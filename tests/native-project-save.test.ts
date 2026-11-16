// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import {
  createNativeProjectSaveController,
  MAX_NATIVE_PROJECT_SAVE_CAPTURES,
} from '../src/application/native-project-save';
import { newProject, type Slot } from '../src/domain/model';
import { encodeEq, packet } from '../src/hardware/codec';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { importProjectFolder, projectFiles } from '../src/domain/project-io';
import { importHfd } from '../src/domain/files';
import { applyNativeOrdinarySavePostState } from '../src/application/native-save-lifecycle';

const actor = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'ui:save' },
  agent = { ...actor, scope: 'paired:site:synthetic' },
  foreign = { owner: 'workspace:22222222-2222-4222-8222-222222222222', scope: 'ui:other' };
function device(serial: string, frequency: number) {
  const panel = new SimulatedPanel(serial),
    backup = vi.fn(async () => {
      throw Error('Read-only capture cannot save a hardware backup');
    });
  panel.configuration[5] = panel.configuration[12] = 3;
  panel.deviceConfiguration[11] = 9;
  for (const preset of [0, 1, 2]) {
    const bands = newProject().presets[preset].inputEq;
    bands[0].frequency = frequency + preset;
    bands[0].gain = preset + 1;
    panel.memory.set(encodeEq(bands), 0x25000 + preset * 4096);
  }
  const session = new PanelSession(
      {
        exchange: async (request) => (request[0] === 0x67 ? packet(0x67) : panel.exchange(request)),
        close: () => panel.close(),
      },
      backup,
    ),
    identity = { serial, product: 22, core: '5.1', firmware: '5.7' };
  return { panel, session, identity, backup };
}
function fixture(limits?: { characters?: number; bytes?: number }) {
  const documents = { left: newProject('Left design'), right: newProject('Right design') },
    left = device('SIM-SAVE-LEFT', 444),
    right = device('SIM-SAVE-RIGHT', 888),
    bindings: Partial<Record<Slot, ReturnType<typeof device>>> = { left, right };
  let revision = 7,
    sequence = 0;
  const operate = vi.fn();
  const controller = createNativeProjectSaveController({
    state: () => ({ documents, documentRevision: revision }),
    binding: (slot) => bindings[slot],
    operate: async <T>(label: string, work: () => Promise<T>) => {
      operate(label);
      return work();
    },
    now: () => Date.UTC(2026, 0, 1),
    id: () => `capture-${++sequence}`,
    limits,
  });
  return {
    documents,
    left,
    right,
    bindings,
    controller,
    operate,
    bump: () => revision++,
    get revision() {
      return revision;
    },
    stage: (target: Slot | 'both' = 'left', mode: 'auto' | 'design' = 'auto') =>
      controller.stage({ target, expectedRevision: revision, mode }, actor),
  };
}
const setters = (panel: SimulatedPanel) =>
  panel.requests.filter(
    (r) =>
      r[0] === 0x64 ||
      (r[0] === 5 && r[1] === 0) ||
      (r[0] === 0x66 && r[1] === 1) ||
      (r[0] === 3 && r[1] === 0),
  );
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it('stages synchronously with stable status and zero I/O, then emits fresh physical info/EQ while preserving the complete staged design', async () => {
  const f = fixture(),
    before = structuredClone(f.documents),
    snapshot = f.controller.getSnapshot(),
    summary = f.stage();
  expect(f.left.panel.requests).toHaveLength(0);
  expect(f.right.panel.requests).toHaveLength(0);
  expect(summary).toMatchObject({
    phase: 'staged',
    roles: [{ slot: 'left', source: 'connected', identity: f.left.identity }],
  });
  expect(f.controller.getSnapshot()).not.toBe(snapshot);
  expect(f.controller.getSnapshot()).toBe(f.controller.getSnapshot());
  const artifact = await f.controller.resolve(summary.id, agent),
    saved = artifact.roles[0];
  expect(saved.project.hfdCloneTemplate!.eqBanks[0][0].frequency).toBe(444);
  expect(saved.project.presets[0].inputEq).toEqual(before.left.presets[0].inputEq);
  expect(saved.project.hfdCloneTemplate!.provenance).toMatchObject({
    kind: 'device-capture',
    sourceSerial: 'SIM-SAVE-LEFT',
  });
  const config = saved.files.find((file) => file.path === 'Config.xml')!.content;
  expect(importHfd(config, 'Native reopen').hfdCloneTemplate!.eqBanks[0][0].frequency).toBe(444);
  const reopened = importProjectFolder([...saved.files]);
  expect({ ...reopened, warnings: saved.project.warnings }).toEqual(saved.project);
  expect(reopened.warnings.join(' ')).toContain('Restored browser-only');
  const json = JSON.stringify(saved.project),
    detached = JSON.parse(json);
  expect(detached.hfdCloneTemplate.eqBanks[2][0].frequency).toBe(446);
  expect(f.documents).toEqual(before);
  expect(f.revision).toBe(7);
  expect(f.right.panel.requests).toHaveLength(0);
  expect(setters(f.left.panel)).toHaveLength(0);
  expect(f.left.backup).not.toHaveBeenCalled();
  expect(Object.isFrozen(saved.project.presets[0].inputEq)).toBe(true);
});

