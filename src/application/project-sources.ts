import type { Project, Slot } from '../domain/model';
import type { ExecutionPrincipal } from './execution-context';
import type { TransferJson } from './file-transfers';

/** Browser capabilities kept locally in IndexedDB; never serialize these to tool output. */
export interface ProjectFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
}
export interface ProjectDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
  getDirectoryHandle(name: string): Promise<ProjectDirectoryHandle>;
  values(): AsyncIterableIterator<ProjectDirectoryHandle | ProjectFileHandle>;
  isSameEntry(other: ProjectDirectoryHandle): Promise<boolean>;
}
export type ProjectSourceReference =
  | { kind: 'directory-project'; rootId: string; folderName: string }
  | { kind: 'library-snapshot'; libraryId: string };
export interface StoredProjectSource {
  id: string;
  source: ProjectSourceReference;
  label: string;
  modifiedAt?: number;
}
export interface ProjectSourcesEnvelope {
  version: 1;
  revision: number;
  roots: { id: string; label: string; handle: ProjectDirectoryHandle }[];
  sources: StoredProjectSource[];
  recent: { sourceId: string; openedAt: number }[];
  activeRootId?: string;
  sort?: ProjectSourceSort;
}
export interface ProjectSourcesBackend {
  read(): Promise<unknown | null>;
  /** Atomic compare-and-swap. Null means the database must still be empty. */
  write(next: ProjectSourcesEnvelope, expectedRevision: number | null): Promise<void>;
}
export interface ProjectSourceSummary {
  id: string;
  kind: ProjectSourceReference['kind'];
  label: string;
  rootId?: string;
  modifiedAt?: number;
  openedAt?: number;
}
export interface ProjectSourcesSnapshot {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  hydrated: boolean;
  saving: boolean;
  error: string | null;
  roots: readonly { id: string; label: string }[];
  activeRootId?: string;
  sort: Readonly<ProjectSourceSort>;
  recent: readonly ProjectSourceSummary[];
}
export interface ProjectSourceSort {
  by: 'name' | 'modified';
  direction: 'ascending' | 'descending';
}
export interface ProjectSourceListing {
  rootId: string;
  entries: readonly ProjectSourceSummary[];
  sort: Readonly<ProjectSourceSort>;
  /** Browser Intl adaptation; Windows NLS comparison equivalence is not claimed. */
  comparison: 'browser-locale';
  needsHumanGrant: boolean;
  reason?: string;
}
export interface ProjectOpenBinding {
  target: Slot | 'both';
  expectedRevision: number;
  requestId: string;
  principal: ExecutionPrincipal;
}
export interface ProjectOpenCommitMetadata {
  workflow: 'source-open';
  sourceId: string;
  target: Slot | 'both';
  expectedRevision: number;
  requestId: string;
}
export interface ProjectOpenReceipt {
  commitId: string;
  revision: number;
  result: TransferJson;
}
export interface ProjectOpenResult {
  receipt: ProjectOpenReceipt;
  replayed: boolean;
  recentSaved: boolean;
  recentWarning?: string;
}
declare const preparedProjectOpenBrand: unique symbol;
export interface PreparedProjectOpen {
  readonly [preparedProjectOpenBrand]: true;
}
export interface ProjectSourcesOptions {
  backend?: ProjectSourcesBackend;
  /** Resolve one existing local vault record; return undefined if removed/missing. */
  resolveLibrary: (id: string) => Promise<Project | undefined>;
  /** Must atomically persist the document mutation and this result as one durable receipt. */
  commit: (
    binding: Readonly<ProjectOpenBinding>,
    project: Project,
    commitId: string,
    result: ProjectOpenCommitMetadata,
  ) => Promise<ProjectOpenReceipt>;
  lookup: (
    commitId: string,
    principal: Readonly<ExecutionPrincipal>,
  ) => Promise<ProjectOpenReceipt | undefined>;
  compareNames?: (a: string, b: string) => number;
  now?: () => number;
  id?: () => string;
}
export interface ProjectSources {
  getSnapshot(): ProjectSourcesSnapshot;
  subscribe(listener: () => void): () => void;
  hydrate(): Promise<void>;
  retry(): Promise<void>;
  flush(): Promise<void>;
  /** Human chooser supplies a read-granted capability. This method never prompts. */
  registerDirectory(handle: ProjectDirectoryHandle): Promise<string>;
  selectRoot(rootId: string): Promise<void>;
  list(rootId: string, sort?: ProjectSourceSort): Promise<ProjectSourceListing>;
  rememberLibrary(input: { id: string; label: string; modifiedAt?: number }): Promise<string>;
  prepareOpen(input: ProjectOpenBinding & { sourceId: string }): Promise<PreparedProjectOpen>;
  commitOpen(prepared: PreparedProjectOpen): Promise<ProjectOpenResult>;
  open(input: ProjectOpenBinding & { sourceId: string }): Promise<ProjectOpenResult>;
  forgetRecent(sourceId: string): Promise<void>;
  clearRecent(): Promise<void>;
  forgetRoot(rootId: string): Promise<void>;
}

