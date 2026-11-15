// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { HFD_TEMPLATE } from '../src/domain/hfd-template';
import { exportHfd, importHfd, parseProject } from '../src/domain/files';
import { newProject, type HfdGraphOptions } from '../src/domain/model';
import { importProjectFolder, projectFiles } from '../src/domain/project-io';
import { importChannelMeasurement } from '../src/domain/hfd-measurement';
import {
  restoreNativeGraphSelection,
  normalizeNativeGraphSelection,
  buildMagnitudeLayers,
} from '../src/domain/plot-layers';
import { sampleHfdView } from '../src/domain/hfd-response-view';
import { copyPreset } from '../src/domain/preset-copy';
import { clearPreset } from '../src/domain/editing';
import { linkChannel } from '../src/domain/links';

const parseXml = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');
const serialize = (xml: Document) => new XMLSerializer().serializeToString(xml);
const impulse = (doc: Document, preset = 1, channel = 1) =>
  doc.querySelector(
    `device > preset[index="${preset}"] > processobj[processtype="ptImpulse"][groupid="${channel}"]`,
  )!;
function setFlag(node: Element, name: string, value: string) {
  let field = node.querySelector(`:scope > ${name}`);
  if (!field) {
    field = node.ownerDocument.createElement(name);
    node.appendChild(field);
  }
  field.setAttribute('value', value);
}
const flags = (preset: number, channel: number): HfdGraphOptions => ({
  showMeasuredResponse: (preset + channel) % 2 === 0,
  showSum: (preset * channel) % 3 === 0,
});
function variedXml() {
  const doc = parseXml(HFD_TEMPLATE);
  for (let p = 1; p <= 3; p++)
    for (let c = 1; c <= 3; c++) {
      const node = impulse(doc, p, c),
        value = flags(p, c);
      setFlag(node, 'graphshowmeasuredrespons', String(value.showMeasuredResponse));
      setFlag(node, 'graphshowsum', String(value.showSum));
      setFlag(node, 'filename', '');
    }
  return serialize(doc);
}
function loadedChannels() {
  const channels = newProject().presets[0].channels;
  channels[0].hfdGraph = { showMeasuredResponse: true, showSum: false };
  channels[1].hfdGraph = { showMeasuredResponse: false, showSum: true };
  channels[2].hfdGraph = { showMeasuredResponse: true, showSum: true };
  for (let i = 0; i < 2; i++)
    channels[i].measurement = {
      name: `${i}.frd`,
      sampleRate: 48000,
      frequency: [10, 1000],
      magnitude: [0, 0],
    };
  return channels;
}

