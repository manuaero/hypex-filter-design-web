// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ backups: vi.fn(), fir: vi.fn(), configuration: vi.fn() }));
vi.mock('../src/hardware/storage', () => ({
  listBackups: storage.backups,
  listFirBackups: storage.fir,
  listConfigurationBackups: storage.configuration,
}));
import {
  ImportWorkflowSchema,
  ExportWorkflowSchema,
  prepareFileImport,
  prepareFileExport,
} from '../src/application/file-workflows';
import { newProject, type Project } from '../src/domain/model';
import { exportHfd, parseProject } from '../src/domain/files';
import { projectFiles, importProjectFolder } from '../src/domain/project-io';
import { spectrum, processMeasurement } from '../src/domain/measurement';
import * as measurementMath from '../src/domain/measurement';
import { useHfdNative } from '../src/domain/hfd-measurement';
import { loadProjectMicrophone } from '../src/domain/hfd-microphone';
import { linkChannel } from '../src/domain/links';
import { clearNativeFir, selectNativeFirPlacement } from '../src/domain/fir-editing';
import { createWorkspaceStore } from '../src/state/workspace';
import {
  FILE_TRANSFER_MAX_FILE_BYTES,
  FILE_TRANSFER_MAX_TOTAL_BYTES,
  type TransferBinding,
  type TransferBlobFile,
  type TransferJson,
} from '../src/application/file-transfers';

beforeAll(() => vi.stubGlobal('Blob', NodeBlob));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  storage.backups.mockResolvedValue([]);
  storage.fir.mockResolvedValue([]);
  storage.configuration.mockResolvedValue([]);
});
const file = (path: string, text: string): TransferBlobFile => ({ path, blob: new Blob([text]) });
const binding = (workflow: string, parameters: TransferJson): TransferBinding => ({
  workflow,
  parameters,
  expectedRevision: 3,
});
const snapshot = (left = newProject('Left'), right = newProject('Right')) => ({
  documents: { left, right },
});
const target = { target: 'both', preset: 1, channel: 1 };
function driver(project: Project, native = false) {
  const c = project.presets[0].channels[0];
  c.measurement = { ...spectrum([0, 0, 1, 0.2, 0, 0, 0, 0], 48000), name: 'Original driver' };
  if (native) useHfdNative(c);
  return c;
}
function wav() {
  const bytes = new Uint8Array(44 + 8),
    v = new DataView(bytes.buffer);
  for (const [offset, text] of [
    [0, 'RIFF'],
    [8, 'WAVE'],
    [12, 'fmt '],
    [36, 'data'],
  ] as const)
    bytes.set(new TextEncoder().encode(text), offset);
  v.setUint32(4, bytes.length - 8, true);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 44100, true);
  v.setUint32(28, 88200, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  v.setUint32(40, 8, true);
  v.setInt16(46, 16384, true);
  return bytes.buffer;
}

it('allowlists offline variants and validates defaults, indices and unrecognized arguments', () => {
  expect(
    ImportWorkflowSchema.parse({ workflow: 'measurement-text', parameters: target }).parameters,
  ).toEqual({ ...target, sampleRate: 48000, format: 'auto' });
  expect(
    ImportWorkflowSchema.parse({ workflow: 'fir', parameters: { ...target, channel: 0 } })
      .parameters,
  ).toEqual({ ...target, channel: 0 });
  for (const workflow of ['upload', 'firmware', 'backup', 'unknown'])
    expect(ImportWorkflowSchema.safeParse({ workflow, parameters: {} }).success).toBe(false);
  for (const parameters of [
    { ...target, preset: 0 },
    { ...target, channel: 4 },
    { ...target, owner: 'forged' },
  ])
    expect(
      ImportWorkflowSchema.safeParse({ workflow: 'measurement-text', parameters }).success,
    ).toBe(false);
  expect(
    ExportWorkflowSchema.safeParse({ workflow: 'workspace-recovery', parameters: { slot: 'left' } })
      .success,
  ).toBe(false);
});

