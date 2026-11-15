import { expect, it, vi } from 'vitest';
import {
  createPlotViewController,
  MAX_PLOT_ZOOM_HISTORY,
  type PlotViewContext,
} from '../src/application/plot-view';
import { defaultPlotRange, PLOT_MODES } from '../src/domain/plot-viewport';
import { rectangleZoom, type ZoomAxes } from '../src/components/plot-zoom-geometry';

const context: PlotViewContext = { slot: 'left', mode: 'Impulse' };
function zoom(controller: ReturnType<typeof createPlotViewController>, selected = context) {
  const range = controller.getSnapshot()[selected.slot][selected.mode].range,
    timed = selected.mode === 'Impulse' || selected.mode === 'Step',
    axes: ZoomAxes = timed
      ? {
          xMin: range.timeMinMs,
          xMax: range.timeMaxMs,
          yMin: range.amplitudeMin,
          yMax: range.amplitudeMax,
          xScale: 'linear',
        }
      : {
          xMin: range.frequencyMin,
          xMax: range.frequencyMax,
          yMin: range.dbMin,
          yMax: range.dbMax,
          xScale: 'logarithmic',
        };
  controller.rectangle(
    selected,
    rectangleZoom(
      axes,
      { x: 25, y: 25 },
      { x: 75, y: 75 },
      { left: 0, top: 0, width: 100, height: 100 },
    ),
    range,
  );
}
function back(controller: ReturnType<typeof createPlotViewController>, selected = context) {
  controller.rectangle(
    selected,
    { kind: 'undo' },
    controller.getSnapshot()[selected.slot][selected.mode].range,
  );
}

