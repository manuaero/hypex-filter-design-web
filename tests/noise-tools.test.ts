import { expect, it, vi } from 'vitest';
import { createToolExecutor, TOOL_DEFINITIONS, type ToolAdapter } from '../src/application/tools';
import { createNoiseController } from '../src/application/noise-control';
import { newProject } from '../src/domain/model';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { decodeStatus } from '../src/hardware/codec';
import type { Transport } from '../src/hardware/transport';
const actionCount = (panel: SimulatedPanel) =>
  panel.requests.filter((r) => r[0] === 8 && r[1] === 30).length;
function setup(withRight = true, badRightAck = false) {
  const left = new SimulatedPanel('NOISE-L'),
    right = new SimulatedPanel('NOISE-R');
  const transport: Transport = {
    close: () => right.close(),
    exchange: async (request) => {
      const reply = await right.exchange(request);
      if (badRightAck && request[0] === 8) reply[1] = 0;
      return reply;
    },
  };
  const make = (panel: SimulatedPanel, driver: Transport = panel) => ({
    session: new PanelSession(driver, async () => {}),
    identity: {
      serial: panel.serial,
      product: 22,
      core: '5.1',
      firmware: '5.7',
      name: 'Simulation',
      configuration: '',
    },
    status: decodeStatus(panel.status),
  });
  const connections = { left: make(left), ...(withRight ? { right: make(right, transport) } : {}) },
    documents = { left: newProject('Left'), right: newProject('Right') },
    operate = vi.fn(async (_label: string, fn: () => Promise<unknown>) => fn());
  const controller = createNoiseController({
    connections: () => connections,
    operate: async (label, work) =>
      operate(label, work) as Promise<Awaited<ReturnType<typeof work>>>,
  });
  const adapter: ToolAdapter = {
    state: () => ({
      documents,
      slot: 'left',
      preset: 0,
      channel: 0,
      filter: 0,
      linkedEdits: true,
      linkedControls: false,
    }),
    edit: vi.fn(),
    choose: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    connections: () => connections,
    connect: vi.fn(),
    disconnect: vi.fn(),
    refresh: vi.fn(),
    operate: async (_label, work) => work(),
    message: vi.fn(),
    progress: vi.fn(),
    view: vi.fn(),
    noise: controller,
  };
  return {
    execute: createToolExecutor(adapter),
    adapter,
    controller,
    operate,
    left,
    right,
    documents,
  };
}

it('reads only session-local request status and exposes the same panel visibility without I/O', async () => {
  const { execute, adapter, left, right } = setup();
  expect(
    await execute('fusion_noise', { target: 'both', command: { action: 'status' } }),
  ).toMatchObject({
    ok: true,
    noise: {
      left: { requested: null, actualState: 'unavailable' },
      right: { requested: null, actualState: 'unavailable' },
    },
  });
  expect(await execute('fusion_view', { noisePanel: true })).toEqual({ ok: true });
  expect(adapter.view).toHaveBeenCalledWith({ noisePanel: true });
  expect(left.requests).toHaveLength(0);
  expect(right.requests).toHaveLength(0);
});

it('shares explicit paired Start/Stop with the controller and leaves both designs/control fields intact', async () => {
  const { execute, adapter, left, right, documents, operate } = setup(),
    before = structuredClone(documents);
  expect(
    await execute('fusion_noise', { target: 'both', command: { action: 'set', enabled: true } }),
  ).toMatchObject({ ok: true, result: { complete: true, requested: true } });
  expect([actionCount(left), actionCount(right)]).toEqual([1, 1]);
  expect(
    await execute('fusion_noise', { target: 'both', command: { action: 'set', enabled: false } }),
  ).toMatchObject({ ok: true, result: { complete: true, requested: false } });
  expect([actionCount(left), actionCount(right)]).toEqual([2, 2]);
  expect(documents).toEqual(before);
  expect(adapter.edit).not.toHaveBeenCalled();
  expect(operate).toHaveBeenCalledTimes(2);
  expect([...left.requests, ...right.requests].some((r) => r[0] === 5 && r[1] === 0)).toBe(false);
});

it('dispatches the cached device-read namespace through the same actions and rejects mixed namespaces', async () => {
  const { execute, left, right } = setup();
  expect(
    await execute('fusion_device_read', {
      target: 'left',
      noise: { action: 'set', enabled: true },
    }),
  ).toMatchObject({ ok: true, result: { requested: true } });
  expect(actionCount(left)).toBe(1);
  expect(right.requests).toHaveLength(0);
  const count = left.requests.length;
  expect(
    await execute('fusion_device_read', { target: 'left', noise: { action: 'status' } }),
  ).toMatchObject({ ok: true, noise: { left: { acknowledgement: 'accepted' } } });
  expect(left.requests).toHaveLength(count);
  expect(
    await execute('fusion_device_read', {
      target: 'left',
      noise: { action: 'set', enabled: false },
      auth: { action: 'status' },
    }),
  ).toMatchObject({ ok: false });
  expect(actionCount(left)).toBe(1);
});

it('returns the independent partial-result ledger without claiming a failed ACK was off or rolling back', async () => {
  const { execute, left, right } = setup(true, true);
  expect(
    await execute('fusion_noise', { target: 'both', command: { action: 'set', enabled: true } }),
  ).toMatchObject({
    ok: false,
    result: {
      partial: true,
      complete: false,
      roles: { left: { write: 'acknowledged' }, right: { write: 'unconfirmed' } },
    },
  });
  expect([actionCount(left), actionCount(right)]).toEqual([1, 1]);
});

it('rejects a missing peer, implicit state or invalid fields before any action', async () => {
  const { execute, left } = setup(false);
  expect(
    await execute('fusion_noise', { target: 'both', command: { action: 'set', enabled: true } }),
  ).toMatchObject({ ok: false });
  expect(
    await execute('fusion_noise', { target: 'left', command: { action: 'set' } }),
  ).toMatchObject({ ok: false });
  expect(
    await execute('fusion_noise', { target: 'left', command: { action: 'set', enabled: 'true' } }),
  ).toMatchObject({ ok: false });
  expect(
    await execute('fusion_noise', { target: 'left', command: { action: 'status', enabled: true } }),
  ).toMatchObject({ ok: false });
  expect(left.requests).toHaveLength(0);
  expect(TOOL_DEFINITIONS.find((d) => d.name === 'fusion_noise')?.annotations.readOnlyHint).toBe(
    false,
  );
  expect(
    TOOL_DEFINITIONS.find((d) => d.name === 'fusion_device_read')?.annotations.readOnlyHint,
  ).toBe(false);
});

it('does not disconnect a session while another device operation holds the shared UI executor', async () => {
  const { execute, adapter } = setup();
  adapter.operate = async () => {
    throw new Error('Another operation is still running');
  };
  expect(await execute('fusion_disconnect', { target: 'both' })).toMatchObject({ ok: false });
  expect(adapter.disconnect).not.toHaveBeenCalled();
});
