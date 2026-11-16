import type { HfdCalibrationCurve } from './hfd-calibration';
import type { NativeCloneTemplate } from './clone-template';
export const FS = 93750;
export const CHANNELS = 3;
/** Native crop/phase setters store signed32-bit indices; FFT capacity is separate. */
export const HFD_INDEX_MIN = -(2 ** 31),
  HFD_INDEX_MAX = 2 ** 31 - 1;
export const SLOTS = ['left', 'right'] as const;
export type Slot = (typeof SLOTS)[number];
export type Coefficients = { b0: number; b1: number; b2: number; f1: number; f2: number };
export type FilterKind =
  | 'unity'
  | 'lowpass1'
  | 'lowpass2'
  | 'highpass1'
  | 'highpass2'
  | 'peak'
  | 'lowshelf1'
  | 'highshelf1'
  | 'lowshelf2'
  | 'highshelf2'
  | 'asymmetric'
  | 'allpass1'
  | 'allpass2'
  | 'raw';
export type NativeShelfDirection = 'stLowShelf' | 'stHighShelf' | 'stUnknown';
export interface Filter {
  id: string;
  kind: FilterKind;
  enabled: boolean;
  frequency: number;
  q: number;
  gain: number;
  frequency2: number;
  q2: number;
  coefficients?: Coefficients;
  provenance?: 'hfd' | 'panel';
  sourceType?: string;
  sourceId?: string;
  shelfDirection?: 'low' | 'high';
  /** Current native enum, distinct from its type-dependent effective direction. */
  sourceShelfDirection?: NativeShelfDirection;
}
export type CoefficientCache = 'base' | 'effective' | 'unresolved';
/** The context used to turn a saved native first cache into canonical data.
 * Later channel gain/bypass edits do not change the saved direct Doubles. */
