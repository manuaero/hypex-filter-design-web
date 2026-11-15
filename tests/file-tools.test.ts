import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createToolExecutor, TOOL_DEFINITIONS, type ToolAdapter } from '../src/application/tools';
import {
  createFileTransfers,
  FILE_TRANSFER_CHUNK_BYTES as CHUNK,
  type FileTransferBackend,
  type FileTransferRecord,
  type FileTransferTransaction,
  type FileTransferStatus,
  type TransferJson,
} from '../src/application/file-transfers';
import type { ToolExecutionContext } from '../src/application/execution-context';
import { newProject } from '../src/domain/model';
import { createWorkspaceStore } from '../src/state/workspace';
import {
  assertWorkspaceWrite,
  type WorkspaceEnvelope,
  type WorkspacePersistenceBackend,
} from '../src/state/persistence';

const actor: ToolExecutionContext = { owner: 'site:alice', scope: 'browser-a' };
const other: ToolExecutionContext = { owner: 'site:bob', scope: 'browser-b' };
const names = [
  'fusion_file_upload_begin',
  'fusion_file_upload_chunk',
  'fusion_file_upload_commit',
  'fusion_file_export',
  'fusion_file_chunk_read',
  'fusion_file_status',
  'fusion_file_close',
  'fusion_file_list',
];
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const text = (value: string) => new TextEncoder().encode(value);
type Page = FileTransferStatus & {
  fileCount: number;
  fileOffset: number;
  nextFileOffset: number | null;
};
type Result = {
  ok: boolean;
  error?: string;
  transfer?: Page;
  receipt?: TransferJson;
  base64?: string;
  bytes?: number;
  sha256?: string;
  closed?: boolean;
  transfers?: { id: string; rebindRequired: boolean; filesPreview: unknown[]; workflow?: string }[];
  total?: number;
  offset?: number;
  nextOffset?: number | null;
};
function transfersBackend() {
  let records = new Map<string, FileTransferRecord>(),
    chunks = new Map<string, Uint8Array>(),
    tail: Promise<unknown> = Promise.resolve();
  const key = (id: string, file: number, index: number) => `${id}/${file}/${index}`;
  const backend: FileTransferBackend = {
    transaction<T>(action: (tx: FileTransferTransaction) => Promise<T>): Promise<T> {
      const work = tail.then(async () => {
        const r = structuredClone(records),
          c = new Map(chunks);
        const remove = async (id: string) => {
          for (const k of c.keys()) if (k.startsWith(`${id}/`)) c.delete(k);
        };
        const tx: FileTransferTransaction = {
          get: async (id) => structuredClone(r.get(id)),
          list: async () => structuredClone([...r.values()]),
          put: async (value) => {
            r.set(value.id, structuredClone(value));
          },
          getChunk: async (id, file, index) => c.get(key(id, file, index))?.slice(),
          putChunk: async (id, file, index, bytes) => {
            c.set(key(id, file, index), new Uint8Array(bytes));
          },
          deleteChunks: remove,
          delete: async (id) => {
            r.delete(id);
            await remove(id);
          },
        };
        const result = await action(tx);
        records = r;
        chunks = c;
        return result;
      });
      tail = work.then(
        () => {},
        () => {},
      );
      return work;
    },
  };
  return {
    backend,
    get records() {
      return records;
    },
  };
}
async function setup() {
  let durable: WorkspaceEnvelope = {
    version: 1,
    state: {
      documents: { left: newProject('Original left'), right: newProject('Original right') },
      slot: 'left',
      preset: 0,
      channel: 0,
      filter: 0,
      linkedEdits: false,
      linkedControls: true,
      documentRevision: 0,
    },
  };
  let writes: Promise<unknown> = Promise.resolve();
  const disk: WorkspacePersistenceBackend = {
    read: async () => structuredClone(durable),
    readLegacy: () => null,
    write(next, expected) {
      const job = writes.then(() => {
        assertWorkspaceWrite(durable, expected, next);
        durable = structuredClone(next);
      });
      writes = job.then(
        () => {},
        () => {},
      );
      return job;
    },
  };
  const workspace = createWorkspaceStore(disk);
  await workspace.persistence.hydrate();
  const staging = transfersBackend();
  let id = 0;
  const manager = createFileTransfers({
    backend: staging.backend,
    randomId: () => `file-tool-${++id}`,
  });
  const hardware = vi.fn(() => {
    throw Error('File workflows must not access hardware');
  });
  const operation = vi.fn<(label: string) => void>();
  const adapter: ToolAdapter = {
    state: () => workspace.store.getState(),
    edit: (slots, apply) => workspace.store.getState().editAt(slots, apply),
    choose: (patch) => workspace.store.getState().choose(patch),
    undo: () => workspace.store.getState().undo(),
    redo: () => workspace.store.getState().redo(),
    connections: () => hardware(),
    connect: async () => hardware(),
    disconnect: async () => hardware(),
    refresh: async () => hardware(),
    operate: async (label, fn) => {
      operation(label);
      return fn();
    },
    message: () => {},
    progress: () => hardware(),
    view: () => {},
    persistence: {
      status: workspace.persistence.getSnapshot,
      retry: workspace.persistence.retry,
      flush: workspace.persistence.flush,
      recovery: workspace.persistence.recoveryText,
    },
    files: {
      manager,
      revision: () => workspace.store.getState().documentRevision ?? 0,
      commit: async (id, principal, revision, slots, apply, result, remember) =>
        (await workspace.store
          .getState()
          .commitFileImport(
            id,
            principal,
            revision,
            slots,
            apply,
            result,
            remember,
          )) as unknown as TransferJson,
      lookup: async (id, owner) =>
        (await workspace.store.getState().lookupFileCommit(id, owner)) as unknown as
          TransferJson | undefined,
    },
  };
  const execute = createToolExecutor(adapter);
  async function call(
    name: string,
    args: unknown,
    context: ToolExecutionContext | undefined = actor,
    alias = false,
  ): Promise<Result> {
    const result = (await execute(
      alias ? 'fusion_workspace_storage' : name,
      alias ? { action: 'file-transfer', command: name, arguments: args } : args,
      context,
    )) as Result;
    const wire = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
    });
    expect(text(wire).length).toBeLessThan(8e6);
    return result;
  }
  async function begin(
    data: Uint8Array,
    operation: unknown,
    path = 'project.fusion.json',
    alias = false,
  ) {
    const result = await call(
      'fusion_file_upload_begin',
      { operation, files: [{ path, bytes: data.length, sha256: digest(data) }] },
      actor,
      alias,
    );
    expect(result.ok, result.error).toBe(true);
    return result.transfer!;
  }
  async function chunk(id: string, data: Uint8Array, index: number, alias = false) {
    const part = data.subarray(index * CHUNK, (index + 1) * CHUNK);
    return call(
      'fusion_file_upload_chunk',
      {
        id,
        fileIndex: 0,
        chunkIndex: index,
        base64: Buffer.from(part).toString('base64'),
        sha256: digest(part),
      },
      actor,
      alias,
    );
  }
  return {
    call,
    execute,
    begin,
    chunk,
    workspace,
    manager,
    staging,
    hardware,
    operation,
    get durable() {
      return durable;
    },
  };
}

