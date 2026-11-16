// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { HFD_TEMPLATE } from '../src/domain/hfd-template';
import { exportHfd, importHfd, parseProject } from '../src/domain/files';
import { importProjectFolder, projectFiles } from '../src/domain/project-io';
import { encodeChannel } from '../src/domain/dsp';
import { newProject } from '../src/domain/model';
import { normalizeHardwareGainCallback } from '../src/domain/hardware-gain';
import { nativeParameterWheelStates } from './data/hfd-native-parameter-wheels';

function reconstruction(additionalGain: number, hint: string | null, raw = false) {
  // Synthetic container, retaining actual native21 Peak literals only. This is
  // not the vendor/user XML or a physical device snapshot.
  const doc = new DOMParser().parseFromString(HFD_TEMPLATE, 'application/xml'),
    device = doc.querySelector('device')!,
    fixture = nativeParameterWheelStates.additionalGainReload,
    bq = doc.querySelector('preset[index="1"] processobj[id="13"]')!,
    gain = doc.querySelector('preset[index="1"] processobj[id="67"]')!;
  if (hint === null) device.removeAttribute('gainlowered');
  else device.setAttribute('gainlowered', hint);
  bq.setAttribute('enabled', 'true');
  for (const [key, value] of Object.entries({ ...fixture.parameters, ...fixture.coefficients }))
    bq.querySelector(`:scope > ${key}`)!.setAttribute('value', value);
  if (raw) bq.querySelector('filtertype')!.setAttribute('value', 'ftFree');
  gain.querySelector('additionalgain')!.setAttribute('value', String(additionalGain));
  return importHfd(new XMLSerializer().serializeToString(doc), 'Compensation reconstruction');
}

function savedHint(xml: string) {
  return new DOMParser()
    .parseFromString(xml, 'application/xml')
    .querySelector('device')!
    .getAttribute('gainlowered');
}

it.each([
  [10, true], // Actual native21 relationship.
  [6, false], // Synthetic input19 must not be passively normalized to10/true.
  [0, true], // The device hint is independent of this channel's value.
] as const)(
  'preserves native hint %s/%s independently of AdditionalGain',
  (additionalGain, hint) => {
    const project = reconstruction(additionalGain, String(hint)),
      channel = project.presets[0].channels[0],
      before = structuredClone(project);
    expect(project.hfdGainLowered).toBe(hint);
    expect(channel.additionalGain).toBe(additionalGain);
    expect(channel.coefficientCache).toBe('base');
    expect(savedHint(exportHfd(project))).toBe(String(hint));
    expect(project).toEqual(before);
  },
);

it('exports explicit native Off against an old true source hint without ORing other channels', () => {
  const project = reconstruction(10, 'true'),
    channel = project.presets[0].channels[0],
    originalCache = structuredClone(channel.filters),
    other = project.presets[2].channels[2];
  other.additionalGain = 10;
  const peer = structuredClone(other),
    next = normalizeHardwareGainCallback(channel, false);
  channel.gain = next.gain;
  channel.additionalGain = next.additionalGain;
  project.hfdGainLowered = next.hfdGainLowered;
  const xml = exportHfd(project),
    reopened = importHfd(xml, 'Explicit compensation Off');
  expect(savedHint(xml)).toBe('false');
  expect(reopened.hfdGainLowered).toBe(false);
  expect(reopened.presets[0].channels[0].additionalGain).toBe(0);
  expect(reopened.presets[0].channels[0].filters[0].coefficients).toEqual(
    originalCache[0].coefficients,
  );
  expect(channel.filters).toEqual(originalCache);
  expect(other).toEqual(peer);
  expect(reopened.presets[2].channels[2].additionalGain).toBe(10);
});

it('retains false and arbitrary AdditionalGain through JSON and bound folder sidecars', () => {
  const project = reconstruction(6, 'false'),
    cache = structuredClone(project.presets[0].channels[0].filters[0].coefficients);
  for (const reopened of [
    parseProject(JSON.stringify(project)),
    importProjectFolder(projectFiles(project)),
  ]) {
    expect(reopened.hfdGainLowered).toBe(false);
    expect(reopened.presets[0].channels[0].additionalGain).toBe(6);
    expect(reopened.presets[0].channels[0].filters[0].coefficients).toEqual(cache);
    expect(savedHint(exportHfd(reopened))).toBe('false');
  }
});

it('keeps absent legacy metadata optional and retains a legacy source hint on export', () => {
  const blank = newProject();
  expect(parseProject(JSON.stringify(blank)).hfdGainLowered).toBeUndefined();
  expect(reconstruction(6, null).hfdGainLowered).toBeUndefined();
  const legacy = reconstruction(6, 'true');
  delete legacy.hfdGainLowered;
  const reopened = parseProject(JSON.stringify(legacy));
  expect(reopened.hfdGainLowered).toBeUndefined();
  expect(savedHint(exportHfd(reopened))).toBe('true');
});

it('rejects malformed native gainlowered rather than coercing truthy text', () => {
  expect(() => reconstruction(6, 'false-ish')).toThrow(/gainlowered/i);
});

it.each(['false', 0])('rejects nonboolean JSON hint %s', (hint) => {
  expect(() => parseProject(JSON.stringify({ ...newProject(), hfdGainLowered: hint }))).toThrow();
});

it('keeps unresolved raw-cache refusal after explicit compensation Off and every persistence route', () => {
  const project = reconstruction(10, 'true', true),
    channel = project.presets[0].channels[0],
    coefficients = structuredClone(channel.filters[0].coefficients),
    next = normalizeHardwareGainCallback(channel, false);
  expect(channel.coefficientCache).toBe('unresolved');
  channel.gain = next.gain;
  channel.additionalGain = next.additionalGain;
  project.hfdGainLowered = next.hfdGainLowered;
  for (const reopened of [
    project,
    importHfd(exportHfd(project), 'Compensation with unresolved cache'),
    parseProject(JSON.stringify(project)),
    importProjectFolder(projectFiles(project)),
  ]) {
    const output = reopened.presets[0].channels[0];
    expect(reopened.hfdGainLowered).toBe(false);
    expect(output.coefficientCache).toBe('unresolved');
    expect(output.filters[0].coefficients).toEqual(coefficients);
    expect(() => encodeChannel(output)).toThrow(/Resolve/);
  }
});
