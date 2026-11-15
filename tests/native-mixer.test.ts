import { expect, it, vi } from 'vitest';
import { PanelSession, NativeMixerStepError } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { hex, packet } from '../src/hardware/codec';
import type { Transport } from '../src/hardware/transport';
import {
  nativeMixerAvailability,
  nativeMixerEditorRow,
  nativeMixerEditorWeight,
  decodeNativeMixer,
  encodeNativeMixerWeight,
  planNativeMixer,
  verifyNativeMixerReadback,
  type NativeMixerCapture,
} from '../src/hardware/native-mixer';

const rawWords = [
  1, 32, -32, 127, -127, 512, -32768, 32767, -1, 0, 256, -256, 1234, -4321, 100, 200, -300, 400,
];
function fixture(serial = 'H05U-SYNTHETIC-MIXER') {
  const panel = new SimulatedPanel(serial),
    requests: Uint8Array[] = [],
    backup = vi.fn(async () => {
      throw new Error('No generic backup write');
    });
  panel.configuration[4] = 2;
  panel.configuration[5] = panel.configuration[12] = 3;
  panel.deviceConfiguration[11] = 1;
  panel.deviceConfiguration[14] = 128;
  const mv = new DataView(panel.mixerConfiguration.buffer);
  rawWords.forEach((word, i) => mv.setInt16(2 + i * 2, word, true));
  panel.mixerConfiguration.fill(0xa5, 38);
  let intercept:
    ((r: Uint8Array, send: () => Promise<Uint8Array>) => Promise<Uint8Array>) | undefined;
  const transport: Transport = {
      exchange: async (r) => {
        requests.push(r.slice());
        const send = () => panel.exchange(r);
        return intercept ? intercept(r, send) : send();
      },
      close: () => panel.close(),
    },
    session = new PanelSession(transport, backup),
    identity = { serial, product: 22, core: '5.1', firmware: '5.7' },
    capture = () => session.exclusive(() => session.captureNativeMixerInternal(identity));
  return {
    panel,
    session,
    identity,
    requests,
    backup,
    capture,
    set intercept(value: typeof intercept) {
      intercept = value;
    },
  };
}
const setters = (rows: readonly Uint8Array[]) =>
  rows.filter(
    (r) =>
      (r[0] === 0x67 && r[1] === 1) ||
      (r[0] === 5 && r[1] === 0) ||
      (r[0] === 0x66 && r[1] === 1) ||
      r[0] === 0x64,
  );
const input = { product: 22, moduleType: 1, core: '5.1', systemSetup: 2, stereoDsp: true };

it('retains the native capability/route distinction and actual reported Enable flag', () => {
  expect(nativeMixerAvailability(input)).toMatchObject({
    groupVisible: true,
    enabled: true,
    editorAvailable: true,
    routingChoices: [0, 1, 2, 3, 4],
  });
  expect(nativeMixerAvailability({ ...input, moduleType: 9 })).toMatchObject({
    groupVisible: true,
    enabled: true,
    editorAvailable: false,
    routingChoices: [0, 1, 2],
  });
  for (const patch of [
    { product: 0x90 },
    { systemSetup: 0 },
    { stereoDsp: false },
    { core: '1.49' },
    { core: 'bad' },
  ])
    expect(nativeMixerAvailability({ ...input, ...patch })).toMatchObject({
      editorAvailable: false,
      routingChoices: [0, 1, 2],
    });
  expect(nativeMixerAvailability({ ...input, core: '1.50' }).editorAvailable).toBe(true);
  expect(nativeMixerAvailability({ ...input, core: '2.0' }).editorAvailable).toBe(true);
  expect(nativeMixerAvailability({ ...input, product: 18 }).editorAvailable).toBe(true);
  expect(nativeMixerAvailability({ ...input, product: 99, moduleType: 1 }).groupVisible).toBe(true);
  expect(nativeMixerAvailability({ ...input, core: '5.1000' }).editorAvailable).toBe(false);
});

it('decodes literal signed-Q8 words without narrowing the latent wire domain or using byte1 as ACK', () => {
  const f = fixture();
  f.panel.mixerConfiguration[1] = 255;
  expect(decodeNativeMixer(f.panel.mixerConfiguration).flat()).toEqual(
    rawWords.map((n) => n / 256),
  );
  expect(() => decodeNativeMixer(packet(0x66))).toThrow('67');
  expect(() => decodeNativeMixer(new Uint8Array(63))).toThrow('complete');
});

