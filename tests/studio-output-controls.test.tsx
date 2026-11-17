// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Studio from '../src/components/Studio';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';
import type { WorkspaceAuthority } from '../src/application/workspace-authority';
import { AMPLIFIER_ROLE_PREFERENCES_KEY } from '../src/application/amplifier-role-preferences';
import { newFilter, newProject, type Project, type Slot } from '../src/domain/model';
import { SimulatedPanel } from '../src/hardware/simulator';
import { ensureWorkspaceHydrated, useWorkspace } from '../src/state/workspace';

const seen = vi.hoisted(() => ({
  adapter: undefined as ToolAdapter | undefined,
  authority: undefined as WorkspaceAuthority | undefined,
}));
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

/** Real WebHidTransport and PanelSession talk to these supplied ports. Reads are
 * whitelisted; only the explicit simulated live-mute case enables 05/00.
 * No operating-system USB interface is accessed by these tests. */
class OutputHid extends EventTarget {
  readonly vendorId = 0x345e;
  readonly productId = 0x03e8;
  readonly productName = 'Synthetic output-control FA503';
  readonly collections = [{ usagePage: 0xff00, usage: 1 }];
  readonly panel: SimulatedPanel;
  opened = false;
  forbidden: Uint8Array[] = [];
  controls: Uint8Array[] = [];
  beforeControl?: () => Promise<void>;
  controlReply?: (reply: Uint8Array, writeIndex: number) => Uint8Array;
  constructor(
    readonly serial: string,
    readonly allowOutputMute = false,
  ) {
    super();
    this.panel = new SimulatedPanel(serial);
    this.panel.name = `Synthetic ${serial}`;
    this.panel.configuration[5] = this.panel.configuration[12] = 3;
    this.panel.deviceConfiguration[11] = 9;
    this.panel.deviceConfiguration[13] = 1;
    this.panel.status[11] = 0;
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
    const outputControl = this.allowOutputMute && bytes[0] === 5 && bytes[1] === 0;
    if (reportId !== 0 || bytes.length !== 64 || (!ordinaryRead && !serialRead && !outputControl)) {
      this.forbidden.push(bytes);
      throw new Error('Output fixture forbids unrelated device mutations');
    }
    if (outputControl) {
      this.controls.push(bytes);
      await this.beforeControl?.();
    }
    let response: Uint8Array = await this.panel.exchange(bytes);
    if (outputControl && this.controlReply)
      response = this.controlReply(response, this.controls.length);
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
      writes: this.panel.writes,
      mixerWrites: this.panel.mixerWrites,
      eqReloads: this.panel.eqReloads,
      displayUpdates: this.panel.displayUpdates,
      oemMaskUpdates: this.panel.oemMaskUpdates,
      noiseRequests: this.panel.noiseRequests,
    };
  }
}
let host: HTMLDivElement, root: Root, restoreHid: (() => void) | undefined;
const state = () => useWorkspace.getState();
const channel = (slot: Slot = 'left', index = state().channel) =>
  state().documents[slot].presets[0].channels[index];
