// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Studio from '../src/components/Studio';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';
import type { WorkspaceAuthority } from '../src/application/workspace-authority';
import { exportHfd, parseProject } from '../src/domain/files';
import { defaultHfdMeasurementOptions } from '../src/domain/hfd-measurement';
import { newProject, type Slot } from '../src/domain/model';
import { SimulatedPanel } from '../src/hardware/simulator';
import { ensureWorkspaceHydrated, useWorkspace } from '../src/state/workspace';

const seen = vi.hoisted(() => ({
  adapter: undefined as ToolAdapter | undefined,
  authority: undefined as WorkspaceAuthority | undefined,
  invalidRightPreparation: false,
  preparedRoles: [] as Slot[],
}));
vi.mock('../src/application/native-project-open', async (original) => {
  const actual = await original<typeof import('../src/application/native-project-open')>();
  return {
    ...actual,
    prepareNativeProjectOpen: (...args: Parameters<typeof actual.prepareNativeProjectOpen>) => {
      const prepared = actual.prepareNativeProjectOpen(...args);
      seen.preparedRoles.push(args[1]);
      // A detached, role-specific fault checks the Studio final-schema boundary.
      // The real core still prepared both proposals; no workspace state is injected.
      if (args[1] === 'right' && seen.invalidRightPreparation)
        return { ...prepared, project: { ...prepared.project, hfdSelectedPreset: 2147483648 } };
      return prepared;
    },
  };
});
vi.mock('../src/components/AgentAccess', () => ({
  default: ({ adapter, authority }: { adapter: ToolAdapter; authority: WorkspaceAuthority }) => {
    seen.adapter = adapter;
    seen.authority = authority;
    return null;
  },
}));
vi.mock('../src/components/InteractivePlot', async (original) => ({
  ...(await original<typeof import('../src/components/InteractivePlot')>()),
  default: () => <div data-testid="plot" />,
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
  let stored: unknown = null;
  const workspace = actual.createWorkspaceStore({
    read: async () => structuredClone(stored),
    write: async (value) => {
      stored = structuredClone(value);
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

function syntheticRuntime(serial: string, preset: 1 | 3) {
  const panel = new SimulatedPanel(serial);
  panel.status[2] = preset;
  let forbidden = 0;
  class SyntheticDevice extends EventTarget {
    vendorId = 0x345e;
    productId = 0x03e8;
    productName = 'V51 synthetic runtime';
    opened = false;
    open = vi.fn(async () => {
      this.opened = true;
    });
    close = vi.fn(async () => {
      this.opened = false;
    });
    sendReport = vi.fn(async (_id: number, data: BufferSource) => {
      const request = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
        : new Uint8Array(data).slice();
      const allowed =
        (request[0] === 6 && request[1] === 1) ||
        (request[0] === 0x66 && request[1] === 0) ||
        (request[0] === 3 && request[1] === 8) ||
        (request[0] === 5 && request[1] === 1) ||
        (request[0] === 0x65 &&
          request[1] === 32 &&
          request[2] === 0 &&
          request[3] === 1 &&
          request[4] === 0 &&
          request[5] === 0);
      if (!allowed) {
        forbidden++;
        throw new Error('Synthetic runtime refuses setters and unrelated reads');
      }
      const reply = await panel.exchange(request),
        event = new Event('inputreport');
      Object.defineProperties(event, {
        reportId: { value: 0 },
        data: { value: new DataView(reply.buffer, reply.byteOffset, reply.byteLength) },
      });
      this.dispatchEvent(event);
    });
  }
  return { panel, device: new SyntheticDevice(), forbidden: () => forbidden };
}

let host: HTMLDivElement, root: Root, restoreHid: () => void;
let runtimes: {
  left: ReturnType<typeof syntheticRuntime>;
  right: ReturnType<typeof syntheticRuntime>;
};
const state = () => useWorkspace.getState();
const selection = () => {
  const { slot, preset, channel, filter } = state();
  return { slot, preset, channel, filter };
};
const execute = (name: Parameters<ReturnType<typeof createToolExecutor>>[0], args: unknown) =>
  createToolExecutor(seen.adapter!)(name, args, seen.authority!.localContext('manual'));

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // Freeze periodic polling only; actual request/response promises remain real.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  for (const name of ['showModal', 'close'])
    Object.defineProperty(HTMLDialogElement.prototype, name, {
      configurable: true,
      value: vi.fn(),
    });
  await ensureWorkspaceHydrated();
  useWorkspace.setState({
    documents: { left: newProject('Before Left'), right: newProject('Before Right') },
    slot: 'right',
    preset: 1,
    channel: 2,
    filter: 4,
    linkedEdits: true,
    linkedControls: false,
    documentRevision: 0,
    past: [],
    future: [],
    gesture: undefined,
    fileCommitReceipts: {},
  });
  seen.adapter = undefined;
  seen.authority = undefined;
  seen.invalidRightPreparation = false;
  seen.preparedRoles = [];
  runtimes = {
    left: syntheticRuntime('V51-SYNTHETIC-LEFT', 1),
    right: syntheticRuntime('V51-SYNTHETIC-RIGHT', 3),
  };
  const previous = Object.getOwnPropertyDescriptor(navigator, 'hid'),
    hub = new EventTarget();
  Object.assign(hub, {
    getDevices: vi.fn(async () => Object.values(runtimes).map((value) => value.device)),
    requestDevice: vi.fn(async () => {
      throw new Error('No chooser is allowed in this fixture');
    }),
  });
  Object.defineProperty(navigator, 'hid', { configurable: true, value: hub });
  restoreHid = () => {
    if (previous) Object.defineProperty(navigator, 'hid', previous);
    else Reflect.deleteProperty(navigator, 'hid');
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  restoreHid();
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function connectBoth() {
  await act(async () => root.render(<Studio />));
  await act(async () => seen.adapter!.view({ tab: 'Help' }));
  for (const slot of ['left', 'right'] as const)
    await act(async () => {
      expect(
        await execute('fusion_connect', { slot, serial: runtimes[slot].panel.serial }),
      ).toMatchObject({ ok: true });
    });
  expect(seen.adapter!.connections().left?.status.preset).toBe(1);
  expect(seen.adapter!.connections().right?.status.preset).toBe(3);
}
function nativeInput() {
  const project = newProject('Synthetic role-specific native input');
  project.hfdSelectedPreset = 2;
  project.hfdSelectedGroupId = 2;
  project.hfdCalibration = { filename: '', loaded: false, showCurve: false };
  for (const preset of project.presets)
    for (const [index, channel] of preset.channels.entries()) {
      channel.hfdMeasurement = { ...defaultHfdMeasurementOptions(), applyMicCorrection: false };
      if (index === 1) {
        channel.gain = 24;
        channel.additionalGain = 10;
      }
    }
  const content = exportHfd(project);
  return { content, decoded: parseProject(content) };
}
const reports = () => Object.values(runtimes).map((value) => value.panel.requests.length);
const noWrites = () => {
  for (const value of Object.values(runtimes)) {
    expect(value.panel.writes).toBe(0);
    expect(value.forbidden()).toBe(0);
  }
};

it('native Both import uses cached Left P1 and Right P3 without a fresh status read and one Undo restores both', async () => {
  await connectBoth();
  const incoming = nativeInput(),
    before = structuredClone(state().documents),
    beforeReports = reports();
  await act(async () => {
    expect(
      await execute('fusion_project_import', { target: 'both', content: incoming.content }),
    ).toMatchObject({ ok: true });
  });
  expect(seen.preparedRoles).toEqual(['left', 'right']);
  for (const [slot, presetIndex] of [
    ['left', 0],
    ['right', 2],
  ] as const) {
    const project = state().documents[slot];
    expect(project.hfdSelectedPreset).toBe(presetIndex + 1);
    expect(project.presets[presetIndex].channels[1].gain).toBe(14);
    expect(
      project.presets[presetIndex].channels.map(
        (channel) => channel.hfdMeasurement?.applyMicCorrection,
      ),
    ).toEqual([true, false, true]);
    for (const other of [0, 1, 2].filter((index) => index !== presetIndex)) {
      expect(project.presets[other].channels[1].gain).toBe(24);
      expect(
        project.presets[other].channels.map(
          (channel) => channel.hfdMeasurement?.applyMicCorrection,
        ),
      ).toEqual([false, false, false]);
    }
  }
  // Native XML has process sourceIds, not browser UUIDs. Both may clone one
  // decoded UUID bank; independence concerns detached role object graphs.
  const left = state().documents.left,
    right = state().documents.right;
  expect(left).not.toBe(right);
  expect(left.presets[0].channels[1]).not.toBe(right.presets[0].channels[1]);
  expect(left.presets[0].channels[1].filters[0].sourceId).toBe('72');
  const processingFilters = (project: typeof incoming.decoded) =>
    project.presets.map((preset) =>
      preset.channels.map((channel) =>
        channel.filters.map(({ id: _browserUuid, ...filter }) => filter),
      ),
    );
  expect(processingFilters(left)).toEqual(processingFilters(incoming.decoded));
  expect(processingFilters(right)).toEqual(processingFilters(incoming.decoded));
  expect(selection()).toEqual({ slot: 'right', preset: 2, channel: 1, filter: 0 });
  expect(state().past).toHaveLength(1);
  expect(state().documentRevision).toBe(1);
  expect(reports()).toEqual(beforeReports);
  noWrites();
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
});

it('an invalid connected Right cached preset refuses Both without publishing Left or changing selection/history', async () => {
  await connectBoth();
  seen.adapter!.connections().right!.status.preset = 4;
  const incoming = nativeInput(),
    before = structuredClone(state().documents),
    beforeSelection = selection(),
    beforeReports = reports();
  await act(async () => {
    expect(
      await execute('fusion_project_import', { target: 'both', content: incoming.content }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('cached amplifier preset') });
  });
  expect(seen.preparedRoles).toEqual(['left']);
  expect(state().documents).toEqual(before);
  expect(selection()).toEqual(beforeSelection);
  expect(state().past).toHaveLength(0);
  expect(state().documentRevision).toBe(0);
  expect(reports()).toEqual(beforeReports);
  noWrites();
});

it('an invalid Right final preparation refuses the paired import before any document publication', async () => {
  await connectBoth();
  seen.invalidRightPreparation = true;
  const incoming = nativeInput(),
    before = structuredClone(state().documents),
    beforeSelection = selection(),
    beforeReports = reports();
  const publications: unknown[] = [];
  const stop = useWorkspace.subscribe((next, previous) => {
    if (next.documents !== previous.documents) publications.push(next.documents);
  });
  await act(async () => {
    expect(
      await execute('fusion_project_import', { target: 'both', content: incoming.content }),
    ).toMatchObject({ ok: false });
  });
  stop();
  expect(seen.preparedRoles).toEqual(['left', 'right']);
  expect(publications).toEqual([]);
  expect(state().documents).toEqual(before);
  expect(selection()).toEqual(beforeSelection);
  expect(state().past).toHaveLength(0);
  expect(state().documentRevision).toBe(0);
  expect(reports()).toEqual(beforeReports);
  noWrites();
});
