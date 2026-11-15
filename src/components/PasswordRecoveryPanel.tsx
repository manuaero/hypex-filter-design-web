'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Slot } from '../domain/model';
import type {
  PasswordRecoveryController,
  RecoveryCodeReview,
} from '../application/password-recovery';
import styles from './PasswordRecoveryPanel.module.css';

export default function PasswordRecoveryPanel({
  controller,
  slot,
  paused = false,
}: {
  controller: PasswordRecoveryController;
  slot: Slot;
  paused?: boolean;
}) {
  const snapshot = useSyncExternalStore(
      controller.subscribe,
      controller.getSnapshot,
      controller.getSnapshot,
    ),
    state = snapshot[slot],
    review = state.review;
  const [code, setCode] = useState(''),
    [codeReview, setCodeReview] = useState<RecoveryCodeReview>(),
    [confirmInstall, setConfirmInstall] = useState(false),
    [existingConfirmed, setExistingConfirmed] = useState(false),
    [supportConfirmed, setSupportConfirmed] = useState(false),
    [error, setError] = useState('');
  const generation = useRef(0),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    generation.current++;
    setCode('');
    setCodeReview(undefined);
    setConfirmInstall(false);
    setExistingConfirmed(false);
    setSupportConfirmed(false);
    setError('');
    return () => {
      mounted.current = false;
      generation.current++;
      controller.discardCodeReview(slot);
    };
  }, [controller, slot, state.target?.serial, state.target?.firmware, state.revision]);
  const busy = paused || state.busy;
  const run = async (fn: () => Promise<unknown>, after?: (result: unknown) => void) => {
    const request = ++generation.current;
    setError('');
    try {
      const result = await fn();
      if (mounted.current && generation.current === request) after?.(result);
    } catch {
      if (mounted.current && generation.current === request)
        setError(
          'Recovery action was not confirmed. Inspect its ledger; no write is retried automatically.',
        );
    }
  };
  const clear = () => {
    generation.current++;
    setCode('');
    setCodeReview(undefined);
    setConfirmInstall(false);
    setExistingConfirmed(false);
    setSupportConfirmed(false);
    setError('');
    controller.clear(slot);
  };
  const accepted =
    review?.source === 'installed-challenge' ||
    (state.lastResult?.operation === 'challenge-install' &&
      state.lastResult.mutation === 'acknowledged');
  return (
    <details
      className={styles.panel}
      onToggle={(e) => {
        if (!e.currentTarget.open) clear();
      }}
    >
      <summary>Forgotten password</summary>
      <div className={styles.body}>
        <p className={styles.note}>
          Manual Hypex support handoff. This app does not contact support or generate an unlock
          code. Device behavior is reconstructed from HFD and v5.82; physical 5.7 acceptance is
          unverified.
        </p>
        <p>
          <strong>{slot === 'left' ? 'Left' : 'Right'}</strong> ·{' '}
          {state.target?.serial ?? 'No compatible connection'} ·{' '}
          {state.protection?.locked
            ? 'Locked'
            : 'Fresh locked/OEM status checked before each action'}
        </p>
        <div className={styles.row}>
          <button
            type="button"
            disabled={busy || !state.connected}
            onClick={() => void run(() => controller.review(slot, { source: 'new-challenge' }))}
          >
            Review new request
          </button>
          <button type="button" disabled={busy} onClick={clear}>
            Clear recovery form
          </button>
        </div>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={existingConfirmed}
            disabled={busy}
            onChange={(e) => setExistingConfirmed(e.target.checked)}
          />
          I already requested a code from Hypex support for this amplifier’s installed challenge.
        </label>
        <button
          type="button"
          disabled={busy || !state.connected || !existingConfirmed}
          onClick={() =>
            void run(() =>
              controller.review(slot, { source: 'installed-challenge', sourceConfirmed: true }),
            )
          }
        >
          Review existing support request
        </button>
        {review && (
          <div className={styles.review}>
            <p>
              <strong>Captured amplifier:</strong> {review.target.serial} · review {review.revision}
            </p>
            {review.uniqueKey && (
              <>
                <label>
                  Unique key{' '}
                  <input aria-label="Recovery unique key" readOnly value={review.uniqueKey} />
                </label>
                <p className={styles.note}>
                  Confirming installs this challenge and replaces the prior request. An ACK cannot
                  verify challenge persistence. After acceptance, contact Hypex support yourself
                  with this exact key.
                </p>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={confirmInstall}
                    disabled={busy || accepted}
                    onChange={(e) => setConfirmInstall(e.target.checked)}
                  />
                  Install this unique key on {review.target.serial}.
                </label>
                <button
                  type="button"
                  disabled={busy || accepted || !confirmInstall || !!state.lastResult}
                  onClick={() =>
                    void run(() =>
                      controller.confirmChallenge(slot, {
                        reviewId: review.id,
                        revision: review.revision,
                        uniqueKey: review.uniqueKey!,
                        confirm: true,
                      }),
                    )
                  }
                >
                  Confirm unlock request
                </button>
              </>
            )}
            {accepted && (
              <>
                <p className={styles.note}>
                  {review.source === 'new-challenge'
                    ? 'Challenge request acknowledged. Preserve the unique key and obtain the received code directly from Hypex support.'
                    : 'Existing support request confirmed by you; its challenge is not reinstalled.'}
                </p>
                <label>
                  Received unlock code{' '}
                  <input
                    aria-label="Received unlock code"
                    type="password"
                    autoComplete="off"
                    value={code}
                    disabled={busy}
                    onChange={(e) => {
                      setCode(e.target.value);
                      setCodeReview(undefined);
                      controller.discardCodeReview(slot);
                    }}
                  />
                </label>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={supportConfirmed}
                    disabled={busy}
                    onChange={(e) => {
                      setSupportConfirmed(e.target.checked);
                      setCodeReview(undefined);
                      controller.discardCodeReview(slot);
                    }}
                  />
                  This code came from Hypex support for {review.target.serial}.
                </label>
                <button
                  type="button"
                  disabled={busy || !code || !supportConfirmed}
                  onClick={() =>
                    void run(
                      () =>
                        controller.reviewCode(slot, {
                          reviewId: review.id,
                          revision: review.revision,
                          code,
                          source: 'hypex-support',
                        }),
                      (result) => {
                        setCode('');
                        setCodeReview(result as RecoveryCodeReview);
                      },
                    )
                  }
                >
                  Review received code
                </button>
                {codeReview && state.codeReviewReady && codeReview.reviewId === review.id && (
                  <div className={styles.review}>
                    <p>
                      Native first-four-character value: <strong>{codeReview.canonicalCode}</strong>
                      . Confirm resetting the password on {codeReview.target.serial}. Stored
                      recovery email is retained.
                    </p>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            controller.submitCode(slot, {
                              reviewId: review.id,
                              revision: review.revision,
                              codeReviewId: codeReview.id,
                              source: 'hypex-support',
                              confirm: true,
                            }),
                          () => {
                            setCode('');
                            setCodeReview(undefined);
                          },
                        )
                      }
                    >
                      Confirm password reset
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {state.lastResult && (
          <div className={styles.ledger} role="status">
            <strong>
              {state.lastResult.operation}: {state.lastResult.mutation}
            </strong>
            <span>
              {state.lastResult.persistence === 'password-cleared'
                ? 'Fresh status reports no password set.'
                : 'Persistent challenge readback unavailable.'}
            </span>
            {state.lastResult.steps.map((step, index) => (
              <span key={index}>
                {step.name}: {step.state}
              </span>
            ))}
          </div>
        )}
        {(error || state.error) && <p role="alert">{error || state.error}</p>}
      </div>
    </details>
  );
}
