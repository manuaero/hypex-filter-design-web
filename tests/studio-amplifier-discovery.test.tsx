// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createHash } from 'node:crypto';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Studio from '../src/components/Studio';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';
import type { WorkspaceAuthority } from '../src/application/workspace-authority';
import { AMPLIFIER_ROLE_PREFERENCES_KEY } from '../src/application/amplifier-role-preferences';
import { SimulatedPanel } from '../src/hardware/simulator';
import { newProject, type Slot } from '../src/domain/model';
import { ensureWorkspaceHydrated, useWorkspace } from '../src/state/workspace';

const seen = vi.hoisted(() => ({
  adapter: undefined as ToolAdapter | undefined,
  authority: undefined as WorkspaceAuthority | undefined,
}));
// Capture the production adapter supplied by Studio; do not substitute its
// connection implementation or its PanelSession/WebHidTransport stack.
vi.mock('../src/components/AgentAccess', () => ({
  default: ({ adapter, authority }: { adapter: ToolAdapter; authority: WorkspaceAuthority }) => {
    seen.adapter = adapter;
    seen.authority = authority;
    return null;
  },
}));
vi.mock('../src/components/InteractivePlot', async (original) => ({
  ...(await original<typeof import('../src/components/InteractivePlot')>()),
  default: () => null,
}));
vi.mock('../src/components/ResponsePlot', async (original) => ({
  ...(await original<typeof import('../src/components/ResponsePlot')>()),
  default: () => null,
}));
vi.mock('../src/hardware/storage', async (original) => ({
  ...(await original<typeof import('../src/hardware/storage')>()),
  listBackups: async () => [],
}));
vi.mock('../src/application/workspace-authority', async (original) => {
  const actual = await original<typeof import('../src/application/workspace-authority')>();
  return {
    ...actual,
    createWorkspaceAuthority: () =>
      actual.createWorkspaceAuthority({
        loadOrCreate: async () => ({ version: 1, id: '11111111-1111-4111-8111-111111111111' }),
      }),
  };
});
vi.mock('../src/state/workspace', async (original) => {
  const actual = await original<typeof import('../src/state/workspace')>();
  let saved: unknown = null;
  const workspace = actual.createWorkspaceStore({
    read: async () => structuredClone(saved),
    write: async (value) => {
      saved = structuredClone(value);
    },
    readLegacy: () => null,
  });
  return {
    ...actual,
    useWorkspace: workspace.store,
    ensureWorkspaceHydrated: workspace.persistence.hydrate,
    retryWorkspacePersistence: workspace.persistence.retry,
    flushWorkspacePersistence: workspace.persistence.flush,
    getWorkspacePersistenceStatus: workspace.persistence.getSnapshot,
    subscribeWorkspacePersistence: workspace.persistence.subscribe,
    getWorkspaceRecoveryText: workspace.persistence.recoveryText,
  };
});

/** Only identify and status reads are admitted. Any setter, mute, preset
 * selection, bridge write, flash access or unrelated command fails before the
 * simulated device sees it. These are synthetic ports, never real USB. */
