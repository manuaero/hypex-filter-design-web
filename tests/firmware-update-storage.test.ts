import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ openDB: vi.fn() }));
vi.mock('idb', () => ({ openDB: mock.openDB }));
import {
  FIRMWARE_JOURNAL_STEPS,
  MAX_FIRMWARE_EXECUTION_SOURCE_BYTES,
  MAX_FIRMWARE_JOURNAL_RECORDS,
  assertFirmwareJournalWrite,
  createFirmwareJournalStore,
  firmwareBeforeSha256,
  firmwareImageSha256,
  firmwareSourceSha256,
  FirmwareJournalCapacityError,
  FirmwareJournalConflictError,
  parseFirmwareJournalEnvelope,
  type FirmwareJournalEnvelope,
  type FirmwareJournalImage,
  type FirmwareJournalRecord,
} from '../src/application/firmware-update-storage';

const owner = 'workspace:11111111-1111-1111-1111-111111111111';
const id = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const empty = (): FirmwareJournalEnvelope => ({ version: 1, revision: 0, records: [] });
function image(
  name: string,
  kind: FirmwareJournalImage['kind'],
  size: number,
  address?: number,
  command?: number,
): FirmwareJournalImage {
  const raw = new Uint8Array(size);
  raw[0] = command ?? ((address ?? 0) >> 5) & 255;
  const hex = Buffer.from(raw).toString('hex');
  return {
    id: name,
    kind,
    ...(address === undefined ? {} : { address }),
    hex,
    sha256: createHash('sha256').update(raw).digest('hex'),
    ...(kind === 'report' ? { compareMaskHex: 'ff'.repeat(size) } : {}),
  };
}
function record(n = 1): FirmwareJournalRecord {
  const images = [
    ...[3, 5, 6, 0x66].map((command) =>
      image(`report-${command}`, 'report', 64, undefined, command),
    ),
    ...Array.from({ length: 24 }, (_, index) =>
      image(`flash-${index}`, 'spi-flash', 4096, 0x10000 + index * 4096),
    ),
    ...[0x100, 0x120, 0x140, ...Array.from({ length: 12 }, (_, index) => 0x200 + index * 32)].map(
      (address) => image(`eeprom-${address}`, 'eeprom', 32, address),
    ),
  ];
  const before = {
    images,
    gaps: [
      'Original PIC32 firmware image is unavailable',
      'Unmapped calibration/recovery state is unqualified',
    ],
    sha256: '',
  };
  before.sha256 = createHash('sha256')
    .update(JSON.stringify({ images, gaps: before.gaps }))
    .digest('hex');
  const text = 'Synthetic execution-source fixture; parser qualification is a separate layer.\n';
  return {
    id: id(n),
    owner,
    scope: 'ui:synthetic',
    target: 'left',
    qualifier: 'reference-simulation',
    createdAt: 100,
    updatedAt: 100,
    phase: 'prepared',
    roles: [
      {
        slot: 'left',
        binding: {
          assignmentId: `assignment-${n}`,
          connectionId: `connection-${n}`,
          connectionEpoch: 2,
          serial: `SIM-${n}`,
          hidSerial: `FUSION32-SIM-${n}`,
          family: 'FUSION32',
          product: 22,
          core: '5.1',
          firmware: '5.7',
        },
        source: {
          name: 'synthetic.hex',
          text,
          sha256: createHash('sha256').update(text).digest('hex'),
          family: 'FUSION32',
          expectedAfter: { firmware: '5.82', source: 'explicit-simulation' },
        },
        before,
        steps: FIRMWARE_JOURNAL_STEPS.map((stepId) => ({
          id: stepId,
          state: 'pending',
          attempted: false,
        })),
      },
    ],
  };
}
const envelope = (...records: FirmwareJournalRecord[]): FirmwareJournalEnvelope => ({
  version: 1,
  revision: 1,
  records,
});
it('retains exact known-content provenance separately from record metadata and simulation', () => {
  const value = record();
  value.roles[0].source.expectedAfter = {
    core: '5.5',
    firmware: '5.82',
    source: 'known-content-profile',
  };
  const parsed = parseFirmwareJournalEnvelope(envelope(value));
  expect(parsed.records[0].roles[0].source.expectedAfter).toEqual(
    value.roles[0].source.expectedAfter,
  );
  const edited = structuredClone(parsed);
  edited.revision++;
  edited.records[0].roles[0].source.expectedAfter!.source = 'bundle-record-metadata';
  expect(() => assertFirmwareJournalWrite(parsed, parsed.revision, edited)).toThrow(
    /immutable|source|plan/i,
  );
});
const reseal = (r: FirmwareJournalRecord) => {
  for (const role of r.roles) {
    for (const part of role.before.images) part.sha256 = firmwareImageSha256(part.hex);
    role.before.sha256 = firmwareBeforeSha256(role.before);
  }
};
function complete(r: FirmwareJournalRecord): FirmwareJournalRecord {
  r.phase = 'complete';
  r.updatedAt++;
  const role = r.roles[0];
  role.steps = role.steps.map((step) => ({
    ...step,
    state: 'verified',
    attempted: ['entry', 'stream', 'exit'].includes(step.id),
  }));
  role.stream = {
    acceptedPackets: 4,
    acceptedRecords: 6,
    nativeProgressRecords: 8,
    transportAttempts: 5,
    wireRequests: 4,
    streamComplete: true,
    lastAccepted: { pass: 1, index: 1 },
    targetStatus: 1,
  };
  role.after = {
    binding: {
      ...role.binding,
      connectionId: 'after-reconnect',
      connectionEpoch: 3,
      firmware: '5.82',
    },
    controlsDialect: 'unqualified',
    preservation: 'matched-known-ranges',
    changedImages: [],
  };
  return r;
}

