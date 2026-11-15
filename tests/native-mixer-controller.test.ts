import { expect, it, vi } from 'vitest';
import {
  createNativeMixerController,
  NativeMixerError,
  type NativeMixerControllerOptions,
  type NativeMixerBinding,
} from '../src/application/native-mixer';
import {
  assertNativeMixerWrite,
  type NativeMixerJournalEnvelope,
  type NativeMixerStorage,
} from '../src/application/native-mixer-storage';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { decodeNativeMixer } from '../src/hardware/native-mixer';
import type { Slot } from '../src/domain/model';
import type { Transport } from '../src/hardware/transport';

const actor = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'manual:mixer' },
  ui = { ...actor, scope: 'ui:mixer' },
  foreign = { owner: 'workspace:22222222-2222-4222-8222-222222222222', scope: 'manual:foreign' };
const setters = (panel: SimulatedPanel) =>
  panel.requests.filter((r) => r[0] === 0x67 && r[1] === 1);
const anySetters = (panel: SimulatedPanel) =>
  panel.requests.filter(
    (r) =>
      (r[0] === 0x67 && r[1] === 1) ||
      (r[0] === 5 && r[1] === 0) ||
      (r[0] === 0x66 && r[1] === 1) ||
      r[0] === 0x64,
  );
const identifier = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
function memory() {
  let value: NativeMixerJournalEnvelope = { version: 1, revision: 0, records: [] };
  const hooks = {
    before: undefined as undefined | ((next: NativeMixerJournalEnvelope) => void | Promise<void>),
    after: undefined as undefined | ((next: NativeMixerJournalEnvelope) => void | Promise<void>),
    failRead: false,
  };
  const storage: NativeMixerStorage = {
    read: vi.fn(async () => {
      if (hooks.failRead) throw new Error('Injected journal read failure');
      return structuredClone(value);
    }),
    compareAndSwap: vi.fn(async (expected, next) => {
      await hooks.before?.(next);
      assertNativeMixerWrite(value, expected, next);
      value = structuredClone(next);
      await hooks.after?.(next);
    }),
  };
  return {
    storage,
    hooks,
    get value() {
      return structuredClone(value);
    },
  };
}
async function fixture(cached = true) {
  const panels = {
      left: new SimulatedPanel('SYNTHETIC-MIXER-LEFT'),
      right: new SimulatedPanel('SYNTHETIC-MIXER-RIGHT'),
    },
    sessions = {} as Record<Slot, PanelSession>,
    bindings = {} as Record<Slot, NativeMixerBinding>,
    intercept: Partial<
      Record<Slot, (request: Uint8Array, send: () => Promise<Uint8Array>) => Promise<Uint8Array>>
    > = {};
  for (const slot of ['left', 'right'] as const) {
    const panel = panels[slot];
    panel.configuration[4] = 2;
    panel.configuration[5] = panel.configuration[12] = 3;
    panel.deviceConfiguration[11] = 1;
    panel.deviceConfiguration[14] = 128;
    const words = [
        1, 32, -32, 127, -127, 512, -32768, 32767, -1, 0, 256, -256, 1234, -4321, 100, 200, -300,
        400,
      ],
      v = new DataView(panel.mixerConfiguration.buffer);
    words.forEach((word, i) => v.setInt16(2 + i * 2, word, true));
    panel.mixerConfiguration.fill(0xa5, 38);
    const transport: Transport = {
      exchange: (r) => intercept[slot]?.(r, () => panel.exchange(r)) ?? panel.exchange(r),
      close: () => panel.close(),
    };
    sessions[slot] = new PanelSession(transport, async () => {
      throw new Error('Generic flash backup must not run');
    });
    bindings[slot] = {
      session: sessions[slot],
      identity: cached
        ? await sessions[slot].identify()
        : {
            serial: slot === 'left' ? 'SYNTHETIC-MIXER-LEFT' : 'SYNTHETIC-MIXER-RIGHT',
            product: 22,
            core: '5.1',
            firmware: '5.7',
          },
    };
    panel.requests.length = 0;
  }
  const db = memory();
  let sequence = 0,
    tail = Promise.resolve();
  const operate = vi.fn(async (_label: string, work: () => Promise<unknown>) => work()),
    options: NativeMixerControllerOptions = {
      binding: (slot) => bindings[slot],
      storage: db.storage,
      operate: operate as NativeMixerControllerOptions['operate'],
      id: () => identifier(++sequence),
      now: () => 100,
      withLock: async <T>(_name: string, work: () => Promise<T>) => {
        const before = tail;
        let release!: () => void;
        tail = new Promise<void>((r) => {
          release = r;
        });
        await before;
        try {
          return await work();
        } finally {
          release();
        }
      },
    },
    controller = createNativeMixerController(options),
    edit = (
      slot: Slot,
      value: number,
      preset: 1 | 2 | 3 = 1,
      channel: 1 | 2 | 3 = 1,
      input: 'left' | 'right' = 'left',
    ) =>
      controller.edit(slot, actor, {
        expectedRevision: controller.status(actor).revision,
        preset,
        channel,
        input,
        value,
      }),
    review = (target: Slot | 'both' = 'left', preset: 1 | 2 | 3 = 1) =>
      controller.review(target, actor, {
        expectedRevision: controller.status(actor).revision,
        preset,
      });
  return { panels, sessions, bindings, intercept, db, controller, options, operate, edit, review };
}

