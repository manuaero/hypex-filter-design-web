import type { Slot } from '../domain/model';
import { firmwareFamilyForHidSerial } from '../domain/firmware';

/** Ordinary, independently read EEPROM identity of the selected live HID session. */
export interface UsbDescriptorBinding {
  readonly serial: string;
  readonly product: number;
  readonly core: string;
  readonly firmware: string;
}
/** Deliberately excludes every device-I/O method, including open and claim. */
export interface UsbDescriptorDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly serialNumber?: string | null;
}
export interface UsbDescriptorApi {
  requestDevice(options: {
    filters: { vendorId: number; productId: number }[];
  }): Promise<UsbDescriptorDevice>;
  getDevices(): Promise<readonly UsbDescriptorDevice[]>;
}
export interface UsbDescriptorProof {
  readonly source: 'webusb-descriptor';
  readonly slot: Slot;
  readonly vendorId: 0x345e;
  readonly productId: 0x03e8;
  readonly hidSerial: string;
  readonly family: 'FUSION32';
  readonly binding: UsbDescriptorBinding;
}
export interface UsbDescriptorRoleState {
  readonly phase: 'empty' | 'requesting' | 'checking' | 'verified' | 'error';
  readonly proof?: UsbDescriptorProof;
  readonly error?: string;
}
export type UsbDescriptorSnapshot = Readonly<Record<Slot, UsbDescriptorRoleState>>;
export interface UsbDescriptorVerifier {
  getSnapshot(): UsbDescriptorSnapshot;
  subscribe(listener: () => void): () => void;
  availability(slot: Slot): { readonly available: boolean; readonly reason?: string };
  /** Must be invoked directly from a manual browser gesture. No device is opened. */
  request(slot: Slot): Promise<UsbDescriptorProof>;
  /** Recheck an existing proof against already-granted descriptor metadata only.
   * Never discovers/selects an amplifier or creates a proof from VID/PID alone. */
  revalidate(slot: Slot): Promise<UsbDescriptorProof | undefined>;
  clear(slot: Slot): void;
  /** Call when live identities change; getSnapshot also reconciles on access.
   * Clear on session teardown, including reconnects with the same identity. */
  refreshBindings(): void;
}
export interface UsbDescriptorVerifierOptions {
  binding(slot: Slot): UsbDescriptorBinding | undefined;
  usb?: () => UsbDescriptorApi | undefined;
}

const runtimeVendor = 0x345e,
  runtimeProduct = 0x03e8,
  prefix = '0303A:';
const slots: readonly Slot[] = ['left', 'right'];
const detail = (error: unknown) => (error instanceof Error ? error.message : String(error));
function checkedSlot(slot: Slot): Slot {
  if (slot !== 'left' && slot !== 'right')
    throw new Error('Choose Left or Right descriptor verification');
  return slot;
}
function checkedBinding(value: UsbDescriptorBinding | undefined): UsbDescriptorBinding {
  if (!value)
    throw new Error(
      'Connect and identify the selected amplifier before verifying its USB descriptor',
    );
  // identifyInternal reads 32 EEPROM bytes and trims its serial. Do not normalize
  // descriptor tails to compensate for a different/raw padded EEPROM layout.
  if (
    typeof value.serial !== 'string' ||
    !/^[\x20-\x7e]{1,32}$/.test(value.serial) ||
    value.serial !== value.serial.trim() ||
    !Number.isInteger(value.product) ||
    value.product < 0 ||
    value.product > 255 ||
    ![value.core, value.firmware].every(
      (v) => typeof v === 'string' && v.length > 0 && v.length <= 512,
    )
  )
    throw new Error('The selected amplifier has an invalid EEPROM identity');
  return Object.freeze({
    serial: value.serial,
    product: value.product,
    core: value.core,
    firmware: value.firmware,
  });
}
const sameBinding = (left: UsbDescriptorBinding, right: UsbDescriptorBinding) =>
  left.serial === right.serial &&
  left.product === right.product &&
  left.core === right.core &&
  left.firmware === right.firmware;
const defaultUsb = () =>
  typeof navigator === 'undefined'
    ? undefined
    : (navigator as Navigator & { usb?: UsbDescriptorApi }).usb;
function browserUsb(options: UsbDescriptorVerifierOptions): UsbDescriptorApi {
  const api = (options.usb ?? defaultUsb)();
  if (!api || typeof api.requestDevice !== 'function' || typeof api.getDevices !== 'function')
    throw new Error('WebUSB descriptor metadata is unavailable in this browser');
  return api;
}

/** Read-only supplemental runtime identity proof. Native v5.82 serial builder
 * 9d00fe04..fe7e appends ':' and EEPROM[0x100..0x11f] to UTF16 '0303A'.
 * Exact observed tail equality is mandatory; no product/core-to-family guess.
 * This proves neither bootloader identity nor reconnect/flash/recovery behavior. */
