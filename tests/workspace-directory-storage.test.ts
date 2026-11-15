import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../src/application/directory-writer-storage', async (original) => ({
  ...(await original<typeof import('../src/application/directory-writer-storage')>()),
  openDirectoryWriterDatabase: mock.open,
}));
import {
  createIndexedDbWorkspaceDirectoryBackend,
  type DirectoryAdoptions,
} from '../src/application/workspace-directory';
const identity = { version: 1, id: '11111111-1111-1111-1111-111111111111' };
beforeEach(() => mock.open.mockReset());
function fixture(relaxed = false) {
  const writer = { opaque: 'writer-state-kept-exact' };
  const state = { get: vi.fn(async () => writer), put: vi.fn() };
  const authority = {
    get: vi.fn(async (key: string) => (key === 'workspace' ? identity : undefined)),
    put: vi.fn(async () => {}),
  };
  const tx = {
    durability: relaxed ? 'relaxed' : 'strict',
    objectStore: vi.fn((name: string) => (name === 'state' ? state : authority)),
    done: Promise.resolve(),
    abort: vi.fn(),
  };
  const database = { transaction: vi.fn(() => tx) };
  mock.open.mockResolvedValue(database);
  return { writer, state, authority, tx, database };
}
it('reads writer and authority/grants from one snapshot transaction without filesystem data reads', async () => {
  const f = fixture(),
    backend = createIndexedDbWorkspaceDirectoryBackend();
  expect(await backend.read()).toEqual({ writer: f.writer, authority: identity, adoptions: null });
  expect(f.database.transaction).toHaveBeenCalledWith(['state', 'authority'], 'readonly');
  expect(f.state.get).toHaveBeenCalledWith('writer');
  expect(f.authority.put).not.toHaveBeenCalled();
});
it('checks the current writer and writes only grants inside a single strict transaction across both stores', async () => {
  const f = fixture(),
    backend = createIndexedDbWorkspaceDirectoryBackend();
  const next: DirectoryAdoptions = { version: 1, revision: 1, grants: [] };
  await backend.update((current) => {
    expect(current.writer).toBe(f.writer);
    expect(current.authority).toBe(identity);
    return next;
  });
  expect(f.database.transaction).toHaveBeenCalledWith(['state', 'authority'], 'readwrite', {
    durability: 'strict',
  });
  expect(f.authority.put).toHaveBeenCalledWith(next, 'directory-adoptions');
  expect(f.state.put).not.toHaveBeenCalled();
});
it('fails closed before grant writes if strict durability is unavailable', async () => {
  const f = fixture(true),
    backend = createIndexedDbWorkspaceDirectoryBackend(),
    change = vi.fn();
  await expect(backend.update(change)).rejects.toThrow(/Strict/);
  expect(change).not.toHaveBeenCalled();
  expect(f.tx.abort).toHaveBeenCalledTimes(1);
  expect(f.authority.put).not.toHaveBeenCalled();
  expect(f.state.put).not.toHaveBeenCalled();
});
it('aborts malformed grants rather than replacing prior grants or writer state', async () => {
  const f = fixture(),
    backend = createIndexedDbWorkspaceDirectoryBackend();
  await expect(
    backend.update(() => ({ version: 1, revision: 1, grants: [{ recordId: 'forged' }] }) as never),
  ).rejects.toThrow();
  expect(f.tx.abort).toHaveBeenCalledTimes(1);
  expect(f.authority.put).not.toHaveBeenCalled();
  expect(f.state.put).not.toHaveBeenCalled();
});
