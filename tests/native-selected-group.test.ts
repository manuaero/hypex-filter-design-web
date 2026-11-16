// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { exportHfd, importHfd, parseProject } from '../src/domain/files';
import { HFD_TEMPLATE } from '../src/domain/hfd-template';
import { newProject } from '../src/domain/model';
import { importProjectFolder, projectFiles } from '../src/domain/project-io';

function nativeXml(value: string | null) {
  // Synthetic template reconstruction; -1 and2 are the saved native view IDs.
  // No native/user XML, hardware state, or navigation callback is simulated.
  const doc = new DOMParser().parseFromString(HFD_TEMPLATE, 'application/xml');
  let selected = doc.querySelector('project > selectedgroupid');
  if (value === null) selected?.remove();
  else {
    if (!selected) {
      selected = doc.createElement('selectedgroupid');
      doc.documentElement.appendChild(selected);
    }
    selected.setAttribute('value', value);
  }
  return new XMLSerializer().serializeToString(doc);
}

function selectedValue(xml: string) {
  return new DOMParser()
    .parseFromString(xml, 'application/xml')
    .querySelector('project > selectedgroupid')
    ?.getAttribute('value');
}

it.each([-1, 2])('retains saved native selectedgroupid %s through XML reopening', (id) => {
  const project = importHfd(nativeXml(String(id)), 'Selected-group reconstruction');
  expect(project.hfdSelectedGroupId).toBe(id);
  expect(selectedValue(exportHfd(project))).toBe(String(id));
  expect(importHfd(exportHfd(project), 'Reopened selection').hfdSelectedGroupId).toBe(id);
});

it('retains unsupported signed32 IDs as metadata without choosing a replacement channel', () => {
  for (const id of [-2147483648, -17, 0, 4, 2147483647]) {
    const project = importHfd(nativeXml(String(id)), 'Unknown native group');
    expect(project.hfdSelectedGroupId).toBe(id);
    expect(selectedValue(exportHfd(project))).toBe(String(id));
    expect(parseProject(JSON.stringify(project)).hfdSelectedGroupId).toBe(id);
  }
});

it('gives new projects the native automatic-open sentinel -1', () => {
  const project = newProject();
  expect(project.hfdSelectedGroupId).toBe(-1);
  expect(selectedValue(exportHfd(project))).toBe('-1');
});

it('keeps typed metadata absent when the imported native element is absent', () => {
  const project = importHfd(nativeXml(null), 'Legacy native project');
  expect(project.hfdSelectedGroupId).toBeUndefined();
  expect(selectedValue(exportHfd(project))).toBeUndefined();
});

it('does not overwrite a legacy raw source value when JSON lacks the typed metadata', () => {
  const project = importHfd(nativeXml('17'), 'Legacy JSON with native source');
  delete project.hfdSelectedGroupId;
  const legacy = parseProject(JSON.stringify(project));
  expect(legacy.hfdSelectedGroupId).toBeUndefined();
  expect(selectedValue(exportHfd(legacy))).toBe('17');
});

it('updates only the selected-group export field and leaves cached processing untouched', () => {
  const project = importHfd(nativeXml('-1'), 'Explicit selected channel');
  project.presets[0].channels[0].gain = 24;
  project.presets[0].channels[0].additionalGain = 6;
  project.presets[1].channels[2].gain = -7;
  const before = structuredClone(project),
    oldXml = exportHfd(project);
  project.hfdSelectedGroupId = 2;
  const nextXml = exportHfd(project),
    eraseSelection = (xml: string) => {
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      doc.querySelector('project > selectedgroupid')!.remove();
      return new XMLSerializer().serializeToString(doc);
    };
  expect(selectedValue(nextXml)).toBe('2');
  expect(eraseSelection(nextXml)).toBe(eraseSelection(oldXml));
  expect(project).toEqual({ ...before, hfdSelectedGroupId: 2 });
  expect(importHfd(nextXml, 'Metadata-only reopen').presets[0].channels[0]).toMatchObject({
    gain: 24,
    additionalGain: 6,
  });
});

it('retains explicit selection through JSON and a bound folder sidecar', () => {
  const project = importHfd(nativeXml('-1'), 'Selection persistence');
  project.hfdSelectedGroupId = 2;
  for (const reopened of [
    parseProject(JSON.stringify(project)),
    importProjectFolder(projectFiles(project)),
  ]) {
    expect(reopened.hfdSelectedGroupId).toBe(2);
    expect(selectedValue(exportHfd(reopened))).toBe('2');
  }
});

it('rejects malformed or out-of-range native integer literals', () => {
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
    expect(() => importHfd(nativeXml(value), 'Invalid selected group')).toThrow(/selectedgroupid/i);
  const doc = new DOMParser().parseFromString(nativeXml('2'), 'application/xml');
  doc.querySelector('project > selectedgroupid')!.removeAttribute('value');
  expect(() => importHfd(new XMLSerializer().serializeToString(doc), 'Missing integer')).toThrow(
    /selectedgroupid/i,
  );
});

it('rejects duplicate native selection elements rather than silently taking the first', () => {
  const doc = new DOMParser().parseFromString(nativeXml('2'), 'application/xml');
  doc.documentElement.appendChild(doc.querySelector('project > selectedgroupid')!.cloneNode(true));
  expect(() =>
    importHfd(new XMLSerializer().serializeToString(doc), 'Duplicate selection'),
  ).toThrow(/selectedgroupid/i);
});

it('validates the typed signed32 metadata in both JSON and direct XML export', () => {
  for (const value of [1.5, -2147483649, 2147483648, '2', null, true]) {
    const project = { ...newProject(), hfdSelectedGroupId: value };
    expect(() => parseProject(JSON.stringify(project))).toThrow();
    expect(() => exportHfd(project as ReturnType<typeof newProject>)).toThrow();
  }
  for (const value of [NaN, Infinity, -Infinity])
    expect(() => exportHfd({ ...newProject(), hfdSelectedGroupId: value })).toThrow();
});
