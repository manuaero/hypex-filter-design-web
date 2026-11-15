import type { NativeMixerIdentity } from '../hardware/native-mixer';
import { assertNativeMixerCapture } from '../hardware/native-mixer';
import { openDB, type IDBPDatabase } from 'idb';
import { z } from 'zod';
import { Sha256 } from './file-transfers';

export interface NativeMixerJournalRole {
  slot: 'left' | 'right';
  identity: NativeMixerIdentity;
  before: {
    statusHex: string;
    configurationHex: string;
    deviceConfigurationHex: string;
    mixerHex: string;
  };
  beforeSha256: string;
  desired: { requestHex: string; expectedHex: string; maskHex: string };
  desiredSha256: string;
  state: 'pending' | 'intent' | 'unchanged' | 'verified' | 'blocked' | 'unconfirmed';
  /** Intent is not proof of transmission. This marker follows actual wire admission. */
  attempted: boolean;
  actualHex?: string;
  error?: string;
}
export interface NativeMixerJournalRecord {
  id: string;
  owner: string;
  scope: string;
  appliedScope?: string;
  target: 'left' | 'right' | 'both';
  preset: 1 | 2 | 3;
  revision: number;
  createdAt: number;
  updatedAt: number;
  phase: 'prepared' | 'running' | 'complete' | 'partial' | 'failed';
  roles: NativeMixerJournalRole[];
  error?: string;
}
export interface NativeMixerJournalEnvelope {
  version: 1;
  revision: number;
  records: NativeMixerJournalRecord[];
}
export interface NativeMixerStorage {
  read(): Promise<NativeMixerJournalEnvelope>;
  compareAndSwap(expectedRevision: number, next: NativeMixerJournalEnvelope): Promise<void>;
}

