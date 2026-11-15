import {
  parseExecutionPrincipal,
  type ExecutionPrincipal,
  type ToolExecutionContext,
} from './execution-context';
import { loadOrCreateWorkspaceAuthority } from './workspace-authority-storage';

export type WorkspaceLocalContextKind = 'ui' | 'manual' | 'webmcp';
export type WorkspacePairedActorSource = 'site' | 'local';
/** Lifecycle termination is distinct from an unreadable or invalid persistent identity. */
export class WorkspaceAuthorityDisposedError extends Error {
  constructor() {
    super('Workspace authority is disposed');
    this.name = 'WorkspaceAuthorityDisposedError';
  }
}
export interface WorkspaceAuthorityIdentity {
  version: 1;
  id: string;
}
export interface WorkspaceAuthoritySnapshot {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error';
  readonly owner?: string;
  readonly error: string | null;
}
export interface WorkspaceAuthorityOptions {
  loadOrCreate?: () => Promise<WorkspaceAuthorityIdentity>;
  /** Local scope nonce only; persistent workspace identity comes from storage. */
  id?: () => string;
}
export interface WorkspaceAuthority {
  getSnapshot(): WorkspaceAuthoritySnapshot;
  subscribe(listener: () => void): () => void;
  hydrate(): Promise<void>;
  retry(): Promise<void>;
  localContext(kind: WorkspaceLocalContextKind): ToolExecutionContext;
  isLocalHuman(principal: ExecutionPrincipal): boolean;
  /** Trusted pairing callback only, after transport authentication. Never a tool argument. */
  registerPairedActor(
    principal: ExecutionPrincipal,
    source: WorkspacePairedActorSource,
  ): () => void;
  /** Transport envelopes keep their raw identity; application execution admits it once. */
  admit(context: ToolExecutionContext): Promise<ToolExecutionContext>;
  dispose(): void;
}

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const keyFor = (principal: ExecutionPrincipal) =>
  JSON.stringify([principal.owner, principal.scope]);
const failure = (error: unknown) =>
  (error instanceof Error ? error.message : 'Local workspace identity could not be loaded').slice(
    0,
    2048,
  );
function identity(value: unknown): WorkspaceAuthorityIdentity {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'version') ||
    !Object.hasOwn(value, 'id') ||
    (value as WorkspaceAuthorityIdentity).version !== 1 ||
    typeof (value as WorkspaceAuthorityIdentity).id !== 'string' ||
    !uuid.test((value as WorkspaceAuthorityIdentity).id)
  )
    throw new Error('Stored workspace identity is invalid; it was retained without replacement');
  return { version: 1, id: (value as WorkspaceAuthorityIdentity).id };
}
function executionContext(value: ToolExecutionContext): ToolExecutionContext {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.hasOwn(value, 'owner') ||
    !Object.hasOwn(value, 'scope') ||
    Object.keys(value).some((key) => !['owner', 'scope', 'signal'].includes(key))
  )
    throw new Error('Invalid trusted execution context');
  const principal = parseExecutionPrincipal({ owner: value.owner, scope: value.scope }),
    signal = value.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new Error('Invalid execution abort signal');
  return { ...principal, ...(signal === undefined ? {} : { signal }) };
}

/** One origin's persistent workspace owner, with page-local authenticated leases.
 * No construction-time storage access, implicit enrollment, prefix authorization
 * or fallback identity. Pairing revocation never changes transport authentication. */
