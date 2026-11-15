import { KNOWN_FIRMWARE_PROFILES, type KnownFirmwareProfile } from '../domain/firmware-profile';
import type { Transport } from './transport';

export interface FirmwareRuntimeIdentity {
  readonly serial: string;
  readonly product: number;
  readonly core: string;
  readonly firmware: string;
  readonly name: string;
}
export interface FirmwareRuntimeReport {
  readonly identity: FirmwareRuntimeIdentity;
  readonly hardware: {
    readonly amplifier: number;
    readonly moduleType: number;
    readonly presets: number;
    readonly channels: number;
  };
  readonly profileId: string;
  /** Existing5.1 dialect only; this is not a permission or a setter capability. */
  readonly controlsQualified: boolean;
  readonly familyProof: 'not-established-by-runtime-reports';
  readonly imageProof: 'not-established-by-runtime-reports';
  readonly consistency: 'double-read-matched';
}
export interface FirmwareRuntimeInspectionOptions {
  readonly expectedSerial?: string;
  readonly assertCurrent?: () => void;
  readonly signal?: AbortSignal;
}

/** Candidate discovery can distinguish a different permitted device from an
 * unqualified or malformed reply, without exposing either serial in an error. */
export class FirmwareRuntimeSerialMismatchError extends Error {
  constructor() {
    super('Firmware runtime serial differs from the captured amplifier');
    this.name = 'FirmwareRuntimeSerialMismatchError';
  }
}

// Only these literal requests exist in this reader. In particular03/00,
// 05/00,64,66/01,67/01 and40/41/43 cannot be reached through this API.
const REQUESTS = Object.freeze({
  configuration: Object.freeze([0x06, 0x01]),
  hardware: Object.freeze([0x66, 0x00]),
  name: Object.freeze([0x03, 0x08]),
  serial: Object.freeze([0x65, 32, 0x00, 0x01, 0x00, 0x00]),
});
type Snapshot = {
  configuration: Uint8Array;
  hardware: Uint8Array;
  name: Uint8Array;
  serial: Uint8Array;
  profile: KnownFirmwareProfile;
  report: FirmwareRuntimeReport;
};
function printable(value: string): boolean {
  return value.length >= 1 && value.length <= 32 && /^[\x20-\x7e]+$/.test(value);
}
function nativeText(bytes: Uint8Array, label: string, required: boolean): string {
  const end = bytes.findIndex((byte) => byte === 0 || byte === 255),
    length = end < 0 ? bytes.length : end;
  if (
    bytes.slice(0, length).some((byte) => byte < 0x20 || byte > 0x7e) ||
    (end >= 0 && bytes.slice(end).some((byte) => byte !== 0 && byte !== 255)) ||
    (required && length === 0)
  )
    throw new Error(`Malformed firmware runtime ${label} ASCII field`);
  return String.fromCharCode(...bytes.slice(0, length));
}
function reportedProfile(configuration: Uint8Array): KnownFirmwareProfile {
  const view = new DataView(configuration.buffer, configuration.byteOffset, 64),
    core = `${configuration[2]}.${configuration[3]}`,
    firmware = `${view.getUint16(15, true)}.${view.getUint16(17, true)}`,
    profile = KNOWN_FIRMWARE_PROFILES.find(
      (candidate) => candidate.coreVersion === core && candidate.bundleVersion === firmware,
    );
  // Product is read from board configuration, not established by the HEX family.
  if (configuration[1] !== 22 || !profile)
    throw new Error(
      'Unqualified firmware runtime; only exact FA5035.7/core5.1 or5.82/core5.5 reports can be inspected',
    );
  return profile;
}
const sameProjection = (left: Uint8Array, right: Uint8Array, indexes: readonly number[]) =>
  indexes.every((index) => left[index] === right[index]);
const configurationFields = Object.freeze([
  ...Array.from({ length: 19 }, (_, index) => index),
  ...Array.from({ length: 8 }, (_, index) => index + 50),
]);
const hardwareFields = Object.freeze([0, ...Array.from({ length: 52 }, (_, index) => index + 10)]);

