// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  createWorkspaceDirectoryWriter,
  type DirectoryAdoptions,
  type WorkspaceDirectoryBackend,
} from '../src/application/workspace-directory';
import {
  createProjectDirectoryWriter,
  type DirectoryWriterEnvelope,
  type DirectoryWriterBackend,
  type WritableProjectDirectoryHandle,
} from '../src/application/project-directory-writer';
import {
  assertDirectoryWriterWrite,
  directoryWriterMetadata,
} from '../src/application/directory-writer-storage';
import {
  createWorkspaceAuthority,
  WorkspaceAuthorityDisposedError,
  type WorkspaceAuthority,
} from '../src/application/workspace-authority';
import { DirectorySaveError } from '../src/application/project-directory-writer';
import { sha256TransferBytes } from '../src/application/file-transfers';
import { newProject } from '../src/domain/model';
const authorityId = '11111111-1111-1111-1111-111111111111',
  owner = `workspace:${authorityId}`;
const human = { owner, scope: 'ui:registered' },
  paired = { owner, scope: 'paired:site:hash' };
beforeEach(() => vi.stubGlobal('Blob', NodeBlob));
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  let fs = 0,
    writes = 0,
    grantWrites = 0,
    failReadback = false,
    failNextRead = false,
    sequence = 0;
  const root: WritableProjectDirectoryHandle = {
    kind: 'directory',
    name: 'Grant',
    async queryPermission() {
      fs++;
      return 'granted';
    },
    async getDirectoryHandle() {
      fs++;
      throw new DOMException('Missing', 'NotFoundError');
    },
    async getFileHandle() {
      fs++;
      throw new Error('No file writes in fixture');
    },
    async *values() {
      fs++;
    },
    async isSameEntry(other) {
      fs++;
      return other === root;
    },
  };
  const hash = (text: string) => sha256TransferBytes(new TextEncoder().encode(text));
  let value: DirectoryWriterEnvelope = {
    version: 2,
    revision: 1,
    roots: [{ id: 'root', label: 'Grant', handle: root }],
    associations: {},
    archives: [],
    saves: [
      {
        id: 'legacy',
        owner: 'browser:old-tab',
        scope: 'ui:old',
        requestId: 'legacy-request',
        slot: 'left',
        expectedRevision: 7,
        mode: 'save-as',
        rootId: 'root',
        folderName: 'Previous',
        folderExisted: false,
        projectKey: 'old-key',
        phase: 'complete',
        createdAt: 1,
        overwriteConfirmed: false,
        files: ['Config.xml', 'FusionProject.json'].map((path) => ({
          path,
          action: 'create',
          bytes: 2,
          sha256: hash('{}'),
          state: 'verified',
          recovery: 'pending',
          before: null,
          after: new Blob(['{}']),
        })),
      },
    ],
  };
  let adoptions: DirectoryAdoptions | null = null;
  const writerBackend: DirectoryWriterBackend = {
    read: async () => value,
    write: async (next, expected) => {
      assertDirectoryWriterWrite(value, next, expected);
      value = next;
      writes++;
    },
  };
  const storage: WorkspaceDirectoryBackend = {
    read: async () => {
      if (failNextRead) {
        failNextRead = false;
        throw new Error('Lost grant readback');
      }
      return { writer: value, authority: { version: 1, id: authorityId }, adoptions };
    },
    update: async (change) => {
      adoptions = change({ writer: value, authority: { version: 1, id: authorityId }, adoptions });
      grantWrites++;
      if (failReadback) {
        failReadback = false;
        failNextRead = true;
      }
    },
  };
  const authority: WorkspaceAuthority = {
    getSnapshot: () => ({ phase: 'ready', owner, error: null }),
    subscribe: () => () => {},
    hydrate: async () => {},
    retry: async () => {},
    localContext: (kind) => ({ owner, scope: `${kind}:registered` }),
    isLocalHuman: (p) => p.owner === owner && p.scope === human.scope,
    registerPairedActor: () => () => {},
    admit: async (p) => p,
    dispose: () => {},
  };
  const core = createProjectDirectoryWriter({
    backend: writerBackend,
    getProject: () => newProject(),
    getRevision: () => 7,
    now: () => 100,
    id: () => `id-${++sequence}`,
    withLock: async (_key, fn) => fn(),
  });
  const lock = vi.fn((_key: string, _fn: () => Promise<unknown>) => {});
  const facade = createWorkspaceDirectoryWriter({
    writer: core,
    authority,
    backend: storage,
    now: () => 100,
    id: () => `review-${++sequence}`,
    withLock: async <T>(key: string, work: () => Promise<T>) => {
      lock(key, work);
      return work();
    },
  });
  return {
    facade,
    core,
    authority,
    storage,
    lock,
    get value() {
      return value;
    },
    set value(next) {
      value = next;
    },
    get adoptions() {
      return adoptions;
    },
    get fs() {
      return fs;
    },
    get writes() {
      return writes;
    },
    get grantWrites() {
      return grantWrites;
    },
    loseReadback: () => {
      failReadback = true;
    },
  };
}
it('keeps a stable idle snapshot before hydration, and exposes unadopted metadata without filesystem calls', async () => {
  const f = fixture(),
    initial = f.facade.getSnapshot();
  expect(initial.phase).toBe('idle');
  expect(f.facade.getSnapshot()).toBe(initial);
  await f.facade.hydrate();
  const snapshot = f.facade.getSnapshot();
  expect(snapshot.saves[0].needsLocalAdoption).toBe(true);
  expect(f.facade.getSnapshot()).toBe(snapshot);
  expect(await f.facade.status('legacy', paired)).toMatchObject({
    needsLocalAdoption: true,
    id: 'legacy',
  });
  await expect(f.facade.retry('legacy', paired)).rejects.toMatchObject({
    code: 'needs-local-adoption',
    result: { needsLocalAdoption: true },
  });
  await expect(f.facade.exportRecovery('legacy', paired)).rejects.toMatchObject({
    code: 'needs-local-adoption',
  });
  expect(f.fs).toBe(0);
  expect(f.writes).toBe(0);
});
it('allows readonly paired review but only the exact locally minted UI principal can confirm adoption', async () => {
  const f = fixture(),
    review = await f.facade.reviewLegacy('legacy', paired),
    before = directoryWriterMetadata(f.value);
  for (const p of [
    paired,
    { owner, scope: 'manual:registered' },
    { owner, scope: 'webmcp:registered' },
    { owner, scope: 'ui:forged' },
  ])
    await expect(f.facade.adoptLegacy(review.id, p, { confirm: true })).rejects.toThrow(
      /local human/,
    );
  expect(f.grantWrites).toBe(0);
  const adopted = await f.facade.adoptLegacy(review.id, human, { confirm: true });
  expect(adopted.needsLocalAdoption).toBeUndefined();
  expect(f.facade.getSnapshot().saves[0].needsLocalAdoption).toBeUndefined();
  expect(directoryWriterMetadata(f.value)).toBe(before);
  expect(f.writes).toBe(0);
  expect(f.fs).toBe(0);
  expect(f.grantWrites).toBe(1);
  expect(f.lock).toHaveBeenCalledWith(
    'fusion-studio-project-write:root:previous',
    expect.any(Function),
  );
  expect(f.adoptions!.grants[0].originalOwner).toBe('browser:old-tab');
});
it('replays adopted legacy IDs and request UUIDs through the original strict owner without changing receipt provenance', async () => {
  const f = fixture(),
    review = await f.facade.reviewLegacy('legacy', human);
  await f.facade.adoptLegacy(review.id, human, { confirm: true });
  expect((await f.facade.commit('legacy', paired)).replayed).toBe(true);
  expect((await f.facade.retry('legacy', paired)).verified).toBe(true);
  const input = {
    slot: 'left' as const,
    expectedRevision: 7,
    requestId: 'legacy-request',
    principal: paired,
    mode: 'save-as' as const,
    rootId: 'root',
    folderName: 'Previous',
  };
  expect((await f.facade.prepare(input)).id).toBe('legacy');
  await expect(f.facade.prepare({ ...input, folderName: 'Changed' })).rejects.toMatchObject({
    code: 'invalid-request',
  });
  expect(f.value.saves[0].owner).toBe('browser:old-tab');
  expect(f.value.saves[0].scope).toBe('ui:old');
  expect(f.writes).toBe(0);
  expect(f.fs).toBe(0);
});
it('never applies a new save for an unadopted or ambiguous legacy request UUID', async () => {
  const f = fixture(),
    input = {
      slot: 'left' as const,
      expectedRevision: 7,
      requestId: 'legacy-request',
      principal: paired,
      mode: 'save-as' as const,
      rootId: 'root',
      folderName: 'Previous',
    };
  await expect(f.facade.prepare(input)).rejects.toMatchObject({ code: 'needs-local-adoption' });
  const review = await f.facade.reviewLegacy('legacy', human);
  await f.facade.adoptLegacy(review.id, human, { confirm: true });
  f.value = {
    ...f.value,
    revision: 2,
    saves: [...f.value.saves, { ...f.value.saves[0], id: 'collision', owner: 'local:old-process' }],
  };
  await expect(f.facade.prepare(input)).rejects.toThrow(/ambiguous/);
  expect(f.value.saves).toHaveLength(2);
  expect(f.writes).toBe(0);
  expect(f.fs).toBe(0);
});
it('requires fresh revision/phase/manifest and no live claim, but permits an inactive orphaned partial journal', async () => {
  const f = fixture(),
    review = await f.facade.reviewLegacy('legacy', human);
  f.value = { ...f.value, revision: 2 };
  await expect(f.facade.adoptLegacy(review.id, human, { confirm: true })).rejects.toMatchObject({
    code: 'conflict',
  });
  f.value.saves[0].phase = 'partial';
  f.value.saves[0].claim = { id: 'active', until: 200 };
  const active = await f.facade.reviewLegacy('legacy', human);
  await expect(f.facade.adoptLegacy(active.id, human, { confirm: true })).rejects.toMatchObject({
    code: 'conflict',
  });
  f.value.saves[0].claim = undefined;
  const inactive = await f.facade.reviewLegacy('legacy', human);
  expect((await f.facade.adoptLegacy(inactive.id, human, { confirm: true })).phase).toBe('partial');
  expect(f.fs).toBe(0);
  expect(f.writes).toBe(0);
});
it('retains adoption across legitimate archive progress and returns exact historical original-owner receipts', async () => {
  const f = fixture(),
    review = await f.facade.reviewLegacy('legacy', human);
  await f.facade.adoptLegacy(review.id, human, { confirm: true });
  const archive = await f.facade.reviewArchive('legacy', paired);
  const receipt = await f.facade.archive(archive.id, paired, {
    confirm: true,
    removeLocalRecovery: true,
  });
  expect(receipt.archived).toBe(true);
  expect(f.value.archives[0].owner).toBe('browser:old-tab');
  expect(f.value.archives[0].requestId).toBe('legacy-request');
  expect(await f.facade.retry('legacy', human)).toEqual(receipt);
  expect((await f.facade.status('legacy', human)).needsLocalAdoption).toBeUndefined();
  expect(f.fs).toBe(0);
});
it('keeps a lost adoption readback recoverable without regranting or mutating the original journal', async () => {
  const f = fixture(),
    review = await f.facade.reviewLegacy('legacy', human),
    before = directoryWriterMetadata(f.value);
  f.loseReadback();
  await expect(f.facade.adoptLegacy(review.id, human, { confirm: true })).rejects.toMatchObject({
    code: 'persistence',
  });
  await f.facade.retryStorage();
  expect(
    (await f.facade.adoptLegacy(review.id, human, { confirm: true })).needsLocalAdoption,
  ).toBeUndefined();
  expect(f.grantWrites).toBe(1);
  expect(directoryWriterMetadata(f.value)).toBe(before);
  expect(f.fs).toBe(0);
});
it('rejects a grant if immutable target data changes and rejects a foreign canonical authority', async () => {
  const f = fixture(),
    review = await f.facade.reviewLegacy('legacy', human);
  await f.facade.adoptLegacy(review.id, human, { confirm: true });
  f.value.saves[0].folderName = 'Retargeted';
  f.value.revision++;
  await expect(f.facade.retry('legacy', paired)).rejects.toMatchObject({
    code: 'needs-local-adoption',
  });
  await expect(
    f.facade.status('legacy', {
      owner: 'workspace:22222222-2222-2222-2222-222222222222',
      scope: 'ui:registered',
    }),
  ).rejects.toMatchObject({ code: 'invalid-request' });
  expect(f.fs).toBe(0);
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function realAuthorityFixture(legacy = false) {
  const f = fixture(),
    authority = createWorkspaceAuthority({
      loadOrCreate: async () => ({ version: 1, id: authorityId }),
    });
  await authority.hydrate();
  const actor = authority.localContext('ui');
  if (!legacy) {
    f.value.saves[0].owner = actor.owner;
    f.value.saves[0].scope = actor.scope;
  }
  const facade = createWorkspaceDirectoryWriter({
    writer: f.core,
    authority,
    backend: f.storage,
    now: () => 100,
    withLock: async (_key, work) => work(),
  });
  await facade.hydrate();
  return { ...f, source: f, authority, actor, facade };
}
it('returns the exact verified core receipt after actual authority disposal while its result is held, without repeating commit', async () => {
  const f = await realAuthorityFixture(),
    original = f.core.commit.bind(f.core),
    completed = deferred<Awaited<ReturnType<typeof original>>>(),
    release = deferred<void>();
  f.core.commit = vi.fn(async (...args: Parameters<typeof original>) => {
    const receipt = await original(...args);
    completed.resolve(receipt);
    await release.promise;
    return receipt;
  });
  const operation = f.facade.commit('legacy', f.actor),
    verified = await completed.promise;
  f.authority.dispose();
  release.resolve();
  expect(await operation).toBe(verified);
  expect(verified.verified).toBe(true);
  expect(f.core.commit).toHaveBeenCalledTimes(1);
  expect(f.source.fs).toBe(0);
  expect(f.source.writes).toBe(0);
});
it('denies an operation admitted after disposal, including a previously hydrated facade', async () => {
  const f = await realAuthorityFixture(),
    commit = vi.spyOn(f.core, 'commit');
  f.authority.dispose();
  await expect(f.facade.commit('legacy', f.actor)).rejects.toBeInstanceOf(
    WorkspaceAuthorityDisposedError,
  );
  expect(commit).not.toHaveBeenCalled();
  expect(f.source.fs).toBe(0);
});
it('does not mask a real backend error during observer refresh even when disposal happens during that read', async () => {
  const f = await realAuthorityFixture(),
    original = f.core.commit.bind(f.core),
    completed = deferred<void>(),
    release = deferred<void>(),
    reading = deferred<void>(),
    failure = deferred<never>();
  f.core.commit = vi.fn(async (...args: Parameters<typeof original>) => {
    const receipt = await original(...args);
    completed.resolve();
    await release.promise;
    return receipt;
  });
  const operation = f.facade.commit('legacy', f.actor);
  await completed.promise;
  f.storage.read = async () => {
    reading.resolve();
    return failure.promise;
  };
  release.resolve();
  await reading.promise;
  f.authority.dispose();
  failure.reject(new Error('Actual IDB readback failed'));
  await expect(operation).rejects.toMatchObject({ code: 'persistence' });
  expect(f.core.commit).toHaveBeenCalledTimes(1);
  expect(f.facade.getSnapshot().phase).toBe('error');
});
it('does not mask malformed backend data returned during disposal', async () => {
  const f = await realAuthorityFixture(),
    original = f.core.commit.bind(f.core),
    completed = deferred<void>(),
    release = deferred<void>();
  f.core.commit = vi.fn(async (...args: Parameters<typeof original>) => {
    const receipt = await original(...args);
    completed.resolve();
    await release.promise;
    return receipt;
  });
  const operation = f.facade.commit('legacy', f.actor);
  await completed.promise;
  const read = f.storage.read;
  f.storage.read = async () => {
    const stored = await read();
    f.authority.dispose();
    return { ...stored, adoptions: { malformed: true } };
  };
  release.resolve();
  await expect(operation).rejects.toMatchObject({ code: 'persistence' });
  expect(f.core.commit).toHaveBeenCalledTimes(1);
});
it('preserves the original core partial-failure object and ledger when authority disposal also prevents refresh', async () => {
  const f = await realAuthorityFixture(),
    entered = deferred<void>(),
    release = deferred<void>();
  const partial = new DirectorySaveError(
    'partial-write',
    'Captured partial outcome',
    f.core.getSnapshot().saves[0],
  );
  f.core.commit = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    throw partial;
  });
  const operation = f.facade.commit('legacy', f.actor);
  await entered.promise;
  f.authority.dispose();
  release.resolve();
  await expect(operation).rejects.toBe(partial);
  expect(f.core.commit).toHaveBeenCalledTimes(1);
});
it.each(['prepare', 'retry', 'archive'] as const)(
  'preserves authoritative %s results when only its observer has been disposed',
  async (method) => {
    const f = await realAuthorityFixture(),
      entered = deferred<unknown>(),
      release = deferred<void>();
    let operation: Promise<unknown>;
    if (method === 'prepare') {
      const original = f.core.prepare.bind(f.core);
      f.core.prepare = vi.fn(async (input) => {
        const value = await original(input);
        entered.resolve(value);
        await release.promise;
        return value;
      });
      operation = f.facade.prepare({
        slot: 'left',
        expectedRevision: 7,
        requestId: 'legacy-request',
        principal: f.actor,
        mode: 'save-as',
        rootId: 'root',
        folderName: 'Previous',
      });
    } else if (method === 'retry') {
      const original = f.core.retry.bind(f.core);
      f.core.retry = vi.fn(async (...args: Parameters<typeof original>) => {
        const value = await original(...args);
        entered.resolve(value);
        await release.promise;
        return value;
      });
      operation = f.facade.retry('legacy', f.actor);
    } else {
      const review = await f.facade.reviewArchive('legacy', f.actor),
        original = f.core.archive.bind(f.core);
      f.core.archive = vi.fn(async (...args: Parameters<typeof original>) => {
        const value = await original(...args);
        entered.resolve(value);
        await release.promise;
        return value;
      });
      operation = f.facade.archive(review.id, f.actor, {
        confirm: true,
        removeLocalRecovery: true,
      });
    }
    const verified = await entered.promise;
    f.authority.dispose();
    release.resolve();
    expect(await operation).toBe(verified);
    expect(f.core[method]).toHaveBeenCalledTimes(1);
    expect(f.source.fs).toBe(0);
  },
);
it('does not acknowledge a grant write if disposal prevented its required readback', async () => {
  const f = await realAuthorityFixture(true),
    review = await f.facade.reviewLegacy('legacy', f.actor),
    update = f.storage.update;
  f.storage.update = async (change) => {
    await update(change);
    f.authority.dispose();
  };
  await expect(f.facade.adoptLegacy(review.id, f.actor, { confirm: true })).rejects.toBeInstanceOf(
    WorkspaceAuthorityDisposedError,
  );
  expect(f.source.grantWrites).toBe(1);
  expect(f.source.writes).toBe(0);
  expect(f.source.fs).toBe(0);
});
it('can acknowledge an exact grant readback when disposal only prevents the subsequent observer check', async () => {
  const f = await realAuthorityFixture(true),
    review = await f.facade.reviewLegacy('legacy', f.actor),
    read = f.storage.read;
  f.storage.read = async () => {
    const stored = await read();
    if (f.source.grantWrites) f.authority.dispose();
    return stored;
  };
  expect(
    (await f.facade.adoptLegacy(review.id, f.actor, { confirm: true })).needsLocalAdoption,
  ).toBeUndefined();
  expect(f.source.grantWrites).toBe(1);
  expect(f.source.writes).toBe(0);
  expect(f.source.fs).toBe(0);
});
