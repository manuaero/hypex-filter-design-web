// @vitest-environment jsdom
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Studio from '../src/components/Studio';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';
import type { WorkspaceAuthority } from '../src/application/workspace-authority';
import type {
  DirectoryWriterEnvelope,
  ProjectDirectoryWriter,
  WritableProjectDirectoryHandle,
  WritableProjectFileHandle,
} from '../src/application/project-directory-writer';
import { assertDirectoryWriterWrite } from '../src/application/directory-writer-storage';
import { exportHfd, parseProject } from '../src/domain/files';
import { newProject, type Project, type Slot } from '../src/domain/model';
import { ensureWorkspaceHydrated, useWorkspace } from '../src/state/workspace';
import type { WorkspaceEnvelope } from '../src/state/persistence';

const identity = { version: 1 as const, id: '11111111-1111-4111-8111-111111111111' };
const seen = vi.hoisted(() => ({
  adapter: undefined as ToolAdapter | undefined,
  authority: undefined as WorkspaceAuthority | undefined,
  writer: undefined as ProjectDirectoryWriter | undefined,
  envelope: null as DirectoryWriterEnvelope | null,
  writes: [] as WorkspaceEnvelope[],
  downloads: [] as Blob[],
  mutations: [] as string[],
}));
vi.mock('../src/components/AgentAccess', () => ({
  default: ({ adapter, authority }: { adapter: ToolAdapter; authority: WorkspaceAuthority }) => {
    seen.adapter = adapter;
    seen.authority = authority;
    return null;
  },
}));
vi.mock('../src/components/InteractivePlot', async (original) => ({
  ...(await original<typeof import('../src/components/InteractivePlot')>()),
  default: () => null,
}));
vi.mock('../src/components/ResponsePlot', async (original) => ({
  ...(await original<typeof import('../src/components/ResponsePlot')>()),
  default: () => null,
}));
vi.mock('../src/hardware/storage', async (original) => ({
  ...(await original<typeof import('../src/hardware/storage')>()),
  listBackups: async () => [],
}));
vi.mock('../src/application/workspace-authority', async (original) => {
  const actual = await original<typeof import('../src/application/workspace-authority')>();
  return {
    ...actual,
    createWorkspaceAuthority: () =>
      actual.createWorkspaceAuthority({ loadOrCreate: async () => identity }),
  };
});
vi.mock('../src/application/project-directory-writer', async (original) => {
  const actual = await original<typeof import('../src/application/project-directory-writer')>();
  return {
    ...actual,
    createProjectDirectoryWriter: (
      options: Parameters<typeof actual.createProjectDirectoryWriter>[0],
    ) =>
      actual.createProjectDirectoryWriter({
        ...options,
        backend: {
          read: async () => cloneEnvelope(seen.envelope),
          write: async (next, expected) => {
            assertDirectoryWriterWrite(seen.envelope, next, expected);
            seen.envelope = cloneEnvelope(next);
          },
        },
      }),
  };
});
vi.mock('../src/application/workspace-directory', async (original) => {
  const actual = await original<typeof import('../src/application/workspace-directory')>();
  return {
    ...actual,
    createWorkspaceDirectoryWriter: (
      options: Parameters<typeof actual.createWorkspaceDirectoryWriter>[0],
    ) => {
      const writer = actual.createWorkspaceDirectoryWriter({
        ...options,
        backend: {
          read: async () => ({
            writer: cloneEnvelope(seen.envelope),
            authority: identity,
            adoptions: null,
          }),
          update: async () => {
            throw new Error('Legacy adoption is outside this fixture');
          },
        },
      });
      seen.writer = writer;
      return writer;
    },
  };
});
vi.mock('../src/state/workspace', async (original) => {
  const actual = await original<typeof import('../src/state/workspace')>();
  let saved: WorkspaceEnvelope | null = null;
  const workspace = actual.createWorkspaceStore({
    read: async () => structuredClone(saved),
    write: async (value) => {
      saved = structuredClone(value);
      seen.writes.push(structuredClone(value));
    },
    readLegacy: () => null,
  });
  return {
    ...actual,
    useWorkspace: workspace.store,
    ensureWorkspaceHydrated: workspace.persistence.hydrate,
    retryWorkspacePersistence: workspace.persistence.retry,
    flushWorkspacePersistence: workspace.persistence.flush,
    getWorkspacePersistenceStatus: workspace.persistence.getSnapshot,
    subscribeWorkspacePersistence: workspace.persistence.subscribe,
    getWorkspaceRecoveryText: workspace.persistence.recoveryText,
  };
});

