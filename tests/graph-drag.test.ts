import { expect, it } from 'vitest';
import { newFilter, newProject, type Filter, type Project, type Slot } from '../src/domain/model';
import {
  captureManualFilterDrag,
  planManualFilterDrag,
  applyManualFilterDrag,
} from '../src/domain/graph-drag';

const location = { presetIndex: 0, channelIndex: 0, filterIndex: 0 };
const pointer = (frequency = 1000, delta = 0) => ({ frequency, originAxisY: 0, axisY: delta });
function fixture() {
  const left = newProject('Left');
  left.presets[0].channels[0].filters[0] = {
    ...newFilter('peak'),
    frequency: 1000,
    gain: 3,
    enabled: false,
    sourceId: 'native-13',
    provenance: 'hfd',
    coefficients: { b0: 0.5, b1: 0.2, b2: 0.1, f1: 0.3, f2: 0.1 },
  };
  left.presets[0].channels[0].coefficientCache = 'unresolved';
  const right = structuredClone(left);
  right.name = 'Right';
  right.presets[0].channels[0].filters[0].gain = -2;
  return { left, right };
}
const filter = (p: Project) => p.presets[0].channels[0].filters[0];
function apply(documents: Record<Slot, Project>, plan: ReturnType<typeof planManualFilterDrag>) {
  const next = structuredClone(documents);
  // Deliberately reversed order: explicit role is authoritative, not identity
  // inferred from a project UUID, filter ID or callback iteration order.
  for (const slot of [...plan.changedSlots].reverse())
    applyManualFilterDrag(next[slot], slot, plan);
  return next;
}

it('captures independent origins and applies the same absolute Single frequency with each role own relative gain', () => {
  const docs = fixture(),
    original = structuredClone(docs),
    capture = captureManualFilterDrag(docs, ['left', 'right'], location, 4);
  const plan = planManualFilterDrag(docs, capture, pointer(6319.0052, 1), 4),
    result = apply(docs, plan);
  expect(filter(result.left)).toMatchObject({
    frequency: 6319.00537109375,
    gain: 4,
    enabled: false,
    sourceId: 'native-13',
  });
  expect(filter(result.right)).toMatchObject({
    frequency: 6319.00537109375,
    gain: -1,
    enabled: false,
  });
  expect(filter(result.left).coefficients).toBeUndefined();
  expect(filter(result.right).provenance).toBeUndefined();
  expect(result.left.presets[0].channels[0].coefficientCache).toBe('base');
  expect(docs).toEqual(original);
  expect(plan.nextCapture.revision).toBe(5);
  expect(Object.isFrozen(capture.roles[0].originFilter)).toBe(true);
});

it('keeps original role gains through repeated/clamped moves, including convergence with identical IDs then divergence', () => {
  let docs = fixture(),
    capture = captureManualFilterDrag(docs, ['left', 'right'], location, 0);
  const high = planManualFilterDrag(docs, capture, pointer(1000, 100), 0);
  docs = apply(docs, high);
  capture = high.nextCapture;
  expect(filter(docs.left).gain).toBe(24);
  expect(filter(docs.right).gain).toBe(24);
  expect(filter(docs.left).id).toBe(filter(docs.right).id);
  const repeated = planManualFilterDrag(docs, capture, pointer(1000, 100), 1);
  expect(repeated.changedSlots).toEqual([]);
  const back = planManualFilterDrag(docs, capture, pointer(1000, 5), 1),
    result = apply(docs, back);
  expect(filter(result.left).gain).toBe(8);
  expect(filter(result.right).gain).toBe(3);
  expect(capture.roles[0].originFilter.gain).toBe(3);
  expect(capture.roles[1].originFilter.gain).toBe(-2);
});

it('preserves canonical no-op caches/provenance/bypass and a matching peer whole document', () => {
  const docs = fixture();
  filter(docs.left).gain = 24;
  filter(docs.right).gain = 24;
  const capture = captureManualFilterDrag(docs, ['left', 'right'], location, 0);
  const noop = planManualFilterDrag(docs, capture, pointer(1000, 100), 0);
  expect(noop.changedSlots).toEqual([]);
  expect(noop.nextCapture).toBe(capture);
  expect(noop.roles.every((role) => role.nextFilter.provenance === 'hfd')).toBe(true);
  filter(docs.left).gain = 23;
  const nextCapture = captureManualFilterDrag(docs, ['left', 'right'], location, 0),
    peer = structuredClone(docs.right);
  const next = planManualFilterDrag(docs, nextCapture, pointer(1000, 1), 0),
    result = apply(docs, next);
  expect(next.changedSlots).toEqual(['left']);
  expect(result.right).toEqual(peer);
});

it('does not round high-precision gain on a horizontal-only move or involve channel/AdditionalGain', () => {
  const docs = fixture(),
    before = 7.555123456789;
  filter(docs.left).gain = before;
  docs.left.presets[0].channels[0].gain = 24;
  docs.left.presets[0].channels[0].additionalGain = 10;
  const capture = captureManualFilterDrag(docs, ['left'], location);
  const moved = apply(docs, planManualFilterDrag(docs, capture, pointer(1500.123456789)));
  expect(filter(moved.left).gain).toBe(before);
  expect(filter(moved.left).frequency).toBe(Math.fround(1500.123456789));
  const vertical = apply(docs, planManualFilterDrag(docs, capture, pointer(1000, 1)));
  expect(filter(vertical.left).gain).toBe(8.56);
});

