import type { Identity } from './session';
import { decodeStatus, packet, hex } from './codec';
import { decodeHardwareOverview } from './device-settings';
import { assertOperationAllowed } from './protection';
import { q24 } from '../domain/dsp';

export type NativeMixerIdentity = Pick<Identity, 'serial' | 'product' | 'core' | 'firmware'>;
export type NativeMixerRow = readonly [number, number, number, number, number, number];
export type NativeMatrix = readonly [NativeMixerRow, NativeMixerRow, NativeMixerRow];
export interface NativeMixerCapture {
  identity: NativeMixerIdentity;
  status: Uint8Array;
  configuration: Uint8Array;
  deviceConfiguration: Uint8Array;
  mixerConfiguration: Uint8Array;
}
export interface NativeMixerRowEdit {
  preset: 1 | 2 | 3;
  weights: readonly number[];
}
export interface NativeMixerPlan {
  readonly rows: readonly NativeMixerRowEdit[];
  readonly request: Uint8Array;
  readonly verification: { readonly expected: Uint8Array; readonly mask: Uint8Array };
  readonly before: NativeMatrix;
  readonly after: NativeMatrix;
  readonly editedPresets: readonly (1 | 2 | 3)[];
}
export interface NativeMixerAvailabilityInput {
  product: number;
  moduleType: number;
  core: string;
  systemSetup: number;
  stereoDsp: boolean;
}
export interface NativeMixerAvailability {
  /** Native group reachability predicate; this is independent of password access. */
  groupVisible: boolean;
  /** The actual reported StereoDSP flag, even when the native editor is unavailable. */
  enabled: boolean;
  editorAvailable: boolean;
  routingChoices: readonly number[];
  reason?: string;
}

/** Native c197b8/c194cc/c18fd4. No manufacturing Enable mixer operation. */
export function nativeMixerAvailability(
  input: NativeMixerAvailabilityInput,
): NativeMixerAvailability {
  const valid = [input.product, input.moduleType, input.systemSetup].every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 255,
    ),
    groupVisible =
      valid &&
      input.product !== 0x90 &&
      ([18, 22].includes(input.product) || input.moduleType === 1) &&
      !!(input.systemSetup & 2),
    core = /^(\d+)\.(\d+)$/.exec(input.core),
    versionSupported =
      !!core &&
      Number(core[1]) <= 255 &&
      Number(core[2]) <= 255 &&
      (Number(core[1]) > 1 || (Number(core[1]) === 1 && Number(core[2]) >= 50)),
    enabled = input.stereoDsp === true,
    editorAvailable = groupVisible && input.moduleType === 1 && versionSupported && enabled;
  const reason = !valid
    ? 'Invalid native mixer capability metadata'
    : !groupVisible
      ? 'The amplifier does not advertise the native digital mixer group'
      : input.moduleType !== 1
        ? 'Native User mixer requires configured OEM module 1'
        : !versionSupported
          ? 'Native User mixer requires DSP core 1.50 or later'
          : !enabled
            ? 'The manufacturing StereoDSP mixer flag is disabled; this editor does not change it'
            : undefined;
  return Object.freeze({
    groupVisible,
    enabled,
    editorAvailable,
    routingChoices: Object.freeze(editorAvailable ? [0, 1, 2, 3, 4] : [0, 1, 2]),
    ...(reason ? { reason } : {}),
  });
}

export function decodeNativeMixer(raw: Uint8Array): NativeMatrix {
  if (!(raw instanceof Uint8Array) || raw.length !== 64 || raw[0] !== 0x67)
    throw new Error('Native mixer requires a complete 67 response');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return Object.freeze(
    Array.from({ length: 3 }, (_, p) =>
      Object.freeze(
        Array.from({ length: 6 }, (_, n) => view.getInt16(2 + (p * 6 + n) * 2, true) / 256),
      ),
    ),
  ) as unknown as NativeMatrix;
}

/** Explicit modal-load normalization: loaded signed-Q8 Singles are exact, so
 * clamp then #0.00 decimal carry has no binary conversion ambiguity. Inactive
 * rows must never pass through this helper merely because another preset opens. */
export function nativeMixerEditorRow(row: readonly number[]): NativeMixerRow {
  if (row.length !== 6 || row.some((value) => !Number.isFinite(value)))
    throw new Error('Native mixer row requires six finite weights');
  return Object.freeze(
    row.map((value) => nativeMixerEditorWeight(Math.max(-1, Math.min(1, value)))),
  ) as unknown as NativeMixerRow;
}

/** Browser numeric edits enter native Text as their canonical decimal spelling.
 * FormatFloat431e27/431eb2 uses18-significant nearest/even then >=5 decimal
 * carry; canonical numeric input has at most17 significant digits. Decimal
 * integer arithmetic preserves exact +/-half ties before final Single storage. */
export function nativeMixerEditorWeight(value: number): number {
  if (!Number.isFinite(value) || value < -1 || value > 1)
    throw new Error('Edited native mixer weights must be -1..1');
  const [mantissa, exp = '0'] = String(Math.abs(value)).split('e'),
    parts = mantissa.split('.'),
    digits = BigInt(parts.join('')),
    power = Number(exp) - (parts[1]?.length ?? 0) + 2;
  const numerator = power >= 0 ? digits * 10n ** BigInt(power) : digits,
    denominator = power >= 0 ? 1n : 10n ** BigInt(-power),
    hundredths = (numerator * 2n + denominator) / (denominator * 2n),
    parsed = Number(hundredths) / 100;
  return parsed === 0 ? 0 : Math.fround(value < 0 ? -parsed : parsed);
}

