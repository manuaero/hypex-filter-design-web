// @vitest-environment jsdom
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { newProject, type Project, type Slot } from '../src/domain/model';
import type { ProjectReplacementIntent } from '../src/application/native-project-open';
import { exportHfd } from '../src/domain/files';
import * as projectIo from '../src/domain/project-io';
import { prepareFileImport } from '../src/application/file-workflows';
import { createToolExecutor, type DocumentState, type ToolAdapter } from '../src/application/tools';
import {
  createProjectSources,
  type ProjectDirectoryHandle,
  type ProjectFileHandle,
  type ProjectOpenReceipt,
  type ProjectSourcesBackend,
  type ProjectSourcesEnvelope,
} from '../src/application/project-sources';
import { assertProjectSourcesWrite } from '../src/application/project-sources-format';
import { createWorkspaceProjectSources } from '../src/application/browser-project-sources';
import { createWorkspaceStore } from '../src/state/workspace';
import {
  readDirectoryProjectOpen,
  readDirectoryProject,
} from '../src/application/directory-project-source';

const library = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../src/hardware/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/hardware/storage')>()),
  getProject: library.get,
}));

beforeAll(() => vi.stubGlobal('Blob', NodeBlob));
afterAll(() => vi.unstubAllGlobals());
const native = () => {
  const project = newProject('Native bytes');
  project.hfdSelectedPreset = 3;
  project.hfdSelectedGroupId = 2;
  project.presets[0].channels[1].gain = 24;
  project.presets[0].channels[1].additionalGain = 10;
  return { project, text: exportHfd(project) };
};
function toolFixture() {
  let state: DocumentState = {
    documents: { left: newProject('Left'), right: newProject('Right') },
    slot: 'left',
    preset: 0,
    channel: 0,
    filter: 0,
    linkedEdits: false,
    linkedControls: false,
  };
  const replaced = vi.fn();
  const adapter: ToolAdapter = {
    state: () => state,
    edit: (slots, apply) => {
      const next = structuredClone(state.documents);
      for (const slot of slots) apply(next[slot]);
      state = { ...state, documents: next };
    },
    choose: (patch) => {
      state = { ...state, ...patch };
    },
    undo() {},
    redo() {},
    connections: () => ({}),
    connect: async () => {},
    disconnect: async () => {},
    refresh: async () => {},
    operate: async (_label, action) => action(),
    message() {},
    progress() {},
    view() {},
    documentsReplaced: replaced,
  };
  return {
    execute: createToolExecutor(adapter),
    state: () => state,
    replaced,
    adapter,
    publishDocuments: (documents: DocumentState['documents']) => {
      state = { ...state, documents };
    },
  };
}

function roleWriter(f: ReturnType<typeof toolFixture>) {
  const publish = vi.fn<NonNullable<ToolAdapter['editByRole']>>((slots, apply) => {
    const next = structuredClone(f.state().documents);
    for (const slot of slots) apply(next[slot], slot);
    // The fixture only publishes after every explicit-role proposal succeeds.
    f.publishDocuments(next);
  });
  f.adapter.editByRole = publish;
  return publish;
}

