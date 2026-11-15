import { expect, it } from 'vitest';
import {
  createAmplifierModesController,
  AmplifierModesError,
  type AmplifierModesBinding,
} from '../src/application/amplifier-modes';
import { PanelSession, type ConfigurationBackup } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { decodeStatus, hex } from '../src/hardware/codec';
import { Sha256 } from '../src/application/file-transfers';
import type { Slot } from '../src/domain/model';
import type { Transport } from '../src/hardware/transport';

const actor = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'manual:modes' },
  ui = { ...actor, scope: 'ui:modes' };
const isSetter = (r: Uint8Array) => r[0] === 5 && r[1] === 0;
async function fixture() {
  const panels = {
      left: new SimulatedPanel('H05U-MODES-LEFT'),
      right: new SimulatedPanel('H05U-MODES-RIGHT'),
    },
    sessions = {} as Record<Slot, PanelSession>,
    bindings: Partial<Record<Slot, AmplifierModesBinding>> = {},
    events: string[] = [],
    backups: ConfigurationBackup[] = [];
  let hook:
      | ((slot: Slot, request: Uint8Array, phase: 'before' | 'after') => void | Promise<void>)
      | undefined,
    backupHook: ((slot: Slot) => void | Promise<void>) | undefined;
  for (const slot of ['left', 'right'] as const) {
    const panel = panels[slot];
    panel.status[9] = 0x19;
    panel.status[12] = 0xb1;
    panel.status[13] = 0x32;
    panel.status[14] = 0x96;
    panel.status[28] = 0xa5;
    panel.status[29] = 0x32;
    panel.status[30] = 0x72;
    panel.status[35] = 0x96;
    new DataView(panel.status.buffer).setInt16(21, -5000, true);
    const transport: Transport = {
      exchange: async (request) => {
        await hook?.(slot, request, 'before');
        if (isSetter(request)) events.push(`send:${slot}`);
        const reply = await panel.exchange(request);
        await hook?.(slot, request, 'after');
        return reply;
      },
      close: () => panel.close(),
    };
    const session = new PanelSession(transport, async () => {});
    sessions[slot] = session;
    const identity = await session.identify(),
      status = await session.status();
    bindings[slot] = { session, identity, status };
  }
  const controller = createAmplifierModesController({
    binding: (slot) => bindings[slot],
    operate: async (_label, work) => work(),
    withLock: async (_name, work) => work(),
    backup: async (session) => {
      const slot = session === sessions.left ? 'left' : 'right',
        panel = panels[slot];
      await backupHook?.(slot);
      const capture = await session.captureAmplifierModesInternal(bindings[slot]!.identity);
      const backup: ConfigurationBackup = {
        format: 'fusion-studio-configuration-backup',
        version: 1,
        id: crypto.randomUUID(),
        utc: new Date().toISOString(),
        serial: capture.identity.serial,
        product: 22,
        firmware: '5.7',
        configuration_hex: hex(panel.deviceConfiguration),
        status_hex: hex(capture.status),
        sha256: new Sha256().update(panel.deviceConfiguration).digest(),
      };
      backups.push(structuredClone(backup));
      events.push(`backup:${slot}`);
      return backup;
    },
    onStatus: (slot, session, status) => {
      if (bindings[slot]?.session === session) bindings[slot] = { ...bindings[slot]!, status };
    },
  });
  controller.refreshBindings();
  return {
    panels,
    sessions,
    bindings,
    events,
    backups,
    controller,
    hook: (fn: typeof hook) => {
      hook = fn;
    },
    backupHook: (fn: typeof backupHook) => {
      backupHook = fn;
    },
    requests: () => Object.values(panels).reduce((n, p) => n + p.requests.length, 0),
  };
}
const edit = (
  f: Awaited<ReturnType<typeof fixture>>,
  target: Slot | 'both',
  patch: { master?: boolean; bridge?: boolean; softClip?: boolean },
) =>
  f.controller.edit(target, actor, {
    expectedRevision: f.controller.getSnapshot().revision,
    patch,
  });
const review = (f: Awaited<ReturnType<typeof fixture>>, target: Slot | 'both') =>
  f.controller.review(target, actor, { expectedRevision: f.controller.getSnapshot().revision });

it('shares independent draft/preview state across UI and agent contexts without sending reports', async () => {
  const f = await fixture(),
    before = f.requests();
  edit(f, 'left', { master: false });
  edit(f, 'right', { softClip: false });
  const state = f.controller.status(ui);
  expect(state.roles.left.preview).toMatchObject({
    master: false,
    wakeOnLine: false,
    signalDetection: false,
    startupVolume: -200,
    standbyMode: 0,
  });
  expect(state.roles.right.draft).toMatchObject({ master: true, softClip: false });
  expect(f.requests()).toBe(before);
  f.controller.cancel('both', ui);
  expect(f.requests()).toBe(before);
  expect(f.controller.getSnapshot().roles.left.changed).toBe(false);
});

