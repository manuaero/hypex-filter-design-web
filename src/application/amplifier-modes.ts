import type { Slot } from '../domain/model';
import type { PanelSession, ConfigurationBackup } from '../hardware/session';
import { AmplifierModesStepError } from '../hardware/session';
import {
  amplifierModesSummary,
  assertAmplifierModesBaseline,
  planAmplifierModes,
  validateAmplifierModesPatch,
  type AmplifierModes,
  type AmplifierModesCapture,
  type AmplifierModesIdentity,
  type AmplifierModesPatch,
  type AmplifierModesSummary,
} from '../hardware/amplifier-modes';
import type { PanelStatus } from '../hardware/codec';
import { decodeStatus, unhex } from '../hardware/codec';
import { decodeProtection } from '../hardware/protection';
import { parseExecutionPrincipal, type ToolExecutionContext } from './execution-context';

export type AmplifierModesTarget = Slot | 'both';
export interface AmplifierModesBinding {
  session: PanelSession;
  identity: AmplifierModesIdentity;
  status: PanelStatus;
}
export interface AmplifierModesRole {
  connected: boolean;
  identity?: AmplifierModesIdentity;
  current?: AmplifierModesSummary;
  draft?: AmplifierModes;
  preview?: AmplifierModesSummary;
  allowed?: AmplifierModes;
  changed?: boolean;
  error?: string;
}
export interface AmplifierModesReview {
  id: string;
  target: AmplifierModesTarget;
  revision: number;
  createdAt: number;
  roles: {
    slot: Slot;
    identity: AmplifierModesIdentity;
    patch: AmplifierModesPatch;
    before: AmplifierModesSummary;
    after: AmplifierModesSummary;
  }[];
}
export interface AmplifierModesResult {
  reviewId: string;
  target: AmplifierModesTarget;
  complete: boolean;
  partial: boolean;
  roles: {
    slot: Slot;
    identity: AmplifierModesIdentity;
    state: 'pending' | 'unchanged' | 'verified' | 'failed' | 'unconfirmed';
    attempted: boolean;
    backupId?: string;
    before: AmplifierModesSummary;
    planned: AmplifierModesSummary;
    confirmed?: AmplifierModesSummary;
    error?: string;
  }[];
  error?: string;
}
export interface AmplifierModesSnapshot {
  phase: 'idle' | 'ready' | 'busy' | 'error';
  busy: boolean;
  revision: number;
  roles: Record<Slot, AmplifierModesRole>;
  activeReview?: AmplifierModesReview;
  lastResult?: AmplifierModesResult;
  error?: string;
}
export interface AmplifierModesController {
  getSnapshot(): Readonly<AmplifierModesSnapshot>;
  subscribe(listener: () => void): () => void;
  status(context: ToolExecutionContext): Readonly<AmplifierModesSnapshot>;
  load(
    target: AmplifierModesTarget,
    context: ToolExecutionContext,
  ): Promise<Readonly<AmplifierModesSnapshot>>;
  edit(
    target: AmplifierModesTarget,
    context: ToolExecutionContext,
    input: { expectedRevision: number; patch: AmplifierModesPatch },
  ): Readonly<AmplifierModesSnapshot>;
  cancel(target: AmplifierModesTarget, context: ToolExecutionContext): void;
  review(
    target: AmplifierModesTarget,
    context: ToolExecutionContext,
    input: { expectedRevision: number },
  ): Promise<AmplifierModesReview>;
  apply(
    reviewId: string,
    context: ToolExecutionContext,
    input: { confirm: true },
  ): Promise<AmplifierModesResult>;
  discard(reviewId: string, context: ToolExecutionContext): void;
  refreshBindings(): void;
  dispose(): void;
}
export interface AmplifierModesControllerOptions {
  binding(slot: Slot): AmplifierModesBinding | undefined;
  operate<T>(label: string, work: () => Promise<T>): Promise<T>;
  backup?(session: PanelSession): Promise<ConfigurationBackup>;
  onStatus?(slot: Slot, session: PanelSession, status: PanelStatus): void;
  withLock?<T>(name: string, work: () => Promise<T>): Promise<T>;
  now?: () => number;
  id?: () => string;
}
export class AmplifierModesError extends Error {
  constructor(
    message: string,
    readonly result?: AmplifierModesResult,
  ) {
    super(message);
    this.name = 'AmplifierModesError';
  }
}
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const identity = (value: AmplifierModesIdentity): AmplifierModesIdentity => ({
  serial: value.serial,
  product: value.product,
  core: value.core,
  firmware: value.firmware,
});
const modes = (value: AmplifierModes): AmplifierModes => ({
  master: value.master,
  bridge: value.bridge,
  softClip: value.softClip,
});
const patchFor = (current: AmplifierModes, draft: AmplifierModes): AmplifierModesPatch =>
  Object.fromEntries(
    (['master', 'bridge', 'softClip'] as const)
      .filter((key) => current[key] !== draft[key])
      .map((key) => [key, draft[key]]),
  );