it('prepares project replacement without mutation, removes old optional state and detaches each role', async () => {
  const left = newProject('Previous'),
    right = newProject('Right'),
    replacement = newProject('Replacement');
  left.sourceXml = '<old/>';
  loadProjectMicrophone(left, '10 3\n1000 3\n24000 3', 'old.txt');
  const before = structuredClone(left),
    plan = await prepareFileImport(binding('project', { target: 'both' }), [
      file('replacement.json', JSON.stringify(replacement)),
    ]);
  expect(left).toEqual(before);
  expect(plan.slots).toEqual(['left', 'right']);
  plan.apply(left);
  plan.apply(right);
  expect(left).toEqual(replacement);
  expect(right).toEqual(replacement);
  expect(left.hfdCalibration).toBeUndefined();
  expect(left.sourceXml).toBeUndefined();
  left.presets[0].channels[0].filters[0].gain = 7;
  expect(right.presets[0].channels[0].filters[0].gain).toBe(0);
  expect(replacement.presets[0].channels[0].filters[0].gain).toBe(0);
});

it('uses the exact existing native-folder importer and sidecar rules', async () => {
  const original = newProject('Folder source');
  driver(original);
  original.presets[0].channels[0].measurement = processMeasurement(
    original.presets[0].channels[0].measurement!,
    { smoothingOctaves: 1 / 3 },
  );
  const native = projectFiles(original),
    expected = importProjectFolder(native, 'Config.xml'),
    project = newProject();
  const plan = await prepareFileImport(
    binding('folder', { target: 'left', name: 'Config.xml' }),
    native.map((entry) => file(entry.path, entry.content)),
  );
  plan.apply(project);
  expect(project).toEqual(expected);
  expect(project.presets[0].channels[0].measurement?.impulse).toEqual(
    original.presets[0].channels[0].measurement?.impulse,
  );
});

function nativeLinkedClearProject() {
  const project = newProject('Native linked FIR Clear'),
    preset = project.presets[0];
  selectNativeFirPlacement(preset, 'output');
  preset.channels[0].fir = {
    name: 'Source FIR.txt',
    enabled: true,
    taps: [0.5, ...Array(1499).fill(0)],
    hfdState: { loaded: true, used: true, tapCount: 1500 },
  };
  linkChannel(preset, 1, 0);
  clearNativeFir(preset, 1);
  return project;
}

for (const format of ['JSON', 'HFD exact-sidecar folder'] as const) {
  it(`preserves independent native linked-follower Clear through full ${format} preparation and actual workspace commit`, async () => {
    const original = nativeLinkedClearProject(),
      before = structuredClone(original);
    let persisted: unknown = null;
    const workspace = createWorkspaceStore({
      read: async () => persisted,
      write: async (value) => {
        persisted = structuredClone(value);
      },
      readLegacy: () => null,
    });
    await workspace.persistence.hydrate();
    const workflow = format === 'JSON' ? 'project' : 'folder',
      expected =
        format === 'JSON'
          ? parseProject(JSON.stringify(original))
          : importProjectFolder(projectFiles(original), original.name),
      files =
        format === 'JSON'
          ? [file('source.json', JSON.stringify(original))]
          : projectFiles(original).map((entry) => file(entry.path, entry.content)),
      importBinding = {
        ...binding(workflow, { target: 'both', name: original.name }),
        expectedRevision: workspace.store.getState().documentRevision ?? 0,
      },
      plan = await prepareFileImport(importBinding, files),
      proposed = newProject();
    expect(plan.synchronizeLinks).toBe(false);
    plan.apply(proposed);
    expect(proposed).toEqual(expected);
    const receipt = await workspace.store
      .getState()
      .commitFileImport(
        `full-import-${workflow}`,
        { owner: 'browser:test', scope: 'test:full-import' },
        importBinding.expectedRevision,
        plan.slots,
        plan.apply,
        plan.result,
        undefined,
        { synchronizeLinks: plan.synchronizeLinks },
      );
    const state = workspace.store.getState();
    expect(receipt.revision).toBe(1);
    expect(state.past).toHaveLength(1);
    expect(state.documents.left).toEqual(expected);
    expect(state.documents.right).toEqual(expected);
    expect(state.documents.left.presets[0].channels[1].fir).toMatchObject({
      enabled: true,
      taps: [],
      hfdState: { loaded: false, used: true, tapCount: 1500 },
    });
    expect(state.documents.left.presets[0].channels[0].fir.hfdState!.loaded).toBe(true);
    expect(state.documents.left.presets[0].channels[1].linkedTo).toBe(0);
    expect(state.documents.left.presets[0].channels[0].fir.taps).not.toBe(
      state.documents.right.presets[0].channels[0].fir.taps,
    );
    expect(original).toEqual(before);
    const saved = persisted as { state: { documents: { left: Project; right: Project } } };
    expect(saved.state.documents).toEqual(state.documents);
  });
}

