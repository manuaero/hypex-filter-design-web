// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { HFD_TEMPLATE } from '../src/domain/hfd-template';
import { newProject } from '../src/domain/model';
import { parseProjectOpen } from '../src/domain/project-open';

afterEach(() => vi.unstubAllGlobals());

it('classifies actual native XML after validation and forwards the import name', () => {
  const decoded = parseProjectOpen(` \n\t${HFD_TEMPLATE}`, 'Native input');
  expect(decoded.format).toBe('hfd-native');
  expect(decoded.project.name).toBe('Native input');
  expect(decoded.project.sourceXml).toBe(` \n\t${HFD_TEMPLATE}`);
});

it('classifies browser JSON containing native sourceXml as a browser snapshot', () => {
  const project = newProject('Saved browser state');
  project.sourceXml = HFD_TEMPLATE;
  project.hfdSelectedGroupId = 2;
  const decoded = parseProjectOpen(` \n${JSON.stringify(project)}`, 'Ignored snapshot filename');
  expect(decoded.format).toBe('browser-snapshot');
  expect(decoded.project).toEqual(project);
});

it('retains a legacy browser snapshot without adding native preset or group defaults', () => {
  const project = newProject('Legacy snapshot');
  delete project.hfdSelectedPreset;
  delete project.hfdSelectedGroupId;
  const decoded = parseProjectOpen(JSON.stringify(project));
  expect(decoded.format).toBe('browser-snapshot');
  expect(decoded.project.hfdSelectedPreset).toBeUndefined();
  expect(decoded.project.hfdSelectedGroupId).toBeUndefined();
});

it('does not apply FileOpen gain or microphone refresh effects or perform I/O', () => {
  const forbidden = vi.fn(() => {
    throw new Error('Unexpected network operation');
  });
  vi.stubGlobal('fetch', forbidden);
  const doc = new DOMParser().parseFromString(HFD_TEMPLATE, 'application/xml');
  const device = doc.querySelector('project > device')!;
  device.setAttribute('selectedpreset', '3');
  doc.querySelector('project > selectedgroupid')!.setAttribute('value', '2');
  const preset = device.querySelector('preset')!;
  const gain = preset.querySelector('processobj[processtype="ptGain"][groupid="2"]')!;
  gain.querySelector('gain')!.setAttribute('value', '24');
  gain.querySelector('additionalgain')!.setAttribute('value', '10');
  preset
    .querySelector('processobj[processtype="ptImpulse"][groupid="2"] > applymiccorr')!
    .setAttribute('value', 'true');
  const decoded = parseProjectOpen(new XMLSerializer().serializeToString(doc));
  expect(decoded.format).toBe('hfd-native');
  expect(decoded.project).toMatchObject({ hfdSelectedPreset: 3, hfdSelectedGroupId: 2 });
  expect(decoded.project.presets[0].channels[1]).toMatchObject({
    gain: 24,
    additionalGain: 10,
    hfdMeasurement: { applyMicCorrection: true },
  });
  expect(decoded.project.presets.slice(1).every((p) => p.channels.every((c) => c.gain === 0))).toBe(
    true,
  );
  expect(forbidden).not.toHaveBeenCalled();
});

it('rejects invalid native input instead of returning a format-tagged result', () => {
  expect(() => parseProjectOpen('<project/>')).toThrow();
});

it('rejects invalid JSON and snapshot schemas instead of inferring intent from a filename', () => {
  expect(() => parseProjectOpen('{invalid', 'Config.xml')).toThrow();
  expect(() => parseProjectOpen('{}', 'Config.xml')).toThrow();
  expect(parseProjectOpen(JSON.stringify(newProject()), 'Config.xml').format).toBe(
    'browser-snapshot',
  );
});
