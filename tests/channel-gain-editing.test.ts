import { expect, it } from 'vitest';
import { newProject, newFilter, type Project, type Slot } from '../src/domain/model';
import {
  applyChannelEdit,
  planChannelEdit,
  type ChannelEditPatch,
} from '../src/domain/channel-editing';
import { encodeChannel } from '../src/domain/dsp';
import { linkChannel } from '../src/domain/links';
import { hfdChannelGainWheelNext } from '../src/domain/channel-gain';

const at = { presetIndex: 0, channelIndex: 0 };
const channel = (project: Project) => project.presets[0].channels[0];
function fixture() {
  const left = newProject('Left'),
    right = newProject('Right');
  for (const [project, b0] of [
    [left, 0.25],
    [right, 0.75],
  ] as const) {
    channel(project).filters[0] = {
      ...newFilter('raw'),
      coefficients: { b0, b1: 0, b2: 0, f1: 0, f2: 0 },
      provenance: 'hfd',
    };
    channel(project).coefficientCache = 'base';
  }
  return { left, right };
}
function plan(documents: Record<Slot, Project>, patch: ChannelEditPatch) {
  return planChannelEdit(documents, ['left', 'right'], { ...at, patch }, 7);
}
function apply(documents: Record<Slot, Project>, value: ReturnType<typeof plan>) {
  const result = structuredClone(documents);
  for (const slot of value.changedSlots) applyChannelEdit(result[slot], slot, value);
  return result;
}

// Actual V48 native Gain literals in synthetic containers, not helper-generated or full native XML.
// Minimum Save SHA256 31b55f82cd862d437c82ec5cb9c6d457c1cbf93e564f1ff6acafbb382ace454a.
// Maximum Save SHA256 5c6132add0fb06c22c0c55d7db1819225bf0dbc00c7ac51796032320200cc197.
// Half-cent Save SHA256 107c266b31ed09500290aaf68565fc8e90584ba49eab73a052c91b4e1d7e7f57.
it.each([
  ['-125.0001', -125],
  ['24.0001', 24],
  ['0.005', 0.01],
] as const)(
  'normalizes native channel Gain input %s and preserves every retained cache',
  (input, expected) => {
    const docs = fixture(),
      before = structuredClone(docs);
    const value = plan(docs, { gain: input }),
      next = apply(docs, value);
    for (const slot of ['left', 'right'] as const) {
      expect(channel(next[slot]).gain).toBe(expected);
      expect({ ...channel(next[slot]), gain: channel(before[slot]).gain }).toEqual(
        channel(before[slot]),
      );
      expect(next[slot].presets.slice(1)).toEqual(before[slot].presets.slice(1));
    }
    expect(docs).toEqual(before);
  },
);

it('normalizes the original raw request independently instead of mirroring a source compensation cap', () => {
  // Native08 raw18/Add10 saved14: SHA256 035db7f285252554733602bf8665f2e0f774d634b35d3ebfaf8baedf4f59163e.
  // The independent peer and already-capped source here test the browser paired-edit contract.
  const docs = fixture();
  Object.assign(channel(docs.left), { gain: 14, additionalGain: 10 });
  channel(docs.right).additionalGain = 0;
  const value = plan(docs, { gain: '18' }),
    next = apply(docs, value);
  expect(value.changedSlots).toEqual(['right']);
  expect(value.roles.map((role) => role.gainResult)).toEqual([
    { text: '14.00', value: 14 },
    { text: '18.00', value: 18 },
  ]);
  expect(channel(next.left).gain).toBe(14);
  expect(channel(next.right).gain).toBe(18);
});

it('keeps unresolved first-cache refusal after a native channel Gain normalization', () => {
  const docs = fixture();
  channel(docs.left).coefficientCache = 'unresolved';
  const next = apply(docs, plan(docs, { gain: 24 }));
  expect(channel(next.left).coefficientCache).toBe('unresolved');
  expect(channel(next.left).filters).toEqual(channel(docs.left).filters);
  expect(() => encodeChannel(channel(next.left))).toThrow(/Resolve imported/);
});

it('steps each independent role from its own canonical gain and compensation', () => {
  // Native09 saved13.95/Add10 -> native10 wheel saved14;09 SHA256
  // 8e6a0df28c237054cdd1e5bd7875676d05156396ef2d98b6bbd66c9a466df1c4.
  const docs = fixture();
  Object.assign(channel(docs.left), { gain: 13.95, additionalGain: 10 });
  Object.assign(channel(docs.right), { gain: 2, additionalGain: 0 });
  const value = plan(docs, { gainWheel: { direction: 1 } });
  const next = apply(docs, value);
  expect(channel(next.left).gain).toBe(14);
  expect(channel(next.right).gain).toBe(2.1);
});

it('matches the saved 0.01 to 0.11 native one-event wheel result without changing retained vectors', () => {
  // Native wheel Save SHA256 9445d0f21988e1eee93d63e9066529171f04f78524783f8be9ce1a5c1301ed38.
  const docs = fixture();
  channel(docs.left).gain = 0.01;
  const value = planChannelEdit(docs, ['left'], { ...at, patch: { gainWheel: { direction: 1 } } });
  const next = apply(docs, value);
  expect(channel(next.left).gain).toBe(0.11);
  expect({ ...channel(next.left), gain: 0.01 }).toEqual(channel(docs.left));
  expect(next.right).toEqual(docs.right);
});

it('mirrors a changed source result through the peer callback without re-normalizing the source result', () => {
  const docs = fixture();
  Object.assign(channel(docs.left), { gain: 18, additionalGain: 0 });
  Object.assign(channel(docs.right), { gain: 0, additionalGain: 10 });
  const value = plan(docs, {
    gainWheel: { direction: 1, basis: 'left' },
  });
  const next = apply(docs, value);
  expect(channel(next.left).gain).toBe(18.1);
  expect(channel(next.right).gain).toBe(14);
});

