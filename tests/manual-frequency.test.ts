import { describe, expect, it } from 'vitest';
import { normalizeHfdManualFrequencyText } from '../src/domain/manual-frequency';
import { formatHfdAdvancedFrequency } from '../src/domain/frequency-wheel';

const singleHex = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setFloat32(0, value, true);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

describe('native ordinary F1/F2 whole-value manual commits', () => {
  // Root-owned V38 native AsymLow saved files: F1800/Q.7, F2 edited,
  // Q2=1.3. These text/value/Single byte oracles do not come from this helper.
  it.each([
    ['1', '10.0', 10, '00002041'],
    ['10.35', '10.4', 10.399999618530273, '66662641'],
    ['400.04', '400.0', 400, '0000c843'],
    ['50001', '50000.0', 50000, '00504347'],
  ])('matches native completed Text%s ->%s and exact Single', (raw, text, value, hex) => {
    const result = normalizeHfdManualFrequencyText(raw);
    expect(result).toEqual({ text, value });
    expect(singleHex(result.value)).toBe(hex);
  });

  it('keeps raw decimal precision separate from existing Double display formatting', () => {
    // Binary64 10.35 lies below the decimal half. Native Text first parses
    // Extended, and its18-digit conversion restores the decimal10.35.
    expect(formatHfdAdvancedFrequency(10.35)).toBe('10.3');
    expect(normalizeHfdManualFrequencyText('10.35').text).toBe('10.4');
    expect(normalizeHfdManualFrequencyText('1000.05')).toEqual({
      text: '1000.1',
      value: 1000.0999755859375,
    });
    expect(formatHfdAdvancedFrequency(1000.05)).toBe('1000.0');
    // An MCP manual-edit adapter deliberately supplies canonical decimal Text.
    expect(normalizeHfdManualFrequencyText(String(10.35)).value).toBe(10.399999618530273);
  });

  it.each(['10,35', '  +10.35  ', '1.035e1', '1035E-2', '.1035e2', '10.350'])(
    'accepts bounded ordinary decimal/comma/exponent Text%s',
    (text) =>
      expect(normalizeHfdManualFrequencyText(text)).toEqual({
        text: '10.4',
        value: 10.399999618530273,
      }),
  );

  it('retains Extended parsing through the18-digit formatting stage near a half boundary', () => {
    // Independent Fraction/x8764 parse/scale/BCD fixtures. Both lie within
    // native's18-digit decimal buffer rounding to10.35; Number-first loses it.
    for (const text of ['10.3499999999999999999', '10.3500000000000000001'])
      expect(normalizeHfdManualFrequencyText(text).text).toBe('10.4');
    expect(normalizeHfdManualFrequencyText('10.349999999999').text).toBe('10.3');
    expect(normalizeHfdManualFrequencyText('10.25').text).toBe('10.3');
  });

  it('clamps only this explicit commit, with minimum-first native precedence', () => {
    expect(normalizeHfdManualFrequencyText('-500')).toEqual({ text: '10.0', value: 10 });
    expect(normalizeHfdManualFrequencyText('1e-400').value).toBe(10);
    expect(normalizeHfdManualFrequencyText('1e400').value).toBe(50000);
    expect(normalizeHfdManualFrequencyText('15', { min: 20, max: 50 }).value).toBe(20);
    expect(normalizeHfdManualFrequencyText('100', { min: 20, max: 50 }).value).toBe(50);
    expect(normalizeHfdManualFrequencyText('1', { min: 1 }).value).toBe(10);
    expect(normalizeHfdManualFrequencyText('1', { min: 0 }).value).toBe(10);
    expect(normalizeHfdManualFrequencyText('1', { min: -10 }).value).toBe(10);
    // Native independent axis setters allow Maximum<Minimum.
    expect(normalizeHfdManualFrequencyText('1', { min: 10, max: 5 }).value).toBe(10);
    expect(normalizeHfdManualFrequencyText('20', { min: 10, max: 5 }).value).toBe(5);
  });

  it('models the source-derived exact-zero setter exception using the supplied prior Value', () => {
    expect(normalizeHfdManualFrequencyText('0', { previousValue: 400 })).toEqual({
      text: '400.0',
      value: 400,
    });
    expect(normalizeHfdManualFrequencyText('-0e10', { previousValue: 106.17537689209 })).toEqual({
      text: '106.2',
      value: 106.19999694824219,
    });
    expect(() => normalizeHfdManualFrequencyText('0')).toThrow(/previous/);
  });

  it.each([
    '',
    ' ',
    'NaN',
    'Infinity',
    '-Infinity',
    '0x20',
    '10.3.5',
    '10,3.5',
    '1e',
    '--10',
    '10 Hz',
    '10\n',
    '10\0',
    '١٠',
    '1e401',
    '1e-401',
    '1.1e-400',
    '1e999999999999999999999',
    '1'.repeat(129),
  ])('rejects malformed or resource-unbounded Text%j before producing an edit', (text) =>
    expect(() => normalizeHfdManualFrequencyText(text)).toThrow(),
  );

  it('rejects invalid bounds and missing/nonfinite prior state without falling back to zero', () => {
    for (const options of [
      { min: NaN },
      { min: Infinity },
      { min: 50001 },
      { max: Infinity },
      { max: 50001 },
      { max: 0 },
    ])
      expect(() => normalizeHfdManualFrequencyText('400', options)).toThrow(/bounds/);
    expect(() => normalizeHfdManualFrequencyText('0', { previousValue: Infinity })).toThrow(
      /previous/,
    );
    expect(() => normalizeHfdManualFrequencyText(undefined as unknown as string)).toThrow();
  });
});
