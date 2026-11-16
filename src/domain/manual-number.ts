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
  /** Source literal80-bit bounds, distinct from promoted configuration Doubles. */
  extendedBounds?: { readonly min: string; readonly max: string };
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
function fixed(value: Ratio, places: ManualNumberPlaces | 0) {
  if (value.n === 0n) return places === 0 ? '0' : `0.${'0'.repeat(places)}`;
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
  const whole = `${rounded < 0n ? '-' : ''}${absolute / decimalScale}`;
  return places === 0 ? whole : `${whole}.${String(absolute % decimalScale).padStart(places, '0')}`;
}

function numberBounds(
  min: number,
  max: number,
  literals: ManualNumberOptions['extendedBounds'],
  label: string,
) {
  const minimum = literals ? parse(literals.min, label) : double(min),
    maximum = literals ? parse(literals.max, label) : double(max);
  if (literals && (!Object.is(storeDouble(minimum), min) || !Object.is(storeDouble(maximum), max)))
    throw new Error(`Invalid manual ${label.toLowerCase()} literal bounds`);
  return { minimum, maximum };
}

/** Bounded whole-value commit, distinct from native per-keystroke timing.
 * Grammar: printable ASCII decimal dot/comma and ordinary exponents;128 chars,
 * absolute explicit/net exponent<=400. No special/nonfinite input strings.
 */
