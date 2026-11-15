import { openDB, type IDBPDatabase } from 'idb';
import {
  parseExecutionPrincipal,
  type ExecutionPrincipal,
  type ToolExecutionContext,
} from './execution-context';

export const FILE_TRANSFER_CHUNK_BYTES = 256 * 1024;
export const FILE_TRANSFER_IDLE_MS = 15 * 60 * 1000;
export const FILE_TRANSFER_LIFETIME_MS = 60 * 60 * 1000;
export const FILE_TRANSFER_MAX_FILE_BYTES = 320e6;
export const FILE_TRANSFER_MAX_TOTAL_BYTES = 640e6;
export type TransferJson =
  null | boolean | number | string | TransferJson[] | { [key: string]: TransferJson };
export interface TransferBinding {
  workflow: string;
  parameters: TransferJson;
  expectedRevision: number;
}
export interface TransferFileManifest {
  path: string;
  bytes: number;
  sha256: string;
}
export interface TransferUpload {
  files: readonly TransferFileManifest[];
  binding: TransferBinding;
}
export interface TransferBlobFile {
  path: string;
  blob: Blob;
}
export interface TransferCommitCallbacks {
  /** Must atomically deduplicate commitId with the durable imported data/receipt. */
  apply(
    binding: TransferBinding,
    files: readonly TransferBlobFile[],
    commitId: string,
  ): Promise<TransferJson>;
  /** Durable receipt lookup; undefined leaves a committing handle ambiguous. */
  lookup(commitId: string): Promise<TransferJson | undefined>;
}
export type TransferState = 'uploading' | 'verifying' | 'ready' | 'committing' | 'committed';
interface StoredFile extends TransferFileManifest {
  chunks: Record<string, string>;
}
export interface FileTransferRecord {
  version: 1;
  id: string;
  owner: string;
  scope: string;
  direction: 'upload' | 'export';
  state: TransferState;
  files: StoredFile[];
  binding?: TransferBinding;
  createdAt: number;
  touchedAt: number;
  expiresAt: number;
  reservedBytes: number;
  commitId: string;
  receipt?: TransferJson;
  lastError?: string;
}
export interface FileTransferTransaction {
  get(id: string): Promise<FileTransferRecord | undefined>;
  list(): Promise<FileTransferRecord[]>;
  put(record: FileTransferRecord): Promise<void>;
  putChunk(id: string, file: number, index: number, bytes: Uint8Array): Promise<void>;
  getChunk(id: string, file: number, index: number): Promise<Uint8Array | undefined>;
  deleteChunks(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}
export interface FileTransferBackend {
  /** Serializable transaction. Await only transaction methods inside action. */
  transaction<T>(action: (tx: FileTransferTransaction) => Promise<T>): Promise<T>;
}
export interface FileTransferStatus {
  id: string;
  direction: 'upload' | 'export';
  state: TransferState;
  files: (TransferFileManifest & { chunks: number; received: number[]; missing: number[] })[];
  binding?: TransferBinding;
  chunkBytes: number;
  totalBytes: number;
  createdAt: number;
  expiresAt: number;
  idleExpiresAt: number;
  commitId: string;
  receipt?: TransferJson;
  lastError?: string;
}

// FIPS 180-4 sections 4.2.2, 5.1.1 and 6.2.2. Constant-memory incremental
// integrity hashing; not a claim of a FIPS-validated cryptographic module.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n));
export class Sha256 {
  private h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private block = new Uint8Array(64);
  private words = new Uint32Array(64);
  private used = 0;
  private size = 0;
  update(bytes: Uint8Array) {
    this.size += bytes.length;
    for (let offset = 0; offset < bytes.length;) {
      const take = Math.min(64 - this.used, bytes.length - offset);
      this.block.set(bytes.subarray(offset, offset + take), this.used);
      this.used += take;
      offset += take;
      if (this.used === 64) {
        this.compress();
        this.used = 0;
      }
    }
    return this;
  }
  private compress() {
    const w = this.words;
    const view = new DataView(this.block.buffer);
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15],
        b = w[i - 2];
      w[i] =
        (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) +
        w[i - 16] +
        (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10)) +
        w[i - 7];
    }
    let [a, b, c, d, e, f, g, h] = this.h;
    for (let i = 0; i < 64; i++) {
      const t1 =
        h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
      const t2 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    for (const [i, value] of [a, b, c, d, e, f, g, h].entries()) this.h[i] += value;
  }
  digest() {
    const bits = this.size * 8;
    this.block[this.used++] = 0x80;
    if (this.used > 56) {
      this.block.fill(0, this.used);
      this.compress();
      this.used = 0;
    }
    this.block.fill(0, this.used, 56);
    const view = new DataView(this.block.buffer);
    view.setUint32(56, Math.floor(bits / 2 ** 32));
    view.setUint32(60, bits >>> 0);
    this.compress();
    return Array.from(this.h, (v) => v.toString(16).padStart(8, '0')).join('');
  }
}
export const sha256TransferBytes = (bytes: Uint8Array) => new Sha256().update(bytes).digest();