function cloneEnvelope(value: DirectoryWriterEnvelope | null): DirectoryWriterEnvelope | null {
  return (
    value && {
      ...value,
      roots: value.roots.map((root) => ({ ...root })),
      associations: structuredClone(value.associations),
      archives: value.archives.map((archive) => structuredClone(archive)),
      saves: value.saves.map((save) => ({
        ...save,
        claim: save.claim && { ...save.claim },
        files: save.files.map((file) => ({ ...file })),
      })),
    }
  );
}

// These granted handles implement only the production writer's filesystem ports.
// All bytes remain in memory; no OS picker or disk/device operation is performed.
class MemoryFile implements WritableProjectFileHandle {
  readonly kind = 'file' as const;
  generation = 0;
  constructor(
    readonly name: string,
    public data = new Uint8Array(),
  ) {}
  async getFile() {
    return new NodeFile([Uint8Array.from(this.data).buffer], this.name, {
      lastModified: 1000 + this.generation,
    }) as unknown as File;
  }
  async createWritable(options: { keepExistingData: false; mode: 'exclusive' }) {
    expect(options).toEqual({ keepExistingData: false, mode: 'exclusive' });
    let staged = new Uint8Array();
    return {
      write: async (blob: Blob) => {
        staged = new Uint8Array(await blob.arrayBuffer());
      },
      close: async () => {
        this.data = Uint8Array.from(staged);
        this.generation++;
        seen.mutations.push(this.name);
      },
      abort: async () => {},
    };
  }
}
class MemoryDirectory implements WritableProjectDirectoryHandle {
  readonly kind = 'directory' as const;
  children = new Map<string, MemoryDirectory | MemoryFile>();
  constructor(readonly name: string) {}
  async queryPermission() {
    return 'granted' as const;
  }
  async isSameEntry(other: WritableProjectDirectoryHandle) {
    return other === this;
  }
  async *values() {
    yield* this.children.values();
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const old = this.children.get(name);
    if (old?.kind === 'directory') return old;
    if (old || !options?.create) throw new DOMException('Missing directory', 'NotFoundError');
    const next = new MemoryDirectory(name);
    this.children.set(name, next);
    return next;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    const old = this.children.get(name);
    if (old?.kind === 'file') return old;
    if (old || !options?.create) throw new DOMException('Missing file', 'NotFoundError');
    const next = new MemoryFile(name);
    this.children.set(name, next);
    return next;
  }
  text(name: string) {
    const file = this.children.get(name);
    expect(file?.kind).toBe('file');
    return new TextDecoder().decode((file as MemoryFile).data);
  }
}
function fixtureProject(slot: Slot) {
  const project = newProject(`Synthetic ${slot} Save lifecycle`);
  project.hfdSelectedPreset = 1; // Imported metadata is not the current UI preset.
  const values = slot === 'left' ? [101, 113, 127] : [401, 419, 433];
  const maxima = slot === 'left' ? [71001, 71003, 71007] : [73001, 73003, 73009];
  for (const [p, preset] of project.presets.entries())
    for (const [c, channel] of preset.channels.entries()) {
      channel.globalDelayUs = p === 1 ? values[c] : 17 + p * 100 + c;
      channel.hfdDelay = {
        localMaximum: 19200 + c,
        globalMaximum: p === 1 ? maxima[c] : 70000 + p * 100 + c,
      };
      channel.gain = c - p;
      channel.delayUs = c * 11;
    }
  return project;
}
const state = () => useWorkspace.getState();
const globals = (project: Project) =>
  project.presets[1].channels.map((channel) => channel.globalDelayUs);
