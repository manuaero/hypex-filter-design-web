import { describe, expect, it, vi } from 'vitest';
import {
  createPasswordRecoveryController,
  type PasswordRecoveryBinding,
  type PasswordRecoveryController,
} from '../src/application/password-recovery';
import { createDeviceAuthController, type DeviceAuthBinding } from '../src/application/device-auth';
import { PanelSession } from '../src/hardware/session';
import { SimulatedPanel } from '../src/hardware/simulator';
import { recoveryChallengeWord } from '../src/hardware/password-recovery';
import type { Transport } from '../src/hardware/transport';
import type { Slot } from '../src/domain/model';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}
function fixture() {
  const profiles = Object.fromEntries(
    (['left', 'right'] as const).map((slot) => {
      const panel = new SimulatedPanel(`RECOVERY-${slot}`);
      new DataView(panel.configuration.buffer).setUint16(17, 82, true);
      panel.deviceConfiguration[11] = 1;
      panel.status[51] = 2;
      panel.eeprom.set(new TextEncoder().encode('old-password'), 0x20);
      panel.eeprom.set(new TextEncoder().encode('retained@example.test'), 0x50);
      return [
        slot,
        {
          panel,
          session: new PanelSession(panel, async () => {}),
          identity: { serial: panel.serial, product: 22, core: '5.1', firmware: '5.82' },
        },
      ];
    }),
  ) as Record<Slot, PasswordRecoveryBinding & { panel: SimulatedPanel; session: PanelSession }>;
  const bindings: Partial<Record<Slot, PasswordRecoveryBinding>> = { ...profiles };
  const controller = createPasswordRecoveryController({
    binding: (slot) => bindings[slot],
    randomGuid: () => '01234567-89ab-cdef-0123-456789abcdef',
  });
  return { profiles, bindings, controller };
}
async function existing(controller: PasswordRecoveryController, slot: Slot = 'left') {
  return controller.review(slot, { source: 'installed-challenge', sourceConfirmed: true });
}
const reference = (review: Awaited<ReturnType<PasswordRecoveryController['review']>>) => ({
  reviewId: review.id,
  revision: review.revision,
});

