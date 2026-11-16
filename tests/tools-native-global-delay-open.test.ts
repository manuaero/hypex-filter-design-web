// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createToolExecutor, type ToolAdapter } from '../src/application/tools';
import {
  createFileTransfers,
  FILE_TRANSFER_CHUNK_BYTES,
  type FileTransferBackend,
  type FileTransferRecord,
  type TransferJson,
} from '../src/application/file-transfers';
import {
  prepareNativeProjectOpen,
  type ProjectReplacementIntent,
} from '../src/application/native-project-open';
import { exportHfd } from '../src/domain/files';
import { newProject, type Project, type Slot } from '../src/domain/model';
import { createWorkspaceStore } from '../src/state/workspace';
import type { WorkspaceEnvelope } from '../src/state/persistence';

const actor = { owner: 'site:synthetic', scope: 'v55-native-global-open' };
beforeAll(() => vi.stubGlobal('Blob', NodeBlob));
afterAll(() => vi.unstubAllGlobals());
const values = [
  [17, 29, 43],
  [101, 113, 127],
  [203, 227, 251],
];
const maxima = [
  [70001, 70003, 70007],
  [71001, 71003, 71007],
  [72001, 72003, 72007],
];
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function input() {
  const project = newProject('Synthetic native Global input');
  project.hfdSelectedPreset = 3;
  project.hfdSelectedGroupId = 777;
  for (const [p, preset] of project.presets.entries())
    for (const [c, channel] of preset.channels.entries()) {
      channel.globalDelayUs = values[p][c];
      channel.hfdDelay = { localMaximum: 19 + c, globalMaximum: maxima[p][c] };
      channel.fir = { name: `Synthetic FIR ${p}-${c}`, enabled: false, taps: [1, 0.125] };
    }
  return project;
}
const globals = (project: Project) =>
  project.presets.map((preset) => preset.channels.map((c) => c.globalDelayUs));
const maxValues = (project: Project) =>
  project.presets.map((preset) => preset.channels.map((c) => c.hfdDelay?.globalMaximum));

function transferBackend(): FileTransferBackend {
  let records = new Map<string, FileTransferRecord>();
  let chunks = new Map<string, Uint8Array>();
  let tail: Promise<unknown> = Promise.resolve();
  return {
    transaction(action) {
      const job = tail.then(async () => {
        const nextRecords = structuredClone(records),
          nextChunks = new Map(chunks);
        const key = (id: string, file: number, index: number) => `${id}/${file}/${index}`;
        const remove = async (id: string) => {
          for (const k of nextChunks.keys()) if (k.startsWith(`${id}/`)) nextChunks.delete(k);
        };
        const result = await action({
          get: async (id) => structuredClone(nextRecords.get(id)),
          list: async () => structuredClone([...nextRecords.values()]),
          put: async (record) => {
            nextRecords.set(record.id, structuredClone(record));
          },
          getChunk: async (id, file, index) => nextChunks.get(key(id, file, index))?.slice(),
          putChunk: async (id, file, index, bytes) => {
            nextChunks.set(key(id, file, index), bytes.slice());
          },
          deleteChunks: remove,
          delete: async (id) => {
            nextRecords.delete(id);
            await remove(id);
          },
        });
        records = nextRecords;
        chunks = nextChunks;
        return result;
      });
      tail = job.then(
        () => {},
        () => {},
      );
      return job;
    },
  };
}

