import { expect, it } from 'vitest';
import { parseFirmwareBundle } from '../src/domain/firmware';
import {
  createFirmwareUpdateCoordinator,
  createReferenceFirmwareUpdateAdapter,
  FirmwareUpdateError,
  type FirmwareReferenceUpdatePort,
  type FirmwareUpdateSource,
  type FirmwareUpdateAdapter,
} from '../src/hardware/firmware-update';
import { SimulatedFirmwareBootloader } from '../src/hardware/firmware-simulator';
import { SimulatedPanel } from '../src/hardware/simulator';
import { deviceDefaultsStatusMask } from '../src/hardware/device-defaults';
import { hex } from '../src/hardware/codec';
import {
  assertFirmwareJournalWrite,
  parseFirmwareJournalEnvelope,
  firmwareImageSha256,
  firmwareBeforeSha256,
  firmwareSourceSha256,
  type FirmwareJournalBinding,
  type FirmwareJournalBefore,
  type FirmwareJournalEnvelope,
  type FirmwareJournalStore,
} from '../src/application/firmware-update-storage';
import type { Slot } from '../src/domain/model';
const text = [
  ':10000080A80D0000CA080000465553494F4E3332B0',
  ':01000081027C',
  ':020000040000FA',
  ':10068000464133320000000000000000000000007E',
  ':00000001FF',
].join('\n');
const actor = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'manual:firmware' },
  ui = { ...actor, scope: 'ui:firmware' },
  other = { owner: 'workspace:22222222-2222-4222-8222-222222222222', scope: 'manual:foreign' };
