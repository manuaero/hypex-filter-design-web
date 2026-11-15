import { describe, expect, it } from 'vitest';
import {
  HFD_MANUAL_GAIN_BOUNDS,
  HFD_MANUAL_Q_BOUNDS,
  formatHfdManualGainValue,
  formatHfdManualQValue,
  normalizeHfdManualGainText,
  normalizeHfdManualQText,
} from '../src/domain/manual-parameter';
import { normalizeHfdManualFrequencyText } from '../src/domain/manual-frequency';

function doubleHex(value: number) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('ordinary native Q1/Q2 manual Text', () => {
  it('matches the actual native raw0.4005 commit and preserves its Double storage', () => {
    // V39 Native02_QHalf: saved q1=0.401, independently decoded Double bytes.
    const result = normalizeHfdManualQText('0.4005');
    expect(result).toEqual({ text: '0.401', value: 0.401 });
    expect(doubleHex(result.value)).toBe('448b6ce7fba9d93f');
    expect(result.value).not.toBe(Math.fround(result.value));
    // Frequency's independently accepted Single policy remains separate.
    expect(normalizeHfdManualFrequencyText('10.35').value).toBe(Math.fround(10.4));
  });

  // Native factory settings and addressed clamp/RTL path; these rows are source
  // fixtures until the corresponding fresh native GUI saved file is retained.
  it.each([
    ['0.40004', '0.400', 0.4],
    ['0.0001', '0.100', 0.1],
    ['-0.0001', '0.100', 0.1],
    ['100.0001', '20.000', 20],
    ['1.0005', '1.001', 1.001],
    ['4.005e-1', '0.401', 0.401],
    ['0,4005', '0.401', 0.401],
    ['  +0.4005  ', '0.401', 0.401],
  ])('commits raw%s as%s without a Single cast', (raw, text, value) => {
    expect(normalizeHfdManualQText(raw)).toEqual({ text, value });
  });

  it('requires the field-specific previous value for exact zero, not for negative nonzero input', () => {
    expect(normalizeHfdManualQText('0', { previousValue: 0.4 })).toEqual({
      text: '0.400',
      value: 0.4,
    });
    expect(normalizeHfdManualQText('-0e10', { previousValue: 1.3 })).toEqual({
      text: '1.300',
      value: 1.3,
    });
    expect(normalizeHfdManualQText('-0.0001', { previousValue: 1.3 }).value).toBe(0.1);
    expect(() => normalizeHfdManualQText('0')).toThrow(/previous/);
    expect(() => normalizeHfdManualQText('0', { previousValue: Infinity })).toThrow(/previous/);
  });

  it('uses supplied effective bounds with native minimum-first ordering', () => {
    expect(normalizeHfdManualQText('0.1', { min: 0.2, max: 2 }).value).toBe(0.2);
    expect(normalizeHfdManualQText('10', { min: 0.2, max: 2 }).value).toBe(2);
    expect(normalizeHfdManualQText('0.1', { min: 2, max: 1 }).value).toBe(2);
    expect(normalizeHfdManualQText('10', { min: 2, max: 1 }).value).toBe(1);
  });
});

describe('ordinary native BQ gain manual Text', () => {
  it.each([
    ['7.555', '7.56', 7.56],
    ['-7.555', '-7.56', -7.56],
    ['0', '0.00', 0],
    ['24.0001', '24.00', 24],
    ['-125.0001', '-125.00', -125],
    ['7,555', '7.56', 7.56],
    ['7555e-3', '7.56', 7.56],
  ])('models the source-derived gain raw%s ->%s as Double', (raw, text, value) => {
    expect(normalizeHfdManualGainText(raw)).toEqual({ text, value });
  });

  it('accepts zero independently of previous gain and does not change the Q zero policy', () => {
    expect(normalizeHfdManualGainText('0', { previousValue: 7.5 })).toEqual({
      text: '0.00',
      value: 0,
    });
    expect(normalizeHfdManualGainText('0', { previousValue: Infinity }).value).toBe(0);
    expect(normalizeHfdManualQText('0', { previousValue: 7.5 }).value).toBe(7.5);
    expect(normalizeHfdManualGainText('20', { min: -10, max: 12 }).value).toBe(12);
  });

  it('exposes frozen ordinary-authoring defaults, rather than reusing hardware or Input EQ limits', () => {
    expect(HFD_MANUAL_Q_BOUNDS).toEqual({ min: 0.1, max: 20 });
    expect(HFD_MANUAL_GAIN_BOUNDS).toEqual({ min: -125, max: 24 });
    expect(Object.isFrozen(HFD_MANUAL_Q_BOUNDS)).toBe(true);
    expect(Object.isFrozen(HFD_MANUAL_GAIN_BOUNDS)).toBe(true);
  });
});

describe('passive native Q/gain display is distinct from a raw-text commit', () => {
  it('renders the existing Double with fixed places and no editing-bound clamp', () => {
    expect(formatHfdManualQValue(0.4)).toBe('0.400');
    expect(formatHfdManualQValue(0.05)).toBe('0.050');
    expect(formatHfdManualQValue(200)).toBe('200.000');
    expect(formatHfdManualGainValue(-150)).toBe('-150.00');
    expect(formatHfdManualGainValue(40)).toBe('40.00');
    expect(normalizeHfdManualQText('0.05').value).toBe(0.1);
    expect(normalizeHfdManualGainText('-150').value).toBe(-125);
  });

  it('does not reinterpret an imported Double as canonical raw decimal text at halves', () => {
    expect(formatHfdManualQValue(1.0005)).toBe('1.000');
    expect(normalizeHfdManualQText('1.0005').text).toBe('1.001');
    expect(formatHfdManualGainValue(7.555)).toBe('7.55');
    expect(formatHfdManualGainValue(-7.555)).toBe('-7.55');
    expect(normalizeHfdManualGainText('7.555').text).toBe('7.56');
    expect(formatHfdManualQValue(NaN)).toBe('');
    expect(formatHfdManualGainValue(Infinity)).toBe('');
  });
});

describe('bounded shared raw-number parsing', () => {
  it.each([
    '',
    ' ',
    'NaN',
    'Infinity',
    '0x10',
    '1,2.3',
    '1\n',
    '1\0',
    '1e401',
    '1e-401',
    '1.1e-400',
    '1'.repeat(129),
  ])('refuses invalid or excessive raw Text%j for both wrappers', (text) => {
    expect(() => normalizeHfdManualQText(text)).toThrow();
    expect(() => normalizeHfdManualGainText(text)).toThrow();
  });

  it('rejects nonfinite/unbounded options instead of inventing a finite fallback', () => {
    for (const normalize of [normalizeHfdManualQText, normalizeHfdManualGainText]) {
      expect(() => normalize('1', { min: NaN })).toThrow(/bounds/);
      expect(() => normalize('1', { max: Infinity })).toThrow(/bounds/);
      expect(() => normalize('1', { max: 1e17 })).toThrow(/bounds/);
    }
  });
});
