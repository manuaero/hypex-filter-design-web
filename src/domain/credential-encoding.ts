import { z } from 'zod';
import {
  MAX_PASSWORD_BYTES,
  MAX_RECOVERY_EMAIL_BYTES,
  RECOVERY_EMAIL_STORAGE_BYTES,
} from '../hardware/password';

export type CredentialEncoding = 'ascii' | 'windows-1252' | 'utf-8' | 'hex';
export interface CredentialInput {
  text: string;
  encoding: CredentialEncoding;
}
export const credentialInputSchema = z.strictObject({
  text: z.string(),
  encoding: z.enum(['ascii', 'windows-1252', 'utf-8', 'hex']).default('ascii'),
});
export interface DecodedCredential extends CredentialInput {
  requestedEncoding: CredentialEncoding;
  rawHex: string;
  fallback: boolean;
  reason?: string;
}

const cp1252Decoder = new TextDecoder('windows-1252', { fatal: true, ignoreBOM: true });
const cp1252Reverse = new Map<string, number>();
for (let byte = 0; byte <= 255; byte++) {
  const character = cp1252Decoder.decode(Uint8Array.of(byte));
  if (cp1252Reverse.has(character)) throw new Error('Ambiguous Windows-1252 codec');
  cp1252Reverse.set(character, byte);
}
const hexOf = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');

function assertScalarText(text: string) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error('Credential contains an unpaired surrogate');
    } else if (code >= 0xdc00 && code <= 0xdfff)
      throw new Error('Credential contains an unpaired surrogate');
  }
}
function parseHex(text: string): Uint8Array {
  // Only ASCII spaces between complete byte pairs are syntax. No other whitespace,
  // 0x prefix, character substitution or half-byte separators are accepted.
  const values: number[] = [];
  for (let i = 0; i < text.length;) {
    if (text[i] === ' ') {
      i++;
      continue;
    }
    const pair = text.slice(i, i + 2);
    if (!/^[\da-fA-F]{2}$/.test(pair))
      throw new Error('HEX credentials require complete hexadecimal byte pairs');
    values.push(Number.parseInt(pair, 16));
    i += 2;
  }
  return Uint8Array.from(values);
}
function encode(input: CredentialInput, maximum: number, label: string): Uint8Array {
  const parsed = credentialInputSchema.safeParse(input);
  if (!parsed.success) throw new Error('Credential input or encoding is invalid');
  const { text, encoding } = parsed.data;
  let bytes: Uint8Array;
  if (encoding === 'hex') {
    // An enormous string of spaces is valid syntax but must not allocate a byte
    // array before checking the actual encoded byte budget.
    const digits = text.replaceAll(' ', '');
    if (digits.length > maximum * 2) throw new Error(`${label} exceeds the ${maximum}-byte limit`);
    bytes = parseHex(text);
  } else if (encoding === 'utf-8') {
    assertScalarText(text);
    if (text.length > maximum) throw new Error(`${label} exceeds the ${maximum}-byte limit`);
    bytes = new TextEncoder().encode(text);
  } else {
    if (text.length > maximum) throw new Error(`${label} exceeds the ${maximum}-byte limit`);
    const values: number[] = [];
    for (const character of text) {
      const value =
        encoding === 'ascii'
          ? character.codePointAt(0)! <= 127
            ? character.codePointAt(0)!
            : undefined
          : cp1252Reverse.get(character);
      if (value === undefined)
        throw new Error(`Credential is not representable in the selected encoding`);
      values.push(value);
    }
    bytes = Uint8Array.from(values);
  }
  if (bytes.length > maximum) {
    bytes.fill(0);
    throw new Error(`${label} exceeds the ${maximum}-byte limit`);
  }
  if (bytes.includes(0)) {
    bytes.fill(0);
    throw new Error(`${label} cannot contain NUL bytes`);
  }
  return bytes;
}
/** Explicit byte encoding only; ASCII spaces and case are credential data. */
export const encodePassword = (input: CredentialInput) =>
  encode(input, MAX_PASSWORD_BYTES, 'Password');
