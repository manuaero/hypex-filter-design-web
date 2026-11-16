import { expect, it, vi } from 'vitest';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';
import {
  FirmwareExecutionError,
  type FirmwareExecutionWorkflow,
  type FirmwareExecutionSnapshot,
} from '../src/application/firmware-execution';
import { newProject } from '../src/domain/model';

const actor = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'manual:firmware' };
function fixture() {
  const state: FirmwareExecutionSnapshot = {
    files: { left: { phase: 'empty' }, right: { phase: 'empty' } },
    availability: {
      left: { available: false, reasons: ['Unqualified'] },
      right: { available: false, reasons: ['Unqualified'] },
    },
    update: {
      busy: false,
      phase: 'idle',
      records: [],
      availability: {
        left: {
          available: false,
          qualifier: 'unqualified-physical',
          route: 'physical',
          qualified: false,
          reasons: ['Unqualified'],
        },
        right: {
          available: false,
          qualifier: 'unqualified-physical',
          route: 'physical',
          qualified: false,
          reasons: ['Unqualified'],
        },
      },
    },
  };
  const workflow: FirmwareExecutionWorkflow = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    status: vi.fn((ctx) => {
      if (ctx.owner !== actor.owner) throw new Error('Foreign workspace');
      return state;
    }),
    inspect: vi.fn(),
    clear: vi.fn(),
    review: vi.fn(),
    reviewRecovery: vi.fn(),
    apply: vi.fn(),
    discard: vi.fn(),
    hydrate: vi.fn(async () => {}),
    history: vi.fn(() => ({ records: [], total: 0, nextOffset: null })),
    exportRecord: vi.fn(),
    exportPage: vi.fn(() => ({
      id: 'journal',
      content: '{"bounded":true}',
      total: 16,
      nextOffset: null,
      exportPersistence: 'unavailable' as const,
    })),
    refreshContext: vi.fn(),
    dispose: vi.fn(),
  };
  const forbidden = vi.fn(() => {
    throw new Error('Unexpected ordinary hardware/design action');
  });
  const adapter: ToolAdapter = {
    state: () => ({
      documents: { left: newProject(), right: newProject() },
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
    progress: forbidden,
    message: vi.fn(),
    view: vi.fn(),
    firmwareExecution: workflow,
  };
  return { workflow, state, forbidden, execute: createToolExecutor(adapter) };
}
it('strictly scopes firmware execution actions and refuses manufactured qualification, packets, missing confirmation and unrelated fields', async () => {
  const f = fixture();
  for (const firmware of [
    { action: 'update-apply', reviewId: 'r' },
    { action: 'update-review' },
    { action: 'update-status', confirm: true },
    { action: 'update-review', stageIds: { left: 'l' }, qualifier: 'qualified-physical' },
    { action: 'update-review', stageIds: { left: 'l' }, expectedAfter: { core: '5.5' } },
    { action: 'update-export', recordId: 'r', limit: 16385 },
    { action: 'update-history', limit: 17 },
    { action: 'update-apply', reviewId: 'r', confirm: true, packetHex: '4000' },
    { action: 'update-review', stageIds: { left: 'l', extra: 'x' } },
  ])
    expect(
      await f.execute('fusion_device_read', { target: 'left', firmware }, actor),
    ).toMatchObject({ ok: false });
  expect(f.workflow.status).not.toHaveBeenCalled();
  expect(f.workflow.apply).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('requires trusted owner and passes fixed Both stage IDs plus original signal to the same workflow', async () => {
  const f = fixture();
  expect(
    await f.execute('fusion_device_read', {
      target: 'both',
      firmware: { action: 'update-status' },
    }),
  ).toMatchObject({ ok: false, error: expect.stringContaining('trusted') });
  expect(
    await f.execute(
      'fusion_device_read',
      { target: 'left', firmware: { action: 'update-status' } },
      { ...actor, owner: 'foreign' },
    ),
  ).toMatchObject({ ok: false, error: 'Foreign workspace' });
  const abort = new AbortController();
  expect(
    await f.execute(
      'fusion_device_read',
      {
        target: 'both',
        firmware: {
          action: 'update-review',
          stageIds: { left: 'left-exact', right: 'right-exact' },
        },
      },
      { ...actor, signal: abort.signal },
    ),
  ).toMatchObject({ ok: true });
  expect(f.workflow.review).toHaveBeenCalledExactlyOnceWith(
    'both',
    { left: 'left-exact', right: 'right-exact' },
    { ...actor, signal: abort.signal },
  );
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('delegates status/history, discard and explicit recovery without staging or an ordinary connection', async () => {
  const f = fixture();
  for (const firmware of [
    { action: 'update-status' },
    { action: 'update-history', offset: 0, limit: 16 },
    { action: 'update-discard', reviewId: 'review' },
    { action: 'update-review-recovery', recordId: 'partial' },
  ])
    expect(
      await f.execute('fusion_device_read', { target: 'right', firmware }, actor),
    ).toMatchObject({ ok: true });
  expect(f.workflow.hydrate).toHaveBeenCalledExactlyOnceWith(actor);
  expect(f.workflow.history).toHaveBeenCalledExactlyOnceWith(actor, 0, 16);
  expect(f.workflow.discard).toHaveBeenCalledExactlyOnceWith('review', actor);
  expect(f.workflow.reviewRecovery).toHaveBeenCalledExactlyOnceWith('partial', 'right', actor);
  expect(f.workflow.inspect).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('delivers bounded exact export pages with persistence, never raw source/images in the ordinary response', async () => {
  const f = fixture();
  const result = await f.execute(
    'fusion_device_read',
    {
      target: 'both',
      firmware: { action: 'update-export', recordId: 'journal', offset: 20, limit: 100 },
    },
    actor,
  );
  expect(result).toMatchObject({
    ok: true,
    export: { content: '{"bounded":true}', exportPersistence: 'unavailable' as const },
  });
  expect(f.workflow.exportPage).toHaveBeenCalledExactlyOnceWith('journal', actor, 20, 100);
  expect(f.workflow.exportRecord).not.toHaveBeenCalled();
});
it('retains a consumed partial result even when cancellation arrives after hardware start, and refuses a mismatched declared target', async () => {
  const f = fixture(),
    abort = new AbortController();
  f.state.update = {
    ...f.state.update,
    activeReview: { id: 'fixed', target: 'right', qualifier: 'qualified-physical', roles: [] },
  };
  expect(
    await f.execute(
      'fusion_device_read',
      { target: 'left', firmware: { action: 'update-apply', reviewId: 'fixed', confirm: true } },
      actor,
    ),
  ).toMatchObject({ ok: false, error: expect.stringContaining('fixed review') });
  expect(f.workflow.apply).not.toHaveBeenCalled();
  vi.mocked(f.workflow.apply).mockImplementation(async () => {
    abort.abort();
    throw new FirmwareExecutionError(
      'Entry unconfirmed',
      { id: 'fixed', phase: 'partial' } as never,
      'unavailable',
    );
  });
  expect(
    await f.execute(
      'fusion_device_read',
      { target: 'right', firmware: { action: 'update-apply', reviewId: 'fixed', confirm: true } },
      { ...actor, signal: abort.signal },
    ),
  ).toMatchObject({
    ok: false,
    error: 'Entry unconfirmed',
    result: { id: 'fixed', phase: 'partial' },
    persistence: 'unavailable',
  });
  expect(f.workflow.apply).toHaveBeenCalledOnce();
});
