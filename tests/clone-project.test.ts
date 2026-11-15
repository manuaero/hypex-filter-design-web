// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { newFilter, newProject } from '../src/domain/model';
import { exportHfd, parseProject } from '../src/domain/files';
import { importProjectFolder, projectFiles } from '../src/domain/project-io';
import { parseNativeCloneInfo, replaceNativeCloneInfo } from '../src/domain/clone-template';
import {
  exportNativeCloneProject,
  nativeCloneProjectFiles,
  requireNativeCloneTemplate,
} from '../src/domain/clone-project';
import { nativeCloneFixture } from './fixtures/native-clone';

function fixture() {
  const project = newProject('Current staged filters');
  project.hfdCloneTemplate = nativeCloneFixture();
  project.sourceXml = replaceNativeCloneInfo(exportHfd(project), project.hfdCloneTemplate);
  project.presets[0].inputEq[0].gain = 8;
  project.presets[0].eqEnabled = true;
  project.presets[0].channels[0].filters[0] = {
    ...newFilter('peak'),
    frequency: 431,
    gain: 3,
  };
  project.presets[0].channels[0].measurement = {
    name: 'original.dat',
    sampleRate: 48000,
    impulse: [0, 1, -0.25, 0],
  };
  return project;
}

it('requires an actual template and never invents hardware defaults for ordinary browser designs', () => {
  expect(() => exportNativeCloneProject(newProject())).toThrow('no saved amplifier template');
  expect(() => nativeCloneProjectFiles(newProject())).toThrow('no saved amplifier template');
  const project = fixture();
  project.hfdCloneTemplate!.configuration.valid = false;
  expect(parseNativeCloneInfo(exportNativeCloneProject(project))!.configuration.valid).toBe(false);
  const exported = nativeCloneProjectFiles(project);
  expect(
    parseNativeCloneInfo(exported.find((file) => file.path === 'Config.xml')!.content)!
      .configuration.valid,
  ).toBe(false);
});

it('exports current filter design with captured physical EQ and settings without changing ordinary staged-EQ export', () => {
  const project = fixture(),
    before = structuredClone(project),
    native = exportNativeCloneProject(project),
    template = parseNativeCloneInfo(native)!;
  expect(template.eqBanks[0][0].gain).toBe(-1);
  expect(template.settings.presets[0].eqEnabled).toBe(false);
  expect(template.configuration.moduleType).toBe(9);
  expect(parseNativeCloneInfo(exportHfd(project))!.eqBanks[0][0].gain).toBe(8);
  const graph = parseProject(native);
  expect(graph.presets[0].channels[0].filters[0]).toMatchObject({
    kind: 'peak',
    frequency: 431,
    gain: 3,
  });
  expect(graph.presets[0].eqEnabled).toBe(true);
  expect(native).toContain('vendor-extension');
  expect(project).toEqual(before);
});

it('rebinds the exact native-file sidecar while retaining both staged EQ and physical EQ plus original resources', () => {
  const project = fixture(),
    before = structuredClone(project),
    files = nativeCloneProjectFiles(project),
    config = files.find((file) => file.path === 'Config.xml')!,
    sidecar = JSON.parse(files.find((file) => file.path === 'FusionProject.json')!.content);
  expect(parseNativeCloneInfo(config.content)!.eqBanks[0][0].gain).toBe(-1);
  expect(
    sidecar.nativeFiles.find((file: { path: string }) => file.path === 'Config.xml').content,
  ).toBe(config.content);
  expect(sidecar.project.presets[0].inputEq[0].gain).toBe(8);
  expect(sidecar.project.hfdCloneTemplate.eqBanks[0][0].gain).toBe(-1);
  expect(files.find((file) => file.path === 'P1_CH1.dat')!.content).toBe('0\n1\n-0.25\n0');
  const loaded = importProjectFolder(files);
  expect(loaded.presets[0].inputEq[0].gain).toBe(8);
  expect(loaded.hfdCloneTemplate).toEqual(project.hfdCloneTemplate);
  expect(loaded.presets[0].channels[0].measurement).toEqual(
    project.presets[0].channels[0].measurement,
  );
  expect(project).toEqual(before);
});

it('lets native edits invalidate the sidecar rather than restoring a stale physical template or staged EQ', () => {
  const files = nativeCloneProjectFiles(fixture()),
    config = files.find((file) => file.path === 'Config.xml')!;
  config.content = config.content.replace('vendor-extension', 'vendor-edit');
  const loaded = importProjectFolder(files);
  expect(loaded.presets[0].inputEq[0].gain).toBe(-1);
  expect(loaded.hfdCloneTemplate!.unknownInfoXml).toContain('vendor-edit');
  expect(loaded.warnings.some((warning) => warning.includes('snapshot is stale'))).toBe(true);
});

it('adopts native info from legacy JSON only during explicit Clone export and persists a detached typed snapshot in that export', () => {
  const project = fixture(),
    captured = structuredClone(project.hfdCloneTemplate!);
  delete project.hfdCloneTemplate;
  const before = structuredClone(project),
    snapshot = requireNativeCloneTemplate(project);
  snapshot.eqBanks[0][0].gain = 10;
  expect(requireNativeCloneTemplate(project).eqBanks[0][0].gain).toBe(-1);
  const files = nativeCloneProjectFiles(project),
    loaded = importProjectFolder(files);
  expect(loaded.hfdCloneTemplate!.eqBanks).toEqual(captured.eqBanks);
  expect(project).toEqual(before);
  expect(parseNativeCloneInfo(projectFiles(project)[0].content)!.eqBanks[0][0].gain).toBe(8);
});
