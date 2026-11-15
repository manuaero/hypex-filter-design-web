import { type Slot } from '../domain/model';
import {
  PLOT_MODES,
  defaultPlotRange,
  validatePlotRange,
  type PlotMode,
  type PlotRange,
} from '../domain/plot-viewport';
import {
  applyRectangleZoom,
  type RectangleZoom,
  type RectangleZoomHistory,
  type ZoomAxes,
} from '../components/plot-zoom-geometry';

/** Browser memory limit; native TeeChart history itself is not claimed bounded. */
export const MAX_PLOT_ZOOM_HISTORY = 64;
export interface PlotViewContext {
  slot: Slot;
  mode: PlotMode;
}
export interface PlotViewport {
  readonly range: Readonly<PlotRange>;
  readonly revision: number;
  readonly touched: boolean;
  readonly undoDepth: number;
  readonly canReverse: boolean;
}
export type PlotViewSnapshot = Readonly<Record<Slot, Readonly<Record<PlotMode, PlotViewport>>>>;
export interface PlotViewController {
  getSnapshot(): PlotViewSnapshot;
  subscribe(listener: () => void): () => void;
  update(
    context: PlotViewContext,
    patch: Partial<PlotRange>,
    options?: { expectedRange?: Readonly<PlotRange>; clearHistory?: boolean },
  ): void;
  reset(context: PlotViewContext): void;
  /** Passive saved-view projection. Does not invoke rectangle callbacks or the
   * native forward Impulse→Step coupling. Caller owns document selection. */
  restore(context: PlotViewContext, range: Readonly<PlotRange>): void;
  rectangle(
    context: PlotViewContext,
    zoom: RectangleZoom,
    capturedRange: Readonly<PlotRange>,
  ): void;
}
const timed = (mode: PlotMode) => mode === 'Impulse' || mode === 'Step';
const axesFor = (mode: PlotMode, range: Readonly<PlotRange>): ZoomAxes =>
  timed(mode)
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
const equalRange = (a: Readonly<PlotRange>, b: Readonly<PlotRange>) =>
  (Object.keys(defaultPlotRange('Magnitude')) as (keyof PlotRange)[]).every(
    (key) => a[key] === b[key],
  );
const viewport = (mode: PlotMode): PlotViewport =>
  Object.freeze({
    range: Object.freeze(defaultPlotRange(mode)),
    revision: 0,
    touched: false,
    undoDepth: 0,
    canReverse: false,
  });
const roleDefaults = () =>
  Object.freeze(Object.fromEntries(PLOT_MODES.map((mode) => [mode, viewport(mode)]))) as Readonly<
    Record<PlotMode, PlotViewport>
  >;

/** Charts retain viewports across component/tab navigation. Role separation and
 * Phase/Group-delay standalone axes are browser adaptations, not native saved
 * per-group XML semantics. Native geometry/history remains in its pure helper. */
