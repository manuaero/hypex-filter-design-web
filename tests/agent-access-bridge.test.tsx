// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { ToolAdapter } from '../src/application/tools';
import type {
  WorkspaceAuthority,
  WorkspaceAuthoritySnapshot,
} from '../src/application/workspace-authority';
import { createWorkspaceAuthority } from '../src/application/workspace-authority';
import { webcrypto } from 'node:crypto';
const mocks = vi.hoisted(() => ({
  execute: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true })),
  register: vi.fn(),
  site: vi.fn(),
}));
vi.mock('../src/application/tools', () => ({
  createToolExecutor: () => mocks.execute,
  TOOL_DEFINITIONS: [
    { name: 'fusion_state', description: 'State', inputSchema: {}, annotations: {} },
  ],
}));
vi.mock('use-webmcp-tool', () => ({ useWebMCP: mocks.register }));
vi.mock('../src/components/SiteAgentBridge', () => ({
  default: (props: unknown) => {
    mocks.site(props);
    return null;
  },
}));
import AgentAccess from '../src/components/AgentAccess';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void | Promise<void>;
  onclose?: () => void;
  onerror?: () => void;
  sent: Record<string, unknown>[] = [];
  constructor(readonly url: string) {
    Socket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  message(value: unknown) {
    return this.onmessage?.({ data: JSON.stringify(value) });
  }
}
let root: Root, host: HTMLDivElement;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('WebSocket', Socket);
  mocks.execute.mockClear();
  mocks.execute.mockResolvedValue({ ok: true });
  mocks.register.mockClear();
  mocks.site.mockClear();
  Socket.instances = [];
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<AgentAccess adapter={{} as ToolAdapter} visible />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;
async function connect() {
  const input = host.querySelector<HTMLInputElement>('[aria-label="MCP pairing token"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      't'.repeat(64),
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Connect MCP bridge').click());
  const socket = Socket.instances.at(-1)!;
  await act(async () => socket.open());
  return socket;
}

function authorityFixture(phase: WorkspaceAuthoritySnapshot['phase'] = 'ready') {
  let snapshot: WorkspaceAuthoritySnapshot = {
    phase,
    owner: 'workspace:fixed',
    error: phase === 'error' ? 'Identity storage unavailable' : null,
  };
  const listeners = new Set<() => void>(),
    leases = new Map<string, { raw: { owner: string; scope: string }; token: object }>(),
    revokers: ReturnType<typeof vi.fn>[] = [];
  const publish = (next: WorkspaceAuthoritySnapshot) => {
    snapshot = next;
    listeners.forEach((fn) => fn());
  };
  const authority: WorkspaceAuthority = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    hydrate: vi.fn(async () => {}),
    retry: vi.fn(async () => publish({ phase: 'ready', owner: 'workspace:fixed', error: null })),
    localContext: vi.fn((kind) => {
      if (snapshot.phase !== 'ready') throw new Error('Authority is not ready');
      return { owner: 'workspace:fixed', scope: `local-${kind}` };
    }),
    isLocalHuman: vi.fn(() => false),
    registerPairedActor: vi.fn((raw, source) => {
      if (snapshot.phase !== 'ready') throw new Error('Authority is not ready');
      const token = {};
      leases.set(source, { raw: { ...raw }, token });
      const revoke = vi.fn(() => {
        if (leases.get(source)?.token === token) leases.delete(source);
      });
      revokers.push(revoke);
      return revoke;
    }),
    admit: vi.fn(async (raw) => {
      if (snapshot.phase !== 'ready') throw new Error('Authority is not ready');
      if (
        raw.owner !== 'workspace:fixed' &&
        ![...leases.values()].some(
          (lease) => lease.raw.owner === raw.owner && lease.raw.scope === raw.scope,
        )
      )
        throw new Error('Bridge lease was not admitted');
      return {
        owner: 'workspace:fixed',
        scope: `canonical-${raw.scope}`,
        ...(raw.signal ? { signal: raw.signal } : {}),
      };
    }),
    dispose: vi.fn(),
  };
  return { authority, leases, revokers, publish };
}
const withAuthority = async (authority: WorkspaceAuthority) =>
  act(async () =>
    root.render(<AgentAccess adapter={{} as ToolAdapter} visible authority={authority} />),
  );

