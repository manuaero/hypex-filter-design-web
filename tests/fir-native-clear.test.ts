// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { newProject, type Fir, type Preset, type Project } from '../src/domain/model';
import {
  applyNativeFirAction,
  clearNativeFir,
  editPresetFir,
  selectNativeFirPlacement,
  setNativeFirEnabled,
} from '../src/domain/fir-editing';
import { firIsEffective, planFirActivation } from '../src/domain/fir-state';
import { exportHfd, parseProject, projectSchema } from '../src/domain/files';
import { projectFiles, importProjectFolder } from '../src/domain/project-io';
import { presetImpulse, presetResponse } from '../src/domain/dsp';
import { analyzeTimeResponses } from '../src/domain/time-analysis';
import { PanelSession, type Backup } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { uploadFir, restoreFir, readFir, type FirBackup } from '../src/hardware/fir';
import { uploadProjectPair } from '../src/hardware/project-upload';
import { createWorkspaceStore } from '../src/state/workspace';
import { assertWorkspaceWrite, type WorkspaceEnvelope } from '../src/state/persistence';

vi.mock('../src/hardware/storage', () => ({
  saveConfigurationBackup: vi.fn(async () => {}),
  saveFirBackup: vi.fn(async () => {}),
}));
beforeAll(() => vi.stubGlobal('crypto', webcrypto));
afterAll(() => vi.unstubAllGlobals());
afterEach(() => vi.useRealTimers());
const taps = (count: number, amplitude = 0.5, at = 0) =>
  Array.from({ length: count }, (_, i) => (i === at ? amplitude : 0));
const native = (capacity: number, enabled = true, used = true, amplitude = 0.5): Fir => ({
  name: 'Original.txt',
  enabled,
  taps: taps(capacity, amplitude),
  hfdState: { loaded: true, used, tapCount: capacity },
});
function fixture(): Preset {
  const p = newProject().presets[0];
  selectNativeFirPlacement(p, 'output');
  p.inputFir = native(4500, true, false);
  p.channels[0].fir = native(1500);
  p.channels[1].fir = native(1500, true, true, 0.25);
  return p;
}
async function finish<T>(operation: Promise<T>): Promise<T> {
  let done = false;
  const settled = operation.then(
    (value) => {
      done = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      done = true;
      return { ok: false as const, error };
    },
  );
  for (let i = 0; !done && i < 5000; i++) {
    await vi.runAllTimersAsync();
    await yieldEventLoop();
  }
  if (!done) throw new Error('Synthetic operation did not settle');
  const result = await settled;
  if (!result.ok) throw result.error;
  return result.value;
}
function xml(project: Project) {
  return new DOMParser().parseFromString(exportHfd(project), 'application/xml');
}
const node = (doc: Document, input = false, group = 1) =>
  doc.querySelector(
    `device > preset[index="1"] > processobj[processtype="ptFir"]${input ? '[groupid="-1"]' : `[groupid="${group}"]`}`,
  )!;
const value = (n: Element, key: string) =>
  n.querySelector(`:scope > ${key}`)?.getAttribute('value');

it('clears shared input plus only the selected output, preserving enabled/count/placement/link/identity and other processing', () => {
  const p = fixture();
  p.channels[0].linkedTo = 1;
  p.channels[0].gain = -9;
  const before = structuredClone(p);
  clearNativeFir(p, 0);
  expect(p.inputFir).toEqual({
    name: '',
    enabled: true,
    taps: [],
    hfdState: { loaded: false, used: false, tapCount: 4500 },
  });
  expect(p.channels[0].fir).toEqual({
    name: '',
    enabled: true,
    taps: [],
    hfdState: { loaded: false, used: true, tapCount: 1500 },
  });
  expect(p.channels[1]).toEqual(before.channels[1]);
  expect(p.channels[2]).toEqual(before.channels[2]);
  expect(p.channels[0].id).toBe(before.channels[0].id);
  expect(p.channels[0].linkedTo).toBe(1);
  expect(p.channels[0].filters).toEqual(before.channels[0].filters);
  expect(p.channels[0].gain).toBe(-9);
  expect(p.firPlacement).toBe('output');
  expect(p.inputEq).toEqual(before.inputEq);
});

