import { afterEach, expect, it, vi } from 'vitest';
import {
  createBrowserCaptureBackend,
  type BrowserCaptureEnvironment,
} from '../src/audio/browser-capture';
import type { CaptureConfig, CaptureSession } from '../src/application/measurement-capture';
import { HFD_RECORD_SAMPLES } from '../src/domain/hfd-audio';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class AudioNodeFake extends EventTarget {
  connect = vi.fn((destination: AudioNodeFake) => destination);
  disconnect = vi.fn();
  channelCount = 2;
  channelCountMode = 'max';
  channelInterpretation = 'speakers';
}
class PortFake {
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn<(message: Record<string, unknown>, transfer?: Transferable[]) => void>();
  close = vi.fn();
  receive(data: Record<string, unknown>) {
    this.onmessage?.({ data } as MessageEvent);
  }
}
class TrackFake extends EventTarget {
  readyState: MediaStreamTrackState = 'live';
  muted = false;
  settings: MediaTrackSettings = {
    deviceId: 'input-a',
    channelCount: 2,
    sampleRate: 44100,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
  getSettings = vi.fn(() => ({ ...this.settings }));
}

const config: CaptureConfig = {
  inputDeviceId: 'input-a',
  outputDeviceId: 'output-b',
  inputChannel: 1,
  outputChannel: 2,
  requestedSampleRate: 96000,
  outputGainDb: -12,
};
const sessionsForCleanup: CaptureSession[] = [];
function fixture() {
  const track = new TrackFake(),
    stream = {
      getAudioTracks: vi.fn(() => [track]),
      getTracks: vi.fn(() => [track]),
    } as unknown as MediaStream,
    media = Object.assign(new EventTarget(), {
      enumerateDevices: vi.fn(async () => [
        { deviceId: 'input-a', label: 'ADC', kind: 'audioinput', groupId: 'interface' },
        { deviceId: 'output-b', label: 'DAC', kind: 'audiooutput', groupId: 'interface' },
        { deviceId: 'camera', label: 'Camera', kind: 'videoinput', groupId: '' },
      ]),
      getSupportedConstraints: vi.fn(() => ({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      })),
      getUserMedia: vi.fn(async (_constraints: MediaStreamConstraints) => stream),
      selectAudioOutput: vi.fn(async () => ({ deviceId: 'chosen-output' })),
    }),
    source = new AudioNodeFake(),
    node = Object.assign(new AudioNodeFake(), {
      port: new PortFake(),
      onprocessorerror: null as (() => void) | null,
    }),
    gate = Object.assign(new AudioNodeFake(), {
      gain: {
        value: 0.75,
        cancelScheduledValues: vi.fn(),
        setValueAtTime: vi.fn((value: number, _time: number) => {
          gate.gain.value = value;
        }),
      },
    }),
    destination = Object.assign(new AudioNodeFake(), { maxChannelCount: 4 });
  let automaticReady = true;
  const ready = (inputChannels = 2, outputChannels = 4) =>
    node.port.receive({
      type: 'ready',
      inputChannels,
      outputChannels,
      quantumFrames: 128,
    });
  const context = Object.assign(new EventTarget(), {
    state: 'suspended' as AudioContextState,
    sampleRate: 48000,
    currentTime: 7.5,
    baseLatency: 0.01,
    outputLatency: 0.02,
    sinkId: '',
    destination,
    audioWorklet: { addModule: vi.fn(async (_url: string) => {}) },
    setSinkId: vi.fn(async (id: string) => {
      context.sinkId = id;
    }),
    createMediaStreamSource: vi.fn((_stream: MediaStream) => source),
    createGain: vi.fn(() => gate),
    resume: vi.fn(async () => {
      context.state = 'running';
      if (automaticReady) ready();
    }),
    close: vi.fn(async () => {
      context.state = 'closed';
    }),
  });
  const environment = {
    mediaDevices: vi.fn(() => media),
    createContext: vi.fn((_options: AudioContextOptions) => context),
    createWorklet: vi.fn((_context: AudioContext, _options: AudioWorkletNodeOptions) => node),
    workletUrl: '/test-capture-worklet.js',
  };
  const backend = createBrowserCaptureBackend(environment as unknown as BrowserCaptureEnvironment),
    sessions: CaptureSession[] = [];
  const value = {
    backend,
    environment,
    media,
    stream,
    track,
    source,
    node,
    gate,
    context,
    destination,
    ready,
    sessions,
    manualReady() {
      automaticReady = false;
    },
    async enable(patch: Partial<CaptureConfig> = {}) {
      const session = await backend.enable({ ...config, ...patch }, new AbortController().signal);
      sessions.push(session);
      sessionsForCleanup.push(session);
      return session;
    },
  };
  return value;
}
afterEach(async () => {
  for (const session of sessionsForCleanup.splice(0)) await session.dispose();
  vi.useRealTimers();
});
const output = () => new Float64Array(HFD_RECORD_SAMPLES).fill(0.125);
function started(f: ReturnType<typeof fixture>) {
  return f.node.port.postMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message.type === 'start')
    .at(-1)!;
}
async function microtasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

