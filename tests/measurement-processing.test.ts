// @vitest-environment jsdom
import { expect, it } from 'vitest';
import {
  newProject,
  type Measurement,
  type MeasurementCalibration,
  type MeasurementProcessingPatch,
} from '../src/domain/model';
import {
  spectrum,
  applyCalibration,
  smoothMeasurement,
  processMeasurement,
  resetMeasurementProcessing,
  validateMeasurement,
  type ImpulseWindow,
} from '../src/domain/measurement';
import { parseProject } from '../src/domain/files';
import { HFD_TEMPLATE } from '../src/domain/hfd-template';
import { projectFiles, importProjectFolder } from '../src/domain/project-io';

const window: ImpulseWindow = { start: 8, end: 32, taper: 0.25, timeZero: 12 };
const calibration: MeasurementCalibration = {
  name: 'Microphone correction',
  sampleRate: 48000,
  frequency: [10, 300, 1000, 10000, 24000],
  magnitude: [1, 3, 4, 2, 0],
  phase: [0, 0, 0, 0, 0],
};
const frequencyOnly = (): Measurement => ({
  name: 'Imported FRD',
  sampleRate: 48000,
  frequency: [100, 300, 1000, 3000, 10000],
  magnitude: [-2, 4, 9, 1, -7],
  phase: [170, -170, -90, -40, 30],
});
const impulseMeasurement = (): Measurement => ({
  ...spectrum(
    Array.from({ length: 128 }, (_, i) => (i === 12 ? 1 : i === 15 ? 0.35 : i === 90 ? 0.6 : 0)),
    48000,
  ),
  name: 'Original driver impulse',
});
function expectResponse(actual: Measurement, expected: Measurement) {
  expect(actual.frequency).toEqual(expected.frequency);
  expect(actual.magnitude).toEqual(expected.magnitude);
  expect(actual.phase).toEqual(expected.phase);
}
function combined(measurement = impulseMeasurement()) {
  return processMeasurement(measurement, {
    window,
    calibration,
    calibrationEnabled: true,
    smoothingOctaves: 1 / 3,
  });
}

it('computes each processing step from original impulse data and preserves raw inputs', () => {
  const original = impulseMeasurement(),
    before = structuredClone(original),
    curve = structuredClone(calibration);
  const windowed = processMeasurement(original, { window });
  expectResponse(windowed, spectrum(original.impulse!, original.sampleRate, window));
  const corrected = processMeasurement(original, { calibration, calibrationEnabled: true });
  expectResponse(corrected, applyCalibration(original, calibration));
  const smoothed = processMeasurement(original, { smoothingOctaves: 1 / 3 });
  expectResponse(smoothed, smoothMeasurement(original, 1 / 3));
  expect(windowed.impulse).toEqual(before.impulse);
  expect(windowed.sampleRate).toBe(before.sampleRate);
  expect(original).toEqual(before);
  expect(calibration).toEqual(curve);
  expect(windowed.impulse).not.toBe(original.impulse);
});

it('composes window/time-zero then calibration then smoothing regardless of edit order', () => {
  const original = impulseMeasurement(),
    expected = smoothMeasurement(
      applyCalibration(
        { ...spectrum(original.impulse!, original.sampleRate, window), name: original.name },
        calibration,
      ),
      1 / 3,
    );
  let result = processMeasurement(original, { smoothingOctaves: 1 / 3 });
  result = processMeasurement(result, { calibration, calibrationEnabled: true });
  result = processMeasurement(result, { window });
  expectResponse(result, expected);
  expect(result).toEqual(combined(original));
});

it('reapplying the same controls is idempotent instead of cumulatively correcting or smoothing', () => {
  const first = combined();
  let result = first;
  for (let i = 0; i < 4; i++) {
    result = processMeasurement(result, { calibration, calibrationEnabled: true });
    result = processMeasurement(result, { smoothingOctaves: 1 / 3, window });
  }
  expect(result).toEqual(first);
});

it('bypasses, replaces and re-enables a loaded curve while retaining the other controls', () => {
  const first = combined(),
    rawWindow = spectrum(first.impulse!, first.sampleRate, window);
  const disabled = processMeasurement(first, { calibrationEnabled: false });
  expectResponse(disabled, smoothMeasurement(rawWindow, 1 / 3));
  expect(disabled.processing?.calibration).toEqual(calibration);
  expect(disabled.processing?.window).toEqual(window);
  const replacement = { ...calibration, name: 'Replacement', magnitude: [6, 6, 6, 6, 6] };
  const replaced = processMeasurement(disabled, { calibration: replacement });
  expect(replaced.processing?.calibrationEnabled).toBe(false);
  expectResponse(replaced, disabled);
  const enabled = processMeasurement(replaced, { calibrationEnabled: true });
  expectResponse(enabled, smoothMeasurement(applyCalibration(rawWindow, replacement), 1 / 3));
  expect(enabled.processing?.calibration?.name).toBe('Replacement');
});