it('keeps cached status and commercial/unknown eligibility at zero I/O; explicit first load publishes fresh capability', async () => {
  const f = await fixture(false);
  expect(f.controller.status(ui).roles.left.availability).toBeUndefined();
  const same = f.controller.getSnapshot();
  f.controller.status(actor);
  expect(f.controller.getSnapshot()).toBe(same);
  for (const panel of Object.values(f.panels)) expect(panel.requests).toHaveLength(0);
  await f.controller.load('left', ui, { preset: 1 });
  expect(f.controller.status(actor).roles.left).toMatchObject({
    canEdit: true,
    availability: { editorAvailable: true, enabled: true },
  });
  expect(anySetters(f.panels.left)).toHaveLength(0);
  f.panels.right.deviceConfiguration[11] = 9;
  await f.sessions.right.identify();
  f.panels.right.requests.length = 0;
  f.controller.refreshBindings();
  expect(f.controller.status(ui).roles.right).toMatchObject({
    canEdit: false,
    availability: { editorAvailable: false },
  });
  expect(f.panels.right.requests).toHaveLength(0);
  await expect(f.controller.load('right', actor, { preset: 1 })).rejects.toThrow(/OEM/);
  expect(f.panels.right.requests.filter((r) => r[0] === 0x67)).toHaveLength(0);
});

it('opens only the selected row through native Text normalization and preserves inactive raw out-of-range words', async () => {
  const f = await fixture();
  await f.controller.load('left', actor, { preset: 1 });
  const role = f.controller.status(ui).roles.left;
  expect(role.current![0]).toEqual([1 / 256, 0.125, -0.125, 127 / 256, -127 / 256, 2]);
  expect(role.draft![0]).toEqual([0, Math.fround(0.13), Math.fround(-0.13), 0.5, -0.5, 1]);
  expect(role.preview![0]).toEqual([0, 33 / 256, -34 / 256, 0.5, -0.5, 1]);
  expect(role.draft![1]).toEqual([-128, 32767 / 256, -1 / 256, 0, 1, -1]);
  f.edit('left', 0.125);
  expect(f.controller.status(actor).roles.left.draft![0][0]).toBe(Math.fround(0.13));
  f.edit('left', -0.125, 1, 1, 'right');
  expect(f.controller.status(actor).roles.left.preview![0].slice(0, 2)).toEqual([
    33 / 256,
    -34 / 256,
  ]);
  f.edit('left', 0.105);
  expect(f.controller.status(actor).roles.left.draft![0][0]).toBe(Math.fround(0.11));
  expect(f.controller.status(actor).roles.left.draft![0][1]).toBe(Math.fround(-0.13));
  for (const invalid of [1.01, -1.01, NaN, Infinity])
    expect(() => f.edit('left', invalid)).toThrow(/finite mixer weight/);
  expect(anySetters(f.panels.left)).toHaveLength(0);
});

it('keeps independent role/preset drafts; Cancel restores the current raw row and closes only that row', async () => {
  const f = await fixture();
  await f.controller.load('both', actor, { preset: 1 });
  f.edit('left', 0.21);
  f.controller.open('left', actor, {
    expectedRevision: f.controller.status(actor).revision,
    preset: 3,
  });
  f.edit('left', -0.31, 3);
  const third = structuredClone(f.controller.status(actor).roles.left.draft![2]),
    right = structuredClone(f.controller.status(actor).roles.right.draft);
  f.controller.cancel('left', ui, { preset: 1 });
  const state = f.controller.status(actor);
  expect(state.roles.left.draft![0]).toEqual(state.roles.left.current![0]);
  expect(state.roles.left.openedPresets).toEqual([false, false, true]);
  expect(state.roles.left.draft![2]).toEqual(third);
  expect(state.roles.right.draft).toEqual(right);
  await expect(f.review()).rejects.toThrow(/Open/);
  expect(anySetters(f.panels.left)).toHaveLength(0);
});

