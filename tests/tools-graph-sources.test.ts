import { expect, it, vi } from 'vitest';
import {
  createToolExecutor,
  TOOL_DEFINITIONS,
  type DocumentState,
  type ToolAdapter,
} from '../src/application/tools';
import { newProject } from '../src/domain/model';
import { buildMagnitudeLayers } from '../src/domain/plot-layers';
import { sampleHfdView } from '../src/domain/hfd-response-view';
import {
  ProjectSourcesError,
  type ProjectSources,
  type PreparedProjectOpen,
} from '../src/application/project-sources';

function setup(sources?: ProjectSources) {
  const state: DocumentState = {
    documents: { left: newProject('Left'), right: newProject('Right') },
    slot: 'right',
    preset: 2,
    channel: 2,
    filter: 14,
    linkedEdits: true,
    linkedControls: true,
    documentRevision: 7,
  };
  const edit = vi.fn(),
    view = vi.fn(),
    hardware = vi.fn(async () => {
      throw new Error('Unexpected hardware access');
    });
  const adapter: ToolAdapter = {
    state: () => state,
    edit,
    view,
    sources,
    choose: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    connections: () => ({}),
    connect: hardware,
    disconnect: hardware,
    refresh: hardware,
    operate: async (_, fn) => fn(),
    message: vi.fn(),
    progress: vi.fn(),
  };
  return { execute: createToolExecutor(adapter), adapter, state, edit, view, hardware };
}
const context = { owner: 'test-owner', scope: 'test-scope' };

it('passes graph preferences through the shared view action and rejects invalid raw vectors', async () => {
  const { execute, view, edit, hardware } = setup();
  const graph = {
    preset: 'hfd',
    rawMeasurements: [true, false, true],
    otherResults: false,
    sectionScope: 'selected',
  };
  expect(await execute('fusion_view', { graph })).toEqual({ ok: true });
  expect(view).toHaveBeenCalledWith({ graph });
  expect(await execute('fusion_view', { graph: { rawMeasurements: [true] } })).toMatchObject({
    ok: false,
  });
  expect(await execute('fusion_view', { graph: { madeUpOption: true } })).toMatchObject({
    ok: false,
  });
  expect(view).toHaveBeenCalledTimes(1);
  expect(edit).not.toHaveBeenCalled();
  expect(hardware).not.toHaveBeenCalled();
});

it('exposes shared zoom-back through the cached view command and rejects combined range mutations before dispatch', async () => {
  const { execute, view } = setup();
  expect(await execute('fusion_view', { mode: 'Step', zoomBack: true })).toEqual({ ok: true });
  expect(view).toHaveBeenLastCalledWith({ mode: 'Step', zoomBack: true });
  expect(await execute('fusion_view', { zoomBack: true, timeMinMs: 0 })).toMatchObject({
    ok: false,
  });
  expect(await execute('fusion_view', { zoomBack: true, resetPlot: true })).toMatchObject({
    ok: false,
  });
  expect(view).toHaveBeenCalledTimes(1);
});

it('returns precisely sampled display layers without modifying either design', async () => {
  const { execute, state, edit, hardware } = setup(),
    p = state.documents.left.presets[0];
  p.channels[0].measurement = {
    name: 'Driver',
    sampleRate: 48000,
    frequency: [20, 1000, 20000],
    magnitude: [-3, 4, -8],
    phase: [0, 0, 0],
  };
  p.channels[0].filters[1] = {
    ...p.channels[0].filters[1],
    kind: 'peak',
    frequency: 1000,
    gain: 6,
    q: 1,
    enabled: false,
  };
  const before = structuredClone(state.documents),
    frequencies = [0.001, 20, 1000, 23999],
    layers = {
      rawMeasurements: [true, false, false],
      currentResult: true,
      otherResults: true,
      section: true,
      selectedFilter: 2,
      sum: true,
    };
  const expected = buildMagnitudeLayers(p.channels, {
    preset: p,
    layers,
    referenceChannel: 0,
    selectedFilter: 1,
    sum: true,
    measured: false,
    centered: false,
  });
  const result = (await execute('fusion_analyze', {
    slot: 'left',
    preset: 1,
    referenceChannel: 1,
    frequencies,
    nativeCentered: false,
    layers,
  })) as {
    ok: boolean;
    magnitudeLayers: {
      curves: {
        kind: string;
        channel?: number;
        filter?: number;
        points: { frequency: number; db: number | null }[];
      }[];
    };
  };
  expect(result.ok).toBe(true);
  expect(result.magnitudeLayers.curves).toEqual(
    expected.curves.map(({ db, ...curve }) => ({
      ...curve,
      ...(curve.channel === undefined ? {} : { channel: curve.channel + 1 }),
      ...(curve.filter === undefined ? {} : { filter: curve.filter + 1 }),
      points: frequencies.map((frequency) => ({
        frequency,
        db: sampleHfdView(expected, db, frequency),
      })),
    })),
  );
  expect(result.magnitudeLayers.curves.find((c) => c.kind === 'section')?.filter).toBe(2);
  expect(state.documents).toEqual(before);
  expect(edit).not.toHaveBeenCalled();
  expect(hardware).not.toHaveBeenCalled();
});

