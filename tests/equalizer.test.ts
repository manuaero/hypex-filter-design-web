import { describe, expect, it } from 'vitest';
import {
  applyEqBank,
  copyInputEqToPresets,
  resetInputEq,
  snapshotEqBank,
  type EqBank,
} from '../src/domain/equalizer';
import { design } from '../src/domain/dsp';
import { linkChannel } from '../src/domain/links';
import { newProject, type Filter, type Project } from '../src/domain/model';
import { encodeEq } from '../src/hardware/codec';

function varied(): Project {
  const project = newProject('EQ bank fixture');
  project.sourceXml = '<project>owned fixture</project>';
  project.warnings = ['Keep this warning'];
  project.presets.forEach((preset, p) => {
    preset.eqEnabled = p !== 1;
    preset.name = `Independent preset ${p}`;
    preset.inputFir = { name: `Input FIR ${p}`, enabled: true, taps: [0.2, 0.7, 0.1] };
    preset.firPlacement = p === 1 ? 'output' : 'input';
    preset.inputEq.forEach((filter, i) => {
      filter.sourceId = `${p}/EQ/${i}`;
      filter.kind = (['peak', 'lowshelf2', 'highshelf2'] as const)[i % 3];
      filter.enabled = i % 2 === 0;
      filter.frequency = 100 + i * 1000 + p * 10;
      filter.q = 0.55 + i * 0.1 + p * 0.01;
      filter.gain = p + i / 4 - 2;
      filter.frequency2 = 2000 + i;
      filter.q2 = 0.8 + i / 10;
      filter.coefficients = design(filter);
      filter.provenance = 'panel';
      filter.sourceType = 'old cached type';
    });
    preset.channels[0].gain = -5 - p;
    preset.channels[0].delayUs = 250 + p;
    preset.channels[0].filters[2].kind = 'peak';
    preset.channels[0].filters[2].enabled = true;
    preset.channels[0].filters[2].gain = -3;
    preset.channels[0].fir = { name: 'Output FIR', enabled: true, taps: [0.3, 0.7] };
    preset.channels[0].measurement = {
      name: 'Unloaded original DAT reference',
      sampleRate: 93750,
    };
    linkChannel(preset, 1, 0);
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

function unrelated(project: Project) {
  const copy = structuredClone(project);
  return {
    ...copy,
    presets: copy.presets.map(({ inputEq: _eq, eqEnabled: _enabled, ...preset }) => preset),
  };
}

describe('native Default EQ', () => {
  it('uses the executable 16k centers, enables all bands and preserves each current Q', () => {
    const project = varied();
    const before = structuredClone(project);
    project.presets[1].inputEq[0].shelfDirection = 'high';
    resetInputEq(project, 1);
    const preset = project.presets[1];
    expect(preset.inputEq.map((f) => f.frequency)).toEqual([
      50, 100, 200, 500, 1000, 2000, 5000, 10000, 16000,
    ]);
    expect(preset.inputEq.map((f) => f.q)).toEqual(before.presets[1].inputEq.map((f) => f.q));
    expect(preset.inputEq.map(identity)).toEqual(before.presets[1].inputEq.map(identity));
    preset.inputEq.forEach((filter, i) => {
      expect(filter).toMatchObject({ kind: 'peak', enabled: true, gain: 0 });
      expect(filter.frequency2).toBe(before.presets[1].inputEq[i].frequency2);
      expect(filter.q2).toBe(before.presets[1].inputEq[i].q2);
      expect(filter.coefficients).toBeUndefined();
      expect(filter.provenance).toBeUndefined();
      expect(filter.sourceType).toBeUndefined();
      expect(filter.shelfDirection).toBeUndefined();
    });
    expect(preset.eqEnabled).toBe(false);
    expect(project.presets[0]).toEqual(before.presets[0]);
    expect(project.presets[2]).toEqual(before.presets[2]);
    expect(unrelated(project)).toEqual(unrelated(before));
    expect(encodeEq(preset.inputEq)).toHaveLength(256);
  });

  it('keeps whole-EQ active when it was already active', () => {
    const project = varied();
    resetInputEq(project, 0);
    expect(project.presets[0].eqEnabled).toBe(true);
  });
});

describe('copy EQ bands to presets', () => {
  it('copies only selected nine-band pages, preserving slot identities and independent bypass', () => {
    const project = varied();
    delete project.presets[2].inputEq[2].sourceId;
    const before = structuredClone(project);
    copyInputEqToPresets(project, 0, [2, 1, 0, 2]);
    for (const index of [1, 2]) {
      expect(project.presets[index].inputEq.map(parameters)).toEqual(
        before.presets[0].inputEq.map(parameters),
      );
      expect(project.presets[index].inputEq.map(identity)).toEqual(
        before.presets[index].inputEq.map(identity),
      );
      expect(project.presets[index].eqEnabled).toBe(before.presets[index].eqEnabled);
    }
    expect(project.presets[0]).toEqual(before.presets[0]);
    expect(unrelated(project)).toEqual(unrelated(before));
    project.presets[1].inputEq[0].coefficients!.b0 = 0.5;
    project.presets[1].inputEq[0].gain = 10;
    expect(project.presets[0].inputEq[0]).toEqual(before.presets[0].inputEq[0]);
    expect(project.presets[2].inputEq[0].coefficients).toEqual(
      before.presets[0].inputEq[0].coefficients,
    );
  });

  it('leaves empty or self-only destinations unchanged', () => {
    const project = varied();
    const before = structuredClone(project);
    copyInputEqToPresets(project, 1, []);
    copyInputEqToPresets(project, 1, [1, 1]);
    expect(project).toEqual(before);
  });
});

describe('runtime EQ bank clipboard', () => {
  it('snapshots all three independently with detached nested coefficient caches', () => {
    const project = varied();
    const before = structuredClone(project);
    const bank = snapshotEqBank(project);
    expect(bank.map((entry) => entry.enabled)).toEqual([true, false, true]);
    expect(bank[0].bands).toEqual(before.presets[0].inputEq);
    project.presets[0].inputEq[0].gain = 10;
    project.presets[0].inputEq[0].coefficients!.b0 = 0.75;
    expect(bank[0].bands).toEqual(before.presets[0].inputEq);
    bank[1].bands[0].gain = -10;
    bank[1].bands[0].coefficients!.b0 = 0.25;
    expect(project.presets[1]).toEqual(before.presets[1]);
    expect(bank[2].bands).toEqual(before.presets[2].inputEq);
    expect(Object.keys(project).sort()).toEqual(Object.keys(before).sort());
  });

  it('restores all three pages and flags while preserving destination identities and linked outputs', () => {
    const source = varied();
    const bank = snapshotEqBank(source);
    const target = varied();
    target.presets.forEach((preset, p) => {
      preset.eqEnabled = p === 1;
      preset.inputEq.forEach((band, i) => {
        band.gain = 7;
        band.sourceId = `target/${p}/${i}`;
      });
    });
    delete target.presets[0].inputEq[3].sourceId;
    const before = structuredClone(target);
    applyEqBank(target, bank);
    target.presets.forEach((preset, p) => {
      expect(preset.eqEnabled).toBe(bank[p].enabled);
      expect(preset.inputEq.map(parameters)).toEqual(bank[p].bands.map(parameters));
      expect(preset.inputEq.map(identity)).toEqual(before.presets[p].inputEq.map(identity));
    });
    expect(unrelated(target)).toEqual(unrelated(before));
    bank[0].bands[0].coefficients!.b0 = 0.5;
    target.presets[1].inputEq[0].coefficients!.b0 = 0.25;
    expect(target.presets[0].inputEq[0].coefficients).toEqual(
      source.presets[0].inputEq[0].coefficients,
    );
    expect(bank[1].bands[0].coefficients).toEqual(source.presets[1].inputEq[0].coefficients);
    expect(target.presets[2].inputEq[0].coefficients).toEqual(
      source.presets[2].inputEq[0].coefficients,
    );
  });

  it('can apply a bank whose input arrays directly reference the current project', () => {
    const project = varied();
    const before = structuredClone(project);
    const bank = project.presets.map((preset) => ({
      bands: preset.inputEq,
      enabled: preset.eqEnabled,
    }));
    applyEqBank(project, [bank[2], bank[0], bank[1]]);
    expect(project.presets[0].inputEq.map(parameters)).toEqual(
      before.presets[2].inputEq.map(parameters),
    );
    expect(project.presets[1].inputEq.map(parameters)).toEqual(
      before.presets[0].inputEq.map(parameters),
    );
    expect(project.presets[2].inputEq.map(parameters)).toEqual(
      before.presets[1].inputEq.map(parameters),
    );
  });
});

describe('legacy browser disabled Unity EQ', () => {
  function legacyProject() {
    const project = varied();
    Object.assign(project.presets[0].inputEq[4], {
      kind: 'unity',
      enabled: false,
      frequency: 1234,
      q: 1.234,
      gain: 5,
    });
    return project;
  }

  it('snapshots and copies as a bypassed zero-gain peak without changing the legacy source', () => {
    const project = legacyProject();
    const before = structuredClone(project);
    const bank = snapshotEqBank(project);
    const normalized = bank[0].bands[4];
    expect(normalized).toMatchObject({
      ...identity(before.presets[0].inputEq[4]),
      kind: 'peak',
      enabled: false,
      frequency: 1234,
      q: 1.234,
      gain: 0,
    });
    expect(normalized.coefficients).toBeUndefined();
    expect(normalized.provenance).toBeUndefined();
    expect(project).toEqual(before);
    copyInputEqToPresets(project, 0, [1, 2]);
    for (const index of [1, 2]) {
      expect(parameters(project.presets[index].inputEq[4])).toEqual(parameters(normalized));
      expect(identity(project.presets[index].inputEq[4])).toEqual(
        identity(before.presets[index].inputEq[4]),
      );
      expect(project.presets[index].eqEnabled).toBe(before.presets[index].eqEnabled);
    }
    expect(project.presets[0]).toEqual(before.presets[0]);
    expect(unrelated(project)).toEqual(unrelated(before));
  });

  it('applies legacy bank entries without modifying the bank or destination identities', () => {
    const source = legacyProject();
    const bank = source.presets.map((preset) => ({
      bands: structuredClone(preset.inputEq),
      enabled: preset.eqEnabled,
    }));
    const bankBefore = structuredClone(bank);
    const target = legacyProject();
    const before = structuredClone(target);
    applyEqBank(target, bank);
    const filter = target.presets[0].inputEq[4];
    expect(filter).toMatchObject({
      kind: 'peak',
      enabled: false,
      gain: 0,
      frequency: 1234,
      q: 1.234,
    });
    expect(identity(filter)).toEqual(identity(before.presets[0].inputEq[4]));
    expect(filter.coefficients).toBeUndefined();
    expect(filter.provenance).toBeUndefined();
    expect(bank).toEqual(bankBefore);
    expect(unrelated(target)).toEqual(unrelated(before));
  });

  it('allows native Default to repair a legacy bypass while retaining its current Q and identity', () => {
    const project = legacyProject();
    const before = structuredClone(project);
    resetInputEq(project, 0);
    expect(project.presets[0].inputEq[4]).toMatchObject({
      ...identity(before.presets[0].inputEq[4]),
      kind: 'peak',
      enabled: true,
      frequency: 1000,
      q: 1.234,
      gain: 0,
    });
    expect(project.presets[0].inputEq[4].coefficients).toBeUndefined();
    expect(project.presets[0].inputEq[4].provenance).toBeUndefined();
    expect(project.presets[0].eqEnabled).toBe(before.presets[0].eqEnabled);
    expect(project.presets.slice(1)).toEqual(before.presets.slice(1));
    expect(unrelated(project)).toEqual(unrelated(before));
  });
});

describe('EQ transaction guards', () => {
  it.each([-1, 3, 0.5, NaN, Infinity])(
    'rejects invalid preset index %s without changes',
    (index) => {
      const project = varied();
      const before = structuredClone(project);
      expect(() => resetInputEq(project, index)).toThrow('preset index');
      expect(() => copyInputEqToPresets(project, index, [0])).toThrow('preset index');
      expect(() => copyInputEqToPresets(project, 0, [1, index])).toThrow('preset index');
      expect(project).toEqual(before);
    },
  );

  it('requires exactly three distinct presets with nine bands each', () => {
    for (const count of [2, 4]) {
      const project = varied();
      project.presets = Array.from({ length: count }, (_, i) =>
        structuredClone(project.presets[i % 3]),
      );
      expect(() => snapshotEqBank(project)).toThrow('exactly three');
    }
    for (const count of [8, 10]) {
      const project = varied();
      project.presets[2].inputEq = Array.from({ length: count }, (_, i) =>
        structuredClone(project.presets[0].inputEq[i % 9]),
      );
      const before = structuredClone(project);
      expect(() => resetInputEq(project, 0)).toThrow('exactly nine');
      expect(() => copyInputEqToPresets(project, 0, [1])).toThrow('exactly nine');
      expect(project).toEqual(before);
    }
    const project = varied();
    project.presets[2] = project.presets[0];
    expect(() => resetInputEq(project, 0)).toThrow('Aliased presets');
  });

  it.each([
    { kind: 'lowpass2' },
    { kind: 'raw' },
    { kind: 'allpass1', enabled: false },
    { kind: 'unity', enabled: true },
    { frequency: 0 },
    { frequency: 50001 },
    { frequency: NaN },
    { q: 0 },
    { q: 70 },
    { gain: Infinity },
    { gain: 40 },
    { coefficients: { b0: 1, b1: 0, b2: 0, f1: NaN, f2: 0 } },
    { coefficients: { b0: 1, b1: 0, b2: 0, f1: 2, f2: 0 } },
  ])('rejects inappropriate or unencodable bank filters atomically: %o', (patch) => {
    const project = varied();
    const bank = snapshotEqBank(project);
    Object.assign(bank[2].bands[8], patch);
    const before = structuredClone(project);
    expect(() => applyEqBank(project, bank)).toThrow();
    expect(project).toEqual(before);
  });

  it('checks disabled parameters that would otherwise bypass design validation', () => {
    const project = varied();
    Object.assign(project.presets[2].inputEq[7], { enabled: false, q: 0 });
    const before = structuredClone(project);
    expect(() => snapshotEqBank(project)).toThrow('Q');
    expect(() => copyInputEqToPresets(project, 0, [1])).toThrow('Q');
    expect(() => resetInputEq(project, 2)).toThrow('Q');
    expect(project).toEqual(before);
  });

  it('rejects malformed bank sizes, enabled states and later bands before any mutation', () => {
    const project = varied();
    const bank = snapshotEqBank(project);
    const before = structuredClone(project);
    for (const size of [0, 2, 4]) {
      const malformed = Array.from({ length: size }, (_, i) => bank[i % 3]);
      expect(() => applyEqBank(project, malformed)).toThrow('exactly three');
    }
    const missingFlag = structuredClone(bank);
    delete (missingFlag[2] as Partial<EqBank[number]>).enabled;
    expect(() => applyEqBank(project, missingFlag)).toThrow('active state');
    const missingBand = structuredClone(bank);
    missingBand[2].bands.pop();
    expect(() => applyEqBank(project, missingBand)).toThrow('exactly nine');
    expect(project).toEqual(before);
  });
});
