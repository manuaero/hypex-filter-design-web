// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import InteractivePlot, { DEFAULT_RANGE } from '../src/components/InteractivePlot';
import { newProject, newFilter, type Channel, type FilterKind } from '../src/domain/model';

vi.mock('../src/components/ResponsePlot', () => ({ default: () => null }));
const manualKinds: FilterKind[] = [
  'lowpass1',
  'lowpass2',
  'highpass1',
  'highpass2',
  'lowshelf1',
  'highshelf1',
  'lowshelf2',
  'highshelf2',
  'peak',
  'asymmetric',
  'allpass1',
  'allpass2',
];
const qKinds = new Set<FilterKind>(['lowpass2', 'highpass2', 'lowshelf2', 'highshelf2', 'peak']);
let host: HTMLDivElement, root: Root;
const changed = vi.fn(),
  begin = vi.fn(),
  end = vi.fn(),
  selected = vi.fn(),
  rangeChanged = vi.fn();
const range = { ...DEFAULT_RANGE, frequencyMin: 10, frequencyMax: 10000, dbMin: -60, dbMax: 60 };
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
  for (const mock of [changed, begin, end, selected, rangeChanged]) mock.mockClear();
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
type Options = Partial<
  Pick<
    ComponentProps<typeof InteractivePlot>,
    'mode' | 'contextKey' | 'selectedFilter' | 'activeFilter' | 'qGestureProfile' | 'onGraphQChange'
  >
