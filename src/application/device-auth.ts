import type { Slot } from '../domain/model';
import type { PanelSession } from '../hardware/session';
import type { ProtectionReport } from '../hardware/protection';
import {
  createPasswordRecoveryController,
  type PasswordRecoveryController,
} from './password-recovery';
import {
  encodePassword,
  validateRecoveryEmailInput,
  validatePasswordChangeInput,
  type CredentialInput,
} from '../domain/credential-encoding';
export type { CredentialInput } from '../domain/credential-encoding';
import {
  PasswordOperationError,
  validatePasswordTarget,
  type PasswordTarget,
  type PasswordOperationResult,
  type OemMaskProposal,
} from '../hardware/password';

export type DeviceAuthSession = Pick<
  PanelSession,
  | 'protection'
  | 'verifyPassword'
  | 'changePassword'
  | 'readRecoveryEmail'
  | 'setRecoveryEmail'
  | 'proposeOemMask'
  | 'setOemMask'
> &
  Partial<Pick<PanelSession, 'installRecoveryChallenge' | 'submitRecoveryCode'>>;
export interface DeviceAuthBinding {
  session: DeviceAuthSession;
  identity: PasswordTarget;
}
export type DeviceAuthOperation =
  'status' | 'unlock' | 'password-change' | 'email-read' | 'email-set' | 'oem-propose' | 'oem-save';
export type DeviceAuthResult =
  | PasswordOperationResult
  | Awaited<ReturnType<PanelSession['setOemMask']>>
  | {
      operation: 'oem-save';
      target: PasswordTarget;
      previousMask: number;
      requestedMask: number;
      write: 'unconfirmed';
    };
export interface DeviceAuthProposal extends OemMaskProposal {
  id: string;
  slot: Slot;
  target: PasswordTarget;
}
export interface DeviceAuthRoleState {
  phase: 'disconnected' | 'idle' | 'busy' | 'error';
  connected: boolean;
  busy: boolean;
  target?: PasswordTarget;
  operation?: DeviceAuthOperation;
  protection?: ProtectionReport;
  lastResult?: DeviceAuthResult;
  proposal?: DeviceAuthProposal;
  error?: string;
}
export type DeviceAuthSnapshot = Readonly<Record<Slot, DeviceAuthRoleState>>;
export interface DeviceAuthChange {
  current?: CredentialInput;
  next: CredentialInput;
  confirm: CredentialInput;
  email: CredentialInput;
}
export interface DeviceAuthControllerOptions {
  binding(slot: Slot): DeviceAuthBinding | undefined;
}
export interface DeviceAuthController {
  readonly recovery?: PasswordRecoveryController;
  getSnapshot(): DeviceAuthSnapshot;
  subscribe(listener: () => void): () => void;
  refreshBindings(): void;
  status(slot: Slot, refresh?: boolean): Promise<DeviceAuthRoleState>;
  unlock(slot: Slot, input: CredentialInput): Promise<PasswordOperationResult>;
  change(slot: Slot, input: DeviceAuthChange): Promise<PasswordOperationResult>;
  /** Explicit, detached bytes only. Email is never retained in the snapshot. */
  readEmail(slot: Slot): Promise<Uint8Array>;
  writeEmail(slot: Slot, input: CredentialInput): Promise<PasswordOperationResult>;
  proposeOem(slot: Slot, mask: number): Promise<DeviceAuthProposal>;
  discardOemProposal(slot: Slot): void;
  saveOem(slot: Slot, proposalId: string): Promise<Awaited<ReturnType<PanelSession['setOemMask']>>>;
  clear(slot: Slot): void;
  dispose(): void;
}

/** All messages/results are bounded and deliberately omit raw causes or supplied input. */
export class DeviceAuthOperationError extends Error {
  readonly result?: DeviceAuthResult;
  constructor(message: string, result?: DeviceAuthResult) {
    super(message);
    this.name = 'DeviceAuthOperationError';
    if (result) this.result = immutable(structuredClone(result));
  }
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
}
function targetOf(binding: DeviceAuthBinding): PasswordTarget {
  const { serial, product, core, firmware } = binding.identity;
  const target = { serial, product, core, firmware };
  validatePasswordTarget(target);
  return immutable(target);
}
const equalTarget = (a: PasswordTarget, b: PasswordTarget) =>
  a.serial === b.serial &&
  a.product === b.product &&
  a.core === b.core &&
  a.firmware === b.firmware;
