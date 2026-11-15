// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';
import type { GraphViewState } from '../src/application/graph-view';
import type { MagnitudeLayers } from '../src/domain/plot-layers';
import type { PlotRange } from '../src/domain/plot-viewport';
import { rectangleZoom, type RectangleZoom } from '../src/components/plot-zoom-geometry';
import type { PlotViewSnapshot } from '../src/application/plot-view';
import { newFilter, newProject, type Slot } from '../src/domain/model';
import { parseProject } from '../src/domain/files';
import * as projectFiles from '../src/domain/files';
import type { DirectorySaveBinding } from '../src/application/project-directory-writer';
import type { WorkspaceAuthority } from '../src/application/workspace-authority';
import type { DirectoryLegacyReview } from '../src/application/workspace-directory';
import { WebHidTransport } from '../src/hardware/transport';
import { SimulatedPanel } from '../src/hardware/simulator';
import Studio from '../src/components/Studio';
import { HELP_RESOURCES } from '../src/application/help-resources';
import { ensureWorkspaceHydrated, useWorkspace } from '../src/state/workspace';

const seen = vi.hoisted(() => ({
  adapter: undefined as ToolAdapter | undefined,
  authority: undefined as WorkspaceAuthority | undefined,
  save: undefined as
    | undefined
    | {
        captureBinding: () => DirectorySaveBinding;
        projectName?: string;
        onDownloadJson?: () => void;
        onClose: () => void;
        initialLegacyReview?: DirectoryLegacyReview;
      },
  plot: undefined as
    | {
        magnitudeLayers?: MagnitudeLayers;
        phaseLayers?: GraphViewState['phase'];
        selectedFilter?: number | null;
        measured: boolean;
        sum: boolean;
        range: Readonly<PlotRange>;
        onRectangleZoom: (zoom: RectangleZoom, range: Readonly<PlotRange>) => void;
        onResetRange: () => void;
        onRemove: () => void;
        contextKey?: string;
      }
    | undefined,
}));
vi.mock('../src/components/AgentAccess', () => ({
  default: ({ adapter, authority }: { adapter: ToolAdapter; authority?: WorkspaceAuthority }) => {
    seen.adapter = adapter;
    seen.authority = authority;
    return null;
  },
}));
vi.mock('../src/components/ProjectSaveDialog', () => ({
  default: (props: NonNullable<typeof seen.save>) => {
    seen.save = props;
    return <div role="dialog" aria-label="Save project folder" />;
  },
}));
vi.mock('../src/components/InteractivePlot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/components/InteractivePlot')>()),
  default: (props: NonNullable<typeof seen.plot>) => {
    seen.plot = props;
    return <div data-testid="plot" />;
  },
}));
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
  let stored: unknown = null;
  const actual = await importOriginal<typeof import('../src/state/workspace')>(),
    workspace = actual.createWorkspaceStore({
      read: async () => structuredClone(stored),
      write: async (value) => {
        stored = structuredClone(value);
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

let host: HTMLDivElement, root: Root;
let restoreTestHid: (() => void) | undefined;
const state = () => useWorkspace.getState();
const view = () =>
  seen.adapter!.viewState!() as {
    graph: GraphViewState;
    graphs: Record<string, GraphViewState>;
    mode: string;
    plotViews: PlotViewSnapshot;
    timeMinMs: number;
    timeMaxMs: number;
    amplitudeMin: number;
    amplitudeMax: number;
  };
async function mount() {
  await act(async () => root.render(<Studio />));
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: vi.fn(),
  });
  await ensureWorkspaceHydrated();
  useWorkspace.setState({
    documents: { left: newProject('Left'), right: newProject('Right') },
    slot: 'left',
    preset: 0,
    channel: 0,
    filter: 0,
    linkedEdits: false,
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
  seen.authority = undefined;
  seen.save = undefined;
  seen.plot = undefined;
});
afterEach(async () => {
  await act(async () => root.unmount());
  restoreTestHid?.();
  restoreTestHid = undefined;
  host.remove();
  vi.restoreAllMocks();
});

function seedNativeDeleteCase(enabled = true) {
  const documents = structuredClone(state().documents),
    channel = documents.left.presets[0].channels[0];
  channel.filters.forEach((_, i) => {
    channel.filters[i] = { ...newFilter('peak'), frequency: 100 + i, gain: 0 };
  });
  channel.filters[0] = {
    ...newFilter('lowpass2'),
    id: 'native-delete-slot',
    sourceId: '13',
    sourceType: 'ftLowPass2',
    enabled,
    frequency: 720,
    q: 0.4,
    frequency2: 988.101806640625,
    q2: 0.7,
    gain: 0,
    shelfDirection: 'low',
    provenance: 'hfd',
    coefficients: { b0: 0.1, b1: 0, b2: 0, f1: 0.8, f2: -0.2 },
  };
  channel.coefficientCache = 'effective';
  useWorkspace.setState({ documents });
}

it('card Remove retains native slot state and Add reuses enabled Unity through the actual palette commit', async () => {
  seedNativeDeleteCase();
  await mount();
  const before = structuredClone(state().documents),
    previous = before.left.presets[0].channels[0].filters[0];
  const remove = host.querySelector<HTMLButtonElement>('button[aria-label="Remove section 1"]')!;
  expect(remove).not.toBeNull();
  await act(async () => remove.click());
  const deleted = state().documents.left.presets[0].channels[0].filters[0];
  expect(deleted).toMatchObject({
    id: previous.id,
    sourceId: '13',
    kind: 'unity',
    enabled: true,
    frequency: 720,
    q: 0.4,
    frequency2: 988.101806640625,
    q2: 0.7,
    gain: 0,
  });
  expect(state().documents.right).toEqual(before.right);
  expect(host.querySelector('.add-filter-card')?.textContent).toContain('1 sections available');
  await act(async () => (host.querySelector('.add-filter-card') as HTMLButtonElement).click());
  const add = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Add to design'),
  )!;
  expect(add).toBeDefined();
  expect(add.disabled).toBe(false);
  await act(async () => add.click());
  expect(state().documents.left.presets[0].channels[0].filters[0]).toMatchObject({
    id: previous.id,
    sourceId: '13',
    kind: 'peak',
    enabled: true,
    gain: 3,
  });
  expect(state().documents.right).toEqual(before.right);
  await act(async () => state().undo());
  expect(state().documents.left.presets[0].channels[0].filters[0]).toEqual(deleted);
  await act(async () => state().undo());
  expect(state().documents).toEqual(before);
});

it('graph Delete uses native latent retention while explicit inspector Reset stays broader and Undo restores Delete', async () => {
  seedNativeDeleteCase(false);
  await mount();
  const right = structuredClone(state().documents.right);
  await act(async () => seen.plot!.onRemove());
  const deleted = structuredClone(state().documents.left.presets[0].channels[0].filters[0]);
  expect(deleted).toMatchObject({
    id: 'native-delete-slot',
    sourceId: '13',
    kind: 'unity',
    enabled: false,
    frequency: 720,
    q: 0.4,
  });
  const reset = host.querySelector<HTMLButtonElement>('button[title="Reset selected filter"]')!;
  await act(async () => reset.click());
  expect(state().documents.left.presets[0].channels[0].filters[0]).toMatchObject({
    kind: 'unity',
    enabled: false,
    frequency: 1000,
    q: Math.SQRT1_2,
  });
  const execute = createToolExecutor(seen.adapter!);
  await act(async () => {
    await execute('fusion_history', { action: 'undo' });
  });
  expect(state().documents.left.presets[0].channels[0].filters[0]).toEqual(deleted);
  expect(state().documents.right).toEqual(right);
});

it('F1, the Help rail and agent Help share local reference views without editing either project', async () => {
  await mount();
  const documents = structuredClone(state().documents),
    selection = [state().slot, state().preset, state().channel, state().filter],
    execute = createToolExecutor(seen.adapter!);
  const helpKey = new KeyboardEvent('keydown', { key: 'F1', cancelable: true });
  await act(async () => window.dispatchEvent(helpKey));
  expect(helpKey.defaultPrevented).toBe(true);
  expect(host.querySelector('[aria-label="Help"]')?.getAttribute('aria-current')).toBe('page');
  expect(host.querySelector('h1')?.textContent).toBe('Help & About');
  if (HELP_RESOURCES.manual.bundled)
    expect(host.querySelector('a[href="/help/hfdhelp-v3.pdf#page=2"]')).not.toBeNull();
  else {
    expect(host.querySelector('a[href^="/help/"]')).toBeNull();
    expect(host.textContent).toContain('optional HFD PDF is not included');
    expect(host.querySelector(`a[href="${HELP_RESOURCES.manual.fallbackUrl}"]`)).not.toBeNull();
  }
  await act(async () =>
    Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === 'View verification')!
      .click(),
  );
  expect(host.querySelector('h1')?.textContent).toBe('Verification ledger');
  await act(async () => {
    expect(await execute('fusion_help', { action: 'resources' })).toMatchObject({
      ok: true,
      resources: { manual: { generalUrl: '/help/hfdhelp-v3.pdf#page=2' } },
    });
  });
  expect(host.querySelector('h1')?.textContent).toBe('Verification ledger');
  await act(async () => {
    expect(await execute('fusion_help', { action: 'show' })).toMatchObject({
      ok: true,
      view: 'Help',
    });
  });
  expect(host.querySelector('h1')?.textContent).toBe('Help & About');
  await act(async () => {
    expect(await execute('fusion_view', { tab: 'Verification' })).toEqual({ ok: true });
  });
  const modified = new KeyboardEvent('keydown', { key: 'F1', shiftKey: true, cancelable: true });
  await act(async () => window.dispatchEvent(modified));
  expect(modified.defaultPrevented).toBe(false);
  expect(host.querySelector('h1')?.textContent).toBe('Verification ledger');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Help"]')!.click());
  expect(host.querySelector('h1')?.textContent).toBe('Help & About');
  expect(state().documents).toEqual(documents);
  expect([state().slot, state().preset, state().channel, state().filter]).toEqual(selection);
  expect(state().documentRevision).toBe(0);
  expect(state().past).toHaveLength(0);
  expect(seen.adapter!.connections()).toEqual({});
});

