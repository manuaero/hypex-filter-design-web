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
    linkedEdits: true,
    linkedControls: false,
    documentRevision: 0,
    past: [],
    future: [],
    gesture: undefined,
  });
  for (const slot of ['left', 'right'] as const) {
    const c = channel(slot);
    c.gain = slot === 'left' ? 3 : -2;
    c.additionalGain = slot === 'left' ? 10 : 0;
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
it('actual sidebar channel gain refuses an independent Left plus linked Right atomically with no Undo entry', async () => {
  channel('right').linkedTo = 1;
  const before = structuredClone(state().documents),
    revision = state().documentRevision;
  await mount();
  await fill(field('Gain'), '4');
  expect(state().documents).toEqual(before);
  expect(state().documentRevision).toBe(revision);
  expect(state().past).toHaveLength(0);
  expect(host.textContent).toContain('linked');
});
it('actual metadata channel-name edit preserves dirty linked-follower vectors and provenance', async () => {
  channel('right').linkedTo = 1;
  const before = structuredClone(state().documents);
  await mount();
  await fill(field('Channel name'), 'Edited label');
  expect(channel('left').name).toBe('Edited label');
  expect(channel('right').name).toBe('Edited label');
  for (const slot of ['left', 'right'] as const) {
    expect(channel(slot).filters).toEqual(before[slot].presets[0].channels[0].filters);
    expect(channel(slot).coefficientCache).toBe(
      before[slot].presets[0].channels[0].coefficientCache,
    );
    expect(channel(slot).additionalGain).toBe(before[slot].presets[0].channels[0].additionalGain);
  }
  expect(state().past).toHaveLength(1);
  await act(async () => state().undo());
  expect(state().documents).toEqual(before);
});

const compensation = () =>
  host.querySelector<HTMLInputElement>('[aria-label="Hardware gain compensation"]');
const execute = (patch: Record<string, unknown>, target: 'left' | 'right' | 'both' = 'left') =>
  createToolExecutor(
    new Proxy({} as ToolAdapter, { get: (_, key) => seen.adapter![key as keyof ToolAdapter] }),
  )('fusion_channel_set', { target, preset: 1, channel: 1, patch });
it('a fresh zero-offset channel has no universal hardware-gain checkbox or command eligibility', async () => {
  channel().additionalGain = 0;
  await mount();
  expect(compensation()).toBeNull();
  const before = structuredClone(state().documents);
  await act(async () => expect(await execute({ hardwareGain: true })).toMatchObject({ ok: false }));
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
});
it('Off retains its channel view through ordinary Gain, Save and role/channel navigation; On caps14 without changing caches', async () => {
  useWorkspace.setState({ linkedEdits: false });
  await mount();
  const before = structuredClone(channel().filters),
    cache = channel().coefficientCache;
  expect(compensation()?.checked).toBe(true);
  await act(async () => compensation()!.click());
  expect(channel().additionalGain).toBe(0);
  expect(compensation()?.checked).toBe(false);
  await fill(field('Gain'), '18');
  expect(channel().gain).toBe(18);
  expect(compensation()).not.toBeNull();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Save project"]')!.click(),
  );
  const close = host.querySelector<HTMLButtonElement>('[aria-label="Close project save"]');
  expect(close).not.toBeNull();
  await act(async () => close!.click());
  expect(compensation()?.checked).toBe(false);
  await act(async () =>
    host.querySelectorAll<HTMLButtonElement>('.channel-list button')[1].click(),
  );
  expect(compensation()).toBeNull();
  await act(async () =>
    host.querySelectorAll<HTMLButtonElement>('.channel-list button')[0].click(),
  );
  expect(compensation()?.checked).toBe(false);
  await act(async () => seen.adapter!.choose({ slot: 'right' }));
  expect(compensation()).toBeNull();
  await act(async () => seen.adapter!.choose({ slot: 'left' }));
  expect(compensation()?.checked).toBe(false);
  await act(async () => compensation()!.click());
  expect(channel().gain).toBe(14);
  expect(channel().additionalGain).toBe(10);
  expect(state().documents.left.hfdGainLowered).toBe(true);
  expect(channel().filters).toEqual(before);
  expect(channel().coefficientCache).toBe(cache);
});
it('successful Both Off establishes an unvisited Right editor so human Both On and Undo remain independent', async () => {
  channel('right').additionalGain = 10;
  await mount();
  const before = structuredClone(state().documents);
  await act(async () => compensation()!.click());
  expect(channel().additionalGain).toBe(0);
  expect(channel('right').additionalGain).toBe(0);
  expect(state().past).toHaveLength(1);
  await act(async () => compensation()!.click());
  expect(channel().additionalGain).toBe(10);
  expect(channel('right').additionalGain).toBe(10);
  expect(channel().gain).toBe(3);
  expect(channel('right').gain).toBe(-2);
  expect(state().past).toHaveLength(2);
  await act(async () => state().undo());
  expect(channel().additionalGain).toBe(0);
  expect(channel('right').additionalGain).toBe(0);
  await act(async () => state().undo());
  expect(state().documents).toEqual(before);
});
it('actual shared command and checkbox use the same retained context, while replacement clears only the replaced project view', async () => {
  channel('right').additionalGain = 10;
  await mount();
  await act(async () =>
    expect(await execute({ hardwareGain: false }, 'both')).toMatchObject({ ok: true }),
  );
  expect(compensation()?.checked).toBe(false);
  await act(async () =>
    expect(await execute({ hardwareGain: true }, 'both')).toMatchObject({ ok: true }),
  );
  expect(compensation()?.checked).toBe(true);
  await act(async () =>
    expect(await execute({ hardwareGain: false }, 'both')).toMatchObject({ ok: true }),
  );
  const replacement = structuredClone(state().documents.left);
  await act(async () => {
    state().replaceAt('left', replacement);
    seen.adapter!.documentsReplaced!(['left']);
  });
  expect(compensation()).toBeNull();
  const before = structuredClone(state().documents),
    past = state().past.length;
  await act(async () =>
    expect(await execute({ hardwareGain: true }, 'left')).toMatchObject({ ok: false }),
  );
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(past);
  await act(async () => seen.adapter!.choose({ slot: 'right' }));
  expect(compensation()?.checked).toBe(false);
  await act(async () =>
    expect(await execute({ hardwareGain: true }, 'right')).toMatchObject({ ok: true }),
  );
  expect(channel('right').additionalGain).toBe(10);
});
it('a failed paired intent cannot retain an unavailable destination context or change either project', async () => {
  await mount();
  const before = structuredClone(state().documents),
    revision = state().documentRevision;
  await act(async () => compensation()!.click());
  expect(state().documents).toEqual(before);
  expect(state().documentRevision).toBe(revision);
  expect(state().past).toHaveLength(0);
  expect(
    seen.adapter!.hardwareGainContext!({ slot: 'right', presetIndex: 0, channelIndex: 0 }),
  ).toBeUndefined();
  await act(async () => seen.adapter!.choose({ slot: 'right' }));
  expect(compensation()).toBeNull();
});
it('a valid canonical no-op intent retains every requested editor without a phantom history entry', async () => {
  channel('right').additionalGain = 10;
  state().documents.left.hfdGainLowered = true;
  state().documents.right.hfdGainLowered = true;
  await mount();
  const before = structuredClone(state().documents);
  await act(async () =>
    expect(await execute({ hardwareGain: true }, 'both')).toMatchObject({
      ok: true,
      changed: false,
    }),
  );
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
  await act(async () =>
    expect(await execute({ hardwareGain: false }, 'right')).toMatchObject({ ok: true }),
  );
  await act(async () =>
    expect(await execute({ hardwareGain: true }, 'right')).toMatchObject({ ok: true }),
  );
  expect(channel('right').additionalGain).toBe(10);
});
it('the actual sum checkbox applies metadata through the shared plan without normalizing linked processing', async () => {
  channel('right', 1).linkedTo = 2;
  channel('right', 1).filters[0] = {
    ...newFilter('peak'),
    coefficients: { b0: 0.8, b1: 0.03, b2: 0, f1: 0.02, f2: 0.01 },
    provenance: 'panel',
  };
  channel('right', 1).coefficientCache = 'effective';
  const before = structuredClone(state().documents);
  await mount();
  const sum = host.querySelector<HTMLInputElement>('[aria-label="Include Midrange in sum"]');
  expect(sum).not.toBeNull();
  await act(async () => sum!.click());
  for (const slot of ['left', 'right'] as const) {
    expect(channel(slot, 1).includeInSum).toBe(false);
    expect(channel(slot, 1).filters).toEqual(before[slot].presets[0].channels[1].filters);
    expect(channel(slot, 1).coefficientCache).toBe(
      before[slot].presets[0].channels[1].coefficientCache,
    );
  }
  expect(state().past).toHaveLength(1);
  await act(async () => state().undo());
  expect(state().documents).toEqual(before);
});

