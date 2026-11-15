import { q24, roundEven } from '../domain/dsp';
/** Read-only decoded manufacturing/accessory fields; their numeric enums are retained. */
export interface HardwareOverview {
  systemSetup: number;
  oledCapable: boolean;
  amplifier: number;
  moduleType: number;
  product: number;
  thirdChannelEnabled: boolean;
  fanConnected: boolean;
  stereoDsp: boolean;
  temperatureSetpoint: number;
  dspPeakSetpoint: number;
  oledVersion: number;
  /** Native product EEPROM names, independent of the editable DSP filename. */
  productNames?: {
    hypexName: string;
    oemName: string;
    source: 'eeprom-0x120-0x140';
    encoding: 'native-printable-byte';
  };
}
export function decodeNativeProductNames(
  hypexName: Uint8Array,
  oemName: Uint8Array,
): NonNullable<HardwareOverview['productNames']> {
  const decode = (bytes: Uint8Array) => {
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32)
      throw new Error('Native product names require complete 32-byte EEPROM fields');
    let text = '';
    for (const byte of bytes) {
      if (byte < 0x20 || byte > 0x7f) break;
      text += String.fromCharCode(byte);
    }
    return text;
  };
  return {
    hypexName: decode(hypexName),
    oemName: decode(oemName),
    source: 'eeprom-0x120-0x140',
    encoding: 'native-printable-byte',
  };
}
export function decodeHardwareOverview(
  configuration: Uint8Array,
  deviceConfiguration: Uint8Array,
): HardwareOverview {
  if (
    configuration.length !== 64 ||
    configuration[0] !== 6 ||
    configuration[1] !== 22 ||
    configuration[2] !== 5 ||
    configuration[3] !== 1 ||
    deviceConfiguration.length !== 64 ||
    deviceConfiguration[0] !== 0x66 ||
    deviceConfiguration[10] !== 5 ||
    deviceConfiguration[12] !== 22
  )
    throw new Error('Hardware overview requires the recovered FA503 / DSP3-213 v5 protocol');
  const v = new DataView(
    deviceConfiguration.buffer,
    deviceConfiguration.byteOffset,
    deviceConfiguration.byteLength,
  );
  // Native 06 decoder 0xaa940e; 66 decoder 0xaa9ddd..0xaaa004.
  return {
    systemSetup: configuration[4],
    oledCapable: !!(configuration[4] & 0x10),
    amplifier: deviceConfiguration[10],
    moduleType: deviceConfiguration[11],
    product: deviceConfiguration[12],
    thirdChannelEnabled: deviceConfiguration[13] !== 0,
    fanConnected: !!(deviceConfiguration[14] & 1),
    stereoDsp: !!(deviceConfiguration[14] & 128),
    temperatureSetpoint: deviceConfiguration[15],
    dspPeakSetpoint: v.getInt16(16, true),
    oledVersion: v.getUint16(18, true),
  };
}
export interface LimiterChannel {
  watts: number;
  ohms: number;
  attackMs: number;
  releaseMs: number;
}
export interface LimiterConfiguration {
  raw: Uint8Array;
  amplifier: number;
  channels: (LimiterChannel & { threshold: number; attack: number; release: number })[];
}
export function decodeLimiter(raw: Uint8Array): LimiterConfiguration {
  if (raw.length !== 64 || raw[0] !== 0x66 || raw[12] !== 22 || raw[10] !== 5)
    throw new Error('Limiter requires FA503 amplifier configuration 5');
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return {
    raw: raw.slice(),
    amplifier: raw[10],
    channels: [0, 1, 2].map((i) => {
      const attack = v.getInt32(32 + 4 * i, true) / 2 ** 24,
        release = v.getInt32(44 + 4 * i, true) / 2 ** 24;
      return {
        threshold: v.getInt32(20 + 4 * i, true) / 2 ** 24,
        attack,
        release,
        watts: raw[59 + i] * 5,
        ohms: raw[56 + i] / 10,
        attackMs: 0.025 / (1 - attack),
        releaseMs: 5 + 0.0048 / (1 - release),
      };
    }),
  };
}
export function limiterThreshold(channel: number, watts: number, ohms: number, bridged: boolean) {
  const vrms = Math.sqrt(watts * ohms);
  return channel < 2
    ? (((vrms / 18.836490894898006) * (bridged ? 0.5 : 1) * 1.075) / 2.81) * 0.707 * 10
    : (((vrms / 9.440608762859235) * 1.1) / 3.05) * 0.707 * 10;
}
export function encodeLimiter(
  original: LimiterConfiguration,
  channels: LimiterChannel[],
  bridged: boolean,
) {
  if (channels.length !== 3) throw new Error('Expected three limiter channels');
  const raw = original.raw.slice(),
    v = new DataView(raw.buffer);
  raw[1] = 1;
  channels.forEach((c, i) => {
    if (
      ![c.watts, c.ohms, c.attackMs, c.releaseMs].every(Number.isFinite) ||
      c.watts < 5 ||
      c.watts > 1275 ||
      c.ohms < 0.1 ||
      c.ohms > 25.5 ||
      c.attackMs <= 0 ||
      c.releaseMs <= 5
    )
      throw new Error('Invalid limiter power, impedance or timing');
    const power = roundEven(c.watts / 5) * 5,
      ohms = roundEven(c.ohms * 10) / 10;
    const threshold = limiterThreshold(i, power, ohms, bridged),
      attack = Math.max(0.9, Math.min(0.99995, 1 - 0.025 / c.attackMs)),
      release = Math.max(0.9, Math.min(0.99995, 1 - 0.0048 / (c.releaseMs - 5)));
    v.setInt32(20 + 4 * i, q24(threshold), true);
    v.setInt32(32 + 4 * i, q24(attack), true);
    v.setInt32(44 + 4 * i, q24(release), true);
    raw[56 + i] = roundEven(ohms * 10);
    raw[59 + i] = roundEven(power / 5);
  });
  return raw;
}
export interface PowerStatistics {
  mode: 'standby' | 'low-power' | 'on';
  acTimer: number;
  dspTimer: number;
  switchCount: number;
  noSignalTimer: number;
  noSignalActive: boolean;
}
export function decodePower(raw: Uint8Array): PowerStatistics {
  if (raw.length !== 64 || raw[0] !== 8 || !(raw[1] & 128) || raw[15] > 2)
    throw new Error('Invalid power statistics');
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return {
    mode: (['standby', 'low-power', 'on'] as const)[raw[15]],
    acTimer: v.getUint32(2, true),
    dspTimer: v.getUint32(6, true),
    switchCount: v.getUint16(10, true),
    noSignalTimer: v.getUint16(16, true),
    noSignalActive: !!raw[18],
  };
}
