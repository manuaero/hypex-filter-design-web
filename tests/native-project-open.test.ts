import { expect, it } from 'vitest';
import { newProject } from '../src/domain/model';
import { defaultHfdMeasurementOptions } from '../src/domain/hfd-measurement';
import {
  applyNativeProjectOpen,
  planNativeProjectOpen,
  prepareNativeProjectOpen,
  validateNativeProjectOpen,
} from '../src/application/native-project-open';
import { createNativeGraphEntryController } from '../src/application/native-graph-entry';
import { createWorkspaceStore } from '../src/state/workspace';
import { loadProjectMicrophone } from '../src/domain/hfd-microphone';
import {
  processChannelMeasurement,
  reconcileProjectHfdCalibration,
  recomputeHfdMeasurement,
} from '../src/domain/hfd-measurement';

function fixture() {
  const project = newProject('Native input');
  project.hfdSelectedPreset = 3;
  project.hfdSelectedGroupId = 2;
  project.hfdCalibration = { filename: '', loaded: false, showCurve: false };
  project.hfdGainLowered = false;
  for (const [p, preset] of project.presets.entries())
    for (const [c, channel] of preset.channels.entries()) {
      channel.gain = p * 3 + c;
      channel.coefficientCache = 'effective';
      channel.hfdMeasurement = { ...defaultHfdMeasurementOptions(), applyMicCorrection: false };
      channel.filters[0].coefficients = { b0: 1, b1: (p * 3 + c) / 100, b2: 0, f1: 0, f2: 0 };
      channel.filters[0].provenance = 'hfd';
    }
  project.presets[0].channels[1].gain = 24;
  project.presets[0].channels[1].additionalGain = 10;
  return project;
}

it('V51 dialog native load chooses supplied offline P1, preserves group2 and rebinds only unopened current-preset microphones', () => {
  const project = fixture(),
    before = structuredClone(project);
  const plan = planNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'dialog' });
  expect(project).toEqual(before);
  expect(plan).toMatchObject({ slot: 'left', presetIndex: 0, channelIndex: 1, changed: true });
  expect(plan.patch).toEqual({
    hfdSelectedPreset: 1,
    microphoneChanges: [
      { channelIndex: 0, channelId: project.presets[0].channels[0].id, applyMicCorrection: true },
      { channelIndex: 2, channelId: project.presets[0].channels[2].id, applyMicCorrection: true },
    ],
  });
  validateNativeProjectOpen(plan, project, 'left');
  const draft = structuredClone(project);
  applyNativeProjectOpen(draft, 'left', plan);
  const expected = structuredClone(before);
  expected.hfdSelectedPreset = 1;
  expected.presets[0].channels[0].hfdMeasurement!.applyMicCorrection = true;
  expected.presets[0].channels[2].hfdMeasurement!.applyMicCorrection = true;
  expect(draft).toEqual(expected);
  expect(draft.presets[0].channels[1]).toEqual(before.presets[0].channels[1]);
  expect(draft.hfdSelectedGroupId).toBe(2);
  expect(Object.isFrozen(plan.patch.microphoneChanges[0])).toBe(true);
});

it('V51 unknown777 keeps Gain24/Add10 and opens no arbitrary Graph while dialog binding owns all current-preset groups', () => {
  const project = fixture();
  project.hfdSelectedGroupId = 777;
  const before = structuredClone(project),
    plan = planNativeProjectOpen(project, 'right', { presetIndex: 0, route: 'dialog' });
  expect(plan.channelIndex).toBeNull();
  expect(plan.channelId).toBeUndefined();
  expect(plan.patch.microphoneChanges.map((change) => change.channelIndex)).toEqual([0, 1, 2]);
  const draft = structuredClone(project);
  applyNativeProjectOpen(draft, 'right', plan);
  expect(draft.hfdSelectedPreset).toBe(1);
  expect(draft.hfdSelectedGroupId).toBe(777);
  for (let p = 0; p < 3; p++)
    for (let c = 0; c < 3; c++) {
      const old = before.presets[p].channels[c],
        after = draft.presets[p].channels[c];
      expect(after).toEqual(
        p === 0
          ? { ...old, hfdMeasurement: { ...old.hfdMeasurement!, applyMicCorrection: true } }
          : old,
      );
    }
});

