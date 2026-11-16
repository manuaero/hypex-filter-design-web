// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createWorkspaceStore, type WorkspaceGestureToken } from '../src/state/workspace';
import { newProject, type Slot } from '../src/domain/model';
import {
  captureManualFilterDrag,
  planManualFilterDrag,
  applyManualFilterDrag,
} from '../src/domain/graph-drag';

async function fixture() {
  let saved: unknown = null;
  const { store, persistence } = createWorkspaceStore({
    read: async () => saved,
    write: async (value) => {
      saved = structuredClone(value);
    },
    readLegacy: () => null,
  });
  await persistence.hydrate();
  store.setState({
    documents: { left: newProject('Left'), right: newProject('Right') },
    past: [],
    future: [],
    gesture: undefined,
  });
  return { state: store.getState, persistence };
}
const ownedEdit = (
  f: Awaited<ReturnType<typeof fixture>>,
  token: WorkspaceGestureToken,
  gain: number,
) =>
  f.state().editAt(
    ['left', 'right'],
    (p, slot) => {
      p.presets[0].channels[0].gain = gain + (slot === 'right' ? 1 : 0);
    },
    { gestureToken: token },
  );

it('groups explicit-role owned graph edits into one exact paired Undo and Redo', async () => {
  const f = await fixture(),
    original = structuredClone(f.state().documents),
    token = f.state().beginOwnedGesture();
  expect(f.state().isOwnedGestureCurrent(token)).toBe(true);
  ownedEdit(f, token, 2);
  ownedEdit(f, token, 5);
  expect(f.state().past).toHaveLength(0);
  expect(f.state().documents.right.presets[0].channels[0].gain).toBe(6);
  f.state().endOwnedGesture(token);
  const result = structuredClone(f.state().documents);
  expect(f.state().past).toHaveLength(1);
  expect(f.state().isOwnedGestureCurrent(token)).toBe(false);
  f.state().undo();
  expect(f.state().documents).toEqual(original);
  f.state().redo();
  expect(f.state().documents).toEqual(result);
  await f.persistence.flush();
});

it('cancels only its still-owned gesture and keeps no-op start/end out of history and revision', async () => {
  const f = await fixture(),
    original = structuredClone(f.state().documents),
    revision = f.state().documentRevision;
  const noop = f.state().beginOwnedGesture();
  f.state().endOwnedGesture(noop);
  expect(f.state().documentRevision).toBe(revision);
  expect(f.state().past).toEqual([]);
  const token = f.state().beginOwnedGesture();
  ownedEdit(f, token, 9);
  f.state().endOwnedGesture(token, true);
  expect(f.state().documents).toEqual(original);
  expect(f.state().past).toEqual([]);
  expect(f.state().gesture).toBeUndefined();
});

it('commits owned changes before an independent edit and stale cancellation cannot erase it', async () => {
  const f = await fixture(),
    original = structuredClone(f.state().documents),
    token = f.state().beginOwnedGesture();
  ownedEdit(f, token, 3);
  const dragged = structuredClone(f.state().documents);
  f.state().editAt(['right'], (p) => {
    p.name = 'Independent command';
  });
  const independent = structuredClone(f.state().documents);
  expect(f.state().past).toHaveLength(2);
  f.state().endOwnedGesture(token, true);
  expect(f.state().documents).toEqual(independent);
  const invoked = vi.fn();
  expect(() => f.state().editAt(['left'], invoked, { gestureToken: token })).toThrow(
    /gesture|stale/i,
  );
  expect(invoked).not.toHaveBeenCalled();
  f.state().undo();
  expect(f.state().documents).toEqual(dragged);
  f.state().undo();
  expect(f.state().documents).toEqual(original);
});

it('does not retire or publish an owned drag when an independent paired proposal fails', async () => {
  const f = await fixture(),
    token = f.state().beginOwnedGesture();
  ownedEdit(f, token, 3);
  const before = f.state(),
    invoked: Slot[] = [];
  expect(() =>
    f.state().editAt(['left', 'right'], (p, slot) => {
      invoked.push(slot);
      p.name = 'Never published';
      if (slot === 'right') throw new Error('Invalid peer');
    }),
  ).toThrow('Invalid peer');
  expect(invoked).toEqual(['left', 'right']);
  expect(f.state()).toBe(before);
  expect(f.state().isOwnedGestureCurrent(token)).toBe(true);
  f.state().endOwnedGesture(token, true);
});

it.each(['replace', 'choose', 'undo', 'redo', 'copy'] as const)(
  'retires owned graph state before independent %s and ignores its late cancel',
  async (action) => {
    const f = await fixture(),
      token = f.state().beginOwnedGesture();
    ownedEdit(f, token, 4);
    if (action === 'replace') f.state().replaceAt('left', newProject('Replacement'));
    if (action === 'choose') f.state().choose({ filter: 1 });
    if (action === 'undo') f.state().undo();
    if (action === 'redo') f.state().redo();
    if (action === 'copy') f.state().copyPreset(1);
    const after = structuredClone(f.state().documents),
      past = f.state().past.length;
    expect(f.state().isOwnedGestureCurrent(token)).toBe(false);
    f.state().endOwnedGesture(token, true);
    expect(f.state().documents).toEqual(after);
    expect(f.state().past).toHaveLength(past);
  },
);

