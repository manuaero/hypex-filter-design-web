import { expect, it, vi } from 'vitest';
import { createToolExecutor, TOOL_DEFINITIONS, type ToolAdapter } from '../src/application/tools';
import {
  NativeLimiterError,
  type NativeLimiterController,
  type NativeLimiterReview,
  type NativeLimiterResult,
  type NativeLimiterSnapshot,
} from '../src/application/native-limiter';
import { loadNativeLimiter, previewNativeLimiter } from '../src/hardware/native-limiter';
import { decodeLimiter } from '../src/hardware/device-settings';
import { SimulatedPanel } from '../src/hardware/simulator';
import { newProject } from '../src/domain/model';

const reviewId = '11111111-1111-4111-8111-111111111111';
const actor = { owner: 'workspace:22222222-2222-4222-8222-222222222222', scope: 'paired:limiter' };
function fixture() {
  const panel = new SimulatedPanel('SIMULATED-LIMITER'),
    draft = loadNativeLimiter(panel.deviceConfiguration, { bridged: false }),
    preview = previewNativeLimiter(draft),
    identity = { serial: panel.serial, product: 22, firmware: '5.7', core: '5.1' },
    { sourceHex: _source, ...publicDraft } = draft;
  const review: NativeLimiterReview = {
    id: reviewId,
    target: 'left',
    revision: 4,
    createdAt: 10,
    roles: [
      {
        slot: 'left',
        identity,
        expert: false,
        draft: publicDraft,
        before: decodeLimiter(panel.deviceConfiguration).channels,
        after: preview.channels,
      },
    ],
  };
  const result: NativeLimiterResult = {
    reviewId,
    target: 'left',
    complete: true,
    partial: false,
    roles: [
      {
        slot: 'left',
        identity,
        preflight: 'verified',
        lastConfirmedMuted: true,
        steps: [
          { id: 'mute', attempted: true, verified: true },
          { id: 'configuration', attempted: true, verified: true },
        ],
      },
    ],
  };
  const snapshot: NativeLimiterSnapshot = {
    phase: 'ready',
    busy: false,
    revision: 4,
    roles: {
      left: {
        connected: true,
        identity,
        expert: false,
        draft,
        preview: { channels: preview.channels },
      },
      right: { connected: false, expert: false },
    },
    activeReview: review,
    lastResult: result,
  };
  const controller: NativeLimiterController = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    status: vi.fn(() => snapshot),
    load: vi.fn(async () => snapshot),
    edit: vi.fn(() => snapshot),
    review: vi.fn(async () => review),
    apply: vi.fn(async () => result),
    discard: vi.fn(),
    refreshBindings: vi.fn(),
    dispose: vi.fn(),
  };
  const forbidden = vi.fn(() => {
      throw new Error('Use the shared native limiter controller');
    }),
    view = vi.fn(),
    documents = { left: newProject('Left'), right: newProject('Right') };
  const adapter: ToolAdapter = {
    state: () => ({
      documents,
      slot: 'right',
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
    nativeLimiter: controller,
  };
  return {
    execute: createToolExecutor(adapter),
    controller,
    forbidden,
    view,
    documents,
    snapshot,
    review,
    result,
  };
}

it('rejects packet/owner injection, implicit destinations, invalid native bounds and unconfirmed writes before the controller', async () => {
  const f = fixture();
  for (const input of [
    { action: 'load' },
    { action: 'load', target: 'selected' },
    { action: 'load', target: 'both', owner: actor.owner },
    { action: 'edit', target: 'left', expectedRevision: 4, edit: { type: 'bridge', value: true } },
    {
      action: 'edit',
      target: 'left',
      expectedRevision: 4,
      edit: { type: 'power', channel: 0, value: 100 },
    },
    {
      action: 'edit',
      target: 'left',
      expectedRevision: 4,
      edit: { type: 'power', channel: 1, value: 1001 },
    },
    {
      action: 'edit',
      target: 'left',
      expectedRevision: 4,
      edit: { type: 'impedance', channel: 1, value: 0.9 },
    },
    {
      action: 'edit',
      target: 'left',
      expectedRevision: 4,
      edit: { type: 'attack-time', value: 0.2 },
    },
    {
      action: 'edit',
      target: 'left',
      expectedRevision: 4,
      edit: { type: 'release-time', value: 100 },
    },
    { action: 'review', target: 'left' },
    { action: 'apply', reviewId },
    { action: 'apply', reviewId, confirm: false },
    { action: 'apply', reviewId, confirm: true, packets: [] },
  ])
    expect(await f.execute('fusion_limiter_editor', input, actor)).toMatchObject({ ok: false });
  expect(await f.execute('fusion_limiter_editor', { action: 'status' })).toMatchObject({
    ok: false,
    error: expect.stringContaining('trusted workspace'),
  });
  expect(f.controller.status).not.toHaveBeenCalled();
  expect(f.controller.edit).not.toHaveBeenCalled();
  expect(f.controller.load).not.toHaveBeenCalled();
  expect(f.controller.apply).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('returns cached public editor state without exporting source configuration or making device calls', async () => {
  const f = fixture(),
    result = await f.execute('fusion_limiter_editor', { action: 'status' }, actor);
  expect(result).toMatchObject({
    ok: true,
    limiter: { revision: 4, roles: { left: { draft: { channels: expect.any(Array) } } } },
  });
  expect(JSON.stringify(result)).not.toContain('sourceHex');
  expect(JSON.stringify(result)).not.toContain('request');
  expect(f.controller.status).toHaveBeenCalledExactlyOnceWith(actor);
  expect(f.controller.load).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('edits the shared UI draft with one-based channel conversion and exact explicit targets/revisions', async () => {
  const f = fixture(),
    before = structuredClone(f.documents);
  await f.execute('fusion_limiter_editor', { action: 'load', target: 'both' }, actor);
  expect(f.controller.load).toHaveBeenCalledExactlyOnceWith('both', actor);
  await f.execute(
    'fusion_limiter_editor',
    {
      action: 'edit',
      target: 'left',
      expectedRevision: 4,
      edit: { type: 'expert-text', channel: 3, field: 'release', text: '0.999950123' },
    },
    actor,
  );
  expect(f.controller.edit).toHaveBeenLastCalledWith('left', actor, {
    expectedRevision: 4,
    action: { type: 'expert-text', channel: 2, field: 'release', text: '0.999950123' },
  });
  await f.execute(
    'fusion_limiter_editor',
    {
      action: 'edit',
      target: 'both',
      expectedRevision: 5,
      edit: { type: 'expert-mode', value: true },
    },
    actor,
  );
  expect(f.controller.edit).toHaveBeenLastCalledWith('both', actor, {
    expectedRevision: 5,
    action: { type: 'expert-mode', value: true },
  });
  expect(f.view).toHaveBeenCalledWith({ tab: 'Device settings' });
  expect(f.documents).toEqual(before);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('forwards a fixed review and confirmation context rather than retargeting from current selection or linking', async () => {
  const f = fixture(),
    signal = new AbortController().signal,
    context = { ...actor, signal };
  expect(
    await f.execute(
      'fusion_limiter_editor',
      { action: 'review', target: 'left', expectedRevision: 4 },
      context,
    ),
  ).toEqual({ ok: true, review: f.review });
  expect(f.controller.review).toHaveBeenCalledExactlyOnceWith('left', context, {
    expectedRevision: 4,
  });
  expect(
    await f.execute('fusion_limiter_editor', { action: 'apply', reviewId, confirm: true }, context),
  ).toEqual({ ok: true, result: f.result });
  expect(f.controller.apply).toHaveBeenCalledExactlyOnceWith(reviewId, context, { confirm: true });
  await f.execute('fusion_limiter_editor', { action: 'discard-review', reviewId }, actor);
  expect(f.controller.discard).toHaveBeenCalledExactlyOnceWith(reviewId, actor);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('returns an exact partial ledger without silently retrying an unconfirmed configuration', async () => {
  const f = fixture(),
    partial = structuredClone(f.result);
  partial.complete = false;
  partial.partial = true;
  partial.roles[0].steps[1] = {
    id: 'configuration',
    attempted: true,
    verified: false,
    error: 'Reply lost',
  };
  vi.mocked(f.controller.apply).mockRejectedValueOnce(
    new NativeLimiterError('Configuration is unconfirmed', partial),
  );
  expect(
    await f.execute('fusion_limiter_editor', { action: 'apply', reviewId, confirm: true }, actor),
  ).toEqual({ ok: false, error: 'Configuration is unconfirmed', result: partial });
  expect(f.controller.apply).toHaveBeenCalledTimes(1);
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(
    TOOL_DEFINITIONS.find((tool) => tool.name === 'fusion_limiter_editor')?.description,
  ).toContain('same visible UI');
});

it('preserves a known partial ledger when cancellation arrives after the controller started a hardware operation', async () => {
  const f = fixture(),
    cancellation = new AbortController(),
    partial = structuredClone(f.result);
  partial.complete = false;
  partial.partial = true;
  partial.roles[0].steps[1].verified = false;
  vi.mocked(f.controller.apply).mockImplementationOnce(async () => {
    cancellation.abort();
    throw new NativeLimiterError('Readback was not confirmed', partial);
  });
  expect(
    await f.execute(
      'fusion_limiter_editor',
      { action: 'apply', reviewId, confirm: true },
      { ...actor, signal: cancellation.signal },
    ),
  ).toEqual({ ok: false, error: 'Readback was not confirmed', result: partial });
  expect(f.controller.apply).toHaveBeenCalledTimes(1);
  expect(f.forbidden).not.toHaveBeenCalled();
});
