import { fft } from './fft';
import { applyCalibration, processMeasurement, validateMeasurement } from './measurement';
import {
  buildHfdCalibration,
  DEFAULT_HFD_MIC_SMOOTHING,
  type HfdCalibrationResponse,
} from './hfd-calibration';
import {
  FS,
  HFD_INDEX_MIN,
  HFD_INDEX_MAX,
  type Channel,
  type HfdMeasurementOptions,
  type Measurement,
  type MeasurementProcessingPatch,
  type Preset,
  type Project,
} from './model';

const OPTION_KEYS = [
  'sampleRate',
  'localStart',
  'stopInclusive',
  'phaseStart',
  'sharedStart',
  'sharedGroupId',
  'fftLength',
  'smoothBw',
  'smoothPostBw',
  'applyMicCorrection',
] as const;

export function defaultsHfdMeasurementOptions(sampleRate = 48000): HfdMeasurementOptions {
  return {
    sampleRate,
    localStart: 0,
    stopInclusive: 65535,
    phaseStart: -1,
    sharedStart: -1,
    sharedGroupId: -1,
    fftLength: 65536,
    smoothBw: 0.0125,
    smoothPostBw: 0.125,
    applyMicCorrection: false,
  };
}
export const defaultHfdMeasurementOptions = defaultsHfdMeasurementOptions;

export function validateHfdMeasurementOptions(options: HfdMeasurementOptions): void {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((k) => !OPTION_KEYS.includes(k as (typeof OPTION_KEYS)[number]))
  )
    throw new Error('Invalid native measurement options');
  if (!Number.isFinite(options.sampleRate) || options.sampleRate <= 0)
    throw new Error('Native measurement sample rate must be finite and positive');
  for (const key of ['localStart', 'stopInclusive', 'phaseStart', 'sharedStart'] as const) {
    if (
      !Number.isInteger(options[key]) ||
      options[key] < HFD_INDEX_MIN ||
      options[key] > HFD_INDEX_MAX
    )
      throw new Error(`Invalid native ${key}`);
  }
  if (![-1, 1, 2, 3].includes(options.sharedGroupId))
    throw new Error('Invalid native shared crop snapshot');
  if (options.fftLength !== 65536)
    throw new Error('Native measurement analysis currently supports only FFT length 65536');
  if (!Number.isFinite(options.smoothBw) || options.smoothBw < 0 || options.smoothBw > 3)
    throw new Error('Supported native pre-interpolation bandwidth must be 0–3');
  if (
    !Number.isFinite(options.smoothPostBw) ||
    options.smoothPostBw < 0 ||
    options.smoothPostBw > 10
  )
    throw new Error('Native post-plot bandwidth must be 0–10');
  if (typeof options.applyMicCorrection !== 'boolean')
    throw new Error('Native microphone correction flag must be boolean');
}

export function effectiveHfdCropStart(options: HfdMeasurementOptions) {
  return options.sharedGroupId === -1 ? options.localStart : options.sharedStart;
}

function unwrap(re: Float64Array, im: Float64Array) {
  const phase = new Float64Array(re.length);
  let previous = Math.atan2(im[0], re[0]),
    offset = 0;
  phase[0] = previous;
  for (let i = 1; i < phase.length; i++) {
    const current = Math.atan2(im[i], re[i]),
      delta = current - previous;
    if (delta > Math.PI) offset -= 2 * Math.PI;
    else if (delta < -Math.PI) offset += 2 * Math.PI;
    phase[i] = current + offset;
    previous = current;
  }
  return phase;
}

function packedFft(impulse: number[], start: number, stop: number, n: number) {
  const re = new Float64Array(n),
    im = new Float64Array(n);
  let packed = 0;
  // c74f0b/c74f56: original indices, inclusive stop, packed from zero. A
  // phaseStart of -1 includes sample0; it is not a fractional time rotation.
  for (let i = Math.max(0, start); i <= Math.min(stop, n - 1, impulse.length - 1); i++)
    re[packed++] = impulse[i];
  fft(re, im);
  return { re, im };
}

/** Native SmoothInterp c74b50: Gaussian mean of LINEAR magnitude or unwrapped
 * phase on linear FFT-bin positions. This is not dB/power/octave box smoothing. */