async function setup() {
  let saved: WorkspaceEnvelope | null = null;
  const writes: WorkspaceEnvelope[] = [];
  const workspace = createWorkspaceStore({
    read: async () => structuredClone(saved),
    write: async (value) => {
      saved = structuredClone(value);
      writes.push(structuredClone(value));
    },
    readLegacy: () => null,
  });
  await workspace.persistence.hydrate();
  const state = () => workspace.store.getState();
  const publications: Project[][] = [];
  workspace.store.subscribe((next, previous) => {
    if (next.documents !== previous.documents)
      publications.push([
        structuredClone(next.documents.left),
        structuredClone(next.documents.right),
      ]);
  });
  const prepare = vi.fn((project: Project, slot: Slot, intent: ProjectReplacementIntent) =>
    intent.kind === 'native-file-open'
      ? prepareNativeProjectOpen(project, slot, {
          presetIndex: slot === 'left' ? 0 : 1,
          route: intent.route,
        }).project
      : project,
  );
  const hardware = vi.fn(() => {
    throw Error('No hardware in native-open authoring tests');
  });
  let nextId = 0;
  const manager = createFileTransfers({
    backend: transferBackend(),
    randomId: () => `v55-transfer-${++nextId}`,
  });
  const adapter: ToolAdapter = {
    state,
    edit: (slots, apply, options) => state().editAt(slots, apply, options),
    editByRole: (slots, apply, options) => state().editAt(slots, apply, options),
    choose: (patch) => state().choose(patch),
    undo: () => state().undo(),
    redo: () => state().redo(),
    prepareProjectOpen: prepare,
    documentsReplaced: vi.fn(),
    connections: hardware,
    connect: async () => hardware(),
    disconnect: async () => hardware(),
    refresh: async () => hardware(),
    operate: async (_label, action) => action(),
    message() {},
    progress() {},
    view() {},
    files: {
      manager,
      revision: () => state().documentRevision ?? 0,
      lookup: async (id, owner) =>
        (await state().lookupFileCommit(id, owner)) as unknown as TransferJson | undefined,
      // This fixture supplies the same trusted final-preparation port as Studio;
      // the separate Studio suite exercises its actual production implementation.
      commit: async (id, principal, revision, slots, apply, result, remember, options) => {
        const intent = (result as { projectOpen?: ProjectReplacementIntent }).projectOpen ?? {
          kind: 'snapshot',
        };
        return (await state().commitFileImport(
          id,
          principal,
          revision,
          slots,
          (destination, slot) => {
            apply(destination);
            const final = prepare(destination, slot, intent);
            for (const key of Object.keys(destination)) Reflect.deleteProperty(destination, key);
            Object.assign(destination, final);
          },
          result,
          remember,
          { ...options, synchronizeLinks: false },
        )) as unknown as TransferJson;
      },
    },
  };
  return {
    workspace,
    state,
    writes,
    publications,
    prepare,
    hardware,
    adapter,
    execute: createToolExecutor(adapter),
    saved: () => saved,
  };
}

it.each(['xml', 'folder'] as const)(
  'Both %s MCP import prepares independent chosen presets before one publication and Undo',
  async (format) => {
    const f = await setup(),
      before = structuredClone(f.state().documents),
      content = exportHfd(input());
    const result =
      format === 'xml'
        ? await f.execute('fusion_project_import', { target: 'both', content })
        : await f.execute('fusion_project_import_folder', {
            target: 'both',
            name: 'Synthetic folder',
            files: [{ path: 'Config.xml', content }],
          });
    expect(result).toMatchObject({ ok: true });
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(f.publications).toHaveLength(1);
    expect(f.state().past).toHaveLength(1);
    expect(globals(f.state().documents.left)).toEqual([
      [17, 17, 17],
      [101, 113, 127],
      [203, 203, 203],
    ]);
    expect(globals(f.state().documents.right)).toEqual([
      [17, 29, 43],
      [101, 101, 101],
      [203, 203, 203],
    ]);
    expect(maxValues(f.state().documents.left)).toEqual([
      [70001, 70001, 70001],
      maxima[1],
      [72001, 72001, 72001],
    ]);
    expect(maxValues(f.state().documents.right)).toEqual([
      maxima[0],
      [71001, 71001, 71001],
      [72001, 72001, 72001],
    ]);
    expect(f.state().documents.left.hfdSelectedPreset).toBe(1);
    expect(f.state().documents.right.hfdSelectedPreset).toBe(2);
    await f.workspace.persistence.flush();
    expect(f.saved()!.state.documents).toEqual(f.state().documents);
    expect(await f.execute('fusion_history', { action: 'undo' })).toMatchObject({ ok: true });
    expect(f.state().documents).toEqual(before);
    expect(f.hardware).not.toHaveBeenCalled();
  },
);

