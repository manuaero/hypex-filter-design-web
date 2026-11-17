import { expect, it, vi } from 'vitest';
import {
  createAmplifierDiscovery,
  type AmplifierDiscoveryConnection,
  type AmplifierDiscoveryHid,
} from '../src/application/amplifier-discovery';
import {
  AMPLIFIER_ROLE_PREFERENCES_KEY,
  createBrowserAmplifierRolePreferencesBackend,
  parseAmplifierRolePreferences,
  type AmplifierRolePreferences,
} from '../src/application/amplifier-role-preferences';
import type { Slot } from '../src/domain/model';

type FakeDevice = { opened: boolean; serial: string; routing: number } & HIDDevice;
function device(serial: string, routing = 0): FakeDevice {
  return {
    serial,
    routing,
    opened: false,
    vendorId: 0x345e,
    productId: 0x03e8,
    productName: `Synthetic ${serial}`,
    collections: [{ usagePage: 0xff00, usage: 1 }],
  } as unknown as FakeDevice;
}
class FakeHid extends EventTarget {
  constructor(public devices: HIDDevice[]) {
    super();
  }
  getDevices = vi.fn(async () => this.devices);
  event(type: 'connect' | 'disconnect', device: HIDDevice) {
    const event = new Event(type);
    Object.defineProperty(event, 'device', { value: device });
    this.dispatchEvent(event);
  }
}
function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve: () => resolve(),
  };
}
function fixture(devices: FakeDevice[], stored: unknown = null) {
  let bindings: Partial<Record<Slot, AmplifierDiscoveryConnection>> = {},
    nextId = 0,
    idle = true,
    data = stored;
  const hid = new FakeHid(devices),
    connections: AmplifierDiscoveryConnection[] = [],
    write = vi.fn((value: AmplifierRolePreferences) => {
      data = structuredClone(value);
    }),
    replace = vi.fn((next) => {
      bindings = next;
    }),
    probe = vi.fn(async (value: HIDDevice) => {
      const source = value as FakeDevice;
      source.opened = true;
      const raw = new Uint8Array(64);
      raw[11] = source.routing;
      const connection = {
        device: value,
        identity: { serial: source.serial, name: source.productName, firmware: '5.7' },
        status: { raw },
        session: {
          busy: false,
          close: vi.fn(async () => {
            source.opened = false;
          }),
        },
      };
      connections.push(connection);
      return connection;
    }),
    controller = createAmplifierDiscovery({
      hid: () => hid as unknown as AmplifierDiscoveryHid,
      currentBindings: () => bindings,
      replaceBindings: replace,
      canChangeBindings: () => idle,
      probe,
      preferences: { read: () => data, write },
      id: () => `candidate-${++nextId}`,
    });
  return {
    controller,
    hid,
    probe,
    write,
    replace,
    connections,
    live: () => bindings,
    idle: (value: boolean) => {
      idle = value;
    },
    stored: () => data,
    import: (next: Partial<Record<Slot, AmplifierDiscoveryConnection>>) => {
      bindings = next;
    },
  };
}
const prefs = (
  assignments: AmplifierRolePreferences['assignments'],
  autoReconnect = true,
): AmplifierRolePreferences => ({ version: 1, autoReconnect, assignments });

it('automatically connects distinct exclusive routing hints with one two-role publication and no project capability', async () => {
  const left = device('SIM-L', 2),
    right = device('SIM-R', 1),
    f = fixture([right, left]);
  await f.controller.start();
  expect(f.live().left?.identity.serial).toBe('SIM-L');
  expect(f.live().right?.identity.serial).toBe('SIM-R');
  expect(f.replace).toHaveBeenCalledTimes(1);
  expect(f.controller.getSnapshot().roles.right).toMatchObject({
    hint: 'right',
    source: 'routing',
    phase: 'connected',
  });
  expect(
    f.connections.every(
      (connection) => !(connection.session.close as ReturnType<typeof vi.fn>).mock.calls.length,
    ),
  ).toBe(true);
});

it('remembers explicit serial roles instead of opposite routing or USB enumeration order', async () => {
  const a = device('SIM-A', 2),
    b = device('SIM-B', 1),
    f = fixture(
      [a, b],
      prefs({
        'SIM-A': { slot: 'right', source: 'manual' },
        'SIM-B': { slot: 'left', source: 'manual' },
      }),
    );
  await f.controller.start();
  expect(f.live().right?.device).toBe(a);
  expect(f.live().left?.device).toBe(b);
  expect(f.controller.getSnapshot().roles.right?.source).toBe('remembered');
});

