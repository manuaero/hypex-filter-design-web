import { expect, it, vi } from 'vitest';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';
import {
  createFirmwareRuntimeController,
  FirmwareRuntimeDiagnosticError,
} from '../src/application/firmware-runtime';
import type { FirmwareRuntimeReport } from '../src/hardware/firmware-runtime-inspector';
import { newProject } from '../src/domain/model';

const actor = {
  owner: 'workspace:11111111-1111-4111-8111-111111111111',
  scope: 'manual:firmware-runtime',
};
const report: FirmwareRuntimeReport = {
  identity: {
    serial: 'SYNTHETIC-RIGHT',
    product: 22,
    core: '5.5',
    firmware: '5.82',
    name: 'Synthetic runtime',
  },
  hardware: { amplifier: 5, moduleType: 9, channels: 3, presets: 3 },
  profileId: 'fusion32-5.82-core5.5',
  controlsQualified: false,
  familyProof: 'not-established-by-runtime-reports',
  imageProof: 'not-established-by-runtime-reports',
  consistency: 'double-read-matched',
};
function fixture() {
  const read = vi.fn(async () => report),
    runtime = createFirmwareRuntimeController({
      binding: (slot) =>
        slot === 'right'
          ? {
              key: 'right-captured-device',
              serial: report.identity.serial,
              source: 'remembered-device',
            }
          : undefined,
      read,
    });
  const forbidden = vi.fn(() => {
      throw new Error('Unexpected ordinary hardware or design access');
    }),
    view = vi.fn();
  const adapter: ToolAdapter = {
    state: () => ({
      documents: { left: newProject(), right: newProject() },
      slot: 'left',
      preset: 0,
      channel: 0,
      filter: 0,
      linkedEdits: false,
      linkedControls: false,
    }),
    edit: forbidden,
    choose: forbidden,
    undo: forbidden,
    redo: forbidden,
    connections: forbidden,
    connect: forbidden,
    disconnect: forbidden,
    refresh: forbidden,
    operate: forbidden,
    progress: forbidden,
    message: vi.fn(),
    view,
    firmwareRuntime: runtime,
  };
  return { read, runtime, forbidden, view, adapter, execute: createToolExecutor(adapter) };
}
it('rejects manufactured runtime fields, packets and metadata before any provider or controller admission', async () => {
  const f = fixture();
  for (const firmware of [
    { action: 'runtime-read', content: 'HEX' },
    { action: 'runtime-status', name: '5.82.hex' },
    { action: 'runtime-read', profileId: report.profileId },
    { action: 'runtime-clear', serial: report.identity.serial },
    { action: 'runtime-read', packetHex: '4000' },
    { action: 'runtime-read', confirm: true },
  ])
    expect(
      await f.execute('fusion_device_read', { target: 'right', firmware }, actor),
    ).toMatchObject({ ok: false });
  expect(f.read).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('requires trusted context; cached status/clear work without a connection or firmware-file workspace', async () => {
  const f = fixture();
  expect(
    await f.execute('fusion_device_read', {
      target: 'both',
      firmware: { action: 'runtime-status' },
    }),
  ).toMatchObject({ ok: false, error: expect.stringContaining('trusted') });
  expect(
    await f.execute(
      'fusion_device_read',
      { target: 'right', firmware: { action: 'runtime-status' } },
      actor,
    ),
  ).toMatchObject({ ok: true, runtime: { roles: { right: { phase: 'empty' } } } });
  await f.execute(
    'fusion_device_read',
    { target: 'both', firmware: { action: 'runtime-clear' } },
    actor,
  );
  expect(f.read).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(f.view).not.toHaveBeenCalled();
});
it('reads the shared captured role, exposes its diagnostic status and never calls ordinary controls or selection', async () => {
  const f = fixture();
  const result = await f.execute(
    'fusion_device_read',
    { target: 'right', firmware: { action: 'runtime-read' } },
    actor,
  );
  expect(result).toMatchObject({
    ok: true,
    runtime: { busy: false, roles: { right: { phase: 'ready', report } } },
  });
  expect((result as { runtime: { roles: object } }).runtime.roles).not.toHaveProperty('left');
  expect(f.runtime.getSnapshot().roles.right.report).toEqual(report);
  expect(f.view).toHaveBeenCalledExactlyOnceWith({ tab: 'Device settings' });
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('preflights Both and honors foreign-owner/cancellation gates before acquiring a provider', async () => {
  const f = fixture();
  expect(
    await f.execute(
      'fusion_device_read',
      { target: 'both', firmware: { action: 'runtime-read' } },
      actor,
    ),
  ).toMatchObject({ ok: false, error: expect.stringContaining('no captured') });
  expect(
    await f.execute(
      'fusion_device_read',
      { target: 'right', firmware: { action: 'runtime-read' } },
      { owner: 'workspace:22222222-2222-4222-8222-222222222222', scope: 'paired:other' },
    ),
  ).toMatchObject({ ok: false, error: expect.stringContaining('another workspace') });
  const abort = new AbortController();
  abort.abort();
  await expect(
    f.execute(
      'fusion_device_read',
      { target: 'right', firmware: { action: 'runtime-read' } },
      { ...actor, signal: abort.signal },
    ),
  ).rejects.toThrow();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});
it('an unsupported normal connection returns the bounded read-only identity without pretending controls connected', async () => {
  const f = fixture();
  f.adapter.connect = vi.fn(async () => {
    throw new FirmwareRuntimeDiagnosticError(
      'Runtime identified read-only; controls unavailable',
      report,
    );
  });
  expect(
    await f.execute('fusion_connect', { slot: 'right', serial: report.identity.serial }, actor),
  ).toEqual({
    ok: false,
    error: 'Runtime identified read-only; controls unavailable',
    runtime: report,
  });
  expect(f.read).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
});
