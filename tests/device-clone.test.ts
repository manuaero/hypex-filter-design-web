import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createDeviceCloneController,
  deviceCloneSnapshotPage,
  DeviceCloneError,
} from '../src/application/device-clone';
import {
  assertDeviceCloneWrite,
  parseDeviceCloneEnvelope,
  type CloneJournalEnvelope,
  type DeviceCloneStorage,
} from '../src/application/device-clone-storage';
import { newProject, type Slot } from '../src/domain/model';
import type { NativeCloneTemplate } from '../src/domain/clone-template';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { decodeStatus, encodeEq, packet, hex, unhex } from '../src/hardware/codec';
import type { Transport } from '../src/hardware/transport';

afterEach(() => vi.useRealTimers());
const actor = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'manual:clone' },
  ui = { ...actor, scope: 'ui:clone' },
  foreign = { owner: 'workspace:22222222-2222-4222-8222-222222222222', scope: 'ui:other' };
const setters = (p: SimulatedPanel) =>
  p.requests.filter(
    (r) =>
      r[0] === 0x64 || ((r[0] === 5 || r[0] === 3) && r[1] === 0) || (r[0] === 0x66 && r[1] === 1),
  );
function template(selectedPreset: number): NativeCloneTemplate {
  return {
    version: 1,
    provenance: { kind: 'hfd-project', sourceSerial: 'SOURCE-IS-NOT-DESTINATION' },
    configuration: {
      valid: true,
      hypexName: 'Template',
      oemName: 'Template OEM',
      serialNumber: 'TEMPLATE',
      amplifier: 5,
      thirdChannelEnabled: true,
      fanConnected: true,
      mixerEnabled: false,
      moduleType: 9,
      detectedHardware: 22,
      temperatureSetpoint: 65,
      dspPeakSetpoint: 4096,
      mixer: Array.from({ length: 3 }, () => [1, 0, 0, 1, 0, 0]),
      limiter: Array.from({ length: 3 }, () => ({
        threshold: 2,
        attack: 0.97,
        release: 0.99995,
        ohms: 4,
        watts: 100,
      })),
    },
    device: {
      product: 22,
      version: 5,
      build: 1,
      bootloaderMode: false,
      dspFilename: 'Captured old DSP name',
      bundleVersion: '5.7',
      unitBehaviour: 0,
      digitalInputPresent: true,
      testFirmware: false,
      subSetup: 0,
      presetCount: 3,
      channelCount: 3,
      bootloaderVersion: 1,
    },
    settings: {
      activeInput: 1,
      forcedInput: 1,
      actualVolume: -8,
      passwordProtected: false,
      digitalChannelSelect: 2,
      mfbEnabled: false,
      presets: Array.from({ length: 3 }, (_, i) => ({
        forceInput: i ? 4 : 5,
        volumeOffset: -i,
        adcDigitalOut: false,
        sourceLock: false,
        volumeLock: false,
        eqEnabled: i === 1,
        application: 0,
        inputFir: { loaded: false, filename: '', enabled: false },
        outputFirs: Array.from({ length: 3 }, () => ({
          loaded: false,
          filename: '',
          enabled: false,
        })),
      })),
      startupVolume: -32,
      standbyMode: 0,
      gainCorrection12: 1,
      gainCorrection3: 1,
      protectionMask: 65535,
      detectionOn: 1,
      detectionOff: 2,
      oledBrightness: 0xc5,
      systemSetup: 0,
      selectedPreset,
      muted: false,
      options: 9,
      advancedOptions: 1,
      powerOffTime: 15,
      routing: [0, 1, 2, 3, 4, 5],
      bundleBcdMajor: 5,
      bundleBcdMinor: 7,
      controlBundleVersion: '5.7',
    },
    eqBanks: Array.from({ length: 3 }, (_, p) =>
      Array.from({ length: 9 }, (_, i) => ({
        filterType: 0,
        enabled: i === 0,
        frequency: 500 + p * 100 + i * 10,
        q: 0.7,
        gain: p + 1,
      })),
    ),
  };
}
async function fixture() {
  const panels = {
      left: new SimulatedPanel('CLONE-LEFT'),
      right: new SimulatedPanel('CLONE-RIGHT'),
    },
    sessions = {} as Record<Slot, PanelSession>,
    bindings = {} as Record<
      Slot,
      { session: PanelSession; identity: NonNullable<PanelSession['identity']> }
    >,
    projects = { left: newProject('Left native clone'), right: newProject('Right native clone') },
    revisions = { left: 7, right: 13 },
    intercept: Partial<
      Record<Slot, (r: Uint8Array, send: () => Promise<Uint8Array>) => Promise<Uint8Array>>
    > = {};
  for (const slot of ['left', 'right'] as const) {
    const p = panels[slot];
    p.deviceConfiguration[11] = 9;
    p.status[6] = 3;
    p.status[2] = 1;
    p.status[24] = 0x91;
    p.status[25] = 0x3f;
    projects[slot].hfdCloneTemplate = template(slot === 'left' ? 2 : 3);
    projects[slot].presets[0].channels[0].filters[0] = {
      ...projects[slot].presets[0].channels[0].filters[0],
      kind: 'peak',
      enabled: true,
      frequency: slot === 'left' ? 1234 : 2345,
      gain: slot === 'left' ? 3 : -4,
    };
    const transport: Transport = {
      exchange: (r) => intercept[slot]?.(r, () => p.exchange(r)) ?? p.exchange(r),
      close: () => p.close(),
    };
    sessions[slot] = new PanelSession(transport, async () => {
      throw new Error('Clone must use its verified dedicated recovery journal');
    });
    bindings[slot] = { session: sessions[slot], identity: await sessions[slot].identify() };
    p.requests.length = 0;
  }
  let stored: CloneJournalEnvelope = { version: 1, revision: 0, records: [] },
    afterWrite: ((value: CloneJournalEnvelope) => void | Promise<void>) | undefined,
    failWrite: ((value: CloneJournalEnvelope) => boolean) | undefined;
  const storage: DeviceCloneStorage = {
    read: async () => structuredClone(stored),
    compareAndSwap: async (revision, value) => {
      if (failWrite?.(value)) throw new Error('Synthetic durable storage failure');
      assertDeviceCloneWrite(stored, revision, value);
      stored = parseDeviceCloneEnvelope(value);
      await afterWrite?.(structuredClone(stored));
    },
  };
  const locks: string[] = [],
    options = {
      binding: (slot: Slot) => bindings[slot],
      design: (slot: Slot) => ({
        project: projects[slot],
        documentRevision: revisions[slot],
        templateRevision: 2,
      }),
      operate: async <T>(_label: string, work: () => Promise<T>) => work(),
      storage,
      withLock: async <T>(name: string, work: () => Promise<T>) => {
        locks.push(name);
        try {
          return await work();
        } finally {
          locks.pop();
        }
      },
    },
    controller = createDeviceCloneController(options);
  await controller.hydrate(actor);
  return {
    panels,
    sessions,
    bindings,
    projects,
    revisions,
    intercept,
    controller,
    options,
    locks,
    get stored() {
      return stored;
    },
    set afterWrite(fn: typeof afterWrite) {
      afterWrite = fn;
    },
    set failWrite(fn: typeof failWrite) {
      failWrite = fn;
    },
    review: (target: Slot | 'both' = 'both', ctx = actor) =>
      controller.review(target, ctx, { expectedRevision: controller.status(ctx).revision }),
  };
}
async function finish<T>(operation: Promise<T>) {
  let done = false;
  const settled = operation.then(
    (value) => {
      done = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      done = true;
      return { ok: false as const, error };
    },
  );
  for (let n = 0; !done && n < 5000; n++) {
    await vi.runAllTimersAsync();
    await yieldEventLoop();
  }
  if (!done) throw new Error('Clone simulator operation did not settle');
  const r = await settled;
  if (!r.ok) throw r.error;
  return r.value;
}