it('header Save captures its exact role, revision and download snapshot while later navigation and edits cannot retarget it', async () => {
  const download = vi.spyOn(projectFiles, 'download').mockImplementation(() => {});
  await mount();
  const initial = structuredClone(state().documents.left);
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Save project"]')!.click(),
  );
  expect(seen.save?.projectName).toBe('Left');
  const binding = seen.save!.captureBinding();
  expect(binding).toMatchObject({ slot: 'left', expectedRevision: 0 });
  expect(binding.principal.owner).toBe('workspace:11111111-1111-4111-8111-111111111111');
  const execute = createToolExecutor(seen.adapter!);
  expect(
    await execute('fusion_project_save', { action: 'status' }, binding.principal),
  ).toMatchObject({
    ok: true,
    saves: { captures: [{ id: binding.exportId, target: 'left', phase: 'staged' }] },
  });
  await act(async () => seen.adapter!.choose({ slot: 'right' }));
  await act(async () =>
    state().editAt(['left'], (p) => {
      p.name = 'Newer Left';
    }),
  );
  expect(seen.save!.captureBinding()).toEqual(binding);
  expect(seen.save?.projectName).toBe('Left');
  await act(async () => {
    await seen.save!.onDownloadJson!();
  });
  expect(
    await execute(
      'fusion_project_save',
      { action: 'resolve', id: binding.exportId },
      binding.principal,
    ),
  ).toMatchObject({
    ok: true,
    id: binding.exportId,
    roles: [{ slot: 'left' }],
  });
  expect(download).toHaveBeenCalledExactlyOnceWith(
    'Left.fusion.json',
    JSON.stringify(initial, null, 2),
  );
  expect(state().documents.right.name).toBe('Right');
  await act(async () => seen.save!.onClose());
  expect(host.querySelector('[role="dialog"][aria-label="Save project folder"]')).toBeNull();
});