it('saves both independent drafts only after all originals/intents are verified; retains inactive words and every non-mixer byte', async () => {
  const f = await fixture();
  await f.controller.load('both', actor, { preset: 1 });
  f.edit('left', 0.1);
  f.edit('right', -0.1);
  f.controller.open('left', actor, {
    expectedRevision: f.controller.status(actor).revision,
    preset: 3,
  });
  f.edit('left', 0.37, 3);
  const third = structuredClone(f.controller.status(actor).roles.left.draft![2]),
    before = Object.fromEntries(
      Object.entries(f.panels).map(([s, p]) => [
        s,
        {
          status: p.status.slice(),
          config: p.deviceConfiguration.slice(),
          mixer: p.mixerConfiguration.slice(),
          eeprom: p.eeprom.slice(),
          flash: p.memory.slice(),
        },
      ]),
    );
  const r = await f.review('both');
  for (const slot of ['left', 'right'] as const)
    f.intercept[slot] = async (req, send) => {
      if (req[0] === 0x67 && req[1] === 1) {
        const record = f.db.value.records[0];
        expect(record.roles.map((role) => role.state)).toEqual(['intent', 'intent']);
        expect(record.roles.every((role) => !role.attempted)).toBe(true);
      }
      return send();
    };
  const result = await f.controller.save(r.id, ui, { confirm: true });
  expect(result).toMatchObject({ complete: true, partial: false, persistence: 'verified' });
  expect(decodeNativeMixer(f.panels.left.mixerConfiguration)[0][0]).toBe(25 / 256);
  expect(decodeNativeMixer(f.panels.right.mixerConfiguration)[0][0]).toBe(-26 / 256);
  for (const slot of ['left', 'right'] as const) {
    const p = f.panels[slot],
      b = before[slot];
    expect(setters(p)).toHaveLength(1);
    const expectedEeprom = b.eeprom.slice();
    expectedEeprom.set(p.mixerConfiguration.slice(2, 38), 0xd0);
    expect(p.status).toEqual(b.status);
    expect(p.deviceConfiguration).toEqual(b.config);
    expect(p.eeprom).toEqual(expectedEeprom);
    expect(p.memory).toEqual(b.flash);
    expect(Array.from(p.mixerConfiguration.slice(14, 38))).toEqual(
      Array.from(b.mixer.slice(14, 38)),
    );
    expect(anySetters(p)).toHaveLength(1);
  }
  const state = f.controller.status(actor);
  expect(state.roles.left.openedPresets).toEqual([false, false, true]);
  expect(state.roles.left.draft![2]).toEqual(third);
  expect(state.lastResult).toEqual(result);
  expect(f.controller.exportRecord(r.id, actor).exportPersistence).toBe('verified');
  const n = f.panels.left.requests.length + f.panels.right.requests.length;
  expect(await f.controller.save(r.id, actor, { confirm: true })).toMatchObject({
    ...result,
    replayed: true,
  });
  expect(f.panels.left.requests.length + f.panels.right.requests.length).toBe(n);
});

it('checks an unchanged selected peer again after durable intent and blocks the changed role if that peer loses permission', async () => {
  const f = await fixture();
  // Exact editor-stable zero row leaves Right unchanged when the row opens.
  f.panels.right.mixerConfiguration.fill(0, 2, 14);
  await f.controller.load('both', actor, { preset: 1 });
  f.edit('left', 0.2);
  const r = await f.review('both');
  expect(r.roles.map((role) => role.changed)).toEqual([true, false]);
  f.db.hooks.after = (next) => {
    if (next.records[0]?.roles[0].state === 'intent') {
      f.panels.right.status[51] = 2;
      f.panels.right.status[24] = f.panels.right.status[25] = 0;
    }
  };
  await expect(f.controller.save(r.id, ui, { confirm: true })).rejects.toMatchObject({
    result: { complete: false, partial: false, persistence: 'verified' },
  });
  for (const p of Object.values(f.panels)) expect(anySetters(p)).toHaveLength(0);
  expect(f.db.value.records[0].phase).toBe('failed');
});

