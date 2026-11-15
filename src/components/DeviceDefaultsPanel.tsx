'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Slot } from '../domain/model';
import type { ExecutionPrincipal } from '../application/execution-context';
import type {
  DeviceDefaultsController,
  DeviceDefaultsTarget,
} from '../application/device-defaults';
import type { DeviceDefaultsSummary } from '../hardware/device-defaults';
import { deviceDefaultsRecordSummary } from '../application/device-defaults-view';
import { download } from '../domain/files';
import styles from './DeviceDefaultsPanel.module.css';

const label = (slot: DeviceDefaultsTarget) =>
  slot === 'both' ? 'Left + Right' : slot === 'left' ? 'Left' : 'Right';
const number = (value: number) =>
  Number.isFinite(value) ? Number(value.toPrecision(7)).toString() : String(value);
const state = (value: boolean) => (value ? 'On' : 'Off');
type Row = { label: string; value: (summary: DeviceDefaultsSummary) => string };
const rows: Row[] = [
  { label: 'Global mute', value: (s) => state(s.muted) },
  { label: 'Soft-clip limiter', value: (s) => state(s.softClip) },
  { label: 'Bridge mode', value: (s) => state(s.bridge) },
  { label: 'Master unit', value: (s) => state(s.master) },
  {
    label: 'Digital input',
    value: (s) =>
      ['Left + Right', 'Right', 'Left', 'User mixer', 'Disabled'][s.routing] ??
      `Other (${s.routing})`,
  },
  {
    label: 'Startup volume',
    value: (s) => (s.startupVolume === -200 ? 'Last used volume' : `${number(s.startupVolume)} dB`),
  },
  {
    label: 'Preset offsets · 1 / 2 / 3',
    value: (s) => `${s.presetOffsets.map(number).join(' / ')} dB`,
  },
  { label: 'Source locks · 1 / 2 / 3', value: (s) => s.sourceLocks.map(state).join(' / ') },
  { label: 'Volume locks · 1 / 2 / 3', value: (s) => s.volumeLocks.map(state).join(' / ') },
  { label: 'Auto-off', value: (s) => `${s.powerOffMinutes} min` },
  { label: 'Shutdown mode', value: (s) => (s.standbyMode === 0 ? 'Standby' : 'Low power') },
  { label: 'Signal detection', value: (s) => state(s.signalDetection) },
  { label: 'Detection ON / OFF', value: (s) => `${s.detectionOn} / ${s.detectionOff}` },
  { label: 'Wake on mains', value: (s) => state(s.wakeOnLine) },
  { label: 'Absolute sub-input volume', value: (s) => state(s.subAbsolute) },
  {
    label: 'Analog gain · XLR / RCA',
    value: (s) => `${state(s.analogGainXlr)} / ${state(s.analogGainRca)}`,
  },
  { label: 'DAC sound quality', value: (s) => String(s.soundQuality) },
  { label: 'DAC filter', value: (s) => String(s.dacFilter) },
  { label: 'Global FIR mode', value: (s) => String(s.firMode) },
  {
    label: 'Display · maximum / dimmed',
    value: (s) => `${s.oledMaximumBrightness} / ${s.oledDimmedBrightness}`,
  },
  {
    label: 'Standby light',
    value: (s) => ['Off', '100%', '50%', '25%'][s.standbyLedMode] ?? String(s.standbyLedMode),
  },
  ...[0, 1, 2].flatMap((i): Row[] => [
    {
      label: `CH${i + 1} limiter power / load`,
      value: (s) =>
        `${number(s.limiterChannels[i].watts)} W / ${number(s.limiterChannels[i].ohms)} Ω`,
    },
    {
      label: `CH${i + 1} limiter attack / release`,
      value: (s) =>
        `${number(s.limiterChannels[i].attackMs)} / ${number(s.limiterChannels[i].releaseMs)} ms`,
    },
  ]),
];