export function assertNativeMixerCapture(
  capture: NativeMixerCapture,
  requirePermission = true,
): void {
  const { identity, status, configuration, deviceConfiguration, mixerConfiguration } = capture;
  const hardware = decodeHardwareOverview(configuration, deviceConfiguration),
    state = decodeStatus(status);
  const view = new DataView(
    configuration.buffer,
    configuration.byteOffset,
    configuration.byteLength,
  );
  if (
    !identity ||
    identity.product !== 22 ||
    identity.core !== '5.1' ||
    !identity.serial ||
    identity.serial.length > 200 ||
    /[^\x20-\x7e]/.test(identity.serial) ||
    identity.firmware !== `${view.getUint16(15, true)}.${view.getUint16(17, true)}` ||
    configuration[5] !== 3 ||
    configuration[12] !== 3
  )
    throw new Error(
      'Native mixer requires a captured three-preset / three-channel FA503 DSP5.1 identity',
    );
  const availability = nativeMixerAvailability({
    product: configuration[1],
    moduleType: hardware.moduleType,
    core: identity.core,
    systemSetup: configuration[4],
    stereoDsp: hardware.stereoDsp,
  });
  if (!availability.editorAvailable) throw new Error(availability.reason);
  decodeNativeMixer(mixerConfiguration);
  if (requirePermission) assertOperationAllowed(state, 'digitalLeftRight', hardware.moduleType);
}

/** Full matrix and capability fence; unrelated volume/mute/signal telemetry may
 * change because no common05 packet is reconstructed by a mixer save. */
export function assertNativeMixerBaseline(
  baseline: NativeMixerCapture,
  current: NativeMixerCapture,
): void {
  assertNativeMixerCapture(baseline);
  assertNativeMixerCapture(current);
  if (
    (['serial', 'product', 'core', 'firmware'] as const).some(
      (key) => baseline.identity[key] !== current.identity[key],
    ) ||
    hex(baseline.configuration) !== hex(current.configuration) ||
    hex(baseline.deviceConfiguration.slice(2)) !== hex(current.deviceConfiguration.slice(2)) ||
    hex(baseline.mixerConfiguration.slice(2, 38)) !==
      hex(current.mixerConfiguration.slice(2, 38)) ||
    [24, 25].some((i) => baseline.status[i] !== current.status[i]) ||
    (baseline.status[51] ^ current.status[51]) & 6
  )
    throw new Error(
      'Native mixer identity, permissions, configuration or matrix changed; read the amplifier again',
    );
}

/** Input values are stored as Single, rounded to Q24 and transmitted as its
 * upper16 bits (aa72ae..aa736c/aa6164), not round(weight*256). */
export function encodeNativeMixerWeight(value: number): number {
  if (!Number.isFinite(value) || value < -1 || value > 1)
    throw new Error('Edited native mixer weights must be -1..1');
  return q24(Math.fround(value)) >> 16;
}

export function planNativeMixer(
  capture: NativeMixerCapture,
  edits: readonly NativeMixerRowEdit[],
): NativeMixerPlan {
  assertNativeMixerCapture(capture);
  if (
    !Array.isArray(edits) ||
    edits.length < 1 ||
    edits.length > 3 ||
    new Set(edits.map((row) => row.preset)).size !== edits.length
  )
    throw new Error('Native mixer Save requires unique explicit preset rows');
  const before = decodeNativeMixer(capture.mixerConfiguration),
    request = packet(0x67, 1),
    view = new DataView(request.buffer);
  request.set(capture.mixerConfiguration.slice(2, 38), 2);
  const rows = edits.map((row: NativeMixerRowEdit) => {
    if (
      ![1, 2, 3].includes(row.preset) ||
      !Array.isArray(row.weights) ||
      row.weights.length !== 6 ||
      row.weights.some((value: number) => !Number.isFinite(value))
    )
      throw new Error('Native mixer row requires a preset and six finite weights');
    row.weights.forEach((value: number, i: number) => {
      // A lossless raw row may contain latent out-of-editor values. Preserve
      // unchanged components exactly; explicit modal normalization is separate.
      if (value !== before[row.preset - 1][i])
        view.setInt16(2 + ((row.preset - 1) * 6 + i) * 2, encodeNativeMixerWeight(value), true);
    });
    return Object.freeze({ preset: row.preset, weights: Object.freeze([...row.weights]) });
  });
  const expected = request.slice(),
    mask = new Uint8Array(64);
  expected[1] = 0;
  mask[0] = 255;
  mask.fill(255, 2, 38);
  const after = decodeNativeMixer(expected);
  return Object.freeze({
    rows: Object.freeze(rows),
    before,
    after,
    editedPresets: Object.freeze(rows.map((row) => row.preset)),
    get request() {
      return request.slice();
    },
    verification: Object.freeze({
      get expected() {
        return expected.slice();
      },
      get mask() {
        return mask.slice();
      },
    }),
  });
}

export function verifyNativeMixerReadback(plan: NativeMixerPlan, actual: Uint8Array): void {
  decodeNativeMixer(actual);
  const { expected, mask } = plan.verification;
  if (actual.some((value, i) => ((value ^ expected[i]) & mask[i]) !== 0))
    throw new Error('Native mixer readback mismatch');
}