it('Strict Mode effect replay retains a ready workspace authority and human Save capability', async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <Studio />
      </StrictMode>,
    ),
  );
  expect(seen.authority!.getSnapshot()).toMatchObject({
    phase: 'ready',
    owner: 'workspace:11111111-1111-4111-8111-111111111111',
  });
  const saveButton = host.querySelector<HTMLButtonElement>('[aria-label="Save project"]')!;
  expect(saveButton.disabled).toBe(false);
  await act(async () => saveButton.click());
  const binding = seen.save!.captureBinding();
  expect(seen.authority!.isLocalHuman(binding.principal)).toBe(true);
  expect(binding.principal.owner).toBe(seen.authority!.getSnapshot().owner);
  const execute = createToolExecutor(seen.adapter!);
  expect(
    await execute('fusion_device_defaults', { action: 'status' }, binding.principal),
  ).toMatchObject({
    ok: true,
    defaults: { phase: 'idle', busy: false, records: [] },
  });
  expect(
    await execute('fusion_limiter_editor', { action: 'status' }, binding.principal),
  ).toMatchObject({
    ok: true,
    limiter: { phase: 'idle', busy: false, revision: 0 },
  });
});

it('an agent-staged older record review captures its own role without retargeting an open review or editing either project', async () => {
  await mount();
  const documents = structuredClone(state().documents);
  const review: DirectoryLegacyReview = {
    id: 'legacy-review',
    recordId: 'legacy-record',
    slot: 'right',
    phase: 'complete',
    envelopeRevision: 3,
    manifestSha256: 'a'.repeat(64),
    proposal: {
      id: 'legacy-record',
      slot: 'right',
      phase: 'complete',
      expectedRevision: 0,
      mode: 'save-as',
      rootId: 'older-root',
      folderName: 'Older Right',
      createdAt: 1,
      files: [],
      requiresOverwriteConfirmation: false,
      recoveryAvailable: true,
      workspaceChanged: true,
      needsLocalAdoption: true,
    },
  };
  let opened = false;
  await act(async () => {
    opened = seen.adapter!.reviewDirectoryLegacy!(review);
  });
  expect(opened).toBe(true);
  expect(seen.save!.initialLegacyReview).toBe(review);
  expect(seen.save!.captureBinding().slot).toBe('right');
  expect(seen.authority!.isLocalHuman(seen.save!.captureBinding().principal)).toBe(true);
  expect(state().slot).toBe('left');
  const second = {
    ...review,
    id: 'second-review',
    recordId: 'second-record',
    slot: 'left' as const,
    proposal: {
      ...review.proposal,
      id: 'second-record',
      slot: 'left' as const,
      folderName: 'Older Left',
    },
  };
  await act(async () => {
    opened = seen.adapter!.reviewDirectoryLegacy!(second);
  });
  expect(opened).toBe(false);
  expect(seen.save!.initialLegacyReview).toBe(review);
  await act(async () => seen.save!.onClose());
  await act(async () => {
    opened = seen.adapter!.reviewDirectoryLegacy!(second);
  });
  expect(opened).toBe(true);
  expect(seen.save!.captureBinding().slot).toBe('left');
  expect(state().documents).toEqual(documents);
  expect(state().documentRevision).toBe(0);
  expect(state().past).toHaveLength(0);
});

it('Ctrl/Cmd S and the shared agent view open the same folder-save UI without automatic downloads or amplifier access', async () => {
  const download = vi.spyOn(projectFiles, 'download').mockImplementation(() => {});
  await mount();
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }),
    ),
  );
  expect(seen.save!.captureBinding().slot).toBe('left');
  expect(download).not.toHaveBeenCalled();
  await act(async () => seen.save!.onClose());
  await act(async () => seen.adapter!.choose({ slot: 'right' }));
  await act(async () => {
    expect(
      await createToolExecutor(seen.adapter!)('fusion_view', { projectSavePanel: true }),
    ).toEqual({ ok: true });
  });
  expect(seen.save!.captureBinding().slot).toBe('right');
  expect(seen.adapter!.connections()).toEqual({});
  await act(async () => {
    expect(
      await createToolExecutor(seen.adapter!)('fusion_view', { projectSavePanel: false }),
    ).toEqual({ ok: true });
  });
  expect(host.querySelector('[role="dialog"][aria-label="Save project folder"]')).toBeNull();
  expect(download).not.toHaveBeenCalled();
});

it('passively restores saved native flags without changing documents/history and preserves legacy default rendering', async () => {
  state().documents.left.presets[0].channels[0].hfdGraph = {
    showMeasuredResponse: true,
    showSum: false,
  };
  const before = structuredClone(state().documents);
  await mount();
  expect(view().graph).toMatchObject({
    sum: false,
    measured: false,
    rawMeasurements: [false, false, false],
    section: false,
    otherResults: true,
  });
  expect(state().documents).toEqual(before);
  expect(state().documentRevision).toBe(0);
  expect(state().past).toHaveLength(0);
  expect(seen.plot?.magnitudeLayers).toBeUndefined();
  expect(host.querySelector('summary[aria-label="Graph layers"]')).not.toBeNull();
});

it('real Layers UI and MCP share role-local presentation; native writeback ignores mirror/link expansion', async () => {
  const left = state().documents.left.presets[0].channels;
  left[0].measurement = {
    name: 'source.frd',
    sampleRate: 48000,
    frequency: [10, 1000],
    magnitude: [0, -3],
    phase: [0, 0],
  };
  left[0].hfdGraph = { showMeasuredResponse: false, showSum: true };
  left[1].linkedTo = 0;
  left[1].hfdGraph = { showMeasuredResponse: true, showSum: false };
  useWorkspace.setState({ linkedEdits: true });
  const rightBefore = structuredClone(state().documents.right),
    otherFlags = structuredClone(left[1].hfdGraph);
  await mount();
  const hfd = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'HFD view',
  )!;
  await act(async () => hfd.click());
  expect(view().graph).toMatchObject({
    measured: true,
    otherResults: false,
    section: true,
    sectionScope: 'selected',
    nativeTracking: true,
  });
  expect(seen.plot?.magnitudeLayers).toMatchObject({
    currentResult: true,
    otherResults: false,
    section: true,
  });
  expect(seen.plot?.selectedFilter).toBe(0);
  await act(async () =>
    seen.adapter!.view({ graph: { rawMeasurements: [true, false, false], sum: false } }),
  );
  expect(state().documents.left.presets[0].channels[0].hfdGraph).toEqual({
    showMeasuredResponse: true,
    showSum: false,
  });
  expect(state().documents.left.presets[0].channels[1].hfdGraph).toEqual(otherFlags);
  expect(state().documents.right).toEqual(rightBefore);
  expect(state().past).toHaveLength(1);
  await act(async () => seen.adapter!.choose({ slot: 'right' }));
  expect(view().graph).toMatchObject({
    measured: false,
    sum: true,
    otherResults: true,
    section: false,
    nativeTracking: false,
  });
  expect(seen.plot?.magnitudeLayers).toBeUndefined();
  await act(async () => seen.adapter!.choose({ slot: 'left' }));
  expect(view().graph).toMatchObject({
    measured: true,
    sum: false,
    otherResults: false,
    section: true,
    rawMeasurements: [true, false, false],
  });
  await act(async () => seen.adapter!.view({ graph: { sectionScope: 'channel' } }));
  expect(seen.plot?.selectedFilter).toBeNull();
});

