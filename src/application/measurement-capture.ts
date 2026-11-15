import type { Project, Slot } from '../domain/model';
import type { ToolExecutionContext } from './execution-context';
import type { TransferJson } from './file-transfers';
import { parseExecutionPrincipal } from './execution-context';
import { clearHfdCapture, applyHfdCapture } from '../domain/hfd-measurement';
import { prepareHfdAudio, deconvolveHfdAudio, HFD_RECORD_SAMPLES } from '../domain/hfd-audio';
import { z } from 'zod';

export interface CaptureConfig {
  inputDeviceId: string;
  outputDeviceId: string;
  inputChannel: number;
  outputChannel: number;
  requestedSampleRate?: number;
  outputGainDb: number;
}
export interface CaptureDevice {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
  groupId?: string;
}
export interface CaptureRuntimeInfo {
  sampleRate: number;
  inputChannels: number;
  outputChannels: number;
  inputSampleRate?: number;
  baseLatency?: number;
  outputLatency?: number;
  inputDeviceId?: string;
  outputDeviceId?: string;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  timeOrigin: string;
  quantumFrames?: number;
  discardedInputFrames?: number;
  firstOutputFrame?: number;
  firstInputFrame?: number;
  inputPeak?: number;
  clippedInputSamples?: number;
  outputPeak?: number;
  clippedOutputSamples?: number;
}
export interface CaptureSession {
  /** The backend may update diagnostics after capture; snapshots copy this object. */
  info: CaptureRuntimeInfo;
  /** Synchronous readiness check immediately before Clear. Never emits audio. */
  preflight?(): void;
  /** Known route/track/context loss; ordinary dispose must not notify. */
  onUnavailable?(listener: (reason: string) => void): () => void;
  /** Return exactly131072 original input samples at info.sampleRate. */
  capture(
    output: Float64Array,
    signal: AbortSignal,
    onProgress: (recordedFrames: number) => void,
  ): Promise<Float64Array>;
  /** Immediately silence output. Must also terminate an outstanding capture. */
  stop(): void;
  /** Release every track, audio node and AudioContext owned by this session. */
  dispose(): Promise<void>;
}
export interface CaptureBackend {
  devices(): Promise<CaptureDevice[]>;
  chooseOutput?(): Promise<string>;
  enable(config: Readonly<CaptureConfig>, signal: AbortSignal): Promise<CaptureSession>;
}
export interface CaptureTarget {
  slot: Slot;
  /** Zero-based preset and channel. Capture never expands linked edits. */
  preset: number;
  channel: number;
}
export interface CaptureRequest {
  requestId: string;
  target: CaptureTarget;
  expectedRevision: number;
  name?: string;
}
export type CapturePhase =
  | 'disabled'
  | 'enabling'
  | 'ready'
  | 'preparing'
  | 'clearing'
  | 'recording'
  | 'processing'
  | 'saving'
  | 'complete'
  | 'conflict'
  | 'cancelled'
  | 'interrupted'
  | 'error';
export interface CaptureCommitReceipt {
  commitId: string;
  revision: number;
  result: TransferJson;
}
export interface CaptureSnapshot {
  phase: CapturePhase;
  enabled: boolean;
  config: CaptureConfig;
  requestId?: string;
  target?: CaptureTarget;
  expectedRevision?: number;
  recordedFrames: number;
  totalFrames: number;
  runtime?: CaptureRuntimeInfo;
  error?: string;
  receipt?: CaptureCommitReceipt;
  hasResult: boolean;
}
export interface CaptureWorkspace {
  state(): {
    documents: Record<Slot, Project>;
    documentRevision?: number;
    gesture?: unknown;
  };
  flush(): Promise<void>;
  commit(
    commitId: string,
    principal: { owner: string; scope: string },
    expectedRevision: number,
    slots: Slot[],
    apply: (project: Project) => void,
    result: TransferJson,
  ): Promise<CaptureCommitReceipt>;
  lookup(commitId: string, owner: string): Promise<CaptureCommitReceipt | undefined>;
}
export interface CaptureControllerOptions {
  backend: CaptureBackend;
  workspace: CaptureWorkspace;
  operate<T>(label: string, action: () => Promise<T>): Promise<T>;
  /** The page's human UI may stop agent-owned audio. Never accept this from tool arguments. */
  localOwner?: string;
  config?: CaptureConfig;
  /** Synchronous preference save. Failure leaves the current route untouched. */
  saveConfig?: (config: Readonly<CaptureConfig>) => void;
  /** View-only observer of a successfully delivered, newly applied replacement.
   * Indices are zero-based. Replayed receipts never notify. Observer failures
   * cannot turn an already committed Clear/Take into a failed audio operation. */
  onMeasurementReplaced?: (input: CaptureTarget) => void;
}
export interface CaptureController {
  getSnapshot(): CaptureSnapshot;
  subscribe(listener: () => void): () => void;
  devices(context: ToolExecutionContext): Promise<CaptureDevice[]>;
  chooseOutput(context: ToolExecutionContext): Promise<string>;
  configure(context: ToolExecutionContext, config: CaptureConfig): CaptureSnapshot;
  enable(context: ToolExecutionContext): Promise<CaptureSnapshot>;
  /** Accept synchronously; completion is observed through snapshots. */
  start(context: ToolExecutionContext, request: CaptureRequest): CaptureSnapshot;
  cancel(context: ToolExecutionContext, requestId?: string): CaptureSnapshot;
  disable(context: ToolExecutionContext): Promise<CaptureSnapshot>;
  apply(
    context: ToolExecutionContext,
    requestId: string,
    expectedRevision: number,
  ): Promise<CaptureSnapshot>;
  discard(context: ToolExecutionContext, requestId: string): CaptureSnapshot;
  dispose(): Promise<void>;
}