it('does no media/context I/O at construction and only enumerates devices when listing', async () => {
  const f = fixture();
  expect(f.environment.mediaDevices).not.toHaveBeenCalled();
  expect(f.environment.createContext).not.toHaveBeenCalled();
  expect(f.media.getUserMedia).not.toHaveBeenCalled();
  expect(await f.backend.devices()).toEqual([
    { deviceId: 'input-a', label: 'ADC', kind: 'audioinput', groupId: 'interface' },
    { deviceId: 'output-b', label: 'DAC', kind: 'audiooutput', groupId: 'interface' },
  ]);
  expect(f.media.enumerateDevices).toHaveBeenCalledTimes(1);
  expect(f.media.getUserMedia).not.toHaveBeenCalled();
  expect(f.environment.createContext).not.toHaveBeenCalled();
});

it('bounds stalled device discovery without requesting input or creating an audio path', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.media.enumerateDevices.mockReturnValue(new Promise<never>(() => {}));
  const rejected = expect(f.backend.devices()).rejects.toThrow(
    'Audio device discovery timed out. Bring this browser tab forward and refresh devices',
  );
  await vi.advanceTimersByTimeAsync(10001);
  await rejected;
  expect(f.media.enumerateDevices).toHaveBeenCalledTimes(1);
  expect(f.media.getUserMedia).not.toHaveBeenCalled();
  expect(f.environment.createContext).not.toHaveBeenCalled();
  expect(f.environment.createWorklet).not.toHaveBeenCalled();
});

it('chooses output separately without opening input/audio, and reports unavailable output chooser', async () => {
  const f = fixture();
  expect(await f.backend.chooseOutput!()).toBe('chosen-output');
  expect(f.media.selectAudioOutput).toHaveBeenCalledTimes(1);
  expect(f.media.getUserMedia).not.toHaveBeenCalled();
  expect(f.environment.createContext).not.toHaveBeenCalled();
  Reflect.deleteProperty(f.media, 'selectAudioOutput');
  await expect(f.backend.chooseOutput!()).rejects.toThrow('output chooser');
});

it('opens explicit unprocessed devices silently and reports actual Fs/topology/latency, not the requested rate', async () => {
  const f = fixture(),
    session = await f.enable();
  expect(f.media.getUserMedia).toHaveBeenCalledExactlyOnceWith({
    video: false,
    audio: {
      deviceId: { exact: 'input-a' },
      channelCount: { ideal: 32 },
      sampleRate: { ideal: 96000 },
      echoCancellation: { exact: false },
      noiseSuppression: { exact: false },
      autoGainControl: { exact: false },
    },
  });
  expect(f.environment.createContext).toHaveBeenCalledExactlyOnceWith({
    latencyHint: 'interactive',
    sampleRate: 96000,
  });
  expect(f.context.setSinkId).toHaveBeenCalledExactlyOnceWith('output-b');
  expect(f.context.audioWorklet.addModule).toHaveBeenCalledExactlyOnceWith(
    '/test-capture-worklet.js',
  );
  expect(f.environment.createWorklet.mock.calls[0][1]).toEqual({
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [4],
    channelCountMode: 'max',
    channelInterpretation: 'discrete',
  });
  expect(f.destination.channelCount).toBe(4);
  expect(f.destination.channelInterpretation).toBe('discrete');
  expect(f.gate.gain.value).toBe(0);
  expect(f.node.port.postMessage.mock.calls.some(([message]) => message.type === 'start')).toBe(
    false,
  );
  expect(session.info).toMatchObject({
    sampleRate: 48000,
    inputSampleRate: 44100,
    inputChannels: 2,
    outputChannels: 4,
    quantumFrames: 128,
    inputDeviceId: 'input-a',
    outputDeviceId: 'output-b',
    baseLatency: 0.01,
    outputLatency: 0.02,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  });
  expect(session.info.timeOrigin).toContain('Not an ASIO timing equivalence');
  expect(() => session.preflight!()).not.toThrow();
});

