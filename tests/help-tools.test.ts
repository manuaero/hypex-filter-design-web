import { expect, it, vi } from 'vitest';
import { createToolExecutor, TOOL_DEFINITIONS, type ToolAdapter } from '../src/application/tools';
import { HELP_RESOURCES } from '../src/application/help-resources';
import { newProject } from '../src/domain/model';

function fixture() {
  const documents = { left: newProject('Help left'), right: newProject('Help right') },
    forbidden = vi.fn(() => {
      throw new Error('Help cannot edit, operate devices or request permissions');
    }),
    view = vi.fn();
  const adapter: ToolAdapter = {
    state: () => ({
      documents,
      slot: 'left',
      preset: 0,
      channel: 0,
      filter: 0,
      linkedEdits: false,
      linkedControls: false,
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
    view,
  };
  return { execute: createToolExecutor(adapter), documents, view, forbidden };
}

it('returns the identical immutable bounded registry by default without navigating, editing or device operations', async () => {
  const f = fixture(),
    before = structuredClone(f.documents),
    result = (await f.execute('fusion_help', {})) as { ok: true; resources: typeof HELP_RESOURCES };
  expect(result.ok).toBe(true);
  expect(result.resources).toBe(HELP_RESOURCES);
  expect(Object.isFrozen(result.resources)).toBe(true);
  expect(Object.isFrozen(result.resources.manual)).toBe(true);
  expect(Object.isFrozen(result.resources.vendors)).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(8192);
  expect(f.documents).toEqual(before);
  expect(f.view).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('stages Help or the retained Verification page without opening links', async () => {
  const f = fixture();
  expect(await f.execute('fusion_help', { action: 'show' })).toMatchObject({
    ok: true,
    view: 'Help',
    resources: HELP_RESOURCES,
  });
  expect(f.view).toHaveBeenNthCalledWith(1, { tab: 'Help' });
  expect(await f.execute('fusion_help', { action: 'show', view: 'verification' })).toMatchObject({
    ok: true,
    view: 'Verification',
  });
  expect(f.view).toHaveBeenNthCalledWith(2, { tab: 'Verification' });
  expect(await f.execute('fusion_view', { tab: 'Help' })).toEqual({ ok: true });
  expect(f.view).toHaveBeenNthCalledWith(3, { tab: 'Help' });
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('rejects arbitrary URLs, target actors and conflicting navigation before any action', async () => {
  const f = fixture();
  for (const input of [
    { action: 'resources', view: 'help' },
    { action: 'show', view: 'https://example.test/' },
    { action: 'show', url: 'https://example.test/' },
    { action: 'download' },
    { action: 'resources', owner: 'workspace:forged' },
    { action: 'show', target: 'both' },
  ])
    expect(await f.execute('fusion_help', input)).toMatchObject({ ok: false });
  expect(f.view).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('publishes defaultable input fields and honors cancellation before staging a view', async () => {
  const schema = TOOL_DEFINITIONS.find((tool) => tool.name === 'fusion_help')!.inputSchema;
  expect(schema.type).toBe('object');
  expect(schema.additionalProperties).toBe(false);
  expect(schema.required ?? []).not.toContain('action');
  const f = fixture(),
    controller = new AbortController();
  controller.abort();
  await expect(
    f.execute('fusion_help', { action: 'show' }, controller.signal),
  ).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(f.view).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});