it.each(['xml', 'folder'] as const)(
  'prepares and validates every %s role before one explicit-role publication',
  async (format) => {
    const f = toolFixture(),
      incoming = native(),
      before = structuredClone(f.state().documents),
      expected: Partial<Record<Slot, Project>> = {};
    const publish = roleWriter(f),
      legacyEdit = vi.fn(f.adapter.edit);
    f.adapter.edit = legacyEdit;
    f.adapter.prepareProjectOpen = vi.fn(
      (project: Project, slot: Slot, intent: ProjectReplacementIntent) => {
        expect(f.state().documents).toEqual(before);
        expect(intent).toEqual({ kind: 'native-file-open', route: 'dialog' });
        const preset = slot === 'left' ? 0 : 2;
        project.name = `${slot} prepared`;
        project.hfdSelectedPreset = preset + 1;
        project.presets[preset].channels[1].gain = slot === 'left' ? 14 : -2;
        expected[slot] = structuredClone(project);
        return project;
      },
    );
    const result =
      format === 'xml'
        ? await f.execute('fusion_project_import', { target: 'both', content: incoming.text })
        : await f.execute('fusion_project_import_folder', {
            target: 'both',
            name: 'Native folder',
            files: [{ path: 'Config.xml', content: incoming.text }],
          });
    expect(result).toMatchObject({ ok: true });
    expect(f.adapter.prepareProjectOpen).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(legacyEdit).not.toHaveBeenCalled();
    expect(
      Math.max(...vi.mocked(f.adapter.prepareProjectOpen).mock.invocationCallOrder),
    ).toBeLessThan(publish.mock.invocationCallOrder[0]);
    expect(f.state().documents).toEqual(expected);
    expect(f.state().documents.left.hfdSelectedPreset).toBe(1);
    expect(f.state().documents.right.hfdSelectedPreset).toBe(3);
    expect(f.state().documents.left.presets[0].channels[1].gain).toBe(14);
    expect(f.state().documents.right.presets[0].channels[1].gain).toBe(24);
    expect(f.state().documents.right.presets[2].channels[1].gain).toBe(-2);
    expect(f.replaced).toHaveBeenCalledExactlyOnceWith(['left', 'right'], {
      kind: 'native-file-open',
      route: 'dialog',
    });
  },
);

it.each(['nonfinite', 'invalid-links', 'throw'] as const)(
  'a %s Right preparation refuses all replacement before publication',
  async (failure) => {
    const f = toolFixture(),
      before = structuredClone(f.state().documents),
      publish = roleWriter(f),
      legacyEdit = vi.fn(f.adapter.edit);
    f.adapter.edit = legacyEdit;
    f.adapter.prepareProjectOpen = vi.fn((project: Project, slot: Slot) => {
      project.name = `${slot} prepared`;
      if (slot === 'right') {
        if (failure === 'throw') throw Error('Right preparation refused');
        if (failure === 'nonfinite') project.presets[0].channels[0].gain = NaN;
        else project.presets[0].channels[0].linkedTo = 0;
      }
      return project;
    });
    expect(
      await f.execute('fusion_project_import', { target: 'both', content: native().text }),
    ).toMatchObject({ ok: false });
    expect(f.adapter.prepareProjectOpen).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
    expect(legacyEdit).not.toHaveBeenCalled();
    expect(f.replaced).not.toHaveBeenCalled();
    expect(f.state().documents).toEqual(before);
  },
);

it('refuses prepared Both replacement when an explicit-role writer is unavailable', async () => {
  const f = toolFixture(),
    before = structuredClone(f.state().documents);
  f.adapter.edit = vi.fn(f.adapter.edit);
  f.adapter.prepareProjectOpen = vi.fn((project: Project) => project);
  expect(
    await f.execute('fusion_project_import', { target: 'both', content: native().text }),
  ).toMatchObject({ ok: false });
  expect(f.adapter.edit).not.toHaveBeenCalled();
  expect(f.adapter.prepareProjectOpen).not.toHaveBeenCalled();
  expect(f.replaced).not.toHaveBeenCalled();
  expect(f.state().documents).toEqual(before);
});

it('single-role preparation can use the legacy atomic writer without flattening a peer', async () => {
  const f = toolFixture(),
    peer = structuredClone(f.state().documents.left);
  f.adapter.prepareProjectOpen = vi.fn((project: Project, slot: Slot) => {
    expect(slot).toBe('right');
    project.hfdSelectedPreset = 2;
    project.presets[0].channels[1].gain = 14;
    return project;
  });
  expect(
    await f.execute('fusion_project_import', { target: 'right', content: native().text }),
  ).toMatchObject({ ok: true });
  expect(f.adapter.prepareProjectOpen).toHaveBeenCalledTimes(1);
  expect(f.state().documents.right.hfdSelectedPreset).toBe(2);
  expect(f.state().documents.right.presets[0].channels[1].gain).toBe(14);
  expect(f.state().documents.left).toEqual(peer);
});

