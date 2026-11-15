import { expect, it, vi } from 'vitest';
import { createToolExecutor, TOOL_DEFINITIONS, type ToolAdapter } from '../src/application/tools';
import {
  DirectorySaveError,
  type DirectorySaveProposal,
  type DirectorySaveReceipt,
  type DirectoryArchiveReview,
  type ProjectDirectoryWriter,
} from '../src/application/project-directory-writer';
import type { FileTransfers, FileTransferStatus } from '../src/application/file-transfers';
import {
  createFileTransfers,
  type FileTransferBackend,
  type FileTransferRecord,
} from '../src/application/file-transfers';
import { createHash } from 'node:crypto';
import { newProject } from '../src/domain/model';
import type {
  DirectoryLegacyAccess,
  DirectoryLegacyReview,
} from '../src/application/workspace-directory';

const actor = { owner: 'site:owner', scope: 'lease:one' };
const proposal: DirectorySaveProposal = {
  id: 'save-1',
  slot: 'right',
  expectedRevision: 9,
  mode: 'save-as',
  rootId: 'root-1',
  folderName: 'Right crossover',
  phase: 'prepared',
  createdAt: 1,
  files: [],
  requiresOverwriteConfirmation: true,
  recoveryAvailable: true,
  workspaceChanged: false,
};
function fixture() {
  const documents = { left: newProject('Left'), right: newProject('Right') };
  const snapshot = {
    phase: 'ready' as const,
    hydrated: true,
    busy: false,
    error: null,
    roots: [{ id: 'root-1', label: 'Chosen folder' }],
    associations: {},
    saves: [proposal],
  };
  const writer: ProjectDirectoryWriter & Partial<DirectoryLegacyAccess> = {
    getSnapshot: vi.fn(() => snapshot),
    subscribe: vi.fn(() => () => {}),
    hydrate: vi.fn(async () => {}),
    retryStorage: vi.fn(async () => {}),
    registerDirectory: vi.fn(async () => 'root-1'),
    forgetRoot: vi.fn(async () => {}),
    forgetRecovery: vi.fn(async () => {}),
    prepare: vi.fn(async () => proposal),
    commit: vi.fn(async (): Promise<DirectorySaveReceipt> => ({
      ...proposal,
      verified: true,
      replayed: false,
      atomic: false,
      introduced: [],
      restored: [],
    })),
    retry: vi.fn(async (): Promise<DirectorySaveReceipt> => ({
      ...proposal,
      verified: true,
      replayed: true,
      atomic: false,
      introduced: [],
      restored: [],
    })),
    status: vi.fn(async () => proposal),
    recover: vi.fn(async (): Promise<DirectorySaveReceipt> => ({
      ...proposal,
      phase: 'recovered',
      verified: false,
      replayed: false,
      atomic: false,
      introduced: [],
      restored: [],
    })),
    exportRecovery: vi.fn(async () => [
      { path: 'before/Config.xml', blob: new Blob(['original']) },
    ]),
    reviewArchive: vi.fn(async (): Promise<DirectoryArchiveReview> => ({
      id: 'archive-review-1',
      saveId: proposal.id,
      slot: proposal.slot,
      phase: 'complete',
      envelopeRevision: 22,
      manifestSha256: 'e'.repeat(64),
      recoveryBytes: 80,
      proposal: { ...proposal, phase: 'complete' },
    })),
    archive: vi.fn(async (): Promise<DirectorySaveReceipt> => ({
      ...proposal,
      phase: 'complete',
      archived: true,
      archivedAt: 2,
      recoveryAvailable: false,
      verified: true,
      replayed: true,
      atomic: false,
      introduced: [],
      restored: [],
    })),
  };
  const createExport = vi.fn(async (): Promise<FileTransferStatus> => ({
    id: 'transfer-1',
    direction: 'export',
    state: 'ready',
    files: [],
    chunkBytes: 262144,
    totalBytes: 8,
    createdAt: 1,
    expiresAt: 2,
    idleExpiresAt: 2,
    commitId: 'export-1',
  }));
  const adapter: ToolAdapter = {
    state: () => ({
      documents,
      slot: 'left',
      preset: 0,
      channel: 0,
      filter: 0,
      linkedEdits: true,
      linkedControls: true,
      documentRevision: 9,
    }),
    edit: vi.fn(),
    choose: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    connections: () => ({}),
    connect: vi.fn(),
    disconnect: vi.fn(),
    refresh: vi.fn(),
    operate: async (_label, fn) => fn(),
    message: vi.fn(),
    progress: vi.fn(),
    view: vi.fn(),
    directoryWriter: writer,
    files: {
      manager: { createExport } as unknown as FileTransfers,
      revision: () => 9,
      commit: vi.fn(),
      lookup: vi.fn(),
    },
  };
  return {
    writer,
    adapter,
    createExport,
    execute: createToolExecutor(adapter),
    documents,
    snapshot,
  };
}

