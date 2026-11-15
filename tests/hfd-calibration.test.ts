import { describe, expect, it } from 'vitest';
import { hfdCalibrationPhase, parseHfdCalibration } from '../src/domain/hfd-calibration';

describe('native microphone file parsing', () => {
  it('reads native initial comments, decimal commas/exponents and ignores supplied phase', () => {
    expect(
      parseHfdCalibration(
        '"Microphone response\n  * calibrated\n\'note\n\n20,5 -1,25 999\n1E3\t+2.5\t-90',
        'Mic.txt',
      ),
    ).toEqual({
      name: 'Mic.txt',
      frequency: [20.5, 1000],
      magnitude: [-1.25, 2.5],
    });
  });
  it('retains one-point files and literal duplicate/unsorted row order', () => {
    expect(parseHfdCalibration('100 3', 'One.dat').magnitude).toEqual([3]);
    expect(parseHfdCalibration('100 3\n100 5\n20 1', 'Ordered.dat').frequency).toEqual([
      100, 100, 20,
    ]);
  });
  it('rejects unsupported alphabetic headers, missing fields and non-finite values', () => {
    for (const text of [
      '',
      '* comments only',
      'Frequency dB\n20 1',
      '20',
      '20 Infinity',
      '20 1e999',
      '20,1.5',
    ])
      expect(() => parseHfdCalibration(text, 'Bad.txt')).toThrow();
  });
});

describe('native microphone magnitude-derived phase', () => {
  it('matches the analytic minimum-phase partner of a log-cosine magnitude', () => {
    const n = 64;
    const magnitude = Array.from({ length: n + 1 }, (_, i) =>
      Math.exp(0.4 * Math.cos((Math.PI * i) / n) - 0.2 * Math.cos((3 * Math.PI * i) / n)),
    );
    const before = magnitude.slice();
    const phase = hfdCalibrationPhase(magnitude);
    for (let i = 0; i <= n; i++)
      expect(phase[i]).toBeCloseTo(
        -0.4 * Math.sin((Math.PI * i) / n) + 0.2 * Math.sin((3 * Math.PI * i) / n),
        12,
      );
    expect(magnitude).toEqual(before);
    expect(phase[0]).toBeCloseTo(0, 12);
    expect(phase[n]).toBeCloseTo(0, 12);
  });

  it('has zero phase for constant magnitude, including the native zero floor', () => {
    for (const value of [0, 1e-12, -2, 0.5, 1, 100])
      expect(
        Array.from(hfdCalibrationPhase(Array(33).fill(value))).every((p) => Math.abs(p) < 1e-12),
      ).toBe(true);
  });

  it('rejects incompatible transform lengths and non-finite input', () => {
    for (const values of [[], [1], [1, 1, 1, 1], [1, NaN, 1]])
      expect(() => hfdCalibrationPhase(values)).toThrow();
  });
});
