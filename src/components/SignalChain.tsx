'use client';
import { Copy, FileAudio, Link2, ArrowRightLeft, AudioLines } from 'lucide-react';
import { type Preset } from '../domain/model';
import { FilterGlyph, FILTER_LABELS } from './FilterPalette';
import { COLORS } from './ResponsePlot';
const frequency = (f: number) => (f >= 1000 ? `${+(f / 1000).toFixed(1)}k` : `${+f.toFixed(0)}`);
export default function SignalChain({
  preset,
  channel,
  filter,
  selected,
  copySource,
  onSelect,
  onOpenGraph,
  onMarkCopy,
  onCopyTo,
  onExchange,
  onMeasurement,
  onOutputName,
  onNavigate,
}: {
  preset: Preset;
  channel: number;
  filter: number;
  selected: number[];
  copySource: number | null;
  onSelect: (channel: number, filter: number, multiple: boolean) => void;
  onOpenGraph: (channel: number) => void;
  onMarkCopy: (channel: number) => void;
  onCopyTo: (channel: number) => void;
  onExchange: () => void;
  onMeasurement: (channel: number) => void;
  onOutputName: (channel: number, name: string) => void;
  onNavigate: (tab: 'Input EQ' | 'FIR') => void;
}) {
  return (
    <section className="signal-chain" aria-label="Advanced signal chain">
      <div className="chain-input">
        <span>
          <AudioLines size={13} />
          Input
        </span>
        <i />
        <button onClick={() => onNavigate('Input EQ')} title="Open the input equalizer">
          EQ <small>{preset.eqEnabled ? 'On' : 'Bypass'}</small>
        </button>
        <i />
        <button onClick={() => onNavigate('FIR')} title="Open shared input FIR">
          FIR{' '}
          <small>
            {preset.firPlacement !== 'output' && preset.inputFir.enabled
              ? `${preset.inputFir.taps.length} taps`
              : 'Bypass'}
          </small>
        </button>
        <span className="chain-rate">93.750 kHz</span>
      </div>
      <div className="chain-channels">
        {preset.channels.map((c, ch) => (
          <section
            key={c.id}
            className={`chain-channel ${ch === channel ? 'current' : ''} ${c.linkedTo !== undefined ? 'linked' : ''}`}
            style={{ '--channel-color': COLORS[ch] } as React.CSSProperties}
          >
            <header>
              <button
                className="chain-channel-name"
                aria-label={`Open ${c.name} response graph`}
                onClick={() => onSelect(ch, 0, false)}
                onDoubleClick={() => onOpenGraph(ch)}
                title="Select channel · double-click to open its response"
              >
                <span>{ch + 1}</span>
                <strong>{c.name}</strong>
              </button>
              <button
                aria-label={`Mark ${c.name} as copy source`}
                aria-pressed={copySource === ch}
                title="Mark channel to copy"
                onClick={() => onMarkCopy(ch)}
              >
                <Copy size={12} />
              </button>
            </header>
            <div className="chain-link-status">
              {c.linkedTo !== undefined ? (
                <>
                  <Link2 size={10} /> Follows {preset.channels[c.linkedTo].name}
                </>
              ) : preset.channels.some((p) => p.linkedTo === ch) ? (
                <>
                  <Link2 size={10} /> Master channel
                </>
              ) : (
                'Independent channel'
              )}
            </div>
            <div className="chain-biquads" aria-label={`${c.name} biquad cascade`}>
              {c.filters.map((f, i) => (
                <button
                  key={f.id}
                  aria-label={`Select ${c.name} biquad ${i + 1}`}
                  aria-pressed={ch === channel && (selected.includes(i) || filter === i)}
                  aria-controls="selected-filter-inspector"
                  className={`chain-biquad ${f.kind === 'unity' ? 'empty' : ''} ${!f.enabled ? 'bypassed' : ''} ${ch === channel && filter === i ? 'inspecting' : ''} ${ch === channel && selected.includes(i) ? 'multi-selected' : ''}`}
                  title={`BQ ${i + 1} · ${FILTER_LABELS[f.kind]}${f.kind === 'unity' ? '' : ` · ${f.frequency} Hz · Q ${f.q.toFixed(3)}`} · Ctrl/⌘ click to select multiple`}
                  onClick={(e) => onSelect(ch, i, e.ctrlKey || e.metaKey)}
                  onDoubleClick={() => onOpenGraph(ch)}
                >
                  <span>{String(i + 1).padStart(2, '0')}</span>
                  <FilterGlyph kind={f.kind} />
                  <small>
                    {f.kind === 'unity'
                      ? '—'
                      : f.kind === 'raw'
                        ? 'RAW'
                        : `${frequency(f.frequency)} Hz`}
                  </small>
                </button>
              ))}
            </div>
            <div className="chain-processing">
              <span title="Global delay is for response analysis">
                Global <strong>{+(c.globalDelayUs / 1000).toFixed(3)} ms</strong>
              </span>
              <span>
                Delay <strong>{+(c.delayUs / 1000).toFixed(3)} ms</strong>
              </span>
              <span>
                Gain{' '}
                <strong>
                  {c.invert ? 'Ø ' : ''}
                  {c.gain > 0 ? '+' : ''}
                  {c.gain.toFixed(1)} dB
                </strong>
              </span>
              <button onClick={() => onNavigate('FIR')} title="Open this output’s FIR">
                FIR{' '}
                <strong>
                  {preset.firPlacement === 'output' && c.fir.enabled
                    ? `${c.fir.taps.length}`
                    : 'Bypass'}
                </strong>
              </button>
            </div>
            <input
              className="chain-output-name"
              aria-label={`Output name for ${c.name}`}
              title="Project output label"
              value={c.outputName}
              onChange={(e) => onOutputName(ch, e.target.value)}
            />
            <footer>
              <button
                aria-label={`Load impulse for ${c.name}`}
                title={c.measurement?.name || 'Load channel impulse response'}
                onClick={() => onMeasurement(ch)}
              >
                <FileAudio size={11} />
                {c.measurement ? 'Impulse loaded' : 'Load impulse'}
              </button>
              {copySource !== null && copySource !== ch && (
                <button
                  disabled={c.linkedTo !== undefined}
                  title={`Copy processing from ${preset.channels[copySource].name}; retain this driver’s measurement and labels`}
                  onClick={() => onCopyTo(ch)}
                >
                  Paste
                </button>
              )}
            </footer>
          </section>
        ))}
      </div>
      <div className="chain-actions">
        <span>
          {copySource !== null
            ? `Copy source: ${preset.channels[copySource].name}`
            : 'Ctrl/⌘ click two biquads in one channel to exchange.'}
        </span>
        <button
          disabled={selected.length !== 2 || preset.channels[channel].linkedTo !== undefined}
          onClick={onExchange}
        >
          <ArrowRightLeft size={12} />
          Exchange {selected.length === 2 ? selected.map((i) => i + 1).join(' ↔ ') : 'selected'}
        </button>
      </div>
    </section>
  );
}