export function normalizeManualNumberText(
  text: string,
  {
    min,
    max,
    places,
    zeroAllowed,
    previousValue,
    storage,
    label,
    extendedBounds,
  }: ManualNumberOptions,
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
  const { minimum, maximum } = numberBounds(min, max, extendedBounds, label);
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

declare const wheelStateBrand: unique symbol;
/** Opaque transient FloatEdit state. No numeric representation is public. */
export interface ManualNumberWheelState {
  readonly [wheelStateBrand]: true;
}
export interface ManualNumberWheelOptions {
  parameter: 'frequency' | 'q' | 'gain';
  profile?: 'ordinary' | 'input-eq' | 'graph-q' | 'channel-gain';
  displayedText?: string;
  state?: ManualNumberWheelState;
  step: number | 'decade';
  min: number;
  max: number;
  places: ManualNumberPlaces;
  zeroAllowed: boolean;
  additionalGain: number;
  extendedBounds?: { readonly min: string; readonly max: string };
}
export interface ManualNumberWheelResult extends ManualNumberResult {
  changed: boolean;
  state: ManualNumberWheelState;
}
interface WheelMemory {
  internal: Ratio;
  text: string;
  value: number;
  parameter: 'frequency' | 'q' | 'gain';
  profile: 'ordinary' | 'input-eq' | 'graph-q' | 'channel-gain';
}
const wheelMemory = new WeakMap<ManualNumberWheelState, WheelMemory>();
const addExtended = (a: Ratio, b: Ratio) => extended({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });

function additionalGainCeiling(
  text: string,
  additionalGain: number,
  maximum: Ratio,
  setValue: (candidate: Ratio) => void,
) {
  const parsed = storeDouble(parse(text, 'Channel gain'));
  if (!Number.isFinite(parsed)) throw new Error('Channel gain cannot be stored as Double');
  if (compare(addExtended(double(parsed), double(additionalGain)), maximum) > 0n)
    setValue(addExtended(maximum, double(-additionalGain)));
}

/** Internal c64b74 channel callback; no Single narrowing in its cap setter.
 * c64bf0..c64c03 passes Maximum(Extended)-AdditionalGain(Double) as Extended
 * directly to ba6ecc, before its explicit final Text-to-Double getter. */
export function normalizeManualChannelGainText(
  text: string,
  { min, max, additionalGain }: { min: number; max: number; additionalGain: number },
): ManualNumberResult {
  if (!Number.isFinite(additionalGain) || min > max)
    throw new Error('Channel gain requires finite compensation and valid bounds');
  let result = normalizeManualNumberText(text, {
    min,
    max,
    places: 2,
    zeroAllowed: true,
    storage: 'double',
    label: 'Channel gain',
  });
  const { minimum, maximum } = numberBounds(min, max, undefined, 'Channel gain');
  additionalGainCeiling(result.text, additionalGain, maximum, (candidate) => {
    const bounded =
      compare(candidate, minimum) < 0n
        ? minimum
        : compare(candidate, maximum) > 0n
          ? maximum
          : candidate;
    const text = fixed(bounded, 2);
    result = { text, value: storeDouble(parse(text, 'Channel gain')) };
  });
  return result;
}

/** Extended->Double store, including subnormal rounding. Kept private so callers
 * cannot accidentally replace native Extended addition with binary64 addition. */
function storeDouble(value: Ratio): number {
  if (value.n === 0n) return 0;
  const e = exponent(value),
    shift = e < -1022 ? 1074 : 52 - e,
    mantissa = nearest(
      shift >= 0 ? value.n * pow2(shift) : value.n,
      shift >= 0 ? value.d : value.d * pow2(-shift),
    );
  return Number(mantissa) * 2 ** -shift;
}

/** One x87 FSTP Single, including its subnormal rounding. A binary64 store
 * before this narrowing can cross a Float32 midpoint and is not equivalent. */
function storeSingle(value: Ratio): number {
  if (value.n === 0n) return 0;
  const e = exponent(value),
    shift = e < -126 ? 149 : 23 - e,
    mantissa = nearest(
      shift >= 0 ? value.n * pow2(shift) : value.n,
      shift >= 0 ? value.d : value.d * pow2(-shift),
    );
  return Math.fround(Number(mantissa) * 2 ** -shift);
}

export interface ManualChannelDelayOptions {
  sampleRate: number;
  /** Exact native MaximumValueString, parsed into an Extended bound. */
  maximumText: string;
}

/** ba6e08 then FSTP qword at c641d9/c643ed. Current Global Text is
 * propagated directly; this getter does not clamp or sample-quantize. */
export function readManualChannelDelayText(text: string): number {
  const value = storeDouble(parse(text, 'Delay'));
  if (!Number.isFinite(value)) throw new Error('Delay Text cannot be stored as finite Double');
  return value;
}

/** 4322c4 -> 431730/43185a: native general precision15, from a Double.
 * Keep its initial18-digit x87 stage before decimal carry; direct binary64
 * toPrecision(15) can round the other way. ASCII decimal separator only. */
export function formatManualChannelDelayMaximum(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value >= 1e17)
    throw new Error('Delay maximum must be finite, nonnegative and below1e17');
  if (value === 0) return '0';
  const ratio = double(value);
  let digits = Math.floor((exponent(ratio) * 0x4d10) / 65536) + 1;
  const scaled = scale(ratio, 18 - digits);
  let mantissa = nearest(scaled.n, scaled.d);
  if (mantissa >= pow10(18)) {
    const divided = extended({ n: mantissa, d: 10n });
    mantissa = nearest(divided.n, divided.d);
    digits++;
  }
  // 431ead..ed7: discarded decimal digit>=5 carries, then trailing zeros
  // are removed. This carry is distinct from the first nearest-even FRNDINT.
  let significant = nearest(mantissa, 1000n, false);
  if (significant >= pow10(15)) {
    significant /= 10n;
    digits++;
  }
  const text = significant.toString().replace(/0+$/, '');
  // D is the decimal-point position. General format uses fixed notation for
  // -3<=D<=15; otherwise uppercaseE, no positive sign or exponent padding.
  if (digits < -3 || digits > 15)
    return `${text[0]}${text.length > 1 ? `.${text.slice(1)}` : ''}E${digits - 1}`;
  if (digits <= 0) return `0.${'0'.repeat(-digits)}${text}`;
  if (text.length <= digits) return text + '0'.repeat(digits - text.length);
  return `${text.slice(0, digits)}.${text.slice(digits)}`;
}

