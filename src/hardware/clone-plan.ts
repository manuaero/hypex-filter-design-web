import { newFilter, type Fir, type Preset, type Project } from '../domain/model';
import { nativeCloneTemplateSchema, type NativeCloneTemplate } from '../domain/clone-template';
import { projectSchema } from '../domain/files';
import { compileSector, q24 } from '../domain/dsp';
import {
  firIsEffective,
  firLoaded,
  presetFirPlacement,
  validateFirState,
} from '../domain/fir-state';
import { firLayout } from './fir';
import { control, decodeStatus, encodeEq, hex, packet, settings } from './codec';
import { digest } from './checksum';
import { decodeHardwareOverview } from './device-settings';
import {
  deviceDefaultsStatusMask,
  type DeviceDefaultsIdentity,
  type DeviceDefaultsStep,
} from './device-defaults';
import { CLONE_MASTER_INPUT_SOURCES, CLONE_SLAVE_INPUT_SOURCES } from './input-sources';
import type {
  CloneBeforeImage,
  CloneDesiredImage,
  CloneOverrides,
} from '../application/device-clone-storage';

export interface CloneTargetSnapshot {
  identity: DeviceDefaultsIdentity;
  status: Uint8Array;
  configuration: Uint8Array;
  deviceConfiguration: Uint8Array;
  dspName: Uint8Array;
  serial: Uint8Array;
  flash: { address: number; bytes: Uint8Array }[];
  filenames: { address: number; bytes: Uint8Array }[];
}
export interface ClonePresetPlan {
  preset: number;
  iir: { address: number; bytes: Uint8Array };
  eq: { address: number; bytes: Uint8Array };
  fir: {
    sectors: { address: number; bytes: Uint8Array }[];
    filenames: { address: number; bytes: Uint8Array }[];
    flags: number;
    placement: 0 | 1;
  };
}
export interface DeviceClonePlan {
  before: CloneBeforeImage;
  desired: CloneDesiredImage;
  reports: readonly DeviceDefaultsStep[];
  presetActivations: readonly DeviceDefaultsStep[];
  dspNameRequest: Uint8Array;
  dspName: string;
  warnings: readonly string[];
  presets: readonly ClonePresetPlan[];
}
export type { CloneOverrides, NativeCloneTemplate, Project };

const filenameAddresses = Array.from({ length: 3 }, (_, p) =>
  Array.from({ length: 4 }, (_, n) => 0x200 + p * 0x80 + n * 32),
).flat();
const imageAddresses = Array.from({ length: 24 }, (_, i) => 0x10000 + i * 4096);

/** ASCII is invariant under the native current-code-page ShortString conversion.
 * Non-ASCII conversion is deliberately unavailable until that path is qualified. */