it('backs up all changed targets before either single setter and retains every unrelated setting', async () => {
  const f = await fixture(),
    original = { left: f.panels.left.status.slice(), right: f.panels.right.status.slice() },
    hardware = {
      left: f.panels.left.deviceConfiguration.slice(),
      right: f.panels.right.deviceConfiguration.slice(),
    };
  edit(f, 'left', { master: false });
  edit(f, 'right', { softClip: false });
  const prepared = await review(f, 'both');
  expect(f.events).toEqual([]);
  const result = await f.controller.apply(prepared.id, ui, { confirm: true });
  expect(result.complete).toBe(true);
  expect(f.events.slice(0, 2).sort()).toEqual(['backup:left', 'backup:right']);
  expect(f.events.slice(2).sort()).toEqual(['send:left', 'send:right']);
  expect(f.backups).toHaveLength(2);
  for (const slot of ['left', 'right'] as const) {
    const owned = slot === 'left' ? new Set([7, 9, 21, 22]) : new Set([9]);
    const setters = f.panels[slot].requests.filter(isSetter);
    expect(setters).toHaveLength(1);
    for (const index of [
      2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 25, 27, 28, 29,
      30, 31, 35, 36,
    ])
      if (!owned.has(index))
        expect(f.panels[slot].status[index], `${slot}:${index}`).toBe(original[slot][index]);
    expect(f.panels[slot].deviceConfiguration).toEqual(hardware[slot]);
    expect(
      f.panels[slot].requests.some(
        (r) => r[0] === 0x64 || r[0] === 8 || (r[0] === 0x66 && r[1] === 1),
      ),
    ).toBe(false);
  }
  expect(f.controller.getSnapshot().lastResult).toEqual(result);
  const count = f.requests();
  expect(await f.controller.apply(prepared.id, actor, { confirm: true })).toEqual(result);
  expect(f.requests()).toBe(count);
});

it('supports Both with one unchanged role without writing or backing up that role', async () => {
  const f = await fixture();
  edit(f, 'left', { softClip: false });
  const prepared = await review(f, 'both');
  expect(prepared.roles[1].patch).toEqual({});
  const result = await f.controller.apply(prepared.id, actor, { confirm: true });
  expect(result.roles.map((r) => r.state)).toEqual(['verified', 'unchanged']);
  expect(f.backups).toHaveLength(1);
  expect(f.panels.right.requests.filter(isSetter)).toHaveLength(0);
});

it('rejects invalid edits, stale revisions, duplicate physical roles and foreign ownership without setters', async () => {
  const f = await fixture();
  expect(() => edit(f, 'left', { volume: 0 } as never)).toThrow('valid amplifier mode');
  expect(() =>
    f.controller.edit('left', actor, { expectedRevision: 0, patch: { master: false } }),
  ).toThrow('revision');
  expect(() =>
    f.controller.status({ ...actor, owner: 'workspace:22222222-2222-4222-8222-222222222222' }),
  ).toThrow('another workspace');
  f.bindings.right = f.bindings.left;
  expect(() => edit(f, 'both', { softClip: false })).toThrow('distinct physical');
  expect(f.events).toEqual([]);
});

it('rejects locked-target permissions across Both before any backup or setter', async () => {
  const f = await fixture();
  edit(f, 'both', { softClip: false });
  const prepared = await review(f, 'both');
  f.panels.right.status[51] = 2;
  await expect(f.controller.apply(prepared.id, actor, { confirm: true })).rejects.toBeInstanceOf(
    AmplifierModesError,
  );
  expect(f.backups).toHaveLength(0);
  expect(f.events).toEqual([]);
});

it('rejects a changed owned dependency before writes and rebases unrelated fresh runtime/LED fields', async () => {
  const stale = await fixture();
  edit(stale, 'left', { master: false });
  const token = await review(stale, 'left');
  new DataView(stale.panels.left.status.buffer).setInt16(21, -3300, true);
  await expect(stale.controller.apply(token.id, actor, { confirm: true })).rejects.toThrow(
    'dependent settings changed',
  );
  expect(stale.events).toEqual([]);
  const f = await fixture();
  edit(f, 'both', { softClip: false });
  const prepared = await review(f, 'both');
  f.backupHook((slot) => {
    f.panels[slot].status[35] = 0x51;
    new DataView(f.panels[slot].status.buffer).setInt16(3, -4200, true);
  });
  const result = await f.controller.apply(prepared.id, actor, { confirm: true });
  expect(result.complete).toBe(true);
  for (const p of Object.values(f.panels)) {
    expect(p.status[35]).toBe(0x51);
    expect(decodeStatus(p.status).volume).toBe(-42);
  }
});

