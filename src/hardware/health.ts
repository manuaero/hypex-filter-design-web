import type { PanelStatus } from './codec';
import { decodeStatusFlags } from './status-flags';

/** Read-only TFAHealthStatus fields from the recovered FA503 05 reply.
 * Native aa8496..aa86ae; RTTI9a50f4 and TControlRecord9a5894. */
export function decodeHealth(status: PanelStatus) {
  const raw = status.raw,
    signals = decodeStatusFlags(raw),
    view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength),
    bit = (offset: number, mask: number) => !!(raw[offset] & mask);
  return {
    audioInput: raw[50],
    ...signals,
    temperatures: [view.getInt8(55), view.getInt8(56)] as [number, number],
    actualVolumeDb: view.getInt16(52, true) / 100,
    fanOutput: raw[54],
    subInputLevelDb: view.getInt16(61, true) / 100,
    errors: {
      temperatureSensorFailure: bit(57, 0x01),
      temperatureTooHigh: bit(57, 0x02),
      auxiliaryVoltageOutOfRange: bit(57, 0x04),
      dcError: bit(57, 0x08),
      powerFailure: bit(57, 0x10),
      i2cBusError: bit(57, 0x20),
      srcI2cError: bit(57, 0x40),
    },
    warnings: {
      temperature: bit(58, 0x01),
      analogClipping: bit(58, 0x02),
      amplifierClipping: bit(58, 0x04),
    },
    state: {
      amplifierEnabled: bit(59, 0x02),
      deviceJustBooted: bit(59, 0x04),
      passwordMatchedHfd: bit(59, 0x08),
      previousButtonPressed: bit(59, 0x10),
      signalDetected: bit(59, 0x20),
      signalPending: bit(59, 0x40),
      signalLostPending: bit(59, 0x80),
      filtersUpdating: bit(60, 0x01),
      dspSwitchOff: bit(60, 0x02),
      testsEnabled: bit(60, 0x04),
      standbyPending: bit(60, 0x08),
      systemUnhealthy: bit(60, 0x10),
      signalDetectedChanged: bit(60, 0x20),
    },
    unrecognizedBits: {
      signal: raw[51] & 0xf0,
      errors: raw[57] & 0x80,
      warnings: raw[58] & 0xf8,
      state1: raw[59] & 0x01,
      state2: raw[60] & 0xc0,
    },
  };
}
export type PanelHealth = ReturnType<typeof decodeHealth>;
