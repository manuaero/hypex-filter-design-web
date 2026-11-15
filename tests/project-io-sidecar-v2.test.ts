// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { newProject, type Project } from '../src/domain/model';
import { processMeasurement, spectrum } from '../src/domain/measurement';
import { loadProjectMicrophone } from '../src/domain/hfd-microphone';
import { importProjectFolder, projectFiles, type ProjectFile } from '../src/domain/project-io';

const correction = '20 6\n1000 6\n20000 6';
function processedProject() {
  const project = newProject('Browser processing retained');
  project.presets[0].channels[0].measurement = processMeasurement(
    spectrum(
      Array.from({ length: 128 }, (_, i) => (i === 16 ? 1 : i === 28 ? 0.4 : 0)),
      48000,
    ),
    {
      window: { start: 8, end: 64, taper: 0.2, timeZero: 16 },
      smoothingOctaves: 1 / 3,
      calibration: {
        name: 'Browser curve',
        sampleRate: 48000,
        frequency: [20, 1000, 20000],
        magnitude: [2, 3, 5],
        phase: [10, 20, 30],
      },
      calibrationEnabled: true,
    },
  );
  return project;
}
function envelope(files: ProjectFile[]) {
  return JSON.parse(files.find((file) => file.path === 'FusionProject.json')!.content);
}
function changeEnvelope(
  files: ProjectFile[],
  change: (value: ReturnType<typeof envelope>) => void,
) {
  const value = envelope(files);
  change(value);
  files.find((file) => file.path === 'FusionProject.json')!.content = JSON.stringify(value);
}
function isRestored(project: Project) {
  return project.warnings.some((warning) => warning.startsWith('Restored browser-only'));
}
function expectNative(project: Project) {
  expect(isRestored(project)).toBe(false);
  expect(project.warnings.join(' ')).toContain('Ignored FusionProject.json');
}
function replaceConfigReference(files: ProjectFile[], filename: string) {
  const config = files.find((file) => file.path === 'Config.xml')!;
  const doc = new DOMParser().parseFromString(config.content, 'application/xml');
  doc
    .querySelector(
      'device > preset[index="1"] > processobj[processtype="ptImpulse"][groupid="1"] > filename',
    )!
    .setAttribute('value', filename);
  config.content = new XMLSerializer().serializeToString(doc);
  changeEnvelope(files, (value) => {
    value.nativeFiles.find((file: ProjectFile) => file.path === 'Config.xml').content =
      config.content;
  });
}

