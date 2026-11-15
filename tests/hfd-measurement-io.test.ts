// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { HFD_TEMPLATE } from '../src/domain/hfd-template';
import { newProject, type HfdMeasurementOptions } from '../src/domain/model';
import { exportHfd, importHfd, parseProject } from '../src/domain/files';
import { projectFiles, importProjectFolder, type ProjectFile } from '../src/domain/project-io';

// Synthetic, deliberately nondefault XML values; these are not GUI-observed fixtures.
const options: HfdMeasurementOptions = {
  sampleRate: 96000,
  localStart: 5,
  stopInclusive: 31,
  phaseStart: 7,
  sharedStart: 9,
  sharedGroupId: 2,
  fftLength: 65536,
  smoothBw: 0.025,
  smoothPostBw: 0.25,
  applyMicCorrection: true,
};
const selector = 'device > preset[index="1"] > processobj[processtype="ptImpulse"][groupid="1"]';
const xmlKeys = {
  sampleRate: 'meassamplingrate',
  localStart: 'anechstart',
  stopInclusive: 'anechstop',
  phaseStart: 'anechstartcalc',
  sharedStart: 'glbanechstart',
  sharedGroupId: 'glbanechgroupid',
  smoothBw: 'smoothbw',
  smoothPostBw: 'smoothpostbw',
} as const;
function syntheticXml(filename = 'driver.dat') {
  const doc = new DOMParser().parseFromString(HFD_TEMPLATE, 'application/xml');
  const impulse = doc.querySelector(selector)!;
  impulse.querySelector(':scope > filename')!.setAttribute('value', filename);
  for (const [field, tag] of Object.entries(xmlKeys))
    impulse
      .querySelector(`options > ${tag}`)!
      .setAttribute('value', String(options[field as keyof typeof xmlKeys]));
  impulse.querySelector(':scope > applymiccorr')!.setAttribute('value', 'true');
  const unknown = doc.createElement('vendor-option');
  unknown.setAttribute('value', 'preserve me');
  impulse.querySelector('options')!.appendChild(unknown);
  return new XMLSerializer().serializeToString(doc);
}
const impulse: number[] = Array.from({ length: 64 }, (_, i) =>
  i === 10 ? 1 : i === 15 ? -0.25 : 0,
);
const nativeFolder = (): ProjectFile[] => [
  { path: 'Config.xml', content: syntheticXml() },
  { path: 'driver.dat', content: impulse.join('\n') },
];
function cachedProject() {
  const project = newProject('Coherent native cache fixture');
  const channel = project.presets[0].channels[0];
  const frequency = Array.from(
    { length: 1024 },
    (_, i) => 10 * Math.exp((Math.log(93750 / 2 / 10) * i) / 1024),
  );
  channel.hfdMeasurement = { ...options };
  channel.measurement = {
    name: 'Synthetic cache fixture',
    sampleRate: 96000,
    impulse: [1, 0],
    frequency,
    magnitude: frequency.map((_, i) => (i ? 6 : -200)),
    phase: frequency.map((_, i) => (i ? 90 : 0)),
    hfdPhase: { frequency: frequency.slice(), phase: frequency.map((_, i) => 450 + i / 4) },
    hfdMagnitude: {
      frequency: frequency.slice(),
      linearMagnitude: frequency.map((_, i) => (i ? 2 : 0)),
      medianDb: -12.75,
    },
  };
  return project;
}

