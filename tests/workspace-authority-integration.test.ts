import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createWorkspaceAuthority } from '../src/application/workspace-authority';
import {
  createFileTransfers,
  FILE_TRANSFER_CHUNK_BYTES,
  type FileTransferBackend,
  type FileTransferRecord,
  type FileTransferTransaction,
  type TransferCommitCallbacks,
} from '../src/application/file-transfers';
import { createWorkspaceProjectSources } from '../src/application/browser-project-sources';
import {
  type ProjectSourcesBackend,
  type ProjectSourcesEnvelope,
} from '../src/application/project-sources';
import { assertProjectSourcesWrite } from '../src/application/project-sources-format';
import {
  createCaptureController,
  type CaptureBackend,
  type CaptureController,
  type CaptureRequest,
  type CaptureSession,
} from '../src/application/measurement-capture';
import type { ToolExecutionContext } from '../src/application/execution-context';
import { HFD_RECORD_SAMPLES, HFD_SWEEP_SAMPLES } from '../src/domain/hfd-audio';
import { newProject } from '../src/domain/model';
import { createWorkspaceStore } from '../src/state/workspace';
import {
  assertWorkspaceWrite,
  type WorkspaceEnvelope,
  type WorkspacePersistenceBackend,
} from '../src/state/persistence';

const WORKSPACE_ID = '11223344-5566-7788-99aa-bbccddeeff00';
const FOREIGN_ID = 'ffeeddcc-bbaa-9988-7766-554433221100';
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const base64 = (value: Uint8Array) => Buffer.from(value).toString('base64');
let page = 0;
async function authority(id = WORKSPACE_ID) {
  const instance = ++page;
  let scope = 0;
  const service = createWorkspaceAuthority({
    loadOrCreate: async () => ({ version: 1, id }),
    id: () => `page-${instance}-${++scope}`,
  });
  await service.hydrate();
  return {
    service,
    // Like AgentAccess, admission happens once at the trusted execution boundary.
    human: () => service.admit(service.localContext('ui')),
    async paired(source: 'site' | 'local', owner: string, lease: string) {
      const raw = { owner, scope: lease };
      service.registerPairedActor(raw, source);
      return service.admit(raw);
    },
  };
}
function transfersBackend(): FileTransferBackend {
  let records = new Map<string, FileTransferRecord>(),
    chunks = new Map<string, Uint8Array>();
  let tail: Promise<unknown> = Promise.resolve();
  const key = (id: string, file: number, index: number) => `${id}/${file}/${index}`;
  return {
    transaction<T>(action: (tx: FileTransferTransaction) => Promise<T>) {
      const work = tail.then(async () => {
        const nextRecords = structuredClone(records),
          nextChunks = structuredClone(chunks);
        const tx: FileTransferTransaction = {
          get: async (id) => structuredClone(nextRecords.get(id)),
          list: async () => structuredClone([...nextRecords.values()]),
          put: async (record) => {
            nextRecords.set(record.id, structuredClone(record));
          },
          putChunk: async (id, file, index, bytes) => {
            nextChunks.set(key(id, file, index), bytes.slice());
          },
          getChunk: async (id, file, index) => nextChunks.get(key(id, file, index))?.slice(),
          deleteChunks: async (id) => {
            for (const item of nextChunks.keys())
              if (item.startsWith(`${id}/`)) nextChunks.delete(item);
          },
          delete: async (id) => {
            nextRecords.delete(id);
            for (const item of nextChunks.keys())
              if (item.startsWith(`${id}/`)) nextChunks.delete(item);
          },
        };
        const result = await action(tx);
        records = nextRecords;
        chunks = nextChunks;
        return result;
      });
      tail = work.then(
        () => {},
        () => {},
      );
      return work;
    },
  };
}
function sourcesBackend(): ProjectSourcesBackend {
  let value: ProjectSourcesEnvelope | null = null;
  return {
    read: async () => structuredClone(value),
    write: async (next, expected) => {
      assertProjectSourcesWrite(value, next, expected);
      value = structuredClone(next);
    },
  };
}
function workspaceBackend() {
  let value: WorkspaceEnvelope = {
    version: 1,
    state: {
      documents: { left: newProject('Original Left'), right: newProject('Original Right') },
      slot: 'left',
      preset: 0,
      channel: 0,
      filter: 0,
      linkedEdits: true,
      linkedControls: true,
      documentRevision: 0,
    },
  };
  const backend: WorkspacePersistenceBackend = {
    read: async () => structuredClone(value),
    readLegacy: () => null,
    write: async (next, expected) => {
      assertWorkspaceWrite(value, expected, next);
      value = structuredClone(next);
    },
  };
  return {
    backend,
    get value() {
      return structuredClone(value);
    },
  };
}