class ReadOnlyHidDevice extends EventTarget {
  readonly vendorId = 0x345e;
  readonly productId = 0x03e8;
  readonly collections = [{ usagePage: 0xff00, usage: 1 }];
  readonly productName = 'Synthetic FA503 discovery';
  opened = false;
  forbidden: Uint8Array[] = [];
  requests: Uint8Array[] = [];
  readonly panel: SimulatedPanel;
  constructor(
    readonly serial: string,
    routing: 0 | 1 | 2,
  ) {
    super();
    this.panel = new SimulatedPanel(serial);
    this.panel.name = `Synthetic ${serial}`;
    this.panel.configuration[5] = this.panel.configuration[12] = 3;
    this.panel.deviceConfiguration[11] = 9;
    this.panel.deviceConfiguration[13] = 1;
    this.panel.status[11] = routing;
  }
  open = vi.fn(async () => {
    this.opened = true;
  });
  close = vi.fn(async () => {
    this.opened = false;
  });
  sendReport = vi.fn(async (reportId: number, source: BufferSource) => {
    const bytes =
      source instanceof ArrayBuffer
        ? new Uint8Array(source).slice()
        : new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
    const ordinaryRead = [
      [6, 1],
      [0x66, 0],
      [3, 8],
      [5, 1],
    ].some(
      ([command, argument]) =>
        bytes[0] === command &&
        bytes[1] === argument &&
        bytes.subarray(2).every((byte) => byte === 0),
    );
    const serialRead =
      bytes[0] === 0x65 &&
      bytes[1] === 32 &&
      bytes[2] === 0 &&
      bytes[3] === 1 &&
      bytes[4] === 0 &&
      bytes[5] === 0 &&
      bytes.subarray(6).every((byte) => byte === 0);
    if (reportId !== 0 || bytes.length !== 64 || (!ordinaryRead && !serialRead)) {
      this.forbidden.push(bytes);
      throw new Error('Discovery fixture forbids every device mutation and unrelated read');
    }
    this.requests.push(bytes);
    const response = await this.panel.exchange(bytes);
    const event = new Event('inputreport');
    Object.assign(event, {
      reportId: 0,
      data: new DataView(response.buffer, response.byteOffset, response.byteLength),
    });
    this.dispatchEvent(event);
  });
  hid() {
    return this as unknown as HIDDevice;
  }
  snapshot() {
    return {
      configuration: this.panel.configuration.slice(),
      deviceConfiguration: this.panel.deviceConfiguration.slice(),
      status: this.panel.status.slice(),
      eeprom: createHash('sha256').update(this.panel.eeprom).digest('hex'),
      memory: createHash('sha256').update(this.panel.memory).digest('hex'),
      powerMode: this.panel.powerMode,
      noiseRequested: this.panel.noiseRequested,
      writes: this.panel.writes,
      mixerWrites: this.panel.mixerWrites,
      noiseRequests: this.panel.noiseRequests,
      eqReloads: this.panel.eqReloads,
      displayUpdates: this.panel.displayUpdates,
      oemMaskUpdates: this.panel.oemMaskUpdates,
      passwordWrites: this.panel.passwordWrites,
      passwordVerifications: this.panel.passwordVerifications,
      emailWrites: this.panel.emailWrites,
      recoveryChallengeInstalls: this.panel.recoveryChallengeInstalls,
      recoveryCodeSubmissions: this.panel.recoveryCodeSubmissions,
    };
  }
}
class ReadOnlyHidHub extends EventTarget {
  constructor(public permitted: ReadOnlyHidDevice[]) {
    super();
  }
  getDevices = vi.fn(async () => this.permitted.map((device) => device.hid()));
  requestDevice = vi.fn(async () => this.permitted.map((device) => device.hid()));
  connect(device: ReadOnlyHidDevice) {
    if (!this.permitted.includes(device)) this.permitted.push(device);
    const event = new Event('connect');
    Object.assign(event, { device: device.hid() });
    this.dispatchEvent(event);
  }
  disconnect(device: ReadOnlyHidDevice) {
    this.permitted = this.permitted.filter((candidate) => candidate !== device);
    device.opened = false;
    const event = new Event('disconnect');
    Object.assign(event, { device: device.hid() });
    this.dispatchEvent(event);
  }
}

let host: HTMLDivElement,
  root: Root,
  mounted = false;