describe('optional native per-group graph persistence', () => {
  it('does not add a graph marker to new or existing marker-free JSON projects', () => {
    const project = newProject('Legacy without graph display metadata'),
      restored = parseProject(JSON.stringify(project));
    expect(restored).toEqual(project);
    expect(
      restored.presets.every((p) => p.channels.every((c) => !Object.hasOwn(c, 'hfdGraph'))),
    ).toBe(true);
  });
  it('retains distinct native true/false values for all9 channels through JSON without aliases', () => {
    const project = newProject();
    project.presets.forEach((preset, p) =>
      preset.channels.forEach((channel, c) => {
        channel.hfdGraph = flags(p + 1, c + 1);
      }),
    );
    const restored = parseProject(JSON.stringify(project));
    expect(restored).toEqual(project);
    restored.presets[0].channels[0].hfdGraph!.showSum = true;
    expect(project.presets[0].channels[0].hfdGraph!.showSum).toBe(false);
    expect(restored.presets[0].channels[1].hfdGraph).toEqual(flags(1, 2));
  });
  it.each([
    { showMeasuredResponse: true },
    { showMeasuredResponse: false, showSum: 'true' },
    { showMeasuredResponse: null, showSum: false },
    { showMeasuredResponse: false, showSum: false, otherChannels: [true, true, true] },
  ])('rejects malformed or runtime-only fields inside saved graph metadata: %j', (graph) => {
    const project = newProject();
    Object.assign(project.presets[0].channels[0], { hfdGraph: graph });
    expect(() => parseProject(JSON.stringify(project))).toThrow();
  });
  it('imports flags independently of filename/Loaded and keeps canonical values even for unavailable responses', () => {
    const project = importHfd(variedXml(), 'Native flags without DAT');
    project.presets.forEach((preset, p) =>
      preset.channels.forEach((channel, c) => {
        expect(channel.hfdGraph).toEqual(flags(p + 1, c + 1));
        expect(channel.measurement).toBeUndefined();
      }),
    );
    const restored = importHfd(exportHfd(project), 'Round trip');
    expect(restored.presets.map((p) => p.channels.map((c) => c.hfdGraph))).toEqual(
      project.presets.map((p) => p.channels.map((c) => c.hfdGraph)),
    );
  });
  it('keeps both absent XML flags absent on import/export rather than synthesizing defaults', () => {
    const doc = parseXml(HFD_TEMPLATE);
    doc.querySelectorAll('graphshowmeasuredrespons, graphshowsum').forEach((node) => node.remove());
    const project = importHfd(serialize(doc), 'Native file without optional display fields');
    expect(project.presets.every((p) => p.channels.every((c) => c.hfdGraph === undefined))).toBe(
      true,
    );
    const saved = parseXml(exportHfd(project));
    expect(saved.querySelectorAll('graphshowmeasuredrespons, graphshowsum').length).toBe(0);
    expect(project.presets.every((p) => p.channels.every((c) => c.hfdGraph === undefined))).toBe(
      true,
    );
  });
  it('uses the native false default only for a missing sibling of an explicit field', () => {
    const doc = parseXml(HFD_TEMPLATE),
      first = impulse(doc),
      second = impulse(doc, 1, 2);
    first.querySelector('graphshowsum')!.remove();
    setFlag(first, 'graphshowmeasuredrespons', 'true');
    second.querySelector('graphshowmeasuredrespons')!.remove();
    setFlag(second, 'graphshowsum', 'true');
    const project = importHfd(serialize(doc), 'Partial flags');
    expect(project.presets[0].channels[0].hfdGraph).toEqual({
      showMeasuredResponse: true,
      showSum: false,
    });
    expect(project.presets[0].channels[1].hfdGraph).toEqual({
      showMeasuredResponse: false,
      showSum: true,
    });
  });
  it.each(['True', '1', '', ' false ', 'not-a-boolean'])(
    'rejects unproven malformed native flag encoding %j',
    (value) => {
      const doc = parseXml(HFD_TEMPLATE);
      setFlag(impulse(doc), 'graphshowmeasuredrespons', value);
      expect(() => importHfd(serialize(doc), 'Invalid graph flag')).toThrow(
        /Invalid HFD graphshow/,
      );
    },
  );
  it('rejects duplicate or missing-value native flag nodes instead of silently choosing one', () => {
    const doc = parseXml(HFD_TEMPLATE),
      node = impulse(doc);
    node.appendChild(node.querySelector('graphshowsum')!.cloneNode(true));
    expect(() => importHfd(serialize(doc), 'Duplicate graph flag')).toThrow(/Duplicate HFD/);
    node.querySelectorAll('graphshowsum')[1].remove();
    node.querySelector('graphshowsum')!.removeAttribute('value');
    expect(() => importHfd(serialize(doc), 'Missing boolean value')).toThrow(/Invalid HFD/);
  });
  it('exports explicit edited flags whilst preserving source XML metadata, other channels and legacy absent marker state', () => {
    const doc = parseXml(variedXml()),
      node = impulse(doc),
      custom = doc.createElement('vendor-display-option');
    custom.setAttribute('value', 'retain');
    node.appendChild(custom);
    const project = importHfd(serialize(doc), 'Preserved native XML');
    delete project.presets[0].channels[1].hfdGraph;
    project.presets[0].channels[0].hfdGraph = { showMeasuredResponse: false, showSum: true };
    const before = structuredClone(project),
      saved = parseXml(exportHfd(project));
    expect(impulse(saved).querySelector('graphshowmeasuredrespons')!.getAttribute('value')).toBe(
      'false',
    );
    expect(impulse(saved).querySelector('graphshowsum')!.getAttribute('value')).toBe('true');
    expect(impulse(saved).querySelector('vendor-display-option')!.getAttribute('value')).toBe(
      'retain',
    );
    expect(impulse(saved, 1, 2).querySelector('graphshowsum')!.getAttribute('value')).toBe(
      String(flags(1, 2).showSum),
    );
    expect(project).toEqual(before);
  });
  it('validates explicit graph metadata on direct export without changing the source document', () => {
    const project = newProject();
    Object.assign(project.presets[0].channels[0], {
      hfdGraph: { showMeasuredResponse: 1, showSum: false },
    });
    const before = structuredClone(project);
    expect(() => exportHfd(project)).toThrow();
    expect(project).toEqual(before);
  });
  it('retains flags through exact-sidecar and native-only folder exports without persisting runtime overlays', () => {
    const project = importHfd(variedXml(), 'Folder graph flags'),
      files = projectFiles(project),
      exact = importProjectFolder(files),
      native = importProjectFolder(files.filter((file) => file.path !== 'FusionProject.json')),
      expected = project.presets.map((p) => p.channels.map((c) => c.hfdGraph));
    expect(exact.presets.map((p) => p.channels.map((c) => c.hfdGraph))).toEqual(expected);
    expect(native.presets.map((p) => p.channels.map((c) => c.hfdGraph))).toEqual(expected);
    expect(
      parseXml(files.find((file) => file.path === 'Config.xml')!.content).querySelector(
        'rawMeasurements, otherResults',
      ),
    ).toBeNull();
  });
  it('measurement Clear retains saved graph flags rather than confusing them with loaded data', () => {
    const channel = loadedChannels()[0],
      saved = structuredClone(channel.hfdGraph);
    importChannelMeasurement(channel, undefined);
    expect(channel.measurement).toBeUndefined();
    expect(channel.hfdGraph).toEqual(saved);
  });
  it('native preset copy, Clear filters and linked processing retain destination display metadata', () => {
    const project = newProject(),
      source = project.presets[0].channels[0],
      destination = project.presets[1].channels[0];
    source.hfdGraph = { showMeasuredResponse: true, showSum: false };
    destination.hfdGraph = { showMeasuredResponse: false, showSum: true };
    copyPreset(project, 0, 1);
    expect(project.presets[1].channels[0].hfdGraph).toEqual({
      showMeasuredResponse: false,
      showSum: true,
    });
    clearPreset(project, 0);
    expect(source.hfdGraph).toEqual({ showMeasuredResponse: true, showSum: false });
    project.presets[0].channels[1].hfdGraph = { showMeasuredResponse: false, showSum: true };
    linkChannel(project.presets[0], 1, 0);
    expect(project.presets[0].channels[1].hfdGraph).toEqual({
      showMeasuredResponse: false,
      showSum: true,
    });
  });
});

