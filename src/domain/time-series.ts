export interface TimeSeries {
  samples: ArrayLike<number>;
  sampleRate: number;
  startTimeMs: number;
}
export interface TimePlotRange {
  timeMinMs: number;
  timeMaxMs: number;
  amplitudeMin: number;
  amplitudeMax: number;
}
export interface TimePlotPoint {
  timeMs: number;
  value: number;
}
export const DEFAULT_TIME_RANGE: Readonly<TimePlotRange> = Object.freeze({
  timeMinMs: 0,
  timeMaxMs: (8192 / 93750) * 1000,
  amplitudeMin: -1,
  amplitudeMax: 1,
});
const MAX_SAMPLES = 2 ** 22;
const MAX_PIXELS = 16384;
function validateSeries(series: TimeSeries) {
  if (
    !series ||
    !Number.isFinite(series.sampleRate) ||
    series.sampleRate <= 0 ||
    !Number.isFinite(series.startTimeMs)
  )
    throw new Error('Time series requires a finite origin and positive sample rate');
  const length = series.samples?.length;
  if (!Number.isInteger(length) || length < 0 || length > MAX_SAMPLES)
    throw new Error('Invalid or oversized time-series sample count');
  for (let i = 0; i < length; i++)
    if (!Number.isFinite(series.samples[i])) throw new Error('Time-series samples must be finite');
  const interval = 1000 / series.sampleRate,
    end = series.startTimeMs + length * interval;
  if (
    !Number.isFinite(interval) ||
    !Number.isFinite(end) ||
    (length > 0 && end <= series.startTimeMs)
  )
    throw new Error('Time-series extent is not finite or representable');
  return { length, interval, end };
}
function validateRange(range: TimePlotRange) {
  if (
    !range ||
    !Object.values(range).every(Number.isFinite) ||
    range.timeMinMs >= range.timeMaxMs ||
    range.amplitudeMin >= range.amplitudeMax ||
    !Number.isFinite(range.timeMaxMs - range.timeMinMs) ||
    !Number.isFinite(range.amplitudeMax - range.amplitudeMin)
  )
    throw new Error('Invalid time plot range');
}
function sampleAt(series: TimeSeries, timeMs: number, interval: number) {
  const last = series.samples.length - 1;
  const end = series.startTimeMs + last * interval;
  if (last < 0 || timeMs < series.startTimeMs || timeMs > end) return 0;
  const position = Math.max(0, Math.min(last, (timeMs - series.startTimeMs) / interval));
  const index = Math.floor(position),
    fraction = position - index;
  return (
    (1 - fraction) * series.samples[index] + fraction * series.samples[Math.min(last, index + 1)]
  );
}
function visibleIndices(
  series: TimeSeries,
  range: { timeMinMs: number; timeMaxMs: number },
  interval: number,
) {
  const first = (range.timeMinMs - series.startTimeMs) / interval,
    last = (range.timeMaxMs - series.startTimeMs) / interval;
  const epsilon = (value: number) => Number.EPSILON * Math.max(1, Math.abs(value)) * 8;
  return {
    first: Math.max(0, Math.ceil(first - epsilon(first))),
    last: Math.min(series.samples.length - 1, Math.floor(last + epsilon(last))),
  };
}
/** Fit every visible channel against the same unnormalized amplitude scale.
 * The record's right boundary is one sample interval after its last sample. */
export function fitTimeSeries(
  series: readonly TimeSeries[],
  bounds?: { minMs: number; maxMs: number },
): TimePlotRange {
  if (!Array.isArray(series) || series.length > 32)
    throw new Error('Invalid or oversized time-series collection');
  if (
    bounds &&
    (!Number.isFinite(bounds.minMs) ||
      !Number.isFinite(bounds.maxMs) ||
      bounds.minMs >= bounds.maxMs)
  )
    throw new Error('Invalid time fit bounds');
  const info = series.map(validateSeries),
    available = info
      .map((entry, i) => ({ entry, series: series[i] }))
      .filter((item) => item.entry.length > 0);
  let timeMinMs =
    bounds?.minMs ??
    (available.length
      ? Math.min(...available.map((item) => item.series.startTimeMs))
      : DEFAULT_TIME_RANGE.timeMinMs);
  let timeMaxMs =
    bounds?.maxMs ??
    (available.length
      ? Math.max(...available.map((item) => item.entry.end))
      : DEFAULT_TIME_RANGE.timeMaxMs);
  if (!(timeMaxMs > timeMinMs) || !Number.isFinite(timeMaxMs - timeMinMs))
    throw new Error('Invalid time-series fit extent');
  let minimum = 0,
    maximum = 0;
  for (let n = 0; n < series.length; n++) {
    const source = series[n],
      entry = info[n];
    const { first, last } = visibleIndices(source, { timeMinMs, timeMaxMs }, entry.interval);
    for (let i = first; i <= last; i++) {
      minimum = Math.min(minimum, source.samples[i]);
      maximum = Math.max(maximum, source.samples[i]);
    }
    for (const edge of [timeMinMs, timeMaxMs]) {
      const value = sampleAt(source, edge, entry.interval);
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  const span = maximum - minimum;
  const result = {
    timeMinMs,
    timeMaxMs,
    amplitudeMin: span === 0 ? -1 : minimum - span * 0.05,
    amplitudeMax: span === 0 ? 1 : maximum + span * 0.05,
  };
  validateRange(result);
  return result;
}
/** Preserve chronological min/max samples in each horizontal pixel bucket.
 * View edges interpolate only between recorded samples; nothing is extrapolated. */
export function plotTimeSeries(
  series: TimeSeries,
  range: TimePlotRange,
  pixels: number,
): TimePlotPoint[] {
  const { length, interval } = validateSeries(series);
  validateRange(range);
  if (!Number.isInteger(pixels) || pixels < 1 || pixels > MAX_PIXELS)
    throw new Error('Invalid time plot pixel count');
  if (!length) return [];
  const timeMinMs = Math.max(range.timeMinMs, series.startTimeMs);
  const timeMaxMs = Math.min(range.timeMaxMs, series.startTimeMs + (length - 1) * interval);
  if (timeMinMs > timeMaxMs) return [];
  const points: TimePlotPoint[] = [
    { timeMs: timeMinMs, value: sampleAt(series, timeMinMs, interval) },
  ];
  const { first, last } = visibleIndices(series, { timeMinMs, timeMaxMs }, interval);
  const buckets = new Map<number, { min: number; max: number }>();
  for (let i = first; i <= last; i++) {
    const time = series.startTimeMs + i * interval;
    const bucket = Math.max(
      0,
      Math.min(
        pixels - 1,
        Math.floor(((time - range.timeMinMs) / (range.timeMaxMs - range.timeMinMs)) * pixels),
      ),
    );
    const pair = buckets.get(bucket);
    if (!pair) buckets.set(bucket, { min: i, max: i });
    else {
      if (series.samples[i] < series.samples[pair.min]) pair.min = i;
      if (series.samples[i] > series.samples[pair.max]) pair.max = i;
    }
  }
  for (const pair of buckets.values())
    for (const index of pair.min === pair.max
      ? [pair.min]
      : [pair.min, pair.max].sort((a, b) => a - b))
      points.push({ timeMs: series.startTimeMs + index * interval, value: series.samples[index] });
  points.push({ timeMs: timeMaxMs, value: sampleAt(series, timeMaxMs, interval) });
  points.sort((a, b) => a.timeMs - b.timeMs);
  return points.filter(
    (point, i) =>
      !i || point.timeMs !== points[i - 1].timeMs || point.value !== points[i - 1].value,
  );
}
