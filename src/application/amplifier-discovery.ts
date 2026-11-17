import type { Slot } from '../domain/model';
import {
  createBrowserAmplifierRolePreferencesBackend,
  parseAmplifierRolePreferences,
  type AmplifierRolePreferences,
  type AmplifierRolePreferencesBackend,
} from './amplifier-role-preferences';

export interface AmplifierDiscoveryConnection {
  device: HIDDevice;
  identity: { serial: string; name?: string; firmware?: string };
  status: { raw: Uint8Array };
  session: { busy: boolean; close(): Promise<void> };
}
export type AmplifierDiscoveryHid = Pick<
  HID,
  'getDevices' | 'addEventListener' | 'removeEventListener'
>;
export type AmplifierAssignmentSource = 'manual' | 'remembered' | 'routing';
export interface DiscoveredAmplifier {
  id: string;
  serial?: string;
  name: string;
  firmware?: string;
  phase: 'available' | 'connecting' | 'connected' | 'error';
  slot?: Slot;
  source?: AmplifierAssignmentSource;
  hint?: Slot;
  hintReason: string;
  error?: string;
}
export interface AmplifierDiscoverySnapshot {
  revision: number;
  supported: boolean;
  phase: 'idle' | 'discovering' | 'ready' | 'unavailable' | 'error';
  autoReconnect: boolean;
  roles: Partial<Record<Slot, DiscoveredAmplifier & { serial: string }>>;
  devices: readonly DiscoveredAmplifier[];
  error?: string;
  preferencesError?: string;
}
export interface AmplifierDiscoveryOptions<C extends AmplifierDiscoveryConnection> {
  hid?: () => AmplifierDiscoveryHid | undefined;
  currentBindings(): Partial<Record<Slot, C>>;
  /** One synchronous publication. The owner invalidates role-bound operation leases. */
  replaceBindings(next: Partial<Record<Slot, C>>): void;
  probe(device: HIDDevice): Promise<C>;
  canChangeBindings(): boolean;
  preferences?: AmplifierRolePreferencesBackend;
  id?: () => string;
}
export interface AmplifierDiscoveryController {
  getSnapshot(): AmplifierDiscoverySnapshot;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  dispose(): void;
  discover(): Promise<void>;
  acceptGranted(
    devices: readonly HIDDevice[],
    choice?: { slot?: Slot; serial?: string },
  ): Promise<void>;
  assign(id: string, slot: Slot, expectedRevision: number): Promise<void>;
  swap(expectedRevision: number): void;
  disconnect(slot: Slot, expectedRevision?: number): Promise<void>;
  /** Host notification after its legacy explicit-disconnect cleanup completed. */
  noteManualDisconnect(serial: string): void;
  setAutoReconnect(enabled: boolean): void;
  refreshBindings(confirmedSlot?: Slot): void;
}
const slots: readonly Slot[] = ['left', 'right'];
const problem = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 1024);
const eligible = (device: HIDDevice) =>
  device.vendorId === 0x345e &&
  device.productId === 0x03e8 &&
  Array.isArray(device.collections) &&
  device.collections.some(
    (collection) => collection.usagePage === 0xff00 && collection.usage === 1,
  );
const routing = (raw: Uint8Array): { hint?: Slot; hintReason: string } => {
  const value = raw.length > 11 ? raw[11] & 7 : -1;
  return value === 1
    ? { hint: 'right', hintReason: 'Detected from Right digital routing' }
    : value === 2
      ? { hint: 'left', hintReason: 'Detected from Left digital routing' }
      : { hintReason: 'The amplifier does not identify a physical Left or Right side' };
};
interface Candidate {
  id: string;
  device: HIDDevice;
  generation: number;
  online: boolean;
  serial?: string;
  name: string;
  firmware?: string;
  hint?: Slot;
  hintReason: string;
  phase: DiscoveredAmplifier['phase'];
  error?: string;
  source?: AmplifierAssignmentSource;
}

/** Discovery and local connection assignment only. This service has no device
 * setter, project replacement or permission-chooser port. */
