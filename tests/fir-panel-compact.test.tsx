// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import FirPanel from '../src/components/FirPanel';
import { newProject, type Fir } from '../src/domain/model';
import type { FirBackup } from '../src/hardware/fir';
import * as firHardware from '../src/hardware/fir';
import * as fileFunctions from '../src/domain/files';

const storage = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../src/hardware/storage', () => ({ listFirBackups: storage.list }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  storage.list.mockResolvedValue([]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
const loaded = (count: number, used: boolean, enabled = true): Fir => ({
  name: `${count}-taps.txt`,
  enabled,
  taps: Array.from({ length: count }, (_, i) => (i === 0 ? 0.5 : 0)),
  hfdState: { loaded: true, used, tapCount: count },
});
const props = () => ({
  presetIndex: 0,
  edit: vi.fn(),
  run: vi.fn(async (_label: string, fn: () => Promise<void>) => fn()),
  readFile: vi.fn(),
  notice: vi.fn(),
});
const buttons = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].filter(
    (button) => button.textContent?.trim() === text,
  );

it('presents all four banks, native states and actions together as an accessible table', async () => {
  const preset = newProject().presets[0];
  preset.firPlacement = 'output';
  preset.inputFir = loaded(4500, false);
  preset.channels[0].fir = loaded(1500, true);
  preset.channels[1].fir = loaded(1500, true, false);
  preset.channels[2].fir = {
    name: '',
    taps: [],
    enabled: true,
    hfdState: { loaded: false, used: true, tapCount: 1500 },
  };
  await act(async () =>
    root.render(<FirPanel {...props()} preset={preset} selectedOutputIndex={2} />),
  );
  const table = host.querySelector<HTMLTableElement>('table[aria-label="FIR banks"]')!,
    rows = [...table.tBodies[0].rows];
  expect(rows).toHaveLength(4);
  expect(table.closest('details')).toBeNull();
  expect([...table.tHead!.rows[0].cells].map((cell) => cell.textContent)).toEqual([
    'Bank',
    'File / state',
    'Taps',
    'Enabled',
    'Actions',
  ]);
  expect(rows[0].textContent).toContain('Loaded · inactive placement');
  expect(rows[1].textContent).toContain('Processing enabled');
  expect(rows[2].textContent).toContain('Loaded · bypassed');
  expect(rows[3].textContent).toContain('Awaiting FIR data · enable setting retained');
  expect(rows.map((row) => row.querySelector<HTMLInputElement>('input')!.checked)).toEqual([
    true,
    true,
    false,
    true,
  ]);
  expect(rows.map((row) => row.querySelector('th[scope="row"]')!.textContent)).toEqual([
    'Input FIRShared input',
    'WooferOutput 1',
    'MidrangeOutput 2',
    'TweeterOutput 3',
  ]);
  expect(
    rows.every(
      (row) => row.querySelector('[role="group"]') && row.querySelectorAll('button').length === 3,
    ),
  ).toBe(true);
  expect(rows[3].getAttribute('aria-current')).toBe('true');
  expect(rows[0].querySelector('input')!.getAttribute('aria-label')).toBe('Enable Input FIR');
  expect(rows[3].querySelector('input')!.getAttribute('aria-label')).toBe('Enable CH 3 Tweeter');
  expect(buttons('Read FIR')[0].disabled).toBe(true);
  expect(buttons('Upload FIR')[0].disabled).toBe(true);
});

it('retains complete accessible names, linked context and an always-available selected-output Clear with long labels', async () => {
  const preset = newProject().presets[0],
    longName = 'Selected output with a detailed driver and enclosure name '.repeat(8),
    filename = 'Impulse-coefficients-from-measurement-'.repeat(10) + '.txt';
  preset.channels[1].name = longName;
  preset.channels[1].linkedTo = 0;
  preset.channels[1].fir = loaded(1500, false);
  preset.channels[1].fir.name = filename;
  const p = props(),
    native = vi.fn();
  await act(async () =>
    root.render(
      <FirPanel {...p} preset={preset} selectedOutputIndex={1} onNativeAction={native} />,
    ),
  );
  const rows = host.querySelector<HTMLTableElement>('table[aria-label="FIR banks"]')!.tBodies[0]
      .rows,
    linked = rows[2];
  expect(linked.querySelector('th')!.textContent).toContain(longName);
  expect(linked.textContent).toContain('Output 2 · Linked to CH 1');
  expect(linked.textContent).toContain(filename);
  expect(linked.querySelector('input')!.getAttribute('aria-label')).toBe(`Enable CH 2 ${longName}`);
  expect(linked.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  const clear = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === `Clear input + ${longName}`,
  )!;
  expect(clear.disabled).toBe(false);
  await act(async () => clear.click());
  expect(native).toHaveBeenCalledExactlyOnceWith({ kind: 'clear', output: 2 });
  expect(p.edit).not.toHaveBeenCalled();
  expect(p.run).not.toHaveBeenCalled();
});

it('keeps complete recovery manifest exports and matching-device Restore available beneath the banks', async () => {
  const backup = (id: string, serial: string): FirBackup => ({
    format: 'fusion-studio-fir-backup',
    version: 1,
    id,
    utc: '2026-11-14T12:00:00.000Z',
    serial,
    product: 22,
    firmware: '5.82',
    preset: 2,
    name: 'Recovery',
    status_hex: '00',
    sectors: [],
    filenames: [],
    sha256: id.repeat(64).slice(0, 64),
  });
  const a = backup('a', 'matching'),
    b = backup('b', 'different');
  storage.list.mockResolvedValue([a, b]);
  const download = vi.spyOn(fileFunctions, 'download').mockImplementation(() => {}),
    restore = vi.spyOn(firHardware, 'restoreFir').mockResolvedValue(undefined),
    session = {} as never,
    p = props();
  await act(async () =>
    root.render(
      <FirPanel
        {...p}
        preset={newProject().presets[0]}
        live={{ session, identity: { serial: 'matching' } as never }}
      />,
    ),
  );
  const recovery = host.querySelector('section[aria-label="FIR recovery images"]')!;
  expect(
    host.querySelector('table[aria-label="FIR banks"]')!.querySelectorAll('tbody tr'),
  ).toHaveLength(4);
  expect(recovery.textContent).toContain('2 saved');
  expect(recovery.textContent).toContain(a.sha256);
  expect(recovery.textContent).toContain(b.sha256);
  expect(buttons('Restore').map((button) => button.disabled)).toEqual([false, true]);
  await act(async () => buttons('Export')[0].click());
  expect(download).toHaveBeenCalledExactlyOnceWith('FIR-p2-a.json', JSON.stringify(a, null, 2));
  await act(async () => buttons('Restore')[0].click());
  expect(restore).toHaveBeenCalledExactlyOnceWith(session, a);
  expect(p.run).toHaveBeenCalledWith('Restoring FIR', expect.any(Function));
  expect(p.notice).toHaveBeenCalledWith(
    'Complete FIR recovery image restored and verified. Outputs remain muted.',
  );
});
