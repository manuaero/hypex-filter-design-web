import { describe, expect, it } from 'vitest';
import { newProject, type Project } from '../src/domain/model';
import {
  loadProjectMicrophone,
  unloadProjectMicrophone,
  setProjectMicrophoneOptions,
  inheritRememberedHfdCalibration,
  inheritProjectMicrophone,
  projectMicrophoneStatus,
} from '../src/domain/hfd-microphone';
import {
  defaultsHfdMeasurementOptions,
  importChannelMeasurement,
  reconcileProjectHfdCalibration,
} from '../src/domain/hfd-measurement';
import { createWorkspaceStore } from '../src/state/workspace';
import type { WorkspaceEnvelope, WorkspacePersistenceBackend } from '../src/state/persistence';

const correction = '* header\n10 6\n100000 6\n';
function nativeProject() {
  const project = newProject('Native resource context');
  for (const [i, c] of project.presets[0].channels.entries()) {
    c.hfdMeasurement = {
      ...defaultsHfdMeasurementOptions([48000, 96000, 44100][i]),
      applyMicCorrection: i !== 1,
    };
    c.measurement = {
      name: `Driver${i}.dat`,
      sampleRate: c.hfdMeasurement.sampleRate,
      impulse: [1, 0],
    };
  }
  return project;
}
function memory() {
  let value: WorkspaceEnvelope | null = null;
  const backend: WorkspacePersistenceBackend = {
    read: async () => structuredClone(value),
    write: async (next) => {
      value = structuredClone(next);
    },
    readLegacy: () => null,
  };
  return backend;
}