/** Wire representability only; use validateRecoveryEmailInput for a native form action. */
export const encodeRecoveryEmail = (input: CredentialInput) =>
  encode(input, MAX_RECOVERY_EMAIL_BYTES, 'Recovery email');

function decode(
  bytes: Uint8Array,
  preferredEncoding: CredentialEncoding,
  maximum: number,
): DecodedCredential {
  if (!(bytes instanceof Uint8Array) || bytes.length > maximum)
    throw new Error('Credential byte length is invalid');
  if (bytes.includes(0)) throw new Error('Credential cannot contain NUL bytes');
  if (!['ascii', 'windows-1252', 'utf-8', 'hex'].includes(preferredEncoding))
    throw new Error('Credential encoding is invalid');
  const rawHex = hexOf(bytes);
  if (preferredEncoding === 'hex')
    return {
      text: rawHex,
      encoding: 'hex',
      requestedEncoding: preferredEncoding,
      rawHex,
      fallback: false,
    };
  let text: string;
  try {
    if (preferredEncoding === 'ascii') {
      if (bytes.some((byte) => byte > 127)) throw new Error();
      text = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
    } else if (preferredEncoding === 'windows-1252') text = cp1252Decoder.decode(bytes);
    else text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const roundTrip = encode({ text, encoding: preferredEncoding }, maximum, 'Credential');
    try {
      if (roundTrip.length !== bytes.length || roundTrip.some((byte, i) => byte !== bytes[i]))
        throw new Error();
    } finally {
      roundTrip.fill(0);
    }
    return {
      text,
      encoding: preferredEncoding,
      requestedEncoding: preferredEncoding,
      rawHex,
      fallback: false,
    };
  } catch {
    return {
      text: rawHex,
      encoding: 'hex',
      requestedEncoding: preferredEncoding,
      rawHex,
      fallback: true,
      reason: 'Stored bytes do not round-trip in the selected encoding; exact HEX is shown',
    };
  }
}
export const decodePassword = (
  bytes: Uint8Array,
  preferredEncoding: CredentialEncoding = 'ascii',
) => decode(bytes, preferredEncoding, MAX_PASSWORD_BYTES);
/** A legacy read may contain all56 stored bytes even though new writes allow55. */
export const decodeRecoveryEmail = (
  bytes: Uint8Array,
  preferredEncoding: CredentialEncoding = 'ascii',
) => decode(bytes, preferredEncoding, RECOVERY_EMAIL_STORAGE_BYTES);

const atom = /^[a-zA-Z\d!#$%&'*+\-/=?^_`{|}~]+$/;
function quotedEnd(text: string, start: number): number {
  if (text[start] !== '"') return -1;
  for (let i = start + 1; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 1 || code > 127) return -1;
    if (text[i] === '"') return i + 1;
    if (text[i] === '\\') {
      const escaped = text.charCodeAt(++i);
      if (!(escaped >= 1 && escaped <= 127)) return -1;
    }
  }
  return -1;
}
function validDisplayName(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      i = quotedEnd(text, i);
      if (i < 0) return false;
    } else {
      const start = i;
      while (i < text.length && atom.test(text[i])) i++;
      if (i === start) return false;
    }
    while (text[i] === ' ') i++;
  }
  return true;
}
function validDomain(text: string): boolean {
  if (/^(?:(?!-)[a-zA-Z\d-]+(?<!-)\.)+[a-zA-Z]{2,}$/.test(text)) return true;
  if (!text.startsWith('[') || !text.endsWith(']')) return false;
  const literal = text.slice(1, -1);
  if (
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(literal) &&
    literal.split('.').every((n) => Number(n) <= 255)
  )
    return true;
  const separator = literal.indexOf(':');
  if (separator < 1 || !/^[a-zA-Z\d-]*[a-zA-Z\d]$/.test(literal.slice(0, separator))) return false;
  const body = literal.slice(separator + 1);
  if (!body.length) return false;
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    if (code < 1 || code > 127 || body[i] === '[' || body[i] === ']') return false;
    if (body[i] === '\\') {
      const escaped = body.charCodeAt(++i);
      if (!(escaped >= 1 && escaped <= 127)) return false;
    }
  }
  return true;
}
function validAddress(text: string): boolean {
  const localEnd = text.startsWith('"') ? quotedEnd(text, 0) : text.indexOf('@');
  if (localEnd < 0 || text[localEnd] !== '@') return false;
  const local = text.slice(0, localEnd);
  if (
    !(local.startsWith('"')
      ? quotedEnd(local, 0) === local.length
      : local.split('.').every((part) => atom.test(part)))
  )
    return false;
  return validDomain(text.slice(localEnd + 1));
}
/**
 * Native cf61c4 grammar (cf64a0 temporary Trim42e564), expressed without PCRE
 * atomic/conditional groups. Trimming is ASCII codeunits<=0x20, never JS trim.
 * Validation never alters the string later encoded for transmission.
 */
