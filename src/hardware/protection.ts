import type { Controls, PanelStatus } from './codec';
import { decodeStatusFlags } from './status-flags';

/** Native TOEMEnabledItem 0x9a4058 and bit table 0xd3ac2c. */
export const OEM_ITEMS = Object.freeze(
  (
    [
      ['inputSource', 'Input source'],
      ['volumeMute', 'Volume and mute'],
      ['preset', 'Preset'],
      ['deviceSettings', 'Device settings'],
      ['softclipLimiter', 'Soft-clip limiter'],
      ['bridge', 'Bridge'],
      ['masterSlave', 'Master/slave'],
      ['uploadFilters', 'Upload filters'],
      ['updateFirmware', 'Update firmware'],
      ['dacFilter', 'DAC filter'],
      ['digitalLeftRight', 'Digital left/right'],
      ['equalizer', 'Equalizer'],
      ['motionFeedback', 'Motion feedback'],
      ['routing', 'Routing'],
    ] as const
  ).map(([id, label], ordinal) => Object.freeze({ id, label, ordinal, mask: 1 << ordinal })),
);
export type ProtectionOperation =
  | 'inputSource'
  | 'volumeMute'
  | 'preset'
  | 'deviceSettings'
  | 'softclipLimiter'
  | 'bridge'
  | 'masterSlave'
  | 'uploadFilters'
  | 'updateFirmware'
  | 'dacFilter'
  | 'digitalLeftRight'
  | 'equalizer'
  | 'motionFeedback'
  | 'routing'
  | 'manufacturing'
  | 'unknown';
export interface OperationPermission {
  allowed: boolean;
  requiredItems: string[];
  reason?: string;
}
export interface ProtectionReport {
  passwordProtected: boolean;
  passwordMatched: boolean;
  locked: boolean;
  rawMask: number;
  effectiveMask: number;
  moduleType?: number;
  isOemConfigured: boolean;
  items: ((typeof OEM_ITEMS)[number] & { maskEnabled: boolean })[];
  operations: Record<ProtectionOperation, OperationPermission>;
}
export const runtimeProtectionOperation = (operation: ProtectionOperation) =>
  ['inputSource', 'volumeMute', 'preset'].includes(operation);

/** Permission policy recovered from the installed HFD host, not a password verifier.
 * 05 raw51 bit0=signal, bit1=protected, bit2=matched; raw24..25=stored OEM mask.
 * Native runtime callbacks d059b0/d00ee4/d05a58 do not gate the first three
 * operations on mask bits. Settings/EQ/firmware entry d01a4c additionally
 * requires configured OEM module1; IIR upload c4f160 honors bit7 independently.
 * Settings child gates c1ad56..ae81 intersect the entry permission. */
export function decodeProtection(status: PanelStatus, moduleType?: number): ProtectionReport {
  const raw = status.raw;
  if (raw.length !== 64 || raw[0] !== 5) throw new Error('Invalid protection status');
  if (
    moduleType !== undefined &&
    (!Number.isInteger(moduleType) || moduleType < 0 || moduleType > 255)
  )
    throw new Error('Invalid configured module type');
  const { passwordProtected, passwordMatched, locked } = decodeStatusFlags(raw);
  const rawMask = raw[24] | (raw[25] << 8),
    effectiveMask = passwordProtected ? rawMask : 0xffff,
    isOemConfigured = moduleType === 1;
  const operations = {} as ProtectionReport['operations'];
  for (const operation of [
    ...OEM_ITEMS.map((item) => item.id),
    'manufacturing',
    'unknown',
  ] as ProtectionOperation[]) {
    const special = [
        'softclipLimiter',
        'bridge',
        'masterSlave',
        'dacFilter',
        'digitalLeftRight',
      ].includes(operation),
      requiredItems = special ? ['deviceSettings', operation] : [operation];
    let allowed = !locked || runtimeProtectionOperation(operation),
      reason: string | undefined;
    if (!allowed) {
      if (
        operation === 'manufacturing' ||
        operation === 'unknown' ||
        operation === 'motionFeedback' ||
        operation === 'routing'
      )
        reason =
          'Panel is password locked; this operation requires an unlocked panel until its native item mapping is established';
      else if (operation !== 'uploadFilters' && !isOemConfigured)
        reason =
          'Panel is password locked; native access requires an unlocked panel for a non-OEM or unknown configured module';
      else {
        const missing = requiredItems.filter(
          (id) => !(rawMask & OEM_ITEMS.find((item) => item.id === id)!.mask),
        );
        allowed = missing.length === 0;
        if (!allowed)
          reason = `Panel is password locked; OEM permission denied: ${missing.join(', ')}`;
      }
    }
    operations[operation] = { allowed, requiredItems, ...(reason ? { reason } : {}) };
  }
  return {
    passwordProtected,
    passwordMatched,
    locked,
    rawMask,
    effectiveMask,
    moduleType,
    isOemConfigured,
    items: OEM_ITEMS.map((item) => ({ ...item, maskEnabled: !!(effectiveMask & item.mask) })),
    operations,
  };
}
export function assertOperationAllowed(
  status: PanelStatus,
  operation: ProtectionOperation,
  moduleType?: number,
) {
  const permission = decodeProtection(status, moduleType).operations[operation];
  if (!permission.allowed) throw new Error(permission.reason);
}
export function requiredControlOperations(patch: Controls): ProtectionOperation[] {
  const result = new Set<ProtectionOperation>();
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    let operation: ProtectionOperation;
    if (['mute', 'volume', 'channelMutes', 'outputMute'].includes(key)) operation = 'volumeMute';
    else if (key === 'preset') operation = 'preset';
    else if (key === 'forceInput') operation = 'inputSource';
    else if (['eqEnabled', 'presetEq'].includes(key)) operation = 'equalizer';
    else if (key === 'presetFir') operation = 'uploadFilters';
    else if (key === 'softClip') operation = 'softclipLimiter';
    else if (key === 'bridge') operation = 'bridge';
    else if (key === 'master') operation = 'masterSlave';
    else if (['dacFilter', 'soundQuality', 'firMode'].includes(key)) operation = 'dacFilter';
    else if (key === 'routing') operation = 'digitalLeftRight';
    else if (
      [
        'presetOffsets',
        'startupVolume',
        'powerOffMinutes',
        'standbyMode',
        'signalDetection',
        'wakeOnLine',
        'subAbsolute',
        'analogGainXlr',
        'analogGainRca',
        'detectionOn',
        'detectionOff',
        'oledMaximumBrightness',
        'oledDimmedBrightness',
        'standbyLedMode',
      ].includes(key)
    )
      operation = 'deviceSettings';
    else operation = 'unknown';
    result.add(operation);
  }
  // An empty reconstructed settings write has no proven permitted action.
  return result.size ? [...result] : ['unknown'];
}
