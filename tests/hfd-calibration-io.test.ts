// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { HFD_TEMPLATE } from '../src/domain/hfd-template';
import { newProject } from '../src/domain/model';
import { exportHfd, importHfd, parseProject } from '../src/domain/files';
import { importProjectFolder, projectFiles, type ProjectFile } from '../src/domain/project-io';
import { parseHfdCalibration } from '../src/domain/hfd-calibration';

const content = '* native header retained\r\n10\t6\r\n100000\t6\r\n';
function xml(filename = 'mic.txt', loaded = true, showCurve = false, withImpulse = false) {
  const doc = new DOMParser().parseFromString(HFD_TEMPLATE, 'application/xml');
  doc.querySelector('project > microphone > filename')!.setAttribute('value', filename);
  doc.querySelector('project > microphone > loaded')!.setAttribute('value', String(loaded));
  doc
    .querySelector('project > microphonecorrectionenabled')!
    .setAttribute('value', String(showCurve));
  if (withImpulse) {
    const channel = doc.querySelector(
      'preset[index="1"] > processobj[processtype="ptImpulse"][groupid="1"]',
    )!;
    channel.querySelector('filename')!.setAttribute('value', 'driver.dat');
    channel.querySelector('applymiccorr')!.setAttribute('value', 'true');
  }
  return new XMLSerializer().serializeToString(doc);
}
const folder = (text = content): ProjectFile[] => [
  { path: 'Project/Config.xml', content: xml('mic.txt', true, false, true) },
  { path: 'Project/mic.txt', content: text },
  { path: 'Project/driver.dat', content: '1\n0' },
];

describe('project-wide native correction persistence', () => {
  it('preserves an unresolved native reference and keeps curve visibility separate from channel application', () => {
    const project = importHfd(xml('missing.txt', true, true), 'Unresolved');
    expect(project.hfdCalibration).toEqual({
      filename: 'missing.txt',
      loaded: true,
      showCurve: true,
    });
    expect(project.presets[0].channels[0].hfdMeasurement?.applyMicCorrection).toBe(false);
    expect(importHfd(exportHfd(project), 'Readback').hfdCalibration).toEqual(
      project.hfdCalibration,
    );
  });

  it('loads the exact relative correction file, retains raw content and recomputes native data', () => {
    const project = importProjectFolder(folder());
    expect(project.hfdCalibration).toEqual({
      filename: 'mic.txt',
      loaded: true,
      showCurve: false,
      resource: { content, curve: parseHfdCalibration(content, 'mic.txt') },
    });
    expect(
      project.presets[0].channels[0].measurement?.hfdMagnitude?.linearMagnitude[512],
    ).toBeCloseTo(10 ** (-6 / 20), 5);
    const exported = projectFiles(project);
    expect(exported.find((file) => file.path === 'mic.txt')?.content).toBe(content);
    expect(importProjectFolder(exported).hfdCalibration).toEqual(project.hfdCalibration);
    const nativeOnly = importProjectFolder(exported.filter((f) => f.path !== 'FusionProject.json'));
    expect(nativeOnly.hfdCalibration).toEqual(project.hfdCalibration);
    expect(nativeOnly.presets[0].channels[0].measurement?.hfdMagnitude).toEqual(
      project.presets[0].channels[0].measurement?.hfdMagnitude,
    );
  });

  it('preserves raw native file order/duplicates through strict JSON without inventing phase or sample rate', () => {
    const raw = '*header\n1000 3\n100 1\n100 2\n';
    const project = newProject('Raw resource');
    project.hfdCalibration = {
      filename: 'mic.dat',
      loaded: true,
      showCurve: false,
      smoothingOctaves: 0.015,
      resource: { content: raw, curve: parseHfdCalibration(raw, 'mic.dat') },
    };
    expect(parseProject(JSON.stringify(project))).toEqual(project);
    const mismatch = structuredClone(project);
    mismatch.hfdCalibration!.resource!.curve.magnitude[0] += 1;
    expect(() => parseProject(JSON.stringify(mismatch))).toThrow('does not match');
    const extra = structuredClone(project) as typeof project & {
      hfdCalibration: { resource: { curve: { phase: number[] } } };
    };
    extra.hfdCalibration.resource.curve.phase = [0, 0, 0];
    expect(() => parseProject(JSON.stringify(extra))).toThrow();
    expect(parseProject(JSON.stringify(newProject())).hfdCalibration).toBeUndefined();
  });

  it('keeps the resource after measurement Clear and rewrites relative references to safe export basenames', () => {
    const files = folder();
    files[0].content = xml('calibration/mic.txt', true, true, true);
    files[1].path = 'Project/calibration/mic.txt';
    const project = importProjectFolder(files);
    delete project.presets[0].channels[0].measurement;
    const exported = projectFiles(project);
    expect(exported.find((file) => file.path === 'mic.txt')?.content).toBe(content);
    const native = importProjectFolder(
      exported.filter((file) => file.path !== 'FusionProject.json'),
    );
    expect(native.hfdCalibration?.filename).toBe('mic.txt');
    expect(native.hfdCalibration?.resource?.content).toBe(content);
    expect(native.presets[0].channels[0].measurement).toBeUndefined();
  });

  it('does not borrow a basename from another directory and rejects ambiguous resource files', () => {
    const missing = folder();
    missing[0].content = xml('calibration/mic.txt');
    missing[1].path = 'Unrelated/mic.txt';
    const project = importProjectFolder(missing);
    expect(project.hfdCalibration?.loaded).toBe(true);
    expect(project.hfdCalibration?.resource).toBeUndefined();
    expect(project.warnings.join(' ')).toContain('Missing microphone correction file');
    expect(() => importProjectFolder([...folder(), { path: 'PROJECT/MIC.TXT', content }])).toThrow(
      'Ambiguous',
    );
  });

  it('lets native correction-file edits invalidate a stale sidecar and guards DAT filename collisions', () => {
    const project = importProjectFolder(folder());
    const exported = projectFiles(project);
    exported.find((file) => file.path === 'mic.txt')!.content = content.replaceAll('\t6', '\t12');
    const changed = importProjectFolder(exported);
    expect(changed.hfdCalibration?.resource?.curve.magnitude).toEqual([12, 12]);
    expect(changed.warnings.join(' ')).toContain('snapshot is stale');
    expect(
      changed.presets[0].channels[0].measurement?.hfdMagnitude?.linearMagnitude[512],
    ).toBeCloseTo(10 ** (-12 / 20), 5);
    project.hfdCalibration!.filename = 'P1_CH1.dat';
    expect(() => projectFiles(project)).toThrow('collides');
  });
});
