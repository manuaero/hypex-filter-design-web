import { parseExecutionPrincipal } from './execution-context';

export const BRIDGE_PLAINTEXT_LIMIT = 8_000_000;
export const BRIDGE_ENCRYPTED_BODY_LIMIT = 12_000_000;
export interface BridgePublicKey {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}
export interface BridgeBinding {
  owner: string;
  session: string;
  commandId: string;
  name: string;
}
export interface BridgeEncryptedPayload {
  version: 1;
  iv: string;
  ciphertext: string;
}
export interface BridgeEncryptedRequest {
  version: 1;
  publicKey: BridgePublicKey;
  encrypted: BridgeEncryptedPayload;
}
export type BridgeDirection = 'request' | 'result';
export class BridgeCryptoError extends Error {
  constructor(message = 'Encrypted bridge payload is invalid or authentication failed') {
    super(message);
    this.name = 'BridgeCryptoError';
  }
}
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
export function parseBridgePublicKey(value: unknown): BridgePublicKey {
  if (
    !exact(value, ['kty', 'crv', 'x', 'y']) ||
    value.kty !== 'EC' ||
    value.crv !== 'P-256' ||
    typeof value.x !== 'string' ||
    typeof value.y !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.x) ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.y)
  )
    throw new BridgeCryptoError(
      'A valid public P-256 browser key is required; reload and enable Site agent access',
    );
  return { kty: 'EC', crv: 'P-256', x: value.x, y: value.y };
}
function bindingBytes(binding: BridgeBinding, direction?: BridgeDirection) {
  try {
    parseExecutionPrincipal({ owner: binding.owner, scope: binding.session });
    if (
      !uuid.test(binding.session) ||
      !uuid.test(binding.commandId) ||
      !/^fusion_[a-z0-9_]{1,100}$/.test(binding.name) ||
      (direction !== undefined && direction !== 'request' && direction !== 'result')
    )
      throw new Error();
    return new TextEncoder().encode(
      JSON.stringify([
        'fusion-site-bridge-v1',
        binding.owner,
        binding.session,
        binding.commandId,
        binding.name,
        direction ?? 'key',
      ]),
    );
  } catch {
    throw new BridgeCryptoError('Invalid encrypted bridge command binding');
  }
}
const arrayBuffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768)
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(parts.join(''));
}
function validBase64(text: string): boolean {
  if (text.length % 4) return false;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
    padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0,
    end = text.length - padding;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    if (!(
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) ||
      c === 43 ||
      c === 47
    ))
      return false;
  }
  return !padding || (alphabet.indexOf(text[end - 1]) & (padding === 2 ? 15 : 3)) === 0;
}
function unbase64(text: string, maximum: number): Uint8Array {
  if (text.length > Math.ceil(maximum / 3) * 4 || !validBase64(text)) throw new BridgeCryptoError();
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    throw new BridgeCryptoError();
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length > maximum) {
    bytes.fill(0);
    throw new BridgeCryptoError();
  }
  return bytes;
}
export function parseBridgeEncryptedPayload(value: unknown): BridgeEncryptedPayload {
  if (
    !exact(value, ['version', 'iv', 'ciphertext']) ||
    value.version !== 1 ||
    typeof value.iv !== 'string' ||
    value.iv.length !== 16 ||
    typeof value.ciphertext !== 'string' ||
    value.ciphertext.length < 24 ||
    value.ciphertext.length > Math.ceil((BRIDGE_PLAINTEXT_LIMIT + 16) / 3) * 4 ||
    !validBase64(value.iv) ||
    !validBase64(value.ciphertext)
  )
    throw new BridgeCryptoError();
  return { version: 1, iv: value.iv, ciphertext: value.ciphertext };
}
export function parseBridgeEncryptedRequest(value: unknown): BridgeEncryptedRequest {
  if (!exact(value, ['version', 'publicKey', 'encrypted']) || value.version !== 1)
    throw new BridgeCryptoError();
  return {
    version: 1,
    publicKey: parseBridgePublicKey(value.publicKey),
    encrypted: parseBridgeEncryptedPayload(value.encrypted),
  };
}
async function importPublic(publicKey: BridgePublicKey) {
  try {
    return await crypto.subtle.importKey(
      'jwk',
      parseBridgePublicKey(publicKey),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
  } catch {
    throw new BridgeCryptoError(
      'A valid public P-256 browser key is required; reload and enable Site agent access',
    );
  }
}
export async function validateBridgePublicKey(value: unknown): Promise<BridgePublicKey> {
  const parsed = parseBridgePublicKey(value);
  await importPublic(parsed);
  return parsed;
}
export async function createBridgeKeyPair(): Promise<{
  privateKey: CryptoKey;
  publicKey: BridgePublicKey;
}> {
  try {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
      'deriveBits',
    ]);
    const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
    return {
      privateKey: pair.privateKey,
      publicKey: parseBridgePublicKey({
        kty: exported.kty,
        crv: exported.crv,
        x: exported.x,
        y: exported.y,
      }),
    };
  } catch {
    throw new BridgeCryptoError(
      'Secure browser cryptography is unavailable; reload in a supported secure browser',
    );
  }
}
export async function deriveBridgeCommandKey(
  privateKey: CryptoKey,
  publicKey: BridgePublicKey,
  binding: BridgeBinding,
): Promise<CryptoKey> {
  const info = bindingBytes(binding);
  let secret: Uint8Array | undefined;
  try {
    const remote = await importPublic(publicKey);
    secret = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'ECDH', public: remote }, privateKey, 256),
    );
    const source = await crypto.subtle.importKey('raw', arrayBuffer(secret), 'HKDF', false, [
      'deriveKey',
    ]);
    return await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: arrayBuffer(info) },
      source,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } catch {
    throw new BridgeCryptoError();
  } finally {
    secret?.fill(0);
  }
}
export async function createBridgeCommand(publicKey: BridgePublicKey, binding: BridgeBinding) {
  const pair = await createBridgeKeyPair();
  return {
    key: await deriveBridgeCommandKey(pair.privateKey, publicKey, binding),
    requestPublicKey: pair.publicKey,
  };
}
export function serializeBridgePayload(value: unknown): Uint8Array {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new BridgeCryptoError('Bridge result is not serializable');
  }
  if (serialized === undefined) throw new BridgeCryptoError('Bridge result is not serializable');
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.length > BRIDGE_PLAINTEXT_LIMIT) {
    bytes.fill(0);
    throw new BridgeCryptoError(
      'Inline payload exceeds the hosted 8 MB limit; use fusion_file_export and fusion_file_chunk_read, or file-transfer commands',
    );
  }
  return bytes;
}
export async function sealBridgePayload(
  key: CryptoKey,
  binding: BridgeBinding,
  direction: BridgeDirection,
  value: unknown,
): Promise<BridgeEncryptedPayload> {
  const plain = serializeBridgePayload(value),
    iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: arrayBuffer(iv),
        additionalData: arrayBuffer(bindingBytes(binding, direction)),
        tagLength: 128,
      },
      key,
      arrayBuffer(plain),
    );
    return { version: 1, iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
  } catch {
    throw new BridgeCryptoError();
  } finally {
    plain.fill(0);
  }
}
export async function openBridgePayload(
  key: CryptoKey,
  binding: BridgeBinding,
  direction: BridgeDirection,
  value: unknown,
): Promise<unknown> {
  const parsed = parseBridgeEncryptedPayload(value);
  let iv: Uint8Array | undefined, ciphertext: Uint8Array | undefined, plain: Uint8Array | undefined;
  try {
    iv = unbase64(parsed.iv, 12);
    ciphertext = unbase64(parsed.ciphertext, BRIDGE_PLAINTEXT_LIMIT + 16);
    if (iv.length !== 12 || ciphertext.length < 16) throw new BridgeCryptoError();
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: arrayBuffer(iv),
          additionalData: arrayBuffer(bindingBytes(binding, direction)),
          tagLength: 128,
        },
        key,
        arrayBuffer(ciphertext),
      ),
    );
    if (plain.length > BRIDGE_PLAINTEXT_LIMIT) throw new BridgeCryptoError();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } catch {
    throw new BridgeCryptoError();
  } finally {
    iv?.fill(0);
    ciphertext?.fill(0);
    plain?.fill(0);
  }
}