it('caches a successful artifact for same-owner cross-scope replay without new device reads', async () => {
  const f = fixture(),
    summary = f.stage(),
    artifact = await f.controller.resolve(summary.id, actor),
    reads = f.left.panel.requests.length;
  delete f.bindings.left;
  f.bump();
  expect(await f.controller.resolve(summary.id, agent)).toBe(artifact);
  expect(f.left.panel.requests).toHaveLength(reads);
});

it('keeps explicit design mode and initially offline auto mode identical to ordinary projectFiles without picking up a later connection', async () => {
  const f = fixture(),
    explicit = f.stage('left', 'design');
  delete f.bindings.right;
  const offline = f.stage('right');
  f.bindings.right = f.right;
  for (const summary of [explicit, offline]) {
    const result = await f.controller.resolve(summary.id, actor),
      role = result.roles[0];
    expect(role.source).toBe('design');
    expect(role.files).toEqual(projectFiles(f.documents[role.slot]));
    expect(role.project).toEqual(f.documents[role.slot]);
    expect(role.project.hfdCloneTemplate).toBeUndefined();
  }
  expect(f.left.panel.requests).toHaveLength(0);
  expect(f.right.panel.requests).toHaveLength(0);
});

it('preserves an offline frozen export after navigation/design replacement without entering a hardware busy gate', async () => {
  const f = fixture(),
    original = structuredClone(f.documents.left),
    summary = f.stage('left', 'design');
  f.documents.left = newProject('Later design');
  f.bump();
  const artifact = await f.controller.resolve(summary.id, actor);
  expect(artifact.roles[0].project).toEqual(original);
  expect(JSON.stringify(artifact.roles[0].project, null, 2)).toBe(
    JSON.stringify(original, null, 2),
  );
  expect(artifact.roles[0].files).toEqual(projectFiles(original));
  expect(f.operate).not.toHaveBeenCalled();
  expect(f.left.panel.requests).toHaveLength(0);
  const ticket = f.controller.ticket(
    {
      slot: 'left',
      expectedRevision: 7,
      requestId: 'frozen',
      principal: actor,
      exportId: summary.id,
      metadata: 'design',
    },
    original,
  );
  expect(() => ticket.assertCurrent()).not.toThrow();
});

it('Both captures different physical banks atomically with no workspace publication', async () => {
  const f = fixture(),
    before = structuredClone(f.documents),
    summary = f.stage('both');
  const artifact = await f.controller.resolve(summary.id, actor);
  expect(
    artifact.roles.map((role) => role.project.hfdCloneTemplate!.eqBanks[0][0].frequency),
  ).toEqual([444, 888]);
  expect(artifact.roles.map((role) => role.slot)).toEqual(['left', 'right']);
  expect(f.documents).toEqual(before);
  expect(setters(f.left.panel)).toHaveLength(0);
  expect(setters(f.right.panel)).toHaveLength(0);
});

