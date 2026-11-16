import { describe, expect, it } from 'vitest';
import {
  clearPreset,
  copyChannelProcessing,
  exchangeBiquads,
  editManualFilter,
  planManualFilterWheel,
  applyManualFilterWheel,
} from '../src/domain/editing';
import { effectiveSections, encodeChannel } from '../src/domain/dsp';
import { linkChannel } from '../src/domain/links';
import { newProject, type Channel, type Filter, type Project } from '../src/domain/model';

function varied(project = newProject()): Project {
  project.presets.forEach((preset, p) => {
    preset.channels.forEach((channel, c) => {
      channel.gain = -6 - c;
      channel.invert = c === 0;
      channel.muted = c === 1;
      channel.delayUs = 100 + c;
      channel.globalDelayUs = 200 + c;
      channel.additionalGain = c + 1;
      channel.includeInSum = c !== 2;
      channel.coefficientCache = 'effective';
      channel.measurement = {
        name: `${p}/${c} driver`,
        sampleRate: 48000,
        impulse: [0, c + 1, 0],
        frequency: [100, 1000],
        magnitude: [-2, 1],
      };
      channel.fir = { name: `Output ${p}/${c}`, enabled: c === 0, taps: [0.1, 0.5, 0.2] };
      channel.filters.forEach((filter, i) => {
        filter.kind = i % 2 === 0 ? 'raw' : 'peak';
        filter.enabled = i % 3 !== 1;
        filter.frequency = 50 + 100 * i;
        filter.frequency2 = 100 + 100 * i;
        filter.q = 0.5 + i / 20;
        filter.q2 = 0.6 + i / 20;
        filter.gain = i - 5;
        filter.sourceId = `${p}/${c}/${i}`;
        filter.sourceType = i % 2 === 0 ? 'ftFree' : 'ftBoostCut';
        filter.provenance = 'hfd';
        filter.coefficients = { b0: 0.25 + i / 100, b1: 0.02, b2: 0.01, f1: 0.1, f2: -0.01 };
      });
    });
    preset.inputEq[0].gain = 3 + p;
    preset.inputEq[0].enabled = true;
    preset.eqEnabled = true;
    preset.inputFir = { name: `Input ${p}`, enabled: true, taps: [0.2, 0.7] };
    preset.firPlacement = 'output';
  });
  return project;
}

function identity(filter: Filter) {
  return { id: filter.id, sourceId: filter.sourceId };
}

function parameters(filter: Filter) {
  const { id: _id, sourceId: _sourceId, ...value } = filter;
  return value;
}

function localProperties(channel: Channel) {
  return {
    id: channel.id,
    name: channel.name,
    outputName: channel.outputName,
    measurement: channel.measurement,
    additionalGain: channel.additionalGain,
    includeInSum: channel.includeInSum,
    linkedTo: channel.linkedTo,
    slots: channel.filters.map(identity),
  };
}