describe('native HFD measurement persistence', () => {
  it('does not migrate new or legacy browser JSON into native analysis implicitly', () => {
    const project = newProject('Legacy snapshot');
    project.presets[0].channels[0].measurement = {
      name: 'Saved display response',
      sampleRate: 48000,
      frequency: [100, 1000],
      magnitude: [2, -4],
      phase: [123, -87],
      sourceSpectrum: { frequency: [100, 1000], magnitude: [3, -2], phase: [150, -60] },
      processing: { smoothingOctaves: 0.5, calibrationEnabled: false },
    };
    const restored = parseProject(JSON.stringify(project));
    expect(restored).toEqual(project);
    expect(
      restored.presets.every((p) => p.channels.every((c) => c.hfdMeasurement === undefined)),
    ).toBe(true);
    const fromFolder = importProjectFolder(projectFiles(project));
    expect(fromFolder.presets[0].channels[0]).toEqual(project.presets[0].channels[0]);
  });

  it('imports all native options even with no loaded filename', () => {
    const project = importHfd(syntheticXml(''), 'Synthetic no-data options');
    expect(project.presets[0].channels[0].hfdMeasurement).toEqual(options);
    expect(project.presets[0].channels[0].measurement).toBeUndefined();
    expect(
      project.presets.every((p) => p.channels.every((c) => c.hfdMeasurement !== undefined)),
    ).toBe(true);
    expect(project.presets[1].channels[2].hfdMeasurement).toEqual({
      sampleRate: 48000,
      localStart: 0,
      stopInclusive: 65535,
      phaseStart: -1,
      sharedStart: -1,
      sharedGroupId: -1,
      fftLength: 65536,
      smoothBw: 0.0125,
      smoothPostBw: 0.125,
      applyMicCorrection: false,
    });
    expect(project.warnings.join(' ')).toContain('microphone calibration resource is unresolved');
  });

  it('round-trips the native post-smoothing maximum of 10 through XML and JSON', () => {
    const project = importHfd(syntheticXml(''), 'Native post width maximum');
    const channel = project.presets[0].channels[0];
    channel.hfdMeasurement!.smoothPostBw = 10;
    expect(
      parseProject(JSON.stringify(project)).presets[0].channels[0].hfdMeasurement?.smoothPostBw,
    ).toBe(10);
    const restored = importHfd(exportHfd(project), 'Post width readback');
    expect(restored.presets[0].channels[0].hfdMeasurement?.smoothPostBw).toBe(10);
    expect(restored.presets[0].channels[0].hfdMeasurement?.smoothBw).toBe(options.smoothBw);
    channel.hfdMeasurement!.smoothPostBw = 10.01;
    expect(() => parseProject(JSON.stringify(project))).toThrow();
    channel.hfdMeasurement!.smoothPostBw = 10;
    channel.hfdMeasurement!.smoothBw = 3.01;
    expect(() => parseProject(JSON.stringify(project))).toThrow();
  });

  it('preserves the established legacy 96000 Hz DAT export rate without activating browser native mode', () => {
    const project = newProject('Legacy 96 kHz DAT');
    project.presets[0].channels[0].measurement = {
      name: 'Legacy DAT',
      sampleRate: 96000,
      impulse: [0, 1, -0.2, 0],
    };
    const files = projectFiles(project);
    const exact = importProjectFolder(files).presets[0].channels[0];
    expect(exact.hfdMeasurement).toBeUndefined();
    expect(exact.measurement?.sampleRate).toBe(96000);
    const nativeOnly = importProjectFolder(files.filter((f) => f.path !== 'FusionProject.json'));
    expect(nativeOnly.presets[0].channels[0].hfdMeasurement?.sampleRate).toBe(96000);
    expect(nativeOnly.presets[0].channels[0].measurement?.sampleRate).toBe(96000);
  });

  it('strictly round-trips native phase and options through project JSON', () => {
    const project = cachedProject();
    const { frequency, phase } = project.presets[0].channels[0].measurement!.hfdPhase!;
    expect(parseProject(JSON.stringify(project))).toEqual(project);
    for (const bad of [
      { frequency: frequency.slice(1), phase },
      { frequency: frequency.map((f, i) => (i === 3 ? frequency[2] : f)), phase },
      { frequency: frequency.map((f) => f * 1.01), phase },
      { frequency, phase: [Infinity, ...phase.slice(1)] },
      { frequency, phase, surprise: true },
    ]) {
      const candidate = structuredClone(project);
      candidate.presets[0].channels[0].measurement!.hfdPhase = bad;
      expect(() => parseProject(JSON.stringify(candidate))).toThrow();
    }
  });

  it('initializes missing native caches from raw IR without recalculating complete or legacy snapshots', () => {
    const project = newProject('Native raw IR import');
    const [raw, complete, legacy] = project.presets[0].channels;
    raw.hfdMeasurement = { ...options };
    raw.measurement = { name: 'Original driver.dat', sampleRate: 96000, impulse: impulse.slice() };
    Object.assign(complete, cachedProject().presets[0].channels[0]);
    legacy.measurement = {
      name: 'Saved browser response',
      sampleRate: 48000,
      impulse: [0, 1, -0.2, 0],
      frequency: [100, 1000],
      magnitude: [-3, 4],
      phase: [123, -87],
    };
    const before = structuredClone(project);
    const restored = parseProject(JSON.stringify(project));
    const calculated = restored.presets[0].channels[0];
    expect(calculated.hfdMeasurement).toEqual(options);
    expect(calculated.measurement?.impulse).toEqual(impulse);
    expect(calculated.measurement?.hfdPhase?.frequency).toHaveLength(1024);
    expect(calculated.measurement?.hfdMagnitude?.linearMagnitude).toHaveLength(1024);
    expect(restored.presets[0].channels[1]).toEqual(before.presets[0].channels[1]);
    expect(restored.presets[0].channels[2]).toEqual(before.presets[0].channels[2]);
    expect(project).toEqual(before);
    const partial = structuredClone(restored);
    delete partial.presets[0].channels[0].measurement!.hfdPhase;
    expect(parseProject(JSON.stringify(partial)).presets[0].channels[0]).toEqual(calculated);
  });

  it('preserves exact linear zeros and the native median through JSON and validated folder sidecars', () => {
    const project = cachedProject();
    const channel = project.presets[0].channels[0];
    const { frequency, linearMagnitude, medianDb } = channel.measurement!.hfdMagnitude!;
    expect(parseProject(JSON.stringify(project))).toEqual(project);
    const restored = importProjectFolder(projectFiles(project));
    expect(restored.presets[0].channels[0].measurement?.hfdMagnitude).toEqual(
      channel.measurement!.hfdMagnitude,
    );
    expect(restored.presets[0].channels[0].measurement?.hfdMagnitude?.linearMagnitude[0]).toBe(0);
    for (const bad of [
      { frequency: frequency.slice(1), linearMagnitude, medianDb },
      { frequency: frequency.map((f) => f * 1.01), linearMagnitude, medianDb },
      { frequency, linearMagnitude: [-1, ...linearMagnitude.slice(1)], medianDb },
      { frequency, linearMagnitude: [Infinity, ...linearMagnitude.slice(1)], medianDb },
      { frequency, linearMagnitude, medianDb: Infinity },
      { frequency, linearMagnitude, medianDb, surprise: true },
    ]) {
      const candidate = structuredClone(project);
      candidate.presets[0].channels[0].measurement!.hfdMagnitude = bad;
      expect(() => parseProject(JSON.stringify(candidate))).toThrow();
    }
  });

  it('rejects cache/base phase-grid inconsistencies while accepting tiny canonical-grid rounding', () => {
    const project = cachedProject();
    const measurement = project.presets[0].channels[0].measurement!;
    const rounded = measurement.frequency!.map((f) => f * (1 + 1e-12));
    measurement.frequency = rounded;
    measurement.hfdMagnitude!.frequency = rounded.slice();
    measurement.hfdPhase!.frequency = rounded.slice();
    expect(parseProject(JSON.stringify(project))).toEqual(project);
    measurement.frequency[0] += 1e-12;
    expect(() => parseProject(JSON.stringify(project))).toThrow('exactly match');
    measurement.frequency = rounded.slice();
    delete measurement.phase;
    expect(() => parseProject(JSON.stringify(project))).toThrow('exactly match');
  });

  it('rejects oversized native caches without reducing the supported size of legacy spectra', () => {
    const project = cachedProject();
    const channel = project.presets[0].channels[0];
    const frequency = Array.from({ length: 16384 }, (_, i) => 10 * Math.exp(i / 2000));
    const values = frequency.map(() => 0);
    channel.measurement = {
      name: 'Large imported spectrum',
      sampleRate: 96000,
      impulse: [1, 0],
      frequency,
      magnitude: values,
      phase: values,
      hfdPhase: { frequency, phase: values },
      hfdMagnitude: { frequency, linearMagnitude: values, medianDb: 0 },
    };
    expect(() => parseProject(JSON.stringify(project))).toThrow('1024');
    delete channel.hfdMeasurement;
    delete channel.measurement.hfdPhase;
    delete channel.measurement.hfdMagnitude;
    expect(parseProject(JSON.stringify(project))).toEqual(project);
  });

  it('requires native cache ownership and original impulse data but permits unloaded native references', () => {
    const project = cachedProject();
    const channel = project.presets[0].channels[0];
    delete channel.hfdMeasurement;
    expect(() => parseProject(JSON.stringify(project))).toThrow('require the channel HFD');
    channel.hfdMeasurement = { ...options };
    channel.measurement = {
      name: 'Native FRD',
      sampleRate: 96000,
      frequency: [100, 1000],
      magnitude: [0, 1],
    };
    expect(() => parseProject(JSON.stringify(project))).toThrow('requires original impulse');
    channel.measurement = { name: 'Missing driver.dat', sampleRate: 96000 };
    expect(parseProject(JSON.stringify(project))).toEqual(project);
    channel.measurement.sampleRate = 48000;
    expect(() => parseProject(JSON.stringify(project))).toThrow('sample rate must match');
  });

  it('loads DAT data while retaining native metadata and computing its separate phase response', () => {
    const project = importProjectFolder(nativeFolder());
    const channel = project.presets[0].channels[0];
    expect(channel.hfdMeasurement).toEqual(options);
    expect(channel.measurement?.impulse).toEqual(impulse);
    expect(channel.measurement?.sampleRate).toBe(96000);
    expect(channel.measurement?.hfdPhase?.frequency.length).toBeGreaterThan(1000);
    expect(channel.measurement?.processing?.calibration).toBeUndefined();
    const files = projectFiles(project);
    expect(importProjectFolder(files).presets[0].channels[0]).toEqual(channel);
    const nativeOnly = importProjectFolder(files.filter((f) => f.path !== 'FusionProject.json'));
    expect(nativeOnly.presets[0].channels[0].hfdMeasurement).toEqual(options);
    expect(nativeOnly.presets[0].channels[0].measurement).toEqual({
      ...channel.measurement,
      name: 'P1_CH1.dat',
    });
  });

  it('writes modified native options after Clear and preserves unknown source XML', () => {
    const project = importProjectFolder(nativeFolder());
    const channel = project.presets[0].channels[0];
    channel.hfdMeasurement = {
      ...options,
      localStart: 12,
      sharedStart: 14,
      phaseStart: 20,
      smoothBw: 0.05,
    };
    delete channel.measurement; // Clear affects data, not the channel's analysis settings.
    const xml = exportHfd(project);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    expect(doc.querySelector(`${selector} > filename`)!.getAttribute('value')).toBe('');
    expect(doc.querySelector(`${selector} > options > vendor-option`)!.getAttribute('value')).toBe(
      'preserve me',
    );
    const restored = importHfd(xml, 'Cleared');
    expect(restored.presets[0].channels[0].hfdMeasurement).toEqual(channel.hfdMeasurement);
    expect(restored.presets[0].channels[0].measurement).toBeUndefined();
  });

  it('keeps native XML options untouched when the browser channel has no native marker', () => {
    const project = importHfd(syntheticXml(''), 'Legacy options passthrough');
    delete project.presets[0].channels[0].hfdMeasurement;
    const xml = exportHfd(project);
    expect(importHfd(xml, 'Read back').presets[0].channels[0].hfdMeasurement).toEqual(options);
  });

  it('honors native XML and DAT changes over a stale browser snapshot without losing settings', () => {
    const project = importProjectFolder(nativeFolder());
    const files = projectFiles(project);
    const config = files.find((f) => f.path === 'Config.xml')!;
    const doc = new DOMParser().parseFromString(config.content, 'application/xml');
    doc.querySelector(`${selector} > options > glbanechstart`)!.setAttribute('value', '12');
    config.content = new XMLSerializer().serializeToString(doc);
    const changedXml = importProjectFolder(files);
    expect(changedXml.presets[0].channels[0].hfdMeasurement?.sharedStart).toBe(12);
    expect(changedXml.warnings.join(' ')).toContain('snapshot is stale');
    const changedImpulse = impulse.slice();
    changedImpulse[14] = 0.75;
    files.find((f) => f.path === 'P1_CH1.dat')!.content = changedImpulse.join('\n');
    const changedData = importProjectFolder(files).presets[0].channels[0];
    expect(changedData.hfdMeasurement?.sharedStart).toBe(12);
    expect(changedData.measurement?.impulse).toEqual(changedImpulse);
    expect(changedData.measurement?.hfdPhase).not.toEqual(
      project.presets[0].channels[0].measurement?.hfdPhase,
    );
  });

  it('preserves sentinels and empty native buffers, rejecting invalid shared snapshots and bounds', () => {
    const project = newProject('Option validation');
    const channel = project.presets[0].channels[0];
    channel.hfdMeasurement = {
      ...options,
      localStart: 1000,
      stopInclusive: 10,
      phaseStart: 2000,
      sharedStart: -1,
      sharedGroupId: -1,
    };
    expect(parseProject(JSON.stringify(project)).presets[0].channels[0].hfdMeasurement).toEqual(
      channel.hfdMeasurement,
    );
    for (const patch of [
      { sampleRate: 0 },
      { localStart: 0.5 },
      { phaseStart: -(2 ** 31) - 1 },
      { sharedGroupId: 0 },
      { sharedGroupId: 1, sharedStart: 2 ** 31 },
      { stopInclusive: 2 ** 31 },
      { fftLength: 12345 },
      { smoothBw: 4 },
    ]) {
      channel.hfdMeasurement = { ...options, ...patch };
      expect(() => parseProject(JSON.stringify(project))).toThrow();
    }
  });
});
