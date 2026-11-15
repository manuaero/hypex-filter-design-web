import { describe, expect, it } from 'vitest';
import {
  editManualFilter,
  mergeRawCoefficients,
  type ManualFilterPatch,
} from '../src/domain/editing';
import { design, encodeChannel, response } from '../src/domain/dsp';
import { newFilter, newProject, unity, type Coefficients, type Filter } from '../src/domain/model';

const left: Coefficients = {
  b0: 0.12345678901234568,
  b1: -0.012345678901234568,
  b2: 0.0034567890123456787,
  f1: 0.375,
  f2: -0.125,
};
const right: Coefficients = { b0: 0.75, b1: 0.125, b2: -0.03125, f1: 0.625, f2: -0.25 };
function raw(coefficients: Coefficients = left): Filter {
  return {
    ...newFilter('raw'),
    sourceId: 'native-slot-13',
    sourceType: 'ftFree',
    provenance: 'hfd',
    coefficients: { ...coefficients },
  };
}

describe('shared exact raw coefficient editing', () => {
  it('constructs independent complete unity vectors for fresh raw sections', () => {
    const first = newFilter('raw'),
      second = newFilter('raw');
    expect(first).toMatchObject({ enabled: true, coefficients: unity() });
    expect(second.coefficients).toEqual(unity());
    first.coefficients!.b0 = 0.5;
    expect(second.coefficients).toEqual(unity());
    expect(design(second)).toEqual(unity());
  });

  it('merges one supplied Double into each role’s own vector without copying other-role values', () => {
    const a = raw(),
      b = raw(right),
      original = structuredClone([a, b]);
    const patch: ManualFilterPatch = { coefficients: { b1: -0.2222222222222222 } };
    const nextA = editManualFilter(a, patch, { redesign: true });
    const nextB = editManualFilter(b, patch, { redesign: true });
    expect(nextA.coefficients).toEqual({ ...left, b1: -0.2222222222222222 });
    expect(nextB.coefficients).toEqual({ ...right, b1: -0.2222222222222222 });
    expect(nextA.provenance).toBeUndefined();
    expect(nextA.sourceId).toBe(a.sourceId);
    expect(nextA.id).toBe(a.id);
    expect([a, b]).toEqual(original);
    nextA.coefficients!.b0 = 9;
    expect(a.coefficients).toEqual(left);
    expect(nextB.coefficients!.b0).toBe(right.b0);
  });

  it.each([false, true])(
    'retains a raw vector and provenance across Enabled=%s redesign',
    (enabled) => {
      const current = raw();
      current.enabled = !enabled;
      const before = structuredClone(current);
      const next = editManualFilter(current, { enabled }, { redesign: true });
      expect(next).toEqual({ ...before, enabled });
      expect(current).toEqual(before);
    },
  );

  it('keeps disabled raw coefficients under latent manual parameter redesign', () => {
    const current = { ...raw(), enabled: false };
    const next = editManualFilter(
      current,
      { frequency: 400.04, q: 0.4005, gain: 7.555 },
      { redesign: true },
    );
    expect(next).toMatchObject({
      enabled: false,
      frequency: 400,
      q: 0.401,
      gain: 7.56,
      coefficients: left,
      provenance: 'hfd',
    });
    expect(design(next)).toEqual(unity());
    expect(design({ ...next, enabled: true })).toEqual(left);
  });

  it('converts a disabled cached ordinary section without bypassing or redesigning its exact cache', () => {
    const current = { ...raw(), kind: 'peak' as const, enabled: false, gain: 7.55555 };
    const next = editManualFilter(current, { kind: 'raw' }, { redesign: true });
    expect(next).toEqual({ ...current, kind: 'raw' });
    expect(next.coefficients).not.toBe(current.coefficients);
    expect(design({ ...next, enabled: true })).toEqual(left);
  });

  it('converts a disabled cacheless HP2 from its unbypassed native transfer', () => {
    const current = { ...newFilter('highpass2'), enabled: false, frequency: 720, q: 0.4 };
    const next = editManualFilter(current, { kind: 'raw' }, { redesign: true });
    // Independent saved native HP2 literal, not the bypassed unity transfer.
    const native: Coefficients = {
      b0: 0.941853163030452,
      b1: -1.8837063260609,
      b2: 0.941853163030452,
      f1: 1.88416237410376,
      f2: -0.886355508349538,
    };
    expect(next.enabled).toBe(false);
    for (const key of Object.keys(native) as (keyof Coefficients)[])
      expect(next.coefficients![key]).toBeCloseTo(native[key], 12);
    for (const hz of [100, 720, 5000]) {
      const actual = response(design({ ...next, enabled: true }), hz);
      const expected = response(native, hz);
      actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 11));
    }
  });

  it('keeps the current transfer when conversion and latent parameter edits share one patch', () => {
    const current = { ...newFilter('highpass2'), enabled: false, frequency: 720, q: 0.4 };
    const expected = editManualFilter(current, { kind: 'raw' });
    const next = editManualFilter(
      current,
      { kind: 'raw', frequency: 1800, q: 2.5, gain: 12 },
      { redesign: true },
    );
    expect(next).toMatchObject({ frequency: 1800, q: 2.5, gain: 12, enabled: false });
    expect(next.coefficients).toEqual(expected.coefficients);
  });

  it('uses the old ordinary cache as the baseline for an explicit partial raw conversion', () => {
    const current = { ...raw(right), kind: 'peak' as const, enabled: false };
    const next = editManualFilter(current, { kind: 'raw', coefficients: { b0: 0.6 } });
    expect(next).toMatchObject({
      kind: 'raw',
      enabled: false,
      coefficients: { ...right, b0: 0.6 },
    });
    expect(current.coefficients).toEqual(right);
  });

  it('converts Unity to actual unity even if an ignored stale cache exists', () => {
    const current = { ...raw(), kind: 'unity' as const, enabled: false };
    expect(editManualFilter(current, { kind: 'raw' }).coefficients).toEqual(unity());
  });

  it('redesigns away from raw by removing its cache and provenance while preserving slot and bypass', () => {
    const current = { ...raw(), enabled: false };
    const next = editManualFilter(current, { kind: 'highpass2' }, { redesign: true });
    expect(next).toMatchObject({
      id: current.id,
      sourceId: current.sourceId,
      kind: 'highpass2',
      enabled: false,
    });
    expect(Object.hasOwn(next, 'coefficients')).toBe(false);
    expect(Object.hasOwn(next, 'provenance')).toBe(false);
  });

  it('preserves the existing full-vector ordinary-cache API without implicit raw conversion', () => {
    const current = newFilter('peak');
    const next = editManualFilter(current, { coefficients: right }, { redesign: true });
    expect(next.kind).toBe('peak');
    expect(next.coefficients).toEqual(right);
    expect(design(next)).toEqual(right);
  });

  it('clears stale ordinary-cache provenance only for a genuinely changed explicit vector', () => {
    const channel = newProject().presets[0].channels[0];
    channel.coefficientCache = 'effective';
    channel.additionalGain = 10;
    const current = { ...raw(), kind: 'peak' as const, enabled: false };
    const before = structuredClone(current);
    const same = editManualFilter(current, { coefficients: left }, { redesign: true });
    expect(same).toEqual(before);
    expect(same.provenance).toBe('hfd');
    const changed = editManualFilter(current, { coefficients: right }, { redesign: true });
    channel.filters[0] = changed;
    expect(changed).toEqual({ ...before, coefficients: right, provenance: undefined });
    expect(Object.hasOwn(changed, 'provenance')).toBe(false);
    expect(changed).toMatchObject({
      id: before.id,
      sourceId: before.sourceId,
      kind: 'peak',
      enabled: false,
    });
    expect(channel.coefficientCache).toBe('effective');
    expect(channel.additionalGain).toBe(10);
    expect(current).toEqual(before);
  });

  it('rejects partial coefficients unless the resulting section is raw', () => {
    expect(() => editManualFilter(newFilter('peak'), { coefficients: { b0: 0.5 } })).toThrow(
      /raw|complete/i,
    );
    expect(() => editManualFilter(raw(), { kind: 'peak', coefficients: { b0: 0.5 } })).toThrow(
      /raw|complete/i,
    );
  });

  it.each([undefined, { ...left, f2: NaN }])(
    'allows a complete explicit replacement to repair malformed raw data (%j)',
    (coefficients) => {
      const current = { ...raw(), coefficients };
      const next = editManualFilter(current, { coefficients: right });
      expect(next.coefficients).toEqual(right);
      expect(next.provenance).toBeUndefined();
    },
  );

  it.each([undefined, { b0: 1 }, { ...left, f1: Infinity }])(
    'refuses partial or implicit edits of malformed raw data (%j)',
    (coefficients) => {
      const current = { ...raw(), coefficients } as Filter;
      expect(() => editManualFilter(current, { coefficients: { b0: 0.5 } })).toThrow(
        /coefficient|finite|complete/i,
      );
      expect(() => editManualFilter(current, { enabled: false }, { redesign: true })).toThrow(
        /coefficient|finite|complete/i,
      );
    },
  );

  it.each([NaN, Infinity, -Infinity, undefined])(
    'rejects a nonfinite/undefined explicitly supplied coefficient (%j)',
    (b0) => {
      expect(() => editManualFilter(raw(), { coefficients: { b0 } })).toThrow(
        /coefficient|finite/i,
      );
    },
  );

  it.each([{}, { extra: 1 }, null, [], 1].map((coefficients) => [coefficients]))(
    'rejects empty, unknown or malformed coefficient patches (%j)',
    (coefficients) => {
      expect(() => editManualFilter(raw(), { coefficients } as ManualFilterPatch)).toThrow(
        /coefficient|patch|object/i,
      );
    },
  );

  it('keeps exact supplied Double values and signed zero without manual parameter formatting', () => {
    const next = editManualFilter(raw(), { coefficients: { b0: 0.4000000000000001, b1: -0 } });
    expect(next.coefficients!.b0).toBe(0.4000000000000001);
    expect(Object.is(next.coefficients!.b1, -0)).toBe(true);
    expect(next.coefficients!.b2).toBe(left.b2);
  });

  it('preserves provenance for an exact no-op coefficient patch', () => {
    const current = raw();
    expect(editManualFilter(current, { coefficients: { b0: left.b0 } })).toEqual(current);
  });

  it('offers a detached shared merge helper with full repair but no invented partial baseline', () => {
    const repaired = mergeRawCoefficients(undefined, right);
    expect(repaired).toEqual(right);
    expect(repaired).not.toBe(right);
    expect(mergeRawCoefficients(left, { b0: right.b0 })).toEqual({ ...left, b0: right.b0 });
    expect(() => mergeRawCoefficients(undefined, { b0: 1 })).toThrow(/coefficient|complete/i);
    expect(() =>
      mergeRawCoefficients(left, { b0: 1, unwanted: 2 } as unknown as Coefficients),
    ).toThrow(/known/);
    const inherited = Object.create({ ...left }) as Coefficients;
    expect(() => mergeRawCoefficients(inherited, { b0: 1 })).toThrow(/coefficient|complete/i);
  });

  it('accepts finite authoring values while keeping stability, Q24 and unresolved first-cache refusal separate', () => {
    const channel = newProject().presets[0].channels[0];
    channel.filters[0] = editManualFilter(raw(), { coefficients: { f1: 1, f2: 0 } });
    expect(() => encodeChannel(channel)).toThrow(/unstable/i);
    channel.filters[0] = editManualFilter(raw(), { coefficients: { b0: 1000 } });
    expect(() => encodeChannel(channel)).toThrow(/Q8.24/);
    channel.filters[0] = editManualFilter(raw(), { coefficients: { b0: 0.5 } });
    channel.coefficientCache = 'unresolved';
    channel.additionalGain = 10;
    expect(() => encodeChannel(channel)).toThrow(/gain interpretation/);
    expect(channel.coefficientCache).toBe('unresolved');
    expect(channel.additionalGain).toBe(10);
  });
});