describe('explicit manual filter commits', () => {
  it('compiles stable ordinary BQ gains and admits the native channel minimum while rejecting lower imports', () => {
    const channel = newProject().presets[0].channels[0];
    channel.filters[0] = editManualFilter(
      channel.filters[0],
      { kind: 'lowshelf1', enabled: true, frequency: 1000, q: 0.4, gain: -125 },
      { redesign: true },
    );
    expect(channel.filters[0].gain).toBe(-125);
    expect(encodeChannel(channel)).toHaveLength(512);
    channel.filters[0] = editManualFilter(
      channel.filters[0],
      { kind: 'peak', q: 20, gain: 24 },
      { redesign: true },
    );
    expect(encodeChannel(channel)).toHaveLength(512);
    channel.gain = -125;
    expect(encodeChannel(channel)).toHaveLength(512);
    channel.gain = -125.01;
    expect(() => encodeChannel(channel)).toThrow(/Channel gain/);
  });
  it('normalizes only explicit Q/Q2/gain fields as Double and keeps imported and gesture precision separate', () => {
    const source = varied().presets[0].channels[0].filters[0];
    Object.assign(source, { enabled: false, q: 0.456789123456789, q2: 1.3, gain: 7.123456789 });
    const before = structuredClone(source);
    const next = editManualFilter(source, { q: 0.4005, q2: 99, gain: 7.555 });
    expect(next).toMatchObject({ q: 0.401, q2: 20, gain: 7.56, enabled: false });
    expect(next.q).not.toBe(Math.fround(next.q));
    expect(next.gain).not.toBe(Math.fround(next.gain));
    expect(next.coefficients).toEqual(before.coefficients);
    expect(editManualFilter(source, { kind: 'peak' }, { redesign: true })).toMatchObject({
      q: before.q,
      q2: before.q2,
      gain: before.gain,
      enabled: false,
    });
    expect(editManualFilter(source, { gain: 0 }).gain).toBe(0);
    expect(editManualFilter(source, { q2: 0 }).q2).toBe(1.3);
    expect(editManualFilter(source, { gain: -999 }).gain).toBe(-125);
    const gesture = editManualFilter(
      source,
      { q: 0.4005, gain: 7.555 },
      { manualParameters: false },
    );
    expect(gesture).toMatchObject({ q: 0.4005, gain: 7.555 });
    expect(source).toEqual(before);
  });
  it('normalizes only supplied frequency fields from decimal Text and preserves zero previous-value semantics', () => {
    const source = varied().presets[0].channels[0].filters[0];
    source.frequency = 720;
    source.frequency2 = 988.101806640625;
    const before = structuredClone(source);
    const next = editManualFilter(source, { frequency: 10.35 });
    expect(next.frequency).toBe(10.399999618530273);
    expect(next.frequency2).toBe(before.frequency2);
    expect(next.coefficients).toEqual(before.coefficients);
    expect(editManualFilter(source, { frequency: 0 }).frequency).toBe(720);
    expect(editManualFilter(source, { frequency: -1 }).frequency).toBe(10);
    expect(editManualFilter(source, { frequency2: 50001 }).frequency2).toBe(50000);
    expect(source).toEqual(before);
    expect(() => editManualFilter(source, { frequency: Infinity })).toThrow(/finite/);
  });

  it.each([false, true])(
    'retains Enabled=%s, identities and latent native values across type redesign',
    (enabled) => {
      const source = varied().presets[0].channels[0].filters[0];
      Object.assign(source, {
        kind: 'lowpass2',
        enabled,
        frequency: 5.049999999999999,
        frequency2: 988.101806640625,
      });
      const before = structuredClone(source);
      const next = editManualFilter(source, { kind: 'highpass2' }, { redesign: true });
      expect(next).toEqual({
        ...before,
        kind: 'highpass2',
        coefficients: undefined,
        provenance: undefined,
      });
      expect(next.enabled).toBe(enabled);
      expect(next.frequency).toBe(before.frequency);
      expect(next.frequency2).toBe(before.frequency2);
      expect(source).toEqual(before);
      expect(editManualFilter(source, { kind: 'unity' }, { redesign: true }).enabled).toBe(enabled);
      expect(editManualFilter(source, { kind: 'highpass2', enabled: !enabled }).enabled).toBe(
        !enabled,
      );
    },
  );
});