it('snapshot preparation keeps exact per-role raw coefficients, provenance and cache interpretation', async () => {
  const f = toolFixture(),
    incoming = native().project,
    publish = roleWriter(f),
    vectors: Partial<Record<Slot, Project>> = {};
  incoming.sourceXml = native().text;
  incoming.presets[0].channels[1].coefficientCache = 'unresolved';
  f.adapter.prepareProjectOpen = vi.fn(
    (project: Project, slot: Slot, intent: ProjectReplacementIntent) => {
      expect(intent).toEqual({ kind: 'snapshot' });
      expect(project).toEqual(incoming);
      const filter = project.presets[0].channels[1].filters[0];
      filter.kind = 'raw';
      filter.coefficients = {
        b0: slot === 'left' ? 0.25 : 0.75,
        b1: 0.1,
        b2: 0.02,
        f1: 0.3,
        f2: -0.1,
      };
      filter.provenance = 'panel';
      filter.sourceId = `${slot}-retained-cache`;
      vectors[slot] = structuredClone(project);
      return project;
    },
  );
  expect(
    await f.execute('fusion_project_import', { target: 'both', content: JSON.stringify(incoming) }),
  ).toMatchObject({ ok: true });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(f.state().documents).toEqual(vectors);
  expect(f.state().documents.left.presets[0].channels[1].coefficientCache).toBe('unresolved');
  expect(f.state().documents.right.presets[0].channels[1].coefficientCache).toBe('unresolved');
});

it('direct native bytes tag the dialog route while JSON carrying sourceXml remains a snapshot', async () => {
  const incoming = native();
  const f = toolFixture();
  expect(
    await f.execute('fusion_project_import', { target: 'left', content: incoming.text }),
  ).toMatchObject({ ok: true });
  expect(f.replaced).toHaveBeenLastCalledWith(['left'], {
    kind: 'native-file-open',
    route: 'dialog',
  });
  const snapshot = { ...incoming.project, sourceXml: incoming.text };
  expect(
    await f.execute('fusion_project_import', {
      target: 'right',
      content: JSON.stringify(snapshot),
    }),
  ).toMatchObject({ ok: true });
  expect(f.replaced).toHaveBeenLastCalledWith(['right'], { kind: 'snapshot' });
  expect(f.state().documents.right.presets[0].channels[1].gain).toBe(24);
});

it('folder outcome reports the actually used validated sidecar or native fallback', () => {
  const files = projectIo.projectFiles(native().project);
  expect(projectIo.importProjectFolderOpen(files).format).toBe('browser-snapshot');
  const stale = files.map((file) =>
    file.path === 'Config.xml'
      ? { ...file, content: file.content.replace('selectedpreset="3"', 'selectedpreset="2"') }
      : file,
  );
  expect(projectIo.importProjectFolderOpen(stale).format).toBe('hfd-native');
});

it('verified project preparation carries byte-derived intent without changing its passive imported model', async () => {
  const incoming = native();
  for (const [text, expected] of [
    [incoming.text, { kind: 'native-file-open', route: 'dialog' }],
    [JSON.stringify({ ...incoming.project, sourceXml: incoming.text }), { kind: 'snapshot' }],
  ] as const) {
    const prepared = await prepareFileImport(
      { workflow: 'project', parameters: { target: 'left' }, expectedRevision: 0 },
      [{ path: 'input.txt', blob: new Blob([text]) }],
    );
    expect(prepared.projectOpen).toEqual(expected);
    expect(prepared.result).toMatchObject({ projectOpen: expected });
    const result = newProject();
    prepared.apply(result);
    expect(result.presets[0].channels[1].gain).toBe(24);
    expect(result.hfdSelectedPreset).toBe(3);
  }
});