it('both accepted positive-group inputs converge to the same selected-Graph microphone result', () => {
  for (const initialSelectedMic of [true, false]) {
    const project = fixture();
    project.presets[0].channels[1].hfdMeasurement!.applyMicCorrection = initialSelectedMic;
    let state = {
      documents: { left: project, right: newProject('Other role') },
      documentRevision: 4,
    };
    const before = structuredClone(state.documents),
      entries = createNativeGraphEntryController({ current: () => state });
    const documentPlan = planNativeProjectOpen(project, 'left', {
      presetIndex: 0,
      route: 'dialog',
    });
    const graphPlan = entries.planNativeFileOpen(
      { slot: 'left', presetIndex: 0, channelIndex: 1 },
      'dialog',
    );
    entries.commit(graphPlan, (apply) => {
      const documents = structuredClone(state.documents);
      applyNativeProjectOpen(documents.left, 'left', documentPlan);
      apply(documents.left, 'left');
      state = { documents, documentRevision: 5 };
    });
    expect(
      state.documents.left.presets[0].channels.map(
        (channel) => channel.hfdMeasurement!.applyMicCorrection,
      ),
    ).toEqual([true, false, true]);
    expect(state.documents.left.presets[0].channels[1]).toMatchObject({
      gain: 14,
      additionalGain: 10,
    });
    expect(state.documents.left.hfdSelectedPreset).toBe(1);
    expect(state.documents.left.hfdSelectedGroupId).toBe(2);
    expect(state.documents.left.presets.slice(1)).toEqual(before.left.presets.slice(1));
    expect(state.documents.right).toEqual(before.right);
  }
});

it.each([undefined, 0, -2, 2147483647])(
  'unmapped saved group %s never manufactures a Graph target',
  (id) => {
    const project = fixture();
    project.hfdSelectedGroupId = id;
    const plan = planNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'inner' });
    expect(plan.channelIndex).toBeNull();
    expect(plan.patch.microphoneChanges).toEqual([]);
  },
);

it('native automatic group-1 means first channel and does not rewrite that metadata', () => {
  const project = fixture();
  project.hfdSelectedGroupId = -1;
  const plan = planNativeProjectOpen(project, 'left', { presetIndex: 2, route: 'inner' });
  expect(plan).toMatchObject({
    channelIndex: 0,
    channelId: project.presets[2].channels[0].id,
    changed: false,
  });
  const draft = structuredClone(project);
  applyNativeProjectOpen(draft, 'left', plan);
  expect(draft).toEqual(project);
  expect(draft.hfdSelectedGroupId).toBe(-1);
});

it.each([false, true, undefined])(
  'dialog unopened-group binding is independent of microphone Loaded %s',
  (loaded) => {
    const project = fixture();
    if (loaded === undefined) delete project.hfdCalibration;
    else project.hfdCalibration!.loaded = loaded;
    delete project.presets[0].channels[0].hfdMeasurement;
    const plan = planNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'dialog' });
    const draft = structuredClone(project);
    applyNativeProjectOpen(draft, 'left', plan);
    expect(draft.presets[0].channels[0].hfdMeasurement).toEqual({
      ...defaultHfdMeasurementOptions(),
      applyMicCorrection: true,
    });
    expect(draft.presets[0].channels[1].hfdMeasurement!.applyMicCorrection).toBe(false);
  },
);

it('inner routes normalize chosen preset metadata without the dialog-only microphone loop', () => {
  const project = fixture(),
    before = structuredClone(project);
  const plan = planNativeProjectOpen(project, 'left', { presetIndex: 1, route: 'inner' });
  const draft = structuredClone(project);
  applyNativeProjectOpen(draft, 'left', plan);
  expect(draft).toEqual({ ...before, hfdSelectedPreset: 2 });
  expect(plan.patch.microphoneChanges).toEqual([]);
});

