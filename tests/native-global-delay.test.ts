import { expect, it, vi } from 'vitest';
import { newProject } from '../src/domain/model';
import {
  planNativeGlobalDelayReconciliation as plan,
  applyNativeGlobalDelayReconciliation as apply,
  type NativeGlobalDelayReconciliationPlan,
} from '../src/domain/native-global-delay';

function fixture(equal = false) {
  const project = newProject('Synthetic raw native Global reconciliation');
  const delays = equal
    ? [
        [17, 17, 17],
        [101, 101, 101],
        [203, 203, 203],
      ]
    : [
        [17, 29, 43],
        [101, 113, 127],
        [203, 227, 251],
      ];
  const maxima = [
    [70001, 70003, 70007],
    [71001, 71003, 71007],
    [72001, 72003, 72007],
  ];
  for (let p = 0; p < 3; p++)
    for (let c = 0; c < 3; c++) {
      const channel = project.presets[p].channels[c];
      channel.globalDelayUs = delays[p][c];
      channel.hfdDelay = { localMaximum: 19 + c, globalMaximum: maxima[p][c] };
    }
  return project;
}

// Literal E/D matrices match the parent-owned offline native oracle. These
// containers exercise the shared operation, not native file/GUI replay.
it('does not reconcile maxima when all three raw Global values already agree', () => {
  const project = fixture(true),
    before = structuredClone(project);
  for (let p = 0; p < 3; p++) {
    const value = plan(project, p);
    expect(value.changed).toBe(false);
    expect(value.channelChanges).toEqual([]);
    apply(project, value);
  }
  expect(project).toEqual(before);
});

it('copies the first raw value and maximum only in the explicitly requested preset', () => {
  const project = fixture(),
    before = structuredClone(project),
    value = plan(project, 2);
  expect(value.channelChanges.map((c) => c.channelIndex)).toEqual([1, 2]);
  expect(project).toEqual(before);
  apply(project, value);
  expect(
    project.presets[2].channels.map((c) => [c.globalDelayUs, c.hfdDelay?.globalMaximum]),
  ).toEqual([
    [203, 72001],
    [203, 72001],
    [203, 72001],
  ]);
  expect(project.presets.slice(0, 2)).toEqual(before.presets.slice(0, 2));
  apply(project, plan(project, 0));
  expect(project.presets[0].channels.map((c) => c.globalDelayUs)).toEqual([17, 17, 17]);
  expect(project.presets[1]).toEqual(before.presets[1]);
});

it('preserves raw fractional Double values and maxima without Text/sample normalization', () => {
  const project = fixture(),
    channels = project.presets[0].channels;
  channels[0].globalDelayUs = 17.1234567890123;
  channels[0].hfdDelay!.globalMaximum = 74666.6666666667;
  apply(project, plan(project, 0));
  expect(channels.map((c) => c.globalDelayUs)).toEqual(Array(3).fill(17.1234567890123));
  expect(channels.map((c) => c.hfdDelay?.globalMaximum)).toEqual(Array(3).fill(74666.6666666667));
});

it('uniform legacy values need no first maximum and do not create optional metadata', () => {
  const project = fixture(true),
    channels = project.presets[0].channels;
  delete channels[0].hfdDelay;
  delete channels[1].hfdDelay!.globalMaximum;
  const before = structuredClone(project),
    value = plan(project, 0);
  expect(value.changed).toBe(false);
  apply(project, value);
  expect(project).toEqual(before);
  expect(Object.hasOwn(channels[0], 'hfdDelay')).toBe(false);
});

it('treats all signed zeros as equal without rewriting their signs or requiring Max', () => {
  const project = fixture(),
    channels = project.presets[0].channels;
  [0, -0, 0].forEach((v, i) => {
    channels[i].globalDelayUs = v;
    delete channels[i].hfdDelay;
  });
  const value = plan(project, 0);
  expect(value.changed).toBe(false);
  apply(project, value);
  expect(channels.map((c) => Object.is(c.globalDelayUs, -0))).toEqual([false, true, false]);
});

it.each([0, -0])(
  'copies first zero exact sign when a third value activates reconciliation (%s)',
  (zero) => {
    const project = fixture(),
      channels = project.presets[0].channels;
    channels[0].globalDelayUs = zero;
    channels[1].globalDelayUs = Object.is(zero, -0) ? 0 : -0;
    channels[2].globalDelayUs = 1;
    apply(project, plan(project, 0));
    expect(channels.every((c) => Object.is(c.globalDelayUs, zero))).toBe(true);
  },
);

it('does not impose profile minima, maxima or formatting budgets on finite raw values', () => {
  const project = fixture(),
    channels = project.presets[0].channels;
  channels[0].globalDelayUs = -17.125;
  channels[0].hfdDelay!.globalMaximum = -123.5;
  apply(project, plan(project, 0));
  expect(channels.map((c) => [c.globalDelayUs, c.hfdDelay?.globalMaximum])).toEqual(
    Array.from({ length: 3 }, () => [-17.125, -123.5]),
  );
});

