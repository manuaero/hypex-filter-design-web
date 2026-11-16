import type { Channel } from './model';
import { formatManualNumberValue, normalizeManualNumberText } from './manual-number';

type HardwareGainChannel = Readonly<Pick<Channel, 'gain' | 'additionalGain'>>;

/** Offline FA503 factory channel-field profile (c69020/c6d3dc/c6d4d0).
 * This is design compensation, not a live amplifier gain/attenuation command. */
export const HFD_CHANNEL_GAIN_BOUNDS = Object.freeze({ min: -125, max: 24 });

export interface HardwareGainPresentation {
  /** Fresh native visibility. A trusted view can retain visibility after Off. */
  available: boolean;
  checked: boolean;
  gainText: string;
}

export interface HardwareGainCallbackOptions {
  /** Trusted current widget Text; omitted means a fresh passive presentation. */
  gainText?: string;
}

export interface HardwareGainCallbackResult {
  gain: number;
  additionalGain: 0 | 10;
  /** Native device-level hint from this channel, never an OR over all channels. */
  hfdGainLowered: boolean;
  gainText: string;
}

function validate(channel: HardwareGainChannel) {
  if (!Number.isFinite(channel.gain) || !Number.isFinite(channel.additionalGain ?? 0))
    throw new Error('Channel gain and AdditionalGain must be finite');
}

/** c72ae0 -> c60826 -> c69020: stored Double -> Single -> bounded #0.00.
 * Only presentation is rounded; passive import/canonical values stay untouched. */
export function hardwareGainPresentation(channel: HardwareGainChannel): HardwareGainPresentation {
  validate(channel);
  const { min, max } = HFD_CHANNEL_GAIN_BOUNDS,
    value = Math.min(max, Math.max(min, Math.fround(channel.gain))),
    nonzero = (channel.additionalGain ?? 0) !== 0;
  return {
    available: nonzero,
    checked: nonzero,
    gainText: formatManualNumberValue(value, 2),
  };
}

/** cbGainLoweredChange c63244 -> c64b74. Admission/visible-context ownership is
 * the caller's responsibility. The callback normalizes ordinary channel Gain,
 * then explicitly reparses/stores its capped Text as Double (c64c21..c64c37).
 * Unlike the BQ wheel postguard, the cap therefore changes canonical Gain.
 * This detached patch preserves every filter/cache and performs no I/O. */
export function normalizeHardwareGainCallback(
  channel: HardwareGainChannel,
  checked: boolean,
  options: HardwareGainCallbackOptions = {},
): HardwareGainCallbackResult {
  validate(channel);
  if (typeof checked !== 'boolean')
    throw new Error('Hardware gain compensation requires a boolean');
  const normalize = (text: string) =>
      normalizeManualNumberText(text, {
        ...HFD_CHANNEL_GAIN_BOUNDS,
        places: 2,
        zeroAllowed: true,
        storage: 'double',
        label: 'Channel gain',
      }),
    additionalGain = checked ? 10 : 0,
    text = options.gainText ?? hardwareGainPresentation(channel).gainText;
  let gain = normalize(text);
  // In this explicit factory profile Maximum24 and AdditionalGain0/10 are exact
  // integers. Comparing the parsed Double to24-AdditionalGain is equivalent to
  // c64bb5's Extended sum/compare, without introducing a binary64 addition stage.
  const ceiling = HFD_CHANNEL_GAIN_BOUNDS.max - additionalGain;
  if (gain.value > ceiling) gain = normalize(String(ceiling));
  return {
    gain: gain.value,
    additionalGain,
    hfdGainLowered: additionalGain !== 0,
    gainText: gain.text,
  };
}