it('separates manual and WebMCP scopes while preserving the tab owner and abort signal', async () => {
  await act(async () => button('Run command').click());
  const manual = mocks.execute.mock.calls[0][2] as { owner: string; scope: string },
    registered = mocks.register.mock.calls.at(-1)![0],
    signal = new AbortController().signal;
  await registered.execute({}, { signal });
  const web = mocks.execute.mock.calls[1][2] as {
    owner: string;
    scope: string;
    signal: AbortSignal;
  };
  expect(manual.owner).toMatch(/^browser:/);
  expect(web.owner).toBe(manual.owner);
  expect(manual.scope).toMatch(/^manual:/);
  expect(web.scope).toMatch(/^webmcp:/);
  expect(web.scope).not.toBe(manual.scope);
  expect(web.signal).toBe(signal);
});

it('passes only the authenticated local context separately from command arguments', async () => {
  const socket = await connect(),
    context = { owner: 'local:server-owner', scope: 'connection-epoch' },
    args = { context: { owner: 'forged', scope: 'forged' } };
  await act(async () => socket.message({ type: 'authenticated', context }));
  await act(async () =>
    socket.message({
      type: 'command',
      id: 'command-id',
      name: 'fusion_state',
      arguments: args,
      context,
    }),
  );
  expect(mocks.execute).toHaveBeenCalledExactlyOnceWith('fusion_state', args, context);
  expect(socket.sent.at(-1)).toEqual({
    type: 'result',
    id: 'command-id',
    result: { ok: true },
    context,
  });
});

it.each(['missing-welcome', 'wrong-owner', 'wrong-scope'] as const)(
  'rejects %s commands before execution',
  async (kind) => {
    const socket = await connect(),
      context = { owner: 'local:server-owner', scope: 'connection-epoch' };
    if (kind !== 'missing-welcome')
      await act(async () => socket.message({ type: 'authenticated', context }));
    const commandContext = { ...context };
    if (kind === 'wrong-owner') commandContext.owner = 'local:other-owner';
    if (kind === 'wrong-scope') commandContext.scope = 'other-epoch';
    await act(async () =>
      socket.message({
        type: 'command',
        id: 'id',
        name: 'fusion_state',
        arguments: {},
        context: commandContext,
      }),
    );
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(3);
    expect(host.textContent).toContain('does not belong to this bridge connection');
  },
);

it('ignores late old-socket commands and closure after a replacement is authenticated', async () => {
  const old = await connect(),
    oldContext = { owner: 'local:server-owner', scope: 'old' };
  await act(async () => old.message({ type: 'authenticated', context: oldContext }));
  await act(async () => button('Disconnect').click());
  const replacement = await connect(),
    context = { ...oldContext, scope: 'replacement' };
  await act(async () => replacement.message({ type: 'authenticated', context }));
  await act(async () => {
    old.readyState = 1; // Deliberately deliver callbacks from the obsolete connection.
    await old.message({
      type: 'command',
      id: 'late',
      name: 'fusion_state',
      arguments: {},
      context: oldContext,
    });
    old.onclose?.();
  });
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(button('Connect MCP bridge').disabled).toBe(true);
  await act(async () =>
    replacement.message({
      type: 'command',
      id: 'current',
      name: 'fusion_state',
      arguments: {},
      context,
    }),
  );
  expect(mocks.execute).toHaveBeenCalledExactlyOnceWith('fusion_state', {}, context);
});

it('returns a bounded error for oversized UTF-8 output without closing the local socket', async () => {
  const socket = await connect(),
    context = { owner: 'local:server-owner', scope: 'connection-epoch' };
  await act(async () => socket.message({ type: 'authenticated', context }));
  const original = { ok: true, content: '漢'.repeat(8_000_000) };
  expect(JSON.stringify(original).length).toBeLessThan(24e6);
  mocks.execute
    .mockResolvedValueOnce(original)
    .mockResolvedValueOnce({ ok: true, marker: 'next command' });
  await act(async () =>
    socket.message({ type: 'command', id: 'large', name: 'fusion_state', arguments: {}, context }),
  );
  const first = socket.sent.at(-1)!;
  expect(first.type).toBe('result');
  expect(first.context).toEqual(context);
  expect(first.result).toEqual({
    ok: false,
    error: expect.stringContaining('Inline result exceeds'),
  });
  expect((first.result as { error: string }).error).toContain('fusion_file_chunk_read');
  expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThan(24e6);
  expect(socket.readyState).toBe(1);
  expect(original.content).toHaveLength(8_000_000);
  await act(async () =>
    socket.message({ type: 'command', id: 'next', name: 'fusion_state', arguments: {}, context }),
  );
  expect(socket.sent.at(-1)!.result).toEqual({ ok: true, marker: 'next command' });
  expect(socket.readyState).toBe(1);
});

