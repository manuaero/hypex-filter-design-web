import type { Slot } from '../domain/model';
import type { PanelSession } from '../hardware/session';
import type { NativeMatrix, NativeMixerIdentity } from '../hardware/native-mixer';
import type { ToolExecutionContext } from './execution-context';
import type { NativeMixerJournalRecord, NativeMixerStorage } from './native-mixer-storage';
import { NativeMixerStepError } from '../hardware/session';
import { hex } from '../hardware/codec';
import { decodeProtection } from '../hardware/protection';
import { decodeHardwareOverview } from '../hardware/device-settings';
import {
  decodeNativeMixer,
  nativeMixerAvailability,
  nativeMixerEditorRow,
  nativeMixerEditorWeight,
  planNativeMixer,
  assertNativeMixerBaseline,
  type NativeMixerCapture,
  type NativeMixerPlan,
} from '../hardware/native-mixer';
import { parseExecutionPrincipal } from './execution-context';
import {
  createNativeMixerStorage,
  parseNativeMixerEnvelope,
  nativeMixerBeforeSha256,
  nativeMixerDesiredSha256,
  MAX_NATIVE_MIXER_RECORDS,
  type NativeMixerJournalEnvelope,
  type NativeMixerJournalRole,
} from './native-mixer-storage';

export type NativeMixerTarget = Slot | 'both';
export type NativeMixerPreset = 1 | 2 | 3;
export interface NativeMixerBinding {
  session: PanelSession;
  identity: NativeMixerIdentity;
}
export interface NativeMixerRoleState {
  connected: boolean;
  identity?: NativeMixerIdentity;
  availability?: ReturnType<typeof nativeMixerAvailability>;
  canEdit: boolean;
  reason?: string;
  current?: NativeMatrix;
  draft?: NativeMatrix;
  /** Actual quantized values for the currently opened preset preview. */
  preview?: NativeMatrix;
  openedPresets: readonly [boolean, boolean, boolean];
  changedPresets: readonly [boolean, boolean, boolean];
  error?: string;
}
export interface NativeMixerReview {
  id: string;
  target: NativeMixerTarget;
  preset: NativeMixerPreset;
  revision: number;
  createdAt: number;
  roles: {
    slot: Slot;
    identity: NativeMixerIdentity;
    changed: boolean;
    before: NativeMatrix;
    after: NativeMatrix;
  }[];
}
export interface NativeMixerRecordSummary {
  id: string;
  target: NativeMixerTarget;
  preset: NativeMixerPreset;
  createdAt: number;
  updatedAt: number;
  phase: NativeMixerJournalRecord['phase'];
  roles: {
    slot: Slot;
    identity: NativeMixerIdentity;
    state: NativeMixerJournalRecord['roles'][number]['state'];
    attempted: boolean;
    error?: string;
  }[];
  error?: string;
}
export interface NativeMixerResult extends NativeMixerRecordSummary {
  complete: boolean;
  partial: boolean;
  replayed: boolean;
  persistence: 'verified' | 'unavailable';
}
export interface NativeMixerSnapshot {
  phase: 'idle' | 'ready' | 'busy' | 'error';
  busy: boolean;
  revision: number;
  roles: Record<Slot, NativeMixerRoleState>;
  records: readonly NativeMixerRecordSummary[];
  activeReview?: NativeMixerReview;
  lastResult?: NativeMixerResult;
  error?: string;
}
export interface NativeMixerControllerOptions {
  binding(slot: Slot): NativeMixerBinding | undefined;
  operate<T>(label: string, work: () => Promise<T>): Promise<T>;
  storage?: NativeMixerStorage;
  withLock?<T>(name: string, work: () => Promise<T>): Promise<T>;
  now?: () => number;
  id?: () => string;
}
export interface NativeMixerController {
  getSnapshot(): Readonly<NativeMixerSnapshot>;
  subscribe(listener: () => void): () => void;
  status(context: ToolExecutionContext): Readonly<NativeMixerSnapshot>;
  hydrate(context: ToolExecutionContext): Promise<void>;
  refreshHistory(context: ToolExecutionContext): Promise<void>;
  load(
    target: NativeMixerTarget,
    context: ToolExecutionContext,
    input: { preset: NativeMixerPreset },
  ): Promise<Readonly<NativeMixerSnapshot>>;
  open(
    target: NativeMixerTarget,
    context: ToolExecutionContext,
    input: { expectedRevision: number; preset: NativeMixerPreset },
  ): Readonly<NativeMixerSnapshot>;
  edit(
    target: NativeMixerTarget,
    context: ToolExecutionContext,
    input: {
      expectedRevision: number;
      preset: NativeMixerPreset;
      channel: 1 | 2 | 3;
      input: 'left' | 'right';
      value: number;
    },
  ): Readonly<NativeMixerSnapshot>;
  cancel(
    target: NativeMixerTarget,
    context: ToolExecutionContext,
    input: { preset: NativeMixerPreset },
  ): void;
  review(
    target: NativeMixerTarget,
    context: ToolExecutionContext,
    input: { expectedRevision: number; preset: NativeMixerPreset },
  ): Promise<NativeMixerReview>;
  save(
    reviewId: string,
    context: ToolExecutionContext,
    input: { confirm: true },
  ): Promise<NativeMixerResult>;
  discard(reviewId: string, context: ToolExecutionContext): void;
  exportRecord(
    id: string,
    context: ToolExecutionContext,
  ): NativeMixerJournalRecord & { exportPersistence: 'verified' | 'unavailable' };
  refreshBindings(): void;
  dispose(): void;
}
export class NativeMixerError extends Error {
  constructor(
    message: string,
    readonly result?: NativeMixerResult,
  ) {
    super(message);
    this.name = 'NativeMixerError';
  }
}
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const message = (failure: unknown) =>
  (failure instanceof Error ? failure.message : 'Native mixer operation was not confirmed').slice(
    0,
    1024,
  );
