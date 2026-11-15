// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NativeMixerPanel, { type NativeMixerPanelProps } from '../src/components/NativeMixerPanel';
import type {
  NativeMixerController,
  NativeMixerSnapshot,
  NativeMixerTarget,
  NativeMixerPreset,
  NativeMixerReview,
  NativeMixerResult,
} from '../src/application/native-mixer';
import {
  nativeMixerAvailability,
  nativeMixerEditorRow,
  nativeMixerEditorWeight,
  encodeNativeMixerWeight,
  type NativeMatrix,
} from '../src/hardware/native-mixer';
import type { Slot } from '../src/domain/model';
import type { ToolExecutionContext } from '../src/application/execution-context';
import { downloadBrowserBlob } from '../src/domain/browser-download';
vi.mock('../src/domain/browser-download', () => ({ downloadBrowserBlob: vi.fn() }));

const ui = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'ui:mixer' },
  agent = { ...ui, scope: 'paired:site:mixer' },
  foreign = { owner: 'workspace:22222222-2222-4222-8222-222222222222', scope: 'ui:other' };
const identity = (slot: Slot) => ({
  serial: `SYNTHETIC-MIXER-${slot}`,
  product: 22,
  core: '5.1',
  firmware: '5.7',
});
const roles = (target: NativeMixerTarget): Slot[] =>
  target === 'both' ? ['left', 'right'] : [target];
const matrix = (values: number[][]) => values as unknown as NativeMatrix;
const raw = (slot: Slot) =>
  matrix(
    slot === 'left'
      ? [
          [0.5, 0.5, 0, 1, -1, 0],
          [0.125, -0.125, 0, 0, 0.5, 0.5],
          [0.75, 0.25, 1, 0, 0, -1],
        ]
      : [
          [0.25, 0.75, 1, 0, 0, -1],
          [-0.5, 0.5, 0, 1, 0.125, 0.875],
          [0, 1, 1, 0, -1, 0],
        ],
  );
const freeze = <T,>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
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
/** Public-controller component boundary. No PanelSession/USB/audio/storage
 * capability is present; only the actual pure native row/quantization is used. */
