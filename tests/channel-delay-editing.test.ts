import { expect, it, vi } from 'vitest';
import { newProject, newFilter, type Project, type Slot } from '../src/domain/model';
import {
  planChannelEdit,
  applyChannelEdit,
  type ChannelEditPatch,
  type ChannelEditOptions,
} from '../src/domain/channel-editing';
import { resolveChannelDelayProfiles } from '../src/domain/channel-delay-profile';
import { hfdChannelDelayWheelNext } from '../src/domain/channel-delay';
import { createWorkspaceStore } from '../src/state/workspace';
import {
  copyNativeLinkedChannel,
  settleNativeLinkedCopyCache,
} from '../src/domain/native-linked-copy';

const at = { presetIndex: 0, channelIndex: 0 };
const channel = (p: Project, i = 0) => p.presets[0].channels[i];
function fixture() {
  const left = newProject('Left'),
    right = newProject('Right');
  for (const p of [left, right]) {
    for (const c of p.presets[0].channels)
      c.hfdDelay = { localMaximum: 19, globalMaximum: 74666.6666666667 };
    channel(p).filters[0] = {
      ...newFilter('raw'),
      provenance: 'hfd',
      coefficients: { b0: 0.25, b1: 0, b2: 0, f1: 0, f2: 0 },
    };
    channel(p).coefficientCache = 'unresolved';
  }
  return { left, right };
}
const plan = (
  docs: Record<Slot, Project>,
  patch: ChannelEditPatch,
  options: ChannelEditOptions = {},
  slots: Slot[] = ['left', 'right'],
) => planChannelEdit(docs, slots, { ...at, patch }, 7, options);
function apply(docs: Record<Slot, Project>, p: ReturnType<typeof plan>) {
  const next = structuredClone(docs);
  for (const slot of p.changedSlots) applyChannelEdit(next[slot], slot, p);
  return next;
}

// Synthetic containers with actual V54 callback literals; not a full native project fixture.
it('publishes MaxDelay for an explicit same-Text zero callback without changing retained caches', () => {
  const docs = fixture(),
    before = structuredClone(docs),
    p = plan(docs, { delayUs: '0' });
  expect(p.changedSlots).toEqual(['left', 'right']);
  const next = apply(docs, p);
  for (const slot of ['left', 'right'] as const) {
    expect(channel(next[slot]).delayUs).toBe(0);
    expect(channel(next[slot]).hfdDelay?.localMaximum).toBe(19200);
    expect({ ...channel(next[slot]), hfdDelay: channel(before[slot]).hfdDelay }).toEqual(
      channel(before[slot]),
    );
  }
  expect(docs).toEqual(before);
});

it.each([
  ['16', 21],
  ['20000', 19200],
] as const)('normalizes local raw %s using offline runtime bounds', (raw, value) => {
  const docs = fixture(),
    p = plan(docs, { delayUs: raw }),
    next = apply(docs, p);
  expect(channel(next.left).delayUs).toBe(value);
  expect(next.left.presets.slice(1)).toEqual(docs.left.presets.slice(1));
});

it('keeps the final global value above its fractional maximum and fans only the value to the current preset', () => {
  const docs = fixture(),
    p = plan(docs, { globalDelayUs: '100000' }),
    next = apply(docs, p);
  for (const slot of ['left', 'right'] as const) {
    expect(next[slot].presets[0].channels.map((c) => c.globalDelayUs)).toEqual([
      74667, 74667, 74667,
    ]);
    expect(next[slot].presets[0].channels.map((c) => c.hfdDelay?.globalMaximum)).toEqual([
      74666.6666666667, 74666.6666666667, 74666.6666666667,
    ]);
    expect(next[slot].presets.slice(1)).toEqual(docs[slot].presets.slice(1));
  }
});

it('propagates each role current Global Text directly during a local callback without quantizing it', () => {
  const docs = fixture(),
    p = plan(
      docs,
      { delayUs: '16' },
      { delayContext: { left: { globalText: '17.123456789' }, right: { globalText: '29,5' } } },
    ),
    next = apply(docs, p);
  expect(next.left.presets[0].channels.map((c) => c.globalDelayUs)).toEqual([
    17.123456789, 17.123456789, 17.123456789,
  ]);
  expect(next.right.presets[0].channels.map((c) => c.globalDelayUs)).toEqual([29.5, 29.5, 29.5]);
});

