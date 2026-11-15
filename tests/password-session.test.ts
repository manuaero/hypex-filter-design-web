import { describe, expect, it } from 'vitest';
import { decodeStatus, packet } from '../src/hardware/codec';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { PasswordOperationError, type PasswordTarget } from '../src/hardware/password';

const bytes = (text: string) => new TextEncoder().encode(text);
function fixture(password = '', matched = false) {
  const panel = new SimulatedPanel('SYNTHETIC-AUTH'),
    session = new PanelSession(panel, async () => {}),
    target: PasswordTarget = { serial: panel.serial, product: 22, core: '5.1', firmware: '5.7' };
  panel.eeprom.set(bytes(password), 0x20);
  panel.status[51] = (password.length ? 2 : 0) | (matched ? 4 : 0);
  panel.deviceConfiguration[11] = 1;
  return { panel, session, target };
}
const secretCommands = (panel: SimulatedPanel) => panel.requests.filter((r) => r[0] === 4);
async function failed(operation: Promise<unknown>) {
  try {
    await operation;
    throw new Error('Expected failure');
  } catch (error) {
    expect(error).toBeInstanceOf(PasswordOperationError);
    return error as PasswordOperationError;
  }
}
const storedPassword = (panel: SimulatedPanel) => panel.eeprom.slice(0x20, 0x30);