export function createPlotViewController(): PlotViewController {
  let snapshot: PlotViewSnapshot = Object.freeze({ left: roleDefaults(), right: roleDefaults() });
  const history: Record<Slot, Partial<Record<PlotMode, RectangleZoomHistory>>> = {
      left: {},
      right: {},
    },
    listeners = new Set<() => void>();
  function check(context: PlotViewContext) {
    if (!context || !['left', 'right'].includes(context.slot) || !PLOT_MODES.includes(context.mode))
      throw new Error('Invalid plot viewport context');
    return snapshot[context.slot][context.mode];
  }
  function publish(
    context: PlotViewContext,
    range: PlotRange,
    nextHistory: RectangleZoomHistory,
    touched = true,
  ): boolean {
    validatePlotRange(range);
    const previous = check(context),
      oldHistory = history[context.slot][context.mode] ?? { previous: [] };
    if (
      equalRange(previous.range, range) &&
      previous.touched === touched &&
      oldHistory === nextHistory
    )
      return false;
    history[context.slot][context.mode] = nextHistory;
    const value: PlotViewport = Object.freeze({
      range: Object.freeze({ ...range }),
      touched,
      revision: previous.revision + 1,
      canReverse: !!nextHistory.original,
      undoDepth: nextHistory.original ? Math.max(1, nextHistory.previous.length) : 0,
    });
    snapshot = Object.freeze({
      ...snapshot,
      [context.slot]: Object.freeze({ ...snapshot[context.slot], [context.mode]: value }),
    });
    return true;
  }
  const notify = () => listeners.forEach((listener) => listener());
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(context, patch, options) {
      const current = check(context);
      if (options?.expectedRange && options.expectedRange !== current.range)
        throw new Error('The plot changed during this gesture');
      if (
        !patch ||
        typeof patch !== 'object' ||
        Array.isArray(patch) ||
        Object.keys(patch).some((key) => !Object.hasOwn(DEFAULT_KEYS, key))
      )
        throw new Error('Invalid plot range patch');
      const next = { ...current.range, ...patch };
      const currentHistory = (history[context.slot][context.mode] ??= { previous: [] });
      if (publish(context, next, options?.clearHistory ? { previous: [] } : currentHistory))
        notify();
    },
    reset(context) {
      check(context);
      if (publish(context, defaultPlotRange(context.mode), { previous: [] })) notify();
    },
    restore(context, range) {
      check(context);
      if (publish(context, { ...range }, { previous: [] })) notify();
    },
    rectangle(context, zoom, capturedRange) {
      const current = check(context);
      if (
        !zoom ||
        !['none', 'zoom', 'undo'].includes(zoom.kind) ||
        (zoom.kind === 'zoom' && zoom.axes?.xScale !== axesFor(context.mode, current.range).xScale)
      )
        throw new Error('Invalid plot rectangle action');
      if (capturedRange !== current.range) throw new Error('The plot changed during this gesture');
      const result = applyRectangleZoom(
        history[context.slot][context.mode] ?? { previous: [] },
        axesFor(context.mode, current.range),
        zoom,
        context.mode !== 'Impulse',
      );
      if (!result.axes) return;
      const a = result.axes,
        next = timed(context.mode)
          ? {
              ...current.range,
              timeMinMs: a.xMin,
              timeMaxMs: a.xMax,
              amplitudeMin: a.yMin,
              amplitudeMax: a.yMax,
            }
          : {
              ...current.range,
              frequencyMin: Math.max(0.001, Math.min(50000, a.xMin)),
              frequencyMax: Math.max(0.001, Math.min(50000, a.xMax)),
              dbMin: a.yMin,
              dbMax: a.yMax,
            };
      if (!timed(context.mode) && next.frequencyMin >= next.frequencyMax) return;
      const bounded = {
        ...result.history,
        previous:
          result.history.previous.length > MAX_PLOT_ZOOM_HISTORY
            ? [
                { ...result.history.original! },
                ...result.history.previous.slice(-(MAX_PLOT_ZOOM_HISTORY - 1)),
              ]
            : result.history.previous,
      };
      let changed = publish(context, next, bounded);
      // Native resource: ImpChart.OnZoom=ImpChartZoom; no Step callback and no
      // ImpChart.OnUndoZoom. c6ca46..93 copies only forward-zoom X into Step.
      // b5bb6d..83 invokes OnZoom +4b8; reverse b017d4 invokes +4b0 instead.
      if (context.mode === 'Impulse' && zoom.kind === 'zoom') {
        const stepContext = { slot: context.slot, mode: 'Step' as const },
          step = check(stepContext);
        changed =
          publish(
            stepContext,
            { ...step.range, timeMinMs: next.timeMinMs, timeMaxMs: next.timeMaxMs },
            history[context.slot].Step ?? { previous: [] },
          ) || changed;
      }
      if (changed) notify();
    },
  };
}
const DEFAULT_KEYS = defaultPlotRange('Magnitude');
