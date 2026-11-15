// @vitest-environment jsdom
import { Blob as NodeBlob, File as NodeFile, Buffer } from 'node:buffer';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import {
  createProjectDirectoryWriter,
  type DirectoryWriterBackend,
  type DirectoryWriterEnvelope,
  type WritableProjectDirectoryHandle,
  type WritableProjectFileHandle,
} from '../src/application/project-directory-writer';
import {
  assertDirectoryWriterWrite,
  parseDirectoryWriterEnvelope,
  assertDirectoryWriterCapacity,
  MAX_DIRECTORY_ARCHIVES,
} from '../src/application/directory-writer-storage';
import { hashDirectoryBlob, directoryNameKey } from '../src/application/directory-writer-fs';
import { newProject, type Project, type Slot } from '../src/domain/model';
import { projectFiles, importProjectFolder } from '../src/domain/project-io';
import { spectrum, processMeasurement } from '../src/domain/measurement';
import { loadProjectMicrophone } from '../src/domain/hfd-microphone';
import { clearNativeFir, selectNativeFirPlacement } from '../src/domain/fir-editing';
import { projectSchema } from '../src/domain/files';

beforeAll(() => {
  globalThis.Blob = NodeBlob as unknown as typeof Blob;
  globalThis.File = NodeFile as unknown as typeof File;
});
const oldBlob = globalThis.Blob,
  oldFile = globalThis.File;
afterAll(() => {
  globalThis.Blob = oldBlob;
  globalThis.File = oldFile;
});
const actor = { owner: 'site:owner', scope: 'lease:first' };
const bytes = (value: string | Uint8Array) =>
  typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value);
type Event = { kind: 'mkdir' | 'create' | 'open' | 'write' | 'close' | 'abort'; path: string };
class Environment {
  permission: PermissionState = 'granted';
  reads = 0;
  events: Event[] = [];
  closeThenThrow?: string;
  failReadAfterClose?: string;
  failedRead?: string;
  beforeMutation?: () => void;
  afterStagedWrite?: (file: FakeFile) => void;
  record(kind: Event['kind'], path: string) {
    this.beforeMutation?.();
    this.events.push({ kind, path });
  }
}
class FakeFile implements WritableProjectFileHandle {
  readonly kind = 'file' as const;
  generation = 0;
  ephemeral = false;
  busy = false;
  data: Uint8Array;
  constructor(
    readonly name: string,
    readonly path: string,
    readonly env: Environment,
    input: string | Uint8Array,
  ) {
    this.data = bytes(input);
  }
  external(input: string | Uint8Array) {
    this.data = bytes(input);
    this.generation++;
  }
  async getFile(): Promise<File> {
    this.env.reads++;
    if (this.env.failedRead === this.path) {
      this.env.failedRead = undefined;
      throw new DOMException('Injected post-close read failure', 'NotReadableError');
    }
    const source = this,
      generation = this.generation;
    class BorrowedFile extends NodeFile {
      check() {
        if (source.ephemeral && source.generation !== generation)
          throw new DOMException(
            'The borrowed disk snapshot became unreadable',
            'NotReadableError',
          );
      }
      override async arrayBuffer() {
        this.check();
        return super.arrayBuffer();
      }
      override stream() {
        this.check();
        return super.stream();
      }
    }
    return new BorrowedFile([Uint8Array.from(this.data).buffer], this.name, {
      lastModified: generation + 1000,
    }) as unknown as File;
  }
  async createWritable(options: { keepExistingData: false; mode: 'exclusive' }) {
    expect(options).toEqual({ keepExistingData: false, mode: 'exclusive' });
    if (this.env.permission !== 'granted')
      throw new DOMException('Write grant expired', 'NotAllowedError');
    if (this.busy)
      throw new DOMException('Another writer owns the stream', 'NoModificationAllowedError');
    this.env.record('open', this.path);
    this.busy = true;
    let staged = new Uint8Array();
    return {
      write: async (blob: Blob) => {
        this.env.record('write', this.path);
        staged = new Uint8Array(await blob.arrayBuffer());
        this.env.afterStagedWrite?.(this);
      },
      close: async () => {
        this.env.record('close', this.path);
        this.data = Uint8Array.from(staged);
        this.generation++;
        this.busy = false;
        if (this.env.failReadAfterClose === this.path) {
          this.env.failReadAfterClose = undefined;
          this.env.failedRead = this.path;
        }
        if (this.env.closeThenThrow === this.path) {
          this.env.closeThenThrow = undefined;
          throw new Error('Close committed but its acknowledgment was lost');
        }
      },
      abort: async () => {
        this.env.record('abort', this.path);
        this.busy = false;
      },
    };
  }
}
class FakeDirectory implements WritableProjectDirectoryHandle {
  readonly kind = 'directory' as const;
  children = new Map<string, FakeDirectory | FakeFile>();
  constructor(
    readonly name: string,
    readonly env: Environment,
    readonly path = name,
  ) {}
  async queryPermission(options: { mode: 'readwrite' }) {
    this.env.reads++;
    expect(options.mode).toBe('readwrite');
    return this.env.permission;
  }
  async isSameEntry(other: WritableProjectDirectoryHandle) {
    return other === this;
  }
  async *values() {
    this.env.reads++;
    yield* this.children.values();
  }
  directory(name: string) {
    const child = new FakeDirectory(name, this.env, `${this.path}/${name}`);
    this.children.set(name, child);
    return child;
  }
  file(name: string, input: string | Uint8Array) {
    const child = new FakeFile(name, `${this.path}/${name}`, this.env, input);
    this.children.set(name, child);
    return child;
  }
  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<WritableProjectDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'directory')
        throw new DOMException('Not a directory', 'TypeMismatchError');
      return existing;
    }
    if (!options?.create) throw new DOMException('Missing directory', 'NotFoundError');
    this.env.record('mkdir', `${this.path}/${name}`);
    return this.directory(name);
  }
  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<WritableProjectFileHandle> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw new DOMException('Not a file', 'TypeMismatchError');
      return existing;
    }
    if (!options?.create) throw new DOMException('Missing file', 'NotFoundError');
    this.env.record('create', `${this.path}/${name}`);
    return this.file(name, new Uint8Array());
  }
}
function clone(value: DirectoryWriterEnvelope): DirectoryWriterEnvelope {
  return {
    ...value,
    roots: value.roots.map((r) => ({ ...r })),
    associations: structuredClone(value.associations),
    saves: value.saves.map((s) => ({
      ...s,
      claim: s.claim ? { ...s.claim } : undefined,
      files: s.files.map((f) => ({ ...f })),
    })),
  };
}
function backend() {
  let value: DirectoryWriterEnvelope | null = null;
  const state = {
    failWrites: false,
    failReadback: false,
    nextReadFails: false,
    writes: 0,
    beforeWrite: undefined as ((next: DirectoryWriterEnvelope) => void) | undefined,
  };
  const api: DirectoryWriterBackend = {
    read: async () => {
      if (state.nextReadFails) {
        state.nextReadFails = false;
        throw new Error('Injected journal readback failure');
      }
      return value ? clone(value) : null;
    },
    write: async (next, expected) => {
      state.beforeWrite?.(next);
      if (state.failWrites) throw new Error('Injected journal write failure');
      assertDirectoryWriterWrite(value, next, expected);
      value = clone(next);
      state.writes++;
      if (state.failReadback) {
        state.failReadback = false;
        state.nextReadFails = true;
      }
    },
  };
  return {
    api,
    state,
    get value() {
      return value;
    },
  };
}
function source(name = 'Original') {
  const project = newProject(name);
  project.presets[0].channels[0].measurement = {
    ...spectrum([0, 1, 0.25, 0], 48000),
    name: 'original.dat',
  };
  project.presets[0].channels[1].measurement = {
    name: 'spectrum.frd',
    sampleRate: 48000,
    frequency: [20, 1000, 20000],
    magnitude: [-1, 2, -3],
    phase: [0, -30, -90],
  };
  return project;
}
function setup() {
  const env = new Environment(),
    root = new FakeDirectory('Granted', env),
    store = backend(),
    documents: Record<Slot, Project> = { left: source('Left'), right: source('Right') };
  let revision = 7,
    sequence = 0;
  const locks = new Set<string>();
  const create = () =>
    createProjectDirectoryWriter({
      getProject: (slot) => documents[slot],
      getRevision: () => revision,
      backend: store.api,
      hash: hashDirectoryBlob,
      now: () => 10000,
      id: () => `id-${++sequence}`,
      withLock: async <T>(name: string, work: () => Promise<T>) => {
        if (locks.has(name)) throw new Error('Folder lock already held');
        locks.add(name);
        try {
          return await work();
        } finally {
          locks.delete(name);
        }
      },
    });
  return {
    env,
    root,
    store,
    documents,
    create,
    bump: () => {
      revision++;
    },
    get revision() {
      return revision;
    },
    binding: (requestId: string, slot: Slot = 'left') => ({
      slot,
      expectedRevision: revision,
      requestId,
      principal: actor,
    }),
  };
}
async function initialize(f: ReturnType<typeof setup>) {
  const writer = f.create();
  await writer.hydrate();
  const rootId = await writer.registerDirectory(f.root);
  return { writer, rootId };
}
async function expectedFiles(project: Project) {
  return new Map(projectFiles(project).map((f) => [f.path, bytes(f.content)]));
}
function fileIn(folder: FakeDirectory, name: string) {
  return [...folder.children.values()].find(
    (f) => f.kind === 'file' && directoryNameKey(f.name) === directoryNameKey(name),
  ) as FakeFile;
}
function expectBytes(folder: FakeDirectory, expected: Map<string, Uint8Array>) {
  for (const [name, data] of expected)
    expect(Buffer.from(fileIn(folder, name)?.data ?? []).equals(Buffer.from(data)), name).toBe(
      true,
    );
}

