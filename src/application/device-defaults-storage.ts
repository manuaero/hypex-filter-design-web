import { openDB, type IDBPDatabase } from 'idb';
import { z } from 'zod';
import { Sha256 } from './file-transfers';

export interface DefaultsJournalStep {
  id:
    | 'mute'
    | 'settings'
    | 'mixer'
    | 'configuration'
    | 'display'
    | 'restore-configuration'
    | 'restore-settings';
  requestHex: string;
  expectedHex: string;
  maskHex: string;
  /** Persisted before send; true conservatively includes a crash with an unknown send outcome. */
  attempted: boolean;
  state: 'pending' | 'attempted' | 'verified' | 'failed';
  error?: string;
}
export interface DefaultsJournalRole {
  slot: 'left' | 'right';
  identity: { serial: string; product: number; core: string; firmware: string };
  before: { statusHex: string; configurationHex: string; deviceConfigurationHex: string };
  /** SHA-256 of the 64-byte 05, 06 and 66 records concatenated in that order. */
  beforeSha256: string;
  steps: DefaultsJournalStep[];
  preflight: 'pending' | 'verified' | 'failed';
  lastConfirmedMuted: boolean;
  error?: string;
}
export interface DefaultsJournalRecord {
  /** Immutable request UUID; a retry never allocates another identity for the same operation. */
  id: string;
  owner: string;
  scope: string;
  appliedScope?: string;
  operation: 'defaults' | 'recovery';
  sourceRecordId?: string;
  target: 'left' | 'right' | 'both';
  createdAt: number;
  updatedAt: number;
  phase: 'prepared' | 'running' | 'complete' | 'partial' | 'failed';
  roles: DefaultsJournalRole[];
  error?: string;
}
export interface DefaultsJournalEnvelope {
  version: 1;
  revision: number;
  records: DefaultsJournalRecord[];
}
export interface DeviceDefaultsStorage {
  read(): Promise<DefaultsJournalEnvelope>;
  compareAndSwap(expectedRevision: number, next: DefaultsJournalEnvelope): Promise<void>;
}

export const DEVICE_DEFAULTS_DATABASE = 'fusion-studio-device-defaults';
export const MAX_DEVICE_DEFAULTS_RECORDS = 32;
export const MAX_DEVICE_DEFAULTS_BYTES = 1024 * 1024;
export class DeviceDefaultsCapacityError extends Error {
  constructor() {
    super(
      'Device Defaults recovery storage is full (32 records or 1 MiB). Existing recovery records were retained; no device operation was started.',
    );
    this.name = 'DeviceDefaultsCapacityError';
  }
}
export class DeviceDefaultsConflictError extends Error {
  constructor() {
    super('Device Defaults storage changed in another tab; reload its journal before continuing.');
    this.name = 'DeviceDefaultsConflictError';
  }
}

const uuid = z.string().regex(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i),
  owner = z.string().regex(/^workspace:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i),
  text = z
    .string()
    .min(1)
    .max(512)
    .regex(/^[^\u0000-\u001f\u007f]+$/),
  error = z.string().max(2048),
  integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  hex = z.string().regex(/^[a-f\d]{128}$/),
  digest = z.string().regex(/^[a-f\d]{64}$/),
  step = z
    .object({
      id: z.enum([
        'mute',
        'settings',
        'mixer',
        'configuration',
        'display',
        'restore-configuration',
        'restore-settings',
      ]),
      requestHex: hex,
      expectedHex: hex,
      maskHex: hex,
      attempted: z.boolean(),
      state: z.enum(['pending', 'attempted', 'verified', 'failed']),
      error: error.optional(),
    })
    .strict(),
  role = z
    .object({
      slot: z.enum(['left', 'right']),
      identity: z
        .object({ serial: text, product: integer.max(255), core: text, firmware: text })
        .strict(),
      before: z
        .object({ statusHex: hex, configurationHex: hex, deviceConfigurationHex: hex })
        .strict(),
      beforeSha256: digest,
      steps: z.array(step).min(1).max(5),
      preflight: z.enum(['pending', 'verified', 'failed']),
      lastConfirmedMuted: z.boolean(),
      error: error.optional(),
    })
    .strict(),
  record = z
    .object({
      id: uuid,
      owner,
      scope: text,
      appliedScope: text.optional(),
      operation: z.enum(['defaults', 'recovery']),
      sourceRecordId: uuid.optional(),
      target: z.enum(['left', 'right', 'both']),
      createdAt: integer,
      updatedAt: integer,
      phase: z.enum(['prepared', 'running', 'complete', 'partial', 'failed']),
      roles: z.array(role).min(1).max(2),
      error: error.optional(),
    })
    .strict(),
  envelope = z
    .object({ version: z.literal(1), revision: integer, records: z.array(record) })
    .strict();

