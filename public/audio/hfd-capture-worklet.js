/* Deliberately independent of the main thread and DOM. Never monitors input. */
class HfdCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = null;
    this.topology = '';
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'cancel') {
        const id = this.active?.id;
        this.active = null;
        if (id) this.port.postMessage({ type: 'cancelled', id });
        return;
      }
      if (data?.type !== 'start') return;
      if (this.active) {
        this.port.postMessage({ type: 'error', id: data.id, error: 'Capture is already active' });
        return;
      }
      if (
        typeof data.id !== 'string' || !data.id ||
        !(data.output instanceof Float32Array) || data.output.length !== 131072 ||
        !Number.isInteger(data.inputChannel) || data.inputChannel < 0 || data.inputChannel > 31 ||
        !Number.isInteger(data.outputChannel) || data.outputChannel < 0 || data.outputChannel > 31 ||
        !data.output.every(Number.isFinite)
      ) {
        this.port.postMessage({ type: 'error', id: data.id, error: 'Invalid capture request' });
        return;
      }
      this.active = {
        id: data.id, output: data.output, inputChannel: data.inputChannel,
        outputChannel: data.outputChannel, recording: new Float32Array(131072),
        read: 0, written: 0, first: true, discardedInputFrames: 0,
        firstOutputFrame: -1, firstInputFrame: -1, quantumFrames: 0,
        inputPeak: 0, clippedInputSamples: 0, outputPeak: 0, clippedOutputSamples: 0,
        lastProgress: 0,
      };
    };
  }

  fail(error) {
    const id = this.active?.id;
    this.active = null;
    this.port.postMessage({ type: 'error', id, error });
  }

  process(inputs, outputs) {
    const input = inputs[0] ?? [], output = outputs[0] ?? [];
    for (const channel of output) channel.fill(0);
    const frames = output[0]?.length ?? input[0]?.length ?? 0;
    const topology = `${input.length}/${output.length}/${frames}`;
    if (this.topology !== topology) {
      this.topology = topology;
      this.port.postMessage({
        type: 'ready', inputChannels: input.length, outputChannels: output.length,
        quantumFrames: frames, frame: currentFrame,
      });
    }
    const capture = this.active;
    if (!capture) return true;
    const selectedInput = input[capture.inputChannel], selectedOutput = output[capture.outputChannel];
    if (!frames || !selectedInput || !selectedOutput || selectedInput.length !== frames ||
        selectedOutput.length !== frames) {
      this.fail('The selected audio channel is unavailable');
      return true;
    }
    if (capture.first) {
      // This is a Web Audio render quantum, not an ASIO hardware block.
      capture.first = false;
      capture.quantumFrames = frames;
      capture.discardedInputFrames = frames;
      capture.firstOutputFrame = currentFrame;
      this.port.postMessage({
        type: 'started', id: capture.id, firstOutputFrame: currentFrame,
        quantumFrames: frames, discardedInputFrames: frames,
      });
    } else {
      if (!capture.written) capture.firstInputFrame = currentFrame;
      const count = Math.min(frames, capture.recording.length - capture.written);
      for (let i = 0; i < count; i++) {
        const value = selectedInput[i];
        if (!Number.isFinite(value)) {
          this.fail('Audio input contains a non-finite sample');
          return true;
        }
        capture.recording[capture.written + i] = value;
        capture.inputPeak = Math.max(capture.inputPeak, Math.abs(value));
        if (Math.abs(value) >= 1) capture.clippedInputSamples++;
      }
      capture.written += count;
    }
    const count = Math.min(frames, capture.output.length - capture.read);
    for (let i = 0; i < count; i++) {
      const value = capture.output[capture.read + i];
      selectedOutput[i] = value;
      capture.outputPeak = Math.max(capture.outputPeak, Math.abs(value));
      if (Math.abs(value) > 1) capture.clippedOutputSamples++;
    }
    capture.read += count;
    if (capture.written - capture.lastProgress >= 8192) {
      capture.lastProgress = capture.written;
      this.port.postMessage({ type: 'progress', id: capture.id, recordedFrames: capture.written });
    }
    if (capture.written === capture.recording.length) {
      this.active = null;
      this.port.postMessage({
        type: 'complete', id: capture.id, recording: capture.recording,
        firstOutputFrame: capture.firstOutputFrame, firstInputFrame: capture.firstInputFrame,
        quantumFrames: capture.quantumFrames, discardedInputFrames: capture.discardedInputFrames,
        inputPeak: capture.inputPeak, clippedInputSamples: capture.clippedInputSamples,
        outputPeak: capture.outputPeak, clippedOutputSamples: capture.clippedOutputSamples,
      }, [capture.recording.buffer]);
    }
    return true;
  }
}

registerProcessor('hfd-capture', HfdCaptureProcessor);