it('does not mirror a canonical source no-op into a differing peer', () => {
  // Native11 repeat-wheel Save was byte-identical to10 at14/Add10. Equal
  // saved state does not establish native callback count or a stereo mirror.
  const docs = fixture();
  Object.assign(channel(docs.left), { gain: 14, additionalGain: 10 });
  Object.assign(channel(docs.right), { gain: 2, additionalGain: 0 });
  const before = structuredClone(docs);
  const value = plan(docs, {
    gainWheel: { direction: 1, basis: 'left' },
  });
  expect(value.changedSlots).toEqual([]);
  expect(apply(docs, value)).toEqual(before);
});

it('preflights a linked peer even when the source wheel is a canonical no-op', () => {
  const docs = fixture();
  Object.assign(channel(docs.left), { gain: 14, additionalGain: 10 });
  linkChannel(docs.right.presets[0], 0, 1);
  const before = structuredClone(docs);
  expect(() => plan(docs, { gainWheel: { direction: 1, basis: 'left' } })).toThrow(
    /linked|master/i,
  );
  expect(docs).toEqual(before);
});

it('retains context fences for a wheel plan when AdditionalGain or a saved vector changes', () => {
  const docs = fixture();
  const value = plan(docs, { gainWheel: { direction: 1 } });
  for (const change of [
    (project: Project) => {
      channel(project).additionalGain = 10;
    },
    (project: Project) => {
      channel(project).filters[0].coefficients!.b0 = 0.125;
    },
  ]) {
    const changed = structuredClone(docs.left);
    change(changed);
    const before = structuredClone(changed);
    expect(() => applyChannelEdit(changed, 'left', value)).toThrow(/changed/);
    expect(changed).toEqual(before);
  }
});

it('uses a trusted current field event once, without copying its opaque state or recomputing its source', () => {
  const docs = fixture();
  channel(docs.left).additionalGain = 10;
  const result = hfdChannelGainWheelNext(0, 1, { displayedText: '13.95', additionalGain: 10 });
  const source = {
    slot: 'left' as const,
    channelId: channel(docs.left).id,
    expectedGain: 0,
    expectedAdditionalGain: 10,
    result,
  };
  const value = planChannelEdit(
    docs,
    ['left', 'right'],
    { ...at, patch: { gainWheel: { direction: 1, basis: 'left' } } },
    7,
    { gainWheelSourceEvent: source },
  );
  expect(value.roles[0].gainWheelResult).toEqual({ text: '14.00', value: 14, changed: true });
  expect(Object.hasOwn(value.roles[0].gainWheelResult!, 'state')).toBe(false);
  expect(apply(docs, value).left.presets[0].channels[0].gain).toBe(14);
  for (const stale of [
    { ...source, channelId: 'replacement' },
    { ...source, expectedGain: 1 },
    { ...source, expectedAdditionalGain: 0 },
    { ...source, result: { ...result, changed: false } },
  ])
    expect(() =>
      planChannelEdit(
        docs,
        ['left', 'right'],
        { ...at, patch: { gainWheel: { direction: 1, basis: 'left' } } },
        7,
        { gainWheelSourceEvent: stale },
      ),
    ).toThrow(/source changed/);
  expect(() =>
    planChannelEdit(docs, ['left'], { ...at, patch: { gainWheel: { direction: 1 } } }, 7, {
      gainWheelSourceEvent: source,
    }),
  ).toThrow(/fixed wheel basis/);
});

it.each([
  { gainWheel: { direction: 0 } },
  { gainWheel: { direction: 1, basis: 'other' } },
  { gainWheel: { direction: 1, state: {} } },
  { gainWheel: { direction: 1 }, gain: 1 },
  { gainWheel: { direction: 1 }, hardwareGain: false },
])('rejects malformed or mixed wheel intent %j atomically', (patch) => {
  const docs = fixture(),
    before = structuredClone(docs);
  expect(() => plan(docs, patch as unknown as ChannelEditPatch)).toThrow(/sole valid intent/);
  expect(docs).toEqual(before);
});

// Independent Decimal(80 digits) predictions for a unity first section:
// roundHalfEven(10**(dB/20)*2**24). These are software words, not native USB evidence.
it.each([
  [-125, 9],
  [24, 265900954],
] as const)('compiles Gain %s with the independent Q24 scale word', (gain, word) => {
  const c = channel(newProject());
  c.gain = gain;
  expect(new DataView(encodeChannel(c).buffer).getInt32(12, true)).toBe(word);
});

it('applies compensation once and retains Q24 overflow refusal after expanding the channel range', () => {
  const c = channel(newProject());
  c.gain = 14;
  c.additionalGain = 10;
  expect(new DataView(encodeChannel(c).buffer).getInt32(12, true)).toBe(265900954);
  c.gain = 24;
  c.additionalGain = 0;
  c.filters[0] = { ...newFilter('raw'), coefficients: { b0: 16, b1: 0, b2: 0, f1: 0, f2: 0 } };
  expect(() => encodeChannel(c)).toThrow(/Q8.24 range/);
});

it('does not use authoring clamping to admit out-of-range or nonfinite imported Gain at compile time', () => {
  for (const gain of [-125.01, 24.01, NaN]) {
    const c = channel(newProject());
    c.gain = gain;
    expect(() => encodeChannel(c)).toThrow(/Channel gain outside/);
    expect(Object.is(c.gain, gain)).toBe(true);
  }
});
