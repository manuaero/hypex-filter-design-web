import { expect, it, vi } from 'vitest';
import {
  createToolExecutor,
  TOOL_DEFINITIONS,
  type ToolAdapter,
  type DocumentState,
} from '../src/application/tools';
import { newFilter, newProject, type Slot } from '../src/domain/model';

type DelayContext = NonNullable<ReturnType<NonNullable<ToolAdapter['delayContext']>>>;
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
  const contexts: Record<Slot, DelayContext> = {
    left: { runtime: { kind: 'offline' }, globalText: '17.123456789' },
    right: {
      runtime: { kind: 'connected', core: '5.1', sessionKey: 'right-current-session' },
      globalText: '29.75',
    },
  };
  for (const slot of ['left', 'right'] as const) {
    state.documents[slot].presets[0].channels.forEach((channel, index) => {
      channel.gain = slot === 'left' ? 3 : -2;
      channel.delayUs = 0;
      channel.globalDelayUs = [17, 29, 43][index];
      channel.hfdDelay = {
        localMaximum: 19,
        globalMaximum: index === 0 ? 74666.6666666667 : 1000 + index,
      };
      channel.filters[0] = {
        ...newFilter('peak'),
        frequency: 2300,
        q: 1.15,
        gain: 7.5,
        coefficients: { b0: 0.9, b1: 0.02, b2: -0.01, f1: 0.1, f2: 0.05 },
        provenance: slot === 'left' ? 'hfd' : 'panel',
      };
      channel.coefficientCache = slot === 'left' ? 'effective' : 'unresolved';
    });
  }
  const history: (typeof state.documents)[] = [],
    forbidden = vi.fn(() => {
      throw new Error('Unexpected hardware/global action');
    });
  const editByRole = vi.fn(
    (slots: Slot[], fn: (p: typeof state.documents.left, slot: Slot) => void) => {
      const documents = structuredClone(state.documents);
      slots.forEach((slot) => fn(documents[slot], slot));
      history.push(state.documents);
      state = { ...state, documents, documentRevision: (state.documentRevision ?? 0) + 1 };
    },
  );
  const delayContext = vi.fn(({ slot }: { slot: Slot }) => contexts[slot]);
  const adapter: ToolAdapter = {
    state: () => state,
    edit: (slots, fn) => editByRole(slots, (p) => fn(p)),
    editByRole,
    delayContext,
    choose: (patch) => {
      state = { ...state, ...patch };
    },
    undo: () => {
      const documents = history.pop();
      if (documents) state = { ...state, documents };
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
    state: () => state,
    execute: createToolExecutor(adapter),
    adapter,
    history,
    editByRole,
    forbidden,
    contexts,
    delayContext,
  };
}
const command = (f: ReturnType<typeof fixture>, patch: Record<string, unknown>, target = 'both') =>
  f.execute('fusion_channel_set', { target, preset: 1, channel: 1, patch });
const local = (f: ReturnType<typeof fixture>, slot: Slot = 'left', index = 0) =>
  f.state().documents[slot].presets[0].channels[index];

