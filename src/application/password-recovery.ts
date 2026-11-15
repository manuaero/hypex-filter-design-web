import type { Slot } from '../domain/model';
import { validatePasswordTarget, type PasswordTarget } from '../hardware/password';
import type { PanelSession } from '../hardware/session';
import type { ProtectionReport } from '../hardware/protection';
import {
  assertRecoveryProtection,
  parseReceivedRecoveryCode,
  recoveryChallengeFromGuid,
  recoveryChallengeWord,
  RecoveryOperationError,
  type RecoveryOperationResult,
} from '../hardware/password-recovery';

export type PasswordRecoverySession = Pick<
  PanelSession,
  'protection' | 'installRecoveryChallenge' | 'submitRecoveryCode'
>;
export interface PasswordRecoveryBinding {
  session: PasswordRecoverySession;
  identity: PasswordTarget;
}
export interface RecoveryReview {
  id: string;
  slot: Slot;
  target: PasswordTarget;
  revision: number;
  source: 'new-challenge' | 'installed-challenge';
  uniqueKey?: string;
}
export interface RecoveryCodeReview {
  id: string;
  reviewId: string;
  revision: number;
  slot: Slot;
  target: PasswordTarget;
  canonicalCode: string;
}
export interface PasswordRecoveryRoleState {
  connected: boolean;
  busy: boolean;
  revision: number;
  target?: PasswordTarget;
  review?: RecoveryReview;
  codeReviewReady?: boolean;
  protection?: ProtectionReport;
  lastResult?: RecoveryOperationResult;
  error?: string;
}
export type PasswordRecoverySnapshot = Readonly<Record<Slot, PasswordRecoveryRoleState>>;
export interface RecoveryReviewInput {
  source: 'new-challenge' | 'installed-challenge';
  sourceConfirmed?: true;
}
export interface RecoveryReference {
  reviewId: string;
  revision: number;
}
export interface ConfirmRecoveryChallengeInput extends RecoveryReference {
  uniqueKey: string;
  confirm: true;
}
export interface ReviewRecoveryCodeInput extends RecoveryReference {
  code: string;
  source: 'hypex-support';
}
export interface SubmitRecoveryCodeInput extends RecoveryReference {
  codeReviewId: string;
  source: 'hypex-support';
  confirm: true;
}
export interface PasswordRecoveryController {
  getSnapshot(): PasswordRecoverySnapshot;
  subscribe(listener: () => void): () => void;
  refreshBindings(): void;
  review(slot: Slot, input: RecoveryReviewInput): Promise<RecoveryReview>;
  confirmChallenge(
    slot: Slot,
    input: ConfirmRecoveryChallengeInput,
  ): Promise<RecoveryOperationResult>;
  /** Explicit detached preview only; canonical code is never stored in the public snapshot. */
  reviewCode(slot: Slot, input: ReviewRecoveryCodeInput): Promise<RecoveryCodeReview>;
  discardCodeReview(slot: Slot): void;
  submitCode(slot: Slot, input: SubmitRecoveryCodeInput): Promise<RecoveryOperationResult>;
  clear(slot: Slot): void;
  dispose(): void;
}
export interface PasswordRecoveryOptions {
  binding(slot: Slot): PasswordRecoveryBinding | undefined;
  isRoleBusy?(slot: Slot): boolean;
  randomGuid?(): string;
}
export class PasswordRecoveryError extends Error {
  readonly result?: RecoveryOperationResult;
  constructor(
    message = 'Recovery action could not be confirmed. Review the captured target and operation ledger.',
    result?: RecoveryOperationResult,
  ) {
    super(message);
    this.name = 'PasswordRecoveryError';
    if (result) this.result = freeze(structuredClone(result));
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const sameTarget = (a: PasswordTarget, b: PasswordTarget) =>
  a.serial === b.serial &&
  a.product === b.product &&
  a.core === b.core &&
  a.firmware === b.firmware;
const captureTarget = (identity: PasswordTarget): PasswordTarget => {
  const { serial, product, core, firmware } = identity;
  const target = { serial, product, core, firmware };
  validatePasswordTarget(target);
  return target;
};
const sameBinding = (a?: PasswordRecoveryBinding, b?: PasswordRecoveryBinding) =>
  (!a && !b) || !!(a && b && a.session === b.session && sameTarget(a.identity, b.identity));
type Pending = {
  review: RecoveryReview;
  binding: PasswordRecoveryBinding;
  epoch: number;
  challengeAttempted: boolean;
  challengeAcknowledged: boolean;
  code?: { id: string; word: number };
};

/** In-memory, selected-device manual handoff. It never sends mail, derives a support code or retries a write. */
export function createPasswordRecoveryController(
  options: PasswordRecoveryOptions,
): PasswordRecoveryController {
  const listeners = new Set<() => void>();
  const bindings: Partial<Record<Slot, PasswordRecoveryBinding>> = {},
    pending: Partial<Record<Slot, Pending>> = {};
  const epochs = { left: 0, right: 0 },
    revisions = { left: 0, right: 0 },
    flights = { left: false, right: false };
  let disposed = false;
  let snapshot: PasswordRecoverySnapshot = freeze({
    left: { connected: false, busy: false, revision: 0 },
    right: { connected: false, busy: false, revision: 0 },
  });
  const publish = (slot: Slot, state: PasswordRecoveryRoleState) => {
    snapshot = freeze({ ...snapshot, [slot]: structuredClone(state) });
    listeners.forEach((fn) => fn());
  };
  const clean = (slot: Slot): PasswordRecoveryRoleState => ({
    connected: !!bindings[slot],
    busy: flights[slot],
    revision: revisions[slot],
    ...(bindings[slot] ? { target: bindings[slot]!.identity } : {}),
  });
  const checkSlot = (slot: Slot) => {
    if (slot !== 'left' && slot !== 'right')
      throw new PasswordRecoveryError('Choose one amplifier role');
  };
  const invalidate = (slot: Slot) => {
    epochs[slot]++;
    revisions[slot]++;
    delete pending[slot];
  };
  const refreshBindings = () => {
    if (disposed) return;
    for (const slot of ['left', 'right'] as const) {
      const supplied = options.binding(slot),
        next = supplied
          ? { session: supplied.session, identity: captureTarget(supplied.identity) }
          : undefined;
      if (!sameBinding(bindings[slot], next)) {
        bindings[slot] = next;
        invalidate(slot);
        publish(slot, clean(slot));
      }
    }
  };
  const assertCurrent = (slot: Slot, binding: PasswordRecoveryBinding, epoch: number) => {
    refreshBindings();
    if (disposed || epoch !== epochs[slot] || !sameBinding(bindings[slot], binding))
      throw new PasswordRecoveryError('Recovery review belongs to a stale amplifier connection');
  };
  const fresh = async (slot: Slot, binding: PasswordRecoveryBinding, epoch: number) => {
    assertCurrent(slot, binding, epoch);
    const { identity, ...protection } = await binding.session.protection();
    assertCurrent(slot, binding, epoch);
    if (!sameTarget(identity, binding.identity))
      throw new PasswordRecoveryError('The captured amplifier identity changed');
    try {
      assertRecoveryProtection(protection);
    } catch {
      throw new PasswordRecoveryError(
        'Recovery requires a locked, password-protected OEM-configured amplifier',
      );
    }
    return protection;
  };
  const reference = (slot: Slot, input: RecoveryReference) => {
    checkSlot(slot);
    refreshBindings();
    const item = pending[slot];
    if (
      !item ||
      !input ||
      input.reviewId !== item.review.id ||
      input.revision !== item.review.revision
    )
      throw new PasswordRecoveryError(
        'Recovery review is missing, replaced or belongs to another role',
      );
    assertCurrent(slot, item.binding, item.epoch);
    return item;
  };
  async function run<T>(
    slot: Slot,
    fn: (binding: PasswordRecoveryBinding, epoch: number) => Promise<T>,
  ): Promise<T> {
    checkSlot(slot);
    refreshBindings();
    if (disposed) throw new PasswordRecoveryError('Password recovery is disposed');
    if (flights[slot] || options.isRoleBusy?.(slot))
      throw new PasswordRecoveryError('Another authentication operation is running for this role');
    const binding = bindings[slot];
    if (!binding) throw new PasswordRecoveryError('Recovery is unavailable for this connection');
    const epoch = epochs[slot];
    flights[slot] = true;
    publish(slot, { ...snapshot[slot], busy: true, error: undefined });
    try {
      const value = await fn(binding, epoch);
      assertCurrent(slot, binding, epoch);
      return value;
    } catch (error) {
      const safe =
        error instanceof PasswordRecoveryError
          ? error
          : new PasswordRecoveryError(
              undefined,
              error instanceof RecoveryOperationError ? error.result : undefined,
            );
      if (!disposed && epochs[slot] === epoch && sameBinding(bindings[slot], binding))
        publish(slot, {
          ...snapshot[slot],
          error: safe.message,
          ...(safe.result
            ? {
                lastResult: safe.result,
                protection: safe.result.protection ?? snapshot[slot].protection,
              }
            : {}),
        });
      throw safe;
    } finally {
      flights[slot] = false;
      if (!disposed)
        publish(slot, epochs[slot] === epoch ? { ...snapshot[slot], busy: false } : clean(slot));
    }
  }
  const controller: PasswordRecoveryController = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    refreshBindings,
    review: async (slot, input) => {
      checkSlot(slot);
      if (
        !input ||
        !['new-challenge', 'installed-challenge'].includes(input.source) ||
        (input.source === 'installed-challenge' && input.sourceConfirmed !== true)
      )
        return Promise.reject(
          new PasswordRecoveryError(
            'Explicitly confirm the support request was made for this amplifier',
          ),
        );
      const captured = { ...input };
      return run(slot, async (binding, epoch) => {
        const protection = await fresh(slot, binding, epoch);
        const revision = ++revisions[slot];
        const review: RecoveryReview = freeze({
          id: crypto.randomUUID(),
          slot,
          target: { ...binding.identity },
          revision,
          source: captured.source,
          ...(captured.source === 'new-challenge'
            ? {
                uniqueKey: recoveryChallengeFromGuid(
                  (options.randomGuid ?? (() => crypto.randomUUID()))(),
                ),
              }
            : {}),
        });
        pending[slot] = {
          review,
          binding,
          epoch,
          challengeAttempted: false,
          challengeAcknowledged: captured.source === 'installed-challenge',
        };
        publish(slot, {
          ...snapshot[slot],
          revision,
          review,
          codeReviewReady: false,
          protection,
          lastResult: undefined,
          error: undefined,
        });
        return review;
      });
    },
    confirmChallenge: async (slot, input) => {
      const item = reference(slot, input);
      if (
        input.confirm !== true ||
        item.review.source !== 'new-challenge' ||
        input.uniqueKey !== item.review.uniqueKey ||
        item.challengeAttempted
      )
        return Promise.reject(
          new PasswordRecoveryError('Confirm the current unused challenge review exactly'),
        );
      return run(slot, async (binding, epoch) => {
        await fresh(slot, binding, epoch);
        assertCurrent(slot, binding, epoch);
        item.challengeAttempted = true;
        const result = await binding.session.installRecoveryChallenge(
          binding.identity,
          recoveryChallengeWord(item.review.uniqueKey!),
          () => assertCurrent(slot, binding, epoch),
        );
        try {
          assertCurrent(slot, binding, epoch);
        } catch {
          throw new PasswordRecoveryError(
            'Challenge result returned for a stale connection; inspect the captured target ledger.',
            result,
          );
        }
        item.challengeAcknowledged = result.mutation === 'acknowledged';
        publish(slot, { ...snapshot[slot], lastResult: result, protection: result.protection });
        return result;
      });
    },
    reviewCode: async (slot, input) => {
      const item = reference(slot, input);
      let word: number;
      try {
        word = parseReceivedRecoveryCode(input.code);
      } catch {
        return Promise.reject(
          new PasswordRecoveryError(
            'Received support code is invalid; review the first four hexadecimal characters',
          ),
        );
      }
      if (input.source !== 'hypex-support' || !item.challengeAcknowledged)
        return Promise.reject(
          new PasswordRecoveryError(
            'Confirm the challenge installation or the existing support request first',
          ),
        );
      return run(slot, async (binding, epoch) => {
        const protection = await fresh(slot, binding, epoch);
        const id = crypto.randomUUID();
        item.code = { id, word };
        publish(slot, { ...snapshot[slot], protection, codeReviewReady: true, error: undefined });
        return freeze({
          id,
          reviewId: item.review.id,
          revision: item.review.revision,
          slot,
          target: { ...binding.identity },
          canonicalCode: word.toString(16).padStart(4, '0').toUpperCase(),
        });
      });
    },
    submitCode: async (slot, input) => {
      const item = reference(slot, input);
      if (
        input.confirm !== true ||
        input.source !== 'hypex-support' ||
        !item.code ||
        input.codeReviewId !== item.code.id
      )
        return Promise.reject(
          new PasswordRecoveryError('Review and explicitly confirm this received support code'),
        );
      return run(slot, async (binding, epoch) => {
        await fresh(slot, binding, epoch);
        const code = item.code!;
        delete item.code;
        publish(slot, { ...snapshot[slot], codeReviewReady: false });
        const result = await binding.session.submitRecoveryCode(binding.identity, code.word, () =>
          assertCurrent(slot, binding, epoch),
        );
        try {
          assertCurrent(slot, binding, epoch);
        } catch {
          throw new PasswordRecoveryError(
            'Reset result returned for a stale connection; inspect the captured target ledger.',
            result,
          );
        }
        delete pending[slot];
        publish(slot, {
          ...snapshot[slot],
          review: undefined,
          codeReviewReady: false,
          lastResult: result,
          protection: result.protection,
        });
        return result;
      });
    },
    discardCodeReview: (slot) => {
      checkSlot(slot);
      if (disposed) return;
      refreshBindings();
      const item = pending[slot];
      if (item) delete item.code;
      publish(slot, { ...snapshot[slot], codeReviewReady: false });
    },
    clear: (slot) => {
      checkSlot(slot);
      if (disposed) return;
      refreshBindings();
      invalidate(slot);
      publish(slot, clean(slot));
    },
    dispose: () => {
      disposed = true;
      for (const slot of ['left', 'right'] as const) {
        invalidate(slot);
        bindings[slot] = undefined;
      }
      listeners.clear();
      snapshot = freeze({
        left: { connected: false, busy: false, revision: revisions.left },
        right: { connected: false, busy: false, revision: revisions.right },
      });
    },
  };
  refreshBindings();
  return controller;
}
