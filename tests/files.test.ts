// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { HFD_TEMPLATE } from '../src/domain/hfd-template';
import { importHfd, exportHfd, resolveGainCache } from '../src/domain/files';
import { newProject, newFilter } from '../src/domain/model';
import {
  effectiveSections,
  encodeChannel,
  design,
  channelResponse,
  response,
} from '../src/domain/dsp';
import { filterMarkerAnchor, selectedSectionResponse } from '../src/domain/plot-layers';
import manualNative from './fixtures/hfd-gui-manual-filter-coefficients.json';
import nativeLifecycle from './fixtures/hfd-gui-v37-filter-lifecycle.json';
const document = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');
const serialize = (doc: Document) => new XMLSerializer().serializeToString(doc);

// Only native semantic parameters and saved literals are retained in this
// fixture; the original complete project and machine paths remain private.
it.each(manualNative.cases)(
  'imports and regenerates screenshot-operated HFD $name with exact native field mapping',
  (fixture) => {
    const doc = document(HFD_TEMPLATE),
      node = doc.querySelector(
        'preset[index="1"] processobj[processtype="ptBiQuad"][groupid="1"]',
      )!;
    node.setAttribute('enabled', 'true');
    for (const [key, value] of Object.entries({
      ...fixture.parameters,
      ...fixture.coefficients,
    }))
      node.querySelector(`:scope > ${key}`)!.setAttribute('value', value);
    const project = importHfd(serialize(doc), 'Native manual filter fixture'),
      channel = project.presets[0].channels[0],
      filter = channel.filters[0],
      native = {
        b0: Number(fixture.coefficients.b0),
        b1: Number(fixture.coefficients.b1),
        b2: Number(fixture.coefficients.b2),
        f1: Number(fixture.coefficients.a1),
        f2: Number(fixture.coefficients.a2),
      };
    // For AsymShelf F1/Q1 are zeros, F2/Q2 are poles. Other native types
    // can retain a latent secondary pair and an inactive Unknown shelf mode.
    expect(filter).toMatchObject({
      kind: fixture.kind,
      frequency: Number(fixture.parameters.f1),
      q: Number(fixture.parameters.q1),
      frequency2: Number(fixture.parameters.f2),
      q2: Number(fixture.parameters.q2),
      gain: Number(fixture.parameters.gain),
      enabled: true,
      ...(fixture.parameters.shelfhl === 'stLowShelf'
        ? { shelfDirection: 'low' }
        : fixture.parameters.shelfhl === 'stHighShelf'
          ? { shelfDirection: 'high' }
          : {}),
    });
    expect(channel.gain).toBe(0);
    expect(channel.additionalGain ?? 0).toBe(0);
    expect(channel.invert).toBe(false);
    expect(filter.coefficients).toEqual(native);

    // Remove the imported coefficient cache so this exercises parameter design
    // as well as exact native-cache import. Expected values are native literals.
    const rebuiltChannel = structuredClone(channel);
    delete rebuiltChannel.filters[0].coefficients;
    delete rebuiltChannel.filters[0].provenance;
    const regenerated = design(rebuiltChannel.filters[0]);
    for (const key of ['b0', 'b1', 'b2', 'f1', 'f2'] as const)
      expect(Math.abs(regenerated[key] - native[key])).toBeLessThan(1e-12);

    // Five signed wire words begin after the delay word, in b2,b1,b0,a2,a1
    // order. These fixed words encode the native literals, not model output.
    for (const candidate of [channel, rebuiltChannel]) {
      const bytes = encodeChannel(candidate),
        view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(Array.from({ length: 5 }, (_, i) => view.getInt32(4 + i * 4, true))).toEqual(
        fixture.q24WireWords,
      );
    }
    if ('nativeLiteralMarker' in fixture)
      expect(filterMarkerAnchor(filter)).toEqual(fixture.nativeLiteralMarker);
  },
);

