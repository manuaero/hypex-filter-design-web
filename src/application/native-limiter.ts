import type { Slot } from '../domain/model';
import { NativeLimiterStepError, type Identity, type PanelSession } from '../hardware/session';
import { decodeLimiter, type LimiterConfiguration } from '../hardware/device-settings';
import {
  loadNativeLimiter,
  editNativeLimiter,
  previewNativeLimiter,
  type NativeLimiterAction,
  type NativeLimiterDraft,
  type NativeLimiterPreview,
} from '../hardware/native-limiter';
import { parseExecutionPrincipal, type ToolExecutionContext } from './execution-context';
import { decodeStatus, unhex } from '../hardware/codec';
import { assertOperationAllowed, decodeProtection } from '../hardware/protection';
import type { DeviceDefaultsSnapshot as HardwareSnapshot } from '../hardware/device-defaults';

export type NativeLimiterTarget = Slot | 'both';
export type NativeLimiterEditAction =
  Exclude<NativeLimiterAction, { type: 'bridge' }> | { type: 'expert-mode'; value: boolean };
export interface NativeLimiterBinding {
  session: PanelSession;
  identity: Pick<Identity, 'serial' | 'product' | 'core' | 'firmware'>;
}
export interface NativeLimiterRoleState {
  connected: boolean;
  identity?: NativeLimiterBinding['identity'];
  expert: boolean;
  draft?: NativeLimiterDraft;
  preview?: Pick<NativeLimiterPreview, 'channels'>;
  canUpdate?: boolean;
  error?: string;
}
export interface NativeLimiterReview {
  id: string;
  target: NativeLimiterTarget;
  revision: number;
  createdAt: number;
  roles: {
    slot: Slot;
    identity: NativeLimiterBinding['identity'];
    expert: boolean;
    draft: Omit<NativeLimiterDraft, 'sourceHex'>;
    before: LimiterConfiguration['channels'];
    after: NativeLimiterPreview['channels'];
  }[];
}
export interface NativeLimiterStepResult {
  id: 'mute' | 'configuration';
  attempted: boolean;
  verified: boolean;
  error?: string;
}
export interface NativeLimiterResult {
  reviewId: string;
  target: NativeLimiterTarget;
  complete: boolean;
  partial: boolean;
  roles: {
    slot: Slot;
    identity: NativeLimiterBinding['identity'];
    backupId?: string;
    preflight: 'pending' | 'verified' | 'failed';
    steps: NativeLimiterStepResult[];
    lastConfirmedMuted: boolean | null;
    stale?: boolean;
    error?: string;
  }[];
  error?: string;
}
export interface NativeLimiterSnapshot {
  phase: 'idle' | 'ready' | 'busy' | 'error';
  busy: boolean;
  revision: number;
  roles: Record<Slot, NativeLimiterRoleState>;
  activeReview?: NativeLimiterReview;
  lastResult?: NativeLimiterResult;
  error?: string;
}
export interface NativeLimiterControllerOptions {
  binding(slot: Slot): NativeLimiterBinding | undefined;
  operate<T>(label: string, work: () => Promise<T>): Promise<T>;
  now?: () => number;
  id?: () => string;
  withLock?<T>(name: string, work: () => Promise<T>): Promise<T>;
}
export interface NativeLimiterController {
  getSnapshot(): Readonly<NativeLimiterSnapshot>;
  subscribe(listener: () => void): () => void;
  status(context: ToolExecutionContext): Readonly<NativeLimiterSnapshot>;
  load(
    target: NativeLimiterTarget,
    context: ToolExecutionContext,
  ): Promise<Readonly<NativeLimiterSnapshot>>;
  edit(
    target: NativeLimiterTarget,
    context: ToolExecutionContext,
    input: { expectedRevision: number; action: NativeLimiterEditAction },
  ): Readonly<NativeLimiterSnapshot>;
  review(
    target: NativeLimiterTarget,
    context: ToolExecutionContext,
    input: { expectedRevision: number },
  ): Promise<NativeLimiterReview>;
  apply(
    reviewId: string,
    context: ToolExecutionContext,
    confirmation: { confirm: true },
  ): Promise<NativeLimiterResult>;
  discard(reviewId: string, context: ToolExecutionContext): void;
  refreshBindings(): void;
  dispose(): void;
}
export class NativeLimiterError extends Error {
  constructor(
    message: string,
    readonly result?: NativeLimiterResult,
  ) {
    super(message);
    this.name = 'NativeLimiterError';
  }
}