interface Hooks {
  upgrade(db: unknown): void;
  blocking(): void;
  terminated(): void;
}
function database(initial?: unknown) {
  let value = structuredClone(initial),
    tail = Promise.resolve(),
    puts = 0;
  const db = {
    relaxed: false,
    putFailure: false,
    commitFailure: false,
    readFailure: false,
    readback: undefined as ((data: unknown) => unknown) | undefined,
    close: vi.fn(),
    get: vi.fn(async () => {
      if (db.readFailure) throw new Error('Readback unavailable');
      return structuredClone(db.readback ? db.readback(value) : value);
    }),
    transaction: vi.fn(() => {
      const before = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      let staged: unknown,
        written = false,
        aborted = false,
        done: Promise<void> | undefined;
      return {
        durability: db.relaxed ? 'relaxed' : 'strict',
        store: {
          get: async () => {
            await before;
            return structuredClone(value);
          },
          put: async (data: unknown) => {
            await before;
            if (db.putFailure) throw new Error('Put unavailable');
            staged = structuredClone(data);
            written = true;
            puts++;
          },
        },
        abort() {
          aborted = true;
        },
        get done() {
          return (done ??= before
            .then(() => {
              if (aborted || db.commitFailure) throw new Error('Transaction did not commit');
              if (written) value = structuredClone(staged);
            })
            .finally(release));
        },
      };
    }),
  };
  mock.openDB.mockResolvedValue(db);
  return {
    db,
    get value() {
      return structuredClone(value);
    },
    get puts() {
      return puts;
    },
  };
}
beforeEach(() => {
  mock.openDB.mockReset();
  vi.stubGlobal('indexedDB', {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it('reads empty without writes, then stores detached complete preservation images/source after strict CAS/readback', async () => {
  const f = database(),
    store = createFirmwareJournalStore();
  expect(await store.read()).toEqual(empty());
  expect(f.puts).toBe(0);
  const next = envelope(record()),
    original = structuredClone(next),
    saving = store.compareAndSwap(0, next);
  next.records[0].roles[0].before.images[0].hex = 'ff'.repeat(64);
  await saving;
  expect(await store.read()).toEqual(original);
  expect(f.db.transaction).toHaveBeenCalledWith('state', 'readwrite', { durability: 'strict' });
  const detached = await store.read();
  detached.records[0].roles[0].source.text = 'changed';
  expect(await store.read()).toEqual(original);
});

it('checks original images/source/manifest hashes independently, including exact source UTF-8 and masks/gaps', () => {
  const r = record(),
    role = r.roles[0];
  expect(firmwareSourceSha256('μ\uFEFF\r\n')).toBe(
    createHash('sha256').update('μ\uFEFF\r\n').digest('hex'),
  );
  expect(firmwareImageSha256(role.before.images[4].hex)).toBe(
    createHash('sha256').update(Buffer.from(role.before.images[4].hex, 'hex')).digest('hex'),
  );
  expect(firmwareBeforeSha256(role.before)).toBe(role.before.sha256);
  role.before.images[0].compareMaskHex = '00'.repeat(64);
  expect(() => parseFirmwareJournalEnvelope(envelope(r))).toThrow(/SHA/);
  reseal(r);
  expect(() => parseFirmwareJournalEnvelope(envelope(r))).not.toThrow();
  role.before.gaps.push('Additional unavailable range');
  expect(() => parseFirmwareJournalEnvelope(envelope(r))).toThrow(/SHA/);
});

it.each([
  null,
  {},
  { version: 2, revision: 0, records: [] },
  { version: 1, revision: 0, records: [], extra: true },
])('fails closed over invalid prior journal without resetting it: %j', async (invalid) => {
  const f = database(invalid),
    store = createFirmwareJournalStore();
  await expect(store.read()).rejects.toThrow();
  await expect(store.compareAndSwap(0, envelope(record()))).rejects.toThrow();
  expect(f.value).toEqual(invalid);
  expect(f.puts).toBe(0);
});

it('rejects unsafe EEPROM, omitted/duplicate flash, bad reports/masks, corrupt source, noncanonical ownership and forged correlation', () => {
  const changes: ((r: FirmwareJournalRecord) => void)[] = [
    (r) => {
      r.owner = 'site:raw-actor';
    },
    (r) => {
      r.roles[0].before.images[28].address = 0x20;
      reseal(r);
    },
    (r) => {
      r.roles[0].before.images[4].address = 0x11000;
      reseal(r);
    },
    (r) => {
      r.roles[0].before.images.pop();
      reseal(r);
    },
    (r) => {
      r.roles[0].before.images[0].hex = '04' + '00'.repeat(63);
      reseal(r);
    },
    (r) => {
      delete r.roles[0].before.images[0].compareMaskHex;
      reseal(r);
    },
    (r) => {
      r.roles[0].before.images[4].compareMaskHex = '00'.repeat(4096);
      reseal(r);
    },
    (r) => {
      r.roles[0].source.text += 'changed';
    },
    (r) => {
      r.roles[0].source.family = 'FUSION01';
    },
    (r) => {
      r.qualifier = 'qualified-physical';
    },
    (r) => {
      r.roles[0].steps.reverse();
    },
    (r) => {
      r.roles[0].steps[0].attempted = true;
    },
    (r) => {
      r.roles[0].after = {
        binding: { ...r.roles[0].binding, hidSerial: 'OTHER' },
        controlsDialect: 'supported',
        preservation: 'unavailable',
        changedImages: [],
      };
    },
  ];
  for (const change of changes) {
    const r = record();
    change(r);
    expect(() => parseFirmwareJournalEnvelope(envelope(r))).toThrow();
  }
});

it('permits read-only verified steps but never promotes intent into proof of an actual send', () => {
  const next = envelope(record());
  next.records[0].phase = 'running';
  Object.assign(next.records[0].roles[0].steps[0], { state: 'intent', attempted: false });
  Object.assign(next.records[0].roles[0].steps[1], { state: 'verified', attempted: false });
  expect(parseFirmwareJournalEnvelope(next).records[0].roles[0].steps[0]).toMatchObject({
    state: 'intent',
    attempted: false,
  });
  expect(() =>
    assertFirmwareJournalWrite(envelope(record()), 1, { ...next, revision: 2 }),
  ).not.toThrow();
});

it('fresh CAS serializes independent writers and preserves the winner against a stale overwrite', async () => {
  const f = database(),
    a = createFirmwareJournalStore(),
    b = createFirmwareJournalStore();
  const result = await Promise.allSettled([
    a.compareAndSwap(0, envelope(record(1))),
    b.compareAndSwap(0, envelope(record(2))),
  ]);
  expect(result.map((entry) => entry.status)).toEqual(['fulfilled', 'rejected']);
  expect((result[1] as PromiseRejectedResult).reason).toBeInstanceOf(FirmwareJournalConflictError);
  expect(f.value).toEqual(envelope(record(1)));
  expect(f.puts).toBe(1);
});

it('exact same-revision replay performs no put, while changed same-revision bytes are refused', async () => {
  const f = database(),
    store = createFirmwareJournalStore(),
    next = envelope(record());
  await store.compareAndSwap(0, next);
  await store.compareAndSwap(0, structuredClone(next));
  expect(f.puts).toBe(1);
  const altered = structuredClone(next);
  altered.records[0].scope = 'another-scope';
  await expect(store.compareAndSwap(0, altered)).rejects.toBeInstanceOf(
    FirmwareJournalConflictError,
  );
  expect(f.value).toEqual(next);
});

it('protects immutable source, images, role/binding/provenance and append order even after valid rehash', () => {
  const current = envelope(record()),
    changes: ((v: FirmwareJournalEnvelope) => void)[] = [
      (v) => {
        v.records[0].owner = 'workspace:22222222-2222-2222-2222-222222222222';
      },
      (v) => {
        v.records[0].scope = 'paired:other';
      },
      (v) => {
        v.records[0].roles[0].binding.connectionId = 'replacement';
      },
      (v) => {
        v.records[0].roles[0].source.text = 'new';
        v.records[0].roles[0].source.sha256 = firmwareSourceSha256('new');
      },
      (v) => {
        v.records[0].roles[0].before.images[4].hex = '01'.repeat(4096);
        reseal(v.records[0]);
      },
      (v) => {
        v.records[0].roles[0].before.gaps = [];
        reseal(v.records[0]);
      },
      (v) => {
        v.records.unshift(record(2));
      },
      (v) => {
        v.records = [];
      },
    ];
  for (const change of changes) {
    const next = structuredClone(current);
    next.revision++;
    change(next);
    expect(() => assertFirmwareJournalWrite(current, 1, next)).toThrow();
  }
  const consumed = envelope(complete(record()));
  expect(() => assertFirmwareJournalWrite(empty(), 0, consumed)).toThrow(/prepared/);
});

it.each(['complete', 'partial', 'failed', 'cancelled'] as const)(
  'keeps consumed %s receipts immutable and requires a new appended recovery identity',
  (phase) => {
    const first = phase === 'complete' ? complete(record()) : record();
    first.phase = phase;
    const current = envelope(first),
      changed = structuredClone(current);
    changed.revision++;
    changed.records[0].updatedAt++;
    expect(() => assertFirmwareJournalWrite(current, 1, changed)).toThrow(/historical/);
    const recovery = record(2);
    recovery.sourceRecordId = first.id;
    recovery.roles[0] = structuredClone(first.roles[0]);
    recovery.roles[0].binding.connectionId = 'recovery-connection';
    recovery.roles[0].binding.connectionEpoch++;
    recovery.roles[0].binding.firmware = '5.82';
    recovery.roles[0].steps = FIRMWARE_JOURNAL_STEPS.map((stepId) => ({
      id: stepId,
      state: 'pending',
      attempted: false,
    }));
    delete recovery.roles[0].after;
    delete recovery.roles[0].stream;
    expect(() =>
      assertFirmwareJournalWrite(current, 1, {
        version: 1,
        revision: 2,
        records: [first, recovery],
      }),
    ).not.toThrow();
    const reordered = { version: 1 as const, revision: 2, records: [recovery, first] };
    expect(() => parseFirmwareJournalEnvelope(reordered)).toThrow(/earlier/);
  },
);

it('refuses erasing attempted/verified progress or decreasing stream counters, while allowing a precise partial ledger', () => {
  const old = record();
  old.phase = 'running';
  Object.assign(old.roles[0].steps[0], { state: 'verified', attempted: true });
  Object.assign(old.roles[0].steps[2], { state: 'intent', attempted: true });
  old.roles[0].stream = {
    acceptedPackets: 2,
    acceptedRecords: 3,
    nativeProgressRecords: 4,
    transportAttempts: 3,
    wireRequests: 2,
    streamComplete: false,
    lastAccepted: { pass: 0, index: 1 },
  };
  const current = envelope(old),
    next = structuredClone(current);
  next.revision++;
  next.records[0].phase = 'partial';
  Object.assign(next.records[0].roles[0].steps[2], {
    state: 'unconfirmed',
    error: 'Lost correlated reply',
  });
  expect(() => assertFirmwareJournalWrite(current, 1, next)).not.toThrow();
  next.records[0].roles[0].steps[2].attempted = false;
  expect(() => assertFirmwareJournalWrite(current, 1, next)).toThrow(/erased/);
  const backwards = structuredClone(current);
  backwards.revision++;
  backwards.records[0].roles[0].stream!.transportAttempts = 2;
  expect(() => assertFirmwareJournalWrite(current, 1, backwards)).toThrow(/decrease/);
});

it('rejects false stream completion, mismatched counters and claimed-preserved changed images', () => {
  const changes: ((r: FirmwareJournalRecord) => void)[] = [
    (r) => {
      delete r.roles[0].after;
    },
    (r) => {
      r.roles[0].after!.preservation = 'unavailable';
    },
    (r) => {
      r.roles[0].stream!.streamComplete = false;
    },
    (r) => {
      r.roles[0].stream!.nativeProgressRecords = 3;
    },
    (r) => {
      r.roles[0].stream!.acceptedRecords = 20;
    },
    (r) => {
      r.roles[0].after!.changedImages = ['flash-0'];
    },
  ];
  for (const change of changes) {
    const r = complete(record());
    change(r);
    expect(() => parseFirmwareJournalEnvelope(envelope(r))).toThrow();
  }
});

it('recovery preserves original role/source/before bytes while allowing a fresh correlated connection and firmware', () => {
  const original = complete(record()),
    recovery = record(2);
  recovery.sourceRecordId = original.id;
  recovery.roles[0].binding = {
    ...original.roles[0].binding,
    connectionId: 'new-connection',
    connectionEpoch: 3,
    firmware: '5.82',
  };
  expect(() => parseFirmwareJournalEnvelope(envelope(original, recovery))).not.toThrow();
  for (const change of [
    (r: FirmwareJournalRecord) => {
      r.roles[0].binding.assignmentId = 'other-assignment';
    },
    (r: FirmwareJournalRecord) => {
      r.roles[0].binding.serial = 'other-device';
    },
    (r: FirmwareJournalRecord) => {
      r.roles[0].source.name = 'renamed-source';
    },
    (r: FirmwareJournalRecord) => {
      r.roles[0].before.images[4].hex = 'ff'.repeat(4096);
      reseal(r);
    },
  ]) {
    const altered = structuredClone(recovery);
    change(altered);
    expect(() => parseFirmwareJournalEnvelope(envelope(original, altered))).toThrow(
      /recovery must retain/,
    );
  }
});

it('capacity and UTF-8 execution source limits fail before transactions without poisoning future storage use', async () => {
  const f = database(),
    store = createFirmwareJournalStore();
  await expect(
    store.compareAndSwap(
      0,
      envelope(
        ...Array.from({ length: MAX_FIRMWARE_JOURNAL_RECORDS + 1 }, (_, index) =>
          record(index + 1),
        ),
      ),
    ),
  ).rejects.toBeInstanceOf(FirmwareJournalCapacityError);
  const large = record();
  large.roles[0].source.text = 'μ'.repeat(MAX_FIRMWARE_EXECUTION_SOURCE_BYTES / 2 + 1);
  large.roles[0].source.sha256 = firmwareSourceSha256(large.roles[0].source.text);
  await expect(store.compareAndSwap(0, envelope(large))).rejects.toThrow(/size/);
  expect(f.db.transaction).not.toHaveBeenCalled();
  await store.compareAndSwap(0, envelope(record()));
  expect(f.puts).toBe(1);
});

it.each(['putFailure', 'commitFailure', 'readFailure'] as const)(
  'does not acknowledge %s and supports exact already-durable retry only',
  async (fault) => {
    const f = database(),
      store = createFirmwareJournalStore(),
      next = envelope(record());
    f.db[fault] = true;
    await expect(store.compareAndSwap(0, next)).rejects.toThrow();
    f.db[fault] = false;
    await store.compareAndSwap(0, next);
    expect(await store.read()).toEqual(next);
    expect(f.puts).toBe(fault === 'commitFailure' ? 2 : 1);
  },
);

it('does not acknowledge mismatched/corrupt durable readback and does not replace it with an empty journal', async () => {
  const f = database(),
    store = createFirmwareJournalStore(),
    next = envelope(record());
  f.db.readback = () => ({ version: 1, revision: 1, records: [] });
  await expect(store.compareAndSwap(0, next)).rejects.toThrow(/readback differs/);
  expect(f.value).toEqual(next);
  f.db.readback = (value) => {
    const copy = structuredClone(value) as FirmwareJournalEnvelope;
    copy.records[0].roles[0].before.images[4].hex = 'ff'.repeat(4096);
    return copy;
  };
  await expect(store.read()).rejects.toThrow(/SHA/);
  expect(f.puts).toBe(1);
});

it('requests strict durability and fails closed if unavailable', async () => {
  const f = database();
  f.db.relaxed = true;
  await expect(createFirmwareJournalStore().compareAndSwap(0, envelope(record()))).rejects.toThrow(
    /Strict/,
  );
  expect(f.puts).toBe(0);
  expect(f.value).toBeUndefined();
});

it.each(['blocking', 'terminated'] as const)(
  'fences an existing handle after %s without fresh replacement',
  async (event) => {
    const f = database(),
      store = createFirmwareJournalStore();
    await store.read();
    const hooks = mock.openDB.mock.calls[0][2] as Hooks;
    hooks[event]();
    await expect(store.read()).rejects.toThrow(/changed version/);
    await expect(store.compareAndSwap(0, envelope(record()))).rejects.toThrow(/changed version/);
    expect(mock.openDB).toHaveBeenCalledOnce();
    expect(f.puts).toBe(0);
  },
);

it('reports missing IndexedDB without opening or silently storing volatile defaults', async () => {
  vi.stubGlobal('indexedDB', undefined);
  const store = createFirmwareJournalStore();
  await expect(store.read()).rejects.toThrow(/IndexedDB is unavailable/);
  await expect(store.compareAndSwap(0, envelope(record()))).rejects.toThrow(
    /IndexedDB is unavailable/,
  );
  expect(mock.openDB).not.toHaveBeenCalled();
});
