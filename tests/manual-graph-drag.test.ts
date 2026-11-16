import { describe, expect, it } from 'vitest';
import { normalizeManualGraphDrag as drag } from '../src/domain/manual-graph-drag';
import { newFilter, type FilterKind } from '../src/domain/model';

const peak = (gain = 7.5) => ({ ...newFilter('peak'), frequency: 2300, q: 1.15, gain });
const point = (axisY: number, originAxisY = 0, frequency = 1000.123456789) => ({
  frequency,
  originAxisY,
  axisY,
});

describe('native ordinary graph drag arithmetic', () => {
  // Source predictions from c5b5bb..c8/c63d1f..51 and the independent
  // Fraction/x87/RTL reconstruction. These are not native Save observations.
  it.each([
    [0.145, 1, 1.14],
    [-0.145, -1, -1.14],
    [2.675, 1, 3.67],
    [7.5, 0.505, 8],
    [7.5, 0.515, 8.01],
    [23.99, 0.02, 24],
    [-124.99, -0.02, -125],
  ])('publishes captured Double gain%s + Single delta%s as%s', (origin, delta, expected) => {
    expect(drag(peak(origin), point(delta)).gain).toBe(expected);
  });

  it('subtracts the two axis Doubles in Extended before the Single store', () => {
    // Exact source-derived boundary: the Extended difference is one64-bit
    // significand step below a Float32 midpoint. Binary64-first subtraction
    // rounds to the midpoint and then to1, losing the native lower Single.
    const originAxisY = 2 ** -25 + 2 ** -64;
    expect(Math.fround(1 - originAxisY)).toBe(1);
    expect(drag(peak(0.14500003), point(1, originAxisY)).gain).toBe(1.14);
  });

  it('uses the captured model gain rather than its already-rounded display', () => {
    expect(drag(peak(2.675), point(1)).gain).toBe(3.67);
    expect(drag(peak(2.68), point(1)).gain).toBe(3.68);
  });

  it('publishes the explicit getter even when final visible gain Text stays the same', () => {
    expect(drag(peak(20.0004), point(0.0001)).gain).toBe(20);
    expect(drag(peak(20.0004), point(0))).not.toHaveProperty('gain');
    expect(drag(peak(20.0004), point(1e-50))).not.toHaveProperty('gain');
  });

  it('allows gain zero and retains captured independent role origins without accumulating events', () => {
    expect(drag(peak(7.5), point(-7.5)).gain).toBe(0);
    const left = peak(7.5),
      right = peak(-2);
    expect(drag(left, point(1.25)).gain).toBe(8.75);
    expect(drag(right, point(1.25)).gain).toBe(-0.75);
    expect(drag(left, point(1.25))).toEqual(drag(left, point(1.25)));
  });

  it('has the positive native Shelf1/Shelf2/Peak gain gate without a shelf multiplier', () => {
    const kinds: FilterKind[] = [
      'unity',
      'lowpass1',
      'lowpass2',
      'highpass1',
      'highpass2',
      'peak',
      'lowshelf1',
      'highshelf1',
      'lowshelf2',
      'highshelf2',
      'asymmetric',
      'allpass1',
      'allpass2',
      'raw',
    ];
    const supported = new Set<FilterKind>([
      'peak',
      'lowshelf1',
      'highshelf1',
      'lowshelf2',
      'highshelf2',
    ]);
    for (const kind of kinds) {
      const patch = drag({ ...peak(), kind }, point(1));
      expect(patch.frequency).toBe(1000.1234741210938);
      if (supported.has(kind)) expect(patch.gain).toBe(8.5);
      else expect(patch).not.toHaveProperty('gain');
    }
  });

  it('uses ordinary graph field bounds independently of the field-wheel AdditionalGain ceiling', () => {
    // AdditionalGain belongs to the channel; it is deliberately not an input
    // to this graph profile. Its separate field-wheel ceiling would produce14.
    expect(drag(peak(18), point(0.05)).gain).toBe(18.05);
  });

  it('narrows an absolute axis frequency once without applying typed frequency formatting', () => {
    expect(drag(peak(), point(0)).frequency).toBe(1000.1234741210938);
    expect(drag(peak(), point(0, 0, 1)).frequency).toBe(1);
    expect(drag(peak(), point(0, 0, 75000)).frequency).toBe(75000);
    expect(drag(peak(), point(0, 0, 0))).not.toHaveProperty('frequency');
    expect(drag(peak(), point(0, 0, -1))).not.toHaveProperty('frequency');
    expect(drag(peak(), point(0, 0, 1e-50))).not.toHaveProperty('frequency');
  });

  it('retains actual native interior and off-center Single frequencies beyond field display', () => {
    // Actual V45 native01 SHA daae165abb44e40ddda8adac4ece4b9c956a152ad36f0bfe95048682e24fcd0d:
    // f1=6319.00537109375, displayed6319.0; gain10.55. No synthetic axis-Y
    // input is presented as the original native pointer event here.
    const result = drag(peak(), point(0, 0, 6319.00537109375));
    expect(result).toEqual({ frequency: 6319.00537109375 });
    expect(result.frequency).not.toBe(6319);
    // Native02 SHA3dab4d8a0823bc1f355f483ded96869fabb3807087cc1634268cbf464fa0f457:
    // the actual off-center grab kept pointer X906 unchanged while
    // moving Y198->168. Saved F changed to6514.17333984375 from6319.00537109375.
    // The pure input is the admitted endpoint axis frequency, not a ratio or
    // reconstruction of that GUI's unrecorded exact axis-Y Doubles.
    const offsetOrigin = { ...peak(10.55), frequency: 6319.00537109375 };
    expect(drag(offsetOrigin, point(0, 0, 6514.17333984375))).toEqual({
      frequency: 6514.17333984375,
    });
  });

  it('returns only a patch and leaves retained caches, bypass and latent metadata untouched', () => {
    const origin = {
      ...peak(),
      enabled: false,
      sourceId: 'synthetic-retained-slot',
      sourceType: 'ftBoostCut',
      sourceShelfDirection: 'stUnknown' as const,
      coefficients: { b0: 1.2, b1: -0.3, b2: 0.1, f1: 0.2, f2: -0.1 },
    };
    const before = structuredClone(origin);
    const patch = drag(Object.freeze(origin), point(1));
    expect(patch).toEqual({ frequency: 1000.1234741210938, gain: 8.5 });
    expect(origin).toEqual(before);
  });

  it('refuses nonfinite or unrepresentable inputs without modifying its captured filter', () => {
    const origin = peak(),
      before = structuredClone(origin);
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => drag(origin, point(1, 0, value))).toThrow();
      expect(() => drag(origin, point(value))).toThrow();
      expect(() => drag(origin, point(1, value))).toThrow();
      expect(() => drag({ ...origin, gain: value }, point(1))).toThrow();
    }
    expect(() => drag(origin, point(1, 0, 1e100))).toThrow(/Single/);
    expect(() => drag(origin, point(1e100))).toThrow(/Single/);
    expect(origin).toEqual(before);
  });
});
