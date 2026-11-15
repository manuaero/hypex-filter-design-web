import { describe, expect, it } from 'vitest';
import {
  createBridgeKeyPair,
  createBridgeCommand,
  deriveBridgeCommandKey,
  sealBridgePayload,
  openBridgePayload,
  validateBridgePublicKey,
  parseBridgeEncryptedPayload,
  parseBridgeEncryptedRequest,
  BRIDGE_PLAINTEXT_LIMIT,
  BridgeCryptoError,
} from '../src/application/bridge-crypto';

const binding = () => ({
  owner: 'site:owner-a',
  session: crypto.randomUUID(),
  commandId: crypto.randomUUID(),
  name: 'fusion_device_read',
});
async function keys() {
  const browser = await createBridgeKeyPair(),
    bound = binding(),
    server = await createBridgeCommand(browser.publicKey, bound),
    browserKey = await deriveBridgeCommandKey(browser.privateKey, server.requestPublicKey, bound);
  return { browser, bound, server, browserKey };
}

describe('encrypted transient Site bridge', () => {
  it('uses nonextractable ephemeral keys, fresh nonces and detached JSON without plaintext in stored envelopes', async () => {
    const { browser, bound, server, browserKey } = await keys();
    expect(browser.privateKey.extractable).toBe(false);
    expect(server.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('jwk', browser.privateKey)).rejects.toThrow();
    const input = { arguments: { credential: 'private-password', email: 'private@example.org' } },
      baseline = structuredClone(input);
    const request = {
      version: 1,
      publicKey: server.requestPublicKey,
      encrypted: await sealBridgePayload(server.key, bound, 'request', input),
    };
    expect(JSON.stringify(request)).not.toMatch(
      /private-password|private@example|arguments|credential/,
    );
    const decoded = await openBridgePayload(
      browserKey,
      bound,
      'request',
      parseBridgeEncryptedRequest(request).encrypted,
    );
    expect(decoded).toEqual(input);
    expect(decoded).not.toBe(input);
    const response = await sealBridgePayload(browserKey, bound, 'result', {
      email: 'private@example.org',
    });
    expect(JSON.stringify(response)).not.toContain('private@example.org');
    expect(await openBridgePayload(server.key, bound, 'result', response)).toEqual({
      email: 'private@example.org',
    });
    const second = await sealBridgePayload(server.key, bound, 'request', input);
    expect(second.iv).not.toBe(request.encrypted.iv);
    expect(input).toEqual(baseline);
  });

  it.each(['owner', 'session', 'commandId', 'name', 'direction'] as const)(
    'authenticates the %s binding and rejects reflected/cross-target ciphertext',
    async (field) => {
      const { bound, server, browserKey } = await keys(),
        cipher = await sealBridgePayload(server.key, bound, 'request', { secret: 'not-in-error' });
      const changed = {
        ...bound,
        [field]:
          field === 'owner'
            ? 'site:owner-b'
            : field === 'name'
              ? 'fusion_state'
              : crypto.randomUUID(),
      };
      await expect(
        openBridgePayload(
          browserKey,
          changed,
          field === 'direction' ? 'result' : 'request',
          cipher,
        ),
      ).rejects.toThrow(BridgeCryptoError);
    },
  );

  it('rejects another session key, corrupted ciphertext, plaintext downgrades and private JWK fields without exposing input', async () => {
    const { bound, server, browserKey, browser } = await keys(),
      other = await createBridgeKeyPair();
    const cipher = await sealBridgePayload(server.key, bound, 'request', {
      secret: 'not-in-error',
    });
    const wrong = await deriveBridgeCommandKey(other.privateKey, server.requestPublicKey, bound);
    await expect(openBridgePayload(wrong, bound, 'request', cipher)).rejects.toThrow(
      BridgeCryptoError,
    );
    const corrupt = {
      ...cipher,
      ciphertext: (cipher.ciphertext[0] === 'A' ? 'B' : 'A') + cipher.ciphertext.slice(1),
    };
    const failure = await openBridgePayload(browserKey, bound, 'request', corrupt).catch(
      (error: unknown) => error,
    );
    expect(String(failure)).not.toContain('not-in-error');
    expect(() =>
      parseBridgeEncryptedRequest({ name: 'fusion_state', arguments: { secret: 'not-in-error' } }),
    ).toThrow(BridgeCryptoError);
    await expect(
      validateBridgePublicKey({ ...browser.publicKey, d: 'private-material' }),
    ).rejects.toThrow(BridgeCryptoError);
    await expect(
      validateBridgePublicKey({ ...browser.publicKey, x: 'A'.repeat(43), y: 'A'.repeat(43) }),
    ).rejects.toThrow(BridgeCryptoError);
    expect(() => parseBridgeEncryptedPayload({ ...cipher, result: 'plaintext' })).toThrow(
      BridgeCryptoError,
    );
  });

  it('retains the full 8 MB UTF-8 plaintext capacity while bounding ciphertext envelopes and rejecting excess before encryption', async () => {
    const { bound, server, browserKey } = await keys();
    const overhead = new TextEncoder().encode(JSON.stringify({ content: '' })).length;
    const value = { content: 'x'.repeat(BRIDGE_PLAINTEXT_LIMIT - overhead) };
    const cipher = await sealBridgePayload(server.key, bound, 'result', value);
    expect(JSON.stringify(cipher).length).toBeLessThan(12_000_000);
    expect(await openBridgePayload(browserKey, bound, 'result', cipher)).toEqual(value);
    await expect(
      sealBridgePayload(server.key, bound, 'result', { content: value.content + 'x' }),
    ).rejects.toThrow('8 MB limit');
    await expect(
      sealBridgePayload(server.key, bound, 'result', { content: '漢'.repeat(2_700_000) }),
    ).rejects.toThrow('8 MB limit');
    expect(() =>
      parseBridgeEncryptedPayload({
        version: 1,
        iv: 'A'.repeat(16),
        ciphertext: 'A'.repeat(11_000_000),
      }),
    ).toThrow(BridgeCryptoError);
  }, 10000);
});
