import { expect, it } from 'vitest';
import { dspPowerOffAvailability } from '../src/hardware/power-availability';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';

it.each([undefined, '5.7', '5.82', '6.0', '5.07'])(
  'does not qualify OFF for firmware%s or expose a caller override',
  (version) => {
    const capability = dspPowerOffAvailability(version);
    expect(capability.available).toBe(false);
    expect(capability.reason).toContain('DSP off is unavailable');
    if (version === '5.7') expect(capability.reason).toContain('caused USB loss');
    else expect(capability.reason).toContain('has not been qualified');
  },
);

it.each([7, 82, 99])(
  'blocks firmware5.%s OFF before any status, mute, power or flash transaction',
  async (minor) => {
    const panel = new SimulatedPanel(),
      session = new PanelSession(panel, async () => {});
    new DataView(panel.configuration.buffer).setUint16(17, minor, true);
    await session.identify();
    panel.requests.length = 0;
    const status = panel.status.slice(),
      memory = panel.memory.slice(),
      eeprom = panel.eeprom.slice();
    await expect(session.setPower(false)).rejects.toThrow('DSP off is unavailable');
    expect(panel.requests).toHaveLength(0);
    expect(panel.status).toEqual(status);
    expect(panel.memory).toEqual(memory);
    expect(panel.eeprom).toEqual(eeprom);
    expect(panel.powerMode).toBe(2);
    expect(session.busy).toBe(false);
  },
);

it('blocks an unidentified session without probing or guessing its firmware', async () => {
  const panel = new SimulatedPanel(),
    session = new PanelSession(panel, async () => {});
  await expect(session.setPower(false)).rejects.toThrow('has not been qualified');
  expect(panel.requests).toHaveLength(0);
});

it('leaves explicit ON and idempotent state reading intact in the source-only simulator while never issuing OFF', async () => {
  const panel = new SimulatedPanel(),
    session = new PanelSession(panel, async () => {});
  await session.identify();
  panel.requests.length = 0;
  panel.powerMode = 0;
  const memory = panel.memory.slice(),
    eeprom = panel.eeprom.slice();
  expect((await session.setPower(true)).mode).toBe('on');
  expect(panel.requests.filter((request) => request[0] === 8 && request[1] === 1)).toHaveLength(1);
  expect(panel.requests.some((request) => request[0] === 8 && request[1] === 0)).toBe(false);
  expect(session.lastStatus!.muted).toBe(true);
  expect(panel.memory).toEqual(memory);
  expect(panel.eeprom).toEqual(eeprom);
  panel.requests.length = 0;
  expect((await session.setPower(true)).mode).toBe('on');
  expect(panel.requests.filter((request) => request[0] === 8).map((request) => request[1])).toEqual(
    [128],
  );
});
