import { describe, expect, it, vi } from 'vitest';
import {
  createToolExecutor,
  TOOL_DEFINITIONS,
  type ToolAdapter,
  type DocumentState,
} from '../src/application/tools';
import { newProject, type Slot } from '../src/domain/model';
import { PanelSession } from '../src/hardware/session';
import { decodeStatus, settings } from '../src/hardware/codec';
import { SimulatedPanel } from '../src/hardware/simulator';
import type { PanelMetering } from '../src/hardware/metering';

type Reply = {
  ok: boolean;
  error?: string;
  devices?: {
    slot: Slot;
    identity: { name: string };
    options: Record<string, unknown>;
    hardware: Record<string, unknown>;
    limiter: { amplifier: number; channels: unknown[] };
    power: { mode: string };
    metering: PanelMetering;
  }[];
};
const controlWrites = (panel: SimulatedPanel) =>
  panel.requests.filter((request) => request[0] === 5 && request[1] === 0);
async function setup() {
  const panels = {
    left: new SimulatedPanel('LEFT-DEVICE-TOOLS'),
    right: new SimulatedPanel('RIGHT-DEVICE-TOOLS'),
  };
  for (const panel of Object.values(panels)) {
    panel.configuration[4] = 0x95;
    panel.status[6] = 0;
    panel.status[23] = 0xff;
    panel.status[35] = 0xa5;
    panel.status[36] = 0xe7;
    panel.deviceConfiguration[11] = 9;
    panel.deviceConfiguration[13] = 1;
    panel.deviceConfiguration[14] = 0x81;
    panel.deviceConfiguration[15] = 55;
    const view = new DataView(panel.deviceConfiguration.buffer);
    view.setInt16(16, -1234, true);
    view.setUint16(18, 0x1234, true);
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
  const state: DocumentState = {
    documents: { left: newProject('Left'), right: newProject('Right') },
    slot: 'left',
    preset: 0,
    channel: 0,
    filter: 0,
    linkedEdits: true,
    linkedControls: true,
  };
  const noDocumentEdit = vi.fn(() => {
    throw new Error('Device tools must not edit design documents');
  });
  const refresh = vi.fn(async (slots: Slot[]) => {
    for (const slot of slots) connections[slot].status = await sessions[slot].status();
  });
  const adapter: ToolAdapter = {
    state: () => state,
    edit: noDocumentEdit,
    choose: noDocumentEdit,
    undo: noDocumentEdit,
    redo: noDocumentEdit,
    connections: () => connections,
    connect: async () => {
      throw new Error('No connection changes in device tools');
    },
    disconnect: async () => {},
    refresh,
    operate: async (_label, action) => action(),
    message: vi.fn(),
    progress: vi.fn(),
    view: vi.fn(),
  };
  return { panels, sessions, state, refresh, noDocumentEdit, execute: createToolExecutor(adapter) };
}

describe('OLED/standby and hardware overview MCP parity', () => {
  it('shares native Slave coupling and detection clamping with UI controls, retaining the unselected amplifier', async () => {
    const s = await setup(),
      before = s.panels.right.status.slice(),
      v = new DataView(s.panels.left.status.buffer);
    v.setUint16(9, 9, true);
    v.setInt16(21, -5000, true);
    s.panels.left.status[7] = 1;
    s.panels.left.status[24] = 0xa5;
    s.panels.left.status[25] = 0x5a;
    expect(
      await s.execute('fusion_controls', { target: 'left', patch: { master: false } }),
    ).toEqual({ ok: true });
    expect(settings(decodeStatus(s.panels.left.status))).toMatchObject({
      master: false,
      wakeOnLine: false,
      signalDetection: false,
      startupVolume: -200,
      standbyMode: 0,
      irRemoteMasterIndicator: false,
    });
    expect(s.panels.left.status.slice(24, 26)).toEqual(Uint8Array.of(0xa5, 0x5a));
    s.panels.left.status[27] = 15;
    expect(
      await s.execute('fusion_controls', { target: 'left', patch: { detectionOn: 1 } }),
    ).toEqual({ ok: true });
    expect(s.panels.left.status[27]).toBe(5);
    expect(s.panels.right.status).toEqual(before);
    expect(s.panels.right.requests).toHaveLength(0);
    expect(s.noDocumentEdit).not.toHaveBeenCalled();
  });

  it('accepts native sources S/PDIF4, AES5 and Future7 for one role without changing preset flags or documents', async () => {
    const s = await setup();
    s.panels.left.status[12] = 0xa1;
    const untouched = s.panels.right.status.slice();
    for (const value of [4, 5, 7]) {
      expect(
        await s.execute('fusion_controls', { target: 'left', patch: { forceInput: value } }),
      ).toEqual({ ok: true });
      expect(controlWrites(s.panels.left).at(-1)![12]).toBe(0xa0 | value);
      expect(s.panels.left.status[12]).toBe(0xa0 | value);
    }
    expect(controlWrites(s.panels.left)).toHaveLength(3);
    expect(s.panels.right.status).toEqual(untouched);
    expect(s.panels.right.requests).toHaveLength(0);
    expect(s.noDocumentEdit).not.toHaveBeenCalled();
  });

  it('rejects out-of-range native source input before any selected amplifier query or write', async () => {
    const s = await setup();
    for (const forceInput of [-1, 8, 15, 0.5])
      expect(
        ((await s.execute('fusion_controls', { target: 'both', patch: { forceInput } })) as Reply)
          .ok,
      ).toBe(false);
    expect(s.panels.left.requests).toHaveLength(0);
    expect(s.panels.right.requests).toHaveLength(0);
    expect(s.refresh).not.toHaveBeenCalled();
    expect(s.noDocumentEdit).not.toHaveBeenCalled();
  });

  it('extends the existing controls schema and writes only the explicitly selected role, including zero OLED values', async () => {
    const s = await setup();
    const schema = TOOL_DEFINITIONS.find((tool) => tool.name === 'fusion_controls')!.inputSchema;
    expect(schema.type).toBe('object');
    const untouched = s.panels.right.status.slice();
    expect(
      await s.execute('fusion_controls', {
        target: 'left',
        patch: { oledMaximumBrightness: 0, oledDimmedBrightness: 15, standbyLedMode: 0 },
      }),
    ).toEqual({ ok: true });
    expect(settings(decodeStatus(s.panels.left.status))).toMatchObject({
      oledMaximumBrightness: 0,
      oledDimmedBrightness: 15,
      standbyLedMode: 0,
    });
    expect(s.panels.left.status[35]).toBe(0x0f);
    expect(s.panels.left.status[36]).toBe(0xe0);
    expect(controlWrites(s.panels.left)).toHaveLength(1);
    expect(controlWrites(s.panels.left)[0][23]).toBe(8);
    expect(s.panels.right.status).toEqual(untouched);
    expect(s.panels.right.requests).toHaveLength(0);
    expect(s.refresh).toHaveBeenCalledExactlyOnceWith(['left']);
    expect(s.noDocumentEdit).not.toHaveBeenCalled();
  });

  it('preflights both roles before any display write and never mutes on an initial missing-OLED or locked refusal', async () => {
    for (const failure of ['missing-oled', 'locked'] as const) {
      const s = await setup();
      if (failure === 'missing-oled') s.panels.right.configuration[4] &= ~0x10;
      else s.panels.right.status[51] = 2;
      const leftPreflight = vi.spyOn(s.sessions.left, 'preflightControls');
      const rightPreflight = vi.spyOn(s.sessions.right, 'preflightControls');
      const result = (await s.execute('fusion_controls', {
        target: 'both',
        patch: { oledDimmedBrightness: 0 },
      })) as Reply;
      expect(result.ok).toBe(false);
      expect(leftPreflight).toHaveBeenCalledTimes(1);
      expect(rightPreflight).toHaveBeenCalledTimes(1);
      expect(controlWrites(s.panels.left)).toHaveLength(0);
      expect(controlWrites(s.panels.right)).toHaveLength(0);
      expect(decodeStatus(s.panels.left.status).muted).toBe(false);
      expect(decodeStatus(s.panels.right.status).muted).toBe(false);
      expect(s.refresh).not.toHaveBeenCalled();
      expect(s.noDocumentEdit).not.toHaveBeenCalled();
    }
  });

  it('validates display input before any operation and preserves standby selection semantics without OLED', async () => {
    const s = await setup();
    for (const patch of [
      { oledMaximumBrightness: -1 },
      { oledMaximumBrightness: 16 },
      { oledDimmedBrightness: 0.5 },
      { oledDimmedBrightness: Infinity },
      { standbyLedMode: -1 },
      { standbyLedMode: 4 },
      { oledVersion: 1 },
    ])
      expect(((await s.execute('fusion_controls', { target: 'both', patch })) as Reply).ok).toBe(
        false,
      );
    expect(s.panels.left.requests).toHaveLength(0);
    expect(s.panels.right.requests).toHaveLength(0);
    s.panels.left.configuration[4] = 0;
    for (const mode of [0, 1, 2, 3]) {
      expect(
        (
          (await s.execute('fusion_controls', {
            target: 'left',
            patch: { standbyLedMode: mode },
          })) as Reply
        ).ok,
      ).toBe(true);
      expect(settings(decodeStatus(s.panels.left.status)).standbyLedMode).toBe(mode);
      expect(s.panels.left.status[36] & 0xfc).toBe(0xe0);
      expect(s.panels.left.status[35]).toBe(0xa5);
    }
    expect(controlWrites(s.panels.left)).toHaveLength(4);
    expect(s.panels.right.requests).toHaveLength(0);
  });

  it('preflights each actual relative-volume destination before a combined display change can write', async () => {
    const s = await setup();
    new DataView(s.panels.left.status.buffer).setInt16(3, 0, true);
    new DataView(s.panels.right.status.buffer).setInt16(3, 1800, true);
    const result = (await s.execute('fusion_controls', {
      target: 'both',
      relativeVolume: true,
      patch: { volume: 1, oledMaximumBrightness: 0 },
    })) as Reply;
    expect(result.ok).toBe(false);
    expect(controlWrites(s.panels.left)).toHaveLength(0);
    expect(controlWrites(s.panels.right)).toHaveLength(0);
    expect(decodeStatus(s.panels.left.status)).toMatchObject({ volume: 0, muted: false });
    expect(decodeStatus(s.panels.right.status)).toMatchObject({ volume: 18, muted: false });
  });

  it('preserves existing paired controls and retains pair-mute recovery after a real display write/readback failure', async () => {
    const s = await setup();
    expect(
      await s.execute('fusion_controls', { target: 'both', patch: { volume: -12, mute: false } }),
    ).toEqual({ ok: true });
    expect(decodeStatus(s.panels.left.status).volume).toBe(-12);
    expect(decodeStatus(s.panels.right.status).volume).toBe(-12);
    const exchange = s.panels.left.exchange.bind(s.panels.left);
    let fail = true;
    s.panels.left.exchange = async (request) => {
      const reply = await exchange(request);
      if (fail && request[0] === 5 && request[1] === 0 && request[23] & 8) {
        fail = false;
        reply[35] ^= 1;
      }
      return reply;
    };
    const result = (await s.execute('fusion_controls', {
      target: 'both',
      patch: { oledMaximumBrightness: 8 },
    })) as Reply;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('readback mismatch');
    expect(decodeStatus(s.panels.left.status).muted).toBe(true);
    expect(decodeStatus(s.panels.right.status).muted).toBe(true);
    expect(controlWrites(s.panels.left).length).toBeGreaterThanOrEqual(3);
    expect(controlWrites(s.panels.right).length).toBeGreaterThanOrEqual(3);
    expect(s.noDocumentEdit).not.toHaveBeenCalled();
  });

  it('returns a fresh read-only hardware overview while preserving all existing device-read fields', async () => {
    const s = await setup();
    s.panels.left.name = 'Fresh panel name';
    s.panels.left.configuration[4] = 0x91;
    s.panels.left.deviceConfiguration[11] = 7;
    s.panels.left.deviceConfiguration[13] = 0;
    const meterBytes = new DataView(s.panels.left.status.buffer);
    meterBytes.setUint16(44, 960, true);
    meterBytes.setInt16(46, 4096, true);
    meterBytes.setInt16(48, 2048, true);
    s.panels.left.status[6] &= 127;
    const result = (await s.execute('fusion_device_read', { target: 'left' })) as Reply;
    expect(result.ok).toBe(true);
    expect(result.devices).toHaveLength(1);
    const device = result.devices![0];
    expect(device.slot).toBe('left');
    expect(device.identity.name).toBe('Fresh panel name');
    expect(device.options).toMatchObject({
      oledMaximumBrightness: 10,
      oledDimmedBrightness: 5,
      standbyLedMode: 3,
    });
    expect(device.hardware).toMatchObject({
      systemSetup: 0x91,
      oledCapable: true,
      amplifier: 5,
      moduleType: 7,
      product: 22,
      thirdChannelEnabled: false,
      fanConnected: true,
      stereoDsp: true,
      temperatureSetpoint: 55,
      dspPeakSetpoint: -1234,
      oledVersion: 0x1234,
    });
    expect(device.limiter.amplifier).toBe(5);
    expect(device.limiter.channels).toHaveLength(3);
    expect(device.power.mode).toBe('on');
    expect(device.metering).toMatchObject({
      inputPeakDb: 0,
      actualSampleRateHz: 96000,
      outputSuppressedByMute: false,
    });
    expect(device.metering.outputPeakDb).toBeCloseTo(-6.020599913, 8);
    expect(controlWrites(s.panels.left)).toHaveLength(0);
    expect(
      s.panels.left.requests.every(
        (request) =>
          request[0] === 6 ||
          (request[0] === 0x66 && request[1] === 0) ||
          (request[0] === 5 && request[1] === 1) ||
          (request[0] === 3 && request[1] === 8) ||
          request[0] === 0x65 ||
          (request[0] === 8 && request[1] === 128),
      ),
    ).toBe(true);
    expect(s.panels.right.requests).toHaveLength(0);
    expect(s.noDocumentEdit).not.toHaveBeenCalled();
  });
});
