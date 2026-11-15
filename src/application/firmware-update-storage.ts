import { openDB, type IDBPDatabase } from 'idb';
import { z } from 'zod';
import type { FirmwareFamily } from '../domain/firmware';
import { Sha256 } from './file-transfers';

export const FIRMWARE_JOURNAL_STEPS = [
  'entry',
  'loader',
  'stream',
  'exit',
  'runtime',
  'preservation',
] as const;
export interface FirmwareJournalBinding {
  assignmentId: string;
  connectionId: string;
  connectionEpoch: number;
  serial: string;
  hidSerial: string;
  family: FirmwareFamily;
  product: number;
  core: string;
  firmware: string;
}
export interface FirmwareJournalImage {
  id: string;
  kind: 'report' | 'spi-flash' | 'eeprom';
  address?: number;
  hex: string;
  sha256: string;
  compareMaskHex?: string;
}
export interface FirmwareJournalBefore {
  images: FirmwareJournalImage[];
  gaps: string[];
  sha256: string;
}
export interface FirmwareJournalSource {
  name: string;
  text: string;
  sha256: string;
  family: FirmwareFamily;
  expectedAfter?: {
    core?: string;
    firmware?: string;
    source: 'bundle-record-metadata' | 'explicit-simulation';
  };
}
export interface FirmwareJournalStep {
  id: (typeof FIRMWARE_JOURNAL_STEPS)[number];
  state: 'pending' | 'intent' | 'verified' | 'unconfirmed' | 'rejected' | 'skipped' | 'cancelled';
  /** Intent alone is not proof of a wire attempt. Preserve this independently. */
  attempted: boolean;
  error?: string;
}
export interface FirmwareJournalStream {
  acceptedPackets: number;
  acceptedRecords: number;
  nativeProgressRecords: number;
  transportAttempts: number;
  wireRequests: number;
  streamComplete: boolean;
  lastAccepted?: { pass: 0 | 1; index: number };
  targetStatus?: number;
}
export interface FirmwareJournalRole {
  slot: 'left' | 'right';
  binding: FirmwareJournalBinding;
  source: FirmwareJournalSource;
  before: FirmwareJournalBefore;
  steps: FirmwareJournalStep[];
  stream?: FirmwareJournalStream;
  after?: {
    binding: FirmwareJournalBinding;
    controlsDialect: 'supported' | 'unqualified';
    preservation: 'matched-known-ranges' | 'changed' | 'unavailable';
    changedImages: string[];
  };
  error?: string;
}
export interface FirmwareJournalRecord {
  id: string;
  owner: string;
  scope: string;
  target: 'left' | 'right' | 'both';
  qualifier: 'reference-simulation' | 'qualified-physical';
  sourceRecordId?: string;
  createdAt: number;
  updatedAt: number;
  phase: 'prepared' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled';
  roles: FirmwareJournalRole[];
  error?: string;
}
export interface FirmwareJournalEnvelope {
  version: 1;
  revision: number;
  records: FirmwareJournalRecord[];
}
export interface FirmwareJournalStore {
  read(): Promise<FirmwareJournalEnvelope>;
  compareAndSwap(expectedRevision: number, next: FirmwareJournalEnvelope): Promise<void>;
}

export const FIRMWARE_JOURNAL_DATABASE = 'fusion-studio-firmware-update';
export const MAX_FIRMWARE_JOURNAL_RECORDS = 16;
export const MAX_FIRMWARE_JOURNAL_BYTES = 32 * 1024 * 1024;
export const MAX_FIRMWARE_EXECUTION_SOURCE_BYTES = 4 * 1024 * 1024;

export class FirmwareJournalCapacityError extends Error {
  constructor() {
    super(
      'Firmware recovery storage is full (16 records or 32 MiB). Existing journals were retained; no firmware operation was started.',
    );
    this.name = 'FirmwareJournalCapacityError';
  }
}
export class FirmwareJournalConflictError extends Error {
  constructor() {
    super(
      'Firmware recovery storage changed in another tab; reload its journal before continuing.',
    );
    this.name = 'FirmwareJournalConflictError';
  }
}

