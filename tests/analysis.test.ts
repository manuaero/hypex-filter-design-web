import { it, expect } from 'vitest';
import { fft, convolve } from '../src/domain/fft';
import {
  spectrum,
  measurementResponse,
  applyCalibration,
  decodeWav,
} from '../src/domain/measurement';
import { presetResponse, presetImpulse } from '../src/domain/dsp';
import { newProject } from '../src/domain/model';
it('round-trips complex FFT and convolves without circular wrap', () => {
  const a = Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    original = a.slice(),
    b = new Float64Array(8);
  fft(a, b);
  fft(a, b, true);
  a.forEach((x, i) => expect(x).toBeCloseTo(original[i], 12));
  expect(Array.from(convolve([1, 2, 3], [1, -1])).map((n) => +n.toFixed(8))).toEqual([1, 1, 1, -3]);
});
it('retains impulse time origin and applies windowing and time-zero phase correction', () => {
  const impulse = Array.from({ length: 2048 }, (_, i) => (i === 48 ? 1 : 0)),
    m = spectrum(impulse, 48000),
    at = measurementResponse(m, 1000);
  expect(Math.hypot(...at)).toBeCloseTo(1, 9);
  const corrected = spectrum(impulse, 48000, { start: 40, end: 80, taper: 0, timeZero: 48 });
  expect(measurementResponse(corrected, 1000)[0]).toBeCloseTo(1, 9);
  const removed = spectrum(impulse, 48000, { start: 49, end: 80, taper: 0, timeZero: 0 });
  expect(removed.magnitude?.every((n) => n === -300)).toBe(true);
});
it('interpolates dB in log frequency and takes the short phase path at the wrap', () => {
  const m = {
    name: 'test',
    sampleRate: 48000,
    frequency: [100, 10000],
    magnitude: [0, 12],
    phase: [170, -170],
  };
  const c = measurementResponse(m, 1000);
  expect(20 * Math.log10(Math.hypot(...c))).toBeCloseTo(6, 10);
  expect(Math.abs((Math.atan2(c[1], c[0]) * 180) / Math.PI)).toBeCloseTo(180, 9);
  const corrected = applyCalibration(m, { ...m, magnitude: [3, 3] });
  expect(corrected.magnitude![0]).toBeCloseTo(-3, 12);
  expect(corrected.magnitude![1]).toBeCloseTo(9, 12);
});
it('includes shared EQ and input FIR once, and excludes incompatible output FIR placement', () => {
  const p = newProject().presets[0];
  p.firPlacement = 'input';
  p.eqEnabled = true;
  p.inputEq[0] = {
    ...p.inputEq[0],
    enabled: true,
    kind: 'raw',
    coefficients: { b0: 0.5, b1: 0, b2: 0, f1: 0, f2: 0 },
  };
  p.inputFir = { name: 'input', enabled: true, taps: [0, 1] };
  p.channels[0].fir = { name: 'inactive', enabled: true, taps: [7] };
  const [r, i] = presetResponse(p, 0, 0);
  expect(r).toBeCloseTo(0.5, 12);
  expect(i).toBe(0);
  const impulse = presetImpulse(p, 0, 64);
  expect(impulse[1]).toBeCloseTo(0.5, 12);
  expect(Math.abs(impulse[0])).toBeLessThan(1e-12);
  p.firPlacement = 'output';
  expect(presetResponse(p, 0, 0)[0]).toBeCloseTo(3.5, 12);
});
it('decodes 24-bit PCM with frame/channel strides and rejects truncated WAVs', () => {
  const b = new ArrayBuffer(44 + 12),
    v = new DataView(b),
    s = (o: number, t: string) =>
      Array.from(t).forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  s(0, 'RIFF');
  v.setUint32(4, b.byteLength - 8, true);
  s(8, 'WAVE');
  s(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, 48000, true);
  v.setUint32(28, 288000, true);
  v.setUint16(32, 6, true);
  v.setUint16(34, 24, true);
  s(36, 'data');
  v.setUint32(40, 12, true);
  v.setUint8(46, 64);
  v.setUint8(52, 192);
  const m = decodeWav(b, 'test');
  expect(m.impulse).toEqual([0.5, -0.5]);
  v.setUint32(40, 999, true);
  expect(() => decodeWav(b, 'bad')).toThrow('Truncated');
});
