import { describe, expect, it } from 'vitest';
import type { Measurement, MeasurementCalibration } from '../src/domain/model';
import {
  applyCalibration,
  processMeasurement,
  resetMeasurementProcessing,
  spectrum,
} from '../src/domain/measurement';

const calibration: MeasurementCalibration = {
  name: 'Complex microphone response',
  sampleRate: 48000,
  frequency: [100, 400, 1600],
  magnitude: [2, 6, -2],
  phase: [20, 60, 100],
};

describe('complex microphone calibration', () => {
  it('independently divides magnitude and subtracts interpolated phase in degrees', () => {
    const measurement: Measurement = {
      name: 'Driver',
      sampleRate: 48000,
      frequency: [50, 100, 200, 400, 800, 1600, 3200],
      magnitude: [10, 10, 10, 10, 10, 10, 10],
      phase: [150, 140, 130, 120, 110, 100, 90],
    };
    const before = structuredClone(measurement);
    const curve = structuredClone(calibration);
    const corrected = applyCalibration(measurement, calibration);
    expect(corrected.magnitude).toEqual([8, 8, 6, 4, 8, 12, 12]);
    expect(corrected.phase).toEqual([130, 120, 90, 60, 30, 0, -10]);
    expect(measurement).toEqual(before);
    expect(calibration).toEqual(curve);
  });

  it('keeps wrapped calibration continuous, including across sparse measurement points', () => {
    const measurement: Measurement = {
      name: 'Continuous phase',
      sampleRate: 48000,
      frequency: [100, 200, 400, 800, 1600],
      magnitude: [0, 0, 0, 0, 0],
      phase: [0, 0, 0, 0, 0],
    };
    const curve = { ...calibration, phase: [170, -170, -150] };
    expect(applyCalibration(measurement, curve).phase).toEqual([-170, -180, -190, -200, -210]);
    const sparse = { ...measurement, frequency: [100, 1600], magnitude: [0, 0], phase: [0, 0] };
    expect(applyCalibration(sparse, curve).phase).toEqual([-170, -210]);
  });

  it('retains the phase origin of an already unwrapped calibration curve', () => {
    const measurement: Measurement = {
      name: 'Unwrapped driver',
      sampleRate: 48000,
      frequency: [100, 200, 400, 800, 1600],
      magnitude: [0, 0, 0, 0, 0],
      phase: [720, 720, 720, 720, 720],
    };
    expect(applyCalibration(measurement, { ...calibration, phase: [450, 510, 570] }).phase).toEqual(
      [270, 240, 210, 180, 150],
    );
  });

  it('preserves unknown driver phase and treats magnitude-only calibration as phase neutral', () => {
    const measurement: Measurement = {
      name: 'Magnitude only',
      sampleRate: 48000,
      frequency: [100, 400, 1600],
      magnitude: [10, 10, 10],
    };
    expect(applyCalibration(measurement, calibration).phase).toBeUndefined();
    expect(Object.hasOwn(applyCalibration(measurement, calibration), 'phase')).toBe(false);
    const { phase: _phase, ...magnitudeOnlyCurve } = calibration;
    const withPhase = { ...measurement, phase: [120, 90, -40] };
    expect(applyCalibration(withPhase, magnitudeOnlyCurve).phase).toEqual(withPhase.phase);
  });

  it('reapplies phase from source data, and bypass/reset restore original frequency phase', () => {
    const original: Measurement = {
      name: 'FRD source',
      sampleRate: 48000,
      frequency: [100, 200, 400, 800, 1600],
      magnitude: [2, 5, -1, 6, 0],
      phase: [150, 130, 90, 20, -60],
    };
    const first = processMeasurement(original, {
      calibration,
      calibrationEnabled: true,
      smoothingOctaves: 1,
    });
    const again = processMeasurement(first, { calibrationEnabled: true, smoothingOctaves: 1 });
    expect(again).toEqual(first);
    expect(first.sourceSpectrum?.phase).toEqual(original.phase);
    expect(first.phase).toEqual([130, 90, 30, -60, -160]);
    expect(processMeasurement(again, { calibrationEnabled: false }).phase).toEqual(original.phase);
    expect(resetMeasurementProcessing(again).phase).toEqual(original.phase);
    expect(original.phase).toEqual([150, 130, 90, 20, -60]);
  });

  it('calibrates only windowed display phase and leaves original impulse/time response intact', () => {
    const original = spectrum([0, 0, 1, 0.25, 0, -0.1, 0, 0], 48000);
    const window = { start: 1, end: 7, taper: 0.2, timeZero: 2 };
    const windowed = spectrum(original.impulse!, 48000, window);
    const first = processMeasurement(original, {
      window,
      calibration,
      calibrationEnabled: true,
      smoothingOctaves: 1 / 3,
    });
    expect(first.impulse).toEqual(original.impulse);
    expect(first.phase).toEqual(applyCalibration(windowed, calibration).phase);
    expect(processMeasurement(first, { window, smoothingOctaves: 1 / 3 })).toEqual(first);
    expect(processMeasurement(first, { calibrationEnabled: false }).phase).toEqual(windowed.phase);
    const reset = resetMeasurementProcessing(first);
    expect(reset.phase).toEqual(original.phase);
    expect(reset.impulse).toEqual(original.impulse);
  });
});