it('keeps ordinary source-FIR imports synchronized through both preparation and actual workspace commit', async () => {
  let saved: unknown = null;
  const workspace = createWorkspaceStore({
    read: async () => saved,
    write: async (value) => {
      saved = structuredClone(value);
    },
    readLegacy: () => null,
  });
  await workspace.persistence.hydrate();
  const original = newProject('Linked ordinary edit');
  linkChannel(original.presets[0], 1, 0);
  workspace.store.setState({ documents: { left: original, right: newProject('Other role') } });
  const before = structuredClone(workspace.store.getState().documents.right),
    followerId = original.presets[0].channels[1].id,
    plan = await prepareFileImport(
      {
        ...binding('fir', { target: 'left', preset: 1, channel: 1, enabled: true }),
        expectedRevision: 0,
      },
      [file('source.txt', ['0.25', ...Array(1499).fill('0')].join('\n'))],
    );
  expect(plan.synchronizeLinks).toBeUndefined();
  await workspace.store
    .getState()
    .commitFileImport(
      'source-fir-import',
      { owner: 'browser:test', scope: 'test:ordinary-import' },
      0,
      plan.slots,
      plan.apply,
      plan.result,
      undefined,
      { synchronizeLinks: plan.synchronizeLinks },
    );
  const state = workspace.store.getState(),
    preset = state.documents.left.presets[0];
  expect(preset.channels[0].fir.enabled).toBe(true);
  expect(preset.channels[0].fir.taps[0]).toBe(0.25);
  expect(preset.channels[1].fir).toEqual(preset.channels[0].fir);
  expect(preset.channels[1].fir.taps).not.toBe(preset.channels[0].fir.taps);
  expect(preset.channels[1].id).toBe(followerId);
  expect(state.documents.right).toEqual(before);
});

it('imports output FIR with placement exclusion and propagates only source processing to linked outputs', async () => {
  const project = newProject(),
    pr = project.presets[0];
  pr.inputFir = { name: 'Input', enabled: true, taps: Array(4500).fill(0.01) };
  const slaveId = pr.channels[1].filters[0].id;
  linkChannel(pr, 1, 0);
  const plan = await prepareFileImport(binding('fir', { ...target, enabled: true }), [
    file('output.txt', Array(1500).fill('0.001').join('\n')),
  ]);
  plan.apply(project);
  expect(project.presets[0].firPlacement).toBe('output');
  expect(project.presets[0].inputFir.enabled).toBe(false);
  expect(project.presets[0].channels[0].fir.enabled).toBe(true);
  expect(project.presets[0].channels[1].fir).toEqual(project.presets[0].channels[0].fir);
  expect(project.presets[0].channels[1].filters[0].id).toBe(slaveId);
  const readonly = await prepareFileImport(binding('fir', { ...target, channel: 2 }), [
    file('slave.txt', Array(1500).fill('0.001').join('\n')),
  ]);
  const before = structuredClone(project);
  expect(() => readonly.apply(project)).toThrow('read-only');
  expect(project).toEqual(before);
});

it('imports 4500 input taps, disables outputs only when enabling, and rejects wrong or zero tap sets', async () => {
  const project = newProject();
  project.presets[0].channels[0].fir.enabled = true;
  const plan = await prepareFileImport(binding('fir', { ...target, channel: 0, enabled: false }), [
    file('input.dat', Array(4500).fill('0.002').join('\n')),
  ]);
  plan.apply(project);
  expect(project.presets[0].inputFir).toMatchObject({ name: 'input.dat', enabled: false });
  expect(project.presets[0].channels[0].fir.enabled).toBe(true);
  for (const text of [Array(1500).fill('0').join('\n'), '1\n0'])
    await expect(
      prepareFileImport(binding('fir', target), [file('bad.txt', text)]),
    ).rejects.toThrow();
});