function sourceCapture(f: Awaited<ReturnType<typeof fixture>>, slot: Slot) {
  const panel = f.panels[slot],
    serial = slot === 'left' ? 'H05U000001-SYNTHETIC' : 'H05U000002-SYNTHETIC';
  panel.eeprom.fill(0, 0x100, 0x160);
  panel.eeprom.set(new TextEncoder().encode(serial), 0x100);
  panel.eeprom.set(new TextEncoder().encode(`Hypex ${slot}`), 0x120);
  panel.eeprom.set(new TextEncoder().encode(`OEM ${slot}`), 0x140);
  f.bindings[slot].identity.serial = serial;
  panel.configuration[5] = 3;
  panel.configuration[12] = 3;
  panel.status[51] = 2;
  for (let p = 0; p < 3; p++)
    panel.memory.set(
      encodeEq(
        f.projects[slot].presets[p].inputEq.map((band, i) => ({
          ...band,
          enabled: i === 0,
          frequency: 777 + p,
          gain: 2 + p,
        })),
      ),
      0x25000 + p * 4096,
    );
  const mixer = packet(0x67, 0);
  new DataView(mixer.buffer).setInt16(2, 320, true);
  f.intercept[slot] = async (r, send) => (r[0] === 0x67 && r[1] === 0 ? mixer.slice() : send());
}

