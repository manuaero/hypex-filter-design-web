import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../src/application/directory-writer-storage', () => ({
  openDirectoryWriterDatabase: mock.open,
}));
import {
  loadOrCreateWorkspaceAuthority,
  parseStoredWorkspaceAuthority,
} from '../src/application/workspace-authority-storage';
function database(initial?: unknown) {
  let value = initial,
    tail = Promise.resolve(),
    puts = 0;
  const transactions: { durability: string; aborted: boolean }[] = [];
  const db = {
    wrongReadback: false,
    relaxed: false,
    transaction: vi.fn((_store: string, _mode: string, _options: unknown) => {
      const before = tail;
      let release!: () => void;
      tail = new Promise<void>((yes) => {
        release = yes;
      });
      const state = { durability: db.relaxed ? 'relaxed' : 'strict', aborted: false };
      transactions.push(state);
      return {
        durability: state.durability,
        store: {
          get: async () => {
            await before;
            return value;
          },
          put: async (next: unknown) => {
            await before;
            puts++;
            value = structuredClone(next);
          },
        },
        get done() {
          release();
          return Promise.resolve();
        },
        abort: () => {
          state.aborted = true;
          release();
        },
      };
    }),
    get: async () =>
      db.wrongReadback ? { version: 1, id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' } : value,
  };
  mock.open.mockResolvedValue(db);
  return {
    db,
    transactions,
    get value() {
      return value;
    },
    get puts() {
      return puts;
    },
  };
}
beforeEach(() => mock.open.mockReset());
it('serializes concurrent first use to one persistent authority and reads it back without subsequent writes', async () => {
  const f = database();
  const [a, b] = await Promise.all([
    loadOrCreateWorkspaceAuthority(),
    loadOrCreateWorkspaceAuthority(),
  ]);
  expect(a).toEqual(b);
  expect(f.puts).toBe(1);
  expect(Object.isFrozen(a)).toBe(true);
  expect(await loadOrCreateWorkspaceAuthority()).toEqual(a);
  expect(f.puts).toBe(1);
  expect(f.db.transaction).toHaveBeenCalledWith('authority', 'readwrite', { durability: 'strict' });
});
it.each([
  null,
  {},
  { version: 1, id: 'bad' },
  { version: 2, id: '11111111-1111-1111-1111-111111111111' },
  { version: 1, id: '11111111-1111-1111-1111-111111111111', extra: true },
])('never replaces invalid existing authority %j', async (value) => {
  const f = database(value);
  await expect(loadOrCreateWorkspaceAuthority()).rejects.toThrow(/invalid/);
  expect(f.value).toEqual(value);
  expect(f.puts).toBe(0);
  expect(f.transactions[0].aborted).toBe(true);
});
it('fails closed for relaxed durability before reading or writing an authority', async () => {
  const f = database();
  f.db.relaxed = true;
  await expect(loadOrCreateWorkspaceAuthority()).rejects.toThrow(/Strict/);
  expect(f.puts).toBe(0);
});
it('does not acknowledge a mismatching durable readback or silently generate another identity', async () => {
  const f = database();
  f.db.wrongReadback = true;
  await expect(loadOrCreateWorkspaceAuthority()).rejects.toThrow(/readback/);
  expect(f.puts).toBe(1);
  const actual = f.value;
  f.db.wrongReadback = false;
  expect(await loadOrCreateWorkspaceAuthority()).toEqual(actual);
  expect(f.puts).toBe(1);
});
it('validates exact UUID shape without accepting owner strings or unknown fields', () => {
  expect(() =>
    parseStoredWorkspaceAuthority({
      version: 1,
      id: 'workspace:11111111-1111-1111-1111-111111111111',
    }),
  ).toThrow();
});
