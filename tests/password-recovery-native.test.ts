import { describe, expect, it } from 'vitest';
import {
  recoveryChallengeFromGuid,
  recoveryChallengeWord,
  parseReceivedRecoveryCode,
  installRecoveryChallengePacket,
  submitRecoveryCodePacket,
  RecoveryOperationError,
} from '../src/hardware/password-recovery';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import type { PasswordTarget } from '../src/hardware/password';
import type { Transport } from '../src/hardware/transport';

function fixture(wrap?: (panel: SimulatedPanel) => Transport) {
  const panel = new SimulatedPanel('NATIVE-RECOVERY-FIXTURE');
  // This firmware-specific test double is not evidence of acceptance on a
  // physical 5.7 panel. No support-code algorithm is implemented or assumed.
  new DataView(panel.configuration.buffer).setUint16(17, 82, true);
  panel.deviceConfiguration[11] = 1;
  panel.status[51] = 3; // Independent signal-present + protected, not matched.
  panel.eeprom.set(new TextEncoder().encode('old-password'), 0x20);
  panel.eeprom.set(new TextEncoder().encode('retained@example.test'), 0x50);
  const target: PasswordTarget = {
    serial: panel.serial,
    product: 22,
    core: '5.1',
    firmware: '5.82',
  };
  return { panel, target, session: new PanelSession(wrap?.(panel) ?? panel, async () => {}) };
}
const requests = (panel: SimulatedPanel) => panel.requests.filter((request) => request[0] === 4);
async function failure(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(RecoveryOperationError);
    return error as RecoveryOperationError;
  }
  throw new Error('Expected a recovery ledger failure');
}

describe('native password-recovery codec, without physical hardware or support requests', () => {
  it('extracts the GUID last16 uppercase hex characters and matches independent CRC32 known answers', () => {
    expect(recoveryChallengeFromGuid('{00112233-4455-6677-0123-456789abcdef}')).toBe(
      '0123456789ABCDEF',
    );
    expect(recoveryChallengeFromGuid('00112233-4455-6677-89ab-cdef01234567')).toBe(
      '89ABCDEF01234567',
    );
    // Full reflected CRC32 known answers from Python zlib, not this codec:
    // 0x983c37b5, 0x69d749b8 and 0xa2006b64 respectively.
    expect(recoveryChallengeWord('0123456789ABCDEF')).toBe(0x37b5);
    expect(recoveryChallengeWord('89ABCDEF01234567')).toBe(0x49b8);
    expect(recoveryChallengeWord('0000000000000000')).toBe(0x6b64);
    expect(() => recoveryChallengeFromGuid('{00112233-4455-6677-0123-456789abcdef')).toThrow();
    expect(() => recoveryChallengeWord('0123456789abcdef')).toThrow();
    expect(() => recoveryChallengeWord('0123456789ABCDEFsuffix')).toThrow();
  });
  it('constructs fresh zero-tailed64-byte04/02/03 and04/02/04 requests with little-endian words', () => {
    for (const [make, subcommand] of [
      [installRecoveryChallengePacket, 3],
      [submitRecoveryCodePacket, 4],
    ] as const) {
      const packet = make(0xabcd);
      expect(packet).toHaveLength(64);
      expect(Array.from(packet.slice(0, 5))).toEqual([4, 2, subcommand, 0xcd, 0xab]);
      expect(packet.slice(5)).toEqual(new Uint8Array(59));
      packet[0] = 99;
      expect(make(0)[0]).toBe(4);
      expect(Array.from(make(65535).slice(3, 5))).toEqual([255, 255]);
      for (const value of [-1, 65536, 1.5, NaN, Infinity]) expect(() => make(value)).toThrow();
    }
  });
  it('uses the proven first4 hex digits, accepts suffixes and0000, and explicitly rejects native error-fallback inputs', () => {
    expect(parseReceivedRecoveryCode('aBcD')).toBe(0xabcd);
    expect(parseReceivedRecoveryCode('aBcD any suffix including more hex 1234')).toBe(0xabcd);
    expect(parseReceivedRecoveryCode('0000')).toBe(0);
    expect(parseReceivedRecoveryCode('FFFF0000')).toBe(65535);
    // Malformed/short => reject is an explicit browser validation boundary;
    // it does not claim equivalence to Delphi's exception fallback word zero.
    for (const input of ['', 'ABC', '0x12', ' ABCD', '12G4', 'ABCD' + 'x'.repeat(4093)])
      expect(() => parseReceivedRecoveryCode(input)).toThrow();
  });
});

