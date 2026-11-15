import { describe, expect, it, vi } from 'vitest';
import { createDeviceAuthController, type DeviceAuthBinding } from '../src/application/device-auth';
import { createToolExecutor, type DocumentState, type ToolAdapter } from '../src/application/tools';
import { newProject, type Slot } from '../src/domain/model';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import type { Transport } from '../src/hardware/transport';

const actor = { owner: 'site:test-owner', scope: 'test:password-recovery' };
type Reference = { reviewId: string; revision: number };
type Reply = {
  ok: boolean;
  error?: string;
  recovery?: Record<string, unknown>;
  result?: Record<string, unknown>;
};
function fixture(lostResetAck = false) {
  const profiles = Object.fromEntries(
    (['left', 'right'] as const).map((slot) => {
      const panel = new SimulatedPanel(`TOOL-RECOVERY-${slot}`);
      new DataView(panel.configuration.buffer).setUint16(17, 82, true);
      panel.deviceConfiguration[11] = 1;
      panel.status[51] = 2;
      panel.eeprom.set(new TextEncoder().encode('old-password'), 0x20);
      panel.eeprom.set(new TextEncoder().encode('retained@example.test'), 0x50);
      const transport: Transport = {
        exchange: async (bytes) => {
          const response = await panel.exchange(bytes);
          if (lostResetAck && slot === 'left' && bytes[0] === 4 && bytes[2] === 4)
            throw new Error('transport-private-ABCD');
          return response;
        },
        close: async () => panel.close(),
      };
      return [
        slot,
        {
          panel,
          session: new PanelSession(transport, async () => {}),
          identity: { serial: panel.serial, product: 22, core: '5.1', firmware: '5.82' },
        },
      ];
    }),
  ) as Record<Slot, DeviceAuthBinding & { panel: SimulatedPanel; session: PanelSession }>;
  const auth = createDeviceAuthController({ binding: (slot) => profiles[slot] });
  const state: DocumentState = {
    documents: { left: newProject('Left'), right: newProject('Right') },
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
    auth,
    edit: forbidden,
    choose: forbidden,
    undo: forbidden,
    redo: forbidden,
    connections: forbidden,
    connect: forbidden,
    disconnect: forbidden,
    refresh: forbidden,
    operate: async (_label, run) => run(),
    message: forbidden,
    progress: forbidden,
    view: forbidden,
  };
  const execute = createToolExecutor(adapter);
  const command = async (recovery: object, target: Slot | 'both' = 'left') =>
    (await execute(
      'fusion_device_read',
      { target, auth: { action: 'recovery', recovery } },
      actor,
    )) as Reply;
  return { profiles, auth, state, forbidden, execute, command };
}
async function installed(f: ReturnType<typeof fixture>, slot: Slot = 'left') {
  const reply = await f.command(
    { action: 'review', source: 'installed-challenge', sourceConfirmed: true },
    slot,
  );
  expect(reply.ok).toBe(true);
  return { reviewId: reply.result!.id as string, revision: reply.result!.revision as number };
}
async function code(
  f: ReturnType<typeof fixture>,
  ref: Reference,
  text = 'aBcD-private-suffix',
  slot: Slot = 'left',
) {
  const reply = await f.command(
    { action: 'review-code', ...ref, code: text, source: 'hypex-support' },
    slot,
  );
  expect(reply.ok).toBe(true);
  return reply.result!;
}