export interface NativeCacheContext {
  gain: number;
  additionalGain?: number;
  invert: boolean;
  coefficientCache: CoefficientCache;
}
export interface NativeDirectCacheWitness {
  version: 1;
  native: Coefficients;
  firstFilter: Filter;
  /** Ordered browser slot identities; native source IDs remain on the filters. */
  filterIds: string[];
  context: NativeCacheContext;
}
export interface Fir {
  name: string;
  enabled: boolean;
  taps: number[];
  /** Native flags are independent of cached data and the preset placement. */
  hfdState?: HfdFirState;
}
export interface HfdFirState {
  loaded: boolean;
  used: boolean;
  tapCount: number;
}
export interface MeasurementSpectrum {
  frequency: number[];
  magnitude: number[];
  phase?: number[];
}
export interface ImpulseWindow {
  start: number;
  end: number;
  taper: number;
  timeZero: number;
}
export interface MeasurementCalibration extends MeasurementSpectrum {
  name: string;
  sampleRate: number;
}
export interface MeasurementProcessing {
  window?: ImpulseWindow;
  smoothingOctaves: number;
  calibration?: MeasurementCalibration;
  calibrationEnabled: boolean;
}
export interface MeasurementProcessingPatch {
  window?: ImpulseWindow | null;
  smoothingOctaves?: number;
  calibration?: MeasurementCalibration | null;
  calibrationEnabled?: boolean;
}
export interface HfdCalibrationResource {
  content: string;
  curve: HfdCalibrationCurve;
}
export interface HfdProjectCalibration {
  filename: string;
  loaded: boolean;
  showCurve: boolean;
  smoothingOctaves?: number;
  resource?: HfdCalibrationResource;
}
/** Native HFD analysis settings exist independently of a loaded measurement. */
export interface HfdMeasurementOptions {
  sampleRate: number;
  localStart: number;
  stopInclusive: number;
  phaseStart: number;
  sharedStart: number;
  sharedGroupId: number;
  fftLength: number;
  smoothBw: number;
  smoothPostBw: number;
  applyMicCorrection: boolean;
}
export interface Measurement {
  name: string;
  sampleRate: number;
  impulse?: number[];
  frequency?: number[];
  magnitude?: number[];
  phase?: number[];
  sourceSpectrum?: MeasurementSpectrum;
  processing?: MeasurementProcessing;
  hfdPhase?: { frequency: number[]; phase: number[] };
  hfdMagnitude?: { frequency: number[]; linearMagnitude: number[]; medianDb: number };
}
/** Native per-group saved graph flags; other-channel overlay checkboxes are runtime view state. */
export interface HfdGraphOptions {
  showMeasuredResponse: boolean;
  showSum: boolean;
}
/** Native saved Impulse axes: seconds and raw amplitude, including inactive sentinels. */
export interface HfdImpulseZoom {
  left: number;
  right: number;
  top: number;
  bottom: number;
  use: boolean;
}
export interface Channel {
  id: string;
  name: string;
  outputName: string;
  gain: number;
  invert: boolean;
  muted: boolean;
  delayUs: number;
  globalDelayUs: number;
  /** Native Delay.MaxDelay Doubles, retained independently of runtime field
   * bounds and values. Legacy snapshots may omit either field. */
  hfdDelay?: { localMaximum?: number; globalMaximum?: number };
  filters: Filter[];
  fir: Fir;
  includeInSum?: boolean;
  measurement?: Measurement;
  hfdMeasurement?: HfdMeasurementOptions;
  hfdGraph?: HfdGraphOptions;
  hfdImpulseZoom?: HfdImpulseZoom;
  additionalGain?: number;
  linkedTo?: number;
  coefficientCache?: CoefficientCache;
  hfdDirectCacheWitness?: NativeDirectCacheWitness;
}
export interface Preset {
  name: string;
  channels: Channel[];
  inputEq: Filter[];
  eqEnabled: boolean;
  inputFir: Fir;
  firPlacement?: 'input' | 'output';
}
export interface Project {
  format: 'fusion-studio-project';
  version: 1;
  name: string;
  model: 'FA503';
  sampleRate: 93750;
  presets: Preset[];
  sourceXml?: string;
  /** Native document hint; explicit channel compensation edits set it locally.
   * It is not a measurement of physical amplifier attenuation. */
  hfdGainLowered?: boolean;
  /** Saved native group ID, including -1 and unsupported signed32 IDs.
   * Metadata alone does not choose a browser channel or refresh processing. */
  hfdSelectedGroupId?: number;
  /** Saved native preset ID, including unsupported signed32 IDs.
   * Passive metadata does not select a browser preset or apply FileOpen effects. */
  hfdSelectedPreset?: number;
  hfdCalibration?: HfdProjectCalibration;
  /** Physical settings/EQ captured by HFD, independent of editable designs. */
  hfdCloneTemplate?: NativeCloneTemplate;
  warnings: string[];
}
export const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
export const unity = (): Coefficients => ({ b0: 1, b1: 0, b2: 0, f1: 0, f2: 0 });
export const emptyFir = (): Fir => ({ name: '', enabled: false, taps: [] });
export function newFilter(kind: FilterKind = 'unity'): Filter {
  return {
    id: uid(),
    kind,
    enabled: kind !== 'unity',
    frequency: 1000,
    q: Math.SQRT1_2,
    gain: 0,
    frequency2: 2000,
    q2: Math.SQRT1_2,
    ...(kind === 'raw' ? { coefficients: unity() } : {}),
  };
}
export function newProject(name = 'Untitled crossover'): Project {
  return {
    format: 'fusion-studio-project',
    version: 1,
    name,
    model: 'FA503',
    sampleRate: FS,
    hfdSelectedGroupId: -1,
    hfdSelectedPreset: 1,
    warnings: [],
    presets: Array.from({ length: 3 }, (_, p) => ({
      name: `Preset ${p + 1}`,
      eqEnabled: false,
      firPlacement: 'input',
      inputFir: emptyFir(),
      inputEq: [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].map((frequency) => ({
        ...newFilter('peak'),
        frequency,
        enabled: false,
        q: 0.707,
      })),
      channels: ['Woofer', 'Midrange', 'Tweeter'].map((name, i) => ({
        id: uid(),
        name,
        outputName: `Output ${i + 1}`,
        gain: 0,
        invert: false,
        muted: false,
        delayUs: 0,
        globalDelayUs: 0,
        filters: Array.from({ length: 15 }, () => newFilter()),
        fir: emptyFir(),
      })),
    })),
  };
}
export function exampleProject(): Project {
  const project = newProject('Three-way reference');
  for (const p of project.presets) {
    p.channels[0].filters[0] = { ...newFilter('lowpass2'), frequency: 350 };
    p.channels[0].filters[1] = { ...newFilter('lowpass2'), frequency: 350 };
    p.channels[1].filters[0] = { ...newFilter('highpass2'), frequency: 350 };
    p.channels[1].filters[1] = { ...newFilter('highpass2'), frequency: 350 };
    p.channels[1].filters[2] = { ...newFilter('lowpass2'), frequency: 2500 };
    p.channels[1].filters[3] = { ...newFilter('lowpass2'), frequency: 2500 };
    p.channels[2].filters[0] = { ...newFilter('highpass2'), frequency: 2500 };
    p.channels[2].filters[1] = { ...newFilter('highpass2'), frequency: 2500 };
  }
  return project;
}