it('skips the unchanged role setter while still retaining both role originals in the durable record', async () => {
  const f = await fixture();
  f.panels.right.mixerConfiguration.fill(0, 2, 14);
  await f.controller.load('both', actor, { preset: 1 });
  f.edit('left', 0.2);
  const r = await f.review('both'),
    result = await f.controller.save(r.id, ui, { confirm: true });
  expect(result.roles.map((role) => role.state)).toEqual(['verified', 'unchanged']);
  expect(setters(f.panels.left)).toHaveLength(1);
  expect(setters(f.panels.right)).toHaveLength(0);
  expect(f.db.value.records[0].roles).toHaveLength(2);
});

it('fails closed before any setter when the original-image journal cannot be persisted/read back', async () => {
  const f = await fixture();
  await f.controller.load('both', actor, { preset: 1 });
  const r = await f.review('both');
  f.db.hooks.before = () => {
    throw new Error('Injected durable write failure');
  };
  await expect(f.controller.save(r.id, actor, { confirm: true })).rejects.toMatchObject({
    result: { persistence: 'unavailable', complete: false },
  });
  for (const p of Object.values(f.panels)) expect(anySetters(p)).toHaveLength(0);
  const n = f.panels.left.requests.length;
  expect(await f.controller.save(r.id, ui, { confirm: true })).toMatchObject({
    replayed: true,
    persistence: 'unavailable',
  });
  expect(f.panels.left.requests).toHaveLength(n);
});

it('retains exact attempted/Unconfirmed outcomes after lost ACK and never resends the consumed ID, including after reload', async () => {
  const f = await fixture();
  await f.controller.load('both', actor, { preset: 1 });
  const r = await f.review('both');
  f.intercept.right = async (req, send) => {
    const response = await send();
    if (req[0] === 0x67 && req[1] === 1) throw new Error('Injected lost ACK');
    return response;
  };
  let error: NativeMixerError | undefined;
  try {
    await f.controller.save(r.id, ui, { confirm: true });
  } catch (e) {
    error = e as NativeMixerError;
  }
  expect(error).toBeInstanceOf(NativeMixerError);
  expect(error!.result).toMatchObject({ partial: true, persistence: 'verified' });
  expect(error!.result!.roles.find((role) => role.slot === 'right')).toMatchObject({
    state: 'unconfirmed',
    attempted: true,
  });
  const n = f.panels.left.requests.length + f.panels.right.requests.length;
  const reloaded = createNativeMixerController(f.options);
  await reloaded.hydrate(actor);
  expect(await reloaded.save(r.id, actor, { confirm: true })).toMatchObject({
    partial: true,
    replayed: true,
    persistence: 'verified',
  });
  expect(f.panels.left.requests.length + f.panels.right.requests.length).toBe(n);
});

it('exports the latest verified physical outcome when terminal journal readback fails and does not repeat the setter', async () => {
  const f = await fixture();
  await f.controller.load('left', actor, { preset: 1 });
  const r = await f.review();
  f.db.hooks.after = (next) => {
    if (next.records[0]?.phase === 'complete') f.db.hooks.failRead = true;
  };
  await expect(f.controller.save(r.id, ui, { confirm: true })).rejects.toMatchObject({
    result: { complete: true, persistence: 'unavailable' },
  });
  const exported = f.controller.exportRecord(r.id, actor);
  expect(exported).toMatchObject({ phase: 'complete', exportPersistence: 'unavailable' });
  expect(exported.roles[0]).toMatchObject({ attempted: true, state: 'verified' });
  expect(setters(f.panels.left)).toHaveLength(1);
  const n = f.panels.left.requests.length;
  expect(await f.controller.save(r.id, ui, { confirm: true })).toMatchObject({
    complete: true,
    replayed: true,
    persistence: 'unavailable',
  });
  expect(f.panels.left.requests).toHaveLength(n);
});

it('fences equal-identity session replacement, foreign actors and stale revisions without retargeting a setter', async () => {
  const f = await fixture();
  await f.controller.load('left', actor, { preset: 1 });
  const old = f.controller.status(actor).revision;
  f.edit('left', 0.2);
  expect(() =>
    f.controller.edit('left', actor, {
      expectedRevision: old,
      preset: 1,
      channel: 1,
      input: 'left',
      value: 0.3,
    }),
  ).toThrow(/revision/);
  expect(() => f.controller.status(foreign)).toThrow(/workspace/);
  const r = await f.review();
  f.bindings.left = {
    ...f.bindings.left,
    session: new PanelSession(new SimulatedPanel('SYNTHETIC-MIXER-LEFT'), async () => {}),
  };
  await expect(f.controller.save(r.id, ui, { confirm: true })).rejects.toMatchObject({
    result: { complete: false, partial: false },
  });
  expect(anySetters(f.panels.left)).toHaveLength(0);
  expect(f.controller.status(actor).roles.left.draft).toBeUndefined();
});