export function validateNativeRecoveryEmail(input: string): boolean {
  if (typeof input !== 'string') return false;
  let text = input.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
  if (!text.length) return false;
  if (validAddress(text)) return true;
  let angle = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      const next = quotedEnd(text, i);
      if (next < 0) return false;
      i = next - 1;
    } else if (text[i] === '<') {
      angle = i;
      break;
    } else if (text[i] === '@') return false;
  }
  if (angle >= 0) {
    if (!text.endsWith('>') || !validDisplayName(text.slice(0, angle))) return false;
    text = text.slice(angle + 1, -1);
  }
  return validAddress(text);
}
/** Native form grammar after explicit encoding; HEX syntax is not email text. */
export function validateRecoveryEmailInput(input: CredentialInput): Uint8Array {
  const bytes = encodeRecoveryEmail(input);
  const validationText =
    input.encoding === 'hex'
      ? Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
      : input.text;
  if (!validateNativeRecoveryEmail(validationText)) {
    bytes.fill(0);
    throw new Error('Recovery email does not match the native address grammar');
  }
  return bytes;
}
export interface PasswordChangeInput {
  oldPassword?: CredentialInput;
  newPassword: CredentialInput;
  retypePassword: CredentialInput;
  email: CredentialInput;
  protected: boolean;
}
/** Returns owned buffers; the caller must wipe all returned buffers after use. */
export function validatePasswordChangeInput(input: PasswordChangeInput): {
  oldPassword?: Uint8Array;
  newPassword: Uint8Array;
  email: Uint8Array;
} {
  if (!input || typeof input.protected !== 'boolean')
    throw new Error('Password change input is invalid');
  const next = credentialInputSchema.safeParse(input.newPassword),
    retype = credentialInputSchema.safeParse(input.retypePassword);
  if (
    !next.success ||
    !retype.success ||
    next.data.text !== retype.data.text ||
    next.data.encoding !== retype.data.encoding
  )
    throw new Error('New password and retyped text and encoding must match exactly');
  let oldPassword: Uint8Array | undefined,
    newPassword: Uint8Array | undefined,
    email: Uint8Array | undefined;
  try {
    if (input.oldPassword !== undefined) oldPassword = encodePassword(input.oldPassword);
    if (input.protected && !oldPassword?.length)
      throw new Error('The current password is required for a protected panel');
    newPassword = encodePassword(next.data);
    email = encodeRecoveryEmail(input.email);
    if (newPassword.length || email.length) {
      email.fill(0);
      email = validateRecoveryEmailInput(input.email);
    }
    return { ...(oldPassword ? { oldPassword } : {}), newPassword, email };
  } catch (error) {
    oldPassword?.fill(0);
    newPassword?.fill(0);
    email?.fill(0);
    throw error;
  }
}
