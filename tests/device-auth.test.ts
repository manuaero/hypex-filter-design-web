import { describe, expect, it, vi } from 'vitest';
import {
  createDeviceAuthController,
  DeviceAuthOperationError,
  type CredentialInput,
  type DeviceAuthBinding,
  type DeviceAuthSession,
} from '../src/application/device-auth';
import { createToolExecutor, type ToolAdapter, type DocumentState } from '../src/application/tools';
import {
  PasswordOperationError,
  type PasswordOperationResult,
  type PasswordTarget,
} from '../src/hardware/password';
import { decodeProtection } from '../src/hardware/protection';
import { decodeStatus, packet } from '../src/hardware/codec';
import { PanelSession, type Identity } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { newProject, type Slot } from '../src/domain/model';

const credential = (
  text: string,
  encoding: CredentialInput['encoding'] = 'ascii',
): CredentialInput => ({ text, encoding });
const target = (serial: string): Identity => ({
  serial,
  product: 22,
  core: '5.1',
  firmware: '5.7',
  name: 'Synthetic',
  configuration: '',
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const result = (
  target: PasswordTarget,
  operation: PasswordOperationResult['operation'] = 'verify',
): PasswordOperationResult => ({
  operation,
  target: {
    serial: target.serial,
    product: target.product,
    core: target.core,
    firmware: target.firmware,
  },
  steps: [{ name: 'final-status', state: 'confirmed' }],
  passwordWrite: operation === 'change' || operation === 'clear' ? 'confirmed' : 'not-attempted',
  emailWrite: operation === 'email' || operation === 'change' ? 'confirmed' : 'not-attempted',
});
class FakeSession implements DeviceAuthSession {
  constructor(readonly identity: Identity) {}
  protection = vi.fn(async () => ({
    ...decodeProtection(decodeStatus(packet(5, 6, 1)), 1),
    identity: this.identity,
  }));
  verifyPassword = vi.fn(async (t: PasswordTarget, _bytes: Uint8Array) => result(t));
  changePassword = vi.fn(
    async (
      t: PasswordTarget,
      _input: { oldPassword?: Uint8Array; newPassword: Uint8Array; email?: Uint8Array },
    ) => result(t, 'change'),
  );
  readRecoveryEmail = vi.fn(async (_t: PasswordTarget) =>
    new TextEncoder().encode('private@example.org'),
  );
  setRecoveryEmail = vi.fn(async (t: PasswordTarget, _bytes: Uint8Array) => result(t, 'email'));
  proposeOemMask = vi.fn(async (t: PasswordTarget, mask: number) => ({
    target: t,
    previousMask: 0xffff,
    requestedMask: mask,
    targetMask: (mask & 0xff8) | 7,
    clearedMask: 0xffff & ~((mask & 0xff8) | 7),
    forcedMask: 7 & ~mask,
    ignoredRequestedMask: mask & 0xf000,
  }));
  setOemMask = vi.fn(async (t: PasswordTarget, mask: number, expected: number) => ({
    ...(await this.proposeOemMask(t, mask)),
    previousMask: expected,
    protection: decodeProtection(decodeStatus(packet(5, 6, 1)), 1),
  }));
}
function fixture() {
  const sessions = {
    left: new FakeSession(target('AUTH-LEFT')),
    right: new FakeSession(target('AUTH-RIGHT')),
  };
  const bindings: Partial<Record<Slot, DeviceAuthBinding>> = {
    left: { session: sessions.left, identity: sessions.left.identity },
    right: { session: sessions.right, identity: sessions.right.identity },
  };
  const controller = createDeviceAuthController({ binding: (slot) => bindings[slot] });
  return { sessions, bindings, controller };
}
function toolFixture() {
  const f = fixture();
  const state: DocumentState = {
    documents: { left: newProject(), right: newProject() },
    slot: 'right',
    preset: 2,
    channel: 1,
    filter: 0,
    linkedEdits: true,
    linkedControls: true,
  };
  const forbidden = vi.fn(() => {
    throw new Error('Unrelated hardware/document access');
  });
  const adapter: ToolAdapter = {
    state: () => state,
    auth: f.controller,
    edit: forbidden,
    choose: forbidden,
    undo: forbidden,
    redo: forbidden,
    connections: forbidden,
    connect: forbidden,
    disconnect: forbidden,
    refresh: forbidden,
    operate: async (_label, fn) => fn(),
    message: forbidden,
    progress: forbidden,
    view: forbidden,
  };
  return { ...f, adapter, state, forbidden, execute: createToolExecutor(adapter) };
}

describe('shared role-bound authentication controller', () => {
  it('publishes stable frozen secret-free snapshots and explicitly reads detached email only', async () => {
    const { controller, sessions } = fixture();
    const idle = controller.getSnapshot(),
      listener = vi.fn(),
      stop = controller.subscribe(listener);
    expect(controller.getSnapshot()).toBe(idle);
    expect(Object.isFrozen(idle.left.target)).toBe(true);
    await controller.status('left');
    expect(sessions.left.readRecoveryEmail).not.toHaveBeenCalled();
    expect(controller.getSnapshot().left.protection?.isOemConfigured).toBe(true);
    const sourceEmail = new TextEncoder().encode('private@example.org');
    sessions.left.readRecoveryEmail.mockResolvedValueOnce(sourceEmail);
    const email = await controller.readEmail('left');
    expect(new TextDecoder().decode(email)).toBe('private@example.org');
    expect(sourceEmail.every((byte) => byte === 0)).toBe(true);
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('private@example.org');
    email.fill(0);
    expect(controller.getSnapshot().right).toBe(idle.right);
    stop();
    const count = listener.mock.calls.length;
    controller.clear('left');
    expect(listener).toHaveBeenCalledTimes(count);
  });

  it('rejects same-role reentry while allowing the other role, and wipes controller-owned credential buffers', async () => {
    const { controller, sessions } = fixture(),
      pending = deferred<PasswordOperationResult>();
    sessions.left.verifyPassword.mockImplementationOnce(async () => pending.promise);
    const input = credential('keep-private'),
      left = controller.unlock('left', input);
    expect(controller.getSnapshot().left.busy).toBe(true);
    await expect(controller.unlock('left', credential('second'))).rejects.toThrow(
      'already running',
    );
    await controller.unlock('right', credential('right-secret'));
    expect(sessions.right.verifyPassword.mock.calls[0][1].every((byte) => byte === 0)).toBe(true);
    expect(sessions.left.verifyPassword.mock.calls[0][1].some(Boolean)).toBe(true);
    pending.resolve(result(sessions.left.identity));
    await left;
    expect(sessions.left.verifyPassword.mock.calls[0][1].every((byte) => byte === 0)).toBe(true);
    expect(input.text).toBe('keep-private');
  });

  it.each(['clear', 'replace', 'disconnect'] as const)(
    'does not publish a late reply after %s or redirect the captured write',
    async (action) => {
      const { controller, sessions, bindings } = fixture(),
        pending = deferred<PasswordOperationResult>();
      sessions.left.verifyPassword.mockImplementationOnce(async () => pending.promise);
      const active = controller.unlock('left', credential('private-late'));
      if (action === 'clear') controller.clear('left');
      else {
        bindings.left =
          action === 'replace'
            ? { session: sessions.right, identity: sessions.right.identity }
            : undefined;
        controller.refreshBindings();
      }
      await expect(controller.status('left')).rejects.toThrow(/running|connected/);
      pending.resolve(result(sessions.left.identity));
      await expect(active).rejects.toBeInstanceOf(DeviceAuthOperationError);
      expect(sessions.left.verifyPassword.mock.calls[0][0].serial).toBe('AUTH-LEFT');
      expect(sessions.right.verifyPassword).not.toHaveBeenCalled();
      expect(controller.getSnapshot().left.lastResult).toBeUndefined();
      expect(controller.getSnapshot().left.busy).toBe(false);
      expect(controller.getSnapshot().left.error).toBeUndefined();
    },
  );

  it('keeps native unconfirmed mutation ledgers intact while sanitizing arbitrary transport causes and encoding errors', async () => {
    const { controller, sessions } = fixture(),
      ledger = result(sessions.left.identity, 'change');
    ledger.passwordWrite = 'unconfirmed';
    ledger.steps = [{ name: 'password-write', state: 'unconfirmed' }];
    sessions.left.verifyPassword.mockRejectedValueOnce(
      new PasswordOperationError('secret-value private@example.org', ledger),
    );
    const error = await controller
      .unlock('left', credential('secret-value'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeviceAuthOperationError);
    expect((error as DeviceAuthOperationError).result).toEqual(ledger);
    expect(controller.getSnapshot().left.lastResult).toEqual(ledger);
    expect(sessions.left.verifyPassword.mock.calls[0][1].every((byte) => byte === 0)).toBe(true);
    expect(JSON.stringify(controller.getSnapshot())).not.toMatch(/secret-value|private@example/);
    sessions.right.verifyPassword.mockRejectedValueOnce(
      new Error('second-secret private@example.org'),
    );
    await expect(controller.unlock('right', credential('second-secret'))).rejects.not.toThrow(
      'second-secret',
    );
    await expect(controller.unlock('right', credential('☃', 'ascii'))).rejects.not.toThrow('☃');
    expect(sessions.right.verifyPassword).toHaveBeenCalledTimes(1);
  });

  it('retains the successful native ledger if the extra fresh protection read fails', async () => {
    const { controller, sessions } = fixture();
    sessions.left.protection.mockRejectedValueOnce(new Error('raw private data'));
    await expect(controller.unlock('left', credential('ok'))).rejects.toBeInstanceOf(
      DeviceAuthOperationError,
    );
    expect(controller.getSnapshot().left.lastResult).toEqual(result(sessions.left.identity));
  });

  it('validates captured fresh protected state, exact confirmation and explicit email before any credential mutation', async () => {
    const { controller, sessions } = fixture();
    const protectedReport = await sessions.left.protection();
    protectedReport.passwordProtected = true;
    sessions.left.protection.mockResolvedValue(protectedReport);
    const change = {
      next: credential('new-value'),
      confirm: credential('new-value'),
      email: credential('user@example.org'),
    };
    await expect(controller.change('left', change)).rejects.toThrow('invalid');
    await expect(
      controller.change('left', {
        ...change,
        current: credential('old'),
        confirm: credential('6e65772d76616c7565', 'hex'),
      }),
    ).rejects.toThrow('invalid');
    await controller.change('left', { ...change, current: credential('old') });
    const supplied = sessions.left.changePassword.mock.calls[0][1];
    expect(supplied.newPassword.every((byte) => byte === 0)).toBe(true);
    expect(supplied.oldPassword?.every((byte) => byte === 0)).toBe(true);
    expect(supplied.email?.every((byte) => byte === 0)).toBe(true);
    expect(change.next.text).toBe('new-value');
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('user@example.org');
    expect(sessions.left.changePassword).toHaveBeenCalledTimes(1);
  });

  it('fences readonly OEM proposals by exact role/session, consumes Save once and retains an unconfirmed save ledger', async () => {
    const { controller, sessions, bindings } = fixture();
    const preview = await controller.proposeOem('left', 0xf208);
    expect(preview).toMatchObject({
      slot: 'left',
      targetMask: 0x020f,
      ignoredRequestedMask: 0xf000,
    });
    expect(sessions.left.setOemMask).not.toHaveBeenCalled();
    await expect(controller.saveOem('right', preview.id)).rejects.toThrow('another connection');
    await controller.saveOem('left', preview.id);
    expect(sessions.left.setOemMask).toHaveBeenCalledWith(
      expect.objectContaining({ serial: 'AUTH-LEFT' }),
      0xf208,
      0xffff,
    );
    await expect(controller.saveOem('left', preview.id)).rejects.toThrow('consumed');
    const failed = await controller.proposeOem('left', 0x208);
    sessions.left.setOemMask.mockRejectedValueOnce(new Error('uncertain raw packet'));
    await expect(controller.saveOem('left', failed.id)).rejects.toThrow('not confirmed');
    expect(controller.getSnapshot().left.lastResult).toMatchObject({
      operation: 'oem-save',
      write: 'unconfirmed',
    });
    await expect(controller.saveOem('left', failed.id)).rejects.toThrow('consumed');
    const old = await controller.proposeOem('left', 0x208);
    bindings.left = { session: sessions.right, identity: sessions.right.identity };
    controller.refreshBindings();
    await expect(controller.saveOem('left', old.id)).rejects.toThrow('another connection');
    expect(sessions.right.setOemMask).not.toHaveBeenCalled();
  });

  it('captures password-change input before asynchronous preflight, and does not revive after dispose', async () => {
    const { controller, sessions } = fixture(),
      pending = deferred<Awaited<ReturnType<DeviceAuthSession['protection']>>>();
    const ready = await sessions.left.protection();
    sessions.left.protection.mockImplementationOnce(async () => pending.promise);
    const input = {
      next: credential('fixed-new'),
      confirm: credential('fixed-new'),
      email: credential('fixed@example.org'),
    };
    let observed = '';
    sessions.left.changePassword.mockImplementationOnce(async (t, supplied) => {
      observed = new TextDecoder().decode(supplied.newPassword);
      return result(t, 'change');
    });
    const changing = controller.change('left', input);
    input.next.text = 'retarget';
    input.confirm.text = 'retarget';
    input.email.text = 'other@example.org';
    pending.resolve(ready);
    await changing;
    expect(observed).toBe('fixed-new');
    controller.dispose();
    controller.clear('left');
    expect(controller.getSnapshot().left).toEqual({
      phase: 'disconnected',
      connected: false,
      busy: false,
    });
    await expect(controller.status('left', false)).rejects.toThrow('disposed');
    await expect(controller.unlock('left', credential('x'))).rejects.toThrow('disposed');
  });

  it('refuses cached status for a disconnected role and validates decoded HEX email before writing', async () => {
    const { controller, sessions, bindings } = fixture();
    await controller.writeEmail(
      'left',
      credential(Buffer.from('hex@example.org').toString('hex'), 'hex'),
    );
    expect(sessions.left.setRecoveryEmail).toHaveBeenCalledTimes(1);
    await expect(controller.writeEmail('left', credential('bad-email'))).rejects.toThrow('invalid');
    expect(sessions.left.setRecoveryEmail).toHaveBeenCalledTimes(1);
    bindings.right = undefined;
    controller.refreshBindings();
    await expect(controller.status('right', false)).rejects.toThrow('not connected');
  });

  it('performs selected native session unlock/change/email/OEM round trips over an independent synthetic transport', async () => {
    const panel = new SimulatedPanel('AUTH-ROUNDTRIP'),
      session = new PanelSession(panel, async () => {});
    panel.deviceConfiguration[11] = 1;
    panel.eeprom.set(new TextEncoder().encode('old'), 0x20);
    panel.status[51] = 2;
    const identity = await session.identify();
    const controller = createDeviceAuthController({
      binding: (slot) => (slot === 'left' ? { session, identity } : undefined),
    });
    await controller.unlock('left', credential('old'));
    expect(controller.getSnapshot().left.protection?.locked).toBe(false);
    await controller.change('left', {
      current: credential('old'),
      next: credential('new'),
      confirm: credential('new'),
      email: credential('test@example.org'),
    });
    expect(new TextDecoder().decode(await controller.readEmail('left'))).toBe('test@example.org');
    await controller.writeEmail('left', credential('other@example.org'));
    const preview = await controller.proposeOem('left', 0x0208);
    await controller.saveOem('left', preview.id);
    expect(panel.oemMaskUpdates).toBe(1);
    expect(panel.passwordWrites).toBe(1);
    expect(panel.emailWrites).toBe(2);
    expect(controller.getSnapshot().left.protection?.rawMask).toBe(0x020f);
    expect(JSON.stringify(controller.getSnapshot())).not.toMatch(/test@example|other@example/);
  });
});

describe('cached fusion_device_read auth namespace', () => {
  it('uses the exact controller and explicit role, with email only in the requested read result and no document/hardware adapter calls', async () => {
    const { execute, controller, sessions, state, forbidden } = toolFixture(),
      baseline = structuredClone(state);
    const status = (await execute('fusion_device_read', {
      target: 'both',
      auth: { action: 'status' },
    })) as { ok: boolean; auth: object };
    expect(status.ok).toBe(true);
    expect(status.auth).toEqual(controller.getSnapshot());
    const unlocked = (await execute('fusion_device_read', {
      target: 'right',
      auth: { action: 'unlock', credential: credential('exact-right') },
    })) as { ok: boolean };
    expect(unlocked.ok).toBe(true);
    expect(sessions.left.verifyPassword).not.toHaveBeenCalled();
    expect(sessions.right.verifyPassword).toHaveBeenCalledWith(
      expect.objectContaining({ serial: 'AUTH-RIGHT' }),
      expect.any(Uint8Array),
    );
    const email = (await execute('fusion_device_read', {
      target: 'right',
      auth: { action: 'email-read' },
    })) as { ok: boolean; email: { bytes: number[] } };
    expect(new TextDecoder().decode(new Uint8Array(email.email.bytes))).toBe('private@example.org');
    expect(
      JSON.stringify(
        await execute('fusion_device_read', {
          target: 'right',
          auth: { action: 'status', refresh: false },
        }),
      ),
    ).not.toContain('private@example.org');
    expect(state).toEqual(baseline);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it.each([
    { target: 'both', auth: { action: 'unlock', credential: credential('x') } },
    {
      target: 'left',
      auth: { action: 'unlock', credential: credential('x'), identity: target('SPOOF') },
    },
    { target: 'left', auth: { action: 'status', credential: credential('hidden') } },
    { target: 'left', auth: { action: 'status' }, firmware: { action: 'status' } },
    {
      target: 'left',
      auth: { action: 'password-change', next: credential('x'), confirm: credential('x') },
    },
    { target: 'left', auth: { action: 'oem-propose', mask: -1 } },
    { target: 'left', auth: { action: 'email-read', owner: 'spoof' } },
  ])(
    'rejects mixed, spoofed or incomplete auth arguments before invoking sessions: %j',
    async (input) => {
      const { execute, sessions, forbidden } = toolFixture();
      expect(await execute('fusion_device_read', input)).toMatchObject({ ok: false });
      expect(sessions.left.protection).not.toHaveBeenCalled();
      expect(sessions.left.verifyPassword).not.toHaveBeenCalled();
      expect(forbidden).not.toHaveBeenCalled();
    },
  );

  it('returns the native unconfirmed password ledger without secrets, and requires explicit preview ID before OEM Save', async () => {
    const { execute, sessions } = toolFixture(),
      ledger = result(sessions.left.identity, 'change');
    ledger.passwordWrite = 'unconfirmed';
    sessions.left.verifyPassword.mockRejectedValueOnce(
      new PasswordOperationError('hidden-input', ledger),
    );
    const failure = await execute('fusion_device_read', {
      target: 'left',
      auth: { action: 'unlock', credential: credential('hidden-input') },
    });
    expect(failure).toMatchObject({ ok: false, result: ledger });
    expect(JSON.stringify(failure)).not.toContain('hidden-input');
    const proposal = (await execute('fusion_device_read', {
      target: 'left',
      auth: { action: 'oem-propose', mask: 0x208 },
    })) as { result: { id: string } };
    expect(sessions.left.setOemMask).not.toHaveBeenCalled();
    expect(
      await execute('fusion_device_read', {
        target: 'left',
        auth: { action: 'oem-save', proposalId: proposal.result.id },
      }),
    ).toMatchObject({ ok: true });
    expect(
      await execute('fusion_device_read', {
        target: 'left',
        auth: { action: 'oem-save', proposalId: proposal.result.id },
      }),
    ).toMatchObject({ ok: false });
    expect(sessions.left.setOemMask).toHaveBeenCalledTimes(1);
  });
});
