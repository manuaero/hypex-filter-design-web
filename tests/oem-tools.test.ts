import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createToolExecutor, type DocumentState, type ToolAdapter } from '../src/application/tools';
import { newProject, type Slot } from '../src/domain/model';
import { decodeStatus, settings } from '../src/hardware/codec';
import { OEM_ITEMS, type ProtectionReport } from '../src/hardware/protection';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { saveConfigurationBackup } from '../src/hardware/storage';

vi.mock('../src/hardware/storage', async (original) => ({
  ...(await original<typeof import('../src/hardware/storage')>()),
  saveConfigurationBackup: vi.fn(async () => {}),
}));
beforeEach(() => vi.mocked(saveConfigurationBackup).mockClear());
const mask = (...ids: string[]) =>
  ids.reduce((value, id) => value | OEM_ITEMS.find((item) => item.id === id)!.mask, 0);
const limiter = Array.from({ length: 3 }, () => ({
  watts: 25,
  ohms: 4,
  attackMs: 10,
  releaseMs: 250,
}));
const writes = (panel: SimulatedPanel) =>
  panel.requests.filter(
    (request) =>
      request[0] === 0x64 ||
      ((request[0] === 5 || request[0] === 3) && request[1] === 0) ||
      (request[0] === 0x66 && request[1] === 1) ||
      (request[0] === 8 && request[1] !== 128),
  );
type Reply = {
  ok: boolean;
  error?: string;
  devices?: {
    slot: Slot;
    protection: ProtectionReport;
    power?: { mode: string };
    limiter?: unknown[];
  }[];
};
async function setup() {
  const panels = {
    left: new SimulatedPanel('OEM-TOOLS-LEFT'),
    right: new SimulatedPanel('OEM-TOOLS-RIGHT'),
  };
  for (const panel of Object.values(panels)) {
    panel.configuration[4] = 0x10;
    panel.status[6] = 0;
    panel.deviceConfiguration[11] = 1;
  }
  const sessions = {
    left: new PanelSession(panels.left, async () => {}),
    right: new PanelSession(panels.right, async () => {}),
  };
  const connections = {
    left: {
      session: sessions.left,
      identity: await sessions.left.identify(),
      status: await sessions.left.status(),
    },
    right: {
      session: sessions.right,
      identity: await sessions.right.identify(),
      status: await sessions.right.status(),
    },
  };
  for (const panel of Object.values(panels)) panel.requests.length = 0;
  let state: DocumentState = {
    documents: { left: newProject('Left'), right: newProject('Right') },
    slot: 'left',
    preset: 0,
    channel: 0,
    filter: 0,
    linkedEdits: true,
    linkedControls: true,
  };
  const edit = vi.fn<ToolAdapter['edit']>((slots, change) => {
    const documents = structuredClone(state.documents);
    slots.forEach((slot) => change(documents[slot]));
    state = { ...state, documents };
  });
  const refresh = vi.fn(async (slots: Slot[]) => {
    for (const slot of slots) connections[slot].status = await sessions[slot].status();
  });
  const adapter: ToolAdapter = {
    state: () => state,
    edit,
    choose: (patch) => {
      state = { ...state, ...patch };
    },
    undo: vi.fn(),
    redo: vi.fn(),
    connections: () => connections,
    connect: async () => {},
    disconnect: async () => {},
    refresh,
    operate: async (_label, fn) => fn(),
    message: vi.fn(),
    progress: vi.fn(),
    view: vi.fn(),
  };
  const protect = (slot: Slot, value: number, moduleType = 1, flags = 2) => {
    const panel = panels[slot];
    panel.status[51] = flags;
    panel.status[24] = value & 255;
    panel.status[25] = value >> 8;
    panel.deviceConfiguration[11] = moduleType;
  };
  return {
    panels,
    sessions,
    protect,
    refresh,
    edit,
    state: () => state,
    execute: createToolExecutor(adapter),
  };
}