export function hfdSmoothInterp(input: ArrayLike<number>, x: number, bw: number, n: number) {
  if (x > n / 2) return 0;
  // c74d1b catches the singular native zero-bandwidth/zero-position path.
  if (bw === 0 || x === 0) return 0;
  const ratio = 2 ** bw,
    a = (Math.sqrt(Math.LN2) * (ratio + 1)) / (x * (ratio - 1)),
    radius = Math.sqrt(-Math.log(0.001)) / a,
    lo = Math.max(0, Math.floor(x - radius)),
    hi = Math.min(input.length - 1, Math.ceil(x + radius));
  let total = 0,
    weights = 0;
  for (let i = lo; i <= hi; i++) {
    const weight = Math.exp(-(((i - x) * a) ** 2));
    total += input[i] * weight;
    weights += weight;
  }
  return weights ? total / weights : 0;
}

/** Native c74828/c75714 post-plot Gaussian. Call AFTER complex products/sums
 * become display dB or wrapped phase; never feed it back into complex sources. */
export function hfdSmoothPlot(
  values: ArrayLike<number>,
  frequencies: ArrayLike<number>,
  bandwidth: number,
) {
  const count = values.length;
  if (
    count !== frequencies.length ||
    !Number.isFinite(bandwidth) ||
    bandwidth < 0 ||
    bandwidth > 10
  )
    throw new Error('Invalid native post-plot smoothing input');
  if (!count) return new Float64Array(0);
  if (
    Array.from(values).some((x) => !Number.isFinite(x)) ||
    Array.from(frequencies).some(
      (f, i) => !Number.isFinite(f) || f <= 0 || (i > 0 && f <= frequencies[i - 1]),
    )
  )
    throw new Error('Native post-plot values must be finite and frequencies positive/increasing');
  if (count === 1) return Float64Array.from(values);
  const bw = bandwidth === 0 ? 1e-5 : bandwidth,
    s = (count * bw * Math.LN2) / Math.log(frequencies[count - 1] / frequencies[0]),
    a = Math.sqrt(Math.LN2) / s,
    kernel = Float64Array.from({ length: count }, (_, i) => Math.exp(-((i * a) ** 2))),
    radius = Math.ceil(4 * s);
  let normalizer = kernel[0];
  for (let i = 1; i < count; i++) normalizer += 2 * kernel[i];
  for (let i = 0; i < count; i++) kernel[i] /= normalizer;
  return Float64Array.from(values, (_, j) => {
    let value = kernel[0] * values[j];
    // Native allocation is L=65536; only M coefficients are written and the
    // fresh tail stays zero. This bound remains exact even when R>=M.
    for (let i = 1; i <= Math.min(radius, count - 1); i++)
      value += kernel[i] * (values[Math.max(0, j - i)] + values[Math.min(count - 1, j + i)]);
    return value;
  });
}

/** c7527a/c752b1: pre-post interpolated linear magnitude histogram; bin0 is
 * ignored and the scan increments its index before returning. These native
 * quirks produce +0.1dB for a unit response and +199.9dB for all-zero data. */
export function hfdMagnitudeMedian(values: ArrayLike<number>): number {
  if (!values.length) throw new Error('Native magnitude median requires samples');
  const histogram = new Uint32Array(4000);
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i]) || values[i] < 0)
      throw new Error('Native magnitude samples must be finite and nonnegative');
    const db = 20 * Math.log10(Math.max(1e-10, values[i])),
      bin = Math.trunc((db + 200) * 10);
    if (bin < 0 || bin >= histogram.length)
      throw new Error('Native magnitude exceeds the recovered centering histogram range');
    histogram[bin]++;
  }
  let index = 1,
    count = 0;
  do {
    count += histogram[index];
    index++;
  } while (count <= Math.floor(values.length / 2) && index < 3999);
  return index / 10 - 200;
}
export const hfdMedianDb = hfdMagnitudeMedian;