let restoreHid: (() => void) | undefined;
const state = () => useWorkspace.getState();
const workspaceSnapshot = () => {
  const current = state();
  return structuredClone({
    documents: current.documents,
    slot: current.slot,
    preset: current.preset,
    channel: current.channel,
    filter: current.filter,
    linkedEdits: current.linkedEdits,
    linkedControls: current.linkedControls,
    revision: current.documentRevision,
    past: current.past,
    future: current.future,
  });
};
function installHid(devices: ReadOnlyHidDevice[]) {
  const prior = Object.getOwnPropertyDescriptor(navigator, 'hid'),
    hub = new ReadOnlyHidHub(devices);
  Object.defineProperty(navigator, 'hid', { configurable: true, value: hub });
  restoreHid = () => {
    if (prior) Object.defineProperty(navigator, 'hid', prior);
    else Reflect.deleteProperty(navigator, 'hid');
  };
  return hub;
}
function remember(assignments: Record<string, Slot>) {
  localStorage.setItem(
    AMPLIFIER_ROLE_PREFERENCES_KEY,
    JSON.stringify({
      version: 1,
      autoReconnect: true,
      assignments: Object.fromEntries(
        Object.entries(assignments).map(([serial, slot]) => [serial, { slot, source: 'manual' }]),
      ),
    }),
  );
}
async function mount() {
  await act(async () =>
    root.render(
      <StrictMode>
        <Studio />
      </StrictMode>,
    ),
  );
  mounted = true;
}
async function waitForConnections(expected: Partial<Record<Slot, string>>) {
  await act(async () =>
    vi.waitFor(() => {
      const actual = Object.fromEntries(
        Object.entries(seen.adapter!.connections()).map(([slot, connection]) => [
          slot,
          connection.identity.serial,
        ]),
      );
      expect(actual, host.querySelector('[role=alert]')?.textContent ?? undefined).toEqual(
        expected,
      );
    }),
  );
}
async function clickButton(name: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) =>
      candidate.getAttribute('aria-label') === name || candidate.textContent?.trim() === name,
  );
  expect(button, `Visible production button: ${name}`).toBeTruthy();
  expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
}
async function assign(serial: string, slot: Slot) {
  const selector = host.querySelector<HTMLSelectElement>(
    `select[aria-label="Assignment for ${serial}"]`,
  );
  expect(selector, `Assignment control for ${serial}`).toBeTruthy();
  await act(async () => {
    selector!.value = slot;
    selector!.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function expectUnchanged(
  devices: ReadOnlyHidDevice[],
  before: ReturnType<ReadOnlyHidDevice['snapshot']>[],
) {
  devices.forEach((device, index) => {
    expect(device.forbidden).toEqual([]);
    expect(device.snapshot()).toEqual(before[index]);
  });
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    }),
  });
  localStorage.clear();
  await ensureWorkspaceHydrated();
  useWorkspace.setState({
    documents: {
      left: newProject('Independent Left design'),
      right: newProject('Independent Right design'),
    },
    slot: 'left',
    preset: 0,
    channel: 0,
    filter: 0,
    linkedEdits: true,
    linkedControls: true,
    documentRevision: 0,
    past: [],
    future: [],
    gesture: undefined,
    fileCommitReceipts: {},
  });
  seen.adapter = undefined;
  seen.authority = undefined;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  mounted = false;
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  restoreHid?.();
  restoreHid = undefined;
  host.remove();
  vi.restoreAllMocks();
});

it('reconnects a permitted remembered Right serial without a chooser or changing its conflicting Left routing', async () => {
  const device = new ReadOnlyHidDevice('DISCOVERY-REMEMBERED-R', 2),
    hub = installHid([device]);
  remember({ [device.serial]: 'right' });
  const before = workspaceSnapshot(),
    hardware = [device.snapshot()];
  await mount();
  await waitForConnections({ right: device.serial });
  expect(hub.requestDevice).not.toHaveBeenCalled();
  expect(device.open).toHaveBeenCalledTimes(1);
  expect(workspaceSnapshot()).toEqual(before);
  await clickButton('Manage amplifiers');
  expect(host.querySelector('dialog[aria-label="Amplifier connections"]')).toBeTruthy();
  expect(
    host.querySelector<HTMLSelectElement>(`select[aria-label="Assignment for ${device.serial}"]`)
      ?.value,
  ).toBe('right');
  expectUnchanged([device], hardware);
});

it('shows a unique Right routing inference and lets the user move only its assignment to Left', async () => {
  const device = new ReadOnlyHidDevice('DISCOVERY-INFERRED-R', 1),
    hub = installHid([device]);
  const before = workspaceSnapshot(),
    hardware = [device.snapshot()];
  await mount();
  await waitForConnections({ right: device.serial });
  await clickButton('Manage amplifiers');
  expect(host.querySelector('dialog[aria-label="Amplifier connections"]')?.textContent).toMatch(
    /routing|inferred|suggest/i,
  );
  await assign(device.serial, 'left');
  await waitForConnections({ left: device.serial });
  expect(hub.requestDevice).not.toHaveBeenCalled();
  expect(workspaceSnapshot()).toEqual(before);
  expect(
    JSON.parse(localStorage.getItem(AMPLIFIER_ROLE_PREFERENCES_KEY)!).assignments[device.serial],
  ).toMatchObject({ slot: 'left', source: 'manual' });
  expectUnchanged([device], hardware);
});

