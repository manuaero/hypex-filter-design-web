// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';
import type { PlotViewSnapshot } from '../src/application/plot-view';
import { rectangleZoom } from '../src/components/plot-zoom-geometry';
import type InteractivePlot from '../src/components/InteractivePlot';
import { newProject, type HfdImpulseZoom } from '../src/domain/model';
import Studio from '../src/components/Studio';
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
import { ensureWorkspaceHydrated, useWorkspace } from '../src/state/workspace';

type PlotProps = ComponentProps<typeof InteractivePlot>;
const seen = vi.hoisted(() => ({
  adapter: undefined as ToolAdapter | undefined,
  plot: undefined as PlotProps | undefined,
}));
vi.mock('../src/components/AgentAccess', () => ({
  default: ({ adapter }: { adapter: ToolAdapter }) => {
    seen.adapter = adapter;
    return null;
  },
}));
vi.mock('../src/components/InteractivePlot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/components/InteractivePlot')>()),
  default: (props: PlotProps) => {
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

const raw: HfdImpulseZoom = { left: -0.002, right: 0.018, top: 3, bottom: -2, use: true };
let host: HTMLDivElement, root: Root;
const state = () => useWorkspace.getState();
const currentChannel = () =>
  state().documents[state().slot].presets[state().preset].channels[state().channel];
const view = () => seen.adapter!.viewState!() as { mode: string; plotViews: PlotViewSnapshot };
const impulseView = (slot: 'left' | 'right' = 'left') => view().plotViews[slot].Impulse;
const stepView = (slot: 'left' | 'right' = 'left') => view().plotViews[slot].Step;
const nativeFrom = (range: PlotProps['range']): HfdImpulseZoom => ({
  left: range.timeMinMs / 1000,
  right: range.timeMaxMs / 1000,
  top: range.amplitudeMax,
  bottom: range.amplitudeMin,
  use: true,
});
async function mount() {
  await act(async () => root.render(<Studio />));
}
async function command(name: string, args: object) {
  let result: unknown;
  await act(async () => {
    result = await createToolExecutor(seen.adapter!)(name, args);
  });
  return result;
}
async function showImpulse() {
  expect(await command('fusion_view', { mode: 'Impulse' })).toEqual({ ok: true });
}
async function start(kind: 'pan' | 'zoom' = 'pan') {
  expect(seen.plot!.onRangeGestureStart).toBeTypeOf('function');
  await act(async () => seen.plot!.onRangeGestureStart!(kind));
}
async function commit() {
  await act(async () => seen.plot!.onRangeGestureCommit!());
}
async function rangePreview(patch: Partial<PlotProps['range']>) {
  await act(async () => seen.plot!.onRange({ ...seen.plot!.range, ...patch }));
}
async function rectangle() {
  const range = seen.plot!.range;
  const zoom = rectangleZoom(
    {
      xMin: range.timeMinMs,
      xMax: range.timeMaxMs,
      yMin: range.amplitudeMin,
      yMax: range.amplitudeMax,
      xScale: 'linear',
    },
    { x: 25, y: 25 },
    { x: 75, y: 75 },
    { left: 0, top: 0, width: 100, height: 100 },
  );
  await act(async () => seen.plot!.onRectangleZoom!(zoom, range));
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
  });
  state().documents.left.presets[0].channels[0].hfdImpulseZoom = { ...raw };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  seen.adapter = undefined;
  seen.plot = undefined;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

it('passively restores valid native seconds/raw amplitudes without documents, Undo or Step coupling', async () => {
  const before = structuredClone(state().documents);
  await mount();
  await showImpulse();
  expect(impulseView().range).toMatchObject({
    timeMinMs: -2,
    timeMaxMs: 18,
    amplitudeMin: -2,
    amplitudeMax: 3,
  });
  expect(stepView().range).not.toMatchObject({ timeMinMs: -2, timeMaxMs: 18 });
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
  expect(state().documentRevision).toBe(0);
});