const bytes = (value: string) => Uint8Array.from(value.match(/../g)!, (part) => parseInt(part, 16));
export function defaultsBeforeSha256(before: DefaultsJournalRole['before']): string {
  return new Sha256()
    .update(bytes(hex.parse(before.statusHex)))
    .update(bytes(hex.parse(before.configurationHex)))
    .update(bytes(hex.parse(before.deviceConfigurationHex)))
    .digest();
}
export function assertDeviceDefaultsCapacity(value: DefaultsJournalEnvelope): void {
  if (
    value.records.length > MAX_DEVICE_DEFAULTS_RECORDS ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_DEVICE_DEFAULTS_BYTES
  )
    throw new DeviceDefaultsCapacityError();
}

/** Strict, detached validation. Invalid persisted data is never treated as an empty journal. */
export function parseDeviceDefaultsEnvelope(value: unknown): DefaultsJournalEnvelope {
  if (
    value &&
    typeof value === 'object' &&
    'records' in value &&
    Array.isArray(value.records) &&
    value.records.length > MAX_DEVICE_DEFAULTS_RECORDS
  )
    throw new DeviceDefaultsCapacityError();
  const parsed = envelope.parse(value);
  assertDeviceDefaultsCapacity(parsed);
  if (new Set(parsed.records.map((item) => item.id.toLowerCase())).size !== parsed.records.length)
    throw new Error('Duplicate Device Defaults request identifiers');
  for (const [index, item] of parsed.records.entries()) {
    const slots = item.roles.map((entry) => entry.slot);
    if (
      item.updatedAt < item.createdAt ||
      new Set(slots).size !== slots.length ||
      (item.target === 'both' ? slots.length !== 2 : slots.length !== 1 || slots[0] !== item.target)
    )
      throw new Error('Invalid Device Defaults target or timestamps');
    if (
      (item.operation === 'recovery') !== (item.sourceRecordId !== undefined) ||
      item.sourceRecordId?.toLowerCase() === item.id.toLowerCase()
    )
      throw new Error('Invalid Device Defaults recovery source');
    for (const entry of item.roles) {
      const configuration = bytes(entry.before.configurationHex),
        configurationView = new DataView(configuration.buffer),
        expectedStepIds =
          item.operation === 'defaults'
            ? ['mute', 'settings', 'mixer', 'configuration', 'display']
            : ['mute', 'restore-configuration', 'restore-settings'];
      if (
        !entry.before.statusHex.startsWith('05') ||
        !entry.before.configurationHex.startsWith('06') ||
        !entry.before.deviceConfigurationHex.startsWith('66') ||
        defaultsBeforeSha256(entry.before) !== entry.beforeSha256
      )
        throw new Error('Device Defaults original records or checksum are invalid');
      if (
        entry.identity.product !== configuration[1] ||
        entry.identity.product !== bytes(entry.before.deviceConfigurationHex)[12] ||
        entry.identity.core !== `${configuration[2]}.${configuration[3]}` ||
        entry.identity.firmware !==
          `${configurationView.getUint16(15, true)}.${configurationView.getUint16(17, true)}`
      )
        throw new Error('Device Defaults identity differs from its original configuration');
      if (
        !same(
          entry.steps.map((part) => part.id),
          expectedStepIds,
        )
      )
        throw new Error('Device Defaults steps are incomplete or out of native order');
      for (const part of entry.steps) {
        const configurationWrite =
            part.id === 'configuration' || part.id === 'restore-configuration',
          command = configurationWrite ? '66' : '05',
          selector = configurationWrite ? '01' : '00';
        if (
          !part.requestHex.startsWith(command + selector) ||
          !part.expectedHex.startsWith(command)
        )
          throw new Error('Device Defaults step contains an unsupported report command');
        if (
          (part.state === 'pending' && part.attempted) ||
          ((part.state === 'attempted' || part.state === 'verified') && !part.attempted)
        )
          throw new Error('Device Defaults step attempt ledger is inconsistent');
      }
      if (
        item.phase === 'complete' &&
        (entry.preflight !== 'verified' || entry.steps.some((part) => part.state !== 'verified'))
      )
        throw new Error('Complete Device Defaults journal has unverified steps');
    }
    if (item.sourceRecordId) {
      const source = parsed.records
        .slice(0, index)
        .find((candidate) => candidate.id.toLowerCase() === item.sourceRecordId!.toLowerCase());
      if (!source || source.owner !== item.owner || source.operation !== 'defaults')
        throw new Error(
          'Device Defaults recovery source must be an earlier original Defaults record from the same owner',
        );
    }
  }
  return parsed;
}

