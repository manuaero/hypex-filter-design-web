import { expect, it, vi } from 'vitest';
import { createToolExecutor, TOOL_DEFINITIONS, type ToolAdapter } from '../src/application/tools';
import {
  DeviceCloneError,
  type DeviceCloneController,
  type DeviceCloneSnapshot,
} from '../src/application/device-clone';
import type { CloneJournalRecord } from '../src/application/device-clone-storage';
import { newProject } from '../src/domain/model';

const id = '11111111-1111-4111-8111-111111111111';
const actor = { owner: 'workspace:22222222-2222-4222-8222-222222222222', scope: 'manual:clone' };
function fixture() {
  const record = {
    id,
    target: 'left',
    phase: 'partial',
    roles: [],
    createdAt: 1,
    updatedAt: 2,
    privateImages: 'DO-NOT-RETURN-RAW',
  } as unknown as CloneJournalRecord;
  const snapshot: DeviceCloneSnapshot = {
    phase: 'ready',
    busy: false,
    revision: 4,
    roles: { left: { connected: true }, right: { connected: false } },
    records: [record],
  };
  const controller: DeviceCloneController = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    status: vi.fn(() => snapshot),
    hydrate: vi.fn(async () => {}),
    reload: vi.fn(async () => snapshot),
    editOverrides: vi.fn(() => snapshot),
    review: vi.fn(async () => ({
      id,
      target: 'both' as const,
      revision: 4,
      createdAt: 1,
      roles: [],
    })),
    apply: vi.fn(async () => record),
    discard: vi.fn(),
    exportRecord: vi.fn(() => ({ ...record, exportPersistence: 'verified' as const })),
    refreshBindings: vi.fn(),
    dispose: vi.fn(),
  };
  const forbidden = vi.fn(() => {
      throw new Error('Use the shared Clone controller');
    }),
    view = vi.fn();
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
    choose: forbidden,
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
    deviceClone: controller,
  };
  return {
    controller,
    snapshot,
    record,
    adapter,
    view,
    forbidden,
    execute: createToolExecutor(adapter),
  };
}