describe('shared native parameter wheel planning', () => {
  const request = {
    presetIndex: 0,
    channelIndex: 0,
    filterIndex: 0,
    parameter: 'q' as const,
    direction: 1 as const,
  };
  function documents() {
    const docs = { left: varied(), right: varied() };
    Object.assign(docs.left.presets[0].channels[0].filters[0], {
      kind: 'peak',
      enabled: false,
      q: 0.7,
    });
    Object.assign(docs.right.presets[0].channels[0].filters[0], {
      kind: 'lowpass2',
      enabled: true,
      q: 1.3,
    });
    return docs;
  }
  it('plans each role independently without mutation, then redesigns only changed fields and keeps identities/bypass', () => {
    const docs = documents(),
      before = structuredClone(docs);
    const plan = planManualFilterWheel(docs, ['left', 'right'], request);
    expect(docs).toEqual(before);
    expect(plan.roles.map((role) => role.value)).toEqual([0.74, 1.34]);
    for (const slot of plan.changedSlots) applyManualFilterWheel(docs[slot], plan);
    for (const slot of ['left', 'right'] as const) {
      const filter = docs[slot].presets[0].channels[0].filters[0],
        old = before[slot].presets[0].channels[0].filters[0];
      expect(filter.id).toBe(old.id);
      expect(filter.sourceId).toBe(old.sourceId);
      expect(filter.enabled).toBe(old.enabled);
      expect(filter.frequency2).toBe(old.frequency2);
      expect(filter.coefficients).toBeUndefined();
      expect(filter.provenance).toBeUndefined();
      expect(docs[slot].presets[0].channels[0].coefficientCache).toBe('base');
    }
  });
  it('refuses inactive or linked targets before mutation and permits inactive latent destination fields only in source mirror', () => {
    const docs = documents();
    Object.assign(docs.right.presets[0].channels[0].filters[0], { kind: 'raw', q: 3 });
    const before = structuredClone(docs);
    expect(() => planManualFilterWheel(docs, ['left', 'right'], request)).toThrow(/inactive/);
    expect(docs).toEqual(before);
    const plan = planManualFilterWheel(docs, ['left', 'right'], { ...request, basis: 'left' });
    for (const slot of plan.changedSlots) applyManualFilterWheel(docs[slot], plan);
    expect(docs.left.presets[0].channels[0].filters[0].q).toBe(0.74);
    expect(docs.right.presets[0].channels[0].filters[0]).toMatchObject({
      kind: 'raw',
      q: 0.74,
      coefficients: before.right.presets[0].channels[0].filters[0].coefficients,
    });
    docs.right.presets[0].channels[0].linkedTo = 1;
    const linked = structuredClone(docs);
    expect(() =>
      planManualFilterWheel(docs, ['left', 'right'], { ...request, basis: 'left' }),
    ).toThrow(/read-only/);
    expect(docs).toEqual(linked);
  });
  it('keeps bound no-ops including imported excess precision/cache, and a no-op source never mirrors', () => {
    const docs = documents();
    docs.left.presets[0].channels[0].filters[0].q = 20.00001;
    const before = structuredClone(docs);
    const mirrored = planManualFilterWheel(docs, ['left', 'right'], { ...request, basis: 'left' });
    expect(mirrored.changedSlots).toEqual([]);
    expect(mirrored.roles.map((role) => role.changed)).toEqual([false, false]);
    expect(docs).toEqual(before);
    const each = planManualFilterWheel(docs, ['left', 'right'], request);
    expect(each.changedSlots).toEqual(['right']);
    applyManualFilterWheel(docs.right, each);
    expect(docs.left).toEqual(before.left);
    expect(docs.right.presets[0].channels[0].filters[0].q).toBe(1.34);
  });
  it('uses AdditionalGain for the post-step ceiling and does not use ordinary channel gain', () => {
    const docs = documents();
    for (const slot of ['left', 'right'] as const) {
      const channel = docs[slot].presets[0].channels[0];
      channel.filters[0].kind = 'peak';
      channel.filters[0].gain = 20;
      channel.gain = -12;
    }
    docs.left.presets[0].channels[0].additionalGain = 10;
    docs.right.presets[0].channels[0].additionalGain = 0;
    const plan = planManualFilterWheel(docs, ['left', 'right'], { ...request, parameter: 'gain' });
    // The native post-step guard suppresses its model callback: only Text
    // becomes 14.00. Both actual canonical models still receive the wheel step.
    expect(plan.roles.map((role) => role.value)).toEqual([20.1, 20.1]);
    expect(plan.roles.map((role) => role.text)).toEqual(['14.00', '20.10']);
  });
});