function snapshot(panel: SimulatedPanel): FirmwareJournalBefore {
  const report = (id: number, bytes: Uint8Array) => {
    const mask = new Uint8Array(64).fill(255);
    mask[1] = 0;
    if (id === 6) for (const i of [2, 3, 15, 16, 17, 18]) mask[i] = 0;
    if (id === 5) mask.set(deviceDefaultsStatusMask());
    return {
      id: `report-${id}`,
      kind: 'report' as const,
      hex: hex(bytes),
      sha256: firmwareImageSha256(hex(bytes)),
      compareMaskHex: hex(mask),
    };
  };
  const images = [
    report(3, Uint8Array.of(3, 0, ...Array(62).fill(0))),
    report(5, panel.status),
    report(6, panel.configuration),
    report(0x66, panel.deviceConfiguration),
    ...Array.from({ length: 24 }, (_, i) => {
      const address = 0x10000 + i * 4096,
        bytes = panel.memory.slice(address, address + 4096);
      return {
        id: `flash-${address}`,
        kind: 'spi-flash' as const,
        address,
        hex: hex(bytes),
        sha256: firmwareImageSha256(hex(bytes)),
      };
    }),
    ...[0x100, 0x120, 0x140, ...Array.from({ length: 12 }, (_, i) => 0x200 + i * 32)].map(
      (address) => {
        const bytes = panel.eeprom.slice(address, address + 32);
        return {
          id: `eeprom-${address}`,
          kind: 'eeprom' as const,
          address,
          hex: hex(bytes),
          sha256: firmwareImageSha256(hex(bytes)),
        };
      },
    ),
  ];
  const before = { images, gaps: [] as string[], sha256: '' };
  before.sha256 = firmwareBeforeSha256(before);
  return before;
}
async function fixture() {
  const slots = ['left', 'right'] as const,
    panels = { left: new SimulatedPanel('SIM-FW-LEFT'), right: new SimulatedPanel('SIM-FW-RIGHT') },
    sources = {} as Record<Slot, FirmwareUpdateSource>,
    bindings = {} as Record<Slot, FirmwareJournalBinding>,
    assignments = {} as Record<Slot, string>,
    loaders = {} as Record<Slot, SimulatedFirmwareBootloader>,
    mode = { left: 'runtime', right: 'runtime' } as Record<Slot, 'runtime' | 'loader'>;
  for (const slot of slots) {
    panels[slot].deviceConfiguration[11] = 9;
    const serial = panels[slot].serial;
    bindings[slot] = {
      assignmentId: `assignment-${slot}`,
      connectionId: `runtime-${slot}-1`,
      connectionEpoch: 1,
      serial,
      hidSerial: `0303A:${serial}`,
      family: 'FUSION32',
      product: 22,
      core: '5.1',
      firmware: '5.7',
    };
    assignments[slot] = bindings[slot].assignmentId;
    sources[slot] = {
      stageId: `stage-${slot}-1`,
      name: `Synthetic${slot}.hex`,
      text,
      sha256: firmwareSourceSha256(text),
      family: 'FUSION32',
      expectedAfter: { core: '5.5', firmware: '5.82', source: 'explicit-simulation' },
    };
    loaders[slot] = new SimulatedFirmwareBootloader(parseFirmwareBundle(text), serial);
    loaders[slot].restartOnHeader = true;
  }
  const audit = {
      entries: [] as Slot[],
      captures: [] as Slot[],
      reservations: 0,
      events: [] as string[],
      physicalIO: 0,
    },
    faults = {
      wrongLoader: undefined as Slot | undefined,
      wrongRuntime: undefined as Slot | undefined,
      changedPreservation: undefined as Slot | undefined,
      entryAckLost: false,
    },
    slotFor = (b: FirmwareJournalBinding) =>
      b.assignmentId === 'assignment-left' ? 'left' : 'right';
  let afterWrite: ((value: FirmwareJournalEnvelope) => void | Promise<void>) | undefined,
    failWrite: ((value: FirmwareJournalEnvelope) => boolean) | undefined,
    stored: FirmwareJournalEnvelope = { version: 1, revision: 0, records: [] };
  const store: FirmwareJournalStore = {
    read: async () => structuredClone(stored),
    compareAndSwap: async (rev, next) => {
      if (failWrite?.(next)) throw new Error('Synthetic firmware journal outage');
      assertFirmwareJournalWrite(stored, rev, next);
      stored = parseFirmwareJournalEnvelope(next);
      await afterWrite?.(stored);
    },
  };
  const port: FirmwareReferenceUpdatePort = {
    reserve: async (_bindings, work) => {
      audit.reservations++;
      try {
        return await work();
      } finally {
        audit.reservations--;
      }
    },
    preflightRuntime: async (b) => {
      const s = slotFor(b);
      if (mode[s] !== 'runtime') throw new Error('Synthetic target is not in runtime mode');
      return structuredClone(bindings[s]);
    },
    captureBefore: async (b) => {
      const s = slotFor(b);
      audit.captures.push(s);
      return snapshot(panels[s]);
    },
    enterBootloader: async (b, ctx) => {
      expect(audit.reservations).toBeGreaterThan(0);
      expect(stored.records.at(-1)!.roles.every((r) => r.before.images.length === 43)).toBe(true);
      const s = slotFor(b);
      ctx.beforeWireSend();
      audit.entries.push(s);
      audit.events.push(`entry-${s}`);
      mode[s] = 'loader';
      loaders[s].restartReference();
      if (faults.entryAckLost) throw new Error('Synthetic entry stale/absent reply');
      return 'sent';
    },
    discoverBootloader: async (b) => {
      const s = slotFor(b);
      if (mode[s] !== 'loader') throw new Error('Synthetic loader not attached');
      const selected =
        faults.wrongLoader === s ? loaders[s === 'left' ? 'right' : 'left'] : loaders[s];
      return { identity: selected.identity(), channel: selected.channel() };
    },
    discoverRuntime: async (b) => {
      const s = slotFor(b);
      if (!loaders[s].exitRequested) throw new Error('Synthetic runtime did not reappear');
      const fresh = {
        ...b,
        connectionId: `runtime-${s}-${b.connectionEpoch + 2}`,
        connectionEpoch: b.connectionEpoch + 2,
        core: '5.5',
        firmware: '5.82',
      };
      if (faults.wrongRuntime === s) return { ...fresh, serial: 'OTHER-UNIT' };
      bindings[s] = fresh;
      mode[s] = 'runtime';
      panels[s].configuration[2] = 5;
      panels[s].configuration[3] = 5;
      const v = new DataView(panels[s].configuration.buffer);
      v.setUint16(15, 5, true);
      v.setUint16(17, 82, true);
      return structuredClone(fresh);
    },
    captureAfter: async (b) => {
      const s = slotFor(b);
      if (faults.changedPreservation === s) panels[s].memory[0x22000] ^= 1;
      return snapshot(panels[s]);
    },
  };
  const adapter = createReferenceFirmwareUpdateAdapter(port),
    options = {
      adapter,
      source: (slot: Slot) => sources[slot],
      binding: (slot: Slot) => bindings[slot],
      assignmentId: (slot: Slot) => assignments[slot],
      journal: store,
      withLock: async <T>(_name: string, work: () => Promise<T>) => work(),
      sleep: async () => {},
    };
  const controller = createFirmwareUpdateCoordinator(options);
  await controller.hydrate(actor);
  return {
    controller,
    options,
    port,
    panels,
    sources,
    bindings,
    assignments,
    loaders,
    mode,
    audit,
    faults,
    get stored() {
      return stored;
    },
    set afterWrite(value: typeof afterWrite) {
      afterWrite = value;
    },
    set failWrite(value: typeof failWrite) {
      failWrite = value;
    },
  };
}

