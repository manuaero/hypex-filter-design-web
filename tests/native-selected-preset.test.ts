// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { exportHfd, importHfd, parseProject } from '../src/domain/files';
import { HFD_TEMPLATE } from '../src/domain/hfd-template';
import { newProject, type Project } from '../src/domain/model';

function nativeXml(value: string | null) {
  // Synthetic blank template, not a saved user/native oracle project.
  const doc = new DOMParser().parseFromString(HFD_TEMPLATE, 'application/xml');
  const device = doc.querySelector('project > device')!;
  if (value === null) device.removeAttribute('selectedpreset');
  else device.setAttribute('selectedpreset', value);
  return new XMLSerializer().serializeToString(doc);
}

function selectedValue(xml: string) {
  return new DOMParser()
    .parseFromString(xml, 'application/xml')
    .querySelector('project > device')!
    .getAttribute('selectedpreset');
}

it('gives new projects the native saved-preset default 1', () => {
  const project = newProject();
  expect(project.hfdSelectedPreset).toBe(1);
  expect(selectedValue(exportHfd(project))).toBe('1');
});

it('retains native selectedpreset 3 through passive XML and JSON reopening', () => {
  const project = importHfd(nativeXml('3'), 'Saved preset metadata');
  expect(project.hfdSelectedPreset).toBe(3);
  expect(selectedValue(exportHfd(project))).toBe('3');
  expect(importHfd(exportHfd(project), 'Reopened').hfdSelectedPreset).toBe(3);
  expect(parseProject(JSON.stringify(project)).hfdSelectedPreset).toBe(3);
});

it('preserves unsupported signed32 preset IDs as metadata', () => {
  for (const id of [-2147483648, -1, 0, 4, 2147483647]) {
    const project = importHfd(nativeXml(String(id)), 'Unsupported preset ID');
    expect(project.hfdSelectedPreset).toBe(id);
    expect(selectedValue(exportHfd(project))).toBe(String(id));
  }
});

it('keeps the typed preset absent when native XML has no attribute', () => {
  const project = importHfd(nativeXml(null), 'Legacy native project');
  expect(project.hfdSelectedPreset).toBeUndefined();
  expect(selectedValue(exportHfd(project))).toBeNull();
});

it('does not overwrite legacy raw XML when a browser snapshot lacks typed metadata', () => {
  const project = importHfd(nativeXml('17'), 'Legacy browser snapshot');
  delete project.hfdSelectedPreset;
  const reopened = parseProject(JSON.stringify(project));
  expect(reopened.hfdSelectedPreset).toBeUndefined();
  expect(selectedValue(exportHfd(reopened))).toBe('17');
});

it('updates only the selectedpreset export attribute without changing processing', () => {
  const project = importHfd(nativeXml('3'), 'Explicit metadata export');
  project.presets[0].channels[0].gain = 24;
  project.presets[0].channels[0].additionalGain = 10;
  const before = structuredClone(project),
    oldXml = exportHfd(project);
  project.hfdSelectedPreset = 1;
  const nextXml = exportHfd(project);
  const withoutPreset = (xml: string) => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    doc.querySelector('project > device')!.removeAttribute('selectedpreset');
    return new XMLSerializer().serializeToString(doc);
  };
  expect(selectedValue(nextXml)).toBe('1');
  expect(withoutPreset(nextXml)).toBe(withoutPreset(oldXml));
  expect(project).toEqual({ ...before, hfdSelectedPreset: 1 });
});

it('rejects malformed and out-of-range native selectedpreset attributes', () => {
  for (const value of [
    '',
    ' ',
    '1.5',
    '2e0',
    'NaN',
    'Infinity',
    '0x2',
    '2tail',
    '-2147483649',
    '2147483648',
  ])
    expect(() => importHfd(nativeXml(value), 'Invalid native preset')).toThrow(/selectedpreset/i);
});

it('validates optional signed32 metadata in snapshots and direct exports', () => {
  for (const value of [1.5, -2147483649, 2147483648, '2', null, true]) {
    const project = { ...newProject(), hfdSelectedPreset: value };
    expect(() => parseProject(JSON.stringify(project))).toThrow();
    expect(() => exportHfd(project as Project)).toThrow();
  }
  for (const value of [NaN, Infinity, -Infinity])
    expect(() => exportHfd({ ...newProject(), hfdSelectedPreset: value })).toThrow();
});
