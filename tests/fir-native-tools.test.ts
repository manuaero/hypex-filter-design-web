// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';
import { newProject, type Fir, type Project, type Slot } from '../src/domain/model';
import { createWorkspaceStore } from '../src/state/workspace';
import { assertWorkspaceWrite, type WorkspaceEnvelope } from '../src/state/persistence';
import * as firHardware from '../src/hardware/fir';

afterEach(() => vi.restoreAllMocks());

const native = (capacity: number, enabled = true, used = true): Fir => ({
  name: 'Original.txt',
  enabled,
  taps: Array.from({ length: capacity }, (_, i) => (i === 1 ? 0.5 : 0)),
  hfdState: { loaded: true, used, tapCount: capacity },
});
async function fixture(invalidPeer = false) {
  const documents = { left: newProject('Left'), right: newProject('Right') };
  for (const doc of Object.values(documents)) {
    const p = doc.presets[0];
    p.firPlacement = 'output';
    p.inputFir = native(4500, true, false);
    p.channels.forEach((c) => {
      c.fir = native(1500);
    });
    p.channels[1].linkedTo = 0;
  }
  documents.right.presets[0].channels[1].fir.enabled = false;
  let envelope: WorkspaceEnvelope = {
    version: 1,
    state: {
      documents,
      slot: 'left',
      preset: 0,
      channel: 1,
      filter: 0,
      linkedEdits: true,
      linkedControls: true,
      documentRevision: 0,
    },
  };
  const { store, persistence } = createWorkspaceStore({
    read: async () => structuredClone(envelope),
    readLegacy: () => null,
    write: async (next, revision) => {
      assertWorkspaceWrite(envelope, revision, next);
      envelope = structuredClone(next);
    },
  });
  await persistence.hydrate();
  if (invalidPeer)
    store.getState().documents.right.presets[0].channels[2].fir.hfdState!.tapCount = 1;
  const edit = vi.fn(
    (roles: Slot[], change: (project: Project) => void, options?: { synchronizeLinks?: boolean }) =>
      store.getState().editAt(roles, change, options),
  );
  const connections = vi.fn(() => ({})),
    operate = vi.fn(async (_label: string, action: () => Promise<unknown>) => action());
  const executor = createToolExecutor({
    state: store.getState,
    edit,
    connections,
    operate,
    undo: () => store.getState().undo(),
    redo: () => store.getState().redo(),
    message: vi.fn(),
  } as unknown as ToolAdapter);
  return { store, persistence, executor, edit, connections, operate };
}

it('native Clear through the shared tool clears linked follower independently on both roles and exact whole-document Undo/Redo is one entry', async () => {
  const f = await fixture(),
    before = structuredClone(f.store.getState().documents);
  expect(
    await f.executor('fusion_fir_set', {
      target: 'both',
      preset: 1,
      native: { kind: 'clear', output: 2 },
    }),
  ).toMatchObject({ ok: true });
  expect(f.edit).toHaveBeenCalledWith(['left', 'right'], expect.any(Function), {
    synchronizeLinks: false,
  });
  const after = structuredClone(f.store.getState().documents);
  for (const role of ['left', 'right'] as const) {
    const p = after[role].presets[0];
    expect(p.inputFir.hfdState!.loaded).toBe(false);
    expect(p.channels[1].fir.hfdState!.loaded).toBe(false);
    expect(p.channels[0].fir).toEqual(before[role].presets[0].channels[0].fir);
    expect(p.channels[2].fir).toEqual(before[role].presets[0].channels[2].fir);
    expect(p.channels[1].linkedTo).toBe(0);
    expect(p.channels[1].fir.enabled).toBe(before[role].presets[0].channels[1].fir.enabled);
  }
  expect(f.store.getState().past).toHaveLength(1);
  expect(await f.executor('fusion_history', { action: 'undo' })).toMatchObject({ ok: true });
  expect(f.store.getState().documents).toEqual(before);
  await f.executor('fusion_history', { action: 'redo' });
  expect(f.store.getState().documents).toEqual(after);
  expect(f.operate).not.toHaveBeenCalled();
  await f.persistence.flush();
});

it('native placement and follower bypass preserve opposite latent flags without link normalization', async () => {
  const f = await fixture(),
    before = structuredClone(f.store.getState().documents.left.presets[0]);
  expect(
    await f.executor('fusion_fir_set', {
      target: 'left',
      preset: 1,
      native: { kind: 'enabled', channel: 2, enabled: false },
    }),
  ).toMatchObject({ ok: true });
  let p = f.store.getState().documents.left.presets[0];
  expect(p.channels[0].fir).toEqual(before.channels[0].fir);
  expect(p.channels[1].fir.enabled).toBe(false);
  expect(p.inputFir.enabled).toBe(true);
  expect(
    await f.executor('fusion_fir_set', {
      target: 'left',
      preset: 1,
      native: { kind: 'placement', placement: 'input' },
    }),
  ).toMatchObject({ ok: true });
  p = f.store.getState().documents.left.presets[0];
  expect(p.firPlacement).toBe('input');
  expect(p.inputFir.hfdState!.used).toBe(true);
  expect(p.channels.map((c) => c.fir.enabled)).toEqual([true, false, true]);
  expect(p.channels.every((c) => !c.fir.hfdState!.used && c.fir.hfdState!.loaded)).toBe(true);
  expect(f.store.getState().documents.right.presets[0].firPlacement).toBe('output');
  await f.persistence.flush();
});

