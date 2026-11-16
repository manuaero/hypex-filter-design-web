// @vitest-environment jsdom
import { File as NativeFile } from 'node:buffer';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Studio from '../src/components/Studio';
import { newFilter, newProject, type Slot } from '../src/domain/model';
import { exportHfd, parseProject } from '../src/domain/files';
import { defaultHfdMeasurementOptions } from '../src/domain/hfd-measurement';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';
import { ensureWorkspaceHydrated, useWorkspace } from '../src/state/workspace';

const seen = vi.hoisted(() => ({
  adapter: undefined as ToolAdapter | undefined,
  invalidateGraphPlanOnce: false,
  writeGate: undefined as Promise<void> | undefined,
}));
vi.mock('../src/application/graph-view', async (original) => {
  const actual = await original<typeof import('../src/application/graph-view')>();
  return {
    ...actual,
    createGraphViewController: () => {
      const controller = actual.createGraphViewController();
      return {
        ...controller,
        plan: (...args: Parameters<typeof controller.plan>) => {
          const plan = controller.plan(...args);
          if (seen.invalidateGraphPlanOnce) {
            seen.invalidateGraphPlanOnce = false;
            controller.commit(controller.selection(args[0], { normalize: false }));
          }
          return plan;
        },
      };
    },
  };
});
vi.mock('../src/components/AgentAccess', () => ({
  default: ({ adapter }: { adapter: ToolAdapter }) => {
    seen.adapter = adapter;
    return null;
  },
}));
vi.mock('../src/components/InteractivePlot', async (original) => ({
  ...(await original<typeof import('../src/components/InteractivePlot')>()),
  default: () => <div data-testid="actual-plot-location" />,
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
      await seen.writeGate;
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

let host: HTMLDivElement, root: Root;
const state = () => useWorkspace.getState();
const target = (slot: Slot = 'left') => state().documents[slot].presets[0].channels[1];
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  for (const name of ['showModal', 'close'])
    Object.defineProperty(HTMLDialogElement.prototype, name, {
      configurable: true,
      value: vi.fn(),
    });
  await ensureWorkspaceHydrated();
  const documents = {
    left: newProject('Left native synthetic'),
    right: newProject('Right synthetic'),
  };
  for (const slot of ['left', 'right'] as const) {
    const project = documents[slot];
    Object.assign(project, { hfdSelectedGroupId: -1 });
    project.hfdCalibration = { filename: '', loaded: false, showCurve: false };
    project.hfdGainLowered = false;
    const channel = project.presets[0].channels[1];
    channel.gain = 24;
    channel.additionalGain = 10;
    channel.hfdMeasurement = { ...defaultHfdMeasurementOptions(), applyMicCorrection: true };
    channel.hfdGraph = { showMeasuredResponse: true, showSum: false };
    channel.coefficientCache = 'unresolved';
    channel.filters[0] = {
      ...newFilter('peak'),
      enabled: slot === 'left',
      coefficients: { b0: 0.9, b1: 0.02, b2: -0.01, f1: 0.1, f2: 0.05 },
      provenance: 'hfd',
      sourceId: `${slot}-native-cache`,
    };
  }
  useWorkspace.setState({
    documents,
    slot: 'left',
    preset: 0,
    channel: 0,
    filter: 0,
    linkedEdits: true,
    linkedControls: false,
    documentRevision: 0,
    past: [],
    future: [],
    gesture: undefined,
    fileCommitReceipts: {},
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  seen.adapter = undefined;
  seen.invalidateGraphPlanOnce = false;
  seen.writeGate = undefined;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
const mount = () => act(async () => root.render(<Studio />));
const button = (text: string) => {
  const found = [...host.querySelectorAll('button')].find((node) =>
    node.textContent?.includes(text),
  );
  expect(found, text).toBeDefined();
  return found!;
};
const execute = (name: Parameters<ReturnType<typeof createToolExecutor>>[0], args: unknown) =>
  createToolExecutor(seen.adapter!)(name, args);

const nativeInput = (group = 2) => {
  const project = newProject('V51 native synthetic');
  project.hfdSelectedPreset = 3;
  project.hfdSelectedGroupId = group;
  project.hfdGainLowered = false;
  project.hfdCalibration = { filename: '', loaded: false, showCurve: false };
  for (const preset of project.presets)
    for (const channel of preset.channels) {
      channel.hfdMeasurement = { ...defaultHfdMeasurementOptions(), applyMicCorrection: false };
      channel.coefficientCache = 'effective';
    }
  for (const p of [0, 2]) {
    project.presets[p].channels[1].gain = 24;
    project.presets[p].channels[1].additionalGain = 10;
    project.presets[p].channels[1].hfdGraph = { showMeasuredResponse: true, showSum: false };
  }
  const content = exportHfd(project);
  return { content, decoded: parseProject(content) };
};
const view = () => seen.adapter!.viewState!() as { tab: string; designer: string };
const flags = () =>
  state().documents.left.presets[0].channels.map((c) => c.hfdMeasurement?.applyMicCorrection);
// Native XML has no browser UUIDs; independently parsed imports allocate them.
const processing = (value: unknown) => {
  const identities = new Map<string, string>();
  const collect = (item: unknown) => {
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    if (typeof record.id === 'string' && !identities.has(record.id))
      identities.set(record.id, `browser-identity-${identities.size}`);
    Object.values(record).forEach(collect);
  };
  collect(value);
  // Normalize generated identities consistently, retaining the new raw-cache
  // witness's ordered slot bindings and first-filter identity in the comparison.
  return JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === 'string' ? (identities.get(item) ?? item) : item,
    ),
  );
};

it('native MCP Open from Help chooses offline P1/saved CH2 and publishes complete final data in one Undo', async () => {
  const incoming = nativeInput(),
    before = structuredClone(state().documents);
  useWorkspace.setState({ preset: 2, channel: 2, filter: 7 });
  await mount();
  await act(async () => seen.adapter!.view({ tab: 'Help' }));
  const publications: ReturnType<typeof state>['documents'][] = [];
  const stop = useWorkspace.subscribe((next, previous) => {
    if (next.documents !== previous.documents) publications.push(structuredClone(next.documents));
  });
  await act(async () => {
    expect(
      await execute('fusion_project_import', { target: 'left', content: incoming.content }),
    ).toMatchObject({ ok: true });
  });
  stop();
  expect(publications).toHaveLength(1);
  expect(state()).toMatchObject({
    slot: 'left',
    preset: 0,
    channel: 1,
    filter: 0,
    documentRevision: 1,
  });
  expect(state().documents.left).toMatchObject({
    hfdSelectedPreset: 1,
    hfdSelectedGroupId: 2,
    hfdGainLowered: true,
  });
  expect(target()).toMatchObject({
    gain: 14,
    additionalGain: 10,
    hfdGraph: { showMeasuredResponse: false, showSum: false },
  });
  expect(flags()).toEqual([true, false, true]);
  expect(view()).toMatchObject({ tab: 'Crossover', designer: 'graph' });
  expect(state().documents.right).toEqual(before.right);
  expect(processing(state().documents.left.presets.slice(1))).toEqual(
    processing(incoming.decoded.presets.slice(1)),
  );
  expect(processing(target().filters)).toEqual(
    processing(incoming.decoded.presets[0].channels[1].filters),
  );
  expect(publications[0]).toEqual(state().documents);
  expect(state().past).toHaveLength(1);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
  await act(async () => seen.adapter!.redo());
  expect(state().documents).toEqual(publications[0]);
});

it('unknown group777 keeps Gain24 and no arbitrary Graph while dialog rebinds all current-preset microphones', async () => {
  const incoming = nativeInput(777),
    right = structuredClone(state().documents.right);
  useWorkspace.setState({ preset: 2, channel: 2 });
  await mount();
  await act(async () => {
    expect(
      await execute('fusion_project_import', { target: 'left', content: incoming.content }),
    ).toMatchObject({ ok: true });
  });
  expect(state().documents.left).toMatchObject({ hfdSelectedPreset: 1, hfdSelectedGroupId: 777 });
  expect(target().gain).toBe(24);
  expect(flags()).toEqual([true, true, true]);
  expect(state()).toMatchObject({ preset: 0, channel: 2 });
  expect(view()).toMatchObject({ tab: 'Crossover', designer: 'chain' });
  expect(state().past).toHaveLength(1);
  expect(state().documents.right).toEqual(right);
});

it('explicit Both native Open independently prepares both roles despite Mirror and uses one paired Undo', async () => {
  const incoming = nativeInput(),
    before = structuredClone(state().documents);
  useWorkspace.setState({ slot: 'right', preset: 2, channel: 2 });
  await mount();
  await act(async () => {
    expect(
      await execute('fusion_project_import', { target: 'both', content: incoming.content }),
    ).toMatchObject({ ok: true });
  });
  for (const role of ['left', 'right'] as const) {
    expect(state().documents[role].hfdSelectedPreset).toBe(1);
    expect(state().documents[role].presets[0].channels[1].gain).toBe(14);
    expect(
      state().documents[role].presets[0].channels.map((c) => c.hfdMeasurement?.applyMicCorrection),
    ).toEqual([true, false, true]);
  }
  expect(state()).toMatchObject({ slot: 'right', preset: 0, channel: 1, documentRevision: 1 });
  expect(state().past).toHaveLength(1);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
  expect(target('right').gain).toBe(24);
});

it('browser JSON containing native source XML remains a passive snapshot while Help is visible', async () => {
  const incoming = nativeInput();
  useWorkspace.setState({ preset: 2, channel: 2 });
  await mount();
  await act(async () => seen.adapter!.view({ tab: 'Help' }));
  await act(async () => {
    expect(
      await execute('fusion_project_import', {
        target: 'left',
        content: JSON.stringify(incoming.decoded),
      }),
    ).toMatchObject({ ok: true });
  });
  expect(state()).toMatchObject({ preset: 2, channel: 2 });
  expect(state().documents.left).toEqual(incoming.decoded);
  expect(view().tab).toBe('Help');
  expect(state().past).toHaveLength(1);
});

it('durable native file commit persists only the prepared final and replay after Undo stays passive', async () => {
  const incoming = nativeInput(),
    before = structuredClone(state().documents),
    principal = { owner: 'site:test', scope: 'v51' };
  await mount();
  await act(async () => seen.adapter!.view({ tab: 'Help' }));
  const replace = vi.fn((destination: typeof incoming.decoded) => {
    for (const key of Object.keys(destination)) Reflect.deleteProperty(destination, key);
    Object.assign(destination, structuredClone(incoming.decoded));
  });
  const metadata = {
    workflow: 'project',
    projectOpen: { kind: 'native-file-open', route: 'dialog' },
  };
  let receipt: unknown;
  await act(async () => {
    receipt = await seen.adapter!.files!.commit(
      'v51-native',
      principal,
      0,
      ['left'],
      replace,
      metadata,
      undefined,
      { synchronizeLinks: false },
    );
  });
  expect(target().gain).toBe(14);
  expect(flags()).toEqual([true, false, true]);
  expect(state()).toMatchObject({ preset: 0, channel: 1, documentRevision: 1 });
  expect(state().past).toHaveLength(1);
  expect(replace).toHaveBeenCalledTimes(1);
  const persisted = JSON.parse(seen.adapter!.persistence!.recovery()!);
  expect(persisted.state.documents).toEqual(state().documents);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
  const afterUndo = state().documentRevision;
  await act(async () => seen.adapter!.view({ tab: 'Help' }));
  await act(async () => {
    expect(
      await seen.adapter!.files!.commit('v51-native', principal, 0, ['left'], replace, metadata),
    ).toEqual(receipt);
  });
  expect(state().documents).toEqual(before);
  expect(state().documentRevision).toBe(afterUndo);
  expect(replace).toHaveBeenCalledTimes(1);
  expect(view().tab).toBe('Help');
});

const pickFile = async (text: string | Promise<string>, name = 'Config.xml') => {
  const picker = host.querySelector<HTMLInputElement>('input[type=file][hidden]')!;
  Object.defineProperty(picker, 'files', {
    configurable: true,
    value: [new NativeFile([await text], name)],
  });
  await act(async () => {
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
it('header Open applies the same native dialog profile before one replacement', async () => {
  const incoming = nativeInput();
  useWorkspace.setState({ preset: 2, channel: 2 });
  await mount();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Open project"]')!.click(),
  );
  await pickFile(incoming.content);
  expect(state()).toMatchObject({ preset: 0, channel: 1, documentRevision: 1 });
  expect(target().gain).toBe(14);
  expect(flags()).toEqual([true, false, true]);
  expect(state().past).toHaveLength(1);
});

it('header Open refuses a stale picker after the user changes document selection', async () => {
  const incoming = nativeInput();
  await mount();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Open project"]')!.click(),
  );
  await act(async () => seen.adapter!.view({ tab: 'Help' }));
  await act(async () => seen.adapter!.choose({ slot: 'right', channel: 2 }));
  const before = structuredClone(state().documents),
    revision = state().documentRevision;
  await pickFile(incoming.content);
  expect(state().documents).toEqual(before);
  expect(state().documentRevision).toBe(revision);
  expect(state()).toMatchObject({ slot: 'right', channel: 2 });
  expect(host.textContent).toContain('changed');
});

it('saved native source inner Open retains unopened microphone flags while applying the selected cold Graph', async () => {
  const incoming = nativeInput();
  useWorkspace.setState({ preset: 2, channel: 2 });
  await mount();
  await act(async () => seen.adapter!.view({ tab: 'Help' }));
  await act(async () => {
    await seen.adapter!.files!.commit(
      'v51-inner',
      { owner: 'site:test', scope: 'v51' },
      0,
      ['left'],
      (destination) => {
        for (const key of Object.keys(destination)) Reflect.deleteProperty(destination, key);
        Object.assign(destination, structuredClone(incoming.decoded));
      },
      { workflow: 'source-open', projectOpen: { kind: 'native-file-open', route: 'inner' } },
      undefined,
      { synchronizeLinks: false },
    );
  });
  expect(flags()).toEqual([false, false, false]);
  expect(target().gain).toBe(14);
  expect(state()).toMatchObject({ preset: 0, channel: 1, documentRevision: 1 });
  expect(view()).toMatchObject({ tab: 'Crossover', designer: 'graph' });
  expect(state().past).toHaveLength(1);
});

it('a newer edit during native commit persistence retains its data and current view without replaying Open', async () => {
  const incoming = nativeInput();
  await mount();
  await act(async () => seen.adapter!.view({ tab: 'Help' }));
  await seen.adapter!.persistence!.flush();
  let release!: () => void;
  seen.writeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let committed!: Promise<unknown>;
  try {
    await act(async () => {
      committed = seen.adapter!.files!.commit(
        'v51-interleaved',
        { owner: 'site:test', scope: 'v51' },
        0,
        ['left'],
        (destination) => {
          for (const key of Object.keys(destination)) Reflect.deleteProperty(destination, key);
          Object.assign(destination, structuredClone(incoming.decoded));
        },
        { workflow: 'project', projectOpen: { kind: 'native-file-open', route: 'dialog' } },
        undefined,
        { synchronizeLinks: false },
      );
      await Promise.resolve();
    });
    expect(target().gain).toBe(14);
    expect(state().documentRevision).toBe(1);
    expect(view()).toMatchObject({ tab: 'Crossover', designer: 'graph' });
    await act(async () => seen.adapter!.view({ tab: 'Help' }));
    await act(async () =>
      state().editAt(
        ['left'],
        (project) => {
          project.presets[0].channels[1].gain = 23;
        },
        { synchronizeLinks: false },
      ),
    );
  } finally {
    seen.writeGate = undefined;
    release();
    await act(async () => {
      await committed;
    });
  }
  expect(target().gain).toBe(23);
  expect(state().documentRevision).toBe(2);
  expect(state().past).toHaveLength(2);
  expect(view().tab).toBe('Help');
  expect(state()).toMatchObject({ preset: 0, channel: 1 });
  await act(async () => seen.adapter!.view({ tab: 'Crossover' }));
  expect(target().gain).toBe(23);
  expect(state().documentRevision).toBe(2);
});

it('visible snapshot replacement retains ordinary V50 current-Graph admission without native saved-selection or dialog rebind', async () => {
  const incoming = nativeInput();
  useWorkspace.setState({ channel: 1 });
  await mount();
  await act(async () => {
    expect(
      await execute('fusion_project_import', {
        target: 'left',
        content: JSON.stringify(incoming.decoded),
      }),
    ).toMatchObject({ ok: true });
  });
  expect(state().documents.left.hfdSelectedPreset).toBe(3);
  expect(state().documents.left.hfdSelectedGroupId).toBe(2);
  expect(target().gain).toBe(14);
  expect(flags()).toEqual([false, false, false]);
  expect(state()).toMatchObject({ preset: 0, channel: 1, documentRevision: 2 });
  expect(state().past).toHaveLength(2);
});
