// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AmplifierConfiguration, {
  type AmplifierConfigurationProps,
} from '../src/components/AmplifierConfiguration';
import {
  AmplifierModesError,
  type AmplifierModesController,
  type AmplifierModesSnapshot,
  type AmplifierModesTarget,
  type AmplifierModesReview,
  type AmplifierModesResult,
} from '../src/application/amplifier-modes';
import {
  amplifierModesSummary,
  planAmplifierModes,
  type AmplifierModes,
  type AmplifierModesPatch,
  type AmplifierModesSummary,
} from '../src/hardware/amplifier-modes';
import { decodeStatus } from '../src/hardware/codec';
import type { ToolExecutionContext } from '../src/application/execution-context';
import type { Slot } from '../src/domain/model';

const ui = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'ui:configuration' },
  agent = { ...ui, scope: 'site:configuration' },
  foreign = { owner: 'workspace:22222222-2222-4222-8222-222222222222', scope: 'ui:other' };
const identity = (slot: Slot) => ({
  serial: `SYNTHETIC-${slot}`,
  product: 22,
  core: '5.1',
  firmware: '5.7',
});
const roles = (target: AmplifierModesTarget): Slot[] =>
  target === 'both' ? ['left', 'right'] : [target];
const freeze = <T,>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const toModes = ({ master, bridge, softClip }: AmplifierModes): AmplifierModes => ({
  master,
  bridge,
  softClip,
});
const difference = (before: AmplifierModes, draft: AmplifierModes): AmplifierModesPatch =>
  Object.fromEntries(
    (['master', 'bridge', 'softClip'] as const)
      .filter((key) => before[key] !== draft[key])
      .map((key) => [key, draft[key]]),
  );
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
let host: HTMLDivElement,
  root: Root,
  unmounted = false;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  unmounted = false;
});
afterEach(async () => {
  if (!unmounted) await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
const toggle = (label: string) =>
  host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((element) => element.textContent === label)!;
const target = async (value: string) =>
  act(async () => {
    const field = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Configuration target"]',
    )!;
    field.value = value;
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });

/** Public-controller boundary fixture. Its only native dependency is the pure
 * status/plan math; no PanelSession, media, USB or real device backend exists. */
function fixture() {
  const listeners = new Set<() => void>(),
    raw: Record<Slot, Uint8Array> = { left: new Uint8Array(64), right: new Uint8Array(64) };
  for (const slot of ['left', 'right'] as const) {
    raw[slot][0] = 5;
    raw[slot][2] = 1;
    raw[slot][9] = slot === 'left' ? 0x19 : 0x1d;
    raw[slot][7] = 1;
    raw[slot].set([0xa1, 0xa2, 0xa3], 12);
    new DataView(raw[slot].buffer).setInt16(21, -4000, true);
  }
  const initial = (slot: Slot) => {
    const current = amplifierModesSummary(decodeStatus(raw[slot]));
    return {
      connected: true,
      identity: identity(slot),
      current,
      draft: toModes(current),
      preview: current,
      allowed: { master: true, bridge: true, softClip: true },
      changed: false,
    };
  };
  let state: Readonly<AmplifierModesSnapshot> = freeze({
      phase: 'ready',
      busy: false,
      revision: 2,
      roles: { left: initial('left'), right: initial('right') },
    }),
    reviewNumber = 0,
    reviewWait: Promise<void> | undefined,
    applyWait: Promise<void> | undefined,
    applyFailure: AmplifierModesResult | undefined;
  const publish = (patch: Partial<AmplifierModesSnapshot>) => {
    state = freeze({ ...state, ...structuredClone(patch) });
    listeners.forEach((listener) => listener());
  };
  const actor = (context: ToolExecutionContext) => {
    if (context.owner !== ui.owner)
      throw new Error('Configuration drafts belong to another workspace');
  };
  const controller: AmplifierModesController = {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status: vi.fn((context) => {
      actor(context);
      return state;
    }),
    refreshBindings: vi.fn(),
    dispose: vi.fn(),
    load: vi.fn(async (_target, context) => {
      actor(context);
      return state;
    }),
    edit: vi.fn((selected, context, input) => {
      actor(context);
      if (input.expectedRevision !== state.revision) throw new Error('Stale revision');
      const next = structuredClone(state.roles);
      for (const slot of roles(selected)) {
        const row = next[slot];
        row.draft = { ...row.draft!, ...input.patch };
        const patch = difference(row.current!, row.draft!);
        row.changed = Object.keys(patch).length > 0;
        row.preview = row.changed
          ? planAmplifierModes(decodeStatus(raw[slot]), patch, 9).summary
          : row.current;
      }
      publish({
        roles: next,
        revision: state.revision + 1,
        activeReview: undefined,
        lastResult: undefined,
      });
      return state;
    }),
    cancel: vi.fn((selected, context) => {
      actor(context);
      const next = structuredClone(state.roles);
      for (const slot of roles(selected)) {
        next[slot].draft = toModes(next[slot].current!);
        next[slot].preview = next[slot].current;
        next[slot].changed = false;
      }
      publish({
        roles: next,
        revision: state.revision + 1,
        activeReview: undefined,
        error: undefined,
      });
    }),
    discard: vi.fn((id, context) => {
      actor(context);
      if (state.activeReview?.id !== id) throw new Error('Stale review');
      publish({ activeReview: undefined });
    }),
    review: vi.fn(async (selected, context, input) => {
      actor(context);
      if (input.expectedRevision !== state.revision) throw new Error('Stale revision');
      const captured: AmplifierModesReview = freeze({
        id: `00000000-0000-4000-8000-${String(++reviewNumber).padStart(12, '0')}`,
        target: selected,
        revision: state.revision,
        createdAt: 100,
        roles: roles(selected).map((slot) => ({
          slot,
          identity: state.roles[slot].identity!,
          patch: difference(state.roles[slot].current!, state.roles[slot].draft!),
          before: state.roles[slot].current!,
          after: state.roles[slot].preview!,
        })),
      });
      if (reviewWait) await reviewWait;
      publish({ activeReview: captured });
      return captured;
    }),
    apply: vi.fn(async (id, context, confirmation) => {
      actor(context);
      if (confirmation.confirm !== true || state.activeReview?.id !== id)
        throw new Error('Stale review');
      const captured = state.activeReview!;
      publish({ busy: true, phase: 'busy', activeReview: undefined });
      if (applyWait) await applyWait;
      const result: AmplifierModesResult = applyFailure ?? {
        reviewId: id,
        target: captured.target,
        complete: true,
        partial: false,
        roles: captured.roles.map((row) => ({
          ...row,
          state: Object.keys(row.patch).length ? 'verified' : 'unchanged',
          attempted: Object.keys(row.patch).length > 0,
          planned: row.after,
          confirmed: row.after,
        })),
      };
      if (!applyFailure) {
        const next = structuredClone(state.roles);
        for (const row of captured.roles) {
          next[row.slot].current = row.after;
          next[row.slot].draft = toModes(row.after);
          next[row.slot].preview = row.after;
          next[row.slot].changed = false;
        }
        publish({ roles: next });
      }
      publish({
        busy: false,
        phase: result.complete ? 'ready' : 'error',
        lastResult: result,
        error: result.error,
      });
      if (!result.complete) throw new AmplifierModesError(result.error ?? 'Unconfirmed', result);
      return result;
    }),
  };
  return {
    controller,
    get state() {
      return state;
    },
    publish,
    waitForReview: (value: Promise<void>) => {
      reviewWait = value;
    },
    waitForApply: (value: Promise<void>) => {
      applyWait = value;
    },
    failApply: (result: AmplifierModesResult) => {
      applyFailure = result;
    },
  };
}
async function render(
  f: ReturnType<typeof fixture>,
  props: Partial<AmplifierConfigurationProps> = {},
) {
  await act(async () =>
    root.render(
      <AmplifierConfiguration
        controller={f.controller}
        slot="left"
        connectedRoles={['left', 'right']}
        getContext={() => ui}
        {...props}
      />,
    ),
  );
}

it('seeds from cached status, edits immediately without reads/writes, and previews native Slave dependencies', async () => {
  const f = fixture();
  await render(f);
  expect(f.controller.refreshBindings).toHaveBeenCalledOnce();
  expect(f.controller.load).not.toHaveBeenCalled();
  expect(button('Apply configuration').disabled).toBe(true);
  await act(async () => toggle('Left Master unit').click());
  expect(f.controller.edit).toHaveBeenCalledExactlyOnceWith('left', ui, {
    expectedRevision: 2,
    patch: { master: false },
  });
  expect(f.state.roles.left.current!.master).toBe(true);
  expect(f.state.roles.left.draft!.master).toBe(false);
  const preview = host.querySelector('table[aria-label="Left planned configuration changes"]')!;
  expect(preview.textContent).toContain('Wake on mainsOnOff');
  expect(preview.textContent).toContain('Fixed startup volume-40 dBDisabled');
  expect(host.textContent).toContain('Slave mode clears');
  expect(f.controller.review).not.toHaveBeenCalled();
  expect(f.controller.apply).not.toHaveBeenCalled();
  expect(f.controller.load).not.toHaveBeenCalled();
  await act(async () => button('Cancel changes').click());
  expect(f.controller.cancel).toHaveBeenCalledExactlyOnceWith('left', ui);
  expect(toggle('Left Master unit').checked).toBe(true);
});

it('keeps independent Both drafts, native Master lock preview and all warnings adjacent to Apply', async () => {
  const f = fixture();
  await render(f);
  await target('both');
  await act(async () => toggle('Left Bridged CH1 + CH2').click());
  await act(async () => toggle('Right Master unit').click());
  await act(async () => toggle('Right Soft clip enabled').click());
  expect(f.state.roles.left.draft).toEqual({ master: true, bridge: true, softClip: true });
  expect(f.state.roles.right.draft).toEqual({ master: true, bridge: false, softClip: false });
  expect(host.textContent).toContain('Master mode clears source and volume locks');
  expect(host.textContent).toContain('matching output wiring');
  expect(host.textContent).toContain('Disabling soft clip removes');
  expect(
    host.querySelector('table[aria-label="Right planned configuration changes"]')?.textContent,
  ).toContain('Preset source locks');
  expect(f.controller.apply).not.toHaveBeenCalled();
  await act(async () => button('Cancel changes').click());
  expect(f.controller.cancel).toHaveBeenCalledExactlyOnceWith('both', ui);
  expect(f.controller.load).not.toHaveBeenCalled();
});

it('applies once with one changed and one unchanged role, with no extra confirmation or Run field', async () => {
  const f = fixture();
  await render(f);
  await target('both');
  await act(async () => toggle('Left Soft clip enabled').click());
  expect(button('Apply configuration').disabled).toBe(false);
  expect(host.querySelector('input:not([type="checkbox"])')).toBeNull();
  await act(async () => button('Apply configuration').click());
  expect(f.controller.review).toHaveBeenCalledExactlyOnceWith('both', ui, { expectedRevision: 3 });
  expect(f.controller.apply).toHaveBeenCalledExactlyOnceWith(
    '00000000-0000-4000-8000-000000000001',
    ui,
    { confirm: true },
  );
  const outcome = host.querySelector('section[aria-label="Configuration outcome"]')!;
  expect(outcome.textContent).toContain('Left · SYNTHETIC-left');
  expect(outcome.textContent).toContain('Right · SYNTHETIC-right');
  expect(outcome.textContent).toContain('Unchanged');
  expect(f.controller.load).not.toHaveBeenCalled();
});

it('reflects MCP drafts/review and consumes the exact existing shared review from the current UI actor', async () => {
  const f = fixture();
  let actor = ui;
  await render(f, { getContext: () => actor });
  await act(async () => {
    f.controller.edit('right', agent, { expectedRevision: 2, patch: { master: true } });
    await f.controller.review('right', agent, { expectedRevision: 3 });
  });
  expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe('right');
  expect(toggle('Right Master unit').checked).toBe(true);
  actor = { ...ui, scope: 'ui:current' };
  await render(f, { getContext: () => actor });
  await act(async () => button('Apply configuration').click());
  expect(f.controller.review).toHaveBeenCalledOnce();
  expect(f.controller.apply).toHaveBeenCalledExactlyOnceWith(
    '00000000-0000-4000-8000-000000000001',
    actor,
    { confirm: true },
  );
  expect(host.textContent).toContain('Configuration verified');
});

it('coalesces duplicate clicks and never applies a delayed review after selecting another role', async () => {
  const f = fixture(),
    wait = deferred<void>();
  f.waitForReview(wait.promise);
  await render(f);
  await act(async () => toggle('Left Soft clip enabled').click());
  await act(async () => {
    const apply = button('Apply configuration');
    apply.click();
    apply.click();
  });
  expect(f.controller.review).toHaveBeenCalledOnce();
  await render(f, { slot: 'right' });
  await act(async () => wait.resolve());
  expect(f.controller.apply).not.toHaveBeenCalled();
});

it('does not auto-apply a late review after unmount', async () => {
  const f = fixture(),
    wait = deferred<void>();
  f.waitForReview(wait.promise);
  await render(f);
  await act(async () => toggle('Left Soft clip enabled').click());
  await act(async () => button('Apply configuration').click());
  await act(async () => root.unmount());
  unmounted = true;
  await act(async () => wait.resolve());
  expect(f.controller.apply).not.toHaveBeenCalled();
});

it('uses shared cancellation for an agent review and disables all mutations for a foreign owner', async () => {
  const f = fixture();
  await render(f);
  await act(async () => {
    f.controller.edit('left', agent, { expectedRevision: 2, patch: { softClip: false } });
    await f.controller.review('left', agent, { expectedRevision: 3 });
  });
  await act(async () => button('Cancel reviewed changes').click());
  expect(f.controller.discard).toHaveBeenCalledExactlyOnceWith(
    '00000000-0000-4000-8000-000000000001',
    ui,
  );
  expect(f.controller.cancel).toHaveBeenCalledExactlyOnceWith('left', ui);
  await render(f, { getContext: () => foreign });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('another workspace');
  expect(host.querySelector('input')).toBeNull();
  expect(f.controller.apply).not.toHaveBeenCalled();
});

it('hides historical outcomes on mount or context change and rejects a result for an old serial', async () => {
  const f = fixture();
  const result: AmplifierModesResult = {
    reviewId: 'old',
    target: 'left',
    complete: true,
    partial: false,
    roles: [
      {
        slot: 'left',
        identity: identity('left'),
        state: 'verified',
        attempted: true,
        before: f.state.roles.left.current!,
        planned: f.state.roles.left.current!,
        confirmed: f.state.roles.left.current!,
      },
    ],
  };
  f.publish({ lastResult: result });
  await render(f);
  expect(host.querySelector('section[aria-label="Configuration outcome"]')).toBeNull();
  await act(async () => f.publish({ lastResult: { ...result, reviewId: 'fresh' } }));
  expect(host.textContent).toContain('Configuration verified');
  await render(f, { slot: 'right' });
  expect(host.querySelector('section[aria-label="Configuration outcome"]')).toBeNull();
  await act(async () => f.publish({ revision: f.state.revision + 1 }));
  expect(host.querySelector('section[aria-label="Configuration outcome"]')).toBeNull();
  const changed = structuredClone(f.state.roles);
  changed.left.identity!.serial = 'REPLACEMENT';
  await act(async () => f.publish({ roles: changed }));
  await act(async () => f.publish({ lastResult: { ...result, reviewId: 'old-serial' } }));
  expect(host.querySelector('section[aria-label="Configuration outcome"]')).toBeNull();
});

it('shows unconfirmed, verified and pending results without claiming success or retrying', async () => {
  const f = fixture();
  await render(f);
  await target('both');
  await act(async () => toggle('Left Soft clip enabled').click());
  f.failApply({
    reviewId: 'fixture',
    target: 'both',
    complete: false,
    partial: true,
    error: 'Synthetic reply lost',
    roles: [
      {
        slot: 'left',
        identity: identity('left'),
        state: 'unconfirmed',
        attempted: true,
        before: f.state.roles.left.current!,
        planned: f.state.roles.left.preview!,
        error: 'Lost reply',
      },
      {
        slot: 'right',
        identity: identity('right'),
        state: 'pending',
        attempted: false,
        before: f.state.roles.right.current!,
        planned: f.state.roles.right.preview!,
      },
    ],
  });
  await act(async () => button('Apply configuration').click());
  const result = host.querySelector('section[aria-label="Configuration outcome"]')!;
  expect(result.textContent).toContain('Unconfirmed');
  expect(result.textContent).toContain('Not sent');
  expect(host.textContent).not.toContain('Configuration verified');
  expect(f.controller.apply).toHaveBeenCalledOnce();
});

it('does not access an unready principal and respects live permission changes', async () => {
  const f = fixture(),
    getContext = vi.fn(() => ui);
  await render(f, { contextReady: false, getContext });
  expect(getContext).not.toHaveBeenCalled();
  expect(f.controller.status).not.toHaveBeenCalled();
  expect(f.controller.load).not.toHaveBeenCalled();
  await render(f);
  await act(async () => toggle('Left Soft clip enabled').click());
  const changed = structuredClone(f.state.roles);
  changed.left.allowed!.softClip = false;
  await act(async () => f.publish({ roles: changed }));
  expect(toggle('Left Soft clip enabled').disabled).toBe(true);
  expect(button('Apply configuration').disabled).toBe(true);
  expect(f.controller.apply).not.toHaveBeenCalled();
});

it('does not apply a review for a replaced identity and hides a late completion after role changes', async () => {
  const f = fixture();
  await render(f);
  await act(async () => {
    f.controller.edit('left', agent, { expectedRevision: 2, patch: { softClip: false } });
    await f.controller.review('left', agent, { expectedRevision: 3 });
  });
  const next = structuredClone(f.state.roles);
  next.left.identity!.serial = 'REPLACEMENT';
  await act(async () => f.publish({ roles: next }));
  expect(button('Apply configuration').disabled).toBe(true);
  await act(async () => button('Apply configuration').click());
  expect(f.controller.apply).not.toHaveBeenCalled();
  const g = fixture(),
    wait = deferred<void>();
  g.waitForApply(wait.promise);
  await render(g);
  await act(async () => toggle('Left Soft clip enabled').click());
  await act(async () => button('Apply configuration').click());
  expect(g.controller.apply).toHaveBeenCalledOnce();
  await render(g, { slot: 'right' });
  await act(async () => wait.resolve());
  expect(host.querySelector('section[aria-label="Configuration outcome"]')).toBeNull();
  await act(async () => g.publish({ revision: g.state.revision + 1 }));
  expect(host.querySelector('section[aria-label="Configuration outcome"]')).toBeNull();
});

it('refuses automatic apply if the principal changes while the one-click review is pending', async () => {
  const f = fixture(),
    wait = deferred<void>();
  let actor: ToolExecutionContext = ui;
  f.waitForReview(wait.promise);
  await render(f, { getContext: () => actor });
  await act(async () => toggle('Left Soft clip enabled').click());
  await act(async () => button('Apply configuration').click());
  actor = foreign;
  await render(f, { getContext: () => actor });
  await act(async () => wait.resolve());
  expect(f.controller.apply).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('another workspace');
});

it('keeps connected current settings visible with the exact blocked-preview reason after permission drops', async () => {
  const f = fixture();
  await render(f);
  await act(async () => toggle('Left Soft clip enabled').click());
  const changed = structuredClone(f.state.roles);
  changed.left.allowed!.softClip = false;
  changed.left.preview = undefined;
  changed.left.error = 'Soft clip is locked by the current device permissions';
  await act(async () => f.publish({ roles: changed }));
  expect(host.querySelector('[aria-label="Left configuration draft"]')?.textContent).toContain(
    'SYNTHETIC-left',
  );
  expect(toggle('Left Soft clip enabled').checked).toBe(false);
  expect(toggle('Left Soft clip enabled').disabled).toBe(true);
  expect(host.textContent).toContain('Actual On');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'locked by the current device permissions',
  );
  expect(host.textContent).not.toContain('Connect the Left amplifier');
  expect(button('Apply configuration').disabled).toBe(true);
  expect(host.querySelector('table[aria-label="Left planned configuration changes"]')).toBeNull();
  await act(async () => button('Cancel changes').click());
  expect(f.controller.cancel).toHaveBeenCalledExactlyOnceWith('left', ui);
  expect(f.controller.apply).not.toHaveBeenCalled();
});