it('explicit selection normalizes only its current native flag; Undo restores canonical flag without a hydration writeback', async () => {
  const target = state().documents.left.presets[0].channels[1];
  target.hfdGraph = { showMeasuredResponse: true, showSum: false };
  const rightBefore = structuredClone(state().documents.right);
  await mount();
  expect(state().documents.left.presets[0].channels[1].hfdGraph!.showMeasuredResponse).toBe(true);
  await act(async () => seen.adapter!.choose({ channel: 1, filter: 0 }));
  expect(state().channel).toBe(1);
  expect(state().documents.left.presets[0].channels[1].hfdGraph).toEqual({
    showMeasuredResponse: false,
    showSum: false,
  });
  expect(state().past).toHaveLength(1);
  expect(view().graph).toMatchObject({
    rawMeasurements: [false, false, false],
    sum: false,
    section: false,
  });
  await act(async () => seen.adapter!.undo());
  expect(state().documents.left.presets[0].channels[1].hfdGraph!.showMeasuredResponse).toBe(true);
  expect(state().past).toHaveLength(0);
  expect(state().future).toHaveLength(1);
  expect(view().graph.rawMeasurements[1]).toBe(false);
  expect(state().documents.right).toEqual(rightBefore);
});

it('rejects unloaded raw and conflicting alias requests before any view/document change', async () => {
  await mount();
  const before = structuredClone(state().documents),
    snapshot = view().graphs;
  expect(() =>
    seen.adapter!.view({ mode: 'Phase', graph: { rawMeasurements: [true, false, false] } }),
  ).toThrow(/Load/);
  expect(view().mode).toBe('Magnitude');
  expect(view().graphs).toBe(snapshot);
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
  expect(() => seen.adapter!.view({ sum: true, graph: { sum: false } })).toThrow(/Conflicting/);
  expect(view().graphs).toBe(snapshot);
});

it('shared MCP viewport updates retain separate axes while only explicit Crossover Impulse bounds save role-local native metadata', async () => {
  await mount();
  const before = structuredClone(state().documents);
  await act(async () =>
    seen.adapter!.view({
      mode: 'Impulse',
      timeMinMs: -10,
      timeMaxMs: 90,
      amplitudeMin: -2,
      amplitudeMax: 4,
    }),
  );
  const expected = structuredClone(before);
  expected.left.presets[0].channels[0].hfdImpulseZoom = {
    left: -0.01,
    right: 0.09,
    top: 4,
    bottom: -2,
    use: true,
  };
  expect(state().documents).toEqual(expected);
  expect(state().past).toHaveLength(1);
  await act(async () =>
    seen.adapter!.view({
      mode: 'Step',
      timeMinMs: 20,
      timeMaxMs: 80,
      amplitudeMin: -8,
      amplitudeMax: 12,
    }),
  );
  await act(async () =>
    seen.adapter!.view({
      mode: 'Phase',
      frequencyMin: 20,
      frequencyMax: 20000,
      dbMin: -90,
      dbMax: 90,
    }),
  );
  await act(async () => seen.adapter!.view({ mode: 'Impulse' }));
  expect(seen.plot!.range).toMatchObject({
    timeMinMs: -10,
    timeMaxMs: 90,
    amplitudeMin: -2,
    amplitudeMax: 4,
  });
  await act(async () => seen.adapter!.view({ tab: 'Device settings' }));
  await act(async () => seen.adapter!.view({ tab: 'Crossover' }));
  expect(seen.plot!.range).toMatchObject({ timeMinMs: -10, amplitudeMin: -2 });
  expect(state().documents).toEqual(expected);
  expect(state().past).toHaveLength(1);
  await act(async () => seen.adapter!.choose({ slot: 'right' }));
  await act(async () =>
    seen.adapter!.view({ timeMinMs: 0, timeMaxMs: 50, amplitudeMin: -1, amplitudeMax: 1 }),
  );
  expected.right.presets[0].channels[0].hfdImpulseZoom = {
    left: 0,
    right: 0.05,
    top: 1,
    bottom: -1,
    use: true,
  };
  expect(state().documents).toEqual(expected);
  expect(state().past).toHaveLength(2);
  await act(async () => seen.adapter!.choose({ slot: 'left' }));
  expect(view()).toMatchObject({
    timeMinMs: -10,
    timeMaxMs: 90,
    amplitudeMin: -2,
    amplitudeMax: 4,
  });
  expect(view().plotViews.left.Step.range).toMatchObject({
    timeMinMs: 20,
    timeMaxMs: 80,
    amplitudeMin: -8,
    amplitudeMax: 12,
  });
  expect(view().plotViews.left.Phase.range).toMatchObject({
    frequencyMin: 20,
    frequencyMax: 20000,
    dbMin: -90,
    dbMax: 90,
  });
  expect(view().plotViews.right.Impulse.range).toMatchObject({ timeMinMs: 0, timeMaxMs: 50 });
  expect(state().documents).toEqual(expected);
  expect(state().past).toHaveLength(2);
  const step = view().plotViews.left.Step.range;
  await act(async () => seen.adapter!.undo());
  delete expected.right.presets[0].channels[0].hfdImpulseZoom;
  expect(state().documents).toEqual(expected);
  expect(state().past).toHaveLength(1);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
  expect(view().plotViews.left.Step.range).toEqual(step);
});