it.each([
  undefined,
  { left: 91, right: 92, top: 9, bottom: 8, use: false },
  { left: -1, right: -1, top: -1, bottom: -1, use: true },
])(
  'auto-fits missing/disabled/invalid tuples once without normalizing stored metadata: %j',
  async (zoom) => {
    if (zoom) currentChannel().hfdImpulseZoom = zoom;
    else delete currentChannel().hfdImpulseZoom;
    const before = structuredClone(state().documents);
    await mount();
    await showImpulse();
    const first = { ...impulseView().range };
    expect(first.timeMinMs).toBeLessThan(first.timeMaxMs);
    expect(first.amplitudeMin).toBeLessThan(first.amplitudeMax);
    expect(first.timeMinMs).not.toBe(91000);
    await act(async () => seen.adapter!.view({ tab: 'Device settings' }));
    await act(async () => seen.adapter!.view({ tab: 'Crossover' }));
    expect(impulseView().range).toEqual(first);
    expect(state().documents).toEqual(before);
    expect(state().past).toHaveLength(0);
    await command('fusion_view', { resetPlot: true });
    const reset = { ...impulseView().range };
    await act(async () =>
      state().editAt(['left'], (project) => {
        project.name = 'Unrelated rename';
      }),
    );
    expect(impulseView().range).toEqual(reset);
    expect(currentChannel().hfdImpulseZoom).toEqual(zoom);
  },
);

it('previews a background pan without a document edit and commits only the selected linked follower on mouse-up', async () => {
  const left = state().documents.left.presets[1].channels;
  left[2].linkedTo = 0;
  left[2].hfdImpulseZoom = { ...raw };
  left[0].hfdImpulseZoom = { ...raw, right: 0.035 };
  useWorkspace.setState({ preset: 1, channel: 2, linkedEdits: true });
  const before = structuredClone(state().documents);
  await mount();
  await showImpulse();
  await start();
  await rangePreview({ timeMinMs: 5, timeMaxMs: 35, amplitudeMin: -0.5, amplitudeMax: 1.5 });
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
  await commit();
  const expected = structuredClone(before);
  expected.left.presets[1].channels[2].hfdImpulseZoom = {
    left: 0.005,
    right: 0.035,
    top: 1.5,
    bottom: -0.5,
    use: true,
  };
  expect(state().documents).toEqual(expected);
  expect(state().past).toHaveLength(1);
  expect(state().documentRevision).toBe(1);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
});

it('deduplicates a plain mouse click when the existing saved tuple is already active', async () => {
  await mount();
  await showImpulse();
  const before = structuredClone(state().documents);
  await start();
  await commit();
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
  expect(state().documentRevision).toBe(0);
});

it.each([
  { label: 'role', selection: { slot: 'right' }, slot: 'right' as const, channel: 0 },
  { label: 'channel', selection: { channel: 2 }, slot: 'left' as const, channel: 1 },
])(
  'discards a focused Time draft when MCP changes the selected $label before blur',
  async (target) => {
    state().documents[target.slot].presets[0].channels[target.channel].hfdImpulseZoom = {
      left: 0.035,
      right: 0.075,
      top: 7,
      bottom: -7,
      use: true,
    };
    const before = structuredClone(state().documents);
    await mount();
    await showImpulse();
    const field = host.querySelector<HTMLInputElement>('input[aria-label="Time from"]')!;
    expect(field).not.toBeNull();
    await act(async () => {
      field.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '7');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(field.value).toBe('7');
    expect(state().documents).toEqual(before);
    expect(await command('fusion_select', target.selection)).toEqual({ ok: true });
    expect(state().slot).toBe(target.slot);
    expect(state().channel).toBe(target.channel);
    await act(async () => field.blur());
    const selectedField = host.querySelector<HTMLInputElement>('input[aria-label="Time from"]')!;
    expect(selectedField.value).toBe('35');
    await act(async () => {
      selectedField.focus();
      selectedField.blur();
    });
    expect(state().documents).toEqual(before);
    expect(state().past).toHaveLength(0);
    expect(state().documentRevision).toBe(0);
  },
);

it.each(['same-ID import', 'external revision'] as const)(
  'discards a stale focused Time draft after %s while retaining field focus',
  async (replacement) => {
    await mount();
    await showImpulse();
    const original = structuredClone(state().documents);
    const field = host.querySelector<HTMLInputElement>('input[aria-label="Time from"]')!;
    await act(async () => {
      field.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '7');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(field.value).toBe('7');
    const expected = structuredClone(original);
    if (replacement === 'same-ID import') {
      expected.left.name = 'Replacement with identical IDs';
      expected.left.presets[0].channels[0].hfdImpulseZoom = {
        left: 0.035,
        right: 0.075,
        top: 7,
        bottom: -7,
        use: true,
      };
      expect(
        await command('fusion_project_import', {
          target: 'left',
          content: JSON.stringify(expected.left),
          name: 'Same IDs',
        }),
      ).toMatchObject({ ok: true });
    } else {
      expected.left.name = 'External rename';
      await act(async () =>
        state().editAt(['left'], (project) => {
          project.name = expected.left.name;
        }),
      );
    }
    expect(host.querySelector('input[aria-label="Time from"]')).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe(replacement === 'same-ID import' ? '35' : '-2');
    expect(state().documents).toEqual(expected);
    await act(async () => field.blur());
    expect(state().documents).toEqual(expected);
    expect(state().past).toHaveLength(1);
    expect(state().documentRevision).toBe(1);
    await act(async () => seen.adapter!.undo());
    expect(state().documents).toEqual(original);
    expect(state().past).toHaveLength(0);
  },
);

it('keeps focused Time arrows usable across their own document revisions and blur adds no duplicate edit', async () => {
  await mount();
  await showImpulse();
  const before = structuredClone(state().documents);
  const field = host.querySelector<HTMLInputElement>('input[aria-label="Time from"]')!;
  await act(async () => field.focus());
  await act(async () =>
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
    ),
  );
  expect(host.querySelector('input[aria-label="Time from"]')).toBe(field);
  expect(document.activeElement).toBe(field);
  expect(field.value).toBe('-1');
  expect(currentChannel().hfdImpulseZoom).toEqual({ ...raw, left: -0.001 });
  await act(async () =>
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
    ),
  );
  expect(document.activeElement).toBe(field);
  expect(field.value).toBe('0');
  const expected = structuredClone(before);
  expected.left.presets[0].channels[0].hfdImpulseZoom = { ...raw, left: 0 };
  expect(state().documents).toEqual(expected);
  expect(state().past).toHaveLength(2);
  await act(async () => field.blur());
  expect(state().past).toHaveLength(2);
  expect(state().documents).toEqual(expected);
});

