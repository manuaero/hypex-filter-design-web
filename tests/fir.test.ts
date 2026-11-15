import { it, expect } from 'vitest';
import { newProject } from '../src/domain/model';
import { PanelSession, type Backup } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { uploadFir, readFir, restoreFir, encodeFir, type FirBackup } from '../src/hardware/fir';
import { decodeStatus, hex, encodeEq, decodeEq } from '../src/hardware/codec';
const save = async (_: Backup) => {};
it('serializes FIR in reverse order and rejects overflow before a device write', () => {
  expect(new DataView(encodeFir([0.25, -0.5, 1], 3).buffer).getInt32(0, true)).toBe(2 ** 24);
  expect(() => encodeFir([128], 1)).toThrow('range');
  expect(() => encodeFir([0], 1)).toThrow('nonzero');
});
it('preserves FIR tails, writes bypassed taps, and restores the entire manifest', async () => {
  const sim = new SimulatedPanel(),
    session = new PanelSession(sim, save),
    saved: FirBackup[] = [];
  sim.memory.set(
    Uint8Array.from({ length: 24576 }, (_, i) => i % 251),
    0x10000,
  );
  sim.eeprom.fill(77, 0x200, 0x280);
  sim.status[2] = 2;
  sim.status[28] = 0x52;
  sim.status[31] = 1;
  const original = sim.memory.slice(0x10000, 0x16000),
    names = sim.eeprom.slice(0x200, 0x280),
    p = newProject().presets[0];
  p.firPlacement = 'input';
  p.inputFir = {
    name: 'C:\\Filters\\test.txt',
    enabled: false,
    taps: Array.from({ length: 4500 }, (_, i) => (i === 0 ? 0.5 : i === 4499 ? 0.25 : 0)),
  };
  const backup = await uploadFir(
    session,
    1,
    p,
    () => {},
    async (b) => {
      saved.push(b);
    },
  );
  expect(saved).toHaveLength(1);
  expect(backup).toBeDefined();
  expect(sim.writes).toBe(5);
  expect(sim.memory.slice(0x10000 + 18000, 0x16000)).toEqual(original.slice(18000));
  expect(sim.status[28]).toBe(130);
  expect(sim.status[31] & 1).toBe(0);
  expect(sim.status[2]).toBe(2);
  expect(new TextDecoder().decode(sim.eeprom.slice(0x200, 0x220)).replace(/\0.*$/s, '')).toBe(
    'test.txt',
  );
  const read = await readFir(session, 1, async () => {});
  expect(read.placement).toBe('input');
  expect(read.filters[0].taps).toEqual(p.inputFir.taps);
  expect(read.filters[0].enabled).toBe(false);
  await restoreFir(
    session,
    backup!,
    () => {},
    async () => {},
  );
  expect(sim.memory.slice(0x10000, 0x16000)).toEqual(original);
  expect(sim.eeprom.slice(0x200, 0x280)).toEqual(names);
  expect(sim.status[28]).toBe(0x52);
  expect(sim.status[31] & 1).toBe(1);
  expect(decodeStatus(sim.status).muted).toBe(true);
  expect(sim.status[2]).toBe(2);
}, 20000);
it('programs distinct output banks without touching unloaded outputs', async () => {
  const sim = new SimulatedPanel(),
    session = new PanelSession(sim, save),
    p = newProject().presets[2];
  p.firPlacement = 'output';
  p.channels[2].fir = {
    name: 'tweeter.txt',
    enabled: true,
    taps: Array.from({ length: 1500 }, (_, i) => (i === 4 ? 1 : 0)),
  };
  await uploadFir(
    session,
    3,
    p,
    () => {},
    async () => {},
  );
  expect(sim.writes).toBe(2);
  expect(sim.memory.slice(0x1c000, 0x20000).every((b) => b === 255)).toBe(true);
  expect(sim.status[30]).toBe(0x44);
  expect(sim.status[31] & 4).toBe(4);
  const result = await readFir(session, 3, async () => {});
  expect(result.filters[2].taps).toEqual(p.channels[2].fir.taps);
  expect(result.filters[0].taps).toEqual([]);
}, 10000);
it('cancels FIR erase on persistence failure or incompatible DSP mode', async () => {
  const sim = new SimulatedPanel(),
    session = new PanelSession(sim, save),
    p = newProject().presets[0];
  p.inputFir = {
    name: 'test',
    enabled: true,
    taps: Array.from({ length: 4500 }, (_, i) => (i === 0 ? 1 : 0)),
  };
  await expect(
    uploadFir(
      session,
      1,
      p,
      () => {},
      async () => {
        throw Error('storage full');
      },
    ),
  ).rejects.toThrow('storage full');
  expect(sim.writes).toBe(0);
  sim.status[10] = 32;
  await expect(
    uploadFir(
      session,
      1,
      p,
      () => {},
      async () => {},
    ),
  ).rejects.toThrow('ordinary');
  expect(sim.writes).toBe(0);
});
it('retains mute after partial FIR failure and rejects a tampered manifest', async () => {
  const sim = new SimulatedPanel(),
    session = new PanelSession(sim, save),
    p = newProject().presets[0];
  p.inputFir = {
    name: 'test',
    enabled: true,
    taps: Array.from({ length: 4500 }, (_, i) => (i === 0 ? 1 : 0)),
  };
  let backup: FirBackup | undefined;
  sim.failAtPage = 0x11000;
  await expect(
    uploadFir(
      session,
      1,
      p,
      () => {},
      async (b) => {
        backup = b;
      },
    ),
  ).rejects.toThrow('Injected');
  expect(decodeStatus(sim.status).muted).toBe(true);
  backup!.filenames[0].hex = '01'.repeat(32);
  await expect(
    restoreFir(
      session,
      backup!,
      () => {},
      async () => {},
    ),
  ).rejects.toThrow('checksum');
}, 10000);
it('uploads input EQ separately, preserves its tail, and restores the original active preset and enable flag', async () => {
  const sim = new SimulatedPanel(),
    session = new PanelSession(sim, save),
    p = newProject().presets[0];
  sim.status[2] = 3;
  sim.status[12] |= 16;
  sim.memory.set(encodeEq(p.inputEq), 0x25000);
  const before = sim.memory.slice(0x25000, 0x26000);
  p.inputEq[0].enabled = true;
  p.inputEq[0].gain = -4;
  const backup = await session.uploadEq(1, p.inputEq, false);
  expect(sim.status[2]).toBe(3);
  expect(sim.status[12] & 16).toBe(0);
  expect(sim.eqReloads).toBe(1);
  expect(sim.memory.slice(0x25100, 0x26000)).toEqual(before.slice(256));
  expect(decodeEq(sim.memory.slice(0x25000, 0x25100))[0].gain).toBe(-4);
  await session.restore(backup);
  expect(sim.status[2]).toBe(3);
  expect(sim.status[12] & 16).toBe(16);
  expect(sim.eqReloads).toBe(2);
  expect(hex(sim.memory.slice(0x25000, 0x26000))).toBe(hex(before));
}, 10000);