it('explicit modal opening clamps and formats only its selected six-value row before Single storage', () => {
  const matrix = decodeNativeMixer(fixture().panel.mixerConfiguration),
    row = nativeMixerEditorRow(matrix[0]);
  expect(row).toEqual([0, Math.fround(0.13), Math.fround(-0.13), 0.5, -0.5, 1]);
  expect(matrix[0]).toEqual(rawWords.slice(0, 6).map((n) => n / 256));
  expect(matrix[1][0]).toBe(-128);
  expect(() => nativeMixerEditorRow([1, 2])).toThrow('six');
});

it('matches literal positive and negative native FormatFloat two-place tie vectors', () => {
  const ties = [0.125, 0.375, 0.625, 0.875, -0.125, -0.375, -0.625, -0.875],
    expected = [0.13, 0.38, 0.63, 0.88, -0.13, -0.38, -0.63, -0.88];
  expect(ties.map(nativeMixerEditorWeight)).toEqual(expected.map(Math.fround));
  expect(nativeMixerEditorRow(ties.slice(0, 6))).toEqual(expected.slice(0, 6).map(Math.fround));
  expect([0.105, -0.105, 0.005, -0.005, 1e-100, -1e-100].map(nativeMixerEditorWeight)).toEqual([
    Math.fround(0.11),
    Math.fround(-0.11),
    Math.fround(0.01),
    Math.fround(-0.01),
    0,
    0,
  ]);
});

it('uses Single then Q24 rounding then upper16, including asymmetric signs and a Single boundary', () => {
  expect([0.1, -0.1, 1, -1, 0].map(encodeNativeMixerWeight)).toEqual([25, -26, 256, -256, 0]);
  const below = 65535.5 / 2 ** 24 - 2 ** -50;
  expect(below * 2 ** 24).toBeLessThan(65535.5);
  expect(encodeNativeMixerWeight(below)).toBe(1);
  expect(() => encodeNativeMixerWeight(1.01)).toThrow('-1..1');
  expect(() => encodeNativeMixerWeight(NaN)).toThrow('-1..1');
});

it('captures only readonly reports and stable serial, with no flash reads, backups or setters', async () => {
  const f = fixture(),
    cap = await f.capture();
  expect(cap.identity).toEqual(f.identity);
  expect(decodeNativeMixer(cap.mixerConfiguration)[2]).toEqual(
    rawWords.slice(12).map((n) => n / 256),
  );
  for (const r of f.requests) {
    if (r[0] === 0x65) expect(Array.from(r.slice(1, 6))).toEqual([32, 0, 1, 0, 0]);
    else
      expect([
        [6, 1],
        [0x66, 0],
        [3, 8],
        [5, 1],
        [0x67, 0],
      ]).toContainEqual([r[0], r[1]]);
  }
  expect(setters(f.requests)).toHaveLength(0);
  expect(f.backup).not.toHaveBeenCalled();
  const saved = hex(cap.mixerConfiguration);
  f.panel.mixerConfiguration.fill(7);
  expect(hex(cap.mixerConfiguration)).toBe(saved);
});

it('preserves all unselected signed-Q8 words and inert padding while opened-row normalization is explicit', async () => {
  const f = fixture(),
    cap = await f.capture(),
    rows = [
      {
        preset: 1 as const,
        weights: [...nativeMixerEditorRow(decodeNativeMixer(cap.mixerConfiguration)[0])],
      },
    ],
    plan = planNativeMixer(cap, rows);
  expect(plan.after[0]).toEqual([0, 33 / 256, -34 / 256, 0.5, -0.5, 1]);
  expect(hex(plan.request.slice(14, 38))).toBe(hex(cap.mixerConfiguration.slice(14, 38)));
  expect(Array.from(plan.request.slice(38))).toEqual(Array(26).fill(0));
  expect(plan.verification.mask[1]).toBe(0);
  expect(Array.from(plan.verification.mask.slice(38))).toEqual(Array(26).fill(0));
  rows[0].weights.fill(0);
  const changed = plan.request;
  changed.fill(0);
  expect(plan.request[0]).toBe(0x67);
  expect(plan.rows[0].weights[1]).toBe(Math.fround(0.13));
  const same = planNativeMixer(cap, [
    { preset: 2, weights: decodeNativeMixer(cap.mixerConfiguration)[1] },
  ]);
  expect(hex(same.request.slice(2, 38))).toBe(hex(cap.mixerConfiguration.slice(2, 38)));
  expect(() => planNativeMixer(cap, [{ preset: 1, weights: [2, 0, 0, 0, 0, 0] }])).toThrow('-1..1');
  expect(() =>
    planNativeMixer(cap, [
      { preset: 1, weights: [0, 0, 0, 0, 0, 0] },
      { preset: 1, weights: [0, 0, 0, 0, 0, 0] },
    ]),
  ).toThrow('unique');
});

