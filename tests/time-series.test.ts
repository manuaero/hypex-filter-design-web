import { expect, it } from 'vitest';
import {
  DEFAULT_TIME_RANGE,
  fitTimeSeries,
  plotTimeSeries,
  type TimeSeries,
} from '../src/domain/time-series';
const series = (samples: ArrayLike<number>, startTimeMs = 0, sampleRate = 1000): TimeSeries => ({
  samples,
  startTimeMs,
  sampleRate,
});
it('keeps positive and negative impulses narrower than a pixel with chronological extrema', () => {
  const samples = new Float64Array(10000);
  samples[142] = 0.8;
  samples[148] = -0.6;
  const points = plotTimeSeries(
    series(samples),
    { timeMinMs: 0, timeMaxMs: 10000, amplitudeMin: -1, amplitudeMax: 1 },
    20,
  );
  expect(points.some((p) => p.timeMs === 142 && p.value === 0.8)).toBe(true);
  expect(points.some((p) => p.timeMs === 148 && p.value === -0.6)).toBe(true);
  expect(points.every((p, i) => !i || p.timeMs >= points[i - 1].timeMs)).toBe(true);
  expect(points.length).toBeLessThanOrEqual(2 * 20 + 6);
});
it('retains the temporal order when a bucket minimum occurs before its maximum', () => {
  const points = plotTimeSeries(
    series([0, -3, 2, 0]),
    { timeMinMs: 0, timeMaxMs: 4, amplitudeMin: -4, amplitudeMax: 3 },
    1,
  );
  expect(points.filter((p) => p.value === -3 || p.value === 2)).toEqual([
    { timeMs: 1, value: -3 },
    { timeMs: 2, value: 2 },
  ]);
});
it('fits mixed signed origins and different rates with one shared amplitude scale including zero', () => {
  const fitted = fitTimeSeries([series([0, 0.25, 0], -5, 1000), series([0, -2, 0, 1], 3, 2000)]);
  expect(fitted.timeMinMs).toBe(-5);
  expect(fitted.timeMaxMs).toBe(5);
  expect(fitted.amplitudeMin).toBeCloseTo(-2.15);
  expect(fitted.amplitudeMax).toBeCloseTo(1.15);
  const range = { ...fitted, timeMinMs: -6, timeMaxMs: 6 };
  expect(plotTimeSeries(series([0, 0.25, 0], -5), range, 100).some((p) => p.value === 0.25)).toBe(
    true,
  );
  expect(
    plotTimeSeries(series([0, -2, 0, 1], 3, 2000), range, 100).some((p) => p.value === -2),
  ).toBe(true);
});
it('explicit fit bounds use visible data without normalizing each driver', () => {
  const fitted = fitTimeSeries([series([8, 0, 0.5, 0, 0])], { minMs: 1, maxMs: 4 });
  expect(fitted).toEqual({ timeMinMs: 1, timeMaxMs: 4, amplitudeMin: -0.025, amplitudeMax: 0.525 });
});
it('clips a delayed record to its actual sample times without zero extensions', () => {
  const points = plotTimeSeries(
    series([2, 1], 4),
    { timeMinMs: 0, timeMaxMs: 10, amplitudeMin: -1, amplitudeMax: 3 },
    100,
  );
  expect(points).toEqual([
    { timeMs: 4, value: 2 },
    { timeMs: 5, value: 1 },
  ]);
});
it('interpolates within the record and leaves an entirely outside view empty', () => {
  const input = series([0, 2, 0], -1);
  expect(
    plotTimeSeries(
      input,
      { timeMinMs: -0.5, timeMaxMs: 0.5, amplitudeMin: -1, amplitudeMax: 3 },
      8,
    ),
  ).toEqual([
    { timeMs: -0.5, value: 1 },
    { timeMs: 0, value: 2 },
    { timeMs: 0.5, value: 1 },
  ]);
  expect(
    plotTimeSeries(input, { timeMinMs: 10, timeMaxMs: 11, amplitudeMin: -1, amplitudeMax: 1 }, 4),
  ).toEqual([]);
  expect(
    plotTimeSeries(input, { timeMinMs: -4, timeMaxMs: -2, amplitudeMin: -1, amplitudeMax: 1 }, 4),
  ).toEqual([]);
});
it('preserves the final step plateau instead of inventing a future return to zero', () => {
  const input = series([0, 1, 1, 1], -5);
  const points = plotTimeSeries(
    input,
    { timeMinMs: -10, timeMaxMs: 10, amplitudeMin: -1, amplitudeMax: 2 },
    1,
  );
  expect(points[0]).toEqual({ timeMs: -5, value: 0 });
  expect(points.at(-1)).toEqual({ timeMs: -2, value: 1 });
  expect(points.every((point) => point.timeMs >= -5 && point.timeMs <= -2)).toBe(true);
  expect(
    plotTimeSeries(input, { timeMinMs: -1.9, timeMaxMs: -1, amplitudeMin: -1, amplitudeMax: 2 }, 4),
  ).toEqual([]);
});
it('clips partially outside signed records and retains a one-sample record', () => {
  const input = series([1, 3, 5], -3);
  expect(
    plotTimeSeries(input, { timeMinMs: -2.5, timeMaxMs: 0, amplitudeMin: 0, amplitudeMax: 6 }, 8),
  ).toEqual([
    { timeMs: -2.5, value: 2 },
    { timeMs: -2, value: 3 },
    { timeMs: -1, value: 5 },
  ]);
  expect(plotTimeSeries(series([0.75], -1), DEFAULT_TIME_RANGE, 8)).toEqual([]);
  expect(plotTimeSeries(series([0.75], 1), DEFAULT_TIME_RANGE, 8)).toEqual([
    { timeMs: 1, value: 0.75 },
  ]);
});
it('handles empty and muted data without zero-width time or amplitude ranges', () => {
  expect(fitTimeSeries([])).toEqual(DEFAULT_TIME_RANGE);
  expect(fitTimeSeries([series([], -10)])).toEqual(DEFAULT_TIME_RANGE);
  expect(fitTimeSeries([series(new Float64Array(10), -3)])).toEqual({
    timeMinMs: -3,
    timeMaxMs: 7,
    amplitudeMin: -1,
    amplitudeMax: 1,
  });
  expect(plotTimeSeries(series([]), DEFAULT_TIME_RANGE, 20)).toEqual([]);
});
it('does not mutate arrays, origins, ranges or explicit fit bounds', () => {
  const samples = [0, 1, -2],
    input = series(samples, -2),
    range = { ...DEFAULT_TIME_RANGE },
    bounds = { minMs: -2, maxMs: 1 },
    before = structuredClone({ samples, input, range, bounds });
  fitTimeSeries([input], bounds);
  plotTimeSeries(input, range, 80);
  expect({ samples, input, range, bounds }).toEqual(before);
});
it.each([0, -1, NaN, Infinity])('rejects invalid sample rates %s', (rate) => {
  expect(() => fitTimeSeries([series([0, 1], 0, rate)])).toThrow();
  expect(() => plotTimeSeries(series([0, 1], 0, rate), DEFAULT_TIME_RANGE, 10)).toThrow();
});
it('guards invalid ranges, samples, bounds and excessive allocations', () => {
  expect(() => fitTimeSeries([series([0, NaN])])).toThrow('finite');
  expect(() => fitTimeSeries([series([1], Infinity)])).toThrow();
  expect(() => fitTimeSeries([], { minMs: 2, maxMs: 1 })).toThrow('bounds');
  expect(() =>
    plotTimeSeries(series([0, 1]), { ...DEFAULT_TIME_RANGE, timeMinMs: 1, timeMaxMs: 1 }, 10),
  ).toThrow('range');
  expect(() =>
    plotTimeSeries(series([0, 1]), { ...DEFAULT_TIME_RANGE, amplitudeMin: 1, amplitudeMax: 1 }, 10),
  ).toThrow('range');
  for (const pixels of [0, -1, 1.5, Infinity, 20000])
    expect(() => plotTimeSeries(series([0, 1]), DEFAULT_TIME_RANGE, pixels)).toThrow('pixel');
  expect(() => fitTimeSeries([series({ length: 2 ** 22 + 1 })])).toThrow('sample count');
});
