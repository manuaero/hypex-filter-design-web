import { expect, it, vi } from 'vitest';
import {
  createToolExecutor,
  TOOL_DEFINITIONS,
  type ToolAdapter,
  type DocumentState,
} from '../src/application/tools';
import { newProject, newFilter, type Slot } from '../src/domain/model';
import { synchronizeLinks } from '../src/domain/links';
function fixture() {
  let state: DocumentState = {
    documents: { left: newProject('Left synthetic'), right: newProject('Right synthetic') },
    slot: 'left',
    preset: 0,
    channel: 0,
    filter: 0,
    linkedEdits: false,
    linkedControls: false,
    documentRevision: 4,
  };
  for (const slot of ['left', 'right'] as const) {
    const f = state.documents[slot].presets[0].channels[0].filters[0];
    Object.assign(f, {
      ...newFilter('peak'),
      frequency: 2300,
      frequency2: 988.101806640625,
      q: 1.15,
      gain: slot === 'left' ? 7.5 : -4,
      enabled: slot === 'right',
      coefficients: { b0: 0.9, b1: 0.02, b2: -0.01, f1: 0.1, f2: 0.05 },
      provenance: 'hfd',
    });
  }
  for (const slot of ['left', 'right'] as const) {
    const c = state.documents[slot].presets[0].channels[0];
    c.gain = slot === 'left' ? 3 : -2;
    c.additionalGain = 10;
    c.coefficientCache = slot === 'left' ? 'effective' : 'unresolved';
    Object.assign(state.documents[slot], { hfdGainLowered: true });
  }
  // Deliberately duplicate native identities across independent roles. They must
  // never be used to infer which role receives a planned relative-gain result.
  state.documents.right.presets[0].channels[0].filters[0].id =
    state.documents.left.presets[0].channels[0].filters[0].id;
  const history: (typeof state.documents)[] = [],
    forbidden = vi.fn(() => {
      throw new Error('Unexpected hardware or global operation');
    });
  const editByRole = vi.fn(
    (
      slots: Slot[],
      fn: (project: typeof state.documents.left, slot: Slot) => void,
      options?: { synchronizeLinks?: boolean },
    ) => {
      const documents = structuredClone(state.documents);
      slots.forEach((slot) => {
        fn(documents[slot], slot);
        if (options?.synchronizeLinks !== false)
          synchronizeLinks(documents[slot], state.documents[slot]);
      });
      history.push(state.documents);
      state = { ...state, documents, documentRevision: (state.documentRevision ?? 0) + 1 };
    },
  );
  const adapter: ToolAdapter = {
    state: () => state,
    edit: (slots, fn, options) => editByRole(slots, (project) => fn(project), options),
    editByRole,
    choose: (patch) => {
      state = { ...state, ...patch };
    },
    undo: () => {
      const prior = history.pop();
      if (prior) state = { ...state, documents: prior };
    },
    redo: forbidden,
    connections: forbidden,
    connect: forbidden,
    disconnect: forbidden,
    refresh: forbidden,
    operate: forbidden,
    progress: forbidden,
    message: vi.fn(),
    view: vi.fn(),
  };
  return {
    adapter,
    execute: createToolExecutor(adapter),
    state: () => state,
    history,
    editByRole,
    forbidden,
  };
}

const command = (patch: Record<string, unknown>, target: 'left' | 'right' | 'both' = 'both') => ({
  target,
  preset: 1,
  channel: 1,
  patch,
});
const channel = (f: ReturnType<typeof fixture>, slot: 'left' | 'right' = 'left', index = 0) =>
  f.state().documents[slot].presets[0].channels[index];
