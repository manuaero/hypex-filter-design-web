import { expect, it } from 'vitest';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import {
  getRotatingNoiseState,
  preflightRotatingNoise,
  setRotatingNoise,
} from '../src/hardware/noise';
import type { Transport } from '../src/hardware/transport';

const session = (transport: Transport) => new PanelSession(transport, async () => {});
const actions = (panel: SimulatedPanel) => panel.requests.filter((r) => r[0] === 8 && r[1] === 30);

it('preflights the exact normal FA503 without producing a noise, power or settings write', async () => {
  const panel = new SimulatedPanel('NOISE-LEFT'),
    amp = session(panel);
  expect(await preflightRotatingNoise(amp)).toEqual({
    serial: 'NOISE-LEFT',
    product: 22,
    core: '5.1',
    firmware: '5.7',
  });
  expect(getRotatingNoiseState(amp)).toEqual({ requested: null, acknowledgement: 'none' });
  expect(panel.requests.some((r) => r[0] === 8 || (r[0] === 5 && r[1] === 0))).toBe(false);
  expect(panel.writes).toBe(0);
});

it('matches independent native 08/1e/bool fixtures and keeps ordinary controls/flash unchanged', async () => {
  const panel = new SimulatedPanel(),
    amp = session(panel),
    before = {
      status: panel.status.slice(),
      memory: panel.memory.slice(),
      eeprom: panel.eeprom.slice(),
      mode: panel.powerMode,
    };
  // cbNoiseChange bypasses OEM mask checks, just like the recovered host callback.
  panel.status[51] = 2;
  panel.status[24] = panel.status[25] = 0;
  before.status = panel.status.slice();
  const on = await setRotatingNoise(amp, true);
  expect(Array.from(actions(panel)[0])).toEqual([8, 30, 1, ...Array(61).fill(0)]);
  expect(on).toMatchObject({ requested: true, acknowledged: true, actualState: 'unavailable' });
  expect(on.status?.raw).toEqual(before.status);
  expect(panel.noiseRequested).toBe(true);
  expect(getRotatingNoiseState(amp)).toEqual({ requested: true, acknowledgement: 'accepted' });
  const off = await setRotatingNoise(amp, false, on.identity);
  expect(Array.from(actions(panel)[1])).toEqual([8, 30, 0, ...Array(61).fill(0)]);
  expect(off).toMatchObject({ requested: false, acknowledged: true, actualState: 'unavailable' });
  expect(panel.noiseRequested).toBe(false);
  expect(panel.status).toEqual(before.status);
  expect(panel.memory).toEqual(before.memory);
  expect(panel.eeprom).toEqual(before.eeprom);
  expect(panel.powerMode).toBe(before.mode);
  expect(panel.writes).toBe(0);
  expect(panel.requests.some((r) => r[0] === 5 && r[1] === 0)).toBe(false);
});

it('refuses a changed identity before sending an action or changing request state', async () => {
  const panel = new SimulatedPanel('REPLACED'),
    amp = session(panel);
  await expect(
    setRotatingNoise(amp, true, { serial: 'ORIGINAL', product: 22, core: '5.1', firmware: '5.7' }),
  ).rejects.toThrow('identity changed');
  expect(actions(panel)).toHaveLength(0);
  expect(getRotatingNoiseState(amp)).toEqual({ requested: null, acknowledgement: 'none' });
});

it.each([0, 14])(
  'does not confuse rejected/raw-enum ACK %s with a successful request or retry it',
  async (wireCommand) => {
    const panel = new SimulatedPanel();
    const transport: Transport = {
      close: () => panel.close(),
      exchange: async (request) => {
        const reply = await panel.exchange(request);
        if (request[0] === 8) {
          reply[0] = wireCommand === 0 ? 8 : wireCommand;
          reply[1] = wireCommand === 0 ? 0 : 1;
        }
        return reply;
      },
    };
    const amp = session(transport);
    await expect(setRotatingNoise(amp, true)).rejects.toThrow('unconfirmed');
    expect(actions(panel)).toHaveLength(1);
    expect(getRotatingNoiseState(amp)).toEqual({ requested: true, acknowledgement: 'unconfirmed' });
  },
);

it('retains the exact ACK result if the following status read fails and issues no automatic retry', async () => {
  const panel = new SimulatedPanel();
  let acknowledged = false;
  const transport: Transport = {
    close: () => panel.close(),
    exchange: async (request) => {
      if (acknowledged && request[0] === 5) throw new Error('Status connection lost');
      const reply = await panel.exchange(request);
      if (request[0] === 8) acknowledged = true;
      return reply;
    },
  };
  const amp = session(transport),
    result = await setRotatingNoise(amp, false);
  expect(result).toMatchObject({
    acknowledged: true,
    requested: false,
    actualState: 'unavailable',
    statusError: 'Status connection lost',
  });
  expect(result.status).toBeUndefined();
  expect(actions(panel)).toHaveLength(1);
  expect(getRotatingNoiseState(amp)).toEqual({ requested: false, acknowledgement: 'accepted' });
});

it('validates explicit request/identity inputs before transport access and rejects unsupported hardware', async () => {
  const panel = new SimulatedPanel(),
    amp = session(panel);
  await expect(setRotatingNoise(amp, 1 as unknown as boolean)).rejects.toThrow('boolean');
  await expect(
    setRotatingNoise(amp, true, { serial: 'x', product: 23, core: '5.1', firmware: '5.7' }),
  ).rejects.toThrow('FA503');
  expect(panel.requests).toHaveLength(0);
  panel.configuration[1] = 23;
  await expect(setRotatingNoise(amp, true)).rejects.toThrow('FA503');
  expect(actions(panel)).toHaveLength(0);
});

it('serializes explicit Start and Stop within the existing session queue', async () => {
  const panel = new SimulatedPanel(),
    amp = session(panel);
  await Promise.all([setRotatingNoise(amp, true), setRotatingNoise(amp, false)]);
  expect(actions(panel).map((r) => r[2])).toEqual([1, 0]);
  expect(panel.maxConcurrent).toBe(1);
  expect(getRotatingNoiseState(amp)).toEqual({ requested: false, acknowledgement: 'accepted' });
});
