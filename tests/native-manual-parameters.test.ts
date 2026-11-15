// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { HFD_TEMPLATE } from '../src/domain/hfd-template';
import { exportHfd, importHfd } from '../src/domain/files';
import { editManualFilter } from '../src/domain/editing';
import { designHfd } from '../src/domain/hfd-math';
import { encodeChannel, q24, response } from '../src/domain/dsp';
import {
  normalizeHfdManualGainText,
  normalizeHfdManualQText,
} from '../src/domain/manual-parameter';
import type { Coefficients, FilterKind } from '../src/domain/model';
import {
  nativeManualParameterStates,
  nativeQCommitCases,
  nativeQZeroCommit,
  nativeGainCommitCases,
  nativeGainMinimumCommit,
  nativeAllpassCases,
  nativeQ2Commit,
} from './data/hfd-native-manual-parameters';

interface NativeState {
  kind: FilterKind;
  enabled: boolean;
  parameters: Record<string, string>;
  coefficients: Record<string, string>;
}
function nativeProject(fixture: NativeState) {
  const xml = new DOMParser().parseFromString(HFD_TEMPLATE, 'application/xml'),
    node = xml.querySelector('preset[index="1"] processobj[processtype="ptBiQuad"][groupid="1"]')!;
  node.setAttribute('enabled', String(fixture.enabled));
  for (const [name, value] of Object.entries({ ...fixture.parameters, ...fixture.coefficients }))
    node.querySelector(`:scope > ${name}`)!.setAttribute('value', value);
  return importHfd(new XMLSerializer().serializeToString(xml), 'Native manual parameters');
}
const literalCoefficients = (fixture: NativeState): Coefficients => ({
  b0: Number(fixture.coefficients.b0),
  b1: Number(fixture.coefficients.b1),
  b2: Number(fixture.coefficients.b2),
  f1: Number(fixture.coefficients.a1),
  f2: Number(fixture.coefficients.a2),
});
function doubleHex(value: number) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function firstWords(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: 5 }, (_, index) => view.getInt32(4 + index * 4, true));
}

it.each(nativeQCommitCases)(
  'matches native Q $name through raw Text, Double, saved cache and unbypassed software encoding',
  (fixture) => {
    const normalized = normalizeHfdManualQText(fixture.rawText);
    expect(normalized).toEqual({ text: fixture.expectedText, value: fixture.expectedValue });
    expect(doubleHex(normalized.value)).toBe(fixture.expectedFloat64LittleEndianHex);

    const imported = nativeProject(fixture.after),
      nativeChannel = imported.presets[0].channels[0],
      nativeFilter = nativeChannel.filters[0],
      literal = literalCoefficients(fixture.after);
    expect(nativeFilter.q).toBe(Number(fixture.after.parameters.q1));
    expect(nativeFilter.coefficients).toEqual(literal);
    const { id: _nativeId, ...nativeFields } = nativeFilter,
      { id: _reopenedId, ...reopenedFields } = importHfd(exportHfd(imported), 'Reopened native Q')
        .presets[0].channels[0].filters[0];
    // Native XML stores sourceId; each import creates a new browser UUID.
    expect(reopenedFields).toEqual(nativeFields);

    const original = nativeProject(fixture.before),
      untouched = structuredClone(original),
      before = original.presets[0].channels[0],
      next = editManualFilter(
        before.filters[0],
        { kind: fixture.after.kind, q: normalized.value },
        { redesign: true, manualParameters: false },
      ),
      generated = designHfd({ ...next, enabled: true });
    expect(next).toMatchObject({
      id: before.filters[0].id,
      sourceId: before.filters[0].sourceId,
      enabled: false,
      frequency: 720,
      frequency2: 988.101806640625,
      q: fixture.expectedValue,
      q2: 0.7,
      gain: 0,
    });
    expect(next.coefficients).toBeUndefined();
    for (const key of ['b0', 'b1', 'b2', 'f1', 'f2'] as const)
      expect(Math.abs(generated[key] - literal[key])).toBeLessThan(1e-12);
    const filters = [{ ...next, enabled: true }, ...before.filters.slice(1)];
    // Native rows are disabled. These are explicitly underlying-section
    // software words; the real disabled channel still encodes Unity.
    expect(firstWords(encodeChannel({ ...before, filters }))).toEqual(fixture.after.q24WireWords);
    expect(firstWords(encodeChannel(nativeChannel))).toEqual([0, 0, 16777216, 0, 0]);
    expect(original).toEqual(untouched);
  },
);

