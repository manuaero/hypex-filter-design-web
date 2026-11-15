import { describe, expect, it } from 'vitest';
import {
  rectangleZoom,
  applyRectangleZoom,
  type ZoomAxes,
  type RectangleZoomHistory,
} from '../src/components/plot-zoom-geometry';

const axes: ZoomAxes = { xMin: -20, xMax: 80, yMin: -2, yMax: 6, xScale: 'linear' };
const bounds = { left: 48, top: 24, width: 400, height: 200 };
const rectangle = (a: ZoomAxes = axes) =>
  rectangleZoom(a, { x: 148, y: 74 }, { x: 348, y: 174 }, bounds);

describe('recovered HFD two-axis rectangle gesture', () => {
  it('maps X and inverted-screen Y into the actual plot, preserving signed values and axis units', () => {
    expect(rectangle()).toEqual({
      kind: 'zoom',
      axes: { ...axes, xMin: 5, xMax: 55, yMin: 0, yMax: 4 },
    });
  });
  it('sorts the Y endpoints for an upward rightward drag without reversing amplitude', () => {
    expect(rectangleZoom(axes, { x: 148, y: 174 }, { x: 348, y: 74 }, bounds)).toEqual(rectangle());
  });
  it.each([174, 274])(
    'reverse X invokes UndoZoom independently of vertical direction (%i)',
    (y) => {
      expect(rectangleZoom(axes, { x: 348, y: 224 }, { x: 148, y }, bounds)).toEqual({
        kind: 'undo',
      });
    },
  );
  it('requires BOTH spans strictly larger than16 native pixels, even on reverse drags', () => {
    for (const end of [
      { x: 300, y: 74 },
      { x: 148, y: 170 },
      { x: 164, y: 170 },
      { x: 300, y: 90 },
      { x: 132, y: 170 },
    ])
      expect(rectangleZoom(axes, { x: 148, y: 74 }, end, bounds)).toEqual({ kind: 'none' });
    expect(rectangleZoom(axes, { x: 148, y: 74 }, { x: 165, y: 91 }, bounds).kind).toBe('zoom');
  });
  it('uses native nearest-even pixel coordinates at the minimum-size boundary', () => {
    expect(rectangleZoom(axes, { x: 148, y: 74 }, { x: 164.5, y: 91 }, bounds).kind).toBe('none');
    expect(rectangleZoom(axes, { x: 148, y: 74 }, { x: 164.5001, y: 91 }, bounds).kind).toBe(
      'zoom',
    );
  });
  it('uses logarithmic X but linear Y for magnitude rectangles', () => {
    const result = rectangle({ ...axes, xMin: 10, xMax: 10000, xScale: 'logarithmic' });
    expect(result.kind).toBe('zoom');
    if (result.kind !== 'zoom') throw new Error('Expected zoom');
    expect(result.axes.xMin).toBeCloseTo(10 ** 1.75, 12);
    expect(result.axes.xMax).toBeCloseTo(10 ** 3.25, 10);
    expect([result.axes.yMin, result.axes.yMax]).toEqual([0, 4]);
  });
  it('does not invent clipping of native coordinate-to-axis mapping', () => {
    expect(rectangleZoom(axes, { x: -52, y: -26 }, { x: 548, y: 274 }, bounds)).toEqual({
      kind: 'zoom',
      axes: { ...axes, xMin: -45, xMax: 105, yMin: -4, yMax: 8 },
    });
  });
  it('does not mutate its captured range, points or viewport', () => {
    const source = structuredClone({
        axes,
        bounds,
        start: { x: 148, y: 74 },
        end: { x: 348, y: 174 },
      }),
      snapshot = structuredClone(source);
    rectangleZoom(source.axes, source.start, source.end, source.bounds);
    expect(source).toEqual(snapshot);
  });
  it('rejects invalid geometry and ignores numeric overflow without returning an invalid view', () => {
    for (const invalid of [{ width: 0 }, { height: -1 }, { left: NaN }])
      expect(() =>
        rectangleZoom(axes, { x: 1, y: 1 }, { x: 50, y: 50 }, { ...bounds, ...invalid }),
      ).toThrow();
    expect(() => rectangle({ ...axes, xMin: 0, xScale: 'logarithmic' })).toThrow();
    expect(
      rectangleZoom(
        { ...axes, xMin: 1, xMax: 1e300, xScale: 'logarithmic' },
        { x: 148, y: 74 },
        { x: 10000, y: 174 },
        bounds,
      ).kind,
    ).toBe('none');
  });
});

describe('native reverse-drag zoom history', () => {
  it('time graph reverse resets the original XY range after multiple zooms instead of doubling the latest span', () => {
    const first = applyRectangleZoom({ previous: [] }, axes, rectangle(), false),
      second = applyRectangleZoom(first.history, first.axes!, rectangle(first.axes!), false),
      undone = applyRectangleZoom(second.history, second.axes!, { kind: 'undo' }, false);
    expect(undone.axes).toEqual(axes);
    expect(undone.history).toEqual({ previous: [] });
    expect(applyRectangleZoom(undone.history, axes, { kind: 'undo' }, false).axes).toBeUndefined();
  });
  it('magnitude History=true steps back exactly one snapshot and then restores the original', () => {
    const original = { ...axes, xMin: 10, xMax: 10000, xScale: 'logarithmic' as const },
      first = applyRectangleZoom({ previous: [] }, original, rectangle(original), true),
      second = applyRectangleZoom(first.history, first.axes!, rectangle(first.axes!), true),
      undone = applyRectangleZoom(second.history, second.axes!, { kind: 'undo' }, true),
      reset = applyRectangleZoom(undone.history, undone.axes!, { kind: 'undo' }, true);
    expect(undone.axes).toEqual(first.axes);
    expect(reset.axes).toEqual(original);
    expect(reset.history).toEqual({ previous: [] });
  });
  it('small drags and reverse before any zoom do not alter view or history', () => {
    const history: RectangleZoomHistory = { previous: [] };
    expect(applyRectangleZoom(history, axes, { kind: 'undo' }, false)).toEqual({ history });
    expect(applyRectangleZoom(history, axes, { kind: 'none' }, false)).toEqual({ history });
  });
  it('snapshots are detached from original inputs and later zoom results', () => {
    const initial = { ...axes },
      first = applyRectangleZoom({ previous: [] }, initial, rectangle(), true),
      baseline = structuredClone(first.history),
      second = applyRectangleZoom(first.history, first.axes!, rectangle(first.axes!), true);
    initial.xMin = -999;
    second.axes!.yMin = -999;
    second.history.previous[0].xMin = -555;
    expect(first.history).toEqual(baseline);
    expect(first.history.original).toEqual(axes);
  });
});