it('never assigns the first of two colliding Right hints and closes both unassigned probes', async () => {
  const f = fixture([device('SIM-A', 1), device('SIM-B', 1)]);
  await f.controller.start();
  expect(f.live()).toEqual({});
  expect(f.replace).not.toHaveBeenCalled();
  expect(
    f.controller.getSnapshot().devices.every((entry) => entry.error?.includes('ambiguous')),
  ).toBe(true);
  expect(
    f.connections.every(
      (connection) =>
        (connection.session.close as ReturnType<typeof vi.fn>).mock.calls.length === 1,
    ),
  ).toBe(true);
});

it('retains unknown, mono and mixer-routing amps as closed unassigned choices', async () => {
  const f = fixture([device('SIM-MONO', 0), device('SIM-MIX', 3), device('SIM-OFF', 4)]);
  await f.controller.start();
  expect(f.live()).toEqual({});
  expect(f.controller.getSnapshot().devices).toHaveLength(3);
  expect(
    f.controller.getSnapshot().devices.every((entry) => !entry.hint && entry.phase === 'available'),
  ).toBe(true);
  expect(
    f.connections.every(
      (connection) =>
        (connection.session.close as ReturnType<typeof vi.fn>).mock.calls.length === 1,
    ),
  ).toBe(true);
});

it('manual assignment reopens an unknown amp, retires conflicting role preferences and moves only connection bindings', async () => {
  const a = device('SIM-A'),
    f = fixture([a], prefs({ 'OLD-R': { slot: 'right', source: 'manual' } }));
  await f.controller.start();
  const entry = f.controller.getSnapshot().devices[0];
  await f.controller.assign(entry.id, 'right', f.controller.getSnapshot().revision);
  const connection = f.live().right;
  expect(f.probe).toHaveBeenCalledTimes(2);
  expect(f.stored()).toEqual(prefs({ 'SIM-A': { slot: 'right', source: 'manual' } }));
  await f.controller.assign(entry.id, 'left', f.controller.getSnapshot().revision);
  expect(f.live()).toEqual({ left: connection });
  expect(f.probe).toHaveBeenCalledTimes(2);
  expect(connection!.status.raw[11]).toBe(0);
});

it('an explicit occupied-side assignment is refused; Swap moves two identities atomically without session writes or closes', async () => {
  const f = fixture([device('SIM-L', 2), device('SIM-R', 1)]);
  await f.controller.start();
  const before = { ...f.live() },
    entry = f.controller.getSnapshot().roles.right!;
  await expect(
    f.controller.assign(entry.id, 'left', f.controller.getSnapshot().revision),
  ).rejects.toThrow(/occupied/);
  f.controller.swap(f.controller.getSnapshot().revision);
  expect(f.live()).toEqual({ left: before.right, right: before.left });
  expect(f.replace).toHaveBeenCalledTimes(2);
  expect(
    f.connections.every(
      (connection) => !(connection.session.close as ReturnType<typeof vi.fn>).mock.calls.length,
    ),
  ).toBe(true);
});

it('imports an existing manual Right connection without opening or reading it again, overriding stale preferences', async () => {
  const a = device('SIM-A', 2),
    f = fixture([a], prefs({ 'SIM-A': { slot: 'left', source: 'routing' } }));
  const existing = await f.probe(a);
  f.probe.mockClear();
  f.import({ right: existing });
  await f.controller.start();
  expect(f.live().right).toBe(existing);
  expect(f.probe).not.toHaveBeenCalled();
  expect(f.stored()).toEqual(prefs({ 'SIM-A': { slot: 'right', source: 'manual' } }));
  f.controller.dispose();
  expect(existing.session.close).not.toHaveBeenCalled();
});

it('explicit legacy connection confirmation remembers its actual role while ordinary refresh preserves inferred source', async () => {
  const a = device('SIM-A', 1),
    f = fixture([a]);
  await f.controller.start();
  f.controller.refreshBindings();
  expect(f.controller.getSnapshot().roles.right?.source).toBe('routing');
  f.controller.refreshBindings('right');
  expect(f.controller.getSnapshot().roles.right?.source).toBe('manual');
  expect(f.stored()).toEqual(prefs({ 'SIM-A': { slot: 'right', source: 'manual' } }));
  expect(f.probe).toHaveBeenCalledTimes(1);
});