const chunkKey = (id: string, file: number, index: number) => `${id}/${file}/${index}`;
export function createIndexedDbFileTransferBackend(): FileTransferBackend {
  let connection: Promise<IDBPDatabase> | undefined;
  const database = () => {
    if (typeof indexedDB === 'undefined')
      return Promise.reject(new Error('IndexedDB is unavailable for staged file transfers'));
    connection ??= openDB('fusion-studio-file-transfers', 1, {
      upgrade(db) {
        db.createObjectStore('transfers', { keyPath: 'id' });
        db.createObjectStore('chunks', { keyPath: 'key' }).createIndex('transfer', 'transfer');
      },
      terminated() {
        connection = undefined;
      },
      blocking() {
        void connection?.then((db) => db.close());
        connection = undefined;
      },
    }).catch((error) => {
      connection = undefined;
      throw error;
    });
    return connection;
  };
  return {
    async transaction(action) {
      const db = await database(),
        transaction = db.transaction(['transfers', 'chunks'], 'readwrite');
      const records = transaction.objectStore('transfers'),
        chunks = transaction.objectStore('chunks');
      const deleteChunks = async (id: string) => {
        const keys = await chunks.index('transfer').getAllKeys(id);
        await Promise.all(keys.map((key) => chunks.delete(key)));
      };
      const tx: FileTransferTransaction = {
        get: async (id) => (await records.get(id)) as FileTransferRecord | undefined,
        list: async () => (await records.getAll()) as FileTransferRecord[],
        put: async (record) => {
          await records.put(record);
        },
        putChunk: async (id, file, index, bytes) => {
          await chunks.put({ key: chunkKey(id, file, index), transfer: id, bytes: bytes.slice() });
        },
        getChunk: async (id, file, index) =>
          (await chunks.get(chunkKey(id, file, index)))?.bytes as Uint8Array | undefined,
        deleteChunks,
        delete: async (id) => {
          await deleteChunks(id);
          await records.delete(id);
        },
      };
      try {
        const value = await action(tx);
        await transaction.done;
        return value;
      } catch (error) {
        try {
          transaction.abort();
        } catch {}
        await transaction.done.catch(() => {});
        throw error;
      }
    },
  };
}