function nativeMeasurement(
  channel: Channel,
  calibration?: HfdCalibrationResponse | null,
): Measurement | undefined {
  const options = channel.hfdMeasurement!;
  validateHfdMeasurementOptions(options);
  const original = channel.measurement;
  if (!original?.impulse?.length) {
    if (original) {
      validateMeasurement(original);
      if (original.frequency?.length || original.sourceSpectrum?.frequency.length)
        throw new Error(
          'Native HFD measurement analysis requires original impulse samples; import frequency-only data in Browser mode.',
        );
      const retained = structuredClone(original);
      retained.sampleRate = options.sampleRate;
      delete retained.hfdPhase;
      delete retained.hfdMagnitude;
      return retained;
    }
    return;
  }
  validateMeasurement(original);
  const n = options.fftLength,
    crop = packedFft(original.impulse, effectiveHfdCropStart(options), options.stopInclusive, n),
    reference = packedFft(original.impulse, options.phaseStart, options.stopInclusive, n),
    phase = unwrap(crop.re, crop.im),
    independent = unwrap(reference.re, reference.im),
    magnitude = Float64Array.from(crop.re, (r, i) => Math.hypot(r, crop.im[i]));
  if (options.applyMicCorrection && calibration) {
    if (
      calibration.sampleRate !== options.sampleRate ||
      calibration.magnitude.length !== n + 1 ||
      calibration.phase.length !== n + 1
    )
      throw new Error('Native correction resource does not match measurement sampling');
    for (let i = 0; i < n; i++) {
      if (calibration.magnitude[i] !== 0) magnitude[i] /= calibration.magnitude[i];
      phase[i] -= calibration.phase[i];
    }
  } else if (
    options.applyMicCorrection &&
    calibration === undefined &&
    original.processing?.calibration
  ) {
    // Correct the magnitude-source arrays before native interpolation. The
    // independent phase-start FFT deliberately excludes microphone correction.
    const corrected = applyCalibration(
      {
        name: original.name,
        sampleRate: options.sampleRate,
        frequency: Array.from({ length: n }, (_, i) =>
          i === 0 ? 0.01 : (i * options.sampleRate) / n,
        ),
        magnitude: Array.from(magnitude, (v) => 20 * Math.log10(Math.max(1e-15, v))),
        phase: Array.from(phase, (v) => (v * 180) / Math.PI),
      },
      original.processing.calibration,
    );
    for (let i = 0; i < n; i++) {
      magnitude[i] = magnitude[i] === 0 ? 0 : 10 ** (corrected.magnitude![i] / 20);
      phase[i] = (corrected.phase![i] * Math.PI) / 180;
    }
  }
  const frequency: number[] = [],
    db: number[] = [],
    linearMagnitude: number[] = [],
    cropPhase: number[] = [],
    phaseReference: number[] = [];
  // c749c4: 1024 logarithmic points; DSP Nyquist is an excluded endpoint.
  for (let j = 0; j < 1024; j++) {
    const f = 10 * Math.exp((Math.log(FS / 2 / 10) * j) / 1024),
      x = (n * f) / options.sampleRate;
    frequency.push(f);
    const amplitude = hfdSmoothInterp(magnitude, x, options.smoothBw, n);
    linearMagnitude.push(amplitude);
    db.push(20 * Math.log10(Math.max(1e-10, amplitude)));
    cropPhase.push((hfdSmoothInterp(phase, x, options.smoothBw, n) * 180) / Math.PI);
    phaseReference.push((hfdSmoothInterp(independent, x, options.smoothBw, n) * 180) / Math.PI);
  }
  return {
    ...structuredClone(original),
    sampleRate: options.sampleRate,
    frequency,
    magnitude: db,
    phase: cropPhase,
    hfdPhase: { frequency: frequency.slice(), phase: phaseReference },
    hfdMagnitude: {
      frequency: frequency.slice(),
      linearMagnitude,
      medianDb: hfdMagnitudeMedian(linearMagnitude),
    },
  };
}

function commit(channel: Channel, proposed: Channel) {
  // Optional fields require deletion too; Object.assign alone retains markers.
  if (!proposed.hfdMeasurement) delete channel.hfdMeasurement;
  if (!proposed.measurement) delete channel.measurement;
  return Object.assign(channel, proposed);
}
function recompute(proposed: Channel, calibration?: HfdCalibrationResponse | null) {
  if (proposed.hfdMeasurement) {
    const measurement = nativeMeasurement(proposed, calibration);
    if (measurement) proposed.measurement = measurement;
  }
  return proposed;
}

export function recomputeHfdMeasurement(
  channel: Channel,
  calibration?: HfdCalibrationResponse | null,
): Channel {
  if (!channel.hfdMeasurement) return channel;
  return commit(channel, recompute(structuredClone(channel), calibration));
}

