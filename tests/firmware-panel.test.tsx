// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { createHash } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import FirmwarePanel from '../src/components/firmware-panel';
import {
  createFirmwareWorkspace,
  type FirmwareDeviceBinding,
  type FirmwareWorkspace,
} from '../src/application/firmware-workspace';
import { MAX_UI_FILE_BYTES } from '../src/application/file-budget';
import type { Slot } from '../src/domain/model';
import type {
  FirmwareExecutionWorkflow,
  FirmwareExecutionSnapshot,
} from '../src/application/firmware-execution';
import * as fileDownloads from '../src/domain/files';
import {
  createUsbDescriptorVerifier,
  type UsbDescriptorVerifier,
  type UsbDescriptorDevice,
} from '../src/hardware/usb-descriptor';

// Literal source records; no native app, hardware or media dependency.
const header = ':10000080A80D0000CA080000465553494F4E3332B0',
  segment = ':01000081027C',
  address = ':020000040000FA',
  data = ':10068000464133320000000000000000000000007E',
  eof = ':00000001FF',
  text = [header, segment, address, ...Array(6).fill(data), eof].join('\r\n') + '\r\n';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const identity = (serial: string): FirmwareDeviceBinding => ({
  serial,
  core: '5.1',
  firmware: '5.7',
  product: 22,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function file(content = text, name = 'fixture.hex') {
  return Object.assign(new NodeBlob([content]), { name }) as unknown as File;
}
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
async function render(
  workspace: FirmwareWorkspace,
  slot: Slot = 'left',
  descriptorVerifier?: UsbDescriptorVerifier,
) {
  await act(async () =>
    root.render(<FirmwarePanel {...{ workspace, slot, descriptorVerifier }} />),
  );
}
function button(name: string) {
  const element = [...host.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === name || button.textContent?.includes(name),
  );
  expect(element, name).toBeDefined();
  return element!;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
function selectFiles(files: File[]) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
async function choose(selected: File) {
  await click('Choose firmware');
  await act(async () => selectFiles([selected]));
}
function rows() {
  return [...host.querySelectorAll('tbody tr')];
}

it('stages an offline bundle with exact file/SHA context, disabled programming and bounded pageable previews for both passes', async () => {
  const workspace = createFirmwareWorkspace({
      binding: () => undefined,
      sha256: async (bytes) => sha(bytes),
    }),
    preview = vi.spyOn(workspace, 'packetPreview');
  await render(workspace);
  expect(host.textContent).toContain('No firmware staged for Left');
  expect(button('Program firmware').disabled).toBe(true);
  await choose(file());
  expect(host.textContent).toContain('fixture.hex');
  expect(host.textContent).toContain('FUSION32 · file identity only');
  expect(host.textContent).toContain(sha(new TextEncoder().encode(text)));
  expect(host.textContent).toContain('96 bytes · 10 records · 1 segments');
  expect(host.textContent).toContain('2 passes · 5 packets/pass · 10 total');
  expect(host.textContent).toContain('Offline · no amplifier identity bound');
  expect(host.textContent).toContain(
    'Target compatibility, programming and recovery are not yet verified.',
  );
  expect(host.querySelector('details')?.open).toBe(false);
  expect(host.querySelector('details')?.textContent).toContain('trusted HID product serial');
  expect(button('Program firmware').disabled).toBe(true);
  expect(preview).not.toHaveBeenCalled();
  await click('Transfer preview');
  expect(preview).toHaveBeenLastCalledWith('left', 0, 0, 4);
  expect(rows()).toHaveLength(4);
  expect(rows()[0].children[1].textContent).toBe('1–2');
  expect(button('Previous firmware packets').disabled).toBe(true);
  await click('Next firmware packets');
  expect(preview).toHaveBeenLastCalledWith('left', 0, 4, 4);
  expect(rows()).toHaveLength(1);
  expect(rows()[0].children[0].textContent).toBe('5');
  expect(button('Next firmware packets').disabled).toBe(true);
  const pass = host.querySelector<HTMLSelectElement>('select[aria-label="Firmware preview pass"]')!;
  await act(async () => {
    pass.value = '1';
    pass.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(preview).toHaveBeenLastCalledWith('left', 1, 0, 4);
  expect(rows()).toHaveLength(4);
  expect(rows()[0].children[2].textContent).toBe('12/20');
  await click('Next firmware packets');
  await click('Previous firmware packets');
  expect(preview).toHaveBeenLastCalledWith('left', 1, 0, 4);
  expect(workspace.getSnapshot().right.phase).toBe('empty');
});

it('retains the role and identity captured before the chooser through a later role switch, slow read and asynchronous hash', async () => {
  const bindings: Partial<Record<Slot, FirmwareDeviceBinding>> = {
      left: identity('ORIGINAL-EEPROM'),
      right: identity('RIGHT'),
    },
    readStarted = deferred<void>(),
    releaseRead = deferred<void>(),
    hashStarted = deferred<void>(),
    releaseHash = deferred<string>(),
    workspace = createFirmwareWorkspace({
      binding: (slot) => bindings[slot],
      sha256: () => {
        hashStarted.resolve();
        return releaseHash.promise;
      },
    }),
    inspect = vi.spyOn(workspace, 'inspect'),
    bytes = new TextEncoder().encode(text),
    slow = {
      name: 'captured-left.hex',
      size: bytes.length,
      stream: () =>
        new ReadableStream<Uint8Array>({
          async start(controller) {
            readStarted.resolve();
            await releaseRead.promise;
            controller.enqueue(bytes);
            controller.close();
          },
        }),
    } as File;
  await render(workspace, 'left');
  await click('Choose firmware');
  bindings.left = identity('REPLACEMENT');
  await render(workspace, 'right');
  await act(async () => {
    selectFiles([slow]);
    await readStarted.promise;
  });
  await act(async () => {
    releaseRead.resolve();
    await hashStarted.promise;
  });
  expect(inspect).toHaveBeenCalledWith('left', text, 'captured-left.hex', expect.any(Object));
  expect(host.textContent).toContain('No firmware staged for Right');
  await act(async () => releaseHash.resolve(sha(bytes)));
  expect(workspace.getSnapshot().right.phase).toBe('empty');
  expect(workspace.getSnapshot().left.stage?.boundDevice?.serial).toBe('ORIGINAL-EEPROM');
  await render(workspace, 'left');
  expect(host.textContent).toContain('ORIGINAL-EEPROM · core 5.1 · firmware 5.7');
  expect(host.textContent).toContain('Device assignment changed during inspection');
  expect(host.textContent).toContain('captured-left.hex');
  expect(button('Program firmware').disabled).toBe(true);
});

it('Clear invalidates a pending chooser, slow file read and in-flight hash without reviving a stage or late error', async () => {
  const workspace = createFirmwareWorkspace({
      binding: () => undefined,
      sha256: async () => 'a'.repeat(64),
    }),
    inspect = vi.spyOn(workspace, 'inspect');
  await render(workspace);
  await click('Choose firmware');
  await click('Clear staged firmware');
  await act(async () => selectFiles([file()]));
  expect(inspect).not.toHaveBeenCalled();
  const releaseRead = deferred<void>(),
    started = deferred<void>(),
    bytes = new TextEncoder().encode(text);
  const slow = {
    name: 'slow.hex',
    size: bytes.length,
    stream: () =>
      new ReadableStream<Uint8Array>({
        async start(controller) {
          started.resolve();
          await releaseRead.promise;
          controller.enqueue(bytes);
          controller.close();
        },
      }),
  } as File;
  await click('Choose firmware');
  await act(async () => {
    selectFiles([slow]);
    await started.promise;
  });
  await click('Clear staged firmware');
  await act(async () => releaseRead.resolve());
  expect(inspect).not.toHaveBeenCalled();
  const hashStarted = deferred<void>(),
    releaseHash = deferred<string>();
  const hashing = createFirmwareWorkspace({
    binding: () => undefined,
    sha256: () => {
      hashStarted.resolve();
      return releaseHash.promise;
    },
  });
  await render(hashing);
  await click('Choose firmware');
  await act(async () => {
    selectFiles([file()]);
    await hashStarted.promise;
  });
  await click('Clear staged firmware');
  await act(async () => releaseHash.resolve('b'.repeat(64)));
  expect(hashing.getSnapshot().left).toEqual({ phase: 'empty' });
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain('No firmware staged for Left');
});

it('keeps cancelled choosers quiet and rejects byte overflow before opening a file stream', async () => {
  const workspace = createFirmwareWorkspace({ binding: () => undefined }),
    inspect = vi.spyOn(workspace, 'inspect'),
    stream = vi.fn();
  await render(workspace);
  await click('Choose firmware');
  await act(async () => selectFiles([]));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await choose({ name: 'oversized.hex', size: MAX_UI_FILE_BYTES + 1, stream } as unknown as File);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('byte budget');
  expect(stream).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
});

it('preserves the BOM for syntax rejection and reports a newer fatal UTF-8 read error while keeping the prior stage', async () => {
  const workspace = createFirmwareWorkspace({
    binding: () => undefined,
    sha256: async (bytes) => sha(bytes),
  });
  await render(workspace);
  await choose(file());
  const original = workspace.getSnapshot().left.stage;
  await choose(file('\ufeff' + text, 'bom.hex'));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('complete colon-prefixed');
  expect(workspace.getSnapshot().left.stage).toBe(original);
  const malformed = Object.assign(new NodeBlob([new Uint8Array([0xff])]), {
    name: 'bad-utf8.hex',
  }) as unknown as File;
  await choose(malformed);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('bad-utf8.hex');
  expect(host.querySelector('[role="alert"]')?.textContent).not.toContain('bom.hex');
  expect(workspace.getSnapshot().left.stage).toBe(original);
  expect(button('Program firmware').disabled).toBe(true);
});

it('verifies descriptor metadata for the originally clicked role across a late chooser, then Clear removes the attached proof', async () => {
  const bindings = { left: identity('LEFT'), right: identity('RIGHT') },
    chooser = deferred<UsbDescriptorDevice>(),
    api = { requestDevice: vi.fn(() => chooser.promise), getDevices: vi.fn(async () => []) },
    verifier = createUsbDescriptorVerifier({
      binding: (slot) => bindings[slot] as Required<FirmwareDeviceBinding>,
      usb: () => api,
    }),
    workspace = createFirmwareWorkspace({
      binding: (slot) => bindings[slot],
      descriptor: (slot) => verifier.getSnapshot()[slot].proof,
      sha256: async (bytes) => sha(bytes),
    });
  await render(workspace, 'left', verifier);
  expect(api.requestDevice).not.toHaveBeenCalled();
  expect(api.getDevices).not.toHaveBeenCalled();
  await choose(file());
  await click('Verify USB identity');
  expect(host.textContent).toContain('Choose the Left USB descriptor');
  await render(workspace, 'right', verifier);
  await act(async () =>
    chooser.resolve({ vendorId: 0x345e, productId: 0x03e8, serialNumber: '0303A:LEFT' }),
  );
  expect(workspace.getSnapshot().left.stage?.target?.hidSerial).toBe('0303A:LEFT');
  expect(workspace.getSnapshot().right.stage).toBeUndefined();
  await render(workspace, 'left', verifier);
  expect(host.textContent).toContain('0303A:LEFT · FUSION32 · matches bundle family');
  expect(button('Program firmware').disabled).toBe(true);
  await click('Clear USB proof');
  expect(workspace.getSnapshot().left.stage?.target).toBeUndefined();
  expect(host.textContent).toContain('No matching USB descriptor proof attached');
  expect(api.getDevices).not.toHaveBeenCalled();
});

it('disables the metadata chooser without a live binding or browser API and keeps the reason visible', async () => {
  const verifier = createUsbDescriptorVerifier({ binding: () => undefined, usb: () => undefined }),
    workspace = createFirmwareWorkspace({ binding: () => undefined });
  await render(workspace, 'left', verifier);
  expect(button('Verify USB identity').disabled).toBe(true);
  expect(host.textContent).toContain('Connect and identify the selected amplifier');
  expect(button('Recheck granted identity').disabled).toBe(true);
  expect(button('Program firmware').disabled).toBe(true);
});

const executionActor = {
  owner: 'workspace:11111111-1111-4111-8111-111111111111',
  scope: 'ui:firmware-panel',
};
function executionFixture() {
  const workspace = createFirmwareWorkspace({ binding: () => undefined });
  const listeners = new Set<() => void>();
  let state: FirmwareExecutionSnapshot = {
    files: workspace.getSnapshot(),
    availability: {
      left: { available: false, reasons: ['Physical loader profile unqualified.'] },
      right: { available: false, reasons: ['Physical loader profile unqualified.'] },
    },
    update: {
      busy: false,
      phase: 'idle',
      records: [],
      availability: {
        left: {
          available: false,
          qualifier: 'unqualified-physical',
          route: 'physical',
          qualified: false,
          reasons: ['Unqualified'],
        },
        right: {
          available: false,
          qualifier: 'unqualified-physical',
          route: 'physical',
          qualified: false,
          reasons: ['Unqualified'],
        },
      },
    },
  };
  const workflow: FirmwareExecutionWorkflow = {
    getSnapshot: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    status: vi.fn((context) => {
      if (context.owner !== executionActor.owner) throw new Error('Foreign workspace');
      return state;
    }),
    inspect: vi.fn(async (slot, source, name, _context, token) =>
      workspace.inspect(slot, source, name, token),
    ),
    clear: vi.fn((target) => {
      if (target === 'both') {
        workspace.clear('left');
        workspace.clear('right');
      } else workspace.clear(target);
    }),
    review: vi.fn(),
    reviewRecovery: vi.fn(),
    apply: vi.fn(),
    discard: vi.fn(),
    hydrate: vi.fn(async () => {}),
    history: vi.fn(() => ({ records: [], total: 0, nextOffset: null })),
    exportRecord: vi.fn(),
    exportPage: vi.fn(),
    refreshContext: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    workspace,
    workflow,
    publish: (patch: Partial<FirmwareExecutionSnapshot['update']>) => {
      state = { ...state, update: { ...state.update, ...patch } };
      listeners.forEach((fn) => fn());
    },
    enable: () => {
      state = {
        ...state,
        availability: {
          left: { available: true, reasons: [] },
          right: { available: true, reasons: [] },
        },
      };
      listeners.forEach((fn) => fn());
    },
  };
}
it('shows the actual shared physical availability and never queries a device or opens a permission chooser on entry', async () => {
  const f = executionFixture();
  await act(async () =>
    root.render(
      <FirmwarePanel
        workspace={f.workspace}
        execution={f.workflow}
        slot="left"
        getContext={() => executionActor}
      />,
    ),
  );
  expect(host.textContent).toContain('Physical programming is unavailable');
  expect(host.textContent).toContain('Physical loader profile unqualified');
  expect(button('Review firmware update').disabled).toBe(true);
  expect(button('Program firmware').disabled).toBe(true);
  expect(f.workflow.status).toHaveBeenCalled();
  for (const fn of [f.workflow.review, f.workflow.apply, f.workflow.hydrate, f.workflow.inspect])
    expect(fn).not.toHaveBeenCalled();
});
it('routes picker/Clear through the owner-admitted workflow and preserves the captured role', async () => {
  const f = executionFixture();
  await act(async () =>
    root.render(
      <FirmwarePanel
        workspace={f.workspace}
        execution={f.workflow}
        slot="right"
        getContext={() => executionActor}
      />,
    ),
  );
  await choose(file());
  expect(f.workflow.inspect).toHaveBeenCalledWith(
    'right',
    text,
    'fixture.hex',
    executionActor,
    expect.any(Object),
  );
  expect(f.workspace.getSnapshot().left.phase).toBe('empty');
  await click('Clear staged firmware');
  expect(f.workflow.clear).toHaveBeenCalledExactlyOnceWith('right', executionActor);
});
it('shows consumed outcomes published externally and exports journal filename/content/persistence at the download boundary', async () => {
  const f = executionFixture(),
    record = {
      id: 'external-partial',
      target: 'right',
      phase: 'partial',
      qualifier: 'qualified-physical',
    } as never;
  const raw = {
    id: 'external-partial',
    roles: [{ source: { text: 'EXACT SOURCE' }, before: { images: [{ hex: '00' }] } }],
    exportPersistence: 'unavailable' as const,
  };
  vi.mocked(f.workflow.exportRecord).mockReturnValue(raw as never);
  const download = vi.spyOn(fileDownloads, 'download').mockImplementation(() => {});
  await act(async () =>
    root.render(
      <FirmwarePanel
        workspace={f.workspace}
        execution={f.workflow}
        slot="right"
        getContext={() => executionActor}
      />,
    ),
  );
  expect(host.querySelector('[aria-label="Firmware update outcome"]')).toBeNull();
  await act(async () =>
    f.publish({ records: [record], latestOutcome: { record, persistence: 'unavailable' } }),
  );
  expect(host.querySelector('[aria-label="Firmware update outcome"]')?.textContent).toContain(
    'partial',
  );
  expect(host.querySelector('[aria-label="Firmware update outcome"]')?.textContent).toContain(
    'persistence unavailable',
  );
  expect(host.textContent).not.toContain('EXACT SOURCE');
  await click('Export firmware journal external-partial');
  expect(download).toHaveBeenCalledExactlyOnceWith(
    'firmware-journal-external-partial.json',
    JSON.stringify(raw),
    'application/json',
  );
});
it('requires the exact shared review and explicit confirmation; owner changes hide private outcomes and disable actions', async () => {
  const f = executionFixture();
  const review = {
    id: 'fixed-review',
    target: 'both' as const,
    qualifier: 'qualified-physical' as const,
    roles: [],
  };
  await act(async () =>
    root.render(
      <FirmwarePanel
        workspace={f.workspace}
        execution={f.workflow}
        slot="left"
        getContext={() => executionActor}
      />,
    ),
  );
  await act(async () => {
    f.enable();
    f.publish({ activeReview: review });
  });
  expect(
    (host.querySelector('[aria-label="Firmware program target"]') as HTMLSelectElement).value,
  ).toBe('both');
  expect(button('Program firmware').disabled).toBe(true);
  const confirm = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => confirm.click());
  await click('Program firmware');
  expect(f.workflow.apply).toHaveBeenCalledExactlyOnceWith('fixed-review', executionActor, {
    confirm: true,
  });
  await act(async () =>
    root.render(
      <FirmwarePanel
        workspace={f.workspace}
        execution={f.workflow}
        slot="left"
        getContext={() => ({ ...executionActor, owner: 'foreign' })}
      />,
    ),
  );
  expect(host.querySelector('[aria-label="Firmware update review"]')).toBeNull();
  expect(button('Program firmware').disabled).toBe(true);
  expect(host.textContent).toContain('Foreign workspace');
});

it('binds confirmation to the exact shared review ID so an external replacement requires its own confirmation', async () => {
  const f = executionFixture();
  await act(async () =>
    root.render(
      <FirmwarePanel
        workspace={f.workspace}
        execution={f.workflow}
        slot="left"
        getContext={() => executionActor}
      />,
    ),
  );
  await act(async () => {
    f.enable();
    f.publish({
      activeReview: { id: 'review-A', target: 'left', qualifier: 'qualified-physical', roles: [] },
    });
  });
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(button('Program firmware').disabled).toBe(false);
  await act(async () =>
    f.publish({
      activeReview: { id: 'review-B', target: 'left', qualifier: 'qualified-physical', roles: [] },
    }),
  );
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
  expect(button('Program firmware').disabled).toBe(true);
  await click('Program firmware');
  expect(f.workflow.apply).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await click('Program firmware');
  expect(f.workflow.apply).toHaveBeenCalledExactlyOnceWith('review-B', executionActor, {
    confirm: true,
  });
});

it('reviews and applies captured recovery while ordinary runtime and current file availability are absent', async () => {
  const f = executionFixture(),
    record = {
      id: 'historical-partial',
      target: 'right',
      phase: 'partial',
      qualifier: 'qualified-physical',
    } as never;
  vi.mocked(f.workflow.reviewRecovery).mockImplementation(async (id, target) => {
    const review = {
      id: 'recovery-review',
      sourceRecordId: id,
      target,
      qualifier: 'qualified-physical' as const,
      roles: [],
    };
    f.publish({ activeReview: review });
    return review;
  });
  await act(async () =>
    root.render(
      <FirmwarePanel
        workspace={f.workspace}
        execution={f.workflow}
        slot="left"
        getContext={() => executionActor}
      />,
    ),
  );
  await act(async () => f.publish({ records: [record] }));
  expect(f.workspace.getSnapshot().left.stage).toBeUndefined();
  expect(f.workspace.getSnapshot().right.stage).toBeUndefined();
  expect(button('Review firmware update').disabled).toBe(true);
  expect(button('Review recovery historical-partial').disabled).toBe(false);
  await click('Review recovery historical-partial');
  expect(f.workflow.reviewRecovery).toHaveBeenCalledExactlyOnceWith(
    'historical-partial',
    'right',
    executionActor,
  );
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(button('Program firmware').disabled).toBe(false);
  await click('Program firmware');
  expect(f.workflow.apply).toHaveBeenCalledExactlyOnceWith('recovery-review', executionActor, {
    confirm: true,
  });
});

it('lets a partial Both journal recover only the selected original role without re-entering its completed peer', async () => {
  const f = executionFixture();
  const record = {
    id: 'partial-both',
    target: 'both',
    phase: 'partial',
    qualifier: 'qualified-physical',
    roles: [
      {
        slot: 'left',
        binding: { serial: 'SYNTHETIC-LEFT' },
        steps: [{ id: 'runtime', state: 'verified', attempted: true }],
      },
      {
        slot: 'right',
        binding: { serial: 'SYNTHETIC-RIGHT' },
        steps: [{ id: 'runtime', state: 'unconfirmed', attempted: true }],
      },
    ],
  } as never;
  await act(async () =>
    root.render(
      <FirmwarePanel
        workspace={f.workspace}
        execution={f.workflow}
        slot="left"
        getContext={() => executionActor}
      />,
    ),
  );
  await act(async () => f.publish({ records: [record] }));
  expect(host.textContent).toContain('Left · SYNTHETIC-LEFT · runtime: verified');
  expect(host.textContent).toContain('Right · SYNTHETIC-RIGHT · runtime: unconfirmed');
  const target = host.querySelector<HTMLSelectElement>(
    '[aria-label="Firmware recovery target partial-both"]',
  )!;
  await act(async () => {
    target.value = 'right';
    target.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('Review recovery partial-both');
  expect(f.workflow.reviewRecovery).toHaveBeenCalledExactlyOnceWith(
    'partial-both',
    'right',
    executionActor,
  );
  expect(f.workflow.review).not.toHaveBeenCalled();
  expect(f.workflow.apply).not.toHaveBeenCalled();
});
