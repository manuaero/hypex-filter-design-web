import { expect, it, vi } from 'vitest';
import { createToolExecutor, TOOL_DEFINITIONS, type ToolAdapter } from '../src/application/tools';
import type {
  AmplifierDiscoveryController,
  AmplifierDiscoverySnapshot,
} from '../src/application/amplifier-discovery';
import { newProject } from '../src/domain/model';
import type { ToolExecutionContext } from '../src/application/execution-context';

const actor = {
  owner: 'workspace:11111111-1111-4111-8111-111111111111',
  scope: 'paired:local:synthetic',
};
function fixture() {
  const documents = {
      left: newProject('Left local design'),
      right: newProject('Right local design'),
    },
    snapshot: AmplifierDiscoverySnapshot = {
      revision: 7,
      supported: true,
      phase: 'ready',
      autoReconnect: true,
      roles: {},
      devices: [],
    },
    controller: AmplifierDiscoveryController = {
      getSnapshot: vi.fn(() => snapshot),
      subscribe: vi.fn(() => () => {}),
      start: vi.fn(async () => {}),
      dispose: vi.fn(),
      discover: vi.fn(async () => {}),
      acceptGranted: vi.fn(async () => {}),
      assign: vi.fn(async () => {}),
      swap: vi.fn(),
      disconnect: vi.fn(async () => {}),
      noteManualDisconnect: vi.fn(),
      setAutoReconnect: vi.fn(),
      refreshBindings: vi.fn(),
    },
    forbidden = vi.fn(() => {
      throw new Error('Discovery commands must use the shared controller');
    }),
    readResult = { serial: 'SYNTHETIC-RIGHT', presets: [1, 2, 3], backups: 6 },
    readAmplifierProject = vi.fn(async () => readResult),
    adapter: ToolAdapter = {
      state: () => ({
        documents,
        slot: 'left',
        preset: 0,
        channel: 0,
        filter: 0,
        linkedEdits: true,
        linkedControls: true,
        documentRevision: 4,
      }),
      edit: forbidden,
      choose: forbidden,
      undo: forbidden,
      redo: forbidden,
      connections: forbidden,
      connect: forbidden,
      disconnect: forbidden,
      refresh: forbidden,
      operate: forbidden,
      message: vi.fn(),
      progress: forbidden,
      view: forbidden,
      amplifiers: controller,
      readAmplifierProject,
    };
  return {
    documents,
    controller,
    snapshot,
    forbidden,
    adapter,
    readResult,
    readAmplifierProject,
    execute: createToolExecutor(adapter),
  };
}

it('declares the complete discovery schema without falsely annotating workspace replacement as read-only', () => {
  expect(TOOL_DEFINITIONS).toHaveLength(92);
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === 'fusion_devices')!;
  expect(definition.annotations.readOnlyHint).toBe(false);
  expect(definition.description).toContain(
    'never write routing, bridge, mute, volume, power or filters',
  );
  expect(definition.description).toContain('does not prove physical speaker location');
  const options = (definition.inputSchema as any).oneOf;
  expect(options.map((option: any) => option.properties.action.const)).toEqual([
    'status',
    'discover',
    'assign',
    'swap',
    'disconnect',
    'auto-connect',
    'read',
  ]);
});

