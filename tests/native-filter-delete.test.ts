import { expect, it, vi } from 'vitest';
import { deleteBiquad, isUnusedBiquad } from '../src/domain/editing';
import { linkChannel } from '../src/domain/links';
import { newFilter, newProject, unity, type Filter } from '../src/domain/model';
import {
  createToolExecutor,
  TOOL_DEFINITIONS,
  type DocumentState,
  type ToolAdapter,
} from '../src/application/tools';

function nativeFilter(enabled = true): Filter {
  return {
    ...newFilter('lowpass2'),
    id: 'retained-browser-slot',
    sourceId: '13',
    sourceType: 'ftLowPass2',
    enabled,
    frequency: 720,
    frequency2: 988.101806640625,
    q: 0.4,
    q2: 0.7,
    gain: -3.25,
    shelfDirection: 'high',
    provenance: 'hfd',
    coefficients: { b0: 0.2, b1: 0.03, b2: 0.04, f1: 0.8, f2: -0.1 },
  };
}
function latent(filter: Filter) {
  const {
    kind: _kind,
    coefficients: _coefficients,
    sourceType: _sourceType,
    provenance: _provenance,
    ...rest
  } = filter;
  return rest;
}

it.each([true, false])('native Delete retains slot and latent state with Enabled=%s', (enabled) => {
  const project = newProject(),
    channel = project.presets[0].channels[0];
  channel.filters[0] = nativeFilter(enabled);
  channel.gain = -6;
  channel.additionalGain = 10;
  channel.invert = true;
  channel.coefficientCache = 'unresolved';
  const before = structuredClone(project),
    previous = channel.filters[0];
  deleteBiquad(project, 0, 0, 0);
  expect(latent(channel.filters[0])).toEqual(latent(previous));
  expect(channel.filters[0]).toMatchObject({
    kind: 'unity',
    coefficients: unity(),
    sourceType: 'ftUnity',
  });
  expect(channel.filters[0].provenance).toBeUndefined();
  expect(channel.coefficientCache).toBe('base');
  expect(channel.gain).toBe(-6);
  expect(channel.additionalGain).toBe(10);
  expect(channel.invert).toBe(true);
  expect(channel.filters.slice(1)).toEqual(before.presets[0].channels[0].filters.slice(1));
  expect(project.presets[0].channels.slice(1)).toEqual(before.presets[0].channels.slice(1));
  expect(project.presets.slice(1)).toEqual(before.presets.slice(1));
  expect(isUnusedBiquad(channel.filters[0])).toBe(true);
  expect(JSON.parse(JSON.stringify(channel.filters[0]))).toMatchObject(latent(previous));
});

it('deleting a later slot keeps an unrelated unresolved first cache and rejects invalid/linked targets atomically', () => {
  const project = newProject(),
    channel = project.presets[0].channels[0];
  channel.coefficientCache = 'unresolved';
  channel.filters[2] = nativeFilter();
  deleteBiquad(project, 0, 0, 2);
  expect(channel.coefficientCache).toBe('unresolved');
  const before = structuredClone(project);
  expect(() => deleteBiquad(project, 0, 0, 15)).toThrow('biquad');
  expect(project).toEqual(before);
  linkChannel(project.presets[0], 1, 0);
  const linked = structuredClone(project);
  expect(() => deleteBiquad(project, 0, 1, 0)).toThrow('read-only');
  expect(project).toEqual(linked);
});

it('shares native Delete with linked followers while preserving their graph identities and local compensation', () => {
  const project = newProject(),
    preset = project.presets[0];
  preset.channels[0].filters[0] = nativeFilter();
  preset.channels[1].filters[0].sourceId = '72';
  preset.channels[1].additionalGain = 10;
  const followerId = preset.channels[1].filters[0].id;
  linkChannel(preset, 1, 0);
  deleteBiquad(project, 0, 0, 0);
  expect(preset.channels[1].filters[0]).toMatchObject({
    id: followerId,
    sourceId: '72',
    kind: 'unity',
    enabled: true,
    frequency: 720,
    q: 0.4,
    coefficients: unity(),
  });
  expect(preset.channels[1].additionalGain).toBe(10);
  expect(isUnusedBiquad({ kind: 'unity' })).toBe(true);
  expect(isUnusedBiquad({ kind: 'lowpass2' })).toBe(false);
});