it('imports text with requested sampling rate and keeps measurements local on linked channels', async () => {
  const left = newProject(),
    right = newProject();
  linkChannel(left.presets[0], 0, 1);
  const plan = await prepareFileImport(
    binding('measurement-text', { ...target, format: 'impulse', sampleRate: 96000 }),
    [file('driver.dat', '0\n1\n0\n0')],
  );
  plan.apply(left);
  plan.apply(right);
  expect(left.presets[0].channels[0].measurement).toMatchObject({
    name: 'driver.dat',
    sampleRate: 96000,
    impulse: [0, 1, 0, 0],
  });
  expect(left.presets[0].channels[1].measurement).toBeUndefined();
  left.presets[0].channels[0].measurement!.impulse![1] = 5;
  expect(right.presets[0].channels[0].measurement!.impulse![1]).toBe(1);
});

it('retains native mode, rejects native frequency-only atomically, and permits explicit browser conversion', async () => {
  const project = newProject();
  driver(project, true);
  const before = structuredClone(project),
    frd = file('driver.frd', '100 -3 0\n1000 -6 20');
  const retained = await prepareFileImport(binding('measurement-text', target), [frd]);
  expect(() => retained.apply(project)).toThrow('original impulse');
  expect(project).toEqual(before);
  const browser = await prepareFileImport(
    binding('measurement-text', { ...target, analysis: 'browser', format: 'frequency' }),
    [frd],
  );
  browser.apply(project);
  expect(project.presets[0].channels[0].hfdMeasurement).toBeUndefined();
  expect(project.presets[0].channels[0].measurement?.frequency).toEqual([100, 1000]);
  expect(project.presets[0].channels[0].measurement?.hfdPhase).toBeUndefined();
  await expect(
    prepareFileImport(binding('measurement-text', { ...target, format: 'frequency' }), [
      file('impulse.txt', '1\n0'),
    ]),
  ).rejects.toThrow('Frequency import');
});

it('decodes raw WAV bytes without base64 and can explicitly select native analysis', async () => {
  const project = newProject(),
    plan = await prepareFileImport(binding('measurement-wav', { ...target, analysis: 'hfd' }), [
      { path: 'driver.wav', blob: new Blob([wav()]) },
    ]);
  plan.apply(project);
  const c = project.presets[0].channels[0];
  expect(c.measurement?.sampleRate).toBe(44100);
  expect(c.measurement?.impulse).toEqual([0, 0.5, 0, 0]);
  expect(c.hfdMeasurement?.sampleRate).toBe(44100);
  expect(c.measurement?.hfdPhase?.frequency).toHaveLength(1024);
});

it('loads project microphone resources while preserving apply flags and each role’s independent options', async () => {
  const left = newProject(),
    right = newProject();
  driver(left, true);
  driver(right, true);
  left.presets[0].channels[0].hfdMeasurement!.applyMicCorrection = true;
  const plan = await prepareFileImport(
    binding('microphone', { target: 'both', showCurve: true, smoothingOctaves: 0.02 }),
    [file('mic.txt', '10 6\n1000 6\n24000 6')],
  );
  expect(plan.remember).toBe('microphone');
  plan.apply(left);
  plan.apply(right);
  expect(left.hfdCalibration).toMatchObject({
    filename: 'mic.txt',
    loaded: true,
    showCurve: true,
    smoothingOctaves: 0.02,
  });
  expect(left.presets[0].channels[0].hfdMeasurement?.applyMicCorrection).toBe(true);
  expect(right.presets[0].channels[0].hfdMeasurement?.applyMicCorrection).toBe(false);
  left.hfdCalibration!.resource!.curve.magnitude[0] = 99;
  expect(right.hfdCalibration!.resource!.curve.magnitude[0]).toBe(6);
  await expect(
    prepareFileImport(binding('microphone', { target: 'left' }), [file('bad.txt', 'bad')]),
  ).rejects.toThrow();
});

