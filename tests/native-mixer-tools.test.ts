import { expect, it, vi } from 'vitest';
import { createToolExecutor, TOOL_DEFINITIONS, type ToolAdapter } from '../src/application/tools';
import {
  NativeMixerError,
  type NativeMixerController,
  type NativeMixerSnapshot,
  type NativeMixerResult,
} from '../src/application/native-mixer';
import { newProject } from '../src/domain/model';

const actor = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'manual:mixer' },
  id = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const empty = () => ({
    connected: false,
    canEdit: false,
    openedPresets: [false, false, false] as const,
    changedPresets: [false, false, false] as const,
  });
  const snapshot: NativeMixerSnapshot = {
    phase: 'ready',
    busy: false,
    revision: 3,
    roles: { left: empty(), right: empty() },
    records: [],
  };
  const result: NativeMixerResult = {
    id,
    target: 'both',
    preset: 2,
    createdAt: 1,
    updatedAt: 2,
    phase: 'partial',
    roles: [],
    complete: false,
    partial: true,
    replayed: false,
    persistence: 'verified',
  };
  const controller: NativeMixerController = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    status: vi.fn(() => snapshot),
    hydrate: vi.fn(async () => {}),
    refreshHistory: vi.fn(async () => {}),
    load: vi.fn(async () => snapshot),
    open: vi.fn(() => snapshot),
    edit: vi.fn(() => snapshot),
    cancel: vi.fn(),
    review: vi.fn(async () => ({
      id,
      target: 'both' as const,
      preset: 2 as const,
      revision: 3,
      createdAt: 1,
      roles: [],
    })),
    save: vi.fn(async () => result),
    discard: vi.fn(),
    exportRecord: vi.fn(),
    refreshBindings: vi.fn(),
    dispose: vi.fn(),
  };
  const forbidden = vi.fn(() => {
      throw new Error('Use the shared mixer controller');
    }),
    view = vi.fn(),
    choose = vi.fn();
  const createExport = vi.fn(async () => ({ id: 'mixer-export', files: [] }));
  const adapter: ToolAdapter = {
    state: () => ({
      documents: { left: newProject(), right: newProject() },
      slot: 'right',
      preset: 0,
      channel: 0,
      filter: 0,
      linkedEdits: true,
      linkedControls: true,
    }),
    edit: forbidden,
    choose,
    undo: forbidden,
    redo: forbidden,
    connections: forbidden,
    connect: forbidden,
    disconnect: forbidden,
    refresh: forbidden,
    operate: forbidden,
    progress: forbidden,
    message: vi.fn(),
    view,
    nativeMixer: controller,
    files: { manager: { createExport }, revision: () => 4 } as unknown as NonNullable<
      ToolAdapter['files']
    >,
  };
  return {
    controller,
    snapshot,
    result,
    forbidden,
    view,
    choose,
    createExport,
    execute: createToolExecutor(adapter),
  };
}
it('rejects implicit roles/presets, invalid weights, packet injection, authority and unconfirmed saves before the controller', async () => {
  const f = fixture();
  for (const input of [
    { action: 'load', target: 'left' },
    { action: 'open', target: 'both', preset: 0, expectedRevision: 3 },
    {
      action: 'edit',
      target: 'left',
      preset: 1,
      channel: 0,
      input: 'left',
      value: 0,
      expectedRevision: 3,
    },
    {
      action: 'edit',
      target: 'left',
      preset: 1,
      channel: 1,
      input: 'right',
      value: 1.001,
      expectedRevision: 3,
    },
    { action: 'load', target: 'both', preset: 1, enable: true },
    { action: 'load', target: 'both', preset: 1, owner: actor.owner },
    { action: 'save', reviewId: id },
    { action: 'save', reviewId: id, confirm: true, packetHex: '6701' },
  ])
    expect(await f.execute('fusion_native_mixer', input, actor)).toMatchObject({ ok: false });
  expect(f.controller.load).not.toHaveBeenCalled();
  expect(f.controller.open).not.toHaveBeenCalled();
  expect(f.controller.edit).not.toHaveBeenCalled();
  expect(f.controller.save).not.toHaveBeenCalled();
  expect(f.choose).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('requires authenticated context and reads cached status without touching the hardware adapter or navigation', async () => {
  const f = fixture();
  expect(await f.execute('fusion_native_mixer', { action: 'status' })).toMatchObject({
    ok: false,
    error: expect.stringContaining('trusted'),
  });
  expect(await f.execute('fusion_native_mixer', { action: 'status' }, actor)).toMatchObject({
    ok: true,
    mixer: { revision: 3 },
  });
  expect(f.controller.status).toHaveBeenCalledExactlyOnceWith(actor);
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(f.choose).not.toHaveBeenCalled();
  expect(f.view).not.toHaveBeenCalled();
  expect(
    TOOL_DEFINITIONS.find((t) => t.name === 'fusion_native_mixer')?.annotations.readOnlyHint,
  ).toBe(false);
});
it('uses exact one-based context and the same independent drafts as UI, without selecting a different amplifier', async () => {
  const f = fixture();
  await f.execute('fusion_native_mixer', { action: 'load', target: 'both', preset: 3 }, actor);
  expect(f.controller.load).toHaveBeenCalledExactlyOnceWith('both', actor, { preset: 3 });
  await f.execute(
    'fusion_native_mixer',
    { action: 'open', target: 'left', preset: 2, expectedRevision: 3 },
    actor,
  );
  expect(f.controller.open).toHaveBeenCalledExactlyOnceWith('left', actor, {
    preset: 2,
    expectedRevision: 3,
  });
  await f.execute(
    'fusion_native_mixer',
    {
      action: 'edit',
      target: 'right',
      preset: 2,
      expectedRevision: 4,
      channel: 3,
      input: 'left',
      value: -0.1,
    },
    actor,
  );
  expect(f.controller.edit).toHaveBeenCalledExactlyOnceWith('right', actor, {
    preset: 2,
    expectedRevision: 4,
    channel: 3,
    input: 'left',
    value: -0.1,
  });
  await f.execute(
    'fusion_native_mixer',
    { action: 'review', target: 'both', preset: 2, expectedRevision: 5 },
    actor,
  );
  expect(f.controller.review).toHaveBeenCalledExactlyOnceWith('both', actor, {
    preset: 2,
    expectedRevision: 5,
  });
  await f.execute('fusion_native_mixer', { action: 'cancel', target: 'both', preset: 2 }, actor);
  expect(f.controller.cancel).toHaveBeenCalledExactlyOnceWith('both', actor, { preset: 2 });
  expect(f.choose.mock.calls).toEqual([
    [{ preset: 2 }],
    [{ preset: 1 }],
    [{ preset: 1 }],
    [{ preset: 1 }],
    [{ preset: 1 }],
  ]);
  expect(f.view).toHaveBeenCalledWith({ tab: 'Device settings' });
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('returns a consumed write ledger even when cancellation arrives after transmission', async () => {
  const f = fixture(),
    abort = new AbortController();
  vi.mocked(f.controller.save).mockImplementationOnce(async () => {
    abort.abort();
    throw new NativeMixerError('Unconfirmed mixer', f.result);
  });
  expect(
    await f.execute(
      'fusion_native_mixer',
      { action: 'save', reviewId: id, confirm: true },
      { ...actor, signal: abort.signal },
    ),
  ).toEqual({ ok: false, error: 'Unconfirmed mixer', result: f.result });
  expect(f.controller.save).toHaveBeenCalledOnce();
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('exports complete journals through checked chunks rather than inlining recovery packets into tool status', async () => {
  const f = fixture(),
    record = { id, exportPersistence: 'verified', before: 'retained exact bytes' };
  vi.mocked(f.controller.exportRecord).mockReturnValueOnce(record as never);
  expect(
    await f.execute('fusion_native_mixer', { action: 'export-record', id }, actor),
  ).toMatchObject({ ok: true, transfer: { id: 'mixer-export' } });
  const args = f.createExport.mock.calls[0] as unknown as [
    unknown,
    { path: string; blob: Blob }[],
    unknown,
  ];
  expect(args[0]).toEqual(actor);
  expect(args[1][0].path).toBe(`Mixer-${id}.json`);
  expect(JSON.parse(await args[1][0].blob.text())).toEqual(record);
  expect(args[2]).toEqual({
    workflow: 'native-mixer-recovery',
    parameters: { id },
    expectedRevision: 4,
  });
  expect(f.forbidden).not.toHaveBeenCalled();
});
