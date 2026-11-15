import type {
  CaptureBackend,
  CaptureConfig,
  CaptureDevice,
  CaptureRuntimeInfo,
  CaptureSession,
} from '../application/measurement-capture';
import { HFD_RECORD_SAMPLES } from '../domain/hfd-audio';

type OutputDevices = MediaDevices & {
  selectAudioOutput?: () => Promise<MediaDeviceInfo>;
};
type RoutedContext = AudioContext & {
  setSinkId?: (id: string) => Promise<void>;
  sinkId?: string | { type: string };
  outputLatency?: number;
};
export interface BrowserCaptureEnvironment {
  mediaDevices(): OutputDevices;
  createContext(options: AudioContextOptions): RoutedContext;
  createWorklet(context: AudioContext, options: AudioWorkletNodeOptions): AudioWorkletNode;
  workletUrl: string;
}
const defaultEnvironment: BrowserCaptureEnvironment = {
  mediaDevices: () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices)
      throw new Error('Audio capture requires a secure browser with media-device support');
    return navigator.mediaDevices as OutputDevices;
  },
  createContext: (options) => new AudioContext(options),
  createWorklet: (context, options) => new AudioWorkletNode(context, 'hfd-capture', options),
  workletUrl: '/audio/hfd-capture-worklet.js',
};
const aborted = () => new DOMException('Audio capture cancelled', 'AbortError');
function bounded<T>(promise: Promise<T>, signal: AbortSignal, ms: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const cancel = () => finish(aborted());
    const timer = setTimeout(() => finish(new Error(message)), ms);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    promise.then(
      (value) => finish(undefined, value),
      (error) => finish(error),
    );
  });
}
const stopTracks = (stream?: MediaStream) => stream?.getTracks().forEach((track) => track.stop());