it('restores the saved previous Double for an exact-zero Q commit without clamping it to the minimum', () => {
  const fixture = nativeQZeroCommit,
    project = nativeProject(nativeManualParameterStates.hp2QHalf),
    original = structuredClone(project),
    current = project.presets[0].channels[0].filters[0],
    normalized = normalizeHfdManualQText(fixture.rawText, { previousValue: current.q });
  expect(normalized).toEqual({ text: fixture.expectedText, value: fixture.expectedValue });
  expect(doubleHex(normalized.value)).toBe(fixture.expectedFloat64LittleEndianHex);
  const next = editManualFilter(current, { q: 0 }, { redesign: true });
  expect(next).toMatchObject({ q: current.q, enabled: false, frequency: 720, q2: 0.7 });
  expect(designHfd({ ...next, enabled: true })).toEqual(
    designHfd({ ...current, enabled: true, coefficients: undefined }),
  );
  expect(project).toEqual(original);
});

it('refuses the observed direct HP2-to-Peak NaN cache while accepting the subsequently repaired native Peak', () => {
  // The actual native route used Function BoostCut directly, with no Unity
  // selection. The later Q commit produced a finite cancelling Peak cache.
  expect(() => nativeProject(nativeManualParameterStates.directPeakInvalid)).toThrow(
    'Invalid HFD b1',
  );
  const repaired = nativeProject(nativeManualParameterStates.peakQHalf),
    filter = repaired.presets[0].channels[0].filters[0];
  expect(filter).toMatchObject({ kind: 'peak', enabled: false, q: 0.401, gain: 0 });
  expect(filter.coefficients).toEqual(literalCoefficients(nativeManualParameterStates.peakQHalf));
  expect(Object.values(filter.coefficients!).every(Number.isFinite)).toBe(true);
});

it.each(nativeGainCommitCases)(
  'matches native gain $name through raw Text, Double, saved coefficients and software words',
  (fixture) => {
    const normalized = normalizeHfdManualGainText(fixture.rawText);
    expect(normalized).toEqual({ text: fixture.expectedText, value: fixture.expectedValue });
    expect(doubleHex(normalized.value)).toBe(fixture.expectedFloat64LittleEndianHex);
    const saved = nativeProject(fixture.after),
      channel = saved.presets[0].channels[0],
      filter = channel.filters[0],
      native = literalCoefficients(fixture.after);
    expect(filter.gain).toBe(Number(fixture.after.parameters.gain));
    expect(filter.coefficients).toEqual(native);
    expect(firstWords(encodeChannel(channel))).toEqual(fixture.after.q24WireWords);
    const reopened = importHfd(exportHfd(saved), 'Reopened gain').presets[0].channels[0].filters[0];
    expect(reopened).toMatchObject({
      gain: fixture.expectedValue,
      q: 1.15,
      enabled: true,
      sourceId: filter.sourceId,
      coefficients: native,
    });

    const original = nativeProject(fixture.before),
      untouched = structuredClone(original),
      before = original.presets[0].channels[0],
      next = editManualFilter(
        before.filters[0],
        { gain: normalized.value },
        { redesign: true, manualParameters: false },
      ),
      generated = designHfd(next);
    expect(next).toMatchObject({
      id: before.filters[0].id,
      sourceId: before.filters[0].sourceId,
      kind: 'peak',
      enabled: true,
      frequency: 2300,
      frequency2: 988.101806640625,
      q: 1.15,
      q2: 0.7,
      gain: fixture.expectedValue,
    });
    expect(next.coefficients).toBeUndefined();
    for (const key of ['b0', 'b1', 'b2', 'f1', 'f2'] as const)
      expect(Math.abs(generated[key] - native[key])).toBeLessThan(1e-12);
    expect(
      firstWords(encodeChannel({ ...before, filters: [next, ...before.filters.slice(1)] })),
    ).toEqual(fixture.after.q24WireWords);
    expect(original).toEqual(untouched);
  },
);

it('preserves the actual native minimum-gain cache for inspection while refusing its pole-at-one compilation', () => {
  const fixture = nativeGainMinimumCommit,
    normalized = normalizeHfdManualGainText(fixture.rawText);
  expect(normalized).toEqual({ text: fixture.expectedText, value: fixture.expectedValue });
  expect(doubleHex(normalized.value)).toBe(fixture.expectedFloat64LittleEndianHex);
  const imported = nativeProject(fixture.after),
    channel = imported.presets[0].channels[0],
    filter = channel.filters[0],
    literal = literalCoefficients(fixture.after);
  expect(filter).toMatchObject({ gain: -125, enabled: true, coefficients: literal });
  expect([literal.b2, literal.b1, literal.b0, literal.f2, literal.f1].map(q24)).toEqual(
    fixture.after.q24WireWords,
  );
  expect(() => encodeChannel(channel)).toThrow('Unstable or non-finite biquad');
  const regeneratedFilter = { ...filter, coefficients: undefined },
    regenerated = designHfd(regeneratedFilter);
  // Native complex AUTOZERO snaps the tiny 1-sqrt pole factor before its
  // large real-pole multiplication. Preserve that actual coefficient result;
  // reproducing it does not make the pole-at-one section safe to compile.
  for (const key of ['b0', 'b1', 'b2', 'f1', 'f2'] as const)
    expect(Math.abs(regenerated[key] - literal[key])).toBeLessThan(1e-18);
  expect(regenerated.f1).toBe(1);
  expect(() =>
    encodeChannel({ ...channel, filters: [regeneratedFilter, ...channel.filters.slice(1)] }),
  ).toThrow('Unstable or non-finite biquad');
  expect(
    importHfd(exportHfd(imported), 'Reopened extreme native gain').presets[0].channels[0].filters[0]
      .coefficients,
  ).toEqual(literal);
});

