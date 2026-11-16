import type {
  FirmwareJournalBinding,
  FirmwareJournalSource,
} from '../application/firmware-update-storage';

declare const physicalProfileBrand: unique symbol;
export interface FirmwarePhysicalCandidate {
  readonly device: HIDDevice;
  /** Established by the source-qualified correlator, never copied by the adapter. */
  readonly serial: string;
  readonly hidSerial: string;
}
export interface FirmwarePhysicalReadbackProfile {
  readonly id: string;
  readonly product: number;
  readonly core: string;
  readonly firmware: string;
  readonly amplifier: number;
  readonly moduleType: number;
  readonly channels: 3;
  readonly presets: 3;
  /** Complete03/05/06/66 before-images, with fixed source-qualified comparison
   * masks. A runtime/version profile does not inherit another profile's reads. */
  readonly reportMasks: Readonly<Record<3 | 5 | 6 | 102, readonly number[]>>;
  readonly evidence: readonly string[];
}
export interface FirmwareQualifiedPhysicalProfile {
  readonly [physicalProfileBrand]: true;
  readonly id: string;
  readonly family: 'FUSION32';
  readonly sourceSha256s: readonly string[];
  readonly before: FirmwarePhysicalReadbackProfile;
  readonly after: readonly FirmwarePhysicalReadbackProfile[];
  readonly loader: {
    readonly vendorId: number;
    readonly productId: number;
    readonly product: number;
    readonly build: number;
    readonly version: number;
  };
  readonly evidence: {
    readonly sameUnitCorrelation: readonly string[];
    readonly singleReplyAndLateDuplicates: readonly string[];
    readonly preservation: readonly string[];
    readonly recovery: readonly string[];
    readonly runtimePermission: readonly string[];
  };
  /** Fresh native firmware permission policy, distinct from ordinary settings
   * permissions. Source-qualified code must refuse before entry40. */
  assertRuntimeAccess(reports: {
    configuration: Uint8Array;
    status: Uint8Array;
    hardware: Uint8Array;
  }): void;
  /** These source-owned correlators must establish exact HID-interface/unit
   * association from independently qualified evidence. A lone candidate,
   * VID/PID, product name or major99 is insufficient. They perform no writes. */
  correlateLoader(
    binding: Readonly<FirmwareJournalBinding>,
    granted: readonly HIDDevice[],
  ): Promise<readonly FirmwarePhysicalCandidate[]>;
  correlateRuntime(
    binding: Readonly<FirmwareJournalBinding>,
    granted: readonly HIDDevice[],
  ): Promise<readonly FirmwarePhysicalCandidate[]>;
}

// Deliberately EMPTY. Available host/runtime artifacts do not independently
// establish loader same-unit association or late/duplicate40 reply semantics.
// Only a reviewed source change can add a profile; there is no public issuer,
// serialized qualification flag, environment switch or caller-supplied profile.
const profiles: readonly FirmwareQualifiedPhysicalProfile[] = Object.freeze([]);
const issued = new WeakSet<object>(profiles);
export function isQualifiedFirmwarePhysicalProfile(
  value: unknown,
): value is FirmwareQualifiedPhysicalProfile {
  return !!value && typeof value === 'object' && issued.has(value);
}
export function lookupQualifiedFirmwarePhysicalProfile(
  binding: Readonly<FirmwareJournalBinding>,
  source?: Readonly<FirmwareJournalSource>,
): FirmwareQualifiedPhysicalProfile | undefined {
  return profiles.find(
    (profile) =>
      profile.family === binding.family &&
      profile.before.product === binding.product &&
      profile.before.core === binding.core &&
      profile.before.firmware === binding.firmware &&
      (!source || profile.sourceSha256s.includes(source.sha256)),
  );
}
