import { roundEven, q24, design, stable } from '../domain/dsp';
import type { Filter } from '../domain/model';
import { assertOperationAllowed, requiredControlOperations } from './protection';
import { decodeStatusFlags } from './status-flags';
import { isInputSource } from './input-sources';
export const VID = 0x345e,
  PID = 0x03e8,
  SECTOR = 4096;
export const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function unhex(s: string) {
  if (!/^(?:[a-f\d]{2})*$/i.test(s)) throw new Error('Invalid hexadecimal data');
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
}
export function packet(command: number, ...body: number[]) {
  if (body.length > 63) throw new Error('Packet too large');
  const b = new Uint8Array(64);
  b.set([command, ...body]);
  return b;
}
export const addr = (a: number) => {
  if (!Number.isInteger(a) || a < 0 || a > 0xffffff) throw new Error('Invalid address');
  return [a & 255, (a >> 8) & 255, (a >> 16) & 255];
};
export function presetBase(p: number) {
  if (![1, 2, 3].includes(p)) throw new Error('Invalid preset');
  return 0x21000 + p * 4096;
}
export interface PanelStatus {
  raw: Uint8Array;
  preset: number;
  volume: number;
  muted: boolean;
  channelMutes: boolean[];
  input: number;
  locked: boolean;
}
export function decodeStatus(raw: Uint8Array): PanelStatus {
  if (raw.length !== 64 || raw[0] !== 5 || ![1, 2, 3].includes(raw[2]))
    throw new Error('Invalid panel status');
  return {
    raw: raw.slice(),
    preset: raw[2],
    volume: new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getInt16(3, true) / 100,
    muted: !!(raw[6] & 128),
    channelMutes: [0, 1, 2].map((i) => !!(raw[6] & (1 << i))),
    input: raw[1],
    locked: decodeStatusFlags(raw).locked,
  };
}
export interface Controls {
  mute?: boolean;
  volume?: number;
  preset?: number;
  channelMutes?: boolean[];
  /** One output intent, merged into the fresh status inside the session reservation. */
  outputMute?: { channel: number; muted: boolean };
  routing?: number;
  forceInput?: number;
  eqEnabled?: boolean;
  presetEq?: { preset: number; enabled: boolean };
  presetFir?: { preset: number; flags: number; placement: number };
  presetOffsets?: number[];
  startupVolume?: number | null;
  powerOffMinutes?: number;
  standbyMode?: 0 | 1;
  signalDetection?: boolean;
  bridge?: boolean;
  master?: boolean;
  wakeOnLine?: boolean;
  softClip?: boolean;
  subAbsolute?: boolean;
  analogGainXlr?: boolean;
  analogGainRca?: boolean;
  dacFilter?: number;
  soundQuality?: number;
  firMode?: number;
  sourceLock?: boolean;
  volumeLock?: boolean;
  adcOutput?: boolean;
  detectionOn?: number;
  detectionOff?: number;
  oledMaximumBrightness?: number;
  oledDimmedBrightness?: number;
  /** Native selection: 0 OFF, 1 100%, 2 50%, 3 25%. */
  standbyLedMode?: 0 | 1 | 2 | 3;
}
export function hasDisplayControls(patch: Controls): boolean {
  return (
    patch.oledMaximumBrightness !== undefined ||
    patch.oledDimmedBrightness !== undefined ||
    patch.standbyLedMode !== undefined
  );
}
export function settings(status: PanelStatus) {
  const b = status.raw,
    v = new DataView(b.buffer, b.byteOffset, b.byteLength),
    options = v.getUint16(9, true),
    startupVolume = v.getInt16(21, true) / 100,
    p = 11 + status.preset;
  return {
    presetOffsets: [15, 17, 19].map((o) => v.getInt16(o, true) / 100),
    startupVolume,
    startupVolumeEnabled: startupVolume > -100,
    powerOffMinutes: b[8],
    standbyMode: b[7],
    signalDetection: !!(options & 1),
    bridge: !!(options & 2),
    master: !(options & 4),
    wakeOnLine: !!(options & 8),
    softClip: !!(options & 16),
    subAbsolute: !!(options & 32),
    analogGainXlr: !!(options & 64),
    analogGainRca: !!(options & 128),
    // Literal HFD cbAddGain1/2 readouts (0xc1862c/0xc1878c), not an inferred gain formula.
    maximumAnalogXlrVrms: options & 64 ? 2.18 : 6.15,
    maximumAnalogRcaVrms: options & 128 ? 0.98 : 2.18,
    // Native lblIRRemote follows Master; this is not proof of an attached receiver.
    irRemoteMasterIndicator: !(options & 4),
    dacFilter: (options >> 8) & 7,
    soundQuality: ((options >> 11) & 3) + 1,
    firMode: (options >> 13) & 7,
    sourceLock: !!(b[p] & 128),
    volumeLock: !!(b[p] & 32),
    adcOutput: !!(b[p] & 64),
    detectionOn: b[27] & 3,
    detectionOff: (b[27] >> 2) & 3,
    oledMaximumBrightness: b[35] >> 4,
    oledDimmedBrightness: b[35] & 15,
    standbyLedMode: (b[36] & 3) as 0 | 1 | 2 | 3,
  };
}
export function control(status: PanelStatus, patch: Controls, moduleType?: number) {
  if (Object.hasOwn(patch, 'outputMute')) {
    const intent = patch.outputMute;
    if (
      Object.keys(patch).length !== 1 ||
      !intent ||
      typeof intent !== 'object' ||
      Array.isArray(intent) ||
      Object.keys(intent).length !== 2 ||
      !Object.hasOwn(intent, 'channel') ||
      !Object.hasOwn(intent, 'muted') ||
      !Number.isInteger(intent.channel) ||
      intent.channel < 1 ||
      intent.channel > 3 ||
      typeof intent.muted !== 'boolean'
    )
      throw new Error('outputMute requires only channel 1–3 and muted, as a separate intent');
  }
  for (const operation of requiredControlOperations(patch))
    assertOperationAllowed(status, operation, moduleType);
  const b = packet(5);
  for (const i of [
    2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 25, 27, 28, 29, 30,
    31, 35, 36,
  ])
    b[i] = status.raw[i];
  b[36] &= 0xfb;
  if (patch.mute !== undefined) b[6] = (b[6] & 127) | (patch.mute ? 128 : 0);
  if (patch.volume !== undefined) {
    if (!Number.isFinite(patch.volume) || patch.volume < -96 || patch.volume > 18)
      throw new Error('Volume must be −96…18 dB');
    new DataView(b.buffer).setInt16(3, roundEven(patch.volume * 100), true);
  }
  if (patch.preset !== undefined) {
    presetBase(patch.preset);
    b[2] = patch.preset;
  }
  if (patch.channelMutes) {
    if (patch.channelMutes.length !== 3) throw new Error('Expected three mute bits');
    b[6] = (b[6] & 0xf8) | patch.channelMutes.reduce((x, m, i) => x | (m ? 1 << i : 0), 0);
  }
  if (patch.outputMute) {
    const mask = 1 << (patch.outputMute.channel - 1);
    b[6] = (b[6] & ~mask) | (patch.outputMute.muted ? mask : 0);
  }
  if (patch.routing !== undefined) {
    if (![0, 1, 2, 3, 4].includes(patch.routing)) throw new Error('Invalid routing');
    b[11] = (b[11] & 0xf8) | patch.routing;
  }
  if (patch.forceInput !== undefined) {
    if (!isInputSource(patch.forceInput)) throw new Error('Invalid source');
    b[11 + b[2]] = (b[11 + b[2]] & 0xf0) | patch.forceInput;
  }
  if (patch.eqEnabled !== undefined)
    b[11 + b[2]] = (b[11 + b[2]] & 0xef) | (patch.eqEnabled ? 16 : 0);
  if (patch.presetEq) {
    presetBase(patch.presetEq.preset);
    const i = 11 + patch.presetEq.preset;
    b[i] = (b[i] & 0xef) | (patch.presetEq.enabled ? 16 : 0);
  }
  if (patch.presetFir) {
    const f = patch.presetFir;
    presetBase(f.preset);
    if (!Number.isInteger(f.flags) || f.flags < 0 || f.flags > 255 || ![0, 1].includes(f.placement))
      throw new Error('Invalid FIR activation');
    b[27 + f.preset] = f.flags;
    b[31] = (b[31] & ~(1 << (f.preset - 1))) | (f.placement << (f.preset - 1));
  }
  const v = new DataView(b.buffer);
  let options = v.getUint16(9, true);
  for (const [key, bit, inverse] of [
    ['signalDetection', 0, false],
    ['bridge', 1, false],
    ['master', 2, true],
    ['wakeOnLine', 3, false],
    ['softClip', 4, false],
    ['subAbsolute', 5, false],
    ['analogGainXlr', 6, false],
    ['analogGainRca', 7, false],
  ] as const) {
    const value = patch[key];
    if (value !== undefined)
      options = (options & ~(1 << bit)) | ((inverse ? !value : value) ? 1 << bit : 0);
  }
  for (const [key, shift, mask, offset] of [
    ['dacFilter', 8, 7, 0],
    ['soundQuality', 11, 3, 1],
    ['firMode', 13, 7, 0],
  ] as const) {
    const value = patch[key];
    if (value !== undefined) {
      if (!Number.isInteger(value) || value < offset || value > mask + offset)
        throw new Error(`Invalid ${key}`);
      options = (options & ~(mask << shift)) | ((value - offset) << shift);
    }
  }
  v.setUint16(9, options, true);
  if (patch.master === true) for (const i of [12, 13, 14]) b[i] &= 0x5f;
  for (const [key, mask] of [
    ['sourceLock', 128],
    ['volumeLock', 32],
    ['adcOutput', 64],
  ] as const) {
    const value = patch[key];
    if (value !== undefined) {
      if (key !== 'adcOutput' && !(options & 4))
        throw new Error('Source and volume lock require slave mode');
      b[11 + b[2]] = (b[11 + b[2]] & ~mask) | (value ? mask : 0);
    }
  }
  if (patch.presetOffsets) {
    if (patch.presetOffsets.length !== 3) throw new Error('Expected three preset offsets');
    patch.presetOffsets.forEach((value, i) => {
      if (!Number.isFinite(value) || value < -24 || value > 24)
        throw new Error('Preset offset must be −24…24 dB');
      v.setInt16(15 + i * 2, roundEven(value * 100), true);
    });
  }
  if (patch.startupVolume !== undefined) {
    const value = patch.startupVolume === null ? -200 : patch.startupVolume;
    if (!Number.isFinite(value) || (value !== -200 && (value < -96 || value > 18)))
      throw new Error('Invalid startup volume');
    v.setInt16(21, roundEven(value * 100), true);
  }
  if (patch.powerOffMinutes !== undefined) {
    if (
      !Number.isInteger(patch.powerOffMinutes) ||
      patch.powerOffMinutes < 0 ||
      patch.powerOffMinutes > 255
    )
      throw new Error('Invalid auto-off time');
    b[8] = patch.powerOffMinutes;
  }
  if (patch.standbyMode !== undefined) {
    if (![0, 1].includes(patch.standbyMode)) throw new Error('Invalid standby mode');
    b[7] = patch.standbyMode;
  }
  if (patch.detectionOn !== undefined || patch.detectionOff !== undefined) {
    const on = patch.detectionOn ?? b[27] & 3,
      requestedOff = patch.detectionOff ?? (b[27] >> 2) & 3;
    if (
      !Number.isInteger(on) ||
      !Number.isInteger(requestedOff) ||
      on < 0 ||
      on > 3 ||
      requestedOff < 0 ||
      requestedOff > 3
    )
      throw new Error('Detection thresholds must be 0–3');
    // Native cbDetectionLevelChange 0xc18984 clamps OFF down to ON before sending.
    b[27] = (Math.min(requestedOff, on) << 2) | on;
    b[23] |= 4;
  }
  // HFD SetUIBrightness 0xaa1740 and serializer 0xaa6675..0xaa66ac.
  // RX byte23 is not a writable trigger template; only explicit changes set bit3.
  for (const [key, shift] of [
    ['oledMaximumBrightness', 4],
    ['oledDimmedBrightness', 0],
  ] as const) {
    const value = patch[key];
    if (value !== undefined) {
      if (!Number.isInteger(value) || value < 0 || value > 15)
        throw new Error(`${key} must be an integer from 0 to 15`);
      b[35] = (b[35] & ~(15 << shift)) | (value << shift);
      b[23] |= 8;
    }
  }
  if (patch.standbyLedMode !== undefined) {
    if (!Number.isInteger(patch.standbyLedMode) || ![0, 1, 2, 3].includes(patch.standbyLedMode))
      throw new Error('Standby LED mode must be 0 OFF, 1 100%, 2 50% or 3 25%');
    b[36] = (b[36] & 0xfc) | patch.standbyLedMode;
    b[23] |= 8;
  }
  if (patch.master === false) {
    // Native cbMasterUnitChange 0xc18a04: Slave clears these dependent settings.
    // Apply after explicit child fields so a composite patch cannot bypass the native coupling.
    v.setUint16(9, v.getUint16(9, true) & ~9, true);
    b[7] = 0;
    v.setInt16(21, -20000, true);
  }
  return b;
}
export function allowedSector(base: number) {
  return Number.isInteger(base) && base % 4096 === 0 && base >= 0x10000 && base <= 0x27000;
}
export function erase(base: number) {
  if (!allowedSector(base)) throw new Error('Address is outside recovered filter sectors');
  return packet(0x64, 4, ...addr(base), 1);
}
export function pagePackets(base: number, data: Uint8Array) {
  if (base % 256 || data.length !== 256 || !allowedSector(base & ~4095))
    throw new Error('Invalid page');
  return [
    packet(0x64, 0, ...addr(base), 1),
    ...Array.from({ length: 8 }, (_, i) => packet(0x64, 1, 32, ...data.slice(i * 32, i * 32 + 32))),
    packet(0x64, 2, 0),
  ];
}
export function crc16(data: Uint8Array) {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}
export function encodeEq(bands: Filter[]) {
  if (bands.length !== 9) throw new Error('Input EQ requires nine bands');
  const bytes = new Uint8Array(256).fill(255),
    v = new DataView(bytes.buffer);
  bands.forEach((f, i) => {
    if (!['peak', 'lowshelf2', 'highshelf2', 'unity'].includes(f.kind))
      throw new Error('Input EQ supports peak, low shelf and high shelf');
    const c = design(f),
      quant = Object.fromEntries(
        Object.entries(c).map(([k, v]) => [k, q24(v) / 2 ** 24]),
      ) as typeof c;
    if (!stable(c) || !stable(quant)) throw new Error('Input EQ is unstable after quantization');
    [c.b2, c.b1, c.b0, c.f2, c.f1].forEach((x, j) => v.setInt32(i * 20 + j * 4, q24(x), true));
    const o = 180 + i * 8,
      t = f.kind === 'lowshelf2' ? 1 : f.kind === 'highshelf2' ? 2 : 0;
    bytes[o] = t | (f.enabled ? 128 : 0);
    const freq = roundEven(f.frequency * 100),
      q = roundEven(f.q * 1000),
      g = roundEven(f.gain * 1000);
    // Native ab0da8/ab0ef3 reads Q as signed16. Refuse a positive
    // rounded word that would become negative when the panel page is read.
    if (freq < 0 || freq > 0xffffff || q < 0 || q > 32767 || g < -32768 || g > 32767)
      throw new Error('Input EQ metadata exceeds device range');
    bytes.set(addr(freq), o + 1);
    v.setUint16(o + 4, q, true);
    v.setInt16(o + 6, g, true);
  });
  v.setUint16(254, crc16(bytes.slice(0, 254)), true);
  return bytes;
}
export function decodeEq(bytes: Uint8Array): Filter[] {
  if (bytes.length < 256) throw new Error('Incomplete EQ page');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    empty =
      bytes.slice(0, 256).every((x) => x === 255) || bytes.slice(0, 256).every((x) => x === 0);
  if (!empty && v.getUint16(254, true) !== crc16(bytes.slice(0, 254)))
    throw new Error('Input EQ CRC mismatch');
  return Array.from({ length: 9 }, (_, i) => {
    const o = 180 + i * 8,
      uninitialized = empty || bytes.slice(o, o + 4).every((x) => x === 255);
    const f: Filter = {
      id: crypto.randomUUID(),
      kind: 'peak',
      enabled: false,
      frequency: [50, 100, 200, 500, 1000, 2000, 5000, 10000, 16000][i],
      q: 0.707,
      gain: 0,
      frequency2: 2000,
      q2: 0.707,
    };
    if (uninitialized) return f;
    const kind = ['peak', 'lowshelf2', 'highshelf2'][bytes[o] & 7] as Filter['kind'];
    if (!kind) throw new Error('Unsupported EQ metadata type');
    const a = Array.from({ length: 5 }, (_, j) => v.getInt32(i * 20 + j * 4, true) / 2 ** 24),
      frequency = bytes[o + 1] + (bytes[o + 2] << 8) + (bytes[o + 3] << 16),
      q = v.getInt16(o + 4, true);
    return {
      ...f,
      kind,
      enabled: !!(bytes[o] & 128),
      // Native ab0e9a..ec8 and ab0f13..2c substitute defaults only for
      // exact-zero metadata. Preserve the original compiled panel response.
      frequency: frequency === 0 ? f.frequency : frequency / 100,
      q: q === 0 ? f.q : q / 1000,
      gain: v.getInt16(o + 6, true) / 1000,
      provenance: 'panel',
      coefficients: { b2: a[0], b1: a[1], b0: a[2], f2: a[3], f1: a[4] },
    };
  });
}
