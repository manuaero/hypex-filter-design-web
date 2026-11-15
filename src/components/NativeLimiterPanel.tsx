'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Numeric from './Numeric';
import type { Slot } from '../domain/model';
import type { ExecutionPrincipal } from '../application/execution-context';
import type {
  NativeLimiterController,
  NativeLimiterEditAction,
  NativeLimiterTarget,
} from '../application/native-limiter';
import type { NativeLimiterChannel, NativeLimiterField } from '../hardware/native-limiter';
import styles from './NativeLimiterPanel.module.css';

const label = (target: NativeLimiterTarget) =>
  target === 'both' ? 'Left + Right' : target === 'left' ? 'Left' : 'Right';
const number = (value: number, digits = 6) =>
  Number.isFinite(value) ? String(Number(value.toFixed(digits))) : 'Unavailable';
const coefficient = (value: number) => (Number.isFinite(value) ? value.toFixed(6) : 'Unavailable');
const fields: readonly NativeLimiterField[] = ['threshold', 'attack', 'release'];
const channels: readonly NativeLimiterChannel[] = [0, 1, 2];

export default function NativeLimiterPanel({
  controller,
  slot,
  connectedRoles,
  getContext,
  contextReady = true,
  externalBusy = false,
}: {
  controller: NativeLimiterController;
  slot: Slot;
  connectedRoles: readonly Slot[];
  getContext: () => ExecutionPrincipal;
  contextReady?: boolean;
  externalBusy?: boolean;
}) {
  const snapshot = useSyncExternalStore(
      controller.subscribe,
      controller.getSnapshot,
      controller.getSnapshot,
    ),
    role = snapshot.roles[slot],
    draft = role.draft,
    review = snapshot.activeReview;
  const [target, setTarget] = useState<NativeLimiterTarget>(slot),
    [confirmedReviewId, setConfirmedReviewId] = useState<string>(),
    [failure, setFailure] = useState(''),
    [notice, setNotice] = useState(''),
    [localBusy, setLocalBusy] = useState(false);
  const mounted = useRef(false),
    generation = useRef(0),
    flight = useRef(false),
    currentSlot = useRef(slot),
    context = useRef(getContext);
  currentSlot.current = slot;
  context.current = getContext;
  const busy = localBusy || snapshot.busy || externalBusy,
    selected = review?.target ?? target,
    selectedRoles: readonly Slot[] = selected === 'both' ? ['left', 'right'] : [selected],
    available = selectedRoles.every((s) => connectedRoles.includes(s)),
    reviewable = selectedRoles.every(
      (s) =>
        snapshot.roles[s].draft &&
        snapshot.roles[s].preview &&
        snapshot.roles[s].canUpdate !== false,
    ),
    disabledDraft = busy || !contextReady || !!review || !draft;

  useEffect(() => {
    mounted.current = true;
    generation.current++;
    setFailure('');
    setNotice('');
    setConfirmedReviewId(undefined);
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [controller, slot]);
  useEffect(() => {
    setConfirmedReviewId(undefined);
    if (review) {
      setFailure('');
      setNotice('');
    }
  }, [review?.id]);
  useEffect(() => {
    if (!review && !snapshot.busy) setTarget(slot);
  }, [slot]);

  async function perform(work: (actor: ExecutionPrincipal) => unknown | Promise<unknown>) {
    if (flight.current || !contextReady) return;
    const captured = generation.current;
    flight.current = true;
    setLocalBusy(true);
    setFailure('');
    setNotice('');
    try {
      await work(context.current());
    } catch (error) {
      if (mounted.current && captured === generation.current)
        setFailure((error instanceof Error ? error.message : String(error)).slice(0, 2048));
    } finally {
      flight.current = false;
      if (mounted.current) setLocalBusy(false);
    }
  }
  const edit = (action: NativeLimiterEditAction) => {
    if (disabledDraft || currentSlot.current !== slot) return;
    try {
      controller.edit(slot, context.current(), {
        expectedRevision: controller.getSnapshot().revision,
        action,
      });
      setFailure('');
      setNotice('');
      setConfirmedReviewId(undefined);
    } catch (error) {
      setFailure((error instanceof Error ? error.message : String(error)).slice(0, 2048));
    }
  };
  const draftContext = `${slot}:${role.identity?.serial ?? ''}:${snapshot.revision}`;
  return (
    <section className={`feature-card ${styles.panel}`} aria-label="Native limiter editor">
      <div className={styles.heading}>
        <h2>Soft-clip limiter · {label(slot)}</h2>
        <div className={styles.toolbar}>
          {!review && (
            <label className={styles.expertToggle}>
              <input
                type="checkbox"
                aria-label="Expert limiter coefficients"
                checked={role.expert}
                disabled={disabledDraft}
                onChange={(event) => edit({ type: 'expert-mode', value: event.target.checked })}
              />
              Expert
            </label>
          )}
          <label>
            Apply to
            <select
              aria-label="Limiter target"
              value={selected}
              disabled={busy || !!review || !contextReady}
              onChange={(event) => setTarget(event.target.value as NativeLimiterTarget)}
            >
              <option value="left">Left</option>
              <option value="right">Right</option>
              <option value="both">Left + Right</option>
            </select>
          </label>
          <button
            type="button"
            disabled={busy || !contextReady || !available || !!review}
            onClick={() => perform((actor) => controller.load(target, actor))}
          >
            Read {label(selected)}
          </button>
          <button
            type="button"
            disabled={busy || !contextReady || !available || !reviewable || !!review}
            onClick={() =>
              perform((actor) =>
                controller.review(target, actor, {
                  expectedRevision: controller.getSnapshot().revision,
                }),
              )
            }
          >
            Review update
          </button>
        </div>
      </div>
      <div className={styles.identity}>
        {role.identity ? (
          <strong>{role.identity.serial}</strong>
        ) : (
          <strong>{label(slot)} · not read</strong>
        )}
        {draft && (
          <span>
            Bridge {draft.bridged ? 'On' : 'Off'} · CH3{' '}
            {draft.thirdChannelEnabled ? 'enabled' : 'disabled'}
          </span>
        )}
        <span>{connectedRoles.includes(slot) ? 'Connected' : 'Offline'}</span>
      </div>
      {selected === 'both' && (
        <p className={`${styles.muted} ${styles.help}`}>
          Apply each amplifier’s own draft. Editing here changes {label(slot)} only.
        </p>
      )}
      {!draft && !review && (
        <p className={`${styles.muted} ${styles.help}`}>
          Read the selected amplifier to load its exact coefficients. Opening this editor makes no
          device call.
        </p>
      )}
      {draft && !review && (
        <div className={styles.editor}>
          <table className={styles.channelTable} aria-label="Limiter output power and load">
            <thead>
              <tr>
                <th>Output</th>
                <th>Maximum power · W</th>
                <th>Load · Ω</th>
                <th>Threshold on update</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((i) => (
                <tr key={i}>
                  <th scope="row">CH{i + 1}</th>
                  {(draft.bridged && i === 1) || (!draft.thirdChannelEnabled && i === 2) ? (
                    <td colSpan={2} className={styles.muted}>
                      {i === 1
                        ? 'Bridge pair · power retained; load follows CH1.'
                        : 'Output disabled · power and load retained.'}
                    </td>
                  ) : (
                    <>
                      <td>
                        <Numeric
                          commitOnly
                          label={`CH${i + 1} maximum power`}
                          value={draft.channels[i].watts}
                          min={0}
                          max={1000}
                          step={5}
                          precision={0}
                          contextKey={draftContext}
                          disabled={disabledDraft}
                          onChange={(value) => edit({ type: 'power', channel: i, value })}
                        />
                      </td>
                      <td>
                        <Numeric
                          commitOnly
                          label={`CH${i + 1} impedance`}
                          value={draft.channels[i].ohms}
                          min={1}
                          max={25}
                          step={0.1}
                          precision={1}
                          contextKey={draftContext}
                          disabled={disabledDraft}
                          onChange={(value) => edit({ type: 'impedance', channel: i, value })}
                        />
                      </td>
                    </>
                  )}
                  <td>
                    {role.preview ? coefficient(role.preview.channels[i].threshold) : 'Unavailable'}
                    <p className={styles.muted}>
                      Loaded {coefficient(draft.channels[i].loaded.threshold)}
                    </p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!role.expert && (
            <div className={styles.timing}>
              <Numeric
                commitOnly
                label="Global attack"
                value={draft.attackMs}
                unit="ms"
                min={0.3}
                max={999.9}
                step={0.1}
                precision={1}
                contextKey={draftContext}
                disabled={disabledDraft}
                onChange={(value) => edit({ type: 'attack-time', value })}
              />
              <Numeric
                commitOnly
                label="Global release"
                value={draft.releaseMs}
                unit="ms"
                min={5}
                max={99.9}
                step={0.1}
                precision={1}
                contextKey={draftContext}
                disabled={disabledDraft}
                onChange={(value) => edit({ type: 'release-time', value })}
              />
            </div>
          )}
          {role.expert && (
            <table className={styles.coefficientTable} aria-label="Expert limiter coefficient text">
              <thead>
                <tr>
                  <th>Output</th>
                  <th>Threshold</th>
                  <th>Attack</th>
                  <th>Release</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((i) => (
                  <tr key={i}>
                    <th scope="row">CH{i + 1}</th>
                    {fields.map((field) => (
                      <td key={field}>
                        <label className={styles.coefficientField}>
                          <input
                            type="text"
                            inputMode="decimal"
                            aria-label={`CH${i + 1} ${field} coefficient`}
                            value={draft.channels[i][`${field}Text`]}
                            disabled={disabledDraft}
                            onChange={(event) =>
                              edit({
                                type: 'expert-text',
                                channel: i,
                                field,
                                text: event.target.value,
                              })
                            }
                            onBlur={() => edit({ type: 'expert-exit', channel: i, field })}
                          />
                          <small>
                            Loaded {coefficient(draft.channels[i].loaded[field])} · word{' '}
                            {draft.channels[i].loaded[`${field}Word`]}
                          </small>
                          <small>
                            Planned Q24 word{' '}
                            {role.preview?.channels[i][`${field}Word`] ?? 'Unavailable'}
                          </small>
                        </label>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className={`${styles.muted} ${styles.help}`}>
            {role.expert
              ? 'Update recalculates all thresholds from power and load. In-range attack/release text retains its entered precision.'
              : 'Reading keeps the loaded timing; explicit time edits change all three outputs.'}
            {draft.bridged && ' Bridge mode hides CH2 power/load; its update threshold is 20.'}
            {!draft.thirdChannelEnabled && ' Disabled CH3 uses update threshold 20.'}
          </p>
          <p className={`${styles.muted} ${styles.help}`}>
            Edits are staged. Read replaces the draft; Update requires a captured review and retains
            master mute.
          </p>
        </div>
      )}
      {role.canUpdate === false && (
        <p className={`${styles.warning} ${styles.help}`}>
          The current amplifier permissions do not allow a limiter update.
        </p>
      )}
      {review && (
        <div className={styles.review} aria-label="Limiter update review">
          <div className={styles.reviewHeading}>
            <h3>Captured update · {label(review.target)}</h3>
            <span className={styles.muted}>Revision {review.revision}</span>
          </div>
          <div className={styles.reviewIdentities}>
            {review.roles.map((r) => (
              <strong key={r.slot}>
                {label(r.slot)} · {r.identity.serial} · bridge {r.draft.bridged ? 'On' : 'Off'}
              </strong>
            ))}
          </div>
          <p className={styles.warning}>
            The original configuration is backed up before writing. Every selected amplifier is
            muted and remains muted. No automatic retry or rollback.
          </p>
          <div className={styles.reviewScroll} tabIndex={0} aria-label="Captured limiter changes">
            <table className={styles.reviewTable}>
              <thead>
                <tr>
                  <th>Output</th>
                  <th>Power / load · current → planned</th>
                  <th>Threshold</th>
                  <th>Attack</th>
                  <th>Release</th>
                </tr>
              </thead>
              <tbody>
                {review.roles.flatMap((r) =>
                  channels.map((i) => (
                    <tr key={`${r.slot}-${i}`}>
                      <th scope="row">
                        {label(r.slot)} CH{i + 1}
                      </th>
                      <td>
                        {number(r.before[i].watts)} W / {number(r.before[i].ohms)} Ω →{' '}
                        {number(r.after[i].watts)} W / {number(r.after[i].ohms)} Ω
                      </td>
                      <td>
                        {coefficient(r.before[i].threshold)} → {coefficient(r.after[i].threshold)}
                        <p className={styles.muted}>Q24 {r.after[i].thresholdWord}</p>
                      </td>
                      <td>
                        {coefficient(r.before[i].attack)} → {r.draft.channels[i].attackText}
                        <p className={styles.muted}>
                          {number(r.after[i].attackMs, 3)} ms · Q24 {r.after[i].attackWord}
                        </p>
                      </td>
                      <td>
                        {coefficient(r.before[i].release)} → {r.draft.channels[i].releaseText}
                        <p className={styles.muted}>
                          {number(r.after[i].releaseMs, 3)} ms · Q24 {r.after[i].releaseWord}
                        </p>
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
          <div className={styles.confirmation}>
            <label>
              <input
                type="checkbox"
                aria-label="Confirm captured limiter update"
                checked={confirmedReviewId === review.id}
                disabled={busy || !contextReady}
                onChange={(event) =>
                  setConfirmedReviewId(event.target.checked ? review.id : undefined)
                }
              />
              I reviewed these amplifiers and settings.
            </label>
            <div className={styles.actions}>
              <button
                type="button"
                disabled={busy || !contextReady}
                onClick={() => perform((actor) => controller.discard(review.id, actor))}
              >
                Cancel review
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || !contextReady || !available || confirmedReviewId !== review.id}
                onClick={() => {
                  const capturedGeneration = generation.current;
                  void perform(async (actor) => {
                    const result = await controller.apply(review.id, actor, { confirm: true });
                    if (mounted.current && capturedGeneration === generation.current)
                      setNotice(
                        result.complete
                          ? 'Limiter update verified. Outputs remain muted.'
                          : 'Update incomplete. Inspect each amplifier outcome.',
                      );
                  });
                }}
              >
                Update captured amplifiers
              </button>
            </div>
          </div>
        </div>
      )}
      {busy && (
        <p className={styles.status} role="status">
          Reading or updating captured limiter settings…
        </p>
      )}
      {notice && (
        <p className={styles.status} role="status">
          {notice}
        </p>
      )}
      {(failure || role.error || snapshot.error) && (
        <p className={styles.error} role="alert">
          {failure || role.error || snapshot.error}
        </p>
      )}
      {snapshot.lastResult && (
        <div className={styles.outcomes} aria-label="Last limiter update outcomes">
          {snapshot.lastResult.roles.map((r) => (
            <div key={r.slot} className={styles.outcome}>
              <strong>
                {label(r.slot)} · {r.identity.serial}
              </strong>
              <span>
                Preflight: {r.preflight === 'failed' ? 'Blocked' : r.preflight} · Last confirmed
                mute:{' '}
                {r.lastConfirmedMuted == null ? 'Unknown' : r.lastConfirmedMuted ? 'On' : 'Off'}
              </span>
              {r.steps.map((s) => (
                <span key={s.id}>
                  {s.id === 'mute' ? 'Mute' : 'Configuration'}:{' '}
                  <strong>
                    {s.verified
                      ? 'Verified'
                      : s.attempted
                        ? 'Unconfirmed'
                        : s.error
                          ? 'Blocked'
                          : 'Not sent'}
                  </strong>
                  {s.error && <span className={styles.warning}>{s.error}</span>}
                </span>
              ))}
              {r.backupId && (
                <span className={styles.muted}>Recovery configuration backup saved.</span>
              )}
              {r.error && <p className={styles.warning}>{r.error}</p>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
