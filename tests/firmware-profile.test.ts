import { expect, it } from 'vitest';
import {
  KNOWN_FIRMWARE_PROFILES,
  lookupKnownFirmwareProfile,
} from '../src/domain/firmware-profile';

it('recognizes only the exact independently hashed official5.7 and installed5.82 source bytes', () => {
  expect(
    lookupKnownFirmwareProfile('00cbaf3fb38e731959fef26eb7b844c2f79987442397e9ce194a0d2b302f00a5'),
  ).toMatchObject({
    id: 'fusion32-5.7-core5.1',
    family: 'FUSION32',
    coreVersion: '5.1',
    bundleVersion: '5.7',
  });
  const hash = '8cba0150c33acc338a7581ba89069b174f8786a6d97c68269dc4a540b9c47f61';
  expect(lookupKnownFirmwareProfile(hash.toUpperCase())).toMatchObject({
    id: 'fusion32-5.82-core5.5',
    family: 'FUSION32',
    coreVersion: '5.5',
    bundleVersion: '5.82',
  });
  expect(lookupKnownFirmwareProfile(hash)).toBe(lookupKnownFirmwareProfile(hash));
});

it.each([
  'FusionAmp-v5.7.hex',
  'DSP3-213 (FusionAmp)-v5.82.hex',
  '5.82',
  '8cba0150',
  'f'.repeat(64),
  ` ${KNOWN_FIRMWARE_PROFILES[0].sha256}`,
])('never infers a source profile from %s', (value) => {
  expect(lookupKnownFirmwareProfile(value)).toBeUndefined();
});

it('keeps recognition metadata/evidence immutable and contains no mutable caller registration', () => {
  expect(KNOWN_FIRMWARE_PROFILES).toHaveLength(2);
  for (const profile of KNOWN_FIRMWARE_PROFILES) {
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.evidence)).toBe(true);
    expect(profile.evidence.length).toBeGreaterThan(1);
    expect(profile.source).toBeTruthy();
  }
  expect(Object.isFrozen(KNOWN_FIRMWARE_PROFILES)).toBe(true);
  expect(lookupKnownFirmwareProfile(undefined as unknown as string)).toBeUndefined();
});