it('preserves latent enable through native Clear/reload and native placement selection without disabling the opposite resource', () => {
  const p = fixture();
  clearNativeFir(p, 0);
  expect(firIsEffective(p.channels[0].fir)).toBe(false);
  editPresetFir(p, 1, { name: 'Reload.txt', taps: taps(1500, 0.75) });
  expect(p.channels[0].fir).toMatchObject({
    enabled: true,
    hfdState: { loaded: true, used: true, tapCount: 1500 },
  });
  expect(presetResponse(p, 0, 1000)[0]).toBeCloseTo(0.75, 12);
  selectNativeFirPlacement(p, 'input');
  expect(p.channels[0].fir.enabled).toBe(true);
  expect(p.channels[0].fir.hfdState!.used).toBe(false);
  expect(p.inputFir.enabled).toBe(true);
  expect(p.inputFir.hfdState).toEqual({ loaded: false, used: true, tapCount: 4500 });
  editPresetFir(p, 0, { name: 'Reload input.txt', taps: taps(4500, 0.2) });
  expect(presetResponse(p, 0, 1000)[0]).toBeCloseTo(0.2, 12);
  setNativeFirEnabled(p, 0, false);
  expect(p.channels[0].fir.enabled).toBe(true);
  expect(presetResponse(p, 0, 1000)[0]).toBeCloseTo(1, 12);
});

it('keeps explicit browser Unload separate and rejects malformed native state before any coupled mutation', () => {
  const p = fixture();
  editPresetFir(p, 1, { clear: true });
  expect(p.channels[0].fir).toEqual({ name: '', enabled: false, taps: [] });
  expect(p.inputFir.hfdState!.loaded).toBe(true);
  const invalid = fixture();
  invalid.channels[1].fir.hfdState!.tapCount = 1;
  const before = structuredClone(invalid);
  expect(() => clearNativeFir(invalid, 0)).toThrow(/native FIR/);
  expect(invalid).toEqual(before);
  for (const index of [-1, 3, NaN]) expect(() => clearNativeFir(p, index)).toThrow(/channel/);
});

it('gates frequency and electrical/timed impulses on native Loaded and Used, including ignored zero-filled caches', () => {
  const project = newProject(),
    p = project.presets[0];
  selectNativeFirPlacement(p, 'output');
  p.channels[0].fir = {
    name: '',
    enabled: true,
    taps: Array(1500).fill(0),
    hfdState: { loaded: false, used: true, tapCount: 1500 },
  };
  expect(presetResponse(p, 0, 1000)).toEqual([1, 0]);
  expect(presetImpulse(p, 0, 32)[0]).toBeCloseTo(1, 12);
  const time = analyzeTimeResponses(p.channels, { preset: p, length: 32 });
  expect(time.channels[0].impulse!.samples[0]).toBeCloseTo(1, 9);
  p.channels[0].fir = native(1500, true, false, 0.125);
  expect(presetResponse(p, 0, 1000)).toEqual([1, 0]);
  expect(presetImpulse(p, 0, 32)[0]).toBeCloseTo(1, 12);
  p.channels[0].fir.hfdState!.used = true;
  expect(presetResponse(p, 0, 1000)[0]).toBeCloseTo(0.125, 12);
});

it('uses the actual product of two explicitly used native FIR nodes rather than accidentally selecting one', () => {
  const p = fixture();
  p.inputFir.hfdState!.used = true;
  expect(presetResponse(p, 0, 1000)[0]).toBeCloseTo(0.25, 12);
  expect(presetImpulse(p, 0, 32)[0]).toBeCloseTo(0.25, 12);
  const before = structuredClone(p),
    plan = planFirActivation(p, 0);
  expect(plan.banks.map((bank) => bank.channel)).toEqual([1, 2, 3]);
  expect(plan.warnings).toEqual([
    'Inactive input graph FIR is not transferred; only the selected placement is programmed.',
  ]);
  expect(p).toEqual(before);
});

