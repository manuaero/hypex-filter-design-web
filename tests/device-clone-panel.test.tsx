// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import DeviceClonePanel, { type DeviceClonePanelProps } from '../src/components/DeviceClonePanel';
import {
  DeviceCloneError,
  type DeviceCloneController,
  type DeviceCloneReview,
  type DeviceCloneSnapshot,
  type DeviceCloneSummary,
  type DeviceCloneTarget,
} from '../src/application/device-clone';
import {
  CLONE_PHASES,
  type CloneJournalRecord,
  type CloneOverrides,
} from '../src/application/device-clone-storage';
import { newProject, type Slot } from '../src/domain/model';
import {
  captureNativeCloneTemplate,
  type CloneCaptureSnapshot,
} from '../src/hardware/clone-capture';
import { buildClonePlan, type DeviceClonePlan } from '../src/hardware/clone-plan';
import {
  decodeEq,
  decodeStatus,
  encodeEq,
  packet,
  presetBase,
  settings,
} from '../src/hardware/codec';
import { decodeHardwareOverview, decodeLimiter } from '../src/hardware/device-settings';
import { SimulatedPanel } from '../src/hardware/simulator';
import { firLayout } from '../src/hardware/fir';

const files = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('../src/domain/files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/domain/files')>()),
  download: files.download,
}));
const firstActor = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'ui:first' },
  secondActor = { ...firstActor, scope: 'ui:current' },
  id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const targets = (target: DeviceCloneTarget): Slot[] =>
  target === 'both' ? ['left', 'right'] : [target];
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let host: HTMLDivElement,
  root: Root,
  unmounted = false;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  unmounted = false;
  files.download.mockReset();
});
afterEach(async () => {
  if (!unmounted) await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
/** Memory-only test data. No PanelSession, device chooser, filesystem or audio backend is used. */
function source(slot: Slot): CloneCaptureSnapshot {
  const panel = new SimulatedPanel(`H05U-SYNTHETIC-${slot}`),
    project = newProject(`${slot} physical`);
  panel.configuration[5] = 3;
  panel.configuration[12] = 3;
  panel.deviceConfiguration[11] = 9;
  panel.deviceConfiguration[13] = 1;
  panel.status[9] = 9;
  new DataView(panel.status.buffer).setInt16(3, slot === 'left' ? -625 : -1250, true);
  for (const p of [1, 2, 3])
    panel.memory.set(encodeEq(project.presets[p - 1].inputEq), presetBase(p) + 0x3000);
  return {
    identity: { serial: panel.serial, product: 22, core: '5.1', firmware: '5.7' },
    status: panel.status.slice(),
    configuration: panel.configuration.slice(),
    deviceConfiguration: panel.deviceConfiguration.slice(),
    dspName: packet(3, 8, ...new TextEncoder().encode(`Previous ${slot}`)),
    serial: panel.eeprom.slice(0x100, 0x120),
    flash: Array.from({ length: 24 }, (_, i) => ({
      address: 0x10000 + i * 4096,
      bytes: panel.memory.slice(0x10000 + i * 4096, 0x11000 + i * 4096),
    })),
    filenames: [1, 2, 3].flatMap((p) =>
      firLayout(p).names.map((address) => ({
        address,
        bytes: panel.eeprom.slice(address, address + 32),
      })),
    ),
    mixerConfiguration: packet(0x67),
    productStrings: { hypexName: new Uint8Array(32), oemName: new Uint8Array(32) },
  };
}
function summary(raw: CloneCaptureSnapshot, plan?: DeviceClonePlan): DeviceCloneSummary {
  const status = plan ? plan.presetActivations[2].request : raw.status,
    device = plan
      ? plan.reports.find((r) => r.id === 'configuration')!.request
      : raw.deviceConfiguration,
    flash = plan
      ? plan.desired.flash.map((s) => ({
          address: s.address,
          bytes: Uint8Array.from(Buffer.from(s.hex, 'hex')),
        }))
      : raw.flash,
    find = (address: number) => flash.find((s) => s.address === address)!.bytes;
  return {
    dspName: plan?.dspName ?? `Previous ${raw.identity.serial.endsWith('left') ? 'left' : 'right'}`,
    preset: status[2],
    volume: decodeStatus(status).volume,
    muted: !!(status[6] & 128),
    channelMutes: decodeStatus(status).channelMutes,
    settings: settings(decodeStatus(status)),
    hardware: decodeHardwareOverview(raw.configuration, device),
    limiter: decodeLimiter(device).channels.map((c) => ({
      ...c,
      attackMs: Number.isFinite(c.attackMs) ? c.attackMs : null,
      releaseMs: Number.isFinite(c.releaseMs) ? c.releaseMs : null,
    })),
    presets: [1, 2, 3].map((p) => ({
      source: status[11 + p] & 15,
      sourceLock: !!(status[11 + p] & 128),
      volumeLock: !!(status[11 + p] & 32),
      eqEnabled: !!(status[11 + p] & 16),
      adcOutput: !!(status[11 + p] & 64),
      firFlags: status[27 + p],
      firPlacement: ((status[31] >> (p - 1)) & 1) as 0 | 1,
    })),
    eqBanks: [1, 2, 3].map((p) => ({
      preset: p,
      sha256: sha(find(presetBase(p) + 0x3000)),
      bands: decodeEq(find(presetBase(p) + 0x3000)),
    })),
    iirBanks: [1, 2, 3].map((p) => ({ preset: p, sha256: sha(find(presetBase(p))) })),
    firBanks: [1, 2, 3].map((p) => ({
      preset: p,
      flags: status[27 + p],
      placement: ((status[31] >> (p - 1)) & 1) as 0 | 1,
      filenames: firLayout(p).names.map((address) => ({ address, name: `FIR ${address}` })),
      sectors: firLayout(p).sectors.map((address) => ({ address, sha256: sha(find(address)) })),
    })),
  };
}
function fixture() {
  const raw = { left: source('left'), right: source('right') },
    projects = { left: newProject('Left design'), right: newProject('Right design') },
    plans = new Map<Slot, DeviceClonePlan>();
  for (const slot of ['left', 'right'] as const)
    projects[slot].hfdCloneTemplate = captureNativeCloneTemplate(
      raw[slot],
      '2026-11-14T20:00:00.000Z',
    );
  let snapshot: DeviceCloneSnapshot = {
      phase: 'ready',
      busy: false,
      revision: 0,
      roles: {
        left: { connected: true, identity: raw.left.identity },
        right: { connected: true, identity: raw.right.identity },
      },
      records: [],
    },
    counter = 0;
  const listeners = new Set<() => void>(),
    publish = (patch: Partial<DeviceCloneSnapshot>) => {
      snapshot = { ...snapshot, ...patch };
      listeners.forEach((fn) => fn());
    },
    overrides = (slot: Slot): CloneOverrides =>
      snapshot.roles[slot].overrides ?? {
        mode: 'master',
        presets: Array.from({ length: 3 }, () => ({
          forceInput: 0,
          sourceLock: false,
          volumeLock: false,
        })),
      };
  const review = vi.fn<DeviceCloneController['review']>(async (target, _actor, input) => {
    if (input.expectedRevision !== snapshot.revision) throw new Error('Stale review revision');
    const roles: DeviceCloneReview['roles'] = [];
    for (const slot of targets(target)) {
      const draft = structuredClone(overrides(slot)),
        plan = await buildClonePlan(
          projects[slot],
          projects[slot].hfdCloneTemplate!,
          raw[slot],
          draft,
        );
      plans.set(slot, plan);
      roles.push({
        slot,
        identity: raw[slot].identity,
        projectName: projects[slot].name,
        templateProvenance: projects[slot].hfdCloneTemplate!.provenance,
        documentRevision: slot === 'left' ? 7 : 19,
        templateRevision: slot === 'left' ? 2 : 5,
        overrides: draft,
        before: summary(raw[slot]),
        after: summary(raw[slot], plan),
        steps: [...CLONE_PHASES],
        warnings: [...plan.warnings],
      });
    }
    const result = {
      id: id(++counter),
      target,
      revision: snapshot.revision,
      createdAt: 100,
      roles,
    };
    publish({ activeReview: result });
    return result;
  });
  const makeRecord = (
    review: DeviceCloneReview,
    phase: 'complete' | 'partial' = 'complete',
  ): CloneJournalRecord => ({
    id: review.id,
    owner: firstActor.owner,
    scope: firstActor.scope,
    target: review.target,
    templateSha256: 'ab'.repeat(32),
    designSha256: 'cd'.repeat(32),
    documentRevision: 19,
    templateRevision: 5,
    overrideRevision: review.revision,
    createdAt: 100,
    updatedAt: 101,
    phase,
    roles: review.roles.map((role, index) => ({
      slot: role.slot,
      identity: role.identity,
      documentRevision: role.documentRevision,
      templateRevision: role.templateRevision,
      overrides: role.overrides,
      before: plans.get(role.slot)!.before,
      desired: plans.get(role.slot)!.desired,
      preflight: 'verified',
      lastConfirmedMuted: index === 0 ? true : null,
      steps: CLONE_PHASES.map((id, i) => ({
        id,
        attempted: id !== 'product-configuration' && (phase === 'complete' || i < 3),
        state:
          id === 'product-configuration'
            ? 'skipped'
            : phase === 'complete'
              ? 'verified'
              : i < 2
                ? 'verified'
                : i === 2
                  ? 'unconfirmed'
                  : 'pending',
      })),
    })),
  });
  const apply = vi.fn<DeviceCloneController['apply']>(async (reviewId, _actor, confirm) => {
    if (!confirm.confirm || snapshot.activeReview?.id !== reviewId)
      throw new Error('Invalid review');
    const record = makeRecord(snapshot.activeReview);
    publish({
      activeReview: undefined,
      records: [...snapshot.records, record],
      latestOutcome: { record, persistence: 'verified' },
    });
    return record;
  });
  const controller: DeviceCloneController = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    hydrate: vi.fn(async () => {
      publish({ phase: 'ready' });
    }),
    status: vi.fn(() => snapshot),
    reload: vi.fn(async () => {
      publish({ activeReview: undefined, revision: snapshot.revision + 1 });
      return snapshot;
    }),
    editOverrides: vi.fn((target, _actor, input) => {
      if (input.expectedRevision !== snapshot.revision) throw new Error('Stale edit revision');
      const roles = { ...snapshot.roles };
      for (const slot of targets(target))
        roles[slot] = { ...roles[slot], overrides: structuredClone(input.overrides) };
      publish({ roles, revision: snapshot.revision + 1, activeReview: undefined });
      return snapshot;
    }),
    review,
    apply,
    discard: vi.fn(() => {
      publish({ activeReview: undefined });
    }),
    exportRecord: vi.fn((recordId) => {
      const found = snapshot.records.find((record) => record.id === recordId);
      if (!found) throw new Error('Unavailable record');
      return { ...found, exportPersistence: 'verified' as const };
    }),
    refreshBindings: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    controller,
    projects,
    raw,
    review,
    apply,
    publish,
    makeRecord,
    get snapshot() {
      return snapshot;
    },
  };
}
async function render(f: ReturnType<typeof fixture>, props: Partial<DeviceClonePanelProps> = {}) {
  await act(async () =>
    root.render(
      <DeviceClonePanel
        controller={f.controller}
        slot="left"
        connectedRoles={['left', 'right']}
        getContext={() => firstActor}
        projects={f.projects}
        {...props}
      />,
    ),
  );
}
function button(text: string) {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  expect(found, text).toBeDefined();
  return found!;
}
function select(label: string) {
  const found = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  expect(found, label).not.toBeNull();
  return found!;
}
async function choose(label: string, value: string) {
  await act(async () => {
    const control = select(label);
    control.value = value;
    control.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function reviewClone(f: ReturnType<typeof fixture>) {
  await click('Review clone');
  const pending = f.review.mock.results.at(-1)?.value;
  expect(pending).toBeDefined();
  // Native-plan hashing uses async WebCrypto; await the actual operation, not a timer.
  await act(async () => {
    await pending;
  });
}
async function confirm() {
  const input = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => input.click());
}

it('renders cached source provenance without automatically reading devices, reviewing or applying', async () => {
  const f = fixture();
  await render(f);
  expect(host.textContent).toContain('Captured device');
  expect(host.textContent).toContain('H05U-SYNTHETIC-left');
  expect(host.textContent).toContain('Left design');
  expect(f.controller.reload).not.toHaveBeenCalled();
  expect(f.review).not.toHaveBeenCalled();
  expect(f.apply).not.toHaveBeenCalled();
  expect(host.querySelector('button')?.textContent).not.toBe('Run');
});
it('edits only the selected role through the shared latest revision and exact native mode-specific menus', async () => {
  const f = fixture();
  await render(f);
  expect([...select('Left preset 1 source').options].map((o) => o.value)).toEqual([
    '0',
    '1',
    '2',
    '5',
    '4',
    '6',
    '7',
  ]);
  await choose('Left Clone mode', 'slave');
  expect(select('Left preset 1 source').value).toBe('1');
  expect([...select('Left preset 1 source').options].map((o) => o.value)).toEqual([
    '1',
    '2',
    '5',
    '4',
    '6',
    '7',
  ]);
  await choose('Left preset 2 source', '4');
  expect(f.snapshot.roles.left.overrides!.presets[1].forceInput).toBe(4);
  expect(f.snapshot.roles.right.overrides).toBeUndefined();
  expect(f.controller.editOverrides).toHaveBeenLastCalledWith('left', firstActor, {
    expectedRevision: 1,
    overrides: f.snapshot.roles.left.overrides,
  });
});
it('shows both independent role editors and keeps per-role metadata/overrides distinct', async () => {
  const f = fixture();
  await render(f);
  await choose('Clone target', 'both');
  expect(host.querySelectorAll('section[aria-label$="Clone overrides"]')).toHaveLength(2);
  await choose('Right preset 3 source', '7');
  expect(f.snapshot.roles.right.overrides!.presets[2].forceInput).toBe(7);
  expect(f.snapshot.roles.left.overrides).toBeUndefined();
  expect(host.textContent).toContain("Both applies each amplifier's own project");
});
it('requires an explicit capture and supports native XML/folder callbacks without applying', async () => {
  const f = fixture(),
    exportNative = vi.fn();
  await render(f, { onExportNative: exportNative });
  await click('Capture / Reload settings');
  expect(f.controller.reload).toHaveBeenCalledExactlyOnceWith('left', firstActor);
  await click('Left captured XML');
  await click('Left captured folder');
  expect(exportNative.mock.calls).toEqual([
    ['left', 'xml'],
    ['left', 'folder'],
  ]);
  expect(f.apply).not.toHaveBeenCalled();
});
it('replaces the editor with a fixed two-role before/after review and cancels back to the editor', async () => {
  const f = fixture();
  await render(f);
  await choose('Clone target', 'both');
  await reviewClone(f);
  expect(f.review).toHaveBeenCalledExactlyOnceWith('both', firstActor, { expectedRevision: 0 });
  expect(host.textContent).toContain('design 7, template 2');
  expect(host.textContent).toContain('design 19, template 5');
  expect(host.querySelectorAll('section[aria-label$="Clone overrides"]')).toHaveLength(0);
  expect(host.querySelectorAll('select[aria-label$="source"]')).toHaveLength(0);
  expect(button('Apply clone').disabled).toBe(true);
  for (const category of ['General', 'Limiter', 'Hardware', 'Settings']) {
    await click(category);
    expect(host.querySelector('[role="tabpanel"]')?.getAttribute('aria-label')).toBe(
      `${category} before and after`,
    );
    expect(host.querySelector('thead')?.textContent).toContain('BeforePlanned');
  }
  await click('Cancel review');
  expect(host.querySelectorAll('section[aria-label$="Clone overrides"]')).toHaveLength(2);
  expect(f.apply).not.toHaveBeenCalled();
});
it('binds confirmation to the exact current review and uses the current trusted actor at Apply', async () => {
  const f = fixture();
  await render(f);
  await reviewClone(f);
  await confirm();
  expect(button('Apply clone').disabled).toBe(false);
  await render(f, { getContext: () => secondActor });
  await click('Apply clone');
  expect(f.apply).toHaveBeenCalledExactlyOnceWith(id(1), secondActor, { confirm: true });
  expect(host.textContent).toContain('Verified clone completion');
  expect(files.download).not.toHaveBeenCalled();
  await reviewClone(f);
  expect(button('Apply clone').disabled).toBe(true);
  expect(host.querySelector('input[type="checkbox"]')?.getAttribute('checked')).not.toBe('true');
});
it('reflects external shared-controller edits and invalidates old review confirmation', async () => {
  const f = fixture();
  await render(f);
  await reviewClone(f);
  await confirm();
  await act(async () => {
    f.controller.editOverrides('left', secondActor, {
      expectedRevision: 0,
      overrides: {
        mode: 'slave',
        presets: Array.from({ length: 3 }, () => ({
          forceInput: 5,
          sourceLock: true,
          volumeLock: false,
        })),
      },
    });
  });
  expect(select('Left Clone mode').value).toBe('slave');
  expect(select('Left preset 1 source').value).toBe('5');
  expect(f.apply).not.toHaveBeenCalled();
  await reviewClone(f);
  expect(button('Apply clone').disabled).toBe(true);
});
it('disables capture/review for missing selected connections and leaves offline native export available', async () => {
  const f = fixture(),
    exportNative = vi.fn();
  await render(f, { connectedRoles: ['left'], onExportNative: exportNative });
  await choose('Clone target', 'both');
  expect(button('Review clone').disabled).toBe(true);
  expect(button('Capture / Reload settings').disabled).toBe(true);
  expect(button('Right captured XML').disabled).toBe(false);
  expect(f.review).not.toHaveBeenCalled();
});
it('keeps missing or unsupported saved template sources explicit without auto-normalizing them', async () => {
  const f = fixture();
  delete f.projects.left.hfdCloneTemplate;
  await render(f);
  expect(host.textContent).toContain('No captured template');
  expect(button('Review clone').disabled).toBe(true);
  expect(button('Capture / Reload settings').disabled).toBe(false);
  f.projects.left.hfdCloneTemplate = captureNativeCloneTemplate(f.raw.left);
  f.projects.left.hfdCloneTemplate.settings.presets[0].forceInput = 3;
  await render(f);
  expect(select('Left preset 1 source').selectedOptions[0].disabled).toBe(true);
  expect(select('Left preset 1 source').value).toBe('3');
  expect(button('Review clone').disabled).toBe(true);
  expect(f.controller.editOverrides).not.toHaveBeenCalled();
});
it('blocks duplicate Apply while pending and does not show a late previous-role result in the new context', async () => {
  const f = fixture(),
    hold = deferred<CloneJournalRecord>();
  f.apply.mockImplementationOnce(() => hold.promise);
  await render(f);
  await reviewClone(f);
  const reviewed = f.snapshot.activeReview!;
  await confirm();
  await act(async () => {
    button('Apply clone').click();
    button('Apply clone').click();
  });
  expect(f.apply).toHaveBeenCalledTimes(1);
  await render(f, { slot: 'right' });
  await act(async () => {
    f.publish({ activeReview: undefined });
    hold.resolve(f.makeRecord(reviewed));
  });
  expect(host.textContent).not.toContain('Verified clone completion');
  expect(host.textContent).not.toContain('Clone completed and its recovery record was verified');
});
it('retains consumed partial outcomes and tri-state mute without offering an automatic retry', async () => {
  const f = fixture();
  await render(f);
  await choose('Clone target', 'both');
  await reviewClone(f);
  const partial = f.makeRecord(f.snapshot.activeReview!, 'partial');
  f.apply.mockImplementationOnce(async () => {
    f.publish({
      activeReview: undefined,
      records: [partial],
      latestOutcome: { record: partial, persistence: 'unavailable' },
    });
    throw new DeviceCloneError('Synthetic lost ACK', partial, 'unavailable');
  });
  await confirm();
  await click('Apply clone');
  expect(host.textContent).toContain('Unconfirmed');
  expect(host.textContent).toContain('Unknown');
  expect(host.textContent).toContain('Journal persistence is unconfirmed');
  expect(host.textContent).toContain('This request is consumed');
  expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Retry clone')).toBe(
    false,
  );
  expect(f.apply).toHaveBeenCalledTimes(1);
});
it('exports a selected local recovery journal only on explicit action and bounds visible history', async () => {
  const f = fixture();
  await render(f);
  await reviewClone(f);
  const record = f.makeRecord(f.snapshot.activeReview!);
  await act(async () =>
    f.publish({
      activeReview: undefined,
      records: Array.from({ length: 9 }, (_, i) => ({ ...record, id: id(i + 20) })),
    }),
  );
  expect(files.download).not.toHaveBeenCalled();
  expect(
    [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Export record'),
  ).toHaveLength(5);
  await click('Show older records');
  expect(
    [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Export record'),
  ).toHaveLength(9);
  await click('Export record');
  expect(files.download).toHaveBeenCalledOnce();
  expect(f.controller.exportRecord).toHaveBeenCalledWith(id(28), firstActor);
  expect(files.download.mock.calls[0][0]).toBe(`Clone-${id(28)}.json`);
  const exported = JSON.parse(files.download.mock.calls[0][1]);
  expect(exported.id).toBe(id(28));
  expect(exported.exportPersistence).toBe('verified');
});

it('pairs variable EQ details by stable field identity, never by the next preset array position', async () => {
  const f = fixture();
  await render(f);
  await reviewClone(f);
  const review = structuredClone(f.snapshot.activeReview!);
  delete review.roles[0].before.eqBanks[0].bands;
  review.roles[0].before.eqBanks[0].reason = 'Erased EQ page';
  await act(async () => f.publish({ activeReview: review }));
  const find = (name: string) =>
    [...host.querySelectorAll('tbody tr')].find(
      (row) => row.querySelector('th')?.textContent === `Left${name}`,
    )!;
  const band = find('P1 EQ 1');
  expect(band).toBeDefined();
  expect(band.querySelectorAll('td')[0].textContent).toBe('Unavailable');
  expect(band.querySelectorAll('td')[1].textContent).toContain(
    `${review.roles[0].after.eqBanks[0].bands![0].frequency} Hz`,
  );
  const p2 = find('P2 EQ 1');
  expect(p2.querySelectorAll('td')[0].textContent).toContain(
    `${review.roles[0].before.eqBanks[1].bands![0].frequency} Hz`,
  );
  expect(find('P1 EQ metadata').querySelectorAll('td')[0].textContent).toBe('Erased EQ page');
  expect(find('P1 EQ metadata').querySelectorAll('td')[1].textContent).toBe('9 bands');
});

it('exports an invalid captured template for inspection without allowing a programming review or including draft overrides', async () => {
  const f = fixture(),
    exportNative = vi.fn();
  f.projects.left.hfdCloneTemplate!.configuration.valid = false;
  await render(f, { onExportNative: exportNative });
  expect(button('Review clone').disabled).toBe(true);
  expect(button('Left captured XML').disabled).toBe(false);
  expect(host.textContent).toContain('captured template is marked invalid');
  expect(host.textContent).toContain('Draft Clone overrides are excluded');
  await click('Left captured XML');
  expect(exportNative).toHaveBeenCalledExactlyOnceWith('left', 'xml');
  expect(f.review).not.toHaveBeenCalled();
  expect(f.apply).not.toHaveBeenCalled();
});

it('blocks all consequential actions until the trusted context is ready and while another hardware operation owns the UI', async () => {
  const f = fixture(),
    getContext = vi.fn(() => firstActor);
  await render(f, { contextReady: false, getContext });
  expect(button('Review clone').disabled).toBe(true);
  expect(button('Capture / Reload settings').disabled).toBe(true);
  expect(getContext).not.toHaveBeenCalled();
  await render(f);
  await reviewClone(f);
  await confirm();
  expect(button('Apply clone').disabled).toBe(false);
  await render(f, { externalBusy: true });
  expect(button('Apply clone').disabled).toBe(true);
  await click('Apply clone');
  expect(f.apply).not.toHaveBeenCalled();
});

it.each(['complete', 'partial'] as const)(
  'shows a new external MCP %s outcome automatically without a human Apply handler',
  async (phase) => {
    const f = fixture();
    await render(f);
    if (phase === 'partial')
      f.apply.mockImplementationOnce(async () => {
        const record = f.makeRecord(f.snapshot.activeReview!, 'partial');
        f.publish({
          activeReview: undefined,
          records: [record],
          latestOutcome: { record, persistence: 'unavailable' },
        });
        throw new DeviceCloneError('External lost ACK', record, 'unavailable');
      });
    await act(async () => {
      const reviewed = await f.controller.review('both', secondActor, { expectedRevision: 0 });
      try {
        await f.controller.apply(reviewed.id, secondActor, { confirm: true });
      } catch (error) {
        if (phase === 'complete') throw error;
      }
    });
    const outcome = host.querySelector('[aria-label="Clone outcome"]');
    expect(outcome).not.toBeNull();
    expect(outcome!.textContent).toContain(
      phase === 'complete' ? 'Verified clone completion' : 'Clone partial',
    );
    if (phase === 'partial') {
      expect(outcome!.textContent).toContain('Journal persistence is unconfirmed');
      expect(outcome!.textContent).toContain('Unconfirmed');
    }
    expect(f.apply).toHaveBeenCalledExactlyOnceWith(id(1), secondActor, { confirm: true });
  },
);

it('does not select an existing historical outcome on mount or readonly journal hydration', async () => {
  const f = fixture(),
    reviewed = await f.controller.review('left', firstActor, { expectedRevision: 0 });
  await f.controller.apply(reviewed.id, firstActor, { confirm: true });
  await render(f);
  expect(host.querySelector('[aria-label="Clone outcome"]')).toBeNull();
  await act(async () => f.controller.hydrate(secondActor));
  expect(host.querySelector('[aria-label="Clone outcome"]')).toBeNull();
  expect(host.textContent).toContain('Clone history · 1 records');
});

it('clears live outcomes on owner changes and same-identity session invalidation without accepting a foreign receipt', async () => {
  const f = fixture();
  await render(f);
  await act(async () => {
    const reviewed = await f.controller.review('left', secondActor, { expectedRevision: 0 });
    await f.controller.apply(reviewed.id, secondActor, { confirm: true });
  });
  const record = f.snapshot.latestOutcome!.record;
  expect(host.querySelector('[aria-label="Clone outcome"]')).not.toBeNull();
  const foreign = { owner: 'workspace:22222222-2222-4222-8222-222222222222', scope: 'ui:other' };
  await render(f, { getContext: () => foreign });
  expect(host.querySelector('[aria-label="Clone outcome"]')).toBeNull();
  await act(async () => f.publish({ latestOutcome: { record, persistence: 'verified' } }));
  expect(host.querySelector('[aria-label="Clone outcome"]')).toBeNull();
  await render(f);
  await act(async () => f.publish({ latestOutcome: { record, persistence: 'verified' } }));
  expect(host.querySelector('[aria-label="Clone outcome"]')).not.toBeNull();
  // The controller clears this event for a replaced session even if public identity is equal.
  await act(async () => f.publish({ latestOutcome: undefined }));
  expect(host.querySelector('[aria-label="Clone outcome"]')).toBeNull();
});
