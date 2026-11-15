'use client';
import { ChevronDown, Layers } from 'lucide-react';
import type { Channel } from '../domain/model';
import {
  phaseCurveAvailable,
  type PhaseViewPatch,
  type PhaseViewState,
} from '../application/graph-view';
import styles from './PhaseLayers.module.css';

export interface PhaseLayersProps {
  state: PhaseViewState;
  channels: readonly Channel[];
  channelIndex: number;
  onPatch: (patch: PhaseViewPatch) => void;
  disabled?: boolean;
  showSumControl?: boolean;
}

/** Native phase-series visibility is independent of channel processing and
 * UseInSum. The sum checkbox changes visibility, never its contributing set. */
export default function PhaseLayers({
  state,
  channels,
  channelIndex,
  onPatch,
  disabled = false,
  showSumControl = true,
}: PhaseLayersProps) {
  return (
    <details className={styles.menu}>
      <summary aria-label="Phase curves" title="Phase curve visibility">
        <Layers size={12} /> Curves <ChevronDown size={11} />
      </summary>
      <div className={styles.options} aria-label="Phase curve options">
        {channels.map((channel, index) => (
          <label key={channel.id} className={index === channelIndex ? styles.current : undefined}>
            <input
              type="checkbox"
              aria-label={`Show ${channel.name} phase`}
              checked={state.channels[index] ?? false}
              disabled={disabled || !phaseCurveAvailable(channel)}
              onChange={(event) => {
                const selected = [...state.channels];
                selected[index] = event.target.checked;
                onPatch({ channels: selected });
              }}
            />
            <span>
              {channel.name}
              {index === channelIndex ? ' · current' : ''}
            </span>
          </label>
        ))}
        {showSumControl && (
          <label
            className={styles.sum}
            title="Uses the outputs marked Include in sum; hiding a phase curve does not remove it from the sum."
          >
            <input
              type="checkbox"
              aria-label="Show phase sum"
              checked={state.sum}
              disabled={disabled}
              onChange={(event) => onPatch({ sum: event.target.checked })}
            />
            Show phase sum
          </label>
        )}
      </div>
    </details>
  );
}
