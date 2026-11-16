// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { HFD_TEMPLATE } from '../src/domain/hfd-template';
import { exportHfd, importHfd, parseProject } from '../src/domain/files';
import { importProjectFolder, projectFiles } from '../src/domain/project-io';
import { design, encodeChannel, response } from '../src/domain/dsp';
import { editManualFilter } from '../src/domain/editing';
import { hfdManualGraphQNext, type HfdManualGraphQState } from '../src/domain/manual-graph-q';
import { selectedSectionCoefficients, selectedSectionResponse } from '../src/domain/plot-layers';
import { nativeGraphQStates } from './data/hfd-native-graph-q';

type NativeState = (typeof nativeGraphQStates)[number];

function reconstruction(state: NativeState) {
  // A minimal synthetic container holds only the sanitized saved BQ literals.
  // Its complete bytes are not represented as a native project Save artifact.
  const doc = new DOMParser().parseFromString(HFD_TEMPLATE, 'application/xml'),
    node = doc.querySelector('preset[index="1"] processobj[processtype="ptBiQuad"][groupid="1"]')!;
  doc.documentElement.removeAttribute('fusion-studio-coefficient-cache');
  node.setAttribute('enabled', String(state.enabled));
  node.setAttribute('id', state.sourceId);
  for (const [name, value] of Object.entries({
    ...state.parameters,
    ...state.coefficients,
    ...state.rootMetadata,
  }))
    node.querySelector(`:scope > ${name}`)!.setAttribute('value', value);
  return importHfd(new XMLSerializer().serializeToString(doc), 'Native graph Q reconstruction');
}

function literalCoefficients(state: NativeState) {
  return {
    b0: Number(state.coefficients.b0),
    b1: Number(state.coefficients.b1),
    b2: Number(state.coefficients.b2),
    f1: Number(state.coefficients.a1),
    f2: Number(state.coefficients.a2),
  };
}

function firstWords(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: 5 }, (_, index) => view.getInt32(4 + index * 4, true));
}

it('matches the three completed native additive graph Q steps and regenerates their saved sections', () => {
  let filter = reconstruction(nativeGraphQStates[0]).presets[0].channels[0].filters[0],
    state: HfdManualGraphQState | undefined;
  for (const native of nativeGraphQStates.slice(1, 4)) {
    // The native inputs were +120, +360 and one requested Ctrl endpoint move.
    // Their stored sequence qualifies three signed steps, not OS callback counts.
    const result = hfdManualGraphQNext(filter.q, 1, { state });
    expect(result).toMatchObject({
      value: Number(native.parameters.q1),
      text: Number(native.parameters.q1).toFixed(3),
      changed: true,
    });
    state = result.state;
    filter = editManualFilter(
      filter,
      { q: result.value },
      { redesign: true, manualParameters: false },
    );
    expect(filter.coefficients).toBeUndefined();
    expect(filter).toMatchObject({
      frequency: 2300,
      frequency2: 988.101806640625,
      q2: 0.7,
      gain: 7.5,
      enabled: true,
    });
    const generated = design(filter),
      expected = literalCoefficients(native);
    for (const key of ['b0', 'b1', 'b2', 'f1', 'f2'] as const)
      expect(Math.abs(generated[key] - expected[key])).toBeLessThan(1e-12);
  }
});