it('manual disconnect stays offline through automatic hotplug and Find until an explicit assignment', async () => {
  const a = device('SIM-R', 1),
    f = fixture([a]);
  await f.controller.start();
  await f.controller.disconnect('right', f.controller.getSnapshot().revision);
  const reads = f.probe.mock.calls.length;
  f.hid.event('connect', a);
  await vi.waitFor(() => expect(f.controller.getSnapshot().phase).toBe('ready'));
  expect(f.live()).toEqual({});
  expect(f.probe).toHaveBeenCalledTimes(reads);
  await f.controller.discover();
  expect(f.live()).toEqual({});
  const available = f.controller.getSnapshot().devices.find((entry) => entry.serial === a.serial)!;
  await f.controller.assign(available.id, 'right', f.controller.getSnapshot().revision);
  expect(f.live().right?.device).toBe(a);
});

it('the legacy host can record its completed manual disconnect without another close or reconnect', async () => {
  const a = device('SIM-LEGACY-R', 1),
    f = fixture([a]);
  await f.controller.start();
  const connection = f.live().right!;
  expect(() => f.controller.noteManualDisconnect(a.serial)).toThrow(/Release/);
  expect(() => f.controller.noteManualDisconnect('UNKNOWN')).toThrow(/not known/);
  await connection.session.close();
  f.import({});
  f.idle(false);
  f.controller.noteManualDisconnect(a.serial);
  f.idle(true);
  f.hid.event('connect', a);
  await vi.waitFor(() => expect(f.controller.getSnapshot().phase).toBe('ready'));
  expect(f.live()).toEqual({});
  expect(f.probe).toHaveBeenCalledTimes(1);
  expect(connection.session.close).toHaveBeenCalledTimes(1);
  await f.controller.discover();
  expect(f.live()).toEqual({});
  await f.controller.acceptGranted([a], {});
  expect(f.live().right?.device).toBe(a);
});

it('turning automatic reconnect back on and scanning does not reverse a manual disconnect', async () => {
  const a = device('SIM-MANUAL-OFF', 1),
    f = fixture([a]);
  await f.controller.start();
  await f.controller.disconnect('right');
  f.controller.setAutoReconnect(false);
  f.controller.setAutoReconnect(true);
  await f.controller.discover();
  expect(f.live()).toEqual({});
  expect(f.probe).toHaveBeenCalledTimes(1);
});

it('explicitly reconnecting through the legacy host clears suppression for a later ordinary hotplug', async () => {
  const a = device('SIM-LEGACY-RESUME', 1),
    f = fixture([a]);
  await f.controller.start();
  await f.controller.disconnect('right');
  const explicit = await f.probe(a);
  f.import({ right: explicit });
  f.controller.refreshBindings('right');
  f.hid.devices = [];
  f.hid.event('disconnect', a);
  const replacement = device(a.serial, 0);
  f.hid.devices = [replacement];
  f.hid.event('connect', replacement);
  await vi.waitFor(() => expect(f.live().right?.device).toBe(replacement));
  expect(f.controller.getSnapshot().roles.right?.source).toBe('remembered');
});

it('an explicit empty-choice grant reads identity with auto reconnect disabled without assigning a role', async () => {
  const a = device('SIM-EXPLICIT-GRANT', 1),
    f = fixture([a], prefs({}, false));
  await f.controller.start();
  expect(f.probe).not.toHaveBeenCalled();
  await f.controller.acceptGranted([a], {});
  expect(f.probe).toHaveBeenCalledTimes(1);
  expect(f.live()).toEqual({});
  expect(f.controller.getSnapshot().devices[0]).toMatchObject({
    serial: a.serial,
    phase: 'available',
  });
  expect(f.connections[0].session.close).toHaveBeenCalledTimes(1);
});

it('physical disconnect removes the current binding immediately and a fresh interface reconnects to its remembered side', async () => {
  const a = device('SIM-A', 0),
    f = fixture([a], prefs({ 'SIM-A': { slot: 'right', source: 'manual' } }));
  await f.controller.start();
  f.hid.devices = [];
  f.hid.event('disconnect', a);
  expect(f.live()).toEqual({});
  const replacement = device('SIM-A', 2);
  f.hid.devices = [replacement];
  f.hid.event('connect', replacement);
  await vi.waitFor(() => expect(f.live().right?.device).toBe(replacement));
  expect(f.controller.getSnapshot().roles.right?.source).toBe('remembered');
});

