import { describe, expect, it, vi } from 'vitest';
import {
  createCaptureController,
  DEFAULT_CAPTURE_CONFIG,
  type CaptureBackend,
  type CaptureControllerOptions,
  type CaptureConfig,
  type CaptureRequest,
  type CaptureSession,
  type CaptureSnapshot,
} from '../src/application/measurement-capture';
import { createToolExecutor, TOOL_DEFINITIONS, type ToolAdapter } from '../src/application/tools';
import type { ToolExecutionContext } from '../src/application/execution-context';
import { HFD_RECORD_SAMPLES } from '../src/domain/hfd-audio';
import { defaultsHfdMeasurementOptions } from '../src/domain/hfd-measurement';
import { newProject } from '../src/domain/model';
import { createWorkspaceStore } from '../src/state/workspace';
import {
  assertWorkspaceWrite,
  type WorkspaceEnvelope,
  type WorkspacePersistenceBackend,
} from '../src/state/persistence';

const actor: ToolExecutionContext = { owner: 'site:alice', scope: 'lease-a' };
const other: ToolExecutionContext = { owner: 'site:bob', scope: 'lease-b' };
const human: ToolExecutionContext = { owner: 'browser:human', scope: 'ui:one' };
const target = { slot: 'right', preset: 1, channel: 2 } as const;
const request = (id = 'take-1'): CaptureRequest => ({
  requestId: id,
  target: { ...target },
  expectedRevision: 0,
  name: 'Actual capture',
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function setup(
  options: {
    sampleRate?: number;
    enableDeferred?: boolean;
    saveConfig?: CaptureControllerOptions['saveConfig'];
    onMeasurementReplaced?: CaptureControllerOptions['onMeasurementReplaced'];
  } = {},
) {
  const left = newProject('Original left'),
    right = newProject('Original right');
  const channel = right.presets[1].channels[2];
  channel.name = 'Physical driver';
  channel.outputName = 'High output';
  channel.hfdMeasurement = {
    ...defaultsHfdMeasurementOptions(48000),
    localStart: 5,
    stopInclusive: 12,
    phaseStart: 7,
    sharedStart: 3,
    sharedGroupId: 2,
    applyMicCorrection: true,
  };
  // Metadata-only is valid and makes the previous value easy to distinguish
  // from both native Clear and a newly captured original impulse.
  channel.measurement = { name: 'Previous native file', sampleRate: 48000 };
  let durable: WorkspaceEnvelope = {
    version: 1,
    state: {
      documents: { left, right },
      slot: 'left',
      preset: 0,
      channel: 0,
      filter: 0,
      linkedEdits: true,
      linkedControls: true,
      documentRevision: 0,
    },
  };
  const faults = { write: false, read: false };
  const disk: WorkspacePersistenceBackend = {
    read: async () => {
      if (faults.read) throw new Error('Readback unavailable');
      return structuredClone(durable);
    },
    readLegacy: () => null,
    write: async (next, expected) => {
      if (faults.write) throw new Error('Disk full');
      assertWorkspaceWrite(durable, expected, next);
      durable = structuredClone(next);
    },
  };
  const workspace = createWorkspaceStore(disk);
  await workspace.persistence.hydrate();
  const recording = deferred<Float64Array>(),
    pendingEnable = deferred<CaptureSession>();
  const invalidations: {
    listener: (reason: string) => void;
    unsubscribe: ReturnType<typeof vi.fn>;
  }[] = [];
  let beforeCapture: (() => void) | undefined, progress: ((frames: number) => void) | undefined;
  const session: CaptureSession = {
    info: {
      sampleRate: options.sampleRate ?? 96000,
      inputChannels: 2,
      outputChannels: 2,
      inputSampleRate: 48000,
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: false,
      timeOrigin: 'browser render-frame origin; no acoustic alignment',
    },
    preflight: vi.fn(),
    onUnavailable: vi.fn((listener: (reason: string) => void) => {
      const unsubscribe = vi.fn(() => {});
      invalidations.push({ listener, unsubscribe });
      return unsubscribe;
    }),
    capture: vi.fn(
      async (output: Float64Array, _signal: AbortSignal, onProgress: (frames: number) => void) => {
        expect(output).toBeInstanceOf(Float64Array);
        expect(output.length).toBe(HFD_RECORD_SAMPLES);
        expect(output.slice(HFD_RECORD_SAMPLES / 2).every((v) => v === 0)).toBe(true);
        beforeCapture?.();
        progress = onProgress;
        return recording.promise;
      },
    ),
    stop: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
  const backend: CaptureBackend = {
    devices: vi.fn(async () => [
      { deviceId: 'input-a', label: 'Two-channel interface', kind: 'audioinput' as const },
      { deviceId: 'output-a', label: 'Interface output', kind: 'audiooutput' as const },
    ]),
    chooseOutput: vi.fn(async () => 'chosen-output'),
    enable: vi.fn(async () => (options.enableDeferred ? pendingEnable.promise : session)),
  };
  let busy = false;
  const operate = vi.fn(async <T>(_label: string, fn: () => Promise<T>): Promise<T> => {
    if (busy) throw new Error('Another operation is still running');
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  }) as CaptureControllerOptions['operate'];
  const makeController = () =>
    createCaptureController({
      backend,
      operate,
      localOwner: human.owner,
      saveConfig: options.saveConfig,
      onMeasurementReplaced: options.onMeasurementReplaced,
      workspace: {
        state: workspace.store.getState,
        flush: workspace.persistence.flush,
        commit: (...args) => workspace.store.getState().commitFileImport(...args),
        lookup: (id, owner) => workspace.store.getState().lookupFileCommit(id, owner),
      },
    });
  const controller = makeController();
  const baseline = structuredClone(workspace.store.getState().documents);
  const settled = async (phase: CaptureSnapshot['phase']) => {
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe(phase), {
      timeout: 10000,
      interval: 5,
    });
    // The terminal snapshot is published before the operation's finally block.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    controller,
    backend,
    session,
    workspace,
    baseline,
    faults,
    recording,
    pendingEnable,
    operate,
    makeController,
    settled,
    invalidations,
    beforeCapture(fn: () => void) {
      beforeCapture = fn;
    },
    progress(frames: number) {
      progress?.(frames);
    },
    get durable() {
      return durable;
    },
  };
}

describe('shared browser measurement capture transactions', () => {
  it('ACKs immediately, clears the explicit target before audio, preserves shared/electrical settings, and commits actual-rate original samples once', async () => {
    const s = await setup();
    await s.controller.enable(actor);
    s.beforeCapture(() => {
      const current = s.workspace.store.getState();
      expect(current.documentRevision).toBe(1);
      expect(current.documents.right.presets[1].channels[2].measurement).toBeUndefined();
      expect(s.durable.state.fileCommitReceipts).toBeDefined();
    });
    const input = request();
    expect(s.controller.start(actor, input).phase).toBe('preparing');
    input.target.channel = 0;
    input.name = 'Changed after ACK';
    expect(s.session.capture).not.toHaveBeenCalled();
    await s.settled('recording');
    expect(s.controller.start(actor, request()).phase).toBe('recording');
    s.workspace.store.getState().choose({ slot: 'left', preset: 2, channel: 0 });
    s.progress(512);
    expect(s.controller.getSnapshot().recordedFrames).toBe(512);
    const cleared = s.workspace.store.getState().documents.right.presets[1].channels[2];
    expect(cleared.hfdMeasurement).toMatchObject({
      sampleRate: 96000,
      localStart: 0,
      stopInclusive: 65535,
      phaseStart: -1,
      sharedStart: 3,
      sharedGroupId: 2,
      applyMicCorrection: true,
    });
    expect(cleared.name).toBe('Physical driver');
    expect(cleared.outputName).toBe('High output');
    expect(cleared.filters).toEqual(s.baseline.right.presets[1].channels[2].filters);
    expect(() => {
      s.controller.getSnapshot().target!.channel = 0;
    }).toThrow();
    s.session.info.quantumFrames = 128;
    s.session.info.discardedInputFrames = 128;
    s.recording.resolve(new Float64Array(HFD_RECORD_SAMPLES));
    await s.settled('complete');
    const state = s.workspace.store.getState(),
      result = state.documents.right.presets[1].channels[2].measurement!;
    expect(result.name).toBe('Actual capture');
    expect(result.sampleRate).toBe(96000);
    expect(result.impulse).toHaveLength(65536);
    expect(result.impulse!.every((v) => v === 0)).toBe(true);
    expect(result.hfdMagnitude!.linearMagnitude.every((v) => v === 0)).toBe(true);
    expect(result.hfdPhase!.frequency).toHaveLength(1024);
    expect(s.controller.getSnapshot().runtime).toMatchObject({
      quantumFrames: 128,
      discardedInputFrames: 128,
    });
    expect(state.documents.left).toEqual(s.baseline.left);
    expect(state.documents.right.presets[0]).toEqual(s.baseline.right.presets[0]);
    expect(state.documents.right.presets[1].channels.slice(0, 2)).toEqual(
      s.baseline.right.presets[1].channels.slice(0, 2),
    );
    expect(s.session.capture).toHaveBeenCalledTimes(1);
    expect(s.controller.start(actor, request()).phase).toBe('complete');
    expect(s.workspace.persistence.getSnapshot()).toMatchObject({ unsaved: false, saving: false });
    await s.controller.dispose();
  });

  it('cancels without waiting for a backend, immediately stops output, leaves native Clear, and rejects late samples', async () => {
    const s = await setup();
    await s.controller.enable(actor);
    s.controller.start(actor, request());
    await s.settled('recording');
    const stops = vi.mocked(s.session.stop).mock.calls.length;
    expect(s.controller.cancel(actor, 'take-1').phase).toBe('cancelled');
    expect(s.session.stop).toHaveBeenCalledTimes(stops + 1);
    await s.settled('cancelled');
    expect(
      s.workspace.store.getState().documents.right.presets[1].channels[2].measurement,
    ).toBeUndefined();
    s.recording.resolve(new Float64Array(HFD_RECORD_SAMPLES).fill(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.workspace.store.getState().documentRevision).toBe(1);
    s.workspace.store.getState().undo();
    expect(s.workspace.store.getState().documents).toEqual(s.baseline);
    await s.controller.dispose();
  });

  it('commits the recovered deconvolution scale and gain cancellation, without peak normalization', async () => {
    const s = await setup({ sampleRate: 48000 });
    s.controller.configure(actor, { ...DEFAULT_CAPTURE_CONFIG, outputGainDb: -6 });
    await s.controller.enable(actor);
    s.controller.start(actor, request());
    await s.settled('recording');
    // Independent constant-input fixture from the recovered native kernel:
    // DC H(0)=-636.4279835940106 at48kHz. Playback gain cancels before it.
    s.recording.resolve(new Float64Array(HFD_RECORD_SAMPLES).fill(10 ** (-6 / 20)));
    await s.settled('complete');
    const impulse =
      s.workspace.store.getState().documents.right.presets[1].channels[2].measurement!.impulse!;
    for (const i of [0, 1, 100, 65535]) expect(impulse[i]).toBeCloseTo(-636.4279835940106, 6);
    expect(s.controller.getSnapshot().runtime!.sampleRate).toBe(48000);
    await s.controller.dispose();
  });

  it('does not Clear when readiness/preflight or the captured revision is stale', async () => {
    const s = await setup();
    await s.controller.enable(actor);
    vi.mocked(s.session.preflight!).mockImplementation(() => {
      throw new Error('Track ended');
    });
    s.controller.start(actor, request());
    await s.settled('error');
    expect(s.controller.getSnapshot().error).toContain('Track ended');
    expect(s.workspace.store.getState().documents).toEqual(s.baseline);
    expect(s.session.capture).not.toHaveBeenCalled();
    vi.mocked(s.session.preflight!).mockReset();
    s.workspace.store.getState().editAt(['left'], (project) => {
      project.name = 'New revision';
    });
    s.controller.start(actor, request('stale'));
    await s.settled('error');
    expect(s.controller.getSnapshot().error).toContain('design changed');
    expect(s.workspace.store.getState().documents.right).toEqual(s.baseline.right);
    expect(s.session.capture).not.toHaveBeenCalled();
    await s.controller.dispose();
  });

  it('retains an async stale result for its immutable destination, applies only with a fresh revision, and remains idempotent after Undo', async () => {
    const replaced = vi.fn(),
      s = await setup({ onMeasurementReplaced: replaced });
    await s.controller.enable(actor);
    s.controller.start(actor, request());
    await s.settled('recording');
    expect(replaced).toHaveBeenCalledExactlyOnceWith(target);
    s.workspace.store.getState().editAt(['left'], (project) => {
      project.name = 'Edited during recording';
    });
    s.workspace.store.getState().choose({ slot: 'left', preset: 0, channel: 0 });
    s.recording.resolve(new Float64Array(HFD_RECORD_SAMPLES));
    await s.settled('conflict');
    expect(replaced).toHaveBeenCalledTimes(1);
    expect(s.controller.getSnapshot().hasResult).toBe(true);
    expect(() => s.controller.start(actor, request('second'))).toThrow('Apply or discard');
    await expect(s.controller.apply(actor, 'take-1', 1)).rejects.toThrow('design changed');
    expect(
      s.workspace.store.getState().documents.right.presets[1].channels[2].measurement,
    ).toBeUndefined();
    const completed = await s.controller.apply(actor, 'take-1', 2);
    expect(replaced).toHaveBeenCalledTimes(2);
    expect(replaced).toHaveBeenLastCalledWith(target);
    expect(completed.phase).toBe('complete');
    expect(s.workspace.store.getState().documents.left.name).toBe('Edited during recording');
    expect(
      s.workspace.store.getState().documents.right.presets[1].channels[2].measurement!.impulse,
    ).toHaveLength(65536);
    s.workspace.store.getState().undo();
    const revision = s.workspace.store.getState().documentRevision;
    expect((await s.controller.apply(actor, 'take-1', revision!)).receipt).toEqual(
      completed.receipt,
    );
    expect(s.workspace.store.getState().documentRevision).toBe(revision);
    expect(replaced).toHaveBeenCalledTimes(2);
    expect(
      s.workspace.store.getState().documents.right.presets[1].channels[2].measurement,
    ).toBeUndefined();
    await s.controller.dispose();
  });

  it('discards a retained result without changing either document', async () => {
    const s = await setup();
    await s.controller.enable(actor);
    s.controller.start(actor, request());
    await s.settled('recording');
    s.workspace.store.getState().editAt(['left'], (project) => {
      project.name = 'Conflict';
    });
    s.recording.resolve(new Float64Array(HFD_RECORD_SAMPLES));
    await s.settled('conflict');
    const before = structuredClone(s.workspace.store.getState().documents);
    expect(s.controller.discard(actor, 'take-1').hasResult).toBe(false);
    expect(s.workspace.store.getState().documents).toEqual(before);
    await expect(s.controller.apply(actor, 'take-1', 2)).rejects.toThrow('no completed capture');
    await s.controller.dispose();
  });

  it('stops/disposes permission results that arrive after Disable, without opening a capture or editing data', async () => {
    const s = await setup({ enableDeferred: true });
    const enable = s.controller.enable(actor);
    const rejected = expect(enable).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(s.backend.enable).toHaveBeenCalledTimes(1));
    await s.controller.disable(human);
    await rejected;
    expect(s.controller.getSnapshot().phase).toBe('disabled');
    s.pendingEnable.resolve(s.session);
    await vi.waitFor(() => expect(s.session.dispose).toHaveBeenCalledTimes(1));
    expect(s.session.stop).toHaveBeenCalled();
    expect(s.session.capture).not.toHaveBeenCalled();
    expect(s.workspace.store.getState().documents).toEqual(s.baseline);
    await s.controller.dispose();
  });

  it('cleans up an invalid prepared session and releases an enabled session on routing changes', async () => {
    const s = await setup();
    s.session.info.inputChannels = 0;
    await expect(s.controller.enable(actor)).rejects.toThrow();
    expect(s.session.dispose).toHaveBeenCalledTimes(1);
    s.session.info.inputChannels = 2;
    await s.controller.enable(actor);
    const changed: CaptureConfig = { ...DEFAULT_CAPTURE_CONFIG, inputDeviceId: 'different-input' };
    expect(s.controller.configure(actor, changed)).toMatchObject({
      enabled: false,
      phase: 'disabled',
    });
    await vi.waitFor(() => expect(s.session.dispose).toHaveBeenCalledTimes(2));
    expect(s.workspace.store.getState().documents).toEqual(s.baseline);
    await s.controller.dispose();
  });

  it('saves an immutable preference clone first and preserves the current config/session when saving fails', async () => {
    let fail = true;
    let saved: Readonly<CaptureConfig> | undefined;
    const saveConfig = vi.fn((value: Readonly<CaptureConfig>) => {
      expect(Object.isFrozen(value)).toBe(true);
      expect(Reflect.set(value, 'outputGainDb', 999)).toBe(false);
      if (fail) throw new Error('Preferences unavailable');
      saved = value;
    });
    const s = await setup({ saveConfig });
    await s.controller.enable(actor);
    const before = s.controller.getSnapshot();
    const stops = vi.mocked(s.session.stop).mock.calls.length;
    expect(() =>
      s.controller.configure(actor, { ...DEFAULT_CAPTURE_CONFIG, inputDeviceId: 'another-input' }),
    ).toThrow('Preferences unavailable');
    expect(s.controller.getSnapshot()).toBe(before);
    expect(s.session.stop).toHaveBeenCalledTimes(stops);
    expect(s.session.dispose).not.toHaveBeenCalled();
    fail = false;
    const input = { ...DEFAULT_CAPTURE_CONFIG, outputGainDb: -12 };
    expect(s.controller.configure(actor, input)).toMatchObject({
      enabled: true,
      config: { outputGainDb: -12 },
    });
    expect(saved).toEqual(input);
    expect(saved).not.toBe(input);
    input.outputGainDb = 20;
    expect(saved!.outputGainDb).toBe(-12);
    expect(s.controller.getSnapshot().config.outputGainDb).toBe(-12);
    expect(s.session.dispose).not.toHaveBeenCalled();
    expect(saveConfig).toHaveBeenCalledTimes(2);
    await s.controller.dispose();
  });

  it('preserves a completed conflict result when a later Enable is cancelled', async () => {
    const s = await setup();
    await s.controller.enable(actor);
    s.controller.start(actor, request());
    await s.settled('recording');
    s.workspace.store.getState().editAt(['left'], (project) => {
      project.name = 'Concurrent edit';
    });
    s.recording.resolve(new Float64Array(HFD_RECORD_SAMPLES));
    await s.settled('conflict');
    await s.controller.disable(actor);
    expect(s.controller.getSnapshot().hasResult).toBe(true);
    vi.mocked(s.backend.enable).mockImplementationOnce(() => s.pendingEnable.promise);
    const enabling = s.controller.enable(actor);
    const rejected = expect(enabling).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(s.backend.enable).toHaveBeenCalledTimes(2));
    expect(s.controller.cancel(actor).hasResult).toBe(true);
    await rejected;
    expect(s.controller.getSnapshot().hasResult).toBe(true);
    s.pendingEnable.resolve(s.session);
    await vi.waitFor(() => expect(s.session.dispose).toHaveBeenCalledTimes(2));
    expect((await s.controller.apply(actor, 'take-1', 2)).phase).toBe('complete');
    expect(s.session.capture).toHaveBeenCalledTimes(1);
    await s.controller.dispose();
  });

  it('releases known unavailable idle sessions and ignores callbacks from an older subscription', async () => {
    const s = await setup();
    await s.controller.enable(actor);
    const old = s.invalidations[0];
    old.listener('Selected input ended');
    expect(s.controller.getSnapshot()).toMatchObject({
      phase: 'error',
      enabled: false,
      error: 'Selected input ended',
    });
    expect(old.unsubscribe).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(s.session.dispose).toHaveBeenCalledTimes(1));
    expect(s.workspace.store.getState().documents).toEqual(s.baseline);
    await s.controller.enable(actor);
    expect(s.controller.getSnapshot().phase).toBe('ready');
    old.listener('Stale failure must not affect a new session');
    expect(s.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      enabled: true,
      error: undefined,
    });
    expect(s.session.dispose).toHaveBeenCalledTimes(1);
    await s.controller.dispose();
    expect(s.invalidations[1].unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('stops active capture on known route loss, surfaces its reason, and preserves a retained result on later idle loss', async () => {
    const active = await setup();
    await active.controller.enable(actor);
    active.controller.start(actor, request());
    await active.settled('recording');
    active.invalidations[0].listener('Output route disconnected');
    await active.settled('error');
    expect(active.controller.getSnapshot()).toMatchObject({
      enabled: false,
      error: 'Output route disconnected',
      hasResult: false,
    });
    expect(
      active.workspace.store.getState().documents.right.presets[1].channels[2].measurement,
    ).toBeUndefined();
    expect(active.session.stop).toHaveBeenCalled();
    await active.controller.dispose();

    const pending = await setup();
    await pending.controller.enable(actor);
    pending.controller.start(actor, request());
    await pending.settled('recording');
    pending.workspace.store.getState().editAt(['left'], (project) => {
      project.name = 'Conflict';
    });
    pending.recording.resolve(new Float64Array(HFD_RECORD_SAMPLES));
    await pending.settled('conflict');
    pending.invalidations[0].listener('Idle device was removed');
    expect(pending.controller.getSnapshot()).toMatchObject({
      enabled: false,
      hasResult: true,
      phase: 'error',
    });
    expect((await pending.controller.apply(actor, 'take-1', 2)).phase).toBe('complete');
    expect(pending.session.capture).toHaveBeenCalledTimes(1);
    await pending.controller.dispose();
  });

  it('recovers a durable completion across a new controller and Undo without emitting again', async () => {
    const s = await setup();
    await s.controller.enable(actor);
    s.controller.start(actor, request());
    await s.settled('recording');
    s.recording.resolve(new Float64Array(HFD_RECORD_SAMPLES));
    await s.settled('complete');
    const receipt = s.controller.getSnapshot().receipt;
    await s.controller.dispose();
    s.workspace.store.getState().undo();
    const before = structuredClone(s.workspace.store.getState().documents),
      fresh = s.makeController();
    const revision = s.workspace.store.getState().documentRevision;
    fresh.start({ ...actor, scope: 'new-lease' }, request());
    await vi.waitFor(() => expect(fresh.getSnapshot().phase).toBe('complete'));
    expect(fresh.getSnapshot().receipt).toEqual(receipt);
    expect(s.workspace.store.getState().documentRevision).toBe(revision);
    expect(s.workspace.store.getState().documents).toEqual(before);
    expect(s.session.capture).toHaveBeenCalledTimes(1);
    expect(s.backend.enable).toHaveBeenCalledTimes(1);
    await fresh.dispose();
  });

  it('fences an interrupted durable Clear across a new controller instead of replaying an audible Take', async () => {
    const s = await setup();
    await s.controller.enable(actor);
    s.controller.start(actor, request());
    await s.settled('recording');
    s.controller.cancel(actor);
    await s.settled('cancelled');
    await s.controller.dispose();
    const fresh = s.makeController();
    fresh.start(actor, request());
    await vi.waitFor(() => expect(fresh.getSnapshot().phase).toBe('interrupted'));
    expect(s.session.capture).toHaveBeenCalledTimes(1);
    expect(s.workspace.store.getState().documentRevision).toBe(1);
    expect(
      s.workspace.store.getState().documents.right.presets[1].channels[2].measurement,
    ).toBeUndefined();
    await fresh.dispose();
  });

  it('rejects other owners and changed requestId parameters while allowing human cancellation and same-owner reconnection', async () => {
    const s = await setup();
    await s.controller.enable(actor);
    s.controller.start(actor, request());
    await s.settled('recording');
    expect(() => s.controller.cancel(other)).toThrow('another owner');
    expect(() => s.controller.configure(actor, { ...DEFAULT_CAPTURE_CONFIG })).toThrow(
      'current audio operation',
    );
    expect(() =>
      s.controller.start(actor, { ...request(), target: { ...target, channel: 0 } }),
    ).toThrow('different parameters');
    expect(s.controller.start({ ...actor, scope: 'new' }, request()).phase).toBe('recording');
    expect(s.controller.cancel(human).phase).toBe('cancelled');
    await s.settled('cancelled');
    await s.controller.dispose();
  });

  it('rejects changed parameters against a durable start fence after reload, without enabling or emitting audio', async () => {
    const s = await setup();
    await s.controller.enable(actor);
    s.controller.start(actor, request());
    await s.settled('recording');
    await s.controller.disable(actor);
    expect(s.controller.getSnapshot().phase).toBe('disabled');
    const fresh = s.makeController();
    fresh.start(actor, { ...request(), target: { slot: 'left', preset: 0, channel: 0 } });
    await vi.waitFor(() => expect(fresh.getSnapshot().phase).toBe('error'));
    expect(fresh.getSnapshot().error).toContain('different parameters');
    expect(s.backend.enable).toHaveBeenCalledTimes(1);
    expect(s.session.capture).toHaveBeenCalledTimes(1);
    expect(s.workspace.store.getState().documentRevision).toBe(1);
    expect(s.session.dispose).toHaveBeenCalledTimes(1);
    s.recording.resolve(new Float64Array(HFD_RECORD_SAMPLES));
    await fresh.dispose();
    await s.controller.dispose();
  });

  it('releases an active session on Dispose, stays disabled after late completion, and cannot be restarted', async () => {
    const s = await setup();
    await s.controller.enable(actor);
    s.controller.start(actor, request());
    await s.settled('recording');
    await s.controller.dispose();
    expect(s.controller.getSnapshot()).toMatchObject({
      phase: 'disabled',
      enabled: false,
      hasResult: false,
    });
    expect(s.session.dispose).toHaveBeenCalledTimes(1);
    expect(s.session.stop).toHaveBeenCalled();
    s.recording.resolve(new Float64Array(HFD_RECORD_SAMPLES));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.controller.getSnapshot().phase).toBe('disabled');
    expect(s.workspace.store.getState().documentRevision).toBe(1);
    expect(() => s.controller.start(actor, request('another'))).toThrow('disposed');
  });

  it('does not emit until Clear has durable readback, and never acknowledges a failed completion save', async () => {
    const s = await setup();
    await s.controller.enable(actor);
    s.faults.write = true;
    s.controller.start(actor, request());
    await s.settled('error');
    expect(s.session.capture).not.toHaveBeenCalled();
    expect(s.controller.getSnapshot().receipt).toBeUndefined();
    s.faults.write = false;
    await s.workspace.persistence.retry();
    // The first Clear may now be durable, but reusing its ID still cannot play.
    const fresh = s.makeController();
    fresh.start(actor, request());
    await vi.waitFor(() => expect(fresh.getSnapshot().phase).toBe('interrupted'));
    await fresh.dispose();
    await s.controller.dispose();

    const completed = await setup();
    await completed.controller.enable(actor);
    completed.controller.start(actor, request());
    await completed.settled('recording');
    completed.faults.read = true;
    completed.recording.resolve(new Float64Array(HFD_RECORD_SAMPLES));
    await completed.settled('conflict');
    expect(completed.controller.getSnapshot()).toMatchObject({
      hasResult: true,
      receipt: undefined,
    });
    completed.faults.read = false;
    await completed.workspace.persistence.retry();
    const revision = completed.workspace.store.getState().documentRevision!;
    expect((await completed.controller.apply(actor, 'take-1', revision)).phase).toBe('complete');
    expect(completed.workspace.store.getState().documentRevision).toBe(revision);
    expect(completed.session.capture).toHaveBeenCalledTimes(1);
    await completed.controller.dispose();
  });

  it('keeps a result retryable if Cancel arrives during Saving and the commit fails before publishing a receipt', async () => {
    const s = await setup();
    await s.controller.enable(actor);
    const commit = s.workspace.store.getState().commitFileImport;
    const pending = deferred<never>();
    s.workspace.store.setState({
      commitFileImport: async (...args) => {
        if ((args[5] as { stage?: string }).stage === 'complete') return pending.promise;
        return commit(...args);
      },
    });
    s.controller.start(actor, request());
    await s.settled('recording');
    s.recording.resolve(new Float64Array(HFD_RECORD_SAMPLES));
    await s.settled('saving');
    expect(s.controller.cancel(actor).phase).toBe('saving');
    s.workspace.store.setState({ commitFileImport: commit });
    pending.reject(new Error('Known failure before atomic publication'));
    await s.settled('conflict');
    expect(s.controller.getSnapshot().hasResult).toBe(true);
    expect((await s.controller.apply(actor, 'take-1', 1)).phase).toBe('complete');
    expect(
      s.workspace.store.getState().documents.right.presets[1].channels[2].measurement!.impulse,
    ).toHaveLength(65536);
    expect(s.session.capture).toHaveBeenCalledTimes(1);
    await s.controller.dispose();
  });

  it('leaves the cleared state on backend failure or invalid recording, with no fabricated sample data', async () => {
    const s = await setup();
    await s.controller.enable(actor);
    s.controller.start(actor, request());
    await s.settled('recording');
    s.recording.resolve(new Float64Array(128));
    await s.settled('error');
    expect(s.controller.getSnapshot().error).toContain('131072');
    expect(s.controller.getSnapshot().hasResult).toBe(false);
    expect(
      s.workspace.store.getState().documents.right.presets[1].channels[2].measurement,
    ).toBeUndefined();
    s.workspace.store.getState().undo();
    expect(s.workspace.store.getState().documents).toEqual(s.baseline);
    await s.controller.dispose();
  });

  it('notifies the zero-based fixed target only after actual Clear and result replacements, with two unchanged Undo steps and no replay notifications', async () => {
    let s: Awaited<ReturnType<typeof setup>>;
    const observed: (number | undefined)[] = [],
      replaced = vi.fn((input) => {
        expect(Object.isFrozen(input)).toBe(true);
        observed.push(
          s.workspace.store.getState().documents[input.slot as 'left' | 'right'].presets[
            input.preset
          ].channels[input.channel].measurement?.impulse?.length,
        );
      });
    s = await setup({ onMeasurementReplaced: replaced });
    await s.controller.enable(actor);
    expect(replaced).not.toHaveBeenCalled();
    const input = request();
    s.controller.start(actor, input);
    await s.settled('recording');
    expect(replaced).toHaveBeenCalledExactlyOnceWith(target);
    expect(replaced.mock.calls[0][0]).not.toBe(input.target);
    expect(observed).toEqual([undefined]);
    s.recording.resolve(new Float64Array(HFD_RECORD_SAMPLES));
    await s.settled('complete');
    expect(replaced).toHaveBeenCalledTimes(2);
    expect(observed).toEqual([undefined, 65536]);
    expect(s.session.capture).toHaveBeenCalledTimes(1);
    expect(s.workspace.store.getState().past).toHaveLength(2);
    s.workspace.store.getState().undo();
    expect(
      s.workspace.store.getState().documents.right.presets[1].channels[2].measurement,
    ).toBeUndefined();
    s.workspace.store.getState().undo();
    expect(s.workspace.store.getState().documents).toEqual(s.baseline);
    await s.controller.dispose();
    const replay = s.makeController();
    replay.start(actor, request());
    await vi.waitFor(() => expect(replay.getSnapshot().phase).toBe('complete'));
    expect(replaced).toHaveBeenCalledTimes(2);
    expect(s.session.capture).toHaveBeenCalledTimes(1);
    await replay.dispose();
  });

  it('does not notify for settings, enable/status or cancellation before Clear, but does for Clear retained after later cancellation', async () => {
    const replaced = vi.fn(),
      s = await setup({ onMeasurementReplaced: replaced });
    await s.controller.devices(actor);
    s.controller.configure(actor, { ...DEFAULT_CAPTURE_CONFIG, outputGainDb: -12 });
    await s.controller.enable(actor);
    s.controller.getSnapshot();
    s.controller.start(actor, request('cancel-before-clear'));
    s.controller.cancel(actor);
    await s.settled('cancelled');
    expect(replaced).not.toHaveBeenCalled();
    expect(s.session.capture).not.toHaveBeenCalled();
    s.controller.start(actor, request('cancel-after-clear'));
    await s.settled('recording');
    expect(replaced).toHaveBeenCalledExactlyOnceWith(target);
    s.controller.cancel(actor);
    await s.settled('cancelled');
    expect(replaced).toHaveBeenCalledTimes(1);
    expect(s.workspace.store.getState().past).toHaveLength(1);
    await s.controller.dispose();
  });

  it.each(['clear', 'complete'] as const)(
    'does not notify for lost%s delivery or its later receipt replay',
    async (stage) => {
      const replaced = vi.fn(),
        s = await setup({ onMeasurementReplaced: replaced }),
        commit = s.workspace.store.getState().commitFileImport;
      s.workspace.store.setState({
        commitFileImport: async (...args) => {
          const result = await commit(...args);
          if ((args[5] as { stage?: string }).stage === stage)
            throw new Error('Lost receipt delivery');
          return result;
        },
      });
      await s.controller.enable(actor);
      s.controller.start(actor, request());
      if (stage === 'clear') {
        await s.settled('error');
        expect(replaced).not.toHaveBeenCalled();
        s.workspace.store.setState({ commitFileImport: commit });
        const fresh = s.makeController();
        fresh.start(actor, request());
        await vi.waitFor(() => expect(fresh.getSnapshot().phase).toBe('interrupted'));
        expect(replaced).not.toHaveBeenCalled();
        expect(s.session.capture).not.toHaveBeenCalled();
        await fresh.dispose();
      } else {
        await s.settled('recording');
        s.recording.resolve(new Float64Array(HFD_RECORD_SAMPLES));
        await s.settled('conflict');
        expect(replaced).toHaveBeenCalledTimes(1);
        s.workspace.store.setState({ commitFileImport: commit });
        await s.controller.apply(actor, 'take-1', s.workspace.store.getState().documentRevision!);
        expect(s.controller.getSnapshot().phase).toBe('complete');
        expect(replaced).toHaveBeenCalledTimes(1);
        expect(s.session.capture).toHaveBeenCalledTimes(1);
      }
      await s.controller.dispose();
    },
  );

  it('ignores presentation observer errors after applied replacements without retrying audio or misreporting capture success', async () => {
    const replaced = vi.fn(() => {
        throw new Error('View-only refresh failed');
      }),
      s = await setup({ onMeasurementReplaced: replaced });
    await s.controller.enable(actor);
    s.controller.start(actor, request());
    await s.settled('recording');
    s.recording.resolve(new Float64Array(HFD_RECORD_SAMPLES));
    await s.settled('complete');
    expect(s.controller.getSnapshot()).toMatchObject({
      phase: 'complete',
      hasResult: false,
      error: undefined,
    });
    expect(replaced).toHaveBeenCalledTimes(2);
    expect(s.session.capture).toHaveBeenCalledTimes(1);
    expect(s.workspace.store.getState().documentRevision).toBe(2);
    expect(s.workspace.store.getState().past).toHaveLength(2);
    await s.controller.dispose();
  });
});

describe('fusion_audio shared UI/MCP command', () => {
  const publicConfig = { ...DEFAULT_CAPTURE_CONFIG, inputChannel: 1, outputChannel: 1 };
  const toolRequest = () => ({ ...request(), target: { slot: 'right', preset: 2, channel: 3 } });
  async function tools() {
    const s = await setup();
    const hardware = vi.fn(() => {
      throw new Error('No hardware operation is authorized by capture');
    });
    const adapter: ToolAdapter = {
      state: s.workspace.store.getState,
      edit: (slots, fn) => s.workspace.store.getState().editAt(slots, fn),
      choose: (patch) => s.workspace.store.getState().choose(patch),
      undo: () => s.workspace.store.getState().undo(),
      redo: () => s.workspace.store.getState().redo(),
      connections: hardware,
      connect: async () => hardware(),
      disconnect: async () => hardware(),
      refresh: async () => hardware(),
      progress: hardware,
      operate: s.operate,
      message: vi.fn(),
      view: vi.fn(),
      capture: s.controller,
    };
    return { ...s, hardware, execute: createToolExecutor(adapter) };
  }
  type Reply = {
    ok: boolean;
    error?: string;
    capture?: CaptureSnapshot;
    devices?: unknown[];
    outputDeviceId?: string;
  };
  it('exposes a root-object schema, requires trusted context, and rejects spoofed identity and incomplete commands before effects', async () => {
    const s = await tools();
    const schema = TOOL_DEFINITIONS.find((tool) => tool.name === 'fusion_audio')!.inputSchema;
    expect(schema.type).toBe('object');
    expect(((await s.execute('fusion_audio', { action: 'enable' })) as Reply).error).toContain(
      'trusted',
    );
    for (const args of [
      { action: 'enable', owner: actor.owner },
      { action: 'start', requestId: 'missing-target' },
      { action: 'status', expectedRevision: 0 },
      { action: 'start', ...toolRequest(), target: { slot: 'right', preset: 2, channel: 0 } },
      { action: 'configure', config: { ...publicConfig, outputGainDb: Infinity } },
    ])
      expect(((await s.execute('fusion_audio', args, actor)) as Reply).ok).toBe(false);
    expect(s.backend.enable).not.toHaveBeenCalled();
    expect(s.session.capture).not.toHaveBeenCalled();
    expect(s.hardware).not.toHaveBeenCalled();
    await s.controller.dispose();
  });

  it('routes configure/devices/output/enable/start/status/cancel/disable through the same controller with bounded metadata only', async () => {
    const s = await tools();
    expect(
      ((await s.execute('fusion_audio', { action: 'devices' }, actor)) as Reply).devices,
    ).toHaveLength(2);
    expect(
      ((await s.execute('fusion_audio', { action: 'choose-output' }, actor)) as Reply)
        .outputDeviceId,
    ).toBe('chosen-output');
    expect(
      (
        (await s.execute(
          'fusion_audio',
          { action: 'configure', config: { ...publicConfig, outputGainDb: -6 } },
          actor,
        )) as Reply
      ).capture!.config.outputGainDb,
    ).toBe(-6);
    expect(
      ((await s.execute('fusion_audio', { action: 'enable' }, actor)) as Reply).capture!.phase,
    ).toBe('ready');
    const first = (await s.execute(
      'fusion_audio',
      { action: 'start', ...toolRequest() },
      actor,
    )) as Reply;
    expect(first.capture!.phase).toBe('preparing');
    await s.settled('recording');
    expect(
      ((await s.execute('fusion_audio', { action: 'start', ...toolRequest() }, actor)) as Reply)
        .capture!.phase,
    ).toBe('recording');
    expect(
      ((await s.execute('fusion_audio', { action: 'cancel' }, other)) as Reply).error,
    ).toContain('another owner');
    const status = (await s.execute('fusion_audio', { action: 'status' }, actor)) as Reply;
    expect(status.capture!.target).toEqual({ slot: 'right', preset: 2, channel: 3 });
    expect(status.capture!.config).toMatchObject({ inputChannel: 1, outputChannel: 1 });
    expect(s.controller.getSnapshot().target).toEqual(target);
    expect(JSON.stringify(status).length).toBeLessThan(65536);
    expect(JSON.stringify(status)).not.toMatch(/"(impulse|stimulus|kernel|recording)":/);
    expect(
      ((await s.execute('fusion_audio', { action: 'cancel', requestId: 'take-1' }, actor)) as Reply)
        .capture!.phase,
    ).toBe('cancelled');
    await s.settled('cancelled');
    expect(
      ((await s.execute('fusion_audio', { action: 'disable' }, actor)) as Reply).capture!.phase,
    ).toBe('disabled');
    expect(s.operate).toHaveBeenCalledWith('Taking measurement', expect.any(Function));
    expect(s.session.capture).toHaveBeenCalledTimes(1);
    expect(s.hardware).not.toHaveBeenCalled();
    await s.controller.dispose();
  });

  it('applies/discards stale results through MCP and cannot retarget them with command arguments', async () => {
    const s = await tools();
    await s.controller.enable(actor);
    await s.execute('fusion_audio', { action: 'start', ...toolRequest() }, actor);
    await s.settled('recording');
    s.workspace.store.getState().editAt(['left'], (project) => {
      project.name = 'Concurrent edit';
    });
    s.recording.resolve(new Float64Array(HFD_RECORD_SAMPLES));
    await s.settled('conflict');
    expect(
      (
        (await s.execute(
          'fusion_audio',
          {
            action: 'apply',
            requestId: 'take-1',
            expectedRevision: 2,
            target: { ...target, slot: 'left' },
          },
          actor,
        )) as Reply
      ).ok,
    ).toBe(false);
    expect(
      (
        (await s.execute(
          'fusion_audio',
          { action: 'apply', requestId: 'take-1', expectedRevision: 2 },
          actor,
        )) as Reply
      ).capture!.phase,
    ).toBe('complete');
    const revision = s.workspace.store.getState().documentRevision;
    expect(
      (
        (await s.execute(
          'fusion_audio',
          { action: 'apply', requestId: 'take-1', expectedRevision: revision },
          actor,
        )) as Reply
      ).capture!.phase,
    ).toBe('complete');
    expect(s.workspace.store.getState().documentRevision).toBe(revision);
    expect(
      (
        (await s.execute(
          'fusion_audio',
          { action: 'discard', requestId: 'take-1' },
          actor,
        )) as Reply
      ).capture!.hasResult,
    ).toBe(false);
    expect(s.hardware).not.toHaveBeenCalled();
    await s.controller.dispose();
  });

  it('shares native Clear semantics with the UI while a browser Clear simply removes the legacy measurement', async () => {
    const s = await tools();
    const native = (await s.execute(
      'fusion_measurement_set',
      { target: 'right', preset: 2, channel: 3, name: '', text: null, sampleRate: 96000 },
      actor,
    )) as Reply;
    expect(native.ok).toBe(true);
    const channel = s.workspace.store.getState().documents.right.presets[1].channels[2];
    expect(channel.measurement).toBeUndefined();
    expect(channel.hfdMeasurement).toMatchObject({
      sampleRate: 48000,
      localStart: 0,
      stopInclusive: 65535,
      phaseStart: -1,
      sharedStart: 3,
      sharedGroupId: 2,
    });
    expect(channel.filters).toEqual(s.baseline.right.presets[1].channels[2].filters);
    s.workspace.store.getState().undo();
    expect(s.workspace.store.getState().documents).toEqual(s.baseline);
    expect(
      (
        (await s.execute(
          'fusion_measurement_set',
          {
            target: 'left',
            preset: 1,
            channel: 1,
            name: 'Browser file',
            text: '100 3\n1000 -2',
            format: 'frequency',
            analysis: 'browser',
          },
          actor,
        )) as Reply
      ).ok,
    ).toBe(true);
    expect(
      (
        (await s.execute(
          'fusion_measurement_set',
          { target: 'left', preset: 1, channel: 1, name: '', text: null },
          actor,
        )) as Reply
      ).ok,
    ).toBe(true);
    expect(
      s.workspace.store.getState().documents.left.presets[0].channels[0].measurement,
    ).toBeUndefined();
    expect(
      s.workspace.store.getState().documents.left.presets[0].channels[0].hfdMeasurement,
    ).toBeUndefined();
    expect(s.hardware).not.toHaveBeenCalled();
    await s.controller.dispose();
  });

  it('uses one-based public audio channels and Right/P3/CH2 while the controller remains zero-based', async () => {
    const s = await tools();
    for (const args of [
      { action: 'configure', config: { ...publicConfig, inputChannel: 0 } },
      { action: 'configure', config: { ...publicConfig, outputChannel: 0 } },
      { action: 'start', ...toolRequest(), target: { slot: 'right', preset: 0, channel: 2 } },
      { action: 'start', ...toolRequest(), target: { slot: 'right', preset: 3, channel: 0 } },
    ])
      expect(((await s.execute('fusion_audio', args, actor)) as Reply).ok).toBe(false);
    expect(s.operate).not.toHaveBeenCalled();
    expect(s.backend.enable).not.toHaveBeenCalled();
    expect(s.workspace.store.getState().documents).toEqual(s.baseline);
    const configured = (await s.execute(
      'fusion_audio',
      { action: 'configure', config: { ...publicConfig, inputChannel: 2 } },
      actor,
    )) as Reply;
    expect(configured.capture!.config).toMatchObject({ inputChannel: 2, outputChannel: 1 });
    expect(s.controller.getSnapshot().config).toMatchObject({ inputChannel: 1, outputChannel: 0 });
    const enabled = (await s.execute('fusion_audio', { action: 'enable' }, actor)) as Reply;
    expect(enabled.capture!.config.inputChannel).toBe(2);
    const publicTarget = { slot: 'right', preset: 3, channel: 2 };
    const started = (await s.execute(
      'fusion_audio',
      { action: 'start', ...toolRequest(), target: publicTarget },
      actor,
    )) as Reply;
    expect(started.capture!.target).toEqual(publicTarget);
    await s.settled('recording');
    expect(s.controller.getSnapshot().target).toEqual({ slot: 'right', preset: 2, channel: 1 });
    s.recording.resolve(new Float64Array(HFD_RECORD_SAMPLES));
    await s.settled('complete');
    const status = (await s.execute('fusion_audio', { action: 'status' }, actor)) as Reply;
    expect(status.capture!.target).toEqual(publicTarget);
    expect(status.capture!.config.inputChannel).toBe(2);
    expect((status.capture!.receipt!.result as { target: unknown }).target).toEqual(publicTarget);
    expect(
      s.workspace.store.getState().documents.right.presets[2].channels[1].measurement!.impulse,
    ).toHaveLength(65536);
    expect(s.workspace.store.getState().documents.right.presets[1].channels[2]).toEqual(
      s.baseline.right.presets[1].channels[2],
    );
    expect(s.workspace.store.getState().documents.left).toEqual(s.baseline.left);
    expect(s.hardware).not.toHaveBeenCalled();
    await s.controller.dispose();
  });

  it('provides the identical trusted one-based audio command through the cached HFD-measurement alias', async () => {
    const s = await tools();
    const configure = vi.spyOn(s.controller, 'configure');
    const alias = (audio: unknown) => ({
      action: 'audio',
      target: 'both',
      preset: 3,
      channel: 2,
      audio,
    });
    expect(
      ((await s.execute('fusion_hfd_measurement', alias({ action: 'status' }))) as Reply).error,
    ).toContain('trusted');
    for (const args of [
      { action: 'audio' },
      { action: 'inspect', target: 'left', preset: 1, audio: { action: 'status' } },
      alias({ action: 'configure', config: { ...publicConfig, inputChannel: 0 } }),
      alias({ action: 'status', owner: actor.owner }),
      { ...alias({ action: 'status' }), patch: { sampleRate: 48000 } },
    ])
      expect(((await s.execute('fusion_hfd_measurement', args, actor)) as Reply).ok).toBe(false);
    const configured = (await s.execute(
      'fusion_hfd_measurement',
      alias({
        action: 'configure',
        config: { ...publicConfig, inputChannel: 2, outputGainDb: -9 },
      }),
      actor,
    )) as Reply;
    expect(configured.capture!.config).toMatchObject({
      inputChannel: 2,
      outputChannel: 1,
      outputGainDb: -9,
    });
    expect(configure).toHaveBeenCalledWith(actor, {
      ...DEFAULT_CAPTURE_CONFIG,
      inputChannel: 1,
      outputGainDb: -9,
    });
    const status = (await s.execute(
      'fusion_hfd_measurement',
      alias({ action: 'status' }),
      actor,
    )) as Reply;
    expect(status).toEqual(await s.execute('fusion_audio', { action: 'status' }, actor));
    expect(s.controller.getSnapshot().config.inputChannel).toBe(1);
    expect(s.workspace.store.getState().documentRevision).toBe(0);
    expect(s.workspace.store.getState().documents).toEqual(s.baseline);
    expect(s.backend.enable).not.toHaveBeenCalled();
    expect(s.session.capture).not.toHaveBeenCalled();
    expect(s.operate).not.toHaveBeenCalled();
    expect(s.hardware).not.toHaveBeenCalled();
    await s.controller.dispose();
  });

  it('provides the same audio command through the existing processing tool without mixing legacy edits', async () => {
    const s = await tools();
    const configure = vi.spyOn(s.controller, 'configure');
    const alias = (audio: unknown) => ({ target: 'both', preset: 3, channel: 2, audio });
    expect(
      ((await s.execute('fusion_measurement_processing', alias({ action: 'status' }))) as Reply)
        .error,
    ).toContain('trusted');
    const invalid = [
      alias({ action: 'configure', config: { ...publicConfig, outputChannel: 0 } }),
      alias({ action: 'status', owner: actor.owner }),
      ...['reset', 'resetWindow', 'peakZero', 'calibrationEnabled', 'clearCalibration'].map(
        (key) => ({ ...alias({ action: 'status' }), [key]: false }),
      ),
      { ...alias({ action: 'status' }), sampleRate: 48000 },
    ];
    for (const args of invalid)
      expect(((await s.execute('fusion_measurement_processing', args, actor)) as Reply).ok).toBe(
        false,
      );
    const configured = (await s.execute(
      'fusion_measurement_processing',
      alias({
        action: 'configure',
        config: { ...publicConfig, inputChannel: 2, outputGainDb: -12 },
      }),
      actor,
    )) as Reply;
    expect(configured.capture!.config).toMatchObject({
      inputChannel: 2,
      outputChannel: 1,
      outputGainDb: -12,
    });
    expect(configure).toHaveBeenCalledExactlyOnceWith(actor, {
      ...DEFAULT_CAPTURE_CONFIG,
      inputChannel: 1,
      outputGainDb: -12,
    });
    expect(
      await s.execute('fusion_measurement_processing', alias({ action: 'status' }), actor),
    ).toEqual(await s.execute('fusion_audio', { action: 'status' }, actor));
    expect(s.controller.getSnapshot().config.inputChannel).toBe(1);
    expect(s.workspace.store.getState().documentRevision).toBe(0);
    expect(s.workspace.store.getState().documents).toEqual(s.baseline);
    expect(s.backend.enable).not.toHaveBeenCalled();
    expect(s.session.capture).not.toHaveBeenCalled();
    expect(s.operate).not.toHaveBeenCalled();
    expect(s.hardware).not.toHaveBeenCalled();
    await s.controller.dispose();
  });
});
