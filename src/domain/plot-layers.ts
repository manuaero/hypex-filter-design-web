import {
  FS,
  unity,
  emptyFir,
  newFilter,
  type Channel,
  type Coefficients,
  type Filter,
  type Preset,
} from './model';
import { response, FILTER_NAMES } from './dsp';
import { designHfd } from './hfd-math';
import { measurementResponse } from './measurement';
import { hfdSmoothPlot } from './hfd-measurement';
import { buildHfdResponseView, hfdCentering } from './hfd-response-view';
import { prepareNativeElectricalView } from './native-electrical-view';

export interface MagnitudeLayers {
  rawMeasurements: boolean[];
  /** Native result/section are automatic; hiding either is a browser display extension. */
  currentResult: boolean;
  /** Other filtered outputs are a browser overlay, separate from native raw CH boxes. */
  otherResults?: boolean;
  section: boolean;
}
export interface MagnitudeLayerCurve {
  kind: 'raw' | 'result' | 'section' | 'sum';
  channel?: number;
  filter?: number;
  label: string;
  color: string;
  width: number;
  db: number[];
}
export interface MagnitudeLayerData {
  frequency: number[];
  curves: MagnitudeLayerCurve[];
  availability: boolean[];
  warnings: string[];
  centerOffsetDb: number;
  centered: boolean;
}
/** Fresh owned native FA503 XML has GraphShowMeasuredRespons/GraphShowSum false.
 * Main editor refresh c5fe2d..74 overrides the resource's initial Show=true.
 * Result and selected-or-cascade series have no native visibility checkbox. */
export function defaultMagnitudeLayers(channelCount = 3): MagnitudeLayers {
  if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 6)
    throw new Error('Invalid magnitude layer channel count');
  return {
    rawMeasurements: new Array<boolean>(channelCount).fill(false),
    currentResult: true,
    section: true,
  };
}

/** Native c5d2c0 -> c74384 recalculates the selected parameter section and applies
 * channel gain1. c74420 -> a8edc8 evaluates it directly, bypassing the enable
 * guards in a8ed60. Parameter sections must be regenerated: a disabled imported
 * compiled cache can contain Unity. Free coefficients remain exactly supplied.
 * This does not mutate a filter or bake channel trim/invert/mute/EQ/FIR into it. */
export function selectedSectionCoefficients(filter: Filter): Coefficients {
  if (!filter || typeof filter !== 'object') throw new Error('No filter section selected');
  const coefficients =
    filter.kind === 'unity'
      ? unity()
      : filter.kind === 'raw'
        ? filter.coefficients && { ...filter.coefficients }
        : designHfd({ ...filter, enabled: true });
  if (
    !coefficients ||
    !['b0', 'b1', 'b2', 'f1', 'f2'].every((key) =>
      Number.isFinite(coefficients[key as keyof Coefficients]),
    )
  )
    throw new Error('Selected free section requires finite original coefficients');
  return coefficients;
}
export function selectedSectionResponse(filter: Filter, frequency: number): [number, number] {
  if (!Number.isFinite(frequency) || frequency < 0) throw new Error('Invalid response frequency');
  return response(selectedSectionCoefficients(filter), frequency);
}

/** Native c608f8/c6dd90 stores Single(f1), then Single(dB) from the same
 * section's unbypassed matched-z roots/Kz (a8edc8), not its direct gain cache.
 * No channel processing, measurement or graph centering enters this anchor. */
export function filterMarkerAnchor(filter: Filter): { frequency: number; db: number } | undefined {
  if (
    !filter ||
    !Object.hasOwn(FILTER_NAMES, filter.kind) ||
    filter.kind === 'unity' ||
    filter.kind === 'raw' ||
    ![filter.frequency, filter.q, filter.gain].every(Number.isFinite) ||
    (filter.kind === 'asymmetric' && ![filter.frequency2, filter.q2].every(Number.isFinite))
  )
    return undefined;
  const frequency = Math.fround(filter.frequency);
  if (!Number.isFinite(frequency) || frequency <= 0) return undefined;
  try {
    const db = Math.fround(
      20 * Math.log10(Math.hypot(...selectedSectionResponse(filter, frequency))),
    );
    return Number.isFinite(db) ? { frequency, db } : undefined;
  } catch {
    // A malformed section must not place an invented zero-dB handle or prevent
    // the remaining valid sections from being inspected.
    return undefined;
  }
}

/** A detached analysis-only channel for the ordinary Magnitude/Phase renderer.
 * Construct explicitly so large measurement arrays/resources are neither cloned
 * nor accidentally retained. The live/original signal chain stays bypassed. */