it('requires trusted context and rejects caller principals, paths, chooser actions and ambiguous Save destinations before service access', async () => {
  const f = fixture();
  expect(await f.execute('fusion_project_directory', { action: 'status' })).toMatchObject({
    ok: false,
  });
  for (const input of [
    { action: 'choose' },
    { action: 'status', principal: actor },
    { action: 'prepare', slot: 'right', mode: 'save-as', expectedRevision: 9, requestId: 'one' },
    {
      action: 'prepare',
      slot: 'right',
      mode: 'save',
      expectedRevision: 9,
      requestId: 'one',
      rootId: 'root-1',
    },
    { action: 'commit', id: 'save-1', path: 'C:\\private' },
  ])
    expect(await f.execute('fusion_project_directory', input, actor)).toMatchObject({ ok: false });
  expect(f.writer.hydrate).not.toHaveBeenCalled();
  expect(f.writer.prepare).not.toHaveBeenCalled();
  expect(f.writer.commit).not.toHaveBeenCalled();
  expect(f.writer.registerDirectory).not.toHaveBeenCalled();
});

it('binds a reviewed Save As to the explicit role and trusted principal without expanding linked roles', async () => {
  const f = fixture(),
    before = structuredClone(f.documents);
  const input = {
    action: 'prepare',
    slot: 'right',
    mode: 'save-as',
    expectedRevision: 9,
    requestId: 'one',
    rootId: 'root-1',
    folderName: 'Right crossover',
  };
  expect(await f.execute('fusion_project_directory', input, actor)).toMatchObject({
    ok: true,
    proposal: { ...proposal, totalFiles: 0, fileOffset: 0, nextFileOffset: null },
  });
  expect(f.writer.prepare).toHaveBeenCalledWith({
    slot: 'right',
    mode: 'save-as',
    expectedRevision: 9,
    requestId: 'one',
    rootId: 'root-1',
    folderName: 'Right crossover',
    principal: actor,
  });
  expect(
    await f.execute('fusion_project_directory', { action: 'commit', id: proposal.id }, actor),
  ).toMatchObject({ ok: true });
  expect(f.writer.commit).toHaveBeenCalledWith(proposal.id, actor, { allowOverwrite: false });
  await f.execute(
    'fusion_project_directory',
    { action: 'commit', id: proposal.id, allowOverwrite: true },
    actor,
  );
  expect(f.writer.commit).toHaveBeenLastCalledWith(proposal.id, actor, { allowOverwrite: true });
  expect(f.documents).toEqual(before);
  expect(f.adapter.edit).not.toHaveBeenCalled();
  expect(f.adapter.connect).not.toHaveBeenCalled();
});

it('cached storage namespace forwards the same validated review and recovery operations', async () => {
  const f = fixture();
  const invoke = (directory: unknown) =>
    f.execute('fusion_workspace_storage', { action: 'project-directory', directory }, actor);
  expect(await invoke({ action: 'status' })).toMatchObject({
    ok: true,
    directory: { roots: [{ id: 'root-1' }] },
  });
  await invoke({ action: 'status', id: proposal.id });
  expect(f.writer.status).toHaveBeenCalledWith(proposal.id, actor);
  await invoke({ action: 'retry', id: proposal.id });
  expect(f.writer.retry).toHaveBeenCalledWith(proposal.id, actor);
  await invoke({ action: 'recover', id: proposal.id });
  expect(f.writer.recover).toHaveBeenCalledWith(proposal.id, actor);
  await invoke({ action: 'discard-review', id: proposal.id });
  expect(f.writer.forgetRecovery).toHaveBeenCalledWith(proposal.id, actor);
  await invoke({ action: 'retry-storage' });
  expect(f.writer.retryStorage).toHaveBeenCalledOnce();
  await invoke({ action: 'forget-root', rootId: 'root-1' });
  expect(f.writer.forgetRoot).toHaveBeenCalledWith('root-1');
  expect(
    await f.execute(
      'fusion_workspace_storage',
      { action: 'status', directory: { action: 'status' } },
      actor,
    ),
  ).toMatchObject({ ok: false });
});