it('rejects every legacy/native combination before calling the edit adapter', async () => {
  const f = await fixture(),
    before = structuredClone(f.store.getState().documents);
  for (const patch of [
    { channel: 0 },
    { name: 'Changed' },
    { text: '1' },
    { enabled: false },
    { clear: false },
  ]) {
    expect(
      await f.executor('fusion_fir_set', {
        target: 'both',
        preset: 1,
        native: { kind: 'clear', output: 1 },
        ...patch,
      }),
    ).toMatchObject({ ok: false });
  }
  expect(f.edit).not.toHaveBeenCalled();
  expect(f.store.getState().documents).toEqual(before);
  expect(f.store.getState().past).toHaveLength(0);
  await f.persistence.flush();
});

it('stages paired native edits atomically when the peer has malformed native cache metadata', async () => {
  const f = await fixture(true),
    before = structuredClone(f.store.getState().documents);
  expect(
    await f.executor('fusion_fir_set', {
      target: 'both',
      preset: 1,
      native: { kind: 'clear', output: 1 },
    }),
  ).toMatchObject({ ok: false });
  expect(f.store.getState().documents).toEqual(before);
  expect(f.store.getState().past).toHaveLength(0);
  expect(f.operate).not.toHaveBeenCalled();
  await f.persistence.flush();
});

function readResult(): Awaited<ReturnType<typeof firHardware.readFir>> {
  const unloaded = (): Fir => ({
    name: 'Previous EEPROM name.txt',
    enabled: false,
    taps: [],
    hfdState: { loaded: false, used: true, tapCount: 1500 },
  });
  return {
    placement: 'output',
    flags: 0x1a,
    filters: [native(1500), unloaded(), unloaded()],
    backup: {} as never,
  };
}

it('tool read preserves the inactive local cache and raw hardware enable bits without mirroring one amplifier or normalizing linked banks', async () => {
  const f = await fixture(),
    before = structuredClone(f.store.getState().documents),
    session = {} as never,
    result = readResult();
  f.connections.mockReturnValue({ left: { session } });
  const read = vi.spyOn(firHardware, 'readFir').mockResolvedValue(result);
  expect(await f.executor('fusion_fir_read', { slot: 'left', preset: 1 })).toMatchObject({
    ok: true,
  });
  expect(read).toHaveBeenCalledExactlyOnceWith(session, 1);
  expect(f.edit).toHaveBeenCalledWith(['left'], expect.any(Function), { synchronizeLinks: false });
  const p = f.store.getState().documents.left.presets[0];
  expect(p.inputFir).toEqual(before.left.presets[0].inputFir);
  expect(p.channels[0].fir).toMatchObject({
    enabled: false,
    hfdState: { loaded: true, used: true },
  });
  expect(p.channels[1].fir).toMatchObject({
    enabled: true,
    taps: [],
    hfdState: { loaded: false, used: true },
  });
  expect(p.channels[1].linkedTo).toBe(0);
  expect(f.store.getState().documents.right).toEqual(before.right);
  expect(f.store.getState().past).toHaveLength(1);
  await f.executor('fusion_history', { action: 'undo' });
  expect(f.store.getState().documents).toEqual(before);
  await f.persistence.flush();
});

it.each(['edit', 'reference', 'revision'] as const)(
  'rejects a pending read after a %s change before calling the edit adapter',
  async (change) => {
    const f = await fixture();
    f.connections.mockReturnValue({ left: { session: {} } });
    let resolve!: (result: Awaited<ReturnType<typeof firHardware.readFir>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof firHardware.readFir>>>((done) => {
      resolve = done;
    });
    const read = vi.spyOn(firHardware, 'readFir').mockReturnValue(pending);
    const task = f.executor('fusion_fir_read', { slot: 'left', preset: 1 });
    expect(read).toHaveBeenCalledOnce();
    if (change === 'edit')
      f.store.getState().editAt(['left'], (doc) => {
        doc.name = 'Intervening edit';
      });
    else if (change === 'reference')
      f.store.setState({
        documents: {
          ...f.store.getState().documents,
          left: structuredClone(f.store.getState().documents.left),
        },
      });
    else f.store.setState({ documentRevision: f.store.getState().documentRevision! + 1 });
    const current = structuredClone(f.store.getState().documents),
      historyLength = f.store.getState().past.length;
    resolve(readResult());
    expect(await task).toMatchObject({
      ok: false,
      error: expect.stringContaining('design changed while reading FIR'),
    });
    expect(f.edit).not.toHaveBeenCalled();
    expect(f.store.getState().documents).toEqual(current);
    expect(f.store.getState().past).toHaveLength(historyLength);
    await f.persistence.flush();
  },
);

it('the existing placement command aliases native Used-only selection and preserves both roles’ independent latent flags', async () => {
  const f = await fixture(),
    before = structuredClone(f.store.getState().documents);
  expect(
    await f.executor('fusion_fir_placement', { target: 'both', preset: 1, placement: 'input' }),
  ).toMatchObject({ ok: true });
  expect(f.edit).toHaveBeenCalledWith(['left', 'right'], expect.any(Function), {
    synchronizeLinks: false,
  });
  for (const role of ['left', 'right'] as const) {
    const p = f.store.getState().documents[role].presets[0];
    expect(p.inputFir).toEqual({
      ...before[role].presets[0].inputFir,
      hfdState: { ...before[role].presets[0].inputFir.hfdState!, used: true },
    });
    expect(p.channels.map((c) => c.fir.enabled)).toEqual(
      before[role].presets[0].channels.map((c) => c.fir.enabled),
    );
    expect(p.channels.every((c) => !c.fir.hfdState!.used && c.fir.hfdState!.loaded)).toBe(true);
  }
  expect(f.operate).not.toHaveBeenCalled();
  await f.executor('fusion_history', { action: 'undo' });
  expect(f.store.getState().documents).toEqual(before);
  await f.persistence.flush();
});