/** Caller owns the connection/reservation. This function does not open/close a
 * device, instantiate PanelSession, acquire authority or enable controls.
 * Two matched projections are a consistency check, not an atomic device read.
 * Unwritten reply padding can contain prior TX data and is not compared. */
export async function inspectFirmwareRuntime(
  transport: Pick<Transport, 'exchange'>,
  options: FirmwareRuntimeInspectionOptions = {},
): Promise<FirmwareRuntimeReport> {
  const { expectedSerial, assertCurrent, signal } = options;
  if (
    expectedSerial !== undefined &&
    (typeof expectedSerial !== 'string' || !printable(expectedSerial))
  )
    throw new Error('Expected firmware runtime serial must be exact printable ASCII,1–32 bytes');
  const fence = () => {
    signal?.throwIfAborted();
    assertCurrent?.();
    signal?.throwIfAborted();
  };
  const read = async (kind: keyof typeof REQUESTS): Promise<Uint8Array> => {
    fence();
    const request = new Uint8Array(64);
    request.set(REQUESTS[kind]);
    const received = await transport.exchange(request),
      reply = received instanceof Uint8Array ? received.slice() : undefined;
    fence();
    if (!reply || reply.length !== 64 || reply[0] !== request[0])
      throw new Error(`Malformed firmware runtime ${kind} reply`);
    if (kind === 'serial' && reply[1] !== 32)
      throw new Error('Malformed firmware runtime serial read length');
    return reply;
  };
  const capture = async (): Promise<Snapshot> => {
    const configuration = await read('configuration'),
      profile = reportedProfile(configuration);
    // Fail unknown versions/bootloaders before any further command.
    // Native06 RX aa9444 reads channels from raw5; aa94de reads presets from
    // raw12. The5.82 builder stores these at9d009d5c/60 and9d009d6e respectively.
    if (configuration[5] !== 3)
      throw new Error('Firmware runtime requires three advertised channels');
    if (configuration[12] !== 3)
      throw new Error('Firmware runtime requires three advertised presets');
    const hardware = await read('hardware');
    if (hardware[10] !== 5 || hardware[12] !== 22 || hardware[13] !== 1)
      throw new Error('Firmware runtime hardware is not the qualified three-output FA503 profile');
    const name = await read('name'),
      serial = await read('serial'),
      serialText = nativeText(serial.slice(2, 34), 'serial', true),
      nameText = nativeText(name.slice(2, 34), 'name', false);
    if (expectedSerial !== undefined && serialText !== expectedSerial)
      throw new FirmwareRuntimeSerialMismatchError();
    return {
      configuration,
      hardware,
      name,
      serial,
      profile,
      report: {
        identity: {
          serial: serialText,
          product: 22,
          core: profile.coreVersion,
          firmware: profile.bundleVersion,
          name: nameText,
        },
        hardware: {
          amplifier: hardware[10],
          moduleType: hardware[11],
          channels: configuration[5],
          presets: configuration[12],
        },
        profileId: profile.id,
        controlsQualified: profile.coreVersion === '5.1',
        familyProof: 'not-established-by-runtime-reports',
        imageProof: 'not-established-by-runtime-reports',
        consistency: 'double-read-matched',
      },
    };
  };
  const before = await capture(),
    after = await capture();
  if (
    before.profile.id !== after.profile.id ||
    !sameProjection(before.configuration, after.configuration, configurationFields) ||
    !sameProjection(before.hardware, after.hardware, hardwareFields) ||
    !sameProjection(
      before.name,
      after.name,
      Array.from({ length: 32 }, (_, index) => index + 2),
    ) ||
    !sameProjection(
      before.serial,
      after.serial,
      Array.from({ length: 32 }, (_, index) => index + 2),
    )
  )
    throw new Error(
      'Firmware runtime metadata changed during inspection; no identity was returned',
    );
  fence();
  return Object.freeze({
    ...before.report,
    identity: Object.freeze(before.report.identity),
    hardware: Object.freeze(before.report.hardware),
  });
}
