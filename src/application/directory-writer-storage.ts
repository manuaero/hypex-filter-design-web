import { openDB, type IDBPDatabase } from 'idb';
import { z } from 'zod';
import { assertSaveName, isWritableProjectDirectory } from './directory-writer-fs';
import type {
  DirectoryWriterBackend,
  DirectoryWriterEnvelope,
  WritableProjectDirectoryHandle,
} from './project-directory-writer';
import { MAX_UI_FILE_BYTES, MAX_UI_TOTAL_BYTES } from './file-budget';

export const MAX_DIRECTORY_ARCHIVES = 4096;
export const MAX_DIRECTORY_ARCHIVE_BYTES = 16 * 1024 * 1024;
export class DirectoryWriterCapacityError extends Error {}
/** New-operation capacity checks are separate from invalid/unreadable persisted-data failures. */
export function assertDirectoryWriterCapacity(value: DirectoryWriterEnvelope): void {
  if (value.roots.length > 32)
    throw new DirectoryWriterCapacityError(
      'The 32 granted-directory limit is full. Remove an unused grant before adding another.',
    );
  if (value.saves.length > 32)
    throw new DirectoryWriterCapacityError(
      'The 32 local recovery-journal limit is full. Export and explicitly archive a completed save, or discard an unused review.',
    );
  const bytes = value.saves.reduce(
    (sum, save) => sum + save.files.reduce((n, f) => n + f.after.size + (f.before?.size ?? 0), 0),
    0,
  );
  if (bytes > 2 ** 30)
    throw new DirectoryWriterCapacityError(
      'The 1 GiB local recovery limit is full. Export and explicitly archive a completed save before saving again.',
    );
  if (
    value.archives.length > MAX_DIRECTORY_ARCHIVES ||
    new TextEncoder().encode(JSON.stringify(value.archives)).byteLength >
      MAX_DIRECTORY_ARCHIVE_BYTES
  )
    throw new DirectoryWriterCapacityError(
      'The compact receipt archive is full (4096 receipts or 16 MiB). Existing receipts were retained; no recovery bytes were removed.',
    );
}

const id = z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9._:-]+$/),
  principal = z
    .string()
    .min(1)
    .max(512)
    .regex(/^[^\u0000-\u001f\u007f]+$/),
  integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const blob = z.custom<Blob>(
  (v) =>
    !!v &&
    typeof v === 'object' &&
    'size' in v &&
    Number.isSafeInteger(v.size) &&
    Number(v.size) >= 0 &&
    Number(v.size) <= MAX_UI_FILE_BYTES &&
    'arrayBuffer' in v &&
    typeof v.arrayBuffer === 'function' &&
    'stream' in v &&
    typeof v.stream === 'function',
);
const association = z
  .object({
    rootId: id,
    folderName: z.string().min(1).max(255),
    projectKey: z.string().max(4096).optional(),
  })
  .strict();
const file = z
  .object({
    path: z.string().min(1).max(255),
    action: z.enum(['create', 'replace', 'unchanged']),
    bytes: integer.max(MAX_UI_FILE_BYTES),
    sha256: digest,
    beforeBytes: integer.max(MAX_UI_FILE_BYTES).optional(),
    beforeSha256: digest.optional(),
    state: z.enum(['pending', 'attempting', 'verified', 'conflict']),
    recovery: z.enum(['pending', 'restored', 'retained-new-file', 'not-created', 'conflict']),
    before: blob.nullable(),
    after: blob,
  })
  .strict();
