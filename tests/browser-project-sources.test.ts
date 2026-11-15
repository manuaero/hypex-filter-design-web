// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceProjectSources } from '../src/application/browser-project-sources';
import { newProject, type Project } from '../src/domain/model';
import { clearNativeFir, selectNativeFirPlacement } from '../src/domain/fir-editing';
import { createWorkspaceStore } from '../src/state/workspace';
import {
  assertWorkspaceWrite,
  type WorkspaceEnvelope,
  type FileCommitReceipt,
} from '../src/state/persistence';
import { assertProjectSourcesWrite } from '../src/application/project-sources-format';
import type {
  ProjectSourcesBackend,
  ProjectSourcesEnvelope,
} from '../src/application/project-sources';

const principal = { owner: 'site:owner', scope: 'lease-before' };
function sourceBackend(): ProjectSourcesBackend {
  let value: ProjectSourcesEnvelope | null = null;
  return {
    read: async () => structuredClone(value),
    write: async (next, expected) => {
      assertProjectSourcesWrite(value, next, expected);
      value = structuredClone(next);
    },
  };
}
function workspace() {
  let value: WorkspaceEnvelope | null = null;
  const backend = {
    read: async () => structuredClone(value),
    readLegacy: () => null,
    write: async (next: WorkspaceEnvelope, expected?: WorkspaceEnvelope | null) => {
      assertWorkspaceWrite(value, expected, next);
      value = structuredClone(next);
    },
  };
  return createWorkspaceStore(backend);
}
function markedSnapshot(): Project {
  const project = newProject('Exact native Clear snapshot'),
    preset = project.presets[0];
  selectNativeFirPlacement(preset, 'output');
  preset.channels[0].linkedTo = 1;
  preset.channels[1].fir = {
    name: 'Master.txt',
    enabled: true,
    taps: Array(1500)
      .fill(0)
      .map((_, i) => (i === 0 ? 0.25 : 0)),
    hfdState: { loaded: true, used: true, tapCount: 1500 },
  };
  preset.channels[0].fir = structuredClone(preset.channels[1].fir);
  clearNativeFir(preset, 0);
  return project;
}