import { projectSchema } from '../domain/files';
import { parseExecutionPrincipal } from './execution-context';
import { createIndexedDbProjectSourcesBackend } from './project-sources-storage';
import { parseProjectSourcesEnvelope, projectSourcesMetadata } from './project-sources-format';
import {
  hasProjectReadPermission,
  isProjectDirectoryHandle,
  listDirectoryProjects,
  readDirectoryProject,
} from './directory-project-source';

export type ProjectSourcesErrorCode =
  | 'needs-human-grant'
  | 'missing-source'
  | 'invalid-project'
  | 'persistence'
  | 'invalid-request'
  | 'source-changed'
  | 'commit-failed';
export class ProjectSourcesError extends Error {
  readonly needsHumanGrant: boolean;
  recentWarning?: string;
  constructor(
    readonly code: ProjectSourcesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectSourcesError';
    this.needsHumanGrant = code === 'needs-human-grant';
  }
  toJSON() {
    return {
      ok: false,
      code: this.code,
      error: this.message,
      needsHumanGrant: this.needsHumanGrant,
      ...(this.recentWarning ? { recentWarning: this.recentWarning } : {}),
    };
  }
}
const emptyEnvelope = (): ProjectSourcesEnvelope => ({
  version: 1,
  revision: 0,
  roots: [],
  sources: [],
  recent: [],
});
const idleSnapshot: ProjectSourcesSnapshot = Object.freeze({
  phase: 'idle',
  hydrated: false,
  saving: false,
  error: null,
  roots: Object.freeze([]),
  sort: Object.freeze({ by: 'name', direction: 'ascending' }),
  recent: Object.freeze([]),
});
const checkId = (value: string) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,256}$/.test(value))
    throw new ProjectSourcesError('invalid-request', 'Invalid local project-source identifier');
  return value;
};
function freezeBinding(input: ProjectOpenBinding): Readonly<ProjectOpenBinding> {
  if (!input?.principal)
    throw new ProjectSourcesError('invalid-request', 'Trusted execution context is required');
  const principal = Object.freeze(
    parseExecutionPrincipal({ owner: input.principal.owner, scope: input.principal.scope }),
  );
  if (
    !['left', 'right', 'both'].includes(input.target) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    typeof input.requestId !== 'string' ||
    !/^[a-zA-Z0-9._:-]{1,128}$/.test(input.requestId)
  )
    throw new ProjectSourcesError(
      'invalid-request',
      'Open requires an explicit target, current revision and request ID',
    );
  return Object.freeze({
    target: input.target,
    expectedRevision: input.expectedRevision,
    requestId: input.requestId,
    principal,
  });
}
const metadataFor = (
  sourceId: string,
  binding: Readonly<ProjectOpenBinding>,
): ProjectOpenCommitMetadata => ({
  workflow: 'source-open',
  sourceId,
  target: binding.target,
  expectedRevision: binding.expectedRevision,
  requestId: binding.requestId,
});
const sameMetadata = (value: unknown, expected: ProjectOpenCommitMetadata) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 5
  )
    return false;
  return Object.entries(expected).every(
    ([key, item]) => Object.hasOwn(value, key) && (value as Record<string, unknown>)[key] === item,
  );
};
function receiptFor(
  value: ProjectOpenReceipt,
  commitId: string,
  metadata: ProjectOpenCommitMetadata,
): ProjectOpenReceipt {
  if (
    !value ||
    value.commitId !== commitId ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !sameMetadata(value.result, metadata)
  )
    throw new ProjectSourcesError(
      'invalid-request',
      'Request ID belongs to a different open operation or its durable receipt is invalid',
    );
  return structuredClone(value);
}
function cloneEnvelope(value: ProjectSourcesEnvelope): ProjectSourcesEnvelope {
  return {
    ...value,
    roots: value.roots.map((root) => ({ ...root })),
    ...(value.sort ? { sort: { ...value.sort } } : {}),
    sources: structuredClone(value.sources),
    recent: structuredClone(value.recent),
  };
}
function summary(source: StoredProjectSource, openedAt?: number): ProjectSourceSummary {
  return Object.freeze({
    id: source.id,
    kind: source.source.kind,
    label: source.label,
    ...(source.source.kind === 'directory-project' ? { rootId: source.source.rootId } : {}),
    ...(source.modifiedAt !== undefined ? { modifiedAt: source.modifiedAt } : {}),
    ...(openedAt !== undefined ? { openedAt } : {}),
  });
}
function sortSettings(value?: ProjectSourceSort): ProjectSourceSort {
  if (
    value &&
    (Object.keys(value).length !== 2 ||
      !['name', 'modified'].includes(value.by) ||
      !['ascending', 'descending'].includes(value.direction))
  )
    throw new ProjectSourcesError('invalid-request', 'Invalid project sort');
  return value ? { ...value } : { by: 'name', direction: 'ascending' };
}

