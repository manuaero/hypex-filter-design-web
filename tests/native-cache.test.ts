// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { HFD_TEMPLATE } from '../src/domain/hfd-template';
import { exportHfd, importHfd, parseProject, resolveGainCache } from '../src/domain/files';
import { captureNativeCacheWitness, validNativeCacheWitness } from '../src/domain/native-cache';
import {
  copyNativeLinkedChannel,
  settleNativeLinkedCopyCache,
} from '../src/domain/native-linked-copy';
import { newProject } from '../src/domain/model';
import { encodeChannel } from '../src/domain/dsp';

// Sanitized synthetic effective-cache input: native V53 E retained this direct
// vector instead of replacing it with the parameter-designed Peak response.
const effectiveRaw = {
  b0: 2.445749199542239,
  b1: -4.1758432203528795,
  b2: 1.779779561293355,
  f1: 1.85236017184606,
  f2: -0.874553956539528,
};
function effectiveProject() {
  const doc = new DOMParser().parseFromString(HFD_TEMPLATE, 'application/xml');
  doc.documentElement.removeAttribute('fusion-studio-coefficient-cache');
  const first = doc.querySelector(
    'preset[index="1"] processobj[processtype="ptBiQuad"][groupid="1"]',
  )!;
  const gain = doc.querySelector(
    'preset[index="1"] processobj[processtype="ptGain"][groupid="1"]',
  )!;
  first.setAttribute('enabled', 'true');
  for (const [field, value] of Object.entries({
    filtertype: 'ftBoostCut',
    f1: 2300,
    q1: 1.15,
    gain: 7.5,
    b0: effectiveRaw.b0,
    b1: effectiveRaw.b1,
    b2: effectiveRaw.b2,
    a1: effectiveRaw.f1,
    a2: effectiveRaw.f2,
  }))
    first.querySelector(field)!.setAttribute('value', String(value));
  gain.querySelector('gain')!.setAttribute('value', '-3');
  gain.querySelector('additionalgain')!.setAttribute('value', '10');
  return importHfd(new XMLSerializer().serializeToString(doc), 'Synthetic effective cache');
}

it('captures original effective native Doubles independently of their canonical first cache', () => {
  const project = effectiveProject(),
    channel = project.presets[0].channels[0];
  expect(channel.coefficientCache).toBe('effective');
  expect(validNativeCacheWitness(channel)?.native).toEqual(effectiveRaw);
  expect(channel.filters[0].coefficients).not.toEqual(effectiveRaw);
});
it('persists the bound witness through JSON without depending on source XML lookup', () => {
  const project = effectiveProject();
  delete project.sourceXml;
  const reopened = parseProject(JSON.stringify(project));
  expect(validNativeCacheWitness(reopened.presets[0].channels[0])?.native).toEqual(effectiveRaw);
});
it('exports the valid raw cache with explicit normalization metadata after gain changes', () => {
  const project = effectiveProject(),
    channel = project.presets[0].channels[0],
    canonical = structuredClone(channel.filters[0].coefficients);
  channel.gain = -6;
  channel.filters[0].enabled = false;
  const text = exportHfd(project),
    doc = new DOMParser().parseFromString(text, 'application/xml');
  const first = doc.querySelector(
    'preset[index="1"] processobj[processtype="ptBiQuad"][groupid="1"]',
  )!;
  expect(Number(first.querySelector('b1')!.getAttribute('value'))).toBe(effectiveRaw.b1);
  const reopened = importHfd(text, 'Reopened raw witness').presets[0].channels[0];
  expect(reopened.gain).toBe(-6);
  expect(reopened.filters[0].enabled).toBe(false);
  expect(reopened.filters[0].coefficients).toEqual(canonical);
  expect(reopened.coefficientCache).toBe('effective');
});

