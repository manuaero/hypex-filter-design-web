import { openDB, type IDBPDatabase } from 'idb';
import { z } from 'zod';
import { Sha256 } from './file-transfers';

export const CLONE_PHASES = [
  'mute',
  'product-configuration',
  'eq-1',
  'eq-2',
  'eq-3',
  'eq-reload',
  'settings',
  'configuration',
  'display',
  'filters-1',
  'filters-2',
  'filters-3',
] as const;
export interface CloneMemoryImage {
  address: number;
  hex: string;
  sha256: string;
}
export interface CloneReportPlan {
  id: 'mute' | 'settings' | 'configuration' | 'display';
  requestHex: string;
  expectedHex: string;
  maskHex: string;
}
export interface CloneBeforeImage {
  statusHex: string;
  configurationHex: string;
  deviceConfigurationHex: string;
  dspNameHex: string;
  serialHex: string;
  flash: CloneMemoryImage[];
  filenames: CloneMemoryImage[];
  /** OEM-only strings at 0x120 and 0x140; serial at 0x100 is always retained separately. */
  oemStrings?: CloneMemoryImage[];
  sha256: string;
}
export interface CloneDesiredImage {
  reports: CloneReportPlan[];
  presetActivations: (Omit<CloneReportPlan, 'id'> & { preset: 1 | 2 | 3 })[];
  dspNameHex: string;
  flash: CloneMemoryImage[];
  filenames: CloneMemoryImage[];
  oemStrings?: CloneMemoryImage[];
  sha256: string;
}
export interface CloneOverrides {
  mode: 'master' | 'slave';
  presets: { forceInput: number; sourceLock: boolean; volumeLock: boolean }[];
}
export interface CloneJournalStep {
  id: (typeof CLONE_PHASES)[number];
  /** Persist only at the mutating-exchange hook, immediately before an actual setter. */
  attempted: boolean;
  /** Ready is durable intent, not proof of a send; a crash in this state requires inspection. */
  state: 'pending' | 'ready' | 'attempted' | 'verified' | 'unconfirmed' | 'failed' | 'skipped';
  error?: string;
}
export interface CloneJournalRole {
  slot: 'left' | 'right';
  documentRevision?: number;
  templateRevision?: number;
  identity: { serial: string; product: number; core: string; firmware: string };
  overrides: CloneOverrides;
  before: CloneBeforeImage;
  desired: CloneDesiredImage;
  /** Optional identifiers of additional exports; the complete recovery bytes above are authoritative. */
  backupIds?: string[];
  preflight: 'pending' | 'verified' | 'failed';
  lastConfirmedMuted: boolean | null;
  steps: CloneJournalStep[];
  error?: string;
}
export interface CloneJournalRecord {
  id: string;
  owner: string;
  scope: string;
  appliedScope?: string;
  target: 'left' | 'right' | 'both';
  templateSha256: string;
  designSha256: string;
  documentRevision: number;
  templateRevision: number;
  overrideRevision: number;
  createdAt: number;
  updatedAt: number;
  phase: 'prepared' | 'running' | 'complete' | 'partial' | 'failed';
  roles: CloneJournalRole[];
  error?: string;
}
export interface CloneJournalEnvelope {
  version: 1;
  revision: number;
  records: CloneJournalRecord[];
}
export interface DeviceCloneStorage {
  read(): Promise<CloneJournalEnvelope>;
  compareAndSwap(expectedRevision: number, next: CloneJournalEnvelope): Promise<void>;
}

