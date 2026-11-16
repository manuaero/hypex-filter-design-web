import { expect, it, vi } from 'vitest';
import { newProject, type Project, type Slot } from '../src/domain/model';
import { createNativeOrdinarySaveAttempt as create } from '../src/application/native-save-attempt';
import { applyNativeOrdinarySavePostState } from '../src/application/native-save-lifecycle';

const principal = {
  owner: 'workspace:11111111-2222-4333-8444-555555555555',
  scope: 'ui:save',
};
const mcp = { ...principal, scope: 'mcp:directory' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(targets: Slot[] = ['left']) {
  const left = newProject('Left preimage'),
    right = structuredClone(left);
  right.name = 'Right preimage';
  for (const [role, project] of [left, right].entries()) {
    project.hfdSelectedPreset = 3;
    project.sourceXml = '<retained native="source" />';
    for (const [p, preset] of project.presets.entries())
      for (const [c, channel] of preset.channels.entries()) {
        channel.globalDelayUs = role * 1000 + p * 100 + [11, 23, 37][c];
        channel.hfdDelay = {
          localMaximum: 17 + c,
          globalMaximum: 70001 + role * 1000 + p * 100 + c,
        };
        channel.additionalGain = c === 1 ? 10 : 0;
        channel.gain = p + c;
        channel.delayUs = 0.125 + c;
        channel.coefficientCache = 'unresolved';
        channel.fir = { name: 'Retained vector', enabled: false, taps: [1, 0.5, -0.25] };
        if (c === 1) channel.linkedTo = 0;
      }
  }
  const state = { documents: { left, right }, documentRevision: 7 },
    selected = { left: 1, right: 1 },
    persist = vi.fn(async () => {}),
    publish = vi.fn(
      (
        plans: readonly import('../src/application/native-save-lifecycle').NativeOrdinarySavePostPlan[],
      ) => {
        const documents = { ...state.documents };
        for (const plan of plans) {
          if (!plan.changed) continue;
          documents[plan.slot] = structuredClone(documents[plan.slot]);
          applyNativeOrdinarySavePostState(documents[plan.slot], plan.slot, plan);
        }
        state.documents = documents;
        state.documentRevision++;
      },
    ),
    contexts = () =>
      targets.map((slot) => ({
        slot,
        project: state.documents[slot],
        presetIndex: selected[slot],
        expectedRevision: state.documentRevision,
      })),
    options = {
      state: () => state,
      currentPresetIndex: (slot: Slot) => selected[slot],
      publish,
      persist,
    },
    attempt = () => create({ principal, contexts: contexts() }, options);
  return { left, right, state, selected, persist, publish, contexts, options, attempt };
}
const globals = (project: Project, preset = 1) =>
  project.presets[preset].channels.map((channel) => channel.globalDelayUs);

it('leaves the exact serialized preimage untouched until the admitted writer returns normally', async () => {
  const f = fixture(),
    before = structuredClone(f.state.documents),
    writer = deferred(),
    attempt = f.attempt();
  expect(Object.isFrozen(attempt)).toBe(true);
  expect(Object.isFrozen(attempt.getSnapshot())).toBe(true);
  expect(attempt.getSnapshot().phase).toBe('ready');
  attempt.beforeWrite(principal);
  const execution = (async () => {
    await writer.promise;
    return attempt.returned(principal, true);
  })();
  await Promise.resolve();
  expect(f.state.documents).toEqual(before);
  expect(f.publish).not.toHaveBeenCalled();
  writer.resolve();
  expect(await execution).toEqual({
    changed: true,
    published: true,
    durable: true,
    normalResult: true,
  });
  expect(globals(f.state.documents.left)).toEqual([111, 111, 111]);
  expect(globals(before.left)).toEqual([111, 123, 137]);
  expect(f.state.documents.right).toBe(f.right);
  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(f.persist).toHaveBeenCalledTimes(1);
  expect(f.publish.mock.invocationCallOrder[0]).toBeLessThan(f.persist.mock.invocationCallOrder[0]);
});

it('settles a normal Boolean-false return and changes only the explicit preset raw Globals/maxima', async () => {
  const f = fixture(),
    before = structuredClone(f.left),
    attempt = f.attempt();
  attempt.beforeWrite(principal);
  const result = await attempt.returned(mcp, false),
    expected = structuredClone(before);
  for (const channel of expected.presets[1].channels) {
    channel.globalDelayUs = 111;
    channel.hfdDelay!.globalMaximum = 70101;
  }
  expect(result).toEqual({ changed: true, published: true, durable: true, normalResult: false });
  expect(f.state.documents.left).toEqual(expected);
  expect(f.left).toEqual(before);
  expect(f.state.documents.left.hfdSelectedPreset).toBe(3);
  expect(attempt.getSnapshot()).toEqual({ phase: 'complete', changed: true, normalResult: false });
});

it('preflights independent Both contexts with matching native IDs and publishes them atomically once', async () => {
  const f = fixture(['left', 'right']),
    attempt = f.attempt();
  expect(f.left.presets[1].channels[0].id).toBe(f.right.presets[1].channels[0].id);
  attempt.beforeWrite(principal);
  attempt.beforeWrite(mcp);
  await attempt.returned(mcp, true);
  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(f.publish.mock.calls[0][0].map((plan) => plan.slot)).toEqual(['left', 'right']);
  expect(f.state.documentRevision).toBe(8);
  expect(globals(f.state.documents.left)).toEqual([111, 111, 111]);
  expect(globals(f.state.documents.right)).toEqual([1111, 1111, 1111]);
  expect(
    f.state.documents.right.presets[1].channels.map((channel) => channel.hfdDelay?.globalMaximum),
  ).toEqual([71101, 71101, 71101]);
});

it('refuses an invalid Right plan before any writer or Left publication can be admitted', () => {
  const f = fixture(['left', 'right']);
  delete f.right.presets[1].channels[0].hfdDelay!.globalMaximum;
  const before = structuredClone(f.state.documents);
  expect(f.attempt).toThrow(/first saved maximum/);
  expect(f.state.documents).toEqual(before);
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.persist).not.toHaveBeenCalled();
});

