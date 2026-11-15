import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ openDB: vi.fn() }));
vi.mock('idb', () => ({ openDB: mock.openDB }));
import {
  assertNativeMixerWrite,
  createNativeMixerStorage,
  nativeMixerBeforeSha256,
  nativeMixerDesiredSha256,
  parseNativeMixerEnvelope,
  NativeMixerCapacityError,
  NativeMixerConflictError,
  type NativeMixerJournalEnvelope,
  type NativeMixerJournalRecord,
} from '../src/application/native-mixer-storage';
import { SimulatedPanel } from '../src/hardware/simulator';
import {
  decodeNativeMixer,
  nativeMixerEditorRow,
  planNativeMixer,
} from '../src/hardware/native-mixer';
import { hex } from '../src/hardware/codec';

const owner = 'workspace:11111111-1111-4111-8111-111111111111',
  id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
function record(n = 1): NativeMixerJournalRecord {
  const panel = new SimulatedPanel(`SYNTHETIC-${n}`);
  panel.configuration[4] = 2;
  panel.configuration[5] = panel.configuration[12] = 3;
  panel.deviceConfiguration[11] = 1;
  panel.deviceConfiguration[14] = 128;
  new DataView(panel.mixerConfiguration.buffer).setInt16(14, -32768, true);
  const capture = {
      identity: { serial: `SYNTHETIC-${n}`, product: 22, core: '5.1', firmware: '5.7' },
      status: panel.status,
      configuration: panel.configuration,
      deviceConfiguration: panel.deviceConfiguration,
      mixerConfiguration: panel.mixerConfiguration,
    },
    row = [...nativeMixerEditorRow(decodeNativeMixer(panel.mixerConfiguration)[0])];
  row[0] = Math.fround(0.1);
  const plan = planNativeMixer(capture, [{ preset: 1, weights: row }]),
    before = {
      statusHex: hex(capture.status),
      configurationHex: hex(capture.configuration),
      deviceConfigurationHex: hex(capture.deviceConfiguration),
      mixerHex: hex(capture.mixerConfiguration),
    },
    desired = {
      requestHex: hex(plan.request),
      expectedHex: hex(plan.verification.expected),
      maskHex: hex(plan.verification.mask),
    };
  return {
    id: id(n),
    owner,
    scope: 'ui:mixer',
    target: 'left',
    preset: 1,
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
    phase: 'prepared',
    roles: [
      {
        slot: 'left',
        identity: capture.identity,
        before,
        beforeSha256: nativeMixerBeforeSha256(before),
        desired,
        desiredSha256: nativeMixerDesiredSha256(desired),
        state: 'pending',
        attempted: false,
      },
    ],
  };
}
const empty = (): NativeMixerJournalEnvelope => ({ version: 1, revision: 0, records: [] });
const envelope = (...records: NativeMixerJournalRecord[]): NativeMixerJournalEnvelope => ({
  version: 1,
  revision: 1,
  records,
});
function database(initial?: unknown) {
  let value = structuredClone(initial),
    tail = Promise.resolve(),
    puts = 0;
  const transactions: { durability: string; aborted: boolean }[] = [],
    db = {
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
        tail = new Promise<void>((r) => {
          release = r;
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
          abort() {
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
afterEach(() => vi.unstubAllGlobals());

it('stores detached exact original/desired reports with strict durability and exact readback', async () => {
  const f = database(),
    storage = createNativeMixerStorage();
  expect(await storage.read()).toEqual(empty());
  expect(f.puts).toBe(0);
  const next = envelope(record()),
    saving = storage.compareAndSwap(0, next);
  next.records[0].scope = 'ui:mutated-after-call';
  await saving;
  expect(await storage.read()).toEqual(envelope(record()));
  expect(f.db.transaction).toHaveBeenCalledWith('state', 'readwrite', { durability: 'strict' });
  const loaded = await storage.read();
  loaded.records[0].roles[0].before.statusHex = 'ff'.repeat(64);
  expect(await storage.read()).toEqual(envelope(record()));
});

it('checks both image manifests against independent SHA-256 known answers', () => {
  const r = record().roles[0];
  expect(r.beforeSha256).toBe(
    createHash('sha256')
      .update(Buffer.from(Object.values(r.before).join(''), 'hex'))
      .digest('hex'),
  );
  expect(r.desiredSha256).toBe(
    createHash('sha256')
      .update(Buffer.from(Object.values(r.desired).join(''), 'hex'))
      .digest('hex'),
  );
  r.before.mixerHex = r.before.mixerHex.slice(0, 126) + '01';
  expect(() => parseNativeMixerEnvelope(envelope({ ...record(), roles: [r] }))).toThrow(/SHA/);
});

it.each([
  null,
  {},
  { version: 2, revision: 0, records: [] },
  { version: 1, revision: 0, records: [], extra: true },
])('does not replace corrupt stored state %j', async (invalid) => {
  const f = database(invalid),
    storage = createNativeMixerStorage();
  await expect(storage.read()).rejects.toThrow();
  await expect(storage.compareAndSwap(0, envelope(record()))).rejects.toThrow();
  expect(f.value).toEqual(invalid);
  expect(f.puts).toBe(0);
});

it('rejects unsafe owner/identity/reports, changed inactive words, forged hashes and false success ledgers', () => {
  const changes: ((r: NativeMixerJournalRecord) => void)[] = [
    (r) => {
      r.owner = 'site:caller';
    },
    (r) => {
      r.id = 'not-a-uuid';
    },
    (r) => {
      r.roles[0].identity.firmware = '5.82';
    },
    (r) => {
      r.roles[0].before.statusHex = '0500';
    },
    (r) => {
      r.roles[0].desired.maskHex = 'ff'.repeat(64);
      r.roles[0].desiredSha256 = nativeMixerDesiredSha256(r.roles[0].desired);
    },
    (r) => {
      const role = r.roles[0];
      role.desired.requestHex =
        role.desired.requestHex.slice(0, 28) + '0100' + role.desired.requestHex.slice(32);
      role.desired.expectedHex =
        role.desired.requestHex.slice(0, 2) + '00' + role.desired.requestHex.slice(4);
      role.desiredSha256 = nativeMixerDesiredSha256(role.desired);
    },
    (r) => {
      r.phase = 'complete';
    },
    (r) => {
      r.roles[0].state = 'verified';
      r.roles[0].attempted = true;
    },
    (r) => {
      r.phase = 'partial';
    },
    (r) => {
      r.target = 'both';
    },
    (r) => {
      r.roles[0].state = 'blocked';
      r.roles[0].attempted = true;
    },
    (r) => {
      r.roles[0].state = 'unchanged';
    },
  ];
  for (const change of changes) {
    const r = record();
    change(r);
    expect(() => parseNativeMixerEnvelope(envelope(r))).toThrow();
  }
});

it('serializes CAS writers, rejects a stale loser and permits only identical idempotent replay', async () => {
  const f = database(),
    a = createNativeMixerStorage(),
    b = createNativeMixerStorage(),
    outcomes = await Promise.allSettled([
      a.compareAndSwap(0, envelope(record(1))),
      b.compareAndSwap(0, envelope(record(2))),
    ]);
  expect(outcomes.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
  expect((outcomes[1] as PromiseRejectedResult).reason).toBeInstanceOf(NativeMixerConflictError);
  await b.compareAndSwap(0, envelope(record(1)));
  expect(f.puts).toBe(1);
  expect(f.value).toEqual(envelope(record(1)));
});

it('preserves immutable actor, target, originals, plans and append-only request chronology', () => {
  const prior = envelope(record(1), record(2));
  for (const change of [
    (v: NativeMixerJournalEnvelope) => {
      v.records.reverse();
    },
    (v: NativeMixerJournalEnvelope) => {
      v.records.unshift(record(3));
    },
    (v: NativeMixerJournalEnvelope) => {
      v.records[0].scope = 'paired:other';
    },
    (v: NativeMixerJournalEnvelope) => {
      v.records[0].preset = 2;
    },
    (v: NativeMixerJournalEnvelope) => {
      v.records = [];
    },
    (v: NativeMixerJournalEnvelope) => {
      v.records[0].roles[0].identity.serial = 'CHANGED';
    },
  ]) {
    const next = structuredClone(prior);
    next.revision = 2;
    change(next);
    expect(() => assertNativeMixerWrite(prior, 1, next)).toThrow();
  }
  expect(() =>
    assertNativeMixerWrite(prior, 1, {
      ...prior,
      revision: 2,
      records: [...prior.records, record(3)],
    }),
  ).not.toThrow();
});

it('records durable intent separately from actual transmission, then keeps partial/complete receipts immutable', () => {
  const prepared = envelope(record()),
    running = structuredClone(prepared);
  running.revision = 2;
  running.records[0].phase = 'running';
  running.records[0].roles[0].state = 'intent';
  expect(() => assertNativeMixerWrite(prepared, 1, running)).not.toThrow();
  expect(running.records[0].roles[0].attempted).toBe(false);
  const partial = structuredClone(running);
  partial.revision = 3;
  partial.records[0].phase = 'partial';
  Object.assign(partial.records[0].roles[0], {
    state: 'unconfirmed',
    attempted: true,
    error: 'ACK lost',
  });
  expect(() => assertNativeMixerWrite(running, 2, partial)).not.toThrow();
  const changed = structuredClone(partial);
  changed.revision = 4;
  changed.records[0].error = 'Late observer failure';
  expect(() => assertNativeMixerWrite(partial, 3, changed)).toThrow(/historical/);
  const complete = structuredClone(running);
  complete.revision = 3;
  complete.records[0].phase = 'complete';
  Object.assign(complete.records[0].roles[0], {
    state: 'verified',
    attempted: true,
    actualHex: complete.records[0].roles[0].desired.expectedHex,
  });
  expect(() => assertNativeMixerWrite(running, 2, complete)).not.toThrow();
  const downgraded = structuredClone(complete);
  downgraded.revision = 4;
  downgraded.records[0].phase = 'partial';
  expect(() => assertNativeMixerWrite(complete, 3, downgraded)).toThrow(/historical/);
});

it('rejects capacity before opening a transaction and remains usable for an admissible write', async () => {
  const f = database(),
    storage = createNativeMixerStorage();
  await expect(
    storage.compareAndSwap(0, envelope(...Array.from({ length: 33 }, (_, i) => record(i + 1)))),
  ).rejects.toBeInstanceOf(NativeMixerCapacityError);
  expect(f.db.transaction).not.toHaveBeenCalled();
  await storage.compareAndSwap(0, envelope(record()));
  expect(f.puts).toBe(1);
});

it.each(['relaxed', 'commitFailure', 'putFailure', 'readFailure'] as const)(
  'does not acknowledge %s durability/write/readback failure',
  async (key) => {
    const f = database(),
      storage = createNativeMixerStorage();
    f.db[key] = true;
    await expect(storage.compareAndSwap(0, envelope(record()))).rejects.toThrow();
    if (key === 'readFailure') expect(f.value).toEqual(envelope(record()));
    else expect(f.value).toBeUndefined();
  },
);

it('rejects silently substituted readback and fences old connections on version change', async () => {
  const f = database(),
    storage = createNativeMixerStorage();
  f.db.overrideReadback = (value) => ({ ...(value as object), revision: 99 });
  await expect(storage.compareAndSwap(0, envelope(record()))).rejects.toThrow(/readback/);
  const hooks = mock.openDB.mock.calls[0][2] as { blocking(): void };
  hooks.blocking();
  await Promise.resolve();
  expect(f.db.close).toHaveBeenCalled();
  await expect(storage.read()).rejects.toThrow(/version/);
});