it('keeps canonical root-gain export separate from preserved effective direct coefficients', () => {
  const project = effectiveProject(),
    canonical = project.presets[0].channels[0].filters[0].coefficients!,
    doc = new DOMParser().parseFromString(exportHfd(project), 'application/xml'),
    first = doc.querySelector('preset[index="1"] processobj[processtype="ptBiQuad"][groupid="1"]')!;
  expect(Number(first.querySelector('b0')!.getAttribute('value'))).toBe(effectiveRaw.b0);
  expect(Number(first.querySelector('zconst')!.getAttribute('value'))).toBe(canonical.b0);
});
function linkedEffective() {
  const project = effectiveProject();
  project.presets[0].channels[1].linkedTo = 0;
  return project;
}
function matchingEffectiveTarget() {
  const project = linkedEffective(),
    [source, target] = project.presets[0].channels;
  target.gain = source.gain;
  target.invert = source.invert;
  target.muted = source.muted;
  target.delayUs = source.delayUs;
  target.globalDelayUs = source.globalDelayUs;
  target.additionalGain = source.additionalGain;
  target.fir = structuredClone(source.fir);
  target.filters = source.filters.map((filter, i) => {
    const slot = target.filters[i],
      copy = structuredClone(filter);
    copy.id = slot.id;
    if (Object.hasOwn(slot, 'sourceId')) copy.sourceId = slot.sourceId;
    else delete copy.sourceId;
    return copy;
  });
  target.coefficientCache = 'effective';
  delete target.hfdDirectCacheWitness;
  return project;
}
it.each(['missing', 'stale', 'different raw'])(
  'repairs an equal canonical effective destination with %s native evidence',
  (reason) => {
    const project = matchingEffectiveTarget(),
      target = project.presets[0].channels[1];
    if (reason === 'stale') {
      target.hfdDirectCacheWitness = captureNativeCacheWitness(target, effectiveRaw);
      target.hfdDirectCacheWitness.filterIds[14] = 'stale-slot';
    }
    if (reason === 'different raw') {
      const raw = {
        ...effectiveRaw,
        b0: effectiveRaw.b0 * 2,
        b1: effectiveRaw.b1 * 2,
        b2: effectiveRaw.b2 * 2,
      };
      target.hfdDirectCacheWitness = captureNativeCacheWitness(target, raw, {
        gain: 3.020599913279622,
        additionalGain: 10,
        invert: false,
        coefficientCache: 'effective',
      });
      expect(validNativeCacheWitness(target)?.native).toEqual(raw);
    }
    expect(copyNativeLinkedChannel(project, 0, 1)).toBe(true);
    settleNativeLinkedCopyCache(project, 0, 1);
    expect(validNativeCacheWitness(target)?.native).toEqual(effectiveRaw);
  },
);
it('retains a genuine effective canonical/raw/metadata no-op exactly', () => {
  const project = matchingEffectiveTarget(),
    target = project.presets[0].channels[1];
  target.hfdDirectCacheWitness = captureNativeCacheWitness(target, effectiveRaw);
  const before = structuredClone(project);
  expect(copyNativeLinkedChannel(project, 0, 1)).toBe(false);
  expect(settleNativeLinkedCopyCache(project, 0, 1)).toBe(false);
  expect(project).toEqual(before);
});
it('replaces a one-ULP raw witness difference even when both canonical Unity caches are identical', () => {
  const project = newProject(),
    [source, target] = project.presets[0].channels,
    canonical = { b0: 1, b1: 0, b2: 0, f1: 0, f2: 0 },
    sourceRaw = { ...canonical, b0: 0.5011872336272722 },
    targetRaw = { ...canonical, b0: 0.5011872336272724 };
  source.gain = target.gain = -6;
  source.coefficientCache = target.coefficientCache = 'effective';
  source.filters[0].coefficients = { ...canonical };
  target.filters[0].coefficients = { ...canonical };
  source.hfdDirectCacheWitness = captureNativeCacheWitness(source, sourceRaw);
  target.hfdDirectCacheWitness = captureNativeCacheWitness(target, targetRaw, {
    gain: -5.999999999999999,
    invert: false,
    coefficientCache: 'effective',
  });
  target.linkedTo = 0;
  expect(source.filters[0].coefficients).toEqual(target.filters[0].coefficients);
  expect(copyNativeLinkedChannel(project, 0, 1)).toBe(true);
  settleNativeLinkedCopyCache(project, 0, 1);
  expect(validNativeCacheWitness(target)?.native).toEqual(sourceRaw);
});
it('copies native type/provenance when canonical electrical data already matches', () => {
  const project = matchingEffectiveTarget(),
    target = project.presets[0].channels[1];
  delete target.filters[0].sourceType;
  delete target.filters[0].provenance;
  target.hfdDirectCacheWitness = captureNativeCacheWitness(target, effectiveRaw);
  expect(copyNativeLinkedChannel(project, 0, 1)).toBe(true);
  expect(target.filters[0].sourceType).toBe('ftBoostCut');
  expect(target.filters[0].provenance).toBe('hfd');
});
it('copies native E raw data into only the destination, preserving local Add, identities and driver state', () => {
  const project = linkedEffective(),
    target = project.presets[0].channels[1];
  target.additionalGain = 0;
  target.name = 'Local driver';
  target.measurement = { name: 'Local measurement', sampleRate: 48000, impulse: [0, 1] };
  delete target.filters[2].sourceId;
  const before = structuredClone(project),
    ids = target.filters.map((f) => f.id),
    sourceIds = target.filters.map((f) => ({
      present: Object.hasOwn(f, 'sourceId'),
      value: f.sourceId,
    }));
  expect(copyNativeLinkedChannel(project, 0, 1)).toBe(true);
  expect(settleNativeLinkedCopyCache(project, 0, 1)).toBe(false);
  expect(target).toMatchObject({
    gain: -3,
    additionalGain: 0,
    invert: false,
    muted: false,
    name: 'Local driver',
    coefficientCache: 'unresolved',
  });
  expect(target.filters[0].coefficients).toEqual(effectiveRaw);
  expect(target.filters.map((f) => f.id)).toEqual(ids);
  expect(
    target.filters.map((f) => ({ present: Object.hasOwn(f, 'sourceId'), value: f.sourceId })),
  ).toEqual(sourceIds);
  expect(() => encodeChannel(target)).toThrow('Resolve');
  const withoutTarget = structuredClone(project);
  withoutTarget.presets[0].channels[1] = before.presets[0].channels[1];
  expect(withoutTarget).toEqual(before);
});
it('uses the immediate linked source rather than flattening a chain to its root', () => {
  const project = newProject(),
    [root, middle, target] = project.presets[0].channels;
  root.gain = 2;
  middle.gain = -7;
  middle.linkedTo = 0;
  middle.filters[0] = {
    ...middle.filters[0],
    kind: 'raw',
    enabled: true,
    coefficients: { b0: 0.75, b1: 0.125, b2: 0.0625, f1: 0.25, f2: -0.125 },
  };
  middle.coefficientCache = 'base';
  target.linkedTo = 1;
  expect(copyNativeLinkedChannel(project, 0, 2)).toBe(true);
  settleNativeLinkedCopyCache(project, 0, 2);
  expect(target.gain).toBe(-7);
  expect(target.filters[0].coefficients).toEqual(middle.filters[0].coefficients);
  expect(target.linkedTo).toBe(1);
});
it('settles known effective data under final cold-callback Add without recopying processing', () => {
  const project = linkedEffective(),
    target = project.presets[0].channels[1];
  target.additionalGain = 6;
  copyNativeLinkedChannel(project, 0, 1);
  expect(target.coefficientCache).toBe('unresolved');
  target.additionalGain = 10;
  expect(settleNativeLinkedCopyCache(project, 0, 1)).toBe(true);
  expect(target.coefficientCache).toBe('effective');
  expect(target.filters[0].coefficients).toEqual(
    project.presets[0].channels[0].filters[0].coefficients,
  );
  expect(validNativeCacheWitness(target)?.native).toEqual(effectiveRaw);
  const reopened = importHfd(exportHfd(project), 'Settled raw vector').presets[0].channels[1];
  expect(reopened.filters[0].coefficients).toEqual(target.filters[0].coefficients);
  expect(validNativeCacheWitness(reopened)?.native).toEqual(effectiveRaw);
});
it('keeps unknown source U unknown even if a later scalar would make its raw vector unambiguous', () => {
  const project = linkedEffective(),
    [source, target] = project.presets[0].channels,
    raw = { b0: 0.75, b1: 0.125, b2: 0.0625, f1: 0.25, f2: -0.125 };
  source.filters[0].coefficients = raw;
  source.coefficientCache = 'unresolved';
  source.hfdDirectCacheWitness = captureNativeCacheWitness(source, raw);
  target.additionalGain = 6;
  copyNativeLinkedChannel(project, 0, 1);
  target.additionalGain = 3; // copied Gain-3 now makes scalar exactly1
  settleNativeLinkedCopyCache(project, 0, 1);
  expect(target.coefficientCache).toBe('unresolved');
  expect(target.filters[0].coefficients).toEqual(raw);
  expect(() => encodeChannel(target)).toThrow('Resolve');
});
it('allows an explicit known-base source to replace old destination ambiguity', () => {
  const project = newProject(),
    [source, target] = project.presets[0].channels;
  source.gain = -4;
  source.filters[0] = {
    ...source.filters[0],
    kind: 'raw',
    enabled: true,
    coefficients: { b0: 0.75, b1: 0.125, b2: 0.0625, f1: 0.25, f2: -0.125 },
  };
  source.coefficientCache = 'base';
  target.linkedTo = 0;
  target.coefficientCache = 'unresolved';
  copyNativeLinkedChannel(project, 0, 1);
  settleNativeLinkedCopyCache(project, 0, 1);
  expect(target.coefficientCache).toBe('base');
  expect(() => encodeChannel(target)).not.toThrow();
});
it('retains a valid raw witness after gain, Add, inversion and bypass changes without source XML', () => {
  const project = linkedEffective(),
    source = project.presets[0].channels[0];
  delete project.sourceXml;
  source.gain = -4;
  source.additionalGain = 7;
  source.invert = true;
  source.filters[0].enabled = false;
  expect(validNativeCacheWitness(source)?.native).toEqual(effectiveRaw);
  expect(copyNativeLinkedChannel(project, 0, 1)).toBe(true);
  expect(project.presets[0].channels[1].filters[0].coefficients).toEqual(effectiveRaw);
  expect(project.presets[0].channels[1].filters[0].enabled).toBe(false);
});
it('repairs a legacy effective cache only through a full passive XML binding without mutating its source', () => {
  const project = linkedEffective(),
    source = project.presets[0].channels[0];
  delete source.hfdDirectCacheWitness;
  source.gain = -4;
  source.filters[0].enabled = false;
  const before = structuredClone(source);
  copyNativeLinkedChannel(project, 0, 1);
  expect(project.presets[0].channels[1].filters[0].coefficients).toEqual(effectiveRaw);
  expect(source).toEqual(before);
  expect(Object.hasOwn(source, 'hfdDirectCacheWitness')).toBe(false);
});
it.each(['nonfirst parameter', 'source identity', 'class', 'no XML', 'stale witness'])(
  'refuses an unproved effective source (%s) before any destination write',
  (reason) => {
    const project = linkedEffective(),
      source = project.presets[0].channels[0];
    delete source.hfdDirectCacheWitness;
    if (reason === 'nonfirst parameter') source.filters[8].frequency += 1;
    if (reason === 'source identity') delete source.filters[8].sourceId;
    if (reason === 'class') source.filters[0].coefficients!.b0 += 0.01;
    if (reason === 'no XML') delete project.sourceXml;
    if (reason === 'stale witness') {
      source.hfdDirectCacheWitness = captureNativeCacheWitness(source, effectiveRaw);
      source.filters[0].frequency += 1;
      delete project.sourceXml;
    }
    const before = structuredClone(project);
    expect(() => copyNativeLinkedChannel(project, 0, 1)).toThrow(/Reimport|reimport/);
    expect(project).toEqual(before);
  },
);
it('preserves exact nonreconstructible raw Double bits after explicit effective resolution and JSON/XML', () => {
  const project = newProject(),
    [source, target] = project.presets[0].channels,
    raw = {
      b0: 1.28734873744321,
      b1: -1.92017414830364,
      b2: 0.655018836373937,
      f1: 1.85236017184606,
      f2: -0.874553956539528,
    };
  source.additionalGain = 10;
  source.filters[0] = {
    ...source.filters[0],
    kind: 'raw',
    enabled: true,
    coefficients: { ...raw },
  };
  source.coefficientCache = 'unresolved';
  resolveGainCache(source, 'effective');
  expect(source.filters[0].coefficients!.b1 * 10 ** 0.5).not.toBe(raw.b1);
  target.linkedTo = 0;
  const reopened = parseProject(JSON.stringify(project));
  copyNativeLinkedChannel(reopened, 0, 1);
  expect(reopened.presets[0].channels[1].filters[0].coefficients).toEqual(raw);
  const xmlReopened = importHfd(exportHfd(reopened), 'Exact raw vector');
  expect(xmlReopened.presets[0].channels[1].filters[0].coefficients).toEqual(raw);
});
it('keeps a canonical no-op free of caches, witness/provenance and sourceId properties', () => {
  const project = newProject(),
    target = project.presets[0].channels[1];
  target.linkedTo = 0;
  const before = structuredClone(project);
  expect(copyNativeLinkedChannel(project, 0, 1)).toBe(false);
  expect(settleNativeLinkedCopyCache(project, 0, 1)).toBe(false);
  expect(project).toEqual(before);
  expect(
    target.filters.every((f) => !Object.hasOwn(f, 'sourceId') && !Object.hasOwn(f, 'coefficients')),
  ).toBe(true);
  expect(Object.hasOwn(target, 'hfdDirectCacheWitness')).toBe(false);
});
it('rejects settlement without copy authority or after an intervening processing edit', () => {
  const project = linkedEffective();
  expect(() => settleNativeLinkedCopyCache(project, 0, 1)).toThrow('settlement');
  copyNativeLinkedChannel(project, 0, 1);
  project.presets[0].channels[1].filters[0].frequency += 1;
  const before = structuredClone(project);
  expect(() => settleNativeLinkedCopyCache(project, 0, 1)).toThrow('settlement');
  expect(project).toEqual(before);
});
it.each(['extra field', 'short identities', 'wrong normalization'])(
  'rejects malformed persisted witness metadata (%s)',
  (reason) => {
    const project = effectiveProject(),
      witness = project.presets[0].channels[0].hfdDirectCacheWitness!;
    if (reason === 'extra field') Object.assign(witness, { override: true });
    if (reason === 'short identities') witness.filterIds.pop();
    if (reason === 'wrong normalization') witness.native.b0 += 1;
    expect(() => parseProject(JSON.stringify(project))).toThrow();
  },
);
it('does not export a stale witness or reconstruct its original raw bits', () => {
  const project = effectiveProject(),
    source = project.presets[0].channels[0];
  source.filters[0].coefficients!.b1 += 0.01;
  expect(validNativeCacheWitness(source)).toBeUndefined();
  const xml = exportHfd(project),
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.querySelector('[fusion-studio-cache-context]')).toBeNull();
  const reopened = importHfd(xml, 'Canonical stale export').presets[0].channels[0];
  expect(reopened.coefficientCache).toBe('base');
  expect(reopened.filters[0].coefficients).toEqual(source.filters[0].coefficients);
});
it('requires a new proof after ordered slot identities change without an XML binding', () => {
  const project = linkedEffective(),
    source = project.presets[0].channels[0];
  delete project.sourceXml;
  source.filters[14].id = 'replacement-slot';
  expect(validNativeCacheWitness(source)).toBeUndefined();
  const before = structuredClone(project);
  expect(() => copyNativeLinkedChannel(project, 0, 1)).toThrow(/Reimport|reimport/);
  expect(project).toEqual(before);
});
it('refuses aliased channel slots before writing the selected destination', () => {
  const project = linkedEffective();
  project.presets[0].channels[1].filters = project.presets[0].channels[0].filters;
  const before = structuredClone(project);
  expect(() => copyNativeLinkedChannel(project, 0, 1)).toThrow('aliased');
  expect(project).toEqual(before);
});
it.each(['missing', 'extra', 'orphan'])(
  'refuses malformed XML normalization metadata (%s)',
  (reason) => {
    const project = effectiveProject(),
      doc = new DOMParser().parseFromString(exportHfd(project), 'application/xml'),
      gain = doc.querySelector('[fusion-studio-cache-context]')!;
    if (reason === 'missing') gain.removeAttribute('fusion-studio-cache-context');
    if (reason === 'extra')
      gain.setAttribute(
        'fusion-studio-cache-context',
        JSON.stringify({ version: 1, gain: -3, invert: false, override: true }),
      );
    if (reason === 'orphan') gain.removeAttribute('fusion-studio-coefficient-cache');
    expect(() =>
      importHfd(new XMLSerializer().serializeToString(doc), 'Invalid metadata'),
    ).toThrow();
  },
);
