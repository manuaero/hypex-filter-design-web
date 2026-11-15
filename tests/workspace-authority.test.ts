import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createWorkspaceAuthority,
  type WorkspaceAuthorityIdentity,
} from '../src/application/workspace-authority';
import type { ToolExecutionContext } from '../src/application/execution-context';

const UUID = '11223344-5566-7788-99aa-bbccddeeff00';
const saved = { version: 1 as const, id: UUID };
const site = { owner: 'site:alice', scope: 'lease:one' };
const local = { owner: 'local:server-process', scope: 'connection:one' };
function fixture() {
  let sequence = 0;
  const load = vi.fn(async () => ({ ...saved }));
  const authority = createWorkspaceAuthority({
    loadOrCreate: load,
    id: () => `nonce-${++sequence}`,
  });
  return { authority, load };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => vi.restoreAllMocks());

it('does not read storage, mint or enroll anything before explicit hydration', async () => {
  const { authority, load } = fixture();
  expect(authority.getSnapshot()).toEqual({ phase: 'idle', error: null });
  expect(Object.isFrozen(authority.getSnapshot())).toBe(true);
  expect(load).not.toHaveBeenCalled();
  expect(() => authority.localContext('ui')).toThrow('not ready');
  expect(() => authority.registerPairedActor(site, 'site')).toThrow('not ready');
  expect(authority.isLocalHuman({ owner: `workspace:${UUID}`, scope: 'ui:nonce-1' })).toBe(false);
  await expect(authority.admit(site)).rejects.toThrow('not ready');
  expect(load).not.toHaveBeenCalled();
});
it('shares one hydration, publishes stable frozen snapshots and keeps a verified persistent owner', async () => {
  const pending = deferred<WorkspaceAuthorityIdentity>(),
    load = vi.fn(() => pending.promise);
  const authority = createWorkspaceAuthority({ loadOrCreate: load });
  const listener = vi.fn(),
    unsubscribe = authority.subscribe(listener),
    before = authority.getSnapshot();
  const first = authority.hydrate(),
    second = authority.hydrate();
  expect(first).toBe(second);
  expect(authority.getSnapshot()).not.toBe(before);
  expect(authority.getSnapshot()).toEqual({ phase: 'loading', error: null });
  expect(() => authority.localContext('ui')).toThrow('not ready');
  await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(1);
  pending.resolve({ ...saved });
  await first;
  const ready = authority.getSnapshot();
  expect(ready).toEqual({ phase: 'ready', owner: `workspace:${UUID}`, error: null });
  expect(Object.isFrozen(ready)).toBe(true);
  await authority.hydrate();
  await authority.retry();
  expect(authority.getSnapshot()).toBe(ready);
  expect(load).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
  authority.dispose();
  expect(listener).toHaveBeenCalledTimes(2);
});
it('retains a storage failure until explicit retry and never generates a substitute workspace ID', async () => {
  const load = vi
    .fn<() => Promise<WorkspaceAuthorityIdentity>>()
    .mockRejectedValueOnce(new Error('Identity store is unreadable'))
    .mockResolvedValueOnce({ ...saved });
  const nonce = vi.fn(() => 'local-nonce');
  const authority = createWorkspaceAuthority({ loadOrCreate: load, id: nonce });
  await expect(authority.hydrate()).rejects.toThrow('unreadable');
  expect(authority.getSnapshot()).toEqual({
    phase: 'error',
    error: 'Identity store is unreadable',
  });
  expect(() => authority.localContext('manual')).toThrow('not ready');
  await expect(authority.admit(site)).rejects.toThrow('not ready');
  expect(load).toHaveBeenCalledTimes(1);
  expect(nonce).not.toHaveBeenCalled();
  await authority.retry();
  expect(authority.getSnapshot().owner).toBe(`workspace:${UUID}`);
  expect(load).toHaveBeenCalledTimes(2);
  expect(nonce).not.toHaveBeenCalled();
});
it.each([
  null,
  { version: 2, id: UUID },
  { version: 1, id: 'not-a-uuid' },
  { version: 1, id: '' },
  { version: 1, id: UUID, other: true },
  { version: 1 },
  Object.create(saved),
])('fails closed on malformed stored identity without replacing it: %j', async (value) => {
  const load = vi.fn(async () => value as WorkspaceAuthorityIdentity),
    id = vi.fn(() => 'nonce');
  const authority = createWorkspaceAuthority({ loadOrCreate: load, id });
  await expect(authority.hydrate()).rejects.toThrow('retained without replacement');
  expect(authority.getSnapshot().phase).toBe('error');
  expect(authority.getSnapshot().owner).toBeUndefined();
  expect(id).not.toHaveBeenCalled();
  await expect(authority.retry()).rejects.toThrow('retained without replacement');
  expect(load).toHaveBeenCalledTimes(2);
});
it('mints detached distinct local scopes and admits only exact registered tuples', async () => {
  const { authority } = fixture();
  await authority.hydrate();
  const ui = authority.localContext('ui'),
    manual = authority.localContext('manual'),
    web = authority.localContext('webmcp');
  expect(ui).toEqual({ owner: `workspace:${UUID}`, scope: 'ui:nonce-1' });
  expect(Object.isFrozen(ui)).toBe(true);
  expect(new Set([ui.scope, manual.scope, web.scope]).size).toBe(3);
  expect(authority.isLocalHuman(ui)).toBe(true);
  expect(authority.isLocalHuman({ ...ui })).toBe(true);
  expect(authority.isLocalHuman(manual)).toBe(false);
  expect(authority.isLocalHuman(web)).toBe(false);
  expect(authority.isLocalHuman({ ...ui, scope: 'ui:unknown' })).toBe(false);
  expect(authority.isLocalHuman({ ...ui, owner: 'workspace:foreign' })).toBe(false);
  expect(await authority.admit({ ...manual })).toEqual(manual);
  await expect(authority.admit({ ...ui, scope: 'ui:unknown' })).rejects.toThrow('not registered');
  await expect(authority.admit({ ...ui, owner: 'workspace:foreign' })).rejects.toThrow(
    'not registered',
  );
  const other = createWorkspaceAuthority({
    loadOrCreate: async () => ({ ...saved }),
    id: () => 'another-page',
  });
  await other.hydrate();
  await expect(other.admit(ui)).rejects.toThrow('not registered');
});
it('refuses malformed kind, nonce and duplicate locally minted scope', async () => {
  const authority = createWorkspaceAuthority({
    loadOrCreate: async () => ({ ...saved }),
    id: () => 'same-nonce',
  });
  await authority.hydrate();
  expect(() => authority.localContext('site' as never)).toThrow('kind');
  authority.localContext('ui');
  expect(() => authority.localContext('ui')).toThrow('already minted');
  expect(authority.localContext('manual').scope).toBe('manual:same-nonce');
  const bad = createWorkspaceAuthority({
    loadOrCreate: async () => ({ ...saved }),
    id: () => 'bad\nnonce',
  });
  await bad.hydrate();
  expect(() => bad.localContext('ui')).toThrow('nonce');
  await expect(bad.admit({ owner: `workspace:${UUID}`, scope: 'ui:bad\nnonce' })).rejects.toThrow();
});
it('never authorizes site/local prefixes or a fabricated canonical context without a registered lease', async () => {
  const { authority } = fixture();
  await authority.hydrate();
  await expect(authority.admit(site)).rejects.toThrow('not registered');
  await expect(authority.admit(local)).rejects.toThrow('not registered');
  await expect(
    authority.admit({ owner: `workspace:${UUID}`, scope: 'paired:site:forged' }),
  ).rejects.toThrow('not registered');
  expect(() => authority.registerPairedActor(local, 'site')).toThrow('pairing source');
  expect(() => authority.registerPairedActor(site, 'local')).toThrow('pairing source');
  expect(() => authority.registerPairedActor({ owner: 'site:', scope: 'lease' }, 'site')).toThrow(
    'pairing source',
  );
  expect(() => authority.registerPairedActor(site, 'browser' as never)).toThrow('pairing source');
  expect(() =>
    authority.registerPairedActor({ ...site, extra: 'tool argument' } as never, 'site'),
  ).toThrow('Invalid trusted');
});
it('maps a verified actor to the persistent owner and an independently checked bounded SHA-256 scope', async () => {
  const { authority } = fixture();
  await authority.hydrate();
  const raw = { ...site },
    revoke = authority.registerPairedActor(raw, 'site');
  raw.scope = 'mutated-after-registration';
  const controller = new AbortController();
  const admitted = await authority.admit({ ...site, signal: controller.signal });
  const independentDigest = createHash('sha256')
    .update('["fusion-workspace-authority-v1","site","site:alice","lease:one"]')
    .digest('hex');
  expect(admitted).toEqual({
    owner: `workspace:${UUID}`,
    scope: `paired:site:${independentDigest}`,
    signal: controller.signal,
  });
  expect(admitted.scope.length).toBeLessThan(100);
  expect(admitted.scope).not.toContain(site.scope);
  expect(authority.isLocalHuman(admitted)).toBe(false);
  expect(await authority.admit(site)).toEqual({ owner: admitted.owner, scope: admitted.scope });
  await expect(authority.admit(admitted)).rejects.toThrow('not registered');
  revoke();
  revoke();
  await expect(authority.admit(site)).rejects.toThrow('not registered');
});
it('keeps deterministic lease mapping after page reload without automatically registering the prior actor', async () => {
  const first = fixture().authority,
    second = fixture().authority;
  await Promise.all([first.hydrate(), second.hydrate()]);
  first.registerPairedActor(site, 'site');
  const old = await first.admit(site);
  await expect(second.admit(site)).rejects.toThrow('not registered');
  second.registerPairedActor(site, 'site');
  expect(await second.admit(site)).toEqual(old);
  second.registerPairedActor({ ...site, scope: 'new-lease' }, 'site');
  expect((await second.admit({ ...site, scope: 'new-lease' })).scope).not.toBe(old.scope);
});
it('keeps site and local leases independent, replaces a source lease, and protects replacement from old cleanup', async () => {
  const { authority } = fixture();
  await authority.hydrate();
  const oldRevoke = authority.registerPairedActor(site, 'site'),
    localRevoke = authority.registerPairedActor(local, 'local');
  const next = { ...site, scope: 'lease:two' },
    newRevoke = authority.registerPairedActor(next, 'site');
  oldRevoke();
  oldRevoke();
  await expect(authority.admit(site)).rejects.toThrow('not registered');
  expect((await authority.admit(next)).owner).toBe(`workspace:${UUID}`);
  expect((await authority.admit(local)).scope).toMatch(/^paired:local:[a-f\d]{64}$/);
  localRevoke();
  await expect(authority.admit(local)).rejects.toThrow('not registered');
  expect((await authority.admit(next)).owner).toBe(`workspace:${UUID}`);
  newRevoke();
  await expect(authority.admit(next)).rejects.toThrow('not registered');
});
it.each(['revoke', 'replace', 'replace-same'] as const)(
  'rechecks the exact paired lease after async hashing: %s',
  async (change) => {
    const { authority } = fixture();
    await authority.hydrate();
    const revoke = authority.registerPairedActor(site, 'site'),
      digest = deferred<ArrayBuffer>();
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => digest.promise);
    const pending = authority.admit(site);
    if (change === 'revoke') revoke();
    else
      authority.registerPairedActor(
        change === 'replace' ? { ...site, scope: 'next' } : site,
        'site',
      );
    digest.resolve(new Uint8Array(32).buffer);
    await expect(pending).rejects.toThrow('lease changed or was revoked');
  },
);
it('captures input identity before the async boundary and preserves the exact signal', async () => {
  const { authority } = fixture();
  await authority.hydrate();
  const ui = authority.localContext('ui'),
    abort = new AbortController(),
    raw = { ...ui, signal: abort.signal };
  const pending = authority.admit(raw);
  raw.owner = 'forged';
  raw.scope = 'forged';
  expect(await pending).toEqual({ ...ui, signal: abort.signal });
});
it('rejects aborted contexts before work and after an in-flight hash', async () => {
  const { authority } = fixture();
  await authority.hydrate();
  const abort = new AbortController(),
    ui = authority.localContext('ui');
  abort.abort(new Error('Cancelled before admission'));
  await expect(authority.admit({ ...ui, signal: abort.signal })).rejects.toThrow(
    'Cancelled before',
  );
  authority.registerPairedActor(site, 'site');
  const later = new AbortController(),
    digest = deferred<ArrayBuffer>();
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => digest.promise);
  const pending = authority.admit({ ...site, signal: later.signal });
  later.abort(new Error('Cancelled during admission'));
  digest.resolve(new Uint8Array(32).buffer);
  await expect(pending).rejects.toThrow('Cancelled during');
});
it.each([
  null,
  Object.create(site),
  { ...site, arguments: { owner: 'forged' } },
  { ...site, signal: {} },
  { owner: 'site:alice', scope: 'bad\nlease' },
])('rejects malformed raw contexts even when an actor is paired: %j', async (value) => {
  const { authority } = fixture();
  await authority.hydrate();
  authority.registerPairedActor(site, 'site');
  await expect(authority.admit(value as ToolExecutionContext)).rejects.toThrow();
});
it('revokes local and paired admissions in flight and fails closed after disposal', async () => {
  const { authority } = fixture();
  await authority.hydrate();
  const ui = authority.localContext('ui'),
    revoke = authority.registerPairedActor(site, 'site'),
    digest = deferred<ArrayBuffer>();
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => digest.promise);
  const localPending = authority.admit(ui),
    pairedPending = authority.admit(site);
  authority.dispose();
  authority.dispose();
  revoke();
  digest.resolve(new Uint8Array(32).buffer);
  await expect(localPending).rejects.toThrow('disposed');
  await expect(pairedPending).rejects.toThrow('disposed');
  expect(authority.getSnapshot()).toEqual({
    phase: 'error',
    error: 'Workspace authority is disposed',
  });
  expect(authority.isLocalHuman(ui)).toBe(false);
  expect(() => authority.localContext('ui')).toThrow('disposed');
  expect(() => authority.registerPairedActor(site, 'site')).toThrow('disposed');
  await expect(authority.hydrate()).rejects.toThrow('disposed');
  await expect(authority.retry()).rejects.toThrow('disposed');
  await expect(authority.admit(site)).rejects.toThrow('disposed');
});
it('does not publish a late stored identity after disposal during hydration', async () => {
  const pending = deferred<WorkspaceAuthorityIdentity>(),
    load = vi.fn(() => pending.promise);
  const authority = createWorkspaceAuthority({ loadOrCreate: load });
  const work = authority.hydrate();
  await Promise.resolve();
  authority.dispose();
  pending.resolve({ ...saved });
  await expect(work).rejects.toThrow('disposed');
  expect(authority.getSnapshot().owner).toBeUndefined();
  expect(authority.getSnapshot().error).toBe('Workspace authority is disposed');
  expect(load).toHaveBeenCalledTimes(1);
});
