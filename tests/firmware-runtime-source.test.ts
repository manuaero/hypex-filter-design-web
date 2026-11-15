// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  createFirmwareRuntimeSourceProvider,
  type FirmwareRuntimeCandidateSource,
  type FirmwareRuntimeLiveSource,
  type FirmwareRuntimeRememberedSource,
  type FirmwareRuntimeSourceProviderOptions,
} from '../src/application/firmware-runtime-source';
import { createFirmwareRuntimeController } from '../src/application/firmware-runtime';
import { FirmwareRuntimeSerialMismatchError } from '../src/hardware/firmware-runtime-inspector';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import type { Transport } from '../src/hardware/transport';

afterEach(() => vi.unstubAllGlobals());
const hooks = () => ({ assertCurrent: vi.fn() });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function amplifier(serial: string, core: '5.1' | '5.5' = '5.5', initialOpened = false) {
  const panel = new SimulatedPanel(serial);
  panel.configuration[5] = panel.configuration[12] = 3;
  panel.deviceConfiguration[11] = 9;
  panel.deviceConfiguration[13] = 1;
  panel.configuration[3] = core === '5.1' ? 1 : 5;
  new DataView(panel.configuration.buffer).setUint16(17, core === '5.1' ? 7 : 82, true);
  let opened = initialOpened;
  const events = new EventTarget(),
    device = Object.assign(events, {
      vendorId: 0x345e,
      productId: 0x03e8,
      get opened() {
        return opened;
      },
      open: vi.fn(async () => {
        opened = true;
      }),
      close: vi.fn(async () => {
        opened = false;
      }),
      sendReport: vi.fn(async (_id: number, value: BufferSource) => {
        const data =
            value instanceof ArrayBuffer
              ? new Uint8Array(value)
              : new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
          reply = await panel.exchange(data),
          event = new Event('inputreport');
        Object.defineProperties(event, {
          reportId: { value: 0 },
          data: { value: new DataView(reply.buffer, reply.byteOffset, reply.byteLength) },
        });
        events.dispatchEvent(event);
      }),
    });
  // Object.assign materializes getters, so supply the live state accessor.
  Object.defineProperty(device, 'opened', { configurable: true, get: () => opened });
  const closeBorrowed = vi.spyOn(panel, 'close'),
    backup = vi.fn(async () => {}),
    session = new PanelSession(panel, backup),
    factory = vi.fn((_device: HIDDevice): Transport => ({
      exchange: (request, timeout) => panel.exchange(request),
      close: async () => {
        await device.close();
      },
    }));
  return {
    panel,
    device: device as unknown as HIDDevice & typeof device,
    session,
    backup,
    factory,
    closeBorrowed,
    setOpened(value: boolean) {
      opened = value;
    },
  };
}
function setup() {
  const state: {
      live: Partial<Record<'left' | 'right', FirmwareRuntimeLiveSource>>;
      candidate: Partial<Record<'left' | 'right', FirmwareRuntimeCandidateSource>>;
      remembered: Partial<Record<'left' | 'right', FirmwareRuntimeRememberedSource>>;
    } = { live: {}, candidate: {}, remembered: {} },
    options: FirmwareRuntimeSourceProviderOptions = {
      live: vi.fn((slot: 'left' | 'right') => state.live[slot]),
      candidate: vi.fn((slot: 'left' | 'right') => state.candidate[slot]),
      remembered: vi.fn((slot: 'left' | 'right') => state.remembered[slot]),
      allLive: vi.fn(() => Object.values(state.live).map((value) => ({ device: value.device }))),
      operate: vi.fn(async (_label, work) => work()),
    };
  return { state, options, provider: () => createFirmwareRuntimeSourceProvider(options) };
}
const remembered = (
  amp: ReturnType<typeof amplifier>,
  key = 'remembered-left',
): FirmwareRuntimeRememberedSource => ({ key, serial: amp.panel.serial, device: amp.device });
const live = (amp: ReturnType<typeof amplifier>, key = 'live-left'): FirmwareRuntimeLiveSource => ({
  ...remembered(amp, key),
  session: amp.session,
});
const noSetters = (amp: ReturnType<typeof amplifier>) => {
  expect(amp.panel.requests).toHaveLength(8);
  expect(amp.panel.requests.map((r) => [...r.slice(0, 2)])).toEqual([
    [6, 1],
    [0x66, 0],
    [3, 8],
    [0x65, 32],
    [6, 1],
    [0x66, 0],
    [3, 8],
    [0x65, 32],
  ]);
  expect(
    amp.panel.writes + amp.panel.mixerWrites + amp.panel.passwordWrites + amp.panel.emailWrites,
  ).toBe(0);
  expect(amp.backup).not.toHaveBeenCalled();
};