it('unloads calibration without clearing the window or smoothing', () => {
  const first = combined(),
    result = processMeasurement(first, { calibration: null });
  expect(result.processing).toEqual({ window, smoothingOctaves: 1 / 3, calibrationEnabled: false });
  expectResponse(
    result,
    smoothMeasurement(spectrum(first.impulse!, first.sampleRate, window), 1 / 3),
  );
});

it('resets smoothing alone and resets window/time-zero alone without losing other controls', () => {
  const first = combined(),
    unsmoothed = processMeasurement(first, { smoothingOctaves: 0 });
  expectResponse(
    unsmoothed,
    applyCalibration(spectrum(first.impulse!, first.sampleRate, window), calibration),
  );
  expect(unsmoothed.processing?.window).toEqual(window);
  expect(unsmoothed.processing?.calibrationEnabled).toBe(true);
  const unwindowed = processMeasurement(first, { window: null });
  expect(unwindowed.processing?.window).toBeUndefined();
  expect(unwindowed.processing?.smoothingOctaves).toBe(1 / 3);
  expectResponse(
    unwindowed,
    smoothMeasurement(
      applyCalibration(spectrum(first.impulse!, first.sampleRate), calibration),
      1 / 3,
    ),
  );
});

it('fully resets impulse processing while preserving the original impulse and rate', () => {
  const original = impulseMeasurement(),
    reset = resetMeasurementProcessing(combined(original));
  expectResponse(reset, original);
  expect(reset.impulse).toEqual(original.impulse);
  expect(reset.sampleRate).toBe(original.sampleRate);
  expect(reset.processing).toEqual({ smoothingOctaves: 0, calibrationEnabled: false });
  expect(resetMeasurementProcessing(reset)).toEqual(reset);
});

it('seeds and retains an immutable original spectrum for frequency-only measurements', () => {
  const original = frequencyOnly(),
    before = structuredClone(original);
  const first = processMeasurement(original, {
    calibration,
    calibrationEnabled: true,
    smoothingOctaves: 1,
  });
  expect(first.sourceSpectrum).toEqual({
    frequency: before.frequency,
    magnitude: before.magnitude,
    phase: before.phase,
  });
  expect(first.sourceSpectrum?.magnitude).not.toBe(original.magnitude);
  const again = processMeasurement(first, { calibration, calibrationEnabled: true });
  expect(again).toEqual(first);
  expectResponse(resetMeasurementProcessing(again), before);
  expect(original).toEqual(before);
});

it('does not migrate legacy processed response arrays until an explicit edit', () => {
  const legacy = applyCalibration(impulseMeasurement(), calibration),
    project = newProject('Legacy measurement');
  project.presets[0].channels[0].measurement = legacy;
  const parsed = parseProject(JSON.stringify(project)).presets[0].channels[0].measurement!;
  expect(parsed).toEqual(legacy);
  expect(parsed.processing).toBeUndefined();
  expect(processMeasurement(parsed, {})).toEqual(legacy);
  const edited = processMeasurement(parsed, { smoothingOctaves: 0 });
  expectResponse(edited, spectrum(legacy.impulse!, legacy.sampleRate));
  expect(edited.processing).toEqual({ smoothingOctaves: 0, calibrationEnabled: false });
  // Without an impulse, the legacy frequency response is the only available source.
  const frequencyLegacy = applyCalibration(frequencyOnly(), calibration);
  expectResponse(resetMeasurementProcessing(frequencyLegacy), frequencyLegacy);
});

it('preserves unloaded native DAT references through project JSON and exact folder sidecars', () => {
  const doc = new DOMParser().parseFromString(HFD_TEMPLATE, 'application/xml'),
    impulse = doc.querySelector(
      'device > preset[index="1"] > processobj[processtype="ptImpulse"][groupid="1"]',
    )!;
  impulse.querySelector('filename')!.setAttribute('value', 'Unloaded driver.dat');
  impulse.querySelector('options > meassamplingrate')!.setAttribute('value', '96000');
  const project = parseProject(new XMLSerializer().serializeToString(doc)),
    reference = { name: 'Unloaded driver.dat', sampleRate: 96000 };
  expect(project.presets[0].channels[0].measurement).toEqual(reference);
  const files = projectFiles(project);
  expect(files.some((file) => file.path.endsWith('.dat'))).toBe(false);
  const json = parseProject(JSON.stringify(project)),
    folder = importProjectFolder(files);
  expect(json.presets[0].channels[0].measurement).toEqual(reference);
  expect(folder.presets[0].channels[0].measurement).toEqual(reference);
  expect(folder.warnings.join(' ')).toContain('Restored browser-only');
});

