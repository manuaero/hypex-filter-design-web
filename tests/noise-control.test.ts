import { describe, expect, it, vi } from 'vitest';
import {
  createNoiseController,
  NoiseControlError,
  type NoiseConnection,
  type NoiseControlOptions,
} from '../src/application/noise-control';
import type { PanelSession } from '../src/hardware/session';
import type { NoiseIdentity, NoiseResult, RotatingNoiseState } from '../src/hardware/noise';
import type { Slot } from '../src/domain/model';

const identity = (serial: string): NoiseIdentity => ({
  serial,
  product: 22,
  core: '5.1',
  firmware: '5.82',
});
const session = (tag: string) => ({ tag }) as unknown as PanelSession;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  const left = session('left'),
    right = session('right');
  const connections: Partial<Record<Slot, NoiseConnection>> = {
    left: { session: left, identity: identity('LEFT') },
    right: { session: right, identity: identity('RIGHT') },
  };
  const states = new Map<PanelSession, RotatingNoiseState>(),
    identities = new Map<PanelSession, NoiseIdentity>([
      [left, identity('LEFT')],
      [right, identity('RIGHT')],
    ]);
  const preflight = vi.fn(async (s: PanelSession) => identities.get(s)!);
  const send = vi.fn(
    async (s: PanelSession, enabled: boolean, expected?: NoiseIdentity): Promise<NoiseResult> => {
      states.set(s, { requested: enabled, acknowledgement: 'accepted' });
      return {
        identity: expected!,
        requested: enabled,
        acknowledged: true,
        actualState: 'unavailable',
        status: {} as never,
      };
    },
  );
  const operated = vi.fn();
  const options: NoiseControlOptions = {
    connections: () => connections,
    preflight,
    send,
    getState: (s) => states.get(s) ?? { requested: null, acknowledgement: 'none' },
    operate<T>(label: string, work: () => Promise<T>) {
      operated(label);
      return work();
    },
  };
  const controller = createNoiseController(options);
  return {
    controller,
    connections,
    identities,
    states,
    preflight,
    send,
    operated,
    options,
    left,
    right,
  };
}

