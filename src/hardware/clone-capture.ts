import {
  nativeCloneTemplateSchema,
  type NativeCloneTemplate,
  type NativeCloneCaptureDefaultField,
} from '../domain/clone-template';
import { assertCloneTargetSnapshot, type CloneTargetSnapshot } from './clone-plan';
import { decodeEq } from './codec';
import { decodeHardwareOverview, decodeLimiter } from './device-settings';
import { decodeStatusFlags } from './status-flags';

export interface CloneCaptureSnapshot extends CloneTargetSnapshot {
  mixerConfiguration: Uint8Array;
  productStrings: { hypexName: Uint8Array; oemName: Uint8Array };
}

function nativeString(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    // a9ae10 and aae598 stop at the first non-native-printable byte.
    if (byte < 0x20 || byte > 0x7f) break;
    result += String.fromCharCode(byte);
  }
  return result;
}
function dspFilename(bytes: Uint8Array): string {
  let result = '';
  // aa7b74..be4 reads exactly the native 30-character filename field.
  for (const byte of bytes.slice(2, 32)) {
    if (byte === 0 || byte === 255) break;
    if (byte > 127)
      throw new Error('Native DSP filename current-code-page conversion is not verified');
    result += String.fromCharCode(byte);
  }
  return result;
}

/** Pure fresh-native-host capture. Its defaults never claim to be measured or
 * retained state from an existing Windows host; all required reads are complete. */