it('durably captures independent original/desired bytes before any mutation and writes exact native exports with dependent-first order', async () => {
  const f = setup(),
    folder = f.root.directory('Existing'),
    original = new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0, 13, 10]),
    config = folder.file('Config.xml', original);
  config.ephemeral = true;
  const unrelated = folder.file('notes.bin', new Uint8Array([255, 7, 0]));
  const { writer, rootId } = await initialize(f),
    expected = await expectedFiles(f.documents.left),
    proposal = await writer.prepare({
      ...f.binding('exact'),
      mode: 'save-as',
      rootId,
      folderName: 'Existing',
    });
  expect(f.env.events).toEqual([]);
  expect(proposal.requiresOverwriteConfirmation).toBe(true);
  f.env.beforeMutation = () => {
    const saved = f.store.value!.saves.find((s) => s.id === proposal.id)!;
    expect(saved.phase).toBe('writing');
    expect(saved.files.every((v) => v.after instanceof Blob)).toBe(true);
    expect(saved.files.find((v) => v.path === 'Config.xml')!.before).not.toBeInstanceOf(NodeFile);
  };
  const result = await writer.commit(proposal.id, actor, { allowOverwrite: true });
  expect(result).toMatchObject({ phase: 'complete', verified: true, atomic: false });
  expectBytes(folder, expected);
  expect(unrelated.data).toEqual(new Uint8Array([255, 7, 0]));
  const closed = f.env.events
    .filter((e) => e.kind === 'close')
    .map((e) => e.path.split('/').at(-1));
  expect(closed.indexOf('P1_CH1.dat')).toBeLessThan(closed.indexOf('Config.xml'));
  expect(closed.at(-1)).toBe('FusionProject.json');
  const before = f.store.value!.saves[0].files.find((file) => file.path === 'Config.xml')!.before!;
  expect(new Uint8Array(await before.arrayBuffer())).toEqual(original);
  expect(JSON.stringify(writer.getSnapshot())).not.toMatch(
    /"(?:before|after|handle|folderHandle|owner|scope)":/,
  );
});
it('Save uses its own role association, requires Save As for an unrelated project, and refuses stale captured revisions before writes', async () => {
  const f = setup(),
    { writer, rootId } = await initialize(f);
  await expect(writer.prepare({ ...f.binding('no-association'), mode: 'save' })).rejects.toThrow();
  const first = await writer.prepare({
    ...f.binding('create-left'),
    mode: 'save-as',
    rootId,
    folderName: 'Left folder',
  });
  await writer.commit(first.id, actor);
  expect(writer.getSnapshot().associations).toEqual({
    left: { rootId, folderName: 'Left folder' },
  });
  const count = f.env.events.length;
  f.documents.left.name = 'Edited left';
  f.bump();
  const save = await writer.prepare({ ...f.binding('normal-save'), mode: 'save' });
  expect(save.folderName).toBe('Left folder');
  f.bump();
  await expect(writer.commit(save.id, actor)).rejects.toMatchObject({ code: 'stale-workspace' });
  expect(f.env.events).toHaveLength(count);
  f.documents.left = source('Replacement');
  await expect(
    writer.prepare({ ...f.binding('different-project'), mode: 'save' }),
  ).rejects.toThrow();
  await expect(
    writer.prepare({ ...f.binding('right-unbound', 'right'), mode: 'save' }),
  ).rejects.toThrow();
});
it('refuses externally edited target bytes after review without overwriting anything', async () => {
  const f = setup(),
    folder = f.root.directory('Existing'),
    config = folder.file('Config.xml', 'before'),
    { writer, rootId } = await initialize(f),
    p = await writer.prepare({
      ...f.binding('conflict'),
      mode: 'save-as',
      rootId,
      folderName: 'Existing',
    });
  config.external('Desktop edit after review');
  await expect(writer.commit(p.id, actor, { allowOverwrite: true })).rejects.toMatchObject({
    code: 'conflict',
  });
  expect(config.data).toEqual(bytes('Desktop edit after review'));
  expect(f.env.events).toEqual([]);
});
it.each(['close-ack', 'readback'] as const)(
  'interrupted %s resumes the exact captured export after later workspace edits and does not rewrite committed bytes',
  async (fault) => {
    const f = setup(),
      folder = f.root.directory('Existing');
    folder.file('Config.xml', 'old config');
    const { writer, rootId } = await initialize(f),
      expected = await expectedFiles(f.documents.left),
      p = await writer.prepare({
        ...f.binding(`retry-${fault}`),
        mode: 'save-as',
        rootId,
        folderName: 'Existing',
      });
    const path = `${folder.path}/Config.xml`;
    if (fault === 'close-ack') f.env.closeThenThrow = path;
    else f.env.failReadAfterClose = path;
    await expect(writer.commit(p.id, actor, { allowOverwrite: true })).rejects.toThrow();
    const attempts = f.env.events.filter((e) => e.kind === 'open' && e.path === path).length;
    f.documents.left.name = 'Newer unsaved project';
    f.documents.left.presets[0].channels[0].measurement!.impulse![1] = 99;
    f.bump();
    const result = await writer.retry(p.id, actor);
    expect(result).toMatchObject({ phase: 'complete', verified: true, workspaceChanged: true });
    expectBytes(folder, expected);
    expect(f.env.events.filter((e) => e.kind === 'open' && e.path === path)).toHaveLength(attempts);
  },
);
it('recovery restores exact overwritten raw bytes, retains introduced and unrelated files, and rejects later external edits', async () => {
  const f = setup(),
    folder = f.root.directory('Existing'),
    original = new Uint8Array([0xff, 0, 13, 10]),
    config = folder.file('Config.xml', original),
    unrelated = folder.file('photo.bin', new Uint8Array([8, 9]));
  const { writer, rootId } = await initialize(f),
    p = await writer.prepare({
      ...f.binding('recover'),
      mode: 'save-as',
      rootId,
      folderName: 'Existing',
    });
  await writer.commit(p.id, actor, { allowOverwrite: true });
  const introduced = Uint8Array.from(fileIn(folder, 'P1_CH1.dat').data);
  const result = await writer.recover(p.id, actor);
  expect(result).toMatchObject({
    phase: 'recovered-with-new-files',
    verified: true,
    atomic: false,
  });
  expect(config.data).toEqual(original);
  expect(fileIn(folder, 'P1_CH1.dat').data).toEqual(introduced);
  expect(unrelated.data).toEqual(new Uint8Array([8, 9]));
  const next = await writer.prepare({
    ...f.binding('recover-conflict'),
    mode: 'save-as',
    rootId,
    folderName: 'Existing',
  });
  await writer.commit(next.id, actor, { allowOverwrite: true });
  config.external('Later human edit');
  const count = f.env.events.length;
  await expect(writer.recover(next.id, actor)).rejects.toMatchObject({ code: 'conflict' });
  expect(f.env.events).toHaveLength(count);
  expect(config.data).toEqual(bytes('Later human edit'));
});
it('expired permission and unverified journal persistence prevent every filesystem mutation', async () => {
  const f = setup(),
    { writer, rootId } = await initialize(f),
    p = await writer.prepare({
      ...f.binding('permission'),
      mode: 'save-as',
      rootId,
      folderName: 'New',
    });
  f.env.permission = 'prompt';
  await expect(writer.commit(p.id, actor)).rejects.toMatchObject({ code: 'needs-human-grant' });
  expect(f.env.events).toEqual([]);
  f.env.permission = 'granted';
  f.store.state.failWrites = true;
  await expect(
    writer.prepare({ ...f.binding('storage-fail'), mode: 'save-as', rootId, folderName: 'Other' }),
  ).rejects.toThrow();
  expect(f.env.events).toEqual([]);
});
it('completed requests replay across scope/reload without file I/O, while other owners and request-ID rebinding are refused', async () => {
  const f = setup(),
    { writer, rootId } = await initialize(f),
    input = { ...f.binding('idempotent'), mode: 'save-as' as const, rootId, folderName: 'Saved' },
    p = await writer.prepare(input);
  await writer.commit(p.id, actor);
  const count = f.env.events.length;
  f.bump();
  const fresh = f.create();
  await fresh.hydrate();
  const readsBeforeReplay = f.env.reads;
  const reconnect = { ...actor, scope: 'lease:reconnected' };
  expect((await fresh.prepare({ ...input, principal: reconnect })).id).toBe(p.id);
  expect(await fresh.commit(p.id, reconnect)).toMatchObject({ replayed: true, verified: true });
  expect(f.env.events).toHaveLength(count);
  expect(f.env.reads).toBe(readsBeforeReplay);
  await expect(fresh.status(p.id, { owner: 'site:other', scope: 'lease:other' })).rejects.toThrow();
  await expect(
    fresh.prepare({ ...input, folderName: 'Different', principal: reconnect }),
  ).rejects.toThrow();
  expect(f.env.events).toHaveLength(count);
});
it('NFC/case aliases are matched before backup and ambiguous folder/file names are rejected without writes', async () => {
  const f = setup(),
    folder = f.root.directory('Café'),
    micName = 'cafe\u0301.txt';
  loadProjectMicrophone(f.documents.left, '10 1\n1000 1\n24000 1', micName);
  const old = folder.file(micName, 'raw original correction');
  const { writer, rootId } = await initialize(f),
    p = await writer.prepare({
      ...f.binding('unicode'),
      mode: 'save-as',
      rootId,
      folderName: 'Cafe\u0301',
    });
  const mic = p.files.find((file) => file.path === micName)!;
  expect(mic.action).toBe('replace');
  expect(mic.beforeBytes).toBe(old.data.length);
  folder.file('café.txt', 'duplicate NFC alias');
  await expect(writer.commit(p.id, actor, { allowOverwrite: true })).rejects.toThrow();
  expect(f.env.events).toEqual([]);
  folder.file('Config.xml', 'first');
  folder.file('CONFIG.XML', 'second');
  await expect(
    writer.prepare({ ...f.binding('duplicate-file'), mode: 'save-as', rootId, folderName: 'Café' }),
  ).rejects.toThrow();
  f.root.directory('Cafe\u0301');
  await expect(
    writer.prepare({
      ...f.binding('duplicate-folder'),
      mode: 'save-as',
      rootId,
      folderName: 'Café',
    }),
  ).rejects.toThrow();
  expect(f.env.events).toEqual([]);
});
it('only unused prepared reviews can be discarded and root references cannot be forgotten while any recovery record exists', async () => {
  const f = setup(),
    { writer, rootId } = await initialize(f),
    p = await writer.prepare({
      ...f.binding('discard'),
      mode: 'save-as',
      rootId,
      folderName: 'Unused',
    });
  await expect(writer.forgetRoot(rootId)).rejects.toThrow();
  await writer.forgetRecovery(p.id, actor);
  expect(writer.getSnapshot().saves).toHaveLength(0);
  expect(f.env.events).toEqual([]);
  await writer.forgetRoot(rootId);
  expect(writer.getSnapshot().roots).toHaveLength(0);
  const again = await writer.registerDirectory(f.root),
    saved = await writer.prepare({
      ...f.binding('written'),
      mode: 'save-as',
      rootId: again,
      folderName: 'Written',
    });
  await writer.commit(saved.id, actor);
  await expect(writer.forgetRecovery(saved.id, actor)).rejects.toThrow();
  await expect(writer.forgetRoot(again)).rejects.toThrow();
});
it('stale hydrated writers deduplicate the same root capability using the fresh persisted envelope', async () => {
  const f = setup(),
    a = f.create(),
    b = f.create();
  await Promise.all([a.hydrate(), b.hydrate()]);
  const first = await a.registerDirectory(f.root),
    second = await b.registerDirectory(f.root);
  expect(second).toBe(first);
  expect(f.store.value!.roots).toHaveLength(1);
  expect(f.env.events).toEqual([]);
});

