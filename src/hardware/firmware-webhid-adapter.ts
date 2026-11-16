import type {
  FirmwareJournalBinding,
  FirmwareJournalBefore,
  FirmwareJournalImage,
  FirmwareJournalSource,
} from '../application/firmware-update-storage';
import { firmwareBeforeSha256, firmwareImageSha256 } from '../application/firmware-update-storage';
import type { PanelSession } from './session';
import type { UsbDescriptorProof } from './usb-descriptor';
import { WebHidTransport } from './transport';
import { addr, hex, packet } from './codec';
import { decodeStatusFlags } from './status-flags';
import {
  createGuardedPhysicalFirmwareUpdateAdapter,
  type FirmwareUpdateAdapter,
  type FirmwarePhysicalUpdatePort,
  type FirmwareUpdateAvailability,
  type FirmwareEntryContext,
} from './firmware-update';
import {
  createQualifiedPhysicalFirmwareChannel,
  type FirmwareBootloaderIdentity,
  type FirmwareReferencePort,
} from './firmware-program';
import {
  lookupQualifiedFirmwarePhysicalProfile,
  isQualifiedFirmwarePhysicalProfile,
  type FirmwareQualifiedPhysicalProfile,
  type FirmwarePhysicalReadbackProfile,
  type FirmwarePhysicalCandidate,
} from './firmware-physical-profile';

export interface FirmwareWebHidRuntimeCapture {
  readonly binding: Readonly<FirmwareJournalBinding>;
  readonly device: HIDDevice;
  readonly session: PanelSession;
  readonly descriptor?: UsbDescriptorProof;
}
export interface FirmwareWebHidAdapterOptions {
  /** Metadata lookup only. It may become undefined during expected disconnect;
   * a replacement session/interface is never silently substituted. */
  capture(binding: Readonly<FirmwareJournalBinding>): FirmwareWebHidRuntimeCapture | undefined;
  /** Stable role-assignment lease, surviving expected USB disappearance. */
  isCurrent(binding: Readonly<FirmwareJournalBinding>): boolean;
  assignedDevices(): readonly HIDDevice[];
  onRuntimeRetired?(binding: Readonly<FirmwareJournalBinding>): void;
  /** Already-granted discovery only. There is no requestDevice/chooser path. */
  hid?: Pick<HID, 'getDevices'>;
  discoveryTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}
type Connection = {
  device: HIDDevice;
  transport: WebHidTransport;
  binding: FirmwareJournalBinding;
  owned: boolean;
  correlated?: { serial: string; hidSerial: string };
};
type CapturedMetadata = {
  configuration: Uint8Array;
  hardware: Uint8Array;
  name: Uint8Array;
  status: Uint8Array;
  serialBytes: Uint8Array;
};
type Role = {
  binding: FirmwareJournalBinding;
  original?: FirmwareWebHidRuntimeCapture;
  profile: FirmwareQualifiedPhysicalProfile;
  runtime?: Connection;
  loader?: Connection;
  entryCalled: boolean;
  retired: boolean;
  cleanupFault?: unknown;
  beforeMetadata?: CapturedMetadata;
};
type Lease = {
  roles: Map<string, Role>;
  hooks?: { signal?: AbortSignal; assertCurrent?(): void };
  opened: Set<Connection>;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const serial = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x20-\x7e]{1,64}$/.test(value);
const detail = (error: unknown) =>
  error instanceof Error ? error.message : 'Physical firmware adapter unavailable';
const clone = <T>(value: T): T => structuredClone(value);
const runtimeKey = (p: { core: string; firmware: string; product: number }) =>
  `${p.product}:${p.core}:${p.firmware}`;