it('a failed Right capture returns no partial artifact or Left template publication and never silently retries', async () => {
  const f = fixture(),
    before = structuredClone(f.documents),
    summary = f.stage('both');
  vi.spyOn(f.right.session, 'captureNativeSaveSnapshotInternal').mockRejectedValue(
    new Error('Synthetic Right read failed'),
  );
  await expect(f.controller.resolve(summary.id, actor)).rejects.toThrow(/Right read failed/);
  expect(f.documents).toEqual(before);
  expect(f.controller.getSnapshot().captures[0]).toMatchObject({ phase: 'error' });
  expect(
    f.controller.getSnapshot().captures[0].roles.every((role) => role.capturedAt === undefined),
  ).toBe(true);
  const reads = f.left.panel.requests.length;
  await expect(f.controller.resolve(summary.id, actor)).rejects.toThrow();
  expect(f.left.panel.requests).toHaveLength(reads);
});

it.each(['revision', 'replacement', 'disconnect'] as const)(
  'rejects stale %s during a read even when replacement identity is equal',
  async (mode) => {
    const f = fixture(),
      summary = f.stage(),
      gate = deferred(),
      started = deferred(),
      capture = f.left.session.captureNativeSaveSnapshotInternal.bind(f.left.session);
    vi.spyOn(f.left.session, 'captureNativeSaveSnapshotInternal').mockImplementation(
      async (identity) => {
        started.resolve();
        await gate.promise;
        return capture(identity);
      },
    );
    const flight = f.controller.resolve(summary.id, actor);
    await started.promise;
    if (mode === 'revision') f.bump();
    else if (mode === 'disconnect') delete f.bindings.left;
    else f.bindings.left = device(f.left.identity.serial, 999);
    gate.resolve();
    await expect(flight).rejects.toThrow(/changed/);
    expect(f.documents.left.hfdCloneTemplate).toBeUndefined();
    expect(f.controller.getSnapshot().busy).toBe(false);
  },
);

it('release invalidates an in-flight capture, does not close the user session, and keeps its bounded slot until the read settles', async () => {
  const f = fixture(),
    summary = f.stage(),
    gate = deferred(),
    started = deferred(),
    capture = f.left.session.captureNativeSaveSnapshotInternal.bind(f.left.session);
  vi.spyOn(f.left.session, 'captureNativeSaveSnapshotInternal').mockImplementation(
    async (identity) => {
      started.resolve();
      await gate.promise;
      return capture(identity);
    },
  );
  const flight = f.controller.resolve(summary.id, actor);
  await started.promise;
  f.controller.release(summary.id, agent);
  expect(f.controller.getSnapshot().captures).toEqual([]);
  expect(f.controller.getSnapshot().busy).toBe(true);
  gate.resolve();
  await expect(flight).rejects.toThrow(/released/);
  expect(f.left.panel.closed).toBe(false);
  expect(f.documents.left.hfdCloneTemplate).toBeUndefined();
  expect(f.controller.getSnapshot().busy).toBe(false);
});

it('owner filtering and admission reject foreign resolution/release, raw identities and aborted context without I/O', async () => {
  const f = fixture(),
    summary = f.stage();
  expect(f.controller.status(foreign).captures).toEqual([]);
  await expect(f.controller.resolve(summary.id, foreign)).rejects.toThrow(/unavailable/);
  expect(() => f.controller.release(summary.id, foreign)).toThrow(/another workspace/);
  expect(() =>
    f.controller.stage(
      { target: 'left', expectedRevision: 7, mode: 'auto' },
      { owner: 'site:unadmitted', scope: 'lease' },
    ),
  ).toThrow(/admission/);
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    f.controller.resolve(summary.id, { ...actor, signal: aborted.signal }),
  ).rejects.toThrow();
  expect(f.left.panel.requests).toHaveLength(0);
});

