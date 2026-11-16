'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { pickWritableProjectDirectory } from '../application/directory-writer-fs';
import {
  DirectorySaveError,
  type DirectorySaveBinding,
  type DirectorySaveProposal,
  type DirectorySaveReceipt,
  type DirectoryArchiveReview,
  type ProjectDirectoryWriter,
  type WritableProjectDirectoryHandle,
} from '../application/project-directory-writer';
import type { TransferBlobFile } from '../application/file-transfers';
import { createRecoveryZip } from '../application/recovery-archive';
import type {
  DirectoryLegacyAccess,
  DirectoryLegacyReview,
} from '../application/workspace-directory';
import styles from './ProjectSaveDialog.module.css';
import type { Slot } from '../domain/model';

export type WritableProjectDirectoryPicker = (options: {
  mode: 'readwrite';
  id: string;
}) => Promise<WritableProjectDirectoryHandle>;
export interface ProjectSaveDialogProps {
  writer: ProjectDirectoryWriter & Partial<DirectoryLegacyAccess>;
  initialLegacyReview?: DirectoryLegacyReview;
  captureBinding: () => DirectorySaveBinding;
  projectName?: string;
  onError: (message: string) => void;
  onSaved: (receipt: DirectorySaveReceipt) => void;
  onClose: () => void;
  onDownloadJson?: () => void | Promise<void>;
  onDownloadZip?: () => void | Promise<void>;
  exportPreparation?: {
    phase: 'staged' | 'capturing' | 'ready' | 'error';
    slot: Slot;
    source: 'connected' | 'design';
    serial?: string;
    capturedAt?: string;
    error?: string;
    onRetry?: () => void;
    onDesignOnly?: () => void;
    onCancelRead?: () => void;
  };
  picker?: WritableProjectDirectoryPicker;
}
const role = (slot: 'left' | 'right') => (slot === 'left' ? 'Left' : 'Right');
const phaseLabel: Record<DirectorySaveProposal['phase'], string> = {
  prepared: 'Ready to save',
  writing: 'Saving',
  partial: 'Save incomplete',
  complete: 'Saved',
  recovering: 'Restoring originals',
  recovered: 'Originals restored',
  'recovered-with-new-files': 'Originals restored; new files retained',
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The folder operation was not confirmed';
const locked = (proposal?: DirectorySaveProposal) =>
  !!proposal && ['writing', 'partial', 'recovering'].includes(proposal.phase);

export default function ProjectSaveDialog({
  writer,
  captureBinding,
  projectName,
  onError,
  onSaved,
  onClose,
  onDownloadJson,
  onDownloadZip,
  picker,
  initialLegacyReview,
  exportPreparation,
}: ProjectSaveDialogProps) {
  const state = useSyncExternalStore(writer.subscribe, writer.getSnapshot, writer.getSnapshot);
  const [captured] = useState(() => {
    try {
      const binding = captureBinding();
      return {
        binding: Object.freeze({ ...binding, principal: Object.freeze({ ...binding.principal }) }),
        name: projectName ?? 'Current design',
        json: onDownloadJson,
        zip: onDownloadZip,
      };
    } catch (error) {
      return { error: message(error), name: projectName ?? 'Current design' };
    }
  });
  const binding = captured.binding,
    association = binding ? state.associations[binding.slot] : undefined;
  const [mode, setMode] = useState<'save' | 'save-as'>(),
    [rootChoice, setRootChoice] = useState(''),
    [folderChoice, setFolderChoice] = useState<string>(),
    [proposal, setProposal] = useState<DirectorySaveProposal | undefined>(
      initialLegacyReview?.proposal,
    ),
    [receipt, setReceipt] = useState<DirectorySaveReceipt>(),
    [overwrite, setOverwrite] = useState(false),
    [localBusy, setLocalBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [failure, setFailure] = useState(''),
    [recoveryChoice, setRecoveryChoice] = useState(''),
    [recoveryFiles, setRecoveryFiles] = useState<readonly TransferBlobFile[]>([]),
    [archiveReview, setArchiveReview] = useState<DirectoryArchiveReview>(),
    [archiveConfirmed, setArchiveConfirmed] = useState(false),
    [showArchived, setShowArchived] = useState(false),
    [historyPage, setHistoryPage] = useState(0),
    [legacyReview, setLegacyReview] = useState<DirectoryLegacyReview | undefined>(
      initialLegacyReview,
    ),
    [legacyConfirmed, setLegacyConfirmed] = useState(false),
    [legacyNotice, setLegacyNotice] = useState(''),
    [reviewingHistory, setReviewingHistory] = useState(!!initialLegacyReview);
  const [cancelingRead, setCancelingRead] = useState(false);
  const modal = useRef<HTMLDialogElement>(null),
    legacyPanel = useRef<HTMLElement>(null),
    mounted = useRef(true),
    flight = useRef(false),
    requestId = useRef(binding?.requestId ?? ''),
    sourceChoiceLocked = useRef(!!initialLegacyReview),
    ready = state.hydrated && state.phase === 'ready',
    sourceMatches = !exportPreparation || exportPreparation.slot === binding?.slot,
    reading = !reviewingHistory && sourceMatches && exportPreparation?.phase === 'capturing',
    busy = localBusy || state.busy || reading,
    frozenTarget = locked(proposal) || uncertain,
    chosenMode = mode ?? (association ? 'save' : 'save-as'),
    rootId = rootChoice || association?.rootId || state.roots[0]?.id || '',
    folderName = folderChoice ?? association?.folderName ?? captured.name;
  useEffect(() => {
    if (proposal) sourceChoiceLocked.current = true;
  }, [proposal]);
  useEffect(() => {
    if (!reading) setCancelingRead(false);
  }, [reading]);
  useEffect(() => {
    mounted.current = true;
    if (modal.current?.showModal) modal.current.showModal();
    else modal.current?.setAttribute('open', '');
    void writer.hydrate().catch((error) => {
      if (mounted.current) {
        setFailure(message(error));
        onError(message(error));
      }
    });
    if (captured.error) onError(captured.error);
    return () => {
      mounted.current = false;
      modal.current?.close();
    };
  }, [writer]);
  const invalidate = () => {
    setProposal(undefined);
    setReceipt(undefined);
    setOverwrite(false);
    setRecoveryFiles([]);
    setArchiveReview(undefined);
    setArchiveConfirmed(false);
    setLegacyReview(undefined);
    setLegacyConfirmed(false);
    setLegacyNotice('');
    setReviewingHistory(false);
    setFailure('');
    setUncertain(false);
    requestId.current = crypto.randomUUID();
  };
  const perform = async (work: () => Promise<void>, mutating = false) => {
    if (flight.current || writer.getSnapshot().busy) return;
    flight.current = true;
    setLocalBusy(true);
    setFailure('');
    try {
      await work();
    } catch (error) {
      if (mounted.current) {
        if (mutating) setUncertain(true);
        if (error instanceof DirectorySaveError && error.result) setProposal(error.result);
        const detail =
          error instanceof DirectorySaveError && error.code === 'stale-workspace'
            ? `${message(error)} Close this dialog and open Save again to capture the current design.`
            : message(error);
        setFailure(detail);
        onError(detail);
      }
    } finally {
      flight.current = false;
      if (mounted.current) setLocalBusy(false);
    }
  };
  const adopt = (result: DirectorySaveReceipt) => {
    if (!mounted.current) return;
    setProposal(result);
    setReceipt(result);
    setUncertain(false);
    if (result.phase === 'complete' && result.verified) onSaved(result);
  };
  const prepare = () => {
    if (!binding || !sourceMatches || reading) return;
    // Completing Save As establishes an association, but must not silently turn
    // this captured request into a different Save operation on the next render.
    setMode(chosenMode);
    if (chosenMode === 'save-as') {
      setRootChoice(rootId);
      setFolderChoice(folderName);
    }
    if (proposal && ['complete', 'recovered', 'recovered-with-new-files'].includes(proposal.phase))
      requestId.current = crypto.randomUUID();
    void perform(async () => {
      const input = { ...binding, requestId: requestId.current };
      const result = await writer.prepare(
        chosenMode === 'save'
          ? { ...input, mode: 'save' }
          : { ...input, mode: 'save-as', rootId, folderName },
      );
      if (mounted.current) {
        setProposal(result);
        setReceipt(undefined);
        setOverwrite(false);
        setRecoveryFiles([]);
      }
    });
  };
  const principal = binding?.principal;
  const recoveryVisible =
    proposal &&
    !proposal.needsLocalAdoption &&
    proposal.recoveryAvailable &&
    (proposal.phase !== 'prepared' || uncertain);
  const archiveAvailable =
    proposal &&
    !proposal.needsLocalAdoption &&
    proposal.recoveryAvailable &&
    ['complete', 'recovered', 'recovered-with-new-files'].includes(proposal.phase);
  const history = state.saves.filter((save) => showArchived || !save.archived);
  const pageStart = Math.min(
    historyPage * 50,
    Math.max(0, Math.floor((history.length - 1) / 50) * 50),
  );
  const downloadBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob),
      anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  useEffect(() => {
    if (!proposal) return;
    const current = state.saves.find((save) => save.id === proposal.id);
    if (
      current &&
      ((!proposal.archived && current.archived) ||
        !!current.needsLocalAdoption !== !!proposal.needsLocalAdoption)
    ) {
      setProposal(current);
      setReceipt(undefined);
      setRecoveryFiles([]);
      setArchiveReview(undefined);
      setArchiveConfirmed(false);
      setLegacyReview(undefined);
      setLegacyConfirmed(false);
    }
  }, [state.saves, proposal?.id, proposal?.archived, proposal?.needsLocalAdoption]);
  useEffect(() => {
    legacyPanel.current?.scrollIntoView?.({ block: 'nearest' });
  }, [legacyReview?.id]);
  return (
    <dialog
      ref={modal}
      className={styles.dialog}
      aria-label="Save HFD project folder"
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <h2>
              {reviewingHistory
                ? proposal?.needsLocalAdoption
                  ? 'Restore record access'
                  : 'Saved record'
                : 'Save HFD project'}
            </h2>
            <p>
              {reviewingHistory && proposal
                ? `${role(proposal.slot)} · ${proposal.folderName}`
                : binding
                  ? `${role(binding.slot)} · ${captured.name}`
                  : captured.name}
            </p>
          </div>
          <button type="button" aria-label="Close project save" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>
        <div className={styles.body}>
          {exportPreparation && !reviewingHistory && (
            <section className={styles.source} aria-label="Save source">
              <div className={styles.sourceHeading}>
                <h3>Save source</h3>
                <span>
                  {binding ? role(binding.slot) : role(exportPreparation.slot)} ·{' '}
                  {exportPreparation.source === 'connected'
                    ? 'Current amplifier settings'
                    : 'Design only'}
                </span>
                {sourceMatches && exportPreparation.serial && (
                  <span>{exportPreparation.serial}</span>
                )}
              </div>
              {!sourceMatches ? (
                <p role="alert" className={styles.error}>
                  The save source belongs to another role. Close this dialog and open Save again.
                </p>
              ) : (
                <>
                  {exportPreparation.phase === 'staged' && (
                    <p className={styles.note}>
                      {exportPreparation.source === 'connected'
                        ? 'Current amplifier settings and physical EQ will be read automatically when you save or download. No upload is sent.'
                        : 'No amplifier read is needed. Any retained device metadata is a saved snapshot.'}
                    </p>
                  )}
                  {reading && (
                    <p role="status" aria-live="polite" className={styles.note}>
                      Reading {role(exportPreparation.slot)} amplifier settings and physical EQ…
                    </p>
                  )}
                  {exportPreparation.phase === 'ready' && (
                    <p role="status" className={styles.note}>
                      {exportPreparation.source === 'connected' ? (
                        <>
                          Amplifier settings and physical EQ captured
                          {exportPreparation.capturedAt ? (
                            <>
                              {' '}
                              at{' '}
                              <time dateTime={exportPreparation.capturedAt}>
                                {exportPreparation.capturedAt}
                              </time>
                            </>
                          ) : (
                            ''
                          )}
                          .
                        </>
                      ) : (
                        'Design-only export prepared. No amplifier data was read.'
                      )}
                    </p>
                  )}
                  {exportPreparation.phase === 'error' && (
                    <p role="alert" className={styles.error}>
                      {exportPreparation.error ??
                        'Current amplifier data could not be captured. No fresh export was prepared.'}
                    </p>
                  )}
                  <p className={styles.note}>
                    Staged filters and design EQ are retained separately from amplifier metadata.
                  </p>
                  <div className={styles.actions}>
                    {reading && exportPreparation.onCancelRead && (
                      <button
                        type="button"
                        disabled={state.busy || frozenTarget || cancelingRead}
                        onClick={() => {
                          if (state.busy || frozenTarget || cancelingRead) return;
                          setCancelingRead(true);
                          try {
                            exportPreparation.onCancelRead?.();
                          } catch (error) {
                            setCancelingRead(false);
                            setFailure(message(error));
                            onError(message(error));
                          }
                        }}
                      >
                        {cancelingRead ? 'Canceling read…' : 'Cancel read'}
                      </button>
                    )}
                    {exportPreparation.source === 'connected' &&
                      exportPreparation.phase === 'error' &&
                      exportPreparation.onRetry &&
                      !proposal &&
                      !uncertain &&
                      !sourceChoiceLocked.current && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              exportPreparation.onRetry?.();
                            })
                          }
                        >
                          Retry device read
                        </button>
                      )}
                    {exportPreparation.source === 'connected' &&
                      exportPreparation.onDesignOnly &&
                      !reading &&
                      !proposal &&
                      !uncertain &&
                      !sourceChoiceLocked.current && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              exportPreparation.onDesignOnly?.();
                            })
                          }
                        >
                          Save design only
                        </button>
                      )}
                  </div>
                </>
              )}
            </section>
          )}
          {(captured.error || failure || state.error) && (
            <p className={styles.error} role="alert">
              {captured.error || failure || state.error}
            </p>
          )}
          {state.phase === 'error' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void perform(() => writer.retryStorage())}
            >
              Retry local save storage
            </button>
          )}
          {!reviewingHistory && (
            <fieldset
              disabled={busy || !ready || !binding || !sourceMatches || frozenTarget}
              className={styles.target}
            >
              <legend>Folder destination</legend>
              <div className={styles.mode}>
                <label>
                  <input
                    type="radio"
                    name="project-save-mode"
                    checked={chosenMode === 'save'}
                    disabled={!association}
                    onChange={() => {
                      invalidate();
                      setMode('save');
                    }}
                  />
                  Save
                </label>
                <label>
                  <input
                    type="radio"
                    name="project-save-mode"
                    checked={chosenMode === 'save-as'}
                    onChange={() => {
                      invalidate();
                      setMode('save-as');
                    }}
                  />
                  Save as
                </label>
              </div>
              {chosenMode === 'save' && association ? (
                <p className={styles.destination}>
                  {state.roots.find((root) => root.id === association.rootId)?.label ??
                    'Saved folder'}{' '}
                  / {association.folderName}
                </p>
              ) : (
                <>
                  <label>
                    Parent folder
                    <select
                      aria-label="Project save parent folder"
                      value={rootId}
                      onChange={(event) => {
                        invalidate();
                        setRootChoice(event.target.value);
                      }}
                    >
                      <option value="" disabled>
                        Choose a parent folder
                      </option>
                      {state.roots.map((root) => (
                        <option key={root.id} value={root.id}>
                          {root.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Project folder name
                    <input
                      aria-label="Project folder name"
                      value={folderName}
                      onChange={(event) => {
                        invalidate();
                        setFolderChoice(event.target.value);
                      }}
                    />
                  </label>
                </>
              )}
              <button
                type="button"
                onClick={() =>
                  void perform(async () => {
                    const handle = await pickWritableProjectDirectory(picker);
                    if (!handle || !mounted.current) return;
                    const id = await writer.registerDirectory(handle);
                    if (mounted.current) {
                      invalidate();
                      setRootChoice(id);
                      setMode('save-as');
                    }
                  })
                }
              >
                Choose parent folder…
              </button>
              <button
                type="button"
                className={styles.primary}
                disabled={chosenMode === 'save-as' && (!rootId || !folderName)}
                onClick={prepare}
              >
                Review save
              </button>
            </fieldset>
          )}
          {reviewingHistory && (
            <button type="button" disabled={busy || frozenTarget} onClick={invalidate}>
              Return to current design Save
            </button>
          )}
          {frozenTarget && proposal && !proposal.needsLocalAdoption && (
            <button
              type="button"
              disabled={busy || !ready}
              onClick={() =>
                void perform(async () => {
                  const handle = await pickWritableProjectDirectory(picker);
                  if (!handle || !mounted.current) return;
                  const id = await writer.registerDirectory(handle);
                  if (id !== proposal.rootId)
                    throw new Error('Choose the same granted folder used by this recovery record');
                })
              }
            >
              Reauthorize this writable folder…
            </button>
          )}
          {proposal && (
            <section className={styles.review} aria-label="Prepared folder save">
              <div>
                <strong>
                  {role(proposal.slot)} · {proposal.folderName}
                </strong>
                <small>
                  {state.roots.find((root) => root.id === proposal.rootId)?.label ??
                    'Granted folder'}{' '}
                  · {phaseLabel[proposal.phase]}
                </small>
              </div>
              {proposal.workspaceChanged && (
                <p className={styles.error}>
                  The design changed after this save was captured. This record retains its original
                  export.
                </p>
              )}
              <div className={styles.fileList}>
                <table>
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Change</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proposal.files.slice(0, 20).map((file) => (
                      <tr key={file.path}>
                        <td>
                          {file.path}
                          <small>{file.bytes.toLocaleString()} bytes</small>
                        </td>
                        <td>{file.action}</td>
                        <td>
                          {file.state}
                          {file.recovery === 'pending' ? '' : ` · ${file.recovery}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {proposal.files.length > 20 && (
                  <p>{proposal.files.length - 20} more files retained in this record.</p>
                )}
              </div>
              <p className={styles.note}>
                {proposal.needsLocalAdoption
                  ? 'This record belongs to an earlier app session. Restoring access preserves its original recovery copies and receipt; it does not write project files.'
                  : 'Only the listed files are written. Recovery retains newly created files. A folder save can finish partially.'}
              </p>
              {proposal.needsLocalAdoption && writer.reviewLegacy && (
                <button
                  type="button"
                  disabled={busy || !principal}
                  onClick={() =>
                    void perform(async () => {
                      const review = await writer.reviewLegacy!(proposal.id, principal!);
                      if (mounted.current) {
                        setLegacyReview(review);
                        setLegacyConfirmed(false);
                        setLegacyNotice('');
                      }
                    })
                  }
                >
                  Review record access
                </button>
              )}
              {proposal.needsLocalAdoption &&
                legacyReview?.recordId === proposal.id &&
                writer.adoptLegacy && (
                  <section
                    ref={legacyPanel}
                    className={styles.review}
                    aria-label="Older record access review"
                  >
                    <strong>
                      {role(legacyReview.slot)} · {legacyReview.proposal.folderName}
                    </strong>
                    <p>
                      Allow this workspace and its paired agents to use this saved record. Its
                      original owner, receipt and recovery bytes are preserved. Project files stay
                      unchanged.
                    </p>
                    <label className={styles.confirm}>
                      <input
                        type="checkbox"
                        checked={legacyConfirmed}
                        disabled={busy}
                        onChange={(event) => setLegacyConfirmed(event.target.checked)}
                      />
                      Allow this workspace to use this older record
                    </label>
                    <button
                      type="button"
                      disabled={busy || !principal || !legacyConfirmed}
                      onClick={() =>
                        void perform(async () => {
                          try {
                            const result = await writer.adoptLegacy!(legacyReview.id, principal!, {
                              confirm: true,
                            });
                            if (mounted.current) {
                              setProposal(result);
                              setReceipt(undefined);
                              setLegacyNotice(
                                'Record access restored for this workspace. Project files were not changed.',
                              );
                            }
                          } finally {
                            if (mounted.current) {
                              setLegacyReview(undefined);
                              setLegacyConfirmed(false);
                            }
                          }
                        })
                      }
                    >
                      Confirm record access
                    </button>
                  </section>
                )}
              {legacyNotice && <p role="status">{legacyNotice}</p>}
              {proposal.phase === 'prepared' && !uncertain && !proposal.needsLocalAdoption && (
                <>
                  {proposal.requiresOverwriteConfirmation && (
                    <label className={styles.confirm}>
                      <input
                        type="checkbox"
                        checked={overwrite}
                        disabled={busy}
                        onChange={(event) => setOverwrite(event.target.checked)}
                      />
                      Replace the listed existing files
                    </label>
                  )}
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={
                      busy || !principal || (proposal.requiresOverwriteConfirmation && !overwrite)
                    }
                    onClick={() =>
                      void perform(
                        async () =>
                          adopt(
                            await writer.commit(proposal.id, principal!, {
                              allowOverwrite: overwrite,
                            }),
                          ),
                        true,
                      )
                    }
                  >
                    Save reviewed files
                  </button>
                  <button
                    type="button"
                    disabled={busy || !principal}
                    onClick={() =>
                      void perform(async () => {
                        await writer.forgetRecovery(proposal.id, principal!);
                        if (mounted.current) invalidate();
                      })
                    }
                  >
                    Discard unused review
                  </button>
                </>
              )}
              {!proposal.needsLocalAdoption &&
                (proposal.phase === 'partial' || proposal.phase === 'writing' || uncertain) && (
                  <button
                    type="button"
                    disabled={busy || !principal}
                    onClick={() =>
                      void perform(
                        async () => adopt(await writer.retry(proposal.id, principal!)),
                        true,
                      )
                    }
                  >
                    Retry this save
                  </button>
                )}
              {proposal.archived && (
                <p role="status">
                  Archived historical record. Browser recovery copies were removed; project files
                  are unchanged.
                </p>
              )}
              {!proposal.archived && receipt?.phase === 'complete' && receipt.verified && (
                <p role="status">
                  {receipt.replayed
                    ? 'Historical save verified when it completed; no fresh folder check.'
                    : 'All project files verified.'}
                </p>
              )}
              {!receipt?.replayed && receipt?.nativeSavePostState === 'applied' && (
                <p role="status">
                  The open preset's Global delays were reconciled after the files were saved. Close
                  this dialog and Save again to write those updated values.
                </p>
              )}
              {receipt &&
                ['unavailable', 'unconfirmed'].includes(receipt.nativeSavePostState ?? '') && (
                  <p role="status">
                    Files were verified without a confirmed workspace delay update. Close this
                    dialog and prepare a new Save for the current design.
                  </p>
                )}
              {receipt?.phase === 'recovered' && (
                <p role="status">Original file bytes restored and verified.</p>
              )}
              {receipt?.phase === 'recovered-with-new-files' && (
                <p role="status">
                  Original bytes restored. Newly created files remain in the folder.
                </p>
              )}
              {recoveryVisible && (
                <div className={styles.actions}>
                  <button
                    type="button"
                    disabled={busy || !principal}
                    onClick={() =>
                      void perform(
                        async () => adopt(await writer.recover(proposal.id, principal!)),
                        true,
                      )
                    }
                  >
                    Restore original files
                  </button>
                  <button
                    type="button"
                    disabled={busy || !principal}
                    onClick={() =>
                      void perform(async () => {
                        const files = await writer.exportRecovery(proposal.id, principal!);
                        if (mounted.current) setRecoveryFiles(files);
                      })
                    }
                  >
                    Recovery files
                  </button>
                  <button
                    type="button"
                    disabled={busy || !principal}
                    onClick={() =>
                      void perform(async () => {
                        const files = await writer.exportRecovery(proposal.id, principal!);
                        const zip = await createRecoveryZip(files);
                        if (mounted.current)
                          downloadBlob(zip, `${proposal.folderName}-recovery.zip`);
                      })
                    }
                  >
                    Download recovery ZIP
                  </button>
                </div>
              )}
              {archiveAvailable && (
                <button
                  type="button"
                  disabled={busy || !principal}
                  onClick={() =>
                    void perform(async () => {
                      const review = await writer.reviewArchive(proposal.id, principal!);
                      if (mounted.current) {
                        setArchiveReview(review);
                        setArchiveConfirmed(false);
                      }
                    })
                  }
                >
                  Review archiving
                </button>
              )}
              {archiveReview && archiveReview.saveId === proposal.id && !proposal.archived && (
                <section className={styles.review} aria-label="Archive recovery review">
                  <strong>
                    Archive {role(archiveReview.slot)} · {archiveReview.proposal.folderName}
                  </strong>
                  <p>
                    {archiveReview.recoveryBytes.toLocaleString()} bytes of browser recovery copies
                    will be removed. The historical receipt remains. This does not write or remove
                    project files.
                  </p>
                  <p>
                    Download the recovery ZIP first if you need these copies later. A download alone
                    does not prove that another durable copy exists.
                  </p>
                  <label className={styles.confirm}>
                    <input
                      type="checkbox"
                      checked={archiveConfirmed}
                      disabled={busy}
                      onChange={(event) => setArchiveConfirmed(event.target.checked)}
                    />
                    Remove this record’s local recovery copies
                  </label>
                  <button
                    type="button"
                    disabled={busy || !principal || !archiveConfirmed}
                    onClick={() =>
                      void perform(async () => {
                        const result = await writer.archive(archiveReview.id, principal!, {
                          confirm: true,
                          removeLocalRecovery: true,
                        });
                        if (mounted.current) {
                          setProposal(result);
                          setReceipt(result);
                          setRecoveryFiles([]);
                          setArchiveReview(undefined);
                          setArchiveConfirmed(false);
                        }
                      })
                    }
                  >
                    Archive recovery record
                  </button>
                </section>
              )}
              {recoveryFiles.length > 0 && (
                <div className={styles.downloads} aria-label="Recovery downloads">
                  {recoveryFiles.map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => {
                        downloadBlob(file.blob, file.path);
                      }}
                    >
                      {file.path}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
          {state.saves.length > 0 && (
            <details className={styles.recovery}>
              <summary>Save history and recovery</summary>
              <label className={styles.confirm}>
                <input
                  type="checkbox"
                  checked={showArchived}
                  disabled={busy || frozenTarget}
                  onChange={(event) => {
                    setShowArchived(event.target.checked);
                    setHistoryPage(0);
                    setRecoveryChoice('');
                  }}
                />
                Include archived receipts
              </label>
              <label>
                Record
                <select
                  aria-label="Folder recovery record"
                  value={recoveryChoice}
                  disabled={busy || frozenTarget}
                  onChange={(event) => {
                    setRecoveryChoice(event.target.value);
                    setArchiveReview(undefined);
                    setArchiveConfirmed(false);
                  }}
                >
                  <option value="">Choose a record</option>
                  {history.slice(pageStart, pageStart + 50).map((save) => (
                    <option key={save.id} value={save.id}>
                      {role(save.slot)} · {save.folderName} · {save.archived ? 'Archived · ' : ''}
                      {phaseLabel[save.phase]}
                    </option>
                  ))}
                </select>
              </label>
              {history.length > 50 && (
                <div className={styles.actions}>
                  <button
                    type="button"
                    disabled={busy || frozenTarget || pageStart === 0}
                    onClick={() => {
                      setHistoryPage(Math.max(0, Math.floor(pageStart / 50) - 1));
                      setRecoveryChoice('');
                    }}
                  >
                    Previous records
                  </button>
                  <span>
                    {pageStart + 1}–{Math.min(pageStart + 50, history.length)} of {history.length}
                  </span>
                  <button
                    type="button"
                    disabled={busy || frozenTarget || pageStart + 50 >= history.length}
                    onClick={() => {
                      setHistoryPage(Math.floor(pageStart / 50) + 1);
                      setRecoveryChoice('');
                    }}
                  >
                    Next records
                  </button>
                </div>
              )}
              <button
                type="button"
                disabled={busy || frozenTarget || !principal || !recoveryChoice}
                onClick={() =>
                  void perform(async () => {
                    const selected = await writer.status(recoveryChoice, principal!);
                    if (mounted.current) {
                      setProposal(selected);
                      setReceipt(undefined);
                      setOverwrite(false);
                      setRecoveryFiles([]);
                      setArchiveReview(undefined);
                      setArchiveConfirmed(false);
                      setLegacyReview(undefined);
                      setLegacyConfirmed(false);
                      setLegacyNotice('');
                      setReviewingHistory(true);
                    }
                  })
                }
              >
                Review recovery record
              </button>
            </details>
          )}
        </div>
        <footer className={styles.footer}>
          {captured.json && !reviewingHistory && (
            <button
              type="button"
              disabled={busy || !sourceMatches}
              onClick={() =>
                void perform(async () => {
                  await captured.json?.();
                })
              }
            >
              Download JSON
            </button>
          )}
          {captured.zip && !reviewingHistory && (
            <button
              type="button"
              disabled={busy || !sourceMatches}
              onClick={() =>
                void perform(async () => {
                  await captured.zip?.();
                })
              }
            >
              Download HFD ZIP
            </button>
          )}
          <button type="button" disabled={busy} onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </dialog>
  );
}