describe('native project microphone ownership', () => {
  it('applies a shared resource at each native sample rate while leaving channel application flags independent', () => {
    const project = nativeProject();
    loadProjectMicrophone(project, correction, 'mic.txt');
    for (const [i, c] of project.presets[0].channels.entries()) {
      expect(c.hfdMeasurement?.applyMicCorrection).toBe(i !== 1);
      expect(c.measurement?.hfdMagnitude?.linearMagnitude[512]).toBeCloseTo(
        i === 1 ? 1 : 10 ** (-6 / 20),
        5,
      );
    }
    const before = structuredClone(project.presets);
    setProjectMicrophoneOptions(project, { showCurve: true });
    expect(project.presets).toEqual(before);
    expect(projectMicrophoneStatus(project)).toMatchObject({
      available: true,
      showCurve: true,
      points: 2,
    });
    unloadProjectMicrophone(project);
    expect(project.hfdCalibration?.resource).toBeUndefined();
    for (const c of project.presets[0].channels)
      expect(c.measurement?.hfdMagnitude?.linearMagnitude[512]).toBeCloseTo(1, 5);
  });

  it('keeps load/options failures atomic and leaves marker-free browser responses unchanged', () => {
    const project = nativeProject();
    project.presets[1].channels[0].measurement = {
      name: 'Archived browser response',
      sampleRate: 48000,
      frequency: [100, 1000],
      magnitude: [7, -3],
      phase: [123, -87],
    };
    const legacy = structuredClone(project.presets[1].channels[0]);
    loadProjectMicrophone(project, correction, 'mic.txt');
    expect(project.presets[1].channels[0]).toEqual(legacy);
    const before = structuredClone(project);
    expect(() => loadProjectMicrophone(project, 'not valid', 'bad.txt')).toThrow();
    expect(project).toEqual(before);
    expect(() => setProjectMicrophoneOptions(project, { smoothingOctaves: -1 })).toThrow();
    expect(project).toEqual(before);
    project.presets[0].channels[2].hfdMeasurement!.sampleRate = 0;
    const invalidBefore = structuredClone(project);
    expect(() => loadProjectMicrophone(project, correction, 'other.txt')).toThrow();
    expect(project).toEqual(invalidBefore);
  });

  it('retains the project resource through Clear and applies it again after native IR replacement', () => {
    const project = nativeProject();
    loadProjectMicrophone(project, correction, 'mic.txt');
    const resource = structuredClone(project.hfdCalibration);
    const c = project.presets[0].channels[0];
    delete c.measurement;
    reconcileProjectHfdCalibration(project);
    expect(project.hfdCalibration).toEqual(resource);
    importChannelMeasurement(
      c,
      { name: 'Replacement.dat', sampleRate: 48000, impulse: [2, 0] },
      'hfd',
    );
    reconcileProjectHfdCalibration(project);
    expect(
      project.presets[0].channels[0].measurement?.hfdMagnitude?.linearMagnitude[512],
    ).toBeCloseTo(2 * 10 ** (-6 / 20), 5);
    expect(project.hfdCalibration).toEqual(resource);
  });

  it('seeds startup from a detached remembered resource without overriding an explicit selection', () => {
    const source = newProject();
    loadProjectMicrophone(source, correction, 'mic.txt');
    setProjectMicrophoneOptions(source, { showCurve: true });
    const remembered = source.hfdCalibration!;
    const created = inheritRememberedHfdCalibration(newProject(), remembered);
    expect(created.hfdCalibration).toEqual({ ...remembered, showCurve: false });
    expect(created.hfdCalibration?.resource).not.toBe(remembered.resource);
    const imported = newProject();
    imported.hfdCalibration = { filename: 'missing.txt', loaded: true, showCurve: false };
    const before = structuredClone(imported);
    inheritRememberedHfdCalibration(imported, remembered);
    expect(imported).toEqual(before);
  });

  it('makes New inherit the current loaded project and never borrow an unrelated remembered selection', () => {
    const rememberedProject = newProject();
    loadProjectMicrophone(rememberedProject, correction, 'remembered.txt');
    const current = newProject();
    loadProjectMicrophone(current, correction.replaceAll(' 6', ' 12'), 'current.txt');
    const created = inheritProjectMicrophone(newProject(), current);
    expect(created.hfdCalibration?.filename).toBe('current.txt');
    expect(created.hfdCalibration?.resource?.curve.magnitude).toEqual([12, 12]);
    expect(rememberedProject.hfdCalibration?.filename).toBe('remembered.txt');
    unloadProjectMicrophone(current);
    expect(inheritProjectMicrophone(newProject(), current).hfdCalibration).toBeUndefined();
    current.hfdCalibration = { filename: 'missing.txt', loaded: true, showCurve: false };
    expect(inheritProjectMicrophone(newProject(), current).hfdCalibration).toBeUndefined();
  });

  it('reconciles stereo workspace edits and durably remembers a detached optional resource', async () => {
    const backend = memory();
    const workspace = createWorkspaceStore(backend);
    expect(() => workspace.store.getState().rememberHfdCalibration(undefined)).toThrow(
      'finish loading',
    );
    await workspace.persistence.hydrate();
    workspace.store.getState().editAt(['left', 'right'], (doc) => {
      Object.assign(doc, nativeProject());
      loadProjectMicrophone(doc, correction, 'mic.txt');
    });
    const input = structuredClone(workspace.store.getState().documents.left.hfdCalibration!);
    workspace.store.getState().rememberHfdCalibration(input);
    input.resource!.curve.magnitude[0] = 123;
    expect(workspace.store.getState().rememberedHfdCalibration?.resource?.curve.magnitude[0]).toBe(
      6,
    );
    workspace.store.getState().editAt(['left', 'right'], (doc) => {
      doc.presets[0].channels[0].measurement!.impulse![0] = 2;
    });
    for (const doc of Object.values(workspace.store.getState().documents))
      expect(
        doc.presets[0].channels[0].measurement?.hfdMagnitude?.linearMagnitude[512],
      ).toBeCloseTo(2 * 10 ** (-6 / 20), 5);
    await workspace.persistence.flush();
    const reload = createWorkspaceStore(backend);
    await reload.persistence.hydrate();
    expect(reload.store.getState().rememberedHfdCalibration).toEqual(
      workspace.store.getState().rememberedHfdCalibration,
    );
    expect(reload.store.getState().documents).toEqual(workspace.store.getState().documents);
    const imported = newProject('Do not inherit');
    reload.store.getState().replace(imported);
    expect(reload.store.getState().documents.left.hfdCalibration).toBeUndefined();
    reload.store.getState().rememberHfdCalibration(null);
    await reload.persistence.flush();
    const cleared = createWorkspaceStore(backend);
    await cleared.persistence.hydrate();
    expect(cleared.store.getState().rememberedHfdCalibration).toBeUndefined();
  });
});
