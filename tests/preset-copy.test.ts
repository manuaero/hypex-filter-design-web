import { describe, expect, it, vi } from 'vitest';
import { copyPreset, copyPresetBetween } from '../src/domain/preset-copy';
import { defaultsHfdMeasurementOptions, useHfdNative } from '../src/domain/hfd-measurement';
import { loadProjectMicrophone } from '../src/domain/hfd-microphone';
import { newProject, type Channel, type Project } from '../src/domain/model';
import { createWorkspaceStore } from '../src/state/workspace';
import { assertWorkspaceWrite, type WorkspaceEnvelope } from '../src/state/persistence';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';

function varied(name = 'Project') {
  const project = newProject(name);
  project.presets.forEach((preset, p) => {
    preset.name = `Independent preset ${p}`;
    preset.eqEnabled = p === 1;
    preset.inputEq[0].gain = p + 1;
    preset.inputFir = { name: `Input ${p}`, enabled: p !== 0, taps: [p + 0.1, 0.5] };
    preset.firPlacement = p === 0 ? 'output' : 'input';
    preset.channels.forEach((channel, c) => {
      channel.name = `Driver ${p}/${c}`;
      channel.outputName = `Terminal ${p}/${c}`;
      channel.gain = p * 3 + c;
      channel.invert = (p + c) % 2 === 1;
      channel.muted = c === p;
      channel.delayUs = p * 100 + c * 7;
      channel.globalDelayUs = p * 500;
      channel.additionalGain = p + c / 10;
      channel.includeInSum = p !== c;
      channel.fir = { name: `Output ${p}/${c}`, enabled: c !== 1, taps: [p + 0.3, c + 0.2] };
      channel.filters.forEach((filter, i) => {
        filter.sourceId = `${p}/${c}/${i}`;
        filter.kind = i === 0 ? 'raw' : 'peak';
        filter.enabled = (p + c + i) % 3 !== 0;
        filter.frequency = 100 + p * 200 + c * 10 + i;
        filter.gain = p + c + i / 10;
        filter.coefficients = { b0: p + 0.25, b1: c / 100, b2: i / 100, f1: 0, f2: 0 };
      });
    });
  });
  return project;
}

const local = (channel: Channel) => ({
  id: channel.id,
  name: channel.name,
  outputName: channel.outputName,
  additionalGain: channel.additionalGain,
  linkedTo: channel.linkedTo,
  includeInSum: channel.includeInSum,
  identities: channel.filters.map(({ id, sourceId }) => ({ id, sourceId })),
});
const processing = (channel: Channel) => ({
  gain: channel.gain,
  invert: channel.invert,
  muted: channel.muted,
  delayUs: channel.delayUs,
  globalDelayUs: channel.globalDelayUs,
  fir: channel.fir,
  filters: channel.filters.map(({ id: _id, sourceId: _sourceId, ...parameters }) => parameters),
});

