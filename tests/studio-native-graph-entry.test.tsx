// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Studio from '../src/components/Studio';
import { newFilter, newProject, type Slot } from '../src/domain/model';
import { defaultHfdMeasurementOptions } from '../src/domain/hfd-measurement';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';
import { ensureWorkspaceHydrated, useWorkspace } from '../src/state/workspace';

const seen = vi.hoisted(() => ({
  adapter: undefined as ToolAdapter | undefined,
  invalidateGraphPlanOnce: false,
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

it('real channel click commits Gain, microphone, graph flags and selection metadata in one selected-role Undo', async () => {
  const before = structuredClone(state().documents);
  await mount();
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
  await act(async () => button('Midrange').click());
  expect(state().channel).toBe(1);
  expect(target().gain).toBe(14);
  expect(target().additionalGain).toBe(10);
  expect(target().hfdMeasurement!.applyMicCorrection).toBe(false);
  expect(target().hfdGraph).toEqual({ showMeasuredResponse: false, showSum: false });
  expect(state().documents.left).toMatchObject({ hfdGainLowered: true, hfdSelectedGroupId: 2 });
  expect(target().filters).toEqual(before.left.presets[0].channels[1].filters);
  expect(target().coefficientCache).toBe('unresolved');
  expect(state().documents.right).toEqual(before.right);
  expect(state().documents.left.presets[1]).toEqual(before.left.presets[1]);
  expect(state().past).toHaveLength(1);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
});

it('shared fusion_select runs the same selected-role initialization despite Mirror', async () => {
  const before = structuredClone(state().documents);
  await mount();
  let result: unknown;
  await act(async () => {
    result = await execute('fusion_select', { slot: 'left', preset: 1, channel: 2, filter: 1 });
  });
  expect(result).toMatchObject({ ok: true });
  expect(target().gain).toBe(14);
  expect(state().documents.right).toEqual(before.right);
  expect(state().past).toHaveLength(1);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
});

it('selection while Help is visible stays passive until the Crossover graph is actually opened', async () => {
  const before = structuredClone(state().documents);
  await mount();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Help"]')!.click());
  await act(async () => seen.adapter!.choose({ channel: 1, filter: 0 }));
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(0);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Crossover"]')!.click());
  expect(target().gain).toBe(14);
  expect(target().hfdMeasurement!.applyMicCorrection).toBe(false);
  expect(state().documents.right).toEqual(before.right);
  expect(state().past).toHaveLength(1);
});

it('reveals the mixer Device panel before preset selection without initializing a hidden Crossover graph', async () => {
  const documents = structuredClone(state().documents);
  const dirty = documents.left.presets[1].channels[0];
  Object.assign(dirty, {
    gain: 24,
    additionalGain: 6,
    hfdMeasurement: { ...defaultHfdMeasurementOptions(), applyMicCorrection: true },
    hfdGraph: { showMeasuredResponse: true, showSum: false },
  });
  useWorkspace.setState({ documents });
  const before = structuredClone(state().documents),
    revision = state().documentRevision;
  await mount();
  const adapter = seen.adapter!,
    mixer = adapter.nativeMixer!,
    actor = {
      owner: 'workspace:11111111-1111-4111-8111-111111111111',
      scope: 'manual:mixer',
    },
    expectedRevision = mixer.getSnapshot().revision;
  // Admit only the mixer operation; actual Studio navigation, workspace and
  // graph entry remain real. No amplifier/session is provided to this test.
  const open = vi.spyOn(mixer, 'open').mockImplementation(() => mixer.getSnapshot()),
    view = vi.spyOn(adapter, 'view'),
    choose = vi.spyOn(adapter, 'choose');
  let result: unknown;
  await act(async () => {
    result = await createToolExecutor(adapter)(
      'fusion_native_mixer',
      { action: 'open', target: 'left', preset: 2, expectedRevision },
      actor,
    );
  });
  expect(result).toMatchObject({ ok: true });
  expect(open).toHaveBeenCalledExactlyOnceWith('left', actor, { preset: 2, expectedRevision });
  expect(state().documents).toEqual(before);
  expect(state().documentRevision).toBe(revision);
  expect(state().past).toHaveLength(0);
  expect(state().preset).toBe(1);
  expect(host.querySelector('[aria-label="Device settings"]')?.getAttribute('aria-current')).toBe(
    'page',
  );
  expect(view).toHaveBeenCalledExactlyOnceWith({ tab: 'Device settings' });
  expect(choose).toHaveBeenCalledExactlyOnceWith({ preset: 1 });
  expect(view.mock.invocationCallOrder[0]).toBeLessThan(choose.mock.invocationCallOrder[0]);
});

it.each([
  ['meters', { meters: true }],
  ['authentication', { authPanel: 'password' }],
  ['empty view', {}],
] as const)(
  'auxiliary %s fusion_view preserves a passively hydrated Graph document',
  async (_name, patch) => {
    useWorkspace.setState({ channel: 1 });
    const before = structuredClone(state().documents),
      revision = state().documentRevision;
    await mount();
    expect(state().documents).toEqual(before);
    await act(async () => {
      expect(await execute('fusion_view', patch)).toMatchObject({ ok: true });
    });
    expect(state().documents).toEqual(before);
    expect(state().documentRevision).toBe(revision);
    expect(state().past).toHaveLength(0);
  },
);

it('Undo restores model bytes while a revisit retains the already-created Graph lifetime', async () => {
  const before = structuredClone(state().documents);
  await mount();
  await act(async () => seen.adapter!.choose({ channel: 1, filter: 0 }));
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
  await act(async () => seen.adapter!.choose({ channel: 0 }));
  await act(async () => seen.adapter!.choose({ channel: 1 }));
  expect(target().gain).toBe(24);
  expect(target().hfdMeasurement!.applyMicCorrection).toBe(true);
  expect(state().documents.left.hfdGainLowered).toBe(false);
  expect(target().filters).toEqual(before.left.presets[0].channels[1].filters);
});

it('a canonical no-op visit is claimed without history and does not rerun after an ordinary edit', async () => {
  const project = state().documents.left;
  project.hfdSelectedGroupId = 2;
  project.hfdGainLowered = true;
  Object.assign(target(), { gain: 14, hfdGraph: { showMeasuredResponse: false, showSum: false } });
  target().hfdMeasurement!.applyMicCorrection = false;
  await mount();
  await act(async () => seen.adapter!.choose({ channel: 1 }));
  expect(state().past).toHaveLength(0);
  await act(async () =>
    state().editAt(
      ['left'],
      (document) => {
        document.presets[0].channels[1].gain = 24;
      },
      { synchronizeLinks: false },
    ),
  );
  await act(async () => seen.adapter!.choose({ channel: 0 }));
  await act(async () => seen.adapter!.choose({ channel: 1 }));
  expect(target().gain).toBe(24);
});

it.each(['Input EQ', 'Device settings'] as const)(
  'selection under %s does not initialize a hidden ordinary Graph',
  async (tab) => {
    const before = structuredClone(state().documents);
    await mount();
    await act(async () => seen.adapter!.view!({ tab }));
    await act(async () => seen.adapter!.choose({ channel: 1 }));
    expect(state().documents).toEqual(before);
    expect(state().past).toHaveLength(0);
  },
);

it('opening Response graph from Signal chain uses the combined entry transaction', async () => {
  const before = structuredClone(state().documents);
  await mount();
  await act(async () => seen.adapter!.view!({ designer: 'chain' }));
  await act(async () => seen.adapter!.choose({ channel: 1 }));
  expect(state().documents).toEqual(before);
  await act(async () => button('Response graph').click());
  expect(target().gain).toBe(14);
  expect(target().hfdMeasurement!.applyMicCorrection).toBe(false);
  expect(state().past).toHaveLength(1);
  expect(state().documents.right).toEqual(before.right);
});

it('explicit fusion_view HFD preset enters the current graph while retaining file selection metadata', async () => {
  await mount();
  await act(async () => seen.adapter!.view!({ tab: 'Help' }));
  await act(async () => seen.adapter!.choose({ channel: 1 }));
  await act(async () => {
    expect(
      await execute('fusion_view', { tab: 'Crossover', graph: { preset: 'hfd' } }),
    ).toMatchObject({ ok: true });
  });
  expect(target().gain).toBe(14);
  expect(target().hfdMeasurement!.applyMicCorrection).toBe(false);
  expect(state().documents.left.hfdSelectedGroupId).toBe(-1);
  expect(state().past).toHaveLength(1);
});

it('linked first entry copies the immediate source before compensation, hint and graph initialization in one Undo', async () => {
  target().linkedTo = 0;
  target().gain = 0;
  target().additionalGain = 6;
  const before = structuredClone(state().documents);
  await mount();
  await act(async () => seen.adapter!.choose({ channel: 1 }));
  expect(target()).toMatchObject({
    gain: 0,
    additionalGain: 10,
    linkedTo: 0,
    coefficientCache: 'base',
  });
  expect(state().documents.left.hfdGainLowered).toBe(true);
  expect(target().filters[0]).toMatchObject({
    kind: before.left.presets[0].channels[0].filters[0].kind,
    id: before.left.presets[0].channels[1].filters[0].id,
    sourceId: before.left.presets[0].channels[1].filters[0].sourceId,
  });
  expect(target().filters[0].coefficients).toEqual({ b0: 1, b1: 0, b2: 0, f1: 0, f2: 0 });
  expect(state().documents.left.presets[0].channels[0]).toEqual(before.left.presets[0].channels[0]);
  expect(state().documents.right).toEqual(before.right);
  expect(state().past).toHaveLength(1);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(before);
});

it('filter selection and graph-option changes leave a stale linked processing cache untouched', async () => {
  target().linkedTo = 0;
  useWorkspace.setState({ channel: 1 });
  const filters = structuredClone(target().filters),
    right = structuredClone(state().documents.right);
  await mount();
  await act(async () => {
    expect(await execute('fusion_select', { filter: 2 })).toMatchObject({ ok: true });
  });
  expect(target().gain).toBe(24);
  expect(target().filters).toEqual(filters);
  await act(async () => {
    expect(await execute('fusion_view', { graph: { sum: true } })).toMatchObject({ ok: true });
  });
  expect(target().gain).toBe(24);
  expect(target().filters).toEqual(filters);
  expect(state().documents.right).toEqual(right);
});

it.each(['channel click', 'MCP selection', 'MCP Graph opening'] as const)(
  '%s copies only the selected linked role and one Undo restores the full baseline',
  async (route) => {
    target().linkedTo = 0;
    state().documents.left.presets[0].channels[0].gain = -3;
    const before = structuredClone(state().documents);
    await mount();
    if (route === 'MCP Graph opening') {
      await act(async () => seen.adapter!.view!({ tab: 'Help' }));
      await act(async () => seen.adapter!.choose({ channel: 1 }));
      expect(state().documents).toEqual(before);
    }
    await act(async () => {
      if (route === 'channel click') button('Midrange').click();
      else if (route === 'MCP selection')
        expect(await execute('fusion_select', { channel: 2 })).toMatchObject({ ok: true });
      else expect(await execute('fusion_view', { tab: 'Crossover' })).toMatchObject({ ok: true });
    });
    expect(target()).toMatchObject({ gain: -3, additionalGain: 10, coefficientCache: 'base' });
    expect(target().filters[0].coefficients).toEqual({ b0: 1, b1: 0, b2: 0, f1: 0, f2: 0 });
    expect(state().documents.left.presets[0].channels[0]).toEqual(
      before.left.presets[0].channels[0],
    );
    expect(state().documents.right).toEqual(before.right);
    expect(state().past).toHaveLength(1);
    await act(async () => seen.adapter!.undo());
    expect(state().documents).toEqual(before);
    await act(async () => {
      expect(await execute('fusion_select', { channel: 2 })).toMatchObject({ ok: true });
    });
    expect(target().gain).toBe(-3);
    // The linked CopyTo repeats, but the already-created Graph's cold mic callback does not.
    expect(target().hfdMeasurement!.applyMicCorrection).toBe(true);
    expect(state().documents.right).toEqual(before.right);
    expect(state().past).toHaveLength(1);
  },
);

it.each(['absent', 'loaded'] as const)(
  'does not infer an unloaded microphone from %s calibration',
  async (mode) => {
    if (mode === 'absent') delete state().documents.left.hfdCalibration;
    else state().documents.left.hfdCalibration!.loaded = true;
    await mount();
    await act(async () => seen.adapter!.choose({ channel: 1 }));
    expect(target().hfdMeasurement!.applyMicCorrection).toBe(true);
    expect(target().gain).toBe(14);
  },
);

it.each([-1, 3])(
  'visible file replacement initializes only the current browser selection and preserves saved group %i',
  async (selectedGroup) => {
    await mount();
    await act(async () => seen.adapter!.choose({ channel: 1 }));
    const incoming = structuredClone(state().documents.left);
    incoming.hfdSelectedGroupId = selectedGroup;
    incoming.presets[0].channels[1].gain = 24;
    incoming.presets[0].channels[1].hfdMeasurement!.applyMicCorrection = true;
    incoming.presets[0].channels[2].gain = 24;
    incoming.presets[0].channels[2].additionalGain = 10;
    const right = structuredClone(state().documents.right),
      history = state().past.length;
    await act(async () => {
      state().replaceAt('left', incoming);
      seen.adapter!.documentsReplaced!(['left']);
    });
    expect(target().gain).toBe(14);
    expect(target().hfdMeasurement!.applyMicCorrection).toBe(false);
    expect(state().documents.left.hfdSelectedGroupId).toBe(selectedGroup);
    expect(state().documents.left.presets[0].channels[2].gain).toBe(24);
    expect(state().documents.right).toEqual(right);
    expect(state().past).toHaveLength(history + 2);
  },
);

it('preset navigation initializes only that selected role and preset without retargeting native group metadata', async () => {
  const channel = state().documents.left.presets[1].channels[0];
  channel.gain = 24;
  channel.additionalGain = 10;
  channel.hfdMeasurement = { ...defaultHfdMeasurementOptions(), applyMicCorrection: true };
  const before = structuredClone(state().documents);
  await mount();
  await act(async () => button('Preset 2').click());
  expect(state().preset).toBe(1);
  expect(state().documents.left.presets[1].channels[0]).toMatchObject({
    gain: 14,
    additionalGain: 10,
  });
  expect(state().documents.left.presets[1].channels[0].hfdMeasurement!.applyMicCorrection).toBe(
    false,
  );
  expect(state().documents.left.hfdSelectedGroupId).toBe(-1);
  expect(state().documents.left.presets[0]).toEqual(before.left.presets[0]);
  expect(state().documents.right).toEqual(before.right);
  expect(state().past).toHaveLength(1);
});

it('same-ID replacement invalidates visits synchronously before the React epoch rerender', async () => {
  await mount();
  await act(async () => seen.adapter!.choose({ channel: 1 }));
  await act(async () => seen.adapter!.undo());
  await act(async () => seen.adapter!.view!({ tab: 'Help' }));
  const oldAdapter = seen.adapter!,
    incoming = structuredClone(state().documents.left);
  const beforeRight = structuredClone(state().documents.right);
  await act(async () => {
    state().replaceAt('left', incoming);
    oldAdapter.documentsReplaced!(['left']);
    expect(target().gain).toBe(24);
    oldAdapter.view!({ tab: 'Crossover' });
  });
  expect(target().gain).toBe(14);
  expect(target().id).toBe(incoming.presets[0].channels[1].id);
  expect(state().documents.right).toEqual(beforeRight);
});

it('a stale graph plan refuses before Gain, microphone, graph flags or selection publication', async () => {
  await mount();
  await act(async () => seen.adapter!.view!({ tab: 'Help' }));
  await act(async () => seen.adapter!.choose({ channel: 1 }));
  const before = structuredClone(state().documents),
    selection = [state().slot, state().preset, state().channel, state().filter];
  seen.invalidateGraphPlanOnce = true;
  await act(async () => {
    expect(
      await execute('fusion_view', { tab: 'Crossover', graph: { preset: 'hfd' } }),
    ).toMatchObject({ ok: false });
  });
  expect(state().documents).toEqual(before);
  expect([state().slot, state().preset, state().channel, state().filter]).toEqual(selection);
  expect(state().past).toHaveLength(0);
  await act(async () => {
    expect(
      await execute('fusion_view', { tab: 'Crossover', graph: { preset: 'hfd' } }),
    ).toMatchObject({ ok: true });
  });
  expect(target().gain).toBe(14);
  expect(state().past).toHaveLength(1);
});

it('native time-bound refusal precedes entry, selection, model and view publication without claiming the visit', async () => {
  await mount();
  await act(async () => seen.adapter!.view!({ tab: 'Help' }));
  await act(async () => seen.adapter!.choose({ channel: 1 }));
  const before = structuredClone(state().documents),
    revision = state().documentRevision;
  const selection = [state().slot, state().preset, state().channel, state().filter];
  const view = () => {
    const value = seen.adapter!.viewState!() as Record<string, unknown>;
    return structuredClone({
      tab: value.tab,
      mode: value.mode,
      graph: value.graph,
      graphs: value.graphs,
      plotViews: value.plotViews,
    });
  };
  const beforeView = view();
  await act(async () => {
    expect(
      await execute('fusion_view', {
        tab: 'Crossover',
        mode: 'Impulse',
        timeMinMs: 0,
        timeMaxMs: Number.MIN_VALUE,
        amplitudeMin: -1,
        amplitudeMax: 1,
      }),
    ).toMatchObject({ ok: false });
  });
  expect(state().documents).toEqual(before);
  expect(state().documentRevision).toBe(revision);
  expect(state().past).toHaveLength(0);
  expect([state().slot, state().preset, state().channel, state().filter]).toEqual(selection);
  expect(view()).toEqual(beforeView);
  await act(async () => seen.adapter!.view!({ tab: 'Crossover' }));
  expect(target().gain).toBe(14);
  expect(state().past).toHaveLength(1);
});

it('a fresh visible Graph is admitted before palette staging and Apply retains raw caches, mixed bypass and one Undo', async () => {
  useWorkspace.setState({ channel: 1 });
  for (const slot of ['left', 'right'] as const) target(slot).coefficientCache = 'effective';
  const before = structuredClone(state().documents);
  await mount();
  await act(async () => {
    expect(
      await execute('fusion_filter_palette', { action: 'open', mode: 'replace', index: 1 }),
    ).toMatchObject({ ok: true });
  });
  expect(target().gain).toBe(14);
  expect(target().hfdMeasurement!.applyMicCorrection).toBe(false);
  expect(state().documents.left.hfdSelectedGroupId).toBe(-1);
  expect(state().documents.right).toEqual(before.right);
  expect(target().filters).toEqual(before.left.presets[0].channels[1].filters);
  const stagedBaseline = structuredClone(state().documents),
    history = state().past.length;
  const coefficients = { b0: 0.8, b1: 0.02, b2: -0.01, f1: 0.1, f2: 0.05 };
  await act(async () => {
    expect(
      await execute('fusion_filter_palette', {
        action: 'update',
        draft: { kind: 'raw', coefficients },
      }),
    ).toMatchObject({ ok: true });
  });
  expect(state().documents).toEqual(stagedBaseline);
  await act(async () => {
    expect(await execute('fusion_filter_palette', { action: 'apply' })).toMatchObject({ ok: true });
  });
  for (const slot of ['left', 'right'] as const) {
    expect(target(slot).filters[0]).toMatchObject({
      kind: 'raw',
      coefficients,
      enabled: slot === 'left',
    });
    expect(target(slot).filters[0].sourceId).toBe(
      before[slot].presets[0].channels[1].filters[0].sourceId,
    );
    expect(target(slot).coefficientCache).toBe('effective');
  }
  expect(state().documents.left.hfdSelectedGroupId).toBe(-1);
  expect(state().past).toHaveLength(history + 1);
  await act(async () => seen.adapter!.undo());
  expect(state().documents).toEqual(stagedBaseline);
});

it('opening an ordinary palette from Help visibly admits only its source Graph before staging', async () => {
  useWorkspace.setState({ channel: 1 });
  const before = structuredClone(state().documents);
  await mount();
  await act(async () => seen.adapter!.view!({ tab: 'Help', designer: 'chain' }));
  await act(async () => {
    expect(
      await execute('fusion_filter_palette', { action: 'open', mode: 'replace', index: 1 }),
    ).toMatchObject({ ok: true });
  });
  expect(seen.adapter!.viewState!()).toMatchObject({ tab: 'Crossover', designer: 'graph' });
  expect(target().gain).toBe(14);
  expect(target().hfdMeasurement!.applyMicCorrection).toBe(false);
  expect(target().filters).toEqual(before.left.presets[0].channels[1].filters);
  expect(state().documents.left.hfdSelectedGroupId).toBe(-1);
  expect(state().documents.right).toEqual(before.right);
  expect(state().past).toHaveLength(1);
});

it('a refused paired palette opening preserves model, selection and hidden view before any source admission', async () => {
  useWorkspace.setState({ channel: 1 });
  target('right').linkedTo = 0;
  await mount();
  await act(async () => seen.adapter!.view!({ tab: 'Help', designer: 'chain' }));
  const before = structuredClone(state().documents),
    revision = state().documentRevision;
  const selection = [state().slot, state().preset, state().channel, state().filter];
  await act(async () => {
    expect(
      await execute('fusion_filter_palette', { action: 'open', mode: 'replace', index: 1 }),
    ).toMatchObject({ ok: false });
  });
  expect(state().documents).toEqual(before);
  expect(state().documentRevision).toBe(revision);
  expect(state().past).toHaveLength(0);
  expect([state().slot, state().preset, state().channel, state().filter]).toEqual(selection);
  expect(seen.adapter!.viewState!()).toMatchObject({
    tab: 'Help',
    designer: 'chain',
    palette: null,
  });
  await act(async () => seen.adapter!.view!({ tab: 'Crossover', designer: 'graph' }));
  expect(target().gain).toBe(14);
});