it('reloads locked sources into one atomic metadata callback and preserves every staged design', async () => {
  const f = await fixture();
  f.revisions.right = f.revisions.left;
  sourceCapture(f, 'left');
  sourceCapture(f, 'right');
  const before = structuredClone(f.projects),
    replace = vi.fn(
      (entries: readonly { slot: Slot; template: NativeCloneTemplate }[], expected: number) => {
        expect(expected).toBe(7);
        expect(f.revisions.left).toBe(expected);
        expect(f.revisions.right).toBe(expected);
        for (const entry of entries)
          f.projects[entry.slot] = {
            ...f.projects[entry.slot],
            hfdCloneTemplate: structuredClone(entry.template),
          };
        f.revisions.left++;
        f.revisions.right++;
      },
    ),
    controller = createDeviceCloneController({ ...f.options, replaceTemplates: replace });
  await controller.hydrate(actor);
  const result = await controller.reload('both', ui);
  expect(result.busy).toBe(false);
  expect(replace).toHaveBeenCalledTimes(1);
  for (const slot of ['left', 'right'] as const) {
    expect(f.projects[slot].presets).toEqual(before[slot].presets);
    expect(f.projects[slot].hfdCloneTemplate).toMatchObject({
      provenance: { kind: 'device-capture' },
      configuration: {
        valid: true,
        hypexName: `Hypex ${slot}`,
        oemName: `OEM ${slot}`,
        mixer: [
          [1.25, 0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0, 0],
        ],
      },
      settings: { passwordProtected: true },
    });
    expect(f.projects[slot].hfdCloneTemplate!.eqBanks[0][0]).toMatchObject({
      frequency: 777,
      gain: 2,
    });
    expect(f.projects[slot].presets[0].inputEq[0].gain).toBe(0);
    expect(setters(f.panels[slot])).toHaveLength(0);
  }
  expect(f.stored.records).toHaveLength(0);
});

it('does not replace either metadata record when one capture fails or a document changes during read', async () => {
  const f = await fixture();
  f.revisions.right = f.revisions.left;
  sourceCapture(f, 'left');
  sourceCapture(f, 'right');
  const replace = vi.fn(),
    controller = createDeviceCloneController({ ...f.options, replaceTemplates: replace });
  await controller.hydrate(actor);
  const before = structuredClone(f.projects);
  f.panels.right.configuration[12] = 0;
  await expect(controller.reload('both', actor)).rejects.toThrow('counts');
  expect(replace).not.toHaveBeenCalled();
  expect(f.projects).toEqual(before);
  f.panels.right.configuration[12] = 3;
  const intercept = f.intercept.left!;
  f.intercept.left = async (r, send) => {
    const reply = await intercept(r, send);
    if (r[0] === 0x67) f.revisions.left++;
    return reply;
  };
  await expect(controller.reload('both', actor)).rejects.toThrow('design changed');
  expect(replace).not.toHaveBeenCalled();
  expect(f.projects).toEqual(before);
  for (const p of Object.values(f.panels)) expect(setters(p)).toHaveLength(0);
});

