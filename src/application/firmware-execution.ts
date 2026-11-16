import type { Slot } from '../domain/model';
import {
  FirmwareUpdateError,
  firmwareUpdateRecordSummary,
  type FirmwareUpdateCoordinator,
  type FirmwareUpdateReview,
  type FirmwareUpdateSnapshot,
  type FirmwareUpdateTarget,
} from '../hardware/firmware-update';
import type { ToolExecutionContext } from './execution-context';
import type { FirmwareJournalBinding } from './firmware-update-storage';
import type {
  FirmwareInspectionToken,
  FirmwareWorkspace,
  FirmwareWorkspaceSnapshot,
} from './firmware-workspace';

export type FirmwareStageIds = Partial<Record<Slot, string>>;
export type FirmwareExecutionRecord = ReturnType<typeof firmwareUpdateRecordSummary>;
export type FirmwareAssignmentLease = Pick<
  FirmwareJournalBinding,
  'assignmentId' | 'connectionId' | 'connectionEpoch' | 'serial'
>;

/** Production metadata-only recovery preparation, called exclusively after the
 * coordinator admits the journal owner, execution route and physical profile.
 * This restores an expected-role lease, not a live device/interface assignment.
 * The loader correlator must still prove the actual unit before any sender. */
export function planFirmwareRecoveryAssignments(
  current: Partial<Record<Slot, FirmwareAssignmentLease>>,
  liveSerials: Partial<Record<Slot, string>>,
  roles: readonly Readonly<{ slot: Slot; binding: FirmwareJournalBinding }>[],
): Partial<Record<Slot, FirmwareAssignmentLease>> {
  if (
    !roles.length ||
    roles.length > 2 ||
    new Set(roles.map((role) => role.slot)).size !== roles.length
  )
    throw new Error('Recovery requires distinct original roles');
  const planned = { ...current };
  for (const { slot, binding } of roles) {
    if (
      !['left', 'right'].includes(slot) ||
      !binding ||
      ![binding.assignmentId, binding.connectionId, binding.serial].every(
        (value) => typeof value === 'string' && value.length > 0 && value.length <= 512,
      ) ||
      !Number.isSafeInteger(binding.connectionEpoch) ||
      binding.connectionEpoch < 0
    )
      throw new Error('Invalid historical firmware assignment');
    if (Object.hasOwn(liveSerials, slot))
      throw new Error(`${slot} has a live interface; recovery cannot replace it`);
    const expected: FirmwareAssignmentLease = {
      assignmentId: binding.assignmentId,
      connectionId: binding.connectionId,
      connectionEpoch: binding.connectionEpoch,
      serial: binding.serial,
    };
    const existing = current[slot];
    if (
      existing &&
      (['assignmentId', 'connectionId', 'connectionEpoch', 'serial'] as const).some(
        (key) => existing[key] !== expected[key],
      )
    )
      throw new Error(`${slot} already has a different firmware assignment`);
    planned[slot] = expected;
  }
  if (
    planned.left &&
    planned.right &&
    (planned.left.assignmentId === planned.right.assignmentId ||
      planned.left.serial === planned.right.serial)
  )
    throw new Error('Recovery conflicts with the other role assignment');
  for (const { slot, binding } of roles) {
    const other = slot === 'left' ? 'right' : 'left';
    if (liveSerials[other] === binding.serial)
      throw new Error('Recovery target is live in the other role');
  }
  return planned;
}
export interface FirmwareExecutionSnapshot {
  files: FirmwareWorkspaceSnapshot;
  update: Readonly<FirmwareUpdateSnapshot>;
  availability: Readonly<Record<Slot, { available: boolean; reasons: readonly string[] }>>;
}
export interface FirmwareExecutionOptions {
  workspace: FirmwareWorkspace;
  coordinator: FirmwareUpdateCoordinator;
  /** Stable role lease, retained across the expected runtime disconnect. */
  assignmentId?(slot: Slot): string | undefined;
}
export interface FirmwareExecutionWorkflow {
  getSnapshot(): Readonly<FirmwareExecutionSnapshot>;
  subscribe(listener: () => void): () => void;
  status(context: ToolExecutionContext): Readonly<FirmwareExecutionSnapshot>;
  inspect(
    slot: Slot,
    text: string,
    name: string,
    context: ToolExecutionContext,
    token?: FirmwareInspectionToken,
  ): ReturnType<FirmwareWorkspace['inspect']>;
  clear(target: FirmwareUpdateTarget, context: ToolExecutionContext): void;
  review(
    target: FirmwareUpdateTarget,
    stageIds: FirmwareStageIds,
    context: ToolExecutionContext,
  ): Promise<FirmwareUpdateReview>;
  reviewRecovery(
    id: string,
    target: FirmwareUpdateTarget,
    context: ToolExecutionContext,
  ): Promise<FirmwareUpdateReview>;
  apply(
    id: string,
    context: ToolExecutionContext,
    confirmation: { confirm: true },
  ): Promise<FirmwareExecutionRecord>;
  discard(id: string, context: ToolExecutionContext): void;
  hydrate(context: ToolExecutionContext): Promise<void>;
  history(
    context: ToolExecutionContext,
    offset?: number,
    limit?: number,
  ): { records: readonly FirmwareExecutionRecord[]; total: number; nextOffset: number | null };
  exportRecord(
    id: string,
    context: ToolExecutionContext,
  ): ReturnType<FirmwareUpdateCoordinator['exportRecord']>;
  exportPage(
    id: string,
    context: ToolExecutionContext,
    offset?: number,
    limit?: number,
  ): {
    id: string;
    content: string;
    total: number;
    nextOffset: number | null;
    exportPersistence: 'verified' | 'unavailable';
  };
  refreshContext(): void;
  dispose(): void;
}
export class FirmwareExecutionError extends Error {
  constructor(
    message: string,
    readonly result?: FirmwareExecutionRecord,
    readonly persistence: 'verified' | 'unavailable' = 'verified',
  ) {
    super(message);
    this.name = 'FirmwareExecutionError';
  }
}
const slots = (target: FirmwareUpdateTarget): Slot[] => {
  if (!['left', 'right', 'both'].includes(target)) throw new Error('Choose Left, Right or Both');
  return target === 'both' ? ['left', 'right'] : [target];
};
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

