// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Measurements from '../src/components/Measurements';
import { newProject, type Preset, type Slot } from '../src/domain/model';
import { defaultHfdMeasurementOptions } from '../src/domain/hfd-measurement';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const field = (label: string) =>
  host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const setValue = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
function fixture(native = true): Preset {
  const preset = newProject('Measurement context').presets[0];
  preset.channels.forEach((channel, index) => {
    channel.measurement = {
      name: `IR ${index}`,
      sampleRate: 48000,
      impulse: Array.from({ length: 128 }, (_, sample) => (sample === 20 ? 1 : 0)),
    };
    if (native)
      channel.hfdMeasurement = {
        ...defaultHfdMeasurementOptions(48000),
        localStart: index * 10,
        stopInclusive: 100 + index,
        phaseStart: 20 + index,
      };
  });
  return preset;
}
async function harness(native = true) {
  const first = fixture(native);
  let documents: Record<Slot, Preset> = { left: first, right: structuredClone(first) },
    slot: Slot = 'left',
    selected = 0,
    revision = 0;
  const edits: { slot: Slot; channel: number }[] = [],
    microphoneChanges: { slot: Slot; smoothingOctaves?: number }[] = [];
  const onError = vi.fn();
  const paint = () => {
    const role = slot,
      channel = selected;
    root.render(
      <Measurements
        preset={documents[role]}
        selected={channel}
        contextKey={`${role}:0:${revision}`}
        onSelect={(index) => {
          selected = index;
          paint();
        }}
        view="impulse"
        onView={() => {}}
        calibrationCurve={false}
        onCalibrationCurve={() => {}}
        edit={(change) => {
          const next = structuredClone(documents[role]);
          change(next);
          documents = { ...documents, [role]: next };
          revision++;
          edits.push({ slot: role, channel });
          paint();
        }}
        readFile={() => {}}
        onError={onError}
        nativeCentered={false}
        onNativeCentered={() => {}}
        microphone={{ filename: '', loaded: false, showCurve: false, smoothingOctaves: 0.015 }}
        onMicrophoneLoad={() => {}}
        onMicrophoneUnload={() => {}}
        onMicrophoneOptions={(patch) => {
          microphoneChanges.push({ slot: role, ...patch });
        }}
      />,
    );
  };
  await act(async () => paint());
  return {
    documents: () => documents,
    edits,
    microphoneChanges,
    onError,
    select: async (next: { slot?: Slot; channel?: number }) =>
      act(async () => {
        if (next.slot) slot = next.slot;
        if (next.channel !== undefined) selected = next.channel;
        paint();
      }),
    replace: async (next: Preset) =>
      act(async () => {
        documents = { ...documents, [slot]: next };
        revision++;
        paint();
      }),
  };
}