it('cancels preview and rejects a late commit after a document revision or selected role changed', async () => {
  await mount();
  await showImpulse();
  const before = structuredClone(state().documents);
  await start();
  await rangePreview({ timeMinMs: 1, timeMaxMs: 11 });
  await act(async () => seen.plot!.onRangeGestureCancel!());
  expect(state().documents).toEqual(before);
  await start();
  const lateCommit = seen.plot!.onRangeGestureCommit!;
  await rangePreview({ timeMinMs: 3, timeMaxMs: 13 });
  await act(async () =>
    state().editAt(['right'], (project) => {
      project.name = 'Newer revision';
    }),
  );
  const edited = structuredClone(state().documents),
    history = state().past.length;
  await act(async () => lateCommit());
  expect(state().documents).toEqual(edited);
  expect(state().past).toHaveLength(history);
  await start();
  const switchedCommit = seen.plot!.onRangeGestureCommit!;
  await act(async () => seen.adapter!.choose({ slot: 'right' }));
  const switched = structuredClone(state().documents);
  await act(async () => switchedCommit());
  expect(state().documents).toEqual(switched);
});

it('keeps native zoom unchanged for Step, Input EQ and browser Reset view actions', async () => {
  await mount();
  await showImpulse();
  const before = structuredClone(state().documents);
  await command('fusion_view', {
    mode: 'Step',
    timeMinMs: -10,
    timeMaxMs: 40,
    amplitudeMin: -8,
    amplitudeMax: 8,
  });
  await act(async () => seen.plot!.onRangeGestureStart?.('pan'));
  await rangePreview({ timeMinMs: 0, timeMaxMs: 20 });
  await act(async () => seen.plot!.onRangeGestureCommit?.());
  await command('fusion_view', { tab: 'Input EQ', mode: 'Impulse', timeMinMs: 0, timeMaxMs: 30 });
  await act(async () => seen.plot!.onRangeGestureStart?.('pan'));
  await rangePreview({ timeMinMs: 1, timeMaxMs: 31 });
  await act(async () => seen.plot!.onRangeGestureCommit?.());
  await command('fusion_view', { tab: 'Crossover', mode: 'Impulse', resetPlot: true });
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
});

it('actual Fit and explicit MCP Impulse fields save the same native tuple with one Undo each', async () => {
  await mount();
  await showImpulse();
  const before = structuredClone(state().documents);
  const fit = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'Fit response',
  )!;
  expect(fit).toBeDefined();
  await act(async () => fit.click());
  expect(currentChannel().hfdImpulseZoom).toEqual(nativeFrom(impulseView().range));
  expect(state().past).toHaveLength(1);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
  expect(
    await command('fusion_view', {
      mode: 'Impulse',
      timeMinMs: -4,
      timeMaxMs: 24,
      amplitudeMin: -3,
      amplitudeMax: 6,
    }),
  ).toEqual({ ok: true });
  expect(currentChannel().hfdImpulseZoom).toEqual({
    left: -0.004,
    right: 0.024,
    top: 6,
    bottom: -3,
    use: true,
  });
  expect(state().past).toHaveLength(1);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
});

