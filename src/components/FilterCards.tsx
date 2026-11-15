'use client';
import { Plus, Power, SlidersHorizontal, X } from 'lucide-react';
import { type Filter } from '../domain/model';
import { FilterGlyph, FILTER_LABELS, hasQ, hasGain } from './FilterPalette';
export default function FilterCards({
  filters,
  selected,
  readonly = false,
  eq = false,
  onSelect,
  onToggle,
  onRemove,
  onType,
  onAdd,
}: {
  filters: Filter[];
  selected: number;
  readonly?: boolean;
  eq?: boolean;
  onSelect: (index: number) => void;
  onToggle: (index: number) => void;
  onRemove: (index: number) => void;
  onType: (index: number) => void;
  onAdd: () => void;
}) {
  const visible = filters.map((f, i) => ({ f, i })).filter(({ f }) => eq || f.kind !== 'unity'),
    used = visible.length;
  return (
    <div className="filter-cards">
      <div className="filter-cards-grid">
        {visible.map(({ f, i }) => (
          <article
            key={f.id}
            role="button"
            tabIndex={0}
            aria-label={`Select ${FILTER_LABELS[f.kind]} in section ${i + 1}`}
            className={`filter-card ${selected === i ? 'selected' : ''} ${f.enabled ? '' : 'bypassed'}`}
            onClick={() => onSelect(i)}
            aria-pressed={selected === i}
            onKeyDown={(e) => {
              if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                onSelect(i);
              }
            }}
            onDoubleClick={() => {
              if (!readonly) onType(i);
            }}
          >
            <span className="filter-card-index">{String(i + 1).padStart(2, '0')}</span>
            <FilterGlyph kind={f.kind} />
            <div className="filter-card-main">
              <div>
                <strong>{FILTER_LABELS[f.kind]}</strong>
                <small>
                  {f.kind.endsWith('1')
                    ? '1st order'
                    : f.kind.endsWith('2')
                      ? '2nd order'
                      : f.kind === 'raw'
                        ? 'Exact coefficients'
                        : f.enabled
                          ? 'Active'
                          : 'Bypassed'}
                </small>
              </div>
            </div>
            <div className="filter-card-values">
              <strong>
                {f.frequency >= 1000
                  ? `${+(f.frequency / 1000).toFixed(2)} kHz`
                  : `${+f.frequency.toFixed(1)} Hz`}
              </strong>
              {hasGain(f.kind) && (
                <span>
                  {f.gain > 0 ? '+' : ''}
                  {f.gain.toFixed(1)} dB
                </span>
              )}
              {hasQ(f.kind) && <span>Q {f.q.toFixed(2)}</span>}
            </div>
            <button
              className="filter-power icon-only"
              aria-label={`${f.enabled ? 'Bypass' : 'Enable'} section ${i + 1}`}
              aria-pressed={!f.enabled}
              disabled={readonly}
              onClick={(e) => {
                e.stopPropagation();
                onToggle(i);
              }}
            >
              <Power size={13} />
            </button>
            {selected === i && (
              <div className="filter-card-actions">
                <button
                  aria-label={`Change shape of section ${i + 1}`}
                  title="Change shape"
                  disabled={readonly}
                  onClick={(e) => {
                    e.stopPropagation();
                    onType(i);
                  }}
                >
                  <SlidersHorizontal size={13} />
                </button>
                {!eq && (
                  <button
                    disabled={readonly}
                    aria-label={`Remove section ${i + 1}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(i);
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            )}
          </article>
        ))}
        {!eq && used < filters.length && (
          <button className="add-filter-card" disabled={readonly} onClick={onAdd}>
            <Plus size={15} />
            <strong>Add filter</strong>
            <span>{filters.length - used} sections available</span>
          </button>
        )}
      </div>
      {!visible.length && (
        <p className="hint">Start with a crossover, shape the tone, or adjust phase.</p>
      )}
    </div>
  );
}