it('keeps two remembered physical identities independent when grant enumeration is reversed, then swaps only bindings', async () => {
  const left = new ReadOnlyHidDevice('DISCOVERY-L', 0),
    right = new ReadOnlyHidDevice('DISCOVERY-R', 0),
    devices = [right, left];
  const hub = installHid(devices);
  remember({ [left.serial]: 'left', [right.serial]: 'right' });
  const before = workspaceSnapshot(),
    hardware = devices.map((device) => device.snapshot());
  await mount();
  await waitForConnections({ left: left.serial, right: right.serial });
  await clickButton('Manage amplifiers');
  await clickButton('Swap Left and Right');
  await waitForConnections({ left: right.serial, right: left.serial });
  expect(hub.requestDevice).not.toHaveBeenCalled();
  expect(left.open).toHaveBeenCalledTimes(1);
  expect(right.open).toHaveBeenCalledTimes(1);
  expect(workspaceSnapshot()).toEqual(before);
  expectUnchanged(devices, hardware);
});

it('discovers a remembered hotplug once and clears its disconnected role before reconnecting', async () => {
  const device = new ReadOnlyHidDevice('DISCOVERY-HOTPLUG-R', 0),
    hub = installHid([]);
  remember({ [device.serial]: 'right' });
  const before = workspaceSnapshot(),
    hardware = [device.snapshot()];
  await mount();
  await act(async () => vi.waitFor(() => expect(hub.getDevices).toHaveBeenCalled()));
  await act(async () => {
    hub.connect(device);
    hub.connect(device);
  });
  await waitForConnections({ right: device.serial });
  expect(device.open).toHaveBeenCalledTimes(1);
  await act(async () => hub.disconnect(device));
  await waitForConnections({});
  await act(async () => hub.connect(device));
  await waitForConnections({ right: device.serial });
  expect(device.open).toHaveBeenCalledTimes(2);
  expect(hub.requestDevice).not.toHaveBeenCalled();
  expect(workspaceSnapshot()).toEqual(before);
  expectUnchanged([device], hardware);
});

it('restores a manual assignment on a fresh Studio mount without reopening the chooser or changing either design', async () => {
  const device = new ReadOnlyHidDevice('DISCOVERY-RELOAD-R', 1),
    hub = installHid([device]);
  const before = workspaceSnapshot(),
    hardware = [device.snapshot()];
  await mount();
  await waitForConnections({ right: device.serial });
  await clickButton('Manage amplifiers');
  await assign(device.serial, 'left');
  await waitForConnections({ left: device.serial });
  await act(async () => root.unmount());
  mounted = false;
  root = createRoot(host);
  await mount();
  await waitForConnections({ left: device.serial });
  expect(hub.requestDevice).not.toHaveBeenCalled();
  expect(device.open).toHaveBeenCalledTimes(2);
  expect(workspaceSnapshot()).toEqual(before);
  expectUnchanged([device], hardware);
});

it('leaves conflicting Right routing hints unassigned instead of choosing the first permitted device', async () => {
  const first = new ReadOnlyHidDevice('DISCOVERY-CONFLICT-A', 1),
    second = new ReadOnlyHidDevice('DISCOVERY-CONFLICT-B', 1),
    devices = [second, first],
    hub = installHid(devices),
    before = workspaceSnapshot(),
    hardware = devices.map((device) => device.snapshot());
  await mount();
  await clickButton('Manage amplifiers');
  await act(async () =>
    vi.waitFor(() => {
      for (const device of devices) {
        expect(
          host.querySelector<HTMLSelectElement>(
            `select[aria-label="Assignment for ${device.serial}"]`,
          )?.value,
        ).toBe('unassigned');
        expect(device.close).toHaveBeenCalledTimes(1);
      }
    }),
  );
  expect(seen.adapter!.connections()).toEqual({});
  expect(hub.requestDevice).not.toHaveBeenCalled();
  expect(workspaceSnapshot()).toEqual(before);
  expectUnchanged(devices, hardware);
});