const uuid = z.string().regex(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i),
  owner = z.string().regex(/^workspace:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i),
  text = z
    .string()
    .min(1)
    .max(512)
    .regex(/^[^\u0000-\u001f\u007f]+$/),
  failure = z.string().max(2048),
  uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  family = z.enum(['FUSION01', 'FUSION32', 'FUSION03', 'DSP3-224']),
  hash = z.string().regex(/^[a-f\d]{64}$/),
  hexadecimal = z
    .string()
    .min(2)
    .max(8192)
    .regex(/^(?:[a-f\d]{2})+$/),
  binding = z
    .object({
      assignmentId: text,
      connectionId: text,
      connectionEpoch: uint,
      serial: text,
      hidSerial: text,
      family,
      product: uint.max(255),
      core: text,
      firmware: text,
    })
    .strict(),
  image = z
    .object({
      id: text,
      kind: z.enum(['report', 'spi-flash', 'eeprom']),
      address: uint.optional(),
      hex: hexadecimal,
      sha256: hash,
      compareMaskHex: hexadecimal.optional(),
    })
    .strict(),
  source = z
    .object({
      name: text,
      text: z.string().min(1).max(MAX_FIRMWARE_EXECUTION_SOURCE_BYTES),
      sha256: hash,
      family,
      expectedAfter: z
        .object({
          core: text.optional(),
          firmware: text.optional(),
          source: z.enum(['bundle-record-metadata', 'explicit-simulation']),
        })
        .strict()
        .refine(
          (item) => item.core !== undefined || item.firmware !== undefined,
          'Expected firmware metadata requires a core or firmware value',
        )
        .optional(),
    })
    .strict(),
  step = z
    .object({
      id: z.enum(FIRMWARE_JOURNAL_STEPS),
      state: z.enum([
        'pending',
        'intent',
        'verified',
        'unconfirmed',
        'rejected',
        'skipped',
        'cancelled',
      ]),
      attempted: z.boolean(),
      error: failure.optional(),
    })
    .strict(),
  stream = z
    .object({
      acceptedPackets: uint,
      acceptedRecords: uint,
      nativeProgressRecords: uint,
      transportAttempts: uint,
      wireRequests: uint,
      streamComplete: z.boolean(),
      lastAccepted: z
        .object({ pass: z.union([z.literal(0), z.literal(1)]), index: uint })
        .strict()
        .optional(),
      targetStatus: uint.max(0xffffffff).optional(),
    })
    .strict(),
  role = z
    .object({
      slot: z.enum(['left', 'right']),
      binding,
      source,
      before: z
        .object({ images: z.array(image).length(43), gaps: z.array(text).max(32), sha256: hash })
        .strict(),
      steps: z.array(step).length(FIRMWARE_JOURNAL_STEPS.length),
      stream: stream.optional(),
      after: z
        .object({
          binding,
          controlsDialect: z.enum(['supported', 'unqualified']),
          preservation: z.enum(['matched-known-ranges', 'changed', 'unavailable']),
          changedImages: z.array(text).max(43),
        })
        .strict()
        .optional(),
      error: failure.optional(),
    })
    .strict(),
  record = z
    .object({
      id: uuid,
      owner,
      scope: text,
      target: z.enum(['left', 'right', 'both']),
      qualifier: z.enum(['reference-simulation', 'qualified-physical']),
      sourceRecordId: uuid.optional(),
      createdAt: uint,
      updatedAt: uint,
      phase: z.enum(['prepared', 'running', 'complete', 'partial', 'failed', 'cancelled']),
      roles: z.array(role).min(1).max(2),
      error: failure.optional(),
    })
    .strict(),
  envelope = z.object({ version: z.literal(1), revision: uint, records: z.array(record) }).strict();

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (part) => parseInt(part, 16));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function firmwareImageSha256(hex: string): string {
  return new Sha256().update(bytes(hexadecimal.parse(hex))).digest();
}
export function firmwareSourceSha256(text: string): string {
  return new Sha256().update(new TextEncoder().encode(text)).digest();
}
/** Hash exact ordered images and gap declarations, including IDs and compare masks. */
export function firmwareBeforeSha256(
  before: Pick<FirmwareJournalBefore, 'images' | 'gaps'>,
): string {
  return firmwareSourceSha256(JSON.stringify({ images: before.images, gaps: before.gaps }));
}
export function assertFirmwareJournalCapacity(value: FirmwareJournalEnvelope): void {
  if (
    value.records.length > MAX_FIRMWARE_JOURNAL_RECORDS ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_FIRMWARE_JOURNAL_BYTES
  )
    throw new FirmwareJournalCapacityError();
}

