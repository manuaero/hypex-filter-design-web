import { expect, it, vi } from 'vitest';
import {
  createDeviceDefaultsController,
  DeviceDefaultsError,
} from '../src/application/device-defaults';
import {
  assertDeviceDefaultsWrite,
  parseDeviceDefaultsEnvelope,
  type DeviceDefaultsStorage,
  type DefaultsJournalEnvelope,
} from '../src/application/device-defaults-storage';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { hex, unhex, settings, decodeStatus } from '../src/hardware/codec';
import { buildDeviceDefaultsRecoveryPlan } from '../src/hardware/device-defaults';
import type { Transport } from '../src/hardware/transport';
import type { Slot } from '../src/domain/model';

const actor = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'manual:review' };
const ui = { ...actor, scope: 'ui:confirm' };
const other = { owner: 'workspace:22222222-2222-4222-8222-222222222222', scope: 'manual:other' };
const mutating = (p: SimulatedPanel) =>
  p.requests.filter((r) => (r[0] === 5 && r[1] === 0) || (r[0] === 0x66 && r[1] === 1));
class MemoryJournal implements DeviceDefaultsStorage {
  value: DefaultsJournalEnvelope = { version: 1, revision: 0, records: [] };
  reads = 0;
  writes = 0;
  beforeWrite?: (next: DefaultsJournalEnvelope) => void;
  afterWrite?: (next: DefaultsJournalEnvelope) => void;
  async read() {
    this.reads++;
    return parseDeviceDefaultsEnvelope(structuredClone(this.value));
  }
  async compareAndSwap(revision: number, next: DefaultsJournalEnvelope) {
    this.beforeWrite?.(next);
    assertDeviceDefaultsWrite(this.value, revision, next);
    this.value = parseDeviceDefaultsEnvelope(structuredClone(next));
    this.writes++;
    this.afterWrite?.(this.value);
  }
}
async function fixture() {
  const panels = {
      left: new SimulatedPanel('DEFAULTS-LEFT'),
      right: new SimulatedPanel('DEFAULTS-RIGHT'),
    },
    intercept: Partial<
      Record<Slot, (request: Uint8Array, send: () => Promise<Uint8Array>) => Promise<Uint8Array>>
    > = {};
  const sessions = {} as Record<Slot, PanelSession>,
    bindings = {} as Record<
      Slot,
      { session: PanelSession; identity: NonNullable<PanelSession['identity']> }
    >;
  for (const slot of ['left', 'right'] as const) {
    const panel = panels[slot];
    panel.status[6] = 0;
    panel.status[9] = 0xf6;
    panel.status[10] = 0x2b;
    panel.status[12] = 0xf3;
    panel.status[13] = 0x65;
    panel.status[14] = 0xb1;
    panel.status[27] = 0x83;
    panel.status[35] = 0x92;
    panel.status[36] = 0xd9;
    panel.deviceConfiguration[13] = 1;
    const transport: Transport = {
      exchange: (request) =>
        intercept[slot]?.(request, () => panel.exchange(request)) ?? panel.exchange(request),
      close: () => panel.close(),
    };
    sessions[slot] = new PanelSession(transport, async () => {});
    bindings[slot] = { session: sessions[slot], identity: await sessions[slot].identify() };
    panel.requests.length = 0;
  }
  const storage = new MemoryJournal(),
    operate = vi.fn(async (_label: string, work: () => Promise<unknown>) => work()),
    locks: string[] = [],
    controller = createDeviceDefaultsController({
      binding: (slot) => bindings[slot],
      storage,
      operate: operate as <T>(label: string, work: () => Promise<T>) => Promise<T>,
      withLock: async (_name, work) => {
        locks.push('held');
        try {
          return await work();
        } finally {
          locks.pop();
        }
      },
    });
  return { panels, sessions, bindings, storage, intercept, controller, operate, locks };
}