export interface ManualChannelDelayResult extends ManualNumberResult {
  maximumValue: number;
}
declare const delayWheelBrand: unique symbol;
export interface ManualChannelDelayWheelState {
  readonly [delayWheelBrand]: true;
}
export interface ManualChannelDelayWheelResult extends ManualNumberResult {
  changed: boolean;
  notified: boolean;
  maximumValue?: number;
  state: ManualChannelDelayWheelState;
}
interface DelayContext {
  sampleRate: Ratio;
  maximum: Ratio;
  maximumValue: number;
}
function delayContext({ sampleRate, maximumText }: ManualChannelDelayOptions): DelayContext {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate >= 1e17)
    throw new Error('Delay requires a finite positive sample rate');
  const maximum = parse(maximumText, 'Delay maximum'),
    maximumValue = storeDouble(maximum);
  if (!Number.isFinite(maximumValue) || maximum.n < 0n || maximumValue >= 1e17)
    throw new Error('Delay requires a finite nonnegative maximum');
  return { sampleRate: double(sampleRate), maximum, maximumValue };
}
const delayMillion: Ratio = { n: 1000000n, d: 1n };
const multiplyExtended = (a: Ratio, b: Ratio) => extended({ n: a.n * b.n, d: a.d * b.d });
const divideExtended = (a: Ratio, b: Ratio) => extended({ n: a.n * b.d, d: a.d * b.n });
const roundExtendedInteger = (value: Ratio): Ratio => ({ n: nearest(value.n, value.d), d: 1n });
function boundDelay(value: Ratio, maximum: Ratio): Ratio {
  // ba6ecc: minimum is tested first; zero is allowed on both Delay fields.
  return value.n < 0n ? { n: 0n, d: 1n } : compare(value, maximum) > 0n ? maximum : value;
}
function delayCallback(text: string, context: DelayContext) {
  // c64990 first normalizes current Text through bounded fixed0 SetValue.
  const normalized = parse(fixed(boundDelay(parse(text, 'Delay'), context.maximum), 0), 'Delay');
  // c63e93..eb3/c63fcd..fed: Extended arithmetic and nearest-even RoundTo0,
  // followed by the explicit qword sample-count store. No Single stage.
  const samples = double(
    storeDouble(
      roundExtendedInteger(
        divideExtended(multiplyExtended(normalized, context.sampleRate), delayMillion),
      ),
    ),
  );
  const microseconds = roundExtendedInteger(
    divideExtended(multiplyExtended(samples, delayMillion), context.sampleRate),
  );
  // The second bounded setter can format a fractional maximum upward. The
  // explicit final Text getter is authoritative; there is no later clamp.
  const internal = boundDelay(microseconds, context.maximum),
    formatted = fixed(internal, 0);
  return { text: formatted, value: storeDouble(parse(formatted, 'Delay')), internal };
}

/** c64990 -> c63e60/c63fa4 -> c73220: explicit callback publication.
 * Delay and MaxDelay are independent qword stores (a8d924 and a8d970). */
export function normalizeManualChannelDelayText(
  text: string,
  options: ManualChannelDelayOptions,
): ManualChannelDelayResult {
  const context = delayContext(options),
    result = delayCallback(text, context);
  return { text: result.text, value: result.value, maximumValue: context.maximumValue };
}

/** c6084a/c6085a -> c69500: passive Single arguments, bounded fixed0 display.
 * This does not run the sample callback or publish a canonical value. */
export function formatManualChannelDelayValue(
  value: number,
  options: ManualChannelDelayOptions,
): string {
  const context = delayContext(options);
  if (!Number.isFinite(value) || Math.abs(value) >= 1e17) return '';
  return fixed(boundDelay(double(storeSingle(double(value))), context.maximum), 0);
}

const delayWheelMemory = new WeakMap<
  ManualChannelDelayWheelState,
  {
    internal: Ratio;
    text: string;
    value: number;
    sampleRate: number;
    maximumText: string;
  }
>();

/** c64228: one signed Double(Extended(1e6/Fs)) AddValue event. Only a
 * changed formatted Text notifies the callback; no unconditional getter. */