class FileHandle implements ProjectFileHandle {
  readonly kind = 'file' as const;
  getFile = vi.fn(
    async () => new NodeFile([this.text], this.name, { lastModified: 1000 }) as unknown as File,
  );
  constructor(
    readonly name: string,
    public text: string,
  ) {}
}
class Directory implements ProjectDirectoryHandle {
  readonly kind = 'directory' as const;
  permission: PermissionState = 'granted';
  children = new Map<string, Directory | FileHandle>();
  constructor(readonly name: string) {}
  queryPermission = vi.fn(async () => this.permission);
  isSameEntry = async (other: ProjectDirectoryHandle) => this === other;
  getDirectoryHandle = async (name: string) => {
    const child = this.children.get(name);
    if (!(child instanceof Directory)) throw Error('Missing folder');
    return child;
  };
  async *values() {
    yield* this.children.values();
  }
  add(child: Directory | FileHandle) {
    this.children.set(child.name, child);
    return this;
  }
}
function sourcesFixture(files: projectIo.ProjectFile[]) {
  const root = new Directory('Database'),
    folder = new Directory('Design');
  for (const file of files) folder.add(new FileHandle(file.path, file.content));
  root.add(folder);
  let stored: ProjectSourcesEnvelope | null = null,
    revision = 0;
  const copy = (value: ProjectSourcesEnvelope | null) =>
    value && {
      ...structuredClone({ ...value, roots: [] }),
      roots: value.roots.map((r) => ({ ...r })),
    };
  const backend: ProjectSourcesBackend = {
    read: async () => copy(stored),
    write: async (next, expected) => {
      assertProjectSourcesWrite(stored, next, expected);
      stored = copy(next);
    },
  };
  const receipts = new Map<string, ProjectOpenReceipt>(),
    accepted: unknown[] = [];
  let sequence = 0;
  const service = createProjectSources({
    backend,
    resolveLibrary: async () => {
      const incoming = native();
      return { ...incoming.project, sourceXml: incoming.text };
    },
    commit: async (binding, _project, commitId, metadata) => {
      if (binding.expectedRevision !== revision) throw Error('Stale revision');
      accepted.push(structuredClone(metadata));
      const receipt = { commitId, revision: ++revision, result: { ...metadata } };
      receipts.set(commitId, receipt);
      return structuredClone(receipt);
    },
    lookup: async (id) => structuredClone(receipts.get(id)),
    id: () => `local-${++sequence}`,
  });
  const principal = { owner: 'browser:local', scope: 'ui:one' };
  return {
    service,
    backend,
    root,
    folder,
    accepted,
    receipts,
    principal,
    input: (sourceId: string, requestId = 'open-1') => ({
      sourceId,
      requestId,
      principal,
      target: 'left' as const,
      expectedRevision: 0,
    }),
    stale: () => {
      revision++;
    },
  };
}
it('fresh directory-native open carries inner intent and durable replay does not emit another intent', async () => {
  const f = sourcesFixture([{ path: 'Config.xml', content: native().text }]);
  const rootId = await f.service.registerDirectory(f.root),
    listing = await f.service.list(rootId),
    input = f.input(listing.entries[0].id);
  const token = await f.service.prepareOpen(input);
  expect(f.accepted).toEqual([]);
  expect(await f.service.commitOpen(token)).toMatchObject({ replayed: false });
  expect(f.accepted).toEqual([
    expect.objectContaining({ projectOpen: { kind: 'native-file-open', route: 'inner' } }),
  ]);
  expect(await f.service.open(input)).toMatchObject({ replayed: true });
  expect(f.accepted).toHaveLength(1);
});