it('a failed journal readback retains its prepared bytes for explicit storage retry and causes zero filesystem mutation', async () => {
  const f = setup(),
    { writer, rootId } = await initialize(f);
  f.store.state.failReadback = true;
  await expect(
    writer.prepare({
      ...f.binding('readback-journal'),
      mode: 'save-as',
      rootId,
      folderName: 'Journal',
    }),
  ).rejects.toMatchObject({ code: 'persistence' });
  expect(f.env.events).toEqual([]);
  await writer.retryStorage();
  const saved = writer.getSnapshot().saves.find((s) => s.folderName === 'Journal')!;
  expect(saved.phase).toBe('prepared');
  await writer.commit(saved.id, actor);
  expectBytes(
    f.root.children.get('Journal') as FakeDirectory,
    await expectedFiles(f.documents.left),
  );
});

it('loss of a new folder identity journal blocks resume into an ambiguous replacement and recovery leaves its unrelated bytes alone', async () => {
  const f = setup(),
    { writer, rootId } = await initialize(f),
    p = await writer.prepare({
      ...f.binding('lost-folder'),
      mode: 'save-as',
      rootId,
      folderName: 'New folder',
    });
  f.store.state.beforeWrite = (next) => {
    if (next.saves.find((s) => s.id === p.id)?.folderHandle)
      throw new Error('Folder handle persistence failed');
  };
  await expect(writer.commit(p.id, actor)).rejects.toThrow();
  expect(f.env.events.map((e) => e.kind)).toEqual(['mkdir']);
  const replacement = f.root.directory('New folder'),
    notes = replacement.file('other-person.bin', new Uint8Array([9, 8, 7]));
  f.store.state.beforeWrite = undefined;
  await writer.retryStorage();
  await expect(writer.retry(p.id, actor)).rejects.toMatchObject({ code: 'conflict' });
  expect(f.env.events.map((e) => e.kind)).toEqual(['mkdir']);
  const recovered = await writer.recover(p.id, actor);
  expect(recovered.phase).toBe('recovered');
  expect(recovered.files.every((file) => file.recovery === 'not-created')).toBe(true);
  expect(notes.data).toEqual(new Uint8Array([9, 8, 7]));
  expect(f.env.events.map((e) => e.kind)).toEqual(['mkdir']);
});