it.each([undefined, NaN, Infinity, -Infinity])(
  'refuses a mismatched value set with invalid first maximum %s',
  (maximum) => {
    const project = fixture();
    project.presets[0].channels[0].hfdDelay!.globalMaximum = maximum;
    const before = structuredClone(project);
    expect(() => plan(project, 0)).toThrow(/first.*maximum/i);
    expect(project).toEqual(before);
  },
);

it.each([NaN, Infinity, -Infinity])(
  'preflights an invalid third raw value %s before any mutation',
  (value) => {
    const project = fixture();
    project.presets[0].channels[2].globalDelayUs = value;
    const before = structuredClone(project);
    expect(() => plan(project, 0)).toThrow(/finite/i);
    expect(project).toEqual(before);
  },
);

it.each(['id', 'value', 'maximum'] as const)(
  'rejects stale third channel %s before applying the first change',
  (field) => {
    const project = fixture(),
      value = plan(project, 0),
      target = project.presets[0].channels[2];
    if (field === 'id') target.id += '-new';
    if (field === 'value') target.globalDelayUs = 99;
    if (field === 'maximum') target.hfdDelay!.globalMaximum = 99;
    const before = structuredClone(project);
    expect(() => apply(project, value)).toThrow(/context changed/i);
    expect(project).toEqual(before);
  },
);

it('preserves current local maxima and all unrelated object identity without taking bulk snapshots', () => {
  const project = fixture(),
    channels = project.presets[0].channels;
  channels[1].measurement = { name: 'Retained impulse', sampleRate: 48000, impulse: [1, 0, 0.5] };
  channels[1].linkedTo = 0;
  channels[1].additionalGain = 10;
  channels[1].coefficientCache = 'unresolved';
  const measurement = channels[1].measurement,
    filters = channels[1].filters,
    fir = channels[1].fir;
  const clone = vi.spyOn(globalThis, 'structuredClone');
  let value: NativeGlobalDelayReconciliationPlan;
  try {
    value = plan(project, 0);
    expect(clone).not.toHaveBeenCalled();
  } finally {
    clone.mockRestore();
  }
  channels[1].hfdDelay!.localMaximum = 123.456789;
  apply(project, value!);
  expect(channels[1].hfdDelay!.localMaximum).toBe(123.456789);
  expect(channels[1].measurement).toBe(measurement);
  expect(channels[1].filters).toBe(filters);
  expect(channels[1].fir).toBe(fir);
  expect(channels[1]).toMatchObject({
    linkedTo: 0,
    additionalGain: 10,
    coefficientCache: 'unresolved',
  });
  expect(Object.isFrozen(measurement)).toBe(false);
  expect(Object.isFrozen(measurement.impulse)).toBe(false);
  expect(Object.isFrozen(value!)).toBe(true);
  expect(Object.isFrozen(value!.beforeChannels)).toBe(true);
  expect(
    value!.channelChanges.every(
      (c) => Object.isFrozen(c) && Object.isFrozen(c.before) && Object.isFrozen(c.value),
    ),
  ).toBe(true);
});

it('refuses a forged change vector without partial writes', () => {
  const project = fixture(),
    value = plan(project, 0),
    before = structuredClone(project);
  const forged = {
    ...value,
    channelChanges: value.channelChanges.map((c, i) =>
      i === 1 ? { ...c, value: { ...c.value, globalDelayUs: 999 } } : c,
    ),
  };
  expect(() => apply(project, forged)).toThrow(/invalid.*changes/i);
  expect(project).toEqual(before);
});

it('preflights a stale no-op plan as well as an active plan', () => {
  const project = fixture(true),
    value = plan(project, 0);
  project.presets[0].channels[2].hfdDelay!.globalMaximum = 7;
  expect(() => apply(project, value)).toThrow(/context changed/i);
});

it('fills missing destination maxima only after a mismatched value activates the copy', () => {
  const project = fixture(),
    channels = project.presets[0].channels;
  delete channels[1].hfdDelay;
  delete channels[2].hfdDelay!.globalMaximum;
  apply(project, plan(project, 0));
  expect(channels[1].hfdDelay).toEqual({ globalMaximum: 70001 });
  expect(channels[2].hfdDelay).toEqual({ localMaximum: 21, globalMaximum: 70001 });
});

it('fences a raw signed-zero change even when numeric equality would still be a no-op', () => {
  const project = fixture(true);
  project.presets[0].channels.forEach((c) => (c.globalDelayUs = 0));
  const value = plan(project, 0);
  project.presets[0].channels[2].globalDelayUs = -0;
  expect(() => apply(project, value)).toThrow(/context changed/i);
});

it.each([-1, 3, 0.5])('rejects invalid preset %s', (p) =>
  expect(() => plan(fixture(), p)).toThrow(/preset/i),
);

it('refuses aliased channel objects before mutation', () => {
  const project = fixture();
  project.presets[1].channels[2] = project.presets[0].channels[1];
  expect(() => plan(project, 0)).toThrow(/alias/i);
});
