// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SourceBrowser from '../src/components/SourceBrowser';
import {
  createProjectSources,
  type ProjectDirectoryHandle,
  type ProjectSourcesEnvelope,
  type ProjectSourcesBackend,
  type ProjectSourcesOptions,
} from '../src/application/project-sources';
import { assertProjectSourcesWrite } from '../src/application/project-sources-format';
import { newProject } from '../src/domain/model';

const principal = { owner: 'browser:human', scope: 'ui:test' };
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  let stored: ProjectSourcesEnvelope | null = null,
    failRead = false,
    sequence = 0;
  const backend: ProjectSourcesBackend = {
    read: async () => {
      if (failRead) throw new Error('private browser path');
      return stored;
    },
    write: async (next, expected) => {
      assertProjectSourcesWrite(stored, next, expected);
      stored = {
        ...next,
        roots: next.roots.map((root) => ({ ...root })),
        sources: structuredClone(next.sources),
        recent: structuredClone(next.recent),
      };
    },
  };
  const project = newProject('Saved snapshot');
  const options: ProjectSourcesOptions = {
    backend,
    id: () => `opaque-${++sequence}`,
    resolveLibrary: async () => project,
    lookup: async () => undefined,
    commit: vi.fn(async (_binding, _project, commitId, result) => ({
      commitId,
      revision: 1,
      result: { ...result },
    })),
  };
  const sources = createProjectSources(options);
  return {
    sources,
    options,
    project,
    set failRead(value: boolean) {
      failRead = value;
    },
  };
}
function directory(name = 'Chosen database') {
  const handle: ProjectDirectoryHandle = {
    kind: 'directory',
    name,
    queryPermission: vi.fn(async (): Promise<PermissionState> => 'granted'),
    getDirectoryHandle: vi.fn(async () => {
      throw new Error('No projects');
    }),
    async *values() {},
    async isSameEntry(other) {
      return other === handle;
    },
  };
  return handle;
}
let host: HTMLDivElement, root: Root;
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
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;

describe('shared local SourceBrowser', () => {
  it('calls the human picker only after a click and registers a read-only capability without opening a document', async () => {
    const f = fixture(),
      handle = directory(),
      picker = vi.fn(async () => handle),
      onError = vi.fn();
    await act(async () =>
      root.render(
        <SourceBrowser
          sources={f.sources}
          captureOpen={() => ({ target: 'left', expectedRevision: 0, principal })}
          onError={onError}
          picker={picker}
        />,
      ),
    );
    expect(picker).not.toHaveBeenCalled();
    expect(host.textContent).toContain('No recent projects');
    await act(async () => button('Choose database folder…').click());
    expect(picker).toHaveBeenCalledExactlyOnceWith({
      mode: 'read',
      id: 'fusion-studio-project-database',
    });
    expect(f.sources.getSnapshot().roots[0].label).toBe('Chosen database');
    expect(handle.queryPermission).toHaveBeenCalledWith({ mode: 'read' });
    expect(host.textContent).toContain('No direct child folders contain Config.xml');
    expect(f.options.commit).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
  it('uses the same source service and captures the explicit role before a delayed fresh open', async () => {
    const f = fixture(),
      gate = deferred<ReturnType<typeof newProject> | undefined>();
    const options = { ...f.options, resolveLibrary: () => gate.promise },
      sources = createProjectSources(options);
    await sources.rememberLibrary({ id: 'saved', label: 'Saved snapshot' });
    let role: 'left' | 'right' = 'right';
    const captureOpen = vi.fn(() => ({ target: role, expectedRevision: 0, principal })),
      onOpened = vi.fn();
    await act(async () =>
      root.render(
        <SourceBrowser
          sources={sources}
          captureOpen={captureOpen}
          onError={vi.fn()}
          onOpened={onOpened}
        />,
      ),
    );
    const open = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Open recent Saved snapshot"]',
    )!;
    await act(async () => open.click());
    role = 'left';
    expect(captureOpen).toHaveBeenCalledTimes(1);
    expect(options.commit).not.toHaveBeenCalled();
    await act(async () => gate.resolve(f.project));
    expect(options.commit).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'right', expectedRevision: 0, principal }),
      f.project,
      expect.any(String),
      expect.objectContaining({ target: 'right' }),
    );
    expect(onOpened).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Library snapshot');
  });
  it('keeps chooser cancellation quiet and leaves the existing recent references intact', async () => {
    const f = fixture();
    await f.sources.rememberLibrary({ id: 'saved', label: 'Saved snapshot' });
    const before = f.sources.getSnapshot().recent;
    const onError = vi.fn(),
      picker = vi.fn(async () => {
        throw new DOMException('Cancelled', 'AbortError');
      });
    await act(async () =>
      root.render(
        <SourceBrowser
          sources={f.sources}
          captureOpen={() => ({ target: 'left', expectedRevision: 0, principal })}
          onError={onError}
          picker={picker}
        />,
      ),
    );
    await act(async () => button('Choose database folder…').click());
    expect(onError).not.toHaveBeenCalled();
    expect(f.sources.getSnapshot().recent).toEqual(before);
    expect(f.sources.getSnapshot().roots).toEqual([]);
  });
  it('shows expired read access as a human grant requirement without opening a picker automatically', async () => {
    const f = fixture(),
      handle = directory(),
      picker = vi.fn(async () => handle);
    await f.sources.registerDirectory(handle);
    vi.mocked(handle.queryPermission).mockResolvedValue('prompt');
    await act(async () =>
      root.render(
        <SourceBrowser
          sources={f.sources}
          captureOpen={() => ({ target: 'left', expectedRevision: 0, principal })}
          onError={vi.fn()}
          picker={picker}
        />,
      ),
    );
    expect(host.textContent).toContain('reauthorize');
    expect(host.textContent).toContain('no permission prompt');
    expect(picker).not.toHaveBeenCalled();
    expect(f.options.commit).not.toHaveBeenCalled();
  });
  it('exposes storage retry without a phantom saved state or automatic permission request', async () => {
    const f = fixture(),
      onError = vi.fn(),
      picker = vi.fn(async () => directory());
    f.failRead = true;
    await act(async () =>
      root.render(
        <SourceBrowser
          sources={f.sources}
          captureOpen={() => ({ target: 'left', expectedRevision: 0, principal })}
          onError={onError}
          picker={picker}
        />,
      ),
    );
    expect(host.querySelector('[role="alert"]')).toBeTruthy();
    expect(button('Retry local storage')).toBeTruthy();
    expect(button('Choose database folder…').disabled).toBe(true);
    f.failRead = false;
    await act(async () => button('Retry local storage').click());
    expect(f.sources.getSnapshot().phase).toBe('ready');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(picker).not.toHaveBeenCalled();
  });
});

