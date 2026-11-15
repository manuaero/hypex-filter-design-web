import { expect, it, vi } from 'vitest';
import { decodeStatus, packet } from '../src/hardware/codec';
import { decodeMetering, meterDisplayDb, METER_ZERO_DB } from '../src/hardware/metering';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';
import { newProject } from '../src/domain/model';
import type { Identity, PanelSession } from '../src/hardware/session';

function status(input: number, output: number, muted = false, rate = 480) {
  const bytes = packet(5, 6, 1),
    view = new DataView(bytes.buffer);
  bytes[6] = muted ? 128 : 0;
  view.setUint16(44, rate, true);
  view.setInt16(46, input, true);
  view.setInt16(48, output, true);
  return decodeStatus(bytes);
}

it('decodes aggregate signed LE peaks and actual sample rate from a nonzero byte-offset buffer', () => {
  const fixture = status(4096, 2048, false, 960);
  const offset = new Uint8Array(80);
  offset.set(fixture.raw, 9);
  const decoded = decodeMetering({ ...fixture, raw: offset.subarray(9, 73) });
  expect(decoded.inputPeakDb).toBe(0);
  expect(decoded.outputPeakDb).toBeCloseTo(-6.020599913, 8);
  expect(decoded.actualSampleRateHz).toBe(96000);
  expect(decoded.outputSuppressedByMute).toBe(false);
  expect(fixture.raw[46]).toBe(0);
  expect(fixture.raw[47]).toBe(16);
});

it('substitutes one only for exact zero and suppresses output while master muted', () => {
  expect(decodeMetering(status(0, 0)).inputPeakDb).toBeCloseTo(-72.247198959, 8);
  const muted = decodeMetering(status(8192, 16384, true));
  expect(muted.inputPeakDb).toBeCloseTo(6.020599913, 8);
  expect(muted.outputPeakDb).toBe(METER_ZERO_DB);
  expect(muted.outputSuppressedByMute).toBe(true);
});

it('retains invalid negative samples as unavailable and clamps only visual meter extents', () => {
  const values = decodeMetering(status(-1, -32768));
  expect(values.inputPeakDb).toBeNull();
  expect(values.outputPeakDb).toBeNull();
  expect(decodeMetering(status(1, -1, true)).outputPeakDb).toBe(METER_ZERO_DB);
  const above = decodeMetering(status(32767, 4096));
  expect(above.inputPeakDb).toBeGreaterThan(18);
  expect(meterDisplayDb(above.inputPeakDb)).toBe(18);
  expect(meterDisplayDb(METER_ZERO_DB)).toBe(-72);
  expect(meterDisplayDb(null)).toBeUndefined();
  expect(meterDisplayDb(NaN)).toBeUndefined();
});

it('rejects wrong-length and wrong-command status instead of constructing a meter reading', () => {
  const fixture = status(1, 1);
  expect(() => decodeMetering({ ...fixture, raw: fixture.raw.subarray(1) })).toThrow();
  fixture.raw[0] = 8;
  expect(() => decodeMetering(fixture)).toThrow();
});

it('shares independent cached stereo readings and meter visibility through existing agent tools without USB calls', async () => {
  const left = status(4096, 2048),
    right = status(8192, 16384, true, 441);
  const state = {
    documents: { left: newProject('Left'), right: newProject('Right') },
    slot: 'left' as const,
    preset: 0,
    channel: 0,
    filter: 0,
    linkedEdits: true,
    linkedControls: true,
  };
  const view = vi.fn(),
    calls = vi.fn();
  const identity = (serial: string) => ({ serial }) as Identity;
  const adapter: ToolAdapter = {
    state: () => state,
    edit: calls,
    choose: calls,
    undo: calls,
    redo: calls,
    connections: () => ({
      left: { identity: identity('LEFT'), status: left, session: {} as PanelSession },
      right: { identity: identity('RIGHT'), status: right, session: {} as PanelSession },
    }),
    connect: calls,
    disconnect: calls,
    refresh: calls,
    operate: async (_, fn) => fn(),
    message: () => {},
    progress: () => {},
    view,
  };
  const execute = createToolExecutor(adapter);
  const result = (await execute('fusion_state', { includeProjects: false })) as {
    connections: {
      left: { metering: ReturnType<typeof decodeMetering> };
      right: { metering: ReturnType<typeof decodeMetering> };
    };
  };
  expect(result.connections.left.metering).toEqual(decodeMetering(left));
  expect(result.connections.right.metering).toEqual(decodeMetering(right));
  expect(await execute('fusion_view', { meters: true })).toEqual({ ok: true });
  expect(view).toHaveBeenCalledWith({ meters: true });
  expect(calls).not.toHaveBeenCalled();
});
