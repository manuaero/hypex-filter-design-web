'use client';
import { useEffect, useRef, useState } from 'react';
import { Cloud, Unplug } from 'lucide-react';
import {
  parseExecutionPrincipal,
  sameExecutionPrincipal,
  type ExecutionPrincipal,
  type ToolExecutionContext,
} from '../application/execution-context';
import {
  createBridgeKeyPair,
  deriveBridgeCommandKey,
  parseBridgeEncryptedRequest,
  openBridgePayload,
  sealBridgePayload,
  BridgeCryptoError,
} from '../application/bridge-crypto';
export default function SiteAgentBridge({
  execute,
  onAuthenticated,
  authorityReady = true,
}: {
  execute: (name: string, input: unknown, context: ToolExecutionContext) => Promise<unknown>;
  onAuthenticated?: (context: Readonly<ExecutionPrincipal>) => () => void;
  authorityReady?: boolean;
}) {
  const executor = useRef(execute);
  executor.current = execute;
  const authenticated = useRef(onAuthenticated),
    stopCurrent = useRef<(() => void) | undefined>(undefined);
  authenticated.current = onAuthenticated;
  const [enabled, setEnabled] = useState(false),
    [status, setStatus] = useState('Disabled'),
    [failure, setFailure] = useState(''),
    [available, setAvailable] = useState(false);
  const session = useRef<string>('');
  useEffect(() => {
    setAvailable(!['localhost', '127.0.0.1'].includes(location.hostname));
  }, []);
  useEffect(() => {
    if (!enabled || !authorityReady) {
      if (!authorityReady) setEnabled(false);
      return;
    }
    let stopped = false,
      running = false,
      context: ExecutionPrincipal | undefined,
      privateKey: CryptoKey | undefined,
      heartbeatTimer: ReturnType<typeof setInterval> | undefined,
      revoke: (() => void) | undefined;
    session.current = crypto.randomUUID();
    const id = session.current;
    const shutdown = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      void request('session', { session: id, action: 'stop' }).catch(() => {});
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      const release = revoke;
      revoke = undefined;
      try {
        release?.();
      } catch {
        /* Revocation must not interrupt an admitted operation. */
      }
      if (!running) {
        privateKey = undefined;
        shutdown();
      }
    };
    stopCurrent.current = stop;
    const request = async (path: string, body: unknown, serializedBody?: string) => {
      const response = await fetch(`/api/agent/${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Fusion-Request': '1' },
          body: serializedBody ?? JSON.stringify(body),
        }),
        data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Site agent bridge request failed');
      return data;
    };
    const poll = async () => {
      if (stopped) return;
      try {
        const data = await request('next', { session: id, longPoll: true });
        // A newly claimed command must not start after an outstanding poll's
        // owning effect has been disabled or replaced by another session.
        if (stopped) return;
        if (data.command) {
          const commandContext = parseExecutionPrincipal(data.command.context);
          if (!context || !sameExecutionPrincipal(commandContext, context))
            throw new Error('Site command does not belong to this browser session');
          if (!privateKey)
            throw new BridgeCryptoError(
              'Encrypted browser pairing is unavailable; reload and enable Site agent access',
            );
          const binding = {
              owner: context.owner,
              session: id,
              commandId: data.command.id,
              name: data.command.name,
            },
            payload = parseBridgeEncryptedRequest(data.command.payload),
            key = await deriveBridgeCommandKey(privateKey, payload.publicKey, binding),
            decoded = await openBridgePayload(key, binding, 'request', payload.encrypted);
          if (
            !decoded ||
            typeof decoded !== 'object' ||
            Object.keys(decoded).length !== 1 ||
            !('arguments' in decoded)
          )
            throw new BridgeCryptoError();
          if (stopped) return;
          running = true;
          setStatus(`Running ${data.command.name}`);
          let result: unknown;
          try {
            result = await executor.current(data.command.name, decoded.arguments, {
              ...commandContext,
            });
          } catch (e) {
            result = { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
          const envelope = { session: id, id: data.command.id, result };
          let encrypted;
          try {
            encrypted = await sealBridgePayload(key, binding, 'result', envelope);
          } catch (error) {
            if (
              !(error instanceof BridgeCryptoError) ||
              !/exceeds|serializable/.test(error.message)
            )
              throw error;
            encrypted = await sealBridgePayload(key, binding, 'result', {
              ...envelope,
              result: {
                ok: false,
                error: error.message.includes('exceeds')
                  ? 'Inline result exceeds the hosted 8 MB limit. Use fusion_file_export and fusion_file_chunk_read, or fusion_workspace_storage with action file-transfer, to retrieve file data.'
                  : 'Inline result is not serializable. Inspect the visible application before retrying.',
              },
            });
          }
          // Only the ciphertext envelope crosses queue storage; the authenticated
          // HTTPS MCP endpoint still handles decrypted values in memory.
          await request('result', { session: id, id: data.command.id, encrypted });
          running = false;
          if (stopped) {
            privateKey = undefined;
            shutdown();
            return;
          }
          setStatus('Connected · waiting for agent commands');
        }
      } catch (e) {
        // The application await has settled before result encryption/submission.
        // A failed delivery must not leave a false running flag or start more
        // commands; the visible application remains the source of its outcome.
        const hadOperation = running;
        running = false;
        if (stopped) {
          if (hadOperation) shutdown();
          return;
        }
        setFailure(e instanceof Error ? e.message : String(e));
        stop();
        setEnabled(false);
        return;
      }
      if (!stopped) void poll();
    };
    void createBridgeKeyPair()
      .then(async (pair) => {
        if (stopped) return;
        privateKey = pair.privateKey;
        const data = await request('session', {
          session: id,
          action: 'start',
          publicKey: pair.publicKey,
        });
        return data;
      })
      .then((data) => {
        if (stopped || !data) {
          shutdown();
          return;
        }
        context = parseExecutionPrincipal(data.context);
        if (context.scope !== id || !context.owner.startsWith('site:'))
          throw new Error('Site pairing returned an invalid browser context');
        const release = authenticated.current?.(Object.freeze({ ...context }));
        if (stopped) {
          release?.();
          shutdown();
          return;
        }
        revoke = release;
        setFailure('');
        setStatus('Connected · waiting for agent commands');
        heartbeatTimer = setInterval(() => {
          void request('session', { session: id, action: 'heartbeat' }).catch((e) => {
            if (stopped) return;
            setFailure(String(e));
            stop();
            setEnabled(false);
          });
        }, 4000);
        void poll();
      })
      .catch((e) => {
        if (stopped) return;
        setFailure(String(e));
        stop();
        setEnabled(false);
      });
    return () => {
      stop();
      if (stopCurrent.current === stop) stopCurrent.current = undefined;
      setStatus('Disabled');
    };
  }, [enabled, authorityReady]);
  return (
    <section className="feature-card">
      <Cloud size={25} />
      <h2>Site MCP server</h2>
      <p>
        The private Site exposes this application’s commands to its ChatGPT/Codex plugin. Enable
        access in the browser that owns the amplifier connections, and keep this page open.
      </p>
      <div className="button-row">
        <button
          disabled={enabled || !available || !authorityReady}
          onClick={() => setEnabled(true)}
        >
          Enable Site agent access
        </button>
        <button
          disabled={!enabled}
          onClick={() => {
            stopCurrent.current?.();
            setEnabled(false);
          }}
        >
          <Unplug size={14} />
          Disable access
        </button>
      </div>
      <p className={failure ? 'inline-error' : 'hint'}>{failure || status}</p>
      <p className="hint">
        {available
          ? 'Commands and requested results pass through your private Site HTTPS endpoint. Transient queue objects are encrypted with in-memory keys; this is not end-to-end encryption. USB operations run here, using the same identity checks, backup and mute rules as the UI.'
          : 'Hosted access is available at the private Site URL. This local preview uses the local MCP bridge below.'}
      </p>
      <p className="hint">
        One browser can be paired per signed-in Site user. Closing or disabling it stops new
        commands. A flash operation already running is allowed to finish.
      </p>
    </section>
  );
}
