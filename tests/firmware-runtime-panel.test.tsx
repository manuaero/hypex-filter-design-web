// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import FirmwarePanel from '../src/components/firmware-panel';
import {
  createFirmwareWorkspace,
  type FirmwareWorkspace,
} from '../src/application/firmware-workspace';
import type {
  FirmwareRuntimeController,
  FirmwareRuntimeSnapshot,
  FirmwareRuntimeTarget,
} from '../src/application/firmware-runtime';
import type { FirmwareRuntimeReport } from '../src/hardware/firmware-runtime-inspector';
import { KNOWN_FIRMWARE_PROFILES } from '../src/domain/firmware-profile';
import type { Slot } from '../src/domain/model';
import type { ToolExecutionContext } from '../src/application/execution-context';
const ui = { owner: 'workspace:11111111-1111-4111-8111-111111111111', scope: 'ui:runtime' },
  foreign = { owner: 'workspace:22222222-2222-4222-8222-222222222222', scope: 'ui:other' };
const content =
  [
    ':10000080A80D0000CA080000465553494F4E3332B0',
    ':01000081027C',
    ':020000040000FA',
    ...Array(6).fill(':10068000464133320000000000000000000000007E'),
    ':00000001FF',
  ].join('\r\n') + '\r\n';
const roles = (target: FirmwareRuntimeTarget): Slot[] =>
  target === 'both' ? ['left', 'right'] : [target];
const report = (slot: Slot, core = '5.5', firmware = '5.82'): FirmwareRuntimeReport => ({
  identity: {
    serial: `SYNTHETIC-RUNTIME-${slot}`,
    product: 22,
    core,
    firmware,
    name: `Synthetic ${slot} DSP`,
  },
  hardware: { amplifier: 5, moduleType: 9, presets: 3, channels: 3 },
  profileId: core === '5.5' ? 'fusion32-5.82-core5.5' : 'fusion32-5.7-core5.1',
  controlsQualified: core === '5.1',
  familyProof: 'not-established-by-runtime-reports',
  imageProof: 'not-established-by-runtime-reports',
  consistency: 'double-read-matched',
});
const freeze = <T,>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
/** Controller-boundary fixture only. No hardware transport, device chooser or
 * browser media API is reachable. Reports are explicit synthetic metadata. */
function fixture() {
  let snapshot: Readonly<FirmwareRuntimeSnapshot> = freeze({
      busy: false,
      revision: 0,
      roles: { left: { phase: 'empty', stale: false }, right: { phase: 'empty', stale: false } },
    }),
    gate: Promise<void> | undefined;
  const listeners = new Set<() => void>(),
    epochs = { left: 0, right: 0 };
  const publish = (patch: Partial<FirmwareRuntimeSnapshot>) => {
    snapshot = freeze({ ...snapshot, ...structuredClone(patch) });
    listeners.forEach((listener) => listener());
  };
  const actor = (context: ToolExecutionContext) => {
    if (context.owner !== ui.owner) throw Error('Runtime reports belong to another workspace');
  };
  const controller: FirmwareRuntimeController = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    availability: vi.fn(() => ({ available: true })),
    status: vi.fn((context) => {
      actor(context);
      return snapshot;
    }),
    refreshBindings: vi.fn(),
    dispose: vi.fn(),
    read: vi.fn(async (target, context) => {
      actor(context);
      const captures = roles(target).map((slot) => ({ slot, epoch: epochs[slot] }));
      publish({
        busy: true,
        roles: {
          ...snapshot.roles,
          ...Object.fromEntries(
            captures.map((c) => [c.slot, { ...snapshot.roles[c.slot], phase: 'reading' }]),
          ),
        },
      });
      try {
        if (gate) await gate;
        for (const capture of captures)
          if (epochs[capture.slot] !== capture.epoch) throw Error('Read was cleared');
        const next = structuredClone(snapshot.roles);
        for (const c of captures)
          next[c.slot] = {
            phase: 'ready',
            report: report(c.slot),
            observedAt: '2026-11-15T12:00:00.000Z',
            source: 'staged-device',
            stale: false,
          };
        publish({ roles: next, revision: snapshot.revision + 1 });
        return snapshot;
      } catch (error) {
        const next = structuredClone(snapshot.roles);
        for (const c of captures)
          if (epochs[c.slot] === c.epoch)
            next[c.slot] = {
              ...next[c.slot],
              phase: 'error',
              stale: !!next[c.slot].report,
              error: error instanceof Error ? error.message : String(error),
            };
        publish({ roles: next });
        throw error;
      } finally {
        publish({ busy: false });
      }
    }),
    clear: vi.fn((target, context) => {
      actor(context);
      const next = structuredClone(snapshot.roles);
      for (const slot of roles(target)) {
        epochs[slot]++;
        next[slot] = { phase: 'empty', stale: false };
      }
      publish({ roles: next, revision: snapshot.revision + 1 });
    }),
  };
  return {
    controller,
    publish,
    snapshot: () => snapshot,
    wait: (value: Promise<void>) => {
      gate = value;
    },
  };
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
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === name,
  )!;
