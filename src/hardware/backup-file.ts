import { z } from 'zod';
import { decodeStatus, presetBase, unhex } from './codec';
import { digest } from './checksum';
import type { Backup, SaveBackup } from './session';
import { listBackups, saveBackup } from './storage';
import { AsyncQueue } from './transport';

const hexField = (length: number) =>
  z
    .string()
    .length(length)
    .regex(/^[\da-f]+$/i)
    .transform((value) => value.toLowerCase());
const backupSchema = z
  .object({
    format: z.literal('fusion-studio-backup'),
    version: z.literal(1),
    id: z.string().min(1).max(200),
    utc: z
      .string()
      .max(100)
      .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid backup date'),
    serial: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\x20-\x7e]+$/),
    product: z.literal(22),
    firmware: z.string().regex(/^\d{1,5}\.\d{1,5}$/),
    preset: z.number().int().min(1).max(3),
    address: z.number().int(),
    configuration_hex: hexField(128),
    status_hex: hexField(128),
    sector_hex: hexField(8192),
    sha256: hexField(64),
    name: z.string().max(1024),
  })
  .strict();
const keys = Object.keys(backupSchema.shape) as (keyof Backup)[];
// The early independent physical reader emitted exactly these fields: no id or
// name, and a misnamed `firmware` tuple containing USB DSP-format bytes2/3.
// It is not the amplifier firmware stored in configuration words15/17.
const legacyV1Schema = backupSchema
  .omit({ id: true, name: true })
  .extend({
    firmware: z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255)]),
  })
  .strict();

async function adaptLegacyV1(value: unknown): Promise<Backup> {
  const legacy = legacyV1Schema.parse(value),
    configuration = unhex(legacy.configuration_hex);
  if (legacy.firmware[0] !== configuration[2] || legacy.firmware[1] !== configuration[3])
    throw new Error('Legacy backup DSP-format tuple does not match its configuration');
  const view = new DataView(
      configuration.buffer,
      configuration.byteOffset,
      configuration.byteLength,
    ),
    canonical = Object.fromEntries(
      Object.keys(legacy)
        .sort()
        .map((key) => [key, legacy[key as keyof typeof legacy]]),
    ),
    id = `import-${await digest(new TextEncoder().encode(JSON.stringify(canonical)))}`;
  return backupSchema.parse({
    ...legacy,
    id,
    name: 'Imported recovery image',
    firmware: `${view.getUint16(15, true)}.${view.getUint16(17, true)}`,
  });
}

/** Validate a standard IIR/input-EQ recovery file without accessing storage or a
 * panel. A sector remains opaque original bytes, including blank/uninitialized
 * data; this validates its identity metadata and integrity, not its design. */
export async function parseBackupFile(content: string): Promise<Backup> {
  if (content.length > 1e6) throw new Error('Backup file exceeds 1 MB');
  const value = JSON.parse(content.replace(/^\uFEFF/, ''));
  if (value?.format === 'fusion-studio-fir-backup')
    throw new Error(
      'This action imports standard IIR/input-EQ backups; FIR manifests use the separate FIR recovery flow',
    );
  const legacy =
      value !== null &&
      typeof value === 'object' &&
      Array.isArray(value.firmware) &&
      !Object.hasOwn(value, 'id') &&
      !Object.hasOwn(value, 'name'),
    backup = legacy ? await adaptLegacyV1(value) : backupSchema.parse(value),
    base = presetBase(backup.preset),
    configuration = unhex(backup.configuration_hex);
  if (![base, base + 0x3000].includes(backup.address))
    throw new Error('Backup address does not match its preset IIR/input-EQ sector');
  if (
    configuration[0] !== 6 ||
    configuration[1] !== 22 ||
    configuration[2] !== 5 ||
    configuration[3] !== 1
  )
    throw new Error('Backup configuration is not the supported FA503 / DSP3-213 v5 format');
  const view = new DataView(
    configuration.buffer,
    configuration.byteOffset,
    configuration.byteLength,
  );
  if (backup.firmware !== `${view.getUint16(15, true)}.${view.getUint16(17, true)}`)
    throw new Error('Backup firmware metadata does not match its configuration');
  decodeStatus(unhex(backup.status_hex));
  if ((await digest(unhex(backup.sector_hex))) !== backup.sha256)
    throw new Error('Backup sector SHA-256 mismatch');
  return backup;
}

export interface BackupImportStore {
  list: () => Promise<Backup[]>;
  save: SaveBackup;
}
const store: BackupImportStore = { list: listBackups, save: saveBackup },
  imports = new AsyncQueue();
const sameRecord = (a: Backup, b: Backup) =>
  Object.keys(a).length === keys.length && keys.every((key) => a[key] === b[key]);

/** Import into the local recovery library only. This never opens a USB session,
 * changes controls, or restores flash. Restoration remains a separate explicit
 * operation with the session's live identity/firmware/mute/readback checks. */
export function importBackupFile(
  content: string,
  storage: BackupImportStore = store,
): Promise<Backup> {
  return imports.run(async () => {
    const backup = await parseBackupFile(content),
      existing = (await storage.list()).filter((b) => b.id === backup.id);
    if (existing.length > 1 || (existing[0] && !sameRecord(existing[0], backup)))
      throw new Error(
        'A different recovery record already uses this backup ID; the existing record was retained',
      );
    if (!existing.length) await storage.save(backup);
    const actual = (await storage.list()).filter((b) => b.id === backup.id);
    if (actual.length !== 1 || !sameRecord(actual[0], backup))
      throw new Error('Imported backup readback did not match the complete recovery record');
    return structuredClone(backup);
  });
}
