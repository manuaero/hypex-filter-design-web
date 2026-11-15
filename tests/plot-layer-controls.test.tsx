// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PlotLayerControls from '../src/components/PlotLayerControls';
import { createGraphViewController } from '../src/application/graph-view';
import { newProject } from '../src/domain/model';

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
});

it('renders compact independent controls, loaded/current labels, and emits detached raw preferences', async () => {
  const channels = newProject().presets[0].channels;
  channels[0].measurement = { name: 'impulse', sampleRate: 48000, impulse: [1] };
  channels[1].measurement = { name: 'spectrum', sampleRate: 48000, frequency: [100] };
  const state = createGraphViewController().getSnapshot().left,
    onPatch = vi.fn(),
    before = structuredClone(channels);
  await act(async () =>
    root.render(
      <PlotLayerControls state={state} channels={channels} channelIndex={1} onPatch={onPatch} />,
    ),
  );
  expect(host.querySelector('summary')?.textContent).toContain('Layers');
  expect(host.textContent).toContain(`${channels[1].name} (current)`);
  expect(host.textContent).toContain(`${channels[0].name} (other)`);
  const boxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(boxes).toHaveLength(6);
  expect(boxes.map((box) => box.disabled)).toEqual([false, false, false, false, false, true]);
  await act(async () => boxes[4].click());
  expect(onPatch).toHaveBeenLastCalledWith({ rawMeasurements: [false, true, false] });
  expect(state.rawMeasurements).toEqual([false, false, false]);
  expect(channels).toEqual(before);
  await act(async () => boxes[0].click());
  expect(onPatch).toHaveBeenLastCalledWith({ currentResult: false });
  await act(async () => boxes[1].click());
  expect(onPatch).toHaveBeenLastCalledWith({ otherResults: false });
  await act(async () => boxes[2].click());
  expect(onPatch).toHaveBeenLastCalledWith({ section: true });
});

it('uses shared preset/scope actions and disables every action while its owner is busy', async () => {
  const channels = newProject().presets[0].channels,
    state = createGraphViewController().getSnapshot().left,
    onPatch = vi.fn();
  const render = (disabled: boolean) =>
    root.render(
      <PlotLayerControls
        state={state}
        channels={channels}
        channelIndex={0}
        onPatch={onPatch}
        disabled={disabled}
      />,
    );
  await act(async () => render(false));
  const buttons = [...host.querySelectorAll('button')];
  await act(async () => buttons[0].click());
  expect(onPatch).toHaveBeenLastCalledWith({ preset: 'outputs' });
  await act(async () => buttons[1].click());
  expect(onPatch).toHaveBeenLastCalledWith({ preset: 'hfd' });
  const select = host.querySelector('select')!;
  await act(async () => {
    select.value = 'channel';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(onPatch).toHaveBeenLastCalledWith({ sectionScope: 'channel' });
  await act(async () => render(true));
  expect(
    [
      ...host.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
        'input,button,select',
      ),
    ].every((control) => control.disabled),
  ).toBe(true);
  const calls = onPatch.mock.calls.length;
  await act(async () => buttons[1].click());
  expect(onPatch).toHaveBeenCalledTimes(calls);
});
