// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { editPresetFir } from '../src/domain/fir-editing';
import { newProject, type Project } from '../src/domain/model';
import { linkChannel } from '../src/domain/links';
import { parseProject, exportHfd } from '../src/domain/files';
import { prepareFileImport } from '../src/application/file-workflows';
import { createToolExecutor, type ToolAdapter, type DocumentState } from '../src/application/tools';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { uploadFir } from '../src/hardware/fir';

beforeAll(() => {
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('crypto', webcrypto);
});
afterAll(() => vi.unstubAllGlobals());
const taps = (count: number, amplitude = 0.5) =>
  Array.from({ length: count }, (_, i) => (i === 1 ? amplitude : 0));

describe('native FIR load and replacement', () => {
  it.each([0, 1, 2, 3])(
    'loads fresh channel%s bypassed without changing placement or another FIR',
    (channel) => {
      const project = newProject(),
        p = project.presets[0],
        before = structuredClone(p),
        input = taps(channel === 0 ? 4500 : 1500);
      editPresetFir(p, channel, { name: 'new.txt', taps: input });
      const f = channel === 0 ? p.inputFir : p.channels[channel - 1].fir;
      expect(f).toEqual({ name: 'new.txt', taps: input, enabled: false });
      expect(p.firPlacement).toBe(before.firPlacement);
      expect(f.taps).not.toBe(input);
      input[1] = 10;
      expect(f.taps[1]).toBe(0.5);
      if (channel === 0) expect(p.channels).toEqual(before.channels);
      else {
        expect(p.inputFir).toEqual(before.inputFir);
        for (let c = 0; c < 3; c++)
          if (c !== channel - 1) expect(p.channels[c]).toEqual(before.channels[c]);
      }
    },
  );

  it('preserves each FIR enabled/bypassed state on replacement, even in an inactive placement', () => {
    const p = newProject().presets[0];
    p.inputFir = { name: 'Active input', enabled: true, taps: taps(4500) };
    p.channels[0].fir = { name: 'Inactive enabled output', enabled: true, taps: taps(1500) };
    p.channels[1].fir = { name: 'Inactive bypassed output', enabled: false, taps: taps(1500) };
    editPresetFir(p, 1, { name: 'replace-on.txt', taps: taps(1500, 0.25) });
    editPresetFir(p, 2, { name: 'replace-off.txt', taps: taps(1500, 0.75) });
    expect(p.firPlacement).toBe('input');
    expect(p.inputFir.enabled).toBe(true);
    expect(p.channels[0].fir).toMatchObject({ name: 'replace-on.txt', enabled: true });
    expect(p.channels[1].fir).toMatchObject({ name: 'replace-off.txt', enabled: false });
  });

  it('keeps explicit enable and explicit browser Unload distinct from plain file load', () => {
    const p = newProject().presets[0];
    p.inputFir = { name: 'Input', enabled: true, taps: taps(4500) };
    editPresetFir(p, 3, { name: 'Output', taps: taps(1500) });
    expect(p.firPlacement).toBe('input');
    expect(p.inputFir.enabled).toBe(true);
    editPresetFir(p, 3, { enabled: true });
    expect(p.firPlacement).toBe('output');
    expect(p.inputFir.enabled).toBe(false);
    expect(p.channels[2].fir.enabled).toBe(true);
    editPresetFir(p, 3, { clear: true });
    expect(p.channels[2].fir).toEqual({ name: '', taps: [], enabled: false });
    expect(p.firPlacement).toBe('output');
    editPresetFir(p, 3, { name: 'After explicit Unload', taps: taps(1500) });
    expect(p.channels[2].fir.enabled).toBe(false);
  });

  it('propagates only FIR data to linked followers, preserving independent ownership and labels', () => {
    const p = newProject().presets[0];
    linkChannel(p, 1, 0);
    const before = structuredClone(p);
    editPresetFir(p, 1, { name: 'linked.txt', taps: taps(1500) });
    expect(p.channels[1].fir).toEqual(p.channels[0].fir);
    expect(p.channels[1].fir).not.toBe(p.channels[0].fir);
    expect(p.channels[1].fir.taps).not.toBe(p.channels[0].fir.taps);
    expect(p.channels[1].name).toBe(before.channels[1].name);
    expect(p.channels[1].filters).toEqual(before.channels[1].filters);
    const loaded = structuredClone(p);
    expect(() => editPresetFir(p, 2, { clear: true })).toThrow(/read-only/);
    expect(p).toEqual(loaded);
  });

  it('rejects invalid taps, aliased resources and bad links without partially changing enabled/placement/name', () => {
    const p = newProject().presets[0],
      before = structuredClone(p);
    for (const invalid of [[], [1, 0], Array(1500).fill(0), [...taps(1500).slice(1), NaN]])
      expect(() => editPresetFir(p, 1, { name: 'Bad', taps: invalid, enabled: true })).toThrow();
    expect(p).toEqual(before);
    p.channels[1].fir = p.channels[0].fir;
    expect(() => editPresetFir(p, 1, { taps: taps(1500) })).toThrow(/independent/);
    const cyclic = newProject().presets[0];
    cyclic.channels[0].linkedTo = 1;
    cyclic.channels[1].linkedTo = 0;
    expect(() => editPresetFir(cyclic, 0, { taps: taps(4500) })).toThrow(/Cyclic/);
  });

  it('retains first-load bypass through browser JSON and native XML round trips', () => {
    const project = newProject();
    editPresetFir(project.presets[0], 0, { name: 'first.txt', taps: taps(4500) });
    expect(parseProject(JSON.stringify(project)).presets[0].inputFir.enabled).toBe(false);
    const native = parseProject(exportHfd(project));
    expect(native.presets[0].inputFir.enabled).toBe(false);
    expect(native.presets[0].inputFir.taps).toEqual(project.presets[0].inputFir.taps);
  });
});

