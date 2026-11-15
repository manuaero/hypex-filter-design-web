import { beforeEach, expect, it, vi } from 'vitest';
import {
  createNativeLimiterController,
  nativeLimiterSnapshotPage,
  NativeLimiterError,
} from '../src/application/native-limiter';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { encodeLimiter, decodeLimiter } from '../src/hardware/device-settings';
import { saveConfigurationBackup } from '../src/hardware/storage';
import type { Slot } from '../src/domain/model';
import type { Transport } from '../src/hardware/transport';

vi.mock('../src/hardware/storage', () => ({ saveConfigurationBackup: vi.fn(async () => {}) }));
beforeEach(() => {
  vi.mocked(saveConfigurationBackup).mockReset().mockResolvedValue(undefined);
});
const actor = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'manual:limiter' },
  ui = { ...actor, scope: 'ui:limiter' },
  other = { owner: 'workspace:22222222-2222-4222-8222-222222222222', scope: 'manual:foreign' };
const setters = (p: SimulatedPanel) =>
  p.requests.filter((r) => (r[0] === 5 && r[1] === 0) || (r[0] === 0x66 && r[1] === 1));
async function fixture() {
  const panels = {
      left: new SimulatedPanel('NATIVE-LIMITER-LEFT'),
      right: new SimulatedPanel('NATIVE-LIMITER-RIGHT'),
    },
    sessions = {} as Record<Slot, PanelSession>,
    bindings = {} as Record<
      Slot,
      { session: PanelSession; identity: NonNullable<PanelSession['identity']> }
    >,
    intercept: Partial<
      Record<Slot, (request: Uint8Array, send: () => Promise<Uint8Array>) => Promise<Uint8Array>>
    > = {};
  for (const slot of ['left', 'right'] as const) {
    const p = panels[slot];
    p.status[6] = 0;
    p.deviceConfiguration[13] = 1;
    p.deviceConfiguration = encodeLimiter(
      decodeLimiter(p.deviceConfiguration),
      Array.from({ length: 3 }, () => ({ watts: 25, ohms: 4, attackMs: 10, releaseMs: 37.5 })),
      false,
    );
    p.deviceConfiguration[1] = 0;
    const transport: Transport = {
      exchange: (request) =>
        intercept[slot]?.(request, () => p.exchange(request)) ?? p.exchange(request),
      close: () => p.close(),
    };
    sessions[slot] = new PanelSession(transport, async () => {});
    bindings[slot] = { session: sessions[slot], identity: await sessions[slot].identify() };
    p.requests.length = 0;
  }
  const locks: string[] = [],
    operate = vi.fn(async (_label: string, work: () => Promise<unknown>) => work()),
    options = {
      binding: (slot: Slot) => bindings[slot],
      operate: operate as <T>(label: string, work: () => Promise<T>) => Promise<T>,
      withLock: async <T>(_name: string, work: () => Promise<T>) => {
        locks.push('held');
        try {
          return await work();
        } finally {
          locks.pop();
        }
      },
    },
    controller = createNativeLimiterController(options);
  const edit = (slot: Slot, watts: number) =>
    controller.edit(slot, actor, {
      expectedRevision: controller.status(actor).revision,
      action: { type: 'power', channel: 0, value: watts },
    });
  const review = (target: Slot | 'both') =>
    controller.review(target, actor, { expectedRevision: controller.status(actor).revision });
  return {
    panels,
    sessions,
    bindings,
    intercept,
    controller,
    options,
    locks,
    operate,
    edit,
    review,
  };
}

