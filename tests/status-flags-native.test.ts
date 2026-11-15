import { describe, expect, it } from 'vitest';
import { control, decodeStatus, packet } from '../src/hardware/codec';
import { decodeProtection } from '../src/hardware/protection';
import { decodeStatusFlags } from '../src/hardware/status-flags';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';

// Independent native host fixtures. aa8201..aa8238 reads buffer[0x34],
// including the report-ID byte. TControlRecord fields +24/+25 are password
// protected/matched; their stores use masks 02/04. Mask01 is signal detected.
// These literals deliberately do not come from the browser decoder/simulator.
describe('native FA503 status flag positions', () => {
  it.each([
    ['no flags', 0x00, false, false, false],
    ['signal only', 0x01, false, false, false],
    ['protected without signal', 0x02, true, false, true],
    ['signal and protected', 0x03, true, false, true],
    ['matched without password', 0x04, false, true, false],
    ['signal and matched', 0x05, false, true, false],
    ['protected and matched', 0x06, true, true, false],
    ['all three', 0x07, true, true, false],
    ['protected with signal lost', 0x0a, true, false, true],
  ] as const)('%s', (_name, flags, passwordProtected, passwordMatched, locked) => {
    const raw = packet(5, 6, 1);
    raw[51] = flags;
    const status = decodeStatus(raw),
      protection = decodeProtection(status, 0);
    expect(status.locked).toBe(locked);
    expect(protection).toMatchObject({ passwordProtected, passwordMatched, locked });
  });

  it('signal alone cannot cause a password refusal, and signal plus protection cannot unlock settings', () => {
    const raw = packet(5, 6, 1);
    raw[51] = 0x01;
    expect(() => control(decodeStatus(raw), { wakeOnLine: true }, 0)).not.toThrow();
    for (const flags of [0x02, 0x03]) {
      raw[51] = flags;
      expect(() => control(decodeStatus(raw), { wakeOnLine: true }, 0)).toThrow(/password locked/);
    }
  });

  it('keeps signal/loss flags separate when a synthetic verification sets or clears the matched bit', async () => {
    const panel = new SimulatedPanel('NATIVE-FLAG-FIXTURE'),
      session = new PanelSession(panel, async () => {}),
      credential = new TextEncoder().encode('fixture-only'),
      target = { serial: panel.serial, product: 22, core: '5.1', firmware: '5.7' };
    panel.eeprom.set(credential, 0x20);
    panel.status[51] = 0x0b;
    const original = panel.eeprom.slice();
    await session.verifyPassword(target, credential);
    expect(panel.status[51]).toBe(0x0f);
    await expect(
      session.verifyPassword(target, new TextEncoder().encode('wrong-fixture')),
    ).rejects.toThrow();
    expect(panel.status[51]).toBe(0x0b);
    expect(decodeStatusFlags(panel.status)).toEqual({
      signalDetected: true,
      signalLostDetected: true,
      passwordProtected: true,
      passwordMatched: false,
      locked: true,
    });
    expect(panel.eeprom).toEqual(original);
    expect(panel.passwordWrites + panel.emailWrites + panel.writes).toBe(0);
  });

  it('rejects invalid status buffers before reading flags', () => {
    expect(() => decodeStatusFlags(new Uint8Array(63))).toThrow(/status flags/);
    expect(() => decodeStatusFlags(packet(4))).toThrow(/status flags/);
  });
});