describe('version 2 HFD-folder exact snapshots', () => {
  it('allows unrelated preserved files while restoring the complete processed document', () => {
    const project = processedProject(),
      files = projectFiles(project);
    expect(envelope(files).version).toBe(2);
    const imported = importProjectFolder(
      [
        ...files,
        { path: 'notes.txt', content: 'Keep these notes.' },
        { path: 'old-unreferenced.DAT', content: '0\n.75\n0' },
        { path: 'Previous.xml', content: '<previous />' },
        { path: 'old-response.frd', content: '100\t-3\t0' },
      ].map((file) => ({ ...file, path: `Moved Folder/${file.path}` })),
    );
    expect(isRestored(imported)).toBe(true);
    expect({ ...imported, warnings: project.warnings }).toEqual(project);
    expect(imported.presets[0].channels[0].measurement!.processing).toEqual(
      project.presets[0].channels[0].measurement!.processing,
    );
  });

  it.each(['edit', 'missing', 'duplicate'] as const)('invalidates a %s listed DAT', (mutation) => {
    let files = projectFiles(processedProject());
    const dat = files.find((file) => file.path === 'P1_CH1.dat')!;
    if (mutation === 'edit') dat.content = '0\n.5\n0';
    if (mutation === 'missing') files = files.filter((file) => file !== dat);
    if (mutation === 'duplicate') files.push({ ...dat, path: 'p1_ch1.DAT' });
    expectNative(importProjectFolder(files));
  });

  it('does not let an edited native Config hide behind unrelated extras', () => {
    const files = projectFiles(processedProject());
    const doc = new DOMParser().parseFromString(files[0].content, 'application/xml');
    doc
      .querySelector(
        'device > preset[index="1"] > processobj[processtype="ptGain"][groupid="1"] > gain',
      )!
      .setAttribute('value', '-6');
    files[0].content = new XMLSerializer().serializeToString(doc);
    expectNative(importProjectFolder([...files, { path: 'notes.txt', content: 'notes' }]));
  });

  it('rejects an injected incomplete manifest that omits a referenced DAT', () => {
    const files = projectFiles(processedProject());
    changeEnvelope(files, (value) => {
      value.nativeFiles = value.nativeFiles.filter(
        (file: ProjectFile) => file.path !== 'P1_CH1.dat',
      );
      value.project.name = 'Injected stale document';
    });
    const imported = importProjectFolder(files);
    expectNative(imported);
    expect(imported.name).not.toBe('Injected stale document');
    expect(imported.presets[0].channels[0].measurement!.impulse).toHaveLength(128);
  });

  it.each(['missing.dat', 'missing.csv'])(
    'does not hide a newly available native %s reference',
    (filename) => {
      const project = newProject('Unloaded resource');
      project.presets[0].channels[0].measurement = { name: filename, sampleRate: 48000 };
      const files = projectFiles(project);
      expect(isRestored(importProjectFolder(files))).toBe(true);
      const imported = importProjectFolder([...files, { path: filename, content: '0\n1\n0' }]);
      expectNative(imported);
      expect(imported.presets[0].channels[0].measurement!.impulse).toEqual([0, 1, 0]);
    },
  );

  it('rejects a newly resolved unlisted basename when the exact DAT path is absent', () => {
    const project = newProject('Unloaded nested resource');
    project.presets[0].channels[0].measurement = { name: 'sub/missing.dat', sampleRate: 48000 };
    const imported = importProjectFolder([
      ...projectFiles(project),
      { path: 'Elsewhere/missing.dat', content: '0\n.25\n0' },
    ]);
    expectNative(imported);
    expect(imported.presets[0].channels[0].measurement!.impulse).toEqual([0, 0.25, 0]);
  });

  it('allows a uniquely listed fallback but rejects ambiguous basename fallback', () => {
    const files = projectFiles(processedProject());
    replaceConfigReference(files, 'Missing/P1_CH1.dat');
    expect(isRestored(importProjectFolder(files))).toBe(true);
    expectNative(importProjectFolder([...files, { path: 'Other/P1_CH1.dat', content: '0\n.5' }]));
  });

  it('keeps unique exact-path precedence over an inert basename elsewhere', () => {
    const project = processedProject();
    const imported = importProjectFolder([
      ...projectFiles(project),
      { path: 'Other/P1_CH1.dat', content: '0\n.5' },
    ]);
    expect(isRestored(imported)).toBe(true);
    expect(imported.presets[0].channels[0].measurement).toEqual(
      project.presets[0].channels[0].measurement,
    );
  });

  it.each(['mic.txt', 'mic.cal'])(
    'does not hide an unlisted exact microphone resource %s',
    (filename) => {
      const project = newProject('Unloaded microphone');
      project.hfdCalibration = { filename, loaded: false, showCurve: false };
      const files = projectFiles(project);
      expect(isRestored(importProjectFolder(files))).toBe(true);
      const imported = importProjectFolder([...files, { path: filename, content: correction }]);
      expectNative(imported);
      expect(imported.hfdCalibration!.resource!.content).toBe(correction);
    },
  );

  it('does not apply DAT-style basename fallback to microphone files', () => {
    const project = newProject('Missing exact microphone');
    project.hfdCalibration = { filename: 'Missing/mic.txt', loaded: false, showCurve: false };
    expect(
      isRestored(
        importProjectFolder([
          ...projectFiles(project),
          { path: 'Other/mic.txt', content: correction },
        ]),
      ),
    ).toBe(true);
  });

  it('matches writer-preserved Unicode spelling in a moved folder without changing content', () => {
    const project = processedProject();
    loadProjectMicrophone(project, correction, 'caf\u00e9.txt');
    const files = projectFiles(project).map((file) => ({
      ...file,
      path: `Moved/${file.path === 'caf\u00e9.txt' ? 'cafe\u0301.txt' : file.path}`,
    }));
    const imported = importProjectFolder(files);
    expect(isRestored(imported)).toBe(true);
    expect({ ...imported, warnings: project.warnings }).toEqual(project);
    const alias = { path: 'Moved/caf\u00e9.txt', content: correction };
    expectNative(importProjectFolder([...files, alias]));
  });

  it('rejects duplicate normalized unrelated names rather than claiming an exact folder', () => {
    const files = projectFiles(processedProject());
    expectNative(
      importProjectFolder([
        ...files,
        { path: 'Notes.txt', content: 'a' },
        { path: 'notes.TXT', content: 'b' },
      ]),
    );
  });

  it.each(['../notes.txt', './notes.txt', 'sub//notes.txt', 'C:notes.txt', 'bad\u0000.txt'])(
    'rejects unsafe manifest path %s',
    (path) => {
      const files = projectFiles(processedProject());
      changeEnvelope(files, (value) => value.nativeFiles.push({ path, content: 'ignored' }));
      expectNative(importProjectFolder([...files, { path, content: 'ignored' }]));
    },
  );

  it('rejects duplicate manifest aliases and duplicate browser sidecars', () => {
    const files = projectFiles(processedProject());
    changeEnvelope(files, (value) =>
      value.nativeFiles.push({ path: 'p1_ch1.DAT', content: files[2].content }),
    );
    expectNative(importProjectFolder(files));
    const valid = projectFiles(processedProject());
    expectNative(importProjectFolder([...valid, { ...valid[1], path: 'fusionproject.JSON' }]));
  });

  it('retains strict version 1 complete-folder behavior', () => {
    const files = projectFiles(processedProject());
    changeEnvelope(files, (value) => (value.version = 1));
    expect(isRestored(importProjectFolder(files))).toBe(true);
    expectNative(importProjectFolder([...files, { path: 'notes.txt', content: 'preserved' }]));
    expectNative(importProjectFolder([...files, { path: 'old.dat', content: '0\n1' }]));
  });
});