function toolFixture() {
  let value: DocumentState = {
    documents: { left: newProject('Left'), right: newProject('Right') },
    slot: 'right',
    preset: 2,
    channel: 2,
    filter: 4,
    linkedEdits: false,
    linkedControls: false,
  };
  for (const role of ['left', 'right'] as const) {
    const filters = value.documents[role].presets[0].channels[0].filters;
    filters.forEach((_, i) => {
      filters[i] = { ...newFilter('peak'), enabled: false, frequency: 100 + i };
    });
    filters[0] = nativeFilter();
    filters[0].id = role + '-slot';
  }
  const history: DocumentState['documents'][] = [];
  const hardware = {
    connections: vi.fn(() => ({})),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    progress: vi.fn(),
    operate: vi.fn(),
  };
  const adapter: ToolAdapter = {
    state: () => value,
    edit: (roles, action) => {
      const documents = structuredClone(value.documents);
      for (const role of roles) action(documents[role]);
      history.push(value.documents);
      value = { ...value, documents };
    },
    choose: (patch) => {
      value = { ...value, ...patch };
    },
    undo: () => {
      const previous = history.pop();
      if (previous) value = { ...value, documents: previous };
    },
    redo: () => {},
    connections: hardware.connections,
    connect: hardware.connect,
    disconnect: hardware.disconnect,
    refresh: hardware.refresh,
    progress: hardware.progress,
    operate: async (_label, action) => {
      hardware.operate();
      return action();
    },
    message: () => {},
    view: () => {},
  };
  return { execute: createToolExecutor(adapter), state: () => value, hardware };
}

it('MCP Delete preserves each role own parameters and Undo, then Add reuses enabled Unity with the same slot identity', async () => {
  const { execute, state, hardware } = toolFixture(),
    before = structuredClone(state());
  state().documents.right.presets[0].channels[0].filters[0].frequency = 930;
  const ownBefore = structuredClone(state());
  expect(
    await execute('fusion_filter_delete', { target: 'both', preset: 1, channel: 1, index: 1 }),
  ).toMatchObject({ ok: true });
  expect(state().documents.left.presets[0].channels[0].filters[0]).toMatchObject({
    kind: 'unity',
    id: 'left-slot',
    enabled: true,
    frequency: 720,
  });
  expect(state().documents.right.presets[0].channels[0].filters[0]).toMatchObject({
    kind: 'unity',
    id: 'right-slot',
    enabled: true,
    frequency: 930,
  });
  expect([state().slot, state().preset, state().channel, state().filter]).toEqual([
    before.slot,
    before.preset,
    before.channel,
    before.filter,
  ]);
  await execute('fusion_history', { action: 'undo' });
  expect(state().documents).toEqual(ownBefore.documents);
  await execute('fusion_filter_delete', { target: 'left', preset: 1, channel: 1, index: 1 });
  const right = structuredClone(state().documents.right);
  expect(
    await execute('fusion_filter_add', { target: 'left', preset: 1, channel: 1, frequency: 1500 }),
  ).toMatchObject({ ok: true });
  expect(state().documents.left.presets[0].channels[0].filters[0]).toMatchObject({
    kind: 'peak',
    id: 'left-slot',
    sourceId: '13',
    frequency: 1500,
  });
  expect(state().documents.right).toEqual(right);
  for (const spy of Object.values(hardware)) expect(spy).not.toHaveBeenCalled();
});

it('Delete validates strict public inputs/linked destinations while explicit broader Reset remains distinct', async () => {
  const { execute, state, hardware } = toolFixture();
  const definition = TOOL_DEFINITIONS.find((t) => t.name === 'fusion_filter_delete')!;
  expect(definition.inputSchema.additionalProperties).toBe(false);
  expect(definition.annotations.readOnlyHint).toBe(false);
  const before = structuredClone(state().documents);
  for (const patch of [{ index: 0 }, { owner: 'spoof' }, { enabled: false }]) {
    expect(
      await execute('fusion_filter_delete', {
        target: 'left',
        preset: 1,
        channel: 1,
        index: 1,
        ...patch,
      }),
    ).toMatchObject({ ok: false });
    expect(state().documents).toEqual(before);
  }
  state().documents.right.presets[0].channels[0].linkedTo = 1;
  const linked = structuredClone(state().documents);
  expect(
    await execute('fusion_filter_delete', { target: 'both', preset: 1, channel: 1, index: 1 }),
  ).toMatchObject({ ok: false });
  expect(state().documents).toEqual(linked);
  await execute('fusion_filter_reset', { target: 'left', preset: 1, channel: 1, index: 1 });
  expect(state().documents.left.presets[0].channels[0].filters[0]).toMatchObject({
    kind: 'unity',
    enabled: false,
    frequency: 1000,
    q: Math.SQRT1_2,
    gain: 0,
    sourceId: '13',
  });
  for (const spy of Object.values(hardware)) expect(spy).not.toHaveBeenCalled();
});

it('MCP Add can reuse an imported enabled Unity first slot and replaces only its obsolete cache classification', async () => {
  const { execute, state } = toolFixture(),
    channel = state().documents.left.presets[0].channels[0];
  channel.filters[0].kind = 'unity';
  channel.filters[0].coefficients = unity();
  channel.coefficientCache = 'unresolved';
  const right = structuredClone(state().documents.right);
  expect(
    await execute('fusion_filter_add', { target: 'left', preset: 1, channel: 1, frequency: 1500 }),
  ).toMatchObject({ ok: true });
  expect(state().documents.left.presets[0].channels[0].coefficientCache).toBe('base');
  expect(state().documents.left.presets[0].channels[0].filters[0]).toMatchObject({
    id: 'left-slot',
    sourceId: '13',
    kind: 'peak',
    frequency: 1500,
  });
  expect(state().documents.right).toEqual(right);
});