it.each(['missing', 'invalid', 'stale', 'legacy'] as const)(
  'a %s browser sidecar follows the actual native fallback',
  (mode) => {
    let files = projectIo.projectFiles(native().project);
    if (mode === 'missing') files = files.filter((file) => file.path !== 'FusionProject.json');
    else
      files = files.map((file) =>
        file.path !== 'FusionProject.json'
          ? file
          : {
              ...file,
              content:
                mode === 'invalid'
                  ? '{invalid'
                  : mode === 'legacy'
                    ? JSON.stringify(native().project)
                    : file.content.replace('selectedpreset=\\"3\\"', 'selectedpreset=\\"2\\"'),
            },
      );
    const opened = projectIo.importProjectFolderOpen(files);
    expect(opened.format).toBe('hfd-native');
    expect(opened.project.presets[0].channels[1].gain).toBe(24);
    expect(opened.project.hfdSelectedPreset).toBe(3);
    if (mode !== 'missing')
      expect(opened.project.warnings.join(' ')).toContain('Ignored FusionProject.json');
    // The compatibility API retains the same passive imported values.
    expect(projectIo.importProjectFolder(files).hfdSelectedPreset).toBe(3);
  },
);

it('Config.xml filename alone cannot turn validated JSON sourceXml into native intent', () => {
  const incoming = native();
  const opened = projectIo.importProjectFolderOpen([
    {
      path: 'Config.xml',
      content: JSON.stringify({ ...incoming.project, sourceXml: incoming.text }),
    },
  ]);
  expect(opened.format).toBe('browser-snapshot');
  expect(opened.project.sourceXml).toBe(incoming.text);
});

it('malformed native Config is refused even when a browser sidecar is present', () => {
  const files = projectIo
    .projectFiles(native().project)
    .map((file) => (file.path === 'Config.xml' ? { ...file, content: '<project/>' } : file));
  expect(() => projectIo.importProjectFolderOpen(files)).toThrow();
});

it.each(['native', 'snapshot', 'fallback'] as const)(
  'verified folder %s outcome carries the actual dialog/snapshot intent',
  async (mode) => {
    const incoming = native();
    let files = projectIo.projectFiles(incoming.project);
    if (mode === 'native') files = files.filter((file) => file.path !== 'FusionProject.json');
    if (mode === 'fallback')
      files = files.map((file) =>
        file.path === 'FusionProject.json' ? { ...file, content: '{}' } : file,
      );
    const opened = await prepareFileImport(
      { workflow: 'folder', parameters: { target: 'both' }, expectedRevision: 4 },
      files.map((file) => ({ path: file.path, blob: new Blob([file.content]) })),
    );
    const expected =
      mode === 'snapshot' ? { kind: 'snapshot' } : { kind: 'native-file-open', route: 'dialog' };
    expect(opened.projectOpen).toEqual(expected);
    expect(opened.result).toMatchObject({ projectOpen: expected });
    const target = newProject();
    opened.apply(target);
    expect(target.hfdSelectedPreset).toBe(3);
    expect(target.presets[0].channels[1].gain).toBe(24);
  },
);

it.each(['projectOpen', 'route', 'format'] as const)(
  'public direct and verified import reject the caller-owned %s flag',
  async (field) => {
    const incoming = native(),
      f = toolFixture(),
      before = structuredClone(f.state().documents);
    expect(
      await f.execute('fusion_project_import', {
        target: 'left',
        content: incoming.text,
        [field]: 'native-file-open',
      }),
    ).toMatchObject({ ok: false });
    await expect(
      prepareFileImport(
        {
          workflow: 'project',
          expectedRevision: 0,
          parameters: { target: 'left', [field]: 'native-file-open' },
        },
        [{ path: 'input.xml', blob: new Blob([incoming.text]) }],
      ),
    ).rejects.toThrow();
    expect(f.state().documents).toEqual(before);
    expect(f.replaced).not.toHaveBeenCalled();
  },
);