export default function DeviceDefaultsPanel({
  controller,
  slot,
  connectedRoles,
  getContext,
  contextReady = true,
  externalBusy = false,
}: {
  controller: DeviceDefaultsController;
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
  );
  const [target, setTarget] = useState<DeviceDefaultsTarget>(slot),
    [confirmedReviewId, setConfirmedReviewId] = useState<string>(),
    [failure, setFailure] = useState(''),
    [notice, setNotice] = useState(''),
    [localBusy, setLocalBusy] = useState(false),
    [historyLimit, setHistoryLimit] = useState(5);
  const contextRef = useRef(getContext),
    mounted = useRef(false),
    flight = useRef(false),
    reviewElement = useRef<HTMLDivElement>(null);
  contextRef.current = getContext;
  const review = snapshot.activeReview,
    busy = localBusy || snapshot.busy || externalBusy,
    selected = review?.target ?? target,
    available =
      selected === 'both'
        ? connectedRoles.includes('left') && connectedRoles.includes('right')
        : connectedRoles.includes(selected);
  useEffect(() => {
    let current = true;
    mounted.current = true;
    if (contextReady) {
      try {
        void controller.hydrate(contextRef.current()).catch((error) => {
          if (current) setFailure(error instanceof Error ? error.message : String(error));
        });
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      }
    }
    return () => {
      current = false;
      mounted.current = false;
    };
  }, [controller, contextReady]);
  useEffect(() => {
    setConfirmedReviewId(undefined);
    if (review) {
      setFailure('');
      setNotice('');
      reviewElement.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [review?.id]);
  useEffect(() => {
    if (!review && !snapshot.busy) setTarget(slot);
  }, [slot, review?.id]);

  async function perform(work: (context: ExecutionPrincipal) => unknown | Promise<unknown>) {
    if (flight.current || !contextReady) return;
    flight.current = true;
    setLocalBusy(true);
    setFailure('');
    setNotice('');
    try {
      await work(contextRef.current());
    } catch (error) {
      if (mounted.current)
        setFailure((error instanceof Error ? error.message : String(error)).slice(0, 2048));
    } finally {
      flight.current = false;
      if (mounted.current) setLocalBusy(false);
    }
  }
  const history = [...snapshot.records]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, historyLimit);
  return (
    <section className={`feature-card ${styles.panel}`} aria-label="Device Defaults">
      <div className={styles.heading}>
        <div>
          <h2>Device Defaults</h2>
          <p>
            Reset device settings using HFD defaults. Review the captured amplifier and every
            planned change first.
          </p>
        </div>
        <div className={styles.actions}>
          <select
            aria-label="Defaults target"
            value={selected}
            disabled={busy || !!review}
            onChange={(e) => setTarget(e.target.value as DeviceDefaultsTarget)}
          >
            <option value="left">Left</option>
            <option value="right">Right</option>
            <option value="both">Left + Right</option>
          </select>
          <button
            type="button"
            disabled={!contextReady || busy || !!review || !available}
            onClick={() => perform((actor) => controller.reviewDefaults(target, actor))}
          >
            Review defaults
          </button>
        </div>
      </div>
      {!available && !review && (
        <p className={styles.muted}>
          Connect the selected amplifier{selected === 'both' ? 's' : ''} to review defaults.
        </p>
      )}
      {review && (
        <div ref={reviewElement} className={styles.review} aria-label="Device Defaults review">
          <h3>
            {review.operation === 'defaults' ? 'Apply defaults' : 'Restore saved settings'} ·{' '}
            {label(review.target)}
          </h3>
          <div className={styles.identities}>
            {review.roles.map((role) => (
              <div key={role.slot}>
                <strong>
                  {label(role.slot)} · {role.identity.serial}
                </strong>
                <span>
                  Firmware {role.identity.firmware} · DSP {role.identity.core}
                </span>
              </div>
            ))}
          </div>
          <p className={styles.warning}>
            {review.operation === 'defaults'
              ? 'Defaults disable the soft-clip limiter and bridge mode, and select the Left digital input. Outputs stay muted.'
              : 'Restore the settings changed by this operation. Current runtime, unrelated settings and filter data are retained; outputs stay muted.'}
          </p>
          <div className={styles.tableScroll} tabIndex={0} aria-label="Planned device settings">
            <table>
              <thead>
                <tr>
                  <th rowSpan={2}>Setting</th>
                  {review.roles.map((role) => (
                    <th colSpan={2} key={role.slot}>
                      {label(role.slot)}
                    </th>
                  ))}
                </tr>
                <tr>
                  {review.roles.flatMap((role) => [
                    <th key={`${role.slot}-before`}>Current</th>,
                    <th key={`${role.slot}-after`}>Planned</th>,
                  ])}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    {review.roles.flatMap((role) => {
                      const before = row.value(role.before),
                        after = row.value(role.after);
                      return [
                        <td key={`${role.slot}-before`}>{before}</td>,
                        <td key={`${role.slot}-after`} data-changed={before !== after || undefined}>
                          {after}
                        </td>,
                      ];
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.muted}>
            Preset sources, EQ/FIR activation and filter data are preserved. Complete recovery
            records are saved before the first write.
          </p>
          <div className={styles.confirmation}>
            <label>
              <input
                type="checkbox"
                aria-label="Confirm the captured Defaults settings"
                checked={confirmedReviewId === review.id}
                disabled={busy || !contextReady}
                onChange={(e) => setConfirmedReviewId(e.target.checked ? review.id : undefined)}
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
                disabled={busy || confirmedReviewId !== review.id || !contextReady}
                onClick={() =>
                  perform(async (actor) => {
                    const result =
                      review.operation === 'defaults'
                        ? await controller.apply(review.id, actor, { confirm: true })
                        : await controller.restore(review.id, actor, { confirm: true });
                    if (mounted.current)
                      setNotice(
                        result.phase === 'complete'
                          ? 'All steps were verified. Outputs remain muted.'
                          : `Recorded result: ${result.phase}. Inspect the recovery history before another action.`,
                      );
                  })
                }
              >
                {review.operation === 'defaults'
                  ? 'Apply captured defaults'
                  : 'Restore captured settings'}
              </button>
            </div>
          </div>
        </div>
      )}
      {busy && (
        <p role="status">Device operation in progress. Each verified step is recorded below.</p>
      )}
      {notice && <p role="status">{notice}</p>}
      {(failure || snapshot.error) && (
        <p role="alert" className={styles.warning}>
          {failure || snapshot.error}
        </p>
      )}
      <div className={styles.historyHeading}>
        <h3>Recovery history</h3>
        <button
          type="button"
          disabled={busy || !contextReady}
          onClick={() => perform((actor) => controller.hydrate(actor))}
        >
          Reload history
        </button>
      </div>
      {!history.length && (
        <p className={styles.muted}>
          No recorded Defaults operations. History does not query an amplifier.
        </p>
      )}
      {history.map((stored) => {
        const record = deviceDefaultsRecordSummary(stored),
          recoverable =
            record.operation === 'defaults' &&
            record.roles.every((role) => connectedRoles.includes(role.slot));
        return (
          <article
            key={record.id}
            className={styles.record}
            aria-label={`${label(record.target)} Defaults record ${record.id}`}
          >
            <div className={styles.recordHeading}>
              <strong>
                {label(record.target)} · {record.operation === 'defaults' ? 'Defaults' : 'Restore'}{' '}
                · {record.phase}
              </strong>
              <span>{new Date(record.updatedAt).toLocaleString()}</span>
            </div>
            {record.error && <p className={styles.warning}>{record.error}</p>}
            {record.roles.map((role) => (
              <div key={role.slot} className={styles.outcome}>
                <strong>
                  {label(role.slot)} · {role.identity.serial}
                </strong>
                <span>
                  Preflight: {role.preflight} · Last confirmed mute:{' '}
                  {state(role.lastConfirmedMuted)}
                </span>
                <ol>
                  {role.steps.map((step) => (
                    <li key={step.id}>
                      <span>{step.id.replaceAll('-', ' ')}</span>
                      <strong>
                        {step.state === 'verified'
                          ? 'Verified'
                          : step.attempted
                            ? 'Unconfirmed'
                            : step.state === 'failed'
                              ? 'Blocked before send'
                              : 'Not sent'}
                      </strong>
                      {step.error && <span className={styles.warning}>{step.error}</span>}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
            <div className={styles.actions}>
              <button
                type="button"
                disabled={busy || !contextReady}
                onClick={() =>
                  perform((actor) =>
                    download(
                      `fa503-defaults-${record.id}.json`,
                      JSON.stringify(controller.exportRecord(record.id, actor), null, 2),
                    ),
                  )
                }
              >
                Download recovery JSON
              </button>
              {record.operation === 'defaults' && (
                <button
                  type="button"
                  disabled={busy || !!review || !contextReady || !recoverable}
                  onClick={() => perform((actor) => controller.reviewRecovery(record.id, actor))}
                >
                  Review restore
                </button>
              )}
            </div>
          </article>
        );
      })}
      {snapshot.records.length > history.length && (
        <button type="button" disabled={busy} onClick={() => setHistoryLimit((limit) => limit + 5)}>
          Show more records
        </button>
      )}
    </section>
  );
}