function jsonClone<T extends TransferJson>(value: T): T {
  const visit = (item: unknown, depth: number): void => {
    if (depth > 32) throw new Error('Transfer metadata nesting is too deep');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) {
      item.forEach((v) => visit(v, depth + 1));
      return;
    }
    if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      Object.values(item).forEach((v) => visit(v, depth + 1));
      return;
    }
    throw new Error('Transfer metadata must be finite JSON data');
  };
  visit(value, 0);
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > 65536)
    throw new Error('Transfer metadata exceeds 64 KiB');
  return JSON.parse(text) as T;
}
function bindingCopy(binding: TransferBinding): TransferBinding {
  if (
    !binding ||
    typeof binding.workflow !== 'string' ||
    !binding.workflow ||
    binding.workflow.length > 100 ||
    !Number.isSafeInteger(binding.expectedRevision) ||
    binding.expectedRevision < 0 ||
    Object.keys(binding).some((k) => !['workflow', 'parameters', 'expectedRevision'].includes(k))
  )
    throw new Error('Invalid immutable file workflow binding');
  return {
    workflow: binding.workflow,
    expectedRevision: binding.expectedRevision,
    parameters: jsonClone(binding.parameters),
  };
}
function manifests(
  files: readonly TransferFileManifest[],
  maxFileBytes: number,
  maxTransferBytes: number,
  allowPendingHash = false,
) {
  if (!Array.isArray(files) || !files.length || files.length > 2000)
    throw new Error('Transfer requires 1–2000 files');
  const paths = new Set<string>();
  const copied = files.map((file) => {
    if (
      !file ||
      typeof file.path !== 'string' ||
      !file.path ||
      new TextEncoder().encode(file.path).byteLength > 1024 ||
      /[\u0000-\u001f\u007f:]/.test(file.path) ||
      /(^|[\\/])(?:\.|\.\.)([\\/]|$)|^[\\/]/.test(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > maxFileBytes ||
      (!(allowPendingHash && file.sha256 === '') && !/^[a-f\d]{64}$/i.test(file.sha256))
    )
      throw new Error('Invalid transfer file path, byte length, or SHA-256');
    const path = file.path.replaceAll('\\', '/'),
      key = path.toLowerCase();
    if (paths.has(key)) throw new Error('Duplicate transfer file path');
    paths.add(key);
    return {
      path,
      bytes: file.bytes,
      sha256: file.sha256.toLowerCase(),
      chunks: {},
    } satisfies StoredFile;
  });
  if (copied.reduce((n, f) => n + f.bytes, 0) > maxTransferBytes)
    throw new Error('Transfer exceeds total byte limit');
  return copied;
}
const countChunks = (file: TransferFileManifest) =>
  Math.ceil(file.bytes / FILE_TRANSFER_CHUNK_BYTES);
const chunkLength = (file: TransferFileManifest, index: number) =>
  Math.min(FILE_TRANSFER_CHUNK_BYTES, file.bytes - index * FILE_TRANSFER_CHUNK_BYTES);
const expired = (record: FileTransferRecord, now: number) =>
  now >= record.expiresAt || now >= record.touchedAt + FILE_TRANSFER_IDLE_MS;
const principal = (context: ToolExecutionContext | ExecutionPrincipal) => {
  if ('signal' in context && context.signal?.aborted)
    throw new Error('File transfer request was aborted');
  return parseExecutionPrincipal({ owner: context.owner, scope: context.scope });
};
const decodeBase64 = (text: string) => {
  if (
    typeof text !== 'string' ||
    text.length > Math.ceil(FILE_TRANSFER_CHUNK_BYTES / 3) * 4 ||
    text.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
  )
    throw new Error('Invalid or oversized base64 chunk');
  const decoded = atob(text);
  return Uint8Array.from(decoded, (c) => c.charCodeAt(0));
};
const encodeBase64 = (bytes: Uint8Array) => {
  let text = '';
  for (let start = 0; start < bytes.length; start += 8192)
    text += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(text);
};

export function createFileTransfers(
  options: {
    backend?: FileTransferBackend;
    now?: () => number;
    randomId?: () => string;
    quotaBytes?: number;
    maxTransfers?: number;
    maxFileBytes?: number;
    maxTransferBytes?: number;
  } = {},
) {
  const backend = options.backend ?? createIndexedDbFileTransferBackend();
  const now = options.now ?? Date.now,
    randomId = options.randomId ?? (() => crypto.randomUUID());
  const quota = options.quotaBytes ?? 1024 * 1024 * 1024,
    maxTransfers = options.maxTransfers ?? 8;
  const maxFileBytes = options.maxFileBytes ?? FILE_TRANSFER_MAX_FILE_BYTES,
    maxTransferBytes = options.maxTransferBytes ?? FILE_TRANSFER_MAX_TOTAL_BYTES;
  if (
    !Number.isSafeInteger(quota) ||
    quota < 1 ||
    !Number.isInteger(maxTransfers) ||
    maxTransfers < 1 ||
    !Number.isSafeInteger(maxFileBytes) ||
    maxFileBytes < 1 ||
    !Number.isSafeInteger(maxTransferBytes) ||
    maxTransferBytes < 1
  )
    throw new Error('Invalid file transfer quota');
  const activeCommits = new Map<string, Promise<TransferJson>>();
  const activeSeals = new Map<string, Promise<FileTransferStatus>>();
  const cleanup = async (tx: FileTransferTransaction) => {
    for (const record of await tx.list()) if (expired(record, now())) await tx.delete(record.id);
  };
  const get = async (
    tx: FileTransferTransaction,
    context: ExecutionPrincipal,
    id: string,
    allowRebind = false,
  ) => {
    const record = await tx.get(id);
    if (
      !record ||
      record.owner !== context.owner ||
      (!allowRebind && record.scope !== context.scope) ||
      expired(record, now())
    )
      throw new Error(
        'File transfer is unavailable, expired, or belongs to another execution scope',
      );
    return record;
  };
  const touch = async (tx: FileTransferTransaction, record: FileTransferRecord) => {
    record.touchedAt = now();
    await tx.put(record);
  };
  const view = (record: FileTransferRecord): FileTransferStatus => ({
    id: record.id,
    direction: record.direction,
    state: record.state,
    files: record.files.map(({ path, bytes, sha256, chunks }) => {
      const received = Object.keys(chunks)
        .map(Number)
        .sort((a, b) => a - b);
      return {
        path,
        bytes,
        sha256,
        chunks: Math.ceil(bytes / FILE_TRANSFER_CHUNK_BYTES),
        received,
        missing: Array.from(
          { length: Math.ceil(bytes / FILE_TRANSFER_CHUNK_BYTES) },
          (_, i) => i,
        ).filter((i) => !Object.hasOwn(chunks, String(i))),
      };
    }),
    ...(record.binding ? { binding: structuredClone(record.binding) } : {}),
    chunkBytes: FILE_TRANSFER_CHUNK_BYTES,
    totalBytes: record.files.reduce((n, f) => n + f.bytes, 0),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    idleExpiresAt: Math.min(record.expiresAt, record.touchedAt + FILE_TRANSFER_IDLE_MS),
    commitId: record.commitId,
    ...(record.receipt === undefined ? {} : { receipt: structuredClone(record.receipt) }),
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
  });
  const begin = async (
    context: ExecutionPrincipal,
    files: StoredFile[],
    direction: 'upload' | 'export',
    binding?: TransferBinding,
  ) => {
    return backend.transaction(async (tx) => {
      await cleanup(tx);
      const owned = (await tx.list()).filter((r) => r.owner === context.owner);
      const bytes = files.reduce((n, f) => n + f.bytes, 0);
      if (
        owned.length >= maxTransfers ||
        owned.reduce((n, r) => n + r.reservedBytes, 0) + bytes > quota
      )
        throw new Error('File transfer quota exceeded; close or abort existing transfers');
      const id = randomId();
      if (!id || id.length > 200 || (await tx.get(id)))
        throw new Error('Invalid or duplicate transfer identifier');
      const createdAt = now();
      const record: FileTransferRecord = {
        version: 1,
        id,
        ...context,
        direction,
        state: 'uploading',
        files,
        ...(binding ? { binding } : {}),
        createdAt,
        touchedAt: createdAt,
        expiresAt: createdAt + FILE_TRANSFER_LIFETIME_MS,
        reservedBytes: bytes,
        commitId: `${context.owner}:${id}`,
      };
      await tx.put(record);
      return view(record);
    });
  };
  const readBytes = async (
    context: ExecutionPrincipal,
    id: string,
    fileIndex: number,
    chunkIndex: number,
  ) => {
    return backend.transaction(async (tx) => {
      const record = await get(tx, context, id),
        file = record.files[fileIndex];
      if (
        !file ||
        !Number.isInteger(chunkIndex) ||
        chunkIndex < 0 ||
        chunkIndex >= countChunks(file)
      )
        throw new Error('Invalid transfer chunk index');
      const bytes = await tx.getChunk(id, fileIndex, chunkIndex);
      if (!bytes || bytes.length !== chunkLength(file, chunkIndex))
        throw new Error('Staged file chunk is missing or corrupt');
      await touch(tx, record);
      return { bytes: bytes.slice(), hash: file.chunks[String(chunkIndex)] };
    });
  };
  const writeBytes = async (
    context: ExecutionPrincipal,
    id: string,
    fileIndex: number,
    chunkIndex: number,
    bytes: Uint8Array,
    hash: string,
    exporting = false,
  ) => {
    return backend.transaction(async (tx) => {
      const record = await get(tx, context, id),
        file = record.files[fileIndex];
      if (record.state !== 'uploading' || (record.direction === 'export') !== exporting)
        throw new Error('Transfer no longer accepts chunks');
      if (
        !Number.isInteger(fileIndex) ||
        !file ||
        !Number.isInteger(chunkIndex) ||
        chunkIndex < 0 ||
        chunkIndex >= countChunks(file) ||
        bytes.length !== chunkLength(file, chunkIndex)
      )
        throw new Error('Chunk length/index does not match the immutable manifest');
      const previous = file.chunks[String(chunkIndex)];
      if (previous && previous !== hash) throw new Error('Conflicting duplicate chunk');
      if (!previous) {
        await tx.putChunk(id, fileIndex, chunkIndex, bytes);
        file.chunks[String(chunkIndex)] = hash;
      }
      await touch(tx, record);
      return view(record);
    });
  };
  const status = async (context: ToolExecutionContext, id: string) => {
    const p = principal(context);
    // Commit garbage collection before an expired/missing handle throws; doing
    // both in one transaction would roll the cleanup back with that error.
    await backend.transaction(cleanup);
    return backend.transaction(async (tx) => {
      const record = await get(tx, p, id);
      await touch(tx, record);
      return view(record);
    });
  };
  const seal = async (context: ExecutionPrincipal, id: string, exporting = false) => {
    await backend.transaction(async (tx) => {
      const record = await get(tx, context, id);
      if (record.state === 'ready') return;
      if (
        !['uploading', 'verifying'].includes(record.state) ||
        (record.direction === 'export') !== exporting
      )
        throw new Error('Transfer cannot be sealed');
      if (record.files.some((f) => Object.keys(f.chunks).length !== countChunks(f)))
        throw new Error('Transfer has missing chunks');
      record.state = 'verifying';
      await touch(tx, record);
    });
    const record = await backend.transaction((tx) => get(tx, context, id));
    if (record.state === 'ready') return view(record);
    try {
      for (let f = 0; f < record.files.length; f++) {
        const hash = new Sha256();
        for (let i = 0; i < countChunks(record.files[f]); i++) {
          const chunk = await readBytes(context, id, f, i);
          if (sha256TransferBytes(chunk.bytes) !== chunk.hash)
            throw new Error('Staged chunk SHA-256 verification failed');
          hash.update(chunk.bytes);
        }
        if (hash.digest() !== record.files[f].sha256)
          throw new Error('Whole-file SHA-256 verification failed');
      }
      return backend.transaction(async (tx) => {
        const current = await get(tx, context, id);
        if (current.state === 'verifying') {
          current.state = 'ready';
          delete current.lastError;
          await touch(tx, current);
        }
        return view(current);
      });
    } catch (error) {
      const completed = await backend.transaction(async (tx) => {
        const current = await get(tx, context, id);
        if (['ready', 'committing', 'committed'].includes(current.state)) return view(current);
        if (current.state === 'verifying') {
          current.state = 'uploading';
          current.lastError = String(error);
          await touch(tx, current);
        }
        return undefined;
      });
      if (completed) return completed;
      throw error;
    }
  };
  const close = async (context: ToolExecutionContext, id: string) => {
    const p = principal(context);
    return backend.transaction(async (tx) => {
      const record = await get(tx, p, id);
      await tx.delete(id);
      return {
        closed: true as const,
        ...(record.state === 'committing' ? { commitOutcomeUnknown: true } : {}),
      };
    });
  };
  return {
    beginUpload: async (context: ToolExecutionContext, input: TransferUpload) =>
      begin(
        principal(context),
        manifests(input.files, maxFileBytes, maxTransferBytes),
        'upload',
        bindingCopy(input.binding),
      ),
    async putChunk(
      context: ToolExecutionContext,
      id: string,
      fileIndex: number,
      chunkIndex: number,
      base64: string,
      sha256: string,
    ) {
      const p = principal(context),
        bytes = decodeBase64(base64),
        hash = sha256TransferBytes(bytes);
      if (
        typeof sha256 !== 'string' ||
        !/^[a-f\d]{64}$/i.test(sha256) ||
        hash !== sha256.toLowerCase()
      )
        throw new Error('Chunk SHA-256 verification failed');
      return writeBytes(p, id, fileIndex, chunkIndex, bytes, hash);
    },
    status,
    async list(context: ToolExecutionContext, options: { includeOtherScopes?: boolean } = {}) {
      const p = principal(context);
      if (
        !options ||
        typeof options !== 'object' ||
        Array.isArray(options) ||
        Object.keys(options).some((key) => key !== 'includeOtherScopes') ||
        (options.includeOtherScopes !== undefined &&
          typeof options.includeOtherScopes !== 'boolean')
      )
        throw new Error('Invalid transfer discovery options');
      await backend.transaction(cleanup);
      return backend.transaction(async (tx) =>
        (await tx.list())
          .filter(
            (record) =>
              record.owner === p.owner &&
              (options.includeOtherScopes === true || record.scope === p.scope),
          )
          .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
          .map((record) => ({ ...view(record), rebindRequired: record.scope !== p.scope })),
      );
    },
    async rebind(context: ToolExecutionContext, id: string) {
      const p = principal(context);
      return backend.transaction(async (tx) => {
        const record = await get(tx, p, id, true);
        record.scope = p.scope;
        await touch(tx, record);
        return view(record);
      });
    },
    async sealUpload(context: ToolExecutionContext, id: string) {
      const p = principal(context);
      // Authenticate even when another call has already started verification.
      await backend.transaction((tx) => get(tx, p, id));
      const key = `${p.owner}\n${p.scope}\n${id}`;
      let work = activeSeals.get(key);
      if (!work) {
        work = seal(p, id).finally(() => activeSeals.delete(key));
        activeSeals.set(key, work);
      }
      return work;
    },
    async commit(
      context: ToolExecutionContext,
      id: string,
      callbacks: TransferCommitCallbacks,
    ): Promise<TransferJson> {
      const p = principal(context);
      const record = await backend.transaction((tx) => get(tx, p, id));
      const key = `${p.owner}\n${id}`;
      const active = activeCommits.get(key);
      if (active) return active;
      const run = async () => {
        const claimed = await backend.transaction(async (tx) => {
          const current = await get(tx, p, id);
          if (current.direction !== 'upload' || !current.binding)
            throw new Error('Only a sealed upload can be committed');
          if (current.state === 'committed') return { record: current, recover: true };
          if (current.state === 'committing') return { record: current, recover: true };
          if (current.state !== 'ready')
            throw new Error('Seal and verify the upload before committing');
          current.state = 'committing';
          await touch(tx, current);
          return { record: current, recover: false };
        });
        if (claimed.record.state === 'committed') return structuredClone(claimed.record.receipt!);
        try {
          let receipt = claimed.recover
            ? await callbacks.lookup(claimed.record.commitId)
            : undefined;
          if (claimed.recover && receipt === undefined)
            throw new Error(
              'Transfer commit outcome is ambiguous; no durable receipt exists. Inspect the workspace, then abort or start a new transfer; this handle will not apply again.',
            );
          if (receipt === undefined) {
            const files: TransferBlobFile[] = [];
            for (let f = 0; f < claimed.record.files.length; f++) {
              const parts: ArrayBuffer[] = [];
              for (let i = 0; i < countChunks(claimed.record.files[f]); i++) {
                const chunk = await readBytes(p, id, f, i);
                if (sha256TransferBytes(chunk.bytes) !== chunk.hash)
                  throw new Error('Staged chunk changed after verification');
                parts.push(chunk.bytes.buffer as ArrayBuffer);
              }
              files.push({ path: claimed.record.files[f].path, blob: new Blob(parts) });
            }
            receipt = await callbacks.apply(
              structuredClone(claimed.record.binding!),
              files,
              claimed.record.commitId,
            );
          }
          const copied = jsonClone(receipt);
          await backend.transaction(async (tx) => {
            const current = await tx.get(id);
            if (!current || current.owner !== p.owner)
              throw new Error(
                'Committed transfer metadata is unavailable; recover the durable workspace receipt',
              );
            current.state = 'committed';
            current.receipt = copied;
            current.reservedBytes = 0;
            delete current.lastError;
            await tx.deleteChunks(id);
            await touch(tx, current);
          });
          return structuredClone(copied);
        } catch (error) {
          await backend.transaction(async (tx) => {
            const current = await tx.get(id);
            if (current?.owner === p.owner && current.state === 'committing') {
              current.lastError = error instanceof Error ? error.message : String(error);
              await touch(tx, current);
            }
          });
          throw error;
        }
      };
      const work = run().finally(() => activeCommits.delete(key));
      activeCommits.set(key, work);
      return work;
    },
    async createExport(
      context: ToolExecutionContext,
      files: readonly TransferBlobFile[],
      binding?: TransferBinding,
    ) {
      const p = principal(context);
      if (!Array.isArray(files) || files.length > 2000) throw new Error('Invalid export file list');
      const sources = files.map((file) => ({ path: file.path, blob: file.blob }));
      const upload = await begin(
        p,
        manifests(
          sources.map((f) => ({ path: f.path, bytes: f.blob.size, sha256: '' })),
          maxFileBytes,
          maxTransferBytes,
          true,
        ),
        'export',
        binding ? bindingCopy(binding) : undefined,
      );
      try {
        for (let f = 0; f < sources.length; f++) {
          const hash = new Sha256();
          for (let i = 0; i < countChunks(upload.files[f]); i++) {
            const bytes = new Uint8Array(
              await sources[f].blob
                .slice(i * FILE_TRANSFER_CHUNK_BYTES, (i + 1) * FILE_TRANSFER_CHUNK_BYTES)
                .arrayBuffer(),
            );
            hash.update(bytes);
            await writeBytes(p, upload.id, f, i, bytes, sha256TransferBytes(bytes), true);
          }
          const digest = hash.digest();
          await backend.transaction(async (tx) => {
            const current = await get(tx, p, upload.id);
            current.files[f].sha256 = digest;
            await touch(tx, current);
          });
        }
        return await seal(p, upload.id, true);
      } catch (error) {
        await backend.transaction((tx) => tx.delete(upload.id));
        throw error;
      }
    },
    async readChunk(
      context: ToolExecutionContext,
      id: string,
      fileIndex: number,
      chunkIndex: number,
    ) {
      const p = principal(context);
      await backend.transaction(async (tx) => {
        const record = await get(tx, p, id);
        if (record.direction !== 'export' || record.state !== 'ready')
          throw new Error('Export is not ready');
      });
      const chunk = await readBytes(p, id, fileIndex, chunkIndex);
      if (sha256TransferBytes(chunk.bytes) !== chunk.hash)
        throw new Error('Export chunk SHA-256 verification failed');
      return {
        fileIndex,
        chunkIndex,
        bytes: chunk.bytes.length,
        base64: encodeBase64(chunk.bytes),
        sha256: chunk.hash,
      };
    },
    close,
  };
}
export type FileTransfers = ReturnType<typeof createFileTransfers>;
