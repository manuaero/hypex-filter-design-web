import { describe, expect, it } from 'vitest';
import {
  HFD_MANUAL_GAIN_WHEEL_STEP,
  HFD_MANUAL_Q_WHEEL_STEP,
  hfdManualParameterWheelNext as next,
  type HfdManualWheelState,
} from '../src/domain/parameter-wheel';

describe('ordinary native Q wheel events', () => {
  it('matches the actual .700 -> .740 and +360 .740 -> .780 observations as one event each', () => {
    // Native V40 screenshots02: +120, then +360, each delivered once. The
    // caller reduces delta to direction; its magnitude is not an event count.
    const first = next(0.7, 1, { parameter: 'q' });
    expect(first).toMatchObject({ text: '0.740', value: 0.74, changed: true });
    const second = next(first.value, 1, { parameter: 'q', state: first.state });
    expect(second).toMatchObject({ text: '0.780', value: 0.78, changed: true });
    expect(second.value).not.toBe(Math.fround(0.78));
    expect(next(second.value, -1, { parameter: 'q', state: second.state })).toMatchObject({
      text: '0.740',
      value: 0.74,
      changed: true,
    });
  });

  it('reparses each formatted Text on repeated steps and supports the same Q2 profile', () => {
    let result = next(0.401, 1, { parameter: 'q' });
    expect(result.value).toBe(0.441);
    for (const value of [0.481, 0.521, 0.561]) {
      result = next(result.value, 1, { parameter: 'q', state: result.state });
      expect(result.value).toBe(value);
    }
    expect(next(1.301, 1, { parameter: 'q' }).value).toBe(1.341);
  });

  it('uses displayed Text without silently normalizing imported canonical precision first', () => {
    const imported = 0.40004;
    expect(next(imported, 1, { parameter: 'q' })).toMatchObject({
      text: '0.440',
      value: 0.44,
      changed: true,
    });
    expect(imported).toBe(0.40004);
    expect(next(0.4005, 1, { parameter: 'q' }).value).toBe(0.441);
  });

  it('clamps on a real visible edit and leaves bound no-ops exact', () => {
    expect(next(19.99, 1, { parameter: 'q' })).toMatchObject({
      text: '20.000',
      value: 20,
      changed: true,
    });
    expect(next(0.1, -1, { parameter: 'q' })).toMatchObject({
      text: '0.100',
      value: 0.1,
      changed: false,
    });
    // 811768 skips an identical formatted Text, so imported model/cache
    // precision is retained even though private FloatEdit Value clamps.
    expect(next(0.10004, -1, { parameter: 'q' })).toMatchObject({
      text: '0.100',
      value: 0.10004,
      changed: false,
    });
    const capped = next(20.0004, 1, { parameter: 'q' });
    expect(capped).toMatchObject({ text: '20.000', value: 20.0004, changed: false });
    expect(next(capped.value, -1, { parameter: 'q', state: capped.state }).value).toBe(19.96);
  });

  it('models AddValue zero avoidance in both directions before bounds', () => {
    expect(next(0.04, -1, { parameter: 'q', min: -1, max: 1 })).toMatchObject({
      text: '-0.040',
      value: -0.04,
    });
    expect(next(-0.04, 1, { parameter: 'q', min: -1, max: 1 }).value).toBe(0.04);
    // Ordinary Q min0.1 still applies after the doubled skip-zero delta.
    expect(next(0.04, -1, { parameter: 'q' }).value).toBe(0.1);
  });

  it('retains a private sub-display Extended change for the next zero probe', () => {
    const held = next(0.00249, 1, { parameter: 'q', step: 0.0001, min: -1, max: 1 });
    expect(held).toMatchObject({ text: '0.002', value: 0.00249, changed: false });
    const resumed = next(held.value, -1, {
      parameter: 'q',
      state: held.state,
      step: 0.0018,
      min: -1,
      max: 1,
    });
    expect(resumed).toMatchObject({ text: '-0.002', value: -0.002, changed: true });
    // A passive refresh deliberately seeds a different exact Double internal
    // Value; it is not equivalent to retaining the prior FloatEdit state.
    const reset = next(held.value, -1, { parameter: 'q', step: 0.0018, min: -1, max: 1 });
    expect(reset.value).not.toBe(resumed.value);
  });

  it('does nothing for configured Q step0 and preserves non-grid imports', () => {
    expect(next(0.70004, 1, { parameter: 'q', step: 0 })).toMatchObject({
      text: '0.700',
      value: 0.70004,
      changed: false,
    });
  });
});

