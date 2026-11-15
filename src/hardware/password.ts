import { control, type PanelStatus } from './codec';
import { decodeProtection } from './protection';

export const MAX_PASSWORD_BYTES = 16,
  MAX_RECOVERY_EMAIL_BYTES = 55,
  RECOVERY_EMAIL_STORAGE_BYTES = 56;
export interface PasswordTarget {
  serial: string;
  product: number;
  core: string;
  firmware: string;
}
export type PasswordStepName =
  | 'identity'
  | 'verification'
  | 'old-password-verification'
  | 'password-write'
  | 'new-password-verification'
  | 'email-write'
  | 'email-readback'
  | 'final-status';
export type PasswordStepState =
  'pending' | 'acknowledged' | 'confirmed' | 'rejected' | 'unconfirmed';
export type CredentialMutationState =
  'not-attempted' | 'unconfirmed' | 'acknowledged' | 'confirmed';
export interface PasswordOperationResult {
  operation: 'verify' | 'change' | 'clear' | 'email';
  target: PasswordTarget;
  steps: { name: PasswordStepName; state: PasswordStepState }[];
  passwordWrite: CredentialMutationState;
  emailWrite: CredentialMutationState;
  /** Last successfully read flags; an unconfirmed later write can make them stale. */
  protection?: {
    passwordProtected: boolean;
    passwordMatched: boolean;
    locked: boolean;
    rawMask: number;
  };
}
/** Contains bounded state only, never credential bytes, response bytes or a raw transport cause. */
export class PasswordOperationError extends Error {
  readonly result: PasswordOperationResult;
  constructor(message: string, result: PasswordOperationResult) {
    super(message);
    this.name = 'PasswordOperationError';
    this.result = structuredClone(result);
  }
}
export class PasswordProtocolError extends Error {
  constructor(
    readonly kind: 'rejected' | 'malformed' | 'mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'PasswordProtocolError';
  }
}
function validateBytes(bytes: Uint8Array, maximum: number, label: string) {
  if (!(bytes instanceof Uint8Array) || bytes.length > maximum)
    throw new Error(`${label} must be a byte array of at most ${maximum} bytes`);
  if (bytes.some((byte) => byte === 0)) throw new Error(`${label} cannot contain NUL bytes`);
}
export function validatePasswordBytes(bytes: Uint8Array) {
  validateBytes(bytes, MAX_PASSWORD_BYTES, 'Password');
}
export function validateRecoveryEmailBytes(bytes: Uint8Array) {
  validateBytes(bytes, MAX_RECOVERY_EMAIL_BYTES, 'Recovery email');
}
export function validatePasswordTarget(target: PasswordTarget) {
  if (
    !target ||
    typeof target.serial !== 'string' ||
    !/^[\x20-\x7e]{1,32}$/.test(target.serial) ||
    target.product !== 22 ||
    target.core !== '5.1' ||
    typeof target.firmware !== 'string' ||
    !/^\d{1,5}\.\d{1,5}$/.test(target.firmware) ||
    !target.firmware.split('.').every((word) => Number(word) <= 65535)
  )
    throw new Error('A captured FA503 / DSP5.1 identity is required');
}
function credentialPacket(subcommand: number, bytes: Uint8Array, email = false) {
  if (email) validateRecoveryEmailBytes(bytes);
  else validatePasswordBytes(bytes);
  const packet = new Uint8Array(64);
  packet.set([4, 2, subcommand]);
  packet.set(bytes, 3);
  return packet;
}
/** HFD a9c3a0: raw3 byte string + NUL, not a hash, code-page conversion or normalization. */
export const verifyPasswordPacket = (bytes: Uint8Array) => credentialPacket(2, bytes);
/** HFD a9c9d8/cf7128: an empty byte string is the ordinary clear-password operation. */
export const setPasswordPacket = (bytes: Uint8Array) => credentialPacket(0, bytes);
export const writeRecoveryEmailPacket = (bytes: Uint8Array) => credentialPacket(5, bytes, true);
export function readRecoveryEmailPacket() {
  const packet = new Uint8Array(64);
  packet.set([4, 2, 6]);
  return packet;
}
export function parsePasswordAck(reply: Uint8Array): boolean {
  if (
    !(reply instanceof Uint8Array) ||
    reply.length !== 64 ||
    reply[0] !== 4 ||
    ![0, 1].includes(reply[1])
  )
    throw new PasswordProtocolError('malformed', 'Unexpected credential acknowledgment');
  return reply[1] === 1;
}
/** HFD a9c840 stops on NUL or FF. Return all56 possible stored bytes without text decoding. */
export function parseRecoveryEmail(reply: Uint8Array): Uint8Array {
  if (!(reply instanceof Uint8Array) || reply.length !== 64 || reply[0] !== 4)
    throw new PasswordProtocolError('malformed', 'Unexpected recovery-email response');
  if (reply[1] !== 3)
    throw new PasswordProtocolError('rejected', 'Recovery-email read was rejected');
  const bytes = reply.slice(2, 2 + RECOVERY_EMAIL_STORAGE_BYTES),
    end = bytes.findIndex((byte) => byte === 0 || byte === 255);
  return end < 0 ? bytes : bytes.slice(0, end);
}
/** Raw builder permits FF. A verified session write cannot round-trip HFD's FF terminator. */
export function validateRecoveryEmailRoundTrip(bytes: Uint8Array) {
  validateRecoveryEmailBytes(bytes);
  if (bytes.includes(255))
    throw new Error(
      'Recovery email contains an FF terminator and cannot round-trip the native reader',
    );
}
export interface OemMaskProposal {
  previousMask: number;
  requestedMask: number;
  targetMask: number;
  clearedMask: number;
  forcedMask: number;
  ignoredRequestedMask: number;
}
/** FusionAmp dialog cf5ab4: first3 forced on, editable3..11; unsupported bits cleared. */
export function prepareOemMask(
  status: PanelStatus,
  requestedMask: number,
  moduleType: number,
): OemMaskProposal & { packet: Uint8Array } {
  if (!Number.isInteger(requestedMask) || requestedMask < 0 || requestedMask > 65535)
    throw new Error('OEM mask must be an unsigned 16-bit integer');
  const protection = decodeProtection(status, moduleType);
  if (!protection.isOemConfigured)
    throw new Error('OEM mask editing requires configured OEM module 1');
  if (protection.locked) throw new Error('OEM mask editing requires an unlocked panel');
  const targetMask = (requestedMask & 0x0ff8) | 7,
    packet = control(status, {}, moduleType);
  packet[24] = targetMask & 255;
  packet[25] = targetMask >> 8;
  packet[23] = 1;
  return {
    previousMask: protection.rawMask,
    requestedMask,
    targetMask,
    clearedMask: protection.rawMask & ~targetMask & 65535,
    forcedMask: 7 & ~requestedMask,
    ignoredRequestedMask: requestedMask & 0xf000,
    packet,
  };
}
