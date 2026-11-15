import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

const RECORD_SAMPLES = 131072;
type Wire = Record<string, unknown>;
interface Processor {
  port: { onmessage?: (event: { data: unknown }) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
function createProcessor() {
  const messages: { message: Wire; transfer?: ArrayBuffer[] }[] = [];
  let Constructor!: new () => Processor;
  class WorkletBase {
    port = {
      onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
      postMessage: (message: Wire, transfer?: ArrayBuffer[]) =>
        messages.push({ message, transfer }),
    };
  }
  const scope = {
    AudioWorkletProcessor: WorkletBase,
    Float32Array,
    currentFrame: 0,
    registerProcessor: (name: string, value: new () => Processor) => {
      expect(name).toBe('hfd-capture');
      Constructor = value;
    },
  };
  runInNewContext(readFileSync('public/audio/hfd-capture-worklet.js', 'utf8'), scope, {
    filename: 'hfd-capture-worklet.js',
  });
  const processor = new Constructor();
  const command = (data: unknown) => processor.port.onmessage!({ data });
  const process = (inputs: Float32Array[], outputs: Float32Array[], frame: number) => {
    scope.currentFrame = frame;
    expect(processor.process([inputs], [outputs])).toBe(true);
  };
  return { messages, command, process };
}
const channels = (count: number, frames = 128, value = 0) =>
  Array.from({ length: count }, () => new Float32Array(frames).fill(value));
const stimulus = () => Float32Array.from({ length: RECORD_SAMPLES }, (_, i) => (i % 256) / 512);

it('emits exact zeros on every output while idle and never monitors input', () => {
  const worklet = createProcessor(),
    input = channels(2, 128, 0.75),
    output = channels(4, 128, 5);
  worklet.process(input, output, 0);
  expect(output.every((channel) => channel.every((sample) => sample === 0))).toBe(true);
  expect(input.every((channel) => channel.every((sample) => sample === 0.75))).toBe(true);
  expect(worklet.messages.map((entry) => entry.message.type)).toEqual(['ready']);
  worklet.process(input, output, 128);
  expect(worklet.messages).toHaveLength(1);
});

it.each([128, 256])(
  'routes only the selected output and discards exactly the first actual %i-frame quantum',
  (frames) => {
    const worklet = createProcessor(),
      generated = stimulus();
    worklet.command({
      type: 'start',
      id: 'take-1',
      output: generated,
      inputChannel: 1,
      outputChannel: 2,
    });
    const blocks = RECORD_SAMPLES / frames;
    for (let block = 0; block <= blocks; block++) {
      const input = channels(2, frames, -0.25),
        output = channels(4, frames, 7);
      input[1].fill(block / (2 * blocks));
      worklet.process(input, output, 1024 + block * frames);
      for (const index of [0, 1, 3])
        expect(output[index].every((sample) => sample === 0)).toBe(true);
      expect(output[2]).toEqual(
        block < blocks
          ? generated.slice(block * frames, (block + 1) * frames)
          : new Float32Array(frames),
      );
    }
    const complete = worklet.messages.find((entry) => entry.message.type === 'complete')!;
    const recorded = complete.message.recording as Float32Array;
    expect(recorded).toHaveLength(RECORD_SAMPLES);
    expect(recorded[0]).toBe(1 / (2 * blocks));
    expect(recorded.at(-1)).toBe(0.5);
    expect(complete.message).toMatchObject({
      id: 'take-1',
      firstOutputFrame: 1024,
      firstInputFrame: 1024 + frames,
      quantumFrames: frames,
      discardedInputFrames: frames,
      clippedInputSamples: 0,
      clippedOutputSamples: 0,
    });
    expect(complete.transfer).toEqual([recorded.buffer]);
    const outputAfter = channels(4, frames, 9);
    worklet.process(channels(2, frames, 1), outputAfter, 1024 + (blocks + 1) * frames);
    expect(outputAfter.every((channel) => channel.every((value) => value === 0))).toBe(true);
  },
);

it('cancels an active take, emits silence and starts a fresh take independently', () => {
  const worklet = createProcessor();
  worklet.command({
    type: 'start',
    id: 'old',
    output: stimulus(),
    inputChannel: 0,
    outputChannel: 0,
  });
  worklet.process(channels(1), channels(2), 0);
  worklet.command({ type: 'cancel' });
  expect(worklet.messages.at(-1)?.message).toEqual({ type: 'cancelled', id: 'old' });
  const silent = channels(2, 128, 3);
  worklet.process(channels(1, 128, 0.9), silent, 128);
  expect(silent.every((channel) => channel.every((value) => value === 0))).toBe(true);
  const next = new Float32Array(RECORD_SAMPLES).fill(0.125);
  worklet.command({ type: 'start', id: 'new', output: next, inputChannel: 0, outputChannel: 1 });
  const output = channels(2, 128, 3);
  worklet.process(channels(1), output, 256);
  expect(output[0].every((value) => value === 0)).toBe(true);
  expect(output[1].every((value) => value === 0.125)).toBe(true);
  expect(worklet.messages.at(-1)?.message).toMatchObject({
    type: 'started',
    id: 'new',
    firstOutputFrame: 256,
  });
});

it('rejects another start without replacing an active take or its routing', () => {
  const worklet = createProcessor();
  worklet.command({
    type: 'start',
    id: 'original',
    output: new Float32Array(RECORD_SAMPLES).fill(0.25),
    inputChannel: 0,
    outputChannel: 1,
  });
  worklet.command({
    type: 'start',
    id: 'overlap',
    output: stimulus(),
    inputChannel: 0,
    outputChannel: 0,
  });
  expect(worklet.messages.at(-1)?.message).toMatchObject({
    type: 'error',
    id: 'overlap',
    error: 'Capture is already active',
  });
  const output = channels(2);
  worklet.process(channels(1), output, 0);
  expect(output[0].every((value) => value === 0)).toBe(true);
  expect(output[1].every((value) => value === 0.25)).toBe(true);
  expect(worklet.messages.at(-1)?.message).toMatchObject({ type: 'started', id: 'original' });
});

it.each(['input', 'output'] as const)(
  'fails a missing selected %s channel before emitting samples',
  (missing) => {
    const worklet = createProcessor();
    worklet.command({
      type: 'start',
      id: 'missing',
      output: stimulus(),
      inputChannel: missing === 'input' ? 1 : 0,
      outputChannel: missing === 'output' ? 1 : 0,
    });
    const output = channels(1, 128, 5);
    worklet.process(channels(1), output, 0);
    expect(output[0].every((value) => value === 0)).toBe(true);
    expect(worklet.messages.at(-1)?.message).toEqual({
      type: 'error',
      id: 'missing',
      error: 'The selected audio channel is unavailable',
    });
  },
);

it('fails non-finite input and clears all outputs before further playback', () => {
  const worklet = createProcessor();
  worklet.command({
    type: 'start',
    id: 'invalid-input',
    output: stimulus(),
    inputChannel: 0,
    outputChannel: 0,
  });
  worklet.process(channels(1), channels(2), 0);
  const input = channels(1);
  input[0][7] = NaN;
  const output = channels(2, 128, 5);
  worklet.process(input, output, 128);
  expect(output.every((channel) => channel.every((sample) => sample === 0))).toBe(true);
  expect(worklet.messages.at(-1)?.message).toEqual({
    type: 'error',
    id: 'invalid-input',
    error: 'Audio input contains a non-finite sample',
  });
});

it.each([
  { id: '', output: stimulus(), inputChannel: 0, outputChannel: 0 },
  { id: 'short', output: new Float32Array(128), inputChannel: 0, outputChannel: 0 },
  { id: 'wide', output: new Float64Array(RECORD_SAMPLES), inputChannel: 0, outputChannel: 0 },
  { id: 'negative', output: stimulus(), inputChannel: -1, outputChannel: 0 },
  { id: 'fractional', output: stimulus(), inputChannel: 0, outputChannel: 0.5 },
  { id: 'unbounded', output: stimulus(), inputChannel: 0, outputChannel: 32 },
  {
    id: 'nonfinite',
    output: new Float32Array(RECORD_SAMPLES).fill(Infinity),
    inputChannel: 0,
    outputChannel: 0,
  },
])('rejects malformed request $id and leaves idle output silent', (request) => {
  const worklet = createProcessor();
  worklet.command({ type: 'start', ...request });
  expect(worklet.messages.at(-1)?.message).toMatchObject({
    type: 'error',
    error: 'Invalid capture request',
  });
  const output = channels(2, 128, 5);
  worklet.process(channels(1, 128, 0.8), output, 0);
  expect(output.every((channel) => channel.every((sample) => sample === 0))).toBe(true);
});