it.each(['input', 'output'] as const)(
  'rejects an explicit %s device silently substituted by the browser',
  async (side) => {
    const f = fixture();
    if (side === 'input') f.track.settings.deviceId = 'unrequested-input';
    else
      f.context.setSinkId.mockImplementation(async () => {
        f.context.sinkId = 'unrequested-output';
      });
    await expect(f.enable()).rejects.toThrow(/selected|requested|device|route/i);
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.gate.gain.setValueAtTime.mock.calls.every(([value]) => value === 0)).toBe(true);
    expect(f.node.port.postMessage.mock.calls.some(([message]) => message.type === 'start')).toBe(
      false,
    );
  },
);

it.each(['routing-unavailable', 'routing-rejected', 'voice-processing'] as const)(
  'fails %s without output fallback and releases acquired resources',
  async (reason) => {
    const f = fixture();
    if (reason === 'routing-unavailable') Reflect.deleteProperty(f.context, 'setSinkId');
    if (reason === 'routing-rejected')
      f.context.setSinkId.mockRejectedValue(new Error('Sink permission denied'));
    if (reason === 'voice-processing') f.track.settings.echoCancellation = true;
    await expect(f.enable()).rejects.toThrow();
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    if (reason !== 'voice-processing') expect(f.context.close).toHaveBeenCalledTimes(1);
    else expect(f.environment.createContext).not.toHaveBeenCalled();
    expect(f.node.port.postMessage.mock.calls.some(([message]) => message.type === 'start')).toBe(
      false,
    );
  },
);

it('does not enable until the worklet proves the selected input/output channels, then rechecks topology', async () => {
  const f = fixture();
  f.manualReady();
  let enabled = false;
  const enabling = f.enable().then((session) => {
    enabled = true;
    return session;
  });
  await microtasks();
  f.ready(1, 4);
  await microtasks();
  expect(enabled).toBe(false);
  expect(f.gate.gain.value).toBe(0);
  f.ready(2, 4);
  const session = await enabling;
  expect(enabled).toBe(true);
  f.ready(1, 4);
  expect(() => session.preflight!()).toThrow('channel');
  await expect(session.capture(output(), new AbortController().signal, vi.fn())).rejects.toThrow(
    'channel',
  );
  expect(f.gate.gain.value).toBe(0);
});

it('uses only the active take ID and explicit channel tags, returns finite retained samples, then closes the gate', async () => {
  const f = fixture(),
    session = await f.enable(),
    progress = vi.fn(),
    input = output(),
    before = input.slice();
  let complete = false;
  const recording = session.capture(input, new AbortController().signal, progress).then((value) => {
    complete = true;
    return value;
  });
  const start = started(f),
    id = start.id as string;
  expect(id).toBeTypeOf('string');
  expect(start.inputChannel).toBe(1);
  expect(start.outputChannel).toBe(2);
  expect(start.output).toBeInstanceOf(Float32Array);
  expect(start.output).toHaveLength(HFD_RECORD_SAMPLES);
  expect(
    f.node.port.postMessage.mock.calls.find(([message]) => message.type === 'start')![1],
  ).toEqual([(start.output as Float32Array).buffer]);
  expect(f.gate.gain.value).toBe(1);
  f.node.port.receive({ type: 'progress', id: 'old-take', recordedFrames: 100 });
  f.node.port.receive({
    type: 'complete',
    id: 'old-take',
    recording: new Float32Array(HFD_RECORD_SAMPLES),
  });
  await microtasks();
  expect(complete).toBe(false);
  expect(progress).not.toHaveBeenCalled();
  for (const recordedFrames of [-1, 1.5, HFD_RECORD_SAMPLES + 1, Infinity])
    f.node.port.receive({ type: 'progress', id, recordedFrames });
  f.node.port.receive({ type: 'progress', id, recordedFrames: 128 });
  expect(progress).toHaveBeenCalledExactlyOnceWith(128);
  const samples = new Float32Array(HFD_RECORD_SAMPLES);
  samples[0] = 0.5;
  samples[HFD_RECORD_SAMPLES - 1] = -0.125;
  f.node.port.receive({
    type: 'complete',
    id,
    recording: samples,
    quantumFrames: 128,
    discardedInputFrames: 128,
    firstOutputFrame: 4096,
    firstInputFrame: 4224,
    inputPeak: 0.5,
    clippedInputSamples: 0,
    outputPeak: 0.125,
    clippedOutputSamples: 0,
  });
  const result = await recording;
  expect(result).toBeInstanceOf(Float64Array);
  expect(result).toHaveLength(HFD_RECORD_SAMPLES);
  expect(result[0]).toBe(0.5);
  expect(result[HFD_RECORD_SAMPLES - 1]).toBe(-0.125);
  expect(result.subarray(1, -1).every((value) => value === 0)).toBe(true);
  expect(result.buffer).not.toBe(samples.buffer);
  expect(input).toEqual(before);
  expect(progress).toHaveBeenLastCalledWith(HFD_RECORD_SAMPLES);
  expect(session.info).toMatchObject({
    discardedInputFrames: 128,
    firstOutputFrame: 4096,
    firstInputFrame: 4224,
    inputPeak: 0.5,
  });
  expect(f.gate.gain.value).toBe(0);
});

