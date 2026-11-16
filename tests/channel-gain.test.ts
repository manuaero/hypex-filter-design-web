import { describe, expect, it } from 'vitest';
import {
  HFD_CHANNEL_GAIN_BOUNDS,
  HFD_CHANNEL_GAIN_PROFILE,
  formatHfdChannelGainValue,
  normalizeHfdChannelGainText,
  hfdChannelGainWheelNext as next,
  type HfdChannelGainWheelState,
} from '../src/domain/channel-gain';
import {
  adjustManualNumberWheel,
  formatManualNumberValue,
  type ManualNumberWheelState,
} from '../src/domain/manual-number';
import { hfdManualParameterWheelNext } from '../src/domain/parameter-wheel';

describe('ordinary channel Gain committed Text', () => {
  it.each([
    ['-125.0001', '-125.00', -125],
    ['24.0001', '24.00', 24],
    ['0.005', '0.01', 0.01],
  ] as const)('matches actual native saved raw%s with compensation0', (raw, text, value) => {
    // Actual V48 Saves02/03/04; the explicit selection/ASCII/Tab route is
    // established. Earlier click-only input attempts are not extra oracles.
    expect(normalizeHfdChannelGainText(raw)).toEqual({ text, value });
  });

  it('matches the saved native04->05 Gain0.01->0.11 after one requested +360 wheel action', () => {
    // Saved files establish these values; OS delta does not count callbacks.
    const result = next(0.01, 1);
    expect(result).toMatchObject({ text: '0.11', value: 0.11, changed: true });
    expect(result.value).not.toBe(Math.fround(0.11));
    expect(next(result.value, -1, { state: result.state })).toMatchObject({
      text: '0.01',
      value: 0.01,
      changed: true,
    });
  });

  it('keeps passive Single display separate from explicit raw Text and canonical Double', () => {
    // Source prediction at the Float32 half-cent boundary, not an additional
    // native Save. Passive presentation must not rewrite imported canonical.
    const value = 0.005;
    expect(formatHfdChannelGainValue(value)).toBe('0.00');
    expect(normalizeHfdChannelGainText('0.005')).toEqual({ text: '0.01', value: 0.01 });
    expect(next(value, 1)).toMatchObject({ text: '0.10', value: 0.1, changed: true });
    expect(value).toBe(0.005);
    expect(formatHfdChannelGainValue(24.000001)).toBe('24.00');
  });

  it.each([
    ['7,555', 0, '7.56', 7.56],
    ['0', 0, '0.00', 0],
    ['18', 10, '14.00', 14],
    ['20', 6, '18.00', 18],
    ['-125', 10, '-125.00', -125],
    ['2.4e1', 0, '24.00', 24],
  ] as const)(
    'source-predicted callback %s with compensation%s publishes final capped Double',
    (raw, additionalGain, text, value) => {
      expect(normalizeHfdChannelGainText(raw, { additionalGain, previousValue: 5 })).toEqual({
        text,
        value,
      });
    },
  );

  it('keeps arbitrary compensation subtraction Extended through the bounded cap setter', () => {
    // c64bf0..c64c03 has an Extended argument store, not a Double or Single
    // intermediate. These two precision vectors are source-only predictions.
    expect(formatManualNumberValue(24 - 0.015, 2)).toBe('23.98');
    expect(normalizeHfdChannelGainText('24', { additionalGain: 0.015 })).toEqual({
      text: '23.99',
      value: 23.99,
    });
    expect(formatHfdChannelGainValue(24 - 23.985)).toBe('0.01');
    expect(normalizeHfdChannelGainText('24', { additionalGain: 23.985 })).toEqual({
      text: '0.02',
      value: 0.02,
    });
  });

  it('uses one bounded setter pass, without inventing a floor or repeated ceiling solver', () => {
    // Source-only outlying imported-compensation cases. The setter still uses
    // its own bounds/format; this is not a claim of physical configuration.
    expect(normalizeHfdChannelGainText('24', { additionalGain: 200 })).toEqual({
      text: '-125.00',
      value: -125,
    });
    expect(normalizeHfdChannelGainText('24', { additionalGain: -6 })).toEqual({
      text: '24.00',
      value: 24,
    });
  });

  it.each(['', '-', 'NaN', 'INF', 'not a number', '1e401', '1'.repeat(129)])(
    'refuses invalid or unbounded raw Text%j',
    (raw) => {
      expect(() => normalizeHfdChannelGainText(raw)).toThrow();
    },
  );
  it('rejects nonfinite compensation rather than substituting zero', () => {
    for (const additionalGain of [NaN, Infinity, -Infinity]) {
      expect(() => normalizeHfdChannelGainText('1', { additionalGain })).toThrow();
      expect(() => next(1, 1, { additionalGain })).toThrow();
    }
  });
});

