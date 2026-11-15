// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import PasswordRecoveryPanel from '../src/components/PasswordRecoveryPanel';
import {
  createPasswordRecoveryController,
  type PasswordRecoveryBinding,
  type PasswordRecoveryController,
} from '../src/application/password-recovery';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';

let host: HTMLDivElement, root: Root, controller: PasswordRecoveryController;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  controller?.dispose();
  host.remove();
});
async function fixture() {
  const panel = new SimulatedPanel('RECOVERY-UI');
  panel.deviceConfiguration[11] = 1;
  panel.status[51] = 2;
  panel.eeprom.set(new TextEncoder().encode('retained-password'), 0x20);
  const session = new PanelSession(panel, async () => {});
  const binding: PasswordRecoveryBinding = {
    session,
    identity: { serial: panel.serial, product: 22, core: '5.1', firmware: '5.7' },
  };
  controller = createPasswordRecoveryController({
    binding: (slot) => (slot === 'left' ? binding : undefined),
    randomGuid: () => '01234567-89ab-cdef-0123-456789abcdef',
  });
  await act(async () => root.render(<PasswordRecoveryPanel controller={controller} slot="left" />));
  return { panel, session, binding };
}
function button(label: string) {
  const b = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  expect(b, label).toBeDefined();
  return b!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function check(text: string) {
  const label = [...host.querySelectorAll('label')].find((l) => l.textContent?.includes(text));
  expect(label, text).toBeDefined();
  const field = label!.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  await act(async () => field.click());
}
async function enter(text: string) {
  const field = host.querySelector<HTMLInputElement>('input[aria-label="Received unlock code"]')!;
  expect(field).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('opening and readonly review do not install a challenge until explicit checkbox+confirmation', async () => {
  const { panel } = await fixture();
  await click('Review new request');
  expect(panel.recoveryChallengeInstalls).toBe(0);
  expect(button('Confirm unlock request').disabled).toBe(true);
  expect(
    host.querySelector<HTMLInputElement>('input[aria-label="Recovery unique key"]')?.value,
  ).toBe('0123456789ABCDEF');
  await check('Install this unique key');
  await click('Confirm unlock request');
  expect(panel.recoveryChallengeInstalls).toBe(1);
  expect(host.textContent).toContain('Persistent challenge readback unavailable');
  expect(button('Confirm unlock request').disabled).toBe(true);
});
it('supports an existing HFD request, masks code input and shows canonical native prefix for explicit reset review', async () => {
  const { panel } = await fixture();
  panel.receivedRecoveryCode = 0xabcd;
  expect(button('Review existing support request').disabled).toBe(true);
  await check('I already requested');
  await click('Review existing support request');
  expect(panel.recoveryChallengeInstalls).toBe(0);
  expect(
    host.querySelector<HTMLInputElement>('input[aria-label="Received unlock code"]')?.type,
  ).toBe('password');
  await enter('abcd-suffix');
  await check('This code came from Hypex support');
  await click('Review received code');
  expect(host.textContent).toContain('ABCD');
  expect(host.textContent).not.toContain('abcd-suffix');
  expect(JSON.stringify(controller.getSnapshot())).not.toContain('ABCD');
  await click('Confirm password reset');
  expect(panel.recoveryCodeSubmissions).toBe(1);
  expect(panel.eeprom[0x20]).toBe(0);
  expect(host.textContent).toContain('Fresh status reports no password set');
});
it('editing code after review removes reset confirmation and invalidates its opaque token', async () => {
  const { panel } = await fixture();
  await check('I already requested');
  await click('Review existing support request');
  await enter('abcd');
  await check('This code came from Hypex support');
  await click('Review received code');
  expect(button('Confirm password reset')).toBeDefined();
  await enter('1234');
  expect(
    [...host.querySelectorAll('button')].some((b) => b.textContent === 'Confirm password reset'),
  ).toBe(false);
  expect(controller.getSnapshot().left.codeReviewReady).toBe(false);
  expect(panel.recoveryCodeSubmissions).toBe(0);
});
it('Clear drops reviews without a device command or credential mutation', async () => {
  const { panel } = await fixture();
  await click('Review new request');
  const requests = panel.requests.length;
  await click('Clear recovery form');
  expect(controller.getSnapshot().left.review).toBeUndefined();
  expect(panel.requests.length).toBe(requests);
  expect(panel.eeprom[0x20]).not.toBe(0);
  expect(panel.recoveryChallengeInstalls).toBe(0);
});
it('a paused hardware owner disables recovery writes', async () => {
  const { panel } = await fixture();
  await act(async () =>
    root.render(<PasswordRecoveryPanel controller={controller} slot="left" paused />),
  );
  expect(button('Review new request').disabled).toBe(true);
  expect(button('Review existing support request').disabled).toBe(true);
  expect(panel.requests).toHaveLength(0);
});
