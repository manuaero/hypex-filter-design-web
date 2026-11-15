import type { Slot } from '../domain/model';
import { DeviceDefaultsStepError, type PanelSession, type Identity } from '../hardware/session';
import {
  parseExecutionPrincipal,
  type ExecutionPrincipal,
  type ToolExecutionContext,
} from './execution-context';
import {
  buildDeviceDefaultsPlan,
  buildDeviceDefaultsRecoveryPlan,
  deviceDefaultsStatusMask,
  type DeviceDefaultsPlan,
  type DeviceDefaultsSnapshot as HardwareSnapshot,
  type DeviceDefaultsStep,
} from '../hardware/device-defaults';
import { control, decodeStatus, hex, unhex } from '../hardware/codec';
import {
  createDeviceDefaultsStorage,
  defaultsBeforeSha256,
  type DefaultsJournalEnvelope,
  type DefaultsJournalRecord,
  type DefaultsJournalRole,
  type DefaultsJournalStep,
  type DeviceDefaultsStorage,
} from './device-defaults-storage';

export type DeviceDefaultsTarget = Slot | 'both';
export interface DeviceDefaultsBinding {
  session: PanelSession;
  identity: Pick<Identity, 'serial' | 'product' | 'core' | 'firmware'>;
}
export interface DeviceDefaultsReview {
  id: string;
  operation: 'defaults' | 'recovery';
  target: DeviceDefaultsTarget;
  createdAt: number;
  sourceRecordId?: string;
  roles: {
    slot: Slot;
    identity: DeviceDefaultsBinding['identity'];
    before: DeviceDefaultsPlan['before'];
    after: DeviceDefaultsPlan['after'];
    steps: string[];
  }[];
}
export interface DeviceDefaultsSnapshot {
  phase: 'idle' | 'loading' | 'ready' | 'busy' | 'error';
  busy: boolean;
  activeReview?: DeviceDefaultsReview;
  records: DefaultsJournalRecord[];
  error?: string;
}
export interface DeviceDefaultsControllerOptions {
  binding(slot: Slot): DeviceDefaultsBinding | undefined;
  operate<T>(label: string, work: () => Promise<T>): Promise<T>;
  storage?: DeviceDefaultsStorage;
  withLock?<T>(name: string, work: () => Promise<T>): Promise<T>;
  now?: () => number;
  id?: () => string;
}
export interface DeviceDefaultsController {
  getSnapshot(): Readonly<DeviceDefaultsSnapshot>;
  subscribe(listener: () => void): () => void;
  hydrate(context: ToolExecutionContext): Promise<void>;
  /** Cached state only: no storage or device I/O. */
  status(context: ToolExecutionContext): Readonly<DeviceDefaultsSnapshot>;
  reviewDefaults(
    target: DeviceDefaultsTarget,
    context: ToolExecutionContext,
  ): Promise<DeviceDefaultsReview>;
  apply(
    reviewId: string,
    context: ToolExecutionContext,
    confirmation: { confirm: true },
  ): Promise<DefaultsJournalRecord>;
  discard(reviewId: string, context: ToolExecutionContext): void;
  reviewRecovery(recordId: string, context: ToolExecutionContext): Promise<DeviceDefaultsReview>;
  restore(
    reviewId: string,
    context: ToolExecutionContext,
    confirmation: { confirm: true },
  ): Promise<DefaultsJournalRecord>;
  exportRecord(recordId: string, context: ToolExecutionContext): DefaultsJournalRecord;
  refreshBindings(): void;
  dispose(): void;
}

export class DeviceDefaultsError extends Error {
  constructor(
    message: string,
    readonly result?: DefaultsJournalRecord,
  ) {
    super(message);
    this.name = 'DeviceDefaultsError';
  }
}

const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const sameIdentity = (a: DeviceDefaultsBinding['identity'], b: DeviceDefaultsBinding['identity']) =>
  a.serial === b.serial &&
  a.product === b.product &&
  a.core === b.core &&
  a.firmware === b.firmware;