it.each(['short', 'double', 'nan', 'infinity'] as const)(
  'rejects a %s processor recording and silences output',
  async (kind) => {
    const f = fixture(),
      session = await f.enable(),
      promise = session.capture(output(), new AbortController().signal, vi.fn());
    const recording =
      kind === 'short'
        ? new Float32Array(1)
        : kind === 'double'
          ? new Float64Array(HFD_RECORD_SAMPLES)
          : new Float32Array(HFD_RECORD_SAMPLES);
    if (kind === 'nan') recording[99] = NaN;
    if (kind === 'infinity') recording[99] = Infinity;
    const rejected = expect(promise).rejects.toThrow('invalid recording');
    f.node.port.receive({ type: 'complete', id: started(f).id, recording });
    await rejected;
    expect(f.gate.gain.value).toBe(0);
  },
);

it('rejects wrong/nonfinite/Float32-overflow sweeps before opening the gate or starting the processor', async () => {
  const f = fixture(),
    session = await f.enable();
  for (const samples of [
    new Float64Array(1),
    new Float64Array(HFD_RECORD_SAMPLES).fill(NaN),
    new Float64Array(HFD_RECORD_SAMPLES).fill(1e50),
  ])
    await expect(session.capture(samples, new AbortController().signal, vi.fn())).rejects.toThrow(
      /sweep|range/,
    );
  expect(f.gate.gain.value).toBe(0);
  expect(f.node.port.postMessage.mock.calls.some(([message]) => message.type === 'start')).toBe(
    false,
  );
});

it.each(['stop', 'abort'] as const)(
  'immediately silences and rejects an active take on %s; late completion is ignored',
  async (action) => {
    const f = fixture(),
      session = await f.enable(),
      signal = new AbortController(),
      progress = vi.fn(),
      promise = session.capture(output(), signal.signal, progress),
      id = started(f).id;
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    if (action === 'stop') session.stop();
    else signal.abort();
    expect(f.gate.gain.value).toBe(0);
    await rejected;
    f.node.port.receive({ type: 'complete', id, recording: new Float32Array(HFD_RECORD_SAMPLES) });
    expect(progress).not.toHaveBeenCalled();
    expect(f.node.port.postMessage.mock.calls.at(-1)![0]).toEqual({ type: 'cancel' });
  },
);

it.each(['timeout', 'abort'] as const)(
  'stops a late getUserMedia grant after enable %s without opening an AudioContext',
  async (action) => {
    vi.useFakeTimers();
    const f = fixture(),
      opening = deferred<MediaStream>(),
      controller = new AbortController();
    f.media.getUserMedia.mockReturnValue(opening.promise);
    const promise = f.backend.enable(config, controller.signal),
      rejected = expect(promise).rejects.toThrow();
    if (action === 'abort') controller.abort();
    else await vi.advanceTimersByTimeAsync(30001);
    await rejected;
    opening.resolve(f.stream);
    await microtasks();
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.environment.createContext).not.toHaveBeenCalled();
  },
);

it('times out missing worklet topology without leaving an open track/context or output gate', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.manualReady();
  const rejected = expect(f.enable()).rejects.toThrow('input channel');
  await vi.advanceTimersByTimeAsync(10001);
  await rejected;
  expect(f.track.stop).toHaveBeenCalledTimes(1);
  expect(f.context.close).toHaveBeenCalledTimes(1);
  expect(f.node.port.close).toHaveBeenCalledTimes(1);
  expect(f.gate.gain.value).toBe(0);
});

