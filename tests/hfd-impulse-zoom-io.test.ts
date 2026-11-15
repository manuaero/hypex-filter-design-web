// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { HFD_TEMPLATE } from '../src/domain/hfd-template';
import {
  exportHfd,
  hfdImpulseZoomSchema,
  importHfd as readHfd,
  parseProject,
  projectSchema,
} from '../src/domain/files';
import { newProject, type HfdImpulseZoom } from '../src/domain/model';
import { importProjectFolder, projectFiles } from '../src/domain/project-io';

const importHfd = (xml: string, name = 'Synthetic zoom fixture') => readHfd(xml, name);

const tags = ['zoomleft', 'zoomright', 'zoomtop', 'zoombottom', 'zoomuse'] as const;
const defaults: HfdImpulseZoom = { left: -1, right: -1, top: -1, bottom: -1, use: false };
const parseXml = (text: string) => new DOMParser().parseFromString(text, 'application/xml');
const serialize = (doc: Document) => new XMLSerializer().serializeToString(doc);
const impulse = (doc: Document, preset = 1, group = 1) =>
  doc.querySelector(
    `device > preset[index="${preset}"] > processobj[processtype="ptImpulse"][groupid="${group}"]`,
  )!;
function set(node: Element, tag: string, value: string) {
  let field = node.querySelector(`:scope > ${tag}`);
  if (!field) {
    field = node.ownerDocument.createElement(tag);
    node.appendChild(field);
  }
  field.setAttribute('value', value);
}
function stripZoom(doc: Document) {
  doc.querySelectorAll(tags.join(',')).forEach((field) => field.remove());
  return doc;
}
const rawZoom = (preset: number, group: number): HfdImpulseZoom => ({
  left: -(preset + group / 10) / 1000,
  right: (preset * 10 + group) / 1000,
  top: preset * 100 + group / 10,
  bottom: -preset * 50 - group / 10,
  use: (preset + group) % 2 === 0,
});
const zooms = (project: ReturnType<typeof newProject>) =>
  project.presets.map((preset) => preset.channels.map((channel) => channel.hfdImpulseZoom));