it('reviews both roles read-only, captures all known areas without credentials, and exposes bounded metadata only', async () => {
  const f = await fixture(),
    review = await f.controller.review('both', actor);
  expect(review.roles).toHaveLength(2);
  expect(
    review.roles.every(
      (r) => r.knownImageCount === 43 && r.gaps.includes('original-pic32-program-not-captured'),
    ),
  ).toBe(true);
  expect(f.audit.entries).toHaveLength(0);
  expect(f.stored.records).toHaveLength(0);
  expect(JSON.stringify(f.controller.status(ui))).not.toMatch(/:10000080|compareMaskHex/);
  const count = f.audit.captures.length;
  f.controller.status(ui);
  expect(f.audit.captures.length).toBe(count);
});

// Every CAS validates/hashes all 43 real-size images per role. Keep these full
// durability checks while allowing CPU headroom when the broad suite runs in parallel.
it('executes complete reference discovery/two-pass/exit/fresh-runtime workflow sequentially with all beforeimages durable first', async () => {
  const f = await fixture(),
    review = await f.controller.review('both', actor),
    before = { left: hex(f.panels.left.memory), right: hex(f.panels.right.memory) };
  for (const slot of ['left', 'right'] as const)
    f.loaders[slot].afterWire = () => {
      expect(f.stored.records[0].roles).toHaveLength(2);
      expect(f.stored.records[0].roles.every((r) => r.before.images.length === 43)).toBe(true);
    };
  const result = await f.controller.apply(review.id, ui, { confirm: true });
  expect(result).toMatchObject({ qualifier: 'reference-simulation', phase: 'complete' });
  expect(f.audit.entries).toEqual(['left', 'right']);
  for (const slot of ['left', 'right'] as const) {
    expect(hex(f.panels[slot].memory)).toBe(before[slot]);
    const role = result.roles.find((r) => r.slot === slot)!;
    expect(role.steps.every((s) => s.state === 'verified')).toBe(true);
    expect(role.stream).toMatchObject({
      acceptedPackets: 6,
      acceptedRecords: 10,
      nativeProgressRecords: 12,
      streamComplete: true,
    });
    expect(role.after).toMatchObject({
      binding: { serial: f.panels[slot].serial, core: '5.5', firmware: '5.82' },
      controlsDialect: 'unqualified',
      preservation: 'matched-known-ranges',
    });
  }
  expect(f.controller.status(actor).latestOutcome?.record.phase).toBe('complete');
  const events =
    f.audit.entries.length + f.loaders.left.requests.length + f.loaders.right.requests.length;
  expect(await f.controller.apply(review.id, actor, { confirm: true })).toEqual(result);
  expect(
    f.audit.entries.length + f.loaders.left.requests.length + f.loaders.right.requests.length,
  ).toBe(events);
}, 30_000);

it('uses fresh correlated major99 instead of trusting a stale/absent entry ACK', async () => {
  const f = await fixture();
  f.faults.entryAckLost = true;
  const r = await f.controller.review('left', actor),
    result = await f.controller.apply(r.id, actor, { confirm: true });
  expect(result.phase).toBe('complete');
  expect(f.audit.entries).toEqual(['left']);
  expect(result.roles[0].steps[0]).toMatchObject({ attempted: true, state: 'verified' });
});

it('rejects wrong bootloader correlation before program and leaves the other amplifier untouched', async () => {
  const f = await fixture(),
    r = await f.controller.review('both', actor);
  f.faults.wrongLoader = 'left';
  await expect(f.controller.apply(r.id, actor, { confirm: true })).rejects.toMatchObject({
    result: { phase: 'partial' },
  });
  expect(f.audit.entries).toEqual(['left']);
  expect(f.loaders.left.requests).toHaveLength(0);
  expect(f.loaders.right.requests).toHaveLength(0);
});

