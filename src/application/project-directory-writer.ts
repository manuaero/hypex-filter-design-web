import type { Slot, Project } from '../domain/model';
import type { ExecutionPrincipal } from './execution-context';
import type { TransferBlobFile } from './file-transfers';
import type { ProjectFile } from '../domain/project-io';

export interface WritableProjectFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(options: {
    keepExistingData: false;
    mode: 'exclusive';
  }): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
}
export interface WritableProjectDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<WritableProjectDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<WritableProjectFileHandle>;
  values(): AsyncIterableIterator<WritableProjectDirectoryHandle | WritableProjectFileHandle>;
  isSameEntry(other: WritableProjectDirectoryHandle): Promise<boolean>;
}
export interface DirectorySaveBinding {
  slot: Slot;
  expectedRevision: number;
  requestId: string;
  principal: ExecutionPrincipal;
  exportId?: string;
  metadata?: 'auto' | 'design';
}
export interface DirectoryExportTicket {
  resolve(): Promise<{ project: Project; files: readonly ProjectFile[] }>;
  assertCurrent(): void;
  /** Release only implicit capture stages owned by this ticket. */
  dispose?(): void;
}
export type DirectorySaveInput = DirectorySaveBinding &
  (
    | { mode: 'save'; rootId?: never; folderName?: never }
    | { mode: 'save-as'; rootId: string; folderName: string }
  );
export interface DirectorySaveFileSummary {
  path: string;
  action: 'create' | 'replace' | 'unchanged';
  bytes: number;
  sha256: string;
  beforeBytes?: number;
  beforeSha256?: string;
  state: 'pending' | 'attempting' | 'verified' | 'conflict';
  recovery: 'pending' | 'restored' | 'retained-new-file' | 'not-created' | 'conflict';
}
export type DirectorySavePhase =
  | 'prepared'
  | 'writing'
  | 'partial'
  | 'complete'
  | 'recovering'
  | 'recovered'
  | 'recovered-with-new-files';
export interface DirectorySaveProposal {
  id: string;
  slot: Slot;
  expectedRevision: number;
  exportId?: string;
  metadata?: 'auto' | 'design';
  mode: 'save' | 'save-as';
  rootId: string;
  folderName: string;
  phase: DirectorySavePhase;
  createdAt: number;
  files: readonly DirectorySaveFileSummary[];
  requiresOverwriteConfirmation: boolean;
  recoveryAvailable: boolean;
  archived?: true;
  archivedAt?: number;
  needsLocalAdoption?: true;
  workspaceChanged: boolean;
  error?: string;
}
export interface DirectorySaveReceipt extends DirectorySaveProposal {
  /** Every listed outcome was verified at completion. Replay is historical; no whole-folder absence or atomicity guarantee. */
  verified: boolean;
  replayed: boolean;
  /** Complete save and recovery are multi-file operations, never a filesystem transaction. */
  atomic: false;
  introduced: readonly string[];
  restored: readonly string[];
}
export interface DirectoryArchiveReview {
  id: string;
  saveId: string;
  slot: Slot;
  phase: 'complete' | 'recovered' | 'recovered-with-new-files';
  envelopeRevision: number;
  manifestSha256: string;
  recoveryBytes: number;
  proposal: DirectorySaveProposal;
}
export interface DirectoryWriterSnapshot {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  hydrated: boolean;
  busy: boolean;
  error: string | null;
  roots: readonly { id: string; label: string }[];
  associations: Readonly<Partial<Record<Slot, { rootId: string; folderName: string }>>>;
  saves: readonly DirectorySaveProposal[];
}
export interface ProjectDirectoryWriterOptions {
  getProject(slot: Slot): Project;
  getRevision(): number;
  /** Synchronous capture only; resolve is deferred until after durable replay/grant checks. */
  captureExport?(binding: Readonly<DirectorySaveBinding>, project: Project): DirectoryExportTicket;
  backend?: DirectoryWriterBackend;
  now?: () => number;
  id?: () => string;
  hash?: (blob: Blob) => Promise<string>;
  withLock?: <T>(name: string, work: () => Promise<T>) => Promise<T>;
}
/** Injected persistence must atomically compare-and-swap one envelope. */
export interface DirectoryWriterBackend {
  read(): Promise<unknown | null>;
  write(next: DirectoryWriterEnvelope, expectedRevision: number | null): Promise<void>;
}
/** Private persistence. Never return this envelope from UI/MCP status. */
export interface DirectoryWriterEnvelope {
  version: 2;
  revision: number;
  roots: { id: string; label: string; handle: WritableProjectDirectoryHandle }[];
  associations: Partial<Record<Slot, { rootId: string; folderName: string; projectKey?: string }>>;
  saves: DirectoryWriterJournal[];
  archives: DirectoryArchivedSave[];
}
export interface DirectoryArchivedSave {
  owner: string;
  scope: string;
  requestId: string;
  projectKey: string;
  reviewId: string;
  manifestSha256: string;
  receipt: DirectorySaveReceipt & { archived: true; archivedAt: number; recoveryAvailable: false };
}
export interface DirectoryWriterJournal {
  id: string;
  owner: string;
  scope: string;
  requestId: string;
  slot: Slot;
  expectedRevision: number;
  exportId?: string;
  metadata?: 'auto' | 'design';
  mode: 'save' | 'save-as';
  rootId: string;
  folderName: string;
  folderExisted: boolean;
  projectKey: string;
  phase: DirectorySavePhase;
  createdAt: number;
  overwriteConfirmed: boolean;
  error?: string;
  claim?: { id: string; until: number };
  folderHandle?: WritableProjectDirectoryHandle;
  files: (DirectorySaveFileSummary & { before: Blob | null; after: Blob })[];
}
export interface ProjectDirectoryWriter {
  getSnapshot(): DirectoryWriterSnapshot;
  subscribe(listener: () => void): () => void;
  hydrate(): Promise<void>;
  retryStorage(): Promise<void>;
  /** Human supplies an already readwrite-granted handle. This method never prompts. */
  registerDirectory(handle: WritableProjectDirectoryHandle): Promise<string>;
  forgetRoot(rootId: string): Promise<void>;
  prepare(input: DirectorySaveInput): Promise<DirectorySaveProposal>;
  commit(
    id: string,
    principal: ExecutionPrincipal,
    options?: { allowOverwrite?: boolean },
  ): Promise<DirectorySaveReceipt>;
  /** Resume the exact captured export; never replace it with a newer workspace project. */
  retry(id: string, principal: ExecutionPrincipal): Promise<DirectorySaveReceipt>;
  status(id: string, principal: ExecutionPrincipal): Promise<DirectorySaveProposal>;
  /** Restores originals; introduced files are retained and explicitly reported. */
  recover(id: string, principal: ExecutionPrincipal): Promise<DirectorySaveReceipt>;
  exportRecovery(id: string, principal: ExecutionPrincipal): Promise<readonly TransferBlobFile[]>;
  forgetRecovery(id: string, principal: ExecutionPrincipal): Promise<void>;
  reviewArchive(id: string, principal: ExecutionPrincipal): Promise<DirectoryArchiveReview>;
  archive(
    reviewId: string,
    principal: ExecutionPrincipal,
    confirmation: { confirm: true; removeLocalRecovery: true },
  ): Promise<DirectorySaveReceipt>;
}
export class DirectorySaveError extends Error {
  readonly needsHumanGrant: boolean;
  constructor(
    readonly code:
      | 'needs-human-grant'
      | 'invalid-request'
      | 'stale-workspace'
      | 'conflict'
      | 'busy'
      | 'persistence'
      | 'partial-write'
      | 'capacity'
      | 'archived-unavailable'
      | 'needs-local-adoption',
    message: string,
    readonly result?: DirectorySaveProposal,
  ) {
    super(message);
    this.name = 'DirectorySaveError';
    this.needsHumanGrant = code === 'needs-human-grant';
  }
}

