'use client';
import { ChevronDown, Layers } from 'lucide-react';
import type { Channel } from '../domain/model';
import type { GraphViewPatch, GraphViewState } from '../application/graph-view';

export interface PlotLayerControlsProps {
  state: GraphViewState;
  channels: readonly Channel[];
  channelIndex: number;
  onPatch: (patch: GraphViewPatch) => void;
  disabled?: boolean;
}

/** Presentation controls only. The owner stages/validates a shared controller
 * plan before changing either saved native flags or temporary view preferences. */
export default function PlotLayerControls({
  state,
  channels,
  channelIndex,
  onPatch,
  disabled = false,
}: PlotLayerControlsProps) {
  return (
    <details className="plot-layer-menu" style={{ position: 'relative' }}>
      <summary aria-label="Graph layers" title="Magnitude graph layers">
        <Layers size={12} /> Layers <ChevronDown size={11} />
      </summary>
      <div
        className="plot-layer-options"
        aria-label="Magnitude layer options"
        style={{
          position: 'absolute',
          top: 'calc(100% + 6px)',
          right: 0,
          zIndex: 20,
          minWidth: 240,
          padding: 12,
          display: 'grid',
          gap: 10,
          background: 'var(--panel, #1c211e)',
          border: '1px solid var(--border, #394039)',
          borderRadius: 8,
          boxShadow: '0 8px 28px #0008',
        }}
      >
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" disabled={disabled} onClick={() => onPatch({ preset: 'outputs' })}>
            All outputs
          </button>
          <button type="button" disabled={disabled} onClick={() => onPatch({ preset: 'hfd' })}>
            HFD view
          </button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <label>
            <input
              type="checkbox"
              checked={state.currentResult}
              disabled={disabled}
              onChange={(event) => onPatch({ currentResult: event.target.checked })}
            />
            Result
          </label>
          <label title="Filtered or electrical results of the other outputs">
            <input
              type="checkbox"
              checked={state.otherResults}
              disabled={disabled}
              onChange={(event) => onPatch({ otherResults: event.target.checked })}
            />
            Other outputs
          </label>
          <label>
            <input
              type="checkbox"
              checked={state.section}
              disabled={disabled}
              onChange={(event) => onPatch({ section: event.target.checked })}
            />
            Section
          </label>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Section scope
          <select
            value={state.sectionScope}
            disabled={disabled}
            onChange={(event) =>
              onPatch({ sectionScope: event.target.value as 'selected' | 'channel' })
            }
          >
            <option value="selected">Selected BQ</option>
            <option value="channel">Whole channel</option>
          </select>
        </label>
        <fieldset style={{ display: 'grid', gap: 6, border: 0, margin: 0, padding: 0 }}>
          <legend style={{ marginBottom: 6 }}>Raw measurements</legend>
          {channels.map((channel, index) => {
            const loaded = !!(
              channel.measurement?.impulse?.length || channel.measurement?.frequency?.length
            );
            return (
              <label
                key={channel.id}
                title={
                  loaded
                    ? 'Original measured response before channel processing'
                    : 'Load a measurement to show its raw response'
                }
              >
                <input
                  type="checkbox"
                  checked={state.rawMeasurements[index] ?? false}
                  disabled={disabled || !loaded}
                  onChange={(event) => {
                    const rawMeasurements = [...state.rawMeasurements];
                    rawMeasurements[index] = event.target.checked;
                    onPatch({ rawMeasurements });
                  }}
                />
                {channel.name} {index === channelIndex ? '(current)' : '(other)'}
              </label>
            );
          })}
        </fieldset>
        <small>Raw overlays are independent of measured processing and the sum.</small>
      </div>
    </details>
  );
}