const legacySchema = z
  .object({
    version: z.literal(1),
    revision: integer,
    roots: z
      .array(
        z
          .object({
            id,
            label: z.string().min(1).max(65536),
            handle: z.custom<WritableProjectDirectoryHandle>(isWritableProjectDirectory),
          })
          .strict(),
      )
      .max(32),
    associations: z
      .object({ left: association.optional(), right: association.optional() })
      .strict(),
    saves: z
      .array(
        z
          .object({
            id,
            owner: principal,
            scope: principal,
            requestId: id,
            slot: z.enum(['left', 'right']),
            expectedRevision: integer,
            exportId: id.optional(),
            metadata: z.enum(['auto', 'design']).optional(),
            mode: z.enum(['save', 'save-as']),
            rootId: id,
            folderName: z.string().min(1).max(255),
            folderExisted: z.boolean(),
            projectKey: z.string().min(1).max(4096),
            phase: z.enum([
              'prepared',
              'writing',
              'partial',
              'complete',
              'recovering',
              'recovered',
              'recovered-with-new-files',
            ]),
            createdAt: integer,
            overwriteConfirmed: z.boolean(),
            folderHandle: z
              .custom<WritableProjectDirectoryHandle>(isWritableProjectDirectory)
              .optional(),
            error: z.string().max(2048).optional(),
            claim: z.object({ id, until: integer }).strict().optional(),
            files: z.array(file).min(2).max(2000),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
const terminalPhase = z.enum(['complete', 'recovered', 'recovered-with-new-files']);
const summary = file.omit({ before: true, after: true });
const archivedReceipt = z
  .object({
    id,
    slot: z.enum(['left', 'right']),
    expectedRevision: integer,
    exportId: id.optional(),
    metadata: z.enum(['auto', 'design']).optional(),
    mode: z.enum(['save', 'save-as']),
    rootId: id,
    folderName: z.string().min(1).max(255),
    phase: terminalPhase,
    createdAt: integer,
    files: z.array(summary).min(2).max(2000),
    requiresOverwriteConfirmation: z.boolean(),
    recoveryAvailable: z.literal(false),
    workspaceChanged: z.boolean(),
    error: z.string().max(2048).optional(),
    verified: z.literal(true),
    replayed: z.boolean(),
    atomic: z.literal(false),
    introduced: z.array(z.string().min(1).max(255)).max(2000),
    restored: z.array(z.string().min(1).max(255)).max(2000),
    archived: z.literal(true),
    archivedAt: integer,
  })
  .strict();
const archivedSave = z
  .object({
    owner: principal,
    scope: principal,
    requestId: id,
    projectKey: z.string().min(1).max(4096),
    reviewId: id,
    manifestSha256: digest,
    receipt: archivedReceipt,
  })
  .strict();
const schema = z.union([
  legacySchema
    .extend({ version: z.literal(2), archives: z.array(archivedSave).max(MAX_DIRECTORY_ARCHIVES) })
    .strict(),
  legacySchema,
]);
export function parseDirectoryWriterEnvelope(value: unknown): DirectoryWriterEnvelope {
  const parsed = schema.parse(value),
    checked: DirectoryWriterEnvelope = {
      ...parsed,
      version: 2,
      archives: 'archives' in parsed ? parsed.archives : [],
    },
    roots = checked.roots.map((v) => v.id),
    saves = [...checked.saves.map((v) => v.id), ...checked.archives.map((v) => v.receipt.id)],
    requests = [...checked.saves, ...checked.archives].map((v) =>
      JSON.stringify([v.owner, v.requestId]),
    );
  if (
    new Set(roots).size !== roots.length ||
    new Set(saves).size !== saves.length ||
    new Set(requests).size !== saves.length
  )
    throw new Error('Duplicate directory-save identifiers');
  let total = 0;
  for (const a of Object.values(checked.associations))
    if (a) {
      assertSaveName(a.folderName);
      if (!roots.includes(a.rootId)) throw new Error('Missing save association root');
    }
  for (const save of checked.saves) {
    assertSaveName(save.folderName);
    if (save.folderExisted && !save.folderHandle)
      throw new Error('Existing project folder has no bound capability');
    let bytes = 0;
    const names = save.files.map((f) => f.path.toLowerCase());
    if (
      new Set(names).size !== names.length ||
      !names.includes('config.xml') ||
      !names.includes('fusionproject.json')
    )
      throw new Error('Invalid project-save file set');
    for (const f of save.files) {
      assertSaveName(f.path);
      if (f.after.size !== f.bytes) throw new Error('Desired save blob size differs');
      if (f.before === null) {
        if (f.action !== 'create' || f.beforeBytes !== undefined || f.beforeSha256 !== undefined)
          throw new Error('Invalid created-file backup');
      } else if (
        f.before.size !== f.beforeBytes ||
        !f.beforeSha256 ||
        f.action ===
          (f.sha256 === f.beforeSha256 && f.bytes === f.beforeBytes ? 'replace' : 'unchanged') ||
        f.action === 'create'
      )
        throw new Error('Invalid original-file backup');
      bytes += f.after.size + (f.before?.size ?? 0);
    }
    if (bytes > MAX_UI_TOTAL_BYTES) throw new Error('Directory-save backup exceeds 640 MB');
    total += bytes;
    if (save.phase === 'complete' && save.files.some((f) => f.state !== 'verified'))
      throw new Error('Unverified complete save');
    if (
      ['recovered', 'recovered-with-new-files'].includes(save.phase) &&
      save.files.some((f) => !['restored', 'retained-new-file', 'not-created'].includes(f.recovery))
    )
      throw new Error('Unverified recovery');
  }
  if (total > 2 ** 30) throw new Error('Local directory-save recovery quota exceeded');
  for (const archive of checked.archives) {
    const r = archive.receipt,
      names = r.files.map((f) => f.path.toLowerCase());
    assertSaveName(r.folderName);
    if (
      new Set(names).size !== names.length ||
      !names.includes('config.xml') ||
      !names.includes('fusionproject.json')
    )
      throw new Error('Invalid archived project file set');
    for (const f of r.files) assertSaveName(f.path);
    if (r.phase === 'complete' && r.files.some((f) => f.state !== 'verified'))
      throw new Error('Unverified archived save');
    if (
      r.phase !== 'complete' &&
      r.files.some((f) => !['restored', 'retained-new-file', 'not-created'].includes(f.recovery))
    )
      throw new Error('Unverified archived recovery');
    const introduced = r.files
      .filter(
        (f) =>
          f.action === 'create' && (f.state === 'verified' || f.recovery === 'retained-new-file'),
      )
      .map((f) => f.path);
    const restored = r.files
      .filter((f) => f.action !== 'create' && f.recovery === 'restored')
      .map((f) => f.path);
    if (
      JSON.stringify(introduced) !== JSON.stringify(r.introduced) ||
      JSON.stringify(restored) !== JSON.stringify(r.restored)
    )
      throw new Error('Archived outcome paths differ');
  }
  assertDirectoryWriterCapacity(checked);
  return checked;
}
export function directoryWriterMetadata(value: DirectoryWriterEnvelope): string {
  return JSON.stringify({
    ...value,
    roots: value.roots.map(({ id, label }) => ({ id, label })),
    saves: value.saves.map(({ folderHandle, ...s }) => ({
      ...s,
      hasFolderHandle: !!folderHandle,
      files: s.files.map(({ before, after, ...f }) => ({
        ...f,
        beforeSize: before?.size ?? null,
        afterSize: after.size,
      })),
    })),
  });
}
export function assertDirectoryWriterWrite(
  current: unknown | null,
  next: DirectoryWriterEnvelope,
  expected: number | null,
): void {
  const n = parseDirectoryWriterEnvelope(next),
    c = current === null ? null : parseDirectoryWriterEnvelope(current);
  if (c?.revision === n.revision && directoryWriterMetadata(c) === directoryWriterMetadata(n))
    return;
  if ((c?.revision ?? null) !== expected || n.revision !== (expected ?? 0) + 1)
    throw new Error('Directory-save storage changed in another tab');
}
/** Shared schema for directory state and browser authority; old v1/v2 clients fail closed. */
export function createDirectoryWriterConnection(): () => Promise<IDBPDatabase> {
  let connection: Promise<IDBPDatabase> | undefined;
  const db = () => {
    if (typeof indexedDB === 'undefined')
      return Promise.reject(new Error('IndexedDB is unavailable'));
    connection ??= openDB('fusion-studio-directory-writes', 3, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
        if (!db.objectStoreNames.contains('authority')) db.createObjectStore('authority');
      },
      blocking() {
        void connection?.then((db) => db.close());
        connection = undefined;
      },
      terminated() {
        connection = undefined;
      },
    }).catch((error) => {
      connection = undefined;
      throw error;
    });
    return connection;
  };
  return db;
}
export const openDirectoryWriterDatabase = createDirectoryWriterConnection();
export function createIndexedDbDirectoryWriterBackend(): DirectoryWriterBackend {
  const db = createDirectoryWriterConnection();
  return {
    async read() {
      return (await (await db()).get('state', 'writer')) ?? null;
    },
    async write(next, expected) {
      const tx = (await db()).transaction('state', 'readwrite', { durability: 'strict' });
      try {
        if (tx.durability !== 'strict')
          throw new Error('Strict IndexedDB journal durability is unavailable');
        assertDirectoryWriterWrite((await tx.store.get('writer')) ?? null, next, expected);
        await tx.store.put(next, 'writer');
        await tx.done;
      } catch (error) {
        try {
          tx.abort();
        } catch {}
        await tx.done.catch(() => {});
        throw error;
      }
    },
  };
}
