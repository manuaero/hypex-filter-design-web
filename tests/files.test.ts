// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { HFD_TEMPLATE } from '../src/domain/hfd-template';
import { importHfd, exportHfd, resolveGainCache } from '../src/domain/files';
import { newProject, newFilter } from '../src/domain/model';
import { effectiveSections, encodeChannel, design } from '../src/domain/dsp';
import manualNative from './fixtures/hfd-gui-manual-filter-coefficients.json';
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
    // For AsymShelf F1/Q1 are zeros, F2/Q2 are poles. Shelf2 retains
    // the latent second pair but must use its own kind and signed gain.
    expect(filter).toMatchObject({
      kind: fixture.kind,
      frequency: fixture.kind === 'asymmetric' ? 800 : 1500,
      q: fixture.kind === 'asymmetric' ? 0.7 : 0.65,
      frequency2: 400,
      q2: 1.3,
      gain: Number(fixture.parameters.gain),
      enabled: true,
      shelfDirection: fixture.direction,
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
  },
);

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
