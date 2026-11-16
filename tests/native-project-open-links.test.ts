import { expect, it } from 'vitest';
import { newProject } from '../src/domain/model';
import { parseProjectOpen } from '../src/domain/project-open';
import {
  applyNativeProjectOpen,
  planNativeProjectOpen,
  prepareNativeProjectOpen,
  validateNativeProjectOpen,
} from '../src/application/native-project-open';
import { createWorkspaceStore } from '../src/state/workspace';

function fixture() {
  const project = newProject('Saved-preset link context');
  project.hfdSelectedPreset = 3;
  project.hfdSelectedGroupId = 777;
  project.sourceXml = '<project original="retained" />';
  project.warnings = ['Existing native warning'];
  for (const [p, preset] of project.presets.entries())
    for (const [c, channel] of preset.channels.entries()) {
      channel.gain = p * 3 + c;
      channel.additionalGain = c === 1 ? 0 : 10;
      channel.coefficientCache = 'unresolved';
      channel.filters[0].coefficients = {
        b0: 0.75,
        b1: (p * 3 + c) / 100,
        b2: 0,
        f1: 0.1,
        f2: 0,
      };
      channel.filters[0].provenance = 'hfd';
      channel.filters[0].sourceId = `native-${p}-${c}`;
    }
  project.presets[0].channels[1].gain = 24;
  project.presets[0].channels[1].invert = true;
  project.presets[0].channels[1].muted = true;
  project.presets[0].channels[1].delayUs = 1;
  project.presets[0].channels[1].linkedTo = 0;
  project.presets[1].channels[2].linkedTo = 0;
  project.presets[2].channels[1].linkedTo = 0;
  return project;
}

it('saved P3 resolves only its links before runtime P1 metadata replaces the original selection', () => {
  const project = fixture(),
    before = structuredClone(project),
    prepared = prepareNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'inner' });
  expect(project).toEqual(before);
  expect(prepared.selection).toBeNull();
  expect(prepared.project.hfdSelectedPreset).toBe(1);
  expect(prepared.project.presets[0].channels[1].linkedTo).toBeUndefined();
  expect(prepared.project.presets[1].channels[2].linkedTo).toBeUndefined();
  expect(prepared.project.presets[2].channels[1].linkedTo).toBe(0);
  expect(prepared.plan.patch.linkResolution).toMatchObject({
    resolvedPresetIndex: 2,
    unresolvedLinks: [
      { presetIndex: 0, channelIndex: 1, channelId: before.presets[0].channels[1].id, linkedTo: 0 },
      { presetIndex: 1, channelIndex: 2, channelId: before.presets[1].channels[2].id, linkedTo: 0 },
    ],
  });
  expect(Object.isFrozen(prepared.plan.patch.linkResolution!.unresolvedLinks[0])).toBe(true);
  const expected = structuredClone(before);
  expected.hfdSelectedPreset = 1;
  delete expected.presets[0].channels[1].linkedTo;
  delete expected.presets[1].channels[2].linkedTo;
  expected.warnings = prepared.project.warnings;
  expect(prepared.project).toEqual(expected);
  expect(prepared.project.warnings).toHaveLength(2);
  expect(prepared.project.warnings[1]).toMatch(/saved preset 3.*2.*deactivated/i);
  expect(prepared.project.sourceXml).toBe(before.sourceXml);
});

it('valid saved P1 links remain unchanged without copying the master or claiming a Graph', () => {
  const project = fixture();
  project.hfdSelectedPreset = 1;
  delete project.presets[1].channels[2].linkedTo;
  delete project.presets[2].channels[1].linkedTo;
  const before = structuredClone(project),
    prepared = prepareNativeProjectOpen(project, 'right', { presetIndex: 0, route: 'inner' });
  expect(prepared.selection).toBeNull();
  expect(prepared.plan.changed).toBe(false);
  expect(prepared.project).toEqual(before);
  expect(prepared.project.presets[0].channels[1]).toMatchObject({
    gain: 24,
    invert: true,
    muted: true,
    delayUs: 1,
    linkedTo: 0,
    coefficientCache: 'unresolved',
  });
});

it('resolved acyclic chains retain immediate sources rather than flattening to their root', () => {
  const project = fixture();
  delete project.presets[0].channels[1].linkedTo;
  delete project.presets[1].channels[2].linkedTo;
  project.presets[2].channels[2].linkedTo = 1;
  const before = structuredClone(project),
    prepared = prepareNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'inner' });
  expect(prepared.project.presets[2].channels.map((channel) => channel.linkedTo)).toEqual([
    undefined,
    0,
    1,
  ]);
  expect(prepared.project.presets).toEqual(before.presets);
  expect(prepared.project.warnings).toEqual(before.warnings);
});

it.each([undefined, 0, -1, 4, 2147483647])(
  'linked native Open refuses original saved preset %s without changing either role',
  (savedPreset) => {
    const project = fixture();
    if (savedPreset === undefined) delete project.hfdSelectedPreset;
    else project.hfdSelectedPreset = savedPreset;
    const before = structuredClone(project);
    for (const route of ['dialog', 'inner'] as const) {
      expect(() => planNativeProjectOpen(project, 'left', { presetIndex: 0, route })).toThrow(
        /original.*saved preset|saved preset.*links/i,
      );
      expect(() => prepareNativeProjectOpen(project, 'right', { presetIndex: 0, route })).toThrow(
        /original.*saved preset|saved preset.*links/i,
      );
      expect(project).toEqual(before);
    }
  },
);

