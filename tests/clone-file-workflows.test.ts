// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { ExportWorkflowSchema, prepareFileExport } from '../src/application/file-workflows';
import { newProject } from '../src/domain/model';
import { exportHfd } from '../src/domain/files';
import { parseNativeCloneInfo, replaceNativeCloneInfo } from '../src/domain/clone-template';
import { importProjectFolder } from '../src/domain/project-io';
import { nativeCloneFixture } from './fixtures/native-clone';

function snapshot() {
  const project = newProject('Clone file workflow');
  project.hfdCloneTemplate = nativeCloneFixture();
  project.sourceXml = replaceNativeCloneInfo(exportHfd(project), project.hfdCloneTemplate);
  project.presets[0].inputEq[0].gain = 9;
  project.presets[0].eqEnabled = true;
  return { documents: { left: project, right: newProject('Independent Right') } };
}

it('requires an explicit role for both Clone export workflows and rejects authority or hardware arguments', () => {
  for (const workflow of ['project-clone-hfd-xml', 'project-clone-folder']) {
    for (const parameters of [
      {},
      { slot: 'both' },
      { slot: 'left', confirm: true },
      { slot: 'left', owner: 'fake' },
      { slot: 'left', packets: [] },
    ])
      expect(ExportWorkflowSchema.safeParse({ workflow, parameters }).success).toBe(false);
    expect(
      ExportWorkflowSchema.safeParse({ workflow, parameters: { slot: 'right' } }).success,
    ).toBe(true);
  }
});

it('exports captured physical EQ through the bounded agent file path while ordinary XML keeps staged EQ', async () => {
  const state = snapshot(),
    before = structuredClone(state),
    clone = await prepareFileExport(
      { workflow: 'project-clone-hfd-xml', parameters: { slot: 'left' } },
      state,
    ),
    ordinary = await prepareFileExport(
      { workflow: 'project-hfd-xml', parameters: { slot: 'left' } },
      state,
    );
  expect(clone).toHaveLength(1);
  expect(clone[0].path).toBe('Clone file workflow-clone.xml');
  expect(clone[0].blob.type).toBe('application/xml');
  expect(parseNativeCloneInfo(await clone[0].blob.text())!.eqBanks[0][0].gain).toBe(-1);
  expect(parseNativeCloneInfo(await ordinary[0].blob.text())!.eqBanks[0][0].gain).toBe(9);
  expect(state).toEqual(before);
});

it('emits exact Clone folder bytes and bound lossless sidecar without adding a template to an unrelated role', async () => {
  const state = snapshot(),
    before = structuredClone(state),
    exported = await prepareFileExport(
      { workflow: 'project-clone-folder', parameters: { slot: 'left' } },
      state,
    ),
    files = await Promise.all(
      exported.map(async (file) => ({ path: file.path, content: await file.blob.text() })),
    ),
    native = parseNativeCloneInfo(files.find((file) => file.path === 'Config.xml')!.content)!,
    loaded = importProjectFolder(files);
  expect(native.eqBanks[0][0].gain).toBe(-1);
  expect(loaded.presets[0].inputEq[0].gain).toBe(9);
  expect(loaded.hfdCloneTemplate).toEqual(state.documents.left.hfdCloneTemplate);
  await expect(
    prepareFileExport({ workflow: 'project-clone-folder', parameters: { slot: 'right' } }, state),
  ).rejects.toThrow('no saved amplifier template');
  expect(state).toEqual(before);
});