it('a failed backup blocks every setter, and a replacement session is never targeted', async () => {
  const f = await fixture();
  edit(f, 'both', { softClip: false });
  const prepared = await review(f, 'both');
  f.backupHook((slot) => {
    if (slot === 'right') throw new Error('Persistence unavailable');
  });
  await expect(f.controller.apply(prepared.id, actor, { confirm: true })).rejects.toThrow(
    'Persistence unavailable',
  );
  expect(f.events.filter((e) => e.startsWith('send'))).toEqual([]);
  const g = await fixture();
  edit(g, 'both', { softClip: false });
  const token = await review(g, 'both'),
    replacement = new SimulatedPanel(g.panels.right.serial),
    replacementSession = new PanelSession(replacement, async () => {});
  g.backupHook((slot) => {
    if (slot === 'left') g.bindings.right = { ...g.bindings.right!, session: replacementSession };
  });
  await expect(g.controller.apply(token.id, actor, { confirm: true })).rejects.toThrow(
    'replacement was not targeted',
  );
  expect(replacement.requests).toHaveLength(0);
  expect(g.events.filter((e) => e.startsWith('send'))).toEqual([]);
});

it('lost acknowledgements retain a shared partial outcome and consumed replay performs no I/O', async () => {
  const f = await fixture();
  edit(f, 'both', { softClip: false });
  const prepared = await review(f, 'both');
  let lost = false;
  f.hook((slot, r, phase) => {
    if (!lost && slot === 'right' && isSetter(r) && phase === 'after') {
      lost = true;
      throw new Error('SIMULATED applied, ACK lost');
    }
  });
  let result: unknown;
  try {
    await f.controller.apply(prepared.id, actor, { confirm: true });
  } catch (e) {
    result = (e as AmplifierModesError).result;
  }
  expect(result).toMatchObject({
    complete: false,
    partial: true,
    roles: [
      { state: 'verified', attempted: true },
      { state: 'unconfirmed', attempted: true },
    ],
  });
  expect(f.controller.status(ui).lastResult).toEqual(result);
  const count = f.requests();
  await expect(f.controller.apply(prepared.id, ui, { confirm: true })).rejects.toBeInstanceOf(
    AmplifierModesError,
  );
  expect(f.requests()).toBe(count);
});

it('holds every sender until all final fresh permission checks pass', async () => {
  const f = await fixture();
  edit(f, 'both', { softClip: false });
  const prepared = await review(f, 'both');
  let rightStatusReads = 0;
  f.hook((slot, request, phase) => {
    if (
      slot === 'right' &&
      phase === 'before' &&
      request[0] === 5 &&
      request[1] === 1 &&
      ++rightStatusReads === 4
    )
      f.panels.right.status[51] = 2;
  });
  await expect(f.controller.apply(prepared.id, actor, { confirm: true })).rejects.toBeInstanceOf(
    AmplifierModesError,
  );
  expect(rightStatusReads).toBe(4);
  expect(f.backups).toHaveLength(2);
  expect(f.events.filter((event) => event.startsWith('send'))).toEqual([]);
  expect(f.controller.getSnapshot().lastResult).toMatchObject({
    complete: false,
    partial: false,
    roles: [{ attempted: false }, { attempted: false }],
  });
});

it('cancels before setters and completes bounded verification after the first sender', async () => {
  const f = await fixture(),
    beforeCancel = new AbortController();
  edit(f, 'left', { softClip: false });
  const prepared = await review(f, 'left');
  beforeCancel.abort();
  await expect(
    f.controller.apply(prepared.id, { ...actor, signal: beforeCancel.signal }, { confirm: true }),
  ).rejects.toThrow();
  expect(f.events).toEqual([]);
  const g = await fixture(),
    afterStart = new AbortController();
  edit(g, 'both', { softClip: false });
  const token = await review(g, 'both');
  g.hook((_slot, r, phase) => {
    if (isSetter(r) && phase === 'after') afterStart.abort();
  });
  expect(
    (await g.controller.apply(token.id, { ...actor, signal: afterStart.signal }, { confirm: true }))
      .complete,
  ).toBe(true);
  expect(g.events.filter((e) => e.startsWith('send'))).toHaveLength(2);
});