it.each(['asymmetric', 'allpass1', 'allpass2', 'lowpass2'] as const)(
  'retains %s latent gain/F2/Q2 when a linked Peak has a vertical component',
  (kind) => {
    const docs = fixture();
    Object.assign(filter(docs.right), {
      kind,
      gain: 17.123456789,
      frequency2: 988.101806640625,
      q2: 1.301,
    });
    const before = structuredClone(filter(docs.right)),
      capture = captureManualFilterDrag(docs, ['left', 'right'], location);
    const result = apply(docs, planManualFilterDrag(docs, capture, pointer(1500, 3)));
    expect(filter(result.right)).toMatchObject({
      kind,
      frequency: 1500,
      gain: before.gain,
      frequency2: before.frequency2,
      q2: before.q2,
      enabled: false,
    });
    expect(filter(result.left).gain).toBe(6);
  },
);

it('never resolves an unrelated first cache when editing another slot and retains native shelf direction metadata', () => {
  const docs = fixture(),
    channel = docs.left.presets[0].channels[0];
  channel.filters[3] = {
    ...newFilter('lowshelf2'),
    gain: 3,
    sourceShelfDirection: 'stUnknown',
    provenance: 'panel',
  };
  const first = structuredClone(channel.filters[0]),
    capture = captureManualFilterDrag(docs, ['left'], { ...location, filterIndex: 3 });
  const result = apply(docs, planManualFilterDrag(docs, capture, pointer(1500, 1)));
  expect(result.left.presets[0].channels[0].coefficientCache).toBe('unresolved');
  expect(result.left.presets[0].channels[0].filters[0]).toEqual(first);
  expect(result.left.presets[0].channels[0].filters[3]).toMatchObject({
    gain: 4,
    sourceShelfDirection: 'stUnknown',
  });
});

it.each(['raw', 'unity'] as const)(
  'refuses a %s peer atomically instead of writing latent marker parameters',
  (kind) => {
    const docs = fixture(),
      original = structuredClone(docs);
    filter(docs.right).kind = kind;
    expect(() => captureManualFilterDrag(docs, ['left', 'right'], location)).toThrow(
      /graph|marker/i,
    );
    filter(docs.right).kind = original.right.presets[0].channels[0].filters[0].kind;
    expect(docs).toEqual(original);
  },
);

it.each(['filter', 'native-enum', 'cache', 'channel-id', 'link', 'revision'] as const)(
  'refuses a stale %s context before any plan or mutation',
  (change) => {
    const docs = fixture(),
      capture = captureManualFilterDrag(docs, ['left', 'right'], location, 4);
    if (change === 'filter') filter(docs.right).id = 'different-filter';
    if (change === 'native-enum') filter(docs.right).sourceShelfDirection = 'stUnknown';
    if (change === 'cache') docs.right.presets[0].channels[0].coefficientCache = 'base';
    if (change === 'channel-id') docs.right.presets[0].channels[0].id = 'other-channel';
    if (change === 'link') docs.right.presets[0].channels[0].linkedTo = 1;
    const before = structuredClone(docs);
    expect(() =>
      planManualFilterDrag(docs, capture, pointer(1500, 1), change === 'revision' ? 5 : 4),
    ).toThrow(/changed|stale|linked/i);
    expect(docs).toEqual(before);
  },
);

it('fences explicit apply roles and stale metadata even after a plan has been prepared', () => {
  const docs = fixture(),
    capture = captureManualFilterDrag(docs, ['left', 'right'], location),
    plan = planManualFilterDrag(docs, capture, pointer(1500, 1));
  const right = structuredClone(docs.right);
  expect(() => applyManualFilterDrag(right, 'left', plan)).toThrow(/changed|role/i);
  expect(right).toEqual(docs.right);
  const changed = structuredClone(docs.left);
  filter(changed).provenance = 'panel';
  const before = structuredClone(changed);
  expect(() => applyManualFilterDrag(changed, 'left', plan)).toThrow(/changed/i);
  expect(changed).toEqual(before);
});

it('refuses malformed/aliased/linked targets and nonfinite pointer coordinates without modifying either role', () => {
  const cases: ((docs: Record<Slot, Project>) => void)[] = [
    (docs) => {
      docs.right.presets[0].channels[0].linkedTo = 1;
    },
    (docs) => {
      docs.right.presets[0].channels[1].linkedTo = 2;
      docs.right.presets[0].channels[2].linkedTo = 1;
    },
    (docs) => {
      docs.right.presets[0].channels[0].filters.pop();
    },
    (docs) => {
      docs.right = docs.left;
    },
    (docs) => {
      docs.right.presets[0].channels[1] = docs.left.presets[0].channels[1];
    },
    (docs) => {
      filter(docs.right).gain = NaN;
    },
  ];
  for (const change of cases) {
    const docs = fixture();
    change(docs);
    const before = structuredClone(docs);
    expect(() => captureManualFilterDrag(docs, ['left', 'right'], location)).toThrow();
    expect(docs).toEqual(before);
  }
  const docs = fixture(),
    capture = captureManualFilterDrag(docs, ['left'], location);
  for (const bad of [pointer(NaN), pointer(Infinity), pointer(1000, -Infinity)])
    expect(() => planManualFilterDrag(docs, capture, bad)).toThrow(/finite/i);
});
