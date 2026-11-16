// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { newFilter, newProject, type Slot } from '../src/domain/model';
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
const channel = (slot: Slot = 'left', index = 0, preset = 0) =>
  state().documents[slot].presets[preset].channels[index];
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
  for (const slot of ['left', 'right'] as const)
    state().documents[slot].presets.forEach((preset, p) =>
      preset.channels.forEach((c, index) => {
        c.gain = slot === 'left' ? 3 : -2;
        c.additionalGain = 0;
        c.delayUs = 0;
        c.globalDelayUs = slot === 'left' ? [17, 29, 43][index] : [29, 31, 47][index];
        c.hfdDelay = { localMaximum: 19, globalMaximum: 74666.6666666667 };
        c.filters[0] = {
          ...newFilter('peak'),
          frequency: 2300 + p,
          q: 1.15,
          gain: 7.5,
          coefficients: { b0: 0.9, b1: 0.02, b2: -0.01, f1: 0.1, f2: 0.05 },
          provenance: slot === 'left' ? 'hfd' : 'panel',
        };
        c.coefficientCache = slot === 'left' ? 'effective' : 'unresolved';
      }),
    );
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
  const node = Array.from(host.querySelectorAll('label'))
    .find((x) => x.textContent?.trim().startsWith(label))
    ?.querySelector('input');
  expect(node).not.toBeNull();
  return node as HTMLInputElement;
}
async function draft(input: HTMLInputElement, text: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
}
async function fill(input: HTMLInputElement, text: string) {
  await draft(input, text);
  await act(async () => input.blur());
}
async function wheel(input: HTMLInputElement, deltaY: number) {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  await act(async () => input.dispatchEvent(event));
  return event;
}
const execute = (patch: Record<string, unknown>, target = 'both', preset = 1, output = 1) =>
  createToolExecutor(seen.adapter!)('fusion_channel_set', {
    target,
    preset,
    channel: output,
    patch,
  });