it('already-normalized dialog document plans remain canonical no-ops', () => {
  const project = fixture();
  project.hfdSelectedPreset = 1;
  project.presets[0].channels.forEach((channel) => {
    channel.hfdMeasurement!.applyMicCorrection = true;
  });
  const plan = planNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'dialog' });
  expect(plan.changed).toBe(false);
  const draft = structuredClone(project);
  applyNativeProjectOpen(draft, 'left', plan);
  expect(draft).toEqual(project);
});

it('role, same-ID replacement, original-object and provenance drift all refuse before application', () => {
  const project = fixture(),
    plan = planNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'dialog' });
  expect(() => validateNativeProjectOpen(plan, structuredClone(project), 'left')).toThrow(
    /changed|role/,
  );
  expect(() => validateNativeProjectOpen(plan, project, 'right')).toThrow(/changed|role/);
  expect(() => applyNativeProjectOpen(project, 'left', plan)).toThrow(/detached/);
  const draft = structuredClone(project),
    before = structuredClone(draft);
  expect(() => applyNativeProjectOpen(draft, 'right', plan)).toThrow(/role|detached/);
  expect(draft).toEqual(before);
  draft.presets[0].channels[0].filters[0].provenance = 'panel';
  const changed = structuredClone(draft);
  expect(() => applyNativeProjectOpen(draft, 'left', plan)).toThrow(/detached/);
  expect(draft).toEqual(changed);
  project.presets[0].channels[0].gain++;
  expect(() => validateNativeProjectOpen(plan, project, 'left')).toThrow(/changed/);
});

it('forged plans and caller-supplied selection or capability fields do not grant admission', () => {
  const project = fixture(),
    plan = planNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'dialog' });
  expect(() => applyNativeProjectOpen(structuredClone(project), 'left', { ...plan })).toThrow(
    /detached/,
  );
  for (const request of [
    { presetIndex: 3, route: 'dialog' },
    { presetIndex: 0, route: 'mru' },
    { presetIndex: 0, route: 'dialog', eligible: true },
    { presetIndex: 0, route: 'dialog', channelIndex: 2 },
  ])
    expect(() => planNativeProjectOpen(project, 'left', request as never)).toThrow(/request/);
});

it('two independently chosen role presets compose with constructor plans in one real workspace Undo', async () => {
  let saved: unknown = null;
  const store = createWorkspaceStore({
    read: async () => saved,
    write: async (value) => {
      saved = structuredClone(value);
    },
    readLegacy: () => null,
  });
  await store.persistence.hydrate();
  const documents = { left: fixture(), right: fixture() };
  documents.right.hfdSelectedPreset = 1;
  documents.right.presets[2].channels[1].gain = -3.25;
  documents.right.presets[2].channels[1].additionalGain = 6;
  store.store.setState({ documents, past: [], future: [], gesture: undefined });
  const current = store.store.getState,
    entries = createNativeGraphEntryController({ current }),
    before = structuredClone(current().documents);
  const docPlans = {
    left: planNativeProjectOpen(current().documents.left, 'left', {
      presetIndex: 0,
      route: 'dialog',
    }),
    right: planNativeProjectOpen(current().documents.right, 'right', {
      presetIndex: 2,
      route: 'dialog',
    }),
  };
  const graphPlans = {
    left: entries.planNativeFileOpen({ slot: 'left', presetIndex: 0, channelIndex: 1 }, 'dialog'),
    right: entries.planNativeFileOpen({ slot: 'right', presetIndex: 2, channelIndex: 1 }, 'dialog'),
  };
  for (const slot of ['left', 'right'] as const)
    validateNativeProjectOpen(docPlans[slot], current().documents[slot], slot);
  entries.commit(graphPlans.left, (leftApply) =>
    entries.commit(graphPlans.right, (rightApply) => {
      current().editAt(
        ['left', 'right'],
        (project, slot) => {
          applyNativeProjectOpen(project, slot, docPlans[slot]);
          (slot === 'left' ? leftApply : rightApply)(project, slot);
        },
        { synchronizeLinks: false },
      );
    }),
  );
  const after = structuredClone(current().documents);
  expect(after.left.hfdSelectedPreset).toBe(1);
  expect(after.right.hfdSelectedPreset).toBe(3);
  expect(after.left.presets[0].channels[1].gain).toBe(14);
  expect(after.right.presets[2].channels[1]).toMatchObject({ gain: -3.25, additionalGain: 10 });
  expect(
    after.left.presets[0].channels.map((channel) => channel.hfdMeasurement!.applyMicCorrection),
  ).toEqual([true, false, true]);
  expect(
    after.right.presets[2].channels.map((channel) => channel.hfdMeasurement!.applyMicCorrection),
  ).toEqual([true, false, true]);
  for (const slot of ['left', 'right'] as const)
    for (let p = 0; p < 3; p++)
      for (let c = 0; c < 3; c++)
        expect(after[slot].presets[p].channels[c].filters).toEqual(
          before[slot].presets[p].channels[c].filters,
        );
  expect(current().past).toHaveLength(1);
  current().undo();
  expect(current().documents).toEqual(before);
  expect(() =>
    entries.planNativeFileOpen({ slot: 'left', presetIndex: 0, channelIndex: 1 }, 'dialog'),
  ).toThrow(/fresh|generation/);
  current().redo();
  expect(current().documents).toEqual(after);
  await store.persistence.flush();
});

