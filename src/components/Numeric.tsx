'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  formatHfdAdvancedFrequency,
  hfdAdvancedFrequencyWheelNext,
  hfdEqFrequencyWheelDelta,
} from '../domain/frequency-wheel';
import {
  hfdManualParameterWheelNext,
  type HfdManualWheelState,
  type HfdManualWheelResult,
} from '../domain/parameter-wheel';
import {
  normalizeHfdInputEqText,
  formatHfdInputEqValue,
  hfdInputEqWheelNext,
  type HfdInputEqParameter,
  type HfdInputEqWheelState,
  type HfdInputEqWheelResult,
} from '../domain/input-eq-parameters';
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
  deferTextCommit = false,
  normalizeText,
  formatValue,
  adjustmentBounds,
  parameterWheel,
  parameterWheelAdditionalGain = 0,
  onParameterWheel,
  inputEqParameter,
  onInputEqWheel,
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
  /** Keep typed text local until blur/Enter without requiring focus for wheel edits. */
  deferTextCommit?: boolean;
  normalizeText?: (text: string, previousValue: number) => { text: string; value: number };
  /** Passive display only; never commits or bounds the canonical value. */
  formatValue?: (value: number) => string;
  /** Separate bounds for existing wheel/arrow extensions, independent of typed commits. */
  adjustmentBounds?: { min?: number; max?: number };
  parameterWheel?: 'q' | 'gain';
  parameterWheelAdditionalGain?: number;
  /** Optional shared workspace action. False rejects the event without a local edit. */
  onParameterWheel?: (result: HfdManualWheelResult, direction: -1 | 1) => boolean | void;
  /** Full native Input EQ Text/Double/wheel profile; no channel-gain coupling. */
  inputEqParameter?: HfdInputEqParameter;
  onInputEqWheel?: (result: HfdInputEqWheelResult, direction: -1 | 1) => boolean | void;
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
    inputEqParameter && Number.isFinite(n)
      ? formatHfdInputEqValue(inputEqParameter, n)
      : formatValue && Number.isFinite(n)
        ? formatValue(n)
        : frequencyWheel === 'advanced'
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
    parameterWheelState = useRef<HfdManualWheelState | undefined>(undefined),
    inputEqWheelState = useRef<HfdInputEqWheelState | undefined>(undefined),
    parameterWheelText = useRef<{ value: number; text: string } | undefined>(undefined),
    draftContext = useRef(contextKey);
  useLayoutEffect(() => {
    if (draftContext.current === contextKey) return;
    draftContext.current = contextKey;
    parameterWheelState.current = undefined;
    inputEqWheelState.current = undefined;
    parameterWheelText.current = undefined;
    cancelled.current = false;
    dirty.current = false;
    baseline.current = value;
    submitted.current = undefined;
    liveEmission.current = undefined;
    previousValue.current = value;
    setDraft(format(value));
  }, [contextKey, value, frequencyWheel, inputEqParameter, precision, formatValue]);
  useLayoutEffect(() => {
    if (previousValue.current === value) return;
    previousValue.current = value;
    const ownEdit = liveEmission.current === value;
    liveEmission.current = undefined;
    if (!ownEdit) {
      parameterWheelState.current = undefined;
      inputEqWheelState.current = undefined;
      parameterWheelText.current = undefined;
    }
    if (focused && !ownEdit) {
      dirty.current = false;
      baseline.current = value;
      submitted.current = undefined;
      setDraft(format(value));
    }
  }, [value, focused, frequencyWheel, inputEqParameter, precision, formatValue]);
  useEffect(() => {
    const hadWheelText = parameterWheelText.current !== undefined;
    parameterWheelState.current = undefined;
    inputEqWheelState.current = undefined;
    parameterWheelText.current = undefined;
    if (hadWheelText) setDraft(format(value));
  }, [parameterWheel, parameterWheelAdditionalGain, inputEqParameter, min, max]);
  useEffect(() => {
    // A new canonical value (including external Undo) ends submission deduplication.
    // Otherwise repeating the same wheel edit after Undo could be suppressed.
    submitted.current = undefined;
    if (!focused)
      setDraft(
        parameterWheelText.current?.value === value
          ? parameterWheelText.current.text
          : format(value),
      );
  }, [value, focused, frequencyWheel, inputEqParameter, precision, formatValue]);
  const parse = (s: string) => (s.trim() === '' ? NaN : Number(s.replace(',', '.')));
  const commit = (
    n: number,
    bounds: { min?: number; max?: number } = { min, max },
    boundedAlready = false,
  ) => {
    parameterWheelText.current = undefined;
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
    parameterWheelState.current = undefined;
    inputEqWheelState.current = undefined;
    parameterWheelText.current = undefined;
    const n = parse(draft),
      current = Number.isFinite(n) ? n : value,
      ordinaryBounds = adjustmentBounds ?? { min, max },
      bounds = wheel
        ? {
            min: frequencyWheelMin ?? ordinaryBounds.min,
            max: frequencyWheelMax ?? ordinaryBounds.max,
          }
        : ordinaryBounds;
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
  const adjustParameter = (direction: -1 | 1) => {
    if (!parameterWheel) return;
    try {
      const result = hfdManualParameterWheelNext(value, direction, {
        parameter: parameterWheel,
        displayedText: draft,
        state: parameterWheelState.current,
        min,
        max,
        additionalGain: parameterWheelAdditionalGain,
      });
      if (result.changed && result.value !== value) liveEmission.current = result.value;
      if (onParameterWheel?.(result, direction) === false) {
        liveEmission.current = undefined;
        parameterWheelState.current = undefined;
        inputEqWheelState.current = undefined;
        parameterWheelText.current = undefined;
        dirty.current = false;
        setDraft(format(value));
        return;
      }
      if (result.changed && result.value !== value) {
        if (!onParameterWheel) onChange(result.value);
      }
      parameterWheelState.current = result.state;
      parameterWheelText.current = { value: result.value, text: result.text };
      dirty.current = false;
      setDraft(result.text);
    } catch {
      liveEmission.current = undefined;
      parameterWheelState.current = undefined;
      inputEqWheelState.current = undefined;
      parameterWheelText.current = undefined;
      dirty.current = false;
      setDraft(format(value));
    }
  };
  const adjustInputEq = (direction: -1 | 1) => {
    if (!inputEqParameter) return;
    try {
      const result = hfdInputEqWheelNext(inputEqParameter, value, direction, {
        displayedText: draft,
        state: inputEqWheelState.current,
      });
      if (result.changed && result.value !== value) liveEmission.current = result.value;
      if (onInputEqWheel?.(result, direction) === false) {
        liveEmission.current = undefined;
        inputEqWheelState.current = undefined;
        parameterWheelText.current = undefined;
        dirty.current = false;
        setDraft(format(value));
        return;
      }
      if (result.changed && result.value !== value && !onInputEqWheel) onChange(result.value);
      inputEqWheelState.current = result.state;
      parameterWheelText.current = { value: result.value, text: result.text };
      dirty.current = false;
      setDraft(result.text);
    } catch {
      liveEmission.current = undefined;
      inputEqWheelState.current = undefined;
      parameterWheelText.current = undefined;
      dirty.current = false;
      setDraft(format(value));
    }
  };
  // React's delegated wheel listener is passive. Native HFD marks this event
  // handled; a nonpassive local listener prevents the inspector scrolling as
  // its EQ value changes. Reinstall with the current draft/props after render.
  useEffect(() => {
    const field = input.current;
    if (!field || (!frequencyWheel && !parameterWheel && !inputEqParameter)) return;
    const wheel = (event: WheelEvent) => {
      if (disabled || (commitOnly && !focused) || event.deltaY === 0) return;
      event.preventDefault();
      if (inputEqParameter) adjustInputEq(event.deltaY < 0 ? 1 : -1);
      else if (parameterWheel) adjustParameter(event.deltaY < 0 ? 1 : -1);
      else adjust(event.deltaY < 0 ? 1 : -1, true);
    };
    field.addEventListener('wheel', wheel, { passive: false });
    return () => field.removeEventListener('wheel', wheel);
  });
  return (
    <label className="numeric">
      <span>
        {label}
        {parameterWheel === 'gain' &&
          parameterWheelText.current?.value === value &&
          draft !== format(value) && (
            <small style={{ display: 'block', color: 'inherit' }}>
              Stored {format(value)} {unit}
            </small>
          )}
      </span>
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
            parameterWheelState.current = undefined;
            inputEqWheelState.current = undefined;
            baseline.current = value;
            submitted.current = undefined;
            dirty.current = false;
            setFocused(true);
            begin?.();
          }}
          onBlur={() => {
            // Native gain's post-wheel guard can change Text without updating
            // the model. Passive refresh returns to canonical Text and must
            // also discard the state bound to that previous guarded Text.
            parameterWheelState.current = undefined;
            inputEqWheelState.current = undefined;
            parameterWheelText.current = undefined;
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
            try {
              if (inputEqParameter || normalizeText) {
                const normalized = inputEqParameter
                  ? normalizeHfdInputEqText(inputEqParameter, draft, { previousValue: value })
                  : normalizeText!(draft, value);
                commit(normalized.value, { min, max }, true);
                setDraft(normalized.text);
              } else {
                const n = parse(draft);
                if (Number.isFinite(n)) commit(n);
                else setDraft(format(value));
              }
            } catch {
              setDraft(format(value));
              dirty.current = false;
            }
            end?.();
          }}
          onChange={(e) => {
            parameterWheelState.current = undefined;
            inputEqWheelState.current = undefined;
            parameterWheelText.current = undefined;
            dirty.current = true;
            setDraft(e.target.value);
            const n = parse(e.target.value);
            if (!commitOnly && !deferTextCommit && !inputEqParameter && Number.isFinite(n)) {
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
              parameterWheelState.current = undefined;
              inputEqWheelState.current = undefined;
              parameterWheelText.current = undefined;
              cancelled.current = true;
              if (
                !commitOnly &&
                ((!deferTextCommit && !inputEqParameter) || value !== baseline.current)
              )
                onChange(baseline.current);
              setDraft(format(baseline.current));
              e.currentTarget.blur();
            }
          }}
          onWheel={(e) => {
            if (frequencyWheel || parameterWheel || inputEqParameter) return;
            if (disabled || (commitOnly && !focused)) return;
            adjust(e.deltaY < 0 ? 1 : -1);
          }}
        />
        <small>{unit}</small>
      </div>
    </label>
  );
}