it('uses candidate→live→remembered priority and never labels a candidate as a staged firmware file', () => {
  const f = setup(),
    chosen = amplifier('H05U-CHOSEN'),
    connected = amplifier('H05U-LIVE'),
    old = amplifier('H05U-OLD');
  f.state.candidate.left = live(chosen, 'candidate');
  f.state.live.left = live(connected);
  f.state.remembered.left = remembered(old);
  const p = f.provider();
  expect(p.binding('left')).toEqual({
    key: 'candidate',
    serial: chosen.panel.serial,
    source: 'chosen-device',
  });
  expect(f.options.live).not.toHaveBeenCalled();
  delete f.state.candidate.left;
  expect(p.binding('left')?.source).toBe('connected-session');
  delete f.state.live.left;
  expect(p.binding('left')?.source).toBe('remembered-device');
  expect(chosen.device.open).not.toHaveBeenCalled();
});

it('queues a live read behind its real Session reservation inside operate and never closes its borrowed connection', async () => {
  const f = setup(),
    amp = amplifier('H05U-LIVE', '5.1', true),
    gate = deferred(),
    entered = deferred();
  f.state.live.left = live(amp);
  f.options.transportFactory = amp.factory;
  const p = f.provider(),
    prior = amp.session.exclusive(async () => {
      entered.resolve();
      await gate.promise;
    });
  await entered.promise;
  const result = p.read('left', p.binding('left')!, hooks());
  await Promise.resolve();
  expect(amp.panel.requests).toHaveLength(0);
  gate.resolve();
  await prior;
  expect((await result).controlsQualified).toBe(true);
  noSetters(amp);
  expect(f.options.operate).toHaveBeenCalledOnce();
  expect(amp.factory).not.toHaveBeenCalled();
  expect(amp.device.open).not.toHaveBeenCalled();
  expect(amp.device.close).not.toHaveBeenCalled();
  expect(amp.closeBorrowed).not.toHaveBeenCalled();
});

it('uses the connecting candidate queue without nesting operate or assigning its known5.5 report to a normal Session', async () => {
  const f = setup(),
    amp = amplifier('H05U-CANDIDATE', '5.5', true);
  f.state.candidate.left = { key: 'connecting-epoch', device: amp.device, session: amp.session };
  f.options.operate = vi.fn(async () => {
    throw new Error('outer connecting already owns operate');
  });
  const p = f.provider(),
    report = await p.read('left', p.binding('left')!, hooks());
  expect(report.identity.serial).toBe(amp.panel.serial);
  expect(report.controlsQualified).toBe(false);
  expect(amp.session.identity).toBeUndefined();
  expect(f.state.live.left).toBeUndefined();
  expect(f.options.operate).not.toHaveBeenCalled();
  noSetters(amp);
  expect(amp.device.open).not.toHaveBeenCalled();
  expect(amp.device.close).not.toHaveBeenCalled();
});

it('temporarily opens only the exact remembered object and closes the owned transport after eight actual-reader requests', async () => {
  const f = setup(),
    amp = amplifier('H05U-REMEMBERED'),
    memory = amp.panel.memory.slice(),
    eeprom = amp.panel.eeprom.slice();
  f.state.remembered.left = remembered(amp);
  f.options.transportFactory = amp.factory;
  const p = f.provider(),
    report = await p.read('left', p.binding('left')!, hooks());
  expect(report.identity.core).toBe('5.5');
  expect(amp.device.open).toHaveBeenCalledOnce();
  expect(amp.factory).toHaveBeenCalledExactlyOnceWith(amp.device);
  expect(amp.device.close).toHaveBeenCalledOnce();
  expect(amp.device.opened).toBe(false);
  expect(amp.panel.memory).toEqual(memory);
  expect(amp.panel.eeprom).toEqual(eeprom);
  expect(amp.session.identity).toBeUndefined();
  noSetters(amp);
});

