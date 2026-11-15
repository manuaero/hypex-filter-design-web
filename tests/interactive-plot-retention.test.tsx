// @vitest-environment jsdom
import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import InteractivePlot from '../src/components/InteractivePlot';
import { createPlotViewController, type PlotViewController } from '../src/application/plot-view';
import { newProject, type Slot } from '../src/domain/model';
import type { PlotMode } from '../src/domain/plot-viewport';

vi.mock('../src/components/ResponsePlot', () => ({ default: () => null }));
const project = newProject(),
  changed = vi.fn(),
  begin = vi.fn(),
  end = vi.fn();
let host: HTMLDivElement, root: Root, controller: PlotViewController;
function Harness({
  slot,
  mode,
  visible = true,
}: {
  slot: Slot;
  mode: PlotMode;
  visible?: boolean;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot),
    context = { slot, mode };
  return visible ? (
    <InteractivePlot
      channels={project.presets[0].channels}
      mode={mode}
      sum={false}
      measured={false}
      activeChannel={0}
      activeFilter={0}
      contextKey={`${slot}:${mode}`}
      range={snapshot[slot][mode].range}
      onRange={(range) => controller.update(context, range)}
      onRectangleZoom={(zoom, range) => controller.rectangle(context, zoom, range)}
      onResetRange={() => controller.reset(context)}
      onSelect={vi.fn()}
      onChange={changed}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
      onToggle={vi.fn()}
      begin={begin}
      end={end}
    />
  ) : null;
}
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
    left: 0,
    top: 0,
    width: 468,
    height: 262,
    right: 468,
    bottom: 262,
    x: 0,
    y: 0,
    toJSON() {},
  });
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  controller = createPlotViewController();
  changed.mockClear();
  begin.mockClear();
  end.mockClear();
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
const show = async (slot: Slot, mode: PlotMode, visible = true) => {
  await act(async () => root.render(<Harness slot={slot} mode={mode} visible={visible} />));
};
async function pointer(type: string, x: number, y: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 1,
    buttons: type === 'pointerup' ? 0 : 4,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  await act(async () => host.querySelector('.plot-interaction')!.dispatchEvent(event));
}
async function drag(reverse = false) {
  const a = reverse ? [348, 174] : [148, 74],
    b = reverse ? [148, 74] : [348, 174];
  await pointer('pointerdown', a[0], a[1]);
  await pointer('pointermove', b[0], b[1]);
  await pointer('pointerup', b[0], b[1]);
}
it.each(['Magnitude', 'Phase', 'Group delay', 'Step'] as const)(
  'actual %s pointer history survives chart unmount and keeps the other role independent',
  async (mode) => {
    await show('left', mode);
    const original = controller.getSnapshot().left[mode].range;
    await drag();
    const first = controller.getSnapshot().left[mode].range;
    await drag();
    await show('left', mode, false);
    await show('right', mode);
    await drag();
    const right = controller.getSnapshot().right[mode];
    await show('left', mode);
    await drag(true);
    expect(controller.getSnapshot().left[mode].range).toEqual(first);
    expect(controller.getSnapshot().right[mode]).toBe(right);
    await drag(true);
    expect(controller.getSnapshot().left[mode].range).toEqual(original);
    expect(changed).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  },
);
it('actual Impulse forward pointer drag couples Step X only and reverse after unmount restores the first Impulse snapshot', async () => {
  controller.update({ slot: 'left', mode: 'Step' }, { amplitudeMin: -8, amplitudeMax: 8 });
  await show('left', 'Impulse');
  const original = controller.getSnapshot().left.Impulse.range;
  await drag();
  await drag();
  const step = controller.getSnapshot().left.Step;
  expect(step.range.amplitudeMin).toBe(-8);
  expect(step.range.amplitudeMax).toBe(8);
  expect(step.range.timeMinMs).toBe(controller.getSnapshot().left.Impulse.range.timeMinMs);
  await show('left', 'Impulse', false);
  await show('left', 'Impulse');
  await drag(true);
  expect(controller.getSnapshot().left.Impulse.range).toEqual(original);
  expect(controller.getSnapshot().left.Step).toBe(step);
});
it('role change during an unfinished pointer rectangle cancels it before either viewport changes', async () => {
  await show('left', 'Impulse');
  const original = controller.getSnapshot();
  await pointer('pointerdown', 148, 74);
  await pointer('pointermove', 348, 174);
  await show('right', 'Impulse');
  await pointer('pointerup', 348, 174);
  expect(controller.getSnapshot()).toBe(original);
});
it('selection context changes close the old frequency menu before it can edit another role', async () => {
  await show('left', 'Magnitude');
  await act(async () =>
    host.querySelector('.plot-interaction')!.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 150,
        clientY: 90,
      }),
    ),
  );
  expect(host.querySelector('.plot-menu')).not.toBeNull();
  await show('right', 'Magnitude');
  expect(host.querySelector('.plot-menu')).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});