it.each([1 << 10, 1 << 3, 1 << 13, 0])(
  'requires entry AND DigitalLeftRight permission, not Routing, mask %i',
  async (mask) => {
    const f = fixture();
    f.panel.status[51] = 2;
    new DataView(f.panel.status.buffer).setUint16(24, mask, true);
    await expect(f.capture()).rejects.toThrow('permission');
    expect(f.requests.some((r) => r[0] === 0x67)).toBe(false);
    expect(setters(f.requests)).toHaveLength(0);
  },
);

it('permits the exact protected OEM intersection and separately permits verified password access', async () => {
  const f = fixture();
  f.panel.status[51] = 2;
  new DataView(f.panel.status.buffer).setUint16(24, (1 << 3) | (1 << 10), true);
  expect((await f.capture()).status[51]).toBe(2);
  f.panel.status[51] = 6;
  f.panel.status[24] = f.panel.status[25] = 0;
  expect((await f.capture()).status[51]).toBe(6);
});

it('exposes stable cached capability without probing a commercial module and refreshes after a fresh overview', async () => {
  const f = fixture();
  expect(f.session.nativeMixerCapability).toBeUndefined();
  f.panel.deviceConfiguration[11] = 9;
  await f.session.identify();
  const cached = f.session.nativeMixerCapability,
    count = f.requests.length;
  expect(nativeMixerAvailability(cached!).editorAvailable).toBe(false);
  expect(f.session.nativeMixerCapability).toBe(cached);
  expect(f.requests).toHaveLength(count);
  await f.session.identify();
  expect(f.session.nativeMixerCapability).toBe(cached);
  f.panel.deviceConfiguration[11] = 1;
  await f.session.hardwareOverview();
  expect(nativeMixerAvailability(f.session.nativeMixerCapability!).editorAvailable).toBe(true);
});

it.each([3, 4])(
  'blocks ordinary routing %i for commercial module9 before every setter and keeps routing2 unchanged',
  async (routing) => {
    const f = fixture();
    f.panel.deviceConfiguration[11] = 9;
    await expect(f.session.preflightControls({ routing })).rejects.toThrow('OEM');
    await expect(f.session.setControls({ routing })).rejects.toThrow('OEM');
    expect(setters(f.requests)).toHaveLength(0);
    await f.session.preflightControls({ routing: 2 });
    expect(setters(f.requests)).toHaveLength(0);
  },
);

it('checks advanced routing capability freshly after identity reads and preserves current runtime controls', async () => {
  const f = fixture();
  let changed = false;
  f.intercept = async (r, send) => {
    const reply = await send();
    if (!changed && r[0] === 0x65) {
      changed = true;
      f.panel.deviceConfiguration[14] = 0;
    }
    return reply;
  };
  await expect(f.session.setControls({ routing: 3 })).rejects.toThrow('disabled');
  expect(setters(f.requests)).toHaveLength(0);
});

it('sends one exact67/01 and independently reads back67/00 without any05/66 setter or mute', async () => {
  const f = fixture(),
    cap = await f.capture(),
    plan = planNativeMixer(cap, [
      { preset: 1, weights: nativeMixerEditorRow(decodeNativeMixer(cap.mixerConfiguration)[0]) },
    ]),
    oldStatus = hex(f.panel.status),
    oldConfig = hex(f.panel.deviceConfiguration);
  const result = await f.session.exclusive(() =>
    f.session.writeNativeMixerInternal(f.identity, cap, plan),
  );
  expect(setters(f.requests).map((r) => [r[0], r[1]])).toEqual([[0x67, 1]]);
  expect(f.panel.mixerWrites).toBe(1);
  expect(result.matrix).toEqual(plan.after);
  expect(hex(f.panel.status)).toBe(oldStatus);
  expect(hex(f.panel.deviceConfiguration)).toBe(oldConfig);
  expect(hex(f.panel.eeprom.slice(0xd0, 0xf4))).toBe(hex(plan.request.slice(2, 38)));
  expect(f.requests.at(-1)!.slice(0, 2)).toEqual(Uint8Array.of(0x67, 0));
});