it('an interrupted recovery resumes recovery from a stale writer instance and never rewrites the saved forward export', async () => {
  const f = setup(),
    folder = f.root.directory('Existing'),
    oldConfig = bytes('original config'),
    oldImpulse = bytes('original impulse');
  const config = folder.file('Config.xml', oldConfig),
    impulse = folder.file('P1_CH1.dat', oldImpulse),
    { writer, rootId } = await initialize(f),
    p = await writer.prepare({
      ...f.binding('recover-direction'),
      mode: 'save-as',
      rootId,
      folderName: 'Existing',
    });
  await writer.commit(p.id, actor, { allowOverwrite: true });
  const stale = f.create();
  await stale.hydrate();
  f.env.closeThenThrow = config.path;
  await expect(writer.recover(p.id, actor)).rejects.toThrow();
  expect((await writer.status(p.id, actor)).phase).toBe('recovering');
  const writes = f.env.events.filter(
    (event) => event.kind === 'open' && event.path === config.path,
  ).length;
  const resumed = await stale.retry(p.id, { ...actor, scope: 'lease:reload' });
  expect(resumed.phase).toBe('recovered-with-new-files');
  expect(Buffer.from(config.data).equals(Buffer.from(oldConfig))).toBe(true);
  expect(Buffer.from(impulse.data).equals(Buffer.from(oldImpulse))).toBe(true);
  expect(
    f.env.events.filter((event) => event.kind === 'open' && event.path === config.path),
  ).toHaveLength(writes);
});