it('uses authority local contexts for manual/WebMCP and admits once while preserving the original AbortSignal', async () => {
  const { authority } = authorityFixture();
  await withAuthority(authority);
  await act(async () => button('Run command').click());
  expect(authority.localContext).toHaveBeenCalledWith('manual');
  expect(authority.admit).toHaveBeenCalledExactlyOnceWith({
    owner: 'workspace:fixed',
    scope: 'local-manual',
  });
  expect(mocks.execute.mock.calls[0][2]).toEqual({
    owner: 'workspace:fixed',
    scope: 'canonical-local-manual',
  });
  const signal = new AbortController().signal,
    registered = mocks.register.mock.calls.at(-1)![0];
  await registered.execute({ context: { owner: 'forged', scope: 'forged' } }, { signal });
  expect(authority.admit).toHaveBeenLastCalledWith({
    owner: 'workspace:fixed',
    scope: 'local-webmcp',
    signal,
  });
  expect(authority.admit).toHaveBeenCalledTimes(2);
  expect(mocks.execute.mock.calls[1][2]).toEqual({
    owner: 'workspace:fixed',
    scope: 'canonical-local-webmcp',
    signal,
  });
});

it('fails closed until authority is ready and exposes an explicit storage retry instead of falling back to tab identity', async () => {
  const { authority } = authorityFixture('error');
  await withAuthority(authority);
  expect(button('Run command').disabled).toBe(true);
  expect(button('Connect MCP bridge').disabled).toBe(true);
  expect(mocks.site.mock.calls.at(-1)![0].authorityReady).toBe(false);
  expect(host.textContent).toContain('Identity storage unavailable');
  await expect(
    Promise.resolve().then(() =>
      mocks.register.mock.calls.at(-1)![0].execute({}, { signal: new AbortController().signal }),
    ),
  ).rejects.toThrow('not ready');
  expect(mocks.execute).not.toHaveBeenCalled();
  await act(async () => button('Retry local workspace access').click());
  expect(authority.retry).toHaveBeenCalledTimes(1);
  expect(button('Run command').disabled).toBe(false);
  expect(button('Connect MCP bridge').disabled).toBe(false);
});

it('registers only validated local and Site welcomes, validates raw command equality before admission and preserves raw local result context', async () => {
  const { authority } = authorityFixture();
  await withAuthority(authority);
  const socket = await connect(),
    raw = { owner: 'local:server', scope: 'epoch-one' };
  await act(async () => socket.message({ type: 'authenticated', context: raw }));
  expect(authority.registerPairedActor).toHaveBeenCalledExactlyOnceWith(raw, 'local');
  expect(Object.isFrozen(vi.mocked(authority.registerPairedActor).mock.calls[0][0])).toBe(true);
  await act(async () =>
    socket.message({
      type: 'command',
      id: 'one',
      name: 'fusion_state',
      arguments: { context: { owner: 'forged', scope: 'forged' } },
      context: raw,
    }),
  );
  expect(authority.admit).toHaveBeenCalledExactlyOnceWith(raw);
  expect(mocks.execute.mock.calls[0][2]).toEqual({
    owner: 'workspace:fixed',
    scope: 'canonical-epoch-one',
  });
  expect(socket.sent.at(-1)!.context).toEqual(raw);
  await act(async () =>
    socket.message({
      type: 'command',
      id: 'wrong',
      name: 'fusion_state',
      arguments: {},
      context: { ...raw, scope: 'other-epoch' },
    }),
  );
  expect(authority.admit).toHaveBeenCalledTimes(1);
  const site = mocks.site.mock.calls.at(-1)![0];
  const release = site.onAuthenticated({ owner: 'site:owner', scope: 'hosted-lease' });
  expect(authority.registerPairedActor).toHaveBeenLastCalledWith(
    { owner: 'site:owner', scope: 'hosted-lease' },
    'site',
  );
  release();
});

it('revokes synchronously on Disconnect, rejects late authentication and lets old closure revoke only its own replaced lease', async () => {
  const { authority, leases, revokers } = authorityFixture();
  await withAuthority(authority);
  const old = await connect(),
    raw = { owner: 'local:server', scope: 'old' };
  await act(async () => old.message({ type: 'authenticated', context: raw }));
  old.close = () => {
    old.readyState = 2;
  }; // Delay the browser's close event.
  await act(async () => button('Disconnect').click());
  expect(revokers[0]).toHaveBeenCalledTimes(1);
  expect(leases.size).toBe(0);
  const replacement = await connect(),
    current = { ...raw, scope: 'replacement' };
  await act(async () => replacement.message({ type: 'authenticated', context: current }));
  await act(async () => {
    old.readyState = 1;
    await old.message({ type: 'authenticated', context: raw });
    old.onclose?.();
  });
  expect(authority.registerPairedActor).toHaveBeenCalledTimes(2);
  expect(leases.get('local')!.raw).toEqual(current);
  expect(revokers[1]).not.toHaveBeenCalled();
  expect(button('Connect MCP bridge').disabled).toBe(true);
});

