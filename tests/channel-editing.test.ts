import { expect, it } from 'vitest';
import { newProject, newFilter, type Project, type Slot } from '../src/domain/model';
import { linkChannel } from '../src/domain/links';
import {
  planChannelEdit,
  applyChannelEdit,
  type ChannelEditPatch,
} from '../src/domain/channel-editing';
import { encodeChannel } from '../src/domain/dsp';
import { createWorkspaceStore } from '../src/state/workspace';
const where = { presetIndex: 0, channelIndex: 0 };
const channel = (p: Project, i = 0) => p.presets[0].channels[i];
function fixture() {
  const left = newProject('Left');
  channel(left).filters[0] = {
    ...newFilter('peak'),
    gain: 6,
    enabled: false,
    provenance: 'hfd',
    coefficients: { b0: 0.25, b1: 0.1, b2: 0, f1: 0.2, f2: 0.1 },
  };
  channel(left).additionalGain = 6;
  channel(left).coefficientCache = 'unresolved';
  const right = structuredClone(left);
  right.name = 'Right';
  return { left, right };
}
const plan = (docs: Record<Slot, Project>, patch: ChannelEditPatch) =>
  planChannelEdit(docs, ['left', 'right'], { ...where, patch }, 7);
function applied(docs: Record<Slot, Project>, p: ReturnType<typeof plan>) {
  const next = structuredClone(docs);
  for (const slot of [...p.changedSlots].reverse()) applyChannelEdit(next[slot], slot, p);
  return next;
}

it('refuses Both processing edits when only the selected role is independent, before any mutation', () => {
  const docs = fixture();
  linkChannel(docs.right.presets[0], 0, 1);
  const original = structuredClone(docs);
  expect(() => plan(docs, { gain: -6 })).toThrow(/linked|master/i);
  expect(docs).toEqual(original);
});

it.each(['gain', 'invert', 'muted', 'delayUs'] as const)(
  'preflights every root for requested %s even when the linked peer value is equal',
  (field) => {
    const docs = fixture();
    linkChannel(docs.right.presets[0], 0, 1);
    expect(() => plan(docs, { [field]: channel(docs.right)[field] })).toThrow(/linked|master/i);
  },
);

it('retains the linked exceptions for channel labels and sum membership without processing synchronization', () => {
  const docs = fixture();
  linkChannel(docs.right.presets[0], 0, 1);
  const original = structuredClone(docs),
    p = plan(docs, { name: 'Driver label', outputName: 'Output label', includeInSum: false }),
    result = applied(docs, p);
  expect(p.synchronizeLinks).toBe(false);
  for (const slot of ['left', 'right'] as const) {
    expect(channel(result[slot])).toMatchObject({
      name: 'Driver label',
      outputName: 'Output label',
      includeInSum: false,
    });
    expect(channel(result[slot]).filters).toEqual(channel(original[slot]).filters);
    expect(channel(result[slot]).additionalGain).toBe(channel(original[slot]).additionalGain);
    expect(channel(result[slot]).coefficientCache).toBe(channel(original[slot]).coefficientCache);
  }
});

it('sets global delay through its native callback while retaining linked and independent filter processing', () => {
  const docs = fixture();
  linkChannel(docs.right.presets[0], 0, 1);
  const before = structuredClone(docs),
    p = plan(docs, { globalDelayUs: 74666.6666667 }),
    next = applied(docs, p);
  expect(p.synchronizeLinks).toBe(false);
  expect(p.roles.every((role) => role.changes.length === 3)).toBe(true);
  for (const slot of ['left', 'right'] as const)
    for (const [i, c] of next[slot].presets[0].channels.entries()) {
      expect(c.globalDelayUs).toBe(74667);
      expect({
        ...c,
        globalDelayUs: before[slot].presets[0].channels[i].globalDelayUs,
        ...(i === 0 ? { hfdDelay: undefined } : {}),
      }).toEqual(
        i === 0
          ? { ...before[slot].presets[0].channels[i], hfdDelay: undefined }
          : before[slot].presets[0].channels[i],
      );
    }
});

