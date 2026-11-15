import { formatManualNumberValue, normalizeManualNumberText } from './manual-number';

/** Native factory Settings.xml: a86e16/a86e48 and a86f1e/a86f92.
 * Runtime fields use configuration values; these are the ordinary FA503 defaults,
 * not import, filter-math, Input EQ, channel gain or hardware-control limits. */
export const HFD_MANUAL_Q_BOUNDS = Object.freeze({ min: 0.1, max: 20 });
export const HFD_MANUAL_GAIN_BOUNDS = Object.freeze({ min: -125, max: 24 });

export interface HfdManualParameterOptions {
  /** Effective widget bounds. Native raw gain configuration first formats0.#. */
  min?: number;
  max?: number;
  /** Q's exact0 restores its prior widget Value; gain accepts0 normally. */
  previousValue?: number;
}
export interface HfdManualParameterResult {
  text: string;
  value: number;
}

/** Ordinary output Q1/Q2: c64a3c/c64a78 ->c64990, '#0.000', Double store.
 * Only an explicit whole-value commit; untouched imported metadata stays raw. */
export function normalizeHfdManualQText(
  text: string,
  {
    min = HFD_MANUAL_Q_BOUNDS.min,
    max = HFD_MANUAL_Q_BOUNDS.max,
    previousValue,
  }: HfdManualParameterOptions = {},
): HfdManualParameterResult {
  return normalizeManualNumberText(text, {
    min,
    max,
    previousValue,
    places: 3,
    zeroAllowed: false,
    storage: 'double',
    label: 'Q',
  });
}

/** Ordinary output BQ gain: c63e18 ->c64990, '#0.00', zero allowed, Double.
 * Fusion-family max uses FMaxGainFA; Input EQ/hardware gains are separate. */
export function normalizeHfdManualGainText(
  text: string,
  {
    min = HFD_MANUAL_GAIN_BOUNDS.min,
    max = HFD_MANUAL_GAIN_BOUNDS.max,
    previousValue,
  }: HfdManualParameterOptions = {},
): HfdManualParameterResult {
  return normalizeManualNumberText(text, {
    min,
    max,
    previousValue,
    places: 2,
    zeroAllowed: true,
    storage: 'double',
    label: 'Gain',
  });
}

/** Passive native unbounded Value display from the existing Double.
 * No clamp, storage cast, raw-text reinterpretation or canonical mutation. */
export function formatHfdManualQValue(value: number): string {
  return formatManualNumberValue(value, 3);
}
export function formatHfdManualGainValue(value: number): string {
  return formatManualNumberValue(value, 2);
}