describe('selected-amplifier manual recovery', () => {
  it('reviews a native-shaped challenge with fresh readonly status and stable immutable snapshots', async () => {
    const f = fixture(),
      before = f.controller.getSnapshot();
    expect(f.controller.getSnapshot()).toBe(before);
    const review = await f.controller.review('right', { source: 'new-challenge' });
    expect(review.uniqueKey).toBe('0123456789ABCDEF');
    expect(review.target.serial).toBe('RECOVERY-right');
    expect(Object.isFrozen(review)).toBe(true);
    expect(Object.isFrozen(f.controller.getSnapshot().right.protection)).toBe(true);
    expect(f.profiles.right.panel.requests.filter((p) => p[0] === 4)).toHaveLength(0);
    expect(f.profiles.left.panel.requests).toHaveLength(0);
  });
  it('requires exact review confirmation, installs once, and labels persistence unavailable', async () => {
    const f = fixture(),
      review = await f.controller.review('right', { source: 'new-challenge' });
    await expect(
      f.controller.confirmChallenge('right', {
        ...reference(review),
        uniqueKey: 'FFFFFFFFFFFFFFFF',
        confirm: true,
      }),
    ).rejects.toThrow();
    expect(f.profiles.right.panel.recoveryChallengeInstalls).toBe(0);
    const result = await f.controller.confirmChallenge('right', {
      ...reference(review),
      uniqueKey: review.uniqueKey!,
      confirm: true,
    });
    expect(result.mutation).toBe('acknowledged');
    expect(result.persistence).toBe('unavailable');
    expect(f.profiles.right.panel.recoveryChallengeWord).toBe(
      recoveryChallengeWord(review.uniqueKey!),
    );
    await expect(
      f.controller.confirmChallenge('right', {
        ...reference(review),
        uniqueKey: review.uniqueKey!,
        confirm: true,
      }),
    ).rejects.toThrow();
    expect(f.profiles.right.panel.recoveryChallengeInstalls).toBe(1);
  });
  it('requires explicit prior installed-challenge source confirmation without reinstalling it', async () => {
    const f = fixture();
    await expect(f.controller.review('left', { source: 'installed-challenge' })).rejects.toThrow();
    const review = await existing(f.controller);
    expect(review.uniqueKey).toBeUndefined();
    expect(f.profiles.left.panel.recoveryChallengeInstalls).toBe(0);
  });
  it('shows canonical first4hex only in explicit code preview, never status/error', async () => {
    const f = fixture(),
      review = await existing(f.controller);
    const preview = await f.controller.reviewCode('left', {
      ...reference(review),
      code: 'aB09-private-suffix',
      source: 'hypex-support',
    });
    expect(preview.canonicalCode).toBe('AB09');
    const state = JSON.stringify(f.controller.getSnapshot());
    expect(state).not.toContain('AB09');
    expect(state).not.toContain('private-suffix');
    await expect(
      f.controller.reviewCode('left', {
        ...reference(review),
        code: 'secret!',
        source: 'hypex-support',
      }),
    ).rejects.toThrow(/invalid/);
    expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('secret');
  });
  it('submits reviewed support code once, verifies cleared flags and preserves trailing password/email bytes', async () => {
    const f = fixture(),
      panel = f.profiles.left.panel,
      review = await existing(f.controller);
    const original = panel.eeprom.slice();
    panel.receivedRecoveryCode = 0;
    const preview = await f.controller.reviewCode('left', {
      ...reference(review),
      code: '0000',
      source: 'hypex-support',
    });
    const input = {
      ...reference(review),
      codeReviewId: preview.id,
      source: 'hypex-support' as const,
      confirm: true as const,
    };
    const result = await f.controller.submitCode('left', input);
    expect(result.mutation).toBe('confirmed');
    expect(result.protection?.passwordProtected).toBe(false);
    expect(panel.eeprom[0x20]).toBe(0);
    expect(panel.eeprom.slice(0x21)).toEqual(original.slice(0x21));
    await expect(f.controller.submitCode('left', input)).rejects.toThrow();
    expect(panel.recoveryCodeSubmissions).toBe(1);
    expect(f.profiles.right.panel.requests).toHaveLength(0);
  });
  it('rejects stale, cross-role and replaced reviews before writes', async () => {
    const f = fixture(),
      review = await existing(f.controller);
    await expect(
      f.controller.reviewCode('right', {
        ...reference(review),
        code: '1234',
        source: 'hypex-support',
      }),
    ).rejects.toThrow();
    await existing(f.controller);
    await expect(
      f.controller.reviewCode('left', {
        ...reference(review),
        code: '1234',
        source: 'hypex-support',
      }),
    ).rejects.toThrow();
    expect(f.profiles.left.panel.recoveryCodeSubmissions).toBe(0);
  });
  it('invalidates a received-code preview when its form changes', async () => {
    const f = fixture(),
      review = await existing(f.controller);
    const preview = await f.controller.reviewCode('left', {
      ...reference(review),
      code: '1234',
      source: 'hypex-support',
    });
    f.controller.discardCodeReview('left');
    await expect(
      f.controller.submitCode('left', {
        ...reference(review),
        codeReviewId: preview.id,
        source: 'hypex-support',
        confirm: true,
      }),
    ).rejects.toThrow();
    expect(f.profiles.left.panel.recoveryCodeSubmissions).toBe(0);
  });
  it('fresh OEM or locked-state changes refuse code submission before04', async () => {
    for (const change of ['oem', 'unlock'] as const) {
      const f = fixture(),
        review = await existing(f.controller),
        panel = f.profiles.left.panel;
      const preview = await f.controller.reviewCode('left', {
        ...reference(review),
        code: '1234',
        source: 'hypex-support',
      });
      if (change === 'oem') panel.deviceConfiguration[11] = 0;
      else panel.status[51] = 6;
      await expect(
        f.controller.submitCode('left', {
          ...reference(review),
          codeReviewId: preview.id,
          source: 'hypex-support',
          confirm: true,
        }),
      ).rejects.toThrow();
      expect(panel.recoveryCodeSubmissions).toBe(0);
    }
  });
  it('consumes rejected codes without retry and records rejection without the secret', async () => {
    const f = fixture(),
      review = await existing(f.controller),
      panel = f.profiles.left.panel;
    panel.receivedRecoveryCode = 0xabcd;
    const preview = await f.controller.reviewCode('left', {
      ...reference(review),
      code: '5678',
      source: 'hypex-support',
    });
    const input = {
      ...reference(review),
      codeReviewId: preview.id,
      source: 'hypex-support' as const,
      confirm: true as const,
    };
    await expect(f.controller.submitCode('left', input)).rejects.toMatchObject({
      result: { mutation: 'rejected' },
    });
    await expect(f.controller.submitCode('left', input)).rejects.toThrow();
    expect(panel.recoveryCodeSubmissions).toBe(1);
    expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('5678');
  });
  it('preserves an unknown-write ledger after lost ACK and never retries', async () => {
    const f = fixture(),
      original = f.profiles.left.session,
      panel = f.profiles.left.panel;
    const transport: Transport = {
      close: () => panel.close(),
      exchange: async (request) => {
        const reply = await panel.exchange(request);
        if (request[0] === 4 && request[2] === 3) throw new Error('secret packet dump');
        return reply;
      },
    };
    f.bindings.left = { ...f.profiles.left, session: new PanelSession(transport, async () => {}) };
    const review = await f.controller.review('left', { source: 'new-challenge' });
    const input = { ...reference(review), uniqueKey: review.uniqueKey!, confirm: true as const };
    await expect(f.controller.confirmChallenge('left', input)).rejects.toMatchObject({
      result: { mutation: 'unconfirmed' },
    });
    await expect(f.controller.confirmChallenge('left', input)).rejects.toThrow();
    expect(panel.recoveryChallengeInstalls).toBe(1);
    expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('secret packet dump');
    expect(original).not.toBe(f.bindings.left.session);
  });
  it('Clear during queued fresh identity prevents a late recovery request', async () => {
    const f = fixture(),
      panel = f.profiles.left.panel,
      gate = deferred<void>();
    let hold = false,
      entered = false;
    const transport: Transport = {
      close: () => panel.close(),
      exchange: async (request) => {
        if (hold && request[0] === 6) {
          entered = true;
          await gate.promise;
        }
        return panel.exchange(request);
      },
    };
    f.bindings.left = { ...f.profiles.left, session: new PanelSession(transport, async () => {}) };
    const review = await f.controller.review('left', { source: 'new-challenge' });
    hold = true;
    const flight = f.controller.confirmChallenge('left', {
      ...reference(review),
      uniqueKey: review.uniqueKey!,
      confirm: true,
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    f.controller.clear('left');
    gate.resolve();
    await expect(flight).rejects.toThrow(/stale|confirmed/);
    expect(panel.recoveryChallengeInstalls).toBe(0);
    expect(f.controller.getSnapshot().left.review).toBeUndefined();
  });
  it('refuses same-role reentrancy while allowing independent role reads', async () => {
    const f = fixture(),
      gate = deferred<void>(),
      original = f.profiles.left.session.protection.bind(f.profiles.left.session);
    f.profiles.left.session.protection = async () => {
      await gate.promise;
      return original();
    };
    const first = existing(f.controller);
    await expect(existing(f.controller)).rejects.toThrow(/running/);
    await expect(existing(f.controller, 'right')).resolves.toMatchObject({ slot: 'right' });
    gate.resolve();
    await first;
  });
  it('retains a captured successful-write ledger after Clear without applying its late UI state', async () => {
    const f = fixture(),
      session = f.profiles.left.session,
      panel = f.profiles.left.panel;
    panel.receivedRecoveryCode = 0x1234;
    const review = await existing(f.controller);
    const preview = await f.controller.reviewCode('left', {
      ...reference(review),
      code: '1234',
      source: 'hypex-support',
    });
    const original = session.submitRecoveryCode.bind(session),
      gate = deferred<void>();
    let completed = false;
    session.submitRecoveryCode = async (...args) => {
      const result = await original(...args);
      completed = true;
      await gate.promise;
      return result;
    };
    const flight = f.controller.submitCode('left', {
      ...reference(review),
      codeReviewId: preview.id,
      source: 'hypex-support',
      confirm: true,
    });
    await vi.waitFor(() => expect(completed).toBe(true));
    f.controller.clear('left');
    gate.resolve();
    await expect(flight).rejects.toMatchObject({
      result: { target: { serial: panel.serial }, mutation: 'confirmed' },
    });
    expect(f.controller.getSnapshot().left.lastResult).toBeUndefined();
    expect(f.controller.getSnapshot().left.review).toBeUndefined();
    expect(panel.recoveryCodeSubmissions).toBe(1);
  });
  it('shares normal authentication exclusion and invalidates recovery after normal credential operations', async () => {
    const f = fixture();
    const auth = createDeviceAuthController({
      binding: (slot) => f.profiles[slot] as DeviceAuthBinding,
    });
    const recovery = auth.recovery!,
      review = await existing(recovery);
    await auth.unlock('left', { text: 'old-password', encoding: 'ascii' });
    expect(recovery.getSnapshot().left.review).toBeUndefined();
    await expect(
      recovery.reviewCode('left', { ...reference(review), code: '1234', source: 'hypex-support' }),
    ).rejects.toThrow();
    expect(f.profiles.left.panel.recoveryCodeSubmissions).toBe(0);
    auth.dispose();
    f.controller.dispose();
  });
  it('updates the normal authentication report from the same-target recovery readback without extra USB reads', async () => {
    const f = fixture(),
      auth = createDeviceAuthController({
        binding: (slot) => f.profiles[slot] as DeviceAuthBinding,
      });
    await auth.status('left');
    expect(auth.getSnapshot().left.protection?.locked).toBe(true);
    const recovery = auth.recovery!,
      review = await existing(recovery),
      panel = f.profiles.left.panel;
    panel.receivedRecoveryCode = 0xabcd;
    const preview = await recovery.reviewCode('left', {
      ...reference(review),
      code: 'ABCD',
      source: 'hypex-support',
    });
    await recovery.submitCode('left', {
      ...reference(review),
      codeReviewId: preview.id,
      source: 'hypex-support',
      confirm: true,
    });
    const reads = panel.requests.length;
    expect((await auth.status('left', false)).protection?.passwordProtected).toBe(false);
    expect(panel.requests.length).toBe(reads);
    auth.dispose();
    f.controller.dispose();
  });
});