it('bounds captures, rejects duplicate physical targets and releases implicit tickets without evicting explicit artifacts', async () => {
  const f = fixture();
  f.bindings.right = f.left;
  expect(() => f.stage('both')).toThrow(/distinct physical/);
  f.bindings.right = f.right;
  for (let i = 0; i < 12; i++) {
    const ticket = f.controller.ticket(
      {
        slot: 'left',
        expectedRevision: 7,
        requestId: `request-${i}`,
        principal: actor,
        metadata: 'design',
      },
      f.documents.left,
    );
    await ticket.resolve();
    ticket.assertCurrent();
    ticket.dispose?.();
  }
  expect(f.controller.getSnapshot().captures).toHaveLength(0);
  const retained = Array.from({ length: MAX_NATIVE_PROJECT_SAVE_CAPTURES }, () =>
    f.stage('left', 'design'),
  );
  expect(() => f.stage()).toThrow(/Eight/);
  f.controller.release(retained[0].id, actor);
  expect(() => f.stage()).not.toThrow();
});

it('explicit tickets retain the stage, reject mismatched fixed design/mode/revision and fence the current workspace separately from historical export', async () => {
  const f = fixture(),
    summary = f.stage(),
    binding = {
      slot: 'left' as const,
      expectedRevision: 7,
      requestId: 'request',
      principal: actor,
      exportId: summary.id,
      metadata: 'auto' as const,
    };
  const ticket = f.controller.ticket(binding, f.documents.left);
  await ticket.resolve();
  ticket.dispose?.();
  expect(f.controller.getSnapshot().captures).toHaveLength(1);
  const altered = structuredClone(f.documents.left);
  altered.name = 'Different';
  expect(() => f.controller.ticket(binding, altered)).toThrow(/does not match/);
  expect(() => f.controller.ticket({ ...binding, metadata: 'design' }, f.documents.left)).toThrow(
    /does not match/,
  );
  f.bump();
  expect(() => ticket.assertCurrent()).toThrow(/design changed/);
});

it('dispose invalidates pending work and later admission without initiating a device close or setter', async () => {
  const f = fixture(),
    summary = f.stage('left', 'design');
  f.controller.dispose();
  await expect(f.controller.resolve(summary.id, actor)).rejects.toThrow(/disposed/);
  expect(() =>
    f.controller.stage({ target: 'left', expectedRevision: 7, mode: 'auto' }, actor),
  ).toThrow(/disposed/);
  expect(f.left.panel.closed).toBe(false);
  expect(f.left.panel.requests).toHaveLength(0);
});

it('counts Both projects separately against the aggregate retention budget and frees capacity only on release', () => {
  const sample = { left: newProject('Left design'), right: newProject('Right design') },
    size = JSON.stringify(sample.left).length + JSON.stringify(sample.right).length,
    f = fixture({ characters: size + 100 });
  const pair = f.stage('both', 'design');
  expect(() => f.stage('left', 'design')).toThrow(/aggregate retained/);
  expect(f.controller.getSnapshot().captures).toHaveLength(1);
  f.controller.release(pair.id, actor);
  expect(() => f.stage('left', 'design')).not.toThrow();
});

it('rejects resolved project plus file-text budget overflow before publishing any artifact and retains only an error summary', async () => {
  const size = JSON.stringify(newProject('Left design')).length,
    f = fixture({ characters: size * 2 }),
    summary = f.stage('left', 'design');
  await expect(f.controller.resolve(summary.id, actor)).rejects.toThrow(/aggregate retained/);
  expect(f.controller.getSnapshot().captures[0]).toMatchObject({ phase: 'error' });
  expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('presets');
  // Retained failed IDs are not silently evicted; their large detached data is released.
  expect(() => f.stage('left', 'design')).not.toThrow();
  expect(f.controller.getSnapshot().captures).toHaveLength(2);
});

