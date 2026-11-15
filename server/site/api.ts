import { TOOL_DEFINITIONS } from '../../src/application/tools';
import { parseExecutionPrincipal } from '../../src/application/execution-context';
import {
  BRIDGE_PLAINTEXT_LIMIT,
  BRIDGE_ENCRYPTED_BODY_LIMIT,
  createBridgeCommand,
  validateBridgePublicKey,
  parseBridgeEncryptedRequest,
  parseBridgeEncryptedPayload,
  sealBridgePayload,
  openBridgePayload,
  BridgeCryptoError,
} from '../../src/application/bridge-crypto';
export interface Statement {
  bind(...values: unknown[]): Statement;
  run(): Promise<{ meta: { changes: number } }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface SiteEnv {
  DB: { prepare(sql: string): Statement };
  BUCKET: {
    put(key: string, value: string): Promise<unknown>;
    get(key: string): Promise<{ text(): Promise<string> } | null>;
    delete(key: string | string[]): Promise<void>;
  };
}
interface Lease {
  session: string;
  seen: number;
}
interface Command {
  id: string;
  owner: string;
  session: string;
  name: string;
  status: string;
  created: number;
  expires: number;
  request_key: string;
  response_key: string;
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f\d-]{36}$/i.test(value);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function body(request: Request, limit = BRIDGE_PLAINTEXT_LIMIT) {
  const reader = request.body?.getReader();
  if (!reader) return {};
  let text = '',
    length = 0;
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      if (limit === BRIDGE_ENCRYPTED_BODY_LIMIT)
        throw new Error(
          'Encrypted result envelope exceeds the hosted 12 MB limit; inline plaintext remains limited to 8 MB. Use chunked file tools.',
        );
      throw new Error(
        'Command exceeds the hosted 8 MB limit; use fusion_file_upload_begin, fusion_file_upload_chunk and fusion_file_upload_commit for file inputs, or fusion_workspace_storage with action file-transfer',
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error('Invalid JSON request');
  }
}
const sessionKey = (owner: string, session: string) =>
  `bridge/${encodeURIComponent(owner)}/sessions/${session}.public`;
async function browserPublicKey(env: SiteEnv, owner: string, session: string) {
  const stored = await env.BUCKET.get(sessionKey(owner, session));
  if (!stored)
    throw new BridgeCryptoError(
      'Encrypted browser pairing is unavailable; reload and enable Site agent access',
    );
  try {
    const record = JSON.parse(await stored.text());
    if (!record || Object.keys(record).length !== 2 || record.version !== 1) throw new Error();
    return await validateBridgePublicKey(record.publicKey);
  } catch {
    throw new BridgeCryptoError(
      'Encrypted browser pairing is invalid; reload and enable Site agent access',
    );
  }
}
async function cleanup(env: SiteEnv, owner: string) {
  const old = await env.DB.prepare(
    'SELECT id, request_key, response_key FROM bridge_commands WHERE owner = ? AND expires < ? LIMIT 20',
  )
    .bind(owner, Date.now() - 300000)
    .all<Command>();
  for (const row of old.results) {
    await env.BUCKET.delete([row.request_key, row.response_key]);
    await env.DB.prepare('DELETE FROM bridge_commands WHERE id = ? AND owner = ?')
      .bind(row.id, owner)
      .run();
  }
}
async function validLease(env: SiteEnv, owner: string, session?: string, allowStale = false) {
  const lease = await env.DB.prepare('SELECT session, seen FROM browser_leases WHERE owner = ?')
    .bind(owner)
    .first<Lease>();
  const running =
    lease && Date.now() - lease.seen > 15000
      ? await env.DB.prepare(
          "SELECT id FROM bridge_commands WHERE owner = ? AND session = ? AND status = 'running' AND expires > ? LIMIT 1",
        )
          .bind(owner, lease.session, Date.now())
          .first()
      : null;
  if (
    !lease ||
    (!allowStale && Date.now() - lease.seen > 15000 && !running) ||
    (session !== undefined && session !== lease.session)
  )
    throw new Error(
      'Open Fusion Studio and enable Site agent access in the browser that owns the USB connections',
    );
  return lease;
}
async function callBrowser(env: SiteEnv, owner: string, name: string, args: unknown) {
  const lease = await validLease(env, owner),
    id = crypto.randomUUID(),
    prefix = `bridge/${encodeURIComponent(owner)}/${id}`,
    requestKey = `${prefix}.request`,
    responseKey = `${prefix}.response`,
    now = Date.now(),
    binding = { owner: `site:${owner}`, session: lease.session, commandId: id, name },
    remoteKey = await browserPublicKey(env, owner, lease.session),
    { key, requestPublicKey } = await createBridgeCommand(remoteKey, binding),
    encrypted = await sealBridgePayload(key, binding, 'request', { arguments: args });
  // Only ciphertext and public metadata reach queue storage. The response key
  // exists only in this live HTTPS call's closure, never D1/R2.
  await env.BUCKET.put(
    requestKey,
    JSON.stringify({ version: 1, publicKey: requestPublicKey, encrypted }),
  );
  try {
    await env.DB.prepare(
      'INSERT INTO bridge_commands (id,owner,session,name,status,created,expires,request_key,response_key) VALUES (?,?,?,?,?,?,?,?,?)',
    )
      .bind(id, owner, lease.session, name, 'queued', now, now + 90000, requestKey, responseKey)
      .run();
    for (let i = 0; i < 170; i++) {
      const row = await env.DB.prepare(
        'SELECT status FROM bridge_commands WHERE id = ? AND owner = ?',
      )
        .bind(id, owner)
        .first<{ status: string }>();
      if (row?.status === 'complete') {
        const object = await env.BUCKET.get(responseKey);
        if (!object)
          throw new Error(
            'Browser result is unavailable; inspect the visible application before retrying',
          );
        try {
          const value = await openBridgePayload(
            key,
            binding,
            'result',
            JSON.parse(await object.text()),
          );
          if (
            !value ||
            typeof value !== 'object' ||
            Object.keys(value).length !== 3 ||
            !('session' in value) ||
            value.session !== lease.session ||
            !('id' in value) ||
            value.id !== id ||
            !('result' in value)
          )
            throw new BridgeCryptoError();
          return value.result;
        } catch {
          throw new BridgeCryptoError();
        } finally {
          await env.BUCKET.delete([requestKey, responseKey]);
          await env.DB.prepare('DELETE FROM bridge_commands WHERE id = ? AND owner = ?')
            .bind(id, owner)
            .run();
        }
      }
      await wait(500);
    }
    await env.DB.prepare(
      "UPDATE bridge_commands SET status = 'expired' WHERE id = ? AND owner = ? AND status = 'queued'",
    )
      .bind(id, owner)
      .run();
    throw new Error(
      'Browser command result timed out. A running USB operation is allowed to finish; inspect its visible result before retrying.',
    );
  } catch (error) {
    // Expired commands retain the existing unknown-outcome record; their R2
    // objects are encrypted and are swept by cleanup. Failed enqueues have no row.
    const row = await env.DB.prepare(
      'SELECT status FROM bridge_commands WHERE id = ? AND owner = ?',
    )
      .bind(id, owner)
      .first();
    if (!row) await env.BUCKET.delete([requestKey, responseKey]);
    throw error;
  }
}
export async function handleSiteApi(request: Request, env: SiteEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== '/mcp' && !url.pathname.startsWith('/api/agent/')) return;
  const owner = request.headers.get('oai-authenticated-user-id');
  if (!owner)
    return json({ error: 'Sign in with ChatGPT to access your amplifier workspace' }, 401);
  if (request.method !== 'POST')
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  const origin = request.headers.get('Origin');
  if (
    url.pathname.startsWith('/api/') &&
    (origin !== url.origin || request.headers.get('X-Fusion-Request') !== '1')
  )
    return json({ error: 'Same-origin browser request required' }, 403);
  if (!env.DB || !env.BUCKET)
    return json({ error: 'Hosted agent bridge storage is unavailable' }, 503);
  try {
    const input = await body(
      request,
      url.pathname === '/api/agent/result' ? BRIDGE_ENCRYPTED_BODY_LIMIT : BRIDGE_PLAINTEXT_LIMIT,
    );
    if (url.pathname === '/mcp') {
      if (input.jsonrpc !== '2.0' || typeof input.method !== 'string')
        return json(
          {
            jsonrpc: '2.0',
            id: input.id ?? null,
            error: { code: -32600, message: 'Invalid JSON-RPC' },
          },
          400,
        );
      if (input.id === undefined) return new Response(null, { status: 202 });
      const result = (value: unknown) => json({ jsonrpc: '2.0', id: input.id, result: value }),
        params = input.params as Record<string, unknown> | undefined;
      if (input.method === 'server/discover')
        return result({
          supportedVersions: ['2026-07-28', '2025-11-25'],
          capabilities: { tools: {} },
        });
      if (input.method === 'initialize')
        return result({
          protocolVersion: params?.protocolVersion === '2025-11-25' ? '2025-11-25' : '2026-07-28',
          serverInfo: { name: 'fusion-studio', version: '0.1.0' },
          capabilities: { tools: {} },
        });
      if (input.method === 'ping') return result({});
      if (input.method === 'tools/list') return result({ tools: TOOL_DEFINITIONS });
      if (input.method === 'tools/call') {
        const name = String(params?.name ?? '');
        try {
          if (!TOOL_DEFINITIONS.some((t) => t.name === name))
            throw new Error('Unknown Fusion Studio tool');
          const value = await callBrowser(env, owner, name, params?.arguments ?? {});
          return result({
            isError:
              typeof value === 'object' && value !== null && 'ok' in value && value.ok === false,
            content: [{ type: 'text', text: JSON.stringify(value) }],
          });
        } catch (e) {
          return result({
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  error: e instanceof Error ? e.message : String(e),
                }),
              },
            ],
          });
        }
      }
      return json({
        jsonrpc: '2.0',
        id: input.id,
        error: { code: -32601, message: 'Method not found' },
      });
    }
    const session = input.session;
    if (!uuid(session)) throw new Error('Invalid browser session');
    const context = parseExecutionPrincipal({ owner: `site:${owner}`, scope: session });
    if (url.pathname === '/api/agent/session') {
      if (input.action === 'start') {
        const publicKey = await validateBridgePublicKey(input.publicKey),
          previous = await env.DB.prepare(
            'SELECT session, seen FROM browser_leases WHERE owner = ?',
          )
            .bind(owner)
            .first<Lease>(),
          keyPath = sessionKey(owner, session),
          priorKey = await env.BUCKET.get(keyPath),
          now = Date.now();
        if (priorKey) {
          const existing = await browserPublicKey(env, owner, session);
          if (JSON.stringify(existing) !== JSON.stringify(publicKey))
            throw new BridgeCryptoError(
              'Browser pairing key changed; enable access with a new session',
            );
        } else await env.BUCKET.put(keyPath, JSON.stringify({ version: 1, publicKey }));
        let result: { meta: { changes: number } };
        try {
          result = await env.DB.prepare(
            "INSERT INTO browser_leases (owner,session,seen) VALUES (?,?,?) ON CONFLICT(owner) DO UPDATE SET session=excluded.session, seen=excluded.seen WHERE browser_leases.session = excluded.session OR (browser_leases.seen < ? AND NOT EXISTS (SELECT 1 FROM bridge_commands WHERE owner = excluded.owner AND session = browser_leases.session AND status = 'running' AND expires > ?))",
          )
            .bind(owner, session, now, now - 15000, now)
            .run();
        } catch {
          if (!priorKey) await env.BUCKET.delete(keyPath);
          throw new Error(
            'Encrypted browser pairing could not be saved; reload and enable Site agent access',
          );
        }
        if (!result.meta.changes) {
          if (!priorKey) await env.BUCKET.delete(keyPath);
          return json(
            {
              error:
                'Another browser is paired. Disable its Site agent access first, or wait for its lease to expire.',
            },
            409,
          );
        }
        if (previous && previous.session !== session)
          await env.BUCKET.delete(sessionKey(owner, previous.session));
        await cleanup(env, owner);
        return json({
          ok: true,
          context,
        });
      }
      if (input.action === 'heartbeat') {
        const r = await env.DB.prepare(
          'UPDATE browser_leases SET seen = ? WHERE owner = ? AND session = ?',
        )
          .bind(Date.now(), owner, session)
          .run();
        return json({ ok: !!r.meta.changes }, r.meta.changes ? 200 : 409);
      }
      if (input.action === 'stop') {
        await env.DB.prepare('DELETE FROM browser_leases WHERE owner = ? AND session = ?')
          .bind(owner, session)
          .run();
        await env.BUCKET.delete(sessionKey(owner, session));
        await env.DB.prepare(
          "UPDATE bridge_commands SET status = 'expired' WHERE owner = ? AND session = ? AND status = 'queued'",
        )
          .bind(owner, session)
          .run();
        return json({ ok: true });
      }
      throw new Error('Unknown browser-session action');
    }
    await validLease(env, owner, session, url.pathname === '/api/agent/result');
    if (url.pathname === '/api/agent/next') {
      const attempts = input.longPoll === true ? 25 : 1;
      for (let i = 0; i < attempts; i++) {
        if (request.signal.aborted) return json({ ok: true, command: null });
        const row = await env.DB.prepare(
          "SELECT * FROM bridge_commands WHERE owner = ? AND session = ? AND status = 'queued' AND expires > ? ORDER BY created LIMIT 1",
        )
          .bind(owner, session, Date.now())
          .first<Command>();
        if (row) {
          const claimed = await env.DB.prepare(
            "UPDATE bridge_commands SET status = 'running' WHERE id = ? AND owner = ? AND session = ? AND status = 'queued' AND expires > ?",
          )
            .bind(row.id, owner, session, Date.now())
            .run();
          if (claimed.meta.changes) {
            const object = await env.BUCKET.get(row.request_key);
            if (!object) throw new Error('Queued command data is unavailable');
            let payload;
            try {
              payload = parseBridgeEncryptedRequest(JSON.parse(await object.text()));
            } catch {
              throw new BridgeCryptoError();
            }
            // Identity is bound to the authenticated owner and claimed lease,
            // never the MCP arguments or an object loaded from payload storage.
            return json({
              ok: true,
              command: {
                id: row.id,
                name: row.name,
                payload,
                context: parseExecutionPrincipal({ owner: `site:${owner}`, scope: row.session }),
              },
            });
          }
        }
        if (i < attempts - 1) {
          if (i % 4 === 0)
            await env.DB.prepare(
              'UPDATE browser_leases SET seen = ? WHERE owner = ? AND session = ?',
            )
              .bind(Date.now(), owner, session)
              .run();
          await wait(900);
        }
      }
      return json({ ok: true, command: null });
    }

    if (url.pathname === '/api/agent/result') {
      if (!uuid(input.id)) throw new Error('Invalid command result ID');
      const row = await env.DB.prepare(
        "SELECT * FROM bridge_commands WHERE id = ? AND owner = ? AND session = ? AND status = 'running'",
      )
        .bind(input.id, owner, session)
        .first<Command>();
      if (!row) return json({ error: 'Command is not assigned to this browser' }, 409);
      if (Object.keys(input).length !== 3 || !Object.hasOwn(input, 'encrypted'))
        throw new BridgeCryptoError(
          'Encrypted command results are required; reload and enable Site agent access',
        );
      const encrypted = parseBridgeEncryptedPayload(input.encrypted);
      await env.BUCKET.put(row.response_key, JSON.stringify(encrypted));
      await env.DB.prepare(
        "UPDATE bridge_commands SET status = 'complete' WHERE id = ? AND owner = ? AND session = ? AND status = 'running'",
      )
        .bind(row.id, owner, session)
        .run();
      return json({ ok: true });
    }
    return json({ error: 'Unknown agent bridge route' }, 404);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
}
