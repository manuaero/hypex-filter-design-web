import { describe, expect, it } from 'vitest';
import {
  buildHfdCalibration,
  DEFAULT_HFD_MIC_SMOOTHING,
  hfdCalibrationSample,
  hfdSmoothCalibration,
  parseHfdCalibration,
  type HfdCalibrationCurve,
} from '../src/domain/hfd-calibration';

// Source-only fixtures from HFD 5.2.4.24 static code; these are not hardware or
// native GUI observations. See HFD-CALIBRATION-SEMANTICS.md for addresses.
// Numeric kernel values were computed independently with Python math. The
// builder phase values use the closed-form circular Hilbert cotangent kernel
// for a constant log-amplitude prefix, rather than the application's FFT.
const L = 65536;
const M = 1024;
const grid = (sampleRate = 48000) =>
  Float64Array.from({ length: L + 1 }, (_, i) => (i === 0 ? 0.01 : (i * sampleRate) / L));
const steps: HfdCalibrationCurve = {
  name: 'Source-only crossed-point fixture',
  frequency: [1, 2, 3, 100],
  magnitude: [0, 20 * Math.log10(2), 20 * Math.log10(4), 20 * Math.log10(8)],
};
const expectValuesClose = (actual: ArrayLike<number>, expected: number[]) => {
  expect(actual.length).toBe(expected.length);
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 13));
};

describe('source-only native microphone sampler boundaries', () => {
  it('loads the first crossed point and skips later points crossed by the same target', () => {
    const before = structuredClone(steps);
    const target = [0.01, 10, 20, 30, 100, 1000];
    // A conventional previous-value sampler would produce 4 at10/20/30.
    expectValuesClose(hfdCalibrationSample(steps, target), [1, 1, 1, 1, 8, 8]);
    expectValuesClose(hfdCalibrationSample(steps, [1.5, 2, 3, 4]), [1, 2, 4, 4]);
    expect(steps).toEqual(before);
  });

  it('retains the first point at the left endpoint and preserves duplicate/unsorted file order', () => {
    const curve = {
      ...steps,
      frequency: [100, 100, 20, 200],
    };
    // Initial left extension includes equality at100. At101 the native scan
    // loads row0 once, then advances over all three crossed rows.
    expectValuesClose(
      hfdCalibrationSample(curve, [0.01, 100, 101, 199, 200, 201]),
      [1, 1, 1, 1, 8, 8],
    );
  });

  it('keeps display sampling in dB rather than converting its values to amplitude', () => {
    expect(Array.from(hfdCalibrationSample(steps, [0.01, 2, 3, 100], false))).toEqual([
      0,
      0,
      20 * Math.log10(4),
      20 * Math.log10(8),
    ]);
  });

  it('rejects a non-whitespace delimiter included by the native numeric substring copy', () => {
    // a8cb47/a8cc3e include the first nonnumeric delimiter before Trim.
    for (const text of ['20;1', '20 1junk', '20 1#tail'])
      expect(() => parseHfdCalibration(text, 'Source-only invalid delimiter.txt')).toThrow();
    expect(parseHfdCalibration('20\t1\t-90', 'Third phase ignored.txt').magnitude).toEqual([1]);
  });
});

