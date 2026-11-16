import { expect, it } from 'vitest';
import { newProject } from '../src/domain/model';
import { resolveChannelDelayProfiles } from '../src/domain/channel-delay-profile';

it('uses the verified fresh offline FA503 bound without changing saved metadata or values', () => {
  const project = newProject();
  project.presets[0].channels[0].hfdDelay = { localMaximum: 19, globalMaximum: 74666.6666666667 };
  project.presets[0].channels[0].delayUs = 25000;
  const before = structuredClone(project);
  const profiles = resolveChannelDelayProfiles(project, 0, 0);
  expect(profiles.local).toEqual({
    kind: 'local',
    unit: 'us',
    sampleRate: 93750,
    minimumText: '0',
    maximumText: '19200',
  });
  expect(profiles.global.maximumText).toBe('74666.6666666667');
  expect(project).toEqual(before);
  expect(Object.isFrozen(profiles.local)).toBe(true);
});

it.each([
  ['0.255', '19200'],
  ['1.0', '19200'],
  ['1.49', '19200'],
  ['1.50', '32000'],
  ['2.0', '32000'],
  ['5.1', '32000'],
  ['255.255', '32000'],
])('resolves native VersionNr/BuildNr from current core %s', (core, maximum) => {
  expect(
    resolveChannelDelayProfiles(newProject(), 0, 0, {
      kind: 'connected',
      core,
      sessionKey: 'current-session',
    }).local.maximumText,
  ).toBe(maximum);
});

it('fences a replacement session even when both profiles have the same numeric bounds', () => {
  const project = newProject();
  const a = resolveChannelDelayProfiles(project, 0, 0, {
    kind: 'connected',
    core: '5.1',
    sessionKey: 'A',
  });
  const b = resolveChannelDelayProfiles(project, 0, 0, {
    kind: 'connected',
    core: '5.1',
    sessionKey: 'B',
  });
  expect(a.local).toEqual(b.local);
  expect(a.contextKey).not.toBe(b.contextKey);
});

it.each(['5.01', '05.1', '5.1.0', '5.7 firmware', '256.0', '1.256', '-1.0', '', 'NaN.1'])(
  'refuses an ambiguous connected core %s rather than assuming offline',
  (core) => {
    expect(() =>
      resolveChannelDelayProfiles(newProject(), 0, 0, { kind: 'connected', core, sessionKey: 'A' }),
    ).toThrow(/runtime/);
  },
);

it('uses each channel own stored global limit, including zero and fractions', () => {
  const project = newProject();
  project.presets[0].channels[0].hfdDelay = { globalMaximum: 19 };
  project.presets[0].channels[1].hfdDelay = { globalMaximum: 0 };
  project.presets[0].channels[2].hfdDelay = { globalMaximum: 123.456789012345 };
  expect(
    [0, 1, 2].map((i) => resolveChannelDelayProfiles(project, 0, i).global.maximumText),
  ).toEqual(['19', '0', '123.456789012345']);
});

it('uses the explicit factory limit only for a browser design with no native XML', () => {
  const project = newProject();
  expect(resolveChannelDelayProfiles(project, 0, 0).global.maximumText).toBe('74666.6666666667');
  project.sourceXml = '<project/>';
  expect(() => resolveChannelDelayProfiles(project, 0, 0)).toThrow(/limit is missing/);
  project.presets[0].channels[0].hfdDelay = { globalMaximum: 37 };
  expect(resolveChannelDelayProfiles(project, 0, 0).global.maximumText).toBe('37');
});

it.each([NaN, Infinity, -1])('refuses invalid typed global maximum %s', (maximum) => {
  const project = newProject();
  project.presets[0].channels[0].hfdDelay = { globalMaximum: maximum };
  expect(() => resolveChannelDelayProfiles(project, 0, 0)).toThrow(/invalid/);
});

it('does not infer connected firmware from source XML buildnr or saved local maxima', () => {
  const project = newProject();
  project.sourceXml = '<project><device buildnr="255"/></project>';
  project.presets[0].channels[0].hfdDelay = { globalMaximum: 12, localMaximum: 48000 };
  expect(resolveChannelDelayProfiles(project, 0, 0).local.maximumText).toBe('19200');
});
