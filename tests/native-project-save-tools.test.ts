// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { createNativeProjectSaveController } from '../src/application/native-project-save';
import { createToolExecutor, TOOL_DEFINITIONS, type ToolAdapter } from '../src/application/tools';
import { newProject } from '../src/domain/model';

beforeAll(() => vi.stubGlobal('Blob', NodeBlob));
afterAll(() => vi.unstubAllGlobals());
const actor = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'manual:save' };
function fixture() {
  const documents = { left: newProject('Left Save'), right: newProject('Right Save') };
  const binding = vi.fn(() => undefined);
  let sequence = 0;
  const saves = createNativeProjectSaveController({
    state: () => ({ documents, documentRevision: 3 }),
    binding,
    id: () => `save-${++sequence}`,
  });
  const forbidden = vi.fn(() => {
    throw Error('No generic hardware, document or selection operation is allowed');
  });
  const createExport = vi.fn(async () => ({ id: 'export-1', files: [] }));
  const adapter: ToolAdapter = {
    state: () => ({
      documents,
      documentRevision: 3,
      slot: 'left',
      preset: 0,
      channel: 0,
      filter: 0,
      linkedEdits: false,
      linkedControls: true,
    }),
    edit: forbidden,
    choose: forbidden,
    undo: forbidden,
    redo: forbidden,
    connections: forbidden,
    connect: forbidden,
    disconnect: forbidden,
    refresh: forbidden,
    operate: forbidden,
    message: vi.fn(),
    progress: forbidden,
    view: forbidden,
    nativeProjectSave: saves,
    files: { manager: { createExport }, revision: () => 3 } as unknown as NonNullable<
      ToolAdapter['files']
    >,
  };
  return {
    saves,
    binding,
    forbidden,
    createExport,
    execute: createToolExecutor(adapter),
    documents,
  };
}

it('requires trusted context and strict stage, resolve and release arguments before accessing capture state', async () => {
  const f = fixture();
  expect(await f.execute('fusion_project_save', { action: 'status' })).toMatchObject({
    ok: false,
    error: expect.stringContaining('trusted'),
  });
  for (const input of [
    { action: 'stage', target: 'left' },
    { action: 'stage', target: 'both', expectedRevision: 3, mode: 'connected' },
    { action: 'stage', target: 'left', expectedRevision: 3, owner: actor.owner },
    { action: 'resolve', id: 'capture', packet: '05' },
    { action: 'release' },
  ])
    expect(await f.execute('fusion_project_save', input, actor)).toMatchObject({ ok: false });
  expect(f.binding).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('shares fixed Both artifacts across UI and MCP scopes with bounded summaries and no design mutation', async () => {
  const f = fixture(),
    before = structuredClone(f.documents);
  const staged = (await f.execute(
    'fusion_project_save',
    { action: 'stage', target: 'both', expectedRevision: 3 },
    actor,
  )) as { capture: { id: string } };
  const id = staged.capture.id;
  expect(f.saves.getSnapshot().captures[0]).toMatchObject({
    id,
    mode: 'auto',
    target: 'both',
    phase: 'staged',
  });
  const result = await f.execute(
    'fusion_project_save',
    { action: 'resolve', id },
    { ...actor, scope: 'ui:shared' },
  );
  expect(result).toMatchObject({
    ok: true,
    id,
    expectedRevision: 3,
    roles: [
      { slot: 'left', fileCount: 2 },
      { slot: 'right', fileCount: 2 },
    ],
  });
  expect(JSON.stringify(result)).not.toContain('content');
  expect(JSON.stringify(result)).not.toContain('filters');
  expect(f.documents).toEqual(before);
  expect(f.forbidden).not.toHaveBeenCalled();
  const calls = f.binding.mock.calls.length;
  await f.execute('fusion_project_save', { action: 'resolve', id }, actor);
  expect(f.binding).toHaveBeenCalledTimes(calls);
  expect(
    TOOL_DEFINITIONS.find((t) => t.name === 'fusion_project_save')?.annotations.readOnlyHint,
  ).toBe(false);
});

it('keeps artifact ownership and exposes exact resolved bytes through the existing chunked export path', async () => {
  const f = fixture();
  const capture = f.saves.stage({ target: 'left', expectedRevision: 3, mode: 'design' }, actor);
  expect(
    await f.execute(
      'fusion_project_save',
      { action: 'resolve', id: capture.id },
      { owner: 'workspace:22222222-2222-4222-8222-222222222222', scope: 'manual:other' },
    ),
  ).toMatchObject({ ok: false });
  expect(
    await f.execute(
      'fusion_file_export',
      {
        operation: {
          workflow: 'native-project-save',
          parameters: { id: capture.id, slot: 'left', format: 'json' },
        },
      },
      actor,
    ),
  ).toMatchObject({ ok: true, transfer: { id: 'export-1' } });
  const call = f.createExport.mock.calls[0] as unknown as [
    unknown,
    { path: string; blob: Blob }[],
    unknown,
  ];
  expect(call[0]).toEqual(actor);
  expect(JSON.parse(await call[1][0].blob.text())).toEqual(f.documents.left);
  expect(call[2]).toMatchObject({
    workflow: 'native-project-save',
    parameters: { id: capture.id, slot: 'left', format: 'json' },
  });
  expect(f.binding).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
  await f.execute('fusion_project_save', { action: 'release', id: capture.id }, actor);
  expect(
    await f.execute('fusion_project_save', { action: 'resolve', id: capture.id }, actor),
  ).toMatchObject({ ok: false });
});

it('rejects a mismatched export role before resolving or reading the originally staged amplifier', async () => {
  const f = fixture(),
    capture = f.saves.stage({ target: 'left', expectedRevision: 3, mode: 'auto' }, actor),
    resolve = vi.spyOn(f.saves, 'resolve');
  expect(
    await f.execute(
      'fusion_file_export',
      {
        operation: {
          workflow: 'native-project-save',
          parameters: { id: capture.id, slot: 'right', format: 'folder' },
        },
      },
      actor,
    ),
  ).toMatchObject({ ok: false, error: expect.stringContaining('role') });
  expect(resolve).not.toHaveBeenCalled();
  expect(f.createExport).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});
