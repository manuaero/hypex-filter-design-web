'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Channel, type Preset, type Filter } from '../domain/model';
import ResponsePlot, { type PlotMode } from './ResponsePlot';
import { layoutFilterHandles } from './filter-handle-layout';
import {
  rectangleZoom,
  applyRectangleZoom,
  type ZoomAxes,
  type RectangleZoomHistory,
  type RectangleZoom,
} from './plot-zoom-geometry';
import { defaultPlotRange, type PlotRange } from '../domain/plot-viewport';
export { DEFAULT_RANGE, type PlotRange } from '../domain/plot-viewport';
import type { MagnitudeLayers } from '../domain/plot-layers';
import type { PhaseViewState } from '../application/graph-view';
const gainType = (f: Filter) => f.kind === 'peak' || f.kind.includes('shelf');
const qType = (f: Filter) =>
  !['unity', 'raw', 'lowpass1', 'highpass1', 'allpass1', 'lowshelf1', 'highshelf1'].includes(
    f.kind,
  );
export default function InteractivePlot({
  channels,
  preset,
  mode,
  sum,
  measured,
  gainLimit = 60,
  nativeCentered = true,
  showUnloadedFilters = false,
  magnitudeLayers,
  phaseLayers,
  selectedFilter,
  activeChannel,
  activeFilter,
  range,
  onRange,
  onRectangleZoom,
  onResetRange,
  onRangeGestureStart,
  onRangeGestureCommit,
  onRangeGestureCancel,
  contextKey,
  onSelect,
  onChange,
  onAdd,
  onRemove,
  onToggle,
  begin,
  end,
}: {
  channels: Channel[];
  preset?: Preset;
  mode: PlotMode;
  sum: boolean;
  measured: boolean;
  gainLimit?: number;
  nativeCentered?: boolean;
  showUnloadedFilters?: boolean;
  magnitudeLayers?: MagnitudeLayers;
  phaseLayers?: PhaseViewState;
  selectedFilter?: number | null;
  activeChannel: number;
  activeFilter: number;
  range: PlotRange;
  onRange: (range: PlotRange) => void;
  onRectangleZoom?: (zoom: RectangleZoom, capturedRange: Readonly<PlotRange>) => void;
  onResetRange?: () => void;
  /** Background-only view gestures. Commit follows the final synchronous
   * onRange/onRectangleZoom call, including a plain click or reverse rectangle.
   * Filter edits, cancellation, unmount and stale contexts never commit a view. */
  onRangeGestureStart?: (kind: 'pan' | 'zoom') => void;
  onRangeGestureCommit?: () => void;
  onRangeGestureCancel?: () => void;
  contextKey?: string;
  onSelect: (index: number) => void;
  onChange: (patch: Partial<Filter>) => void;
  onAdd: (frequency: number) => void;
  onRemove: () => void;
  onToggle: () => void;
  begin: () => void;
  end: (cancel?: boolean) => void;
}) {
  const element = useRef<HTMLDivElement>(null),
    [size, setSize] = useState({ width: 800, height: 330 }),
    [cursor, setCursor] = useState(''),
    [menu, setMenu] = useState<{ x: number; y: number; frequency: number; matches: number[] }>();
  const drag = useRef<
    | {
        kind: 'filter' | 'pan' | 'zoom';
        x: number;
        y: number;
        mode: PlotMode;
        contextKey?: string;
        filter?: Filter;
        range: PlotRange;
        commitRange?: () => void;
        cancelRange?: () => void;
      }
    | undefined
  >(undefined);
  const zoomHistory = useRef<Partial<Record<PlotMode, RectangleZoomHistory>>>({});
  useEffect(() => {
    setMenu(undefined);
    setCursor('');
    return () => {
      if (drag.current?.kind === 'filter') end(true);
      else drag.current?.cancelRange?.();
      drag.current = undefined;
    };
  }, [contextKey, mode]);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const resize = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const channel = channels[activeChannel],
    editable = channel?.linkedTo === undefined,
    filter = channel?.filters[activeFilter],
    timed = mode === 'Impulse' || mode === 'Step';
  const L = 48,
    R = 20,
    T = 24,
    B = 38,
    W = size.width - L - R,
    H = size.height - T - B;
  const frequency = (x: number) =>
    Math.max(
      0.001,
      Math.min(
        50000,
        range.frequencyMin * (range.frequencyMax / range.frequencyMin) ** ((x - L) / W),
      ),
    );
  const timeAt = (x: number, r = range) =>
    r.timeMinMs + ((x - L) / W) * (r.timeMaxMs - r.timeMinMs);
  const position = (f: Filter) => ({
    x:
      L +
      (Math.log(f.frequency / range.frequencyMin) /
        Math.log(range.frequencyMax / range.frequencyMin)) *
        W,
    y: T + ((range.dbMax - (gainType(f) ? f.gain : 0)) / (range.dbMax - range.dbMin)) * H,
  });
  const handles = useMemo(
    () =>
      W > 0 && H > 0
        ? layoutFilterHandles(
            channel?.filters.flatMap((f, index) => {
              if (f.kind === 'unity' || f.kind === 'raw') return [];
              const p = position(f);
              return p.x < L || p.x > size.width - R || p.y < T || p.y > size.height - B
                ? []
                : [{ index, ...p }];
            }) ?? [],
            { left: L, right: size.width - R, top: T, bottom: size.height - B },
          )
        : [],
    [channel?.filters, range, size.width, size.height],
  );
  const point = (e: { clientX: number; clientY: number }) => {
    const r = element.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const matching = (x: number, y: number) =>
    handles.flatMap((p) =>
      Math.hypot(x - p.x, y - p.y) < 13 || Math.hypot(x - p.anchorX, y - p.anchorY) < 13
        ? [p.index]
        : [],
    );
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const wheel = (e: WheelEvent) => {
      const handle = (e.target as Element).closest<HTMLElement>('[data-filter]');
      if (timed) {
        e.preventDefault();
        const { x, y } = point(e),
          scale = Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.002)));
        if (e.shiftKey) {
          const anchor =
              range.amplitudeMax - ((y - T) / H) * (range.amplitudeMax - range.amplitudeMin),
            span = Math.max(
              1e-9,
              Math.min(1e12, (range.amplitudeMax - range.amplitudeMin) * scale),
            ),
            fraction = Math.max(0, Math.min(1, (y - T) / H));
          onRange({
            ...range,
            amplitudeMax: anchor + fraction * span,
            amplitudeMin: anchor - (1 - fraction) * span,
          });
        } else {
          const anchor = timeAt(x),
            span = Math.max(0.001, Math.min(600000, (range.timeMaxMs - range.timeMinMs) * scale)),
            fraction = Math.max(0, Math.min(1, (x - L) / W));
          onRange({
            ...range,
            timeMinMs: anchor - fraction * span,
            timeMaxMs: anchor + (1 - fraction) * span,
          });
        }
        return;
      }
      if (!handle || !editable || timed) return;
      e.preventDefault();
      const index = Number(handle.dataset.filter);
      if (index !== activeFilter) {
        onSelect(index);
        return;
      }
      if (filter && qType(filter))
        onChange({
          q: Math.max(0.001, Math.min(100, filter.q * (e.deltaY > 0 ? 1 / 1.06 : 1.06))),
        });
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [filter, activeFilter, onSelect, onChange, editable, timed, range, onRange, W, H]);
  return (
    <div
      className="interactive-plot"
      ref={element}
      onPointerMove={(e) => {
        const { x, y } = point(e),
          f = frequency(x);
        setCursor(
          timed
            ? `${timeAt(x).toFixed(3)} ms · ${(range.amplitudeMax - ((y - T) / H) * (range.amplitudeMax - range.amplitudeMin)).toPrecision(4)}`
            : `${f.toFixed(f < 100 ? 1 : 0)} Hz · ${(range.dbMax - ((y - T) / H) * (range.dbMax - range.dbMin)).toFixed(2)} ${mode === 'Phase' ? '°' : mode === 'Group delay' ? 'ms' : 'dB'}`,
        );
        const d = drag.current;
        if (!d) return;
        if (d.mode !== mode || d.contextKey !== contextKey) return;
        if (d.kind === 'filter' && d.filter) {
          if (e.ctrlKey && qType(d.filter))
            onChange({ q: Math.max(0.001, Math.min(100, d.filter.q * Math.exp((d.y - y) / 100))) });
          else
            onChange({
              frequency: Math.max(
                0.001,
                Math.min(
                  50000,
                  d.filter.frequency *
                    (d.range.frequencyMax / d.range.frequencyMin) ** ((x - d.x) / W),
                ),
              ),
              ...(gainType(d.filter)
                ? {
                    gain: Math.max(
                      -gainLimit,
                      Math.min(
                        gainLimit,
                        d.filter.gain + ((d.y - y) / H) * (range.dbMax - range.dbMin),
                      ),
                    ),
                  }
                : {}),
            });
        } else if (d.kind === 'pan') {
          if (timed) {
            const dt = -((x - d.x) / W) * (d.range.timeMaxMs - d.range.timeMinMs),
              da = ((y - d.y) / H) * (d.range.amplitudeMax - d.range.amplitudeMin);
            onRange({
              ...d.range,
              timeMinMs: d.range.timeMinMs + dt,
              timeMaxMs: d.range.timeMaxMs + dt,
              amplitudeMin: d.range.amplitudeMin + da,
              amplitudeMax: d.range.amplitudeMax + da,
            });
            return;
          }
          const delta = ((y - d.y) / H) * (d.range.dbMax - d.range.dbMin);
          onRange({ ...d.range, dbMin: d.range.dbMin + delta, dbMax: d.range.dbMax + delta });
        }
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d) return;
        if (d.mode !== mode || d.contextKey !== contextKey) {
          if (d.kind === 'filter') end(true);
          else d.cancelRange?.();
          drag.current = undefined;
          return;
        }
        const { x, y } = point(e);
        if (d.kind === 'filter') {
          end();
        }
        if (d.kind === 'zoom' && W > 0 && H > 0) {
          const axes: ZoomAxes = timed
              ? {
                  xMin: d.range.timeMinMs,
                  xMax: d.range.timeMaxMs,
                  yMin: d.range.amplitudeMin,
                  yMax: d.range.amplitudeMax,
                  xScale: 'linear',
                }
              : {
                  xMin: d.range.frequencyMin,
                  xMax: d.range.frequencyMax,
                  yMin: d.range.dbMin,
                  yMax: d.range.dbMax,
                  xScale: 'logarithmic',
                },
            zoom = rectangleZoom(
              axes,
              { x: d.x, y: d.y },
              { x, y },
              { left: L, top: T, width: W, height: H },
            ),
            history = zoomHistory.current[mode] ?? { previous: [] },
            result = applyRectangleZoom(history, axes, zoom, mode !== 'Impulse');
          if (onRectangleZoom) onRectangleZoom(zoom, d.range);
          else if (result.axes) {
            const frequencyMin = Math.max(0.001, Math.min(50000, result.axes.xMin)),
              frequencyMax = Math.max(0.001, Math.min(50000, result.axes.xMax));
            if (timed || frequencyMin < frequencyMax) {
              zoomHistory.current[mode] = result.history;
              onRange(
                timed
                  ? {
                      ...d.range,
                      timeMinMs: result.axes.xMin,
                      timeMaxMs: result.axes.xMax,
                      amplitudeMin: result.axes.yMin,
                      amplitudeMax: result.axes.yMax,
                    }
                  : {
                      ...d.range,
                      frequencyMin,
                      frequencyMax,
                      dbMin: result.axes.yMin,
                      dbMax: result.axes.yMax,
                    },
              );
            }
          }
        }
        drag.current = undefined;
        if (d.kind !== 'filter') d.commitRange?.();
      }}
      onPointerCancel={() => {
        if (drag.current?.kind === 'filter') end(true);
        else drag.current?.cancelRange?.();
        drag.current = undefined;
      }}
    >
      <ResponsePlot
        channels={channels}
        preset={preset}
        mode={mode}
        sum={sum}
        measured={measured}
        range={range}
        referenceChannel={activeChannel}
        nativeCentered={nativeCentered}
        showUnloadedFilters={showUnloadedFilters}
        magnitudeLayers={magnitudeLayers}
        phaseLayers={phaseLayers}
        selectedFilter={selectedFilter}
      />
      <div
        className="plot-interaction"
        onContextMenu={(e) => {
          e.preventDefault();
          if (timed || mode !== 'Magnitude') return;
          const { x, y } = point(e);
          setMenu({ x, y, frequency: frequency(x), matches: matching(x, y) });
        }}
        onDoubleClick={(e) => {
          if (editable && mode === 'Magnitude') onChange({ frequency: frequency(point(e).x) });
        }}
        onPointerDown={(e) => {
          if ((e.target as Element).closest('button')) return;
          setMenu(undefined);
          const { x, y } = point(e);
          if (e.button === 0 || e.button === 1) {
            e.preventDefault();
            onRangeGestureStart?.(e.button === 1 ? 'zoom' : 'pan');
            drag.current = {
              kind: e.button === 1 ? 'zoom' : 'pan',
              x,
              y,
              mode,
              contextKey,
              range,
              commitRange: onRangeGestureCommit,
              cancelRange: onRangeGestureCancel,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }
        }}
      >
        {mode === 'Magnitude' && (
          <svg className="filter-handle-leaders" aria-hidden="true">
            {handles.map((p) =>
              p.x === p.anchorX && p.y === p.anchorY ? null : (
                <line key={p.index} x1={p.anchorX} y1={p.anchorY} x2={p.x} y2={p.y} />
              ),
            )}
          </svg>
        )}
        {mode === 'Magnitude' &&
          handles.map(({ index: i, x, y }) => {
            const f = channel.filters[i];
            return (
              <button
                key={f.id}
                data-filter={i}
                aria-label={`Graph filter ${i + 1}: ${f.kind}`}
                aria-pressed={i === activeFilter}
                aria-controls="selected-filter-inspector"
                title={`BQ ${i + 1} · ${f.frequency.toFixed(1)} Hz · Q ${f.q.toFixed(3)}${editable ? ' · drag frequency/gain, Ctrl-drag or wheel Q' : ' · linked to master'}`}
                className={`filter-handle ${i === activeFilter ? 'selected' : ''} ${f.enabled ? '' : 'bypassed'} ${f.kind.startsWith('lowpass') ? 'lowpass' : f.kind.startsWith('highpass') ? 'highpass' : 'other'}`}
                style={{ left: x, top: y }}
                onClick={(e) => {
                  if (e.detail === 0) onSelect(i);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  e.preventDefault();
                  onSelect(i);
                  setMenu(undefined);
                  if (editable) {
                    begin();
                    drag.current = {
                      kind: 'filter',
                      mode,
                      contextKey,
                      x: e.clientX - element.current!.getBoundingClientRect().left,
                      y: e.clientY - element.current!.getBoundingClientRect().top,
                      filter: { ...f },
                      range,
                    };
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }
                }}
              >
                {i + 1}
              </button>
            );
          })}
      </div>
      <span className="interactive-cursor">{cursor}</span>
      {menu && (
        <div
          className="plot-menu"
          style={{
            left: Math.max(0, Math.min(menu.x, size.width - 230)),
            top: Math.max(6, Math.min(menu.y, size.height - Math.min(360, size.height - 12) - 6)),
          }}
        >
          {menu.matches.map((i) => (
            <button
              key={i}
              onClick={() => {
                onSelect(i);
                setMenu(undefined);
              }}
            >
              Select BQ {i + 1} · {channel.filters[i].kind}
            </button>
          ))}
          <button
            disabled={!editable}
            onClick={() => {
              onAdd(menu.frequency);
              setMenu(undefined);
            }}
          >
            Add Boost/Cut · {menu.frequency.toFixed(0)} Hz
          </button>
          {filter?.kind !== 'unity' && (
            <>
              <button
                disabled={!editable}
                onClick={() => {
                  onToggle();
                  setMenu(undefined);
                }}
              >
                {filter?.enabled ? 'Bypass' : 'Enable'} selected filter
              </button>
              <button
                disabled={!editable}
                onClick={() => {
                  onRemove();
                  setMenu(undefined);
                }}
              >
                Delete selected filter
              </button>
            </>
          )}
          <button
            onClick={() => {
              if (onResetRange) onResetRange();
              else {
                delete zoomHistory.current[mode];
                onRange(defaultPlotRange(mode));
              }
              setMenu(undefined);
            }}
          >
            Reset graph view
          </button>
          <button onClick={() => setMenu(undefined)}>Close menu</button>
        </div>
      )}
    </div>
  );
}
