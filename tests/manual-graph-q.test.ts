import { describe, expect, it } from 'vitest';
import { hfdManualGraphQNext as next, supportsHfdGraphQ } from '../src/domain/manual-graph-q';
import { hfdManualParameterWheelNext } from '../src/domain/parameter-wheel';
import { hfdInputEqWheelNext } from '../src/domain/input-eq-parameters';
import { adjustManualNumberWheel } from '../src/domain/manual-number';
import type { FilterKind } from '../src/domain/model';

describe('native ordinary Magnitude graph Q publication', () => {
  it('matches actual selected Peak1.15->1.19->1.23->1.27 across signed wheel/drag events', () => {
    const first = next(1.15, 1);
    expect(first).toMatchObject({ text: '1.190', value: 1.19, changed: true });
    const second = next(first.value, 1, { state: first.state });
    expect(second).toMatchObject({ text: '1.230', value: 1.23, changed: true });
    const third = next(second.value, 1, { state: second.state });
    expect(third).toMatchObject({ text: '1.270', value: 1.27, changed: true });
    expect(next(third.value, -1, { state: third.state }).value).toBe(1.23);
    expect(third.value).not.toBe(Math.fround(third.value));
  });
  it('explicit getter publishes rounded Double even when maximum Text is unchanged', () => {
    const graph = next(20.0004, 1),
      field = hfdManualParameterWheelNext(20.0004, 1, { parameter: 'q' });
    expect(graph).toMatchObject({ text: '20.000', value: 20, changed: true });
    expect(field).toMatchObject({ text: '20.000', value: 20.0004, changed: false });
    expect(next(graph.value, -1, { state: graph.state })).toMatchObject({
      text: '19.960',
      value: 19.96,
      changed: true,
    });
  });
  it('normalizes an off-grid minimum via graph getter while field publication remains unchanged', () => {
    expect(next(0.100000001, -1)).toMatchObject({ text: '0.100', value: 0.1, changed: true });
    expect(hfdInputEqWheelNext('q', 0.100000001, -1)).toMatchObject({
      text: '0.100',
      value: 0.100000001,
      changed: false,
    });
  });
  it('starts additions from displayed native Text and clamps the default bounds', () => {
    expect(next(0.4005, 1)).toMatchObject({ text: '0.441', value: 0.441 });
    expect(next(20.0004, -1)).toMatchObject({ text: '19.960', value: 19.96 });
    expect(next(19.99, 1).value).toBe(20);
    expect(next(0.11, -1).value).toBe(0.1);
    expect(next(0.7, 1, { displayedText: '.75' }).value).toBe(0.79);
  });
  it('keeps canonical bound no-ops false while returning reusable graph-only state', () => {
    const maximum = next(20, 1);
    expect(maximum).toMatchObject({ value: 20, changed: false });
    expect(next(maximum.value, -1, { state: maximum.state }).value).toBe(19.96);
    const minimum = next(0.1, -1);
    expect(minimum).toMatchObject({ value: 0.1, changed: false });
    expect(next(minimum.value, 1, { state: minimum.state }).value).toBe(0.14);
  });
  it('reparses three-decimal Text on every event without cumulative binary addition drift', () => {
    let result = next(0.7, 1);
    for (let i = 1; i < 100; i++) result = next(result.value, 1, { state: result.state });
    expect(result.value).toBe(4.7);
    for (let i = 0; i < 100; i++) result = next(result.value, -1, { state: result.state });
    expect(result.value).toBe(0.7);
  });
  it('retains inhibited internal state without ordinary callback re-normalization', () => {
    // Direct private-core profile probe: custom tiny deltas are deliberately not
    // exposed by the factory graph wrapper. This distinguishes widget internal
    // Value from final explicitly published Text/Double after an inhibited call.
    const base = {
      parameter: 'q' as const,
      profile: 'graph-q' as const,
      min: -1,
      max: 1,
      places: 3 as const,
      zeroAllowed: false,
      additionalGain: 0,
    };
    const held = adjustManualNumberWheel(0.00249, 1, { ...base, step: 0.0001 });
    expect(held).toMatchObject({ text: '0.002', value: 0.002, changed: true });
    const resumed = adjustManualNumberWheel(held.value, -1, {
      ...base,
      state: held.state,
      step: 0.00155,
    });
    expect(resumed).toMatchObject({ text: '0.000', value: 0 });
    const refreshed = adjustManualNumberWheel(held.value, -1, { ...base, step: 0.00155 });
    expect(refreshed.value).not.toBe(resumed.value);
  });
  it('rejects ordinary/Input EQ states and refuses graph tokens on either field profile', () => {
    const field = hfdManualParameterWheelNext(0.7, 1, { parameter: 'q' }),
      eq = hfdInputEqWheelNext('q', 0.7, 1),
      graph = next(0.7, 1);
    expect(() => next(field.value, 1, { state: field.state })).toThrow(/state/);
    expect(() => next(eq.value, 1, { state: eq.state })).toThrow(/state/);
    expect(() =>
      hfdManualParameterWheelNext(graph.value, 1, { parameter: 'q', state: graph.state }),
    ).toThrow(/state/);
    expect(() => hfdInputEqWheelNext('q', graph.value, 1, { state: graph.state })).toThrow(/state/);
  });
  it('rejects stale value, foreign token and independently changed displayed Text', () => {
    const first = next(0.7, 1);
    expect(() => next(0.7, 1, { state: first.state })).toThrow(/state/);
    expect(() => next(first.value, 1, { state: first.state, displayedText: '.75' })).toThrow(
      /text/,
    );
    expect(() => next(0.7, 1, { state: {} as typeof first.state })).toThrow(/state/);
  });
  it('refuses nonfinite/malformed input and invalid event direction without silently substituting a value', () => {
    for (const value of [NaN, Infinity, -Infinity]) expect(() => next(value, 1)).toThrow();
    for (const displayedText of ['', 'NaN', 'Infinity', 'not a number'])
      expect(() => next(0.7, 1, { displayedText })).toThrow();
    expect(() => next(0.7, 0 as 1)).toThrow();
    expect(() =>
      adjustManualNumberWheel(0.7, 1, {
        profile: 'graph-q',
        parameter: 'gain',
        step: 0.04,
        min: 0.1,
        max: 20,
        places: 3,
        zeroAllowed: false,
        additionalGain: 0,
      }),
    ).toThrow();
  });
});
it('graph Q has a positive native type gate independent of numeric-Q availability', () => {
  const kinds: FilterKind[] = [
    'unity',
    'lowpass1',
    'lowpass2',
    'highpass1',
    'highpass2',
    'peak',
    'lowshelf1',
    'highshelf1',
    'lowshelf2',
    'highshelf2',
    'asymmetric',
    'allpass1',
    'allpass2',
    'raw',
  ];
  expect(kinds.filter(supportsHfdGraphQ)).toEqual([
    'lowpass2',
    'highpass2',
    'peak',
    'lowshelf2',
    'highshelf2',
  ]);
});
