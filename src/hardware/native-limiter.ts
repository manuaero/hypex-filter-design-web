import { hex, unhex } from './codec';
import { decodeLimiter } from './device-settings';
import { q24, roundEven } from '../domain/dsp';

export type NativeLimiterChannel = 0 | 1 | 2;
export type NativeLimiterField = 'threshold' | 'attack' | 'release';
export interface NativeLimiterLoadedCoefficients {
  threshold: number;
  attack: number;
  release: number;
  thresholdWord: number;
  attackWord: number;
  releaseWord: number;
}
export interface NativeLimiterChannelDraft {
  watts: number;
  ohms: number;
  thresholdText: string;
  attackText: string;
  releaseText: string;
  /** Browser draft of fields awaiting their native OnExit before Update. */
  pendingExits?: NativeLimiterField[];
  /** Original decoded values/words, independent of formatted editor Text. */
  loaded: NativeLimiterLoadedCoefficients;
}
export interface NativeLimiterDraft {
  version: 1;
  sourceHex: string;
  bridged: boolean;
  thirdChannelEnabled: boolean;
  channels: [NativeLimiterChannelDraft, NativeLimiterChannelDraft, NativeLimiterChannelDraft];
  /** Global spinner values; their displayed precision does not replace coefficient Text. */
  attackMs: number;
  releaseMs: number;
}
export type NativeLimiterAction =
  | { type: 'power' | 'impedance'; channel: NativeLimiterChannel; value: number }
  | { type: 'attack-time' | 'release-time'; value: number }
  | { type: 'expert-text'; channel: NativeLimiterChannel; field: NativeLimiterField; text: string }
  | { type: 'expert-exit'; channel: NativeLimiterChannel; field: NativeLimiterField }
  /** Pure simulation only: the hardware controller binds bridge to fresh device status. */
  | { type: 'bridge'; value: boolean };
export interface NativeLimiterPreviewChannel extends NativeLimiterLoadedCoefficients {
  /** Actual encoded byte metadata, decoded back to engineering units. */
  watts: number;
  ohms: number;
  /** Native callback values used by the threshold calculation before metadata serialization. */
  calculationWatts: number;
  calculationOhms: number;
  attackMs: number;
  releaseMs: number;
}
export interface NativeLimiterPreview {
  draft: NativeLimiterDraft;
  channels: [NativeLimiterPreviewChannel, NativeLimiterPreviewChannel, NativeLimiterPreviewChannel];
  request: Uint8Array;
}

