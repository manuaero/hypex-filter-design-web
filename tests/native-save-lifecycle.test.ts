import { expect, it, vi } from 'vitest';
import { newProject, type Slot } from '../src/domain/model';
import {
  applyNativeOrdinarySavePostState as apply,
  planNativeOrdinarySavePostState as plan,
} from '../src/application/native-save-lifecycle';

function fixture() {
  const project = newProject('Native ordinary Save post-state');
  project.hfdSelectedPreset = 3;
  project.hfdSelectedGroupId = 777;
  project.sourceXml = '<project retained="original" />';
  project.warnings = ['Retained warning'];
  for (const [p, preset] of project.presets.entries())
    for (const [c, channel] of preset.channels.entries()) {
      channel.globalDelayUs = p * 100 + [17, 29, 43][c];
      channel.hfdDelay = { localMaximum: 19 + c, globalMaximum: 70001 + p * 1000 + c };
      channel.gain = p + c;
      channel.additionalGain = c === 1 ? 10 : 0;
      channel.delayUs = p * 3 + c;
      channel.invert = c === 1;
      channel.muted = c === 2;
      channel.coefficientCache = 'unresolved';
      if (c === 1) channel.linkedTo = 0;
      channel.fir = { name: 'Retained FIR', enabled: true, taps: [1, 0.125, -0.25] };
      channel.measurement = {
        name: 'Retained bulk payload',
        sampleRate: 93750,
        frequency: [100, 1000],
        magnitude: [p, c],
      };
      channel.filters[0].coefficients = {
        b0: 0.75,
        b1: 0.125,
        b2: -0.0625,
        f1: 0.25,
        f2: -0.125,
      };
      channel.filters[0].provenance = 'hfd';
      channel.filters[0].sourceId = `retained-${p}-${c}`;
    }
  return project;
}

it('plans passively with frozen scalar records and no bulk-project clone', () => {
  const project = fixture(),
    serializedPreimage = JSON.stringify(project),
    clone = vi.spyOn(globalThis, 'structuredClone');
  try {
    const value = plan(project, 'left', 1);
    expect(clone).not.toHaveBeenCalled();
    expect(JSON.stringify(project)).toBe(serializedPreimage);
    expect(value.slot).toBe('left');
    expect(value.presetIndex).toBe(1);
    expect(value.changed).toBe(true);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.globalDelay)).toBe(true);
    expect(Object.isFrozen(value.globalDelay.beforeChannels)).toBe(true);
    expect(value).not.toHaveProperty('project');
    expect(JSON.stringify(value)).not.toContain('Retained bulk payload');
  } finally {
    clone.mockRestore();
  }
});

it('uses the explicit runtime preset instead of saved selected-preset metadata', () => {
  const project = fixture(),
    before = structuredClone(project);
  apply(project, 'left', plan(project, 'left', 1));
  expect(project.presets[1].channels.map((channel) => channel.globalDelayUs)).toEqual([
    117, 117, 117,
  ]);
  expect(project.presets[0]).toEqual(before.presets[0]);
  expect(project.presets[2]).toEqual(before.presets[2]);
  expect(project.hfdSelectedPreset).toBe(3);
  expect(project.hfdSelectedGroupId).toBe(777);
});

it('applies only raw Global value/maximum while retaining all unrelated data and vectors', () => {
  const project = fixture(),
    expected = structuredClone(project),
    channel = project.presets[1].channels[1],
    filters = channel.filters,
    coefficients = filters[0].coefficients,
    fir = channel.fir,
    measurement = channel.measurement;
  project.presets[1].channels[0].globalDelayUs = 17.1234567890123;
  project.presets[1].channels[0].hfdDelay!.globalMaximum = 74666.6666666667;
  for (const entry of expected.presets[1].channels) {
    entry.globalDelayUs = 17.1234567890123;
    entry.hfdDelay!.globalMaximum = 74666.6666666667;
  }
  apply(project, 'right', plan(project, 'right', 1));
  expect(project).toEqual(expected);
  expect(channel.filters).toBe(filters);
  expect(filters[0].coefficients).toBe(coefficients);
  expect(channel.fir).toBe(fir);
  expect(channel.measurement).toBe(measurement);
});

it('refuses the wrong explicit role even when both documents have identical IDs', () => {
  const left = fixture(),
    right = structuredClone(left),
    before = structuredClone(right),
    value = plan(left, 'left', 1);
  expect(() => apply(right, 'right', value)).toThrow(/role/);
  expect(right).toEqual(before);
});

it('preflights the last selected channel before any earlier Global assignment', () => {
  const project = fixture(),
    value = plan(project, 'left', 1);
  project.presets[1].channels[2].id = 'replacement-with-same-values';
  const before = structuredClone(project);
  expect(() => apply(project, 'left', value)).toThrow(/context changed/);
  expect(project).toEqual(before);
});

it('rejects inconsistent wrapper preset and changed fields without mutation', () => {
  const project = fixture(),
    before = structuredClone(project),
    value = plan(project, 'left', 1);
  expect(() => apply(project, 'left', { ...value, presetIndex: 0 })).toThrow(/plan context/);
  expect(() => apply(project, 'left', { ...value, changed: false })).toThrow(/plan context/);
  expect(project).toEqual(before);
});

it('requires a valid explicit role and zero-based preset without an inferred default', () => {
  const project = fixture(),
    before = structuredClone(project);
  for (const slot of ['both', '', undefined])
    expect(() => plan(project, slot as Slot, 1)).toThrow(/role/);
  for (const presetIndex of [-1, 3, 1.5, NaN])
    expect(() => plan(project, 'left', presetIndex)).toThrow(/valid FA503 preset/);
  expect(() => apply(project, 'both' as Slot, plan(project, 'left', 1))).toThrow(/role/);
  expect(project).toEqual(before);
});

it('keeps a uniform legacy preset an exact no-op without inventing maxima or metadata', () => {
  const project = fixture();
  for (const channel of project.presets[1].channels) {
    channel.globalDelayUs = 101;
    delete channel.hfdDelay;
  }
  delete project.hfdSelectedPreset;
  const before = structuredClone(project),
    value = plan(project, 'right', 1);
  expect(value.changed).toBe(false);
  apply(project, 'right', value);
  expect(project).toEqual(before);
  expect(Object.hasOwn(project, 'hfdSelectedPreset')).toBe(false);
});

it('keeps independent role plans and raw maxima separate despite matching native IDs', () => {
  const left = fixture(),
    right = structuredClone(left);
  right.presets[1].channels[0].globalDelayUs = 8.75;
  right.presets[1].channels[0].hfdDelay!.globalMaximum = 71001.125;
  const leftPlan = plan(left, 'left', 1),
    rightPlan = plan(right, 'right', 1);
  apply(left, 'left', leftPlan);
  apply(right, 'right', rightPlan);
  expect(left.presets[1].channels.map((channel) => channel.globalDelayUs)).toEqual([117, 117, 117]);
  expect(right.presets[1].channels.map((channel) => channel.globalDelayUs)).toEqual([
    8.75, 8.75, 8.75,
  ]);
  expect(right.presets[1].channels.map((channel) => channel.hfdDelay?.globalMaximum)).toEqual([
    71001.125, 71001.125, 71001.125,
  ]);
});