it('the default WebHidTransport uses only fake input reports and removes its owned listeners/port after success', async () => {
  const f = setup(),
    amp = amplifier('H05U-DEFAULT-TRANSPORT'),
    hid = new EventTarget(),
    remove = vi.spyOn(hid, 'removeEventListener');
  vi.stubGlobal('navigator', { hid });
  f.state.remembered.left = remembered(amp);
  const p = f.provider();
  await p.read('left', p.binding('left')!, hooks());
  noSetters(amp);
  expect(amp.device.sendReport).toHaveBeenCalledTimes(8);
  expect(amp.device.close).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith('disconnect', expect.any(Function));
});

it('keeps Both live/remembered source identities independent and closes only the remembered interface', async () => {
  const f = setup(),
    left = amplifier('H05U-LEFT', '5.1', true),
    right = amplifier('H05U-RIGHT');
  f.state.live.left = live(left);
  f.state.remembered.right = remembered(right, 'remembered-right');
  f.options.transportFactory = right.factory;
  const p = f.provider(),
    controller = createFirmwareRuntimeController({ ...p }),
    ctx = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'ui:runtime' };
  await controller.read('both', ctx);
  const roles = controller.status(ctx).roles;
  expect(roles.left.report?.identity.serial).toBe(left.panel.serial);
  expect(roles.right.report?.identity.serial).toBe(right.panel.serial);
  expect(roles.right.report?.controlsQualified).toBe(false);
  noSetters(left);
  noSetters(right);
  expect(left.device.close).not.toHaveBeenCalled();
  expect(right.device.close).toHaveBeenCalledOnce();
});

it('Both failure publishes neither newly captured report and still closes the owned remembered port', async () => {
  const f = setup(),
    left = amplifier('H05U-LEFT', '5.1', true),
    right = amplifier('H05U-RIGHT');
  right.panel.configuration[3] = 99;
  f.state.live.left = live(left);
  f.state.remembered.right = remembered(right, 'remembered-right');
  f.options.transportFactory = right.factory;
  const p = f.provider(),
    controller = createFirmwareRuntimeController({ ...p }),
    ctx = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'ui:runtime' };
  await expect(controller.read('both', ctx)).rejects.toThrow('Unqualified');
  expect(controller.getSnapshot().roles.left.report).toBeUndefined();
  expect(controller.getSnapshot().roles.right.report).toBeUndefined();
  expect(left.device.close).not.toHaveBeenCalled();
  expect(right.device.close).toHaveBeenCalledOnce();
  noSetters(left);
  expect(right.panel.requests).toHaveLength(1);
});

it.each(['already open', 'assigned live'])(
  'refuses a remembered interface that is%s without opening, reading or closing it',
  async (reason) => {
    const f = setup(),
      amp = amplifier('H05U-REMEMBERED', '5.5', reason === 'already open');
    f.state.remembered.left = remembered(amp);
    f.options.transportFactory = amp.factory;
    if (reason === 'assigned live') f.state.live.right = live(amp, 'live-right');
    const p = f.provider();
    await expect(p.read('left', p.binding('left')!, hooks())).rejects.toThrow(
      /already open|assigned/,
    );
    expect(amp.device.open).not.toHaveBeenCalled();
    expect(amp.device.close).not.toHaveBeenCalled();
    expect(amp.panel.requests).toHaveLength(0);
  },
);

it.each(['vendorId', 'productId'] as const)(
  'rejects wrong%s before I/O and does not fall back to a different live source',
  (field) => {
    const f = setup(),
      bad = amplifier('H05U-BAD'),
      good = amplifier('H05U-GOOD');
    Object.defineProperty(bad.device, field, { value: 0 });
    f.state.candidate.left = live(bad, 'bad-candidate');
    f.state.live.left = live(good);
    expect(() => f.provider().binding('left')).toThrow('Invalid captured');
    expect(bad.device.open).not.toHaveBeenCalled();
    expect(good.device.open).not.toHaveBeenCalled();
    expect(bad.panel.requests).toHaveLength(0);
    expect(good.panel.requests).toHaveLength(0);
  },
);