describe('agent file tools through the real executor', () => {
  it('retains direct channel labels beyond 100 characters exactly in the chosen role and supports Undo', async () => {
    const f = await setup(),
      before = structuredClone(f.workspace.store.getState().documents);
    const name = `  ${'Driver 測定 '.repeat(20)}  `,
      outputName = ` ${'Output / reference '.repeat(12)} `;
    expect(name.length).toBeGreaterThan(100);
    expect(outputName.length).toBeGreaterThan(100);
    const result = await f.call('fusion_channel_set', {
      target: 'right',
      preset: 2,
      channel: 3,
      patch: { name, outputName },
    });
    expect(result.ok, result.error).toBe(true);
    await f.workspace.persistence.flush();
    const state = f.workspace.store.getState();
    expect(state.documents.right.presets[1].channels[2].name).toBe(name);
    expect(state.documents.right.presets[1].channels[2].outputName).toBe(outputName);
    expect(state.documents.left).toEqual(before.left);
    expect(state.documents.right.presets[0]).toEqual(before.right.presets[0]);
    expect(state.documents.right.presets[1].channels.slice(0, 2)).toEqual(
      before.right.presets[1].channels.slice(0, 2),
    );
    expect(f.durable.state.documents.right.presets[1].channels[2].name).toBe(name);
    expect((await f.call('fusion_history', { action: 'undo' })).ok).toBe(true);
    expect(f.workspace.store.getState().documents).toEqual(before);
    expect(f.hardware).not.toHaveBeenCalled();
  });

  it('retains a direct FIR filename beyond 200 characters in the chosen role and supports Undo', async () => {
    const f = await setup(),
      before = structuredClone(f.workspace.store.getState().documents);
    const filename = `${'Native FIR '.repeat(23)}.txt`;
    expect(filename.length).toBeGreaterThan(200);
    const taps = Array.from({ length: 1500 }, (_, i) => (i === 0 ? 1 : 0));
    const result = await f.call('fusion_fir_set', {
      target: 'right',
      preset: 3,
      channel: 2,
      name: filename,
      text: taps.join('\n'),
      enabled: true,
    });
    expect(result.ok, result.error).toBe(true);
    await f.workspace.persistence.flush();
    const state = f.workspace.store.getState();
    expect(state.documents.right.presets[2].channels[1].fir).toEqual({
      name: filename,
      taps,
      enabled: true,
    });
    expect(state.documents.left).toEqual(before.left);
    expect(state.documents.right.presets.slice(0, 2)).toEqual(before.right.presets.slice(0, 2));
    expect(f.durable.state.documents.right.presets[2].channels[1].fir.name).toBe(filename);
    expect((await f.call('fusion_history', { action: 'undo' })).ok).toBe(true);
    expect(f.workspace.store.getState().documents).toEqual(before);
    expect(f.hardware).not.toHaveBeenCalled();
  });

  it('exposes eight offline tools and requires trusted context while rejecting spoofed arguments', async () => {
    for (const name of names)
      expect(TOOL_DEFINITIONS.some((tool) => tool.name === name)).toBe(true);
    const f = await setup(),
      operation = { workflow: 'project', parameters: { target: 'left' } };
    const args = { operation, files: [{ path: 'empty.json', bytes: 0, sha256: digest(text('')) }] };
    expect(((await f.execute('fusion_file_upload_begin', args)) as Result).ok).toBe(false);
    expect((await f.call('fusion_file_upload_begin', { ...args, owner: 'site:bob' })).ok).toBe(
      false,
    );
    expect((await f.call('fusion_file_upload_begin', { ...args, scope: 'spoofed' })).ok).toBe(
      false,
    );
    expect(
      (
        await f.call('fusion_file_upload_begin', {
          ...args,
          operation: { ...operation, parameters: { target: 'left', owner: 'site:bob' } },
        })
      ).ok,
    ).toBe(false);
    const forbidden = (await f.execute(
      'fusion_workspace_storage',
      { action: 'file-transfer', command: 'fusion_device_write', arguments: {} },
      actor,
    )) as Result;
    expect(forbidden.ok).toBe(false);
    expect(f.staging.records.size).toBe(0);
    expect(f.hardware).not.toHaveBeenCalled();
  });

  it('recovers lost begin/export handles through the owner-bound paged list compatibility alias', async () => {
    const f = await setup();
    const upload = await f.begin(text('not committed'), {
      workflow: 'project',
      parameters: { target: 'left' },
    });
    const exported = await f.call('fusion_file_export', {
      operation: { workflow: 'project-json', parameters: { slot: 'left' } },
    });
    const foreign = await f.call(
      'fusion_file_export',
      { operation: { workflow: 'project-json', parameters: { slot: 'right' } } },
      other,
    );
    const listed = await f.call('fusion_file_list', {}, actor, true);
    expect(listed.ok, listed.error).toBe(true);
    expect(listed.total).toBe(2);
    expect(new Set(listed.transfers?.map((value) => value.id))).toEqual(
      new Set([upload.id, exported.transfer!.id]),
    );
    expect(listed.transfers?.some((value) => value.id === foreign.transfer!.id)).toBe(false);
    for (const row of listed.transfers!) {
      expect(row.rebindRequired).toBe(false);
      expect(row.filesPreview.length).toBeLessThanOrEqual(3);
      expect(Object.hasOwn(row, 'binding')).toBe(false);
      expect(Object.hasOwn(row, 'parameters')).toBe(false);
    }
    const first = await f.call('fusion_file_list', { offset: 0, limit: 1 }, actor, true);
    expect(first.transfers).toHaveLength(1);
    expect(first.nextOffset).toBe(1);
    const last = await f.call('fusion_file_list', { offset: 1, limit: 1 }, actor, true);
    expect(last.transfers).toHaveLength(1);
    expect(last.nextOffset).toBeNull();
    expect((await f.call('fusion_file_list', { limit: 101 }, actor, true)).ok).toBe(false);
    expect(
      (
        await f.call(
          'fusion_file_list',
          { owner: other.owner, includeOtherScopes: true },
          actor,
          true,
        )
      ).ok,
    ).toBe(false);
    const reloaded = { ...actor, scope: 'reloaded-lease' };
    expect((await f.call('fusion_file_list', {}, reloaded, true)).total).toBe(0);
    const recoverable = await f.call(
      'fusion_file_list',
      { includeOtherScopes: true },
      reloaded,
      true,
    );
    expect(recoverable.total).toBe(2);
    expect(recoverable.transfers?.every((value) => value.rebindRequired)).toBe(true);
    expect(
      (await f.call('fusion_file_status', { id: upload.id, rebind: true }, reloaded, true)).ok,
    ).toBe(true);
    expect(
      (await f.call('fusion_file_list', {}, reloaded, true)).transfers?.map((value) => value.id),
    ).toEqual([upload.id]);
    expect(f.hardware).not.toHaveBeenCalled();
  });

  it('supports out-of-order chunk retries, cached-name alias, captured destinations and single-use commit after Undo', async () => {
    const f = await setup(),
      project = newProject('Imported left');
    project.presets[0].channels[0].name = 'x'.repeat(CHUNK + 400);
    const bytes = text(JSON.stringify(project)),
      beforeRight = structuredClone(f.workspace.store.getState().documents.right);
    const upload = await f.begin(
      bytes,
      { workflow: 'project', parameters: { target: 'left' } },
      'large.fusion.json',
      true,
    );
    expect(upload.files[0].chunks).toBe(2);
    expect((await f.chunk(upload.id, bytes, 1, true)).ok).toBe(true);
    expect((await f.chunk(upload.id, bytes, 1, true)).ok).toBe(true);
    const status = await f.call('fusion_file_status', { id: upload.id }, actor, true);
    expect(status.transfer?.files[0].missing).toEqual([0]);
    expect((await f.chunk(upload.id, bytes, 0, true)).ok).toBe(true);
    f.workspace.store.getState().choose({ slot: 'right' });
    const committed = await f.call('fusion_file_upload_commit', { id: upload.id }, actor, true);
    expect(committed.ok, committed.error).toBe(true);
    expect(f.operation).toHaveBeenCalledWith('Importing verified files');
    expect(f.workspace.store.getState().documents.left).toEqual(project);
    expect(f.workspace.store.getState().documents.right).toEqual(beforeRight);
    const retry = await f.call('fusion_file_upload_commit', { id: upload.id });
    expect(retry.receipt).toEqual(committed.receipt);
    await f.execute('fusion_history', { action: 'undo' });
    await f.workspace.persistence.flush();
    expect(f.workspace.store.getState().documents.left.name).toBe('Original left');
    expect((await f.call('fusion_file_upload_commit', { id: upload.id })).receipt).toEqual(
      committed.receipt,
    );
    expect(f.workspace.store.getState().documents.left.name).toBe('Original left');
    expect((await f.call('fusion_file_close', { id: upload.id }, actor, true)).closed).toBe(true);
    expect(f.hardware).not.toHaveBeenCalled();
  });

  it('rejects stale revisions and cannot retarget a transfer after it begins', async () => {
    const f = await setup(),
      data = text(JSON.stringify(newProject('Should not import')));
    const upload = await f.begin(data, { workflow: 'project', parameters: { target: 'left' } });
    for (let i = 0; i < upload.files[0].chunks; i++)
      expect((await f.chunk(upload.id, data, i)).ok).toBe(true);
    f.workspace.store.getState().editAt(['right'], (project) => {
      project.name = 'User edit';
    });
    const result = await f.call('fusion_file_upload_commit', { id: upload.id });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/design changed/);
    expect(f.workspace.store.getState().documents.left.name).toBe('Original left');
    expect(f.workspace.store.getState().documents.right.name).toBe('User edit');
    expect((await f.call('fusion_file_upload_commit', { id: upload.id, target: 'right' })).ok).toBe(
      false,
    );
    const stale = await f.call('fusion_file_upload_begin', {
      operation: { workflow: 'project', parameters: { target: 'right' } },
      files: [{ path: 'p.json', bytes: data.length, sha256: digest(data) }],
      expectedRevision: 0,
    });
    expect(stale.ok).toBe(false);
    expect(f.workspace.store.getState().documentRevision).toBe(1);
  });

  it('pages at most 100 manifests and explicitly rebinds only the authenticated owner', async () => {
    const f = await setup();
    const created = await f.call('fusion_file_upload_begin', {
      operation: { workflow: 'folder', parameters: { target: 'left' } },
      files: Array.from({ length: 205 }, (_, i) => ({
        path: `folder/file-${i}.dat`,
        bytes: 0,
        sha256: digest(text('')),
      })),
    });
    expect(created.ok).toBe(true);
    expect(created.transfer?.fileCount).toBe(205);
    expect(created.transfer?.files).toHaveLength(100);
    expect(created.transfer?.nextFileOffset).toBe(100);
    const id = created.transfer!.id;
    const page = await f.call(
      'fusion_file_status',
      { id, fileOffset: 100, limit: 100 },
      actor,
      true,
    );
    expect(page.transfer?.files).toHaveLength(100);
    expect(page.transfer?.nextFileOffset).toBe(200);
    expect((await f.call('fusion_file_status', { id, limit: 101 })).ok).toBe(false);
    expect(
      (await f.call('fusion_file_status', { id, fileOffset: 200 })).transfer?.files,
    ).toHaveLength(5);
    const reloaded = { ...actor, scope: 'new-browser' };
    expect((await f.call('fusion_file_status', { id }, reloaded)).ok).toBe(false);
    expect((await f.call('fusion_file_status', { id, rebind: true }, other)).ok).toBe(false);
    expect((await f.call('fusion_file_status', { id, rebind: true }, reloaded)).ok).toBe(true);
    expect((await f.call('fusion_file_status', { id }, actor)).ok).toBe(false);
    expect((await f.call('fusion_file_close', { id }, reloaded)).ok).toBe(true);
  });

  it('exports an immutable byte-exact snapshot and verifies repeated chunk reads against SHA-256', async () => {
    const f = await setup();
    f.workspace.store.getState().editAt(['left'], (p) => {
      p.presets[0].channels[0].name = 'q'.repeat(CHUNK + 100);
    });
    await f.workspace.persistence.flush();
    const expected = Buffer.from(
      JSON.stringify(f.workspace.store.getState().documents.left, null, 2),
    );
    const output = await f.call(
      'fusion_file_export',
      { operation: { workflow: 'project-json', parameters: { slot: 'left' } } },
      actor,
      true,
    );
    expect(output.ok, output.error).toBe(true);
    const transfer = output.transfer!,
      manifest = transfer.files[0];
    expect(manifest.bytes).toBe(expected.length);
    expect(manifest.sha256).toBe(digest(expected));
    f.workspace.store.getState().editAt(['left'], (p) => {
      p.name = 'Edited after snapshot';
    });
    const parts: Buffer[] = [];
    for (let i = 0; i < manifest.chunks; i++) {
      const result = await f.call(
        'fusion_file_chunk_read',
        { id: transfer.id, fileIndex: 0, chunkIndex: i },
        actor,
        true,
      );
      expect(result.ok, result.error).toBe(true);
      const bytes = Buffer.from(result.base64!, 'base64');
      expect(bytes.length).toBeLessThanOrEqual(CHUNK);
      expect(digest(bytes)).toBe(result.sha256);
      parts.push(bytes);
    }
    expect(Buffer.concat(parts)).toEqual(expected);
    expect(
      await f.call('fusion_file_chunk_read', { id: transfer.id, fileIndex: 0, chunkIndex: 0 }),
    ).toEqual(
      await f.call('fusion_file_chunk_read', { id: transfer.id, fileIndex: 0, chunkIndex: 0 }),
    );
    expect((await f.call('fusion_file_close', { id: transfer.id })).closed).toBe(true);
    expect(f.hardware).not.toHaveBeenCalled();
  });

  it('imports an actual two-million-frame Float64 WAV beyond the old base64 limit into only the bound native destination', async () => {
    const f = await setup(),
      frames = 2_000_000;
    const buffer = new ArrayBuffer(44 + frames * 8),
      view = new DataView(buffer);
    const tag = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
    };
    tag(0, 'RIFF');
    view.setUint32(4, 36 + frames * 8, true);
    tag(8, 'WAVE');
    tag(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 3, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 48000, true);
    view.setUint32(28, 48000 * 8, true);
    view.setUint16(32, 8, true);
    view.setUint16(34, 64, true);
    tag(36, 'data');
    view.setUint32(40, frames * 8, true);
    view.setFloat64(44, 1, true);
    const data = new Uint8Array(buffer);
    expect(data.length).toBe(16_000_044);
    expect(4 * Math.ceil(data.length / 3)).toBeGreaterThan(20e6);
    const originalLeft = structuredClone(f.workspace.store.getState().documents.left),
      originalRight = structuredClone(f.workspace.store.getState().documents.right);
    const upload = await f.begin(
      data,
      {
        workflow: 'measurement-wav',
        parameters: { target: 'right', preset: 2, channel: 3, analysis: 'hfd' },
      },
      'two-million.wav',
    );
    expect(upload.files[0].chunks).toBe(62);
    for (let i = upload.files[0].chunks - 1; i >= 0; i--)
      expect((await f.chunk(upload.id, data, i)).ok).toBe(true);
    const result = await f.call('fusion_file_upload_commit', { id: upload.id });
    expect(result.ok, result.error).toBe(true);
    expect(f.operation).toHaveBeenCalledWith('Importing verified files');
    const state = f.workspace.store.getState(),
      selected = state.documents.right.presets[1].channels[2];
    expect(selected.hfdMeasurement?.sampleRate).toBe(48000);
    expect(selected.measurement?.impulse).toHaveLength(frames);
    expect(
      selected.measurement?.impulse?.every((value, index) => value === (index === 0 ? 1 : 0)),
    ).toBe(true);
    expect(selected.measurement?.hfdMagnitude?.frequency).toHaveLength(1024);
    expect(state.documents.left).toEqual(originalLeft);
    expect(state.documents.right.presets[0]).toEqual(originalRight.presets[0]);
    expect(state.documents.right.presets[2]).toEqual(originalRight.presets[2]);
    expect(state.documents.right.presets[1].channels.slice(0, 2)).toEqual(
      originalRight.presets[1].channels.slice(0, 2),
    );
    expect(
      f.durable.state.documents.right.presets[1].channels[2].measurement?.impulse,
    ).toHaveLength(frames);
    expect(f.hardware).not.toHaveBeenCalled();
  }, 120000);
});
