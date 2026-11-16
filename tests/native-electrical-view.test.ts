import { expect, it } from 'vitest';
import { newFilter, newProject, type Channel } from '../src/domain/model';
import { defaultsHfdMeasurementOptions } from '../src/domain/hfd-measurement';
import { buildHfdResponseView } from '../src/domain/hfd-response-view';
import { buildMagnitudeLayers } from '../src/domain/plot-layers';
import { channelResponse, presetResponse } from '../src/domain/dsp';
import { prepareNativeElectricalView } from '../src/domain/native-electrical-view';

// V53 saved E/U direct vectors. These remain authoritative stored data, while
// the native frequency evaluator uses the separate parameter/root cascade.
const caches = [
  {
    b0: 2.44574919954224,
    b1: -4.17584322035288,
    b2: 1.77977956129335,
    f1: 1.85236017184606,
    f2: -0.874553956539528,
  },
  { b0: 0.75, b1: 0.125, b2: 0.0625, f1: 0.25, f2: -0.125 },
];
function source(cache = caches[1]): Channel {
  const channel = newProject().presets[0].channels[0];
  channel.filters[0] = {
    ...newFilter('peak'),
    frequency: 2300,
    q: 1.15,
    gain: 7.5,
    coefficients: { ...cache },
    provenance: 'hfd',
  };
  channel.hfdMeasurement = { ...defaultsHfdMeasurementOptions(), smoothPostBw: 0 };
  channel.coefficientCache = 'unresolved';
  return channel;
}
function measurement(channel: Channel) {
  const frequency = [1000, 2300, 5000];
  channel.measurement = {
    name: 'Synthetic unit measurement',
    sampleRate: 48000,
    impulse: [1, 0],
    frequency,
    magnitude: [0, 0, 0],
    phase: [0, 0, 0],
    hfdMagnitude: { frequency, linearMagnitude: [1, 1, 1], medianDb: 0 },
    hfdPhase: { frequency, phase: [30, 30, 30] },
  };
}

it.each(caches)(
  'uses native parametric Magnitude and dedicated Phase while retaining a saved direct vector %#',
  (cache) => {
    const c = source(cache);
    measurement(c);
    const before = structuredClone(c),
      view = buildHfdResponseView([c], { measured: true, centered: false, sum: true })!;
    // Independently evaluated polynomial from the retained native Peak root/Kz
    // design: complex H(1000) = 1.2443013779399679 + .5264636627342775i.
    expect(view.channels[0].db[0]).toBeCloseTo(2.6136991985395195, 9);
    expect(view.channels[0].phase[0]).toBeCloseTo(52.93321212711359, 9);
    expect(view.sum!.phase[0]).toBeCloseTo(52.93321212711359, 9);
    expect(c).toEqual(before);
    expect(channelResponse(c, 1000)).not.toEqual([1.2443013779399679, 0.5264636627342775]);
  },
);

it('uses the same native electrical cascade in the no-IR magnitude result and whole-channel section', () => {
  const c = source(),
    before = structuredClone(c),
    view = buildMagnitudeLayers([c], {
      measured: false,
      centered: false,
      selectedFilter: null,
      layers: { rawMeasurements: [false], currentResult: true, section: true },
      sum: true,
    });
  const i = 500;
  // The result, sum, and complete electrical cascade share one projection.
  const curves = view.curves.map((curve) => curve.db[i]);
  expect(curves[0]).toBeCloseTo(curves[1], 12);
  expect(curves[0]).toBeCloseTo(curves[2], 12);
  expect(
    Math.abs(curves[0] - 20 * Math.log10(Math.hypot(...channelResponse(c, view.frequency[i])))),
  ).toBeGreaterThan(0.1);
  expect(c).toEqual(before);
});

it('projects only native channels and leaves InputEQ cached coefficients and synthetic band analysis intact', () => {
  const preset = newProject().presets[0];
  preset.channels[0] = source();
  preset.channels[1] = source(caches[0]);
  delete preset.channels[1].hfdMeasurement;
  preset.eqEnabled = true;
  preset.inputEq[0] = {
    ...newFilter('peak'),
    gain: 12,
    coefficients: { b0: 0.5, b1: 0, b2: 0, f1: 0, f2: 0 },
  };
  const before = structuredClone(preset),
    projection = prepareNativeElectricalView(preset.channels, preset),
    [re, im] = projection.evaluate(0, 1000);
  expect(re).toBeCloseTo(1.2443013779399679 / 2, 11);
  expect(im).toBeCloseTo(0.5264636627342775 / 2, 11);
  expect(projection.evaluate(1, 1000)).toEqual(presetResponse(preset, 1, 1000));
  // Input-EQ's separate synthetic analysis channel has no native marker.
  const synthetic = { ...preset.channels[1], filters: [preset.inputEq[0]] };
  expect(prepareNativeElectricalView([synthetic]).evaluate(0, 1000)).toEqual([0.5, 0]);
  expect(preset).toEqual(before);
});

it('retains exact raw vectors, disabled bypass, Unity, trim/AddGain, delay and FIR semantics', () => {
  const c = source();
  c.filters[0].kind = 'raw';
  c.filters[1] = {
    ...newFilter('peak'),
    enabled: false,
    frequency: 1000,
    gain: 24,
    coefficients: { b0: 42, b1: 1, b2: 2, f1: 0.5, f2: 0.1 },
  };
  c.filters[2] = { ...newFilter('unity'), coefficients: { b0: 100, b1: 0, b2: 0, f1: 0, f2: 0 } };
  c.gain = -3;
  c.additionalGain = 10;
  c.invert = true;
  c.delayUs = 10;
  c.globalDelayUs = 20;
  c.fir = {
    ...c.fir,
    enabled: true,
    hfdState: { loaded: true, used: true, tapCount: 2 },
    taps: [0.5, 0.25],
  };
  const before = structuredClone(c);
  expect(prepareNativeElectricalView([c]).evaluate(0, 1000)).toEqual(channelResponse(c, 1000));
  expect(c).toEqual(before);
});

it('combines native parameter complex response with channel Gain plus AdditionalGain and phase delay', () => {
  const c = source();
  c.gain = -3;
  c.additionalGain = 10;
  c.delayUs = 250;
  const factor = 10 ** (7 / 20),
    [re, im] = prepareNativeElectricalView([c]).evaluate(0, 1000);
  // A quarter cycle delay rotates H by -90 degrees.
  expect(re).toBeCloseTo(0.5264636627342775 * factor, 11);
  expect(im).toBeCloseTo(-1.2443013779399679 * factor, 11);
});

it('ignores stored Mute only in native electrical Magnitude/Phase and keeps browser mute and raw diagnostics unchanged', () => {
  const native = source(),
    browser = source();
  native.muted = browser.muted = true;
  delete browser.hfdMeasurement;
  measurement(native);
  const before = structuredClone([native, browser]),
    view = buildHfdResponseView([native, browser], { measured: true, centered: false })!;
  expect(view.channels[0].db[0]).toBeCloseTo(2.6136991985395195, 9);
  expect(view.channels[0].phase[0]).toBeCloseTo(52.93321212711359, 9);
  expect(prepareNativeElectricalView([native, browser]).evaluate(1, 1000)).toEqual([0, 0]);
  expect(channelResponse(native, 1000)).toEqual([0, 0]);
  expect([native, browser]).toEqual(before);
});
