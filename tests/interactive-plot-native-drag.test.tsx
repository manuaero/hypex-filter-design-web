// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import InteractivePlot, { DEFAULT_RANGE } from '../src/components/InteractivePlot';
import { newProject, newFilter, type Channel, type FilterKind } from '../src/domain/model';

vi.mock('../src/components/ResponsePlot', () => ({ default: () => null }));
let host: HTMLDivElement, root: Root;
const changed = vi.fn(),
  begin = vi.fn(),
  end = vi.fn();
const range = { ...DEFAULT_RANGE, frequencyMin: 10, frequencyMax: 10000, dbMin: -20, dbMax: 20 };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(468);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(262);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    top: 50,
    width: 468,
    height: 262,
    right: 568,
    bottom: 312,
    x: 100,
    y: 50,
    toJSON() {},
  });
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  for (const mock of [changed, begin, end]) mock.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(
  kind: FilterKind = 'peak',
  options: Partial<ComponentProps<typeof InteractivePlot>> = {},
) {
  const channels = newProject().presets[0].channels;
  channels[0].filters[0] = {
    ...newFilter(kind),
    frequency: 2300,
    frequency2: 988.101806640625,
    q: 1.15,
    gain: 7.5,
  };
  await act(async () =>
    root.render(
      <InteractivePlot
        channels={channels}
        mode="Magnitude"
        sum={false}
        measured={false}
        activeChannel={0}
        activeFilter={0}
        range={range}
        contextKey="left:p1:c1"
        onRange={vi.fn()}
        onSelect={vi.fn()}
        onChange={changed}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onToggle={vi.fn()}
        begin={begin}
        end={end}
        {...options}
      />,
    ),
  );
  return channels;
}
async function pointer(type: string, x: number, y: number, target: Element, ctrlKey = false) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x + 100,
    clientY: y + 50,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    ctrlKey,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  await act(async () => target.dispatchEvent(event));
}
const marker = () => host.querySelector<HTMLButtonElement>('[data-filter="0"]')!;
const plot = () => host.querySelector('.interactive-plot')!;
async function start(offsetX = 0, offsetY = 0) {
  const m = marker();
  await pointer(
    'pointerdown',
    parseFloat(m.style.left) + offsetX,
    parseFloat(m.style.top) + offsetY,
    m,
  );
}
it('maps ordinary drag to the absolute integer chart coordinate, without a marker grab-offset frequency ratio', async () => {
  const channels = await mount(),
    before = structuredClone(channels);
  await start(3.2, 5.4);
  await pointer('pointermove', 300.2, 90.2, plot());
  await pointer('pointerup', 300.2, 90.2, plot());
  expect(changed).toHaveBeenCalledExactlyOnceWith({ frequency: 776.2471313476562, gain: 7.9 });
  expect(channels).toEqual(before);
  expect(begin).toHaveBeenCalledOnce();
  expect(end).toHaveBeenCalledExactlyOnceWith();
});
it('clamps the captured pointer to current displayed X/Y axes, before the native gain pipeline rather than extrapolating to ±60', async () => {
  await mount();
  await start();
  await pointer('pointermove', 999, -999, plot());
  await pointer('pointerup', 999, -999, plot());
  expect(changed).toHaveBeenCalledExactlyOnceWith({ frequency: 10000, gain: 19.9 });
});
it('preserves inactive gain and latent secondary frequency during an ordinary asymmetric drag', async () => {
  const channels = await mount('asymmetric'),
    before = structuredClone(channels);
  await start(2, 0);
  await pointer('pointermove', 300, 90, plot());
  await pointer('pointerup', 300, 90, plot());
  expect(changed).toHaveBeenCalledExactlyOnceWith({ frequency: 776.2471313476562 });
  expect(channels).toEqual(before);
});

it('snaps an off-center grab to absolute X even when the drag has zero horizontal motion', async () => {
  await mount();
  const m = marker(),
    x = parseFloat(m.style.left) + 3,
    y = parseFloat(m.style.top);
  await pointer('pointerdown', x, y, m);
  await pointer('pointermove', x, y - 20, plot());
  await pointer('pointerup', x, y - 20, plot());
  expect(changed).toHaveBeenCalledExactlyOnceWith({ frequency: 2426.610107421875, gain: 11.5 });
});
it('narrows pointer coordinates to Single before nearest-even integer mapping', async () => {
  await mount();
  await start(3.2, 5.4);
  await pointer('pointermove', 300.500001, 90.500001, plot());
  expect(changed).toHaveBeenCalledExactlyOnceWith({ frequency: 776.2471313476562, gain: 7.9 });
});
it('uses the displayed lower frequency bound without imposing the typed10Hz minimum', async () => {
  await mount('peak', { range: { ...range, frequencyMin: 1 } });
  await start();
  await pointer('pointermove', -100, 90, plot());
  expect(changed.mock.calls.at(-1)![0].frequency).toBe(1);
});
it('rejects an out-of-axis mouse-down before selection or opening a filter gesture', async () => {
  const selected = vi.fn();
  await mount('peak', { onSelect: selected });
  await pointer('pointerdown', -10, 100, marker());
  await pointer('pointermove', 300, 90, plot());
  await pointer('pointerup', 300, 90, plot());
  expect(changed).not.toHaveBeenCalled();
  expect(begin).not.toHaveBeenCalled();
  expect(end).not.toHaveBeenCalled();
  expect(selected).not.toHaveBeenCalled();
});
it('keeps InputEQ ordinary drag on its pre-existing separate convenience mapping', async () => {
  await mount('peak', { qGestureProfile: 'input-eq' });
  await start(3.2, 5.4);
  await pointer('pointermove', 300.2, 90.2, plot());
  expect(changed.mock.calls[0][0].frequency).toBeCloseTo(737.0557456044518, 10);
  expect(changed.mock.calls[0][0].gain).toBeCloseTo(7.840000000000003, 10);
});
it('uses the exact operation returned at pointer-down and ends it after rejection or cancellation', async () => {
  const op = { change: vi.fn(() => false), end: vi.fn() },
    startOperation = vi.fn(() => op);
  await mount('peak', { onGraphDragStart: startOperation });
  await start();
  await pointer('pointermove', 300, 90, plot());
  await pointer('pointerup', 300, 90, plot());
  expect(startOperation).toHaveBeenCalledExactlyOnceWith(0);
  expect(op.change).toHaveBeenCalledOnce();
  expect(op.end).toHaveBeenCalledExactlyOnceWith(true);
  expect(begin).not.toHaveBeenCalled();
  expect(end).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});
it('does not edit when source admission rejects the ordinary graph gesture', async () => {
  const admission = vi.fn(() => false as const);
  await mount('peak', { onGraphDragStart: admission });
  await start();
  await pointer('pointermove', 300, 90, plot());
  expect(admission).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
  expect(begin).not.toHaveBeenCalled();
});