/** One page-owned service shared by UI and trusted MCP adapters. No device APIs. */
export function createProjectSources(options: ProjectSourcesOptions): ProjectSources {
  const backend = options.backend ?? createIndexedDbProjectSourcesBackend();
  const now = options.now ?? Date.now,
    newId = options.id ?? (() => crypto.randomUUID());
  const compare =
    options.compareNames ??
    new Intl.Collator(undefined, { usage: 'sort', sensitivity: 'variant' }).compare;
  let data = emptyEnvelope(),
    diskRevision: number | null = null,
    snapshot = idleSnapshot;
  let queue: Promise<void> = Promise.resolve(),
    hydration: Promise<void> | undefined;
  const listeners = new Set<() => void>(),
    epochs = new Map<string, number>(),
    listingEpochs = new Map<string, number>();
  let sortEpoch = 0;
  const tokens = new WeakMap<
    PreparedProjectOpen,
    {
      sourceId: string;
      binding: Readonly<ProjectOpenBinding>;
      metadata: ProjectOpenCommitMetadata;
      commitId: string;
      project?: Project;
      receipt?: ProjectOpenReceipt;
      rootId?: string;
      epoch?: number;
    }
  >();
  const commits = new Map<
    string,
    { metadata: ProjectOpenCommitMetadata; promise: Promise<ProjectOpenResult> }
  >();
  const opens = new Map<
    string,
    { metadata: ProjectOpenCommitMetadata; promise: Promise<ProjectOpenResult> }
  >();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  };
  const publish = (
    patch: Partial<Pick<ProjectSourcesSnapshot, 'phase' | 'hydrated' | 'saving' | 'error'>>,
  ) => {
    snapshot = Object.freeze({
      ...snapshot,
      ...patch,
      roots: Object.freeze(data.roots.map(({ id, label }) => Object.freeze({ id, label }))),
      activeRootId: data.activeRootId,
      sort: Object.freeze(data.sort ? { ...data.sort } : { by: 'name', direction: 'ascending' }),
      recent: Object.freeze(
        data.recent.map(({ sourceId, openedAt }) =>
          summary(
            data.sources.find(({ id }) => id === sourceId)!,
            openedAt,
          ),
        ),
      ),
    });
    for (const listener of listeners) listener();
  };
  const hydrate = (): Promise<void> => {
    if (snapshot.hydrated) return Promise.resolve();
    hydration ??= enqueue(async () => {
      publish({ phase: 'loading', saving: false, error: null });
      try {
        const stored = await backend.read();
        const checked = stored === null ? emptyEnvelope() : parseProjectSourcesEnvelope(stored);
        data = checked;
        diskRevision = stored === null ? null : checked.revision;
        publish({ phase: 'ready', hydrated: true, error: null });
      } catch {
        publish({
          phase: 'error',
          error:
            'Local project sources could not be read. Prior data was retained; retry or use folder import.',
        });
        throw new ProjectSourcesError('persistence', snapshot.error!);
      }
    }).finally(() => {
      hydration = undefined;
    });
    return hydration;
  };
  const ready = async () => {
    await hydrate();
    if (snapshot.phase !== 'ready')
      throw new ProjectSourcesError(
        'persistence',
        snapshot.error ?? 'Retry local project-source storage before continuing',
      );
  };
  const mutate = async (change: (next: ProjectSourcesEnvelope) => void): Promise<void> => {
    await ready();
    await enqueue(async () => {
      if (snapshot.phase !== 'ready')
        throw new ProjectSourcesError(
          'persistence',
          snapshot.error ?? 'Retry local project-source storage',
        );
      const next = cloneEnvelope(data);
      change(next);
      if (
        projectSourcesMetadata(next) === projectSourcesMetadata(data) &&
        next.roots.every((root, index) => root.handle === data.roots[index]?.handle)
      )
        return;
      next.revision = (diskRevision ?? 0) + 1;
      if (!Number.isSafeInteger(next.revision))
        throw new ProjectSourcesError('persistence', 'Local project-source revision is exhausted');
      parseProjectSourcesEnvelope(next);
      publish({ saving: true, error: null });
      try {
        await backend.write(next, diskRevision);
        // Once write is acknowledged, verification failure must not permit an old revision overwrite.
        diskRevision = next.revision;
        const confirmed = parseProjectSourcesEnvelope(await backend.read());
        if (projectSourcesMetadata(confirmed) !== projectSourcesMetadata(next))
          throw new Error('Project-source readback differs');
        for (const root of next.roots) {
          const saved = confirmed.roots.find(({ id }) => id === root.id)!;
          if (saved.handle !== root.handle && !(await root.handle.isSameEntry(saved.handle)))
            throw new Error('Directory capability readback differs');
        }
        data = confirmed;
        publish({ phase: 'ready', saving: false, error: null });
      } catch {
        publish({
          phase: 'error',
          saving: false,
          error:
            'Local project-source changes were not verified. Prior data was retained; retry storage before making more changes.',
        });
        throw new ProjectSourcesError('persistence', snapshot.error!);
      }
    });
  };
  const timestamp = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new ProjectSourcesError('invalid-request', 'Invalid local clock');
    return value;
  };
  const identifier = () => checkId(newId());
  const touch = async (
    sourceId: string,
  ): Promise<{ recentSaved: boolean; recentWarning?: string }> => {
    try {
      await ready();
      if (!data.sources.some(({ id }) => id === sourceId))
        return {
          recentSaved: false,
          recentWarning:
            'The durable open was recovered, but its local recent reference is no longer registered.',
        };
      await mutate((next) => {
        if (!next.sources.some(({ id }) => id === sourceId)) return;
        next.recent = [
          { sourceId, openedAt: timestamp() },
          ...next.recent.filter((entry) => entry.sourceId !== sourceId),
        ].slice(0, 10);
      });
      return { recentSaved: true };
    } catch {
      return {
        recentSaved: false,
        recentWarning:
          'The open result is separate from recent-list storage. Recent changes were not saved; retry local source storage.',
      };
    }
  };
  const checkedLookup = async (
    commitId: string,
    binding: Readonly<ProjectOpenBinding>,
    metadata: ProjectOpenCommitMetadata,
  ) => {
    let existing: ProjectOpenReceipt | undefined;
    try {
      existing = await options.lookup(commitId, binding.principal);
    } catch {
      throw new ProjectSourcesError(
        'persistence',
        'The prior open receipt could not be checked; no new document application was attempted',
      );
    }
    return existing ? receiptFor(existing, commitId, metadata) : undefined;
  };
  const validateRoot = (rootId: string, epoch: number) => {
    if (!data.roots.some(({ id }) => id === rootId) || (epochs.get(rootId) ?? 0) !== epoch)
      throw new ProjectSourcesError(
        'source-changed',
        'The directory source changed while opening. The document was not applied.',
      );
  };
  const prepareOpen = async (
    input: ProjectOpenBinding & { sourceId: string },
  ): Promise<PreparedProjectOpen> => {
    const binding = freezeBinding(input),
      sourceId = checkId(input.sourceId),
      metadata = metadataFor(sourceId, binding),
      commitId = `source-open:${binding.principal.owner}:${binding.requestId}`;
    const receipt = await checkedLookup(commitId, binding, metadata);
    const token = Object.freeze({}) as PreparedProjectOpen;
    if (receipt) {
      tokens.set(token, { sourceId, binding, metadata, commitId, receipt });
      return token;
    }
    await ready();
    const stored = data.sources.find(({ id }) => id === sourceId);
    if (!stored)
      throw new ProjectSourcesError('missing-source', 'The local project source was not found');
    const source = structuredClone(stored.source);
    let rootId: string | undefined, epoch: number | undefined, project: Project;
    try {
      if (source.kind === 'directory-project') {
        rootId = source.rootId;
        epoch = epochs.get(rootId) ?? 0;
        const root = data.roots.find(({ id }) => id === rootId);
        if (!root || !(await hasProjectReadPermission(root.handle)))
          throw new ProjectSourcesError(
            'needs-human-grant',
            'A human must select or reauthorize this project database folder. No permission prompt was opened.',
          );
        try {
          project = await readDirectoryProject(root.handle, source.folderName);
        } catch (error) {
          if (!(await hasProjectReadPermission(root.handle)))
            throw new ProjectSourcesError(
              'needs-human-grant',
              'Read access expired; a human must reauthorize this database folder',
            );
          if (
            error !== null &&
            typeof error === 'object' &&
            'name' in error &&
            error.name === 'NotFoundError'
          )
            throw new ProjectSourcesError(
              'missing-source',
              'The project folder or a required file is missing. Its recent entry was retained.',
            );
          throw new ProjectSourcesError(
            'invalid-project',
            'The fresh project folder failed existing import validation or file budgets. The current document was retained.',
          );
        }
        validateRoot(rootId, epoch);
      } else {
        let value: Project | undefined;
        try {
          value = await options.resolveLibrary(source.libraryId);
        } catch {
          throw new ProjectSourcesError(
            'persistence',
            'The local library snapshot could not be read',
          );
        }
        if (!value)
          throw new ProjectSourcesError(
            'missing-source',
            'The saved library snapshot is missing or removed. Its recent entry was retained.',
          );
        try {
          project = projectSchema.parse(value);
        } catch {
          throw new ProjectSourcesError(
            'invalid-project',
            'The library snapshot failed existing project validation. The current document was retained.',
          );
        }
      }
      tokens.set(token, { sourceId, binding, metadata, commitId, project, rootId, epoch });
      return token;
    } catch (error) {
      const recent = await touch(sourceId);
      if (error instanceof ProjectSourcesError) {
        if (!recent.recentSaved) error.recentWarning = recent.recentWarning;
        throw error;
      }
      throw new ProjectSourcesError(
        'invalid-project',
        'The project could not be opened; the current document was retained',
      );
    }
  };
  const commitOpen = (token: PreparedProjectOpen): Promise<ProjectOpenResult> => {
    const prepared = tokens.get(token);
    if (!prepared)
      return Promise.reject(
        new ProjectSourcesError(
          'invalid-request',
          'Prepared open belongs to a different page or was not created by this service',
        ),
      );
    const active = commits.get(prepared.commitId);
    if (active) {
      if (!sameMetadata(active.metadata, prepared.metadata))
        return Promise.reject(
          new ProjectSourcesError(
            'invalid-request',
            'Request ID is already in use by a different open operation',
          ),
        );
      return active.promise;
    }
    const promise = (async () => {
      let receipt = await checkedLookup(prepared.commitId, prepared.binding, prepared.metadata),
        replayed = !!receipt;
      if (!receipt) {
        if (prepared.rootId !== undefined) {
          validateRoot(prepared.rootId, prepared.epoch!);
          const root = data.roots.find(({ id }) => id === prepared.rootId)!;
          if (!(await hasProjectReadPermission(root.handle)))
            throw new ProjectSourcesError(
              'needs-human-grant',
              'Read access expired before application; a human must reauthorize the database folder',
            );
          validateRoot(prepared.rootId, prepared.epoch!);
        }
        if (!prepared.project)
          throw new ProjectSourcesError(
            'persistence',
            'The durable open receipt is no longer available; no document was reapplied',
          );
        try {
          const result = await options.commit(
            prepared.binding,
            structuredClone(prepared.project),
            prepared.commitId,
            { ...prepared.metadata },
          );
          receipt = receiptFor(result, prepared.commitId, prepared.metadata);
        } catch (error) {
          const recovered = await checkedLookup(
            prepared.commitId,
            prepared.binding,
            prepared.metadata,
          );
          if (recovered) {
            receipt = recovered;
            replayed = true;
          } else {
            await touch(prepared.sourceId);
            if (error instanceof ProjectSourcesError) throw error;
            throw new ProjectSourcesError(
              'commit-failed',
              'The workspace did not confirm this open. Retry with the same request ID to recover its durable receipt.',
            );
          }
        }
      }
      prepared.receipt = receipt;
      prepared.project = undefined;
      return { receipt, replayed, ...(await touch(prepared.sourceId)) };
    })();
    commits.set(prepared.commitId, { metadata: prepared.metadata, promise });
    void promise
      .finally(() => {
        if (commits.get(prepared.commitId)?.promise === promise) commits.delete(prepared.commitId);
      })
      .catch(() => {});
    return promise;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hydrate,
    async retry() {
      await queue;
      if (hydration) return hydration;
      const previousHydrated = snapshot.hydrated;
      publish({ hydrated: false });
      try {
        await hydrate();
      } catch (error) {
        publish({ hydrated: previousHydrated });
        throw error;
      }
    },
    async flush() {
      await queue;
      if (snapshot.phase === 'error') throw new ProjectSourcesError('persistence', snapshot.error!);
    },
    async registerDirectory(handle) {
      await ready();
      if (!isProjectDirectoryHandle(handle))
        throw new ProjectSourcesError(
          'invalid-request',
          'A real read-only directory capability is required',
        );
      if (!(await hasProjectReadPermission(handle)))
        throw new ProjectSourcesError(
          'needs-human-grant',
          'A human must grant read access before registering this folder',
        );
      let rootId: string | undefined;
      for (const root of data.roots) {
        try {
          if (await handle.isSameEntry(root.handle)) {
            rootId = root.id;
            break;
          }
        } catch {}
      }
      const selectedId = rootId ?? identifier();
      await mutate((next) => {
        const existing = next.roots.find(({ id }) => id === selectedId);
        if (existing) {
          existing.handle = handle;
          existing.label = handle.name || 'Project database';
        } else {
          if (
            next.roots.length >= 32 ||
            next.roots.some(({ id }) => id === selectedId) ||
            next.sources.some(({ id }) => id === selectedId)
          )
            throw new ProjectSourcesError(
              'invalid-request',
              'Local database source capacity or identifier collision',
            );
          next.roots.push({ id: selectedId, label: handle.name || 'Project database', handle });
        }
        next.activeRootId = selectedId;
      });
      return selectedId;
    },
    async selectRoot(rootId) {
      checkId(rootId);
      await mutate((next) => {
        if (!next.roots.some(({ id }) => id === rootId))
          throw new ProjectSourcesError(
            'needs-human-grant',
            'A human must select this database folder again',
          );
        next.activeRootId = rootId;
      });
    },
    async list(rootId, inputSort) {
      checkId(rootId);
      await ready();
      const sort = sortSettings(inputSort ?? data.sort);
      const listingEpoch = (listingEpochs.get(rootId) ?? 0) + 1;
      listingEpochs.set(rootId, listingEpoch);
      const requestedSortEpoch = inputSort ? ++sortEpoch : sortEpoch;
      const root = data.roots.find(({ id }) => id === rootId),
        epoch = epochs.get(rootId) ?? 0;
      const blocked = (reason: string): ProjectSourceListing => ({
        rootId,
        entries: Object.freeze([]),
        sort: Object.freeze(sort),
        comparison: 'browser-locale',
        needsHumanGrant: true,
        reason,
      });
      if (!root || !(await hasProjectReadPermission(root.handle)))
        return blocked(
          'A human must select or reauthorize this database folder; no permission prompt was opened',
        );
      let listed;
      try {
        listed = await listDirectoryProjects(root.handle);
      } catch {
        if (!(await hasProjectReadPermission(root.handle)))
          return blocked('Read access expired; reauthorize the database folder');
        throw new ProjectSourcesError(
          'invalid-project',
          'The database directory could not be enumerated within its entry budget',
        );
      }
      validateRoot(rootId, epoch);
      if (listingEpochs.get(rootId) !== listingEpoch)
        throw new ProjectSourcesError(
          'source-changed',
          'A newer database listing replaced this request',
        );
      const ids = new Map<string, string>();
      await mutate((next) => {
        validateRoot(rootId, epoch);
        if (listingEpochs.get(rootId) !== listingEpoch)
          throw new ProjectSourcesError(
            'source-changed',
            'A newer database listing replaced this request',
          );
        if (requestedSortEpoch === sortEpoch) next.sort = { ...sort };
        const recentIds = new Set(next.recent.map(({ sourceId }) => sourceId));
        const names = new Set(listed.map(({ folderName }) => folderName));
        next.sources = next.sources.filter(
          (entry) =>
            entry.source.kind !== 'directory-project' ||
            entry.source.rootId !== rootId ||
            names.has(entry.source.folderName) ||
            recentIds.has(entry.id),
        );
        for (const found of listed) {
          let source = next.sources.find(
            (entry) =>
              entry.source.kind === 'directory-project' &&
              entry.source.rootId === rootId &&
              entry.source.folderName === found.folderName,
          );
          if (!source) {
            const id = identifier();
            if (
              next.sources.some((entry) => entry.id === id) ||
              next.roots.some((entry) => entry.id === id)
            )
              throw new ProjectSourcesError('invalid-request', 'Local source identifier collision');
            source = {
              id,
              source: { kind: 'directory-project', rootId, folderName: found.folderName },
              label: found.label,
              modifiedAt: found.modifiedAt,
            };
            next.sources.push(source);
          } else {
            source.label = found.label;
            source.modifiedAt = found.modifiedAt;
          }
          ids.set(found.folderName, source.id);
        }
      });
      const entries = listed.map((entry) =>
        summary(data.sources.find(({ id }) => id === ids.get(entry.folderName))!),
      );
      entries.sort((a, b) => {
        const result =
          sort.by === 'name'
            ? compare(a.label, b.label)
            : (a.modifiedAt ?? 0) - (b.modifiedAt ?? 0);
        if (!Number.isFinite(result))
          throw new ProjectSourcesError(
            'invalid-request',
            'Project name comparator returned an invalid result',
          );
        return sort.direction === 'ascending' ? result : -result;
      });
      return {
        rootId,
        entries: Object.freeze(entries),
        sort: Object.freeze(sort),
        comparison: 'browser-locale',
        needsHumanGrant: false,
      };
    },
    async rememberLibrary(input) {
      checkId(input.id);
      let sourceId = '';
      await mutate((next) => {
        let source = next.sources.find(
          (entry) =>
            entry.source.kind === 'library-snapshot' && entry.source.libraryId === input.id,
        );
        if (!source) {
          const id = identifier();
          if (
            next.sources.some((entry) => entry.id === id) ||
            next.roots.some((entry) => entry.id === id)
          )
            throw new ProjectSourcesError('invalid-request', 'Local source identifier collision');
          source = {
            id,
            source: { kind: 'library-snapshot', libraryId: input.id },
            label: input.label,
            ...(input.modifiedAt !== undefined ? { modifiedAt: input.modifiedAt } : {}),
          };
          next.sources.push(source);
        } else {
          source.label = input.label;
          source.modifiedAt = input.modifiedAt;
        }
        sourceId = source.id;
        next.recent = [
          { sourceId, openedAt: timestamp() },
          ...next.recent.filter((entry) => entry.sourceId !== sourceId),
        ].slice(0, 10);
      });
      return sourceId;
    },
    prepareOpen,
    commitOpen,
    open(input) {
      const binding = freezeBinding(input),
        sourceId = checkId(input.sourceId),
        metadata = metadataFor(sourceId, binding),
        key = `source-open:${binding.principal.owner}:${binding.requestId}`;
      const existing = opens.get(key);
      if (existing) {
        if (!sameMetadata(existing.metadata, metadata))
          return Promise.reject(
            new ProjectSourcesError(
              'invalid-request',
              'Request ID is already in use by a different open operation',
            ),
          );
        return existing.promise;
      }
      const promise = prepareOpen({ ...binding, sourceId }).then(commitOpen);
      opens.set(key, { metadata, promise });
      void promise
        .finally(() => {
          if (opens.get(key)?.promise === promise) opens.delete(key);
        })
        .catch(() => {});
      return promise;
    },
    async forgetRecent(sourceId) {
      checkId(sourceId);
      await mutate((next) => {
        next.recent = next.recent.filter((entry) => entry.sourceId !== sourceId);
      });
    },
    async clearRecent() {
      await mutate((next) => {
        next.recent = [];
      });
    },
    async forgetRoot(rootId) {
      checkId(rootId);
      epochs.set(rootId, (epochs.get(rootId) ?? 0) + 1);
      await mutate((next) => {
        next.roots = next.roots.filter(({ id }) => id !== rootId);
        if (next.activeRootId === rootId) delete next.activeRootId;
        const recentIds = new Set(next.recent.map(({ sourceId }) => sourceId));
        next.sources = next.sources.filter(
          (entry) =>
            entry.source.kind !== 'directory-project' ||
            entry.source.rootId !== rootId ||
            recentIds.has(entry.id),
        );
      });
    },
  };
}
