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

it('explicit raw Gain18 reaches both original role contexts even when compensated source stays14', async () => {
  channel().gain = 14;
  channel('right').gain = 2;
  const before = structuredClone(state().documents);
  await mount();
  await fill(field('Gain'), '18');
  expect(channel().gain).toBe(14);
  expect(channel('right').gain).toBe(18);
  expect(channel().filters).toEqual(before.left.presets[0].channels[0].filters);
  expect(channel('right').filters).toEqual(before.right.presets[0].channels[0].filters);
  expect(state().past).toHaveLength(1);
  await act(async () => state().undo());
  expect(state().documents).toEqual(before);
});

const execute = (patch: Record<string, unknown>, target = 'both') =>
  createToolExecutor(seen.adapter!)('fusion_channel_set', { target, preset: 1, channel: 1, patch });
async function draft(input: HTMLInputElement, text: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function wheel(input: HTMLInputElement, deltaY: number) {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  await act(async () => input.dispatchEvent(event));
  return event;
}
it('passive display uses Single Text without rounding stored imports and dirty half text commits Double on Enter', async () => {
  channel().gain = 0.005;
  channel().additionalGain = 0;
  state().linkedEdits = false;
  const before = structuredClone(state().documents);
  await mount();
  const input = field('Gain');
  expect(input.value).toBe('0.00');
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
  await draft(input, '7.555');
  expect(channel().gain).toBe(0.005);
  expect(input.value).toBe('7.555');
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  expect(channel().gain).toBe(7.56);
  expect(channel().gain).not.toBe(Math.fround(7.56));
  expect(input.value).toBe('7.56');
  expect(state().documents.right).toEqual(before.right);
  expect(state().past).toHaveLength(1);
  await act(async () => state().undo());
  expect(state().documents).toEqual(before);
});
it.each([
  ['-126', -125],
  ['24.0001', 24],
  ['0', 0],
] as const)(
  'typed %s uses channel factory callback bounds without changing live master controls',
  async (text, expected) => {
    channel().additionalGain = 0;
    state().linkedEdits = false;
    await mount();
    await fill(field('Gain'), text);
    expect(channel().gain).toBe(expected);
  },
);
it('source wheel is sign-only, caps destination independently and retains bypass/cache fields with one Undo', async () => {
  channel().additionalGain = 0;
  channel().gain = 17.9;
  channel('right').additionalGain = 10;
  channel('right').gain = 2;
  const before = structuredClone(state().documents);
  await mount();
  const event = await wheel(field('Gain'), -360);
  expect(event.defaultPrevented).toBe(true);
  expect(channel().gain).toBe(18);
  expect(channel('right').gain).toBe(14);
  for (const slot of ['left', 'right'] as const) {
    expect(channel(slot).filters).toEqual(before[slot].presets[0].channels[0].filters);
    expect(channel(slot).coefficientCache).toBe(
      before[slot].presets[0].channels[0].coefficientCache,
    );
  }
  expect(state().past).toHaveLength(1);
  await act(async () => state().undo());
  expect(state().documents).toEqual(before);
});
it('bound source wheel and zero delta do not mirror, clear caches or create history', async () => {
  channel().gain = 14;
  channel('right').gain = 2;
  const before = structuredClone(state().documents);
  await mount();
  const input = field('Gain');
  await wheel(input, 0);
  await wheel(input, -120);
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
  expect(input.value).toBe('14.00');
});
it('a linked destination refuses the whole typed and wheel intent before changing either project', async () => {
  channel('right').linkedTo = 1;
  const before = structuredClone(state().documents);
  await mount();
  await fill(field('Gain'), '7.555');
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
  await wheel(field('Gain'), -120);
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
});
it('a foreign accepted command discards a raw draft and Escape cannot publish it or restore old projects', async () => {
  const before = structuredClone(state().documents);
  await mount();
  const input = field('Gain');
  await draft(input, '7.555');
  expect(state().documents).toEqual(before);
  await act(async () =>
    expect(await execute({ hardwareGain: false }, 'left')).toMatchObject({ ok: true }),
  );
  const accepted = structuredClone(state().documents);
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(state().documents).toEqual(accepted);
  expect(state().past).toHaveLength(1);
  await act(async () => state().undo());
  expect(state().documents).toEqual(before);
});
it('a changed explicit raw commit is a field-owned edit and Escape only cancels a later renewed draft', async () => {
  const before = structuredClone(state().documents);
  await mount();
  const input = field('Gain');
  await fill(input, '4.125');
  const committed = structuredClone(state().documents);
  expect(channel().gain).toBe(4.13);
  expect(state().past).toHaveLength(1);
  await draft(input, '9.555');
  expect(state().documents).toEqual(committed);
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(state().documents).toEqual(committed);
  expect(state().past).toHaveLength(1);
  await act(async () => state().undo());
  expect(state().documents).toEqual(before);
});
it('channel wheel state resets after accepted AdditionalGain changes and a passive blur', async () => {
  state().linkedEdits = false;
  channel().gain = 13.9;
  await mount();
  const input = field('Gain');
  await wheel(input, -120);
  expect(channel().gain).toBe(14);
  await act(async () =>
    expect(await execute({ hardwareGain: false }, 'left')).toMatchObject({ ok: true }),
  );
  await wheel(input, -120);
  expect(channel().gain).toBe(14.1);
  await act(async () => input.focus());
  await act(async () => input.blur());
  await wheel(input, 120);
  expect(channel().gain).toBe(14);
  expect(channel().additionalGain).toBe(0);
});
it('source-predicted conflicting import keeps Text-only guard distinct from stored gain and retains continuous wheel state', async () => {
  channel().gain = 24;
  channel('right').gain = 2;
  const before = structuredClone(state().documents);
  await mount();
  const input = field('Gain');
  await wheel(input, -120);
  expect(input.value).toBe('14.00');
  expect(channel().gain).toBe(24);
  expect(host.textContent).toContain('Stored 24 dB');
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
  await wheel(input, -360);
  expect(channel().gain).toBe(14);
  expect(channel('right').gain).toBe(14);
  expect(state().past).toHaveLength(1);
  await act(async () => state().undo());
  expect(state().documents).toEqual(before);
  expect(input.value).toBe('24.00');
});
it('a foreign Right-only publication refreshes unfocused channel Text-only state without stale continuous carryover', async () => {
  channel().gain = 24;
  await mount();
  const input = field('Gain');
  await wheel(input, -120);
  expect(input.value).toBe('14.00');
  expect(channel().gain).toBe(24);
  await act(async () =>
    expect(await execute({ muted: true }, 'right')).toMatchObject({ ok: true }),
  );
  await wheel(input, -120);
  expect(channel().gain).toBe(24);
  expect(input.value).toBe('14.00');
  expect(channel('right').muted).toBe(true);
  expect(state().past).toHaveLength(1);
});
it('offline arrow extension uses the channel range so an allowed24dB cannot jump to the old18dB ceiling', async () => {
  channel().gain = 24;
  channel().additionalGain = 0;
  state().linkedEdits = false;
  await mount();
  const input = field('Gain');
  await act(async () => input.focus());
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
  );
  expect(channel().gain).toBe(23.9);
  await act(async () => input.blur());
  expect(state().past).toHaveLength(1);
});
it('the readonly latest revision refreshes an unfocused wheel before React has rendered a foreign peer edit', async () => {
  channel().gain = 24;
  await mount();
  const input = field('Gain');
  await wheel(input, -120);
  expect(input.value).toBe('14.00');
  await act(async () => {
    state().editAt(
      ['right'],
      (project) => {
        project.presets[0].channels[0].muted = true;
      },
      { independent: true, synchronizeLinks: false },
    );
    input.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
  });
  expect(channel().gain).toBe(24);
  expect(channel('right').muted).toBe(true);
  expect(state().past).toHaveLength(1);
});
it('a pre-render selected Gain replacement refuses the old wheel proposal instead of overwriting the accepted value', async () => {
  channel().gain = 24;
  await mount();
  const input = field('Gain');
  await wheel(input, -120);
  await act(async () => {
    state().editAt(
      ['left'],
      (project) => {
        project.presets[0].channels[0].gain = 13;
      },
      { independent: true, synchronizeLinks: false },
    );
    input.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
  });
  expect(channel().gain).toBe(13);
  expect(channel('right').gain).toBe(-2);
  expect(state().past).toHaveLength(1);
});