it('reads native product names independently from the DSP filename without setters', async () => {
  const f = await fixture();
  f.panels.left.eeprom.set(new TextEncoder().encode('Native Hypex module'), 0x120);
  f.panels.left.eeprom.set(new TextEncoder().encode('OEM display alias'), 0x140);
  const overview = await f.sessions.left.hardwareOverview();
  expect(overview.identity.name).toBe('Simulator');
  expect(overview.productNames).toEqual({
    hypexName: 'Native Hypex module',
    oemName: 'OEM display alias',
    source: 'eeprom-0x120-0x140',
    encoding: 'native-printable-byte',
  });
  expect(setters(f.panels.left)).toHaveLength(0);
});

it('rejects a non-Clone setter before transport and clears its scoped observer after failure', async () => {
  const f = await fixture(),
    before = f.panels.left.requests.length,
    beforeRequest = vi.fn(async () => {}),
    beforeExchange = vi.fn();
  await expect(
    f.sessions.left.exclusive(() =>
      f.sessions.left.withCloneMutationScopeInternal({ beforeRequest, beforeExchange }, () =>
        f.sessions.left.ack(packet(4, 2, 0)),
      ),
    ),
  ).rejects.toMatchObject({ attempted: false, message: 'Unsupported setter in Clone scope' });
  expect(f.panels.left.requests.length).toBe(before);
  expect(beforeRequest).not.toHaveBeenCalled();
  expect(beforeExchange).not.toHaveBeenCalled();
  await f.sessions.left.status();
  expect(f.panels.left.requests.length).toBe(before + 1);
  expect(beforeRequest).not.toHaveBeenCalled();
});

it('bounds history pages and strips every executable and recovery byte field', async () => {
  const f = await fixture(),
    snapshot = f.controller.status(actor),
    records = Array.from({ length: 23 }, (_, i) => ({
      id: String(i),
      phase: 'complete',
      roles: [],
      target: 'left',
      documentRevision: i,
    }));
  const page = deviceCloneSnapshotPage(
    { ...snapshot, records: records as unknown as typeof snapshot.records },
    10,
    10,
  );
  expect(page).toMatchObject({ offset: 10, totalRecords: 23, nextOffset: 20 });
  expect(page.records.map((r) => r.id)).toEqual(records.slice(10, 20).map((r) => r.id));
  expect(
    deviceCloneSnapshotPage(
      { ...snapshot, records: records as unknown as typeof snapshot.records },
      20,
      10,
    ).nextOffset,
  ).toBeNull();
  expect(() => deviceCloneSnapshotPage(snapshot, 0, 51)).toThrow('page');
});

it('reviews immutable complete originals without setters, keeps metadata bounded, and status has zero I/O', async () => {
  const f = await fixture(),
    original = structuredClone(f.projects);
  f.projects.left.hfdCloneTemplate!.settings.presets[0].volumeOffset = 1.125;
  original.left.hfdCloneTemplate!.settings.presets[0].volumeOffset = 1.125;
  const review = await f.review();
  expect(review.roles.map((r) => [r.slot, r.documentRevision])).toEqual([
    ['left', 7],
    ['right', 13],
  ]);
  expect(f.projects).toEqual(original);
  expect(review.roles[0].before).toMatchObject({
    dspName: 'Simulator',
    muted: false,
    channelMutes: [true, true, false],
  });
  expect(review.roles[0].after).toMatchObject({
    dspName: 'Left native clone',
    volume: -96,
    muted: true,
    preset: 2,
    hardware: { moduleType: 9, fanConnected: true },
    settings: { presetOffsets: [1.13, -1, -2] },
  });
  expect(review.roles[0].after.presets.map((p) => p.eqEnabled)).toEqual([false, true, false]);
  expect(review.roles[0].after.eqBanks[0].bands![0]).toMatchObject({ frequency: 500, gain: 1 });
  expect(review.roles[0].after.limiter[0]).toMatchObject({ watts: 100, ohms: 4, threshold: 2 });
  expect(Object.isFrozen(review.roles[0].after.settings)).toBe(true);
  expect(f.stored.records).toHaveLength(0);
  for (const p of Object.values(f.panels)) expect(setters(p)).toHaveLength(0);
  const requests = f.panels.left.requests.length + f.panels.right.requests.length;
  const page = deviceCloneSnapshotPage(f.controller.status(ui));
  expect(JSON.stringify(page)).not.toMatch(/statusHex|requestHex|sector_hex/);
  expect(page.activeReview!.roles[0].templateProvenance).toEqual({
    kind: 'hfd-project',
    sourceSerial: 'SOURCE-IS-NOT-DESTINATION',
    capturedAt: undefined,
  });
  expect(JSON.stringify(page).length).toBeLessThan(32000);
  expect(f.panels.left.requests.length + f.panels.right.requests.length).toBe(requests);
  expect(() => f.controller.status(foreign)).toThrow('workspace');
}, 30000);