it('own rectangle commit preserves reverse history and shared MCP Back stores restored Impulse bounds only', async () => {
  await mount();
  await showImpulse();
  const before = structuredClone(state().documents);
  await start('zoom');
  await rectangle();
  expect(state().documents).toEqual(before);
  await commit();
  expect(currentChannel().hfdImpulseZoom).toEqual({
    left: 0.003,
    right: 0.013,
    top: 1.75,
    bottom: -0.75,
    use: true,
  });
  expect(impulseView().canReverse).toBe(true);
  expect(impulseView().undoDepth).toBe(1);
  expect(stepView().range).toMatchObject({ timeMinMs: 3, timeMaxMs: 13 });
  const step = { ...stepView().range };
  expect(await command('fusion_view', { zoomBack: true })).toEqual({ ok: true });
  expect(impulseView().range).toMatchObject({
    timeMinMs: -2,
    timeMaxMs: 18,
    amplitudeMin: -2,
    amplitudeMax: 3,
  });
  expect(currentChannel().hfdImpulseZoom).toEqual(raw);
  expect(stepView().range).toEqual(step);
  expect(state().past).toHaveLength(2);
});

it('explicit MCP forward rectangle shares history, Step X coupling and one native view Undo with the human gesture', async () => {
  await mount();
  await showImpulse();
  const original = structuredClone(state().documents),
    step = { ...stepView().range };
  expect(
    await command('fusion_view', {
      mode: 'Impulse',
      zoomRectangle: true,
      timeMinMs: 4,
      timeMaxMs: 14,
      amplitudeMin: -1,
      amplitudeMax: 2,
    }),
  ).toEqual({ ok: true });
  expect(impulseView().range).toMatchObject({
    timeMinMs: 4,
    timeMaxMs: 14,
    amplitudeMin: -1,
    amplitudeMax: 2,
  });
  expect(currentChannel().hfdImpulseZoom).toEqual({
    left: 0.004,
    right: 0.014,
    top: 2,
    bottom: -1,
    use: true,
  });
  expect(impulseView().undoDepth).toBe(1);
  expect(impulseView().canReverse).toBe(true);
  expect(stepView().range).toEqual({ ...step, timeMinMs: 4, timeMaxMs: 14 });
  expect(state().past).toHaveLength(1);
  expect(state().documents.right).toEqual(original.right);
  expect(await command('fusion_view', { zoomBack: true })).toEqual({ ok: true });
  expect(currentChannel().hfdImpulseZoom).toEqual(raw);
  expect(impulseView().range).toMatchObject({
    timeMinMs: -2,
    timeMaxMs: 18,
    amplitudeMin: -2,
    amplitudeMax: 3,
  });
  expect(stepView().range).toEqual({ ...step, timeMinMs: 4, timeMaxMs: 14 });
  expect(state().past).toHaveLength(2);
});

it('rejects an incomplete MCP rectangle without changing axes, history or canonical native metadata', async () => {
  await mount();
  await showImpulse();
  const documents = structuredClone(state().documents),
    plots = view().plotViews;
  expect(
    await command('fusion_view', {
      mode: 'Impulse',
      zoomRectangle: true,
      timeMinMs: 4,
      timeMaxMs: 14,
    }),
  ).toMatchObject({ ok: false });
  expect(state().documents).toEqual(documents);
  expect(view().plotViews).toBe(plots);
  expect(state().past).toHaveLength(0);
});

it('Undo and explicit same-ID project import reproject saved bounds without a passive writeback', async () => {
  await mount();
  await showImpulse();
  const original = structuredClone(state().documents.left);
  await command('fusion_view', { timeMinMs: 2, timeMaxMs: 12, amplitudeMin: -1, amplitudeMax: 2 });
  await act(async () => seen.adapter!.undo());
  expect(impulseView().range).toMatchObject({
    timeMinMs: -2,
    timeMaxMs: 18,
    amplitudeMin: -2,
    amplitudeMax: 3,
  });
  expect(state().past).toHaveLength(0);
  // Browser Reset is deliberately view-only and leaves the same tuple/IDs.
  await command('fusion_view', { resetPlot: true });
  expect(impulseView().range).not.toMatchObject({ timeMinMs: -2, timeMaxMs: 18 });
  expect(
    await command('fusion_project_import', {
      target: 'left',
      content: JSON.stringify(original),
      name: 'Same IDs',
    }),
  ).toMatchObject({ ok: true });
  expect(state().documents.left).toEqual(original);
  expect(impulseView().range).toMatchObject({
    timeMinMs: -2,
    timeMaxMs: 18,
    amplitudeMin: -2,
    amplitudeMax: 3,
  });
  expect(state().past).toHaveLength(1);
});