it('reviews/status without writes, then confirms the exact two-amplifier plan across same-owner entry points with all snapshots durable before mute', async () => {
  const f = await fixture(),
    original = structuredClone(f.panels.left.status);
  const proposal = await f.controller.reviewDefaults('both', actor);
  expect(proposal.roles.map((r) => r.slot)).toEqual(['left', 'right']);
  expect(proposal.roles[0].after).toMatchObject({
    startupVolume: -40,
    bridge: false,
    master: true,
    oledMaximumBrightness: 15,
    oledDimmedBrightness: 6,
    standbyLedMode: 0,
  });
  expect(mutating(f.panels.left)).toHaveLength(0);
  expect(mutating(f.panels.right)).toHaveLength(0);
  const reads = f.storage.reads,
    requests = f.panels.left.requests.length;
  f.controller.status(ui);
  f.controller.status(actor);
  expect(f.storage.reads).toBe(reads);
  expect(f.panels.left.requests).toHaveLength(requests);
  f.storage.beforeWrite = (next) => {
    expect(f.locks).toEqual(['held']);
    expect(f.sessions.left.busy && f.sessions.right.busy).toBe(true);
    if (next.records[0].phase === 'prepared') {
      expect(next.records[0].roles).toHaveLength(2);
      for (const panel of Object.values(f.panels)) expect(mutating(panel)).toHaveLength(0);
    }
  };
  const result = await f.controller.apply(proposal.id, ui, { confirm: true });
  expect(result.phase).toBe('complete');
  expect(result.scope).toBe(actor.scope);
  expect(result.appliedScope).toBe(ui.scope);
  for (const role of result.roles) {
    expect(role.steps.map((s) => [s.id, s.state, s.attempted])).toEqual(
      ['mute', 'settings', 'mixer', 'configuration', 'display'].map((id) => [id, 'verified', true]),
    );
    expect(role.lastConfirmedMuted).toBe(true);
  }
  expect(f.panels.left.configuration[4] & 16).toBe(0); // Native Defaults display is unconditional without OLED.
  expect(settings(decodeStatus(f.panels.left.status))).toMatchObject({
    oledMaximumBrightness: 15,
    oledDimmedBrightness: 6,
  });
  expect(f.panels.left.status[12] & 0x5f).toBe(original[12] & 0x5f);
  const allRequests = Object.values(f.panels).reduce((n, p) => n + p.requests.length, 0),
    storageReads = f.storage.reads;
  expect(await f.controller.apply(proposal.id, actor, { confirm: true })).toEqual(result);
  await expect(f.controller.restore(proposal.id, actor, { confirm: true })).rejects.toThrow(
    'different device operation',
  );
  expect(Object.values(f.panels).reduce((n, p) => n + p.requests.length, 0)).toBe(allRequests);
  expect(f.storage.reads).toBe(storageReads);
});

it('refuses a late locked second amp even with every OEM bit before any mute or Defaults write', async () => {
  const f = await fixture(),
    proposal = await f.controller.reviewDefaults('both', actor);
  f.panels.right.status[51] = 2;
  f.panels.right.status[24] = 255;
  f.panels.right.status[25] = 255;
  f.panels.right.deviceConfiguration[11] = 1;
  await expect(f.controller.apply(proposal.id, ui, { confirm: true })).rejects.toThrow('unlocked');
  for (const panel of Object.values(f.panels)) expect(mutating(panel)).toHaveLength(0);
  expect(f.storage.value.records).toHaveLength(0);
});

it.each(['prepared', 'running', 'attempt-marker', 'other-attempt-marker'] as const)(
  'sends no participant setter when the second amp locks during the %s journal write',
  async (phase) => {
    const f = await fixture(),
      proposal = await f.controller.reviewDefaults('both', actor);
    f.storage.afterWrite = (next) => {
      if (
        next.records[0].phase === phase ||
        (phase === 'attempt-marker' && next.records[0].roles[0].steps[0].state === 'attempted')
      )
        f.panels.right.status[51] = 2;
      if (
        phase === 'other-attempt-marker' &&
        next.records[0].roles[1].steps[0].state === 'attempted'
      )
        f.panels.left.status[51] = 2;
    };
    await expect(f.controller.apply(proposal.id, actor, { confirm: true })).rejects.toBeInstanceOf(
      DeviceDefaultsError,
    );
    expect(mutating(f.panels.left)).toHaveLength(0);
    expect(mutating(f.panels.right)).toHaveLength(0);
    expect(f.storage.value.records[0].phase).toBe('failed');
    expect(
      f.storage.value.records[0].roles.every(
        (role) => role.steps[0].state === 'failed' && !role.steps[0].attempted,
      ),
    ).toBe(true);
  },
);

