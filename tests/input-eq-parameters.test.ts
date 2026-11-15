import { describe, expect, it } from 'vitest';
import {
  HFD_INPUT_EQ_PROFILE,
  formatHfdInputEqValue as display,
  hfdInputEqWheelNext as wheel,
  normalizeHfdInputEqText as commit,
  type HfdInputEqParameter,
  type HfdInputEqWheelState,
} from '../src/domain/input-eq-parameters';
import { normalizeHfdManualFrequencyText } from '../src/domain/manual-frequency';
import { hfdManualParameterWheelNext } from '../src/domain/parameter-wheel';

function doubleHex(value: number) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Addressed native source contracts, not a claim of actual popup GUI acceptance:
// FormShow cef728, Text normalizer cee9b0, qword setters cee96c/ceeb38/ceebdc.
describe('fixed Input EQ whole-Text commits', () => {
  it.each([
    ['frequency', '10.35', '10.4', 10.4],
    ['frequency', '400.04', '400.0', 400],
    ['frequency', '1', '10.0', 10],
    ['frequency', '50001', '50000.0', 50000],
    ['q', '0.4005', '0.401', 0.401],
    ['q', '.0001', '0.100', 0.1],
    ['q', '100.0001', '20.000', 20],
    ['gain', '7.555', '7.56', 7.56],
    ['gain', '-7.555', '-7.56', -7.56],
    ['gain', '-15.9001', '-15.90', -15.9],
    ['gain', '15.9001', '15.90', 15.9],
  ] as const)(
    '%s raw %s commits as %s without changing the input',
    (parameter, raw, text, value) => {
      expect(commit(parameter, raw)).toEqual({ text, value });
    },
  );

  it('stores frequency as Double, keeping the ordinary BQ Single policy separate', () => {
    const eq = commit('frequency', '10.35');
    expect(doubleHex(eq.value)).toBe('cdcccccccccc2440');
    expect(eq.value).not.toBe(Math.fround(eq.value));
    expect(normalizeHfdManualFrequencyText('10.35').value).toBe(10.399999618530273);
    expect(doubleHex(commit('q', '0.4005').value)).toBe('448b6ce7fba9d93f');
    expect(doubleHex(commit('gain', '7.555').value)).toBe('3d0ad7a3703d1e40');
  });

  it('shares Extended decimal parsing for comma/exponents rather than Number-first half rounding', () => {
    expect(commit('frequency', '  +1,035e1  ')).toEqual({ text: '10.4', value: 10.4 });
    expect(commit('q', '4.005e-1')).toEqual({ text: '0.401', value: 0.401 });
    expect(commit('gain', '7555e-3')).toEqual({ text: '7.56', value: 7.56 });
  });

  it('keeps the native exact-zero exception before bounds for F/Q and accepts gain zero', () => {
    expect(commit('frequency', '-0e10', { previousValue: 720 })).toEqual({
      text: '720.0',
      value: 720,
    });
    expect(commit('q', '0', { previousValue: 0.401 })).toEqual({ text: '0.401', value: 0.401 });
    expect(commit('q', '0', { previousValue: 0.01 })).toEqual({ text: '0.010', value: 0.01 });
    expect(commit('gain', '0', { previousValue: Infinity })).toEqual({ text: '0.00', value: 0 });
    expect(() => commit('frequency', '0')).toThrow(/previous/);
    expect(() => commit('q', '0', { previousValue: NaN })).toThrow(/previous/);
  });

  it('formats and reparses the previous internal frequency after zero instead of preserving its canonical precision', () => {
    const previousValue = 720.123456789;
    const result = commit('frequency', '0', { previousValue });
    expect(result).toEqual({ text: '720.1', value: 720.1 });
    expect(result.value).not.toBe(previousValue);
    expect(result.value).not.toBe(Math.fround(720.1));
    expect(previousValue).toBe(720.123456789);
  });

  it.each(['', 'NaN', 'INF', '1e401', 'x', '1'.repeat(129)])(
    'rejects malformed/nonfinite/abusive browser Text %s',
    (text) => {
      expect(() => commit('gain', text)).toThrow();
    },
  );
});

describe('Input EQ passive display and profile boundaries', () => {
  it('formats existing Doubles without bounds or canonical updates', () => {
    const values = { frequency: 106.17537689209, q: 0.0004, gain: 24.123456789 };
    expect(display('frequency', values.frequency)).toBe('106.2');
    expect(display('q', values.q)).toBe('0.000');
    expect(display('gain', values.gain)).toBe('24.12');
    expect(values).toEqual({ frequency: 106.17537689209, q: 0.0004, gain: 24.123456789 });
    expect(display('gain', Infinity)).toBe('');
    expect(display('frequency', 1e100)).toBe('');
  });

  it('exposes recursively frozen authoring defaults rather than codec or custom preference limits', () => {
    expect(HFD_INPUT_EQ_PROFILE).toEqual({
      frequency: { min: 10, max: 50000, places: 1, zeroAllowed: false, wheelStep: 'decade' },
      q: { min: 0.1, max: 20, places: 3, zeroAllowed: false, wheelStep: 0.04 },
      gain: { min: -15.9, max: 15.9, places: 2, zeroAllowed: true, wheelStep: 0.1 },
    });
    expect(Object.isFrozen(HFD_INPUT_EQ_PROFILE)).toBe(true);
    expect(Object.values(HFD_INPUT_EQ_PROFILE).every(Object.isFrozen)).toBe(true);
    for (const action of [
      () => display('unknown' as HfdInputEqParameter, 1),
      () => commit('unknown' as HfdInputEqParameter, '1'),
      () => wheel('unknown' as HfdInputEqParameter, 1, 1),
    ])
      expect(action).toThrow(/parameter/);
  });
});