type Ratio = { n: bigint; d: bigint };
const power2 = (n: number) => 1n << BigInt(n);
const power10 = (n: number) => 10n ** BigInt(n);
const integer = (n: number): Ratio => ({ n: BigInt(n), d: 1n });
const compare = (a: Ratio, b: Ratio) => a.n * b.d - b.n * a.d;
function nearest(n: bigint, d: bigint, even = true): bigint {
  const sign = n < 0n ? -1n : 1n,
    abs = n < 0n ? -n : n,
    whole = abs / d,
    twice = (abs % d) * 2n;
  return sign * (whole + (twice > d || (twice === d && (!even || whole % 2n !== 0n)) ? 1n : 0n));
}
function doubleRatio(value: number): Ratio {
  if (!Number.isFinite(value)) throw new Error('Limiter value must be finite');
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false),
    exp = Number((bits >> 52n) & 2047n),
    mantissa = (bits & ((1n << 52n) - 1n)) | (exp ? 1n << 52n : 0n),
    shift = (exp || 1) - 1023 - 52,
    n = bits >> 63n ? -mantissa : mantissa;
  return shift >= 0 ? { n: n << BigInt(shift), d: 1n } : { n, d: power2(-shift) };
}
function exponent(value: Ratio): number {
  const abs = value.n < 0n ? -value.n : value.n;
  let e = abs.toString(2).length - value.d.toString(2).length;
  if (e >= 0 ? abs < value.d * power2(e) : abs * power2(-e) < value.d) e--;
  return e;
}
/** Reproduce x87's 64-bit significand, and explicit qword stores at native sites. */
function binary(value: Ratio, precision = 64): Ratio {
  if (value.n === 0n) return integer(0);
  const shift = precision - 1 - exponent(value),
    m = nearest(
      shift >= 0 ? value.n * power2(shift) : value.n,
      shift >= 0 ? value.d : value.d * power2(-shift),
    );
  return shift >= 0 ? { n: m, d: power2(shift) } : { n: m * power2(-shift), d: 1n };
}
function numeric(value: Ratio): number {
  const r = binary(value, 53);
  let result = Number(r.n),
    e = -(r.d.toString(2).length - 1);
  while (e < -1022) {
    result *= 2 ** -1022;
    e += 1022;
  }
  return result * 2 ** e;
}
const add = (a: Ratio, b: Ratio) => binary({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const subtract = (a: Ratio, b: Ratio) => add(a, { n: -b.n, d: b.d });
const multiply = (a: Ratio, b: Ratio) => binary({ n: a.n * b.n, d: a.d * b.d });
const divide = (a: Ratio, b: Ratio) => {
  if (b.n === 0n) throw new Error('Invalid limiter division');
  return binary({ n: a.n * b.d * (b.n < 0n ? -1n : 1n), d: a.d * (b.n < 0n ? -b.n : b.n) });
};
function integerSqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = power2(Math.ceil(n.toString(2).length / 2)),
    next = (x + n / x) / 2n;
  while (next < x) {
    x = next;
    next = (x + n / x) / 2n;
  }
  return x;
}
function sqrt80(value: Ratio): Ratio {
  if (value.n < 0n) throw new Error('Negative limiter power');
  if (value.n === 0n) return integer(0);
  const e = Math.floor(exponent(value) / 2),
    shift = 63 - e,
    n = shift >= 0 ? value.n * power2(shift * 2) : value.n,
    d = shift >= 0 ? value.d : value.d * power2(-shift * 2);
  let m = integerSqrt(n / d);
  const difference = 4n * n - d * (2n * m + 1n) ** 2n;
  if (difference > 0n || (difference === 0n && m % 2n !== 0n)) m++;
  return shift >= 0 ? { n: m, d: power2(shift) } : { n: m * power2(-shift), d: 1n };
}
const extended = (mantissa: bigint, exp: number): Ratio => {
  const shift = exp - 16383 - 63;
  return shift >= 0 ? { n: mantissa * power2(shift), d: 1n } : { n: mantissa, d: power2(-shift) };
};
// Literal x87 constants in c17f18 and 9a615c/9a62e0, not decimal approximations.
const K12 = extended(0x96b1222367e8ded1n, 0x4003),
  K3 = extended(0x970cbbc62cfb9c99n, 0x4002),
  G12 = extended(0x899999999999999an, 0x3fff),
  G3 = extended(0x8ccccccccccccccdn, 0x3fff),
  RMS = extended(0xb4fdf3b645a1cac1n, 0x3ffe),
  ATTACK = extended(0xcccccccccccccccdn, 0x3ff9),
  RELEASE = extended(0x9d495182a9930be1n, 0x3ff7);

/** FormatFloat431e27/431eb2: 18 significant digits nearest/even, then decimal carry. */
function fixed(value: Ratio, places: number): string {
  if (value.n === 0n) return `0.${'0'.repeat(places)}`;
  const abs = value.n < 0n ? -value.n : value.n;
  let digits = abs.toString().length - value.d.toString().length + 1;
  if (digits - 1 >= 0 ? abs < value.d * power10(digits - 1) : abs * power10(1 - digits) < value.d)
    digits--;
  const shift = 18 - digits;
  const decimal =
    shift >= 0
      ? { n: nearest(value.n * power10(shift), value.d), d: power10(shift) }
      : { n: nearest(value.n, value.d * power10(-shift)) * power10(-shift), d: 1n };
  const scale = power10(places),
    rounded = nearest(decimal.n * scale, decimal.d, false),
    positive = rounded < 0n ? -rounded : rounded;
  return `${rounded < 0n ? '-' : ''}${positive / scale}.${String(positive % scale).padStart(places, '0')}`;
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const formatted = (value: number, max: number) => fixed(doubleRatio(clamp(value, 0, max)), 6);
function parsed(text: string): Ratio {
  if (typeof text !== 'string' || text.length > 128 || /[\x00-\x1f\x7f]/.test(text))
    throw new Error('Limiter coefficient Text must be at most 128 printable characters');
  if (text === '') return integer(0); // Native ba6bfc empty-string branch.
  const match = /^\s*([+-]?)(?:(\d+)(?:[.,](\d*))?|[.,](\d+))(?:[eE]([+-]?\d+))?\s*$/.exec(text);
  if (!match) throw new Error('Enter a valid limiter coefficient');
  const decimal = match[3] ?? match[4] ?? '',
    exp = Number(match[5] ?? 0) - decimal.length;
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 400)
    throw new Error('Limiter coefficient exponent is out of range');
  const n = BigInt(`${match[2] ?? '0'}${decimal}`) * (match[1] === '-' ? -1n : 1n);
  return binary(exp >= 0 ? { n: n * power10(exp), d: 1n } : { n, d: power10(-exp) });
}
function coefficient(text: string, max: number): number {
  const value = parsed(text);
  if (compare(value, integer(0)) < 0n || compare(value, integer(max)) > 0n)
    throw new Error(`Limiter coefficient must be between 0 and ${max}`);
  return numeric(value); // c1775c stores parsed Extended into qword before serialization.
}
const tuple = <T>(items: T[]) => items as [T, T, T];
const fieldKey = (field: NativeLimiterField) => `${field}Text` as const;
function assertChannel(channel: number): asserts channel is NativeLimiterChannel {
  if (![0, 1, 2].includes(channel)) throw new Error('Choose limiter channel 0, 1 or 2');
}
function assertField(field: string): asserts field is NativeLimiterField {
  if (!['threshold', 'attack', 'release'].includes(field))
    throw new Error('Invalid limiter coefficient field');
}
function range(value: number, min: number, max: number, name: string) {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`${name} must be ${min}–${max}`);
}
function validate(draft: NativeLimiterDraft) {
  if (
    !draft ||
    draft.version !== 1 ||
    typeof draft.sourceHex !== 'string' ||
    !/^[a-f\d]{128}$/.test(draft.sourceHex) ||
    typeof draft.bridged !== 'boolean' ||
    typeof draft.thirdChannelEnabled !== 'boolean' ||
    !Array.isArray(draft.channels) ||
    draft.channels.length !== 3
  )
    throw new Error('Invalid native limiter draft');
  const source = unhex(draft.sourceHex),
    original = decodeLimiter(source),
    view = new DataView(source.buffer);
  if (draft.thirdChannelEnabled !== (source[13] !== 0))
    throw new Error('Limiter output capability changed');
  range(draft.attackMs, 0.3, 999.9, 'Global attack');
  range(draft.releaseMs, 5, 99.9, 'Global release');
  draft.channels.forEach((channel, i) => {
    range(channel.watts, 0, 1000, 'Power');
    range(channel.ohms, 1, 25, 'Impedance');
    for (const [field, base] of [
      ['threshold', 20],
      ['attack', 32],
      ['release', 44],
    ] as const) {
      const text = channel[fieldKey(field)],
        word = view.getInt32(base + 4 * i, true);
      if (
        typeof text !== 'string' ||
        text.length > 128 ||
        /[\x00-\x1f\x7f]/.test(text) ||
        !channel.loaded ||
        channel.loaded[field] !== original.channels[i][field] ||
        channel.loaded[`${field}Word`] !== word
      )
        throw new Error('Native limiter source provenance or coefficient draft is invalid');
    }
    if (
      channel.pendingExits &&
      (!Array.isArray(channel.pendingExits) ||
        channel.pendingExits.length > 3 ||
        new Set(channel.pendingExits).size !== channel.pendingExits.length)
    )
      throw new Error('Invalid pending limiter exits');
    channel.pendingExits?.forEach(assertField);
  });
}
function roundedTime(value: number) {
  const shifted = add(
    multiply(doubleRatio(value), integer(1000)),
    doubleRatio(value >= 0 ? 0.5 : -0.5),
  );
  return numeric(divide({ n: shifted.n / shifted.d, d: 1n }, integer(1000)));
}
function attackTime(value: number) {
  const time =
    value > 0.99995 ? 999.9 : numeric(divide(ATTACK, subtract(integer(1), doubleRatio(value))));
  return roundedTime(time);
}
function releaseTime(value: number) {
  const time =
    value > 0.99995
      ? 99.9
      : value < 0.9
        ? 0
        : numeric(add(integer(5), divide(RELEASE, subtract(integer(1), doubleRatio(value)))));
  return roundedTime(time);
}
function threshold(draft: NativeLimiterDraft, index: NativeLimiterChannel) {
  if ((index === 1 && draft.bridged) || (index === 2 && !draft.thirdChannelEnabled)) return 20;
  const channel = draft.channels[index],
    ohms = index === 1 && draft.bridged ? draft.channels[0].ohms : channel.ohms;
  let voltage = divide(
    sqrt80(multiply(doubleRatio(channel.watts), doubleRatio(ohms))),
    index < 2 ? K12 : K3,
  );
  if (index < 2 && draft.bridged) voltage = divide(voltage, integer(2));
  voltage = doubleRatio(numeric(voltage)); // c181ac/c181f5/c1823b qword store.
  const gained = doubleRatio(
    numeric(divide(multiply(index < 2 ? G12 : G3, voltage), doubleRatio(index < 2 ? 2.81 : 3.05))),
  );
  return numeric(multiply(multiply(RMS, gained), integer(10)));
}
function recalculate(draft: NativeLimiterDraft, channel?: NativeLimiterChannel) {
  if (draft.bridged) draft.channels[1].ohms = draft.channels[0].ohms;
  for (const i of channel === undefined ? ([0, 1, 2] as const) : [channel])
    draft.channels[i].thresholdText = formatted(threshold(draft, i), 20);
}
function exit(draft: NativeLimiterDraft, channel: NativeLimiterChannel, field: NativeLimiterField) {
  const item = draft.channels[channel],
    key = fieldKey(field),
    value = parsed(item[key]);
  if (field === 'threshold') coefficient(item[key], 20);
  else if (compare(value, integer(1)) >= 0n) item[key] = '0.999990';
  else if (value.n < 0n) item[key] = '0.100000';
  // Ordinary in-range expert Text is intentionally not reformatted.
  item.pendingExits = item.pendingExits?.filter((pending) => pending !== field);
  if (!item.pendingExits?.length) delete item.pendingExits;
}