describe('OEM permission-aware existing MCP tools', () => {
  it('reports fresh native permission inventory independently of actual allowed runtime and module-qualified operations', async () => {
    const s = await setup();
    s.protect('left', 0, 1);
    s.protect('right', 0xffff, 9);
    const result = (await s.execute('fusion_device_read', { target: 'both' })) as Reply;
    expect(result.ok).toBe(true);
    const left = result.devices!.find((device) => device.slot === 'left')!.protection;
    expect(left).toMatchObject({
      passwordProtected: true,
      passwordMatched: false,
      locked: true,
      rawMask: 0,
      effectiveMask: 0,
      moduleType: 1,
      isOemConfigured: true,
    });
    expect(left.items).toHaveLength(14);
    expect(left.items.every((item) => !item.maskEnabled)).toBe(true);
    for (const id of ['inputSource', 'volumeMute', 'preset'] as const)
      expect(left.operations[id].allowed).toBe(true);
    expect(left.operations.deviceSettings.allowed).toBe(false);
    const right = result.devices!.find((device) => device.slot === 'right')!.protection;
    expect(right.rawMask).toBe(0xffff);
    expect(right.isOemConfigured).toBe(false);
    expect(right.operations.deviceSettings.allowed).toBe(false);
    expect(right.operations.equalizer.allowed).toBe(false);
    expect(right.operations.uploadFilters.allowed).toBe(true);
    expect(writes(s.panels.left)).toHaveLength(0);
    expect(writes(s.panels.right)).toHaveLength(0);
    expect(s.edit).not.toHaveBeenCalled();
  });

  it('keeps native input/volume/mute/channel-mutes/preset available with a zero mask on protected non-OEM panels', async () => {
    const s = await setup();
    s.protect('left', 0, 9);
    s.protect('right', 0, 9);
    expect(
      await s.execute('fusion_controls', {
        target: 'both',
        patch: {
          forceInput: 3,
          volume: -12,
          mute: false,
          channelMutes: [true, false, true],
          preset: 2,
        },
      }),
    ).toEqual({ ok: true });
    for (const panel of Object.values(s.panels)) {
      expect(decodeStatus(panel.status)).toMatchObject({
        volume: -12,
        muted: false,
        preset: 2,
        channelMutes: [true, false, true],
        locked: true,
      });
      expect(panel.status[13] & 15).toBe(3);
      expect(panel.status[24] | (panel.status[25] << 8)).toBe(0);
      expect(writes(panel)).toHaveLength(1);
    }
    expect(s.refresh).toHaveBeenCalledExactlyOnceWith(['left', 'right']);
    expect(s.edit).not.toHaveBeenCalled();
  });

  it('preflights actual independent relative volumes even when no display field is present', async () => {
    const s = await setup();
    s.protect('left', 0, 9);
    s.protect('right', 0, 9);
    new DataView(s.panels.left.status.buffer).setInt16(3, -1000, true);
    new DataView(s.panels.right.status.buffer).setInt16(3, -2000, true);
    expect(
      await s.execute('fusion_controls', {
        target: 'both',
        relativeVolume: true,
        patch: { volume: 2 },
      }),
    ).toEqual({ ok: true });
    expect(decodeStatus(s.panels.left.status).volume).toBe(-8);
    expect(decodeStatus(s.panels.right.status).volume).toBe(-18);
    new DataView(s.panels.left.status.buffer).setInt16(3, 0, true);
    new DataView(s.panels.right.status.buffer).setInt16(3, 1800, true);
    for (const panel of Object.values(s.panels)) panel.requests.length = 0;
    const invalid = (await s.execute('fusion_controls', {
      target: 'both',
      relativeVolume: true,
      patch: { volume: 1 },
    })) as Reply;
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain('right:');
    expect(writes(s.panels.left)).toHaveLength(0);
    expect(writes(s.panels.right)).toHaveLength(0);
    expect(decodeStatus(s.panels.left.status)).toMatchObject({ volume: 0, muted: false });
    expect(decodeStatus(s.panels.right.status)).toMatchObject({ volume: 18, muted: false });
  });

  it('preflights a composite patch on every role and does not mute a permitted amp when another role denies one child item', async () => {
    const s = await setup();
    s.protect('left', mask('deviceSettings', 'softclipLimiter'));
    s.protect('right', mask('deviceSettings'));
    const left = vi.spyOn(s.sessions.left, 'preflightControls'),
      right = vi.spyOn(s.sessions.right, 'preflightControls');
    const result = (await s.execute('fusion_controls', {
      target: 'both',
      patch: { softClip: true, volume: -18 },
    })) as Reply;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('right:');
    expect(result.error).toContain('softclipLimiter');
    expect(left).toHaveBeenCalledTimes(1);
    expect(right).toHaveBeenCalledTimes(1);
    for (const panel of Object.values(s.panels)) {
      expect(writes(panel)).toHaveLength(0);
      expect(decodeStatus(panel.status).muted).toBe(false);
    }
    expect(s.refresh).not.toHaveBeenCalled();
  });

  it('honors locked OEM settings-entry plus child permissions and leaves ordinary unlocked wire ranges intact', async () => {
    const s = await setup();
    const allowed = mask(
      'deviceSettings',
      'softclipLimiter',
      'bridge',
      'masterSlave',
      'dacFilter',
      'digitalLeftRight',
    );
    s.protect('left', allowed);
    expect(
      await s.execute('fusion_controls', {
        target: 'left',
        patch: {
          softClip: true,
          bridge: true,
          master: false,
          dacFilter: 4,
          soundQuality: 3,
          routing: 2,
          powerOffMinutes: 30,
          oledMaximumBrightness: 15,
          standbyLedMode: 0,
        },
      }),
    ).toEqual({ ok: true });
    expect(settings(decodeStatus(s.panels.left.status))).toMatchObject({
      softClip: true,
      bridge: true,
      master: false,
      dacFilter: 4,
      soundQuality: 3,
      powerOffMinutes: 30,
      oledMaximumBrightness: 15,
      standbyLedMode: 0,
    });
    expect(s.panels.left.status[11] & 7).toBe(2);
    expect(s.panels.left.status[24] | (s.panels.left.status[25] << 8)).toBe(allowed);
    expect(decodeStatus(s.panels.left.status).locked).toBe(true);
    expect(
      await s.execute('fusion_controls', {
        target: 'right',
        patch: { dacFilter: 7, soundQuality: 4 },
      }),
    ).toEqual({ ok: true });
    expect(settings(decodeStatus(s.panels.right.status))).toMatchObject({
      dacFilter: 7,
      soundQuality: 4,
    });
  });

  it('refuses unknown live fields under lock even with every mask bit, while offline design edits remain unrestricted', async () => {
    const s = await setup();
    s.protect('left', 0xffff);
    s.protect('right', 0xffff);
    const result = (await s.execute('fusion_controls', {
      target: 'both',
      patch: { sourceLock: true },
    })) as Reply;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unlocked panel');
    expect(writes(s.panels.left)).toHaveLength(0);
    expect(writes(s.panels.right)).toHaveLength(0);
    for (const panel of Object.values(s.panels)) panel.requests.length = 0;
    expect(
      await s.execute('fusion_channel_set', {
        target: 'left',
        preset: 1,
        channel: 1,
        patch: { gain: -3 },
      }),
    ).toEqual({ ok: true });
    expect(s.state().documents.left.presets[0].channels[0].gain).toBe(-3);
    expect(s.panels.left.requests).toHaveLength(0);
    expect(s.panels.right.requests).toHaveLength(0);
  });

  it('preflights both power targets before either setPower can mute or request a transition', async () => {
    const s = await setup();
    s.protect('left', mask('deviceSettings'));
    s.protect('right', 0);
    const left = vi.spyOn(s.sessions.left, 'setPower'),
      right = vi.spyOn(s.sessions.right, 'setPower');
    const denied = (await s.execute('fusion_power', { target: 'both', state: 'off' })) as Reply;
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('right:');
    expect(left).not.toHaveBeenCalled();
    expect(right).not.toHaveBeenCalled();
    expect(writes(s.panels.left)).toHaveLength(0);
    expect(writes(s.panels.right)).toHaveLength(0);
    s.protect('right', mask('deviceSettings'));
    const blocked = (await s.execute('fusion_power', { target: 'both', state: 'off' })) as Reply;
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('USB loss');
    expect(writes(s.panels.left)).toHaveLength(0);
    expect(writes(s.panels.right)).toHaveLength(0);
    // Source-only ON remains separately exercised, with no OFF command/cycle.
    s.panels.left.powerMode = s.panels.right.powerMode = 0;
    const permitted = (await s.execute('fusion_power', { target: 'both', state: 'on' })) as Reply;
    expect(permitted.ok).toBe(true);
    expect(permitted.devices!.map((device) => [device.slot, device.power!.mode])).toEqual([
      ['left', 'on'],
      ['right', 'on'],
    ]);
    expect(decodeStatus(s.panels.left.status).muted).toBe(true);
    expect(decodeStatus(s.panels.right.status).muted).toBe(true);
  });

  it('also blocks statically decoded but physically unqualified5.82 OFF through the shared MCP executor without writes', async () => {
    const s = await setup();
    for (const slot of ['left', 'right'] as const) {
      new DataView(s.panels[slot].configuration.buffer).setUint16(17, 82, true);
      await s.sessions[slot].identify();
      s.panels[slot].requests.length = 0;
    }
    const result = (await s.execute('fusion_power', { target: 'both', state: 'off' })) as Reply;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('has not been qualified');
    for (const panel of Object.values(s.panels)) {
      expect(writes(panel)).toHaveLength(0);
      expect(panel.powerMode).toBe(2);
    }
  });

  it('advertises the OFF qualification limit in connection state without a USB query', async () => {
    const s = await setup();
    for (const panel of Object.values(s.panels)) panel.requests.length = 0;
    expect(await s.execute('fusion_state', {})).toMatchObject({
      ok: true,
      connections: {
        left: { powerOff: { available: false, reason: expect.stringContaining('USB loss') } },
        right: { powerOff: { available: false, reason: expect.stringContaining('USB loss') } },
      },
    });
    for (const panel of Object.values(s.panels)) expect(panel.requests).toHaveLength(0);
  });

  it('preflights all limiter permissions and live configuration before either amp is muted or configured', async () => {
    for (const invalid of ['permission', 'configuration']) {
      const s = await setup();
      s.protect('left', mask('deviceSettings', 'softclipLimiter'));
      s.protect('right', mask('deviceSettings', 'softclipLimiter'));
      if (invalid === 'permission') s.protect('right', mask('deviceSettings'));
      else s.panels.right.deviceConfiguration[12] = 0;
      const left = vi.spyOn(s.sessions.left, 'setLimiter'),
        right = vi.spyOn(s.sessions.right, 'setLimiter');
      const result = (await s.execute('fusion_limiter_set', {
        target: 'both',
        channels: limiter,
      })) as Reply;
      expect(result.ok).toBe(false);
      expect(result.error).toContain('right:');
      expect(left).not.toHaveBeenCalled();
      expect(right).not.toHaveBeenCalled();
      expect(writes(s.panels.left)).toHaveLength(0);
      expect(writes(s.panels.right)).toHaveLength(0);
      expect(saveConfigurationBackup).not.toHaveBeenCalled();
    }
  });

  it('updates a permitted locked OEM pair limiter with existing verification, backups and mute behavior', async () => {
    const s = await setup();
    s.protect('left', mask('deviceSettings', 'softclipLimiter'));
    s.protect('right', mask('deviceSettings', 'softclipLimiter'));
    const result = (await s.execute('fusion_limiter_set', {
      target: 'both',
      channels: limiter,
    })) as Reply;
    expect(result.ok).toBe(true);
    expect(result.devices).toHaveLength(2);
    expect(saveConfigurationBackup).toHaveBeenCalledTimes(2);
    for (const panel of Object.values(s.panels)) {
      expect(
        panel.requests.filter((request) => request[0] === 0x66 && request[1] === 1),
      ).toHaveLength(1);
      expect(decodeStatus(panel.status)).toMatchObject({ muted: true, locked: true });
      expect(panel.deviceConfiguration.slice(59, 62)).toEqual(new Uint8Array([5, 5, 5]));
    }
    expect(s.refresh).toHaveBeenCalledExactlyOnceWith(['left', 'right']);
    expect(s.edit).not.toHaveBeenCalled();
  });
});