>;
async function renderChannels(channels: Channel[], options: Options = {}) {
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
        contextKey="left:p1:ch1"
        onRange={rangeChanged}
        onSelect={selected}
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
}
async function mount(kind: FilterKind, linked = false, options: Options = {}) {
  const channels = newProject().presets[0].channels;
  channels[0].filters[0] = {
    ...newFilter(kind),
    frequency: 800,
    frequency2: 400,
    q: 0.7,
    q2: 1.3,
    gain: 6,
  };
  if (linked) channels[0].linkedTo = 1;
  await renderChannels(channels, options);
  return channels;
}
const marker = () => host.querySelector<HTMLButtonElement>('[data-filter="0"]')!;
async function wheel(deltaY: number, target: Element = marker()) {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  await act(async () => target.dispatchEvent(event));
  return event;
}
async function pointer(type: string, x: number, y: number, target: Element, ctrlKey: boolean) {
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
async function drag(dx: number, dy: number, ctrlKey: boolean) {
  const target = marker(),
    x = Number.parseFloat(target.style.left),
    y = Number.parseFloat(target.style.top),
    plot = host.querySelector('.interactive-plot')!;
  await pointer('pointerdown', x, y, target, ctrlKey);
  await pointer('pointermove', x + dx, y + dy, plot, ctrlKey);
  await pointer('pointerup', x + dx, y + dy, plot, ctrlKey);
}

it.each(manualKinds)(
  '%s graph wheel offers Q only for the native LP2/HP2/Shelf2/Peak gate',
  async (kind) => {
    const channels = await mount(kind),
      before = structuredClone(channels);
    expect(marker()).not.toBeNull();
    await wheel(-120);
    await wheel(120);
    if (qKinds.has(kind)) {
      expect(changed.mock.calls.map(([patch]) => patch)).toEqual([{ q: 0.74 }, { q: 0.7 }]);
      expect(marker().title).toContain('Ctrl-drag or wheel Q');
    } else {
      expect(changed).not.toHaveBeenCalled();
      expect(marker().title).not.toContain('Ctrl-drag or wheel Q');
    }
    expect(channels).toEqual(before);
  },
);
it.each(manualKinds)(
  '%s vertical Ctrl-drag changes Q only where native graph Q is supported',
  async (kind) => {
    const channels = await mount(kind),
      before = structuredClone(channels);
    await drag(24, -20, true);
    if (qKinds.has(kind)) expect(changed).toHaveBeenCalledExactlyOnceWith({ q: 0.74 });
    else expect(changed).not.toHaveBeenCalled();
    expect(channels).toEqual(before);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledExactlyOnceWith();
  },
);
it.each(manualKinds)(
  '%s horizontal Ctrl-drag does not fall through to frequency or gain',
  async (kind) => {
    const channels = await mount(kind),
      before = structuredClone(channels);
    await drag(24, 0, true);
    expect(changed).not.toHaveBeenCalled();
    expect(channels).toEqual(before);
  },
);
it.each(['asymmetric', 'allpass2'] as const)(
  '%s ordinary drag still changes frequency while graph Q remains unavailable',
  async (kind) => {
    const channels = await mount(kind),
      before = structuredClone(channels);
    await drag(24, -20, false);
    // Absolute native pixel326 on this400px log axis, stored as Single.
    expect(changed).toHaveBeenCalledExactlyOnceWith({ frequency: 1216.18603515625 });
    expect(channels).toEqual(before);
  },
);
it('Unity and exact raw sections have no graph marker or graph Q entrypoint', async () => {
  await mount('unity');
  expect(marker()).toBeNull();
  await mount('raw');
  expect(marker()).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});
it('linked channel markers remain inspection-only for wheel and Ctrl-drag', async () => {
  await mount('peak', true);
  await wheel(-120);
  await drag(24, -20, true);
  expect(changed).not.toHaveBeenCalled();
  expect(begin).not.toHaveBeenCalled();
  expect(marker().title).toContain('linked to master');
  expect(marker().title).not.toContain('Ctrl-drag or wheel Q');
});

it('actual native selected Peak progresses1.15->1.19->1.23 from blank-chart wheel120 and360', async () => {
  const channels = await mount('peak');
  channels[0].filters[0].q = 1.15;
  await renderChannels(channels);
  const blank = host.querySelector('.plot-interaction')!;
  await wheel(-120, blank);
  await wheel(-360, blank);
  expect(changed.mock.calls.map(([p]) => p)).toEqual([{ q: 1.19 }, { q: 1.23 }]);
  expect(selected).not.toHaveBeenCalled();
});
it('wheel over another marker adjusts the already-selected filter without selecting the hovered marker', async () => {
  const channels = structuredClone(await mount('peak'));
  channels[0].filters[1] = { ...newFilter('peak'), frequency: 300, q: 3, gain: -3 };
  await renderChannels(channels);
  await wheel(-120, host.querySelector('[data-filter="1"]')!);
  expect(changed).toHaveBeenCalledExactlyOnceWith({ q: 0.74 });
  expect(selected).not.toHaveBeenCalled();
  expect(channels[0].filters[1].q).toBe(3);
});
it('whole-channel response scope retains the active editing filter for graph Q', async () => {
  await mount('peak', false, { selectedFilter: null });
  await wheel(-120, host.querySelector('.plot-interaction')!);
  expect(changed).toHaveBeenCalledExactlyOnceWith({ q: 0.74 });
});
it('an absent active editing filter and zero wheel delta do not acquire graph-Q edits', async () => {
  await mount('peak', false, { activeFilter: -1 });
  await wheel(-120, host.querySelector('.plot-interaction')!);
  expect(changed).not.toHaveBeenCalled();
  await mount('peak');
  await wheel(0, host.querySelector('.plot-interaction')!);
  expect(changed).not.toHaveBeenCalled();
  expect(selected).not.toHaveBeenCalled();
});

it.each(['Phase', 'Group delay'] as const)(
  '%s blank-chart wheel cannot edit Magnitude graph Q',
  async (mode) => {
    await mount('peak', false, { mode });
    await wheel(-120, host.querySelector('.plot-interaction')!);
    expect(changed).not.toHaveBeenCalled();
    expect(rangeChanged).not.toHaveBeenCalled();
  },
);
it.each(['Impulse', 'Step'] as const)(
  '%s wheel retains its separate time-view zoom without graph-Q changes',
  async (mode) => {
    await mount('peak', false, { mode });
    await wheel(-120, host.querySelector('.plot-interaction')!);
    expect(changed).not.toHaveBeenCalled();
    expect(rangeChanged).toHaveBeenCalledTimes(1);
  },
);
it('Ctrl captured on pointer-down persists after key release and steps current Q once per qualifying move', async () => {
  await mount('peak');
  const target = marker(),
    x = parseFloat(target.style.left),
    y = parseFloat(target.style.top),
    plot = host.querySelector('.interactive-plot')!;
  await pointer('pointerdown', x, y, target, true);
  await pointer('pointermove', x + 24, y - 20, plot, false);
  await pointer('pointermove', x + 48, y - 20, plot, false);
  await pointer('pointermove', x + 60, y + 20, plot, false);
  await pointer('pointerup', x + 60, y + 20, plot, false);
  expect(changed.mock.calls.map(([p]) => p)).toEqual([{ q: 0.74 }, { q: 0.78 }, { q: 0.74 }]);
  expect(begin).toHaveBeenCalledTimes(1);
  expect(end).toHaveBeenCalledExactlyOnceWith();
});
it('pressing Ctrl after an ordinary drag begins does not switch the captured gesture into Q', async () => {
  await mount('peak');
  const target = marker(),
    x = parseFloat(target.style.left),
    y = parseFloat(target.style.top),
    plot = host.querySelector('.interactive-plot')!;
  await pointer('pointerdown', x, y, target, false);
  await pointer('pointermove', x + 24, y - 20, plot, true);
  await pointer('pointerup', x + 24, y - 20, plot, true);
  expect(changed).toHaveBeenCalledExactlyOnceWith({
    frequency: 1216.18603515625,
    gain: 18,
  });
});
it('all-target refusal clears graph transient state and never falls back to the scalar onChange callback', async () => {
  const graph = vi.fn((_q: number) => false);
  await mount('peak', false, { onGraphQChange: graph });
  const blank = host.querySelector('.plot-interaction')!;
  await wheel(-120, blank);
  await wheel(-120, blank);
  expect(graph.mock.calls.map(([q]) => q)).toEqual([0.74, 0.74]);
  expect(changed).not.toHaveBeenCalled();
});
it.each(['ordinary', 'input-eq'] as const)(
  '%s graph profile keeps its own off-grid bound publication rule',
  async (qGestureProfile) => {
    const channels = await mount('peak');
    channels[0].filters[0].q = 0.100000001;
    await renderChannels(channels, { qGestureProfile });
    await wheel(120, host.querySelector('.plot-interaction')!);
    if (qGestureProfile === 'ordinary') expect(changed).toHaveBeenCalledExactlyOnceWith({ q: 0.1 });
    else expect(changed).not.toHaveBeenCalled();
  },
);
it('context, profile, external value and selection changes reset private graph wheel state', async () => {
  const channels = await mount('peak'),
    blank = () => host.querySelector('.plot-interaction')!;
  await wheel(-120, blank());
  expect(changed).toHaveBeenLastCalledWith({ q: 0.74 });
  await renderChannels(channels, { contextKey: 'right:p1:ch1' });
  await wheel(-120, blank());
  expect(changed).toHaveBeenLastCalledWith({ q: 0.74 });
  await renderChannels(channels, { contextKey: 'right:p1:ch1', qGestureProfile: 'input-eq' });
  await wheel(-120, blank());
  expect(changed).toHaveBeenLastCalledWith({ q: 0.74 });
  const external = structuredClone(channels);
  external[0].filters[0].q = 2.3;
  await renderChannels(external, { contextKey: 'right:p1:ch1', qGestureProfile: 'input-eq' });
  await wheel(-120, blank());
  expect(changed).toHaveBeenLastCalledWith({ q: 2.34 });
  const count = changed.mock.calls.length;
  await renderChannels(external, { activeFilter: -1 });
  await wheel(-120, blank());
  expect(changed).toHaveBeenCalledTimes(count);
  await renderChannels(external);
  await wheel(-120, blank());
  expect(changed).toHaveBeenLastCalledWith({ q: 2.34 });
});
