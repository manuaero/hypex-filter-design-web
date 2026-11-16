import { describe, expect, it } from 'vitest';
import {
  formatHfdChannelDelayValue,
  formatHfdChannelDelayMaximum,
  readHfdChannelDelayText,
  normalizeHfdChannelDelayText as normalize,
  hfdChannelDelayWheelNext as next,
  type HfdChannelDelayProfile,
  type HfdChannelDelayWheelState,
} from '../src/domain/channel-delay';

const local: HfdChannelDelayProfile = Object.freeze({
  kind: 'local',
  unit: 'us',
  sampleRate: 93750,
  minimumText: '0',
  maximumText: '19200',
});
const global: HfdChannelDelayProfile = Object.freeze({
  ...local,
  kind: 'global',
  maximumText: '74666.6666666667',
});

describe('Delay Maximum general15 formatter', () => {
  it.each([
    [0, '0'],
    [-0, '0'],
    [19200, '19200'],
    [32000, '32000'],
    [74666.66666666667, '74666.6666666667'],
    [74666.6666666667, '74666.6666666667'],
    [30026.666666666668, '30026.6666666667'],
    [123.125, '123.125'],
    [0.0001, '0.0001'],
    [0.00001, '1E-5'],
    [100000000000000, '100000000000000'],
    [1000000000000000, '1E15'],
    [10000000000000000, '1E16'],
    [999999999999999.5, '1E15'],
    [281474976710654.5, '281474976710655'],
    [Number.MIN_VALUE, '4.94065645841247E-324'],
  ] as const)('source general15 value%s formats%s', (value, expected) => {
    // Current actual native global MaxDelay literal is74666.6666666667;
    // other notation/precision vectors are source-only formatter cases.
    expect(formatHfdChannelDelayMaximum(value)).toBe(expected);
  });

  it.each([
    [
      7.124377397762375,
      '401c7f5cc9df0102',
      4010667924226177n,
      562949953421312n,
      56995019182099n,
      8000000000000n,
      '7.12437739776238',
    ],
    [
      1.141336445033865,
      '3ff242ea01127421',
      5140122388558881n,
      4503599627370496n,
      228267289006773n,
      200000000000000n,
      '1.14133644503387',
    ],
    [
      3.692122068502945,
      '400d89774b887aec',
      2078479946489531n,
      562949953421312n,
      738424413700589n,
      200000000000000n,
      '3.69212206850295',
    ],
  ] as const)(
    'preserves18-digit intermediate carry for exact Double%s',
    (value, bits, n, d, hn, hd, expected) => {
      const view = new DataView(new ArrayBuffer(8));
      view.setFloat64(0, value, false);
      expect(view.getBigUint64(0, false).toString(16)).toBe(bits);
      // Independent rational witness: the exact dyadic is BELOW the15-digit
      // half, but within7/16 of one decimal18 unit. Even allowing the bounded
      // x87 multiplication error, the18-stage FRNDINT reaches the half first.
      // Decimal carry>=5 then rounds upward; direct15 would round downward.
      const gapNumerator = hn * d - n * hd,
        gapDenominator = hd * d;
      expect(gapNumerator > 0n).toBe(true);
      expect(gapNumerator * 10n ** 17n * 16n < gapDenominator * 7n).toBe(true);
      expect(formatHfdChannelDelayMaximum(value)).toBe(expected);
    },
  );

  it('refuses negative, nonfinite or unbounded maxima without formatting a substitute', () => {
    for (const value of [-1, NaN, Infinity, -Infinity, 1e17])
      expect(() => formatHfdChannelDelayMaximum(value)).toThrow();
  });
});

