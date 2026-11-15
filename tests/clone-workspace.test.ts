// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createCloneWorkspace } from '../src/application/clone-workspace';
import { nativeCloneFixture } from './fixtures/native-clone';
import { newProject, type Slot, type Project } from '../src/domain/model';
import { exportHfd } from '../src/domain/files';
import { replaceNativeCloneInfo } from '../src/domain/clone-template';

function fixture() {
  const left = newProject('Left'),
    right = structuredClone(left);
  right.name = 'Right';
  let state = { documents: { left, right }, documentRevision: 7 };
  const edit = vi.fn((slots: Slot[], change: (p: Project) => void) => {
    const documents = structuredClone(state.documents);
    slots.forEach((slot) => change(documents[slot]));
    state = { documents, documentRevision: state.documentRevision + 1 };
  });
  return { port: createCloneWorkspace({ state: () => state, edit }), edit, state: () => state };
}

it('replaces paired metadata atomically even when both projects share the same imported ID', () => {
  const f = fixture(),
    left = nativeCloneFixture(),
    right = nativeCloneFixture();
  right.settings.startupVolume = -38;
  const before = structuredClone(f.state());
  f.port.replaceTemplates(
    [
      { slot: 'right', template: right },
      { slot: 'left', template: left },
    ],
    7,
  );
  expect(f.edit).toHaveBeenCalledOnce();
  expect(f.edit.mock.calls[0][0]).toEqual(['right', 'left']);
  expect(f.state().documentRevision).toBe(8);
  expect(f.state().documents.right.hfdCloneTemplate?.settings.startupVolume).toBe(-38);
  expect(f.state().documents.left.hfdCloneTemplate?.settings.startupVolume).toBe(
    left.settings.startupVolume,
  );
  for (const slot of ['left', 'right'] as const) {
    const { hfdCloneTemplate: _template, ...project } = f.state().documents[slot];
    expect(project).toEqual(before.documents[slot]);
  }
  right.settings.startupVolume = -10;
  expect(f.state().documents.right.hfdCloneTemplate?.settings.startupVolume).toBe(-38);
});

it('rejects stale revisions, duplicate targets and a malformed second snapshot before either design changes', () => {
  const f = fixture(),
    before = structuredClone(f.state()),
    template = nativeCloneFixture();
  expect(() => f.port.replaceTemplates([{ slot: 'left', template }], 6)).toThrow('design changed');
  expect(() =>
    f.port.replaceTemplates(
      [
        { slot: 'left', template },
        { slot: 'left', template },
      ],
      7,
    ),
  ).toThrow('unique');
  expect(() =>
    f.port.replaceTemplates(
      [
        { slot: 'left', template },
        { slot: 'right', template: {} as never },
      ],
      7,
    ),
  ).toThrow();
  expect(f.edit).not.toHaveBeenCalled();
  expect(f.state()).toEqual(before);
});

it('provides a stable legacy XML projection without changing editable documents and tracks template changes separately', () => {
  const f = fixture(),
    project = f.state().documents.left;
  project.sourceXml = replaceNativeCloneInfo(exportHfd(project), nativeCloneFixture());
  const before = structuredClone(project),
    first = f.port.design('left');
  expect(first.project.hfdCloneTemplate?.configuration.valid).toBe(true);
  expect(f.port.design('left').project).toBe(first.project);
  expect(project).toEqual(before);
  const templateRevision = first.templateRevision;
  f.edit(['left'], (p) => {
    p.presets[0].channels[0].gain = -3;
  });
  expect(f.port.design('left').templateRevision).toBe(templateRevision);
  const replacement = nativeCloneFixture();
  replacement.settings.startupVolume = -41;
  f.port.replaceTemplates([{ slot: 'left', template: replacement }], 8);
  expect(f.port.design('left').templateRevision).toBe(templateRevision + 1);
});
