import { expect, it, vi } from 'vitest';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';
import { newFilter, newProject } from '../src/domain/model';
import { defaultsHfdMeasurementOptions } from '../src/domain/hfd-measurement';
import { presetResponse } from '../src/domain/dsp';

it.each([
  { muted: false, measured: false },
  { muted: true, measured: false },
  { muted: false, measured: true },
  { muted: true, measured: true },
])(
  'reports native display separately from cached complex diagnostics and sums ($muted mute, $measured measurement)',
  async ({ muted, measured }) => {
    const project = newProject(),
      preset = project.presets[0],
      c = preset.channels[0];
    c.hfdMeasurement = defaultsHfdMeasurementOptions();
    c.filters[0] = {
      ...newFilter('peak'),
      frequency: 2300,
      q: 1.15,
      gain: 7.5,
      coefficients: { b0: 0.75, b1: 0.125, b2: 0.0625, f1: 0.25, f2: -0.125 },
    };
    c.gain = -3;
    c.additionalGain = 10;
    c.muted = muted;
    if (measured) {
      const frequency = [1000, 2300, 5000];
      c.measurement = {
        name: 'Synthetic unit IR cache',
        sampleRate: 48000,
        impulse: [1, 0],
        frequency,
        magnitude: [0, 0, 0],
        phase: [0, 0, 0],
        hfdMagnitude: { frequency, linearMagnitude: [1, 1, 1], medianDb: 0 },
        hfdPhase: { frequency, phase: [30, 30, 30] },
      };
    }
    preset.channels[1].includeInSum = false;
    preset.channels[2].includeInSum = false;
    const before = structuredClone(project),
      forbidden = vi.fn(() => {
        throw new Error('Unexpected mutation or hardware');
      });
    const adapter: ToolAdapter = {
      state: () => ({
        documents: { left: project, right: newProject() },
        slot: 'left',
        preset: 0,
        channel: 0,
        filter: 0,
        linkedEdits: false,
        linkedControls: false,
      }),
      edit: forbidden,
      choose: forbidden,
      undo: forbidden,
      redo: forbidden,
      connections: forbidden,
      connect: forbidden,
      disconnect: forbidden,
      refresh: forbidden,
      operate: forbidden,
      progress: forbidden,
      message: forbidden,
      view: forbidden,
    };
    const result = (await createToolExecutor(adapter)('fusion_analyze', {
      slot: 'left',
      preset: 1,
      frequencies: [1000],
      measured,
      nativeCentered: false,
    })) as {
      points: {
        channels: {
          real: number;
          imaginary: number;
          db: number;
          phaseDegrees: number;
          viewDb: number;
          viewPhaseDegrees: number;
        }[];
        viewSumDb: number;
        viewSumPhaseDegrees: number;
        sumReal: number;
        sumImaginary: number;
      }[];
      nativeView: unknown;
    };
    const point = result.points[0],
      raw = presetResponse(preset, 0, 1000, measured),
      channel = point.channels[0];
    if (measured) expect(result.nativeView).not.toBeNull();
    else expect(result.nativeView).toBeNull();
    expect([channel.real, channel.imaginary]).toEqual(raw);
    expect(channel.db).toBeCloseTo(20 * Math.log10(Math.max(1e-12, Math.hypot(...raw))), 12);
    expect(channel.phaseDegrees).toBeCloseTo((Math.atan2(raw[1], raw[0]) * 180) / Math.PI, 12);
    expect(channel.viewDb).toBeCloseTo(9.6136991985395195, 9);
    expect(channel.viewPhaseDegrees).toBeCloseTo(22.93321212711359 + (measured ? 30 : 0), 9);
    expect(point.viewSumDb).toBeCloseTo(channel.viewDb, 12);
    expect(point.viewSumPhaseDegrees).toBeCloseTo(channel.viewPhaseDegrees, 12);
    expect([point.sumReal, point.sumImaginary]).toEqual(raw);
    expect(project).toEqual(before);
    expect(forbidden).not.toHaveBeenCalled();
  },
);