const targets = (target: AmplifierModesTarget): Slot[] => {
  if (!['left', 'right', 'both'].includes(target))
    throw new AmplifierModesError('Choose Left, Right or Both explicitly');
  return target === 'both' ? ['left', 'right'] : [target];
};
const message = (error: unknown) =>
  (error instanceof Error ? error.message : 'Amplifier configuration was not confirmed').slice(
    0,
    1024,
  );
const reserve = <T>(sessions: PanelSession[], work: () => Promise<T>) => {
  const ordered = [...sessions].sort((a, b) => a.lockOrder - b.lockOrder);
  const enter = (index: number): Promise<T> =>
    index === ordered.length ? work() : ordered[index].exclusive(() => enter(index + 1));
  return enter(0);
};
async function browserLock<T>(name: string, work: () => Promise<T>) {
  if (typeof navigator === 'undefined' || !navigator.locks)
    throw new AmplifierModesError('Configuration requires browser Web Locks');
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
    if (!lock) throw new AmplifierModesError('Another browser tab is configuring these amplifiers');
    return work();
  });
}

/** Mode drafts are shared across the human UI and authenticated agents. Safe
 * ordinary settings stay in the existing direct controls workflow. */
export function createAmplifierModesController(
  options: AmplifierModesControllerOptions,
): AmplifierModesController {
  type Capture = {
    slot: Slot;
    binding: AmplifierModesBinding;
    hardware: AmplifierModesCapture;
    patch: AmplifierModesPatch;
  };
  const listeners = new Set<() => void>(),
    known: Partial<Record<Slot, AmplifierModesBinding>> = {},
    baselines: Partial<Record<Slot, Uint8Array>> = {},
    receipts = new Map<string, { owner: string; result: AmplifierModesResult }>();
  let disposed = false,
    flight = false,
    owner: string | undefined,
    pending: { owner: string; review: AmplifierModesReview; captures: Capture[] } | undefined,
    snapshot: Readonly<AmplifierModesSnapshot> = freeze({
      phase: 'idle',
      busy: false,
      revision: 0,
      roles: { left: { connected: false }, right: { connected: false } },
    });
  const publish = (patch: Partial<AmplifierModesSnapshot> = {}) => {
    snapshot = freeze({ ...snapshot, ...patch, busy: flight, activeReview: pending?.review });
    for (const listener of listeners)
      try {
        listener();
      } catch {
        /* A view cannot interrupt device verification. */
      }
  };
  const actor = (context: ToolExecutionContext) => {
    const checked = parseExecutionPrincipal({ owner: context?.owner, scope: context?.scope });
    if (!/^workspace:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(checked.owner))
      throw new AmplifierModesError('Amplifier configuration requires trusted workspace admission');
    if (disposed) throw new AmplifierModesError('Amplifier configuration is disposed');
    if (owner && owner !== checked.owner)
      throw new AmplifierModesError('Configuration drafts belong to another workspace');
    owner ??= checked.owner;
    return checked;
  };
  const guard = () => {
    if (flight || disposed)
      throw new AmplifierModesError('Amplifier configuration is busy or disposed');
  };
  const checkRevision = (revision: number) => {
    if (!Number.isSafeInteger(revision) || revision !== snapshot.revision)
      throw new AmplifierModesError('Configuration draft changed; inspect its current revision');
  };
  const current = (capture: Pick<Capture, 'slot' | 'binding'>) => {
    const live = options.binding(capture.slot);
    if (
      disposed ||
      !live ||
      live.session !== capture.binding.session ||
      !same(identity(live.identity), identity(capture.binding.identity))
    )
      throw new AmplifierModesError(
        'The captured amplifier connection changed; its replacement was not targeted',
      );
  };
  const roleState = (
    binding: AmplifierModesBinding,
    draft?: AmplifierModes,
  ): AmplifierModesRole => {
    const summary = amplifierModesSummary(binding.status),
      next = draft ?? modes(summary),
      patch = patchFor(summary, next),
      access = decodeProtection(binding.status, binding.session.moduleType),
      allowed = {
        master: access.operations.masterSlave.allowed,
        bridge: access.operations.bridge.allowed,
        softClip: access.operations.softclipLimiter.allowed,
      };
    let preview: AmplifierModesSummary | undefined, error: string | undefined;
    try {
      preview = Object.keys(patch).length
        ? planAmplifierModes(binding.status, patch, binding.session.moduleType).summary
        : summary;
    } catch (e) {
      error = message(e);
    }
    return {
      connected: true,
      identity: identity(binding.identity),
      current: summary,
      draft: next,
      preview,
      allowed,
      changed: Object.keys(patch).length > 0,
      ...(error ? { error } : {}),
    };
  };
  const refreshBindings = () => {
    if (disposed) return;
    const roles = { ...snapshot.roles };
    let changed = false,
      invalid = false;
    for (const slot of ['left', 'right'] as const) {
      const supplied = options.binding(slot),
        prior = known[slot];
      if (!supplied) {
        if (prior || roles[slot].connected) {
          delete known[slot];
          delete baselines[slot];
          roles[slot] = { connected: false };
          changed = invalid = true;
        }
        continue;
      }
      const binding = { ...supplied, identity: identity(supplied.identity) },
        replaced =
          !prior || prior.session !== binding.session || !same(prior.identity, binding.identity);
      let draft = replaced ? undefined : roles[slot].draft;
      if (draft && baselines[slot]) {
        const patch = patchFor(amplifierModesSummary(decodeStatus(baselines[slot]!)), draft);
        if (Object.keys(patch).length)
          try {
            assertAmplifierModesBaseline(baselines[slot]!, binding.status.raw, patch);
          } catch {
            draft = undefined;
            invalid = true;
          }
      }
      const next = roleState(binding, draft);
      if (replaced || !same(next, roles[slot])) {
        roles[slot] = next;
        changed = true;
      }
      if (replaced) invalid = true;
      known[slot] = binding;
      baselines[slot] = binding.status.raw.slice();
    }
    if (changed) {
      if (invalid) pending = undefined;
      publish({
        roles,
        revision: snapshot.revision + 1,
        ...(invalid ? { lastResult: undefined } : {}),
      });
    }
  };
  const select = (target: AmplifierModesTarget) => {
    refreshBindings();
    const captures = targets(target).map((slot) => {
      const binding = known[slot];
      if (!binding) throw new AmplifierModesError(`Connect the ${slot} amplifier first`);
      return { slot, binding };
    });
    if (
      new Set(captures.map((c) => c.binding.session)).size !== captures.length ||
      new Set(captures.map((c) => c.binding.identity.serial)).size !== captures.length
    )
      throw new AmplifierModesError('Left and Right require distinct physical amplifiers');
    return captures;
  };
  const updateStatus = (slot: Slot, binding: AmplifierModesBinding, status: PanelStatus) => {
    current({ slot, binding });
    const fresh = { ...binding, status };
    known[slot] = fresh;
    baselines[slot] = status.raw.slice();
    publish({
      roles: { ...snapshot.roles, [slot]: roleState(fresh) },
      revision: snapshot.revision + 1,
    });
    try {
      options.onStatus?.(slot, binding.session, status);
    } catch {
      /* USB result is already verified; a view refresh cannot change its outcome. */
    }
  };
  const load: AmplifierModesController['load'] = async (target, context) => {
    actor(context);
    guard();
    context.signal?.throwIfAborted();
    const selected = select(target);
    flight = true;
    pending = undefined;
    publish({ phase: 'busy', error: undefined });
    try {
      const loaded = await options.operate('Reading amplifier configuration', () =>
        reserve(
          selected.map((c) => c.binding.session),
          async () => {
            const results = await Promise.allSettled(
              selected.map(async (c) => {
                current(c);
                const hardware = await c.binding.session.captureAmplifierModesInternal(
                  c.binding.identity,
                );
                current(c);
                return { ...c, hardware };
              }),
            );
            const rejected = results.find((r) => r.status === 'rejected');
            if (rejected?.status === 'rejected') throw rejected.reason;
            context.signal?.throwIfAborted();
            return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
          },
        ),
      );
      loaded.forEach((c) => current(c));
      loaded.forEach((c) => updateStatus(c.slot, c.binding, decodeStatus(c.hardware.status)));
      publish({ phase: 'ready' });
      return snapshot;
    } catch (e) {
      publish({ phase: 'error', error: message(e) });
      throw e;
    } finally {
      flight = false;
      publish();
    }
  };
  const review: AmplifierModesController['review'] = async (target, context, input) => {
    const principal = actor(context);
    guard();
    context.signal?.throwIfAborted();
    const selected = select(target);
    checkRevision(input.expectedRevision);
    const sources = selected.map((c) => {
      const state = snapshot.roles[c.slot],
        patch = patchFor(state.current!, state.draft!);
      return { ...c, patch, expected: baselines[c.slot]!.slice() };
    });
    if (!sources.some((c) => Object.keys(c.patch).length))
      throw new AmplifierModesError('There are no unapplied configuration changes');
    flight = true;
    pending = undefined;
    publish({ phase: 'busy', error: undefined });
    try {
      const captures = await options.operate('Reviewing amplifier configuration', () =>
        reserve(
          sources.map((c) => c.binding.session),
          async () => {
            const all = await Promise.allSettled(
              sources.map(async (c) => {
                current(c);
                const changed = Object.keys(c.patch).length > 0;
                const hardware = await c.binding.session.captureAmplifierModesInternal(
                  c.binding.identity,
                  changed ? c.patch : undefined,
                );
                current(c);
                if (changed) assertAmplifierModesBaseline(c.expected, hardware.status, c.patch);
                return { ...c, hardware };
              }),
            );
            const failure = all.find((r) => r.status === 'rejected');
            if (failure?.status === 'rejected') throw failure.reason;
            return all.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
          },
        ),
      );
      context.signal?.throwIfAborted();
      captures.forEach(current);
      checkRevision(input.expectedRevision);
      const captured: AmplifierModesReview = {
        id: (options.id ?? crypto.randomUUID.bind(crypto))(),
        target,
        revision: snapshot.revision,
        createdAt: (options.now ?? Date.now)(),
        roles: captures.map((c) => ({
          slot: c.slot,
          identity: identity(c.binding.identity),
          patch: c.patch,
          before: c.hardware.summary,
          after: Object.keys(c.patch).length
            ? planAmplifierModes(
                decodeStatus(c.hardware.status),
                c.patch,
                c.hardware.configuredModuleType,
              ).summary
            : c.hardware.summary,
        })),
      };
      pending = { owner: principal.owner, review: freeze(captured), captures };
      publish({ phase: 'ready' });
      return captured;
    } catch (e) {
      publish({ phase: 'error', error: message(e) });
      throw e;
    } finally {
      flight = false;
      publish();
    }
  };
  const apply: AmplifierModesController['apply'] = async (reviewId, context, confirmation) => {
    const principal = actor(context);
    guard();
    context.signal?.throwIfAborted();
    if (confirmation?.confirm !== true)
      throw new AmplifierModesError('Confirm the configuration action explicitly');
    const prior = receipts.get(reviewId);
    if (prior) {
      if (prior.owner !== principal.owner)
        throw new AmplifierModesError('Configuration receipt belongs to another workspace');
      if (!prior.result.complete)
        throw new AmplifierModesError(
          prior.result.error ?? 'Configuration was not confirmed',
          prior.result,
        );
      return prior.result;
    }
    const captured = pending;
    if (!captured || captured.owner !== principal.owner || captured.review.id !== reviewId)
      throw new AmplifierModesError('Configuration review is unavailable or consumed');
    pending = undefined;
    flight = true;
    const result: AmplifierModesResult = {
      reviewId,
      target: captured.review.target,
      complete: false,
      partial: false,
      roles: captured.review.roles.map((r) => ({
        slot: r.slot,
        identity: r.identity,
        state: Object.keys(r.patch).length ? 'pending' : 'unchanged',
        attempted: false,
        before: r.before,
        planned: r.after,
      })),
    };
    publish({ phase: 'busy', lastResult: undefined, error: undefined });
    let started = false;
    const fence = (capture: Capture) => {
      current(capture);
      if (!started) context.signal?.throwIfAborted();
    };
    const settle = async <T>(jobs: Promise<T>[]) => {
      const results = await Promise.allSettled(jobs);
      const failure = results.find((r) => r.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    };
    const checkRole = async <T>(capture: Capture, index: number, work: () => Promise<T>) => {
      try {
        return await work();
      } catch (error) {
        const row = result.roles[index];
        row.state = 'failed';
        row.error = `${capture.slot}: ${message(error)}`;
        throw new AmplifierModesError(row.error);
      }
    };
    try {
      await (options.withLock ?? browserLock)('fusion-studio-amplifier-modes', () =>
        options.operate('Applying amplifier configuration', () =>
          reserve(
            captured.captures.map((c) => c.binding.session),
            async () => {
              const ready = async (c: Capture, index: number) =>
                checkRole(c, index, async () => {
                  fence(c);
                  const changed = Object.keys(c.patch).length > 0;
                  const fresh = await c.binding.session.captureAmplifierModesInternal(
                    c.binding.identity,
                    changed ? c.patch : undefined,
                  );
                  fence(c);
                  if (changed)
                    assertAmplifierModesBaseline(c.hardware.status, fresh.status, c.patch);
                  return fresh;
                });
              await settle(captured.captures.map(ready));
              await settle(
                captured.captures.map(async (c, index) =>
                  checkRole(c, index, async () => {
                    if (!Object.keys(c.patch).length) return;
                    fence(c);
                    const backup = await (
                      options.backup ?? ((session) => session.backupConfigurationInternal())
                    )(c.binding.session);
                    fence(c);
                    if (
                      backup.serial !== c.binding.identity.serial ||
                      backup.product !== c.binding.identity.product ||
                      backup.firmware !== c.binding.identity.firmware ||
                      !/^05[0-9a-f]{126}$/i.test(backup.status_hex)
                    )
                      throw new AmplifierModesError(
                        'Configuration backup identity or status is invalid',
                      );
                    assertAmplifierModesBaseline(
                      c.hardware.status,
                      unhex(backup.status_hex),
                      c.patch,
                    );
                    result.roles[index].backupId = backup.id;
                  }),
                ),
              );
              await settle(captured.captures.map(ready));
              let remaining = captured.captures.filter((c) => Object.keys(c.patch).length).length;
              let release!: () => void, breakReadiness!: (error: unknown) => void;
              const readiness = new Promise<void>((resolve, reject) => {
                release = resolve;
                breakReadiness = reject;
              });
              // A failure may precede the first waiter. Every started participant
              // still settles before reservations are released.
              void readiness.catch(() => {});
              const writes = await Promise.allSettled(
                captured.captures.map(async (c, index) => {
                  const row = result.roles[index];
                  if (row.state === 'unchanged') return;
                  try {
                    const written = await c.binding.session.writeAmplifierModesInternal(
                      c.binding.identity,
                      c.hardware.status,
                      c.patch,
                      {
                        assertCurrent: () => fence(c),
                        afterReady: () => {
                          remaining--;
                          if (remaining === 0) release();
                          return readiness;
                        },
                        beforeExchange: () => captured.captures.forEach(fence),
                        onAttempt: () => {
                          started = true;
                          row.attempted = true;
                        },
                      },
                    );
                    row.state = 'verified';
                    row.confirmed = amplifierModesSummary(written.status);
                    updateStatus(c.slot, c.binding, written.status);
                  } catch (e) {
                    breakReadiness(e);
                    row.attempted =
                      e instanceof AmplifierModesStepError ? e.attempted : row.attempted;
                    row.state = row.attempted ? 'unconfirmed' : 'failed';
                    row.error = message(e);
                    throw e;
                  }
                }),
              );
              if (writes.some((r) => r.status === 'rejected'))
                throw new AmplifierModesError(
                  'Configuration was not verified on every selected amplifier',
                );
            },
          ),
        ),
      );
      result.complete = true;
      publish({ phase: 'ready' });
      return freeze(structuredClone(result));
    } catch (e) {
      result.error = message(e);
      result.partial = result.roles.some((r) => r.attempted);
      publish({ phase: 'error', error: result.error });
      throw new AmplifierModesError(result.error, freeze(structuredClone(result)));
    } finally {
      const stored = freeze(structuredClone(result));
      receipts.set(reviewId, { owner: principal.owner, result: stored });
      while (receipts.size > 32) receipts.delete(receipts.keys().next().value!);
      flight = false;
      publish({ lastResult: stored });
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status: (context) => {
      actor(context);
      return snapshot;
    },
    load,
    review,
    apply,
    edit(target, context, input) {
      actor(context);
      guard();
      const selected = select(target);
      checkRevision(input.expectedRevision);
      const patch = validateAmplifierModesPatch(input.patch),
        roles = { ...snapshot.roles };
      for (const { slot, binding } of selected) {
        const draft = { ...roles[slot].draft!, ...patch },
          next = roleState(binding, draft);
        if (Object.entries(patch).some(([key]) => !next.allowed?.[key as keyof AmplifierModes]))
          throw new AmplifierModesError(next.error ?? 'A selected mode is not currently permitted');
        roles[slot] = next;
      }
      pending = undefined;
      publish({
        roles,
        phase: 'ready',
        revision: snapshot.revision + 1,
        error: undefined,
        lastResult: undefined,
      });
      return snapshot;
    },
    cancel(target, context) {
      actor(context);
      guard();
      const selected = select(target),
        roles = { ...snapshot.roles };
      selected.forEach(({ slot, binding }) => {
        roles[slot] = roleState(binding);
      });
      pending = undefined;
      publish({ roles, revision: snapshot.revision + 1, error: undefined });
    },
    discard(id, context) {
      actor(context);
      guard();
      if (!pending || pending.review.id !== id)
        throw new AmplifierModesError('Configuration review is unavailable');
      pending = undefined;
      publish();
    },
    refreshBindings,
    dispose() {
      disposed = true;
      pending = undefined;
      receipts.clear();
      publish({
        roles: { left: { connected: false }, right: { connected: false } },
        lastResult: undefined,
      });
      listeners.clear();
    },
  };
}