it('Right missing chosen first Max refuses after Left preparation without any publication, selection, history or persisted change', async () => {
  const f = await setup(),
    before = f.state(),
    doc = new DOMParser().parseFromString(exportHfd(input()), 'application/xml');
  const global = [
    ...doc.querySelectorAll('preset[index="2"] > processobj[processtype="ptDelay"][groupid="1"]'),
  ].find((node) => node.querySelector(':scope > global')?.getAttribute('value') === 'true')!;
  global.querySelector(':scope > maxdelay')!.remove();
  const result = await f.execute('fusion_project_import', {
    target: 'both',
    content: new XMLSerializer().serializeToString(doc),
  });
  expect(result).toMatchObject({ ok: false });
  expect(JSON.stringify(result)).toMatch(/first.*max|maximum/i);
  expect(f.prepare.mock.calls.map((call) => call[1])).toEqual(['left', 'right']);
  expect(f.state().documents).toBe(before.documents);
  expect(f.state().past).toEqual(before.past);
  expect(f.state().documentRevision).toBe(before.documentRevision);
  expect([f.state().slot, f.state().preset, f.state().channel, f.state().filter]).toEqual([
    before.slot,
    before.preset,
    before.channel,
    before.filter,
  ]);
  expect(f.publications).toEqual([]);
  expect(f.writes).toEqual([]);
  expect(f.state().fileCommitReceipts).toEqual(before.fileCommitReceipts);
  expect(f.adapter.documentsReplaced).not.toHaveBeenCalled();
  expect(f.hardware).not.toHaveBeenCalled();
});

it('verified Both file commit persists only reconciled role finals plus receipt; Undo and receipt replay never reopen', async () => {
  const f = await setup(),
    before = structuredClone(f.state().documents),
    data = new TextEncoder().encode(exportHfd(input()));
  const begin = (await f.execute(
    'fusion_file_upload_begin',
    {
      operation: { workflow: 'project', parameters: { target: 'both' } },
      files: [{ path: 'Config.xml', bytes: data.length, sha256: digest(data) }],
    },
    actor,
  )) as { ok: boolean; transfer: { id: string } };
  expect(begin.ok).toBe(true);
  const id = begin.transfer.id;
  for (let index = 0; index * FILE_TRANSFER_CHUNK_BYTES < data.length; index++) {
    const part = data.subarray(
      index * FILE_TRANSFER_CHUNK_BYTES,
      (index + 1) * FILE_TRANSFER_CHUNK_BYTES,
    );
    expect(
      await f.execute(
        'fusion_file_upload_chunk',
        {
          id,
          fileIndex: 0,
          chunkIndex: index,
          base64: Buffer.from(part).toString('base64'),
          sha256: digest(part),
        },
        actor,
      ),
    ).toMatchObject({ ok: true });
  }
  expect(f.publications).toEqual([]);
  const committed = (await f.execute('fusion_file_upload_commit', { id }, actor)) as {
    ok: boolean;
    receipt: unknown;
  };
  expect(committed.ok, JSON.stringify(committed)).toBe(true);
  expect(f.publications).toHaveLength(1);
  expect(f.writes).toHaveLength(1);
  expect(f.saved()!.state.documents).toEqual(f.state().documents);
  expect(Object.values(f.saved()!.state.fileCommitReceipts!)).toContainEqual(committed.receipt);
  expect(globals(f.saved()!.state.documents.left)).toEqual([
    [17, 17, 17],
    [101, 113, 127],
    [203, 203, 203],
  ]);
  expect(globals(f.saved()!.state.documents.right)).toEqual([
    [17, 29, 43],
    [101, 101, 101],
    [203, 203, 203],
  ]);
  expect(f.state().past).toHaveLength(1);
  await f.execute('fusion_history', { action: 'undo' });
  await f.workspace.persistence.flush();
  expect(f.state().documents).toEqual(before);
  const afterUndo = f.state(),
    writes = f.writes.length;
  expect(await f.execute('fusion_file_upload_commit', { id }, actor)).toEqual(committed);
  expect(f.prepare).toHaveBeenCalledTimes(2);
  expect(f.state().documents).toBe(afterUndo.documents);
  expect(f.state().documentRevision).toBe(afterUndo.documentRevision);
  expect(f.writes).toHaveLength(writes);
  expect(f.hardware).not.toHaveBeenCalled();
});

it('Both JSON snapshot import retains raw nonuniform Globals and unequal maxima without the native route', async () => {
  const f = await setup(),
    incoming = input();
  expect(
    await f.execute('fusion_project_import', { target: 'both', content: JSON.stringify(incoming) }),
  ).toMatchObject({ ok: true });
  expect(f.prepare.mock.calls.map((call) => call[2])).toEqual([
    { kind: 'snapshot' },
    { kind: 'snapshot' },
  ]);
  expect(f.state().documents).toEqual({ left: incoming, right: incoming });
  expect(globals(f.state().documents.left)).toEqual(values);
  expect(maxValues(f.state().documents.right)).toEqual(maxima);
  expect(f.state().past).toHaveLength(1);
  expect(f.hardware).not.toHaveBeenCalled();
});
