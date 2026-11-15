import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { DirectoryWriterEnvelope } from '../src/application/project-directory-writer';
const mock = vi.hoisted(() => ({ openDB: vi.fn() }));
vi.mock('idb', () => ({ openDB: mock.openDB }));
import { createIndexedDbDirectoryWriterBackend } from '../src/application/directory-writer-storage';
const empty = (): DirectoryWriterEnvelope => ({
  version: 2,
  revision: 1,
  roots: [],
  associations: {},
  saves: [],
  archives: [],
});
beforeEach(() => {
  mock.openDB.mockReset();
  vi.stubGlobal('indexedDB', {});
});
afterEach(() => vi.unstubAllGlobals());
function fake(durability: 'strict' | 'relaxed' = 'strict') {
  const store = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
  const tx = { durability, store, done: Promise.resolve(), abort: vi.fn() };
  const db = { get: vi.fn(async () => null), transaction: vi.fn(() => tx) };
  mock.openDB.mockResolvedValue(db);
  return { db, tx, store };
}
it('opens database v3 without recreating existing stores and requests strict archive-journal durability', async () => {
  const f = fake(),
    backend = createIndexedDbDirectoryWriterBackend();
  await backend.write(empty(), null);
  expect(mock.openDB.mock.calls[0][0]).toBe('fusion-studio-directory-writes');
  expect(mock.openDB.mock.calls[0][1]).toBe(3);
  const options = mock.openDB.mock.calls[0][2] as { upgrade(db: unknown): void };
  const createObjectStore = vi.fn();
  options.upgrade({ objectStoreNames: { contains: () => true }, createObjectStore });
  expect(createObjectStore).not.toHaveBeenCalled();
  options.upgrade({ objectStoreNames: { contains: () => false }, createObjectStore });
  expect(createObjectStore).toHaveBeenCalledWith('state');
  expect(createObjectStore).toHaveBeenCalledWith('authority');
  expect(f.db.transaction).toHaveBeenCalledWith('state', 'readwrite', { durability: 'strict' });
  expect(f.store.put).toHaveBeenCalledWith(empty(), 'writer');
});
it('fails closed when strict durability is unavailable, without writing metadata or deleting recovery bytes', async () => {
  const f = fake('relaxed'),
    backend = createIndexedDbDirectoryWriterBackend();
  await expect(backend.write(empty(), null)).rejects.toThrow(/Strict/);
  expect(f.store.put).not.toHaveBeenCalled();
  expect(f.tx.abort).toHaveBeenCalledTimes(1);
});
it('compares revision before the archive write and leaves prior data intact on stale CAS', async () => {
  const f = fake(),
    backend = createIndexedDbDirectoryWriterBackend();
  f.store.get.mockResolvedValue({ ...empty(), revision: 3 } as never);
  await expect(backend.write({ ...empty(), revision: 2 }, 1)).rejects.toThrow(/another tab/);
  expect(f.store.put).not.toHaveBeenCalled();
  expect(f.tx.abort).toHaveBeenCalledTimes(1);
});