const maxima = (project: Project) =>
  project.presets[1].channels.map((channel) => channel.hfdDelay?.globalMaximum);
function expectedPost(before: Project) {
  const expected = structuredClone(before),
    first = before.presets[1].channels[0];
  for (const channel of expected.presets[1].channels) {
    channel.globalDelayUs = first.globalDelayUs;
    channel.hfdDelay!.globalMaximum = first.hfdDelay!.globalMaximum;
  }
  return expected;
}
let host: HTMLDivElement, root: Root, folders: Record<Slot, MemoryDirectory>;
const oldBlob = globalThis.Blob,
  oldFile = globalThis.File;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, Blob: NodeBlob, File: NodeFile });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  for (const name of ['showModal', 'close'])
    Object.defineProperty(HTMLDialogElement.prototype, name, {
      configurable: true,
      value: vi.fn(),
    });
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: string, _options: unknown, action: (lock: object) => unknown) =>
        action({}),
    },
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      seen.downloads.push(blob);
      return 'blob:synthetic-save';
    }),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await ensureWorkspaceHydrated();
  const documents = { left: fixtureProject('left'), right: fixtureProject('right') };
  useWorkspace.setState({
    documents,
    slot: 'left',
    preset: 1,
    channel: 0,
    filter: 0,
    linkedEdits: true,
    linkedControls: false,
    documentRevision: 0,
    past: [],
    future: [],
    gesture: undefined,
    fileCommitReceipts: {},
  });
  const database = new MemoryDirectory('Synthetic granted database');
  folders = {
    left: new MemoryDirectory('LeftExisting'),
    right: new MemoryDirectory('RightExisting'),
  };
  for (const slot of ['left', 'right'] as const) {
    database.children.set(folders[slot].name, folders[slot]);
    folders[slot].children.set(
      'Config.xml',
      new MemoryFile('Config.xml', new TextEncoder().encode(exportHfd(documents[slot]))),
    );
  }
  seen.envelope = {
    version: 2,
    revision: 0,
    roots: [{ id: 'save-root', label: database.name, handle: database }],
    associations: {
      left: {
        rootId: 'save-root',
        folderName: folders.left.name,
        projectKey: JSON.stringify(
          documents.left.presets.flatMap((preset) => preset.channels.map((channel) => channel.id)),
        ),
      },
      right: {
        rootId: 'save-root',
        folderName: folders.right.name,
        projectKey: JSON.stringify(
          documents.right.presets.flatMap((preset) => preset.channels.map((channel) => channel.id)),
        ),
      },
    },
    saves: [],
    archives: [],
  };
  seen.adapter = undefined;
  seen.writer = undefined;
  seen.writes = [];
  seen.downloads = [];
  seen.mutations = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Studio />));
  await act(async () => seen.adapter!.view({ tab: 'Help' }));
  await seen.adapter!.persistence!.flush();
  seen.writes = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  globalThis.Blob = oldBlob;
  globalThis.File = oldFile;
});
async function click(text: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  expect(
    button,
    `Visible production button: ${text}; alerts: ${host.querySelector('[role=alert]')?.textContent}`,
  ).toBeTruthy();
  expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
}
async function openSave(slot: Slot = 'left') {
  if (state().slot !== slot) await act(async () => seen.adapter!.choose({ slot }));
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Save project"]')!.click(),
  );
  expect(host.querySelector('dialog[aria-label="Save HFD project folder"]')).toBeTruthy();
}
async function reviewAndSave() {
  await click('Review save');
  await act(async () =>
    vi.waitFor(() =>
      expect(
        seen.writer!.getSnapshot().saves.at(-1),
        [...host.querySelectorAll('[role=alert]')].map((node) => node.textContent).join('\n'),
      ).toMatchObject({ phase: 'prepared' }),
    ),
  );
  const proposal = seen.writer!.getSnapshot().saves.at(-1)!;
  expect(proposal).toMatchObject({ mode: 'save', phase: 'prepared' });
  const checkbox = [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(
    (input) => input.parentElement?.textContent?.includes('Replace the listed existing files'),
  );
  if (checkbox) await act(async () => checkbox.click());
  await click('Save reviewed files');
  await act(async () =>
    vi.waitFor(() =>
      expect(
        seen.writer!.getSnapshot().saves.at(-1),
        [...host.querySelectorAll('[role=alert]')].map((node) => node.textContent).join('\n'),
      ).toMatchObject({ phase: 'complete' }),
    ),
  );
  expect(seen.writer!.getSnapshot().saves.at(-1)).toMatchObject({ phase: 'complete' });
  return seen.envelope!.saves.at(-1)!;
}

it.each(['left', 'right'] as const)(
  'ordinary %s folder Save writes the P2 preimage, then publishes only that role post-state once despite Mirror',
  async (slot) => {
    await openSave(slot);
    const before = structuredClone(state().documents),
      revision = state().documentRevision ?? 0;
    const publications: Record<Slot, Project>[] = [];
    const stop = useWorkspace.subscribe((next, old) => {
      if (next.documents !== old.documents) publications.push(structuredClone(next.documents));
    });
    await reviewAndSave();
    stop();
    const saved = parseProject(folders[slot].text('Config.xml'));
    expect(globals(saved)).toEqual(globals(before[slot]));
    expect(maxima(saved)).toEqual(maxima(before[slot]));
    expect.soft(saved.hfdSelectedPreset).toBe(2);
    const sidecar = JSON.parse(folders[slot].text('FusionProject.json'));
    expect.soft(sidecar.project.hfdSelectedPreset).toBe(2);
    expect(
      sidecar.nativeFiles.find((file: { path: string }) => file.path === 'Config.xml').content,
    ).toBe(folders[slot].text('Config.xml'));
    expect
      .soft(globals(state().documents[slot]))
      .toEqual(slot === 'left' ? [101, 101, 101] : [401, 401, 401]);
    expect
      .soft(maxima(state().documents[slot]))
      .toEqual(slot === 'left' ? [71001, 71001, 71001] : [73001, 73001, 73001]);
    expect.soft(publications).toHaveLength(1);
    expect(state().documents[slot]).toEqual(expectedPost(before[slot]));
    expect(state().documents[slot === 'left' ? 'right' : 'left']).toEqual(
      before[slot === 'left' ? 'right' : 'left'],
    );
    expect(publications).toHaveLength(1);
    expect(state().documentRevision).toBe(revision + 1);
    expect(state().past).toHaveLength(1);
    expect(state().documents[slot].hfdSelectedPreset).toBe(1);
    await seen.adapter!.persistence!.flush();
    expect(seen.writes.at(-1)!.state.documents[slot]).toEqual(expectedPost(before[slot]));
    await act(async () => seen.adapter!.undo());
    expect(state().documents).toEqual(before);
  },
);

it('opening, reviewing and canceling folder Save is passive before the explicit writer attempt', async () => {
  const before = structuredClone(state().documents),
    revision = state().documentRevision;
  await openSave();
  await click('Review save');
  await act(async () =>
    vi.waitFor(() =>
      expect(
        seen.writer!.getSnapshot().saves.at(-1),
        [...host.querySelectorAll('[role=alert]')].map((node) => node.textContent).join('\n'),
      ).toMatchObject({ phase: 'prepared' }),
    ),
  );
  expect(seen.writer!.getSnapshot().saves.at(-1)).toMatchObject({ phase: 'prepared' });
  expect(seen.mutations).toEqual([]);
  await click('Close');
  expect(state().documents).toEqual(before);
  expect(state().documentRevision).toBe(revision);
  expect(state().past).toEqual([]);
});

it('JSON and HFD ZIP download preparation stays passive and keeps imported selection metadata', async () => {
  const before = structuredClone(state().documents),
    revision = state().documentRevision;
  await openSave();
  await click('Download JSON');
  const json = JSON.parse(await seen.downloads[0].text());
  expect(json).toEqual(before.left);
  await click('Download HFD ZIP');
  expect(seen.downloads).toHaveLength(2);
  expect(seen.downloads[1].size).toBeGreaterThan(1000);
  expect(state().documents).toEqual(before);
  expect(state().documentRevision).toBe(revision);
  expect(state().past).toEqual([]);
  expect(seen.mutations).toEqual([]);
});

it('a historical completed folder receipt does not reapply the Save post-state after Undo', async () => {
  await openSave();
  const before = structuredClone(state().documents);
  const journal = await reviewAndSave();
  // The missing post-state is asserted before replay, so today's RED is a real
  // lifecycle failure rather than an unrelated receipt/undo fixture failure.
  expect(state().documents.left).toEqual(expectedPost(before.left));
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
  const afterUndo = state(),
    writes = seen.mutations.length;
  await act(async () => {
    const receipt = await seen.writer!.commit(
      journal.id,
      { owner: journal.owner, scope: journal.scope },
      { allowOverwrite: true },
    );
    expect(receipt).toMatchObject({ phase: 'complete', verified: true, replayed: true });
  });
  expect(state().documents).toBe(afterUndo.documents);
  expect(state().documentRevision).toBe(afterUndo.documentRevision);
  expect(state().past).toEqual(afterUndo.past);
  expect(seen.mutations).toHaveLength(writes);
});

it('the admitted MCP executor uses the same independent Right folder Save lifecycle and passive receipt replay', async () => {
  const raw = { owner: 'local:synthetic-save-client', scope: 'paired-save-fixture' },
    revoke = seen.authority!.registerPairedActor(raw, 'local'),
    execute = createToolExecutor(seen.adapter!),
    call = async (name: string, input: unknown) => {
      let result: any;
      await act(async () => {
        result = await execute(name, input, await seen.authority!.admit(raw));
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      return result;
    },
    before = structuredClone(state().documents),
    revision = state().documentRevision ?? 0;
  try {
    const staged = await call('fusion_project_save', {
        action: 'stage',
        target: 'both',
        mode: 'design',
        expectedRevision: revision,
      }),
      prepared = await call('fusion_project_directory', {
        action: 'prepare',
        slot: 'right',
        mode: 'save',
        expectedRevision: revision,
        requestId: 'mcp-save-lifecycle',
        exportId: staged.capture.id,
        metadata: 'design',
      });
    expect(state().documents).toEqual(before);
    expect(seen.mutations).toEqual([]);
    const saved = await call('fusion_project_directory', {
      action: 'commit',
      id: prepared.proposal.id,
      allowOverwrite: true,
    });
    expect(saved.receipt).toMatchObject({
      phase: 'complete',
      verified: true,
      replayed: false,
      nativeSavePostState: 'applied',
    });
    expect(state().documents).toEqual({ left: before.left, right: expectedPost(before.right) });
    expect(state().documentRevision).toBe(revision + 1);
    expect(state().past).toHaveLength(1);
    const serialized = parseProject(folders.right.text('Config.xml'));
    expect(globals(serialized)).toEqual([401, 419, 433]);
    expect(serialized.hfdSelectedPreset).toBe(2);
    await call('fusion_history', { action: 'undo' });
    expect(state().documents).toEqual(before);
    const mutations = seen.mutations.length,
      replay = await call('fusion_project_directory', {
        action: 'commit',
        id: prepared.proposal.id,
        allowOverwrite: true,
      });
    expect(replay.receipt).toMatchObject({ phase: 'complete', replayed: true });
    expect(state().documents).toEqual(before);
    expect(seen.mutations).toHaveLength(mutations);
  } finally {
    revoke();
  }
});
