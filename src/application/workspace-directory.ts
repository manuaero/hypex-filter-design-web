import { z } from 'zod';
import { WorkspaceAuthorityDisposedError, type WorkspaceAuthority } from './workspace-authority';
import { parseExecutionPrincipal, type ExecutionPrincipal } from './execution-context';
import {
  DirectorySaveError,
  type ProjectDirectoryWriter,
  type DirectoryWriterEnvelope,
  type DirectorySaveProposal,
  type DirectorySavePhase,
  type DirectorySaveInput,
  type DirectoryWriterSnapshot,
} from './project-directory-writer';
import {
  openDirectoryWriterDatabase,
  parseDirectoryWriterEnvelope,
} from './directory-writer-storage';
import {
  parseStoredWorkspaceAuthority,
  WORKSPACE_AUTHORITY_KEY,
} from './workspace-authority-storage';
import { directoryNameKey, withDirectoryWriteLock } from './directory-writer-fs';
import { sha256TransferBytes } from './file-transfers';

export interface DirectoryLegacyReview {
  id: string;
  recordId: string;
  slot: 'left' | 'right';
  phase: DirectorySavePhase;
  envelopeRevision: number;
  manifestSha256: string;
  proposal: DirectorySaveProposal;
}
export interface DirectoryLegacyAccess {
  reviewLegacy(id: string, principal: ExecutionPrincipal): Promise<DirectoryLegacyReview>;
  adoptLegacy(
    reviewId: string,
    principal: ExecutionPrincipal,
    confirmation: { confirm: true },
  ): Promise<DirectorySaveProposal>;
}
export interface DirectoryAdoptionGrant {
  recordId: string;
  originalOwner: string;
  workspaceOwner: string;
  bindingSha256: string;
  adoptedAt: number;
  reviewId: string;
}
export interface DirectoryAdoptions {
  version: 1;
  revision: number;
  grants: DirectoryAdoptionGrant[];
}
export interface WorkspaceDirectoryStored {
  writer: unknown | null;
  authority: unknown;
  adoptions: unknown | null;
}
/** update must run its synchronous callback in one strict transaction covering writer state and authority. */
export interface WorkspaceDirectoryBackend {
  read(): Promise<WorkspaceDirectoryStored>;
  update(change: (current: WorkspaceDirectoryStored) => DirectoryAdoptions): Promise<void>;
}
export interface WorkspaceDirectoryOptions {
  writer: ProjectDirectoryWriter;
  authority: WorkspaceAuthority;
  backend?: WorkspaceDirectoryBackend;
  now?: () => number;
  id?: () => string;
  withLock?: <T>(name: string, work: () => Promise<T>) => Promise<T>;
}
const ADOPTIONS_KEY = 'directory-adoptions';
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9._:-]+$/);
const principalString = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const grantsSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    grants: z
      .array(
        z
          .object({
            recordId: identifier,
            originalOwner: principalString,
            workspaceOwner: z
              .string()
              .refine((v) => v.startsWith('workspace:') && uuid.test(v.slice(10))),
            bindingSha256: z.string().regex(/^[a-f0-9]{64}$/),
            adoptedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            reviewId: identifier,
          })
          .strict(),
      )
      .max(4128),
  })
  .strict();
