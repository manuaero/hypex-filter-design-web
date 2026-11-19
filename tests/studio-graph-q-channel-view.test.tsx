// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ToolAdapter } from '../src/application/tools';
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
        gain: 7.5,
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
async function pointer(type: string, x: number, y: number, target: Element) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x + 100,
    clientY: y + 50,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    ctrlKey: true,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  await act(async () => target.dispatchEvent(event));
}
function verify(tab: 'Crossover' | 'Input EQ', before: { left: Project; right: Project }) {
  expect(current(tab)).toMatchObject({ q: 1.19, enabled: false });
  expect(current(tab).coefficients).toBeUndefined();
  expect(current(tab).provenance).toBeUndefined();
  expect(state().documents.right).toEqual(before.right);
  expect(state().past).toHaveLength(1);
}
it.each(['Crossover', 'Input EQ'] as const)(
  'actual %s whole-channel response still permits the selected filter chart-wide Ctrl-wheel Q',
  async (tab) => {
    await mount(tab);
    const before = structuredClone(state().documents);
    const chart = host.querySelector('.plot-interaction')!;
    await act(async () =>
      chart.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }),
      ),
    );
    verify(tab, before);
    await act(async () => state().undo());
    expect(state().documents).toEqual(before);
  },
);
it.each(['Crossover', 'Input EQ'] as const)(
  'actual %s whole-channel response still permits captured-Ctrl Q drag and one exact Undo',
  async (tab) => {
    await mount(tab);
    const before = structuredClone(state().documents),
      marker = host.querySelector<HTMLButtonElement>('.interactive-plot [data-filter="0"]')!;
    expect(marker).not.toBeNull();
    const x = parseFloat(marker.style.left),
      y = parseFloat(marker.style.top),
      plot = host.querySelector('.interactive-plot')!;
    await pointer('pointerdown', x, y, marker);
    await pointer('pointermove', x + 24, y - 20, plot);
    await pointer('pointerup', x + 24, y - 20, plot);
    verify(tab, before);
    await act(async () => state().undo());
    expect(state().documents).toEqual(before);
  },
);

it.each(['Crossover', 'Input EQ'] as const)(
  '%s wheel navigation preserves both amplifier documents and filter Undo history',
  async (tab) => {
    await mount(tab);
    const before = structuredClone(state().documents),
      revision = state().documentRevision;
    await act(async () =>
      host
        .querySelector('.plot-interaction')!
        .dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: -120,
            clientX: 348,
            clientY: 174,
            bubbles: true,
            cancelable: true,
          }),
        ),
    );
    expect(state().documents).toEqual(before);
    expect(state().documentRevision).toBe(revision);
    expect(state().past).toHaveLength(0);
  },
);