it('exports Clear with raw Enabled, retained count, input unused/no coefficients and used output zero padding', () => {
  const project = newProject();
  project.presets[0] = fixture();
  clearNativeFir(project.presets[0], 0);
  const doc = xml(project),
    input = node(doc, true),
    output = node(doc);
  expect(input.getAttribute('enabled')).toBe('true');
  expect(value(input, 'loaded')).toBe('false');
  expect(value(input, 'firobjectused')).toBe('false');
  expect(value(input, 'ntaps')).toBe('4500');
  expect(input.querySelectorAll('coefficient')).toHaveLength(0);
  expect(output.getAttribute('enabled')).toBe('true');
  expect(value(output, 'loaded')).toBe('false');
  expect(value(output, 'firobjectused')).toBe('true');
  expect(output.querySelectorAll('coefficient')).toHaveLength(1500);
  expect(
    [...output.querySelectorAll('coefficient')].every(
      (coefficient) => coefficient.getAttribute('value') === '0',
    ),
  ).toBe(true);
  const imported = parseProject(new XMLSerializer().serializeToString(doc));
  expect(imported.presets[0].inputFir).toMatchObject({
    enabled: true,
    hfdState: { loaded: false, used: false, tapCount: 4500 },
  });
  expect(imported.presets[0].inputFir.taps).toEqual(Array(4500).fill(0));
  expect(imported.presets[0].channels[0].fir).toMatchObject({
    enabled: true,
    hfdState: { loaded: false, used: true, tapCount: 1500 },
  });
  expect(presetResponse(imported.presets[0], 0, 1000)[0]).toBeCloseTo(1, 12);
});

it('normalizes native XML Loaded using Used/parse-success/nonblank filename, while JSON retains complete inactive runtime caches', () => {
  const project = newProject();
  project.presets[0] = fixture();
  const json = parseProject(JSON.stringify(project));
  expect(json.presets[0].inputFir.hfdState!.loaded).toBe(true);
  expect(json.presets[0].inputFir.taps[0]).toBe(0.5);
  const doc = xml(project),
    input = node(doc, true),
    output = node(doc);
  expect(value(input, 'loaded')).toBe('true');
  expect(input.querySelectorAll('coefficient')).toHaveLength(0);
  output.querySelector('loaded')!.setAttribute('value', 'false');
  let imported = parseProject(new XMLSerializer().serializeToString(doc));
  expect(imported.presets[0].inputFir.hfdState!.loaded).toBe(false);
  expect(imported.presets[0].inputFir.taps).toEqual(Array(4500).fill(0));
  expect(imported.presets[0].channels[0].fir.hfdState!.loaded).toBe(true);
  output.querySelector('filename')!.setAttribute('value', ' \t ');
  imported = parseProject(new XMLSerializer().serializeToString(doc));
  expect(imported.presets[0].channels[0].fir.hfdState!.loaded).toBe(false);
  expect(imported.presets[0].channels[0].fir.enabled).toBe(true);
});

it('uses exact-file sidecars to preserve runtime Clear caches while native-only import follows HFD normalization', () => {
  const project = newProject();
  project.presets[0] = fixture();
  clearNativeFir(project.presets[0], 0);
  const files = projectFiles(project),
    restored = importProjectFolder(files),
    nativeOnly = importProjectFolder(files.filter((file) => file.path !== 'FusionProject.json'));
  expect(restored.presets[0]).toEqual(project.presets[0]);
  expect(restored.presets[0].inputFir.taps).toEqual([]);
  expect(nativeOnly.presets[0].inputFir.taps).toEqual(Array(4500).fill(0));
  expect(nativeOnly.presets[0].inputFir.hfdState!.loaded).toBe(false);
});

