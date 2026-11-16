import { HFD_TEMPLATE } from './hfd-template';
import { downloadBrowserBlob } from './browser-download';
import { spectrum, validateMeasurement, MAX_MEASUREMENT_SPECTRUM_POINTS } from './measurement';
import { designHfd } from './hfd-math';
import { parseImpulse } from './measurement';
import { z } from 'zod';
import {
  FS,
  HFD_INDEX_MIN,
  HFD_INDEX_MAX,
  newProject,
  newFilter,
  emptyFir,
  type Project,
  type FilterKind,
  type Filter,
  type Measurement,
} from './model';
import { effectiveSections } from './dsp';
import {
  defaultHfdMeasurementOptions,
  validateHfdMeasurementOptions,
  recomputeHfdMeasurement,
  reconcileProjectHfdCalibration,
} from './hfd-measurement';
import { parseHfdCalibration, validateHfdCalibrationCurve } from './hfd-calibration';
import { firState, validateFirState } from './fir-state';
import { assertProjectLinks } from './links';
import { nativeCloneTemplateSchema, parseNativeCloneInfo } from './clone-template';
const number = z.number().finite();
const coefficients = z.object({ b0: number, b1: number, b2: number, f1: number, f2: number });
const hfdGraphOptions = z.strictObject({
  showMeasuredResponse: z.boolean(),
  showSum: z.boolean(),
});
/** Storage preserves native raw axes. Applying a viewport validates ordering separately. */
export const hfdImpulseZoomSchema = z.strictObject({
  left: number,
  right: number,
  top: number,
  bottom: number,
  use: z.boolean(),
});
const fir = (capacity: number) =>
  z
    .object({
      name: z.string(),
      enabled: z.boolean(),
      taps: z.array(number).max(capacity),
      hfdState: z
        .object({
          loaded: z.boolean(),
          used: z.boolean(),
          tapCount: z.number().int().min(0).max(capacity),
        })
        .strict()
        .optional(),
    })
    .superRefine((value, context) => {
      try {
        validateFirState(value, capacity);
      } catch (error) {
        context.addIssue({
          code: 'custom',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
const nativeShelfDirection = z.enum(['stLowShelf', 'stHighShelf', 'stUnknown']);
const filter = z.object({
  id: z.string(),
  kind: z.enum([
    'unity',
    'lowpass1',
    'lowpass2',
    'highpass1',
    'highpass2',
    'peak',
    'lowshelf1',
    'highshelf1',
    'lowshelf2',
    'highshelf2',
    'asymmetric',
    'allpass1',
    'allpass2',
    'raw',
  ]),
  enabled: z.boolean(),
  frequency: number,
  q: number,
  gain: number,
  frequency2: number,
  q2: number,
  coefficients: coefficients.optional(),
  provenance: z.enum(['hfd', 'panel']).optional(),
  sourceType: z.string().optional(),
  sourceId: z.string().optional(),
  shelfDirection: z.enum(['low', 'high']).optional(),
  sourceShelfDirection: nativeShelfDirection.optional(),
});
const measurementSpectrum = z
  .object({
    frequency: z.array(number).max(MAX_MEASUREMENT_SPECTRUM_POINTS),
    magnitude: z.array(number).max(MAX_MEASUREMENT_SPECTRUM_POINTS),
    phase: z.array(number).max(MAX_MEASUREMENT_SPECTRUM_POINTS).optional(),
  })
  .strict();
const measurementCalibration = measurementSpectrum.extend({ name: z.string(), sampleRate: number });
const hfdCalibrationCurve = z
  .object({
    name: z.string(),
    frequency: z.array(number).min(1).max(2e6),
    magnitude: z.array(number).min(1).max(2e6),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      validateHfdCalibrationCurve(value);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
export const hfdCalibrationResourceSchema = z
  .object({
    content: z.string().max(20e6),
    curve: hfdCalibrationCurve,
  })
  .strict()
  .superRefine((value, context) => {
    try {
      const parsed = parseHfdCalibration(value.content, value.curve.name);
      if (JSON.stringify(parsed) !== JSON.stringify(value.curve))
        throw new Error('Native calibration resource does not match its original file content');
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
export const hfdCalibrationSchema = z
  .object({
    filename: z.string(),
    loaded: z.boolean(),
    showCurve: z.boolean(),
    smoothingOctaves: number.min(0).max(3).optional(),
    resource: hfdCalibrationResourceSchema.optional(),
  })
  .strict();
export const UNRESOLVED_HFD_CALIBRATION_WARNING =
  'Native microphone calibration resource is unresolved; correction settings are retained without inventing a correction curve.';
const HFD_CACHE_POINTS = 1024;
const nativeCacheFrequency = z
  .array(number.positive())
  .length(HFD_CACHE_POINTS)
  .superRefine((value, context) => {
    if (
      value.some((f, i) => {
        const expected = 10 * Math.exp((Math.log(FS / 2 / 10) * i) / HFD_CACHE_POINTS);
        return Math.abs(f - expected) > expected * 1e-10 || (i > 0 && f <= value[i - 1]);
      })
    )
      context.addIssue({
        code: 'custom',
        message: 'Native cache must use the ordinary 1024-point HFD frequency grid',
      });
  });
const hfdMeasurementOptions = z
  .object({
    sampleRate: number.positive(),
    localStart: number.int().min(HFD_INDEX_MIN).max(HFD_INDEX_MAX),
    stopInclusive: number.int().min(HFD_INDEX_MIN).max(HFD_INDEX_MAX),
    phaseStart: number.int().min(HFD_INDEX_MIN).max(HFD_INDEX_MAX),
    sharedStart: number.int().min(HFD_INDEX_MIN).max(HFD_INDEX_MAX),
    sharedGroupId: z.union([z.literal(-1), number.int().min(1).max(3)]),
    fftLength: number
      .int()
      .min(1024)
      .max(2 ** 21),
    smoothBw: number.min(0).max(3),
    smoothPostBw: number.min(0).max(10),
    applyMicCorrection: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      validateHfdMeasurementOptions(value);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
const hfdPhase = z
  .object({
    frequency: nativeCacheFrequency,
    phase: z.array(number).length(HFD_CACHE_POINTS),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.frequency.length !== value.phase.length ||
      value.frequency.some((f, i) => i > 0 && f <= value.frequency[i - 1])
    )
      context.addIssue({ code: 'custom', message: 'Invalid native phase spectrum' });
  });
const hfdMagnitude = z
  .object({
    frequency: nativeCacheFrequency,
    linearMagnitude: z.array(number.nonnegative()).length(HFD_CACHE_POINTS),
    medianDb: number,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.frequency.length !== value.linearMagnitude.length ||
      value.frequency.some((f, i) => i > 0 && f <= value.frequency[i - 1])
    )
      context.addIssue({ code: 'custom', message: 'Invalid native linear magnitude spectrum' });
  });
const measurement = z
  .object({
    name: z.string(),
    sampleRate: number,
    impulse: z.array(number).max(2e6).optional(),
    frequency: z.array(number).max(MAX_MEASUREMENT_SPECTRUM_POINTS).optional(),
    magnitude: z.array(number).max(MAX_MEASUREMENT_SPECTRUM_POINTS).optional(),
    phase: z.array(number).max(MAX_MEASUREMENT_SPECTRUM_POINTS).optional(),
    sourceSpectrum: measurementSpectrum.optional(),
    processing: z
      .object({
        window: z
          .object({ start: number, end: number, taper: number, timeZero: number })
          .strict()
          .optional(),
        smoothingOctaves: number,
        calibration: measurementCalibration.optional(),
        calibrationEnabled: z.boolean(),
      })
      .strict()
      .optional(),
    hfdPhase: hfdPhase.optional(),
    hfdMagnitude: hfdMagnitude.optional(),
  })
  .superRefine((value, context) => {
    try {
      validateMeasurement(value);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (
      value.hfdMagnitude &&
      (!value.frequency ||
        !value.phase ||
        value.frequency.length !== value.hfdMagnitude.frequency.length ||
        value.phase.length !== value.hfdMagnitude.frequency.length ||
        value.frequency.some((f, i) => f !== value.hfdMagnitude!.frequency[i]))
    )
      context.addIssue({
        code: 'custom',
        message:
          'Native magnitude cache must exactly match the measurement frequency and phase grid',
      });
  });
export const projectSchema = z
  .object({
    format: z.literal('fusion-studio-project'),
    version: z.literal(1),
    name: z.string().max(200),
    model: z.literal('FA503'),
    sampleRate: z.literal(93750),
    sourceXml: z.string().max(20e6).optional(),
    hfdGainLowered: z.boolean().optional(),
    hfdCalibration: hfdCalibrationSchema.optional(),
    hfdCloneTemplate: nativeCloneTemplateSchema.optional(),
    warnings: z.array(z.string()),
    presets: z
      .array(
        z.object({
          name: z.string(),
          eqEnabled: z.boolean(),
          firPlacement: z.enum(['input', 'output']).optional(),
          inputFir: fir(4500),
          inputEq: z.array(filter).length(9),
          channels: z
            .array(
              z
                .object({
                  id: z.string(),
                  name: z.string(),
                  outputName: z.string(),
                  gain: number,
                  invert: z.boolean(),
                  muted: z.boolean(),
                  delayUs: number,
                  globalDelayUs: number,
                  filters: z.array(filter).length(15),
                  fir: fir(1500),
                  includeInSum: z.boolean().optional(),
                  coefficientCache: z.enum(['base', 'effective', 'unresolved']).optional(),
                  additionalGain: number.optional(),
                  linkedTo: z.number().int().min(0).max(2).optional(),
                  measurement: measurement.optional(),
                  hfdMeasurement: hfdMeasurementOptions.optional(),
                  hfdGraph: hfdGraphOptions.optional(),
                  hfdImpulseZoom: hfdImpulseZoomSchema.optional(),
                })
                .superRefine((value, context) => {
                  const m = value.measurement;
                  if ((m?.hfdMagnitude || m?.hfdPhase) && !value.hfdMeasurement)
                    context.addIssue({
                      code: 'custom',
                      message: 'Native measurement caches require the channel HFD analysis marker',
                    });
                  if (value.hfdMeasurement && m) {
                    if (m.sampleRate !== value.hfdMeasurement.sampleRate)
                      context.addIssue({
                        code: 'custom',
                        message:
                          'Native measurement sample rate must match channel HFD analysis options',
                      });
                    if (!m.impulse?.length && (m.frequency?.length || m.hfdMagnitude || m.hfdPhase))
                      context.addIssue({
                        code: 'custom',
                        message:
                          'Native HFD analysis requires original impulse data; frequency-only measurements must use browser analysis',
                      });
                  }
                }),
            )
            .length(3),
        }),
      )
      .length(3),
  })
  .superRefine((project, context) => {
    try {
      assertProjectLinks(project as Project);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        path: ['presets'],
        message: error instanceof Error ? error.message : 'Invalid channel links',
      });
    }
  });
export function parseProject(text: string, name = 'Imported HFD project'): Project {
  if (text.length > 80e6) throw new Error('Project exceeds 80 million characters');
  if (text.trimStart().startsWith('<')) return importHfd(text, name);
  const project = projectSchema.parse(JSON.parse(text)) as Project;
  // Raw native IR imports are authoritative. Validate supplied caches first;
  // only genuinely absent caches are generated, leaving saved snapshots intact.
  if (project.hfdCalibration) reconcileProjectHfdCalibration(project);
  else
    for (const preset of project.presets)
      for (const channel of preset.channels)
        if (
          channel.hfdMeasurement &&
          channel.measurement?.impulse?.length &&
          (!channel.measurement.hfdPhase || !channel.measurement.hfdMagnitude)
        )
          recomputeHfdMeasurement(channel);
  return project;
}
const val = (node: Element | null, name: string, fallback = '') =>
  node?.querySelector(`:scope > ${name}`)?.getAttribute('value') ?? fallback;
const num = (node: Element | null, name: string, fallback = 0) => {
  const n = Number(val(node, name, String(fallback)));
  if (!Number.isFinite(n)) throw new Error(`Invalid HFD ${name}`);
  return n;
};
const bool = (node: Element | null, name: string) => val(node, name) === 'true';
function readNativeFir(node: Element, capacity: number): Project['presets'][0]['inputFir'] {
  const tapCount = num(node, 'ntaps', 10);
  if (!Number.isInteger(tapCount) || tapCount < 0 || tapCount > capacity)
    throw new Error('Invalid native FIR tap count');
  const coefficients = new Map<number, number>();
  for (const entry of node.querySelectorAll(':scope > coefficient')) {
    if (!entry.getAttribute('index')?.trim() || !entry.getAttribute('value')?.trim())
      throw new Error('Invalid native FIR coefficients');
    const index = Number(entry.getAttribute('index')),
      value = Number(entry.getAttribute('value'));
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= tapCount ||
      coefficients.has(index) ||
      !Number.isFinite(value)
    )
      throw new Error('Invalid native FIR coefficients');
    coefficients.set(index, value);
  }
  // a953af..da overrides serialized Loaded after successful parsing. Native
  // Trim uses ASCII code units <=32, independently of the locale decimal char.
  const used = bool(node, 'firobjectused'),
    name = val(node, 'filename'),
    loaded = used && name.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '') !== '';
  if (loaded && used && coefficients.size !== tapCount)
    throw new Error('A loaded native FIR requires complete original coefficients');
  const result = {
    name,
    enabled: node.getAttribute('enabled') === 'true',
    taps: Array.from({ length: tapCount }, (_, i) => coefficients.get(i) ?? 0),
    hfdState: { loaded, used, tapCount },
  };
  validateFirState(result, capacity);
  return result;
}
function nativeGraphFlag(node: Element, name: string): boolean | undefined {
  const fields = node.querySelectorAll(`:scope > ${name}`);
  if (fields.length > 1) throw new Error(`Duplicate HFD ${name}`);
  if (!fields.length) return undefined;
  const value = fields[0].getAttribute('value');
  if (value !== 'true' && value !== 'false') throw new Error(`Invalid HFD ${name}`);
  return value === 'true';
}
function nativeZoomNumber(node: Element | null, name: string): number | undefined {
  const fields = node?.querySelectorAll(`:scope > ${name}`);
  if (!fields?.length) return undefined;
  if (fields.length > 1) throw new Error(`Duplicate HFD ${name}`);
  const value = fields[0].getAttribute('value')?.trim();
  if (
    !value ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ||
    !Number.isFinite(Number(value))
  )
    throw new Error(`Invalid HFD ${name}`);
  return Number(value);
}
function xmlDocument(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('XML entities and DOCTYPE are not supported');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML');
  return doc;
}
const kinds: Record<string, FilterKind> = {
  ftUnity: 'unity',
  ftLowPass1: 'lowpass1',
  ftLowPass2: 'lowpass2',
  ftHighPass1: 'highpass1',
  ftHighPass2: 'highpass2',
  ftBoostCut: 'peak',
  ftAsymShelf: 'asymmetric',
  ftAllPass1: 'allpass1',
  ftAllPass2: 'allpass2',
  ftFree: 'raw',
  ftNotDefined: 'raw',
};
export function importHfd(xml: string, name: string): Project {
  const doc = xmlDocument(xml),
    device = doc.querySelector('project > device');
  if (
    !device ||
    !(
      (device.getAttribute('productnr') === '18' && device.getAttribute('fusionamp') === '9') ||
      device.getAttribute('productnr') === '22'
    ) ||
    device.getAttribute('procsamplingrate') !== '93750'
  )
    throw new Error('Expected an FA503 project at 93,750 Hz');
  const project = newProject(name);
  project.sourceXml = xml;
  const gainLowered = device.getAttribute('gainlowered');
  if (gainLowered !== null) {
    if (gainLowered !== 'true' && gainLowered !== 'false')
      throw new Error('Invalid native gainlowered flag');
    project.hfdGainLowered = gainLowered === 'true';
  }
  const cloneTemplate = parseNativeCloneInfo(xml);
  if (cloneTemplate) project.hfdCloneTemplate = cloneTemplate;
  project.warnings = [
    'Imported HFD coefficients are preserved. Editing a filter parameter explicitly redesigns it with the browser algorithm. Device settings in this file are not applied.',
  ];
  const microphone = doc.querySelector('project > microphone');
  const showMicCurve = doc.querySelector('project > microphonecorrectionenabled');
  if (microphone || showMicCurve) {
    const loaded = val(microphone, 'loaded', 'false');
    const show = showMicCurve?.getAttribute('value') ?? 'false';
    if (![loaded, show].every((v) => v === 'true' || v === 'false'))
      throw new Error('Invalid native microphone calibration flags');
    project.hfdCalibration = {
      filename: val(microphone, 'filename'),
      loaded: loaded === 'true',
      showCurve: show === 'true',
    };
  }
  for (let p = 0; p < 3; p++) {
    const preset = device.querySelector(`:scope > preset[index="${p + 1}"]`);
    if (!preset) throw new Error(`Missing preset ${p + 1}`);
    const nodes = Array.from(preset.querySelectorAll(':scope > processobj')),
      map = new Map<string, Element>();
    for (const node of nodes) {
      const id = node.getAttribute('id');
      if (!id || map.has(id)) throw new Error('Missing or duplicate process ID');
      map.set(id, node);
    }
    for (let ch = 0; ch < 3; ch++) {
      const group = String(ch + 1),
        gain = nodes.find(
          (n) => n.getAttribute('groupid') === group && n.getAttribute('processtype') === 'ptGain',
        );
      if (!gain) throw new Error(`Missing channel ${group} gain`);
      const cacheMarker = gain.getAttribute('fusion-studio-coefficient-cache');
      if (cacheMarker !== null && cacheMarker !== 'unresolved')
        throw new Error('Invalid browser channel coefficient cache marker');
      const unresolvedCache = cacheMarker === 'unresolved';
      const path: Element[] = [],
        seen = new Set<string>();
      let node: Element | undefined = gain;
      while (node && node.getAttribute('groupid') === group) {
        const id = node.getAttribute('id')!;
        if (seen.has(id)) throw new Error('Cyclic HFD graph');
        seen.add(id);
        path.unshift(node);
        const links = node.querySelectorAll(':scope > sources > source');
        if (links.length !== 1) throw new Error('Unsupported HFD channel fan-in');
        const previous = links[0].getAttribute('connectedTo')!;
        node = map.get(previous);
        if (!node) throw new Error('Broken HFD graph link');
      }
      const bqs = path.filter((n) => n.getAttribute('processtype') === 'ptBiQuad');
      if (bqs.length !== 15) throw new Error('Expected 15 ordered biquads');
      const channel = project.presets[p].channels[ch],
        measurement = nodes.find(
          (n) =>
            n.getAttribute('groupid') === group && n.getAttribute('processtype') === 'ptImpulse',
        );
      channel.name = measurement?.getAttribute('title') ?? channel.name;
      if (measurement) {
        // Native c70c1e/51 saves group+10d/+10e independently of DAT/Loaded.
        // Missing fields retain legacy absence; one existing field uses the
        // zero-initialized native false default for its missing sibling.
        const showMeasuredResponse = nativeGraphFlag(measurement, 'graphshowmeasuredrespons'),
          showSum = nativeGraphFlag(measurement, 'graphshowsum');
        if (showMeasuredResponse !== undefined || showSum !== undefined)
          channel.hfdGraph = {
            showMeasuredResponse: showMeasuredResponse ?? false,
            showSum: showSum ?? false,
          };
        const defaults = defaultHfdMeasurementOptions();
        const options = measurement.querySelector(':scope > options');
        const zoom = {
          left: nativeZoomNumber(options, 'zoomleft'),
          right: nativeZoomNumber(options, 'zoomright'),
          top: nativeZoomNumber(options, 'zoomtop'),
          bottom: nativeZoomNumber(options, 'zoombottom'),
          use: options ? nativeGraphFlag(options, 'zoomuse') : undefined,
        };
        if (Object.values(zoom).some((value) => value !== undefined))
          channel.hfdImpulseZoom = hfdImpulseZoomSchema.parse({
            left: zoom.left ?? -1,
            right: zoom.right ?? -1,
            top: zoom.top ?? -1,
            bottom: zoom.bottom ?? -1,
            use: zoom.use ?? false,
          });
        const mic = val(measurement, 'applymiccorr', 'false');
        if (mic !== 'true' && mic !== 'false') throw new Error('Invalid HFD applymiccorr');
        channel.hfdMeasurement = hfdMeasurementOptions.parse({
          ...defaults,
          sampleRate: num(options, 'meassamplingrate', defaults.sampleRate),
          localStart: num(options, 'anechstart', defaults.localStart),
          stopInclusive: num(options, 'anechstop', defaults.stopInclusive),
          phaseStart: num(options, 'anechstartcalc', defaults.phaseStart),
          sharedStart: num(options, 'glbanechstart', defaults.sharedStart),
          sharedGroupId: num(options, 'glbanechgroupid', defaults.sharedGroupId),
          smoothBw: num(options, 'smoothbw', defaults.smoothBw),
          smoothPostBw: num(options, 'smoothpostbw', defaults.smoothPostBw),
          applyMicCorrection: mic === 'true',
        });
      }
      const measurementFilename = val(measurement ?? null, 'filename');
      if (measurementFilename) {
        channel.measurement = {
          name: measurementFilename,
          sampleRate: num(
            measurement?.querySelector(':scope > options') ?? null,
            'meassamplingrate',
            48000,
          ),
        };
      }
      channel.outputName = val(measurement ?? null, 'outputname', channel.outputName);
      channel.includeInSum = bool(measurement ?? null, 'useinsum');
      project.presets[p].firPlacement =
        num(measurement ?? null, 'applicationSelect') === 1 ? 'output' : 'input';
      channel.gain = num(gain, 'gain');
      channel.invert = bool(gain, 'invert');
      channel.muted = bool(gain, 'mute');
      channel.additionalGain = num(gain, 'additionalgain');
      const link = val(measurement ?? null, 'linkedto');
      if (link) {
        const n = Number(link) - 1;
        if (!Number.isInteger(n) || n < 0 || n > 2 || n === ch)
          throw new Error('Invalid HFD channel link');
        channel.linkedTo = n;
      }
      for (const delay of path.filter((n) => n.getAttribute('processtype') === 'ptDelay')) {
        if (bool(delay, 'global')) channel.globalDelayUs = num(delay, 'delay');
        else channel.delayUs = num(delay, 'delay');
      }
      const cacheIsBase =
        doc.documentElement.getAttribute('fusion-studio-coefficient-cache') === 'base';
      const multiplier =
        10 ** ((channel.gain + (channel.additionalGain ?? 0)) / 20) * (channel.invert ? -1 : 1);
      channel.filters = bqs.map((b, i): Filter => {
        const type = val(b, 'filtertype'),
          shelf = val(b, 'shelfhl'),
          sourceShelf = nativeShelfDirection.safeParse(shelf),
          // Native Shelf1/2 select High only for stHighShelf. Asym instead
          // selects Low only for stLowShelf; stUnknown has different meanings.
          shelfIsLow =
            type === 'ftShelf1' || type === 'ftShelf2'
              ? shelf !== 'stHighShelf'
              : shelf === 'stLowShelf',
          kind =
            type === 'ftShelf1'
              ? shelfIsLow
                ? 'lowshelf1'
                : 'highshelf1'
              : type === 'ftShelf2'
                ? shelfIsLow
                  ? 'lowshelf2'
                  : 'highshelf2'
                : (kinds[type] ?? 'raw');
        const div = i === 0 && !cacheIsBase && !unresolvedCache ? multiplier : 1;
        return {
          ...newFilter(kind),
          enabled: b.getAttribute('enabled') === 'true',
          frequency: num(b, 'f1', 1000),
          frequency2: num(b, 'f2', 2000),
          q: num(b, 'q1', 0.707),
          q2: num(b, 'q2', 0.707),
          gain: num(b, 'gain'),
          shelfDirection: shelfIsLow ? 'low' : 'high',
          ...(sourceShelf.success ? { sourceShelfDirection: sourceShelf.data } : {}),
          sourceType: type,
          sourceId: b.getAttribute('id')!,
          provenance: 'hfd',
          coefficients: {
            b0: num(b, 'b0', 1) / div,
            b1: num(b, 'b1') / div,
            b2: num(b, 'b2') / div,
            f1: num(b, 'a1'),
            f2: num(b, 'a2'),
          },
        };
      });
      // HFD serializes a cached direct form: either a base section or an
      // effective first numerator. Detect both without replacing custom data.
      const first = channel.filters[0];
      // At an exact unit multiplier the two interpretations are identical,
      // including native freshly-added zero-Peak caches that are still Unity
      // instead of parameter-regenerated cancelling poles/zeros. Keep the
      // original cache; near-unit and inverted caches still need detection.
      // Browser-only per-channel metadata overrides the root base-cache marker:
      // an unresolved vector must remain untouched and blocked after XML reopen.
      channel.coefficientCache = unresolvedCache
        ? 'unresolved'
        : cacheIsBase || multiplier === 1
          ? 'base'
          : 'effective';
      if (!unresolvedCache && !cacheIsBase && multiplier !== 1 && first.coefficients) {
        // Read original native Doubles directly: dividing then multiplying to
        // undo speculative de-embedding can change a cache by one ULP.
        const original = {
          b0: num(bqs[0], 'b0', 1),
          b1: num(bqs[0], 'b1'),
          b2: num(bqs[0], 'b2'),
          f1: num(bqs[0], 'a1'),
          f2: num(bqs[0], 'a2'),
        };
        let base;
        try {
          base = designHfd({ ...first, enabled: true });
        } catch {
          /* Custom/raw first section has no recoverable parameter baseline. */
        }
        if (base) {
          const keys = ['b0', 'b1', 'b2', 'f1', 'f2'] as const,
            scaled = {
              ...base,
              b0: base.b0 * multiplier,
              b1: base.b1 * multiplier,
              b2: base.b2 * multiplier,
            };
          const matches = (expected: typeof base) =>
            keys.every(
              (k) => Math.abs(original[k] - expected[k]) / (1 + Math.abs(expected[k])) < 1e-9,
            );
          if (matches(base) && !matches(scaled)) {
            first.coefficients = original;
            channel.coefficientCache = 'base';
          } else if (!matches(base) && !matches(scaled)) {
            first.coefficients = original;
            channel.coefficientCache = 'unresolved';
            project.warnings.push(
              `Preset ${p + 1}, channel ${ch + 1}: choose whether the custom first-section coefficients already include channel gain before upload.`,
            );
          }
        } else if (Math.abs(multiplier - 1) > 1e-12) {
          first.coefficients = original;
          channel.coefficientCache = 'unresolved';
        }
      }
      const f = path.find((n) => n.getAttribute('processtype') === 'ptFir');
      if (f) channel.fir = readNativeFir(f, 1500);
    }
    const eq = device.querySelector(`:scope > info > equalizer > preset[index="${p + 1}"]`);
    if (eq) {
      const bands = Array.from(eq.querySelectorAll('filter'));
      if (bands.length !== 9) throw new Error('Expected nine input EQ bands');
      project.presets[p].inputEq = bands.map((b) => ({
        ...newFilter(['peak', 'lowshelf2', 'highshelf2'][num(b, 'filterType')] as FilterKind),
        enabled: bool(b, 'enabled'),
        frequency: num(b, 'frequency'),
        q: num(b, 'qparam'),
        gain: num(b, 'gain'),
      }));
    }
    project.presets[p].eqEnabled = bool(preset, 'eqActive');
    const input = nodes.find((n) => n.getAttribute('processtype') === 'ptFir' && bool(n, 'input'));
    if (input) project.presets[p].inputFir = readNativeFir(input, 4500);
  }
  if (
    bool(doc.documentElement, 'microphonecorrectionenabled') ||
    bool(doc.querySelector('project > microphone'), 'loaded') ||
    project.presets.some((p) => p.channels.some((c) => c.hfdMeasurement?.applyMicCorrection))
  )
    project.warnings.push(UNRESOLVED_HFD_CALIBRATION_WARNING);
  return project;
}
export function exportHfd(project: Project): string {
  const doc = xmlDocument(project.sourceXml ?? HFD_TEMPLATE),
    device = doc.querySelector('device')!;
  // Explicit compensation edits own this native hint. Legacy JSON without the
  // typed field retains its source attribute; no OR/normalization of channels.
  if (project.hfdGainLowered !== undefined)
    device.setAttribute('gainlowered', String(z.boolean().parse(project.hfdGainLowered)));
  doc.documentElement.setAttribute('fusion-studio-coefficient-cache', 'base');
  const set = (node: Element, name: string, value: unknown) => {
    let field = node.querySelector(`:scope > ${name}`);
    if (!field) {
      field = doc.createElement(name);
      node.appendChild(field);
    }
    field.setAttribute('value', String(value));
  };
  if (project.hfdCalibration) {
    const calibration = hfdCalibrationSchema.parse(project.hfdCalibration);
    let microphone = doc.querySelector('project > microphone');
    if (!microphone) {
      microphone = doc.createElement('microphone');
      doc.documentElement.appendChild(microphone);
    }
    set(microphone, 'filename', calibration.filename.replaceAll('\\', '/').split('/').at(-1) ?? '');
    set(microphone, 'loaded', calibration.loaded);
    set(doc.documentElement, 'microphonecorrectionenabled', calibration.showCurve);
  }
  const writeFir = (
    node: Element | undefined,
    f: Project['presets'][0]['inputFir'],
    active: boolean,
  ) => {
    if (!node) return;
    const state = firState(f, active);
    node.setAttribute('enabled', String(f.hfdState ? f.enabled : active && f.enabled));
    set(node, 'loaded', state.loaded);
    set(node, 'ntaps', state.tapCount);
    set(node, 'filename', f.name);
    set(node, 'firobjectused', state.used);
    node.querySelectorAll(':scope > coefficient').forEach((n) => n.remove());
    const values = f.hfdState
      ? state.used
        ? Array.from({ length: state.tapCount }, (_, i) => f.taps[i] ?? 0)
        : []
      : f.taps;
    for (const [index, value] of values.entries()) {
      const c = doc.createElement('coefficient');
      c.setAttribute('index', String(index));
      c.setAttribute('value', String(value));
      node.appendChild(c);
    }
  };
  const type: Record<FilterKind, string> = {
    unity: 'ftUnity',
    lowpass1: 'ftLowPass1',
    lowpass2: 'ftLowPass2',
    highpass1: 'ftHighPass1',
    highpass2: 'ftHighPass2',
    peak: 'ftBoostCut',
    lowshelf1: 'ftShelf1',
    highshelf1: 'ftShelf1',
    lowshelf2: 'ftShelf2',
    highshelf2: 'ftShelf2',
    asymmetric: 'ftAsymShelf',
    allpass1: 'ftAllPass1',
    allpass2: 'ftAllPass2',
    raw: 'ftFree',
  };
  project.presets.forEach((p, i) => {
    const preset = device.querySelector(`:scope > preset[index="${i + 1}"]`)!;
    if (!preset) throw new Error('Missing HFD preset template');
    set(preset, 'eqActive', p.eqEnabled);
    const nodes = Array.from(preset.querySelectorAll(':scope > processobj')),
      map = new Map(nodes.map((n) => [n.getAttribute('id'), n]));
    const placement = p.firPlacement ?? (p.inputFir.enabled ? 'input' : 'output');
    writeFir(
      nodes.find((n) => n.getAttribute('processtype') === 'ptFir' && bool(n, 'input')),
      p.inputFir,
      placement === 'input',
    );
    p.channels.forEach((c, ch) => {
      const group = String(ch + 1),
        gain = nodes.find(
          (n) => n.getAttribute('groupid') === group && n.getAttribute('processtype') === 'ptGain',
        );
      if (!gain) throw new Error('Missing HFD channel gain');
      if (c.coefficientCache === 'unresolved')
        gain.setAttribute('fusion-studio-coefficient-cache', 'unresolved');
      else gain.removeAttribute('fusion-studio-coefficient-cache');
      const path: Element[] = [],
        seen = new Set<string>();
      let cursor: Element | undefined = gain;
      while (cursor?.getAttribute('groupid') === group) {
        const id = cursor.getAttribute('id')!;
        if (seen.has(id)) throw new Error('Cyclic HFD template graph');
        seen.add(id);
        path.unshift(cursor);
        cursor = map.get(
          cursor.querySelector(':scope > sources > source')?.getAttribute('connectedTo') ?? '',
        );
      }
      const bqs = path.filter((n) => n.getAttribute('processtype') === 'ptBiQuad');
      if (bqs.length !== 15) throw new Error('Missing HFD biquad slots');
      c.filters.forEach((f, j) => {
        const node = bqs[j],
          coeff = f.coefficients ?? designHfd({ ...f, enabled: true });
        node.setAttribute('enabled', String(f.enabled));
        for (const [key, value] of Object.entries({
          b0: coeff.b0,
          b1: coeff.b1,
          b2: coeff.b2,
          a1: coeff.f1,
          a2: coeff.f2,
          f1: f.frequency,
          f2: f.frequency2,
          q1: f.q,
          q2: f.q2,
          gain: f.gain,
          zconst: coeff.b0,
        }))
          set(node, key, value);
        set(node, 'filtertype', type[f.kind]);
        set(
          node,
          'shelfhl',
          f.sourceShelfDirection !== undefined
            ? nativeShelfDirection.parse(f.sourceShelfDirection)
            : f.kind.startsWith('low')
              ? 'stLowShelf'
              : f.kind.startsWith('high')
                ? 'stHighShelf'
                : f.shelfDirection === 'high'
                  ? 'stHighShelf'
                  : 'stLowShelf',
        );
      });
      set(gain, 'gain', c.gain);
      set(gain, 'additionalgain', c.additionalGain ?? 0);
      set(gain, 'invert', c.invert);
      set(gain, 'mute', c.muted);
      for (const node of path.filter((n) => n.getAttribute('processtype') === 'ptDelay'))
        set(node, 'delay', bool(node, 'global') ? c.globalDelayUs : c.delayUs);
      writeFir(
        path.find((n) => n.getAttribute('processtype') === 'ptFir'),
        c.fir,
        placement === 'output',
      );
      const impulse = nodes.find(
        (n) => n.getAttribute('groupid') === group && n.getAttribute('processtype') === 'ptImpulse',
      );
      if (impulse) {
        if (c.hfdGraph) {
          const graph = hfdGraphOptions.parse(c.hfdGraph);
          set(impulse, 'graphshowmeasuredrespons', graph.showMeasuredResponse);
          set(impulse, 'graphshowsum', graph.showSum);
        }
        if (c.hfdImpulseZoom) {
          const zoom = hfdImpulseZoomSchema.parse(c.hfdImpulseZoom);
          let options = impulse.querySelector(':scope > options');
          if (!options) {
            options = doc.createElement('options');
            impulse.appendChild(options);
          }
          for (const [key, value] of Object.entries({
            zoomleft: zoom.left,
            zoomright: zoom.right,
            zoomtop: zoom.top,
            zoombottom: zoom.bottom,
            zoomuse: zoom.use,
          }))
            set(options, key, value);
        }
        if (c.measurement?.impulse) {
          set(impulse, 'filename', `P${i + 1}_CH${ch + 1}.dat`);
          const options = impulse.querySelector(':scope > options');
          if (options)
            set(
              options,
              'meassamplingrate',
              c.hfdMeasurement?.sampleRate ?? c.measurement.sampleRate,
            );
        } else
          set(impulse, 'filename', c.measurement?.frequency ? '' : (c.measurement?.name ?? ''));
        if (c.hfdMeasurement) {
          const native = hfdMeasurementOptions.parse(c.hfdMeasurement);
          let options = impulse.querySelector(':scope > options');
          if (!options) {
            options = doc.createElement('options');
            impulse.appendChild(options);
          }
          for (const [key, value] of Object.entries({
            meassamplingrate: native.sampleRate,
            anechstart: native.localStart,
            anechstop: native.stopInclusive,
            anechstartcalc: native.phaseStart,
            glbanechstart: native.sharedStart,
            glbanechgroupid: native.sharedGroupId,
            smoothbw: native.smoothBw,
            smoothpostbw: native.smoothPostBw,
          }))
            set(options, key, value);
          set(impulse, 'applymiccorr', native.applyMicCorrection);
        }
        impulse.setAttribute('title', c.name);
        set(impulse, 'outputname', c.outputName);
        set(impulse, 'useinsum', c.includeInSum !== false);
        set(impulse, 'applicationSelect', placement === 'output' ? 1 : 0);
        impulse.querySelector(':scope > linkedto')?.remove();
        if (c.linkedTo !== undefined) set(impulse, 'linkedto', c.linkedTo + 1);
      }
    });
    // Input EQ belongs to the separate info snapshot, never the output graph.
    let info = device.querySelector(':scope > info');
    if (!info) {
      info = doc.createElement('info');
      device.appendChild(info);
    }
    let eq = info.querySelector(':scope > equalizer');
    if (!eq) {
      eq = doc.createElement('equalizer');
      info.appendChild(eq);
    }
    let ep = eq.querySelector(`:scope > preset[index="${i + 1}"]`);
    if (!ep) {
      ep = doc.createElement('preset');
      ep.setAttribute('index', String(i + 1));
      eq.appendChild(ep);
    }
    ep.replaceChildren();
    p.inputEq.forEach((f, index) => {
      const b = doc.createElement('filter');
      b.setAttribute('index', String(index + 1));
      for (const [k, v] of Object.entries({
        enabled: f.enabled,
        filterType: f.kind === 'lowshelf2' ? 1 : f.kind === 'highshelf2' ? 2 : 0,
        frequency: f.frequency,
        qparam: f.q,
        gain: f.gain,
      }))
        set(b, k, v);
      ep!.appendChild(b);
    });
  });
  return new XMLSerializer().serializeToString(doc);
}

export function resolveGainCache(
  channel: Project['presets'][0]['channels'][0],
  interpretation: 'base' | 'effective',
) {
  if (channel.coefficientCache !== 'unresolved')
    throw new Error('Channel cache is already resolved');
  const c = channel.filters[0].coefficients;
  if (!c) throw new Error('No imported coefficient cache');
  const scalar =
    10 ** ((channel.gain + (channel.additionalGain ?? 0)) / 20) * (channel.invert ? -1 : 1);
  if (interpretation === 'effective') {
    c.b0 /= scalar;
    c.b1 /= scalar;
    c.b2 /= scalar;
  }
  channel.coefficientCache = interpretation;
}
export function parseFir(text: string, count: number) {
  const taps = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#') && !s.startsWith(';'))
    .map(Number);
  if (taps.length !== count || !taps.every(Number.isFinite))
    throw new Error(`Expected exactly ${count.toLocaleString()} finite taps, one per line`);
  if (taps.every((x) => x === 0)) throw new Error('FIR contains only zeros');
  return taps;
}
export function parseMeasurement(text: string, name: string): Measurement {
  const clean = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[*#;]/.test(l));
  if (clean.length > 1 && clean.every((l) => Number.isFinite(Number(l))))
    return parseImpulse(text, name);
  const rows = text
    .split(/\r?\n/)
    .filter((s) => s.trim() && !/^[*#;]/.test(s.trim()))
    .map((s) =>
      s
        .trim()
        .split(/[\s,]+/)
        .map(Number),
    )
    .filter((r) => r.length >= 2 && r.every(Number.isFinite));
  if (rows.length < 2) throw new Error('Expected frequency, dB and optional phase columns');
  const frequency = rows.map((r) => r[0]);
  if (frequency.some((f, i) => f <= 0 || (i > 0 && f <= frequency[i - 1])))
    throw new Error('Frequencies must be positive and increasing');
  return {
    name,
    sampleRate: 93750,
    frequency,
    magnitude: rows.map((r) => r[1]),
    phase: rows.map((r) => r[2] ?? 0),
  };
}
export function download(name: string, content: string, type = 'application/json') {
  downloadBrowserBlob(name, new Blob([content], { type }));
}