it('retains complete no-op state including omitted default-true sum metadata, cache and provenance', () => {
  const docs = fixture(),
    before = structuredClone(docs);
  const p = plan(docs, {
    gain: 0,
    name: channel(docs.left).name,
    includeInSum: true,
  });
  expect(p.changedSlots).toEqual([]);
  expect(p.synchronizeLinks).toBe(false);
  expect(p.roles.every((role) => !role.changed && role.changes.length === 0)).toBe(true);
  expect(docs).toEqual(before);
  expect(Object.hasOwn(channel(docs.left), 'includeInSum')).toBe(false);
  expect(plan(docs, {}).changedSlots).toEqual([]);
});

it('changes only the role which differs and requires processing synchronization only for actual processing changes', () => {
  const docs = fixture();
  channel(docs.right).gain = -6;
  const peer = structuredClone(docs.right),
    p = plan(docs, { gain: -6 }),
    result = applied(docs, p);
  expect(p.changedSlots).toEqual(['left']);
  expect(p.synchronizeLinks).toBe(false);
  expect(p.roles.map((role) => role.synchronizeLinks)).toEqual([true, false]);
  expect(result.right).toEqual(peer);
  const labelsOnly = plan(docs, { gain: 0, outputName: 'New label' });
  expect(labelsOnly.roles.map((role) => role.synchronizeLinks)).toEqual([false, true]);
  channel(docs.right).gain = 0;
  expect(plan(docs, { gain: 0, outputName: 'New label' }).synchronizeLinks).toBe(false);
});

it('does not redesign vectors or silently resolve first-cache interpretation when ordinary channel scalars change', () => {
  const docs = fixture(),
    p = plan(docs, { gain: -6.123456789, invert: true, muted: true });
  const filters = channel(docs.left).filters,
    fir = channel(docs.left).fir;
  applyChannelEdit(docs.left, 'left', p);
  expect(channel(docs.left)).toMatchObject({
    gain: -6.12,
    invert: true,
    muted: true,
    delayUs: 0,
    additionalGain: 6,
    coefficientCache: 'unresolved',
  });
  expect(channel(docs.left).filters).toBe(filters);
  expect(channel(docs.left).fir).toBe(fir);
  expect(filters[0].provenance).toBe('hfd');
  expect(() => encodeChannel(channel(docs.left))).toThrow(/Resolve imported/);
});

it.each([
  { gain: -Infinity },
  { gain: Infinity },
  { gain: NaN },
  { invert: 1 },
  { muted: 'false' },
  { delayUs: NaN },
  { delayUs: 'invalid' },
  { globalDelayUs: Infinity },
  { globalDelayUs: 'invalid' },
  { additionalGain: 10 },
  { coefficientCache: 'base' },
  { linkedTo: 1 },
  { filters: [] },
] as unknown as ChannelEditPatch[])(
  'rejects invalid/unsupported ordinary patch %j without effects',
  (patch) => {
    const docs = fixture(),
      before = structuredClone(docs);
    expect(() => plan(docs, patch)).toThrow();
    expect(docs).toEqual(before);
  },
);

it.each(['id', 'root', 'cache', 'provenance', 'scalar'] as const)(
  'fences stale %s context at explicit-role apply without partial mutation',
  (change) => {
    const docs = fixture(),
      p = plan(docs, { gain: -6 }),
      next = structuredClone(docs.left);
    if (change === 'id') channel(next).id = 'other-channel';
    if (change === 'root') channel(next).linkedTo = 1;
    if (change === 'cache') channel(next).coefficientCache = 'base';
    if (change === 'provenance') channel(next).filters[0].provenance = 'panel';
    if (change === 'scalar') channel(next).additionalGain = 10;
    const before = structuredClone(next);
    expect(() => applyChannelEdit(next, 'left', p)).toThrow(/changed|linked|stale/i);
    expect(next).toEqual(before);
  },
);

