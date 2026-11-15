// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NativeLimiterPanel from '../src/components/NativeLimiterPanel';
import type {
  NativeLimiterController,
  NativeLimiterReview,
  NativeLimiterResult,
  NativeLimiterSnapshot,
  NativeLimiterTarget,
} from '../src/application/native-limiter';
import {
  loadNativeLimiter,
  editNativeLimiter,
  previewNativeLimiter,
} from '../src/hardware/native-limiter';
import { packet, unhex } from '../src/hardware/codec';
import { decodeLimiter } from '../src/hardware/device-settings';
import type { Slot } from '../src/domain/model';

const firstActor = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'ui:first' },
  secondActor = { ...firstActor, scope: 'ui:current' },
  id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
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
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function raw(slot: Slot) {
  const b = packet(0x66),
    v = new DataView(b.buffer);
  b[10] = 5;
  b[11] = 1;
  b[12] = 22;
  b[13] = 1;
  for (let i = 0; i < 3; i++) {
    v.setInt32(20 + 4 * i, 20000000 + i, true);
    v.setInt32(32 + 4 * i, [16273900, 16100000, 16500000][i], true);
    v.setInt32(44 + 4 * i, [16776377, 16770000, 16776000][i], true);
    b[56 + i] = 40 + i * 10;
    b[59 + i] = (slot === 'left' ? 50 : 60) + i;
  }
  return b;
}
const targets = (target: NativeLimiterTarget): Slot[] =>
  target === 'both' ? ['left', 'right'] : [target];
function fixture() {
  let snapshot: NativeLimiterSnapshot = {
      phase: 'idle',
      busy: false,
      revision: 0,
      roles: {
        left: { connected: true, expert: false },
        right: { connected: true, expert: false },
      },
    },
    counter = 0;
  const listeners = new Set<() => void>(),
    publish = (patch: Partial<NativeLimiterSnapshot>) => {
      snapshot = { ...snapshot, ...patch };
      listeners.forEach((fn) => fn());
    };
  const identity = (slot: Slot) => ({
    serial: `SYNTHETIC-${slot.toUpperCase()}`,
    product: 22,
    core: '5.1',
    firmware: '5.7',
  });
  const loadRole = (slot: Slot) => {
    const draft = loadNativeLimiter(raw(slot), { bridged: false });
    publish({
      phase: 'ready',
      revision: snapshot.revision + 1,
      roles: {
        ...snapshot.roles,
        [slot]: {
          connected: true,
          identity: identity(slot),
          draft,
          preview: previewNativeLimiter(draft),
          expert: false,
          canUpdate: true,
        },
      },
    });
  };
  const makeReview = (target: NativeLimiterTarget = 'left'): NativeLimiterReview => ({
    id: id(++counter),
    target,
    revision: snapshot.revision,
    createdAt: 100,
    roles: targets(target).map((slot) => {
      const role = snapshot.roles[slot],
        { sourceHex, ...draft } = role.draft!;
      return {
        slot,
        identity: identity(slot),
        expert: role.expert,
        draft,
        before: decodeLimiter(unhex(sourceHex)).channels,
        after: role.preview!.channels,
      };
    }),
  });
  const result = (target: NativeLimiterTarget = 'left', reviewId = id(1)): NativeLimiterResult => ({
    reviewId,
    target,
    complete: true,
    partial: false,
    roles: targets(target).map((slot) => ({
      slot,
      identity: identity(slot),
      preflight: 'verified',
      backupId: `backup-${slot}`,
      lastConfirmedMuted: true,
      steps: [
        { id: 'mute', attempted: true, verified: true },
        { id: 'configuration', attempted: true, verified: true },
      ],
    })),
  });
  const controller: NativeLimiterController = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    status: vi.fn(() => snapshot),
    load: vi.fn(async (target) => {
      targets(target).forEach(loadRole);
      return snapshot;
    }),
    edit: vi.fn((target, _actor, input) => {
      expect(input.expectedRevision).toBe(snapshot.revision);
      const roles = { ...snapshot.roles };
      for (const slot of targets(target)) {
        const previous = roles[slot];
        if (input.action.type === 'expert-mode')
          roles[slot] = { ...previous, expert: input.action.value };
        else {
          const draft = editNativeLimiter(previous.draft!, input.action);
          try {
            roles[slot] = {
              ...previous,
              draft,
              preview: previewNativeLimiter(draft),
              error: undefined,
            };
          } catch {
            roles[slot] = {
              ...previous,
              draft,
              preview: undefined,
              error: 'Invalid coefficient text; finish editing before review',
            };
          }
        }
      }
      publish({ revision: snapshot.revision + 1, roles, activeReview: undefined });
      return snapshot;
    }),
    review: vi.fn(async (target, _actor, input) => {
      expect(input.expectedRevision).toBe(snapshot.revision);
      const activeReview = makeReview(target);
      publish({ activeReview, error: undefined });
      return activeReview;
    }),
    apply: vi.fn(async (reviewId) => {
      const value = result(snapshot.activeReview!.target, reviewId);
      publish({ activeReview: undefined, lastResult: value });
      return value;
    }),
    discard: vi.fn(() => publish({ activeReview: undefined })),
    refreshBindings: vi.fn(),
    dispose: vi.fn(),
  };
  return { controller, loadRole, publish, makeReview, result, snapshot: () => snapshot };
}
type Fixture = ReturnType<typeof fixture>;
async function render(
  f: Fixture,
  options: {
    slot?: Slot;
    contextReady?: boolean;
    externalBusy?: boolean;
    getContext?: () => typeof firstActor;
    connectedRoles?: readonly Slot[];
  } = {},
) {
  await act(async () =>
    root.render(
      <NativeLimiterPanel
        controller={f.controller}
        slot={options.slot ?? 'left'}
        connectedRoles={options.connectedRoles ?? ['left', 'right']}
        getContext={options.getContext ?? (() => firstActor)}
        contextReady={options.contextReady}
        externalBusy={options.externalBusy}
      />,
    ),
  );
}
function button(text: string) {
  const element = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  );
  expect(element, text).toBeDefined();
  return element!;
}
function input(label: string) {
  const element = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(element, label).not.toBeNull();
  return element!;
}
async function text(element: HTMLInputElement, value: string, blur = true) {
  await act(async () => element.focus());
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  if (blur) await act(async () => element.blur());
}
async function click(text: string) {
  await act(async () => button(text).click());
}