export const NATIVE_MIXER_DATABASE = 'fusion-studio-native-mixer';
export const MAX_NATIVE_MIXER_RECORDS = 32;
export const MAX_NATIVE_MIXER_BYTES = 1024 * 1024;
export class NativeMixerCapacityError extends Error {
  constructor() {
    super(
      'Native mixer recovery storage is full (32 records or 1 MiB). Existing records were retained; no mixer write was started.',
    );
    this.name = 'NativeMixerCapacityError';
  }
}
export class NativeMixerConflictError extends Error {
  constructor() {
    super(
      'Native mixer recovery storage changed in another tab; refresh history before continuing.',
    );
    this.name = 'NativeMixerConflictError';
  }
}
const uuid = z.string().regex(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i),
  owner = z.string().regex(/^workspace:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i),
  text = z
    .string()
    .min(1)
    .max(512)
    .regex(/^[^\u0000-\u001f\u007f]+$/),
  integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  hex = z.string().regex(/^[a-f\d]{128}$/),
  hash = z.string().regex(/^[a-f\d]{64}$/),
  error = z.string().max(2048),
  identity = z
    .object({ serial: text, product: integer.max(255), core: text, firmware: text })
    .strict(),
  role = z
    .object({
      slot: z.enum(['left', 'right']),
      identity,
      before: z
        .object({
          statusHex: hex,
          configurationHex: hex,
          deviceConfigurationHex: hex,
          mixerHex: hex,
        })
        .strict(),
      beforeSha256: hash,
      desired: z.object({ requestHex: hex, expectedHex: hex, maskHex: hex }).strict(),
      desiredSha256: hash,
      state: z.enum(['pending', 'intent', 'unchanged', 'verified', 'blocked', 'unconfirmed']),
      attempted: z.boolean(),
      actualHex: hex.optional(),
      error: error.optional(),
    })
    .strict(),
  record = z
    .object({
      id: uuid,
      owner,
      scope: text,
      appliedScope: text.optional(),
      target: z.enum(['left', 'right', 'both']),
      preset: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      revision: integer,
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
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function nativeMixerBeforeSha256(value: NativeMixerJournalRole['before']): string {
  return new Sha256()
    .update(bytes(hex.parse(value.statusHex)))
    .update(bytes(hex.parse(value.configurationHex)))
    .update(bytes(hex.parse(value.deviceConfigurationHex)))
    .update(bytes(hex.parse(value.mixerHex)))
    .digest();
}
export function nativeMixerDesiredSha256(value: NativeMixerJournalRole['desired']): string {
  return new Sha256()
    .update(bytes(hex.parse(value.requestHex)))
    .update(bytes(hex.parse(value.expectedHex)))
    .update(bytes(hex.parse(value.maskHex)))
    .digest();
}
export function assertNativeMixerCapacity(value: NativeMixerJournalEnvelope): void {
  if (
    value.records.length > MAX_NATIVE_MIXER_RECORDS ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_NATIVE_MIXER_BYTES
  )
    throw new NativeMixerCapacityError();
}
export function parseNativeMixerEnvelope(value: unknown): NativeMixerJournalEnvelope {
  if (
    value &&
    typeof value === 'object' &&
    'records' in value &&
    Array.isArray(value.records) &&
    value.records.length > MAX_NATIVE_MIXER_RECORDS
  )
    throw new NativeMixerCapacityError();
  const parsed: NativeMixerJournalEnvelope = envelope.parse(value);
  assertNativeMixerCapacity(parsed);
  if (new Set(parsed.records.map((item) => item.id.toLowerCase())).size !== parsed.records.length)
    throw new Error('Duplicate native mixer request IDs');
  for (const item of parsed.records) {
    const slots = item.roles.map((entry) => entry.slot);
    if (
      item.updatedAt < item.createdAt ||
      new Set(slots).size !== slots.length ||
      (item.target === 'both' ? slots.length !== 2 : slots.length !== 1 || slots[0] !== item.target)
    )
      throw new Error('Invalid native mixer target or timestamps');
    for (const entry of item.roles) {
      const before = {
          identity: entry.identity,
          status: bytes(entry.before.statusHex),
          configuration: bytes(entry.before.configurationHex),
          deviceConfiguration: bytes(entry.before.deviceConfigurationHex),
          mixerConfiguration: bytes(entry.before.mixerHex),
        },
        request = bytes(entry.desired.requestHex),
        expected = bytes(entry.desired.expectedHex),
        mask = bytes(entry.desired.maskHex);
      assertNativeMixerCapture(before);
      if (
        nativeMixerBeforeSha256(entry.before) !== entry.beforeSha256 ||
        nativeMixerDesiredSha256(entry.desired) !== entry.desiredSha256
      )
        throw new Error('Native mixer original/desired image SHA-256 differs');
      if (
        request[0] !== 0x67 ||
        request[1] !== 1 ||
        expected[0] !== 0x67 ||
        expected[1] !== 0 ||
        mask.some((bits, i) => bits !== (i === 0 || (i >= 2 && i < 38) ? 255 : 0)) ||
        request.some((byte, i) => i > 1 && expected[i] !== byte) ||
        request.slice(38).some((byte) => byte !== 0)
      )
        throw new Error('Invalid native mixer request or verification mask');
      const view = new DataView(request.buffer);
      for (let p = 0; p < 3; p++)
        for (let n = 0; n < 6; n++) {
          const index = 2 + (p * 6 + n) * 2;
          if (
            p !== item.preset - 1 &&
            (request[index] !== before.mixerConfiguration[index] ||
              request[index + 1] !== before.mixerConfiguration[index + 1])
          )
            throw new Error('Native mixer Save cannot alter inactive preset words');
          if (p === item.preset - 1 && Math.abs(view.getInt16(index, true)) > 256)
            throw new Error('Opened native mixer row exceeds the editor range');
        }
      const changed = request
        .slice(2, 38)
        .some((byte, i) => byte !== before.mixerConfiguration[i + 2]);
      if (
        (entry.state === 'unchanged' && (changed || entry.attempted)) ||
        (['pending', 'blocked'].includes(entry.state) && entry.attempted) ||
        (['verified', 'unconfirmed'].includes(entry.state) && !entry.attempted)
      )
        throw new Error('Native mixer attempt ledger is inconsistent');
      if (entry.actualHex) {
        const actual = bytes(entry.actualHex);
        if (actual[0] !== 0x67) throw new Error('Invalid native mixer actual record');
        if (
          entry.state === 'verified' &&
          actual.some((byte, i) => ((byte ^ expected[i]) & mask[i]) !== 0)
        )
          throw new Error('Unverified native mixer success bytes');
      }
      if (entry.state === 'verified' && !entry.actualHex)
        throw new Error('Verified native mixer outcome requires actual readback');
      if (
        item.phase === 'prepared' &&
        (!['pending', 'unchanged'].includes(entry.state) || entry.attempted || entry.actualHex)
      )
        throw new Error('Prepared native mixer record contains an outcome');
    }
    if (
      item.phase === 'complete' &&
      item.roles.some((entry) => !['verified', 'unchanged'].includes(entry.state))
    )
      throw new Error('Native mixer completion is unverified');
    if (item.phase === 'failed' && item.roles.some((entry) => entry.attempted))
      throw new Error('Attempted native mixer failure must remain partial');
    if (item.phase === 'partial' && !item.roles.some((entry) => entry.attempted))
      throw new Error('Native mixer partial record has no actual attempt');
  }
  return parsed;
}
const initial = (): NativeMixerJournalEnvelope => ({ version: 1, revision: 0, records: [] }),
  persisted = (value: unknown) =>
    value === undefined ? initial() : parseNativeMixerEnvelope(value),
  immutable = (value: NativeMixerJournalRecord) => ({
    id: value.id,
    owner: value.owner,
    scope: value.scope,
    target: value.target,
    preset: value.preset,
    revision: value.revision,
    createdAt: value.createdAt,
    roles: value.roles.map((entry) => ({
      slot: entry.slot,
      identity: entry.identity,
      before: entry.before,
      beforeSha256: entry.beforeSha256,
      desired: entry.desired,
      desiredSha256: entry.desiredSha256,
    })),
  });
export function assertNativeMixerWrite(
  current: NativeMixerJournalEnvelope,
  expectedRevision: number,
  next: NativeMixerJournalEnvelope,
): void {
  const prior = parseNativeMixerEnvelope(current),
    proposed = parseNativeMixerEnvelope(next);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new Error('Invalid native mixer expected revision');
  if (prior.revision === proposed.revision && same(prior, proposed)) return;
  if (prior.revision !== expectedRevision || proposed.revision !== expectedRevision + 1)
    throw new NativeMixerConflictError();
  if (prior.records.some((old, index) => proposed.records[index]?.id !== old.id))
    throw new Error('Native mixer history is append-only');
  for (const [index, old] of prior.records.entries()) {
    const updated = proposed.records[index];
    if (!same(immutable(old), immutable(updated)) || updated.updatedAt < old.updatedAt)
      throw new Error('Native mixer request/source/plan cannot be rebound');
    if (!['prepared', 'running'].includes(old.phase) && !same(old, updated))
      throw new Error('Consumed native mixer receipts are historical');
    if (old.appliedScope !== undefined && updated.appliedScope !== old.appliedScope)
      throw new Error('Native mixer applied-scope provenance cannot change');
    if (old.phase === 'running' && updated.phase === 'prepared')
      throw new Error('Native mixer request cannot return to prepared');
    for (const [roleIndex, entry] of old.roles.entries()) {
      const changed = updated.roles[roleIndex];
      if (
        (entry.attempted && !changed.attempted) ||
        (['verified', 'unchanged'].includes(entry.state) && !same(entry, changed)) ||
        (entry.state !== 'pending' && changed.state === 'pending')
      )
        throw new Error('Native mixer outcome progress cannot be erased');
    }
  }
  if (proposed.records.slice(prior.records.length).some((item) => item.phase !== 'prepared'))
    throw new Error('Native mixer before-images must be prepared first');
}
export function createNativeMixerStorage(): NativeMixerStorage {
  let connection: Promise<IDBPDatabase> | undefined,
    fenced = false;
  const database = () => {
    if (fenced)
      return Promise.reject(
        new Error('Native mixer recovery storage changed version; reload before continuing'),
      );
    if (typeof indexedDB === 'undefined')
      return Promise.reject(new Error('IndexedDB is unavailable for native mixer recovery'));
    if (!connection) {
      const opened = openDB(NATIVE_MIXER_DATABASE, 1, {
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
      const next = parseNativeMixerEnvelope(value),
        db = await database(),
        tx = db.transaction('state', 'readwrite', { durability: 'strict' });
      try {
        if (tx.durability !== 'strict')
          throw new Error('Strict native mixer journal durability is unavailable');
        const current = persisted(await tx.store.get('journal'));
        assertNativeMixerWrite(current, expectedRevision, next);
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
        throw new Error('Native mixer journal readback differs; outcome not acknowledged');
    },
  };
}