export function captureNativeCloneTemplate(
  snapshot: CloneCaptureSnapshot,
  capturedAt?: string,
): NativeCloneTemplate {
  assertCloneTargetSnapshot(snapshot, { allowLocked: true });
  const { mixerConfiguration, productStrings, status, configuration, deviceConfiguration } =
    snapshot;
  if (
    !(mixerConfiguration instanceof Uint8Array) ||
    mixerConfiguration.length !== 64 ||
    mixerConfiguration[0] !== 0x67 ||
    !productStrings ||
    ![productStrings.hypexName, productStrings.oemName].every(
      (value) => value instanceof Uint8Array && value.length === 32,
    )
  )
    throw new Error('Clone capture requires complete 67 mixer and Hypex/OEM string snapshots');
  // These counts are actually transmitted: a9c0e0 maps driver107c8/107dc.
  if (configuration[12] !== 3 || configuration[5] !== 3)
    throw new Error('Clone capture requires the native three-preset / three-channel counts');
  const hardware = decodeHardwareOverview(configuration, deviceConfiguration),
    limiter = decodeLimiter(deviceConfiguration),
    statusView = new DataView(status.buffer, status.byteOffset, status.byteLength),
    configurationView = new DataView(
      configuration.buffer,
      configuration.byteOffset,
      configuration.byteLength,
    ),
    mixerView = new DataView(
      mixerConfiguration.buffer,
      mixerConfiguration.byteOffset,
      mixerConfiguration.byteLength,
    ),
    options = statusView.getUint16(9, true) === 65535 ? 25 : statusView.getUint16(9, true),
    flags = decodeStatusFlags(status);
  const serial = nativeString(snapshot.serial),
    valid = /^(H05U|H03U|H99U)/.test(serial);
  const captureDefaults: NativeCloneCaptureDefaultField[] = [
    'device.bundleVersion',
    'device.bootloaderVersion',
    'settings.gainCorrection12',
    'settings.gainCorrection3',
    'settings.routing',
  ];
  const presets = Array.from({ length: 3 }, (_, index) => {
    const packed = status[12 + index],
      firFlags = status[28 + index],
      application = (status[31] >> index) & 1,
      base = 0x200 + index * 0x80;
    const filename = (channel: number) => {
      const selected = application === 0 ? channel === 0 : channel > 0;
      if (!selected) {
        captureDefaults.push(
          channel === 0
            ? (`settings.presets.${index}.inputFir.filename` as NativeCloneCaptureDefaultField)
            : (`settings.presets.${index}.outputFirs.${channel - 1}.filename` as NativeCloneCaptureDefaultField),
        );
        return '';
      }
      return nativeString(
        snapshot.filenames.find((image) => image.address === base + channel * 32)!.bytes,
      );
    };
    return {
      forceInput: packed & 15,
      volumeOffset: Math.fround(statusView.getInt16(15 + index * 2, true) / 100),
      adcDigitalOut: !!(packed & 64),
      sourceLock: !!(packed & 128),
      volumeLock: !!(packed & 32),
      eqEnabled: !!(packed & 16),
      application,
      inputFir: { loaded: !!(firFlags & 128), filename: filename(0), enabled: !!(firFlags & 8) },
      outputFirs: Array.from({ length: 3 }, (_, channel) => ({
        loaded: !!(firFlags & (16 << channel)),
        filename: filename(channel + 1),
        enabled: !!(firFlags & (1 << channel)),
      })),
    };
  });
  const major = configurationView.getUint16(15, true),
    minor = configurationView.getUint16(17, true);
  return nativeCloneTemplateSchema.parse({
    version: 1,
    provenance: {
      kind: 'device-capture',
      sourceSerial: snapshot.identity.serial,
      ...(capturedAt === undefined ? {} : { capturedAt }),
      captureDefaults,
    },
    configuration: {
      valid,
      hypexName: valid ? nativeString(productStrings.hypexName) : '',
      oemName: valid ? nativeString(productStrings.oemName) : '',
      serialNumber: valid ? serial : '----------',
      amplifier: hardware.amplifier,
      thirdChannelEnabled: hardware.thirdChannelEnabled,
      fanConnected: hardware.fanConnected,
      mixerEnabled: hardware.stereoDsp,
      moduleType: hardware.moduleType,
      detectedHardware: hardware.product,
      temperatureSetpoint: hardware.temperatureSetpoint,
      dspPeakSetpoint: hardware.dspPeakSetpoint,
      mixer: Array.from({ length: 3 }, (_, preset) =>
        Array.from(
          { length: 6 },
          (_, channel) => mixerView.getInt16(2 + (preset * 6 + channel) * 2, true) / 256,
        ),
      ),
      limiter: limiter.channels.map((channel) => ({
        threshold: channel.threshold,
        attack: channel.attack,
        release: channel.release,
        ohms: Math.fround(channel.ohms),
        watts: channel.watts,
      })),
    },
    device: {
      product: configuration[1],
      version: configuration[2],
      build: configuration[3],
      bootloaderMode: false,
      dspFilename: dspFilename(snapshot.dspName),
      bundleVersion: '',
      unitBehaviour: options & 4 ? 1 : 0,
      digitalInputPresent: false,
      testFirmware: false,
      subSetup: 0,
      presetCount: configuration[12],
      channelCount: configuration[5],
      bootloaderVersion: 0,
    },
    settings: {
      activeInput: status[50],
      forcedInput: status[1],
      actualVolume: Math.fround(statusView.getInt16(52, true) / 100),
      passwordProtected: flags.passwordProtected,
      digitalChannelSelect: status[11] & 7,
      mfbEnabled: !!(status[11] & 8),
      presets,
      startupVolume: statusView.getInt16(21, true) / 100,
      standbyMode: status[7],
      gainCorrection12: 0,
      gainCorrection3: 0,
      protectionMask: flags.passwordProtected ? statusView.getUint16(24, true) : 65535,
      detectionOn: status[27] & 3,
      detectionOff: (status[27] >> 2) & 3,
      oledBrightness: status[35],
      systemSetup: configuration[4],
      selectedPreset: status[2],
      muted: !!(status[6] & 128),
      options,
      advancedOptions: status[36] & 0xfb,
      powerOffTime: status[8],
      routing: [0, 0, 0, 0, 0, 0],
      bundleBcdMajor: major,
      bundleBcdMinor: minor,
      controlBundleVersion: `${major}.${minor}`,
    },
    eqBanks: [0, 1, 2].map((preset) =>
      decodeEq(
        snapshot.flash
          .find((image) => image.address === 0x25000 + preset * 4096)!
          .bytes.slice(0, 256),
      ).map((band) => ({
        filterType: band.kind === 'lowshelf2' ? 1 : band.kind === 'highshelf2' ? 2 : 0,
        enabled: band.enabled,
        frequency: band.frequency,
        q: band.q,
        gain: band.gain,
      })),
    ),
  });
}