it('owns ten detached frozen viewports with the existing rendered defaults and bounded public summaries', () => {
  const c = createPlotViewController(),
    s = c.getSnapshot();
  expect(c.getSnapshot()).toBe(s);
  for (const role of ['left', 'right'] as const)
    for (const mode of PLOT_MODES) {
      expect(s[role][mode].range).toEqual(defaultPlotRange(mode));
      expect(Object.isFrozen(s[role][mode].range)).toBe(true);
      expect(s[role][mode]).not.toHaveProperty('history');
      expect(s[role][mode].touched).toBe(false);
    }
  expect(s.left.Impulse.range).not.toBe(s.left.Step.range);
  expect(s.left.Impulse.range).not.toBe(s.right.Impulse.range);
  expect(s.left.Phase.range).toMatchObject({ dbMin: -180, dbMax: 180 });
  expect(s.left['Group delay'].range).toMatchObject({ dbMin: -5, dbMax: 25 });
  expect(JSON.stringify(s).length).toBeLessThan(5000);
});
it('changes only the selected role/mode and does not alias input range patches', () => {
  const c = createPlotViewController(),
    before = c.getSnapshot(),
    patch = { amplitudeMin: -4, amplitudeMax: 6 };
  c.update(context, patch);
  patch.amplitudeMin = -999;
  expect(c.getSnapshot().left.Impulse.range.amplitudeMin).toBe(-4);
  expect(c.getSnapshot().left.Step).toBe(before.left.Step);
  expect(c.getSnapshot().right).toBe(before.right);
  c.update({ slot: 'left', mode: 'Phase' }, { dbMin: -90, dbMax: 45 });
  expect(c.getSnapshot().left.Magnitude).toBe(before.left.Magnitude);
});
it('Impulse forward zoom copies only timeX into Step, preserving its own Y and history; reverse does not copy', () => {
  const c = createPlotViewController();
  c.update(context, { timeMinMs: -20, timeMaxMs: 80, amplitudeMin: -2, amplitudeMax: 6 });
  c.update({ slot: 'left', mode: 'Step' }, { amplitudeMin: -10, amplitudeMax: 20 });
  zoom(c, { slot: 'left', mode: 'Step' });
  const stepBefore = c.getSnapshot().left.Step;
  zoom(c);
  const impulseFirst = c.getSnapshot().left.Impulse,
    stepAfter = c.getSnapshot().left.Step;
  expect(impulseFirst.range).toMatchObject({
    timeMinMs: 5,
    timeMaxMs: 55,
    amplitudeMin: 0,
    amplitudeMax: 4,
  });
  expect(stepAfter.range.timeMinMs).toBe(5);
  expect(stepAfter.range.timeMaxMs).toBe(55);
  expect(stepAfter.range.amplitudeMin).toBe(stepBefore.range.amplitudeMin);
  expect(stepAfter.range.amplitudeMax).toBe(stepBefore.range.amplitudeMax);
  expect(stepAfter.undoDepth).toBe(stepBefore.undoDepth);
  expect(stepAfter.touched).toBe(true);
  zoom(c);
  const stepLast = c.getSnapshot().left.Step;
  back(c);
  expect(c.getSnapshot().left.Impulse.range).toMatchObject({
    timeMinMs: -20,
    timeMaxMs: 80,
    amplitudeMin: -2,
    amplitudeMax: 6,
  });
  expect(c.getSnapshot().left.Step).toBe(stepLast);
  const impulseReset = c.getSnapshot().left.Impulse;
  back(c, { slot: 'left', mode: 'Step' });
  expect(c.getSnapshot().left.Impulse).toBe(impulseReset);
  expect(c.getSnapshot().left.Step.range.amplitudeMin).toBe(-10);
});
it.each(['Step', 'Magnitude', 'Phase', 'Group delay'] as const)(
  '%s retains reverse snapshots independently of navigation consumers',
  (mode) => {
    const c = createPlotViewController(),
      selected = { slot: 'right' as const, mode },
      original = c.getSnapshot().right[mode].range;
    zoom(c, selected);
    const first = c.getSnapshot().right[mode].range;
    zoom(c, selected);
    // Unsubscribing/unmounting a chart never owns or clears the controller.
    const stop = c.subscribe(vi.fn());
    stop();
    back(c, selected);
    expect(c.getSnapshot().right[mode].range).toEqual(first);
    back(c, selected);
    expect(c.getSnapshot().right[mode].range).toEqual(original);
    expect(c.getSnapshot().right[mode].canReverse).toBe(false);
  },
);
it('manual changes retain history; Reset clears only its visible role/mode', () => {
  const c = createPlotViewController();
  zoom(c, { slot: 'left', mode: 'Magnitude' });
  zoom(c, { slot: 'right', mode: 'Step' });
  c.update({ slot: 'left', mode: 'Magnitude' }, { dbMin: -30, dbMax: 30 });
  expect(c.getSnapshot().left.Magnitude.canReverse).toBe(true);
  const other = c.getSnapshot().right.Step;
  c.reset({ slot: 'left', mode: 'Magnitude' });
  expect(c.getSnapshot().left.Magnitude.range).toEqual(defaultPlotRange('Magnitude'));
  expect(c.getSnapshot().left.Magnitude.canReverse).toBe(false);
  expect(c.getSnapshot().right.Step).toBe(other);
  back(c, { slot: 'left', mode: 'Magnitude' });
  expect(c.getSnapshot().left.Magnitude.range).toEqual(defaultPlotRange('Magnitude'));
});
it('rejects stale captured rectangles and invalid range updates without any published change', () => {
  const c = createPlotViewController(),
    old = c.getSnapshot().left.Impulse.range;
  c.update(context, { amplitudeMax: 3 });
  const before = c.getSnapshot();
  expect(() => c.rectangle(context, { kind: 'undo' }, old)).toThrow(/changed/);
  for (const patch of [{ amplitudeMin: 5 }, { frequencyMin: 0 }, { timeMaxMs: NaN }, { wrong: 1 }])
    expect(() => c.update(context, patch as never)).toThrow();
  expect(c.getSnapshot()).toBe(before);
});
it('caps retained reverse history without exposing arrays and still reaches the first baseline', () => {
  const c = createPlotViewController(),
    selected = { slot: 'left' as const, mode: 'Magnitude' as const },
    original = c.getSnapshot().left.Magnitude.range;
  for (let i = 0; i < MAX_PLOT_ZOOM_HISTORY + 10; i++) {
    const r = c.getSnapshot().left.Magnitude.range;
    c.rectangle(
      selected,
      {
        kind: 'zoom',
        axes: { xMin: 10, xMax: 40000, yMin: i + 1, yMax: i + 2, xScale: 'logarithmic' },
      },
      r,
    );
  }
  expect(c.getSnapshot().left.Magnitude.undoDepth).toBe(MAX_PLOT_ZOOM_HISTORY);
  for (let i = 0; i <= MAX_PLOT_ZOOM_HISTORY; i++) back(c, selected);
  expect(c.getSnapshot().left.Magnitude.range).toEqual(original);
});