it('rejects malformed links, aliases and invalid roles before planning a valid label update', () => {
  const changes: ((docs: Record<Slot, Project>) => void)[] = [
    (d) => {
      channel(d.right, 1).linkedTo = 2;
      channel(d.right, 2).linkedTo = 1;
    },
    (d) => {
      d.right = d.left;
    },
    (d) => {
      d.right.presets[0].channels[2] = d.left.presets[0].channels[2];
    },
    (d) => {
      d.right.presets[0].channels.pop();
    },
  ];
  for (const change of changes) {
    const docs = fixture();
    change(docs);
    const before = structuredClone(docs);
    expect(() => plan(docs, { name: 'Valid label' })).toThrow();
    expect(docs).toEqual(before);
  }
  const docs = fixture();
  expect(() =>
    planChannelEdit(docs, ['left', 'left'], { ...where, patch: { name: 'X' } }),
  ).toThrow();
});

it('uses explicit role rather than duplicate imported identity and leaves source and other presets untouched', () => {
  const docs = fixture();
  channel(docs.right).gain = -3;
  const before = structuredClone(docs),
    p = plan(docs, { gain: -6 }),
    next = applied(docs, p);
  expect(channel(next.left).gain).toBe(-6);
  expect(channel(next.right).gain).toBe(-6);
  expect(docs).toEqual(before);
  expect(next.left.presets.slice(1)).toEqual(before.left.presets.slice(1));
  expect(() => applyChannelEdit(structuredClone(docs.right), 'left', p)).toThrow(/changed|role/i);
});

async function workspace(documents = fixture()) {
  let saved: unknown = null;
  const { store, persistence } = createWorkspaceStore({
    read: async () => saved,
    write: async (value) => {
      saved = structuredClone(value);
    },
    readLegacy: () => null,
  });
  await persistence.hydrate();
  store.setState({ documents, past: [], future: [], gesture: undefined });
  return { state: store.getState, persistence };
}
it('publishes paired metadata once without rewriting dirty imported follower vectors/cache/provenance, with one exact Undo', async () => {
  const docs = fixture();
  for (const slot of ['left', 'right'] as const) {
    linkChannel(docs[slot].presets[0], 1, 0);
    Object.assign(channel(docs[slot], 1), { coefficientCache: 'effective', additionalGain: 10 });
    channel(docs[slot], 1).filters[0] = {
      ...newFilter('raw'),
      provenance: 'panel',
      coefficients: { b0: 0.125, b1: 0.375, b2: -0.25, f1: 0.125, f2: 0 },
    };
  }
  const f = await workspace(docs),
    before = structuredClone(f.state().documents),
    p = plan(f.state().documents, { name: 'Relabeled master' });
  expect(p.synchronizeLinks).toBe(false);
  f.state().editAt(p.changedSlots, (project, slot) => applyChannelEdit(project, slot, p), {
    synchronizeLinks: p.synchronizeLinks,
  });
  for (const slot of ['left', 'right'] as const) {
    const follower = channel(f.state().documents[slot], 1),
      old = channel(before[slot], 1);
    expect({ ...follower, globalDelayUs: old.globalDelayUs }).toEqual(old);
    expect(channel(f.state().documents[slot]).filters).toEqual(channel(before[slot]).filters);
  }
  expect(f.state().past).toHaveLength(1);
  f.state().undo();
  expect(f.state().documents).toEqual(before);
  await f.persistence.flush();
});