it('refuses duplicate physical identity, foreign review confirmation, and a replaced session without retargeting', async () => {
  const f = await fixture();
  f.bindings.right = f.bindings.left;
  await expect(f.controller.reviewDefaults('both', actor)).rejects.toThrow('distinct');
  const proposal = await f.controller.reviewDefaults('left', actor);
  await expect(f.controller.apply(proposal.id, other, { confirm: true })).rejects.toThrow(
    'another workspace',
  );
  f.bindings.left = f.bindings.right = {
    ...f.bindings.left,
    session: new PanelSession(new SimulatedPanel('REPLACEMENT'), async () => {}),
  };
  f.controller.refreshBindings();
  await expect(f.controller.apply(proposal.id, actor, { confirm: true })).rejects.toThrow(
    'missing',
  );
  for (const panel of Object.values(f.panels)) expect(mutating(panel)).toHaveLength(0);
});

it('cancels both before any setter when original snapshot persistence fails', async () => {
  const f = await fixture(),
    proposal = await f.controller.reviewDefaults('both', actor);
  f.storage.beforeWrite = () => {
    throw new Error('Injected durable storage failure');
  };
  await expect(f.controller.apply(proposal.id, actor, { confirm: true })).rejects.toThrow(
    'storage failure',
  );
  for (const panel of Object.values(f.panels)) expect(mutating(panel)).toHaveLength(0);
});

it('rechecks serial after durable preparation and writes no mute to a replacement identity', async () => {
  const f = await fixture(),
    proposal = await f.controller.reviewDefaults('left', actor);
  f.storage.afterWrite = (next) => {
    if (next.records[0].phase === 'prepared')
      f.panels.left.eeprom.set(new TextEncoder().encode('CHANGED-IDENTITY\0'), 0x100);
  };
  await expect(f.controller.apply(proposal.id, actor, { confirm: true })).rejects.toBeInstanceOf(
    DeviceDefaultsError,
  );
  expect(mutating(f.panels.left)).toHaveLength(0);
  expect(f.storage.value.records[0].phase).toBe('failed');
  expect(f.storage.value.records[0].roles[0].steps[0]).toMatchObject({
    state: 'failed',
    attempted: false,
  });
});

it('stops the affected amp after a committed write loses its ACK, lets the other finish, and replays the partial ledger without I/O', async () => {
  const f = await fixture(),
    proposal = await f.controller.reviewDefaults('both', actor);
  let poisoned = false;
  f.intercept.left = async (request, send) => {
    if (poisoned) throw new Error('Poisoned transport');
    const reply = await send();
    if (request[0] === 5 && request[1] === 0 && request[8] === 15) {
      poisoned = true;
      throw new Error('Lost ACK');
    }
    return reply;
  };
  await expect(f.controller.apply(proposal.id, actor, { confirm: true })).rejects.toMatchObject({
    result: { phase: 'partial' },
  });
  const result = f.storage.value.records[0];
  expect(result.roles[0].steps.map((s) => s.state)).toEqual([
    'verified',
    'failed',
    'pending',
    'pending',
    'pending',
  ]);
  expect(result.roles[0].steps[1].attempted).toBe(true);
  expect(result.roles[1].steps.every((s) => s.state === 'verified')).toBe(true);
  expect(mutating(f.panels.left)).toHaveLength(2);
  const requests = f.panels.left.requests.length + f.panels.right.requests.length;
  await expect(f.controller.apply(proposal.id, ui, { confirm: true })).rejects.toMatchObject({
    result: { phase: 'partial' },
  });
  expect(f.panels.left.requests.length + f.panels.right.requests.length).toBe(requests);
});

it('recovers only Defaults-owned settings and limiter fields, preserving newer runtime, OEM, EQ/FIR and manufacturing values', async () => {
  const f = await fixture(),
    originalStatus = f.panels.left.status.slice(),
    originalConfiguration = f.panels.left.deviceConfiguration.slice();
  const proposal = await f.controller.reviewDefaults('left', actor);
  await f.controller.apply(proposal.id, ui, { confirm: true });
  const p = f.panels.left;
  p.status[2] = 2;
  new DataView(p.status.buffer).setInt16(3, -1234, true);
  p.status[6] = 0x85;
  p.status[12] = 0x51;
  p.status[13] = 0x56;
  p.status[14] = 0x42;
  p.status[24] = 0x69;
  p.status[25] = 0x35;
  p.status[28] = 0x35;
  p.status[31] = 5;
  p.deviceConfiguration[15] = 77;
  const current = p.status.slice();
  const recovery = await f.controller.reviewRecovery(proposal.id, ui);
  expect(recovery.operation).toBe('recovery');
  const result = await f.controller.restore(recovery.id, actor, { confirm: true });
  expect(result.phase).toBe('complete');
  expect(result.roles[0].steps.map((s) => s.id)).toEqual([
    'mute',
    'restore-configuration',
    'restore-settings',
  ]);
  for (const i of [2, 3, 4, 6, 24, 25, 28, 29, 30, 31]) expect(p.status[i]).toBe(current[i]);
  for (const i of [12, 13, 14]) {
    expect(p.status[i] & 0x5f).toBe(current[i] & 0x5f);
    expect(p.status[i] & 0xa0).toBe(originalStatus[i] & 0xa0);
  }
  expect(hex(p.deviceConfiguration.slice(20, 62))).toBe(hex(originalConfiguration.slice(20, 62)));
  expect(p.deviceConfiguration[15]).toBe(77);
  expect(p.status[23]).toBe(0);
  expect(p.oemMaskUpdates).toBe(0);
});