it('rejects implicit roles, raw reports, injected authority and unconfirmed Clone actions before the controller', async () => {
  const f = fixture();
  for (const input of [
    { action: 'reload' },
    { action: 'review', target: 'selected', expectedRevision: 4 },
    { action: 'reload', target: 'both', owner: actor.owner },
    { action: 'apply', reviewId: id },
    { action: 'apply', reviewId: id, confirm: true, reportHex: '05' },
    {
      action: 'overrides',
      target: 'left',
      expectedRevision: 4,
      overrides: {
        mode: 'slave',
        presets: [{ forceInput: 8, sourceLock: true, volumeLock: true }],
      },
    },
  ])
    expect(await f.execute('fusion_device_clone', input, actor)).toMatchObject({ ok: false });
  expect(f.controller.reload).not.toHaveBeenCalled();
  expect(f.controller.apply).not.toHaveBeenCalled();
  expect(f.controller.review).not.toHaveBeenCalled();
  expect(f.controller.editOverrides).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('requires trusted context and serves cached bounded status without hardware calls or recovery bytes', async () => {
  const f = fixture();
  expect(await f.execute('fusion_device_clone', { action: 'status' })).toMatchObject({
    ok: false,
    error: expect.stringContaining('trusted'),
  });
  const result = await f.execute(
    'fusion_device_clone',
    { action: 'status', offset: 0, limit: 1 },
    actor,
  );
  expect(result).toMatchObject({
    ok: true,
    clone: { revision: 4, totalRecords: 1, records: [{ id, phase: 'partial' }] },
  });
  expect(JSON.stringify(result)).not.toContain('DO-NOT-RETURN-RAW');
  expect(f.controller.status).toHaveBeenCalledExactlyOnceWith(actor);
  expect(f.controller.reload).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(
    TOOL_DEFINITIONS.find((t) => t.name === 'fusion_device_clone')?.annotations.readOnlyHint,
  ).toBe(false);
});

it('forwards exact independent destinations, revisions and overrides through the shared UI controller', async () => {
  const f = fixture(),
    overrides = {
      mode: 'slave',
      presets: Array.from({ length: 3 }, () => ({
        forceInput: 7,
        sourceLock: true,
        volumeLock: false,
      })),
    };
  await f.execute('fusion_device_clone', { action: 'reload', target: 'both' }, actor);
  expect(f.controller.reload).toHaveBeenCalledExactlyOnceWith('both', actor);
  await f.execute(
    'fusion_device_clone',
    { action: 'overrides', target: 'right', expectedRevision: 4, overrides },
    actor,
  );
  expect(f.controller.editOverrides).toHaveBeenCalledExactlyOnceWith('right', actor, {
    expectedRevision: 4,
    overrides,
  });
  await f.execute(
    'fusion_device_clone',
    { action: 'review', target: 'left', expectedRevision: 4 },
    actor,
  );
  expect(f.controller.review).toHaveBeenCalledExactlyOnceWith('left', actor, {
    expectedRevision: 4,
  });
  expect(f.view).toHaveBeenCalledWith({ tab: 'Device settings' });
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('preserves a consumed partial outcome and persistence failure even if cancellation arrives after a write', async () => {
  const f = fixture(),
    cancellation = new AbortController();
  vi.mocked(f.controller.apply).mockImplementationOnce(async () => {
    cancellation.abort();
    throw new DeviceCloneError('Readback not confirmed', f.record, 'unavailable');
  });
  const result = await f.execute(
    'fusion_device_clone',
    { action: 'apply', reviewId: id, confirm: true },
    { ...actor, signal: cancellation.signal },
  );
  expect(result).toMatchObject({
    ok: false,
    error: 'Readback not confirmed',
    persistence: 'unavailable',
    result: { id, phase: 'partial' },
  });
  expect(JSON.stringify(result)).not.toContain('DO-NOT-RETURN-RAW');
  expect(f.controller.apply).toHaveBeenCalledOnce();
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('returns a completed journal directly when cancellation follows its final verified step', async () => {
  const f = fixture(),
    cancellation = new AbortController();
  vi.mocked(f.controller.apply).mockImplementationOnce(async () => {
    cancellation.abort();
    return f.record;
  });
  expect(
    await f.execute(
      'fusion_device_clone',
      { action: 'apply', reviewId: id, confirm: true },
      { ...actor, signal: cancellation.signal },
    ),
  ).toMatchObject({ ok: true, record: { id, phase: 'partial' } });
  expect(f.controller.status).not.toHaveBeenCalled();
});

it('exports complete recovery images only through the checked file transfer, with no inline raw data', async () => {
  const f = fixture();
  const createExport = vi.fn(async () => ({ id: 'transfer', files: [], totalBytes: 1 }));
  f.adapter.files = {
    manager: { createExport } as never,
    revision: () => 8,
    commit: vi.fn(),
    lookup: vi.fn(),
  };
  const execute = createToolExecutor(f.adapter);
  const result = await execute('fusion_device_clone', { action: 'export-record', id }, actor);
  expect(result).toMatchObject({ ok: true, transfer: { id: 'transfer' } });
  expect(JSON.stringify(result)).not.toContain('DO-NOT-RETURN-RAW');
  expect(f.controller.exportRecord).toHaveBeenCalledExactlyOnceWith(id, actor);
  const call = createExport.mock.calls[0] as unknown as [
    unknown,
    { path: string; blob: Blob }[],
    unknown,
  ];
  expect(call[0]).toEqual(actor);
  expect(call[1][0].path).toBe(`Clone-${id}.json`);
  expect(await call[1][0].blob.text()).toContain('DO-NOT-RETURN-RAW');
});