/** Load mirrors c1959d..c1976f: format coefficients, then derive spinner values from CH1 Text. */
export function loadNativeLimiter(
  raw: Uint8Array,
  { bridged }: { bridged: boolean },
): NativeLimiterDraft {
  if (!(raw instanceof Uint8Array) || typeof bridged !== 'boolean')
    throw new Error('Invalid native limiter source');
  const original = decodeLimiter(raw),
    view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength),
    channels = tuple(
      original.channels.map((c, i): NativeLimiterChannelDraft => ({
        watts: clamp(c.watts, 0, 1000),
        ohms: clamp(Math.fround(c.ohms), 1, 25),
        thresholdText: formatted(c.threshold, 20),
        attackText: formatted(c.attack, 1),
        releaseText: formatted(c.release, 1),
        loaded: {
          threshold: c.threshold,
          attack: c.attack,
          release: c.release,
          thresholdWord: view.getInt32(20 + 4 * i, true),
          attackWord: view.getInt32(32 + 4 * i, true),
          releaseWord: view.getInt32(44 + 4 * i, true),
        },
      })),
    );
  return {
    version: 1,
    sourceHex: hex(raw),
    bridged,
    thirdChannelEnabled: raw[13] !== 0,
    channels,
    attackMs: clamp(attackTime(coefficient(channels[0].attackText, 1)), 0.3, 999.9),
    releaseMs: clamp(releaseTime(coefficient(channels[0].releaseText, 1)), 5, 99.9),
  };
}