it('applies compatibility calibration as native project resource or browser-local curve according to target', async () => {
  const native = newProject(),
    browser = newProject();
  driver(native, true);
  driver(browser);
  const original = native.presets[0].channels[0].measurement!.impulse!.slice();
  const phase = structuredClone(native.presets[0].channels[0].measurement!.hfdPhase);
  const plan = await prepareFileImport(binding('calibration', target), [
    file('compat.txt', '10 3\n1000 3\n24000 3'),
  ]);
  plan.apply(native);
  plan.apply(browser);
  expect(native.hfdCalibration?.loaded).toBe(true);
  expect(native.presets[0].channels[0].hfdMeasurement?.applyMicCorrection).toBe(true);
  expect(native.presets[0].channels[0].measurement?.impulse).toEqual(original);
  expect(native.presets[0].channels[0].measurement?.hfdPhase).toEqual(phase);
  expect(native.presets[0].channels[0].measurement?.processing?.calibration).toBeUndefined();
  expect(browser.hfdCalibration).toBeUndefined();
  expect(browser.presets[0].channels[0].measurement?.processing?.calibrationEnabled).toBe(true);
  expect(browser.presets[0].channels[1].measurement).toBeUndefined();
  const empty = newProject(),
    before = structuredClone(empty);
  expect(() => plan.apply(empty)).toThrow('No measurement');
  expect(empty).toEqual(before);
});

it('rejects invalid revision, path traversal, duplicates, extra files and byte budgets before decoding', async () => {
  const normal = binding('project', { target: 'left' });
  await expect(
    prepareFileImport({ ...normal, expectedRevision: -1 }, [file('p.json', '{}')]),
  ).rejects.toThrow('revision');
  for (const path of ['../p.json', '/p.json', 'C:/p.json', './p.json', 'a\u0000.json'])
    await expect(prepareFileImport(normal, [file(path, '{}')])).rejects.toThrow('path');
  await expect(
    prepareFileImport(binding('folder', { target: 'left' }), [
      file('Config.xml', ''),
      file('config.XML', ''),
    ]),
  ).rejects.toThrow('Duplicate');
  await expect(prepareFileImport(normal, [file('a', ''), file('b', '')])).rejects.toThrow(
    'exactly one',
  );
  function sized(path: string, size: number) {
    const blob = new Blob();
    Object.defineProperty(blob, 'size', { value: size });
    Object.defineProperty(blob, 'text', {
      value: vi.fn(() => {
        throw new Error('must not decode');
      }),
    });
    return { path, blob };
  }
  await expect(
    prepareFileImport(normal, [sized('large', FILE_TRANSFER_MAX_FILE_BYTES + 1)]),
  ).rejects.toThrow('byte budget');
  await expect(
    prepareFileImport(binding('folder', { target: 'left' }), [
      sized('a', FILE_TRANSFER_MAX_TOTAL_BYTES / 2),
      sized('b', FILE_TRANSFER_MAX_TOTAL_BYTES / 2),
      sized('c', 1),
    ]),
  ).rejects.toThrow('total byte');
  await expect(prepareFileImport(normal, [sized('p.json', 240e6 + 4)])).rejects.toThrow(
    'text import limit',
  );
});

it('round-trips a valid pretty impulse project larger than 20m characters under the shared 80m limit', async () => {
  const source = newProject('Large impulse snapshot');
  source.presets[0].channels[0].measurement = {
    name: 'Large original impulse',
    sampleRate: 48000,
    impulse: Array.from({ length: 1_200_000 }, (_, i) => (i === 0 ? 1 : 0)),
  };
  const files = await prepareFileExport(
    { workflow: 'project-json', parameters: { slot: 'left' } },
    snapshot(source),
  );
  expect(files[0].blob.size).toBeGreaterThan(20e6);
  const plan = await prepareFileImport(binding('project', { target: 'left' }), files);
  const restored = newProject();
  plan.apply(restored);
  expect(restored.name).toBe(source.name);
  expect(restored.presets[0].channels[0].measurement?.impulse).toEqual(
    source.presets[0].channels[0].measurement?.impulse,
  );
}, 20000);