function validateBefore(before: FirmwareJournalBefore): void {
  const reports = new Set<number>(),
    flash = new Set<number>(),
    eeprom = new Set<number>(),
    ids = new Set<string>(),
    addresses = [
      0x100,
      0x120,
      0x140,
      ...Array.from({ length: 12 }, (_, index) => 0x200 + index * 32),
    ];
  for (const item of before.images) {
    if (ids.has(item.id) || firmwareImageSha256(item.hex) !== item.sha256)
      throw new Error('Firmware before-image identifiers or SHA-256 are invalid');
    ids.add(item.id);
    if (item.compareMaskHex !== undefined && item.compareMaskHex.length !== item.hex.length)
      throw new Error('Firmware before-image compare mask has the wrong length');
    if (item.kind === 'report') {
      const command = parseInt(item.hex.slice(0, 2), 16);
      if (
        item.hex.length !== 128 ||
        ![3, 5, 6, 0x66].includes(command) ||
        reports.has(command) ||
        item.address !== undefined ||
        item.compareMaskHex === undefined
      )
        throw new Error(
          'Firmware before-images require exactly the complete 03/05/06/66 reports and masks',
        );
      reports.add(command);
    } else {
      if (item.compareMaskHex !== undefined && !/^f+$/.test(item.compareMaskHex))
        throw new Error('Firmware memory preservation must compare every saved byte');
      const address = item.address;
      if (item.kind === 'spi-flash') {
        if (
          address === undefined ||
          address < 0x10000 ||
          address > 0x27000 ||
          address % 4096 ||
          flash.has(address) ||
          item.hex.length !== 8192
        )
          throw new Error('Firmware before-images require all 24 complete filter flash sectors');
        flash.add(address);
      } else {
        if (
          address === undefined ||
          !addresses.includes(address) ||
          eeprom.has(address) ||
          item.hex.length !== 64
        )
          throw new Error(
            'Firmware before-images contain missing, unsafe or duplicate EEPROM ranges',
          );
        eeprom.add(address);
      }
    }
  }
  if (
    reports.size !== 4 ||
    flash.size !== 24 ||
    eeprom.size !== 15 ||
    firmwareBeforeSha256(before) !== before.sha256
  )
    throw new Error('Firmware before-image manifest is incomplete or its SHA-256 differs');
}

