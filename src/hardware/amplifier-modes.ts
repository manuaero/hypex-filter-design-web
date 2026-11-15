import { control, decodeStatus, settings, type PanelStatus } from './codec';
import type { Identity } from './session';

export interface AmplifierModes {
  master: boolean;
  bridge: boolean;
  softClip: boolean;
}
export type AmplifierModesPatch = Partial<AmplifierModes>;
export type AmplifierModesIdentity = Pick<Identity, 'serial' | 'product' | 'core' | 'firmware'>;
export interface AmplifierModesSummary extends AmplifierModes {
  wakeOnLine: boolean;
  signalDetection: boolean;
  startupVolume: number;
  standbyMode: number;
  sourceLocks: [boolean, boolean, boolean];
  volumeLocks: [boolean, boolean, boolean];
}
export interface AmplifierModesCapture {
  identity: AmplifierModesIdentity;
  status: Uint8Array;
  configuration: Uint8Array;
  configuredModuleType: number;
  summary: AmplifierModesSummary;
}
export interface AmplifierModesPlan {
  before: AmplifierModesSummary;
  after: AmplifierModesSummary;
  summary: AmplifierModesSummary;
  request: Uint8Array;
  baselineMask: Uint8Array;
}

export function validateAmplifierModesPatch(value: AmplifierModesPatch): AmplifierModesPatch {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length === 0 ||
    Object.entries(value).some(
      ([key, entry]) =>
        !['master', 'bridge', 'softClip'].includes(key) || typeof entry !== 'boolean',
    )
  )
    throw new Error('Choose at least one valid amplifier mode');
  return { ...value };
}

function rawStatus(raw: Uint8Array): PanelStatus {
  if (!(raw instanceof Uint8Array) || raw.length !== 64 || raw[0] !== 5)
    throw new Error('Amplifier modes require a complete 05 status');
  return decodeStatus(raw);
}

export function summarizeAmplifierModes(raw: Uint8Array): AmplifierModesSummary {
  const state = settings(rawStatus(raw));
  return {
    master: state.master,
    bridge: state.bridge,
    softClip: state.softClip,
    wakeOnLine: state.wakeOnLine,
    signalDetection: state.signalDetection,
    startupVolume: state.startupVolume,
    standbyMode: state.standbyMode,
    sourceLocks: [12, 13, 14].map((index) => !!(raw[index] & 128)) as [boolean, boolean, boolean],
    volumeLocks: [12, 13, 14].map((index) => !!(raw[index] & 32)) as [boolean, boolean, boolean],
  };
}

export function amplifierModesSummary(status: PanelStatus): AmplifierModesSummary {
  return summarizeAmplifierModes(status.raw);
}

/** Only reviewed mode bits and native mode-dependent fields fence the review.
 * Fresh runtime, LEDs, source IDs, ADC/EQ and security fields are rebased. */
export function amplifierModesBaselineMask(patch: AmplifierModesPatch): Uint8Array {
  const proposal = validateAmplifierModesPatch(patch),
    mask = new Uint8Array(64);
  mask[9] = 0x16; // bridge, inverse Master and soft clip
  if (proposal.master === false) {
    mask[9] |= 9; // native Slave clears signal detection and wake-on-line
    mask[7] = mask[21] = mask[22] = 255;
  } else if (proposal.master === true) {
    // Native Master clears each preset's source/volume locks, not source/ADC/EQ.
    mask[12] = mask[13] = mask[14] = 0xa0;
  }
  return mask;
}

export function assertAmplifierModesBaseline(
  expected: Uint8Array,
  current: Uint8Array,
  patch: AmplifierModesPatch,
): void {
  rawStatus(expected);
  rawStatus(current);
  const mask = amplifierModesBaselineMask(patch);
  if (mask.some((bits, index) => (expected[index] & bits) !== (current[index] & bits)))
    throw new Error('Amplifier modes or their dependent settings changed; review again');
}

export function planAmplifierModes(
  status: PanelStatus,
  patch: AmplifierModesPatch,
  configuredModuleType?: number,
): AmplifierModesPlan {
  rawStatus(status.raw);
  const proposal = validateAmplifierModesPatch(patch),
    request = control(status, proposal, configuredModuleType),
    summary = summarizeAmplifierModes(request);
  return {
    before: summarizeAmplifierModes(status.raw),
    after: summary,
    summary,
    request,
    baselineMask: amplifierModesBaselineMask(proposal),
  };
}
