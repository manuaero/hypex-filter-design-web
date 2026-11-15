'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  formatHfdAdvancedFrequency,
  hfdAdvancedFrequencyWheelNext,
  hfdEqFrequencyWheelDelta,
} from '../domain/frequency-wheel';
export default function Numeric({
  label,
  value,
  onChange,
  unit,
  min,
  max,
  step = 1,
  disabled = false,
  commitOnly = false,
  begin,
  end,
  precision = 8,
  frequencyWheel,
  frequencyWheelStep,
  frequencyWheelMin,
  frequencyWheelMax,
  contextKey,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  commitOnly?: boolean;
  begin?: () => void;
  end?: (cancel?: boolean) => void;
  precision?: number;
  frequencyWheel?: 'input-eq' | 'advanced';
  frequencyWheelStep?: number;
  frequencyWheelMin?: number;
  frequencyWheelMax?: number;
  /** Discard an uncommitted draft when its document or editing context changes. */
  contextKey?: string | number;
}) {
  const format = (n: number) =>
    frequencyWheel === 'advanced'
      ? formatHfdAdvancedFrequency(n)
      : Number.isFinite(n)
        ? String(+n.toFixed(precision))
        : '';
  const [draft, setDraft] = useState(format(value)),
    [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    cancelled = useRef(false),
    dirty = useRef(false),
    baseline = useRef(value),
    submitted = useRef<number | undefined>(undefined),
    liveEmission = useRef<number | undefined>(undefined),
    previousValue = useRef(value),
    draftContext = useRef(contextKey);
  useLayoutEffect(() => {
    if (draftContext.current === contextKey) return;
    draftContext.current = contextKey;
    cancelled.current = false;
    dirty.current = false;
    baseline.current = value;
    submitted.current = undefined;
    liveEmission.current = undefined;
    previousValue.current = value;
    setDraft(format(value));
  }, [contextKey, value, frequencyWheel, precision]);
  useLayoutEffect(() => {
    if (previousValue.current === value) return;
    previousValue.current = value;
    const ownEdit = liveEmission.current === value;
    liveEmission.current = undefined;
    if (focused && !ownEdit) {
      dirty.current = false;
      baseline.current = value;
      submitted.current = undefined;
      setDraft(format(value));
    }
  }, [value, focused, frequencyWheel, precision]);
  useEffect(() => {
    // A new canonical value (including external Undo) ends submission deduplication.
    // Otherwise repeating the same wheel edit after Undo could be suppressed.
    submitted.current = undefined;
    if (!focused) setDraft(format(value));
  }, [value, focused, frequencyWheel, precision]);
  const parse = (s: string) => (s.trim() === '' ? NaN : Number(s.replace(',', '.')));
  const commit = (n: number, bounds = { min, max }, boundedAlready = false) => {
    if (draftContext.current !== contextKey) {
      dirty.current = false;
      setDraft(format(value));
      return;
    }
    const bounded = boundedAlready
      ? n
      : Math.max(bounds.min ?? -Infinity, Math.min(bounds.max ?? Infinity, n));
    if (bounded !== value && bounded !== submitted.current) {
      submitted.current = bounded;
      liveEmission.current = bounded;
      onChange(bounded);
    }
    dirty.current = false;
    setDraft(format(bounded));
  };
  const adjust = (direction: -1 | 1, wheel = false) => {
    const n = parse(draft),
      current = Number.isFinite(n) ? n : value,
      bounds = wheel
        ? { min: frequencyWheelMin ?? min, max: frequencyWheelMax ?? max }
        : { min, max };
    commit(
      wheel && frequencyWheel === 'advanced'
        ? hfdAdvancedFrequencyWheelNext(draft === format(value) ? value : current, direction, {
            ...bounds,
            frequencyStep: frequencyWheelStep,
          })
        : current +
            (wheel && frequencyWheel === 'input-eq'
              ? hfdEqFrequencyWheelDelta(current, direction)
              : direction * step),
      bounds,
      wheel && frequencyWheel === 'advanced',
    );
  };
  // React's delegated wheel listener is passive. Native HFD marks this event
  // handled; a nonpassive local listener prevents the inspector scrolling as
  // its EQ value changes. Reinstall with the current draft/props after render.
  useEffect(() => {
    const field = input.current;
    if (!field || !frequencyWheel) return;
    const wheel = (event: WheelEvent) => {
      if (disabled || (commitOnly && !focused) || event.deltaY === 0) return;
      event.preventDefault();
      adjust(event.deltaY < 0 ? 1 : -1, true);
    };
    field.addEventListener('wheel', wheel, { passive: false });
    return () => field.removeEventListener('wheel', wheel);
  });
  return (
    <label className="numeric">
      <span>{label}</span>
      <div>
        <input
          ref={input}
          type="text"
          inputMode="decimal"
          role="spinbutton"
          aria-label={label}
          aria-valuenow={Number.isFinite(value) ? value : undefined}
          aria-valuemin={min}
          aria-valuemax={max}
          disabled={disabled}
          value={draft}
          onFocus={() => {
            baseline.current = value;
            submitted.current = undefined;
            dirty.current = false;
            setFocused(true);
            begin?.();
          }}
          onBlur={() => {
            setFocused(false);
            if (cancelled.current) {
              cancelled.current = false;
              setDraft(format(baseline.current));
              end?.(true);
              return;
            }
            if (!dirty.current) {
              setDraft(format(value));
              end?.();
              return;
            }
            const n = parse(draft);
            if (Number.isFinite(n)) commit(n);
            else setDraft(format(value));
            end?.();
          }}
          onChange={(e) => {
            dirty.current = true;
            setDraft(e.target.value);
            const n = parse(e.target.value);
            if (!commitOnly && Number.isFinite(n)) {
              liveEmission.current = n;
              onChange(n);
            }
          }}
          onKeyDown={(e) => {
            if (begin && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z')
              e.currentTarget.blur();
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              adjust(e.key === 'ArrowUp' ? 1 : -1);
            }
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              cancelled.current = true;
              if (!commitOnly) onChange(baseline.current);
              setDraft(format(baseline.current));
              e.currentTarget.blur();
            }
          }}
          onWheel={(e) => {
            if (frequencyWheel) return;
            if (disabled || (commitOnly && !focused)) return;
            adjust(e.deltaY < 0 ? 1 : -1);
          }}
        />
        <small>{unit}</small>
      </div>
    </label>
  );
}