it('mounts from cached status with no device calls, then explicitly reads the chosen amplifier', async () => {
  const f = fixture();
  await render(f);
  expect(f.controller.load).not.toHaveBeenCalled();
  expect(f.controller.apply).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Opening this editor makes no device call');
  expect(button('Review update').disabled).toBe(true);
  await click('Read Left');
  expect(f.controller.load).toHaveBeenCalledExactlyOnceWith('left', firstActor);
  expect(host.textContent).toContain('SYNTHETIC-LEFT');
  for (const n of [1, 2, 3]) {
    expect(input(`CH${n} maximum power`)).toBeDefined();
    expect(input(`CH${n} impedance`)).toBeDefined();
  }
  expect(input('Global attack')).toBeDefined();
  expect(input('Global release')).toBeDefined();
  expect(host.querySelectorAll('input[aria-label$="coefficient"]')).toHaveLength(0);
});

it('keeps three output rows, one global timing pair and native presentation bounds while draft edits make no update call', async () => {
  const f = fixture();
  f.loadRole('left');
  await render(f);
  expect(
    host.querySelectorAll('table[aria-label="Limiter output power and load"] tbody tr'),
  ).toHaveLength(3);
  expect(input('CH1 maximum power').getAttribute('aria-valuemax')).toBe('1000');
  expect(input('CH1 impedance').getAttribute('aria-valuemin')).toBe('1');
  expect(input('Global attack').getAttribute('aria-valuemin')).toBe('0.3');
  expect(input('Global release').getAttribute('aria-valuemax')).toBe('99.9');
  await text(input('CH1 maximum power'), '280');
  expect(f.controller.edit).toHaveBeenLastCalledWith('left', firstActor, {
    expectedRevision: 1,
    action: { type: 'power', channel: 0, value: 280 },
  });
  expect(f.controller.apply).not.toHaveBeenCalled();
});

it('displays a native Single impedance as one decimal without changing its loaded value on focus/blur', async () => {
  const f = fixture(),
    source = raw('left');
  source[56] = 41;
  const draft = loadNativeLimiter(source, { bridged: false });
  f.publish({
    phase: 'ready',
    revision: 1,
    roles: {
      ...f.snapshot().roles,
      left: {
        connected: true,
        identity: { serial: 'SYNTHETIC-LEFT', product: 22, core: '5.1', firmware: '5.7' },
        expert: false,
        draft,
        preview: previewNativeLimiter(draft),
        canUpdate: true,
      },
    },
  });
  await render(f);
  const field = input('CH1 impedance');
  expect(field.value).toBe('4.1');
  const exact = f.snapshot().roles.left.draft!.channels[0].ohms;
  await act(async () => field.focus());
  await act(async () => field.blur());
  expect(f.snapshot().roles.left.draft!.channels[0].ohms).toBe(exact);
  expect(f.controller.edit).not.toHaveBeenCalled();
  expect(f.controller.apply).not.toHaveBeenCalled();
});