describe('direct current Global Delay Text getter', () => {
  it.each([
    ['16', 16],
    ['17.123456789', 17.123456789],
    ['1,6e1', 16],
    ['1.6e1', 16],
    ['-2.5', -2.5],
    ['100000', 100000],
  ] as const)('reads%s as Double without bounds or sample quantization', (text, value) => {
    // c641d9/c643ed read current Global Text, then c4c918 propagates it
    // directly. This is not another whole-Text/sample callback.
    expect(readHfdChannelDelayText(text)).toBe(value);
  });

  it('preserves the Extended-to-Double boundary instead of parsing Number first', () => {
    // Source-only precision witness: decimal is just above a Double midpoint,
    // but its Extended rounding reaches the midpoint; final Double ties even.
    expect(readHfdChannelDelayText('9007199254740993.0001')).toBe(9007199254740992);
    expect(Number('9007199254740993.0001')).toBe(9007199254740994);
  });

  it('enforces finite decimal Text and parser budgets without a profile', () => {
    for (const text of ['', '-', 'NaN', 'INF', '1e400', '1e401', '1'.repeat(129)])
      expect(() => readHfdChannelDelayText(text)).toThrow();
  });
});

describe('ordinary Delay whole-Text callback', () => {
  it.each([
    ['1', '0', 0],
    ['16', '21', 21],
  ] as const)(
    'matches actual native local raw%s and publishes its widget maximum',
    (raw, text, value) => {
      // V54 B01/B02: raw1 saved Delay0 and MaxDelay19->19200;
      // raw16 saved21. Notification can matter despite unchanged Delay0.
      expect(normalize(raw, { profile: local })).toEqual({ text, value, maximumValue: 19200 });
    },
  );

  it('matches actual Global16->21 while retaining its distinct maximum', () => {
    // Native B05 establishes the three-current-preset fanout separately.
    expect(normalize('16', { profile: global })).toEqual({
      text: '21',
      value: 21,
      maximumValue: Number(global.maximumText),
    });
  });

  it.each([
    ['6', '11', 11],
    ['48', '43', 43],
    ['26.5', '32', 32],
    ['15.4999999999999999', '11', 11],
    ['26.4999999999999999', '21', 21],
    ['1,6e1', '21', 21],
  ] as const)(
    'source-only precision vector%s preserves formatter and nearest-even stages',
    (raw, text, value) => {
      // 48us is4.5 samples ->nearest-even4 ->43us. Fixed0 Text carry
      // happens BEFORE this: raw26.5 ->27 ->3 samples ->32us.
      // Long Text vectors distinguish Extended parsing from Number-first.
      expect(normalize(raw, { profile: local })).toMatchObject({ text, value });
    },
  );

  it('bounds both setters but does not invent a final clamp after the formatted getter', () => {
    // Native V54 B06/B07 confirm local20000->19200 and Global100000->74667.
    // The Global MaxDelay literal stays74666.6666666667; no final clamp.
    expect(normalize('-1', { profile: local })).toMatchObject({ text: '0', value: 0 });
    expect(normalize('20000', { profile: local })).toMatchObject({ text: '19200', value: 19200 });
    const capped = normalize('100000', { profile: global });
    expect(capped).toEqual({
      text: '74667',
      value: 74667,
      maximumValue: Number(global.maximumText),
    });
    expect(capped.value).toBeGreaterThan(capped.maximumValue);
  });

  it('separates bounded passive Single presentation from explicit sample quantization', () => {
    const imported = 0.499999999;
    expect(formatHfdChannelDelayValue(imported, { profile: local })).toBe('1');
    expect(normalize(String(imported), { profile: local })).toMatchObject({ text: '0', value: 0 });
    expect(imported).toBe(0.499999999);
    expect(formatHfdChannelDelayValue(17.123456789, { profile: local })).toBe('17');
    expect(formatHfdChannelDelayValue(20000, { profile: local })).toBe('19200');
    expect(formatHfdChannelDelayValue(NaN, { profile: local })).toBe('');
  });

  it.each(['', '-', 'NaN', 'INF', '1e401', '1'.repeat(129)])(
    'refuses invalid raw Text%j',
    (text) => {
      expect(() => normalize(text, { profile: local })).toThrow();
    },
  );
});

