// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { createWorkspaceStore } from '../src/state/workspace';
import { newProject } from '../src/domain/model';
it('records one undo entry for a full graph drag and restores cancelled gestures', async () => {
  let saved: unknown = null;
  const { store: useWorkspace, persistence } = createWorkspaceStore({
    read: async () => saved,
    write: async (value) => {
      saved = structuredClone(value);
    },
    readLegacy: () => null,
  });
  await persistence.hydrate();
  useWorkspace.setState({
    documents: { left: newProject(), right: newProject() },
    past: [],
    future: [],
    gesture: undefined,
  });
  const state = () => useWorkspace.getState(),
    original = structuredClone(state().documents);
  state().beginGesture();
  for (const frequency of [300, 400, 500])
    state().editAt(['left'], (p) => {
      p.presets[0].channels[0].filters[0].frequency = frequency;
    });
  expect(state().past).toHaveLength(0);
  state().endGesture();
  expect(state().past).toHaveLength(1);
  state().undo();
  expect(state().documents).toEqual(original);
  state().redo();
  expect(state().documents.left.presets[0].channels[0].filters[0].frequency).toBe(500);
  const before = structuredClone(state().documents);
  state().beginGesture();
  state().editAt(['left'], (p) => (p.presets[0].channels[0].gain = -9));
  state().endGesture(true);
  expect(state().documents).toEqual(before);
  expect(state().past).toHaveLength(1);
  await persistence.flush();
});