it('durably backs up BOTH complete independent images before first mute, verifies all phases, and replays with zero I/O', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = await fixture(),
    originals = { left: f.panels.left.memory.slice(), right: f.panels.right.memory.slice() };
  f.projects.left.presets[0].inputFir = {
    name: 'Input loaded bypassed.txt',
    enabled: false,
    taps: Array.from({ length: 4500 }, (_, i) => (i === 0 ? 0.125 : i === 4499 ? 0.25 : 0)),
  };
  f.projects.right.presets[0].firPlacement = 'output';
  f.projects.right.presets[0].channels[0].fir = {
    name: 'Output active.txt',
    enabled: true,
    taps: Array.from({ length: 1500 }, (_, i) => (i === 0 ? 0.5 : i === 1499 ? 0.25 : 0)),
  };
  const review = await f.review();
  for (const slot of ['left', 'right'] as const) {
    let staging = false;
    f.intercept[slot] = async (r, send) => {
      if (staging) expect(r[0] === 0x64 && [1, 2].includes(r[1])).toBe(true);
      if (r[0] === 0x64 && r[1] === 0) staging = true;
      if (r[0] === 0x64 && r[1] === 2) staging = false;
      if (r[0] === 5 && r[1] === 0) {
        expect(f.sessions.left.busy && f.sessions.right.busy).toBe(true);
        expect(f.locks).toEqual(['fusion-studio-device-clone']);
        expect(f.stored.records[0].roles).toHaveLength(2);
        for (const role of f.stored.records[0].roles) {
          expect(role.before.flash).toHaveLength(24);
          expect(role.before.filenames).toHaveLength(12);
          expect(role.before.flash[0].hex).toBe(hex(originals[role.slot].slice(0x10000, 0x11000)));
        }
      }
      return send();
    };
  }
  const result = await finish(f.controller.apply(review.id, ui, { confirm: true }));
  expect(result.phase).toBe('complete');
  expect(f.controller.status(actor).latestOutcome).toEqual({
    record: result,
    persistence: 'verified',
  });
  for (const role of result.roles) {
    const p = f.panels[role.slot];
    expect(role.steps.filter((s) => s.state === 'verified')).toHaveLength(11);
    expect(role.steps[1]).toMatchObject({ state: 'skipped', attempted: false });
    for (const sector of role.desired.flash)
      expect(hex(p.memory.slice(sector.address, sector.address + 4096))).toBe(sector.hex);
    expect(p.eqReloads).toBe(1);
    expect(p.passwordWrites + p.emailWrites + p.oemMaskUpdates).toBe(0);
    expect(p.name).toBe(f.projects[role.slot].name);
    expect(decodeStatus(p.status)).toMatchObject({
      muted: true,
      volume: -96,
      preset: role.slot === 'left' ? 2 : 3,
    });
    expect(p.status[6]).toBe(128);
    expect(p.status[24]).toBe(0x91);
    expect(p.status[25]).toBe(0x3f);
    expect(p.status[12] & 16).toBe(0);
    expect(p.status[13] & 16).toBe(16);
  }
  expect(result.roles[0].desired.flash).not.toEqual(result.roles[1].desired.flash);
  const requests = f.panels.left.requests.length + f.panels.right.requests.length;
  expect(await f.controller.apply(review.id, actor, { confirm: true })).toEqual(result);
  expect(f.panels.left.requests.length + f.panels.right.requests.length).toBe(requests);
}, 30000);

