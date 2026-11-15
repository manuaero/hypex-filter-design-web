import type { Slot } from '../domain/model';
import type { PanelSession } from '../hardware/session';
import { WebHidTransport, type Transport } from '../hardware/transport';
import { inspectFirmwareRuntime } from '../hardware/firmware-runtime-inspector';
import type { FirmwareRuntimeBinding, FirmwareRuntimeControllerOptions } from './firmware-runtime';

export interface FirmwareRuntimeLiveSource {
  readonly key: string;
  readonly serial: string;
  readonly device: HIDDevice;
  readonly session: PanelSession;
}
export interface FirmwareRuntimeCandidateSource {
  readonly key: string;
  readonly serial?: string;
  readonly device: HIDDevice;
  readonly session: PanelSession;
}
export interface FirmwareRuntimeRememberedSource {
  readonly key: string;
  readonly serial: string;
  readonly device: HIDDevice;
}
export interface FirmwareRuntimeSourceProviderOptions {
  live(slot: Slot): FirmwareRuntimeLiveSource | undefined;
  candidate(slot: Slot): FirmwareRuntimeCandidateSource | undefined;
  remembered(slot: Slot): FirmwareRuntimeRememberedSource | undefined;
  allLive(): readonly { readonly device: HIDDevice }[];
  operate<T>(label: string, work: () => Promise<T>): Promise<T>;
  transportFactory?(device: HIDDevice): Transport;
}
export type FirmwareRuntimeSourceProvider = Pick<
  FirmwareRuntimeControllerOptions,
  'binding' | 'read'
>;

type Source = {
  readonly binding: Readonly<FirmwareRuntimeBinding>;
  readonly device: HIDDevice;
  readonly session?: PanelSession;
};
const validSerial = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x20-\x7e]{1,32}$/.test(value);
const sameBinding = (a: FirmwareRuntimeBinding, b: FirmwareRuntimeBinding) =>
  a.key === b.key && a.serial === b.serial && a.source === b.source;

/** Uses captured object identities only. No chooser, device enumeration, HID
 * serial heuristic or PanelSession construction is part of this provider.
 * Remembered ports are owned temporarily; candidate/live ports are borrowed. */
export function createFirmwareRuntimeSourceProvider(
  options: FirmwareRuntimeSourceProviderOptions,
): FirmwareRuntimeSourceProvider {
  const factory = options.transportFactory ?? ((device: HIDDevice) => new WebHidTransport(device)),
    opening = new Set<HIDDevice>();
  const select = (slot: Slot): Source | undefined => {
    if (slot !== 'left' && slot !== 'right') throw new Error('Choose Left or Right runtime source');
    const candidate = options.candidate(slot),
      live = candidate ? undefined : options.live(slot),
      remembered = candidate || live ? undefined : options.remembered(slot),
      value = candidate ?? live ?? remembered;
    if (!value) return undefined;
    const source: FirmwareRuntimeBinding['source'] = candidate
      ? 'chosen-device'
      : live
        ? 'connected-session'
        : 'remembered-device';
    if (
      typeof value.key !== 'string' ||
      value.key.length < 1 ||
      value.key.length > 512 ||
      /[\x00-\x1f\x7f]/.test(value.key) ||
      (value.serial !== undefined && !validSerial(value.serial)) ||
      (source !== 'chosen-device' && !validSerial(value.serial)) ||
      !value.device ||
      value.device.vendorId !== 0x345e ||
      value.device.productId !== 0x03e8 ||
      typeof value.device.open !== 'function' ||
      typeof value.device.close !== 'function'
    )
      throw new Error('Invalid captured FA503 firmware runtime interface');
    const session = candidate?.session ?? live?.session;
    if (source !== 'remembered-device' && (!session || typeof session.exclusive !== 'function'))
      throw new Error('Captured runtime interface has no owning session queue');
    return {
      binding: Object.freeze({
        key: value.key,
        ...(value.serial !== undefined ? { serial: value.serial } : {}),
        source,
      }),
      device: value.device,
      ...(session ? { session } : {}),
    };
  };
  return {
    binding(slot) {
      return select(slot)?.binding;
    },
    async read(slot, binding, hooks) {
      const captured = select(slot);
      if (!captured || !sameBinding(captured.binding, binding))
        throw new Error('Captured firmware runtime source changed; read its current binding');
      const assertCurrent = () => {
        hooks.signal?.throwIfAborted();
        hooks.assertCurrent();
        const current = select(slot);
        if (
          !current ||
          !sameBinding(captured.binding, current.binding) ||
          current.device !== captured.device ||
          current.session !== captured.session
        )
          throw new Error(
            'Captured firmware runtime interface changed; its replacement was not read',
          );
        if (
          captured.binding.source === 'remembered-device' &&
          options.allLive().some((live) => live.device === captured.device)
        )
          throw new Error('Remembered runtime interface is assigned to a live amplifier');
        hooks.signal?.throwIfAborted();
      };
      assertCurrent();
      const inspect = () =>
        inspectFirmwareRuntime(captured.session!.transport, {
          ...(captured.binding.serial !== undefined
            ? { expectedSerial: captured.binding.serial }
            : {}),
          assertCurrent,
          ...(hooks.signal ? { signal: hooks.signal } : {}),
        });
      if (captured.session) {
        const reserved = () =>
          captured.session!.exclusive(async () => {
            assertCurrent();
            const report = await inspect();
            assertCurrent();
            return report;
          });
        // Connecting already owns the global operation, so nesting operate
        // would reject its own candidate. An ordinary live read owns both locks.
        const report =
          captured.binding.source === 'chosen-device'
            ? await reserved()
            : await options.operate('Reading amplifier firmware runtime', reserved);
        assertCurrent();
        return report;
      }
      const report = await options.operate(
        'Reading remembered amplifier firmware runtime',
        async () => {
          assertCurrent();
          if (captured.device.opened || opening.has(captured.device))
            throw new Error(
              'Remembered runtime interface is already open; its ownership is unknown',
            );
          opening.add(captured.device);
          let openAttempted = false,
            transport: Transport | undefined;
          try {
            assertCurrent();
            openAttempted = true;
            await captured.device.open();
            assertCurrent();
            if (!captured.device.opened)
              throw new Error('Remembered runtime interface did not open');
            transport = factory(captured.device);
            assertCurrent();
            return await inspectFirmwareRuntime(transport, {
              expectedSerial: captured.binding.serial,
              assertCurrent,
              ...(hooks.signal ? { signal: hooks.signal } : {}),
            });
          } finally {
            try {
              // The transport owns listeners as well as this opened interface.
              // No borrowed live/candidate session reaches this cleanup path.
              if (transport) await transport.close();
              else if (openAttempted && captured.device.opened) await captured.device.close();
              if (openAttempted && captured.device.opened)
                throw new Error('Owned firmware runtime interface did not close');
            } catch {
              // Never return a successful report or serial-mismatch continuation
              // when closure of the temporary interface is unconfirmed.
              throw new Error('Firmware runtime inspection could not close its owned interface');
            } finally {
              opening.delete(captured.device);
            }
          }
        },
      );
      assertCurrent();
      return report;
    },
  };
}