/** Explicit callbacks only. Normal/expert visibility changes do not regenerate values. */
export function editNativeLimiter(
  original: NativeLimiterDraft,
  action: NativeLimiterAction,
): NativeLimiterDraft {
  validate(original);
  const draft = structuredClone(original);
  switch (action.type) {
    case 'power':
      assertChannel(action.channel);
      range(action.value, 0, 1000, 'Power');
      // Integer TSpinBox getter ba3618, followed by c1b398's 5-W callback.
      draft.channels[action.channel].watts = Math.trunc(roundEven(action.value) / 5 + 0.5) * 5;
      recalculate(draft, action.channel);
      break;
    case 'impedance':
      assertChannel(action.channel);
      range(action.value, 1, 25, 'Impedance');
      draft.channels[action.channel].ohms = action.value;
      recalculate(draft, action.channel);
      break;
    case 'attack-time':
    case 'release-time': {
      const attack = action.type === 'attack-time';
      range(
        action.value,
        attack ? 0.3 : 5,
        attack ? 999.9 : 99.9,
        attack ? 'Global attack' : 'Global release',
      );
      draft[attack ? 'attackMs' : 'releaseMs'] = action.value;
      const time = doubleRatio(action.value),
        unbounded =
          !attack && action.value <= 5
            ? doubleRatio(0.9)
            : subtract(
                integer(1),
                divide(attack ? ATTACK : RELEASE, attack ? time : subtract(time, integer(5))),
              ),
        text = formatted(clamp(numeric(unbounded), 0.9, 0.99995), 1),
        field: NativeLimiterField = attack ? 'attack' : 'release';
      for (const channel of draft.channels) {
        channel[fieldKey(field)] = text;
        channel.pendingExits = channel.pendingExits?.filter((pending) => pending !== field);
        if (!channel.pendingExits?.length) delete channel.pendingExits;
      }
      break;
    }
    case 'expert-text':
      assertChannel(action.channel);
      assertField(action.field);
      if (
        typeof action.text !== 'string' ||
        action.text.length > 128 ||
        /[\x00-\x1f\x7f]/.test(action.text)
      )
        throw new Error('Invalid limiter coefficient Text');
      draft.channels[action.channel][fieldKey(action.field)] = action.text;
      draft.channels[action.channel].pendingExits = [
        ...new Set([...(draft.channels[action.channel].pendingExits ?? []), action.field]),
      ];
      break;
    case 'expert-exit':
      assertChannel(action.channel);
      assertField(action.field);
      exit(draft, action.channel, action.field);
      break;
    case 'bridge':
      if (typeof action.value !== 'boolean') throw new Error('Invalid limiter bridge state');
      draft.bridged = action.value;
      recalculate(draft);
      break;
    default:
      throw new Error('Unknown native limiter action');
  }
  return draft;
}