export function createAmplifierDiscovery<C extends AmplifierDiscoveryConnection>(
  options: AmplifierDiscoveryOptions<C>,
): AmplifierDiscoveryController {
  const candidates = new Map<HIDDevice, Candidate>(),
    listeners = new Set<() => void>(),
    suppressed = new Set<string>(),
    backend = options.preferences ?? createBrowserAmplifierRolePreferencesBackend();
  let preferences: AmplifierRolePreferences = { version: 1, autoReconnect: true, assignments: {} },
    preferencesError: string | undefined,
    error: string | undefined,
    revision = 0,
    epoch = 0,
    started = false,
    hid: AmplifierDiscoveryHid | undefined,
    phase: AmplifierDiscoverySnapshot['phase'] = 'idle',
    flight: Promise<void> | undefined,
    flightEpoch = 0,
    assigning = false,
    rescan = false;
  let snapshot: AmplifierDiscoverySnapshot = Object.freeze({
    revision,
    supported: false,
    phase,
    autoReconnect: true,
    roles: Object.freeze({}),
    devices: Object.freeze([]),
  });
  const getHid = () =>
    options.hid ? options.hid() : typeof navigator !== 'undefined' ? navigator.hid : undefined;
  const candidate = (device: HIDDevice) => {
    let value = candidates.get(device);
    if (!value) {
      for (const [key, entry] of candidates) if (!entry.online) candidates.delete(key);
      if (candidates.size >= 32)
        throw new Error(
          'Too many amplifier interfaces are available. Disconnect an unused device and retry.',
        );
      const id = options.id?.() ?? crypto.randomUUID();
      if (
        !/^[a-zA-Z0-9._:-]{1,200}$/.test(id) ||
        [...candidates.values()].some((entry) => entry.id === id)
      )
        throw new Error('Invalid or repeated amplifier discovery ID.');
      value = {
        id,
        device,
        generation: 0,
        online: true,
        name: device.productName || 'Hypex amplifier',
        hintReason: 'Choose a side to connect',
        phase: 'available',
      };
      candidates.set(device, value);
    }
    return value;
  };
  const remember = (serial: string, slot: Slot, source: 'manual' | 'routing') => {
    // A remembered role has one authoritative serial, never order-dependent history.
    for (const [key, value] of Object.entries(preferences.assignments))
      if (value.slot === slot || key === serial) delete preferences.assignments[key];
    Object.defineProperty(preferences.assignments, serial, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: { slot, source },
    });
  };
  const remembered = (serial: string) =>
    Object.hasOwn(preferences.assignments, serial) ? preferences.assignments[serial] : undefined;
  const persist = () => {
    try {
      backend.write(structuredClone(preferences));
      preferencesError = undefined;
    } catch {
      preferencesError =
        'Assignments work for this session, but this browser could not remember them.';
    }
  };
  const sync = (importExisting = false) => {
    let imported = false;
    for (const slot of slots) {
      const connection = options.currentBindings()[slot];
      if (!connection) continue;
      const entry = candidate(connection.device);
      Object.assign(entry, {
        serial: connection.identity.serial,
        name: connection.identity.name || connection.device.productName || 'Hypex amplifier',
        firmware: connection.identity.firmware,
        online: true,
        phase: 'connected',
        ...routing(connection.status.raw),
      });
      entry.source ??= 'manual';
      if (
        importExisting &&
        (remembered(connection.identity.serial)?.slot !== slot ||
          remembered(connection.identity.serial)?.source !== 'manual')
      ) {
        remember(connection.identity.serial, slot, 'manual');
        imported = true;
      }
    }
    if (imported) persist();
  };
  const publish = () => {
    sync();
    const bindings = options.currentBindings(),
      roles: AmplifierDiscoverySnapshot['roles'] = {},
      devices: DiscoveredAmplifier[] = [];
    for (const entry of candidates.values()) {
      if (!entry.online) continue;
      const slot = slots.find((value) => bindings[value]?.device === entry.device);
      const item = Object.freeze({
        id: entry.id,
        ...(entry.serial ? { serial: entry.serial } : {}),
        name: entry.name,
        ...(entry.firmware ? { firmware: entry.firmware } : {}),
        phase: slot
          ? ('connected' as const)
          : entry.phase === 'connected'
            ? ('available' as const)
            : entry.phase,
        ...(slot ? { slot } : {}),
        ...(entry.source ? { source: entry.source } : {}),
        ...(entry.hint ? { hint: entry.hint } : {}),
        hintReason: entry.hintReason,
        ...(entry.error ? { error: entry.error } : {}),
      });
      devices.push(item);
      if (slot && entry.serial) roles[slot] = item as DiscoveredAmplifier & { serial: string };
    }
    const next = {
      revision,
      supported: !!hid,
      phase,
      autoReconnect: preferences.autoReconnect,
      roles: Object.freeze(roles),
      devices: Object.freeze(devices),
      ...(error ? { error } : {}),
      ...(preferencesError ? { preferencesError } : {}),
    };
    if (JSON.stringify({ ...next, revision: 0 }) === JSON.stringify({ ...snapshot, revision: 0 }))
      return;
    snapshot = Object.freeze({ ...next, revision: ++revision });
    listeners.forEach((listener) => listener());
  };
  const idle = () => {
    if (!started) throw new Error('Amplifier discovery has not started.');
    if (!options.canChangeBindings())
      throw new Error('Finish the current amplifier operation before changing connections.');
  };
  const expected = (value: number) => {
    if (!Number.isSafeInteger(value) || value !== revision)
      throw new Error('Amplifier connections changed; review the current assignments.');
  };
  const close = async (connection: C) => {
    try {
      await connection.session.close();
    } catch {
      /* A failed/removed interface is already unusable. */
    }
  };
  const probe = async (entry: Candidate, capturedEpoch: number) => {
    if (entry.device.opened)
      throw new Error(
        'This amplifier is already open in another controller. Close HFD or its other tab, then retry.',
      );
    const generation = entry.generation;
    entry.phase = 'connecting';
    entry.error = undefined;
    publish();
    const connection = await options.probe(entry.device);
    if (!started || epoch !== capturedEpoch || entry.generation !== generation || !entry.online) {
      await close(connection);
      throw new Error('Amplifier disconnected or discovery was canceled.');
    }
    if (
      connection.device !== entry.device ||
      !/^[\x20-\x7e]{1,512}$/.test(connection.identity.serial) ||
      !connection.identity.serial.trim()
    ) {
      await close(connection);
      throw new Error('The amplifier identity could not be established.');
    }
    Object.assign(entry, {
      serial: connection.identity.serial,
      name: connection.identity.name || entry.device.productName || 'Hypex amplifier',
      firmware: connection.identity.firmware,
      phase: 'available',
      ...routing(connection.status.raw),
    });
    return connection;
  };
  const runScan = async (
    devices: readonly HIDDevice[],
    choice?: { slot?: Slot; serial?: string },
  ) => {
    const capturedEpoch = epoch,
      opened = new Map<Candidate, C>(),
      generations = new Map<Candidate, number>();
    phase = 'discovering';
    error = undefined;
    publish();
    try {
      const selected = [...new Set(devices)].filter(eligible);
      for (const entry of candidates.values())
        if (
          !selected.includes(entry.device) &&
          !Object.values(options.currentBindings()).some((live) => live.device === entry.device)
        )
          entry.online = false;
      for (const device of selected) {
        const entry = candidate(device);
        entry.online = true;
        if (Object.values(options.currentBindings()).some((live) => live.device === device))
          continue;
        if (
          !choice &&
          (!preferences.autoReconnect || (entry.serial && suppressed.has(entry.serial)))
        )
          continue;
        try {
          opened.set(entry, await probe(entry, capturedEpoch));
          generations.set(entry, entry.generation);
        } catch (failure) {
          entry.phase = 'error';
          entry.error = problem(failure);
        }
      }
      if (!started || epoch !== capturedEpoch) return;
      const currentEntries = [...opened.keys()].filter(
        (entry) => entry.online && entry.generation === generations.get(entry),
      );
      // Only an actual explicit grant/connect action can resume a manually
      // disconnected identity. Background and Find scans preserve that choice.
      if (choice !== undefined)
        for (const entry of currentEntries)
          if (!choice.serial || choice.serial === entry.serial) suppressed.delete(entry.serial!);
      const bindings = options.currentBindings(),
        next = { ...bindings };
      if (choice?.slot) {
        const matches = currentEntries.filter(
          (entry) => !choice.serial || entry.serial === choice.serial,
        );
        if (matches.length !== 1)
          throw new Error(
            matches.length === 0 && selected.length === 1 && candidates.get(selected[0])?.error
              ? candidates.get(selected[0])!.error
              : choice.serial
                ? 'The requested permitted amplifier was not found.'
                : 'Choose one amplifier for this role.',
          );
        const entry = matches[0],
          connection = opened.get(entry)!;
        idle();
        if (next[choice.slot] || slots.some((slot) => next[slot]?.identity.serial === entry.serial))
          throw new Error(
            'That amplifier or role is already assigned. Use the assignment controls.',
          );
        next[choice.slot] = connection;
        entry.source = 'manual';
        suppressed.delete(entry.serial!);
        options.replaceBindings(next);
        opened.delete(entry);
        remember(entry.serial!, choice.slot, 'manual');
        persist();
      } else if (preferences.autoReconnect) {
        const proposed = currentEntries
          .filter((entry) => !suppressed.has(entry.serial!))
          .map((entry) => ({
            entry,
            remembered: remembered(entry.serial!),
            slot: remembered(entry.serial!)?.slot ?? entry.hint,
          }));
        const serialCounts = new Map<string, number>();
        for (const entry of currentEntries)
          serialCounts.set(entry.serial!, (serialCounts.get(entry.serial!) ?? 0) + 1);
        let changed = false;
        for (const plan of proposed) {
          const { entry, slot } = plan;
          if (
            serialCounts.get(entry.serial!) !== 1 ||
            slots.some((role) => bindings[role]?.identity.serial === entry.serial)
          ) {
            entry.error = 'Duplicate amplifier identity; choose a distinct device.';
            continue;
          }
          const contenders = proposed.filter((value) => value.slot === slot);
          const winners = contenders.some((value) => value.remembered)
            ? contenders.filter((value) => value.remembered)
            : contenders;
          if (!slot || next[slot] || winners.length !== 1 || winners[0] !== plan) {
            if (slot)
              entry.error = 'This side is already assigned or ambiguous. Choose Left or Right.';
            continue;
          }
          idle();
          next[slot] = opened.get(entry)!;
          changed = true;
          entry.source = plan.remembered ? 'remembered' : 'routing';
        }
        if (changed) {
          options.replaceBindings(next);
          for (const slot of slots) {
            const connection = next[slot];
            if (!connection || connection === bindings[slot]) continue;
            const entry = candidates.get(connection.device)!;
            opened.delete(entry);
            remember(
              entry.serial!,
              slot,
              entry.source === 'routing'
                ? 'routing'
                : (remembered(entry.serial!)?.source ?? 'manual'),
            );
          }
          persist();
        }
      }
      phase = 'ready';
    } catch (failure) {
      phase = 'error';
      error = problem(failure);
      throw failure;
    } finally {
      await Promise.all([...opened.values()].map(close));
      if (started && epoch === capturedEpoch) publish();
    }
  };
  const scan = (
    devices?: readonly HIDDevice[],
    choice?: { slot?: Slot; serial?: string },
  ): Promise<void> => {
    if (choice?.slot !== undefined && !slots.includes(choice.slot))
      return Promise.reject(new Error('Choose a valid amplifier side.'));
    if (
      choice?.serial !== undefined &&
      (!choice.serial || choice.serial.length > 512 || !/^[\x20-\x7e]+$/.test(choice.serial))
    )
      return Promise.reject(new Error('Choose a valid amplifier identity.'));
    if (flight)
      return devices || flightEpoch !== epoch
        ? flight.catch(() => {}).then(() => scan(devices, choice))
        : flight;
    if (assigning) return Promise.reject(new Error('Wait for the amplifier assignment to finish.'));
    flightEpoch = epoch;
    const work = (async () => {
      if (!started) throw new Error('Amplifier discovery has not started.');
      if (!hid) return;
      phase = 'discovering';
      error = undefined;
      publish();
      try {
        const granted = devices ?? (await hid.getDevices());
        await runScan(granted, choice);
      } catch (failure) {
        phase = 'error';
        error = problem(failure);
        publish();
        throw failure;
      }
    })();
    flight = work.finally(() => {
      flight = undefined;
      scheduleRescan();
    });
    return flight;
  };
  const scheduleRescan = () => {
    if (rescan && started && !flight && !assigning) {
      rescan = false;
      void scan().catch(() => {});
    }
  };
  const onConnect = () => {
    if (flight || assigning) rescan = true;
    else void scan().catch(() => {});
  };
  const onDisconnect = (event: HIDConnectionEvent) => {
    const entry = candidates.get(event.device);
    if (entry) {
      entry.online = false;
      entry.generation++;
    }
    const current = options.currentBindings(),
      next = { ...current };
    for (const slot of slots)
      if (current[slot]?.device === event.device) {
        delete next[slot];
        void close(current[slot]!);
      }
    if (slots.some((slot) => next[slot] !== current[slot])) options.replaceBindings(next);
    publish();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start() {
      if (started) return flight;
      started = true;
      epoch++;
      try {
        const value = backend.read();
        if (value !== null && value !== undefined)
          preferences = parseAmplifierRolePreferences(value);
      } catch {
        preferencesError = 'Saved amplifier assignments could not be read. Choose the roles again.';
      }
      hid = getHid();
      sync(true);
      phase = hid ? 'ready' : 'unavailable';
      publish();
      hid?.addEventListener('connect', onConnect);
      hid?.addEventListener('disconnect', onDisconnect);
      await scan();
    },
    dispose() {
      started = false;
      epoch++;
      rescan = false;
      hid?.removeEventListener('connect', onConnect);
      hid?.removeEventListener('disconnect', onDisconnect);
      phase = 'idle';
      publish();
    },
    async discover() {
      await scan();
    },
    acceptGranted(devices, choice) {
      return scan(devices, choice ?? {});
    },
    async assign(id, slot, expectedRevision) {
      expected(expectedRevision);
      idle();
      const entry = [...candidates.values()].find((value) => value.id === id && value.online);
      if (!entry || !slots.includes(slot))
        throw new Error('Choose an available amplifier and a valid side.');
      if (flight || assigning) throw new Error('Wait for amplifier discovery to finish.');
      const capturedEpoch = epoch,
        current = options.currentBindings(),
        existingSlot = slots.find((role) => current[role]?.device === entry.device);
      if (current[slot] && current[slot]?.device !== entry.device)
        throw new Error('That side is occupied. Use Swap Left/Right.');
      assigning = true;
      try {
        if (existingSlot) {
          const next = { ...current };
          delete next[existingSlot];
          next[slot] = current[existingSlot];
          if (existingSlot !== slot) options.replaceBindings(next);
        } else {
          const connection = await probe(entry, capturedEpoch);
          try {
            idle();
            if (
              options.currentBindings()[slot] ||
              slots.some(
                (role) =>
                  options.currentBindings()[role]?.identity.serial === connection.identity.serial,
              )
            )
              throw new Error('Amplifier assignments changed while connecting.');
            options.replaceBindings({ ...options.currentBindings(), [slot]: connection });
          } catch (failure) {
            await close(connection);
            throw failure;
          }
        }
        entry.source = 'manual';
        entry.error = undefined;
        suppressed.delete(entry.serial!);
        remember(entry.serial!, slot, 'manual');
        persist();
        publish();
      } catch (failure) {
        entry.phase = 'error';
        entry.error = problem(failure);
        throw failure;
      } finally {
        assigning = false;
        publish();
        scheduleRescan();
      }
    },
    swap(expectedRevision) {
      expected(expectedRevision);
      idle();
      if (flight || assigning) throw new Error('Wait for amplifier discovery to finish.');
      const current = options.currentBindings();
      if (!current.left && !current.right)
        throw new Error('Connect an amplifier before swapping sides.');
      const next: Partial<Record<Slot, C>> = {};
      if (current.right) next.left = current.right;
      if (current.left) next.right = current.left;
      options.replaceBindings(next);
      preferences.assignments = {};
      for (const slot of slots)
        if (next[slot]) {
          const entry = candidate(next[slot]!.device);
          entry.source = 'manual';
          remember(next[slot]!.identity.serial, slot, 'manual');
        }
      persist();
      publish();
    },
    async disconnect(slot, expectedRevision) {
      if (expectedRevision !== undefined) expected(expectedRevision);
      idle();
      if (flight || assigning) throw new Error('Wait for amplifier discovery to finish.');
      const connection = options.currentBindings()[slot];
      if (!connection) return;
      suppressed.add(connection.identity.serial);
      const next = { ...options.currentBindings() };
      delete next[slot];
      options.replaceBindings(next);
      await close(connection);
      publish();
    },
    noteManualDisconnect(serial) {
      if (
        !/^[\x20-\x7e]{1,512}$/.test(serial) ||
        ![...candidates.values()].some((entry) => entry.serial === serial)
      )
        throw new Error('The disconnected amplifier identity is not known to this browser.');
      if (
        Object.values(options.currentBindings()).some(
          (connection) => connection.identity.serial === serial,
        )
      )
        throw new Error('Release this amplifier connection before marking it disconnected.');
      suppressed.add(serial);
      publish();
    },
    setAutoReconnect(enabled) {
      if (!started) throw new Error('Amplifier discovery has not started.');
      if (typeof enabled !== 'boolean')
        throw new Error('Choose an automatic reconnect preference.');
      preferences.autoReconnect = enabled;
      persist();
      publish();
    },
    refreshBindings(confirmedSlot) {
      sync();
      if (confirmedSlot !== undefined) {
        if (!slots.includes(confirmedSlot)) throw new Error('Choose a valid amplifier side.');
        const connection = options.currentBindings()[confirmedSlot];
        if (!connection) throw new Error('The confirmed amplifier is no longer connected.');
        const entry = candidate(connection.device);
        entry.source = 'manual';
        suppressed.delete(connection.identity.serial);
        remember(connection.identity.serial, confirmedSlot, 'manual');
        persist();
      }
      publish();
    },
  };
}
