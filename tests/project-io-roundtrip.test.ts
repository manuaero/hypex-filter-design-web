// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { newProject } from '../src/domain/model';
import {
  spectrum,
  applyCalibration,
  smoothMeasurement,
  measurementResponse,
} from '../src/domain/measurement';
import { projectFiles, importProjectFolder, type ProjectFile } from '../src/domain/project-io';

function processedProject() {
  const project = newProject('Processed measurement'),
    impulse = Array.from({ length: 128 }, (_, i) =>
      i === 12 ? 1 : i === 15 ? 0.3 : i === 70 ? 0.5 : 0,
    ),
    windowed = spectrum(impulse, 48000, { start: 8, end: 32, taper: 0.2, timeZero: 12 }),
    calibration = {
      name: 'Microphone correction',
      sampleRate: 48000,
      frequency: [10, 1000, 20000],
      magnitude: [2, 3, 6],
      phase: [0, 0, 0],
    };
  project.presets[0].channels[0].measurement = {
    ...smoothMeasurement(applyCalibration(windowed, calibration), 1 / 3),
    name: 'Windowed driver',
  };
  return project;
}
function sidecar(files: ProjectFile[]) {
  return files.find((f) => f.path === 'FusionProject.json')!;
}
function phaseAt(
  measurement: NonNullable<
    ReturnType<typeof processedProject>['presets'][number]['channels'][number]['measurement']
  >,
) {
  const [re, im] = measurementResponse(measurement, 1000);
  return Math.atan2(im, re);
}

it('round-trips processed window/time-zero/calibration/smoothing state with original DAT samples', () => {
  const project = processedProject(),
    expected = project.presets[0].channels[0].measurement!,
    files = projectFiles(project),
    envelope = JSON.parse(sidecar(files).content),
    imported = importProjectFolder(files),
    actual = imported.presets[0].channels[0].measurement!;
  expect(envelope.nativeFiles).toEqual(files.filter((f) => f.path !== 'FusionProject.json'));
  expect(actual).toEqual(expected);
  expect(imported.name).toBe(project.name);
  expect(files.find((f) => f.path === 'P1_CH1.dat')!.content).toBe(expected.impulse!.join('\n'));
  expect(imported.warnings.join(' ')).toContain(
    'Restored browser-only processed measurement state',
  );
  const nativeOnly = importProjectFolder(files.filter((f) => f.path !== 'FusionProject.json'));
  expect(nativeOnly.presets[0].channels[0].measurement!.impulse).toEqual(expected.impulse);
  expect(nativeOnly.presets[0].channels[0].measurement!.magnitude).not.toEqual(expected.magnitude);
  expect(phaseAt(nativeOnly.presets[0].channels[0].measurement!)).not.toBeCloseTo(
    phaseAt(expected),
    4,
  );
});

it('matches relative native paths when an exported folder is moved or its path casing changes', () => {
  const project = processedProject(),
    files = projectFiles(project).map((f) => ({ ...f, path: `Moved Folder/${f.path}` }));
  files[2].path = files[2].path.toUpperCase();
  expect(importProjectFolder(files).presets[0].channels[0].measurement).toEqual(
    project.presets[0].channels[0].measurement,
  );
});

it('retains browser frequency-only measurements only while the emitted FRD file matches', () => {
  const project = newProject('Frequency-only response');
  project.presets[1].channels[2].measurement = {
    name: 'Measured tweeter',
    sampleRate: 96000,
    frequency: [100, 1000, 10000],
    magnitude: [-12, 0, 3],
    phase: [90, -45, -120],
  };
  const files = projectFiles(project);
  expect(importProjectFolder(files).presets[1].channels[2].measurement).toEqual(
    project.presets[1].channels[2].measurement,
  );
  files.find((f) => f.path === 'P2_CH3.frd')!.content += '\n20000\t0\t0';
  const native = importProjectFolder(files);
  expect(native.presets[1].channels[2].measurement).toBeUndefined();
  expect(native.warnings.join(' ')).toContain('snapshot is stale');
});

