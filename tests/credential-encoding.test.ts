import { describe, expect, it } from 'vitest';
import {
  credentialInputSchema,
  decodePassword,
  decodeRecoveryEmail,
  encodePassword,
  encodeRecoveryEmail,
  validateNativeRecoveryEmail,
  validatePasswordChangeInput,
  validateRecoveryEmailInput,
  type CredentialEncoding,
  type CredentialInput,
} from '../src/domain/credential-encoding';

const input = (text: string, encoding: CredentialEncoding = 'ascii'): CredentialInput => ({
  text,
  encoding,
});
const change = (patch: Partial<Parameters<typeof validatePasswordChangeInput>[0]> = {}) => ({
  newPassword: input('secret'),
  retypePassword: input('secret'),
  email: input('person@example.com'),
  protected: false,
  ...patch,
});

describe('explicit credential encodings', () => {
  it('defaults schema to ASCII, rejects unknown keys and preserves literal spaces/case', () => {
    expect(credentialInputSchema.parse({ text: ' A b ' })).toEqual(input(' A b '));
    expect(credentialInputSchema.safeParse({ ...input('a'), extra: true }).success).toBe(false);
    expect([...encodePassword(input(' A b '))]).toEqual([32, 65, 32, 98, 32]);
    expect([...encodePassword(input('\t\x7f'))]).toEqual([9, 127]);
  });
  it('rejects Unicode ASCII substitution and never changes normalization', () => {
    expect(() => encodePassword(input('é'))).toThrow(/representable/);
    expect([...encodePassword(input('é', 'utf-8'))]).toEqual([0xc3, 0xa9]);
    expect([...encodePassword(input('e\u0301', 'utf-8'))]).toEqual([0x65, 0xcc, 0x81]);
  });
  it('round-trips every non-NUL CP1252 byte including undefined C1 positions', () => {
    for (let byte = 1; byte <= 255; byte++) {
      const decoded = decodePassword(Uint8Array.of(byte), 'windows-1252');
      expect(decoded.fallback).toBe(false);
      expect([...encodePassword(input(decoded.text, decoded.encoding))]).toEqual([byte]);
    }
    expect([...encodePassword(input('€\u0081\u008d\u008f\u0090\u009d', 'windows-1252'))]).toEqual([
      0x80, 0x81, 0x8d, 0x8f, 0x90, 0x9d,
    ]);
    expect(() => encodePassword(input('\u0080', 'windows-1252'))).toThrow(/representable/);
  });
  it('rejects characters absent from CP1252 without replacing them', () => {
    expect(() => encodePassword(input('Ж', 'windows-1252'))).toThrow(/representable/);
    expect(() => encodePassword(input('😀', 'windows-1252'))).toThrow(/representable/);
  });
  it.each(['\ud800', '\udfff', 'x\ud800z'])('rejects unpaired UTF8 surrogate %j', (text) => {
    expect(() => encodePassword(input(text, 'utf-8'))).toThrow(/surrogate/);
  });
  it('enforces encoded byte limits, including multibyte characters and exact boundaries', () => {
    expect(encodePassword(input('é'.repeat(8), 'utf-8')).length).toBe(16);
    expect(() => encodePassword(input('é'.repeat(9), 'utf-8'))).toThrow(/16-byte/);
    expect(encodePassword(input('x'.repeat(16))).length).toBe(16);
    expect(() => encodePassword(input('x'.repeat(17)))).toThrow(/16-byte/);
    expect(encodeRecoveryEmail(input('x'.repeat(55))).length).toBe(55);
    expect(() => encodeRecoveryEmail(input('x'.repeat(56)))).toThrow(/55-byte/);
  });
  it.each(['ascii', 'windows-1252', 'utf-8', 'hex'] as const)('rejects NUL in %s', (encoding) => {
    expect(() => encodePassword(input(encoding === 'hex' ? '00' : '\0', encoding))).toThrow(/NUL/);
    expect(() =>
      encodeRecoveryEmail(input(encoding === 'hex' ? '61 00' : 'a\0', encoding)),
    ).toThrow(/NUL/);
  });
  it('HEX accepts only complete byte pairs and explicit ASCII-space syntax', () => {
    expect([...encodePassword(input(' 41ff 82  20 ', 'hex'))]).toEqual([65, 255, 130, 32]);
    for (const text of ['a', 'a b', '0x41', '41\t42', '41\n42', 'zz'])
      expect(() => encodePassword(input(text, 'hex'))).toThrow();
    expect(encodePassword(input('   ', 'hex')).length).toBe(0);
    expect(() => encodePassword(input('aa'.repeat(17), 'hex'))).toThrow(/16-byte/);
  });
  it('decodes strict UTF8 without stripping BOM or replacing malformed input', () => {
    const bom = Uint8Array.of(0xef, 0xbb, 0xbf, 65);
    expect(decodePassword(bom, 'utf-8').text).toBe('\ufeffA');
    for (const bytes of [
      Uint8Array.of(0xc0, 0xaf),
      Uint8Array.of(0xed, 0xa0, 0x80),
      Uint8Array.of(0xff),
    ]) {
      const decoded = decodePassword(bytes, 'utf-8');
      expect(decoded).toMatchObject({
        encoding: 'hex',
        requestedEncoding: 'utf-8',
        fallback: true,
      });
      expect(decoded.reason).toMatch(/round-trip/);
      expect([...encodePassword(input(decoded.text, decoded.encoding))]).toEqual([...bytes]);
    }
  });
  it('ASCII decode falls back to exact annotated HEX and never assumes an old ACP', () => {
    expect(decodeRecoveryEmail(Uint8Array.of(0x80))).toMatchObject({
      text: '80',
      rawHex: '80',
      encoding: 'hex',
      requestedEncoding: 'ascii',
      fallback: true,
    });
    expect(decodeRecoveryEmail(Uint8Array.of(0x80), 'windows-1252').text).toBe('€');
  });
  it('supports56-byte legacy email reads without allowing a56-byte write', () => {
    const bytes = new Uint8Array(56).fill(65);
    expect(decodeRecoveryEmail(bytes).text).toBe('A'.repeat(56));
    expect(() => encodeRecoveryEmail(input('A'.repeat(56)))).toThrow();
    expect(() => decodeRecoveryEmail(new Uint8Array(57).fill(65))).toThrow();
    expect(() => decodePassword(new Uint8Array(17).fill(65))).toThrow();
    expect(() => decodePassword(Uint8Array.of(0))).toThrow(/NUL/);
  });
  it('does not mutate byte inputs or share returned encoded buffers', () => {
    const bytes = Uint8Array.of(0x80, 65),
      copy = bytes.slice();
    decodePassword(bytes, 'utf-8');
    expect(bytes).toEqual(copy);
    const first = encodePassword(input('a')),
      second = encodePassword(input('a'));
    first.fill(0);
    expect([...second]).toEqual([97]);
  });
});

