import { describe, expect, it } from 'vitest';
import {
  hfdEqFrequencyWheelDelta,
  hfdAdvancedFrequencyWheelDelta,
  hfdAdvancedFrequencyWheelNext,
  formatHfdAdvancedFrequency,
  type FrequencyWheelDirection,
} from '../src/domain/frequency-wheel';

describe('native input EQ frequency wheel threshold fixtures', () => {
  it.each([
    [10, 1, 1],
    [10, -1, -1],
    [99.9, 1, 1],
    [100, 1, 10],
    [100.1, 1, 10],
    [99.9, -1, -1],
    [100, -1, -1],
    [100.1, -1, -10],
    [999.9, 1, 10],
    [1000, 1, 100],
    [1000.1, 1, 100],
    [999.9, -1, -10],
    [1000, -1, -10],
    [1000.1, -1, -100],
    [9999.9, 1, 100],
    [10000, 1, 1000],
    [10000.1, 1, 1000],
    [9999.9, -1, -100],
    [10000, -1, -100],
    [10000.1, -1, -1000],
    [12000, 1, 1000],
    [12000, -1, -1000],
  ])('at %sHz, direction %s produces signed delta %sHz', (frequency, direction, delta) => {
    expect(hfdEqFrequencyWheelDelta(frequency, direction as FrequencyWheelDirection)).toBe(delta);
  });

  it('adds without snapping to decade boundaries or rounding manually entered fractions', () => {
    expect(99.9 + hfdEqFrequencyWheelDelta(99.9, 1)).toBe(100.9);
    expect(999.9 + hfdEqFrequencyWheelDelta(999.9, 1)).toBe(1009.9);
    expect(1000.125 + hfdEqFrequencyWheelDelta(1000.125, -1)).toBe(900.125);
    // The helper selects a delta; the numeric control owns its configured bounds.
    expect(hfdEqFrequencyWheelDelta(0, 1)).toBe(1);
  });

  it('rejects nonfinite values and directions that are not a single notch sign', () => {
    for (const value of [NaN, Infinity, -Infinity])
      expect(() => hfdEqFrequencyWheelDelta(value, 1)).toThrow(/finite/);
    for (const direction of [0, 2, -120, NaN])
      expect(() => hfdEqFrequencyWheelDelta(1000, direction as FrequencyWheelDirection)).toThrow(
        /direction/,
      );
  });
});

describe('advanced-wheel Single delta fixtures', () => {
  // Independent Python math/struct Float32 values from the recovered x87
  // operations. They are DELTAS, not native formatted next-frequency fixtures.
  it.each([
    [1, 100, 3.3882949352264404],
    [10, 100, 9.21034049987793],
    [100, 100, 25.036300659179688],
    [1000, 100, 68.05572509765625],
    [12000, 100, 200.23828125],
    [50000, 100, 372.1499328613281],
    [1000, 10, 184.99462890625],
    [1000, 250, 45.71318817138672],
  ])('f=%s configStep=%s preserves native Single delta %s', (frequency, step, delta) => {
    expect(hfdAdvancedFrequencyWheelDelta(frequency, 1, step)).toBe(delta);
    expect(hfdAdvancedFrequencyWheelDelta(frequency, -1, step)).toBe(-delta);
  });
  it('rejects invalid logarithm inputs, nonfinite parameters and a Float32 overflow', () => {
    for (const value of [0, -1, NaN])
      expect(() => hfdAdvancedFrequencyWheelDelta(value, 1)).toThrow();
    for (const step of [0, -1, Infinity, NaN])
      expect(() => hfdAdvancedFrequencyWheelDelta(100, 1, step)).toThrow();
    expect(() => hfdAdvancedFrequencyWheelDelta(Number.MAX_VALUE, 1, Number.MIN_VALUE)).toThrow(
      /finite/,
    );
  });
});