it('raw16 is deferred then publishes independent role Global Text/maxima in one Undo without changing caches', async () => {
  const before = structuredClone(state().documents);
  await mount();
  const input = field('Delay');
  await draft(input, '16');
  expect(state().documents).toEqual(before);
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  for (const slot of ['left', 'right'] as const) {
    expect(channel(slot).delayUs).toBe(21);
    expect(channel(slot).hfdDelay?.localMaximum).toBe(19200);
    expect(state().documents[slot].presets[0].channels.map((c) => c.globalDelayUs)).toEqual(
      Array(3).fill(slot === 'left' ? 17 : 29),
    );
    expect(channel(slot).filters).toEqual(before[slot].presets[0].channels[0].filters);
    expect(channel(slot).coefficientCache).toBe(
      before[slot].presets[0].channels[0].coefficientCache,
    );
    expect(state().documents[slot].presets.slice(1)).toEqual(before[slot].presets.slice(1));
  }
  expect(input.value).toBe('21');
  expect(state().past).toHaveLength(1);
  await act(async () => state().undo());
  expect(state().documents).toEqual(before);
});
it('C same-visible0 input changes only Max19 to19200 while passive focus/blur is inert', async () => {
  state().linkedEdits = false;
  state().documents.left.presets[0].channels.forEach((c) => {
    c.globalDelayUs = 17;
  });
  const before = structuredClone(state().documents);
  await mount();
  const input = field('Delay');
  await act(async () => {
    input.focus();
    input.blur();
  });
  expect(state().documents).toEqual(before);
  await fill(input, '0');
  const expected = structuredClone(before);
  expected.left.presets[0].channels[0].hfdDelay!.localMaximum = 19200;
  expect(state().documents).toEqual(expected);
  expect(state().past).toHaveLength(1);
  await act(async () => state().undo());
  expect(state().documents).toEqual(before);
});
it('D source local callback copies immediate linked Gain flags/Delay maximum without opening a follower Graph', async () => {
  state().linkedEdits = false;
  const source = channel(),
    follower = channel('left', 1);
  source.gain = 0;
  source.invert = false;
  source.muted = false;
  source.coefficientCache = 'unresolved';
  Object.assign(follower, {
    linkedTo: 0,
    gain: 24,
    invert: true,
    muted: true,
    delayUs: 1,
    additionalGain: 6,
  });
  const before = structuredClone(state().documents);
  await mount();
  await fill(field('Delay'), '16');
  expect(channel('left', 1)).toMatchObject({
    gain: 0,
    invert: false,
    muted: false,
    delayUs: 21,
    additionalGain: 6,
    hfdDelay: { localMaximum: 19200 },
  });
  expect(state().channel).toBe(0);
  expect(state().documents.left.hfdSelectedGroupId).toBe(before.left.hfdSelectedGroupId);
  expect(state().documents.right).toEqual(before.right);
  expect(state().past).toHaveLength(1);
  await act(async () => state().undo());
  expect(state().documents).toEqual(before);
});
it.each([
  ['16', 21],
  ['100000', 74667],
] as const)(
  'Global raw%s publishes%d in all three current-preset channels only',
  async (raw, expected) => {
    const before = structuredClone(state().documents);
    await mount();
    await fill(field('Global delay'), raw);
    for (const slot of ['left', 'right'] as const) {
      expect(state().documents[slot].presets[0].channels.map((c) => c.globalDelayUs)).toEqual([
        expected,
        expected,
        expected,
      ]);
      expect(state().documents[slot].presets.slice(1)).toEqual(before[slot].presets.slice(1));
      state().documents[slot].presets[0].channels.forEach((c, i) => {
        expect(c.hfdDelay).toEqual(before[slot].presets[0].channels[i].hfdDelay);
        expect(c.filters).toEqual(before[slot].presets[0].channels[i].filters);
      });
    }
    expect(field('Global delay').value).toBe(String(expected));
    expect(state().past).toHaveLength(1);
    await act(async () => state().undo());
    expect(state().documents).toEqual(before);
  },
);
it('Mirror forwards original Global Text through the peer saved maximum instead of copying selected final Text', async () => {
  channel('right').hfdDelay!.globalMaximum = 1000;
  const before = structuredClone(state().documents);
  await mount();
  await fill(field('Global delay'), '100000');
  expect(state().documents.left.presets[0].channels.map((c) => c.globalDelayUs)).toEqual([
    74667, 74667, 74667,
  ]);
  expect(state().documents.right.presets[0].channels.map((c) => c.globalDelayUs)).toEqual([
    1000, 1000, 1000,
  ]);
  expect(channel().hfdDelay?.globalMaximum).toBe(74666.6666666667);
  expect(channel('right').hfdDelay?.globalMaximum).toBe(1000);
  expect(state().past).toHaveLength(1);
  await act(async () => state().undo());
  expect(state().documents).toEqual(before);
});
it.each([-120, -360])(
  'one wheel%d is one source11 step mirrored with one Undo; zero is inert',
  async (delta) => {
    channel('right').delayUs = 21;
    const before = structuredClone(state().documents);
    await mount();
    const input = field('Delay');
    expect((await wheel(input, 0)).defaultPrevented).toBe(false);
    expect(state().past).toHaveLength(0);
    expect((await wheel(input, delta)).defaultPrevented).toBe(true);
    expect(channel().delayUs).toBe(11);
    expect(channel('right').delayUs).toBe(11);
    expect(state().past).toHaveLength(1);
    await act(async () => state().undo());
    expect(state().documents).toEqual(before);
  },
);
it('a bound wheel without notification preserves imported excess precision, peers, caches and history', async () => {
  channel().delayUs = 19200.000001;
  const before = structuredClone(state().documents);
  await mount();
  expect(field('Delay').value).toBe('19200');
  await wheel(field('Delay'), -120);
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
});
it('a notified source canonical no-op still publishes its own Max/global effects while skipping the Mirror peer', async () => {
  channel('right').delayUs = 21;
  const before = structuredClone(state().documents);
  await mount();
  await draft(field('Delay'), '-10');
  await wheel(field('Delay'), -120);
  expect(channel().delayUs).toBe(0);
  expect(channel().hfdDelay?.localMaximum).toBe(19200);
  expect(state().documents.left.presets[0].channels.map((c) => c.globalDelayUs)).toEqual([
    17, 17, 17,
  ]);
  expect(state().documents.right).toEqual(before.right);
  await act(async () => field('Delay').blur());
  expect(state().past).toHaveLength(1);
});
it('a linked Mirror destination refuses typed and wheel callbacks atomically', async () => {
  channel('right').linkedTo = 1;
  const before = structuredClone(state().documents);
  await mount();
  await fill(field('Delay'), '16');
  expect(state().documents).toEqual(before);
  await wheel(field('Delay'), -120);
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
});
it('an accepted foreign command retires an unfinished Delay draft; Escape preserves it and Undo restores baseline', async () => {
  const before = structuredClone(state().documents);
  await mount();
  const input = field('Delay');
  await draft(input, '16');
  await act(async () =>
    expect(await execute({ muted: true }, 'right')).toMatchObject({ ok: true }),
  );
  const accepted = structuredClone(state().documents);
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(state().documents).toEqual(accepted);
  expect(channel().hfdDelay?.localMaximum).toBe(19);
  expect(state().past).toHaveLength(1);
  await act(async () => state().undo());
  expect(state().documents).toEqual(before);
});
it('a local callback reads currently visible dirty Global Text directly without a second sample normalization', async () => {
  state().linkedEdits = false;
  await mount();
  const global = field('Global delay');
  await draft(global, '17.123456789');
  await wheel(field('Delay'), -120);
  expect(channel().delayUs).toBe(11);
  expect(state().documents.left.presets[0].channels.map((c) => c.globalDelayUs)).toEqual([
    17.123456789, 17.123456789, 17.123456789,
  ]);
  const accepted = structuredClone(state().documents);
  await act(async () =>
    global.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(state().documents).toEqual(accepted);
  expect(state().past).toHaveLength(1);
});
it('invalid visible Global Text refuses the local callback without changing either project', async () => {
  const before = structuredClone(state().documents);
  await mount();
  const global = field('Global delay');
  await draft(global, '-');
  await wheel(field('Delay'), -120);
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
  await act(async () =>
    global.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(state().documents).toEqual(before);
});
it('a pre-render foreign command retires dirty Global Text before a subsequent local Delay MCP callback', async () => {
  await mount();
  const global = field('Global delay');
  await draft(global, '17.123456789');
  expect(global.value).toBe('17.123456789');
  expect(channel().globalDelayUs).toBe(17);
  const executor = createToolExecutor(seen.adapter!);
  await act(async () => {
    const first = executor('fusion_channel_set', {
      target: 'right',
      preset: 1,
      channel: 1,
      patch: { muted: true },
    });
    expect(channel('right').muted).toBe(true);
    expect(global.value).toBe('17.123456789');
    expect(channel().globalDelayUs).toBe(17);
    const second = executor('fusion_channel_set', {
      target: 'left',
      preset: 1,
      channel: 1,
      patch: { delayUs: '16' },
    });
    const replies = await Promise.all([first, second]);
    expect(replies).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
  });
  expect(channel().delayUs).toBe(21);
  expect(channel('right').muted).toBe(true);
  expect(state().documents.left.presets[0].channels.map((c) => c.globalDelayUs)).toEqual([
    17, 17, 17,
  ]);
  expect(state().past).toHaveLength(2);
});
it('a pre-render filter selection retires dirty Global Text even when project revision is unchanged', async () => {
  await mount();
  const global = field('Global delay');
  await draft(global, '17.123456789');
  const revision = state().documentRevision;
  const executor = createToolExecutor(seen.adapter!);
  await act(async () => {
    const first = executor('fusion_select', { filter: 2 });
    expect(state().filter).toBe(1);
    expect(state().documentRevision).toBe(revision);
    expect(global.value).toBe('17.123456789');
    expect(channel().globalDelayUs).toBe(17);
    const second = executor('fusion_channel_set', {
      target: 'left',
      preset: 1,
      channel: 1,
      patch: { delayUs: '16' },
    });
    const replies = await Promise.all([first, second]);
    expect(replies).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
  });
  expect(channel().delayUs).toBe(21);
  expect(state().documents.left.presets[0].channels.map((c) => c.globalDelayUs)).toEqual([
    17, 17, 17,
  ]);
  expect(state().past).toHaveLength(1);
});
it('MCP on an inactive role/preset/channel uses its own passive context rather than selected visible Text', async () => {
  const before = structuredClone(state().documents);
  await mount();
  await act(async () =>
    expect(await execute({ delayUs: '16' }, 'right', 2, 3)).toMatchObject({ ok: true }),
  );
  expect(channel('right', 2, 1).delayUs).toBe(21);
  expect(state().documents.right.presets[1].channels.map((c) => c.globalDelayUs)).toEqual([
    47, 47, 47,
  ]);
  expect(state().documents.left).toEqual(before.left);
  expect(state().documents.right.presets[0]).toEqual(before.right.presets[0]);
  expect(state().slot).toBe('left');
  expect(state().preset).toBe(0);
  expect(state().channel).toBe(0);
  expect(state().past).toHaveLength(1);
});
