import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  parseExecutionPrincipal,
  type ExecutionPrincipal,
} from '../src/application/execution-context';

const token = 'test-pairing-token-'.repeat(4);
let processHandle: ChildProcess, endpoint: string, bridge: string;
const sockets = new Set<WebSocket>();
beforeAll(async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Missing temporary port');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  processHandle = spawn(process.execPath, ['--import', 'tsx', 'server/mcp.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, FUSION_MCP_PORT: String(port), FUSION_MCP_TOKEN: token },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    let output = '',
      errorOutput = '';
    const timer = setTimeout(
      () => reject(new Error(`Local MCP startup timed out: ${errorOutput}`)),
      15000,
    );
    processHandle.stderr!.on('data', (chunk) => {
      errorOutput = (errorOutput + String(chunk)).slice(-5000);
    });
    processHandle.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    processHandle.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Local MCP exited ${code}: ${errorOutput}`));
    });
    processHandle.stdout!.on('data', (chunk) => {
      output += String(chunk);
      if (!output.includes('\n')) return;
      try {
        const ready = JSON.parse(output.slice(0, output.indexOf('\n')));
        endpoint = ready.url;
        bridge = ready.bridge;
        clearTimeout(timer);
        resolve();
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}, 20000);
afterAll(async () => {
  for (const socket of sockets) socket.terminate();
  if (processHandle && processHandle.exitCode === null) {
    const closed = once(processHandle, 'close');
    processHandle.kill();
    await closed;
  }
});
async function pair() {
  const socket = new WebSocket(bridge, { headers: { Origin: 'http://127.0.0.1:3210' } });
  sockets.add(socket);
  const welcome = once(socket, 'message');
  await once(socket, 'open');
  socket.send(
    JSON.stringify({ type: 'authenticate', token, context: { owner: 'forged', scope: 'forged' } }),
  );
  const message = JSON.parse(String((await welcome)[0]));
  expect(message.type).toBe('authenticated');
  return { socket, context: parseExecutionPrincipal(message.context) };
}
async function disconnect(socket: WebSocket) {
  const close = once(socket, 'close');
  socket.close();
  await close;
  sockets.delete(socket);
}
async function call(arguments_: unknown = {}, extra: Record<string, unknown> = {}) {
  return (
    await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'fusion_state', arguments: arguments_, ...extra },
      }),
    })
  ).json();
}

it('uses server-generated identity and isolates every authenticated connection epoch', async () => {
  const first = await pair();
  expect(first.context.owner).toMatch(/^local:[a-f\d-]{36}$/);
  expect(first.context.scope).toMatch(/^[a-f\d-]{36}$/);
  await disconnect(first.socket);
  const second = await pair();
  expect(second.context.owner).toBe(first.context.owner);
  expect(second.context.scope).not.toBe(first.context.scope);
  await disconnect(second.socket);
});

it('keeps caller-supplied identity inside arguments and emits only its authenticated context', async () => {
  const { socket, context } = await pair(),
    next = once(socket, 'message'),
    forged = { owner: 'forged-owner', scope: 'forged-scope' },
    pending = call({ context: forged, owner: 'forged' }, { context: forged, owner: 'forged' }),
    command = JSON.parse(String((await next)[0]));
  expect(command.context).toEqual(context);
  expect(command.arguments).toEqual({ context: forged, owner: 'forged' });
  socket.send(
    JSON.stringify({ type: 'result', id: command.id, context, result: { ok: true, sentinel: 7 } }),
  );
  const result = await pending;
  expect(JSON.parse(result.result.content[0].text)).toEqual({ ok: true, sentinel: 7 });
  await disconnect(socket);
});

it('rejects a result from a different context and reports the interrupted request', async () => {
  const { socket, context } = await pair(),
    next = once(socket, 'message'),
    pending = call(),
    command = JSON.parse(String((await next)[0])),
    closed = once(socket, 'close');
  const wrong: ExecutionPrincipal = { ...context, scope: crypto.randomUUID() };
  socket.send(
    JSON.stringify({ type: 'result', id: command.id, context: wrong, result: { ok: true } }),
  );
  await closed;
  sockets.delete(socket);
  const result = await pending;
  expect(result.result.isError).toBe(true);
  expect(result.result.content[0].text).toContain('disconnected');
});