import { projectSchema } from '../domain/files';
import { projectFiles } from '../domain/project-io';
import { parseExecutionPrincipal } from './execution-context';
import { assertFileByteBudget, MAX_UI_TEXT_CHARACTERS } from './file-budget';
import {
  assertSaveName,
  directoryNameKey,
  findChildDirectory,
  matchingProjectFiles,
  hasDirectoryWritePermission,
  isWritableProjectDirectory,
  hashDirectoryBlob,
  ownDirectoryBlob,
  withDirectoryWriteLock,
} from './directory-writer-fs';
import {
  createIndexedDbDirectoryWriterBackend,
  parseDirectoryWriterEnvelope,
  directoryWriterMetadata,
  assertDirectoryWriterCapacity,
  DirectoryWriterCapacityError,
} from './directory-writer-storage';

const blank = (): DirectoryWriterEnvelope => ({
  version: 2,
  revision: 0,
  roots: [],
  associations: {},
  saves: [],
  archives: [],
});
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const copy = (value: DirectoryWriterEnvelope): DirectoryWriterEnvelope => ({
  ...value,
  roots: value.roots.map((r) => ({ ...r })),
  associations: structuredClone(value.associations),
  saves: value.saves.map((s) => ({
    ...s,
    claim: s.claim ? { ...s.claim } : undefined,
    files: s.files.map((f) => ({ ...f })),
  })),
  archives: structuredClone(value.archives),
});
const idValue = (value: string) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,256}$/.test(value))
    throw new DirectorySaveError('invalid-request', 'Invalid directory-save identifier');
  return value;
};
const actor = (p: ExecutionPrincipal) =>
  parseExecutionPrincipal({ owner: p?.owner, scope: p?.scope });
const keyFor = (project: Project) =>
  JSON.stringify(project.presets.flatMap((p) => p.channels.map((c) => c.id)));
const terminal = (phase: DirectorySavePhase) =>
  ['complete', 'recovered', 'recovered-with-new-files'].includes(phase);
const order = (file: { path: string }) =>
  directoryNameKey(file.path) === 'fusionproject.json'
    ? 2
    : directoryNameKey(file.path) === 'config.xml'
      ? 1
      : 0;

