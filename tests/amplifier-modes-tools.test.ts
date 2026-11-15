import { expect, it, vi } from 'vitest';
import { createToolExecutor, TOOL_DEFINITIONS, type ToolAdapter } from '../src/application/tools';
import {
  AmplifierModesError,
  type AmplifierModesController,
  type AmplifierModesSnapshot,
  type AmplifierModesResult,
} from '../src/application/amplifier-modes';
import { newProject } from '../src/domain/model';
const actor = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'manual:modes' },
  id = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const snapshot: AmplifierModesSnapshot = {
    phase: 'ready',
    busy: false,
    revision: 3,
    roles: { left: { connected: false }, right: { connected: false } },
  };
  const result: AmplifierModesResult = {
    reviewId: id,
    target: 'both',
    complete: false,
    partial: true,
    roles: [],
    error: 'Unconfirmed response',
  };
  const controller: AmplifierModesController = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    status: vi.fn(() => snapshot),
    load: vi.fn(async () => snapshot),
    edit: vi.fn(() => snapshot),
    cancel: vi.fn(),
    review: vi.fn(async () => ({
      id,
      target: 'both' as const,
      revision: 3,
      createdAt: 1,
      roles: [],
    })),
    apply: vi.fn(async () => result),
    discard: vi.fn(),
    refreshBindings: vi.fn(),
    dispose: vi.fn(),
  };
  const forbidden = vi.fn(() => {
      throw new Error('Use the shared configuration controller');
    }),
    view = vi.fn();
  const adapter: ToolAdapter = {
    state: () => ({
      documents: { left: newProject(), right: newProject() },
      slot: 'left',
      preset: 0,
      channel: 0,
      filter: 0,
      linkedEdits: true,
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
    progress: forbidden,
    message: vi.fn(),
    view,
    amplifierModes: controller,
  };
  return { controller, snapshot, result, forbidden, view, execute: createToolExecutor(adapter) };
}
it('rejects missing roles, unknown fields, raw packets, injected authority and unconfirmed writes before the controller', async () => {
  const f = fixture();
  for (const input of [
    { action: 'edit', patch: { master: false }, expectedRevision: 3 },
    { action: 'edit', target: 'both', expectedRevision: 3, patch: {} },
    { action: 'edit', target: 'left', expectedRevision: 3, patch: { volume: 12 } },
    {
      action: 'edit',
      target: 'left',
      expectedRevision: 3,
      patch: { softClip: false },
      owner: actor.owner,
    },
    { action: 'apply', reviewId: id },
    { action: 'apply', reviewId: id, confirm: true, packetHex: '05' },
  ])
    expect(await f.execute('fusion_amplifier_modes', input, actor)).toMatchObject({ ok: false });
  expect(f.controller.edit).not.toHaveBeenCalled();
  expect(f.controller.apply).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('requires trusted context and cached status never accesses the hardware adapter', async () => {
  const f = fixture();
  expect(await f.execute('fusion_amplifier_modes', { action: 'status' })).toMatchObject({
    ok: false,
    error: expect.stringContaining('trusted'),
  });
  expect(await f.execute('fusion_amplifier_modes', { action: 'status' }, actor)).toMatchObject({
    ok: true,
    configuration: { revision: 3 },
  });
  expect(f.controller.status).toHaveBeenCalledExactlyOnceWith(actor);
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(
    TOOL_DEFINITIONS.find((t) => t.name === 'fusion_amplifier_modes')?.annotations.readOnlyHint,
  ).toBe(false);
});
it('uses the same UI drafts and exact independent targets and revisions', async () => {
  const f = fixture();
  await f.execute(
    'fusion_amplifier_modes',
    {
      action: 'edit',
      target: 'right',
      expectedRevision: 3,
      patch: { master: false, softClip: false },
    },
    actor,
  );
  expect(f.controller.edit).toHaveBeenCalledExactlyOnceWith('right', actor, {
    expectedRevision: 3,
    patch: { master: false, softClip: false },
  });
  await f.execute(
    'fusion_amplifier_modes',
    { action: 'review', target: 'both', expectedRevision: 4 },
    actor,
  );
  expect(f.controller.review).toHaveBeenCalledExactlyOnceWith('both', actor, {
    expectedRevision: 4,
  });
  expect(f.view).toHaveBeenCalledWith({ tab: 'Device settings' });
  await f.execute('fusion_amplifier_modes', { action: 'cancel', target: 'both' }, actor);
  expect(f.controller.cancel).toHaveBeenCalledExactlyOnceWith('both', actor);
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('retains consumed partial outcomes when cancellation arrives after a setter', async () => {
  const f = fixture(),
    abort = new AbortController();
  vi.mocked(f.controller.apply).mockImplementationOnce(async () => {
    abort.abort();
    throw new AmplifierModesError('Unconfirmed response', f.result);
  });
  expect(
    await f.execute(
      'fusion_amplifier_modes',
      { action: 'apply', reviewId: id, confirm: true },
      { ...actor, signal: abort.signal },
    ),
  ).toEqual({ ok: false, error: 'Unconfirmed response', result: f.result });
  expect(f.controller.apply).toHaveBeenCalledOnce();
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('returns the completed result directly instead of checking an aborted status again', async () => {
  const f = fixture(),
    abort = new AbortController();
  f.result.complete = true;
  f.result.partial = false;
  vi.mocked(f.controller.apply).mockImplementationOnce(async () => {
    abort.abort();
    return f.result;
  });
  expect(
    await f.execute(
      'fusion_amplifier_modes',
      { action: 'apply', reviewId: id, confirm: true },
      { ...actor, signal: abort.signal },
    ),
  ).toEqual({ ok: true, result: f.result });
  expect(f.controller.status).not.toHaveBeenCalled();
});
