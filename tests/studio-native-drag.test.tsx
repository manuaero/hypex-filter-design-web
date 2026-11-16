// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';
import type { GraphViewState } from '../src/application/graph-view';
import { newFilter, newProject, type Project } from '../src/domain/model';
import { ensureWorkspaceHydrated, useWorkspace } from '../src/state/workspace';
import Studio from '../src/components/Studio';

const seen = vi.hoisted(() => ({ adapter: undefined as ToolAdapter | undefined }));
vi.mock('../src/components/AgentAccess', () => ({
  default: ({ adapter }: { adapter: ToolAdapter }) => {
    seen.adapter = adapter;
    return null;
  },
}));
// Studio and InteractivePlot remain real. Only the separate canvas renderer is
// unnecessary for these DOM pointer/selection/admission integration checks.
vi.mock('../src/components/ResponsePlot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/components/ResponsePlot')>()),
  default: () => null,
}));
vi.mock('../src/hardware/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/hardware/storage')>()),
  listBackups: async () => [],
}));
vi.mock('../src/application/workspace-authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/application/workspace-authority')>();
  return {
    ...actual,
    createWorkspaceAuthority: () =>
      actual.createWorkspaceAuthority({
        loadOrCreate: async () => ({ version: 1, id: '11111111-1111-4111-8111-111111111111' }),
      }),
  };
});
vi.mock('../src/state/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/state/workspace')>();
  const workspace = actual.createWorkspaceStore({
    read: async () => null,
    write: async () => {},
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
let host: HTMLDivElement, root: Root;
const state = () => useWorkspace.getState();
const current = (tab: 'Crossover' | 'Input EQ', role: 'left' | 'right' = 'left') =>
  tab === 'Input EQ'
    ? state().documents[role].presets[0].inputEq[0]
    : state().documents[role].presets[0].channels[0].filters[0];
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(468);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(262);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    top: 50,
    width: 468,
    height: 262,
    right: 568,
    bottom: 312,
    x: 100,
    y: 50,
    toJSON() {},
  });
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  await ensureWorkspaceHydrated();
  useWorkspace.setState({
    documents: { left: newProject('Left synthetic'), right: newProject('Right synthetic') },
    slot: 'left',
    preset: 0,
    channel: 0,
    filter: 0,
    linkedEdits: true,
    linkedControls: false,
    documentRevision: 0,
    past: [],
    future: [],
    gesture: undefined,
  });
  for (const tab of ['Crossover', 'Input EQ'] as const)
    for (const role of ['left', 'right'] as const) {
      const band = current(tab, role);
      Object.assign(band, {
        ...newFilter('peak'),
        frequency: 2300,
        q: role === 'left' ? 1.15 : 1.19,
        gain: role === 'left' ? 7.5 : -4,
        enabled: role === 'right',
        coefficients: { b0: 0.9, b1: 0.02, b2: -0.01, f1: 0.1, f2: 0.05 },
        provenance: role === 'left' ? 'hfd' : 'panel',
      });
    }
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  seen.adapter = undefined;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(tab: 'Crossover' | 'Input EQ') {
  await act(async () => root.render(<Studio />));
  if (tab === 'Input EQ') await act(async () => seen.adapter!.view({ tab: 'Input EQ', eqBand: 1 }));
  const beforeScope = structuredClone(state().documents),
    revision = state().documentRevision;
  await act(async () => seen.adapter!.view({ graph: { sectionScope: 'channel' } }));
  expect(state().documents).toEqual(beforeScope);
  expect(state().documentRevision).toBe(revision);
  expect((seen.adapter!.viewState!() as { graph: GraphViewState }).graph.sectionScope).toBe(
    'channel',
  );
  expect(host.querySelector('#selected-filter-inspector')).not.toBeNull();
}

