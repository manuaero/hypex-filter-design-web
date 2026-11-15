import { adjustManualNumberWheel, type ManualNumberWheelState } from './manual-number';
import { HFD_MANUAL_GAIN_BOUNDS, HFD_MANUAL_Q_BOUNDS } from './manual-parameter';

/** Native factory literals a86eae/a86ee4; configuration may replace them. */
export const HFD_MANUAL_Q_WHEEL_STEP = 0.04;
export const HFD_MANUAL_GAIN_WHEEL_STEP = 0.1;
export type HfdManualWheelState = ManualNumberWheelState;
export interface HfdManualWheelOptions {
  parameter: 'q' | 'gain';
  /** Normally the passive field display. Invalid/nonfinite dirty Text rejects. */
  displayedText?: string;
  /** Reuse after own result; reset on passive/external/context/Text changes. */
  state?: HfdManualWheelState;
  step?: number;
  min?: number;
  max?: number;
  /** Native shared gain handler uses channel AdditionalGain, not channel gain. */
  additionalGain?: number;
}
export interface HfdManualWheelResult {
  /** Native visible Text; the once-inhibited gain ceiling can differ from value. */
  text: string;
  /** Canonical BQ Double published by OnChange, not necessarily Number(text). */
  value: number;
  /** Only canonical changes require a design transaction. */
  changed: boolean;
  state: HfdManualWheelState;
}

/** One native ordinary Q1/Q2 or BQ gain wheel event. Direction alone matters;
 * callers must ignore browser delta0. No Single cast or arrow increment path.
 * Unchanged formatted Text retains canonical metadata and permits a true no-op
 * document transaction. The native gain ceiling changes only Text/internal state
 * after AddValue; never substitute it for the canonical BQ value. State is
 * transient and intentionally not serializable. */
export function hfdManualParameterWheelNext(
  value: number,
  direction: -1 | 1,
  options: HfdManualWheelOptions,
): HfdManualWheelResult {
  const gain = options.parameter === 'gain',
    bounds = gain ? HFD_MANUAL_GAIN_BOUNDS : HFD_MANUAL_Q_BOUNDS;
  return adjustManualNumberWheel(value, direction, {
    ...options,
    step: options.step ?? (gain ? HFD_MANUAL_GAIN_WHEEL_STEP : HFD_MANUAL_Q_WHEEL_STEP),
    min: options.min ?? bounds.min,
    max: options.max ?? bounds.max,
    places: gain ? 2 : 3,
    zeroAllowed: gain,
    additionalGain: options.additionalGain ?? 0,
  });
}
