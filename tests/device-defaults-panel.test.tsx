// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DeviceDefaultsPanel from '../src/components/DeviceDefaultsPanel';
import type {
  DeviceDefaultsController,
  DeviceDefaultsReview,
  DeviceDefaultsSnapshot,
  DeviceDefaultsTarget,
} from '../src/application/device-defaults';
import {
  defaultsBeforeSha256,
  type DefaultsJournalRecord,
  type DefaultsJournalRole,
} from '../src/application/device-defaults-storage';
import type { ExecutionPrincipal } from '../src/application/execution-context';
import {
  buildDeviceDefaultsPlan,
  buildDeviceDefaultsRecoveryPlan,
} from '../src/hardware/device-defaults';
import { control, decodeStatus, hex } from '../src/hardware/codec';
import { SimulatedPanel } from '../src/hardware/simulator';
import type { Slot } from '../src/domain/model';
import { download } from '../src/domain/files';

vi.mock('../src/domain/files', () => ({ download: vi.fn() }));

const firstActor = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'ui:first' };
const secondActor = { ...firstActor, scope: 'ui:renewed' };
const id = (n: number) => `12345678-1234-4234-8234-${String(n).padStart(12, '0')}`;
let host: HTMLDivElement,
  root: Root,
  unmounted = false;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  unmounted = false;
  vi.mocked(download).mockClear();
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
function hardware(slot: Slot) {
  const panel = new SimulatedPanel(`SYNTHETIC-DEFAULTS-${slot.toUpperCase()}`);
  panel.status[6] = 0;
  panel.status[9] = 0xf6;
  panel.status[10] = 0x2b;
  panel.status[35] = 0x92;
  new DataView(panel.status.buffer).setInt16(21, -20000, true);
  panel.deviceConfiguration[13] = 1;
  const snapshot = {
    identity: { serial: panel.serial, product: 22, core: '5.1', firmware: '5.7' },
    status: panel.status.slice(),
    configuration: panel.configuration.slice(),
    deviceConfiguration: panel.deviceConfiguration.slice(),
  };
  return { snapshot, plan: buildDeviceDefaultsPlan(snapshot), panel };
}
function review(
  target: DeviceDefaultsTarget = 'left',
  serial = 1,
  operation: 'defaults' | 'recovery' = 'defaults',
): DeviceDefaultsReview {
  const slots: Slot[] = target === 'both' ? ['left', 'right'] : [target];
  return {
    id: id(serial),
    target,
    operation,
    createdAt: 100,
    ...(operation === 'recovery' ? { sourceRecordId: id(80) } : {}),
    roles: slots.map((slot) => {
      const { snapshot, plan: forward } = hardware(slot);
      const plan =
        operation === 'defaults'
          ? forward
          : buildDeviceDefaultsRecoveryPlan(
              snapshot,
              forward.steps[3].request,
              forward.steps[2].request,
            );
      return {
        slot,
        identity: snapshot.identity,
        before: plan.before,
        after: plan.after,
        steps: ['mute', ...plan.steps.map((s) => s.id)],
      };
    }),
  };
}
function record(
  serial = 80,
  phase: DefaultsJournalRecord['phase'] = 'complete',
): DefaultsJournalRecord {
  const { snapshot, plan } = hardware('left'),
    before = {
      statusHex: hex(snapshot.status),
      configurationHex: hex(snapshot.configuration),
      deviceConfigurationHex: hex(snapshot.deviceConfiguration),
    },
    mute = control(decodeStatus(snapshot.status), { mute: true }),
    allSteps = [
      {
        id: 'mute' as const,
        request: mute,
        verification: { expected: mute, mask: plan.steps[0].verification.mask },
      },
      ...plan.steps,
    ];
  const role: DefaultsJournalRole = {
    slot: 'left',
    identity: snapshot.identity,
    before,
    beforeSha256: defaultsBeforeSha256(before),
    preflight: 'verified',
    lastConfirmedMuted: true,
    steps: allSteps.map((step, i) => ({
      id: step.id,
      requestHex: hex(step.request),
      expectedHex: hex(step.verification.expected),
      maskHex: hex(step.verification.mask),
      attempted: phase === 'complete' || i < 2,
      state: phase === 'complete' || i === 0 ? 'verified' : i === 1 ? 'attempted' : 'pending',
      ...(phase === 'partial' && i === 1
        ? { error: 'Synthetic response lost; outcome unknown' }
        : {}),
    })),
  };
  return {
    id: id(serial),
    owner: firstActor.owner,
    scope: firstActor.scope,
    operation: 'defaults',
    target: 'left',
    createdAt: 100,
    updatedAt: 200,
    phase,
    roles: [role],
    ...(phase === 'partial' ? { error: 'Settings write was not confirmed' } : {}),
  };
}
function fixture(initial: Partial<DeviceDefaultsSnapshot> = {}) {
  let snapshot: Readonly<DeviceDefaultsSnapshot> = {
    phase: 'ready',
    busy: false,
    records: [],
    ...initial,
  };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<DeviceDefaultsSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const controller = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hydrate: vi.fn(async (_actor: ExecutionPrincipal) => {}),
    status: vi.fn((_actor: ExecutionPrincipal) => snapshot),
    reviewDefaults: vi.fn(async (target: DeviceDefaultsTarget, _actor: ExecutionPrincipal) => {
      const next = review(target);
      publish({ activeReview: next });
      return next;
    }),
    apply: vi.fn(async (_id: string, _actor: ExecutionPrincipal, _confirm: { confirm: true }) => {
      const next = record();
      publish({ activeReview: undefined, records: [next] });
      return next;
    }),
    discard: vi.fn((_id: string, _actor: ExecutionPrincipal) =>
      publish({ activeReview: undefined }),
    ),
    reviewRecovery: vi.fn(async (_id: string, _actor: ExecutionPrincipal) => {
      const next = review('left', 2, 'recovery');
      publish({ activeReview: next });
      return next;
    }),
    restore: vi.fn(async (_id: string, _actor: ExecutionPrincipal, _confirm: { confirm: true }) => {
      const next = { ...record(81), operation: 'recovery' as const, sourceRecordId: id(80) };
      publish({ activeReview: undefined, records: [next] });
      return next;
    }),
    exportRecord: vi.fn((recordId: string, _actor: ExecutionPrincipal) =>
      snapshot.records.find((entry) => entry.id === recordId)!,
    ),
    refreshBindings: vi.fn(),
    dispose: vi.fn(),
  } satisfies DeviceDefaultsController;
  let props = {
    controller,
    slot: 'left' as Slot,
    connectedRoles: ['left', 'right'] as readonly Slot[],
    getContext: () => firstActor,
    contextReady: true,
    externalBusy: false,
  };
  const render = async (patch: Partial<typeof props> = {}) => {
    props = { ...props, ...patch };
    await act(async () => root.render(<DeviceDefaultsPanel {...props} />));
  };
  return { controller, publish, render, listeners };
}
function button(text: string) {
  const result = [...host.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === text,
  );
  expect(result, text).toBeDefined();
  return result!;
}
function confirmation() {
  const result = host.querySelector<HTMLInputElement>(
    'input[aria-label="Confirm the captured Defaults settings"]',
  );
  expect(result).not.toBeNull();
  return result!;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function confirm() {
  await act(async () => confirmation().click());
}

it('mounts offline history without querying or writing an amp, and only enables review after authority and connection are available', async () => {
  const f = fixture();
  await f.render({ connectedRoles: [], contextReady: false });
  expect(f.controller.hydrate).not.toHaveBeenCalled();
  expect(button('Review defaults').disabled).toBe(true);
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  await f.render({ contextReady: true, getContext: () => secondActor });
  expect(f.controller.hydrate).toHaveBeenCalledExactlyOnceWith(secondActor);
  expect(button('Review defaults').disabled).toBe(true);
  expect(f.controller.reviewDefaults).not.toHaveBeenCalled();
  expect(f.controller.apply).not.toHaveBeenCalled();
  expect(host.textContent).toContain('History does not query an amplifier');
  await f.render({ connectedRoles: ['left'] });
  expect(button('Review defaults').disabled).toBe(false);
  await click('Review defaults');
  expect(f.controller.reviewDefaults).toHaveBeenCalledExactlyOnceWith('left', secondActor);
  expect(host.textContent).toContain('Last used volume');
  expect(host.textContent).not.toContain('-200 dB');
  expect(confirmation().checked).toBe(false);
  expect(button('Apply captured defaults').disabled).toBe(true);
});

it('binds confirmation to the opaque review identity and resets it when a different review replaces the visible settings', async () => {
  const f = fixture({ activeReview: review('left', 5) });
  await f.render();
  await confirm();
  expect(button('Apply captured defaults').disabled).toBe(false);
  await act(async () => f.publish({ activeReview: review('right', 6) }));
  expect(confirmation().checked).toBe(false);
  expect(button('Apply captured defaults').disabled).toBe(true);
  await click('Apply captured defaults');
  expect(f.controller.apply).not.toHaveBeenCalled();
  await confirm();
  await click('Apply captured defaults');
  expect(f.controller.apply).toHaveBeenCalledExactlyOnceWith(id(6), firstActor, { confirm: true });
});

it('keeps the captured review visible through selected-role and connection changes, without retargeting its confirmation', async () => {
  const f = fixture({ activeReview: review('left', 7) });
  await f.render();
  await confirm();
  await f.render({ slot: 'right', connectedRoles: ['right'], getContext: () => secondActor });
  const target = host.querySelector<HTMLSelectElement>('select[aria-label="Defaults target"]')!;
  expect(target.value).toBe('left');
  expect(target.disabled).toBe(true);
  expect(host.textContent).toContain('SYNTHETIC-DEFAULTS-LEFT');
  expect(host.textContent).not.toContain('SYNTHETIC-DEFAULTS-RIGHT');
  f.controller.apply.mockRejectedValueOnce(new Error('Captured Left connection is unavailable'));
  await click('Apply captured defaults');
  expect(f.controller.apply).toHaveBeenCalledExactlyOnceWith(id(7), secondActor, { confirm: true });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Captured Left connection is unavailable',
  );
  await act(async () => f.publish({ activeReview: review('right', 8) }));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(confirmation().checked).toBe(false);
  expect(f.controller.reviewDefaults).not.toHaveBeenCalled();
});

