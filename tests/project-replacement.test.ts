import { expect, it } from 'vitest';
import { newProject } from '../src/domain/model';
import { createWorkspaceStore } from '../src/state/workspace';
import { assertWorkspaceWrite, type WorkspaceEnvelope } from '../src/state/persistence';

async function workspace() {
  let saved: WorkspaceEnvelope = {
    version: 1,
    state: {
      documents: { left: newProject('Original left'), right: newProject('Original right') },
      slot: 'right',
      preset: 0,
      channel: 0,
      filter: 0,
      linkedEdits: true,
      linkedControls: true,
      documentRevision: 0,
    },
  };
  const instance = createWorkspaceStore({
    read: async () => structuredClone(saved),
    readLegacy: () => null,
    write: async (next, expected) => {
      assertWorkspaceWrite(saved, expected, next);
      saved = structuredClone(next);
    },
  });
  await instance.persistence.hydrate();
  return instance;
}

it('replaces the explicit role despite selected-right and linked edits, with one complete Undo/Redo entry', async () => {
  const { store, persistence } = await workspace(),
    before = structuredClone(store.getState().documents),
    right = store.getState().documents.right,
    replacement = newProject('Imported left');
  replacement.presets[2].channels[1].gain = -8;
  store.getState().replaceAt('left', replacement);
  expect(store.getState().slot).toBe('right');
  expect(store.getState().documents.left).toEqual(replacement);
  expect(store.getState().documents.right).toBe(right);
  expect(store.getState().past).toHaveLength(1);
  expect(store.getState().future).toHaveLength(0);
  expect(store.getState().documentRevision).toBe(1);

  store.getState().undo();
  expect(store.getState().documents).toEqual(before);
  expect(store.getState().past).toHaveLength(0);
  expect(store.getState().future).toHaveLength(1);
  store.getState().redo();
  expect(store.getState().documents).toEqual({ left: replacement, right: before.right });
  expect(store.getState().past).toHaveLength(1);
  expect(store.getState().documentRevision).toBe(3);
  await persistence.flush();
  expect(persistence.getSnapshot().unsaved).toBe(false);
});

it('deeply isolates the caller project from current documents and subsequent history', async () => {
  const { store, persistence } = await workspace(),
    replacement = newProject('Owned import');
  replacement.presets[0].channels[0].fir = { name: 'Impulse FIR', enabled: true, taps: [1, 0.5] };
  replacement.presets[0].channels[0].measurement = {
    name: 'Response',
    sampleRate: 48000,
    impulse: [0, 1, 0],
    sourceSpectrum: { frequency: [100, 1000], magnitude: [0, -2], phase: [0, -30] },
  };
  const expected = structuredClone(replacement);
  store.getState().replaceAt('left', replacement);
  replacement.name = 'Caller changed';
  replacement.presets[0].inputEq[0].gain = 9;
  replacement.presets[0].channels[0].filters[0].frequency = 9999;
  replacement.presets[0].channels[0].fir.taps[0] = 99;
  replacement.presets[0].channels[0].measurement!.impulse![1] = 99;
  replacement.presets[0].channels[0].measurement!.sourceSpectrum!.magnitude[0] = 99;
  expect(store.getState().documents.left).toEqual(expected);

  store.getState().editAt(['left'], (project) => {
    project.presets[0].channels[0].gain = -7;
  });
  expect(replacement.presets[0].channels[0].gain).toBe(0);
  store.getState().undo();
  expect(store.getState().documents.left).toEqual(expected);
  store.getState().undo();
  expect(store.getState().documents.left.name).toBe('Original left');
  store.getState().redo();
  expect(store.getState().documents.left).toEqual(expected);
  expect(store.getState().documents.right.name).toBe('Original right');
  await persistence.flush();
});
