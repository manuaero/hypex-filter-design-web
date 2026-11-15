import { beforeAll, expect, it } from 'vitest';
import {
  prepareHfdAudio,
  deconvolveHfdAudio,
  HFD_SWEEP_SAMPLES,
  HFD_RECORD_SAMPLES,
  type HfdPreparedAudio,
} from '../src/domain/hfd-audio';

const prepared = new Map<number, HfdPreparedAudio>();
beforeAll(() => {
  for (const rate of [44100, 48000, 96000]) prepared.set(rate, prepareHfdAudio(rate));
});
function near(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThan(1e-5 + Math.abs(expected) * 2e-9);
}

// Independently transcribed Python math waveform + NumPy complex FFT/Hilbert/
// irfft fixtures; not recorded native GUI/audio results. Forward Nyquist is
// deliberately zero; no unit-peak scaling. Native addresses are in audio docs.
it.each([
  [44100, 0.9814515998753675, 0.5556765097571834, 8.603168490813748e-6],
  [48000, 0.220329625572171, -0.9790729081758094, -2.006976693709253e-6],
  [96000, -0.8148598592298375, 0.0901395736243728, -8.366485133916533e-6],
])('recovers native waveform/taper/buffer boundaries at Fs %s', (rate, attack, middle, last) => {
  const p = prepared.get(rate)!;
  expect(HFD_SWEEP_SAMPLES).toBe(65536);
  expect(HFD_RECORD_SAMPLES).toBe(131072);
  expect(p.stimulus).toHaveLength(131072);
  expect(p.output).toBeInstanceOf(Float64Array);
  expect(p.output).not.toBe(p.stimulus);
  // A negative initial cosine can preserve IEEE negative zero through taper.
  expect(p.stimulus[0] === 0).toBe(true);
  expect(p.stimulus[8192]).toBeCloseTo(attack, 10);
  expect(p.stimulus[32768]).toBeCloseTo(middle, 9);
  expect(p.stimulus[65535]).toBeCloseTo(last, 12);
  expect(p.stimulus.subarray(65536).every((sample) => sample === 0)).toBe(true);
  expect(p.output).toEqual(p.stimulus);
});

it.each([
  [44100, 1, 5.387094697524676, -108.38559677322115],
  [44100, 32768, -320826.497502626, -931356.4264646933],
  [48000, 1, -582.4912840888163, -270.54564758551686],
  [48000, 1000, -180086.45171484878, 47880.666084646335],
  [48000, 65535, 8475.338571138527, 18103.07013061073],
  [96000, 10, -4997.015056721238, -14268.898923467523],
  [96000, 32768, 896931.7932485485, 1842767.2940909176],
])(
  'matches independent minimum-phase inverse bin at Fs %s, bin %s',
  (rate, bin, real, imaginary) => {
    const kernel = prepared.get(rate)!.kernel;
    near(kernel.real[bin], real);
    near(kernel.imaginary[bin], imaginary);
    expect(kernel.real[65536]).toBe(0);
    expect(kernel.imaginary[65536]).toBe(0);
  },
);

it('retains the native nonunit point-spread scale and first-half crop in a mathematical loopback', () => {
  const p = prepared.get(48000)!,
    impulse = deconvolveHfdAudio(p, p.output);
  expect(impulse).toHaveLength(65536);
  for (const [index, value] of [
    [0, 81304164.69541022],
    [1, 24326624.20650067],
    [2, -21207854.871726744],
    [16, 2912535.3404857353],
    [128, -291817.66294113256],
    [1024, 26737.778955905393],
    [65535, 0.0990127682382408],
  ])
    near(impulse[index], value);
  expect(impulse[0]).toBeGreaterThan(8e7);
  expect(impulse.every((value) => Math.abs(value) <= impulse[0])).toBe(true);
});

it('preserves delayed/negative multi-tap transfers instead of peak-aligning or normalizing', () => {
  const p = prepared.get(48000)!,
    reference = deconvolveHfdAudio(p, p.output),
    recording = new Float64Array(131072);
  for (let i = 0; i < 65536; i++) {
    recording[i + 17] += p.output[i] * -0.7;
    recording[i + 93] += p.output[i] * 0.2;
  }
  const impulse = deconvolveHfdAudio(p, recording);
  for (const i of [93, 94, 100, 128, 512, 4096, 65535])
    near(impulse[i], -0.7 * reference[i - 17] + 0.2 * reference[i - 93]);
  let peak = 0;
  for (let i = 1; i < impulse.length; i++)
    if (Math.abs(impulse[i]) > Math.abs(impulse[peak])) peak = i;
  expect(peak).toBe(17);
  expect(impulse[peak]).toBeLessThan(0);
});

it('cancels requested playback gain once while retaining physical path gain and source arrays', () => {
  const p = prepareHfdAudio(48000, 20 * Math.log10(2)),
    recording = Float64Array.from(p.output, (sample) => sample * 0.25),
    before = recording.slice(),
    kernelBefore = p.kernel.real.slice(),
    impulse = deconvolveHfdAudio(p, recording),
    reference = deconvolveHfdAudio(prepared.get(48000)!, prepared.get(48000)!.output);
  expect(p.gain).toBeCloseTo(2, 14);
  for (const i of [0, 1, 17, 128, 4096]) near(impulse[i], reference[i] * 0.25);
  expect(recording).toEqual(before);
  expect(p.kernel.real).toEqual(kernelBefore);
  expect(impulse.buffer).not.toBe(recording.buffer);
  const large = prepareHfdAudio(48000, 1000);
  expect(large.gain).toBe(1e50);
  expect(large.output.some((sample) => Math.abs(sample) > 1e40)).toBe(true);
});

it('omits forward Nyquist without doubling DC, using the native Hermitian inverse', () => {
  const p = prepared.get(48000)!,
    nyquist = Float64Array.from({ length: 131072 }, (_, i) => (i % 2 ? -1 : 1));
  expect(deconvolveHfdAudio(p, nyquist).every((sample) => sample === 0)).toBe(true);
  const dc = deconvolveHfdAudio(p, new Float64Array(131072).fill(1));
  for (const i of [0, 1, 100, 65535]) near(dc[i], -636.4279835940106);
});

it('rejects invalid rates/gains, incomplete recordings and non-finite data without inventing a gain policy', () => {
  for (const rate of [NaN, Infinity, -1, 0, 12])
    expect(() => prepareHfdAudio(rate)).toThrow('sample rate');
  for (const gain of [NaN, Infinity, -Infinity, 10000, -10000])
    expect(() => prepareHfdAudio(48000, gain)).toThrow('gain');
  const p = prepared.get(48000)!;
  for (const length of [0, 65536, 131071, 131073])
    expect(() => deconvolveHfdAudio(p, new Float64Array(length))).toThrow('exactly 131072');
  const recording = new Float64Array(131072);
  for (const value of [NaN, Infinity, -Infinity]) {
    recording[131071] = value;
    expect(() => deconvolveHfdAudio(p, recording)).toThrow('non-finite');
  }
  expect(() => deconvolveHfdAudio({ ...p, gain: 0 }, p.output)).toThrow('inconsistent');
  expect(() =>
    deconvolveHfdAudio(
      { ...p, kernel: { real: new Float64Array(1), imaginary: new Float64Array(1) } },
      p.output,
    ),
  ).toThrow('kernel length');
  const real = p.kernel.real.slice();
  real[5] = NaN;
  expect(() => deconvolveHfdAudio({ ...p, kernel: { ...p.kernel, real } }, p.output)).toThrow(
    'kernel contains',
  );
});
