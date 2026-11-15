import { convolve } from './fft';
import { measurementResponse } from './measurement';
import { designHfd } from './hfd-math';
import { firIsEffective, presetFirPlacement, effectiveFirTaps } from './fir-state';
import { FS, unity, type Coefficients, type Filter, type Channel, type Preset } from './model';

export const FILTER_NAMES: Record<Filter['kind'], string> = {
  unity: 'Unity / bypass',
  lowpass1: 'Low-pass · 1st order',
  lowpass2: 'Low-pass · 2nd order',
  highpass1: 'High-pass · 1st order',
  highpass2: 'High-pass · 2nd order',
  peak: 'Parametric EQ',
  lowshelf1: 'Low shelf · 1st order',
  highshelf1: 'High shelf · 1st order',
  lowshelf2: 'Low shelf · 2nd order',
  highshelf2: 'High shelf · 2nd order',
  asymmetric: 'Asymmetric shelf',
  allpass1: 'All-pass · 1st order',
  allpass2: 'All-pass · 2nd order',
  raw: 'Free coefficients',
};
export function finite(value: number, label: string) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}
export function roundEven(x: number): number {
  finite(x, 'Value');
  const floor = Math.floor(x),
    r = x - floor;
  return r === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(x);
}
export function q24(x: number): number {
  const n = roundEven(x * 2 ** 24);
  if (n < -(2 ** 31) || n > 2 ** 31 - 1) throw new Error('Coefficient exceeds Q8.24 range');
  return n;
}
export function stable(c: Coefficients) {
  return (
    [c.b0, c.b1, c.b2, c.f1, c.f2].every(Number.isFinite) &&
    Math.abs(c.f2) < 1 &&
    1 - c.f1 - c.f2 > 0 &&
    1 + c.f1 - c.f2 > 0
  );
}
export function design(f: Filter): Coefficients {
  if (!f.enabled || f.kind === 'unity') return unity();
  if (f.coefficients) return { ...f.coefficients };
  return designHfd(f);
}
export function effectiveSections(channel: Channel): Coefficients[] {
  if (channel.coefficientCache === 'unresolved')
    throw new Error('Resolve imported channel gain interpretation before compiling');
  if (channel.filters.length !== 15) throw new Error('FA503 requires 15 biquad slots per channel');
  if (channel.gain < -96 || channel.gain > 18) throw new Error('Channel gain outside −96…18 dB');
  const sections = channel.filters.map(design),
    gain = 10 ** ((channel.gain + (channel.additionalGain ?? 0)) / 20) * (channel.invert ? -1 : 1);
  const first = sections[0];
  first.b0 *= gain;
  first.b1 *= gain;
  first.b2 *= gain;
  for (const c of sections) {
    if (!stable(c)) throw new Error('Unstable or non-finite biquad');
    const quant = {
      b0: q24(c.b0) / 2 ** 24,
      b1: q24(c.b1) / 2 ** 24,
      b2: q24(c.b2) / 2 ** 24,
      f1: q24(c.f1) / 2 ** 24,
      f2: q24(c.f2) / 2 ** 24,
    };
    if (!stable(quant)) throw new Error('Biquad becomes unstable after Q8.24 quantization');
  }
  return sections;
}
export function encodeChannel(channel: Channel): Uint8Array {
  const bytes = new Uint8Array(512).fill(255),
    v = new DataView(bytes.buffer);
  const us = finite(channel.delayUs, 'Delay');
  if (us < 0 || us > 32000) throw new Error('FA503 output delay must be 0–32,000 microseconds');
  v.setUint32(0, roundEven((us * FS) / 1e6), true);
  effectiveSections(channel).forEach((c, i) =>
    [c.b2, c.b1, c.b0, c.f2, c.f1].forEach((x, j) => v.setInt32(4 + i * 20 + j * 4, q24(x), true)),
  );
  return bytes;
}
export function compileSector(preset: Preset, original: Uint8Array): Uint8Array {
  if (original.length !== 4096 || preset.channels.length !== 3)
    throw new Error('Expected a complete 4 KiB backup and three channels');
  const result = original.slice();
  preset.channels.forEach((c, i) => result.set(encodeChannel(c), i * 512));
  return result;
}
export function response(c: Coefficients, frequency: number): [number, number] {
  const w = (2 * Math.PI * frequency) / FS,
    cr = Math.cos(w),
    ci = -Math.sin(w),
    c2 = Math.cos(2 * w),
    s2 = -Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cr + c.b2 * c2,
    ni = c.b1 * ci + c.b2 * s2,
    dr = 1 - c.f1 * cr - c.f2 * c2,
    di = -c.f1 * ci - c.f2 * s2,
    d = dr * dr + di * di;
  return [(nr * dr + ni * di) / d, (ni * dr - nr * di) / d];
}
export function channelResponse(
  channel: Channel,
  frequency: number,
  includeMeasurement = false,
): [number, number] {
  let re =
      10 ** ((channel.gain + (channel.additionalGain ?? 0)) / 20) *
      (channel.invert ? -1 : 1) *
      (channel.muted ? 0 : 1),
    im = 0;
  for (const f of channel.filters) {
    const [a, b] = response(design(f), frequency);
    [re, im] = [re * a - im * b, re * b + im * a];
  }
  const w = (-2 * Math.PI * frequency * (channel.delayUs + channel.globalDelayUs)) / 1e6;
  [re, im] = [re * Math.cos(w) - im * Math.sin(w), re * Math.sin(w) + im * Math.cos(w)];
  if (firIsEffective(channel.fir)) {
    let a = 0,
      b = 0;
    channel.fir.taps.forEach((tap, i) => {
      const p = (-2 * Math.PI * frequency * i) / FS;
      a += tap * Math.cos(p);
      b += tap * Math.sin(p);
    });
    [re, im] = [re * a - im * b, re * b + im * a];
  }
  if (includeMeasurement && channel.measurement) {
    const [a, b] = measurementResponse(channel.measurement, frequency);
    [re, im] = [re * a - im * b, re * b + im * a];
  }
  return [re, im];
}
export function impulseResponse(channel: Channel, length = 2048): Float64Array {
  if (channel.muted) return new Float64Array(length);
  const data = new Float64Array(length),
    sections = effectiveSections(channel),
    states = sections.map(() => [0, 0, 0, 0]);
  for (let n = 0; n < length; n++) {
    let x = n === 0 ? 1 : 0;
    sections.forEach((c, i) => {
      const s = states[i],
        y = c.b0 * x + c.b1 * s[0] + c.b2 * s[1] + c.f1 * s[2] + c.f2 * s[3];
      s[1] = s[0];
      s[0] = x;
      s[3] = s[2];
      s[2] = y;
      x = y;
    });
    data[n] = x;
  }
  if (firIsEffective(channel.fir)) {
    const filtered = convolve(data, channel.fir.taps, length);
    data.set(filtered);
  }
  const delay = roundEven(((channel.delayUs + channel.globalDelayUs) * FS) / 1e6);
  return Float64Array.from(data, (_, i) => (i >= delay ? data[i - delay] : 0));
}

