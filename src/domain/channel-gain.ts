import {
  adjustManualNumberWheel,
  formatManualNumberValue,
  normalizeManualChannelGainText,
  type ManualNumberWheelState,
} from './manual-number';

/** Installed FA503 runtime configuration, not live master-volume limits. */
export const HFD_CHANNEL_GAIN_BOUNDS = Object.freeze({ min: -125, max: 24 });
export const HFD_CHANNEL_GAIN_PROFILE = Object.freeze({
  bounds: HFD_CHANNEL_GAIN_BOUNDS,
  step: 0.1,
  places: 2,
});
export interface HfdChannelGainResult {
  text: string;
  value: number;
}
export interface HfdChannelGainTextOptions {
  additionalGain?: number;
  /** Compatibility with field commit ports. Gain accepts zero; no restore. */
  previousValue?: number;
}
declare const channelWheelBrand: unique symbol;
export interface HfdChannelGainWheelState {
  readonly [channelWheelBrand]: true;
}
export interface HfdChannelGainWheelOptions {
  additionalGain?: number;
  displayedText?: string;
  state?: HfdChannelGainWheelState;
}
export interface HfdChannelGainWheelResult extends HfdChannelGainResult {
  changed: boolean;
  state: HfdChannelGainWheelState;
}
const states = new WeakMap<
  HfdChannelGainWheelState,
  {
    internal: ManualNumberWheelState;
    additionalGain: number;
    text: string;
  }
>();

/** c60826 -> c69020: bounded passive Single presentation, no model rewrite. */
export function formatHfdChannelGainValue(value: number): string {
  if (!Number.isFinite(value)) return '';
  return formatManualNumberValue(
    Math.min(
      HFD_CHANNEL_GAIN_BOUNDS.max,
      Math.max(HFD_CHANNEL_GAIN_BOUNDS.min, Math.fround(value)),
    ),
    2,
  );
}

/** Explicit whole-Text c64b74 callback. The AdditionalGain cap uses Extended
 * SetValue, then reparses final Text to Double. Keystroke timing is separate. */
export function normalizeHfdChannelGainText(
  text: string,
  { additionalGain = 0 }: HfdChannelGainTextOptions = {},
): HfdChannelGainResult {
  return normalizeManualChannelGainText(text, { ...HFD_CHANNEL_GAIN_BOUNDS, additionalGain });
}

/** One sign-only factory wheel event. A changed-Text notification publishes the
 * channel callback's final capped Double. Without that notification, the shared
 * late guard can change Text alone; final Text equality is not model equality.
 * This private channel state is distinct from BQ/graph/Input-EQ wheel state. */
export function hfdChannelGainWheelNext(
  value: number,
  direction: -1 | 1,
  { additionalGain = 0, displayedText, state }: HfdChannelGainWheelOptions = {},
): HfdChannelGainWheelResult {
  const previous = state === undefined ? undefined : states.get(state);
  if (state !== undefined && (!previous || !Object.is(previous.additionalGain, additionalGain)))
    throw new Error('Channel gain wheel state does not match the current field context');
  const result = adjustManualNumberWheel(value, direction, {
    profile: 'channel-gain',
    parameter: 'gain',
    ...HFD_CHANNEL_GAIN_BOUNDS,
    places: 2,
    step: HFD_CHANNEL_GAIN_PROFILE.step,
    zeroAllowed: true,
    additionalGain,
    displayedText: displayedText ?? previous?.text ?? formatHfdChannelGainValue(value),
    state: previous?.internal,
  });
  const next = Object.freeze({}) as HfdChannelGainWheelState;
  states.set(next, { internal: result.state, additionalGain, text: result.text });
  return { text: result.text, value: result.value, changed: result.changed, state: next };
}