export function adjustManualChannelDelayWheel(
  value: number,
  direction: -1 | 1,
  options: ManualChannelDelayOptions & {
    displayedText?: string;
    state?: ManualChannelDelayWheelState;
  },
): ManualChannelDelayWheelResult {
  const context = delayContext(options);
  if (!Number.isFinite(value) || Math.abs(value) >= 1e17 || (direction !== -1 && direction !== 1))
    throw new Error('Invalid delay wheel value or direction');
  const previous = options.state === undefined ? undefined : delayWheelMemory.get(options.state);
  if (
    options.state !== undefined &&
    (!previous ||
      !Object.is(previous.value, value) ||
      !Object.is(previous.sampleRate, options.sampleRate) ||
      previous.maximumText !== options.maximumText)
  )
    throw new Error('Delay wheel state does not match the field value or profile context');
  const before =
    options.displayedText ?? previous?.text ?? formatManualChannelDelayValue(value, options);
  if (previous && before !== previous.text)
    throw new Error('Delay wheel state does not match displayed Text');
  const parsed = parse(before, 'Delay');
  if (!Number.isFinite(storeDouble(parsed)))
    throw new Error('Delay Text cannot be stored as Double');
  const step = storeDouble(divideExtended(delayMillion, context.sampleRate));
  if (!Number.isFinite(step)) throw new Error('Delay wheel step cannot be stored as Double');
  let internal = boundDelay(addExtended(parsed, double(direction * step)), context.maximum),
    text = fixed(internal, 0),
    model = value;
  const notified = text !== before;
  if (notified) {
    const callback = delayCallback(text, context);
    internal = callback.internal;
    text = callback.text;
    model = callback.value;
  }
  const state = Object.freeze({}) as ManualChannelDelayWheelState;
  delayWheelMemory.set(state, {
    internal,
    text,
    value: model,
    sampleRate: options.sampleRate,
    maximumText: options.maximumText,
  });
  return {
    text,
    value: model,
    changed: !Object.is(model, value),
    notified,
    ...(notified ? { maximumValue: context.maximumValue } : {}),
    state,
  };
}

/** Internal graph drag setter/getter. The graph suppresses OnChange and then
 * explicitly publishes parsed final Text; it does not use wheel recurrence. */
export function normalizeManualNumberDragGain(
  originGain: number,
  originAxisY: number,
  axisY: number,
  { min, max }: { readonly min: number; readonly max: number },
): ManualNumberResult | undefined {
  if (
    [originGain, originAxisY, axisY, min, max].some((v) => !Number.isFinite(v)) ||
    Math.abs(min) >= 1e17 ||
    Math.abs(max) >= 1e17
  )
    throw new Error('Graph gain requires finite captured values and bounds');
  // c5b5bb..c4: the two axis values are Doubles, subtraction stays Extended
  // until its Single argument store. Do not subtract in JS before Math.fround.
  const from = double(originAxisY),
    delta = storeSingle(addExtended(double(axisY), { n: -from.n, d: from.d }));
  if (!Number.isFinite(delta)) throw new Error('Graph gain delta cannot be stored as Single');
  if (delta === 0) return undefined;
  const { minimum, maximum } = numberBounds(min, max, undefined, 'Graph gain');
  // c63d1f..51: captured gain Double + Single delta, bounded SetValue,
  // inhibited OnChange, then explicit final Text/GetValue -> Double store.
  // The field-wheel AdditionalGain postguard is not in this call path.
  let candidate = addExtended(double(originGain), double(delta));
  if (compare(candidate, minimum) < 0n) candidate = minimum;
  else if (compare(candidate, maximum) > 0n) candidate = maximum;
  const text = fixed(candidate, 2);
  return { text, value: storeDouble(parse(text, 'Graph gain')) };
}

/** Internal ba6a48 AddValue, ba6ecc bounds, and changed-Text OnChange model
 * publication. A passive field starts with its exact canonical Double; a
 * returned state also retains private Extended changes when Text stays equal.
 * Unlike native RTL NAN/INF support, this browser path admits only bounded
 * finite decimal Text. Native arrow keys and zero-delta UI events are separate. */