it('retains actual attempted state in an explicitly nondurable error result when journal storage fails after a setter ACK', async () => {
  const f = await fixture(),
    review = await f.review('left');
  f.failWrite = (value) => value.records[0].roles[0].steps[0].attempted;
  let failure: DeviceCloneError | undefined;
  try {
    await f.controller.apply(review.id, actor, { confirm: true });
  } catch (e) {
    failure = e as DeviceCloneError;
  }
  expect(setters(f.panels.left)).toHaveLength(1);
  expect(failure!.persistence).toBe('unavailable');
  expect(failure!.result!.roles[0].steps[0]).toMatchObject({
    attempted: true,
    state: 'unconfirmed',
  });
  expect(failure!.result!.phase).toBe('partial');
  expect(f.stored.records[0].roles[0].steps[0]).toMatchObject({ attempted: false, state: 'ready' });
  expect(f.controller.status(ui).latestOutcome).toEqual({
    record: failure!.result,
    persistence: 'unavailable',
  });
  const page = deviceCloneSnapshotPage(f.controller.status(ui));
  expect(page.latestOutcome).toMatchObject({
    persistence: 'unavailable',
    record: { id: review.id, phase: 'partial' },
  });
  expect(JSON.stringify(page.latestOutcome)).not.toMatch(
    /statusHex|requestHex|serialHex|deviceConfigurationHex|"before"|"desired"/,
  );
  expect(f.stored.records[0].phase).toBe('running');
  const exported = f.controller.exportRecord(review.id, ui),
    { exportPersistence, ...record } = exported;
  expect(exportPersistence).toBe('unavailable');
  expect(record).toEqual(failure!.result);
  await f.controller.hydrate(actor);
  expect(f.controller.exportRecord(review.id, actor)).toEqual(exported);
  expect(() => f.controller.exportRecord(review.id, foreign)).toThrow('workspace');
  f.options.storage.read = async () => ({ version: 1, revision: 0, records: [] });
  await f.controller.hydrate(actor);
  expect(f.controller.exportRecord(review.id, ui)).toEqual(exported);
  const nextReview = await f.review('left');
  await expect(f.controller.apply(nextReview.id, ui, { confirm: true })).rejects.toThrow(
    'unfinished',
  );
  expect(setters(f.panels.left)).toHaveLength(1);
});

it('refuses duplicate identity, unsupported module and a locked second target before any setters', async () => {
  const f = await fixture();
  f.bindings.right.identity.serial = f.bindings.left.identity.serial;
  await expect(f.review()).rejects.toThrow('distinct');
  f.bindings.right.identity.serial = 'CLONE-RIGHT';
  f.panels.right.deviceConfiguration[11] = 1;
  await expect(f.review()).rejects.toThrow('module9');
  f.panels.right.deviceConfiguration[11] = 9;
  f.panels.right.status[51] = 2;
  await expect(f.review()).rejects.toThrow('unlocked');
  for (const p of Object.values(f.panels)) expect(setters(p)).toHaveLength(0);
});

it('holds every reservation until other read-only preparation finishes after one role fails', async () => {
  const f = await fixture();
  f.panels.right.status[51] = 2;
  let release!: () => void,
    entered!: () => void,
    held = false;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  f.intercept.left = async (request, send) => {
    if (!held && request[0] === 6) {
      held = true;
      entered();
      await gate;
    }
    return send();
  };
  let settled = false;
  const operation = f.review().finally(() => {
    settled = true;
  });
  void operation.catch(() => {});
  await started;
  await yieldEventLoop();
  expect(settled).toBe(false);
  expect(f.sessions.left.busy && f.sessions.right.busy).toBe(true);
  release();
  await expect(operation).rejects.toThrow('unlocked');
  expect(f.sessions.left.busy || f.sessions.right.busy).toBe(false);
  for (const p of Object.values(f.panels)) expect(setters(p)).toHaveLength(0);
});

