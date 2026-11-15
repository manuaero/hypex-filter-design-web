/** Native wheel handlers use direction, never the wheel-delta magnitude. */
export type FrequencyWheelDirection = -1 | 1;
function validate(frequency: number, direction: FrequencyWheelDirection) {
  if (!Number.isFinite(frequency)) throw new Error('Frequency must be finite');
  if (direction !== -1 && direction !== 1) throw new Error('Invalid wheel direction');
}

/** HFD input EQ feFrequencyMouseWheel (cee9e4). Exact thresholds belong to
 * different decades depending on direction. No snapping or display rounding. */
export function hfdEqFrequencyWheelDelta(
  frequency: number,
  direction: FrequencyWheelDirection,
): number {
  validate(frequency, direction);
  const before = (boundary: number) =>
    direction > 0 ? frequency < boundary : frequency <= boundary;
  return direction * (before(100) ? 1 : before(1000) ? 10 : before(10000) ? 100 : 1000);
}

/** Advanced feFreqMouseWheel c64ab4 stores its continuous delta as Single.
 * This is the raw delta, before FloatEdit formatting/clamping/reparse. */
export function hfdAdvancedFrequencyWheelDelta(
  frequency: number,
  direction: FrequencyWheelDirection,
  frequencyStep = 100,
): number {
  validate(frequency, direction);
  if (frequency <= 0) throw new Error('Advanced frequency must be positive');
  if (!Number.isFinite(frequencyStep) || frequencyStep <= 0)
    throw new Error('Frequency step must be finite and positive');
  const delta = Math.fround(
    4 * Math.LN10 * Math.exp(Math.log10(frequency) - Math.log10(frequencyStep) + 1),
  );
  if (!Number.isFinite(delta)) throw new Error('Frequency wheel delta is not finite');
  return direction * delta;
}

interface Ratio {
  n: bigint;
  d: bigint;
}
const power10 = (count: number) => 10n ** BigInt(count);
function exactDouble(value: number): Ratio {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false),
    exponent = Number((bits >> 52n) & 2047n),
    mantissa = (bits & ((1n << 52n) - 1n)) | (exponent ? 1n << 52n : 0n),
    shift = (exponent || 1) - 1023 - 52,
    n = bits >> 63n ? -mantissa : mantissa;
  return shift >= 0 ? { n: n << BigInt(shift), d: 1n } : { n, d: 1n << BigInt(-shift) };
}
const addRatio = (a: Ratio, b: Ratio): Ratio => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const less = (a: Ratio, b: Ratio) => a.n * b.d < b.n * a.d;
function nearestInteger(n: bigint, d: bigint, even: boolean) {
  const sign = n < 0n ? -1n : 1n,
    abs = n < 0n ? -n : n,
    whole = abs / d,
    remainder = (abs % d) * 2n;
  return (
    sign * (whole + (remainder > d || (remainder === d && (!even || whole % 2n !== 0n)) ? 1n : 0n))
  );
}
/** FloatToDecimal431e27 first obtains18 significant digits (FRNDINT with
 * nearest/even), then431eb2 rounds at the requested decimal by >= '5'.
 * Exact ratios avoid JS binary64 additions creating a false decimal half tie.
 * Frequencies use the ordinary non-exponent '#0.0' path, far below1e18. */
function decimal18(value: Ratio): Ratio {
  if (value.n === 0n) return value;
  const abs = value.n < 0n ? -value.n : value.n;
  let digits = abs.toString().length - value.d.toString().length + 1;
  const atPower = digits - 1 >= 0 ? value.d * power10(digits - 1) : value.d;
  if (digits - 1 >= 0 ? abs < atPower : abs * power10(1 - digits) < atPower) digits--;
  const shift = 18 - digits;
  if (shift >= 0) {
    const scale = power10(shift);
    return { n: nearestInteger(value.n * scale, value.d, true), d: scale };
  }
  const scale = power10(-shift);
  return { n: nearestInteger(value.n, value.d * scale, true) * scale, d: 1n };
}
function tenths(value: Ratio) {
  const rounded = decimal18(value);
  return nearestInteger(rounded.n * 10n, rounded.d, false);
}

/** The native advanced frequency field displays '#0.0'. This changes text,
 * not an imported canonical frequency, until an explicit wheel edit commits. */
export function formatHfdAdvancedFrequency(value: number): string {
  if (!Number.isFinite(value)) return '';
  const tenth = tenths(exactDouble(value)),
    abs = tenth < 0n ? -tenth : tenth;
  return `${tenth < 0n ? '-' : ''}${abs / 10n}.${abs % 10n}`;
}

export interface AdvancedFrequencyWheelOptions {
  min?: number;
  max?: number;
  /** Settings.xml freqstep / configuration.FFreqStep; native factory100. */
  frequencyStep?: number;
}
/** Native advanced wheel recurrence: displayed '#0.0' value→Single delta→
 * AddValue zero avoidance→bounds→18-digit decimal formatting→text parse→
 * Single model storage (c62eb7/c62ed8/c62f63/c62f84). Manual browser typing
 * and keyboard steps are independent of this wheel-only contract. */
export function hfdAdvancedFrequencyWheelNext(
  frequency: number,
  direction: FrequencyWheelDirection,
  { min = 1, max = 50000, frequencyStep = 100 }: AdvancedFrequencyWheelOptions = {},
): number {
  validate(frequency, direction);
  if (frequency <= 0) throw new Error('Advanced frequency must be positive');
  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    min <= 0 ||
    min >= 1e17 ||
    max <= 0 ||
    max >= 1e17
  )
    throw new Error('Invalid native frequency wheel bounds');
  const current = frequency,
    shown = tenths(exactDouble(current)),
    displayedFrequency = Number(shown) / 10;
  const delta = hfdAdvancedFrequencyWheelDelta(displayedFrequency, direction, frequencyStep);
  if (delta === 0) return frequency; // AddValue's zero-delta early return.
  const rawDelta = exactDouble(delta),
    // ba6aaf compares Format(internalValue+delta) to Format(0), not Format(current).
    doubled = tenths(addRatio(exactDouble(current), rawDelta)) === 0n,
    amount = { ...rawDelta, n: rawDelta.n * (doubled ? 2n : 1n) };
  let candidate = addRatio({ n: shown, d: 10n }, amount);
  if (candidate.n === 0n)
    candidate = exactDouble(current); // ZeroValueAllowed=false.
  else if (less(candidate, exactDouble(min))) candidate = exactDouble(min);
  else if (less(exactDouble(max), candidate)) candidate = exactDouble(max);
  return Math.fround(Number(tenths(candidate)) / 10);
}