function installHid(devices: OutputHid[]) {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'hid'),
    hub = Object.assign(new EventTarget(), {
      getDevices: vi.fn(async () => devices.map((device) => device.hid())),
      requestDevice: vi.fn(async () => devices.map((device) => device.hid())),
    });
  Object.defineProperty(navigator, 'hid', { configurable: true, value: hub });
  restoreHid = () => {
    if (previous) Object.defineProperty(navigator, 'hid', previous);
    else Reflect.deleteProperty(navigator, 'hid');
  };
  return hub;
}
const field = () => {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Gain"]');
  expect(input).toBeTruthy();
  return input!;
};
const button = (label: string) => {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.getAttribute('aria-label') === label || node.textContent?.trim() === label,
  );
  expect(found, `Production button ${label}`).toBeTruthy();
  return found!;
};
async function click(label: string) {
  const target = button(label);
  expect(target.disabled).toBe(false);
  await act(async () => target.click());
}
async function selectOutput(index: number, slot: Slot = state().slot) {
  await click(`Edit output CH${index + 1} · ${channel(slot, index).name}`);
  expect(state().channel).toBe(index);
}
async function draft(input: HTMLInputElement, text: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function commitGain(text: string) {
  const input = field();
  await draft(input, text);
  await act(async () => input.blur());
}
async function mount() {
  await act(async () => root.render(<Studio />));
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  for (const name of ['showModal', 'close'])
    Object.defineProperty(HTMLDialogElement.prototype, name, {
      configurable: true,
      value: vi.fn(),
    });
  localStorage.clear();
  await ensureWorkspaceHydrated();
  const documents = {
    left: newProject('Left output design'),
    right: newProject('Right output design'),
  };
  for (const slot of ['left', 'right'] as const)
    for (const [index, item] of documents[slot].presets[0].channels.entries()) {
      item.name = `${slot === 'left' ? 'Left' : 'Right'} ${['Woofer', 'Midrange', 'Tweeter'][index]}`;
      item.gain = slot === 'left' ? index : -index - 1;
      item.additionalGain = 0;
      item.filters[0] = {
        ...newFilter('peak'),
        frequency: 400 + index * 100,
        gain: 1.5,
        enabled: true,
        coefficients: { b0: 0.9, b1: 0.01, b2: -0.02, f1: 0.1, f2: -0.03 },
        provenance: 'hfd',
      };
      item.coefficientCache = 'effective';
    }
  useWorkspace.setState({
    documents,
    slot: 'left',
    preset: 0,
    channel: 0,
    filter: 0,
    linkedEdits: false,
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
});
afterEach(async () => {
  await act(async () => root.unmount());
  restoreHid?.();
  restoreHid = undefined;
  host.remove();
  vi.restoreAllMocks();
});

it('shows all three offline output mutes and one contextual Gain, sharing its selected-output edit with MCP and Undo', async () => {
  const hub = installHid([]);
  await mount();
  const overview = host.querySelector('[aria-label="Left output controls"]');
  expect(overview).toBeTruthy();
  expect(overview!.querySelectorAll('.channel-list button')).toHaveLength(3);
  for (const index of [1, 2, 3]) expect(button(`Live output mute CH${index}`).disabled).toBe(true);
  expect(host.querySelectorAll('input[aria-label="Gain"]')).toHaveLength(1);
  await selectOutput(1);
  expect(host.querySelector('[aria-label="Design gain CH2"]')?.contains(field())).toBe(true);
  expect(host.querySelector('[aria-label="Design gain CH2"]')?.textContent).toMatch(
    /upload.*apply/i,
  );
  const before = structuredClone(state().documents),
    history = state().past.length;
  await commitGain('7.555');
  expect(channel('left', 1).gain).toBe(7.56);
  expect(channel('left', 1).filters).toEqual(before.left.presets[0].channels[1].filters);
  expect(state().documents.right).toEqual(before.right);
  expect(state().past).toHaveLength(history + 1);
  const fromUi = structuredClone(state().documents);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
  await act(async () =>
    expect(
      await createToolExecutor(seen.adapter!)(
        'fusion_channel_set',
        { target: 'left', preset: 1, channel: 2, patch: { gain: 7.555 } },
        seen.authority!.localContext('manual'),
      ),
    ).toMatchObject({ ok: true }),
  );
  expect(state().documents).toEqual(fromUi);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
  expect(hub.requestDevice).not.toHaveBeenCalled();
});

it('keeps preview muting a selected output as a design-only Undo step while offline live buttons remain disabled', async () => {
  installHid([]);
  await mount();
  await selectOutput(2);
  const before = structuredClone(state().documents),
    history = state().past.length;
  await click('Preview mute');
  expect(channel('left', 2).muted).toBe(true);
  expect(state().documents.right).toEqual(before.right);
  expect(channel('left', 0)).toEqual(before.left.presets[0].channels[0]);
  expect(channel('left', 1)).toEqual(before.left.presets[0].channels[1]);
  expect(button('Edit output CH3 · Left Tweeter').textContent).toContain('preview muted');
  expect(button('Live output mute CH3').disabled).toBe(true);
  expect(state().past).toHaveLength(history + 1);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
});

it('mirrors the selected output Gain through each role native bound without touching other outputs or filter caches', async () => {
  installHid([]);
  useWorkspace.setState({ linkedEdits: true });
  channel('right', 1).additionalGain = 10;
  await mount();
  await selectOutput(1);
  const before = structuredClone(state().documents),
    history = state().past.length;
  await commitGain('24');
  expect(channel('left', 1).gain).toBe(24);
  expect(channel('right', 1).gain).toBe(14);
  for (const slot of ['left', 'right'] as const) {
    expect(channel(slot, 1).filters).toEqual(before[slot].presets[0].channels[1].filters);
    expect(channel(slot, 1).coefficientCache).toBe(
      before[slot].presets[0].channels[1].coefficientCache,
    );
    for (const index of [0, 2])
      expect(channel(slot, index)).toEqual(before[slot].presets[0].channels[index]);
  }
  expect(state().past).toHaveLength(history + 1);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
});

it('refuses a mirrored selected-output Gain when its peer is linked, without partial publication', async () => {
  installHid([]);
  useWorkspace.setState({ linkedEdits: true });
  channel('right', 1).linkedTo = 0;
  await mount();
  await selectOutput(1);
  const before = structuredClone(state().documents),
    history = state().past.length;
  await commitGain('7.555');
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(history);
  expect(host.textContent).toMatch(/linked|master/i);
});

it('discards a gain draft before a pre-render role switch can commit it to the newly selected amplifier', async () => {
  installHid([]);
  await mount();
  await selectOutput(1);
  const input = field();
  await draft(input, '7.555');
  let accepted!: Record<Slot, Project>;
  let history = 0;
  await act(async () => {
    seen.adapter!.choose({ slot: 'right' });
    accepted = structuredClone(state().documents);
    history = state().past.length;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect(state().documents).toEqual(accepted);
  expect(channel('left', 1).gain).toBe(1);
  expect(channel('right', 1).gain).toBe(-2);
  expect(state().past).toHaveLength(history);
  expect(host.querySelector('[aria-label="Right output controls"]')).toBeTruthy();
});

it('a simulated live mute changes one selected physical output from fresh status, while gain stays staged and linked controls cannot widen the target', async () => {
  const left = new OutputHid('OUTPUT-SIM-LEFT'),
    right = new OutputHid('OUTPUT-SIM-RIGHT', true),
    hub = installHid([left, right]);
  localStorage.setItem(
    AMPLIFIER_ROLE_PREFERENCES_KEY,
    JSON.stringify({
      version: 1,
      autoReconnect: true,
      assignments: {
        [left.serial]: { slot: 'left', source: 'manual' },
        [right.serial]: { slot: 'right', source: 'manual' },
      },
    }),
  );
  const hardware = [left.snapshot(), right.snapshot()];
  await mount();
  await act(async () =>
    vi.waitFor(() =>
      expect(Object.keys(seen.adapter!.connections()).sort()).toEqual(['left', 'right']),
    ),
  );
  await act(async () => seen.adapter!.choose({ slot: 'right' }));
  await selectOutput(1, 'right');
  const beforeGain = structuredClone(state().documents);
  await commitGain('-3.125');
  expect(channel('right', 1).gain).toBe(-3.13);
  expect(left.controls).toEqual([]);
  expect(right.controls).toEqual([]);
  expect(left.snapshot()).toEqual(hardware[0]);
  expect(right.snapshot()).toEqual(hardware[1]);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(beforeGain);
  const documents = structuredClone(state().documents),
    history = state().past.length,
    selection = { slot: state().slot, channel: state().channel, preset: state().preset };
  // Model an independent device update after the UI was drawn. The requested
  // output must merge against these fresh bits rather than the displayed array.
  right.panel.status[2] = 3;
  new DataView(right.panel.status.buffer).setInt16(3, -5000, true);
  right.panel.status[6] = 0x83;
  right.panel.status[7] = 1;
  right.panel.status[8] = 17;
  right.panel.status[9] = 0x1a;
  right.panel.status[35] = 0xab;
  right.panel.status[36] = 0xa3;
  const fresh = right.snapshot(),
    expectedStatus = fresh.status.slice();
  expectedStatus[6] |= 4;
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  right.beforeControl = async () => {
    started();
    await gate;
  };
  try {
    await click('Live output mute CH3');
    await entered;
    for (const index of [1, 2, 3])
      expect(button(`Live output mute CH${index}`).disabled).toBe(true);
    button('Live output mute CH3').click();
    expect(right.controls).toHaveLength(1);
  } finally {
    await act(async () => release());
  }
  await act(async () =>
    vi.waitFor(() =>
      expect(button('Live output mute CH3').getAttribute('aria-pressed')).toBe('true'),
    ),
  );
  expect(right.controls).toHaveLength(1);
  expect(left.controls).toEqual([]);
  expect(left.snapshot()).toEqual(hardware[0]);
  expect(right.snapshot()).toEqual({ ...fresh, status: expectedStatus });
  expect(left.forbidden).toEqual([]);
  expect(right.forbidden).toEqual([]);
  expect(state().documents).toEqual(documents);
  expect(state().past).toHaveLength(history);
  expect({ slot: state().slot, channel: state().channel, preset: state().preset }).toEqual(
    selection,
  );
  expect(hub.requestDevice).not.toHaveBeenCalled();
});

it('an uncertain simulated output-mute acknowledgement reports an error without a second setter or master-mute recovery', async () => {
  const left = new OutputHid('OUTPUT-UNCERTAIN-LEFT'),
    right = new OutputHid('OUTPUT-UNCERTAIN-RIGHT', true),
    hub = installHid([left, right]);
  right.panel.status[6] = 2; // CH2 muted; master and the requested CH3 are not.
  localStorage.setItem(
    AMPLIFIER_ROLE_PREFERENCES_KEY,
    JSON.stringify({
      version: 1,
      autoReconnect: true,
      assignments: {
        [left.serial]: { slot: 'left', source: 'manual' },
        [right.serial]: { slot: 'right', source: 'manual' },
      },
    }),
  );
  await mount();
  await act(async () =>
    vi.waitFor(() =>
      expect(Object.keys(seen.adapter!.connections()).sort()).toEqual(['left', 'right']),
    ),
  );
  await act(async () => seen.adapter!.choose({ slot: 'right' }));
  const documents = structuredClone(state().documents),
    history = state().past.length,
    selection = { slot: state().slot, preset: state().preset, channel: state().channel },
    leftBefore = left.snapshot();
  right.panel.status[2] = 2;
  new DataView(right.panel.status.buffer).setInt16(3, -5050, true);
  right.panel.status[9] = 0x1a;
  const fresh = right.snapshot(),
    expectedStatus = fresh.status.slice();
  expectedStatus[6] |= 4;
  right.controlReply = (reply, writeIndex) => {
    if (writeIndex !== 1) return reply;
    // A correctly framed acknowledgement with stale output state must fail
    // readback while leaving the transport usable. This makes an unintended
    // recovery setter observable, unlike a poisoned transport/send failure.
    const stale = reply.slice();
    stale[6] &= ~4;
    return stale;
  };
  await click('Live output mute CH3');
  await act(async () =>
    vi.waitFor(() => {
      expect(host.textContent).toMatch(/readback mismatch|unconfirmed/i);
      expect(button('Live output mute CH3').disabled).toBe(false);
    }),
  );
  expect(right.controls).toHaveLength(1);
  expect(left.controls).toEqual([]);
  expect(right.snapshot()).toEqual({ ...fresh, status: expectedStatus });
  expect(left.snapshot()).toEqual(leftBefore);
  expect(left.forbidden).toEqual([]);
  expect(right.forbidden).toEqual([]);
  expect(state().documents).toEqual(documents);
  expect(state().past).toHaveLength(history);
  expect({ slot: state().slot, preset: state().preset, channel: state().channel }).toEqual(
    selection,
  );
  expect(hub.requestDevice).not.toHaveBeenCalled();
});
