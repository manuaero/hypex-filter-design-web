'use client';
import { useEffect, useSyncExternalStore } from 'react';
import {
  NoiseControlError,
  type NoiseController,
  type NoiseControlResult,
  type NoiseTarget,
} from '../application/noise-control';
import styles from './NoisePanel.module.css';

export interface NoisePanelProps {
  controller: NoiseController;
  onError: (message: string, result?: NoiseControlResult) => void;
  onResult?: (result: NoiseControlResult) => void;
  paused?: boolean;
}
export default function NoisePanel({
  controller,
  onError,
  onResult,
  paused = false,
}: NoisePanelProps) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    controller.refreshBindings();
  }, [controller]);
  const set = (target: NoiseTarget, enabled: boolean) => {
    void controller
      .set(target, enabled)
      .then((result) => onResult?.(result))
      .catch((error) =>
        onError(
          error instanceof NoiseControlError
            ? error.message
            : 'The rotating-noise command was not confirmed',
          error instanceof NoiseControlError ? error.result : undefined,
        ),
      );
  };
  const bothDisabled =
    !state.left.connected ||
    !state.right.connected ||
    state.left.busy ||
    state.right.busy ||
    paused;
  return (
    <section className={styles.panel} aria-label="Rotating noise">
      <div className={styles.heading}>
        <h3>Rotating noise</h3>
        <div className={styles.actions}>
          <button disabled={bothDisabled} onClick={() => set('both', true)}>
            Start both
          </button>
          <button disabled={bothDisabled} onClick={() => set('both', false)}>
            Stop both
          </button>
        </div>
      </div>
      <div className={styles.roles}>
        {(['left', 'right'] as const).map((slot) => {
          const role = state[slot],
            label = slot === 'left' ? 'Left' : 'Right';
          const command = !role.connected
            ? 'Offline'
            : role.busy
              ? 'Command in progress…'
              : role.acknowledgement === 'none'
                ? 'Command state unknown'
                : `${role.requested ? 'Start' : 'Stop'} ${role.acknowledgement === 'accepted' ? 'acknowledged' : 'unconfirmed'}`;
          return (
            <div className={styles.role} key={slot}>
              <div className={styles.identity}>
                <strong>{label}</strong>
                <span>{role.identity?.serial ?? 'Not connected'}</span>
              </div>
              <div className={styles.state} role="status">
                <span>{command}</span>
                {role.error && <small>{role.error}</small>}
              </div>
              <div className={styles.actions}>
                <button
                  disabled={paused || !role.connected || role.busy}
                  aria-label={`Start rotating noise on ${label}`}
                  onClick={() => set(slot, true)}
                >
                  Start
                </button>
                <button
                  disabled={paused || !role.connected || role.busy}
                  aria-label={`Stop rotating noise on ${label}`}
                  onClick={() => set(slot, false)}
                >
                  Stop
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <p className={styles.note}>
        Acknowledgement confirms the command, not the actual sound state. Stop before disconnecting;
        closing the browser cannot guarantee a USB stop.
      </p>
    </section>
  );
}
