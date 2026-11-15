// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://studio.example"}
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SiteAgentBridge from '../src/components/SiteAgentBridge';
import {
  createBridgeCommand,
  sealBridgePayload,
  openBridgePayload,
  type BridgeBinding,
  type BridgePublicKey,
} from '../src/application/bridge-crypto';

type Reply = { ok: boolean; json: () => Promise<unknown> };
function deferred<T>() {
  let resolve!: (value?: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = (value) => r(value as T);
    reject = j;
  });
  return { promise, resolve, reject };
}
const reply = (data: unknown): Reply => ({ ok: true, json: async () => data });
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function harness(
  options: {
    onAuthenticated?: (context: Readonly<{ owner: string; scope: string }>) => () => void;
    start?: ReturnType<typeof deferred<Reply>>;
  } = {},
) {
  const polls: ReturnType<typeof deferred<Reply>>[] = [],
    requests: { path: string; body: Record<string, unknown> }[] = [],
    execute = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true })),
    commandKeys = new Map<string, { key: CryptoKey; binding: BridgeBinding }>();
  let scope = '',
    publicKey: BridgePublicKey,
    authenticated = options.onAuthenticated,
    authorityReady = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push({ path, body });
      if (path.endsWith('/session') && body.action === 'start') {
        scope = body.session;
        publicKey = body.publicKey;
        return (
          options.start?.promise ?? reply({ ok: true, context: { owner: 'site:owner-a', scope } })
        );
      }
      if (path.endsWith('/next')) {
        const pending = deferred<Reply>();
        polls.push(pending);
        return pending.promise;
      }
      return reply({ ok: true });
    }),
  );
  const until = async (assertion: () => void) => {
    await vi.waitFor(async () => {
      await act(async () => {
        await Promise.resolve();
      });
      assertion();
    });
  };
  const render = async () =>
    act(async () =>
      root.render(
        <SiteAgentBridge
          execute={execute}
          onAuthenticated={authenticated}
          authorityReady={authorityReady}
        />,
      ),
    );
  const beginEnable = async () => {
    await render();
    const button = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Enable Site'),
    )!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
  };
  const enable = async () => {
    const count = polls.length;
    await beginEnable();
    await until(() => expect(polls.length).toBe(count + 1));
  };
  const disable = () =>
    act(async () => {
      [...host.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('Disable access'))!
        .click();
    });
  const context = () => ({ owner: 'site:owner-a', scope });
  const deliver = async (
    index: number,
    args: unknown = {},
    options: {
      id?: string;
      context?: ReturnType<typeof context>;
      corrupt?: boolean;
      plaintext?: boolean;
    } = {},
  ) => {
    const id = options.id ?? crypto.randomUUID(),
      ctx = options.context ?? context(),
      binding = { owner: ctx.owner, session: ctx.scope, commandId: id, name: 'fusion_state' },
      command = await createBridgeCommand(publicKey, binding),
      encrypted = await sealBridgePayload(command.key, binding, 'request', { arguments: args });
    commandKeys.set(id, { key: command.key, binding });
    if (options.corrupt)
      encrypted.ciphertext =
        (encrypted.ciphertext[0] === 'A' ? 'B' : 'A') + encrypted.ciphertext.slice(1);
    await act(async () =>
      polls[index].resolve(
        reply({
          command: {
            id,
            name: binding.name,
            context: ctx,
            ...(options.plaintext
              ? { arguments: args }
              : { payload: { version: 1, publicKey: command.requestPublicKey, encrypted } }),
          },
        }),
      ),
    );
    return id;
  };
  const results = () => requests.filter((request) => request.path.endsWith('/result'));
  const resultAt = async (index: number) => {
    const body = results()[index].body,
      command = commandKeys.get(String(body.id))!;
    const opened = (await openBridgePayload(
      command.key,
      command.binding,
      'result',
      body.encrypted,
    )) as { result: unknown };
    return opened.result;
  };
  return {
    polls,
    requests,
    execute,
    enable,
    beginEnable,
    disable,
    context,
    deliver,
    until,
    results,
    resultAt,
    rerender: async (next: typeof authenticated, ready = true) => {
      authenticated = next;
      authorityReady = ready;
      await render();
    },
  };
}