it('preserves native small and zero-count loaded caches without qualifying them for the ordinary hardware writer', () => {
  for (const count of [0, 10]) {
    const project = newProject(),
      p = project.presets[0];
    p.firPlacement = 'output';
    p.channels[0].fir = {
      name: 'Native.txt',
      enabled: true,
      taps: taps(count),
      hfdState: { loaded: true, used: true, tapCount: count },
    };
    const restored = parseProject(JSON.stringify(project));
    expect(restored.presets[0].channels[0].fir).toEqual(p.channels[0].fir);
    const imported = parseProject(exportHfd(project));
    expect(imported.presets[0].channels[0].fir).toEqual(p.channels[0].fir);
    expect(Number.isFinite(presetResponse(imported.presets[0], 0, 1000)[0])).toBe(true);
    expect(Number.isFinite(presetImpulse(imported.presets[0], 0, 16)[0])).toBe(true);
    expect(() => planFirActivation(p, 0)).toThrow(/1500 original taps/);
  }
});

it('does not manufacture active original samples from missing, malformed or duplicate coefficient records', () => {
  const project = newProject();
  project.presets[0] = fixture();
  for (const malformed of ['missing', 'value', 'index', 'duplicate', 'nonfinite']) {
    const doc = xml(project),
      output = node(doc),
      coefficient = output.querySelector('coefficient')!;
    if (malformed === 'missing') coefficient.remove();
    else if (malformed === 'value') coefficient.removeAttribute('value');
    else if (malformed === 'index') coefficient.removeAttribute('index');
    else if (malformed === 'duplicate') output.appendChild(coefficient.cloneNode(true));
    else coefficient.setAttribute('value', 'Infinity');
    expect(() => parseProject(new XMLSerializer().serializeToString(doc))).toThrow(/coefficients/);
  }
});

it('prevalidates the shared native action shape before mutation', () => {
  const p = fixture(),
    before = structuredClone(p);
  for (const action of [
    null,
    { kind: 'clear', output: 0 },
    { kind: 'clear', output: 1, enabled: false },
    { kind: 'enabled', channel: 2 },
    { kind: 'placement', placement: 'other' },
  ]) {
    expect(() => applyNativeFirAction(p, action as never)).toThrow(/native FIR/);
    expect(p).toEqual(before);
  }
});

it('plans native latent enabled bits with the shared FIR-transfer gate and preserves inactive enable ownership', () => {
  const p = fixture();
  clearNativeFir(p, 0);
  expect(planFirActivation(p, 0x88)).toMatchObject({ placement: 1, anyLoaded: true, flags: 0x2b });
  // Now all selected banks are unloaded. Latent project flags stay true while
  // native successful activation clears selected bits without a FIR transfer.
  clearNativeFir(p, 1);
  expect(p.channels[0].fir.enabled).toBe(true);
  expect(planFirActivation(p, 0xff)).toMatchObject({ placement: 1, anyLoaded: false, flags: 8 });
  selectNativeFirPlacement(p, 'input');
  expect(planFirActivation(p, 0xff)).toMatchObject({ placement: 0, anyLoaded: false, flags: 7 });
});

it('keeps legacy invalid enabled-empty rejection and rejects incomplete marked loaded data before any device query', async () => {
  for (const marked of [false, true]) {
    const p = newProject().presets[0],
      panel = new SimulatedPanel(),
      session = new PanelSession(panel, async () => {});
    p.inputFir.enabled = true;
    if (marked) p.inputFir.hfdState = { loaded: true, used: true, tapCount: 4500 };
    expect(
      projectSchema.safeParse({ ...newProject(), presets: [p, ...newProject().presets.slice(1)] })
        .success,
    ).toBe(!marked);
    await expect(
      uploadFir(
        session,
        1,
        p,
        () => {},
        async () => {},
      ),
    ).rejects.toThrow(/taps|source data/);
    expect(panel.requests).toHaveLength(0);
  }
});