it.each(nativeAllpassCases)(
  'matches native $name without resetting latent gain or substituting a conventional polarity',
  (fixture) => {
    const imported = nativeProject(fixture.after),
      channel = imported.presets[0].channels[0],
      filter = channel.filters[0],
      native = literalCoefficients(fixture.after),
      beforeProject = nativeProject(fixture.before),
      untouched = structuredClone(beforeProject),
      before = beforeProject.presets[0].channels[0],
      next = editManualFilter(
        before.filters[0],
        {
          kind: fixture.after.kind,
          frequency: Number(fixture.after.parameters.f1),
          q: Number(fixture.after.parameters.q1),
        },
        { redesign: true, manualFrequency: false, manualParameters: false },
      ),
      generated = designHfd(next);
    expect(filter.coefficients).toEqual(native);
    expect(filter).toMatchObject({
      kind: fixture.after.kind,
      enabled: true,
      gain: 7.5,
      frequency2: 988.101806640625,
      q2: 0.7,
    });
    expect(next).toMatchObject({
      id: before.filters[0].id,
      sourceId: before.filters[0].sourceId,
      enabled: true,
      gain: 7.5,
      frequency2: 988.101806640625,
      q2: 0.7,
    });
    for (const key of ['b0', 'b1', 'b2', 'f1', 'f2'] as const)
      expect(Math.abs(generated[key] - native[key])).toBeLessThan(1e-12);
    const [real, imaginary] = response(generated, next.frequency);
    expect(real).toBeCloseTo(fixture.after.responseAtPrimary.real, 12);
    expect(imaginary).toBeCloseTo(fixture.after.responseAtPrimary.imaginary, 12);
    expect(firstWords(encodeChannel(channel))).toEqual(fixture.after.q24WireWords);
    expect(
      firstWords(encodeChannel({ ...before, filters: [next, ...before.filters.slice(1)] })),
    ).toEqual(fixture.after.q24WireWords);
    expect(beforeProject).toEqual(untouched);
  },
);

it('matches the native asymmetric Q2 Double half commit and subsequent zero revert independently of Q1', () => {
  const fixture = nativeQ2Commit,
    normalized = normalizeHfdManualQText(fixture.rawText),
    original = nativeProject(fixture.before),
    untouched = structuredClone(original),
    channel = original.presets[0].channels[0],
    next = editManualFilter(
      channel.filters[0],
      { q2: normalized.value },
      { redesign: true, manualParameters: false },
    ),
    native = literalCoefficients(fixture.after),
    imported = nativeProject(fixture.after).presets[0].channels[0];
  expect(normalized).toEqual({ text: fixture.expectedText, value: fixture.expectedValue });
  expect(doubleHex(normalized.value)).toBe(fixture.expectedFloat64LittleEndianHex);
  expect(next).toMatchObject({
    id: channel.filters[0].id,
    sourceId: channel.filters[0].sourceId,
    kind: 'asymmetric',
    shelfDirection: 'low',
    enabled: true,
    frequency: 800,
    frequency2: 400,
    q: 0.7,
    q2: 1.301,
    gain: 0,
  });
  expect(next.coefficients).toBeUndefined();
  expect(imported.filters[0]).toMatchObject({ q: 0.7, q2: 1.301, coefficients: native });
  const generated = designHfd(next);
  for (const key of ['b0', 'b1', 'b2', 'f1', 'f2'] as const)
    expect(Math.abs(generated[key] - native[key])).toBeLessThan(1e-12);
  expect(firstWords(encodeChannel(imported))).toEqual(fixture.after.q24WireWords);
  const zero = normalizeHfdManualQText(fixture.zeroText, { previousValue: next.q2 });
  expect(zero).toEqual(normalized);
  const afterZero = editManualFilter(next, { q2: 0 }, { redesign: true });
  expect(afterZero).toEqual(next);
  expect(
    firstWords(encodeChannel({ ...channel, filters: [afterZero, ...channel.filters.slice(1)] })),
  ).toEqual(fixture.after.q24WireWords);
  expect(original).toEqual(untouched);
});
