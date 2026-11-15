// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';
import { createWorkspaceStore } from '../src/state/workspace';
import { newProject } from '../src/domain/model';
import { exportHfd, parseProject } from '../src/domain/files';
import { projectFiles, importProjectFolder } from '../src/domain/project-io';
import { clearNativeFir, selectNativeFirPlacement } from '../src/domain/fir-editing';
import { linkChannel } from '../src/domain/links';

const vault = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../src/hardware/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/hardware/storage')>()),
  getProject: vault.get,
}));

function fixture() {
  const project = newProject('Native independent FIR'),
    preset = project.presets[0];
  selectNativeFirPlacement(preset, 'output');
  preset.channels[0].fir = {
    name: 'Source.txt',
    enabled: true,
    taps: [0.5, ...Array(1499).fill(0)],
    hfdState: { loaded: true, used: true, tapCount: 1500 },
  };
  linkChannel(preset, 1, 0);
  clearNativeFir(preset, 1);
  return project;
}
async function setup() {
  let saved: unknown = null;
  const { store, persistence } = createWorkspaceStore({
    read: async () => saved,
    write: async (value) => {
      saved = structuredClone(value);
    },
    readLegacy: () => null,
  });
  await persistence.hydrate();
  const hardware = vi.fn(async () => {
      throw new Error('Unexpected hardware access');
    }),
    edit = vi.fn((...args: Parameters<ReturnType<typeof store.getState>['editAt']>) =>
      store.getState().editAt(...args),
    ),
    adapter: ToolAdapter = {
      state: store.getState,
      edit,
      choose: (patch) => store.getState().choose(patch),
      undo: () => store.getState().undo(),
      redo: () => store.getState().redo(),
      connections: () => ({}),
      connect: hardware,
      disconnect: hardware,
      refresh: hardware,
      operate: async (_, work) => work(),
      view: vi.fn(),
      message: vi.fn(),
      progress: vi.fn(),
    };
  return { execute: createToolExecutor(adapter), store, edit, hardware };
}

for (const format of ['JSON', 'HFD folder', 'library'] as const) {
  it(`actual ${format} replacement executor preserves native linked-follower Clear and one exact Undo`, async () => {
    const { execute, store, edit, hardware } = await setup(),
      original = fixture(),
      beforeSource = structuredClone(original),
      before = structuredClone(store.getState().documents),
      folder = projectFiles(original),
      expected =
        format === 'HFD folder'
          ? importProjectFolder(folder, original.name)
          : parseProject(JSON.stringify(original));
    vault.get.mockResolvedValue({
      id: 'native-snapshot',
      name: original.name,
      utc: '2026-11-14T00:00:00Z',
      project: original,
    });
    const result =
      format === 'JSON'
        ? await execute('fusion_project_import', {
            target: 'both',
            name: original.name,
            content: JSON.stringify(original),
          })
        : format === 'HFD folder'
          ? await execute('fusion_project_import_folder', {
              target: 'both',
              name: original.name,
              files: folder,
            })
          : await execute('fusion_library_open', { target: 'both', id: 'native-snapshot' });
    expect(result).toMatchObject({ ok: true });
    expect(edit.mock.calls[0][2]).toEqual({ synchronizeLinks: false });
    const after = store.getState();
    expect(after.documents.left).toEqual(expected);
    expect(after.documents.right).toEqual(expected);
    expect(after.documents.left.presets[0].channels[0].fir.hfdState!.loaded).toBe(true);
    expect(after.documents.left.presets[0].channels[1].fir).toMatchObject({
      enabled: true,
      taps: [],
      hfdState: { loaded: false, used: true, tapCount: 1500 },
    });
    expect(after.documents.left.presets[0].channels[1].linkedTo).toBe(0);
    expect(after.documents.left.presets[0].channels[0].fir.taps).not.toBe(
      after.documents.right.presets[0].channels[0].fir.taps,
    );
    expect(after.past).toHaveLength(1);
    after.undo();
    expect(store.getState().documents).toEqual(before);
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().future).toHaveLength(1);
    store.getState().redo();
    expect(store.getState().documents.left).toEqual(expected);
    expect(original).toEqual(beforeSource);
    expect(hardware).not.toHaveBeenCalled();
  });
}

it('actual JSON/library full replacements reject cyclic links before workspace mutation', async () => {
  const { execute, store, hardware } = await setup(),
    project = fixture();
  project.presets[0].channels[0].linkedTo = 1;
  const before = structuredClone(store.getState().documents);
  expect(
    await execute('fusion_project_import', {
      target: 'left',
      name: project.name,
      content: JSON.stringify(project),
    }),
  ).toMatchObject({ ok: false });
  vault.get.mockResolvedValue({
    id: 'cyclic',
    name: project.name,
    utc: '2026-11-14T00:00:00Z',
    project,
  });
  expect(await execute('fusion_library_open', { target: 'both', id: 'cyclic' })).toMatchObject({
    ok: false,
  });
  expect(store.getState().documents).toEqual(before);
  expect(store.getState().past).toHaveLength(0);
  expect(hardware).not.toHaveBeenCalled();
});