it('publishes only a public pairing key and executes decrypted arguments with separate trusted metadata', async () => {
  const h = harness();
  await h.enable();
  const args = {
    credential: 'private-password',
    context: { owner: 'forged-owner', scope: 'forged-scope' },
  };
  await h.deliver(0, args);
  await h.until(() => expect(h.results()).toHaveLength(1));
  expect(h.execute).toHaveBeenCalledExactlyOnceWith('fusion_state', args, h.context());
  expect(await h.resultAt(0)).toEqual({ ok: true });
  expect(h.requests[0].body.publicKey).toMatchObject({ kty: 'EC', crv: 'P-256' });
  expect(h.requests[0].body.publicKey).not.toHaveProperty('d');
  expect(h.results()[0].body).not.toHaveProperty('result');
  expect(JSON.stringify(h.requests)).not.toMatch(/private-password|forged-owner/);
});

it.each(['owner', 'scope'] as const)(
  'rejects another authenticated %s before execution',
  async (field) => {
    const h = harness();
    await h.enable();
    await h.deliver(
      0,
      {},
      {
        context: {
          ...h.context(),
          [field]: field === 'owner' ? 'site:other-owner' : crypto.randomUUID(),
        },
      },
    );
    await h.until(() =>
      expect(host.textContent).toContain('does not belong to this browser session'),
    );
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.results()).toHaveLength(0);
  },
);

it.each(['corrupt', 'plaintext'] as const)(
  'rejects %s requests without executing or revealing arguments',
  async (failure) => {
    const h = harness();
    await h.enable();
    await h.deliver(0, { secret: 'do-not-reveal' }, { [failure]: true });
    await h.until(() => expect(host.textContent).toContain('authentication failed'));
    expect(h.execute).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('do-not-reveal');
  },
);

it('does not execute a late poll after disable and uses a fresh key/session after re-enable', async () => {
  const h = harness();
  await h.enable();
  const old = h.context();
  await h.disable();
  await h.deliver(0);
  expect(h.execute).not.toHaveBeenCalled();
  await h.enable();
  expect(h.context().scope).not.toBe(old.scope);
  await h.deliver(1);
  await h.until(() => expect(h.results()).toHaveLength(1));
  expect(h.execute).toHaveBeenCalledExactlyOnceWith('fusion_state', {}, h.context());
  expect(h.requests.some((request) => request.body.action === 'stop')).toBe(true);
});

it('allows an executing command to finish and posts only encrypted result after disable', async () => {
  const h = harness(),
    completion = deferred<{ ok: boolean; email: string }>();
  h.execute.mockImplementation(() => completion.promise);
  await h.enable();
  await h.deliver(0);
  await h.until(() => expect(h.execute).toHaveBeenCalledTimes(1));
  await h.disable();
  expect(h.requests.some((request) => request.body.action === 'stop')).toBe(false);
  await act(async () => completion.resolve({ ok: true, email: 'private@example.org' }));
  await h.until(() => expect(h.results()).toHaveLength(1));
  expect(await h.resultAt(0)).toEqual({ ok: true, email: 'private@example.org' });
  expect(JSON.stringify(h.requests)).not.toContain('private@example.org');
  expect(h.requests.some((request) => request.body.action === 'stop')).toBe(true);
});

it('ignores an obsolete poll failure after a new keyed session is enabled', async () => {
  const h = harness();
  await h.enable();
  await h.disable();
  await h.enable();
  await act(async () => h.polls[0].reject(new Error('Old session failed')));
  expect(host.textContent).not.toContain('Old session failed');
  await h.deliver(1);
  await h.until(() => expect(h.results()).toHaveLength(1));
  expect(h.execute).toHaveBeenCalledTimes(1);
});

it('stops accepting new commands after result delivery fails without retrying the operation', async () => {
  const h = harness();
  await h.enable();
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/result'))
      throw new Error('Result delivery unavailable; inspect the application');
    return originalFetch(input, init);
  });
  await h.deliver(0);
  await h.until(() => expect(host.textContent).toContain('Result delivery unavailable'));
  expect(h.execute).toHaveBeenCalledTimes(1);
  expect(h.polls).toHaveLength(1);
  expect(h.requests.some((request) => request.body.action === 'stop')).toBe(true);
});

it('rechecks disable after asynchronous decryption before invoking the application', async () => {
  const h = harness(),
    release = deferred<void>(),
    started = deferred<void>(),
    decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'decrypt').mockImplementationOnce(async (...args) => {
    const plain = await decrypt(...args);
    started.resolve();
    await release.promise;
    return plain;
  });
  await h.enable();
  await h.deliver(0);
  await started.promise;
  await h.disable();
  await act(async () => release.resolve());
  expect(h.execute).not.toHaveBeenCalled();
});