export function adjustManualNumberWheel(
  value: number,
  direction: -1 | 1,
  options: ManualNumberWheelOptions,
): ManualNumberWheelResult {
  const { parameter, step, min, max, places, zeroAllowed, additionalGain } = options,
    profile = options.profile ?? 'ordinary';
  if (
    !['ordinary', 'input-eq', 'graph-q', 'channel-gain'].includes(profile) ||
    !['frequency', 'q', 'gain'].includes(parameter) ||
    (parameter === 'frequency' && profile !== 'input-eq') ||
    (profile === 'graph-q' && parameter !== 'q') ||
    (profile === 'channel-gain' && parameter !== 'gain') ||
    (direction !== -1 && direction !== 1) ||
    ![1, 2, 3].includes(places) ||
    (step === 'decade' ? parameter !== 'frequency' : !Number.isFinite(step)) ||
    (typeof step === 'number' && Math.abs(step) >= 1e17) ||
    [value, min, max].some((number) => !Number.isFinite(number) || Math.abs(number) >= 1e17) ||
    !Number.isFinite(additionalGain) ||
    (profile !== 'channel-gain' && Math.abs(additionalGain) >= 1e17) ||
    min > max
  )
    throw new Error('Invalid manual wheel value, direction or bounds');

  const previous = options.state === undefined ? undefined : wheelMemory.get(options.state);
  if (
    options.state !== undefined &&
    (!previous ||
      previous.parameter !== parameter ||
      previous.profile !== profile ||
      !Object.is(previous.value, value))
  )
    throw new Error('Manual wheel state does not match the current field value');
  let text = options.displayedText ?? previous?.text ?? fixed(double(value), places);
  if (previous && text !== previous.text)
    throw new Error('Manual wheel state does not match the displayed text');
  // Strict dirty-Text admission is intentional; do not turn malformed/NAN/INF
  // input into zero or silently substitute the canonical model value.
  const parsedText = parse(text, 'Wheel value');
  if (!Number.isFinite(storeDouble(parsedText)))
    throw new Error('Wheel value cannot be stored as Double');
  let internal = previous?.internal ?? double(value),
    model = value;
  const { minimum, maximum } = numberBounds(min, max, options.extendedBounds, 'Wheel value');
  // cee9e4 reads Text as Extended for the directional100/1000/10000
  // thresholds. Do not narrow dirty Text to Double before choosing its decade.
  const before = (boundary: number) =>
    direction > 0
      ? compare(parsedText, double(boundary)) < 0n
      : compare(parsedText, double(boundary)) <= 0n;
  const amount =
      step === 'decade' ? (before(100) ? 1 : before(1000) ? 10 : before(10000) ? 100 : 1000) : step,
    delta = double(direction * amount);

  function setBounded(candidate: Ratio, notify = true) {
    if (!zeroAllowed && candidate.n === 0n) {
      // ba6ee3 skips exact0 and retains the previous internal Extended Value.
    } else if (compare(candidate, minimum) < 0n) internal = minimum;
    else if (compare(candidate, maximum) > 0n) internal = maximum;
    else internal = candidate;
    const nextText = fixed(internal, places);
    if (nextText === text) return; // 811768: no Text assignment, callback or model edit.
    text = nextText;
    if (!notify) return;
    // c64990 sets InhibitOnChangeEventOnce (ba7664/+533) while normalizing
    // changed Text, then the outer Q/gain callback performs its qword store.
    setBounded(parse(text, 'Wheel value'), false);
    // Channel c64b74 additionally caps its normalized Text, then explicitly
    // publishes the final getter. BQ gain's callback does not do this.
    if (profile === 'channel-gain')
      additionalGainCeiling(text, additionalGain, maximum, (candidate) =>
        setBounded(candidate, false),
      );
    model = storeDouble(parse(text, 'Wheel value'));
  }

  if (delta.n !== 0n) {
    const skipZero =
        !zeroAllowed &&
        fixed(addExtended(internal, delta), places) === fixed({ n: 0n, d: 1n }, places),
      amount = skipZero ? extended({ n: delta.n * 2n, d: delta.d }) : delta;
    setBounded(addExtended(parse(text, 'Wheel value'), amount), profile !== 'graph-q');
  }

  // c63cb1..de inhibits the graph Q field's OnChange once, then explicitly
  // reparses its final Text and stores Q as Double. This publication occurs
  // even when FloatEdit skipped an identical Text assignment; its private
  // Extended Value must not run the ordinary changed-Text normalization.
  if (profile === 'graph-q') model = storeDouble(parse(text, 'Wheel value'));

  if (parameter === 'gain' && (profile === 'ordinary' || profile === 'channel-gain')) {
    // c64323: Text is narrowed to Double, then channel AdditionalGain is added
    // in Extended. This ceiling follows AddValue even when its delta was0.
    additionalGainCeiling(text, additionalGain, maximum, (candidate) =>
      // c64359..8b inhibits this Text change's OnChange once. The visible field
      // is capped, but its model retains the preceding callback publication.
      setBounded(candidate, false),
    );
  }

  if (!Number.isFinite(model)) throw new Error('Wheel value cannot be stored as Double');
  const state = Object.freeze({}) as ManualNumberWheelState;
  wheelMemory.set(state, { internal, text, value: model, parameter, profile });
  return { text, value: model, changed: !Object.is(model, value), state };
}