it('permits new Defaults after a later verified recovery, then blocks again after a newer partial recovery without rewriting old receipts', async () => {
  const f = await fixture(),
    initial = await f.controller.reviewDefaults('left', actor);
  let failed = false;
  f.intercept.left = async (request, send) => {
    const response = await send();
    if (!failed && request[0] === 5 && request[1] === 0 && request[8] === 15) {
      failed = true;
      throw new Error('Lost original settings ACK');
    }
    return response;
  };
  await expect(f.controller.apply(initial.id, actor, { confirm: true })).rejects.toMatchObject({
    result: { phase: 'partial' },
  });
  const originalReceipt = structuredClone(f.storage.value.records[0]);
  delete f.intercept.left;
  const reconnect = async () => {
    const session = new PanelSession(f.panels.left, async () => {});
    f.bindings.left = { session, identity: await session.identify() };
    f.controller.refreshBindings();
  };
  await reconnect();
  const recovery = await f.controller.reviewRecovery(initial.id, ui);
  expect((await f.controller.restore(recovery.id, ui, { confirm: true })).phase).toBe('complete');
  const next = await f.controller.reviewDefaults('left', actor);
  expect((await f.controller.apply(next.id, actor, { confirm: true })).phase).toBe('complete');
  expect(f.storage.value.records[0]).toEqual(originalReceipt);
  const requests = f.panels.left.requests.length,
    reads = f.storage.reads;
  await expect(f.controller.apply(initial.id, ui, { confirm: true })).rejects.toMatchObject({
    result: originalReceipt,
  });
  expect(f.panels.left.requests).toHaveLength(requests);
  expect(f.storage.reads).toBe(reads);
  const lateRecovery = await f.controller.reviewRecovery(initial.id, ui);
  let lateFailed = false;
  // Replace the current session's transport explicitly to model a new lost ACK.
  const current = f.bindings.left.session,
    exchange = current.transport.exchange.bind(current.transport);
  current.transport.exchange = async (request, timeout) => {
    const response = await exchange(request, timeout);
    if (!lateFailed && request[0] === 0x66 && request[1] === 1) {
      lateFailed = true;
      throw new Error('Lost later recovery ACK');
    }
    return response;
  };
  await expect(f.controller.restore(lateRecovery.id, ui, { confirm: true })).rejects.toMatchObject({
    result: { phase: 'partial' },
  });
  await reconnect();
  const blocked = await f.controller.reviewDefaults('left', actor),
    before = mutating(f.panels.left).length;
  await expect(f.controller.apply(blocked.id, actor, { confirm: true })).rejects.toThrow(
    'unfinished Defaults',
  );
  expect(mutating(f.panels.left)).toHaveLength(before);
  expect(f.storage.value.records[0]).toEqual(originalReceipt);
});

