import { describe, expect, it } from 'vitest';
import { decodeStatus, packet } from '../src/hardware/codec';
import {
  parsePasswordAck,
  parseRecoveryEmail,
  prepareOemMask,
  readRecoveryEmailPacket,
  setPasswordPacket,
  verifyPasswordPacket,
  writeRecoveryEmailPacket,
  validateRecoveryEmailRoundTrip,
  validatePasswordTarget,
} from '../src/hardware/password';

describe('native credential byte fixtures', () => {
  it('bounds captured identity fields to native serial and version-word capacity', () => {
    const target = { serial: 'SYNTHETIC', product: 22, core: '5.1', firmware: '65535.65535' };
    expect(() => validatePasswordTarget(target)).not.toThrow();
    for (const invalid of [
      { ...target, serial: 'x'.repeat(33) },
      { ...target, firmware: '65536.1' },
      { ...target, firmware: '1'.repeat(1000) + '.7' },
      { ...target, product: 18 },
      { ...target, core: '5.2' },
    ])
      expect(() => validatePasswordTarget(invalid)).toThrow('captured FA503');
  });
  it('writes exact raw prefixes and preserves byte values without UTF8, trimming or case conversion', () => {
    const bytes = new Uint8Array([0x20, 0x41, 0xe9, 0xff, 0x20]);
    const verify = verifyPasswordPacket(bytes),
      set = setPasswordPacket(bytes);
    expect(verify.length).toBe(64);
    expect([...verify.slice(0, 9)]).toEqual([4, 2, 2, 0x20, 0x41, 0xe9, 0xff, 0x20, 0]);
    expect([...set.slice(0, 9)]).toEqual([4, 2, 0, 0x20, 0x41, 0xe9, 0xff, 0x20, 0]);
    expect(verify.slice(9).every((byte) => byte === 0)).toBe(true);
    verify[3] = 0;
    expect([...bytes]).toEqual([0x20, 0x41, 0xe9, 0xff, 0x20]);
  });
  it('supports16 nonNUL password bytes and the actual empty-set clear request', () => {
    const source = new Uint8Array(24).subarray(4, 20).fill(0xa5),
      encoded = setPasswordPacket(source);
    expect([...encoded.slice(3, 19)]).toEqual(Array(16).fill(0xa5));
    expect(encoded[19]).toBe(0);
    expect([...setPasswordPacket(new Uint8Array()).slice(0, 6)]).toEqual([4, 2, 0, 0, 0, 0]);
    expect([...verifyPasswordPacket(new Uint8Array()).slice(0, 5)]).toEqual([4, 2, 2, 0, 0]);
    for (const builder of [setPasswordPacket, verifyPasswordPacket]) {
      expect(() => builder(new Uint8Array(17).fill(65))).toThrow('at most 16');
      expect(() => builder(new Uint8Array([65, 0, 66]))).toThrow('NUL');
    }
  });
  it('encodes55 email bytes plus terminator, allows rawFF, and separately checks session representability', () => {
    const source = new Uint8Array(55).fill(0xe9),
      encoded = writeRecoveryEmailPacket(source);
    expect([...encoded.slice(0, 3)]).toEqual([4, 2, 5]);
    expect(encoded.slice(3, 58)).toEqual(source);
    expect(encoded.slice(58).every((byte) => byte === 0)).toBe(true);
    expect(writeRecoveryEmailPacket(new Uint8Array([255]))[3]).toBe(255);
    expect(() => validateRecoveryEmailRoundTrip(new Uint8Array([255]))).toThrow(
      'cannot round-trip',
    );
    expect(() => writeRecoveryEmailPacket(new Uint8Array(56).fill(65))).toThrow('at most 55');
    expect(() => writeRecoveryEmailPacket(new Uint8Array([0]))).toThrow('NUL');
    expect([...writeRecoveryEmailPacket(new Uint8Array()).slice(0, 4)]).toEqual([4, 2, 5, 0]);
    expect([...readRecoveryEmailPacket().slice(0, 5)]).toEqual([4, 2, 6, 0, 0]);
  });
  it('distinguishes credential acknowledgment from email-read replies and rejects malformed frames', () => {
    expect(parsePasswordAck(packet(4, 1))).toBe(true);
    expect(parsePasswordAck(packet(4, 0))).toBe(false);
    for (const reply of [new Uint8Array(63), packet(5, 1), packet(4, 3), packet(4, 2)])
      expect(() => parsePasswordAck(reply)).toThrow('acknowledgment');
    for (const reply of [new Uint8Array(63), packet(5, 3), packet(4, 0), packet(4, 1)])
      expect(() => parseRecoveryEmail(reply)).toThrow();
  });
  it('reads all56 stored email bytes, handles offsets, and follows native NUL/FF sentinels', () => {
    const reply = new Uint8Array(80).subarray(8, 72);
    reply.set([4, 3]);
    reply.fill(0xe9, 2, 58);
    reply.fill(77, 58);
    const full = parseRecoveryEmail(reply);
    expect(full).toEqual(new Uint8Array(56).fill(0xe9));
    full[0] = 0;
    expect(reply[2]).toBe(0xe9);
    reply[4] = 255;
    expect([...parseRecoveryEmail(reply)]).toEqual([0xe9, 0xe9]);
    reply[3] = 0;
    expect([...parseRecoveryEmail(reply)]).toEqual([0xe9]);
    reply[2] = 255;
    expect(parseRecoveryEmail(reply)).toHaveLength(0);
  });
});

describe('native FusionAmp OEM replacement fixtures', () => {
  it('forcesfirst3, replaces3..11, exposes cleared unsupported bits and sets onlyOEMtrigger', () => {
    const raw = packet(5);
    raw[2] = 2;
    raw[23] = 255;
    raw[24] = 0x01;
    raw[25] = 0xf8;
    raw[35] = 0xc5;
    raw[36] = 0xdd;
    raw[27] = 5;
    raw[6] = 0x85;
    const original = raw.slice(),
      plan = prepareOemMask(decodeStatus(raw), 0x2200, 1);
    expect(plan).toMatchObject({
      previousMask: 0xf801,
      requestedMask: 0x2200,
      targetMask: 0x207,
      clearedMask: 0xf800,
      forcedMask: 7,
      ignoredRequestedMask: 0x2000,
    });
    expect([...plan.packet.slice(23, 26)]).toEqual([1, 7, 2]);
    expect(plan.packet[35]).toBe(0xc5);
    expect(plan.packet[36]).toBe(0xd9);
    expect(plan.packet[27]).toBe(5);
    expect(plan.packet[6]).toBe(0x85);
    expect(plan.packet[2]).toBe(2);
    expect(raw).toEqual(original);
  });
  it('allows onlyfreshunlocked OEM module1, with integer16-bit proposals', () => {
    const raw = packet(5);
    raw[2] = 1;
    expect(() => prepareOemMask(decodeStatus(raw), 0, 0)).toThrow('module 1');
    raw[51] = 2;
    expect(() => prepareOemMask(decodeStatus(raw), 65535, 1)).toThrow('unlocked');
    raw[51] = 6;
    expect(prepareOemMask(decodeStatus(raw), 65535, 1).targetMask).toBe(0x0fff);
    for (const value of [-1, 65536, 1.1, NaN, Infinity])
      expect(() => prepareOemMask(decodeStatus(raw), value, 1)).toThrow('16-bit');
  });
});
