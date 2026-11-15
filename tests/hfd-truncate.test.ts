// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  newProject,
  HFD_INDEX_MIN,
  HFD_INDEX_MAX,
  type Project,
  type Slot,
} from '../src/domain/model';
import { truncateHfdVisibleRange } from '../src/domain/hfd-truncate';
import {
  useHfdNative,
  updateHfdMeasurement,
  setSharedHfdCrop,
  validateHfdMeasurementOptions,
} from '../src/domain/hfd-measurement';
import { analyzeTimeResponses } from '../src/domain/time-analysis';
import { parseProject, exportHfd } from '../src/domain/files';
import { createWorkspaceStore } from '../src/state/workspace';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';

function fixture(sampleRate = 48000): Project {
  const project = newProject('Native original-index truncate');
  project.presets[0].channels.forEach((channel, index) => {
    channel.measurement = {
      name: `Original${index}`,
      sampleRate,
      impulse: Array.from({ length: 64 }, (_, i) => (i === index + 2 ? 1 : 0)),
    };
    useHfdNative(channel, {
      sampleRate,
      localStart: 5 + index,
      stopInclusive: 63,
      phaseStart: 9 + index,
    });
  });
  return project;
}
describe('native visible-range Truncate', () => {
  it('truncates signed original-time samples toward zero, retaining phase/originals/processing and independent presets', () => {
    const project = fixture(),
      before = structuredClone(project),
      channel = project.presets[0].channels[0];
    expect(
      truncateHfdVisibleRange(project, 0, 0, { timeMinMs: -0.031, timeMaxMs: 0.123 }),
    ).toMatchObject({
      sampleRate: 48000,
      localStart: -1,
      stopInclusive: 5,
      effectiveStart: -1,
      sharedAction: 'none',
    });
    expect(channel.hfdMeasurement!.phaseStart).toBe(9);
    const updated = project.presets[0].channels[0];
    expect(updated.measurement!.impulse).toEqual(
      before.presets[0].channels[0].measurement!.impulse,
    );
    expect(updated.filters).toEqual(before.presets[0].channels[0].filters);
    expect(project.presets.slice(1)).toEqual(before.presets.slice(1));
    expect(project.presets[0].channels.slice(1)).toEqual(before.presets[0].channels.slice(1));
  });

  it('retains a checked source effective snapshot but unshares all outputs when truncating an unchecked follower', () => {
    const project = fixture(),
      preset = project.presets[0];
    updateHfdMeasurement(preset.channels[0], { localStart: -5 });
    setSharedHfdCrop(preset, 0);
    expect(truncateHfdVisibleRange(project, 0, 0, { timeMinMs: 1, timeMaxMs: 2 })).toMatchObject({
      localStart: 48,
      stopInclusive: 96,
      effectiveStart: -5,
      sharedAction: 'retained-source',
    });
    expect(preset.channels.map((channel) => channel.hfdMeasurement!.sharedStart)).toEqual([
      -5, -5, -5,
    ]);
    expect(
      truncateHfdVisibleRange(project, 0, 1, { timeMinMs: -0.1, timeMaxMs: 0.2 }),
    ).toMatchObject({
      localStart: -4,
      stopInclusive: 9,
      effectiveStart: -4,
      sharedAction: 'cleared',
    });
    expect(
      preset.channels.map((channel) => [
        channel.hfdMeasurement!.sharedGroupId,
        channel.hfdMeasurement!.sharedStart,
      ]),
    ).toEqual([
      [-1, -1],
      [-1, -1],
      [-1, -1],
    ]);
    expect(preset.channels.map((channel) => channel.hfdMeasurement!.localStart)).toEqual([
      48, -4, 7,
    ]);
  });

  it('accepts signedint32 crop/phase/shared snapshots without expanding allocations or scanning negative indices', () => {
    const project = fixture(),
      channel = project.presets[0].channels[0];
    updateHfdMeasurement(channel, { localStart: 0, stopInclusive: 65535, phaseStart: 0 });
    const magnitude = channel.measurement!.magnitude!.slice();
    const expected = analyzeTimeResponses([channel], { measured: true, sum: false }).channels[0]
      .impulse!;
    updateHfdMeasurement(channel, {
      localStart: HFD_INDEX_MIN,
      stopInclusive: HFD_INDEX_MAX,
      phaseStart: HFD_INDEX_MIN,
      sharedStart: HFD_INDEX_MIN,
      sharedGroupId: 1,
    });
    expect(channel.measurement!.magnitude).toEqual(magnitude);
    const actual = analyzeTimeResponses([channel], { measured: true, sum: false }).channels[0]
      .impulse!;
    expect(actual.samples.length).toBe(65536);
    expect(Array.from(actual.samples)).toEqual(Array.from(expected.samples));
    updateHfdMeasurement(channel, { stopInclusive: HFD_INDEX_MIN });
    const empty = analyzeTimeResponses([channel], { measured: true, sum: false }).channels[0]
      .impulse!;
    expect(empty.samples.length).toBe(4);
    expect(Array.from(empty.samples)).toEqual([0, 0, 0, 0]);
    for (const patch of [
      { localStart: HFD_INDEX_MIN - 1 },
      { stopInclusive: HFD_INDEX_MAX + 1 },
      { sharedStart: 0.1 },
    ])
      expect(() =>
        validateHfdMeasurementOptions({ ...channel.hfdMeasurement!, ...patch }),
      ).toThrow();
  });

  it('round-trips signed original indices in JSON/native XML while keeping group−1 as the independent sharing sentinel', () => {
    const project = fixture(),
      channel = project.presets[0].channels[0];
    updateHfdMeasurement(channel, {
      localStart: HFD_INDEX_MIN,
      stopInclusive: -2,
      phaseStart: -12,
      sharedStart: -1,
      sharedGroupId: 1,
    });
    expect(parseProject(JSON.stringify(project)).presets[0].channels[0].hfdMeasurement).toEqual(
      channel.hfdMeasurement,
    );
    expect(parseProject(exportHfd(project)).presets[0].channels[0].hfdMeasurement).toEqual(
      channel.hfdMeasurement,
    );
    const snapshot = structuredClone(project);
    for (const range of [
      { timeMinMs: 1, timeMaxMs: 1 },
      { timeMinMs: NaN, timeMaxMs: 2 },
      { timeMinMs: -1e20, timeMaxMs: 0 },
    ]) {
      expect(() => truncateHfdVisibleRange(project, 0, 0, range)).toThrow();
      expect(project).toEqual(snapshot);
    }
    expect(() => truncateHfdVisibleRange(project, 1, 0, { timeMinMs: 0, timeMaxMs: 1 })).toThrow(
      'requires HFD',
    );
  });
});

