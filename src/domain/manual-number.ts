/** Internal shared HFD TFloatEdit committed-Text arithmetic. No document or I/O state.
 * Addresses: parser432108/432208/40a648; formatter431dc4/431e27/431eb2;
 * field clamp/zero policyba6ecc. Existing frequency/display/wheel contracts
 * choose their own storage and bounds; this module never changes imports.
 */
export type ManualNumberPlaces = 1 | 2 | 3;
export interface ManualNumberResult {
  text: string;
  value: number;
}
export interface ManualNumberOptions {
  min: number;
  max: number;
  places: ManualNumberPlaces;
  zeroAllowed: boolean;
  previousValue?: number;
  storage: 'single' | 'double';
  label: string;
}
type Ratio = { n: bigint; d: bigint };
const pow2 = (exponent: number) => 1n << BigInt(exponent);
const pow10 = (exponent: number) => 10n ** BigInt(exponent);
const MAX_TEXT = 128;
const MAX_SCALE = 400;
const compare = (a: Ratio, b: Ratio) => a.n * b.d - b.n * a.d;

function nearest(n: bigint, d: bigint, even = true) {
  const sign = n < 0n ? -1n : 1n,
    magnitude = n < 0n ? -n : n,
    whole = magnitude / d,
    twice = (magnitude % d) * 2n;
  return sign * (whole + (twice > d || (twice === d && (!even || whole % 2n !== 0n)) ? 1n : 0n));
}
function exponent(value: Ratio) {
  const magnitude = value.n < 0n ? -value.n : value.n;
  let result = magnitude.toString(2).length - value.d.toString(2).length;
  if (result >= 0 ? magnitude < value.d * pow2(result) : magnitude * pow2(-result) < value.d)
    result--;
  return result;
}
/** 432134 loads CW133f:64-significand bits, nearest/even, not binary64. */
function extended(value: Ratio): Ratio {
  if (value.n === 0n) return { n: 0n, d: 1n };
  const shift = 63 - exponent(value),
    mantissa = nearest(
      shift >= 0 ? value.n * pow2(shift) : value.n,
      shift >= 0 ? value.d : value.d * pow2(-shift),
    );
  return shift >= 0 ? { n: mantissa, d: pow2(shift) } : { n: mantissa * pow2(-shift), d: 1n };
}
function double(value: number): Ratio {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false),
    e = Number((bits >> 52n) & 2047n),
    mantissa = (bits & ((1n << 52n) - 1n)) | (e ? 1n << 52n : 0n),
    shift = (e || 1) - 1023 - 52,
    n = bits >> 63n ? -mantissa : mantissa;
  return shift >= 0 ? { n: n * pow2(shift), d: 1n } : { n, d: pow2(-shift) };
}
/** 40a648 scales using Extended10^(e&31), then10^(32*(e>>5)).
 * Both native tables were checked against nearest/even Extended powers.
 * The bounded exponent never reaches the third512-exponent table. */