async function click(name: string) {
  expect(button(name), name).toBeDefined();
  await act(async () => button(name).click());
}
async function render(
  f: ReturnType<typeof fixture>,
  workspace: FirmwareWorkspace,
  options: {
    slot?: Slot;
    getContext?: () => ToolExecutionContext;
    contextReady?: boolean;
    externalBusy?: boolean;
  } = {},
) {
  await act(async () =>
    root.render(
      <FirmwarePanel
        workspace={workspace}
        slot={options.slot ?? 'left'}
        runtime={f.controller}
        getContext={options.getContext ?? (() => ui)}
        contextReady={options.contextReady}
        externalBusy={options.externalBusy}
      />,
    ),
  );
}
const workspace = () => createFirmwareWorkspace({ binding: () => undefined });

it('renders cached runtime context without reading on mount, selection or file inspection', async () => {
  const f = fixture(),
    w = workspace();
  await render(f, w);
  expect(f.controller.read).not.toHaveBeenCalled();
  expect(f.controller.clear).not.toHaveBeenCalled();
  expect(host.textContent).toContain('No runtime identity report for Left');
  await render(f, w, { slot: 'right' });
  expect(f.controller.read).not.toHaveBeenCalled();
  await act(async () => w.inspect('right', content, 'synthetic.hex'));
  expect(f.controller.read).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Unknown content hash');
  expect(button('Program firmware · unavailable').disabled).toBe(true);
});
it('explicitly reads the selected role and displays firmware5.82/core5.5 as diagnostic-only without a hash/family proof', async () => {
  const f = fixture(),
    w = workspace();
  await render(f, w);
  await click('Read runtime identity');
  expect(f.controller.read).toHaveBeenCalledExactlyOnceWith('left', ui);
  expect(host.textContent).toContain('SYNTHETIC-RUNTIME-left');
  expect(host.textContent).toContain('firmware 5.82 · core 5.5 · product 22');
  expect(host.textContent).toContain('amplifier 5, module 9, 3 presets / 3 outputs');
  expect(host.textContent).toContain('unavailable for this reported profile');
  expect(host.textContent).toContain(
    'Runtime reports do not establish the installed image hash or bundle family',
  );
  expect(host.querySelector('time')?.dateTime).toBe('2026-11-15T12:00:00.000Z');
  expect(button('Program firmware · unavailable').disabled).toBe(true);
});
it('reflects a shared cached report and keeps a late Left read distinct after switching to Right', async () => {
  const f = fixture(),
    w = workspace(),
    delay = deferred();
  f.wait(delay.promise);
  await render(f, w);
  await click('Read runtime identity');
  await act(async () =>
    f.publish({
      roles: {
        ...f.snapshot().roles,
        right: {
          phase: 'ready',
          report: report('right', '5.1', '5.7'),
          observedAt: '2026-11-15T11:59:00.000Z',
          source: 'connected-session',
          stale: false,
        },
      },
    }),
  );
  await render(f, w, { slot: 'right' });
  expect(host.textContent).toContain('SYNTHETIC-RUNTIME-right');
  expect(host.textContent).toContain('existing core 5.1 profile');
  await act(async () => delay.resolve());
  expect(host.textContent).not.toContain('SYNTHETIC-RUNTIME-left');
  expect(f.controller.read).toHaveBeenCalledTimes(1);
  await render(f, w);
  expect(host.textContent).toContain('SYNTHETIC-RUNTIME-left');
});
it('coalesces read clicks and Clear invalidates the pending report without clearing the staged file', async () => {
  const f = fixture(),
    w = workspace(),
    delay = deferred();
  f.wait(delay.promise);
  await w.inspect('left', content, 'retained.hex');
  const original = w.getSnapshot().left.stage;
  await render(f, w);
  await act(async () => {
    button('Read runtime identity').click();
    button('Read runtime identity').click();
  });
  expect(f.controller.read).toHaveBeenCalledTimes(1);
  await click('Clear runtime report');
  expect(f.controller.clear).toHaveBeenCalledExactlyOnceWith('left', ui);
  await act(async () => delay.resolve());
  expect(host.textContent).toContain('No runtime identity report for Left');
  expect(host.textContent).not.toContain('Read was cleared');
  expect(w.getSnapshot().left.stage).toBe(original);
});
it('shows stale/error context while retaining a prior diagnostic report and never retries automatically', async () => {
  const f = fixture(),
    w = workspace();
  await render(f, w);
  await click('Read runtime identity');
  await act(async () =>
    f.publish({
      roles: {
        ...f.snapshot().roles,
        left: {
          ...f.snapshot().roles.left,
          phase: 'error',
          stale: true,
          error: 'Captured session was replaced',
        },
      },
    }),
  );
  expect(host.textContent).toContain('Captured session was replaced');
  expect(host.textContent).toContain('cached runtime report is stale');
  expect(host.textContent).toContain('SYNTHETIC-RUNTIME-left');
  expect(f.controller.read).toHaveBeenCalledTimes(1);
  await click('Clear runtime report');
  expect(host.textContent).not.toContain('SYNTHETIC-RUNTIME-left');
});
it('keeps runtime actions gated by capability, external busy and workspace context while offline staging remains usable', async () => {
  const f = fixture(),
    w = workspace();
  vi.mocked(f.controller.availability).mockReturnValue({
    available: false,
    reason: 'No already-granted target matches this role',
  });
  await render(f, w);
  expect(button('Read runtime identity').disabled).toBe(true);
  expect(host.textContent).toContain('No already-granted target');
  expect(button('Choose firmware (.hex)').disabled).toBe(false);
  await render(f, w, { externalBusy: true });
  expect(button('Read runtime identity').disabled).toBe(true);
  await render(f, w, { contextReady: false });
  expect(host.textContent).toContain('Workspace access is required');
  expect(f.controller.read).not.toHaveBeenCalled();
});
it('requires an explicit workspace context for runtime buttons without changing optional offline file inspection', async () => {
  const f = fixture(),
    w = workspace();
  await act(async () =>
    root.render(<FirmwarePanel workspace={w} slot="left" runtime={f.controller} />),
  );
  expect(button('Read runtime identity').disabled).toBe(true);
  expect(button('Clear runtime report').disabled).toBe(true);
  expect(button('Choose firmware (.hex)').disabled).toBe(false);
  expect(f.controller.status).not.toHaveBeenCalled();
  expect(f.controller.read).not.toHaveBeenCalled();
});
it('hides another owner’s cached report and catches authority expiry immediately before Read', async () => {
  const f = fixture(),
    w = workspace();
  let expired = false;
  const getContext = () => {
    if (expired) throw Error('Workspace authority expired');
    return ui;
  };
  await render(f, w, { getContext });
  expired = true;
  await click('Read runtime identity');
  expect(f.controller.read).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Workspace authority expired');
  expired = false;
  await render(f, w);
  await click('Read runtime identity');
  await render(f, w, { getContext: () => foreign });
  expect(host.textContent).toContain('another workspace');
  expect(host.textContent).not.toContain('SYNTHETIC-RUNTIME-left');
});
it('distinguishes exact known staged file content from the independently reported installed version', async () => {
  const f = fixture(),
    profile = KNOWN_FIRMWARE_PROFILES.find((p) => p.bundleVersion === '5.82')!,
    w = createFirmwareWorkspace({ binding: () => undefined, sha256: async () => profile.sha256 });
  await w.inspect('left', content, 'synthetic-known-hash.hex');
  await render(f, w);
  await act(async () =>
    f.publish({
      roles: {
        ...f.snapshot().roles,
        left: {
          phase: 'ready',
          report: report('left', '5.1', '5.7'),
          observedAt: '2026-11-15T12:00:00.000Z',
          source: 'connected-session',
          stale: false,
        },
      },
    }),
  );
  expect(host.textContent).toContain('Exact known-content match · firmware 5.82 · core 5.5');
  expect(host.textContent).toContain('firmware 5.7 · core 5.1');
  expect(host.textContent).toContain(
    'classifies the staged file; it does not prove the installed image hash',
  );
  expect(f.controller.read).not.toHaveBeenCalled();
  expect(button('Program firmware · unavailable').disabled).toBe(true);
});
it('ignores a late read error after unmount without initiating another action', async () => {
  const f = fixture(),
    w = workspace(),
    delay = deferred();
  f.wait(delay.promise);
  await render(f, w);
  await click('Read runtime identity');
  await act(async () => root.unmount());
  unmounted = true;
  await act(async () => delay.reject(Error('Late synthetic reply failure')));
  expect(f.controller.read).toHaveBeenCalledTimes(1);
  expect(f.controller.clear).not.toHaveBeenCalled();
});
