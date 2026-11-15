import type { Slot } from '../domain/model';
import type { PanelSession } from '../hardware/session';
import {
  preflightRotatingNoise,
  setRotatingNoise,
  getRotatingNoiseState,
  type NoiseIdentity,
  type NoiseResult,
} from '../hardware/noise';

export interface NoiseConnection {
  session: PanelSession;
  identity: NoiseIdentity;
}
export type NoiseTarget = Slot | 'both';
export interface NoiseResultSummary {
  identity: NoiseIdentity;
  requested: boolean;
  acknowledged: true;
  actualState: 'unavailable';
  statusRead: 'succeeded' | 'failed';
  statusError?: string;
}
export interface NoiseRoleLedger {
  slot: Slot;
  identity?: NoiseIdentity;
  preflight: 'not-run' | 'passed' | 'failed';
  /** Unconfirmed means the hardware setter was attempted; it is not proof that a report reached the amp. */
  write: 'not-sent' | 'acknowledged' | 'unconfirmed';
  stale?: boolean;
  result?: NoiseResultSummary;
  error?: string;
}
export interface NoiseControlResult {
  target: NoiseTarget;
  requested: boolean;
  complete: boolean;
  partial: boolean;
  roles: Partial<Record<Slot, NoiseRoleLedger>>;
}
export interface NoiseRoleState {
  connected: boolean;
  busy: boolean;
  phase: 'disconnected' | 'idle' | 'busy' | 'error';
  identity?: NoiseIdentity;
  requested: boolean | null;
  acknowledgement: 'none' | 'accepted' | 'unconfirmed';
  actualState: 'unavailable';
  lastOperation?: NoiseRoleLedger;
  error?: string;
}
export type NoiseControlSnapshot = Readonly<Record<Slot, NoiseRoleState>>;
export interface NoiseControlOptions {
  connections(): Partial<Record<Slot, NoiseConnection>>;
  operate<T>(label: string, work: () => Promise<T>): Promise<T>;
  preflight?: typeof preflightRotatingNoise;
  send?: typeof setRotatingNoise;
  getState?: typeof getRotatingNoiseState;
}
export interface NoiseController {
  getSnapshot(): NoiseControlSnapshot;
  subscribe(listener: () => void): () => void;
  refreshBindings(): void;
  set(target: NoiseTarget, enabled: boolean): Promise<NoiseControlResult>;
  /** Disconnect cleanup only; skips the outer operate wrapper and never retries a Stop. */
  stopOwned(slot: Slot): Promise<NoiseControlResult | undefined>;
  /** Detaches listeners and blocks new actions; sends no automatic command. */
  dispose(): void;
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
}
export class NoiseControlError extends Error {
  readonly result?: NoiseControlResult;
  constructor(message: string, result?: NoiseControlResult) {
    super(message);
    this.name = 'NoiseControlError';
    if (result) this.result = immutable(structuredClone(result));
  }
}
const slots = ['left', 'right'] as const;
const sameIdentity = (a: NoiseIdentity, b: NoiseIdentity) =>
  a.serial === b.serial &&
  a.product === b.product &&
  a.core === b.core &&
  a.firmware === b.firmware;
const sameConnection = (a: NoiseConnection | undefined, b: NoiseConnection | undefined) =>
  (!a && !b) || !!(a && b && a.session === b.session && sameIdentity(a.identity, b.identity));
function identity(value: NoiseIdentity): NoiseIdentity {
  if (
    !value ||
    !Number.isInteger(value.product) ||
    value.product < 0 ||
    value.product > 255 ||
    ![value.serial, value.core, value.firmware].every(
      (field) =>
        typeof field === 'string' &&
        field.length > 0 &&
        field.length <= 256 &&
        !/[\u0000-\u001f\u007f]/.test(field),
    )
  )
    throw new NoiseControlError('The amplifier identity is unavailable');
  return immutable({
    serial: value.serial,
    product: value.product,
    core: value.core,
    firmware: value.firmware,
  });
}
const unknown = (connected = false): NoiseRoleState => ({
  connected,
  busy: false,
  phase: connected ? 'idle' : 'disconnected',
  requested: null,
  acknowledgement: 'none',
  actualState: 'unavailable',
});

