import { digest } from './checksum';
import { decodeStatusFlags } from './status-flags';
import {
  assertAmplifierModesBaseline,
  planAmplifierModes,
  amplifierModesSummary,
  validateAmplifierModesPatch,
  type AmplifierModesCapture,
  type AmplifierModesIdentity,
  type AmplifierModesPatch,
} from './amplifier-modes';
import { dspPowerOffAvailability } from './power-availability';
export { digest } from './checksum';
import { coordinatedUpload } from './coordinator';
import { prepareFirInternal, programFirInternal, writeFirNameInternal, type FirPlan } from './fir';
import { type Channel, type Preset, type Filter, newFilter, emptyFir, uid } from '../domain/model';
import { compileSector } from '../domain/dsp';
import {
  packet,
  addr,
  presetBase,
  decodeStatus,
  control,
  hasDisplayControls,
  hex,
  unhex,
  erase,
  pagePackets,
  allowedSector,
  encodeEq,
  decodeEq,
  type Controls,
  type PanelStatus,
} from './codec';
import { AsyncQueue, type Transport } from './transport';
import {
  assertRecoveryProtection,
  createRecoveryResult,
  installRecoveryChallengePacket,
  submitRecoveryCodePacket,
  validateRecoveryWord,
  RecoveryOperationError,
  type RecoveryOperationResult,
} from './password-recovery';
import {
  decodeLimiter,
  encodeLimiter,
  decodePower,
  decodeHardwareOverview,
  decodeNativeProductNames,
  type HardwareOverview,
  type LimiterChannel,
} from './device-settings';
import { saveConfigurationBackup } from './storage';
import {
  captureNativeSaveTemplate,
  nativeSaveFilenameAddresses,
  nativeSaveStatusMask,
  type NativeSaveSnapshot,
} from './native-save-capture';
import {
  verifyDeviceDefaultsStep,
  deviceDefaultsStatusMask,
  type DeviceDefaultsSnapshot as DefaultsHardwareSnapshot,
  type DeviceDefaultsStep,
} from './device-defaults';
import {
  assertOperationAllowed,
  decodeProtection,
  requiredControlOperations,
  runtimeProtectionOperation,
  type ProtectionOperation,
} from './protection';
import {
  PasswordOperationError,
  PasswordProtocolError,
  verifyPasswordPacket,
  setPasswordPacket,
  readRecoveryEmailPacket,
  writeRecoveryEmailPacket,
  parsePasswordAck,
  parseRecoveryEmail,
  prepareOemMask,
  validatePasswordBytes,
  validateRecoveryEmailRoundTrip,
  validatePasswordTarget,
  type PasswordTarget,
  type PasswordOperationResult,
  type PasswordStepName,
  type PasswordStepState,
  type OemMaskProposal,
} from './password';

