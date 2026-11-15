import { expect, it, vi } from 'vitest';
import { createToolExecutor, TOOL_DEFINITIONS, type ToolAdapter } from '../src/application/tools';
import {
  DeviceDefaultsError,
  type DeviceDefaultsController,
  type DeviceDefaultsReview,
  type DeviceDefaultsSnapshot,
} from '../src/application/device-defaults';
import {
  defaultsBeforeSha256,
  type DefaultsJournalRecord,
} from '../src/application/device-defaults-storage';
import { buildDeviceDefaultsPlan } from '../src/hardware/device-defaults';
import { hex } from '../src/hardware/codec';
import { newProject } from '../src/domain/model';

const reviewId = '11111111-1111-4111-8111-111111111111',
  owner = 'workspace:22222222-2222-4222-8222-222222222222';
const actor = { owner, scope: 'paired:site:tool-test' };
function fixture() {
  const status = new Uint8Array(64);
  status[0] = 5;
  status[2] = 1;
  const configuration = new Uint8Array(64);
  configuration.set([6, 22, 5, 1]);
  configuration[15] = 5;
  configuration[17] = 7;
  const deviceConfiguration = new Uint8Array(64);
  deviceConfiguration[0] = 0x66;
  deviceConfiguration[10] = 5;
  deviceConfiguration[12] = 22;
  deviceConfiguration[13] = 1;
  const identity = { serial: 'SIMULATED-LEFT', product: 22, core: '5.1', firmware: '5.7' },
    plan = buildDeviceDefaultsPlan({ identity, status, configuration, deviceConfiguration }),
    before = {
      statusHex: hex(status),
      configurationHex: hex(configuration),
      deviceConfigurationHex: hex(deviceConfiguration),
    };
  const review: DeviceDefaultsReview = {
    id: reviewId,
    operation: 'defaults',
    target: 'left',
    createdAt: 10,
    roles: [
      {
        slot: 'left',
        identity,
        before: plan.before,
        after: plan.after,
        steps: plan.steps.map((s) => s.id),
      },
    ],
  };
  const record: DefaultsJournalRecord = {
    id: reviewId,
    owner,
    scope: 'ui:creator',
    appliedScope: actor.scope,
    operation: 'defaults',
    target: 'left',
    createdAt: 10,
    updatedAt: 20,
    phase: 'complete',
    roles: [
      {
        slot: 'left',
        identity,
        before,
        beforeSha256: defaultsBeforeSha256(before),
        preflight: 'verified',
        lastConfirmedMuted: true,
        steps: plan.steps.map((s) => ({
          id: s.id,
          requestHex: hex(s.request),
          expectedHex: hex(s.verification.expected),
          maskHex: hex(s.verification.mask),
          attempted: true,
          state: 'verified',
        })),
      },
    ],
  };
  const snapshot: DeviceDefaultsSnapshot = {
    phase: 'ready',
    busy: false,
    records: [record],
    activeReview: review,
  };
  const controller: DeviceDefaultsController = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    hydrate: vi.fn(async () => {}),
    status: vi.fn(() => snapshot),
    reviewDefaults: vi.fn(async () => review),
    apply: vi.fn(async () => record),
    discard: vi.fn(),
    reviewRecovery: vi.fn(async () => ({
      ...review,
      operation: 'recovery' as const,
      sourceRecordId: record.id,
    })),
    restore: vi.fn(async () => ({
      ...record,
      operation: 'recovery' as const,
      sourceRecordId: record.id,
    })),
    exportRecord: vi.fn(() => structuredClone(record)),
    refreshBindings: vi.fn(),
    dispose: vi.fn(),
  };
  const forbidden = vi.fn(() => {
      throw new Error('The Defaults tool must use its shared controller');
    }),
    view = vi.fn(),
    documents = { left: newProject('Left'), right: newProject('Right') };
  const adapter: ToolAdapter = {
    state: () => ({
      documents,
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
    message: vi.fn(),
    progress: forbidden,
    view,
    deviceDefaults: controller,
  };
  return {
    execute: createToolExecutor(adapter),
    controller,
    snapshot,
    review,
    record,
    forbidden,
    view,
    documents,
  };
}

it('requires explicit targets and confirmations and refuses identity/packet injection before reaching the controller', async () => {
  const f = fixture();
  for (const input of [
    { action: 'review' },
    { action: 'review', target: 'selected' },
    { action: 'review', target: ['left', 'left'] },
    { action: 'review', target: 'both', owner },
    { action: 'apply', reviewId },
    { action: 'apply', reviewId, confirm: false },
    { action: 'apply', reviewId: 'not-a-uuid', confirm: true },
    { action: 'apply', reviewId, confirm: true, packets: [] },
    { action: 'restore', reviewId, confirm: true, scope: actor.scope },
    { action: 'status', limit: 21 },
    { action: 'status', offset: -1 },
  ])
    expect(await f.execute('fusion_device_defaults', input, actor)).toMatchObject({ ok: false });
  expect(await f.execute('fusion_device_defaults', { action: 'status' })).toMatchObject({
    ok: false,
    error: expect.stringContaining('trusted workspace'),
  });
  expect(f.controller.status).not.toHaveBeenCalled();
  expect(f.controller.reviewDefaults).not.toHaveBeenCalled();
  expect(f.controller.apply).not.toHaveBeenCalled();
  expect(f.controller.restore).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('reviews exactly the requested roles regardless of selected role or linked controls and stages the same visible review', async () => {
  const f = fixture(),
    before = structuredClone(f.documents);
  expect(
    await f.execute('fusion_device_defaults', { action: 'review', target: 'left' }, actor),
  ).toEqual({ ok: true, review: f.review });
  expect(f.controller.reviewDefaults).toHaveBeenCalledExactlyOnceWith('left', actor);
  expect(f.view).toHaveBeenCalledExactlyOnceWith({ tab: 'Device settings' });
  await f.execute('fusion_device_defaults', { action: 'review', target: 'both' }, actor);
  expect(f.controller.reviewDefaults).toHaveBeenLastCalledWith('both', actor);
  expect(f.documents).toEqual(before);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('pages cached metadata without hydrating, device I/O or silently exporting exact records', async () => {
  const f = fixture();
  f.snapshot.records = Array.from({ length: 12 }, (_, i) => ({
    ...f.record,
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  }));
  const result = await f.execute(
    'fusion_device_defaults',
    { action: 'status', offset: 2, limit: 3 },
    actor,
  );
  expect(result).toMatchObject({
    ok: true,
    defaults: { totalRecords: 12, offset: 2, nextOffset: 5, records: expect.any(Array) },
  });
  expect((result as { defaults: { records: unknown[] } }).defaults.records).toHaveLength(3);
  const json = JSON.stringify(result);
  for (const key of [
    'statusHex',
    'requestHex',
    'expectedHex',
    'maskHex',
    'beforeSha256',
    'appliedScope',
  ])
    expect(json).not.toContain(key);
  expect(f.controller.hydrate).not.toHaveBeenCalled();
  expect(f.controller.exportRecord).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
  await f.execute('fusion_device_defaults', { action: 'refresh-history' }, actor);
  expect(f.controller.hydrate).toHaveBeenCalledExactlyOnceWith(actor);
});

it('forwards one immutable review ID and cancellation context, returns a ledger summary, and exposes full recovery only on explicit export', async () => {
  const f = fixture(),
    cancellation = new AbortController(),
    context = { ...actor, signal: cancellation.signal };
  expect(
    await f.execute(
      'fusion_device_defaults',
      { action: 'apply', reviewId, confirm: true },
      context,
    ),
  ).toMatchObject({ ok: true, record: { id: reviewId, phase: 'complete' } });
  expect(f.controller.apply).toHaveBeenCalledExactlyOnceWith(reviewId, context, { confirm: true });
  const exported = await f.execute(
    'fusion_device_defaults',
    { action: 'export-record', id: reviewId },
    actor,
  );
  expect(exported).toEqual({ ok: true, record: f.record });
  expect(f.controller.exportRecord).toHaveBeenCalledExactlyOnceWith(reviewId, actor);
  await f.execute('fusion_device_defaults', { action: 'review-recovery', id: reviewId }, actor);
  expect(f.controller.reviewRecovery).toHaveBeenCalledExactlyOnceWith(reviewId, actor);
  await f.execute('fusion_device_defaults', { action: 'restore', reviewId, confirm: true }, actor);
  expect(f.controller.restore).toHaveBeenCalledExactlyOnceWith(reviewId, actor, { confirm: true });
  await f.execute('fusion_device_defaults', { action: 'discard-review', reviewId }, actor);
  expect(f.controller.discard).toHaveBeenCalledExactlyOnceWith(reviewId, actor);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('retains partial and unconfirmed outcomes on failures without invoking a second apply or leaking raw recovery frames', async () => {
  const f = fixture(),
    partial = structuredClone(f.record);
  partial.phase = 'partial';
  partial.roles[0].steps[2].state = 'failed';
  partial.roles[0].steps[2].attempted = true;
  partial.roles[0].steps[3].state = 'pending';
  partial.roles[0].steps[3].attempted = false;
  vi.mocked(f.controller.apply).mockRejectedValueOnce(
    new DeviceDefaultsError('Readback was not confirmed', partial),
  );
  const result = await f.execute(
    'fusion_device_defaults',
    { action: 'apply', reviewId, confirm: true },
    actor,
  );
  expect(result).toMatchObject({
    ok: false,
    result: {
      phase: 'partial',
      roles: [
        {
          steps: [
            { state: 'verified' },
            { state: 'verified' },
            { state: 'failed', attempted: true },
            { state: 'pending', attempted: false },
          ],
        },
      ],
    },
  });
  expect(JSON.stringify(result)).not.toContain('requestHex');
  expect(f.controller.apply).toHaveBeenCalledTimes(1);
  expect(f.controller.restore).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('publishes the strict mixed-operation schema and cancels before any controller action', async () => {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === 'fusion_device_defaults')!;
  expect(tool.inputSchema.type).toBe('object');
  expect(tool.annotations.readOnlyHint).toBe(false);
  const f = fixture(),
    cancellation = new AbortController();
  cancellation.abort();
  await expect(
    f.execute(
      'fusion_device_defaults',
      { action: 'apply', reviewId, confirm: true },
      { ...actor, signal: cancellation.signal },
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.controller.apply).not.toHaveBeenCalled();
});