const identityOf = (value: NativeMixerIdentity): NativeMixerIdentity => ({
  serial: value.serial,
  product: value.product,
  core: value.core,
  firmware: value.firmware,
});
const sameIdentity = (a: NativeMixerIdentity, b: NativeMixerIdentity) =>
  (['serial', 'product', 'core', 'firmware'] as const).every((key) => a[key] === b[key]);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const slots = (target: NativeMixerTarget): Slot[] => {
  if (!['left', 'right', 'both'].includes(target))
    throw new NativeMixerError('Choose Left, Right or Both');
  return target === 'both' ? ['left', 'right'] : [target];
};
const presetIndex = (preset: NativeMixerPreset) => {
  if (![1, 2, 3].includes(preset)) throw new NativeMixerError('Choose preset 1, 2 or 3');
  return preset - 1;
};
const tuple = (values: boolean[]) => values as [boolean, boolean, boolean];
const copyMatrix = (value: NativeMatrix) => value.map((row) => [...row]) as unknown as number[][];
const asMatrix = (value: number[][]) => value as unknown as NativeMatrix;
const idleRole = (): NativeMixerRoleState => ({
  connected: false,
  canEdit: false,
  openedPresets: [false, false, false],
  changedPresets: [false, false, false],
});
const summary = (record: NativeMixerJournalRecord): NativeMixerRecordSummary => ({
  id: record.id,
  target: record.target,
  preset: record.preset,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  phase: record.phase,
  roles: record.roles.map(({ slot, identity, state, attempted, error }) => ({
    slot,
    identity: { ...identity },
    state,
    attempted,
    ...(error ? { error } : {}),
  })),
  ...(record.error ? { error: record.error } : {}),
});
const resultOf = (
  record: NativeMixerJournalRecord,
  persistence: 'verified' | 'unavailable',
  replayed = false,
): NativeMixerResult => ({
  ...summary(record),
  complete: record.phase === 'complete',
  partial: record.phase === 'partial',
  replayed,
  persistence,
});
async function browserLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks)
    throw new NativeMixerError('Native mixer Save requires browser Web Locks');
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
    if (!lock) throw new NativeMixerError('Another tab is saving a native mixer');
    return work();
  });
}
async function reserve<T>(sessions: PanelSession[], work: () => Promise<T>): Promise<T> {
  const ordered = [...sessions].sort((a, b) => a.lockOrder - b.lockOrder),
    enter = (index: number): Promise<T> =>
      index === ordered.length ? work() : ordered[index].exclusive(() => enter(index + 1));
  return enter(0);
}

/** Conditional native OEM editor. No construction/status/open/edit setters,
 * manufacturing enable action, mute, retry, rollback or project mutation. */