describe('recovered native email grammar', () => {
  it.each([
    'a+b@example.com',
    'a.b@example.co.uk',
    'person@example.technology',
    '""@example.com',
    '"a b\\\"c"@example.com',
    '<a@example.com>',
    'Display Name <a@example.com>',
    '"A, B" <a@example.com>',
    'a@[127.0.0.1]',
    'a@[000.001.099.255]',
    'a@[IPv6:2001:db8::1]',
    'a@[tag:"]',
    'a@[tag:<x>]',
    'a@[tag:\\]]',
    '\t a@example.com\r\n',
  ])('accepts native grammar fixture %j', (text) => {
    expect(validateNativeRecoveryEmail(text)).toBe(true);
  });
  it.each([
    '',
    'a',
    'a@localhost',
    'a@example.c',
    'a@-example.com',
    'a@example-.com',
    '.a@example.com',
    'a.@example.com',
    'a..b@example.com',
    'a b@example.com',
    'a@[256.0.0.1]',
    'a@[1.2.3]',
    'a@[tag:]',
    'a@[tag:a[b]',
    'Display <a@example.com',
    'a@example.com>',
    'Display a@example.com',
    '"a\\"@example.com',
    '"é"@example.com',
    'a@éxample.com',
    '\u00a0a@example.com\u00a0',
    'a@exam\nple.com',
  ])('rejects native grammar fixture %j', (text) => {
    expect(validateNativeRecoveryEmail(text)).toBe(false);
  });
  it('validates a temporary ASCII trim but preserves exact transmitted spaces', () => {
    expect([...validateRecoveryEmailInput(input(' a@example.com '))]).toEqual([
      ...new TextEncoder().encode(' a@example.com '),
    ]);
  });
  it('validates decoded HEX address bytes rather than HEX notation', () => {
    const hex = '61 40 65 78 61 6d 70 6c 65 2e 63 6f 6d';
    expect(new TextDecoder().decode(validateRecoveryEmailInput(input(hex, 'hex')))).toBe(
      'a@example.com',
    );
    expect(() => validateRecoveryEmailInput(input('ff', 'hex'))).toThrow(/grammar/);
    expect(() => validateRecoveryEmailInput(input('not an address'))).toThrow(/grammar/);
  });
});

describe('native password-change form contract', () => {
  it('requires protected current credential and explicit valid email for a set', () => {
    expect(() => validatePasswordChangeInput(change({ protected: true }))).toThrow(
      /current password/,
    );
    expect(() =>
      validatePasswordChangeInput(change({ protected: true, oldPassword: input('') })),
    ).toThrow();
    expect(() => validatePasswordChangeInput(change({ email: input('') }))).toThrow(/grammar/);
    const prepared = validatePasswordChangeInput(
      change({ protected: true, oldPassword: input('€', 'windows-1252') }),
    );
    expect([...prepared.oldPassword!]).toEqual([0x80]);
    expect(new TextDecoder().decode(prepared.newPassword)).toBe('secret');
    expect(new TextDecoder().decode(prepared.email)).toBe('person@example.com');
  });
  it('checks exact new/retype text and encoding before equivalent bytes', () => {
    for (const confirm of [input('Secret'), input('secret', 'utf-8')])
      expect(() => validatePasswordChangeInput(change({ retypePassword: confirm }))).toThrow(
        /match exactly/,
      );
    expect(() =>
      validatePasswordChangeInput(
        change({ newPassword: input('61 62', 'hex'), retypePassword: input('6162', 'hex') }),
      ),
    ).toThrow(/match exactly/);
  });
  it('permits explicit clear with empty email, or a native-valid retained email', () => {
    const blank = { newPassword: input(''), retypePassword: input('') };
    const cleared = validatePasswordChangeInput(change({ ...blank, email: input('') }));
    expect(cleared.newPassword.length).toBe(0);
    expect(cleared.email.length).toBe(0);
    expect(validatePasswordChangeInput(change(blank)).email.length).toBeGreaterThan(0);
    expect(() => validatePasswordChangeInput(change({ ...blank, email: input('   ') }))).toThrow(
      /grammar/,
    );
  });
  it('does not silently default absent email or retype fields and never embeds secrets in errors', () => {
    expect(() => validatePasswordChangeInput({ ...change(), email: undefined } as never)).toThrow();
    expect(() =>
      validatePasswordChangeInput({ ...change(), retypePassword: undefined } as never),
    ).toThrow();
    try {
      validatePasswordChangeInput(
        change({ newPassword: input('PRIVATE SECRET'), retypePassword: input('different') }),
      );
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE SECRET');
    }
  });
});