export interface Identity {
  serial: string;
  product: number;
  core: string;
  firmware: string;
  name: string;
  configuration: string;
}
export interface Backup {
  format: 'fusion-studio-backup';
  version: 1;
  id: string;
  utc: string;
  serial: string;
  product: number;
  firmware: string;
  preset: number;
  address: number;
  configuration_hex: string;
  status_hex: string;
  sector_hex: string;
  sha256: string;
  name: string;
}
export interface ConfigurationBackup {
  format: 'fusion-studio-configuration-backup';
  version: 1;
  id: string;
  utc: string;
  serial: string;
  product: number;
  firmware: string;
  configuration_hex: string;
  status_hex: string;
  sha256: string;
}
export type SaveBackup = (backup: Backup) => Promise<void>;
export type Progress = (percent: number, message: string) => void;
export class DeviceDefaultsStepError extends Error {
  constructor(
    message: string,
    readonly attempted: boolean,
  ) {
    super(message);
    this.name = 'DeviceDefaultsStepError';
  }
}
export class NativeLimiterStepError extends Error {
  constructor(
    message: string,
    readonly attempted: boolean,
  ) {
    super(message);
    this.name = 'NativeLimiterStepError';
  }
}
export class AmplifierModesStepError extends Error {
  constructor(
    message: string,
    readonly attempted: boolean,
  ) {
    super(message);
    this.name = 'AmplifierModesStepError';
  }
}
export interface CloneTargetSnapshot {
  identity: Pick<Identity, 'serial' | 'product' | 'core' | 'firmware'>;
  status: Uint8Array;
  configuration: Uint8Array;
  deviceConfiguration: Uint8Array;
  dspName: Uint8Array;
  serial: Uint8Array;
  flash: { address: number; bytes: Uint8Array }[];
  filenames: { address: number; bytes: Uint8Array }[];
}
export class DeviceCloneStepError extends Error {
  constructor(
    message: string,
    readonly attempted: boolean,
  ) {
    super(message);
    this.name = 'DeviceCloneStepError';
  }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let sessionSequence = 0;
export class PanelSession {
  readonly lockOrder = ++sessionSequence;
  private operations = new AsyncQueue();
  identity?: Identity;
  lastStatus?: PanelStatus;
  busy = false;
  private configuredModuleType?: number;
  /** Cached only from the last successfully identified device configuration. */
  get moduleType(): number | undefined {
    return this.configuredModuleType;
  }
  private cloneMutation?: {
    beforeRequest(request: Uint8Array): Promise<void>;
    beforeExchange(request: Uint8Array): void;
    afterExchange?(request: Uint8Array, reply: Uint8Array): Promise<void>;
    attempted: boolean;
  };
  constructor(
    readonly transport: Transport,
    readonly saveBackup: SaveBackup,
  ) {}
  exclusive<T>(fn: () => Promise<T>) {
    return this.operations.run(async () => {
      this.busy = true;
      try {
        return await fn();
      } finally {
        this.busy = false;
      }
    });
  }
  async identify() {
    return this.exclusive(() => this.identifyInternal());
  }
  async identifyInternal() {
    const c = await this.transport.exchange(packet(6, 1));
    if (c.length !== 64 || c[0] !== 6 || c[1] !== 22 || c[2] !== 5 || c[3] !== 1)
      throw new Error('This release requires the recovered FA503 / DSP3-213 v5 protocol');
    const amplifier = await this.transport.exchange(packet(0x66, 0));
    if (
      amplifier.length !== 64 ||
      amplifier[0] !== 0x66 ||
      amplifier[10] !== 5 ||
      amplifier[12] !== 22
    )
      throw new Error('This USB interface is not the verified FA503 amplifier configuration');
    this.configuredModuleType = amplifier[11];
    const name = await this.transport.exchange(packet(3, 8));
    const id = await this.readMemoryInternal(0x100, 32, 0);
    const serial = new TextDecoder('latin1').decode(id).replace(/\0.*$/s, '').trim();
    if (!serial || !/^[\x20-\x7e]+$/.test(serial))
      throw new Error('Cannot establish a stable amplifier identity');
    const v = new DataView(c.buffer, c.byteOffset, c.byteLength);
    return (this.identity = {
      serial,
      product: c[1],
      core: `${c[2]}.${c[3]}`,
      firmware: `${v.getUint16(15, true)}.${v.getUint16(17, true)}`,
      name: new TextDecoder('latin1').decode(name.slice(2)).replace(/\0.*$/s, ''),
      configuration: hex(c),
    });
  }
  async status() {
    return this.exclusive(() => this.statusInternal());
  }
  async statusInternal() {
    return (this.lastStatus = decodeStatus(await this.transport.exchange(packet(5, 1))));
  }
  async setControls(patch: Controls) {
    const proposal = structuredClone(patch);
    return this.exclusive(() => this.controlsInternal(proposal));
  }
  /** Read-only validation; final writes recheck to detect changed live capability/locks. */
  async preflightControls(patch: Controls): Promise<void> {
    const proposal = structuredClone(patch);
    return this.exclusive(async () => {
      await this.prepareControlsInternal(proposal);
    });
  }
  async protection() {
    return this.exclusive(async () => {
      const identity = await this.identifyInternal();
      return {
        ...decodeProtection(await this.statusInternal(), this.configuredModuleType),
        identity: { ...identity },
      };
    });
  }
  private capturePasswordTarget(target: PasswordTarget): PasswordTarget {
    if (!target) throw new Error('A captured FA503 / DSP5.1 identity is required');
    const captured = {
      serial: target.serial,
      product: target.product,
      core: target.core,
      firmware: target.firmware,
    };
    validatePasswordTarget(captured);
    return captured;
  }
  private async checkPasswordIdentityInternal(target: PasswordTarget) {
    let current: Identity;
    try {
      current = await this.identifyInternal();
    } catch {
      throw new PasswordProtocolError(
        'mismatch',
        'Captured amplifier identity could not be confirmed',
      );
    }
    if (
      current.serial !== target.serial ||
      current.product !== target.product ||
      current.core !== target.core ||
      current.firmware !== target.firmware
    )
      throw new PasswordProtocolError('mismatch', 'Captured amplifier identity changed');
  }
  private rememberPasswordStatus(result: PasswordOperationResult, status: PanelStatus) {
    const p = decodeProtection(status, this.configuredModuleType);
    result.protection = {
      passwordProtected: p.passwordProtected,
      passwordMatched: p.passwordMatched,
      locked: p.locked,
      rawMask: p.rawMask,
    };
  }
  private newPasswordResult(
    operation: PasswordOperationResult['operation'],
    target: PasswordTarget,
  ): PasswordOperationResult {
    return {
      operation,
      target,
      steps: [],
      passwordWrite: 'not-attempted',
      emailWrite: 'not-attempted',
    };
  }
  private async passwordStepInternal<T>(
    result: PasswordOperationResult,
    name: PasswordStepName,
    fn: (step: { name: PasswordStepName; state: PasswordStepState }) => Promise<T>,
  ): Promise<T> {
    const step: { name: PasswordStepName; state: PasswordStepState } = { name, state: 'pending' };
    result.steps.push(step);
    try {
      const value = await fn(step);
      if (step.state === 'pending') step.state = 'confirmed';
      return value;
    } catch (error) {
      step.state =
        error instanceof PasswordProtocolError && error.kind === 'rejected'
          ? 'rejected'
          : 'unconfirmed';
      // Never forward an arbitrary transport message/cause: it could include a request dump.
      throw new PasswordOperationError(
        `Credential operation ${name} ${step.state}; inspect the confirmed steps before taking further action`,
        result,
      );
    }
  }
  private async passwordAckInternal(request: Uint8Array) {
    let reply: Uint8Array | undefined;
    try {
      reply = await this.transport.exchange(request);
      return parsePasswordAck(reply);
    } finally {
      request.fill(0);
      reply?.fill(0);
    }
  }
  private async recoveryEmailInternal(target: PasswordTarget) {
    await this.checkPasswordIdentityInternal(target);
    let reply: Uint8Array | undefined;
    try {
      reply = await this.transport.exchange(readRecoveryEmailPacket());
      return parseRecoveryEmail(reply);
    } finally {
      reply?.fill(0);
    }
  }
  private async verifyPasswordInternal(
    target: PasswordTarget,
    bytes: Uint8Array,
    result: PasswordOperationResult,
    name: PasswordStepName,
  ) {
    await this.passwordStepInternal(result, name, async (step) => {
      await this.checkPasswordIdentityInternal(target);
      const accepted = await this.passwordAckInternal(verifyPasswordPacket(bytes));
      if (!accepted) {
        try {
          this.rememberPasswordStatus(result, await this.statusInternal());
        } catch {
          /* Rejection remains known even if status is unavailable. */
        }
        throw new PasswordProtocolError('rejected', 'Password verification was rejected');
      }
      step.state = 'acknowledged';
      const status = await this.statusInternal();
      this.rememberPasswordStatus(result, status);
      const flags = decodeStatusFlags(status.raw);
      if (!flags.passwordMatched || flags.passwordProtected !== bytes.length > 0)
        throw new PasswordProtocolError(
          'mismatch',
          'Password verification status was not confirmed',
        );
      step.state = 'confirmed';
    });
  }
  private async finishPasswordInternal(
    target: PasswordTarget,
    result: PasswordOperationResult,
    passwordLength?: number,
  ) {
    await this.passwordStepInternal(result, 'final-status', async () => {
      await this.checkPasswordIdentityInternal(target);
      const status = await this.statusInternal();
      this.rememberPasswordStatus(result, status);
      const flags = decodeStatusFlags(status.raw);
      if (
        passwordLength !== undefined &&
        (!flags.passwordMatched || flags.passwordProtected !== passwordLength > 0)
      )
        throw new PasswordProtocolError('mismatch', 'Final password status was not confirmed');
    });
  }
  async verifyPassword(
    target: PasswordTarget,
    credential: Uint8Array,
  ): Promise<PasswordOperationResult> {
    const captured = this.capturePasswordTarget(target);
    validatePasswordBytes(credential);
    const bytes = credential.slice();
    try {
      return await this.exclusive(async () => {
        const result = this.newPasswordResult('verify', captured);
        await this.verifyPasswordInternal(captured, bytes, result, 'verification');
        await this.finishPasswordInternal(captured, result, bytes.length);
        return result;
      });
    } finally {
      bytes.fill(0);
    }
  }
  /** Selected-panel byte workflow. No credential enters a backup, error result or generic history. */
  async changePassword(
    target: PasswordTarget,
    input: { oldPassword?: Uint8Array; newPassword: Uint8Array; email?: Uint8Array },
  ): Promise<PasswordOperationResult> {
    const captured = this.capturePasswordTarget(target);
    validatePasswordBytes(input.newPassword);
    if (input.oldPassword !== undefined) validatePasswordBytes(input.oldPassword);
    if (input.email !== undefined) validateRecoveryEmailRoundTrip(input.email);
    const old = input.oldPassword?.slice(),
      next = input.newPassword.slice(),
      email = input.email?.slice();
    try {
      return await this.exclusive(async () => {
        const result = this.newPasswordResult(next.length ? 'change' : 'clear', captured);
        await this.passwordStepInternal(result, 'identity', async () => {
          await this.checkPasswordIdentityInternal(captured);
          const status = await this.statusInternal();
          this.rememberPasswordStatus(result, status);
          if (decodeStatusFlags(status.raw).passwordProtected && !old?.length)
            throw new PasswordProtocolError(
              'rejected',
              'A current credential is required for a protected panel',
            );
        });
        if (old?.length)
          await this.verifyPasswordInternal(captured, old, result, 'old-password-verification');
        await this.passwordStepInternal(result, 'password-write', async (step) => {
          await this.checkPasswordIdentityInternal(captured);
          const status = await this.statusInternal();
          this.rememberPasswordStatus(result, status);
          if (status.locked || (decodeStatusFlags(status.raw).passwordProtected && !old?.length))
            throw new PasswordProtocolError('rejected', 'Protection changed before password write');
          result.passwordWrite = 'unconfirmed';
          if (!(await this.passwordAckInternal(setPasswordPacket(next))))
            throw new PasswordProtocolError('rejected', 'Password write was rejected');
          result.passwordWrite = 'acknowledged';
          step.state = 'acknowledged';
          this.rememberPasswordStatus(result, await this.statusInternal());
        });
        await this.verifyPasswordInternal(captured, next, result, 'new-password-verification');
        result.passwordWrite = 'confirmed';
        result.steps.find((step) => step.name === 'password-write')!.state = 'confirmed';
        if (email !== undefined) await this.writeRecoveryEmailInternal(captured, email, result);
        await this.finishPasswordInternal(captured, result, next.length);
        return result;
      });
    } finally {
      old?.fill(0);
      next.fill(0);
      email?.fill(0);
    }
  }
  async readRecoveryEmail(target: PasswordTarget): Promise<Uint8Array> {
    const captured = this.capturePasswordTarget(target);
    return this.exclusive(async () => {
      let owned: Uint8Array | undefined;
      // Fixed messages avoid returning raw transport data through a read failure too.
      try {
        owned = await this.recoveryEmailInternal(captured);
        await this.checkPasswordIdentityInternal(captured);
        await this.statusInternal();
        return owned;
      } catch {
        owned?.fill(0);
        throw new Error('Recovery email could not be confirmed for the captured amplifier');
      }
    });
  }
  /** Manual support recovery only. ACK does not establish challenge persistence or support delivery. */
  async installRecoveryChallenge(
    target: PasswordTarget,
    word: number,
    beforeRequest?: () => void,
  ): Promise<RecoveryOperationResult> {
    return this.recoveryOperation(target, word, 'challenge-install', beforeRequest);
  }
  async submitRecoveryCode(
    target: PasswordTarget,
    word: number,
    beforeRequest?: () => void,
  ): Promise<RecoveryOperationResult> {
    return this.recoveryOperation(target, word, 'password-reset', beforeRequest);
  }
  private async recoveryOperation(
    target: PasswordTarget,
    word: number,
    operation: RecoveryOperationResult['operation'],
    beforeRequest?: () => void,
  ): Promise<RecoveryOperationResult> {
    const captured = this.capturePasswordTarget(target);
    validateRecoveryWord(word);
    return this.exclusive(async () => {
      const result = createRecoveryResult(operation, captured);
      const step = async (
        name: RecoveryOperationResult['steps'][number]['name'],
        fn: (item: RecoveryOperationResult['steps'][number]) => Promise<void>,
      ) => {
        const item: RecoveryOperationResult['steps'][number] = { name, state: 'pending' };
        result.steps.push(item);
        try {
          await fn(item);
          if (item.state === 'pending') item.state = 'confirmed';
        } catch (error) {
          item.state =
            error instanceof PasswordProtocolError && error.kind === 'rejected'
              ? 'rejected'
              : 'unconfirmed';
          throw new RecoveryOperationError(result);
        }
      };
      await step('identity', async () => {
        beforeRequest?.();
        await this.checkPasswordIdentityInternal(captured);
      });
      await step('preflight', async () => {
        result.protection = decodeProtection(
          await this.statusInternal(),
          this.configuredModuleType,
        );
        assertRecoveryProtection(result.protection);
      });
      await step('request', async (item) => {
        // No awaited work between the application epoch fence and the actual request.
        beforeRequest?.();
        result.mutation = 'unconfirmed';
        const accepted = await this.passwordAckInternal(
          operation === 'challenge-install'
            ? installRecoveryChallengePacket(word)
            : submitRecoveryCodePacket(word),
        );
        if (!accepted) {
          result.mutation = 'rejected';
          throw new PasswordProtocolError('rejected', 'Recovery request was rejected');
        }
        result.mutation = 'acknowledged';
        item.state = 'acknowledged';
      });
      await step('final-status', async () => {
        await this.checkPasswordIdentityInternal(captured);
        result.protection = decodeProtection(
          await this.statusInternal(),
          this.configuredModuleType,
        );
        if (operation === 'password-reset') {
          if (result.protection.passwordProtected)
            throw new PasswordProtocolError(
              'mismatch',
              'Password-cleared status was not confirmed',
            );
          result.mutation = 'confirmed';
          result.persistence = 'password-cleared';
          result.steps.find((item) => item.name === 'request')!.state = 'confirmed';
        }
      });
      return result;
    });
  }
  private async writeRecoveryEmailInternal(
    target: PasswordTarget,
    bytes: Uint8Array,
    result: PasswordOperationResult,
  ) {
    await this.passwordStepInternal(result, 'email-write', async (step) => {
      await this.checkPasswordIdentityInternal(target);
      const status = await this.statusInternal();
      this.rememberPasswordStatus(result, status);
      if (status.locked)
        throw new PasswordProtocolError('rejected', 'Recovery email requires an unlocked panel');
      result.emailWrite = 'unconfirmed';
      if (!(await this.passwordAckInternal(writeRecoveryEmailPacket(bytes))))
        throw new PasswordProtocolError('rejected', 'Recovery email write was rejected');
      result.emailWrite = 'acknowledged';
      step.state = 'acknowledged';
      this.rememberPasswordStatus(result, await this.statusInternal());
    });
    await this.passwordStepInternal(result, 'email-readback', async () => {
      const actual = await this.recoveryEmailInternal(target);
      try {
        if (actual.length !== bytes.length || actual.some((byte, i) => byte !== bytes[i]))
          throw new PasswordProtocolError('mismatch', 'Recovery email readback mismatch');
      } finally {
        actual.fill(0);
      }
      result.emailWrite = 'confirmed';
      result.steps.find((step) => step.name === 'email-write')!.state = 'confirmed';
    });
  }
  async setRecoveryEmail(
    target: PasswordTarget,
    email: Uint8Array,
  ): Promise<PasswordOperationResult> {
    const captured = this.capturePasswordTarget(target);
    validateRecoveryEmailRoundTrip(email);
    const bytes = email.slice();
    try {
      return await this.exclusive(async () => {
        const result = this.newPasswordResult('email', captured);
        await this.writeRecoveryEmailInternal(captured, bytes, result);
        await this.finishPasswordInternal(captured, result);
        return result;
      });
    } finally {
      bytes.fill(0);
    }
  }
  async proposeOemMask(
    target: PasswordTarget,
    requestedMask: number,
  ): Promise<OemMaskProposal & { target: PasswordTarget }> {
    const captured = this.capturePasswordTarget(target);
    return this.exclusive(async () => {
      await this.checkPasswordIdentityInternal(captured);
      let status: PanelStatus;
      try {
        status = await this.statusInternal();
      } catch {
        throw new Error('OEM mask proposal could not be read for the captured amplifier');
      }
      const { packet: _packet, ...proposal } = prepareOemMask(
        status,
        requestedMask,
        this.configuredModuleType!,
      );
      return { ...proposal, target: captured };
    });
  }
  async setOemMask(target: PasswordTarget, requestedMask: number, expectedPreviousMask: number) {
    const captured = this.capturePasswordTarget(target);
    if (
      !Number.isInteger(expectedPreviousMask) ||
      expectedPreviousMask < 0 ||
      expectedPreviousMask > 65535
    )
      throw new Error('A captured previous OEM mask is required');
    return this.exclusive(async () => {
      await this.checkPasswordIdentityInternal(captured);
      let previous: PanelStatus;
      try {
        previous = await this.statusInternal();
      } catch {
        throw new Error('OEM mask preflight could not be read for the captured amplifier');
      }
      const { packet: request, ...proposal } = prepareOemMask(
        previous,
        requestedMask,
        this.configuredModuleType!,
      );
      if (proposal.previousMask !== expectedPreviousMask)
        throw new Error('OEM mask changed since the proposal was captured');
      let status: PanelStatus;
      try {
        status = decodeStatus(await this.transport.exchange(request));
        for (const i of [
          2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 25, 27, 28,
          29, 30, 31, 35, 36,
        ]) {
          const mask = i === 36 ? 0xfb : 255;
          if ((status.raw[i] & mask) !== (request[i] & mask)) throw new Error('readback');
        }
        await this.checkPasswordIdentityInternal(captured);
        status = await this.statusInternal();
        if ((status.raw[24] | (status.raw[25] << 8)) !== proposal.targetMask)
          throw new Error('readback');
        this.lastStatus = status;
      } catch {
        throw new Error(
          'OEM mask write is unconfirmed; inspect fresh protection state before another write',
        );
      }
      return {
        ...proposal,
        target: captured,
        protection: decodeProtection(status, this.configuredModuleType),
      };
    });
  }
  async preflightOperation(operation: ProtectionOperation): Promise<void> {
    return this.exclusive(async () => {
      await this.assertOperationsInternal(operation);
    });
  }
  /** Internal callers already own the session reservation. Recheck after identity reads. */
  async assertOperationsInternal(...operations: ProtectionOperation[]): Promise<PanelStatus> {
    let status = await this.statusInternal();
    if (status.locked && operations.some((operation) => !runtimeProtectionOperation(operation))) {
      await this.identifyInternal();
      status = await this.statusInternal();
    }
    for (const operation of operations)
      assertOperationAllowed(status, operation, this.configuredModuleType);
    return status;
  }
  private async prepareControlsInternal(patch: Controls) {
    // Capture the same proposal for wire construction and checks across awaits.
    patch = structuredClone(patch);
    if (
      hasDisplayControls(patch) ||
      requiredControlOperations(patch).some((operation) => !runtimeProtectionOperation(operation))
    ) {
      const identity = await this.identifyInternal();
      if (
        (patch.oledMaximumBrightness !== undefined || patch.oledDimmedBrightness !== undefined) &&
        !(unhex(identity.configuration)[4] & 0x10)
      )
        throw new Error('The amplifier does not advertise OLED brightness controls');
    }
    // Identity/accessory reads may take several exchanges. Preserve the latest ordinary
    // volume/mute/preset/settings snapshot immediately before reconstructing the 05 packet.
    return control(await this.statusInternal(), patch, this.configuredModuleType);
  }
  async controlsInternal(patch: Controls) {
    const target = await this.prepareControlsInternal(patch);
    const reply = await this.mutatingExchangeInternal(target);
    return this.verifyControlsReplyInternal(target, reply);
  }
  private verifyControlsReplyInternal(target: Uint8Array, reply: Uint8Array) {
    const status = decodeStatus(reply);
    this.lastStatus = status;
    for (const i of [
      2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 25, 27, 28, 29,
      30, 31, 35, 36,
    ]) {
      const mask = i === 36 ? 0xfb : 255;
      if ((status.raw[i] & mask) !== (target[i] & mask))
        throw new Error(`Control readback mismatch at byte ${i}`);
    }
    return status;
  }
  /** Read-only capture. Caller owns this session's exclusive reservation. */
  async captureAmplifierModesInternal(
    expected: AmplifierModesIdentity,
    patch?: AmplifierModesPatch,
  ): Promise<AmplifierModesCapture> {
    const target = this.capturePasswordTarget(expected),
      proposal = patch === undefined ? undefined : validateAmplifierModesPatch(patch),
      identity = await this.identifyInternal();
    if (
      identity.serial !== target.serial ||
      identity.product !== target.product ||
      identity.core !== target.core ||
      identity.firmware !== target.firmware
    )
      throw new Error('Captured amplifier modes identity or firmware changed');
    const status = await this.statusInternal();
    if (proposal) planAmplifierModes(status, proposal, this.configuredModuleType);
    return {
      identity: target,
      status: status.raw.slice(),
      configuration: unhex(identity.configuration),
      configuredModuleType: this.configuredModuleType!,
      summary: amplifierModesSummary(status),
    };
  }
  /** One reviewed common-05 write; no added mute, DSP restart, retry or rollback.
   * Caller holds the exclusive reservation and durably verifies every backup. */
  async writeAmplifierModesInternal(
    expected: AmplifierModesIdentity,
    expectedStatus: Uint8Array,
    patch: AmplifierModesPatch,
    hooks: {
      assertCurrent?: () => void;
      readyToExchange?: () => Promise<void>;
      /** Pair coordinator barrier after each target's final fresh capture/plan. */
      afterReady?: () => Promise<void>;
      beforeExchange?: () => void;
      onAttempt?: () => void;
    } = {},
  ): Promise<{ status: PanelStatus }> {
    let attempted = false;
    try {
      const target = this.capturePasswordTarget(expected),
        baseline = expectedStatus.slice(),
        proposal = validateAmplifierModesPatch(patch);
      if (this.cloneMutation)
        throw new Error('Reviewed amplifier modes cannot run inside a Clone phase');
      assertAmplifierModesBaseline(baseline, baseline, proposal);
      hooks.assertCurrent?.();
      // Persist controller intent before the final fresh identity/status reads.
      await hooks.readyToExchange?.();
      hooks.assertCurrent?.();
      const current = await this.captureAmplifierModesInternal(target, proposal);
      assertAmplifierModesBaseline(baseline, current.status, proposal);
      const request = planAmplifierModes(
        decodeStatus(current.status),
        proposal,
        current.configuredModuleType,
      ).request;
      // All paired targets can finish final permission/baseline checks before
      // any setter. No further USB reads occur after this common barrier.
      await hooks.afterReady?.();
      hooks.assertCurrent?.();
      hooks.beforeExchange?.();
      hooks.onAttempt?.();
      attempted = true;
      const reply = await this.transport.exchange(request.slice());
      return { status: this.verifyControlsReplyInternal(request, reply) };
    } catch (failure) {
      throw new AmplifierModesStepError(
        failure instanceof Error
          ? failure.message.slice(0, 1024)
          : 'Amplifier modes were not confirmed',
        attempted,
      );
    }
  }
  async readMemoryInternal(address: number, length: number, selector = 1) {
    const result = new Uint8Array(length);
    for (let o = 0; o < length; o += 32) {
      const n = Math.min(32, length - o),
        r = await this.transport.exchange(packet(0x65, n, ...addr(address + o), selector));
      if (r[1] !== n) throw new Error('Unexpected flash read length');
      result.set(r.slice(2, 2 + n), o);
    }
    return result;
  }
  async backup(preset: number) {
    return this.exclusive(() => this.backupInternal(preset, presetBase(preset)));
  }
  async backupInternal(preset: number, address: number): Promise<Backup> {
    if (![presetBase(preset), presetBase(preset) + 0x3000].includes(address))
      throw new Error('Unsupported backup address');
    const identity = await this.identifyInternal(),
      status = await this.statusInternal(),
      sector = await this.readMemoryInternal(address, 4096);
    const backup: Backup = {
      format: 'fusion-studio-backup',
      version: 1,
      id: uid(),
      utc: new Date().toISOString(),
      serial: identity.serial,
      product: identity.product,
      firmware: identity.firmware,
      preset,
      address,
      configuration_hex: identity.configuration,
      status_hex: hex(status.raw),
      sector_hex: hex(sector),
      sha256: await digest(sector),
      name: identity.name,
    };
    await this.saveBackup(backup);
    return backup;
  }
  async ack(payload: Uint8Array, timeout?: number) {
    const reply = await this.mutatingExchangeInternal(payload, timeout);
    if (reply[1] !== 0) throw new Error(`Flash operation rejected (${reply[1]})`);
  }
  async writeSectorInternal(address: number, target: Uint8Array, progress: Progress = () => {}) {
    if (target.length !== 4096 || !allowedSector(address)) throw new Error('Invalid target sector');
    const state = await this.assertOperationsInternal(
      address >= 0x25000 ? 'equalizer' : 'uploadFilters',
    );
    if (!state.muted) throw new Error('Panel must be muted before programming');
    await this.ack(erase(address), 4000);
    await sleep(300);
    for (let offset = 0; offset < 4096; offset += 256) {
      const page = target.slice(offset, offset + 256);
      for (const request of pagePackets(address + offset, page)) await this.ack(request);
      await sleep(20);
      const actual = await this.readMemoryInternal(address + offset, 256);
      if (hex(actual) !== hex(page))
        throw new Error(
          `Readback mismatch at 0x${(address + offset).toString(16)}; keep the amplifier muted`,
        );
      progress(((offset + 256) / 4096) * 95, `Verified page ${offset / 256 + 1}/16`);
    }
    const readback = await this.readMemoryInternal(address, 4096);
    if ((await digest(readback)) !== (await digest(target)))
      throw new Error('Full-sector checksum mismatch');
  }
  async setNameInternal(name: string) {
    await this.assertOperationsInternal('uploadFilters');
    const bytes = Uint8Array.from(name.slice(0, 30), (s) => {
      const n = s.charCodeAt(0);
      return n <= 255 ? n : 63;
    });
    await this.mutatingExchangeInternal(packet(3, 0, ...bytes, 0));
  }
  /** A Clone scope observes actual setters, never reads or phase entry. Internal
   * callers must hold this session's exclusive reservation for its whole scope. */
  async withCloneMutationScopeInternal<T>(
    hooks: {
      beforeRequest(request: Uint8Array): Promise<void>;
      beforeExchange(request: Uint8Array): void;
      afterExchange?(request: Uint8Array, reply: Uint8Array): Promise<void>;
    },
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.cloneMutation) throw new Error('Nested Clone mutation scopes are not allowed');
    const scope = { ...hooks, attempted: false };
    this.cloneMutation = scope;
    try {
      return await work();
    } catch (failure) {
      throw new DeviceCloneStepError(
        failure instanceof Error ? failure.message.slice(0, 1024) : 'Clone phase was not verified',
        scope.attempted,
      );
    } finally {
      this.cloneMutation = undefined;
    }
  }
  private async mutatingExchangeInternal(request: Uint8Array, timeout?: number) {
    const copy = request.slice(),
      scope = this.cloneMutation;
    if (scope) {
      if (
        copy.length !== 64 ||
        !(
          (copy[0] === 5 && copy[1] === 0) ||
          (copy[0] === 0x66 && copy[1] === 1) ||
          (copy[0] === 3 && copy[1] === 0) ||
          (copy[0] === 0x64 && copy[1] <= 4)
        )
      )
        throw new Error('Unsupported setter in Clone scope');
      await scope.beforeRequest(copy.slice());
      if (this.cloneMutation !== scope)
        throw new Error('Clone mutation scope ended before exchange');
      // No await after the final identity/cancellation fence and actual-attempt
      // marker: an exception before this call is a blocked phase, not a write.
      scope.beforeExchange(copy.slice());
      scope.attempted = true;
    }
    const reply = await this.transport.exchange(copy, timeout);
    await scope?.afterExchange?.(copy.slice(), reply.slice());
    return reply;
  }
  /** Commercial FA503 Clone is deliberately browser-unlocked-only: the native
   * protected Clone entry policy has not been established. No OEM string writes. */
  async captureCloneInternal(
    expected: Pick<Identity, 'serial' | 'product' | 'core' | 'firmware'>,
    full = true,
  ): Promise<CloneTargetSnapshot> {
    return this.captureCloneSnapshotInternal(expected, full, true);
  }
  private async captureCloneSnapshotInternal(
    expected: Pick<Identity, 'serial' | 'product' | 'core' | 'firmware'>,
    full: boolean,
    requireUnlocked: boolean,
  ): Promise<CloneTargetSnapshot> {
    const base = await this.captureNativeLimiterInternal(expected, false);
    if (requireUnlocked && decodeStatus(base.status).locked)
      throw new Error('Clone requires an unlocked amplifier');
    if (base.deviceConfiguration[11] !== 9)
      throw new Error('Clone currently supports the commercial FA503 module9 only');
    const dspName = await this.transport.exchange(packet(3, 8)),
      serial = await this.readMemoryInternal(0x100, 32, 0);
    if (dspName.length !== 64 || dspName[0] !== 3)
      throw new Error('Unexpected Clone DSP filename response');
    const flash: CloneTargetSnapshot['flash'] = [],
      filenames: CloneTargetSnapshot['filenames'] = [];
    if (full) {
      for (let address = 0x10000; address <= 0x27000; address += 4096)
        flash.push({ address, bytes: await this.readMemoryInternal(address, 4096) });
      for (let p = 0; p < 3; p++)
        for (let n = 0; n < 4; n++) {
          const address = 0x200 + p * 0x80 + n * 32;
          filenames.push({ address, bytes: await this.readMemoryInternal(address, 32, 0) });
        }
    }
    return { ...base, dspName: dspName.slice(), serial, flash, filenames };
  }
  /** Read-only source/Reload snapshot. Raw before-images do not reconstruct or
   * replace IIR/FIR graph designs. Inspecting a protected source grants no write access. */
  async captureCloneTemplateInternal(
    expected: Pick<Identity, 'serial' | 'product' | 'core' | 'firmware'>,
  ) {
    const snapshot = await this.captureCloneSnapshotInternal(expected, true, false),
      mixerConfiguration = await this.transport.exchange(packet(0x67, 0)),
      productStrings = {
        hypexName: await this.readMemoryInternal(0x120, 32, 0),
        oemName: await this.readMemoryInternal(0x140, 32, 0),
      },
      final = await this.captureCloneSnapshotInternal(expected, false, false),
      mask = deviceDefaultsStatusMask();
    if (
      mixerConfiguration.length !== 64 ||
      mixerConfiguration[0] !== 0x67 ||
      snapshot.status.some((v, i) => ((v ^ final.status[i]) & mask[i]) !== 0) ||
      hex(snapshot.configuration) !== hex(final.configuration) ||
      snapshot.deviceConfiguration.some((v, i) => i > 1 && v !== final.deviceConfiguration[i]) ||
      hex(snapshot.serial) !== hex(final.serial) ||
      hex(snapshot.dspName) !== hex(final.dspName)
    )
      throw new Error('Clone source changed during Reload; no metadata was replaced');
    return { ...snapshot, mixerConfiguration: mixerConfiguration.slice(), productStrings };
  }
  /** Connected native Save reads only physical info, selected FIR names and
   * the three EQ parameter pages. The caller owns one exclusive reservation.
   * Two complete matching reads detect changes; no atomic device-snapshot or
   * persisted Windows-host-state claim is made. No setter or backup-store write. */
  async captureNativeSaveSnapshotInternal(
    expected: Pick<Identity, 'serial' | 'product' | 'core' | 'firmware'>,
  ): Promise<NativeSaveSnapshot> {
    const target = {
      serial: expected?.serial,
      product: expected?.product,
      core: expected?.core,
      firmware: expected?.firmware,
    };
    if (
      typeof target.serial !== 'string' ||
      !target.serial.length ||
      target.serial.length > 200 ||
      /[^\x20-\x7e]/.test(target.serial) ||
      target.product !== 22 ||
      target.core !== '5.1' ||
      typeof target.firmware !== 'string' ||
      !/^\d+\.\d+$/.test(target.firmware)
    )
      throw new Error('Native Save requires an explicit captured FA503 identity');
    const read = async (address: number, length: number, selector: 0 | 1) => {
      const result = new Uint8Array(length);
      for (let offset = 0; offset < length; offset += 32) {
        const count = Math.min(32, length - offset),
          reply = await this.transport.exchange(
            packet(0x65, count, ...addr(address + offset), selector),
          );
        if (reply.length !== 64 || reply[0] !== 0x65 || reply[1] !== count)
          throw new Error('Incomplete or unexpected native Save metadata read');
        result.set(reply.slice(2, 2 + count), offset);
      }
      return result;
    };
    const readData = async (status: Uint8Array) => {
      const filenames: NativeSaveSnapshot['filenames'] = [],
        eqPages: NativeSaveSnapshot['eqPages'] = [];
      for (const address of nativeSaveFilenameAddresses(status))
        filenames.push({ address, bytes: await read(address, 32, 0) });
      for (const preset of [1, 2, 3] as const) {
        const address = 0x24000 + preset * 4096;
        eqPages.push({ preset, address, bytes: await read(address, 256, 1) });
      }
      return { filenames, eqPages };
    };
    const readPass = async (previous?: NativeSaveSnapshot): Promise<NativeSaveSnapshot> => {
      // Finish the second data read before the final identity/settings fence.
      // Placement is rechecked below, so a changed selection cannot substitute
      // a different filename set or be mistaken for an uninitialised resource.
      const repeated = previous ? await readData(previous.status) : undefined;
      const configuration = (await this.transport.exchange(packet(6, 1))).slice(),
        deviceConfiguration = (await this.transport.exchange(packet(0x66, 0))).slice();
      decodeHardwareOverview(configuration, deviceConfiguration);
      if (configuration[5] !== 3 || configuration[12] !== 3 || deviceConfiguration[11] !== 9)
        throw new Error('Native Save requires a commercial three-channel / three-preset FA503');
      const status = (await this.statusInternal()).raw.slice(),
        dspName = (await this.transport.exchange(packet(3, 8))).slice(),
        serial = await read(0x100, 32, 0),
        view = new DataView(
          configuration.buffer,
          configuration.byteOffset,
          configuration.byteLength,
        ),
        actualSerial = new TextDecoder('latin1').decode(serial).replace(/\0.*$/s, '').trim(),
        identity = {
          serial: actualSerial,
          product: configuration[1],
          core: `${configuration[2]}.${configuration[3]}`,
          firmware: `${view.getUint16(15, true)}.${view.getUint16(17, true)}`,
        };
      if (
        identity.serial !== target.serial ||
        identity.product !== target.product ||
        identity.core !== target.core ||
        identity.firmware !== target.firmware
      )
        throw new Error('Native Save amplifier identity or firmware changed');
      const productStrings = {
          hypexName: await read(0x120, 32, 0),
          oemName: await read(0x140, 32, 0),
        },
        mixerConfiguration = (await this.transport.exchange(packet(0x67, 0))).slice();
      if (previous && (previous.status[31] ^ status[31]) & 7)
        throw new Error('Native Save FIR placement changed during capture');
      const { filenames, eqPages } = repeated ?? (await readData(status));
      const snapshot = {
        identity,
        status,
        configuration,
        deviceConfiguration,
        dspName,
        serial,
        productStrings,
        mixerConfiguration,
        filenames,
        eqPages,
      };
      // Shared pure mapper checks every required packet, selected name and EQ
      // CRC, including the documented non-wire defaults and encoding limits.
      captureNativeSaveTemplate(snapshot);
      return snapshot;
    };
    const before = await readPass(),
      after = await readPass(before),
      mask = nativeSaveStatusMask(),
      same = (a: Uint8Array, b: Uint8Array) => hex(a) === hex(b);
    if (
      before.status.some((value, i) => ((value ^ after.status[i]) & mask[i]) !== 0) ||
      !same(before.configuration, after.configuration) ||
      !same(before.deviceConfiguration.slice(2), after.deviceConfiguration.slice(2)) ||
      !same(before.dspName.slice(2, 32), after.dspName.slice(2, 32)) ||
      !same(before.serial, after.serial) ||
      !same(before.productStrings.hypexName, after.productStrings.hypexName) ||
      !same(before.productStrings.oemName, after.productStrings.oemName) ||
      !same(before.mixerConfiguration.slice(2, 38), after.mixerConfiguration.slice(2, 38)) ||
      before.filenames.length !== after.filenames.length ||
      before.filenames.some(
        (value, i) =>
          value.address !== after.filenames[i]?.address ||
          !same(value.bytes, after.filenames[i].bytes),
      ) ||
      before.eqPages.some(
        (value, i) =>
          value.address !== after.eqPages[i]?.address || !same(value.bytes, after.eqPages[i].bytes),
      )
    )
      throw new Error('Native Save source changed during capture; no metadata was returned');
    return before;
  }
  async writeCloneReportInternal(step: {
    id: 'mute' | 'settings' | 'configuration' | 'display' | 'activation';
    request: Uint8Array;
    verification: { expected: Uint8Array; mask: Uint8Array };
  }): Promise<PanelStatus> {
    if (!this.cloneMutation) throw new Error('Clone report requires a reserved mutation scope');
    step = {
      id: step.id,
      request: step.request.slice(),
      verification: {
        expected: step.verification.expected.slice(),
        mask: step.verification.mask.slice(),
      },
    };
    const r = step.request.slice(),
      configuration = step.id === 'configuration';
    if (
      !['mute', 'settings', 'configuration', 'display', 'activation'].includes(step.id) ||
      r.length !== 64 ||
      r[0] !== (configuration ? 0x66 : 5) ||
      r[1] !== (configuration ? 1 : 0) ||
      (!configuration &&
        (!(r[6] & 128) ||
          r[23] !== (step.id === 'settings' ? 4 : step.id === 'display' ? 8 : 0))) ||
      (configuration && (r[10] !== 5 || r[11] !== 9 || r[12] !== 22))
    )
      throw new Error('Invalid muted Clone report');
    await this.mutatingExchangeInternal(r);
    const actual = await this.transport.exchange(packet(r[0], configuration ? 0 : 1));
    verifyDeviceDefaultsStep(step as DeviceDefaultsStep, actual);
    if (configuration) decodeLimiter(actual);
    else this.lastStatus = decodeStatus(actual);
    const status = await this.statusInternal();
    if (!status.muted) throw new Error('Clone outputs did not remain muted');
    return status;
  }
  async writeCloneEqInternal(address: number, bytes: Uint8Array) {
    if (!this.cloneMutation || ![0x25000, 0x26000, 0x27000].includes(address))
      throw new Error('Invalid reserved Clone EQ phase');
    await this.writeSectorInternal(address, bytes);
  }
  async reloadCloneEqInternal() {
    if (!this.cloneMutation) throw new Error('Clone EQ reload requires a reserved mutation scope');
    await this.ack(packet(0x64, 3));
  }
  async writeCloneFiltersInternal(
    plan: {
      preset: number;
      iir: { address: number; bytes: Uint8Array };
      fir: {
        sectors: { address: number; bytes: Uint8Array }[];
        filenames: { address: number; bytes: Uint8Array }[];
        flags: number;
        placement: 0 | 1;
      };
    },
    dspNameRequest: Uint8Array,
    activation: DeviceDefaultsStep,
  ) {
    plan = {
      ...plan,
      iir: { address: plan.iir.address, bytes: plan.iir.bytes.slice() },
      fir: {
        ...plan.fir,
        sectors: plan.fir.sectors.map((sector) => ({
          address: sector.address,
          bytes: sector.bytes.slice(),
        })),
        filenames: plan.fir.filenames.map((filename) => ({
          address: filename.address,
          bytes: filename.bytes.slice(),
        })),
      },
    };
    dspNameRequest = dspNameRequest.slice();
    activation = {
      id: activation.id,
      request: activation.request.slice(),
      verification: {
        expected: activation.verification.expected.slice(),
        mask: activation.verification.mask.slice(),
      },
    };
    if (
      !this.cloneMutation ||
      plan.iir.address !== presetBase(plan.preset) ||
      dspNameRequest.length !== 64 ||
      dspNameRequest[0] !== 3 ||
      dspNameRequest[1] !== 0
    )
      throw new Error('Invalid reserved Clone filter phase');
    await this.mutatingExchangeInternal(dspNameRequest);
    const actualName = await this.transport.exchange(packet(3, 8));
    if (
      actualName[0] !== 3 ||
      actualName.slice(2).some((byte, i) => byte !== dspNameRequest[i + 2])
    )
      throw new Error('Clone DSP filename readback mismatch');
    await this.writeSectorInternal(plan.iir.address, plan.iir.bytes);
    for (const sector of plan.fir.sectors)
      await this.writeSectorInternal(sector.address, sector.bytes);
    // Send the exact reviewed, persisted sequential activation. Reconstructing
    // a generic control patch here would weaken immutable-plan verification.
    await this.writeCloneReportInternal({ ...activation, id: 'activation' });
    for (const filename of plan.fir.filenames)
      await writeFirNameInternal(this, filename.address, filename.bytes);
  }
  async prepareInternal(preset: number, design: Preset) {
    // Compile before side effects. Existing FIR content is not overwritten by IIR.
    compileSector(design, new Uint8Array(4096));
    const fir = await prepareFirInternal(this, preset, design);
    const backup = await this.backupInternal(preset, presetBase(preset)),
      state = decodeStatus(unhex(backup.status_hex));
    await this.assertOperationsInternal('uploadFilters');
    const target = compileSector(design, unhex(backup.sector_hex));
    return { backup, target, fir };
  }
  async programInternal(
    preset: number,
    name: string,
    target: Uint8Array,
    progress: Progress,
    fir?: FirPlan,
  ) {
    if (fir) await programFirInternal(this, preset, fir, progress);
    await this.setNameInternal(name);
    await this.writeSectorInternal(presetBase(preset), target, progress);
    await this.controlsInternal({ mute: true, preset });
    progress(100, 'Verified · outputs remain muted');
  }
  async upload(preset: number, name: string, design: Preset, progress: Progress = () => {}) {
    return this.exclusive(async () => {
      const plan = await this.prepareInternal(preset, design);
      await this.controlsInternal({ mute: true });
      await this.programInternal(preset, name, plan.target, progress, plan.fir);
      return plan.backup;
    });
  }
  async restore(backup: Backup, progress: Progress = () => {}) {
    return this.exclusive(async () => {
      const bytes = unhex(backup.sector_hex);
      if (
        backup.format !== 'fusion-studio-backup' ||
        backup.version !== 1 ||
        bytes.length !== 4096 ||
        (await digest(bytes)) !== backup.sha256 ||
        ![presetBase(backup.preset), presetBase(backup.preset) + 0x3000].includes(backup.address)
      )
        throw new Error('Backup checksum, format or address invalid');
      const identity = await this.identifyInternal();
      if (
        backup.serial !== identity.serial ||
        backup.product !== identity.product ||
        backup.firmware !== identity.firmware
      )
        throw new Error('Backup belongs to a different amplifier or firmware');
      await this.assertOperationsInternal(
        backup.address >= 0x25000 ? 'equalizer' : 'uploadFilters',
        'uploadFilters', // Restoration also restores the DSP filename.
        'equalizer', // Restoration also reapplies the recorded EQ activation flag.
      );
      await this.backupInternal(backup.preset, backup.address);
      await this.controlsInternal({ mute: true });
      await this.writeSectorInternal(backup.address, bytes, progress);
      await this.setNameInternal(backup.name);
      const original = decodeStatus(unhex(backup.status_hex));
      if (backup.address >= 0x25000) await this.ack(packet(0x64, 3));
      await this.controlsInternal({
        mute: true,
        preset: original.preset,
        presetEq: { preset: backup.preset, enabled: !!(original.raw[11 + backup.preset] & 16) },
      });
      progress(100, 'Original bytes restored and verified · muted');
    });
  }
  async readPreset(preset: number) {
    return this.exclusive(async () => {
      const backup = await this.backupInternal(preset, presetBase(preset));
      return { backup, channels: decodeChannels(unhex(backup.sector_hex)) };
    });
  }
  async close() {
    await this.exclusive(() => this.transport.close());
  }
  async readEq(preset: number) {
    return this.exclusive(async () => {
      const base = presetBase(preset) + 0x3000,
        backup = await this.backupInternal(preset, base);
      return { backup, bands: decodeEq(unhex(backup.sector_hex)) };
    });
  }
  async prepareEqInternal(preset: number, bands: Filter[], enabled: boolean) {
    const record = encodeEq(bands),
      base = presetBase(preset) + 0x3000,
      backup = await this.backupInternal(preset, base),
      target = unhex(backup.sector_hex);
    await this.assertOperationsInternal('equalizer');
    target.set(record);
    return { backup, target, enabled };
  }
  async programEqInternal(
    preset: number,
    target: Uint8Array,
    enabled: boolean,
    progress: Progress = () => {},
  ) {
    await this.writeSectorInternal(presetBase(preset) + 0x3000, target, progress);
    await this.ack(packet(0x64, 3));
    await this.controlsInternal({ mute: true, presetEq: { preset, enabled } });
    progress(100, 'Input EQ verified · outputs remain muted');
  }
  async uploadEq(preset: number, bands: Filter[], enabled: boolean, progress: Progress = () => {}) {
    return this.exclusive(async () => {
      const plan = await this.prepareEqInternal(preset, bands, enabled);
      await this.controlsInternal({ mute: true });
      await this.programEqInternal(preset, plan.target, plan.enabled, progress);
      return plan.backup;
    });
  }
  async powerStatistics() {
    return this.exclusive(async () =>
      decodePower(await this.transport.exchange(packet(8, 128, 0))),
    );
  }
  async limiter() {
    return this.exclusive(async () =>
      decodeLimiter(await this.transport.exchange(packet(0x66, 0))),
    );
  }
  async hardwareOverview(): Promise<HardwareOverview & { identity: Identity }> {
    return this.exclusive(async () => {
      const identity = await this.identifyInternal(),
        configuration = await this.transport.exchange(packet(0x66, 0)),
        hypexName = await this.readMemoryInternal(0x120, 32, 0),
        oemName = await this.readMemoryInternal(0x140, 32, 0);
      return {
        identity: { ...identity },
        ...decodeHardwareOverview(unhex(identity.configuration), configuration),
        productNames: decodeNativeProductNames(hypexName, oemName),
      };
    });
  }
  /** Internal Defaults transaction API. The coordinator owns the session reservation. */
  async captureDeviceDefaultsInternal(
    expected: Pick<Identity, 'serial' | 'product' | 'core' | 'firmware'>,
  ): Promise<DefaultsHardwareSnapshot> {
    expected = {
      serial: expected?.serial,
      product: expected?.product,
      core: expected?.core,
      firmware: expected?.firmware,
    };
    const identity = await this.identifyInternal();
    if (
      !expected ||
      identity.serial !== expected.serial ||
      identity.product !== expected.product ||
      identity.core !== expected.core ||
      identity.firmware !== expected.firmware
    )
      throw new Error('Captured Defaults amplifier identity or firmware changed');
    const deviceConfiguration = await this.transport.exchange(packet(0x66, 0));
    decodeLimiter(deviceConfiguration);
    const status = await this.statusInternal();
    // Native bDefaults has an absolute lock gate, with no OEM-mask exception.
    if (status.locked) throw new Error('Device Defaults requires an unlocked amplifier');
    return {
      identity: {
        serial: identity.serial,
        product: identity.product,
        core: identity.core,
        firmware: identity.firmware,
      },
      status: status.raw.slice(),
      configuration: unhex(identity.configuration),
      deviceConfiguration: deviceConfiguration.slice(),
    };
  }
  /** Narrow, fully unlocked Defaults path: its native display write is allowed
   * even when OLED capability is absent. Ordinary OLED controls remain gated. */
  async writeDeviceDefaultsStepInternal(
    expected: Pick<Identity, 'serial' | 'product' | 'core' | 'firmware'>,
    step:
      | DeviceDefaultsStep
      | {
          id: 'mute';
          request: Uint8Array;
          verification: { expected: Uint8Array; mask: Uint8Array };
        },
    hooks: {
      beforeSend?: () => Promise<void>;
      /** Shared initial-mute barrier, after durable marker and fresh validation. */
      readyToExchange?: () => Promise<void>;
      /** Synchronous final admission immediately before the setter exchange. */
      beforeExchange?: () => void;
      assertCurrent?: () => void;
      assertSnapshot?: (snapshot: DefaultsHardwareSnapshot) => void;
    } = {},
  ): Promise<PanelStatus> {
    let attempted = false;
    try {
      expected = {
        serial: expected?.serial,
        product: expected?.product,
        core: expected?.core,
        firmware: expected?.firmware,
      };
      step = {
        id: step.id,
        request: step.request.slice(),
        verification: {
          expected: step.verification.expected.slice(),
          mask: step.verification.mask.slice(),
        },
      };
      const configurationWrite = step.id === 'configuration' || step.id === 'restore-configuration';
      if (
        ![
          'mute',
          'settings',
          'mixer',
          'configuration',
          'display',
          'restore-configuration',
          'restore-settings',
        ].includes(step.id) ||
        step.request.length !== 64 ||
        step.request[0] !== (configurationWrite ? 0x66 : 5) ||
        step.request[1] !== (configurationWrite ? 1 : 0) ||
        (!configurationWrite && !(step.request[6] & 128)) ||
        step.verification.expected[0] !== step.request[0]
      )
        throw new Error('Invalid Defaults write frame');
      verifyDeviceDefaultsStep(step as DeviceDefaultsStep, step.verification.expected);
      hooks.assertCurrent?.();
      hooks.assertSnapshot?.(await this.captureDeviceDefaultsInternal(expected));
      await hooks.beforeSend?.();
      // Durable attempt-marker storage can await. Fence identity and the absolute
      // native lock again after it and immediately before the setter.
      const current = await this.captureDeviceDefaultsInternal(expected);
      hooks.assertSnapshot?.(current);
      if (step.id !== 'mute' && !(current.status[6] & 128))
        throw new Error('Every selected amplifier must remain muted during Defaults');
      if (hooks.readyToExchange) await hooks.readyToExchange();
      hooks.assertCurrent?.();
      hooks.beforeExchange?.();
      attempted = true;
      await this.transport.exchange(step.request.slice());
      const actual = await this.transport.exchange(
        packet(step.request[0], step.request[0] === 5 ? 1 : 0),
      );
      if (step.request[0] === 5) this.lastStatus = decodeStatus(actual);
      else decodeLimiter(actual);
      verifyDeviceDefaultsStep(step as DeviceDefaultsStep, actual);
      return this.lastStatus!;
    } catch (failure) {
      throw new DeviceDefaultsStepError(
        failure instanceof Error
          ? failure.message.slice(0, 1024)
          : 'Defaults step was not confirmed',
        attempted,
      );
    }
  }
  /** Read-only native limiter capture; internal callers own the reservation. */
  async captureNativeLimiterInternal(
    expected: Pick<Identity, 'serial' | 'product' | 'core' | 'firmware'>,
    requirePermission = true,
  ): Promise<DefaultsHardwareSnapshot> {
    const target = {
        serial: expected?.serial,
        product: expected?.product,
        core: expected?.core,
        firmware: expected?.firmware,
      },
      identity = await this.identifyInternal();
    if (
      identity.serial !== target.serial ||
      identity.product !== target.product ||
      identity.core !== target.core ||
      identity.firmware !== target.firmware
    )
      throw new Error('Captured native limiter amplifier identity or firmware changed');
    const deviceConfiguration = await this.transport.exchange(packet(0x66, 0));
    decodeLimiter(deviceConfiguration);
    this.configuredModuleType = deviceConfiguration[11];
    const status = await this.statusInternal();
    if (requirePermission)
      assertOperationAllowed(status, 'softclipLimiter', this.configuredModuleType);
    return {
      identity: target,
      status: status.raw.slice(),
      configuration: unhex(identity.configuration),
      deviceConfiguration: deviceConfiguration.slice(),
    };
  }
  /** One native limiter setter followed by a separate readback. No timeout retry. */
  async writeNativeLimiterStepInternal(
    expected: Pick<Identity, 'serial' | 'product' | 'core' | 'firmware'>,
    kind: 'mute' | 'configuration',
    originalConfiguration: Uint8Array,
    bridged: boolean,
    proposedConfiguration: Uint8Array,
    hooks: {
      assertCurrent?: () => void;
      readyToExchange?: () => Promise<void>;
      beforeExchange?: () => void;
      onAttempt?: () => void;
    } = {},
  ) {
    let attempted = false;
    try {
      const identity = {
          serial: expected?.serial,
          product: expected?.product,
          core: expected?.core,
          firmware: expected?.firmware,
        },
        original = originalConfiguration.slice(),
        proposed = proposedConfiguration.slice();
      decodeLimiter(original);
      decodeLimiter(proposed);
      if (kind !== 'mute' && kind !== 'configuration')
        throw new Error('Invalid native limiter step');
      for (const i of [...Array.from({ length: 18 }, (_, n) => n + 2), 62, 63])
        if (original[i] !== proposed[i])
          throw new Error('Native limiter cannot change manufacturing configuration');
      hooks.assertCurrent?.();
      const current = await this.captureNativeLimiterInternal(identity);
      if (
        current.deviceConfiguration.some(
          (value, index) => index > 1 && value !== original[index],
        ) ||
        !!(current.status[9] & 2) !== bridged
      )
        throw new Error(
          'Native limiter configuration or bridge mode changed; read the amplifier again',
        );
      if (kind === 'configuration' && !(current.status[6] & 128))
        throw new Error('Amplifier must remain muted during native limiter update');
      const request =
        kind === 'mute' ? control(decodeStatus(current.status), { mute: true }) : proposed;
      if (kind === 'configuration') request[1] = 1;
      if (hooks.readyToExchange) await hooks.readyToExchange();
      hooks.assertCurrent?.();
      hooks.onAttempt?.();
      // The controller's final synchronous cancellation/identity fence follows
      // all awaits and observers, directly before starting the transport call.
      hooks.beforeExchange?.();
      attempted = true;
      await this.transport.exchange(request.slice());
      if (kind === 'mute') {
        const actual = await this.statusInternal();
        verifyDeviceDefaultsStep(
          {
            id: 'mute',
            request,
            verification: { expected: request, mask: deviceDefaultsStatusMask() },
          },
          actual.raw,
        );
        return { status: actual };
      }
      const actual = decodeLimiter(await this.transport.exchange(packet(0x66, 0)));
      for (let i = 2; i < 64; i++)
        if (actual.raw[i] !== proposed[i])
          throw new Error(`Native limiter readback differs at byte ${i}`);
      const status = await this.statusInternal();
      if (!status.muted)
        throw new Error(
          'Native limiter configuration was read back but global mute is no longer confirmed',
        );
      return { status, configuration: actual };
    } catch (failure) {
      throw new NativeLimiterStepError(
        failure instanceof Error
          ? failure.message.slice(0, 1024)
          : 'Native limiter step was not confirmed',
        attempted,
      );
    }
  }
  async backupConfigurationInternal(): Promise<ConfigurationBackup> {
    const identity = await this.identifyInternal(),
      status = await this.statusInternal(),
      current = decodeLimiter(await this.transport.exchange(packet(0x66, 0)));
    const backup: ConfigurationBackup = {
      id: uid(),
      format: 'fusion-studio-configuration-backup',
      version: 1,
      utc: new Date().toISOString(),
      serial: identity.serial,
      product: identity.product,
      firmware: identity.firmware,
      configuration_hex: hex(current.raw),
      status_hex: hex(status.raw),
      sha256: await digest(current.raw),
    };
    await saveConfigurationBackup(backup);
    return backup;
  }
  async backupConfiguration() {
    return this.exclusive(() => this.backupConfigurationInternal());
  }
  async writeConfigurationInternal(
    target: Uint8Array,
    operation: 'manufacturing' | 'softclipLimiter' = 'manufacturing',
  ) {
    decodeLimiter(target);
    await this.assertOperationsInternal(operation);
    if (operation === 'softclipLimiter') {
      const current = decodeLimiter(await this.transport.exchange(packet(0x66, 0)));
      for (const i of [...Array.from({ length: 18 }, (_, n) => n + 2), 62, 63])
        if (current.raw[i] !== target[i])
          throw new Error(
            'Manufacturing configuration changed; limiter update cannot overwrite it',
          );
    }
    await this.controlsInternal({ mute: true });
    const request = target.slice();
    request[1] = 1;
    await this.transport.exchange(request);
    const actual = decodeLimiter(await this.transport.exchange(packet(0x66, 0)));
    for (let i = 2; i < 64; i++)
      if (actual.raw[i] !== target[i])
        throw new Error(
          `Device configuration readback mismatch at byte ${i}; amplifier remains muted`,
        );
    return actual;
  }
  private async prepareLimiterInternal(channels: LimiterChannel[]) {
    const status = await this.assertOperationsInternal('softclipLimiter'),
      current = decodeLimiter(await this.transport.exchange(packet(0x66, 0)));
    return encodeLimiter(current, channels, !!(status.raw[9] & 2));
  }
  async preflightLimiter(channels: LimiterChannel[]): Promise<void> {
    const proposal = structuredClone(channels);
    return this.exclusive(async () => {
      await this.prepareLimiterInternal(proposal);
    });
  }
  async setLimiter(channels: LimiterChannel[]) {
    const proposal = structuredClone(channels);
    return this.exclusive(async () => {
      const target = await this.prepareLimiterInternal(proposal);
      await this.backupConfigurationInternal();
      return this.writeConfigurationInternal(target, 'softclipLimiter');
    });
  }
  async restoreConfiguration(backup: ConfigurationBackup) {
    return this.exclusive(async () => {
      const current = await this.identifyInternal(),
        raw = unhex(backup.configuration_hex);
      if (
        backup.format !== 'fusion-studio-configuration-backup' ||
        backup.version !== 1 ||
        raw.length !== 64 ||
        backup.serial !== current.serial ||
        backup.product !== current.product ||
        backup.firmware !== current.firmware ||
        (await digest(raw)) !== backup.sha256
      )
        throw new Error('Configuration backup identity or checksum mismatch');
      await this.assertOperationsInternal('manufacturing');
      await this.backupConfigurationInternal();
      return this.writeConfigurationInternal(raw);
    });
  }
  async setPower(on: boolean) {
    return this.exclusive(async () => {
      if (!on) throw new Error(dspPowerOffAvailability(this.identity?.firmware).reason);
      await this.assertOperationsInternal('deviceSettings');
      await this.controlsInternal({ mute: true });
      let power = decodePower(await this.transport.exchange(packet(8, 128, 0)));
      if ((power.mode === 'on') === on) return power;
      let result: Uint8Array;
      try {
        result = await this.transport.exchange(packet(8, on ? 1 : 0, 0));
      } catch {
        throw new Error(
          'USB became unavailable during the DSP power request. The resulting power state is unconfirmed; restore physical mains power before reconnecting.',
        );
      }
      if (result[1] !== 1) throw new Error('DSP power request was not accepted');
      for (let i = 0; i < 40; i++) {
        await sleep(75);
        try {
          power = decodePower(await this.transport.exchange(packet(8, 128, 0)));
        } catch {
          throw new Error(
            'USB became unavailable after the DSP power request. Reconnection may require the panel’s mains switch. Filter flash was not changed.',
          );
        }
        if ((power.mode === 'on') === on) {
          await this.controlsInternal({ mute: true });
          return power;
        }
      }
      throw new Error('DSP power transition was not confirmed; outputs remain muted');
    });
  }
}
export function decodeChannels(sector: Uint8Array): Channel[] {
  if (sector.length !== 4096) throw new Error('Incomplete sector');
  const v = new DataView(sector.buffer, sector.byteOffset, sector.byteLength);
  return ['Woofer', 'Midrange', 'Tweeter'].map((name, index) => {
    const base = index * 512;
    const filters: Filter[] = Array.from({ length: 15 }, (_, i) => {
      const offset = base + 4 + i * 20,
        values = Array.from({ length: 5 }, (_, j) => v.getInt32(offset + j * 4, true) / 2 ** 24);
      return {
        ...newFilter('raw'),
        coefficients: { b2: values[0], b1: values[1], b0: values[2], f2: values[3], f1: values[4] },
        provenance: 'panel',
      };
    });
    return {
      id: uid(),
      name,
      outputName: `Output ${index + 1}`,
      gain: 0,
      invert: false,
      muted: false,
      delayUs: (v.getUint32(base, true) * 1e6) / 93750,
      globalDelayUs: 0,
      filters,
      fir: emptyFir(),
    };
  });
}
export async function uploadPair(
  jobs: {
    session: PanelSession;
    preset: number;
    name: string;
    design: Preset;
    progress: Progress;
    label?: string;
  }[],
) {
  return coordinatedUpload(
    jobs.map((j) => ({
      session: j.session,
      label: j.label,
      prepare: () => j.session.prepareInternal(j.preset, j.design),
      program: (plan: Awaited<ReturnType<PanelSession['prepareInternal']>>) =>
        j.session.programInternal(j.preset, j.name, plan.target, j.progress, plan.fir),
    })),
  );
}
export async function uploadEqPair(
  jobs: {
    session: PanelSession;
    preset: number;
    bands: Filter[];
    enabled: boolean;
    progress?: Progress;
    label?: string;
  }[],
) {
  return coordinatedUpload(
    jobs.map((j) => ({
      session: j.session,
      label: j.label,
      prepare: () => j.session.prepareEqInternal(j.preset, j.bands, j.enabled),
      program: (plan: Awaited<ReturnType<PanelSession['prepareEqInternal']>>) =>
        j.session.programEqInternal(j.preset, plan.target, plan.enabled, j.progress),
    })),
  );
}
