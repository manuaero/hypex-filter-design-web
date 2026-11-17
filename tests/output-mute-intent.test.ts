import { describe, expect, it, vi } from 'vitest';
import { createToolExecutor, controlsSchema, type ToolAdapter } from '../src/application/tools';
import { newProject } from '../src/domain/model';
import { control, decodeStatus, type Controls } from '../src/hardware/codec';
import { requiredControlOperations } from '../src/hardware/protection';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';

const invalid = [
  { outputMute: null },
  { outputMute: [] },
  { outputMute: { channel: 0, muted: true } },
  { outputMute: { channel: 4, muted: true } },
  { outputMute: { channel: 1.5, muted: true } },
  { outputMute: { channel: '1', muted: true } },
  { outputMute: { channel: 1, muted: 1 } },
  { outputMute: { channel: 1 } },
  { outputMute: { channel: 1, muted: true, bridge: false } },
  { outputMute: { channel: 1, muted: true }, mute: true },
  { outputMute: { channel: 1, muted: true }, channelMutes: [false, false, false] },
];
const mutations = (panel: SimulatedPanel) => panel.requests.filter((r) => r[0] === 5 && r[1] === 0);
function fixture(serial = 'SYNTHETIC-OUTPUT-MUTE') {
  const panel = new SimulatedPanel(serial);
  panel.status[2] = 3;
  panel.status[6] = 0xa5;
  panel.status[9] = 0xe9; // Bridge remains off throughout these simulated tests.
  panel.status[10] = 0x39;
  panel.status.set([2, 3, 5], 12);
  panel.status[36] = 2;
  return { panel, session: new PanelSession(panel, async () => {}) };
}

describe('single physical output mute intent', () => {
  it('changes only the selected mute bit for all three outputs and both values', () => {
    for (const channel of [1, 2, 3]) {
      for (const muted of [true, false]) {
        const { panel } = fixture(),
          before = panel.status.slice(),
          status = decodeStatus(before);
        const actual = control(status, { outputMute: { channel, muted } });
        const expected = status.channelMutes.map((value, index) =>
          index === channel - 1 ? muted : value,
        );
        expect(decodeStatus(actual).channelMutes).toEqual(expected);
        expect(actual).toEqual(control(status, { channelMutes: expected }));
        expect(actual[6] & ~7).toBe(before[6] & ~7);
        expect(actual.slice(9, 15)).toEqual(before.slice(9, 15));
        expect(actual.slice(2, 5)).toEqual(before.slice(2, 5));
        expect(status.raw).toEqual(before);
      }
    }
  });

  it.each(invalid)(
    'refuses invalid or composite intent before any mutating exchange: %j',
    async (patch) => {
      const { panel, session } = fixture(),
        before = panel.status.slice();
      expect(() => control(decodeStatus(before), patch as unknown as Controls)).toThrow(
        'outputMute',
      );
      await expect(session.setControls(patch as unknown as Controls)).rejects.toThrow('outputMute');
      expect(mutations(panel)).toEqual([]);
      expect(panel.status).toEqual(before);
    },
  );

  it('uses final fresh status after preflight instead of replaying stale mute/source/preset/volume', async () => {
    const { panel, session } = fixture();
    await session.status();
    await session.preflightControls({ outputMute: { channel: 2, muted: true } });
    panel.status[2] = 2;
    panel.status[3] = 0xd2;
    panel.status[4] = 0x04;
    panel.status[6] = 0x84;
    panel.status[11] = 2;
    panel.status[13] = 5;
    const fresh = panel.status.slice();
    const result = await session.setControls({ outputMute: { channel: 2, muted: true } });
    expect(result.channelMutes).toEqual([false, true, true]);
    expect(result.muted).toBe(true);
    expect(result.preset).toBe(2);
    expect(result.volume).toBe(12.34);
    expect(result.raw.slice(9, 15)).toEqual(fresh.slice(9, 15));
    expect(result.raw[9] & 2).toBe(0);
    expect(mutations(panel)).toHaveLength(1);
    const finalRead = panel.requests.at(-2)!;
    expect(Array.from(finalRead.slice(0, 2))).toEqual([5, 1]);
  });

  it('shares runtime volume/mute permission, including a locked zero-mask panel', async () => {
    const { panel, session } = fixture();
    panel.status[51] = 2;
    panel.status[24] = panel.status[25] = 0;
    expect(requiredControlOperations({ outputMute: { channel: 1, muted: true } })).toEqual([
      'volumeMute',
    ]);
    expect(requiredControlOperations({ channelMutes: [true, false, true] })).toEqual([
      'volumeMute',
    ]);
    await expect(
      session.setControls({ outputMute: { channel: 1, muted: false } }),
    ).resolves.toMatchObject({
      channelMutes: [false, false, true],
      locked: true,
    });
    expect(mutations(panel)).toHaveLength(1);
  });

  it('checks the common control readback and refuses a different returned mute bit without retry', async () => {
    const { panel } = fixture();
    const session = new PanelSession(
      {
        exchange: async (request) => {
          const reply = await panel.exchange(request);
          if (request[0] === 5 && request[1] === 0) reply[6] ^= 2;
          return reply;
        },
        close: async () => {},
      },
      async () => {},
    );
    await expect(session.setControls({ outputMute: { channel: 2, muted: true } })).rejects.toThrow(
      'Control readback mismatch at byte 6',
    );
    expect(mutations(panel)).toHaveLength(1);
  });
});

