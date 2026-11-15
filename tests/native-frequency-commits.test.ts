// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { HFD_TEMPLATE } from '../src/domain/hfd-template';
import { importHfd, exportHfd } from '../src/domain/files';
import { designHfd } from '../src/domain/hfd-math';
import { encodeChannel } from '../src/domain/dsp';
import { filterMarkerAnchor } from '../src/domain/plot-layers';
import { editManualFilter } from '../src/domain/editing';
import { normalizeHfdManualFrequencyText } from '../src/domain/manual-frequency';
import type { Coefficients, FilterKind } from '../src/domain/model';
import {
  nativeAsymmetricFrequencyBaseline,
  nativeFrequencyBounds,
  nativeFrequencyCommitCases,
  nativeDisabledTypeTransition,
  nativeRejectedUnitySelection,
  nativeZeroFrequencyCommit,
} from './data/hfd-native-frequency-commits';

interface NativeState {
  kind: FilterKind;
  enabled: boolean;
  parameters: Record<string, string>;
  coefficients: Record<string, string>;
}
function nativeProject(fixture: NativeState) {
  const doc = new DOMParser().parseFromString(HFD_TEMPLATE, 'application/xml'),
    node = doc.querySelector('preset[index="1"] processobj[processtype="ptBiQuad"][groupid="1"]')!;
  node.setAttribute('enabled', String(fixture.enabled));
  for (const [name, value] of Object.entries({ ...fixture.parameters, ...fixture.coefficients }))
    node.querySelector(`:scope > ${name}`)!.setAttribute('value', value);
  return importHfd(new XMLSerializer().serializeToString(doc), 'Native numeric commit');
}
const literalCoefficients = (fixture: NativeState): Coefficients => ({
  b0: Number(fixture.coefficients.b0),
  b1: Number(fixture.coefficients.b1),
  b2: Number(fixture.coefficients.b2),
  f1: Number(fixture.coefficients.a1),
  f2: Number(fixture.coefficients.a2),
});
function firstWords(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: 5 }, (_, i) => view.getInt32(4 + i * 4, true));
}
function singleHex(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setFloat32(0, value, true);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

it.each(nativeFrequencyCommitCases)(
  'matches native $name from raw text through Single, saved literals and compilation',
  (fixture) => {
    const normalized = normalizeHfdManualFrequencyText(fixture.rawText, nativeFrequencyBounds);
    expect(normalized).toEqual({ text: fixture.expectedText, value: fixture.expectedValue });
    expect(singleHex(normalized.value)).toBe(fixture.expectedFloat32LittleEndianHex);

    const imported = nativeProject(fixture),
      nativeChannel = imported.presets[0].channels[0],
      nativeFilter = nativeChannel.filters[0],
      original = literalCoefficients(fixture);
    // Native Save serializes a rounded decimal of its Single. Passive import
    // retains that literal value instead of silently applying a text commit.
    expect(nativeFilter.frequency2).toBe(Number(fixture.parameters.f2));
    expect(nativeFilter.coefficients).toEqual(original);
    const reopened = importHfd(exportHfd(imported), 'Reopened native commit');
    expect(reopened.presets[0].channels[0].filters[0].frequency2).toBe(
      Number(fixture.parameters.f2),
    );
    expect(firstWords(encodeChannel(nativeChannel))).toEqual(fixture.q24WireWords);

    const baseline = nativeProject(nativeAsymmetricFrequencyBaseline),
      channel = baseline.presets[0].channels[0],
      before = structuredClone(baseline),
      edited = editManualFilter(
        channel.filters[0],
        { frequency2: normalized.value },
        { redesign: true, manualFrequency: false },
      ),
      generated = designHfd(edited);
    expect(edited).toMatchObject({
      id: channel.filters[0].id,
      sourceId: channel.filters[0].sourceId,
      kind: 'asymmetric',
      enabled: true,
      frequency: 800,
      frequency2: fixture.expectedValue,
      q: 0.7,
      q2: 1.3,
      gain: 0,
    });
    for (const key of ['b0', 'b1', 'b2', 'f1', 'f2'] as const)
      expect(Math.abs(generated[key] - original[key])).toBeLessThan(1e-12);
    expect(filterMarkerAnchor(edited)).toEqual(fixture.marker);
    expect(
      firstWords(encodeChannel({ ...channel, filters: [edited, ...channel.filters.slice(1)] })),
    ).toEqual(fixture.q24WireWords);
    expect(baseline).toEqual(before);
  },
);

it('preserves the observed native disabled LP2 to HP2 transition while retaining its underlying response', () => {
  const project = nativeProject(nativeDisabledTypeTransition.before),
    before = structuredClone(project),
    channel = project.presets[0].channels[0],
    old = channel.filters[0],
    next = editManualFilter(old, { kind: 'highpass2' }, { redesign: true }),
    generated = designHfd({ ...next, enabled: true }),
    original = literalCoefficients(nativeDisabledTypeTransition.after);
  expect(next).toMatchObject({
    id: old.id,
    sourceId: old.sourceId,
    kind: 'highpass2',
    enabled: false,
    frequency: 720,
    frequency2: 988.101806640625,
    q: 0.4,
    q2: 0.7,
    gain: 0,
  });
  for (const key of ['b0', 'b1', 'b2', 'f1', 'f2'] as const)
    expect(Math.abs(generated[key] - original[key])).toBeLessThan(1e-12);
  expect(filterMarkerAnchor(next)).toEqual(nativeDisabledTypeTransition.after.marker);
  expect(
    firstWords(encodeChannel({ ...channel, filters: [next, ...channel.filters.slice(1)] })),
  ).toEqual([0, 0, 16777216, 0, 0]);
  expect(project).toEqual(before);
});

it('restores the observed previous frequency when committed native text is exact zero', () => {
  const fixture = nativeZeroFrequencyCommit;
  expect(
    normalizeHfdManualFrequencyText(fixture.rawText, {
      ...nativeFrequencyBounds,
      previousValue: fixture.previousValue,
    }),
  ).toEqual({ text: fixture.expectedText, value: fixture.expectedValue });
});

it('rejects the observed native Function-Unity NaN cache instead of manufacturing finite coefficients', () => {
  expect(() => nativeProject(nativeRejectedUnitySelection)).toThrow(
    nativeRejectedUnitySelection.expectedError,
  );
});
