import { newFilter, type Channel, type Preset } from './model';

/** The EQ designer previews its staged bands independently of output processing. */
export function inputEqAnalysisChannel(preset: Preset): Channel {
  return {
    id: 'input-eq-analysis',
    name: 'Input equalizer',
    outputName: 'Input EQ',
    gain: 0,
    additionalGain: 0,
    invert: false,
    muted: false,
    delayUs: 0,
    globalDelayUs: 0,
    fir: { name: '', enabled: false, taps: [] },
    coefficientCache: 'base',
    filters: [...preset.inputEq, ...Array.from({ length: 6 }, () => newFilter())],
  };
}