describe('real PanelSession recovery transaction against the synthetic5.82 panel', () => {
  it('installs one challenge only after fresh selected identity and OEM/protected/locked checks, without claiming durable readback', async () => {
    const { panel, session, target } = fixture(),
      original = panel.eeprom.slice(),
      result = await session.installRecoveryChallenge(target, 0x37b5);
    expect(result).toMatchObject({
      operation: 'challenge-install',
      mutation: 'acknowledged',
      persistence: 'unavailable',
      protection: { passwordProtected: true, locked: true, isOemConfigured: true },
    });
    expect(result.steps).toEqual([
      { name: 'identity', state: 'confirmed' },
      { name: 'preflight', state: 'confirmed' },
      { name: 'request', state: 'acknowledged' },
      { name: 'final-status', state: 'confirmed' },
    ]);
    expect(panel.recoveryChallengeWord).toBe(0x37b5);
    expect(panel.recoveryChallengeInstalls).toBe(1);
    expect(requests(panel)).toHaveLength(1);
    expect(Array.from(requests(panel)[0].slice(0, 5))).toEqual([4, 2, 3, 0xb5, 0x37]);
    expect(panel.eeprom).toEqual(original);
    expect(panel.writes + panel.passwordWrites + panel.emailWrites).toBe(0);
    expect(panel.maxConcurrent).toBe(1);
  });
  it.each([
    'wrong selected identity',
    'standard module',
    'already matched',
    'unprotected',
  ] as const)('refuses %s before sending recovery packets', async (condition) => {
    const { panel, session, target } = fixture(),
      original = panel.eeprom.slice();
    if (condition === 'wrong selected identity') target.serial = 'DIFFERENT-AMPLIFIER';
    if (condition === 'standard module') panel.deviceConfiguration[11] = 0;
    if (condition === 'already matched') panel.status[51] |= 4;
    if (condition === 'unprotected') panel.status[51] &= ~2;
    const error = await failure(session.installRecoveryChallenge(target, 0x37b5));
    expect(error.result.mutation).toBe('not-attempted');
    expect(requests(panel)).toHaveLength(0);
    expect(panel.eeprom).toEqual(original);
  });
  it('a received fixture code clears only the first password storage byte, retains email and confirms fresh flags', async () => {
    const { panel, session, target } = fixture(),
      original = panel.eeprom.slice();
    panel.receivedRecoveryCode = 0;
    const result = await session.submitRecoveryCode(
      target,
      parseReceivedRecoveryCode('0000suffix'),
    );
    expect(result).toMatchObject({
      operation: 'password-reset',
      mutation: 'confirmed',
      persistence: 'password-cleared',
      protection: { passwordProtected: false, locked: false },
    });
    expect(result.steps.every((step) => step.state === 'confirmed')).toBe(true);
    expect(panel.eeprom[0x20]).toBe(0);
    expect(panel.eeprom.slice(0, 0x20)).toEqual(original.slice(0, 0x20));
    expect(panel.eeprom.slice(0x21)).toEqual(original.slice(0x21));
    expect(panel.status[51]).toBe(1); // Signal flag is independent and retained.
    expect(panel.recoveryCodeSubmissions).toBe(1);
    expect(panel.passwordWrites + panel.emailWrites + panel.writes).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/old-password|retained@example|0000suffix/);
  });
  it('a rejected code has a rejected request ledger, no retry and no storage changes', async () => {
    const { panel, session, target } = fixture(),
      original = panel.eeprom.slice();
    panel.receivedRecoveryCode = 0xabcd;
    const error = await failure(session.submitRecoveryCode(target, 0x1234));
    expect(error.result).toMatchObject({ mutation: 'rejected', persistence: 'unavailable' });
    expect(error.result.steps.at(-1)).toEqual({ name: 'request', state: 'rejected' });
    expect(panel.recoveryCodeSubmissions).toBe(1);
    expect(requests(panel)).toHaveLength(1);
    expect(panel.eeprom).toEqual(original);
  });
  it.each(['challenge-install', 'password-reset'] as const)(
    'a lost%s ACK remains unconfirmed, never retries and strips transport secrets',
    async (operation) => {
      const { panel, session, target } = fixture((simulator) => ({
        exchange: async (request) => {
          const reply = await simulator.exchange(request);
          if (request[0] === 4) throw new Error('private-transport-ABCD-retained@example.test');
          return reply;
        },
        close: async () => simulator.close(),
      }));
      panel.receivedRecoveryCode = 0xabcd;
      const error = await failure(
        operation === 'challenge-install'
          ? session.installRecoveryChallenge(target, 0xabcd)
          : session.submitRecoveryCode(target, 0xabcd),
      );
      expect(error.result).toMatchObject({
        operation,
        mutation: 'unconfirmed',
        persistence: 'unavailable',
      });
      expect(error.result.steps.at(-1)).toEqual({ name: 'request', state: 'unconfirmed' });
      expect(requests(panel)).toHaveLength(1);
      expect(error.message + JSON.stringify(error.result)).not.toMatch(
        /private-transport|ABCD|retained@example/,
      );
      expect(error).not.toHaveProperty('cause');
    },
  );
  it('a post-ACK status failure retains acknowledged ambiguity without resubmitting the reset', async () => {
    let submitted = false;
    const { panel, session, target } = fixture((simulator) => ({
      exchange: async (request) => {
        if (submitted && request[0] === 5) throw new Error('private-status-failure');
        const reply = await simulator.exchange(request);
        if (request[0] === 4) submitted = true;
        return reply;
      },
      close: async () => simulator.close(),
    }));
    panel.receivedRecoveryCode = 0xabcd;
    const error = await failure(session.submitRecoveryCode(target, 0xabcd));
    expect(error.result).toMatchObject({ mutation: 'acknowledged', persistence: 'unavailable' });
    expect(error.result.steps.at(-1)).toEqual({ name: 'final-status', state: 'unconfirmed' });
    expect(panel.eeprom[0x20]).toBe(0);
    expect(panel.recoveryCodeSubmissions).toBe(1);
    expect(error.message + JSON.stringify(error.result)).not.toContain('private-status-failure');
  });
});
