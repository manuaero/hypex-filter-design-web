import { expect, it } from 'vitest';
import { createFirmwareWorkspace } from '../src/application/firmware-workspace';
import {
  createUsbDescriptorVerifier,
  type UsbDescriptorBinding,
  type UsbDescriptorDevice,
} from '../src/hardware/usb-descriptor';
import type { Slot } from '../src/domain/model';

const text = [
  ':10000080A80D0000CA080000465553494F4E3332B0',
  ':01000081027C',
  ':020000040000FA',
  ':10068000464133320000000000000000000000007E',
  ':00000001FF',
].join('\n');
const identity = (serial: string): UsbDescriptorBinding => ({
  serial,
  product: 22,
  core: '5.1',
  firmware: '5.7',
});
const descriptor = (serial: string): UsbDescriptorDevice => ({
  vendorId: 0x345e,
  productId: 0x03e8,
  serialNumber: '0303A:' + serial,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture(offline = false, hash?: () => Promise<string>) {
  const bindings: Partial<Record<Slot, UsbDescriptorBinding>> = {
    ...(offline ? {} : { left: identity('LEFT') }),
    right: identity('RIGHT'),
  };
  let chosen = descriptor('LEFT');
  const verifier = createUsbDescriptorVerifier({
      binding: (slot) => bindings[slot],
      usb: () => ({ requestDevice: async () => chosen, getDevices: async () => [chosen] }),
    }),
    workspace = createFirmwareWorkspace({
      binding: (slot) => bindings[slot],
      descriptor: (slot) => verifier.getSnapshot()[slot].proof,
      sha256: hash ?? (async () => 'a'.repeat(64)),
    });
  return {
    bindings,
    verifier,
    workspace,
    choose: (serial: string) => {
      chosen = descriptor(serial);
    },
  };
}

it('attaches a matching descriptor to the original stage without changing its binding, identity, hash or programming availability', async () => {
  const { workspace, verifier } = fixture(),
    original = await workspace.inspect('left', text, 'native.hex');
  expect(original.target).toBeUndefined();
  await verifier.request('left');
  workspace.refreshTarget('left');
  const staged = workspace.getSnapshot().left.stage!;
  expect(staged.target).toEqual({
    source: 'webusb-descriptor',
    hidSerial: '0303A:LEFT',
    family: 'FUSION32',
    compatibleWithBundle: true,
  });
  expect(staged.id).toBe(original.id);
  expect(staged.sha256).toBe(original.sha256);
  expect(staged.boundDevice).toBe(original.boundDevice);
  expect(staged.programming.available).toBe(false);
  const codes = staged.programming.reasons.map((reason) => reason.code);
  expect(codes).not.toContain('hid-product-serial-unavailable');
  expect(codes).toEqual(
    expect.arrayContaining([
      'bootloader-correlation-unavailable',
      'preservation-unverified',
      'recovery-unavailable',
      'writer-unavailable',
    ]),
  );
  const same = workspace.getSnapshot();
  expect(workspace.getSnapshot()).toBe(same);
  verifier.clear('left');
  workspace.refreshTarget('left');
  expect(workspace.getSnapshot().left.stage?.target).toBeUndefined();
  expect(
    workspace
      .getSnapshot()
      .left.stage?.programming.reasons.some(
        (reason) => reason.code === 'hid-product-serial-unavailable',
      ),
  ).toBe(true);
});

it('never attaches to an unbound offline stage; a new inspection is required after connecting and verifying', async () => {
  const { workspace, verifier, bindings } = fixture(true),
    offline = await workspace.inspect('left', text, 'offline.hex');
  bindings.left = identity('LEFT');
  await verifier.request('left');
  workspace.refreshTarget('left');
  expect(workspace.getSnapshot().left.stage?.boundDevice).toBeUndefined();
  expect(workspace.getSnapshot().left.stage?.target).toBeUndefined();
  expect(workspace.getSnapshot().left.stage?.id).toBe(offline.id);
  const bound = await workspace.inspect('left', text, 'offline.hex');
  expect(bound.target?.hidSerial).toBe('0303A:LEFT');
  expect(bound.boundDevice?.serial).toBe('LEFT');
});

it('reports the observed target family mismatch and retains every writer/recovery block', async () => {
  const { workspace, verifier } = fixture();
  await verifier.request('left');
  const wrongFamily = text.replace(
      ':10000080A80D0000CA080000465553494F4E3332B0',
      ':10000080550600008D020000465553494F4E303151',
    ),
    staged = await workspace.inspect('left', wrongFamily, 'legacy.hex');
  expect(staged.family).toBe('FUSION01');
  expect(staged.target?.compatibleWithBundle).toBe(false);
  expect(staged.programming.reasons.map((reason) => reason.code)).toEqual(
    expect.arrayContaining([
      'firmware-family-mismatch',
      'writer-unavailable',
      'recovery-unavailable',
    ]),
  );
  expect(staged.programming.available).toBe(false);
});

it('invalidates stale attached proof on status access and never retargets the staged file to a replacement amplifier', async () => {
  const { bindings, workspace, verifier, choose } = fixture();
  await verifier.request('left');
  const original = await workspace.inspect('left', text, 'original.hex');
  bindings.left = identity('REPLACEMENT');
  expect(workspace.getSnapshot().left.stage?.target).toBeUndefined();
  expect(workspace.getSnapshot().left.stage?.boundDevice?.serial).toBe('LEFT');
  choose('REPLACEMENT');
  await verifier.request('left');
  workspace.refreshTarget('left');
  const retained = workspace.getSnapshot().left.stage!;
  expect(retained.target).toBeUndefined();
  expect(retained.boundDevice).toBe(original.boundDevice);
  expect(retained.id).toBe(original.id);
  expect(
    retained.programming.reasons.some((reason) => reason.code === 'device-binding-changed'),
  ).toBe(true);
  expect(workspace.getSnapshot().right.stage).toBeUndefined();
});

it('checks the current descriptor again after a slow hash, so a cleared proof cannot be captured into the completed stage', async () => {
  const digest = deferred<string>(),
    { workspace, verifier } = fixture(false, () => digest.promise);
  await verifier.request('left');
  const inspection = workspace.inspect('left', text, 'slow.hex');
  verifier.clear('left');
  digest.resolve('b'.repeat(64));
  const staged = await inspection;
  expect(staged.target).toBeUndefined();
  expect(staged.programming.available).toBe(false);
});

it('rejects wrong-role and malformed proof providers and rechecks a binding changed by a provider before attachment', async () => {
  const { bindings, verifier, choose } = fixture();
  choose('RIGHT');
  const right = await verifier.request('right');
  const wrongRole = createFirmwareWorkspace({
    binding: (slot) => bindings[slot],
    descriptor: () => right,
    sha256: async () => 'a'.repeat(64),
  });
  expect((await wrongRole.inspect('left', text, 'left.hex')).target).toBeUndefined();
  choose('LEFT');
  const left = await verifier.request('left');
  const changed = createFirmwareWorkspace({
    binding: (slot) => bindings[slot],
    descriptor: () => {
      bindings.left = identity('REPLACEMENT');
      return left;
    },
    sha256: async () => 'a'.repeat(64),
  });
  expect((await changed.inspect('left', text, 'race.hex')).target).toBeUndefined();
  bindings.left = identity('LEFT');
  const malformed = createFirmwareWorkspace({
    binding: (slot) => bindings[slot],
    descriptor: () => ({ ...left, binding: { ...left.binding, serial: '' } }),
    sha256: async () => 'a'.repeat(64),
  });
  const staged = await malformed.inspect('left', text, 'malformed.hex');
  expect(staged.target).toBeUndefined();
  expect(malformed.getSnapshot().left.stage?.target).toBeUndefined();
});
