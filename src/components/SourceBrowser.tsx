'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useProjectSourceOpen, type ProjectSourceOpener } from './useProjectSourceOpen';
import { pickProjectDirectory } from '../application/directory-project-source';
import type {
  ProjectSources,
  ProjectOpenBinding,
  ProjectOpenResult,
  ProjectDirectoryHandle,
  ProjectSourceListing,
  ProjectSourceSort,
} from '../application/project-sources';

export interface SourceBrowserProps {
  sources: ProjectSources;
  /** Called synchronously at Open click, before any asynchronous reads. */
  captureOpen: () => Omit<ProjectOpenBinding, 'requestId'>;
  onError: (message: string) => void;
  onOpened?: (result: ProjectOpenResult) => void;
  opener?: ProjectSourceOpener;
  /** Test injection. Production uses the browser's human-only directory picker. */
  picker?: (options: { mode: 'read'; id: string }) => Promise<ProjectDirectoryHandle>;
}
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'The local project source operation failed';
export default function SourceBrowser({
  sources,
  captureOpen,
  onError,
  onOpened,
  opener: suppliedOpener,
  picker,
}: SourceBrowserProps) {
  const state = useSyncExternalStore(sources.subscribe, sources.getSnapshot, sources.getSnapshot);
  const [listing, setListing] = useState<ProjectSourceListing>(),
    [loading, setLoading] = useState(false),
    [working, setWorking] = useState(false);
  const ownOpener = useProjectSourceOpen(sources),
    opener = suppliedOpener ?? ownOpener;
  const busy = working || opener.busy;
  const mounted = useRef(true),
    listGeneration = useRef(0),
    errorRef = useRef(onError);
  errorRef.current = onError;
  const rootId = state.activeRootId;
  const visibleListing = listing?.rootId === rootId ? listing : undefined;
  useEffect(() => {
    mounted.current = true;
    void sources.hydrate().catch((error) => errorRef.current(errorMessage(error)));
    return () => {
      mounted.current = false;
      listGeneration.current++;
    };
  }, [sources]);
  const refresh = async (selected = rootId, sort?: ProjectSourceSort) => {
    const generation = ++listGeneration.current;
    if (!selected) {
      setListing(undefined);
      setLoading(false);
      return;
    }
    setListing((current) => (current?.rootId === selected ? current : undefined));
    setLoading(true);
    try {
      const result = await sources.list(selected, sort);
      if (mounted.current && generation === listGeneration.current) setListing(result);
    } catch (error) {
      if (mounted.current && generation === listGeneration.current) {
        setListing(undefined);
        onError(errorMessage(error));
      }
    } finally {
      if (mounted.current && generation === listGeneration.current) setLoading(false);
    }
  };
  useEffect(() => {
    if (state.hydrated && state.phase === 'ready') void refresh(rootId);
    else {
      listGeneration.current++;
      setLoading(false);
    }
    return () => {
      listGeneration.current++;
    };
  }, [sources, rootId, state.hydrated, state.phase, state.sort.by, state.sort.direction]);
  const perform = async (work: () => Promise<void>) => {
    setWorking(true);
    try {
      await work();
    } catch (error) {
      if (mounted.current) onError(errorMessage(error));
    } finally {
      if (mounted.current) setWorking(false);
    }
  };
  const open = (sourceId: string) => {
    // Capture the complete explicit destination before perform's first await.
    let binding: ProjectOpenBinding;
    try {
      binding = { ...captureOpen(), requestId: crypto.randomUUID() };
    } catch (error) {
      onError(errorMessage(error));
      return;
    }
    void perform(async () => {
      const result = await opener.open({ ...binding, sourceId });
      if (!mounted.current) return;
      if (result.recentWarning) onError(result.recentWarning);
      onOpened?.(result);
    });
  };
  const sort = (by: ProjectSourceSort['by']) => {
    const direction =
      state.sort.by === by
        ? state.sort.direction === 'ascending'
          ? 'descending'
          : 'ascending'
        : state.sort.direction;
    void refresh(rootId, { by, direction });
  };
  return (
    <section className="feature-card" aria-label="Local project sources">
      <div className="button-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>Open project</strong>
        <div className="button-row">
          <button
            disabled={busy || !state.hydrated || state.phase === 'error'}
            onClick={() =>
              void perform(async () => {
                // This is the only permission-picker path and begins in a human click.
                const handle = await pickProjectDirectory(picker);
                if (handle) {
                  const selected = await sources.registerDirectory(handle);
                  if (selected === rootId) await refresh(selected);
                }
              })
            }
          >
            Choose database folder…
          </button>
          <button
            disabled={busy || loading || !rootId || state.phase !== 'ready'}
            onClick={() => void refresh()}
          >
            Refresh
          </button>
        </div>
      </div>
      <p className="hint">
        Read-only access to a folder you choose. Projects open fresh; saved library snapshots are
        separate local references.
      </p>
      {state.phase === 'error' && (
        <p role="alert">
          {state.error}{' '}
          <button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await sources.retry();
                await refresh();
              })
            }
          >
            Retry local storage
          </button>
        </p>
      )}
      {!state.hydrated && state.phase !== 'error' && <p role="status">Loading local sources…</p>}
      {state.roots.length > 0 && (
        <label className="field-label">
          Database{' '}
          <select
            aria-label="Project database"
            value={rootId ?? ''}
            disabled={busy || state.phase !== 'ready'}
            onChange={(event) => {
              const selected = event.target.value;
              void perform(async () => {
                await sources.selectRoot(selected);
              });
            }}
          >
            {!rootId && <option value="">Select a granted folder</option>}
            {state.roots.map((root) => (
              <option key={root.id} value={root.id}>
                {root.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {loading && <p role="status">Reading project folders…</p>}
      {visibleListing?.needsHumanGrant && (
        <p role="status">
          {visibleListing.reason} Use Choose database folder to grant read access.
        </p>
      )}
      {visibleListing && !visibleListing.needsHumanGrant && (
        <div style={{ maxHeight: 220, overflowY: 'auto' }}>
          <table style={{ width: '100%', textAlign: 'left' }}>
            <thead>
              <tr>
                <th>
                  <button
                    onClick={() => sort('name')}
                    disabled={busy || loading}
                    aria-label="Sort project names"
                  >
                    Name{' '}
                    {state.sort.by === 'name'
                      ? state.sort.direction === 'ascending'
                        ? '↑'
                        : '↓'
                      : ''}
                  </button>
                </th>
                <th>
                  <button
                    onClick={() => sort('modified')}
                    disabled={busy || loading}
                    aria-label="Sort project modified dates"
                  >
                    Modified{' '}
                    {state.sort.by === 'modified'
                      ? state.sort.direction === 'ascending'
                        ? '↑'
                        : '↓'
                      : ''}
                  </button>
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleListing.entries.map((entry) => (
                <tr key={entry.id}>
                  <td style={{ overflowWrap: 'anywhere' }}>{entry.label}</td>
                  <td>
                    {entry.modifiedAt !== undefined
                      ? new Date(entry.modifiedAt).toLocaleString()
                      : 'Unknown'}
                  </td>
                  <td>
                    <button
                      disabled={
                        busy ||
                        !!opener.pending ||
                        loading ||
                        listing?.rootId !== rootId ||
                        state.phase !== 'ready'
                      }
                      onClick={() => {
                        if (
                          !loading &&
                          visibleListing.rootId === sources.getSnapshot().activeRootId
                        )
                          open(entry.id);
                      }}
                      aria-label={`Open folder project ${entry.label}`}
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visibleListing.entries.length && (
            <p className="hint">No direct child folders contain Config.xml.</p>
          )}
        </div>
      )}
      {opener.pending && !opener.busy && (
        <div role="status" className="hint">
          <p>
            This open was not confirmed. Retry checks the original operation for{' '}
            {opener.pending.target === 'both'
              ? 'both roles'
              : opener.pending.target === 'left'
                ? 'Left'
                : 'Right'}
            . If a save error is shown, retry workspace storage first, then retry this open. Discard
            leaves the current design as it is.
          </p>
          <div className="button-row">
            <button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const result = await opener.retry();
                  if (!mounted.current) return;
                  if (result.recentWarning) onError(result.recentWarning);
                  onOpened?.(result);
                })
              }
            >
              Retry same open
            </button>
            <button
              disabled={busy}
              onClick={() => {
                try {
                  opener.discard();
                } catch (error) {
                  onError(errorMessage(error));
                }
              }}
            >
              Discard retry
            </button>
          </div>
        </div>
      )}
      <div className="button-row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
        <strong>Recent projects</strong>
        <button
          disabled={busy || !state.recent.length || state.phase !== 'ready'}
          onClick={() => void perform(() => sources.clearRecent())}
        >
          Clear recent list
        </button>
      </div>
      {state.recent.length ? (
        <div style={{ maxHeight: 160, overflowY: 'auto' }}>
          {state.recent.map((entry) => (
            <div
              className="button-row"
              key={entry.id}
              style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}
            >
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                {entry.label}{' '}
                <small className="hint">
                  {entry.kind === 'library-snapshot' ? 'Library snapshot' : 'Folder project'}
                </small>
              </span>
              <div className="button-row" style={{ flexWrap: 'nowrap' }}>
                <button
                  disabled={busy || !!opener.pending || state.phase !== 'ready'}
                  onClick={() => open(entry.id)}
                  aria-label={`Open recent ${entry.label}`}
                >
                  Open
                </button>
                <button
                  disabled={busy || state.phase !== 'ready'}
                  onClick={() => void perform(() => sources.forgetRecent(entry.id))}
                  aria-label={`Forget recent ${entry.label}`}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="hint">No recent projects.</p>
      )}
    </section>
  );
}
