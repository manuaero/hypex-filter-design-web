import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createFirmwareWorkspace } from '../src/application/firmware-workspace';
import {
  createFirmwareExecutionWorkflow,
  planFirmwareRecoveryAssignments,
  FirmwareExecutionError,
} from '../src/application/firmware-execution';
import { KNOWN_FIRMWARE_PROFILES } from '../src/domain/firmware-profile';
import {
  createFirmwareUpdateCoordinator,
  createGuardedPhysicalFirmwareUpdateAdapter,
  FirmwareUpdateError,
  type FirmwareUpdateCoordinator,
  type FirmwareUpdateSnapshot,
} from '../src/hardware/firmware-update';
import type {
  FirmwareJournalRecord,
  FirmwareJournalBinding,
} from '../src/application/firmware-update-storage';

const actor = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'ui:firmware' };
const text =
  [
    ':10000080A80D0000CA080000465553494F4E3332B0',
    ':01000081027C',
    ':020000040000FA',
    ':10068000464133320000000000000000000000007E',
    ':00000001FF',
  ].join('\r\n') + '\r\n';
const unavailable = {
  available: false,
  qualifier: 'unqualified-physical' as const,
  route: 'physical' as const,
  qualified: false,
  reasons: ['No qualified physical loader profile.'],
};
function fixture(available = true) {
  // Deliberate hasher test double for app flow, never actual file identity proof.
  const workspace = createFirmwareWorkspace({
    binding: () => undefined,
    sha256: async () => KNOWN_FIRMWARE_PROFILES[0].sha256,
  });
  const listeners = new Set<() => void>();
  let snapshot: Readonly<FirmwareUpdateSnapshot> = {
    busy: false,
    phase: 'idle',
    records: [],
    availability: {
      left: { ...unavailable, available, reasons: available ? [] : unavailable.reasons },
      right: { ...unavailable, available, reasons: available ? [] : unavailable.reasons },
    },
  };
  const coordinator: FirmwareUpdateCoordinator = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    status: vi.fn((ctx) => {
      if (ctx.owner !== actor.owner) throw new Error('Foreign workspace');
      return snapshot;
    }),
    availability: (target) => snapshot.availability[target === 'both' ? 'left' : target],
    invalidateReview: vi.fn(),
    hydrate: vi.fn(async () => {}),
    review: vi.fn(async (target) => ({
      id: 'review-1',
      target,
      qualifier: 'qualified-physical' as const,
      roles: [],
    })),
    reviewRecovery: vi.fn(async (id, target) => ({
      id: 'recovery-1',
      target,
      sourceRecordId: id,
      qualifier: 'qualified-physical' as const,
      roles: [],
    })),
    apply: vi.fn(),
    discard: vi.fn(),
    exportRecord: vi.fn(),
    dispose: vi.fn(),
  };
  let lease = 'original-role';
  const workflow = createFirmwareExecutionWorkflow({
    workspace,
    coordinator,
    assignmentId: () => lease,
  });
  return {
    workspace,
    coordinator,
    workflow,
    setLease: (value: string) => {
      lease = value;
    },
    publish: (patch: Partial<FirmwareUpdateSnapshot>) => {
      snapshot = { ...snapshot, ...patch };
      listeners.forEach((fn) => fn());
    },
  };
}
it('requires all exact stages before Both review, with no hidden reads or retargeting', async () => {
  const f = fixture();
  const left = await f.workflow.inspect('left', text, 'left.hex', actor);
  const right = await f.workflow.inspect('right', text, 'right.hex', actor);
  await expect(f.workflow.review('both', { left: left.id, right: 'stale' }, actor)).rejects.toThrow(
    'Every intended role',
  );
  await expect(
    f.workflow.review('left', { left: left.id, right: right.id }, actor),
  ).rejects.toThrow('Every intended role');
  expect(f.coordinator.review).not.toHaveBeenCalled();
  await expect(
    f.workflow.review('both', { left: left.id, right: right.id }, actor),
  ).resolves.toMatchObject({ target: 'both' });
  expect(f.coordinator.review).toHaveBeenCalledExactlyOnceWith('both', actor);
  expect(JSON.stringify(f.workflow.status(actor))).not.toContain(text);
});
it('preserves a stage through metadata-only expected disconnect but fences explicit new file, clear and reassignment', async () => {
  const f = fixture();
  const stage = await f.workflow.inspect('left', text, 'left.hex', actor);
  vi.mocked(f.coordinator.invalidateReview).mockClear();
  f.workspace.refreshTarget('left');
  f.workflow.refreshContext();
  expect(f.coordinator.invalidateReview).not.toHaveBeenCalled();
  expect(f.workspace.executionSource('left', stage.id)).toBeDefined();
  f.setLease('replacement');
  f.workflow.refreshContext();
  expect(f.coordinator.invalidateReview).toHaveBeenCalledTimes(1);
  await expect(f.workflow.inspect('left', 'bad', 'new.hex', actor)).rejects.toThrow();
  expect(f.workspace.executionSource('left', stage.id)).toBeUndefined();
  expect(f.coordinator.invalidateReview).toHaveBeenCalledTimes(2);
  f.workflow.clear('left', actor);
  expect(f.workflow.status(actor).files.left.phase).toBe('empty');
});
it('admits trusted owner and cancellation before staging, review, history or export', async () => {
  const f = fixture();
  expect(() =>
    f.workflow.status({ ...actor, owner: 'workspace:22222222-2222-4222-8222-222222222222' }),
  ).toThrow('Foreign');
  const abort = new AbortController();
  abort.abort();
  expect(() =>
    f.workflow.inspect('left', text, 'x.hex', { ...actor, signal: abort.signal }),
  ).toThrow('cancelled');
  expect(f.workspace.getSnapshot().left.phase).toBe('empty');
  expect(() => f.workflow.history(actor, 0, 17)).toThrow('1..16');
  expect(() => f.workflow.exportPage('x', actor, 0, 16385)).toThrow('1..16384');
  expect(f.coordinator.exportRecord).not.toHaveBeenCalled();
});
it('surfaces external/MCP outcomes through the same subscribed snapshot, with exact persistence', () => {
  const f = fixture(),
    listener = vi.fn();
  f.workflow.subscribe(listener);
  const outcome = {
    record: { id: 'consumed-partial', phase: 'partial' } as never,
    persistence: 'unavailable' as const,
  };
  f.publish({ latestOutcome: outcome });
  expect(f.workflow.status(actor).update.latestOutcome).toEqual(outcome);
  expect(listener).toHaveBeenCalledTimes(1);
  f.workflow.dispose();
  expect(f.coordinator.dispose).toHaveBeenCalledOnce();
  expect(() => f.workflow.status(actor)).toThrow('disposed');
});
it('never admits a production review or Apply through an empty physical qualification route', async () => {
  const forbidden = vi.fn(async () => {
    throw new Error('Unexpected physical I/O');
  });
  const workspace = createFirmwareWorkspace({ binding: () => undefined });
  const adapter = createGuardedPhysicalFirmwareUpdateAdapter({
    availability: () => unavailable,
    reserve: forbidden,
    preflightRuntime: forbidden,
    captureBefore: forbidden,
    enterBootloader: forbidden,
    discoverBootloader: forbidden,
    discoverRuntime: forbidden,
    captureAfter: forbidden,
  });
  const coordinator = createFirmwareUpdateCoordinator({
    adapter,
    source: (slot) => {
      const id = workspace.getSnapshot()[slot].stage?.id;
      return id ? workspace.executionSource(slot, id) : undefined;
    },
    binding: () => undefined,
    assignmentId: () => undefined,
  });
  const workflow = createFirmwareExecutionWorkflow({ workspace, coordinator });
  const stage = await workflow.inspect('left', text, 'arbitrary-version-5.7.hex', actor);
  expect(workflow.status(actor).availability.left.available).toBe(false);
  await expect(workflow.review('left', { left: stage.id }, actor)).rejects.toThrow(
    'No qualified physical',
  );
  await expect(workflow.apply('manufactured', actor, { confirm: true })).rejects.toThrow();
  expect(forbidden).not.toHaveBeenCalled();
  expect(createHash('sha256').update(text).digest('hex')).toBe(stage.sha256);
});
it('exports exact recovery bytes in bounded pages and retains consumed errors without raw source in the result', async () => {
  const f = fixture();
  const record = {
    id: 'r',
    owner: actor.owner,
    creatorScope: actor.scope,
    target: 'left',
    qualifier: 'qualified-physical',
    createdAt: 1,
    updatedAt: 2,
    phase: 'partial',
    roles: [],
  } as unknown as FirmwareJournalRecord;
  vi.mocked(f.coordinator.exportRecord).mockReturnValue({
    ...record,
    exportPersistence: 'unavailable',
  });
  const expected = JSON.stringify({ ...record, exportPersistence: 'unavailable' });
  let output = '',
    offset = 0;
  do {
    const page = f.workflow.exportPage('r', actor, offset, 17);
    output += page.content;
    expect(page.exportPersistence).toBe('unavailable');
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  } while (true);
  expect(output).toBe(expected);
  vi.mocked(f.coordinator.apply).mockRejectedValue(
    new FirmwareUpdateError('ACK lost', record, 'unavailable'),
  );
  await expect(f.workflow.apply('r', actor, { confirm: true })).rejects.toMatchObject({
    name: FirmwareExecutionError.name,
    result: { id: 'r', phase: 'partial' },
    persistence: 'unavailable',
  });
});

