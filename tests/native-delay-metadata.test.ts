// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { exportHfd, importHfd, parseProject } from '../src/domain/files';
import { HFD_TEMPLATE } from '../src/domain/hfd-template';
import { newProject, type Project } from '../src/domain/model';
import { importProjectFolder, projectFiles } from '../src/domain/project-io';
import { validNativeCacheWitness } from '../src/domain/native-cache';

const document = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');
const serialize = (doc: Document) => new XMLSerializer().serializeToString(doc);
function delay(doc: Document, preset = 1, channel = 1, global = false) {
  return Array.from(
    doc.querySelectorAll(
      `preset[index="${preset}"] > processobj[processtype="ptDelay"][groupid="${channel}"]`,
    ),
  ).find(
    (node) => node.querySelector(':scope > global')?.getAttribute('value') === String(global),
  )!;
}
function maximum(doc: Document, preset = 1, channel = 1, global = false) {
  return delay(doc, preset, channel, global).querySelector(':scope > maxdelay');
}
function xmlWithMaxima(local: string | null, global: string | null) {
  // Synthetic template reconstruction, never complete user/native project XML.
  const doc = document(HFD_TEMPLATE);
  for (const [isGlobal, value] of [
    [false, local],
    [true, global],
  ] as const) {
    const node = maximum(doc, 1, 1, isGlobal)!;
    if (value === null) node.remove();
    else node.setAttribute('value', value);
  }
  return serialize(doc);
}

it('passively retains each channel and preset maximum without normalizing delays or cache data', () => {
  const doc = document(HFD_TEMPLATE);
  for (let p = 1; p <= 3; p++)
    for (let c = 1; c <= 3; c++) {
      maximum(doc, p, c)!.setAttribute('value', String(p * 100 + c + 0.125));
      maximum(doc, p, c, true)!.setAttribute('value', String(p * 1000 + c + 0.5));
      delay(doc, p, c)
        .querySelector(':scope > delay')!
        .setAttribute('value', String(c + 0.25));
      delay(doc, p, c, true)
        .querySelector(':scope > delay')!
        .setAttribute('value', String(c * 17));
    }
  const xml = serialize(doc),
    project = importHfd(xml, 'Independent maxima');
  expect(project.sourceXml).toBe(xml);
  for (let p = 0; p < 3; p++)
    for (let c = 0; c < 3; c++) {
      const channel = project.presets[p].channels[c];
      expect(channel.hfdDelay).toEqual({
        localMaximum: (p + 1) * 100 + c + 1 + 0.125,
        globalMaximum: (p + 1) * 1000 + c + 1 + 0.5,
      });
      expect(channel.delayUs).toBe(c + 1 + 0.25);
      expect(channel.globalDelayUs).toBe((c + 1) * 17);
      expect(validNativeCacheWitness(channel)).toBeDefined();
    }
});

it('retains native Global74667 above its fractional maximum through XML and JSON without a clamp', () => {
  // Native B07 Config SHA91610949f8a72a4cbfde3bee91847201120d95282b4b3bd93fa026d42485db38.
  // Only independently saved numeric literals are reconstructed here.
  const doc = document(xmlWithMaxima('19200', '74666.6666666667'));
  for (let c = 1; c <= 3; c++)
    delay(doc, 1, c, true).querySelector(':scope > delay')!.setAttribute('value', '74667');
  const xml = serialize(doc),
    project = importHfd(xml, 'Native upper literals'),
    before = structuredClone(project);
  for (const reopened of [
    project,
    parseProject(JSON.stringify(project)),
    importHfd(exportHfd(project), 'Upper reopened'),
  ]) {
    for (const channel of reopened.presets[0].channels) {
      expect(channel.globalDelayUs).toBe(74667);
      expect(channel.hfdDelay?.globalMaximum).toBe(Number('74666.6666666667'));
      expect(channel.globalDelayUs).toBeGreaterThan(channel.hfdDelay!.globalMaximum!);
    }
  }
  expect(project).toEqual(before);
  expect(project.sourceXml).toBe(xml);
});

it('keeps missing maxima absent and retains partial metadata without inventing defaults', () => {
  const none = importHfd(xmlWithMaxima(null, null), 'Missing maxima');
  expect(none.presets[0].channels[0].hfdDelay).toBeUndefined();
  const partial = importHfd(xmlWithMaxima(null, '70000.125'), 'Partial maxima');
  expect(partial.presets[0].channels[0].hfdDelay).toEqual({ globalMaximum: 70000.125 });
  const reopened = document(exportHfd(partial));
  expect(maximum(reopened)).toBeNull();
  expect(maximum(reopened, 1, 1, true)?.getAttribute('value')).toBe('70000.125');
  expect(
    newProject()
      .presets.flatMap((p) => p.channels)
      .every((c) => c.hfdDelay === undefined),
  ).toBe(true);
});