it.each(['prepared', 'running'] as const)(
  'rechecks every target after %s persistence before any entry or program sender',
  async (at) => {
    const f = await fixture(),
      r = await f.controller.review('both', actor);
    let changed = false;
    f.afterWrite = (value) => {
      if (!changed && value.records[0].phase === at) {
        changed = true;
        f.bindings.right = { ...f.bindings.right, firmware: 'changed' };
      }
    };
    await expect(f.controller.apply(r.id, actor, { confirm: true })).rejects.toBeInstanceOf(
      FirmwareUpdateError,
    );
    expect(f.audit.entries).toHaveLength(0);
    expect(f.loaders.left.requests.length + f.loaders.right.requests.length).toBe(0);
  },
);

it('rejects durable backup failure with zero senders, and never accepts a forged physical adapter', async () => {
  const f = await fixture(),
    r = await f.controller.review('left', actor);
  f.failWrite = () => true;
  await expect(f.controller.apply(r.id, actor, { confirm: true })).rejects.toMatchObject({
    result: undefined,
  });
  expect(f.audit.entries).toHaveLength(0);
  expect(() =>
    createFirmwareUpdateCoordinator({ ...f.options, adapter: {} as FirmwareUpdateAdapter }),
  ).toThrow('unqualified');
});

it('honors abort during first program intent without sending program rows and never issues cancel41', async () => {
  const f = await fixture(),
    stop = new AbortController(),
    ctx = { ...actor, signal: stop.signal },
    r = await f.controller.review('left', ctx);
  f.afterWrite = (value) => {
    if (value.records[0].roles[0].steps[2].state === 'intent') stop.abort();
  };
  await expect(f.controller.apply(r.id, ctx, { confirm: true })).rejects.toMatchObject({
    result: { phase: 'partial' },
  });
  expect(f.audit.entries).toEqual(['left']);
  expect(f.loaders.left.requests).toHaveLength(0);
});

it('distinguishes target rejection, stops peers, and replay consumes no I/O', async () => {
  const f = await fixture(),
    r = await f.controller.review('both', actor);
  f.loaders.left.statuses.set(0, 0x9e);
  let failure: FirmwareUpdateError | undefined;
  try {
    await f.controller.apply(r.id, actor, { confirm: true });
  } catch (e) {
    failure = e as FirmwareUpdateError;
  }
  expect(failure!.result!.roles[0].steps[2]).toMatchObject({ state: 'rejected', attempted: true });
  expect(failure!.result!.roles[0].stream?.targetStatus).toBe(0x9e);
  expect(f.audit.entries).toEqual(['left']);
  const requests = f.loaders.left.requests.length;
  await expect(f.controller.apply(r.id, ui, { confirm: true })).rejects.toThrow('Consumed');
  expect(f.loaders.left.requests.length).toBe(requests);
});

it('allows explicit same-owner correlated bootloader recovery under a new token without rewriting historical failure', async () => {
  const f = await fixture(),
    r = await f.controller.review('right', actor);
  f.loaders.right.fault = { at: 0, kind: 'lost-ack' };
  await expect(f.controller.apply(r.id, actor, { confirm: true })).rejects.toBeInstanceOf(
    FirmwareUpdateError,
  );
  const original = structuredClone(f.stored.records[0]);
  await expect(f.controller.reviewRecovery(r.id, 'right', other)).rejects.toThrow('workspace');
  const recovery = await f.controller.reviewRecovery(r.id, 'right', ui);
  expect(recovery.id).not.toBe(r.id);
  const result = await f.controller.apply(recovery.id, ui, { confirm: true });
  expect(result).toMatchObject({ phase: 'complete', sourceRecordId: r.id });
  expect(result.roles[0].steps[0]).toMatchObject({ state: 'skipped', attempted: false });
  expect(f.stored.records[0]).toEqual(original);
  expect(f.audit.entries).toEqual(['right']);
});

it('does not mistake exit43 or a different normal-mode device for successful reconnect', async () => {
  const f = await fixture(),
    r = await f.controller.review('left', actor);
  f.faults.wrongRuntime = 'left';
  await expect(f.controller.apply(r.id, actor, { confirm: true })).rejects.toMatchObject({
    result: { phase: 'partial' },
  });
  const role = f.stored.records[0].roles[0];
  expect(role.stream?.streamComplete).toBe(true);
  expect(role.steps[3]).toMatchObject({ state: 'verified', attempted: true });
  expect(role.steps[4]).toMatchObject({ state: 'rejected', attempted: false });
  expect(role.after).toBeUndefined();
});

