import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ openDB: vi.fn() }));
vi.mock('idb', () => ({ openDB: mock.openDB }));
import {
  assertDeviceDefaultsWrite,
  createDeviceDefaultsStorage,
  defaultsBeforeSha256,
  DeviceDefaultsCapacityError,
  DeviceDefaultsConflictError,
  MAX_DEVICE_DEFAULTS_RECORDS,
  parseDeviceDefaultsEnvelope,
  type DefaultsJournalEnvelope,
  type DefaultsJournalRecord,
  type DefaultsJournalStep,
} from '../src/application/device-defaults-storage';

const owner = 'workspace:11111111-1111-1111-1111-111111111111';
const identifier = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
function record(n = 1): DefaultsJournalRecord {
  const status = new Uint8Array(64),
    configuration = new Uint8Array(64),
    deviceConfiguration = new Uint8Array(64);
  status.set([5, 6, 2]);
  status[51] = 1;
  configuration.set([6, 22, 5, 1]);
  configuration[15] = 5;
  configuration[17] = 7;
  deviceConfiguration[0] = 0x66;
  deviceConfiguration[10] = 5;
  deviceConfiguration[12] = 22;
  const before = {
    statusHex: hex(status),
    configurationHex: hex(configuration),
    deviceConfigurationHex: hex(deviceConfiguration),
  };
  return {
    id: identifier(n),
    owner,
    scope: 'ui:synthetic-scope',
    operation: 'defaults',
    target: 'left',
    createdAt: 100,
    updatedAt: 100,
    phase: 'prepared',
    roles: [
      {
        slot: 'left',
        identity: { serial: `SIM-${n}`, product: 22, core: '5.1', firmware: '5.7' },
        before,
        beforeSha256: defaultsBeforeSha256(before),
        preflight: 'verified',
        lastConfirmedMuted: false,
        steps: (['mute', 'settings', 'mixer', 'configuration', 'display'] as const).map(
          (id): DefaultsJournalStep => {
            const request = status.slice(),
              expected = status.slice(),
              mask = new Uint8Array(64).fill(255);
            request[1] = 0;
            if (id === 'configuration') {
              request.set(deviceConfiguration);
              request[1] = 1;
              expected.set(deviceConfiguration);
            }
            return {
              id,
              requestHex: hex(request),
              expectedHex: hex(expected),
              maskHex: hex(mask),
              attempted: false,
              state: 'pending',
            };
          },
        ),
      },
    ],
  };
}
const empty = (): DefaultsJournalEnvelope => ({ version: 1, revision: 0, records: [] });
const envelope = (...records: DefaultsJournalRecord[]): DefaultsJournalEnvelope => ({
  version: 1,
  revision: 1,
  records,
});