export function selectedSectionAnalysisChannel(
  channel: Channel,
  filter: Filter,
  index: number,
): Channel {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= channel.filters.length ||
    channel.filters[index].id !== filter.id
  )
    throw new Error('Invalid selected section index');
  if (index === 0 && filter.kind === 'raw' && channel.coefficientCache === 'unresolved')
    throw new Error('Resolve the first free section gain cache before isolated response analysis');
  const coefficients = selectedSectionCoefficients(filter),
    first = { ...newFilter('raw'), id: filter.id, enabled: true, coefficients };
  return {
    id: channel.id,
    name: channel.name,
    outputName: channel.outputName,
    gain: 0,
    additionalGain: 0,
    invert: false,
    muted: false,
    delayUs: 0,
    globalDelayUs: 0,
    filters: [first, ...Array.from({ length: 14 }, () => newFilter())],
    fir: emptyFir(),
    includeInSum: true,
    coefficientCache: 'base',
  };
}

const hasSpectrum = (channel: Channel) =>
  !!(
    channel.measurement?.frequency?.length &&
    channel.measurement.magnitude?.length === channel.measurement.frequency.length
  );
const nativeMeasurementLoaded = (channel: Channel) =>
  !!(channel.measurement?.impulse?.length || channel.measurement?.frequency?.length);
/** Native selection refresh c5fe2d..74 restores only the current group's saved
 * Show/Sum. Other CH checkbox states belong to the open graph and survive a
 * selection change. Gate visibility against loaded measurement data without
 * rewriting preserved imported flags (native callback writeback is a separate
 * action). The returned array is detached; neither model nor caller view mutates. */
export function restoreNativeGraphSelection(
  channels: Channel[],
  rawMeasurements: readonly boolean[],
  selectedChannel: number,
): { rawMeasurements: boolean[]; showSum: boolean } {
  if (
    !Number.isInteger(selectedChannel) ||
    selectedChannel < 0 ||
    selectedChannel >= channels.length ||
    rawMeasurements.length !== channels.length ||
    !rawMeasurements.every((value) => typeof value === 'boolean')
  )
    throw new Error('Invalid native graph selection');
  const current = channels[selectedChannel],
    raw = [...rawMeasurements];
  raw[selectedChannel] =
    !!current.hfdGraph?.showMeasuredResponse && nativeMeasurementLoaded(current);
  return { rawMeasurements: raw, showSum: current.hfdGraph?.showSum ?? false };
}
/** Explicit native selection callback writeback (c5fe2d..54 -> c6349c).
 * Only a user native-view action should call this; never a parser/hydrator.
 * Native Loaded is source data, not whether its display FFT cache is ready. */
export function normalizeNativeGraphSelection(channel: Channel): boolean {
  if (!channel.hfdGraph?.showMeasuredResponse || nativeMeasurementLoaded(channel)) return false;
  channel.hfdGraph = { ...channel.hfdGraph, showMeasuredResponse: false };
  return true;
}
// Native c76628 floors nonfinite/overflowing components as well as true zeros.
const db = (value: [number, number]) =>
  value.every((component) => Number.isFinite(component) && Math.abs(component) < 1e100)
    ? 20 * Math.log10(Math.max(1e-10, Math.hypot(...value)))
    : -200;

/** Native main-editor layers (not the recording form):
 * - c6349c/c6472c: Show aliases the current CH raw checkbox; other boxes are raw.
 * - c5b773..b7ad/c60391..c3c3: corrected magnitude -> common center -> own post.
 * - c5d6b0: current filtered result and complex UseInSum sum ignore raw visibility.
 * - c5c3f0/c5d5b8: one selected section, or one complete electrical cascade.
 * Layer booleans never alter includeInSum, calibration, processing or originals.
 * Caller owns native persisted Group flags/selection restoration, or can choose
 * an explicitly browser-only view preference. Missing options retain defaults. */