function readback(
  profile: FirmwareQualifiedPhysicalProfile,
  binding: Pick<FirmwareJournalBinding, 'core' | 'firmware' | 'product'>,
): FirmwarePhysicalReadbackProfile {
  const result = [profile.before, ...profile.after].find(
    (item) => runtimeKey(item) === runtimeKey(binding),
  );
  if (!result || !result.evidence.length || result.channels !== 3 || result.presets !== 3)
    throw new Error('No separately qualified complete43-image runtime readback profile');
  for (const command of [3, 5, 6, 102] as const) {
    const mask = result.reportMasks[command];
    if (
      !mask ||
      mask.length !== 64 ||
      mask.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255) ||
      mask[0] !== 255 ||
      !mask.slice(1).some((byte) => byte !== 0)
    )
      throw new Error('Physical firmware requires fixed meaningful source-qualified report masks');
  }
  return result;
}
function checkedProfile(
  binding: FirmwareJournalBinding,
  source?: FirmwareJournalSource,
): FirmwareQualifiedPhysicalProfile {
  const profile = lookupQualifiedFirmwarePhysicalProfile(binding, source);
  if (!profile || !isQualifiedFirmwarePhysicalProfile(profile))
    throw new Error(
      'Physical firmware profile unqualified: same-unit loader, reply freshness, preservation and recovery evidence are required',
    );
  if (
    profile.family !== binding.family ||
    ![
      'sameUnitCorrelation',
      'singleReplyAndLateDuplicates',
      'preservation',
      'recovery',
      'runtimePermission',
    ].every((key) => profile.evidence[key as keyof typeof profile.evidence]?.length > 0) ||
    typeof profile.assertRuntimeAccess !== 'function'
  )
    throw new Error(
      'Physical firmware profile lacks qualified permission/correlation/reply evidence',
    );
  readback(profile, binding);
  if (source) {
    if (
      !profile.sourceSha256s.includes(source.sha256) ||
      source.expectedAfter?.source === 'explicit-simulation' ||
      !source.expectedAfter?.core ||
      !source.expectedAfter.firmware
    )
      throw new Error(
        'Physical firmware requires an exact qualified source and version expectation',
      );
    readback(profile, {
      product: binding.product,
      core: source.expectedAfter.core,
      firmware: source.expectedAfter.firmware,
    });
  }
  return profile;
}
function ascii(bytes: Uint8Array): string {
  const end = bytes.findIndex((byte) => byte === 0 || byte === 255),
    n = end < 0 ? bytes.length : end;
  if (
    !n ||
    bytes.slice(0, n).some((byte) => byte < 32 || byte > 126) ||
    (end >= 0 && bytes.slice(end).some((byte) => byte !== 0 && byte !== 255))
  )
    throw new Error('Malformed firmware EEPROM serial');
  return String.fromCharCode(...bytes.slice(0, n));
}

/** Real production I/O mechanics behind an empty, non-caller-issued physical
 * registry. This factory returns only an opaque coordinator adapter: its port
 * is never exposed to a reference factory or tools. Unit mocks do not qualify
 * any physical profile, and host stamps do not prove target-echo correlation. */
