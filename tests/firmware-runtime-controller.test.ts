import { expect, it, vi } from 'vitest';
import {
  createFirmwareRuntimeController,
  type FirmwareRuntimeBinding,
} from '../src/application/firmware-runtime';
import type { FirmwareRuntimeReport } from '../src/hardware/firmware-runtime-inspector';

const actor = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'manual:runtime' };
const report = (serial = 'SYNTHETIC-LEFT', newer = false): FirmwareRuntimeReport => ({
  identity: {
    serial,
    product: 22,
    core: newer ? '5.5' : '5.1',
    firmware: newer ? '5.82' : '5.7',
    name: 'Synthetic DSP',
  },
  hardware: { amplifier: 5, moduleType: 9, presets: 3, channels: 3 },
  profileId: newer ? 'fusion32-5.82-core5.5' : 'fusion32-5.7-core5.1',
  controlsQualified: !newer,
  familyProof: 'not-established-by-runtime-reports',
  imageProof: 'not-established-by-runtime-reports',
  consistency: 'double-read-matched',
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  const bindings: Partial<Record<'left' | 'right', FirmwareRuntimeBinding>> = {
    left: { key: 'left-session-1', serial: 'SYNTHETIC-LEFT', source: 'connected-session' },
    right: { key: 'right-memory-1', serial: 'SYNTHETIC-RIGHT', source: 'remembered-device' },
  };
  const read = vi.fn(async (slot: 'left' | 'right') =>
    report(bindings[slot]!.serial, slot === 'right'),
  );
  const controller = createFirmwareRuntimeController({
    binding: (slot) => bindings[slot],
    read,
    now: () => 1000,
  });
  return { bindings, read, controller };
}
it('cached construction, availability, status, clear and binding reconciliation perform no read', () => {
  const f = fixture();
  expect(f.controller.getSnapshot().busy).toBe(false);
  expect(f.controller.availability('left')).toEqual({ available: true });
  f.controller.status(actor);
  f.controller.clear('both', actor);
  f.controller.refreshBindings();
  expect(f.read).not.toHaveBeenCalled();
});
it('requires canonical workspace admission and never lets another owner read or clear the shared report', async () => {
  const f = fixture();
  expect(() => f.controller.status({ owner: 'ui:invented', scope: 'ui:invented' })).toThrow(
    'trusted',
  );
  await f.controller.read('left', actor);
  const before = f.controller.getSnapshot();
  const foreign = { owner: 'workspace:22222222-2222-4222-8222-222222222222', scope: 'ui:other' };
  await expect(f.controller.read('right', foreign)).rejects.toThrow('another workspace');
  expect(() => f.controller.status(foreign)).toThrow('another workspace');
  expect(() => f.controller.clear('both', foreign)).toThrow('another workspace');
  expect(f.controller.getSnapshot()).toBe(before);
  expect(f.read).toHaveBeenCalledTimes(1);
});
it('captures independent sources, reads sequentially and publishes completed nonbusy Both snapshots without enabling newer controls', async () => {
  const f = fixture(),
    result = await f.controller.read('both', actor);
  expect(result.busy).toBe(false);
  expect(f.read.mock.calls.map((call) => call[0])).toEqual(['left', 'right']);
  expect(result.roles.left).toMatchObject({
    phase: 'ready',
    stale: false,
    source: 'connected-session',
    observedAt: '1970-01-01T00:00:01.000Z',
    report: { identity: { serial: 'SYNTHETIC-LEFT' } },
  });
  expect(result.roles.right).toMatchObject({
    phase: 'ready',
    source: 'remembered-device',
    report: { identity: { core: '5.5' }, controlsQualified: false },
  });
  expect(Object.isFrozen(result.roles.right.report!.identity)).toBe(true);
});
it('preflights missing and duplicate Both identities before the first provider call', async () => {
  const f = fixture();
  delete f.bindings.right;
  await expect(f.controller.read('both', actor)).rejects.toThrow('no captured');
  f.bindings.right = {
    key: 'different-source',
    serial: f.bindings.left!.serial,
    source: 'remembered-device',
  };
  await expect(f.controller.read('both', actor)).rejects.toThrow('distinct');
  f.bindings.right = { key: 'manual-choice', source: 'chosen-device' };
  await expect(f.controller.read('both', actor)).rejects.toThrow('distinct');
  expect(f.read).not.toHaveBeenCalled();
});
it('retains historical reports but publishes no fresh Left result when Right fails', async () => {
  const f = fixture();
  await f.controller.read('both', actor);
  const before = structuredClone(f.controller.getSnapshot());
  f.read.mockImplementationOnce(async () => ({
    ...report(),
    identity: { ...report().identity, name: 'New left name' },
  }));
  f.read.mockRejectedValueOnce(new Error('Right read failed'));
  await expect(f.controller.read('both', actor)).rejects.toThrow('Right read failed');
  const after = f.controller.getSnapshot();
  expect(after.busy).toBe(false);
  for (const slot of ['left', 'right'] as const) {
    expect(after.roles[slot].report).toEqual(before.roles[slot].report);
    expect(after.roles[slot]).toMatchObject({ phase: 'error', stale: true });
  }
});
it('rejects a provider report from the wrong amplifier and any invented proof/controls flag', async () => {
  const f = fixture();
  for (const value of [
    report('OTHER-SYNTHETIC'),
    { ...report(), controlsQualified: false },
    { ...report(), imageProof: 'verified' },
  ]) {
    f.read.mockResolvedValueOnce(value as FirmwareRuntimeReport);
    await expect(f.controller.read('left', actor)).rejects.toThrow();
    expect(f.controller.getSnapshot().roles.left.report).toBeUndefined();
  }
});
it('fences replaced sources even if an injected provider ignores its hooks', async () => {
  const f = fixture(),
    pending = deferred<FirmwareRuntimeReport>();
  f.read.mockImplementationOnce(() => pending.promise);
  const task = f.controller.read('left', actor);
  f.bindings.left = { ...f.bindings.left!, key: 'replacement-session' };
  pending.resolve(report());
  await expect(task).rejects.toThrow('target changed');
  expect(f.controller.getSnapshot().roles.left.report).toBeUndefined();
  expect(f.read).toHaveBeenCalledTimes(1);
});
it('Clear invalidates a late selected result; clearing the other role does not cancel this read', async () => {
  const f = fixture(),
    first = deferred<FirmwareRuntimeReport>();
  f.read.mockImplementationOnce(() => first.promise);
  const discarded = f.controller.read('left', actor);
  f.controller.clear('left', actor);
  first.resolve(report());
  await expect(discarded).rejects.toThrow('target changed');
  expect(f.controller.getSnapshot().roles.left).toEqual({ phase: 'empty', stale: false });
  const second = deferred<FirmwareRuntimeReport>();
  f.read.mockImplementationOnce(() => second.promise);
  const retained = f.controller.read('left', actor);
  f.controller.clear('right', actor);
  second.resolve(report());
  expect((await retained).roles.left.phase).toBe('ready');
});
it('cancellation before and after a read prevents publication without retry', async () => {
  const f = fixture(),
    abort = new AbortController();
  abort.abort();
  await expect(f.controller.read('left', { ...actor, signal: abort.signal })).rejects.toThrow();
  expect(f.read).not.toHaveBeenCalled();
  const late = new AbortController(),
    pending = deferred<FirmwareRuntimeReport>();
  f.read.mockImplementationOnce(() => pending.promise);
  const task = f.controller.read('left', { ...actor, signal: late.signal });
  late.abort();
  pending.resolve(report());
  await expect(task).rejects.toThrow();
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.controller.getSnapshot().roles.left.report).toBeUndefined();
});
it('prevents duplicate flights and marks old source reports stale without automatic reads', async () => {
  const f = fixture(),
    pending = deferred<FirmwareRuntimeReport>();
  f.read.mockImplementationOnce(() => pending.promise);
  const task = f.controller.read('left', actor);
  await expect(f.controller.read('right', actor)).rejects.toThrow('running');
  pending.resolve(report());
  await task;
  f.bindings.left = { ...f.bindings.left!, key: 'new-epoch' };
  expect(f.controller.status(actor).roles.left.stale).toBe(true);
  expect(f.read).toHaveBeenCalledTimes(1);
});
it('dispose clears cached identity and prevents late results and later admissions', async () => {
  const f = fixture(),
    pending = deferred<FirmwareRuntimeReport>();
  f.read.mockImplementationOnce(() => pending.promise);
  const task = f.controller.read('left', actor);
  f.controller.dispose();
  pending.resolve(report());
  await expect(task).rejects.toThrow('target changed');
  expect(f.controller.getSnapshot()).toMatchObject({
    busy: false,
    roles: { left: { phase: 'empty' }, right: { phase: 'empty' } },
  });
  expect(f.controller.availability('left').available).toBe(false);
  expect(() => f.controller.status(actor)).toThrow('disposed');
});