describe('selected-panel credential session workflows', () => {
  it('verifies a protected syntheticcredential without persistent writes and returns bounded flags only', async () => {
    const { panel, session, target } = fixture('fixture-old'),
      before = panel.eeprom.slice(),
      result = await session.verifyPassword(target, bytes('fixture-old'));
    expect(result.operation).toBe('verify');
    expect(result.protection).toMatchObject({
      passwordProtected: true,
      passwordMatched: true,
      locked: false,
    });
    expect(result.steps.every((step) => step.state === 'confirmed')).toBe(true);
    expect(panel.eeprom).toEqual(before);
    expect(panel.passwordWrites + panel.emailWrites).toBe(0);
    expect(JSON.stringify(result)).not.toContain('fixture-old');
    expect(secretCommands(panel).map((r) => r[2])).toEqual([2]);
  });
  it('returns a rejected verification and updates native matchedstate false without changing stored bytes', async () => {
    const { panel, session, target } = fixture('fixture-old', true),
      before = storedPassword(panel),
      error = await failed(session.verifyPassword(target, bytes('fixture-wrong')));
    expect(error.result.steps[0]).toEqual({ name: 'verification', state: 'rejected' });
    expect(error.result.protection?.locked).toBe(true);
    expect(storedPassword(panel)).toEqual(before);
    expect(panel.passwordWrites).toBe(0);
    expect(secretCommands(panel)).toHaveLength(1);
  });
  it('changes protected passwords viaoldverify/set/newverify/email/readback and preserves other panel state', async () => {
    const { panel, session, target } = fixture('fixture-old'),
      originalStatus = panel.status.slice(),
      result = await session.changePassword(target, {
        oldPassword: bytes('fixture-old'),
        newPassword: bytes('fixture-new'),
        email: bytes('fixture@example.test'),
      });
    expect(secretCommands(panel).map((r) => r[2])).toEqual([2, 0, 2, 5, 6]);
    expect(result).toMatchObject({
      operation: 'change',
      passwordWrite: 'confirmed',
      emailWrite: 'confirmed',
      protection: { passwordProtected: true, passwordMatched: true, locked: false },
    });
    expect(panel.passwordWrites).toBe(1);
    expect(panel.emailWrites).toBe(1);
    expect(new TextDecoder().decode(storedPassword(panel)).replace(/\0.*$/s, '')).toBe(
      'fixture-new',
    );
    expect(await session.readRecoveryEmail(target)).toEqual(bytes('fixture@example.test'));
    expect(panel.status.slice(0, 51)).toEqual(originalStatus.slice(0, 51));
    expect(panel.writes).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/fixture-old|fixture-new|fixture@example/);
  });
  it('sets an unprotected16byte arbitrarybyte credential and clears through emptyset/emptyverify', async () => {
    const { panel, session, target } = fixture(),
      credential = new Uint8Array(16).fill(0xff);
    const installed = await session.changePassword(target, { newPassword: credential });
    expect(installed.passwordWrite).toBe('confirmed');
    expect(storedPassword(panel)).toEqual(credential);
    expect(secretCommands(panel).map((r) => r[2])).toEqual([0, 2]);
    const cleared = await session.changePassword(target, {
      oldPassword: credential,
      newPassword: new Uint8Array(),
      email: new Uint8Array(),
    });
    expect(cleared.operation).toBe('clear');
    expect(cleared.protection).toMatchObject({
      passwordProtected: false,
      passwordMatched: true,
      locked: false,
    });
    expect(storedPassword(panel)).toEqual(new Uint8Array(16));
    expect(panel.eeprom.slice(0x50, 0x88)).toEqual(new Uint8Array(56));
    expect(
      secretCommands(panel)
        .slice(2)
        .map((r) => r[2]),
    ).toEqual([2, 0, 2, 5, 6]);
  });
  it('preserves recovery email when omitted from clear and never invents a logout command', async () => {
    const { panel, session, target } = fixture('fixture-old');
    panel.eeprom.set(bytes('retained@example.test'), 0x50);
    await session.changePassword(target, {
      oldPassword: bytes('fixture-old'),
      newPassword: new Uint8Array(),
    });
    expect(panel.emailWrites).toBe(0);
    expect(await session.readRecoveryEmail(target)).toEqual(bytes('retained@example.test'));
    expect(secretCommands(panel).every((r) => [0, 2, 6].includes(r[2]))).toBe(true);
  });
  it('requires the current credential for protected changes even when an earlier password was matched', async () => {
    const { panel, session, target } = fixture('fixture-old', true),
      error = await failed(session.changePassword(target, { newPassword: bytes('fixture-new') }));
    expect(error.result.passwordWrite).toBe('not-attempted');
    expect(secretCommands(panel)).toHaveLength(0);
    expect(panel.passwordWrites).toBe(0);
  });
  it('stops after a wrong old credential before newpassword or email writes', async () => {
    const { panel, session, target } = fixture('fixture-old'),
      error = await failed(
        session.changePassword(target, {
          oldPassword: bytes('wrong'),
          newPassword: bytes('fixture-new'),
          email: bytes('fixture@example.test'),
        }),
      );
    expect(error.result.passwordWrite).toBe('not-attempted');
    expect(panel.passwordWrites + panel.emailWrites).toBe(0);
    expect(secretCommands(panel).map((r) => r[2])).toEqual([2]);
  });
  it('validates every secret before any request, including an unroundtrippable email', async () => {
    for (const input of [
      { newPassword: new Uint8Array(17).fill(65) },
      { newPassword: bytes('fixture'), oldPassword: new Uint8Array([0]) },
      { newPassword: bytes('fixture'), email: new Uint8Array(56).fill(65) },
      { newPassword: bytes('fixture'), email: new Uint8Array([255]) },
    ]) {
      const { panel, session, target } = fixture();
      await expect(session.changePassword(target, input)).rejects.toThrow();
      expect(panel.requests).toHaveLength(0);
    }
  });
  it('refuses captured identity or firmware changes before any secret packet', async () => {
    for (const change of [
      (p: SimulatedPanel) => {
        p.eeprom.fill(0, 0x100, 0x120);
        p.eeprom.set(bytes('OTHER'), 0x100);
      },
      (p: SimulatedPanel) => {
        p.configuration[17] = 8;
      },
      (p: SimulatedPanel) => {
        p.configuration[3] = 2;
      },
    ]) {
      const { panel, session, target } = fixture('fixture-old');
      change(panel);
      await failed(session.verifyPassword(target, bytes('fixture-old')));
      expect(secretCommands(panel)).toHaveLength(0);
    }
  });
  it('reidentifies afteroldverify so a replacement amplifier never receives the new credential', async () => {
    const { panel, session, target } = fixture('fixture-old'),
      exchange = panel.exchange.bind(panel);
    panel.exchange = async (request) => {
      const reply = await exchange(request);
      if (request[0] === 4 && request[2] === 2) {
        panel.eeprom.fill(0, 0x100, 0x120);
        panel.eeprom.set(bytes('OTHER'), 0x100);
      }
      return reply;
    };
    const error = await failed(
      session.changePassword(target, {
        oldPassword: bytes('fixture-old'),
        newPassword: bytes('fixture-new'),
      }),
    );
    expect(error.result.passwordWrite).toBe('not-attempted');
    expect(panel.passwordWrites).toBe(0);
    expect(secretCommands(panel).map((r) => r[2])).toEqual([2]);
  });
  it('reports a confirmed password change followed by an unconfirmed email write without leaking errors', async () => {
    const { panel, session, target } = fixture('fixture-old'),
      exchange = panel.exchange.bind(panel);
    panel.exchange = async (request) => {
      if (request[0] === 4 && request[2] === 5)
        throw new Error('fixture-new raw confidential transport dump');
      return exchange(request);
    };
    const error = await failed(
      session.changePassword(target, {
        oldPassword: bytes('fixture-old'),
        newPassword: bytes('fixture-new'),
        email: bytes('fixture@example.test'),
      }),
    );
    expect(error.result.passwordWrite).toBe('confirmed');
    expect(error.result.emailWrite).toBe('unconfirmed');
    expect(panel.passwordWrites).toBe(1);
    expect(panel.emailWrites).toBe(0);
    expect(error.message + JSON.stringify(error.result) + error.stack).not.toMatch(
      /fixture-new|fixture-old|confidential|fixture@example/,
    );
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });
  it('never retries or rolls back an ambiguous passwordwrite that actually reached the target', async () => {
    const { panel, session, target } = fixture(),
      exchange = panel.exchange.bind(panel);
    panel.exchange = async (request) => {
      const reply = await exchange(request);
      if (request[0] === 4 && request[2] === 0) throw new Error('synthetic timeout');
      return reply;
    };
    const error = await failed(
      session.changePassword(target, {
        newPassword: bytes('fixture-new'),
        email: bytes('fixture@example.test'),
      }),
    );
    expect(error.result.passwordWrite).toBe('unconfirmed');
    expect(panel.passwordWrites).toBe(1);
    expect(panel.emailWrites).toBe(0);
    expect(secretCommands(panel).map((r) => r[2])).toEqual([0]);
    expect(new TextDecoder().decode(storedPassword(panel))).toContain('fixture-new');
  });
  it('distinguishes acknowledged email from verified readback after a partial failure', async () => {
    const { panel, session, target } = fixture(),
      exchange = panel.exchange.bind(panel);
    panel.exchange = async (request) => {
      const reply = await exchange(request);
      if (request[0] === 4 && request[2] === 6) reply[2] ^= 1;
      return reply;
    };
    const error = await failed(session.setRecoveryEmail(target, bytes('fixture@example.test')));
    expect(error.result.passwordWrite).toBe('not-attempted');
    expect(error.result.emailWrite).toBe('acknowledged');
    expect(panel.emailWrites).toBe(1);
    expect(secretCommands(panel).map((r) => r[2])).toEqual([5, 6]);
  });

  it.each([0, 3])(
    'does not continue after rejected or malformed password-write reply raw1=%s',
    async (replyCode) => {
      const { panel, session, target } = fixture(),
        exchange = panel.exchange.bind(panel);
      panel.exchange = async (request) => {
        if (request[0] === 4 && request[2] === 0) {
          await exchange(request);
          return packet(4, replyCode);
        }
        return exchange(request);
      };
      const error = await failed(
        session.changePassword(target, {
          newPassword: bytes('fixture-new'),
          email: bytes('fixture@example.test'),
        }),
      );
      expect(error.result.passwordWrite).toBe('unconfirmed');
      expect(error.result.steps.at(-1)?.state).toBe(replyCode === 0 ? 'rejected' : 'unconfirmed');
      expect(panel.passwordWrites).toBe(1);
      expect(panel.emailWrites).toBe(0);
      expect(secretCommands(panel).map((r) => r[2])).toEqual([0]);
    },
  );

  it('does not promote a password-write ACK to confirmed when new verification status disagrees', async () => {
    const { panel, session, target } = fixture(),
      exchange = panel.exchange.bind(panel);
    panel.exchange = async (request) => {
      const reply = await exchange(request);
      if (request[0] === 4 && request[2] === 2) panel.status[51] &= ~4;
      return reply;
    };
    const error = await failed(
      session.changePassword(target, { newPassword: bytes('fixture-new') }),
    );
    expect(error.result.passwordWrite).toBe('acknowledged');
    expect(error.result.steps.at(-1)).toEqual({
      name: 'new-password-verification',
      state: 'unconfirmed',
    });
    expect(error.result.protection?.locked).toBe(true);
    expect(panel.passwordWrites).toBe(1);
  });

  it('drops unrelated caller properties from captured targets and sanitizes email-read failures', async () => {
    const { panel, session, target } = fixture(),
      dirty = { ...target, unrelatedSecret: 'fixture-secret' };
    const result = await session.changePassword(dirty, { newPassword: bytes('fixture-new') });
    expect(result.target).toEqual(target);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    const exchange = panel.exchange.bind(panel);
    panel.exchange = async (request) => {
      if (request[0] === 4 && request[2] === 6) throw new Error('fixture-secret');
      return exchange(request);
    };
    await expect(session.readRecoveryEmail(target)).rejects.toThrow(
      'Recovery email could not be confirmed',
    );
  });
  it('permits lockedemailread, requires unlockedemailwrite and handles all56 legacy stored bytes', async () => {
    const { panel, session, target } = fixture('fixture-old');
    panel.eeprom.fill(0xe9, 0x50, 0x88);
    expect(await session.readRecoveryEmail(target)).toEqual(new Uint8Array(56).fill(0xe9));
    await failed(session.setRecoveryEmail(target, bytes('fixture@example.test')));
    expect(panel.emailWrites).toBe(0);
    await session.verifyPassword(target, bytes('fixture-old'));
    const result = await session.setRecoveryEmail(target, bytes('fixture@example.test'));
    expect(result.emailWrite).toBe('confirmed');
    expect(panel.passwordWrites).toBe(0);
  });
  it('snapshots queued proposals and wipes owned request/reply buffers while preserving caller ownership', async () => {
    const { panel, session, target } = fixture(),
      exchange = panel.exchange.bind(panel),
      requests: Uint8Array[] = [],
      replies: Uint8Array[] = [];
    panel.exchange = async (request) => {
      const reply = await exchange(request);
      if (request[0] === 4) {
        requests.push(request);
        replies.push(reply);
      }
      return reply;
    };
    let release!: () => void;
    const hold = session.exclusive(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const credential = bytes('fixture-new'),
      email = bytes('fixture@example.test'),
      pending = session.changePassword(target, { newPassword: credential, email });
    credential.fill(90);
    email.fill(88);
    target.serial = 'MUTATED-CALLER';
    release();
    await hold;
    const result = await pending;
    expect(result.target.serial).toBe('SYNTHETIC-AUTH');
    expect(new TextDecoder().decode(storedPassword(panel))).toContain('fixture-new');
    expect(credential.every((v) => v === 90)).toBe(true);
    expect(email.every((v) => v === 88)).toBe(true);
    expect(
      requests
        .filter((r, i) => secretCommands(panel)[i]?.[2] !== 6)
        .every((r) => r.every((v) => v === 0)),
    ).toBe(true);
    expect(replies.every((r) => r.every((v) => v === 0))).toBe(true);
  });
  it('holds one exclusive reservation through the workflow before ordinary controls can run', async () => {
    const { panel, session, target } = fixture('fixture-old');
    await Promise.all([
      session.changePassword(target, {
        oldPassword: bytes('fixture-old'),
        newPassword: bytes('fixture-new'),
        email: bytes('fixture@example.test'),
      }),
      session.setControls({ volume: -22 }),
    ]);
    const firstControl = panel.requests.findIndex((r) => r[0] === 5 && r[1] === 0),
      lastCredential = panel.requests.findLastIndex((r) => r[0] === 4);
    expect(firstControl).toBeGreaterThan(lastCredential);
    expect(panel.maxConcurrent).toBe(1);
    expect(decodeStatus(panel.status).volume).toBe(-22);
  });
});

