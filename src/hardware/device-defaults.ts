import { control, decodeStatus, settings } from './codec';
import { decodeHardwareOverview, decodeLimiter } from './device-settings';
import type { Identity } from './session';

export type DeviceDefaultsIdentity = Pick<Identity, 'serial' | 'product' | 'core' | 'firmware'>;
export interface DeviceDefaultsSnapshot {
  identity: DeviceDefaultsIdentity;
  status: Uint8Array;
  configuration: Uint8Array;
  deviceConfiguration: Uint8Array;
}
export interface DeviceDefaultsStep {
  id:
    | 'settings'
    | 'mixer'
    | 'configuration'
    | 'display'
    | 'restore-configuration'
    | 'restore-settings'
    | 'mute';
  request: Uint8Array;
  verification: { expected: Uint8Array; mask: Uint8Array };
}
export type DeviceDefaultsSummary = ReturnType<typeof settings> & {
  preset: number;
  volume: number;
  muted: boolean;
  channelMutes: boolean[];
  routing: number;
  motionFeedback: boolean;
  sourceLocks: boolean[];
  volumeLocks: boolean[];
  presetSources: number[];
  eqEnabled: boolean[];
  firFlags: number[];
  firPlacements: number[];
  oledCapable: boolean;
  thirdChannelEnabled: boolean;
  limiterChannels: ReturnType<typeof decodeLimiter>['channels'];
};
export interface DeviceDefaultsPlan {
  snapshot: DeviceDefaultsSnapshot;
  before: DeviceDefaultsSummary;
  after: DeviceDefaultsSummary;
  steps: readonly DeviceDefaultsStep[];
}

/** Stable writable status projection, not the RX trigger/password/telemetry bytes. */
export function deviceDefaultsStatusMask(): Uint8Array {
  const mask = new Uint8Array(64);
  for (const i of [
    0, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 25, 27, 28, 29,
    30, 31, 35,
  ])
    mask[i] = 0xff;
  mask[36] = 0xfb;
  return mask;
}

function validate(snapshot: DeviceDefaultsSnapshot): void {
  const { identity, status, configuration, deviceConfiguration } = snapshot;
  if (
    ![status, configuration, deviceConfiguration].every(
      (b) => b instanceof Uint8Array && b.length === 64,
    )
  )
    throw new Error('Device Defaults requires complete 05, 06 and 66 snapshots');
  decodeHardwareOverview(configuration, deviceConfiguration);
  const state = decodeStatus(status);
  if (state.locked) throw new Error('Device Defaults requires an unlocked amplifier');
  const view = new DataView(
    configuration.buffer,
    configuration.byteOffset,
    configuration.byteLength,
  );
  const firmware = `${view.getUint16(15, true)}.${view.getUint16(17, true)}`;
  if (
    !identity ||
    identity.product !== 22 ||
    identity.core !== '5.1' ||
    typeof identity.serial !== 'string' ||
    !identity.serial.length ||
    identity.serial.length > 200 ||
    /[\x00-\x1f\x7f]/.test(identity.serial) ||
    identity.firmware !== firmware
  )
    throw new Error('Device Defaults requires a matching FA503 / DSP 5.1 identity');
}

function cloneSnapshot(snapshot: DeviceDefaultsSnapshot): DeviceDefaultsSnapshot {
  const identity = Object.freeze({ ...snapshot.identity });
  const status = snapshot.status.slice(),
    configuration = snapshot.configuration.slice(),
    deviceConfiguration = snapshot.deviceConfiguration.slice();
  return Object.freeze({
    identity,
    get status() {
      return status.slice();
    },
    get configuration() {
      return configuration.slice();
    },
    get deviceConfiguration() {
      return deviceConfiguration.slice();
    },
  });
}
function summary(
  snapshot: DeviceDefaultsSnapshot,
  statusBytes: Uint8Array,
  deviceBytes: Uint8Array,
): DeviceDefaultsSummary {
  const state = decodeStatus(statusBytes),
    overview = decodeHardwareOverview(snapshot.configuration, deviceBytes);
  const result: DeviceDefaultsSummary = {
    ...settings(state),
    detectionOff: (statusBytes[27] >> 2) & 3,
    preset: state.preset,
    volume: state.volume,
    muted: state.muted,
    channelMutes: state.channelMutes,
    routing: statusBytes[11] & 7,
    motionFeedback: !!(statusBytes[11] & 8),
    sourceLocks: [12, 13, 14].map((i) => !!(statusBytes[i] & 128)),
    volumeLocks: [12, 13, 14].map((i) => !!(statusBytes[i] & 32)),
    presetSources: [12, 13, 14].map((i) => statusBytes[i] & 15),
    eqEnabled: [12, 13, 14].map((i) => !!(statusBytes[i] & 16)),
    firFlags: [28, 29, 30].map((i) => statusBytes[i]),
    firPlacements: [0, 1, 2].map((i) => (statusBytes[31] >> i) & 1),
    oledCapable: overview.oledCapable,
    thirdChannelEnabled: overview.thirdChannelEnabled,
    limiterChannels: decodeLimiter(deviceBytes).channels,
  };
  for (const value of Object.values(result))
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'object' && item) Object.freeze(item);
      Object.freeze(value);
    }
  return Object.freeze(result);
}
function step(id: DeviceDefaultsStep['id'], source: Uint8Array): DeviceDefaultsStep {
  const request = source.slice(),
    expected = source.slice();
  let mask: Uint8Array;
  if (source[0] === 5) mask = deviceDefaultsStatusMask();
  else {
    mask = new Uint8Array(64).fill(255);
    mask[1] = 0;
    expected[1] = 0;
  }
  const verification = Object.freeze({
    get expected() {
      return expected.slice();
    },
    get mask() {
      return mask.slice();
    },
  });
  return Object.freeze({
    id,
    get request() {
      return request.slice();
    },
    verification,
  });
}
function plan(
  snapshot: DeviceDefaultsSnapshot,
  finalStatus: Uint8Array,
  finalConfiguration: Uint8Array,
  steps: DeviceDefaultsStep[],
): DeviceDefaultsPlan {
  return Object.freeze({
    snapshot: cloneSnapshot(snapshot),
    before: summary(snapshot, snapshot.status, snapshot.deviceConfiguration),
    after: summary(snapshot, finalStatus, finalConfiguration),
    steps: Object.freeze(steps),
  });
}