/** Native Update: pending editor exits, all-threshold calculation, coefficient Text→qword→Q24. */
export function previewNativeLimiter(original: NativeLimiterDraft): NativeLimiterPreview {
  validate(original);
  const draft = structuredClone(original);
  for (const [index, channel] of draft.channels.entries())
    for (const field of [...(channel.pendingExits ?? [])])
      exit(draft, index as NativeLimiterChannel, field);
  recalculate(draft);
  const request = unhex(draft.sourceHex),
    view = new DataView(request.buffer);
  request[1] = 1;
  const channels = tuple(
    draft.channels.map((c, i): NativeLimiterPreviewChannel => {
      const threshold = coefficient(c.thresholdText, 20),
        attack = coefficient(c.attackText, 1),
        release = coefficient(c.releaseText, 1),
        thresholdWord = q24(threshold),
        attackWord = q24(attack),
        releaseWord = q24(release);
      view.setInt32(20 + 4 * i, thresholdWord, true);
      view.setInt32(32 + 4 * i, attackWord, true);
      view.setInt32(44 + 4 * i, releaseWord, true);
      // Native aa6e9c..aa6f5d: metadata is stored as Single, then positive half-up via Trunc.
      request[56 + i] = Math.trunc(Math.fround(c.ohms) * 10 + 0.5);
      request[59 + i] = Math.trunc(Math.fround(c.watts) / 5 + 0.5);
      return {
        watts: request[59 + i] * 5,
        ohms: request[56 + i] / 10,
        calculationWatts: c.watts,
        calculationOhms: c.ohms,
        threshold,
        attack,
        release,
        thresholdWord,
        attackWord,
        releaseWord,
        attackMs: attackTime(attack),
        releaseMs: releaseTime(release),
      };
    }),
  );
  return { draft, channels, request };
}
export function encodeNativeLimiter(draft: NativeLimiterDraft): Uint8Array {
  return previewNativeLimiter(draft).request;
}