describe('source-only native correction Gaussian dimensions', () => {
  it('matches the independently calculated .015 kernel, inclusive radius and lost tail weight', () => {
    expect(DEFAULT_HFD_MIC_SMOOTHING).toBe(0.015);
    const input = new Float64Array(L + 1);
    input[512] = 1;
    const output = hfdSmoothCalibration(input, grid(), 0.015, L, M);
    expect(output[512]).toBeCloseTo(0.010605070363402748, 14); // K0
    expect(output[513]).toBeCloseTo(0.010601323966256066, 14); // K1
    expect(output[612]).toBeCloseTo(0.00030976570989054976, 14); // K100
    expect(output[690]).toBeCloseTo(1.4576942693314927e-7, 17); // K178, included
    expect(output[691]).toBe(0); // R179 is excluded
    expect(input[512]).toBe(1);
    expect(input[513]).toBe(0);

    const constant = hfdSmoothCalibration(new Float64Array(L + 1).fill(1), grid(), 0.015, L, M);
    expect(constant[512]).toBeCloseTo(0.9999979169928167, 13);
    expect(constant[512]).toBeLessThan(1); // No finite-radius renormalization.
    expect(constant[1024]).toBe(1); // Unprocessed source tail remains exact.
  });

  it('reads beyond the output prefix and leaves that source tail unprocessed', () => {
    const input = new Float64Array(L + 1);
    input[1024] = 1;
    const output = hfdSmoothCalibration(input, grid(), 0.015, L, M);
    // The right boundary is the full65537-element source, not prefix1024.
    expect(output[1023]).toBeCloseTo(0.010601323966256066, 14);
    expect(output[846]).toBeCloseTo(1.4576942693314927e-7, 17);
    expect(output[845]).toBe(0);
    expect(output[1024]).toBe(1);
    expect(output[1025]).toBe(0);
    expect(input[1023]).toBe(0);
    expect(input[1024]).toBe(1);
  });

  it('extends the source endpoint while retaining the globally normalized truncated kernel', () => {
    const input = new Float64Array(L + 1);
    input[0] = 1;
    const output = hfdSmoothCalibration(input, grid(), 0.015, L, M);
    expect(output[0]).toBeCloseTo(0.5053014936781097, 13);
    expect(output[1]).toBeCloseTo(0.494696423314707, 13);
    expect(output[0] - output[1]).toBeCloseTo(0.010605070363402748, 14);
  });
});

describe('source-only full-capacity native correction resources', () => {
  it.each([
    {
      sampleRate: 48000,
      weight: 0.9999979169928167,
      phase512: 7.282930867047364e-7,
      phase1023: 5.89683715563925e-6,
      phase1024: 5.8974844544718325e-6,
      phase2048: 7.278938554088441e-7,
      phase32768: 3.256009973205987e-8,
    },
    {
      sampleRate: 96000,
      weight: 0.9999978283834278,
      phase512: 7.59274101061772e-7,
      phase1023: 6.147683964314267e-6,
      phase1024: 6.1483587987294225e-6,
      phase2048: 7.588578867809584e-7,
      phase32768: 3.3945180732663166e-8,
    },
  ])(
    'retains the full-Fs grid, prefix smoothing and derived radians at $sampleRate Hz',
    (fixture) => {
      const curve: HfdCalibrationCurve = {
        name: 'Source-only flat microphone',
        frequency: [20, 20000],
        magnitude: [0, 0],
      };
      const before = structuredClone(curve);
      const response = buildHfdCalibration(curve, fixture.sampleRate);
      expect(response.frequency.length).toBe(L + 1);
      expect(response.magnitude.length).toBe(L + 1);
      expect(response.phase.length).toBe(L + 1);
      expect(response.frequency[0]).toBe(0.01);
      expect(response.frequency[1]).toBe(fixture.sampleRate / L);
      expect(response.frequency[L / 2]).toBe(fixture.sampleRate / 2);
      expect(response.frequency[L]).toBe(fixture.sampleRate);
      expect(response.magnitude[0]).toBeCloseTo(fixture.weight, 13);
      expect(response.magnitude[1023]).toBeCloseTo(fixture.weight, 13);
      expect(response.magnitude[1024]).toBe(1);
      expect(response.magnitude[L]).toBe(1);
      // A full-array smoother or truncated-kernel renormalizer would remove
      // the prefix step and incorrectly yield zero phase for this resource.
      expect(response.phase[512]).toBeCloseTo(fixture.phase512, 12);
      expect(response.phase[1023]).toBeCloseTo(fixture.phase1023, 12);
      expect(response.phase[1024]).toBeCloseTo(fixture.phase1024, 12);
      expect(response.phase[2048]).toBeCloseTo(fixture.phase2048, 12);
      expect(response.phase[L / 2]).toBeCloseTo(fixture.phase32768, 12);
      expect(response.phase[0]).toBeCloseTo(0, 12);
      expect(response.phase[L]).toBeCloseTo(0, 12);
      expect(curve).toEqual(before);
    },
  );
});