async function toolFixture() {
  const left = fixture('SYNTHETIC-LEFT'),
    right = fixture('SYNTHETIC-RIGHT');
  const connections = {
    left: {
      session: left.session,
      identity: await left.session.identify(),
      status: await left.session.status(),
    },
    right: {
      session: right.session,
      identity: await right.session.identify(),
      status: await right.session.status(),
    },
  };
  for (const { panel } of [left, right]) panel.requests.length = 0;
  const forbidden = vi.fn(() => {
    throw new Error('Unexpected document or connection change');
  });
  const adapter: ToolAdapter = {
    state: vi.fn(() => ({
      documents: { left: newProject('Left'), right: newProject('Right') },
      slot: 'left' as const,
      preset: 0,
      channel: 0,
      filter: 0,
      linkedEdits: true,
      linkedControls: true,
    })),
    edit: forbidden,
    choose: forbidden,
    undo: forbidden,
    redo: forbidden,
    connections: vi.fn(() => connections),
    connect: forbidden,
    disconnect: forbidden,
    refresh: vi.fn(async () => {}),
    operate: vi.fn(async (_, fn) => fn()),
    message: vi.fn(),
    progress: forbidden,
    view: forbidden,
  };
  return { left, right, adapter, forbidden, execute: createToolExecutor(adapter) };
}

it.each(invalid)(
  'rejects malformed MCP output mute before workspace access or device I/O: %j',
  async (patch) => {
    const f = await toolFixture();
    expect(controlsSchema.safeParse(patch).success).toBe(false);
    expect(await f.execute('fusion_controls', { target: 'right', patch })).toMatchObject({
      ok: false,
    });
    expect(f.adapter.state).not.toHaveBeenCalled();
    expect(f.adapter.connections).not.toHaveBeenCalled();
    expect(f.adapter.operate).not.toHaveBeenCalled();
    expect(f.left.panel.requests).toEqual([]);
    expect(f.right.panel.requests).toEqual([]);
  },
);

it('MCP uses the shared session intent for the explicit role despite linked controls', async () => {
  const f = await toolFixture(),
    before = f.right.panel.status.slice();
  expect(
    await f.execute('fusion_controls', {
      target: 'right',
      patch: { outputMute: { channel: 2, muted: true } },
    }),
  ).toMatchObject({ ok: true });
  expect(f.left.panel.requests).toEqual([]);
  expect(decodeStatus(f.right.panel.status).channelMutes).toEqual([true, true, true]);
  expect(f.right.panel.status.slice(9, 15)).toEqual(before.slice(9, 15));
  expect(f.right.panel.status[9] & 2).toBe(0);
  expect(mutations(f.right.panel)).toHaveLength(1);
  expect(f.adapter.refresh).toHaveBeenCalledWith(['right']);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('reports uncertain output mute readback without a second setter or master mute', async () => {
  const f = await toolFixture();
  f.right.panel.status[6] &= 0x7f;
  const before = f.right.panel.status.slice(),
    exchange = f.right.panel.exchange.bind(f.right.panel);
  vi.spyOn(f.right.panel, 'exchange').mockImplementation(async (request) => {
    const reply = await exchange(request);
    if (request[0] === 5 && request[1] === 0) reply[6] ^= 2;
    return reply;
  });
  expect(
    await f.execute('fusion_controls', {
      target: 'right',
      patch: { outputMute: { channel: 2, muted: true } },
    }),
  ).toMatchObject({
    ok: false,
    error: expect.stringContaining('Control readback mismatch at byte 6'),
  });
  expect(mutations(f.right.panel)).toHaveLength(1);
  expect(f.left.panel.requests).toEqual([]);
  expect(f.right.panel.status[6] & ~2).toBe(before[6] & ~2);
  expect(decodeStatus(f.right.panel.status).muted).toBe(false);
  expect(decodeStatus(f.right.panel.status).channelMutes).toEqual([true, true, true]);
  expect(f.right.panel.status.slice(9, 15)).toEqual(before.slice(9, 15));
  expect(f.right.panel.status[9] & 2).toBe(0);
  expect(f.adapter.refresh).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});