it('exports exact pretty project JSON/XML and immutable data in browser Blobs', async () => {
  const project = newProject('Quoted "name"'),
    state = snapshot(project);
  driver(project);
  const expected = JSON.stringify(project, null, 2);
  const json = await prepareFileExport(
    { workflow: 'project-json', parameters: { slot: 'left' } },
    state,
  );
  expect(await json[0].blob.text()).toBe(expected);
  expect(parseProject(await json[0].blob.text())).toEqual(project);
  const xml = await prepareFileExport(
    { workflow: 'project-hfd-xml', parameters: { slot: 'left' } },
    state,
  );
  expect(await xml[0].blob.text()).toBe(exportHfd(project));
  project.presets[0].channels[0].measurement!.impulse![2] = 8;
  expect(await json[0].blob.text()).toBe(expected);
  expect(json[0].blob.type).toBe('application/json');
});

it('exports every native folder file with exact existing sidecar/text content', async () => {
  const project = newProject();
  driver(project);
  loadProjectMicrophone(project, '10 2\n1000 2\n24000 2', 'mic.txt');
  const expected = projectFiles(project);
  const files = await prepareFileExport(
    { workflow: 'project-folder', parameters: { slot: 'left' } },
    snapshot(project),
  );
  expect(
    await Promise.all(files.map(async (f) => ({ path: f.path, content: await f.blob.text() }))),
  ).toEqual(expected);
});

it('exports processed frequency response, untouched impulse and FIR as exact numeric lines', async () => {
  const project = newProject(),
    c = driver(project);
  c.measurement = processMeasurement(c.measurement!, {
    window: { start: 1, end: 4, taper: 0, timeZero: 1 },
  });
  const m = c.measurement!,
    state = snapshot(project),
    p = { slot: 'left', preset: 1, channel: 1 };
  const frequency = await prepareFileExport(
    { workflow: 'measurement-frequency', parameters: p },
    state,
  );
  expect(await frequency[0].blob.text()).toBe(
    m.frequency!.map((f, i) => [f, m.magnitude![i], m.phase?.[i] ?? 0].join('\t')).join('\n'),
  );
  const impulse = await prepareFileExport(
    { workflow: 'measurement-impulse', parameters: p },
    state,
  );
  expect(await impulse[0].blob.text()).toBe(m.impulse!.join('\n'));
  project.presets[0].inputFir = { name: 'Input', enabled: false, taps: [1, 0.25, -0.5] };
  const fir = await prepareFileExport({ workflow: 'fir', parameters: { ...p, channel: 0 } }, state);
  expect(await fir[0].blob.text()).toBe('1\n0.25\n-0.5');
  expect(fir[0].path).toBe('Input.txt');
});

it.each(['backup', 'fir-backup', 'configuration-backup'] as const)(
  'exports %s using only its read-only saved-record lookup',
  async (workflow) => {
    const record = {
      id: 'saved',
      utc: '2026-11-14T12:00:00Z',
      preset: 2,
      format: workflow,
      nested: { samples: [1, 2, 3] },
    };
    const loader =
      workflow === 'backup'
        ? storage.backups
        : workflow === 'fir-backup'
          ? storage.fir
          : storage.configuration;
    loader.mockResolvedValue([record]);
    const files = await prepareFileExport(
      { workflow, parameters: { backupId: 'saved' } },
      snapshot(),
    );
    expect(await files[0].blob.text()).toBe(JSON.stringify(record, null, 2));
    expect(loader).toHaveBeenCalledOnce();
    record.nested.samples[0] = 99;
    expect(JSON.parse(await files[0].blob.text()).nested.samples[0]).toBe(1);
    await expect(
      prepareFileExport({ workflow, parameters: { backupId: 'absent' } }, snapshot()),
    ).rejects.toThrow('not found');
  },
);

