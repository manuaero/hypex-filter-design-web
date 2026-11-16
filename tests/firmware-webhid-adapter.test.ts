import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFirmwareWebHidUpdateAdapter } from '../src/hardware/firmware-webhid-adapter';
import {
  createFirmwareUpdateCoordinator,
  type FirmwarePhysicalUpdatePort,
} from '../src/hardware/firmware-update';
import type {
  FirmwareQualifiedPhysicalProfile,
  FirmwarePhysicalReadbackProfile,
} from '../src/hardware/firmware-physical-profile';
import { createQualifiedPhysicalFirmwareChannel } from '../src/hardware/firmware-program';
import {
  assertFirmwareJournalWrite,
  firmwareSourceSha256,
  type FirmwareJournalBinding,
  type FirmwareJournalEnvelope,
  type FirmwareJournalStore,
} from '../src/application/firmware-update-storage';
import { WebHidTransport } from '../src/hardware/transport';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { hex, packet } from '../src/hardware/codec';
import { firmwarePacketAt, parseFirmwareBundle } from '../src/domain/firmware';

// Only this unit-test module supplies a synthetic profile via module mocking.
// No production issuer or installed physical profile is created by these tests.
const mocked = vi.hoisted(() => ({ profile: undefined as unknown, port: undefined as unknown }));
vi.mock('../src/hardware/firmware-physical-profile', async (original) => ({
  ...(await original<typeof import('../src/hardware/firmware-physical-profile')>()),
  lookupQualifiedFirmwarePhysicalProfile: () => mocked.profile,
  isQualifiedFirmwarePhysicalProfile: (value: unknown) => !!value && value === mocked.profile,
}));
vi.mock('../src/hardware/firmware-update', async (original) => {
  const actual = await original<typeof import('../src/hardware/firmware-update')>();
  return {
    ...actual,
    createGuardedPhysicalFirmwareUpdateAdapter: (port: FirmwarePhysicalUpdatePort) => {
      mocked.port = port;
      return actual.createGuardedPhysicalFirmwareUpdateAdapter(port);
    },
  };
});
const text = [
  ':10000080A80D0000CA080000465553494F4E3332B0',
  ':01000081027C',
  ':020000040000FA',
  ':10068000464133320000000000000000000000007E',
  ':00000001FF',
].join('\n');
const actor = {
  owner: 'workspace:11111111-1111-4111-8111-111111111111',
  scope: 'manual:firmware-adapter',
};
class FakeHid extends EventTarget {
  opened = false;
  requests: Uint8Array[] = [];
  failClose = false;
  beforeSend?: (request: Uint8Array) => void;
  constructor(
    readonly vendorId: number,
    readonly productId: number,
    readonly handler: (request: Uint8Array) => Promise<Uint8Array | undefined>,
  ) {
    super();
  }
  open = vi.fn(async () => {
    this.opened = true;
  });
  close = vi.fn(async () => {
    if (this.failClose) throw new Error('Synthetic close failure');
    this.opened = false;
  });
  emit(payload: Uint8Array) {
    const event = new Event('inputreport');
    Object.assign(event, {
      reportId: 0,
      data: new DataView(payload.buffer, payload.byteOffset, payload.byteLength),
    });
    this.dispatchEvent(event);
  }
  sendReport = vi.fn(async (_reportId: number, data: Uint8Array) => {
    const request = new Uint8Array(data);
    this.beforeSend?.(request);
    this.requests.push(request);
    const response = await this.handler(request);
    if (response) queueMicrotask(() => this.emit(response));
  });
  hid(): HIDDevice {
    return this as unknown as HIDDevice;
  }
}
function fixture(unit = 'SIM-FW-LEFT') {
  const panel = new SimulatedPanel(unit),
    hub = new EventTarget(),
    state = {
      current: true,
      attached: true,
      volatile: false,
      reads: 0,
      granted: [] as HIDDevice[],
      loseStream: false,
    };
  panel.configuration[2] = 5;
  panel.configuration[3] = 1;
  panel.configuration[5] = 3;
  panel.configuration[12] = 3;
  new DataView(panel.configuration.buffer).setUint16(15, 5, true);
  new DataView(panel.configuration.buffer).setUint16(17, 7, true);
  panel.deviceConfiguration[11] = 9;
  const binding: FirmwareJournalBinding = {
    assignmentId: `assignment:${unit}`,
    connectionId: `runtime:${unit}`,
    connectionEpoch: 1,
    serial: unit,
    hidSerial: `0303A:${unit}`,
    family: 'FUSION32',
    product: 22,
    core: '5.1',
    firmware: '5.7',
  };
  let afterExit: (() => void) | undefined;
  const runtime = new FakeHid(0x345e, 0x03e8, async (request) => {
    if (request[0] === 0x40) {
      runtime.emit(Uint8Array.of(6, ...Array(63).fill(0)));
      state.attached = false;
      runtime.opened = false;
      state.granted = [loader.hid()];
      return undefined;
    }
    const response = await panel.exchange(request);
    if (state.volatile && [3, 5, 6, 102].includes(request[0]))
      response[request[0] === 5 ? 60 : 63] = ++state.reads % 256;
    return response;
  });
  const post = new FakeHid(0x345e, 0x03e8, (request) => panel.exchange(request));
  const loader = new FakeHid(0x345e, 0x03e9, async (request) => {
    if (request[0] === 6) return Uint8Array.of(6, 18, 99, 1, 3, ...Array(59).fill(0));
    if (request[0] === 0x40 && state.loseStream) {
      const event = new Event('disconnect');
      Object.assign(event, { device: loader.hid() });
      hub.dispatchEvent(event);
      return undefined;
    }
    if (request[0] === 0x43) {
      panel.configuration[3] = 5;
      new DataView(panel.configuration.buffer).setUint16(17, 82, true);
      state.granted = [post.hid()];
      afterExit?.();
    }
    return Uint8Array.of(request[0], 0, ...Array(62).fill(0));
  });
  runtime.opened = true;
  const getDevices = vi.fn(async () => state.granted);
  Object.assign(hub, { getDevices });
  vi.stubGlobal('navigator', { hid: hub });
  const transport = new WebHidTransport(runtime.hid()),
    session = new PanelSession(transport, async () => {});
  const descriptor = {
    source: 'webusb-descriptor' as const,
    slot: 'left' as const,
    vendorId: 0x345e as const,
    productId: 0x03e8 as const,
    hidSerial: binding.hidSerial,
    family: 'FUSION32' as const,
    binding: { serial: unit, product: 22, core: '5.1', firmware: '5.7' },
  };
  const capture = vi.fn(() =>
      state.attached ? { binding, device: runtime.hid(), session, descriptor } : undefined,
    ),
    retired = vi.fn();
  let stored: FirmwareJournalEnvelope = { version: 1, revision: 0, records: [] },
    afterWrite: ((value: FirmwareJournalEnvelope) => void) | undefined;
  const journal: FirmwareJournalStore = {
    read: async () => structuredClone(stored),
    compareAndSwap: async (revision, next) => {
      assertFirmwareJournalWrite(stored, revision, next);
      stored = structuredClone(next);
      afterWrite?.(stored);
    },
  };
  const source = {
    stageId: 'source:1',
    name: 'Synthetic-FUSION32.hex',
    text,
    sha256: firmwareSourceSha256(text),
    family: 'FUSION32' as const,
    expectedAfter: { core: '5.5', firmware: '5.82', source: 'bundle-record-metadata' as const },
  };
  const masks = Object.fromEntries(
    [3, 5, 6, 102].map((command) => {
      const mask = Array(64).fill(255) as number[];
      mask[1] = 0;
      mask[63] = 0;
      if (command === 5) mask[60] = 0;
      if (command === 6) for (const i of [2, 3, 15, 16, 17, 18]) mask[i] = 0;
      return [command, mask];
    }),
  ) as unknown as FirmwarePhysicalReadbackProfile['reportMasks'];
  const before: FirmwarePhysicalReadbackProfile = {
    id: 'UNIT-TEST-ONLY-before',
    product: 22,
    core: '5.1',
    firmware: '5.7',
    amplifier: 5,
    moduleType: 9,
    channels: 3,
    presets: 3,
    reportMasks: masks,
    evidence: ['Mocked test profile, not physical source qualification'],
  };
  const profile = {
    id: 'UNIT-TEST-ONLY',
    family: 'FUSION32',
    sourceSha256s: [source.sha256],
    before,
    after: [{ ...before, id: 'UNIT-TEST-ONLY-after', core: '5.5', firmware: '5.82' }],
    loader: { vendorId: 0x345e, productId: 0x03e9, product: 18, build: 1, version: 3 },
    evidence: {
      sameUnitCorrelation: ['mock'],
      singleReplyAndLateDuplicates: ['mock'],
      preservation: ['mock'],
      recovery: ['mock'],
      runtimePermission: ['mock'],
    },
    assertRuntimeAccess: vi.fn(() => {}),
    correlateLoader: vi.fn(
      async (_binding: FirmwareJournalBinding, granted: readonly HIDDevice[]) =>
        granted
          .filter((device) => device === loader.hid())
          .map((device) => ({ device, serial: unit, hidSerial: `MOCK-LOADER:${unit}` })),
    ),
    correlateRuntime: vi.fn(
      async (_binding: FirmwareJournalBinding, granted: readonly HIDDevice[]) =>
        granted
          .filter((device) => device === post.hid())
          .map((device) => ({ device, serial: unit, hidSerial: binding.hidSerial })),
    ),
  } as unknown as FirmwareQualifiedPhysicalProfile;
  const adapter = createFirmwareWebHidUpdateAdapter({
    capture,
    isCurrent: () => state.current,
    assignedDevices: () => (state.attached ? [runtime.hid()] : []),
    onRuntimeRetired: retired,
    hid: hub as unknown as HID,
    discoveryTimeoutMs: 20,
    pollIntervalMs: 1,
  });
  const port = mocked.port as FirmwarePhysicalUpdatePort;
  const coordinator = createFirmwareUpdateCoordinator({
    adapter,
    source: () => source,
    binding: () => binding,
    assignmentId: () => (state.current ? binding.assignmentId : undefined),
    journal,
    withLock: async (_name, work) => work(),
    sleep: async () => {},
  });
  return {
    panel,
    hub,
    state,
    binding,
    source,
    profile,
    adapter,
    port,
    coordinator,
    runtime,
    loader,
    post,
    capture,
    retired,
    getDevices,
    transport,
    session,
    journal,
    stored: () => stored,
    onWrite: (fn: typeof afterWrite) => (afterWrite = fn),
    onExit: (fn: () => void) => (afterExit = fn),
  };
}
beforeEach(() => {
  mocked.profile = undefined;
  mocked.port = undefined;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('registers a real blocked physical route with cached history but zero discovery, reads, opens or writes', async () => {
  const f = fixture();
  await f.coordinator.hydrate(actor);
  expect(f.coordinator.availability('left')).toMatchObject({
    available: false,
    route: 'physical',
    qualified: false,
    qualifier: 'unqualified-physical',
  });
  expect(f.coordinator.status(actor).records).toEqual([]);
  await expect(f.coordinator.review('left', actor)).rejects.toThrow(/unqualified/);
  expect(f.getDevices).not.toHaveBeenCalled();
  expect(f.capture).not.toHaveBeenCalled();
  expect(f.runtime.requests).toEqual([]);
  expect(f.loader.open).not.toHaveBeenCalled();
  expect(f.retired).not.toHaveBeenCalled();
  await expect(f.coordinator.apply('unknown', actor, { confirm: true })).rejects.toThrow(
    /stale|consumed/,
  );
  expect(() => createQualifiedPhysicalFirmwareChannel({} as never, {} as never)).toThrow(
    /qualified/,
  );
});

it('refuses missing separately-qualified5.5 full readback and meaningless masks before any hardware access', () => {
  const f = fixture();
  mocked.profile = f.profile;
  const after = f.profile.after;
  (f.profile as { after: typeof after }).after = [];
  expect(f.coordinator.availability('left').available).toBe(false);
  (f.profile as { after: typeof after }).after = after;
  const mask = f.profile.before.reportMasks[5] as number[];
  mask.fill(0);
  expect(f.coordinator.availability('left').available).toBe(false);
  expect(f.capture).not.toHaveBeenCalled();
  expect(f.runtime.requests).toEqual([]);
});

it('guards metadata adoption by the private profile, then recovers a cold role through fresh loader correlation without another entry40', async () => {
  const f = fixture();
  mocked.profile = f.profile;
  f.state.loseStream = true;
  const first = await f.coordinator.review('left', actor);
  await expect(f.coordinator.apply(first.id, actor, { confirm: true })).rejects.toThrow();
  const original = structuredClone(f.stored().records[0]);
  f.state.current = false;
  f.state.loseStream = false;
  let cold: ReturnType<typeof createFirmwareUpdateCoordinator>;
  const prepareRecovery = vi.fn(
    (roles: readonly { slot: 'left' | 'right'; binding: FirmwareJournalBinding }[]) => {
      expect(roles).toEqual([{ slot: 'left', binding: original.roles[0].binding }]);
      f.state.current = true;
      cold.invalidateReview();
    },
  );
  cold = createFirmwareUpdateCoordinator({
    adapter: f.adapter,
    binding: () => undefined,
    source: () => undefined,
    assignmentId: () => (f.state.current ? f.binding.assignmentId : undefined),
    prepareRecovery,
    journal: f.journal,
    withLock: async (_name, work) => work(),
    sleep: async () => {},
  });
  await cold.hydrate(actor);
  const queries = f.getDevices.mock.calls.length,
    loaderRequests = f.loader.requests.length,
    entries = f.runtime.requests.filter((request) => request[0] === 0x40).length;
  mocked.profile = undefined;
  await expect(cold.reviewRecovery(first.id, 'left', actor)).rejects.toThrow(/unqualified/i);
  expect(prepareRecovery).not.toHaveBeenCalled();
  expect(f.getDevices).toHaveBeenCalledTimes(queries);
  expect(f.loader.requests).toHaveLength(loaderRequests);
  mocked.profile = f.profile;
  const review = await cold.reviewRecovery(first.id, 'left', actor);
  expect(prepareRecovery).toHaveBeenCalledOnce();
  const completed = await cold.apply(review.id, actor, { confirm: true });
  expect(completed.phase).toBe('complete');
  expect(completed.roles[0].steps[0]).toMatchObject({ state: 'skipped', attempted: false });
  expect(f.runtime.requests.filter((request) => request[0] === 0x40)).toHaveLength(entries);
  expect(f.stored().records[0]).toEqual(original);
  expect(f.profile.correlateLoader).toHaveBeenCalled();
});

it('uses actual WebHID queues through entry, original two passes, exit and separate43-image5.5 readback with physical journal qualifier', async () => {
  const f = fixture();
  mocked.profile = f.profile;
  let entryDurable = false;
  f.runtime.beforeSend = (request) => {
    if (request[0] === 0x40) {
      const record = f.stored().records[0];
      entryDurable =
        record.phase === 'running' &&
        record.roles[0].before.images.length === 43 &&
        record.roles[0].steps[0].state === 'intent';
    }
  };
  const review = await f.coordinator.review('left', actor);
  const result = await f.coordinator.apply(review.id, actor, { confirm: true });
  expect(entryDurable).toBe(true);
  expect(review.qualifier).toBe('qualified-physical');
  expect(result).toMatchObject({
    phase: 'complete',
    qualifier: 'qualified-physical',
    roles: [
      {
        before: {
          images: expect.arrayContaining([
            expect.objectContaining({ id: 'flash-65536' }),
            expect.objectContaining({ id: 'eeprom-256' }),
          ]),
        },
        stream: { wireRequests: 6, acceptedPackets: 6, streamComplete: true },
        after: {
          controlsDialect: 'unqualified',
          preservation: 'matched-known-ranges',
          binding: { core: '5.5', firmware: '5.82' },
        },
      },
    ],
  });
  expect(result.roles[0].before.images).toHaveLength(43);
  expect(f.runtime.requests.filter((request) => request[0] === 0x40)).toHaveLength(1);
  const stream = f.loader.requests.filter((request) => request[0] === 0x40),
    bundle = parseFirmwareBundle(text);
  expect(stream.map((request) => Array.from(request))).toEqual(
    ([0, 1] as const).flatMap((pass) =>
      [0, 1, 2].map((index) => Array.from(firmwarePacketAt(bundle, pass, index).payload)),
    ),
  );
  expect(f.loader.requests.filter((request) => request[0] === 0x43)).toHaveLength(1);
  expect(f.retired).toHaveBeenCalledExactlyOnceWith(f.binding);
  expect(f.loader.opened).toBe(false);
  expect(f.post.opened).toBe(false);
  await expect(f.transport.exchange(packet(6, 1))).rejects.toThrow(/retired|closed/);
  const before = f.runtime.requests.length + f.loader.requests.length + f.post.requests.length;
  expect(await f.coordinator.apply(review.id, actor, { confirm: true })).toEqual(result);
  expect(f.runtime.requests.length + f.loader.requests.length + f.post.requests.length).toBe(
    before,
  );
});

it('allows excluded padding/telemetry to vary while retaining original raw images through review/apply', async () => {
  const f = fixture();
  mocked.profile = f.profile;
  f.state.volatile = true;
  const review = await f.coordinator.review('left', actor);
  const result = await f.coordinator.apply(review.id, actor, { confirm: true });
  expect(result.phase).toBe('complete');
  expect(
    result.roles[0].before.images.find((image) => image.id === 'report-5')?.hex.slice(120, 122),
  ).not.toBe('00');
});

it.each(['lock', 'masked-settings', 'assignment'] as const)(
  'blocks a late %s change after durable backup with no entry send',
  async (change) => {
    const f = fixture();
    mocked.profile = f.profile;
    const review = await f.coordinator.review('left', actor);
    f.onWrite((value) => {
      if (value.records.at(-1)?.phase === 'running') {
        if (change === 'lock') {
          f.panel.status[51] = 2;
          f.panel.status[24] = 255;
          f.panel.status[25] = 255;
        } else if (change === 'masked-settings') f.panel.status[7] ^= 1;
        else f.state.current = false;
      }
    });
    await expect(f.coordinator.apply(review.id, actor, { confirm: true })).rejects.toMatchObject({
      result: { phase: 'failed' },
    });
    expect(f.runtime.requests.filter((request) => request[0] === 0x40)).toHaveLength(0);
    expect(f.retired).not.toHaveBeenCalled();
    expect(f.runtime.opened).toBe(true);
  },
);

it('cancels a fresh-read admission before entry without closing the borrowed ordinary runtime', async () => {
  const f = fixture();
  mocked.profile = f.profile;
  const review = await f.coordinator.review('left', actor),
    signal = new AbortController();
  f.runtime.beforeSend = (request) => {
    if (request[0] === 6) signal.abort();
  };
  await expect(
    f.coordinator.apply(review.id, { ...actor, signal: signal.signal }, { confirm: true }),
  ).rejects.toMatchObject({ result: undefined });
  expect(f.runtime.requests.filter((request) => request[0] === 0x40)).toHaveLength(0);
  expect(f.runtime.close).not.toHaveBeenCalled();
});

it('requires trusted same-unit correlation instead of substituting captured serial into an arbitrary major99 loader', async () => {
  const f = fixture();
  mocked.profile = f.profile;
  vi.mocked(f.profile.correlateLoader).mockImplementation(async (_binding, granted) =>
    granted.map((device) => ({ device, serial: 'SIM-OTHER-UNIT', hidSerial: 'MOCK-OTHER' })),
  );
  const review = await f.coordinator.review('left', actor);
  await expect(f.coordinator.apply(review.id, actor, { confirm: true })).rejects.toMatchObject({
    result: { phase: 'partial' },
  });
  expect(f.loader.open).not.toHaveBeenCalled();
  expect(f.loader.requests).toEqual([]);
});

it('refuses ambiguous loaders before opening or streaming either candidate', async () => {
  const f = fixture();
  mocked.profile = f.profile;
  vi.mocked(f.profile.correlateLoader).mockImplementation(async (_binding, granted) =>
    [0, 1].map(() => ({ device: granted[0], serial: f.binding.serial, hidSerial: 'MOCK' })),
  );
  const review = await f.coordinator.review('left', actor);
  await expect(f.coordinator.apply(review.id, actor, { confirm: true })).rejects.toMatchObject({
    result: { phase: 'partial' },
  });
  expect(f.loader.open).not.toHaveBeenCalled();
});

it('poisons a disconnected stream after one request and never retries or sends automatic cancel/restore', async () => {
  const f = fixture();
  mocked.profile = f.profile;
  f.state.loseStream = true;
  const review = await f.coordinator.review('left', actor);
  await expect(f.coordinator.apply(review.id, actor, { confirm: true })).rejects.toMatchObject({
    result: { phase: 'partial', roles: [{ stream: { wireRequests: 1, transportAttempts: 1 } }] },
  });
  expect(f.loader.requests.filter((request) => request[0] === 0x40)).toHaveLength(1);
  f.loader.emit(Uint8Array.of(0x40, 0, ...Array(62).fill(0)));
  expect(f.loader.requests.some((request) => [0x41, 0x43, 0x64].includes(request[0]))).toBe(false);
  await expect(f.coordinator.apply(review.id, actor, { confirm: true })).rejects.toThrow(
    /Consumed/,
  );
});

it('reports changed known memory as partial without silently restoring settings or bridge', async () => {
  const f = fixture();
  mocked.profile = f.profile;
  f.onExit(() => (f.panel.memory[0x22000] ^= 1));
  const review = await f.coordinator.review('left', actor);
  await expect(f.coordinator.apply(review.id, actor, { confirm: true })).rejects.toMatchObject({
    result: {
      phase: 'partial',
      roles: [{ after: { preservation: 'changed', changedImages: ['flash-139264'] } }],
    },
  });
  expect(
    [...f.runtime.requests, ...f.loader.requests, ...f.post.requests].some(
      (request) =>
        (request[0] === 5 && request[1] === 0) ||
        (request[0] === 102 && request[1] === 1) ||
        [0x41, 0x64].includes(request[0]),
    ),
  ).toBe(false);
});

it('attempts every owned loader close even when the first close fails, without touching an unrelated open interface', async () => {
  const left = fixture('SIM-CLOSE-LEFT'),
    right = fixture('SIM-CLOSE-RIGHT');
  mocked.profile = left.profile;
  const profile = left.profile;
  vi.mocked(profile.correlateLoader).mockImplementation(async (binding, granted) =>
    granted
      .filter(
        (device) =>
          device ===
          (binding.serial === left.binding.serial ? left.loader.hid() : right.loader.hid()),
      )
      .map((device) => ({ device, serial: binding.serial, hidSerial: `MOCK:${binding.serial}` })),
  );
  const getDevices = vi.fn(async () => [left.loader.hid(), right.loader.hid()]);
  createFirmwareWebHidUpdateAdapter({
    capture: () => undefined,
    isCurrent: () => true,
    assignedDevices: () => [],
    hid: { getDevices },
    discoveryTimeoutMs: 20,
    pollIntervalMs: 1,
  });
  const port = mocked.port as FirmwarePhysicalUpdatePort;
  left.loader.failClose = true;
  await expect(
    port.reserve([left.binding, right.binding], async () => {
      await Promise.all([
        port.discoverBootloader(left.binding, true),
        port.discoverBootloader(right.binding, true),
      ]);
    }),
  ).rejects.toThrow(/cleanup/);
  expect(left.loader.close).toHaveBeenCalledOnce();
  expect(right.loader.close).toHaveBeenCalledOnce();
  expect(right.loader.opened).toBe(false);
  expect(left.runtime.close).not.toHaveBeenCalled();
});

it('does not borrow or close an already-open correlated candidate', async () => {
  const f = fixture();
  mocked.profile = f.profile;
  f.state.attached = false;
  f.state.granted = [f.loader.hid()];
  f.loader.opened = true;
  await expect(
    f.port.reserve([f.binding], () => f.port.discoverBootloader(f.binding, true)),
  ).rejects.toThrow(/open|assigned/);
  expect(f.loader.open).not.toHaveBeenCalled();
  expect(f.loader.close).not.toHaveBeenCalled();
});

it('persists known-content version provenance while refusing fabricated known hash expectations', async () => {
  const f = fixture();
  mocked.profile = f.profile;
  f.source.expectedAfter.source = 'known-content-profile' as never;
  await expect(f.coordinator.review('left', actor)).rejects.toThrow(/known content profile/);
  expect(f.runtime.requests).toEqual([]);
});

it('refuses asynchronous permission policies and observes their rejection without granting entry', async () => {
  const f = fixture();
  mocked.profile = f.profile;
  vi.mocked(f.profile.assertRuntimeAccess).mockImplementation(async () => {
    throw new Error('Unsettled permission is not authority');
  });
  await expect(f.coordinator.review('left', actor)).rejects.toThrow(/synchronously/);
  expect(f.runtime.requests.some((request) => request[0] === 0x40)).toBe(false);
});

it('closes an interface opened by discovery even if its assignment changes while open is pending', async () => {
  const f = fixture();
  mocked.profile = f.profile;
  f.state.attached = false;
  f.state.granted = [f.loader.hid()];
  f.loader.open.mockImplementation(async () => {
    f.loader.opened = true;
    f.state.current = false;
  });
  await expect(
    f.port.reserve([f.binding], () => f.port.discoverBootloader(f.binding, true)),
  ).rejects.toThrow(/lease changed/);
  expect(f.loader.close).toHaveBeenCalledOnce();
  expect(f.loader.opened).toBe(false);
  expect(f.loader.requests).toEqual([]);
});

it('keeps an unattempted runtime usable and emits no retirement callback when the final wire fence refuses', async () => {
  const f = fixture();
  mocked.profile = f.profile;
  const result = await f.port.reserve([f.binding], () =>
    f.port.enterBootloader(f.binding, {
      requestId: 'refused-entry',
      payload: packet(0x40),
      timeoutMs: 5000,
      beforeWireSend() {
        throw new Error('Changed at final fence');
      },
    }),
  );
  expect(result).toBe('not-sent');
  expect(f.retired).not.toHaveBeenCalled();
  expect(f.runtime.requests.some((request) => request[0] === 0x40)).toBe(false);
  expect((await f.transport.exchange(packet(6, 1)))[0]).toBe(6);
});

it('quarantines retired-runtime close failure and never proceeds to loader or repeats entry', async () => {
  const f = fixture();
  mocked.profile = f.profile;
  f.retired.mockImplementation(() => {
    f.runtime.opened = true;
    f.runtime.failClose = true;
  });
  const review = await f.coordinator.review('left', actor);
  await expect(f.coordinator.apply(review.id, actor, { confirm: true })).rejects.toMatchObject({
    result: { phase: 'partial' },
  });
  expect(f.runtime.requests.filter((request) => request[0] === 0x40)).toHaveLength(1);
  expect(f.loader.open).not.toHaveBeenCalled();
  expect(f.getDevices).not.toHaveBeenCalled();
  await expect(f.transport.exchange(packet(6, 1))).rejects.toThrow(/retired|closed/);
});

it('bounds an unresolved granted-device discovery query without opening a candidate', async () => {
  vi.useFakeTimers();
  const f = fixture();
  mocked.profile = f.profile;
  f.state.attached = false;
  createFirmwareWebHidUpdateAdapter({
    capture: () => undefined,
    isCurrent: () => true,
    assignedDevices: () => [],
    hid: { getDevices: () => new Promise(() => {}) },
    discoveryTimeoutMs: 20,
    pollIntervalMs: 1,
  });
  const port = mocked.port as FirmwarePhysicalUpdatePort;
  const pending = expect(
    port.reserve([f.binding], () => port.discoverBootloader(f.binding, true)),
  ).rejects.toThrow(/bound/);
  await vi.advanceTimersByTimeAsync(21);
  await pending;
  expect(f.loader.open).not.toHaveBeenCalled();
});
