import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ openDB: vi.fn() }));
vi.mock('idb', () => ({ openDB: mock.openDB }));
import {
  CLONE_PHASES,
  MAX_DEVICE_CLONE_BYTES,
  MAX_DEVICE_CLONE_RECORDS,
  DeviceCloneCapacityError,
  DeviceCloneConflictError,
  assertDeviceCloneCapacity,
  assertDeviceCloneWrite,
  cloneBytesSha256,
  cloneImageSha256,
  createDeviceCloneStorage,
  parseDeviceCloneEnvelope,
  type CloneBeforeImage,
  type CloneDesiredImage,
  type CloneJournalEnvelope,
  type CloneJournalRecord,
  type CloneMemoryImage,
} from '../src/application/device-clone-storage';

const owner = 'workspace:11111111-1111-1111-1111-111111111111';
const identifier = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function image(address: number, length: number, value: number): CloneMemoryImage {
  const raw = Uint8Array.from({ length }, (_, i) => (i * 31 + value) & 255);
  return { address, hex: hex(raw), sha256: sha(raw) };
}
function record(n = 1): CloneJournalRecord {
  const status = new Uint8Array(64),
    configuration = new Uint8Array(64),
    device = new Uint8Array(64),
    dsp = new Uint8Array(64),
    serial = new Uint8Array(32);
  status.set([5, 6, 1]);
  configuration.set([6, 22, 5, 1]);
  configuration[15] = 5;
  configuration[17] = 7;
  device[0] = 0x66;
  device[10] = 5;
  device[11] = 9;
  device[12] = 22;
  dsp.set([3, 8]);
  serial.set(Buffer.from(`SIM-${n}`));
  const flash = Array.from({ length: 24 }, (_, i) => image(0x10000 + i * 4096, 4096, i)),
    filenames = Array.from({ length: 12 }, (_, i) => image(0x200 + i * 32, 32, i)),
    before: CloneBeforeImage = {
      statusHex: hex(status),
      configurationHex: hex(configuration),
      deviceConfigurationHex: hex(device),
      dspNameHex: hex(dsp),
      serialHex: hex(serial),
      flash,
      filenames,
      sha256: '',
    };
  before.sha256 = cloneImageSha256(before);
  const desired: CloneDesiredImage = {
    reports: (['mute', 'settings', 'configuration', 'display'] as const).map((id) => {
      const request = (id === 'configuration' ? device : status).slice();
      request[1] = id === 'configuration' ? 1 : 0;
      return {
        id,
        requestHex: hex(request),
        expectedHex: hex(id === 'configuration' ? device : status),
        maskHex: 'ff'.repeat(64),
      };
    }),
    presetActivations: ([1, 2, 3] as const).map((preset) => {
      const request = status.slice(),
        expected = status.slice();
      request[1] = 0;
      request[6] = 128;
      expected[6] = 128;
      return {
        preset,
        requestHex: hex(request),
        expectedHex: hex(expected),
        maskHex: 'ff'.repeat(64),
      };
    }),
    dspNameHex: '0300' + '00'.repeat(62),
    flash: structuredClone(flash),
    filenames: structuredClone(filenames),
    sha256: '',
  };
  desired.sha256 = cloneImageSha256(desired);
  return {
    id: identifier(n),
    owner,
    scope: 'ui:synthetic-scope',
    target: 'left',
    templateSha256: '12'.repeat(32),
    designSha256: '34'.repeat(32),
    documentRevision: 7,
    templateRevision: 2,
    overrideRevision: 3,
    createdAt: 100,
    updatedAt: 100,
    phase: 'prepared',
    roles: [
      {
        slot: 'left',
        identity: { serial: `SIM-${n}`, product: 22, core: '5.1', firmware: '5.7' },
        overrides: {
          mode: 'master',
          presets: Array.from({ length: 3 }, () => ({
            forceInput: 1,
            sourceLock: false,
            volumeLock: false,
          })),
        },
        before,
        desired,
        backupIds: [identifier(100 + n)],
        preflight: 'verified',
        lastConfirmedMuted: false,
        steps: CLONE_PHASES.map((id) => ({
          id,
          attempted: false,
          state: id === 'product-configuration' ? 'skipped' : 'pending',
        })),
      },
    ],
  };
}
const empty = (): CloneJournalEnvelope => ({ version: 1, revision: 0, records: [] });
const envelope = (...records: CloneJournalRecord[]): CloneJournalEnvelope => ({
  version: 1,
  revision: 1,
  records,
});
const next = (value: CloneJournalEnvelope) => ({
  ...structuredClone(value),
  revision: value.revision + 1,
});
function completed(value: CloneJournalRecord): CloneJournalRecord {
  const r = structuredClone(value);
  r.phase = 'complete';
  r.updatedAt++;
  for (const part of r.roles[0].steps)
    if (part.state !== 'skipped') {
      part.attempted = true;
      part.state = 'verified';
    }
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
  const transactions: { durability: string; aborted: boolean }[] = [];
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
      const state = { durability: db.relaxed ? 'relaxed' : 'strict', aborted: false };
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

it('does not write on an empty read and strictly persists detached complete 3-preset recovery images and plans', async () => {
  const f = database(),
    storage = createDeviceCloneStorage();
  expect(await storage.read()).toEqual(empty());
  expect(f.puts).toBe(0);
  const desired = envelope(record()),
    original = structuredClone(desired),
    writing = storage.compareAndSwap(0, desired);
  desired.records[0].roles[0].before.flash[0].hex = 'ff'.repeat(4096);
  await writing;
  expect(await storage.read()).toEqual(original);
  expect(f.db.transaction).toHaveBeenCalledWith('state', 'readwrite', { durability: 'strict' });
  const read = await storage.read();
  read.records[0].roles[0].desired.filenames[0].hex = '00'.repeat(32);
  expect(await storage.read()).toEqual(original);
});

it('uses independently checked SHA-256 for every memory byte and a canonical addressed manifest', () => {
  const original = record().roles[0].before;
  expect(cloneBytesSha256('000102ff')).toBe(sha(Uint8Array.of(0, 1, 2, 255)));
  const expected = [
    'before',
    original.statusHex,
    original.configurationHex,
    original.deviceConfigurationHex,
    original.dspNameHex,
    original.serialHex,
    original.flash.map(({ address, sha256 }) => [address, sha256]),
    original.filenames.map(({ address, sha256 }) => [address, sha256]),
    null,
  ];
  expect(original.sha256).toBe(sha(JSON.stringify(expected)));
  const r = record();
  r.roles[0].before.flash[7].hex = '00'.repeat(4096);
  expect(() => parseDeviceCloneEnvelope(envelope(r))).toThrow(/corrupt sectors/);
});

it.each([
  null,
  {},
  { version: 2, revision: 0, records: [] },
  { version: 1, revision: 0, records: [], extra: true },
])('retains invalid prior data %j and refuses replacement', async (invalid) => {
  const f = database(invalid),
    storage = createDeviceCloneStorage();
  await expect(storage.read()).rejects.toThrow();
  await expect(storage.compareAndSwap(0, envelope(record()))).rejects.toThrow();
  expect(f.value).toEqual(invalid);
  expect(f.puts).toBe(0);
});

it('rejects incomplete/corrupt backup coverage, source-identity changes, unsafe plans and fake completion', () => {
  const changes: ((r: CloneJournalRecord) => void)[] = [
    (r) => {
      r.owner = 'site:spoofed';
    },
    (r) => {
      r.roles[0].before.flash.splice(8, 1);
    },
    (r) => {
      r.roles[0].desired.filenames[3].address = 0x100;
    },
    (r) => {
      r.roles[0].before.flash[0].address = 0;
    },
    (r) => {
      r.roles[0].before.serialHex = '00'.repeat(32);
      r.roles[0].before.sha256 = cloneImageSha256(r.roles[0].before);
    },
    (r) => {
      r.roles[0].identity.firmware = '5.82';
    },
    (r) => {
      r.roles[0].desired.reports[0].requestHex = '040203' + '00'.repeat(61);
      r.roles[0].desired.sha256 = cloneImageSha256(r.roles[0].desired);
    },
    (r) => {
      const d = r.roles[0].desired;
      d.reports[2].requestHex =
        d.reports[2].requestHex.slice(0, 22) + '01' + d.reports[2].requestHex.slice(24);
      d.sha256 = cloneImageSha256(d);
    },
    (r) => {
      r.roles[0].steps.splice(5, 1);
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
    (r) => {
      r.roles[0].steps[1].state = 'pending';
    },
    (r) => {
      r.roles[0].overrides.presets[0].forceInput = 8;
    },
  ];
  for (const change of changes) {
    const r = record();
    change(r);
    expect(() => parseDeviceCloneEnvelope(envelope(r))).toThrow();
  }
});

it('persists native Future input 7 exactly while refusing the out-of-range value 8', async () => {
  const f = database(),
    storage = createDeviceCloneStorage(),
    proposed = envelope(record());
  proposed.records[0].roles[0].overrides.presets[2].forceInput = 7;
  await storage.compareAndSwap(0, proposed);
  expect((await storage.read()).records[0].roles[0].overrides.presets[2].forceInput).toBe(7);
  expect(f.value).toEqual(proposed);
  const invalid = next(proposed);
  invalid.records[0].roles[0].overrides.presets[1].forceInput = 8;
  await expect(storage.compareAndSwap(1, invalid)).rejects.toThrow();
  expect(f.puts).toBe(1);
});

it('requires OEM original string bytes and a non-skipped product phase only for the OEM module', () => {
  const r = record(),
    role = r.roles[0];
  for (const key of ['before', 'desired'] as const) {
    const target = role[key];
    target.oemStrings = [image(0x120, 32, 1), image(0x140, 32, 2)];
    if ('deviceConfigurationHex' in target)
      target.deviceConfigurationHex =
        target.deviceConfigurationHex.slice(0, 22) + '01' + target.deviceConfigurationHex.slice(24);
    else
      target.reports[2].requestHex =
        target.reports[2].requestHex.slice(0, 22) + '01' + target.reports[2].requestHex.slice(24);
    target.sha256 = cloneImageSha256(target);
  }
  role.steps[1].state = 'pending';
  expect(parseDeviceCloneEnvelope(envelope(r)).records[0].roles[0].before.oemStrings).toHaveLength(
    2,
  );
  delete role.before.oemStrings;
  role.before.sha256 = cloneImageSha256(role.before);
  expect(() => parseDeviceCloneEnvelope(envelope(r))).toThrow(/OEM/);
});

it('binds all three exact muted preset activation reports and rejects wrong order, active preset, security changes and triggers', () => {
  const original = record();
  expect(
    parseDeviceCloneEnvelope(envelope(original)).records[0].roles[0].desired.presetActivations.map(
      (a) => a.preset,
    ),
  ).toEqual([1, 2, 3]);
  const mutations: ((value: CloneDesiredImage) => void)[] = [
    (value) => {
      value.presetActivations.pop();
    },
    (value) => {
      value.presetActivations.reverse();
    },
    ...[2, 6, 23, 24, 25].map((offset) => (value: CloneDesiredImage) => {
      const a = value.presetActivations[1],
        raw = Buffer.from(a.requestHex, 'hex');
      raw[offset] = offset === 6 ? 0 : raw[offset] ^ 1;
      a.requestHex = raw.toString('hex');
    }),
  ];
  for (const change of mutations) {
    const r = record(),
      d = r.roles[0].desired;
    change(d);
    d.sha256 = cloneImageSha256(d);
    expect(() => parseDeviceCloneEnvelope(envelope(r))).toThrow();
  }
  const prior = envelope(original),
    changed = next(prior),
    d = changed.records[0].roles[0].desired;
  const raw = Buffer.from(d.presetActivations[0].requestHex, 'hex');
  raw[28] ^= 1;
  d.presetActivations[0].requestHex = raw.toString('hex');
  d.sha256 = cloneImageSha256(d);
  expect(() => assertDeviceCloneWrite(prior, 1, changed)).toThrow(/cannot change/);
});

it('allows read-only preflight failure with no attempt but preserves attempted/unconfirmed partial truth', () => {
  const r = record();
  r.phase = 'failed';
  r.roles[0].preflight = 'failed';
  r.roles[0].steps[0].state = 'failed';
  expect(parseDeviceCloneEnvelope(envelope(r)).records[0].phase).toBe('failed');
  r.roles[0].preflight = 'verified';
  r.roles[0].steps[0].attempted = true;
  r.roles[0].steps[0].state = 'unconfirmed';
  r.phase = 'partial';
  expect(parseDeviceCloneEnvelope(envelope(r)).records[0].roles[0].steps[0]).toMatchObject({
    attempted: true,
    state: 'unconfirmed',
  });
  r.phase = 'failed';
  expect(() => parseDeviceCloneEnvelope(envelope(r))).toThrow(/attempted/);
});

it('durably records ready intent without claiming a setter, permits final-preflight refusal, and refuses resetting intent for replay', async () => {
  const f = database(),
    storage = createDeviceCloneStorage(),
    prepared = envelope(record());
  await storage.compareAndSwap(0, prepared);
  const ready = next(prepared);
  ready.records[0].phase = 'running';
  ready.records[0].roles[0].steps[0].state = 'ready';
  await storage.compareAndSwap(1, ready);
  expect((await storage.read()).records[0].roles[0].steps[0]).toEqual({
    id: 'mute',
    attempted: false,
    state: 'ready',
  });
  const reset = next(ready);
  reset.records[0].roles[0].steps[0].state = 'pending';
  expect(() => assertDeviceCloneWrite(ready, 2, reset)).toThrow(/reset/);
  const refused = next(ready);
  refused.records[0].phase = 'failed';
  refused.records[0].roles[0].steps[0].state = 'failed';
  refused.records[0].roles[0].steps[0].error = 'Captured connection changed before send';
  await storage.compareAndSwap(2, refused);
  expect((await storage.read()).records[0].roles[0].steps[0].attempted).toBe(false);
  expect(f.puts).toBe(3);
});

it('supports both independent roles while rejecting duplicate physical identities before persistence', () => {
  const r = record(),
    right = record(2).roles[0];
  right.slot = 'right';
  r.target = 'both';
  r.roles.push(right);
  expect(parseDeviceCloneEnvelope(envelope(r)).records[0].roles).toHaveLength(2);
  r.roles[1] = structuredClone(r.roles[0]);
  r.roles[1].slot = 'right';
  expect(() => parseDeviceCloneEnvelope(envelope(r))).toThrow(/independent/);
});

it('retains independent role document/template revisions and prevents changing their captured provenance', () => {
  const left = record(),
    right = record(2).roles[0];
  right.slot = 'right';
  left.target = 'both';
  left.roles[0].documentRevision = 4;
  left.roles[0].templateRevision = 2;
  right.documentRevision = 19;
  right.templateRevision = 7;
  left.roles.push(right);
  const prior = envelope(left),
    parsed = parseDeviceCloneEnvelope(prior);
  expect(
    parsed.records[0].roles.map((role) => [role.documentRevision, role.templateRevision]),
  ).toEqual([
    [4, 2],
    [19, 7],
  ]);
  const altered = next(prior);
  altered.records[0].roles[1].documentRevision = 20;
  expect(() => assertDeviceCloneWrite(prior, 1, altered)).toThrow(/cannot change/);
});

it('keeps immutable owner, identities, before/desired bytes, overrides and design/template binding across CAS', () => {
  const prior = envelope(record()),
    mutations: ((r: CloneJournalRecord) => void)[] = [
      (r) => {
        r.owner = 'workspace:22222222-2222-2222-2222-222222222222';
      },
      (r) => {
        r.scope = 'different';
      },
      (r) => {
        r.templateSha256 = 'ab'.repeat(32);
      },
      (r) => {
        r.designSha256 = 'cd'.repeat(32);
      },
      (r) => {
        r.documentRevision++;
      },
      (r) => {
        r.templateRevision++;
      },
      (r) => {
        r.overrideRevision++;
      },
      (r) => {
        r.roles[0].overrides.mode = 'slave';
      },
      (r) => {
        r.roles[0].backupIds = [];
      },
      (r) => {
        r.roles[0].desired.filenames[0] = image(0x200, 32, 99);
        r.roles[0].desired.sha256 = cloneImageSha256(r.roles[0].desired);
      },
    ];
  for (const mutate of mutations) {
    const proposed = next(prior);
    mutate(proposed.records[0]);
    expect(() => assertDeviceCloneWrite(prior, 1, proposed)).toThrow(/cannot change/);
  }
});

it('requires append-only UUID history and prepared durable images before any new running/complete record', () => {
  const prior = envelope(record(1), record(2));
  for (const records of [[prior.records[1], prior.records[0]], [record(3), ...prior.records], []])
    expect(() => assertDeviceCloneWrite(prior, 1, { version: 1, revision: 2, records })).toThrow(
      /history/,
    );
  const proposed = next(prior);
  proposed.records.push(completed(record(3)));
  expect(() => assertDeviceCloneWrite(prior, 1, proposed)).toThrow(/first persist/);
  proposed.records[2] = record(3);
  expect(() => assertDeviceCloneWrite(prior, 1, proposed)).not.toThrow();
  proposed.records[2].id = proposed.records[0].id;
  expect(() => parseDeviceCloneEnvelope(proposed)).toThrow(/Duplicate/);
});

it('replays a verified durable receipt exactly and prevents completion/attempt regression or hidden retry resets', async () => {
  const f = database(),
    storage = createDeviceCloneStorage(),
    prepared = envelope(record());
  await storage.compareAndSwap(0, prepared);
  const complete = next(prepared);
  complete.records[0] = completed(complete.records[0]);
  await storage.compareAndSwap(1, complete);
  const writes = f.puts;
  await storage.compareAndSwap(1, complete);
  expect(f.puts).toBe(writes);
  const altered = next(complete);
  altered.records[0].error = 'different';
  expect(() => assertDeviceCloneWrite(complete, 2, altered)).toThrow(/historical/);
  const partial = next(prepared);
  partial.records[0].phase = 'partial';
  partial.records[0].roles[0].steps[0] = { id: 'mute', attempted: true, state: 'unconfirmed' };
  const reset = next(partial);
  reset.records[0].phase = 'running';
  reset.records[0].roles[0].steps[0] = { id: 'mute', attempted: false, state: 'pending' };
  expect(() => assertDeviceCloneWrite(partial, 2, reset)).toThrow(/erased|reset/);
});

it('uses fresh transactional revisions to reject a stale second writer while retaining the first complete plan', async () => {
  const f = database(),
    a = createDeviceCloneStorage(),
    b = createDeviceCloneStorage(),
    first = envelope(record(1));
  await a.compareAndSwap(0, first);
  await expect(b.compareAndSwap(0, envelope(record(2)))).rejects.toBeInstanceOf(
    DeviceCloneConflictError,
  );
  expect(f.value).toEqual(first);
  expect(f.puts).toBe(1);
});

it('fails capacity before opening a database and keeps the existing journal usable after a rejected append', async () => {
  const over = {
    version: 1 as const,
    revision: 1,
    records: Array.from({ length: MAX_DEVICE_CLONE_RECORDS + 1 }, (_, i) => record(i + 1)),
  };
  await expect(createDeviceCloneStorage().compareAndSwap(0, over)).rejects.toBeInstanceOf(
    DeviceCloneCapacityError,
  );
  expect(mock.openDB).not.toHaveBeenCalled();
  expect(() =>
    assertDeviceCloneCapacity({
      version: 1,
      revision: 0,
      records: [{ error: 'x'.repeat(MAX_DEVICE_CLONE_BYTES) } as CloneJournalRecord],
    }),
  ).toThrow(DeviceCloneCapacityError);
  const f = database(),
    storage = createDeviceCloneStorage();
  await storage.compareAndSwap(0, envelope(record()));
  expect(f.puts).toBe(1);
});

it.each(['relaxed', 'putFailure', 'commitFailure'] as const)(
  'does not acknowledge %s persistence and preserves prior data',
  async (failure) => {
    const prior = envelope(record()),
      f = database(prior),
      storage = createDeviceCloneStorage(),
      proposed = next(prior);
    proposed.records.push(record(2));
    f.db[failure] = true;
    await expect(storage.compareAndSwap(1, proposed)).rejects.toThrow();
    expect(f.value).toEqual(prior);
  },
);

it('does not acknowledge lost/corrupt durable readback; same-ID read recovery finds the applied prepared record', async () => {
  const f = database(),
    storage = createDeviceCloneStorage(),
    proposed = envelope(record());
  f.db.readFailure = true;
  await expect(storage.compareAndSwap(0, proposed)).rejects.toThrow(/readback failure/);
  f.db.readFailure = false;
  expect(await storage.read()).toEqual(proposed);
  await storage.compareAndSwap(0, proposed);
  expect(f.puts).toBe(1);
  f.db.overrideReadback = (value) => {
    const copy = structuredClone(value) as CloneJournalEnvelope;
    copy.records[0].roles[0].before.flash[0].hex = 'ff'.repeat(4096);
    return copy;
  };
  await expect(storage.compareAndSwap(0, proposed)).rejects.toThrow(/corrupt sectors/);
});

it('fails closed when IndexedDB is missing and fences old clients after version change or termination', async () => {
  vi.stubGlobal('indexedDB', undefined);
  await expect(createDeviceCloneStorage().read()).rejects.toThrow(/unavailable/);
  expect(mock.openDB).not.toHaveBeenCalled();
  vi.stubGlobal('indexedDB', {});
  for (const callback of ['blocking', 'terminated'] as const) {
    const f = database(),
      storage = createDeviceCloneStorage();
    await storage.read();
    const hooks = mock.openDB.mock.calls.at(-1)![2] as Hooks;
    hooks[callback]();
    await expect(storage.read()).rejects.toThrow(/changed version/);
    await expect(storage.compareAndSwap(0, envelope(record()))).rejects.toThrow(/changed version/);
    expect(f.puts).toBe(0);
  }
});