it('preserves loaded independent coefficients through Expert switching and exposes all nine raw Text fields with loaded words', async () => {
  const f = fixture();
  f.loadRole('left');
  const original = structuredClone(f.snapshot().roles.left.draft!.channels);
  await render(f);
  await act(async () => input('Expert limiter coefficients').click());
  expect(host.querySelectorAll('input[aria-label$="coefficient"]')).toHaveLength(9);
  expect(host.querySelector('input[aria-label="Global attack"]')).toBeNull();
  expect(host.textContent).toContain('Update recalculates all thresholds');
  expect(host.textContent).toContain('word 16776377');
  expect(host.textContent).toContain(
    `Planned Q24 word ${f.snapshot().roles.left.preview!.channels[0].attackWord}`,
  );
  await act(async () => input('Expert limiter coefficients').click());
  expect(f.snapshot().roles.left.draft!.channels).toEqual(original);
  expect(input('Global release').value).toBe('99.9');
  expect(f.controller.apply).not.toHaveBeenCalled();
});

it('retains output context while hiding native bridged CH2 and disabled CH3 power/load controls', async () => {
  const f = fixture();
  f.loadRole('left');
  const disabledOutput = raw('left');
  disabledOutput[13] = 0;
  const draft = loadNativeLimiter(disabledOutput, { bridged: true });
  f.publish({
    roles: {
      ...f.snapshot().roles,
      left: { ...f.snapshot().roles.left, draft, preview: previewNativeLimiter(draft) },
    },
  });
  await render(f);
  expect(input('CH1 maximum power')).toBeDefined();
  expect(host.querySelector('input[aria-label="CH2 maximum power"]')).toBeNull();
  expect(host.querySelector('input[aria-label="CH3 impedance"]')).toBeNull();
  expect(host.textContent).toContain('Bridge pair');
  expect(host.textContent).toContain('Output disabled');
  expect(
    host.querySelectorAll('table[aria-label="Limiter output power and load"] tbody tr'),
  ).toHaveLength(3);
  expect(host.textContent).toContain('update threshold is 20');
  expect(f.controller.apply).not.toHaveBeenCalled();
});

it('retains extra in-range coefficient precision and incomplete text; invalid preview blocks review without replacing the draft', async () => {
  const f = fixture();
  f.loadRole('left');
  await render(f);
  await act(async () => input('Expert limiter coefficients').click());
  await text(input('CH1 attack coefficient'), '0.987654321');
  expect(input('CH1 attack coefficient').value).toBe('0.987654321');
  expect(f.snapshot().roles.left.draft!.channels[0].attackText).toBe('0.987654321');
  await text(input('CH2 release coefficient'), '-', false);
  expect(input('CH2 release coefficient').value).toBe('-');
  expect(button('Review update').disabled).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Invalid coefficient');
  expect(f.controller.apply).not.toHaveBeenCalled();
});

