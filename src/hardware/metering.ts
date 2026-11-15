import type { PanelStatus } from './codec';

export const METER_MIN_DB = -72;
export const METER_MAX_DB = 18;
export const METER_ZERO_DB = 20 * Math.log10(1 / 4096);

export interface PanelMetering {
  inputPeakDb: number | null;
  outputPeakDb: number | null;
  actualSampleRateHz: number;
  outputSuppressedByMute: boolean;
}

/** Aggregate FA503 status peaks, not three separate output-channel meters. */
export function decodeMetering(status: PanelStatus): PanelMetering {
  const raw = status.raw;
  if (raw.length !== 64 || raw[0] !== 5) throw new Error('Invalid metering status');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const db = (sample: number) => {
    // Native HFD treats exactly zero as one before log10. Negative signed
    // samples have no real logarithm; expose unavailable rather than inventing
    // an absolute-value meter or a silent zero level.
    return sample < 0 ? null : 20 * Math.log10((sample === 0 ? 1 : sample) / 4096);
  };
  const muted = !!(raw[6] & 128);
  return {
    inputPeakDb: db(view.getInt16(46, true)),
    outputPeakDb: muted ? METER_ZERO_DB : db(view.getInt16(48, true)),
    actualSampleRateHz: view.getUint16(44, true) * 100,
    outputSuppressedByMute: muted,
  };
}

export function meterDisplayDb(value: number | null): number | undefined {
  return value === null || !Number.isFinite(value)
    ? undefined
    : Math.max(METER_MIN_DB, Math.min(METER_MAX_DB, value));
}