it('coalesces duplicate apply clicks before React flushes and retains busy until the one operation completes', async () => {
  const f = fixture({ activeReview: review('both', 8) }),
    pending = deferred<DefaultsJournalRecord>();
  f.controller.apply.mockImplementationOnce(() => pending.promise);
  await f.render();
  await confirm();
  const apply = button('Apply captured defaults');
  await act(async () => {
    apply.click();
    apply.click();
  });
  expect(f.controller.apply).toHaveBeenCalledTimes(1);
  expect(apply.disabled).toBe(true);
  expect(confirmation().disabled).toBe(true);
  expect(host.querySelector('[role="status"]')?.textContent).toContain('operation in progress');
  await act(async () => pending.resolve(record()));
  expect(host.textContent).toContain('All steps were verified. Outputs remain muted.');
});

it('shows a partial unknown outcome separately from verified and not-sent steps', async () => {
  const f = fixture({ activeReview: review() }),
    partial = record(80, 'partial');
  partial.roles[0].steps[1].state = 'failed';
  partial.roles[0].steps[2].state = 'failed';
  partial.roles[0].steps[2].attempted = false;
  f.controller.apply.mockImplementationOnce(async () => {
    f.publish({ activeReview: undefined, records: [partial] });
    return partial;
  });
  await f.render();
  await confirm();
  await click('Apply captured defaults');
  expect(host.textContent).toContain('Recorded result: partial.');
  expect(host.textContent).not.toContain('All steps were verified.');
  const ledger = host.querySelector('article ol')!;
  expect([...ledger.querySelectorAll('li strong')].map((node) => node.textContent)).toEqual([
    'Verified',
    'Unconfirmed',
    'Blocked before send',
    'Not sent',
    'Not sent',
  ]);
  expect(ledger.textContent).toContain('outcome unknown');
});