it('coalesces concurrent scans and does not probe already attached devices', async () => {
  const a = device('SIM-A', 1),
    f = fixture([a]),
    gate = deferred(),
    original = f.probe.getMockImplementation()!;
  f.probe.mockImplementation(async (device) => {
    await gate.promise;
    return original(device);
  });
  const first = f.controller.start(),
    second = f.controller.discover();
  gate.resolve();
  await Promise.all([first, second]);
  expect(f.probe).toHaveBeenCalledTimes(1);
  await f.controller.discover();
  expect(f.probe).toHaveBeenCalledTimes(1);
});

it('closes late disconnected probes without publishing a phantom role', async () => {
  const a = device('SIM-A', 1),
    f = fixture([a]),
    gate = deferred(),
    original = f.probe.getMockImplementation()!;
  f.probe.mockImplementation(async (device) => {
    const connection = await original(device);
    await gate.promise;
    return connection;
  });
  const flight = f.controller.start();
  await vi.waitFor(() => expect(f.probe).toHaveBeenCalledTimes(1));
  f.hid.devices = [];
  f.hid.event('disconnect', a);
  gate.resolve();
  await flight;
  expect(f.live()).toEqual({});
  expect(f.connections[0].session.close).toHaveBeenCalledTimes(1);
});

it('rechecks an earlier probe after another device awaited, so an unplugged first amp never enters the final pair', async () => {
  const a = device('SIM-R', 1),
    b = device('SIM-L', 2),
    f = fixture([a, b]),
    gate = deferred(),
    original = f.probe.getMockImplementation()!;
  f.probe.mockImplementation(async (value) => {
    const connection = await original(value);
    if (value === b) await gate.promise;
    return connection;
  });
  const flight = f.controller.start();
  await vi.waitFor(() => expect(f.probe).toHaveBeenCalledTimes(2));
  f.hid.event('disconnect', a);
  gate.resolve();
  await flight;
  expect(f.live().right).toBeUndefined();
  expect(f.live().left?.device).toBe(b);
  expect(f.connections[0].session.close).toHaveBeenCalledTimes(1);
});

it('manual disconnect suppression also fences a fresh USB object with the same EEPROM serial', async () => {
  const a = device('SIM-R', 1),
    f = fixture([a]);
  await f.controller.start();
  await f.controller.disconnect('right');
  f.hid.devices = [];
  f.hid.event('disconnect', a);
  const replacement = device('SIM-R', 1);
  f.hid.devices = [replacement];
  f.hid.event('connect', replacement);
  await vi.waitFor(() => expect(f.probe).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(f.controller.getSnapshot().phase).toBe('ready'));
  expect(f.live()).toEqual({});
  expect(f.connections[1].session.close).toHaveBeenCalledTimes(1);
});

it('effect replay cancels the old probe and starts a new owner without closing its later attached session', async () => {
  const a = device('SIM-A', 1),
    f = fixture([a]),
    gate = deferred(),
    original = f.probe.getMockImplementation()!;
  f.probe.mockImplementationOnce(async (device) => {
    const connection = await original(device);
    await gate.promise;
    return connection;
  });
  const old = f.controller.start();
  await vi.waitFor(() => expect(f.probe).toHaveBeenCalledTimes(1));
  f.controller.dispose();
  const fresh = f.controller.start();
  gate.resolve();
  await Promise.all([old, fresh]);
  expect(f.live().right).toBe(f.connections[1]);
  expect(f.connections[0].session.close).toHaveBeenCalledTimes(1);
  expect(f.connections[1].session.close).not.toHaveBeenCalled();
});

it('rescans a hotplug arriving during another device probe instead of losing its only connect event', async () => {
  const a = device('SIM-R', 1),
    b = device('SIM-L', 2),
    f = fixture([a]),
    gate = deferred(),
    original = f.probe.getMockImplementation()!;
  f.probe.mockImplementationOnce(async (value) => {
    const connection = await original(value);
    await gate.promise;
    return connection;
  });
  const flight = f.controller.start();
  await vi.waitFor(() => expect(f.probe).toHaveBeenCalledTimes(1));
  f.hid.devices = [a, b];
  f.hid.event('connect', b);
  gate.resolve();
  await flight;
  await vi.waitFor(() => expect(f.live().left?.device).toBe(b));
  expect(f.live().right?.device).toBe(a);
  expect(f.probe).toHaveBeenCalledTimes(2);
});