describe('ordinary BQ gain wheel and post-step AdditionalGain ceiling', () => {
  it('uses the source-derived0.1 step, Double storage and ordinary zero crossing', () => {
    const up = next(7.56, 1, { parameter: 'gain' });
    expect(up).toMatchObject({ text: '7.66', value: 7.66, changed: true });
    expect(up.value).not.toBe(Math.fround(7.66));
    expect(next(up.value, -1, { parameter: 'gain', state: up.state }).value).toBe(7.56);
    expect(next(0, -1, { parameter: 'gain' }).value).toBe(-0.1);
    expect(next(-0.1, 1, { parameter: 'gain' }).value).toBe(0);
  });

  it('starts from passive Double display, not canonical decimal reinterpretation', () => {
    expect(next(7.555, 1, { parameter: 'gain' })).toMatchObject({
      text: '7.65',
      value: 7.65,
      changed: true,
    });
    expect(next(-7.555, -1, { parameter: 'gain' }).value).toBe(-7.65);
  });

  it('clamps both default bounds while preserving same-Text imported data', () => {
    expect(next(23.95, 1, { parameter: 'gain' }).value).toBe(24);
    expect(next(-124.95, -1, { parameter: 'gain' }).value).toBe(-125);
    expect(next(24.004, 1, { parameter: 'gain' })).toMatchObject({
      text: '24.00',
      value: 24.004,
      changed: false,
    });
  });

  it('matches Native22 stored14.05 despite visible14.00, with AdditionalGain after the field increment', () => {
    const native22 = next(13.95, 1, { parameter: 'gain', additionalGain: 10 });
    expect(native22).toMatchObject({
      text: '14.00',
      value: 14.05,
      changed: true,
    });
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, native22.value, true);
    expect(Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')).toBe(
      '9a99999999192c40',
    );
    expect(next(14, -1, { parameter: 'gain', additionalGain: 10 }).value).toBe(13.9);
    expect(next(20, -1, { parameter: 'gain', additionalGain: 10 }).value).toBe(19.9);
    // Ordinary channel gain is not part of this operation or its options.
    expect(next(13.95, 1, { parameter: 'gain' }).value).toBe(14.05);
  });

  it('retains the native post-step ceiling even when GainStep is0', () => {
    expect(next(20, 1, { parameter: 'gain', step: 0, additionalGain: 10 })).toMatchObject({
      text: '14.00',
      value: 20,
      changed: false,
    });
    expect(next(7.555, 1, { parameter: 'gain', step: 0 })).toMatchObject({
      text: '7.55',
      value: 7.555,
      changed: false,
    });
  });

  it('uses the actual Double additional gain in Extended subtraction before fixed2 formatting', () => {
    expect(next(20, 1, { parameter: 'gain', additionalGain: 9.955 })).toMatchObject({
      text: '14.04',
      value: 20.1,
    });
  });

  it('matches actual Native20 visible14.00 while retaining saved model18.05 and follows the private display next', () => {
    // Native20 saved BQ13.gain18.05/cache18.05 despite visible14.00. Its
    // live AdditionalGain was10; Native21 independently proves load6->10.
    const first = next(17.95, 1, { parameter: 'gain', additionalGain: 10 });
    expect(first).toMatchObject({ text: '14.00', value: 18.05, changed: true });
    const second = next(first.value, 1, {
      parameter: 'gain',
      additionalGain: 10,
      state: first.state,
    });
    expect(second).toMatchObject({ text: '14.00', value: 14.1, changed: true });
    const down = next(second.value, -1, {
      parameter: 'gain',
      additionalGain: 10,
      state: second.state,
    });
    expect(down).toMatchObject({ text: '13.90', value: 13.9, changed: true });
    // A deliberate passive reset starts from the saved canonical Double again.
    expect(next(first.value, 1, { parameter: 'gain', additionalGain: 10 })).toMatchObject({
      text: '14.00',
      value: 18.15,
      changed: true,
    });
  });

  it('retains presentation-only zero-step state without inventing a model callback', () => {
    const held = next(20, 1, { parameter: 'gain', additionalGain: 10, step: 0 });
    expect(held).toMatchObject({ text: '14.00', value: 20, changed: false });
    expect(
      next(held.value, -1, {
        parameter: 'gain',
        additionalGain: 10,
        state: held.state,
      }),
    ).toMatchObject({ text: '13.90', value: 13.9, changed: true });
    // Native guard reads the captured AdditionalGain exactly; it does not
    // normalize arbitrary imported6 to the checkbox's load-lifecycle value10.
    expect(next(17.95, 1, { parameter: 'gain', additionalGain: 6 })).toMatchObject({
      text: '18.00',
      value: 18.05,
      changed: true,
    });
  });
});