it('rejects forged/cross-store tokens before callbacks and preserves an unrelated anonymous gesture', async () => {
  const f = await fixture(),
    g = await fixture(),
    token = f.state().beginOwnedGesture(),
    change = vi.fn();
  expect(() => g.state().editAt(['left'], change, { gestureToken: token })).toThrow(
    /gesture|stale/i,
  );
  expect(() =>
    f.state().editAt(['left'], change, { gestureToken: {} as WorkspaceGestureToken }),
  ).toThrow(/gesture|stale/i);
  expect(change).not.toHaveBeenCalled();
  f.state().endOwnedGesture(token);
  f.state().beginGesture();
  f.state().editAt(['left'], (p) => {
    p.name = 'Anonymous';
  });
  const current = structuredClone(f.state().documents);
  f.state().endOwnedGesture(token, true);
  expect(f.state().documents).toEqual(current);
  expect(f.state().gesture).toBeDefined();
  f.state().endGesture(true);
  expect(f.state().documents.left.name).toBe('Left');
});

it('legacy end cannot cancel an owned drag; independent begin commits it before starting anonymous work', async () => {
  const f = await fixture(),
    token = f.state().beginOwnedGesture();
  ownedEdit(f, token, 3);
  f.state().endGesture(true);
  expect(f.state().isOwnedGestureCurrent(token)).toBe(true);
  f.state().beginGesture();
  expect(f.state().isOwnedGestureCurrent(token)).toBe(false);
  expect(f.state().past).toHaveLength(1);
  const originalAnonymous = structuredClone(f.state().documents);
  f.state().editAt(['left'], (p) => {
    p.name = 'Anonymous second edit';
  });
  f.state().endGesture(true);
  expect(f.state().documents).toEqual(originalAnonymous);
  expect(f.state().past).toHaveLength(1);
});

it('persists explicit file import independently after committing a pending owned drag', async () => {
  const f = await fixture(),
    token = f.state().beginOwnedGesture();
  ownedEdit(f, token, 3);
  const dragged = structuredClone(f.state().documents);
  const receipt = await f.state().commitFileImport(
    'owned-independent-import',
    { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'manual:test' },
    f.state().documentRevision ?? 0,
    ['left'],
    (p) => {
      p.name = 'Imported';
    },
    { ok: true },
  );
  expect(receipt.result).toEqual({ ok: true });
  const imported = structuredClone(f.state().documents);
  f.state().endOwnedGesture(token, true);
  expect(f.state().documents).toEqual(imported);
  expect(f.state().past).toHaveLength(2);
  f.state().undo();
  expect(f.state().documents).toEqual(dragged);
});

it('commits repeated shared graph plans as one actual paired gesture while skipping canonical no-op plans', async () => {
  const f = await fixture();
  f.state().editAt(['left', 'right'], (p, slot) => {
    Object.assign(p.presets[0].channels[0].filters[0], {
      kind: 'peak',
      frequency: 1000,
      gain: slot === 'left' ? 3 : -2,
      enabled: false,
    });
  });
  const original = structuredClone(f.state().documents),
    history = f.state().past.length;
  let capture = captureManualFilterDrag(
    f.state().documents,
    ['left', 'right'],
    { presetIndex: 0, channelIndex: 0, filterIndex: 0 },
    f.state().documentRevision,
  );
  const token = f.state().beginOwnedGesture();
  for (const pointer of [
    { frequency: 1500, originAxisY: 0, axisY: 1 },
    { frequency: 1600, originAxisY: 0, axisY: 2 },
    { frequency: 1600, originAxisY: 0, axisY: 2 },
  ]) {
    const plan = planManualFilterDrag(
      f.state().documents,
      capture,
      pointer,
      f.state().documentRevision,
    );
    if (plan.changedSlots.length)
      f.state().editAt(plan.changedSlots, (p, slot) => applyManualFilterDrag(p, slot, plan), {
        gestureToken: token,
      });
    capture = plan.nextCapture;
  }
  expect(f.state().past).toHaveLength(history);
  expect(f.state().documents.left.presets[0].channels[0].filters[0].gain).toBe(5);
  expect(f.state().documents.right.presets[0].channels[0].filters[0].gain).toBe(0);
  const result = structuredClone(f.state().documents);
  f.state().endOwnedGesture(token);
  expect(f.state().past).toHaveLength(history + 1);
  f.state().undo();
  expect(f.state().documents).toEqual(original);
  f.state().redo();
  expect(f.state().documents).toEqual(result);
});

it('keeps an owned gesture intact when file-import validation fails after detached proposals', async () => {
  const f = await fixture(),
    token = f.state().beginOwnedGesture();
  ownedEdit(f, token, 3);
  const before = f.state();
  await expect(
    f.state().commitFileImport(
      'invalid-owned-independent-import',
      { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'manual:test' },
      before.documentRevision ?? 0,
      ['left'],
      (p) => {
        p.name = 'Never published';
      },
      { ok: true },
      () => ({ invalid: true }) as never,
    ),
  ).rejects.toThrow();
  expect(f.state()).toBe(before);
  expect(f.state().isOwnedGestureCurrent(token)).toBe(true);
  expect(f.state().fileCommitReceipts?.['invalid-owned-independent-import']).toBeUndefined();
  f.state().endOwnedGesture(token, true);
});