it('displays fixed Both identities and requires review-bound confirmation from the current actor', async () => {
  const f = fixture();
  f.loadRole('left');
  f.loadRole('right');
  let actor = firstActor;
  await render(f, { getContext: () => actor });
  const selector = host.querySelector<HTMLSelectElement>('select[aria-label="Limiter target"]')!;
  await act(async () => {
    selector.value = 'both';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('Review update');
  const review = f.snapshot().activeReview!;
  expect(f.controller.review).toHaveBeenCalledWith('both', firstActor, { expectedRevision: 2 });
  expect(host.querySelector('[aria-label="Limiter update review"]')?.textContent).toContain(
    'SYNTHETIC-LEFT',
  );
  expect(host.querySelector('[aria-label="Limiter update review"]')?.textContent).toContain(
    'SYNTHETIC-RIGHT',
  );
  expect(host.textContent).toContain('Apply each amplifier’s own draft');
  expect(host.querySelector('[aria-label="Limiter update review"]')?.textContent).toContain(
    `Q24 ${review.roles[0].after[0].thresholdWord}`,
  );
  expect(button('Update captured amplifiers').disabled).toBe(true);
  expect(selector.disabled).toBe(true);
  await act(async () => input('Confirm captured limiter update').click());
  actor = secondActor;
  await click('Update captured amplifiers');
  expect(f.controller.apply).toHaveBeenCalledExactlyOnceWith(review.id, secondActor, {
    confirm: true,
  });
  expect(host.textContent).toContain('Outputs remain muted');
});

it('replaces staged controls with all six captured review rows and restores the editor after Cancel', async () => {
  const f = fixture();
  f.loadRole('left');
  f.loadRole('right');
  await render(f);
  expect(input('CH1 maximum power')).toBeDefined();
  expect(input('Global attack')).toBeDefined();
  const review = f.makeReview('both');
  await act(async () => f.publish({ activeReview: review }));
  expect(host.querySelector('[aria-label="Limiter output power and load"]')).toBeNull();
  expect(host.querySelector('input[aria-label="Global attack"]')).toBeNull();
  expect(host.querySelector('input[aria-label="Expert limiter coefficients"]')).toBeNull();
  expect(host.querySelectorAll('[aria-label="Captured limiter changes"] tbody tr')).toHaveLength(6);
  expect(host.textContent).toContain('Soft-clip limiter · Left');
  expect(host.textContent).toContain('SYNTHETIC-LEFT');
  expect(host.textContent).toContain('SYNTHETIC-RIGHT');
  expect(input('Confirm captured limiter update')).toBeDefined();
  await click('Cancel review');
  expect(f.controller.discard).toHaveBeenCalledExactlyOnceWith(review.id, firstActor);
  expect(host.querySelector('[aria-label="Limiter update review"]')).toBeNull();
  expect(input('CH1 maximum power')).toBeDefined();
  expect(input('Global attack')).toBeDefined();
  expect(f.controller.apply).not.toHaveBeenCalled();
});

it('uses the current shared revision when an expert exit and Review happen before another render', async () => {
  const f = fixture();
  f.loadRole('left');
  await render(f);
  await act(async () => input('Expert limiter coefficients').click());
  const field = input('CH1 attack coefficient');
  await text(field, '0.987654321', false);
  const revisionBeforeExit = f.snapshot().revision;
  await act(async () => {
    field.blur();
    button('Review update').click();
  });
  expect(f.controller.review).toHaveBeenCalledExactlyOnceWith('left', firstActor, {
    expectedRevision: revisionBeforeExit + 1,
  });
  expect(f.snapshot().activeReview?.roles[0].draft.channels[0].attackText).toBe('0.987654321');
});

it('does not overwrite a newer agent edit with a locally focused uncommitted number', async () => {
  const f = fixture();
  f.loadRole('left');
  await render(f);
  const field = input('CH1 maximum power');
  await text(field, '290', false);
  await act(async () =>
    f.controller.edit('left', secondActor, {
      expectedRevision: f.snapshot().revision,
      action: { type: 'power', channel: 0, value: 320 },
    }),
  );
  expect(field.value).toBe('320');
  await act(async () => field.blur());
  expect(f.controller.edit).toHaveBeenCalledTimes(1);
  expect(f.snapshot().roles.left.draft!.channels[0].watts).toBe(320);
});

it('immediately reflects agent edits and clears old confirmation/error when a new review appears', async () => {
  const f = fixture();
  f.loadRole('left');
  await render(f);
  vi.mocked(f.controller.review).mockRejectedValueOnce(new Error('Old review failed'));
  await click('Review update');
  expect(host.textContent).toContain('Old review failed');
  await act(async () =>
    f.controller.edit('left', firstActor, {
      expectedRevision: f.snapshot().revision,
      action: { type: 'power', channel: 0, value: 300 },
    }),
  );
  expect(input('CH1 maximum power').value).toBe('300');
  const next = f.makeReview('left');
  await act(async () => f.publish({ activeReview: next }));
  expect(host.textContent).not.toContain('Old review failed');
  await act(async () => input('Confirm captured limiter update').click());
  expect(button('Update captured amplifiers').disabled).toBe(false);
  await act(async () => f.publish({ activeReview: f.makeReview('left') }));
  expect(input('Confirm captured limiter update').checked).toBe(false);
  expect(button('Update captured amplifiers').disabled).toBe(true);
});

it('coalesces duplicate Update clicks and ignores a stale Left completion notice after switching to Right', async () => {
  const f = fixture();
  f.loadRole('left');
  f.loadRole('right');
  await render(f);
  await click('Review update');
  const review = f.snapshot().activeReview!,
    pending = deferred<NativeLimiterResult>();
  vi.mocked(f.controller.apply).mockImplementationOnce(() => pending.promise);
  await act(async () => input('Confirm captured limiter update').click());
  await act(async () => {
    button('Update captured amplifiers').click();
    button('Update captured amplifiers').click();
  });
  expect(f.controller.apply).toHaveBeenCalledTimes(1);
  await render(f, { slot: 'right' });
  expect(host.querySelector('[aria-label="Limiter output power and load"]')).toBeNull();
  await act(async () => pending.resolve(f.result('left', review.id)));
  expect(f.snapshot().roles.right.draft!.channels[0].watts).toBe(300);
  expect(host.textContent).toContain('Soft-clip limiter · Right');
  expect(host.textContent).not.toContain('Limiter update verified. Outputs remain muted.');
});

it('labels unconfirmed writes separately from blocked/not-sent steps and offers no automatic Retry', async () => {
  const f = fixture(),
    result = f.result('both');
  result.complete = false;
  result.partial = true;
  result.roles[0].steps[1] = {
    id: 'configuration',
    attempted: true,
    verified: false,
    error: 'ACK lost',
  };
  result.roles[0].error = 'Configuration was not confirmed';
  result.roles[1].preflight = 'failed';
  result.roles[1].steps = [
    { id: 'mute', attempted: false, verified: false, error: 'Locked' },
    { id: 'configuration', attempted: false, verified: false },
  ];
  f.publish({ lastResult: result });
  await render(f);
  const outcomes = host.querySelector('[aria-label="Last limiter update outcomes"]')!;
  expect(outcomes.textContent).toContain('Unconfirmed');
  expect(outcomes.textContent).toContain('Blocked');
  expect(outcomes.textContent).toContain('Not sent');
  expect(outcomes.textContent).toContain('SYNTHETIC-LEFT');
  expect(outcomes.textContent).toContain('SYNTHETIC-RIGHT');
  expect([...host.querySelectorAll('button')].some((b) => /retry/i.test(b.textContent ?? ''))).toBe(
    false,
  );
  expect(f.controller.apply).not.toHaveBeenCalled();
});

it('distinguishes unknown mute from confirmed On and confirmed Off in failure ledgers', async () => {
  const f = fixture(),
    value = f.result('left');
  value.complete = false;
  value.roles[0].preflight = 'failed';
  for (const [lastConfirmedMuted, expected] of [
    [undefined, 'Unknown'],
    [null, 'Unknown'],
    [true, 'On'],
    [false, 'Off'],
  ] as const) {
    // The current API uses null; absent observer metadata must also display Unknown.
    Object.assign(value.roles[0], { lastConfirmedMuted });
    await act(async () => f.publish({ lastResult: structuredClone(value) }));
    await render(f);
    expect(
      host.querySelector('[aria-label="Last limiter update outcomes"]')?.textContent,
    ).toContain(`Last confirmed mute: ${expected}`);
  }
  expect(f.controller.apply).not.toHaveBeenCalled();
});

it('disables actions while authority is unready, target is offline or another operation owns the devices', async () => {
  const f = fixture(),
    context = vi.fn(() => firstActor);
  f.loadRole('left');
  await render(f, { contextReady: false, getContext: context });
  expect(button('Read Left').disabled).toBe(true);
  expect(button('Review update').disabled).toBe(true);
  expect(context).not.toHaveBeenCalled();
  await render(f, { connectedRoles: [] });
  expect(button('Read Left').disabled).toBe(true);
  expect(button('Review update').disabled).toBe(true);
  await render(f, { externalBusy: true });
  expect(input('CH1 maximum power').disabled).toBe(true);
  expect(input('Expert limiter coefficients').disabled).toBe(true);
  expect(f.controller.load).not.toHaveBeenCalled();
  expect(f.controller.apply).not.toHaveBeenCalled();
});

it('does not publish a late request error after unmount', async () => {
  const f = fixture(),
    pending = deferred<Readonly<NativeLimiterSnapshot>>();
  vi.mocked(f.controller.load).mockReturnValueOnce(pending.promise);
  await render(f);
  await act(async () => button('Read Left').click());
  await act(async () => root.unmount());
  unmounted = true;
  await act(async () => pending.reject(new Error('Old session failed')));
  expect(host.textContent).toBe('');
  expect(f.controller.apply).not.toHaveBeenCalled();
});