describe('MCP manual password recovery through the shared hardware controller', () => {
  it('requires trusted execution and strict, single-role recovery arguments before any USB call', async () => {
    const f = fixture();
    const untrusted = (await f.execute('fusion_device_read', {
      target: 'left',
      auth: { action: 'recovery', recovery: { action: 'status' } },
    })) as Reply;
    expect(untrusted).toMatchObject({ ok: false, error: expect.stringMatching(/trusted/) });
    for (const input of [
      {
        target: 'both',
        auth: { action: 'recovery', recovery: { action: 'review', source: 'new-challenge' } },
      },
      {
        target: 'left',
        auth: { action: 'recovery', recovery: { action: 'review', source: 'installed-challenge' } },
      },
      {
        target: 'left',
        auth: {
          action: 'recovery',
          recovery: { action: 'status' },
          confirm: { text: 'hidden', encoding: 'ascii' },
        },
      },
      { target: 'left', auth: { action: 'status', recovery: { action: 'status' } } },
      {
        target: 'left',
        auth: { action: 'recovery', recovery: { action: 'status', owner: 'forged' } },
      },
      {
        target: 'left',
        auth: { action: 'recovery', recovery: { action: 'status' } },
        firmware: { action: 'status' },
      },
    ]) {
      const result = (await f.execute('fusion_device_read', input, actor)) as Reply;
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('hidden');
    }
    for (const { panel } of Object.values(f.profiles)) expect(panel.requests).toHaveLength(0);
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it('returns and clears cached states for both roles without USB or document changes', async () => {
    const f = fixture(),
      before = structuredClone(f.state);
    for (const action of ['status', 'clear']) {
      const reply = await f.command({ action }, 'both');
      expect(reply.ok).toBe(true);
      expect(Object.keys(reply.recovery!).sort()).toEqual(['left', 'right']);
    }
    expect(f.state).toEqual(before);
    for (const { panel } of Object.values(f.profiles)) expect(panel.requests).toHaveLength(0);
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it('installs a reviewed challenge exactly once on the explicit role despite linked controls', async () => {
    const f = fixture();
    const review = await f.command({ action: 'review', source: 'new-challenge' });
    expect(review.ok).toBe(true);
    expect(f.profiles.left.panel.requests.filter((request) => request[0] === 4)).toHaveLength(0);
    const request = {
      action: 'confirm-challenge',
      reviewId: review.result!.id,
      revision: review.result!.revision,
      uniqueKey: review.result!.uniqueKey,
      confirm: true,
    };
    expect((await f.command(request)).result).toMatchObject({
      mutation: 'acknowledged',
      persistence: 'unavailable',
    });
    expect((await f.command(request)).ok).toBe(false);
    expect(f.profiles.left.panel.recoveryChallengeInstalls).toBe(1);
    expect(f.profiles.right.panel.requests).toHaveLength(0);
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it('exposes canonical code only in explicit preview and resets the reviewed role once', async () => {
    const f = fixture(),
      before = structuredClone(f.state),
      original = f.profiles.left.panel.eeprom.slice();
    f.profiles.left.panel.receivedRecoveryCode = 0xabcd;
    const ref = await installed(f),
      preview = await code(f, ref);
    expect(preview.canonicalCode).toBe('ABCD');
    const cached = JSON.stringify(await f.command({ action: 'status' }, 'both'));
    expect(cached).not.toContain('ABCD');
    expect(cached).not.toContain('private-suffix');
    expect(cached).not.toContain('retained@example.test');
    const request = {
      action: 'submit-code',
      ...ref,
      codeReviewId: preview.id,
      source: 'hypex-support',
      confirm: true,
    };
    const reply = await f.command(request);
    expect(reply.ok).toBe(true);
    expect(reply.result).toMatchObject({ mutation: 'confirmed', persistence: 'password-cleared' });
    expect(f.profiles.left.panel.eeprom[0x20]).toBe(0);
    expect(f.profiles.left.panel.eeprom.slice(0x21)).toEqual(original.slice(0x21));
    expect((await f.auth.status('left', false)).protection?.passwordProtected).toBe(false);
    expect((await f.command(request)).ok).toBe(false);
    expect(f.profiles.left.panel.recoveryCodeSubmissions).toBe(1);
    expect(f.profiles.left.panel.recoveryChallengeInstalls).toBe(0);
    expect(f.profiles.right.panel.requests).toHaveLength(0);
    expect(f.state).toEqual(before);
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it('rejects cross-role, discarded and cleared reviews before sending a reset', async () => {
    const f = fixture(),
      ref = await installed(f),
      preview = await code(f, ref);
    const request = {
      action: 'submit-code',
      ...ref,
      codeReviewId: preview.id,
      source: 'hypex-support',
      confirm: true,
    };
    expect((await f.command(request, 'right')).ok).toBe(false);
    expect((await f.command({ action: 'discard-code' })).ok).toBe(true);
    expect((await f.command(request)).ok).toBe(false);
    const replacement = await code(f, ref);
    await f.command({ action: 'clear' });
    expect((await f.command({ ...request, codeReviewId: replacement.id })).ok).toBe(false);
    for (const { panel } of Object.values(f.profiles))
      expect(panel.recoveryCodeSubmissions).toBe(0);
  });

  it('preserves uncertain reset results without leaking transport secrets or retrying writes', async () => {
    const f = fixture(true);
    f.profiles.left.panel.receivedRecoveryCode = 0xabcd;
    const ref = await installed(f),
      preview = await code(f, ref);
    const request = {
      action: 'submit-code',
      ...ref,
      codeReviewId: preview.id,
      source: 'hypex-support',
      confirm: true,
    };
    const reply = await f.command(request);
    expect(reply.ok).toBe(false);
    expect(reply.result).toMatchObject({ mutation: 'unconfirmed', persistence: 'unavailable' });
    expect(JSON.stringify(reply)).not.toContain('ABCD');
    expect(JSON.stringify(reply)).not.toContain('transport-private');
    expect((await f.command(request)).ok).toBe(false);
    expect(f.profiles.left.panel.recoveryCodeSubmissions).toBe(1);
    expect(f.profiles.right.panel.requests).toHaveLength(0);
  });

  it('refuses a protected standard module before challenge/reset commands', async () => {
    const f = fixture();
    f.profiles.left.panel.deviceConfiguration[11] = 0;
    expect((await f.command({ action: 'review', source: 'new-challenge' })).ok).toBe(false);
    expect(f.profiles.left.panel.requests.filter((request) => request[0] === 4)).toHaveLength(0);
    expect(f.profiles.left.panel.recoveryCodeSubmissions).toBe(0);
  });
});