const identityOf = ({ serial, product, core, firmware }: DeviceDefaultsBinding['identity']) => ({
  serial,
  product,
  core,
  firmware,
});
const actorOf = (context: ExecutionPrincipal) => {
  const actor = parseExecutionPrincipal({ owner: context?.owner, scope: context?.scope });
  if (!/^workspace:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(actor.owner))
    throw new DeviceDefaultsError('Device Defaults requires trusted workspace admission');
  return actor;
};
const message = (error: unknown) =>
  (error instanceof Error ? error.message : 'Device Defaults did not complete').slice(0, 1024);
const sameBytes = (a: Uint8Array, b: Uint8Array, mask?: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => ((byte ^ b[i]) & (mask?.[i] ?? 255)) === 0);
const storedSnapshot = (s: HardwareSnapshot): DefaultsJournalRole['before'] => ({
  statusHex: hex(s.status),
  configurationHex: hex(s.configuration),
  deviceConfigurationHex: hex(s.deviceConfiguration),
});
const hardwareSnapshot = (role: DefaultsJournalRole): HardwareSnapshot => ({
  identity: { ...role.identity },
  status: unhex(role.before.statusHex),
  configuration: unhex(role.before.configurationHex),
  deviceConfiguration: unhex(role.before.deviceConfigurationHex),
});
const frame = (step: DefaultsJournalStep): DeviceDefaultsStep => ({
  id: step.id as DeviceDefaultsStep['id'],
  request: unhex(step.requestHex),
  verification: { expected: unhex(step.expectedHex), mask: unhex(step.maskHex) },
});
const reserve = async <T>(sessions: PanelSession[], work: () => Promise<T>): Promise<T> => {
  const ordered = [...sessions].sort((a, b) => a.lockOrder - b.lockOrder);
  const enter = (index: number): Promise<T> =>
    index === ordered.length ? work() : ordered[index].exclusive(() => enter(index + 1));
  return enter(0);
};
async function browserLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks)
    throw new DeviceDefaultsError('Device Defaults requires browser Web Locks before writing');
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
    if (!lock) throw new DeviceDefaultsError('Another browser tab is operating Device Defaults');
    return work();
  });
}

/** Defaults is a multi-report device operation, not an atomic reset. Raw snapshots
 * and an attempted marker are durably verified before each setter. Unknown writes
 * are never retried: recovery always requires another explicit, fresh review. */