/** An explicit project microphone resource is authoritative, even if its file
 * is missing/unloaded. An absent project field leaves old per-measurement
 * browser curves untouched. Stage all changes before committing any channel. */
export function reconcileProjectHfdCalibration(project: Project, previous?: Project): Project {
  const reference = project.hfdCalibration;
  if (!reference) return project;
  const fingerprint = (value: NonNullable<Project['hfdCalibration']>) =>
    JSON.stringify([
      value.loaded,
      value.smoothingOctaves ?? DEFAULT_HFD_MIC_SMOOTHING,
      value.resource?.curve,
    ]);
  const unchangedResource =
    previous?.hfdCalibration && fingerprint(previous.hfdCalibration) === fingerprint(reference);
  const responses = new Map<string, HfdCalibrationResponse>();
  const staged: { channel: Channel; measurement: Measurement | undefined }[] = [];
  for (let p = 0; p < project.presets.length; p++) {
    for (let c = 0; c < project.presets[p].channels.length; c++) {
      const channel = project.presets[p].channels[c];
      if (!channel.hfdMeasurement) continue;
      const old = previous?.presets[p]?.channels[c],
        current = channel.measurement;
      const sourceUnchanged =
        old?.measurement?.impulse &&
        current?.impulse &&
        old.measurement.impulse.length === current.impulse.length &&
        old.measurement.impulse.every((value, i) => value === current.impulse![i]);
      if (
        unchangedResource &&
        sourceUnchanged &&
        old?.measurement?.hfdMagnitude &&
        old.measurement.hfdPhase &&
        JSON.stringify(old.hfdMeasurement) === JSON.stringify(channel.hfdMeasurement)
      ) {
        staged.push({
          channel,
          measurement: {
            ...current!,
            frequency: old.measurement.frequency?.slice(),
            magnitude: old.measurement.magnitude?.slice(),
            phase: old.measurement.phase?.slice(),
            hfdMagnitude: structuredClone(old.measurement.hfdMagnitude),
            hfdPhase: structuredClone(old.measurement.hfdPhase),
          },
        });
        continue;
      }
      let calibration: HfdCalibrationResponse | null = null;
      if (
        channel.hfdMeasurement.applyMicCorrection &&
        current?.impulse?.length &&
        reference.loaded &&
        reference.resource
      ) {
        const rate = channel.hfdMeasurement.sampleRate,
          length = channel.hfdMeasurement.fftLength;
        const key = `${rate}:${length}`;
        calibration =
          responses.get(key) ??
          buildHfdCalibration(
            reference.resource.curve,
            rate,
            length,
            reference.smoothingOctaves ?? DEFAULT_HFD_MIC_SMOOTHING,
          );
        responses.set(key, calibration);
      }
      staged.push({ channel, measurement: nativeMeasurement(channel, calibration) });
    }
  }
  for (const { channel, measurement } of staged) {
    if (measurement) channel.measurement = measurement;
    else delete channel.measurement;
  }
  return project;
}

/** Import a detached measurement without silently changing its target's analysis
 * engine. Browser response snapshots are retained as supplied. Native imports
 * are rebuilt from original impulse samples and retain the target's crop/shared
 * settings; metadata-only references and Clear preserve native options. Every
 * validation/rebuild completes on a proposal before the target is committed. */
export function importChannelMeasurement(
  channel: Channel,
  measurement: Measurement | undefined,
  analysis?: 'hfd' | 'browser',
): Channel {
  if (analysis !== undefined && analysis !== 'hfd' && analysis !== 'browser')
    throw new Error('Invalid measurement analysis engine');
  const proposed = structuredClone(channel),
    native = analysis === 'hfd' || (analysis === undefined && !!channel.hfdMeasurement);
  if (measurement === undefined) delete proposed.measurement;
  else {
    proposed.measurement = structuredClone(measurement);
    // Imported derived caches are never authoritative over original data or a
    // target's settings. Browser mode discards them; native mode rebuilds them.
    delete proposed.measurement.hfdPhase;
    delete proposed.measurement.hfdMagnitude;
    validateMeasurement(proposed.measurement);
  }
  if (native)
    useHfdNative(
      proposed,
      proposed.measurement?.impulse?.length ? { sampleRate: proposed.measurement.sampleRate } : {},
    );
  else delete proposed.hfdMeasurement;
  return commit(channel, proposed);
}

