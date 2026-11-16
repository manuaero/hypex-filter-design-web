'use client';
import { synchronizeLinks } from '../domain/links';
import { copyPreset as copyNativePreset } from '../domain/preset-copy';
import { create } from 'zustand';
import {
  exampleProject,
  type HfdProjectCalibration,
  type Project,
  type Slot,
} from '../domain/model';
import { hfdCalibrationSchema, projectSchema } from '../domain/files';
import { reconcileProjectHfdCalibration } from '../domain/hfd-measurement';
import {
  createIndexedDbWorkspaceBackend,
  createWorkspacePersistence,
  type PersistedWorkspace,
  type WorkspacePersistenceBackend,
  type FileCommitReceipt,
} from './persistence';
import { parseExecutionPrincipal, type ExecutionPrincipal } from '../application/execution-context';
import type { TransferJson } from '../application/file-transfers';
import { z } from 'zod';

type Documents = Record<Slot, Project>;
declare const gestureBrand: unique symbol;
/** Store-issued identity, never a serialized permission or a shared global. */
export type WorkspaceGestureToken = Readonly<{ [gestureBrand]: true }>;
declare const fieldGestureBrand: unique symbol;
/** Focus-issued edit authority; never inferred from document reference equality. */
export type WorkspaceFieldGestureToken = Readonly<{ [fieldGestureBrand]: true }>;
export interface WorkspaceIndependentOptions {
  independent?: boolean;
}
interface Workspace extends PersistedWorkspace {
  past: Documents[];
  future: Documents[];
  gesture?: Documents;
  beginGesture: () => void;
  endGesture: (cancel?: boolean) => void;
  beginOwnedGesture: () => WorkspaceGestureToken;
  endOwnedGesture: (token: WorkspaceGestureToken, cancel?: boolean) => void;
  isOwnedGestureCurrent: (token: WorkspaceGestureToken) => boolean;
  beginFieldGesture: () => WorkspaceFieldGestureToken;
  isFieldGestureCurrent: (token: WorkspaceFieldGestureToken) => boolean;
  endFieldGesture: (token: WorkspaceFieldGestureToken, cancel?: boolean) => void;
  runFieldGesture: <T>(token: WorkspaceFieldGestureToken, action: () => T) => T;
  choose: (
    patch: Partial<
      Pick<Workspace, 'slot' | 'preset' | 'channel' | 'filter' | 'linkedEdits' | 'linkedControls'>
    >,
    options?: WorkspaceIndependentOptions,
  ) => void;
  edit: (change: (project: Project) => void, linkable?: boolean) => void;
  editAt: (
    slots: Slot[],
    change: (project: Project, slot: Slot) => void,
    options?: {
      synchronizeLinks?: boolean;
      gestureToken?: WorkspaceGestureToken;
      independent?: boolean;
    },
  ) => void;
  replace: (project: Project) => void;
  replaceAt: (slot: Slot, project: Project, options?: WorkspaceIndependentOptions) => void;
  undo: (options?: WorkspaceIndependentOptions) => void;
  redo: (options?: WorkspaceIndependentOptions) => void;
  copyPreset: (to: number) => void;
  rememberHfdCalibration: (value: HfdProjectCalibration | null | undefined) => void;
  commitFileImport: (
    commitId: string,
    principal: ExecutionPrincipal,
    expectedRevision: number,
    slots: Slot[],
    apply: (project: Project, slot: Slot) => void,
    result: TransferJson,
    remember?: (documents: Documents) => HfdProjectCalibration | undefined,
    options?: { synchronizeLinks?: boolean },
  ) => Promise<FileCommitReceipt>;
  lookupFileCommit: (commitId: string, owner: string) => Promise<FileCommitReceipt | undefined>;
}
const persisted = (state: Workspace): PersistedWorkspace => ({
  documents: state.documents,
  slot: state.slot,
  preset: state.preset,
  channel: state.channel,
  filter: state.filter,
  linkedEdits: state.linkedEdits,
  linkedControls: state.linkedControls,
  ...(state.rememberedHfdCalibration === undefined
    ? {}
    : { rememberedHfdCalibration: state.rememberedHfdCalibration }),
  ...(state.documentRevision === undefined ? {} : { documentRevision: state.documentRevision }),
  ...(state.fileCommitReceipts === undefined
    ? {}
    : { fileCommitReceipts: state.fileCommitReceipts }),
});
const changed = (state: Workspace, previous: Workspace) =>
  state.documents !== previous.documents ||
  state.slot !== previous.slot ||
  state.preset !== previous.preset ||
  state.channel !== previous.channel ||
  state.filter !== previous.filter ||
  state.linkedEdits !== previous.linkedEdits ||
  state.linkedControls !== previous.linkedControls ||
  state.rememberedHfdCalibration !== previous.rememberedHfdCalibration ||
  state.documentRevision !== previous.documentRevision ||
  state.fileCommitReceipts !== previous.fileCommitReceipts;

