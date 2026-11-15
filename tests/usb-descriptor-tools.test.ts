import { expect, it, vi } from 'vitest';
import { newProject, type Slot } from '../src/domain/model';
import { createToolExecutor, type ToolAdapter, type DocumentState } from '../src/application/tools';
import { createFirmwareWorkspace } from '../src/application/firmware-workspace';
import {
  createUsbDescriptorVerifier,
  type UsbDescriptorBinding,
} from '../src/hardware/usb-descriptor';

const text =
  ':10000080A80D0000CA080000465553494F4E3332B0\r\n:01000081027C\r\n:020000040000FA\r\n:10068000464133320000000000000000000000007E\r\n:00000001FF\r\n';
function fixture() {
  const bindings: Partial<Record<Slot, UsbDescriptorBinding>> = {
    left: { serial: 'LEFT', product: 22, core: '5.1', firmware: '5.7' },
    right: { serial: 'RIGHT', product: 22, core: '5.1', firmware: '5.7' },
  };
  const devices = ['LEFT', 'RIGHT'].map((serial) => ({
    vendorId: 0x345e,
    productId: 0x03e8,
    serialNumber: `0303A:${serial}`,
    open: vi.fn(),
    claimInterface: vi.fn(),
    transferOut: vi.fn(),
  }));
  let granted = devices;
  const api = {
    requestDevice: vi.fn(async () => devices[0]),
    getDevices: vi.fn(async () => granted),
  };
  const verifier = createUsbDescriptorVerifier({
    binding: (slot) => bindings[slot],
    usb: () => api,
  });
  const workspace = createFirmwareWorkspace({
    binding: (slot) => bindings[slot],
    descriptor: (slot) => verifier.getSnapshot()[slot].proof,
  });
  const forbidden = vi.fn(() => {
    throw new Error('No project or HID effect allowed');
  });
  const state: DocumentState = {
    documents: { left: newProject('Left'), right: newProject('Right') },
    slot: 'right',
    preset: 2,
    channel: 1,
    filter: 0,
    linkedEdits: false,
    linkedControls: true,
  };
  const adapter: ToolAdapter = {
    state: () => state,
    edit: forbidden,
    choose: forbidden,
    undo: forbidden,
    redo: forbidden,
    connections: forbidden,
    connect: async () => forbidden(),
    disconnect: async () => forbidden(),
    refresh: async () => forbidden(),
    operate: async (_label, fn) => fn(),
    message: vi.fn(),
    progress: forbidden,
    view: vi.fn(),
    firmware: workspace,
    descriptorVerifier: verifier,
  };
  const execute = createToolExecutor(adapter);
  const command = (action: string, target: Slot | 'both' = 'left', extra = {}) =>
    execute('fusion_device_read', { target, firmware: { action, ...extra } }) as Promise<{
      ok: boolean;
      error?: string;
      descriptors?: Record<Slot, { phase: string; proof?: unknown }>;
    }>;
  return {
    bindings,
    devices,
    api,
    verifier,
    workspace,
    forbidden,
    command,
    revokeLeft: () => {
      granted = devices.slice(1);
    },
  };
}
it('shares native descriptor proof and staged-family state through cached tools without HID, file or project effects', async () => {
  const f = fixture();
  await f.workspace.inspect('left', text, 'generated.hex');
  expect((await f.command('usb-status', 'both')).ok).toBe(true);
  expect(f.api.requestDevice).not.toHaveBeenCalled();
  expect(f.api.getDevices).not.toHaveBeenCalled();
  const result = await f.command('usb-choose');
  expect(result.ok).toBe(true);
  expect(f.verifier.getSnapshot().left.proof?.hidSerial).toBe('0303A:LEFT');
  expect(f.workspace.getSnapshot().left.stage?.target).toMatchObject({
    hidSerial: '0303A:LEFT',
    compatibleWithBundle: true,
  });
  expect(f.workspace.getSnapshot().left.stage?.programming.available).toBe(false);
  expect(f.verifier.getSnapshot().right.phase).toBe('empty');
  expect(f.forbidden).not.toHaveBeenCalled();
  f.devices.forEach((device) => {
    expect(device.open).not.toHaveBeenCalled();
    expect(device.claimInterface).not.toHaveBeenCalled();
    expect(device.transferOut).not.toHaveBeenCalled();
  });
});
it('removes revoked proof from the retained file stage and independently reports both revalidations', async () => {
  const f = fixture();
  await f.workspace.inspect('left', text, 'keep.hex');
  await f.command('usb-choose');
  const sha = f.workspace.getSnapshot().left.stage?.sha256;
  f.revokeLeft();
  expect((await f.command('usb-revalidate', 'both')).ok).toBe(false);
  expect(f.workspace.getSnapshot().left.stage?.sha256).toBe(sha);
  expect(f.workspace.getSnapshot().left.stage?.target).toBeUndefined();
  expect(
    f.workspace
      .getSnapshot()
      .left.stage?.programming.reasons.some((r) => r.code === 'hid-product-serial-unavailable'),
  ).toBe(true);
  expect(f.verifier.getSnapshot().right.phase).toBe('empty');
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('rejects both-role choosers, mixed metadata arguments and forged serial/proof fields before any chooser', async () => {
  const f = fixture();
  for (const args of [
    { target: 'both', action: 'usb-choose' },
    { target: 'left', action: 'usb-status', content: text },
    { target: 'left', action: 'usb-choose', hidSerial: '0303A:FORGED' },
    { target: 'left', action: 'usb-choose', proof: { family: 'FUSION32' } },
  ]) {
    const { target, ...firmware } = args;
    expect((await f.command(firmware.action, target as Slot, firmware)).ok).toBe(false);
  }
  expect(f.api.requestDevice).not.toHaveBeenCalled();
  expect(f.api.getDevices).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('clears metadata independently of a valid retained file and refuses disconnected bindings without a chooser', async () => {
  const f = fixture();
  await f.workspace.inspect('left', text, 'keep.hex');
  await f.command('usb-choose');
  expect((await f.command('usb-clear', 'both')).ok).toBe(true);
  expect(f.verifier.getSnapshot().left.phase).toBe('empty');
  expect(f.workspace.getSnapshot().left.stage?.name).toBe('keep.hex');
  delete f.bindings.left;
  const calls = f.api.requestDevice.mock.calls.length;
  expect((await f.command('usb-choose')).ok).toBe(false);
  expect(f.api.requestDevice).toHaveBeenCalledTimes(calls);
  expect(f.forbidden).not.toHaveBeenCalled();
});