it('times out an unresponsive take and returns the output gate to zero', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    session = await f.enable(),
    rejected = expect(
      session.capture(output(), new AbortController().signal, vi.fn()),
    ).rejects.toThrow('stopped responding');
  await vi.advanceTimersByTimeAsync(Math.ceil((HFD_RECORD_SAMPLES / 48000) * 1000) + 10001);
  await rejected;
  expect(f.gate.gain.value).toBe(0);
});

it.each(['ended', 'mute', 'devicechange', 'sinkchange'] as const)(
  'invalidates active and future takes on %s',
  async (event) => {
    const f = fixture(),
      session = await f.enable(),
      rejected = expect(
        session.capture(output(), new AbortController().signal, vi.fn()),
      ).rejects.toThrow(/ended|stopped|changed/);
    const target =
      event === 'devicechange' ? f.media : event === 'sinkchange' ? f.context : f.track;
    target.dispatchEvent(new Event(event));
    await rejected;
    expect(f.gate.gain.value).toBe(0);
    expect(() => session.preflight!()).toThrow(/ended|stopped|changed/);
  },
);

it('disposes every owned resource once, removes event listeners and ignores late processor messages', async () => {
  const f = fixture(),
    session = await f.enable();
  await session.dispose();
  await session.dispose();
  expect(f.track.stop).toHaveBeenCalledTimes(1);
  expect(f.source.disconnect).toHaveBeenCalledTimes(1);
  expect(f.node.disconnect).toHaveBeenCalledTimes(1);
  expect(f.gate.disconnect).toHaveBeenCalledTimes(1);
  expect(f.node.port.close).toHaveBeenCalledTimes(1);
  expect(f.context.close).toHaveBeenCalledTimes(1);
  expect(f.gate.gain.value).toBe(0);
  const count = f.node.port.postMessage.mock.calls.length;
  f.track.dispatchEvent(new Event('ended'));
  f.media.dispatchEvent(new Event('devicechange'));
  f.context.dispatchEvent(new Event('sinkchange'));
  f.node.port.receive({ type: 'ready', inputChannels: -1, outputChannels: 0, quantumFrames: 0 });
  expect(f.node.port.postMessage).toHaveBeenCalledTimes(count);
  expect(() => session.preflight!()).toThrow('disabled');
});

