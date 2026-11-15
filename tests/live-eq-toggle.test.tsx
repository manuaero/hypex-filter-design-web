// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LiveEqToggle from '../src/components/LiveEqToggle';
import { decodeStatus, type Controls } from '../src/hardware/codec';
import { PanelSession, type Identity } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';

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
function fixture(serial = 'EQ-LEFT', module = 2, locked = false, mask = 0) {
  const panel = new SimulatedPanel(serial),
    session = new PanelSession(panel, async () => {});
  panel.deviceConfiguration[11] = module;
  panel.status[51] = locked ? 2 : 0;
  panel.status[24] = mask & 255;
  panel.status[25] = mask >> 8;
  panel.status[2] = 2;
  panel.status[13] = 16;
  const identity: Identity = {
    serial,
    product: 22,
    core: '5.1',
    firmware: '5.7',
    name: 'Synthetic EQ',
    configuration: '',
  };
  return {
    panel,
    session,
    identity,
    get live() {
      return { session, identity, status: decodeStatus(panel.status) };
    },
  };
}
const checkbox = () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
async function render(
  f?: ReturnType<typeof fixture>,
  onChange = vi.fn(async (_preset: number, _enabled: boolean) => {}),
  busy = false,
) {
  await act(async () =>
    root.render(<LiveEqToggle live={f?.live} role="Left" busy={busy} onChange={onChange} />),
  );
}
it('keeps the offline/busy live control separate from the staged design and never invokes a change', async () => {
  const onChange = vi.fn(async () => {});
  await render(undefined, onChange);
  expect(checkbox().disabled).toBe(true);
  expect(host.textContent).toContain('Offline');
  const f = fixture();
  await render(f, onChange, true);
  expect(checkbox().disabled).toBe(true);
  expect(host.textContent).toContain('Left amp P2 EQ');
  expect(onChange).not.toHaveBeenCalled();
  expect(f.panel.requests).toHaveLength(0);
});
it('captures the displayed active preset and preserves another newly active preset, flash, volume and mute', async () => {
  const f = fixture(),
    original = f.panel.status.slice(),
    flash = f.panel.memory.slice();
  let patch: Controls | undefined;
  const change = vi.fn(async (preset: number, enabled: boolean) => {
    patch = { presetEq: { preset, enabled } };
    // A physical preset change after the click must not redirect the named target.
    f.panel.status[2] = 3;
    await f.session.preflightControls(patch);
    await f.session.setControls(patch);
  });
  await render(f, change);
  expect(checkbox().checked).toBe(true);
  await act(async () => checkbox().click());
  expect(change).toHaveBeenCalledWith(2, false);
  expect(patch).toEqual({ presetEq: { preset: 2, enabled: false } });
  expect(f.panel.status[2]).toBe(3);
  expect(f.panel.status[13] & 16).toBe(0);
  for (const i of [3, 4, 6, 12, 14]) expect(f.panel.status[i]).toBe(original[i]);
  expect(f.panel.memory).toEqual(flash);
  expect(f.panel.requests.filter((r) => r[0] === 5 && r[1] === 0)).toHaveLength(1);
  await render(f, change);
  expect(host.textContent).toContain('Left amp P3 EQ');
  expect(host.textContent).toContain('Bypassed');
});
it('allows protected OEM Equalizer permission without upload/device-settings permissions and denies protected standard modules', async () => {
  const denied = fixture('STANDARD', 2, true, 0xffff),
    onChange = vi.fn(async () => {});
  await render(denied, onChange);
  expect(checkbox().disabled).toBe(true);
  expect(host.querySelector('label')?.title).toContain('non-OEM');
  expect(denied.panel.requests.some((r) => r[0] === 5 && r[1] === 0)).toBe(false);
  const allowed = fixture('OEM', 1, true, 1 << 11);
  const change = vi.fn(async (preset: number, enabled: boolean) => {
    await allowed.session.setControls({ presetEq: { preset, enabled } });
  });
  await render(allowed, change);
  expect(checkbox().disabled).toBe(false);
  await act(async () => checkbox().click());
  expect(change).toHaveBeenCalledWith(2, false);
  expect(allowed.panel.status[13] & 16).toBe(0);
  expect(allowed.panel.requests.some((r) => r[0] === 0x64)).toBe(false);
});
it('ignores a late permission reply from the previous amplifier', async () => {
  const old = fixture('OLD', 1, true, 1 << 11),
    current = fixture('CURRENT', 2, true, 0xffff);
  const oldReport = await old.session.protection();
  let resolve!: (value: typeof oldReport) => void;
  vi.spyOn(old.session, 'protection').mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  await render(old);
  expect(checkbox().disabled).toBe(true);
  await render(current);
  expect(checkbox().disabled).toBe(true);
  await act(async () => resolve(oldReport));
  expect(checkbox().disabled).toBe(true);
  expect(host.querySelector('label')?.title).toContain('non-OEM');
});