export function createDeviceDefaultsController(
  options: DeviceDefaultsControllerOptions,
): DeviceDefaultsController {
  const storage = options.storage ?? createDeviceDefaultsStorage(),
    now = options.now ?? Date.now,
    nextId = options.id ?? (() => crypto.randomUUID()),
    withLock = options.withLock ?? browserLock,
    listeners = new Set<() => void>();
  type Capture = {
    slot: Slot;
    binding: DeviceDefaultsBinding;
    before: HardwareSnapshot;
    plan: DeviceDefaultsPlan;
  };
  type Pending = {
    owner: string;
    scope: string;
    review: DeviceDefaultsReview;
    captures: Capture[];
  };
  let pending: Pending | undefined,
    disposed = false,
    flight = false,
    operationEpoch = 0,
    owner: string | undefined,
    loaded = false,
    loadFlight: Promise<void> | undefined,
    envelope: DefaultsJournalEnvelope = { version: 1, revision: 0, records: [] },
    snapshot: Readonly<DeviceDefaultsSnapshot> = freeze({
      phase: 'idle',
      busy: false,
      records: [],
    });
  let updateTail: Promise<unknown> = Promise.resolve();
  const publish = (patch: Partial<DeviceDefaultsSnapshot> = {}) => {
    snapshot = freeze({
      ...snapshot,
      records: structuredClone(envelope.records.filter((r) => r.owner === owner)),
      activeReview: pending?.review,
      busy: flight,
      ...patch,
    });
    listeners.forEach((fn) => {
      try {
        fn();
      } catch {
        /* View observers cannot interrupt device transactions. */
      }
    });
  };
  const checkActor = (context: ExecutionPrincipal) => {
    const actor = actorOf(context);
    if (owner && actor.owner !== owner)
      throw new DeviceDefaultsError('This Defaults journal belongs to another workspace');
    return actor;
  };
  const assertCurrent = (capture: Capture) => {
    const current = options.binding(capture.slot);
    if (
      disposed ||
      !current ||
      current.session !== capture.binding.session ||
      !sameIdentity(current.identity, capture.binding.identity)
    )
      throw new DeviceDefaultsError(
        'The captured amplifier connection changed; its replacement was not targeted',
      );
  };
  const assertBefore = (expected: HardwareSnapshot, actual: HardwareSnapshot) => {
    if (
      !sameIdentity(expected.identity, actual.identity) ||
      !sameBytes(expected.configuration, actual.configuration) ||
      !sameBytes(expected.deviceConfiguration.slice(2), actual.deviceConfiguration.slice(2)) ||
      !sameBytes(expected.status, actual.status, deviceDefaultsStatusMask())
    )
      throw new DeviceDefaultsError(
        'Amplifier settings changed since review; prepare a fresh Defaults review',
      );
  };
  const load = async (context: ExecutionPrincipal) => {
    const actor = checkActor(context);
    if (disposed) throw new DeviceDefaultsError('Device Defaults is disposed');
    if (loaded) return;
    loadFlight ??= (async () => {
      publish({ phase: 'loading', error: undefined });
      try {
        const saved = await storage.read();
        if (disposed) throw new DeviceDefaultsError('Device Defaults is disposed');
        envelope = saved;
        owner = actor.owner;
        loaded = true;
        publish({ phase: 'ready', error: undefined });
      } catch (error) {
        publish({ phase: 'error', error: message(error) });
        throw error;
      }
    })().finally(() => {
      loadFlight = undefined;
    });
    await loadFlight;
    checkActor(context);
  };
  const mutate = <T>(fn: (draft: DefaultsJournalEnvelope) => T): Promise<T> => {
    const work = updateTail.then(async () => {
      const current = await storage.read(),
        draft = structuredClone(current),
        value = fn(draft);
      draft.revision = current.revision + 1;
      await storage.compareAndSwap(current.revision, draft);
      envelope = draft;
      publish();
      return value;
    });
    updateTail = work.catch(() => {});
    return work;
  };
  const record = (id: string, actor: ExecutionPrincipal) => {
    const found = envelope.records.find((r) => r.id === id && r.owner === actor.owner);
    if (!found)
      throw new DeviceDefaultsError(
        'This Defaults recovery record is unavailable to the workspace',
      );
    return found;
  };
  const setRecord = (id: string, change: (r: DefaultsJournalRecord) => void) =>
    mutate((draft) => {
      const r = draft.records.find((r) => r.id === id && r.owner === owner);
      if (!r) throw new DeviceDefaultsError('Defaults journal record is unavailable');
      change(r);
      r.updatedAt = now();
    });
  async function review(
    target: DeviceDefaultsTarget,
    context: ExecutionPrincipal,
    source?: DefaultsJournalRecord,
  ) {
    await load(context);
    const actor = checkActor(context);
    if (flight || disposed) throw new DeviceDefaultsError('Another Defaults operation is running');
    if (!['left', 'right', 'both'].includes(target))
      throw new DeviceDefaultsError('Choose Left, Right or Both explicitly');
    flight = true;
    operationEpoch++;
    publish({ phase: 'busy', error: undefined });
    try {
      const captures: Capture[] = (target === 'both' ? (['left', 'right'] as const) : [target]).map(
        (slot) => {
          const supplied = options.binding(slot);
          if (!supplied) throw new DeviceDefaultsError(`Connect the ${slot} amplifier first`);
          return {
            slot,
            binding: { session: supplied.session, identity: identityOf(supplied.identity) },
            before: undefined!,
            plan: undefined!,
          };
        },
      );
      if (
        new Set(captures.map((c) => c.binding.session)).size !== captures.length ||
        new Set(captures.map((c) => c.binding.identity.serial)).size !== captures.length
      )
        throw new DeviceDefaultsError('Left and Right must be distinct physical amplifiers');
      await reserve(
        captures.map((c) => c.binding.session),
        async () => {
          const results = await Promise.allSettled(
            captures.map(async (capture) => {
              assertCurrent(capture);
              const before = await capture.binding.session.captureDeviceDefaultsInternal(
                capture.binding.identity,
              );
              assertCurrent(capture);
              capture.before = before;
              if (source) {
                const original = source.roles.find((r) => r.slot === capture.slot);
                if (!original || !sameIdentity(original.identity, before.identity))
                  throw new DeviceDefaultsError(
                    'Recovery snapshot does not match this captured amplifier',
                  );
                capture.plan = buildDeviceDefaultsRecoveryPlan(
                  hardwareSnapshot(original),
                  before.status,
                  before.deviceConfiguration,
                );
              } else capture.plan = buildDeviceDefaultsPlan(before);
            }),
          );
          const failed = results.find((r) => r.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
        },
      );
      const proposal: DeviceDefaultsReview = freeze({
        id: nextId(),
        operation: source ? 'recovery' : 'defaults',
        target,
        createdAt: now(),
        ...(source ? { sourceRecordId: source.id } : {}),
        roles: captures.map((c) => ({
          slot: c.slot,
          identity: { ...c.binding.identity },
          before: structuredClone(c.plan.before),
          after: structuredClone(c.plan.after),
          steps: ['mute', ...c.plan.steps.map((s) => s.id)],
        })),
      });
      pending = { owner: actor.owner, scope: actor.scope, review: proposal, captures };
      publish({ phase: 'ready', error: undefined });
      return proposal;
    } catch (error) {
      publish({ phase: 'error', error: message(error) });
      throw new DeviceDefaultsError(message(error));
    } finally {
      flight = false;
      publish();
    }
  }
  const replay = (r: DefaultsJournalRecord): DefaultsJournalRecord => {
    if (r.phase === 'complete') return freeze(structuredClone(r));
    throw new DeviceDefaultsError(
      'This operation was already consumed. Inspect its journal and explicitly review recovery; no request was retried.',
      freeze(structuredClone(r)),
    );
  };
  async function apply(
    id: string,
    context: ToolExecutionContext,
    confirmation: { confirm: true },
    operation: 'defaults' | 'recovery',
  ) {
    const actor = checkActor(context),
      signal = context.signal;
    if (confirmation?.confirm !== true)
      throw new DeviceDefaultsError('Explicitly confirm the reviewed device settings');
    await load(context);
    const historical = envelope.records.find((r) => r.id === id && r.owner === actor.owner);
    if (historical) {
      if (historical.operation !== operation)
        throw new DeviceDefaultsError('This review belongs to a different device operation');
      return replay(historical);
    }
    if (flight || disposed) throw new DeviceDefaultsError('Another Defaults operation is running');
    const captured = pending;
    if (
      !captured ||
      captured.review.id !== id ||
      captured.owner !== actor.owner ||
      captured.review.operation !== operation
    )
      throw new DeviceDefaultsError(
        'The Defaults review is missing, stale or belongs to another workspace',
      );
    pending = undefined;
    flight = true;
    operationEpoch++;
    publish({ phase: 'busy', error: undefined });
    let journal: DefaultsJournalRecord | undefined;
    try {
      return await options.operate(
        operation === 'defaults' ? 'Applying device Defaults' : 'Restoring device settings',
        () =>
          withLock('fusion-studio-device-defaults', () =>
            reserve(
              captured.captures.map((c) => c.binding.session),
              async () => {
                const currentEnvelope = await storage.read();
                envelope = currentEnvelope;
                const duplicate = currentEnvelope.records.find((r) => r.id === id);
                if (duplicate) {
                  if (duplicate.owner !== actor.owner)
                    throw new DeviceDefaultsError('Defaults request belongs to another workspace');
                  if (duplicate.operation !== operation)
                    throw new DeviceDefaultsError(
                      'This review belongs to a different device operation',
                    );
                  return replay(duplicate);
                }
                const fresh = await Promise.allSettled(
                  captured.captures.map(async (c) => {
                    assertCurrent(c);
                    const actual = await c.binding.session.captureDeviceDefaultsInternal(
                      c.binding.identity,
                    );
                    assertCurrent(c);
                    assertBefore(c.before, actual);
                  }),
                );
                const failed = fresh.find((r) => r.status === 'rejected');
                if (failed?.status === 'rejected') throw failed.reason;
                const serials = captured.captures.map((c) => c.binding.identity.serial);
                if (
                  currentEnvelope.records.some(
                    (r, index, records) =>
                      ['prepared', 'running', 'partial'].includes(r.phase) &&
                      r.roles.some((role) => serials.includes(role.identity.serial)) &&
                      // Historical uncertainty is retained verbatim. Only a later
                      // verified inverse covering this exact family and every
                      // captured identity resolves its block on new Defaults.
                      !records
                        .slice(index + 1)
                        .some(
                          (later) =>
                            later.owner === r.owner &&
                            later.operation === 'recovery' &&
                            later.phase === 'complete' &&
                            later.sourceRecordId ===
                              (r.operation === 'defaults' ? r.id : r.sourceRecordId) &&
                            r.roles.every((priorRole) =>
                              later.roles.some(
                                (recoveredRole) =>
                                  recoveredRole.slot === priorRole.slot &&
                                  sameIdentity(recoveredRole.identity, priorRole.identity) &&
                                  recoveredRole.preflight === 'verified' &&
                                  recoveredRole.steps.every(
                                    (step) => step.state === 'verified' && step.attempted,
                                  ),
                              ),
                            ),
                        ) &&
                      !(
                        operation === 'recovery' &&
                        (r.id === captured.review.sourceRecordId ||
                          r.sourceRecordId === captured.review.sourceRecordId)
                      ),
                  )
                )
                  throw new DeviceDefaultsError(
                    'An unfinished Defaults transaction requires explicit recovery before another Defaults operation',
                  );
                journal = {
                  id,
                  owner: actor.owner,
                  scope: captured.scope,
                  appliedScope: actor.scope,
                  operation,
                  ...(captured.review.sourceRecordId
                    ? { sourceRecordId: captured.review.sourceRecordId }
                    : {}),
                  target: captured.review.target,
                  createdAt: captured.review.createdAt,
                  updatedAt: now(),
                  phase: 'prepared',
                  roles: captured.captures.map((c) => {
                    const before = storedSnapshot(c.before),
                      mute = control(decodeStatus(c.before.status), { mute: true });
                    const steps = [
                      {
                        id: 'mute' as const,
                        request: mute,
                        verification: { expected: mute, mask: deviceDefaultsStatusMask() },
                      },
                      ...c.plan.steps,
                    ];
                    return {
                      slot: c.slot,
                      identity: { ...c.binding.identity },
                      before,
                      beforeSha256: defaultsBeforeSha256(before),
                      preflight: 'verified' as const,
                      lastConfirmedMuted: !!(c.before.status[6] & 128),
                      steps: steps.map((s) => ({
                        id: s.id,
                        requestHex: hex(s.request),
                        expectedHex: hex(s.verification.expected),
                        maskHex: hex(s.verification.mask),
                        state: 'pending' as const,
                        attempted: false,
                      })),
                    };
                  }),
                };
                await mutate((draft) => {
                  draft.records.push(structuredClone(journal!));
                });
                // Cancellation applies before the first write. Once a setter is in flight,
                // finish its verification/ledger instead of abandoning a partial operation.
                signal?.throwIfAborted();
                for (const c of captured.captures) assertCurrent(c);
                await setRecord(id, (r) => {
                  r.phase = 'running';
                });
                const expected = captured.captures.map((c) => structuredClone(c.before));
                let hardwareStarted = false;
                let releaseMute!: () => void, rejectMute!: (error: unknown) => void;
                const muteReady = new Set<number>(),
                  muteBarrier = new Promise<void>((resolve, reject) => {
                    releaseMute = resolve;
                    rejectMute = reject;
                  });
                // A participant can fail before any other participant waits.
                void muteBarrier.catch(() => {});
                const runStep = async (index: number, stepIndex: number) => {
                  const c = captured.captures[index],
                    saved = record(id, actor).roles[index].steps[stepIndex];
                  try {
                    const result = await c.binding.session.writeDeviceDefaultsStepInternal(
                      c.binding.identity,
                      frame(saved),
                      {
                        assertCurrent: () => assertCurrent(c),
                        assertSnapshot: (actual) => assertBefore(expected[index], actual),
                        ...(stepIndex === 0
                          ? {
                              readyToExchange: async () => {
                                muteReady.add(index);
                                if (muteReady.size === captured.captures.length) releaseMute();
                                await muteBarrier;
                              },
                            }
                          : {}),
                        beforeExchange: () => {
                          // No await separates this shared cancellation fence from
                          // the first setter on either participant. After admission,
                          // finish verification and ledger handling even if aborted.
                          if (!hardwareStarted) {
                            signal?.throwIfAborted();
                            for (const participant of captured.captures) assertCurrent(participant);
                          }
                          hardwareStarted = true;
                        },
                        beforeSend: () =>
                          setRecord(id, (r) => {
                            const s = r.roles[index].steps[stepIndex];
                            s.state = 'attempted';
                            s.attempted = true;
                          }),
                      },
                    );
                    if (unhex(saved.requestHex)[0] === 5)
                      expected[index].status = result.raw.slice();
                    else {
                      expected[index].deviceConfiguration = unhex(saved.expectedHex);
                      expected[index].deviceConfiguration[1] = 0;
                    }
                    await setRecord(id, (r) => {
                      r.roles[index].steps[stepIndex].state = 'verified';
                      r.roles[index].lastConfirmedMuted = result.muted;
                    });
                  } catch (error) {
                    if (stepIndex === 0) rejectMute(error);
                    await setRecord(id, (r) => {
                      const role = r.roles[index],
                        step = role.steps[stepIndex];
                      step.state = 'failed';
                      if (error instanceof DeviceDefaultsStepError && !error.attempted)
                        step.attempted = false;
                      step.error = message(error);
                      role.error = message(error);
                      if (c.binding.session.lastStatus)
                        role.lastConfirmedMuted = c.binding.session.lastStatus.muted;
                    }).catch(() => {});
                    throw error;
                  }
                };
                const mutes = await Promise.allSettled(
                  captured.captures.map((_, i) => runStep(i, 0)),
                );
                if (mutes.some((r) => r.status === 'rejected'))
                  throw new DeviceDefaultsError(
                    'Mute was not confirmed on every selected amplifier; no Defaults phase was started',
                  );
                const results = await Promise.allSettled(
                  captured.captures.map(async (_, i) => {
                    for (let n = 1; n < record(id, actor).roles[i].steps.length; n++)
                      await runStep(i, n);
                  }),
                );
                if (results.some((r) => r.status === 'rejected'))
                  throw new DeviceDefaultsError(
                    'Device settings were not completely verified; inspect each role and step',
                  );
                await setRecord(id, (r) => {
                  r.phase = 'complete';
                });
                return freeze(structuredClone(record(id, actor)));
              },
            ),
          ),
      );
    } catch (error) {
      if (journal) {
        try {
          envelope = await storage.read();
          const confirmed = envelope.records.find((r) => r.id === id && r.owner === actor.owner);
          if (confirmed?.phase === 'complete') {
            publish({ phase: 'ready', error: undefined });
            return freeze(structuredClone(confirmed));
          }
        } catch {
          /* Keep the last durable attempted marker if storage is unavailable. */
        }
        await setRecord(id, (r) => {
          if (r.phase === 'complete') return;
          r.phase = r.roles.some((role) => role.steps.some((s) => s.attempted))
            ? 'partial'
            : 'failed';
          r.error = message(error);
        }).catch(() => {});
        // A constructed proposal is not a durable recovery receipt. Return only
        // a record observed in storage or retained from a verified journal write.
        journal = envelope.records.find((r) => r.id === id && r.owner === actor.owner);
      }
      publish({ phase: 'error', error: message(error) });
      if (error instanceof DeviceDefaultsError && error.result) throw error;
      throw new DeviceDefaultsError(
        message(error),
        journal ? freeze(structuredClone(journal)) : undefined,
      );
    } finally {
      flight = false;
      publish({ phase: snapshot.error ? 'error' : 'ready' });
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async hydrate(context) {
      if (flight) throw new DeviceDefaultsError('A Defaults operation is running');
      loaded = false;
      await load(context);
    },
    status(context) {
      checkActor(context);
      return snapshot;
    },
    reviewDefaults: (target, context) => review(target, context),
    apply: (id, context, confirmation) => apply(id, context, confirmation, 'defaults'),
    discard(id, context) {
      const actor = checkActor(context);
      if (flight) throw new DeviceDefaultsError('A Defaults operation is running');
      if (!pending || pending.owner !== actor.owner || pending.review.id !== id)
        throw new DeviceDefaultsError('Defaults review is unavailable');
      pending = undefined;
      operationEpoch++;
      publish();
    },
    async reviewRecovery(id, context) {
      if (flight || disposed)
        throw new DeviceDefaultsError('Another Defaults operation is running or disposed');
      const epoch = operationEpoch;
      await load(context);
      const actor = checkActor(context);
      if (flight || disposed || operationEpoch !== epoch)
        throw new DeviceDefaultsError(
          'Defaults state changed while preparing recovery; review it again',
        );
      // A detached read must never replace the live transaction cache. An older
      // read may resolve after another operation has advanced its journal.
      const saved = await storage.read();
      if (flight || disposed || operationEpoch !== epoch)
        throw new DeviceDefaultsError(
          'Defaults state changed while preparing recovery; review it again',
        );
      const find = (recordId: string) => {
        const found = saved.records.find((r) => r.id === recordId && r.owner === actor.owner);
        if (!found)
          throw new DeviceDefaultsError(
            'This Defaults recovery record is unavailable to the workspace',
          );
        return found;
      };
      const selected = find(id),
        source = selected.operation === 'defaults' ? selected : find(selected.sourceRecordId!);
      return review(source.target, context, source);
    },
    restore: (id, context, confirmation) => apply(id, context, confirmation, 'recovery'),
    exportRecord(id, context) {
      return structuredClone(record(id, checkActor(context)));
    },
    refreshBindings() {
      if (
        pending &&
        pending.captures.some((c) => {
          try {
            assertCurrent(c);
            return false;
          } catch {
            return true;
          }
        })
      ) {
        pending = undefined;
        operationEpoch++;
        publish();
      }
    },
    dispose() {
      disposed = true;
      operationEpoch++;
      pending = undefined;
      publish();
      listeners.clear();
    },
  };
}
