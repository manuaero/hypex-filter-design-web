// @vitest-environment jsdom
import { File as NodeFile } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newProject, type Project, type Slot } from '../src/domain/model';
import { projectFiles } from '../src/domain/project-io';
import {
  createProjectSources,
  ProjectSourcesError,
  type ProjectSourcesBackend,
  type ProjectSourcesEnvelope,
  type ProjectDirectoryHandle,
  type ProjectFileHandle,
  type ProjectOpenReceipt,
  type ProjectSourcesOptions,
} from '../src/application/project-sources';
import { assertProjectSourcesWrite } from '../src/application/project-sources-format';
import { createIndexedDbProjectSourcesBackend } from '../src/application/project-sources-storage';
import {
  pickProjectDirectory,
  readDirectoryProject,
  listDirectoryProjects,
} from '../src/application/directory-project-source';
import { MAX_UI_FILE_BYTES } from '../src/application/file-budget';

const principal = { owner: 'browser:test', scope: 'ui:one' };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class Directory implements ProjectDirectoryHandle {
  readonly kind = 'directory' as const;
  permission: PermissionState = 'granted';
  children = new Map<string, Directory | FileHandle>();
  queryPermission = vi.fn(async (_: { mode: 'read' }) => this.permission);
  requestPermission = vi.fn(async () => this.permission);
  getDirectoryHandle = vi.fn(async (name: string) => {
    const handle = this.children.get(name);
    if (!handle || handle.kind !== 'directory')
      throw new DOMException('Private local path', 'NotFoundError');
    return handle;
  });
  constructor(
    readonly name: string,
    readonly identity = name,
  ) {}
  async isSameEntry(other: ProjectDirectoryHandle) {
    return other instanceof Directory && other.identity === this.identity;
  }
  async *values() {
    for (const value of this.children.values()) yield value;
  }
  add(handle: Directory | FileHandle) {
    this.children.set(handle.name, handle);
    return this;
  }
}
class FileHandle implements ProjectFileHandle {
  readonly kind = 'file' as const;
  getFile = vi.fn(
    async () =>
      new NodeFile([this.text], this.name, { lastModified: this.modified }) as unknown as File,
  );
  constructor(
    readonly name: string,
    public text: string,
    public modified = 10001,
  ) {}
}
function folder(name: string, project = newProject(name), modified = 10001) {
  const result = new Directory(name);
  for (const entry of projectFiles(project))
    result.add(new FileHandle(entry.path, entry.content, modified));
  return result;
}
const copy = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || !('roots' in value)) return structuredClone(value);
  const v = value as ProjectSourcesEnvelope;
  return {
    ...v,
    roots: v.roots.map((root) => ({ ...root })),
    sources: structuredClone(v.sources),
    recent: structuredClone(v.recent),
  };
};
function memory(initial: unknown = null) {
  let stored = copy(initial),
    failRead = false,
    failWrite = false;
  const backend: ProjectSourcesBackend = {
    read: vi.fn(async () => {
      if (failRead) throw new Error('private database error');
      return copy(stored);
    }),
    write: vi.fn(async (next, expected) => {
      if (failWrite) throw new Error('private quota path');
      assertProjectSourcesWrite(stored, next, expected);
      stored = copy(next);
    }),
  };
  return {
    backend,
    get stored() {
      return copy(stored);
    },
    set failRead(value: boolean) {
      failRead = value;
    },
    set failWrite(value: boolean) {
      failWrite = value;
    },
  };
}
function setup(overrides: Partial<ProjectSourcesOptions> = {}, storage = memory()) {
  const baseline = { left: newProject('Original Left'), right: newProject('Original Right') };
  let documents = structuredClone(baseline),
    revision = 0,
    sequence = 0,
    clock = 100000;
  const library = new Map<string, Project>(),
    receipts = new Map<string, ProjectOpenReceipt>();
  const apply = vi.fn();
  const commit: ProjectSourcesOptions['commit'] = vi.fn(
    async (binding, project, commitId, metadata) => {
      if (receipts.has(commitId)) return structuredClone(receipts.get(commitId)!);
      if (revision !== binding.expectedRevision) throw new Error('Stale workspace revision');
      for (const slot of (binding.target === 'both'
        ? ['left', 'right']
        : [binding.target]) as Slot[])
        documents[slot] = structuredClone(project);
      apply();
      revision++;
      const receipt = { commitId, revision, result: { ...metadata } };
      receipts.set(commitId, receipt);
      return structuredClone(receipt);
    },
  );
  const options: ProjectSourcesOptions = {
    backend: storage.backend,
    resolveLibrary: async (id) => library.get(id),
    commit,
    lookup: vi.fn(async (id) => structuredClone(receipts.get(id))),
    id: () => `opaque-${++sequence}`,
    now: () => ++clock,
    ...overrides,
  };
  const service = createProjectSources(options);
  return {
    service,
    storage,
    options,
    library,
    receipts,
    apply,
    commit,
    get documents() {
      return structuredClone(documents);
    },
    get revision() {
      return revision;
    },
    undo() {
      documents = structuredClone(baseline);
      revision++;
    },
    changeRevision() {
      revision++;
    },
    input(sourceId: string, requestId = 'request-1', target: Slot | 'both' = 'right') {
      return {
        sourceId,
        target,
        expectedRevision: revision,
        requestId,
        principal: { ...principal },
      };
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('granted directory project source', () => {
  it('lists direct children containing Config.xml, defaults to name ascending and exposes only summaries', async () => {
    const root = new Directory('Private database')
      .add(folder('Zulu'))
      .add(folder('Alpha', undefined, 4999))
      .add(new Directory('No config').add(folder('Nested project')))
      .add(new FileHandle('ordinary.txt', 'unused'));
    const f = setup({ compareNames: (a, b) => (a < b ? -1 : a > b ? 1 : 0) });
    const idle = f.service.getSnapshot();
    expect(f.service.getSnapshot()).toBe(idle);
    const rootId = await f.service.registerDirectory(root),
      listed = await f.service.list(rootId);
    expect(listed.entries.map((entry) => entry.label)).toEqual(['Alpha', 'Zulu']);
    expect(listed.entries[0].modifiedAt).toBe(4000);
    expect(listed).toMatchObject({
      sort: { by: 'name', direction: 'ascending' },
      comparison: 'browser-locale',
      needsHumanGrant: false,
    });
    expect(JSON.stringify(listed)).not.toMatch(/folderName|handle|sourceXML|contents|Config.xml/);
    expect(JSON.stringify(f.service.getSnapshot())).not.toMatch(/folderName|handle|sourceXML/);
    expect(Object.isFrozen(listed.entries)).toBe(true);
    expect(Object.isFrozen(listed.entries[0])).toBe(true);
    expect(root.requestPermission).not.toHaveBeenCalled();
  });
  it('uses injected locale comparison and 2-second Config.xml timestamps without a secondary tie breaker', async () => {
    const root = new Directory('db')
      .add(folder('Zulu', undefined, 5999))
      .add(folder('Alpha', undefined, 4000))
      .add(folder('Middle', undefined, 9001));
    const compare = vi.fn((a: string, b: string) =>
      a === b ? 0 : a === 'Zulu' ? -1 : b === 'Zulu' ? 1 : a.localeCompare(b),
    );
    const f = setup({ compareNames: compare });
    const rootId = await f.service.registerDirectory(root);
    expect((await f.service.list(rootId)).entries.map((entry) => entry.label)).toEqual([
      'Zulu',
      'Alpha',
      'Middle',
    ]);
    expect(
      (await f.service.list(rootId, { by: 'name', direction: 'descending' })).entries.map(
        (entry) => entry.label,
      ),
    ).toEqual(['Middle', 'Alpha', 'Zulu']);
    compare.mockClear();
    const dates = await f.service.list(rootId, { by: 'modified', direction: 'ascending' });
    expect(dates.entries.map((entry) => entry.modifiedAt)).toEqual([4000, 4000, 8000]);
    expect(dates.entries.slice(0, 2).map((entry) => entry.label)).toEqual(['Zulu', 'Alpha']);
    expect(compare).not.toHaveBeenCalled();
  });
  it('reuses the same granted root identity while retaining distinct case-sensitive browser child identities', async () => {
    const f = setup(),
      first = new Directory('db', 'same').add(folder('Case')).add(folder('case'));
    const id = await f.service.registerDirectory(first);
    const second = new Directory('renamed', 'same');
    expect(await f.service.registerDirectory(second)).toBe(id);
    expect(f.service.getSnapshot().roots).toHaveLength(1);
    // Listing the original root again shows case differences are not collapsed on Mac/Linux.
    await f.service.registerDirectory(first);
    const list = await f.service.list(id);
    expect(new Set(list.entries.map((entry) => entry.id)).size).toBe(2);
  });
  it('reads files freshly on every new request and never falls back to an older cached project', async () => {
    const p = newProject('First');
    p.presets[0].channels[0].gain = 1;
    const child = folder('Speaker', p),
      root = new Directory('db').add(child),
      f = setup();
    const rootId = await f.service.registerDirectory(root),
      sourceId = (await f.service.list(rootId)).entries[0].id;
    await f.service.open(f.input(sourceId));
    expect(f.documents.right.presets[0].channels[0].gain).toBe(1);
    const changed = newProject('Second');
    changed.presets[0].channels[0].gain = 7;
    child.children = folder('Speaker', changed).children;
    await f.service.open(f.input(sourceId, 'request-2'));
    expect(f.documents.right.presets[0].channels[0].gain).toBe(7);
    const before = f.documents;
    child.children.delete('Config.xml');
    await expect(f.service.open(f.input(sourceId, 'request-3'))).rejects.toMatchObject({
      code: 'invalid-project',
    });
    expect(f.documents).toEqual(before);
    expect(f.apply).toHaveBeenCalledTimes(2);
    expect(f.service.getSnapshot().recent[0].id).toBe(sourceId);
  });
  it('reports missing/expired permission without requesting it or exposing a stale listing', async () => {
    const root = new Directory('db').add(folder('Speaker')),
      f = setup();
    const rootId = await f.service.registerDirectory(root),
      sourceId = (await f.service.list(rootId)).entries[0].id;
    root.permission = 'prompt';
    expect(await f.service.list(rootId)).toMatchObject({ entries: [], needsHumanGrant: true });
    await expect(f.service.open(f.input(sourceId))).rejects.toMatchObject({
      needsHumanGrant: true,
      code: 'needs-human-grant',
    });
    expect(root.requestPermission).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.service.getSnapshot().recent[0].id).toBe(sourceId);
  });
  it('retains and promotes a missing recent folder rather than guessing a similarly named project', async () => {
    const root = new Directory('db').add(folder('Speaker')).add(folder('Speaker backup')),
      f = setup();
    const rootId = await f.service.registerDirectory(root),
      entries = (await f.service.list(rootId)).entries;
    await f.service.open(f.input(entries[0].id));
    await f.service.open(f.input(entries[1].id, 'other'));
    root.children.delete('Speaker');
    const before = f.documents;
    await expect(f.service.open(f.input(entries[0].id, 'missing'))).rejects.toMatchObject({
      code: 'missing-source',
    });
    expect(f.service.getSnapshot().recent.map(({ id }) => id)).toEqual([
      entries[0].id,
      entries[1].id,
    ]);
    expect(f.documents).toEqual(before);
  });
  it('sanitizes filesystem errors and rejects traversal, nested Config ambiguity and oversized blobs before text reads', async () => {
    const root = new Directory('db').add(folder('Speaker')),
      f = setup();
    const rootId = await f.service.registerDirectory(root),
      sourceId = (await f.service.list(rootId)).entries[0].id;
    root.getDirectoryHandle.mockRejectedValueOnce(new Error('C:\\Users\\secret\\private.txt'));
    try {
      await f.service.open(f.input(sourceId));
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectSourcesError);
      expect(JSON.stringify(error)).not.toMatch(/C:|Users|secret|private.txt/);
    }
    root.add(new Directory('../outside'));
    await expect(f.service.list(rootId)).rejects.toMatchObject({ code: 'invalid-project' });
    const nested = new Directory('Project')
      .add(new FileHandle('Config.xml', 'bad'))
      .add(new Directory('other').add(new FileHandle('Config.xml', 'bad')));
    await expect(readDirectoryProject(new Directory('db').add(nested), 'Project')).rejects.toThrow(
      /single Config.xml/,
    );
    const stream = vi.fn(),
      huge = new FileHandle('large.bin', '');
    huge.getFile.mockResolvedValue({ size: MAX_UI_FILE_BYTES + 1, stream } as unknown as File);
    await expect(
      readDirectoryProject(new Directory('db').add(new Directory('Large').add(huge)), 'Large'),
    ).rejects.toThrow(/byte budget/);
    expect(stream).not.toHaveBeenCalled();
  });
  it('rejects ambiguous Config.xml casing instead of importing an arbitrary one', async () => {
    const root = new Directory('db').add(
      new Directory('Ambiguous')
        .add(new FileHandle('Config.xml', 'one'))
        .add(new FileHandle('CONFIG.XML', 'two')),
    );
    await expect(readDirectoryProject(root, 'Ambiguous')).rejects.toThrow(/unambiguous/);
  });
  it('limits file enumeration without starting any file streams', async () => {
    const child = new Directory('Too many');
    for (let i = 0; i < 2001; i++) child.add(new FileHandle(`file-${i}.txt`, ''));
    await expect(readDirectoryProject(new Directory('db').add(child), 'Too many')).rejects.toThrow(
      /2000-file/,
    );
  });
  it('isolates the human picker and treats cancellation as no selection', async () => {
    const root = new Directory('db'),
      picker = vi.fn(async () => root);
    expect(await pickProjectDirectory(picker)).toBe(root);
    expect(picker).toHaveBeenCalledWith({ mode: 'read', id: 'fusion-studio-project-database' });
    expect(
      await pickProjectDirectory(async () => {
        throw new DOMException('Cancelled', 'AbortError');
      }),
    ).toBeUndefined();
    expect(root.requestPermission).not.toHaveBeenCalled();
  });
});

describe('shared recent open and durable workspace receipts', () => {
  it('keeps ten MRU references, reopening promotes without duplicating, and clear does not delete library data', async () => {
    const f = setup();
    for (let i = 0; i < 12; i++) {
      f.library.set(`saved-${i}`, newProject(`Project ${i}`));
      await f.service.rememberLibrary({ id: `saved-${i}`, label: `Project ${i}` });
    }
    const first = f.service.getSnapshot().recent.at(-1)!.id;
    expect(f.service.getSnapshot().recent).toHaveLength(10);
    await f.service.open(f.input(first));
    expect(f.service.getSnapshot().recent[0].id).toBe(first);
    expect(new Set(f.service.getSnapshot().recent.map(({ id }) => id)).size).toBe(10);
    await f.service.clearRecent();
    expect(f.service.getSnapshot().recent).toEqual([]);
    expect(f.library.size).toBe(12);
  });
  it('captures target, revision, request ID and principal before asynchronous reads', async () => {
    const gate = deferred<Project | undefined>(),
      f = setup({ resolveLibrary: () => gate.promise });
    const sourceId = await f.service.rememberLibrary({ id: 'saved', label: 'Saved' });
    const input = f.input(sourceId),
      run = f.service.open(input);
    input.target = 'left';
    input.expectedRevision = 99;
    input.requestId = 'different';
    input.principal.owner = 'attacker';
    gate.resolve(newProject('Captured'));
    await run;
    expect(f.documents.right.name).toBe('Captured');
    expect(f.documents.left.name).toBe('Original Left');
    expect(f.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'right',
        expectedRevision: 0,
        requestId: 'request-1',
        principal,
      }),
      expect.anything(),
      'source-open:browser:test:request-1',
      expect.objectContaining({ sourceId, target: 'right' }),
    );
  });
  it('rejects a stale prepared destination before mutation and preserves both documents', async () => {
    const f = setup();
    f.library.set('saved', newProject('Imported'));
    const id = await f.service.rememberLibrary({ id: 'saved', label: 'Saved' }),
      token = await f.service.prepareOpen(f.input(id, 'fixed', 'both'));
    const before = f.documents;
    f.changeRevision();
    await expect(f.service.commitOpen(token)).rejects.toMatchObject({ code: 'commit-failed' });
    expect(f.documents).toEqual(before);
    expect(f.apply).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent requests, survives reload and never reapplies a receipt after Undo', async () => {
    const f = setup();
    f.library.set('saved', newProject('Imported'));
    const id = await f.service.rememberLibrary({ id: 'saved', label: 'Saved' }),
      input = f.input(id, 'once', 'both');
    const [a, b] = await Promise.all([f.service.open(input), f.service.open(input)]);
    expect(a.receipt).toEqual(b.receipt);
    expect(f.apply).toHaveBeenCalledTimes(1);
    f.undo();
    const before = f.documents;
    const reloaded = createProjectSources(f.options);
    const replay = await reloaded.open({
      ...input,
      principal: { ...principal, scope: 'ui:after-reload' },
    });
    expect(replay).toMatchObject({ replayed: true, receipt: a.receipt });
    expect(f.documents).toEqual(before);
    expect(f.apply).toHaveBeenCalledTimes(1);
    await expect(reloaded.open({ ...input, target: 'left' })).rejects.toMatchObject({
      code: 'invalid-request',
    });
  });
  it('does not acknowledge MRU persistence failure as a failed document import or reapply on retry', async () => {
    const f = setup();
    f.library.set('saved', newProject('Imported'));
    const id = await f.service.rememberLibrary({ id: 'saved', label: 'Saved' }),
      input = f.input(id);
    const token = await f.service.prepareOpen(input);
    f.storage.failWrite = true;
    const result = await f.service.commitOpen(token);
    expect(result).toMatchObject({ replayed: false, recentSaved: false, receipt: { revision: 1 } });
    expect(result.recentWarning).toBeTruthy();
    expect(f.service.getSnapshot()).toMatchObject({ phase: 'error', hydrated: true });
    expect(f.apply).toHaveBeenCalledTimes(1);
    f.undo();
    const before = f.documents;
    f.storage.failWrite = false;
    await f.service.retry();
    const replay = await f.service.open(input);
    expect(replay.replayed).toBe(true);
    expect(replay.recentSaved).toBe(true);
    expect(f.documents).toEqual(before);
    expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it('recovers a durable receipt when the apply acknowledgment is lost', async () => {
    const f = setup();
    f.library.set('saved', newProject('Imported'));
    const commit = f.options.commit;
    f.options.commit = async (...args) => {
      await commit(...args);
      throw new Error('Lost response');
    };
    const service = createProjectSources(f.options),
      id = await service.rememberLibrary({ id: 'saved', label: 'Saved' });
    expect((await service.open(f.input(id))).replayed).toBe(true);
    expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it('retains failed library entries, rejects malformed projects, and never calls commit for either', async () => {
    const f = setup(),
      id = await f.service.rememberLibrary({ id: 'missing', label: 'Unavailable' });
    await expect(f.service.open(f.input(id))).rejects.toMatchObject({ code: 'missing-source' });
    f.library.set('missing', { ...newProject('Invalid'), presets: [] } as unknown as Project);
    await expect(f.service.open(f.input(id, 'invalid'))).rejects.toMatchObject({
      code: 'invalid-project',
    });
    expect(f.service.getSnapshot().recent[0].id).toBe(id);
    expect(f.commit).not.toHaveBeenCalled();
  });
  it('invalidates prepared directory reads when the root is forgotten and retains its recent reference', async () => {
    const f = setup(),
      root = new Directory('db').add(folder('Speaker'));
    const rootId = await f.service.registerDirectory(root),
      id = (await f.service.list(rootId)).entries[0].id;
    await f.service.open(f.input(id, 'first'));
    const token = await f.service.prepareOpen(f.input(id, 'prepared'));
    await f.service.forgetRoot(rootId);
    await expect(f.service.commitOpen(token)).rejects.toMatchObject({ code: 'source-changed' });
    expect(f.service.getSnapshot().recent[0].id).toBe(id);
    await expect(f.service.open(f.input(id, 'later'))).rejects.toMatchObject({
      needsHumanGrant: true,
    });
    expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it('rejects foreign prepared tokens without resolving or applying any project', async () => {
    const f = setup();
    f.library.set('saved', newProject('Imported'));
    const id = await f.service.rememberLibrary({ id: 'saved', label: 'Saved' }),
      token = await f.service.prepareOpen(f.input(id));
    await expect(createProjectSources(f.options).commitOpen(token)).rejects.toMatchObject({
      code: 'invalid-request',
    });
    expect(f.apply).not.toHaveBeenCalled();
  });
});

describe('project source persistence and recovery', () => {
  it('hydrates before edits, does not write empty defaults and retains prior records', async () => {
    const initial = setup();
    await initial.service.rememberLibrary({ id: 'old', label: 'Old' });
    const gate = deferred<unknown>(),
      storage = memory(initial.storage.stored),
      read = storage.backend.read;
    storage.backend.read = vi
      .fn()
      .mockImplementationOnce(() => gate.promise)
      .mockImplementation(read);
    const f = setup({ id: () => 'fresh-source' }, storage),
      run = f.service.rememberLibrary({ id: 'new', label: 'New' });
    expect(storage.backend.write).not.toHaveBeenCalled();
    gate.resolve(initial.storage.stored);
    await run;
    expect(f.service.getSnapshot().recent.map(({ label }) => label)).toEqual(['New', 'Old']);
  });
  it('serializes delayed writes so older asynchronous completions cannot overwrite newer MRU state', async () => {
    const storage = memory(),
      gate = deferred<void>(),
      write = storage.backend.write;
    storage.backend.write = vi
      .fn()
      .mockImplementationOnce(async (...args: Parameters<ProjectSourcesBackend['write']>) => {
        await gate.promise;
        await write(...args);
      })
      .mockImplementation(write);
    const f = setup({}, storage),
      first = f.service.rememberLibrary({ id: 'one', label: 'One' });
    await vi.waitFor(() => expect(storage.backend.write).toHaveBeenCalledTimes(1));
    const second = f.service.rememberLibrary({ id: 'two', label: 'Two' });
    expect(storage.backend.write).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(f.service.getSnapshot().recent.map(({ label }) => label)).toEqual(['Two', 'One']);
    expect((storage.stored as ProjectSourcesEnvelope).revision).toBe(2);
  });
  it('surfaces corrupt prior data without replacing it and offers explicit retry', async () => {
    const prior = {
        version: 1,
        revision: 4,
        roots: [],
        sources: [],
        recent: [{ sourceId: 'missing', openedAt: 100 }],
      },
      storage = memory(prior),
      f = setup({}, storage);
    await expect(f.service.hydrate()).rejects.toMatchObject({ code: 'persistence' });
    await expect(f.service.rememberLibrary({ id: 'new', label: 'New' })).rejects.toMatchObject({
      code: 'persistence',
    });
    expect(storage.backend.write).not.toHaveBeenCalled();
    expect(storage.stored).toEqual(prior);
    expect(f.service.getSnapshot()).toMatchObject({ hydrated: false, phase: 'error' });
  });
  it('does not pretend a failed readback was saved and recovers the durable version on retry', async () => {
    const storage = memory(),
      write = storage.backend.write;
    storage.backend.write = vi.fn(async (...args: Parameters<ProjectSourcesBackend['write']>) => {
      await write(...args);
      storage.failRead = true;
    });
    const f = setup({}, storage);
    await expect(f.service.rememberLibrary({ id: 'saved', label: 'Saved' })).rejects.toMatchObject({
      code: 'persistence',
    });
    expect(f.service.getSnapshot()).toMatchObject({
      phase: 'error',
      hydrated: true,
      saving: false,
    });
    expect(f.service.getSnapshot().recent).toEqual([]);
    storage.failRead = false;
    await f.service.retry();
    expect(f.service.getSnapshot().recent[0].label).toBe('Saved');
  });
  it('prevents another tab overwriting a newer source snapshot with its stale revision', async () => {
    const storage = memory(),
      a = setup({}, storage),
      b = setup({ id: () => 'other' }, storage);
    await Promise.all([a.service.hydrate(), b.service.hydrate()]);
    await a.service.rememberLibrary({ id: 'a', label: 'First tab' });
    await expect(b.service.rememberLibrary({ id: 'b', label: 'Second tab' })).rejects.toMatchObject(
      { code: 'persistence' },
    );
    expect((storage.stored as ProjectSourcesEnvelope).recent).toHaveLength(1);
    await b.service.retry();
    await b.service.rememberLibrary({ id: 'b', label: 'Second tab' });
    expect(b.service.getSnapshot().recent.map(({ label }) => label)).toEqual([
      'Second tab',
      'First tab',
    ]);
  });
  it('reports unavailable IndexedDB without creating an in-memory saved-state fiction', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const service = createProjectSources({
      ...setup().options,
      backend: createIndexedDbProjectSourcesBackend(),
    });
    await expect(service.hydrate()).rejects.toMatchObject({ code: 'persistence' });
    expect(service.getSnapshot()).toMatchObject({ hydrated: false, phase: 'error' });
  });
  it('validates before accepting an idempotent write and never destroys malformed prior state', () => {
    const value: ProjectSourcesEnvelope = {
      version: 1,
      revision: 1,
      roots: [],
      sources: [],
      recent: [],
    };
    expect(() => assertProjectSourcesWrite(value, value, null)).not.toThrow();
    expect(() =>
      assertProjectSourcesWrite(
        value,
        { ...value, recent: [{ sourceId: 'missing', openedAt: 1 }] },
        null,
      ),
    ).toThrow();
    expect(() => assertProjectSourcesWrite({ corrupt: true }, value, null)).toThrow();
  });
});

describe('asynchronous granted-source fences', () => {
  it('persists the active database and explicit sorting preferences across service reload', async () => {
    const f = setup(),
      root = new Directory('db').add(folder('Speaker'));
    const rootId = await f.service.registerDirectory(root);
    await f.service.list(rootId, { by: 'modified', direction: 'descending' });
    const reloaded = createProjectSources(f.options);
    await reloaded.hydrate();
    expect(reloaded.getSnapshot()).toMatchObject({
      activeRootId: rootId,
      sort: { by: 'modified', direction: 'descending' },
    });
    expect((await reloaded.list(rootId)).sort).toEqual({ by: 'modified', direction: 'descending' });
  });
  it('refuses application when read permission expires after preparation', async () => {
    const f = setup(),
      root = new Directory('db').add(folder('Speaker'));
    const rootId = await f.service.registerDirectory(root),
      id = (await f.service.list(rootId)).entries[0].id;
    const token = await f.service.prepareOpen(f.input(id));
    root.permission = 'denied';
    await expect(f.service.commitOpen(token)).rejects.toMatchObject({ needsHumanGrant: true });
    expect(f.apply).not.toHaveBeenCalled();
    expect(root.requestPermission).not.toHaveBeenCalled();
  });
  it('does not restore a forgotten root after a delayed file read completes', async () => {
    const f = setup(),
      child = folder('Speaker'),
      root = new Directory('db').add(child);
    const rootId = await f.service.registerDirectory(root),
      id = (await f.service.list(rootId)).entries[0].id;
    const file = child.children.get('Config.xml') as FileHandle,
      gate = deferred<File>(),
      original = file.getFile;
    file.getFile = vi.fn(() => gate.promise);
    const pending = f.service.prepareOpen(f.input(id));
    await vi.waitFor(() => expect(file.getFile).toHaveBeenCalled());
    await f.service.forgetRoot(rootId);
    gate.resolve(await original());
    await expect(pending).rejects.toMatchObject({ code: 'source-changed' });
    expect(f.service.getSnapshot().roots).toEqual([]);
    expect(f.apply).not.toHaveBeenCalled();
  });
  it('prevents an older slow listing from overwriting a newer sort preference', async () => {
    const f = setup(),
      root = new Directory('db').add(folder('Speaker')),
      rootId = await f.service.registerDirectory(root);
    const gates = [deferred<void>(), deferred<void>()],
      original = root.values.bind(root);
    let calls = 0;
    root.values = async function* () {
      const index = calls++;
      await gates[index].promise;
      yield* original();
    };
    const older = f.service.list(rootId, { by: 'modified', direction: 'descending' });
    await vi.waitFor(() => expect(calls).toBe(1));
    const newer = f.service.list(rootId, { by: 'name', direction: 'ascending' });
    await vi.waitFor(() => expect(calls).toBe(2));
    gates[1].resolve();
    await newer;
    gates[0].resolve();
    await expect(older).rejects.toMatchObject({ code: 'source-changed' });
    expect(f.service.getSnapshot().sort).toEqual({ by: 'name', direction: 'ascending' });
  });
});
