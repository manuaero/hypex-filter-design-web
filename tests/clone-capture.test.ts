// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  captureNativeCloneTemplate,
  type CloneCaptureSnapshot,
} from '../src/hardware/clone-capture';
import { buildClonePlan } from '../src/hardware/clone-plan';
import { decodeEq, encodeEq, packet } from '../src/hardware/codec';
import { newProject } from '../src/domain/model';
import {
  nativeCloneTemplateSchema,
  parseNativeCloneInfo,
  writeNativeCloneInfo,
} from '../src/domain/clone-template';
import { parseProject } from '../src/domain/files';
import { STATUS_FLAGS } from '../src/hardware/status-flags';

const ascii = (value: string) => {
  const bytes = new Uint8Array(32);
  bytes.set(Array.from(value, (character) => character.charCodeAt(0)));
  return bytes;
};
function fixture(serial = 'H05U-SYNTHETIC-CAPTURE'): CloneCaptureSnapshot {
  const project = newProject('Independent physical banks'),
    status = packet(5, 6, 2),
    configuration = packet(6, 22, 5, 1),
    deviceConfiguration = packet(0x66),
    mixerConfiguration = packet(0x67);
  configuration[4] = 0xe2;
  configuration[5] = 3;
  configuration[12] = 3;
  configuration[14] = 128;
  const cv = new DataView(configuration.buffer);
  cv.setUint16(15, 5, true);
  cv.setUint16(17, 7, true);
  [4500, 1500, 1500, 1500].forEach((count, index) => cv.setUint16(50 + index * 2, count, true));
  const sv = new DataView(status.buffer);
  sv.setInt16(3, -9600, true);
  sv.setInt16(52, -1234, true);
  status[6] = 0x82;
  status[7] = 1;
  status[8] = 45;
  sv.setUint16(9, 29, true);
  status[11] = 10;
  status.set([0xf5, 0x26, 0x91], 12);
  [113, -456, 789].forEach((value, index) => sv.setInt16(15 + index * 2, value, true));
  sv.setInt16(21, -20000, true);
  sv.setUint16(24, 0x1234, true);
  status[27] = 11;
  status.set([0xff, 0x01, 0x48], 28);
  status[31] = 2;
  status[35] = 0xf6;
  status[36] = 0xdf;
  status[50] = 5;
  status[51] = STATUS_FLAGS.passwordProtected;
  deviceConfiguration[10] = 5;
  deviceConfiguration[11] = 9;
  deviceConfiguration[12] = 22;
  deviceConfiguration[13] = 1;
  deviceConfiguration[14] = 129;
  deviceConfiguration[15] = 65;
  const dv = new DataView(deviceConfiguration.buffer);
  dv.setInt16(16, 4096, true);
  for (let index = 0; index < 3; index++) {
    dv.setInt32(20 + index * 4, 48180516 + index, true);
    dv.setInt32(32 + index * 4, 16273901 + index, true);
    dv.setInt32(44 + index * 4, 16776376 + index, true);
    deviceConfiguration[56 + index] = index === 0 ? 63 : 40;
    deviceConfiguration[59 + index] = 20 + index;
  }
  const mv = new DataView(mixerConfiguration.buffer);
  [
    -1,
    256,
    -256,
    32767,
    -32768,
    128,
    ...Array.from({ length: 12 }, (_, index) => index * 40),
  ].forEach((word, index) => mv.setInt16(2 + index * 2, word, true));
  const flash = Array.from({ length: 24 }, (_, index) => ({
    address: 0x10000 + index * 4096,
    bytes: new Uint8Array(4096).fill(255),
  }));
  project.presets.forEach((preset, index) => {
    preset.inputEq.forEach((band, bandIndex) => {
      band.enabled = bandIndex % 2 === 0;
      band.frequency = 200 + index * 100 + bandIndex * 20;
      band.gain = -index - bandIndex / 10;
    });
    flash[21 + index].bytes.set(encodeEq(preset.inputEq));
  });
  return {
    identity: { serial, product: 22, core: '5.1', firmware: '5.7' },
    status,
    configuration,
    deviceConfiguration,
    mixerConfiguration,
    dspName: packet(3, 0, ...new TextEncoder().encode('Captured hardware name')),
    serial: ascii(serial),
    productStrings: { hypexName: ascii('FA503'), oemName: ascii('Synthetic OEM') },
    flash,
    filenames: Array.from({ length: 3 }, (_, preset) =>
      Array.from({ length: 4 }, (_, channel) => ({
        address: 0x200 + preset * 0x80 + channel * 32,
        bytes: ascii(`P${preset + 1}-${channel}.txt`),
      })),
    ).flat(),
  };
}