it('metadata commands preserve dirty follower vectors/cache instead of silently synchronizing another role', async () => {
  const f = fixture();
  channel(f, 'right').linkedTo = 1;
  const before = structuredClone(f.state().documents);
  expect(await f.execute('fusion_channel_set', command({ name: 'Local label' }))).toMatchObject({
    ok: true,
  });
  for (const slot of ['left', 'right'] as const) {
    expect(channel(f, slot).name).toBe('Local label');
    expect(channel(f, slot).filters).toEqual(before[slot].presets[0].channels[0].filters);
    expect(channel(f, slot).coefficientCache).toBe(
      before[slot].presets[0].channels[0].coefficientCache,
    );
  }
  expect(f.history).toHaveLength(1);
  f.adapter.undo();
  expect(f.state().documents).toEqual(before);
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('equal ordinary channel values retain exact imported metadata, revision and Undo history', async () => {
  const f = fixture(),
    before = structuredClone(f.state().documents),
    revision = f.state().documentRevision;
  expect(await f.execute('fusion_channel_set', command({ gain: 3 }, 'left'))).toMatchObject({
    ok: true,
    changed: false,
  });
  expect(f.state().documents).toEqual(before);
  expect(f.state().documentRevision).toBe(revision);
  expect(f.history).toHaveLength(0);
  expect(f.editByRole).not.toHaveBeenCalled();
});
it('processing edits preflight every target even for equal requested processing values', async () => {
  const f = fixture();
  channel(f, 'right').linkedTo = 1;
  channel(f, 'right').gain = 3;
  const before = structuredClone(f.state().documents);
  expect(await f.execute('fusion_channel_set', command({ gain: 3 }))).toMatchObject({ ok: false });
  expect(f.state().documents).toEqual(before);
  expect(f.editByRole).not.toHaveBeenCalled();
});
it('global analysis delay expands all three selected-preset channels without recopying dirty followers', async () => {
  const f = fixture();
  channel(f, 'right').linkedTo = 1;
  const before = structuredClone(f.state().documents);
  expect(await f.execute('fusion_channel_set', command({ globalDelayUs: 123.456 }))).toMatchObject({
    ok: true,
  });
  for (const slot of ['left', 'right'] as const) {
    expect(f.state().documents[slot].presets[0].channels.map((c) => c.globalDelayUs)).toEqual([
      123.456, 123.456, 123.456,
    ]);
    expect(f.state().documents[slot].presets[1]).toEqual(before[slot].presets[1]);
    expect(channel(f, slot).filters).toEqual(before[slot].presets[0].channels[0].filters);
  }
  expect(f.history).toHaveLength(1);
});
it('strict hardware-gain intent rejects arbitrary scalars, caller eligibility and mixed callback ordering', async () => {
  const f = fixture();
  for (const patch of [
    { additionalGain: 10 },
    { hardwareGain: true, gain: 18 },
    { hardwareGain: true, available: true },
    { hardwareGain: 'true' },
  ])
    expect(await f.execute('fusion_channel_set', command(patch))).toMatchObject({ ok: false });
  expect(f.editByRole).not.toHaveBeenCalled();
  expect(TOOL_DEFINITIONS).toHaveLength(91);
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('Off changes selected gain offsets and project hints while retaining every coefficient cache and unrelated gain', async () => {
  const f = fixture(),
    before = structuredClone(f.state().documents);
  expect(await f.execute('fusion_channel_set', command({ hardwareGain: false }))).toMatchObject({
    ok: true,
  });
  for (const slot of ['left', 'right'] as const) {
    expect(channel(f, slot).additionalGain).toBe(0);
    expect(channel(f, slot).gain).toBe(before[slot].presets[0].channels[0].gain);
    expect(f.state().documents[slot]).toMatchObject({ hfdGainLowered: false });
    expect(channel(f, slot).filters).toEqual(before[slot].presets[0].channels[0].filters);
    expect(channel(f, slot).coefficientCache).toBe(
      before[slot].presets[0].channels[0].coefficientCache,
    );
    expect(f.state().documents[slot].presets[0].channels.slice(1)).toEqual(
      before[slot].presets[0].channels.slice(1),
    );
  }
  expect(f.history).toHaveLength(1);
  f.adapter.undo();
  expect(f.state().documents).toEqual(before);
});
it('explicit On callback normalizes an already checked imported offset and clamps gain independently per role', async () => {
  const f = fixture();
  channel(f).gain = 18;
  channel(f, 'right').additionalGain = 6;
  channel(f, 'right').linkedTo = undefined;
  channel(f, 'right', 2).linkedTo = 1;
  const dirty = structuredClone(channel(f, 'right', 2));
  expect(await f.execute('fusion_channel_set', command({ hardwareGain: true }))).toMatchObject({
    ok: true,
  });
  expect(channel(f).gain).toBe(14);
  expect(channel(f, 'right').gain).toBe(-2);
  expect(channel(f, 'right').additionalGain).toBe(10);
  expect(channel(f, 'right', 2)).toEqual(dirty);
  expect(f.history).toHaveLength(1);
});
it('fresh zero-offset commands refuse eligibility, while the same trusted visible UI context can re-enable after Off', async () => {
  const fresh = fixture();
  channel(fresh).additionalGain = 0;
  expect(
    await fresh.execute('fusion_channel_set', command({ hardwareGain: true }, 'left')),
  ).toMatchObject({ ok: false });
  expect(fresh.history).toHaveLength(0);
  const f = fixture();
  Object.assign(f.adapter, {
    hardwareGainContext: () => ({ available: true, gainText: String(channel(f).gain) }),
  });
  expect(
    await f.execute('fusion_channel_set', command({ hardwareGain: false }, 'left')),
  ).toMatchObject({ ok: true });
  expect(channel(f).additionalGain).toBe(0);
  expect(
    await f.execute('fusion_channel_set', command({ hardwareGain: true }, 'left')),
  ).toMatchObject({ ok: true });
  expect(channel(f).additionalGain).toBe(10);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('unsupported clients refuse before mutation instead of inferring a role from identical native IDs', async () => {
  const f = fixture();
  delete f.adapter.editByRole;
  const before = structuredClone(f.state().documents);
  expect(await f.execute('fusion_channel_set', command({ gain: 4 }))).toMatchObject({
    ok: false,
    error: expect.stringContaining('Explicit-role'),
  });
  expect(f.state().documents).toEqual(before);
  expect(f.history).toHaveLength(0);
});
it('failed proposals never register retained views, and admitted canonical no-op intents do', async () => {
  const f = fixture(),
    retain = vi.fn();
  Object.assign(f.adapter, { retainHardwareGainContexts: retain });
  channel(f, 'right').additionalGain = 0;
  expect(await f.execute('fusion_channel_set', command({ hardwareGain: false }))).toMatchObject({
    ok: false,
  });
  expect(retain).not.toHaveBeenCalled();
  expect(f.history).toHaveLength(0);
  channel(f, 'right').additionalGain = 10;
  expect(await f.execute('fusion_channel_set', command({ hardwareGain: true }))).toMatchObject({
    ok: true,
    changed: false,
  });
  expect(retain).toHaveBeenCalledOnce();
  expect(retain.mock.calls[0][0]).toEqual([
    { slot: 'left', presetIndex: 0, channelIndex: 0, channelId: channel(f).id },
    { slot: 'right', presetIndex: 0, channelIndex: 0, channelId: channel(f, 'right').id },
  ]);
  expect(f.history).toHaveLength(0);
});
