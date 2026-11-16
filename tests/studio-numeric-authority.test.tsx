// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { newFilter, newProject } from '../src/domain/model';
import { ensureWorkspaceHydrated, useWorkspace } from '../src/state/workspace';
import Studio from '../src/components/Studio';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';
const seen = vi.hoisted(() => ({ adapter: undefined as ToolAdapter | undefined }));
vi.mock('../src/components/AgentAccess', () => ({
  default: ({ adapter }: { adapter: ToolAdapter }) => {
    seen.adapter = adapter;
    return null;
  },
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
const channel = (slot: 'left' | 'right' = 'left', index = 0) =>
  state().documents[slot].presets[0].channels[index];
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  await ensureWorkspaceHydrated();
  useWorkspace.setState({
    documents: { left: newProject('Left synthetic'), right: newProject('Right synthetic') },
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
  for (const slot of ['left', 'right'] as const) {
    const c = channel(slot);
    c.gain = slot === 'left' ? 3 : -2;
    c.additionalGain = 10;
    c.filters[0] = {
      ...newFilter('peak'),
      frequency: 2300,
      q: 1.15,
      gain: 7.5,
      enabled: true,
      coefficients: { b0: 0.9, b1: 0.02, b2: -0.01, f1: 0.1, f2: 0.05 },
      provenance: slot === 'left' ? 'hfd' : 'panel',
    };
    c.coefficientCache = slot === 'left' ? 'effective' : 'unresolved';
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
async function mount() {
  await act(async () => root.render(<Studio />));
}
function field(label: string) {
  const labels = Array.from(host.querySelectorAll('label'));
  const node = labels.find((x) => x.textContent?.trim().startsWith(label))?.querySelector('input');
  expect(node).not.toBeNull();
  return node as HTMLInputElement;
}
async function fill(input: HTMLInputElement, text: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => input.blur());
}

const execute = (name: string, args: unknown) =>
  createToolExecutor(
    new Proxy({} as ToolAdapter, { get: (_, key) => seen.adapter![key as keyof ToolAdapter] }),
  )(name, args);
const foreignOff = (target: 'left' | 'right' | 'both' = 'both') =>
  execute('fusion_channel_set', { target, preset: 1, channel: 1, patch: { hardwareGain: false } });
async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function escape(input: HTMLInputElement) {
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
}
it('local Gain3 to3.1 by arrow then accepted paired compensation Off survives Escape with two exact Undo steps', async () => {
  await mount();
  const original = structuredClone(state().documents),
    input = field('Gain');
  await act(async () => input.focus());
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })),
  );
  const local = structuredClone(state().documents);
  expect(channel().gain).toBe(3.1);
  await act(async () => expect(await foreignOff()).toMatchObject({ ok: true }));
  const accepted = structuredClone(state().documents);
  expect(state().past).toHaveLength(2);
  await escape(input);
  expect(state().documents).toEqual(accepted);
  expect(state().past).toHaveLength(2);
  expect(state().gesture).toBeUndefined();
  await act(async () => state().undo());
  expect(state().documents).toEqual(local);
  await act(async () => state().undo());
  expect(state().documents).toEqual(original);
});
it('Right-only foreign edits retire Left focus even when its canonical number does not change', async () => {
  await mount();
  const input = field('Gain');
  await act(async () => input.focus());
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })),
  );
  const local = structuredClone(state().documents);
  await act(async () => expect(await foreignOff('right')).toMatchObject({ ok: true }));
  const accepted = structuredClone(state().documents);
  expect(channel().gain).toBe(3.1);
  await escape(input);
  expect(state().documents).toEqual(accepted);
  expect(state().past).toHaveLength(2);
  await act(async () => state().undo());
  expect(state().documents).toEqual(local);
});
it('a new arrow edit in the still-focused field renews against accepted canonical state and Escape cancels only that new group', async () => {
  await mount();
  const input = field('Gain');
  await act(async () => input.focus());
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })),
  );
  await act(async () => expect(await foreignOff()).toMatchObject({ ok: true }));
  const accepted = structuredClone(state().documents);
  expect(document.activeElement).toBe(input);
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })),
  );
  expect(channel().gain).toBe(3.2);
  await escape(input);
  expect(state().documents).toEqual(accepted);
  expect(state().past).toHaveLength(2);
});
it('a stale deferred frequency draft is discarded on blur; a genuine later edit renews and commits separately', async () => {
  await mount();
  const input = host.querySelector<HTMLInputElement>(
    '#selected-filter-inspector [aria-label="Frequency"]',
  )!;
  await act(async () => input.focus());
  await type(input, '1500');
  expect(channel().filters[0].frequency).toBe(2300);
  await act(async () => expect(await foreignOff()).toMatchObject({ ok: true }));
  const accepted = structuredClone(state().documents);
  expect(input.value).not.toBe('1500');
  await act(async () => input.blur());
  expect(state().documents).toEqual(accepted);
  expect(state().past).toHaveLength(1);
  await act(async () => input.focus());
  await type(input, '2000');
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  expect(channel().filters[0].frequency).toBe(2000);
  expect(state().past).toHaveLength(2);
  await act(async () => state().undo());
  expect(state().documents).toEqual(accepted);
});
it('filter wheel state and same-number foreign publication cannot restore the old Q baseline', async () => {
  await mount();
  const original = structuredClone(state().documents),
    input = host.querySelector<HTMLInputElement>(
      '#selected-filter-inspector [aria-label="Q factor"]',
    )!;
  await act(async () => input.focus());
  await act(async () =>
    input.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true })),
  );
  const local = structuredClone(state().documents),
    q = channel().filters[0].q;
  await act(async () =>
    expect(
      await execute('fusion_filter_set', {
        target: 'left',
        preset: 1,
        channel: 1,
        index: 1,
        patch: { q, enabled: false },
      }),
    ).toMatchObject({ ok: true }),
  );
  const accepted = structuredClone(state().documents);
  await escape(input);
  expect(state().documents).toEqual(accepted);
  expect(state().past).toHaveLength(2);
  await act(async () => state().undo());
  expect(state().documents).toEqual(local);
  await act(async () => state().undo());
  expect(state().documents).toEqual(original);
});
it.each(['refused', 'canonical-noop'] as const)(
  'a %s command does not retire a valid current local group',
  async (kind) => {
    channel('right').linkedTo = 1;
    await mount();
    const original = structuredClone(state().documents),
      input = field('Gain');
    await act(async () => input.focus());
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })),
    );
    const result = await act(async () =>
      execute('fusion_channel_set', {
        target: kind === 'refused' ? 'both' : 'left',
        preset: 1,
        channel: 1,
        patch: { gain: kind === 'refused' ? 5 : 3.1 },
      }),
    );
    expect(result).toMatchObject(kind === 'refused' ? { ok: false } : { ok: true, changed: false });
    await escape(input);
    expect(state().documents).toEqual(original);
    expect(state().past).toHaveLength(0);
  },
);
it('a pre-render stale Escape and old-context input cannot publish into replacement documents with identical IDs', async () => {
  await mount();
  const input = field('Gain');
  await act(async () => input.focus());
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })),
  );
  let replacement: ReturnType<typeof structuredClone>;
  await act(async () => {
    const project = structuredClone(state().documents.left);
    project.name = 'Replacement same identities';
    project.presets[0].channels[0].gain = 9;
    state().replaceAt('left', project);
    seen.adapter!.documentsReplaced!(['left']);
    replacement = structuredClone(state().documents);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '6');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  expect(state().documents).toEqual(replacement!);
  expect(channel().gain).toBe(9);
});
it('selection swapped before Numeric re-render refuses the old target event rather than editing the new channel', async () => {
  await mount();
  const input = field('Gain');
  await act(async () => input.focus());
  const before = structuredClone(state().documents);
  await act(async () => {
    state().choose({ channel: 1 });
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '7');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur();
  });
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
});
it('an unfocused wheel after a retired session remains individually undoable without a stale lease', async () => {
  await mount();
  const input = host.querySelector<HTMLInputElement>(
    '#selected-filter-inspector [aria-label="Q factor"]',
  )!;
  await act(async () => input.focus());
  await act(async () => expect(await foreignOff()).toMatchObject({ ok: true }));
  await act(async () => input.blur());
  const accepted = structuredClone(state().documents),
    past = state().past.length;
  await act(async () =>
    input.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true })),
  );
  const once = structuredClone(state().documents);
  await act(async () =>
    input.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true })),
  );
  expect(state().past).toHaveLength(past + 2);
  await act(async () => state().undo());
  expect(state().documents).toEqual(once);
  await act(async () => state().undo());
  expect(state().documents).toEqual(accepted);
});