export function buildMagnitudeLayers(
  channels: Channel[],
  options: {
    preset?: Preset;
    layers?: MagnitudeLayers;
    referenceChannel?: number;
    selectedFilter?: number | null;
    sum?: boolean;
    /** false retains the browser's electrical-result mode; raw overlays stay independent. */
    measured?: boolean;
    centered?: boolean;
    showUnloadedFilters?: boolean;
  } = {},
): MagnitudeLayerData {
  const layers = options.layers ?? defaultMagnitudeLayers(channels.length),
    reference = options.referenceChannel ?? 0,
    measured = options.measured ?? true;
  if (
    !Array.isArray(layers.rawMeasurements) ||
    layers.rawMeasurements.length !== channels.length ||
    !layers.rawMeasurements.every((value) => typeof value === 'boolean') ||
    typeof layers.currentResult !== 'boolean' ||
    (layers.otherResults !== undefined && typeof layers.otherResults !== 'boolean') ||
    typeof layers.section !== 'boolean' ||
    !Number.isInteger(reference) ||
    reference < 0 ||
    reference >= channels.length ||
    (options.selectedFilter !== undefined &&
      options.selectedFilter !== null &&
      (!Number.isInteger(options.selectedFilter) ||
        options.selectedFilter < 0 ||
        options.selectedFilter >= channels[reference].filters.length))
  )
    throw new Error('Invalid magnitude layer selection');
  const availability = channels.map(hasSpectrum),
    nativeView = buildHfdResponseView(channels, {
      preset: options.preset,
      measured,
      sum: options.sum,
      centered: options.centered,
      referenceChannel: reference,
      showUnloadedFilters: options.showUnloadedFilters,
    }),
    frequency =
      nativeView?.frequency.slice() ??
      Array.from({ length: 1024 }, (_, i) => 10 * Math.exp((Math.log(FS / 2 / 10) * i) / 1024)),
    center = hfdCentering(channels, options.centered ?? true),
    centerOffsetDb = center.offsetDb,
    warnings = [...(nativeView?.warnings ?? [])],
    curves: MagnitudeLayerCurve[] = [];
  const projection = prepareNativeElectricalView(channels, options.preset),
    electrical = (index: number, f: number) => projection.evaluate(index, f),
    result = (index: number, f: number) => projection.evaluate(index, f, measured),
    post = (values: number[], index: number) =>
      Array.from(
        hfdSmoothPlot(values, frequency, channels[index].hfdMeasurement?.smoothPostBw ?? 0),
      );
  for (let index = 0; index < channels.length; index++) {
    if (!layers.rawMeasurements[index] || !availability[index]) continue;
    curves.push({
      kind: 'raw',
      channel: index,
      label: `${channels[index].name} measured`,
      color: index === reference ? '#ed7b87' : '#c5afd9',
      width: index === reference ? 1.4 : 1,
      db: post(
        frequency.map(
          (f) => db(measurementResponse(channels[index].measurement!, f)) - centerOffsetDb,
        ),
        index,
      ),
    });
  }
  // Match the classic all-output palette only when that browser overlay is on.
  // Native current-only result keeps its orange color on every selected output.
  const resultColors = ['#efb45d', '#58d6bb', '#a596f5'];
  for (let index = 0; index < channels.length; index++) {
    if (!(index === reference ? layers.currentResult : layers.otherResults)) continue;
    if (measured && !availability[index] && !options.showUnloadedFilters) continue;
    curves.push({
      kind: 'result',
      channel: index,
      label:
        index === reference
          ? measured
            ? 'Current filtered result'
            : 'Current electrical result'
          : `${channels[index].name} ${measured ? 'filtered' : 'electrical'} result`,
      color: layers.otherResults ? resultColors[index % resultColors.length] : '#efb45d',
      width: index === reference ? 2 : 1.5,
      db:
        nativeView?.channels[index].db.slice() ??
        post(
          frequency.map((f) => db(result(index, f)) - (measured ? centerOffsetDb : 0)),
          index,
        ),
    });
  }
  if (options.sum) {
    const included = channels.flatMap((channel, index) =>
      channel.includeInSum === false || (measured && !availability[index]) ? [] : [index],
    );
    if (included.length)
      curves.push({
        kind: 'sum',
        label: 'Selected channel sum',
        color: '#e9eddf',
        width: 1.6,
        db:
          nativeView?.sum?.db.slice() ??
          post(
            frequency.map((f) => {
              const sum = included.reduce<[number, number]>(
                (value, index) => {
                  const [re, im] = result(index, f);
                  return [value[0] + re, value[1] + im];
                },
                [0, 0],
              );
              return db(sum) - (measured ? centerOffsetDb : 0);
            }),
            reference,
          ),
      });
  }
  if (layers.section) {
    try {
      const selected = options.selectedFilter,
        channel = channels[reference];
      let values: number[];
      if (selected !== null && selected !== undefined) {
        const filter = channel.filters[selected];
        const coefficients = selectedSectionAnalysisChannel(channel, filter, selected).filters[0]
          .coefficients!;
        values = frequency.map((f) => db(response(coefficients, f)));
      } else values = frequency.map((f) => db(electrical(reference, f)));
      curves.push({
        kind: 'section',
        channel: reference,
        ...(selected === undefined || selected === null ? {} : { filter: selected }),
        label:
          selected === undefined || selected === null
            ? 'Electrical cascade'
            : `Selected biquad ${selected + 1}`,
        color: '#58d6bb',
        width: 1,
        db: values,
      });
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : 'Section response unavailable');
    }
  }
  return {
    frequency,
    curves,
    availability,
    warnings: [...new Set(warnings)],
    centerOffsetDb,
    centered: center.centered,
  };
}
