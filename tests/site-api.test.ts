import { it, expect } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleSiteApi, type SiteEnv, type Statement } from '../server/site/api';
import {
  createBridgeKeyPair,
  deriveBridgeCommandKey,
  openBridgePayload,
  sealBridgePayload,
  parseBridgeEncryptedRequest,
  type BridgeEncryptedRequest,
} from '../src/application/bridge-crypto';
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('drizzle/0000_browser_bridge.sql', 'utf8'));
  class Query implements Statement {
    values: SQLInputValue[] = [];
    constructor(readonly sql: string) {}
    bind(...v: unknown[]) {
      this.values = v as SQLInputValue[];
      return this;
    }
    async run() {
      return { meta: { changes: Number(db.prepare(this.sql).run(...this.values).changes) } };
    }
    async first<T>() {
      return (db.prepare(this.sql).get(...this.values) as T) ?? null;
    }
    async all<T>() {
      return { results: db.prepare(this.sql).all(...this.values) as T[] };
    }
  }
  const objects = new Map<string, string>(),
    writes: { key: string; value: string }[] = [],
    env: SiteEnv = {
      DB: { prepare: (sql) => new Query(sql) },
      BUCKET: {
        put: async (k, v) => {
          objects.set(k, v);
          writes.push({ key: k, value: v });
        },
        get: async (k) => (objects.has(k) ? { text: async () => objects.get(k)! } : null),
        delete: async (keys) => {
          for (const k of typeof keys === 'string' ? [keys] : keys) objects.delete(k);
        },
      },
    };
  const pairs = new Map<string, Awaited<ReturnType<typeof createBridgeKeyPair>>>();
  const call = async (
    path: string,
    payload: unknown,
    owner = 'owner-a',
    origin = 'https://studio.example',
  ) => {
    if (
      path === '/api/agent/session' &&
      payload &&
      typeof payload === 'object' &&
      'action' in payload &&
      payload.action === 'start' &&
      !('publicKey' in payload)
    ) {
      const id = String('session' in payload ? payload.session : ''),
        existing = pairs.get(id),
        pair = existing ?? (await createBridgeKeyPair());
      pairs.set(id, pair);
      payload = { ...payload, publicKey: pair.publicKey };
    }
    return handleSiteApi(
      new Request(`https://studio.example${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'oai-authenticated-user-id': owner,
          Origin: origin,
          'X-Fusion-Request': '1',
        },
        body: JSON.stringify(payload),
      }),
      env,
    ) as Promise<Response>;
  };
  const clientCommand = async (command: {
    id: string;
    name: string;
    context: { owner: string; scope: string };
    payload: BridgeEncryptedRequest;
  }) => {
    const payload = parseBridgeEncryptedRequest(command.payload),
      binding = {
        owner: command.context.owner,
        session: command.context.scope,
        commandId: command.id,
        name: command.name,
      },
      key = await deriveBridgeCommandKey(
        pairs.get(binding.session)!.privateKey,
        payload.publicKey,
        binding,
      );
    return {
      value: await openBridgePayload(key, binding, 'request', payload.encrypted),
      result: async (result: unknown) => ({
        session: binding.session,
        id: command.id,
        encrypted: await sealBridgePayload(key, binding, 'result', {
          session: binding.session,
          id: command.id,
          result,
        }),
      }),
    };
  };
  return { db, objects, env, call, pairs, clientCommand, writes };
}
it('requires Site identity and rejects cross-origin browser commands', async () => {
  const { env, call } = setup();
  expect(
    (
      await handleSiteApi(
        new Request('https://studio.example/mcp', { method: 'POST', body: '{}' }),
        env,
      )
    )?.status,
  ).toBe(401);
  expect(
    (
      await call(
        '/api/agent/session',
        { session: crypto.randomUUID(), action: 'start' },
        'owner-a',
        'https://foreign.example',
      )
    ).status,
  ).toBe(403);
});
it('scopes browser leases to the Site user and permits only one active browser', async () => {
  const { call } = setup(),
    a = crypto.randomUUID(),
    b = crypto.randomUUID();
  const started = await call('/api/agent/session', {
    session: a,
    action: 'start',
    owner: 'forged-owner',
    context: { owner: 'forged-owner', scope: 'forged-scope' },
  });
  expect(started.status).toBe(200);
  expect(await started.json()).toEqual({
    ok: true,
    context: { owner: 'site:owner-a', scope: a },
  });
  expect((await call('/api/agent/session', { session: b, action: 'start' })).status).toBe(409);
  expect(
    (await call('/api/agent/session', { session: b, action: 'start' }, 'owner-b')).status,
  ).toBe(200);
  expect((await call('/api/agent/next', { session: a }, 'owner-b')).status).toBe(400);
});
it('exposes the actual command schemas and reports an unavailable browser explicitly', async () => {
  const { call } = setup();
  const list = await (await call('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
  expect(list.result.tools.some((t: { name: string }) => t.name === 'fusion_upload')).toBe(true);
  const exported = list.result.tools.find(
    (t: { name: string }) => t.name === 'fusion_project_export',
  );
  expect(exported.inputSchema.required).toEqual(['slot']);
  const analyzed = list.result.tools.find((t: { name: string }) => t.name === 'fusion_analyze');
  expect(analyzed.inputSchema.required).toEqual(['slot', 'preset', 'frequencies']);
  const rename = list.result.tools.find((t: { name: string }) => t.name === 'fusion_rename');
  expect(rename.inputSchema.required).toEqual(['target', 'name']);
  const noBrowser = await (
    await call('/mcp', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'fusion_state', arguments: {} },
    })
  ).json();
  expect(noBrowser.result.isError).toBe(true);
  expect(noBrowser.result.content[0].text).toContain('enable Site agent access');
});
it('encrypts queue payloads, claims once, rejects another owner’s result and deletes payloads after delivery', async () => {
  const { call, db, objects, clientCommand, writes } = setup(),
    a = crypto.randomUUID(),
    b = crypto.randomUUID();
  await call('/api/agent/session', { session: a, action: 'start' });
  await call('/api/agent/session', { session: b, action: 'start' }, 'owner-b');
  const pending = call('/mcp', {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'fusion_state',
      arguments: {
        includeProjects: false,
        syntheticSecret: 'never-store-plain-password',
        context: { owner: 'forged-argument-owner', scope: 'forged-argument-scope' },
      },
      context: { owner: 'forged-params-owner', scope: 'forged-params-scope' },
    },
  });
  for (let i = 0; i < 20; i++) {
    if (Number(db.prepare('SELECT count(*) n FROM bridge_commands').get()?.n) > 0) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  const stored = db.prepare('SELECT id, request_key FROM bridge_commands').get()!;
  expect([...objects.values()].join('')).not.toMatch(
    /never-store-plain-password|forged-argument-owner|includeProjects/,
  );
  const replies = await Promise.all([
      call('/api/agent/next', { session: a }),
      call('/api/agent/next', { session: a }),
    ]),
    commands = (await Promise.all(replies.map((r) => r.json())))
      .map((r) => r.command)
      .filter(Boolean);
  expect(commands).toHaveLength(1);
  const command = commands[0];
  expect(command.name).toBe('fusion_state');
  expect(command.id).toBe(stored.id);
  expect(command.context).toEqual({ owner: 'site:owner-a', scope: a });
  expect(command.arguments).toBeUndefined();
  const client = await clientCommand(command);
  expect((client.value as { arguments: { context: unknown } }).arguments.context).toEqual({
    owner: 'forged-argument-owner',
    scope: 'forged-argument-scope',
  });
  expect(
    (
      await call(
        '/api/agent/result',
        { session: b, id: command.id, result: { ok: true } },
        'owner-b',
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await call(
        '/api/agent/result',
        await client.result({
          ok: true,
          selection: { slot: 'left' },
          email: 'private@example.org',
        }),
      )
    ).status,
  ).toBe(200);
  const result = await (await pending).json();
  expect(JSON.parse(result.result.content[0].text)).toEqual({
    ok: true,
    selection: { slot: 'left' },
    email: 'private@example.org',
  });
  expect([...objects.values()].join('')).not.toContain('private@example.org');
  expect(writes.map((write) => write.value).join('')).not.toMatch(
    /private@example.org|never-store-plain-password/,
  );
  await call('/api/agent/session', { session: a, action: 'stop' });
  await call('/api/agent/session', { session: b, action: 'stop' }, 'owner-b');
  expect(objects.size).toBe(0);
  expect(db.prepare('SELECT count(*) n FROM bridge_commands').get()?.n).toBe(0);
}, 5000);

it('changes trusted scope on re-pairing and rejects the previous lease', async () => {
  const { call } = setup(),
    first = crypto.randomUUID(),
    second = crypto.randomUUID();
  const oldContext = await (
    await call('/api/agent/session', { session: first, action: 'start' })
  ).json();
  await call('/api/agent/session', { session: first, action: 'stop' });
  const newContext = await (
    await call('/api/agent/session', { session: second, action: 'start' })
  ).json();
  expect(newContext.context.owner).toBe(oldContext.context.owner);
  expect(newContext.context.scope).not.toBe(oldContext.context.scope);
  expect((await call('/api/agent/next', { session: first })).status).toBe(400);
  expect((await call('/api/agent/next', { session: second })).status).toBe(200);
});

it('measures hosted request bytes and directs large inputs to chunked file tools', async () => {
  const { call, db, objects } = setup();
  const response = await call('/mcp', {
    jsonrpc: '2.0',
    id: 1,
    method: 'ping',
    padding: '漢'.repeat(2_700_000),
  });
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.error).toContain('8 MB limit');
  expect(body.error).toContain('fusion_file_upload_begin');
  expect(body.error).toContain('fusion_file_upload_chunk');
  expect(body.error).not.toContain('local bridge');
  expect(db.prepare('SELECT count(*) n FROM bridge_commands').get()?.n).toBe(0);
  expect(objects.size).toBe(0);
});

async function queued(db: DatabaseSync) {
  for (let i = 0; i < 100; i++) {
    if (Number(db.prepare('SELECT count(*) n FROM bridge_commands').get()?.n) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Expected an encrypted queued command');
}
it('rejects missing/private/invalid pairing keys before enqueue and never falls back to plaintext', async () => {
  const { call, db, objects } = setup(),
    session = crypto.randomUUID();
  for (const publicKey of [
    null,
    { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'A'.repeat(43) },
    { ...(await createBridgeKeyPair()).publicKey, d: 'private-never-echo' },
  ]) {
    const response = await call('/api/agent/session', { session, action: 'start', publicKey });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain('private-never-echo');
  }
  expect(db.prepare('SELECT count(*) n FROM browser_leases').get()?.n).toBe(0);
  expect(objects.size).toBe(0);
  await call('/api/agent/session', { session, action: 'start' });
  objects.clear();
  const unavailable = await (
    await call('/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'fusion_state', arguments: { secret: 'never-enqueue-plain' } },
    })
  ).json();
  expect(unavailable.result.isError).toBe(true);
  expect(unavailable.result.content[0].text).toContain('reload and enable');
  expect(db.prepare('SELECT count(*) n FROM bridge_commands').get()?.n).toBe(0);
  expect(objects.size).toBe(0);
});

it('refuses plaintext or corrupt responses, keeps one-time claim ownership and cleans failed encrypted delivery', async () => {
  const { call, db, objects, clientCommand } = setup(),
    session = crypto.randomUUID();
  await call('/api/agent/session', { session, action: 'start' });
  const pending = call('/mcp', {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'fusion_state', arguments: {} },
  });
  await queued(db);
  const next = await (await call('/api/agent/next', { session })).json(),
    command = next.command,
    client = await clientCommand(command);
  const plain = await call('/api/agent/result', {
    session,
    id: command.id,
    result: { secret: 'never-store-this' },
  });
  expect(plain.status).toBe(400);
  expect(JSON.stringify(await plain.json())).not.toContain('never-store-this');
  expect(db.prepare('SELECT status FROM bridge_commands').get()?.status).toBe('running');
  expect([...objects.values()].join('')).not.toContain('never-store-this');
  const valid = await client.result({ ok: true, secret: 'never-error-echo' });
  valid.encrypted.ciphertext =
    (valid.encrypted.ciphertext[0] === 'A' ? 'B' : 'A') + valid.encrypted.ciphertext.slice(1);
  expect((await call('/api/agent/result', valid)).status).toBe(200);
  const delivered = await (await pending).json();
  expect(delivered.result.isError).toBe(true);
  expect(delivered.result.content[0].text).toContain('authentication failed');
  expect(delivered.result.content[0].text).not.toContain('never-error-echo');
  expect(db.prepare('SELECT count(*) n FROM bridge_commands').get()?.n).toBe(0);
  expect([...objects.keys()].every((key) => key.endsWith('.public'))).toBe(true);
  await call('/api/agent/session', { session, action: 'stop' });
  expect(objects.size).toBe(0);
}, 5000);

it('accepts an encrypted result above 8 MB wire size while enforcing the unchanged 8 MB plaintext boundary', async () => {
  const { call, db, objects, clientCommand } = setup(),
    session = crypto.randomUUID();
  await call('/api/agent/session', { session, action: 'start' });
  const pending = call('/mcp', {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'fusion_state', arguments: {} },
  });
  await queued(db);
  const command = (await (await call('/api/agent/next', { session })).json()).command,
    client = await clientCommand(command),
    overhead = new TextEncoder().encode(
      JSON.stringify({ session, id: command.id, result: { content: '' } }),
    ).length,
    value = { content: 'x'.repeat(8e6 - overhead) },
    encrypted = await client.result(value);
  expect(JSON.stringify(encrypted).length).toBeGreaterThan(8e6);
  expect(JSON.stringify(encrypted).length).toBeLessThan(12e6);
  expect((await call('/api/agent/result', encrypted)).status).toBe(200);
  const delivered = await (await pending).json();
  expect(JSON.parse(delivered.result.content[0].text)).toEqual(value);
  expect([...objects.keys()].every((key) => key.endsWith('.public'))).toBe(true);
  await call('/api/agent/session', { session, action: 'stop' });
}, 10000);
