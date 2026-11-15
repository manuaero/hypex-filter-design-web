import { expect, it, vi } from 'vitest';
import {
  createUsbDescriptorVerifier,
  type UsbDescriptorBinding,
  type UsbDescriptorDevice,
} from '../src/hardware/usb-descriptor';
import type { Slot } from '../src/domain/model';

const binding = (serial = 'H05U-LEFT'): UsbDescriptorBinding => ({
  serial,
  product: 22,
  core: '5.1',
  firmware: '5.7',
});
function descriptor(serial = 'H05U-LEFT') {
  return {
    vendorId: 0x345e,
    productId: 0x03e8,
    serialNumber: `0303A:${serial}`,
    open: vi.fn(),
    claimInterface: vi.fn(),
    controlTransferIn: vi.fn(),
    controlTransferOut: vi.fn(),
    transferIn: vi.fn(),
    transferOut: vi.fn(),
    reset: vi.fn(),
    close: vi.fn(),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const bindings: Partial<Record<Slot, UsbDescriptorBinding>> = {
      left: binding(),
      right: binding('H05U-RIGHT'),
    },
    device = descriptor(),
    api = {
      requestDevice: vi.fn(async () => device as UsbDescriptorDevice),
      getDevices: vi.fn(async () => [device] as readonly UsbDescriptorDevice[]),
    },
    verifier = createUsbDescriptorVerifier({ binding: (slot) => bindings[slot], usb: () => api });
  return { bindings, device, api, verifier };
}
const noDeviceIo = (device: ReturnType<typeof descriptor>) => {
  for (const method of [
    device.open,
    device.claimInterface,
    device.controlTransferIn,
    device.controlTransferOut,
    device.transferIn,
    device.transferOut,
    device.reset,
    device.close,
  ])
    expect(method).not.toHaveBeenCalled();
};

it('opens no chooser/enumeration/device on construction, status or availability; getDevices cannot create an initial proof', async () => {
  const { verifier, api, device } = fixture();
  const snapshot = verifier.getSnapshot();
  expect(verifier.getSnapshot()).toBe(snapshot);
  expect(verifier.availability('left')).toEqual({ available: true });
  expect(await verifier.revalidate('left')).toBeUndefined();
  expect(api.requestDevice).not.toHaveBeenCalled();
  expect(api.getDevices).not.toHaveBeenCalled();
  noDeviceIo(device);
});

it('requires observed exact runtime descriptor equality and returns immutable role/binding/family metadata only', async () => {
  const { verifier, api, device, bindings } = fixture(),
    listener = vi.fn();
  const unsubscribe = verifier.subscribe(listener);
  const proof = await verifier.request('left');
  expect(api.requestDevice).toHaveBeenCalledExactlyOnceWith({
    filters: [{ vendorId: 0x345e, productId: 0x03e8 }],
  });
  expect(api.getDevices).not.toHaveBeenCalled();
  expect(proof).toEqual({
    source: 'webusb-descriptor',
    slot: 'left',
    vendorId: 0x345e,
    productId: 0x03e8,
    hidSerial: '0303A:H05U-LEFT',
    family: 'FUSION32',
    binding: bindings.left,
  });
  expect(Object.isFrozen(proof)).toBe(true);
  expect(Object.isFrozen(proof.binding)).toBe(true);
  expect(proof.binding).not.toBe(bindings.left);
  expect(proof).not.toHaveProperty('device');
  expect(verifier.getSnapshot().left.proof).toBe(proof);
  expect(verifier.getSnapshot().right.phase).toBe('empty');
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
  verifier.clear('left');
  expect(listener).toHaveBeenCalledTimes(2);
  noDeviceIo(device);
});

it('keeps distinct two-amp roles independent and never binds the other amp returned by the chooser', async () => {
  const { verifier, api, bindings } = fixture();
  const left = await verifier.request('left');
  api.requestDevice.mockResolvedValueOnce(descriptor('H05U-RIGHT'));
  const right = await verifier.request('right');
  expect(left.binding.serial).not.toBe(right.binding.serial);
  expect(verifier.getSnapshot().left.proof).toBe(left);
  expect(verifier.getSnapshot().right.proof).toBe(right);
  api.requestDevice.mockResolvedValueOnce(descriptor('H05U-RIGHT'));
  await expect(verifier.request('left')).rejects.toThrow('exactly match');
  expect(verifier.getSnapshot().left.proof).toBeUndefined();
  expect(verifier.getSnapshot().right.proof).toBe(right);
  bindings.right = binding('H05U-LEFT');
  verifier.refreshBindings();
  expect(verifier.getSnapshot().right.proof).toBeUndefined();
  expect(verifier.availability('left').reason).toContain('same EEPROM serial');
});

it.each([
  [{ vendorId: 0x4d8, productId: 0x03e8, serialNumber: '0303A:H05U-LEFT' }, 'VID/PID'],
  [{ vendorId: 0x345e, productId: 0xff89, serialNumber: '0303A:H05U-LEFT' }, 'VID/PID'],
  [{ vendorId: 0x345e, productId: 0x03e8, serialNumber: undefined }, 'runtime prefix'],
  [{ vendorId: 0x345e, productId: 0x03e8, serialNumber: '0303B:H05U-LEFT' }, 'runtime prefix'],
  [{ vendorId: 0x345e, productId: 0x03e8, serialNumber: '0301A:H05U-LEFT' }, 'runtime prefix'],
  [{ vendorId: 0x345e, productId: 0x03e8, serialNumber: '0303A:' }, 'exactly match'],
  [{ vendorId: 0x345e, productId: 0x03e8, serialNumber: '0303A:H05U-LEFT\0' }, 'exactly match'],
  [{ vendorId: 0x345e, productId: 0x03e8, serialNumber: '0303A:H05U-LEFT ' }, 'exactly match'],
  [{ vendorId: 0x345e, productId: 0x03e8, serialNumber: '0303A: H05U-LEFT' }, 'exactly match'],
  [{ vendorId: 0x345e, productId: 0x03e8, serialNumber: '0303A:H05U-LEFT:extra' }, 'exactly match'],
  [{ vendorId: 0x345e, productId: 0x03e8, serialNumber: '0303A:h05u-left' }, 'exactly match'],
] as const)(
  'rejects wrong runtime descriptor %j without normalizing or guessing from product/core',
  async (device, message) => {
    const { verifier, api } = fixture();
    api.requestDevice.mockResolvedValueOnce(device);
    await expect(verifier.request('left')).rejects.toThrow(message);
    expect(verifier.getSnapshot().left.proof).toBeUndefined();
    expect(verifier.getSnapshot().left.phase).toBe('error');
  },
);

it('accepts the complete 32-byte native printable serial tail without trimming, truncating or stopping at an internal colon', async () => {
  const { bindings, verifier, api } = fixture(),
    serial = 'X'.repeat(14) + ': space :' + 'Y'.repeat(9);
  expect(serial).toHaveLength(32);
  bindings.left = binding(serial);
  api.requestDevice.mockResolvedValueOnce(descriptor(serial));
  expect((await verifier.request('left')).hidSerial).toBe('0303A:' + serial);
  bindings.left = binding(serial + 'Z');
  expect(verifier.availability('left').available).toBe(false);
});

it.each(['serial', 'product', 'core', 'firmware'] as const)(
  'invalidates a last-known proof before returning status when live %s changes',
  async (field) => {
    const { bindings, verifier } = fixture();
    await verifier.request('left');
    bindings.left = { ...bindings.left!, [field]: field === 'product' ? 23 : 'changed' };
    expect(verifier.getSnapshot().left.proof).toBeUndefined();
    expect(verifier.getSnapshot().left.phase).toBe('error');
    const invalidated = verifier.getSnapshot();
    expect(verifier.getSnapshot()).toBe(invalidated);
  },
);

it('captures original role before chooser and rejects a changed binding, even if it later changes back after refresh', async () => {
  const { bindings, verifier, api } = fixture(),
    pending = deferred<UsbDescriptorDevice>();
  api.requestDevice.mockReturnValueOnce(pending.promise);
  const promise = verifier.request('left'),
    rejection = expect(promise).rejects.toThrow('superseded');
  bindings.left = binding('REPLACEMENT');
  verifier.refreshBindings();
  bindings.left = binding();
  pending.resolve(descriptor());
  await rejection;
  expect(verifier.getSnapshot().left.proof).toBeUndefined();
  expect(verifier.getSnapshot().right.phase).toBe('empty');
});

it('rejects direct late binding changes and fences cleared or superseded chooser completions', async () => {
  const { verifier, bindings, api } = fixture(),
    pending = deferred<UsbDescriptorDevice>();
  api.requestDevice.mockReturnValueOnce(pending.promise);
  const promise = verifier.request('left'),
    rejection = expect(promise).rejects.toThrow('binding changed');
  bindings.left = binding('REPLACEMENT');
  pending.resolve(descriptor());
  await rejection;
  bindings.left = binding();
  const older = deferred<UsbDescriptorDevice>();
  api.requestDevice.mockReturnValueOnce(older.promise);
  const stale = verifier.request('left'),
    staleRejection = expect(stale).rejects.toThrow('superseded');
  const fresh = await verifier.request('left');
  older.resolve(descriptor());
  await staleRejection;
  expect(verifier.getSnapshot().left.proof).toBe(fresh);
  const cleared = deferred<UsbDescriptorDevice>();
  api.requestDevice.mockReturnValueOnce(cleared.promise);
  const clearing = verifier.request('left'),
    clearRejection = expect(clearing).rejects.toThrow('superseded');
  verifier.clear('left');
  cleared.resolve(descriptor());
  await clearRejection;
  expect(verifier.getSnapshot().left).toEqual({ phase: 'empty' });
});

it('revalidates only an existing granted descriptor, rejecting missing/duplicate grants without choosing by VID/PID', async () => {
  const { verifier, api, device } = fixture();
  const original = await verifier.request('left');
  expect(await verifier.revalidate('left')).toBe(original);
  expect(api.requestDevice).toHaveBeenCalledTimes(1);
  api.getDevices.mockResolvedValueOnce([descriptor('OTHER')]);
  await expect(verifier.revalidate('left')).rejects.toThrow('no longer granted');
  expect(verifier.getSnapshot().left.proof).toBeUndefined();
  expect(await verifier.revalidate('left')).toBeUndefined();
  expect(api.requestDevice).toHaveBeenCalledTimes(1);
  await verifier.request('left');
  api.getDevices.mockResolvedValueOnce([device, descriptor()]);
  await expect(verifier.revalidate('left')).rejects.toThrow('Duplicate');
  expect(verifier.getSnapshot().left.proof).toBeUndefined();
  noDeviceIo(device);
});

it('clears proof during revalidation and does not revive it after Clear or permission failure', async () => {
  const { verifier, api } = fixture();
  await verifier.request('left');
  const grant = deferred<readonly UsbDescriptorDevice[]>();
  api.getDevices.mockReturnValueOnce(grant.promise);
  const pending = verifier.revalidate('left'),
    rejection = expect(pending).rejects.toThrow('superseded');
  expect(verifier.getSnapshot().left.proof).toBeUndefined();
  verifier.clear('left');
  grant.resolve([descriptor()]);
  await rejection;
  expect(verifier.getSnapshot().left.phase).toBe('empty');
  await verifier.request('left');
  api.getDevices.mockRejectedValueOnce(new Error('Permission revoked'));
  await expect(verifier.revalidate('left')).rejects.toThrow('Permission revoked');
  expect(verifier.getSnapshot().left.proof).toBeUndefined();
});

it('reports unavailable metadata or missing/ambiguous identities before opening a chooser, and never retains a proof after cancellation', async () => {
  const api = { requestDevice: vi.fn(), getDevices: vi.fn() },
    unavailable = createUsbDescriptorVerifier({ binding: () => binding(), usb: () => undefined });
  expect(unavailable.availability('left').available).toBe(false);
  // Both roles deliberately match; duplicate rejection comes before API access.
  await expect(unavailable.request('left')).rejects.toThrow('same EEPROM serial');
  const noApi = createUsbDescriptorVerifier({
    binding: (slot) => (slot === 'left' ? binding() : undefined),
    usb: () => undefined,
  });
  await expect(noApi.request('left')).rejects.toThrow('unavailable');
  const missing = createUsbDescriptorVerifier({ binding: () => undefined, usb: () => api });
  await expect(missing.request('left')).rejects.toThrow('Connect and identify');
  expect(api.requestDevice).not.toHaveBeenCalled();
  expect(api.getDevices).not.toHaveBeenCalled();
  const f = fixture();
  await f.verifier.request('left');
  f.api.requestDevice.mockRejectedValueOnce(new Error('Chooser cancelled'));
  await expect(f.verifier.request('left')).rejects.toThrow('Chooser cancelled');
  expect(f.verifier.getSnapshot().left.proof).toBeUndefined();
});