it('original local Text uses each role runtime maximum and direct current Global Text with one Undo', async () => {
  const f = fixture(),
    before = structuredClone(f.state().documents);
  const reply = await command(f, { delayUs: '16' });
  expect(reply).toMatchObject({
    ok: true,
    changed: true,
    roles: [
      { slot: 'left', delay: { text: '21', value: 21, maximumValue: 19200 } },
      { slot: 'right', delay: { text: '21', value: 21, maximumValue: 32000 } },
    ],
  });
  for (const slot of ['left', 'right'] as const) {
    expect(local(f, slot).delayUs).toBe(21);
    expect(local(f, slot).hfdDelay?.localMaximum).toBe(slot === 'left' ? 19200 : 32000);
    expect(f.state().documents[slot].presets[0].channels.map((c) => c.globalDelayUs)).toEqual(
      Array(3).fill(slot === 'left' ? 17.123456789 : 29.75),
    );
    expect(local(f, slot).filters).toEqual(before[slot].presets[0].channels[0].filters);
    expect(local(f, slot).coefficientCache).toBe(
      before[slot].presets[0].channels[0].coefficientCache,
    );
    expect(f.state().documents[slot].presets.slice(1)).toEqual(before[slot].presets.slice(1));
  }
  expect(f.history).toHaveLength(1);
  expect(f.editByRole).toHaveBeenCalledTimes(1);
  expect(f.forbidden).not.toHaveBeenCalled();
  f.adapter.undo();
  expect(f.state().documents).toEqual(before);
});
it('same raw0 callback publishes Max19 to19200 without requiring a changed local Delay', async () => {
  const f = fixture();
  f.contexts.left.globalText = '17';
  f.state().documents.left.presets[0].channels.forEach((c) => {
    c.globalDelayUs = 17;
  });
  const before = structuredClone(f.state().documents);
  expect(await command(f, { delayUs: '0' }, 'left')).toMatchObject({
    ok: true,
    changed: true,
    roles: [{ slot: 'left', delay: { value: 0, text: '0', maximumValue: 19200 } }],
  });
  expect(local(f).delayUs).toBe(0);
  expect(local(f).hfdDelay?.localMaximum).toBe(19200);
  expect(f.state().documents.right).toEqual(before.right);
  expect(f.history).toHaveLength(1);
  f.adapter.undo();
  expect(f.state().documents).toEqual(before);
});
it('the original raw request reaches each local runtime cap instead of flattening the source result', async () => {
  const f = fixture();
  expect(await command(f, { delayUs: '20000' })).toMatchObject({
    ok: true,
    roles: [
      { slot: 'left', delay: { value: 19200, maximumValue: 19200 } },
      { slot: 'right', delay: { value: 20000, maximumValue: 32000 } },
    ],
  });
  expect(local(f).delayUs).toBe(19200);
  expect(local(f, 'right').delayUs).toBe(20000);
});
it('the same raw Global request uses each role saved maximum before independent fanout', async () => {
  const f = fixture();
  local(f, 'right').hfdDelay!.globalMaximum = 1000;
  expect(await command(f, { globalDelayUs: '100000' })).toMatchObject({
    ok: true,
    roles: [
      { slot: 'left', delay: { value: 74667, maximumValue: 74666.6666666667 } },
      { slot: 'right', delay: { value: 1000, maximumValue: 1000 } },
    ],
  });
  expect(f.state().documents.left.presets[0].channels.map((c) => c.globalDelayUs)).toEqual([
    74667, 74667, 74667,
  ]);
  expect(f.state().documents.right.presets[0].channels.map((c) => c.globalDelayUs)).toEqual([
    1000, 1000, 1000,
  ]);
});
it('a local callback immediately copies the linked follower Gain flags and MaxDelay without a Graph command', async () => {
  const f = fixture(),
    source = local(f),
    target = local(f, 'left', 1);
  source.gain = 0;
  source.invert = false;
  source.muted = false;
  source.coefficientCache = 'unresolved';
  target.linkedTo = 0;
  target.gain = 24;
  target.invert = true;
  target.muted = true;
  target.delayUs = 1;
  target.additionalGain = 6;
  const before = structuredClone(f.state().documents);
  expect(await command(f, { delayUs: '16' }, 'left')).toMatchObject({ ok: true });
  expect(local(f, 'left', 1)).toMatchObject({
    gain: 0,
    invert: false,
    muted: false,
    delayUs: 21,
    additionalGain: 6,
    hfdDelay: { localMaximum: 19200 },
  });
  expect(f.state().documents.right).toEqual(before.right);
  expect(f.state().documents.left.presets.slice(1)).toEqual(before.left.presets.slice(1));
  expect(f.adapter.view).not.toHaveBeenCalled();
  expect(f.history).toHaveLength(1);
  f.adapter.undo();
  expect(f.state().documents).toEqual(before);
});
it.each([
  ['16', 21],
  ['100000', 74667],
] as const)(
  'global raw%s fans out canonical%d while preserving every local/global maximum',
  async (raw, expected) => {
    const f = fixture(),
      before = structuredClone(f.state().documents);
    expect(await command(f, { globalDelayUs: raw }, 'left')).toMatchObject({
      ok: true,
      roles: [
        {
          slot: 'left',
          delay: { value: expected, text: String(expected), maximumValue: 74666.6666666667 },
        },
      ],
    });
    expect(f.state().documents.left.presets[0].channels.map((c) => c.globalDelayUs)).toEqual([
      expected,
      expected,
      expected,
    ]);
    f.state().documents.left.presets[0].channels.forEach((c, i) => {
      expect(c.hfdDelay).toEqual(before.left.presets[0].channels[i].hfdDelay);
      expect(c.filters).toEqual(before.left.presets[0].channels[i].filters);
    });
    expect(f.state().documents.left.presets.slice(1)).toEqual(before.left.presets.slice(1));
    expect(f.state().documents.right).toEqual(before.right);
    expect(f.history).toHaveLength(1);
  },
);
it('each-default wheels are independent fresh signed events and return notification separately from change', async () => {
  const f = fixture();
  local(f, 'right').delayUs = 21;
  expect(await command(f, { delayWheel: { parameter: 'local', direction: 'up' } })).toMatchObject({
    ok: true,
    roles: [
      {
        slot: 'left',
        delay: { text: '11', value: 11, changed: true, notified: true, maximumValue: 19200 },
      },
      {
        slot: 'right',
        delay: { text: '32', value: 32, changed: true, notified: true, maximumValue: 32000 },
      },
    ],
  });
  const response = await command(f, { delayWheel: { parameter: 'local', direction: 'down' } });
  expect(response).toMatchObject({ ok: true });
  expect(local(f).delayUs).toBe(0);
  expect(local(f, 'right').delayUs).toBe(21);
  expect(JSON.stringify(response)).not.toContain('state');
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('a fixed source wheel with no notification keeps both projects and history exact', async () => {
  const f = fixture();
  local(f).delayUs = 19200.000001;
  const before = structuredClone(f.state().documents);
  expect(
    await command(f, { delayWheel: { parameter: 'local', direction: 'up', basis: 'left' } }),
  ).toMatchObject({
    ok: true,
    changed: false,
    roles: [
      { slot: 'left', delay: { value: 19200.000001, changed: false, notified: false } },
      { slot: 'right', changed: false },
    ],
  });
  expect(f.state().documents).toEqual(before);
  expect(f.history).toHaveLength(0);
  expect(f.editByRole).not.toHaveBeenCalled();
});
it('a missing legacy native global maximum refuses all roles before publishing the valid peer', async () => {
  const f = fixture();
  f.state().documents.right.sourceXml = '<project/>';
  delete local(f, 'right').hfdDelay!.globalMaximum;
  const before = structuredClone(f.state().documents);
  expect(await command(f, { delayUs: '16' })).toMatchObject({ ok: false });
  expect(f.state().documents).toEqual(before);
  expect(f.editByRole).not.toHaveBeenCalled();
});
it('invalid trusted Global Text refuses atomically instead of silently falling back to passive display', async () => {
  const f = fixture();
  f.contexts.right.globalText = '-';
  const before = structuredClone(f.state().documents);
  expect(await command(f, { delayUs: '16' })).toMatchObject({ ok: false });
  expect(f.state().documents).toEqual(before);
  expect(f.editByRole).not.toHaveBeenCalled();
});
it('an invalid current-session runtime refuses Both before publishing the offline peer', async () => {
  const f = fixture();
  f.contexts.right.runtime = { kind: 'connected', core: '5.1', sessionKey: '' };
  const before = structuredClone(f.state().documents);
  expect(await command(f, { delayUs: '16' })).toMatchObject({ ok: false });
  expect(f.state().documents).toEqual(before);
  expect(f.editByRole).not.toHaveBeenCalled();
});
it('a linked peer refuses even a bound source no-op before any mutation', async () => {
  const f = fixture();
  local(f).delayUs = 19200;
  local(f, 'right').linkedTo = 1;
  const before = structuredClone(f.state().documents);
  expect(
    await command(f, { delayWheel: { parameter: 'local', direction: 'up', basis: 'left' } }),
  ).toMatchObject({ ok: false });
  expect(f.state().documents).toEqual(before);
  expect(f.editByRole).not.toHaveBeenCalled();
});
it.each([
  { delayUs: 'NaN' },
  { delayUs: '' },
  { delayUs: '1e401' },
  { delayUs: '16', muted: true },
  { delayUs: '16', globalDelayUs: '16' },
  { delayWheel: { parameter: 'local', direction: 'up', step: 2 } },
  { delayWheel: { parameter: 'local', direction: 'up', state: {} } },
  { delayWheel: { parameter: 'local', direction: 'up', basis: 'right' } },
  { delayWheel: { parameter: 'local', direction: 'up', maximumText: '32000' } },
  {
    delayUs: '16',
    delayContext: { runtime: { kind: 'connected', core: '5.1', sessionKey: 'forged' } },
  },
])('refuses forged or mixed delay intent %j before publishing', async (patch) => {
  const f = fixture(),
    before = structuredClone(f.state().documents);
  expect(await command(f, patch, 'left')).toMatchObject({ ok: false });
  expect(f.state().documents).toEqual(before);
  expect(f.history).toHaveLength(0);
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('delay intents extend the existing91-tool schema without serializing trusted context', () => {
  expect(TOOL_DEFINITIONS).toHaveLength(91);
  const tool = TOOL_DEFINITIONS.find((t) => t.name === 'fusion_channel_set')!;
  expect(JSON.stringify(tool)).toContain('delayWheel');
  expect(JSON.stringify(tool)).not.toContain('sessionKey');
});