it.each(nativeGraphQStates)(
  'preserves and independently regenerates the completed native $phase section',
  (state) => {
    const project = reconstruction(state),
      before = structuredClone(project),
      channel = project.presets[0].channels[0],
      filter = channel.filters[0],
      native = literalCoefficients(state);
    expect(channel).toMatchObject({
      gain: 0,
      additionalGain: 0,
      invert: false,
      coefficientCache: 'base',
    });
    expect(filter).toMatchObject({
      sourceType: state.parameters.filtertype,
      sourceId: state.sourceId,
      kind: state.kind,
      enabled: state.enabled,
      frequency: Number(state.parameters.f1),
      frequency2: Number(state.parameters.f2),
      q: Number(state.parameters.q1),
      q2: Number(state.parameters.q2),
      gain: Number(state.parameters.gain),
      // Actual native Unknown Shelf1/2 take Low, while Unknown Asym takes High.
      shelfDirection: state.kind.startsWith('low') ? 'low' : 'high',
      sourceShelfDirection: state.parameters.shelfhl,
      coefficients: native,
    });

    const cacheless = structuredClone(channel);
    delete cacheless.filters[0].coefficients;
    delete cacheless.filters[0].provenance;
    for (const actual of [design(cacheless.filters[0]), selectedSectionCoefficients(filter)])
      for (const key of ['b0', 'b1', 'b2', 'f1', 'f2'] as const)
        expect(Math.abs(actual[key] - native[key])).toBeLessThan(1e-12);
    for (const frequency of [0, 2300, 20000]) {
      const selected = selectedSectionResponse(filter, frequency),
        saved = response(native, frequency);
      expect(Math.abs(selected[0] - saved[0])).toBeLessThan(1e-10);
      expect(Math.abs(selected[1] - saved[1])).toBeLessThan(1e-10);
    }
    // Fixed predictions come from Decimal arithmetic on native literal strings,
    // not the production designer. This does not qualify actual upload bytes.
    for (const candidate of [channel, cacheless])
      expect(firstWords(encodeChannel(candidate))).toEqual(state.decimalQ24Prediction);

    const xml = exportHfd(project),
      exported = new DOMParser().parseFromString(xml, 'application/xml'),
      exportedNode = exported.querySelector(
        'preset[index="1"] processobj[processtype="ptBiQuad"][groupid="1"]',
      )!;
    for (const [name, value] of Object.entries({ ...state.coefficients, ...state.rootMetadata }))
      expect(exportedNode.querySelector(`:scope > ${name}`)!.getAttribute('value')).toBe(value);
    expect(exportedNode.querySelector(':scope > shelfhl')!.getAttribute('value')).toBe(
      state.parameters.shelfhl,
    );
    expect(
      importHfd(xml, 'Reopened native graph Q reconstruction').presets[0].channels[0].filters[0],
    ).toMatchObject({ kind: state.kind, enabled: state.enabled, coefficients: native });
    // The native raw direction enum and coefficient Doubles are independent
    // retained fields, including when Unknown selects a different constructor.
    expect(project).toEqual(before);
  },
);

it('reinterprets the retained native Unknown enum across Asym and both Shelf Functions using the actual native constructors', () => {
  let filter = reconstruction(nativeGraphQStates[9]).presets[0].channels[0].filters[0];
  for (const native of [
    nativeGraphQStates[6],
    nativeGraphQStates[8],
    nativeGraphQStates[9],
    nativeGraphQStates[6],
  ]) {
    filter = editManualFilter(filter, { kind: native.kind }, { redesign: true });
    const generated = design(filter),
      expected = literalCoefficients(native);
    for (const key of ['b0', 'b1', 'b2', 'f1', 'f2'] as const)
      expect(Math.abs(generated[key] - expected[key])).toBeLessThan(1e-12);
    expect(filter).toMatchObject({
      kind: native.kind,
      shelfDirection: native.kind === 'asymmetric' ? 'high' : 'low',
      sourceShelfDirection: 'stUnknown',
      enabled: true,
    });
    expect(filter.coefficients).toBeUndefined();
  }
});

it('retains actual native Unknown enums and exact cache vectors through JSON and exact native-folder sidecars', () => {
  for (const state of [nativeGraphQStates[6], nativeGraphQStates[8], nativeGraphQStates[9]]) {
    const project = reconstruction(state),
      before = structuredClone(project),
      files = projectFiles(project);
    for (const reopened of [
      parseProject(JSON.stringify(project)),
      importProjectFolder(files),
      importProjectFolder(files.filter((file) => file.path !== 'FusionProject.json')),
    ]) {
      const filter = reopened.presets[0].channels[0].filters[0];
      expect(filter).toMatchObject({
        kind: state.kind,
        sourceShelfDirection: 'stUnknown',
        coefficients: literalCoefficients(state),
      });
    }
    expect(project).toEqual(before);
  }
});