describe('biquad parameter exchange', () => {
  it('exchanges disabled/raw parameters and caches while retaining graph slot identity', () => {
    const project = varied();
    const channel = project.presets[0].channels[0];
    const before = structuredClone(project);
    const first = structuredClone(channel.filters[0]);
    const second = structuredClone(channel.filters[1]);
    exchangeBiquads(project, 0, 0, 0, 1);
    expect(identity(channel.filters[0])).toEqual(identity(first));
    expect(identity(channel.filters[1])).toEqual(identity(second));
    expect(parameters(channel.filters[0])).toEqual(parameters(second));
    expect(parameters(channel.filters[1])).toEqual(parameters(first));
    expect(channel.filters[0].coefficients).not.toBe(second.coefficients);
    expect(localProperties(channel)).toEqual(localProperties(before.presets[0].channels[0]));
    expect(channel.coefficientCache).toBe('base');
    expect(project.presets[0].channels.slice(1)).toEqual(before.presets[0].channels.slice(1));
    expect(project.presets.slice(1)).toEqual(before.presets.slice(1));
  });

  it('applies channel gain/inversion once to the new first slot without changing raw parameters', () => {
    const project = varied();
    const channel = project.presets[0].channels[0];
    const firstBase = channel.filters[0].coefficients!.b0;
    const nextBase = channel.filters[2].coefficients!.b0;
    const multiplier = -(10 ** ((channel.gain + channel.additionalGain!) / 20));
    exchangeBiquads(project, 0, 0, 0, 2);
    expect(effectiveSections(channel)[0].b0).toBeCloseTo(nextBase * multiplier, 14);
    expect(effectiveSections(channel)[2].b0).toBe(firstBase);
    expect(channel.filters[0].coefficients!.b0).toBe(nextBase);
    expect(channel.gain).toBe(-6);
    expect(channel.additionalGain).toBe(1);
    exchangeBiquads(project, 0, 0, 0, 2);
    expect(channel.filters[0].coefficients!.b0).toBe(firstBase);
  });

  it('updates linked followers while retaining their local identities and measurements', () => {
    const project = varied();
    const preset = project.presets[0];
    linkChannel(preset, 2, 0);
    const local = structuredClone(localProperties(preset.channels[2]));
    exchangeBiquads(project, 0, 0, 0, 14);
    expect(parameters(preset.channels[2].filters[0])).toEqual(
      parameters(preset.channels[0].filters[0]),
    );
    expect(localProperties(preset.channels[2])).toEqual(local);
    expect(preset.channels[2].filters[0].coefficients).not.toBe(
      preset.channels[0].filters[0].coefficients,
    );
    expect(() => exchangeBiquads(project, 0, 2, 0, 1)).toThrow('Linked destination');
  });

  it('retains unresolved gain-cache state and rejects moving its ambiguous first numerator', () => {
    const project = varied();
    const channel = project.presets[0].channels[0];
    channel.coefficientCache = 'unresolved';
    exchangeBiquads(project, 0, 0, 2, 3);
    expect(channel.coefficientCache).toBe('unresolved');
    const before = structuredClone(project);
    expect(() => exchangeBiquads(project, 0, 0, 0, 1)).toThrow('Resolve the first-section');
    expect(project).toEqual(before);
    expect(() => effectiveSections(channel)).toThrow('Resolve imported');
  });
});