export function firResponse(taps: number[], frequency: number): [number, number] {
  let re = 0,
    im = 0;
  for (let i = 0; i < taps.length; i++) {
    const phase = (-2 * Math.PI * frequency * i) / FS;
    re += taps[i] * Math.cos(phase);
    im += taps[i] * Math.sin(phase);
  }
  return [re, im];
}
export function presetResponse(
  preset: Preset,
  index: number,
  frequency: number,
  measured = false,
): [number, number] {
  const placement = presetFirPlacement(preset),
    c = preset.channels[index];
  let [re, im] = channelResponse(
    { ...c, fir: { ...c.fir, enabled: firIsEffective(c.fir, placement === 'output') } },
    frequency,
    measured,
  );
  const apply = ([a, b]: [number, number]) => {
    [re, im] = [re * a - im * b, re * b + im * a];
  };
  if (preset.eqEnabled) for (const f of preset.inputEq) apply(response(design(f), frequency));
  if (firIsEffective(preset.inputFir, placement === 'input'))
    apply(firResponse(preset.inputFir.taps, frequency));
  return [re, im];
}
export function presetImpulse(preset: Preset, index: number, length = 8192): Float64Array {
  const c = preset.channels[index],
    taps = effectiveFirTaps(c, preset);
  let impulse = impulseResponse({ ...c, fir: { ...c.fir, enabled: false } }, length);
  if (preset.eqEnabled) {
    for (const f of preset.inputEq) {
      const b = design(f);
      let x1 = 0,
        x2 = 0,
        y1 = 0,
        y2 = 0;
      impulse = Float64Array.from(impulse, (x) => {
        const y = b.b0 * x + b.b1 * x1 + b.b2 * x2 + b.f1 * y1 + b.f2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        return y;
      });
    }
  }
  if (taps) impulse = convolve(impulse, taps, length);
  return impulse;
}
