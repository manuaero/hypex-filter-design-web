'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, X, SlidersHorizontal } from 'lucide-react';
import { type Filter, type FilterKind, type Preset } from '../domain/model';
import { design, response, presetResponse, encodeChannel, FILTER_NAMES } from '../domain/dsp';
import Numeric from './Numeric';
import { isManualFilterParameterActive } from '../domain/editing';
import { normalizeHfdManualFrequencyText } from '../domain/manual-frequency';
import {
  normalizeHfdManualQText,
  normalizeHfdManualGainText,
  formatHfdManualQValue,
  formatHfdManualGainValue,
  HFD_MANUAL_Q_BOUNDS,
  HFD_MANUAL_GAIN_BOUNDS,
} from '../domain/manual-parameter';

export const FILTER_LABELS: Record<FilterKind, string> = {
  unity: 'Empty section',
  lowpass1: 'Low-pass',
  lowpass2: 'Low-pass',
  highpass1: 'High-pass',
  highpass2: 'High-pass',
  peak: 'Bell',
  lowshelf1: 'Low shelf',
  lowshelf2: 'Low shelf',
  highshelf1: 'High shelf',
  highshelf2: 'High shelf',
  asymmetric: 'Asymmetric shelf',
  allpass1: 'All-pass',
  allpass2: 'All-pass',
  raw: 'Custom coefficients',
};
const family = (kind: FilterKind) =>
  kind.includes('pass') && !kind.startsWith('all')
    ? 'Crossover'
    : kind.startsWith('all')
      ? 'Phase'
      : kind === 'raw'
        ? 'Advanced'
        : 'EQ';