it('uses native XML edits instead of overwriting them with a stale sidecar', () => {
  const files = projectFiles(processedProject()),
    config = files[0],
    doc = new DOMParser().parseFromString(config.content, 'application/xml');
  doc
    .querySelector(
      'device > preset[index="1"] > processobj[processtype="ptGain"][groupid="1"] > gain',
    )!
    .setAttribute('value', '-6');
  config.content = new XMLSerializer().serializeToString(doc);
  const imported = importProjectFolder(files);
  expect(imported.presets[0].channels[0].gain).toBe(-6);
  expect(imported.presets[0].channels[0].measurement!.name).toBe('P1_CH1.dat');
  expect(imported.warnings.join(' ')).toContain('snapshot is stale');
  expect(imported.warnings.join(' ')).not.toContain('Restored browser-only');
});

it('uses native DAT edits and reports a missing DAT rather than reviving a stale measurement', () => {
  const files = projectFiles(processedProject());
  files.find((f) => f.path === 'P1_CH1.dat')!.content = '0\n0\n0.5\n0';
  const edited = importProjectFolder(files);
  expect(edited.presets[0].channels[0].measurement!.impulse).toEqual([0, 0, 0.5, 0]);
  expect(edited.warnings.join(' ')).toContain('snapshot is stale');
  const missing = importProjectFolder(files.filter((f) => !f.path.endsWith('.dat')));
  expect(missing.presets[0].channels[0].measurement).toEqual({
    name: 'P1_CH1.dat',
    sampleRate: 48000,
  });
  expect(missing.presets[0].channels[0].measurement?.impulse).toBeUndefined();
  expect(missing.presets[0].channels[0].measurement?.frequency).toBeUndefined();
  expect(missing.warnings.join(' ')).toContain('Missing measurement file: P1_CH1.dat');
  expect(missing.warnings.join(' ')).toContain('snapshot is stale');
});

it('rejects malformed, unvalidated and legacy plain sidecars while preserving native import', () => {
  const project = processedProject(),
    files = projectFiles(project),
    valid = JSON.parse(sidecar(files).content);
  const invalid = [
    '{broken json',
    JSON.stringify({ ...valid, project: { ...valid.project, model: 'FA123' } }),
    JSON.stringify({ ...valid, nativeFiles: [{ path: 'Config.xml', content: 1 }] }),
    JSON.stringify({ ...valid, nativeFiles: [valid.nativeFiles[0], valid.nativeFiles[0]] }),
    JSON.stringify({
      ...valid,
      nativeFiles: [{ path: '../Config.xml', content: files[0].content }],
    }),
    JSON.stringify({ ...valid, version: 999 }),
    JSON.stringify(project),
  ];
  for (const content of invalid) {
    const imported = importProjectFolder(
      files.map((f) => (f.path === 'FusionProject.json' ? { ...f, content } : f)),
    );
    expect(imported.presets[0].channels[0].measurement!.impulse).toEqual(
      project.presets[0].channels[0].measurement!.impulse,
    );
    expect(imported.presets[0].channels[0].measurement!.name).toBe('P1_CH1.dat');
    expect(imported.warnings.join(' ')).toContain('Ignored FusionProject.json');
    expect(imported.warnings.join(' ')).not.toContain('Restored browser-only');
  }
});

it('requires a complete unambiguous native snapshot and never hides invalid native XML', () => {
  const files = projectFiles(processedProject());
  const envelope = JSON.parse(sidecar(files).content);
  envelope.version = 1;
  sidecar(files).content = JSON.stringify(envelope);
  const added = importProjectFolder([...files, { path: 'extra.dat', content: '1\n0' }]);
  expect(added.warnings.join(' ')).toContain('snapshot is stale');
  const duplicate = importProjectFolder([...files, { ...sidecar(files) }]);
  expect(duplicate.warnings.join(' ')).toContain('multiple browser sidecars');
  expect(() =>
    importProjectFolder(
      files.map((f) => (f.path === 'Config.xml' ? { ...f, content: '<project>' } : f)),
    ),
  ).toThrow();
});