export function createFirmwareWebHidUpdateAdapter(
  options: FirmwareWebHidAdapterOptions,
): FirmwareUpdateAdapter {
  const timeout = options.discoveryTimeoutMs ?? 10000,
    interval = options.pollIntervalMs ?? 100;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 30000 ||
    !Number.isSafeInteger(interval) ||
    interval < 1 ||
    interval > timeout
  )
    throw new Error('Invalid bounded firmware discovery timing');
  const now = options.now ?? Date.now,
    sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let active: Lease | undefined,
    epoch = 0;
  const availability = (
    binding?: Readonly<FirmwareJournalBinding>,
    source?: Readonly<FirmwareJournalSource>,
  ): FirmwareUpdateAvailability => {
    try {
      if (!binding) throw new Error('A captured amplifier assignment is required');
      checkedProfile(clone(binding), source);
      if (!source) throw new Error('Stage an exact qualified firmware source');
      return {
        available: true,
        route: 'physical',
        qualified: true,
        qualifier: 'qualified-physical',
        reasons: [],
      };
    } catch (error) {
      return {
        available: false,
        route: 'physical',
        qualified: false,
        qualifier: 'unqualified-physical',
        reasons: [detail(error)],
      };
    }
  };
  const role = (binding: FirmwareJournalBinding): Role => {
    const value = active?.roles.get(binding.assignmentId);
    if (!value || !same(value.binding, binding)) {
      // captureAfter is passed the new runtime binding, not its old identity.
      const post =
        active && [...active.roles.values()].find((item) => same(item.runtime?.binding, binding));
      if (post) return post;
      throw new Error('Physical firmware requires the captured exclusive reservation');
    }
    return value;
  };
  const fence = (value: Role, connection?: Connection) => {
    active?.hooks?.signal?.throwIfAborted();
    active?.hooks?.assertCurrent?.();
    if (
      !active ||
      !options.isCurrent(value.binding) ||
      lookupQualifiedFirmwarePhysicalProfile(value.binding) !== value.profile ||
      !isQualifiedFirmwarePhysicalProfile(value.profile)
    )
      throw new Error('Firmware assignment/profile lease changed');
    if (value.cleanupFault) throw new Error('Retired firmware interface cleanup is unconfirmed');
    const current = options.capture(value.binding);
    if (
      current &&
      value.original &&
      (current.device !== value.original.device ||
        current.session !== value.original.session ||
        !same(current.binding, value.original.binding))
    )
      throw new Error('Firmware runtime interface was replaced');
    if (!value.retired && value.original && !current)
      throw new Error('Captured runtime disappeared before entry');
    if (
      connection &&
      (!connection.device.opened || (value.runtime !== connection && value.loader !== connection))
    )
      throw new Error('Firmware connection epoch is stale or closed');
    active.hooks?.signal?.throwIfAborted();
  };
  const exchange = async (
    value: Role,
    connection: Connection,
    request: Uint8Array,
    timeoutMs = 1200,
    beforeSend?: () => void,
  ) => {
    fence(value, connection);
    const reply = await connection.transport.exchangeWithFence(request.slice(), timeoutMs, () => {
      fence(value, connection);
      beforeSend?.();
    });
    fence(value, connection);
    if (!(reply instanceof Uint8Array) || reply.length !== 64 || reply[0] !== request[0])
      throw new Error('Malformed firmware read reply');
    return reply.slice();
  };
  const memory = async (
    value: Role,
    connection: Connection,
    address: number,
    length: number,
    selector: 0 | 1,
  ) => {
    const bytes = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += 32) {
      const n = Math.min(32, length - offset),
        reply = await exchange(
          value,
          connection,
          packet(0x65, n, ...addr(address + offset), selector),
        );
      if (reply[1] !== n) throw new Error('Firmware memory read length mismatch');
      bytes.set(reply.slice(2, 2 + n), offset);
    }
    return bytes;
  };
  const header = async (
    value: Role,
    connection: Connection,
    profile: FirmwarePhysicalReadbackProfile,
  ) => {
    const configuration = await exchange(value, connection, packet(6, 1));
    const view = new DataView(configuration.buffer, configuration.byteOffset, 64);
    if (
      configuration[1] !== profile.product ||
      `${configuration[2]}.${configuration[3]}` !== profile.core ||
      `${view.getUint16(15, true)}.${view.getUint16(17, true)}` !== profile.firmware ||
      configuration[5] !== profile.channels ||
      configuration[12] !== profile.presets
    )
      throw new Error('Firmware runtime identity/readback dialect changed');
    const hardware = await exchange(value, connection, packet(0x66, 0));
    if (
      hardware[10] !== profile.amplifier ||
      hardware[11] !== profile.moduleType ||
      hardware[12] !== profile.product
    )
      throw new Error('Firmware hardware identity changed');
    const name = await exchange(value, connection, packet(3, 8)),
      status = await exchange(value, connection, packet(5, 1));
    const serialBytes = await memory(value, connection, 0x100, 32, 0);
    if (ascii(serialBytes) !== value.binding.serial)
      throw new Error('Firmware runtime serial changed');
    // Conservative browser policy: the native OEM-context derivation for
    // firmware item8/0x0100 is not yet qualified. No stored-mask waiver.
    if (profile.core === '5.1' && decodeStatusFlags(status).locked)
      throw new Error('Firmware entry requires an unlocked5.1 runtime');
    const result: unknown = value.profile.assertRuntimeAccess({
      configuration: configuration.slice(),
      hardware: hardware.slice(),
      status: status.slice(),
    });
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result).catch(() => {});
      throw new Error('Firmware permission policy must complete synchronously');
    }
    return { configuration, hardware, name, status, serialBytes };
  };
  const sameMetadata = (
    before: CapturedMetadata,
    after: CapturedMetadata,
    profile: FirmwarePhysicalReadbackProfile,
  ) => {
    for (const [name, command] of [
      ['configuration', 6],
      ['hardware', 102],
      ['name', 3],
      ['status', 5],
    ] as const)
      if (
        before[name].some(
          (byte, i) => ((byte ^ after[name][i]) & profile.reportMasks[command][i]) !== 0,
        )
      )
        return false;
    return same(Array.from(before.serialBytes), Array.from(after.serialBytes));
  };
  const closeOwned = async (connection: Connection) => {
    await connection.transport.close();
    if (connection.device.opened) throw new Error('Owned firmware interface did not close');
  };
  const boundedDiscovery = <T>(work: Promise<T>, milliseconds: number): Promise<T> =>
    new Promise((resolve, reject) => {
      const signal = active?.hooks?.signal;
      const finish = (error?: unknown, value?: T) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value!);
      };
      const abort = () => finish(signal?.reason ?? new Error('Firmware discovery cancelled'));
      const timer = setTimeout(
        () => finish(new Error('Firmware discovery query exceeded its bound')),
        Math.max(1, milliseconds),
      );
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      work.then((value) => finish(undefined, value), finish);
    });
  const discover = async (
    value: Role,
    kind: 'loader' | 'runtime',
    expected?: FirmwareJournalSource['expectedAfter'],
  ): Promise<Connection> => {
    const start = now(),
      maxPolls = Math.ceil(timeout / interval) + 1;
    for (let poll = 0; poll < maxPolls && now() - start <= timeout; poll++) {
      fence(value);
      const hid = options.hid ?? (typeof navigator !== 'undefined' ? navigator.hid : undefined);
      if (!hid) throw new Error('Granted HID discovery unavailable');
      const granted = [...(await boundedDiscovery(hid.getDevices(), timeout - (now() - start)))];
      fence(value);
      const matches = [
        ...(await boundedDiscovery(
          kind === 'loader'
            ? value.profile.correlateLoader(value.binding, granted)
            : value.profile.correlateRuntime(value.binding, granted),
          timeout - (now() - start),
        )),
      ];
      fence(value);
      if (matches.length > 1)
        throw new Error('Firmware re-enumeration is ambiguous; no interface was selected');
      if (matches.length === 1) {
        const match: FirmwarePhysicalCandidate = matches[0];
        if (
          !granted.includes(match.device) ||
          match.serial !== value.binding.serial ||
          !serial(match.hidSerial) ||
          !serial(match.serial) ||
          match.device.opened ||
          options
            .assignedDevices()
            .some((device) => device === match.device && device !== value.original?.device) ||
          [...active!.roles.values()].some(
            (other) => other !== value && other.original?.device === match.device,
          )
        )
          throw new Error(
            'Discovered firmware interface is uncorrelated, open or assigned elsewhere',
          );
        const vendor = kind === 'loader' ? value.profile.loader.vendorId : 0x345e,
          product = kind === 'loader' ? value.profile.loader.productId : 0x03e8;
        if (match.device.vendorId !== vendor || match.device.productId !== product)
          throw new Error('Discovered firmware descriptor differs from qualified profile');
        let connection: Connection | undefined;
        try {
          fence(value);
          await match.device.open();
          fence(value);
          if (!match.device.opened) throw new Error('Firmware interface did not open');
          epoch = Math.max(epoch + 1, value.binding.connectionEpoch + 1);
          connection = {
            device: match.device,
            transport: new WebHidTransport(match.device),
            owned: true,
            correlated: { serial: match.serial, hidSerial: match.hidSerial },
            binding: {
              ...clone(value.binding),
              connectionId: `firmware-hid:${epoch}`,
              connectionEpoch: epoch,
              hidSerial: kind === 'runtime' ? value.binding.hidSerial : match.hidSerial,
              ...(kind === 'runtime'
                ? { core: expected!.core!, firmware: expected!.firmware! }
                : {}),
            },
          };
          active!.opened.add(connection);
          if (kind === 'loader') value.loader = connection;
          else value.runtime = connection;
          fence(value, connection);
          if (kind === 'runtime') {
            if (match.hidSerial !== value.binding.hidSerial)
              throw new Error('Fresh runtime descriptor identity changed');
            await header(value, connection, readback(value.profile, connection.binding));
          }
          return connection;
        } catch (error) {
          if (connection) {
            await closeOwned(connection);
            active?.opened.delete(connection);
          } else if (match.device.opened) await match.device.close();
          throw error;
        }
      }
      if (poll + 1 < maxPolls && now() - start < timeout) {
        await sleep(Math.min(interval, timeout - (now() - start)));
        fence(value);
      }
    }
    throw new Error('Qualified firmware interface did not reappear within the discovery bound');
  };
  const port: FirmwarePhysicalUpdatePort = {
    availability,
    async reserve(bindings, work, hooks) {
      if (active) throw new Error('Physical firmware adapter already reserved');
      if (
        !bindings.length ||
        bindings.length > 2 ||
        new Set(bindings.map((b) => b.assignmentId)).size !== bindings.length ||
        new Set(bindings.map((b) => b.serial)).size !== bindings.length
      )
        throw new Error('Firmware roles must be explicit distinct assignments');
      const roles = bindings.map((binding) => {
        const profile = checkedProfile(binding),
          original = options.capture(binding);
        if (
          original &&
          (!same(original.binding, binding) ||
            original.device.vendorId !== 0x345e ||
            original.device.productId !== 0x03e8 ||
            !(original.session.transport instanceof WebHidTransport) ||
            original.session.transport.device !== original.device)
        )
          throw new Error('Runtime session/interface capture differs');
        if (
          original &&
          (!original.descriptor ||
            original.descriptor.vendorId !== 0x345e ||
            original.descriptor.productId !== 0x03e8 ||
            original.descriptor.family !== binding.family ||
            original.descriptor.hidSerial !== binding.hidSerial ||
            original.descriptor.binding.serial !== binding.serial ||
            original.descriptor.binding.product !== binding.product ||
            original.descriptor.binding.core !== binding.core ||
            original.descriptor.binding.firmware !== binding.firmware)
        )
          throw new Error('Runtime descriptor proof does not match captured identity');
        const value: Role = {
          binding: clone(binding),
          original,
          profile,
          entryCalled: false,
          retired: !original,
        };
        if (original)
          value.runtime = {
            device: original.device,
            transport: original.session.transport as WebHidTransport,
            binding: clone(binding),
            owned: false,
          };
        return value;
      });
      const originals = roles.flatMap((value) => (value.original ? [value.original] : []));
      if (
        new Set(originals.map((value) => value.device)).size !== originals.length ||
        new Set(originals.map((value) => value.session)).size !== originals.length
      )
        throw new Error('Firmware roles alias a physical interface/session');
      const sessions = originals
        .map((value) => value.session)
        .sort((a, b) => a.lockOrder - b.lockOrder);
      const reserve = (index: number): Promise<unknown> =>
        index === sessions.length
          ? (async () => {
              active = {
                roles: new Map(roles.map((value) => [value.binding.assignmentId, value])),
                hooks,
                opened: new Set(),
              };
              let primaryError: unknown;
              try {
                roles.forEach((value) => fence(value));
                return await work();
              } catch (error) {
                primaryError = error;
                throw error;
              } finally {
                const lease = active;
                try {
                  const closed = await Promise.allSettled([...lease.opened].map(closeOwned));
                  const failures = closed.filter(
                    (item): item is PromiseRejectedResult => item.status === 'rejected',
                  );
                  if (failures.length)
                    throw new AggregateError(
                      [
                        ...(primaryError ? [primaryError] : []),
                        ...failures.map((item) => item.reason),
                      ],
                      `Firmware interface cleanup failed${primaryError ? ': ' + detail(primaryError) : ''}`,
                    );
                } finally {
                  active = undefined;
                }
              }
            })()
          : sessions[index].exclusive(() => reserve(index + 1));
      return (await reserve(0)) as Awaited<ReturnType<typeof work>>;
    },
    async preflightRuntime(binding) {
      const value = role(binding);
      fence(value);
      if (!value.runtime || value.retired)
        throw new Error('Captured ordinary runtime is unavailable');
      const profile = readback(value.profile, binding),
        fresh = await header(value, value.runtime, profile);
      if (value.beforeMetadata && !sameMetadata(value.beforeMetadata, fresh, profile))
        throw new Error('Firmware settings changed after the preservation capture');
      return clone(binding);
    },
    async captureBefore(binding) {
      return capture(binding);
    },
    async captureAfter(binding) {
      const value = role(binding),
        result = await capture(binding),
        connection = value.runtime!;
      if (connection.owned) {
        await closeOwned(connection);
        active!.opened.delete(connection);
      }
      return result;
    },
    async enterBootloader(binding, context: FirmwareEntryContext) {
      const value = role(binding);
      fence(value);
      if (!value.runtime || value.retired || value.entryCalled)
        throw new Error('Firmware entry capability is stale or consumed');
      await port.preflightRuntime(binding);
      value.entryCalled = true;
      let attempted = false;
      try {
        const outcome = await value.runtime.transport.transitionToBootloader(
          context.payload.slice(),
          () => {
            fence(value, value.runtime);
            context.beforeWireSend();
            attempted = true;
            value.retired = true;
            active!.opened.add(value.runtime!);
          },
        );
        return outcome;
      } catch (error) {
        if (!attempted) return 'not-sent';
        throw error;
      } finally {
        if (attempted) {
          try {
            options.onRuntimeRetired?.(clone(binding));
          } catch {
            /* View notification cannot interrupt cleanup. */
          }
          try {
            await closeOwned(value.runtime);
            active!.opened.delete(value.runtime);
          } catch (error) {
            value.cleanupFault = error;
            throw error;
          }
        }
      }
    },
    async discoverBootloader(binding) {
      const value = role(binding);
      fence(value);
      const connection = value.loader ?? (await discover(value, 'loader'));
      const identity = async (): Promise<FirmwareBootloaderIdentity> => {
        const configuration = await exchange(value, connection, packet(6, 1));
        const expected = value.profile.loader;
        if (
          configuration[1] !== expected.product ||
          configuration[2] !== 99 ||
          configuration[3] !== expected.build ||
          configuration[4] !== expected.version
        )
          throw new Error('Bootloader06 differs from qualified dialect');
        return {
          serial: connection.correlated!.serial,
          hidSerial: connection.correlated!.hidSerial,
          family: value.profile.family,
          connectionId: connection.binding.connectionId,
          connectionEpoch: connection.binding.connectionEpoch,
          configuration,
        };
      };
      const first = await identity();
      const programPort: FirmwareReferencePort = {
        readBootloaderIdentity: identity,
        currentConnection: () => {
          fence(value, connection);
          return {
            connectionId: connection.binding.connectionId,
            connectionEpoch: connection.binding.connectionEpoch,
          };
        },
        async exchange(request, context) {
          if (
            request.length !== 64 ||
            ![0x40, 0x43].includes(request[0]) ||
            context.connectionId !== connection.binding.connectionId ||
            context.connectionEpoch !== connection.binding.connectionEpoch
          )
            throw new Error('Firmware stream epoch/command differs');
          const payload = await exchange(
            value,
            connection,
            request,
            context.timeoutMs,
            context.beforeWireSend,
          );
          return {
            requestId: context.requestId,
            connectionId: connection.binding.connectionId,
            connectionEpoch: connection.binding.connectionEpoch,
            reportId: 0,
            payload,
          };
        },
      };
      return {
        identity: first,
        channel: createQualifiedPhysicalFirmwareChannel(programPort, value.profile),
      };
    },
    async discoverRuntime(binding, expected) {
      const value = role(binding);
      fence(value);
      if (!expected?.core || !expected.firmware)
        throw new Error('Fresh runtime version expectation missing');
      readback(value.profile, { ...binding, core: expected.core, firmware: expected.firmware });
      if (value.loader) {
        await closeOwned(value.loader);
        active!.opened.delete(value.loader);
        value.loader = undefined;
      }
      const connection = await discover(value, 'runtime', expected);
      return clone(connection.binding);
    },
  };
  async function capture(binding: FirmwareJournalBinding): Promise<FirmwareJournalBefore> {
    const value = role(binding);
    fence(value);
    const connection = value.runtime;
    if (!connection || !same(connection.binding, binding))
      throw new Error('Firmware capture runtime epoch differs');
    const profile = readback(value.profile, binding),
      before = await header(value, connection, profile),
      images: FirmwareJournalImage[] = [];
    for (const [command, bytes] of [
      [3, before.name],
      [5, before.status],
      [6, before.configuration],
      [102, before.hardware],
    ] as const)
      images.push({
        id: `report-${command}`,
        kind: 'report',
        hex: hex(bytes),
        sha256: firmwareImageSha256(hex(bytes)),
        compareMaskHex: hex(Uint8Array.from(profile.reportMasks[command])),
      });
    for (let address = 0x10000; address <= 0x27000; address += 4096) {
      const bytes = await memory(value, connection, address, 4096, 1),
        text = hex(bytes);
      images.push({
        id: `flash-${address}`,
        kind: 'spi-flash',
        address,
        hex: text,
        sha256: firmwareImageSha256(text),
      });
    }
    for (const address of [
      0x100,
      0x120,
      0x140,
      ...Array.from({ length: 12 }, (_, i) => 0x200 + i * 32),
    ]) {
      const bytes = await memory(value, connection, address, 32, 0),
        text = hex(bytes);
      images.push({
        id: `eeprom-${address}`,
        kind: 'eeprom',
        address,
        hex: text,
        sha256: firmwareImageSha256(text),
      });
    }
    const after = await header(value, connection, profile);
    if (!sameMetadata(before, after, profile))
      throw new Error('Firmware metadata changed during known-range capture');
    if (!value.retired && same(binding, value.binding)) value.beforeMetadata = before;
    const result = {
      images,
      gaps: ['original-pic32-program-not-captured', 'unmapped-calibration-not-captured'],
      sha256: '',
    };
    result.sha256 = firmwareBeforeSha256(result);
    return result;
  }
  return createGuardedPhysicalFirmwareUpdateAdapter(port);
}