it('copies all immediate follower processing and both maxima while retaining destination Add, identity and measurements', () => {
  const docs = fixture();
  for (const p of [docs.left, docs.right]) {
    channel(p).hfdDelay!.globalMaximum = 60000;
    Object.assign(channel(p, 1), {
      linkedTo: 0,
      gain: 24,
      invert: true,
      muted: true,
      delayUs: 1,
      additionalGain: 10,
    });
  }
  const before = structuredClone(docs),
    p = plan(docs, { delayUs: '16' }),
    next = apply(docs, p);
  for (const slot of ['left', 'right'] as const) {
    const source = channel(next[slot]),
      target = channel(next[slot], 1),
      old = channel(before[slot], 1);
    expect(target).toMatchObject({
      gain: 0,
      invert: false,
      muted: false,
      delayUs: 21,
      additionalGain: 10,
      hfdDelay: { localMaximum: 19200, globalMaximum: 60000 },
      coefficientCache: 'unresolved',
    });
    expect(target.id).toBe(old.id);
    expect(target.hfdMeasurement).toEqual(old.hfdMeasurement);
    expect(target.filters[0]).toMatchObject({ ...source.filters[0], id: old.filters[0].id });
  }
});

it('copies only immediate followers rather than flattening an acyclic chain', () => {
  const docs = fixture();
  for (const p of [docs.left, docs.right]) {
    channel(p, 1).linkedTo = 0;
    channel(p, 2).linkedTo = 1;
    channel(p, 2).gain = 17;
  }
  const before = structuredClone(docs),
    next = apply(docs, plan(docs, { delayUs: '16' }));
  expect(channel(next.left, 1).delayUs).toBe(21);
  expect(channel(next.left, 2)).toEqual(channel(before.left, 2));
});

it('notified false wheel skips MaxDelay, linked copy and Global fanout', () => {
  const docs = fixture();
  channel(docs.left, 1).linkedTo = 0;
  channel(docs.left, 1).gain = 24;
  const p = plan(
    docs,
    { delayWheel: { parameter: 'local', direction: -1, basis: 'left' } },
    { delayContext: { left: { globalText: '29' } } },
  );
  expect(p.changedSlots).toEqual([]);
  expect(p.roles[0].delayWheelResult).toMatchObject({ notified: false, changed: false });
});

it('retains notified true/value-equal source effects but does not apply a fixed-basis peer callback', () => {
  const docs = fixture();
  channel(docs.left).delayUs = 11;
  const profiles = resolveChannelDelayProfiles(docs.left, 0, 0);
  const result = hfdChannelDelayWheelNext(11, 1, { profile: profiles.local, displayedText: '0' });
  expect(result).toMatchObject({ value: 11, changed: false, notified: true });
  const p = plan(
    docs,
    { delayWheel: { parameter: 'local', direction: 1, basis: 'left' } },
    {
      delayWheelSourceEvent: {
        slot: 'left',
        channelId: channel(docs.left).id,
        expectedValue: 11,
        expectedContextKey: profiles.contextKey,
        result,
      },
    },
  );
  expect(p.changedSlots).toEqual(['left']);
  expect(channel(apply(docs, p).left).hfdDelay?.localMaximum).toBe(19200);
  expect(apply(docs, p).right).toEqual(docs.right);
});

it('uses distinct connected runtime bounds for each role while normalizing the original request', () => {
  const docs = fixture(),
    p = plan(
      docs,
      { delayUs: '30000' },
      {
        delayContext: {
          right: { runtime: { kind: 'connected', core: '1.50', sessionKey: 'right-session' } },
        },
      },
    ),
    next = apply(docs, p);
  expect(channel(next.left).delayUs).toBe(19200);
  expect(channel(next.right).delayUs).toBe(29995);
});

it('preflights malformed Right native cache before any role can be applied', () => {
  const docs = fixture();
  channel(docs.right, 1).linkedTo = 0;
  channel(docs.right).filters[0].coefficients = undefined;
  const before = structuredClone(docs);
  expect(() => plan(docs, { delayUs: '16' })).toThrow(/finite vector|original/i);
  expect(docs).toEqual(before);
});

it.each(['maximum', 'fir', 'xml', 'witness'] as const)(
  'fences stale %s before any detached mutation',
  (field) => {
    const docs = fixture(),
      p = plan(docs, { delayUs: '16' }),
      next = structuredClone(docs.left);
    if (field === 'maximum') channel(next).hfdDelay!.localMaximum = 7;
    if (field === 'fir') channel(next).fir.taps = [1];
    if (field === 'xml') next.sourceXml = '<changed />';
    if (field === 'witness')
      Object.assign(channel(next), { hfdDirectCacheWitness: { invalid: true } });
    const before = structuredClone(next);
    expect(() => applyChannelEdit(next, 'left', p)).toThrow(/context|changed/i);
    expect(next).toEqual(before);
  },
);

