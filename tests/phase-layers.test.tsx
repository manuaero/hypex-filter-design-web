// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PhaseLayers from '../src/components/PhaseLayers';
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
it('exposes three independent phase boxes and preserves checked-but-unavailable native state', async () => {
  const channels = newProject().presets[0].channels;
  channels[1].measurement = { name: 'driver', sampleRate: 48000, impulse: [1] };
  const before = structuredClone(channels),
    patch = vi.fn();
  await act(async () =>
    root.render(
      <PhaseLayers
        state={{ channels: [true, false, false], sum: false }}
        channels={channels}
        channelIndex={0}
        onPatch={patch}
      />,
    ),
  );
  const boxes = [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  expect(boxes).toHaveLength(4);
  expect(boxes[0].checked).toBe(true);
  expect(boxes[0].disabled).toBe(true);
  expect(boxes[1].disabled).toBe(false);
  expect(boxes[2].disabled).toBe(true);
  expect(host.textContent).toContain('Woofer · current');
  await act(async () => boxes[1].click());
  expect(patch).toHaveBeenLastCalledWith({ channels: [true, true, false] });
  expect(channels).toEqual(before);
});
it('phase sum sends only a visibility patch and explains canonical sum membership', async () => {
  const channels = newProject().presets[0].channels,
    before = structuredClone(channels),
    patch = vi.fn();
  await act(async () =>
    root.render(
      <PhaseLayers
        state={{ channels: [false, false, false], sum: false }}
        channels={channels}
        channelIndex={1}
        onPatch={patch}
      />,
    ),
  );
  const sum = host.querySelector<HTMLInputElement>('input[aria-label="Show phase sum"]')!;
  expect(sum.disabled).toBe(false);
  expect(sum.closest('label')!.title).toContain('hiding a phase curve does not remove it');
  await act(async () => sum.click());
  expect(patch).toHaveBeenCalledExactlyOnceWith({ sum: true });
  expect(channels).toEqual(before);
});
it('disables every phase control during a host-disabled context', async () => {
  const channels = newProject().presets[0].channels;
  channels.forEach(
    (channel) => (channel.measurement = { name: 'driver', sampleRate: 48000, impulse: [1] }),
  );
  const patch = vi.fn();
  await act(async () =>
    root.render(
      <PhaseLayers
        state={{ channels: [true, true, true], sum: true }}
        channels={channels}
        channelIndex={2}
        disabled
        onPatch={patch}
      />,
    ),
  );
  expect(
    [...host.querySelectorAll<HTMLInputElement>('input')].every((field) => field.disabled),
  ).toBe(true);
  await act(async () => host.querySelector<HTMLInputElement>('input')!.click());
  expect(patch).not.toHaveBeenCalled();
});
it('can leave sum control in the visible host header without duplicating it in the curves menu', async () => {
  const channels = newProject().presets[0].channels;
  await act(async () =>
    root.render(
      <PhaseLayers
        state={{ channels: [true, false, false], sum: true }}
        channels={channels}
        channelIndex={0}
        onPatch={() => {}}
        showSumControl={false}
      />,
    ),
  );
  expect(host.querySelectorAll('input[type=checkbox]')).toHaveLength(3);
  expect(host.querySelector('input[aria-label="Show phase sum"]')).toBeNull();
});