function importNativeLifecycle(
  fixture: (typeof nativeLifecycle.states)[number],
  configuration?: { gain?: string; additionalGain?: string; invert?: boolean },
) {
  const doc = document(HFD_TEMPLATE),
    node = doc.querySelector('preset[index="1"] processobj[processtype="ptBiQuad"][groupid="1"]')!;
  node.setAttribute('enabled', String(fixture.enabled));
  for (const [key, value] of Object.entries({ ...fixture.parameters, ...fixture.coefficients }))
    node.querySelector(`:scope > ${key}`)!.setAttribute('value', value);
  const gainNode = doc.querySelector(
    'preset[index="1"] processobj[processtype="ptGain"][groupid="1"]',
  )!;
  if (configuration?.gain !== undefined)
    gainNode.querySelector('gain')!.setAttribute('value', configuration.gain);
  if (configuration?.additionalGain !== undefined)
    gainNode.querySelector('additionalgain')!.setAttribute('value', configuration.additionalGain);
  if (configuration?.invert !== undefined)
    gainNode.querySelector('invert')!.setAttribute('value', String(configuration.invert));
  return importHfd(serialize(doc), 'Native filter lifecycle');
}

it('retains native enable, Delete and fresh-Add state through parsing, compilation and XML export', () => {
  for (const fixture of nativeLifecycle.states) {
    const project = importNativeLifecycle(fixture),
      channel = project.presets[0].channels[0],
      filter = channel.filters[0],
      native = {
        b0: Number(fixture.coefficients.b0),
        b1: Number(fixture.coefficients.b1),
        b2: Number(fixture.coefficients.b2),
        f1: Number(fixture.coefficients.a1),
        f2: Number(fixture.coefficients.a2),
      },
      retained = {
        sourceId: '13',
        kind: fixture.kind,
        enabled: fixture.enabled,
        frequency: Number(fixture.parameters.f1),
        frequency2: Number(fixture.parameters.f2),
        q: Number(fixture.parameters.q1),
        q2: Number(fixture.parameters.q2),
        gain: Number(fixture.parameters.gain),
        coefficients: native,
      };
    // Native Delete is an enabled Unity slot retaining its latent parameters.
    // Disabled LP2 keeps designed coefficients; active compilation bypasses it.
    expect(filter, fixture.state).toMatchObject(retained);
    expect(channel.coefficientCache).toBe('base');
    const bytes = encodeChannel(channel),
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(Array.from({ length: 5 }, (_, i) => view.getInt32(4 + i * 4, true))).toEqual(
      fixture.activeQ24WireWords,
    );
    const reopened = importHfd(exportHfd(project), 'Reopened native lifecycle');
    expect(reopened.presets[0].channels[0].filters[0], fixture.state).toMatchObject(retained);
  }
});

it('keeps disabled-section analysis and fresh native zero-Peak caches distinct from channel processing', () => {
  const disabled = nativeLifecycle.states.find((fixture) => fixture.state === 'disabled LP2')!,
    project = importNativeLifecycle(disabled),
    channel = project.presets[0].channels[0],
    filter = channel.filters[0],
    before = structuredClone(project),
    selected = selectedSectionResponse(filter, 720);
  expect(20 * Math.log10(Math.hypot(...selected))).toBeCloseTo(disabled.marker.doubleDb, 10);
  expect(filterMarkerAnchor(filter)).toEqual({
    frequency: disabled.marker.frequency,
    db: disabled.marker.db,
  });
  expect(channelResponse(channel, 720)).toEqual([1, 0]);
  expect(project).toEqual(before);

  const fresh = nativeLifecycle.states.find(
      (fixture) => fixture.state === 'freshly added zero-gain Peak',
    )!,
    added = importNativeLifecycle(fresh).presets[0].channels[0].filters[0],
    originalCache = design(added),
    rebuilt = structuredClone(added);
  delete rebuilt.coefficients;
  delete rebuilt.provenance;
  const regenerated = design(rebuilt);
  // Actual native Add saved Unity directly. An explicitly regenerated zero-gain
  // Peak has cancelling poles/zeros instead; preserve the imported cache while
  // testing equal transfer, rather than forcing false coefficient identity.
  expect(originalCache).toEqual({ b0: 1, b1: 0, b2: 0, f1: 0, f2: 0 });
  expect(regenerated).not.toEqual(originalCache);
  for (const frequency of [20, fresh.marker.frequency, 720, 2000, 20000]) {
    const [real, imaginary] = response(regenerated, frequency);
    expect(real).toBeCloseTo(1, 11);
    expect(imaginary).toBeCloseTo(0, 11);
  }
  expect(added.coefficients).toEqual(originalCache);
});