it('rejects implicit, duplicate, malformed and inconsistent constructor contexts', () => {
  const f = fixture(['left', 'right']),
    valid = f.contexts();
  for (const contexts of [
    [],
    [valid[0], valid[0]],
    [...valid, valid[0]],
    [{ ...valid[0], slot: 'both' }],
    [{ ...valid[0], presetIndex: -1 }],
    [{ ...valid[0], presetIndex: 1.5 }],
    [{ ...valid[0], expectedRevision: NaN }],
    [valid[0], { ...valid[1], expectedRevision: 8 }],
  ])
    expect(() => create({ principal, contexts: contexts as typeof valid }, f.options)).toThrow();
  const invalidProject = { ...f.left, version: 2 } as unknown as Project;
  expect(() =>
    create({ principal, contexts: [{ ...valid[0], project: invalidProject }] }, f.options),
  ).toThrow();
  expect(f.publish).not.toHaveBeenCalled();
});

it.each(['replacement', 'revision', 'preset', 'raw'] as const)(
  'consumes a stale %s fence before the first filesystem mutation',
  (kind) => {
    const f = fixture(),
      attempt = f.attempt();
    if (kind === 'replacement') f.state.documents.left = structuredClone(f.left);
    if (kind === 'revision') f.state.documentRevision++;
    if (kind === 'preset') f.selected.left = 2;
    if (kind === 'raw') f.left.presets[1].channels[2].globalDelayUs++;
    expect(() => attempt.beforeWrite(principal)).toThrow(/changed/);
    expect(attempt.getSnapshot().phase).toBe('unconfirmed');
    expect(() => attempt.beforeWrite(principal)).toThrow(/consumed/);
    expect(f.publish).not.toHaveBeenCalled();
  },
);

it('refences every role after an awaited normal return and never resurrects a stale attempt', async () => {
  const f = fixture(['left', 'right']),
    attempt = f.attempt();
  attempt.beforeWrite(principal);
  f.state.documents.right = structuredClone(f.right);
  await expect(attempt.returned(principal, true)).rejects.toThrow(/changed/);
  f.state.documents.right = f.right;
  await expect(attempt.returned(principal, true)).rejects.toThrow(/no admitted/);
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.persist).not.toHaveBeenCalled();
});