/** One owner-admitted UI/MCP workflow. No transport, chooser or reference adapter
 * is constructed here. A staged image never grants physical qualification. */
export function createFirmwareExecutionWorkflow(
  options: FirmwareExecutionOptions,
): FirmwareExecutionWorkflow {
  const { workspace, coordinator } = options;
  const listeners = new Set<() => void>();
  let disposed = false;
  const sourceId = (slot: Slot) => {
    const id = workspace.getSnapshot()[slot].stage?.id;
    return id && workspace.executionSource(slot, id)?.stageId;
  };
  let sourceIds = { left: sourceId('left'), right: sourceId('right') };
  let assignments = {
    left: options.assignmentId?.('left'),
    right: options.assignmentId?.('right'),
  };
  const build = (): Readonly<FirmwareExecutionSnapshot> => {
    const files = workspace.getSnapshot(),
      update = coordinator.getSnapshot();
    const availability = (slot: Slot) => {
      const stage = files[slot].stage;
      const source = stage && workspace.executionSource(slot, stage.id);
      const route = coordinator.availability(slot);
      const reasons = [...route.reasons];
      if (!source)
        reasons.push('Inspect an execution-sized firmware file for this role (maximum 4 MiB).');
      else if (!source.expectedAfter)
        reasons.push(
          'The exact file content has no known version profile; execution is unavailable.',
        );
      if (files[slot].phase === 'inspecting') reasons.push('File inspection is in progress.');
      return {
        available: route.available && !!source?.expectedAfter && files[slot].phase !== 'inspecting',
        reasons: [...new Set(reasons)],
      };
    };
    return freeze({
      files,
      update,
      availability: { left: availability('left'), right: availability('right') },
    });
  };
  let snapshot = build();
  const publish = () => {
    if (disposed) return;
    snapshot = build();
    listeners.forEach((listener) => {
      try {
        listener();
      } catch {
        /* View-only observer. */
      }
    });
  };
  const refreshContext = () => {
    if (disposed) return;
    const nextSources = { left: sourceId('left'), right: sourceId('right') };
    const nextAssignments = {
      left: options.assignmentId?.('left'),
      right: options.assignmentId?.('right'),
    };
    const changed = (['left', 'right'] as const).some(
      (slot) =>
        sourceIds[slot] !== nextSources[slot] || assignments[slot] !== nextAssignments[slot],
    );
    sourceIds = nextSources;
    assignments = nextAssignments;
    // A valid new inspection is an explicit context change even when no old
    // execution source exists (for example, during journal-based recovery).
    const inspecting = Object.values(workspace.getSnapshot()).some(
      (role) => role.phase === 'inspecting',
    );
    if (changed || inspecting) coordinator.invalidateReview();
    publish();
  };
  const unsubscribeFiles = workspace.subscribe(refreshContext);
  const unsubscribeUpdate = coordinator.subscribe(publish);
  const admit = (context: ToolExecutionContext, cancellable = true) => {
    if (disposed) throw new Error('Firmware workflow is disposed');
    coordinator.status(context);
    if (cancellable && context.signal?.aborted) throw new Error('Firmware action was cancelled');
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status(context) {
      admit(context, false);
      return snapshot;
    },
    inspect(slot, text, name, context, token) {
      admit(context);
      if (snapshot.update.busy) throw new Error('Firmware is busy');
      return workspace.inspect(slot, text, name, token);
    },
    clear(target, context) {
      admit(context);
      const selected = slots(target);
      coordinator.invalidateReview();
      selected.forEach((slot) => workspace.clear(slot));
    },
    async review(target, stageIds, context) {
      admit(context);
      const selected = slots(target);
      if (
        !stageIds ||
        Object.keys(stageIds).length !== selected.length ||
        selected.some(
          (slot) =>
            !stageIds[slot] ||
            workspace.getSnapshot()[slot].stage?.id !== stageIds[slot] ||
            !workspace.executionSource(slot, stageIds[slot]!),
        )
      )
        throw new Error('Every intended role requires its exact current executable stage ID');
      if (selected.some((slot) => !snapshot.availability[slot].available))
        throw new Error(selected.flatMap((slot) => snapshot.availability[slot].reasons).join(' '));
      return coordinator.review(target, context);
    },
    reviewRecovery(id, target, context) {
      admit(context);
      slots(target);
      return coordinator.reviewRecovery(id, target, context);
    },
    async apply(id, context, confirmation) {
      admit(context, false);
      try {
        return firmwareUpdateRecordSummary(await coordinator.apply(id, context, confirmation));
      } catch (error) {
        if (error instanceof FirmwareUpdateError)
          throw new FirmwareExecutionError(
            error.message,
            error.result && firmwareUpdateRecordSummary(error.result),
            error.persistence,
          );
        throw error;
      }
    },
    discard(id, context) {
      admit(context);
      coordinator.discard(id, context);
    },
    hydrate(context) {
      admit(context);
      return coordinator.hydrate(context);
    },
    history(context, offset = 0, limit = 16) {
      admit(context, false);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 16
      )
        throw new Error('Firmware history pages require offset ≥ 0 and limit 1..16');
      const records = snapshot.update.records;
      if (offset > records.length) throw new Error('Firmware history offset exceeds its records');
      const page = records.slice(offset, offset + limit);
      return freeze({
        records: page,
        total: records.length,
        nextOffset: offset + page.length < records.length ? offset + page.length : null,
      });
    },
    exportRecord(id, context) {
      admit(context, false);
      return coordinator.exportRecord(id, context);
    },
    exportPage(id, context, offset = 0, limit = 16384) {
      admit(context, false);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 16384
      )
        throw new Error('Firmware export pages require offset ≥ 0 and limit 1..16384');
      const record = coordinator.exportRecord(id, context),
        content = JSON.stringify(record);
      if (offset > content.length) throw new Error('Firmware export offset exceeds its content');
      const chunk = content.slice(offset, offset + limit);
      return freeze({
        id,
        content: chunk,
        total: content.length,
        nextOffset: offset + chunk.length < content.length ? offset + chunk.length : null,
        exportPersistence: record.exportPersistence,
      });
    },
    refreshContext,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeFiles();
      unsubscribeUpdate();
      listeners.clear();
      coordinator.dispose();
    },
  };
}
