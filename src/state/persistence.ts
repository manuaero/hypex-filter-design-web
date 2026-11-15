import { openDB, type IDBPDatabase } from 'idb';
import { z } from 'zod';
import { projectSchema, hfdCalibrationSchema } from '../domain/files';
import type { HfdProjectCalibration, Project, Slot } from '../domain/model';
import type { TransferJson } from '../application/file-transfers';

export const LEGACY_WORKSPACE_KEY = 'fusion-studio-workspace-v1';
const DATABASE = 'fusion-studio-workspace';
const STORE = 'state';
const KEY = 'workspace';
export interface PersistedWorkspace {
  documents: Record<Slot, Project>;
  slot: Slot;
  preset: number;
  channel: number;
  filter: number;
  linkedEdits: boolean;
  linkedControls: boolean;
  rememberedHfdCalibration?: HfdProjectCalibration;
  documentRevision?: number;
  fileCommitReceipts?: Record<string, FileCommitReceipt>;
}
export type FileCommitReceipt = {
  commitId: string;
  owner: string;
  scope: string;
  revision: number;
  utc: number;
  result: TransferJson;
};
export interface WorkspaceEnvelope {
  version: 1;
  state: PersistedWorkspace;
}
export interface WorkspacePersistenceStatus {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  hydrated: boolean;
  saving: boolean;
  unsaved: boolean;
  error: string | null;
  source: 'indexeddb' | 'legacy' | 'new' | null;
  savedAt: string | null;
}
/** Backend injection keeps ordering/migration tests independent of browser shims. */
export interface WorkspacePersistenceBackend {
  read: () => Promise<unknown | null>;
  write: (value: WorkspaceEnvelope, expected?: WorkspaceEnvelope | null) => Promise<void>;
  readLegacy: () => string | null;
}
const stateSchema = z
  .object({
    documents: z.object({ left: projectSchema, right: projectSchema }).strict(),
    slot: z.enum(['left', 'right']).default('left'),
    preset: z.number().int().min(0).max(2).default(0),
    channel: z.number().int().min(0).max(2).default(0),
    filter: z.number().int().min(0).max(14).default(0),
    linkedEdits: z.boolean().default(false),
    linkedControls: z.boolean().default(true),
    rememberedHfdCalibration: hfdCalibrationSchema.optional(),
    documentRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    fileCommitReceipts: z
      .record(
        z.string().max(1024),
        z
          .object({
            commitId: z.string().max(1024),
            owner: z.string().max(512),
            scope: z.string().max(512),
            revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            utc: z.number().finite().nonnegative(),
            result: z.json(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
const envelopeSchema = z.object({ version: z.literal(1), state: stateSchema }).strict();
const legacySchema = z.object({ version: z.literal(0).optional(), state: stateSchema }).strict();
function parseEnvelope(value: unknown): WorkspaceEnvelope {
  return envelopeSchema.parse(value) as WorkspaceEnvelope;
}
/** Compare-and-swap the complete durable snapshot, including import receipts.
 * A retry of the identical write is idempotent. A different tab's save is never
 * silently replaced by a stale controller. */
export function assertWorkspaceWrite(
  current: unknown,
  expected: WorkspaceEnvelope | null | undefined,
  next: WorkspaceEnvelope,
) {
  const validated = parseEnvelope(next);
  const actual = current == null ? null : parseEnvelope(current);
  if (JSON.stringify(actual) === JSON.stringify(validated)) return;
  if (JSON.stringify(actual) !== JSON.stringify(expected ?? null))
    throw new Error(
      'The saved workspace changed in another tab. Export unsaved recovery before reloading.',
    );
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const SERVER_WORKSPACE_PERSISTENCE_STATUS: WorkspacePersistenceStatus = Object.freeze({
  phase: 'idle',
  hydrated: false,
  saving: false,
  unsaved: false,
  error: null,
  source: null,
  savedAt: null,
});

export function createIndexedDbWorkspaceBackend(): WorkspacePersistenceBackend {
  let connection: Promise<IDBPDatabase> | undefined;
  const database = () => {
    if (typeof indexedDB === 'undefined')
      return Promise.reject(
        new Error('IndexedDB is unavailable; saved workspaces were not changed.'),
      );
    if (!connection) {
      // Older clients must reopen with the new guarded-write contract.
      connection = openDB(DATABASE, 2, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
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
    }
    return connection;
  };
  return {
    read: async () => (await (await database()).get(STORE, KEY)) ?? null,
    write: async (value, expected) => {
      const db = await database(),
        tx = db.transaction(STORE, 'readwrite');
      try {
        assertWorkspaceWrite(await tx.store.get(KEY), expected, value);
        await tx.store.put(value, KEY);
        await tx.done;
      } catch (error) {
        try {
          tx.abort();
        } catch {
          /* The transaction may already have aborted. */
        }
        await tx.done.catch(() => {});
        throw error;
      }
    },
    readLegacy: () => {
      if (typeof window === 'undefined') return null;
      // A denied localStorage read is an error, not proof that no old design exists.
      return window.localStorage.getItem(LEGACY_WORKSPACE_KEY);
    },
  };
}

export function createWorkspacePersistence(
  backend: WorkspacePersistenceBackend,
  applyHydratedState: (state: PersistedWorkspace | null) => void = () => {},
) {
  let status = SERVER_WORKSPACE_PERSISTENCE_STATUS;
  const listeners = new Set<() => void>();
  let hydration: Promise<void> | undefined;
  let draining: Promise<void> | undefined;
  let pending: WorkspaceEnvelope | undefined;
  let latest: WorkspaceEnvelope | undefined;
  let expectedDisk: WorkspaceEnvelope | null = null;
  let rawRecovery: string | null = null;
  let blockedWrite = false;
  let invalidPending = false;
  const notify = (patch: Partial<WorkspacePersistenceStatus>) => {
    status = { ...status, ...patch };
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* A view observer must not abort a durable save. */
      }
    }
  };
  const verify = async (expected: WorkspaceEnvelope) => {
    const raw = await backend.read();
    const actual = parseEnvelope(raw);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error('Workspace readback did not match the saved data.');
  };
  const rememberRaw = (value: unknown) => {
    try {
      rawRecovery = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    } catch {
      rawRecovery = null;
    }
  };
  const drain = (): Promise<void> => {
    if (draining) return draining;
    if (!pending || blockedWrite) return Promise.resolve();
    const work = async () => {
      while (pending && !blockedWrite) {
        const next = pending;
        pending = undefined;
        notify({ saving: true, unsaved: true });
        try {
          await backend.write(next, expectedDisk);
          // The write acknowledged its atomic commit. Even if verification
          // fails, a retry must compare against this write, not its predecessor.
          expectedDisk = next;
          await verify(next);
          notify({
            ...(!blockedWrite ? { phase: 'ready' as const, error: null } : {}),
            savedAt: new Date().toISOString(),
            unsaved: blockedWrite || !!pending,
            saving: !blockedWrite && !!pending,
          });
        } catch (error) {
          // Keep the newest in-memory version, never replace it with an earlier failed write.
          pending ??= next;
          blockedWrite = true;
          notify({
            phase: 'error',
            error: `Workspace was not saved: ${errorText(error)}`,
            saving: false,
            unsaved: true,
          });
          throw error;
        }
      }
      notify({ saving: false, unsaved: blockedWrite || !!pending });
    };
    draining = work().finally(() => {
      draining = undefined;
      if (pending && !blockedWrite)
        void drain().catch(() => {
          /* Failure is exposed in status. */
        });
    });
    return draining;
  };
  const hydrate = (): Promise<void> => {
    if (status.hydrated) return Promise.resolve();
    if (hydration) return hydration;
    notify({ phase: 'loading', error: null });
    hydration = (async () => {
      try {
        const raw = await backend.read();
        let envelope: WorkspaceEnvelope | undefined;
        let source: WorkspacePersistenceStatus['source'] = 'new';
        if (raw !== null && raw !== undefined) {
          rememberRaw(raw);
          envelope = parseEnvelope(raw);
          expectedDisk = envelope;
          source = 'indexeddb';
        } else {
          const legacy = backend.readLegacy();
          if (legacy !== null) {
            rememberRaw(legacy);
            const parsed = legacySchema.parse(JSON.parse(legacy));
            envelope = { version: 1, state: parsed.state as PersistedWorkspace };
            await backend.write(envelope, null);
            expectedDisk = envelope;
            await verify(envelope);
            source = 'legacy';
            // Retain the legacy copy as recovery. No later save writes to localStorage.
          }
        }
        latest = envelope;
        applyHydratedState(envelope?.state ?? null);
        notify({
          phase: 'ready',
          hydrated: true,
          source,
          error: null,
          unsaved: false,
          saving: false,
        });
      } catch (error) {
        notify({
          phase: 'error',
          hydrated: false,
          saving: false,
          error: `Could not load the saved workspace: ${errorText(error)}`,
        });
        throw error;
      }
    })().finally(() => {
      hydration = undefined;
    });
    return hydration;
  };
  const save = (state: PersistedWorkspace) => {
    if (!status.hydrated)
      throw new Error('Wait for the saved workspace to finish loading before editing.');
    try {
      // Validate and clone before the async boundary: edits cannot mutate an in-flight save.
      const envelope = parseEnvelope({ version: 1, state });
      latest = structuredClone(envelope);
      pending = latest;
      invalidPending = false;
      notify({ unsaved: true });
      if (!blockedWrite)
        void drain().catch(() => {
          /* Status and recovery keep this failure visible. */
        });
    } catch (error) {
      blockedWrite = true;
      invalidPending = true;
      notify({
        phase: 'error',
        saving: false,
        unsaved: true,
        error: `Workspace was not saved: ${errorText(error)}`,
      });
    }
  };
  return {
    getSnapshot: () => status,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hydrate,
    assertHydrated: () => {
      if (!status.hydrated)
        throw new Error('Wait for the saved workspace to finish loading before editing.');
    },
    save,
    flush: async () => {
      if (!status.hydrated) throw new Error('The saved workspace has not loaded.');
      if (blockedWrite) throw new Error(status.error ?? 'Workspace persistence is blocked.');
      while (draining || pending) await (draining ?? drain());
    },
    retry: async () => {
      if (!status.hydrated) return hydrate();
      if (invalidPending) throw new Error(status.error ?? 'The current workspace is invalid.');
      blockedWrite = false;
      notify({ phase: 'ready', error: null });
      await drain();
    },
    recoveryText: () => {
      if (status.hydrated && latest) return JSON.stringify(latest, null, 2);
      return rawRecovery;
    },
  };
}