it('uploads Clear as settings-only, preserves every flash/filename byte, and supports explicit exact recovery from its backup', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const panel = new SimulatedPanel(),
    session = new PanelSession(panel, async () => {}),
    p = newProject().presets[0];
  p.inputFir = native(4500);
  panel.status[28] = 0x88;
  panel.memory.fill(0x5a, 0x10000, 0x16000);
  panel.eeprom.fill(77, 0x200, 0x280);
  const original = panel.memory.slice(),
    names = panel.eeprom.slice(0x200, 0x280);
  clearNativeFir(p, 0);
  const saved: FirBackup[] = [],
    backup = await finish(
      uploadFir(
        session,
        1,
        p,
        () => {},
        async (value) => {
          saved.push(value);
        },
      ),
    );
  expect(saved).toHaveLength(1);
  expect(panel.status[28]).toBe(0);
  expect(p.inputFir.enabled).toBe(true);
  expect(panel.requests.filter((request) => request[0] === 0x64)).toHaveLength(0);
  expect(panel.writes).toBe(0);
  expect(panel.memory).toEqual(original);
  expect(panel.eeprom.slice(0x200, 0x280)).toEqual(names);
  const read = await finish(readFir(session, 1, async () => {}));
  expect(read.filters[0].hfdState).toEqual({ loaded: false, used: true, tapCount: 4500 });
  await finish(
    restoreFir(
      session,
      backup!,
      () => {},
      async () => {},
    ),
  );
  expect(panel.status[28]).toBe(0x88);
  expect(panel.memory).toEqual(original);
  expect(panel.eeprom.slice(0x200, 0x280)).toEqual(names);
});

it('refuses a settings-only Clear when durable backup fails, before any mute/settings/flash mutation', async () => {
  const panel = new SimulatedPanel(),
    session = new PanelSession(panel, async () => {}),
    p = newProject().presets[0];
  p.inputFir = native(4500);
  clearNativeFir(p, 0);
  panel.status[28] = 0x88;
  const status = panel.status.slice();
  await expect(
    uploadFir(
      session,
      1,
      p,
      () => {},
      async () => {
        throw new Error('Backup unavailable');
      },
    ),
  ).rejects.toThrow(/Backup/);
  expect(panel.status).toEqual(status);
  expect(
    panel.requests.some((request) => request[0] === 0x64 || (request[0] === 5 && request[1] === 0)),
  ).toBe(false);
});

it('keeps a mixed-bank failure muted with an intact native Clear design and an exact usable recovery image', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const panel = new SimulatedPanel(),
    peer = new SimulatedPanel('UNTOUCHED'),
    session = new PanelSession(panel, async () => {}),
    p = fixture();
  clearNativeFir(p, 0);
  panel.status[28] = 0x88;
  const original = panel.memory.slice(),
    originalNames = panel.eeprom.slice(0x200, 0x280),
    design = structuredClone(p),
    saved: FirBackup[] = [];
  panel.failAtPage = 0x12000;
  await expect(
    finish(
      uploadFir(
        session,
        1,
        p,
        () => {},
        async (b) => {
          saved.push(b);
        },
      ),
    ),
  ).rejects.toThrow(/page failure/);
  expect(saved).toHaveLength(1);
  expect(session.lastStatus!.muted).toBe(true);
  expect(p).toEqual(design);
  expect(peer.requests).toHaveLength(0);
  expect(
    panel.requests.some(
      (request) =>
        request[0] === 0x64 &&
        request[1] === 4 &&
        (request[2] | (request[3] << 8) | (request[4] << 16)) === 0x10000,
    ),
  ).toBe(false);
  panel.failAtPage = undefined;
  await finish(
    restoreFir(
      session,
      saved[0],
      () => {},
      async () => {},
    ),
  );
  expect(panel.memory).toEqual(original);
  expect(panel.eeprom.slice(0x200, 0x280)).toEqual(originalNames);
  expect(panel.status[28]).toBe(0x88);
  expect(session.lastStatus!.muted).toBe(true);
});