it('removes the prior database rows while a newly selected database is still loading', async () => {
  const f = fixture(),
    rootA = await f.sources.registerDirectory(directory('Database A')),
    rootB = await f.sources.registerDirectory(directory('Database B'));
  await f.sources.selectRoot(rootA);
  const gate = deferred<import('../src/application/project-sources').ProjectSourceListing>();
  const listing = (
    rootId: string,
    label: string,
  ): import('../src/application/project-sources').ProjectSourceListing => ({
    rootId,
    entries: [{ id: rootId + '-project', rootId, kind: 'directory-project', label }],
    sort: { by: 'name', direction: 'ascending' },
    comparison: 'browser-locale',
    needsHumanGrant: false,
  });
  const list = vi
    .spyOn(f.sources, 'list')
    .mockImplementation(async (rootId) =>
      rootId === rootA ? listing(rootA, 'Only A') : gate.promise,
    );
  const open = vi.spyOn(f.sources, 'open'),
    onError = vi.fn();
  await act(async () =>
    root.render(
      <SourceBrowser
        sources={f.sources}
        captureOpen={() => ({ target: 'right', expectedRevision: 0, principal })}
        onError={onError}
      />,
    ),
  );
  const oldOpen = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Open folder project Only A"]',
  )!;
  expect(oldOpen).toBeTruthy();
  expect(oldOpen.disabled).toBe(false);
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Project database"]')!;
    select.value = rootB;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(list).toHaveBeenLastCalledWith(rootB, undefined);
  expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe(rootB);
  expect(host.querySelector('button[aria-label="Open folder project Only A"]')).toBeNull();
  expect(host.querySelectorAll('button[aria-label^="Open folder project"]')).toHaveLength(0);
  expect(host.textContent).toContain('Reading project folders');
  await act(async () => oldOpen.click());
  expect(open).not.toHaveBeenCalled();
  await act(async () => gate.resolve(listing(rootB, 'Only B')));
  expect(host.querySelector('button[aria-label="Open folder project Only A"]')).toBeNull();
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label="Open folder project Only B"]')!
      .disabled,
  ).toBe(false);
  expect(open).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});

it('offers the original open retry and disables fresh opens until that request is confirmed', async () => {
  const f = fixture();
  await f.sources.rememberLibrary({ id: 'saved', label: 'Saved snapshot' });
  const { ProjectSourcesError } = await import('../src/application/project-sources');
  const open = vi
    .spyOn(f.sources, 'open')
    .mockRejectedValueOnce(new ProjectSourcesError('persistence', 'Save could not be confirmed'))
    .mockImplementationOnce(async (request) => ({
      receipt: { commitId: request.requestId, revision: 1, result: null },
      replayed: true,
      recentSaved: true,
    }));
  const captureOpen = vi.fn(() => ({ target: 'right' as const, expectedRevision: 0, principal })),
    onOpened = vi.fn(),
    onError = vi.fn();
  await act(async () =>
    root.render(
      <SourceBrowser
        sources={f.sources}
        captureOpen={captureOpen}
        onError={onError}
        onOpened={onOpened}
      />,
    ),
  );
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('button[aria-label="Open recent Saved snapshot"]')!
      .click(),
  );
  expect(host.textContent).toContain('This open was not confirmed');
  expect(host.textContent).toContain('Right');
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label="Open recent Saved snapshot"]')!
      .disabled,
  ).toBe(true);
  expect(button('Retry same open')).toBeTruthy();
  expect(button('Discard retry')).toBeTruthy();
  await act(async () => button('Retry same open').click());
  expect(open).toHaveBeenCalledTimes(2);
  expect(open.mock.calls[1][0]).toEqual(open.mock.calls[0][0]);
  expect(captureOpen).toHaveBeenCalledTimes(1);
  expect(onOpened).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain('This open was not confirmed');
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label="Open recent Saved snapshot"]')!
      .disabled,
  ).toBe(false);
});