/** No microphone, AudioContext or output is opened by constructing this backend. */
export function createBrowserCaptureBackend(
  environment: BrowserCaptureEnvironment = defaultEnvironment,
): CaptureBackend {
  return {
    async devices() {
      const devices = await bounded(
        environment.mediaDevices().enumerateDevices(),
        new AbortController().signal,
        10000,
        'Audio device discovery timed out. Bring this browser tab forward and refresh devices',
      );
      return devices
        .filter((device) => device.kind === 'audioinput' || device.kind === 'audiooutput')
        .map((device) => ({
          deviceId: device.deviceId,
          label: device.label,
          kind: device.kind,
          ...(device.groupId ? { groupId: device.groupId } : {}),
        })) as CaptureDevice[];
    },
    async chooseOutput() {
      const devices = environment.mediaDevices();
      if (!devices.selectAudioOutput)
        throw new Error('This browser has no output chooser; select an available output device');
      return (await devices.selectAudioOutput()).deviceId;
    },
    async enable(config: Readonly<CaptureConfig>, signal: AbortSignal): Promise<CaptureSession> {
      signal.throwIfAborted();
      if (
        [config.inputChannel, config.outputChannel].some(
          (n) => !Number.isInteger(n) || n < 0 || n > 31,
        )
      )
        throw new Error('Choose an audio channel from 1 to 32');
      const devices = environment.mediaDevices();
      if (!devices.getUserMedia) throw new Error('This browser cannot open an audio input');
      const supported = devices.getSupportedConstraints();
      let stream: MediaStream | undefined, context: RoutedContext | undefined;
      let source: MediaStreamAudioSourceNode | undefined, node: AudioWorkletNode | undefined;
      let gate: GainNode | undefined,
        disposed = false,
        abandoned = false,
        unavailable = '',
        captureFlight = false;
      let active:
        | {
            id: string;
            resolve: (recording: Float64Array) => void;
            reject: (error: unknown) => void;
            progress: (frames: number) => void;
          }
        | undefined;
      let topology = { inputChannels: 0, outputChannels: 0, quantumFrames: 0 };
      let readyResolve: (() => void) | undefined,
        readyReject: ((error: unknown) => void) | undefined;
      let runtime: CaptureRuntimeInfo | undefined;
      const invalidationListeners = new Set<(reason: string) => void>();
      const cleanups: (() => void)[] = [];
      const silence = () => {
        if (gate && context) {
          gate.gain.cancelScheduledValues(context.currentTime);
          gate.gain.setValueAtTime(0, context.currentTime);
        }
        node?.port.postMessage({ type: 'cancel' });
      };
      const fail = (error: unknown) => {
        silence();
        const pending = active;
        active = undefined;
        pending?.reject(error);
        readyReject?.(error);
      };
      const invalidate = (reason: string) => {
        unavailable = reason;
        fail(new Error(reason));
        for (const listener of invalidationListeners) listener(reason);
      };
      const dispose = async () => {
        if (disposed) return;
        disposed = true;
        abandoned = true;
        fail(aborted());
        for (const cleanup of cleanups.splice(0)) cleanup();
        invalidationListeners.clear();
        stopTracks(stream);
        source?.disconnect();
        node?.disconnect();
        node?.port.close();
        gate?.disconnect();
        if (context && context.state !== 'closed') await context.close().catch(() => {});
      };
      try {
        const audio: MediaTrackConstraints = {
          ...(config.inputDeviceId ? { deviceId: { exact: config.inputDeviceId } } : {}),
          channelCount: { ideal: 32 },
          ...(config.requestedSampleRate
            ? { sampleRate: { ideal: config.requestedSampleRate } }
            : {}),
          ...(supported.echoCancellation ? { echoCancellation: { exact: false } } : {}),
          ...(supported.noiseSuppression ? { noiseSuppression: { exact: false } } : {}),
          ...(supported.autoGainControl ? { autoGainControl: { exact: false } } : {}),
        };
        // getUserMedia has no AbortSignal. A late permission grant is stopped too.
        const opening = devices.getUserMedia({ video: false, audio }).then((value) => {
          if (abandoned || signal.aborted) {
            stopTracks(value);
            throw aborted();
          }
          return value;
        });
        stream = await bounded(opening, signal, 30000, 'Audio input permission timed out');
        const tracks = stream.getAudioTracks();
        if (tracks.length !== 1)
          throw new Error('Select an audio input with exactly one audio track');
        const track = tracks[0],
          settings = track.getSettings();
        if (track.readyState !== 'live' || track.muted)
          throw new Error('The selected audio input is muted or unavailable');
        const ended = () =>
          invalidate('The selected audio input stopped; disable and enable recording again');
        track.addEventListener('ended', ended);
        track.addEventListener('mute', ended);
        cleanups.push(() => {
          track.removeEventListener('ended', ended);
          track.removeEventListener('mute', ended);
        });
        const concreteInput =
          config.inputDeviceId && !['default', 'communications'].includes(config.inputDeviceId);
        if (concreteInput && settings.deviceId !== config.inputDeviceId)
          throw new Error('The browser did not open the selected input device');
        if (settings.channelCount !== undefined && settings.channelCount > 32)
          throw new Error('This browser audio path supports at most 32 input channels');
        if (settings.echoCancellation || settings.noiseSuppression || settings.autoGainControl)
          throw new Error('The input still has voice processing enabled; use an unprocessed input');
        context = environment.createContext({
          latencyHint: 'interactive',
          ...(config.requestedSampleRate ? { sampleRate: config.requestedSampleRate } : {}),
        });
        if (!context.audioWorklet)
          throw new Error('This browser does not support AudioWorklet capture');
        if (config.outputDeviceId) {
          if (!context.setSinkId)
            throw new Error('This browser cannot route Web Audio to the selected output device');
          await bounded(
            context.setSinkId(config.outputDeviceId),
            signal,
            10000,
            'Audio output selection timed out',
          );
          if (context.sinkId !== config.outputDeviceId)
            throw new Error('The browser did not route audio to the selected output device');
        }
        const outputChannels = Math.min(32, context.destination.maxChannelCount);
        if (!Number.isInteger(outputChannels) || outputChannels <= config.outputChannel)
          throw new Error('The selected output channel is not available on this device');
        context.destination.channelCount = outputChannels;
        context.destination.channelCountMode = 'explicit';
        context.destination.channelInterpretation = 'discrete';
        await bounded(
          context.audioWorklet.addModule(environment.workletUrl),
          signal,
          10000,
          'The audio capture processor did not load',
        );
        source = context.createMediaStreamSource(stream);
        node = environment.createWorklet(context, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [outputChannels],
          channelCountMode: 'max',
          channelInterpretation: 'discrete',
        });
        gate = context.createGain();
        gate.channelCount = outputChannels;
        gate.channelCountMode = 'explicit';
        gate.channelInterpretation = 'discrete';
        gate.gain.value = 0;
        const ready = new Promise<void>((resolve, reject) => {
          readyResolve = resolve;
          readyReject = reject;
        });
        // It can fail while resume() is still waiting for browser activation.
        void ready.catch(() => {});
        node.port.onmessage = ({ data }) => {
          if (disposed) return;
          if (data?.type === 'ready') {
            const next = {
              inputChannels: data.inputChannels,
              outputChannels: data.outputChannels,
              quantumFrames: data.quantumFrames,
            };
            if (!Object.values(next).every((n) => Number.isInteger(n) && n >= 0)) {
              invalidate('The audio processor reported an invalid channel layout');
              return;
            }
            topology = next;
            if (
              next.inputChannels > config.inputChannel &&
              next.outputChannels > config.outputChannel &&
              next.quantumFrames > 0
            )
              readyResolve?.();
            else if (runtime) invalidate('The selected audio channel became unavailable');
            return;
          }
          const pending = active;
          if (!pending || data?.id !== pending.id) return;
          if (data.type === 'error') fail(new Error(String(data.error).slice(0, 2048)));
          else if (data.type === 'cancelled') fail(aborted());
          else if (data.type === 'progress') {
            if (
              Number.isInteger(data.recordedFrames) &&
              data.recordedFrames >= 0 &&
              data.recordedFrames <= HFD_RECORD_SAMPLES
            )
              pending.progress(data.recordedFrames);
          } else if (data.type === 'complete') {
            if (
              !(data.recording instanceof Float32Array) ||
              data.recording.length !== HFD_RECORD_SAMPLES ||
              !data.recording.every(Number.isFinite)
            ) {
              fail(new Error('The audio processor returned an invalid recording'));
              return;
            }
            if (runtime)
              for (const key of [
                'quantumFrames',
                'discardedInputFrames',
                'firstOutputFrame',
                'firstInputFrame',
                'inputPeak',
                'clippedInputSamples',
                'outputPeak',
                'clippedOutputSamples',
              ] as const)
                if (typeof data[key] === 'number' && Number.isFinite(data[key]))
                  runtime[key] = data[key];
            silence();
            active = undefined;
            pending.progress(HFD_RECORD_SAMPLES);
            pending.resolve(Float64Array.from(data.recording));
          }
        };
        node.onprocessorerror = () => invalidate('The audio capture processor failed');
        source.connect(node);
        node.connect(gate).connect(context.destination);
        await bounded(
          context.resume(),
          signal,
          10000,
          'Audio is suspended. Enable recording with a click in this browser',
        );
        await bounded(
          ready,
          signal,
          10000,
          'The selected input channel did not become available; check input routing',
        );
        readyResolve = undefined;
        readyReject = undefined;
        signal.throwIfAborted();
        if (unavailable || track.muted || track.readyState !== 'live')
          throw new Error(unavailable || 'The selected audio input is muted or unavailable');
        runtime = {
          sampleRate: context.sampleRate,
          inputChannels: topology.inputChannels,
          outputChannels: topology.outputChannels,
          quantumFrames: topology.quantumFrames,
          ...(settings.sampleRate ? { inputSampleRate: settings.sampleRate } : {}),
          baseLatency: context.baseLatency,
          ...(Number.isFinite(context.outputLatency)
            ? { outputLatency: context.outputLatency }
            : {}),
          inputDeviceId: settings.deviceId ?? config.inputDeviceId,
          outputDeviceId:
            typeof context.sinkId === 'string' ? context.sinkId : config.outputDeviceId,
          ...(typeof settings.echoCancellation === 'boolean'
            ? { echoCancellation: settings.echoCancellation }
            : {}),
          ...(typeof settings.noiseSuppression === 'boolean'
            ? { noiseSuppression: settings.noiseSuppression }
            : {}),
          ...(typeof settings.autoGainControl === 'boolean'
            ? { autoGainControl: settings.autoGainControl }
            : {}),
          timeOrigin:
            'First Web Audio input quantum discarded; no hardware-latency subtraction or peak alignment. Not an ASIO timing equivalence.',
        };
        const changed = () =>
          invalidate('Audio devices changed; disable and enable recording before another take');
        const suspended = () => {
          if (context?.state !== 'running')
            invalidate('The audio context stopped; disable and enable recording again');
        };
        devices.addEventListener('devicechange', changed);
        context.addEventListener('sinkchange', changed);
        context.addEventListener('statechange', suspended);
        cleanups.push(() => {
          devices.removeEventListener('devicechange', changed);
          context?.removeEventListener('sinkchange', changed);
          context?.removeEventListener('statechange', suspended);
        });
        const preflight = () => {
          if (disposed) throw new Error('Audio recording is disabled');
          if (unavailable) throw new Error(unavailable);
          if (track.readyState !== 'live') throw new Error('The audio input has ended');
          if (track.muted) throw new Error('The selected audio input is muted');
          if (concreteInput && track.getSettings().deviceId !== config.inputDeviceId)
            throw new Error('The selected audio input changed');
          if (config.outputDeviceId && context!.sinkId !== config.outputDeviceId)
            throw new Error('The selected audio output changed');
          if (context!.state !== 'running')
            throw new Error('Audio is suspended; disable and enable recording in the browser');
          if (
            topology.inputChannels <= config.inputChannel ||
            topology.outputChannels <= config.outputChannel
          )
            throw new Error('The selected audio channel is unavailable');
        };
        return {
          info: runtime,
          preflight,
          onUnavailable: (listener) => {
            invalidationListeners.add(listener);
            if (unavailable)
              queueMicrotask(() => {
                if (invalidationListeners.has(listener)) listener(unavailable);
              });
            return () => {
              invalidationListeners.delete(listener);
            };
          },
          async capture(output, captureSignal, onProgress) {
            preflight();
            captureSignal.throwIfAborted();
            if (active || captureFlight) throw new Error('Another audio take is already running');
            if (output.length !== HFD_RECORD_SAMPLES || !output.every(Number.isFinite))
              throw new Error('The sweep must contain 131072 finite samples');
            const samples = Float32Array.from(output);
            if (!samples.every(Number.isFinite))
              throw new Error('Output gain exceeds the audio sample range');
            const id = crypto.randomUUID();
            captureFlight = true;
            const recording = new Promise<Float64Array>((resolve, reject) => {
              active = { id, resolve, reject, progress: onProgress };
            });
            const cancel = () => fail(aborted());
            captureSignal.addEventListener('abort', cancel, { once: true });
            try {
              gate!.gain.setValueAtTime(1, context!.currentTime);
              node!.port.postMessage(
                {
                  type: 'start',
                  id,
                  output: samples,
                  inputChannel: config.inputChannel,
                  outputChannel: config.outputChannel,
                },
                [samples.buffer],
              );
              return await bounded(
                recording,
                captureSignal,
                Math.ceil((HFD_RECORD_SAMPLES / context!.sampleRate) * 1000) + 10000,
                'Audio recording stopped responding',
              );
            } finally {
              captureSignal.removeEventListener('abort', cancel);
              silence();
              active = undefined;
              captureFlight = false;
            }
          },
          stop: () => fail(aborted()),
          dispose,
        };
      } catch (error) {
        abandoned = true;
        await dispose();
        throw error;
      }
    },
  };
}