describe('same visible-view operation through cached MCP processing', () => {
  async function setup() {
    let durable: unknown = {
      version: 1,
      state: {
        documents: { left: fixture(48000), right: fixture(96000) },
        slot: 'right',
        preset: 2,
        channel: 2,
        filter: 0,
        linkedEdits: false,
        linkedControls: true,
        documentRevision: 0,
      },
    };
    const workspace = createWorkspaceStore({
      read: async () => structuredClone(durable),
      write: async (next) => {
        durable = structuredClone(next);
      },
      readLegacy: () => null,
    });
    await workspace.persistence.hydrate();
    let view: unknown = {
      tab: 'Crossover',
      mode: 'Impulse',
      measured: true,
      timeMinMs: -0.15,
      timeMaxMs: 0.35,
    };
    const readView = vi.fn(() => view),
      hardware = vi.fn(() => {
        throw new Error('Truncate cannot call hardware');
      });
    const adapter: ToolAdapter = {
      state: workspace.store.getState,
      edit: (slots, change) => workspace.store.getState().editAt(slots, change),
      choose: (patch) => workspace.store.getState().choose(patch),
      undo: () => workspace.store.getState().undo(),
      redo: () => workspace.store.getState().redo(),
      connections: hardware,
      connect: async () => hardware(),
      disconnect: async () => hardware(),
      refresh: async () => hardware(),
      operate: async (_label, fn) => fn(),
      message: vi.fn(),
      progress: hardware,
      view: vi.fn(),
      viewState: readView,
    };
    return {
      workspace,
      hardware,
      readView,
      setView: (next: unknown) => {
        view = next;
      },
      execute: createToolExecutor(adapter),
    };
  }
  it('uses the current visible range once for explicit both-role destinations, per-role rates and one exact Undo', async () => {
    const s = await setup(),
      before = structuredClone(s.workspace.store.getState().documents);
    const result = (await s.execute('fusion_measurement_processing', {
      target: 'both',
      preset: 1,
      channel: 1,
      truncateToView: true,
    })) as { ok: boolean; range: unknown };
    expect(result.ok).toBe(true);
    expect(s.readView).toHaveBeenCalledTimes(1);
    expect(result.range).toEqual({ timeMinMs: -0.15, timeMaxMs: 0.35 });
    const documents = s.workspace.store.getState().documents;
    expect(documents.left.presets[0].channels[0].hfdMeasurement).toMatchObject({
      localStart: -7,
      stopInclusive: 16,
      phaseStart: 9,
    });
    expect(documents.right.presets[0].channels[0].hfdMeasurement).toMatchObject({
      localStart: -14,
      stopInclusive: 33,
      phaseStart: 9,
    });
    expect(documents.left.presets[1]).toEqual(before.left.presets[1]);
    expect(documents.right.presets[0].channels[1]).toEqual(before.right.presets[0].channels[1]);
    await s.workspace.persistence.flush();
    s.workspace.store.getState().undo();
    expect(s.workspace.store.getState().documents).toEqual(before);
    expect(s.hardware).not.toHaveBeenCalled();
  });
  it('rejects hidden/mixed flags, invalid context and unsupported peer before publishing either document', async () => {
    const s = await setup(),
      before = structuredClone(s.workspace.store.getState().documents),
      base = { target: 'both', preset: 1, channel: 1, truncateToView: true };
    for (const patch of [
      { reset: false },
      { sampleRate: 48000 },
      { audio: { action: 'status' } },
      { timeMinMs: 0 },
      { truncateToView: false },
    ])
      expect(
        (
          (await s.execute('fusion_measurement_processing', { ...base, ...patch })) as {
            ok: boolean;
          }
        ).ok,
      ).toBe(false);
    expect(s.readView).not.toHaveBeenCalled();
    s.setView({ tab: 'Crossover', mode: 'Magnitude', measured: true, timeMinMs: 0, timeMaxMs: 1 });
    expect(((await s.execute('fusion_measurement_processing', base)) as { ok: boolean }).ok).toBe(
      false,
    );
    expect(s.workspace.store.getState().documents).toEqual(before);
    s.setView({ tab: 'Crossover', mode: 'Step', measured: true, timeMinMs: 0, timeMaxMs: 1 });
    s.workspace.store.getState().editAt(['right'], (project) => {
      delete project.presets[0].channels[0].hfdMeasurement;
    });
    const peer = structuredClone(s.workspace.store.getState().documents);
    expect(((await s.execute('fusion_measurement_processing', base)) as { ok: boolean }).ok).toBe(
      false,
    );
    expect(s.workspace.store.getState().documents).toEqual(peer);
    expect(s.hardware).not.toHaveBeenCalled();
  });
});