it('loads/edits independent native drafts without setters, exposes only bounded metadata, and keeps status at zero I/O', async () => {
  const f = await fixture();
  await f.controller.load('both', actor);
  const before = f.controller.status(actor),
    right = structuredClone(before.roles.right.draft);
  f.controller.edit('left', ui, {
    expectedRevision: before.revision,
    action: { type: 'attack-time', value: 2.3 },
  });
  expect(f.controller.status(actor).roles.left.preview!.channels[0].attackWord).toBe(16594848);
  expect(f.controller.status(actor).roles.right.draft).toEqual(right);
  const requests = f.panels.left.requests.length + f.panels.right.requests.length;
  f.controller.status(ui);
  nativeLimiterSnapshotPage(f.controller.status(actor));
  expect(f.panels.left.requests.length + f.panels.right.requests.length).toBe(requests);
  const serialized = JSON.stringify(nativeLimiterSnapshotPage(f.controller.status(actor)));
  expect(serialized).not.toMatch(/sourceHex|"request"|configuration_hex/);
  expect(serialized.length).toBeLessThan(32000);
  for (const p of Object.values(f.panels)) expect(setters(p)).toHaveLength(0);
  expect(saveConfigurationBackup).not.toHaveBeenCalled();
});

it('retains partial expert typing, rejects its review before USB, and enforces atomic edit revision fences', async () => {
  const f = await fixture();
  await f.controller.load('both', actor);
  f.controller.edit('left', actor, {
    expectedRevision: f.controller.status(actor).revision,
    action: { type: 'expert-mode', value: true },
  });
  f.controller.edit('left', actor, {
    expectedRevision: f.controller.status(actor).revision,
    action: { type: 'expert-text', channel: 0, field: 'attack', text: '-' },
  });
  expect(f.controller.status(actor).roles.left.draft!.channels[0].attackText).toBe('-');
  expect(f.controller.status(actor).roles.left.preview).toBeUndefined();
  const before = structuredClone(f.controller.status(actor)),
    requests = f.panels.left.requests.length;
  await expect(f.review('left')).rejects.toBeInstanceOf(NativeLimiterError);
  expect(f.panels.left.requests).toHaveLength(requests);
  expect(() =>
    f.controller.edit('both', actor, {
      expectedRevision: before.revision - 1,
      action: { type: 'power', channel: 0, value: 100 },
    }),
  ).toThrow('revision');
  expect(f.controller.status(actor).roles).toEqual(before.roles);
});

it('backs up BOTH before the common mute, writes each role’s own reviewed target exactly once, and replays same-owner receipts without I/O', async () => {
  const f = await fixture();
  await f.controller.load('both', actor);
  f.edit('left', 100);
  f.edit('right', 50);
  const review = await f.review('both');
  expect(review.roles.map((r) => r.after[0].watts)).toEqual([100, 50]);
  const saved = new Set<string>();
  vi.mocked(saveConfigurationBackup).mockImplementation(async (backup) => {
    expect(f.sessions.left.busy && f.sessions.right.busy).toBe(true);
    saved.add(backup.serial);
  });
  for (const slot of ['left', 'right'] as const)
    f.intercept[slot] = async (request, send) => {
      if ((request[0] === 5 && request[1] === 0) || (request[0] === 0x66 && request[1] === 1)) {
        expect(saved.size).toBe(2);
        expect(f.locks).toEqual(['held']);
      }
      return send();
    };
  const result = await f.controller.apply(review.id, ui, { confirm: true });
  expect(result.complete).toBe(true);
  expect(
    result.roles.every(
      (r) => r.backupId && r.steps.every((s) => s.verified && s.attempted) && r.lastConfirmedMuted,
    ),
  ).toBe(true);
  expect(decodeLimiter(f.panels.left.deviceConfiguration).channels[0].watts).toBe(100);
  expect(decodeLimiter(f.panels.right.deviceConfiguration).channels[0].watts).toBe(50);
  for (const p of Object.values(f.panels)) expect(setters(p)).toHaveLength(2);
  const requests = f.panels.left.requests.length + f.panels.right.requests.length;
  expect(await f.controller.apply(review.id, actor, { confirm: true })).toEqual(result);
  expect(f.panels.left.requests.length + f.panels.right.requests.length).toBe(requests);
  expect(saveConfigurationBackup).toHaveBeenCalledTimes(2);
});