it('an accepted native graph writeback outside adapter edit survives an older focused field Escape', async () => {
  channel().hfdGraph = { showMeasuredResponse: false, showSum: true };
  await mount();
  const input = field('Gain');
  await act(async () => input.focus());
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })),
  );
  const local = structuredClone(state().documents);
  await act(async () =>
    expect(await execute('fusion_view', { graph: { sum: false } })).toMatchObject({ ok: true }),
  );
  expect(channel().hfdGraph?.showSum).toBe(false);
  const accepted = structuredClone(state().documents);
  await escape(input);
  expect(state().documents).toEqual(accepted);
  expect(state().past).toHaveLength(2);
  await act(async () => state().undo());
  expect(state().documents).toEqual(local);
});

it('an unfocused other-field wheel is independent of the still-focused Gain cancellation authority', async () => {
  await mount();
  const original = structuredClone(state().documents),
    gain = field('Gain'),
    q = host.querySelector<HTMLInputElement>('#selected-filter-inspector [aria-label="Q factor"]')!;
  await act(async () => gain.focus());
  await act(async () =>
    gain.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })),
  );
  const local = structuredClone(state().documents);
  expect(document.activeElement).toBe(gain);
  await act(async () =>
    q.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true })),
  );
  expect(document.activeElement).toBe(gain);
  const accepted = structuredClone(state().documents);
  expect(channel().filters[0].q).toBe(1.19);
  await escape(gain);
  expect(state().documents).toEqual(accepted);
  expect(state().past).toHaveLength(2);
  await act(async () => state().undo());
  expect(state().documents).toEqual(local);
  await act(async () => state().undo());
  expect(state().documents).toEqual(original);
});