it('cold preparation returns the complete native document before any authoritative replacement', () => {
  const project = fixture(),
    before = structuredClone(project);
  project.presets[0].channels[1].hfdGraph = { showMeasuredResponse: true, showSum: false };
  const imported = structuredClone(project),
    prepared = prepareNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'dialog' });
  expect(project).toEqual(imported);
  expect(prepared.selection).toEqual({
    presetIndex: 0,
    channelIndex: 1,
    channelId: project.presets[0].channels[1].id,
  });
  expect(prepared.project).not.toBe(project);
  expect(prepared.project.hfdSelectedPreset).toBe(1);
  expect(prepared.project.hfdSelectedGroupId).toBe(2);
  expect(prepared.project.hfdGainLowered).toBe(true);
  expect(prepared.project.presets[0].channels[1]).toMatchObject({
    gain: 14,
    additionalGain: 10,
    hfdGraph: { showMeasuredResponse: false, showSum: false },
  });
  expect(
    prepared.project.presets[0].channels.map(
      (channel) => channel.hfdMeasurement!.applyMicCorrection,
    ),
  ).toEqual([true, false, true]);
  expect(prepared.project.presets.slice(1)).toEqual(before.presets.slice(1));
  const current = () => ({
    documents: { left: prepared.project, right: newProject('Peer') },
    documentRevision: 1,
  });
  const state = current(),
    controller = createNativeGraphEntryController({ current: () => state });
  const entry = controller.planNativeFileOpen(
    {
      slot: 'left',
      presetIndex: prepared.selection!.presetIndex,
      channelIndex: prepared.selection!.channelIndex,
    },
    'dialog',
  );
  expect(entry.changed).toBe(false);
  controller.commit(entry, () => {});
  expect(state.documents.left).toBe(prepared.project);
});

it('cold unknown-group preparation stores only qualified load effects and returns no Graph selection', () => {
  const project = fixture();
  project.hfdSelectedGroupId = 777;
  const before = structuredClone(project),
    prepared = prepareNativeProjectOpen(project, 'right', { presetIndex: 0, route: 'dialog' });
  expect(project).toEqual(before);
  expect(prepared.selection).toBeNull();
  expect(prepared.project.hfdSelectedGroupId).toBe(777);
  expect(prepared.project.presets[0].channels[1]).toMatchObject({ gain: 24, additionalGain: 10 });
  expect(
    prepared.project.presets[0].channels.map(
      (channel) => channel.hfdMeasurement!.applyMicCorrection,
    ),
  ).toEqual([true, true, true]);
});

