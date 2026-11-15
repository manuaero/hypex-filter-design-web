import { describe, expect, it } from 'vitest';
import { firFrequencyGrid } from '../src/domain/chirp-z';

function direct(taps: ArrayLike<number>, k: number, step: number) {
  let real = 0;
  let imaginary = 0;
  for (let n = 0; n < taps.length; n++) {
    const angle = step * k * n;
    real += taps[n] * Math.cos(angle);
    imaginary -= taps[n] * Math.sin(angle);
  }
  return { real, imaginary };
}

function randomTaps(length: number) {
  let seed = 0x12345678;
  return Float64Array.from({ length }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 31 - 1;
  });
}

describe('firFrequencyGrid', () => {
  it('matches independent direct DTFTs on arbitrary linear grids', () => {
    for (const length of [1, 2, 17, 99]) {
      const taps = randomTaps(length);
      const original = taps.slice();
      for (const step of [0.000073, 0.1437, Math.PI / 8, 7.3]) {
        for (const count of [1, 7, 137]) {
          const result = firFrequencyGrid(taps, count, step);
          for (let k = 0; k < count; k++) {
            const expected = direct(taps, k, step);
            expect(result.real[k]).toBeCloseTo(expected.real, 8);
            expect(result.imaginary[k]).toBeCloseTo(expected.imaginary, 8);
          }
        }
      }
      expect(taps).toEqual(original);
    }
  });

  it('preserves amplitude, delay, and both polarities for sparse impulses', () => {
    const taps = new Float64Array(4500);
    taps[0] = 0.25;
    taps[123] = -0.75;
    taps[4499] = 1.5;
    const step = (2 * Math.PI * 48000) / (65536 * 93750);
    const result = firFrequencyGrid(taps, 32769, step);
    for (const k of [0, 1, 32, 8191, 16384, 30000, 32768]) {
      const expected = direct(taps, k, step);
      expect(result.real[k]).toBeCloseTo(expected.real, 8);
      expect(result.imaginary[k]).toBeCloseTo(expected.imaginary, 8);
    }
    expect(result.real[0]).toBeCloseTo(1, 10);
    expect(result.imaginary[0]).toBeCloseTo(0, 10);
  });

  it('matches DC and Nyquist including negative taps', () => {
    const taps = [1, -2, 3, -4, 0.5];
    const result = firFrequencyGrid(taps, 3, Math.PI);
    expect(result.real[0]).toBeCloseTo(-1.5, 12);
    expect(result.real[1]).toBeCloseTo(10.5, 12);
    expect(result.real[2]).toBeCloseTo(-1.5, 12);
    for (const value of result.imaginary) expect(value).toBeCloseTo(0, 12);
  });

  it('handles a full 4500-tap / 32769-bin physical-sample-rate grid', () => {
    const taps = randomTaps(4500);
    const step = (2 * Math.PI * 44100) / (65536 * 93750);
    const result = firFrequencyGrid(taps, 32769, step);
    expect(result.real).toHaveLength(32769);
    expect(result.imaginary).toHaveLength(32769);
    for (const k of [0, 1, 19, 1024, 8192, 16383, 24576, 32768]) {
      const expected = direct(taps, k, step);
      expect(result.real[k]).toBeCloseTo(expected.real, 7);
      expect(result.imaginary[k]).toBeCloseTo(expected.imaginary, 7);
    }
  });

  it('allows zero step and empty inputs without fabricating a normalized response', () => {
    expect(firFrequencyGrid([1, -0.25], 3, 0)).toEqual({
      real: new Float64Array([0.75, 0.75, 0.75]),
      imaginary: new Float64Array(3),
    });
    expect(firFrequencyGrid([], 4, 0.1).real).toEqual(new Float64Array(4));
    expect(firFrequencyGrid([1], 0, 0.1).real).toHaveLength(0);
  });

  it('rejects invalid, unreadable, and excessively large inputs before allocation', () => {
    for (const count of [-1, 0.5, NaN, Infinity, 2 ** 20 + 1])
      expect(() => firFrequencyGrid([1], count, 0.1)).toThrow(RangeError);
    for (const step of [-1, NaN, Infinity])
      expect(() => firFrequencyGrid([1], 1, step)).toThrow(RangeError);
    for (const taps of [[NaN], [Infinity], { length: 1 }, { length: 4501 }, { length: -1 }])
      expect(() => firFrequencyGrid(taps as ArrayLike<number>, 1, 0.1)).toThrow(RangeError);
  });
});