it('requires trusted workspace ownership without allowing a foreign caller to consume a valid attempt', async () => {
  const f = fixture(),
    attempt = f.attempt(),
    foreign = { ...principal, owner: 'workspace:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
  expect(() => attempt.beforeWrite(foreign)).toThrow(/another workspace/);
  expect(attempt.getSnapshot().phase).toBe('ready');
  attempt.beforeWrite(mcp);
  await expect(attempt.returned(foreign, true)).rejects.toThrow(/another workspace/);
  await expect(attempt.returned(principal, undefined as unknown as boolean)).rejects.toThrow(
    /Boolean/,
  );
  expect(attempt.getSnapshot().phase).toBe('writing');
  await attempt.returned(principal, true);
  for (const invalid of [
    { owner: 'browser:untrusted', scope: 'ui' },
    { owner: principal.owner, scope: '' },
  ])
    expect(() => create({ principal: invalid, contexts: f.contexts() }, f.options)).toThrow();
});

it('returns its completed receipt passively after Undo and never rechecks or republishes consumed original references', async () => {
  const f = fixture(),
    before = structuredClone(f.state.documents),
    attempt = f.attempt();
  attempt.beforeWrite(principal);
  const result = await attempt.returned(principal, true);
  expect(Object.isFrozen(result)).toBe(true);
  f.state.documents = before;
  f.state.documentRevision++;
  f.selected.left = 0;
  f.left.presets[1].channels[0].globalDelayUs = NaN;
  expect(await attempt.returned(mcp, false)).toBe(result);
  expect(await attempt.retryPersistence()).toBe(result);
  expect(f.state.documents).toBe(before);
  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(f.persist).toHaveBeenCalledTimes(1);
  expect(() => attempt.beforeWrite(principal)).toThrow(/consumed/);
});

it('consumes an equal signed-zero legacy preset as an exact no-op without an edit or persistence call', async () => {
  const f = fixture();
  for (const [i, channel] of f.left.presets[1].channels.entries()) {
    channel.globalDelayUs = i === 1 ? -0 : 0;
    delete channel.hfdDelay;
  }
  const attempt = f.attempt(),
    before = structuredClone(f.state.documents);
  attempt.beforeWrite(principal);
  expect(await attempt.returned(principal, false)).toEqual({
    changed: false,
    published: false,
    durable: true,
    normalResult: false,
  });
  expect(f.state.documents).toEqual(before);
  expect(Object.is(f.left.presets[1].channels[1].globalDelayUs, -0)).toBe(true);
  expect(f.state.documentRevision).toBe(7);
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.persist).not.toHaveBeenCalled();
});

it('does not admit cancellation, a thrown writer or an unknown outcome as a normal false return', async () => {
  const f = fixture(),
    cancelled = f.attempt();
  cancelled.notReturned();
  await expect(cancelled.returned(principal, false)).rejects.toThrow(/no admitted/);
  const thrown = f.attempt();
  thrown.beforeWrite(principal);
  thrown.notReturned();
  thrown.notReturned();
  await expect(thrown.returned(principal, false)).rejects.toThrow(/no admitted/);
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.persist).not.toHaveBeenCalled();
});

it('retains a published non-durable result on persistence failure and retries persistence only after Undo', async () => {
  const f = fixture(),
    before = structuredClone(f.state.documents),
    attempt = f.attempt();
  f.persist.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
  attempt.beforeWrite(principal);
  await expect(attempt.returned(principal, true)).rejects.toThrow('IndexedDB unavailable');
  expect(attempt.getSnapshot()).toEqual({ phase: 'published', changed: true, normalResult: true });
  expect(globals(f.state.documents.left)).toEqual([111, 111, 111]);
  expect(await attempt.returned(principal, true)).toEqual({
    changed: true,
    published: true,
    durable: false,
    normalResult: true,
  });
  expect(f.persist).toHaveBeenCalledTimes(1);
  f.state.documents = before;
  f.state.documentRevision++;
  expect(await attempt.retryPersistence()).toEqual({
    changed: true,
    published: true,
    durable: true,
    normalResult: true,
  });
  expect(f.state.documents).toBe(before);
  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(f.persist).toHaveBeenCalledTimes(2);
});

it('deduplicates concurrent persistence retries and ignores notReturned after publication', async () => {
  const f = fixture(),
    pending = deferred(),
    attempt = f.attempt();
  f.persist.mockImplementation(() => pending.promise);
  attempt.beforeWrite(principal);
  const returned = attempt.returned(principal, true);
  await Promise.resolve();
  attempt.notReturned();
  const a = attempt.retryPersistence(),
    b = attempt.retryPersistence();
  expect(a).toBe(b);
  expect(f.persist).toHaveBeenCalledTimes(1);
  pending.resolve();
  const results = await Promise.all([returned, a, b]);
  expect(results[0]).toBe(results[1]);
  expect(results[1]).toBe(results[2]);
  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(attempt.getSnapshot().phase).toBe('complete');
});

it('keeps a throwing publication unconfirmed and never persists or retries that unknown outcome', async () => {
  const f = fixture(),
    attempt = f.attempt();
  f.publish.mockImplementation(() => {
    throw new Error('Publication refused');
  });
  attempt.beforeWrite(principal);
  await expect(attempt.returned(principal, true)).rejects.toThrow('Publication refused');
  expect(attempt.getSnapshot().phase).toBe('unconfirmed');
  expect(() => attempt.retryPersistence()).toThrow(/no pending/);
  expect(f.persist).not.toHaveBeenCalled();
});
