import { validatePasswordTarget, type PasswordTarget, type PasswordStepState } from './password';
import type { ProtectionReport } from './protection';

export type RecoveryMutationState =
  'not-attempted' | 'unconfirmed' | 'acknowledged' | 'confirmed' | 'rejected';
export interface RecoveryOperationResult {
  operation: 'challenge-install' | 'password-reset';
  target: PasswordTarget;
  steps: {
    name: 'identity' | 'preflight' | 'request' | 'final-status';
    state: PasswordStepState;
  }[];
  mutation: RecoveryMutationState;
  /** Challenge ACK has no recovered durable readback. A reset is confirmed by fresh password flags. */
  persistence: 'unavailable' | 'password-cleared';
  protection?: ProtectionReport;
}
/** No supplied code, packet, email or arbitrary transport cause is retained. */
export class RecoveryOperationError extends Error {
  readonly result: RecoveryOperationResult;
  constructor(result: RecoveryOperationResult) {
    super(
      'Password recovery was not confirmed. Inspect the operation ledger before another explicit action.',
    );
    this.name = 'RecoveryOperationError';
    this.result = structuredClone(result);
  }
}
export function validateRecoveryWord(word: number): void {
  if (!Number.isInteger(word) || word < 0 || word > 65535)
    throw new Error('A valid unsigned recovery word is required');
}
/** cf4170: GUIDToString, remove hyphens, last16 hex digits before the closing brace. */
export function recoveryChallengeFromGuid(guid: string): string {
  if (
    typeof guid !== 'string' ||
    !/^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i.test(guid) ||
    guid.startsWith('{') !== guid.endsWith('}')
  )
    throw new Error('A valid recovery GUID is required');
  return guid.replace(/[{}-]/g, '').slice(-16).toUpperCase();
}
/** cf39a8: reflected CRC32 of low character bytes; only low16 is installed. Not an unlock-code derivation. */
export function recoveryChallengeWord(challenge: string): number {
  if (typeof challenge !== 'string' || !/^[0-9A-F]{16}$/.test(challenge))
    throw new Error('A valid generated recovery challenge is required');
  let crc = 0xffffffff;
  for (let i = 0; i < challenge.length; i++) {
    crc ^= challenge.charCodeAt(i) & 255;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) & 65535;
}
/** Native cf39e4 reads the first4 characters. Reject malformed text rather than silently sending its error fallback0. */
export function parseReceivedRecoveryCode(text: string): number {
  if (typeof text !== 'string' || text.length > 4096 || !/^[0-9a-f]{4}/i.test(text))
    throw new Error('A received hexadecimal support code is required');
  return Number.parseInt(text.slice(0, 4), 16);
}
function recoveryWordPacket(subcommand: 3 | 4, word: number): Uint8Array {
  validateRecoveryWord(word);
  const packet = new Uint8Array(64);
  packet.set([4, 2, subcommand, word & 255, word >>> 8]);
  return packet;
}
export const installRecoveryChallengePacket = (word: number) => recoveryWordPacket(3, word);
export const submitRecoveryCodePacket = (word: number) => recoveryWordPacket(4, word);
export function createRecoveryResult(
  operation: RecoveryOperationResult['operation'],
  target: PasswordTarget,
): RecoveryOperationResult {
  validatePasswordTarget(target);
  return {
    operation,
    target: { ...target },
    steps: [],
    mutation: 'not-attempted',
    persistence: 'unavailable',
  };
}
export function assertRecoveryProtection(protection: ProtectionReport): void {
  if (!protection.isOemConfigured || !protection.passwordProtected || !protection.locked)
    throw new Error(
      'Forgotten-password recovery requires a locked, password-protected OEM-configured amplifier',
    );
}