it('shares NEW binary transfers between human, Site and local actors while retaining strict scope rebind and durable exact-once receipts', async () => {
  const firstPage = await authority(),
    human = await firstPage.human();
  const disk = transfersBackend();
  let next = 0;
  const manager = createFileTransfers({ backend: disk, randomId: () => `shared-${++next}` });
  const storage = workspaceBackend(),
    workspace = createWorkspaceStore(storage.backend);
  await workspace.persistence.hydrate();
  const baseline = structuredClone(workspace.store.getState().documents);
  const bytes = Uint8Array.from(
    { length: FILE_TRANSFER_CHUNK_BYTES + 23 },
    (_, index) => (index * 37 + 129) % 256,
  );
  const upload = await manager.beginUpload(human, {
    files: [{ path: 'binary.dat', bytes: bytes.length, sha256: hash(bytes) }],
    binding: {
      workflow: 'integration-binary',
      parameters: { target: 'right' },
      expectedRevision: 0,
    },
  });
  const part0 = bytes.subarray(0, FILE_TRANSFER_CHUNK_BYTES),
    part1 = bytes.subarray(FILE_TRANSFER_CHUNK_BYTES);
  await manager.putChunk(human, upload.id, 0, 0, base64(part0), hash(part0));
  const site = await firstPage.paired('site', 'site:authenticated-user', 'site-lease-1');
  expect(site.owner).toBe(human.owner);
  expect(site.scope).not.toBe(human.scope);
  await expect(manager.status(site, upload.id)).rejects.toThrow('execution scope');
  expect(await manager.list(site)).toEqual([]);
  expect(await manager.list(site, { includeOtherScopes: true })).toMatchObject([
    { id: upload.id, rebindRequired: true },
  ]);
  await manager.rebind(site, upload.id);
  await expect(
    manager.putChunk(site, upload.id, 0, 1, base64(part1), '0'.repeat(64)),
  ).rejects.toThrow('SHA-256');
  await manager.putChunk(site, upload.id, 0, 1, base64(part1), hash(part1));
  await manager.sealUpload(site, upload.id);
  const apply = vi.fn();
  const callbacks = (actor: ToolExecutionContext): TransferCommitCallbacks => ({
    lookup: (id) => workspace.store.getState().lookupFileCommit(id, actor.owner),
    apply: async (binding, files, commitId) => {
      const received = new Uint8Array(await files[0].blob.arrayBuffer());
      expect(hash(received)).toBe(hash(bytes));
      expect(Buffer.from(received).equals(Buffer.from(bytes))).toBe(true);
      return workspace.store.getState().commitFileImport(
        commitId,
        actor,
        binding.expectedRevision,
        ['right'],
        (project) => {
          apply();
          project.name = 'Verified binary import';
        },
        { workflow: binding.workflow, sha256: hash(received), bytes: received.length },
      );
    },
  });
  const receipt = await manager.commit(site, upload.id, callbacks(site));
  expect(apply).toHaveBeenCalledTimes(1);
  expect(workspace.store.getState().documents.left).toEqual(baseline.left);
  expect(storage.value.state.fileCommitReceipts![upload.commitId].owner).toBe(human.owner);

  const secondPage = await authority(),
    local = await secondPage.paired('local', 'local:new-server-process', 'local-lease-2');
  const reloaded = createFileTransfers({ backend: disk });
  await expect(reloaded.commit(local, upload.id, callbacks(local))).rejects.toThrow(
    'execution scope',
  );
  await reloaded.rebind(local, upload.id);
  workspace.store.getState().undo();
  await workspace.persistence.flush();
  expect(await reloaded.commit(local, upload.id, callbacks(local))).toEqual(receipt);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(workspace.store.getState().documents).toEqual(baseline);
  const exported = await reloaded.createExport(local, [
    { path: 'binary.bin', blob: new Blob([bytes]) },
  ]);
  const newHuman = await secondPage.human();
  await expect(reloaded.readChunk(newHuman, exported.id, 0, 0)).rejects.toThrow('execution scope');
  await reloaded.rebind(newHuman, exported.id);
  const received = [];
  for (let index = 0; index < 2; index++) {
    const chunk = await reloaded.readChunk(newHuman, exported.id, 0, index),
      data = Buffer.from(chunk.base64, 'base64');
    expect(hash(data)).toBe(chunk.sha256);
    received.push(data);
  }
  expect(Buffer.concat(received).equals(Buffer.from(bytes))).toBe(true);
  const foreignPage = await authority(FOREIGN_ID),
    foreign = await foreignPage.human();
  expect(await reloaded.list(foreign, { includeOtherScopes: true })).toEqual([]);
  await expect(reloaded.rebind(foreign, exported.id)).rejects.toThrow('execution scope');
  await expect(reloaded.readChunk(foreign, exported.id, 0, 0)).rejects.toThrow('execution scope');
  expect(
    await workspace.store.getState().lookupFileCommit(upload.commitId, foreign.owner),
  ).toBeUndefined();
  await reloaded.close(newHuman, exported.id);
  await reloaded.rebind(local, upload.id);
  await reloaded.close(local, upload.id);
});