it('exports binary recovery through bounded file transfers rather than returning raw data or handles', async () => {
  const f = fixture();
  const result = await f.execute(
    'fusion_project_directory',
    { action: 'export-recovery', id: proposal.id },
    actor,
  );
  expect(result).toMatchObject({ ok: true, transfer: { id: 'transfer-1', fileCount: 0 } });
  expect(f.writer.exportRecovery).toHaveBeenCalledWith(proposal.id, actor);
  expect(f.createExport).toHaveBeenCalledWith(
    actor,
    [{ path: 'before/Config.xml', blob: expect.any(Blob) }],
    {
      workflow: 'project-directory-recovery',
      parameters: { id: proposal.id, format: 'files' },
      expectedRevision: 9,
    },
  );
  expect(JSON.stringify(result)).not.toContain('original');
});

it('retains the partial-write ledger and grant failure code, and respects cancellation before a write starts', async () => {
  const f = fixture();
  vi.mocked(f.writer.commit).mockRejectedValueOnce(
    new DirectorySaveError('partial-write', 'Readback failed', { ...proposal, phase: 'partial' }),
  );
  expect(
    await f.execute('fusion_project_directory', { action: 'commit', id: proposal.id }, actor),
  ).toMatchObject({
    ok: false,
    code: 'partial-write',
    needsHumanGrant: false,
    proposal: { phase: 'partial' },
  });
  vi.mocked(f.writer.prepare).mockRejectedValueOnce(
    new DirectorySaveError('needs-human-grant', 'Choose the folder again'),
  );
  expect(
    await f.execute(
      'fusion_project_directory',
      { action: 'prepare', slot: 'right', mode: 'save', expectedRevision: 9, requestId: 'two' },
      actor,
    ),
  ).toMatchObject({ ok: false, code: 'needs-human-grant', needsHumanGrant: true });
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.execute(
      'fusion_project_directory',
      { action: 'commit', id: proposal.id },
      { ...actor, signal: controller.signal },
    ),
  ).rejects.toBeDefined();
  expect(f.writer.commit).toHaveBeenCalledOnce();
  expect(
    TOOL_DEFINITIONS.find((t) => t.name === 'fusion_project_directory')?.annotations.readOnlyHint,
  ).toBe(false);
});

it('archive review and explicit removal use the trusted principal through the cached namespace, returning historical metadata without workspace edits', async () => {
  const f = fixture(),
    before = structuredClone(f.documents),
    invoke = (directory: unknown, context: typeof actor | undefined = actor) =>
      f.execute('fusion_workspace_storage', { action: 'project-directory', directory }, context);
  for (const input of [
    { action: 'archive', reviewId: 'archive-review-1' },
    { action: 'archive', reviewId: 'archive-review-1', confirm: true, removeLocalRecovery: false },
    { action: 'archive', reviewId: 'archive-review-1', confirm: false, removeLocalRecovery: true },
    {
      action: 'archive',
      reviewId: 'archive-review-1',
      confirm: true,
      removeLocalRecovery: true,
      principal: actor,
    },
    { action: 'review-archive', id: 'save-1', confirm: true },
  ])
    expect(await invoke(input)).toMatchObject({ ok: false });
  expect(
    await f.execute('fusion_project_directory', { action: 'review-archive', id: 'save-1' }),
  ).toMatchObject({ ok: false });
  expect(
    await f.execute('fusion_project_directory', {
      action: 'archive',
      reviewId: 'archive-review-1',
      confirm: true,
      removeLocalRecovery: true,
    }),
  ).toMatchObject({ ok: false });
  expect(f.writer.hydrate).not.toHaveBeenCalled();
  expect(f.writer.reviewArchive).not.toHaveBeenCalled();
  expect(f.writer.archive).not.toHaveBeenCalled();
  expect(await invoke({ action: 'review-archive', id: 'save-1' })).toMatchObject({
    ok: true,
    review: {
      id: 'archive-review-1',
      saveId: 'save-1',
      proposal: { phase: 'complete', totalFiles: 0 },
    },
  });
  expect(f.writer.reviewArchive).toHaveBeenCalledWith('save-1', actor);
  expect(
    await invoke({
      action: 'archive',
      reviewId: 'archive-review-1',
      confirm: true,
      removeLocalRecovery: true,
    }),
  ).toMatchObject({
    ok: true,
    receipt: {
      archived: true,
      recoveryAvailable: false,
      verified: true,
      replayed: true,
      atomic: false,
    },
  });
  expect(f.writer.archive).toHaveBeenCalledWith('archive-review-1', actor, {
    confirm: true,
    removeLocalRecovery: true,
  });
  expect(f.documents).toEqual(before);
  expect(f.adapter.edit).not.toHaveBeenCalled();
  expect(f.writer.commit).not.toHaveBeenCalled();
});