describe('native whole-preset processing scope', () => {
  it('copies downstream processing and placement while retaining destination EQ, input FIR, names and graph identities', () => {
    const project = varied(),
      before = structuredClone(project);
    project.presets[1].channels[2].linkedTo = 0;
    before.presets[1].channels[2].linkedTo = 0;
    copyPreset(project, 0, 1);
    const target = project.presets[1];
    expect(target.name).toBe(before.presets[1].name);
    expect(target.inputEq).toEqual(before.presets[1].inputEq);
    expect(target.eqEnabled).toBe(before.presets[1].eqEnabled);
    expect(target.inputFir).toEqual(before.presets[1].inputFir);
    expect(target.firPlacement).toBe('output');
    for (let c = 0; c < 3; c++) {
      expect(processing(target.channels[c])).toEqual(processing(before.presets[0].channels[c]));
      expect(local(target.channels[c])).toEqual(local(before.presets[1].channels[c]));
    }
    // Native bulk copy preserves links without immediately overwriting channel3
    // from destination channel1 when the two preset link layouts differ.
    expect(target.channels[2].gain).toBe(2);
    expect(target.channels[0].gain).toBe(0);
    expect(project.presets[0]).toEqual(before.presets[0]);
    expect(project.presets[2]).toEqual(before.presets[2]);
    target.channels[0].fir.taps[0] = 99;
    target.channels[0].filters[0].coefficients!.b0 = 99;
    expect(project.presets[0]).toEqual(before.presets[0]);
  });

  it('reloads original samples using destination Fs/crop rather than source processed response or options', () => {
    const project = newProject(),
      source = project.presets[0].channels[0],
      target = project.presets[1].channels[0];
    source.measurement = { name: 'Source.dat', sampleRate: 48000, impulse: [0, 1, 0] };
    useHfdNative(source, { localStart: 1, stopInclusive: 1, phaseStart: 1 });
    source.measurement!.magnitude!.fill(123);
    source.measurement!.hfdMagnitude!.linearMagnitude.fill(99);
    source.measurement!.hfdPhase!.phase.fill(45);
    target.hfdMeasurement = {
      ...defaultsHfdMeasurementOptions(96000),
      stopInclusive: 2,
      phaseStart: 0,
    };
    const options = structuredClone(target.hfdMeasurement),
      original = structuredClone(source);
    copyPreset(project, 0, 1);
    const copied = project.presets[1].channels[0];
    expect(copied.hfdMeasurement).toEqual(options);
    expect(copied.measurement!.sampleRate).toBe(96000);
    expect(copied.measurement!.impulse).toEqual([0, 1, 0]);
    expect(copied.measurement!.name).toBe('Source.dat');
    expect(copied.measurement!.magnitude![500]).toBeCloseTo(0, 12);
    const f = copied.measurement!.hfdPhase!.frequency[558];
    expect(copied.measurement!.hfdPhase!.phase[558]).toBeCloseTo((-360 * f) / 96000, 3);
    expect(copied.measurement!.impulse).not.toBe(source.measurement!.impulse);
    expect(project.presets[0].channels[0]).toEqual(original);
  });

  it('uses the destination project microphone while retaining both independent resources', () => {
    const source = newProject('Left'),
      target = newProject('Right');
    loadProjectMicrophone(source, '20 6\n20000 6', 'left.txt');
    loadProjectMicrophone(target, '20 12\n20000 12', 'right.txt');
    source.presets[0].channels[0].measurement = {
      name: 'Original.dat',
      sampleRate: 48000,
      impulse: [1, 0, 0],
    };
    target.presets[1].channels[0].hfdMeasurement = {
      ...defaultsHfdMeasurementOptions(96000),
      applyMicCorrection: true,
    };
    const beforeSource = structuredClone(source),
      resource = structuredClone(target.hfdCalibration);
    copyPresetBetween(source, 0, target, 1);
    // Recovered native correction includes the resource's FFT/sampler edges;
    // its low-band flat-response error is below 0.00005dB, not exactly zero.
    expect(target.presets[1].channels[0].measurement!.magnitude![558]).toBeCloseTo(-12, 4);
    expect(target.hfdCalibration).toEqual(resource);
    expect(source).toEqual(beforeSource);
  });

  it('activates destination input FIR placement while retaining that destination input resource', () => {
    const project = varied();
    project.presets[1].firPlacement = 'input';
    project.presets[2].firPlacement = 'output';
    const input = structuredClone(project.presets[2].inputFir);
    copyPreset(project, 1, 2);
    expect(project.presets[2].firPlacement).toBe('input');
    expect(project.presets[2].inputFir).toEqual(input);
    expect(project.presets[2].inputFir).not.toEqual(project.presets[1].inputFir);
    expect(project.presets[2].channels[0].fir).toEqual(project.presets[1].channels[0].fir);
  });

  it('copies an unloaded DAT reference without keeping the former active response', () => {
    const project = newProject();
    project.presets[0].channels[0].measurement = { name: 'Missing.dat', sampleRate: 48000 };
    const target = project.presets[1].channels[0];
    target.measurement = { name: 'Old.dat', sampleRate: 96000, impulse: [1, 0] };
    target.hfdMeasurement = defaultsHfdMeasurementOptions(96000);
    target.hfdMeasurement.localStart = 91;
    copyPreset(project, 0, 1);
    expect(project.presets[1].channels[0].measurement).toEqual({
      name: 'Missing.dat',
      sampleRate: 96000,
    });
    expect(project.presets[1].channels[0].hfdMeasurement!.localStart).toBe(91);
  });

  it('clears absent source IR, resets only local crop/phase, and retains unloaded native clock/shared/correction options', () => {
    const project = newProject(),
      target = project.presets[1].channels[0];
    target.hfdMeasurement = {
      ...defaultsHfdMeasurementOptions(96000),
      localStart: 120,
      stopInclusive: 500,
      phaseStart: 140,
      sharedStart: 111,
      sharedGroupId: 2,
      smoothBw: 0.03,
      smoothPostBw: 0.5,
      applyMicCorrection: true,
    };
    target.measurement = { name: 'Old.dat', sampleRate: 96000, impulse: [0, 1] };
    const expected = {
      ...target.hfdMeasurement,
      localStart: 0,
      stopInclusive: 65535,
      phaseStart: -1,
    };
    copyPreset(project, 0, 1);
    expect(project.presets[1].channels[0].measurement).toBeUndefined();
    expect(project.presets[1].channels[0].hfdMeasurement).toEqual(expected);
  });

  it('keeps legacy Browser mode and destination processing, without copying source processing metadata', () => {
    const project = newProject(),
      source = project.presets[0].channels[0],
      target = project.presets[1].channels[0];
    source.measurement = {
      name: 'Original.dat',
      sampleRate: 48000,
      impulse: [1, 0, 0],
      frequency: [100, 1000],
      magnitude: [99, 99],
      processing: { smoothingOctaves: 1, calibrationEnabled: false },
    };
    target.measurement = {
      name: 'Old.dat',
      sampleRate: 96000,
      impulse: [0, 1, 0],
      processing: {
        smoothingOctaves: 0,
        calibrationEnabled: false,
        calibration: {
          name: 'Independent',
          sampleRate: 96000,
          frequency: [100, 1000],
          magnitude: [6, 6],
        },
      },
    };
    const settings = structuredClone(target.measurement.processing);
    copyPreset(project, 0, 1);
    const copied = project.presets[1].channels[0];
    expect(copied.hfdMeasurement).toBeUndefined();
    expect(copied.measurement!.processing).toEqual(settings);
    expect(copied.measurement!.magnitude![0]).toBeCloseTo(0, 12);
    expect(copied.measurement!.sampleRate).toBe(96000);
  });

  it('uses archived original frequency data only as a Browser-mode extension', () => {
    const project = newProject();
    project.presets[0].channels[0].measurement = {
      name: 'Frequency.txt',
      sampleRate: 48000,
      frequency: [100, 1000],
      magnitude: [-20, -20],
      sourceSpectrum: { frequency: [100, 1000], magnitude: [-2, -3], phase: [10, 20] },
    };
    copyPreset(project, 0, 1);
    expect(project.presets[1].channels[0].measurement!.magnitude).toEqual([-2, -3]);
    expect(project.presets[1].channels[0].measurement!.phase).toEqual([10, 20]);
    expect(project.presets[1].channels[0].hfdMeasurement).toBeUndefined();
  });

  it('rejects unsupported native frequency-only reload after earlier channels were staged without partial mutation', () => {
    const project = varied();
    project.presets[0].channels[0].measurement = {
      name: 'Good.dat',
      sampleRate: 48000,
      impulse: [1, 0],
    };
    project.presets[0].channels[2].measurement = {
      name: 'Only.txt',
      sampleRate: 48000,
      frequency: [100],
      magnitude: [0],
    };
    project.presets[1].channels[2].hfdMeasurement = defaultsHfdMeasurementOptions();
    const before = structuredClone(project);
    expect(() => copyPreset(project, 0, 1)).toThrow(/original impulse samples/);
    expect(project).toEqual(before);
  });

  it('rejects invalid indices, malformed arrays, aliased slots and cyclic links before any destination assignment', () => {
    const project = varied(),
      before = structuredClone(project);
    for (const bad of [-1, 3, 0.5, NaN]) expect(() => copyPreset(project, bad, 1)).toThrow(/index/);
    expect(() => copyPreset(project, 0, 0)).toThrow(/different presets/);
    expect(project).toEqual(before);
    project.presets[0].channels[0].filters[1] = project.presets[0].channels[0].filters[0];
    const aliased = structuredClone(project);
    expect(() => copyPreset(project, 0, 1)).toThrow(/distinct identities/);
    expect(project).toEqual(aliased);
    const cyclic = newProject();
    cyclic.presets[1].channels[0].linkedTo = 1;
    cyclic.presets[1].channels[1].linkedTo = 0;
    const beforeCyclic = structuredClone(cyclic);
    expect(() => copyPreset(cyclic, 0, 1)).toThrow(/Cyclic/);
    expect(cyclic).toEqual(beforeCyclic);
    const malformed = newProject();
    malformed.presets[0].channels[2].filters.pop();
    const beforeMalformed = structuredClone(malformed);
    expect(() => copyPreset(malformed, 0, 1)).toThrow();
    expect(malformed).toEqual(beforeMalformed);
  });
});

