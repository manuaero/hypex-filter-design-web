import { expect, it, vi } from 'vitest';
import { createWorkspaceStore } from '../src/state/workspace';
import type { WorkspaceEnvelope } from '../src/state/persistence';
import { newProject, type Project, type Slot } from '../src/domain/model';

const actor = { owner: 'browser:local', scope: 'native-open:one' };
const result = { workflow: 'project', projectOpen: { kind: 'native-file-open', route: 'dialog' } };

function replace(destination: Project, incoming: Project) {
  for (const key of Object.keys(destination)) Reflect.deleteProperty(destination, key);
  Object.assign(destination, structuredClone(incoming));
}
async function setup() {
  let saved: WorkspaceEnvelope | null = null;
  const writes: WorkspaceEnvelope[] = [];
  const backend = {
    read: async () => structuredClone(saved),
    write: async (value: WorkspaceEnvelope) => {
      saved = structuredClone(value);
      writes.push(structuredClone(value));
    },
    readLegacy: () => null,
  };
  const workspace = createWorkspaceStore(backend);
  await workspace.persistence.hydrate();
  const finals = { left: newProject('Left final'), right: newProject('Right final') };
  for (const slot of ['left', 'right'] as const) {
    const presetIndex = slot === 'left' ? 0 : 2;
    const project = finals[slot],
      channel = project.presets[presetIndex].channels[1];
    project.hfdSelectedPreset = presetIndex + 1;
    project.hfdSelectedGroupId = 2;
    project.hfdGainLowered = true;
    channel.gain = slot === 'left' ? 14 : -2;
    channel.additionalGain = 10;
    channel.coefficientCache = 'unresolved';
    channel.filters[0] = {
      ...channel.filters[0],
      kind: 'raw',
      enabled: false,
      coefficients: { b0: slot === 'left' ? 0.25 : 0.75, b1: 0.1, b2: 0.02, f1: 0.3, f2: -0.1 },
      provenance: 'hfd',
      sourceType: 'ftBoostCut',
      sourceId: `${slot}-saved`,
    };
  }
  return { ...workspace, backend, writes, finals, saved: () => structuredClone(saved) };
}

it('publishes distinct prepared role finals and their receipt in one persisted envelope and one Undo', async () => {
  const f = await setup(),
    before = structuredClone(f.store.getState().documents),
    observed: Slot[] = [];
  const apply = vi.fn((project: Project, slot: Slot) => {
    expect(f.store.getState().documents).toEqual(before);
    observed.push(slot);
    replace(project, f.finals[slot]);
  });
  const receipt = await f.store
    .getState()
    .commitFileImport('native-final-both', actor, 0, ['left', 'right'], apply, result, undefined, {
      synchronizeLinks: false,
    });
  expect(observed).toEqual(['left', 'right']);
  expect(f.store.getState().documents).toEqual(f.finals);
  expect(f.store.getState().past).toHaveLength(1);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].state.documents).toEqual(f.finals);
  expect(f.writes[0].state.fileCommitReceipts?.['native-final-both']).toEqual(receipt);
  f.store.getState().undo();
  expect(f.store.getState().documents).toEqual(before);
  expect(f.store.getState().fileCommitReceipts?.['native-final-both']).toEqual(receipt);
  await f.persistence.flush();
});

it('an invalid Right staged final refuses before authoritative Left publication, history or receipt', async () => {
  const f = await setup(),
    before = f.store.getState(),
    observed: Slot[] = [];
  const apply = (project: Project, slot: Slot) => {
    observed.push(slot);
    replace(project, f.finals[slot]);
    if (slot === 'right') project.presets[2].channels[1].gain = NaN;
  };
  await expect(
    f.store
      .getState()
      .commitFileImport(
        'invalid-final-both',
        actor,
        0,
        ['left', 'right'],
        apply,
        result,
        undefined,
        { synchronizeLinks: false },
      ),
  ).rejects.toThrow();
  expect(observed).toEqual(['left', 'right']);
  expect(f.store.getState().documents).toBe(before.documents);
  expect(f.store.getState().past).toEqual(before.past);
  expect(f.store.getState().documentRevision).toBe(before.documentRevision);
  expect(f.store.getState().fileCommitReceipts).toEqual(before.fileCommitReceipts);
  expect(f.writes).toEqual([]);
});

it('same-owner duplicate receipt after Undo and cold hydration never invokes role preparation again', async () => {
  const f = await setup(),
    before = structuredClone(f.store.getState().documents);
  const receipt = await f.store
    .getState()
    .commitFileImport(
      'native-replay',
      actor,
      0,
      ['left'],
      (project) => replace(project, f.finals.left),
      result,
      undefined,
      { synchronizeLinks: false },
    );
  f.store.getState().undo();
  await f.persistence.flush();
  const cold = createWorkspaceStore(f.backend);
  await cold.persistence.hydrate();
  const beforeReplay = cold.store.getState(),
    writes = f.writes.length;
  const apply = vi.fn(() => {
    throw Error('Replay attempted native preparation');
  });
  expect(
    await cold.store
      .getState()
      .commitFileImport(
        'native-replay',
        { ...actor, scope: 'native-open:new-page' },
        0,
        ['left'],
        apply,
        result,
      ),
  ).toEqual(receipt);
  expect(apply).not.toHaveBeenCalled();
  expect(cold.store.getState().documents).toEqual(before);
  expect(cold.store.getState().documentRevision).toBe(beforeReplay.documentRevision);
  expect(cold.store.getState().past).toEqual(beforeReplay.past);
  expect(f.writes).toHaveLength(writes);
});

it('legacy one-argument import callbacks remain supported for a unique selected role', async () => {
  const f = await setup(),
    peer = structuredClone(f.store.getState().documents.left);
  const apply = vi.fn((project: Project) => {
    project.name = 'Legacy callback';
  });
  await f.store
    .getState()
    .commitFileImport(
      'legacy-callback',
      actor,
      0,
      ['right', 'right'],
      apply,
      { workflow: 'project' },
      undefined,
      { synchronizeLinks: false },
    );
  expect(apply).toHaveBeenCalledTimes(1);
  expect(f.store.getState().documents.left).toEqual(peer);
  expect(f.store.getState().documents.right.name).toBe('Legacy callback');
});