async function zoomCurrentPlot() {
  const range = seen.plot!.range,
    axes = {
      xMin: range.timeMinMs,
      xMax: range.timeMaxMs,
      yMin: range.amplitudeMin,
      yMax: range.amplitudeMax,
      xScale: 'linear' as const,
    };
  await act(async () =>
    seen.plot!.onRectangleZoom(
      rectangleZoom(
        axes,
        { x: 25, y: 25 },
        { x: 75, y: 75 },
        { left: 0, top: 0, width: 100, height: 100 },
      ),
      range,
    ),
  );
}
it('chart unmount retains reverse history; MCP Back and UI Reset use the same hoisted state', async () => {
  await mount();
  const before = structuredClone(state().documents);
  await act(async () =>
    seen.adapter!.view({
      mode: 'Step',
      timeMinMs: 0,
      timeMaxMs: 100,
      amplitudeMin: -4,
      amplitudeMax: 8,
    }),
  );
  await zoomCurrentPlot();
  const first = { ...seen.plot!.range };
  await zoomCurrentPlot();
  expect(view().plotViews.left.Step.undoDepth).toBe(2);
  await act(async () => seen.adapter!.view({ tab: 'Device settings' }));
  await act(async () => seen.adapter!.view({ tab: 'Crossover', zoomBack: true }));
  expect(seen.plot!.range).toEqual(first);
  await act(async () => seen.plot!.onResetRange());
  expect(view().plotViews.left.Step.canReverse).toBe(false);
  expect(view().plotViews.left.Step.range.amplitudeMin).toBe(-1);
  expect(view().plotViews.left.Step.range.amplitudeMax).toBe(1);
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
});

it('explicit measurement Load and Clear refresh current Phase visibility once while processing edits preserve it', async () => {
  state().documents.left.presets[0].channels[0].measurement = {
    name: 'phase.frd',
    sampleRate: 48000,
    frequency: [10, 1000],
    magnitude: [0, -3],
    phase: [0, 0],
  };
  await mount();
  const execute = createToolExecutor(seen.adapter!);
  await act(async () => {
    await execute('fusion_view', {
      mode: 'Phase',
      graph: { phase: { channels: [false, false, false] } },
    });
  });
  await act(async () =>
    expect(
      await execute('fusion_measurement_smooth', {
        target: 'left',
        preset: 1,
        channel: 1,
        octaves: 0.1,
      }),
    ).toEqual({ ok: true }),
  );
  expect(view().graph.phase.channels).toEqual([false, false, false]);
  await act(async () =>
    expect(
      await execute('fusion_measurement_set', {
        target: 'left',
        preset: 1,
        channel: 1,
        text: '10 0 0\n1000 -3 0',
        name: 'new.frd',
        format: 'frequency',
      }),
    ).toEqual({ ok: true }),
  );
  expect(view().graph.phase.channels).toEqual([true, false, false]);
  expect(state().past).toHaveLength(2);
  await act(async () => {
    await execute('fusion_view', { graph: { phase: { channels: [false, false, false] } } });
  });
  await act(async () =>
    expect(
      await execute('fusion_measurement_set', {
        target: 'left',
        preset: 1,
        channel: 1,
        text: null,
        name: '',
      }),
    ).toEqual({ ok: true }),
  );
  expect(view().graph.phase.channels).toEqual([true, false, false]);
  expect(state().past).toHaveLength(3);
  expect(host.querySelector<HTMLInputElement>('[aria-label="Show Woofer phase"]')!.disabled).toBe(
    true,
  );
});

it('actual Measurements Flat/Clear and newly applied file imports refresh Phase without replay refresh', async () => {
  await mount();
  const execute = createToolExecutor(seen.adapter!);
  await act(async () => {
    await execute('fusion_view', { tab: 'Measurements', mode: 'Phase' });
  });
  const clickImport = async (name: string) =>
    act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>('.measurement-imports button')]
        .find((button) => button.textContent?.trim() === name)!
        .click();
    });
  await clickImport('Flat');
  expect(view().graph.phase.channels).toEqual([true, false, false]);
  await act(async () => {
    await execute('fusion_view', { graph: { phase: { channels: [false, false, false] } } });
  });
  await clickImport('Clear');
  expect(view().graph.phase.channels).toEqual([true, false, false]);
  expect(state().past).toHaveLength(2);
  const revision = state().documentRevision ?? 0;
  const owner = {
    owner: 'workspace:11111111-1111-4111-8111-111111111111',
    scope: 'test:phase-file',
  };
  const apply = vi.fn((project: ReturnType<typeof newProject>) => {
    project.presets[0].channels[0].measurement = {
      name: 'imported.frd',
      sampleRate: 48000,
      frequency: [10, 1000],
      magnitude: [0, -3],
      phase: [0, 0],
    };
  });
  await act(async () => {
    await seen.adapter!.files!.commit('phase-file', owner, revision, ['left'], apply, {
      workflow: 'measurement-text',
      preset: 1,
      channel: 1,
    });
  });
  expect(apply).toHaveBeenCalledTimes(1);
  await act(async () => {
    await execute('fusion_view', { graph: { phase: { channels: [false, false, false] } } });
  });
  await act(async () => {
    await seen.adapter!.files!.commit('phase-file', owner, revision, ['left'], apply, {
      workflow: 'measurement-text',
      preset: 1,
      channel: 1,
    });
  });
  expect(apply).toHaveBeenCalledTimes(1);
  expect(view().graph.phase.channels).toEqual([false, false, false]);
  expect(state().past).toHaveLength(3);
});
it('native forward Impulse coupling changes only Step timeX and reverse keeps Step axes intact', async () => {
  await mount();
  await act(async () =>
    seen.adapter!.view({
      mode: 'Step',
      timeMinMs: -50,
      timeMaxMs: 150,
      amplitudeMin: -8,
      amplitudeMax: 8,
    }),
  );
  await act(async () =>
    seen.adapter!.view({
      mode: 'Impulse',
      timeMinMs: 0,
      timeMaxMs: 100,
      amplitudeMin: -2,
      amplitudeMax: 6,
    }),
  );
  await zoomCurrentPlot();
  expect(view().plotViews.left.Step.range).toMatchObject({
    timeMinMs: 25,
    timeMaxMs: 75,
    amplitudeMin: -8,
    amplitudeMax: 8,
  });
  await act(async () => seen.adapter!.view({ zoomBack: true }));
  expect(view().plotViews.left.Impulse.range).toMatchObject({
    timeMinMs: 0,
    timeMaxMs: 100,
    amplitudeMin: -2,
    amplitudeMax: 6,
  });
  expect(view().plotViews.left.Step.range).toMatchObject({
    timeMinMs: 25,
    timeMaxMs: 75,
    amplitudeMin: -8,
    amplitudeMax: 8,
  });
  const before = view().plotViews;
  expect(() => seen.adapter!.view({ mode: 'Phase', dbMin: 90, dbMax: -90 })).toThrow(/minimum/);
  expect(view().plotViews).toBe(before);
});

