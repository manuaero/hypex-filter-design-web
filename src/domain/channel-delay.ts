import {
  adjustManualChannelDelayWheel,
  formatManualChannelDelayMaximum,
  formatManualChannelDelayValue,
  normalizeManualChannelDelayText,
  readManualChannelDelayText,
  type ManualChannelDelayWheelState,
} from './manual-number';

/** Trusted field context. Resolve native runtime bounds separately; in
 * particular,32000 is not a universal offline FA503 local maximum. */
export interface HfdChannelDelayProfile {
  readonly kind: 'local' | 'global';
  readonly unit: 'us';
  readonly sampleRate: number;
  readonly minimumText: '0';
  /** Native MaximumValueString (general formatting precision15), not a
   * caller-selected preference or a guessed maximum. */
  readonly maximumText: string;
}
export interface HfdChannelDelayResult {
  text: string;
  value: number;
  maximumValue: number;
}
export interface HfdChannelDelayTextOptions {
  profile: Readonly<HfdChannelDelayProfile>;
}

/** Native MaximumValueString's general15 boundary, with invariant ASCII dot.
 * This formats a trusted maximum Double; it does not select runtime bounds. */
export function formatHfdChannelDelayMaximum(value: number): string {
  return formatManualChannelDelayMaximum(value);
}

/** Direct finite Text getter for current Global-value propagation. There is
 * no profile, bounds, display formatting or sample quantization in this path. */
export function readHfdChannelDelayText(text: string): number {
  return readManualChannelDelayText(text);
}
declare const channelDelayWheelBrand: unique symbol;
export interface HfdChannelDelayWheelState {
  readonly [channelDelayWheelBrand]: true;
}
export interface HfdChannelDelayWheelOptions extends HfdChannelDelayTextOptions {
  displayedText?: string;
  state?: HfdChannelDelayWheelState;
}
export interface HfdChannelDelayWheelResult {
  text: string;
  value: number;
  changed: boolean;
  /** MaxDelay/global callback side effects can occur even if value is equal. */
  notified: boolean;
  maximumValue?: number;
  state: HfdChannelDelayWheelState;
}
const states = new WeakMap<
  HfdChannelDelayWheelState,
  {
    internal: ManualChannelDelayWheelState;
    profile: HfdChannelDelayProfile;
  }
>();
function checkedProfile(profile: Readonly<HfdChannelDelayProfile>): HfdChannelDelayProfile {
  if (
    !profile ||
    !['local', 'global'].includes(profile.kind) ||
    profile.unit !== 'us' ||
    profile.minimumText !== '0'
  )
    throw new Error('A trusted microsecond Delay profile is required');
  return { ...profile };
}
const sameProfile = (a: HfdChannelDelayProfile, b: HfdChannelDelayProfile) =>
  a.kind === b.kind &&
  a.unit === b.unit &&
  Object.is(a.sampleRate, b.sampleRate) &&
  a.minimumText === b.minimumText &&
  a.maximumText === b.maximumText;

/** Whole-Text callback only; passive import, view entry and global fanout are
 * separate services. Both returned Delay and Maximum are native Doubles. */
export function normalizeHfdChannelDelayText(
  text: string,
  { profile }: HfdChannelDelayTextOptions,
): HfdChannelDelayResult {
  return normalizeManualChannelDelayText(text, checkedProfile(profile));
}

/** Bounded passive Single presentation. Never sample-quantizes or mutates the
 * canonical document, MaxDelay or any other channel. */
export function formatHfdChannelDelayValue(
  value: number,
  { profile }: HfdChannelDelayTextOptions,
): string {
  return formatManualChannelDelayValue(value, checkedProfile(profile));
}

/** One signed wheel event. Reset state on external/context/Text changes;
 * preserve it across acknowledged own events, including canonical no-ops. */
export function hfdChannelDelayWheelNext(
  value: number,
  direction: -1 | 1,
  { profile, displayedText, state }: HfdChannelDelayWheelOptions,
): HfdChannelDelayWheelResult {
  const current = checkedProfile(profile),
    previous = state === undefined ? undefined : states.get(state);
  if (state !== undefined && (!previous || !sameProfile(previous.profile, current)))
    throw new Error('Delay wheel state does not match the current profile context');
  const result = adjustManualChannelDelayWheel(value, direction, {
    ...current,
    displayedText,
    state: previous?.internal,
  });
  const next = Object.freeze({}) as HfdChannelDelayWheelState;
  states.set(next, { internal: result.state, profile: current });
  return { ...result, state: next };
}