it('rejects an oversized original before reading/copying it and creates no folder files or journal', async () => {
  const f = setup(),
    folder = f.root.directory('Existing'),
    file = folder.file('Config.xml', ''),
    { writer, rootId } = await initialize(f);
  let reads = 0;
  file.getFile = async () =>
    ({
      size: 320e6 + 1,
      arrayBuffer: async () => {
        reads++;
        throw new Error('Should not read oversized data');
      },
      stream: () => {
        reads++;
        throw new Error('Should not stream oversized data');
      },
    }) as unknown as File;
  await expect(
    writer.prepare({ ...f.binding('oversized'), mode: 'save-as', rootId, folderName: 'Existing' }),
  ).rejects.toThrow();
  expect(reads).toBe(0);
  expect(f.env.events).toEqual([]);
  expect(writer.getSnapshot().saves).toHaveLength(0);
});

it('a stale prepared review cannot discard independently persisted partial writes or their original bytes', async () => {
  const f = setup(),
    folder = f.root.directory('Existing'),
    original = bytes('original config'),
    config = folder.file('Config.xml', original),
    { writer, rootId } = await initialize(f),
    p = await writer.prepare({
      ...f.binding('stale-discard'),
      mode: 'save-as',
      rootId,
      folderName: 'Existing',
    }),
    stale = f.create();
  await stale.hydrate();
  f.env.closeThenThrow = config.path;
  await expect(writer.commit(p.id, actor, { allowOverwrite: true })).rejects.toThrow();
  expect((await writer.status(p.id, actor)).phase).toBe('partial');
  const eventCount = f.env.events.length;
  await expect(stale.forgetRecovery(p.id, actor)).rejects.toMatchObject({ code: 'conflict' });
  const journal = f.store.value!.saves.find((save) => save.id === p.id)!;
  expect(journal).toBeDefined();
  const before = journal.files.find((file) => file.path === 'Config.xml')!.before!;
  expect(Buffer.from(await before.arrayBuffer()).equals(Buffer.from(original))).toBe(true);
  expect(f.env.events).toHaveLength(eventCount);
});

it('a stale recovering instance replays terminal recovery without undoing a later legitimate save', async () => {
  const f = setup(),
    folder = f.root.directory('Existing'),
    config = folder.file('Config.xml', 'original config'),
    { writer, rootId } = await initialize(f),
    p = await writer.prepare({
      ...f.binding('terminal-recovery'),
      mode: 'save-as',
      rootId,
      folderName: 'Existing',
    });
  await writer.commit(p.id, actor, { allowOverwrite: true });
  f.env.closeThenThrow = config.path;
  await expect(writer.recover(p.id, actor)).rejects.toThrow();
  const stale = f.create();
  await stale.hydrate();
  expect(stale.getSnapshot().saves.find((save) => save.id === p.id)!.phase).toBe('recovering');
  await writer.retry(p.id, actor);
  f.documents.left.name = 'Legitimate later save';
  f.bump();
  const next = await writer.prepare({ ...f.binding('later-save'), mode: 'save' });
  await writer.commit(next.id, actor);
  const saved = Buffer.from(config.data),
    events = f.env.events.length,
    reads = f.env.reads,
    replay = await stale.retry(p.id, { ...actor, scope: 'lease:new-scope' });
  // Verified describes the historical per-file recovery outcomes, not a fresh
  // assertion that the entire directory still equals the recovered before-image.
  expect(replay).toMatchObject({
    phase: 'recovered-with-new-files',
    verified: true,
    replayed: true,
    atomic: false,
  });
  expect(Buffer.from(config.data).equals(saved)).toBe(true);
  expect(f.env.events).toHaveLength(events);
  expect(f.env.reads).toBe(reads);
});