export function createWorkspaceAuthority(
  options: WorkspaceAuthorityOptions = {},
): WorkspaceAuthority {
  const load = options.loadOrCreate ?? loadOrCreateWorkspaceAuthority,
    nonce = options.id ?? (() => crypto.randomUUID()),
    listeners = new Set<() => void>(),
    locals = new Map<string, WorkspaceLocalContextKind>();
  type PairedLease = {
    principal: Readonly<ExecutionPrincipal>;
    source: WorkspacePairedActorSource;
    epoch: number;
  };
  const paired = new Map<WorkspacePairedActorSource, PairedLease>();
  let snapshot: WorkspaceAuthoritySnapshot = Object.freeze({ phase: 'idle', error: null }),
    loading: Promise<void> | undefined,
    disposed = false,
    epoch = 0;
  const publish = (next: WorkspaceAuthoritySnapshot) => {
    snapshot = Object.freeze(next);
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Observer errors cannot replace or invalidate a verified storage identity.
      }
    }
  };
  const readyOwner = () => {
    if (disposed) throw new WorkspaceAuthorityDisposedError();
    if (snapshot.phase !== 'ready' || !snapshot.owner)
      throw new Error('Workspace authority is not ready; wait for local identity storage');
    return snapshot.owner;
  };
  const hydrate = (): Promise<void> => {
    if (disposed) return Promise.reject(new WorkspaceAuthorityDisposedError());
    if (snapshot.phase === 'ready') return Promise.resolve();
    if (loading) return loading;
    const generation = epoch;
    const work = Promise.resolve()
      .then(async () => {
        const saved = identity(await load());
        if (disposed || generation !== epoch) throw new WorkspaceAuthorityDisposedError();
        publish({ phase: 'ready', owner: `workspace:${saved.id}`, error: null });
      })
      .catch((error: unknown) => {
        if (!disposed) publish({ phase: 'error', error: failure(error) });
        throw error;
      })
      .finally(() => {
        if (loading === work) loading = undefined;
      });
    loading = work;
    publish({ phase: 'loading', error: null });
    return work;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hydrate,
    retry: hydrate,
    localContext(kind) {
      const owner = readyOwner();
      if (!['ui', 'manual', 'webmcp'].includes(kind))
        throw new Error('Invalid local execution context kind');
      const id = nonce();
      if (typeof id !== 'string' || !/^[a-zA-Z0-9._:-]{1,200}$/.test(id))
        throw new Error('Invalid local execution scope nonce');
      const principal = Object.freeze({ owner, scope: `${kind}:${id}` }),
        key = keyFor(principal);
      if (locals.has(key)) throw new Error('Local execution scope was already minted');
      locals.set(key, kind);
      return principal;
    },
    isLocalHuman(principal) {
      if (disposed || snapshot.phase !== 'ready') return false;
      try {
        const checked = parseExecutionPrincipal({ owner: principal.owner, scope: principal.scope });
        return checked.owner === snapshot.owner && locals.get(keyFor(checked)) === 'ui';
      } catch {
        return false;
      }
    },
    registerPairedActor(raw, source) {
      readyOwner();
      const principal = Object.freeze(parseExecutionPrincipal(raw));
      if (
        (source !== 'site' && source !== 'local') ||
        !principal.owner.startsWith(`${source}:`) ||
        principal.owner.length <= source.length + 1
      )
        throw new Error('Authenticated actor does not match its pairing source');
      // One current lease per transport. Replacing it invalidates old pending admits.
      const lease: PairedLease = { principal, source, epoch: ++epoch };
      paired.set(source, lease);
      let revoked = false;
      return () => {
        if (revoked) return;
        revoked = true;
        if (paired.get(source) === lease) paired.delete(source);
      };
    },
    async admit(raw) {
      const owner = readyOwner(),
        context = executionContext(raw),
        key = keyFor(context);
      context.signal?.throwIfAborted();
      if (context.owner === owner && locals.has(key)) {
        await Promise.resolve();
        if (readyOwner() !== owner || !locals.has(key))
          throw new Error('Local execution lease changed or was revoked');
        context.signal?.throwIfAborted();
        return context;
      }
      const lease = [...paired.values()].find((item) => keyFor(item.principal) === key);
      if (!lease) throw new Error('Execution context is not registered with this workspace');
      const bytes = new TextEncoder().encode(
        JSON.stringify([
          'fusion-workspace-authority-v1',
          lease.source,
          lease.principal.owner,
          lease.principal.scope,
        ]),
      );
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      if (readyOwner() !== owner || paired.get(lease.source) !== lease)
        throw new Error('Paired execution lease changed or was revoked');
      context.signal?.throwIfAborted();
      const scope = `paired:${lease.source}:${Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('')}`;
      return { owner, scope, ...(context.signal === undefined ? {} : { signal: context.signal }) };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      epoch++;
      locals.clear();
      paired.clear();
      publish({ phase: 'error', error: 'Workspace authority is disposed' });
      listeners.clear();
    },
  };
}
