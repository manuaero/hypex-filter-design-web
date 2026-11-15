/** FA503 05 payload byte51. The native RX buffer includes a report-ID byte:
 * aa8201..aa8238 reads buffer[0x34]. Bit0 is signal, NOT password protection.
 * Native IIR access checks c4f19f/c4f1b9 consume the bit1/bit2 stores. */
export const STATUS_FLAGS = Object.freeze({
  signalDetected: 0x01,
  passwordProtected: 0x02,
  passwordMatched: 0x04,
  signalLostDetected: 0x08,
});

export function decodeStatusFlags(raw: Uint8Array) {
  if (raw.length !== 64 || raw[0] !== 5) throw new Error('Invalid panel status flags');
  const flags = raw[51],
    passwordProtected = !!(flags & STATUS_FLAGS.passwordProtected),
    passwordMatched = !!(flags & STATUS_FLAGS.passwordMatched);
  return {
    signalDetected: !!(flags & STATUS_FLAGS.signalDetected),
    signalLostDetected: !!(flags & STATUS_FLAGS.signalLostDetected),
    passwordProtected,
    passwordMatched,
    locked: passwordProtected && !passwordMatched,
  };
}