it.each([undefined, 0, -1, 4, 2147483647])(
  'unlinked legacy native Open preserves its prior behavior for saved preset %s',
  (savedPreset) => {
    const project = fixture();
    for (const preset of project.presets)
      for (const channel of preset.channels) delete channel.linkedTo;
    if (savedPreset === undefined) delete project.hfdSelectedPreset;
    else project.hfdSelectedPreset = savedPreset;
    const before = structuredClone(project),
      prepared = prepareNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'inner' });
    expect(prepared.project).toEqual({ ...before, hfdSelectedPreset: 1 });
    expect(project).toEqual(before);
  },
);

it('link deactivation is a real document delta even when no preset or microphone field changes', () => {
  const project = fixture();
  project.hfdSelectedPreset = 1;
  const before = structuredClone(project),
    plan = planNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'inner' });
  expect(plan.changed).toBe(true);
  expect(plan.patch.hfdSelectedPreset).toBeUndefined();
  expect(plan.patch.microphoneChanges).toEqual([]);
  expect(project).toEqual(before);
});

it('deactivation warning is deduplicated while a newly loaded unresolved link is still removed', () => {
  const project = fixture(),
    first = prepareNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'inner' });
  const warning = first.project.warnings.at(-1)!;
  project.warnings.push(warning);
  const prepared = prepareNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'inner' });
  expect(prepared.project.warnings).toEqual(project.warnings);
  expect(prepared.project.warnings.filter((value) => value === warning)).toHaveLength(1);
  expect(prepared.project.presets[0].channels[1].linkedTo).toBeUndefined();
});

it('the original saved preset and full role context remain bound until detached application', () => {
  const project = fixture(),
    plan = planNativeProjectOpen(project, 'left', { presetIndex: 0, route: 'inner' }),
    draft = structuredClone(project),
    before = structuredClone(draft);
  expect(() => applyNativeProjectOpen(draft, 'right', plan)).toThrow(/role|detached/);
  expect(draft).toEqual(before);
  project.hfdSelectedPreset = 1;
  expect(() => validateNativeProjectOpen(plan, project, 'left')).toThrow(/changed/);
  expect(() => applyNativeProjectOpen(draft, 'left', plan)).toThrow(/detached/);
  expect(draft).toEqual(before);
});

it('browser snapshots with original native XML keep all their canonical links passively', () => {
  const project = fixture(),
    decoded = parseProjectOpen(JSON.stringify(project));
  expect(decoded.format).toBe('browser-snapshot');
  expect(decoded.project).toEqual(project);
});

it('two native role proposals deactivate independently in one exact workspace Undo', async () => {
  let saved: unknown = null;
  const backend = {
    read: async () => saved,
    write: async (value: unknown) => {
      saved = structuredClone(value);
    },
    readLegacy: () => null,
  };
  const workspace = createWorkspaceStore(backend);
  await workspace.persistence.hydrate();
  const documents = { left: fixture(), right: fixture() };
  documents.right.hfdSelectedPreset = 1;
  workspace.store.setState({ documents, past: [], future: [], gesture: undefined });
  const current = workspace.store.getState,
    before = structuredClone(current().documents),
    plans = {
      left: planNativeProjectOpen(current().documents.left, 'left', {
        presetIndex: 0,
        route: 'inner',
      }),
      right: planNativeProjectOpen(current().documents.right, 'right', {
        presetIndex: 0,
        route: 'inner',
      }),
    };
  for (const slot of ['left', 'right'] as const)
    validateNativeProjectOpen(plans[slot], current().documents[slot], slot);
  current().editAt(
    ['left', 'right'],
    (project, slot) => applyNativeProjectOpen(project, slot, plans[slot]),
    { synchronizeLinks: false },
  );
  expect(current().documents.left.presets[2].channels[1].linkedTo).toBe(0);
  expect(current().documents.left.presets[0].channels[1].linkedTo).toBeUndefined();
  expect(current().documents.right.presets[0].channels[1].linkedTo).toBe(0);
  expect(current().documents.right.presets[2].channels[1].linkedTo).toBeUndefined();
  expect(current().past).toHaveLength(1);
  current().undo();
  expect(current().documents).toEqual(before);
  await workspace.persistence.flush();
});

it('an invalid linked Right proposal refuses paired admission before any workspace publication', async () => {
  let saved: unknown = null;
  const workspace = createWorkspaceStore({
    read: async () => saved,
    write: async (value) => {
      saved = structuredClone(value);
    },
    readLegacy: () => null,
  });
  await workspace.persistence.hydrate();
  const documents = { left: fixture(), right: fixture() };
  delete documents.right.hfdSelectedPreset;
  workspace.store.setState({ documents, past: [], future: [], gesture: undefined });
  const current = workspace.store.getState,
    before = structuredClone(current().documents),
    revision = current().documentRevision;
  expect(() =>
    (['left', 'right'] as const).map((slot) =>
      planNativeProjectOpen(current().documents[slot], slot, {
        presetIndex: 0,
        route: 'inner',
      }),
    ),
  ).toThrow(/original.*saved preset/i);
  expect(current().documents).toEqual(before);
  expect(current().documentRevision).toBe(revision);
  expect(current().past).toEqual([]);
});