describe('pure fresh-native connected Clone capture', () => {
  it('captures all physical banks and exact raw coefficient values independently of any editable Project', () => {
    const snapshot = fixture(),
      captured = captureNativeCloneTemplate(snapshot, '2026-11-14T12:00:00.000Z');
    expect(captured.provenance).toMatchObject({
      kind: 'device-capture',
      sourceSerial: 'H05U-SYNTHETIC-CAPTURE',
      capturedAt: '2026-11-14T12:00:00.000Z',
    });
    expect(captured.configuration).toMatchObject({
      valid: true,
      hypexName: 'FA503',
      oemName: 'Synthetic OEM',
      serialNumber: 'H05U-SYNTHETIC-CAPTURE',
      amplifier: 5,
      moduleType: 9,
      thirdChannelEnabled: true,
      fanConnected: true,
      mixerEnabled: true,
      detectedHardware: 22,
      temperatureSetpoint: 65,
      dspPeakSetpoint: 4096,
    });
    expect(captured.configuration.limiter[0]).toEqual({
      threshold: 48180516 / 16777216,
      attack: 16273901 / 16777216,
      release: 16776376 / 16777216,
      ohms: 6.300000190734863,
      watts: 100,
    });
    expect(
      captured.eqBanks.map((bank) => [
        bank[0].frequency,
        bank[0].gain,
        bank[8].frequency,
        bank[8].gain,
      ]),
    ).toEqual([
      [200, 0, 360, -0.8],
      [300, -1, 460, -1.8],
      [400, -2, 560, -2.8],
    ]);
    expect(captured.device).toEqual({
      product: 22,
      version: 5,
      build: 1,
      bootloaderMode: false,
      dspFilename: 'Captured hardware name',
      bundleVersion: '',
      unitBehaviour: 1,
      digitalInputPresent: false,
      testFirmware: false,
      subSetup: 0,
      presetCount: 3,
      channelCount: 3,
      bootloaderVersion: 0,
    });
    expect(captured).not.toHaveProperty('project');
    expect(captured).not.toHaveProperty('sourceXml');
  });

  it('distinguishes active/forced input, requested/actual volume, raw FIR flags, native Single offsets and sentinel startup volume', () => {
    const captured = captureNativeCloneTemplate(fixture());
    expect(captured.settings).toMatchObject({
      activeInput: 5,
      forcedInput: 6,
      actualVolume: Math.fround(-12.34),
      startupVolume: -200,
      passwordProtected: true,
      digitalChannelSelect: 2,
      mfbEnabled: true,
      protectionMask: 0x1234,
      detectionOn: 3,
      detectionOff: 2,
      oledBrightness: 246,
      advancedOptions: 219,
      systemSetup: 226,
      selectedPreset: 2,
      muted: true,
      options: 29,
      powerOffTime: 45,
      controlBundleVersion: '5.7',
    });
    expect(captured.settings.presets[0]).toMatchObject({
      forceInput: 5,
      volumeOffset: Math.fround(1.13),
      adcDigitalOut: true,
      sourceLock: true,
      volumeLock: true,
      eqEnabled: true,
      application: 0,
      inputFir: { loaded: true, enabled: true, filename: 'P1-0.txt' },
    });
    expect(captured.settings.presets[1]).toMatchObject({
      forceInput: 6,
      volumeOffset: Math.fround(-4.56),
      adcDigitalOut: false,
      sourceLock: false,
      volumeLock: true,
      eqEnabled: false,
      application: 1,
      inputFir: { loaded: false, enabled: false, filename: '' },
    });
    // Loaded=false never discards a physically read selected EEPROM filename.
    expect(captured.settings.presets[1].outputFirs[0]).toEqual({
      loaded: false,
      enabled: true,
      filename: 'P2-1.txt',
    });
    expect(captured.settings).not.toHaveProperty('passwordMatched');
  });

  it('decodes actual 67 signed Q8 mixer words without borrowing constants or project data', () => {
    const snapshot = fixture(),
      captured = captureNativeCloneTemplate(snapshot);
    expect(captured.configuration.mixer[0]).toEqual([-0.00390625, 1, -1, 127.99609375, -128, 0.5]);
    expect(captured.configuration.mixer[1]).toEqual([0, 0.15625, 0.3125, 0.46875, 0.625, 0.78125]);
    snapshot.mixerConfiguration.fill(0);
    expect(captured.configuration.mixer[0][0]).toBe(-0.00390625);
  });

  it('lists only proven fresh-host defaults and inactive filename fields, rather than presenting them as read state', () => {
    const captured = captureNativeCloneTemplate(fixture()),
      defaults = captured.provenance.captureDefaults!;
    expect(defaults.slice(0, 5)).toEqual([
      'device.bundleVersion',
      'device.bootloaderVersion',
      'settings.gainCorrection12',
      'settings.gainCorrection3',
      'settings.routing',
    ]);
    expect(defaults).toContain('settings.presets.0.outputFirs.0.filename');
    expect(defaults).toContain('settings.presets.1.inputFir.filename');
    expect(defaults).not.toContain('settings.presets.0.inputFir.filename');
    expect(captured.settings.presets[0].outputFirs.map((fir) => fir.filename)).toEqual([
      '',
      '',
      '',
    ]);
    expect(captured.settings.gainCorrection12).toBe(0);
    expect(captured.settings.routing).toEqual([0, 0, 0, 0, 0, 0]);
    expect(nativeCloneTemplateSchema.parse(JSON.parse(JSON.stringify(captured)))).toEqual(captured);
    const project = newProject();
    project.hfdCloneTemplate = captured;
    expect(parseProject(JSON.stringify(project)).hfdCloneTemplate).toEqual(captured);
    const nativeOnly = parseNativeCloneInfo(writeNativeCloneInfo(captured))!;
    expect(nativeOnly.configuration).toEqual(captured.configuration);
    expect(nativeOnly.provenance.captureDefaults).toBeUndefined();
    expect(nativeOnly.provenance.kind).toBe('hfd-project');
  });

  it.each(['H05U', 'H03U', 'H99U'])('honours native fresh serial prefix %s', (prefix) => {
    expect(captureNativeCloneTemplate(fixture(`${prefix}-SYNTHETIC`)).configuration.valid).toBe(
      true,
    );
  });

  it('returns native-invalid cleared configuration strings for other serial prefixes while retaining source provenance', async () => {
    const snapshot = fixture('UNRECOGNISED-SERIAL');
    snapshot.productStrings.hypexName = ascii('OEM');
    const captured = captureNativeCloneTemplate(snapshot);
    expect(captured.provenance.sourceSerial).toBe('UNRECOGNISED-SERIAL');
    expect(captured.configuration).toMatchObject({
      valid: false,
      hypexName: '',
      oemName: '',
      serialNumber: '----------',
    });
    await expect(
      buildClonePlan(newProject(), captured, snapshot, {
        mode: 'master',
        presets: [0, 1, 2].map(() => ({ forceInput: 0, sourceLock: false, volumeLock: false })),
      }),
    ).rejects.toThrow(/unlocked/);
    snapshot.status[51] = 0;
    await expect(
      buildClonePlan(newProject(), captured, snapshot, {
        mode: 'master',
        presets: [0, 1, 2].map(() => ({ forceInput: 0, sourceLock: false, volumeLock: false })),
      }),
    ).rejects.toThrow(/complete FA503/);
  });

  it('reads a locked source without writing or treating its saved protection mask as authorization', () => {
    const snapshot = fixture();
    expect(captureNativeCloneTemplate(snapshot).settings.passwordProtected).toBe(true);
    snapshot.status[51] = 0;
    const unprotected = captureNativeCloneTemplate(snapshot);
    expect(unprotected.settings.protectionMask).toBe(65535);
    expect(unprotected.settings.passwordProtected).toBe(false);
  });

  it('retains exact captured limiter words through a new source plan and keeps two source captures independent', async () => {
    const left = fixture('H05U-LEFT'),
      right = fixture('H05U-RIGHT');
    left.status[51] = right.status[51] = 0;
    left.productStrings.hypexName = ascii('Custom physical label');
    new DataView(right.mixerConfiguration.buffer).setInt16(2, 512, true);
    const capturedLeft = captureNativeCloneTemplate(left),
      capturedRight = captureNativeCloneTemplate(right);
    expect(capturedLeft.configuration.hypexName).toBe('Custom physical label');
    expect(capturedRight.configuration.hypexName).toBe('FA503');
    capturedLeft.configuration.mixer[0][0] = 99;
    expect(capturedRight.configuration.mixer[0][0]).toBe(2);
    const plan = await buildClonePlan(newProject('Round-trip exact words'), capturedRight, right, {
      mode: 'master',
      presets: [0, 1, 2].map(() => ({ forceInput: 0, sourceLock: false, volumeLock: false })),
    });
    const planned = plan.reports[2].request,
      actual = right.deviceConfiguration;
    for (const start of [20, 32, 44])
      expect(Array.from(planned.slice(start, start + 12))).toEqual(
        Array.from(actual.slice(start, start + 12)),
      );
    expect(Array.from(planned.slice(56, 62))).toEqual(Array.from(actual.slice(56, 62)));
    expect(plan.before.serialHex).not.toContain(
      Array.from(left.serial, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    );
  });

  it('uses native string bounds, stop bytes and 30-character DSP limit', () => {
    const snapshot = fixture();
    snapshot.productStrings.oemName = Uint8Array.from([65, 66, 128, ...new Array(29).fill(67)]);
    snapshot.filenames[0].bytes = Uint8Array.from([88, 127, 0, ...new Array(29).fill(90)]);
    snapshot.dspName = packet(3, 0, ...new Array(31).fill(78));
    const captured = captureNativeCloneTemplate(snapshot);
    expect(captured.configuration.oemName).toBe('AB');
    expect(captured.settings.presets[0].inputFir.filename).toBe('X\x7f');
    expect(captured.device.dspFilename).toBe('N'.repeat(30));
    snapshot.dspName = packet(3, 0, 65, 255, 66);
    expect(captureNativeCloneTemplate(snapshot).device.dspFilename).toBe('A');
  });

  it('applies the native all-FFFF options fallback without changing source bytes', () => {
    const snapshot = fixture();
    snapshot.status[9] = snapshot.status[10] = 255;
    const captured = captureNativeCloneTemplate(snapshot);
    expect(captured.settings.options).toBe(25);
    expect(captured.device.unitBehaviour).toBe(0);
    expect(snapshot.status[9]).toBe(255);
  });

  it.each([
    'mixer missing',
    'mixer command',
    'OEM short',
    'missing names',
    'missing sector',
    'preset count absent',
    'channel count absent',
    'foreign serial',
    'corrupt EQ',
  ] as const)('rejects %s atomically with no fallback data', (reason) => {
    const snapshot = fixture();
    if (reason === 'mixer missing') snapshot.mixerConfiguration = new Uint8Array(0);
    if (reason === 'mixer command') snapshot.mixerConfiguration[0] = 0x66;
    if (reason === 'OEM short') snapshot.productStrings.oemName = new Uint8Array(31);
    if (reason === 'missing names') snapshot.filenames.pop();
    if (reason === 'missing sector') snapshot.flash.pop();
    if (reason === 'preset count absent') snapshot.configuration[12] = 0;
    if (reason === 'channel count absent') snapshot.configuration[5] = 0;
    if (reason === 'foreign serial') snapshot.identity.serial = 'OTHER';
    if (reason === 'corrupt EQ') snapshot.flash[22].bytes[0] ^= 1;
    const before = JSON.stringify(snapshot);
    expect(() => captureNativeCloneTemplate(snapshot)).toThrow();
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('rejects malformed provenance and preserves legacy markers without default annotations', () => {
    const captured = captureNativeCloneTemplate(fixture());
    expect(() => captureNativeCloneTemplate(fixture(), '')).toThrow();
    expect(() =>
      nativeCloneTemplateSchema.parse({
        ...captured,
        provenance: { ...captured.provenance, captureDefaults: ['settings.actualVolume'] },
      }),
    ).toThrow();
    expect(() =>
      nativeCloneTemplateSchema.parse({
        ...captured,
        provenance: {
          ...captured.provenance,
          captureDefaults: ['device.bundleVersion', 'device.bundleVersion'],
        },
      }),
    ).toThrow();
    delete captured.provenance.captureDefaults;
    expect(nativeCloneTemplateSchema.parse(captured)).toEqual(captured);
    expect(decodeEq(fixture().flash[21].bytes)[0].frequency).toBe(200);
  });
});
