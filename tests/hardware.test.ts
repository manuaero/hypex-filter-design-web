import { describe, it, expect, vi } from 'vitest';
import { newProject } from '../src/domain/model';
import { encodeChannel } from '../src/domain/dsp';
import { control, decodeStatus, packet, hex, crc16, encodeEq } from '../src/hardware/codec';
import { PanelSession, uploadPair, type Backup } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { AsyncQueue } from '../src/hardware/transport';
const save = async (_: Backup) => {};
describe('FA503 protocol', () => {
  it('preflights both amps and verifies both mutes before the first erase, retaining distinct designs', async () => {
    const left = new SimulatedPanel('L'),
      right = new SimulatedPanel('R'),
      l = new PanelSession(left, save),
      r = new PanelSession(right, save),
      lp = newProject().presets[0],
      rp = newProject().presets[0];
    lp.channels[0].gain = -3;
    rp.channels[0].gain = -7;
    for (const [panel, other] of [
      [left, right],
      [right, left],
    ]) {
      const exchange = panel.exchange.bind(panel);
      panel.exchange = async (request) => {
        if (request[0] === 0x64 && request[1] === 4)
          expect(decodeStatus(other.status).muted).toBe(true);
        return exchange(request);
      };
    }
    await uploadPair([
      { session: l, preset: 1, name: 'Left design', design: lp, progress: () => {} },
      { session: r, preset: 1, name: 'Right design', design: rp, progress: () => {} },
    ]);
    expect(left.memory.slice(0x22000, 0x22200)).toEqual(encodeChannel(lp.channels[0]));
    expect(right.memory.slice(0x22000, 0x22200)).toEqual(encodeChannel(rp.channels[0]));
    expect(left.maxConcurrent).toBe(1);
    expect(right.maxConcurrent).toBe(1);
  }, 10000);
  it('waits for all preflights after one backup failure before releasing sessions', async () => {
    const left = new SimulatedPanel('L'),
      right = new SimulatedPanel('R');
    let completed = false;
    const l = new PanelSession(left, async () => {
        throw Error('backup failed');
      }),
      r = new PanelSession(right, async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        completed = true;
      });
    await expect(
      uploadPair(
        [l, r].map((session) => ({
          session,
          preset: 1,
          name: 'test',
          design: newProject().presets[0],
          progress: () => {},
        })),
      ),
    ).rejects.toThrow('backup failed');
    expect(completed).toBe(true);
    expect(l.busy || r.busy).toBe(false);
    expect(left.writes + right.writes).toBe(0);
  });
  it('preserves writable fields and clears one-shot triggers', () => {
    const raw = packet(5);
    raw[2] = 1;
    raw[6] = 5;
    raw[9] = 0x19;
    raw[11] = 1;
    raw[12] = 0x96;
    raw[23] = 255;
    raw[28] = 0xa5;
    raw[36] = 7;
    const out = control(decodeStatus(raw), { mute: true, preset: 2 });
    expect(out[6]).toBe(133);
    expect(out[11]).toBe(1);
    expect(out[12]).toBe(0x96);
    expect(out[23]).toBe(0);
    expect(out[28]).toBe(0xa5);
    expect(out[36]).toBe(3);
    expect(out[2]).toBe(2);
  });
  it('uses CCITT CRC and encodes the input EQ metadata independently', () => {
    expect(crc16(new TextEncoder().encode('123456789'))).toBe(0x29b1);
    const bands = newProject().presets[0].inputEq;
    bands[0] = { ...bands[0], kind: 'peak', enabled: true, frequency: 1000, q: 0.707, gain: -3 };
    const b = encodeEq(bands),
      v = new DataView(b.buffer);
    expect(b[180]).toBe(128);
    expect(v.getUint16(186, true)).toBe(-3000 & 65535);
    expect(v.getUint16(254, true)).toBe(crc16(b.slice(0, 254)));
  });
  it('serializes operations even after a rejected request', async () => {
    const queue = new AsyncQueue(),
      events: number[] = [];
    const a = queue.run(async () => {
      events.push(1);
      await Promise.resolve();
      events.push(2);
      throw Error('first');
    });
    const b = queue.run(async () => {
      events.push(3);
    });
    await Promise.allSettled([a, b]);
    expect(events).toEqual([1, 2, 3]);
  });
  it('leaves and reloads the active preset while muted after uploading', async () => {
    const sim = new SimulatedPanel(),
      session = new PanelSession(sim, save);
    const transitions: number[] = [];
    const exchange = sim.exchange.bind(sim);
    sim.exchange = async (request) => {
      const before = decodeStatus(sim.status).preset;
      const reply = await exchange(request);
      const after = decodeStatus(sim.status);
      if (after.preset !== before) {
        expect(after.muted).toBe(true);
        transitions.push(after.preset);
      }
      return reply;
    };
    await session.upload(1, 'reload test', newProject().presets[0]);
    expect(transitions).toEqual([2, 1]);
    expect(decodeStatus(sim.status).muted).toBe(true);
  }, 10000);
  it('backs up before erase and restores exact bytes while retaining mute', async () => {
    const sim = new SimulatedPanel(),
      saved: Backup[] = [];
    const session = new PanelSession(sim, async (b) => {
      saved.push(b);
    });
    const before = sim.memory.slice(0x22000, 0x23000);
    const project = newProject();
    const backup = await session.upload(1, 'test', project.presets[0]);
    expect(saved.length).toBe(1);
    expect(saved[0].sector_hex).toBe(hex(before));
    expect(decodeStatus(sim.status).muted).toBe(true);
    await session.restore(backup);
    expect(sim.memory.slice(0x22000, 0x23000)).toEqual(before);
    expect(sim.name).toBe('Simulator');
  }, 10000);
  it('does not erase when backup persistence fails', async () => {
    const sim = new SimulatedPanel(),
      session = new PanelSession(sim, async () => {
        throw Error('disk full');
      });
    await expect(session.upload(1, 'test', newProject().presets[0])).rejects.toThrow('disk full');
    expect(sim.writes).toBe(0);
  });
  it('refuses restoration to a different physical identity', async () => {
    const a = new PanelSession(new SimulatedPanel('A'), save),
      bSim = new SimulatedPanel('B'),
      b = new PanelSession(bSim, save);
    const backup = await a.backup(1);
    await expect(b.restore(backup)).rejects.toThrow('different amplifier');
    expect(bSim.writes).toBe(0);
  });
  it('detects corrupted page readback and stays muted', async () => {
    const sim = new SimulatedPanel();
    sim.corruptReadback = true;
    const session = new PanelSession(sim, save);
    await expect(session.upload(1, 'test', newProject().presets[0])).rejects.toThrow(
      'Readback mismatch',
    );
    expect(decodeStatus(sim.status).muted).toBe(true);
  });
  it('handles a stereo partial failure without declaring pair success', async () => {
    const left = new SimulatedPanel('L'),
      right = new SimulatedPanel('R');
    right.failAtPage = 0x22000;
    const sessions = [new PanelSession(left, save), new PanelSession(right, save)];
    await expect(
      uploadPair(
        sessions.map((session) => ({
          session,
          preset: 1,
          name: 'stereo',
          design: newProject().presets[0],
          progress: () => {},
        })),
      ),
    ).rejects.toThrow('Right');
    expect(decodeStatus(left.status).muted).toBe(true);
    expect(decodeStatus(right.status).muted).toBe(true);
  }, 10000);
});
