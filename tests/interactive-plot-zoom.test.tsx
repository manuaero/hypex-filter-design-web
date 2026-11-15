// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import InteractivePlot, { DEFAULT_RANGE, type PlotRange } from '../src/components/InteractivePlot';
import type { PlotMode } from '../src/components/ResponsePlot';
import { newProject } from '../src/domain/model';

vi.mock('../src/components/ResponsePlot', () => ({ default: () => null }));
let host: HTMLDivElement, root: Root;
const project = newProject(),
  changed = vi.fn(),
  begin = vi.fn(),
  end = vi.fn(),
  viewGestures: string[] = [],
  updates: PlotRange[] = [];
const initial: PlotRange = {
  ...DEFAULT_RANGE,
  timeMinMs: -20,
  timeMaxMs: 80,
  amplitudeMin: -2,
  amplitudeMax: 6,
  frequencyMin: 10,
  frequencyMax: 10000,
  dbMin: -40,
  dbMax: 20,
};
function Harness({ mode, contextKey = 'original' }: { mode: PlotMode; contextKey?: string }) {
  const [range, setRange] = useState(initial);
  return (
    <InteractivePlot
      channels={project.presets[0].channels}
      preset={project.presets[0]}
      mode={mode}
      sum={false}
      measured={false}
      activeChannel={0}
      activeFilter={0}
      range={range}
      onRange={(next) => {
        viewGestures.push('range');
        updates.push(next);
        setRange(next);
      }}
      contextKey={contextKey}
      onRangeGestureStart={(kind) => viewGestures.push(`start:${kind}`)}
      onRangeGestureCommit={() => viewGestures.push('commit')}
      onRangeGestureCancel={() => viewGestures.push('cancel')}
      onSelect={vi.fn()}
      onChange={changed}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
      onToggle={vi.fn()}
      begin={begin}
      end={end}
    />
  );
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
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
  changed.mockClear();
  begin.mockClear();
  end.mockClear();
  updates.length = 0;
  viewGestures.length = 0;
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
async function mount(mode: PlotMode, contextKey?: string) {
  await act(async () => root.render(<Harness mode={mode} contextKey={contextKey} />));
}
async function pointer(type: string, x: number, y: number, button = 1) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x + 100,
    clientY: y + 50,
    button,
    buttons: type === 'pointerup' ? 0 : button === 1 ? 4 : 1,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  await act(async () => host.querySelector('.plot-interaction')!.dispatchEvent(event));
}
async function drag(start = { x: 148, y: 74 }, stop = { x: 348, y: 174 }) {
  await pointer('pointerdown', start.x, start.y);
  await pointer('pointermove', stop.x, stop.y);
  await pointer('pointerup', stop.x, stop.y);
}
const reverse = () => drag({ x: 348, y: 174 }, { x: 148, y: 74 });