describe('channel processing copy', () => {
  it('copies all 15 slots and processing while preserving destination-only data and source data', () => {
    const project = varied();
    const preset = project.presets[1];
    const source = preset.channels[0];
    const destination = preset.channels[1];
    const before = structuredClone(project);
    const local = structuredClone(localProperties(destination));
    delete destination.filters[3].sourceId;
    delete local.slots[3].sourceId;
    copyChannelProcessing(project, 1, 0, 1);
    expect(localProperties(destination)).toEqual(local);
    expect(destination.filters.map(parameters)).toEqual(source.filters.map(parameters));
    expect(destination.fir).toEqual(source.fir);
    expect(destination.fir).not.toBe(source.fir);
    expect(destination.fir.taps).not.toBe(source.fir.taps);
    for (const key of ['gain', 'invert', 'muted', 'delayUs', 'globalDelayUs'] as const)
      expect(destination[key]).toBe(source[key]);
    expect(destination.coefficientCache).toBe('base');
    expect(source).toEqual(before.presets[1].channels[0]);
    expect(preset.inputEq).toEqual(before.presets[1].inputEq);
    expect(preset.inputFir).toEqual(before.presets[1].inputFir);
    expect(preset.firPlacement).toBe('output');
    expect(project.presets[0]).toEqual(before.presets[0]);
    expect(project.presets[2]).toEqual(before.presets[2]);
    destination.filters[14].coefficients!.b0 = 0.9;
    destination.fir.taps[0] = 0.9;
    expect(source).toEqual(before.presets[1].channels[0]);
  });

  it('resolves a linked source to its master without changing the selected source or other presets', () => {
    const project = varied();
    const preset = project.presets[0];
    linkChannel(preset, 1, 0);
    // A caller may hold stale follower values; the master is authoritative.
    preset.channels[1].filters[0].gain = 99;
    const before = structuredClone(project);
    copyChannelProcessing(project, 0, 1, 2);
    expect(preset.channels[2].filters.map(parameters)).toEqual(
      preset.channels[0].filters.map(parameters),
    );
    expect(preset.channels[0]).toEqual(before.presets[0].channels[0]);
    expect(preset.channels[1]).toEqual(before.presets[0].channels[1]);
    expect(project.presets.slice(1)).toEqual(before.presets.slice(1));
    expect(preset.channels[2].linkedTo).toBeUndefined();
  });

  it('updates destination followers with independent copies, retaining every driver measurement', () => {
    const project = varied();
    const preset = project.presets[0];
    linkChannel(preset, 2, 0);
    const local0 = structuredClone(localProperties(preset.channels[0]));
    const local2 = structuredClone(localProperties(preset.channels[2]));
    const source = structuredClone(preset.channels[1]);
    copyChannelProcessing(project, 0, 1, 0);
    expect(localProperties(preset.channels[0])).toEqual(local0);
    expect(localProperties(preset.channels[2])).toEqual(local2);
    for (const c of [0, 2])
      expect(preset.channels[c].filters.map(parameters)).toEqual(source.filters.map(parameters));
    preset.channels[2].filters[0].coefficients!.b0 = 0.8;
    expect(preset.channels[0].filters[0].coefficients!.b0).toBe(source.filters[0].coefficients!.b0);
    expect(preset.channels[1]).toEqual(source);
  });

  it('keeps ambiguous imported coefficients blocked rather than treating their cache as resolved', () => {
    const project = varied();
    const source = project.presets[0].channels[0];
    source.coefficientCache = 'unresolved';
    const before = structuredClone(source);
    copyChannelProcessing(project, 0, 0, 1);
    const destination = project.presets[0].channels[1];
    expect(destination.coefficientCache).toBe('unresolved');
    expect(destination.filters[0].coefficients).toEqual(before.filters[0].coefficients);
    expect(() => effectiveSections(destination)).toThrow('Resolve imported');
    expect(source).toEqual(before);
  });

  it('creates independent slots even when input coefficient objects happen to share a reference', () => {
    const project = varied();
    const source = project.presets[0].channels[0];
    source.filters[1].coefficients = source.filters[0].coefficients;
    copyChannelProcessing(project, 0, 0, 1);
    const filters = project.presets[0].channels[1].filters;
    expect(new Set(filters).size).toBe(15);
    expect(new Set(filters.map((f) => f.coefficients)).size).toBe(15);
    filters[0].coefficients!.b0 = 0.75;
    expect(filters[1].coefficients!.b0).toBe(0.25);
    expect(source.filters[0].coefficients!.b0).toBe(0.25);
  });
});