it('status pages history and archived file manifests and rejects mixing list/file paging before service access', async () => {
  const f = fixture();
  f.snapshot.saves = Array.from({ length: 55 }, (_, index) => ({
    ...proposal,
    id: `record-${index}`,
    phase: 'complete' as const,
    ...(index >= 50 ? { archived: true as const, recoveryAvailable: false } : {}),
    files: Array.from({ length: 52 }, (_, file) => ({
      path: `${file}.dat`,
      action: 'create' as const,
      bytes: 1,
      sha256: 'e'.repeat(64),
      state: 'verified' as const,
      recovery: 'pending' as const,
    })),
  }));
  expect(await f.execute('fusion_project_directory', { action: 'status' }, actor)).toMatchObject({
    ok: true,
    directory: { totalSaves: 50, archivedSaves: 5, nextOffset: 20, saves: expect.any(Array) },
  });
  const history = (await f.execute(
    'fusion_project_directory',
    { action: 'status', offset: 50, limit: 2, includeArchived: true },
    actor,
  )) as { directory: { saves: DirectorySaveProposal[]; nextOffset: number | null } };
  expect(history.directory.saves.map((save) => save.id)).toEqual(['record-50', 'record-51']);
  expect(history.directory.nextOffset).toBe(52);
  vi.mocked(f.writer.status).mockResolvedValue(f.snapshot.saves[50]);
  expect(
    await f.execute(
      'fusion_project_directory',
      { action: 'status', id: 'record-50', fileOffset: 50, fileLimit: 2 },
      actor,
    ),
  ).toMatchObject({
    ok: true,
    proposal: {
      archived: true,
      recoveryAvailable: false,
      totalFiles: 52,
      fileOffset: 50,
      nextFileOffset: null,
      files: [{ path: '50.dat' }, { path: '51.dat' }],
    },
  });
  const calls = vi.mocked(f.writer.hydrate).mock.calls.length;
  for (const input of [
    { action: 'status', fileOffset: 1 },
    { action: 'status', id: 'record-1', includeArchived: true },
    { action: 'status', id: 'record-1', offset: 1 },
    { action: 'status', limit: 101 },
  ])
    expect(await f.execute('fusion_project_directory', input, actor)).toMatchObject({ ok: false });
  expect(f.writer.hydrate).toHaveBeenCalledTimes(calls);
  vi.mocked(f.writer.exportRecovery).mockRejectedValueOnce(
    new DirectorySaveError('archived-unavailable', 'Browser recovery copies were archived'),
  );
  expect(
    await f.execute(
      'fusion_project_directory',
      { action: 'export-recovery', id: 'record-50', format: 'zip' },
      actor,
    ),
  ).toMatchObject({ ok: false, code: 'archived-unavailable' });
  expect(f.createExport).not.toHaveBeenCalled();
});

