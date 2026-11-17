'use client';

import { firDisplayName } from '../domain/fir-name';
import { useEffect, useState } from 'react';
import {
  FolderOpen,
  Download,
  X,
  ShieldCheck,
  ArrowUpFromLine,
  ArrowDownToLine,
} from 'lucide-react';
import { type Preset } from '../domain/model';
import {
  applyNativeFirAction,
  applyReadFir,
  editPresetFir,
  type NativeFirAction,
  type ReadFirDesign,
} from '../domain/fir-editing';
import { firIsEffective, firState, planSelectedFirPlacement } from '../domain/fir-state';
import { parseFir, download } from '../domain/files';
import { firPlacement, readFir, uploadFir, restoreFir, type FirBackup } from '../hardware/fir';
import { listFirBackups } from '../hardware/storage';
import { type PanelSession, type Identity } from '../hardware/session';
import styles from './FirPanel.module.css';
export type { NativeFirAction } from '../domain/fir-editing';
export default function FirPanel({
  preset,
  presetIndex,
  live,
  edit,
  run,
  readFile,
  notice,
  selectedOutputIndex = 0,
  onNativeAction,
  onReadFir,
}: {
  preset: Preset;
  presetIndex: number;
  live?: { session: PanelSession; identity: Identity };
  edit: (fn: (p: Preset) => void) => void;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  readFile: (accept: string, fn: (text: string, name: string) => void) => void;
  notice: (message: string) => void;
  selectedOutputIndex?: number;
  /** The host transaction must bypass ordinary link propagation for native actions. */
  onNativeAction?: (action: NativeFirAction) => void;
  /** Apply to the captured role/preset with ordinary link normalization disabled. */
  onReadFir?: (result: ReadFirDesign) => void;
}) {
  const placement = firPlacement(preset),
    [backups, setBackups] = useState<FirBackup[]>([]);
  let uploadWarnings: string[] = [],
    uploadScopeError = '';
  try {
    uploadWarnings = planSelectedFirPlacement(preset).warnings;
  } catch (error) {
    uploadScopeError = error instanceof Error ? error.message : 'Invalid FIR resources';
  }
  useEffect(() => {
    listFirBackups()
      .then(setBackups)
      .catch(() => {});
  }, []);
  const refresh = async () => setBackups(await listFirBackups());
  const nativeAction = (action: NativeFirAction) => {
    if (onNativeAction) return onNativeAction(action);
    edit((p) => applyNativeFirAction(p, action));
  };
  const selected =
    Number.isInteger(selectedOutputIndex) && selectedOutputIndex >= 0 && selectedOutputIndex < 3
      ? selectedOutputIndex
      : 0;
  return (
    <div className={`page-panel ${styles.panel}`}>
      <header className={styles.heading}>
        <h1>FIR processing</h1>
        <p>4,500 input taps or 3 × 1,500 output taps · 93,750 Hz · Preset {presetIndex + 1}</p>
      </header>
      {(uploadWarnings.length > 0 || uploadScopeError) && (
        <aside className={styles.note} aria-label="FIR upload scope">
          {uploadWarnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          {uploadScopeError && <p>{uploadScopeError}</p>}
        </aside>
      )}
      <div className={styles.toolbar}>
        <label className={styles.placement}>
          <span>Placement</span>
          <select
            aria-label="FIR placement"
            value={placement}
            onChange={(e) =>
              nativeAction({ kind: 'placement', placement: e.target.value as 'input' | 'output' })
            }
          >
            <option value="input">Shared input · 4,500 taps</option>
            <option value="output">Per output · 1,500 taps each</option>
          </select>
        </label>
        <button
          className={styles.clear}
          title="Native HFD Clear retains enable settings and clears shared input plus the selected output"
          onClick={() => nativeAction({ kind: 'clear', output: (selected + 1) as 1 | 2 | 3 })}
        >
          <X size={13} />
          <span>Clear input + {preset.channels[selected].name}</span>
        </button>
        <div className={styles.hardwareActions}>
          <button
            disabled={!live}
            onClick={() =>
              run('Reading FIR', async () => {
                const r = await readFir(live!.session, presetIndex + 1);
                if (onReadFir) onReadFir(r);
                else edit((p) => applyReadFir(p, r));
                await refresh();
                notice('FIR read and exact recovery manifest saved.');
              })
            }
          >
            <ArrowDownToLine size={13} /> Read FIR
          </button>
          <button
            disabled={!live || !!uploadScopeError}
            onClick={() =>
              run('Uploading FIR', async () => {
                await uploadFir(live!.session, presetIndex + 1, preset);
                await refresh();
                notice('FIR flash, names and activation verified. Outputs remain muted.');
              })
            }
          >
            <ArrowUpFromLine size={13} /> Upload FIR
          </button>
        </div>
      </div>
      <table className={styles.banks} aria-label="FIR banks">
        <colgroup>
          <col className={styles.bankColumn} />
          <col />
          <col className={styles.tapsColumn} />
          <col className={styles.enableColumn} />
          <col className={styles.actionsColumn} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Bank</th>
            <th scope="col">File / state</th>
            <th scope="col">Taps</th>
            <th scope="col">Enabled</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {[-1, 0, 1, 2].map((i) => {
            const f = i === -1 ? preset.inputFir : preset.channels[i].fir,
              active = (i === -1) === (placement === 'input'),
              state = firState(f, active),
              readOnly = i >= 0 && preset.channels[i].linkedTo !== undefined,
              bank = i === -1 ? 'Input FIR' : preset.channels[i].name,
              accessibleBank = i === -1 ? bank : `CH ${i + 1} ${bank}`;
            return (
              <tr
                key={i}
                data-selected={i === selected || undefined}
                aria-current={i === selected ? 'true' : undefined}
              >
                <th scope="row">
                  <strong className={styles.bankName} title={bank}>
                    {bank}
                  </strong>
                  <span className={styles.bankMeta}>
                    {i === -1 ? 'Shared input' : `Output ${i + 1}`}
                    {readOnly ? ` · Linked to CH ${preset.channels[i].linkedTo! + 1}` : ''}
                  </span>
                </th>
                <td>
                  <span
                    className={styles.filename}
                    title={firDisplayName(f.name) || 'No FIR loaded'}
                  >
                    {firDisplayName(f.name) || 'No FIR loaded'}
                  </span>
                  <span className={styles.state}>
                    {!state.loaded
                      ? `Awaiting FIR data${f.enabled ? ' · enable setting retained' : ''}`
                      : !state.used
                        ? 'Loaded · inactive placement'
                        : firIsEffective(f, active)
                          ? 'Processing enabled'
                          : 'Loaded · bypassed'}
                    {state.loaded && !active ? ' · outside selected placement' : ''}
                  </span>
                </td>
                <td>
                  <span className={styles.tapCount}>
                    {(state.loaded ? state.tapCount : 0).toLocaleString()}
                  </span>
                  <span className={styles.capacity}> / {i === -1 ? '4,500' : '1,500'}</span>
                </td>
                <td>
                  <label className={`toggle-label ${styles.enabled}`}>
                    <input
                      aria-label={`Enable ${accessibleBank}`}
                      type="checkbox"
                      checked={f.enabled}
                      disabled={
                        !active || (!state.loaded && !f.hfdState) || (readOnly && !f.hfdState)
                      }
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        if (f.hfdState)
                          nativeAction({
                            kind: 'enabled',
                            channel: (i + 1) as 0 | 1 | 2 | 3,
                            enabled,
                          });
                        else edit((p) => editPresetFir(p, i + 1, { enabled }));
                      }}
                    />
                    <span className="switch" />
                    <span className={styles.srOnly}>Enabled</span>
                  </label>
                </td>
                <td>
                  <div
                    className={styles.bankActions}
                    role="group"
                    aria-label={`${accessibleBank} actions`}
                  >
                    <button
                      disabled={readOnly}
                      onClick={() =>
                        readFile('.txt,.dat', (text, name) => {
                          const taps = parseFir(text, i === -1 ? 4500 : 1500);
                          edit((p) => editPresetFir(p, i + 1, { name, taps }));
                        })
                      }
                    >
                      <FolderOpen size={13} /> Load taps
                    </button>
                    <button
                      title="Export taps"
                      aria-label={`Export ${accessibleBank} taps`}
                      disabled={!state.loaded || !f.taps.length}
                      onClick={() =>
                        download(`${f.name || 'fir'}.txt`, f.taps.join('\n'), 'text/plain')
                      }
                    >
                      <Download size={13} />
                    </button>
                    <button
                      title="Unload FIR"
                      aria-label={`Unload ${accessibleBank}`}
                      disabled={(!state.loaded && !f.enabled && !f.name) || readOnly}
                      onClick={() => edit((p) => editPresetFir(p, i + 1, { clear: true }))}
                    >
                      <X size={13} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className={styles.note}>
        Native Clear retains enable settings and clears shared input plus the selected output.
        Unload removes one bank and resets its enable setting.
      </p>
      <section className={styles.recovery} aria-label="FIR recovery images">
        <div className={styles.recoveryHeading}>
          <h2>FIR recovery images</h2>
          <span>{backups.length} saved</span>
        </div>
        <div className={styles.recoveryList}>
          {backups.map((b) => (
            <div className={styles.recoveryRow} key={b.id}>
              <ShieldCheck size={15} aria-hidden="true" />
              <div className={styles.recoveryIdentity}>
                <strong>
                  Preset {b.preset} · {b.serial}
                </strong>
                <small>{new Date(b.utc).toLocaleString()}</small>
                <code title={b.sha256}>{b.sha256}</code>
              </div>
              <button
                onClick={() =>
                  download(`FIR-p${b.preset}-${b.id}.json`, JSON.stringify(b, null, 2))
                }
              >
                <Download size={13} /> Export
              </button>
              <button
                disabled={!live || live.identity.serial !== b.serial}
                onClick={() =>
                  run('Restoring FIR', async () => {
                    await restoreFir(live!.session, b);
                    await refresh();
                    notice(
                      'Complete FIR recovery image restored and verified. Outputs remain muted.',
                    );
                  })
                }
              >
                Restore
              </button>
            </div>
          ))}
          {!backups.length && (
            <p className={styles.emptyRecovery}>No recovery images saved in this browser.</p>
          )}
        </div>
      </section>
      <p className={styles.verification}>
        FIR programming and recovery pass simulated protocol tests. A muted comparison on the
        physical FA503 is pending. Each upload saves all shared FIR sectors, filenames and
        activation flags before programming; unused flash tails are preserved.
      </p>
    </div>
  );
}