describe('native selection versus runtime overlay state', () => {
  it('restores only current saved Show/Sum whilst preserving other runtime checkbox choices', () => {
    const channels = loadedChannels(),
      raw = [false, true, false],
      before = structuredClone(channels),
      first = restoreNativeGraphSelection(channels, raw, 0),
      second = restoreNativeGraphSelection(channels, first.rawMeasurements, 1);
    expect(first).toEqual({ rawMeasurements: [true, true, false], showSum: false });
    expect(second).toEqual({ rawMeasurements: [true, false, false], showSum: true });
    expect(raw).toEqual([false, true, false]);
    expect(channels).toEqual(before);
    second.rawMeasurements[0] = false;
    expect(first.rawMeasurements[0]).toBe(true);
  });
  it('gates only selected raw visibility for unloaded data, retains saved flags, and restores Sum independently', () => {
    const channels = loadedChannels(),
      before = structuredClone(channels);
    expect(restoreNativeGraphSelection(channels, [true, true, true], 2)).toEqual({
      rawMeasurements: [true, true, false],
      showSum: true,
    });
    expect(channels).toEqual(before);
    delete channels[0].hfdGraph;
    expect(restoreNativeGraphSelection(channels, [true, true, true], 0)).toEqual({
      rawMeasurements: [false, true, true],
      showSum: false,
    });
  });
  it('rejects invalid channel or runtime array without modifying anything', () => {
    const channels = loadedChannels(),
      raw = [true, false, true],
      before = structuredClone(channels);
    expect(() => restoreNativeGraphSelection(channels, raw, 3)).toThrow(/selection/);
    expect(() => restoreNativeGraphSelection(channels, [true], 0)).toThrow(/selection/);
    expect(() =>
      restoreNativeGraphSelection(channels, [true, false, undefined] as never, 0),
    ).toThrow(/selection/);
    expect(raw).toEqual([true, false, true]);
    expect(channels).toEqual(before);
  });
  it('performs explicit unloaded native callback writeback only when requested, preserving Sum and marker absence', () => {
    const channels = loadedChannels(),
      unloaded = channels[2],
      before = structuredClone(unloaded);
    restoreNativeGraphSelection(channels, [true, true, true], 2);
    expect(unloaded).toEqual(before);
    expect(normalizeNativeGraphSelection(unloaded)).toBe(true);
    expect(unloaded.hfdGraph).toEqual({ showMeasuredResponse: false, showSum: true });
    expect(normalizeNativeGraphSelection(unloaded)).toBe(false);
    expect(normalizeNativeGraphSelection(channels[0])).toBe(false);
    const legacy = newProject().presets[0].channels[0];
    expect(normalizeNativeGraphSelection(legacy)).toBe(false);
    expect(Object.hasOwn(legacy, 'hfdGraph')).toBe(false);
  });
  it('does not erase a loaded original-only measurement flag while its spectrum cache is unavailable', () => {
    const channels = loadedChannels();
    channels[2].measurement = { name: 'original.dat', sampleRate: 48000, impulse: [1, 0, 0] };
    const before = structuredClone(channels[2]);
    expect(restoreNativeGraphSelection(channels, [false, false, false], 2)).toEqual({
      rawMeasurements: [false, false, true],
      showSum: true,
    });
    expect(normalizeNativeGraphSelection(channels[2])).toBe(false);
    expect(channels[2]).toEqual(before);
  });
  it('samples layer data with the exact shared HFD log-grid polyline and refuses extrapolation', () => {
    const channels = loadedChannels(),
      data = buildMagnitudeLayers(channels, {
        layers: { rawMeasurements: [true, false, false], currentResult: false, section: false },
      }),
      curve = data.curves[0],
      before = structuredClone(data),
      f = Math.sqrt(data.frequency[100] * data.frequency[101]);
    expect(sampleHfdView(data, curve.db, f)).toBeCloseTo((curve.db[100] + curve.db[101]) / 2, 12);
    expect(sampleHfdView(data, curve.db, data.frequency[100])).toBe(curve.db[100]);
    expect(sampleHfdView(data, curve.db, data.frequency[0] / 2)).toBeNull();
    expect(sampleHfdView(data, curve.db, data.frequency.at(-1)! * 2)).toBeNull();
    expect(data).toEqual(before);
  });
});