it('exports exact workspace recovery text without inventing an unavailable snapshot', async () => {
  const text = '{ "version": 1, "state": {"recovery":"exact"} }';
  const files = await prepareFileExport(
    { workflow: 'workspace-recovery', parameters: {} },
    snapshot(),
    text,
  );
  expect(await files[0].blob.text()).toBe(text);
  await expect(
    prepareFileExport({ workflow: 'workspace-recovery', parameters: {} }, snapshot()),
  ).rejects.toThrow('unavailable');
});

it('sanitizes export filenames and rejects unavailable measurement/FIR data', async () => {
  const project = newProject('C:/unsafe/path'),
    state = snapshot(project);
  const files = await prepareFileExport(
    { workflow: 'project-json', parameters: { slot: 'left' } },
    state,
  );
  expect(files[0].path).toBe('C__unsafe_path.fusion.json');
  for (const workflow of ['measurement-frequency', 'measurement-impulse', 'fir'])
    await expect(
      prepareFileExport({ workflow, parameters: { slot: 'left', preset: 1, channel: 1 } }, state),
    ).rejects.toThrow();
});

it('keeps prepared bindings and names detached from later caller mutation', async () => {
  const request = binding('fir', { ...target, name: 'n'.repeat(240) });
  const uploaded = file('original.txt', Array(1500).fill('0.001').join('\n'));
  const plan = await prepareFileImport(request, [uploaded]);
  (request.parameters as Record<string, TransferJson>).preset = 3;
  (request.parameters as Record<string, TransferJson>).name = 'changed';
  uploaded.path = 'changed.txt';
  const project = newProject();
  plan.apply(project);
  expect(project.presets[0].channels[0].fir.name).toBe('n'.repeat(240));
  expect(project.presets[2].channels[0].fir.taps).toHaveLength(0);
});

it('refuses cyclic JSON links during full import preparation before any mutation', async () => {
  const malformed = newProject('Cyclic');
  malformed.presets[0].channels[0].linkedTo = 1;
  malformed.presets[0].channels[1].linkedTo = 0;
  const project = newProject('Keep me'),
    before = structuredClone(project);
  await expect(
    prepareFileImport(binding('project', { target: 'left' }), [
      file('cyclic.json', JSON.stringify(malformed)),
    ]),
  ).rejects.toThrow(/Cyclic/);
  expect(project).toEqual(before);
});

it('validates native XML link topology without normalizing any project processing', async () => {
  const doc = new DOMParser().parseFromString(exportHfd(newProject()), 'application/xml');
  for (const [group, source] of [
    [1, 2],
    [2, 1],
  ]) {
    const impulse = doc.querySelector(
      `device > preset[index="1"] > processobj[processtype="ptImpulse"][groupid="${group}"]`,
    )!;
    let link = impulse.querySelector(':scope > linkedto');
    if (!link) {
      link = doc.createElement('linkedto');
      impulse.appendChild(link);
    }
    link.setAttribute('value', String(source));
  }
  const plan = await prepareFileImport(binding('project', { target: 'left' }), [
      file('cyclic.xml', new XMLSerializer().serializeToString(doc)),
    ]),
    project = newProject('Keep me'),
    before = structuredClone(project);
  expect(plan.synchronizeLinks).toBe(false);
  expect(() => plan.apply(project)).toThrow('Cyclic');
  expect(project).toEqual(before);
});

it('keeps multi-buffer numeric/JSON text byte-identical, including Unicode and escaped names', async () => {
  const project = newProject('Quoted "name" 😀');
  const samples = Array.from({ length: 40000 }, (_, i) => ((i % 7) - 3) / 8);
  project.presets[0].channels[0].measurement = {
    name: 'Driver \"quoted\" 😀',
    sampleRate: 48000,
    impulse: samples,
  };
  const state = snapshot(project);
  const json = await prepareFileExport(
    { workflow: 'project-json', parameters: { slot: 'left' } },
    state,
  );
  expect(json[0].blob.size).toBeGreaterThan(65536);
  expect(await json[0].blob.text()).toBe(JSON.stringify(project, null, 2));
  const impulse = await prepareFileExport(
    { workflow: 'measurement-impulse', parameters: { slot: 'left', preset: 1, channel: 1 } },
    state,
  );
  expect(impulse[0].blob.size).toBeGreaterThan(65536);
  expect(await impulse[0].blob.text()).toBe(samples.join('\n'));
});