it('returns oversized UTF-8 results as an encrypted bounded error and continues polling', async () => {
  const h = harness(),
    original = { ok: true, content: '漢'.repeat(2_700_000) };
  h.execute
    .mockResolvedValueOnce(original)
    .mockResolvedValueOnce({ ok: true, marker: 'next command' });
  await h.enable();
  await h.deliver(0);
  await h.until(() => expect(h.results()).toHaveLength(1));
  expect(await h.resultAt(0)).toMatchObject({
    ok: false,
    error: expect.stringContaining('fusion_file_export'),
  });
  expect(new TextEncoder().encode(JSON.stringify(h.results()[0].body)).length).toBeLessThan(12e6);
  expect(original.content).toHaveLength(2_700_000);
  await h.until(() => expect(h.polls).toHaveLength(2));
  await h.deliver(1);
  await h.until(() => expect(h.results()).toHaveLength(2));
  expect(await h.resultAt(1)).toEqual({ ok: true, marker: 'next command' });
});

it('preserves the original full-envelope 8 MB plaintext boundary with encrypted-body headroom', async () => {
  const h = harness();
  await h.enable();
  const id = crypto.randomUUID();
  const overhead = new TextEncoder().encode(
    JSON.stringify({ session: h.context().scope, id, result: { ok: true, content: '' } }),
  ).length;
  h.execute.mockResolvedValueOnce({ ok: true, content: 'x'.repeat(8e6 - overhead) });
  await h.deliver(0, {}, { id });
  await h.until(() => expect(h.results()).toHaveLength(1));
  expect(((await h.resultAt(0)) as { content: string }).content).toHaveLength(8e6 - overhead);
  expect(JSON.stringify(h.results()[0].body).length).toBeGreaterThan(8e6);
  expect(JSON.stringify(h.results()[0].body).length).toBeLessThan(12e6);
  h.execute.mockResolvedValueOnce({ ok: true, content: 'x'.repeat(8e6 - overhead + 1) });
  await h.until(() => expect(h.polls).toHaveLength(2));
  await h.deliver(1);
  await h.until(() => expect(h.results()).toHaveLength(2));
  expect(await h.resultAt(1)).toMatchObject({
    ok: false,
    error: expect.stringContaining('8 MB limit'),
  });
}, 10000);

it('registers exact authenticated raw identity once and revokes immediately on Disable before late polls can execute', async () => {
  const revoke = vi.fn(),
    register = vi.fn((_raw: Readonly<{ owner: string; scope: string }>) => revoke),
    h = harness({ onAuthenticated: register });
  await h.enable();
  expect(register).toHaveBeenCalledExactlyOnceWith(h.context());
  expect(Object.isFrozen(register.mock.calls[0][0])).toBe(true);
  await h.disable();
  expect(revoke).toHaveBeenCalledTimes(1);
  await h.deliver(0, { context: { owner: 'forged', scope: 'forged' } });
  expect(h.execute).not.toHaveBeenCalled();
  expect(register).toHaveBeenCalledTimes(1);
});

it.each(['Disable', 'unmount'] as const)(
  'does not enroll a late start response after%s, and stops its server lease after delivery',
  async (action) => {
    const start = deferred<Reply>(),
      register = vi.fn(() => vi.fn()),
      h = harness({ onAuthenticated: register, start });
    await h.beginEnable();
    await h.until(() =>
      expect(h.requests.some((request) => request.body.action === 'start')).toBe(true),
    );
    if (action === 'Disable') await h.disable();
    else await act(async () => root.render(null));
    const stops = h.requests.filter((request) => request.body.action === 'stop').length;
    await act(async () => start.resolve(reply({ ok: true, context: h.context() })));
    await h.until(() =>
      expect(h.requests.filter((request) => request.body.action === 'stop').length).toBeGreaterThan(
        stops,
      ),
    );
    expect(register).not.toHaveBeenCalled();
    expect(h.polls).toHaveLength(0);
    expect(h.execute).not.toHaveBeenCalled();
  },
);