it('refuses foreign owners and invalidates reviews on edits or binding replacement without sending setters', async () => {
  const f = await fixture();
  await f.controller.load('left', actor);
  const review = await f.review('left');
  await expect(f.controller.apply(review.id, other, { confirm: true })).rejects.toThrow(
    'another workspace',
  );
  f.edit('left', 50);
  await expect(f.controller.apply(review.id, actor, { confirm: true })).rejects.toThrow('stale');
  const next = await f.review('left');
  f.bindings.left = f.bindings.right;
  f.controller.refreshBindings();
  await expect(f.controller.apply(next.id, actor, { confirm: true })).rejects.toThrow('stale');
  for (const p of Object.values(f.panels)) expect(setters(p)).toHaveLength(0);
});

it('refuses duplicate sessions/serials and stale live bridge/configuration before any setter', async () => {
  const f = await fixture();
  f.bindings.right = f.bindings.left;
  await expect(f.controller.load('both', actor)).rejects.toThrow('distinct');
  await f.controller.load('left', actor);
  const review = await f.review('left');
  f.panels.left.status[9] ^= 2;
  await expect(f.controller.apply(review.id, actor, { confirm: true })).rejects.toMatchObject({
    result: { complete: false, partial: false },
  });
  expect(setters(f.panels.left)).toHaveLength(0);
  expect(saveConfigurationBackup).not.toHaveBeenCalled();
});

it.each(['failure', 'right-lock', 'right-configuration'] as const)(
  'blocks all setters when the last backup has %s',
  async (kind) => {
    const f = await fixture();
    await f.controller.load('both', actor);
    const review = await f.review('both');
    vi.mocked(saveConfigurationBackup).mockImplementation(async (backup) => {
      if (backup.serial !== f.panels.right.serial) return;
      if (kind === 'failure') throw new Error('Backup persistence readback failed');
      if (kind === 'right-lock') {
        f.panels.right.status[51] = 2;
        f.panels.right.deviceConfiguration[11] = 1;
        f.panels.right.status[24] = 8;
      } else f.panels.right.deviceConfiguration[20] ^= 1;
    });
    await expect(f.controller.apply(review.id, actor, { confirm: true })).rejects.toMatchObject({
      result: { complete: false, partial: false },
    });
    for (const p of Object.values(f.panels)) expect(setters(p)).toHaveLength(0);
    expect(
      f.controller
        .status(actor)
        .lastResult!.roles.every((r) => r.steps.every((s) => !s.attempted && !s.verified)),
    ).toBe(true);
  },
);

it('accepts the exact OEM settings+limiter intersection without applying the Defaults absolute lock policy', async () => {
  const f = await fixture();
  for (const p of Object.values(f.panels)) {
    p.status[51] = 2;
    p.deviceConfiguration[11] = 1;
    p.status[24] = 8 | 16;
  }
  await f.controller.load('both', actor);
  const review = await f.review('both');
  expect((await f.controller.apply(review.id, ui, { confirm: true })).complete).toBe(true);
  for (const p of Object.values(f.panels)) {
    expect(p.status[51]).toBe(2);
    expect(setters(p)).toHaveLength(2);
  }
});

it('aborts during the last fresh readiness capture with zero setters on BOTH', async () => {
  const f = await fixture();
  await f.controller.load('both', actor);
  const review = await f.review('both'),
    abort = new AbortController();
  let backups = 0;
  vi.mocked(saveConfigurationBackup).mockImplementation(async () => {
    backups++;
  });
  f.intercept.left = async (request, send) => {
    const reply = await send();
    if (backups === 2 && request[0] === 5 && request[1] === 1) abort.abort();
    return reply;
  };
  await expect(
    f.controller.apply(review.id, { ...actor, signal: abort.signal }, { confirm: true }),
  ).rejects.toMatchObject({ result: { partial: false } });
  for (const p of Object.values(f.panels)) expect(setters(p)).toHaveLength(0);
  expect(f.controller.status(actor).lastResult!.roles.every((r) => !r.steps[0].attempted)).toBe(
    true,
  );
});