it('requests existing link propagation only for an actual processing change and skips no-op workspace history', async () => {
  const docs = fixture();
  linkChannel(docs.left.presets[0], 1, 0);
  const f = await workspace(docs),
    unchanged = structuredClone(f.state().documents),
    revision = f.state().documentRevision;
  const noop = plan(f.state().documents, { gain: 0, includeInSum: true });
  expect(noop.changedSlots).toEqual([]);
  // The shared UI/MCP caller does not open a transaction for this plan.
  if (noop.changedSlots.length)
    f.state().editAt(noop.changedSlots, (p, s) => applyChannelEdit(p, s, noop), {
      synchronizeLinks: noop.synchronizeLinks,
    });
  expect(f.state().documents).toEqual(unchanged);
  expect(f.state().documentRevision).toBe(revision);
  expect(f.state().past).toEqual([]);
  const change = plan(f.state().documents, { gain: -9, name: 'Master' });
  expect(change.synchronizeLinks).toBe(false);
  expect(change.roles[0].synchronizeLinks).toBe(true);
  f.state().editAt(change.changedSlots, (p, s) => applyChannelEdit(p, s, change), {
    synchronizeLinks: change.synchronizeLinks,
  });
  expect(channel(f.state().documents.left, 1).gain).toBe(-9);
  expect(channel(f.state().documents.left, 1).filters).toEqual(
    channel(f.state().documents.left).filters.map((f, i) => ({
      ...f,
      id: channel(unchanged.left, 1).filters[i].id,
      sourceId: channel(unchanged.left, 1).filters[i].sourceId,
    })),
  );
  expect(channel(f.state().documents.left, 1).name).toBe(channel(unchanged.left, 1).name);
  expect(f.state().past).toHaveLength(1);
  f.state().undo();
  expect(f.state().documents).toEqual(unchanged);
});

function dirtyFollower(project: Project) {
  linkChannel(project.presets[0], 1, 0);
  channel(project, 1).filters[0] = {
    ...newFilter('raw'),
    enabled: false,
    provenance: 'panel',
    coefficients: { b0: 0.125, b1: 0.375, b2: -0.25, f1: 0.125, f2: 0 },
  };
  channel(project, 1).coefficientCache = 'effective';
}

it('synchronizes only the genuinely processing-changed role in a mixed paired processing and metadata transaction', async () => {
  const docs = fixture();
  channel(docs.right).gain = -6;
  dirtyFollower(docs.left);
  dirtyFollower(docs.right);
  const f = await workspace(docs),
    before = structuredClone(f.state().documents);
  const p = plan(f.state().documents, { gain: -6, name: 'Both labels' });
  expect(p.changedSlots).toEqual(['left', 'right']);
  expect(p.synchronizeLinks).toBe(false);
  expect(p.roles.map((role) => role.synchronizeLinks)).toEqual([true, false]);
  f.state().editAt(p.changedSlots, (project, slot) => applyChannelEdit(project, slot, p), {
    synchronizeLinks: p.synchronizeLinks,
  });
  expect(channel(f.state().documents.left, 1).gain).toBe(-6);
  expect(channel(f.state().documents.right, 1)).toEqual(channel(before.right, 1));
  expect(f.state().past).toHaveLength(1);
  f.state().undo();
  expect(f.state().documents).toEqual(before);
  await f.persistence.flush();
});

it('retains an unrelated dirty linked group in the selected preset when an unlinked root Gain changes', () => {
  const docs = fixture();
  for (const slot of ['left', 'right'] as const) {
    linkChannel(docs[slot].presets[0], 2, 1);
    const follower = channel(docs[slot], 2);
    follower.gain = 3;
    follower.coefficientCache = 'effective';
    follower.filters[0] = {
      ...newFilter('raw'),
      enabled: false,
      provenance: 'panel',
      coefficients: { b0: 0.125, b1: 0.25, b2: -0.125, f1: 0.375, f2: 0 },
    };
  }
  const before = structuredClone(docs),
    p = plan(docs, { gain: -6 }),
    next = applied(docs, p);
  for (const slot of ['left', 'right'] as const) {
    expect(channel(next[slot]).gain).toBe(-6);
    expect(next[slot].presets[0].channels.slice(1)).toEqual(
      before[slot].presets[0].channels.slice(1),
    );
  }
});