/** Native Take clears first, independently of acquisition success. Shared crop,
 * electrical processing and labels survive; Undo belongs to the workspace. */
export function clearHfdCapture(channel: Channel, sampleRate: number): Channel {
  const proposed = structuredClone(channel);
  delete proposed.measurement;
  proposed.hfdMeasurement = {
    ...(proposed.hfdMeasurement ?? defaultsHfdMeasurementOptions(sampleRate)),
    sampleRate,
    localStart: 0,
    stopInclusive: 65535,
    phaseStart: -1,
  };
  return commit(channel, recompute(proposed));
}

/** Commit the native65536-sample deconvolution without peak normalization or
 * alignment. The recorded clock is authoritative, including when it changed. */
export function applyHfdCapture(
  channel: Channel,
  samples: ArrayLike<number>,
  sampleRate: number,
  name: string,
): Channel {
  if (samples.length !== 65536) throw new Error('A captured HFD impulse requires65536 samples');
  const proposed = structuredClone(channel);
  clearHfdCapture(proposed, sampleRate);
  importChannelMeasurement(proposed, { name, sampleRate, impulse: Array.from(samples) }, 'hfd');
  return commit(channel, proposed);
}

export function useHfdNative(
  channel: Channel,
  patch: Partial<HfdMeasurementOptions> = {},
): Channel {
  const proposed = structuredClone(channel),
    legacy = proposed.measurement?.processing?.window;
  const options = proposed.hfdMeasurement ?? {
    ...defaultsHfdMeasurementOptions(proposed.measurement?.sampleRate),
    ...(legacy
      ? {
          localStart: legacy.start,
          stopInclusive: legacy.end - 1,
          phaseStart: Math.trunc(legacy.timeZero),
        }
      : {}),
    ...(proposed.measurement?.processing
      ? {
          smoothPostBw: proposed.measurement.processing.smoothingOctaves || 0.0001,
          applyMicCorrection: proposed.measurement.processing.calibrationEnabled,
        }
      : {}),
  };
  proposed.hfdMeasurement = { ...options, ...patch };
  return commit(channel, recompute(proposed));
}

export function useBrowserMeasurement(channel: Channel): Channel {
  if (!channel.hfdMeasurement) return channel;
  const proposed = structuredClone(channel);
  delete proposed.hfdMeasurement;
  if (proposed.measurement) {
    delete proposed.measurement.hfdPhase;
    delete proposed.measurement.hfdMagnitude;
    if (proposed.measurement.impulse || proposed.measurement.frequency)
      proposed.measurement = processMeasurement(proposed.measurement, {
        smoothingOctaves: proposed.measurement.processing?.smoothingOctaves ?? 0,
      });
  }
  return commit(channel, proposed);
}

export function updateHfdMeasurement(
  channel: Channel,
  patch: Partial<HfdMeasurementOptions>,
): Channel {
  if (!channel.hfdMeasurement)
    throw new Error('Explicitly enable native measurement processing first');
  const proposed = structuredClone(channel);
  proposed.hfdMeasurement = { ...proposed.hfdMeasurement!, ...patch };
  return commit(channel, recompute(proposed));
}

export function processChannelMeasurement(
  channel: Channel,
  patch: MeasurementProcessingPatch,
): Channel {
  const proposed = structuredClone(channel),
    measurement = proposed.measurement;
  if (!measurement) throw new Error('Load a measurement first');
  if (!proposed.hfdMeasurement) {
    proposed.measurement = processMeasurement(measurement, patch);
    return commit(channel, proposed);
  }
  const options = proposed.hfdMeasurement;
  if (patch.window) {
    if (
      Object.keys(patch.window).some((k) => !['start', 'end', 'taper', 'timeZero'].includes(k)) ||
      !Number.isFinite(patch.window.timeZero)
    )
      throw new Error('Invalid native impulse window patch');
    if (patch.window.taper !== 0)
      throw new Error('Native measurement processing uses a rectangular crop; taper must be zero');
    options.localStart = patch.window.start;
    options.stopInclusive = patch.window.end - 1;
    options.phaseStart = Math.trunc(patch.window.timeZero);
  } else if (patch.window === null) {
    Object.assign(options, { localStart: 0, stopInclusive: 65535, phaseStart: -1 });
  }
  // Use the existing validated resource/state transitions, without feeding its
  // legacy window FFT into native results or overwriting the archived window.
  const commonPatch = { ...patch };
  delete commonPatch.window;
  if (Object.values(commonPatch).some((v) => v !== undefined))
    proposed.measurement = processMeasurement(measurement, commonPatch);
  if (patch.smoothingOctaves !== undefined) options.smoothPostBw = patch.smoothingOctaves || 0.0001;
  if (patch.calibration === null) options.applyMicCorrection = false;
  if (patch.calibrationEnabled !== undefined) options.applyMicCorrection = patch.calibrationEnabled;
  return commit(channel, recompute(proposed));
}