it('retains native Clear and mixed-bank flags through the real coordinated all-preset path without erasing cleared FIR banks', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const project = newProject(),
    panel = new SimulatedPanel(),
    backups: Backup[] = [],
    session = new PanelSession(panel, async (backup) => {
      backups.push(backup);
    });
  project.presets[0].inputFir = native(4500);
  clearNativeFir(project.presets[0], 0);
  project.presets[1] = fixture();
  clearNativeFir(project.presets[1], 0);
  project.presets[2].inputFir = native(4500);
  clearNativeFir(project.presets[2], 2);
  panel.status.set([0x88, 0x88, 0x65], 28);
  const firBefore = panel.memory.slice(0x10000, 0x22000);
  await finish(uploadProjectPair([{ session, name: 'Native clear', presets: project.presets }]));
  expect(backups).toHaveLength(3);
  expect([...panel.status.slice(28, 31)]).toEqual([0, 0x2b, 5]);
  const firErases = panel.requests
    .filter((request) => request[0] === 0x64 && request[1] === 4)
    .map((request) => request[2] | (request[3] << 8) | (request[4] << 16))
    .filter((address) => address >= 0x10000 && address < 0x22000);
  expect(firErases).toEqual([0x18000, 0x19000]);
  expect(panel.memory.slice(0x10000, 0x18000)).toEqual(firBefore.slice(0, 0x8000));
  expect(panel.memory.slice(0x1a000, 0x22000)).toEqual(firBefore.slice(0xa000));
});

it('preflights both roles before mutations when a peer has an invalid native loaded bank', async () => {
  const left = new SimulatedPanel('CLEAR-LEFT'),
    right = new SimulatedPanel('CLEAR-RIGHT'),
    a = newProject(),
    b = newProject();
  a.presets[0].inputFir = native(4500);
  clearNativeFir(a.presets[0], 0);
  b.presets[1].inputFir = {
    name: 'Missing',
    enabled: true,
    taps: [],
    hfdState: { loaded: true, used: true, tapCount: 4500 },
  };
  await expect(
    uploadProjectPair([
      { session: new PanelSession(left, async () => {}), name: 'A', presets: a.presets },
      { session: new PanelSession(right, async () => {}), name: 'B', presets: b.presets },
    ]),
  ).rejects.toThrow(/Nothing programmed/);
  for (const panel of [left, right])
    expect(
      panel.requests.some(
        (request) => request[0] === 0x64 || (request[0] === 5 && request[1] === 0),
      ),
    ).toBe(false);
});

it('clears independent left/right presets in one atomic Undo entry while bypassing ordinary link propagation', async () => {
  const documents = { left: newProject('Left'), right: newProject('Right') };
  documents.left.presets[0] = fixture();
  documents.right.presets[0] = fixture();
  documents.left.presets[0].channels[0].linkedTo = 1;
  documents.right.presets[0].channels[0].fir.enabled = false;
  let envelope: WorkspaceEnvelope = {
    version: 1,
    state: {
      documents,
      slot: 'left',
      preset: 0,
      channel: 0,
      filter: 0,
      linkedEdits: true,
      linkedControls: true,
      documentRevision: 0,
    },
  };
  const { store, persistence } = createWorkspaceStore({
    read: async () => structuredClone(envelope),
    readLegacy: () => null,
    write: async (next, expected) => {
      assertWorkspaceWrite(envelope, expected, next);
      envelope = structuredClone(next);
    },
  });
  await persistence.hydrate();
  const before = structuredClone(store.getState().documents);
  store.getState().editAt(['left', 'right'], (project) => clearNativeFir(project.presets[0], 0), {
    synchronizeLinks: false,
  });
  const after = structuredClone(store.getState().documents);
  expect(after.left.presets[0].channels[0].fir.hfdState!.loaded).toBe(false);
  expect(after.left.presets[0].channels[1].fir.hfdState!.loaded).toBe(true);
  expect(after.left.presets[0].channels[0].fir.enabled).toBe(true);
  expect(after.right.presets[0].channels[0].fir.enabled).toBe(false);
  expect(store.getState().past).toHaveLength(1);
  store.getState().undo();
  expect(store.getState().documents).toEqual(before);
  store.getState().redo();
  expect(store.getState().documents).toEqual(after);
  await persistence.flush();
});
