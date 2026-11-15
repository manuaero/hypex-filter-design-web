import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { TOOL_DEFINITIONS } from '../src/application/tools';
import {
  parseExecutionPrincipal,
  sameExecutionPrincipal,
  type ExecutionPrincipal,
} from '../src/application/execution-context';

const port = Number(process.env.FUSION_MCP_PORT ?? 3211);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid MCP port');
const token = process.env.FUSION_MCP_TOKEN ?? randomBytes(32).toString('hex');
if (token.length < 32) throw new Error('MCP token must contain at least 32 characters');
const origins = new Set(
  (process.env.FUSION_BROWSER_ORIGINS ?? 'http://127.0.0.1:3210,http://localhost:3210').split(','),
);
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
let browser: WebSocket | undefined;
const localOwner = `local:${randomUUID()}`;
let browserContext: ExecutionPrincipal | undefined;
const pending = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const bridgeCall = (name: string, args: unknown) =>
  new Promise<unknown>((resolve, reject) => {
    if (!browser || browser.readyState !== WebSocket.OPEN || !browserContext) {
      reject(new Error('Open Fusion Studio, then connect its local MCP bridge from Agent access'));
      return;
    }
    const id = randomUUID(),
      timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            'Browser command timed out. Check the visible application before retrying a hardware operation.',
          ),
        );
      }, 90000);
    pending.set(id, { resolve, reject, timer });
    browser.send(
      JSON.stringify({ type: 'command', id, name, arguments: args, context: browserContext }),
    );
  });
async function rpc(message: Record<string, unknown>) {
  const { id, method } = message,
    params = message.params as Record<string, unknown> | undefined;
  if (id === undefined) return undefined;
  const result = (value: unknown) => ({ jsonrpc: '2.0', id, result: value });
  switch (method) {
    case 'server/discover':
      return result({
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: {} },
      });
    case 'initialize':
      return result({
        protocolVersion: params?.protocolVersion === '2025-11-25' ? '2025-11-25' : '2026-07-28',
        serverInfo: { name: 'fusion-studio', version: '0.1.0' },
        capabilities: { tools: {} },
      });
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: TOOL_DEFINITIONS });
    case 'tools/call': {
      const name = String(params?.name ?? '');
      if (!TOOL_DEFINITIONS.some((t) => t.name === name))
        return result({
          isError: true,
          content: [{ type: 'text', text: 'Unknown Fusion Studio tool' }],
        });
      try {
        const value = await bridgeCall(name, params?.arguments ?? {});
        return result({
          isError:
            typeof value === 'object' && value !== null && 'ok' in value && value.ok === false,
          content: [{ type: 'text', text: JSON.stringify(value) }],
        });
      } catch (e) {
        return result({
          isError: true,
          content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
        });
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  }
}
const server = createServer(async (req, res) => {
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? '')) {
    json(res, 403, { error: 'Invalid host' });
    return;
  }
  const origin = req.headers.origin;
  if (origin && !origins.has(origin)) {
    json(res, 403, { error: 'Origin not allowed' });
    return;
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization,Content-Type,MCP-Protocol-Version,Accept',
    );
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!equal(req.headers.authorization ?? '', `Bearer ${token}`)) {
    json(res, 401, { error: 'Pairing token required' });
    return;
  }
  if (req.url === '/health') {
    json(res, 200, {
      ok: true,
      browserConnected: browser?.readyState === WebSocket.OPEN,
      tools: TOOL_DEFINITIONS.length,
    });
    return;
  }
  if (req.url !== '/mcp') {
    json(res, 404, { error: 'Not found' });
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    res.end();
    return;
  }
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 22e6) throw new Error('Request too large');
    }
    const message = JSON.parse(body);
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string')
      throw new Error('Invalid JSON-RPC');
    const response = await rpc(message);
    if (response === undefined) {
      res.writeHead(202);
      res.end();
    } else json(res, 200, response);
  } catch (e) {
    json(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: e instanceof Error ? e.message : String(e) },
    });
  }
});
const sockets = new WebSocketServer({ noServer: true, maxPayload: 24e6 });
server.on('upgrade', (req, socket, head) => {
  if (
    req.url !== '/bridge' ||
    ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? '') ||
    (req.headers.origin && !origins.has(req.headers.origin))
  ) {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit('connection', ws, req));
});
sockets.on('connection', (ws: WebSocket) => {
  let authenticated = false;
  let context: ExecutionPrincipal | undefined;
  const deadline = setTimeout(() => {
    if (!authenticated) ws.close(1008, 'Authenticate first');
  }, 5000);
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(String(data));
      if (!authenticated) {
        if (message.type !== 'authenticate' || !equal(String(message.token ?? ''), token)) {
          ws.close(1008, 'Invalid pairing token');
          return;
        }
        if (browser?.readyState === WebSocket.OPEN) {
          ws.close(1008, 'A browser is already paired');
          return;
        }
        authenticated = true;
        clearTimeout(deadline);
        browser = ws;
        context = { owner: localOwner, scope: randomUUID() };
        browserContext = context;
        ws.send(JSON.stringify({ type: 'authenticated', context }));
        return;
      }
      if (message.type === 'result' && typeof message.id === 'string') {
        if (
          browser !== ws ||
          !context ||
          !sameExecutionPrincipal(parseExecutionPrincipal(message.context), context)
        )
          throw new Error('Result does not belong to this bridge connection');
        const entry = pending.get(message.id);
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete(message.id);
          entry.resolve(message.result);
        }
      }
    } catch {
      ws.close(1003, 'Invalid message');
    }
  });
  ws.on('close', () => {
    clearTimeout(deadline);
    if (browser === ws) {
      browser = undefined;
      browserContext = undefined;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(
          new Error('Browser bridge disconnected; inspect hardware state before retrying'),
        );
      }
      pending.clear();
    }
  });
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(
    JSON.stringify({
      url: `http://127.0.0.1:${port}/mcp`,
      bridge: `ws://127.0.0.1:${port}/bridge`,
      ...(process.env.FUSION_MCP_TOKEN ? {} : { token }),
    }) + '\n',
  );
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    sockets.close();
    browser?.close();
    server.close(() => process.exit(0));
  });