it('exports a binary recovery ZIP through the real chunk manager and authorizes chunk reads to the same trusted scope', async () => {
  const f = fixture(),
    records = new Map<string, FileTransferRecord>(),
    chunks = new Map<string, Uint8Array>(),
    key = (id: string, file: number, index: number) => `${id}/${file}/${index}`,
    backend: FileTransferBackend = {
      transaction: async (work) =>
        work({
          get: async (id) => structuredClone(records.get(id)),
          list: async () => structuredClone([...records.values()]),
          put: async (record) => {
            records.set(record.id, structuredClone(record));
          },
          putChunk: async (id, file, index, value) => {
            chunks.set(key(id, file, index), value.slice());
          },
          getChunk: async (id, file, index) => chunks.get(key(id, file, index))?.slice(),
          deleteChunks: async (id) => {
            for (const name of chunks.keys()) if (name.startsWith(id + '/')) chunks.delete(name);
          },
          delete: async (id) => {
            records.delete(id);
          },
        }),
    },
    manager = createFileTransfers({ backend });
  f.adapter.files!.manager = manager;
  const bytes = Uint8Array.of(0xff, 0, 13, 10, 0xc0, 0xaf);
  vi.mocked(f.writer.exportRecovery).mockResolvedValueOnce([
    { path: 'manifest.json', blob: new Blob(['{}']) },
    { path: 'before/Config.xml', blob: new Blob([bytes]) },
  ]);
  const exported = (await f.execute(
    'fusion_project_directory',
    { action: 'export-recovery', id: 'save-1', format: 'zip' },
    actor,
  )) as {
    ok: boolean;
    transfer: { id: string; files: { path: string; bytes: number; sha256: string }[] };
  };
  expect(exported.ok).toBe(true);
  expect(exported.transfer.files).toHaveLength(1);
  expect(exported.transfer.files[0].path).toBe('Recovery.zip');
  const reply = (await f.execute(
    'fusion_file_chunk_read',
    { id: exported.transfer.id, fileIndex: 0, chunkIndex: 0 },
    actor,
  )) as { ok: boolean; base64: string; sha256: string };
  expect(reply.ok).toBe(true);
  const zipped = Buffer.from(reply.base64, 'base64');
  expect(zipped.readUInt32LE(0)).toBe(0x04034b50);
  expect(zipped.includes(Buffer.from(bytes))).toBe(true);
  expect(zipped.includes(Buffer.from('before/Config.xml'))).toBe(true);
  expect(createHash('sha256').update(zipped).digest('hex')).toBe(exported.transfer.files[0].sha256);
  expect(reply.sha256).toBe(exported.transfer.files[0].sha256);
  expect(
    await f.execute(
      'fusion_file_chunk_read',
      { id: exported.transfer.id, fileIndex: 0, chunkIndex: 0 },
      { owner: 'site:other', scope: 'lease:other' },
    ),
  ).toMatchObject({ ok: false });
  expect(f.writer.archive).not.toHaveBeenCalled();
  expect(f.adapter.edit).not.toHaveBeenCalled();
});

it('reviews older-record access through the shared domain service, returns paged metadata and optionally opens the local review with the complete proposal', async () => {
  const f = fixture(),
    before = structuredClone(f.documents),
    older: DirectorySaveProposal = {
      ...proposal,
      phase: 'complete',
      needsLocalAdoption: true,
      files: Array.from({ length: 75 }, (_, index) => ({
        path: `original-${index}.dat`,
        action: 'replace' as const,
        bytes: 3,
        sha256: 'a'.repeat(64),
        state: 'verified' as const,
        recovery: 'pending' as const,
      })),
    },
    review: DirectoryLegacyReview = {
      id: 'legacy-review',
      recordId: proposal.id,
      slot: 'right',
      phase: 'complete',
      envelopeRevision: 44,
      manifestSha256: 'b'.repeat(64),
      proposal: older,
    },
    reviewLegacy = vi.fn(async () => review);
  f.writer.reviewLegacy = reviewLegacy;
  const first = (await f.execute(
    'fusion_project_directory',
    { action: 'review-legacy', id: proposal.id },
    actor,
  )) as {
    ok: boolean;
    localReviewOpened: boolean;
    review: DirectoryLegacyReview & { proposal: { totalFiles: number; nextFileOffset: number } };
  };
  expect(first).toMatchObject({
    ok: true,
    localReviewOpened: false,
    review: {
      id: 'legacy-review',
      proposal: { needsLocalAdoption: true, totalFiles: 75, nextFileOffset: 40 },
    },
  });
  expect(first.review.proposal.files).toHaveLength(40);
  expect(reviewLegacy).toHaveBeenCalledExactlyOnceWith(proposal.id, actor);
  f.adapter.reviewDirectoryLegacy = vi.fn(() => true);
  expect(
    await f.execute(
      'fusion_workspace_storage',
      { action: 'project-directory', directory: { action: 'review-legacy', id: proposal.id } },
      actor,
    ),
  ).toMatchObject({ ok: true, localReviewOpened: true });
  expect(f.adapter.reviewDirectoryLegacy).toHaveBeenCalledExactlyOnceWith(review);
  expect(vi.mocked(f.adapter.reviewDirectoryLegacy).mock.calls[0][0].proposal.files).toHaveLength(
    75,
  );
  expect(f.documents).toEqual(before);
  expect(f.adapter.edit).not.toHaveBeenCalled();
  expect(f.writer.commit).not.toHaveBeenCalled();
  expect(f.writer.recover).not.toHaveBeenCalled();
  expect(f.writer.exportRecovery).not.toHaveBeenCalled();
});

