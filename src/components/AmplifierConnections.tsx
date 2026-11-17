'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Cable, RefreshCw, X } from 'lucide-react';
import type { Slot } from '../domain/model';
import type { AmplifierDiscoverySnapshot } from '../application/amplifier-discovery';
import styles from './AmplifierConnections.module.css';

interface Props {
  snapshot: AmplifierDiscoverySnapshot;
  busy: boolean;
  onClose(): void;
  onAdd(): Promise<unknown>;
  onDiscover(): Promise<unknown>;
  onAssign(id: string, slot: Slot | 'unassigned', revision: number): Promise<unknown>;
  onSwap(revision: number): void | Promise<unknown>;
  onAutoReconnect(enabled: boolean): void | Promise<unknown>;
  onRead(slot: Slot): Promise<unknown>;
}

export default function AmplifierConnections(props: Props) {
  const modal = useRef<HTMLDialogElement>(null);
  const [failure, setFailure] = useState('');
  const [working, setWorking] = useState(false);
  const { snapshot } = props;
  const locked = props.busy || working || snapshot.phase === 'discovering';
  useEffect(() => {
    const element = modal.current;
    if (element?.showModal) element.showModal();
    else element?.setAttribute('open', '');
    return () => element?.close?.();
  }, []);
  const perform = async (work: () => void | Promise<unknown>) => {
    setFailure('');
    setWorking(true);
    try {
      await work();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The connection could not be updated');
    } finally {
      setWorking(false);
    }
  };
  return (
    <dialog
      ref={modal}
      className={styles.dialog}
      aria-label="Amplifier connections"
      onCancel={props.onClose}
    >
      <header className={styles.header}>
        <div>
          <h2>Amplifiers</h2>
          <p>Connect once. This browser remembers which amp belongs on each side.</p>
        </div>
        <button aria-label="Close amplifier connections" onClick={props.onClose}>
          <X size={18} />
        </button>
      </header>
      <div className={styles.toolbar}>
        <button
          className="primary"
          disabled={locked || !snapshot.supported}
          onClick={() => void perform(props.onAdd)}
        >
          <Cable size={15} /> Add amplifier
        </button>
        <button
          disabled={locked || !snapshot.supported}
          onClick={() => void perform(props.onDiscover)}
        >
          <RefreshCw size={14} /> Find permitted amplifiers
        </button>
        <button
          disabled={locked || !snapshot.roles.left || !snapshot.roles.right}
          onClick={() => void perform(() => props.onSwap(snapshot.revision))}
        >
          Swap Left and Right
        </button>
      </div>
      {!snapshot.supported && (
        <p role="status">USB connection needs desktop Chrome or Edge with WebHID support.</p>
      )}
      {(failure || snapshot.error) && (
        <p role="alert" className={styles.error}>
          {failure || snapshot.error}
        </p>
      )}
      {snapshot.preferencesError && (
        <p role="status">{snapshot.preferencesError} Assignments will last for this session.</p>
      )}
      <div className={styles.devices}>
        {snapshot.devices.map((device) => (
          <section
            key={device.id}
            className={styles.device}
            aria-label={`Amplifier ${device.serial ?? device.id}`}
          >
            <div className={styles.identity}>
              <strong>{device.name || 'Hypex amplifier'}</strong>
              <small>
                {device.serial ||
                  (device.phase === 'connecting'
                    ? 'Reading device identity…'
                    : 'Identity has not been read yet')}
                {device.firmware ? ` · Firmware ${device.firmware}` : ''}
              </small>
              <span>
                {device.phase === 'connected'
                  ? 'Connected'
                  : device.phase === 'connecting'
                    ? 'Connecting…'
                    : device.phase === 'error'
                      ? 'Connection needs attention'
                      : 'Available'}
              </span>
              {device.source === 'routing' && (
                <small>{device.hintReason}. Change side below if needed.</small>
              )}
              {device.source === 'remembered' && (
                <small>Remembered {device.slot === 'left' ? 'Left' : 'Right'} assignment</small>
              )}
              {device.hintReason && !device.source && <small>{device.hintReason}</small>}
              {device.error && <p role="alert">{device.error}</p>}
            </div>
            {device.serial && (
              <div className={styles.actions}>
                <label>
                  Use as
                  <select
                    aria-label={`Assignment for ${device.serial}`}
                    value={device.slot ?? 'unassigned'}
                    disabled={locked || device.phase === 'connecting'}
                    onChange={(event) =>
                      void perform(() =>
                        props.onAssign(
                          device.id,
                          event.target.value as Slot | 'unassigned',
                          snapshot.revision,
                        ),
                      )
                    }
                  >
                    <option value="unassigned">Unassigned</option>
                    <option value="left">Left</option>
                    <option value="right">Right</option>
                  </select>
                </label>
                {device.slot && (
                  <button
                    disabled={locked}
                    aria-label={`Load current filters and settings from ${device.slot === 'left' ? 'Left' : 'Right'}`}
                    title="Read all three presets and current settings into this side's local design. Does not upload or change the amplifier."
                    onClick={() => void perform(() => props.onRead(device.slot!))}
                  >
                    <ArrowDownToLine size={14} /> Load filters and settings
                  </button>
                )}
              </div>
            )}
          </section>
        ))}
        {!snapshot.devices.length && (
          <p className={styles.empty}>
            {snapshot.phase === 'discovering'
              ? 'Looking for permitted amplifiers…'
              : 'No permitted amplifiers found. Add an amplifier to grant USB access once.'}
          </p>
        )}
      </div>
      <footer className={styles.footer}>
        <label>
          <input
            type="checkbox"
            aria-label="Auto reconnect"
            checked={snapshot.autoReconnect}
            disabled={locked}
            onChange={(event) => void perform(() => props.onAutoReconnect(event.target.checked))}
          />{' '}
          Auto reconnect
        </label>
        <p>
          Assignments change this workspace connection only. Your designs stay on their editing
          sides. Loading reads from the amp; it never uploads or changes routing.
        </p>
      </footer>
    </dialog>
  );
}
