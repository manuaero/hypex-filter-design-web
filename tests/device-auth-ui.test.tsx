// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DeviceAuthPanel from '../src/components/DeviceAuthPanel';
import {
  createDeviceAuthController,
  type DeviceAuthBinding,
  type DeviceAuthController,
} from '../src/application/device-auth';
import { PanelSession, type Identity } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { hex } from '../src/hardware/codec';
import type { Slot } from '../src/domain/model';

let host: HTMLDivElement, root: Root;
const controllers: DeviceAuthController[] = [];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  controllers.splice(0).forEach((controller) => controller.dispose());
  host.remove();
  vi.restoreAllMocks();
});

function fixture(unlocked = false, connected = true) {
  const profiles = Object.fromEntries(
    (['left', 'right'] as const).map((slot) => {
      const panel = new SimulatedPanel(`AUTH-${slot.toUpperCase()}`);
      panel.deviceConfiguration[11] = slot === 'left' ? 1 : 0;
      panel.status[51] = unlocked ? 6 : 2;
      panel.status[24] = 0x00;
      panel.status[25] = slot === 'left' ? 0xf8 : 0xff;
      panel.eeprom.set(new TextEncoder().encode(`${slot}-demo`), 0x20);
      panel.eeprom.set(new TextEncoder().encode(`${slot}@example.test`), 0x50);
      const session = new PanelSession(
        panel,
        vi.fn(async () => {}),
      );
      const identity: Identity = {
        serial: panel.serial,
        product: 22,
        core: '5.1',
        firmware: '5.7',
        name: 'Synthetic',
        configuration: hex(panel.configuration),
      };
      return [slot, { panel, session, identity }];
    }),
  ) as Record<Slot, { panel: SimulatedPanel; session: PanelSession; identity: Identity }>;
  const bindings: Partial<Record<Slot, DeviceAuthBinding>> = connected
    ? {
        left: profiles.left,
        right: profiles.right,
      }
    : {};
  const controller = createDeviceAuthController({ binding: (slot) => bindings[slot] });
  controllers.push(controller);
  return { profiles, bindings, controller };
}
async function render(controller: DeviceAuthController, slot: Slot = 'left') {
  await act(async () => root.render(<DeviceAuthPanel controller={controller} slot={slot} />));
}
function input(label: string) {
  const field = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(field, label).not.toBeNull();
  return field!;
}
function select(label: string) {
  const field = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  expect(field, label).not.toBeNull();
  return field!;
}
function button(label: string) {
  const field = [...host.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(field, label).toBeDefined();
  return field!;
}
async function enter(label: string, text: string) {
  await act(async () => {
    const field = input(label);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose(label: string, value: string) {
  await act(async () => {
    const field = select(label);
    field.value = value;
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function click(label: string) {
  await act(async () => button(label).click());
}
function permission(label: string) {
  const field = [...host.querySelectorAll('label')]
    .find((item) => item.textContent?.trim() === label)
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(field, label).not.toBeNull();
  return field!;
}
async function toggle(label: string) {
  await act(async () => permission(label).click());
}
const credentials = (panel: SimulatedPanel) =>
  panel.requests.filter((request) => request[0] === 4 && request[1] === 2);
const values = () =>
  [...host.querySelectorAll<HTMLInputElement>('input[aria-label]')].map((field) => field.value);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('mounts with masked autocomplete-off fields and read-only protection queries, without reading email or touching the peer', async () => {
  const f = fixture();
  await render(f.controller);
  for (const label of [
    'Current amplifier password',
    'New amplifier password',
    'Retype new amplifier password',
  ]) {
    expect(input(label).type).toBe('password');
    expect(input(label).autocomplete).toBe('off');
    expect(input(label).value).toBe('');
  }
  expect(input('Amplifier recovery email').value).toBe('');
  expect(button('Read saved address').disabled).toBe(true);
  expect(button('Clear password').disabled).toBe(true);
  expect(host.textContent).toContain('AUTH-LEFT');
  expect(host.textContent).toContain('Password protected');
  expect(f.profiles.left.panel.requests.length).toBeGreaterThan(0);
  expect(credentials(f.profiles.left.panel)).toHaveLength(0);
  expect(f.profiles.right.panel.requests).toHaveLength(0);
  expect(f.profiles.left.panel.writes).toBe(0);
});

it('unlocks the captured synthetic panel and explicitly loads its saved address after verification', async () => {
  const f = fixture();
  await render(f.controller);
  await enter('Current amplifier password', 'left-demo');
  await click('Unlock amplifier');
  expect(f.profiles.left.panel.passwordVerifications).toBe(1);
  expect(credentials(f.profiles.left.panel).map((packet) => packet[2])).toEqual([2, 6]);
  expect(input('Amplifier recovery email').value).toBe('left@example.test');
  expect(input('New amplifier password').disabled).toBe(false);
  expect(host.textContent).toContain('Password verified');
  expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('left-demo');
  expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('left@example.test');
  expect(f.profiles.right.panel.requests).toHaveLength(0);
});

it('requires exact retype and explicit encoding, then changes raw bytes, shows the native ledger and wipes fields', async () => {
  const f = fixture();
  await render(f.controller);
  await enter('Current amplifier password', 'left-demo');
  await click('Unlock amplifier');
  await enter('New amplifier password', ' Cà ');
  await enter('Retype new amplifier password', ' Cà ');
  expect(button('Change password').disabled).toBe(true);
  expect(host.textContent).toContain('representable');
  await choose('New password encoding', 'windows-1252');
  await enter('Retype new amplifier password', ' CÀ ');
  expect(button('Change password').disabled).toBe(true);
  expect(host.textContent).toContain('match exactly');
  await enter('Retype new amplifier password', ' Cà ');
  expect(button('Change password').disabled).toBe(false);
  await click('Change password');
  expect([...f.profiles.left.panel.eeprom.slice(0x20, 0x25)]).toEqual([32, 67, 224, 32, 0]);
  expect(f.profiles.left.panel.passwordWrites).toBe(1);
  expect(f.profiles.left.panel.emailWrites).toBe(1);
  expect(values()).toEqual(['', '', '', '']);
  expect(host.textContent).toContain('Password: confirmed');
  expect(host.textContent).toContain('old password verification');
  expect(host.textContent).toContain('new password verification');
  expect(host.textContent).toContain('email readback');
  expect(host.textContent).toContain('final status');
  expect(f.profiles.right.panel.requests).toHaveLength(0);
  expect(f.profiles.left.panel.writes).toBe(0);
  expect(JSON.stringify(f.controller.getSnapshot())).not.toContain(' Cà ');
});

it('labels byte-HEX spaces as Clear, keeps exact-text confirmation and clears only the selected synthetic password', async () => {
  const f = fixture();
  await render(f.controller);
  await enter('Current amplifier password', 'left-demo');
  await click('Unlock amplifier');
  await choose('New password encoding', 'hex');
  await enter('New amplifier password', ' ');
  await enter('Retype new amplifier password', '  ');
  expect(button('Clear password').disabled).toBe(true);
  await enter('Retype new amplifier password', ' ');
  expect(button('Clear password').disabled).toBe(false);
  await click('Clear password');
  expect(f.profiles.left.panel.eeprom.slice(0x20, 0x30).every((byte) => byte === 0)).toBe(true);
  expect(f.profiles.left.panel.passwordWrites).toBe(1);
  expect(f.profiles.left.panel.emailWrites).toBe(1);
  expect(host.textContent).toContain('No password set');
  expect(values()).toEqual(['', '', '', '']);
  expect(f.profiles.right.panel.passwordWrites).toBe(0);
  expect(f.profiles.right.panel.requests).toHaveLength(0);
  expect(f.profiles.left.panel.writes).toBe(0);
});

it('reviews OEM replacement, revokes review after any draft edit and saves only a freshly reviewed mask', async () => {
  const f = fixture(true);
  await render(f.controller);
  await click('Allowed features');
  for (const forced of ['Input source', 'Volume and mute', 'Preset'])
    expect(permission(forced).disabled).toBe(true);
  expect(button('Save reviewed permissions').disabled).toBe(true);
  await toggle('Device settings');
  await click('Review permissions');
  expect(button('Save reviewed permissions').disabled).toBe(false);
  expect(host.textContent).toContain('Reviewed replacement');
  expect(host.textContent).toContain('0xf000');
  expect(f.profiles.left.panel.oemMaskUpdates).toBe(0);
  const staleReview = f.controller.getSnapshot().left.proposal!.id;
  await toggle('Bridge');
  expect(button('Save reviewed permissions').disabled).toBe(true);
  await expect(f.controller.saveOem('left', staleReview)).rejects.toThrow(/missing|consumed/);
  await toggle('Bridge');
  expect(button('Save reviewed permissions').disabled).toBe(true);
  await click('Review permissions');
  await click('Save reviewed permissions');
  expect(f.profiles.left.panel.oemMaskUpdates).toBe(1);
  expect(f.profiles.left.panel.status[24]).toBe(15);
  expect(f.profiles.left.panel.status[25]).toBe(8);
  expect(host.textContent).toContain('Permissions verified by readback');
  expect(button('Save reviewed permissions').disabled).toBe(true);
  expect(f.profiles.right.panel.requests).toHaveLength(0);
  expect(f.profiles.left.panel.writes).toBe(0);
});

it('does not autosave an OEM draft/review on unmount, and standard modules retain disabled permission editing', async () => {
  const f = fixture(true);
  await render(f.controller);
  await click('Allowed features');
  await toggle('Device settings');
  await click('Review permissions');
  await render(f.controller, 'right');
  await click('Allowed features');
  expect(host.textContent).toContain('configured OEM module');
  expect(permission('Device settings').closest('fieldset')!.disabled).toBe(true);
  await act(async () => root.render(null));
  expect(f.profiles.left.panel.oemMaskUpdates).toBe(0);
  expect(f.profiles.right.panel.oemMaskUpdates).toBe(0);
  expect(f.profiles.left.panel.passwordWrites + f.profiles.right.panel.passwordWrites).toBe(0);
});

it('clears all secrets on role change and discards a late left email without overwriting right fields or errors', async () => {
  const f = fixture(true),
    pending = deferred<Uint8Array>(),
    raw = new TextEncoder().encode('late-left@example.test');
  await render(f.controller);
  vi.spyOn(f.profiles.left.session, 'readRecoveryEmail').mockImplementation(() => pending.promise);
  await enter('Current amplifier password', 'left-demo');
  await enter('New amplifier password', 'left-new');
  await enter('Retype new amplifier password', 'left-new');
  await enter('Amplifier recovery email', 'private-left@example.test');
  // Start, but do not wait for the deliberately held read.
  await act(async () => button('Read saved address').click());
  await render(f.controller, 'right');
  expect(values()).toEqual(['', '', '', '']);
  expect(select('New password encoding').value).toBe('ascii');
  await enter('Amplifier recovery email', 'right-draft@example.test');
  await act(async () => pending.resolve(raw));
  expect(input('Amplifier recovery email').value).toBe('right-draft@example.test');
  expect(host.textContent).not.toContain('late-left');
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(raw.every((byte) => byte === 0)).toBe(true);
  expect(credentials(f.profiles.right.panel)).toHaveLength(0);
});

it('does not start an old-role saved-address load when delayed unlock finishes after switching roles', async () => {
  const f = fixture(),
    pending = deferred<void>(),
    verify = f.profiles.left.session.verifyPassword.bind(f.profiles.left.session),
    email = vi.spyOn(f.profiles.left.session, 'readRecoveryEmail');
  vi.spyOn(f.profiles.left.session, 'verifyPassword').mockImplementation(async (...args) => {
    await pending.promise;
    return verify(...args);
  });
  await render(f.controller);
  await enter('Current amplifier password', 'left-demo');
  await act(async () => button('Unlock amplifier').click());
  await render(f.controller, 'right');
  await act(async () => pending.resolve());
  expect(email).not.toHaveBeenCalled();
  expect(input('Amplifier recovery email').value).toBe('');
  expect(host.textContent).not.toContain('Saved address read');
  expect(host.textContent).toContain('AUTH-RIGHT');
  expect(f.profiles.right.panel.passwordVerifications).toBe(0);
  expect(credentials(f.profiles.right.panel)).toHaveLength(0);
});

it('wipes draft secrets with Clear form, without issuing password/email writes', async () => {
  const f = fixture(true);
  await render(f.controller);
  await enter('Current amplifier password', 'left-demo');
  await enter('New amplifier password', 'unsaved');
  await enter('Retype new amplifier password', 'unsaved');
  await enter('Amplifier recovery email', 'unsaved@example.test');
  await click('Clear form');
  expect(values()).toEqual(['', '', '', '']);
  expect(credentials(f.profiles.left.panel)).toHaveLength(0);
  expect(f.profiles.left.panel.passwordWrites).toBe(0);
  expect(f.profiles.left.panel.emailWrites).toBe(0);
});

it('loads protection when a disconnected panel connects later in the same component instance, without auto-reading email', async () => {
  const f = fixture(false, false);
  await render(f.controller);
  expect(host.textContent).toBe('');
  f.bindings.left = f.profiles.left;
  await act(async () => f.controller.refreshBindings());
  expect(host.textContent).toContain('Password protected');
  expect(host.textContent).not.toContain('Reading access');
  expect(f.controller.getSnapshot().left.protection?.locked).toBe(true);
  expect(credentials(f.profiles.left.panel)).toHaveLength(0);
  expect(f.profiles.right.panel.requests).toHaveLength(0);
});

it('supports a compact controlled editor and closing wipes secret fields and revokes review without credential or OEM writes', async () => {
  const f = fixture(true),
    changed = vi.fn();
  const show = async (view: 'closed' | 'password' | 'permissions') => {
    await act(async () =>
      root.render(
        <DeviceAuthPanel
          controller={f.controller}
          slot="left"
          view={view}
          onViewChange={changed}
        />,
      ),
    );
  };
  await show('closed');
  expect(host.querySelector('input[aria-label="Current amplifier password"]')).toBeNull();
  expect(host.textContent).toContain('AUTH-LEFT');
  await click('Manage access');
  expect(changed).toHaveBeenLastCalledWith('password');
  await show('password');
  await enter('Current amplifier password', 'left-demo');
  await enter('New amplifier password', 'unsaved');
  await enter('Retype new amplifier password', 'unsaved');
  await enter('Amplifier recovery email', 'unsaved@example.test');
  await click('Close access editor');
  expect(changed).toHaveBeenLastCalledWith('closed');
  await show('closed');
  await show('password');
  expect(values()).toEqual(['', '', '', '']);
  await show('permissions');
  await toggle('Device settings');
  await click('Review permissions');
  const review = f.controller.getSnapshot().left.proposal!.id;
  await show('closed');
  expect(f.controller.getSnapshot().left.proposal).toBeUndefined();
  await expect(f.controller.saveOem('left', review)).rejects.toThrow(/missing|consumed/);
  expect(credentials(f.profiles.left.panel)).toHaveLength(0);
  expect(f.profiles.left.panel.oemMaskUpdates).toBe(0);
  expect(f.profiles.left.panel.writes).toBe(0);
  expect(f.profiles.right.panel.requests).toHaveLength(0);
});