it('propagates changed processing to the selected root followers while retaining other presets exactly', () => {
  const docs = fixture();
  for (const slot of ['left', 'right'] as const) {
    dirtyFollower(docs[slot]);
    for (const preset of docs[slot].presets.slice(1)) {
      linkChannel(preset, 2, 1);
      preset.channels[2].gain = 3;
      preset.channels[2].coefficientCache = 'effective';
      preset.channels[2].filters[0] = {
        ...newFilter('raw'),
        enabled: false,
        provenance: 'panel',
        coefficients: { b0: 0.125, b1: 0.25, b2: -0.125, f1: 0.375, f2: 0 },
      };
    }
  }
  const before = structuredClone(docs),
    p = plan(docs, { gain: -6 }),
    next = applied(docs, p);
  for (const slot of ['left', 'right'] as const) {
    expect(channel(next[slot], 1)).toMatchObject({
      gain: -6,
      delayUs: 0,
      coefficientCache: 'unresolved',
    });
    expect(channel(next[slot], 1).filters[0]).toMatchObject({
      ...channel(next[slot]).filters[0],
      id: channel(before[slot], 1).filters[0].id,
    });
    expect(next[slot].presets.slice(1)).toEqual(before[slot].presets.slice(1));
  }
});

it('preflights hardware gain visibility and independent roots for every requested role before publishing anything', () => {
  const docs = fixture();
  channel(docs.right).additionalGain = 0;
  const before = structuredClone(docs);
  expect(() => plan(docs, { hardwareGain: true })).toThrow(/right.*unavailable/i);
  expect(docs).toEqual(before);
  channel(docs.right).additionalGain = 10;
  linkChannel(docs.right.presets[0], 0, 1);
  expect(() => plan(docs, { hardwareGain: false })).toThrow(/right.*linked/i);
  expect(() => plan(docs, { hardwareGain: true, gain: 1 })).toThrow(/sole/i);
  expect(() => plan(docs, { hardwareGain: undefined })).toThrow(/boolean/i);
});

it('always evaluates explicit same-checked callbacks to normalize imported compensation and document hint, retaining all vectors', () => {
  const docs = fixture();
  channel(docs.left).gain = 18;
  channel(docs.right).gain = 18;
  docs.left.hfdGainLowered = false;
  docs.right.hfdGainLowered = false;
  const before = structuredClone(docs),
    p = plan(docs, { hardwareGain: true }),
    next = applied(docs, p);
  expect(p.changedSlots).toEqual(['left', 'right']);
  for (const slot of ['left', 'right'] as const) {
    expect(channel(next[slot])).toMatchObject({
      gain: 14,
      additionalGain: 10,
      coefficientCache: 'unresolved',
    });
    expect(next[slot].hfdGainLowered).toBe(true);
    expect(channel(next[slot]).filters).toEqual(channel(before[slot]).filters);
    expect(p.roles.find((role) => role.slot === slot)?.hardwareGain?.result.gainText).toBe('14.00');
  }
  expect(docs).toEqual(before);
});

it('retains dirty followers when only compensation and the local document hint change, with one exact paired Undo', async () => {
  const docs = fixture();
  for (const slot of ['left', 'right'] as const) {
    channel(docs[slot]).gain = 12;
    dirtyFollower(docs[slot]);
    docs[slot].hfdGainLowered = true;
  }
  const f = await workspace(docs),
    before = structuredClone(f.state().documents),
    p = plan(f.state().documents, { hardwareGain: false });
  expect(p.roles.every((role) => !role.synchronizeLinks)).toBe(true);
  f.state().editAt(p.changedSlots, (project, slot) => applyChannelEdit(project, slot, p), {
    synchronizeLinks: p.synchronizeLinks,
  });
  for (const slot of ['left', 'right'] as const) {
    expect(channel(f.state().documents[slot])).toMatchObject({ gain: 12, additionalGain: 0 });
    expect(f.state().documents[slot].hfdGainLowered).toBe(false);
    expect(channel(f.state().documents[slot], 1)).toEqual(channel(before[slot], 1));
    expect(channel(f.state().documents[slot]).filters).toEqual(channel(before[slot]).filters);
  }
  expect(f.state().past).toHaveLength(1);
  f.state().undo();
  expect(f.state().documents).toEqual(before);
  await f.persistence.flush();
});