it.each(['human-to-site', 'local-to-human'] as const)(
  'replays a NEW project-source receipt across authorities and wire-owner changes without a second apply: %s',
  async (direction) => {
    const firstPage = await authority(),
      first =
        direction === 'human-to-site'
          ? await firstPage.human()
          : await firstPage.paired('local', 'local:first-process', 'lease-before');
    const disk = workspaceBackend(),
      workspace = createWorkspaceStore(disk.backend);
    await workspace.persistence.hydrate();
    const baseline = structuredClone(workspace.store.getState().documents),
      incoming = newProject('Imported source');
    incoming.presets[2].channels[1].delayUs = 125;
    const sourceDisk = sourcesBackend(),
      getLibraryProject = vi.fn(async () => ({
        id: 'saved-project',
        name: incoming.name,
        utc: new Date(0).toISOString(),
        project: incoming,
      }));
    const applied = vi.fn();
    const makeSources = (store: typeof workspace) =>
      createWorkspaceProjectSources({
        backend: sourceDisk,
        getLibraryProject,
        getWorkspace: () => ({
          lookupFileCommit: (...args) => store.store.getState().lookupFileCommit(...args),
          commitFileImport: (...args) => {
            const change = args[4];
            args[4] = (project, slot) => {
              applied();
              change(project, slot);
            };
            return store.store.getState().commitFileImport(...args);
          },
        }),
      });
    const sources = makeSources(workspace),
      sourceId = await sources.rememberLibrary({ id: 'saved-project', label: incoming.name });
    const input = {
      sourceId,
      target: 'right' as const,
      expectedRevision: 0,
      requestId: 'same-open-request',
      principal: first,
    };
    const opened = await sources.open(input);
    expect(workspace.store.getState().documents).toEqual({ left: baseline.left, right: incoming });
    expect(opened.receipt.commitId).toBe(`source-open:${first.owner}:same-open-request`);
    expect(applied).toHaveBeenCalledTimes(1);
    workspace.store.getState().undo();
    await workspace.persistence.flush();
    const reloadWorkspace = createWorkspaceStore(disk.backend);
    await reloadWorkspace.persistence.hydrate();
    const nextPage = await authority(),
      next =
        direction === 'human-to-site'
          ? await nextPage.paired('site', 'site:different-wire-owner', 'new-site-lease')
          : await nextPage.human();
    expect(next.owner).toBe(first.owner);
    expect(next.scope).not.toBe(first.scope);
    const replay = await makeSources(reloadWorkspace).open({ ...input, principal: next });
    expect(replay).toMatchObject({ replayed: true, receipt: opened.receipt });
    expect(reloadWorkspace.store.getState().documents).toEqual(baseline);
    expect(applied).toHaveBeenCalledTimes(1);
    expect(getLibraryProject).toHaveBeenCalledTimes(1);
    await expect(
      makeSources(reloadWorkspace).open({ ...input, target: 'left', principal: next }),
    ).rejects.toThrow();
    expect(applied).toHaveBeenCalledTimes(1);
  },
);

