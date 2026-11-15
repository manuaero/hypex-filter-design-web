// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useProjectSourceOpen,
  type ProjectSourceOpener,
  type ProjectSourceOpenInput,
} from '../src/components/useProjectSourceOpen';
import {
  ProjectSourcesError,
  type ProjectSources,
  type ProjectOpenResult,
  type ProjectSourcesBackend,
  type ProjectSourcesEnvelope,
} from '../src/application/project-sources';
import { createWorkspaceProjectSources } from '../src/application/browser-project-sources';
import { assertProjectSourcesWrite } from '../src/application/project-sources-format';
import { createWorkspaceStore } from '../src/state/workspace';
import { assertWorkspaceWrite, type WorkspaceEnvelope } from '../src/state/persistence';
import { newProject } from '../src/domain/model';

const input: ProjectSourceOpenInput = {
  sourceId: 'opaque',
  target: 'right',
  expectedRevision: 0,
  requestId: 'fixed-request',
  principal: { owner: 'site:owner', scope: 'lease:one' },
};
const confirmed: ProjectOpenResult = {
  receipt: { commitId: 'confirmed', revision: 1, result: null },
  replayed: true,
  recentSaved: true,
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let host: HTMLDivElement, root: Root, opener: ProjectSourceOpener;
function Probe({ sources }: { sources: ProjectSources }) {
  opener = useProjectSourceOpen(sources);
  return null;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
const source = (open: ProjectSources['open']) => ({ open }) as ProjectSources;
async function mount(sources: ProjectSources) {
  await act(async () => root.render(<Probe sources={sources} />));
}
async function realFixture() {
  let disk: WorkspaceEnvelope | null = null,
    sourceDisk: ProjectSourcesEnvelope | null = null,
    failWrite = false;
  const workspace = createWorkspaceStore({
    read: async () => structuredClone(disk),
    readLegacy: () => null,
    write: async (next, expected) => {
      if (failWrite) throw new Error('Save failed after in-memory application');
      assertWorkspaceWrite(disk, expected, next);
      disk = structuredClone(next);
    },
  });
  await workspace.persistence.hydrate();
  const backend: ProjectSourcesBackend = {
    read: async () => structuredClone(sourceDisk),
    write: async (next, expected) => {
      assertProjectSourcesWrite(sourceDisk, next, expected);
      sourceDisk = structuredClone(next);
    },
  };
  const project = newProject('Imported exactly once'),
    commit = vi.fn(workspace.store.getState().commitFileImport);
  const sources = createWorkspaceProjectSources({
    backend,
    getWorkspace: () => ({
      commitFileImport: commit,
      lookupFileCommit: workspace.store.getState().lookupFileCommit,
    }),
    getLibraryProject: async () => ({ id: 'saved', name: project.name, utc: '', project }),
  });
  const sourceId = await sources.rememberLibrary({ id: 'saved', label: project.name });
  return {
    workspace,
    sources,
    project,
    commit,
    sourceId,
    set failWrite(value: boolean) {
      failWrite = value;
    },
  };
}

describe('shared human project-open recovery hook', () => {
  it('retries the original request after an in-memory apply/save failure and confirms one durable application', async () => {
    const f = await realFixture(),
      before = structuredClone(f.workspace.store.getState().documents);
    await mount(f.sources);
    f.failWrite = true;
    const original = { ...structuredClone(input), sourceId: f.sourceId };
    let error: unknown;
    await act(async () => {
      await opener.open(original).catch((e) => {
        error = e;
      });
    });
    expect(error).toMatchObject({ code: 'persistence' });
    expect(opener.pending).toEqual(original);
    expect(opener.busy).toBe(false);
    expect(f.workspace.store.getState().documents.right).toEqual(f.project);
    expect(f.workspace.persistence.getSnapshot().unsaved).toBe(true);
    expect(f.commit).toHaveBeenCalledTimes(1);
    original.target = 'left';
    original.expectedRevision = 99;
    original.principal.owner = 'changed';
    expect(opener.pending!.target).toBe('right');
    expect(Object.isFrozen(opener.pending)).toBe(true);
    expect(Object.isFrozen(opener.pending!.principal)).toBe(true);
    await act(async () => {
      await expect(opener.open({ ...input, sourceId: 'another' })).rejects.toThrow(
        /Retry or discard/,
      );
    });
    f.failWrite = false;
    await f.workspace.persistence.retry();
    let result: ProjectOpenResult | undefined;
    await act(async () => {
      result = await opener.retry();
    });
    expect(result?.replayed).toBe(true);
    expect(opener.pending).toBeUndefined();
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(f.workspace.store.getState().past).toHaveLength(1);
    expect(f.workspace.persistence.getSnapshot()).toMatchObject({ unsaved: false, phase: 'ready' });
    expect(f.workspace.store.getState().documents.left).toEqual(before.left);
    expect(f.workspace.store.getState().documents.right).toEqual(f.project);
  });
  it('Discard clears only retry metadata and never undoes the already applied design', async () => {
    const f = await realFixture();
    await mount(f.sources);
    f.failWrite = true;
    await act(async () => {
      await opener.open({ ...input, sourceId: f.sourceId }).catch(() => {});
    });
    const beforeDiscard = structuredClone(f.workspace.store.getState().documents),
      past = f.workspace.store.getState().past.length;
    await act(async () => {
      opener.discard();
      expect(opener.getStatus()).toEqual({ busy: false, pending: undefined });
    });
    expect(opener.pending).toBeUndefined();
    expect(f.workspace.store.getState().documents).toEqual(beforeDiscard);
    expect(f.workspace.store.getState().past).toHaveLength(past);
    expect(f.commit).toHaveBeenCalledTimes(1);
    f.failWrite = false;
    await f.workspace.persistence.retry();
  });
  it('locks synchronously, rejects duplicate busy requests and retries the identical captured input after an unknown failure', async () => {
    const gate = deferred<ProjectOpenResult>(),
      open = vi
        .fn<ProjectSources['open']>()
        .mockReturnValueOnce(gate.promise)
        .mockResolvedValue(confirmed);
    await mount(source(open));
    let running!: Promise<ProjectOpenResult>;
    const original = structuredClone(input);
    await act(async () => {
      running = opener.open(original);
      expect(opener.getStatus()).toMatchObject({ busy: true, pending: input });
      void running.catch(() => {});
      await expect(opener.open({ ...input, sourceId: 'other' })).rejects.toThrow(/already running/);
      await expect(opener.retry()).rejects.toThrow(/already running/);
      expect(() => opener.discard()).toThrow(/finish/);
    });
    original.target = 'left';
    original.principal.scope = 'changed';
    await act(async () => {
      gate.reject(new Error('Unknown response failure'));
      await running.catch(() => {});
    });
    expect(opener.pending).toEqual(input);
    expect(open).toHaveBeenCalledTimes(1);
    await act(async () => {
      await opener.retry();
    });
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[1][0]).toBe(open.mock.calls[0][0]);
    expect(open.mock.calls[1][0]).toEqual(input);
    expect(opener.pending).toBeUndefined();
  });
  it.each(['missing-source', 'invalid-project', 'needs-human-grant', 'source-changed'] as const)(
    'clears the retry after known pre-application %s refusal',
    async (code) => {
      const open = vi
        .fn<ProjectSources['open']>()
        .mockRejectedValueOnce(new ProjectSourcesError(code, 'Known refusal'))
        .mockResolvedValue(confirmed);
      await mount(source(open));
      await act(async () => {
        await opener.open(input).catch(() => {});
      });
      expect(opener.pending).toBeUndefined();
      expect(opener.busy).toBe(false);
      await act(async () => {
        await opener.open({ ...input, requestId: 'fresh' });
      });
      expect(open).toHaveBeenCalledTimes(2);
    },
  );
  it('keeps the original source service for a pending retry when the surrounding component changes service', async () => {
    const first = vi
        .fn<ProjectSources['open']>()
        .mockRejectedValueOnce(new Error('Uncertain'))
        .mockResolvedValue(confirmed),
      second = vi.fn<ProjectSources['open']>().mockResolvedValue(confirmed);
    await mount(source(first));
    await act(async () => {
      await opener.open(input).catch(() => {});
    });
    await mount(source(second));
    await act(async () => {
      await opener.retry();
    });
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).not.toHaveBeenCalled();
    expect(opener.pending).toBeUndefined();
  });
});

it('retains invalid-request receipt conflicts conservatively until explicit discard', async () => {
  const open = vi
    .fn<ProjectSources['open']>()
    .mockRejectedValue(
      new ProjectSourcesError('invalid-request', 'Durable receipt does not match'),
    );
  await mount(source(open));
  await act(async () => {
    await opener.open(input).catch(() => {});
  });
  expect(opener.pending).toEqual(input);
  expect(opener.getStatus()).toEqual({ pending: input, busy: false });
  await act(async () => {
    await expect(opener.open({ ...input, requestId: 'different' })).rejects.toThrow(
      /Retry or discard/,
    );
  });
  expect(open).toHaveBeenCalledTimes(1);
  await act(async () => {
    opener.discard();
    expect(opener.getStatus().pending).toBeUndefined();
  });
  expect(opener.pending).toBeUndefined();
});