export function createProjectDirectoryWriter(
  options: ProjectDirectoryWriterOptions,
): ProjectDirectoryWriter {
  const backend = options.backend ?? createIndexedDbDirectoryWriterBackend(),
    hash = options.hash ?? hashDirectoryBlob,
    lock = options.withLock ?? withDirectoryWriteLock;
  const now = options.now ?? Date.now,
    newId = () => idValue((options.id ?? (() => crypto.randomUUID()))());
  let data = blank(),
    hydration: Promise<void> | undefined,
    queue: Promise<void> = Promise.resolve(),
    storageBroken = false;
  let snapshot: DirectoryWriterSnapshot = freeze({
    phase: 'idle',
    hydrated: false,
    busy: false,
    error: null,
    roots: [],
    associations: {},
    saves: [],
  });
  const listeners = new Set<() => void>(),
    active = new Set<string>();
  const archiveReviews = new Map<
    string,
    { owner: string; review: DirectoryArchiveReview; consumed: boolean }
  >();
  const changed = (save: DirectoryWriterJournal) => {
    try {
      return options.getRevision() !== save.expectedRevision;
    } catch {
      return true;
    }
  };
  const proposal = (save: DirectoryWriterJournal): DirectorySaveProposal =>
    freeze({
      id: save.id,
      slot: save.slot,
      expectedRevision: save.expectedRevision,
      ...(save.exportId !== undefined ? { exportId: save.exportId } : {}),
      ...(save.metadata !== undefined ? { metadata: save.metadata } : {}),
      mode: save.mode,
      rootId: save.rootId,
      folderName: save.folderName,
      phase: save.phase,
      createdAt: save.createdAt,
      files: save.files.map(({ before, after, ...f }) => ({ ...f })),
      requiresOverwriteConfirmation:
        save.mode === 'save-as' && save.folderExisted && !save.overwriteConfirmed,
      recoveryAvailable: true,
      workspaceChanged: changed(save),
      ...(save.error ? { error: save.error } : {}),
    });
  const publish = (
    patch: Partial<Pick<DirectoryWriterSnapshot, 'phase' | 'hydrated' | 'error'>> = {},
  ) => {
    snapshot = freeze({
      ...snapshot,
      ...patch,
      busy: active.size > 0,
      roots: data.roots.map(({ id, label }) => ({ id, label })),
      associations: Object.fromEntries(
        Object.entries(data.associations)
          .filter(([, v]) => !!v)
          .map(([slot, v]) => [slot, { rootId: v!.rootId, folderName: v!.folderName }]),
      ),
      saves: [...data.saves.map(proposal), ...data.archives.map((a) => a.receipt)].sort(
        (a, b) => b.createdAt - a.createdAt,
      ),
    });
    listeners.forEach((fn) => fn());
  };
  const enqueue = <T>(fn: () => Promise<T>) => {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  };
  const verifyBlobs = async (save: DirectoryWriterJournal, index?: number) => {
    for (const f of index === undefined ? save.files : [save.files[index]]) {
      if ((await hash(f.after)) !== f.sha256 || f.after.size !== f.bytes)
        throw new DirectorySaveError(
          'persistence',
          'The desired project backup failed byte verification',
        );
      if (
        f.before &&
        ((await hash(f.before)) !== f.beforeSha256 || f.before.size !== f.beforeBytes)
      )
        throw new DirectorySaveError(
          'persistence',
          'An original recovery file failed byte verification',
        );
    }
  };
  const verifyRoots = async (value: DirectoryWriterEnvelope) => {
    for (let i = 0; i < value.roots.length; i++)
      for (let j = i + 1; j < value.roots.length; j++)
        if (await value.roots[i].handle.isSameEntry(value.roots[j].handle))
          throw new DirectorySaveError(
            'persistence',
            'Duplicate physical write roots require recovery before saving',
          );
  };
  const read = async (metadataOnly = false) => {
    const value = await backend.read();
    const checked = value === null ? blank() : parseDirectoryWriterEnvelope(value);
    if (!metadataOnly) await verifyRoots(checked);
    return checked;
  };
  const hydrate = (metadataOnly = false): Promise<void> => {
    if (snapshot.hydrated) return Promise.resolve();
    hydration ??= enqueue(async () => {
      publish({ phase: 'loading', error: null });
      try {
        const checked = await read(metadataOnly);
        for (const save of checked.saves) await verifyBlobs(save);
        data = checked;
        storageBroken = false;
        publish({ phase: 'ready', hydrated: true, error: null });
      } catch {
        storageBroken = true;
        publish({
          phase: 'error',
          error:
            'Local save/recovery data could not be verified. Prior data was retained; retry storage.',
        });
        throw new DirectorySaveError('persistence', snapshot.error!);
      }
    }).finally(() => {
      hydration = undefined;
    });
    return hydration;
  };
  const ready = async (metadataOnly = false) => {
    await hydrate(metadataOnly);
    if (storageBroken)
      throw new DirectorySaveError('persistence', snapshot.error ?? 'Retry save/recovery storage');
  };
  const persist = async (
    change: (next: DirectoryWriterEnvelope) => void | Promise<void>,
    verifyId?: string,
    index?: number,
    metadataOnly = false,
  ) => {
    await ready(metadataOnly);
    return enqueue(async () => {
      if (storageBroken) throw new DirectorySaveError('persistence', snapshot.error!);
      let next: DirectoryWriterEnvelope;
      try {
        const raw = await backend.read(),
          base = raw === null ? blank() : parseDirectoryWriterEnvelope(raw);
        if (!metadataOnly) await verifyRoots(base);
        next = copy(base);
        await change(next);
        next.revision = (raw === null ? 0 : base.revision) + 1;
        try {
          assertDirectoryWriterCapacity(next);
        } catch (error) {
          if (error instanceof DirectoryWriterCapacityError)
            throw new DirectorySaveError('capacity', error.message);
          throw error;
        }
        parseDirectoryWriterEnvelope(next);
        await backend.write(next, raw === null ? null : base.revision);
        const confirmed = parseDirectoryWriterEnvelope(await backend.read());
        if (!metadataOnly) await verifyRoots(confirmed);
        if (directoryWriterMetadata(confirmed) !== directoryWriterMetadata(next))
          throw new Error('Save journal readback differs');
        for (const root of metadataOnly ? [] : next.roots) {
          const saved = confirmed.roots.find((r) => r.id === root.id)!;
          if (saved.handle !== root.handle && !(await root.handle.isSameEntry(saved.handle)))
            throw new Error('Write capability changed');
        }
        for (const save of metadataOnly ? [] : next.saves) {
          if (save.folderHandle) {
            const saved = confirmed.saves.find((s) => s.id === save.id)!;
            if (
              !saved.folderHandle ||
              (saved.folderHandle !== save.folderHandle &&
                !(await save.folderHandle.isSameEntry(saved.folderHandle)))
            )
              throw new Error('Project directory capability changed');
          }
        }
        if (verifyId) {
          const saved = confirmed.saves.find((s) => s.id === verifyId);
          if (saved) await verifyBlobs(saved, index);
        }
        data = confirmed;
        publish({ phase: 'ready', error: null });
      } catch (error) {
        if (error instanceof DirectorySaveError && error.code !== 'persistence') throw error;
        storageBroken = true;
        publish({
          phase: 'error',
          error:
            'Save/recovery storage was not durably verified. Resolve storage before retrying this same operation.',
        });
        throw new DirectorySaveError('persistence', snapshot.error!);
      }
    });
  };
  const owned = (id: string, p: ExecutionPrincipal) => {
    idValue(id);
    const a = actor(p),
      save = data.saves.find((s) => s.id === id);
    if (!save || save.owner !== a.owner)
      throw new DirectorySaveError(
        'invalid-request',
        'This save/recovery record is unavailable to the current owner',
      );
    return save;
  };
  const archived = (id: string, p: ExecutionPrincipal) => {
    idValue(id);
    const owner = actor(p).owner;
    const item = data.archives.find((a) => a.receipt.id === id);
    if (item && item.owner !== owner)
      throw new DirectorySaveError(
        'invalid-request',
        'This historical receipt is unavailable to the current owner',
      );
    return item;
  };
  const archivedReceipt = (save: DirectoryArchivedSave): DirectorySaveReceipt =>
    freeze(structuredClone({ ...save.receipt, replayed: true }));
  const archiveUnavailable = (save: DirectoryArchivedSave): never => {
    throw new DirectorySaveError(
      'archived-unavailable',
      'This historical receipt was archived. Its local recovery/export bytes were explicitly removed; no filesystem action was taken.',
      archivedReceipt(save),
    );
  };
  const manifest = (save: DirectoryWriterJournal) => {
    const { folderHandle: _folder, files, ...metadata } = save;
    return hash(
      new Blob([
        JSON.stringify({
          ...metadata,
          files: files.map(({ before: _before, after: _after, ...summary }) => summary),
        }),
      ]),
    );
  };
  const rootFor = async (save: DirectoryWriterJournal) => {
    const root = data.roots.find((r) => r.id === save.rootId);
    if (!root || !(await hasDirectoryWritePermission(root.handle)))
      throw new DirectorySaveError(
        'needs-human-grant',
        'A human must grant read/write access to this database folder; no permission prompt was opened',
        proposal(save),
      );
    return root;
  };
  const receipt = (save: DirectoryWriterJournal, replayed: boolean): DirectorySaveReceipt =>
    freeze({
      ...proposal(save),
      verified: terminal(save.phase),
      replayed,
      atomic: false,
      introduced: save.files
        .filter(
          (f) =>
            f.before === null && (f.state === 'verified' || f.recovery === 'retained-new-file'),
        )
        .map((f) => f.path),
      restored: save.files
        .filter((f) => f.before !== null && f.recovery === 'restored')
        .map((f) => f.path),
    });
  const currentFiles = async (
    folder: WritableProjectDirectoryHandle | undefined,
    save: DirectoryWriterJournal,
  ) => {
    const handles = folder
      ? await matchingProjectFiles(
          folder,
          save.files.map((f) => f.path),
        )
      : new Map<string, WritableProjectFileHandle>();
    const values = new Map<
      string,
      { handle: WritableProjectFileHandle; bytes: number; sha256: string }
    >();
    for (const f of save.files) {
      const h = handles.get(directoryNameKey(f.path));
      if (h) {
        const file = await h.getFile();
        assertFileByteBudget([file]);
        values.set(directoryNameKey(f.path), {
          handle: h,
          bytes: file.size,
          sha256: await hash(file),
        });
      }
    }
    return values;
  };
  const same = (
    actual: { bytes: number; sha256: string } | undefined,
    bytes: number | undefined,
    sha: string | undefined,
  ) => !!actual && actual.bytes === bytes && actual.sha256 === sha;
  const validateBaseline = (
    save: DirectoryWriterJournal,
    values: Awaited<ReturnType<typeof currentFiles>>,
    recovering: boolean,
  ) => {
    for (const f of save.files) {
      const v = values.get(directoryNameKey(f.path));
      if (recovering) {
        if (!v || same(v, f.bytes, f.sha256) || same(v, f.beforeBytes, f.beforeSha256)) continue;
      } else if (
        same(v, f.bytes, f.sha256) || f.before === null
          ? !v || same(v, f.bytes, f.sha256)
          : same(v, f.beforeBytes, f.beforeSha256)
      )
        continue;
      throw new DirectorySaveError(
        'conflict',
        'A destination file changed outside this reviewed save. No conflicting bytes were overwritten.',
        proposal(save),
      );
    }
  };
  const perform = async (
    id: string,
    p: ExecutionPrincipal,
    recovering: boolean,
    resuming: boolean,
    allowOverwrite = false,
  ): Promise<DirectorySaveReceipt> => {
    await ready(true);
    // Historical terminal replay must use fresh journal metadata, not this tab's cache.
    data = await read(true);
    const historical = archived(id, p);
    if (historical) {
      if (recovering) return archiveUnavailable(historical);
      return archivedReceipt(historical);
    }
    data = await read();
    let save = owned(id, p);
    if (resuming && save.phase === 'recovering') recovering = true;
    if (!recovering && save.phase === 'complete') return receipt(save, true);
    if (recovering && ['recovered', 'recovered-with-new-files'].includes(save.phase))
      return receipt(save, true);
    if (!recovering && resuming && save.phase.startsWith('recovered')) return receipt(save, true);
    if (!recovering && save.phase.startsWith('recovered'))
      throw new DirectorySaveError(
        'invalid-request',
        'Prepare a new save after recovery',
        proposal(save),
      );
    if (active.has(id))
      throw new DirectorySaveError(
        'busy',
        'This save/recovery operation is already running',
        proposal(save),
      );
    active.add(id);
    publish();
    let enteredLock = false,
      claimedHere = false;
    try {
      return await lock(
        `fusion-studio-project-write:${save.rootId}:${directoryNameKey(save.folderName)}`,
        async () => {
          enteredLock = true;
          // The same-origin app Web Lock excludes this app’s cooperating writers;
          // external HFD/native processes are not locked. A prior
          // page's persisted claim may be recovered only after acquiring this lock.
          const latest = await read();
          data = latest;
          const archivedDuringLock = archived(id, p);
          if (archivedDuringLock) {
            if (recovering) return archiveUnavailable(archivedDuringLock);
            return archivedReceipt(archivedDuringLock);
          }
          save = owned(id, p);
          if (resuming && save.phase === 'recovering') recovering = true;
          if (recovering && ['recovered', 'recovered-with-new-files'].includes(save.phase))
            return receipt(save, true);
          if (!recovering && resuming && save.phase.startsWith('recovered'))
            return receipt(save, true);
          if (!recovering && save.phase.startsWith('recovered'))
            throw new DirectorySaveError(
              'invalid-request',
              'Prepare a new save after recovery',
              proposal(save),
            );
          await verifyBlobs(save);
          if (!recovering && save.phase === 'complete') return receipt(save, true);
          if (!recovering && save.phase === 'prepared' && changed(save))
            throw new DirectorySaveError(
              'stale-workspace',
              'The design changed after review. Prepare a new save for the current revision.',
              proposal(save),
            );
          if (!recovering && save.phase !== 'prepared' && !resuming)
            throw new DirectorySaveError(
              'invalid-request',
              'Resume this exact save with Retry, or recover its originals',
              proposal(save),
            );
          if (
            !recovering &&
            save.mode === 'save-as' &&
            save.folderExisted &&
            !save.overwriteConfirmed &&
            !allowOverwrite
          )
            throw new DirectorySaveError(
              'conflict',
              'Review this existing destination and explicitly allow replacement before committing',
              proposal(save),
            );
          const competing = data.saves.find(
            (s) =>
              s.id !== id &&
              s.rootId === save.rootId &&
              directoryNameKey(s.folderName) === directoryNameKey(save.folderName) &&
              ['writing', 'partial', 'recovering'].includes(s.phase),
          );
          if (competing)
            throw new DirectorySaveError(
              'conflict',
              'This folder has an unfinished save. Retry or recover that original operation first.',
              proposal(save),
            );
          const root = await rootFor(save);
          let folder = await findChildDirectory(root.handle, save.folderName);
          if (save.folderHandle && folder && !(await save.folderHandle.isSameEntry(folder)))
            throw new DirectorySaveError(
              'conflict',
              'The reviewed project folder was replaced',
              proposal(save),
            );
          if (!recovering && save.phase === 'prepared' && folder && !save.folderExisted)
            throw new DirectorySaveError(
              'conflict',
              'A folder appeared after preparation. Review the destination again.',
              proposal(save),
            );
          if (!recovering && save.folderExisted && !folder)
            throw new DirectorySaveError(
              'conflict',
              'The reviewed project folder is missing',
              proposal(save),
            );
          if (
            !recovering &&
            save.phase !== 'prepared' &&
            !save.folderExisted &&
            !save.folderHandle &&
            folder
          )
            throw new DirectorySaveError(
              'conflict',
              'Folder creation was not durably bound to this save. Recover the unused review, then prepare a fresh Save As.',
              proposal(save),
            );
          validateBaseline(save, await currentFiles(folder, save), recovering);
          if (recovering && !folder && save.files.every((file) => file.before === null)) {
            await persist((next) => {
              const journal = next.saves.find((item) => item.id === id)!;
              journal.files.forEach((file) => {
                file.recovery = 'not-created';
              });
              journal.phase = 'recovered';
              journal.claim = undefined;
              journal.error = undefined;
            }, id);
            return receipt(owned(id, p), false);
          }
          const claim = newId(),
            phase: DirectorySavePhase = recovering ? 'recovering' : 'writing';
          await persist((next) => {
            const s = next.saves.find((s) => s.id === id)!;
            s.phase = phase;
            s.error = undefined;
            s.claim = { id: claim, until: now() + 60_000 };
            if (allowOverwrite) s.overwriteConfirmed = true;
          }, id);
          claimedHere = true;
          save = owned(id, p);
          if (!folder) {
            // Originals and desired bytes are already durable before even creating a folder.
            await rootFor(save);
            const appeared = await findChildDirectory(root.handle, save.folderName);
            if (appeared && !resuming && !recovering)
              throw new DirectorySaveError(
                'conflict',
                'The destination appeared during save preparation',
                proposal(save),
              );
            folder =
              appeared ?? (await root.handle.getDirectoryHandle(save.folderName, { create: true }));
            await persist((next) => {
              next.saves.find((s) => s.id === id)!.folderHandle = folder;
            }, id);
            save = owned(id, p);
          }
          const indexes = save.files
            .map((f, i) => ({ f, i }))
            .sort((a, b) => order(a.f) - order(b.f));
          for (const { i } of indexes) {
            save = owned(id, p);
            const f = save.files[i];
            await rootFor(save);
            const actualFolder = await findChildDirectory(root.handle, save.folderName);
            if (!actualFolder || !(await folder.isSameEntry(actualFolder)))
              throw new DirectorySaveError(
                'conflict',
                'The destination folder changed while saving',
                proposal(save),
              );
            if (order(f) > 0) {
              const dependencies = await currentFiles(actualFolder, save);
              for (const dependency of save.files.filter((item) => order(item) < order(f))) {
                const observed = dependencies.get(directoryNameKey(dependency.path));
                if (recovering && dependency.before === null) {
                  if (observed && !same(observed, dependency.bytes, dependency.sha256))
                    throw new DirectorySaveError(
                      'conflict',
                      'A retained resource changed before project metadata recovery',
                      proposal(save),
                    );
                } else if (
                  !same(
                    observed,
                    recovering ? dependency.before!.size : dependency.bytes,
                    recovering ? dependency.beforeSha256 : dependency.sha256,
                  )
                )
                  throw new DirectorySaveError(
                    'conflict',
                    'A dependent resource changed before project metadata could be committed',
                    proposal(save),
                  );
              }
            }
            const present = await currentFilesForOne(actualFolder, f);
            if (recovering && f.before === null) {
              if (present && !same(present, f.bytes, f.sha256))
                throw new DirectorySaveError(
                  'conflict',
                  'A newly introduced path now contains unreviewed bytes',
                  proposal(save),
                );
              await persist(
                (next) => {
                  next.saves.find((s) => s.id === id)!.files[i].recovery = present
                    ? 'retained-new-file'
                    : 'not-created';
                },
                id,
                i,
              );
              continue;
            }
            const target = recovering ? f.before! : f.after,
              targetSha = recovering ? f.beforeSha256! : f.sha256;
            if (same(present, target.size, targetSha)) {
              await persist(
                (next) => {
                  const item = next.saves.find((s) => s.id === id)!.files[i];
                  if (recovering) item.recovery = 'restored';
                  else item.state = 'verified';
                },
                id,
                i,
              );
              continue;
            }
            if (
              present &&
              !same(present, f.beforeBytes, f.beforeSha256) &&
              !same(present, f.bytes, f.sha256)
            )
              throw new DirectorySaveError(
                'conflict',
                'Destination bytes changed since the reviewed baseline',
                proposal(save),
              );
            if (!recovering && f.before && !present)
              throw new DirectorySaveError(
                'conflict',
                'An original destination file disappeared',
                proposal(save),
              );
            // Journal attempting before createFile/createWritable, and verify durable
            // owned byte copies again before allowing a filesystem mutation.
            await persist(
              (next) => {
                next.saves.find((s) => s.id === id)!.files[i].state = 'attempting';
              },
              id,
              i,
            );
            await rootFor(save);
            const handles = await matchingProjectFiles(actualFolder, [f.path]);
            let handle = handles.get(directoryNameKey(f.path));
            if (!handle) handle = await actualFolder.getFileHandle(f.path, { create: true });
            if (directoryNameKey(handle.name) !== directoryNameKey(f.path))
              throw new DirectorySaveError(
                'conflict',
                'The file handle did not match the reviewed filename',
                proposal(save),
              );
            const stream = await handle.createWritable({
              keepExistingData: false,
              mode: 'exclusive',
            });
            let closed = false;
            try {
              const whileLocked = await handle.getFile(),
                lockedHash = await hash(whileLocked);
              if (
                present
                  ? whileLocked.size !== present.bytes || lockedHash !== present.sha256
                  : whileLocked.size !== 0
              )
                throw new DirectorySaveError(
                  'conflict',
                  'A file changed while its writer was being opened',
                  proposal(save),
                );
              await stream.write(target);
              const beforeClose = await handle.getFile(),
                beforeCloseHash = await hash(beforeClose);
              if (
                present
                  ? beforeClose.size !== present.bytes || beforeCloseHash !== present.sha256
                  : beforeClose.size !== 0
              )
                throw new DirectorySaveError(
                  'conflict',
                  'An external writer changed this file before commit; the staged write was aborted',
                  proposal(save),
                );
              const beforeCloseFolder = await findChildDirectory(root.handle, save.folderName);
              if (!beforeCloseFolder || !(await folder.isSameEntry(beforeCloseFolder)))
                throw new DirectorySaveError(
                  'conflict',
                  'The folder changed before file commit',
                  proposal(save),
                );
              await stream.close();
              closed = true;
            } catch (error) {
              if (!closed) await stream.abort().catch(() => {});
              throw error;
            }
            const afterCloseFolder = await findChildDirectory(root.handle, save.folderName);
            if (!afterCloseFolder || !(await folder.isSameEntry(afterCloseFolder)))
              throw new DirectorySaveError(
                'conflict',
                'The folder changed after file commit',
                proposal(save),
              );
            const confirmed = await currentFilesForOne(afterCloseFolder, f);
            if (!same(confirmed, target.size, targetSha))
              throw new DirectorySaveError(
                'partial-write',
                'The closed file did not verify; its original recovery bytes remain retained',
                proposal(save),
              );
            await persist(
              (next) => {
                const item = next.saves.find((s) => s.id === id)!.files[i];
                if (recovering) item.recovery = 'restored';
                else item.state = 'verified';
              },
              id,
              i,
            );
          }
          save = owned(id, p);
          const finalFolder = await findChildDirectory(root.handle, save.folderName);
          if (!finalFolder || !(await folder.isSameEntry(finalFolder)))
            throw new DirectorySaveError(
              'conflict',
              'The destination identity changed before final verification',
              proposal(save),
            );
          const final = await currentFiles(finalFolder, save);
          for (const f of save.files) {
            const v = final.get(directoryNameKey(f.path));
            if (recovering && f.before === null) {
              if (v && !same(v, f.bytes, f.sha256))
                throw new DirectorySaveError(
                  'conflict',
                  'A retained introduced file changed during recovery',
                  proposal(save),
                );
            } else if (
              !same(
                v,
                recovering ? f.before!.size : f.bytes,
                recovering ? f.beforeSha256 : f.sha256,
              )
            )
              throw new DirectorySaveError(
                'partial-write',
                'Final project bytes did not verify',
                proposal(save),
              );
          }
          await persist((next) => {
            const s = next.saves.find((s) => s.id === id)!;
            s.phase = recovering
              ? s.files.some((f) => f.recovery === 'retained-new-file')
                ? 'recovered-with-new-files'
                : 'recovered'
              : 'complete';
            s.claim = undefined;
            s.error = undefined;
            if (!recovering)
              next.associations[s.slot] = {
                rootId: s.rootId,
                folderName: s.folderName,
                projectKey: s.projectKey,
              };
          }, id);
          return receipt(owned(id, p), false);
        },
      );
    } catch (error) {
      const latest = data.saves.find((s) => s.id === id);
      if (
        claimedHere &&
        latest &&
        ['writing', 'recovering'].includes(latest.phase) &&
        !storageBroken
      ) {
        try {
          await persist((next) => {
            const s = next.saves.find((s) => s.id === id)!;
            s.phase = recovering ? 'recovering' : 'partial';
            s.claim = undefined;
            s.error =
              'The multi-file operation was interrupted. Retry this exact operation or inspect its retained recovery files.';
          }, id);
        } catch {}
      }
      if (error instanceof DirectorySaveError)
        throw new DirectorySaveError(
          error.code,
          error.message,
          latest ? proposal(data.saves.find((s) => s.id === id)!) : undefined,
        );
      throw new DirectorySaveError(
        !enteredLock ? 'busy' : !claimedHere ? 'conflict' : 'partial-write',
        !enteredLock
          ? 'Another browser writer owns this folder, or exclusive locks are unavailable.'
          : !claimedHere
            ? 'The destination is ambiguous, colliding, unreadable or changed. No filesystem mutation was started.'
            : 'The directory operation was not confirmed. No automatic retry, rollback or deletion was attempted.',
        latest ? proposal(latest) : undefined,
      );
    } finally {
      active.delete(id);
      publish();
    }
  };
  const currentFilesForOne = async (
    folder: WritableProjectDirectoryHandle,
    f: DirectoryWriterJournal['files'][number],
  ) => {
    const handles = await matchingProjectFiles(folder, [f.path]),
      handle = handles.get(directoryNameKey(f.path));
    if (!handle) return;
    const file = await handle.getFile();
    assertFileByteBudget([file]);
    return { handle, bytes: file.size, sha256: await hash(file) };
  };
  const controller: ProjectDirectoryWriter = {
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    hydrate,
    async retryStorage() {
      await queue;
      storageBroken = false;
      publish({ hydrated: false });
      await hydrate();
    },
    async registerDirectory(handle) {
      await ready();
      if (!isWritableProjectDirectory(handle) || !(await hasDirectoryWritePermission(handle)))
        throw new DirectorySaveError(
          'needs-human-grant',
          'Choose a directory with explicit read/write permission',
        );
      let selected = '';
      await persist(async (next) => {
        // Deduplicate against the freshly read CAS base, not this tab's cache.
        for (const root of next.roots)
          if (await handle.isSameEntry(root.handle)) {
            selected = root.id;
            root.handle = handle;
            root.label = handle.name || 'Project database';
            return;
          }
        selected = newId();
        next.roots.push({ id: selected, label: handle.name || 'Project database', handle });
      });
      return selected;
    },
    async forgetRoot(rootId) {
      idValue(rootId);
      await persist((next) => {
        if (next.saves.some((s) => s.rootId === rootId))
          throw new DirectorySaveError(
            'conflict',
            'This directory still owns retained save/recovery records',
          );
        next.roots = next.roots.filter((r) => r.id !== rootId);
        for (const slot of ['left', 'right'] as const)
          if (next.associations[slot]?.rootId === rootId) delete next.associations[slot];
      });
    },
    async prepare(input) {
      const binding = {
        slot: input.slot,
        expectedRevision: input.expectedRevision,
        requestId: idValue(input.requestId),
        principal: actor(input.principal),
        mode: input.mode,
        ...(input.exportId !== undefined ? { exportId: idValue(input.exportId) } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        ...(input.mode === 'save-as'
          ? { rootId: idValue(input.rootId), folderName: input.folderName }
          : {}),
      };
      if (
        !['left', 'right'].includes(binding.slot) ||
        !['save', 'save-as'].includes(binding.mode) ||
        !Number.isSafeInteger(binding.expectedRevision) ||
        binding.expectedRevision < 0 ||
        (binding.metadata !== undefined && !['auto', 'design'].includes(binding.metadata))
      )
        throw new DirectorySaveError('invalid-request', 'Invalid explicit save binding');
      const captured =
        options.getRevision() === binding.expectedRevision
          ? projectSchema.parse(options.getProject(binding.slot))
          : undefined;
      let exportTicket: DirectoryExportTicket | undefined, ticketFailure: unknown;
      // Capture the original session synchronously, but preserve zero-I/O replay
      // even when a formerly connected target is now missing or a ticket expired.
      try {
        if (captured && options.captureExport)
          exportTicket = options.captureExport(binding, captured);
      } catch (error) {
        ticketFailure = error;
      }
      try {
        await ready(true);
        data = await read(true);
        const priorArchive = data.archives.find(
          (a) => a.owner === binding.principal.owner && a.requestId === binding.requestId,
        );
        const prior =
          priorArchive?.receipt ??
          data.saves.find(
            (s) => s.owner === binding.principal.owner && s.requestId === binding.requestId,
          );
        if (prior) {
          if (
            prior.slot !== binding.slot ||
            prior.expectedRevision !== binding.expectedRevision ||
            prior.exportId !== binding.exportId ||
            prior.metadata !== binding.metadata ||
            prior.mode !== binding.mode ||
            (binding.mode === 'save-as' &&
              (prior.rootId !== binding.rootId ||
                directoryNameKey(prior.folderName) !== directoryNameKey(binding.folderName!)))
          )
            throw new DirectorySaveError(
              'invalid-request',
              'Request ID belongs to a different save',
            );
          return priorArchive
            ? archivedReceipt(priorArchive)
            : proposal(prior as DirectoryWriterJournal);
        }
        // A new save uses live root-capability validation; an old archived request never touches it.
        data = await read();
        if (!captured)
          throw new DirectorySaveError(
            'stale-workspace',
            'The design changed before this save could be captured',
          );
        const association = data.associations[binding.slot],
          destination =
            binding.mode === 'save-as'
              ? { rootId: binding.rootId!, folderName: binding.folderName! }
              : association;
        if (
          !destination ||
          (binding.mode === 'save' && association?.projectKey !== keyFor(captured))
        )
          throw new DirectorySaveError(
            'invalid-request',
            'Use Save As to associate this project with a granted destination',
          );
        try {
          assertSaveName(destination.folderName);
        } catch {
          throw new DirectorySaveError(
            'invalid-request',
            'Choose one native-compatible project folder name',
          );
        }
        const root = data.roots.find((r) => r.id === destination.rootId);
        if (!root || !(await hasDirectoryWritePermission(root.handle)))
          throw new DirectorySaveError(
            'needs-human-grant',
            'A human must grant read/write access before saving',
          );
        const existing = await findChildDirectory(root.handle, destination.folderName),
          folderName = existing?.name ?? destination.folderName;
        if (
          data.saves.some(
            (s) =>
              s.rootId === root.id &&
              directoryNameKey(s.folderName) === directoryNameKey(folderName) &&
              ['writing', 'partial', 'recovering'].includes(s.phase),
          )
        )
          throw new DirectorySaveError(
            'conflict',
            'Retry or recover the unfinished save for this folder first',
          );
        if (ticketFailure) throw ticketFailure;
        const resolved = exportTicket ? await exportTicket.resolve() : undefined;
        if (resolved) {
          const validated = projectSchema.parse(resolved.project),
            original = structuredClone(captured);
          delete validated.hfdCloneTemplate;
          delete original.hfdCloneTemplate;
          if (JSON.stringify(validated) !== JSON.stringify(original))
            throw new DirectorySaveError(
              'invalid-request',
              'Save capture changed staged design data',
            );
        }
        exportTicket?.assertCurrent();
        const exported = resolved?.files ?? projectFiles(captured);
        if (
          !Array.isArray(exported) ||
          exported.length < 2 ||
          exported.length > 2000 ||
          exported.some(
            (file) => !file || typeof file.path !== 'string' || typeof file.content !== 'string',
          )
        )
          throw new DirectorySaveError(
            'invalid-request',
            'Save capture returned an invalid file set',
          );
        if (exported.reduce((sum, f) => sum + f.content.length, 0) > MAX_UI_TEXT_CHARACTERS)
          throw new DirectorySaveError(
            'invalid-request',
            'Project folder exceeds the existing 80m character import budget',
          );
        const handles = existing
            ? await matchingProjectFiles(
                existing,
                exported.map((f) => f.path),
              )
            : new Map<string, WritableProjectFileHandle>(),
          files: DirectoryWriterJournal['files'] = [];
        const stagedSizes: { size: number }[] = [];
        for (const f of exported) {
          assertSaveName(f.path);
          const handle = handles.get(directoryNameKey(f.path)),
            after = new Blob([f.content]),
            original = handle ? await handle.getFile() : undefined;
          assertFileByteBudget([...stagedSizes, after, ...(original ? [original] : [])]);
          stagedSizes.push({ size: after.size }, ...(original ? [{ size: original.size }] : []));
          const before = original ? await ownDirectoryBlob(original) : null;
          const sha256 = await hash(after),
            beforeSha256 = before ? await hash(before) : undefined;
          files.push({
            path: handle?.name ?? f.path,
            action: before
              ? sha256 === beforeSha256 && after.size === before.size
                ? 'unchanged'
                : 'replace'
              : 'create',
            bytes: after.size,
            sha256,
            ...(before ? { beforeBytes: before.size, beforeSha256 } : {}),
            state: 'pending',
            recovery: 'pending',
            before,
            after,
          });
        }
        assertFileByteBudget(files.flatMap((f) => (f.before ? [f.before, f.after] : [f.after])));
        const journal: DirectoryWriterJournal = {
          id: newId(),
          owner: binding.principal.owner,
          scope: binding.principal.scope,
          requestId: binding.requestId,
          slot: binding.slot,
          expectedRevision: binding.expectedRevision,
          ...(binding.exportId !== undefined ? { exportId: binding.exportId } : {}),
          ...(binding.metadata !== undefined ? { metadata: binding.metadata } : {}),
          mode: binding.mode,
          rootId: root.id,
          folderName,
          folderExisted: !!existing,
          projectKey: keyFor(captured),
          phase: 'prepared',
          createdAt: now(),
          overwriteConfirmed: false,
          folderHandle: existing,
          files,
        };
        let preparedId = journal.id;
        await persist((next) => {
          exportTicket?.assertCurrent();
          const existingArchive = next.archives.find(
            (a) => a.owner === journal.owner && a.requestId === journal.requestId,
          );
          const existing =
            existingArchive?.receipt ??
            next.saves.find((s) => s.owner === journal.owner && s.requestId === journal.requestId);
          if (existing) {
            if (
              existing.slot !== journal.slot ||
              existing.expectedRevision !== journal.expectedRevision ||
              existing.exportId !== journal.exportId ||
              existing.metadata !== journal.metadata ||
              existing.mode !== journal.mode ||
              (journal.mode === 'save-as' &&
                (existing.rootId !== journal.rootId ||
                  directoryNameKey(existing.folderName) !== directoryNameKey(journal.folderName)))
            )
              throw new DirectorySaveError(
                'invalid-request',
                'Request ID belongs to a different save',
              );
            preparedId = existing.id;
            return;
          }
          const older = next.saves
            .filter((s) => s.owner === journal.owner && s.phase === 'prepared')
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(7);
          next.saves = next.saves.filter((s) => !older.some((old) => old.id === s.id));
          next.saves.push(journal);
        }, journal.id);
        const savedArchive = archived(preparedId, binding.principal);
        return savedArchive
          ? archivedReceipt(savedArchive)
          : proposal(data.saves.find((s) => s.id === preparedId)!);
      } finally {
        exportTicket?.dispose?.();
      }
    },
    commit: (id, p, review) => perform(id, p, false, false, review?.allowOverwrite === true),
    async retry(id, p) {
      return perform(id, p, false, true);
    },
    recover: (id, p) => perform(id, p, true, true),
    async status(id, p) {
      await ready(true);
      data = await read(true);
      const historical = archived(id, p);
      if (historical) {
        publish();
        return archivedReceipt(historical);
      }
      const save = owned(id, p);
      publish();
      return proposal(save);
    },
    async exportRecovery(id, p) {
      await ready(true);
      data = await read(true);
      const historical = archived(id, p);
      if (historical) return archiveUnavailable(historical);
      const save = owned(id, p);
      await verifyBlobs(save);
      const manifest = {
        format: 'fusion-studio-directory-recovery',
        version: 1,
        atomic: false,
        proposal: proposal(save),
        introduced: receipt(save, false).introduced,
        restored: receipt(save, false).restored,
      };
      return [
        {
          path: 'manifest.json',
          blob: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
        },
        ...save.files.flatMap((f) => [
          ...(f.before ? [{ path: `before/${f.path}`, blob: f.before }] : []),
          { path: `desired/${f.path}`, blob: f.after },
        ]),
      ];
    },
    async forgetRecovery(id, p) {
      await ready(true);
      data = await read(true);
      const historical = archived(id, p);
      if (historical) return archiveUnavailable(historical);
      const save = owned(id, p);
      if (save.phase !== 'prepared')
        throw new DirectorySaveError(
          'conflict',
          'Written or uncertain recovery records cannot be discarded',
        );
      await persist((next) => {
        const fresh = next.saves.find((item) => item.id === id);
        if (!fresh || fresh.owner !== actor(p).owner || fresh.phase !== 'prepared')
          throw new DirectorySaveError(
            'conflict',
            'Only a current, unwritten review owned by this actor can be discarded',
          );
        next.saves = next.saves.filter((s) => s.id !== id);
      });
    },
    async reviewArchive(id, p) {
      const principal = actor(p);
      await ready(true);
      data = await read(true);
      publish();
      const historical = archived(id, p);
      if (historical) return archiveUnavailable(historical);
      const save = owned(id, p);
      if (!terminal(save.phase) || active.has(id) || (save.claim && save.claim.until > now()))
        throw new DirectorySaveError(
          'conflict',
          'Only a completed save or recovery with no active claim can be archived',
          proposal(save),
        );
      const review: DirectoryArchiveReview = freeze({
        id: newId(),
        saveId: save.id,
        slot: save.slot,
        phase: save.phase as DirectoryArchiveReview['phase'],
        envelopeRevision: data.revision,
        manifestSha256: await manifest(save),
        recoveryBytes: save.files.reduce((n, f) => n + f.after.size + (f.before?.size ?? 0), 0),
        proposal: proposal(save),
      });
      // Reviews are ephemeral. Pruning one never removes recovery bytes or a durable receipt.
      while (archiveReviews.size >= 32) archiveReviews.delete(archiveReviews.keys().next().value!);
      archiveReviews.set(review.id, { owner: principal.owner, review, consumed: false });
      return review;
    },
    async archive(reviewId, p, confirmation) {
      idValue(reviewId);
      const principal = actor(p);
      if (confirmation?.confirm !== true || confirmation?.removeLocalRecovery !== true)
        throw new DirectorySaveError(
          'invalid-request',
          'Explicitly confirm removal of the reviewed local recovery bytes',
        );
      const pending = archiveReviews.get(reviewId);
      if (!pending || pending.owner !== principal.owner)
        throw new DirectorySaveError(
          'invalid-request',
          'Archive review is unavailable to this owner',
        );
      await ready(true);
      data = await read(true);
      publish();
      const historical = archived(pending.review.saveId, p);
      if (historical) {
        if (historical.reviewId !== reviewId)
          throw new DirectorySaveError('conflict', 'A different archive review already completed');
        return archivedReceipt(historical);
      }
      if (pending.consumed)
        throw new DirectorySaveError(
          'conflict',
          'This archive review was already attempted. Read status or create a fresh review after resolving storage.',
        );
      pending.consumed = true;
      await persist(
        async (next) => {
          const save = next.saves.find((s) => s.id === pending.review.saveId);
          if (
            !save ||
            save.owner !== principal.owner ||
            next.revision !== pending.review.envelopeRevision ||
            save.phase !== pending.review.phase ||
            !terminal(save.phase) ||
            active.has(save.id) ||
            (save.claim && save.claim.until > now()) ||
            (await manifest(save)) !== pending.review.manifestSha256
          )
            throw new DirectorySaveError(
              'conflict',
              'Archive review is stale. Read the current terminal record and review it again.',
            );
          const archivedAt = now();
          const historical: DirectoryArchivedSave = {
            owner: save.owner,
            scope: save.scope,
            requestId: save.requestId,
            projectKey: save.projectKey,
            reviewId,
            manifestSha256: pending.review.manifestSha256,
            receipt: {
              ...receipt(save, true),
              recoveryAvailable: false,
              archived: true,
              archivedAt,
            },
          };
          next.archives.push(historical);
          next.saves = next.saves.filter((s) => s.id !== save.id);
        },
        undefined,
        undefined,
        true,
      );
      return archivedReceipt(archived(pending.review.saveId, p)!);
    },
  };
  return controller;
}