describe('raw optional native Impulse zoom persistence', () => {
  it('keeps marker-free browser JSON unchanged', () => {
    const project = newProject('No native view metadata');
    expect(parseProject(JSON.stringify(project))).toEqual(project);
    expect(
      project.presets.every((p) => p.channels.every((c) => !Object.hasOwn(c, 'hfdImpulseZoom'))),
    ).toBe(true);
  });

  it('round-trips nine independent preset/group zooms through JSON without data or native analysis activation', () => {
    const project = newProject('Independent raw view metadata');
    project.presets.forEach((preset, p) =>
      preset.channels.forEach((channel, c) => {
        channel.hfdImpulseZoom = rawZoom(p + 1, c + 1);
      }),
    );
    const restored = parseProject(JSON.stringify(project));
    expect(restored).toEqual(project);
    restored.presets[0].channels[0].hfdImpulseZoom!.left = 123;
    expect(project.presets[0].channels[0].hfdImpulseZoom!.left).toBe(rawZoom(1, 1).left);
    expect(
      restored.presets.every((p) =>
        p.channels.every((c) => c.hfdMeasurement === undefined && c.measurement === undefined),
      ),
    ).toBe(true);
  });

  it('imports and exports all nine native groups in exact seconds and raw amplitudes while unloaded', () => {
    const doc = parseXml(HFD_TEMPLATE);
    for (let p = 1; p <= 3; p++)
      for (let g = 1; g <= 3; g++) {
        const options = impulse(doc, p, g).querySelector(':scope > options')!;
        const value = rawZoom(p, g);
        for (const [key, number] of Object.entries(value))
          set(options, `zoom${key}`, String(number));
      }
    const project = importHfd(serialize(doc), 'Raw native axes');
    expect(zooms(project)).toEqual([1, 2, 3].map((p) => [1, 2, 3].map((g) => rawZoom(p, g))));
    expect(project.presets.every((p) => p.channels.every((c) => c.measurement === undefined))).toBe(
      true,
    );
    const roundTrip = importHfd(exportHfd(project), 'Saved raw axes');
    expect(zooms(roundTrip)).toEqual(zooms(project));
    expect(roundTrip.presets[2].channels[1].hfdImpulseZoom!.right).toBe(0.032);
  });

  it('does not synthesize a marker when all zoom tags or the whole options node are absent', () => {
    const doc = stripZoom(parseXml(HFD_TEMPLATE));
    impulse(doc, 2, 3).querySelector(':scope > options')!.remove();
    const project = importHfd(serialize(doc));
    expect(zooms(project)).toEqual(
      Array.from({ length: 3 }, () => [undefined, undefined, undefined]),
    );
    const saved = parseXml(exportHfd(project));
    expect(saved.querySelectorAll(tags.join(',')).length).toBe(0);
    // Native imports already create analysis options independently of zoom.
    expect(project.presets[1].channels[2].hfdMeasurement).toBeDefined();
  });

  it.each([
    ['zoomleft', '.00125', { left: 0.00125 }],
    ['zoomright', '-2e-3', { right: -0.002 }],
    ['zoomtop', '3.25', { top: 3.25 }],
    ['zoombottom', '-8.5', { bottom: -8.5 }],
    ['zoomuse', 'true', { use: true }],
    ['zoomuse', 'false', { use: false }],
  ])('adds native defaults only for missing siblings of explicit %s', (tag, value, expected) => {
    const doc = stripZoom(parseXml(HFD_TEMPLATE));
    set(impulse(doc).querySelector(':scope > options')!, tag, value);
    const project = importHfd(serialize(doc));
    expect(project.presets[0].channels[0].hfdImpulseZoom).toEqual({ ...defaults, ...expected });
    expect(project.presets[0].channels[1].hfdImpulseZoom).toBeUndefined();
  });

  it.each([
    { ...defaults },
    { left: 0.01, right: 0.02, top: 2, bottom: -2, use: false },
    { left: 4, right: -3, top: -9, bottom: 10, use: true },
    { left: 0, right: 0, top: 0, bottom: 0, use: true },
  ])(
    'preserves inactive, sentinel and invalid-axis raw metadata without viewport normalization: %j',
    (zoom) => {
      expect(hfdImpulseZoomSchema.parse(zoom)).toEqual(zoom);
      const project = newProject();
      project.presets[0].channels[0].hfdImpulseZoom = zoom;
      expect(parseProject(JSON.stringify(project)).presets[0].channels[0].hfdImpulseZoom).toEqual(
        zoom,
      );
      expect(importHfd(exportHfd(project)).presets[0].channels[0].hfdImpulseZoom).toEqual(zoom);
    },
  );

  it('creates only zoom options on direct export when a legacy source has no options node', () => {
    const doc = stripZoom(parseXml(HFD_TEMPLATE));
    impulse(doc).querySelector(':scope > options')!.remove();
    const project = newProject('Legacy browser source');
    project.sourceXml = serialize(doc);
    project.presets[0].channels[0].hfdImpulseZoom = rawZoom(1, 1);
    const before = structuredClone(project),
      saved = parseXml(exportHfd(project));
    expect(
      Array.from(impulse(saved).querySelector(':scope > options')!.children).map(
        (node) => node.tagName,
      ),
    ).toEqual(tags);
    expect(project).toEqual(before);
    expect(project.presets[0].channels[0].hfdMeasurement).toBeUndefined();
  });

  it('leaves source XML zoom fields untouched when an old browser JSON has no typed marker', () => {
    const doc = parseXml(HFD_TEMPLATE),
      options = impulse(doc).querySelector(':scope > options')!;
    set(options, 'zoomleft', '-.0123456789');
    set(options, 'zoomuse', 'true');
    const project = newProject();
    project.sourceXml = serialize(doc);
    const saved = parseXml(exportHfd(parseProject(JSON.stringify(project))));
    expect(impulse(saved).querySelector('options > zoomleft')!.getAttribute('value')).toBe(
      '-.0123456789',
    );
    expect(impulse(saved).querySelector('options > zoomuse')!.getAttribute('value')).toBe('true');
    expect(project.presets[0].channels[0].hfdImpulseZoom).toBeUndefined();
  });

  it('preserves unrelated native options and other groups on an explicit view edit', () => {
    const doc = parseXml(HFD_TEMPLATE),
      options = impulse(doc).querySelector(':scope > options')!;
    set(options, 'vendor-option', 'unchanged');
    set(options, 'anechstart', '123');
    const project = importHfd(serialize(doc)),
      oldOptions = structuredClone(project.presets[0].channels[0].hfdMeasurement);
    project.presets[0].channels[0].hfdImpulseZoom = rawZoom(2, 3);
    const saved = parseXml(exportHfd(project));
    expect(impulse(saved).querySelector('options > vendor-option')!.getAttribute('value')).toBe(
      'unchanged',
    );
    expect(impulse(saved).querySelector('options > anechstart')!.getAttribute('value')).toBe('123');
    expect(project.presets[0].channels[0].hfdMeasurement).toEqual(oldOptions);
    expect(importHfd(serialize(saved)).presets[0].channels[1].hfdImpulseZoom).toEqual(defaults);
  });

  it('retains zoom through exact sidecar and native-only folders, including an unloaded reference', () => {
    const project = newProject('Raw axes folder');
    project.presets[2].channels[1].measurement = { name: 'not-loaded.dat', sampleRate: 48000 };
    project.presets.forEach((preset, p) =>
      preset.channels.forEach((channel, c) => (channel.hfdImpulseZoom = rawZoom(p + 1, c + 1))),
    );
    const files = projectFiles(project),
      exact = importProjectFolder(files),
      native = importProjectFolder(files.filter((file) => file.path !== 'FusionProject.json'));
    expect(zooms(exact)).toEqual(zooms(project));
    expect(zooms(native)).toEqual(zooms(project));
    expect(exact.presets[2].channels[1].measurement).toEqual(
      project.presets[2].channels[1].measurement,
    );
    expect(exact.presets[2].channels[1].hfdMeasurement).toBeUndefined();
    expect(native.presets[2].channels[1].measurement!.impulse).toBeUndefined();
  });

  it.each(['', ' ', 'NaN', 'Infinity', '-Infinity', '1,2', '0x10', 'bad', '1e999'])(
    'rejects malformed numeric XML value %j',
    (value) => {
      const doc = parseXml(HFD_TEMPLATE);
      set(impulse(doc).querySelector(':scope > options')!, 'zoomleft', value);
      expect(() => importHfd(serialize(doc))).toThrow('Invalid HFD zoomleft');
    },
  );
  it.each(['', 'True', '1', ' false ', 'bad'])(
    'rejects malformed zoomuse XML value %j',
    (value) => {
      const doc = parseXml(HFD_TEMPLATE);
      set(impulse(doc).querySelector(':scope > options')!, 'zoomuse', value);
      expect(() => importHfd(serialize(doc))).toThrow('Invalid HFD zoomuse');
    },
  );
  it.each(tags)('rejects duplicate or missing-value %s', (tag) => {
    const doc = parseXml(HFD_TEMPLATE),
      options = impulse(doc).querySelector(':scope > options')!;
    options.appendChild(options.querySelector(tag)!.cloneNode(true));
    expect(() => importHfd(serialize(doc))).toThrow(`Duplicate HFD ${tag}`);
    options.querySelectorAll(tag)[1].remove();
    options.querySelector(tag)!.removeAttribute('value');
    expect(() => importHfd(serialize(doc))).toThrow(`Invalid HFD ${tag}`);
  });
  it.each([
    { ...defaults, left: Infinity },
    { ...defaults, top: NaN },
    { ...defaults, right: '1' },
    { ...defaults, use: 1 },
    { ...defaults, units: 'ms' },
    { left: 1, use: false },
  ])('rejects malformed typed marker on project load and direct export: %j', (zoom) => {
    const project = newProject();
    Object.assign(project.presets[0].channels[0], { hfdImpulseZoom: zoom });
    expect(projectSchema.safeParse(project).success).toBe(false);
    expect(() => parseProject(JSON.stringify(project))).toThrow();
    expect(() => exportHfd(project)).toThrow();
  });
});