const nextRevision = (state: Workspace) => {
  const revision = (state.documentRevision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) throw new Error('Workspace revision is exhausted');
  return revision;
};

export { inheritRememberedHfdCalibration } from '../domain/hfd-microphone';

/** Factory keeps tests and embedded clients isolated; the production store below
 * shares one persistence controller for its full lifetime. No storage I/O at import. */
export function createWorkspaceStore(
  backend: WorkspacePersistenceBackend = createIndexedDbWorkspaceBackend(),
) {
  let applyingHydration = false;
  let ownedGesture: { token: WorkspaceGestureToken; start: Documents } | undefined;
  let fieldGesture: { token: WorkspaceFieldGestureToken; start: Documents } | undefined;
  let fieldScope: WorkspaceFieldGestureToken | undefined;
  const persistence = createWorkspacePersistence(backend, (snapshot) => {
    if (!snapshot) return;
    applyingHydration = true;
    try {
      ownedGesture = undefined;
      fieldGesture = undefined;
      store.setState({ ...snapshot, past: [], future: [], gesture: undefined });
    } finally {
      applyingHydration = false;
    }
  });
  const guard = () => persistence.assertHydrated();
  // Pure until the caller's complete mutation has been validated. An invalid
  // foreign proposal must not retire a valid in-progress field or graph gesture.
  const commitOpen = (state: Workspace, field = false, anonymous = false): Workspace => {
    if (
      !state.gesture ||
      !(
        anonymous ||
        (ownedGesture && state.gesture === ownedGesture.start) ||
        (field && fieldGesture && state.gesture === fieldGesture.start)
      )
    )
      return state;
    return {
      ...state,
      gesture: undefined,
      ...(state.documents === state.gesture
        ? {}
        : { past: [...state.past.slice(-49), state.gesture], future: [] }),
    };
  };
  const commitOwned = (state: Workspace) => commitOpen(state);
  const commitBoundary = (state: Workspace, independent = false) =>
    commitOpen(state, true, independent);
  const store = create<Workspace>()((set, get) => ({
    documents: { left: exampleProject(), right: exampleProject() },
    slot: 'left',
    preset: 0,
    channel: 0,
    filter: 0,
    linkedEdits: false,
    linkedControls: true,
    documentRevision: 0,
    past: [],
    future: [],
    choose: (patch, options) => {
      guard();
      const state = commitBoundary(get(), options?.independent);
      ownedGesture = undefined;
      fieldGesture = undefined;
      set({ ...state, ...patch });
    },
    beginGesture: () => {
      guard();
      const state = commitBoundary(get());
      ownedGesture = undefined;
      fieldGesture = undefined;
      if (!state.gesture) set({ past: state.past, future: state.future, gesture: state.documents });
    },
    endGesture: (cancel = false) => {
      guard();
      // Legacy callbacks never own a token-issued graph or focused field.
      if (ownedGesture || fieldGesture) return;
      const s = get();
      if (!s.gesture) return;
      if (s.documents === s.gesture) {
        set({ gesture: undefined });
        return;
      }
      if (cancel)
        set({ documents: s.gesture, documentRevision: nextRevision(s), gesture: undefined });
      else set({ past: [...s.past.slice(-49), s.gesture], future: [], gesture: undefined });
    },
    beginOwnedGesture: () => {
      guard();
      const state = commitBoundary(get(), true);
      fieldGesture = undefined;
      const token = Object.freeze({}) as WorkspaceGestureToken;
      ownedGesture = { token, start: state.documents };
      set({ past: state.past, future: state.future, gesture: state.documents });
      return token;
    },
    isOwnedGestureCurrent: (token) =>
      ownedGesture?.token === token && get().gesture === ownedGesture.start,
    endOwnedGesture: (token, cancel = false) => {
      guard();
      if (ownedGesture?.token !== token || get().gesture !== ownedGesture.start) return;
      const state = get();
      const patch =
        state.documents === state.gesture
          ? { gesture: undefined }
          : cancel
            ? {
                documents: state.gesture,
                documentRevision: nextRevision(state),
                gesture: undefined,
              }
            : { past: [...state.past.slice(-49), state.gesture!], future: [], gesture: undefined };
      ownedGesture = undefined;
      set(patch);
    },
    beginFieldGesture: () => {
      guard();
      const state = commitBoundary(get(), true);
      ownedGesture = undefined;
      const token = Object.freeze({}) as WorkspaceFieldGestureToken;
      fieldGesture = { token, start: state.documents };
      set({ past: state.past, future: state.future, gesture: state.documents });
      return token;
    },
    isFieldGestureCurrent: (token) =>
      fieldGesture?.token === token && get().gesture === fieldGesture.start,
    endFieldGesture: (token, cancel = false) => {
      guard();
      if (fieldGesture?.token !== token || get().gesture !== fieldGesture.start) return;
      const state = get();
      const patch =
        state.documents === state.gesture
          ? { gesture: undefined }
          : cancel
            ? {
                documents: state.gesture,
                documentRevision: nextRevision(state),
                gesture: undefined,
              }
            : { past: [...state.past.slice(-49), state.gesture!], future: [], gesture: undefined };
      fieldGesture = undefined;
      set(patch);
    },
    runFieldGesture: (token, action) => {
      guard();
      if (!get().isFieldGestureCurrent(token) || (fieldScope !== undefined && fieldScope !== token))
        throw new Error('The focused field edit is stale');
      const previous = fieldScope;
      fieldScope = token;
      try {
        const result = action();
        if (
          result !== null &&
          (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function'
        ) {
          // The synchronous prefix already ran. Observe rejection, but never
          // await or carry local authority into a later continuation.
          void Promise.resolve(result).catch(() => undefined);
          throw new Error('Field edit actions must be synchronous');
        }
        return result;
      } finally {
        fieldScope = previous;
      }
    },
    editAt: (slots, change, options) => {
      guard();
      if (fieldScope !== undefined && !get().isFieldGestureCurrent(fieldScope))
        throw new Error('The focused field edit is stale');
      if (options?.independent && options.gestureToken !== undefined)
        throw new Error('An independent edit cannot use an owned gesture token');
      if (options?.gestureToken !== undefined && !get().isOwnedGestureCurrent(options.gestureToken))
        throw new Error('The owned graph gesture is stale');
      if (slots.some((slot) => slot !== 'left' && slot !== 'right'))
        throw new Error('Invalid edit destination');
      const s = get(),
        documents = structuredClone(s.documents);
      for (const slot of new Set(slots)) {
        change(documents[slot], slot);
        if (options?.synchronizeLinks !== false)
          synchronizeLinks(documents[slot], s.documents[slot]);
        reconcileProjectHfdCalibration(documents[slot], s.documents[slot]);
      }
      const localField = fieldScope !== undefined && fieldGesture?.token === fieldScope;
      const revision = nextRevision(s),
        base =
          options?.gestureToken === undefined
            ? options?.independent
              ? commitBoundary(s, true)
              : localField
                ? commitOwned(s)
                : commitBoundary(s)
            : s;
      if (options?.gestureToken === undefined) ownedGesture = undefined;
      if (options?.independent || !localField) fieldGesture = undefined;
      set({
        documents,
        documentRevision: revision,
        gesture: base.gesture,
        past: base.gesture ? base.past : [...base.past.slice(-49), s.documents],
        future: [],
      });
    },
    edit: (change, linkable = true) => {
      guard();
      const s = get();
      s.editAt(s.linkedEdits && linkable ? ['left', 'right'] : [s.slot], change);
    },
    replace: (project) => {
      get().replaceAt(get().slot, project);
    },
    replaceAt: (slot, project, options) => {
      guard();
      if (slot !== 'left' && slot !== 'right') throw new Error('Invalid project destination');
      const s = get(),
        documents = { ...s.documents, [slot]: structuredClone(project) },
        revision = nextRevision(s),
        base = commitBoundary(s, options?.independent);
      ownedGesture = undefined;
      fieldGesture = undefined;
      set({
        documents,
        documentRevision: revision,
        gesture: base.gesture,
        past: [...base.past.slice(-49), s.documents],
        future: [],
      });
    },
    undo: (options) => {
      guard();
      const before = get(),
        s = commitBoundary(before, options?.independent);
      if (!s.past.length) {
        if (s !== before) {
          ownedGesture = undefined;
          fieldGesture = undefined;
          set(s);
        }
        return;
      }
      const revision = nextRevision(s);
      ownedGesture = undefined;
      fieldGesture = undefined;
      set({
        documents: s.past[s.past.length - 1],
        documentRevision: revision,
        gesture: s.gesture,
        past: s.past.slice(0, -1),
        future: [s.documents, ...s.future],
      });
    },
    redo: (options) => {
      guard();
      const before = get(),
        s = commitBoundary(before, options?.independent);
      if (!s.future.length) {
        if (s !== before) {
          ownedGesture = undefined;
          fieldGesture = undefined;
          set(s);
        }
        return;
      }
      const revision = nextRevision(s);
      ownedGesture = undefined;
      fieldGesture = undefined;
      set({
        documents: s.future[0],
        documentRevision: revision,
        gesture: s.gesture,
        past: [...s.past, s.documents],
        future: s.future.slice(1),
      });
    },
    copyPreset: (to) => {
      guard();
      if (!Number.isInteger(to) || to < 0 || to > 2) throw new Error('Invalid destination preset');
      const state = get();
      state.editAt(
        state.linkedEdits ? ['left', 'right'] : [state.slot],
        (project) => copyNativePreset(project, state.preset, to),
        { synchronizeLinks: false, independent: fieldGesture !== undefined },
      );
    },
    rememberHfdCalibration: (value) => {
      guard();
      const rememberedHfdCalibration =
        value == null ? undefined : structuredClone(hfdCalibrationSchema.parse(value));
      const base = commitOwned(get());
      ownedGesture = undefined;
      set({ ...base, rememberedHfdCalibration });
    },
    lookupFileCommit: async (commitId, owner) => {
      guard();
      const receipts = get().fileCommitReceipts;
      const receipt =
        receipts && Object.hasOwn(receipts, commitId) ? receipts[commitId] : undefined;
      if (!receipt || receipt.owner !== owner) return;
      // A successful lookup is a durable receipt, including after a previous
      // save failure. Never turn an unsaved in-memory edit into an ACK.
      await persistence.flush();
      return structuredClone(receipt);
    },
    commitFileImport: async (
      commitId,
      principal,
      expectedRevision,
      slots,
      apply,
      result,
      remember,
      options,
    ) => {
      guard();
      parseExecutionPrincipal(principal);
      if (
        !commitId ||
        commitId.length > 1024 ||
        /[\x00-\x1f\x7f]/.test(commitId) ||
        Object.hasOwn(Object.prototype, commitId)
      )
        throw new Error('Invalid file commit identifier');
      const existing = get().fileCommitReceipts;
      if (existing && Object.hasOwn(existing, commitId)) {
        if (existing[commitId].owner !== principal.owner)
          throw new Error('File commit belongs to another owner');
        return (await get().lookupFileCommit(commitId, principal.owner))!;
      }
      const s = get();
      if (s.gesture && s.gesture !== ownedGesture?.start)
        throw new Error('Finish the current edit before importing a file');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== (s.documentRevision ?? 0))
        throw new Error(
          'The design changed after this transfer began. Start a new import for the current revision.',
        );
      if (!slots.length || slots.some((slot) => slot !== 'left' && slot !== 'right'))
        throw new Error('Invalid file import destinations');
      const receiptResult = z.json().parse(result) as TransferJson;
      if (new TextEncoder().encode(JSON.stringify(receiptResult)).byteLength > 65536)
        throw new Error('File import receipt exceeds 64 KiB');
      const documents = structuredClone(s.documents);
      for (const slot of new Set(slots)) {
        apply(documents[slot], slot);
        if (options?.synchronizeLinks !== false)
          synchronizeLinks(documents[slot], s.documents[slot]);
        reconcileProjectHfdCalibration(documents[slot], s.documents[slot]);
      }
      documents.left = projectSchema.parse(documents.left) as Project;
      documents.right = projectSchema.parse(documents.right) as Project;
      // The receipt is persisted in the SAME envelope as both documents. Undo
      // retains it, so a retried commit cannot reapply an import the user undid.
      const revision = nextRevision(s),
        utc = Date.now();
      const receipts = Object.fromEntries(
        Object.entries(s.fileCommitReceipts ?? {}).filter(([, r]) => utc - r.utc < 60 * 60 * 1000),
      );
      if (Object.keys(receipts).length >= 512)
        throw new Error(
          'Too many recent file import receipts; retry after their one-hour retention period',
        );
      const receipt: FileCommitReceipt = {
        commitId,
        owner: principal.owner,
        scope: principal.scope,
        revision,
        utc,
        result: structuredClone(receiptResult),
      };
      receipts[commitId] = receipt;
      const microphone = remember?.(documents);
      const rememberedMicrophone = microphone
        ? structuredClone(hfdCalibrationSchema.parse(microphone))
        : undefined;
      const base = commitOwned(s);
      ownedGesture = undefined;
      set({
        documents,
        documentRevision: revision,
        fileCommitReceipts: receipts,
        ...(rememberedMicrophone ? { rememberedHfdCalibration: rememberedMicrophone } : {}),
        gesture: base.gesture,
        past: [...base.past.slice(-49), s.documents],
        future: [],
      });
      await persistence.flush();
      return structuredClone(receipt);
    },
  }));
  store.subscribe((state, previous) => {
    if (!applyingHydration && persistence.getSnapshot().hydrated && changed(state, previous))
      persistence.save(persisted(state));
  });
  return { store, persistence };
}

const workspace = createWorkspaceStore();
export const useWorkspace = workspace.store;
export const ensureWorkspaceHydrated = workspace.persistence.hydrate;
export const retryWorkspacePersistence = workspace.persistence.retry;
export const flushWorkspacePersistence = workspace.persistence.flush;
export const getWorkspacePersistenceStatus = workspace.persistence.getSnapshot;
export const subscribeWorkspacePersistence = workspace.persistence.subscribe;
export const getWorkspaceRecoveryText = workspace.persistence.recoveryText;
export type { WorkspacePersistenceStatus, WorkspacePersistenceBackend } from './persistence';