function sourceStub() {
  const prepared = Object.freeze({}) as PreparedProjectOpen;
  const snapshot = {
    phase: 'ready',
    hydrated: true,
    saving: false,
    error: null,
    roots: [],
    recent: [],
  };
  const source = {
    hydrate: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    getSnapshot: () => snapshot,
    prepareOpen: vi.fn(async () => prepared),
    commitOpen: vi.fn(async () => ({
      receipt: { commitId: 'receipt', revision: 8, result: {} },
      replayed: false,
      recentSaved: true,
    })),
    list: vi.fn(async () => ({ rootId: 'root', entries: [], needsHumanGrant: true })),
  };
  return { source, sources: source as unknown as ProjectSources, prepared, snapshot };
}

it('binds source opens to explicit role/revision/request and the trusted principal', async () => {
  const { source, sources, prepared } = sourceStub(),
    { execute, edit, hardware } = setup(sources);
  const args = {
    action: 'open',
    sourceId: 'source',
    target: 'left',
    expectedRevision: 7,
    requestId: 'open-1',
  };
  expect(await execute('fusion_project_sources', args)).toMatchObject({ ok: false });
  expect(source.prepareOpen).not.toHaveBeenCalled();
  expect(await execute('fusion_project_sources', args, context)).toMatchObject({
    ok: true,
    recentSaved: true,
  });
  expect(source.prepareOpen).toHaveBeenCalledWith({
    sourceId: 'source',
    target: 'left',
    expectedRevision: 7,
    requestId: 'open-1',
    principal: context,
  });
  expect(source.commitOpen).toHaveBeenCalledWith(prepared);
  expect(edit).not.toHaveBeenCalled();
  expect(hardware).not.toHaveBeenCalled();
});

it('does not apply a prepared source if its command was aborted during the read', async () => {
  const { source, sources } = sourceStub(),
    controller = new AbortController(),
    { execute } = setup(sources);
  source.prepareOpen.mockImplementation(async () => {
    controller.abort();
    return {} as PreparedProjectOpen;
  });
  await expect(
    execute(
      'fusion_project_sources',
      {
        action: 'open',
        sourceId: 'source',
        target: 'both',
        expectedRevision: 7,
        requestId: 'open-2',
      },
      { ...context, signal: controller.signal },
    ),
  ).rejects.toThrow();
  expect(source.commitOpen).not.toHaveBeenCalled();
});

it('reports grant expiry and bounded source failures through the cached command alias', async () => {
  const { source, sources } = sourceStub(),
    { execute } = setup(sources);
  expect(
    await execute(
      'fusion_workspace_storage',
      { action: 'project-sources', sources: { action: 'list', rootId: 'root' } },
      context,
    ),
  ).toMatchObject({ ok: true, listing: { needsHumanGrant: true } });
  source.prepareOpen.mockRejectedValue(
    new ProjectSourcesError('needs-human-grant', 'Select the folder again'),
  );
  expect(
    await execute(
      'fusion_workspace_storage',
      {
        action: 'project-sources',
        sources: {
          action: 'open',
          sourceId: 'source',
          target: 'left',
          expectedRevision: 7,
          requestId: 'open-3',
        },
      },
      context,
    ),
  ).toMatchObject({ ok: false, code: 'needs-human-grant', needsHumanGrant: true });
  expect(
    await execute(
      'fusion_workspace_storage',
      { action: 'status', sources: { action: 'status' } },
      context,
    ),
  ).toMatchObject({ ok: false });
});

it('lets source storage retry run despite the failed hydration and describes local writes honestly', async () => {
  const { source, sources } = sourceStub(),
    { execute } = setup(sources);
  source.hydrate.mockRejectedValue(new Error('storage failed'));
  expect(await execute('fusion_project_sources', { action: 'retry' }, context)).toMatchObject({
    ok: true,
  });
  expect(source.retry).toHaveBeenCalledTimes(1);
  expect(source.hydrate).not.toHaveBeenCalled();
  expect(
    TOOL_DEFINITIONS.find((d) => d.name === 'fusion_project_sources')?.annotations.readOnlyHint,
  ).toBe(false);
});

it('shares human pending-open recovery with agents and blocks a second source open', async () => {
  const { source, sources } = sourceStub(),
    { adapter, execute, hardware } = setup(sources);
  let pending:
    | NonNullable<ReturnType<NonNullable<ToolAdapter['sourceOpen']>['status']>['pending']>
    | undefined = {
    sourceId: 'old-source',
    target: 'right',
    expectedRevision: 7,
    requestId: 'original-open',
  };
  const retry = vi.fn(async () => ({
    receipt: { commitId: 'original', revision: 8, result: {} },
    replayed: true,
    recentSaved: true,
  }));
  adapter.sourceOpen = {
    status: () => ({ busy: false, ...(pending ? { pending } : {}) }),
    retry,
    discard: () => {
      pending = undefined;
    },
  };
  expect(
    await execute(
      'fusion_project_sources',
      {
        action: 'open',
        sourceId: 'another-source',
        target: 'left',
        expectedRevision: 7,
        requestId: 'new-open',
      },
      context,
    ),
  ).toMatchObject({ ok: false });
  expect(source.prepareOpen).not.toHaveBeenCalled();
  expect(await execute('fusion_project_sources', { action: 'retry-open' }, context)).toMatchObject({
    ok: true,
    replayed: true,
  });
  expect(retry).toHaveBeenCalledTimes(1);
  expect(await execute('fusion_project_sources', { action: 'discard-open' })).toMatchObject({
    ok: false,
  });
  expect(pending).toBeDefined();
  expect(
    await execute(
      'fusion_workspace_storage',
      { action: 'project-sources', sources: { action: 'discard-open' } },
      context,
    ),
  ).toEqual({ ok: true, open: { busy: false } });
  expect(pending).toBeUndefined();
  expect(hardware).not.toHaveBeenCalled();
});