it.each([
  { delayUs: 16, gain: 3 },
  { delayUs: 16, globalDelayUs: 16 },
  { globalDelayUs: 16, name: 'mixed' },
] as const)('rejects ambiguous mixed callback patch %j', (patch) => {
  expect(() => plan(fixture(), patch)).toThrow(/sole|mixed/i);
});

it('rejects a stale profile source event before creating any proposal', () => {
  const docs = fixture(),
    profile = resolveChannelDelayProfiles(docs.left, 0, 0),
    result = hfdChannelDelayWheelNext(0, 1, { profile: profile.local });
  expect(() =>
    plan(
      docs,
      { delayWheel: { parameter: 'local', direction: 1, basis: 'left' } },
      {
        delayWheelSourceEvent: {
          slot: 'left',
          channelId: channel(docs.left).id,
          expectedValue: 0,
          expectedContextKey: 'old-session',
          result,
        },
      },
    ),
  ).toThrow(/source|context/i);
});

it('runs each-role wheel callbacks independently and strips their opaque state from the plan', () => {
  const docs = fixture();
  channel(docs.right).delayUs = 21;
  const p = plan(docs, { delayWheel: { parameter: 'local', direction: 1 } });
  expect(p.roles.map((role) => role.delayWheelResult)).toEqual([
    { text: '11', value: 11, changed: true, notified: true, maximumValue: 19200 },
    { text: '32', value: 32, changed: true, notified: true, maximumValue: 19200 },
  ]);
  expect(p.roles.every((role) => !Object.hasOwn(role.delayWheelResult!, 'state'))).toBe(true);
});

it('normalizes a changed fixed-source wheel through the peer profile and its own Global Text', () => {
  const docs = fixture();
  channel(docs.left).delayUs = 19189;
  const p = plan(
      docs,
      { delayWheel: { parameter: 'local', direction: 1, basis: 'left' } },
      {
        delayContext: { left: { globalText: '17' }, right: { globalText: '29' } },
      },
    ),
    next = apply(docs, p);
  expect(p.roles.map((role) => role.delayWheelResult?.value)).toEqual([19200, 19200]);
  expect(next.left.presets[0].channels.map((c) => c.globalDelayUs)).toEqual([17, 17, 17]);
  expect(next.right.presets[0].channels.map((c) => c.globalDelayUs)).toEqual([29, 29, 29]);
});

it('keeps a canonical, MaxDelay and coupled-effect no-op completely unchanged', () => {
  const docs = fixture();
  for (const p of [docs.left, docs.right]) channel(p).hfdDelay!.localMaximum = 19200;
  const before = structuredClone(docs),
    p = plan(docs, { delayUs: 0 });
  expect(p.changedSlots).toEqual([]);
  expect(p.roles.map((role) => role.delayResult?.value)).toEqual([0, 0]);
  expect(docs).toEqual(before);
});

it('refuses the entire pair if one imported role has no trusted global maximum', () => {
  const docs = fixture();
  docs.right.sourceXml = '<native-unqualified />';
  delete channel(docs.right).hfdDelay!.globalMaximum;
  const before = structuredClone(docs);
  expect(() => plan(docs, { delayUs: '16' })).toThrow(/right:.*global delay limit.*missing/i);
  expect(docs).toEqual(before);
});

it('preflights a linked local peer even for a no-notification bound wheel', () => {
  const docs = fixture();
  channel(docs.right).linkedTo = 1;
  expect(() =>
    plan(docs, { delayWheel: { parameter: 'local', direction: -1, basis: 'left' } }),
  ).toThrow(/linked|master/i);
});

it('does not bulk-copy processing for a Global callback on a linked channel', () => {
  const docs = fixture();
  for (const p of [docs.left, docs.right]) {
    channel(p).linkedTo = 1;
    channel(p).gain = 24;
  }
  const before = structuredClone(docs),
    next = apply(docs, plan(docs, { globalDelayUs: '16' }));
  for (const slot of ['left', 'right'] as const) {
    expect(next[slot].presets[0].channels.map((c) => c.globalDelayUs)).toEqual([21, 21, 21]);
    expect(channel(next[slot]).gain).toBe(24);
    expect(channel(next[slot]).filters).toEqual(channel(before[slot]).filters);
  }
});