export function createNoiseController(options: NoiseControlOptions): NoiseController {
  const preflight = options.preflight ?? preflightRotatingNoise,
    send = options.send ?? setRotatingNoise,
    getState = options.getState ?? getRotatingNoiseState;
  const listeners = new Set<() => void>(),
    bindings: Partial<Record<Slot, NoiseConnection>> = {},
    owned: Partial<Record<Slot, NoiseConnection>> = {};
  const epochs: Record<Slot, number> = { left: 0, right: 0 },
    flights: Partial<Record<Slot, symbol>> = {};
  let disposed = false,
    snapshot: NoiseControlSnapshot = immutable({ left: unknown(), right: unknown() });
  const publish = (updates: Partial<Record<Slot, NoiseRoleState>>) => {
    snapshot = immutable({ ...snapshot, ...structuredClone(updates) });
    listeners.forEach((listener) => listener());
  };
  const refreshBindings = () => {
    if (disposed) return;
    const supplied = options.connections(),
      updates: Partial<Record<Slot, NoiseRoleState>> = {};
    for (const slot of slots) {
      const next = supplied[slot]
        ? { session: supplied[slot]!.session, identity: identity(supplied[slot]!.identity) }
        : undefined;
      if (!sameConnection(bindings[slot], next)) {
        bindings[slot] = next;
        epochs[slot]++;
        delete owned[slot];
        updates[slot] = {
          ...unknown(!!next),
          busy: !!flights[slot],
          phase: flights[slot] ? 'busy' : next ? 'idle' : 'disconnected',
          ...(next ? { identity: next.identity } : {}),
        };
      }
    }
    if (Object.keys(updates).length) publish(updates);
  };
  const current = (slot: Slot, binding: NoiseConnection, epoch: number) => {
    try {
      refreshBindings();
    } catch {
      return false;
    }
    return epochs[slot] === epoch && sameConnection(bindings[slot], binding);
  };
  const assertCurrent = (slot: Slot, binding: NoiseConnection, epoch: number) => {
    if (disposed || !current(slot, binding, epoch))
      throw new NoiseControlError(
        'The captured amplifier connection changed; no new command was sent to its replacement',
      );
  };
  const cache = (session: PanelSession) => {
    try {
      const state = getState(session);
      if (
        (state.requested === null || typeof state.requested === 'boolean') &&
        ['none', 'accepted', 'unconfirmed'].includes(state.acknowledgement)
      )
        return { requested: state.requested, acknowledgement: state.acknowledgement };
    } catch {}
    return { requested: null, acknowledgement: 'none' } as const;
  };
  async function execute(
    target: NoiseTarget,
    enabled: boolean,
    useOperate: boolean,
  ): Promise<NoiseControlResult> {
    if (!['left', 'right', 'both'].includes(target) || typeof enabled !== 'boolean')
      throw new NoiseControlError('Choose Left, Right or Both and an explicit noise state');
    const selected: readonly Slot[] = target === 'both' ? slots : [target];
    const result: NoiseControlResult = {
      target,
      requested: enabled,
      complete: false,
      partial: false,
      roles: {},
    };
    if (disposed) throw new NoiseControlError('Rotating-noise control is disposed', result);
    refreshBindings();
    const captures = selected.map((slot) => ({
      slot,
      binding: bindings[slot],
      epoch: epochs[slot],
    }));
    for (const { slot, binding } of captures)
      result.roles[slot] = {
        slot,
        ...(binding ? { identity: binding.identity } : {}),
        preflight: 'not-run',
        write: 'not-sent',
      };
    if (selected.some((slot) => !!flights[slot]))
      throw new NoiseControlError(
        'A noise operation is already running for a selected role',
        result,
      );
    if (captures.some(({ binding }) => !binding)) {
      for (const { slot, binding } of captures)
        if (!binding)
          Object.assign(result.roles[slot]!, {
            preflight: 'failed',
            error: 'The selected amplifier is not connected',
          });
      throw new NoiseControlError(
        'Connect every selected amplifier before changing rotating noise',
        result,
      );
    }
    const aliased = !!(
      bindings.left &&
      bindings.right &&
      (bindings.left.session === bindings.right.session ||
        bindings.left.identity.serial === bindings.right.identity.serial)
    );
    // Invalid role aliases block any Start and any paired command. A single
    // explicit Stop remains available so an invalid assignment cannot trap noise.
    if (aliased && (enabled || target === 'both'))
      throw new NoiseControlError(
        'Left and Right must be two independent amplifiers; use a single-role Stop if needed',
        result,
      );
    const token = Symbol('noise'),
      initial: Partial<Record<Slot, NoiseRoleState>> = {};
    for (const { slot } of captures) {
      flights[slot] = token;
      initial[slot] = { ...snapshot[slot], busy: true, phase: 'busy', error: undefined };
    }
    publish(initial);
    try {
      const work = async () => {
        const ready = await Promise.allSettled(
          captures.map(async ({ slot, binding, epoch }) => {
            try {
              assertCurrent(slot, binding!, epoch);
              const fresh = identity(await preflight(binding!.session));
              assertCurrent(slot, binding!, epoch);
              if (!sameIdentity(fresh, binding!.identity))
                throw new NoiseControlError('The amplifier identity changed during preflight');
              result.roles[slot]!.preflight = 'passed';
            } catch {
              Object.assign(result.roles[slot]!, {
                preflight: 'failed',
                stale: !current(slot, binding!, epoch),
                error: 'Fresh amplifier preflight did not confirm this captured connection',
              });
              throw new NoiseControlError('Noise preflight failed');
            }
          }),
        );
        if (ready.some((entry) => entry.status === 'rejected'))
          throw new NoiseControlError(
            'Every selected amplifier must pass preflight before any noise command',
            result,
          );
        // Group recheck occurs before the first request; individual checks and the
        // hardware expected identity also guard each later queued request.
        for (const { slot, binding, epoch } of captures) {
          try {
            assertCurrent(slot, binding!, epoch);
          } catch {
            Object.assign(result.roles[slot]!, {
              preflight: 'failed',
              stale: true,
              error: 'Connection changed before sending',
            });
            throw new NoiseControlError(
              'A selected connection changed before any noise command',
              result,
            );
          }
        }
        await Promise.all(
          captures.map(async ({ slot, binding, epoch }) => {
            const ledger = result.roles[slot]!;
            try {
              assertCurrent(slot, binding!, epoch);
              ledger.write = 'unconfirmed';
              const reply: NoiseResult = await send(binding!.session, enabled, binding!.identity);
              if (
                !sameIdentity(identity(reply.identity), binding!.identity) ||
                reply.requested !== enabled ||
                reply.acknowledged !== true ||
                reply.actualState !== 'unavailable'
              )
                throw new NoiseControlError('The noise acknowledgment did not match this request');
              ledger.write = 'acknowledged';
              ledger.result = {
                identity: identity(reply.identity),
                requested: reply.requested,
                acknowledged: true,
                actualState: 'unavailable',
                statusRead: reply.status ? 'succeeded' : 'failed',
                ...(reply.statusError
                  ? { statusError: String(reply.statusError).slice(0, 1024) }
                  : {}),
              };
              if (current(slot, binding!, epoch)) {
                if (enabled) owned[slot] = binding!;
                else delete owned[slot];
                publish({
                  [slot]: { ...snapshot[slot], requested: enabled, acknowledgement: 'accepted' },
                });
              } else ledger.stale = true;
            } catch {
              ledger.error =
                ledger.write === 'not-sent'
                  ? 'Connection changed before this request was attempted'
                  : 'The noise command was not confirmed; no retry or rollback was sent';
              ledger.stale = !current(slot, binding!, epoch);
              if (!ledger.stale && ledger.write !== 'not-sent') {
                const state = cache(binding!.session);
                if (state.requested === true && state.acknowledgement !== 'none')
                  owned[slot] = binding!;
                else if (state.requested === false && state.acknowledgement !== 'none')
                  delete owned[slot];
                publish({ [slot]: { ...snapshot[slot], ...state } });
              }
            }
          }),
        );
      };
      if (useOperate)
        await options.operate(
          enabled ? 'Starting rotating noise' : 'Stopping rotating noise',
          work,
        );
      else await work();
      const ledgers = Object.values(result.roles);
      result.complete = ledgers.every((entry) => entry.write === 'acknowledged' && !entry.stale);
      result.partial = !result.complete && ledgers.some((entry) => entry.write === 'acknowledged');
      if (!result.complete)
        throw new NoiseControlError(
          'Rotating-noise commands were not all confirmed. Inspect each role; no automatic retry or rollback was sent.',
          result,
        );
      return immutable(structuredClone(result));
    } catch (error) {
      result.complete = false;
      result.partial = Object.values(result.roles).some((entry) => entry.write === 'acknowledged');
      throw new NoiseControlError(
        error instanceof NoiseControlError
          ? error.message
          : 'Rotating-noise operation did not complete; no automatic retry was sent',
        result,
      );
    } finally {
      const updates: Partial<Record<Slot, NoiseRoleState>> = {};
      for (const { slot, binding, epoch } of captures) {
        if (flights[slot] === token) delete flights[slot];
        if (current(slot, binding!, epoch)) {
          const ledger = result.roles[slot]!;
          updates[slot] = {
            ...snapshot[slot],
            busy: false,
            phase: result.complete ? 'idle' : 'error',
            lastOperation: ledger,
            error: result.complete
              ? undefined
              : (ledger.error ?? 'The selected operation did not complete for every role'),
          };
        } else
          updates[slot] = {
            ...snapshot[slot],
            busy: !!flights[slot],
            phase: flights[slot] ? 'busy' : bindings[slot] ? 'idle' : 'disconnected',
          };
      }
      publish(updates);
    }
  }
  const controller: NoiseController = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (!disposed) listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refreshBindings,
    set: (target, enabled) => execute(target, enabled, true),
    async stopOwned(slot) {
      if (slot !== 'left' && slot !== 'right')
        throw new NoiseControlError('Choose one amplifier role');
      refreshBindings();
      if (disposed) throw new NoiseControlError('Rotating-noise control is disposed');
      if (!owned[slot] || !sameConnection(bindings[slot], owned[slot])) return undefined;
      const state = cache(bindings[slot]!.session);
      if (state.requested === false && state.acknowledgement !== 'none') {
        delete owned[slot];
        return undefined;
      }
      return execute(slot, false, false);
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
  refreshBindings();
  return controller;
}