it('fences design replacement and invalid late filter input without any setter', async () => {
  const f = await fixture(),
    review = await f.review();
  f.revisions.left++;
  await expect(f.controller.apply(review.id, actor, { confirm: true })).rejects.toThrow(
    'design changed',
  );
  expect(f.stored.records).toHaveLength(0);
  f.projects.left.presets[2].channels[2].filters[14].frequency = Number.NaN;
  await expect(f.review()).rejects.toThrow();
  for (const p of Object.values(f.panels)) expect(setters(p)).toHaveLength(0);
});

it.each(['prepared', 'running', 'ready'] as const)(
  'fresh all-target mute barrier refuses a late Right lock after %s durability with zero setters',
  async (at) => {
    const f = await fixture(),
      review = await f.review();
    let changed = false;
    f.afterWrite = (value) => {
      const r = value.records[0];
      if (!changed && (at === 'ready' ? r.roles[1].steps[0].state === 'ready' : r.phase === at)) {
        changed = true;
        f.panels.right.status[51] = 2;
      }
    };
    await expect(f.controller.apply(review.id, actor, { confirm: true })).rejects.toBeInstanceOf(
      DeviceCloneError,
    );
    expect(changed).toBe(true);
    for (const p of Object.values(f.panels)) expect(setters(p)).toHaveLength(0);
    expect(f.stored.records[0].phase).toBe('failed');
    expect(f.stored.records[0].roles.every((r) => r.steps.every((s) => !s.attempted))).toBe(true);
  },
);

it('refuses initial durable storage failure without setters or a false recovery receipt', async () => {
  const f = await fixture(),
    review = await f.review();
  f.failWrite = () => true;
  await expect(f.controller.apply(review.id, actor, { confirm: true })).rejects.toMatchObject({
    result: undefined,
  });
  expect(f.stored.records).toHaveLength(0);
  for (const p of Object.values(f.panels)) expect(setters(p)).toHaveLength(0);
});

it.each(['running-cas', 'last-fresh-read'] as const)(
  'honors abort during %s before first sender and classifies blocked phases truthfully',
  async (at) => {
    const f = await fixture(),
      abort = new AbortController(),
      ctx = { ...actor, signal: abort.signal },
      review = await f.review('both', ctx);
    if (at === 'running-cas')
      f.afterWrite = (v) => {
        if (v.records[0].phase === 'running') abort.abort();
      };
    else
      f.intercept.right = async (r, send) => {
        const reply = await send();
        if (r[0] === 5 && r[1] === 1 && f.stored.records[0]?.roles[1].steps[0].state === 'ready')
          abort.abort();
        return reply;
      };
    await expect(f.controller.apply(review.id, ctx, { confirm: true })).rejects.toBeInstanceOf(
      DeviceCloneError,
    );
    for (const p of Object.values(f.panels)) expect(setters(p)).toHaveLength(0);
    expect(f.stored.records[0].roles.every((r) => !r.steps[0].attempted)).toBe(true);
  },
);

it('does not retry a lost first setter ACK, records actual uncertainty, and replays failure without I/O', async () => {
  const f = await fixture(),
    review = await f.review();
  let lost = false;
  f.intercept.left = async (r, send) => {
    const reply = await send();
    if (!lost && r[0] === 5 && r[1] === 0) {
      lost = true;
      throw new Error('Synthetic lost ACK');
    }
    return reply;
  };
  let failure: DeviceCloneError | undefined;
  try {
    await f.controller.apply(review.id, actor, { confirm: true });
  } catch (e) {
    failure = e as DeviceCloneError;
  }
  expect(failure!.result!.phase).toBe('partial');
  expect(failure!.result!.roles[0].steps[0]).toMatchObject({
    id: 'mute',
    attempted: true,
    state: 'unconfirmed',
  });
  expect(setters(f.panels.left)).toHaveLength(1);
  expect(f.panels.left.eqReloads + f.panels.right.eqReloads).toBe(0);
  const requests = f.panels.left.requests.length + f.panels.right.requests.length;
  await expect(f.controller.apply(review.id, ui, { confirm: true })).rejects.toThrow('consumed');
  expect(f.panels.left.requests.length + f.panels.right.requests.length).toBe(requests);
}, 30000);

