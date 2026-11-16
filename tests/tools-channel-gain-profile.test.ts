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

it('native qualified maximum24 is admitted by channel-set rather than rejected at the old18dB schema', async () => {
  const f = fixture();
  for (const slot of ['left', 'right'] as const)
    f.state().documents[slot].presets[0].channels[0].additionalGain = 0;
  expect(
    await f.execute('fusion_channel_set', {
      target: 'both',
      preset: 1,
      channel: 1,
      patch: { gain: 24 },
    }),
  ).toMatchObject({ ok: true });
  expect(f.state().documents.left.presets[0].channels[0].gain).toBe(24);
  expect(f.state().documents.right.presets[0].channels[0].gain).toBe(24);
  expect(f.history).toHaveLength(1);
  expect(f.forbidden).not.toHaveBeenCalled();
});
const command = (f: ReturnType<typeof fixture>, patch: Record<string, unknown>, target = 'both') =>
  f.execute('fusion_channel_set', { target, preset: 1, channel: 1, patch });
it('original raw half text publishes independent per-role capped Double values and returns exact Text', async () => {
  const f = fixture();
  f.state().documents.right.presets[0].channels[0].additionalGain = 0;
  const before = structuredClone(f.state().documents);
  expect(await command(f, { gain: '18.005' })).toEqual({
    ok: true,
    changed: true,
    roles: [
      { slot: 'left', changed: true, gain: { text: '14.00', value: 14 } },
      { slot: 'right', changed: true, gain: { text: '18.01', value: 18.01 } },
    ],
  });
  expect(f.history).toHaveLength(1);
  expect(f.forbidden).not.toHaveBeenCalled();
  for (const slot of ['left', 'right'] as const)
    expect(f.state().documents[slot].presets[0].channels[0].filters).toEqual(
      before[slot].presets[0].channels[0].filters,
    );
  f.adapter.undo();
  expect(f.state().documents).toEqual(before);
});
it('each-default wheel performs one independent sign-only event and exposes no opaque state', async () => {
  const f = fixture();
  const response = await command(f, { gainWheel: { direction: 'up' } });
  expect(response).toEqual({
    ok: true,
    changed: true,
    roles: [
      { slot: 'left', changed: true, gain: { text: '3.10', value: 3.1, changed: true } },
      { slot: 'right', changed: true, gain: { text: '-1.90', value: -1.9, changed: true } },
    ],
  });
  expect(JSON.stringify(response)).not.toContain('state');
  expect(f.history).toHaveLength(1);
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('fixed source wheel mirrors its changed canonical value through the destination own cap', async () => {
  const f = fixture(),
    left = f.state().documents.left.presets[0].channels[0],
    right = f.state().documents.right.presets[0].channels[0];
  left.gain = 17.9;
  left.additionalGain = 0;
  const reply = await command(f, { gainWheel: { direction: 'up', basis: 'left' } });
  expect(reply).toMatchObject({
    ok: true,
    roles: [
      { slot: 'left', gain: { text: '18.00', value: 18 } },
      { slot: 'right', gain: { text: '14.00', value: 14 } },
    ],
  });
  expect(f.state().documents.left.presets[0].channels[0].gain).toBe(18);
  expect(f.state().documents.right.presets[0].channels[0].gain).toBe(14);
  expect(right.additionalGain).toBe(10);
});
it('fixed source canonical no-op skips mirror and history but still preflights linked peers', async () => {
  const f = fixture();
  f.state().documents.left.presets[0].channels[0].gain = 14;
  const before = structuredClone(f.state().documents);
  expect(await command(f, { gainWheel: { direction: 'up', basis: 'left' } })).toMatchObject({
    ok: true,
    changed: false,
  });
  expect(f.state().documents).toEqual(before);
  expect(f.editByRole).not.toHaveBeenCalled();
  f.state().documents.right.presets[0].channels[0].linkedTo = 1;
  expect(await command(f, { gainWheel: { direction: 'up', basis: 'left' } })).toMatchObject({
    ok: false,
  });
  expect(f.editByRole).not.toHaveBeenCalled();
});
it.each([
  { gain: 'NaN' },
  { gain: 'Infinity' },
  { gain: '' },
  { gainWheel: { direction: 'up' }, muted: true },
  { gainWheel: { direction: 'up', step: 2 } },
  { gainWheel: { direction: 'up', state: {} } },
  { gainWheel: { direction: 'up', basis: 'right' } },
])('invalid or cross-role request %j refuses without mutation', async (patch) => {
  const f = fixture(),
    before = structuredClone(f.state().documents);
  expect(await command(f, patch, 'left')).toMatchObject({ ok: false });
  expect(f.state().documents).toEqual(before);
  expect(f.history).toHaveLength(0);
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('single target explicitly each and matching basis are admitted; source operations are fresh stateless fields', async () => {
  const f = fixture();
  expect(await command(f, { gainWheel: { direction: 'up', basis: 'each' } }, 'left')).toMatchObject(
    { ok: true },
  );
  expect(await command(f, { gainWheel: { direction: 'up', basis: 'left' } }, 'left')).toMatchObject(
    { ok: true },
  );
  expect(f.state().documents.left.presets[0].channels[0].gain).toBe(3.2);
});
it('canonical raw no-op returns final Text while retaining whole projects and history', async () => {
  const f = fixture();
  f.state().documents.right.presets[0].channels[0].gain = 3;
  const before = structuredClone(f.state().documents);
  expect(await command(f, { gain: '3.000' })).toEqual({
    ok: true,
    changed: false,
    roles: [
      { slot: 'left', changed: false, gain: { text: '3.00', value: 3 } },
      { slot: 'right', changed: false, gain: { text: '3.00', value: 3 } },
    ],
  });
  expect(f.state().documents).toEqual(before);
  expect(f.history).toHaveLength(0);
});
it('channel gain expands within the existing91-tool registry and strict sole intent schema', () => {
  expect(TOOL_DEFINITIONS).toHaveLength(91);
  const tool = TOOL_DEFINITIONS.find((x) => x.name === 'fusion_channel_set')!;
  expect(JSON.stringify(tool)).toContain('gainWheel');
  expect(JSON.stringify(tool)).toContain('basis');
});
it('fresh stateless commands repeat the source-predicted Text-only guard without inventing continuous human state', async () => {
  const f = fixture();
  f.state().documents.left.presets[0].channels[0].gain = 24;
  const before = structuredClone(f.state().documents);
  for (let event = 0; event < 2; event++)
    expect(await command(f, { gainWheel: { direction: 'up', basis: 'left' } })).toMatchObject({
      ok: true,
      changed: false,
      roles: [
        { slot: 'left', gain: { text: '14.00', value: 24, changed: false } },
        { slot: 'right', gain: { value: -2, changed: false } },
      ],
    });
  expect(f.state().documents).toEqual(before);
  expect(f.history).toHaveLength(0);
  expect(f.editByRole).not.toHaveBeenCalled();
});
