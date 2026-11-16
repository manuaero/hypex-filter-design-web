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
import {
  formatHfdChannelGainValue,
  normalizeHfdChannelGainText,
  hfdChannelGainWheelNext,
  type HfdChannelGainWheelResult,
  type HfdChannelGainWheelState,
} from '../domain/channel-gain';
import {
  formatHfdChannelDelayValue,
  normalizeHfdChannelDelayText,
  hfdChannelDelayWheelNext,
  type HfdChannelDelayProfile,
  type HfdChannelDelayWheelResult,
  type HfdChannelDelayWheelState,
} from '../domain/channel-delay';
export interface NumericFocusOperation {
  isCurrent(): boolean;
  run<T>(action: () => T): T;
  end(cancel?: boolean): void;
}
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
  channelGain = false,
  channelGainAdditionalGain = 0,
  channelGainRevision,
  getChannelGainRevision,
  onTextCommit,
  onChannelGainWheel,
  channelDelay,
  channelDelayRevision,
  getChannelDelayRevision,
  onChannelDelayWheel,
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
  channelGain?: boolean;
  channelGainAdditionalGain?: number;
  /** Browser multi-role freshness fence; own synchronous edits acknowledge it. */
  channelGainRevision?: number;
  getChannelGainRevision?: () => number | undefined;
  /** Publish the original dirty Text independently in every intended role. */
  onTextCommit?: (text: string) => { text: string; value: number } | false;
  onChannelGainWheel?: (result: HfdChannelGainWheelResult, direction: -1 | 1) => boolean | void;
  channelDelay?: Readonly<HfdChannelDelayProfile>;
  channelDelayRevision?: number;
  getChannelDelayRevision?: () => number | undefined;
  /** Forward notification separately from a canonical value change. */
  onChannelDelayWheel?: (result: HfdChannelDelayWheelResult, direction: -1 | 1) => boolean | void;
  begin?: () => void | NumericFocusOperation;
  end?: (cancel?: boolean) => void;
  precision?: number;
  frequencyWheel?: 'input-eq' | 'advanced';
  frequencyWheelStep?: number;
  frequencyWheelMin?: number;
  frequencyWheelMax?: number;
  /** Discard an uncommitted draft when its document or editing context changes. */
  contextKey?: string | number;
}) {
  const channelDelayKey = channelDelay
      ? JSON.stringify([
          channelDelay.kind,
          channelDelay.unit,
          channelDelay.sampleRate,
          channelDelay.minimumText,
          channelDelay.maximumText,
        ])
      : undefined,
    fieldContextKey =
      channelDelayKey === undefined ? contextKey : JSON.stringify([contextKey, channelDelayKey]);
  const format = (n: number) =>
    channelDelay && Number.isFinite(n)
      ? formatHfdChannelDelayValue(n, { profile: channelDelay })
      : channelGain && Number.isFinite(n)
        ? formatHfdChannelGainValue(n)
        : inputEqParameter && Number.isFinite(n)
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
    channelGainWheelState = useRef<HfdChannelGainWheelState | undefined>(undefined),
    channelGainWheelRevision = useRef(channelGainRevision),
    channelDelayWheelState = useRef<HfdChannelDelayWheelState | undefined>(undefined),
    channelDelayWheelRevision = useRef(channelDelayRevision),
    parameterWheelText = useRef<{ value: number; text: string } | undefined>(undefined),
    draftContext = useRef(fieldContextKey),
    focusOperation = useRef<NumericFocusOperation | undefined>(undefined),
    focusRetired = useRef(false);
  const refreshChannelGainRevision = () => {
    if (!channelGain) return false;
    const latest = getChannelGainRevision?.() ?? channelGainRevision;
    if (Object.is(latest, channelGainWheelRevision.current)) return false;
    channelGainWheelRevision.current = latest;
    channelGainWheelState.current = undefined;
    parameterWheelText.current = undefined;
    return true;
  };
  useLayoutEffect(() => {
    if (refreshChannelGainRevision()) setDraft(format(value));
  }, [channelGainRevision, channelGain]);
  const refreshChannelDelayRevision = () => {
    if (!channelDelay) return false;
    const latest = getChannelDelayRevision?.() ?? channelDelayRevision;
    if (Object.is(latest, channelDelayWheelRevision.current)) return false;
    channelDelayWheelRevision.current = latest;
    channelDelayWheelState.current = undefined;
    parameterWheelText.current = undefined;
    return true;
  };
  useLayoutEffect(() => {
    if (refreshChannelDelayRevision()) setDraft(format(value));
  }, [channelDelayRevision, channelDelayKey]);
  useLayoutEffect(() => {
    if (draftContext.current === fieldContextKey) return;
    draftContext.current = fieldContextKey;
    if (focusOperation.current) {
      focusOperation.current.end();
      focusRetired.current = true;
    }
    channelGainWheelState.current = undefined;
    channelDelayWheelState.current = undefined;
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
  }, [
    fieldContextKey,
    value,
    frequencyWheel,
    inputEqParameter,
    channelGain,
    precision,
    formatValue,
  ]);
  useLayoutEffect(() => {
    if (previousValue.current === value) return;
    previousValue.current = value;
    const ownEdit = liveEmission.current === value;
    liveEmission.current = undefined;
    if (!ownEdit) {
      channelGainWheelState.current = undefined;
      channelDelayWheelState.current = undefined;
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
  }, [
    value,
    focused,
    frequencyWheel,
    inputEqParameter,
    channelGain,
    channelDelayKey,
    precision,
    formatValue,
  ]);
  useEffect(() => {
    const hadWheelText = parameterWheelText.current !== undefined;
    channelGainWheelState.current = undefined;
    channelDelayWheelState.current = undefined;
    parameterWheelState.current = undefined;
    inputEqWheelState.current = undefined;
    parameterWheelText.current = undefined;
    if (hadWheelText) setDraft(format(value));
  }, [
    parameterWheel,
    parameterWheelAdditionalGain,
    inputEqParameter,
    channelGain,
    channelGainAdditionalGain,
    channelDelayKey,
    min,
    max,
  ]);
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
  }, [
    value,
    focused,
    frequencyWheel,
    inputEqParameter,
    channelGain,
    channelDelayKey,
    precision,
    formatValue,
  ]);
  const resetFocusDraft = () => {
    channelGainWheelState.current = undefined;
    channelDelayWheelState.current = undefined;
    dirty.current = false;
    baseline.current = value;
    submitted.current = undefined;
    liveEmission.current = undefined;
    parameterWheelState.current = undefined;
    inputEqWheelState.current = undefined;
    parameterWheelText.current = undefined;
    setDraft(format(value));
  };
  const retireFocus = () => {
    if (focusOperation.current && !focusOperation.current.isCurrent()) {
      if (!focusRetired.current) resetFocusDraft();
      focusRetired.current = true;
    }
    return focusRetired.current;
  };
  const runOwnEdit = <T,>(action: () => T): T | false => {
    if (retireFocus()) return false;
    const operation = focusOperation.current;
    try {
      const result = operation ? operation.run(action) : action();
      if (channelGain)
        channelGainWheelRevision.current = getChannelGainRevision?.() ?? channelGainRevision;
      if (channelDelay)
        channelDelayWheelRevision.current = getChannelDelayRevision?.() ?? channelDelayRevision;
      return result;
    } catch (error) {
      if (operation && !operation.isCurrent()) {
        retireFocus();
        return false;
      }
      throw error;
    }
  };
  const renewForLocalEdit = () => {
    const retired = retireFocus();
    if (!retired) return { allowed: true, rebased: false };
    if (!focused) return { allowed: false, rebased: true };
    try {
      const operation = begin?.();
      if (!operation || !operation.isCurrent()) return { allowed: false, rebased: true };
      focusOperation.current = operation;
      focusRetired.current = false;
      resetFocusDraft();
      return { allowed: true, rebased: true };
    } catch {
      resetFocusDraft();
      return { allowed: false, rebased: true };
    }
  };
  const finishFocus = (cancel = false) => {
    if (focusOperation.current) focusOperation.current.end(cancel);
    else if (!focusRetired.current) end?.(cancel);
    focusOperation.current = undefined;
    focusRetired.current = false;
  };
  // Foreign edits can leave this numeric value unchanged (or equal an own
  // emission). Session authority, rather than value equality, retires drafts.
  useLayoutEffect(() => {
    if (focused) retireFocus();
  });
  useEffect(() => () => focusOperation.current?.end(), []);
  const parse = (s: string) => (s.trim() === '' ? NaN : Number(s.replace(',', '.')));
  const commit = (
    n: number,
    bounds: { min?: number; max?: number } = { min, max },
    boundedAlready = false,
  ) => {
    parameterWheelText.current = undefined;
    if (retireFocus()) return;
    if (draftContext.current !== fieldContextKey) {
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
      if (runOwnEdit(() => onChange(bounded)) === false) return;
    }
    dirty.current = false;
    setDraft(format(bounded));
  };
  const commitChannelDelayText = (text: string) => {
    if (!channelDelay || retireFocus() || draftContext.current !== fieldContextKey) return;
    const normalized = normalizeHfdChannelDelayText(text, { profile: channelDelay });
    liveEmission.current = normalized.value;
    const result = runOwnEdit(() => {
      // Explicit raw intent may change a peer or callback metadata even when
      // the selected canonical Delay remains equal.
      if (onTextCommit) return onTextCommit(text);
      if (!Object.is(normalized.value, value)) onChange(normalized.value);
      return normalized;
    });
    if (result === false) resetFocusDraft();
    else {
      dirty.current = false;
      setDraft(result.text);
    }
  };
  const changeDraft = (text: string) => {
    if (!renewForLocalEdit().allowed) return;
    channelGainWheelState.current = undefined;
    channelDelayWheelState.current = undefined;
    parameterWheelState.current = undefined;
    inputEqWheelState.current = undefined;
    parameterWheelText.current = undefined;
    dirty.current = true;
    setDraft(text);
    const n = parse(text);
    if (
      !commitOnly &&
      !deferTextCommit &&
      !inputEqParameter &&
      !channelGain &&
      !channelDelay &&
      Number.isFinite(n)
    ) {
      liveEmission.current = n;
      runOwnEdit(() => onChange(n));
    }
  };
  const adjust = (direction: -1 | 1, wheel = false) => {
    const authority = renewForLocalEdit();
    if (!authority.allowed) return;
    const sourceDraft = authority.rebased ? format(value) : draft;
    channelGainWheelState.current = undefined;
    channelDelayWheelState.current = undefined;
    parameterWheelState.current = undefined;
    inputEqWheelState.current = undefined;
    parameterWheelText.current = undefined;
    const n = parse(sourceDraft),
      current = Number.isFinite(n) ? n : value,
      ordinaryBounds = adjustmentBounds ?? { min, max },
      bounds = wheel
        ? {
            min: frequencyWheelMin ?? ordinaryBounds.min,
            max: frequencyWheelMax ?? ordinaryBounds.max,
          }
        : ordinaryBounds;
    if (channelDelay) {
      // Browser arrow recurrence is separate from native wheel behavior. Its
      // request still uses the shared Text callback and accepted final Text.
      try {
        commitChannelDelayText(String(current + direction * step));
      } catch {
        resetFocusDraft();
      }
      return;
    }
    commit(
      wheel && frequencyWheel === 'advanced'
        ? hfdAdvancedFrequencyWheelNext(
            sourceDraft === format(value) ? value : current,
            direction,
            {
              ...bounds,
              frequencyStep: frequencyWheelStep,
            },
          )
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
    const authority = renewForLocalEdit();
    if (!authority.allowed) return;
    const sourceDraft = authority.rebased ? format(value) : draft;
    try {
      const result = hfdManualParameterWheelNext(value, direction, {
        parameter: parameterWheel,
        displayedText: sourceDraft,
        state: parameterWheelState.current,
        min,
        max,
        additionalGain: parameterWheelAdditionalGain,
      });
      if (result.changed && result.value !== value) liveEmission.current = result.value;
      const accepted = runOwnEdit(() => {
        if (onParameterWheel) return onParameterWheel(result, direction);
        if (result.changed && result.value !== value) onChange(result.value);
      });
      if (accepted === false) {
        liveEmission.current = undefined;
        parameterWheelState.current = undefined;
        inputEqWheelState.current = undefined;
        parameterWheelText.current = undefined;
        dirty.current = false;
        setDraft(format(value));
        return;
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
    const authority = renewForLocalEdit();
    if (!authority.allowed) return;
    const sourceDraft = authority.rebased ? format(value) : draft;
    try {
      const result = hfdInputEqWheelNext(inputEqParameter, value, direction, {
        displayedText: sourceDraft,
        state: inputEqWheelState.current,
      });
      if (result.changed && result.value !== value) liveEmission.current = result.value;
      const accepted = runOwnEdit(() => {
        if (onInputEqWheel) return onInputEqWheel(result, direction);
        if (result.changed && result.value !== value) onChange(result.value);
      });
      if (accepted === false) {
        liveEmission.current = undefined;
        inputEqWheelState.current = undefined;
        parameterWheelText.current = undefined;
        dirty.current = false;
        setDraft(format(value));
        return;
      }
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
  const adjustChannelGain = (direction: -1 | 1) => {
    const refreshed = refreshChannelGainRevision();
    const authority = renewForLocalEdit();
    if (!authority.allowed) return;
    try {
      const result = hfdChannelGainWheelNext(value, direction, {
        additionalGain: channelGainAdditionalGain,
        displayedText: authority.rebased || refreshed ? format(value) : draft,
        state: channelGainWheelState.current,
      });
      if (result.changed && !Object.is(result.value, value)) liveEmission.current = result.value;
      const accepted = runOwnEdit(() => {
        if (onChannelGainWheel) return onChannelGainWheel(result, direction);
        if (result.changed) onChange(result.value);
      });
      if (accepted === false) {
        resetFocusDraft();
        return;
      }
      channelGainWheelState.current = result.state;
      parameterWheelText.current = { value: result.value, text: result.text };
      dirty.current = false;
      setDraft(result.text);
    } catch {
      resetFocusDraft();
    }
  };
  const adjustChannelDelay = (direction: -1 | 1) => {
    if (!channelDelay) return;
    const refreshed = refreshChannelDelayRevision(),
      authority = renewForLocalEdit();
    if (!authority.allowed) return;
    try {
      const result = hfdChannelDelayWheelNext(value, direction, {
        profile: channelDelay,
        displayedText: authority.rebased || refreshed ? format(value) : draft,
        state: channelDelayWheelState.current,
      });
      if (result.changed) liveEmission.current = result.value;
      const accepted = runOwnEdit(() => {
        if (onChannelDelayWheel) return onChannelDelayWheel(result, direction);
        if (result.changed) onChange(result.value);
      });
      if (accepted === false) {
        resetFocusDraft();
        return;
      }
      channelDelayWheelState.current = result.state;
      parameterWheelText.current = { value: result.value, text: result.text };
      dirty.current = false;
      setDraft(result.text);
    } catch {
      resetFocusDraft();
    }
  };
  // React's delegated wheel listener is passive. Native HFD marks this event
  // handled; a nonpassive local listener prevents the inspector scrolling as
  // its EQ value changes. Reinstall with the current draft/props after render.
  useEffect(() => {
    const field = input.current;
    if (
      !field ||
      (!frequencyWheel && !parameterWheel && !inputEqParameter && !channelGain && !channelDelay)
    )
      return;
    const wheel = (event: WheelEvent) => {
      if (disabled || (commitOnly && !focused) || event.deltaY === 0) return;
      event.preventDefault();
      if (channelDelay) adjustChannelDelay(event.deltaY < 0 ? 1 : -1);
      else if (channelGain) adjustChannelGain(event.deltaY < 0 ? 1 : -1);
      else if (inputEqParameter) adjustInputEq(event.deltaY < 0 ? 1 : -1);
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
        {(parameterWheel === 'gain' || channelGain) &&
          parameterWheelText.current?.value === value &&
          draft !== format(value) && (
            <small style={{ display: 'block', color: 'inherit' }}>
              Stored {channelGain ? String(value) : format(value)} {unit}
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
            channelGainWheelState.current = undefined;
            channelDelayWheelState.current = undefined;
            parameterWheelState.current = undefined;
            inputEqWheelState.current = undefined;
            baseline.current = value;
            submitted.current = undefined;
            dirty.current = false;
            setFocused(true);
            focusRetired.current = false;
            try {
              focusOperation.current = begin?.() || undefined;
            } catch {
              focusOperation.current = {
                isCurrent: () => false,
                run: () => {
                  throw new Error('Numeric focus context is stale');
                },
                end: () => {},
              };
              focusRetired.current = true;
              resetFocusDraft();
            }
          }}
          onBlur={() => {
            // Native gain's post-wheel guard can change Text without updating
            // the model. Passive refresh returns to canonical Text and must
            // also discard the state bound to that previous guarded Text.
            channelGainWheelState.current = undefined;
            channelDelayWheelState.current = undefined;
            parameterWheelState.current = undefined;
            inputEqWheelState.current = undefined;
            parameterWheelText.current = undefined;
            const retired = retireFocus();
            setFocused(false);
            if (retired) {
              cancelled.current = false;
              resetFocusDraft();
              finishFocus();
              return;
            }
            if (cancelled.current) {
              cancelled.current = false;
              setDraft(format(baseline.current));
              finishFocus(true);
              return;
            }
            if (!dirty.current) {
              setDraft(format(value));
              finishFocus();
              return;
            }
            try {
              if (channelDelay) commitChannelDelayText(draft);
              else if (channelGain) {
                const normalized = normalizeHfdChannelGainText(draft, {
                  additionalGain: channelGainAdditionalGain,
                });
                liveEmission.current = normalized.value;
                const result = runOwnEdit(() => {
                  if (onTextCommit) return onTextCommit(draft);
                  if (!Object.is(normalized.value, value)) onChange(normalized.value);
                  return normalized;
                });
                if (result === false) resetFocusDraft();
                else {
                  dirty.current = false;
                  setDraft(result.text);
                }
              } else if (inputEqParameter || normalizeText) {
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
            finishFocus();
          }}
          onInput={
            channelDelay
              ? (e) => {
                  // React onChange deduplicates equal resulting Text. A real
                  // Delay input still owns a deferred callback (native0->0
                  // can publish MaxDelay); passive focus/blur does not.
                  if (!e.defaultPrevented) changeDraft(e.currentTarget.value);
                }
              : undefined
          }
          onChange={(e) => {
            if (!channelDelay) changeDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (channelDelay && e.nativeEvent.isComposing) return;
            if (begin && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z')
              e.currentTarget.blur();
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              adjust(e.key === 'ArrowUp' ? 1 : -1);
            }
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              const retired = retireFocus();
              channelGainWheelState.current = undefined;
              channelDelayWheelState.current = undefined;
              parameterWheelState.current = undefined;
              inputEqWheelState.current = undefined;
              parameterWheelText.current = undefined;
              cancelled.current = true;
              if (
                !focusOperation.current &&
                !retired &&
                !commitOnly &&
                ((!deferTextCommit && !inputEqParameter && !channelGain && !channelDelay) ||
                  value !== baseline.current)
              )
                runOwnEdit(() => onChange(baseline.current));
              setDraft(format(retired ? value : baseline.current));
              e.currentTarget.blur();
            }
          }}
          onWheel={(e) => {
            if (frequencyWheel || parameterWheel || inputEqParameter || channelGain || channelDelay)
              return;
            if (disabled || (commitOnly && !focused)) return;
            adjust(e.deltaY < 0 ? 1 : -1);
          }}
        />
        <small>{unit}</small>
      </div>
    </label>
  );
}
