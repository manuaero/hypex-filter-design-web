'use client';

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Slot } from '../domain/model';
import type { ToolExecutionContext } from '../application/execution-context';
import type {
  NativeMixerController,
  NativeMixerPreset,
  NativeMixerResult,
  NativeMixerTarget,
} from '../application/native-mixer';
import type { NativeMixerIdentity } from '../hardware/native-mixer';
import { downloadBrowserBlob } from '../domain/browser-download';
import styles from './NativeMixerPanel.module.css';

export interface NativeMixerPanelProps {
  controller: NativeMixerController;
  slot: Slot;
  preset: NativeMixerPreset;
  onPresetChange(preset: NativeMixerPreset): void;
  connectedRoles: readonly Slot[];
  getContext(): ToolExecutionContext;
  contextReady?: boolean;
  externalBusy?: boolean;
}
const label = (target: NativeMixerTarget) =>
  target === 'both' ? 'Left + Right' : target === 'left' ? 'Left' : 'Right';
const slots = (target: NativeMixerTarget): Slot[] =>
  target === 'both' ? ['left', 'right'] : [target];
const targetFor = (roles: readonly Slot[]): NativeMixerTarget =>
  roles.length === 2 ? 'both' : roles[0];
const problem = (error: unknown) =>
  error instanceof Error ? error.message : 'Mixer operation was not confirmed';
const exact = (value: number) =>
  Number.isFinite(value) ? String(Number(value.toFixed(8))) : 'Unavailable';
const text = (value: number) =>
  Number.isFinite(value) ? (value === 0 ? 0 : value).toFixed(2) : '';
const sameIdentity = (a: NativeMixerIdentity | undefined, b: NativeMixerIdentity) =>
  !!a &&
  a.serial === b.serial &&
  a.product === b.product &&
  a.core === b.core &&
  a.firmware === b.firmware;

/** Text is a local editing draft. No formatting is written into the shared
 * matrix: the controller owns the native row-open and numeric-edit behavior. */
function Weight({
  name,
  value,
  current,
  planned,
  contextKey,
  disabled,
  onValue,
  onError,
}: {
  name: string;
  value: number;
  current: number;
  planned: number;
  contextKey: string;
  disabled: boolean;
  onValue(value: number): number | undefined;
  onError(message: string): void;
}) {
  const [draft, setDraft] = useState(text(value)),
    [inputError, setInputError] = useState(''),
    dirty = useRef(false),
    origin = useRef(contextKey);
  useLayoutEffect(() => {
    origin.current = contextKey;
    dirty.current = false;
    setDraft(text(value));
    setInputError('');
  }, [contextKey, value]);
  const commit = () => {
    if (origin.current !== contextKey || !dirty.current || disabled) return;
    dirty.current = false;
    const parsed = draft.trim() === '' ? NaN : Number(draft.replace(',', '.'));
    if (!Number.isFinite(parsed)) {
      setDraft(text(value));
      const message = `${name} requires a number from −1 to 1.`;
      setInputError(message);
      onError(message);
      return;
    }
    setInputError('');
    const accepted = onValue(parsed);
    setDraft(text(accepted ?? value));
  };
  return (
    <label className={styles.weight}>
      <span className={styles.srOnly}>{name}</span>
      <input
        aria-label={name}
        aria-invalid={!!inputError}
        type="text"
        inputMode="decimal"
        value={draft}
        disabled={disabled}
        onChange={(event) => {
          dirty.current = true;
          setDraft(event.target.value);
          setInputError('');
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            dirty.current = false;
            setDraft(text(value));
            setInputError('');
          }
        }}
      />
      {inputError && (
        <small role="alert" className={styles.error}>
          {inputError}
        </small>
      )}
      <small>
        Current {exact(current)} → planned {exact(planned)}
      </small>
    </label>
  );
}

/** Conditional native OEM mixer. Entry reads and draft edits are distinct from
 * the adjacent explicit Save; manufacturing Enable mixer is never writable. */