export function createNativeMixerController(
  options: NativeMixerControllerOptions,
): NativeMixerController {
  const storage = options.storage ?? createNativeMixerStorage(),
    now = options.now ?? Date.now,
    nextId = options.id ?? (() => crypto.randomUUID()),
    withLock = options.withLock ?? browserLock,
    listeners = new Set<() => void>(),
    known: Partial<Record<Slot, NativeMixerBinding>> = {},
    baselines: Partial<Record<Slot, NativeMixerCapture>> = {},
    overlays = new Map<
      string,
      { record: NativeMixerJournalRecord; persistence: 'verified' | 'unavailable' }
    >();
  type Capture = {
    slot: Slot;
    binding: NativeMixerBinding;
    hardware: NativeMixerCapture;
    plan: NativeMixerPlan;
    changed: boolean;
  };
  let disposed = false,
    flight = false,
    owner: string | undefined,
    loaded = false,
    epoch = 0,
    history: NativeMixerJournalEnvelope = { version: 1, revision: 0, records: [] },
    pending:
      { owner: string; scope: string; review: NativeMixerReview; captures: Capture[] } | undefined,
    snapshot: Readonly<NativeMixerSnapshot> = freeze({
      phase: 'idle',
      busy: false,
      revision: 0,
      roles: { left: idleRole(), right: idleRole() },
      records: [],
    });
  let updateTail: Promise<unknown> = Promise.resolve(),
    historyFlight: Promise<void> | undefined;
  const records = () => {
    const all = new Map(
      history.records
        .filter((record) => record.owner === owner)
        .map((record) => [record.id, record]),
    );
    for (const [id, value] of overlays) if (value.record.owner === owner) all.set(id, value.record);
    return [...all.values()];
  };
  const publish = (patch: Partial<NativeMixerSnapshot> = {}) => {
    snapshot = freeze({
      ...snapshot,
      ...patch,
      busy: flight,
      activeReview: pending?.review,
      records: records().map(summary),
    });
    for (const listener of listeners)
      try {
        listener();
      } catch {
        /* Views cannot interrupt verification. */
      }
  };
  const actor = (context: ToolExecutionContext) => {
    if (disposed) throw new NativeMixerError('Native mixer controller is disposed');
    const value = parseExecutionPrincipal({ owner: context?.owner, scope: context?.scope });
    if (!/^workspace:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value.owner))
      throw new NativeMixerError('Native mixer requires trusted workspace admission');
    if (owner && owner !== value.owner)
      throw new NativeMixerError('Native mixer belongs to another workspace');
    owner ??= value.owner;
    return value;
  };
  const bound = (capture: { slot: Slot; binding: NativeMixerBinding }) => {
    const current = options.binding(capture.slot);
    return (
      !!current &&
      current.session === capture.binding.session &&
      sameIdentity(current.identity, capture.binding.identity)
    );
  };
  const fence = (
    capture: { slot: Slot; binding: NativeMixerBinding },
    context?: ToolExecutionContext,
  ) => {
    if (disposed || !bound(capture))
      throw new NativeMixerError(
        'Captured mixer connection changed; its replacement was not targeted',
      );
    context?.signal?.throwIfAborted();
  };
  const mutable = () => {
    if (flight) throw new NativeMixerError('A native mixer operation is running');
  };
  const version = (expected: number) => {
    if (!Number.isSafeInteger(expected) || expected !== snapshot.revision)
      throw new NativeMixerError('Mixer draft changed; read its current revision');
  };
  const refreshBindings = () => {
    if (disposed) return;
    const roles = { ...snapshot.roles };
    let changed = false,
      invalidated = false;
    for (const slot of ['left', 'right'] as const) {
      const binding = options.binding(slot),
        old = known[slot],
        replaced = !binding
          ? !!old
          : !old ||
            binding.session !== old.session ||
            !sameIdentity(binding.identity, old.identity);
      let role = replaced ? idleRole() : roles[slot];
      if (replaced) {
        delete baselines[slot];
        invalidated = true;
      }
      if (binding) {
        known[slot] = { session: binding.session, identity: identityOf(binding.identity) };
        const capability = binding.session.nativeMixerCapability,
          availability = capability ? nativeMixerAvailability(capability) : undefined,
          permitted =
            availability?.editorAvailable && binding.session.lastStatus
              ? decodeProtection(binding.session.lastStatus, capability?.moduleType).operations
                  .digitalLeftRight
              : undefined;
        role = {
          ...role,
          connected: true,
          identity: identityOf(binding.identity),
          availability,
          canEdit: !!availability?.editorAvailable && !!permitted?.allowed,
          reason:
            availability?.reason ??
            permitted?.reason ??
            (!availability ? 'Device mixer capability has not been read' : undefined),
        };
      } else delete known[slot];
      if (!same(role, roles[slot])) {
        roles[slot] = role;
        changed = true;
      }
    }
    if (changed) {
      pending = undefined;
      epoch++;
      publish({
        roles,
        revision: snapshot.revision + 1,
        ...(invalidated ? { lastResult: undefined } : {}),
      });
    }
  };
  const historyRead = async () => {
    history = parseNativeMixerEnvelope(await storage.read());
    loaded = true;
    publish();
  };
  const hydrate = async (context: ToolExecutionContext) => {
    actor(context);
    if (loaded) return;
    historyFlight ??= historyRead()
      .catch((failure) => {
        publish({ phase: 'error', error: message(failure) });
        throw new NativeMixerError(message(failure));
      })
      .finally(() => {
        historyFlight = undefined;
      });
    await historyFlight;
  };
  const persist = (record: NativeMixerJournalRecord): Promise<void> => {
    const detached = structuredClone(record);
    const work = updateTail.then(async () => {
      const current = parseNativeMixerEnvelope(await storage.read()),
        next = structuredClone(current),
        index = next.records.findIndex((item) => item.id === detached.id);
      if (index < 0) next.records.push(detached);
      else next.records[index] = detached;
      next.revision = current.revision + 1;
      await storage.compareAndSwap(current.revision, next);
      // Injected backends must also prove readback, not merely resolve a write.
      const confirmed = parseNativeMixerEnvelope(await storage.read());
      if (!same(confirmed, next)) throw new Error('Native mixer journal readback differs');
      history = confirmed;
      loaded = true;
      publish();
    });
    updateTail = work.catch(() => {});
    return work;
  };
  const selected = (target: NativeMixerTarget, context: ToolExecutionContext) => {
    actor(context);
    context.signal?.throwIfAborted();
    refreshBindings();
    const captures = slots(target).map((slot) => {
      const binding = known[slot];
      if (!binding) throw new NativeMixerError(`${slot} amplifier is disconnected`);
      return { slot, binding };
    });
    if (
      new Set(captures.map((c) => c.binding.session)).size !== captures.length ||
      new Set(captures.map((c) => c.binding.identity.serial)).size !== captures.length
    )
      throw new NativeMixerError('Native mixer requires distinct physical amplifiers');
    return captures;
  };
  const rebuild = (
    slot: Slot,
    draft: NativeMatrix,
    opened: readonly boolean[],
    activePreset: NativeMixerPreset,
    base = snapshot.roles[slot],
  ): NativeMixerRoleState => {
    const hardware = baselines[slot];
    if (!hardware) throw new NativeMixerError('Read the amplifier mixer first');
    const current = decodeNativeMixer(hardware.mixerConfiguration),
      row = activePreset - 1,
      preview = planNativeMixer(hardware, [{ preset: activePreset, weights: draft[row] }]).after,
      changed = ([1, 2, 3] as const).map(
        (p) =>
          opened[p - 1] &&
          !same(
            planNativeMixer(hardware, [{ preset: p, weights: draft[p - 1] }]).after[p - 1],
            current[p - 1],
          ),
      );
    return {
      ...base,
      current,
      draft,
      preview,
      openedPresets: tuple([...opened]),
      changedPresets: tuple(changed),
      error: undefined,
    };
  };
  const checkedRow = (slot: Slot, preset: NativeMixerPreset) => {
    const role = snapshot.roles[slot];
    if (!role.canEdit || !role.draft || !baselines[slot])
      throw new NativeMixerError(role.reason ?? 'Read an eligible mixer first');
    return presetIndex(preset);
  };
  const setRows = (
    target: NativeMixerTarget,
    context: ToolExecutionContext,
    preset: NativeMixerPreset,
    expected: number,
    change: (row: number[], alreadyOpen: boolean) => number[],
  ) => {
    selected(target, context);
    mutable();
    version(expected);
    const roles = { ...snapshot.roles };
    for (const slot of slots(target)) {
      const index = checkedRow(slot, preset),
        old = roles[slot],
        draft = copyMatrix(old.draft!),
        opened = [...old.openedPresets];
      draft[index] = change([...draft[index]], opened[index]);
      opened[index] = true;
      roles[slot] = rebuild(slot, asMatrix(draft), opened, preset);
    }
    pending = undefined;
    publish({ roles, revision: snapshot.revision + 1, error: undefined });
    return snapshot;
  };
  const runtime = (record: NativeMixerJournalRecord, persistence: 'verified' | 'unavailable') => {
    overlays.set(record.id, { record: structuredClone(record), persistence });
  };
  const finish = (
    record: NativeMixerJournalRecord,
    persistence: 'verified' | 'unavailable',
    captures: Capture[],
  ) => {
    runtime(record, persistence);
    const result = freeze(resultOf(record, persistence));
    refreshBindings();
    const roles = { ...snapshot.roles };
    if (record.phase === 'complete' && !disposed)
      for (const capture of captures) {
        if (!bound(capture)) continue;
        const outcome = record.roles.find((role) => role.slot === capture.slot)!,
          actual = outcome.actualHex
            ? Uint8Array.from(outcome.actualHex.match(/../g)!, (n) => parseInt(n, 16))
            : capture.hardware.mixerConfiguration;
        baselines[capture.slot] = { ...capture.hardware, mixerConfiguration: actual };
        const old = roles[capture.slot],
          draft = copyMatrix(old.draft ?? decodeNativeMixer(actual)),
          opened = [...old.openedPresets];
        draft[record.preset - 1] = [...decodeNativeMixer(actual)[record.preset - 1]];
        opened[record.preset - 1] = false;
        roles[capture.slot] = rebuild(capture.slot, asMatrix(draft), opened, record.preset, old);
      }
    publish({
      roles,
      revision: snapshot.revision + 1,
      phase: record.phase === 'complete' ? 'ready' : 'error',
      lastResult: captures.every(bound) && !disposed ? result : undefined,
      error: record.error,
    });
    return result;
  };
  const controller: NativeMixerController = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status(context) {
      actor(context);
      refreshBindings();
      return snapshot;
    },
    hydrate,
    async refreshHistory(context) {
      actor(context);
      mutable();
      await historyRead();
    },
    async load(target, context, input) {
      const captures = selected(target, context),
        index = presetIndex(input.preset);
      mutable();
      const generation = epoch;
      flight = true;
      pending = undefined;
      publish({ phase: 'busy', error: undefined });
      try {
        const values = await options.operate('Reading native User mixer', () =>
          reserve(
            captures.map((c) => c.binding.session),
            async () => {
              const all = await Promise.allSettled(
                captures.map(async (c) => {
                  fence(c, context);
                  const hardware = await c.binding.session.captureNativeMixerInternal(
                    c.binding.identity,
                  );
                  fence(c, context);
                  return { c, hardware };
                }),
              );
              const failed = all.find((r) => r.status === 'rejected');
              if (failed?.status === 'rejected') throw failed.reason;
              return all.map(
                (r) =>
                  (
                    r as PromiseFulfilledResult<{
                      c: (typeof captures)[number];
                      hardware: NativeMixerCapture;
                    }>
                  ).value,
              );
            },
          ),
        );
        if (epoch !== generation) throw new NativeMixerError('Mixer bindings changed during read');
        captures.forEach((c) => fence(c, context));
        const roles = { ...snapshot.roles };
        for (const { c, hardware } of values) {
          baselines[c.slot] = hardware;
          const current = decodeNativeMixer(hardware.mixerConfiguration),
            old = roles[c.slot],
            draft = copyMatrix(old.draft ?? current),
            opened = [...old.openedPresets];
          // Preserve another preset's independent unsaved draft. The selected
          // modal reads current values, then applies the shared native opener.
          for (let p = 0; p < 3; p++) if (!opened[p]) draft[p] = [...current[p]];
          draft[index] = [...nativeMixerEditorRow(current[index])];
          opened[index] = true;
          const overview = decodeHardwareOverview(
              hardware.configuration,
              hardware.deviceConfiguration,
            ),
            capability = {
              product: hardware.configuration[1],
              moduleType: overview.moduleType,
              core: c.binding.identity.core,
              systemSetup: hardware.configuration[4],
              stereoDsp: overview.stereoDsp,
            };
          roles[c.slot] = rebuild(c.slot, asMatrix(draft), opened, input.preset, {
            ...old,
            canEdit: true,
            availability: nativeMixerAvailability(capability),
            reason: undefined,
          });
        }
        publish({ roles, phase: 'ready', revision: snapshot.revision + 1 });
        return snapshot;
      } catch (failure) {
        refreshBindings();
        publish({ phase: 'error', error: message(failure) });
        throw new NativeMixerError(message(failure));
      } finally {
        flight = false;
        publish();
      }
    },
    open(target, context, input) {
      presetIndex(input.preset);
      return setRows(target, context, input.preset, input.expectedRevision, (row, opened) =>
        opened ? row : [...nativeMixerEditorRow(row)],
      );
    },
    edit(target, context, input) {
      if (
        ![1, 2, 3].includes(input.channel) ||
        !['left', 'right'].includes(input.input) ||
        !Number.isFinite(input.value) ||
        input.value < -1 ||
        input.value > 1
      )
        throw new NativeMixerError('Choose output 1–3 and a finite mixer weight from -1 to 1');
      const offset = (input.channel - 1) * 2 + (input.input === 'right' ? 1 : 0);
      return setRows(target, context, input.preset, input.expectedRevision, (row, opened) => {
        const current = opened ? row : [...nativeMixerEditorRow(row)];
        current[offset] = nativeMixerEditorWeight(input.value);
        return current;
      });
    },
    cancel(target, context, input) {
      selected(target, context);
      mutable();
      const index = presetIndex(input.preset),
        roles = { ...snapshot.roles };
      for (const slot of slots(target)) {
        const old = roles[slot];
        if (!old.current || !old.draft) continue;
        const draft = copyMatrix(old.draft),
          opened = [...old.openedPresets];
        draft[index] = [...old.current[index]];
        opened[index] = false;
        roles[slot] = rebuild(slot, asMatrix(draft), opened, input.preset);
      }
      pending = undefined;
      publish({ roles, revision: snapshot.revision + 1, error: undefined });
    },
    async review(target, context, input) {
      const principal = actor(context),
        captures = selected(target, context),
        index = presetIndex(input.preset);
      mutable();
      version(input.expectedRevision);
      for (const c of captures) {
        checkedRow(c.slot, input.preset);
        if (!snapshot.roles[c.slot].openedPresets[index])
          throw new NativeMixerError('Open this mixer preset before reviewing Save');
      }
      const generation = epoch,
        drafts = new Map(captures.map((c) => [c.slot, [...snapshot.roles[c.slot].draft![index]]]));
      flight = true;
      pending = undefined;
      publish({ phase: 'busy', error: undefined });
      try {
        const prepared = await options.operate('Reviewing native User mixer', () =>
          reserve(
            captures.map((c) => c.binding.session),
            async () => {
              const all = await Promise.allSettled(
                captures.map(async (c) => {
                  fence(c, context);
                  const hardware = await c.binding.session.captureNativeMixerInternal(
                    c.binding.identity,
                  );
                  fence(c, context);
                  assertNativeMixerBaseline(baselines[c.slot]!, hardware);
                  const plan = planNativeMixer(hardware, [
                    { preset: input.preset, weights: drafts.get(c.slot)! },
                  ]);
                  return { ...c, hardware, plan, changed: !same(plan.before, plan.after) };
                }),
              );
              const failed = all.find((r) => r.status === 'rejected');
              if (failed?.status === 'rejected') throw failed.reason;
              return all.map((r) => (r as PromiseFulfilledResult<Capture>).value);
            },
          ),
        );
        if (generation !== epoch)
          throw new NativeMixerError('Mixer connection changed during review');
        captures.forEach((c) => fence(c, context));
        version(input.expectedRevision);
        if (prepared.every((c) => !c.changed))
          throw new NativeMixerError('No mixer changes to save');
        const review = freeze({
          id: nextId(),
          target,
          preset: input.preset,
          revision: input.expectedRevision,
          createdAt: now(),
          roles: prepared.map((c) => ({
            slot: c.slot,
            identity: identityOf(c.binding.identity),
            changed: c.changed,
            before: c.plan.before,
            after: c.plan.after,
          })),
        });
        pending = { owner: principal.owner, scope: principal.scope, review, captures: prepared };
        publish({ phase: 'ready' });
        return review;
      } catch (failure) {
        publish({ phase: 'error', error: message(failure) });
        throw new NativeMixerError(message(failure));
      } finally {
        flight = false;
        publish();
      }
    },
    async save(id, context, confirmation) {
      const principal = actor(context);
      if (confirmation?.confirm !== true)
        throw new NativeMixerError('Confirm native mixer Save explicitly');
      const overlay = overlays.get(id);
      if (overlay) {
        if (overlay.record.owner !== principal.owner)
          throw new NativeMixerError('Mixer record belongs to another workspace');
        return freeze(resultOf(overlay.record, overlay.persistence, true));
      }
      mutable();
      flight = true;
      publish({ phase: 'busy', error: undefined });
      try {
        return await withLock('fusion-studio-native-mixer', async () => {
          await hydrate(context);
          await historyRead();
          const prior = history.records.find((record) => record.id === id);
          if (prior) {
            if (prior.owner !== principal.owner)
              throw new NativeMixerError('Mixer record belongs to another workspace');
            return freeze(resultOf(prior, 'verified', true));
          }
          const active = pending;
          if (!active || active.review.id !== id || active.owner !== principal.owner)
            throw new NativeMixerError('Mixer review expired; review again');
          if (
            history.records.length >= MAX_NATIVE_MIXER_RECORDS ||
            overlays.size >= MAX_NATIVE_MIXER_RECORDS
          )
            throw new NativeMixerError(
              'Native mixer recovery storage is full; no write was started',
            );
          version(active.review.revision);
          pending = undefined;
          publish();
          const record: NativeMixerJournalRecord = {
            id,
            owner: principal.owner,
            scope: active.scope,
            appliedScope: principal.scope,
            target: active.review.target,
            preset: active.review.preset,
            revision: active.review.revision,
            createdAt: now(),
            updatedAt: now(),
            phase: 'prepared',
            roles: active.captures.map((c) => {
              const before = {
                  statusHex: hex(c.hardware.status),
                  configurationHex: hex(c.hardware.configuration),
                  deviceConfigurationHex: hex(c.hardware.deviceConfiguration),
                  mixerHex: hex(c.hardware.mixerConfiguration),
                },
                desired = {
                  requestHex: hex(c.plan.request),
                  expectedHex: hex(c.plan.verification.expected),
                  maskHex: hex(c.plan.verification.mask),
                };
              return {
                slot: c.slot,
                identity: identityOf(c.binding.identity),
                before,
                beforeSha256: nativeMixerBeforeSha256(before),
                desired,
                desiredSha256: nativeMixerDesiredSha256(desired),
                state: c.changed ? 'pending' : 'unchanged',
                attempted: false,
              };
            }),
          };
          let persistence: 'verified' | 'unavailable' = 'verified',
            failure: unknown;
          const store = async () => {
            record.updatedAt = now();
            runtime(record, 'unavailable');
            try {
              await persist(record);
            } catch (error) {
              persistence = 'unavailable';
              throw error;
            }
          };
          try {
            await options.operate('Saving native User mixer', () =>
              reserve(
                active.captures.map((c) => c.binding.session),
                async () => {
                  active.captures.forEach((c) => fence(c, context));
                  // Even a later read-only refusal consumes this reviewed request. Its
                  // immutable originals are durable before any mutating sender exists.
                  await store();
                  const fresh = await Promise.allSettled(
                    active.captures.map(async (c) => {
                      const current = await c.binding.session.captureNativeMixerInternal(
                        c.binding.identity,
                      );
                      fence(c, context);
                      assertNativeMixerBaseline(c.hardware, current);
                      return current;
                    }),
                  );
                  const denied = fresh.find((r) => r.status === 'rejected');
                  if (denied?.status === 'rejected') throw denied.reason;
                  // Every role's complete reviewed original is durable/readback-verified
                  // before any actual67 setter is reachable.
                  record.phase = 'running';
                  await store();
                  let hardwareStarted = false,
                    arrived = 0,
                    intents = 0,
                    broken: unknown,
                    release!: () => void,
                    reject!: (reason: unknown) => void,
                    releaseIntents!: () => void,
                    rejectIntents!: (reason: unknown) => void;
                  const gate = new Promise<void>((resolve, deny) => {
                    release = resolve;
                    reject = deny;
                  });
                  void gate.catch(() => {});
                  const intentsGate = new Promise<void>((resolve, deny) => {
                    releaseIntents = resolve;
                    rejectIntents = deny;
                  });
                  void intentsGate.catch(() => {});
                  const changed = active.captures.filter((c) => c.changed),
                    breakGate = (error: unknown) => {
                      if (!broken) {
                        broken = error;
                        reject(error);
                        rejectIntents(error);
                      }
                    },
                    transactionFence = () =>
                      active.captures.forEach((c) =>
                        fence(c, hardwareStarted ? undefined : context),
                      ),
                    arrive = async () => {
                      if (broken) throw broken;
                      if (++arrived === active.captures.length) release();
                      await gate;
                      transactionFence();
                    };
                  const writes = await Promise.allSettled(
                    active.captures.map(async (c) => {
                      const role = record.roles.find((role) => role.slot === c.slot)!;
                      if (!c.changed) {
                        try {
                          await intentsGate;
                          fence(c, context);
                          const current = await c.binding.session.captureNativeMixerInternal(
                            c.binding.identity,
                          );
                          fence(c, context);
                          assertNativeMixerBaseline(c.hardware, current);
                          await arrive();
                          return;
                        } catch (error) {
                          breakGate(error);
                          throw error;
                        }
                      }
                      try {
                        const actual = await c.binding.session.writeNativeMixerInternal(
                          c.binding.identity,
                          c.hardware,
                          c.plan,
                          {
                            assertCurrent: transactionFence,
                            readyToExchange: async () => {
                              role.state = 'intent';
                              await store();
                              if (++intents === changed.length) releaseIntents();
                              await intentsGate;
                            },
                            afterReady: arrive,
                            onAttempt: () => {
                              role.attempted = true;
                              runtime(record, 'unavailable');
                            },
                            beforeExchange: () => {
                              if (broken) throw broken;
                              transactionFence();
                              // Cancellation may stop preparation, but once a
                              // setter starts all admitted roles finish their
                              // bounded exchange/readback without signal retry.
                              hardwareStarted = true;
                            },
                          },
                        );
                        role.attempted = true;
                        role.state = 'verified';
                        role.actualHex = hex(actual.mixerConfiguration);
                        runtime(record, 'unavailable');
                      } catch (error) {
                        role.attempted =
                          error instanceof NativeMixerStepError ? error.attempted : role.attempted;
                        role.state = role.attempted ? 'unconfirmed' : 'blocked';
                        role.error = message(error);
                        breakGate(error);
                        runtime(record, 'unavailable');
                        throw error;
                      }
                    }),
                  );
                  const deniedWrite = writes.find((r) => r.status === 'rejected');
                  if (deniedWrite?.status === 'rejected') throw deniedWrite.reason;
                },
              ),
            );
            record.phase = 'complete';
            await store();
          } catch (error) {
            failure = error;
            // A failed acknowledgement of the terminal journal must not rewrite
            // already verified hardware outcomes or a possibly durable receipt.
            if (record.roles.every((role) => ['verified', 'unchanged'].includes(role.state))) {
              record.phase = 'complete';
              persistence = 'unavailable';
            } else {
              record.phase = record.roles.some((role) => role.attempted) ? 'partial' : 'failed';
              record.error = message(error);
              for (const role of record.roles)
                if (['pending', 'intent'].includes(role.state)) {
                  role.state = role.attempted ? 'unconfirmed' : 'blocked';
                  role.error ??= record.error;
                }
              try {
                await store();
              } catch {
                persistence = 'unavailable';
              }
            }
          }
          const result = finish(record, persistence, active.captures);
          if (failure) throw new NativeMixerError(message(failure), result);
          return result;
        });
      } catch (failure) {
        if (failure instanceof NativeMixerError) throw failure;
        throw new NativeMixerError(message(failure));
      } finally {
        flight = false;
        publish();
      }
    },
    discard(id, context) {
      actor(context);
      mutable();
      if (pending && pending.review.id === id) {
        pending = undefined;
        publish();
      }
    },
    exportRecord(id, context) {
      const principal = actor(context),
        runtime = overlays.get(id);
      if (runtime) {
        if (runtime.record.owner !== principal.owner)
          throw new NativeMixerError('Mixer record belongs to another workspace');
        return { ...structuredClone(runtime.record), exportPersistence: runtime.persistence };
      }
      const record = history.records.find(
        (record) => record.id === id && record.owner === principal.owner,
      );
      if (!record) throw new NativeMixerError('Mixer recovery record is unavailable');
      return { ...structuredClone(record), exportPersistence: 'verified' };
    },
    refreshBindings,
    dispose() {
      if (disposed) return;
      disposed = true;
      epoch++;
      pending = undefined;
      for (const slot of ['left', 'right'] as const) {
        delete known[slot];
        delete baselines[slot];
      }
      publish({ roles: { left: idleRole(), right: idleRole() }, lastResult: undefined });
      listeners.clear();
    },
  };
  refreshBindings();
  return controller;
}