it('cold preparation rebuilds changed native IR caches against the shared loaded calibration before returning', () => {
  const project = fixture();
  for (const channel of [...project.presets[0].channels, project.presets[1].channels[0]]) {
    channel.measurement = { name: 'Owned impulse', sampleRate: 48000, impulse: [1, 0] };
  }
  project.presets[1].channels[0].hfdMeasurement!.applyMicCorrection = true;
  project.presets[0].channels[1].hfdGraph = { showMeasuredResponse: true, showSum: false };
  loadProjectMicrophone(project, '10 6\n100000 6\n', 'mic.txt');
  const before = structuredClone(project),
    prepared = prepareNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'dialog' });
  expect(project).toEqual(before);
  for (const channel of prepared.project.presets[0].channels) {
    expect(channel.hfdMeasurement!.applyMicCorrection).toBe(true);
    expect(channel.measurement!.hfdMagnitude!.linearMagnitude[512]).toBeCloseTo(10 ** (-6 / 20), 5);
    expect(channel.measurement!.hfdPhase).toBeDefined();
  }
  expect(prepared.project.presets[1].channels[0]).toEqual(before.presets[1].channels[0]);
  expect(prepared.project.presets[0].channels[1].hfdGraph!.showMeasuredResponse).toBe(true);
  expect(prepared.project.hfdCalibration).toEqual(before.hfdCalibration);
});

it.each([true, false])(
  'cold preparation respects explicit project calibration ownership %s versus absent legacy ownership',
  (explicit) => {
    const project = fixture();
    project.hfdSelectedGroupId = 777;
    delete project.hfdCalibration;
    const channel = project.presets[0].channels[0];
    channel.measurement = { name: 'Legacy IR', sampleRate: 48000, impulse: [1, 0] };
    recomputeHfdMeasurement(channel);
    processChannelMeasurement(channel, {
      calibration: {
        name: 'Legacy curve',
        sampleRate: 48000,
        frequency: [10, 24000],
        magnitude: [12, 12],
        phase: [0, 0],
      },
      calibrationEnabled: false,
    });
    if (explicit) {
      project.hfdCalibration = { filename: '', loaded: false, showCurve: false };
      reconcileProjectHfdCalibration(project);
    }
    const before = structuredClone(project),
      prepared = prepareNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'dialog' });
    expect(project).toEqual(before);
    expect(
      prepared.project.presets[0].channels[0].measurement!.hfdMagnitude!.linearMagnitude[512],
    ).toBeCloseTo(explicit ? 1 : 10 ** (-12 / 20), 8);
    expect(prepared.project.presets[1]).toEqual(before.presets[1]);
  },
);

it('failed cold cache preflight cannot modify the imported document or return a partially normalized project', () => {
  const project = fixture();
  project.presets[0].channels[0].hfdMeasurement!.sampleRate = 0;
  const before = structuredClone(project);
  expect(() =>
    prepareNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'dialog' }),
  ).toThrow(/sample rate/);
  expect(project).toEqual(before);
});

it('an unresolved P1 link outside saved P3 is deactivated without copying or resolving its caches', () => {
  const project = fixture(),
    source = project.presets[0].channels[0],
    linked = project.presets[0].channels[1];
  source.gain = 0;
  source.filters[0].kind = 'peak';
  source.filters[0].gain = 7.5;
  source.filters[0].enabled = true;
  linked.linkedTo = 0;
  linked.additionalGain = 6;
  linked.coefficientCache = 'unresolved';
  const before = structuredClone(project),
    prepared = prepareNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'dialog' });
  expect(project).toEqual(before);
  expect(prepared.project.presets[0].channels[1]).toMatchObject({
    gain: 14,
    additionalGain: 10,
    coefficientCache: 'unresolved',
  });
  expect(prepared.project.presets[0].channels[1].linkedTo).toBeUndefined();
  for (let p = 0; p < 3; p++)
    for (let c = 0; c < 3; c++) {
      expect(prepared.project.presets[p].channels[c].filters).toEqual(
        before.presets[p].channels[c].filters,
      );
      expect(prepared.project.presets[p].channels[c].coefficientCache).toBe(
        before.presets[p].channels[c].coefficientCache,
      );
    }
  expect(prepared.project.presets[0].channels[0].gain).toBe(0);
});