it('finishes bounded verification after the first sender despite later abort, and never auto-unmutes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = await fixture(),
    abort = new AbortController(),
    ctx = { ...actor, signal: abort.signal },
    review = await f.review('both', ctx);
  let started = false;
  f.intercept.left = async (r, send) => {
    if (!started && r[0] === 5 && r[1] === 0) {
      started = true;
      abort.abort();
    }
    return send();
  };
  const result = await finish(f.controller.apply(review.id, ctx, { confirm: true }));
  expect(result.phase).toBe('complete');
  for (const p of Object.values(f.panels))
    expect(
      setters(p)
        .filter((r) => r[0] === 5)
        .every((r) => !!(r[6] & 128)),
    ).toBe(true);
}, 30000);

it('publishes consumed MCP outcomes to shared UI state and clears them on same-identity session replacement and disposal', async () => {
  const f = await fixture(),
    review = await f.review('left');
  let lost = false;
  f.intercept.left = async (request, send) => {
    const reply = await send();
    if (!lost && request[0] === 5 && request[1] === 0) {
      lost = true;
      throw new Error('Synthetic lost mute ACK');
    }
    return reply;
  };
  await expect(f.controller.apply(review.id, actor, { confirm: true })).rejects.toBeInstanceOf(
    DeviceCloneError,
  );
  const latest = f.controller.status(ui).latestOutcome;
  expect(latest).toMatchObject({
    persistence: 'verified',
    record: { id: review.id, phase: 'partial' },
  });
  expect(latest!.record.roles[0].steps[0]).toMatchObject({ attempted: true, state: 'unconfirmed' });
  await f.controller.hydrate(ui);
  expect(f.controller.status(ui).latestOutcome).toBe(latest);
  expect(() => f.controller.status(foreign)).toThrow('workspace');
  const replacement = new PanelSession(f.panels.left, async () => {});
  f.bindings.left = { session: replacement, identity: { ...f.bindings.left.identity } };
  f.controller.refreshBindings();
  expect(f.controller.status(ui).latestOutcome).toBeUndefined();
  expect(f.controller.status(ui).records[0].id).toBe(review.id);
  f.controller.dispose();
  expect(f.controller.getSnapshot()).toMatchObject({
    busy: false,
    records: [],
    roles: { left: { connected: false }, right: { connected: false } },
  });
  expect(f.controller.getSnapshot().latestOutcome).toBeUndefined();
});

it('does not publish old role identity into a replacement connection after a late binding change', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = await fixture(),
    review = await f.review('left');
  f.intercept.left = async (r, send) => {
    const reply = await send();
    if (r[0] === 0x66 && r[1] === 1) {
      const replacement = new SimulatedPanel('REPLACEMENT');
      replacement.deviceConfiguration[11] = 9;
      const session = new PanelSession(replacement, async () => {});
      f.bindings.left = {
        session,
        identity: { ...f.bindings.left.identity, serial: 'REPLACEMENT' },
      };
    }
    return reply;
  };
  await expect(
    finish(f.controller.apply(review.id, actor, { confirm: true })),
  ).rejects.toMatchObject({ result: { phase: 'partial' } });
  f.controller.refreshBindings();
  expect(f.controller.status(actor).roles.left.identity!.serial).toBe('REPLACEMENT');
  expect(f.controller.status(actor).records[0].roles[0].identity.serial).toBe('CLONE-LEFT');
  expect(setters(f.panels.left).filter((r) => r[0] === 0x66)).toHaveLength(1);
}, 30000);