export const DEVICE_CLONE_DATABASE = 'fusion-studio-device-clone';
export const MAX_DEVICE_CLONE_RECORDS = 32;
export const MAX_DEVICE_CLONE_BYTES = 32 * 1024 * 1024;
export class DeviceCloneCapacityError extends Error {
  constructor() {
    super(
      'Clone recovery storage is full (32 records or 32 MiB). Existing recovery bytes were retained; no new Clone operation was acknowledged.',
    );
    this.name = 'DeviceCloneCapacityError';
  }
}
export class DeviceCloneConflictError extends Error {
  constructor() {
    super('Clone recovery storage changed in another tab; read its journal before continuing.');
    this.name = 'DeviceCloneConflictError';
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
  hex = (size: number) =>
    z
      .string()
      .length(size * 2)
      .regex(/^[a-f\d]+$/),
  reportHex = hex(64),
  digest = hex(32),
  memory = (size: number) =>
    z.object({ address: integer, hex: hex(size), sha256: digest }).strict(),
  images = {
    flash: z.array(memory(4096)).length(24),
    filenames: z.array(memory(32)).length(12),
    oemStrings: z.array(memory(32)).length(2).optional(),
  },
  report = z
    .object({
      id: z.enum(['mute', 'settings', 'configuration', 'display']),
      requestHex: reportHex,
      expectedHex: reportHex,
      maskHex: reportHex,
    })
    .strict(),
  before = z
    .object({
      statusHex: reportHex,
      configurationHex: reportHex,
      deviceConfigurationHex: reportHex,
      dspNameHex: reportHex,
      serialHex: hex(32),
      ...images,
      sha256: digest,
    })
    .strict(),
  desired = z
    .object({
      reports: z.array(report).length(4),
      presetActivations: z
        .array(
          z
            .object({
              preset: z.union([z.literal(1), z.literal(2), z.literal(3)]),
              requestHex: reportHex,
              expectedHex: reportHex,
              maskHex: reportHex,
            })
            .strict(),
        )
        .length(3),
      dspNameHex: reportHex,
      ...images,
      sha256: digest,
    })
    .strict(),
  step = z
    .object({
      id: z.enum(CLONE_PHASES),
      attempted: z.boolean(),
      state: z.enum([
        'pending',
        'ready',
        'attempted',
        'verified',
        'unconfirmed',
        'failed',
        'skipped',
      ]),
      error: error.optional(),
    })
    .strict(),
  role = z
    .object({
      slot: z.enum(['left', 'right']),
      documentRevision: integer.optional(),
      templateRevision: integer.optional(),
      identity: z
        .object({ serial: text, product: integer.max(255), core: text, firmware: text })
        .strict(),
      overrides: z
        .object({
          mode: z.enum(['master', 'slave']),
          presets: z
            .array(
              z
                .object({
                  forceInput: integer.max(7),
                  sourceLock: z.boolean(),
                  volumeLock: z.boolean(),
                })
                .strict(),
            )
            .length(3),
        })
        .strict(),
      before,
      desired,
      backupIds: z.array(uuid).max(32).optional(),
      preflight: z.enum(['pending', 'verified', 'failed']),
      lastConfirmedMuted: z.boolean().nullable(),
      steps: z.array(step).length(CLONE_PHASES.length),
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
      templateSha256: digest,
      designSha256: digest,
      documentRevision: integer,
      templateRevision: integer,
      overrideRevision: integer,
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

const bytes = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (part) => parseInt(part, 16));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function cloneBytesSha256(value: string): string {
  if (!/^(?:[a-f\d]{2})*$/.test(value)) throw new Error('Invalid Clone image hexadecimal bytes');
  return new Sha256().update(bytes(value)).digest();
}
/** Canonical manifest hash includes addressed image hashes and every planned report byte. */
export function cloneImageSha256(
  value: Omit<CloneBeforeImage, 'sha256'> | Omit<CloneDesiredImage, 'sha256'>,
): string {
  const addressed = (items: CloneMemoryImage[] | undefined) =>
    items?.map(({ address, sha256 }) => [address, sha256]) ?? null;
  const manifest =
    'configurationHex' in value
      ? [
          'before',
          value.statusHex,
          value.configurationHex,
          value.deviceConfigurationHex,
          value.dspNameHex,
          value.serialHex,
          addressed(value.flash),
          addressed(value.filenames),
          addressed(value.oemStrings),
        ]
      : [
          'desired',
          value.reports.map(({ id, requestHex, expectedHex, maskHex }) => [
            id,
            requestHex,
            expectedHex,
            maskHex,
          ]),
          value.presetActivations.map(({ preset, requestHex, expectedHex, maskHex }) => [
            preset,
            requestHex,
            expectedHex,
            maskHex,
          ]),
          value.dspNameHex,
          addressed(value.flash),
          addressed(value.filenames),
          addressed(value.oemStrings),
        ];
  return new Sha256().update(new TextEncoder().encode(JSON.stringify(manifest))).digest();
}
export function assertDeviceCloneCapacity(value: CloneJournalEnvelope): void {
  if (
    value.records.length > MAX_DEVICE_CLONE_RECORDS ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_DEVICE_CLONE_BYTES
  )
    throw new DeviceCloneCapacityError();
}
function checkImages(image: CloneBeforeImage | CloneDesiredImage): void {
  for (const [index, item] of image.flash.entries()) {
    if (item.address !== 0x10000 + index * 4096 || cloneBytesSha256(item.hex) !== item.sha256)
      throw new Error('Clone flash backup or plan has missing, reordered or corrupt sectors');
  }
  const names = Array.from({ length: 3 }, (_, p) =>
    Array.from({ length: 4 }, (_, n) => 0x200 + p * 0x80 + n * 32),
  ).flat();
  for (const [index, item] of image.filenames.entries())
    if (item.address !== names[index] || cloneBytesSha256(item.hex) !== item.sha256)
      throw new Error('Clone filename backup or plan has missing, reordered or corrupt bytes');
  for (const [index, item] of (image.oemStrings ?? []).entries())
    if (item.address !== 0x120 + index * 32 || cloneBytesSha256(item.hex) !== item.sha256)
      throw new Error('Clone OEM string backup or plan is invalid');
  if (cloneImageSha256(image) !== image.sha256)
    throw new Error('Clone image manifest checksum is invalid');
}

/** Strict detached validation. Invalid prior records are never reset or silently skipped. */
export function parseDeviceCloneEnvelope(value: unknown): CloneJournalEnvelope {
  if (
    value &&
    typeof value === 'object' &&
    'records' in value &&
    Array.isArray(value.records) &&
    value.records.length > MAX_DEVICE_CLONE_RECORDS
  )
    throw new DeviceCloneCapacityError();
  const parsed = envelope.parse(value);
  assertDeviceCloneCapacity(parsed);
  if (new Set(parsed.records.map((item) => item.id.toLowerCase())).size !== parsed.records.length)
    throw new Error('Duplicate Clone request identifiers');
  for (const item of parsed.records) {
    const slots = item.roles.map((entry) => entry.slot);
    if (
      item.updatedAt < item.createdAt ||
      new Set(slots).size !== slots.length ||
      (item.target === 'both' ? slots.length !== 2 : slots.length !== 1 || slots[0] !== item.target)
    )
      throw new Error('Invalid Clone targets or timestamps');
    if (new Set(item.roles.map((entry) => entry.identity.serial)).size !== item.roles.length)
      throw new Error('Clone roles must identify independent physical amplifiers');
    for (const entry of item.roles) {
      const original = entry.before,
        c = bytes(original.configurationHex),
        v = new DataView(c.buffer),
        d = bytes(original.deviceConfigurationHex);
      if (
        !original.statusHex.startsWith('05') ||
        !original.configurationHex.startsWith('06') ||
        !original.deviceConfigurationHex.startsWith('66') ||
        !original.dspNameHex.startsWith('03') ||
        !entry.desired.dspNameHex.startsWith('0300')
      )
        throw new Error('Clone original or planned report command is invalid');
      const serial = Array.from(bytes(original.serialHex), (x) => String.fromCharCode(x))
        .join('')
        .replace(/\0.*$/s, '')
        .trim();
      if (
        entry.identity.serial !== serial ||
        entry.identity.product !== c[1] ||
        entry.identity.product !== d[12] ||
        entry.identity.core !== `${c[2]}.${c[3]}` ||
        entry.identity.firmware !== `${v.getUint16(15, true)}.${v.getUint16(17, true)}`
      )
        throw new Error('Clone identity differs from its original images');
      checkImages(original);
      checkImages(entry.desired);
      if (
        !same(
          entry.desired.reports.map((part) => part.id),
          ['mute', 'settings', 'configuration', 'display'],
        )
      )
        throw new Error('Clone report plans are incomplete or out of order');
      for (const part of entry.desired.reports) {
        const command = part.id === 'configuration' ? '66' : '05',
          selector = part.id === 'configuration' ? '01' : '00';
        if (
          !part.requestHex.startsWith(command + selector) ||
          !part.expectedHex.startsWith(command)
        )
          throw new Error('Clone plan contains an unsupported report command');
      }
      const plannedConfiguration = bytes(entry.desired.reports[2].requestHex);
      for (const [index, activation] of entry.desired.presetActivations.entries()) {
        const request = bytes(activation.requestHex),
          expected = bytes(activation.expectedHex),
          active = bytes(entry.desired.reports[1].requestHex)[2],
          status = bytes(original.statusHex);
        if (
          activation.preset !== index + 1 ||
          !activation.requestHex.startsWith('0500') ||
          expected[0] !== 5 ||
          !(request[6] & 128) ||
          !(expected[6] & 128) ||
          request[2] !== active ||
          expected[2] !== active ||
          request[24] !== status[24] ||
          request[25] !== status[25] ||
          expected[24] !== status[24] ||
          expected[25] !== status[25] ||
          request[23] !== 0
        )
          throw new Error(
            'Clone preset activation must preserve selected preset, protection mask and mute without triggers',
          );
      }
      if (
        plannedConfiguration[10] !== d[10] ||
        plannedConfiguration[11] !== d[11] ||
        plannedConfiguration[12] !== d[12]
      )
        throw new Error('Clone plan cannot change target amplifier, module or product identity');
      if (
        !same(
          entry.steps.map((part) => part.id),
          CLONE_PHASES,
        )
      )
        throw new Error('Clone phases are incomplete or out of native order');
      const oem = d[11] === 1,
        product = entry.steps[1];
      if (
        oem
          ? !original.oemStrings || !entry.desired.oemStrings || product.state === 'skipped'
          : original.oemStrings !== undefined ||
            entry.desired.oemStrings !== undefined ||
            product.state !== 'skipped'
      )
        throw new Error('Clone OEM phase and original string coverage disagree');
      for (const part of entry.steps) {
        if (
          ((part.state === 'pending' || part.state === 'ready' || part.state === 'skipped') &&
            part.attempted) ||
          ((part.state === 'attempted' ||
            part.state === 'verified' ||
            part.state === 'unconfirmed') &&
            !part.attempted) ||
          (part.state === 'skipped' && part.id !== 'product-configuration')
        )
          throw new Error('Clone phase attempt ledger is inconsistent');
      }
      if (
        item.phase === 'prepared' &&
        entry.steps.some((part) => part.attempted || !['pending', 'skipped'].includes(part.state))
      )
        throw new Error('Prepared Clone contains attempted or finished setters');
      if (entry.steps.some((part) => part.attempted) && entry.preflight !== 'verified')
        throw new Error(
          'Clone setter was attempted without verified preflight and complete backups',
        );
      if (
        item.phase === 'complete' &&
        (entry.preflight !== 'verified' ||
          entry.steps.some((part) => !['verified', 'skipped'].includes(part.state)))
      )
        throw new Error('Complete Clone contains unverified native phases');
    }
    const attempted = item.roles.some((entry) => entry.steps.some((part) => part.attempted));
    if ((item.phase === 'partial' && !attempted) || (item.phase === 'failed' && attempted))
      throw new Error('Clone partial/failed result disagrees with attempted setters');
  }
  return parsed;
}

const initial = (): CloneJournalEnvelope => ({ version: 1, revision: 0, records: [] });
const persisted = (value: unknown) =>
  value === undefined ? initial() : parseDeviceCloneEnvelope(value);
const immutable = (item: CloneJournalRecord) => ({
  id: item.id,
  owner: item.owner,
  scope: item.scope,
  target: item.target,
  templateSha256: item.templateSha256,
  designSha256: item.designSha256,
  documentRevision: item.documentRevision,
  templateRevision: item.templateRevision,
  overrideRevision: item.overrideRevision,
  createdAt: item.createdAt,
  roles: item.roles.map(
    ({
      slot,
      documentRevision,
      templateRevision,
      identity,
      overrides,
      before,
      desired,
      backupIds,
      steps,
    }) => ({
      slot,
      documentRevision,
      templateRevision,
      identity,
      overrides,
      before,
      desired,
      backupIds,
      steps: steps.map(({ id }) => id),
    }),
  ),
});

export function assertDeviceCloneWrite(
  current: CloneJournalEnvelope,
  expectedRevision: number,
  next: CloneJournalEnvelope,
): void {
  const prior = parseDeviceCloneEnvelope(current),
    proposed = parseDeviceCloneEnvelope(next);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new Error('Invalid Clone expected revision');
  if (prior.revision === proposed.revision && same(prior, proposed)) return;
  if (prior.revision !== expectedRevision || proposed.revision !== expectedRevision + 1)
    throw new DeviceCloneConflictError();
  if (prior.records.some((item, index) => proposed.records[index]?.id !== item.id))
    throw new Error(
      'Clone recovery history cannot be removed, reordered or inserted before existing requests',
    );
  for (const [index, item] of proposed.records.entries()) {
    const old = prior.records[index];
    if (!old) {
      if (item.phase !== 'prepared')
        throw new Error('A new Clone request must first persist complete prepared backups');
      continue;
    }
    if (!same(immutable(old), immutable(item)) || item.updatedAt < old.updatedAt)
      throw new Error(
        'Clone request identity, hashes, overrides, backups or desired plan cannot change',
      );
    if (old.phase === 'complete' && !same(old, item))
      throw new Error('Verified Clone completion is historical and cannot change');
    if (old.appliedScope !== undefined && old.appliedScope !== item.appliedScope)
      throw new Error('Clone applied-scope provenance cannot change');
    for (const [r, entry] of old.roles.entries())
      for (const [s, part] of entry.steps.entries()) {
        const updated = item.roles[r].steps[s];
        if (
          (part.attempted && !updated.attempted) ||
          (part.state === 'verified' && !same(part, updated)) ||
          (part.state !== 'pending' && updated.state === 'pending')
        )
          throw new Error(
            'Clone confirmed or attempted phase cannot be erased or reset for a retry',
          );
      }
  }
}

/** No device calls or implicit writes on read. Every write requests strict durability and exact readback. */
export function createDeviceCloneStorage(): DeviceCloneStorage {
  let connection: Promise<IDBPDatabase> | undefined,
    fenced = false;
  const database = () => {
    if (fenced)
      return Promise.reject(
        new Error('Clone storage changed version; reload this page before continuing'),
      );
    if (typeof indexedDB === 'undefined')
      return Promise.reject(new Error('IndexedDB is unavailable for Clone recovery'));
    if (!connection) {
      const opened = openDB(DEVICE_CLONE_DATABASE, 1, {
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
      const next = parseDeviceCloneEnvelope(value),
        db = await database(),
        tx = db.transaction('state', 'readwrite', { durability: 'strict' });
      try {
        if (tx.durability !== 'strict')
          throw new Error('Strict Clone journal durability is unavailable');
        const current = persisted(await tx.store.get('journal'));
        assertDeviceCloneWrite(current, expectedRevision, next);
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
        throw new Error('Clone journal readback differs; operation was not acknowledged');
    },
  };
}