export function reduceNativeCloneDspName(name: string): string {
  if (typeof name !== 'string' || name.length > 255 || /[^\x20-\x7e]/.test(name))
    throw new Error(
      'Clone DSP name requires at most 255 printable ASCII characters; native non-ASCII conversion is not verified',
    );
  if (name.length <= 30) return name;
  const delimiter = Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/'), name.lastIndexOf(':')),
    basename = name.slice(delimiter + 1);
  if (basename.length >= 25) return basename.slice(0, 30);
  return name.slice(0, delimiter + 1).slice(0, 27 - basename.length) + '..\\' + basename;
}
/** Native a9fd3e..a9fdd1; reports omit the Windows HID report-id byte. */
export function encodeNativeCloneDspName(name: string): Uint8Array {
  const value = reduceNativeCloneDspName(name),
    request = packet(3, 0);
  request.set(
    Array.from(value, (character) => character.charCodeAt(0)),
    2,
  );
  request[value.length + 3] = 0;
  return request;
}
function nativeFilename(name: string): Uint8Array {
  // a9fb38 writes UTF-16 low bytes into a zeroed buffer, then commits the first
  // 32 bytes. This path is distinct from the DSP name's ANSI conversion.
  const base = name.split(/[\\/]/).pop() ?? '';
  if (base.length > 255)
    throw new Error(
      'Clone cannot safely reproduce a native FIR filename longer than 255 code units',
    );
  const result = new Uint8Array(32);
  for (let i = 0; i < Math.min(32, base.length); i++) result[i] = base.charCodeAt(i) & 255;
  return result;
}
function requireInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Clone ${label} is outside its native wire range`);
  return value;
}
// aa6300/aa655e first store the product in a Double; a9a6a8 then adds/subtracts
// 0.5 before Trunc. This is different from the generic browser round-even helper.
function hundredths(value: number, single = false): number {
  const scaled = (single ? Math.fround(value) : value) * 100;
  return requireInteger(
    Math.trunc(scaled + (scaled < 0 ? -0.5 : 0.5)),
    -32768,
    32767,
    'hundredths value',
  );
}
export interface NativeCloneFirPlan {
  placement: 0 | 1;
  flags: number;
  anyTransfer: boolean;
  banks: { filter: Fir; capacity: number; channel: number; loaded: boolean; transfer: boolean }[];
  warnings: string[];
}
/** Native selected-placement transfer, independent of graph Used flags. */
export function planNativeCloneFir(preset: Preset, previousFlags: number): NativeCloneFirPlan {
  requireInteger(previousFlags, 0, 255, 'previous FIR flags');
  if (preset.channels.length !== 3) throw new Error('Clone requires three output FIR resources');
  const placement = presetFirPlacement(preset) === 'input' ? 0 : 1,
    resources = [
      { filter: preset.inputFir, capacity: 4500, channel: 0 },
      ...preset.channels.map((channel, index) => ({
        filter: channel.fir,
        capacity: 1500,
        channel: index + 1,
      })),
    ],
    warnings: string[] = [];
  for (const resource of resources) validateFirState(resource.filter, resource.capacity);
  const selected = (channel: number) => (placement === 0 ? channel === 0 : channel > 0);
  for (const resource of resources.filter((resource) => !selected(resource.channel)))
    if (firIsEffective(resource.filter, false))
      warnings.push(
        `Inactive ${resource.channel === 0 ? 'input' : `output ${resource.channel}`} graph FIR is not transferred; only the selected placement is programmed.`,
      );
  const banks = resources
    .filter((resource) => selected(resource.channel))
    .map((resource) => ({
      ...resource,
      loaded: firLoaded(resource.filter),
      transfer: firLoaded(resource.filter) && resource.filter.taps.length > 10,
    }));
  for (const bank of banks) {
    if (bank.transfer && bank.filter.taps.length !== bank.capacity)
      throw new Error(
        `Clone cannot faithfully reproduce the native fixed-capacity read from a short ${bank.filter.taps.length}-sample FIR cache; reload ${bank.capacity} original taps`,
      );
    if (bank.loaded && !bank.transfer)
      warnings.push(
        `Selected ${bank.channel === 0 ? 'input' : `output ${bank.channel}`} FIR has ${bank.filter.taps.length} samples; native HFD skips its coefficient transfer and still commits its loaded filename.`,
      );
  }
  const anyTransfer = banks.some((bank) => bank.transfer);
  let flags = previousFlags & (placement === 0 ? 7 : 8);
  for (const bank of banks) {
    const bit = placement === 0 ? 3 : bank.channel - 1;
    if (anyTransfer && bank.loaded && bank.filter.taps.length > 0) flags |= 1 << (bit + 4);
    if (anyTransfer && bank.filter.enabled) flags |= 1 << bit;
  }
  return { placement: placement as 0 | 1, flags, anyTransfer, banks, warnings };
}
export function assertCloneTargetSnapshot(
  target: CloneTargetSnapshot,
  options: { allowLocked?: boolean } = {},
): void {
  const {
    identity,
    status,
    configuration,
    deviceConfiguration,
    dspName,
    serial,
    flash,
    filenames,
  } = target;
  if (
    ![status, configuration, deviceConfiguration, dspName].every(
      (value) => value instanceof Uint8Array && value.length === 64,
    ) ||
    !(serial instanceof Uint8Array) ||
    serial.length !== 32
  )
    throw new Error('Clone requires complete 05/06/66/DSP-name and serial snapshots');
  decodeHardwareOverview(configuration, deviceConfiguration);
  const state = decodeStatus(status),
    view = new DataView(configuration.buffer, configuration.byteOffset, configuration.byteLength);
  if (state.locked && !options.allowLocked) throw new Error('Clone requires an unlocked amplifier');
  if (
    !identity ||
    identity.product !== 22 ||
    identity.core !== '5.1' ||
    identity.firmware !== `${view.getUint16(15, true)}.${view.getUint16(17, true)}` ||
    deviceConfiguration[11] !== 9
  )
    throw new Error('Clone requires a matching FA503 module 9 / DSP 5.1 target');
  if (
    !identity.serial ||
    /[^\x20-\x7e]/.test(identity.serial) ||
    identity.serial !== new TextDecoder('latin1').decode(serial).replace(/\0.*$/s, '').trim()
  )
    throw new Error('Clone serial snapshot does not match the target identity');
  if (dspName[0] !== 3) throw new Error('Invalid Clone DSP-name reply');
  for (const [values, addresses, size, label] of [
    [flash, imageAddresses, 4096, 'flash'],
    [filenames, filenameAddresses, 32, 'filename'],
  ] as const) {
    if (
      !Array.isArray(values) ||
      values.length !== addresses.length ||
      values.some(
        (value, index) =>
          value.address !== addresses[index] ||
          !(value.bytes instanceof Uint8Array) ||
          value.bytes.length !== size,
      )
    )
      throw new Error(`Clone requires every ordered ${label} before-image`);
  }
}
function cloneTarget(target: CloneTargetSnapshot): CloneTargetSnapshot {
  return {
    identity: { ...target.identity },
    status: target.status.slice(),
    configuration: target.configuration.slice(),
    deviceConfiguration: target.deviceConfiguration.slice(),
    dspName: target.dspName.slice(),
    serial: target.serial.slice(),
    flash: target.flash.map((image) => ({ address: image.address, bytes: image.bytes.slice() })),
    filenames: target.filenames.map((image) => ({
      address: image.address,
      bytes: image.bytes.slice(),
    })),
  };
}
function mutableReport(id: DeviceDefaultsStep['id'], request: Uint8Array): DeviceDefaultsStep {
  const expected = request.slice(),
    mask = request[0] === 5 ? deviceDefaultsStatusMask() : new Uint8Array(64).fill(255);
  if (request[0] === 0x66) {
    expected[1] = 0;
    mask[1] = 0;
  }
  return { id, request, verification: { expected, mask } };
}
function immutableReport(step: DeviceDefaultsStep): DeviceDefaultsStep {
  const request = step.request.slice(),
    expected = step.verification.expected.slice(),
    mask = step.verification.mask.slice();
  return Object.freeze({
    id: step.id,
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
function immutableImage(image: { address: number; bytes: Uint8Array }) {
  const bytes = image.bytes.slice();
  return Object.freeze({
    address: image.address,
    get bytes() {
      return bytes.slice();
    },
  });
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
function settingsReport(
  target: CloneTargetSnapshot,
  template: NativeCloneTemplate,
  overrides: CloneOverrides,
): Uint8Array {
  if (
    !overrides ||
    !['master', 'slave'].includes(overrides.mode) ||
    !Array.isArray(overrides.presets) ||
    overrides.presets.length !== 3
  )
    throw new Error('Clone requires explicit mode and three preset overrides');
  const source = template.settings,
    result = control(decodeStatus(target.status), {
      mute: true,
      channelMutes: [false, false, false],
      volume: -96,
      preset: source.selectedPreset,
    }),
    view = new DataView(result.buffer);
  result[6] = 0x80;
  result[7] = requireInteger(source.standbyMode, 0, 1, 'standby mode');
  result[8] = source.powerOffTime;
  const options = (source.options & ~4) | (overrides.mode === 'slave' ? 4 : 0);
  view.setUint16(9, options, true);
  result[11] =
    requireInteger(source.digitalChannelSelect, 0, 7, 'digital channel selection') |
    (source.mfbEnabled ? 8 : 0);
  source.presets.forEach((preset, index) => {
    const override = overrides.presets[index];
    const choices =
      overrides.mode === 'master' ? CLONE_MASTER_INPUT_SOURCES : CLONE_SLAVE_INPUT_SOURCES;
    if (!choices.some((choice) => choice.id === override.forceInput))
      throw new Error('Clone source override is not in the native master/slave menu');
    if (typeof override.sourceLock !== 'boolean' || typeof override.volumeLock !== 'boolean')
      throw new Error('Invalid Clone source/volume lock override');
    result[12 + index] =
      override.forceInput |
      (preset.eqEnabled ? 16 : 0) |
      (preset.adcDigitalOut ? 64 : 0) |
      (overrides.mode === 'slave' && override.volumeLock ? 32 : 0) |
      (overrides.mode === 'slave' && override.sourceLock ? 128 : 0);
    view.setInt16(15 + 2 * index, hundredths(preset.volumeOffset, true), true);
    let flags = (preset.inputFir.enabled ? 8 : 0) | (preset.inputFir.loaded ? 128 : 0);
    preset.outputFirs.forEach((fir, ch) => {
      flags |= (fir.enabled ? 1 << ch : 0) | (fir.loaded ? 1 << (ch + 4) : 0);
    });
    result[28 + index] = flags;
    requireInteger(preset.application, 0, 1, 'FIR application');
  });
  result[31] = source.presets.reduce(
    (value, preset, index) => value | (preset.application << index),
    0,
  );
  view.setInt16(21, hundredths(source.startupVolume), true);
  // Source protection masks are metadata, never an authorization operation.
  result.set(target.status.slice(24, 26), 24);
  result[23] = 4;
  result[27] =
    requireInteger(source.detectionOn, 0, 3, 'detection-on') |
    (requireInteger(source.detectionOff, 0, 3, 'detection-off') << 2);
  result[35] = source.oledBrightness;
  result[36] = source.advancedOptions & 0xfb;
  return result;
}
function configurationReport(
  target: CloneTargetSnapshot,
  template: NativeCloneTemplate,
): Uint8Array {
  const source = template.configuration,
    result = target.deviceConfiguration.slice(),
    view = new DataView(result.buffer);
  result[1] = 1;
  result[10] = requireInteger(source.amplifier, 0, 255, 'amplifier');
  result[11] = source.moduleType;
  result[13] = source.thirdChannelEnabled ? 1 : 0;
  result[14] =
    (result[14] & 0x7e) | (source.fanConnected ? 1 : 0) | (source.mixerEnabled ? 128 : 0);
  result[15] = requireInteger(source.temperatureSetpoint, 0, 255, 'temperature');
  view.setInt16(16, requireInteger(source.dspPeakSetpoint, -32768, 32767, 'DSP peak'), true);
  source.limiter.forEach((channel, index) => {
    view.setInt32(20 + index * 4, q24(channel.threshold), true);
    view.setInt32(32 + index * 4, q24(channel.attack), true);
    view.setInt32(44 + index * 4, q24(channel.release), true);
    result[56 + index] = requireInteger(
      Math.trunc(Math.fround(channel.ohms) * 10 + 0.5),
      0,
      255,
      'impedance',
    );
    result[59 + index] = requireInteger(
      Math.trunc(Math.fround(channel.watts) / 5 + 0.5),
      0,
      255,
      'power',
    );
  });
  return result;
}
async function hashedImages(images: { address: number; bytes: Uint8Array }[]) {
  return Promise.all(
    images.map(async (image) => ({
      address: image.address,
      hex: hex(image.bytes),
      sha256: await digest(image.bytes),
    })),
  );
}
async function manifest(
  image: Omit<CloneBeforeImage, 'sha256'> | Omit<CloneDesiredImage, 'sha256'>,
): Promise<string> {
  const addressed = (values: { address: number; sha256: string }[] | undefined) =>
    values?.map(({ address, sha256 }) => [address, sha256]) ?? null;
  const value =
    'configurationHex' in image
      ? [
          'before',
          image.statusHex,
          image.configurationHex,
          image.deviceConfigurationHex,
          image.dspNameHex,
          image.serialHex,
          addressed(image.flash),
          addressed(image.filenames),
          addressed(image.oemStrings),
        ]
      : [
          'desired',
          image.reports.map(({ id, requestHex, expectedHex, maskHex }) => [
            id,
            requestHex,
            expectedHex,
            maskHex,
          ]),
          image.presetActivations.map(({ preset, requestHex, expectedHex, maskHex }) => [
            preset,
            requestHex,
            expectedHex,
            maskHex,
          ]),
          image.dspNameHex,
          addressed(image.flash),
          addressed(image.filenames),
          addressed(image.oemStrings),
        ];
  return digest(new TextEncoder().encode(JSON.stringify(value)));
}

/** Complete, detached module-9 source plan. No reads, writes, permissions or retries. */
export async function buildClonePlan(
  inputProject: Project,
  inputTemplate: NativeCloneTemplate,
  inputTarget: CloneTargetSnapshot,
  inputOverrides: CloneOverrides,
): Promise<DeviceClonePlan> {
  assertCloneTargetSnapshot(inputTarget);
  const project = projectSchema.parse(inputProject) as Project,
    template = nativeCloneTemplateSchema.parse(inputTemplate),
    target = cloneTarget(inputTarget),
    overrides = structuredClone(inputOverrides);
  if (
    !template.configuration.valid ||
    template.configuration.moduleType !== 9 ||
    template.configuration.amplifier !== 5 ||
    template.device.product !== 22 ||
    template.device.version !== 5 ||
    template.device.build !== 1 ||
    template.device.bootloaderMode ||
    template.device.presetCount !== 3 ||
    template.device.channelCount !== 3
  )
    throw new Error('Clone template requires a complete FA503 module 9 / DSP 5.1 snapshot');
  const mute = control(decodeStatus(target.status), {
    mute: true,
    channelMutes: [false, false, false],
  });
  mute[6] = 0x80;
  const configured = settingsReport(target, template, overrides),
    configuration = configurationReport(target, template),
    display = configured.slice();
  display[23] = 8;
  const reports = [
    mutableReport('mute', mute),
    mutableReport('settings', configured),
    mutableReport('configuration', configuration),
    mutableReport('display', display),
  ];
  const flash = target.flash.map((image) => ({
      address: image.address,
      bytes: image.bytes.slice(),
    })),
    names = target.filenames.map((image) => ({
      address: image.address,
      bytes: image.bytes.slice(),
    })),
    presets: ClonePresetPlan[] = [],
    warnings: string[] = [];
  const find = (address: number) => flash.find((image) => image.address === address)!;
  for (const [index, preset] of project.presets.entries()) {
    const number = index + 1,
      iirAddress = 0x22000 + index * 4096,
      eqAddress = 0x25000 + index * 4096;
    const iir = { address: iirAddress, bytes: compileSector(preset, find(iirAddress).bytes) };
    find(iirAddress).bytes = iir.bytes.slice();
    const bands = template.eqBanks[index].map((band, bandIndex) => {
      if (![0, 1, 2].includes(band.filterType))
        throw new Error('Unsupported native Clone EQ filter type');
      return {
        ...newFilter((['peak', 'lowshelf2', 'highshelf2'] as const)[band.filterType]),
        id: `clone-eq-${index}-${bandIndex}`,
        enabled: band.enabled,
        frequency: band.frequency,
        q: band.q,
        gain: band.gain,
      };
    });
    const eq = { address: eqAddress, bytes: find(eqAddress).bytes.slice() };
    eq.bytes.set(encodeEq(bands), 0);
    find(eqAddress).bytes = eq.bytes.slice();
    const activation = planNativeCloneFir(preset, configured[28 + index]),
      layout = firLayout(number),
      touched = new Set<number>(),
      filenames: ClonePresetPlan['fir']['filenames'] = [];
    warnings.push(...activation.warnings.map((warning) => `Preset ${number}: ${warning}`));
    if (activation.anyTransfer) {
      const view = new DataView(target.configuration.buffer);
      if (
        !(target.configuration[14] & 128) ||
        view.getUint16(50, true) !== 4500 ||
        [52, 54, 56].some((offset) => view.getUint16(offset, true) !== 1500) ||
        settings(decodeStatus(configured)).firMode !== 0
      )
        throw new Error('Clone FIR programming requires the recovered ordinary 4500/1500-tap mode');
    }
    activation.banks.forEach((bank, bankIndex) => {
      if (!bank.loaded) return;
      if (bank.transfer) {
        const encoded = new Uint8Array(bank.capacity * 4),
          view = new DataView(encoded.buffer),
          offset = activation.placement === 0 ? 0 : bankIndex * 0x2000;
        bank.filter.taps.forEach((_, tap) =>
          view.setInt32(tap * 4, q24(bank.filter.taps[bank.capacity - 1 - tap]), true),
        );
        for (let byte = 0; byte < encoded.length; byte++) {
          const address = layout.base + offset + byte,
            sectorAddress = address & ~4095;
          find(sectorAddress).bytes[address - sectorAddress] = encoded[byte];
          touched.add(sectorAddress);
        }
      }
      const address = layout.names[activation.placement === 0 ? 0 : bankIndex + 1],
        bytes = nativeFilename(bank.filter.name);
      const base = bank.filter.name.split(/[\\/]/).pop() ?? '';
      if (
        base.length > 32 ||
        Array.from({ length: base.length }, (_, i) => base.charCodeAt(i)).some((code) => code > 255)
      )
        warnings.push(
          `Preset ${number}: native FIR filename uses the first 32 UTF-16 low bytes; its saved device label differs from the design filename.`,
        );
      names.find((image) => image.address === address)!.bytes = bytes.slice();
      filenames.push({ address, bytes });
    });
    presets.push({
      preset: number,
      iir,
      eq,
      fir: {
        sectors: [...touched]
          .sort((a, b) => a - b)
          .map((address) => ({ address, bytes: find(address).bytes.slice() })),
        filenames,
        flags: activation.flags,
        placement: activation.placement,
      },
    });
  }
  const dspName = reduceNativeCloneDspName(project.name),
    dspNameRequest = encodeNativeCloneDspName(project.name),
    dspReply = packet(3, 0, ...Array.from(dspName, (character) => character.charCodeAt(0)));
  let activationStatus = display;
  const presetActivations = presets.map((preset) => {
    activationStatus = control(decodeStatus(activationStatus), {
      mute: true,
      presetFir: {
        preset: preset.preset,
        flags: preset.fir.flags,
        placement: preset.fir.placement,
      },
    });
    activationStatus[6] = 0x80;
    return mutableReport('settings', activationStatus);
  });
  // Inputs and every target byte are already detached before the first await.
  const [beforeFlash, beforeNames, afterFlash, afterNames] = await Promise.all([
    hashedImages(target.flash),
    hashedImages(target.filenames),
    hashedImages(flash),
    hashedImages(names),
  ]);
  const beforeBody: Omit<CloneBeforeImage, 'sha256'> = {
    statusHex: hex(target.status),
    configurationHex: hex(target.configuration),
    deviceConfigurationHex: hex(target.deviceConfiguration),
    dspNameHex: hex(target.dspName),
    serialHex: hex(target.serial),
    flash: beforeFlash,
    filenames: beforeNames,
  };
  const desiredBody: Omit<CloneDesiredImage, 'sha256'> = {
    reports: reports.map((step) => ({
      id: step.id as 'mute' | 'settings' | 'configuration' | 'display',
      requestHex: hex(step.request),
      expectedHex: hex(step.verification.expected),
      maskHex: hex(step.verification.mask),
    })),
    presetActivations: presetActivations.map((step, index) => ({
      preset: (index + 1) as 1 | 2 | 3,
      requestHex: hex(step.request),
      expectedHex: hex(step.verification.expected),
      maskHex: hex(step.verification.mask),
    })),
    dspNameHex: hex(dspReply),
    flash: afterFlash,
    filenames: afterNames,
  };
  const [beforeSha, desiredSha] = await Promise.all([manifest(beforeBody), manifest(desiredBody)]);
  const immutablePresets = Object.freeze(
    presets.map((preset) =>
      Object.freeze({
        preset: preset.preset,
        iir: immutableImage(preset.iir),
        eq: immutableImage(preset.eq),
        fir: Object.freeze({
          sectors: Object.freeze(preset.fir.sectors.map(immutableImage)),
          filenames: Object.freeze(preset.fir.filenames.map(immutableImage)),
          flags: preset.fir.flags,
          placement: preset.fir.placement,
        }),
      }),
    ),
  );
  return Object.freeze({
    before: deepFreeze({ ...beforeBody, sha256: beforeSha }),
    desired: deepFreeze({ ...desiredBody, sha256: desiredSha }),
    reports: Object.freeze(reports.map(immutableReport)),
    presetActivations: Object.freeze(presetActivations.map(immutableReport)),
    get dspNameRequest() {
      return dspNameRequest.slice();
    },
    dspName,
    warnings: Object.freeze(warnings),
    presets: immutablePresets,
  }) as DeviceClonePlan;
}