it('an external edit during staged stream.write aborts before close and preserves the edited bytes', async () => {
  const f = setup(),
    folder = f.root.directory('Existing'),
    config = folder.file('Config.xml', 'original config'),
    { writer, rootId } = await initialize(f),
    p = await writer.prepare({
      ...f.binding('external-during-write'),
      mode: 'save-as',
      rootId,
      folderName: 'Existing',
    });
  f.env.afterStagedWrite = (file) => {
    if (file === config) {
      f.env.afterStagedWrite = undefined;
      config.external('Native application edited during staging');
    }
  };
  await expect(writer.commit(p.id, actor, { allowOverwrite: true })).rejects.toMatchObject({
    code: 'conflict',
  });
  expect(
    Buffer.from(config.data).equals(Buffer.from(bytes('Native application edited during staging'))),
  ).toBe(true);
  expect(f.env.events.some((event) => event.path === config.path && event.kind === 'abort')).toBe(
    true,
  );
  expect(f.env.events.some((event) => event.path === config.path && event.kind === 'close')).toBe(
    false,
  );
  expect(
    f.store
      .value!.saves.find((save) => save.id === p.id)!
      .files.find((file) => file.path === 'Config.xml')!.before,
  ).toBeInstanceOf(Blob);
});

it('a saved native folder reopens exact browser processing and native FIR Clear caches despite unrelated old assets, while referenced native edits invalidate the sidecar', async () => {
  const f = setup(),
    folder = f.root.directory('Existing'),
    unrelated = [
      folder.file('notes.txt', 'Keep these unrelated notes\r\n'),
      folder.file('old-unreferenced.DAT', '0\n7\n0\n'),
      folder.file('Previous.xml', '<unrelated value="keep"/>'),
    ],
    originalAssets = unrelated.map((file) => Buffer.from(file.data)),
    project = f.documents.left,
    preset = project.presets[0],
    samples = Array.from({ length: 128 }, (_, i) =>
      i === 12 ? 1 : i === 15 ? 0.3 : i === 70 ? 0.5 : 0,
    );
  preset.channels[0].measurement = {
    ...processMeasurement(spectrum(samples, 48000), {
      window: { start: 8, end: 32, taper: 0.2, timeZero: 12 },
      calibration: {
        name: 'Browser correction',
        sampleRate: 48000,
        frequency: [10, 1000, 20000],
        magnitude: [2, 3, 6],
        phase: [0, 0, 0],
      },
      calibrationEnabled: true,
      smoothingOctaves: 1 / 3,
    }),
    name: 'Processed driver',
  };
  selectNativeFirPlacement(preset, 'output');
  preset.inputFir = {
    name: 'Prior input.txt',
    enabled: true,
    taps: [0.5, ...Array(4499).fill(0)],
    hfdState: { loaded: true, used: false, tapCount: 4500 },
  };
  preset.channels[0].fir = {
    name: 'Prior output.txt',
    enabled: true,
    taps: [0.25, ...Array(1499).fill(0)],
    hfdState: { loaded: true, used: true, tapCount: 1500 },
  };
  clearNativeFir(preset, 0);
  const original = structuredClone(project),
    { writer, rootId } = await initialize(f),
    p = await writer.prepare({
      ...f.binding('folder-sidecar-roundtrip'),
      mode: 'save-as',
      rootId,
      folderName: 'Existing',
    });
  await writer.commit(p.id, actor, { allowOverwrite: true });
  // The writer serializes its validated immutable capture, including schema
  // property ordering inside the JSON sidecar.
  expectBytes(folder, await expectedFiles(projectSchema.parse(original)));
  unrelated.forEach((file, i) =>
    expect(Buffer.from(file.data).equals(originalAssets[i])).toBe(true),
  );
  const savedFiles = [...folder.children.values()]
      .filter((file): file is FakeFile => file.kind === 'file')
      .map((file) => ({
        path: `Moved folder/${file.name}`,
        content: new TextDecoder().decode(file.data),
      })),
    reopened = importProjectFolder(savedFiles);
  expect(reopened.warnings.join(' ')).toContain(
    'Restored browser-only processed measurement state',
  );
  expect(reopened.warnings.join(' ')).not.toContain('snapshot is stale');
  expect({ ...reopened, warnings: original.warnings }).toEqual(original);
  expect(reopened.presets[0].inputFir.taps).toEqual([]);
  expect(reopened.presets[0].channels[0].fir).toEqual(preset.channels[0].fir);

  const nativeDataEdit = importProjectFolder(
    savedFiles.map((file) =>
      file.path.endsWith('/P1_CH1.dat') ? { ...file, content: '0\n0.5\n0\n' } : file,
    ),
  );
  expect(nativeDataEdit.warnings.join(' ')).toContain('snapshot is stale');
  expect(nativeDataEdit.warnings.join(' ')).not.toContain('Restored browser-only');
  expect(nativeDataEdit.presets[0].channels[0].measurement!.impulse).toEqual([0, 0.5, 0]);
  expect(nativeDataEdit.presets[0].channels[0].measurement!.processing).not.toEqual(
    original.presets[0].channels[0].measurement!.processing,
  );
  const nativeConfigEdit = importProjectFolder(
    savedFiles.map((file) =>
      file.path.endsWith('/Config.xml') ? { ...file, content: `${file.content}\n` } : file,
    ),
  );
  expect(nativeConfigEdit.warnings.join(' ')).toContain('snapshot is stale');
  expect(nativeConfigEdit.warnings.join(' ')).not.toContain('Restored browser-only');
});

async function completedArchiveFixture() {
  const f = setup(),
    { writer, rootId } = await initialize(f);
  const input = {
    ...f.binding('archive-save'),
    mode: 'save-as' as const,
    rootId,
    folderName: 'Archive project',
  };
  const proposal = await writer.prepare(input);
  const saved = await writer.commit(proposal.id, actor);
  return { ...f, writer, rootId, input, saved };
}
const archiveConfirmation = { confirm: true as const, removeLocalRecovery: true as const };