it('source-predicted untouched half-cent Gain shows native passive Text and gives identical active/inactive callback results', async () => {
  channel().gain = 0.005;
  channel('right').gain = 0.005;
  channel('right').additionalGain = 10;
  await mount();
  const passiveText = field('Gain').value,
    before = structuredClone(state().documents);
  expect(channel().gain).toBe(0.005);
  expect(channel('right').gain).toBe(0.005);
  await act(async () =>
    expect(await execute({ hardwareGain: false }, 'both')).toMatchObject({ ok: true }),
  );
  expect(channel().gain).toBe(0);
  expect(channel('right').gain).toBe(0);
  expect(passiveText).toBe('0.00');
  expect(before.left.presets[0].channels[0].gain).toBe(0.005);
  expect(before.right.presets[0].channels[0].gain).toBe(0.005);
});

it('an active unfinished Gain draft stays visible and refuses the compensation callback without hidden fresh-text fallback', async () => {
  channel('right').additionalGain = 10;
  await mount();
  const input = field('Gain'),
    before = structuredClone(state().documents),
    revision = state().documentRevision;
  await act(async () => input.focus());
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '-');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(input.value).toBe('-');
  await act(async () =>
    expect(await execute({ hardwareGain: false }, 'both')).toMatchObject({ ok: false }),
  );
  expect(input.value).toBe('-');
  expect(state().documents).toEqual(before);
  expect(state().documentRevision).toBe(revision);
  expect(state().past).toHaveLength(0);
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  await act(async () => input.blur());
  expect(input.value).toBe('3.00');
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
});
