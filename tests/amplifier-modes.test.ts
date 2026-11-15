import { describe, expect, it, vi } from 'vitest';
import {
  amplifierModesSummary,
  assertAmplifierModesBaseline,
  planAmplifierModes,
  validateAmplifierModesPatch,
} from '../src/hardware/amplifier-modes';
import { decodeStatus, settings } from '../src/hardware/codec';
import { AmplifierModesStepError, PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';

const writes = (panel: SimulatedPanel) =>
  panel.requests.filter((request) => request[0] === 5 && request[1] === 0);
async function fixture() {
  const panel = new SimulatedPanel('MODE-LEFT'),
    session = new PanelSession(panel, async () => {});
  panel.deviceConfiguration[11] = 9;
  panel.status[9] = 0x59; // Master, unbridged, soft clip, wake and detection.
  panel.status[10] = 0xe7;
  panel.status[7] = 1;
  panel.status.set([0xa5, 0x5a], 24);
  panel.status[35] = 0x83;
  panel.status[36] = 0xe3;
  new DataView(panel.status.buffer).setInt16(21, -5000, true);
  panel.status.set([0xf5, 0x72, 0xd7], 12);
  const identity = await session.identify();
  panel.requests.length = 0;
  return { panel, session, identity };
}

describe('reviewed amplifier-mode native plans', () => {
  it('uses literal inverse Master and bridge/soft-clip bits with exact Slave coupling', async () => {
    const { panel } = await fixture(),
      before = panel.status.slice(),
      plan = planAmplifierModes(
        decodeStatus(before),
        { master: false, bridge: true, softClip: false },
        9,
      );
    expect(plan.request[9]).toBe(0x46);
    expect(plan.request[10]).toBe(0xe7);
    expect(Array.from(plan.request.slice(21, 23))).toEqual([0xe0, 0xb1]);
    expect(plan.request[7]).toBe(0);
    expect(plan.summary).toMatchObject({
      master: false,
      bridge: true,
      softClip: false,
      wakeOnLine: false,
      signalDetection: false,
      startupVolume: -200,
      standbyMode: 0,
    });
    expect(plan.summary.sourceLocks).toEqual([true, false, true]);
    expect(plan.summary.volumeLocks).toEqual([true, true, false]);
    for (const index of [2, 3, 4, 6, 8, 10, 11, 12, 13, 14, 24, 25, 27, 28, 29, 30, 31, 35, 36])
      expect(plan.request[index]).toBe(before[index]);
    expect(panel.status).toEqual(before);
  });

  it('Master clears only preset source/volume locks, retaining source, ADC and EQ bits', async () => {
    const { panel } = await fixture();
    panel.status[9] |= 4;
    const plan = planAmplifierModes(decodeStatus(panel.status), { master: true }, 9);
    expect(Array.from(plan.request.slice(12, 15))).toEqual([0x55, 0x52, 0x57]);
    expect(plan.summary.sourceLocks).toEqual([false, false, false]);
    expect(plan.summary.volumeLocks).toEqual([false, false, false]);
    expect(plan.summary.startupVolume).toBe(-50);
    expect(plan.summary.standbyMode).toBe(1);
  });

  it('fences all three modes, and only the couplings owned by the proposed transition', async () => {
    const { panel } = await fixture(),
      original = panel.status.slice();
    for (const [offset, bit] of [
      [9, 2],
      [9, 4],
      [9, 16],
      [9, 1],
      [9, 8],
      [7, 1],
      [21, 1],
      [22, 1],
    ]) {
      const current = original.slice();
      current[offset] ^= bit;
      expect(() => assertAmplifierModesBaseline(original, current, { master: false })).toThrow(
        /review again/,
      );
    }
    const fresh = original.slice();
    for (const index of [3, 4, 6, 8, 10, 11, 12, 13, 14, 24, 25, 35, 36, 51]) fresh[index] ^= 1;
    fresh[2] = 3;
    expect(() => assertAmplifierModesBaseline(original, fresh, { master: false })).not.toThrow();
    const masterFresh = original.slice();
    masterFresh[12] ^= 128;
    expect(() => assertAmplifierModesBaseline(original, masterFresh, { master: true })).toThrow();
    masterFresh[12] ^= 128 | 64; // ADC alone is not owned by the Master transition.
    expect(() =>
      assertAmplifierModesBaseline(original, masterFresh, { master: true }),
    ).not.toThrow();
  });

  it('rejects non-mode keys, empty/nonboolean values and malformed status without mutation', async () => {
    for (const patch of [
      {},
      { bridge: 1 },
      { mute: true },
      { master: true, volume: -96 },
      { bridge: undefined },
    ])
      expect(() => validateAmplifierModesPatch(patch as never)).toThrow();
    expect(() => amplifierModesSummary(decodeStatus(new Uint8Array(64)))).toThrow();
  });
});

describe('reviewed amplifier-mode reserved Session primitives', () => {
  it('reaches the common barrier after final reads and rechecks the synchronous current fence after the barrier', async () => {
    const { panel, session, identity } = await fixture(),
      events: string[] = [],
      exchange = panel.exchange.bind(panel);
    vi.spyOn(panel, 'exchange').mockImplementation(async (request) => {
      events.push(request[0] === 5 && request[1] === 0 ? 'setter' : 'read');
      return exchange(request);
    });
    let readsAtBarrier = 0;
    await session.exclusive(() =>
      session.writeAmplifierModesInternal(
        identity,
        panel.status.slice(),
        { softClip: false },
        {
          afterReady: async () => {
            readsAtBarrier = events.filter((e) => e === 'read').length;
            events.push('barrier');
            await Promise.resolve();
          },
          assertCurrent: () => events.push('fence'),
          beforeExchange: () => events.push('before-send'),
          onAttempt: () => events.push('attempt'),
        },
      ),
    );
    expect(readsAtBarrier).toBeGreaterThan(0);
    expect(events.slice(events.indexOf('barrier'))).toEqual([
      'barrier',
      'fence',
      'before-send',
      'attempt',
      'setter',
    ]);
    expect(writes(panel)).toHaveLength(1);

    panel.requests.length = 0;
    let current = true;
    await expect(
      session.exclusive(() =>
        session.writeAmplifierModesInternal(
          identity,
          panel.status.slice(),
          { softClip: true },
          {
            afterReady: async () => {
              current = false;
            },
            assertCurrent: () => {
              if (!current) throw new Error('Binding replaced during common barrier');
            },
          },
        ),
      ),
    ).rejects.toMatchObject({ attempted: false });
    expect(writes(panel)).toHaveLength(0);
  });

  it('captures read-only and exposes configured module only after identification', async () => {
    const panel = new SimulatedPanel(),
      session = new PanelSession(panel, async () => {});
    expect(session.moduleType).toBeUndefined();
    panel.deviceConfiguration[11] = 9;
    const identity = await session.identify();
    const result = await session.exclusive(() =>
      session.captureAmplifierModesInternal(identity, { softClip: false }),
    );
    expect(session.moduleType).toBe(9);
    expect(result.configuredModuleType).toBe(9);
    expect(result.summary).toEqual(amplifierModesSummary(decodeStatus(result.status)));
    result.status[9] ^= 255;
    expect(writes(panel)).toHaveLength(0);
    expect(result.status[9]).not.toBe(panel.status[9]);
  });

  it('rebases fresh unrelated runtime/source/LED/security fields into exactly one setter without extra mute/restart', async () => {
    const { panel, session, identity } = await fixture();
    panel.status[6] = 2;
    const captured = await session.exclusive(() => session.captureAmplifierModesInternal(identity));
    const ready = vi.fn(async () => {
        panel.status[2] = 3;
        panel.status[3] = 0x51;
        panel.status[4] = 0xfc;
        panel.status[35] = 0xc8;
        panel.status[12] ^= 64;
        panel.status[24] = 0x5a;
      }),
      attempt = vi.fn();
    const result = await session.exclusive(() =>
      session.writeAmplifierModesInternal(
        identity,
        captured.status,
        { softClip: false },
        { readyToExchange: ready, onAttempt: attempt },
      ),
    );
    expect(ready).toHaveBeenCalledOnce();
    expect(attempt).toHaveBeenCalledOnce();
    expect(writes(panel)).toHaveLength(1);
    expect(panel.requests.filter((r) => r[0] === 8 || (r[0] === 0x66 && r[1] === 1))).toHaveLength(
      0,
    );
    expect(result.status.muted).toBe(false);
    expect(result.status.preset).toBe(3);
    expect(result.status.raw[35]).toBe(0xc8);
    expect(result.status.raw[12]).toBe(panel.status[12]);
    expect(result.status.raw[24]).toBe(0x5a);
    expect(settings(result.status).softClip).toBe(false);
  });

  it('fresh permission denial after durable readiness is Blocked with zero writes and attempts', async () => {
    const { panel, session, identity } = await fixture(),
      baseline = panel.status.slice(),
      attempt = vi.fn();
    const promise = session.exclusive(() =>
      session.writeAmplifierModesInternal(
        identity,
        baseline,
        { bridge: true },
        {
          readyToExchange: async () => {
            panel.status[51] = 2;
          },
          onAttempt: attempt,
        },
      ),
    );
    await expect(promise).rejects.toMatchObject({ attempted: false });
    expect(attempt).not.toHaveBeenCalled();
    expect(writes(panel)).toHaveLength(0);
  });

  it('permits locked OEM child intersections without a Defaults-style absolute unlock gate', async () => {
    const { panel, session, identity } = await fixture();
    panel.deviceConfiguration[11] = 1;
    panel.status[51] = 2;
    panel.status[24] = 0x48;
    panel.status[25] = 0; // Settings entry + Master/Slave.
    await session.exclusive(() =>
      session.writeAmplifierModesInternal(identity, panel.status.slice(), { master: false }),
    );
    expect(writes(panel)).toHaveLength(1);
    expect(settings(decodeStatus(panel.status)).master).toBe(false);
  });

  it('refuses a changed owned baseline or changed captured identity before any setter', async () => {
    const { panel, session, identity } = await fixture(),
      baseline = panel.status.slice();
    panel.status[9] ^= 2;
    await expect(
      session.exclusive(() =>
        session.writeAmplifierModesInternal(identity, baseline, { softClip: false }),
      ),
    ).rejects.toMatchObject({ attempted: false });
    panel.status[9] ^= 2;
    panel.eeprom[0x100] = 88;
    await expect(
      session.exclusive(() =>
        session.writeAmplifierModesInternal(identity, baseline, { softClip: false }),
      ),
    ).rejects.toMatchObject({ attempted: false });
    expect(writes(panel)).toHaveLength(0);
  });

  it('checks the synchronous cancellation fence directly before the exchange and does not call the attempt hook', async () => {
    const { panel, session, identity } = await fixture(),
      attempt = vi.fn();
    await expect(
      session.exclusive(() =>
        session.writeAmplifierModesInternal(
          identity,
          panel.status.slice(),
          { softClip: false },
          {
            beforeExchange: () => {
              throw new Error('Captured connection was replaced');
            },
            onAttempt: attempt,
          },
        ),
      ),
    ).rejects.toMatchObject({ attempted: false });
    expect(attempt).not.toHaveBeenCalled();
    expect(writes(panel)).toHaveLength(0);
  });

  it('lost setter ACK is Unconfirmed with one attempted report and no failure mute or retry', async () => {
    const { panel, session, identity } = await fixture(),
      exchange = panel.exchange.bind(panel);
    vi.spyOn(panel, 'exchange').mockImplementation(async (request) => {
      const reply = await exchange(request);
      if (request[0] === 5 && request[1] === 0) throw new Error('Lost ACK');
      return reply;
    });
    panel.status[6] = 0;
    await expect(
      session.exclusive(() =>
        session.writeAmplifierModesInternal(identity, panel.status.slice(), { softClip: false }),
      ),
    ).rejects.toMatchObject({ attempted: true });
    expect(writes(panel)).toHaveLength(1);
    expect(settings(decodeStatus(panel.status)).softClip).toBe(false);
    expect(panel.status[6] & 128).toBe(0);
  });

  it('full common-05 reply verification catches unrelated preserved-field corruption after a report was attempted', async () => {
    const { panel, session, identity } = await fixture(),
      exchange = panel.exchange.bind(panel);
    vi.spyOn(panel, 'exchange').mockImplementation(async (request) => {
      const reply = await exchange(request);
      if (request[0] === 5 && request[1] === 0) reply[35] ^= 1;
      return reply;
    });
    try {
      await session.exclusive(() =>
        session.writeAmplifierModesInternal(identity, panel.status.slice(), { softClip: false }),
      );
      throw new Error('Expected readback rejection');
    } catch (failure) {
      expect(failure).toBeInstanceOf(AmplifierModesStepError);
      expect(failure).toMatchObject({
        attempted: true,
        message: 'Control readback mismatch at byte 35',
      });
    }
    expect(writes(panel)).toHaveLength(1);
  });

  it('captures caller identity, patch and baseline before any asynchronous readiness work', async () => {
    const { panel, session, identity } = await fixture(),
      target = { ...identity },
      patch = { softClip: false },
      baseline = panel.status.slice();
    await session.exclusive(() =>
      session.writeAmplifierModesInternal(target, baseline, patch, {
        readyToExchange: async () => {
          target.serial = 'OTHER';
          patch.softClip = true;
          baseline[9] ^= 2;
        },
      }),
    );
    expect(settings(decodeStatus(panel.status)).softClip).toBe(false);
    expect(writes(panel)).toHaveLength(1);
  });
});