it('explicitly archives a terminal save with no filesystem I/O and replays its historical receipt after reload/new scope', async () => {
  const f = await completedArchiveFixture();
  await f.writer.registerDirectory(new FakeDirectory('Second grant', f.env));
  const sameEntry = vi.spyOn(f.root, 'isSameEntry');
  const events = f.env.events.length,
    reads = f.env.reads;
  sameEntry.mockClear();
  const review = await f.writer.reviewArchive(f.saved.id, actor);
  expect(review.recoveryBytes).toBeGreaterThan(0);
  expect(review.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.isFrozen(review)).toBe(true);
  await expect(
    f.writer.archive(review.id, { ...actor, owner: 'site:foreign' }, archiveConfirmation),
  ).rejects.toMatchObject({ code: 'invalid-request' });
  const archived = await f.writer.archive(review.id, actor, archiveConfirmation);
  expect(archived).toMatchObject({
    id: f.saved.id,
    phase: 'complete',
    recoveryAvailable: false,
    archived: true,
    verified: true,
    replayed: true,
    atomic: false,
  });
  expect(archived.files).toEqual(f.saved.files);
  expect(f.store.value!.saves).toHaveLength(0);
  expect(f.store.value!.archives).toHaveLength(1);
  expect(JSON.stringify(f.store.value!.archives)).not.toContain('folderHandle');
  expect(f.store.value!.archives[0]).not.toHaveProperty('files');
  expect(f.env.events.length).toBe(events);
  expect(f.env.reads).toBe(reads);
  expect(sameEntry).not.toHaveBeenCalled();
  const restored = f.create(),
    nextActor = { ...actor, scope: 'lease:reload' };
  expect(await restored.status(f.saved.id, nextActor)).toEqual(archived);
  expect(await restored.commit(f.saved.id, nextActor)).toEqual(archived);
  expect(await restored.retry(f.saved.id, nextActor)).toEqual(archived);
  expect(await restored.prepare({ ...f.input, principal: nextActor })).toEqual(archived);
  await expect(restored.recover(f.saved.id, nextActor)).rejects.toMatchObject({
    code: 'archived-unavailable',
  });
  await expect(restored.exportRecovery(f.saved.id, nextActor)).rejects.toMatchObject({
    code: 'archived-unavailable',
  });
  await expect(
    restored.commit(f.saved.id, { ...actor, owner: 'site:foreign' }),
  ).rejects.toMatchObject({ code: 'invalid-request' });
  await expect(restored.prepare({ ...f.input, folderName: 'Other folder' })).rejects.toMatchObject({
    code: 'invalid-request',
  });
  expect(f.env.events.length).toBe(events);
  expect(f.env.reads).toBe(reads);
  expect(sameEntry).not.toHaveBeenCalled();
});

it('allows the 33rd completed save after explicit archival and leaves capacity refusal ready, not storage-broken', async () => {
  const f = await completedArchiveFixture();
  for (let i = 1; i < 32; i++) {
    const p = await f.writer.prepare({ ...f.binding(`save-${i}`), mode: 'save' });
    await f.writer.commit(p.id, actor);
  }
  expect(f.store.value!.saves).toHaveLength(32);
  const events = f.env.events.length;
  await expect(f.writer.prepare({ ...f.binding('save-33'), mode: 'save' })).rejects.toMatchObject({
    code: 'capacity',
  });
  expect(f.env.events).toHaveLength(events);
  expect(f.writer.getSnapshot()).toMatchObject({ phase: 'ready', error: null });
  const review = await f.writer.reviewArchive(f.saved.id, actor);
  await f.writer.archive(review.id, actor, archiveConfirmation);
  const p = await f.writer.prepare({ ...f.binding('save-33'), mode: 'save' });
  expect((await f.writer.commit(p.id, actor)).verified).toBe(true);
  expect(f.store.value!.saves).toHaveLength(32);
  expect(f.store.value!.archives).toHaveLength(1);
}, 30000);

it('refuses prepared, writing, partial and recovering journals and active claims without removing any bytes', async () => {
  const f = await completedArchiveFixture();
  const journal = f.store.value!.saves[0];
  const events = f.env.events.length;
  for (const phase of ['prepared', 'writing', 'partial', 'recovering'] as const) {
    journal.phase = phase;
    await expect(f.writer.reviewArchive(journal.id, actor)).rejects.toMatchObject({
      code: 'conflict',
    });
  }
  journal.phase = 'complete';
  journal.claim = { id: 'claim-held', until: 20000 };
  await expect(f.writer.reviewArchive(journal.id, actor)).rejects.toMatchObject({
    code: 'conflict',
  });
  expect(f.store.value!.archives).toHaveLength(0);
  expect(f.store.value!.saves[0].files[0].after.size).toBeGreaterThan(0);
  expect(f.env.events).toHaveLength(events);
});

it('binds archive review to fresh phase, metadata and envelope revision across stale/concurrent writers', async () => {
  const f = await completedArchiveFixture(),
    other = f.create();
  await other.hydrate();
  const first = await f.writer.reviewArchive(f.saved.id, actor);
  await other.registerDirectory(f.root);
  await expect(f.writer.archive(first.id, actor, archiveConfirmation)).rejects.toMatchObject({
    code: 'conflict',
  });
  expect(f.store.value!.saves).toHaveLength(1);
  const stale = await f.writer.reviewArchive(f.saved.id, actor),
    winner = await other.reviewArchive(f.saved.id, actor);
  await other.archive(winner.id, actor, archiveConfirmation);
  await expect(f.writer.archive(stale.id, actor, archiveConfirmation)).rejects.toMatchObject({
    code: 'conflict',
  });
  expect(f.store.value!.archives).toHaveLength(1);
});