it('direct native/folder classification never emits replacement intent after a refused edit', async () => {
  const f = toolFixture();
  f.adapter.edit = vi.fn(() => {
    throw Error('Atomic refusal');
  });
  const files = [{ path: 'Config.xml', content: native().text }];
  for (const [command, args] of [
    ['fusion_project_import', { target: 'left', content: native().text }],
    ['fusion_project_import_folder', { target: 'left', name: 'Native folder', files }],
  ] as const)
    expect(await f.execute(command, args)).toMatchObject({ ok: false });
  expect(f.adapter.edit).toHaveBeenCalledTimes(2);
  expect(f.replaced).not.toHaveBeenCalled();
});

it('new-project carries its separate trusted replacement kind', async () => {
  const f = toolFixture();
  expect(
    await f.execute('fusion_project_new', { target: 'both', name: 'Fresh design' }),
  ).toMatchObject({ ok: true });
  expect(f.replaced).toHaveBeenCalledExactlyOnceWith(['left', 'right'], { kind: 'new-project' });
});

it.each(['sidecar', 'fallback'] as const)(
  'direct folder %s import publishes only its actually consumed replacement kind',
  async (mode) => {
    const f = toolFixture();
    let files = projectIo.projectFiles(native().project);
    if (mode === 'fallback')
      files = files.map((file) =>
        file.path === 'FusionProject.json' ? { ...file, content: '{}' } : file,
      );
    expect(
      await f.execute('fusion_project_import_folder', {
        target: 'both',
        name: 'Native folder',
        files,
      }),
    ).toMatchObject({ ok: true });
    expect(f.replaced).toHaveBeenCalledExactlyOnceWith(
      ['left', 'right'],
      mode === 'sidecar' ? { kind: 'snapshot' } : { kind: 'native-file-open', route: 'dialog' },
    );
  },
);

it('direct library open remains snapshot-origin when its saved project carries native XML', async () => {
  const f = toolFixture(),
    incoming = native();
  library.get.mockResolvedValue({
    id: 'saved',
    project: { ...incoming.project, sourceXml: incoming.text },
  });
  expect(await f.execute('fusion_library_open', { target: 'right', id: 'saved' })).toMatchObject({
    ok: true,
  });
  expect(f.replaced).toHaveBeenCalledExactlyOnceWith(['right'], { kind: 'snapshot' });
  expect(f.state().documents.right.sourceXml).toBe(incoming.text);
});

it.each(['native', 'sidecar', 'fallback'] as const)(
  'fresh directory %s reads retain trusted used-format while legacy readers remain passive',
  async (mode) => {
    let files = projectIo.projectFiles(native().project);
    if (mode === 'native') files = files.filter((file) => file.path !== 'FusionProject.json');
    if (mode === 'fallback')
      files = files.map((file) =>
        file.path === 'FusionProject.json' ? { ...file, content: '{}' } : file,
      );
    const f = sourcesFixture(files);
    const decoded = await readDirectoryProjectOpen(f.root, 'Design');
    expect(decoded.format).toBe(mode === 'sidecar' ? 'browser-snapshot' : 'hfd-native');
    expect((await readDirectoryProject(f.root, 'Design')).presets[0].channels[1].gain).toBe(24);
    const rootId = await f.service.registerDirectory(f.root),
      listing = await f.service.list(rootId);
    await f.service.open(f.input(listing.entries[0].id));
    expect(f.accepted).toEqual([
      expect.objectContaining({
        projectOpen:
          mode === 'sidecar' ? { kind: 'snapshot' } : { kind: 'native-file-open', route: 'inner' },
      }),
    ]);
  },
);

it('library/legacy Project producer remains a snapshot even when it preserves native sourceXml', async () => {
  const f = sourcesFixture([]),
    id = await f.service.rememberLibrary({ id: 'saved', label: 'Snapshot' });
  const result = await f.service.open(f.input(id));
  expect(f.accepted).toEqual([expect.objectContaining({ projectOpen: { kind: 'snapshot' } })]);
  expect(result.receipt.result).toEqual({
    workflow: 'source-open',
    sourceId: id,
    target: 'left',
    expectedRevision: 0,
    requestId: 'open-1',
  });
});