describe('Delay sign wheel notification and private context', () => {
  it('matches one actual requested +360 wheel action0->11, with one signed step', () => {
    // Native B03->B04; requested OS magnitude does not count callbacks.
    expect(next(0, 1, { profile: local })).toMatchObject({
      text: '11',
      value: 11,
      changed: true,
      notified: true,
      maximumValue: 19200,
    });
  });

  it('retains source callback notification when its final value returns to the old model', () => {
    // Source-only dirty Text:0+step from-10 formats1, sample callback returns0.
    // MaxDelay/global side effects must not be suppressed by changed=false.
    expect(next(0, 1, { profile: local, displayedText: '-10' })).toMatchObject({
      text: '0',
      value: 0,
      changed: false,
      notified: true,
      maximumValue: 19200,
    });
  });

  it('retains imported canonical precision when an identical bound Text skips notification', () => {
    const imported = 19200.000001;
    const first = next(imported, 1, { profile: local });
    expect(first).toMatchObject({
      text: '19200',
      value: imported,
      changed: false,
      notified: false,
    });
    expect(first).not.toHaveProperty('maximumValue');
    expect(next(first.value, -1, { profile: local, state: first.state })).toMatchObject({
      text: '19189',
      value: 19189,
      changed: true,
      notified: true,
    });
  });

  it('defaults stateless wheel Text to passive Single formatting, rather than Double formatting', () => {
    expect(next(0.499999999, 1, { profile: local })).toMatchObject({ text: '11', value: 11 });
    expect(next(0.499999999, -1, { profile: local })).toMatchObject({ text: '0', value: 0 });
    const first = next(0, 1, { profile: local });
    expect(next(first.value, 1, { profile: local, state: first.state })).toMatchObject({
      text: '21',
      value: 21,
    });
    expect(next(21, -1, { profile: local })).toMatchObject({ text: '11', value: 11 });
  });

  it('uses the trusted sample rate for step and both callback conversions', () => {
    const other = { ...local, sampleRate: 48000 };
    expect(normalize('16', { profile: other })).toMatchObject({ text: '21', value: 21 });
    expect(next(0, 1, { profile: other })).toMatchObject({ text: '21', value: 21 });
  });

  it('fences forged/cross-context/model/Text state without exposing a numeric representation', () => {
    const first = next(0, 1, { profile: local });
    expect(Object.keys(first.state)).toEqual([]);
    expect(() => next(first.value, 1, { profile: global, state: first.state })).toThrow(
      /state|context/i,
    );
    expect(() =>
      next(first.value, 1, { profile: { ...local, maximumText: '32000' }, state: first.state }),
    ).toThrow(/state|context/i);
    expect(() =>
      next(first.value, 1, { profile: { ...local, sampleRate: 48000 }, state: first.state }),
    ).toThrow(/state|context/i);
    expect(() => next(12, 1, { profile: local, state: first.state })).toThrow(/state|value/i);
    expect(() =>
      next(first.value, 1, { profile: local, displayedText: '12', state: first.state }),
    ).toThrow(/state|text/i);
    expect(() =>
      next(first.value, 1, { profile: local, state: {} as HfdChannelDelayWheelState }),
    ).toThrow(/state|context/i);
    expect(next(first.value, 1, { profile: { ...local }, state: first.state }).value).toBe(21);
  });

  it('rejects invalid direction, canonical input and profiles rather than guessing bounds', () => {
    for (const direction of [0, 120, 360])
      expect(() => next(0, direction as 1, { profile: local })).toThrow();
    for (const value of [NaN, Infinity, -Infinity, 1e17])
      expect(() => next(value, 1, { profile: local })).toThrow();
    for (const profile of [
      { ...local, sampleRate: 0 },
      { ...local, sampleRate: NaN },
      { ...local, unit: 'ms' },
      { ...local, minimumText: '-1' },
      { ...local, maximumText: '-1' },
      { ...local, maximumText: 'NaN' },
    ])
      expect(() => normalize('1', { profile: profile as HfdChannelDelayProfile })).toThrow();
    expect(() => normalize('1', undefined as never)).toThrow();
  });
});