async function pointer(type: string, x: number, y: number, target: Element, ctrlKey = false) {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x + 100,
    clientY: y + 50,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    ctrlKey,
  });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  await act(async () => target.dispatchEvent(e));
}
const marker = () => host.querySelector<HTMLButtonElement>('.interactive-plot [data-filter="0"]')!;
const plot = () => host.querySelector('.interactive-plot')!;
async function start(offsetX = 3.2, offsetY = 5.4) {
  const m = marker();
  await pointer(
    'pointerdown',
    parseFloat(m.style.left) + offsetX,
    parseFloat(m.style.top) + offsetY,
    m,
  );
}
it('actual Studio mirrors absolute frequency but adds gain to each independently captured role origin, with one exact Undo', async () => {
  await mount('Crossover');
  const before = structuredClone(state().documents);
  await start();
  await pointer('pointermove', 300.2, 90.2, plot());
  await pointer('pointerup', 300.2, 90.2, plot());
  expect(current('Crossover', 'left').frequency).toBe(current('Crossover', 'right').frequency);
  expect(current('Crossover', 'left').gain - current('Crossover', 'right').gain).toBe(11.5);
  expect(current('Crossover', 'left').enabled).toBe(false);
  expect(current('Crossover', 'right').enabled).toBe(true);
  expect(current('Crossover', 'left').frequency2).toBe(
    before.left.presets[0].channels[0].filters[0].frequency2,
  );
  expect(state().past).toHaveLength(1);
  expect(state().gesture).toBeUndefined();
  await act(async () => state().undo());
  expect(state().documents).toEqual(before);
});
it('a foreign MCP edit commits the pending owned drag; later pointer cancellation cannot roll it back', async () => {
  await mount('Crossover');
  await start();
  await pointer('pointermove', 300, 90, plot());
  const dragged = structuredClone(state().documents),
    execute = createToolExecutor(seen.adapter!);
  await act(async () => {
    const result = await execute('fusion_filter_set', {
      target: 'right',
      preset: 1,
      channel: 1,
      index: 1,
      patch: { q: 2 },
    });
    expect(result).toMatchObject({ ok: true });
  });
  const foreign = structuredClone(state().documents);
  await pointer('pointercancel', 300, 90, plot());
  expect(state().documents).toEqual(foreign);
  expect(state().documents.left).toEqual(dragged.left);
  expect(current('Crossover', 'right').q).toBe(2);
  await act(async () => state().undo());
  expect(state().documents).toEqual(dragged);
});
it('paired preflight refuses an inactive raw destination before opening or mutating either graph role', async () => {
  current('Crossover', 'right').kind = 'raw';
  await mount('Crossover');
  const before = structuredClone(state().documents),
    revision = state().documentRevision;
  await start();
  await pointer('pointermove', 300, 90, plot());
  await pointer('pointerup', 300, 90, plot());
  expect(state().documents).toEqual(before);
  expect(state().documentRevision).toBe(revision);
  expect(state().past).toHaveLength(0);
  expect(state().gesture).toBeUndefined();
});
it('mixed per-role ordinary kinds retain inactive destination gain while sharing absolute frequency', async () => {
  current('Crossover', 'right').kind = 'allpass2';
  const latent = current('Crossover', 'right').gain;
  await mount('Crossover');
  await start();
  await pointer('pointermove', 300, 90, plot());
  await pointer('pointerup', 300, 90, plot());
  expect(current('Crossover', 'right').gain).toBe(latent);
  expect(current('Crossover', 'right').frequency).toBe(current('Crossover', 'left').frequency);
});
it('an owned gesture with no delivered move retains exact imported cache, provenance and history', async () => {
  await mount('Crossover');
  const before = structuredClone(state().documents),
    revision = state().documentRevision;
  const m = marker(),
    x = parseFloat(m.style.left),
    y = parseFloat(m.style.top);
  await pointer('pointerdown', x, y, m);
  await pointer('pointerup', x, y, m);
  expect(state().documents).toEqual(before);
  expect(state().documentRevision).toBe(revision);
  expect(state().past).toHaveLength(0);
  expect(state().gesture).toBeUndefined();
});

it('an actually delivered canonical position no-op retains both independent caches and creates no Undo entry', async () => {
  for (const role of ['left', 'right'] as const) current('Crossover', role).frequency = 10;
  await mount('Crossover');
  const before = structuredClone(state().documents),
    revision = state().documentRevision,
    m = marker(),
    x = parseFloat(m.style.left),
    y = parseFloat(m.style.top);
  await pointer('pointerdown', x, y, m);
  await pointer('pointermove', x, y, plot());
  await pointer('pointerup', x, y, plot());
  expect(state().documents).toEqual(before);
  expect(state().documentRevision).toBe(revision);
  expect(state().past).toHaveLength(0);
  expect(state().gesture).toBeUndefined();
});