export function enablePresetHfdMeasurement(preset: Preset): Preset {
  if (preset.channels.length !== 3 || new Set(preset.channels).size !== 3)
    throw new Error('Native preset processing requires three distinct channel objects');
  const proposed = structuredClone(preset);
  proposed.channels.forEach((c) => useHfdNative(c));
  Object.assign(preset, proposed);
  return preset;
}

/** c637cc/c4c7b8: current-preset broadcast of a numeric effective-start snapshot;
 * no dynamic link, loaded-data check, channel-processing-link or sum check. */
export function setSharedHfdCrop(preset: Preset, sourceChannel: number | null): Preset {
  if (
    sourceChannel !== null &&
    (!Number.isInteger(sourceChannel) ||
      sourceChannel < 0 ||
      sourceChannel >= preset.channels.length)
  )
    throw new Error('Invalid shared crop source channel');
  if (
    preset.channels.length !== 3 ||
    new Set(preset.channels).size !== 3 ||
    preset.channels.some((c) => !c.hfdMeasurement)
  )
    throw new Error(
      'Explicitly enable native measurement processing for all three preset channels first',
    );
  const proposed = structuredClone(preset),
    start =
      sourceChannel === null
        ? -1
        : effectiveHfdCropStart(proposed.channels[sourceChannel].hfdMeasurement!);
  proposed.channels.forEach((c) =>
    updateHfdMeasurement(c, {
      sharedStart: start,
      sharedGroupId: sourceChannel === null ? -1 : sourceChannel + 1,
    }),
  );
  Object.assign(preset, proposed);
  return preset;
}

export function hfdMeasurementStatus(channel: Channel, calibration?: Project['hfdCalibration']) {
  const options = channel.hfdMeasurement,
    warnings: string[] = [];
  if (options) {
    validateHfdMeasurementOptions(options);
    if (!channel.measurement?.impulse?.length)
      warnings.push(
        'Native crop and phase processing require original impulse samples; unloaded settings are retained.',
      );
    if ((channel.measurement?.impulse?.length ?? 0) > options.fftLength)
      warnings.push('Native measurement FFT uses only the first 65536 original samples.');
    const nativeResource = calibration?.loaded && calibration.resource;
    if (
      options.applyMicCorrection &&
      (calibration ? !nativeResource : !channel.measurement?.processing?.calibration)
    )
      warnings.push(
        'Native microphone correction is requested but its correction resource is not loaded; correction is not applied.',
      );
    if (options.applyMicCorrection && !calibration && channel.measurement?.processing?.calibration)
      warnings.push(
        'A legacy browser correction curve is applied. Load a project microphone file to use native magnitude-derived correction.',
      );
    if ((channel.measurement?.processing?.window?.taper ?? 0) !== 0)
      warnings.push('The retained browser taper is ignored by native rectangular crop processing.');
    if (options.smoothBw === 0)
      warnings.push(
        'Native zero pre-interpolation bandwidth is singular; the recovered exception path returns zero and requires a native edge-case fixture.',
      );
    warnings.push(
      'Native measurement processing follows recovered static code; a native GUI comparison remains pending.',
    );
  }
  return {
    native: !!options,
    mode: options ? ('hfd' as const) : ('browser' as const),
    options: options ? { ...options } : null,
    effectiveStart: options ? effectiveHfdCropStart(options) : null,
    hasImpulse: !!channel.measurement?.impulse?.length,
    warnings,
  };
}