it('invalidates a recovery review on explicit Clear/new inspection even without any current staged source', async () => {
  const f = fixture();
  f.publish({
    activeReview: {
      id: 'recovery-only',
      sourceRecordId: 'partial',
      target: 'left',
      qualifier: 'qualified-physical',
      roles: [],
    },
  });
  f.workflow.clear('left', actor);
  expect(f.coordinator.invalidateReview).toHaveBeenCalledOnce();
  vi.mocked(f.coordinator.invalidateReview).mockClear();
  await expect(f.workflow.inspect('left', 'malformed', 'new.hex', actor)).rejects.toThrow();
  expect(f.coordinator.invalidateReview).toHaveBeenCalledOnce();
});

const historicalBinding = (slot: 'left' | 'right'): FirmwareJournalBinding => ({
  assignmentId: `historical-${slot}`,
  connectionId: `retired-runtime-${slot}`,
  connectionEpoch: 7,
  serial: `SYNTHETIC-${slot.toUpperCase()}`,
  hidSerial: `0303A:SYNTHETIC-${slot.toUpperCase()}`,
  family: 'FUSION32',
  product: 22,
  core: '5.1',
  firmware: '5.7',
});
it('uses the actual production recovery planner to restore cold metadata leases without claiming an interface or current file', () => {
  const roles = [
    { slot: 'left' as const, binding: historicalBinding('left') },
    { slot: 'right' as const, binding: historicalBinding('right') },
  ];
  const original = structuredClone(roles),
    cold = {};
  const planned = planFirmwareRecoveryAssignments(cold, {}, roles);
  expect(planned).toEqual({
    left: {
      assignmentId: 'historical-left',
      connectionId: 'retired-runtime-left',
      connectionEpoch: 7,
      serial: 'SYNTHETIC-LEFT',
    },
    right: {
      assignmentId: 'historical-right',
      connectionId: 'retired-runtime-right',
      connectionEpoch: 7,
      serial: 'SYNTHETIC-RIGHT',
    },
  });
  expect(cold).toEqual({});
  expect(roles).toEqual(original);
  expect(planFirmwareRecoveryAssignments(planned, {}, roles)).toEqual(planned);
  expect(planned.left).not.toHaveProperty('device');
  expect(planned.left).not.toHaveProperty('session');
});
it('refuses every live selected role and any differently occupied lease, including a same-serial new connection', () => {
  const binding = historicalBinding('right'),
    roles = [{ slot: 'right' as const, binding }];
  const retained = {
    right: {
      assignmentId: binding.assignmentId,
      connectionId: binding.connectionId,
      connectionEpoch: binding.connectionEpoch,
      serial: binding.serial,
    },
  };
  expect(() => planFirmwareRecoveryAssignments(retained, { right: binding.serial }, roles)).toThrow(
    'live interface',
  );
  for (const changed of [
    { assignmentId: 'new-assignment' },
    { connectionId: 'new-interface' },
    { connectionEpoch: 8 },
    { serial: 'DIFFERENT' },
  ])
    expect(() =>
      planFirmwareRecoveryAssignments({ right: { ...retained.right, ...changed } }, {}, roles),
    ).toThrow('different firmware assignment');
});
it('validates all requested recovery roles before publishing any restored metadata', () => {
  const current = {
    right: {
      assignmentId: 'occupied-right',
      connectionId: 'current-right',
      connectionEpoch: 8,
      serial: 'OTHER-RIGHT',
    },
  };
  const original = structuredClone(current),
    roles = [
      { slot: 'left' as const, binding: historicalBinding('left') },
      { slot: 'right' as const, binding: historicalBinding('right') },
    ];
  expect(() => planFirmwareRecoveryAssignments(current, {}, roles)).toThrow(
    'different firmware assignment',
  );
  expect(current).toEqual(original);
  expect(current).not.toHaveProperty('left');
});
it('rejects duplicate recovery captures and cross-role serial/assignment conflicts without replacing the peer', () => {
  const left = historicalBinding('left'),
    right = historicalBinding('right');
  expect(() =>
    planFirmwareRecoveryAssignments({}, {}, [
      { slot: 'left', binding: left },
      { slot: 'left', binding: left },
    ]),
  ).toThrow('distinct');
  for (const conflict of [
    { ...right, serial: left.serial },
    { ...right, assignmentId: left.assignmentId },
  ])
    expect(() =>
      planFirmwareRecoveryAssignments({}, {}, [
        { slot: 'left', binding: left },
        { slot: 'right', binding: conflict },
      ]),
    ).toThrow('other role');
  expect(() =>
    planFirmwareRecoveryAssignments({}, { right: left.serial }, [{ slot: 'left', binding: left }]),
  ).toThrow('live in the other role');
  const peer = {
    right: {
      assignmentId: right.assignmentId,
      connectionId: right.connectionId,
      connectionEpoch: right.connectionEpoch,
      serial: left.serial,
    },
  };
  expect(() =>
    planFirmwareRecoveryAssignments(peer, {}, [{ slot: 'left', binding: left }]),
  ).toThrow('other role');
});