it('finishes bounded paired verification when cancellation arrives after the first mute begins', async () => {
  const f = await fixture();
  await f.controller.load('both', actor);
  const review = await f.review('both'),
    abort = new AbortController();
  for (const slot of ['left', 'right'] as const)
    f.intercept[slot] = async (request, send) => {
      if (request[0] === 5 && request[1] === 0) abort.abort();
      return send();
    };
  expect(
    (await f.controller.apply(review.id, { ...actor, signal: abort.signal }, { confirm: true }))
      .complete,
  ).toBe(true);
  for (const p of Object.values(f.panels)) expect(setters(p)).toHaveLength(2);
});

it('retains a per-role lost-ACK ledger and never repeats its consumed request', async () => {
  const f = await fixture();
  await f.controller.load('both', actor);
  const review = await f.review('both');
  f.intercept.right = async (request, send) => {
    const reply = await send();
    if (request[0] === 0x66 && request[1] === 1) throw new Error('Lost limiter ACK');
    return reply;
  };
  await expect(f.controller.apply(review.id, actor, { confirm: true })).rejects.toMatchObject({
    result: { partial: true, complete: false },
  });
  const result = f.controller.status(actor).lastResult!;
  expect(result.roles[0].steps[1]).toMatchObject({ verified: true, attempted: true });
  expect(result.roles[1].steps[1]).toMatchObject({ verified: false, attempted: true });
  const requests = f.panels.left.requests.length + f.panels.right.requests.length;
  await expect(f.controller.apply(review.id, ui, { confirm: true })).rejects.toBeInstanceOf(
    NativeLimiterError,
  );
  expect(f.panels.left.requests.length + f.panels.right.requests.length).toBe(requests);
  for (const p of Object.values(f.panels)) expect(setters(p)).toHaveLength(2);
});

it('rejects an exact-66 readback mismatch without another setter or a false verified receipt', async () => {
  const f = await fixture();
  await f.controller.load('left', actor);
  const review = await f.review('left');
  let configured = false,
    corrupted = false;
  f.intercept.left = async (request, send) => {
    const response = await send();
    if (request[0] === 0x66 && request[1] === 1) configured = true;
    else if (configured && !corrupted && request[0] === 0x66) {
      response[20] ^= 1;
      corrupted = true;
    }
    return response;
  };
  await expect(f.controller.apply(review.id, actor, { confirm: true })).rejects.toMatchObject({
    result: {
      complete: false,
      partial: true,
      roles: [{ steps: [{ verified: true }, { verified: false, attempted: true }] }],
    },
  });
  expect(setters(f.panels.left)).toHaveLength(2);
});

it('fails closed at 32 consumed session receipts and rejects old tokens after reload without I/O', async () => {
  const f = await fixture(),
    rejectOperation = vi.fn(async () => {
      throw new Error('Another application operation is running');
    }),
    controller = createNativeLimiterController({ ...f.options, operate: rejectOperation });
  await controller.load('left', actor);
  let firstId = '';
  for (let i = 0; i < 32; i++) {
    const review = await controller.review('left', actor, {
      expectedRevision: controller.status(actor).revision,
    });
    firstId ||= review.id;
    await expect(controller.apply(review.id, actor, { confirm: true })).rejects.toBeInstanceOf(
      NativeLimiterError,
    );
  }
  const final = await controller.review('left', actor, {
      expectedRevision: controller.status(actor).revision,
    }),
    requests = f.panels.left.requests.length;
  await expect(controller.apply(final.id, ui, { confirm: true })).rejects.toThrow('32 consumed');
  expect(rejectOperation).toHaveBeenCalledTimes(32);
  const reloaded = createNativeLimiterController(f.options);
  await expect(reloaded.apply(firstId, actor, { confirm: true })).rejects.toThrow(
    'does not resume',
  );
  expect(f.panels.left.requests).toHaveLength(requests);
  expect(setters(f.panels.left)).toHaveLength(0);
});