describe('transient field state and bounded admission', () => {
  it('returns an immutable opaque token without numeric internals or serialized state', () => {
    const { state } = next(0.7, 1, { parameter: 'q' });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.keys(state)).toEqual([]);
    expect(JSON.stringify(state)).toBe('{}');
    expect(() => next(0.74, 1, { parameter: 'q', state: {} as HfdManualWheelState })).toThrow(
      /state/,
    );
  });

  it('rejects stale values, changed Text and a different field parameter without mutation', () => {
    const result = next(0.7, 1, { parameter: 'q' });
    expect(() => next(0.75, 1, { parameter: 'q', state: result.state })).toThrow(/state/);
    expect(() => next(result.value, 1, { parameter: 'gain', state: result.state })).toThrow(
      /state/,
    );
    expect(() =>
      next(result.value, 1, {
        parameter: 'q',
        state: result.state,
        displayedText: '0.741',
      }),
    ).toThrow(/state/);
    // Failed uses did not consume or mutate the immutable prior state.
    expect(next(result.value, 1, { parameter: 'q', state: result.state }).value).toBe(0.78);
  });

  it('keeps steps configurable while exposing the actual frozen factory defaults', () => {
    expect(HFD_MANUAL_Q_WHEEL_STEP).toBe(0.04);
    expect(HFD_MANUAL_GAIN_WHEEL_STEP).toBe(0.1);
    expect(next(0.7, 1, { parameter: 'q', step: 0.02 }).value).toBe(0.72);
    expect(next(7.5, 1, { parameter: 'gain', step: 0.25 }).value).toBe(7.75);
  });

  it.each([
    '',
    ' ',
    '-',
    'NaN',
    'NAN',
    'INF',
    '+INF',
    '-INF',
    'Infinity',
    '0x10',
    '1e401',
    '1'.repeat(129),
  ])('refuses invalid/nonfinite dirty Text%j rather than inventing zero', (displayedText) => {
    expect(() => next(0.7, 1, { parameter: 'q', displayedText })).toThrow();
    expect(() => next(7.5, -1, { parameter: 'gain', displayedText })).toThrow();
  });

  it('rejects nonfinite options, invalid direction and reversed profiles outside the bounded wheel contract', () => {
    expect(() => next(NaN, 1, { parameter: 'q' })).toThrow();
    expect(() => next(0.7, 0 as 1, { parameter: 'q' })).toThrow();
    expect(() => next(0.7, 120 as 1, { parameter: 'q' })).toThrow();
    expect(() => next(0.7, 1, { parameter: 'q', step: Infinity })).toThrow();
    expect(() => next(0.7, 1, { parameter: 'q', min: 2, max: 1 })).toThrow();
    expect(() => next(0.7, 1, { parameter: 'gain', additionalGain: NaN })).toThrow();
  });
});