function scale(value: Ratio, decimalExponent: number, label = 'Manual number') {
  if (Math.abs(decimalExponent) > MAX_SCALE) throw new Error(`${label} exponent is out of range`);
  const amount = Math.abs(decimalExponent);
  for (const e of [amount & 31, (amount >> 5) * 32]) {
    if (e === 0) continue;
    const factor = extended({ n: pow10(e), d: 1n });
    value = extended(
      decimalExponent < 0
        ? { n: value.n * factor.d, d: value.d * factor.n }
        : { n: value.n * factor.n, d: value.d * factor.d },
    );
  }
  return value;
}
function parse(text: string, label: string) {
  if (
    typeof text !== 'string' ||
    text.length === 0 ||
    text.length > MAX_TEXT ||
    /[^\x20-\x7e]/.test(text)
  )
    throw new Error(`Enter at most128 printable characters for ${label.toLowerCase()}`);
  const match = /^ *([+-]?)(?:(\d+)(?:[.,](\d*))?|[.,](\d+))(?:[eE]([+-]?\d+))? *$/.exec(text);
  if (!match) throw new Error(`Enter a finite decimal ${label.toLowerCase()}`);
  const fraction = match[3] ?? match[4] ?? '',
    explicitExponent = Number(match[5] ?? 0),
    decimalExponent = explicitExponent - fraction.length;
  if (
    !Number.isSafeInteger(explicitExponent) ||
    Math.abs(explicitExponent) > MAX_SCALE ||
    Math.abs(decimalExponent) > MAX_SCALE
  )
    throw new Error(`${label} exponent is out of range`);
  let value: Ratio = { n: 0n, d: 1n };
  // 432208: every digit is FIMUL10 then FIADD, each at x87 precision.
  for (const digit of `${match[2] ?? ''}${fraction}`) {
    value = extended({ n: value.n * 10n, d: value.d });
    value = extended({ n: value.n + BigInt(digit) * value.d, d: value.d });
  }
  value = scale(value, decimalExponent, label);
  return { n: match[1] === '-' ? -value.n : value.n, d: value.d };
}
function fixed(value: Ratio, places: ManualNumberPlaces) {
  if (value.n === 0n) return `0.${'0'.repeat(places)}`;
  // 431e27..431e96: approximate decimal exponent, Extended scale,
  // FRNDINT, optional /10 and FBSTP. 431eb2 carries discarded digit>=5.
  let digits = Math.floor((exponent(value) * 0x4d10) / 65536) + 1;
  const magnitude = { n: value.n < 0n ? -value.n : value.n, d: value.d },
    scaled = scale(magnitude, 18 - digits);
  let mantissa = nearest(scaled.n, scaled.d);
  if (mantissa >= pow10(18)) {
    const divided = extended({ n: mantissa, d: 10n });
    mantissa = nearest(divided.n, divided.d);
    digits++;
  }
  const sign = value.n < 0n ? -1n : 1n,
    decimalExponent = digits - 18 + places,
    rounded =
      decimalExponent >= 0
        ? sign * mantissa * pow10(decimalExponent)
        : nearest(sign * mantissa, pow10(-decimalExponent), false),
    absolute = rounded < 0n ? -rounded : rounded,
    decimalScale = pow10(places);
  return `${rounded < 0n ? '-' : ''}${absolute / decimalScale}.${String(absolute % decimalScale).padStart(places, '0')}`;
}

/** Bounded whole-value commit, distinct from native per-keystroke timing.
 * Grammar: printable ASCII decimal dot/comma and ordinary exponents;128 chars,
 * absolute explicit/net exponent<=400. No special/nonfinite input strings.
 */
export function normalizeManualNumberText(
  text: string,
  { min, max, places, zeroAllowed, previousValue, storage, label }: ManualNumberOptions,
): ManualNumberResult {
  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    Math.abs(min) >= 1e17 ||
    Math.abs(max) >= 1e17 ||
    ![1, 2, 3].includes(places) ||
    !['single', 'double'].includes(storage)
  )
    throw new Error(`Invalid manual ${label.toLowerCase()} bounds or format`);
  let value = parse(text, label);
  if (!zeroAllowed && value.n === 0n) {
    // ba6ee3..ba6ef0 skips exact0, then formats the old internal Value.
    if (
      typeof previousValue !== 'number' ||
      !Number.isFinite(previousValue) ||
      Math.abs(previousValue) >= 1e17
    )
      throw new Error(`Zero ${label.toLowerCase()} requires the previous field value`);
    value = double(previousValue);
  } else {
    const minimum = double(min),
      maximum = double(max);
    if (compare(value, minimum) < 0n) value = minimum;
    else if (compare(value, maximum) > 0n) value = maximum;
  }
  const formatted = fixed(value, places),
    number = Number(formatted),
    stored = storage === 'single' ? Math.fround(number) : number;
  if (!Number.isFinite(stored))
    throw new Error(`${label} cannot be stored as ${storage === 'single' ? 'Single' : 'Double'}`);
  return { text: formatted, value: stored };
}

/** Passive native unbounded Value formatting from an existing Double.
 * Does not parse String(value), clamp, cast storage or mutate the model. */
export function formatManualNumberValue(value: number, places: ManualNumberPlaces): string {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e17 || ![1, 2, 3].includes(places)) return '';
  return fixed(double(value), places);
}