it('unmount invalidates an unauthenticated socket before any late welcome and revokes a live lease without disposing the shared authority', async () => {
  const { authority, revokers } = authorityFixture();
  await withAuthority(authority);
  const pending = await connect();
  pending.close = () => {
    pending.readyState = 2;
  };
  await act(async () => root.render(null));
  pending.readyState = 1;
  await pending.message({
    type: 'authenticated',
    context: { owner: 'local:server', scope: 'late' },
  });
  expect(authority.registerPairedActor).not.toHaveBeenCalled();
  await withAuthority(authority);
  const live = await connect();
  await act(async () =>
    live.message({ type: 'authenticated', context: { owner: 'local:server', scope: 'live' } }),
  );
  await act(async () => root.render(null));
  expect(revokers[0]).toHaveBeenCalledTimes(1);
  expect(authority.dispose).not.toHaveBeenCalled();
});

it('allows an admitted local operation to finish after disconnect without re-admission or result delivery to a replacement socket', async () => {
  const { authority } = authorityFixture();
  await withAuthority(authority);
  const old = await connect(),
    raw = { owner: 'local:server', scope: 'operation' };
  await act(async () => old.message({ type: 'authenticated', context: raw }));
  let resolve!: (value: unknown) => void;
  const completion = new Promise((done) => {
    resolve = done;
  });
  mocks.execute.mockImplementationOnce(() => completion);
  let delivery: void | Promise<void>;
  await act(async () => {
    delivery = old.message({
      type: 'command',
      id: 'in-flight',
      name: 'fusion_state',
      arguments: {},
      context: raw,
    });
    await Promise.resolve();
  });
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  await act(async () => button('Disconnect').click());
  const fresh = await connect();
  await act(async () =>
    fresh.message({ type: 'authenticated', context: { ...raw, scope: 'new' } }),
  );
  await act(async () => {
    resolve({ ok: true, completed: true });
    await delivery;
  });
  expect(authority.admit).toHaveBeenCalledTimes(1);
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  expect(fresh.sent.some((message) => message.type === 'result')).toBe(false);
});

it('integrates the real authority once per command and retains manual/WebMCP scopes for multi-command transfers while raw local replies stay uncanonicalized', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const authority = createWorkspaceAuthority({
      loadOrCreate: async () => ({ version: 1, id: '12345678-1234-4234-8234-123456789abc' }),
    }),
    admitted = vi.spyOn(authority, 'admit'),
    minted = vi.spyOn(authority, 'localContext');
  await authority.hydrate();
  await withAuthority(authority);
  await act(async () => button('Run command').click());
  await act(async () => button('Run command').click());
  expect(mocks.execute.mock.calls[0][2]).toEqual(mocks.execute.mock.calls[1][2]);
  expect(minted).toHaveBeenCalledExactlyOnceWith('manual');
  const registered = mocks.register.mock.calls.at(-1)![0],
    signal = new AbortController().signal;
  await registered.execute({}, { signal });
  await registered.execute({}, { signal });
  expect(mocks.execute.mock.calls[2][2]).toEqual(mocks.execute.mock.calls[3][2]);
  expect(minted).toHaveBeenCalledTimes(2);
  expect(minted).toHaveBeenLastCalledWith('webmcp');
  expect(mocks.execute.mock.calls[2][2]).toMatchObject({ signal });
  const local = await connect(),
    raw = { owner: 'local:exact-server', scope: 'exact-epoch' };
  await act(async () => local.message({ type: 'authenticated', context: raw }));
  await act(async () =>
    local.message({
      type: 'command',
      id: 'real',
      name: 'fusion_state',
      arguments: {},
      context: raw,
    }),
  );
  expect(admitted).toHaveBeenCalledTimes(5);
  expect(mocks.execute.mock.calls[4][2]).toEqual(await admitted.mock.results[4].value);
  expect(mocks.execute.mock.calls[4][2]).toMatchObject({
    owner: 'workspace:12345678-1234-4234-8234-123456789abc',
    scope: expect.stringMatching(/^paired:/),
  });
  expect(local.sent.at(-1)!.context).toEqual(raw);
  await act(async () => button('Disconnect').click());
  await expect(authority.admit(raw)).rejects.toThrow(/registered/);
  authority.dispose();
});