it('default file imports retain independent per-role activation, while explicit enabled=true remains intentional', async () => {
  const left = newProject(),
    right = newProject();
  right.presets[0].inputFir = { name: 'Previous', enabled: true, taps: taps(4500) };
  const parameters = { target: 'both', preset: 1, channel: 0 },
    files = [{ path: 'replacement.txt', blob: new Blob([taps(4500).join('\n')]) }],
    plan = await prepareFileImport({ workflow: 'fir', parameters, expectedRevision: 0 }, files);
  plan.apply(left);
  plan.apply(right);
  expect(left.presets[0].inputFir.enabled).toBe(false);
  expect(right.presets[0].inputFir.enabled).toBe(true);
  expect(left.presets[0].inputFir.taps).not.toBe(right.presets[0].inputFir.taps);
  const enabled = await prepareFileImport(
    { workflow: 'fir', parameters: { ...parameters, enabled: true }, expectedRevision: 0 },
    files,
  );
  enabled.apply(left);
  expect(left.presets[0].inputFir.enabled).toBe(true);
});

it('MCP omitted-enabled loads and replacements use the shared native activation contract', async () => {
  let state: DocumentState = {
    documents: { left: newProject(), right: newProject() },
    slot: 'left',
    preset: 0,
    channel: 0,
    filter: 0,
    linkedEdits: false,
    linkedControls: true,
  };
  state.documents.right.presets[0].inputFir = { name: 'Previous', enabled: true, taps: taps(4500) };
  const adapter = {
    state: () => state,
    edit: (roles: ('left' | 'right')[], change: (project: Project) => void) => {
      const documents = structuredClone(state.documents);
      roles.forEach((role) => change(documents[role]));
      state = { ...state, documents };
    },
    message: vi.fn(),
    connections: () => ({}),
  } as unknown as ToolAdapter;
  const result = await createToolExecutor(adapter)('fusion_fir_set', {
    target: 'both',
    preset: 1,
    channel: 0,
    name: 'new.txt',
    text: taps(4500).join('\n'),
  });
  expect(result).toMatchObject({ ok: true });
  expect(state.documents.left.presets[0].inputFir.enabled).toBe(false);
  expect(state.documents.right.presets[0].inputFir.enabled).toBe(true);
});

it('first upload from a fresh plain load writes loaded-but-bypassed flags; an explicit later enable survives another upload', async () => {
  const panel = new SimulatedPanel(),
    session = new PanelSession(panel, async () => {}),
    p = newProject().presets[0];
  editPresetFir(p, 0, { name: 'first.txt', taps: taps(4500) });
  await uploadFir(
    session,
    1,
    p,
    () => {},
    async () => {},
  );
  expect(panel.status[28]).toBe(0x80);
  expect(panel.status[31] & 1).toBe(0);
  editPresetFir(p, 0, { enabled: true });
  await uploadFir(
    session,
    1,
    p,
    () => {},
    async () => {},
  );
  expect(panel.status[28]).toBe(0x88);
  expect(p.inputFir.enabled).toBe(true);
}, 20000);