async function captureFixture(complete: boolean) {
  const disk = workspaceBackend(),
    workspace = createWorkspaceStore(disk.backend);
  await workspace.persistence.hydrate();
  const baseline = structuredClone(workspace.store.getState().documents);
  const session: CaptureSession = {
    info: {
      sampleRate: 48000,
      inputChannels: 2,
      outputChannels: 2,
      timeOrigin: 'Synthetic render-frame origin; no physical audio',
    },
    preflight: vi.fn(),
    capture: vi.fn(async (output: Float64Array) => {
      expect(output).toHaveLength(HFD_RECORD_SAMPLES);
      return complete ? output.slice() : new Promise<Float64Array>(() => {});
    }),
    stop: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
  const backend: CaptureBackend = {
    devices: vi.fn(async () => []),
    enable: vi.fn(async () => session),
  };
  let busy = false;
  const make = (human: ToolExecutionContext) =>
    createCaptureController({
      backend,
      localOwner: human.owner,
      operate: async (_label, work) => {
        if (busy) throw new Error('Another synthetic operation is active');
        busy = true;
        try {
          return await work();
        } finally {
          busy = false;
        }
      },
      workspace: {
        state: workspace.store.getState,
        flush: workspace.persistence.flush,
        commit: (...args) => workspace.store.getState().commitFileImport(...args),
        lookup: (id, owner) => workspace.store.getState().lookupFileCommit(id, owner),
      },
    });
  const settled = async (controller: CaptureController, phase: string) => {
    await vi.waitFor(
      () => {
        expect(controller.getSnapshot().phase).toBe(phase);
        expect(busy).toBe(false);
      },
      { timeout: 10000, interval: 5 },
    );
  };
  return { disk, workspace, baseline, session, backend, make, settled };
}
const take = (): CaptureRequest => ({
  requestId: 'authority-take',
  target: { slot: 'right', preset: 1, channel: 2 },
  expectedRevision: 0,
  name: 'Synthetic capture',
});

it('lets admitted Site/local actors control human-enabled capture, but preserves target/signature guards and never replays an interrupted Take', async () => {
  const firstPage = await authority(),
    human = await firstPage.human(),
    site = await firstPage.paired('site', 'site:user', 'site-a');
  const fixture = await captureFixture(false),
    controller = fixture.make(human);
  await controller.enable(human);
  controller.start(site, take());
  await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('recording'), {
    timeout: 10000,
    interval: 5,
  });
  expect(fixture.session.capture).toHaveBeenCalledTimes(1);
  const nextPage = await authority(),
    local = await nextPage.paired('local', 'local:replacement-process', 'local-b');
  expect(controller.start(local, take()).phase).toBe('recording');
  expect(() =>
    controller.start(local, { ...take(), target: { ...take().target, channel: 0 } }),
  ).toThrow('different parameters');
  const foreignPage = await authority(FOREIGN_ID),
    foreign = await foreignPage.human();
  expect(() => controller.cancel(foreign)).toThrow('another owner');
  controller.cancel(local, take().requestId);
  await fixture.settled(controller, 'cancelled');
  expect(fixture.session.stop).toHaveBeenCalled();
  await controller.disable(human);
  const freshHuman = await nextPage.human(),
    fresh = fixture.make(freshHuman);
  fresh.start(freshHuman, take());
  await fixture.settled(fresh, 'interrupted');
  expect(fresh.getSnapshot().error).toContain('already cleared');
  expect(fixture.session.capture).toHaveBeenCalledTimes(1);
  expect(fixture.backend.enable).toHaveBeenCalledTimes(1);
  expect(fixture.workspace.store.getState().documentRevision).toBe(1);
  expect(fixture.workspace.store.getState().documents.left).toEqual(fixture.baseline.left);
  expect(fixture.workspace.store.getState().documents.right.presets[0]).toEqual(
    fixture.baseline.right.presets[0],
  );
  expect(
    fixture.workspace.store.getState().documents.right.presets[1].channels[2].measurement,
  ).toBeUndefined();
  fresh.start(freshHuman, { ...take(), requestId: 'stale-revision-take' });
  await fixture.settled(fresh, 'error');
  expect(fresh.getSnapshot().error).toContain('design changed');
  expect(fixture.session.capture).toHaveBeenCalledTimes(1);
  await fresh.dispose();
  await controller.dispose();
});

it('replays a completed agent Take for a new human authority after Undo using durable receipts without enabling or recording again', async () => {
  const firstPage = await authority(),
    human = await firstPage.human(),
    site = await firstPage.paired('site', 'site:user', 'site-a');
  const fixture = await captureFixture(true),
    controller = fixture.make(human);
  await controller.enable(human);
  controller.start(site, take());
  await fixture.settled(controller, 'complete');
  expect(fixture.session.capture).toHaveBeenCalledTimes(1);
  expect(fixture.workspace.store.getState().documentRevision).toBe(2);
  const measured =
    fixture.workspace.store.getState().documents.right.presets[1].channels[2].measurement!;
  expect(measured.impulse).toHaveLength(HFD_SWEEP_SAMPLES);
  expect(measured.sampleRate).toBe(48000);
  expect(measured.hfdPhase!.frequency).toHaveLength(1024);
  const receipt = controller.getSnapshot().receipt!;
  expect(fixture.disk.value.state.fileCommitReceipts![receipt.commitId].owner).toBe(human.owner);
  fixture.workspace.store.getState().undo();
  fixture.workspace.store.getState().undo();
  await fixture.workspace.persistence.flush();
  expect(fixture.workspace.store.getState().documents).toEqual(fixture.baseline);
  await controller.disable(human);
  const nextPage = await authority(),
    nextHuman = await nextPage.human(),
    fresh = fixture.make(nextHuman);
  fresh.start(nextHuman, take());
  await fixture.settled(fresh, 'complete');
  expect(fresh.getSnapshot().receipt).toEqual(receipt);
  expect(fixture.workspace.store.getState().documents).toEqual(fixture.baseline);
  expect(fixture.session.capture).toHaveBeenCalledTimes(1);
  expect(fixture.backend.enable).toHaveBeenCalledTimes(1);
  expect(() => fresh.start(nextHuman, { ...take(), expectedRevision: 1 })).toThrow(
    'different parameters',
  );
  await fresh.dispose();
  await controller.dispose();
});
