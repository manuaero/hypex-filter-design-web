import {
  adjustManualNumberWheel,
  type ManualNumberWheelState,
  type ManualNumberWheelResult,
} from './manual-number';
import { HFD_MANUAL_Q_BOUNDS } from './manual-parameter';
import { HFD_MANUAL_Q_WHEEL_STEP } from './parameter-wheel';
import type { FilterKind } from './model';

/** Native c63c5b..70 permits enums2/4/6/8 only. Numeric Q editing has a
 * separate capability; Asymmetric and AP2 do not acquire graph Q gestures. */
export function supportsHfdGraphQ(kind: FilterKind): boolean {
  return ['lowpass2', 'highpass2', 'lowshelf2', 'highshelf2', 'peak'].includes(kind);
}

export type HfdManualGraphQState = ManualNumberWheelState;
export type HfdManualGraphQResult = ManualNumberWheelResult;
export interface HfdManualGraphQOptions {
  displayedText?: string;
  state?: HfdManualGraphQState;
}

/** One native graph event: chart wheel sign or captured-Ctrl vertical sign.
 * c63c7c..de uses configured Double QStep (factory0.04), '#0.000', then an
 * explicit GetValue/Q Double store even for unchanged Text. This profile
 * retains the once-inhibited widget's Extended state separately from fields.
 * Callers ignore zero deltas and reset state on passive/context replacement.
 * These defaults are authoring settings, not import or diagnostic limits. */
export function hfdManualGraphQNext(
  value: number,
  direction: -1 | 1,
  { displayedText, state }: HfdManualGraphQOptions = {},
): HfdManualGraphQResult {
  return adjustManualNumberWheel(value, direction, {
    parameter: 'q',
    profile: 'graph-q',
    displayedText,
    state,
    step: HFD_MANUAL_Q_WHEEL_STEP,
    min: HFD_MANUAL_Q_BOUNDS.min,
    max: HFD_MANUAL_Q_BOUNDS.max,
    places: 3,
    zeroAllowed: false,
    additionalGain: 0,
  });
}