it('ignores unproved ACK selector/padding and requires the separate complete matrix readback', async () => {
  const f = fixture(),
    cap = await f.capture(),
    plan = planNativeMixer(cap, [{ preset: 1, weights: [0.1, -0.1, 0.2, -0.2, 0.5, -0.5] }]);
  f.intercept = async (r, send) => {
    const reply = await send();
    if (r[0] === 0x67 && r[1] === 1) return packet(0x67, 0xff); // ACK is not the readback.
    if (r[0] === 0x67 && r[1] === 0) {
      reply[1] = 0x5a;
      reply.fill(0xee, 38);
    }
    return reply;
  };
  const result = await f.session.exclusive(() =>
    f.session.writeNativeMixerInternal(f.identity, cap, plan),
  );
  expect(result.matrix).toEqual(plan.after);
  expect(f.panel.mixerWrites).toBe(1);
});

it.each(['matrix', 'configuration', 'capability', 'permission'] as const)(
  'refuses late %s drift after durable intent with zero setters',
  async (kind) => {
    const f = fixture(),
      cap = await f.capture(),
      plan = planNativeMixer(cap, [{ preset: 1, weights: [0, 0, 0, 0, 0, 0] }]);
    const work = () =>
      f.session.exclusive(() =>
        f.session.writeNativeMixerInternal(f.identity, cap, plan, {
          readyToExchange: async () => {
            if (kind === 'matrix') f.panel.mixerConfiguration[2] ^= 1;
            if (kind === 'configuration') f.panel.deviceConfiguration[15] ^= 1;
            if (kind === 'capability') f.panel.deviceConfiguration[14] = 0;
            if (kind === 'permission') {
              f.panel.status[51] = 2;
              f.panel.status[24] = f.panel.status[25] = 0;
            }
          },
        }),
      );
    await expect(work()).rejects.toMatchObject({ attempted: false });
    expect(f.panel.mixerWrites).toBe(0);
  },
);

it('reports final synchronous cancellation as blocked even if the provisional attempt observer ran', async () => {
  const f = fixture(),
    cap = await f.capture(),
    plan = planNativeMixer(cap, [{ preset: 1, weights: [0, 0, 0, 0, 0, 0] }]),
    provisional = vi.fn();
  await expect(
    f.session.exclusive(() =>
      f.session.writeNativeMixerInternal(f.identity, cap, plan, {
        onAttempt: provisional,
        beforeExchange: () => {
          throw new Error('Synthetic cancelled');
        },
      }),
    ),
  ).rejects.toMatchObject({ attempted: false });
  expect(provisional).toHaveBeenCalledOnce();
  expect(f.panel.mixerWrites).toBe(0);
});

it('rechecks access after the final matrix read before reaching the shared send barrier', async () => {
  const f = fixture(),
    cap = await f.capture(),
    plan = planNativeMixer(cap, [{ preset: 1, weights: [0, 0, 0, 0, 0, 0] }]),
    ready = vi.fn(async () => {});
  f.intercept = async (r, send) => {
    const reply = await send();
    if (r[0] === 0x67 && r[1] === 0) f.panel.status[51] = 2;
    return reply;
  };
  await expect(
    f.session.exclusive(() =>
      f.session.writeNativeMixerInternal(f.identity, cap, plan, { afterReady: ready }),
    ),
  ).rejects.toMatchObject({ attempted: false });
  expect(ready).not.toHaveBeenCalled();
  expect(f.panel.mixerWrites).toBe(0);
});

it('supports a shared final readiness barrier so a peer refusal prevents either matrix setter', async () => {
  const left = fixture('H05U-MIXER-LEFT'),
    right = fixture('H05U-MIXER-RIGHT'),
    caps = await Promise.all([left.capture(), right.capture()]);
  let rejectBarrier!: (e: unknown) => void;
  const barrier = new Promise<void>((_resolve, reject) => {
    rejectBarrier = reject;
  });
  const jobs = [left, right].map((f, i) =>
    f.session
      .exclusive(() =>
        f.session.writeNativeMixerInternal(
          f.identity,
          caps[i],
          planNativeMixer(caps[i], [{ preset: 1, weights: [0, 0, 0, 0, 0, 0] }]),
          {
            readyToExchange: async () => {
              if (i === 1) right.panel.status[51] = 2;
            },
            afterReady: () => barrier,
          },
        ),
      )
      .catch((e) => {
        rejectBarrier(e);
        throw e;
      }),
  );
  const results = await Promise.allSettled(jobs);
  expect(results.every((r) => r.status === 'rejected')).toBe(true);
  expect(left.panel.mixerWrites + right.panel.mixerWrites).toBe(0);
});