it('exports an offline recovery record and reloads history without automatically reviewing or restoring hardware', async () => {
  const saved = record(80, 'partial'),
    f = fixture({ records: [saved] });
  await f.render({ connectedRoles: [], slot: 'right' });
  expect(button('Review restore').disabled).toBe(true);
  expect(button('Download recovery JSON').disabled).toBe(false);
  await click('Download recovery JSON');
  expect(f.controller.exportRecord).toHaveBeenCalledExactlyOnceWith(saved.id, firstActor);
  expect(vi.mocked(download).mock.calls[0][0]).toBe(`fa503-defaults-${saved.id}.json`);
  expect(JSON.parse(vi.mocked(download).mock.calls[0][1])).toEqual(saved);
  await click('Reload history');
  expect(f.controller.hydrate).toHaveBeenCalledTimes(2);
  expect(f.controller.reviewDefaults).not.toHaveBeenCalled();
  expect(f.controller.reviewRecovery).not.toHaveBeenCalled();
  expect(f.controller.restore).not.toHaveBeenCalled();
  expect(f.controller.apply).not.toHaveBeenCalled();
});

it('requires a newly reviewed recovery identity and another explicit confirmation before restoring', async () => {
  const f = fixture({ records: [record()] });
  await f.render({ slot: 'right' });
  await click('Review restore');
  expect(f.controller.reviewRecovery).toHaveBeenCalledExactlyOnceWith(id(80), firstActor);
  expect(host.textContent).toContain('Restore saved settings');
  expect(button('Restore captured settings').disabled).toBe(true);
  expect(confirmation().checked).toBe(false);
  expect(f.controller.restore).not.toHaveBeenCalled();
  await f.render({ getContext: () => secondActor });
  await confirm();
  await click('Restore captured settings');
  expect(f.controller.restore).toHaveBeenCalledExactlyOnceWith(id(2), secondActor, {
    confirm: true,
  });
  expect(f.controller.apply).not.toHaveBeenCalled();
});

it('suppresses late hydration errors after context replacement and unmount and unsubscribes its observer', async () => {
  const pending = deferred<void>(),
    f = fixture(),
    next = fixture();
  f.controller.hydrate.mockImplementationOnce(() => pending.promise);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  await f.render();
  expect(f.listeners.size).toBe(1);
  await next.render();
  expect(f.listeners.size).toBe(0);
  await act(async () => pending.reject(new Error('Old controller hydration failed')));
  expect(host.textContent).not.toContain('Old controller hydration failed');
  const last = deferred<void>();
  next.controller.hydrate.mockImplementationOnce(() => last.promise);
  await next.render({ contextReady: false });
  await next.render({ contextReady: true });
  await act(async () => {
    root.unmount();
    unmounted = true;
  });
  expect(next.listeners.size).toBe(0);
  await act(async () => last.reject(new Error('Unmounted hydration failed')));
  expect(errors).not.toHaveBeenCalled();
  expect(next.controller.apply).not.toHaveBeenCalled();
});