function immutable<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
}
const identityOf = ({ serial, product, core, firmware }: NativeLimiterBinding['identity']) => ({
  serial,
  product,
  core,
  firmware,
});
const sameIdentity = (a: NativeLimiterBinding['identity'], b: NativeLimiterBinding['identity']) =>
  a.serial === b.serial &&
  a.product === b.product &&
  a.core === b.core &&
  a.firmware === b.firmware;
const sameConfiguration = (a: Uint8Array, b: Uint8Array) =>
  a.length === 64 && b.length === 64 && a.every((v, i) => i === 1 || v === b[i]);
const problem = (error: unknown) =>
  (error instanceof Error ? error.message : 'Native limiter operation did not complete').slice(
    0,
    1024,
  );
const withoutSource = (draft: NativeLimiterDraft): Omit<NativeLimiterDraft, 'sourceHex'> => {
  const { sourceHex: _source, ...rest } = draft;
  return structuredClone(rest);
};
const reserve = async <T>(sessions: PanelSession[], work: () => Promise<T>): Promise<T> => {
  const ordered = [...sessions].sort((a, b) => a.lockOrder - b.lockOrder);
  const enter = (index: number): Promise<T> =>
    index === ordered.length ? work() : ordered[index].exclusive(() => enter(index + 1));
  return enter(0);
};
async function browserLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks)
    throw new NativeLimiterError('Native limiter updates require browser Web Locks');
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
    if (!lock) throw new NativeLimiterError('Another browser tab is updating the native limiter');
    return work();
  });
}

/** No hardware work on construction/status. Reviews and consumed receipts are
 * session-local, bounded to 32 applies; reload cannot resume or replay a token.
 * Exact configuration backups remain in the existing persistent backup store. */