it('recovers a lost archive readback through the same receipt without another removal or filesystem call', async () => {
  const f = await completedArchiveFixture(),
    review = await f.writer.reviewArchive(f.saved.id, actor);
  const reads = f.env.reads,
    events = f.env.events.length;
  f.store.state.failReadback = true;
  await expect(f.writer.archive(review.id, actor, archiveConfirmation)).rejects.toMatchObject({
    code: 'persistence',
  });
  expect(f.store.value!.saves).toHaveLength(0);
  expect(f.store.value!.archives).toHaveLength(1);
  await f.writer.retryStorage();
  const writes = f.store.state.writes;
  expect(
    await f.writer.archive(review.id, { ...actor, scope: 'lease:recovered' }, archiveConfirmation),
  ).toMatchObject({ archived: true, verified: true });
  expect(f.store.state.writes).toBe(writes);
  expect(f.env.reads).toBe(reads);
  expect(f.env.events).toHaveLength(events);
});

it('migrates legacy v1 envelopes in memory without rewriting or dropping journals and fences duplicate owner/request IDs across archives', async () => {
  const f = await completedArchiveFixture(),
    current = f.store.value!;
  const { archives: _archives, ...legacy } = current;
  const migrated = parseDirectoryWriterEnvelope({ ...legacy, version: 1 });
  expect(migrated.version).toBe(2);
  expect(migrated.archives).toEqual([]);
  expect(migrated.saves[0].files[0].after).toBe(current.saves[0].files[0].after);
  const review = await f.writer.reviewArchive(f.saved.id, actor);
  await f.writer.archive(review.id, actor, archiveConfirmation);
  expect(() => parseDirectoryWriterEnvelope({ ...f.store.value!, saves: current.saves })).toThrow(
    /Duplicate/,
  );
  expect(() => parseDirectoryWriterEnvelope({ ...legacy, version: 1, archives: [] })).toThrow();
});

it('keeps compact archive capacity separate, bounded and non-sticky without evicting existing receipts', async () => {
  const f = await completedArchiveFixture(),
    review = await f.writer.reviewArchive(f.saved.id, actor);
  await f.writer.archive(review.id, actor, archiveConfirmation);
  const template = f.store.value!.archives[0];
  const p = await f.writer.prepare({ ...f.binding('another-save'), mode: 'save' });
  await f.writer.commit(p.id, actor);
  const smallFiles = template.receipt.files.filter((file) =>
    /^(config\.xml|fusionproject\.json)$/i.test(file.path),
  );
  f.store.value!.archives = Array.from({ length: MAX_DIRECTORY_ARCHIVES }, (_, i) => ({
    ...structuredClone(template),
    requestId: `archive-request-${i}`,
    reviewId: `archive-review-${i}`,
    projectKey: 'small-key',
    receipt: {
      ...structuredClone(template.receipt),
      id: `archive-save-${i}`,
      files: smallFiles,
      introduced: smallFiles.filter((file) => file.action === 'create').map((file) => file.path),
      restored: [],
    },
  }));
  parseDirectoryWriterEnvelope(f.store.value);
  const terminal = await f.writer.reviewArchive(p.id, actor),
    reads = f.env.reads,
    events = f.env.events.length;
  await expect(f.writer.archive(terminal.id, actor, archiveConfirmation)).rejects.toMatchObject({
    code: 'capacity',
  });
  expect(f.writer.getSnapshot()).toMatchObject({ phase: 'ready', error: null });
  expect(f.store.value!.archives).toHaveLength(MAX_DIRECTORY_ARCHIVES);
  expect(f.store.value!.saves).toHaveLength(1);
  expect(f.env.reads).toBe(reads);
  expect(f.env.events).toHaveLength(events);
  const oversized = {
    ...f.store.value!,
    archives: f.store.value!.archives.map((a) => ({ ...a, projectKey: 'x'.repeat(4096) })),
  };
  expect(() => assertDirectoryWriterCapacity(oversized)).toThrow(/16 MiB/);
}, 30000);

it('archives either verified recovery terminal without changing introduced/restored outcomes or touching the folder', async () => {
  for (const preexisting of [false, true]) {
    const f = setup(),
      { writer, rootId } = await initialize(f);
    if (preexisting) {
      const folder = f.root.directory('Recovered project');
      for (const file of projectFiles(source('Before'))) folder.file(file.path, file.content);
    }
    const p = await writer.prepare({
      ...f.binding('recover-terminal'),
      mode: 'save-as',
      rootId,
      folderName: 'Recovered project',
    });
    await writer.commit(p.id, actor, { allowOverwrite: true });
    const recovered = await writer.recover(p.id, actor);
    expect(recovered.phase).toBe(preexisting ? 'recovered' : 'recovered-with-new-files');
    const events = f.env.events.length,
      reads = f.env.reads;
    const review = await writer.reviewArchive(p.id, actor),
      archived = await writer.archive(review.id, actor, archiveConfirmation);
    expect(archived).toMatchObject({
      phase: recovered.phase,
      verified: true,
      recoveryAvailable: false,
    });
    expect(archived.introduced).toEqual(recovered.introduced);
    expect(archived.restored).toEqual(recovered.restored);
    expect(f.env.events).toHaveLength(events);
    expect(f.env.reads).toBe(reads);
  }
});

it('refuses a changed terminal manifest even if an injected backend fails to advance its revision', async () => {
  const f = await completedArchiveFixture(),
    review = await f.writer.reviewArchive(f.saved.id, actor);
  f.store.value!.saves[0].error = 'Changed terminal metadata';
  await expect(f.writer.archive(review.id, actor, archiveConfirmation)).rejects.toMatchObject({
    code: 'conflict',
  });
  expect(f.store.value!.saves).toHaveLength(1);
  expect(f.store.value!.archives).toHaveLength(0);
});
