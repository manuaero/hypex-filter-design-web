'use client';
import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Save, Download, ArchiveRestore } from 'lucide-react';
import { type Project } from '../domain/model';
import { download } from '../domain/files';
import { importProjectFolder, projectFiles, zipFiles, downloadBytes } from '../domain/project-io';
import { saveProject, listProjects, trashProject, type SavedProject } from '../hardware/storage';
import { assertFileByteBudget, readFileText } from '../application/file-budget';
export default function ProjectLibrary({
  project,
  replace,
  onError,
  onSaved,
  openSnapshot,
  openDisabled = false,
}: {
  project: Project;
  replace: (p: Project) => void;
  onError: (error: string) => void;
  onSaved?: (record: SavedProject) => Promise<void>;
  openSnapshot?: (record: SavedProject) => Promise<void>;
  openDisabled?: boolean;
}) {
  const [records, setRecords] = useState<SavedProject[]>([]),
    [trash, setTrash] = useState(false);
  const folder = useRef<HTMLInputElement>(null);
  const folderTarget = useRef<((project: Project) => void) | null>(null);
  const refresh = () =>
    listProjects()
      .then(setRecords)
      .catch((e) => onError(String(e)));
  useEffect(() => {
    void refresh();
    folder.current?.setAttribute('webkitdirectory', '');
  }, []);
  const perform = async (fn: () => Promise<void>) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="feature-card">
      <h2>Project library</h2>
      {project.warnings.length > 0 && (
        <p className="hint" role="status">
          {project.warnings.at(-1)}
        </p>
      )}
      <p>
        Saved snapshots retain complete designs and measurements in this browser. Export a ZIP to
        move an HFD project folder between computers.
      </p>
      <div className="button-row">
        <button
          onClick={() =>
            perform(async () => {
              const record = await saveProject(project);
              await onSaved?.(record);
            })
          }
        >
          <Save size={14} />
          Save snapshot
        </button>
        <button
          onClick={() => {
            folderTarget.current = replace;
            folder.current?.click();
          }}
        >
          <FolderOpen size={14} />
          Open HFD folder
        </button>
        <button
          onClick={() =>
            perform(async () => {
              downloadBytes(`${project.name}.zip`, zipFiles(projectFiles(project)));
            })
          }
        >
          <Download size={14} />
          Export HFD folder ZIP
        </button>
        <label className="toggle-label">
          <input type="checkbox" checked={trash} onChange={(e) => setTrash(e.target.checked)} />
          <span className="switch" />
          Show removed snapshots
        </label>
      </div>
      <input
        ref={folder}
        type="file"
        multiple
        hidden
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          if (!files.length) return;
          const apply = folderTarget.current ?? replace;
          await perform(async () => {
            const selected = files.filter((f) => /\.(xml|dat|txt|frd|json)$/i.test(f.name));
            assertFileByteBudget(selected);
            const entries = await Promise.all(
              selected.map(async (f) => ({
                path: f.webkitRelativePath || f.name,
                content: await readFileText(f, undefined, {
                  preserveBom: !/\.json$/i.test(f.name),
                }),
              })),
            );
            const name = entries[0]?.path.split('/')[0] ?? 'Imported HFD folder';
            apply(importProjectFolder(entries, name));
          });
          e.target.value = '';
        }}
      />
      <div className="backup-list">
        {records
          .filter((r) => !!r.trashed === trash)
          .map((r) => (
            <div className="backup-row" key={r.id}>
              <ArchiveRestore size={18} />
              <div>
                <strong>{r.name}</strong>
                <small>{new Date(r.utc).toLocaleString()}</small>
              </div>
              <button
                disabled={openDisabled || !!r.trashed}
                onClick={() =>
                  openSnapshot
                    ? void perform(() => openSnapshot(r))
                    : replace(structuredClone(r.project))
                }
              >
                Open
              </button>
              <button
                onClick={() =>
                  download(`${r.name}.fusion.json`, JSON.stringify(r.project, null, 2))
                }
              >
                <Download size={14} />
                Export
              </button>
              <button onClick={() => perform(() => trashProject(r.id, !r.trashed))}>
                {trash ? 'Recover' : 'Remove'}
              </button>
            </div>
          ))}
      </div>
      <p className="hint">
        Removing a snapshot is reversible. Frequency-only responses are included as FRD files; HFD’s
        native measurement view requires an impulse DAT file.
      </p>
    </section>
  );
}