it('disposed assignment and preference calls cannot mutate retained Root-owned connections', async () => {
  const f = fixture([device('SIM-R', 1)]);
  await f.controller.start();
  const before = f.live(),
    revision = f.controller.getSnapshot().revision;
  f.controller.dispose();
  expect(() => f.controller.swap(revision)).toThrow();
  await expect(f.controller.disconnect('right')).rejects.toThrow(/not started/);
  expect(() => f.controller.setAutoReconnect(false)).toThrow(/not started/);
  expect(f.live()).toBe(before);
  expect(f.connections[0].session.close).not.toHaveBeenCalled();
});

it('refuses stale and busy remapping, and a preference toggle keeps current connections untouched', async () => {
  const f = fixture([device('SIM-A', 1)]);
  await f.controller.start();
  const before = f.live(),
    revision = f.controller.getSnapshot().revision;
  f.idle(false);
  expect(() => f.controller.swap(revision)).toThrow(/Finish/);
  f.idle(true);
  f.controller.setAutoReconnect(false);
  expect(f.live()).toBe(before);
  expect(f.connections[0].session.close).not.toHaveBeenCalled();
  expect(() => f.controller.swap(revision)).toThrow(/changed/);
});

it('does not auto-open when reconnect is disabled, but an explicit granted choice can connect', async () => {
  const a = device('SIM-A', 1),
    f = fixture([a], prefs({}, false));
  await f.controller.start();
  expect(f.probe).not.toHaveBeenCalled();
  expect(f.live()).toEqual({});
  await f.controller.acceptGranted([a], { slot: 'left' });
  expect(f.live().left?.device).toBe(a);
});

it('filters wrong interfaces and rejects duplicate serials instead of assigning them to both roles', async () => {
  const wrong = device('WRONG', 1);
  Object.assign(wrong, { collections: [{ usagePage: 1, usage: 1 }] });
  const f = fixture([wrong, device('DUPLICATE', 1), device('DUPLICATE', 2)]);
  await f.controller.start();
  expect(f.probe).toHaveBeenCalledTimes(2);
  expect(f.live()).toEqual({});
  expect(
    f.controller.getSnapshot().devices.every((entry) => entry.error?.includes('Duplicate')),
  ).toBe(true);
});

it('shows foreign-open and enumeration failures without hiding a permanently connecting candidate', async () => {
  const a = device('SIM-A', 1);
  a.opened = true;
  const f = fixture([a]);
  await f.controller.start();
  expect(f.probe).not.toHaveBeenCalled();
  expect(f.controller.getSnapshot().devices[0]).toMatchObject({
    phase: 'error',
    error: expect.stringContaining('already open'),
  });
  f.hid.getDevices.mockRejectedValueOnce(new Error('HID enumeration refused'));
  await expect(f.controller.discover()).rejects.toThrow(/enumeration/);
  expect(f.controller.getSnapshot()).toMatchObject({
    phase: 'error',
    error: 'HID enumeration refused',
  });
});

it('invalid or denied preference storage preserves usable session-only assignment', async () => {
  const a = device('SIM-A', 1),
    f = fixture([a], { version: 9, assignments: [] });
  f.write.mockImplementation(() => {
    throw new Error('Storage denied');
  });
  await f.controller.start();
  expect(f.live().right?.device).toBe(a);
  expect(f.controller.getSnapshot().preferencesError).toContain('session');
});

it('uses a bounded strict independent browser preference record without touching workspace state', () => {
  const storage = {
      getItem: vi.fn(() => JSON.stringify(prefs({ 'SIM-R': { slot: 'right', source: 'manual' } }))),
      setItem: vi.fn(),
    },
    backend = createBrowserAmplifierRolePreferencesBackend(storage);
  expect(parseAmplifierRolePreferences(backend.read()).assignments['SIM-R'].slot).toBe('right');
  backend.write(prefs({}));
  expect(storage.setItem).toHaveBeenCalledWith(
    AMPLIFIER_ROLE_PREFERENCES_KEY,
    JSON.stringify(prefs({})),
  );
  expect(() => parseAmplifierRolePreferences({ ...prefs({}), extra: true })).toThrow();
  expect(() =>
    parseAmplifierRolePreferences(
      prefs(
        Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [`SIM-${i}`, { slot: 'right', source: 'manual' }]),
        ),
      ),
    ),
  ).toThrow();
});