it('the admitted MCP executor uses the visible discovery controller for assignments, stale refusal, swap and reconnect preference', async () => {
  const device = new ReadOnlyHidDevice('DISCOVERY-MCP', 0),
    hub = installHid([device]),
    before = workspaceSnapshot(),
    hardware = [device.snapshot()];
  await mount();
  await clickButton('Manage amplifiers');
  await act(async () =>
    vi.waitFor(() => {
      expect(device.close).toHaveBeenCalledTimes(1);
      expect(
        host.querySelector<HTMLSelectElement>(
          `select[aria-label="Assignment for ${device.serial}"]`,
        )?.value,
      ).toBe('unassigned');
    }),
  );
  const raw = { owner: 'local:synthetic-discovery-client', scope: 'paired-discovery-fixture' },
    revoke = seen.authority!.registerPairedActor(raw, 'local'),
    execute = createToolExecutor(seen.adapter!),
    invoke = async (input: unknown) => {
      let result: any;
      await act(async () => {
        result = await execute('fusion_devices', input, await seen.authority!.admit(raw));
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      return result.devices as ReturnType<NonNullable<ToolAdapter['amplifiers']>['getSnapshot']>;
    };
  try {
    const requests = device.requests.length,
      status = await invoke({ action: 'status' });
    expect(status.roles).toEqual({});
    expect(device.requests).toHaveLength(requests);
    const candidate = status.devices.find((entry) => entry.serial === device.serial)!;
    expect(candidate).toBeTruthy();
    expect(await execute('fusion_devices', { action: 'status' })).toMatchObject({ ok: false });
    expect(
      await execute(
        'fusion_devices',
        {
          action: 'assign',
          id: candidate.id,
          slot: 'left',
          expectedRevision: status.revision,
          device: { vendorId: 0x345e },
        },
        await seen.authority!.admit(raw),
      ),
    ).toMatchObject({ ok: false });
    const assigned = await invoke({
      action: 'assign',
      id: candidate.id,
      slot: 'left',
      expectedRevision: status.revision,
    });
    await waitForConnections({ left: device.serial });
    expect(
      host.querySelector<HTMLSelectElement>(`select[aria-label="Assignment for ${device.serial}"]`)
        ?.value,
    ).toBe('left');
    expect(
      await execute(
        'fusion_devices',
        { action: 'swap', expectedRevision: status.revision },
        await seen.authority!.admit(raw),
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/changed|review/) });
    const swapped = await invoke({ action: 'swap', expectedRevision: assigned.revision });
    await waitForConnections({ right: device.serial });
    expect(
      host.querySelector<HTMLSelectElement>(`select[aria-label="Assignment for ${device.serial}"]`)
        ?.value,
    ).toBe('right');
    const changed = await invoke({
      action: 'auto-connect',
      enabled: false,
      expectedRevision: swapped.revision,
    });
    expect(changed.autoReconnect).toBe(false);
    expect(JSON.parse(localStorage.getItem(AMPLIFIER_ROLE_PREFERENCES_KEY)!).autoReconnect).toBe(
      false,
    );
    await invoke({ action: 'disconnect', slot: 'right', expectedRevision: changed.revision });
    await waitForConnections({});
    await invoke({ action: 'discover' });
    expect(seen.adapter!.connections()).toEqual({});
    expect(device.open).toHaveBeenCalledTimes(2);
    expect(hub.requestDevice).not.toHaveBeenCalled();
    expect(workspaceSnapshot()).toEqual(before);
    expectUnchanged([device], hardware);
  } finally {
    revoke();
  }
});

it('Header Disconnect keeps its serial paused through replug and Find, while explicit Header Connect resumes later hotplug', async () => {
  const serial = 'DISCOVERY-MANUAL-DISCONNECT-R',
    original = new ReadOnlyHidDevice(serial, 1),
    reattached = new ReadOnlyHidDevice(serial, 1),
    devices = [original, reattached],
    hub = installHid([original]),
    before = workspaceSnapshot(),
    hardware = devices.map((device) => device.snapshot());
  remember({ [serial]: 'right' });
  await mount();
  await waitForConnections({ right: serial });
  await clickButton('Disconnect Right amplifier');
  await waitForConnections({});
  expect(original.close).toHaveBeenCalledTimes(1);
  await act(async () => {
    hub.disconnect(original);
    hub.connect(reattached);
  });
  await act(async () =>
    vi.waitFor(() => {
      expect(seen.adapter!.amplifiers!.getSnapshot().phase).toBe('ready');
      expect(reattached.close).toHaveBeenCalledTimes(1);
    }),
  );
  expect(seen.adapter!.connections()).toEqual({});
  await clickButton('Manage amplifiers');
  await clickButton('Find permitted amplifiers');
  await act(async () =>
    vi.waitFor(() => expect(seen.adapter!.amplifiers!.getSnapshot().phase).toBe('ready')),
  );
  expect(seen.adapter!.connections()).toEqual({});
  expect(
    host.querySelector<HTMLSelectElement>(`select[aria-label="Assignment for ${serial}"]`)?.value,
  ).toBe('unassigned');
  expect(reattached.open).toHaveBeenCalledTimes(1);
  expect(hub.requestDevice).not.toHaveBeenCalled();
  await clickButton('Close amplifier connections');
  await clickButton('Connect Right amplifier');
  await waitForConnections({ right: serial });
  expect(hub.requestDevice).toHaveBeenCalledTimes(1);
  await act(async () => {
    hub.disconnect(reattached);
    hub.connect(reattached);
  });
  await waitForConnections({ right: serial });
  expect(reattached.open).toHaveBeenCalledTimes(3);
  expect(hub.requestDevice).toHaveBeenCalledTimes(1);
  expect(workspaceSnapshot()).toEqual(before);
  expectUnchanged(devices, hardware);
});

it('StrictMode initial effect replay owns one physical open and releases it exactly once only on final unmount', async () => {
  const device = new ReadOnlyHidDevice('DISCOVERY-STRICT-OWNER-R', 1),
    hub = installHid([device]),
    before = workspaceSnapshot(),
    hardware = [device.snapshot()];
  await mount(); // mount() uses the real React.StrictMode effect replay.
  await waitForConnections({ right: device.serial });
  await act(async () =>
    root.render(
      <StrictMode>
        <Studio />
      </StrictMode>,
    ),
  );
  await waitForConnections({ right: device.serial });
  expect(device.open).toHaveBeenCalledTimes(1);
  expect(device.close).not.toHaveBeenCalled();
  expect(device.opened).toBe(true);
  expect(hub.requestDevice).not.toHaveBeenCalled();
  expect(workspaceSnapshot()).toEqual(before);
  await act(async () => root.unmount());
  mounted = false;
  expect(device.close).toHaveBeenCalledTimes(1);
  expect(device.opened).toBe(false);
  expect(workspaceSnapshot()).toEqual(before);
  expectUnchanged([device], hardware);
});

it('Add amplifier identifies an explicitly granted device with auto reconnect off, then manual assignment connects without another chooser', async () => {
  const device = new ReadOnlyHidDevice('DISCOVERY-EXPLICIT-GRANT-R', 1),
    hub = installHid([device]),
    before = workspaceSnapshot(),
    hardware = [device.snapshot()];
  localStorage.setItem(
    AMPLIFIER_ROLE_PREFERENCES_KEY,
    JSON.stringify({ version: 1, autoReconnect: false, assignments: {} }),
  );
  await mount();
  await act(async () =>
    vi.waitFor(() => expect(seen.adapter!.amplifiers!.getSnapshot().phase).toBe('ready')),
  );
  expect(device.open).not.toHaveBeenCalled();
  expect(hub.requestDevice).not.toHaveBeenCalled();
  await clickButton('Manage amplifiers');
  const add = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === 'Add amplifier',
  );
  expect(add).toBeTruthy();
  expect(add!.disabled).toBe(false);
  let onActivationStack = false;
  hub.requestDevice.mockImplementation(async () => {
    expect(onActivationStack).toBe(true);
    return [device.hid()];
  });
  await act(async () => {
    onActivationStack = true;
    add!.click();
    onActivationStack = false;
  });
  await act(async () =>
    vi.waitFor(() => {
      expect(device.close).toHaveBeenCalledTimes(1);
      expect(
        host.querySelector<HTMLSelectElement>(
          `select[aria-label="Assignment for ${device.serial}"]`,
        )?.value,
      ).toBe('unassigned');
    }),
  );
  expect(hub.requestDevice).toHaveBeenCalledTimes(1);
  expect(hub.requestDevice).toHaveBeenCalledWith({
    filters: [{ vendorId: 0x345e, productId: 0x03e8, usagePage: 0xff00, usage: 1 }],
  });
  expect(seen.adapter!.connections()).toEqual({});
  expect(seen.adapter!.amplifiers!.getSnapshot().autoReconnect).toBe(false);
  await assign(device.serial, 'right');
  await waitForConnections({ right: device.serial });
  expect(device.open).toHaveBeenCalledTimes(2);
  expect(hub.requestDevice).toHaveBeenCalledTimes(1);
  expect(workspaceSnapshot()).toEqual(before);
  expectUnchanged([device], hardware);
});
