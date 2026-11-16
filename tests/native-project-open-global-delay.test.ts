import { expect, it } from 'vitest';
import { newProject, type Project } from '../src/domain/model';
import { parseProject } from '../src/domain/files';
import { defaultHfdMeasurementOptions } from '../src/domain/hfd-measurement';
import {
  applyNativeProjectOpen,
  planNativeProjectOpen,
  prepareNativeProjectOpen,
  validateNativeProjectOpen,
} from '../src/application/native-project-open';

// V55 completed native dialog Open + first Save, unknown group777 (no Graph):
// E e5ffbb106567f08290ba1b80d78e2d56830ebfb1de78ec948af18ab6f618e383
// D c15c5c9d31b5fc2eb163cd56d8380bf3a78529ecbaa9d1452d131a62941f840c
// These independent literals cover Global/Max results, not unrelated XML sink IDs.
const equalGlobals = [
  [17, 17, 17],
  [101, 101, 101],
  [203, 203, 203],
];
const differentGlobals = [
  [17, 29, 43],
  [101, 113, 127],
  [203, 227, 251],
];
const maxima = [
  [70001, 70003, 70007],
  [71001, 71003, 71007],
  [72001, 72003, 72007],
];

function fixture(globals = differentGlobals) {
  const project = newProject('V55 saved-preset Global reconciliation');
  project.hfdSelectedPreset = 3;
  project.hfdSelectedGroupId = 777;
  project.sourceXml = '<project retained="native-source" />';
  project.warnings = ['Existing warning'];
  for (const [p, preset] of project.presets.entries()) {
    preset.inputFir = { name: `Input FIR ${p}`, enabled: true, taps: [1, p / 100, 0.125] };
    for (const [c, channel] of preset.channels.entries()) {
      channel.gain = p * 3 + c;
      channel.additionalGain = c === 1 ? 10 : 0;
      channel.invert = c === 1;
      channel.muted = c === 2;
      channel.delayUs = 1 + p * 3 + c;
      channel.globalDelayUs = globals[p][c];
      channel.hfdDelay = { localMaximum: 19000 + p * 3 + c, globalMaximum: maxima[p][c] };
      channel.coefficientCache = 'unresolved';
      channel.fir = { name: `Output FIR ${p}-${c}`, enabled: true, taps: [1, c / 100, -0.25] };
      channel.measurement = {
        name: `Measurement ${p}-${c}`,
        sampleRate: defaultHfdMeasurementOptions().sampleRate,
        frequency: [100, 1000],
        magnitude: [p + 1, c + 1],
      };
      // Keep pre-existing dialog mic work inert to isolate the new raw delta.
      channel.hfdMeasurement = { ...defaultHfdMeasurementOptions(), applyMicCorrection: true };
      channel.filters.forEach((filter, index) => {
        filter.coefficients = {
          b0: 0.75,
          b1: (p * 45 + c * 15 + index) / 1000,
          b2: -0.125,
          f1: 0.25,
          f2: -0.0625,
        };
        filter.provenance = 'hfd';
        filter.sourceId = `native-${p}-${c}-${index}`;
      });
    }
  }
  return project;
}

function globalState(project: Project, presetIndex: number) {
  return project.presets[presetIndex].channels.map((channel) => ({
    value: channel.globalDelayUs,
    maximum: channel.hfdDelay?.globalMaximum,
  }));
}

function reconcileExpected(project: Project, presetIndex: number) {
  const first = project.presets[presetIndex].channels[0];
  for (const channel of project.presets[presetIndex].channels) {
    channel.globalDelayUs = first.globalDelayUs;
    channel.hfdDelay = { ...channel.hfdDelay, globalMaximum: first.hfdDelay!.globalMaximum };
  }
}

it('native E equal Globals retain all nine differing maxima and every unrelated field', () => {
  const project = fixture(equalGlobals),
    before = structuredClone(project),
    prepared = prepareNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'dialog' });
  expect(prepared.selection).toBeNull();
  expect(prepared.plan.patch).not.toHaveProperty('globalDelayReconciliation');
  expect(prepared.project).toEqual({ ...before, hfdSelectedPreset: 1 });
  expect(project).toEqual(before);
});

it('native D dialog reconciles original P3 and then offline P1, retaining P2 and all cache/FIR data', () => {
  const project = fixture(),
    before = structuredClone(project),
    expected = structuredClone(project);
  reconcileExpected(expected, 2);
  reconcileExpected(expected, 0);
  expected.hfdSelectedPreset = 1;
  const prepared = prepareNativeProjectOpen(project, 'right', { presetIndex: 0, route: 'dialog' });
  expect(prepared.selection).toBeNull();
  expect(globalState(prepared.project, 0)).toEqual([
    { value: 17, maximum: 70001 },
    { value: 17, maximum: 70001 },
    { value: 17, maximum: 70001 },
  ]);
  expect(globalState(prepared.project, 2)).toEqual([
    { value: 203, maximum: 72001 },
    { value: 203, maximum: 72001 },
    { value: 203, maximum: 72001 },
  ]);
  expect(prepared.project.presets[1]).toEqual(before.presets[1]);
  expect(prepared.project).toEqual(expected);
  expect(project).toEqual(before);
});

