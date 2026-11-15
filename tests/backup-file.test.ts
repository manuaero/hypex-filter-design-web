import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  parseBackupFile,
  importBackupFile,
  type BackupImportStore,
} from '../src/hardware/backup-file';
import { digest } from '../src/hardware/checksum';
import { hex, packet, presetBase } from '../src/hardware/codec';
import type { Backup } from '../src/hardware/session';

async function backup(preset = 1, eq = false): Promise<Backup> {
  const configuration = packet(6, 22, 5, 1),
    view = new DataView(configuration.buffer),
    sector = Uint8Array.from({ length: 4096 }, (_, i) => i % 251);
  view.setUint16(15, 5, true);
  view.setUint16(17, 7, true);
  return {
    format: 'fusion-studio-backup',
    version: 1,
    id: 'owned-backup',
    utc: '2026-11-14T00:00:00.000Z',
    serial: 'OWNED-FA503',
    product: 22,
    firmware: '5.7',
    preset,
    address: presetBase(preset) + (eq ? 0x3000 : 0),
    configuration_hex: hex(configuration),
    status_hex: hex(packet(5, 6, 2)),
    sector_hex: hex(sector),
    sha256: await digest(sector),
    name: 'Owned panel',
  };
}
function memoryStore() {
  const records = new Map<string, Backup>(),
    storage: BackupImportStore = {
      list: vi.fn(async () => Array.from(records.values(), (b) => structuredClone(b))),
      save: vi.fn(async (b) => {
        records.set(b.id, structuredClone(b));
      }),
    };
  return { records, storage };
}

async function legacyBackup() {
  const { id: _id, name: _name, firmware: _firmware, ...record } = await backup();
  return { ...record, firmware: [5, 1] };
}

it('adapts only the early independent physical-reader v1 shape, distinguishing its DSP-format tuple from amplifier firmware', async () => {
  const legacy = await legacyBackup(),
    before = structuredClone(legacy),
    canonical = {
      address: legacy.address,
      configuration_hex: legacy.configuration_hex,
      firmware: legacy.firmware,
      format: legacy.format,
      preset: legacy.preset,
      product: legacy.product,
      sector_hex: legacy.sector_hex,
      serial: legacy.serial,
      sha256: legacy.sha256,
      status_hex: legacy.status_hex,
      utc: legacy.utc,
      version: legacy.version,
    },
    expectedId = 'import-' + createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
    adapted = await parseBackupFile(JSON.stringify(legacy));
  expect(adapted.id).toBe(expectedId);
  expect(adapted.name).toBe('Imported recovery image');
  expect(adapted.firmware).toBe('5.7'); // Legacy[5,1] means config bytes2/3, not words15/17.
  expect(adapted.sha256).toBe(legacy.sha256);
  expect(adapted.sector_hex).toBe(legacy.sector_hex);
  expect(legacy).toEqual(before);
  expect(legacy).not.toHaveProperty('id');
  expect(legacy).not.toHaveProperty('name');
});

it('derives deterministic legacy IDs across field order/hex case and imports the recognized record idempotently', async () => {
  const legacy = await legacyBackup(),
    { storage, records } = memoryStore(),
    reversed = Object.fromEntries(Object.entries(legacy).reverse());
  reversed.configuration_hex = legacy.configuration_hex.toUpperCase();
  reversed.status_hex = legacy.status_hex.toUpperCase();
  reversed.sector_hex = legacy.sector_hex.toUpperCase();
  reversed.sha256 = legacy.sha256.toUpperCase();
  const first = await importBackupFile(JSON.stringify(legacy), storage),
    second = await importBackupFile(JSON.stringify(reversed), storage);
  expect(second).toEqual(first);
  expect(storage.save).toHaveBeenCalledTimes(1);
  expect(records.size).toBe(1);
});

it.each([
  'checksum',
  'configuration',
  'tuple',
  'tuple type',
  'id only',
  'name only',
  'both modern fields',
  'string firmware',
  'unknown field',
  'address',
  'status',
])('rejects invalid or mixed legacy %s without persisting any record', async (failure) => {
  const legacy = await legacyBackup(),
    value: Record<string, unknown> = { ...legacy },
    { storage } = memoryStore();
  if (failure === 'checksum') value.sector_hex = 'ff' + legacy.sector_hex.slice(2);
  if (failure === 'configuration')
    value.configuration_hex =
      legacy.configuration_hex.slice(0, 4) + '0502' + legacy.configuration_hex.slice(8);
  if (failure === 'tuple') value.firmware = [5, 7];
  if (failure === 'tuple type') value.firmware = ['5', '1'];
  if (failure === 'id only' || failure === 'both modern fields') value.id = 'mixed-record';
  if (failure === 'name only' || failure === 'both modern fields') value.name = 'Mixed record';
  if (failure === 'string firmware') value.firmware = '5.7';
  if (failure === 'unknown field') value.legacySource = 'unrecognized';
  if (failure === 'address') value.address = presetBase(3);
  if (failure === 'status') value.status_hex = hex(packet(5, 6, 0));
  await expect(importBackupFile(JSON.stringify(value), storage)).rejects.toThrow();
  expect(storage.save).not.toHaveBeenCalled();
});

it.each([
  [1, false],
  [2, false],
  [3, false],
  [1, true],
  [2, true],
  [3, true],
])(
  'validates every standard IIR/EQ sector for preset%i and EQ=%s without treating the active preset as its address',
  async (preset, eq) => {
    const original = await backup(preset as number, eq as boolean);
    expect(await parseBackupFile(JSON.stringify(original))).toEqual(original);
  },
);