/** Native bDefaultsClick c1b56c: four reports; this pure builder performs no I/O. */
export function buildDeviceDefaultsPlan(input: DeviceDefaultsSnapshot): DeviceDefaultsPlan {
  validate(input);
  const snapshot = cloneSnapshot(input),
    original = snapshot.status;
  const first = control(decodeStatus(original), {
    mute: true,
    presetOffsets: [0, 0, 0],
    bridge: false,
    master: true,
    powerOffMinutes: 15,
    standbyMode: 0,
    softClip: false,
    wakeOnLine: true,
    signalDetection: true,
    subAbsolute: false,
    analogGainXlr: false,
    analogGainRca: false,
    startupVolume: -40,
    soundQuality: 1,
    dacFilter: 0,
    firMode: 0,
    detectionOn: 0,
    detectionOff: 0,
  });
  // Native RX keeps two bits per index; TX reconstructs this whole byte.
  // Defaults ON/OFF=0 therefore emits 00, including any unmodeled RX high bits.
  const mixer = control(decodeStatus(first), { mute: true, routing: 2 });
  const configuration = snapshot.deviceConfiguration;
  configuration[1] = 1;
  const v = new DataView(configuration.buffer);
  for (let i = 0; i < 3; i++) {
    // Native controls format to six decimals BEFORE coefficient Q24 conversion.
    v.setInt32(20 + 4 * i, i < 2 ? 48180524 : configuration[13] ? 90627954 : 335544320, true);
    v.setInt32(32 + 4 * i, 16273900, true);
    v.setInt32(44 + 4 * i, 16776377, true);
    configuration[56 + i] = 40;
    configuration[59 + i] = 20;
  }
  const display = control(decodeStatus(mixer), {
    mute: true,
    oledMaximumBrightness: 15,
    oledDimmedBrightness: 6,
    standbyLedMode: 0,
  });
  return plan(snapshot, display, configuration, [
    step('settings', first),
    step('mixer', mixer),
    step('configuration', configuration),
    step('display', display),
  ]);
}

/** Browser recovery: restore only action-owned fields into fresh live packets, retaining mute. */
export function buildDeviceDefaultsRecoveryPlan(
  original: DeviceDefaultsSnapshot,
  currentStatus: Uint8Array,
  currentDeviceConfiguration: Uint8Array,
): DeviceDefaultsPlan {
  validate(original);
  const current: DeviceDefaultsSnapshot = {
    ...original,
    status: currentStatus,
    deviceConfiguration: currentDeviceConfiguration,
  };
  validate(current);
  const status = control(decodeStatus(currentStatus), { mute: true });
  const before = original.status;
  for (const i of [7, 8, 9, 10, 15, 16, 17, 18, 19, 20, 21, 22, 27, 35]) status[i] = before[i];
  status[11] = (status[11] & 0xf8) | (before[11] & 7);
  for (const i of [12, 13, 14]) status[i] = (status[i] & 0x5f) | (before[i] & 0xa0);
  status[36] = (status[36] & 0xfc) | (before[36] & 3);
  status[23] = 0x0c; // Rebuild explicit detection/display updates; never echo RX triggers.
  const configuration = currentDeviceConfiguration.slice();
  configuration[1] = 1;
  configuration.set(original.deviceConfiguration.subarray(20, 62), 20);
  return plan(current, status, configuration, [
    step('restore-configuration', configuration),
    step('restore-settings', status),
  ]);
}

export function verifyDeviceDefaultsStep(step: DeviceDefaultsStep, actual: Uint8Array): void {
  const expected = step.verification.expected,
    mask = step.verification.mask;
  if (
    !(actual instanceof Uint8Array) ||
    actual.length !== 64 ||
    expected.length !== 64 ||
    mask.length !== 64
  )
    throw new Error('Invalid Device Defaults verification frame');
  for (let i = 0; i < 64; i++)
    if ((actual[i] & mask[i]) !== (expected[i] & mask[i]))
      throw new Error(`Device Defaults ${step.id} readback differs at byte ${i}`);
}
