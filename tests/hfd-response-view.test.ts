import { expect, it } from 'vitest';
import { newFilter, newProject, type Channel } from '../src/domain/model';
import { channelResponse } from '../src/domain/dsp';
import { measurementResponse } from '../src/domain/measurement';
import { defaultsHfdMeasurementOptions } from '../src/domain/hfd-measurement';
import { buildHfdResponseView, hfdCentering, sampleHfdView } from '../src/domain/hfd-response-view';

const grid = () =>
  Array.from({ length: 1024 }, (_, j) => 10 * Math.exp((Math.log(46875 / 10) * j) / 1024));
function source(db = 0, phase = 0, dedicated = phase): Channel {
  const c = newProject().presets[0].channels[0],
    frequency = grid();
  c.hfdMeasurement = { ...defaultsHfdMeasurementOptions(), smoothPostBw: 0.0001 };
  // Synthetic pre-plot cache isolates display composition from FFT generation,
  // independently tested in hfd-measurement.test.ts.
  c.measurement = {
    name: 'Synthetic source',
    sampleRate: 48000,
    impulse: [1, 0],
    frequency,
    magnitude: frequency.map(() => db),
    phase: frequency.map(() => phase),
    hfdMagnitude: {
      frequency: frequency.slice(),
      linearMagnitude: frequency.map(() => 10 ** (db / 20)),
      medianDb: db,
    },
    hfdPhase: { frequency: frequency.slice(), phase: frequency.map(() => dedicated) },
  };
  return c;
}
it('centers all loaded medians together independently of sum inclusion', () => {
  const a = source(-4),
    b = source(-12);
  b.includeInSum = false;
  const view = buildHfdResponseView([a, b], { measured: true, sum: true })!;
  expect(view.centerOffsetDb).toBe(-8);
  expect(view.channels[0].db[500]).toBeCloseTo(4, 10);
  expect(view.channels[1].db[500]).toBeCloseTo(-4, 10);
  expect(view.sum!.db[500]).toBeCloseTo(4, 10);
  expect(hfdCentering([a, b], false).offsetDb).toBe(0);
});
it('keeps independent phase and unit-phasor sums separate from magnitude complex sources', () => {
  const a = source(0, 60),
    b = source(-40, -60),
    before = structuredClone([a, b]);
  const view = buildHfdResponseView([a, b], { measured: true, sum: true, centered: false })!;
  expect(view.sum!.phase[500]).toBeCloseTo(0, 10);
  expect(view.channels[0].phase[500]).toBeCloseTo(60, 10);
  const combined = [
    measurementResponse(a.measurement!, 1000),
    measurementResponse(b.measurement!, 1000),
  ];
  expect(
    (Math.atan2(combined[0][1] + combined[1][1], combined[0][0] + combined[1][0]) * 180) / Math.PI,
  ).toBeGreaterThan(59);
  a.measurement!.hfdPhase!.phase.fill(0);
  expect(
    buildHfdResponseView([a], { measured: true, centered: false })!.channels[0].phase[500],
  ).toBeCloseTo(0, 12);
  expect(measurementResponse(a.measurement!, 1000)[1]).toBeCloseTo(Math.sqrt(3) / 2, 10);
  a.measurement!.hfdPhase!.phase.fill(60);
  expect([a, b]).toEqual(before);
});
it('retains literal native zeros through channel gain and clamps display only afterward', () => {
  const c = source(-200);
  c.gain = 18;
  c.measurement!.hfdMagnitude!.linearMagnitude.fill(0);
  expect(Math.hypot(...channelResponse(c, 1000, true))).toBe(0);
  const view = buildHfdResponseView([c], { measured: true, centered: false, sum: true })!;
  expect(view.channels[0].db[500]).toBeCloseTo(-200, 12);
  expect(view.sum!.db[500]).toBeCloseTo(-200, 12);
});
it('post-smooths the filtered dB response, rather than smoothing measurements before filtering', () => {
  const c = source();
  c.filters[0] = { ...newFilter('peak'), frequency: 1000, q: 5, gain: 12 };
  c.hfdMeasurement!.smoothPostBw = 0.5;
  const view = buildHfdResponseView([c], { measured: true, centered: false })!,
    j = view.frequency.findIndex((f) => f >= 1000),
    raw = view.frequency.map(
      (f) => 20 * Math.log10(Math.max(1e-10, Math.hypot(...channelResponse(c, f, true)))),
    ),
    n = raw.length,
    s = (n * 0.5 * Math.LN2) / Math.log(view.frequency.at(-1)! / view.frequency[0]),
    a = Math.sqrt(Math.LN2) / s,
    g = Array.from({ length: n }, (_, i) => Math.exp(-((i * a) ** 2))),
    z = 1 + 2 * g.slice(1).reduce((p, v) => p + v, 0);
  let expected = (g[0] / z) * raw[j];
  for (let i = 1; i <= Math.min(Math.ceil(4 * s), n - 1); i++)
    expected += (g[i] / z) * (raw[Math.max(0, j - i)] + raw[Math.min(n - 1, j + i)]);
  expect(view.channels[0].db[j]).toBeCloseTo(expected, 10);
  expect(Math.abs(view.channels[0].db[j] - raw[j])).toBeGreaterThan(1);
});
it('uses selected-channel post width for sums and gates unloaded filter previews', () => {
  const a = source(),
    b = source();
  a.filters[0] = { ...newFilter('peak'), frequency: 1000, q: 5, gain: 12 };
  a.hfdMeasurement!.smoothPostBw = 0.0001;
  b.hfdMeasurement!.smoothPostBw = 1;
  const unloaded = newProject().presets[0].channels[0],
    one = buildHfdResponseView([a, b, unloaded], {
      measured: true,
      sum: true,
      referenceChannel: 0,
    })!,
    two = buildHfdResponseView([a, b, unloaded], {
      measured: true,
      sum: true,
      referenceChannel: 1,
      showUnloadedFilters: true,
    })!;
  expect(one.channels[2].visible).toBe(false);
  expect(two.channels[2].visible).toBe(true);
  expect(one.sum!.db).not.toEqual(two.sum!.db);
  expect(one.channels[0].db).toEqual(two.channels[0].db);
  expect(buildHfdResponseView([a, b], { measured: false })).toBeNull();
});
it('does not manufacture native centering for legacy data or extrapolate outside the native grid', () => {
  const a = source(-4),
    legacy = source(-12);
  delete legacy.hfdMeasurement;
  const view = buildHfdResponseView([a, legacy], { measured: true })!;
  expect(view.centered).toBe(false);
  expect(view.warnings.some(w=>/mixed/i.test(w))).toBe(true);
  expect(sampleHfdView(view, view.channels[0].db, 1)).toBeNull();
  expect(sampleHfdView(view, view.channels[0].db, 50000)).toBeNull();
  expect(sampleHfdView(view, view.channels[0].db, 1000)).toBeCloseTo(-4, 10);
});
