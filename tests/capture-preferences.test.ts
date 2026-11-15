import { expect, it, vi } from 'vitest';
import {
  CAPTURE_PREFERENCES_KEY,
  MAX_CAPTURE_PREFERENCES_BYTES,
  loadCapturePreferences,
  saveCapturePreferences,
} from '../src/audio/capture-preferences';
import type { CaptureConfig } from '../src/application/measurement-capture';

const config: CaptureConfig = {
  inputDeviceId: 'interface-input',
  outputDeviceId: 'interface-output',
  inputChannel: 3,
  outputChannel: 7,
  requestedSampleRate: 96000,
  outputGainDb: -12,
};
function memory(initial: string | null = null) {
  let value = initial;
  return {
    get value() {
      return value;
    },
    getItem: vi.fn((_key: string) => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next;
    }),
  };
}
const envelope = () => {
  const { outputGainDb: _gain, ...routing } = config;
  return { version: 1, config: routing };
};

it('reads the versioned key without writing defaults or granting/opening any session', () => {
  const storage = memory();
  expect(loadCapturePreferences(storage)).toBeUndefined();
  expect(storage.getItem).toHaveBeenCalledExactlyOnceWith(CAPTURE_PREFERENCES_KEY);
  expect(storage.setItem).not.toHaveBeenCalled();
});

it('round-trips detached routing preferences and always resets output gain to0', () => {
  const storage = memory(),
    input = { ...config };
  saveCapturePreferences(storage, input);
  expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(
    'fusion-studio.audio-preferences.v1',
    JSON.stringify(envelope()),
  );
  const saved = storage.value!;
  input.inputDeviceId = 'caller changed';
  input.outputGainDb = 20;
  const first = loadCapturePreferences(storage)!;
  expect(first).toEqual({ ...config, outputGainDb: 0 });
  first.outputDeviceId = 'loaded object changed';
  first.outputChannel = 0;
  expect(loadCapturePreferences(storage)).toEqual({ ...config, outputGainDb: 0 });
  expect(storage.value).toBe(saved);
  expect(JSON.parse(saved)).not.toHaveProperty('config.outputGainDb');
  expect(storage.setItem).toHaveBeenCalledTimes(1);
});

it('preserves an absent requested rate and the complete schema channel boundaries', () => {
  const storage = memory(),
    { requestedSampleRate: _rate, ...withoutRate } = config;
  saveCapturePreferences(storage, { ...withoutRate, inputChannel: 0, outputChannel: 255 });
  const loaded = loadCapturePreferences(storage)!;
  expect(loaded).toEqual({ ...withoutRate, inputChannel: 0, outputChannel: 255, outputGainDb: 0 });
  expect(loaded).not.toHaveProperty('requestedSampleRate');
});

it.each([
  '{broken',
  JSON.stringify({ ...envelope(), version: 2 }),
  JSON.stringify({ config: envelope().config }),
  JSON.stringify({ ...envelope(), runtime: { enabled: true } }),
  JSON.stringify({ version: 1, config: { ...envelope().config, outputGainDb: 5 } }),
  JSON.stringify({ version: 1, config: { ...envelope().config, stream: {} } }),
  JSON.stringify({ version: 1, config: { ...envelope().config, inputChannel: -1 } }),
])(
  'rejects malformed, unsupported or extended saved preferences without overwriting: %s',
  (text) => {
    const storage = memory(text);
    expect(() => loadCapturePreferences(storage)).toThrow('invalid and were retained');
    expect(storage.value).toBe(text);
    expect(storage.setItem).not.toHaveBeenCalled();
  },
);

it('checks the16-KiB byte budget before parsing, including multibyte text, with an exact boundary', () => {
  const parse = vi.spyOn(JSON, 'parse');
  try {
    for (const text of [' '.repeat(MAX_CAPTURE_PREFERENCES_BYTES + 1), '漢'.repeat(6000)]) {
      const storage = memory(text);
      parse.mockClear();
      expect(() => loadCapturePreferences(storage)).toThrow('16 KiB');
      expect(parse).not.toHaveBeenCalled();
      expect(storage.setItem).not.toHaveBeenCalled();
    }
    const exact = JSON.stringify(envelope()).padEnd(MAX_CAPTURE_PREFERENCES_BYTES, ' ');
    expect(loadCapturePreferences(memory(exact))).toEqual({ ...config, outputGainDb: 0 });
  } finally {
    parse.mockRestore();
  }
});

it('validates the full config, including discarded gain and runtime extras, before any write', () => {
  const storage = memory('existing preferences');
  for (const patch of [
    { inputChannel: -1 },
    { inputChannel: 256 },
    { outputChannel: 0.5 },
    { requestedSampleRate: 7999 },
    { requestedSampleRate: 384001 },
    { outputGainDb: NaN },
    { outputGainDb: Infinity },
    { inputDeviceId: 'x'.repeat(2049) },
    { runtime: { enabled: true } },
  ])
    expect(() => saveCapturePreferences(storage, { ...config, ...patch })).toThrow();
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(storage.value).toBe('existing preferences');
});

it('rejects an escaped oversized envelope before writing even when all config fields validate', () => {
  const storage = memory('original');
  expect(() =>
    saveCapturePreferences(storage, {
      ...config,
      inputDeviceId: '\u0000'.repeat(2048),
      outputDeviceId: '\u0000'.repeat(2048),
    }),
  ).toThrow('16 KiB');
  expect(storage.value).toBe('original');
  expect(storage.setItem).not.toHaveBeenCalled();
});

it('reports unreadable storage and quota errors without fallback writes', () => {
  const read = new Error('Storage access denied'),
    write = new Error('Quota exceeded'),
    getItem = vi.fn(() => {
      throw read;
    }),
    setItem = vi.fn(() => {
      throw write;
    });
  expect(() => loadCapturePreferences({ getItem })).toThrow(
    'could not be read: Storage access denied',
  );
  expect(() => saveCapturePreferences({ setItem }, config)).toThrow(
    'could not be saved: Quota exceeded',
  );
  expect(getItem).toHaveBeenCalledTimes(1);
  expect(setItem).toHaveBeenCalledTimes(1);
});