it('preserves unloaded references on an empty patch but requires loaded data for processing', () => {
  const reference: Measurement = { name: 'Load this.dat', sampleRate: 48000 },
    before = structuredClone(reference);
  expect(() => validateMeasurement(reference)).not.toThrow();
  expect(processMeasurement(reference, {})).toEqual(reference);
  for (const patch of [
    { window },
    { window: null },
    { smoothingOctaves: 0 },
    { calibration, calibrationEnabled: true },
    { calibrationEnabled: false },
  ])
    expect(() => processMeasurement(reference, patch)).toThrow('Load data');
  expect(() => resetMeasurementProcessing(reference)).toThrow('Load data');
  const project = newProject();
  project.presets[0].channels[0].measurement = {
    ...reference,
    processing: { smoothingOctaves: 0, calibrationEnabled: false },
  };
  expect(() => parseProject(JSON.stringify(project))).toThrow('Load data');
  expect(reference).toEqual(before);
});

it('retains processing and original source data through project JSON and validated folder sidecars', () => {
  const project = newProject('Persistent processing');
  project.presets[0].channels[0].measurement = combined();
  project.presets[1].channels[2].measurement = processMeasurement(frequencyOnly(), {
    calibration,
    calibrationEnabled: true,
    smoothingOctaves: 1 / 3,
  });
  for (const imported of [
    parseProject(JSON.stringify(project)),
    importProjectFolder(projectFiles(project)),
  ]) {
    for (const [p, c] of [
      [0, 0],
      [1, 2],
    ]) {
      const before = project.presets[p].channels[c].measurement!,
        after = imported.presets[p].channels[c].measurement!;
      expect(after).toEqual(before);
      expect(processMeasurement(after, { calibrationEnabled: false })).toEqual(
        processMeasurement(before, { calibrationEnabled: false }),
      );
    }
  }
});

it('validates patch ranges, spectrum dimensions/order and calibration state before mutating input', () => {
  const original = impulseMeasurement(),
    before = structuredClone(original);
  const patches: MeasurementProcessingPatch[] = [
    { smoothingOctaves: -1 },
    { smoothingOctaves: 3.1 },
    { smoothingOctaves: NaN },
    { smoothingOctaves: null as unknown as number },
    { calibrationEnabled: 'true' as unknown as boolean },
    { calibrationEnabled: true },
    ...[
      { start: -1 },
      { start: 0.5 },
      { end: 129 },
      { end: 8 },
      { taper: NaN },
      { taper: -0.1 },
      { taper: 1.1 },
      { timeZero: Infinity },
      { timeZero: -1 },
      { timeZero: 129 },
    ].map((patch) => ({ window: { ...window, ...patch } })),
    ...[
      { frequency: [100, 100] },
      { frequency: [100, 90] },
      { frequency: [0, 100] },
      { magnitude: [1] },
      { phase: [0] },
      { sampleRate: 0 },
      { processing: {} },
    ].map((patch) => ({ calibration: { ...calibration, ...patch } as MeasurementCalibration })),
  ];
  for (const patch of patches) expect(() => processMeasurement(original, patch)).toThrow();
  expect(() => processMeasurement(frequencyOnly(), { window })).toThrow('original impulse');
  expect(original).toEqual(before);
});

it('rejects malformed persisted processing and nested/self-referential calibration data', () => {
  const p = newProject(),
    good = combined();
  const invalid = [
    { ...good, sourceSpectrum: { frequency: [100, 50], magnitude: [0, 0] } },
    { ...good, processing: { ...good.processing, smoothingOctaves: -1 } },
    { ...good, processing: { ...good.processing, window: { ...window, end: 999 } } },
    { ...good, processing: { smoothingOctaves: 0, calibrationEnabled: true } },
    { ...good, magnitude: [0] },
  ];
  for (const measurement of invalid) {
    p.presets[0].channels[0].measurement = measurement as Measurement;
    expect(() => parseProject(JSON.stringify(p))).toThrow();
  }
  const recursive = { ...calibration } as MeasurementCalibration & { processing?: unknown };
  recursive.processing = recursive;
  expect(() => processMeasurement(good, { calibration: recursive })).toThrow('Unexpected field');
  const invalidSource = {
    ...good,
    sourceSpectrum: good as unknown as NonNullable<Measurement['sourceSpectrum']>,
  };
  expect(() => validateMeasurement(invalidSource)).toThrow('Unexpected field');
});
