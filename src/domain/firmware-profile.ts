import type { FirmwareFamily } from './firmware';

/** Exact source-file recognition, never an assertion about the running image. */
export interface KnownFirmwareProfile {
  readonly id: string;
  readonly sha256: string;
  readonly family: FirmwareFamily;
  readonly bundleVersion: string;
  readonly coreVersion: string;
  readonly source: string;
  readonly evidence: readonly string[];
}

export const KNOWN_FIRMWARE_PROFILES: readonly KnownFirmwareProfile[] = Object.freeze([
  Object.freeze({
    id: 'fusion32-5.7-core5.1',
    sha256: '00cbaf3fb38e731959fef26eb7b844c2f79987442397e9ce194a0d2b302f00a5',
    family: 'FUSION32' as const,
    bundleVersion: '5.7',
    coreVersion: '5.1',
    source: 'Official Hypex FusionAmp-v5.7.hex',
    evidence: Object.freeze([
      'https://cdn.hypex.nl/media/86/66/2c/1686820901/DSP3-213%20v5.7%20firmware.zip',
      'HEX segment2:0x690=05 00 07 00; command06 builder9d007a24..9d007a30 stores core05 01.',
      'Runtime USB descriptor0303A; serial builder9d00f648..9d00f6c4 reads EEPROM0x100/32.',
    ]),
  }),
  Object.freeze({
    id: 'fusion32-5.82-core5.5',
    sha256: '8cba0150c33acc338a7581ba89069b174f8786a6d97c68269dc4a540b9c47f61',
    family: 'FUSION32' as const,
    bundleVersion: '5.82',
    coreVersion: '5.5',
    source: 'Installed HFD 5.2.4.24 DSP3-213 (FusionAmp)-v5.82.hex',
    evidence: Object.freeze([
      'HEX segment2:0x690=05 00 52 00; command06 builder9d009d2a..9d009d32 stores core05 05.',
      '9d009d84..9d009da8 reads EEPROM0x690/4 into06 raw15..18.',
      'Runtime VID345e/PID03e8 at9d01160c; serial builder9d00fe04..9d00fe7e reads EEPROM0x100/32.',
    ]),
  }),
]);

/** Hexadecimal case is immaterial; whitespace, names and partial hashes do not match. */
export function lookupKnownFirmwareProfile(sha256: string): KnownFirmwareProfile | undefined {
  if (typeof sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(sha256)) return undefined;
  return KNOWN_FIRMWARE_PROFILES.find((profile) => profile.sha256 === sha256.toLowerCase());
}