it('does not retry a lost ACK or send any failure-recovery control packet', async () => {
  const f = fixture(),
    cap = await f.capture(),
    plan = planNativeMixer(cap, [{ preset: 1, weights: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1] }]);
  f.intercept = async (r, send) => {
    const reply = await send();
    if (r[0] === 0x67 && r[1] === 1) throw new Error('Synthetic ACK lost');
    return reply;
  };
  await expect(
    f.session.exclusive(() => f.session.writeNativeMixerInternal(f.identity, cap, plan)),
  ).rejects.toMatchObject({ name: 'NativeMixerStepError', attempted: true });
  expect(setters(f.requests)).toHaveLength(1);
  expect(f.panel.mixerWrites).toBe(1);
  expect(decodeNativeMixer(f.panel.mixerConfiguration)).toEqual(plan.after);
});

it('finishes bounded ACK/readback after a post-send abort and preserves unrelated live controls', async () => {
  const f = fixture(),
    cap = await f.capture(),
    plan = planNativeMixer(cap, [{ preset: 1, weights: [0.1, -0.1, 0.2, -0.2, 0.5, -0.5] }]),
    stop = new AbortController();
  f.intercept = async (r, send) => {
    const reply = await send();
    if (r[0] === 0x67 && r[1] === 1) stop.abort();
    return reply;
  };
  const result = await f.session.exclusive(() =>
    f.session.writeNativeMixerInternal(f.identity, cap, plan, {
      readyToExchange: async () => {
        f.panel.status[3] = 0x34;
        f.panel.status[4] = 0xf9;
        f.panel.status[6] ^= 128;
      },
      beforeExchange: () => stop.signal.throwIfAborted(),
    }),
  );
  expect(stop.signal.aborted).toBe(true);
  expect(result.matrix).toEqual(plan.after);
  expect(f.panel.status[3]).toBe(0x34);
  expect(f.panel.status[4]).toBe(0xf9);
  expect(f.panel.status[6]).toBe(cap.status[6] ^ 128);
  expect(setters(f.requests).map((r) => [r[0], r[1]])).toEqual([[0x67, 1]]);
});

it('classifies mismatched fresh readback as attempted and verifies only the owned command/word bytes', async () => {
  const f = fixture(),
    cap = await f.capture(),
    plan = planNativeMixer(cap, [{ preset: 1, weights: [0, 0, 0, 0, 0, 0] }]);
  f.intercept = async (r, send) => {
    const reply = await send();
    if (r[0] === 0x67 && r[1] === 0 && f.panel.mixerWrites) reply[2] ^= 1;
    return reply;
  };
  await expect(
    f.session.exclusive(() => f.session.writeNativeMixerInternal(f.identity, cap, plan)),
  ).rejects.toBeInstanceOf(NativeMixerStepError);
  expect(f.panel.mixerWrites).toBe(1);
  expect(setters(f.requests)).toHaveLength(1);
  const padded = plan.verification.expected;
  padded[1] = 255;
  padded.fill(123, 38);
  verifyNativeMixerReadback(plan, padded);
  padded[3] ^= 1;
  expect(() => verifyNativeMixerReadback(plan, padded)).toThrow('readback');
});

it('rejects forged reviewed requests before any fresh device or setter call', async () => {
  const f = fixture(),
    cap = await f.capture(),
    plan = planNativeMixer(cap, [{ preset: 1, weights: [0, 0, 0, 0, 0, 0] }]),
    bad = plan.request;
  bad[0] = 5;
  const before = f.requests.length;
  await expect(
    f.session.exclusive(() =>
      f.session.writeNativeMixerInternal(f.identity, cap, { ...plan, request: bad }),
    ),
  ).rejects.toMatchObject({ attempted: false });
  expect(f.requests).toHaveLength(before);
  expect(f.panel.mixerWrites).toBe(0);
});