export function createUsbDescriptorVerifier(
  options: UsbDescriptorVerifierOptions,
): UsbDescriptorVerifier {
  let snapshot: UsbDescriptorSnapshot = Object.freeze({
    left: Object.freeze({ phase: 'empty' as const }),
    right: Object.freeze({ phase: 'empty' as const }),
  });
  const generations: Record<Slot, number> = { left: 0, right: 0 },
    pending: Partial<Record<Slot, UsbDescriptorBinding>> = {},
    listeners = new Set<() => void>();
  let notificationQueued = false;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const publish = (slot: Slot, state: UsbDescriptorRoleState) => {
    snapshot = Object.freeze({ ...snapshot, [slot]: Object.freeze(state) });
    notify();
  };
  const bindingFor = (slot: Slot) => {
    const binding = checkedBinding(options.binding(slot)),
      other = options.binding(slot === 'left' ? 'right' : 'left');
    if (other?.serial === binding.serial)
      throw new Error(
        'Both amplifier roles have the same EEPROM serial; descriptor binding is ambiguous',
      );
    return binding;
  };
  const synchronize = (immediate: boolean) => {
    let changed = false;
    for (const slot of slots) {
      const captured = snapshot[slot].proof?.binding ?? pending[slot];
      if (!captured) continue;
      let failure: string | undefined;
      try {
        if (!sameBinding(captured, bindingFor(slot)))
          failure = 'The amplifier binding changed; verify its USB descriptor again';
      } catch (error) {
        failure = detail(error);
      }
      if (failure) {
        generations[slot]++;
        delete pending[slot];
        snapshot = Object.freeze({
          ...snapshot,
          [slot]: Object.freeze({ phase: 'error' as const, error: failure }),
        });
        changed = true;
      }
    }
    if (!changed) return;
    if (immediate) notify();
    else if (!notificationQueued) {
      notificationQueued = true;
      queueMicrotask(() => {
        notificationQueued = false;
        notify();
      });
    }
  };
  const current = (slot: Slot, generation: number, binding: UsbDescriptorBinding) => {
    if (generation !== generations[slot])
      throw new Error('USB descriptor verification was cleared or superseded');
    if (!sameBinding(binding, bindingFor(slot)))
      throw new Error('The amplifier binding changed during USB descriptor verification');
  };
  const proofFor = (
    slot: Slot,
    device: UsbDescriptorDevice,
    binding: UsbDescriptorBinding,
  ): UsbDescriptorProof => {
    if (!device || device.vendorId !== runtimeVendor || device.productId !== runtimeProduct)
      throw new Error('The selected USB descriptor is not the recovered FusionAmp runtime VID/PID');
    const hidSerial = device.serialNumber;
    if (typeof hidSerial !== 'string' || !hidSerial.startsWith(prefix))
      throw new Error('The USB descriptor must contain the exact runtime prefix 0303A:');
    if (hidSerial !== prefix + binding.serial)
      throw new Error(
        'USB descriptor serial does not exactly match the selected amplifier EEPROM serial',
      );
    const family = firmwareFamilyForHidSerial(hidSerial);
    if (family !== 'FUSION32') throw new Error('USB descriptor firmware family is unsupported');
    return Object.freeze({
      source: 'webusb-descriptor',
      slot,
      vendorId: runtimeVendor,
      productId: runtimeProduct,
      hidSerial,
      family,
      binding,
    });
  };
  const fail = (slot: Slot, generation: number, error: unknown): never => {
    if (generation === generations[slot]) {
      delete pending[slot];
      publish(slot, { phase: 'error', error: detail(error) });
    }
    throw error;
  };
  return {
    getSnapshot: () => {
      synchronize(false);
      return snapshot;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    availability: (slot) => {
      checkedSlot(slot);
      try {
        bindingFor(slot);
        browserUsb(options);
        return Object.freeze({ available: true });
      } catch (error) {
        return Object.freeze({ available: false, reason: detail(error) });
      }
    },
    request: async (slot) => {
      checkedSlot(slot);
      const generation = ++generations[slot];
      delete pending[slot];
      // A failed/cancelled new grant cannot leave an older proof usable.
      publish(slot, { phase: 'requesting' });
      try {
        const binding = bindingFor(slot),
          api = browserUsb(options);
        pending[slot] = binding;
        // No await occurs before requestDevice: preserve the caller's gesture.
        const device = await api.requestDevice({
          filters: [{ vendorId: runtimeVendor, productId: runtimeProduct }],
        });
        current(slot, generation, binding);
        const proof = proofFor(slot, device, binding);
        current(slot, generation, binding);
        delete pending[slot];
        publish(slot, { phase: 'verified', proof });
        return proof;
      } catch (error) {
        return fail(slot, generation, error);
      }
    },
    revalidate: async (slot) => {
      checkedSlot(slot);
      synchronize(true);
      const proof = snapshot[slot].proof;
      if (!proof) return undefined;
      const generation = ++generations[slot],
        binding = proof.binding;
      pending[slot] = binding;
      publish(slot, { phase: 'checking' });
      try {
        const api = browserUsb(options),
          devices = await api.getDevices();
        current(slot, generation, binding);
        if (!Array.isArray(devices)) throw new Error('WebUSB returned invalid descriptor metadata');
        const matching = devices.filter(
          (device) =>
            device?.vendorId === runtimeVendor &&
            device.productId === runtimeProduct &&
            device.serialNumber === proof.hidSerial,
        );
        if (matching.length !== 1)
          throw new Error(
            matching.length > 1
              ? 'Duplicate USB descriptor serials make the amplifier binding ambiguous'
              : 'The verified USB descriptor is no longer granted or connected',
          );
        proofFor(slot, matching[0], binding);
        current(slot, generation, binding);
        delete pending[slot];
        publish(slot, { phase: 'verified', proof });
        return proof;
      } catch (error) {
        return fail(slot, generation, error);
      }
    },
    clear: (slot) => {
      checkedSlot(slot);
      generations[slot]++;
      delete pending[slot];
      publish(slot, { phase: 'empty' });
    },
    refreshBindings: () => synchronize(true),
  };
}