/** Detached and fail-closed: corrupt records are never replaced with fresh state. */
export function parseFirmwareJournalEnvelope(value: unknown): FirmwareJournalEnvelope {
  if (
    value &&
    typeof value === 'object' &&
    'records' in value &&
    Array.isArray(value.records) &&
    value.records.length > MAX_FIRMWARE_JOURNAL_RECORDS
  )
    throw new FirmwareJournalCapacityError();
  const parsed: FirmwareJournalEnvelope = envelope.parse(value);
  assertFirmwareJournalCapacity(parsed);
  if (new Set(parsed.records.map((item) => item.id.toLowerCase())).size !== parsed.records.length)
    throw new Error('Duplicate firmware request identifiers');
  for (const [index, item] of parsed.records.entries()) {
    const slots = item.roles.map((entry) => entry.slot);
    if (
      item.updatedAt < item.createdAt ||
      new Set(slots).size !== slots.length ||
      (item.target === 'both' ? slots.length !== 2 : slots.length !== 1 || slots[0] !== item.target)
    )
      throw new Error('Invalid firmware target or timestamps');
    if (
      item.sourceRecordId &&
      !parsed.records
        .slice(0, index)
        .some(
          (old) =>
            old.id.toLowerCase() === item.sourceRecordId!.toLowerCase() && old.owner === item.owner,
        )
    )
      throw new Error('Firmware recovery source must be an earlier request from the same owner');
    if (item.sourceRecordId) {
      const original = parsed.records
        .slice(0, index)
        .find((old) => old.id.toLowerCase() === item.sourceRecordId!.toLowerCase())!;
      for (const entry of item.roles) {
        const oldRole = original.roles.find((candidate) => candidate.slot === entry.slot);
        if (
          !oldRole ||
          !same(oldRole.source, entry.source) ||
          !same(oldRole.before, entry.before) ||
          (['assignmentId', 'serial', 'hidSerial', 'family', 'product'] as const).some(
            (key) => oldRole.binding[key] !== entry.binding[key],
          )
        )
          throw new Error(
            'Firmware recovery must retain its original target, source and before-images',
          );
      }
    }
    for (const entry of item.roles) {
      validateBefore(entry.before);
      if (
        entry.source.family !== entry.binding.family ||
        new TextEncoder().encode(entry.source.text).byteLength >
          MAX_FIRMWARE_EXECUTION_SOURCE_BYTES ||
        firmwareSourceSha256(entry.source.text) !== entry.source.sha256
      )
        throw new Error('Firmware source family, size or SHA-256 is invalid');
      if (
        item.qualifier !== 'reference-simulation' &&
        entry.source.expectedAfter?.source === 'explicit-simulation'
      )
        throw new Error('Simulation-only firmware expectations cannot qualify a physical record');
      if (
        !same(
          entry.steps.map((part) => part.id),
          FIRMWARE_JOURNAL_STEPS,
        )
      )
        throw new Error('Firmware steps are incomplete or out of native order');
      for (const part of entry.steps) {
        if ((part.state === 'pending' || part.state === 'skipped') && part.attempted)
          throw new Error('Firmware step attempt ledger is inconsistent');
      }
      if (
        item.phase === 'prepared' &&
        (entry.steps.some(
          (part) => !['pending', 'skipped'].includes(part.state) || part.attempted,
        ) ||
          (entry.stream &&
            (entry.stream.acceptedPackets ||
              entry.stream.acceptedRecords ||
              entry.stream.nativeProgressRecords ||
              entry.stream.transportAttempts ||
              entry.stream.wireRequests ||
              entry.stream.streamComplete)))
      )
        throw new Error('A prepared firmware record cannot contain an attempt or outcome');
      if (
        item.phase === 'complete' &&
        (entry.steps.some((part) => !['verified', 'skipped'].includes(part.state)) ||
          !entry.stream?.streamComplete ||
          !entry.after ||
          entry.after.preservation !== 'matched-known-ranges')
      )
        throw new Error(
          'Complete firmware record requires finished steps/stream and verified known-range preservation',
        );
      if (
        entry.stream &&
        (entry.stream.acceptedPackets > entry.stream.acceptedRecords ||
          entry.stream.acceptedRecords > entry.stream.acceptedPackets * 2 ||
          entry.stream.nativeProgressRecords !== entry.stream.acceptedPackets * 2 ||
          entry.stream.wireRequests > entry.stream.transportAttempts)
      )
        throw new Error('Firmware stream counters are inconsistent');
      if (entry.after) {
        for (const key of ['assignmentId', 'serial', 'hidSerial', 'family', 'product'] as const)
          if (entry.after.binding[key] !== entry.binding[key])
            throw new Error('Firmware reconnect is not correlated with the original target');
        if (
          new Set(entry.after.changedImages).size !== entry.after.changedImages.length ||
          entry.after.changedImages.some(
            (id) => !entry.before.images.some((image) => image.id === id),
          ) ||
          (entry.after.preservation === 'matched-known-ranges' &&
            entry.after.changedImages.length > 0) ||
          (entry.after.preservation === 'changed' && entry.after.changedImages.length === 0)
        )
          throw new Error('Firmware preservation outcome is inconsistent');
      }
    }
  }
  return parsed;
}

const initial = (): FirmwareJournalEnvelope => ({ version: 1, revision: 0, records: [] });
const persisted = (value: unknown) =>
  value === undefined ? initial() : parseFirmwareJournalEnvelope(value);
const terminal = (phase: FirmwareJournalRecord['phase']) =>
  !['prepared', 'running'].includes(phase);