function fixture(
  options: { unread?: boolean; commercial?: boolean; unknownCapability?: boolean } = {},
) {
  const role = (slot: Slot) => ({
    connected: true,
    identity: identity(slot),
    availability: options.unknownCapability
      ? undefined
      : nativeMixerAvailability({
          product: 22,
          moduleType: options.commercial ? 9 : 1,
          core: '5.1',
          systemSetup: 2,
          stereoDsp: true,
        }),
    canEdit: !options.commercial,
    openedPresets: [false, false, false] as const,
    changedPresets: [false, false, false] as const,
    ...(options.unread ? {} : { current: raw(slot), draft: raw(slot), preview: raw(slot) }),
  });
  let snapshot: Readonly<NativeMixerSnapshot> = freeze({
      phase: 'ready',
      busy: false,
      revision: 4,
      roles: { left: role('left'), right: role('right') },
      records: [],
    }),
    sequence = 0;
  let loadWait: Promise<void> | undefined,
    reviewWait: Promise<void> | undefined,
    saveWait: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<NativeMixerSnapshot>) => {
    snapshot = freeze({ ...snapshot, ...structuredClone(patch) });
    listeners.forEach((listener) => listener());
  };
  const actor = (context: ToolExecutionContext) => {
    if (context.owner !== ui.owner) throw Error('Mixer drafts belong to another workspace');
  };
  const revision = (value: number) => {
    if (value !== snapshot.revision) throw Error('Mixer draft changed');
  };
  const recalc = (state: NativeMixerSnapshot['roles'][Slot]) => {
    const current = state.current!,
      draft = state.draft!,
      preview = structuredClone(current).map((row) => [...row]);
    state.openedPresets.forEach((opened, p) => {
      if (opened) preview[p] = draft[p].map((value) => encodeNativeMixerWeight(value) / 256);
    });
    state.preview = matrix(preview);
    state.changedPresets = draft.map(
      (row, p) => JSON.stringify(row) !== JSON.stringify(current[p]),
    ) as unknown as [boolean, boolean, boolean];
  };
  const open = (
    target: NativeMixerTarget,
    context: ToolExecutionContext,
    input: { expectedRevision: number; preset: NativeMixerPreset },
  ) => {
    actor(context);
    revision(input.expectedRevision);
    const next = structuredClone(snapshot.roles);
    for (const slot of roles(target)) {
      const state = next[slot];
      if (!state.canEdit || !state.availability?.editorAvailable || !state.current)
        throw Error(state.reason ?? state.availability?.reason ?? 'Mixer unavailable');
      const rows = state.draft!.map((row) => [...row]);
      rows[input.preset - 1] = [...nativeMixerEditorRow(rows[input.preset - 1])];
      state.draft = matrix(rows);
      state.openedPresets = state.openedPresets.map((opened, p) =>
        p === input.preset - 1 ? true : opened,
      ) as unknown as [boolean, boolean, boolean];
      recalc(state);
    }
    publish({ roles: next, revision: snapshot.revision + 1, activeReview: undefined });
    return snapshot;
  };
  const makeReview = (target: NativeMixerTarget, preset: NativeMixerPreset): NativeMixerReview => ({
    id: `opaque-mixer-review-${++sequence}`,
    target,
    preset,
    revision: snapshot.revision,
    createdAt: 123,
    roles: roles(target).map((slot) => ({
      slot,
      identity: identity(slot),
      changed: snapshot.roles[slot].changedPresets[preset - 1],
      before: snapshot.roles[slot].current!,
      after: snapshot.roles[slot].preview!,
    })),
  });
  const controller: NativeMixerController = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    status: vi.fn((context) => {
      actor(context);
      return snapshot;
    }),
    hydrate: vi.fn(async () => {}),
    refreshHistory: vi.fn(async () => {}),
    refreshBindings: vi.fn(),
    dispose: vi.fn(),
    load: vi.fn(async (target, context, input) => {
      actor(context);
      if (loadWait) await loadWait;
      const next = structuredClone(snapshot.roles);
      for (const slot of roles(target)) {
        next[slot].current = raw(slot);
        next[slot].draft = raw(slot);
        next[slot].preview = raw(slot);
      }
      publish({ roles: next });
      return open(target, context, { preset: input.preset, expectedRevision: snapshot.revision });
    }),
    open: vi.fn(open),
    edit: vi.fn((target, context, input) => {
      actor(context);
      revision(input.expectedRevision);
      const next = structuredClone(snapshot.roles);
      for (const slot of roles(target)) {
        const state = next[slot],
          rows = state.draft!.map((row) => [...row]);
        if (!state.canEdit) throw Error('Native mixer permission denied');
        rows[input.preset - 1][(input.channel - 1) * 2 + (input.input === 'right' ? 1 : 0)] =
          nativeMixerEditorWeight(Math.max(-1, Math.min(1, input.value)));
        state.draft = matrix(rows);
        recalc(state);
      }
      publish({ roles: next, revision: snapshot.revision + 1, activeReview: undefined });
      return snapshot;
    }),
    cancel: vi.fn((target, context, input) => {
      actor(context);
      const next = structuredClone(snapshot.roles);
      for (const slot of roles(target)) {
        const state = next[slot],
          rows = state.draft!.map((row) => [...row]);
        rows[input.preset - 1] = [...state.current![input.preset - 1]];
        state.draft = matrix(rows);
        state.openedPresets = state.openedPresets.map((opened, p) =>
          p === input.preset - 1 ? false : opened,
        ) as unknown as [boolean, boolean, boolean];
        recalc(state);
      }
      publish({ roles: next, revision: snapshot.revision + 1, activeReview: undefined });
    }),
    review: vi.fn(async (target, context, input) => {
      actor(context);
      revision(input.expectedRevision);
      if (reviewWait) await reviewWait;
      const activeReview = makeReview(target, input.preset);
      publish({ activeReview });
      return activeReview;
    }),
    save: vi.fn(async (id, context) => {
      actor(context);
      if (saveWait) await saveWait;
      const review = snapshot.activeReview!;
      if (review.id !== id) throw Error('Review changed');
      const result: NativeMixerResult = {
        id,
        target: review.target,
        preset: review.preset,
        createdAt: 123,
        updatedAt: 456,
        phase: 'complete',
        complete: true,
        partial: false,
        replayed: false,
        persistence: 'verified',
        roles: review.roles.map((row) => ({
          slot: row.slot,
          identity: row.identity,
          state: row.changed ? 'verified' : 'unchanged',
          attempted: row.changed,
        })),
      };
      const next = structuredClone(snapshot.roles);
      for (const row of review.roles) {
        const state = next[row.slot],
          current = state.current!.map((value) => [...value]),
          draft = state.draft!.map((value) => [...value]);
        current[review.preset - 1] = [...row.after[review.preset - 1]];
        draft[review.preset - 1] = [...current[review.preset - 1]];
        state.current = matrix(current);
        state.draft = matrix(draft);
        state.openedPresets = state.openedPresets.map((value, p) =>
          p === review.preset - 1 ? false : value,
        ) as unknown as [boolean, boolean, boolean];
        recalc(state);
      }
      publish({
        roles: next,
        revision: snapshot.revision + 1,
        activeReview: undefined,
        lastResult: result,
      });
      return result;
    }),
    discard: vi.fn((id, context) => {
      actor(context);
      if (snapshot.activeReview?.id !== id) throw Error('Wrong review');
      publish({ activeReview: undefined });
    }),
    exportRecord: vi.fn(() => {
      throw Error('Not used by this component');
    }),
  };
  return {
    controller,
    publish,
    makeReview,
    snapshot: () => snapshot,
    waitLoad: (value: Promise<void>) => {
      loadWait = value;
    },
    waitReview: (value: Promise<void>) => {
      reviewWait = value;
    },
    waitSave: (value: Promise<void>) => {
      saveWait = value;
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function Wrapper({
  f,
  options,
}: {
  f: Fixture;
  options: Partial<Omit<NativeMixerPanelProps, 'controller' | 'preset' | 'onPresetChange'>> & {
    initialPreset?: NativeMixerPreset;
  };
}) {
  const [preset, setPreset] = useState(options.initialPreset ?? 1);
  return (
    <NativeMixerPanel
      controller={f.controller}
      slot={options.slot ?? 'left'}
      preset={preset}
      onPresetChange={setPreset}
      connectedRoles={options.connectedRoles ?? ['left', 'right']}
      getContext={options.getContext ?? (() => ui)}
      contextReady={options.contextReady}
      externalBusy={options.externalBusy}
    />
  );
}
async function render(f: Fixture, options: Parameters<typeof Wrapper>[0]['options'] = {}) {
  await act(async () => root.render(<Wrapper f={f} options={options} />));
}
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent?.trim() === name,
  )!;
const input = (slot: Slot = 'left', preset = 1, channel = 1, side = 'Left') =>
  host.querySelector<HTMLInputElement>(
    `input[aria-label="${slot === 'left' ? 'Left' : 'Right'} preset ${preset} CH${channel} ${side} weight"]`,
  )!;
async function click(name: string) {
  expect(button(name), name).toBeDefined();
  await act(async () => button(name).click());
}
async function type(field: HTMLInputElement, value: string, blur = true) {
  await act(async () => field.focus());
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  if (blur) await act(async () => field.blur());
}
async function select(name: string, value: string) {
  await act(async () => {
    const field = host.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`)!;
    field.value = value;
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

it('automatically reads only the eligible selected role once, opens its row, and never saves on entry', async () => {
  const f = fixture({ unread: true });
  await render(f);
  expect(f.controller.load).toHaveBeenCalledExactlyOnceWith('left', ui, { preset: 1 });
  expect(input().value).toBe('0.50');
  expect(f.controller.save).not.toHaveBeenCalled();
  expect(f.controller.hydrate).not.toHaveBeenCalled();
  expect(f.controller.load).not.toHaveBeenCalledWith('right', expect.anything(), expect.anything());
  await act(async () => f.publish({ revision: f.snapshot().revision + 1 }));
  expect(f.controller.load).toHaveBeenCalledTimes(1);
});
it.each([{ commercial: true }, { unknownCapability: true }])(
  'does not read or expose an editable matrix for ineligible/unknown cached capability %o',
  async (options) => {
    const f = fixture({ ...options, unread: true });
    await render(f);
    expect(f.controller.load).not.toHaveBeenCalled();
    expect(f.controller.open).not.toHaveBeenCalled();
    expect(host.querySelector('input')).toBeNull();
    expect(button('Save mixer').disabled).toBe(true);
    expect(button('Refresh mixer').disabled).toBe(true);
    expect(host.textContent).toContain(
      options.commercial ? 'requires configured OEM module 1' : 'capability is not available',
    );
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  },
);
it('preserves native row-open normalization and other presets, then keeps Cancel closed until explicit Edit', async () => {
  const f = fixture();
  await render(f, { initialPreset: 2 });
  expect(f.controller.open).toHaveBeenCalledTimes(1);
  expect(input('left', 2).value).toBe('0.13');
  expect(host.textContent).toContain('Current 0.125 → planned 0.12890625');
  expect(f.snapshot().roles.left.current![1][0]).toBe(0.125);
  expect(f.snapshot().roles.left.draft![0]).toEqual(raw('left')[0]);
  await click('Cancel changes');
  expect(host.querySelector('input')).toBeNull();
  expect(f.snapshot().roles.left.openedPresets[1]).toBe(false);
  await act(async () => f.publish({ revision: f.snapshot().revision + 1 }));
  expect(f.controller.open).toHaveBeenCalledTimes(1);
  await click('Edit Left mixer');
  expect(input('left', 2).value).toBe('0.13');
  expect(f.controller.save).not.toHaveBeenCalled();
});
it('allows a full numeric draft and negative contribution, emits once on blur, and does not normalize the other input', async () => {
  const f = fixture();
  await render(f);
  const field = input();
  await type(field, '-', false);
  await type(field, '-0.', false);
  await type(field, '-0.75', false);
  expect(f.controller.edit).not.toHaveBeenCalled();
  await act(async () => field.blur());
  expect(f.controller.edit).toHaveBeenCalledTimes(1);
  expect(f.snapshot().roles.left.draft![0][0]).toBe(-0.75);
  expect(f.snapshot().roles.left.draft![0][1]).toBe(0.5);
  expect(input().value).toBe('-0.75');
  expect(f.controller.review).not.toHaveBeenCalled();
  expect(f.controller.save).not.toHaveBeenCalled();
});
it('uses the shared native typed callback formatting instead of binary toFixed rounding for an exact decimal tie', async () => {
  const f = fixture();
  await render(f);
  const field = input();
  await type(field, '.105');
  expect(f.controller.edit).toHaveBeenCalledTimes(1);
  expect(f.controller.edit).toHaveBeenCalledWith(
    'left',
    ui,
    expect.objectContaining({ value: 0.105 }),
  );
  expect(field.value).toBe('0.11');
  expect(f.snapshot().roles.left.draft![0][0]).toBe(Math.fround(0.11));
  expect(field.closest('label')?.textContent).toContain('planned 0.109375');
  expect(field.closest('label')?.querySelector('[role="alert"]')).toBeNull();
  expect(f.controller.save).not.toHaveBeenCalled();
});
it('Both shows independent drafts, loads only an unread peer, and saves one preset with one adjacent action', async () => {
  const f = fixture();
  await render(f);
  await type(input(), '.75');
  const next = structuredClone(f.snapshot().roles);
  next.right.current = next.right.draft = next.right.preview = undefined;
  await act(async () => f.publish({ roles: next }));
  await select('Mixer target', 'both');
  expect(f.controller.load).toHaveBeenCalledExactlyOnceWith('right', ui, { preset: 1 });
  expect(input('left').value).toBe('0.75');
  expect(input('right').value).toBe('0.25');
  await type(input('right'), '-0.5');
  const reviewRevision = f.snapshot().revision;
  await click('Save mixer');
  expect(f.controller.review).toHaveBeenCalledExactlyOnceWith('both', ui, {
    expectedRevision: reviewRevision,
    preset: 1,
  });
  expect(f.controller.save).toHaveBeenCalledExactlyOnceWith('opaque-mixer-review-1', ui, {
    confirm: true,
  });
  expect(host.textContent).toContain('Mixer verified');
  expect(host.textContent).toContain('SYNTHETIC-MIXER-left');
  expect(host.textContent).toContain('SYNTHETIC-MIXER-right');
  expect(f.snapshot().roles.left.current![0][0]).toBe(0.75);
  expect(f.snapshot().roles.right.current![0][0]).toBe(-0.5);
  expect(f.snapshot().roles.left.current![1]).toEqual(raw('left')[1]);
});
it('preset selection calls shared open and preserves another unsaved preset draft', async () => {
  const f = fixture();
  await render(f);
  await type(input(), '.75');
  await select('Mixer preset', '2');
  expect(input('left', 2).value).toBe('0.13');
  expect(f.snapshot().roles.left.draft![0][0]).toBe(0.75);
  expect(host.textContent).toContain('Unsaved presets: 1, 2');
  await click('Save mixer');
  expect(f.controller.review).toHaveBeenLastCalledWith(
    'left',
    ui,
    expect.objectContaining({ preset: 2 }),
  );
  expect(f.snapshot().roles.left.changedPresets[0]).toBe(true);
  expect(f.snapshot().roles.left.draft![0][0]).toBe(0.75);
});
it('reopens a canceled Both preset with one shared Edit action and no device load or Save', async () => {
  const f = fixture();
  await render(f);
  await select('Mixer target', 'both');
  await click('Cancel changes');
  expect(host.querySelector('input')).toBeNull();
  const previous = vi.mocked(f.controller.open).mock.calls.length;
  await click('Edit Left + Right mixer');
  expect(f.controller.open).toHaveBeenCalledTimes(previous + 1);
  expect(f.controller.open).toHaveBeenLastCalledWith(
    'both',
    ui,
    expect.objectContaining({ preset: 1 }),
  );
  expect(input('left')).not.toBeNull();
  expect(input('right')).not.toBeNull();
  expect(f.controller.load).not.toHaveBeenCalled();
  expect(f.controller.save).not.toHaveBeenCalled();
});
it('shows externally shared drafts/review context and saves its exact opaque review rather than retargeting', async () => {
  const f = fixture();
  await render(f);
  await act(async () => {
    f.controller.open('right', agent, { expectedRevision: f.snapshot().revision, preset: 3 });
    f.controller.edit('right', agent, {
      expectedRevision: f.snapshot().revision,
      preset: 3,
      channel: 2,
      input: 'right',
      value: -0.75,
    });
    await f.controller.review('right', agent, {
      expectedRevision: f.snapshot().revision,
      preset: 3,
    });
  });
  expect(host.textContent).toContain('Reviewed Right · Preset 3 · opaque-mixer-review-1');
  expect(host.querySelector('input')).toBeNull();
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="Mixer preset"]')!.value).toBe(
    '3',
  );
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="Mixer target"]')!.disabled).toBe(
    true,
  );
  await click('Save mixer');
  expect(f.controller.review).toHaveBeenCalledTimes(1);
  expect(f.controller.save).toHaveBeenCalledExactlyOnceWith('opaque-mixer-review-1', ui, {
    confirm: true,
  });
});
it('displays a native permission drop with actual values and no misleading disconnected prompt', async () => {
  const f = fixture();
  await render(f);
  await type(input(), '.75');
  const next = structuredClone(f.snapshot().roles);
  next.left.canEdit = false;
  next.left.reason = 'Native digital Left/Right permission is denied';
  await act(async () => f.publish({ roles: next, revision: f.snapshot().revision + 1 }));
  expect(host.textContent).toContain('permission is denied');
  expect(host.textContent).not.toContain('Connect the Left');
  expect(host.querySelector('input')).toBeNull();
  expect(button('Save mixer').disabled).toBe(true);
  expect(f.controller.save).not.toHaveBeenCalled();
});
it('invalidates an uncommitted field on external revision and on role replacement', async () => {
  const f = fixture();
  await render(f);
  let field = input();
  await type(field, '.9', false);
  await act(async () =>
    f.controller.edit('left', agent, {
      expectedRevision: f.snapshot().revision,
      preset: 1,
      channel: 1,
      input: 'left',
      value: 0.25,
    }),
  );
  expect(field.value).toBe('0.25');
  await act(async () => field.blur());
  expect(f.controller.edit).toHaveBeenCalledTimes(1);
  field = input();
  await type(field, '.8', false);
  await render(f, { slot: 'right' });
  await act(async () => field.blur());
  expect(f.controller.edit).toHaveBeenCalledTimes(1);
  expect(input('right').value).toBe('0.25');
});
it('restores the actual draft text if the shared controller rejects a numeric edit', async () => {
  const f = fixture();
  await render(f);
  vi.mocked(f.controller.edit).mockImplementationOnce(() => {
    throw Error('Mixer connection changed');
  });
  await type(input(), '.75');
  expect(input().value).toBe('0.50');
  expect(host.textContent).toContain('Mixer connection changed');
  expect(button('Save mixer').disabled).toBe(true);
  expect(f.controller.save).not.toHaveBeenCalled();
});
it('does not save a late reviewed draft after the selected role changes', async () => {
  const f = fixture(),
    gate = deferred<void>();
  await render(f);
  await type(input(), '.75');
  f.waitReview(gate.promise);
  await act(async () => button('Save mixer').click());
  await render(f, { slot: 'right' });
  await act(async () => gate.resolve());
  expect(f.controller.save).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Reviewed Left · Preset 1');
});
it('coalesces duplicate Save clicks and labels unconfirmed shared outcomes separately', async () => {
  const f = fixture(),
    gate = deferred<void>();
  await render(f);
  await type(input(), '.75');
  f.waitSave(gate.promise);
  await act(async () => {
    button('Save mixer').click();
    button('Save mixer').click();
  });
  expect(f.controller.review).toHaveBeenCalledTimes(1);
  expect(f.controller.save).toHaveBeenCalledTimes(1);
  await act(async () => gate.resolve());
  const result: NativeMixerResult = {
    ...f.snapshot().lastResult!,
    id: 'unconfirmed-fixture',
    complete: false,
    partial: true,
    phase: 'partial',
    roles: [
      {
        slot: 'left',
        identity: identity('left'),
        state: 'unconfirmed',
        attempted: true,
        error: 'Lost synthetic ACK',
      },
    ],
  };
  await act(async () => f.publish({ lastResult: result }));
  expect(host.textContent).toContain('Mixer partially confirmed');
  expect(host.textContent).toContain('Unconfirmed');
  expect(host.textContent).toContain('Lost synthetic ACK');
});
it('does not resurrect initial historical results, expose foreign drafts or save on unmount', async () => {
  const f = fixture();
  const result: NativeMixerResult = {
    id: 'old',
    target: 'left',
    preset: 1,
    createdAt: 1,
    updatedAt: 1,
    phase: 'complete',
    roles: [{ slot: 'left', identity: identity('left'), state: 'verified', attempted: true }],
    complete: true,
    partial: false,
    replayed: true,
    persistence: 'verified',
  };
  f.publish({ lastResult: result });
  await render(f);
  expect(host.querySelector('[aria-label="Mixer outcome"]')).toBeNull();
  await render(f, { getContext: () => foreign });
  expect(host.textContent).toContain('another workspace');
  expect(host.querySelector('input')).toBeNull();
  await act(async () => root.unmount());
  unmounted = true;
  expect(f.controller.save).not.toHaveBeenCalled();
});
it('ignores a late initial-read rejection after unmount', async () => {
  const f = fixture({ unread: true }),
    gate = deferred<void>();
  f.waitLoad(gate.promise);
  await render(f);
  expect(f.controller.load).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  unmounted = true;
  await act(async () => gate.reject(Error('Late synthetic read failure')));
  expect(f.controller.save).not.toHaveBeenCalled();
});
it('disables a visible reviewed Save when a known permission changes before the action', async () => {
  const f = fixture();
  await render(f);
  await type(input(), '.75');
  await act(async () => {
    await f.controller.review('left', agent, {
      expectedRevision: f.snapshot().revision,
      preset: 1,
    });
  });
  const next = structuredClone(f.snapshot().roles);
  next.left.canEdit = false;
  next.left.reason = 'Native mixer permission changed';
  await act(async () => f.publish({ roles: next }));
  expect(host.textContent).toContain('Native mixer permission changed');
  expect(button('Save mixer').disabled).toBe(true);
  await click('Save mixer');
  expect(f.controller.save).not.toHaveBeenCalled();
});
it('exposes bounded local journal history and exports the retained record through the browser helper without a device operation', async () => {
  const f = fixture();
  await render(f);
  const record = {
    id: 'retained-record',
    target: 'left' as const,
    preset: 2 as const,
    createdAt: 123,
    updatedAt: 456,
    phase: 'partial' as const,
    roles: [
      {
        slot: 'left' as const,
        identity: identity('left'),
        state: 'unconfirmed' as const,
        attempted: true,
        error: 'Synthetic ACK lost',
      },
    ],
    error: 'Synthetic ACK lost',
  };
  await act(async () => f.publish({ records: [record] }));
  expect(host.textContent).toContain('Saved mixer records (1)');
  expect(host.textContent).toContain('Unconfirmed; attempted');
  const exported = {
    ...record,
    owner: ui.owner,
    scope: ui.scope,
    revision: 4,
    roles: [
      {
        ...record.roles[0],
        before: {
          mixerHex: '67008000',
          statusHex: '0500',
          configurationHex: '0616',
          deviceConfigurationHex: '6600',
        },
        beforeSha256: 'original-before-hash',
        desiredSha256: 'desired-hash',
        desired: { requestHex: '6701', expectedHex: '6700', maskHex: 'ff00' },
      },
    ],
    exportPersistence: 'verified' as const,
  };
  vi.mocked(f.controller.exportRecord).mockReturnValue(exported);
  await click('Refresh history');
  expect(f.controller.refreshHistory).toHaveBeenCalledExactlyOnceWith(ui);
  await click('Download record');
  expect(f.controller.exportRecord).toHaveBeenCalledExactlyOnceWith('retained-record', ui);
  expect(downloadBrowserBlob).toHaveBeenCalledWith(
    'hypex-mixer-retained-record.json',
    expect.any(Blob),
  );
  const blob = vi.mocked(downloadBrowserBlob).mock.calls.at(-1)![1],
    reader = new FileReader();
  const content = await new Promise<string>((resolve, reject) => {
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(blob);
  });
  expect(JSON.parse(content)).toEqual(exported);
  expect(f.controller.load).not.toHaveBeenCalled();
  expect(f.controller.review).not.toHaveBeenCalled();
  expect(f.controller.save).not.toHaveBeenCalled();
});