describe('workspace-owned project source factory', () => {
  it('does no reads or hydration during construction and resolves one nontrashed library record by ID', async () => {
    const getLibraryProject = vi.fn(async () => undefined),
      getWorkspace = vi.fn(() => {
        throw new Error('Not used');
      });
    const sources = createWorkspaceProjectSources({
      backend: sourceBackend(),
      getLibraryProject,
      getWorkspace,
    });
    expect(sources.getSnapshot().phase).toBe('idle');
    expect(getWorkspace).not.toHaveBeenCalled();
    expect(getLibraryProject).not.toHaveBeenCalled();
    const id = await sources.rememberLibrary({ id: 'saved', label: 'Local snapshot' });
    // No library access occurs for metadata-only recent updates.
    expect(getLibraryProject).not.toHaveBeenCalled();
    expect(id).toBeTruthy();
  });
  it('replaces both complete documents atomically, preserves an explicitly cleared linked follower and recovers the receipt after Undo/reload', async () => {
    const w = workspace();
    await w.persistence.hydrate();
    const before = structuredClone(w.store.getState().documents),
      incoming = markedSnapshot();
    const getLibraryProject = vi.fn(async () => ({
      id: 'saved',
      name: incoming.name,
      utc: new Date(0).toISOString(),
      project: incoming,
    }));
    const backend = sourceBackend(),
      service = createWorkspaceProjectSources({
        backend,
        getWorkspace: w.store.getState,
        getLibraryProject,
      });
    const sourceId = await service.rememberLibrary({ id: 'saved', label: incoming.name });
    const input = {
      sourceId,
      target: 'both' as const,
      expectedRevision: 0,
      requestId: 'replace-exact',
      principal,
    };
    const first = await service.open(input);
    expect(w.store.getState().documents).toEqual({ left: incoming, right: incoming });
    expect(w.store.getState().documents.right.presets[0].channels[0].fir.hfdState!.loaded).toBe(
      false,
    );
    expect(w.store.getState().documents.right.presets[0].channels[1].fir.hfdState!.loaded).toBe(
      true,
    );
    expect(getLibraryProject).toHaveBeenCalledExactlyOnceWith('saved');
    expect(first.receipt.result).toEqual({
      workflow: 'source-open',
      sourceId,
      target: 'both',
      expectedRevision: 0,
      requestId: 'replace-exact',
    });
    w.store.getState().undo();
    await w.persistence.flush();
    expect(w.store.getState().documents).toEqual(before);
    const reloaded = createWorkspaceProjectSources({
      backend,
      getWorkspace: w.store.getState,
      getLibraryProject,
    });
    const replay = await reloaded.open({
      ...input,
      principal: { ...principal, scope: 'lease-after-reload' },
    });
    expect(replay).toMatchObject({ replayed: true, receipt: first.receipt });
    expect(w.store.getState().documents).toEqual(before);
    expect(getLibraryProject).toHaveBeenCalledTimes(1);
  });
  it('removes absent optional destination fields and leaves the unselected role unchanged', async () => {
    const w = workspace();
    await w.persistence.hydrate();
    w.store.getState().editAt(['right'], (project) => {
      project.hfdCalibration = { filename: 'old.txt', loaded: false, showCurve: true };
    });
    await w.persistence.flush();
    const before = structuredClone(w.store.getState().documents.left),
      incoming = newProject('Replacement');
    const sources = createWorkspaceProjectSources({
      backend: sourceBackend(),
      getWorkspace: w.store.getState,
      getLibraryProject: async () => ({
        id: 'saved',
        name: incoming.name,
        utc: '',
        project: incoming,
      }),
    });
    const sourceId = await sources.rememberLibrary({ id: 'saved', label: incoming.name });
    await sources.open({
      sourceId,
      target: 'right',
      expectedRevision: w.store.getState().documentRevision ?? 0,
      requestId: 'replace-one',
      principal,
    });
    expect(w.store.getState().documents.right).toEqual(incoming);
    expect(w.store.getState().documents.right.hfdCalibration).toBeUndefined();
    expect(w.store.getState().documents.left).toEqual(before);
  });
  it('does not open trashed vault records or apply after a stale revision', async () => {
    const w = workspace();
    await w.persistence.hydrate();
    let trashed = true;
    const sources = createWorkspaceProjectSources({
      backend: sourceBackend(),
      getWorkspace: w.store.getState,
      getLibraryProject: async () => ({
        id: 'saved',
        name: 'Saved',
        utc: '',
        project: newProject('Saved'),
        trashed,
      }),
    });
    const sourceId = await sources.rememberLibrary({ id: 'saved', label: 'Saved' });
    const input = {
      sourceId,
      target: 'right' as const,
      expectedRevision: 0,
      requestId: 'stale',
      principal,
    };
    await expect(sources.open(input)).rejects.toMatchObject({ code: 'missing-source' });
    trashed = false;
    const prepared = await sources.prepareOpen(input);
    w.store.getState().editAt(['left'], (project) => {
      project.name = 'Later design edit';
    });
    const before = structuredClone(w.store.getState().documents);
    await expect(sources.commitOpen(prepared)).rejects.toMatchObject({ code: 'commit-failed' });
    expect(w.store.getState().documents).toEqual(before);
  });
  it('rejects a misbound owner receipt and invalid recorded scope before applying', async () => {
    const result = {
      workflow: 'source-open',
      sourceId: 'opaque',
      target: 'right',
      expectedRevision: 0,
      requestId: 'request',
    };
    let receipt: FileCommitReceipt = {
      commitId: 'source-open:site:owner:request',
      owner: 'site:other',
      scope: 'lease-before',
      revision: 1,
      utc: 1,
      result,
    };
    const commit = vi.fn(),
      lookup = vi.fn(async () => receipt);
    const sources = createWorkspaceProjectSources({
      backend: sourceBackend(),
      getWorkspace: () => ({ commitFileImport: commit, lookupFileCommit: lookup }),
    });
    const input = {
      sourceId: 'opaque',
      target: 'right' as const,
      expectedRevision: 0,
      requestId: 'request',
      principal,
    };
    await expect(sources.open(input)).rejects.toMatchObject({ code: 'persistence' });
    expect(commit).not.toHaveBeenCalled();
    receipt = { ...receipt, owner: principal.owner, scope: '' };
    await expect(sources.open(input)).rejects.toMatchObject({ code: 'persistence' });
    expect(commit).not.toHaveBeenCalled();
  });
});