export const hasQ = (kind: FilterKind) => isManualFilterParameterActive({ kind }, 'q');
export const hasGain = (kind: FilterKind) => isManualFilterParameterActive({ kind }, 'gain');
export function FilterGlyph({ kind, className = '' }: { kind: FilterKind; className?: string }) {
  let path = '';
  try {
    const filter = {
        id: 'glyph',
        kind,
        enabled: true,
        frequency: 1000,
        q: 0.707,
        gain: 6,
        frequency2: 2200,
        q2: 0.707,
        coefficients: kind === 'raw' ? { b0: 1, b1: 0, b2: 0, f1: 0, f2: 0 } : undefined,
      },
      c = design(filter);
    path = Array.from({ length: 70 }, (_, i) => {
      const f = 30 * (20000 / 30) ** (i / 69),
        [r, im] = response(c, f),
        value = kind.startsWith('allpass')
          ? (Math.atan2(im, r) * 180) / Math.PI / 12
          : 20 * Math.log10(Math.max(1e-12, Math.hypot(r, im)));
      return `${i ? 'L' : 'M'}${4 + (i / 69) * 88},${Math.max(4, Math.min(42, 28 - value * 1.8))}`;
    }).join(' ');
  } catch {}
  return (
    <svg viewBox="0 0 96 48" className={`filter-glyph ${className}`} aria-hidden="true">
      <path d="M4 28H92 M48 5V43" stroke="currentColor" strokeOpacity=".13" fill="none" />
      <path d={path} stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
    </svg>
  );
}
const choices = {
  Crossover: [
    { title: 'Low-pass', description: 'Let the lows through', kinds: ['lowpass1', 'lowpass2'] },
    { title: 'High-pass', description: 'Let the highs through', kinds: ['highpass1', 'highpass2'] },
  ],
  EQ: [
    { title: 'Bell', description: 'Shape a focused band', kinds: ['peak'] },
    {
      title: 'Low shelf',
      description: 'Lift or lower the bass',
      kinds: ['lowshelf1', 'lowshelf2'],
    },
    {
      title: 'High shelf',
      description: 'Shape the upper range',
      kinds: ['highshelf1', 'highshelf2'],
    },
    { title: 'Asymmetric', description: 'Independent poles and zeros', kinds: ['asymmetric'] },
  ],
  Phase: [
    {
      title: 'All-pass',
      description: 'Shift phase while keeping level',
      kinds: ['allpass1', 'allpass2'],
    },
  ],
  Advanced: [{ title: 'Custom', description: 'Enter five exact coefficients', kinds: ['raw'] }],
} as const;
export default function FilterPalette({
  mode,
  draft,
  onDraft,
  preset,
  channelIndex,
  sectionIndex,
  targets,
  onApply,
  onClose,
  eq = false,
  failure = '',
  frequencyMaximum = 40000,
}: {
  mode: 'add' | 'replace';
  draft: Filter;
  onDraft: (patch: Partial<Filter>) => void;
  preset: Preset;
  channelIndex: number;
  sectionIndex: number;
  targets: string[];
  onApply: () => void;
  onClose: () => void;
  eq?: boolean;
  failure?: string;
  frequencyMaximum?: number;
}) {
  const parameterContext = JSON.stringify([draft.id, draft.kind, eq, targets]);
  const [previewContext, setPreviewContext] = useState<'section' | 'driver'>('section'),
    phaseMode = draft.kind.startsWith('allpass'),
    axisMax = phaseMode ? 180 : 20,
    axisMin = phaseMode ? -360 : -60;
  const dialog = useRef<HTMLDialogElement>(null),
    [category, setCategory] = useState<string>(eq ? 'EQ' : family(draft.kind));
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  useEffect(() => {
    if (draft.kind !== 'unity') setCategory(eq ? 'EQ' : family(draft.kind));
  }, [draft.kind, eq]);
  const preview = useMemo(() => {
    try {
      const source = preset.channels[channelIndex],
        after = {
          ...source,
          filters: source.filters.map((f, i) => (i === sectionIndex ? { ...draft } : f)),
        };
      if (eq) {
        after.filters = [
          ...preset.inputEq.map((f, i) => (i === sectionIndex ? { ...draft } : f)),
          ...source.filters.slice(9).map((f) => ({ ...f, kind: 'unity' as const, enabled: false })),
        ];
        after.gain = 0;
        after.additionalGain = 0;
        after.muted = false;
        after.invert = false;
      }
      if (sectionIndex === 0 && !draft.provenance) after.coefficientCache = 'base';
      if (eq) {
        after.coefficientCache = 'base';
        after.delayUs = 0;
        after.globalDelayUs = 0;
      }
      encodeChannel(after);
      const c = design(draft);
      const modified = {
        ...preset,
        channels: preset.channels.map((ch, i) => (i === channelIndex ? after : ch)),
      };
      const path = (change: boolean) => {
        let lastPhase: number | undefined;
        return Array.from({ length: 240 }, (_, i) => {
          const f = 20 * 2000 ** (i / 239),
            current = eq ? preset.inputEq[sectionIndex] : source.filters[sectionIndex];
          let r: number, im: number;
          if (previewContext === 'section') [r, im] = response(change ? c : design(current), f);
          else if (eq) {
            r = 1;
            im = 0;
            preset.inputEq.forEach((band, j) => {
              const [a, b] = response(design(change && j === sectionIndex ? draft : band), f);
              [r, im] = [r * a - im * b, r * b + im * a];
            });
          } else [r, im] = presetResponse(change ? modified : preset, channelIndex, f);
          let value = 20 * Math.log10(Math.max(1e-12, Math.hypot(r, im)));
          if (phaseMode) {
            value = (Math.atan2(im, r) * 180) / Math.PI;
            if (lastPhase !== undefined) {
              while (value - lastPhase > 180) value -= 360;
              while (value - lastPhase < -180) value += 360;
            }
            lastPhase = value;
          }
          return `${i ? 'L' : 'M'}${35 + (i / 239) * 370},${Math.max(14, Math.min(174, 14 + ((axisMax - value) / (axisMax - axisMin)) * 160))}`;
        }).join(' ');
      };
      return { before: path(false), after: path(true), error: '' };
    } catch (e) {
      return { before: '', after: '', error: e instanceof Error ? e.message : String(e) };
    }
  }, [draft, preset, channelIndex, sectionIndex, eq, previewContext, phaseMode, axisMax, axisMin]);
  const select = (kind: FilterKind) =>
    onDraft({
      kind,
      ...(eq ? { enabled: true } : {}),
      coefficients: kind === 'raw' ? { b0: 1, b1: 0, b2: 0, f1: 0, f2: 0 } : undefined,
      provenance: undefined,
    });
  return (
    <dialog
      ref={dialog}
      className="filter-palette"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label={mode === 'add' ? 'Add a filter' : 'Change filter type'}
    >
      <div className="palette-shell">
        <header>
          <div>
            <div className="eyebrow">SHAPE YOUR SOUND</div>
            <h2>{mode === 'add' ? 'Add a filter' : 'Change filter shape'}</h2>
            <div className="palette-targets">
              {targets.map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
          </div>
          <button className="icon-only" aria-label="Close filter palette" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="palette-body">
          <section className="palette-picker">
            <div className="palette-categories">
              {Object.keys(choices)
                .filter((c) => !eq || c === 'EQ')
                .map((c) => (
                  <button
                    key={c}
                    className={category === c ? 'active' : ''}
                    onClick={() => setCategory(c)}
                  >
                    {c}
                  </button>
                ))}
            </div>
            <p className="palette-prompt">
              {category === 'Crossover'
                ? 'Choose which frequencies reach this driver.'
                : category === 'EQ'
                  ? 'Shape the balance without changing the crossover.'
                  : category === 'Phase'
                    ? 'Adjust phase without changing magnitude.'
                    : 'Precise control for custom transfer functions.'}
            </p>
            <div className="palette-shapes">
              {choices[category as keyof typeof choices]
                .filter(
                  (choice) => !eq || ['Bell', 'Low shelf', 'High shelf'].includes(choice.title),
                )
                .map((choice) => {
                  const kinds = choice.kinds.filter((k) => !eq || !k.endsWith('1')),
                    selected = kinds.includes(draft.kind as never),
                    kind = selected ? draft.kind : kinds.at(-1)!;
                  return (
                    <button
                      key={choice.title}
                      className={`shape-choice ${selected ? 'selected' : ''}`}
                      onClick={() => select(kind)}
                    >
                      <FilterGlyph kind={kind} />
                      <strong>{choice.title}</strong>
                      <small>{choice.description}</small>
                      {selected && <Check size={14} className="shape-check" />}
                    </button>
                  );
                })}
            </div>
            <div className="palette-order">
              {choices[category as keyof typeof choices]
                .map((c) => c.kinds as readonly FilterKind[])
                .find((k) => k.includes(draft.kind) && k.length === 2)
                ?.map((kind, i) => (
                  <button
                    key={kind}
                    className={kind === draft.kind ? 'active' : ''}
                    onClick={() => select(kind)}
                  >
                    {i === 0 ? '1st order' : '2nd order'}
                    {category === 'Crossover' ? ` · ${i === 0 ? 6 : 12} dB/oct` : ''}
                  </button>
                ))}
            </div>
            <div className="palette-kind-label">
              <SlidersHorizontal size={14} />
              {FILTER_NAMES[draft.kind]}
              <span>Section {sectionIndex + 1}</span>
            </div>
          </section>
          <section className="palette-preview">
            <div className="palette-preview-title">
              <span>{phaseMode ? 'PHASE PREVIEW' : 'RESPONSE PREVIEW'}</span>
              <span>
                <i />
                Current <i />
                With filter
              </span>
            </div>
            <div className="preview-context">
              <button
                className={previewContext === 'section' ? 'active' : ''}
                onClick={() => setPreviewContext('section')}
              >
                Filter shape
              </button>
              <button
                className={previewContext === 'driver' ? 'active' : ''}
                onClick={() => setPreviewContext('driver')}
              >
                In this driver
              </button>
            </div>
            <svg
              viewBox="0 0 430 205"
              className="palette-response"
              aria-label="Current and proposed response"
            >
              <defs>
                <clipPath id="palette-chart">
                  <rect x="35" y="14" width="370" height="160" />
                </clipPath>
              </defs>
              {[0, 1, 2, 3, 4].map((i) => (
                <path key={i} d={`M35 ${14 + i * 40}H405`} stroke="#ffffff0d" />
              ))}
              {[0, 1, 2, 3, 4].map((i) => (
                <text key={i} x="4" y={18 + i * 40} fill="#78937c" fontSize="9">
                  {axisMax - (i * (axisMax - axisMin)) / 4}
                </text>
              ))}
              <g clipPath="url(#palette-chart)">
                <path
                  d={preview.before}
                  fill="none"
                  stroke="#91a598"
                  strokeWidth="1.4"
                  strokeDasharray="4 5"
                />
                <path d={preview.after} fill="none" stroke="#d0e89b" strokeWidth="2.4" />
              </g>
              {[20, 100, 1000, 10000, 40000].map((f) => (
                <text
                  key={f}
                  x={35 + (Math.log(f / 20) / Math.log(2000)) * 370 - 8}
                  y="195"
                  fill="#78937c"
                  fontSize="9"
                >
                  {f >= 1000 ? `${f / 1000}k` : f}
                </text>
              ))}
            </svg>
            <div className="palette-fields">
              {draft.kind !== 'raw' && (
                <Numeric
                  label={draft.kind === 'asymmetric' ? 'Zero frequency' : 'Frequency'}
                  frequencyWheel={eq ? 'input-eq' : 'advanced'}
                  frequencyWheelMin={eq ? undefined : 10}
                  frequencyWheelMax={eq ? undefined : frequencyMaximum}
                  value={draft.frequency}
                  onChange={(frequency) => onDraft({ frequency })}
                  deferTextCommit={!eq}
                  normalizeText={
                    eq
                      ? undefined
                      : (text, previousValue) =>
                          normalizeHfdManualFrequencyText(text, { previousValue })
                  }
                  min={eq ? 1 : 10}
                  max={50000}
                  unit="Hz"
                />
              )}
              {hasGain(draft.kind) && (
                <Numeric
                  label="Amount"
                  contextKey={eq ? undefined : `${parameterContext}:gain`}
                  value={draft.gain}
                  onChange={(gain) => onDraft({ gain })}
                  parameterWheel={eq ? undefined : 'gain'}
                  parameterWheelAdditionalGain={preset.channels[channelIndex].additionalGain ?? 0}
                  deferTextCommit={!eq}
                  normalizeText={
                    eq
                      ? undefined
                      : (text, previousValue) => normalizeHfdManualGainText(text, { previousValue })
                  }
                  formatValue={eq ? undefined : formatHfdManualGainValue}
                  min={eq ? -32 : HFD_MANUAL_GAIN_BOUNDS.min}
                  max={eq ? 32 : HFD_MANUAL_GAIN_BOUNDS.max}
                  adjustmentBounds={eq ? undefined : { min: -60, max: 60 }}
                  unit="dB"
                  step={0.5}
                />
              )}
              {hasQ(draft.kind) && (
                <Numeric
                  precision={3}
                  label={draft.kind === 'asymmetric' ? 'Zero Q' : 'Width · Q'}
                  contextKey={eq ? undefined : `${parameterContext}:q`}
                  value={draft.q}
                  onChange={(q) => onDraft({ q })}
                  parameterWheel={eq ? undefined : 'q'}
                  parameterWheelAdditionalGain={preset.channels[channelIndex].additionalGain ?? 0}
                  deferTextCommit={!eq}
                  normalizeText={
                    eq
                      ? undefined
                      : (text, previousValue) => normalizeHfdManualQText(text, { previousValue })
                  }
                  formatValue={eq ? undefined : formatHfdManualQValue}
                  min={eq ? 0.001 : HFD_MANUAL_Q_BOUNDS.min}
                  max={eq ? 100 : HFD_MANUAL_Q_BOUNDS.max}
                  adjustmentBounds={eq ? undefined : { min: 0.001, max: 100 }}
                  step={0.05}
                />
              )}
              {draft.kind === 'asymmetric' && (
                <>
                  <Numeric
                    label="Pole frequency"
                    frequencyWheel="advanced"
                    frequencyWheelMin={10}
                    frequencyWheelMax={frequencyMaximum}
                    value={draft.frequency2}
                    onChange={(frequency2) => onDraft({ frequency2 })}
                    deferTextCommit
                    normalizeText={(text, previousValue) =>
                      normalizeHfdManualFrequencyText(text, { previousValue })
                    }
                    unit="Hz"
                    min={10}
                    max={50000}
                  />
                  <Numeric
                    precision={3}
                    label="Pole Q"
                    contextKey={`${parameterContext}:q2`}
                    value={draft.q2}
                    onChange={(q2) => onDraft({ q2 })}
                    parameterWheel="q"
                    parameterWheelAdditionalGain={preset.channels[channelIndex].additionalGain ?? 0}
                    deferTextCommit
                    normalizeText={(text, previousValue) =>
                      normalizeHfdManualQText(text, { previousValue })
                    }
                    formatValue={formatHfdManualQValue}
                    min={HFD_MANUAL_Q_BOUNDS.min}
                    max={HFD_MANUAL_Q_BOUNDS.max}
                    adjustmentBounds={{ min: 0.001, max: 100 }}
                    step={0.05}
                  />
                  <label className="field-label">
                    Shelf direction
                    <select
                      value={draft.shelfDirection ?? 'low'}
                      onChange={(e) =>
                        onDraft({ shelfDirection: e.target.value as 'low' | 'high' })
                      }
                    >
                      <option value="low">Low</option>
                      <option value="high">High</option>
                    </select>
                  </label>
                </>
              )}
              {draft.kind === 'raw' &&
                Object.entries(draft.coefficients ?? { b0: 1, b1: 0, b2: 0, f1: 0, f2: 0 }).map(
                  ([key, value]) => (
                    <Numeric
                      key={key}
                      label={key}
                      value={value}
                      step={0.000001}
                      onChange={(v) =>
                        onDraft({
                          coefficients: {
                            b0: 1,
                            b1: 0,
                            b2: 0,
                            f1: 0,
                            f2: 0,
                            ...draft.coefficients,
                            [key]: v,
                          },
                        })
                      }
                    />
                  ),
                )}
            </div>
            {draft.kind.startsWith('allpass') && (
              <p className="palette-note">
                All-pass keeps the level flat. Its phase curve is shown on the filter tile and in
                the section inspector.
              </p>
            )}
            {(preview.error || failure) && (
              <div className="inline-error">{preview.error || failure}</div>
            )}
            {mode === 'replace' && !draft.enabled && (
              <p className="palette-note">This section is bypassed. Shape changes retain bypass.</p>
            )}
          </section>
        </div>
        <footer>
          <span>Changes are previewed locally. Upload is a separate action.</span>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!!preview.error} onClick={onApply}>
            {mode === 'add' ? 'Add to design' : 'Apply shape'}
            <ArrowRight size={15} />
          </button>
        </footer>
      </div>
    </dialog>
  );
}