it('does not resolve an old partial record using a later recovery receipt for a different amplifier identity', async () => {
  const f = await fixture(),
    initial = await f.controller.reviewDefaults('left', actor);
  let failed = false;
  f.intercept.left = async (request, send) => {
    const reply = await send();
    if (!failed && request[0] === 5 && request[1] === 0 && request[8] === 15) {
      failed = true;
      throw new Error('Lost settings ACK');
    }
    return reply;
  };
  await expect(f.controller.apply(initial.id, actor, { confirm: true })).rejects.toBeInstanceOf(
    DeviceDefaultsError,
  );
  delete f.intercept.left;
  const source = structuredClone(f.storage.value.records[0]),
    prior = source.roles[0],
    plan = buildDeviceDefaultsRecoveryPlan(
      {
        identity: prior.identity,
        status: unhex(prior.before.statusHex),
        configuration: unhex(prior.before.configurationHex),
        deviceConfiguration: unhex(prior.before.deviceConfigurationHex),
      },
      f.panels.left.status,
      f.panels.left.deviceConfiguration,
    );
  const unrelated: typeof source = {
    ...source,
    id: crypto.randomUUID(),
    sourceRecordId: source.id,
    operation: 'recovery',
    phase: 'complete',
    roles: [
      {
        ...prior,
        identity: { ...prior.identity, serial: 'OTHER-PHYSICAL-PANEL' },
        steps: [
          { ...prior.steps[0], state: 'verified', attempted: true },
          ...plan.steps.map((step) => ({
            id: step.id,
            requestHex: hex(step.request),
            expectedHex: hex(step.verification.expected),
            maskHex: hex(step.verification.mask),
            state: 'verified' as const,
            attempted: true,
          })),
        ],
      },
    ],
  };
  await f.storage.compareAndSwap(f.storage.value.revision, {
    ...f.storage.value,
    revision: f.storage.value.revision + 1,
    records: [...f.storage.value.records, unrelated],
  });
  const next = await f.controller.reviewDefaults('left', actor),
    before = mutating(f.panels.left).length;
  await expect(f.controller.apply(next.id, actor, { confirm: true })).rejects.toThrow(
    'unfinished Defaults',
  );
  expect(mutating(f.panels.left)).toHaveLength(before);
  expect(f.storage.value.records[0]).toEqual(source);
});

it('stops before sending when settings change during attempted-marker persistence', async () => {
  const f = await fixture(),
    proposal = await f.controller.reviewDefaults('left', actor);
  let changed = false;
  f.storage.afterWrite = (next) => {
    if (!changed && next.records[0].roles[0].steps[0].state === 'attempted') {
      changed = true;
      f.panels.left.status[3] ^= 1;
    }
  };
  await expect(f.controller.apply(proposal.id, actor, { confirm: true })).rejects.toThrow(
    'Mute was not confirmed',
  );
  expect(mutating(f.panels.left)).toHaveLength(0);
  expect(f.storage.value.records[0].roles[0].steps[0].attempted).toBe(false);
});

it('retains an attempted configuration ledger on readback corruption and never sends the later display phase', async () => {
  const f = await fixture(),
    proposal = await f.controller.reviewDefaults('left', actor);
  let configurationWritten = false,
    corrupted = false;
  f.intercept.left = async (request, send) => {
    const response = await send();
    if (request[0] === 0x66 && request[1] === 1) configurationWritten = true;
    else if (request[0] === 0x66 && configurationWritten && !corrupted) {
      response[20] ^= 1;
      corrupted = true;
    }
    return response;
  };
  await expect(f.controller.apply(proposal.id, actor, { confirm: true })).rejects.toMatchObject({
    result: { phase: 'partial' },
  });
  const role = f.storage.value.records[0].roles[0];
  expect(role.steps.map((s) => s.state)).toEqual([
    'verified',
    'verified',
    'verified',
    'failed',
    'pending',
  ]);
  expect(role.steps[3].attempted).toBe(true);
  expect(f.panels.left.displayUpdates).toBe(0);
  expect(mutating(f.panels.left).filter((r) => r[0] === 0x66)).toHaveLength(1);
});

it('honors cancellation before the first setter and does not discard a complete durable receipt after lost journal acknowledgment', async () => {
  const f = await fixture(),
    proposal = await f.controller.reviewDefaults('left', actor),
    abort = new AbortController();
  abort.abort();
  await expect(
    f.controller.apply(proposal.id, { ...actor, signal: abort.signal }, { confirm: true }),
  ).rejects.toBeInstanceOf(DeviceDefaultsError);
  expect(mutating(f.panels.left)).toHaveLength(0);
  expect(f.storage.value.records[0].phase).toBe('failed');
  const next = await f.controller.reviewDefaults('left', actor);
  let lost = false;
  f.storage.afterWrite = (stored) => {
    if (!lost && stored.records.at(-1)!.phase === 'complete') {
      lost = true;
      throw new Error('Lost completed receipt acknowledgment');
    }
  };
  const result = await f.controller.apply(next.id, ui, { confirm: true });
  expect(result.phase).toBe('complete');
  expect(f.storage.value.records.at(-1)!.phase).toBe('complete');
  expect(f.storage.value.records.at(-1)!.error).toBeUndefined();
});