it('reports changed known preservation images without automatic settings restore or rollback', async () => {
  const f = await fixture(),
    r = await f.controller.review('left', actor);
  f.faults.changedPreservation = 'left';
  await expect(f.controller.apply(r.id, actor, { confirm: true })).rejects.toMatchObject({
    result: { phase: 'partial' },
  });
  expect(f.stored.records[0].roles[0].after).toMatchObject({
    preservation: 'changed',
    changedImages: ['flash-139264'],
  });
  expect(f.panels.left.requests).toHaveLength(0);
  expect(f.audit.entries).toHaveLength(1);
});

it('holds global family/re-enumeration exclusivity across coordinator instances', async () => {
  const f = await fixture(),
    g = await fixture(),
    r = await f.controller.review('left', actor),
    s = await g.controller.review('right', actor);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
  f.loaders.left.beforeExchange = async () => {
    entered();
    await gate;
  };
  const active = f.controller.apply(r.id, actor, { confirm: true });
  await ready;
  await expect(g.controller.apply(s.id, actor, { confirm: true })).rejects.toThrow(
    'already active',
  );
  expect(g.audit.entries).toHaveLength(0);
  release();
  await active;
});

it('honors cancellation during the last durable entry intent with zero transition or program setters', async () => {
  const f = await fixture(),
    stop = new AbortController(),
    ctx = { ...actor, signal: stop.signal },
    review = await f.controller.review('both', ctx);
  f.afterWrite = (value) => {
    if (value.records[0].roles[0].steps[0].state === 'intent') stop.abort();
  };
  await expect(f.controller.apply(review.id, ctx, { confirm: true })).rejects.toMatchObject({
    result: { phase: 'cancelled' },
  });
  expect(f.audit.entries).toHaveLength(0);
  expect(f.loaders.left.requests.length + f.loaders.right.requests.length).toBe(0);
  expect(f.stored.records[0].roles.flatMap((r) => r.steps).every((s) => !s.attempted)).toBe(true);
});

it('exports actual attempted outcomes when the journal fails after streaming instead of returning an older intent', async () => {
  const f = await fixture(),
    review = await f.controller.review('left', actor);
  f.loaders.left.afterWire = () => {
    f.failWrite = () => true;
  };
  let failure: FirmwareUpdateError | undefined;
  try {
    await f.controller.apply(review.id, actor, { confirm: true });
  } catch (error) {
    failure = error as FirmwareUpdateError;
  }
  expect(failure).toMatchObject({ persistence: 'unavailable', result: { phase: 'partial' } });
  const exported = f.controller.exportRecord(review.id, ui);
  expect(exported.exportPersistence).toBe('unavailable');
  expect(exported.roles[0].stream!.acceptedPackets).toBeGreaterThan(0);
  expect(exported.roles[0].stream).toEqual(failure!.result!.roles[0].stream);
  expect(f.controller.status(actor).latestOutcome?.persistence).toBe('unavailable');
  expect(() => f.controller.exportRecord(review.id, other)).toThrow('workspace');
  const sent = f.loaders.left.requests.length;
  await expect(f.controller.apply(review.id, ui, { confirm: true })).rejects.toThrow('Consumed');
  expect(f.loaders.left.requests).toHaveLength(sent);
});

// Four consumed records retain independent, full-size originals and verified CAS
// history; the larger timeout covers hashing work rather than a transport wait.
it('resolves an interrupted recovery family only after a later complete recovery, keeping all earlier receipts exact', async () => {
  const f = await fixture(),
    first = await f.controller.review('left', actor);
  f.loaders.left.fault = { at: 0, kind: 'lost-ack' };
  await expect(f.controller.apply(first.id, actor, { confirm: true })).rejects.toThrow();
  const original = structuredClone(f.stored.records[0]);
  const second = await f.controller.reviewRecovery(first.id, 'left', ui);
  f.loaders.left.fault = { at: f.loaders.left.requests.length, kind: 'lost-ack' };
  await expect(f.controller.apply(second.id, ui, { confirm: true })).rejects.toThrow();
  const failedRecovery = structuredClone(f.stored.records[1]);
  const third = await f.controller.reviewRecovery(second.id, 'left', ui);
  expect((await f.controller.apply(third.id, ui, { confirm: true })).phase).toBe('complete');
  expect(f.stored.records[0]).toEqual(original);
  expect(f.stored.records[1]).toEqual(failedRecovery);
  const next = await f.controller.review('left', ui);
  expect((await f.controller.apply(next.id, ui, { confirm: true })).phase).toBe('complete');
  const requests = f.loaders.left.requests.length;
  await expect(f.controller.apply(first.id, ui, { confirm: true })).rejects.toThrow('Consumed');
  expect(f.loaders.left.requests).toHaveLength(requests);
}, 30_000);