it('inner Open reconciles only original P3, before replacing metadata with chosen P1', () => {
  const project = fixture(),
    expected = structuredClone(project);
  reconcileExpected(expected, 2);
  expected.hfdSelectedPreset = 1;
  const prepared = prepareNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'inner' });
  expect(prepared.project).toEqual(expected);
  expect(globalState(prepared.project, 0).map((item) => item.value)).toEqual([17, 29, 43]);
});

it('inert document plan captures saved P3 delta and applies it before chosen metadata, without a dialog poststage', () => {
  const project = fixture(),
    before = structuredClone(project),
    plan = planNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'dialog' });
  expect(project).toEqual(before);
  expect(plan.patch).toHaveProperty('globalDelayReconciliation');
  validateNativeProjectOpen(plan, project, 'left');
  const draft = structuredClone(project),
    expected = structuredClone(project);
  reconcileExpected(expected, 2);
  expected.hfdSelectedPreset = 1;
  applyNativeProjectOpen(draft, 'left', plan);
  expect(draft).toEqual(expected);
  expect(globalState(draft, 0)).toEqual(globalState(before, 0));
});

it('each role uses its own saved and chosen presets, raw first values and maxima', () => {
  const left = fixture(),
    right = fixture();
  right.hfdSelectedPreset = 2;
  right.presets[1].channels[0].globalDelayUs = 113.125;
  right.presets[1].channels[0].hfdDelay!.globalMaximum = 71000.125;
  const before = structuredClone({ left, right }),
    preparedLeft = prepareNativeProjectOpen(left, 'left', { presetIndex: 0, route: 'inner' }),
    preparedRight = prepareNativeProjectOpen(right, 'right', { presetIndex: 1, route: 'dialog' });
  expect(globalState(preparedLeft.project, 2).map((item) => item.value)).toEqual([203, 203, 203]);
  expect(globalState(preparedRight.project, 1)).toEqual([
    { value: 113.125, maximum: 71000.125 },
    { value: 113.125, maximum: 71000.125 },
    { value: 113.125, maximum: 71000.125 },
  ]);
  expect(preparedLeft.project.presets[1]).toEqual(before.left.presets[1]);
  expect(preparedRight.project.presets[2]).toEqual(before.right.presets[2]);
  expect({ left, right }).toEqual(before);
});

it('raw fractional Global and first Max are copied without Single, Text or sample quantization', () => {
  const project = fixture(),
    first = project.presets[2].channels[0];
  first.globalDelayUs = 17.123456789123;
  first.hfdDelay!.globalMaximum = 72001.123456789;
  const before = structuredClone(project),
    expected = structuredClone(project);
  reconcileExpected(expected, 2);
  const plan = planNativeProjectOpen(project, 'right', { presetIndex: 2, route: 'inner' }),
    draft = structuredClone(project);
  expect(plan.changed).toBe(true);
  applyNativeProjectOpen(draft, 'right', plan);
  expect(draft).toEqual(expected);
  expect(draft.presets[2].channels[2].globalDelayUs).toBe(17.123456789123);
  expect(draft.presets[2].channels[2].hfdDelay!.globalMaximum).toBe(72001.123456789);
  expect(project).toEqual(before);
});

it('numeric +0 and -0 are equal, so differing or absent maxima are not inspected or rewritten', () => {
  const project = fixture(equalGlobals);
  project.presets[2].channels.forEach((channel, c) => {
    channel.globalDelayUs = c === 1 ? -0 : 0;
  });
  delete project.presets[2].channels[0].hfdDelay!.globalMaximum;
  const before = structuredClone(project),
    plan = planNativeProjectOpen(project, 'left', { presetIndex: 2, route: 'inner' });
  expect(plan.changed).toBe(false);
  expect(plan.patch).not.toHaveProperty('globalDelayReconciliation');
  const draft = structuredClone(project);
  applyNativeProjectOpen(draft, 'left', plan);
  expect(draft).toStrictEqual(before);
  expect(Object.is(draft.presets[2].channels[1].globalDelayUs, -0)).toBe(true);
});

it('known uniform legacy values need no first maximum, even in both dialog stages', () => {
  const project = fixture(equalGlobals);
  for (const preset of project.presets) delete preset.channels[0].hfdDelay;
  const before = structuredClone(project),
    prepared = prepareNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'dialog' });
  expect(prepared.project).toEqual({ ...before, hfdSelectedPreset: 1 });
  expect(project).toEqual(before);
});

it.each([undefined, 0, -1, 4, 2147483647])(
  'unlinked unsupported saved preset %s is compatible only when every preset is individually uniform',
  (savedPreset) => {
    const project = fixture(equalGlobals);
    if (savedPreset === undefined) delete project.hfdSelectedPreset;
    else project.hfdSelectedPreset = savedPreset;
    for (const preset of project.presets) delete preset.channels[0].hfdDelay!.globalMaximum;
    const before = structuredClone(project),
      prepared = prepareNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'inner' });
    expect(prepared.project).toEqual({ ...before, hfdSelectedPreset: 1 });
    project.presets[1].channels[2].globalDelayUs += 0.125;
    const changed = structuredClone(project);
    expect(() =>
      prepareNativeProjectOpen(project, 'right', { presetIndex: 0, route: 'dialog' }),
    ).toThrow(/saved preset|global.*delay|reconcil/i);
    expect(project).toEqual(changed);
  },
);