const sameBinding = (a: DeviceAuthBinding | undefined, b: DeviceAuthBinding | undefined) =>
  (!a && !b) || !!(a && b && a.session === b.session && equalTarget(a.identity, b.identity));
const checkSlot = (slot: Slot) => {
  if (slot !== 'left' && slot !== 'right')
    throw new DeviceAuthOperationError('Choose one amplifier role');
};
function safeFailure(operation: DeviceAuthOperation, error: unknown, oem?: DeviceAuthResult) {
  if (error instanceof DeviceAuthOperationError) return error;
  const result = error instanceof PasswordOperationError ? error.result : oem;
  return new DeviceAuthOperationError(
    operation === 'oem-save'
      ? 'OEM permission save was not confirmed. Read fresh protection status before another proposal.'
      : `${operation} did not complete. Inspect fresh protection status and the operation ledger before retrying.`,
    result,
  );
}

export function createDeviceAuthController(
  options: DeviceAuthControllerOptions,
): DeviceAuthController {
  const listeners = new Set<() => void>();
  const connected = {} as Partial<Record<Slot, DeviceAuthBinding>>;
  const epochs: Record<Slot, number> = { left: 0, right: 0 };
  const flights: Record<Slot, boolean> = { left: false, right: false };
  const proposals = new Map<
    string,
    { slot: Slot; binding: DeviceAuthBinding; epoch: number; proposal: DeviceAuthProposal }
  >();
  let disposed = false;
  let recovery: PasswordRecoveryController | undefined;
  let snapshot: DeviceAuthSnapshot = immutable({
    left: { phase: 'disconnected', connected: false, busy: false },
    right: { phase: 'disconnected', connected: false, busy: false },
  });
  const publish = (slot: Slot, next: DeviceAuthRoleState) => {
    snapshot = immutable({ ...snapshot, [slot]: structuredClone(next) });
    listeners.forEach((listener) => listener());
  };
  const invalidateProposals = (slot: Slot) => {
    for (const [id, item] of proposals) if (item.slot === slot) proposals.delete(id);
  };
  const cleanState = (slot: Slot): DeviceAuthRoleState => ({
    phase: flights[slot] ? 'busy' : connected[slot] ? 'idle' : 'disconnected',
    connected: !!connected[slot],
    busy: flights[slot],
    ...(connected[slot] ? { target: targetOf(connected[slot]!) } : {}),
  });
  const refreshBindings = () => {
    if (disposed) return;
    for (const slot of ['left', 'right'] as const) {
      const supplied = options.binding(slot);
      const next = supplied
        ? { session: supplied.session, identity: targetOf(supplied) }
        : undefined;
      if (!sameBinding(connected[slot], next)) {
        connected[slot] = next;
        epochs[slot]++;
        invalidateProposals(slot);
        publish(slot, cleanState(slot));
      }
    }
    recovery?.refreshBindings();
  };
  const assertCurrent = (slot: Slot, binding: DeviceAuthBinding, epoch: number) => {
    refreshBindings();
    if (disposed || epochs[slot] !== epoch || !sameBinding(connected[slot], binding))
      throw new DeviceAuthOperationError(
        'The captured amplifier operation is stale. Read status for the current connection.',
      );
  };
  const report = async (slot: Slot, binding: DeviceAuthBinding, epoch: number) => {
    assertCurrent(slot, binding, epoch);
    const { identity, ...protection } = await binding.session.protection();
    assertCurrent(slot, binding, epoch);
    if (!equalTarget(identity, binding.identity))
      throw new DeviceAuthOperationError(
        'The captured amplifier identity changed. Read status again.',
      );
    return protection;
  };
  async function run<T>(
    slot: Slot,
    operation: DeviceAuthOperation,
    fn: (
      binding: DeviceAuthBinding,
      epoch: number,
    ) => Promise<{
      value: T;
      protection?: ProtectionReport;
      result?: DeviceAuthResult;
      proposal?: DeviceAuthProposal;
    }>,
    failureResult?: DeviceAuthResult,
  ): Promise<T> {
    checkSlot(slot);
    if (disposed) throw new DeviceAuthOperationError('Device authentication is disposed');
    refreshBindings();
    if (flights[slot] || recovery?.getSnapshot()[slot].busy)
      throw new DeviceAuthOperationError(
        'An authentication operation is already running for this role',
      );
    const binding = connected[slot];
    if (!binding) throw new DeviceAuthOperationError('The selected amplifier is not connected');
    const epoch = epochs[slot];
    flights[slot] = true;
    if (operation !== 'status') recovery?.clear(slot);
    if (!['status', 'oem-save'].includes(operation)) invalidateProposals(slot);
    publish(slot, {
      ...snapshot[slot],
      phase: 'busy',
      busy: true,
      operation,
      error: undefined,
      ...(!['status', 'oem-save'].includes(operation) ? { proposal: undefined } : {}),
    });
    let outcome: Awaited<ReturnType<typeof fn>> | undefined;
    try {
      outcome = await fn(binding, epoch);
      assertCurrent(slot, binding, epoch);
      publish(slot, {
        ...snapshot[slot],
        phase: 'idle',
        busy: false,
        operation,
        error: undefined,
        ...(outcome.protection ? { protection: outcome.protection } : {}),
        ...(outcome.result ? { lastResult: outcome.result } : {}),
        ...(outcome.proposal ? { proposal: outcome.proposal } : {}),
      });
      return outcome.value;
    } catch (error) {
      if (outcome?.value instanceof Uint8Array) outcome.value.fill(0);
      const safe = safeFailure(operation, error, failureResult);
      if (!disposed && epochs[slot] === epoch && sameBinding(connected[slot], binding))
        publish(slot, {
          ...snapshot[slot],
          phase: 'error',
          busy: false,
          operation,
          error: safe.message,
          ...(safe.result ? { lastResult: safe.result } : {}),
        });
      throw safe;
    } finally {
      flights[slot] = false;
      if (!disposed && epochs[slot] !== epoch) publish(slot, cleanState(slot));
    }
  }
  const encoded = (fn: () => Uint8Array) => {
    try {
      return fn();
    } catch {
      throw new DeviceAuthOperationError('Credential input or explicit encoding is invalid');
    }
  };
  const afterCredential = async (
    slot: Slot,
    binding: DeviceAuthBinding,
    epoch: number,
    result: PasswordOperationResult,
  ) => {
    try {
      return { value: result, result, protection: await report(slot, binding, epoch) };
    } catch {
      // Preserve confirmed/unknown writes even if the additional fresh read fails.
      throw new PasswordOperationError(
        'Credential operation finished but fresh protection could not be read',
        result,
      );
    }
  };
  recovery = createPasswordRecoveryController({
    binding: (slot) => {
      const binding = options.binding(slot);
      if (!binding?.session.installRecoveryChallenge || !binding.session.submitRecoveryCode)
        return undefined;
      return {
        identity: binding.identity,
        session: binding.session as Required<
          Pick<DeviceAuthSession, 'protection' | 'installRecoveryChallenge' | 'submitRecoveryCode'>
        >,
      };
    },
    isRoleBusy: (slot) => flights[slot],
  });
  const unsubscribeRecovery = recovery.subscribe(() => {
    if (disposed) return;
    for (const slot of ['left', 'right'] as const) {
      const fresh = recovery!.getSnapshot()[slot],
        current = snapshot[slot].protection;
      if (
        !fresh.protection ||
        !fresh.target ||
        !connected[slot] ||
        !equalTarget(fresh.target, connected[slot]!.identity)
      )
        continue;
      if (
        !current ||
        current.passwordProtected !== fresh.protection.passwordProtected ||
        current.passwordMatched !== fresh.protection.passwordMatched ||
        current.rawMask !== fresh.protection.rawMask ||
        current.moduleType !== fresh.protection.moduleType
      )
        publish(slot, { ...snapshot[slot], protection: fresh.protection });
    }
  });
  const controller: DeviceAuthController = {
    recovery,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refreshBindings,
    status: async (slot, refresh = true) => {
      checkSlot(slot);
      refreshBindings();
      if (disposed) throw new DeviceAuthOperationError('Device authentication is disposed');
      if (!connected[slot])
        throw new DeviceAuthOperationError('The selected amplifier is not connected');
      if (!refresh) return snapshot[slot];
      return run(slot, 'status', async (binding, epoch) => {
        const protection = await report(slot, binding, epoch);
        return {
          value: immutable({ ...snapshot[slot], phase: 'idle', busy: false, protection }),
          protection,
        };
      });
    },
    unlock: async (slot, input) => {
      const bytes = encoded(() => encodePassword(input));
      try {
        return await run(slot, 'unlock', async (binding, epoch) => {
          const result = await binding.session.verifyPassword(binding.identity, bytes);
          return afterCredential(slot, binding, epoch, result);
        });
      } finally {
        bytes.fill(0);
      }
    },
    change: async (slot, input) => {
      // Snapshot caller-owned strings/encodings before the first asynchronous read.
      const captured = structuredClone(input);
      return run(slot, 'password-change', async (binding, epoch) => {
        const protection = await report(slot, binding, epoch);
        let prepared: ReturnType<typeof validatePasswordChangeInput>;
        try {
          prepared = validatePasswordChangeInput({
            oldPassword: captured.current,
            newPassword: captured.next,
            retypePassword: captured.confirm,
            email: captured.email,
            protected: protection.passwordProtected,
          });
        } catch {
          throw new DeviceAuthOperationError(
            'Password change fields, retyped confirmation or recovery email are invalid',
          );
        }
        try {
          assertCurrent(slot, binding, epoch);
          const result = await binding.session.changePassword(binding.identity, prepared);
          return await afterCredential(slot, binding, epoch, result);
        } finally {
          prepared.oldPassword?.fill(0);
          prepared.newPassword.fill(0);
          prepared.email.fill(0);
        }
      });
    },
    readEmail: (slot) =>
      run(slot, 'email-read', async (binding, epoch) => {
        const bytes = await binding.session.readRecoveryEmail(binding.identity);
        try {
          assertCurrent(slot, binding, epoch);
          if (!(bytes instanceof Uint8Array) || bytes.length > 56)
            throw new DeviceAuthOperationError('Recovery email response is invalid');
          return { value: bytes.slice() };
        } finally {
          bytes.fill(0);
        }
      }),
    writeEmail: async (slot, input) => {
      const bytes = encoded(() => validateRecoveryEmailInput(input));
      try {
        return await run(slot, 'email-set', async (binding, epoch) => {
          const result = await binding.session.setRecoveryEmail(binding.identity, bytes);
          return afterCredential(slot, binding, epoch, result);
        });
      } finally {
        bytes.fill(0);
      }
    },
    proposeOem: (slot, mask) =>
      run(slot, 'oem-propose', async (binding, epoch) => {
        const native = await binding.session.proposeOemMask(binding.identity, mask);
        assertCurrent(slot, binding, epoch);
        const proposal = immutable({
          ...native,
          target: targetOf(binding),
          slot,
          id: crypto.randomUUID(),
        });
        proposals.set(proposal.id, { slot, binding, epoch, proposal });
        return { value: proposal, proposal };
      }),
    discardOemProposal: (slot) => {
      checkSlot(slot);
      if (disposed) return;
      refreshBindings();
      invalidateProposals(slot);
      const { proposal: discarded, ...state } = snapshot[slot];
      void discarded;
      publish(slot, state);
    },
    saveOem: async (slot, id) => {
      checkSlot(slot);
      refreshBindings();
      const pending = proposals.get(id);
      if (
        !pending ||
        pending.slot !== slot ||
        pending.epoch !== epochs[slot] ||
        !sameBinding(pending.binding, connected[slot])
      )
        throw new DeviceAuthOperationError(
          'OEM proposal is missing, consumed or belongs to another connection',
        );
      // A busy refusal must not consume an otherwise valid preview.
      if (flights[slot] || recovery?.getSnapshot()[slot].busy)
        throw new DeviceAuthOperationError(
          'An authentication operation is already running for this role',
        );
      proposals.delete(id);
      publish(slot, { ...snapshot[slot], proposal: undefined });
      const p = pending.proposal;
      return run(
        slot,
        'oem-save',
        async (binding, epoch) => {
          const result = await binding.session.setOemMask(
            binding.identity,
            p.requestedMask,
            p.previousMask,
          );
          try {
            assertCurrent(slot, binding, epoch);
          } catch {
            throw new DeviceAuthOperationError(
              'OEM save returned for a stale connection. Inspect the captured target result.',
              result,
            );
          }
          return { value: result, result, protection: result.protection };
        },
        {
          operation: 'oem-save',
          target: p.target,
          requestedMask: p.requestedMask,
          previousMask: p.previousMask,
          write: 'unconfirmed',
        },
      );
    },
    clear: (slot) => {
      checkSlot(slot);
      if (disposed) return;
      refreshBindings();
      epochs[slot]++;
      recovery?.clear(slot);
      invalidateProposals(slot);
      publish(slot, cleanState(slot));
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribeRecovery();
      recovery?.dispose();
      epochs.left++;
      epochs.right++;
      proposals.clear();
      listeners.clear();
      snapshot = immutable({
        left: { phase: 'disconnected', connected: false, busy: false },
        right: { phase: 'disconnected', connected: false, busy: false },
      });
    },
  };
  refreshBindings();
  return controller;
}
