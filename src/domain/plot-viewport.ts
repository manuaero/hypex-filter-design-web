import { DEFAULT_TIME_RANGE, type TimePlotRange } from './time-series';

export const PLOT_MODES = ['Magnitude', 'Phase', 'Group delay', 'Impulse', 'Step'] as const;
export type PlotMode = (typeof PLOT_MODES)[number];
export interface PlotRange extends TimePlotRange {
  frequencyMin: number;
  frequencyMax: number;
  /** Frequency-chart Y bounds: dB, degrees, or milliseconds according to mode. */
  dbMin: number;
  dbMax: number;
}
export const DEFAULT_RANGE: Readonly<PlotRange> = Object.freeze({
  ...DEFAULT_TIME_RANGE,
  frequencyMin: 10,
  frequencyMax: 40000,
  dbMin: -60,
  dbMax: 20,
});
export function defaultPlotRange(mode: PlotMode): PlotRange {
  return {
    ...DEFAULT_RANGE,
    ...(mode === 'Phase'
      ? { dbMin: -180, dbMax: 180 }
      : mode === 'Group delay'
        ? { dbMin: -5, dbMax: 25 }
        : {}),
  };
}
export function validatePlotRange(range: PlotRange): void {
  if (
    !range ||
    ![
      'frequencyMin',
      'frequencyMax',
      'dbMin',
      'dbMax',
      'timeMinMs',
      'timeMaxMs',
      'amplitudeMin',
      'amplitudeMax',
    ].every((key) => Number.isFinite(range[key as keyof PlotRange])) ||
    range.frequencyMin < 0.001 ||
    range.frequencyMax > 50000 ||
    range.frequencyMin >= range.frequencyMax ||
    range.dbMin >= range.dbMax ||
    range.timeMinMs >= range.timeMaxMs ||
    range.amplitudeMin >= range.amplitudeMax
  )
    throw new Error('Graph bounds must be finite with each minimum below its maximum');
}
