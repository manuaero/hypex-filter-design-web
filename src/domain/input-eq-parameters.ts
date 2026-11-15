import {
  adjustManualNumberWheel,
  formatManualNumberValue,
  normalizeManualNumberText,
  type ManualNumberResult,
  type ManualNumberWheelResult,
  type ManualNumberWheelState,
} from './manual-number';

export type HfdInputEqParameter = 'frequency' | 'q' | 'gain';

/** TFRMEQUALIZER/FormShow cef728 installs these fixed authoring limits and
 * steps. They are not metadata/codec limits or ordinary output-BQ settings. */
export const HFD_INPUT_EQ_PROFILE = Object.freeze({
  frequency: Object.freeze({
    min: 10,
    max: 50000,
    places: 1,
    zeroAllowed: false,
    wheelStep: 'decade',
  } as const),
  q: Object.freeze({ min: 0.1, max: 20, places: 3, zeroAllowed: false, wheelStep: 0.04 } as const),
  gain: Object.freeze({
    min: -15.9,
    max: 15.9,
    places: 2,
    zeroAllowed: true,
    wheelStep: 0.1,
  } as const),
});

// The decimal parser reproduces the exact literal Extended bounds pushed by
// cef80a/cef83b..898. In particular0.1 and15.9 are not promoted binary64 bounds.
const extendedBounds = {
  frequency: { min: '10', max: '50000' },
  q: { min: '0.1', max: '20' },
  gain: { min: '-15.9', max: '15.9' },
} as const;

function profile(parameter: HfdInputEqParameter) {
  if (!Object.hasOwn(HFD_INPUT_EQ_PROFILE, parameter))
    throw new Error('Invalid Input EQ parameter');
  return HFD_INPUT_EQ_PROFILE[parameter];
}

export interface HfdInputEqTextOptions {
  previousValue?: number;
}
export type HfdInputEqWheelState = ManualNumberWheelState;
export type HfdInputEqWheelResult = ManualNumberWheelResult;
export interface HfdInputEqWheelOptions {
  displayedText?: string;
  state?: HfdInputEqWheelState;
}

/** Explicit whole-Text commit: cee9b0 normalizes Extended Text, then
 * cee96c/ceeb38/ceebdc reparse it and store all three fields as Double.
 * This does not emulate per-keystroke timing or normalize imported values. */
export function normalizeHfdInputEqText(
  parameter: HfdInputEqParameter,
  text: string,
  { previousValue }: HfdInputEqTextOptions = {},
): ManualNumberResult {
  const field = profile(parameter);
  return normalizeManualNumberText(text, {
    min: field.min,
    max: field.max,
    places: field.places,
    zeroAllowed: field.zeroAllowed,
    previousValue,
    storage: 'double',
    label: `Input EQ ${parameter}`,
    extendedBounds: extendedBounds[parameter],
  });
}

/** Passive unbounded Double display only. Native selection ced138 can invoke
 * Text-change-dependent normalization; that separate lifecycle still needs
 * popup acceptance and is not silently applied by this formatter. */
export function formatHfdInputEqValue(parameter: HfdInputEqParameter, value: number): string {
  return formatManualNumberValue(value, profile(parameter).places);
}

/** One signed EQ wheel event: cee9e4/ceeb7c/ceec20. Magnitude is not a count;
 * browser delta0 is not an event. Reuses FloatEdit's private Extended state,
 * bounds, zero avoidance and changed-Text callback. No channel AdditionalGain
 * postguard exists here. Reset opaque state on external/context/Text changes. */
export function hfdInputEqWheelNext(
  parameter: HfdInputEqParameter,
  value: number,
  direction: -1 | 1,
  { displayedText, state }: HfdInputEqWheelOptions = {},
): HfdInputEqWheelResult {
  const field = profile(parameter);
  return adjustManualNumberWheel(value, direction, {
    parameter,
    profile: 'input-eq',
    displayedText,
    state,
    step: field.wheelStep,
    min: field.min,
    max: field.max,
    places: field.places,
    zeroAllowed: field.zeroAllowed,
    additionalGain: 0,
    extendedBounds: extendedBounds[parameter],
  });
}