function importedAsymmetric() {
  const source = newProject('Imported precise values');
  source.presets[0].channels[0].filters[0] = {
    ...newFilter('asymmetric'),
    frequency: 5.049999999999999,
    frequency2: 2050.0499999999997,
    gain: 4,
    shelfDirection: 'low',
  };
  const parsed = parseProject(JSON.stringify(source));
  useWorkspace.setState({ documents: { ...state().documents, left: parsed } });
  return structuredClone(parsed);
}
async function differingRoleAndModeBounds() {
  await act(async () => seen.adapter!.view({ mode: 'Magnitude', frequencyMax: 1234.5 }));
  await act(async () => seen.adapter!.choose({ slot: 'right' }));
  await act(async () => seen.adapter!.view({ mode: 'Magnitude', frequencyMax: 777.7 }));
  await act(async () => seen.adapter!.choose({ slot: 'left' }));
  await act(async () => seen.adapter!.view({ mode: 'Phase', frequencyMax: 9000 }));
}
async function spin(field: HTMLInputElement, deltaY: number) {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  await act(async () => field.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
}
const selectedFilter = (slot: Slot = 'left') =>
  state().documents[slot].presets[0].channels[0].filters[0];

it('actual inspector F1/F2 wheel uses min10 and the selected role Magnitude maximum while Phase is visible; imported values and exact Undo survive', async () => {
  const imported = importedAsymmetric();
  await mount();
  await differingRoleAndModeBounds();
  const original = structuredClone(state().documents),
    inspector = host.querySelector('#selected-filter-inspector')!;
  expect(selectedFilter().frequency).toBe(imported.presets[0].channels[0].filters[0].frequency);
  expect(selectedFilter().frequency2).toBe(imported.presets[0].channels[0].filters[0].frequency2);
  expect(view().mode).toBe('Phase');
  expect(state().past).toHaveLength(0);
  await spin(inspector.querySelector<HTMLInputElement>('input[aria-label="Zero frequency"]')!, 120);
  expect(selectedFilter().frequency).toBe(10);
  expect(state().past).toHaveLength(1);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(original);
  await spin(
    inspector.querySelector<HTMLInputElement>('input[aria-label="Pole frequency"]')!,
    -120,
  );
  expect(selectedFilter().frequency2).toBe(1234.5);
  expect(state().past).toHaveLength(1);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(original);
  // Repeating an explicit wheel action after external Undo must edit again.
  await spin(inspector.querySelector<HTMLInputElement>('input[aria-label="Zero frequency"]')!, 120);
  expect(selectedFilter().frequency).toBe(10);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(original);
});

it('actual palette F1/F2 draft retains its captured role Magnitude bounds after selection changes and edits no document until Apply', async () => {
  const imported = importedAsymmetric();
  await mount();
  await differingRoleAndModeBounds();
  const before = structuredClone(state().documents);
  await act(async () => host.querySelector<HTMLButtonElement>('.inspector-shape')!.click());
  const dialog = host.querySelector<HTMLDialogElement>('dialog[aria-label="Change filter type"]')!;
  expect(dialog).not.toBeNull();
  expect(selectedFilter().frequency).toBe(imported.presets[0].channels[0].filters[0].frequency);
  await act(async () => seen.adapter!.choose({ slot: 'right' }));
  await act(async () => seen.adapter!.view({ mode: 'Phase', frequencyMax: 12000 }));
  await spin(dialog.querySelector<HTMLInputElement>('input[aria-label="Zero frequency"]')!, 120);
  await spin(dialog.querySelector<HTMLInputElement>('input[aria-label="Pole frequency"]')!, -120);
  expect(dialog.querySelector<HTMLInputElement>('input[aria-label="Zero frequency"]')!.value).toBe(
    '10.0',
  );
  expect(dialog.querySelector<HTMLInputElement>('input[aria-label="Pole frequency"]')!.value).toBe(
    '1234.5',
  );
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
  await act(async () =>
    [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent === 'Apply shape')!
      .click(),
  );
  expect(state().slot).toBe('left');
  expect(selectedFilter().frequency).toBe(10);
  expect(selectedFilter().frequency2).toBe(1234.5);
  expect(state().documents.right).toEqual(before.right);
  expect(state().past).toHaveLength(1);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
});

it('actual cached view command opens the offline NoisePanel; local/compatibility status reads do no USB or document work', async () => {
  const usb = vi
    .spyOn(WebHidTransport.prototype, 'exchange')
    .mockRejectedValue(new Error('Unexpected USB exchange'));
  await mount();
  const before = structuredClone(state().documents),
    revision = state().documentRevision;
  expect(host.querySelector('[aria-label="Rotating noise controls"]')).toBeNull();
  const execute = createToolExecutor(seen.adapter!);
  await act(async () => {
    expect(await execute('fusion_view', { noisePanel: true })).toEqual({ ok: true });
  });
  const panel = host.querySelector('section[aria-label="Rotating noise"]')!;
  expect(panel).not.toBeNull();
  expect([...panel.querySelectorAll('button')]).toHaveLength(6);
  expect([...panel.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
  expect(panel.textContent?.match(/Offline/g)).toHaveLength(2);
  expect(seen.adapter!.noise!.getSnapshot()).toMatchObject({
    left: { connected: false, acknowledgement: 'none' },
    right: { connected: false, acknowledgement: 'none' },
  });
  expect(
    await execute('fusion_device_read', { target: 'both', noise: { action: 'status' } }),
  ).toMatchObject({ ok: true, noise: { left: { connected: false }, right: { connected: false } } });
  expect(usb).not.toHaveBeenCalled();
  expect(state().documents).toEqual(before);
  expect(state().documentRevision).toBe(revision);
  expect(state().past).toHaveLength(0);
});

it('actual Studio adapter exposes the same cached native mixer controller and view without USB or document mutations', async () => {
  const usb = vi
    .spyOn(WebHidTransport.prototype, 'exchange')
    .mockRejectedValue(new Error('Unexpected USB exchange'));
  await mount();
  const before = structuredClone(state().documents),
    revision = state().documentRevision,
    actor = seen.authority!.localContext('manual'),
    execute = createToolExecutor(seen.adapter!);
  expect(seen.adapter!.nativeMixer).toBeDefined();
  const result = await execute('fusion_native_mixer', { action: 'status' }, actor);
  expect(result).toMatchObject({
    ok: true,
    mixer: { roles: { left: { connected: false }, right: { connected: false } }, records: [] },
  });
  expect(seen.adapter!.viewState!()).toMatchObject({
    nativeMixer: seen.adapter!.nativeMixer!.getSnapshot(),
  });
  const controllerStatus = seen.adapter!.nativeMixer!.status(actor);
  expect(result).toEqual({ ok: true, mixer: controllerStatus });
  await act(async () => {
    expect(
      await execute('fusion_native_mixer', { action: 'load', target: 'both', preset: 2 }, actor),
    ).toMatchObject({ ok: false });
  });
  expect(state().preset).toBe(0);
  expect(usb).not.toHaveBeenCalled();
  expect(state().documents).toEqual(before);
  expect(state().documentRevision).toBe(revision);
  expect(state().past).toHaveLength(0);
});

function runtimeHidFixture(serial: string) {
  const panel = new SimulatedPanel(serial);
  panel.name = 'Synthetic runtime';
  panel.configuration[3] = 5;
  panel.configuration[5] = panel.configuration[12] = 3;
  new DataView(panel.configuration.buffer).setUint16(17, 82, true);
  panel.deviceConfiguration[11] = 9;
  panel.deviceConfiguration[13] = 1;
  let forbidden = 0;
  class SyntheticDevice extends EventTarget {
    vendorId = 0x345e;
    productId = 0x03e8;
    productName = 'SYNTHETIC runtime';
    opened = false;
    open = vi.fn(async () => {
      this.opened = true;
    });
    close = vi.fn(async () => {
      this.opened = false;
    });
    sendReport = vi.fn(async (_id: number, data: BufferSource) => {
      const request = new Uint8Array(data as ArrayBuffer);
      if (!(
        (request[0] === 6 && request[1] === 1) ||
        (request[0] === 0x66 && request[1] === 0) ||
        (request[0] === 3 && request[1] === 8) ||
        (request[0] === 0x65 &&
          request[1] === 32 &&
          request[2] === 0 &&
          request[3] === 1 &&
          request[4] === 0 &&
          request[5] === 0)
      )) {
        forbidden++;
        throw new Error('Synthetic Studio forbids every setter and unrelated read');
      }
      const reply = await panel.exchange(request),
        event = new Event('inputreport');
      Object.defineProperties(event, {
        reportId: { value: 0 },
        data: { value: new DataView(reply.buffer, reply.byteOffset, reply.byteLength) },
      });
      this.dispatchEvent(event);
    });
  }
  return {
    panel,
    device: new SyntheticDevice(),
    get forbidden() {
      return forbidden;
    },
  };
}
function installRuntimeHid(devices: ReturnType<typeof runtimeHidFixture>[]) {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'hid'),
    hub = new EventTarget();
  const api = Object.assign(hub, {
    getDevices: vi.fn(async () => devices.map((value) => value.device)),
    requestDevice: vi.fn(async () => devices.map((value) => value.device)),
  });
  Object.defineProperty(navigator, 'hid', { configurable: true, value: api });
  restoreTestHid = () => {
    if (previous) Object.defineProperty(navigator, 'hid', previous);
    else Reflect.deleteProperty(navigator, 'hid');
  };
  return api;
}

it('actual Studio identifies core5.5 read-only, closes its chosen interface, leaves controls offline and exposes the same remembered read through MCP', async () => {
  const f = runtimeHidFixture('SYNTHETIC-FW-RIGHT'),
    api = installRuntimeHid([f]);
  await mount();
  const documents = structuredClone(state().documents),
    revision = state().documentRevision,
    actor = seen.authority!.localContext('manual');
  let result: unknown;
  await act(async () => {
    result = await createToolExecutor(seen.adapter!)(
      'fusion_connect',
      { slot: 'right', serial: f.panel.serial },
      actor,
    );
  });
  expect(result).toMatchObject({
    ok: false,
    error: expect.stringContaining('identified read-only'),
    runtime: {
      identity: { serial: f.panel.serial, core: '5.5', firmware: '5.82' },
      controlsQualified: false,
    },
  });
  expect(seen.adapter!.connections()).toEqual({});
  expect(f.device.opened).toBe(false);
  expect(f.device.close).toHaveBeenCalledTimes(1);
  expect(api.requestDevice).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="Right runtime identity"]')?.textContent).toContain(
    '5.82',
  );
  expect(seen.adapter!.viewState!()).toMatchObject({
    firmwareRuntime: { roles: { right: { report: { identity: { core: '5.5' } } } } },
  });
  await act(async () => {
    result = await createToolExecutor(seen.adapter!)(
      'fusion_device_read',
      { target: 'right', firmware: { action: 'runtime-read' } },
      actor,
    );
  });
  expect(result).toMatchObject({
    ok: true,
    runtime: {
      busy: false,
      roles: {
        right: {
          source: 'remembered-device',
          stale: false,
          report: { identity: { serial: f.panel.serial }, controlsQualified: false },
        },
      },
    },
  });
  expect(f.device.open).toHaveBeenCalledTimes(2);
  expect(f.device.close).toHaveBeenCalledTimes(2);
  expect(f.device.opened).toBe(false);
  expect(seen.adapter!.connections()).toEqual({});
  expect(f.forbidden).toBe(0);
  expect(f.panel.writes).toBe(0);
  expect(state().documents).toEqual(documents);
  expect(state().documentRevision).toBe(revision);
  expect(state().past).toHaveLength(0);
});