it('writes only the explicit matching maximum while preserving caches, source XML and peer metadata', () => {
  const project = importHfd(xmlWithMaxima('19', '7.46666666666667e4'), 'Explicit maximum');
  const originalSource = project.sourceXml,
    beforeXml = exportHfd(project),
    before = structuredClone(project);
  project.presets[0].channels[0].hfdDelay!.localMaximum = 19200;
  const afterXml = exportHfd(project);
  const eraseLocalMaximum = (xml: string) => {
    const doc = document(xml);
    maximum(doc)!.remove();
    return serialize(doc);
  };
  expect(maximum(document(afterXml))?.getAttribute('value')).toBe('19200');
  expect(eraseLocalMaximum(afterXml)).toBe(eraseLocalMaximum(beforeXml));
  expect(project.sourceXml).toBe(originalSource);
  expect(validNativeCacheWitness(project.presets[0].channels[0])).toBeDefined();
  const expected = structuredClone(before);
  expected.presets[0].channels[0].hfdDelay!.localMaximum = 19200;
  expect(project).toEqual(expected);
});

it('preserves raw legacy maximum literals when optional metadata is absent or its member is absent', () => {
  const project = importHfd(xmlWithMaxima('1.9000e1', '7.46666666666667e4'), 'Legacy maxima');
  delete project.presets[0].channels[0].hfdDelay;
  const legacy = parseProject(JSON.stringify(project));
  expect(legacy.presets[0].channels[0].hfdDelay).toBeUndefined();
  const xml = document(exportHfd(legacy));
  expect(maximum(xml)?.getAttribute('value')).toBe('1.9000e1');
  expect(maximum(xml, 1, 1, true)?.getAttribute('value')).toBe('7.46666666666667e4');
  legacy.presets[0].channels[0].hfdDelay = { globalMaximum: 1234.5 };
  const partial = document(exportHfd(legacy));
  expect(maximum(partial)?.getAttribute('value')).toBe('1.9000e1');
  expect(maximum(partial, 1, 1, true)?.getAttribute('value')).toBe('1234.5');
});

it('creates a missing maximum only for an explicit typed member on an existing Delay process', () => {
  const project = importHfd(xmlWithMaxima(null, null), 'Explicit absent field');
  project.presets[0].channels[0].hfdDelay = { localMaximum: 21.25 };
  const doc = document(exportHfd(project));
  expect(maximum(doc)?.getAttribute('value')).toBe('21.25');
  expect(maximum(doc, 1, 1, true)).toBeNull();
});

it('retains maximum metadata through JSON and bound folder sidecars without changing processing', () => {
  const project = importHfd(xmlWithMaxima('19200', '74666.6666666667'), 'Maximum persistence');
  project.presets[0].channels[0].globalDelayUs = 74667;
  expect(project.presets[0].channels[0].hfdDelay).toEqual({
    localMaximum: 19200,
    globalMaximum: Number('74666.6666666667'),
  });
  const before = structuredClone(project);
  for (const reopened of [
    parseProject(JSON.stringify(project)),
    importProjectFolder(projectFiles(project)),
  ]) {
    expect(reopened.presets[0].channels[0].hfdDelay).toEqual(
      project.presets[0].channels[0].hfdDelay,
    );
    expect(reopened.presets[0].channels[0].globalDelayUs).toBe(74667);
    expect(reopened.presets[0].channels[0].filters).toEqual(project.presets[0].channels[0].filters);
  }
  expect(project).toEqual(before);
});

it('preserves finite metadata without treating the stored maximum as a new authoring range or unit', () => {
  for (const text of ['0', '-1.25', '1e6', '.125']) {
    const project = importHfd(xmlWithMaxima(text, null), 'Raw maximum Double');
    expect(project.presets[0].channels[0].hfdDelay).toEqual({ localMaximum: Number(text) });
    expect(importHfd(exportHfd(project), 'Raw reopened').presets[0].channels[0].hfdDelay).toEqual({
      localMaximum: Number(text),
    });
  }
});

it('rejects malformed, duplicate and missing-value native maxima rather than coercing them to zero', () => {
  for (const value of ['', ' ', 'NaN', 'Infinity', '-Infinity', '1e999', '0x10', '19tail'])
    expect(() => importHfd(xmlWithMaxima(value, null), 'Invalid maximum')).toThrow(/maxdelay/i);
  const missing = document(xmlWithMaxima('19', null));
  maximum(missing)!.removeAttribute('value');
  expect(() => importHfd(serialize(missing), 'Missing value')).toThrow(/maxdelay/i);
  const duplicate = document(xmlWithMaxima('19', null));
  delay(duplicate).appendChild(maximum(duplicate)!.cloneNode(true));
  expect(() => importHfd(serialize(duplicate), 'Duplicate maximum')).toThrow(/maxdelay/i);
});

it('strictly validates optional finite snapshot and direct-export maximum metadata', () => {
  for (const value of [
    null,
    [],
    19,
    { localMaximum: '19' },
    { globalMaximum: null },
    { maximum: 19 },
  ]) {
    const project = newProject();
    Object.assign(project.presets[0].channels[0], { hfdDelay: value });
    expect(() => parseProject(JSON.stringify(project))).toThrow();
    expect(() => exportHfd(project as Project)).toThrow();
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    const project = newProject();
    project.presets[0].channels[0].hfdDelay = { localMaximum: value };
    expect(() => exportHfd(project)).toThrow();
    expect(() => parseProject(JSON.stringify(project))).toThrow();
  }
  const empty = newProject();
  empty.presets[0].channels[0].hfdDelay = {};
  expect(parseProject(JSON.stringify(empty)).presets[0].channels[0].hfdDelay).toEqual({});
});
