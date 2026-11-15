'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { FolderOpen, Download, RotateCcw, FileAudio, Plus } from 'lucide-react';
import Numeric from './Numeric';
import {
  type Preset,
  type Measurement,
  type HfdMeasurementOptions,
  type HfdProjectCalibration,
  HFD_INDEX_MIN,
  HFD_INDEX_MAX,
} from '../domain/model';
import { displayHfdCalibration, DEFAULT_HFD_MIC_SMOOTHING } from '../domain/hfd-calibration';
import { assertFileByteBudget } from '../application/file-budget';
import {
  useHfdNative,
  useBrowserMeasurement,
  updateHfdMeasurement,
  processChannelMeasurement,
  enablePresetHfdMeasurement,
  setSharedHfdCrop,
  effectiveHfdCropStart,
  hfdMeasurementStatus,
  hfdSmoothPlot,
  importChannelMeasurement,
  clearHfdCapture,
} from '../domain/hfd-measurement';
import { hfdCentering } from '../domain/hfd-response-view';
import { parseMeasurement, download } from '../domain/files';
import {
  parseImpulse,
  decodeWav,
  spectrum,
  processMeasurement,
  resetMeasurementProcessing,
  type MeasurementProcessingPatch,
  type ImpulseWindow,
} from '../domain/measurement';
import { COLORS } from './ResponsePlot';
export type MeasurementView = 'frequency' | 'phase' | 'impulse';
function Trace({
  measurement: m,
  view,
  calibrationCurve,
  window,
  onWindow,
  nativeOptions,
  centerOffsetDb = 0,
  microphone,
  contextKey,
}: {
  measurement: Measurement;
  view: MeasurementView;
  calibrationCurve: boolean;
  window: ImpulseWindow;
  onWindow: (patch: Partial<ImpulseWindow>) => void;
  nativeOptions?: HfdMeasurementOptions;
  centerOffsetDb?: number;
  microphone?: HfdProjectCalibration;
  contextKey: string;
}) {
  const [drag, setDrag] = useState<{ start: number; end: number; context: string }>();
  const gestureContext = JSON.stringify([contextKey, view]);
  useLayoutEffect(() => setDrag(undefined), [gestureContext]);
  const impulse = view === 'impulse',
    phaseSource = nativeOptions ? m.hfdPhase?.phase : m.phase,
    plotFrequency = nativeOptions && view === 'phase' ? m.hfdPhase?.frequency : m.frequency;
  let values = impulse ? m.impulse : view === 'phase' ? phaseSource : m.magnitude;
  if (nativeOptions && !impulse && values && plotFrequency) {
    const source =
      view === 'phase'
        ? values.map(
            (p) =>
              (Math.atan2(Math.sin((p * Math.PI) / 180), Math.cos((p * Math.PI) / 180)) * 180) /
              Math.PI,
          )
        : values.map((db) => db - centerOffsetDb);
    values = Array.from(hfdSmoothPlot(source, plotFrequency, nativeOptions.smoothPostBw));
  }
  if (!values?.length)
    return (
      <div className="measurement-empty">
        {impulse
          ? 'Load an impulse to inspect its original samples.'
          : 'Load a measurement to see its response.'}
      </div>
    );
  const W = 900,
    H = 420,
    L = 56,
    R = 20,
    T = 24,
    B = 38,
    n = values.length;
  const xMin = impulse ? 0 : Math.max(1, plotFrequency?.[0] ?? 10),
    xMax = impulse ? Math.max(1, n - 1) : (plotFrequency?.at(-1) ?? 24000);
  const axisX = (value: number) =>
    L +
    (impulse ? value / Math.max(1, n - 1) : Math.log(value / xMin) / Math.log(xMax / xMin)) *
      (W - L - R);
  const finite = values.filter(
    (v, i) =>
      Number.isFinite(v) &&
      (!nativeOptions ||
        impulse ||
        view !== 'frequency' ||
        (v > -199 && (plotFrequency?.[i] ?? 0) <= m.sampleRate / 2)),
  );
  let low = Infinity,
    high = -Infinity;
  for (const v of finite) {
    low = Math.min(low, v);
    high = Math.max(high, v);
  }
  if (!finite.length) {
    low = impulse ? -1 : -60;
    high = impulse ? 1 : 20;
  }
  const nativeCurve = nativeOptions && microphone?.loaded ? microphone.resource?.curve : undefined;
  const calibration =
    nativeOptions && microphone
      ? nativeCurve && plotFrequency
        ? {
            frequency: plotFrequency,
            magnitude: displayHfdCalibration(
              nativeCurve,
              plotFrequency,
              microphone.smoothingOctaves ?? DEFAULT_HFD_MIC_SMOOTHING,
            ),
          }
        : undefined
      : m.processing?.calibration;
  if (!impulse && view === 'frequency' && calibrationCurve && calibration)
    for (const v of calibration.magnitude) {
      low = Math.min(low, v);
      high = Math.max(high, v);
    }
  const padding = Math.max(impulse ? 0.05 : 6, (high - low) * 0.12);
  low -= padding;
  high += padding;
  if (!impulse) {
    low = Math.floor(low / 10) * 10;
    high = Math.ceil(high / 10) * 10;
    if (high - low < 20) {
      low -= 10;
      high += 10;
    }
  }
  const y = (value: number) => T + ((high - value) / (high - low)) * (H - T - B);
  const path = (data: number[], frequency?: number[]) => {
    const stride = Math.max(1, Math.ceil(data.length / 1400)),
      indices: number[] = [];
    for (let i = 0; i < data.length; i += stride) {
      let a = i,
        b = i;
      for (let j = i; j < Math.min(i + stride, data.length); j++) {
        if (data[j] < data[a]) a = j;
        if (data[j] > data[b]) b = j;
      }
      indices.push(...(a === b ? [a] : [a, b].sort((a, b) => a - b)));
    }
    if (indices.at(-1) !== data.length - 1) indices.push(data.length - 1);
    return indices
      .map(
        (i, j) =>
          `${j ? 'L' : 'M'}${axisX(impulse ? i : (frequency?.[i] ?? xMin)).toFixed(2)},${y(data[i]).toFixed(2)}`,
      )
      .join(' ');
  };
  const sample = (e: { clientX: number; clientY: number; currentTarget: SVGSVGElement }) => {
    const matrix = e.currentTarget.getScreenCTM();
    if (!matrix) return 0;
    const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
    return nativeOptions
      ? Math.trunc(Math.max(0, Math.min(n - 1, ((point.x - L) / (W - L - R)) * (n - 1))))
      : Math.round(Math.max(0, Math.min(n, ((point.x - L) / (W - L - R)) * n)));
  };
  const from = drag ? Math.min(drag.start, drag.end) : window.start,
    to = drag ? Math.max(drag.start, drag.end) : nativeOptions ? window.end - 1 : window.end;
  const ticks = impulse
    ? Array.from({ length: 6 }, (_, i) => (i / 5) * (n - 1))
    : [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 40000, 100000].filter(
        (f) => f >= xMin && f <= xMax,
      );
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={`measurement-response ${impulse ? 'windowable' : ''}`}
      role="img"
      aria-label={`${view === 'frequency' ? 'Processed magnitude' : view === 'phase' ? 'Processed phase' : 'Original impulse'} measurement graph`}
      onPointerDown={(e) => {
        if (!impulse || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const s = sample(e);
        setDrag({ start: s, end: s, context: gestureContext });
      }}
      onPointerMove={(e) => {
        if (drag?.context === gestureContext) setDrag({ ...drag, end: sample(e) });
      }}
      onPointerUp={(e) => {
        if (!drag) return;
        if (drag.context !== gestureContext) {
          setDrag(undefined);
          return;
        }
        const end = sample(e),
          start = Math.min(drag.start, end),
          stop = Math.max(drag.start, end);
        setDrag(undefined);
        if (stop - start >= 2)
          onWindow({ start, end: Math.min(n, stop + (nativeOptions ? 1 : 0)) });
      }}
      onPointerCancel={() => setDrag(undefined)}
      onContextMenu={(e) => {
        if (!impulse) return;
        e.preventDefault();
        onWindow({ timeZero: sample(e) });
      }}
    >
      <defs>
        <clipPath id="measurement-plot-clip">
          <rect x={L} y={T} width={W - L - R} height={H - T - B} />
        </clipPath>
      </defs>
      {Array.from({ length: 5 }, (_, i) => {
        const v = high - ((high - low) * i) / 4;
        return (
          <g key={i}>
            <path d={`M${L},${y(v)}H${W - R}`} stroke="#ffffff12" />
            <text x={L - 10} y={y(v) + 4} textAnchor="end">
              {impulse ? v.toFixed(2) : v.toFixed(0)}
            </text>
          </g>
        );
      })}
      {ticks.map((v, i) => (
        <g key={i}>
          <path d={`M${axisX(v)},${T}V${H - B}`} stroke="#ffffff0c" />
          <text x={axisX(v)} y={H - 13} textAnchor="middle">
            {impulse ? ((v / m.sampleRate) * 1000).toFixed(1) : v >= 1000 ? `${v / 1000}k` : v}
          </text>
        </g>
      ))}
      <text x={L} y={14}>
        {impulse ? 'amplitude · ms' : view === 'phase' ? 'degrees · Hz' : 'dB · Hz'}
      </text>
      <g clipPath="url(#measurement-plot-clip)">
        {impulse && (
          <>
            <rect
              x={axisX(from)}
              y={T}
              width={Math.max(0, axisX(to) - axisX(from))}
              height={H - T - B}
              fill="#b6d68016"
            />
            <path
              d={`M${axisX(from)},${T}V${H - B}M${axisX(to)},${T}V${H - B}`}
              stroke="#c1df8388"
              strokeDasharray="4 4"
            />
            <path
              d={`M${axisX(window.timeZero)},${T}V${H - B}`}
              stroke="#efb45d"
              strokeDasharray="3 3"
            />
          </>
        )}
        {!impulse && view === 'frequency' && calibrationCurve && calibration && (
          <path
            d={path(calibration.magnitude, calibration.frequency)}
            stroke="#efb45d"
            fill="none"
            strokeWidth="1.5"
            strokeDasharray="5 4"
          />
        )}
        <path d={path(values, plotFrequency)} fill="none" stroke="#c1df83" strokeWidth="1.7" />
      </g>
    </svg>
  );
}
export default function Measurements({
  preset,
  selected,
  onSelect,
  view,
  onView,
  calibrationCurve,
  onCalibrationCurve,
  edit,
  readFile,
  onError,
  nativeCentered,
  onNativeCentered,
  microphone,
  onMicrophoneLoad,
  onMicrophoneUnload,
  onMicrophoneOptions,
  captureControls,
  onMeasurementReplaced,
  contextKey,
}: {
  preset: Preset;
  selected: number;
  onSelect: (channel: number) => void;
  view: MeasurementView;
  onView: (view: MeasurementView) => void;
  calibrationCurve: boolean;
  onCalibrationCurve: (show: boolean) => void;
  edit: (fn: (p: Preset) => void) => void;
  readFile: (accept: string, fn: (text: string, name: string) => void) => void;
  onError: (error: string) => void;
  nativeCentered: boolean;
  onNativeCentered: (enabled: boolean) => void;
  microphone?: HfdProjectCalibration;
  onMicrophoneLoad: (text: string, name: string) => void;
  onMicrophoneUnload: () => void;
  onMicrophoneOptions: (patch: { showCurve?: boolean; smoothingOctaves?: number }) => void;
  captureControls?: React.ReactNode;
  onMeasurementReplaced?: () => void;
  /** Role/preset/document revision identity for commit-only processing drafts. */
  contextKey?: string | number;
}) {
  const [importRate, setImportRate] = useState(48000),
    wav = useRef<HTMLInputElement>(null),
    wavTarget = useRef<((measurement: Measurement) => void) | null>(null),
    channel = preset.channels[selected],
    m = channel.measurement,
    nativeOptions = channel.hfdMeasurement,
    center = hfdCentering(preset.channels, nativeCentered),
    nativeStatus = hfdMeasurementStatus(channel, microphone);
  const numericContext = JSON.stringify([contextKey, selected, channel.id, !!nativeOptions]);
  const window: ImpulseWindow = nativeOptions
    ? {
        start: effectiveHfdCropStart(nativeOptions),
        end: nativeOptions.stopInclusive + 1,
        taper: 0,
        timeZero: nativeOptions.phaseStart,
      }
    : (m?.processing?.window ?? {
        start: 0,
        end: m?.impulse?.length ?? 2048,
        taper: 0,
        timeZero: 0,
      });
  const attempt = (fn: () => void) => {
    try {
      fn();
      onError('');
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };
  const update = (measurement: Measurement) => {
    edit((p) => {
      importChannelMeasurement(p.channels[selected], measurement);
    });
    onMeasurementReplaced?.();
  };
  const process = (patch: MeasurementProcessingPatch) =>
    attempt(() => edit((p) => processChannelMeasurement(p.channels[selected], patch)));
  const updateNative = (patch: Partial<HfdMeasurementOptions>) =>
    attempt(() => edit((p) => updateHfdMeasurement(p.channels[selected], patch)));
  const updateWindow = (patch: Partial<ImpulseWindow>) => {
    if (nativeOptions) {
      const next: Partial<HfdMeasurementOptions> = {};
      if (patch.start !== undefined) next.localStart = patch.start;
      if (patch.end !== undefined) next.stopInclusive = patch.end - 1;
      if (patch.timeZero !== undefined) next.phaseStart = Math.trunc(patch.timeZero);
      updateNative(next);
    } else process({ window: { ...window, ...patch } });
  };
  const hasData = !!(m?.impulse?.length || m?.frequency?.length),
    cal =
      nativeOptions && microphone
        ? microphone.loaded
          ? microphone.resource?.curve
          : undefined
        : m?.processing?.calibration,
    calEnabled = nativeOptions?.applyMicCorrection ?? m?.processing?.calibrationEnabled ?? false;
  return (
    <section className="measurement-workspace" aria-label="Measurement workspace">
      <div className="measurement-main">
        <div className="measurement-heading">
          <h1>Measurements</h1>
          <span>Original data + saved processing</span>
        </div>
        {captureControls}
        <div className="measurement-channels">
          {preset.channels.map((c, i) => (
            <button
              key={c.id}
              className={selected === i ? 'active' : ''}
              onClick={() => onSelect(i)}
              style={{ '--channel-color': COLORS[i] } as React.CSSProperties}
            >
              <i />
              <strong>{c.name}</strong>
              <small>
                {c.measurement?.frequency?.length
                  ? `${c.measurement.frequency.length} points`
                  : c.measurement
                    ? 'File referenced'
                    : 'No data'}
              </small>
            </button>
          ))}
        </div>
        <div className="measurement-imports">
          <button
            onClick={() =>
              readFile('.txt,.frd,.dat', (text, name) =>
                attempt(() => {
                  const lines = text
                    .split(/\r?\n/)
                    .map((l) => l.trim())
                    .filter((l) => l && !/^[#;*]/.test(l));
                  update(
                    lines.every((l) => Number.isFinite(Number(l)))
                      ? parseImpulse(
                          text,
                          name,
                          nativeOptions?.sampleRate ?? m?.sampleRate ?? importRate,
                        )
                      : parseMeasurement(text, name),
                  );
                }),
              )
            }
          >
            <FolderOpen size={13} />
            Import text
          </button>
          <button
            onClick={() => {
              wavTarget.current = update;
              wav.current?.click();
            }}
          >
            <FileAudio size={13} />
            Import WAV
          </button>
          <button
            onClick={() =>
              attempt(() =>
                update({
                  ...spectrum(
                    [1, ...Array.from({ length: 1023 }, () => 0)],
                    nativeOptions?.sampleRate ?? m?.sampleRate ?? importRate,
                  ),
                  name: 'Flat response',
                }),
              )
            }
          >
            <Plus size={13} />
            Flat
          </button>
          <button
            disabled={!m && !nativeOptions}
            onClick={() => {
              edit((p) => {
                if (nativeOptions) clearHfdCapture(p.channels[selected], nativeOptions.sampleRate);
                else delete p.channels[selected].measurement;
              });
              onMeasurementReplaced?.();
            }}
          >
            Clear
          </button>
          <span />
          <button
            disabled={!m?.frequency?.length}
            title="Export the processed frequency response"
            onClick={() =>
              download(
                `${m!.name}.frd`,
                m!
                  .frequency!.map((f, i) =>
                    [f, m!.magnitude?.[i] ?? 0, m!.phase?.[i] ?? 0].join('\t'),
                  )
                  .join('\n'),
                'text/plain',
              )
            }
          >
            <Download size={12} />
            Response
          </button>
          <button
            disabled={!m?.impulse?.length}
            title="Export the untouched original impulse"
            onClick={() => download(`${m!.name}.dat`, m!.impulse!.join('\n'), 'text/plain')}
          >
            Impulse
          </button>
        </div>
        <input
          type="file"
          ref={wav}
          hidden
          accept=".wav"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              const apply = wavTarget.current ?? update;
              assertFileByteBudget([f]);
              apply(decodeWav(await f.arrayBuffer(), f.name));
            } catch (error) {
              onError(String(error));
            }
            e.target.value = '';
          }}
        />
        <div className="measurement-graph-card">
          <div className="plot-tabs">
            {(['frequency', 'phase', 'impulse'] as const).map((v) => (
              <button key={v} className={view === v ? 'active' : ''} onClick={() => onView(v)}>
                {v === 'frequency' ? 'Magnitude' : v === 'phase' ? 'Phase' : 'Original impulse'}
              </button>
            ))}
            <span className="measurement-graph-caption">{m?.name ?? 'No measurement'}</span>
          </div>
          {m && hasData ? (
            <Trace
              contextKey={numericContext}
              measurement={m}
              view={view}
              calibrationCurve={
                nativeOptions && microphone ? microphone.showCurve : calibrationCurve
              }
              window={window}
              onWindow={updateWindow}
              nativeOptions={nativeOptions}
              centerOffsetDb={center.offsetDb}
              microphone={microphone}
            />
          ) : (
            <div className="measurement-empty">
              <FileAudio size={30} />
              <p>
                {m
                  ? `${m.name} is referenced, but its data has not been loaded.`
                  : 'Import a driver response, or start with a flat impulse.'}
              </p>
              <small>Text impulse, frequency/dB/phase, or PCM/float WAV</small>
            </div>
          )}
          <div className="measurement-graph-footer">
            {view === 'impulse'
              ? nativeOptions
                ? 'Drag sets local crop · right-click sets independent phase start'
                : 'Drag to set the window · right-click to set time zero'
              : nativeOptions
                ? view === 'phase'
                  ? 'Independent phase crop → Gaussian display smoothing'
                  : `Native crop → correction → Gaussian display · ${center.centered ? 'common-centered' : 'absolute'} dB`
                : 'Window → microphone correction → smoothing'}
            <span>
              {m
                ? `${m.sampleRate.toLocaleString()} Hz · ${m.impulse?.length ?? 0} original samples`
                : ''}
            </span>
          </div>
        </div>
        <p className="measurement-note">
          Processing changes are saved with the project and support Undo. The impulse view and DAT
          export retain the original samples.
        </p>
      </div>
      <aside
        className={`measurement-inspector ${nativeOptions ? 'native-measurement-inspector' : ''}`}
        aria-label="Measurement processing inspector"
      >
        <div className="panel-heading">
          <h2>{preset.channels[selected].name} processing</h2>
          <button
            disabled={!hasData}
            onClick={() =>
              nativeOptions
                ? process({ window: null, smoothingOctaves: 0, calibration: null })
                : attempt(() =>
                    edit((p) => {
                      p.channels[selected].measurement = resetMeasurementProcessing(m!);
                    }),
                  )
            }
            title="Reset window, correction and smoothing"
          >
            <RotateCcw size={12} />
            {nativeOptions ? 'Reset processing' : 'Reset all'}
          </button>
        </div>
        <div className="field-label analysis-mode-field">
          <span>Analysis</span>
          <select
            aria-label="Measurement analysis engine"
            value={nativeOptions ? 'hfd' : 'browser'}
            onChange={(e) =>
              attempt(() =>
                edit((p) =>
                  e.target.value === 'hfd'
                    ? useHfdNative(p.channels[selected])
                    : useBrowserMeasurement(p.channels[selected]),
                ),
              )
            }
          >
            <option value="browser">Browser window</option>
            <option value="hfd">HFD model</option>
          </select>
          {nativeOptions && !preset.channels.every((c) => c.hfdMeasurement) && (
            <button
              type="button"
              onClick={() => attempt(() => edit((p) => enablePresetHfdMeasurement(p)))}
            >
              All outputs
            </button>
          )}
        </div>
        <Numeric
          contextKey={numericContext}
          label="Sample rate"
          value={nativeOptions?.sampleRate ?? m?.sampleRate ?? importRate}
          unit="Hz"
          min={nativeOptions ? 1000 : 8000}
          max={nativeOptions ? 100000 : 384000}
          step={1000}
          commitOnly
          onChange={(rate) =>
            attempt(() => {
              setImportRate(rate);
              if (nativeOptions) {
                updateNative({ sampleRate: rate });
                return;
              }
              if (m)
                edit((p) => {
                  p.channels[selected].measurement = m.impulse
                    ? processMeasurement(
                        { ...m, sampleRate: rate },
                        {
                          window: m.processing?.window ?? {
                            start: 0,
                            end: m.impulse.length,
                            taper: 0,
                            timeZero: 0,
                          },
                        },
                      )
                    : { ...m, sampleRate: rate };
                });
            })
          }
        />
        {nativeOptions ? (
          <div className="processing-section native-crop-controls">
            <div className="section-label">
              CROP & PHASE{' '}
              <button
                onClick={() =>
                  updateNative({ localStart: 0, stopInclusive: 65535, phaseStart: -1 })
                }
              >
                Reset local
              </button>
            </div>
            <div className="processing-window-fields">
              <Numeric
                contextKey={numericContext}
                label="Local start"
                value={nativeOptions.localStart}
                min={HFD_INDEX_MIN}
                max={HFD_INDEX_MAX}
                step={1}
                precision={0}
                commitOnly
                onChange={(localStart) => updateNative({ localStart: Math.trunc(localStart) })}
              />
              <Numeric
                contextKey={numericContext}
                label="Inclusive stop"
                value={nativeOptions.stopInclusive}
                min={HFD_INDEX_MIN}
                max={HFD_INDEX_MAX}
                step={1}
                precision={0}
                commitOnly
                onChange={(stopInclusive) =>
                  updateNative({ stopInclusive: Math.trunc(stopInclusive) })
                }
              />
              <Numeric
                contextKey={numericContext}
                label="Phase start"
                value={nativeOptions.phaseStart}
                min={HFD_INDEX_MIN}
                max={HFD_INDEX_MAX}
                step={1}
                precision={0}
                commitOnly
                onChange={(phaseStart) => updateNative({ phaseStart: Math.trunc(phaseStart) })}
              />
              <Numeric
                contextKey={numericContext}
                label="Effective start"
                value={effectiveHfdCropStart(nativeOptions)}
                precision={0}
                disabled
                onChange={() => {}}
              />
            </div>
            <div className="native-phase-actions">
              <button
                aria-label="Move phase start back one sample"
                onClick={() =>
                  updateNative({
                    phaseStart: Math.max(HFD_INDEX_MIN, nativeOptions.phaseStart - 1),
                  })
                }
              >
                −1 sample
              </button>
              <button
                aria-label="Move phase start forward one sample"
                onClick={() =>
                  updateNative({
                    phaseStart: Math.min(HFD_INDEX_MAX, nativeOptions.phaseStart + 1),
                  })
                }
              >
                +1 sample
              </button>
              <button
                disabled={!m?.impulse?.length}
                onClick={() => {
                  let peak = 0;
                  m!.impulse!.forEach((x, i) => {
                    if (Math.abs(x) > Math.abs(m!.impulse![peak])) peak = i;
                  });
                  updateNative({ phaseStart: peak });
                }}
              >
                At peak
              </button>
            </div>
            <p className="hint">
              Phase −1 uses original sample 0; phase crop is independent of magnitude crop.
            </p>
            <label className="toggle-label">
              <input
                aria-label="Share this channel's effective crop start"
                type="checkbox"
                checked={nativeOptions.sharedGroupId === selected + 1}
                disabled={!preset.channels.every((c) => c.hfdMeasurement)}
                onChange={(e) =>
                  attempt(() =>
                    edit((p) => setSharedHfdCrop(p, e.target.checked ? selected : null)),
                  )
                }
              />
              <span className="switch" />
              Share this start with preset
            </label>
            <p className="hint shared-crop-context">
              {nativeOptions.sharedGroupId === -1
                ? 'Using local crop start.'
                : `Shared snapshot: output ${nativeOptions.sharedGroupId} · sample ${nativeOptions.sharedStart}. Local values are retained.`}
            </p>
          </div>
        ) : (
          <>
            <div className="processing-section">
              <div className="section-label">
                IMPULSE WINDOW{' '}
                <button disabled={!m?.impulse} onClick={() => process({ window: null })}>
                  Reset
                </button>
              </div>
              <div className="processing-window-fields">
                {(
                  [
                    {
                      key: 'start',
                      label: 'Start sample',
                      min: 0,
                      max: Math.max(0, window.end - 1),
                      step: 1,
                    },
                    {
                      key: 'end',
                      label: 'End sample',
                      min: window.start + 1,
                      max: m?.impulse?.length ?? 2048,
                      step: 1,
                    },
                    { key: 'timeZero', label: 'Time-zero sample', step: 1 },
                    { key: 'taper', label: 'Taper fraction', min: 0, max: 1, step: 0.05 },
                  ] as const
                ).map((f) => (
                  <Numeric
                    key={f.key}
                    contextKey={numericContext}
                    label={f.label}
                    value={window[f.key]}
                    min={'min' in f ? f.min : undefined}
                    max={'max' in f ? f.max : undefined}
                    step={f.step}
                    precision={3}
                    commitOnly
                    disabled={!m?.impulse}
                    onChange={(value) => updateWindow({ [f.key]: value })}
                  />
                ))}
              </div>
              <button
                className="full-width"
                disabled={!m?.impulse?.length}
                onClick={() => {
                  let peak = 0;
                  m!.impulse!.forEach((x, i) => {
                    if (Math.abs(x) > Math.abs(m!.impulse![peak])) peak = i;
                  });
                  updateWindow({ timeZero: peak });
                }}
              >
                Time zero at impulse peak
              </button>
              <p className="hint">
                {m?.impulse
                  ? `${(((window.end - window.start) / m.sampleRate) * 1000).toFixed(2)} ms window · ${((window.timeZero / m.sampleRate) * 1000).toFixed(2)} ms time zero`
                  : 'Windowing requires an impulse response.'}
              </p>
            </div>
          </>
        )}
        {nativeOptions ? (
          <div className="processing-section native-smoothing-controls">
            <div className="section-label">GAUSSIAN DISPLAY</div>
            <label className="field-label">
              Graph width
              <select
                aria-label="Native graph smoothing"
                value={
                  [0.0001, 1, 1 / 3, 1 / 6, 1 / 12, 1 / 24].includes(nativeOptions.smoothPostBw)
                    ? nativeOptions.smoothPostBw
                    : 'custom'
                }
                onChange={(e) => {
                  if (e.target.value !== 'custom')
                    updateNative({ smoothPostBw: Number(e.target.value) });
                }}
              >
                <option value={1}>1 octave</option>
                <option value={1 / 3}>1/3 octave</option>
                <option value={1 / 6}>1/6 octave</option>
                <option value={1 / 12}>1/12 octave</option>
                <option value={1 / 24}>1/24 octave</option>
                <option value={0.0001}>None</option>
                <option value="custom" disabled>
                  User
                </option>
              </select>
            </label>
            <div className="processing-window-fields">
              <Numeric
                contextKey={numericContext}
                label="Pre width"
                value={nativeOptions.smoothBw}
                min={0}
                max={3}
                step={0.001}
                precision={4}
                commitOnly
                onChange={(smoothBw) => updateNative({ smoothBw })}
              />
              <Numeric
                contextKey={numericContext}
                label="Post width"
                value={nativeOptions.smoothPostBw}
                min={0}
                max={10}
                step={1 / 24}
                precision={4}
                commitOnly
                onChange={(smoothPostBw) => updateNative({ smoothPostBw })}
              />
            </div>
            <label className="toggle-label">
              <input
                aria-label="Native common magnitude centering"
                type="checkbox"
                checked={center.centered}
                disabled={!center.available}
                onChange={(e) => onNativeCentered(e.target.checked)}
              />
              <span className="switch" />
              Common magnitude centering
            </label>
          </div>
        ) : (
          <>
            <div className="processing-section">
              <div className="section-label">SMOOTHING</div>
              <label className="field-label">
                Octave width
                <select
                  aria-label="Measurement smoothing"
                  value={
                    [0, 1 / 24, 1 / 12, 1 / 6, 1 / 3, 1 / 2, 1].includes(
                      m?.processing?.smoothingOctaves ?? 0,
                    )
                      ? (m?.processing?.smoothingOctaves ?? 0)
                      : 'custom'
                  }
                  disabled={!hasData}
                  onChange={(e) => {
                    if (e.target.value !== 'custom')
                      process({ smoothingOctaves: Number(e.target.value) });
                  }}
                >
                  {[0, 1 / 24, 1 / 12, 1 / 6, 1 / 3, 1 / 2, 1].map((v) => (
                    <option key={v} value={v}>
                      {v === 0 ? 'None' : v === 1 ? '1 octave' : `1/${Math.round(1 / v)} octave`}
                    </option>
                  ))}
                  <option value="custom" disabled>
                    Custom width
                  </option>
                </select>
              </label>
              <Numeric
                contextKey={numericContext}
                label="Octaves"
                value={m?.processing?.smoothingOctaves ?? 0}
                min={0}
                max={3}
                step={1 / 24}
                precision={4}
                disabled={!hasData}
                commitOnly
                onChange={(smoothingOctaves) => process({ smoothingOctaves })}
              />
            </div>
          </>
        )}
        <div className="processing-section">
          <div className="section-label">MICROPHONE CORRECTION</div>
          <div className="processing-calibration-actions">
            <button
              disabled={!nativeOptions && !hasData}
              onClick={() =>
                readFile(nativeOptions ? '.txt,.dat' : '.txt,.dat,.frd,.cal', (text, name) => {
                  if (nativeOptions) {
                    attempt(() => onMicrophoneLoad(text, name));
                    return;
                  }
                  const parsed = parseMeasurement(text, name);
                  if (!parsed.frequency?.length || !parsed.magnitude?.length)
                    throw new Error('Load a frequency/dB microphone correction file');
                  process({
                    calibration: {
                      name: parsed.name,
                      sampleRate: parsed.sampleRate,
                      frequency: parsed.frequency,
                      magnitude: parsed.magnitude,
                      phase: parsed.phase,
                    },
                    calibrationEnabled: true,
                  });
                })
              }
            >
              <FolderOpen size={12} />
              {cal ? 'Replace file' : 'Load file'}
            </button>
            <button
              disabled={nativeOptions ? !cal && !microphone?.filename : !cal}
              onClick={() =>
                nativeOptions ? attempt(onMicrophoneUnload) : process({ calibration: null })
              }
            >
              Unload
            </button>
          </div>
          <p
            className="calibration-filename"
            title={nativeOptions ? microphone?.filename || cal?.name : cal?.name}
          >
            {(nativeOptions ? microphone?.filename || cal?.name : cal?.name) ||
              'No correction file loaded'}
          </p>
          <label className="toggle-label">
            <input
              type="checkbox"
              checked={calEnabled}
              aria-label="Apply microphone correction"
              disabled={!nativeOptions && !cal}
              onChange={(e) =>
                nativeOptions
                  ? updateNative({ applyMicCorrection: e.target.checked })
                  : process({ calibrationEnabled: e.target.checked })
              }
            />
            <span className="switch" />
            Apply correction
          </label>
          <label className="toggle-label">
            <input
              type="checkbox"
              aria-label="Show microphone correction curve"
              checked={nativeOptions && microphone ? microphone.showCurve : calibrationCurve}
              disabled={!cal}
              onChange={(e) =>
                nativeOptions && microphone
                  ? attempt(() => onMicrophoneOptions({ showCurve: e.target.checked }))
                  : onCalibrationCurve(e.target.checked)
              }
            />
            <span className="switch" />
            Show correction curve
          </label>
          {nativeOptions && (
            <Numeric
              contextKey={numericContext}
              label="Correction width"
              value={microphone?.smoothingOctaves ?? DEFAULT_HFD_MIC_SMOOTHING}
              min={0}
              max={3}
              step={0.001}
              precision={4}
              commitOnly
              disabled={!microphone}
              onChange={(smoothingOctaves) =>
                attempt(() => onMicrophoneOptions({ smoothingOctaves }))
              }
            />
          )}
        </div>
        {nativeOptions && (
          <p
            className="native-analysis-status"
            role="status"
            title={nativeStatus.warnings.join('\n')}
          >
            {nativeOptions.applyMicCorrection
              ? cal
                ? microphone?.resource
                  ? 'Project correction · magnitude-derived phase. Native GUI comparison pending.'
                  : 'Legacy browser curve · load a project microphone file for HFD processing.'
                : 'Native correction requested · load a correction file.'
              : 'Static HFD model · native GUI comparison pending.'}
          </p>
        )}
      </aside>
    </section>
  );
}
