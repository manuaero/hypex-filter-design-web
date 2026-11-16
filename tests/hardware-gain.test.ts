import { expect, it } from 'vitest';
import {
  hardwareGainPresentation,
  normalizeHardwareGainCallback,
} from '../src/domain/hardware-gain';
import { newProject } from '../src/domain/model';

it('reproduces actual native Off without altering retained channel/filter state', () => {
  // Native V46 baseline ef1326d6... -> Off c71d6f97...: Gain0 retained,
  // AdditionalGain10->0 and device hinttrue->false; no cached BQ changes.
  const channel = newProject().presets[0].channels[0];
  channel.additionalGain = 10;
  channel.filters[0].coefficients = {
    b0: 1.09247603795187,
    b1: -1.86528064992647,
    b2: 0.794998327675381,
    f1: 1.85236017184606,
    f2: -0.874553956539528,
  };
  channel.coefficientCache = 'base';
  const before = structuredClone(channel);
  expect(hardwareGainPresentation(channel)).toEqual({
    available: true,
    checked: true,
    gainText: '0.00',
  });
  expect(normalizeHardwareGainCallback(channel, false)).toEqual({
    gain: 0,
    additionalGain: 0,
    hfdGainLowered: false,
    gainText: '0.00',
  });
  expect(channel).toEqual(before);
});

it('matches the actual native On cap and publishes final Text as channel Gain14', () => {
  // Actual native03_OnClamp14 SHA
  // 035db7f285252554733602bf8665f2e0f774d634b35d3ebfaf8baedf4f59163e.
  // This is an offline saved-parameter oracle, not an amplifier setting/write.
  expect(normalizeHardwareGainCallback({ gain: 18, additionalGain: 0 }, true)).toEqual({
    gain: 14,
    additionalGain: 10,
    hfdGainLowered: true,
    gainText: '14.00',
  });
});

it('separates fresh Single presentation from captured native widget Text', () => {
  // Source-only precision boundary: Double0.005 narrows below0.005 in Single.
  // A supplied raw Text0.005 instead follows Extended decimal #0.00 formatting.
  const channel = { gain: 0.005, additionalGain: 6 },
    before = structuredClone(channel);
  expect(hardwareGainPresentation(channel)).toEqual({
    available: true,
    checked: true,
    gainText: '0.00',
  });
  expect(normalizeHardwareGainCallback(channel, false)).toMatchObject({
    gain: 0,
    gainText: '0.00',
  });
  expect(normalizeHardwareGainCallback(channel, false, { gainText: '0.005' })).toMatchObject({
    gain: 0.01,
    gainText: '0.01',
  });
  expect(channel).toEqual(before);
});

it.each([
  ['-125.0001', false, -125, '-125.00'],
  ['24.0001', false, 24, '24.00'],
  ['24.0001', true, 14, '14.00'],
  ['0', true, 0, '0.00'],
] as const)(
  'uses the explicit factory callback profile for %s checked%s',
  (text, checked, gain, gainText) => {
    // Addressed source predictions, not additional screenshot/native-save cases.
    expect(normalizeHardwareGainCallback({ gain: 0 }, checked, { gainText: text })).toEqual({
      gain,
      gainText,
      additionalGain: checked ? 10 : 0,
      hfdGainLowered: checked,
    });
  },
);

it('formats captured comma-decimal Text before the explicit final Double store', () => {
  expect(
    normalizeHardwareGainCallback({ gain: 0, additionalGain: 10 }, false, {
      gainText: '17,955',
    }),
  ).toEqual({ gain: 17.96, additionalGain: 0, hfdGainLowered: false, gainText: '17.96' });
});

it('keeps conditional admission separate so a trusted retained Off view can re-toggle On', () => {
  const channel = { gain: 0, additionalGain: 0 };
  expect(hardwareGainPresentation(channel).available).toBe(false);
  expect(normalizeHardwareGainCallback(channel, true)).toEqual({
    gain: 0,
    additionalGain: 10,
    hfdGainLowered: true,
    gainText: '0.00',
  });
});

it('refuses malformed/nonfinite callback data without mutating the input', () => {
  for (const channel of [
    { gain: Infinity, additionalGain: 0 },
    { gain: 0, additionalGain: NaN },
  ]) {
    expect(() => hardwareGainPresentation(channel)).toThrow(/finite/);
    expect(() => normalizeHardwareGainCallback(channel, false)).toThrow(/finite/);
  }
  const channel = { gain: 0, additionalGain: 6 };
  expect(() => normalizeHardwareGainCallback(channel, 'false' as unknown as boolean)).toThrow(
    /boolean/,
  );
  expect(() => normalizeHardwareGainCallback(channel, false, { gainText: 'NaN' })).toThrow(
    /finite/,
  );
  expect(channel).toEqual({ gain: 0, additionalGain: 6 });
});