const immutable = (item: FirmwareJournalRecord) => ({
  id: item.id,
  owner: item.owner,
  scope: item.scope,
  target: item.target,
  qualifier: item.qualifier,
  sourceRecordId: item.sourceRecordId,
  createdAt: item.createdAt,
  roles: item.roles.map((entry) => ({
    slot: entry.slot,
    binding: entry.binding,
    source: entry.source,
    before: entry.before,
    steps: entry.steps.map((part) => part.id),
  })),
});

export function assertFirmwareJournalWrite(
  current: FirmwareJournalEnvelope,
  expectedRevision: number,
  next: FirmwareJournalEnvelope,
): void {
  const prior = parseFirmwareJournalEnvelope(current),
    proposed = parseFirmwareJournalEnvelope(next);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new Error('Invalid firmware journal expected revision');
  if (prior.revision === proposed.revision && same(prior, proposed)) return;
  if (prior.revision !== expectedRevision || proposed.revision !== expectedRevision + 1)
    throw new FirmwareJournalConflictError();
  if (prior.records.some((old, index) => proposed.records[index]?.id !== old.id))
    throw new Error(
      'Firmware history cannot be removed, reordered or inserted before existing requests',
    );
  for (const [index, old] of prior.records.entries()) {
    const updated = proposed.records[index];
    if (!same(immutable(old), immutable(updated)) || updated.updatedAt < old.updatedAt)
      throw new Error('Firmware target, source, original bytes, plan or provenance cannot change');
    if (terminal(old.phase) && !same(old, updated))
      throw new Error('Consumed firmware outcomes are historical and cannot be retried or changed');
    if (old.phase !== 'prepared' && updated.phase === 'prepared')
      throw new Error('Firmware request cannot return to prepared state');
    for (const [roleIndex, entry] of old.roles.entries()) {
      const changed = updated.roles[roleIndex];
      for (const [stepIndex, part] of entry.steps.entries()) {
        const nextStep = changed.steps[stepIndex];
        if (
          (part.attempted && !nextStep.attempted) ||
          (['verified', 'skipped'].includes(part.state) && !same(part, nextStep)) ||
          (part.state !== 'pending' && nextStep.state === 'pending')
        )
          throw new Error('Firmware step progress cannot be erased or replayed');
      }
      if (entry.stream) {
        if (!changed.stream) throw new Error('Firmware stream outcome cannot be removed');
        for (const key of [
          'acceptedPackets',
          'acceptedRecords',
          'nativeProgressRecords',
          'transportAttempts',
          'wireRequests',
        ] as const)
          if (changed.stream[key] < entry.stream[key])
            throw new Error('Firmware stream counters cannot decrease');
        if (entry.stream.streamComplete && !changed.stream.streamComplete)
          throw new Error('Firmware stream completion cannot be erased');
      }
      if (entry.after && !same(entry.after, changed.after))
        throw new Error('Firmware reconnect/preservation outcome cannot be changed');
    }
  }
  if (proposed.records.slice(prior.records.length).some((item) => item.phase !== 'prepared'))
    throw new Error('New firmware requests must be durably prepared before execution');
}

export function createFirmwareJournalStore(): FirmwareJournalStore {
  let connection: Promise<IDBPDatabase> | undefined,
    fenced = false;
  const database = () => {
    if (fenced)
      return Promise.reject(
        new Error('Firmware recovery storage changed version; reload before continuing'),
      );
    if (typeof indexedDB === 'undefined')
      return Promise.reject(new Error('IndexedDB is unavailable for firmware recovery'));
    if (!connection) {
      const opened = openDB(FIRMWARE_JOURNAL_DATABASE, 1, {
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
      const next = parseFirmwareJournalEnvelope(value),
        db = await database(),
        tx = db.transaction('state', 'readwrite', { durability: 'strict' });
      try {
        if (tx.durability !== 'strict')
          throw new Error('Strict firmware journal durability is unavailable');
        const current = persisted(await tx.store.get('journal'));
        assertFirmwareJournalWrite(current, expectedRevision, next);
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
        throw new Error('Firmware journal readback differs; outcome was not acknowledged');
    },
  };
}