it.each(['running-journal', 'attempt-marker', 'final-read'] as const)(
  'aborts during %s before any selected amplifier setter and records blocked attempts',
  async (stage) => {
    const f = await fixture(),
      proposal = await f.controller.reviewDefaults('both', actor),
      abort = new AbortController();
    let markerSeen = false;
    f.storage.afterWrite = (next) => {
      const r = next.records[0];
      if (stage === 'running-journal' && r.phase === 'running') abort.abort();
      if (r.roles.some((role) => role.steps[0].state === 'attempted')) {
        markerSeen = true;
        if (stage === 'attempt-marker') abort.abort();
      }
    };
    f.intercept.left = async (request, send) => {
      const reply = await send();
      if (stage === 'final-read' && markerSeen && request[0] === 5 && request[1] === 1)
        abort.abort();
      return reply;
    };
    await expect(
      f.controller.apply(proposal.id, { ...actor, signal: abort.signal }, { confirm: true }),
    ).rejects.toMatchObject({ result: { phase: 'failed' } });
    for (const panel of Object.values(f.panels)) expect(mutating(panel)).toHaveLength(0);
    for (const role of f.storage.value.records[0].roles) {
      expect(role.steps[0]).toMatchObject({ state: 'failed', attempted: false });
      expect(role.steps.slice(1).every((s) => s.state === 'pending' && !s.attempted)).toBe(true);
    }
  },
);

it('finishes and verifies both captured participants exactly once when abort arrives after the first setter begins', async () => {
  const f = await fixture(),
    proposal = await f.controller.reviewDefaults('both', actor),
    abort = new AbortController();
  let first = false;
  for (const slot of ['left', 'right'] as const)
    f.intercept[slot] = async (request, send) => {
      if (!first && request[0] === 5 && request[1] === 0) {
        first = true;
        abort.abort();
      }
      return send();
    };
  const result = await f.controller.apply(
    proposal.id,
    { ...actor, signal: abort.signal },
    { confirm: true },
  );
  expect(abort.signal.aborted).toBe(true);
  expect(result.phase).toBe('complete');
  for (const panel of Object.values(f.panels)) expect(mutating(panel)).toHaveLength(5);
  expect(
    result.roles.every((r) => r.steps.every((s) => s.state === 'verified' && s.attempted)),
  ).toBe(true);
});

it.each(['during-apply', 'after-apply'] as const)(
  'rejects a recovery read resolving %s without replacing the newer active journal cache',
  async (timing) => {
    const f = await fixture(),
      original = await f.controller.reviewDefaults('left', actor);
    await f.controller.apply(original.id, ui, { confirm: true });
    const next = await f.controller.reviewDefaults('left', actor),
      read = f.storage.read.bind(f.storage);
    let resolveRead!: (value: DefaultsJournalEnvelope) => void, entered!: () => void;
    const pendingRead = new Promise<DefaultsJournalEnvelope>((resolve) => {
        resolveRead = resolve;
      }),
      readStarted = new Promise<void>((resolve) => {
        entered = resolve;
      });
    let captured!: DefaultsJournalEnvelope,
      held = false,
      busyCheck: Promise<unknown> | undefined;
    f.storage.read = async () => {
      const saved = await read();
      if (!held) {
        held = true;
        captured = saved;
        entered();
        return pendingRead;
      }
      return saved;
    };
    const recovery = f.controller.reviewRecovery(original.id, ui).then(
      () => undefined,
      (error: unknown) => error,
    );
    await readStarted;
    f.storage.afterWrite = (saved) => {
      const latest = saved.records.at(-1)!;
      if (!busyCheck && latest.phase === 'running') {
        const reads = f.storage.reads;
        busyCheck = f.controller.reviewRecovery(original.id, ui).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(f.storage.reads).toBe(reads);
      }
      if (timing === 'during-apply' && latest.roles[0].steps[1].state === 'verified')
        resolveRead(captured);
    };
    const applied = await f.controller.apply(next.id, actor, { confirm: true });
    if (timing === 'after-apply') resolveRead(captured);
    expect(await recovery).toBeInstanceOf(DeviceDefaultsError);
    expect(await busyCheck).toBeInstanceOf(DeviceDefaultsError);
    expect(applied.phase).toBe('complete');
    expect(f.controller.status(actor).records.at(-1)!.phase).toBe('complete');
    expect(f.controller.status(actor).activeReview).toBeUndefined();
    expect(
      f.storage.value.records.at(-1)!.roles[0].steps.every((s) => s.state === 'verified'),
    ).toBe(true);
    expect(mutating(f.panels.left)).toHaveLength(10);
  },
);