it('uses File.name basenames for single imports while preserving manifest paths for receipts', async () => {
  const project = newProject();
  const plan = await prepareFileImport(
    binding('measurement-text', { ...target, format: 'impulse' }),
    [file('folder\\drivers\\driver.dat', '0\n1\n0\n0')],
  );
  plan.apply(project);
  expect(project.presets[0].channels[0].measurement?.name).toBe('driver.dat');
  expect((plan.result as Record<string, TransferJson>).filesPreview).toEqual([
    'folder/drivers/driver.dat',
  ]);
  const fir = await prepareFileImport(binding('fir', target), [
    file('folder/taps.txt', Array(1500).fill('0.1').join('\n')),
  ]);
  fir.apply(project);
  expect(project.presets[0].channels[0].fir.name).toBe('taps.txt');
});

it('keeps a 2000-file folder receipt below the durable metadata budget', async () => {
  const files = [file('Config.xml', exportHfd(newProject()))];
  for (let i = 1; i < 2000; i++) files.push(file(`${'a'.repeat(900)}-${i}.bin`, ''));
  const plan = await prepareFileImport(
    binding('folder', { target: 'left', name: 'Large manifest' }),
    files,
  );
  const receipt = plan.result as Record<string, TransferJson>;
  expect(receipt.fileCount).toBe(2000);
  expect(receipt.filesPreview as string[]).toHaveLength(10);
  expect(receipt.omittedCount).toBe(1990);
  expect(receipt.files).toBeUndefined();
  expect(new TextEncoder().encode(JSON.stringify(receipt)).byteLength).toBeLessThan(65536);
});

it('bounds receipt warnings without truncating warnings inside the imported document', async () => {
  const imported = newProject('Warnings');
  imported.warnings = Array.from({ length: 40 }, (_, i) => `${i}:` + '\n'.repeat(10000));
  const plan = await prepareFileImport(binding('project', { target: 'left' }), [
    file('p.json', JSON.stringify(imported)),
  ]);
  const receipt = plan.result as Record<string, TransferJson>,
    project = newProject();
  expect(receipt.warningCount).toBe(40);
  expect(receipt.omittedWarningCount).toBe(30);
  expect(receipt.warnings as string[]).toHaveLength(10);
  expect((receipt.warnings as string[]).every((warning) => warning.length <= 512)).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(receipt)).byteLength).toBeLessThan(65536);
  plan.apply(project);
  expect(project.warnings).toEqual(imported.warnings);
});

it('accepts a legitimate million-sample text impulse larger than the old command cap', async () => {
  const samples = 1_100_000;
  const text = '0.0000000000000000000001\n'.repeat(samples);
  expect(text.length).toBeGreaterThan(20e6);
  const parse = vi.spyOn(measurementMath, 'parseImpulse');
  try {
    const plan = await prepareFileImport(
      binding('measurement-text', { ...target, format: 'impulse' }),
      [file('long.dat', text)],
    );
    expect(parse).toHaveBeenCalledOnce();
    const measurement = parse.mock.results[0].value as ReturnType<
      typeof measurementMath.parseImpulse
    >;
    expect(measurement.impulse).toHaveLength(samples);
    expect(measurement.impulse![0]).toBe(1e-22);
    expect((plan.result as Record<string, TransferJson>).fileCount).toBe(1);
  } finally {
    parse.mockRestore();
  }
}, 20000);

it('allows folder members beyond 20m characters while retaining the 80m aggregate limit', async () => {
  const text = ' '.repeat(20e6 + 1);
  const config = file('Config.xml', exportHfd(newProject()));
  const plan = await prepareFileImport(
    binding('folder', { target: 'left', name: 'Large extra file' }),
    [config, file('ignored.bin', text)],
  );
  expect((plan.result as Record<string, TransferJson>).fileCount).toBe(2);
  await expect(
    prepareFileImport(binding('folder', { target: 'left' }), [
      config,
      file('a.bin', text),
      file('b.bin', text),
      file('c.bin', text),
      file('d.bin', text),
    ]),
  ).rejects.toThrow('Project folder exceeds import limits');
}, 10000);