describe('native HFD Clear preset filter parameters', () => {
  it('clears only gain/inversion, all biquad parameters and input FIR, retaining enabled flags and other data', () => {
    const project = varied();
    const preset = project.presets[1];
    preset.name = 'Keep this preset';
    linkChannel(preset, 2, 0);
    preset.channels[0].coefficientCache = 'unresolved';
    const before = structuredClone(project);
    clearPreset(project, 1);
    const expected = structuredClone(before.presets[1]);
    expected.inputFir = { name: '', enabled: false, taps: [] };
    expected.channels.forEach((channel) => {
      channel.gain = 0;
      channel.invert = false;
      channel.coefficientCache = 'base';
      channel.filters = channel.filters.map((filter) => ({
        id: filter.id,
        sourceId: filter.sourceId,
        kind: 'unity',
        enabled: filter.enabled,
        frequency: 1000,
        frequency2: 1000,
        q: 0.7,
        q2: 0.7,
        gain: 0,
      }));
    });
    expect(preset).toEqual(expected);
    expect(project.presets[0]).toEqual(before.presets[0]);
    expect(project.presets[2]).toEqual(before.presets[2]);
    expect(preset.channels.flatMap((c) => c.filters)).toHaveLength(45);
    expect(new Set(preset.channels.flatMap((c) => c.filters)).size).toBe(45);
    expect(preset.channels[0].filters[0].coefficients).toBeUndefined();
    expect(preset.channels[0].filters[0].sourceType).toBeUndefined();
    preset.channels[0].filters[0].gain = 9;
    expect(preset.channels[0].filters[1].gain).toBe(0);
    expect(preset.channels[1].filters[0].gain).toBe(0);
    expect(preset.inputFir.taps).not.toBe(before.presets[1].inputFir.taps);
  });
});

describe('editing guards', () => {
  it.each([
    ['negative preset', (p: Project) => clearPreset(p, -1)],
    ['fractional preset', (p: Project) => clearPreset(p, 0.5)],
    ['past-last preset', (p: Project) => clearPreset(p, 3)],
    ['NaN preset', (p: Project) => exchangeBiquads(p, NaN, 0, 0, 1)],
    ['negative channel', (p: Project) => exchangeBiquads(p, 0, -1, 0, 1)],
    ['fractional channel', (p: Project) => copyChannelProcessing(p, 0, 0.5, 1)],
    ['past-last channel', (p: Project) => copyChannelProcessing(p, 0, 0, 3)],
    ['negative biquad', (p: Project) => exchangeBiquads(p, 0, 0, -1, 1)],
    ['past-last biquad', (p: Project) => exchangeBiquads(p, 0, 0, 0, 15)],
    ['fractional biquad', (p: Project) => exchangeBiquads(p, 0, 0, 0.5, 1)],
    ['same biquad', (p: Project) => exchangeBiquads(p, 0, 0, 1, 1)],
    ['same channel', (p: Project) => copyChannelProcessing(p, 0, 1, 1)],
  ])('rejects %s without changing the project', (_label, action) => {
    const project = varied();
    const before = structuredClone(project);
    expect(() => action(project)).toThrow();
    expect(project).toEqual(before);
  });

  it('rejects linked destinations and copying a linked source back onto its own master', () => {
    const project = varied();
    linkChannel(project.presets[0], 1, 0);
    const before = structuredClone(project);
    expect(() => copyChannelProcessing(project, 0, 2, 1)).toThrow('Linked destination');
    expect(() => copyChannelProcessing(project, 0, 1, 0)).toThrow('different processing');
    expect(project).toEqual(before);
  });

  it.each([
    'cycle',
    'invalid link',
    'short slots',
    'aliased presets',
    'aliased channels',
    'aliased arrays',
  ])('rejects %s before any mutation', (fault) => {
    const project = varied();
    const preset = project.presets[0];
    if (fault === 'cycle') {
      preset.channels[0].linkedTo = 1;
      preset.channels[1].linkedTo = 0;
    } else if (fault === 'invalid link') preset.channels[2].linkedTo = 3;
    else if (fault === 'short slots') preset.channels[2].filters.pop();
    else if (fault === 'aliased presets') project.presets[1] = preset;
    else if (fault === 'aliased channels') project.presets[1].channels[0] = preset.channels[0];
    else preset.channels[1].filters = preset.channels[0].filters;
    const before = structuredClone(project);
    expect(() => clearPreset(project, 0)).toThrow();
    expect(project).toEqual(before);
  });

  it('rejects two graph slot aliases even when their array indices differ', () => {
    const project = varied();
    const channel = project.presets[0].channels[0];
    channel.filters[1] = channel.filters[0];
    const before = structuredClone(project);
    expect(() => exchangeBiquads(project, 0, 0, 0, 1)).toThrow('different biquad');
    expect(project).toEqual(before);
  });
});