describe('channel-only wheel notification and transient state', () => {
  it('matches actual native coupled ceiling/repeat while leaving the BQ notification contract unchanged', () => {
    // Native V48 Save08 typed18/Add10 ->14; Save09 Gain13.95 ->Save10 Gain14
    // after a requested positive wheel, then Save11 is byte-identical at14.
    // These saved values do not establish a delivered callback count.
    expect(normalizeHfdChannelGainText('18', { additionalGain: 10 })).toEqual({
      text: '14.00',
      value: 14,
    });
    expect(next(13.95, 1, { additionalGain: 10 })).toMatchObject({
      text: '14.00',
      value: 14,
      changed: true,
    });
    expect(next(14, 1, { additionalGain: 10 })).toMatchObject({
      text: '14.00',
      value: 14,
      changed: false,
    });
    expect(
      hfdManualParameterWheelNext(14, 1, { parameter: 'gain', additionalGain: 10 }),
    ).toMatchObject({ text: '14.00', value: 14.1, changed: true });
  });

  it('publishes a changed off-grid model even when final capped Text equals the original Text', () => {
    const value = 14.000001;
    expect(formatHfdChannelGainValue(value)).toBe('14.00');
    expect(next(value, 1, { additionalGain: 10 })).toMatchObject({
      text: '14.00',
      value: 14,
      changed: true,
    });
  });

  it('retains imported canonical precision if bound clamping did not change Text or notify the model', () => {
    const value = 24.000001,
      capped = next(value, 1);
    expect(capped).toMatchObject({ text: '24.00', value, changed: false });
    expect(next(value, -1, { state: capped.state })).toMatchObject({
      text: '23.90',
      value: 23.9,
      changed: true,
    });
    expect(next(-125, -1)).toMatchObject({ text: '-125.00', value: -125, changed: false });
  });

  it('does not manufacture a channel getter notification from the shared late Text-only guard', () => {
    // Source-only conflicting imported state; no native passive-load/selection
    // acceptance is inferred. First AddValue clamps to identical24.00 Text.
    const first = next(24, 1, { additionalGain: 10 });
    expect(first).toMatchObject({ text: '14.00', value: 24, changed: false });
    const continuous = next(first.value, 1, { additionalGain: 10, state: first.state });
    expect(continuous).toMatchObject({ text: '14.00', value: 14, changed: true });
    // Stateless commands deliberately restart from fresh passive presentation.
    expect(next(24, 1, { additionalGain: 10 })).toMatchObject({
      text: '14.00',
      value: 24,
      changed: false,
    });
  });

  it('preserves the shared source-only zero-step late guard without exposing preference inputs in the public profile', () => {
    expect(HFD_CHANNEL_GAIN_BOUNDS).toEqual({ min: -125, max: 24 });
    expect(HFD_CHANNEL_GAIN_PROFILE.step).toBe(0.1);
    const internal = adjustManualNumberWheel(18, 1, {
      profile: 'channel-gain',
      parameter: 'gain',
      step: 0,
      min: -125,
      max: 24,
      places: 2,
      zeroAllowed: true,
      additionalGain: 10,
    });
    expect(internal).toMatchObject({ text: '14.00', value: 18, changed: false });
    expect(() => next(1, 360 as 1)).toThrow();
    expect(() => next(1, 0 as 1)).toThrow();
  });

  it('binds opaque state to the channel profile, model, Text and compensation context', () => {
    const first = next(1, 1),
      bq = hfdManualParameterWheelNext(1, 1, { parameter: 'gain' });
    expect(() => next(1.2, 1, { state: first.state })).toThrow(/state|value/i);
    expect(() => next(first.value, 1, { state: first.state, additionalGain: 10 })).toThrow(
      /context/i,
    );
    expect(() => next(first.value, 1, { state: first.state, displayedText: '1.11' })).toThrow(
      /text/i,
    );
    expect(() => next(first.value, 1, { state: {} as HfdChannelGainWheelState })).toThrow(
      /state|context/i,
    );
    expect(() =>
      next(bq.value, 1, { state: bq.state as unknown as HfdChannelGainWheelState }),
    ).toThrow(/state|context/i);
    expect(() =>
      hfdManualParameterWheelNext(first.value, 1, {
        parameter: 'gain',
        state: first.state as unknown as ManualNumberWheelState,
      }),
    ).toThrow(/state/i);
  });

  it('validates finite wheel models and renders nonfinite passive values without a canonical mutation', () => {
    for (const value of [NaN, Infinity, -Infinity, 1e17]) expect(() => next(value, 1)).toThrow();
    expect(formatHfdChannelGainValue(NaN)).toBe('');
    expect(formatHfdChannelGainValue(Infinity)).toBe('');
  });
});
