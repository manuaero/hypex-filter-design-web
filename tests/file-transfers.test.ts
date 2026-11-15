import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createFileTransfers,
  createIndexedDbFileTransferBackend,
  sha256TransferBytes,
  FILE_TRANSFER_CHUNK_BYTES as CHUNK,
  FILE_TRANSFER_IDLE_MS as IDLE,
  FILE_TRANSFER_LIFETIME_MS as LIFE,
  type FileTransferBackend,
  type FileTransferRecord,
  type FileTransferTransaction,
  type TransferBinding,
  type TransferCommitCallbacks,
  type TransferJson,
} from '../src/application/file-transfers';

const owner = { owner: 'site:alice', scope: 'lease-a' };
const other = { owner: 'site:bob', scope: 'lease-b' };
const binding: TransferBinding = {
  workflow: 'measurement',
  parameters: { slot: 'left', channel: 1 },
  expectedRevision: 4,
};
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const bytes = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 29 + 7) % 251);
function memory() {
  let records = new Map<string, FileTransferRecord>(),
    chunks = new Map<string, Uint8Array>();
  let tail: Promise<unknown> = Promise.resolve();
  let writes = 0,
    failCommitted = false;
  const key = (id: string, file: number, index: number) => `${id}/${file}/${index}`;
  const backend: FileTransferBackend = {
    transaction<T>(action: (tx: FileTransferTransaction) => Promise<T>): Promise<T> {
      const work = tail.then(async () => {
        const nextRecords = structuredClone(records),
          nextChunks = structuredClone(chunks);
        const tx: FileTransferTransaction = {
          get: async (id) => structuredClone(nextRecords.get(id)),
          list: async () => structuredClone([...nextRecords.values()]),
          put: async (record) => {
            if (failCommitted && record.state === 'committed')
              throw Error('Disk write failed after apply');
            nextRecords.set(record.id, structuredClone(record));
          },
          putChunk: async (id, file, index, value) => {
            writes++;
            nextChunks.set(key(id, file, index), new Uint8Array(value));
          },
          getChunk: async (id, file, index) => nextChunks.get(key(id, file, index))?.slice(),
          deleteChunks: async (id) => {
            for (const k of nextChunks.keys()) if (k.startsWith(`${id}/`)) nextChunks.delete(k);
          },
          delete: async (id) => {
            nextRecords.delete(id);
            for (const k of nextChunks.keys()) if (k.startsWith(`${id}/`)) nextChunks.delete(k);
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
  return {
    backend,
    get records() {
      return records;
    },
    get chunks() {
      return chunks;
    },
    get writes() {
      return writes;
    },
    set failCommitted(value: boolean) {
      failCommitted = value;
    },
    corrupt(id: string, file: number, index: number) {
      const data = chunks.get(key(id, file, index))!;
      data[0] ^= 1;
    },
  };
}
function fixture(settings: Parameters<typeof createFileTransfers>[0] = {}) {
  const disk = memory();
  let clock = 0,
    id = 0;
  const manager = createFileTransfers({
    backend: disk.backend,
    now: () => clock,
    randomId: () => `transfer-${++id}`,
    ...settings,
  });
  return {
    disk,
    manager,
    get now() {
      return clock;
    },
    set now(value: number) {
      clock = value;
    },
  };
}
async function begin(
  manager: ReturnType<typeof createFileTransfers>,
  data: Uint8Array,
  sha = hash(data),
) {
  return manager.beginUpload(owner, {
    files: [{ path: 'driver.dat', bytes: data.length, sha256: sha }],
    binding,
  });
}
async function put(
  manager: ReturnType<typeof createFileTransfers>,
  id: string,
  data: Uint8Array,
  index = 0,
) {
  const part = data.subarray(index * CHUNK, (index + 1) * CHUNK);
  return manager.putChunk(owner, id, 0, index, base64(part), hash(part));
}
async function sealed(manager: ReturnType<typeof createFileTransfers>, data = bytes(3)) {
  const record = await begin(manager, data);
  for (let i = 0; i < Math.ceil(data.length / CHUNK); i++) await put(manager, record.id, data, i);
  await manager.sealUpload(owner, record.id);
  return record;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('bounded incremental transfer hashing', () => {
  it.each([0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 1000000])(
    'matches independent SHA-256 at padding boundary %s',
    (length) => {
      const data = bytes(length);
      expect(sha256TransferBytes(data)).toBe(hash(data));
    },
  );
  it('matches the published abc vector', () => {
    expect(sha256TransferBytes(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('browser-owned file transfers', () => {
  it('discovers lost handles only for the owner/current scope and can explicitly discover scopes to rebind', async () => {
    const f = fixture(),
      data = bytes(1),
      old = await begin(f.manager, data);
    await put(f.manager, old.id, data);
    const foreign = await f.manager.createExport(other, [
      { path: 'private.txt', blob: new Blob([data]) },
    ]);
    const reloaded = { ...owner, scope: 'reloaded' };
    const current = await f.manager.beginUpload(reloaded, {
      binding,
      files: [{ path: 'new.dat', bytes: 1, sha256: hash(data) }],
    });
    expect((await f.manager.list(owner)).map((value) => value.id)).toEqual([old.id]);
    expect((await f.manager.list(reloaded)).map((value) => value.id)).toEqual([current.id]);
    const recoverable = await f.manager.list(reloaded, { includeOtherScopes: true });
    expect(new Set(recoverable.map((value) => value.id))).toEqual(new Set([old.id, current.id]));
    expect(recoverable.find((value) => value.id === old.id)?.rebindRequired).toBe(true);
    expect(recoverable.some((value) => value.id === foreign.id)).toBe(false);
    expect(JSON.stringify(recoverable)).not.toContain(other.owner);
    recoverable[0].files[0].path = 'mutated response';
    expect((await f.manager.status(owner, old.id)).files[0].path).toBe('driver.dat');
    await f.manager.rebind(reloaded, old.id);
    expect((await f.manager.list(reloaded)).every((value) => !value.rebindRequired)).toBe(true);
    f.now = IDLE;
    expect(await f.manager.list(reloaded, { includeOtherScopes: true })).toEqual([]);
    expect(f.disk.records.size).toBe(0);
    expect(f.disk.chunks.size).toBe(0);
  });
  it('resumes out-of-order chunks across manager instances and verifies full multi-chunk bytes', async () => {
    const f = fixture(),
      data = bytes(CHUNK * 3 + 17);
    const upload = await begin(f.manager, data);
    await put(f.manager, upload.id, data, 3);
    await put(f.manager, upload.id, data, 0);
    const second = createFileTransfers({ backend: f.disk.backend, now: () => f.now });
    expect((await second.status(owner, upload.id)).files[0]).toMatchObject({
      received: [0, 3],
      missing: [1, 2],
    });
    await put(second, upload.id, data, 2);
    await put(second, upload.id, data, 1);
    expect((await second.sealUpload(owner, upload.id)).state).toBe('ready');
    let applied = 0;
    const receipt = await second.commit(owner, upload.id, {
      lookup: async () => undefined,
      apply: async (actual, files, commitId) => {
        applied++;
        expect(actual).toEqual(binding);
        expect(commitId).toBe(upload.commitId);
        expect(new Uint8Array(await files[0].blob.arrayBuffer())).toEqual(data);
        return { ok: true, revision: 5 };
      },
    });
    expect(receipt).toEqual({ ok: true, revision: 5 });
    expect(applied).toBe(1);
    expect(f.disk.chunks.size).toBe(0);
    expect((await second.status(owner, upload.id)).state).toBe('committed');
    expect(
      await second.commit(owner, upload.id, {
        lookup: async () => undefined,
        apply: async () => {
          throw Error('must not repeat');
        },
      }),
    ).toEqual(receipt);
  });

  it('accepts identical duplicates without rewriting and rejects conflicting bytes without replacing originals', async () => {
    const { manager, disk } = fixture(),
      data = bytes(5),
      upload = await begin(manager, data);
    await put(manager, upload.id, data);
    const writes = disk.writes;
    await put(manager, upload.id, data);
    expect(disk.writes).toBe(writes);
    const conflict = data.slice();
    conflict[0] ^= 1;
    await expect(put(manager, upload.id, conflict)).rejects.toThrow('Conflicting');
    await expect(manager.sealUpload(owner, upload.id)).resolves.toMatchObject({ state: 'ready' });
  });

  it('rejects missing, oversized, misindexed and bad-hash chunks before accepting them', async () => {
    const { manager, disk } = fixture(),
      data = bytes(CHUNK + 4),
      upload = await begin(manager, data);
    await expect(manager.sealUpload(owner, upload.id)).rejects.toThrow('missing');
    await expect(
      manager.putChunk(owner, upload.id, 0, 0, base64(data), '0'.repeat(64)),
    ).rejects.toThrow();
    await expect(
      manager.putChunk(
        owner,
        upload.id,
        0,
        0,
        base64(data.subarray(0, 4)),
        hash(data.subarray(0, 4)),
      ),
    ).rejects.toThrow('length/index');
    await expect(
      manager.putChunk(owner, upload.id, 0, 2, base64(bytes(4)), hash(bytes(4))),
    ).rejects.toThrow('length/index');
    await expect(manager.putChunk(owner, upload.id, 0, 0, '%%%=', hash(bytes(1)))).rejects.toThrow(
      'base64',
    );
    expect(disk.chunks.size).toBe(0);
  });

  it('fails full-file and durable readback hashes without applying or pretending the data is ready', async () => {
    const f = fixture(),
      data = bytes(17),
      upload = await begin(f.manager, data, '0'.repeat(64));
    await put(f.manager, upload.id, data);
    await expect(f.manager.sealUpload(owner, upload.id)).rejects.toThrow('Whole-file');
    expect((await f.manager.status(owner, upload.id)).state).toBe('uploading');
    const good = await begin(f.manager, data);
    await put(f.manager, good.id, data);
    f.disk.corrupt(good.id, 0, 0);
    await expect(f.manager.sealUpload(owner, good.id)).rejects.toThrow('chunk SHA-256');
    expect((await f.manager.status(owner, good.id)).state).toBe('uploading');
  });

  it('binds owner/scope and explicitly rebinds a surviving transfer only for its authenticated owner', async () => {
    const { manager } = fixture(),
      upload = await begin(manager, bytes(1));
    await expect(manager.status(other, upload.id)).rejects.toThrow('another execution scope');
    const reloaded = { ...owner, scope: 'new-lease' };
    await expect(manager.status(reloaded, upload.id)).rejects.toThrow();
    await expect(manager.rebind(other, upload.id)).rejects.toThrow();
    expect((await manager.rebind(reloaded, upload.id)).id).toBe(upload.id);
    await expect(manager.status(owner, upload.id)).rejects.toThrow();
    await expect(manager.close(reloaded, upload.id)).resolves.toMatchObject({ closed: true });
  });

  it('extends idle activity without extending absolute expiry and cleans abandoned chunks', async () => {
    const f = fixture(),
      data = bytes(2),
      upload = await begin(f.manager, data);
    await put(f.manager, upload.id, data);
    f.now = IDLE - 1;
    expect((await f.manager.status(owner, upload.id)).idleExpiresAt).toBe(2 * IDLE - 1);
    f.now = 2 * IDLE - 1;
    await expect(f.manager.status(owner, upload.id)).rejects.toThrow('expired');
    expect(f.disk.chunks.size).toBe(0);
    f.now = 0;
    const another = await begin(f.manager, data);
    for (let t = 10 * 60 * 1000; t < LIFE; t += 10 * 60 * 1000) {
      f.now = t;
      await f.manager.status(owner, another.id);
    }
    f.now = LIFE;
    await expect(f.manager.rebind({ ...owner, scope: 'new' }, another.id)).rejects.toThrow(
      'expired',
    );
  });

  it('atomically reserves declared-byte/count quotas and frees them on abort or expiry', async () => {
    const f = fixture({ quotaBytes: 10, maxTransfers: 2, maxFileBytes: 8, maxTransferBytes: 10 });
    const one = await begin(f.manager, bytes(6));
    await expect(begin(f.manager, bytes(6))).rejects.toThrow('quota');
    await f.manager.close(owner, one.id);
    const two = await begin(f.manager, bytes(6));
    await expect(begin(f.manager, bytes(9))).rejects.toThrow('Invalid transfer');
    await expect(
      f.manager.beginUpload(owner, {
        binding,
        files: [
          { path: 'a', bytes: 6, sha256: hash(bytes(6)) },
          { path: 'b', bytes: 5, sha256: hash(bytes(5)) },
        ],
      }),
    ).rejects.toThrow('total');
    f.now = IDLE;
    const three = await begin(f.manager, bytes(6));
    expect(three.id).not.toBe(two.id);
    expect(f.disk.records.size).toBe(1);
  });

  it('serializes concurrent reservations across distinct manager instances', async () => {
    const disk = memory();
    let id = 0;
    const options = { backend: disk.backend, quotaBytes: 8, randomId: () => String(++id) };
    const a = createFileTransfers(options),
      b = createFileTransfers(options);
    const attempts = await Promise.allSettled([begin(a, bytes(6)), begin(b, bytes(6))]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(disk.records.size).toBe(1);
  });

  it('validates safe unique paths and immutable finite metadata', async () => {
    const { manager } = fixture();
    for (const path of ['../a.txt', '/a.txt', 'C:\\a.txt', 'a/./b', 'a\u0000b'])
      await expect(
        manager.beginUpload(owner, {
          binding,
          files: [{ path, bytes: 0, sha256: hash(bytes(0)) }],
        }),
      ).rejects.toThrow();
    await expect(
      manager.beginUpload(owner, {
        binding,
        files: [
          { path: 'A.txt', bytes: 0, sha256: hash(bytes(0)) },
          { path: 'a.TXT', bytes: 0, sha256: hash(bytes(0)) },
        ],
      }),
    ).rejects.toThrow('Duplicate');
    const mutable = { ...binding, parameters: { value: 1 } },
      upload = await manager.beginUpload(owner, {
        binding: mutable,
        files: [{ path: 'empty.txt', bytes: 0, sha256: hash(bytes(0)) }],
      });
    mutable.parameters.value = 2;
    expect((await manager.status(owner, upload.id)).binding?.parameters).toEqual({ value: 1 });
    expect((await manager.sealUpload(owner, upload.id)).state).toBe('ready');
    await expect(
      manager.beginUpload(owner, {
        binding: { ...binding, parameters: { value: Infinity } },
        files: [{ path: 'a', bytes: 0, sha256: hash(bytes(0)) }],
      }),
    ).rejects.toThrow('finite JSON');
  });

  it('does not retry an ambiguous commit and recovers a durable receipt after manager-finalization failure', async () => {
    const f = fixture(),
      upload = await sealed(f.manager),
      durable = new Map<string, TransferJson>();
    let applies = 0;
    f.disk.failCommitted = true;
    const callbacks: TransferCommitCallbacks = {
      lookup: async (id) => durable.get(id),
      apply: async (_binding, _files, id) => {
        applies++;
        const receipt = { ok: true, revision: 5 };
        durable.set(id, receipt);
        return receipt;
      },
    };
    await expect(f.manager.commit(owner, upload.id, callbacks)).rejects.toThrow(
      'Disk write failed',
    );
    expect((await f.manager.status(owner, upload.id)).state).toBe('committing');
    f.disk.failCommitted = false;
    // Match the original fake clock so this simulates reload rather than expiry.
    const recovered = createFileTransfers({ backend: f.disk.backend, now: () => f.now });
    expect(await recovered.commit(owner, upload.id, callbacks)).toEqual({ ok: true, revision: 5 });
    expect(applies).toBe(1);
    expect(f.disk.chunks.size).toBe(0);
    const failed = await sealed(f.manager);
    const neverApplied = {
      lookup: async () => undefined,
      apply: async () => {
        applies++;
        throw Error('revision conflict');
      },
    };
    await expect(f.manager.commit(owner, failed.id, neverApplied)).rejects.toThrow(
      'revision conflict',
    );
    await expect(recovered.commit(owner, failed.id, neverApplied)).rejects.toThrow('ambiguous');
    expect(applies).toBe(2);
    expect(await recovered.close(owner, failed.id)).toMatchObject({
      closed: true,
      commitOutcomeUnknown: true,
    });
  });

  it('coalesces local commit calls and prevents a second instance applying an in-progress import', async () => {
    const f = fixture(),
      upload = await sealed(f.manager),
      started = deferred(),
      finish = deferred();
    let applies = 0;
    const callbacks: TransferCommitCallbacks = {
      lookup: async () => undefined,
      apply: async () => {
        applies++;
        started.resolve();
        await finish.promise;
        return { revision: 5 };
      },
    };
    const first = f.manager.commit(owner, upload.id, callbacks);
    await started.promise;
    const duplicate = f.manager.commit(owner, upload.id, callbacks);
    const otherManager = createFileTransfers({ backend: f.disk.backend, now: () => f.now });
    await expect(otherManager.commit(owner, upload.id, callbacks)).rejects.toThrow('ambiguous');
    finish.resolve();
    expect(await first).toEqual({ revision: 5 });
    expect(await duplicate).toEqual({ revision: 5 });
    expect(applies).toBe(1);
  });

  it('reports an unknown outcome when closing an in-flight commit instead of pretending to cancel its durable effect', async () => {
    const f = fixture(),
      upload = await sealed(f.manager),
      started = deferred(),
      finish = deferred();
    let durable: TransferJson | undefined;
    const committing = f.manager.commit(owner, upload.id, {
      lookup: async () => durable,
      apply: async () => {
        started.resolve();
        await finish.promise;
        durable = { revision: 5 };
        return durable;
      },
    });
    await started.promise;
    expect(await f.manager.close(owner, upload.id)).toEqual({
      closed: true,
      commitOutcomeUnknown: true,
    });
    finish.resolve();
    await expect(committing).rejects.toThrow('recover the durable workspace receipt');
    expect(durable).toEqual({ revision: 5 });
    expect(await f.manager.list(owner)).toEqual([]);
  });

  it('exports immutable blobs as bounded repeatable chunks with independent whole-file verification', async () => {
    const { manager } = fixture(),
      data = bytes(CHUNK * 2 + 31);
    const sources = [{ path: 'export.dat', blob: new Blob([data]) }];
    const creating = manager.createExport(owner, sources);
    sources[0] = { path: 'changed.dat', blob: new Blob([bytes(1)]) };
    const output = await creating;
    expect(output.files[0].path).toBe('export.dat');
    expect(output.files[0].sha256).toBe(hash(data));
    const parts: Buffer[] = [];
    for (let i = 0; i < 3; i++) {
      const chunk = await manager.readChunk(owner, output.id, 0, i);
      expect(chunk.bytes).toBeLessThanOrEqual(CHUNK);
      const decoded = Buffer.from(chunk.base64, 'base64');
      expect(hash(decoded)).toBe(chunk.sha256);
      parts.push(decoded);
    }
    expect(Buffer.concat(parts)).toEqual(Buffer.from(data));
    expect(await manager.readChunk(owner, output.id, 0, 0)).toEqual(
      await manager.readChunk(owner, output.id, 0, 0),
    );
    await expect(manager.readChunk(other, output.id, 0, 0)).rejects.toThrow();
    await manager.close(owner, output.id);
    await expect(manager.readChunk(owner, output.id, 0, 0)).rejects.toThrow();
  });

  it('fails honestly when IndexedDB is unavailable and honors already-aborted trusted contexts', async () => {
    vi.stubGlobal('indexedDB', undefined);
    try {
      await expect(
        createIndexedDbFileTransferBackend().transaction(async () => null),
      ).rejects.toThrow('IndexedDB');
    } finally {
      vi.unstubAllGlobals();
    }
    const { manager } = fixture(),
      controller = new AbortController();
    controller.abort();
    await expect(
      manager.beginUpload(
        { ...owner, signal: controller.signal },
        { binding, files: [{ path: 'a', bytes: 0, sha256: hash(bytes(0)) }] },
      ),
    ).rejects.toThrow('aborted');
  });
});