it('rejects invalid channel indices and an already-cancelled enable before any media access', async () => {
  const f = fixture();
  for (const index of [-1, 1.5, 32, NaN])
    for (const field of ['inputChannel', 'outputChannel'] as const)
      await expect(f.enable({ [field]: index })).rejects.toThrow('audio channel');
  const controller = new AbortController();
  controller.abort();
  await expect(f.backend.enable(config, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(f.environment.mediaDevices).not.toHaveBeenCalled();
  expect(f.environment.createContext).not.toHaveBeenCalled();
});

it.each(['input', 'output'] as const)(
  'rechecks the explicit %s identity immediately before a take',
  async (side) => {
    const f = fixture(),
      session = await f.enable();
    if (side === 'input') f.track.settings.deviceId = 'changed-input';
    else f.context.sinkId = 'changed-output';
    expect(() => session.preflight!()).toThrow('changed');
    await expect(session.capture(output(), new AbortController().signal, vi.fn())).rejects.toThrow(
      'changed',
    );
    expect(f.gate.gain.value).toBe(0);
    expect(f.node.port.postMessage.mock.calls.some(([message]) => message.type === 'start')).toBe(
      false,
    );
  },
);

it('cleans up a processor failure while browser activation is pending without an unhandled ready rejection', async () => {
  const f = fixture(),
    activation = deferred<void>();
  f.context.resume.mockImplementation(() => activation.promise);
  const rejected = expect(f.enable()).rejects.toThrow('processor failed');
  await microtasks();
  expect(f.node.onprocessorerror).toBeTypeOf('function');
  f.node.onprocessorerror!();
  await microtasks();
  expect(f.gate.gain.value).toBe(0);
  f.context.state = 'running';
  activation.resolve();
  await rejected;
  expect(f.track.stop).toHaveBeenCalledTimes(1);
  expect(f.context.close).toHaveBeenCalledTimes(1);
  expect(f.node.port.close).toHaveBeenCalledTimes(1);
});

it('rejects a competing take without changing the original take or its output gate', async () => {
  const f = fixture(),
    session = await f.enable(),
    first = session.capture(output(), new AbortController().signal, vi.fn()),
    id = started(f).id;
  await expect(session.capture(output(), new AbortController().signal, vi.fn())).rejects.toThrow(
    'already running',
  );
  expect(f.gate.gain.value).toBe(1);
  expect(started(f).id).toBe(id);
  f.node.port.receive({ type: 'complete', id, recording: new Float32Array(HFD_RECORD_SAMPLES) });
  expect(await first).toHaveLength(HFD_RECORD_SAMPLES);
  expect(f.gate.gain.value).toBe(0);
});

it.each(['track', 'device', 'context'] as const)(
  'notifies unavailable subscribers for a %s event, supports late listeners and unsubscribes cleanly',
  async (kind) => {
    const f = fixture(),
      session = await f.enable(),
      listener = vi.fn();
    const unsubscribe = session.onUnavailable!(listener);
    const change = () => {
      if (kind === 'track') f.track.dispatchEvent(new Event('ended'));
      else if (kind === 'device') f.media.dispatchEvent(new Event('devicechange'));
      else {
        f.context.state = 'suspended';
        f.context.dispatchEvent(new Event('statechange'));
      }
    };
    change();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatch(/input stopped|devices changed|context stopped/);
    expect(f.gate.gain.value).toBe(0);
    const reason = listener.mock.calls[0][0];
    unsubscribe();
    change();
    expect(listener).toHaveBeenCalledTimes(1);
    const late = vi.fn(),
      removeLate = session.onUnavailable!(late);
    expect(late).not.toHaveBeenCalled();
    await microtasks();
    expect(late).toHaveBeenCalledExactlyOnceWith(reason);
    removeLate();
    const removedBeforeDelivery = vi.fn(),
      remove = session.onUnavailable!(removedBeforeDelivery);
    remove();
    await microtasks();
    expect(removedBeforeDelivery).not.toHaveBeenCalled();
  },
);

it('does not report ordinary dispose as unavailable and drops a queued callback when disposed', async () => {
  const f = fixture(),
    session = await f.enable(),
    listener = vi.fn();
  session.onUnavailable!(listener);
  await session.dispose();
  expect(listener).not.toHaveBeenCalled();
  f.media.dispatchEvent(new Event('devicechange'));
  expect(listener).not.toHaveBeenCalled();

  const other = fixture(),
    unavailable = await other.enable(),
    queued = vi.fn();
  other.media.dispatchEvent(new Event('devicechange'));
  unavailable.onUnavailable!(queued);
  await unavailable.dispose();
  await microtasks();
  expect(queued).not.toHaveBeenCalled();
});

it('rejects an initially muted input, stops its track and opens no audio signal path', async () => {
  const f = fixture();
  f.track.muted = true;
  await expect(f.enable()).rejects.toThrow(/muted|unavailable/);
  expect(f.track.stop).toHaveBeenCalledTimes(1);
  expect(f.environment.createContext).not.toHaveBeenCalled();
  expect(f.environment.createWorklet).not.toHaveBeenCalled();
  expect(f.node.port.postMessage.mock.calls.some(([message]) => message.type === 'start')).toBe(
    false,
  );
});

it.each(['stop', 'abort'] as const)(
  'blocks a new take until the %s take finally settles, then ignores old completion IDs',
  async (action) => {
    const f = fixture(),
      session = await f.enable(),
      signal = new AbortController(),
      first = session.capture(output(), signal.signal, vi.fn()),
      oldId = started(f).id;
    const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    if (action === 'stop') session.stop();
    else signal.abort();
    const premature = session.capture(output(), new AbortController().signal, vi.fn());
    expect(f.gate.gain.value).toBe(0);
    await expect(premature).rejects.toThrow('already running');
    await cancelled;
    const next = session.capture(output(), new AbortController().signal, vi.fn()),
      newId = started(f).id;
    expect(newId).not.toBe(oldId);
    expect(f.gate.gain.value).toBe(1);
    f.node.port.receive({
      type: 'complete',
      id: oldId,
      recording: new Float32Array(HFD_RECORD_SAMPLES),
    });
    await microtasks();
    expect(f.gate.gain.value).toBe(1);
    const samples = new Float32Array(HFD_RECORD_SAMPLES);
    samples[7] = 0.5;
    f.node.port.receive({ type: 'complete', id: newId, recording: samples });
    expect((await next)[7]).toBe(0.5);
    expect(f.gate.gain.value).toBe(0);
  },
);