it('enforces UTF-8 bytes independently of characters and refuses attempts to raise production retention limits', () => {
  const documents = { left: newProject('μ'.repeat(200)), right: newProject('Right') },
    characters = JSON.stringify(documents.left).length;
  const f = createNativeProjectSaveController({
    state: () => ({ documents, documentRevision: 0 }),
    binding: () => undefined,
    limits: { bytes: characters },
  });
  expect(() => f.stage({ target: 'left', expectedRevision: 0, mode: 'design' }, actor)).toThrow(
    /aggregate retained/,
  );
  expect(f.getSnapshot().captures).toHaveLength(0);
  expect(() =>
    createNativeProjectSaveController({
      state: () => ({ documents }),
      binding: () => undefined,
      limits: { characters: 80e6 + 1 },
    }),
  ).toThrow(/Invalid/);
});

it.each(['design', 'auto'] as const)(
  'projects the captured runtime preset only for %s folder tickets while generic exports remain passive',
  async (mode) => {
    const documents = { left: newProject('Save projection'), right: newProject('Other role') },
      connected = device('SIM-SAVE-PROJECTION', 765),
      publish = vi.fn(),
      persist = vi.fn(async () => {});
    documents.left.hfdSelectedPreset = 1;
    documents.left.presets[1].channels.forEach((channel, index) => {
      channel.globalDelayUs = [101, 113, 127][index];
      channel.hfdDelay = { globalMaximum: 71001 + index, localMaximum: 19200 };
    });
    const before = structuredClone(documents),
      controller = createNativeProjectSaveController({
        state: () => ({ documents, documentRevision: 0 }),
        binding: () => connected,
        ordinarySave: { currentPresetIndex: () => 1, publish, persist },
      }),
      staged = controller.stage({ target: 'left', expectedRevision: 0, mode }, actor),
      artifact = await controller.resolve(staged.id, actor),
      ticket = controller.ticket(
        {
          slot: 'left',
          expectedRevision: 0,
          requestId: 'folder-projection',
          principal: actor,
          exportId: staged.id,
          metadata: mode,
        },
        before.left,
      ),
      folder = await ticket.resolve();
    expect(ticket.nativeOrdinarySave?.presetIndex).toBe(1);
    expect(folder.project).toEqual({ ...artifact.roles[0].project, hfdSelectedPreset: 2 });
    expect(importHfd(folder.files[0].content, 'Saved folder').hfdSelectedPreset).toBe(2);
    const sidecar = JSON.parse(folder.files[1].content);
    expect(sidecar.project).toEqual(folder.project);
    expect(sidecar.nativeFiles[0].content).toBe(folder.files[0].content);
    expect(folder.project.presets[1].channels.map((channel) => channel.globalDelayUs)).toEqual([
      101, 113, 127,
    ]);
    expect(artifact.roles[0].project.hfdSelectedPreset).toBe(1);
    expect(await controller.resolve(staged.id, agent)).toBe(artifact);
    expect(await ticket.resolve()).toBe(folder);
    expect(documents).toEqual(before);
    expect(publish).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    if (mode === 'auto') {
      expect(folder.project.hfdCloneTemplate?.eqBanks[0][0].frequency).toBe(765);
      expect(setters(connected.panel)).toEqual([]);
    }
  },
);