it('keeps genuine non-unit, inverted and near-unit native cache ambiguity guarded', () => {
  const fresh = nativeLifecycle.states.find(
    (fixture) => fixture.state === 'freshly added zero-gain Peak',
  )!;
  for (const configuration of [
    { gain: '-6' },
    { invert: true },
    { gain: '0.00000000001' },
    { additionalGain: '-0.00000000001' },
  ]) {
    const project = importNativeLifecycle(fresh, configuration),
      channel = project.presets[0].channels[0];
    expect(channel.coefficientCache, JSON.stringify(configuration)).toBe('unresolved');
    expect(channel.filters[0].coefficients).toEqual({
      b0: 1,
      b1: 0,
      b2: 0,
      f1: 0,
      f2: 0,
    });
    expect(() => encodeChannel(channel)).toThrow('Resolve');
    // XML design export is distinct from hardware compilation; the existing
    // unresolved-upload guard must remain on encodeChannel, not a new file gate.
    expect(
      10 ** ((channel.gain + (channel.additionalGain ?? 0)) / 20) * (channel.invert ? -1 : 1),
    ).not.toBe(1);
  }
});

it('accepts HFD’s screenshot-created offline FA503 and rejects other offline models', () => {
  const p = importHfd(HFD_TEMPLATE, 'Blank');
  expect(p.presets).toHaveLength(3);
  expect(p.presets[0].channels[0].filters).toHaveLength(15);
  const doc = document(HFD_TEMPLATE);
  doc.querySelector('device')!.setAttribute('fusionamp', '8');
  expect(() => importHfd(serialize(doc), 'Wrong model')).toThrow('FA503');
});
it('detects base and gain-effective first-section caches without double gain', () => {
  const doc = document(HFD_TEMPLATE),
    gain = doc.querySelector(
      'preset[index="1"] processobj[processtype="ptGain"][groupid="1"] gain',
    )!,
    b = doc.querySelector('preset[index="1"] processobj[processtype="ptBiQuad"][groupid="1"] b0')!;
  gain.setAttribute('value', '-6');
  const base = importHfd(serialize(doc), 'Base');
  expect(base.presets[0].channels[0].coefficientCache).toBe('base');
  expect(effectiveSections(base.presets[0].channels[0])[0].b0).toBeCloseTo(10 ** (-6 / 20), 12);
  b.setAttribute('value', String(10 ** (-6 / 20)));
  const effective = importHfd(serialize(doc), 'Effective');
  expect(effective.presets[0].channels[0].coefficientCache).toBe('effective');
  expect(encodeChannel(effective.presets[0].channels[0])).toEqual(
    encodeChannel(base.presets[0].channels[0]),
  );
});
it.each(['ftBoostCut', 'ftFree'])(
  'retains original first-section Double coefficients with AdditionalGain for %s',
  (filterType) => {
    // Actual V40 native save22: the original b1 loses one ULP if reconstructed
    // by dividing and multiplying by the AdditionalGain10 multiplier.
    const doc = document(HFD_TEMPLATE),
      node = doc.querySelector(
        'preset[index="1"] processobj[processtype="ptBiQuad"][groupid="1"]',
      )!,
      gainNode = doc.querySelector(
        'preset[index="1"] processobj[processtype="ptGain"][groupid="1"]',
      )!,
      literals = {
        b0: '1.28734873744321',
        b1: '-1.92017414830364',
        b2: '0.655018836373937',
        a1: '1.85236017184606',
        a2: '-0.874553956539528',
      },
      native = {
        b0: Number(literals.b0),
        b1: Number(literals.b1),
        b2: Number(literals.b2),
        f1: Number(literals.a1),
        f2: Number(literals.a2),
      };
    gainNode.querySelector('additionalgain')!.setAttribute('value', '10');
    node.setAttribute('enabled', 'true');
    for (const [name, value] of Object.entries({
      filtertype: filterType,
      f1: '2300',
      q1: '1.15',
      gain: '14.05',
      ...literals,
    }))
      node.querySelector(`:scope > ${name}`)!.setAttribute('value', value);
    const project = importHfd(serialize(doc), 'Native AdditionalGain cache'),
      channel = project.presets[0].channels[0];
    expect((native.b1 / 10 ** (10 / 20)) * 10 ** (10 / 20)).not.toBe(native.b1);
    expect(channel.filters[0].coefficients).toEqual(native);
    expect(channel.coefficientCache).toBe(filterType === 'ftFree' ? 'unresolved' : 'base');
    if (filterType === 'ftFree') expect(() => encodeChannel(channel)).toThrow('Resolve');
    const reopened = importHfd(exportHfd(project), 'Reopened AdditionalGain cache');
    expect(reopened.presets[0].channels[0].filters[0].coefficients).toEqual(native);
  },
);
it('requires a decision for inconsistent/custom first coefficients before compiling', () => {
  const doc = document(HFD_TEMPLATE);
  doc.querySelector('preset processobj[processtype="ptGain"] gain')!.setAttribute('value', '-6');
  doc.querySelector('preset processobj[processtype="ptBiQuad"] b0')!.setAttribute('value', '.25');
  doc.querySelector('preset processobj[processtype="ptBiQuad"]')!.setAttribute('enabled', 'true');
  doc
    .querySelector('preset processobj[processtype="ptBiQuad"] filtertype')!
    .setAttribute('value', 'ftFree');
  const c = importHfd(serialize(doc), 'Custom').presets[0].channels[0];
  expect(c.coefficientCache).toBe('unresolved');
  expect(() => encodeChannel(c)).toThrow('Resolve');
  resolveGainCache(c, 'effective');
  expect(effectiveSections(c)[0].b0).toBeCloseTo(0.25, 12);
});
it('exports new designs and preserves reordered filters, gain, delay, EQ and FIR', () => {
  const p = newProject('New design'),
    pr = p.presets[0],
    c = pr.channels[0];
  c.gain = -6;
  c.delayUs = 32;
  c.outputName = 'Bass output';
  c.filters[0] = { ...newFilter('highpass2'), frequency: 50 };
  c.filters[1] = { ...newFilter('peak'), frequency: 200, gain: -3 };
  [c.filters[0], c.filters[1]] = [c.filters[1], c.filters[0]];
  pr.eqEnabled = true;
  pr.inputEq[0].gain = -2;
  pr.inputEq[0].enabled = true;
  pr.firPlacement = 'output';
  c.fir = {
    name: 'fir.txt',
    enabled: true,
    taps: Array.from({ length: 1500 }, (_, i) => (i === 4 ? 1 : 0)),
  };
  const output = exportHfd(p),
    round = importHfd(output, 'Round trip'),
    rc = round.presets[0].channels[0];
  expect(rc.filters[0].kind).toBe('peak');
  expect(rc.filters[1].kind).toBe('highpass2');
  expect(rc.gain).toBe(-6);
  expect(rc.delayUs).toBe(32);
  expect(rc.outputName).toBe('Bass output');
  expect(round.presets[0].inputEq[0].gain).toBe(-2);
  expect(round.presets[0].eqEnabled).toBe(true);
  expect(round.presets[0].firPlacement).toBe('output');
  expect(rc.fir).toEqual({ ...c.fir, hfdState: { loaded: true, used: true, tapCount: 1500 } });
  expect(encodeChannel(rc)).toEqual(encodeChannel(c));
});
it('preserves an unloaded native measurement reference and removes it after explicit clear', () => {
  const doc = document(HFD_TEMPLATE);
  const node = doc.querySelector(
    'preset[index="1"] processobj[processtype="ptImpulse"][groupid="1"]',
  )!;
  node.querySelector('filename')!.setAttribute('value', 'ExistingDriver.dat');
  const imported = importHfd(serialize(doc), 'Native reference');
  expect(imported.presets[0].channels[0].measurement?.name).toBe('ExistingDriver.dat');
  const filename = (xml: string) =>
    document(xml)
      .querySelector('preset[index="1"] processobj[processtype="ptImpulse"][groupid="1"] filename')!
      .getAttribute('value');
  expect(filename(exportHfd(imported))).toBe('ExistingDriver.dat');
  delete imported.presets[0].channels[0].measurement;
  expect(filename(exportHfd(imported))).toBe('');
});
