import { describe, expect, it } from 'vitest';
import { newProject } from '../src/domain/model';
import {
  createIndexedDbWorkspaceBackend,
  createWorkspacePersistence,
  SERVER_WORKSPACE_PERSISTENCE_STATUS,
  type PersistedWorkspace,
  type WorkspaceEnvelope,
  type WorkspacePersistenceBackend,
} from '../src/state/persistence';
import { createWorkspaceStore } from '../src/state/workspace';

function snapshot(name = 'Original'): PersistedWorkspace {
  return {
    documents: { left: newProject(name), right: newProject('Right') },
    slot: 'left',
    preset: 0,
    channel: 0,
    filter: 0,
    linkedEdits: false,
    linkedControls: true,
  };
}
function memory(initial: unknown | null = null, legacy: string | null = null) {
  let stored = structuredClone(initial),
    failWrite = false,
    failRead = false,
    corruptReadback = false;
  let writes = 0,
    reads = 0,
    legacyReads = 0;
  const backend: WorkspacePersistenceBackend = {
    read: async () => {
      reads++;
      if (failRead) throw Error('Read unavailable');
      return structuredClone(stored);
    },
    write: async (value) => {
      writes++;
      if (failWrite) throw Error('Quota exceeded');
      stored = structuredClone(value);
      if (corruptReadback)
        (stored as WorkspaceEnvelope).state.documents.left.name = 'Wrong readback';
    },
    readLegacy: () => {
      legacyReads++;
      return legacy;
    },
  };
  return {
    backend,
    get stored() {
      return stored;
    },
    get writes() {
      return writes;
    },
    get reads() {
      return reads;
    },
    get legacyReads() {
      return legacyReads;
    },
    get legacy() {
      return legacy;
    },
    set failWrite(x: boolean) {
      failWrite = x;
    },
    set failRead(x: boolean) {
      failRead = x;
    },
    set corruptReadback(x: boolean) {
      corruptReadback = x;
    },
  };
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it('round-trips a workspace larger than localStorage capacity with independent documents and processing', async () => {
  const state = snapshot('Large measurement');
  state.documents.left.presets[0].channels[0].measurement = {
    name: 'Large impulse',
    sampleRate: 48000,
    impulse: Array.from({ length: 600000 }, (_, i) => (i === 12 ? 1 : 0.123456789)),
  };
  expect(JSON.stringify(state).length).toBeGreaterThan(5 * 1024 * 1024);
  const disk = memory();
  const writer = createWorkspacePersistence(disk.backend);
  await writer.hydrate();
  writer.save(state);
  await writer.flush();
  let loaded: PersistedWorkspace | null = null;
  const reader = createWorkspacePersistence(disk.backend, (s) => {
    loaded = s;
  });
  await reader.hydrate();
  expect(loaded).toEqual(state);
  expect(reader.getSnapshot()).toMatchObject({
    hydrated: true,
    source: 'indexeddb',
    unsaved: false,
  });
  state.documents.left.presets[0].channels[0].measurement!.impulse![12] = 7;
  expect(
    (loaded as unknown as PersistedWorkspace).documents.left.presets[0].channels[0].measurement!
      .impulse![12],
  ).toBe(1);
});

it('serializes delayed writes and coalesces later snapshots without an old completion overwriting them', async () => {
  const gate = deferred(),
    values: string[] = [];
  let stored: unknown = null,
    active = 0,
    maxActive = 0;
  const backend: WorkspacePersistenceBackend = {
    read: async () => structuredClone(stored),
    readLegacy: () => null,
    write: async (value) => {
      active++;
      maxActive = Math.max(maxActive, active);
      values.push(value.state.documents.left.name);
      if (values.length === 1) await gate.promise;
      stored = structuredClone(value);
      active--;
    },
  };
  const p = createWorkspacePersistence(backend);
  await p.hydrate();
  p.save(snapshot('First'));
  p.save(snapshot('Second'));
  p.save(snapshot('Newest'));
  expect(values).toEqual(['First']);
  expect(p.getSnapshot()).toMatchObject({ saving: true, unsaved: true });
  gate.resolve();
  await p.flush();
  expect(values).toEqual(['First', 'Newest']);
  expect(maxActive).toBe(1);
  expect((stored as WorkspaceEnvelope).state.documents.left.name).toBe('Newest');
});

it('migrates valid legacy Zustand data only after validated durable readback and retains its recovery copy', async () => {
  const state = snapshot('Legacy design'),
    legacy = JSON.stringify({ state, version: 0 }),
    disk = memory(null, legacy);
  let applied: PersistedWorkspace | null = null;
  const p = createWorkspacePersistence(disk.backend, (s) => {
    expect(p.getSnapshot().hydrated).toBe(false);
    applied = s;
  });
  expect(p.getSnapshot()).toBe(SERVER_WORKSPACE_PERSISTENCE_STATUS);
  await p.hydrate();
  expect(applied).toEqual(state);
  expect(disk.writes).toBe(1);
  expect(disk.reads).toBe(2);
  expect(disk.legacy).toBe(legacy);
  expect(p.getSnapshot()).toMatchObject({ hydrated: true, source: 'legacy' });
});

it('prefers validated IndexedDB data without consulting a corrupt stale legacy copy', async () => {
  const state = snapshot('IndexedDB is newer'),
    disk = memory({ version: 1, state }, '{broken legacy');
  let actual: PersistedWorkspace | null = null;
  const p = createWorkspacePersistence(disk.backend, (s) => {
    actual = s;
  });
  await p.hydrate();
  expect(actual).toEqual(state);
  expect(disk.legacyReads).toBe(0);
  expect(disk.writes).toBe(0);
});

describe('initial read/migration failures keep editing blocked and existing data intact', () => {
  it('does not write defaults after a failed IndexedDB read, and retries without replacing memory first', async () => {
    const original = { version: 1 as const, state: snapshot('Saved') },
      disk = memory(original);
    disk.failRead = true;
    const { store, persistence } = createWorkspaceStore(disk.backend);
    await expect(persistence.hydrate()).rejects.toThrow('Read unavailable');
    expect(() =>
      store.getState().edit((p) => {
        p.name = 'Wrong default';
      }),
    ).toThrow('finish loading');
    expect(disk.writes).toBe(0);
    expect(disk.stored).toEqual(original);
    expect(persistence.getSnapshot()).toMatchObject({ phase: 'error', hydrated: false });
    disk.failRead = false;
    await persistence.retry();
    expect(store.getState().documents.left.name).toBe('Saved');
    expect(disk.writes).toBe(0);
  });
  it.each(['write', 'readback'] as const)(
    'retains legacy recovery when migration %s fails',
    async (failure) => {
      const legacy = JSON.stringify({ version: 0, state: snapshot('Legacy') });
      const disk = memory(null, legacy);
      if (failure === 'write') disk.failWrite = true;
      else disk.corruptReadback = true;
      let applied = false;
      const p = createWorkspacePersistence(disk.backend, () => {
        applied = true;
      });
      await expect(p.hydrate()).rejects.toThrow();
      expect(applied).toBe(false);
      expect(p.getSnapshot().hydrated).toBe(false);
      expect(p.recoveryText()).toBe(legacy);
      expect(disk.legacy).toBe(legacy);
    },
  );
  it.each([
    '{not json',
    JSON.stringify({ version: 9, state: snapshot() }),
    JSON.stringify({ version: 0, state: { ...snapshot(), filter: 15 } }),
    JSON.stringify({
      version: 0,
      state: { ...snapshot(), documents: { left: { model: 'Wrong' }, right: newProject() } },
    }),
    JSON.stringify({ version: 0, state: { ...snapshot(), editAt: 'injected' } }),
  ])('rejects corrupt/unsupported legacy data without saving defaults: %s', async (legacy) => {
    const disk = memory(null, legacy),
      p = createWorkspacePersistence(disk.backend);
    await expect(p.hydrate()).rejects.toThrow();
    expect(disk.writes).toBe(0);
    expect(p.recoveryText()).toBe(legacy);
    expect(p.getSnapshot()).toMatchObject({ phase: 'error', hydrated: false });
  });
  it('does not fall back to legacy when the existing IndexedDB record is invalid', async () => {
    const raw = { version: 900, state: snapshot() },
      disk = memory(raw, JSON.stringify({ version: 0, state: snapshot('Older') })),
      p = createWorkspacePersistence(disk.backend);
    await expect(p.hydrate()).rejects.toThrow();
    expect(disk.legacyReads).toBe(0);
    expect(disk.writes).toBe(0);
    expect(JSON.parse(p.recoveryText()!)).toEqual(raw);
  });
});

it('does not initialize or save defaults while hydration is pending and applies loaded state before readiness', async () => {
  const gate = deferred<unknown | null>();
  let writes = 0;
  const desired = snapshot('Delayed saved design');
  const { store, persistence } = createWorkspaceStore({
    read: () => gate.promise,
    write: async () => {
      writes++;
    },
    readLegacy: () => null,
  });
  expect(persistence.getSnapshot()).toBe(SERVER_WORKSPACE_PERSISTENCE_STATUS);
  expect(writes).toBe(0);
  const loading = persistence.hydrate();
  expect(() => store.getState().choose({ slot: 'right' })).toThrow('finish loading');
  persistence.subscribe(() => {
    if (persistence.getSnapshot().hydrated)
      expect(store.getState().documents.left.name).toBe('Delayed saved design');
  });
  gate.resolve({ version: 1, state: desired });
  await loading;
  expect(writes).toBe(0);
  expect(store.getState().documents).toEqual(desired.documents);
});

it('surfaces a failed save, preserves the latest edits for recovery, and retries that version rather than reloading old data', async () => {
  const disk = memory({ version: 1, state: snapshot('Old saved version') }),
    { store, persistence } = createWorkspaceStore(disk.backend);
  await persistence.hydrate();
  disk.failWrite = true;
  store.getState().edit((p) => {
    p.name = 'First unsaved';
  });
  await expect(persistence.flush()).rejects.toThrow();
  store.getState().edit((p) => {
    p.name = 'Newest unsaved';
  });
  expect(persistence.getSnapshot()).toMatchObject({
    phase: 'error',
    hydrated: true,
    saving: false,
    unsaved: true,
  });
  expect(JSON.parse(persistence.recoveryText()!).state.documents.left.name).toBe('Newest unsaved');
  disk.failWrite = false;
  await persistence.retry();
  await persistence.flush();
  expect((disk.stored as WorkspaceEnvelope).state.documents.left.name).toBe('Newest unsaved');
  expect(store.getState().documents.left.name).toBe('Newest unsaved');
  expect(persistence.getSnapshot()).toMatchObject({
    phase: 'ready',
    hydrated: true,
    unsaved: false,
    error: null,
  });
});

it('does not claim a readback mismatch is saved and can retry the latest valid data', async () => {
  const disk = memory(),
    p = createWorkspacePersistence(disk.backend);
  await p.hydrate();
  disk.corruptReadback = true;
  p.save(snapshot('Desired'));
  await expect(p.flush()).rejects.toThrow('readback');
  expect(p.getSnapshot()).toMatchObject({ phase: 'error', unsaved: true });
  disk.corruptReadback = false;
  await p.retry();
  await p.flush();
  expect((disk.stored as WorkspaceEnvelope).state.documents.left.name).toBe('Desired');
});

it('keeps a rejected snapshot visible even when a previous in-flight write finishes', async () => {
  const gate = deferred();
  let stored: unknown = null;
  const p = createWorkspacePersistence({
    read: async () => stored,
    readLegacy: () => null,
    write: async (v) => {
      await gate.promise;
      stored = structuredClone(v);
    },
  });
  await p.hydrate();
  p.save(snapshot('Valid in flight'));
  p.save({ ...snapshot('Invalid'), filter: 99 });
  gate.resolve();
  await expect(p.flush()).rejects.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(p.getSnapshot()).toMatchObject({ phase: 'error', unsaved: true });
  await expect(p.retry()).rejects.toThrow();
  p.save(snapshot('Repaired'));
  await p.retry();
  await p.flush();
  expect((stored as WorkspaceEnvelope).state.documents.left.name).toBe('Repaired');
});

it('reports missing IndexedDB explicitly without touching any legacy data', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
  try {
    const p = createWorkspacePersistence(createIndexedDbWorkspaceBackend());
    await expect(p.hydrate()).rejects.toThrow('IndexedDB is unavailable');
    expect(p.getSnapshot()).toMatchObject({ phase: 'error', hydrated: false });
  } finally {
    if (original) Object.defineProperty(globalThis, 'indexedDB', original);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  }
});
it('coalesces concurrent hydration calls and ignores observer exceptions without losing the saved record', async () => {
  const gate = deferred<unknown | null>();
  let reads = 0,
    applied = 0;
  const p = createWorkspacePersistence(
    {
      read: () => {
        reads++;
        return gate.promise;
      },
      write: async () => {},
      readLegacy: () => null,
    },
    () => {
      applied++;
    },
  );
  p.subscribe(() => {
    throw Error('View observer failed');
  });
  const first = p.hydrate(),
    second = p.hydrate();
  expect(first).toBe(second);
  expect(reads).toBe(1);
  gate.resolve({ version: 1, state: snapshot('Shared hydration') });
  await first;
  expect(applied).toBe(1);
  expect(p.getSnapshot().hydrated).toBe(true);
});
it('treats denied legacy storage reads as errors instead of evidence for a new empty workspace', async () => {
  let writes = 0;
  const p = createWorkspacePersistence({
    read: async () => null,
    write: async () => {
      writes++;
    },
    readLegacy: () => {
      throw Error('Legacy access denied');
    },
  });
  await expect(p.hydrate()).rejects.toThrow('Legacy access denied');
  expect(writes).toBe(0);
  expect(p.getSnapshot().hydrated).toBe(false);
});