it('actual Impulse pointer drag changes both physical time and amplitude axes, without filter edits or Undo gesture callbacks', async () => {
  await mount('Impulse');
  await drag();
  expect(updates).toEqual([
    { ...initial, timeMinMs: 5, timeMaxMs: 55, amplitudeMin: 0, amplitudeMax: 4 },
  ]);
  expect(changed).not.toHaveBeenCalled();
  expect(begin).not.toHaveBeenCalled();
  expect(end).not.toHaveBeenCalled();
});
it('actual pointer interaction ignores an X-only rectangle and native16-pixel-sized Y drag', async () => {
  await mount('Impulse');
  await drag({ x: 148, y: 74 }, { x: 348, y: 74 });
  await drag({ x: 148, y: 74 }, { x: 348, y: 90 });
  expect(updates).toEqual([]);
});
it('Impulse reverse restores the first XY snapshot after two rectangle zooms', async () => {
  await mount('Impulse');
  await drag();
  await drag();
  await reverse();
  expect(updates.length).toBe(3);
  expect(updates.at(-1)).toEqual(initial);
  await reverse();
  expect(updates.length).toBe(3);
});
it.each(['Step', 'Magnitude'] as const)(
  '%s uses native History=true and reverses one XY zoom at a time',
  async (mode) => {
    await mount(mode);
    await drag();
    const first = { ...updates[0] };
    await drag();
    await reverse();
    expect(updates.at(-1)).toEqual(first);
    await reverse();
    if (mode === 'Magnitude') {
      expect(first.frequencyMin).toBeCloseTo(10 ** 1.75, 12);
      expect(first.frequencyMax).toBeCloseTo(10 ** 3.25, 10);
      expect([first.dbMin, first.dbMax]).toEqual([-25, 5]);
      expect(updates.at(-1)?.frequencyMin).toBeCloseTo(initial.frequencyMin, 10);
      expect(updates.at(-1)?.frequencyMax).toBeCloseTo(initial.frequencyMax, 10);
      expect(updates.at(-1)?.dbMin).toBe(initial.dbMin);
      expect(updates.at(-1)?.dbMax).toBe(initial.dbMax);
      expect(updates[0].timeMinMs).toBe(initial.timeMinMs);
      expect(updates[0].amplitudeMin).toBe(initial.amplitudeMin);
    } else expect(updates.at(-1)).toEqual(initial);
  },
);
it('keeps each graph history separate and reverses only its axes after switching frequency/time views', async () => {
  await mount('Magnitude');
  await drag();
  await mount('Impulse');
  await drag();
  const timed = { ...updates.at(-1)! };
  await mount('Magnitude');
  await reverse();
  expect(updates.at(-1)).toEqual({
    ...timed,
    frequencyMin: initial.frequencyMin,
    frequencyMax: initial.frequencyMax,
    dbMin: initial.dbMin,
    dbMax: initial.dbMax,
  });
  await mount('Impulse');
  await reverse();
  expect(updates.at(-1)).toEqual(initial);
});
it('cancelled pointer rectangles neither zoom nor add a future reverse snapshot', async () => {
  await mount('Impulse');
  await pointer('pointerdown', 148, 74);
  await pointer('pointermove', 348, 174);
  await pointer('pointercancel', 348, 174);
  await pointer('pointerup', 348, 174);
  await reverse();
  expect(updates).toEqual([]);
});

it('commits a view once after the final rectangle action, and commits plain mouse-up clicks without filter Undo gestures', async () => {
  await mount('Impulse');
  await pointer('pointerdown', 148, 74);
  await pointer('pointermove', 348, 174);
  expect(viewGestures).toEqual(['start:zoom']);
  await pointer('pointerup', 348, 174);
  expect(viewGestures).toEqual(['start:zoom', 'range', 'commit']);
  viewGestures.length = 0;
  await pointer('pointerdown', 200, 120, 0);
  await pointer('pointerup', 200, 120, 0);
  expect(viewGestures).toEqual(['start:pan', 'commit']);
  expect(begin).not.toHaveBeenCalled();
  expect(end).not.toHaveBeenCalled();
});

it('pan moves remain preview-only until one mouse-up commit, while cancellation and context changes cancel without a write callback', async () => {
  await mount('Impulse');
  await pointer('pointerdown', 148, 74, 0);
  await pointer('pointermove', 200, 100, 0);
  await pointer('pointermove', 250, 120, 0);
  expect(viewGestures).toEqual(['start:pan', 'range', 'range']);
  await pointer('pointerup', 250, 120, 0);
  expect(viewGestures.at(-1)).toBe('commit');
  expect(viewGestures.filter((value) => value === 'commit')).toHaveLength(1);
  viewGestures.length = 0;
  await pointer('pointerdown', 148, 74);
  await pointer('pointercancel', 200, 120);
  await pointer('pointerup', 200, 120);
  expect(viewGestures).toEqual(['start:zoom', 'cancel']);
  viewGestures.length = 0;
  await pointer('pointerdown', 148, 74);
  await mount('Impulse', 'replacement-output');
  await pointer('pointerup', 348, 174);
  expect(viewGestures).toEqual(['start:zoom', 'cancel']);
});

it('reverse rectangles commit only after native reverse geometry has restored the first snapshot', async () => {
  await mount('Impulse');
  await drag();
  viewGestures.length = 0;
  await reverse();
  expect(viewGestures).toEqual(['start:zoom', 'range', 'commit']);
  expect(updates.at(-1)).toEqual(initial);
});