it('propagates the explicit compensation callback only in the role whose coupled ordinary Gain actually changes', async () => {
  const docs = fixture();
  channel(docs.left).gain = 18;
  channel(docs.right).gain = 12;
  dirtyFollower(docs.left);
  dirtyFollower(docs.right);
  const f = await workspace(docs),
    before = structuredClone(f.state().documents),
    p = plan(f.state().documents, { hardwareGain: true });
  expect(p.roles.map((role) => role.synchronizeLinks)).toEqual([true, false]);
  f.state().editAt(p.changedSlots, (project, slot) => applyChannelEdit(project, slot, p), {
    synchronizeLinks: p.synchronizeLinks,
  });
  expect(channel(f.state().documents.left)).toMatchObject({ gain: 14, additionalGain: 10 });
  expect(channel(f.state().documents.left, 1).gain).toBe(14);
  expect(channel(f.state().documents.right)).toMatchObject({ gain: 12, additionalGain: 10 });
  expect(channel(f.state().documents.right, 1)).toEqual(channel(before.right, 1));
  expect(f.state().documents.left.presets.slice(1)).toEqual(before.left.presets.slice(1));
  expect(f.state().past).toHaveLength(1);
  f.state().undo();
  expect(f.state().documents).toEqual(before);
  await f.persistence.flush();
});

it('admits Off then On only through the same trusted visible context and uses captured field Text, not arbitrary AdditionalGain', () => {
  const docs = fixture(),
    off = applied(docs, plan(docs, { hardwareGain: false }));
  expect(() => plan(off, { hardwareGain: true })).toThrow(/unavailable/);
  const p = planChannelEdit(
    off,
    ['left', 'right'],
    { ...where, patch: { hardwareGain: true } },
    7,
    {
      hardwareGainContext: {
        left: { available: true, gainText: '17.955' },
        right: { available: true, gainText: '-2.345' },
      },
    },
  );
  const next = applied(off, p);
  expect(channel(next.left)).toMatchObject({ gain: 14, additionalGain: 10 });
  expect(channel(next.right)).toMatchObject({ gain: -2.35, additionalGain: 10 });
  expect(p.roles[1].hardwareGain?.result.gainText).toBe('-2.35');
  expect(() =>
    planChannelEdit(off, ['left'], { ...where, patch: { hardwareGain: true } }, 7, {
      hardwareGainContext: { left: { available: true, gainText: 'NaN' } },
    }),
  ).toThrow();
});

it('skips genuine compensation no-ops, repairs a conflicting hint, and fences changes to that hint before apply', () => {
  const docs = fixture();
  for (const slot of ['left', 'right'] as const) {
    channel(docs[slot]).additionalGain = 10;
    docs[slot].hfdGainLowered = true;
  }
  const p = plan(docs, { hardwareGain: true });
  expect(p.changedSlots).toEqual([]);
  expect(p.roles.every((role) => !role.synchronizeLinks)).toBe(true);
  docs.right.hfdGainLowered = false;
  const hint = plan(docs, { hardwareGain: true });
  expect(hint.changedSlots).toEqual(['right']);
  expect(hint.roles[1].changes).toEqual([]);
  const next = structuredClone(docs.right);
  next.hfdGainLowered = true;
  const before = structuredClone(next);
  expect(() => applyChannelEdit(next, 'right', hint)).toThrow(/hint.*changed/i);
  expect(next).toEqual(before);
  expect(applied(docs, hint).right.hfdGainLowered).toBe(true);
});