it('callback prop changes do not reconnect and old cleanup cannot revoke a new session lease', async () => {
  const revokeOld = vi.fn(),
    revokeNew = vi.fn(),
    old = vi.fn(() => revokeOld),
    next = vi.fn(() => revokeNew),
    h = harness({ onAuthenticated: old });
  await h.enable();
  const previous = h.context();
  await h.rerender(next);
  expect(h.requests.filter((request) => request.body.action === 'start')).toHaveLength(1);
  expect(next).not.toHaveBeenCalled();
  await h.disable();
  expect(revokeOld).toHaveBeenCalledTimes(1);
  await h.enable();
  expect(next).toHaveBeenCalledExactlyOnceWith(h.context());
  expect(h.context().scope).not.toBe(previous.scope);
  await act(async () => h.polls[0].reject(new Error('Late old poll failure')));
  expect(revokeNew).not.toHaveBeenCalled();
  await h.deliver(1);
  await h.until(() => expect(h.results()).toHaveLength(1));
  expect(revokeNew).not.toHaveBeenCalled();
});

it('revokes new admission while allowing an in-flight operation and its original encrypted result to finish after Disable', async () => {
  const revoke = vi.fn(),
    h = harness({ onAuthenticated: () => revoke }),
    completion = deferred<unknown>();
  h.execute.mockImplementationOnce(() => completion.promise);
  await h.enable();
  const raw = h.context();
  await h.deliver(0);
  await h.until(() => expect(h.execute).toHaveBeenCalledTimes(1));
  await h.disable();
  expect(revoke).toHaveBeenCalledTimes(1);
  expect(h.requests.some((request) => request.body.action === 'stop')).toBe(false);
  await act(async () => completion.resolve({ ok: true, done: 'old admitted operation' }));
  await h.until(() => expect(h.results()).toHaveLength(1));
  expect(await h.resultAt(0)).toEqual({ ok: true, done: 'old admitted operation' });
  expect(h.results()[0].body.session).toBe(raw.scope);
  expect(h.execute.mock.calls[0][2]).toEqual(raw);
  expect(revoke).toHaveBeenCalledTimes(1);
  expect(h.polls).toHaveLength(1);
});

it('heartbeat failure revokes immediately during an operation, stops future polling and still delivers its original encrypted result', async () => {
  const interval = vi.spyOn(globalThis, 'setInterval'),
    revoke = vi.fn(),
    h = harness({ onAuthenticated: () => revoke }),
    completion = deferred<unknown>();
  h.execute.mockImplementationOnce(() => completion.promise);
  await h.enable();
  await h.deliver(0);
  await h.until(() => expect(h.execute).toHaveBeenCalledTimes(1));
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (JSON.parse(String(init?.body)).action === 'heartbeat') throw new Error('Lease replaced');
    return original(input, init);
  });
  const heartbeat = interval.mock.calls.find((call) => call[1] === 4000)![0];
  await act(async () => {
    if (typeof heartbeat === 'function') heartbeat();
  });
  await h.until(() => expect(revoke).toHaveBeenCalledTimes(1));
  expect(h.requests.some((request) => request.body.action === 'stop')).toBe(false);
  await act(async () => completion.resolve({ ok: true }));
  await h.until(() => expect(h.results()).toHaveLength(1));
  expect(await h.resultAt(0)).toEqual({ ok: true });
  expect(h.polls).toHaveLength(1);
});

it('revokes on unmount and result-delivery failure, while an unready authority cannot enable Site access', async () => {
  const revoke = vi.fn(),
    h = harness({ onAuthenticated: () => revoke });
  await h.rerender(() => revoke, false);
  expect(
    [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Enable Site'),
    )!.disabled,
  ).toBe(true);
  expect(h.requests).toHaveLength(0);
  await h.rerender(() => revoke, true);
  await h.enable();
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/result')) throw new Error('Delivery failed');
    return original(input, init);
  });
  await h.deliver(0);
  await h.until(() => expect(host.textContent).toContain('Delivery failed'));
  expect(revoke).toHaveBeenCalledTimes(1);
  await act(async () => root.render(null));
  expect(revoke).toHaveBeenCalledTimes(1);
});

it('a failed authority enrollment never polls or executes, and a live lease is revoked exactly once on unmount', async () => {
  const register = vi.fn(() => {
      throw new Error('Workspace authority is not ready');
    }),
    rejected = harness({ onAuthenticated: register });
  await rejected.beginEnable();
  await rejected.until(() =>
    expect(host.textContent).toContain('Workspace authority is not ready'),
  );
  expect(rejected.polls).toHaveLength(0);
  expect(rejected.execute).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  const revoke = vi.fn(),
    accepted = harness({ onAuthenticated: () => revoke });
  await accepted.enable();
  await act(async () => root.render(null));
  expect(revoke).toHaveBeenCalledTimes(1);
  await accepted.deliver(0);
  expect(accepted.execute).not.toHaveBeenCalled();
  expect(revoke).toHaveBeenCalledTimes(1);
});