export const DEFAULT_CAPTURE_CONFIG: Readonly<CaptureConfig> = Object.freeze({
  inputDeviceId: '',
  outputDeviceId: '',
  inputChannel: 0,
  outputChannel: 0,
  outputGainDb: 0,
});
export const captureConfigSchema = z
  .object({
    inputDeviceId: z.string().max(2048),
    outputDeviceId: z.string().max(2048),
    inputChannel: z.number().int().min(0).max(255),
    outputChannel: z.number().int().min(0).max(255),
    requestedSampleRate: z.number().finite().min(8000).max(384000).optional(),
    outputGainDb: z.number().finite(),
  })
  .strict();
export const captureTargetSchema = z
  .object({
    slot: z.enum(['left', 'right']),
    preset: z.number().int().min(0).max(2),
    channel: z.number().int().min(0).max(2),
  })
  .strict();
export const captureRequestSchema = z
  .object({
    requestId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/),
    target: captureTargetSchema,
    expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    name: z.string().max(4096).optional(),
  })
  .strict();

type Job = {
  context: { owner: string; scope: string };
  request: CaptureRequest;
  config: CaptureConfig;
  signature: string;
  controller: AbortController;
  result?: Float64Array;
  runtime?: CaptureRuntimeInfo;
  clearRevision?: number;
  task?: Promise<void>;
  committing?: boolean;
  failureReason?: string;
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 2048);
const abortError = () => new Error('Capture cancelled');
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) {
          try {
            late?.(value);
          } catch (error) {
            reject(error);
            return;
          }
          reject(abortError());
        } else resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
function runtimeInfo(info: CaptureRuntimeInfo): CaptureRuntimeInfo {
  const parsed = z
    .object({
      sampleRate: z.number().finite().gt(12),
      inputChannels: z.number().int().min(1).max(256),
      outputChannels: z.number().int().min(1).max(256),
      inputSampleRate: z.number().finite().positive().optional(),
      baseLatency: z.number().finite().nonnegative().optional(),
      outputLatency: z.number().finite().nonnegative().optional(),
      inputDeviceId: z.string().max(2048).optional(),
      outputDeviceId: z.string().max(2048).optional(),
      echoCancellation: z.boolean().optional(),
      noiseSuppression: z.boolean().optional(),
      autoGainControl: z.boolean().optional(),
      timeOrigin: z.string().max(4096),
      quantumFrames: z.number().int().nonnegative().optional(),
      discardedInputFrames: z.number().int().nonnegative().optional(),
      firstOutputFrame: z.number().int().nonnegative().optional(),
      firstInputFrame: z.number().int().nonnegative().optional(),
      inputPeak: z.number().finite().nonnegative().optional(),
      clippedInputSamples: z.number().int().nonnegative().optional(),
      outputPeak: z.number().finite().nonnegative().optional(),
      clippedOutputSamples: z.number().int().nonnegative().optional(),
    })
    .strict()
    .parse(info);
  return parsed;
}

/** A browser-owned audio transaction. Only samples and receipts enter the
 * workspace; streams, permissions and pending results are never hydrated. */