it('confirms mute with a fresh post-66 status and reports its loss without another setter', async () => {
  const f = await fixture();
  await f.controller.load('left', actor);
  const review = await f.review('left');
  let configured = false;
  f.intercept.left = async (request, send) => {
    const reply = await send();
    if (request[0] === 0x66 && request[1] === 1) configured = true;
    if (configured && request[0] === 5 && request[1] === 1) {
      f.panels.left.status[6] &= 127;
      reply[6] &= 127;
    }
    return reply;
  };
  await expect(f.controller.apply(review.id, actor, { confirm: true })).rejects.toMatchObject({
    result: { roles: [{ lastConfirmedMuted: false }] },
  });
  expect(setters(f.panels.left)).toHaveLength(2);
});

it('retains freshly confirmed On when a second stale review is blocked before setters', async () => {
  const f = await fixture();
  await f.controller.load('both', actor);
  const initial = await f.review('both');
  expect(
    (await f.controller.apply(initial.id, ui, { confirm: true })).roles.every(
      (role) => role.lastConfirmedMuted === true,
    ),
  ).toBe(true);
  const stale = await f.review('both'),
    before = Object.values(f.panels).reduce((n, p) => n + setters(p).length, 0);
  f.panels.left.deviceConfiguration[20] ^= 1;
  await expect(f.controller.apply(stale.id, actor, { confirm: true })).rejects.toMatchObject({
    result: { complete: false, partial: false },
  });
  expect(Object.values(f.panels).reduce((n, p) => n + setters(p).length, 0)).toBe(before);
  expect(
    f.controller.status(actor).lastResult!.roles.map((role) => role.lastConfirmedMuted),
  ).toEqual([true, true]);
});

it('reports Unknown rather than Off when applying never reaches a fresh device read', async () => {
  const f = await fixture(),
    controller = createNativeLimiterController({
      ...f.options,
      operate: async () => {
        throw new Error('Another application operation is running');
      },
    });
  await controller.load('left', actor);
  const review = await controller.review('left', actor, {
      expectedRevision: controller.status(actor).revision,
    }),
    before = f.panels.left.requests.length;
  await expect(controller.apply(review.id, actor, { confirm: true })).rejects.toMatchObject({
    result: { roles: [{ lastConfirmedMuted: null }] },
  });
  expect(f.panels.left.requests).toHaveLength(before);
  expect(controller.status(actor).lastResult!.roles[0].lastConfirmedMuted).toBeNull();
  expect(setters(f.panels.left)).toHaveLength(0);
});

it('retains the old target ledger while a late replacement cannot receive its completed draft publication', async () => {
  const f = await fixture();
  await f.controller.load('left', actor);
  const review = await f.review('left');
  const replacementPanel = new SimulatedPanel('REPLACEMENT-LIMITER'),
    replacement = new PanelSession(replacementPanel, async () => {}),
    identity = await replacement.identify();
  let configured = false;
  f.intercept.left = async (request, send) => {
    const reply = await send();
    if (request[0] === 0x66 && request[1] === 1) configured = true;
    if (configured && request[0] === 5 && request[1] === 1) {
      f.bindings.left = { session: replacement, identity };
      f.controller.refreshBindings();
    }
    return reply;
  };
  const result = await f.controller.apply(review.id, actor, { confirm: true });
  expect(result.complete).toBe(true);
  expect(result.roles[0]).toMatchObject({
    identity: { serial: f.panels.left.serial },
    stale: true,
  });
  expect(f.controller.status(actor).roles.left.identity!.serial).toBe(replacementPanel.serial);
  expect(f.controller.status(actor).roles.left.draft).toBeUndefined();
  expect(setters(replacementPanel)).toHaveLength(0);
});
