'use client';
import SiteAgentBridge from './SiteAgentBridge';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { WorkspaceAuthority } from '../application/workspace-authority';
import { useWebMCP } from 'use-webmcp-tool';
import { Bot, Cable, Play, Unplug } from 'lucide-react';
import {
  createToolExecutor,
  TOOL_DEFINITIONS,
  type ToolAdapter,
  type ToolName,
} from '../application/tools';
import {
  createBrowserExecutionContext,
  parseExecutionPrincipal,
  sameExecutionPrincipal,
  type ExecutionPrincipal,
  type ToolExecutionContext,
} from '../application/execution-context';
type Executor = ReturnType<typeof createToolExecutor>;
const compatibleAuthority = Object.freeze({ phase: 'ready' as const, error: null });
const noSubscribe = () => () => {};
const compatibleSnapshot = () => compatibleAuthority;
const noRevoke = () => {};
function RegisterTool({
  definition,
  execute,
  getContext,
}: {
  definition: (typeof TOOL_DEFINITIONS)[number];
  execute: Executor;
  getContext: () => ToolExecutionContext;
}) {
  useWebMCP({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: definition.annotations,
    execute: (input: unknown, { signal }) =>
      execute(definition.name, input, { ...getContext(), signal }),
  });
  return null;
}
export default function AgentAccess({
  adapter,
  visible,
  authority,
}: {
  adapter: ToolAdapter;
  visible: boolean;
  authority?: WorkspaceAuthority;
}) {
  const ref = useRef(adapter);
  ref.current = adapter;
  const authorityRef = useRef(authority);
  authorityRef.current = authority;
  const authorityState = useSyncExternalStore(
      authority?.subscribe ?? noSubscribe,
      authority?.getSnapshot ?? compatibleSnapshot,
      authority?.getSnapshot ?? compatibleSnapshot,
    ),
    authorityReady = authorityState.phase === 'ready';
  const executeTool = useMemo(
    () =>
      createToolExecutor(
        new Proxy({} as ToolAdapter, { get: (_, key) => ref.current[key as keyof ToolAdapter] }),
      ),
    [],
  );
  const execute: Executor = useMemo(
    () => async (name, input, raw) => {
      const owner = authorityRef.current;
      if (!owner) return executeTool(name, input, raw);
      if (!raw || raw instanceof AbortSignal)
        throw new Error('Trusted execution context is required');
      const admitted = await owner.admit(raw);
      return executeTool(name, input, admitted);
    },
    [executeTool],
  );
  const [name, setName] = useState<ToolName>('fusion_state'),
    [input, setInput] = useState('{}'),
    [result, setResult] = useState(''),
    [running, setRunning] = useState(false),
    [url, setUrl] = useState('ws://127.0.0.1:3211/bridge'),
    [token, setToken] = useState(''),
    [connected, setConnected] = useState(false),
    [bridgeError, setBridgeError] = useState('');
  const socket = useRef<WebSocket | null>(null);
  const stopSocket = useRef<(() => void) | undefined>(undefined),
    mounted = useRef(true);
  const manualContext = useRef<ToolExecutionContext | undefined>(undefined),
    webMcpContext = useRef<ToolExecutionContext | undefined>(undefined);
  const contextAuthority = useRef(authority);
  if (contextAuthority.current !== authority) {
    contextAuthority.current = authority;
    manualContext.current = undefined;
    webMcpContext.current = undefined;
  }
  const getManualContext = () =>
    (manualContext.current ??=
      authorityRef.current?.localContext('manual') ?? createBrowserExecutionContext('manual'));
  const getWebMcpContext = () =>
    (webMcpContext.current ??=
      authorityRef.current?.localContext('webmcp') ?? createBrowserExecutionContext('webmcp'));
  useEffect(() => {
    mounted.current = true;
    void authority?.hydrate().catch(() => {});
    return () => {
      mounted.current = false;
      stopSocket.current?.();
    };
  }, [authority]);
  useEffect(() => {
    if (!authorityReady) stopSocket.current?.();
  }, [authorityReady]);
  function connectBridge() {
    try {
      if (authorityRef.current && authorityRef.current.getSnapshot().phase !== 'ready')
        throw new Error('Local workspace access is not ready');
      const endpoint = new URL(url);
      if (
        endpoint.protocol !== 'ws:' ||
        endpoint.hostname !== '127.0.0.1' ||
        endpoint.pathname !== '/bridge'
      )
        throw new Error('Use the local 127.0.0.1 bridge');
      if (token.length < 32)
        throw new Error('Enter the pairing token printed by the local MCP server');
      stopSocket.current?.();
      const ws = new WebSocket(url);
      let context: ExecutionPrincipal | undefined,
        revoke: (() => void) | undefined,
        stopped = false;
      const stop = (close = true) => {
        if (stopped) return;
        stopped = true;
        const release = revoke;
        revoke = undefined;
        try {
          release?.();
        } catch {
          /* Keep teardown independent of lease observers. */
        }
        if (socket.current === ws) {
          socket.current = null;
          if (stopSocket.current === stop) stopSocket.current = undefined;
          if (mounted.current) setConnected(false);
        }
        if (close) ws.close();
      };
      socket.current = ws;
      stopSocket.current = stop;
      ws.onopen = () => {
        if (!stopped && mounted.current && socket.current === ws)
          ws.send(JSON.stringify({ type: 'authenticate', token }));
      };
      ws.onmessage = async (event) => {
        if (
          stopped ||
          !mounted.current ||
          socket.current !== ws ||
          ws.readyState !== WebSocket.OPEN
        )
          return;
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === 'authenticated') {
            if (context) throw new Error('Local bridge sent a second authentication response');
            const raw = parseExecutionPrincipal(message.context);
            if (!raw.owner.startsWith('local:'))
              throw new Error('Local bridge returned an invalid pairing context');
            const release = authorityRef.current?.registerPairedActor(
              Object.freeze({ ...raw }),
              'local',
            );
            if (stopped || !mounted.current || socket.current !== ws) {
              release?.();
              return;
            }
            revoke = release;
            context = raw;
            setConnected(true);
            setBridgeError('');
            return;
          }
          if (
            message.type === 'command' &&
            typeof message.id === 'string' &&
            typeof message.name === 'string'
          ) {
            const commandContext = parseExecutionPrincipal(message.context);
            if (!context || !sameExecutionPrincipal(commandContext, context))
              throw new Error('Local command does not belong to this bridge connection');
            let value;
            try {
              value = await execute(message.name, message.arguments, { ...commandContext });
            } catch (e) {
              value = { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
            if (!stopped && socket.current === ws && ws.readyState === WebSocket.OPEN) {
              const envelope = { type: 'result', id: message.id, result: value, context };
              let serialized = JSON.stringify(envelope);
              if (new TextEncoder().encode(serialized).byteLength >= 24e6)
                serialized = JSON.stringify({
                  ...envelope,
                  result: {
                    ok: false,
                    error:
                      'Inline result exceeds the local 24 MB limit. Use fusion_file_export and fusion_file_chunk_read, or fusion_workspace_storage with action file-transfer, to retrieve file data.',
                  },
                });
              ws.send(serialized);
            }
          }
        } catch (e) {
          if (mounted.current && socket.current === ws) setBridgeError(String(e));
          stop();
        }
      };
      ws.onclose = () => {
        stop(false);
      };
      ws.onerror = () => {
        if (mounted.current && socket.current === ws)
          setBridgeError('Cannot reach the local bridge. Start the MCP server first.');
        stop();
      };
    } catch (e) {
      setBridgeError(String(e));
    }
  }
  return (
    <>
      {TOOL_DEFINITIONS.map((d) => (
        <RegisterTool key={d.name} definition={d} execute={execute} getContext={getWebMcpContext} />
      ))}
      <div className="page-panel" hidden={!visible}>
        <div className="eyebrow">APPLICATION COMMANDS</div>
        <h1>Agent access</h1>
        <p className="description">
          Agents and people use the same validated commands and USB transaction layer. WebMCP
          exposes these tools to a compatible browser agent. The Site MCP server and optional local
          bridge support MCP clients while this page owns the USB connections.
        </p>
        {!authorityReady && (
          <section className="feature-card" aria-label="Local workspace access">
            <p role={authorityState.phase === 'error' ? 'alert' : 'status'}>
              {authorityState.error ?? 'Loading local workspace access…'}
            </p>
            {authorityState.phase === 'error' && (
              <button onClick={() => void authorityRef.current?.retry().catch(() => {})}>
                Retry local workspace access
              </button>
            )}
          </section>
        )}
        <SiteAgentBridge
          execute={execute}
          authorityReady={authorityReady}
          onAuthenticated={(raw) =>
            authorityRef.current?.registerPairedActor(raw, 'site') ?? noRevoke
          }
        />
        <div className="settings-grid">
          <section className="feature-card">
            <Bot size={25} />
            <h2>{TOOL_DEFINITIONS.length} application tools</h2>
            <p>
              Every implemented operation is exposed with a runtime-validated schema. Hardware
              operations keep identity checks, backups, mute and readback verification.
            </p>
            <details>
              <summary>Developer command console</summary>
              <p className="hint">
                Optional testing console. Use the editing controls and Apply or Upload buttons
                elsewhere in the app for normal work.
              </p>
              <label className="field-label">
                Command
                <select
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value as ToolName);
                    setInput('{}');
                    setResult('');
                  }}
                >
                  {TOOL_DEFINITIONS.map((t) => (
                    <option key={t.name}>{t.name}</option>
                  ))}
                </select>
              </label>
              <p>{TOOL_DEFINITIONS.find((t) => t.name === name)?.description}</p>
              <details>
                <summary>Input schema</summary>
                <pre>
                  {JSON.stringify(
                    TOOL_DEFINITIONS.find((t) => t.name === name)?.inputSchema,
                    null,
                    2,
                  )}
                </pre>
              </details>
              <label className="field-label">
                Arguments (JSON)
                <textarea
                  aria-label="Agent command arguments"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <button
                disabled={running || !authorityReady}
                onClick={async () => {
                  setRunning(true);
                  try {
                    const value = await execute(name, JSON.parse(input), { ...getManualContext() });
                    setResult(JSON.stringify(value, null, 2));
                  } catch (e) {
                    setResult(JSON.stringify({ ok: false, error: String(e) }));
                  } finally {
                    setRunning(false);
                  }
                }}
              >
                <Play size={14} />
                {running ? 'Running…' : 'Run command'}
              </button>
              <pre className="command-result" aria-label="Agent command result">
                {result}
              </pre>
            </details>
          </section>
          <section className="feature-card">
            <Cable size={25} />
            <h2>Local MCP server</h2>
            <p>
              Start <code>pnpm mcp</code> in the project folder, then enter its pairing token. The
              server listens only on this computer. A connected agent acts through this browser.
            </p>
            <label className="field-label">
              Bridge URL
              <input value={url} onChange={(e) => setUrl(e.target.value)} disabled={connected} />
            </label>
            <label className="field-label">
              Pairing token
              <input
                aria-label="MCP pairing token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={connected}
                autoComplete="off"
              />
            </label>
            <button disabled={connected || !authorityReady} onClick={connectBridge}>
              <Cable size={14} />
              Connect MCP bridge
            </button>
            <button disabled={!connected} onClick={() => stopSocket.current?.()}>
              <Unplug size={14} />
              Disconnect
            </button>
            <p className={bridgeError ? 'inline-error' : 'hint'}>
              {bridgeError || (connected ? 'MCP bridge connected' : 'MCP bridge disconnected')}
            </p>
            <h2>Client configuration</h2>
            <pre>
              {JSON.stringify(
                {
                  mcpServers: {
                    fusion: {
                      url: 'http://127.0.0.1:3211/mcp',
                      headers: { Authorization: 'Bearer <pairing token>' },
                    },
                  },
                },
                null,
                2,
              )}
            </pre>
            <p className="hint">
              USB chooser permissions still belong to the browser. An agent can reconnect an already
              permitted amp by serial; a new amp needs its browser chooser once.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