it('actual serial reconnect skips a different permitted diagnostic device without retargeting the requested role', async () => {
  const wrong = runtimeHidFixture('SYNTHETIC-FW-OTHER'),
    chosen = runtimeHidFixture('SYNTHETIC-FW-CHOSEN');
  installRuntimeHid([wrong, chosen]);
  await mount();
  let result: unknown;
  await act(async () => {
    result = await createToolExecutor(seen.adapter!)(
      'fusion_connect',
      { slot: 'right', serial: chosen.panel.serial },
      seen.authority!.localContext('manual'),
    );
  });
  expect(result).toMatchObject({
    ok: false,
    runtime: { identity: { serial: chosen.panel.serial } },
  });
  expect(wrong.device.opened).toBe(false);
  expect(chosen.device.opened).toBe(false);
  expect(wrong.device.close).toHaveBeenCalledTimes(1);
  expect(chosen.device.close).toHaveBeenCalledTimes(1);
  expect(seen.adapter!.connections()).toEqual({});
  expect(wrong.forbidden + chosen.forbidden).toBe(0);
  expect(seen.adapter!.firmwareRuntime!.getSnapshot().roles.right.report?.identity.serial).toBe(
    chosen.panel.serial,
  );
});

it('actual Connect never borrows or closes an already-open unassigned interface', async () => {
  const f = runtimeHidFixture('SYNTHETIC-OPEN-ELSEWHERE');
  f.device.opened = true;
  installRuntimeHid([f]);
  await mount();
  let result: unknown;
  await act(async () => {
    result = await createToolExecutor(seen.adapter!)(
      'fusion_connect',
      { slot: 'right', serial: f.panel.serial },
      seen.authority!.localContext('manual'),
    );
  });
  expect(result).toMatchObject({ ok: false });
  expect(f.device.sendReport).not.toHaveBeenCalled();
  expect(f.device.open).not.toHaveBeenCalled();
  expect(f.device.close).not.toHaveBeenCalled();
  expect(f.device.opened).toBe(true);
  expect(seen.adapter!.connections()).toEqual({});
});