it('does not close borrowed candidate/live sessions when their read fails', async () => {
  for (const kind of ['candidate', 'live'] as const) {
    const f = setup(),
      amp = amplifier('H05U-BORROWED', '5.5', true);
    amp.panel.configuration[3] = 99;
    f.state[kind].left = live(amp);
    const p = f.provider();
    await expect(p.read('left', p.binding('left')!, hooks())).rejects.toThrow('Unqualified');
    expect(amp.device.close).not.toHaveBeenCalled();
    expect(amp.closeBorrowed).not.toHaveBeenCalled();
    expect(amp.panel.requests).toHaveLength(1);
  }
});

it.each(['replace source', 'abort', 'clear'])(
  'cleans up a port opened late after%s, before any inspector request',
  async (event) => {
    const f = setup(),
      amp = amplifier('H05U-LATE'),
      gate = deferred(),
      entered = deferred(),
      abort = new AbortController();
    let current = true;
    amp.device.open.mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      amp.setOpened(true);
    });
    f.state.remembered.left = remembered(amp);
    f.options.transportFactory = amp.factory;
    const p = f.provider(),
      request = p.read('left', p.binding('left')!, {
        signal: abort.signal,
        assertCurrent() {
          if (!current) throw new Error('cleared');
        },
      });
    await entered.promise;
    if (event === 'replace source')
      f.state.remembered.left = { ...remembered(amp), key: 'replacement' };
    if (event === 'abort') abort.abort();
    if (event === 'clear') current = false;
    gate.resolve();
    await expect(request).rejects.toThrow();
    expect(amp.device.close).toHaveBeenCalledOnce();
    expect(amp.device.opened).toBe(false);
    expect(amp.factory).not.toHaveBeenCalled();
    expect(amp.panel.requests).toHaveLength(0);
  },
);

it('rejects same-key device replacement after a reply and cleans only the old owned interface', async () => {
  const f = setup(),
    old = amplifier('H05U-SAME'),
    replacement = amplifier('H05U-SAME');
  f.state.remembered.left = remembered(old);
  f.options.transportFactory = old.factory;
  const exchange = old.panel.exchange.bind(old.panel);
  vi.spyOn(old.panel, 'exchange').mockImplementation(async (request) => {
    const reply = await exchange(request);
    f.state.remembered.left = remembered(replacement);
    return reply;
  });
  const p = f.provider();
  await expect(p.read('left', p.binding('left')!, hooks())).rejects.toThrow(
    'replacement was not read',
  );
  expect(old.device.close).toHaveBeenCalledOnce();
  expect(replacement.device.close).not.toHaveBeenCalled();
  expect(old.panel.requests).toHaveLength(1);
  expect(replacement.panel.requests).toHaveLength(0);
});