export function createNativeLimiterController(
  options: NativeLimiterControllerOptions,
): NativeLimiterController {
  const now = options.now ?? Date.now,
    nextId = options.id ?? (() => crypto.randomUUID()),
    withLock = options.withLock ?? browserLock;
  const listeners = new Set<() => void>(),
    bindings: Partial<Record<Slot, NativeLimiterBinding>> = {},
    receipts = new Map<string, { owner: string; result: NativeLimiterResult }>();
  type Capture = {
    slot: Slot;
    binding: NativeLimiterBinding;
    draft: NativeLimiterDraft;
    preview: NativeLimiterPreview;
    hardware: HardwareSnapshot;
  };
  let pending: { owner: string; review: NativeLimiterReview; captures: Capture[] } | undefined,
    owner: string | undefined,
    disposed = false,
    flight = false,
    snapshot: Readonly<NativeLimiterSnapshot> = immutable({
      phase: 'idle',
      busy: false,
      revision: 0,
      roles: {
        left: { connected: false, expert: false },
        right: { connected: false, expert: false },
      },
    });
  const publish = (patch: Partial<NativeLimiterSnapshot> = {}) => {
    snapshot = immutable({ ...snapshot, busy: flight, activeReview: pending?.review, ...patch });
    listeners.forEach((fn) => {
      try {
        fn();
      } catch {
        /* View observers never interrupt a device operation. */
      }
    });
  };
  const actor = (context: ToolExecutionContext) => {
    const checked = parseExecutionPrincipal({ owner: context?.owner, scope: context?.scope });
    if (!/^workspace:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(checked.owner))
      throw new NativeLimiterError('Native limiter requires trusted workspace admission');
    if (owner && owner !== checked.owner)
      throw new NativeLimiterError('Native limiter state belongs to another workspace');
    if (disposed) throw new NativeLimiterError('Native limiter is disposed');
    owner ??= checked.owner;
    return checked;
  };
  const refreshBindings = () => {
    if (disposed) return;
    const roles = { ...snapshot.roles };
    let changed = false;
    for (const slot of ['left', 'right'] as const) {
      const supplied = options.binding(slot),
        next = supplied
          ? { session: supplied.session, identity: identityOf(supplied.identity) }
          : undefined,
        prior = bindings[slot];
      if (
        (!next && prior) ||
        (next &&
          (!prior ||
            next.session !== prior.session ||
            !sameIdentity(next.identity, prior.identity)))
      ) {
        bindings[slot] = next;
        roles[slot] = {
          connected: !!next,
          expert: false,
          ...(next ? { identity: next.identity } : {}),
        };
        changed = true;
      }
    }
    if (changed) {
      pending = undefined;
      publish({ roles, revision: snapshot.revision + 1 });
    }
  };
  const current = (capture: Pick<Capture, 'slot' | 'binding'>) => {
    const live = options.binding(capture.slot);
    if (
      disposed ||
      !live ||
      live.session !== capture.binding.session ||
      !sameIdentity(live.identity, capture.binding.identity)
    )
      throw new NativeLimiterError(
        'The captured amplifier connection changed; its replacement was not targeted',
      );
  };
  const select = (target: NativeLimiterTarget) => {
    if (!['left', 'right', 'both'].includes(target))
      throw new NativeLimiterError('Choose Left, Right or Both explicitly');
    refreshBindings();
    const selected = (target === 'both' ? (['left', 'right'] as const) : [target]).map((slot) => {
      const binding = bindings[slot];
      if (!binding) throw new NativeLimiterError(`Connect the ${slot} amplifier first`);
      return { slot, binding };
    });
    if (
      new Set(selected.map((c) => c.binding.session)).size !== selected.length ||
      new Set(selected.map((c) => c.binding.identity.serial)).size !== selected.length
    )
      throw new NativeLimiterError('Left and Right require distinct physical amplifiers');
    return selected;
  };
  const guard = () => {
    if (flight || disposed)
      throw new NativeLimiterError('A native limiter operation is already running or disposed');
  };
  const revision = (expected: number) => {
    if (!Number.isSafeInteger(expected) || expected !== snapshot.revision)
      throw new NativeLimiterError('The native limiter draft changed; read its current revision');
  };
  const readyPreview = (draft: NativeLimiterDraft): Pick<NativeLimiterPreview, 'channels'> => ({
    channels: structuredClone(previewNativeLimiter(draft).channels),
  });
  async function load(target: NativeLimiterTarget, context: ToolExecutionContext) {
    actor(context);
    guard();
    const captures = select(target);
    pending = undefined;
    flight = true;
    publish({ phase: 'busy', error: undefined });
    try {
      const loaded = await reserve(
        captures.map((c) => c.binding.session),
        async () => {
          const all = await Promise.allSettled(
            captures.map(async (c) => {
              current(c);
              const raw = await c.binding.session.captureNativeLimiterInternal(
                c.binding.identity,
                false,
              );
              current(c);
              const draft = loadNativeLimiter(raw.deviceConfiguration, {
                bridged: !!(raw.status[9] & 2),
              });
              return {
                capture: c,
                draft,
                canUpdate: decodeProtection(decodeStatus(raw.status), raw.deviceConfiguration[11])
                  .operations.softclipLimiter.allowed,
              };
            }),
          );
          const failed = all.find((r) => r.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
          return all.map(
            (r) =>
              (
                r as PromiseFulfilledResult<{
                  capture: (typeof captures)[number];
                  draft: NativeLimiterDraft;
                  canUpdate: boolean;
                }>
              ).value,
          );
        },
      );
      const roles = { ...snapshot.roles };
      for (const { capture, draft, canUpdate } of loaded) {
        current(capture);
        let preview: NativeLimiterRoleState['preview'], error: string | undefined;
        try {
          preview = readyPreview(draft);
        } catch (failure) {
          error = problem(failure);
        }
        roles[capture.slot] = {
          connected: true,
          identity: capture.binding.identity,
          draft,
          expert: snapshot.roles[capture.slot].expert,
          canUpdate,
          ...(preview ? { preview } : {}),
          ...(error ? { error } : {}),
        };
      }
      publish({ phase: 'ready', roles, revision: snapshot.revision + 1, error: undefined });
      return snapshot;
    } catch (error) {
      publish({ phase: 'error', error: problem(error) });
      throw new NativeLimiterError(problem(error));
    } finally {
      flight = false;
      publish();
    }
  }
  function edit(
    target: NativeLimiterTarget,
    context: ToolExecutionContext,
    input: { expectedRevision: number; action: NativeLimiterEditAction },
  ) {
    actor(context);
    guard();
    const selected = select(target);
    revision(input.expectedRevision);
    if ((input.action as { type: string }).type === 'bridge')
      throw new NativeLimiterError(
        'Bridge mode is bound to the live amplifier; read it again after a device change',
      );
    const roles = { ...snapshot.roles };
    for (const c of selected) {
      const before = roles[c.slot];
      if (!before.draft) throw new NativeLimiterError(`Read the ${c.slot} limiter first`);
      if (input.action.type === 'expert-mode')
        roles[c.slot] = { ...before, expert: input.action.value };
      else {
        const draft = editNativeLimiter(before.draft, input.action);
        let preview: NativeLimiterRoleState['preview'], error: string | undefined;
        try {
          preview = readyPreview(draft);
        } catch (failure) {
          error = problem(failure);
        }
        const { preview: _preview, error: _error, ...kept } = before;
        roles[c.slot] = {
          ...kept,
          draft,
          ...(preview ? { preview } : {}),
          ...(error ? { error } : {}),
        };
      }
    }
    pending = undefined;
    publish({ phase: 'ready', roles, revision: snapshot.revision + 1, error: undefined });
    return snapshot;
  }
  async function review(
    target: NativeLimiterTarget,
    context: ToolExecutionContext,
    input: { expectedRevision: number },
  ) {
    const principal = actor(context);
    guard();
    const selected = select(target);
    revision(input.expectedRevision);
    const captures = selected.map((c) => {
      const draft = snapshot.roles[c.slot].draft;
      if (!draft) throw new NativeLimiterError(`Read the ${c.slot} limiter first`);
      const frozenDraft = structuredClone(draft);
      try {
        return {
          ...c,
          draft: frozenDraft,
          preview: previewNativeLimiter(frozenDraft),
          hardware: undefined! as HardwareSnapshot,
        };
      } catch (error) {
        throw new NativeLimiterError(problem(error));
      }
    });
    pending = undefined;
    flight = true;
    publish({ phase: 'busy', error: undefined });
    try {
      await reserve(
        captures.map((c) => c.binding.session),
        async () => {
          const checks = await Promise.allSettled(
            captures.map(async (c) => {
              current(c);
              c.hardware = await c.binding.session.captureNativeLimiterInternal(c.binding.identity);
              current(c);
              if (
                !sameConfiguration(unhex(c.draft.sourceHex), c.hardware.deviceConfiguration) ||
                c.draft.bridged !== !!(c.hardware.status[9] & 2)
              )
                throw new NativeLimiterError(
                  'Native limiter or bridge mode changed; read the amplifier again',
                );
            }),
          );
          const failed = checks.find((r) => r.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
        },
      );
      const proposal: NativeLimiterReview = immutable({
        id: nextId(),
        target,
        revision: snapshot.revision,
        createdAt: now(),
        roles: captures.map((c) => ({
          slot: c.slot,
          identity: c.binding.identity,
          expert: snapshot.roles[c.slot].expert,
          draft: withoutSource(c.preview.draft),
          before: decodeLimiter(c.hardware.deviceConfiguration).channels,
          after: structuredClone(c.preview.channels),
        })),
      });
      if (
        !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(proposal.id) ||
        receipts.has(proposal.id)
      )
        throw new NativeLimiterError('A native limiter review must have a fresh unique token');
      pending = { owner: principal.owner, review: proposal, captures };
      publish({ phase: 'ready', error: undefined });
      return proposal;
    } catch (error) {
      publish({ phase: 'error', error: problem(error) });
      throw new NativeLimiterError(problem(error));
    } finally {
      flight = false;
      publish();
    }
  }
  async function apply(
    reviewId: string,
    context: ToolExecutionContext,
    confirmation: { confirm: true },
  ) {
    const principal = actor(context),
      signal = context.signal;
    if (confirmation?.confirm !== true)
      throw new NativeLimiterError('Explicitly confirm the reviewed limiter settings');
    const saved = receipts.get(reviewId);
    if (saved) {
      if (saved.owner !== principal.owner)
        throw new NativeLimiterError('Limiter receipt belongs to another workspace');
      if (!saved.result.complete)
        throw new NativeLimiterError(
          'This native limiter operation was already consumed; inspect its ledger and read the amplifier before another review',
          saved.result,
        );
      return saved.result;
    }
    guard();
    if (!pending || pending.owner !== principal.owner || pending.review.id !== reviewId)
      throw new NativeLimiterError(
        'The native limiter review is missing or stale; reload does not resume a token',
      );
    if (receipts.size >= 32)
      throw new NativeLimiterError(
        'This session has 32 consumed limiter receipts; saved backups remain available. Reload before creating another operation',
      );
    const captured = pending;
    pending = undefined;
    flight = true;
    const result: NativeLimiterResult = {
      reviewId,
      target: captured.review.target,
      complete: false,
      partial: false,
      roles: captured.captures.map((c) => ({
        slot: c.slot,
        identity: c.binding.identity,
        preflight: 'pending',
        steps: [
          { id: 'mute', attempted: false, verified: false },
          { id: 'configuration', attempted: false, verified: false },
        ],
        lastConfirmedMuted: null,
      })),
    };
    publish({ phase: 'busy', error: undefined });
    let hardwareStarted = false;
    try {
      await options.operate('Updating native limiter', () =>
        withLock('fusion-studio-native-limiter', () =>
          reserve(
            captured.captures.map((c) => c.binding.session),
            async () => {
              const prepared = await Promise.allSettled(
                captured.captures.map(async (c, i) => {
                  try {
                    current(c);
                    const fresh = await c.binding.session.captureNativeLimiterInternal(
                      c.binding.identity,
                      false,
                    );
                    result.roles[i].lastConfirmedMuted = decodeStatus(fresh.status).muted;
                    current(c);
                    assertOperationAllowed(
                      decodeStatus(fresh.status),
                      'softclipLimiter',
                      fresh.deviceConfiguration[11],
                    );
                    if (
                      !sameConfiguration(
                        fresh.deviceConfiguration,
                        c.hardware.deviceConfiguration,
                      ) ||
                      !!(fresh.status[9] & 2) !== c.draft.bridged
                    )
                      throw new NativeLimiterError(
                        'Limiter configuration or bridge mode changed since review',
                      );
                    result.roles[i].preflight = 'verified';
                  } catch (error) {
                    result.roles[i].preflight = 'failed';
                    result.roles[i].error = problem(error);
                    throw error;
                  }
                }),
              );
              const failed = prepared.find((r) => r.status === 'rejected');
              if (failed?.status === 'rejected') throw failed.reason;
              const backups = await Promise.allSettled(
                captured.captures.map(async (c, i) => {
                  try {
                    current(c);
                    const backup = await c.binding.session.backupConfigurationInternal();
                    current(c);
                    if (
                      sameIdentity(c.binding.identity, {
                        ...backup,
                        core: c.binding.session.identity?.core ?? '',
                      })
                    )
                      result.roles[i].lastConfirmedMuted = decodeStatus(
                        unhex(backup.status_hex),
                      ).muted;
                    if (
                      !sameIdentity(c.binding.identity, {
                        ...backup,
                        core: c.binding.session.identity?.core ?? '',
                      }) ||
                      !sameConfiguration(
                        unhex(backup.configuration_hex),
                        c.hardware.deviceConfiguration,
                      ) ||
                      !!(unhex(backup.status_hex)[9] & 2) !== c.draft.bridged
                    )
                      throw new NativeLimiterError(
                        'Limiter identity, bridge or configuration changed during backup',
                      );
                    result.roles[i].backupId = backup.id;
                  } catch (error) {
                    result.roles[i].preflight = 'failed';
                    result.roles[i].error = problem(error);
                    throw error;
                  }
                }),
              );
              const backupFailure = backups.find((r) => r.status === 'rejected');
              if (backupFailure?.status === 'rejected') throw backupFailure.reason;
              signal?.throwIfAborted();
              let release!: () => void, reject!: (error: unknown) => void;
              const ready = new Set<number>(),
                barrier = new Promise<void>((yes, no) => {
                  release = yes;
                  reject = no;
                });
              void barrier.catch(() => {});
              const perform = async (i: number, stepIndex: 0 | 1) => {
                const c = captured.captures[i],
                  role = result.roles[i],
                  step = role.steps[stepIndex];
                try {
                  const reply = await c.binding.session.writeNativeLimiterStepInternal(
                    c.binding.identity,
                    step.id,
                    c.hardware.deviceConfiguration,
                    c.draft.bridged,
                    c.preview.request,
                    {
                      assertCurrent: () => current(c),
                      ...(stepIndex === 0
                        ? {
                            readyToExchange: async () => {
                              ready.add(i);
                              if (ready.size === captured.captures.length) release();
                              await barrier;
                            },
                          }
                        : {}),
                      onAttempt: () => {
                        step.attempted = true;
                        publish({ lastResult: structuredClone(result) });
                      },
                      beforeExchange: () => {
                        if (!hardwareStarted) {
                          signal?.throwIfAborted();
                          for (const capture of captured.captures) current(capture);
                        }
                        hardwareStarted = true;
                      },
                    },
                  );
                  step.verified = true;
                  role.lastConfirmedMuted = reply.status.muted;
                  if (reply.configuration) {
                    const freshDraft = loadNativeLimiter(reply.configuration.raw, {
                      bridged: c.draft.bridged,
                    });
                    let stillCurrent = true;
                    try {
                      current(c);
                    } catch {
                      stillCurrent = false;
                      role.stale = true;
                    }
                    if (stillCurrent)
                      publish({
                        roles: {
                          ...snapshot.roles,
                          [c.slot]: {
                            ...snapshot.roles[c.slot],
                            draft: freshDraft,
                            preview: readyPreview(freshDraft),
                            error: undefined,
                          },
                        },
                      });
                  }
                  publish({ lastResult: structuredClone(result) });
                } catch (error) {
                  if (stepIndex === 0) reject(error);
                  if (error instanceof NativeLimiterStepError && !error.attempted)
                    step.attempted = false;
                  step.error = problem(error);
                  role.error = problem(error);
                  if (c.binding.session.lastStatus)
                    role.lastConfirmedMuted = c.binding.session.lastStatus.muted;
                  throw error;
                }
              };
              const mutes = await Promise.allSettled(
                captured.captures.map((_, i) => perform(i, 0)),
              );
              if (mutes.some((r) => r.status === 'rejected'))
                throw new NativeLimiterError(
                  'Mute readiness failed on a selected amplifier; no limiter configuration was sent',
                );
              const configurations = await Promise.allSettled(
                captured.captures.map((_, i) => perform(i, 1)),
              );
              if (configurations.some((r) => r.status === 'rejected'))
                throw new NativeLimiterError(
                  'Native limiter was not verified on every selected amplifier',
                );
            },
          ),
        ),
      );
      result.complete = true;
      publish({ phase: 'ready', revision: snapshot.revision + 1, error: undefined });
      return immutable(structuredClone(result));
    } catch (error) {
      result.partial = result.roles.some((r) => r.steps.some((s) => s.attempted));
      result.error = problem(error);
      publish({ phase: 'error', error: result.error });
      throw new NativeLimiterError(result.error, immutable(structuredClone(result)));
    } finally {
      const stored = immutable(structuredClone(result));
      receipts.set(reviewId, { owner: principal.owner, result: stored });
      flight = false;
      publish({ lastResult: stored });
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    status(context) {
      actor(context);
      return snapshot;
    },
    load,
    edit,
    review,
    apply,
    discard(id, context) {
      actor(context);
      guard();
      if (!pending || pending.review.id !== id)
        throw new NativeLimiterError('Native limiter review is unavailable');
      pending = undefined;
      publish();
    },
    refreshBindings,
    dispose() {
      disposed = true;
      pending = undefined;
      publish();
      listeners.clear();
    },
  };
}

/** Bounded agent view: raw source/configuration packets require the backup flow. */
export function nativeLimiterSnapshotPage(snapshot: Readonly<NativeLimiterSnapshot>) {
  return {
    phase: snapshot.phase,
    busy: snapshot.busy,
    revision: snapshot.revision,
    roles: Object.fromEntries(
      (['left', 'right'] as const).map((slot) => {
        const role = snapshot.roles[slot];
        return [slot, { ...role, ...(role.draft ? { draft: withoutSource(role.draft) } : {}) }];
      }),
    ),
    ...(snapshot.activeReview ? { activeReview: structuredClone(snapshot.activeReview) } : {}),
    ...(snapshot.lastResult ? { lastResult: structuredClone(snapshot.lastResult) } : {}),
    ...(snapshot.error ? { error: snapshot.error.slice(0, 1024) } : {}),
  };
}
