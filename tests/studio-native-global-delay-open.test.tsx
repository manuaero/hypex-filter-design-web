// @vitest-environment jsdom
import { File as NodeFile } from 'node:buffer';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Studio from '../src/components/Studio';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';
import { exportHfd, parseProject } from '../src/domain/files';
import { newProject, type Project } from '../src/domain/model';
import { ensureWorkspaceHydrated, useWorkspace } from '../src/state/workspace';
import type { WorkspaceEnvelope } from '../src/state/persistence';

const seen = vi.hoisted(() => ({
  adapter: undefined as ToolAdapter | undefined,
  writes: [] as WorkspaceEnvelope[],
}));
vi.mock('../src/components/AgentAccess', () => ({
  default: ({ adapter }: { adapter: ToolAdapter }) => {
    seen.adapter = adapter;
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
      actual.createWorkspaceAuthority({
        loadOrCreate: async () => ({ version: 1, id: '11111111-1111-4111-8111-111111111111' }),
      }),
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

const rawValues = [
  [17, 29, 43],
  [101, 113, 127],
  [203, 227, 251],
];
const rawMaxima = [
  [70001, 70003, 70007],
  [71001, 71003, 71007],
  [72001, 72003, 72007],
];
const finalValues = [
  [17, 17, 17],
  [101, 113, 127],
  [203, 203, 203],
];
const finalMaxima = [[70001, 70001, 70001], rawMaxima[1], [72001, 72001, 72001]];
const globals = (project: Project) =>
  project.presets.map((preset) => preset.channels.map((c) => c.globalDelayUs));
const maxima = (project: Project) =>
  project.presets.map((preset) => preset.channels.map((c) => c.hfdDelay?.globalMaximum));
function nativeInput() {
  const project = newProject('Synthetic native Global input');
  project.hfdSelectedPreset = 3;
  project.hfdSelectedGroupId = 777;
  for (const [p, preset] of project.presets.entries())
    for (const [c, channel] of preset.channels.entries()) {
      channel.globalDelayUs = rawValues[p][c];
      channel.hfdDelay = { localMaximum: 19 + c, globalMaximum: rawMaxima[p][c] };
    }
  const content = exportHfd(project);
  return { content, decoded: parseProject(content) };
}
const state = () => useWorkspace.getState();
let host: HTMLDivElement, root: Root;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  for (const name of ['showModal', 'close'])
    Object.defineProperty(HTMLDialogElement.prototype, name, {
      configurable: true,
      value: vi.fn(),
    });
  await ensureWorkspaceHydrated();
  const documents = {
    left: newProject('Independent Left'),
    right: newProject('Independent Right'),
  };
  documents.left.presets[2].channels[2].gain = 3;
  documents.right.presets[0].channels[0].gain = -2;
  useWorkspace.setState({
    documents,
    slot: 'left',
    preset: 2,
    channel: 2,
    filter: 7,
    linkedEdits: true,
    linkedControls: false,
    documentRevision: 0,
    past: [],
    future: [],
    gesture: undefined,
    fileCommitReceipts: {},
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  seen.adapter = undefined;
  seen.writes = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
async function mountHidden() {
  await act(async () => root.render(<Studio />));
  await act(async () => seen.adapter!.view({ tab: 'Help' }));
  await seen.adapter!.persistence!.flush();
  seen.writes = [];
}
const execute = (name: Parameters<ReturnType<typeof createToolExecutor>>[0], args: unknown) =>
  createToolExecutor(seen.adapter!)(name, args);
function observePublications() {
  const publications: ReturnType<typeof state>['documents'][] = [];
  const stop = useWorkspace.subscribe((next, previous) => {
    if (next.documents !== previous.documents) publications.push(structuredClone(next.documents));
  });
  return { publications, stop };
}
function expectFinal(project: Project) {
  expect(globals(project)).toEqual(finalValues);
  expect(maxima(project)).toEqual(finalMaxima);
  expect(project.hfdSelectedPreset).toBe(1);
  expect(project.hfdSelectedGroupId).toBe(777);
}

it('Header native Open reconciles saved P3 and offline P1 before one selected-role publication despite Mirror', async () => {
  const incoming = nativeInput(),
    before = structuredClone(state().documents);
  await mountHidden();
  const observed = observePublications();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Open project"]')!.click(),
  );
  const picker = host.querySelector<HTMLInputElement>('input[type=file][hidden]')!;
  Object.defineProperty(picker, 'files', {
    configurable: true,
    value: [new NodeFile([incoming.content], 'Config.xml')],
  });
  await act(async () => {
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  observed.stop();
  expect(observed.publications).toHaveLength(1);
  expectFinal(observed.publications[0].left);
  expectFinal(state().documents.left);
  expect(state().documents.right).toEqual(before.right);
  expect(state().documents.left.presets[1]).toEqual(
    expect.objectContaining({
      channels: expect.arrayContaining([expect.objectContaining({ globalDelayUs: 101 })]),
    }),
  );
  expect(state()).toMatchObject({
    slot: 'left',
    preset: 0,
    channel: 2,
    filter: 7,
    documentRevision: 1,
  });
  expect(seen.adapter!.viewState!()).toMatchObject({ tab: 'Crossover', designer: 'chain' });
  expect(state().past).toHaveLength(1);
  await seen.adapter!.persistence!.flush();
  for (const write of seen.writes) expectFinal(write.state.documents.left);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
});

it('actual Studio MCP Both XML import publishes final Globals/Max once and one Undo restores independently different projects', async () => {
  const incoming = nativeInput(),
    before = structuredClone(state().documents);
  await mountHidden();
  const observed = observePublications();
  await act(async () => {
    expect(
      await execute('fusion_project_import', { target: 'both', content: incoming.content }),
    ).toMatchObject({ ok: true });
  });
  observed.stop();
  expect(observed.publications).toHaveLength(1);
  for (const slot of ['left', 'right'] as const) {
    expectFinal(observed.publications[0][slot]);
    expectFinal(state().documents[slot]);
  }
  expect(state().past).toHaveLength(1);
  await seen.adapter!.persistence!.flush();
  expect(seen.writes.length).toBeGreaterThan(0);
  for (const write of seen.writes)
    for (const slot of ['left', 'right'] as const) expectFinal(write.state.documents[slot]);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
});

it('actual Studio durable Both native commit persists final projects and receipt together, with passive replay after Undo', async () => {
  const incoming = nativeInput(),
    before = structuredClone(state().documents),
    principal = { owner: 'site:synthetic', scope: 'v55' };
  await mountHidden();
  const observed = observePublications(),
    replace = vi.fn((destination: Project) => {
      for (const key of Object.keys(destination)) Reflect.deleteProperty(destination, key);
      Object.assign(destination, structuredClone(incoming.decoded));
    });
  const metadata = {
    workflow: 'project',
    projectOpen: { kind: 'native-file-open', route: 'dialog' },
  };
  let receipt: unknown;
  await act(async () => {
    receipt = await seen.adapter!.files!.commit(
      'v55-native-final-both',
      principal,
      0,
      ['left', 'right'],
      replace,
      metadata,
      undefined,
      { synchronizeLinks: false },
    );
  });
  observed.stop();
  expect(observed.publications).toHaveLength(1);
  expect(replace).toHaveBeenCalledTimes(2);
  expect(state().past).toHaveLength(1);
  for (const slot of ['left', 'right'] as const) expectFinal(state().documents[slot]);
  expect(seen.writes.length).toBeGreaterThan(0);
  for (const write of seen.writes) {
    for (const slot of ['left', 'right'] as const) expectFinal(write.state.documents[slot]);
    expect(write.state.fileCommitReceipts!['v55-native-final-both']).toEqual(receipt);
  }
  await act(async () => seen.adapter!.undo());
  await seen.adapter!.persistence!.flush();
  expect(state().documents).toEqual(before);
  const afterUndo = state(),
    writes = seen.writes.length;
  await act(async () => {
    expect(
      await seen.adapter!.files!.commit(
        'v55-native-final-both',
        principal,
        0,
        ['left', 'right'],
        replace,
        metadata,
      ),
    ).toEqual(receipt);
  });
  expect(replace).toHaveBeenCalledTimes(2);
  expect(state().documents).toBe(afterUndo.documents);
  expect(state().documentRevision).toBe(afterUndo.documentRevision);
  expect(state().past).toEqual(afterUndo.past);
  expect(seen.writes).toHaveLength(writes);
});

it('actual Studio MCP JSON snapshot containing native source XML stays passive while Help is visible', async () => {
  const incoming = nativeInput(),
    before = structuredClone(state().documents);
  await mountHidden();
  const observed = observePublications();
  await act(async () => {
    expect(
      await execute('fusion_project_import', {
        target: 'both',
        content: JSON.stringify(incoming.decoded),
      }),
    ).toMatchObject({ ok: true });
  });
  observed.stop();
  expect(observed.publications).toHaveLength(1);
  expect(state().documents).toEqual({ left: incoming.decoded, right: incoming.decoded });
  expect(globals(state().documents.left)).toEqual(rawValues);
  expect(maxima(state().documents.right)).toEqual(rawMaxima);
  expect(state()).toMatchObject({ preset: 2, channel: 2, filter: 7 });
  expect(seen.adapter!.viewState!()).toMatchObject({ tab: 'Help' });
  expect(state().past).toHaveLength(1);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
});
