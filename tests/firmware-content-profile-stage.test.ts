import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createFirmwareWorkspace,
  type FirmwareDeviceBinding,
} from '../src/application/firmware-workspace';
import type { Slot } from '../src/domain/model';

// These hashes are recognition fixtures, not the hashes of the synthetic bundles
// below. Injecting one tests the staging port; the ignored actual-file CLI uses
// the default WebCrypto implementation to verify the real installed/downloaded files.
const known57 = '00cbaf3fb38e731959fef26eb7b844c2f79987442397e9ce194a0d2b302f00a5';
const known582 = '8cba0150c33acc338a7581ba89069b174f8786a6d97c68269dc4a540b9c47f61';

function record(type: number, values: number[], address = 0) {
  const bytes = [values.length, address >> 8, address & 255, type, ...values];
  bytes.push(-bytes.reduce((sum, byte) => sum + byte, 0) & 255);
  return (
    ':' +
    bytes
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}
function syntheticBundle(family = 'FUSION32', value = 1) {
  return (
    [
      record(0x80, [1, 0, 0, 0, 2, 0, 0, 0, ...Array.from(family, (c) => c.charCodeAt(0))]),
      record(0x81, [2]),
      record(4, [0, 0]),
      record(0, [value, 2, 3, 4], 0x690),
      record(1, []),
    ].join('\r\n') + '\r\n'
  );
}
const source = syntheticBundle();
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const binding = (serial: string): FirmwareDeviceBinding => ({
  serial,
  product: 22,
  core: '5.1',
  firmware: '5.7',
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('staged firmware content profiles', () => {
  it.each([
    { sha256: known57, id: 'fusion32-5.7-core5.1', bundleVersion: '5.7', coreVersion: '5.1' },
    { sha256: known582, id: 'fusion32-5.82-core5.5', bundleVersion: '5.82', coreVersion: '5.5' },
  ])(
    'carries the exact hash profile for a renamed file ($id), using an explicit digest test double',
    async (profile) => {
      const current = Object.freeze(binding('SYNTHETIC-LEFT'));
      const digest = vi.fn(async (bytes: Uint8Array) => {
        expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode(source)));
        return profile.sha256.toUpperCase();
      });
      const service = createFirmwareWorkspace({ binding: () => current, sha256: digest });
      const stage = await service.inspect('left', source, 'renamed-without-version.hex');
      expect(stage).toMatchObject({
        name: 'renamed-without-version.hex',
        sha256: profile.sha256,
        family: 'FUSION32',
        contentProfile: { ...profile, family: 'FUSION32' },
        boundDevice: current,
        programming: { available: false },
      });
      expect(digest).toHaveBeenCalledTimes(1);
      expect(stage.boundDevice).not.toBe(current);
      expect(current).toEqual(binding('SYNTHETIC-LEFT'));
      expect(Object.isFrozen(stage.contentProfile)).toBe(true);
      expect(Object.isFrozen(stage.contentProfile!.evidence)).toBe(true);
      expect(Reflect.set(stage.contentProfile!, 'bundleVersion', '99')).toBe(false);
      expect(stage).not.toHaveProperty('runningImageProfile');
      expect(service.getSnapshot().right).toEqual({ phase: 'empty' });
    },
  );

  it('uses real SHA-256 for synthetic changed bytes, never the unchanged official-looking filename', async () => {
    const digest = vi.fn(async (bytes: Uint8Array) => {
      const result = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
      return Buffer.from(result).toString('hex');
    });
    // Only this first response is the workflow double; subsequent hashes are real.
    digest.mockResolvedValueOnce(known57);
    const service = createFirmwareWorkspace({ binding: () => undefined, sha256: digest });
    const name = 'FusionAmp-v5.7.hex';
    const previous = await service.inspect('left', source, name);
    expect(previous.contentProfile?.id).toBe('fusion32-5.7-core5.1');
    const changed = syntheticBundle('FUSION32', 9);
    const replacement = await service.inspect('left', changed, name);
    expect(replacement.sha256).toBe(hash(changed));
    expect(replacement.sha256).not.toBe(previous.sha256);
    expect(replacement).not.toHaveProperty('contentProfile');
    const renamed = await service.inspect('right', changed, 'DSP3-213 (FusionAmp)-v5.82.hex');
    expect(renamed.sha256).toBe(replacement.sha256);
    expect(renamed).not.toHaveProperty('contentProfile');
    expect(service.packetPreview('left', 0).sha256).toBe(replacement.sha256);
  });

  it('the default hasher recognizes neither filenames nor synthetic bundle version-like data', async () => {
    const service = createFirmwareWorkspace({ binding: () => undefined });
    const staged = await service.inspect('left', source, 'FusionAmp-v5.7.hex');
    const lineEndingChange = source.replaceAll('\r\n', '\n');
    const changed = await service.inspect('left', lineEndingChange, 'FusionAmp-v5.7.hex');
    expect(staged.sha256).toBe(hash(source));
    expect(changed.sha256).toBe(hash(lineEndingChange));
    expect(staged.sha256).not.toBe(changed.sha256);
    expect(staged.contentProfile).toBeUndefined();
    expect(changed.contentProfile).toBeUndefined();
  });

  it('rejects an injected known hash with a conflicting parsed family and retains the prior stage and packet plan', async () => {
    const digest = vi.fn().mockResolvedValueOnce(known582).mockResolvedValueOnce(known57);
    const service = createFirmwareWorkspace({ binding: () => undefined, sha256: digest });
    const previous = await service.inspect('left', source, 'previous.hex');
    const page = service.packetPreview('left', 1);
    await expect(
      service.inspect('left', syntheticBundle('FUSION01'), 'false-known-hash.hex'),
    ).rejects.toThrow('content hash disagrees with the parsed bundle family');
    expect(service.getSnapshot().left).toMatchObject({ phase: 'error', stage: previous });
    expect(service.getSnapshot().left.error).toContain('previous.hex');
    expect(service.getSnapshot().left.stage!.contentProfile?.id).toBe('fusion32-5.82-core5.5');
    expect(service.packetPreview('left', 1)).toEqual(page);
    expect(service.getSnapshot().right).toEqual({ phase: 'empty' });
  });

  it('keeps independent Left/Right profiles and removes an old profile when that role receives unknown content', async () => {
    const digest = vi
      .fn()
      .mockResolvedValueOnce(known57)
      .mockResolvedValueOnce(known582)
      .mockResolvedValueOnce(hash(source));
    const bindings = Object.freeze({
      left: Object.freeze(binding('SYNTHETIC-LEFT')),
      right: Object.freeze(binding('SYNTHETIC-RIGHT')),
    });
    const service = createFirmwareWorkspace({ binding: (slot) => bindings[slot], sha256: digest });
    const left = await service.inspect('left', source, 'left.hex');
    const right = await service.inspect('right', source, 'right.hex');
    expect(left.contentProfile?.bundleVersion).toBe('5.7');
    expect(right.contentProfile?.bundleVersion).toBe('5.82');
    const replacement = await service.inspect('left', source, 'left.hex');
    expect(replacement.contentProfile).toBeUndefined();
    expect(service.getSnapshot().right.stage).toBe(right);
    service.clear('left');
    expect(service.getSnapshot().left).toEqual({ phase: 'empty' });
    expect(service.getSnapshot().right.stage).toBe(right);
    expect(bindings.left).toEqual(binding('SYNTHETIC-LEFT'));
    expect(bindings.right).toEqual(binding('SYNTHETIC-RIGHT'));
  });

  it('cannot restore an older known profile after replacement or Clear while hashing is pending', async () => {
    const older = deferred<string>();
    const clearing = deferred<string>();
    const digest = vi
      .fn()
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce(known582)
      .mockImplementationOnce(() => clearing.promise);
    const service = createFirmwareWorkspace({ binding: () => undefined, sha256: digest });
    const pending = service.inspect('left', source, 'older.hex');
    const stale = expect(pending).rejects.toThrow('superseded');
    const latest = await service.inspect('left', source, 'latest.hex');
    older.resolve(known57);
    await stale;
    expect(service.getSnapshot().left.stage).toBe(latest);
    expect(latest.contentProfile?.bundleVersion).toBe('5.82');
    const pendingClear = service.inspect('left', source, 'cleared.hex');
    const cleared = expect(pendingClear).rejects.toThrow('superseded');
    service.clear('left');
    clearing.resolve(known57);
    await cleared;
    expect(service.getSnapshot().left).toEqual({ phase: 'empty' });
  });

  it('retains the prior profile on parse, digest rejection and malformed digest failures', async () => {
    const digest = vi
      .fn()
      .mockResolvedValueOnce(known57)
      .mockRejectedValueOnce(new Error('Injected digest failure'))
      .mockResolvedValueOnce('invalid');
    const service = createFirmwareWorkspace({ binding: () => undefined, sha256: digest });
    const previous = await service.inspect('right', source, 'retained.hex');
    await expect(service.inspect('right', 'not a bundle', 'parse.hex')).rejects.toThrow();
    expect(digest).toHaveBeenCalledTimes(1);
    await expect(service.inspect('right', source, 'digest.hex')).rejects.toThrow('digest failure');
    await expect(service.inspect('right', source, 'invalid-hash.hex')).rejects.toThrow('SHA-256');
    expect(service.getSnapshot().right.stage).toBe(previous);
    expect(service.getSnapshot().right.stage!.contentProfile?.id).toBe('fusion32-5.7-core5.1');
    expect(service.packetPreview('right', 0).stageId).toBe(previous.id);
  });

  it('does not treat file recognition as a running-device proof or retarget a changed binding', async () => {
    const pending = deferred<string>();
    const bindings: Partial<Record<Slot, FirmwareDeviceBinding>> = {
      left: binding('SYNTHETIC-ORIGINAL'),
    };
    const original = structuredClone(bindings.left);
    const service = createFirmwareWorkspace({
      binding: (slot) => bindings[slot],
      sha256: () => pending.promise,
    });
    const inspection = service.inspect('left', source, 'known-content.hex');
    bindings.left = binding('SYNTHETIC-REPLACEMENT');
    pending.resolve(known57);
    const stage = await inspection;
    expect(stage.contentProfile?.id).toBe('fusion32-5.7-core5.1');
    expect(stage.boundDevice).toEqual(original);
    expect(stage.bindingChangedDuringInspection).toBe(true);
    expect(stage.programming.available).toBe(false);
    expect(stage.programming.reasons.map((reason) => reason.code)).toContain(
      'device-binding-changed',
    );
    expect(stage.target).toBeUndefined();
    expect(bindings.left).toEqual(binding('SYNTHETIC-REPLACEMENT'));
  });
});