describe('explicit selected OEM-mask proposal and write', () => {
  it('does not forward raw transport dumps during identity or proposal reads', async () => {
    const { session, target, panel } = fixture();
    panel.exchange = async () => {
      throw new Error('fixture-secret raw request dump');
    };
    await expect(session.proposeOemMask(target, 0)).rejects.not.toThrow('fixture-secret');
    await expect(session.setOemMask(target, 0, 0)).rejects.not.toThrow('fixture-secret');
  });
  it('proposes read-only, clears unsupported bits visibly, preserves controls and persists onlywithtrigger', async () => {
    const { panel, session, target } = fixture();
    panel.status[24] = 0xff;
    panel.status[25] = 0xf8;
    panel.status[23] = 255;
    panel.status[35] = 0xc5;
    panel.status[36] = 0xdd;
    const proposal = await session.proposeOemMask(target, 0x0200);
    expect(proposal).toMatchObject({
      previousMask: 0xf8ff,
      targetMask: 0x207,
      clearedMask: 0xf8f8,
    });
    expect(panel.oemMaskUpdates).toBe(0);
    expect(panel.requests.some((r) => r[0] === 5 && r[1] === 0)).toBe(false);
    const result = await session.setOemMask(target, proposal.requestedMask, proposal.previousMask);
    expect(result.protection.rawMask).toBe(0x207);
    expect(panel.eeprom.slice(0xba, 0xbc)).toEqual(new Uint8Array([7, 2]));
    expect(panel.oemMaskUpdates).toBe(1);
    const write = panel.requests.find((r) => r[0] === 5 && r[1] === 0)!;
    expect(write[23]).toBe(1);
    expect(panel.displayUpdates).toBe(0);
    expect(panel.status[35]).toBe(0xc5);
    expect(panel.status[36]).toBe(0xd9);
    await session.setControls({ volume: -24 });
    expect(panel.oemMaskUpdates).toBe(1);
  });
  it('refuses stale mask, newlylocked panel or changedOEM module before anysettingswrite', async () => {
    for (const change of [
      (p: SimulatedPanel) => {
        p.status[24] = 8;
      },
      (p: SimulatedPanel) => {
        p.status[51] = 2;
      },
      (p: SimulatedPanel) => {
        p.deviceConfiguration[11] = 2;
      },
    ]) {
      const { panel, session, target } = fixture(),
        proposal = await session.proposeOemMask(target, 0x208);
      change(panel);
      await expect(
        session.setOemMask(target, proposal.requestedMask, proposal.previousMask),
      ).rejects.toThrow();
      expect(panel.oemMaskUpdates).toBe(0);
      expect(panel.requests.some((r) => r[0] === 5 && r[1] === 0)).toBe(false);
    }
  });
  it('reports ambiguous mask writes without replay after the target has changed', async () => {
    const { panel, session, target } = fixture(),
      proposal = await session.proposeOemMask(target, 0x208),
      exchange = panel.exchange.bind(panel);
    panel.exchange = async (request) => {
      const reply = await exchange(request);
      if (request[0] === 5 && request[1] === 0) reply[35] ^= 1;
      return reply;
    };
    await expect(
      session.setOemMask(target, proposal.requestedMask, proposal.previousMask),
    ).rejects.toThrow('unconfirmed');
    expect(panel.oemMaskUpdates).toBe(1);
    expect(panel.requests.filter((r) => r[0] === 5 && r[1] === 0)).toHaveLength(1);
    expect(panel.eeprom.slice(0xba, 0xbc)).toEqual(new Uint8Array([15, 2]));
  });
});
