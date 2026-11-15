export interface ZoomAxes {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  xScale: 'linear' | 'logarithmic';
}
export interface ZoomPoint {
  x: number;
  y: number;
}
export interface ZoomBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}
export type RectangleZoom = { kind: 'none' } | { kind: 'undo' } | { kind: 'zoom'; axes: ZoomAxes };

const nativePixel = (value: number) => {
  const floor = Math.floor(value),
    fraction = value - floor;
  return fraction === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
};

/** HFD5.2.4.24 bundled TTeeZoom b00c58 defaults: Direction=both,
 * MinimumPixels=16, UpLeftZooms=false. TCustomChart.MouseUp b5ddb6..de17
 * requires BOTH rounded pixel spans strictly>16; positiveX invokes DoZoom,
 * reverseX invokes UndoZoom independently of Y direction. DoZoom b5da30 calls
 * b043cc to sort corners, then maps both axes (b5dbe0..dcff, b5ba70).
 * Mapping is deliberately not clipped: the native axis functions receive the
 * pointer coordinates. Caller owns supported plot limits and zoom history. */
export function rectangleZoom(
  axes: ZoomAxes,
  start: ZoomPoint,
  end: ZoomPoint,
  bounds: ZoomBounds,
): RectangleZoom {
  if (
    ![
      axes.xMin,
      axes.xMax,
      axes.yMin,
      axes.yMax,
      start.x,
      start.y,
      end.x,
      end.y,
      bounds.left,
      bounds.top,
      bounds.width,
      bounds.height,
    ].every(Number.isFinite) ||
    axes.xMax <= axes.xMin ||
    axes.yMax <= axes.yMin ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    !['linear', 'logarithmic'].includes(axes.xScale) ||
    (axes.xScale === 'logarithmic' && axes.xMin <= 0)
  )
    throw new Error('Invalid rectangle zoom geometry');
  const x1 = nativePixel(start.x),
    x2 = nativePixel(end.x),
    y1 = nativePixel(start.y),
    y2 = nativePixel(end.y);
  if (Math.abs(x2 - x1) <= 16 || Math.abs(y2 - y1) <= 16) return { kind: 'none' };
  if (x2 < x1) return { kind: 'undo' };
  const xAt = (x: number) => {
      const fraction = (x - bounds.left) / bounds.width;
      return axes.xScale === 'linear'
        ? axes.xMin + fraction * (axes.xMax - axes.xMin)
        : Math.exp(Math.log(axes.xMin) + fraction * (Math.log(axes.xMax) - Math.log(axes.xMin)));
    },
    yAt = (y: number) => axes.yMax - ((y - bounds.top) / bounds.height) * (axes.yMax - axes.yMin);
  const next = {
    ...axes,
    xMin: xAt(x1),
    xMax: xAt(x2),
    yMin: yAt(Math.max(y1, y2)),
    yMax: yAt(Math.min(y1, y2)),
  };
  if (
    ![next.xMin, next.xMax, next.yMin, next.yMax].every(Number.isFinite) ||
    next.xMax <= next.xMin ||
    next.yMax <= next.yMin ||
    (next.xScale === 'logarithmic' && next.xMin <= 0)
  )
    return { kind: 'none' };
  return { kind: 'zoom', axes: next };
}

export interface RectangleZoomHistory {
  original?: ZoomAxes;
  previous: ZoomAxes[];
}
/** ImpChart leaves History=false (TTeeZoom constructor zero-initialization),
 * so UndoZoom restores the first prezoom range. MagChart/StepChart History=true
 * steps through previous zoom ranges. b5d714/b5d948/b5d968 restore axis snapshots,
 * never a guessed factor-two expansion. Treat returned state as immutable. */
export function applyRectangleZoom(
  history: RectangleZoomHistory,
  current: ZoomAxes,
  zoom: RectangleZoom,
  keepHistory: boolean,
): { axes?: ZoomAxes; history: RectangleZoomHistory } {
  if (zoom.kind === 'none') return { history };
  if (zoom.kind === 'zoom')
    return {
      axes: { ...zoom.axes },
      history: {
        original: { ...(history.original ?? current) },
        previous: keepHistory
          ? [...history.previous.map((axes) => ({ ...axes })), { ...current }]
          : [],
      },
    };
  if (!history.original) return { history };
  const previous = history.previous.map((axes) => ({ ...axes })),
    axes = keepHistory ? (previous.pop() ?? history.original) : history.original;
  return {
    axes: { ...axes },
    history:
      keepHistory && previous.length
        ? { original: { ...history.original }, previous }
        : { previous: [] },
  };
}
