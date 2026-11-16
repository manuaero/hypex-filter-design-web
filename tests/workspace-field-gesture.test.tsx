// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { newFilter, newProject } from '../src/domain/model';
import {
  createWorkspaceStore,
  ensureWorkspaceHydrated,
  useWorkspace,
  type WorkspaceFieldGestureToken,
} from '../src/state/workspace';
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
  let saved: unknown = null;
  const workspace = actual.createWorkspaceStore({
    read: async () => saved,
    write: async (value) => {
      saved = structuredClone(value);
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

const command = (patch: Record<string, unknown>) =>
  createToolExecutor(
    new Proxy({} as ToolAdapter, { get: (_, key) => seen.adapter![key as keyof ToolAdapter] }),
  )('fusion_channel_set', { target: 'both', preset: 1, channel: 1, patch });
const escape = async (input: HTMLInputElement) => {
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  await act(async () => input.blur());
};

it('a successful paired compensation command while Gain is focused survives Escape and has one exact Undo', async () => {
  channel('right').additionalGain = 10;
  state().documents.left.hfdGainLowered = true;
  state().documents.right.hfdGainLowered = true;
  const original = structuredClone(state().documents);
  await mount();
  const input = field('Gain');
  await act(async () => input.focus());
  await act(async () =>
    expect(await command({ hardwareGain: false })).toMatchObject({ ok: true, changed: true }),
  );
  const accepted = structuredClone(state().documents);
  expect(channel().additionalGain).toBe(0);
  expect(channel('right').additionalGain).toBe(0);
  await escape(input);
  expect(state().documents).toEqual(accepted);
  expect(state().past).toHaveLength(1);
  await act(async () => state().undo());
  expect(state().documents).toEqual(original);
});
it('a successful paired Gain command cannot be overwritten by the focused field stale Escape baseline', async () => {
  const original = structuredClone(state().documents);
  await mount();
  const input = field('Gain');
  await act(async () => input.focus());
  await act(async () => expect(await command({ gain: -6 })).toMatchObject({ ok: true }));
  const accepted = structuredClone(state().documents);
  await escape(input);
  expect(state().documents).toEqual(accepted);
  expect(channel().gain).toBe(-6);
  expect(state().past).toHaveLength(1);
  await act(async () => state().undo());
  expect(state().documents).toEqual(original);
});

async function isolatedFieldStore() {
  let saved: unknown = null;
  const { store, persistence } = createWorkspaceStore({
    read: async () => saved,
    write: async (value) => {
      saved = structuredClone(value);
    },
    readLegacy: () => null,
  });
  await persistence.hydrate();
  store.setState({
    documents: { left: newProject('Left'), right: newProject('Right') },
    past: [],
    future: [],
    gesture: undefined,
  });
  return { state: store.getState, persistence };
}

const localFieldEdit = (
  f: Awaited<ReturnType<typeof isolatedFieldStore>>,
  token: WorkspaceFieldGestureToken,
  ...args: Parameters<ReturnType<typeof f.state>['editAt']>
) => f.state().runFieldGesture(token, () => f.state().editAt(...args));

it('field authority groups its own edits, permits legitimate cancel and cannot be cancelled by a legacy end callback', async () => {
  const f = await isolatedFieldStore(),
    original = structuredClone(f.state().documents),
    token = f.state().beginFieldGesture();
  localFieldEdit(
    f,
    token,
    ['left', 'right'],
    (p) => {
      p.presets[0].channels[0].gain = 3;
    },
    { synchronizeLinks: false },
  );
  localFieldEdit(
    f,
    token,
    ['left'],
    (p) => {
      p.presets[0].channels[0].gain = 4;
    },
    { synchronizeLinks: false },
  );
  expect(f.state().isFieldGestureCurrent(token)).toBe(true);
  expect(f.state().past).toHaveLength(0);
  f.state().endGesture(true);
  expect(f.state().isFieldGestureCurrent(token)).toBe(true);
  f.state().endFieldGesture(token, true);
  expect(f.state().documents).toEqual(original);
  expect(f.state().past).toHaveLength(0);
  expect(f.state().isFieldGestureCurrent(token)).toBe(false);
  await f.persistence.flush();
});

it('independent publication commits pending field work before its own paired Undo, then rejects stale cancellation authority', async () => {
  const f = await isolatedFieldStore(),
    original = structuredClone(f.state().documents),
    token = f.state().beginFieldGesture();
  localFieldEdit(
    f,
    token,
    ['left'],
    (p) => {
      p.name = 'Own field draft';
    },
    { synchronizeLinks: false },
  );
  const own = structuredClone(f.state().documents);
  f.state().editAt(
    ['left', 'right'],
    (p, slot) => {
      p.name = 'Foreign ' + slot;
    },
    { independent: true, synchronizeLinks: false },
  );
  const accepted = structuredClone(f.state().documents);
  expect(f.state().past).toHaveLength(2);
  expect(f.state().isFieldGestureCurrent(token)).toBe(false);
  f.state().endFieldGesture(token, true);
  expect(f.state().documents).toEqual(accepted);
  f.state().undo();
  expect(f.state().documents).toEqual(own);
  f.state().undo();
  expect(f.state().documents).toEqual(original);
  await f.persistence.flush();
});

it('an independent edit after an untouched focus creates one Undo with no empty focus receipt', async () => {
  const f = await isolatedFieldStore(),
    original = structuredClone(f.state().documents),
    token = f.state().beginFieldGesture();
  f.state().editAt(
    ['left', 'right'],
    (p) => {
      p.name = 'Independent';
    },
    { independent: true, synchronizeLinks: false },
  );
  const accepted = structuredClone(f.state().documents);
  f.state().endFieldGesture(token, true);
  expect(f.state().documents).toEqual(accepted);
  expect(f.state().past).toHaveLength(1);
  f.state().undo();
  expect(f.state().documents).toEqual(original);
  await f.persistence.flush();
});

it('a default untagged service edit cannot acquire field cancellation authority merely because focus is open', async () => {
  const f = await isolatedFieldStore(),
    original = structuredClone(f.state().documents),
    token = f.state().beginFieldGesture();
  f.state().editAt(
    ['left', 'right'],
    (p) => {
      p.name = 'Foreign service';
    },
    { synchronizeLinks: false },
  );
  const accepted = structuredClone(f.state().documents);
  f.state().endFieldGesture(token, true);
  expect(f.state().documents).toEqual(accepted);
  expect(f.state().past).toHaveLength(1);
  f.state().undo();
  expect(f.state().documents).toEqual(original);
  await f.persistence.flush();
});

it('validates every detached independent target before retiring field authority or publishing any role', async () => {
  const f = await isolatedFieldStore(),
    token = f.state().beginFieldGesture();
  localFieldEdit(
    f,
    token,
    ['left'],
    (p) => {
      p.name = 'Cancellable';
    },
    { synchronizeLinks: false },
  );
  const before = f.state();
  expect(() =>
    f.state().editAt(
      ['left', 'right'],
      (p, slot) => {
        p.name = 'Never publish';
        if (slot === 'right') throw Error('Peer refused');
      },
      { independent: true, synchronizeLinks: false },
    ),
  ).toThrow('Peer refused');
  expect(f.state()).toBe(before);
  expect(f.state().isFieldGestureCurrent(token)).toBe(true);
  f.state().endFieldGesture(token, true);
  expect(f.state().documents.left.name).toBe('Left');
  await f.persistence.flush();
});

it('invalid replacement destination and uncloneable payload leave the current field lease and draft exact', async () => {
  const f = await isolatedFieldStore(),
    token = f.state().beginFieldGesture();
  localFieldEdit(
    f,
    token,
    ['left'],
    (p) => {
      p.name = 'Cancellable';
    },
    { synchronizeLinks: false },
  );
  const before = f.state();
  expect(() => f.state().replaceAt('other' as 'left', newProject(), { independent: true })).toThrow(
    /destination/i,
  );
  const bad = { ...newProject(), invalid: () => undefined };
  expect(() => f.state().replaceAt('left', bad, { independent: true })).toThrow();
  expect(f.state()).toBe(before);
  expect(f.state().isFieldGestureCurrent(token)).toBe(true);
  f.state().endFieldGesture(token, true);
  await f.persistence.flush();
});

it('uses a unique field identity even when an unchanged new focus reuses the identical Documents object', async () => {
  const f = await isolatedFieldStore(),
    first = f.state().beginFieldGesture(),
    sameDocuments = f.state().documents,
    revision = f.state().documentRevision;
  f.state().endFieldGesture(first);
  expect(f.state().documentRevision).toBe(revision);
  expect(f.state().past).toEqual([]);
  const second = f.state().beginFieldGesture();
  expect(f.state().documents).toBe(sameDocuments);
  expect(second).not.toBe(first);
  expect(f.state().isFieldGestureCurrent(first)).toBe(false);
  expect(f.state().isFieldGestureCurrent(second)).toBe(true);
  localFieldEdit(
    f,
    second,
    ['left'],
    (p) => {
      p.name = 'Second focus';
    },
    { synchronizeLinks: false },
  );
  f.state().endFieldGesture(first, true);
  expect(f.state().documents.left.name).toBe('Second focus');
  expect(f.state().isFieldGestureCurrent(second)).toBe(true);
  f.state().endFieldGesture(second, true);
  expect(f.state().documents).toBe(sameDocuments);
  await f.persistence.flush();
});

it('a new focus commits the previous pending field group before issuing unrelated cancellation authority', async () => {
  const f = await isolatedFieldStore(),
    original = structuredClone(f.state().documents),
    first = f.state().beginFieldGesture();
  localFieldEdit(
    f,
    first,
    ['left'],
    (p) => {
      p.name = 'First field';
    },
    { synchronizeLinks: false },
  );
  const committed = structuredClone(f.state().documents),
    second = f.state().beginFieldGesture();
  expect(f.state().isFieldGestureCurrent(first)).toBe(false);
  expect(f.state().past).toHaveLength(1);
  localFieldEdit(
    f,
    second,
    ['right'],
    (p) => {
      p.name = 'Second draft';
    },
    { synchronizeLinks: false },
  );
  f.state().endFieldGesture(first, true);
  expect(f.state().documents.right.name).toBe('Second draft');
  f.state().endFieldGesture(second, true);
  expect(f.state().documents).toEqual(committed);
  expect(f.state().past).toHaveLength(1);
  f.state().undo();
  expect(f.state().documents).toEqual(original);
  await f.persistence.flush();
});

it('denies forged and cross-store field leases without ending the current focus', async () => {
  const f = await isolatedFieldStore(),
    g = await isolatedFieldStore(),
    token = f.state().beginFieldGesture(),
    other = g.state().beginFieldGesture();
  localFieldEdit(
    f,
    token,
    ['left'],
    (p) => {
      p.name = 'Own';
    },
    { synchronizeLinks: false },
  );
  expect(f.state().isFieldGestureCurrent(other)).toBe(false);
  expect(g.state().isFieldGestureCurrent(token)).toBe(false);
  f.state().endFieldGesture({} as WorkspaceFieldGestureToken, true);
  f.state().endFieldGesture(other, true);
  expect(f.state().documents.left.name).toBe('Own');
  expect(f.state().isFieldGestureCurrent(token)).toBe(true);
  f.state().endFieldGesture(token, true);
  g.state().endFieldGesture(other);
  await f.persistence.flush();
  await g.persistence.flush();
});

it.each(['choose', 'undo', 'redo', 'replace', 'copy'] as const)(
  'retires field authority at the natural %s context boundary without allowing its late cancel to restore old documents',
  async (action) => {
    const f = await isolatedFieldStore(),
      token = f.state().beginFieldGesture();
    localFieldEdit(
      f,
      token,
      ['left'],
      (p) => {
        p.name = 'Own';
      },
      { synchronizeLinks: false },
    );
    if (action === 'choose') f.state().choose({ channel: 1 });
    if (action === 'undo') f.state().undo();
    if (action === 'redo') f.state().redo();
    if (action === 'replace') f.state().replaceAt('right', newProject('Replacement'));
    if (action === 'copy') f.state().copyPreset(1);
    const current = structuredClone(f.state().documents),
      past = f.state().past.length;
    expect(f.state().isFieldGestureCurrent(token)).toBe(false);
    f.state().endFieldGesture(token, true);
    expect(f.state().documents).toEqual(current);
    expect(f.state().past).toHaveLength(past);
    await f.persistence.flush();
  },
);

it('rejects a file import while a field is active without applying or retiring its cancellable work', async () => {
  const f = await isolatedFieldStore(),
    token = f.state().beginFieldGesture();
  localFieldEdit(
    f,
    token,
    ['left'],
    (p) => {
      p.name = 'Own field';
    },
    { synchronizeLinks: false },
  );
  const before = f.state(),
    apply = vi.fn();
  await expect(
    f
      .state()
      .commitFileImport(
        'field-active-import',
        { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'manual:test' },
        f.state().documentRevision ?? 0,
        ['left'],
        apply,
        { ok: true },
      ),
  ).rejects.toThrow(/finish.*edit/i);
  expect(apply).not.toHaveBeenCalled();
  expect(f.state()).toBe(before);
  expect(f.state().isFieldGestureCurrent(token)).toBe(true);
  f.state().endFieldGesture(token, true);
  expect(f.state().documents.left.name).toBe('Left');
  await f.persistence.flush();
});

it('retains legacy anonymous grouping unless an independent caller explicitly marks its edit boundary', async () => {
  const f = await isolatedFieldStore(),
    original = structuredClone(f.state().documents);
  f.state().beginGesture();
  f.state().editAt(
    ['left'],
    (p) => {
      p.name = 'Legacy';
    },
    { synchronizeLinks: false },
  );
  f.state().endGesture(true);
  expect(f.state().documents).toEqual(original);
  f.state().beginGesture();
  f.state().editAt(
    ['left'],
    (p) => {
      p.name = 'Legacy committed';
    },
    { synchronizeLinks: false },
  );
  const own = structuredClone(f.state().documents);
  f.state().editAt(
    ['right'],
    (p) => {
      p.name = 'Foreign';
    },
    { independent: true, synchronizeLinks: false },
  );
  const accepted = structuredClone(f.state().documents);
  f.state().endGesture(true);
  expect(f.state().documents).toEqual(accepted);
  expect(f.state().past).toHaveLength(2);
  f.state().undo();
  expect(f.state().documents).toEqual(own);
  await f.persistence.flush();
});

it.each(['choose', 'undo', 'redo', 'replace'] as const)(
  'the independent %s option retires legacy anonymous authority without allowing late cancellation',
  async (action) => {
    const f = await isolatedFieldStore();
    f.state().beginGesture();
    f.state().editAt(
      ['left'],
      (p) => {
        p.name = 'Legacy pending';
      },
      { synchronizeLinks: false },
    );
    if (action === 'choose') f.state().choose({ channel: 1 }, { independent: true });
    if (action === 'undo') f.state().undo({ independent: true });
    if (action === 'redo') f.state().redo({ independent: true });
    if (action === 'replace')
      f.state().replaceAt('right', newProject('Replacement'), { independent: true });
    expect(f.state().gesture).toBeUndefined();
    const documents = structuredClone(f.state().documents),
      past = f.state().past.length;
    f.state().endGesture(true);
    expect(f.state().documents).toEqual(documents);
    expect(f.state().past).toHaveLength(past);
    await f.persistence.flush();
  },
);

it('does not conflate field focus with owned graph authority or admit conflicting independent/token edits', async () => {
  const f = await isolatedFieldStore(),
    field = f.state().beginFieldGesture();
  localFieldEdit(
    f,
    field,
    ['left'],
    (p) => {
      p.name = 'Field';
    },
    { synchronizeLinks: false },
  );
  const graph = f.state().beginOwnedGesture();
  expect(f.state().isFieldGestureCurrent(field)).toBe(false);
  expect(f.state().isOwnedGestureCurrent(graph)).toBe(true);
  const before = f.state();
  expect(() =>
    f.state().editAt(
      ['left'],
      () => {
        throw Error('Callback must not run');
      },
      { independent: true, gestureToken: graph },
    ),
  ).toThrow(/independent/i);
  expect(f.state()).toBe(before);
  expect(f.state().isOwnedGestureCurrent(graph)).toBe(true);
  f.state().endFieldGesture(field, true);
  f.state().endOwnedGesture(graph);
  await f.persistence.flush();
});

it('rejects stale or forged runner tokens before callbacks and preserves the current unrelated focus', async () => {
  const f = await isolatedFieldStore(),
    token = f.state().beginFieldGesture(),
    rejected = vi.fn();
  expect(() => f.state().runFieldGesture({} as WorkspaceFieldGestureToken, rejected)).toThrow(
    /stale/i,
  );
  f.state().editAt(
    ['right'],
    (p) => {
      p.name = 'Foreign';
    },
    { synchronizeLinks: false },
  );
  const newer = f.state().beginFieldGesture();
  expect(() => f.state().runFieldGesture(token, rejected)).toThrow(/stale/i);
  expect(rejected).not.toHaveBeenCalled();
  expect(f.state().isFieldGestureCurrent(newer)).toBe(true);
  f.state().endFieldGesture(newer);
  await f.persistence.flush();
});

it('restores synchronous runner scope after throws and same-token nesting without granting the next service call local ownership', async () => {
  const f = await isolatedFieldStore(),
    token = f.state().beginFieldGesture(),
    original = structuredClone(f.state().documents);
  expect(() =>
    f.state().runFieldGesture(token, () => {
      f.state().runFieldGesture(token, () =>
        f.state().editAt(
          ['left'],
          (p) => {
            p.name = 'Own prefix';
          },
          { synchronizeLinks: false },
        ),
      );
      throw Error('Own callback failed after edit');
    }),
  ).toThrow('Own callback failed after edit');
  const prefix = structuredClone(f.state().documents);
  expect(f.state().isFieldGestureCurrent(token)).toBe(true);
  expect(f.state().past).toHaveLength(0);
  f.state().editAt(
    ['right'],
    (p) => {
      p.name = 'Independent after throw';
    },
    { synchronizeLinks: false },
  );
  const accepted = structuredClone(f.state().documents);
  expect(f.state().isFieldGestureCurrent(token)).toBe(false);
  expect(f.state().past).toHaveLength(2);
  f.state().endFieldGesture(token, true);
  expect(f.state().documents).toEqual(accepted);
  f.state().undo();
  expect(f.state().documents).toEqual(prefix);
  f.state().undo();
  expect(f.state().documents).toEqual(original);
  await f.persistence.flush();
});

it('returned promises do not roll back a synchronous prefix or carry local authority into a later continuation', async () => {
  const f = await isolatedFieldStore(),
    token = f.state().beginFieldGesture(),
    original = structuredClone(f.state().documents);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const action = async () => {
    f.state().editAt(
      ['left'],
      (p) => {
        p.name = 'Synchronous prefix';
      },
      { synchronizeLinks: false },
    );
    await gate;
    f.state().editAt(
      ['right'],
      (p) => {
        p.name = 'Later independent continuation';
      },
      { synchronizeLinks: false },
    );
    throw Error('Observed promise rejection');
  };
  expect(() => f.state().runFieldGesture(token, action)).toThrow(/synchronous/i);
  const prefix = structuredClone(f.state().documents);
  expect(prefix.left.name).toBe('Synchronous prefix');
  expect(f.state().past).toHaveLength(0);
  release();
  await gate;
  await Promise.resolve();
  await Promise.resolve();
  expect(f.state().documents.right.name).toBe('Later independent continuation');
  expect(f.state().isFieldGestureCurrent(token)).toBe(false);
  expect(f.state().past).toHaveLength(2);
  const accepted = structuredClone(f.state().documents);
  f.state().endFieldGesture(token, true);
  expect(f.state().documents).toEqual(accepted);
  f.state().undo();
  expect(f.state().documents).toEqual(prefix);
  f.state().undo();
  expect(f.state().documents).toEqual(original);
  await f.persistence.flush();
});
