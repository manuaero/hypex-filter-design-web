// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import CapturePanel from '../src/components/CapturePanel';
import {
  DEFAULT_CAPTURE_CONFIG,
  type CaptureController,
  type CaptureSnapshot,
} from '../src/application/measurement-capture';

let host: HTMLDivElement, root: Root, snapshot: CaptureSnapshot;
const context = { owner: 'browser:human', scope: 'ui:local' };
let controller: CaptureController, publish: (patch: Partial<CaptureSnapshot>) => void;
const target = { slot: 'right' as const, preset: 2, channel: 1 };
let onComplete: Mock<() => void>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    },
  });
  snapshot = {
    phase: 'disabled',
    enabled: false,
    config: { ...DEFAULT_CAPTURE_CONFIG },
    recordedFrames: 0,
    totalFrames: 131072,
    hasResult: false,
  };
  const listeners = new Set<() => void>();
  publish = (patch) => {
    snapshot = { ...snapshot, ...patch };
    for (const fn of listeners) fn();
  };
  controller = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    devices: vi.fn(async () => [
      { kind: 'audioinput' as const, deviceId: 'mic-b', label: 'Measurement interface' },
      { kind: 'audiooutput' as const, deviceId: 'out-b', label: 'Test output' },
    ]),
    chooseOutput: vi.fn(async () => 'out-b'),
    configure: vi.fn(() => snapshot),
    enable: vi.fn(async () => snapshot),
    start: vi.fn(() => snapshot),
    cancel: vi.fn(() => snapshot),
    disable: vi.fn(async () => snapshot),
    apply: vi.fn(async () => snapshot),
    discard: vi.fn(() => snapshot),
    dispose: vi.fn(async () => {}),
  };
  onComplete = vi.fn<() => void>();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});
async function render() {
  await act(async () =>
    root.render(
      <CapturePanel
        controller={controller}
        context={context}
        target={target}
        targetName="Midrange"
        revision={() => 31}
        onComplete={onComplete}
      />,
    ),
  );
}
const button = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;
async function click(text: string) {
  await act(async () => button(text).click());
}

it('opens no media and emits no sweep on mount, enumeration, or opening setup', async () => {
  await render();
  expect(button('Take measurement').disabled).toBe(true);
  expect(controller.enable).not.toHaveBeenCalled();
  expect(controller.start).not.toHaveBeenCalled();
  await click('Audio setup');
  expect(controller.devices).toHaveBeenCalledWith(context);
  expect(host.querySelector('dialog')?.open).toBe(true);
  expect(controller.enable).not.toHaveBeenCalled();
  expect(controller.start).not.toHaveBeenCalled();
});

it('stages device preferences and Cancel does not alter or disable the current route', async () => {
  await render();
  await click('Audio setup');
  const input = host.querySelector<HTMLSelectElement>('[aria-label="Measurement input device"]')!;
  await act(async () => {
    input.value = 'mic-b';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('Cancel');
  expect(controller.configure).not.toHaveBeenCalled();
  expect(controller.disable).not.toHaveBeenCalled();
  await click('Audio setup');
  expect(
    host.querySelector<HTMLSelectElement>('[aria-label="Measurement input device"]')?.value,
  ).toBe('');
});

it('applies staged settings without opening audio or taking a measurement', async () => {
  await render();
  await click('Audio setup');
  const input = host.querySelector<HTMLSelectElement>('[aria-label="Measurement input device"]')!;
  await act(async () => {
    input.value = 'mic-b';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('Apply settings');
  expect(controller.configure).toHaveBeenCalledWith(context, {
    ...DEFAULT_CAPTURE_CONFIG,
    inputDeviceId: 'mic-b',
  });
  expect(controller.enable).not.toHaveBeenCalled();
  expect(controller.start).not.toHaveBeenCalled();
});

it('uses the shared enable action and captures an explicit immutable Right/P3/CH2 destination', async () => {
  await render();
  await click('Enable recording');
  expect(controller.enable).toHaveBeenCalledWith(context);
  await act(async () => publish({ phase: 'ready', enabled: true }));
  await click('Take measurement');
  expect(controller.start).toHaveBeenCalledOnce();
  expect(controller.start).toHaveBeenCalledWith(context, {
    requestId: expect.stringMatching(/^[a-f\d-]{36}$/),
    target: { slot: 'right', preset: 2, channel: 1 },
    expectedRevision: 31,
    name: 'Midrange measurement',
  });
});

it('keeps Cancel enabled while recording and disables another Take and routing changes', async () => {
  await render();
  await act(async () =>
    publish({
      phase: 'recording',
      enabled: true,
      requestId: 'take-a',
      target,
      recordedFrames: 8192,
    }),
  );
  expect(button('Take measurement').disabled).toBe(true);
  expect(button('Audio setup').disabled).toBe(true);
  expect(button('Cancel').disabled).toBe(false);
  expect(host.querySelector('progress')?.value).toBe(8192);
  await click('Cancel');
  expect(controller.cancel).toHaveBeenCalledWith(context, 'take-a');
});

it('keeps a conflict bound to its captured target and exposes explicit Apply and Discard', async () => {
  await render();
  await act(async () =>
    publish({
      phase: 'conflict',
      enabled: true,
      hasResult: true,
      requestId: 'saved-take',
      target: { slot: 'left', preset: 0, channel: 2 },
    }),
  );
  expect(host.textContent).toContain('Captured result retained for Left · P1 · Output 3.');
  expect(button('Take measurement').disabled).toBe(true);
  await click('Apply to this target');
  expect(controller.apply).toHaveBeenCalledWith(context, 'saved-take', 31);
  await click('Discard');
  expect(controller.discard).toHaveBeenCalledWith(context, 'saved-take');
});

it('switches to the impulse view once per completed request, not on every rerender', async () => {
  await render();
  await act(async () => publish({ phase: 'complete', enabled: true, requestId: 'done' }));
  await render();
  expect(onComplete).toHaveBeenCalledTimes(1);
  await act(async () => publish({ phase: 'complete', requestId: 'another' }));
  expect(onComplete).toHaveBeenCalledTimes(2);
});