export default function NativeMixerPanel({
  controller,
  slot,
  preset,
  onPresetChange,
  connectedRoles,
  getContext,
  contextReady = true,
  externalBusy = false,
}: NativeMixerPanelProps) {
  const snapshot = useSyncExternalStore(
      controller.subscribe,
      controller.getSnapshot,
      controller.getSnapshot,
    ),
    [target, setTarget] = useState<NativeMixerTarget>(slot),
    [authorizedOwner, setAuthorizedOwner] = useState<string>(),
    [accessError, setAccessError] = useState(''),
    [failure, setFailure] = useState(''),
    [localBusy, setLocalBusy] = useState(false),
    [outcome, setOutcome] = useState<NativeMixerResult>();
  let caller: ToolExecutionContext | undefined,
    contextError = '';
  if (contextReady)
    try {
      caller = getContext();
    } catch (error) {
      contextError = problem(error);
    }
  const owner = caller?.owner,
    review = snapshot.activeReview,
    selected = review?.target ?? target,
    selectedPreset = review?.preset ?? preset,
    selectedSlots = slots(selected),
    index = selectedPreset - 1,
    connectionKey = JSON.stringify(
      (['left', 'right'] as const).map((role) => [
        role,
        connectedRoles.includes(role),
        snapshot.roles[role].connected,
        snapshot.roles[role].identity,
        snapshot.roles[role].availability?.editorAvailable,
      ]),
    ),
    viewKey = JSON.stringify([slot, owner, preset, connectionKey]),
    busy = localBusy || snapshot.busy || externalBusy,
    authorized = !!owner && owner === authorizedOwner && !accessError && !contextError,
    available = selectedSlots.every(
      (role) => connectedRoles.includes(role) && snapshot.roles[role].connected,
    ),
    editable = selectedSlots.every(
      (role) =>
        snapshot.roles[role].availability?.editorAvailable &&
        snapshot.roles[role].canEdit &&
        snapshot.roles[role].current &&
        snapshot.roles[role].draft &&
        snapshot.roles[role].preview &&
        snapshot.roles[role].openedPresets[index] &&
        !snapshot.roles[role].error,
    ),
    changed = selectedSlots.some((role) => snapshot.roles[role].changedPresets[index]),
    anyDrafts = selectedSlots.some((role) => snapshot.roles[role].changedPresets.some(Boolean)),
    reviewCurrent =
      !review ||
      review.roles.every(
        (row) =>
          connectedRoles.includes(row.slot) &&
          snapshot.roles[row.slot].connected &&
          snapshot.roles[row.slot].canEdit &&
          snapshot.roles[row.slot].availability?.editorAvailable &&
          sameIdentity(snapshot.roles[row.slot].identity, row.identity),
      );
  const mounted = useRef(false),
    generation = useRef(0),
    flight = useRef(false),
    context = useRef(getContext),
    latestView = useRef(viewKey),
    lastEntry = useRef(''),
    observedResult = useRef(snapshot.lastResult),
    ignoreFlight = useRef(false);
  context.current = getContext;
  latestView.current = viewKey;
  useLayoutEffect(() => {
    mounted.current = true;
    lastEntry.current = '';
    controller.refreshBindings();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [controller]);
  useLayoutEffect(() => {
    generation.current++;
    observedResult.current = snapshot.lastResult;
    ignoreFlight.current = snapshot.busy;
    setOutcome(undefined);
    setFailure('');
  }, [controller, viewKey]);
  useLayoutEffect(() => {
    if (!caller || contextError) {
      setAuthorizedOwner(undefined);
      setAccessError(contextError);
      return;
    }
    try {
      controller.status(caller);
      setAuthorizedOwner(caller.owner);
      setAccessError('');
    } catch (error) {
      setAuthorizedOwner(undefined);
      setAccessError(problem(error));
    }
  }, [controller, owner, contextReady, contextError]);
  useEffect(() => {
    setTarget(slot);
  }, [slot]);
  useEffect(() => {
    if (review) {
      setTarget(review.target);
      setFailure('');
      setOutcome(undefined);
    }
  }, [review?.id]);
  useEffect(() => {
    const result = snapshot.lastResult;
    if (result !== observedResult.current) {
      observedResult.current = result;
      if (!result) setOutcome(undefined);
      else if (
        authorized &&
        !ignoreFlight.current &&
        result.roles.every(
          (row) =>
            connectedRoles.includes(row.slot) &&
            snapshot.roles[row.slot].connected &&
            sameIdentity(snapshot.roles[row.slot].identity, row.identity),
        )
      )
        setOutcome(result);
    }
    if (!snapshot.busy) ignoreFlight.current = false;
  }, [snapshot.lastResult, snapshot.busy, authorized, connectionKey]);

  async function perform(
    work: (actor: ToolExecutionContext, isCurrent: () => boolean) => unknown | Promise<unknown>,
  ) {
    if (flight.current || !authorized || externalBusy) return;
    const capturedGeneration = generation.current,
      capturedView = latestView.current;
    const isCurrent = () =>
      mounted.current &&
      generation.current === capturedGeneration &&
      latestView.current === capturedView;
    flight.current = true;
    setLocalBusy(true);
    setFailure('');
    try {
      await work(context.current(), isCurrent);
    } catch (error) {
      if (isCurrent()) setFailure(problem(error));
    } finally {
      flight.current = false;
      if (mounted.current) setLocalBusy(false);
    }
  }
  const invoke = (work: (actor: ToolExecutionContext) => void) => {
    if (busy || !authorized) return false;
    try {
      work(context.current());
      setFailure('');
      setOutcome(undefined);
      return true;
    } catch (error) {
      setFailure(problem(error));
      return false;
    }
  };

  // One automatic read/open per actual entry. A canceled or saved row remains
  // closed during ordinary status renders until the user explicitly reopens it.
  useEffect(() => {
    if (!authorized || busy || review) return;
    const entry = JSON.stringify([viewKey, selected, selectedPreset]);
    if (lastEntry.current === entry) return;
    lastEntry.current = entry;
    const eligible = selectedSlots.filter(
        (role) =>
          connectedRoles.includes(role) &&
          snapshot.roles[role].connected &&
          snapshot.roles[role].availability?.editorAvailable === true,
      ),
      unread = eligible.filter((role) => !snapshot.roles[role].current),
      toOpen = eligible.filter(
        (role) =>
          !!snapshot.roles[role].current &&
          snapshot.roles[role].canEdit &&
          !snapshot.roles[role].openedPresets[index],
      );
    if (!unread.length && !toOpen.length) return;
    void perform(async (actor, isCurrent) => {
      if (unread.length)
        await controller.load(targetFor(unread), actor, { preset: selectedPreset });
      if (!isCurrent()) return;
      if (toOpen.length)
        controller.open(targetFor(toOpen), context.current(), {
          expectedRevision: controller.getSnapshot().revision,
          preset: selectedPreset,
        });
    });
  }, [controller, viewKey, selected, selectedPreset, authorized, busy, review?.id]);

  const save = () => {
    if (busy || !authorized || !available || !reviewCurrent || (!review && (!editable || !changed)))
      return;
    void perform(async (actor, isCurrent) => {
      const captured =
        controller.getSnapshot().activeReview ??
        (await controller.review(selected, actor, {
          expectedRevision: controller.getSnapshot().revision,
          preset: selectedPreset,
        }));
      if (!isCurrent()) return;
      const currentActor = context.current();
      if (currentActor.owner !== actor.owner)
        throw new Error('Workspace changed; mixer was not saved');
      await controller.save(captured.id, currentActor, { confirm: true });
    });
  };
  return (
    <section className={`feature-card ${styles.panel}`} aria-label="Native User mixer">
      <div className={styles.heading}>
        <h2>Digital channel mix</h2>
        <div className={styles.toolbar}>
          <label>
            Preset{' '}
            <select
              aria-label="Mixer preset"
              value={selectedPreset}
              disabled={busy || !!review || !authorized}
              onChange={(event) => onPresetChange(Number(event.target.value) as NativeMixerPreset)}
            >
              {([1, 2, 3] as const).map((value) => (
                <option key={value} value={value}>
                  Preset {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            Save to{' '}
            <select
              aria-label="Mixer target"
              value={selected}
              disabled={busy || !!review || !authorized}
              onChange={(event) => {
                setTarget(event.target.value as NativeMixerTarget);
                setFailure('');
                setOutcome(undefined);
              }}
            >
              <option value="left">Left</option>
              <option value="right">Right</option>
              <option value="both">Left + Right</option>
            </select>
          </label>
          <button
            type="button"
            disabled={
              busy ||
              !authorized ||
              !available ||
              !!review ||
              anyDrafts ||
              selectedSlots.some(
                (role) => snapshot.roles[role].availability?.editorAvailable !== true,
              )
            }
            onClick={() =>
              void perform((actor) => controller.load(selected, actor, { preset: selectedPreset }))
            }
          >
            Refresh mixer
          </button>
        </div>
      </div>
      {!authorized ? (
        <p className={styles.notice} role={accessError || contextError ? 'alert' : undefined}>
          {accessError || contextError || 'Workspace access is loading.'}
        </p>
      ) : (
        <>
          <div className={styles.roles}>
            {selectedSlots.map((role) => {
              const state = snapshot.roles[role],
                captured = review?.roles.find((row) => row.slot === role),
                before = captured?.before ?? state.current,
                after = captured?.after ?? state.preview,
                opened = state.openedPresets[index],
                eligible = !!state.availability?.editorAvailable,
                canEdit = eligible && state.canEdit && opened && !!state.draft && !state.error;
              return (
                <section
                  key={role}
                  className={styles.role}
                  aria-label={`${label(role)} mixer draft`}
                >
                  <div className={styles.identity}>
                    <h3>
                      {label(role)} ·{' '}
                      {captured?.identity.serial ?? state.identity?.serial ?? 'Offline'}
                    </h3>
                    <span>
                      Enable mixer:{' '}
                      {state.availability
                        ? state.availability.enabled
                          ? 'On'
                          : 'Off'
                        : 'Not read'}{' '}
                      · read-only
                    </span>
                  </div>
                  {!connectedRoles.includes(role) || !state.connected ? (
                    <p>Connect the {label(role)} amplifier to read its mixer.</p>
                  ) : !eligible ? (
                    <p className={styles.muted}>
                      {state.reason ||
                        state.availability?.reason ||
                        state.error ||
                        'Native mixer capability is not available yet.'}
                    </p>
                  ) : (
                    <>
                      {state.current && before && after ? (
                        <table
                          className={styles.table}
                          aria-label={`${label(role)} preset ${selectedPreset} mixer weights`}
                        >
                          <thead>
                            <tr>
                              <th>Output</th>
                              <th>Digital Left</th>
                              <th>Digital Right</th>
                            </tr>
                          </thead>
                          <tbody>
                            {([1, 2, 3] as const).map((channel) => (
                              <tr key={channel}>
                                <th scope="row">CH{channel}</th>
                                {(['left', 'right'] as const).map((input, inputIndex) => {
                                  const cell = (channel - 1) * 2 + inputIndex,
                                    name = `${label(role)} preset ${selectedPreset} CH${channel} ${label(input)} weight`;
                                  return (
                                    <td key={input}>
                                      {canEdit && !review ? (
                                        <Weight
                                          key={`${role}:${selectedPreset}:${cell}`}
                                          name={name}
                                          value={state.draft![index][cell]}
                                          current={before[index][cell]}
                                          planned={after[index][cell]}
                                          contextKey={`${viewKey}:${role}:${snapshot.revision}`}
                                          disabled={busy}
                                          onError={setFailure}
                                          onValue={(value) => {
                                            const accepted = invoke((actor) => {
                                              controller.edit(role, actor, {
                                                expectedRevision: controller.getSnapshot().revision,
                                                preset: selectedPreset,
                                                channel,
                                                input,
                                                value,
                                              });
                                            });
                                            return accepted
                                              ? controller.getSnapshot().roles[role].draft?.[index][
                                                  cell
                                                ]
                                              : undefined;
                                          }}
                                        />
                                      ) : (
                                        <span className={styles.value}>
                                          Current {exact(before[index][cell])}
                                          <br />
                                          Planned {exact(after[index][cell])}
                                        </span>
                                      )}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <p className={styles.muted}>Reading the three preset matrices…</p>
                      )}
                      {state.changedPresets.some(Boolean) && (
                        <p className={styles.help}>
                          Unsaved presets:{' '}
                          {state.changedPresets
                            .flatMap((changed, p) => (changed ? [p + 1] : []))
                            .join(', ')}
                          .
                        </p>
                      )}
                      {state.reason && <p className={styles.error}>{state.reason}</p>}
                    </>
                  )}
                  {state.error && eligible && (
                    <p role="alert" className={styles.error}>
                      {state.error}
                    </p>
                  )}
                </section>
              );
            })}
          </div>
          <p className={`${styles.help} ${styles.muted}`}>
            Weights range from −1 to 1. A negative weight inverts that input contribution; the two
            weights are not normalized. Current and planned values include the device’s
            quantization. Entries use native two-decimal formatting.
          </p>
          {review && (
            <p className={styles.review}>
              Reviewed {label(review.target)} · Preset {review.preset} · {review.id}
            </p>
          )}
          <div className={styles.actions}>
            {!review &&
              selectedSlots.some(
                (role) =>
                  snapshot.roles[role].current && !snapshot.roles[role].openedPresets[index],
              ) && (
                <button
                  type="button"
                  disabled={
                    busy ||
                    !available ||
                    selectedSlots.some(
                      (role) =>
                        !snapshot.roles[role].canEdit ||
                        !snapshot.roles[role].availability?.editorAvailable ||
                        !snapshot.roles[role].current,
                    )
                  }
                  onClick={() =>
                    invoke((actor) => {
                      controller.open(selected, actor, {
                        expectedRevision: controller.getSnapshot().revision,
                        preset: selectedPreset,
                      });
                    })
                  }
                >
                  Edit {label(selected)} mixer
                </button>
              )}
            <button
              type="button"
              className="primary"
              disabled={
                busy || !available || !reviewCurrent || (!review && (!editable || !changed))
              }
              onClick={save}
            >
              {localBusy ? 'Working…' : 'Save mixer'}
            </button>
            {(review ||
              selectedSlots.some((role) => snapshot.roles[role].openedPresets[index])) && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  invoke((actor) => {
                    if (review) controller.discard(review.id, actor);
                    controller.cancel(selected, actor, { preset: selectedPreset });
                  })
                }
              >
                Cancel changes
              </button>
            )}
            <span className={styles.muted}>
              Save changes only preset {selectedPreset}; other preset drafts are retained.
            </span>
          </div>
          {(failure || snapshot.error) && (
            <p role="alert" className={`${styles.error} ${styles.notice}`}>
              {failure || snapshot.error}
            </p>
          )}
          {outcome && (
            <section className={styles.result} aria-label="Mixer outcome">
              <h3>
                {outcome.complete
                  ? 'Mixer verified'
                  : outcome.partial
                    ? 'Mixer partially confirmed'
                    : 'Mixer was not saved'}{' '}
                · Preset {outcome.preset}
              </h3>
              <ul>
                {outcome.roles.map((row) => (
                  <li key={row.slot}>
                    {label(row.slot)} · {row.identity.serial} ·{' '}
                    {
                      (
                        {
                          pending: 'Not sent',
                          intent: 'Not confirmed',
                          unchanged: 'Unchanged',
                          verified: 'Verified',
                          blocked: 'Blocked before send',
                          unconfirmed: 'Unconfirmed',
                        } as const
                      )[row.state]
                    }
                    {row.error ? ` · ${row.error}` : ''}
                  </li>
                ))}
              </ul>
              {outcome.error && <p className={styles.error}>{outcome.error}</p>}
            </section>
          )}
          <details className={styles.history}>
            <summary>Saved mixer records ({snapshot.records.length})</summary>
            <div className={styles.actions}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void perform((actor) => controller.refreshHistory(actor))}
              >
                Refresh history
              </button>
              <p className={styles.muted}>
                Local records retain before-images and attempted/confirmed outcomes. They do not
                restore mixer settings automatically.
              </p>
            </div>
            {!snapshot.records.length ? (
              <p className={styles.help}>No mixer records loaded.</p>
            ) : (
              <ol>
                {snapshot.records
                  .slice(-32)
                  .reverse()
                  .map((record) => (
                    <li key={record.id}>
                      <strong>
                        {label(record.target)} · Preset {record.preset} · {record.phase}
                      </strong>
                      <p>
                        {record.roles
                          .map(
                            (row) =>
                              `${label(row.slot)} ${row.identity.serial}: ${row.state === 'verified' ? 'Verified' : row.state === 'unconfirmed' || row.state === 'intent' ? 'Unconfirmed' : row.state === 'unchanged' ? 'Unchanged' : row.state === 'blocked' ? 'Blocked before send' : 'Not sent'}; ${row.attempted ? 'attempted' : 'not attempted'}`,
                          )
                          .join(' · ')}
                      </p>
                      <p className={styles.muted}>{record.id} · Retained before-images</p>
                      {record.error && <p className={styles.error}>{record.error}</p>}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void perform((actor) => {
                            const exported = controller.exportRecord(record.id, actor);
                            downloadBrowserBlob(
                              `hypex-mixer-${record.id}.json`,
                              new Blob([JSON.stringify(exported, null, 2)], {
                                type: 'application/json',
                              }),
                            );
                          })
                        }
                      >
                        Download record
                      </button>
                    </li>
                  ))}
              </ol>
            )}
          </details>
        </>
      )}
    </section>
  );
}