describe('advanced native formatting and next-frequency recurrence', () => {
  // Independent Python Fraction.from_float + native18-digit decimal carry
  // interpretation. Double inputs around decimal halves are deliberately not
  // replaced by decimal literals of an assumed exact value.
  it.each([
    [1.25, '1.3'],
    [1.75, '1.8'],
    [1.15, '1.1'],
    [1.05, '1.1'],
    [2.55, '2.5'],
    [1000.05, '1000.0'],
    [1000.15, '1000.1'],
    [9999.95, '10000.0'],
    [-1.25, '-1.3'],
    [-2.55, '-2.5'],
    [-0.04, '0.0'],
  ])('formats the actual Double %s as native #0.0 text %s', (value, expected) => {
    expect(formatHfdAdvancedFrequency(value)).toBe(expected);
  });
  it.each([
    [1, 1, 4.400000095367432],
    [1, -1, 1],
    [10, 1, 19.200000762939453],
    [10, -1, 1],
    [100, 1, 125],
    [100, -1, 75],
    [1000, 1, 1068.0999755859375],
    [1000, -1, 931.9000244140625],
    [1000.125, 1, 1068.199951171875],
    [1000.125, -1, 932],
    [12000, 1, 12200.2001953125],
    [12000, -1, 11799.7998046875],
    [50000, 1, 50000],
    [50000, -1, 49627.8984375],
  ])(
    'f=%s direction%s follows native text reparse and Single storage %s',
    (frequency, direction, expected) => {
      expect(hfdAdvancedFrequencyWheelNext(frequency, direction as FrequencyWheelDirection)).toBe(
        expected,
      );
    },
  );
  it('rounds exact candidate decimal halves upward before Single storage, independently of wheel direction', () => {
    // Decimal80 formula generated this step; both rawSingle deltas are exactly
    //68.25 (bytes00808842). This distinguishes decimal half-up from bankers.
    const frequencyStep = 99.345768192329;
    expect(hfdAdvancedFrequencyWheelDelta(1000, 1, frequencyStep)).toBe(68.25);
    expect(hfdAdvancedFrequencyWheelNext(1000, 1, { frequencyStep })).toBe(1068.300048828125);
    expect(hfdAdvancedFrequencyWheelNext(1000, -1, { frequencyStep })).toBe(931.7999877929688);
    expect(hfdAdvancedFrequencyWheelNext(1000, 1, { frequencyStep: 250 })).toBe(1045.699951171875);
  });
  it('reparses one-decimal text on each repeated edit and does not incorrectly invert an opposite wheel move', () => {
    const expected = [
      1068.0999755859375, 1138.0999755859375, 1210.0999755859375, 1284, 1359.9000244140625,
      1437.699951171875, 1517.4000244140625, 1599,
    ];
    let current = 1000;
    for (const next of expected) {
      current = hfdAdvancedFrequencyWheelNext(current, 1);
      expect(current).toBe(next);
    }
    expect(hfdAdvancedFrequencyWheelNext(hfdAdvancedFrequencyWheelNext(1000, 1), -1)).toBe(
      998.0999755859375,
    );
  });
  it('honors positive caller bounds and the zero-avoidance branch without doubling ordinary small unchanged display increments', () => {
    //8.7−8.66980266571045 formats as0.0. AddValue compares with zero,
    // doubles delta, then clamps the negative candidate to the positive min.
    expect(hfdAdvancedFrequencyWheelNext(8.7, -1)).toBe(1);
    expect(hfdAdvancedFrequencyWheelNext(1000, 1, { max: 1050 })).toBe(1050);
    expect(hfdAdvancedFrequencyWheelNext(1000, -1, { min: 975 })).toBe(975);
    // Tiny nonzero delta that leaves '#0.0' unchanged is NOT doubled.
    expect(hfdAdvancedFrequencyWheelNext(1000, 1, { frequencyStep: 1e20 })).toBe(1000);
    // Float32 zero delta is AddValue's early return, retaining imported value.
    expect(hfdAdvancedFrequencyWheelNext(1000.125, 1, { frequencyStep: 1e308 })).toBe(1000.125);
  });
  it('rejects invalid directions, logarithm inputs and bounds without producing nonfinite model values', () => {
    for (const frequency of [0, -1, NaN, Infinity])
      expect(() => hfdAdvancedFrequencyWheelNext(frequency, 1)).toThrow();
    for (const direction of [0, 120, NaN])
      expect(() =>
        hfdAdvancedFrequencyWheelNext(1000, direction as FrequencyWheelDirection),
      ).toThrow();
    for (const options of [
      { min: 0 },
      { max: 0 },
      { max: Infinity },
      { frequencyStep: 0 },
      { frequencyStep: NaN },
    ])
      expect(() => hfdAdvancedFrequencyWheelNext(1000, 1, options)).toThrow();
    expect(formatHfdAdvancedFrequency(Infinity)).toBe('');
  });
  it('clamps only the candidate, retains an imported frequency until edited, and follows native minimum-first precedence for crossed graph limits', () => {
    expect(hfdAdvancedFrequencyWheelNext(1, 1, { min: 10 })).toBe(10);
    expect(hfdAdvancedFrequencyWheelNext(10, 1, { min: 10 })).toBe(19.200000762939453);
    expect(hfdAdvancedFrequencyWheelNext(1000, 1, { min: 10, max: 500 })).toBe(500);
    expect(hfdAdvancedFrequencyWheelNext(1000, 1, { min: 10, max: 5 })).toBe(5);
    expect(hfdAdvancedFrequencyWheelNext(5, -1, { min: 10, max: 5 })).toBe(10);
  });
});