interface Hooks {
  upgrade(db: unknown): void;
  blocking(): void;
  terminated(): void;
}
function database(initial?: unknown) {
  let value = structuredClone(initial),
    tail = Promise.resolve(),
    puts = 0;
  const transactions: { durability: string; aborted: boolean; commits: number }[] = [];
  const db = {
    relaxed: false,
    commitFailure: false,
    putFailure: false,
    readFailure: false,
    overrideReadback: undefined as undefined | ((value: unknown) => unknown),
    close: vi.fn(),
    get: vi.fn(async () => {
      if (db.readFailure) throw new Error('Injected readback failure');
      return structuredClone(db.overrideReadback ? db.overrideReadback(value) : value);
    }),
    transaction: vi.fn(() => {
      const before = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      const state = { durability: db.relaxed ? 'relaxed' : 'strict', aborted: false, commits: 0 };
      transactions.push(state);
      let staged: unknown,
        hasWrite = false,
        done: Promise<void> | undefined;
      return {
        durability: state.durability,
        store: {
          get: vi.fn(async () => {
            await before;
            return structuredClone(value);
          }),
          put: vi.fn(async (next: unknown) => {
            await before;
            if (db.putFailure) throw new Error('Injected put failure');
            puts++;
            staged = structuredClone(next);
            hasWrite = true;
          }),
        },
        abort: () => {
          state.aborted = true;
        },
        get done() {
          return (done ??= before
            .then(() => {
              if (state.aborted) throw new Error('Transaction aborted');
              if (db.commitFailure) throw new Error('Injected transaction failure');
              if (hasWrite) value = structuredClone(staged);
              state.commits++;
            })
            .finally(release));
        },
      };
    }),
  };
  mock.openDB.mockResolvedValue(db);
  return {
    db,
    transactions,
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

it('reads an absent journal without writing defaults, then preserves exact detached 05/06/66 bytes and plans after strict CAS/readback', async () => {
  const f = database(),
    storage = createDeviceDefaultsStorage();
  expect(await storage.read()).toEqual(empty());
  expect(f.puts).toBe(0);
  const next = envelope(record());
  const saving = storage.compareAndSwap(0, next);
  next.records[0].roles[0].before.statusHex = 'ff'.repeat(64);
  await saving;
  const restored = await storage.read();
  expect(restored).toEqual(envelope(record()));
  expect(f.db.transaction).toHaveBeenCalledWith('state', 'readwrite', { durability: 'strict' });
  restored.records[0].roles[0].steps[0].requestHex = '00'.repeat(64);
  expect(await storage.read()).toEqual(envelope(record()));
});

it('checks the original-record SHA against an independent known-answer hash of all 192 bytes', () => {
  const r = record().roles[0],
    raw = Buffer.from(
      r.before.statusHex + r.before.configurationHex + r.before.deviceConfigurationHex,
      'hex',
    );
  expect(defaultsBeforeSha256(r.before)).toBe(createHash('sha256').update(raw).digest('hex'));
  r.before.deviceConfigurationHex = r.before.deviceConfigurationHex.slice(0, 126) + '01';
  expect(() => parseDeviceDefaultsEnvelope(envelope({ ...record(), roles: [r] }))).toThrow(
    /checksum/,
  );
});

it.each([
  null,
  {},
  { version: 2, revision: 0, records: [] },
  { version: 1, revision: 0, records: [], extra: true },
])('fails closed over unreadable/invalid prior data %j without replacing it', async (invalid) => {
  const f = database(invalid),
    storage = createDeviceDefaultsStorage();
  await expect(storage.read()).rejects.toThrow();
  await expect(storage.compareAndSwap(0, envelope(record()))).rejects.toThrow();
  expect(f.value).toEqual(invalid);
  expect(f.puts).toBe(0);
});

it('rejects corrupt before-images, identity mismatch, noncanonical actors, unsafe commands, incomplete plans and inconsistent success ledgers', () => {
  const changes: ((r: DefaultsJournalRecord) => void)[] = [
    (r) => {
      r.owner = 'site:spoofed';
    },
    (r) => {
      r.id = 'not-a-request-uuid';
    },
    (r) => {
      r.roles[0].identity.firmware = '5.82';
    },
    (r) => {
      r.roles[0].before.statusHex = '0500';
    },
    (r) => {
      r.roles[0].before.statusHex = '06' + r.roles[0].before.statusHex.slice(2);
      r.roles[0].beforeSha256 = defaultsBeforeSha256(r.roles[0].before);
    },
    (r) => {
      r.roles[0].steps[1].requestHex = '040203' + '00'.repeat(61);
    },
    (r) => {
      r.roles[0].steps.splice(2, 1);
    },
    (r) => {
      r.roles[0].steps[0].state = 'verified';
    },
    (r) => {
      r.phase = 'complete';
    },
    (r) => {
      r.target = 'both';
    },
  ];
  for (const change of changes) {
    const r = record();
    change(r);
    expect(() => parseDeviceDefaultsEnvelope(envelope(r))).toThrow();
  }
});

it('serializes two independent controllers and refuses a stale revision without overwriting the winner', async () => {
  const f = database(),
    a = createDeviceDefaultsStorage(),
    b = createDeviceDefaultsStorage();
  const outcomes = await Promise.allSettled([
    a.compareAndSwap(0, envelope(record(1))),
    b.compareAndSwap(0, envelope(record(2))),
  ]);
  expect(outcomes.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  expect((outcomes[1] as PromiseRejectedResult).reason).toBeInstanceOf(DeviceDefaultsConflictError);
  expect(f.value).toEqual(envelope(record(1)));
  expect(f.puts).toBe(1);
});

it('replays an identical committed envelope without another put but refuses an altered same-revision record', async () => {
  const f = database(),
    storage = createDeviceDefaultsStorage(),
    next = envelope(record());
  await storage.compareAndSwap(0, next);
  await storage.compareAndSwap(0, structuredClone(next));
  expect(f.puts).toBe(1);
  const different = structuredClone(next);
  different.records[0].scope = 'manual:other-scope';
  await expect(storage.compareAndSwap(0, different)).rejects.toBeInstanceOf(
    DeviceDefaultsConflictError,
  );
  expect(f.value).toEqual(next);
});

it('retains immutable owner/request/target/originals/plan and applied-scope provenance while allowing attempted/failure outcome progress', async () => {
  const original = envelope(record()),
    f = database(original),
    storage = createDeviceDefaultsStorage();
  const updated = structuredClone(original);
  updated.revision = 2;
  updated.records[0].updatedAt++;
  updated.records[0].phase = 'partial';
  updated.records[0].appliedScope = 'paired:site:new-scope';
  Object.assign(updated.records[0].roles[0].steps[0], {
    attempted: true,
    state: 'failed',
    error: 'ACK unconfirmed',
  });
  await storage.compareAndSwap(1, updated);
  for (const change of [
    (v: DefaultsJournalEnvelope) => {
      v.records = [];
    },
    (v: DefaultsJournalEnvelope) => {
      v.records[0].owner = 'workspace:22222222-2222-2222-2222-222222222222';
    },
    (v: DefaultsJournalEnvelope) => {
      v.records[0].scope = 'ui:rebound';
    },
    (v: DefaultsJournalEnvelope) => {
      v.records[0].appliedScope = 'paired:local:other';
    },
    (v: DefaultsJournalEnvelope) => {
      v.records[0].roles[0].steps[0].requestHex = '0500' + '01'.repeat(62);
    },
  ]) {
    const next = structuredClone(updated);
    next.revision = 3;
    change(next);
    await expect(storage.compareAndSwap(2, next)).rejects.toThrow(/cannot/);
  }
  expect(f.value).toEqual(updated);
});

it('binds a recovery to an existing same-owner source while retaining current recovery before-images separately', () => {
  const source = record(1),
    recovery = record(2);
  recovery.operation = 'recovery';
  recovery.sourceRecordId = source.id;
  recovery.roles[0].before.statusHex =
    recovery.roles[0].before.statusHex.slice(0, 12) +
    '80' +
    recovery.roles[0].before.statusHex.slice(14);
  recovery.roles[0].beforeSha256 = defaultsBeforeSha256(recovery.roles[0].before);
  recovery.roles[0].steps = [
    recovery.roles[0].steps[0],
    { ...recovery.roles[0].steps[3], id: 'restore-configuration' },
    { ...recovery.roles[0].steps[1], id: 'restore-settings' },
  ];
  const saved = parseDeviceDefaultsEnvelope(envelope(source, recovery));
  expect(saved.records[1].roles[0].before).not.toEqual(saved.records[0].roles[0].before);
  expect(() => parseDeviceDefaultsEnvelope(envelope(recovery))).toThrow(/source/);
  source.owner = 'workspace:22222222-2222-2222-2222-222222222222';
  expect(() => parseDeviceDefaultsEnvelope(envelope(source, recovery))).toThrow(/owner/);
});

it('never downgrades or changes a verified completion after a lost acknowledgment, but permits appending a new request', async () => {
  const r = record();
  r.phase = 'complete';
  for (const s of r.roles[0].steps) {
    s.state = 'verified';
    s.attempted = true;
  }
  const saved = envelope(r),
    f = database(saved),
    storage = createDeviceDefaultsStorage();
  for (const phase of ['prepared', 'running', 'partial', 'failed'] as const) {
    const next = structuredClone(saved);
    next.revision = 2;
    next.records[0].phase = phase;
    await expect(storage.compareAndSwap(1, next)).rejects.toThrow(/historical/);
  }
  const altered = structuredClone(saved);
  altered.revision = 2;
  altered.records[0].error = 'Late observer failure';
  await expect(storage.compareAndSwap(1, altered)).rejects.toThrow(/historical/);
  expect(f.puts).toBe(0);
  const appended = structuredClone(saved);
  appended.revision = 2;
  appended.records.push(record(2));
  await storage.compareAndSwap(1, appended);
  expect((await storage.read()).records[0]).toEqual(r);
});

it('retains existing receipt chronology and permits only appended new requests', async () => {
  const original = envelope(record(1), record(2)),
    f = database(original),
    storage = createDeviceDefaultsStorage();
  for (const records of [
    [original.records[1], original.records[0]],
    [record(3), ...original.records],
    [original.records[0], record(3), original.records[1]],
  ])
    await expect(storage.compareAndSwap(1, { ...original, revision: 2, records })).rejects.toThrow(
      /history cannot/,
    );
  expect(f.puts).toBe(0);
  expect(f.value).toEqual(original);
  const appended = { ...original, revision: 2, records: [...original.records, record(3)] };
  await storage.compareAndSwap(1, appended);
  expect((await storage.read()).records.map((r) => r.id)).toEqual([
    identifier(1),
    identifier(2),
    identifier(3),
  ]);
});

it('rejects a recovery preceding its original source without replacing the corrupt persisted chronology', async () => {
  const source = record(1),
    recovery = record(2);
  recovery.operation = 'recovery';
  recovery.sourceRecordId = source.id;
  recovery.roles[0].steps = [
    recovery.roles[0].steps[0],
    { ...recovery.roles[0].steps[3], id: 'restore-configuration' },
    { ...recovery.roles[0].steps[1], id: 'restore-settings' },
  ];
  expect(parseDeviceDefaultsEnvelope(envelope(source, recovery)).records).toHaveLength(2);
  const invalid = envelope(recovery, source),
    f = database(invalid),
    storage = createDeviceDefaultsStorage();
  await expect(storage.read()).rejects.toThrow(/earlier original/);
  await expect(storage.compareAndSwap(1, envelope(source, recovery))).rejects.toThrow(
    /earlier original/,
  );
  expect(f.value).toEqual(invalid);
  expect(f.puts).toBe(0);
});

it('refuses the 33rd retained request before a transaction without poisoning later writes or deleting recovery', async () => {
  const previous = envelope(
      ...Array.from({ length: MAX_DEVICE_DEFAULTS_RECORDS }, (_, i) => record(i + 1)),
    ),
    f = database(previous),
    storage = createDeviceDefaultsStorage();
  await expect(
    storage.compareAndSwap(1, {
      ...previous,
      revision: 2,
      records: [...previous.records, record(33)],
    }),
  ).rejects.toBeInstanceOf(DeviceDefaultsCapacityError);
  expect(f.db.transaction).not.toHaveBeenCalled();
  expect(await storage.read()).toEqual(previous);
  const next = structuredClone(previous);
  next.revision = 2;
  next.records[0].updatedAt++;
  await storage.compareAndSwap(1, next);
  expect(f.value).toEqual(next);
});

it('keeps capacity failures separate from schema errors and bounds actual UTF-8 journal bytes', () => {
  const records = Array.from({ length: 32 }, (_, i) => record(i + 1));
  for (const r of records) {
    r.error = '界'.repeat(2048);
    r.roles[0].error = '界'.repeat(2048);
    for (const s of r.roles[0].steps) s.error = '界'.repeat(2048);
  }
  expect(() => parseDeviceDefaultsEnvelope(envelope(...records))).toThrow(
    DeviceDefaultsCapacityError,
  );
});

it.each(['putFailure', 'commitFailure'] as const)(
  'does not acknowledge %s and leaves the previous journal untouched',
  async (failure) => {
    const f = database(),
      storage = createDeviceDefaultsStorage();
    f.db[failure] = true;
    await expect(storage.compareAndSwap(0, envelope(record()))).rejects.toThrow(/Injected/);
    expect(f.value).toBeUndefined();
    f.db[failure] = false;
    await storage.compareAndSwap(0, envelope(record()));
    expect(await storage.read()).toEqual(envelope(record()));
  },
);

it('does not acknowledge lost readback; retry finds the durable request and performs no duplicate put', async () => {
  const f = database(),
    storage = createDeviceDefaultsStorage(),
    next = envelope(record());
  f.db.readFailure = true;
  await expect(storage.compareAndSwap(0, next)).rejects.toThrow(/readback/);
  expect(f.value).toEqual(next);
  expect(f.puts).toBe(1);
  f.db.readFailure = false;
  await storage.compareAndSwap(0, next);
  expect(f.puts).toBe(1);
});

it('rejects corrupt or different durable readback without replacing it with an empty envelope', async () => {
  for (const altered of [null, { ...empty(), revision: 999 }, { ...empty(), version: 2 }]) {
    const f = database(),
      storage = createDeviceDefaultsStorage();
    f.db.overrideReadback = () => altered;
    await expect(storage.compareAndSwap(0, envelope(record()))).rejects.toThrow();
    expect(f.value).toEqual(envelope(record()));
    expect(f.puts).toBe(1);
  }
});

it('requests strict IndexedDB durability and fails closed if the browser silently downgrades it', async () => {
  const f = database(),
    storage = createDeviceDefaultsStorage();
  f.db.relaxed = true;
  await expect(storage.compareAndSwap(0, envelope(record()))).rejects.toThrow(/Strict/);
  expect(f.puts).toBe(0);
  expect(f.transactions[0].aborted).toBe(true);
});

it('creates only its own missing store and permanently fences an old client after versionchange or termination', async () => {
  for (const callback of ['blocking', 'terminated'] as const) {
    const f = database(),
      storage = createDeviceDefaultsStorage();
    await storage.read();
    expect(mock.openDB).toHaveBeenLastCalledWith(
      'fusion-studio-device-defaults',
      1,
      expect.any(Object),
    );
    const hooks = mock.openDB.mock.calls.at(-1)![2] as Hooks,
      createObjectStore = vi.fn();
    hooks.upgrade({ objectStoreNames: { contains: () => true }, createObjectStore });
    expect(createObjectStore).not.toHaveBeenCalled();
    hooks.upgrade({ objectStoreNames: { contains: () => false }, createObjectStore });
    expect(createObjectStore).toHaveBeenCalledExactlyOnceWith('state');
    hooks[callback]();
    await Promise.resolve();
    await expect(storage.read()).rejects.toThrow(/changed version/);
    await expect(storage.compareAndSwap(0, envelope(record()))).rejects.toThrow(/changed version/);
    expect(f.puts).toBe(0);
    if (callback === 'blocking') expect(f.db.close).toHaveBeenCalledOnce();
  }
});

it('reports missing IndexedDB without a volatile recovery substitute and retries an initial database-open failure', async () => {
  vi.stubGlobal('indexedDB', undefined);
  const storage = createDeviceDefaultsStorage();
  await expect(storage.read()).rejects.toThrow(/unavailable/);
  expect(mock.openDB).not.toHaveBeenCalled();
  vi.stubGlobal('indexedDB', {});
  const f = database();
  mock.openDB.mockRejectedValueOnce(new Error('Database blocked'));
  await expect(storage.read()).rejects.toThrow(/blocked/);
  expect(await storage.read()).toEqual(empty());
  expect(f.puts).toBe(0);
});

it('validates identical-write inputs before idempotent CAS acceptance', () => {
  const invalid = { ...empty(), version: 2 } as unknown as DefaultsJournalEnvelope;
  expect(() => assertDeviceDefaultsWrite(invalid, 0, invalid)).toThrow();
  expect(() => assertDeviceDefaultsWrite(empty(), -1, empty())).toThrow(/expected revision/);
});