export function createCaptureController(options: CaptureControllerOptions): CaptureController {
  let config = captureConfigSchema.parse(options.config ?? DEFAULT_CAPTURE_CONFIG),
    snapshot: CaptureSnapshot = freeze({
      phase: 'disabled',
      enabled: false,
      config: { ...config },
      recordedFrames: 0,
      totalFrames: HFD_RECORD_SAMPLES,
      hasResult: false,
    }),
    session: CaptureSession | undefined,
    sessionOwner: string | undefined,
    sessionUnsubscribe: (() => void) | undefined,
    sessionEpoch = 0,
    enabling:
      | {
          context: { owner: string; scope: string };
          controller: AbortController;
          task: Promise<CaptureSnapshot>;
        }
      | undefined,
    job: Job | undefined,
    disposed = false,
    disposing: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const requests = new Map<string, { signature: string; snapshot: CaptureSnapshot }>();
  const keyFor = (owner: string, id: string) => `${owner.length}:${owner}:${id}`;
  const receiptId = (j: Job, stage: 'clear' | 'result') =>
    `audio-${stage}:${keyFor(j.context.owner, j.request.requestId)}`;
  const active = () => !!job?.task || !!enabling;
  const set = (patch: Partial<CaptureSnapshot>) => {
    snapshot = freeze({ ...snapshot, ...patch, config: { ...config } });
    for (const listener of listeners) listener();
  };
  const assertAlive = () => {
    if (disposed) throw new Error('Audio capture controller is disposed');
  };
  const principal = (context: ToolExecutionContext) => {
    assertAlive();
    context.signal?.throwIfAborted();
    return parseExecutionPrincipal({ owner: context.owner, scope: context.scope });
  };
  const control = (context: ToolExecutionContext) => {
    const actor = principal(context),
      owner =
        enabling?.context.owner ??
        (job?.task || job?.result ? job.context.owner : undefined) ??
        sessionOwner;
    if (owner && actor.owner !== owner && actor.owner !== options.localOwner)
      throw new Error('Audio capture belongs to another owner');
    return actor;
  };
  const stop = () => {
    try {
      session?.stop();
    } catch {
      /* Continue mandatory cleanup. */
    }
  };
  const release = () => {
    const previous = session,
      unsubscribe = sessionUnsubscribe;
    session = undefined;
    sessionOwner = undefined;
    sessionUnsubscribe = undefined;
    sessionEpoch++;
    try {
      unsubscribe?.();
    } catch {
      /* Resource disposal must still run. */
    }
    if (previous) {
      try {
        previous.stop();
      } catch {
        /* dispose still releases tracks/context */
      }
      disposing = disposing.catch(() => {}).then(() => previous.dispose());
    }
    set({ enabled: false });
    return disposing;
  };
  const assertJob = (j: Job) => {
    if (disposed || job !== j || j.controller.signal.aborted) throw abortError();
  };
  const remember = (j: Job) => {
    requests.set(keyFor(j.context.owner, j.request.requestId), {
      signature: j.signature,
      snapshot: freeze(structuredClone(snapshot)),
    });
    if (requests.size > 256) requests.delete(requests.keys().next().value!);
  };
  const checkReceipt = (receipt: CaptureCommitReceipt, j: Job) => {
    const result = receipt.result as { signature?: string };
    if (!result || result.signature !== j.signature)
      throw new Error('This capture requestId was already used with different parameters');
  };
  const measurementReplaced = (target: CaptureTarget) => {
    try {
      options.onMeasurementReplaced?.(Object.freeze({ ...target }));
    } catch {
      // A presentation observer is not part of the durable/audio transaction.
    }
  };
  const finish = async (j: Job, expectedRevision: number) => {
    const previous = await options.workspace.lookup(receiptId(j, 'result'), j.context.owner);
    if (previous) {
      checkReceipt(previous, j);
      j.result = undefined;
      set({ phase: 'complete', receipt: previous, hasResult: false, error: j.failureReason });
      return;
    }
    assertJob(j);
    if (!j.result || !j.runtime) throw new Error('There is no completed capture to apply');
    const result = j.result,
      runtime = j.runtime;
    if ((options.workspace.state().documentRevision ?? 0) !== expectedRevision)
      throw new Error('The design changed; inspect the result and Apply with the current revision');
    set({ phase: 'saving', hasResult: true, error: undefined });
    j.committing = true;
    try {
      let applied = false;
      const receipt = await options.workspace.commit(
        receiptId(j, 'result'),
        j.context,
        expectedRevision,
        [j.request.target.slot],
        (project) => {
          applyHfdCapture(
            project.presets[j.request.target.preset].channels[j.request.target.channel],
            result,
            runtime.sampleRate,
            j.request.name ?? 'Recorded measurement',
          );
          applied = true;
        },
        {
          stage: 'complete',
          signature: j.signature,
          requestId: j.request.requestId,
          target: { ...j.request.target },
          sampleRate: runtime.sampleRate,
          samples: result.length,
          runtime: { ...runtime },
        } as TransferJson,
      );
      if (applied) measurementReplaced(j.request.target);
      // Once the durable mutation began, cancellation cannot undo it or turn its
      // success into a false cancellation. Undo remains the explicit inverse.
      j.result = undefined;
      set({ phase: 'complete', receipt, hasResult: false, error: j.failureReason });
    } finally {
      j.committing = false;
    }
  };
  const run = async (j: Job) => {
    try {
      await options.operate('Taking measurement', async () => {
        assertJob(j);
        const completed = await options.workspace.lookup(receiptId(j, 'result'), j.context.owner);
        assertJob(j);
        if (completed) {
          checkReceipt(completed, j);
          set({ phase: 'complete', receipt: completed, hasResult: false });
          return;
        }
        const cleared = await options.workspace.lookup(receiptId(j, 'clear'), j.context.owner);
        assertJob(j);
        if (cleared) {
          checkReceipt(cleared, j);
          set({
            phase: 'interrupted',
            error:
              'This Take already cleared the measurement. Its audio cannot be replayed with the same requestId; use Undo or start a new Take.',
            hasResult: false,
          });
          return;
        }
        const current = options.workspace.state();
        if (current.gesture)
          throw new Error('Finish the current graph edit before taking a measurement');
        if ((current.documentRevision ?? 0) !== j.request.expectedRevision)
          throw new Error('The design changed before capture started');
        if (!session) throw new Error('Enable recording before taking a measurement');
        const preparedSession = session;
        preparedSession.preflight?.();
        const info = runtimeInfo(preparedSession.info);
        if (
          j.config.inputChannel >= info.inputChannels ||
          j.config.outputChannel >= info.outputChannels
        )
          throw new Error('The selected audio channel is unavailable');
        j.runtime = info;
        set({ phase: 'preparing', runtime: info });
        const prepared = prepareHfdAudio(info.sampleRate, j.config.outputGainDb);
        await options.workspace.flush();
        assertJob(j);
        preparedSession.preflight?.();
        const latestInfo = runtimeInfo(preparedSession.info);
        if (
          latestInfo.sampleRate !== info.sampleRate ||
          latestInfo.inputChannels !== info.inputChannels ||
          latestInfo.outputChannels !== info.outputChannels
        )
          throw new Error('The audio device changed during preparation');
        set({ phase: 'clearing' });
        let appliedClear = false;
        const clear = await options.workspace.commit(
          receiptId(j, 'clear'),
          j.context,
          j.request.expectedRevision,
          [j.request.target.slot],
          (project) => {
            clearHfdCapture(
              project.presets[j.request.target.preset].channels[j.request.target.channel],
              info.sampleRate,
            );
            appliedClear = true;
          },
          {
            stage: 'clear',
            signature: j.signature,
            requestId: j.request.requestId,
            target: { ...j.request.target },
            sampleRate: info.sampleRate,
          },
        );
        if (appliedClear) measurementReplaced(j.request.target);
        j.clearRevision = clear.revision;
        assertJob(j);
        if ((options.workspace.state().documentRevision ?? 0) !== clear.revision)
          throw new Error(
            'The design changed after Clear and before audio started; no sweep was emitted',
          );
        preparedSession.preflight?.();
        set({ phase: 'recording' });
        const recording = await abortable(
          preparedSession.capture(prepared.output, j.controller.signal, (frames) => {
            if (job === j && !j.controller.signal.aborted && snapshot.phase === 'recording')
              set({
                recordedFrames: Math.max(
                  0,
                  Math.min(HFD_RECORD_SAMPLES, Number.isFinite(frames) ? Math.floor(frames) : 0),
                ),
              });
          }),
          j.controller.signal,
        );
        assertJob(j);
        preparedSession.stop();
        j.runtime = runtimeInfo(preparedSession.info);
        if (j.runtime.sampleRate !== info.sampleRate)
          throw new Error('The audio sample rate changed during capture');
        set({ phase: 'processing', runtime: j.runtime, recordedFrames: HFD_RECORD_SAMPLES });
        j.result = deconvolveHfdAudio(prepared, recording);
        assertJob(j);
        set({ hasResult: true });
        if ((options.workspace.state().documentRevision ?? 0) !== clear.revision) {
          set({
            phase: 'conflict',
            error:
              'The design changed after Clear. The captured result is retained for this fixed target; inspect it, then Apply with the current revision or Discard.',
          });
          return;
        }
        await finish(j, clear.revision);
      });
    } catch (error) {
      if (job === j)
        set({
          phase: j.failureReason
            ? 'error'
            : j.controller.signal.aborted
              ? 'cancelled'
              : j.result
                ? 'conflict'
                : 'error',
          error: j.failureReason ?? message(error),
          hasResult: !!j.result,
        });
    } finally {
      if (job === j) {
        stop();
        j.task = undefined;
        remember(j);
      }
    }
  };

  const controller: CaptureController = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    devices: async (context) => {
      principal(context);
      const devices = await options.backend.devices();
      if (!Array.isArray(devices) || devices.length > 256)
        throw new Error('Audio device list exceeds the supported size');
      return z
        .array(
          z
            .object({
              deviceId: z.string().max(2048),
              label: z.string().max(2048),
              kind: z.enum(['audioinput', 'audiooutput']),
              groupId: z.string().max(2048).optional(),
            })
            .strict(),
        )
        .parse(devices);
    },
    chooseOutput: async (context) => {
      control(context);
      if (active()) throw new Error('Finish the current audio operation before choosing an output');
      if (!options.backend.chooseOutput)
        throw new Error('Output-device selection is unavailable in this browser');
      const id = await options.backend.chooseOutput();
      return z.string().max(2048).parse(id);
    },
    configure: (context, next) => {
      control(context);
      if (active())
        throw new Error('Finish the current audio operation before changing capture settings');
      const validated = captureConfigSchema.parse(next);
      options.saveConfig?.(Object.freeze({ ...validated }));
      const routing = (c: CaptureConfig) => JSON.stringify({ ...c, outputGainDb: 0 });
      if (routing(validated) !== routing(config) && session)
        void release().catch((error) => set({ phase: 'error', error: message(error) }));
      config = validated;
      set({
        phase: session ? 'ready' : 'disabled',
        runtime: session ? runtimeInfo(session.info) : undefined,
        error: undefined,
      });
      return snapshot;
    },
    enable: (context) => {
      const actor = control(context);
      if (enabling) return enabling.task;
      if (job?.task) throw new Error('A measurement is still running');
      if (session) return Promise.resolve(snapshot);
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      context.signal?.addEventListener('abort', onAbort, { once: true });
      set({ phase: 'enabling', error: undefined });
      const task = (async () => {
        try {
          await options.operate('Preparing audio capture', async () => {
            await disposing;
            if (abort.signal.aborted || disposed) throw abortError();
            const prepared = await abortable(
              options.backend.enable(Object.freeze({ ...config }), abort.signal),
              abort.signal,
              (late) => {
                try {
                  late.stop();
                } finally {
                  void late.dispose().catch(() => {});
                }
              },
            );
            if (disposed || abort.signal.aborted) {
              prepared.stop();
              await prepared.dispose();
              throw abortError();
            }
            let accepted = false;
            try {
              const info = runtimeInfo(prepared.info);
              if (
                config.inputChannel >= info.inputChannels ||
                config.outputChannel >= info.outputChannels
              )
                throw new Error('The selected audio channel is unavailable');
              prepared.preflight?.();
              session = prepared;
              sessionOwner = actor.owner;
              accepted = true;
              const epoch = ++sessionEpoch;
              const unsubscribe = prepared.onUnavailable?.((reason) => {
                if (session !== prepared || epoch !== sessionEpoch) return;
                const failure = message(reason || 'The selected audio device is unavailable');
                if (job?.task) {
                  job.failureReason = failure;
                  if (!job.committing) job.controller.abort();
                }
                set({ phase: 'error', enabled: false, error: failure, hasResult: !!job?.result });
                void release().catch((error) =>
                  set({ phase: 'error', error: `${failure}: ${message(error)}` }),
                );
              });
              if (session !== prepared || epoch !== sessionEpoch) {
                unsubscribe?.();
                throw new Error(snapshot.error ?? 'The audio device became unavailable');
              }
              sessionUnsubscribe = unsubscribe;
              set({ phase: 'ready', enabled: true, runtime: info, error: undefined });
            } catch (error) {
              if (accepted) {
                if (session === prepared) await release();
                else await disposing;
              } else {
                prepared.stop();
                await prepared.dispose();
              }
              throw error;
            }
          });
          return snapshot;
        } catch (error) {
          set({
            phase: abort.signal.aborted ? 'cancelled' : 'error',
            enabled: false,
            error: message(error),
          });
          throw error;
        } finally {
          context.signal?.removeEventListener('abort', onAbort);
          enabling = undefined;
        }
      })();
      enabling = { context: actor, controller: abort, task };
      return task;
    },
    start: (context, input) => {
      const actor = control(context),
        request = captureRequestSchema.parse(input),
        signature = JSON.stringify({ request, config }),
        key = keyFor(actor.owner, request.requestId);
      if (job?.context.owner === actor.owner && job.request.requestId === request.requestId) {
        if (job.signature !== signature)
          throw new Error('This capture requestId was already used with different parameters');
        return snapshot;
      }
      const previous = requests.get(key);
      if (previous) {
        if (previous.signature !== signature)
          throw new Error('This capture requestId was already used with different parameters');
        return previous.snapshot;
      }
      if (active()) throw new Error('Another audio operation is still running');
      if (job?.result) throw new Error('Apply or discard the previous captured result first');
      const current = options.workspace.state();
      if (
        !current.documents[request.target.slot]?.presets[request.target.preset]?.channels[
          request.target.channel
        ]
      )
        throw new Error('Invalid capture destination');
      const next: Job = {
        context: actor,
        request,
        config: { ...config },
        signature,
        controller: new AbortController(),
      };
      job = next;
      set({
        phase: 'preparing',
        requestId: request.requestId,
        target: { ...request.target },
        expectedRevision: request.expectedRevision,
        recordedFrames: 0,
        hasResult: false,
        receipt: undefined,
        error: undefined,
      });
      // Acknowledgement is immediate. The task owns its AbortController rather
      // than the lifetime/deadline of the already-acknowledged MCP command.
      next.task = Promise.resolve().then(() => run(next));
      return snapshot;
    },
    cancel: (context, requestId) => {
      control(context);
      if (requestId && job?.request.requestId !== requestId)
        throw new Error('Capture request was not found');
      if (!active()) {
        stop();
        return snapshot;
      }
      enabling?.controller.abort();
      // Saving is already silent and may have published its atomic receipt.
      // Keep its token usable if a known pre-commit failure retains the result.
      if (job?.task && !job.committing) job.controller.abort();
      stop();
      if (!job?.committing) {
        if (job?.task) job.result = undefined;
        set({
          phase: 'cancelled',
          hasResult: !!job?.result,
          error:
            'Capture cancelled. A measurement already cleared by Take stays cleared; Undo restores it.',
        });
      }
      return snapshot;
    },
    disable: async (context) => {
      control(context);
      const tasks = [enabling?.task, job?.task].filter((task) => task !== undefined);
      controller.cancel(context);
      await release();
      await Promise.allSettled(tasks);
      set({ phase: 'disabled', enabled: false });
      return snapshot;
    },
    apply: async (context, requestId, expectedRevision) => {
      control(context);
      if (!job || job.request.requestId !== requestId)
        throw new Error('Capture request was not found');
      if (job.task || enabling) throw new Error('Wait for the current audio operation to finish');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
        throw new Error('Invalid design revision');
      const currentJob = job;
      const task = options.operate('Applying captured measurement', () =>
        finish(currentJob, expectedRevision),
      );
      currentJob.task = task.then(
        () => {},
        () => {},
      );
      try {
        await task;
      } catch (error) {
        set({
          phase: currentJob.result ? 'conflict' : 'error',
          hasResult: !!currentJob.result,
          error: message(error),
        });
        throw error;
      } finally {
        currentJob.task = undefined;
        remember(currentJob);
      }
      return snapshot;
    },
    discard: (context, requestId) => {
      control(context);
      if (!job || job.request.requestId !== requestId)
        throw new Error('Capture request was not found');
      if (job.task || enabling) throw new Error('Cancel the running capture before discarding');
      job.result = undefined;
      set({ phase: 'cancelled', hasResult: false, error: undefined });
      remember(job);
      return snapshot;
    },
    dispose: async () => {
      if (disposed) return disposing;
      disposed = true;
      const tasks = [enabling?.task, job?.task].filter((task) => task !== undefined);
      enabling?.controller.abort();
      job?.controller.abort();
      if (job) job.result = undefined;
      await release();
      await Promise.allSettled(tasks);
      set({ phase: 'disabled', enabled: false, hasResult: false });
    },
  };
  return controller;
}