const initial = (): DefaultsJournalEnvelope => ({ version: 1, revision: 0, records: [] });
const persisted = (value: unknown) =>
  value === undefined ? initial() : parseDeviceDefaultsEnvelope(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const immutableRecord = (value: DefaultsJournalRecord) => ({
  id: value.id,
  owner: value.owner,
  scope: value.scope,
  operation: value.operation,
  sourceRecordId: value.sourceRecordId,
  target: value.target,
  createdAt: value.createdAt,
  roles: value.roles.map((entry) => ({
    slot: entry.slot,
    identity: entry.identity,
    before: entry.before,
    beforeSha256: entry.beforeSha256,
    steps: entry.steps.map(({ id, requestHex, expectedHex, maskHex }) => ({
      id,
      requestHex,
      expectedHex,
      maskHex,
    })),
  })),
});

/** Compare against a fresh transaction snapshot. Receipts/before-images and plans cannot be removed or rebound. */
export function assertDeviceDefaultsWrite(
  current: DefaultsJournalEnvelope,
  expectedRevision: number,
  next: DefaultsJournalEnvelope,
): void {
  const prior = parseDeviceDefaultsEnvelope(current),
    proposed = parseDeviceDefaultsEnvelope(next);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new Error('Invalid Device Defaults expected revision');
  if (prior.revision === proposed.revision && same(prior, proposed)) return;
  if (prior.revision !== expectedRevision || proposed.revision !== expectedRevision + 1)
    throw new DeviceDefaultsConflictError();
  if (prior.records.some((old, index) => proposed.records[index]?.id !== old.id))
    throw new Error(
      'Device Defaults history cannot be reordered, removed or inserted before existing requests',
    );
  for (const old of prior.records) {
    const updated = proposed.records.find((candidate) => candidate.id === old.id);
    if (
      !updated ||
      !same(immutableRecord(old), immutableRecord(updated)) ||
      updated.updatedAt < old.updatedAt
    )
      throw new Error(
        'Device Defaults request identity, original bytes or plan cannot be changed or removed',
      );
    if (old.phase === 'complete' && !same(old, updated))
      throw new Error('Verified Device Defaults completion is historical and cannot be changed');
    if (old.appliedScope !== undefined && updated.appliedScope !== old.appliedScope)
      throw new Error('Device Defaults applied scope provenance cannot be changed');
  }
}

export function createDeviceDefaultsStorage(): DeviceDefaultsStorage {
  let connection: Promise<IDBPDatabase> | undefined,
    fenced = false;
  const database = () => {
    if (fenced)
      return Promise.reject(
        new Error('Device Defaults storage changed version; reload this page before continuing'),
      );
    if (typeof indexedDB === 'undefined')
      return Promise.reject(new Error('IndexedDB is unavailable for Device Defaults recovery'));
    if (!connection) {
      const opened = openDB(DEVICE_DEFAULTS_DATABASE, 1, {
        upgrade(db) {
          if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
        },
        blocking() {
          fenced = true;
          void opened.then((db) => db.close()).catch(() => {});
        },
        terminated() {
          fenced = true;
        },
      });
      connection = opened.catch((cause: unknown) => {
        connection = undefined;
        throw cause;
      });
    }
    return connection;
  };
  return {
    async read() {
      return persisted(await (await database()).get('state', 'journal'));
    },
    async compareAndSwap(expectedRevision, value) {
      // Clone/validate before the await: callers cannot change bytes during a pending write.
      const next = parseDeviceDefaultsEnvelope(value),
        db = await database(),
        tx = db.transaction('state', 'readwrite', { durability: 'strict' });
      try {
        if (tx.durability !== 'strict')
          throw new Error('Strict Device Defaults journal durability is unavailable');
        const current = persisted(await tx.store.get('journal'));
        assertDeviceDefaultsWrite(current, expectedRevision, next);
        if (!same(current, next)) await tx.store.put(next, 'journal');
        await tx.done;
      } catch (cause) {
        try {
          tx.abort();
        } catch {}
        await tx.done.catch(() => {});
        throw cause;
      }
      const confirmed = persisted(await db.get('state', 'journal'));
      if (!same(confirmed, next))
        throw new Error('Device Defaults journal readback differs; outcome was not acknowledged');
    },
  };
}