it('rejects unsupported operations, chooser/packet/principal injection and implicit roles before service dispatch', async () => {
  const f = fixture();
  for (const input of [
    {},
    { action: 'add' },
    { action: 'discover', chooser: true },
    { action: 'status', owner: actor.owner },
    { action: 'status', principal: actor },
    { action: 'assign', slot: 'left', expectedRevision: 7 },
    { action: 'assign', id: '', slot: 'left', expectedRevision: 7 },
    { action: 'assign', id: 'device-one', slot: 'both', expectedRevision: 7 },
    { action: 'assign', id: 'device-one', slot: 'left' },
    {
      action: 'assign',
      id: 'device-one',
      slot: 'right',
      expectedRevision: 7,
      serial: 'CALLER-SERIAL',
    },
    { action: 'swap' },
    { action: 'swap', expectedRevision: -1 },
    { action: 'disconnect', slot: 'right', expectedRevision: 1.5 },
    { action: 'auto-connect', enabled: 'true', expectedRevision: 7 },
    { action: 'auto-connect', enabled: true },
    { action: 'read' },
    { action: 'read', slot: 'both' },
    { action: 'read', slot: 'right', expectedRevision: 7 },
    { action: 'read', slot: 'right', bridge: true },
    { action: 'read', slot: 'right', packetHex: '0500' },
  ])
    expect(await f.execute('fusion_devices', input, actor)).toMatchObject({ ok: false });
  expect(f.controller.getSnapshot).not.toHaveBeenCalled();
  expect(f.controller.discover).not.toHaveBeenCalled();
  expect(f.controller.assign).not.toHaveBeenCalled();
  expect(f.controller.swap).not.toHaveBeenCalled();
  expect(f.controller.disconnect).not.toHaveBeenCalled();
  expect(f.controller.setAutoReconnect).not.toHaveBeenCalled();
  expect(f.readAmplifierProject).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('requires a trusted context even for cached discovery status and the read port', async () => {
  const f = fixture();
  for (const input of [
    { action: 'status' },
    { action: 'discover' },
    { action: 'read', slot: 'right' },
  ])
    expect(await f.execute('fusion_devices', input)).toMatchObject({
      ok: false,
      error: expect.stringContaining('trusted'),
    });
  expect(f.controller.getSnapshot).not.toHaveBeenCalled();
  expect(f.controller.discover).not.toHaveBeenCalled();
  expect(f.readAmplifierProject).not.toHaveBeenCalled();
});

it('rejects malformed trusted envelopes before discovery or reading', async () => {
  const f = fixture();
  for (const context of [
    { owner: '', scope: actor.scope },
    { owner: actor.owner, scope: '' },
    { owner: actor.owner, scope: undefined },
    { owner: actor.owner + '\n', scope: actor.scope },
  ]) {
    expect(
      await f.execute('fusion_devices', { action: 'discover' }, context as ToolExecutionContext),
    ).toMatchObject({ ok: false });
    expect(
      await f.execute(
        'fusion_devices',
        { action: 'read', slot: 'right' },
        context as ToolExecutionContext,
      ),
    ).toMatchObject({ ok: false });
  }
  expect(f.controller.discover).not.toHaveBeenCalled();
  expect(f.readAmplifierProject).not.toHaveBeenCalled();
});

it('forwards cached status and explicit discovery to the controller without invoking chooser or design/hardware operations', async () => {
  const f = fixture(),
    before = structuredClone(f.documents);
  expect(await f.execute('fusion_devices', { action: 'status' }, actor)).toEqual({
    ok: true,
    devices: f.snapshot,
  });
  expect(f.controller.discover).not.toHaveBeenCalled();
  expect(await f.execute('fusion_devices', { action: 'discover' }, actor)).toEqual({
    ok: true,
    devices: f.snapshot,
  });
  expect(f.controller.discover).toHaveBeenCalledTimes(1);
  expect(f.controller.start).not.toHaveBeenCalled();
  expect(f.controller.acceptGranted).not.toHaveBeenCalled();
  expect(f.readAmplifierProject).not.toHaveBeenCalled();
  expect(f.documents).toEqual(before);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('forwards fixed role assignment, swap, disconnect and local reconnect preference with the exact current discovery revision', async () => {
  const f = fixture(),
    before = structuredClone(f.documents);
  for (const input of [
    { action: 'assign', id: 'device-one', slot: 'right', expectedRevision: 7 },
    { action: 'swap', expectedRevision: 7 },
    { action: 'disconnect', slot: 'left', expectedRevision: 7 },
    { action: 'auto-connect', enabled: false, expectedRevision: 7 },
  ])
    expect(await f.execute('fusion_devices', input, actor)).toEqual({
      ok: true,
      devices: f.snapshot,
    });
  expect(f.controller.assign).toHaveBeenCalledExactlyOnceWith('device-one', 'right', 7);
  expect(f.controller.swap).toHaveBeenCalledExactlyOnceWith(7);
  expect(f.controller.disconnect).toHaveBeenCalledExactlyOnceWith('left', 7);
  expect(f.controller.setAutoReconnect).toHaveBeenCalledExactlyOnceWith(false);
  expect(f.readAmplifierProject).not.toHaveBeenCalled();
  expect(f.documents).toEqual(before);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('refuses stale revisions before any binding or preference command reaches the controller', async () => {
  const f = fixture();
  for (const input of [
    { action: 'assign', id: 'device-one', slot: 'right', expectedRevision: 6 },
    { action: 'swap', expectedRevision: 6 },
    { action: 'disconnect', slot: 'left', expectedRevision: 6 },
    { action: 'auto-connect', enabled: true, expectedRevision: 6 },
  ])
    expect(await f.execute('fusion_devices', input, actor)).toMatchObject({
      ok: false,
      error: expect.stringContaining('connections changed'),
    });
  expect(f.controller.assign).not.toHaveBeenCalled();
  expect(f.controller.swap).not.toHaveBeenCalled();
  expect(f.controller.disconnect).not.toHaveBeenCalled();
  expect(f.controller.setAutoReconnect).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('routes a complete design read exclusively to its explicit role port and preserves the returned result', async () => {
  const f = fixture();
  expect(await f.execute('fusion_devices', { action: 'read', slot: 'right' }, actor)).toEqual({
    ok: true,
    result: f.readResult,
  });
  expect(f.readAmplifierProject).toHaveBeenCalledExactlyOnceWith('right');
  expect(f.controller.getSnapshot).not.toHaveBeenCalled();
  expect(f.controller.discover).not.toHaveBeenCalled();
  expect(f.controller.assign).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('refuses missing discovery/read ports and propagates a read failure without fallback, retry or direct hardware calls', async () => {
  const f = fixture();
  f.adapter.readAmplifierProject = undefined;
  expect(await f.execute('fusion_devices', { action: 'read', slot: 'right' }, actor)).toMatchObject(
    { ok: false, error: expect.stringContaining('unavailable') },
  );
  f.adapter.readAmplifierProject = f.readAmplifierProject;
  f.readAmplifierProject.mockRejectedValueOnce(new Error('Synthetic incomplete amplifier read'));
  expect(await f.execute('fusion_devices', { action: 'read', slot: 'right' }, actor)).toMatchObject(
    { ok: false, error: 'Synthetic incomplete amplifier read' },
  );
  expect(f.readAmplifierProject).toHaveBeenCalledTimes(1);
  f.adapter.amplifiers = undefined;
  expect(await f.execute('fusion_devices', { action: 'discover' }, actor)).toMatchObject({
    ok: false,
    error: expect.stringContaining('unavailable'),
  });
  expect(f.controller.discover).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});