it.each([undefined, 0, 4])(
  'unsupported saved preset %s still refuses linked input even when all Globals are uniform',
  (savedPreset) => {
    const project = fixture(equalGlobals);
    project.hfdSelectedPreset = savedPreset;
    project.presets[0].channels[1].linkedTo = 0;
    const before = structuredClone(project);
    expect(() =>
      planNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'inner' }),
    ).toThrow(/original.*saved preset|saved preset.*links/i);
    expect(project).toEqual(before);
  },
);

it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])(
  'a real saved-preset mismatch refuses unknown/nonfinite first Max %s before mutating input',
  (maximum) => {
    const project = fixture();
    if (maximum === undefined) delete project.presets[2].channels[0].hfdDelay!.globalMaximum;
    else project.presets[2].channels[0].hfdDelay!.globalMaximum = maximum;
    const before = structuredClone(project);
    expect(() =>
      planNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'inner' }),
    ).toThrow(/max|maximum/i);
    expect(() =>
      prepareNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'dialog' }),
    ).toThrow(/max|maximum/i);
    expect(project).toEqual(before);
  },
);

it('a missing first Max in the chosen dialog poststage refuses the complete detached preparation', () => {
  const project = fixture();
  project.presets[2].channels.forEach((channel) => {
    channel.globalDelayUs = 203;
  });
  delete project.presets[0].channels[0].hfdDelay!.globalMaximum;
  const before = structuredClone(project);
  expect(() =>
    prepareNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'dialog' }),
  ).toThrow(/max|maximum/i);
  expect(project).toEqual(before);
  expect(() =>
    prepareNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'inner' }),
  ).not.toThrow();
});

it('dialog after linked cold CopyTo preserves differing maxima when Globals are still equal', () => {
  const project = newProject('Linked first group');
  project.hfdSelectedPreset = 1;
  project.hfdSelectedGroupId = 1;
  project.presets[0].channels.forEach((channel, c) => {
    channel.globalDelayUs = 17;
    channel.hfdDelay = { localMaximum: 19, globalMaximum: maxima[0][c] };
    channel.hfdMeasurement = { ...defaultHfdMeasurementOptions(), applyMicCorrection: true };
  });
  project.presets[0].channels[0].linkedTo = 1;
  const before = structuredClone(project),
    inner = prepareNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'inner' }),
    dialog = prepareNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'dialog' });
  expect(globalState(dialog.project, 0)).toEqual([
    { value: 17, maximum: 70003 },
    { value: 17, maximum: 70003 },
    { value: 17, maximum: 70007 },
  ]);
  expect(dialog.project).toEqual(inner.project);
  expect(dialog.project.presets.slice(1)).toEqual(before.presets.slice(1));
  expect(dialog.project.presets[0].channels[1]).toEqual(before.presets[0].channels[1]);
  expect(dialog.project.presets[0].channels[2]).toEqual(before.presets[0].channels[2]);
  expect(project).toEqual(before);
});

it('new raw reconciliation data remains fenced by the complete original role and detached proposal', () => {
  const project = fixture(),
    plan = planNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'inner' });
  expect(() => validateNativeProjectOpen(plan, structuredClone(project), 'left')).toThrow(
    /changed|role/,
  );
  const foreign = structuredClone(project),
    before = structuredClone(foreign);
  expect(() => applyNativeProjectOpen(foreign, 'right', plan)).toThrow(/role|detached/);
  expect(foreign).toEqual(before);
  const draft = structuredClone(project);
  draft.presets[1].channels[2].fir.taps[0] = 0.875;
  const dirtyDraft = structuredClone(draft);
  expect(() => applyNativeProjectOpen(draft, 'left', plan)).toThrow(/detached/);
  expect(draft).toEqual(dirtyDraft);
  project.presets[2].channels[0].hfdDelay!.globalMaximum = 72001.5;
  expect(() => validateNativeProjectOpen(plan, project, 'left')).toThrow(/changed|role/);
  const current = structuredClone(project);
  expect(() => applyNativeProjectOpen(current, 'left', plan)).toThrow(/detached/);
  expect(current).toEqual(project);
});

it('plain JSON snapshot parsing stays passive for nonuniform Globals and unequal maxima', () => {
  const project = fixture();
  // These saved frequency-only curves use browser analysis, not native IR options.
  for (const preset of project.presets)
    for (const channel of preset.channels) delete channel.hfdMeasurement;
  const before = structuredClone(project),
    parsed = parseProject(JSON.stringify(project));
  expect(parsed).toEqual(before);
  expect(globalState(parsed, 0).map((item) => item.value)).toEqual([17, 29, 43]);
  expect(globalState(parsed, 2).map((item) => item.maximum)).toEqual([72001, 72003, 72007]);
  expect(project).toEqual(before);
});