it('an implicit folder ticket retains its admitted original context after releasing detached artifacts', async () => {
  const documents = { left: newProject('Implicit Save'), right: newProject('Other') };
  documents.left.presets[1].channels.forEach((channel, index) => {
    channel.globalDelayUs = [101, 113, 127][index];
    channel.hfdDelay = { globalMaximum: 71001 + index, localMaximum: 19200 };
  });
  const publish = vi.fn((plans) => {
      const proposal = structuredClone(documents.left);
      applyNativeOrdinarySavePostState(proposal, 'left', plans[0]);
      documents.left = proposal;
    }),
    persist = vi.fn(async () => {}),
    controller = createNativeProjectSaveController({
      state: () => ({ documents, documentRevision: 0 }),
      binding: () => undefined,
      ordinarySave: { currentPresetIndex: () => 1, publish, persist },
    }),
    ticket = controller.ticket(
      { slot: 'left', expectedRevision: 0, requestId: 'implicit-save', principal: actor },
      documents.left,
    );
  await ticket.resolve();
  const attempt = ticket.nativeOrdinarySave!.createAttempt(actor);
  ticket.dispose?.();
  expect(controller.getSnapshot().captures).toEqual([]);
  attempt.beforeWrite(agent);
  await expect(attempt.returned(agent, true)).resolves.toMatchObject({
    changed: true,
    published: true,
    durable: true,
  });
  expect(documents.left.presets[1].channels.map((channel) => channel.globalDelayUs)).toEqual([
    101, 101, 101,
  ]);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(persist).toHaveBeenCalledTimes(1);
});

it('runtime preset navigation invalidates a folder attempt without invalidating its detached download', async () => {
  const documents = { left: newProject('Navigation'), right: newProject('Other') };
  let presetIndex = 1;
  const publish = vi.fn(),
    controller = createNativeProjectSaveController({
      state: () => ({ documents, documentRevision: 0 }),
      binding: () => undefined,
      ordinarySave: { currentPresetIndex: () => presetIndex, publish, persist: async () => {} },
    }),
    staged = controller.stage({ target: 'left', expectedRevision: 0, mode: 'design' }, actor),
    ticket = controller.ticket(
      {
        slot: 'left',
        expectedRevision: 0,
        requestId: 'navigation',
        principal: actor,
        exportId: staged.id,
      },
      documents.left,
    ),
    download = await controller.resolve(staged.id, actor);
  presetIndex = 2;
  expect(() => ticket.nativeOrdinarySave!.createAttempt(actor)).toThrow(/preset|changed|stale/i);
  expect(await controller.resolve(staged.id, actor)).toBe(download);
  expect(publish).not.toHaveBeenCalled();
});

it('controller disposal revokes folder admission and already admitted writer fences, independently of ticket disposal', async () => {
  const documents = { left: newProject('Disposed Save'), right: newProject('Other') },
    publish = vi.fn(),
    controller = createNativeProjectSaveController({
      state: () => ({ documents, documentRevision: 0 }),
      binding: () => undefined,
      ordinarySave: { currentPresetIndex: () => 1, publish, persist: async () => {} },
    }),
    ticket = controller.ticket(
      { slot: 'left', expectedRevision: 0, requestId: 'dispose-save', principal: actor },
      documents.left,
    );
  await ticket.resolve();
  expect(() => ticket.nativeOrdinarySave!.createAttempt(foreign)).toThrow(/another workspace/);
  const attempt = ticket.nativeOrdinarySave!.createAttempt(actor);
  ticket.dispose?.();
  attempt.beforeWrite(actor);
  controller.dispose();
  expect(() => ticket.nativeOrdinarySave!.createAttempt(actor)).toThrow(/disposed/);
  await expect(attempt.returned(actor, true)).rejects.toThrow(/disposed/);
  expect(attempt.getSnapshot().phase).toBe('unconfirmed');
  expect(publish).not.toHaveBeenCalled();
});

it('rejects an absent runtime selection when ordinary folder Save ports are installed', () => {
  const documents = { left: newProject('Invalid selection'), right: newProject('Other') },
    controller = createNativeProjectSaveController({
      state: () => ({ documents, documentRevision: 0 }),
      binding: () => undefined,
      ordinarySave: {
        currentPresetIndex: () => undefined as unknown as number,
        publish: vi.fn(),
        persist: async () => {},
      },
    });
  expect(() =>
    controller.stage({ target: 'left', expectedRevision: 0, mode: 'design' }, actor),
  ).toThrow(/current preset/);
  expect(controller.getSnapshot().captures).toEqual([]);
});