it('normalizes encoded hex/checksum case while retaining exact bytes and accepts a UTF-8 BOM', async () => {
  const original = await backup(),
    file = {
      ...original,
      configuration_hex: original.configuration_hex.toUpperCase(),
      status_hex: original.status_hex.toUpperCase(),
      sector_hex: original.sector_hex.toUpperCase(),
      sha256: original.sha256.toUpperCase(),
    };
  expect(await parseBackupFile('\uFEFF' + JSON.stringify(file))).toEqual(original);
});

it.each([
  'checksum',
  'address',
  'status',
  'configuration',
  'firmware',
  'product',
  'hex',
  'date',
  'unknown field',
])('rejects invalid %s before persisting anything', async (failure) => {
  const original = await backup(),
    file: Record<string, unknown> = { ...original },
    { storage } = memoryStore();
  if (failure === 'checksum') file.sector_hex = 'ff' + original.sector_hex.slice(2);
  if (failure === 'address') file.address = presetBase(2);
  if (failure === 'status') file.status_hex = hex(packet(5, 6, 0));
  if (failure === 'configuration')
    file.configuration_hex = '07' + original.configuration_hex.slice(2);
  if (failure === 'firmware') file.firmware = '5.8';
  if (failure === 'product') file.product = 23;
  if (failure === 'hex') file.sector_hex = 'zz' + original.sector_hex.slice(2);
  if (failure === 'date') file.utc = 'Not a date';
  if (failure === 'unknown field') file.firmwareErase = true;
  await expect(importBackupFile(JSON.stringify(file), storage)).rejects.toThrow();
  expect(storage.save).not.toHaveBeenCalled();
});

it('rejects malformed/oversized files and identifies the separate FIR manifest flow', async () => {
  await expect(parseBackupFile('{')).rejects.toThrow();
  await expect(parseBackupFile(' '.repeat(1e6 + 1))).rejects.toThrow('1 MB');
  await expect(
    parseBackupFile(JSON.stringify({ format: 'fusion-studio-fir-backup' })),
  ).rejects.toThrow('separate FIR');
});

it('stores and verifies the complete imported record offline and returns a detached copy', async () => {
  const original = await backup(),
    { records, storage } = memoryStore(),
    result = await importBackupFile(JSON.stringify(original), storage);
  expect(storage.save).toHaveBeenCalledTimes(1);
  expect(storage.list).toHaveBeenCalledTimes(2);
  expect(records.get(original.id)).toEqual(original);
  result.name = 'Caller edit';
  expect(records.get(original.id)!.name).toBe(original.name);
  const same = await importBackupFile(JSON.stringify(original), storage);
  expect(same).toEqual(original);
  expect(storage.save).toHaveBeenCalledTimes(1);
});

it.each(['name', 'serial', 'utc', 'status_hex'] as const)(
  'retains an existing ID when imported %s metadata differs despite identical sector bytes',
  async (field) => {
    const original = await backup(),
      changed = { ...original },
      { records, storage } = memoryStore();
    records.set(original.id, structuredClone(original));
    if (field === 'name') changed.name = 'Other panel name';
    if (field === 'serial') changed.serial = 'OTHER-PANEL';
    if (field === 'utc') changed.utc = '2026-11-15T00:00:00.000Z';
    if (field === 'status_hex') changed.status_hex = hex(packet(5, 6, 3));
    await expect(importBackupFile(JSON.stringify(changed), storage)).rejects.toThrow(
      'different recovery record',
    );
    expect(records.get(original.id)).toEqual(original);
    expect(storage.save).not.toHaveBeenCalled();
  },
);

it('does not report success on storage failure or mismatched persistence readback, and accepts a later retry', async () => {
  const original = await backup(),
    { records, storage } = memoryStore();
  vi.mocked(storage.save).mockRejectedValueOnce(new Error('disk full'));
  await expect(importBackupFile(JSON.stringify(original), storage)).rejects.toThrow('disk full');
  expect(records.size).toBe(0);
  await expect(importBackupFile(JSON.stringify(original), storage)).resolves.toEqual(original);
  const broken = memoryStore();
  vi.mocked(broken.storage.save).mockImplementation(async (b) => {
    broken.records.set(b.id, { ...b, name: 'Corrupt readback' });
  });
  await expect(importBackupFile(JSON.stringify(original), broken.storage)).rejects.toThrow(
    'readback',
  );
});

it('serializes concurrent imports so a conflicting ID cannot overwrite the first verified record', async () => {
  const original = await backup(),
    changed = { ...original, name: 'Conflicting import' },
    { records, storage } = memoryStore();
  let reached!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      reached = r;
    }),
    held = new Promise<void>((r) => {
      release = r;
    });
  vi.mocked(storage.save).mockImplementation(async (b) => {
    reached();
    await held;
    records.set(b.id, structuredClone(b));
  });
  const first = importBackupFile(JSON.stringify(original), storage),
    second = importBackupFile(JSON.stringify(changed), storage).catch((e: unknown) => e);
  await ready;
  expect(storage.list).toHaveBeenCalledTimes(1);
  release();
  expect(await first).toEqual(original);
  expect(String(await second)).toContain('different recovery record');
  expect(records.get(original.id)).toEqual(original);
  expect(storage.save).toHaveBeenCalledTimes(1);
});