describe('measurement drafts remain bound to their original context', () => {
  it('discards a focused native crop draft when the role changes even if channel IDs are identical', async () => {
    const h = await harness(),
      before = JSON.stringify(h.documents()),
      input = field('Local start');
    await act(async () => {
      input.focus();
      setValue(input, '12');
      setValue(input, '123');
    });
    expect(input.value).toBe('123');
    expect(h.edits).toEqual([]);
    await h.select({ slot: 'right' });
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('0');
    await act(async () => input.blur());
    expect(h.edits).toEqual([]);
    expect(JSON.stringify(h.documents())).toBe(before);
  });

  it('discards browser window drafts on channel selection and permits a fresh edit on the new channel', async () => {
    const h = await harness(false),
      beforeLeftFirst = structuredClone(h.documents().left.channels[0]),
      input = field('Start sample');
    await act(async () => {
      input.focus();
      setValue(input, '12');
    });
    await h.select({ channel: 1 });
    expect(input.value).toBe('0');
    await act(async () => input.blur());
    expect(h.edits).toEqual([]);
    await act(async () => {
      input.focus();
      setValue(input, '8');
      input.blur();
    });
    expect(h.edits).toEqual([{ slot: 'left', channel: 1 }]);
    expect(h.documents().left.channels[0]).toEqual(beforeLeftFirst);
    expect(h.documents().left.channels[1].measurement?.processing?.window?.start).toBe(8);
  });

  it('cancels same-ID replacement/revision drafts while keeping focused arrow edits usable', async () => {
    const h = await harness(),
      input = field('Phase start');
    await act(async () => {
      input.focus();
      setValue(input, '99');
    });
    const replaced = structuredClone(h.documents().left);
    replaced.channels[0].hfdMeasurement!.phaseStart = 40;
    await h.replace(replaced);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('40');
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })),
    );
    expect(document.activeElement).toBe(input);
    expect(h.edits).toEqual([{ slot: 'left', channel: 0 }]);
    expect(h.documents().left.channels[0].hfdMeasurement!.phaseStart).toBe(41);
    await act(async () => input.blur());
    expect(h.edits).toHaveLength(1);
  });

  it('keeps legitimate multi-digit processing input local until one Enter/blur commit', async () => {
    const h = await harness(),
      input = field('Sample rate');
    await act(async () => input.focus());
    for (const value of ['9', '96', '960', '9600', '96000'])
      await act(async () => setValue(input, value));
    expect(input.value).toBe('96000');
    expect(h.edits).toEqual([]);
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(h.edits).toEqual([{ slot: 'left', channel: 0 }]);
    expect(h.documents().left.channels[0].hfdMeasurement!.sampleRate).toBe(96000);
    expect(h.documents().right.channels[0].hfdMeasurement!.sampleRate).toBe(48000);
    expect(h.onError).not.toHaveBeenLastCalledWith(expect.stringMatching(/invalid/i));
  });

  it('discards correction-width drafts before the new role callback can run', async () => {
    const h = await harness(),
      input = field('Correction width');
    await act(async () => {
      input.focus();
      setValue(input, '.25');
    });
    await h.select({ slot: 'right' });
    expect(input.value).toBe('0.015');
    await act(async () => input.blur());
    expect(h.microphoneChanges).toEqual([]);
  });

  it('cancels a crop gesture across a role switch but commits one current-context crop gesture', async () => {
    const h = await harness(),
      before = JSON.stringify(h.documents());
    const graph = () =>
      host.querySelector<SVGSVGElement>('svg[aria-label="Original impulse measurement graph"]')!;
    const install = () => {
      Object.defineProperty(graph(), 'getScreenCTM', {
        configurable: true,
        value: () => ({ inverse: () => ({}) }),
      });
      Object.defineProperty(graph(), 'setPointerCapture', { configurable: true, value: () => {} });
    };
    vi.stubGlobal(
      'DOMPoint',
      class {
        constructor(
          readonly x: number,
          readonly y: number,
        ) {}
        matrixTransform() {
          return this;
        }
      },
    );
    const pointer = async (type: string, x: number) =>
      act(async () =>
        graph().dispatchEvent(
          new MouseEvent(type, { clientX: x, clientY: 80, button: 0, bubbles: true }),
        ),
      );
    install();
    await pointer('pointerdown', 120);
    await pointer('pointermove', 400);
    await h.select({ slot: 'right' });
    install();
    await pointer('pointerup', 600);
    expect(h.edits).toEqual([]);
    expect(JSON.stringify(h.documents())).toBe(before);
    await pointer('pointerdown', 120);
    await pointer('pointermove', 400);
    await pointer('pointerup', 600);
    expect(h.edits).toEqual([{ slot: 'right', channel: 0 }]);
    expect(h.documents().right.channels[0].hfdMeasurement!.localStart).toBeGreaterThan(0);
    expect(h.documents().left.channels[0].hfdMeasurement!.localStart).toBe(0);
    vi.unstubAllGlobals();
  });
});