async function workspace(documents = { left: varied('Left'), right: varied('Right') }) {
  let envelope: WorkspaceEnvelope = {
    version: 1,
    state: {
      documents,
      slot: 'left',
      preset: 0,
      channel: 0,
      filter: 0,
      linkedEdits: true,
      linkedControls: true,
      documentRevision: 0,
    },
  };
  const instance = createWorkspaceStore({
    read: async () => structuredClone(envelope),
    readLegacy: () => null,
    write: async (next, expected) => {
      assertWorkspaceWrite(envelope, expected, next);
      envelope = structuredClone(next);
    },
  });
  await instance.persistence.hydrate();
  return instance;
}

describe('shared UI and MCP preset copy integration', () => {
  it('copies each role from its own source and preserves mismatched links in one complete Undo/Redo entry', async () => {
    const documents = { left: varied('Left'), right: varied('Right') };
    documents.left.presets[1].channels[2].linkedTo = 0;
    documents.right.presets[0].channels[0].gain = -9;
    const { store, persistence } = await workspace(documents);
    const before = structuredClone(store.getState().documents);
    store.getState().copyPreset(1);
    expect(store.getState().documents.left.presets[1].channels[2].gain).toBe(2);
    expect(store.getState().documents.left.presets[1].channels[2].linkedTo).toBe(0);
    expect(store.getState().documents.right.presets[1].channels[0].gain).toBe(-9);
    expect(store.getState().past).toHaveLength(1);
    const after = structuredClone(store.getState().documents);
    store.getState().undo();
    expect(store.getState().documents).toEqual(before);
    store.getState().redo();
    expect(store.getState().documents).toEqual(after);
    await persistence.flush();
  });

  it('publishes neither role nor history when the peer rejects its native reload', async () => {
    const documents = { left: varied('Left'), right: varied('Right') };
    documents.right.presets[0].channels[2].measurement = {
      name: 'Frequency.txt',
      sampleRate: 48000,
      frequency: [100],
      magnitude: [0],
    };
    documents.right.presets[1].channels[2].hfdMeasurement = defaultsHfdMeasurementOptions();
    const { store, persistence } = await workspace(documents);
    const before = structuredClone(store.getState().documents),
      revision = store.getState().documentRevision;
    expect(() => store.getState().copyPreset(1)).toThrow(/original impulse samples/);
    expect(store.getState().documents).toEqual(before);
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().documentRevision).toBe(revision);
    await persistence.flush();
  });

  it('routes MCP cross-role whole-preset copy through the same scope and explicitly bypasses ordinary link propagation', async () => {
    const documents = { left: varied('Left'), right: varied('Right') };
    documents.right.presets[2].channels[2].linkedTo = 0;
    const { store, persistence } = await workspace(documents),
      edit = vi.fn((slots, change, options) => store.getState().editAt(slots, change, options));
    const before = structuredClone(store.getState().documents);
    const adapter = {
      state: () => store.getState(),
      edit,
      choose: store.getState().choose,
      undo: store.getState().undo,
      redo: store.getState().redo,
      connections: () => ({}),
      message: vi.fn(),
      progress: vi.fn(),
    } as unknown as ToolAdapter;
    const execute = createToolExecutor(adapter);
    expect(
      await execute('fusion_copy', { from: 'left', to: 'right', preset: 1, destinationPreset: 3 }),
    ).toMatchObject({ ok: true });
    expect(edit.mock.calls[0][2]).toEqual({ synchronizeLinks: false });
    const actual = store.getState().documents.right.presets[2],
      expected = structuredClone(before.right);
    copyPresetBetween(before.left, 0, expected, 2);
    expect(actual).toEqual(expected.presets[2]);
    expect(store.getState().documents.left).toEqual(before.left);
    expect(actual.channels[2].gain).toBe(2);
    expect(actual.channels[2].linkedTo).toBe(0);
    await execute('fusion_history', { action: 'undo' });
    expect(store.getState().documents).toEqual(before);
    await persistence.flush();
  });
});