it('rejects a same-key borrowed session replacement while queued, without reading/closing either session', async () => {
  const f = setup(),
    amp = amplifier('H05U-SAME', '5.1', true),
    replacement = new PanelSession(amp.panel, vi.fn()),
    gate = deferred(),
    entered = deferred();
  f.state.live.left = live(amp);
  const prior = amp.session.exclusive(async () => {
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;
  const p = f.provider(),
    request = p.read('left', p.binding('left')!, hooks());
  f.state.live.left = { ...live(amp), session: replacement };
  gate.resolve();
  await prior;
  await expect(request).rejects.toThrow('replacement was not read');
  expect(amp.panel.requests).toHaveLength(0);
  expect(amp.device.close).not.toHaveBeenCalled();
});

it('retains the typed serial mismatch after successful owned cleanup so a permitted candidate search can continue safely', async () => {
  const f = setup(),
    amp = amplifier('H05U-ACTUAL-SYNTHETIC');
  f.state.remembered.left = { ...remembered(amp), serial: 'H05U-EXPECTED-SYNTHETIC' };
  f.options.transportFactory = amp.factory;
  const p = f.provider();
  await expect(p.read('left', p.binding('left')!, hooks())).rejects.toBeInstanceOf(
    FirmwareRuntimeSerialMismatchError,
  );
  expect(amp.device.close).toHaveBeenCalledOnce();
  expect(amp.panel.requests).toHaveLength(4);
});

it('cancellation after a real read reply still closes the owned port and sends no further request', async () => {
  const f = setup(),
    amp = amplifier('H05U-ABORT-READ'),
    abort = new AbortController();
  f.state.remembered.left = remembered(amp);
  f.options.transportFactory = amp.factory;
  const exchange = amp.panel.exchange.bind(amp.panel);
  vi.spyOn(amp.panel, 'exchange').mockImplementation(async (request) => {
    const reply = await exchange(request);
    abort.abort();
    return reply;
  });
  const p = f.provider();
  await expect(
    p.read('left', p.binding('left')!, { ...hooks(), signal: abort.signal }),
  ).rejects.toThrow();
  expect(amp.panel.requests).toHaveLength(1);
  expect(amp.device.close).toHaveBeenCalledOnce();
  expect(amp.device.opened).toBe(false);
});

it('an unconfirmed owned close overrides serial-mismatch continuation rather than allowing another candidate probe', async () => {
  const f = setup(),
    amp = amplifier('H05U-ACTUAL-SYNTHETIC');
  f.state.remembered.left = { ...remembered(amp), serial: 'H05U-OTHER-SYNTHETIC' };
  f.options.transportFactory = amp.factory;
  amp.device.close.mockRejectedValue(new Error('close unconfirmed'));
  const p = f.provider(),
    error = await p.read('left', p.binding('left')!, hooks()).catch((failure: unknown) => failure);
  expect(error).not.toBeInstanceOf(FirmwareRuntimeSerialMismatchError);
  expect(error).toMatchObject({
    message: 'Firmware runtime inspection could not close its owned interface',
  });
  expect(amp.device.close).toHaveBeenCalledOnce();
  expect(amp.panel.requests).toHaveLength(4);
});

it('closes an owned port when factory construction fails and never constructs a Session or retries the open', async () => {
  const f = setup(),
    amp = amplifier('H05U-FACTORY');
  f.state.remembered.left = remembered(amp);
  f.options.transportFactory = vi.fn(() => {
    throw new Error('factory failure');
  });
  const p = f.provider();
  await expect(p.read('left', p.binding('left')!, hooks())).rejects.toThrow('factory failure');
  expect(amp.device.open).toHaveBeenCalledOnce();
  expect(amp.device.close).toHaveBeenCalledOnce();
  expect(amp.panel.requests).toHaveLength(0);
});

it('rejects close failure instead of returning success or silently continuing to a different device', async () => {
  const f = setup(),
    amp = amplifier('H05U-CLOSE-FAIL');
  amp.device.close.mockRejectedValue(new Error('OS close failure'));
  f.state.remembered.left = remembered(amp);
  f.options.transportFactory = amp.factory;
  const p = f.provider();
  await expect(p.read('left', p.binding('left')!, hooks())).rejects.toThrow(
    'could not close its owned',
  );
  noSetters(amp);
  expect(amp.device.open).toHaveBeenCalledOnce();
  expect(amp.device.close).toHaveBeenCalledOnce();
  await expect(p.read('left', p.binding('left')!, hooks())).rejects.toThrow('already open');
  expect(amp.device.open).toHaveBeenCalledOnce();
});

it('an open failure does not close a port that never opened or create a transport', async () => {
  const f = setup(),
    amp = amplifier('H05U-OPEN-FAIL');
  amp.device.open.mockRejectedValue(new Error('open denied'));
  f.state.remembered.left = remembered(amp);
  f.options.transportFactory = amp.factory;
  const p = f.provider();
  await expect(p.read('left', p.binding('left')!, hooks())).rejects.toThrow('open denied');
  expect(amp.device.close).not.toHaveBeenCalled();
  expect(amp.factory).not.toHaveBeenCalled();
});

it('blocks duplicate remembered opens during a pending open and leaves cleanup to the first owner only', async () => {
  const f = setup(),
    amp = amplifier('H05U-DUPLICATE'),
    gate = deferred(),
    entered = deferred();
  amp.device.open.mockImplementation(async () => {
    entered.resolve();
    await gate.promise;
    amp.setOpened(true);
  });
  f.state.remembered.left = remembered(amp);
  f.options.transportFactory = amp.factory;
  const p = f.provider(),
    binding = p.binding('left')!,
    first = p.read('left', binding, hooks());
  await entered.promise;
  await expect(p.read('left', binding, hooks())).rejects.toThrow('already open');
  expect(amp.device.close).not.toHaveBeenCalled();
  gate.resolve();
  await first;
  expect(amp.device.open).toHaveBeenCalledOnce();
  expect(amp.device.close).toHaveBeenCalledOnce();
  noSetters(amp);
});