it('stale destination, expired grant and forged prepared token emit no admitted intent', async () => {
  const f = sourcesFixture([{ path: 'Config.xml', content: native().text }]);
  const rootId = await f.service.registerDirectory(f.root),
    sourceId = (await f.service.list(rootId)).entries[0].id;
  const token = await f.service.prepareOpen(f.input(sourceId));
  f.root.permission = 'denied';
  await expect(f.service.commitOpen(token)).rejects.toMatchObject({ code: 'needs-human-grant' });
  expect(f.accepted).toEqual([]);
  f.root.permission = 'granted';
  f.stale();
  await expect(f.service.commitOpen(token)).rejects.toMatchObject({ code: 'commit-failed' });
  await expect(
    f.service.commitOpen({} as Parameters<typeof f.service.commitOpen>[0]),
  ).rejects.toMatchObject({ code: 'invalid-request' });
  expect(f.accepted).toEqual([]);
});

it('five-field historical source receipts remain replay-only without reading or emitting format', async () => {
  const f = sourcesFixture([{ path: 'Config.xml', content: native().text }]);
  const rootId = await f.service.registerDirectory(f.root),
    sourceId = (await f.service.list(rootId)).entries[0].id,
    input = f.input(sourceId);
  const receipt = {
    commitId: 'source-open:browser:local:open-1',
    revision: 1,
    result: {
      workflow: 'source-open',
      sourceId,
      target: 'left',
      expectedRevision: 0,
      requestId: 'open-1',
    },
  };
  f.receipts.set(receipt.commitId, receipt);
  const reads = [...f.folder.children.values()]
    .filter((file): file is FileHandle => file instanceof FileHandle)
    .map((file) => file.getFile.mock.calls.length);
  expect(await f.service.open(input)).toMatchObject({ replayed: true, receipt });
  expect(f.accepted).toEqual([]);
  expect(
    [...f.folder.children.values()]
      .filter((file): file is FileHandle => file instanceof FileHandle)
      .map((file) => file.getFile.mock.calls.length),
  ).toEqual(reads);
});

it('workspace-backed source commit receives fresh intent but recovering its receipt after Undo does not reapply it', async () => {
  const f = sourcesFixture([{ path: 'Config.xml', content: native().text }]);
  let stored: unknown = null;
  const workspace = createWorkspaceStore({
    read: async () => structuredClone(stored),
    write: async (value) => {
      stored = structuredClone(value);
    },
    readLegacy: () => null,
  });
  await workspace.persistence.hydrate();
  const commits = vi.fn(
    (...args: Parameters<ReturnType<typeof workspace.store.getState>['commitFileImport']>) =>
      workspace.store.getState().commitFileImport(...args),
  );
  const sourceOptions = {
    backend: f.backend,
    getWorkspace: () => ({
      commitFileImport: commits,
      lookupFileCommit: workspace.store.getState().lookupFileCommit,
    }),
    id: (() => {
      let sequence = 0;
      return () => `backed-${++sequence}`;
    })(),
  };
  const service = createWorkspaceProjectSources(sourceOptions);
  const rootId = await service.registerDirectory(f.root),
    sourceId = (await service.list(rootId)).entries[0].id,
    input = { ...f.input(sourceId), requestId: 'backed' };
  const before = structuredClone(workspace.store.getState().documents);
  const first = await service.open(input);
  expect(commits.mock.calls[0][5]).toMatchObject({
    projectOpen: { kind: 'native-file-open', route: 'inner' },
  });
  workspace.store.getState().undo();
  await workspace.persistence.flush();
  expect(workspace.store.getState().documents).toEqual(before);
  const reloaded = createWorkspaceProjectSources(sourceOptions);
  expect(await reloaded.open(input)).toMatchObject({ replayed: true, receipt: first.receipt });
  expect(commits).toHaveBeenCalledTimes(1);
  expect(workspace.store.getState().documents).toEqual(before);
});