it('preserves destination maximum metadata when a wheel does not notify', () => {
  const docs = fixture();
  channel(docs.left).hfdDelay!.localMaximum = 19;
  const p = plan(docs, { delayWheel: { parameter: 'local', direction: -1 } });
  expect(p.changedSlots).toEqual([]);
  expect(p.roles.every((role) => role.delayWheelResult?.notified === false)).toBe(true);
});

it('publishes callback metadata, immediate copy and role-specific fanout in one exact Undo', async () => {
  const docs = fixture();
  for (const p of [docs.left, docs.right]) {
    channel(p, 1).linkedTo = 0;
    Object.assign(channel(p, 1), { gain: 24, invert: true, muted: true, delayUs: 1 });
  }
  const { store, persistence } = createWorkspaceStore({
    read: async () => null,
    write: async () => {},
    readLegacy: () => null,
  });
  await persistence.hydrate();
  store.setState({ documents: docs, past: [], future: [], gesture: undefined });
  const before = structuredClone(store.getState().documents),
    p = plan(
      store.getState().documents,
      { delayUs: '16' },
      {
        delayContext: { left: { globalText: '17' }, right: { globalText: '29' } },
      },
    );
  store.getState().editAt(p.changedSlots, (project, slot) => applyChannelEdit(project, slot, p), {
    synchronizeLinks: p.synchronizeLinks,
  });
  expect(store.getState().past).toHaveLength(1);
  expect(channel(store.getState().documents.left, 1)).toMatchObject({
    gain: 0,
    delayUs: 21,
    hfdDelay: { localMaximum: 19200 },
  });
  store.getState().undo();
  expect(store.getState().documents).toEqual(before);
});

it('still copies a stale linked follower when source Delay and MaxDelay are already equal', () => {
  const docs = fixture();
  for (const p of [docs.left, docs.right]) {
    channel(p).hfdDelay!.localMaximum = 19200;
    channel(p, 1).linkedTo = 0;
    channel(p, 1).gain = 24;
  }
  const p = plan(docs, { delayUs: '0' }),
    next = apply(docs, p);
  expect(p.changedSlots).toEqual(['left', 'right']);
  expect(p.roles.map((role) => role.delayResult?.value)).toEqual([0, 0]);
  expect(channel(next.left, 1).gain).toBe(0);
});

it('native CopyTo does not retain an unrelated destination maximum when source metadata is unknown', () => {
  const project = fixture().left;
  channel(project, 1).linkedTo = 0;
  delete channel(project).hfdDelay;
  copyNativeLinkedChannel(project, 0, 1);
  settleNativeLinkedCopyCache(project, 0, 1);
  expect(channel(project, 1).hfdDelay).toBeUndefined();
  expect(Object.hasOwn(channel(project, 1), 'hfdDelay')).toBe(false);
});

it('native copy settlement rejects a maximum changed after its own admitted copy', () => {
  const project = fixture().left;
  channel(project, 1).linkedTo = 0;
  copyNativeLinkedChannel(project, 0, 1);
  channel(project, 1).hfdDelay!.globalMaximum = 99;
  expect(() => settleNativeLinkedCopyCache(project, 0, 1)).toThrow(/unchanged copied processing/i);
});

it('does not snapshot or own a bulk measurement for an admitted no-notification wheel', () => {
  const docs = fixture();
  const impulse = Array.from({ length: 2_000_000 }, (_, i) => (i === 0 ? 1 : 0));
  const measurement = { name: 'Large retained impulse', sampleRate: 48000, impulse };
  channel(docs.left).measurement = measurement;
  const clone = vi.spyOn(globalThis, 'structuredClone');
  try {
    const p = plan(docs, { delayWheel: { parameter: 'local', direction: -1 } });
    expect(p.changedSlots).toEqual([]);
    expect(p.roles.every((role) => role.delayProposal === undefined)).toBe(true);
    // Narrow context snapshots are still allowed. A no-event does not own a
    // project snapshot or bulk resource that can never be published.
    expect(clone.mock.calls.some(([value]) => value === docs.left || value === docs.right)).toBe(
      false,
    );
    expect(channel(docs.left).measurement).toBe(measurement);
    expect(measurement.impulse).toBe(impulse);
    expect(Object.isFrozen(measurement)).toBe(false);
    expect(Object.isFrozen(impulse)).toBe(false);
  } finally {
    clone.mockRestore();
  }
});