it('requires strict explicit approval and trusted context, rejects owner/human forgery, and lets the domain refuse agent adoption', async () => {
  const f = fixture(),
    reviewLegacy = vi.fn(async (): Promise<DirectoryLegacyReview> => ({
      id: 'legacy-review',
      recordId: proposal.id,
      slot: 'right',
      phase: 'complete',
      envelopeRevision: 44,
      manifestSha256: 'b'.repeat(64),
      proposal: { ...proposal, phase: 'complete', needsLocalAdoption: true },
    })),
    adoptLegacy = vi.fn(
      async (
        _id: string,
        caller: { owner: string; scope: string },
        _confirmation: { confirm: true },
      ) => {
        if (caller.owner !== 'workspace:local' || caller.scope !== 'ui:actual-dialog')
          throw new DirectorySaveError(
            'needs-local-adoption',
            'Confirm access in the local browser review',
          );
        return proposal;
      },
    );
  f.writer.reviewLegacy = reviewLegacy;
  f.writer.adoptLegacy = adoptLegacy;
  for (const input of [
    { action: 'adopt-legacy', reviewId: 'legacy-review' },
    { action: 'adopt-legacy', reviewId: 'legacy-review', confirm: false },
    { action: 'adopt-legacy', reviewId: 'legacy-review', confirm: true, owner: 'workspace:local' },
    { action: 'adopt-legacy', reviewId: 'legacy-review', confirm: true, scope: 'ui:actual-dialog' },
    { action: 'adopt-legacy', reviewId: 'legacy-review', confirm: true, human: true },
    { action: 'adopt-legacy', reviewId: 'legacy-review', confirm: true, isLocalHuman: true },
    {
      action: 'review-legacy',
      id: proposal.id,
      principal: { owner: 'workspace:local', scope: 'ui:actual-dialog' },
    },
  ])
    expect(await f.execute('fusion_project_directory', input, actor)).toMatchObject({ ok: false });
  for (const input of [
    { action: 'review-legacy', id: proposal.id },
    { action: 'adopt-legacy', reviewId: 'legacy-review', confirm: true },
  ])
    expect(await f.execute('fusion_project_directory', input)).toMatchObject({
      ok: false,
      error: expect.stringContaining('trusted'),
    });
  expect(f.writer.hydrate).not.toHaveBeenCalled();
  expect(reviewLegacy).not.toHaveBeenCalled();
  expect(adoptLegacy).not.toHaveBeenCalled();
  const blocked = await f.execute(
    'fusion_workspace_storage',
    {
      action: 'project-directory',
      directory: { action: 'adopt-legacy', reviewId: 'legacy-review', confirm: true },
    },
    actor,
  );
  expect(blocked).toMatchObject({
    ok: false,
    code: 'needs-local-adoption',
    error: 'Confirm access in the local browser review',
  });
  expect(adoptLegacy).toHaveBeenCalledExactlyOnceWith('legacy-review', actor, { confirm: true });
  expect(f.writer.commit).not.toHaveBeenCalled();
  expect(f.writer.recover).not.toHaveBeenCalled();
  expect(f.writer.archive).not.toHaveBeenCalled();
  expect(f.adapter.edit).not.toHaveBeenCalled();
});