it('actual Studio gesture context includes channel identity and changes when a project replaces the selected channel at the same indices', async () => {
  await mount();
  const before = seen.plot!.contextKey!;
  expect(before).toContain(state().documents.left.presets[0].channels[0].id);
  await act(async () =>
    state().editAt(['left'], (project) => {
      project.presets[0].channels[0].id = 'replacement-channel-id';
    }),
  );
  expect(seen.plot!.contextKey).not.toBe(before);
  expect(seen.plot!.contextKey).toContain('replacement-channel-id');
});

it('actual Phase controls share independent view state without editing sum membership or linked designs', async () => {
  const channels = state().documents.left.presets[0].channels;
  for (const channel of channels.slice(0, 2))
    channel.measurement = {
      name: 'phase.frd',
      sampleRate: 48000,
      frequency: [10, 1000],
      magnitude: [0, -3],
      phase: [0, 0],
    };
  channels[1].includeInSum = false;
  useWorkspace.setState({ linkedEdits: true, linkedControls: true });
  const before = structuredClone(state().documents);
  await mount();
  await act(async () =>
    [...host.querySelectorAll('button')].find((button) => button.textContent === 'Phase')!.click(),
  );
  expect(view().graph.phase).toEqual({ channels: [true, false, false], sum: false });
  expect(view().graph.sum).toBe(true);
  const sum = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
    (input) => input.parentElement?.textContent?.trim() === 'Show phase sum',
  )!;
  expect(sum.checked).toBe(false);
  expect(host.querySelector<HTMLInputElement>('[aria-label="Show Tweeter phase"]')!.disabled).toBe(
    true,
  );
  await act(async () => sum.click());
  await act(async () =>
    host.querySelector<HTMLInputElement>('[aria-label="Show Midrange phase"]')!.click(),
  );
  expect(view().graph.phase).toEqual({ channels: [true, true, false], sum: true });
  expect(seen.plot?.phaseLayers).toEqual(view().graph.phase);
  expect(state().documents).toEqual(before);
  expect(state().documentRevision).toBe(0);
  expect(state().past).toHaveLength(0);
  expect(host.querySelectorAll('[aria-label="Show phase sum"]')).toHaveLength(0);
});

it('MCP Phase visibility is role-local and rejects unavailable or malformed curves before changing any view', async () => {
  for (const channel of state().documents.left.presets[0].channels.slice(0, 2))
    channel.measurement = {
      name: 'phase.frd',
      sampleRate: 48000,
      frequency: [10, 1000],
      magnitude: [0, -3],
      phase: [0, 0],
    };
  const before = structuredClone(state().documents);
  await mount();
  const execute = createToolExecutor(seen.adapter!);
  await act(async () =>
    expect(
      await execute('fusion_view', {
        tab: 'Crossover',
        mode: 'Phase',
        graph: { phase: { channels: [false, true, false], sum: true } },
      }),
    ).toEqual({ ok: true }),
  );
  const left = structuredClone(view().graph.phase);
  await act(async () => {
    await execute('fusion_select', { slot: 'right' });
  });
  expect(view().graph.phase).toEqual({ channels: [true, false, false], sum: false });
  await act(async () => {
    await execute('fusion_select', { slot: 'left' });
  });
  expect(view().graph.phase).toEqual(left);
  const graphs = structuredClone(view().graphs);
  for (const phase of [
    { channels: [false, true, true] },
    { channels: [true, false] },
    { sum: 'yes' },
  ]) {
    await act(async () =>
      expect(
        await execute('fusion_view', { mode: 'Magnitude', graph: { sum: false, phase } }),
      ).toMatchObject({ ok: false }),
    );
    expect(view().graphs).toEqual(graphs);
    expect(view().mode).toBe('Phase');
  }
  expect(state().documents).toEqual(before);
  expect(state().documentRevision).toBe(0);
  expect(state().past).toHaveLength(0);
});
