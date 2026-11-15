import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newProject } from '../src/domain/model';
import { nativeCloneTemplateSchema, type NativeCloneTemplate } from '../src/domain/clone-template';
import {
  buildClonePlan,
  encodeNativeCloneDspName,
  planNativeCloneFir,
  reduceNativeCloneDspName,
  type CloneTargetSnapshot,
} from '../src/hardware/clone-plan';
import { hex, packet, unhex } from '../src/hardware/codec';
import {
  cloneBytesSha256,
  cloneImageSha256,
  type CloneOverrides,
} from '../src/application/device-clone-storage';
import { STATUS_FLAGS } from '../src/hardware/status-flags';

function template(): NativeCloneTemplate {
  return nativeCloneTemplateSchema.parse({
    version: 1,
    provenance: { kind: 'hfd-project', sourceSerial: 'UNTRUSTED-SOURCE' },
    configuration: {
      valid: true,
      hypexName: 'FA503',
      oemName: 'Original source',
      serialNumber: 'UNTRUSTED-SOURCE',
      amplifier: 5,
      thirdChannelEnabled: true,
      fanConnected: true,
      mixerEnabled: true,
      moduleType: 9,
      detectedHardware: 22,
      temperatureSetpoint: 65,
      dspPeakSetpoint: 4096,
      mixer: Array.from({ length: 3 }, () => [1, 2, 3, 4, 5, 6]),
      limiter: [
        { threshold: 2.871783, attack: 0.97, release: 0.99995, ohms: 4, watts: 100 },
        { threshold: 2, attack: 0.5, release: 0.25, ohms: 6.25, watts: 105 },
        { threshold: 20, attack: 0, release: 1, ohms: 8, watts: 75 },
      ],
    },
    device: {
      product: 22,
      version: 5,
      build: 1,
      bootloaderMode: false,
      dspFilename: 'PHYSICAL-SOURCE-NAME',
      bundleVersion: '',
      unitBehaviour: 0,
      digitalInputPresent: false,
      testFirmware: false,
      subSetup: 0,
      presetCount: 3,
      channelCount: 3,
      bootloaderVersion: 0,
    },
    settings: {
      activeInput: 5,
      forcedInput: 5,
      actualVolume: -6,
      passwordProtected: true,
      digitalChannelSelect: 2,
      mfbEnabled: true,
      presets: [0, 1, 2].map((index) => ({
        forceInput: 5,
        volumeOffset: index === 0 ? 1.125 : index === 1 ? -1.125 : 2.5,
        adcDigitalOut: index === 1,
        sourceLock: false,
        volumeLock: false,
        eqEnabled: index !== 1,
        application: index === 1 ? 1 : 0,
        inputFir: { loaded: index === 0, filename: 'source-input.txt', enabled: index !== 1 },
        outputFirs: [0, 1, 2].map((ch) => ({
          loaded: ch === 1,
          filename: `source-${ch}.txt`,
          enabled: ch === 0,
        })),
      })),
      startupVolume: -40.125,
      standbyMode: 1,
      gainCorrection12: 0,
      gainCorrection3: 0,
      protectionMask: 0,
      detectionOn: 3,
      detectionOff: 2,
      oledBrightness: 0xa7,
      systemSetup: 0,
      selectedPreset: 2,
      muted: false,
      options: 25,
      advancedOptions: 0xdb,
      powerOffTime: 15,
      routing: [0, 0, 0, 0, 0, 0],
      bundleBcdMajor: 5,
      bundleBcdMinor: 7,
      controlBundleVersion: '5.7',
    },
    eqBanks: [0, 1, 2].map((p) =>
      Array.from({ length: 9 }, (_, i) => ({
        filterType: i === 0 ? 1 : 0,
        enabled: true,
        frequency: 1000 + i * 100,
        q: 0.707,
        gain: p === 0 && i === 0 ? -3 : 0,
      })),
    ),
  });
}
function target(serial = 'DESTINATION'): CloneTargetSnapshot {
  const status = packet(5, 6, 1),
    configuration = packet(6, 22, 5, 1),
    deviceConfiguration = packet(0x66),
    serialBytes = new Uint8Array(32);
  status[6] = 7;
  status[9] = 9;
  status[24] = 0xa9;
  status[25] = 0x73;
  status[36] = 0xdb;
  new DataView(status.buffer).setInt16(3, -625, true);
  configuration[14] = 128;
  const configView = new DataView(configuration.buffer);
  configView.setUint16(15, 5, true);
  configView.setUint16(17, 7, true);
  [4500, 1500, 1500, 1500].forEach((count, index) =>
    configView.setUint16(50 + index * 2, count, true),
  );
  for (let i = 2; i < 64; i++) deviceConfiguration[i] = (i * 7 + 3) & 255;
  deviceConfiguration[10] = 5;
  deviceConfiguration[11] = 9;
  deviceConfiguration[12] = 22;
  serialBytes.set(new TextEncoder().encode(serial));
  return {
    identity: { serial, product: 22, core: '5.1', firmware: '5.7' },
    status,
    configuration,
    deviceConfiguration,
    dspName: packet(3, 0, ...new TextEncoder().encode('Previous destination')),
    serial: serialBytes,
    flash: Array.from({ length: 24 }, (_, i) => ({
      address: 0x10000 + i * 4096,
      bytes: Uint8Array.from({ length: 4096 }, (_, byte) => (i * 13 + byte * 7) & 255),
    })),
    filenames: Array.from({ length: 3 }, (_, p) =>
      Array.from({ length: 4 }, (_, n) => ({
        address: 0x200 + p * 0x80 + n * 32,
        bytes: new Uint8Array(32).fill(65 + p * 4 + n),
      })),
    ).flat(),
  };
}
const overrides = (): CloneOverrides => ({
  mode: 'slave',
  presets: [
    { forceInput: 5, sourceLock: true, volumeLock: false },
    { forceInput: 4, sourceLock: false, volumeLock: true },
    { forceInput: 7, sourceLock: true, volumeLock: true },
  ],
});
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('pure FA503 module9 Clone plan', () => {
  it('builds native report order and independent literal 05/66 encodings while leaving all outputs globally muted', async () => {
    const destination = target(),
      plan = await buildClonePlan(newProject('Design-name'), template(), destination, overrides());
    expect(
      plan.reports.map((report) => [
        report.id,
        report.request[0],
        report.request[1],
        report.request[0] === 5 ? report.request[23] : null,
      ]),
    ).toEqual([
      ['mute', 5, 0, 0],
      ['settings', 5, 0, 4],
      ['configuration', 102, 1, null],
      ['display', 5, 0, 8],
    ]);
    const setting = plan.reports[1].request,
      configuration = plan.reports[2].request,
      v = new DataView(setting.buffer),
      cv = new DataView(configuration.buffer);
    for (const report of plan.reports.filter((report) => report.request[0] === 5))
      expect(report.request[6]).toBe(128);
    expect(setting[2]).toBe(2);
    expect(v.getInt16(3, true)).toBe(-9600);
    expect(v.getUint16(9, true)).toBe(29);
    expect(Array.from(setting.slice(11, 15))).toEqual([10, 149, 100, 183]);
    // Native a9a6a8 is signed half-away, including exact Single 1.125 offsets.
    expect([15, 17, 19, 21].map((offset) => v.getInt16(offset, true))).toEqual([
      113, -113, 250, -4013,
    ]);
    expect(Array.from(setting.slice(24, 26))).toEqual([169, 115]);
    expect(setting[27]).toBe(11);
    expect(setting[31]).toBe(2);
    expect(setting[35]).toBe(167);
    expect(setting[36]).toBe(219);
    expect([
      configuration[10],
      configuration[11],
      configuration[13],
      configuration[14],
      configuration[15],
      cv.getInt16(16, true),
    ]).toEqual([5, 9, 1, (destination.deviceConfiguration[14] & 126) | 129, 65, 4096]);
    expect([20, 24, 28, 32, 36, 40, 44, 48, 52].map((offset) => cv.getInt32(offset, true))).toEqual(
      [48180524, 33554432, 335544320, 16273900, 8388608, 0, 16776377, 4194304, 16777216],
    );
    expect(Array.from(configuration.slice(56, 62))).toEqual([40, 63, 80, 20, 21, 15]);
    expect(plan.desired).not.toHaveProperty('oemStrings');
    expect(plan.dspName).toBe('Design-name');
    expect(plan.desired.reports.some((report) => unhex(report.requestHex)[0] === 0x67)).toBe(false);
  });

  it('compiles physical captured EQ independently from staged EQ and preserves unrelated flash/configuration bytes', async () => {
    const project = newProject('Independent'),
      destination = target(),
      captured = template();
    project.presets[0].inputEq[0].gain = 12;
    project.presets[0].channels[0].delayUs = 32000;
    const plan = await buildClonePlan(project, captured, destination, overrides());
    expect(new DataView(plan.presets[0].iir.bytes.buffer).getUint32(0, true)).toBe(3000);
    expect(new DataView(plan.presets[0].eq.bytes.buffer).getInt16(186, true)).toBe(-3000);
    expect(plan.presets[0].iir.bytes.slice(1536)).toEqual(destination.flash[18].bytes.slice(1536));
    expect(plan.presets[0].eq.bytes.slice(256)).toEqual(destination.flash[21].bytes.slice(256));
    const config = plan.reports[2].request;
    const owned = new Set([
      1,
      10,
      11,
      13,
      14,
      15,
      16,
      17,
      ...Array.from({ length: 36 }, (_, i) => 20 + i),
      ...Array.from({ length: 6 }, (_, i) => 56 + i),
    ]);
    for (let i = 0; i < 64; i++)
      if (!owned.has(i)) expect(config[i]).toBe(destination.deviceConfiguration[i]);
    expect(plan.desired.filenames.map((file) => file.hex)).toEqual(
      destination.filenames.map((file) => hex(file.bytes)),
    );
    expect(plan.before.serialHex).toBe(hex(destination.serial));
    expect(plan.before.serialHex).not.toContain(
      hex(new TextEncoder().encode(captured.provenance.sourceSerial)),
    );
  });

  it('programs selected full-size zero FIRs and bypassed FIR data, keeps inactive graph FIR separate, and preserves sector tails', async () => {
    const project = newProject('FIR'),
      destination = target(),
      first = project.presets[0];
    first.firPlacement = 'output';
    first.inputFir = {
      name: 'inactive.txt',
      enabled: true,
      taps: [1],
      hfdState: { loaded: true, used: true, tapCount: 1 },
    };
    first.channels[0].fir = { name: 'zero.txt', enabled: true, taps: new Array(1500).fill(0) };
    const taps = new Array(1500).fill(0);
    taps[0] = 1;
    taps[1499] = -0.25;
    first.channels[1].fir = { name: 'bypassed.txt', enabled: false, taps };
    const plan = await buildClonePlan(project, template(), destination, overrides()),
      fir = plan.presets[0].fir;
    expect(plan.warnings.join(' ')).toContain('Inactive input graph FIR is not transferred');
    expect(fir.flags).toBe(57); // source input enable8 + outputLoaded16/32 + outputEnabled1
    expect(fir.sectors.map((image) => image.address)).toEqual([0x10000, 0x11000, 0x12000, 0x13000]);
    expect(fir.sectors[0].bytes.every((byte) => byte === 0)).toBe(true);
    expect(new DataView(fir.sectors[2].bytes.buffer).getInt32(0, true)).toBe(-4194304);
    expect(new DataView(fir.sectors[3].bytes.buffer).getInt32(1900, true)).toBe(16777216);
    expect(fir.sectors[3].bytes.slice(1904)).toEqual(destination.flash[3].bytes.slice(1904));
    expect(fir.filenames.map((image) => image.address)).toEqual([0x220, 0x240]);
    expect(first.inputFir.hfdState).toEqual({ loaded: true, used: true, tapCount: 1 });
  });

  it('faithfully skips native <=10 sample FIR coefficient transfers but retains loaded filename commits', async () => {
    const project = newProject('Short skip');
    project.presets[0].inputFir = {
      name: 'skip.txt',
      enabled: true,
      taps: [],
      hfdState: { loaded: true, used: true, tapCount: 0 },
    };
    project.presets[1].firPlacement = 'output';
    project.presets[1].channels[0].fir = {
      name: 'tiny.txt',
      enabled: true,
      taps: [1],
      hfdState: { loaded: true, used: true, tapCount: 1 },
    };
    const plan = await buildClonePlan(project, template(), target(), overrides());
    expect(plan.presets[0].fir).toMatchObject({ sectors: [], flags: 1, placement: 0 });
    expect(plan.presets[1].fir).toMatchObject({ sectors: [], flags: 0, placement: 1 });
    expect(plan.presets[0].fir.filenames.map((image) => image.address)).toEqual([0x200]);
    expect(plan.presets[1].fir.filenames.map((image) => image.address)).toEqual([0x2a0]);
    expect(plan.warnings.join(' ')).toContain('native HFD skips its coefficient transfer');
    project.presets[0].inputFir = {
      name: 'unsafe-short.txt',
      enabled: true,
      taps: new Array(11).fill(0),
      hfdState: { loaded: true, used: true, tapCount: 11 },
    };
    await expect(buildClonePlan(project, template(), target(), overrides())).rejects.toThrow(
      /cannot faithfully reproduce.*short 11-sample/,
    );
  });

  it('uses native full-byte filename encoding and reports lossy labels rather than silently slicing them', async () => {
    const project = newProject('Names');
    project.presets[0].inputFir = {
      name: `folder/${'x'.repeat(32)}Ā.txt`,
      enabled: false,
      taps: [],
      hfdState: { loaded: true, used: true, tapCount: 0 },
    };
    const plan = await buildClonePlan(project, template(), target(), overrides());
    expect(plan.presets[0].fir.filenames[0].bytes).toEqual(new Uint8Array(32).fill(120));
    expect(plan.warnings.join(' ')).toContain('first 32 UTF-16 low bytes');
  });

  it('matches independent Node hashes and strict journal hash manifests, including all unmodified images', async () => {
    const destination = target(),
      plan = await buildClonePlan(newProject('Hashes'), template(), destination, overrides());
    for (const image of [
      ...plan.before.flash,
      ...plan.before.filenames,
      ...plan.desired.flash,
      ...plan.desired.filenames,
    ])
      expect(image.sha256).toBe(sha(unhex(image.hex)));
    expect(plan.before.sha256).toBe(cloneImageSha256(plan.before));
    expect(plan.desired.sha256).toBe(cloneImageSha256(plan.desired));
    expect(plan.before.flash[0].sha256).toBe(cloneBytesSha256(hex(destination.flash[0].bytes)));
    const second = await buildClonePlan(newProject('Hashes'), template(), destination, overrides());
    expect(second.desired).toEqual(plan.desired);
  });

  it('persists every exact sequential activation report without retargeting the active hardware preset', async () => {
    const plan = await buildClonePlan(
      newProject('Activation sequence'),
      template(),
      target(),
      overrides(),
    );
    expect(plan.presetActivations.map((step) => Array.from(step.request.slice(28, 31)))).toEqual([
      [1, 33, 41],
      [1, 1, 41],
      [1, 1, 1],
    ]);
    expect(plan.presetActivations.map((step) => step.request[31])).toEqual([2, 0, 0]);
    for (const [index, step] of plan.presetActivations.entries()) {
      expect([
        step.request[0],
        step.request[1],
        step.request[2],
        step.request[6],
        step.request[23],
      ]).toEqual([5, 0, 2, 128, 0]);
      expect(new DataView(step.request.buffer).getInt16(3, true)).toBe(-9600);
      expect(Array.from(step.request.slice(24, 26))).toEqual([169, 115]);
      expect(plan.desired.presetActivations[index]).toEqual({
        preset: index + 1,
        requestHex: hex(step.request),
        expectedHex: hex(step.verification.expected),
        maskHex: hex(step.verification.mask),
      });
      step.request.fill(0);
      expect(plan.presetActivations[index].request[0]).toBe(5);
    }
    const changed = structuredClone(plan.desired);
    changed.presetActivations[1].requestHex = changed.presetActivations[0].requestHex;
    expect(cloneImageSha256(changed)).not.toBe(plan.desired.sha256);
  });

  it('detaches every source before hashing and returns immutable reports/images', async () => {
    const project = newProject('Original'),
      captured = template(),
      destination = target(),
      override = overrides(),
      promise = buildClonePlan(project, captured, destination, override);
    project.name = 'Changed';
    captured.configuration.limiter[0].threshold = 0;
    destination.flash[0].bytes.fill(0);
    override.presets[0].forceInput = 1;
    const plan = await promise;
    expect(plan.dspName).toBe('Original');
    expect(new DataView(plan.reports[2].request.buffer).getInt32(20, true)).toBe(48180524);
    const report = plan.reports[1].request;
    report.fill(0);
    expect(plan.reports[1].request[0]).toBe(5);
    plan.presets[0].iir.bytes.fill(255);
    expect(plan.presets[0].iir.bytes[0]).toBe(0);
    plan.dspNameRequest.fill(0);
    expect(plan.dspNameRequest[0]).toBe(3);
    expect(Object.isFrozen(plan.desired.flash)).toBe(true);
    expect(Object.isFrozen(plan.desired.flash[0])).toBe(true);
  });

  it.each([
    'foreign serial',
    'wrong module',
    'locked',
    'missing flash',
    'duplicate names',
    'wrong core',
  ] as const)('rejects %s before producing a partial plan', async (reason) => {
    const destination = target();
    if (reason === 'foreign serial') destination.identity.serial = 'OTHER';
    if (reason === 'wrong module') destination.deviceConfiguration[11] = 1;
    if (reason === 'locked') destination.status[51] = STATUS_FLAGS.passwordProtected;
    if (reason === 'missing flash') destination.flash.pop();
    if (reason === 'duplicate names')
      destination.filenames[1].address = destination.filenames[0].address;
    if (reason === 'wrong core') destination.configuration[2] = 4;
    await expect(
      buildClonePlan(newProject(), template(), destination, overrides()),
    ).rejects.toThrow();
  });

  it('keeps master source/volume locks clear and rejects inputs absent from the native Clone menu', async () => {
    const override = overrides();
    override.mode = 'master';
    override.presets[0].forceInput = 0;
    const plan = await buildClonePlan(newProject(), template(), target(), override),
      report = plan.reports[1].request;
    expect(new DataView(report.buffer).getUint16(9, true) & 4).toBe(0);
    expect(Array.from(report.slice(12, 15)).map((byte) => byte & 0xa0)).toEqual([0, 0, 0]);
    override.presets[0].forceInput = 3;
    await expect(buildClonePlan(newProject(), template(), target(), override)).rejects.toThrow(
      /native master\/slave menu/,
    );
    override.mode = 'slave';
    override.presets[0].forceInput = 0;
    await expect(buildClonePlan(newProject(), template(), target(), override)).rejects.toThrow(
      /native master\/slave menu/,
    );
  });
});

describe('native Clone name reduction', () => {
  it.each([
    ['a'.repeat(30), 'a'.repeat(30)],
    ['a'.repeat(31), 'a'.repeat(30)],
    ['C:\\very-long-native-project-folder\\short', 'C:\\very-long-native-pr..\\short'],
    ['C:\\folder\\' + 'b'.repeat(25), 'b'.repeat(25)],
    ['C:\\folder\\' + 'c'.repeat(31), 'c'.repeat(30)],
  ])('reduces %s with the native basename/path rule', (input, expected) => {
    expect(reduceNativeCloneDspName(input)).toBe(expected);
    const bytes = encodeNativeCloneDspName(input);
    expect(bytes.slice(0, 2)).toEqual(new Uint8Array([3, 0]));
    expect(new TextDecoder().decode(bytes.slice(2, 2 + expected.length))).toBe(expected);
    expect(bytes[expected.length + 3]).toBe(0);
  });
  it('does not invent a current-code-page conversion for Unicode names', () => {
    expect(() => reduceNativeCloneDspName('Café')).toThrow(/non-ASCII conversion/);
    expect(() => reduceNativeCloneDspName('a'.repeat(256))).toThrow(/255/);
  });
});