function parseGrants(value: unknown | null): DirectoryAdoptions {
  const result =
    value === null ? { version: 1 as const, revision: 0, grants: [] } : grantsSchema.parse(value);
  if (
    new Set(result.grants.map((g) => g.recordId)).size !== result.grants.length ||
    new TextEncoder().encode(JSON.stringify(result)).length > 8 * 1024 * 1024
  )
    throw new Error('Invalid or oversized legacy-access grants');
  return result;
}
export function createIndexedDbWorkspaceDirectoryBackend(): WorkspaceDirectoryBackend {
  const readFrom = async (
    tx: ReturnType<Awaited<ReturnType<typeof openDirectoryWriterDatabase>>['transaction']>,
  ): Promise<WorkspaceDirectoryStored> => {
    const [writer, authority, adoptions] = await Promise.all([
      tx.objectStore('state').get('writer'),
      tx.objectStore('authority').get(WORKSPACE_AUTHORITY_KEY),
      tx.objectStore('authority').get(ADOPTIONS_KEY),
    ]);
    return { writer: writer ?? null, authority, adoptions: adoptions ?? null };
  };
  return {
    async read() {
      const database = await openDirectoryWriterDatabase(),
        tx = database.transaction(['state', 'authority'], 'readonly');
      const result = await readFrom(tx);
      await tx.done;
      return result;
    },
    async update(change) {
      const database = await openDirectoryWriterDatabase(),
        tx = database.transaction(['state', 'authority'], 'readwrite', { durability: 'strict' });
      try {
        if (tx.durability !== 'strict')
          throw new Error('Strict legacy-adoption durability is unavailable');
        const next = parseGrants(change(await readFrom(tx)));
        await tx.objectStore('authority').put(next, ADOPTIONS_KEY);
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
type RecordView = {
  owner: string;
  scope: string;
  requestId: string;
  projectKey: string;
  claim?: { id: string; until: number };
  proposal: DirectorySaveProposal;
  binding: string;
  manifest: string;
};
const digest = (value: unknown) =>
  sha256TransferBytes(new TextEncoder().encode(JSON.stringify(value)));
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function recordViews(state: DirectoryWriterEnvelope, writer: ProjectDirectoryWriter): RecordView[] {
  const live = state.saves.map((s) => ({
    owner: s.owner,
    scope: s.scope,
    requestId: s.requestId,
    projectKey: s.projectKey,
    claim: s.claim,
    proposal: {
      id: s.id,
      slot: s.slot,
      expectedRevision: s.expectedRevision,
      mode: s.mode,
      rootId: s.rootId,
      folderName: s.folderName,
      phase: s.phase,
      createdAt: s.createdAt,
      files: s.files.map(({ before: _b, after: _a, ...f }) => f),
      requiresOverwriteConfirmation:
        s.mode === 'save-as' && s.folderExisted && !s.overwriteConfirmed,
      recoveryAvailable: true,
      workspaceChanged:
        writer.getSnapshot().saves.find((p) => p.id === s.id)?.workspaceChanged ?? true,
      ...(s.error ? { error: s.error } : {}),
    },
  }));
  const archived = state.archives.map((a) => ({
    owner: a.owner,
    scope: a.scope,
    requestId: a.requestId,
    projectKey: a.projectKey,
    claim: undefined,
    proposal: a.receipt,
  }));
  return [...live, ...archived].map((r) => {
    const p = r.proposal;
    const binding = digest({
      id: p.id,
      owner: r.owner,
      scope: r.scope,
      requestId: r.requestId,
      projectKey: r.projectKey,
      slot: p.slot,
      expectedRevision: p.expectedRevision,
      mode: p.mode,
      rootId: p.rootId,
      folderName: p.folderName,
      createdAt: p.createdAt,
      files: p.files.map(({ path, action, bytes, sha256, beforeBytes, beforeSha256 }) => ({
        path,
        action,
        bytes,
        sha256,
        beforeBytes,
        beforeSha256,
      })),
    });
    return {
      ...r,
      proposal: p as DirectorySaveProposal,
      binding,
      manifest: digest({
        binding,
        phase: p.phase,
        files: p.files,
        claim: r.claim ?? null,
        error: p.error ?? null,
      }),
    };
  });
}
/** Keeps the strict writer's owner checks intact; only reviewed per-record legacy grants select its old owner. */
export function createWorkspaceDirectoryWriter(
  options: WorkspaceDirectoryOptions,
): ProjectDirectoryWriter & DirectoryLegacyAccess {
  const { writer, authority } = options,
    backend = options.backend ?? createIndexedDbWorkspaceDirectoryBackend(),
    now = options.now ?? Date.now,
    nextId = options.id ?? (() => crypto.randomUUID()),
    lock = options.withLock ?? withDirectoryWriteLock;
  let records: RecordView[] = [],
    grants: DirectoryAdoptions = { version: 1, revision: 0, grants: [] },
    owner: string | undefined,
    hydrated = false,
    error: string | null = null;
  let byId = new Map<string, RecordView>(),
    grantsById = new Map<string, DirectoryAdoptionGrant>();
  let stateRevision = 0,
    hydration: Promise<void> | undefined;
  const listeners = new Set<() => void>(),
    archiveTargets = new Map<string, string>(),
    reviews = new Map<string, { review: DirectoryLegacyReview; owner: string; binding: string }>();
  const allowed = (r: RecordView) => {
    const grant = grantsById.get(r.proposal.id);
    return (
      r.owner === owner ||
      !!(
        grant &&
        grant.workspaceOwner === owner &&
        grant.originalOwner === r.owner &&
        grant.bindingSha256 === r.binding
      )
    );
  };
  const summary = (r: RecordView): DirectorySaveProposal =>
    freeze({
      ...structuredClone(r.proposal),
      ...(allowed(r) ? {} : { needsLocalAdoption: true as const }),
    });
  let snapshot: DirectoryWriterSnapshot = freeze({
    ...writer.getSnapshot(),
    phase: 'idle',
    hydrated: false,
  });
  const publish = () => {
    const base = writer.getSnapshot();
    const value: DirectoryWriterSnapshot = {
      ...base,
      phase: error ? 'error' : hydrated ? base.phase : hydration ? 'loading' : 'idle',
      hydrated: hydrated && base.hydrated,
      error: error ?? base.error,
      saves: base.saves.map((p) => {
        const r = byId.get(p.id);
        return r && allowed(r) ? p : { ...p, needsLocalAdoption: true as const };
      }),
    };
    if (JSON.stringify(value) === JSON.stringify(snapshot)) return;
    snapshot = freeze(value);
    listeners.forEach((fn) => fn());
  };
  writer.subscribe(publish);
  const accept = (
    stored: WorkspaceDirectoryStored,
    expectedOwner = authority.getSnapshot().owner,
  ) => {
    const identity = parseStoredWorkspaceAuthority(stored.authority),
      expected = `workspace:${identity.id}`;
    if (expectedOwner !== expected)
      throw new Error('Workspace authority differs from saved identity');
    owner = expected;
    grants = parseGrants(stored.adoptions);
    grantsById = new Map(grants.grants.map((g) => [g.recordId, g]));
    if (stored.writer === null) {
      records = [];
      stateRevision = 0;
    } else {
      const state = parseDirectoryWriterEnvelope(stored.writer);
      records = recordViews(state, writer);
      stateRevision = state.revision;
    }
    byId = new Map(records.map((r) => [r.proposal.id, r]));
  };
  const refresh = async (afterVerifiedRead?: () => void) => {
    try {
      await authority.hydrate();
      const expectedOwner = authority.getSnapshot().owner;
      // Validate actual storage first: disposal must not hide a corrupt or failed read.
      accept(await backend.read(), expectedOwner);
      afterVerifiedRead?.();
      await authority.hydrate();
      error = null;
      publish();
    } catch (failure) {
      if (failure instanceof WorkspaceAuthorityDisposedError) throw failure;
      error =
        'Local record ownership could not be verified. Prior data was retained; retry local save storage.';
      publish();
      throw new DirectorySaveError('persistence', error);
    }
  };
  const hydrate = () => {
    if (hydrated && !error) return authority.hydrate();
    hydration ??= (async () => {
      await refresh();
      await writer.hydrate();
      await refresh();
      hydrated = true;
      publish();
    })().finally(() => {
      hydration = undefined;
    });
    return hydration;
  };
  const canonical = async (p: ExecutionPrincipal) => {
    const captured = parseExecutionPrincipal({ owner: p?.owner, scope: p?.scope });
    await hydrate();
    if (captured.owner !== owner)
      throw new DirectorySaveError(
        'invalid-request',
        'A canonical workspace principal is required',
      );
    return captured;
  };
  const find = (id: string) => {
    const r = byId.get(id);
    if (!r) throw new DirectorySaveError('invalid-request', 'This local record is unavailable');
    return r;
  };
  const permit = async (id: string, p: ExecutionPrincipal) => {
    const captured = await canonical(p);
    await refresh();
    const r = find(id);
    if (!allowed(r))
      throw new DirectorySaveError(
        'needs-local-adoption',
        'A local human must review access to this legacy record first',
        summary(r),
      );
    return { principal: { owner: r.owner, scope: captured.scope }, record: r };
  };
  /** The core already verified this result. Disposal can stop its observer refresh,
   * but cannot turn completed work into a persistence failure or repeat it. */
  const afterVerifiedCore = async <T>(value: T): Promise<T> => {
    try {
      await refresh();
    } catch (failure) {
      if (!(failure instanceof WorkspaceAuthorityDisposedError)) throw failure;
    }
    return value;
  };
  const invoke = async <T>(
    id: string,
    p: ExecutionPrincipal,
    work: (principal: ExecutionPrincipal) => Promise<T>,
  ) => {
    const resolved = await permit(id, p);
    let value: T;
    try {
      value = await work(resolved.principal);
    } catch (failure) {
      try {
        await refresh();
      } catch {}
      throw failure;
    }
    return afterVerifiedCore(value);
  };
  const result: ProjectDirectoryWriter & DirectoryLegacyAccess = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    hydrate,
    async retryStorage() {
      await authority.retry();
      await writer.retryStorage();
      error = null;
      hydrated = false;
      await hydrate();
    },
    async registerDirectory(handle) {
      await hydrate();
      const id = await writer.registerDirectory(handle);
      return afterVerifiedCore(id);
    },
    async forgetRoot(id) {
      await hydrate();
      await writer.forgetRoot(id);
      await afterVerifiedCore(undefined);
    },
    async prepare(input: DirectorySaveInput) {
      const p = await canonical(input.principal);
      await refresh();
      const matches = records.filter((r) => r.requestId === input.requestId);
      if (matches.length > 1)
        throw new DirectorySaveError(
          'invalid-request',
          'This legacy request ID is ambiguous. Use its explicit record ID; no new save was prepared.',
        );
      if (matches.length) {
        const r = matches[0],
          prior = r.proposal;
        if (!allowed(r))
          throw new DirectorySaveError(
            'needs-local-adoption',
            'This request belongs to an unadopted legacy record; no new save was prepared',
            summary(r),
          );
        if (
          prior.slot !== input.slot ||
          prior.expectedRevision !== input.expectedRevision ||
          prior.mode !== input.mode ||
          (input.mode === 'save-as' &&
            (prior.rootId !== input.rootId ||
              directoryNameKey(prior.folderName) !== directoryNameKey(input.folderName)))
        )
          throw new DirectorySaveError(
            'invalid-request',
            'Request ID belongs to a different captured save',
          );
        const value = await writer.prepare({
          ...input,
          principal: { owner: r.owner, scope: p.scope },
        });
        return afterVerifiedCore(value);
      }
      const value = await writer.prepare({ ...input, principal: p });
      return afterVerifiedCore(value);
    },
    async status(id, p) {
      await canonical(p);
      await refresh();
      const r = find(id);
      return allowed(r) ? invoke(id, p, (actor) => writer.status(id, actor)) : summary(r);
    },
    commit: (id, p, confirmation) =>
      invoke(id, p, (actor) => writer.commit(id, actor, confirmation)),
    retry: (id, p) => invoke(id, p, (actor) => writer.retry(id, actor)),
    recover: (id, p) => invoke(id, p, (actor) => writer.recover(id, actor)),
    exportRecovery: (id, p) => invoke(id, p, (actor) => writer.exportRecovery(id, actor)),
    forgetRecovery: (id, p) => invoke(id, p, (actor) => writer.forgetRecovery(id, actor)),
    async reviewArchive(id, p) {
      const review = await invoke(id, p, (actor) => writer.reviewArchive(id, actor));
      while (archiveTargets.size >= 32) archiveTargets.delete(archiveTargets.keys().next().value!);
      archiveTargets.set(review.id, id);
      return review;
    },
    async archive(reviewId, p, confirmation) {
      const id = archiveTargets.get(reviewId);
      if (!id)
        throw new DirectorySaveError(
          'invalid-request',
          'Archive review belongs to another browser session',
        );
      return invoke(id, p, (actor) => writer.archive(reviewId, actor, confirmation));
    },
    async reviewLegacy(id, p) {
      const actor = await canonical(p);
      await refresh();
      const r = find(id);
      if (allowed(r))
        throw new DirectorySaveError(
          'invalid-request',
          'This record already belongs to the workspace',
        );
      const review: DirectoryLegacyReview = freeze({
        id: nextId(),
        recordId: id,
        slot: r.proposal.slot,
        phase: r.proposal.phase,
        envelopeRevision: stateRevision,
        manifestSha256: r.manifest,
        proposal: summary(r),
      });
      while (reviews.size >= 32) reviews.delete(reviews.keys().next().value!);
      reviews.set(review.id, { review, owner: actor.owner, binding: r.binding });
      return review;
    },
    async adoptLegacy(reviewId, p, confirmation) {
      const actor = await canonical(p);
      if (confirmation?.confirm !== true || !authority.isLocalHuman(actor))
        throw new DirectorySaveError(
          'invalid-request',
          'Legacy access must be confirmed in the local human review',
        );
      const pending = reviews.get(reviewId);
      if (!pending || pending.owner !== actor.owner)
        throw new DirectorySaveError('invalid-request', 'Legacy review is missing or stale');
      await refresh();
      const r = find(pending.review.recordId);
      const completed = grants.grants.find(
        (g) =>
          g.recordId === r.proposal.id &&
          g.reviewId === reviewId &&
          g.workspaceOwner === actor.owner &&
          g.originalOwner === r.owner &&
          g.bindingSha256 === r.binding,
      );
      if (completed) return summary(r);
      await lock(
        `fusion-studio-project-write:${r.proposal.rootId}:${directoryNameKey(r.proposal.folderName)}`,
        async () => {
          await backend
            .update((stored) => {
              const identity = parseStoredWorkspaceAuthority(stored.authority);
              if (`workspace:${identity.id}` !== actor.owner || !authority.isLocalHuman(actor))
                throw new DirectorySaveError(
                  'invalid-request',
                  'Local human authority changed before adoption',
                );
              if (stored.writer === null)
                throw new DirectorySaveError('conflict', 'The reviewed record no longer exists');
              const state = parseDirectoryWriterEnvelope(stored.writer),
                source = recordViews(state, writer).find(
                  (v) => v.proposal.id === pending.review.recordId,
                ),
                current = parseGrants(stored.adoptions);
              if (
                !source ||
                state.revision !== pending.review.envelopeRevision ||
                source.manifest !== pending.review.manifestSha256 ||
                source.binding !== pending.binding ||
                source.proposal.phase !== pending.review.phase ||
                (source.claim && source.claim.until > now())
              )
                throw new DirectorySaveError(
                  'conflict',
                  'The record changed or is still active. Review it again before granting access.',
                );
              const grant = current.grants.find((g) => g.recordId === source.proposal.id);
              if (grant)
                throw new DirectorySaveError(
                  'conflict',
                  'This record already has a legacy-access grant',
                );
              const next: DirectoryAdoptions = {
                version: 1,
                revision: current.revision + 1,
                grants: [
                  ...current.grants,
                  {
                    recordId: source.proposal.id,
                    originalOwner: source.owner,
                    workspaceOwner: actor.owner,
                    bindingSha256: source.binding,
                    adoptedAt: now(),
                    reviewId,
                  },
                ],
              };
              return parseGrants(next);
            })
            .catch((failure) => {
              if (failure instanceof DirectorySaveError) throw failure;
              error =
                'Legacy access was not durably confirmed. Retry local save storage, then inspect this record before another action.';
              publish();
              throw new DirectorySaveError('persistence', error);
            });
        },
      );
      let verified: DirectorySaveProposal | undefined;
      try {
        await refresh(() => {
          const adopted = find(r.proposal.id),
            grant = grantsById.get(r.proposal.id);
          if (!allowed(adopted) || grant?.reviewId !== reviewId)
            throw new DirectorySaveError(
              'persistence',
              'Legacy access readback was not confirmed; no filesystem operation was attempted',
            );
          verified = summary(adopted);
        });
      } catch (failure) {
        // A grant write alone is insufficient. Only a completed, exact readback
        // allows disposal of the observer to be ignored.
        if (!(failure instanceof WorkspaceAuthorityDisposedError) || !verified) throw failure;
      }
      return verified!;
    },
  };
  return result;
}