it('keeps a before-send replacement failure Blocked/attempted false even after the provisional attempt callback', async () => {
  const f = await fixture();
  await f.controller.load('left', actor, { preset: 1 });
  const r = await f.review(),
    write = f.sessions.left.writeNativeMixerInternal.bind(f.sessions.left);
  vi.spyOn(f.sessions.left, 'writeNativeMixerInternal').mockImplementation(
    (expected, before, plan, hooks) =>
      write(expected, before, plan, {
        ...hooks,
        onAttempt: () => {
          hooks?.onAttempt?.();
          f.bindings.left = {
            ...f.bindings.left,
            session: new PanelSession(new SimulatedPanel('SYNTHETIC-MIXER-LEFT'), async () => {}),
          };
        },
      }),
  );
  await expect(f.controller.save(r.id, ui, { confirm: true })).rejects.toMatchObject({
    result: { partial: false, roles: [{ attempted: false, state: 'blocked' }] },
  });
  expect(anySetters(f.panels.left)).toHaveLength(0);
  expect(f.db.value.records[0].roles[0].attempted).toBe(false);
});

it('returns the verified receipt if disposed during an already sent setter, while admitting no new operation', async () => {
  const f = await fixture();
  await f.controller.load('left', actor, { preset: 1 });
  const r = await f.review();
  f.intercept.left = async (req, send) => {
    const actual = await send();
    if (req[0] === 0x67 && req[1] === 1) f.controller.dispose();
    return actual;
  };
  const result = await f.controller.save(r.id, ui, { confirm: true });
  expect(result).toMatchObject({ complete: true, persistence: 'verified' });
  expect(f.controller.getSnapshot().roles.left.connected).toBe(false);
  expect(f.controller.getSnapshot().lastResult).toBeUndefined();
  expect(() => f.controller.status(actor)).toThrow(/disposed/);
  expect(setters(f.panels.left)).toHaveLength(1);
});

it('never resumes an interrupted durable intent after reload', async () => {
  const f = await fixture();
  await f.controller.load('left', actor, { preset: 1 });
  const r = await f.review();
  f.db.hooks.after = (next) => {
    if (next.records[0]?.roles[0].state === 'intent') {
      f.db.hooks.failRead = true;
      throw new Error('Simulated interruption');
    }
  };
  await expect(f.controller.save(r.id, actor, { confirm: true })).rejects.toBeInstanceOf(
    NativeMixerError,
  );
  f.db.hooks.failRead = false;
  f.db.hooks.after = undefined;
  const reloaded = createNativeMixerController(f.options);
  await reloaded.hydrate(ui);
  const n = f.panels.left.requests.length;
  expect(await reloaded.save(r.id, ui, { confirm: true })).toMatchObject({
    phase: 'running',
    complete: false,
    replayed: true,
  });
  expect(f.panels.left.requests).toHaveLength(n);
  expect(setters(f.panels.left)).toHaveLength(0);
});

it('honors cancellation before the first setter but finishes every admitted role once a setter starts', async () => {
  const f = await fixture();
  await f.controller.load('both', actor, { preset: 1 });
  const r = await f.review('both'),
    abort = new AbortController();
  f.intercept.left = async (req, send) => {
    if (req[0] === 0x67 && req[1] === 1) abort.abort(new Error('Caller stopped waiting'));
    return send();
  };
  expect(
    await f.controller.save(r.id, { ...ui, signal: abort.signal }, { confirm: true }),
  ).toMatchObject({ complete: true, persistence: 'verified' });
  expect(setters(f.panels.left)).toHaveLength(1);
  expect(setters(f.panels.right)).toHaveLength(1);
  await f.controller.load('both', actor, { preset: 1 });
  f.edit('left', 0.41);
  const next = await f.review('both'),
    before = f.panels.left.requests.length + f.panels.right.requests.length;
  await expect(
    f.controller.save(next.id, { ...ui, signal: AbortSignal.abort() }, { confirm: true }),
  ).rejects.toMatchObject({ result: { complete: false, partial: false } });
  expect(f.panels.left.requests.length + f.panels.right.requests.length).toBe(before);
  expect(setters(f.panels.left)).toHaveLength(1);
  expect(setters(f.panels.right)).toHaveLength(1);
});