it('starts with unknown command state, stable frozen snapshots and no automatic hardware commands', () => {
  const f = fixture(),
    snapshot = f.controller.getSnapshot();
  expect(snapshot).toMatchObject({
    left: { connected: true, requested: null, acknowledgement: 'none', actualState: 'unavailable' },
    right: { connected: true, requested: null },
  });
  expect(f.controller.getSnapshot()).toBe(snapshot);
  expect(Object.isFrozen(snapshot.left.identity)).toBe(true);
  const listener = vi.fn(),
    unsubscribe = f.controller.subscribe(listener);
  f.controller.refreshBindings();
  unsubscribe();
  expect(listener).not.toHaveBeenCalled();
  expect(f.preflight).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
});
it('preflights both roles completely before sending either command and preserves independent ACK states', async () => {
  const f = fixture(),
    gate = deferred<NoiseIdentity>();
  f.preflight.mockImplementation(async (s) => (s === f.right ? gate.promise : identity('LEFT')));
  const run = f.controller.set('both', true);
  await vi.waitFor(() => expect(f.preflight).toHaveBeenCalledTimes(2));
  expect(f.send).not.toHaveBeenCalled();
  gate.resolve(identity('RIGHT'));
  const result = await run;
  expect(result).toMatchObject({
    complete: true,
    partial: false,
    requested: true,
    roles: {
      left: { preflight: 'passed', write: 'acknowledged' },
      right: { preflight: 'passed', write: 'acknowledged' },
    },
  });
  expect(f.send).toHaveBeenCalledWith(f.left, true, identity('LEFT'));
  expect(f.send).toHaveBeenCalledWith(f.right, true, identity('RIGHT'));
  expect(f.controller.getSnapshot().left).toMatchObject({
    requested: true,
    acknowledgement: 'accepted',
    busy: false,
  });
  expect(Object.isFrozen(result.roles.left!.result)).toBe(true);
  expect(result.roles.left!.result).not.toHaveProperty('status');
});
it('refuses a missing selected role before any preflight or write and leaves the connected role unknown', async () => {
  const f = fixture();
  delete f.connections.right;
  await expect(f.controller.set('both', false)).rejects.toMatchObject({
    result: {
      roles: {
        left: { preflight: 'not-run', write: 'not-sent' },
        right: { preflight: 'failed', write: 'not-sent' },
      },
    },
  });
  expect(f.preflight).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.controller.getSnapshot().left.requested).toBeNull();
});
it.each(['session', 'serial'] as const)(
  'refuses duplicate physical %s across roles before preflight or write',
  async (by) => {
    const f = fixture();
    if (by === 'session') f.connections.right!.session = f.left;
    else f.connections.right!.identity.serial = 'LEFT';
    await expect(f.controller.set('both', true)).rejects.toThrow(/independent/);
    expect(f.preflight).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  },
);
it('sends neither request when one fresh preflight refuses or reports a different identity', async () => {
  const f = fixture();
  f.preflight.mockImplementation(async (s) => identity(s === f.left ? 'WRONG' : 'RIGHT'));
  await expect(f.controller.set('both', true)).rejects.toMatchObject({
    result: {
      roles: {
        left: { preflight: 'failed', write: 'not-sent' },
        right: { preflight: 'passed', write: 'not-sent' },
      },
    },
  });
  expect(f.send).not.toHaveBeenCalled();
});
it('does not leak raw preflight causes and never sends on initial denial', async () => {
  const f = fixture();
  f.preflight.mockRejectedValue(new Error('C:\\Users\\private\\secret.txt'));
  let failure: unknown;
  await f.controller.set('both', true).catch((e) => {
    failure = e;
  });
  expect(failure).toBeInstanceOf(NoiseControlError);
  expect(JSON.stringify(failure)).not.toMatch(/Users|secret|private/);
  expect(f.send).not.toHaveBeenCalled();
});
it('rechecks all captured bindings before writes when a peer changes during group preflight', async () => {
  const f = fixture(),
    gate = deferred<NoiseIdentity>();
  f.preflight.mockImplementation(async (s) => (s === f.left ? gate.promise : identity('RIGHT')));
  const run = f.controller.set('both', true);
  await vi.waitFor(() => expect(f.preflight).toHaveBeenCalledTimes(2));
  f.connections.right = { session: session('replacement'), identity: identity('NEW') };
  f.controller.refreshBindings();
  gate.resolve(identity('LEFT'));
  await expect(run).rejects.toMatchObject({
    result: { roles: { right: { stale: true, write: 'not-sent' } } },
  });
  expect(f.send).not.toHaveBeenCalled();
  expect(f.controller.getSnapshot().right).toMatchObject({
    identity: identity('NEW'),
    requested: null,
    acknowledgement: 'none',
    busy: false,
  });
});
it('captures immutable identity metadata before awaiting preflight', async () => {
  const f = fixture(),
    gate = deferred<NoiseIdentity>();
  f.preflight.mockReturnValue(gate.promise);
  const run = f.controller.set('left', true);
  f.connections.left!.identity.serial = 'MUTATED';
  gate.resolve(identity('LEFT'));
  await expect(run).rejects.toMatchObject({
    result: { roles: { left: { identity: identity('LEFT'), stale: true, write: 'not-sent' } } },
  });
  expect(f.send).not.toHaveBeenCalled();
});
it('keeps acknowledged and unconfirmed pair outcomes separately with no retry, mute or rollback', async () => {
  const f = fixture(),
    send = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (s, enabled, expected) => {
    if (s === f.right) {
      f.states.set(s, { requested: enabled, acknowledgement: 'unconfirmed' });
      throw new Error('ACK lost');
    }
    return send(s, enabled, expected);
  });
  await expect(f.controller.set('both', true)).rejects.toMatchObject({
    result: {
      complete: false,
      partial: true,
      roles: { left: { write: 'acknowledged' }, right: { write: 'unconfirmed' } },
    },
  });
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.send.mock.calls.every(([, enabled]) => enabled)).toBe(true);
  expect(f.controller.getSnapshot().left).toMatchObject({
    requested: true,
    acknowledgement: 'accepted',
  });
  expect(f.controller.getSnapshot().right).toMatchObject({
    requested: true,
    acknowledgement: 'unconfirmed',
  });
});
it('retains ACK success when the later status read fails and makes no acoustic state claim', async () => {
  const f = fixture();
  f.send.mockImplementation(async (_s, enabled, expected) => ({
    identity: expected!,
    requested: enabled,
    acknowledged: true,
    actualState: 'unavailable',
    statusError: 'Status unavailable',
  }));
  const result = await f.controller.set('left', false);
  expect(result).toMatchObject({
    complete: true,
    roles: {
      left: {
        write: 'acknowledged',
        result: {
          statusRead: 'failed',
          statusError: 'Status unavailable',
          actualState: 'unavailable',
        },
      },
    },
  });
  expect(f.controller.getSnapshot().left.acknowledgement).toBe('accepted');
});
it('allows an explicit Stop on an unknown connection without requiring ownership of a previous Start', async () => {
  const f = fixture();
  expect(f.controller.getSnapshot().right.requested).toBeNull();
  expect((await f.controller.set('right', false)).complete).toBe(true);
  expect(f.send).toHaveBeenCalledExactlyOnceWith(f.right, false, identity('RIGHT'));
});
it('blocks reentrant same-role changes while allowing the other role to progress independently', async () => {
  const f = fixture(),
    gate = deferred<NoiseIdentity>();
  f.preflight.mockImplementation(async (s) => (s === f.left ? gate.promise : identity('RIGHT')));
  const left = f.controller.set('left', true);
  await expect(f.controller.set('left', false)).rejects.toThrow(/already running/);
  expect((await f.controller.set('right', false)).complete).toBe(true);
  expect(f.controller.getSnapshot().left.busy).toBe(true);
  gate.resolve(identity('LEFT'));
  await left;
  expect(f.send).toHaveBeenCalledTimes(2);
});
it('does not apply a late ACK to the replacement connection but retains the captured old-device ledger', async () => {
  const f = fixture(),
    gate = deferred<NoiseResult>();
  f.send.mockReturnValue(gate.promise);
  const run = f.controller.set('left', true);
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  f.connections.left = { session: session('new'), identity: identity('NEW') };
  f.controller.refreshBindings();
  gate.resolve({
    identity: identity('LEFT'),
    requested: true,
    acknowledged: true,
    actualState: 'unavailable',
  });
  await expect(run).rejects.toMatchObject({
    result: {
      partial: true,
      roles: { left: { identity: identity('LEFT'), write: 'acknowledged', stale: true } },
    },
  });
  expect(f.controller.getSnapshot().left).toMatchObject({
    identity: identity('NEW'),
    requested: null,
    acknowledgement: 'none',
    busy: false,
  });
  expect(f.controller.getSnapshot().left.lastOperation).toBeUndefined();
  expect(f.send).toHaveBeenCalledTimes(1);
});
it('disconnect cleanup stops only an owned accepted Start and bypasses the outer operate wrapper once', async () => {
  const f = fixture();
  expect(await f.controller.stopOwned('left')).toBeUndefined();
  await f.controller.set('left', true);
  const cleanup = await f.controller.stopOwned('left');
  expect(cleanup).toMatchObject({ complete: true, requested: false });
  expect(f.operated).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls.map(([, value]) => value)).toEqual([true, false]);
  expect(await f.controller.stopOwned('left')).toBeUndefined();
  expect(f.send).toHaveBeenCalledTimes(2);
});
it('disconnect cleanup covers an owned unconfirmed Start but never retries an unconfirmed Stop', async () => {
  const f = fixture(),
    send = f.send.getMockImplementation()!;
  f.send.mockImplementationOnce(async (s) => {
    f.states.set(s, { requested: true, acknowledgement: 'unconfirmed' });
    throw new Error('Lost start ACK');
  });
  await f.controller.set('left', true).catch(() => {});
  expect((await f.controller.stopOwned('left'))?.complete).toBe(true);
  await f.controller.set('left', true);
  f.send.mockImplementationOnce(async (s) => {
    f.states.set(s, { requested: false, acknowledgement: 'unconfirmed' });
    throw new Error('Lost stop ACK');
  });
  await f.controller.set('left', false).catch(() => {});
  expect(await f.controller.stopOwned('left')).toBeUndefined();
  expect(f.send).toHaveBeenCalledTimes(4);
  f.send.mockImplementation(send);
});
it('never sends owned cleanup to a new binding or assumes ownership from an external cached Start', async () => {
  const f = fixture();
  f.states.set(f.right, { requested: true, acknowledgement: 'accepted' });
  expect(await f.controller.stopOwned('right')).toBeUndefined();
  await f.controller.set('left', true);
  f.connections.left = { session: session('new'), identity: identity('NEW') };
  f.controller.refreshBindings();
  expect(await f.controller.stopOwned('left')).toBeUndefined();
  expect(f.send).toHaveBeenCalledTimes(1);
});
it('settles a command already in flight after dispose without extra commands or listener updates', async () => {
  const f = fixture(),
    gate = deferred<NoiseResult>(),
    listener = vi.fn();
  f.send.mockReturnValue(gate.promise);
  f.controller.subscribe(listener);
  const run = f.controller.set('left', true);
  await vi.waitFor(() => expect(f.send).toHaveBeenCalled());
  f.controller.dispose();
  const count = listener.mock.calls.length;
  gate.resolve({
    identity: identity('LEFT'),
    requested: true,
    acknowledged: true,
    actualState: 'unavailable',
  });
  expect((await run).complete).toBe(true);
  expect(f.controller.getSnapshot().left.busy).toBe(false);
  expect(listener).toHaveBeenCalledTimes(count);
  expect(f.send).toHaveBeenCalledTimes(1);
  await expect(f.controller.set('left', false)).rejects.toThrow(/disposed/);
});
it('prevents a new wire command after disposal during preflight and returns a bounded not-sent ledger', async () => {
  const f = fixture(),
    gate = deferred<NoiseIdentity>();
  f.preflight.mockReturnValue(gate.promise);
  const run = f.controller.set('left', true);
  f.controller.dispose();
  gate.resolve(identity('LEFT'));
  await expect(run).rejects.toMatchObject({ result: { roles: { left: { write: 'not-sent' } } } });
  expect(f.send).not.toHaveBeenCalled();
});
it('reports an operate-wrapper refusal with zero hardware calls', async () => {
  const f = fixture(),
    controller = createNoiseController({
      ...f.options,
      operate: async () => {
        throw new Error('Other operation busy');
      },
    });
  await expect(controller.set('both', true)).rejects.toMatchObject({
    result: {
      roles: { left: { preflight: 'not-run', write: 'not-sent' }, right: { write: 'not-sent' } },
    },
  });
  expect(f.preflight).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
});

it.each(['session', 'serial'] as const)(
  'blocks any Start and paired Stop for a duplicate %s, but preserves one explicit Stop',
  async (by) => {
    const f = fixture();
    if (by === 'session') f.connections.right!.session = f.left;
    else f.connections.right!.identity.serial = 'LEFT';
    await expect(f.controller.set('left', true)).rejects.toThrow(/independent/);
    await expect(f.controller.set('right', true)).rejects.toThrow(/independent/);
    await expect(f.controller.set('both', false)).rejects.toThrow(/independent/);
    expect(f.preflight).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    const stop = await f.controller.set('left', false);
    expect(stop.complete).toBe(true);
    expect(f.send).toHaveBeenCalledExactlyOnceWith(f.left, false, identity('LEFT'));
    expect(f.controller.getSnapshot().left.acknowledgement).toBe('accepted');
  },
);