describe('complete Input EQ FloatEdit wheel recurrence', () => {
  it.each([
    [99.9, 1, 100.9],
    [100, 1, 110],
    [100, -1, 99],
    [1000, 1, 1100],
    [1000, -1, 990],
    [10000, 1, 11000],
    [10000, -1, 9900],
  ] as const)(
    'uses directional decade boundaries from %s with sign %s',
    (value, direction, expected) => {
      expect(wheel('frequency', value, direction)).toMatchObject({
        text: expected.toFixed(1),
        value: expected,
        changed: true,
      });
    },
  );

  it('uses exact parsed Extended Text to select a decade instead of narrowing it to Double first', () => {
    expect(wheel('frequency', 100, 1, { displayedText: '99.9999999999999999' })).toMatchObject({
      text: '101.0',
      value: 101,
    });
    expect(wheel('frequency', 100, -1, { displayedText: '100.0000000000000001' })).toMatchObject({
      text: '90.0',
      value: 90,
    });
  });

  it('formats/reparses the frequency sum as Double instead of applying only the delta or a Single cast', () => {
    const result = wheel('frequency', 99.91, 1);
    expect(result.value).toBe(100.9);
    expect(result.value).not.toBe(99.91 + 1);
    expect(result.value).not.toBe(Math.fround(100.9));
    expect(wheel('frequency', result.value, -1, { state: result.state })).toMatchObject({
      text: '90.9',
      value: 90.9,
    });
  });

  it('retains imported model precision when clamping produces unchanged displayed Text', () => {
    const capped = wheel('frequency', 50000.04, 1);
    expect(capped).toMatchObject({ text: '50000.0', value: 50000.04, changed: false });
    expect(wheel('frequency', capped.value, -1, { state: capped.state })).toMatchObject({
      text: '49000.0',
      value: 49000,
      changed: true,
    });
    expect(wheel('frequency', 10.04, -1)).toMatchObject({
      text: '10.0',
      value: 10.04,
      changed: false,
    });
    expect(wheel('q', 0.10004, -1)).toMatchObject({
      text: '0.100',
      value: 0.10004,
      changed: false,
    });
    expect(wheel('gain', 15.90004, 1)).toMatchObject({
      text: '15.90',
      value: 15.90004,
      changed: false,
    });
  });

  it('reparses repeated Q steps and accepts gain zero without an output-channel AdditionalGain guard', () => {
    const first = wheel('q', 0.7, 1);
    expect(first).toMatchObject({ text: '0.740', value: 0.74, changed: true });
    expect(wheel('q', first.value, 1, { state: first.state })).toMatchObject({
      text: '0.780',
      value: 0.78,
    });
    expect(wheel('gain', -0.1, 1)).toMatchObject({ text: '0.00', value: 0 });
    expect(wheel('gain', 14, 1)).toMatchObject({ text: '14.10', value: 14.1 });
    expect(
      hfdManualParameterWheelNext(14, 1, { parameter: 'gain', additionalGain: 10 }),
    ).toMatchObject({ text: '14.00', value: 14.1 });
    expect(wheel('gain', 15.8, 1)).toMatchObject({ text: '15.90', value: 15.9 });
    expect(wheel('gain', -15.8, -1)).toMatchObject({ text: '-15.90', value: -15.9 });
  });

  it('keeps private state opaque and refuses field/profile/stale/copy crossover', () => {
    const eq = wheel('q', 0.7, 1);
    expect(Object.keys(eq.state)).toEqual([]);
    expect(Object.isFrozen(eq.state)).toBe(true);
    expect(() => wheel('gain', eq.value, 1, { state: eq.state })).toThrow(/state/);
    expect(() => wheel('q', 0.75, 1, { state: eq.state })).toThrow(/state/);
    expect(() => wheel('q', eq.value, 1, { state: eq.state, displayedText: '0.750' })).toThrow(
      /state/,
    );
    expect(() =>
      wheel('q', eq.value, 1, { state: { ...eq.state } as HfdInputEqWheelState }),
    ).toThrow(/state/);
    const ordinary = hfdManualParameterWheelNext(0.7, 1, { parameter: 'q' });
    expect(() => wheel('q', ordinary.value, 1, { state: ordinary.state })).toThrow(/state/);
    expect(() =>
      hfdManualParameterWheelNext(eq.value, 1, { parameter: 'q', state: eq.state }),
    ).toThrow(/state/);
  });

  it('rejects zero/magnitude direction, nonfinite model and malformed dirty Text rather than fabricating a value', () => {
    for (const direction of [0, 120, -360, NaN])
      expect(() => wheel('q', 0.7, direction as -1 | 1)).toThrow(/direction/);
    for (const value of [NaN, Infinity, -Infinity]) expect(() => wheel('gain', value, 1)).toThrow();
    for (const text of ['', 'NaN', 'INF', 'bad', '1e401'])
      expect(() => wheel('frequency', 1000, 1, { displayedText: text })).toThrow();
  });
});
