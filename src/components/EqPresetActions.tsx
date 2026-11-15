'use client';
import { Copy, Download, Upload, RotateCcw, ChevronDown } from 'lucide-react';
export default function EqPresetActions({
  preset,
  livePreset,
  busy,
  connected,
  pairConnected,
  role,
  designScope,
  clipboardLabel,
  onDefault,
  onCopyAll,
  onSaveAll,
  onSaveBoth,
  onBank,
}: {
  preset: number;
  livePreset?: number;
  busy: boolean;
  connected: boolean;
  pairConnected: boolean;
  role: string;
  designScope: string;
  clipboardLabel: string;
  onDefault: () => void;
  onCopyAll: () => void;
  onSaveAll: (both: boolean) => void;
  onSaveBoth: () => void;
  onBank: (
    action: 'copy-design' | 'copy-device' | 'apply-design' | 'write-device' | 'clear',
    both?: boolean,
  ) => void;
}) {
  return (
    <div className="eq-preset-actions" aria-label="Input EQ preset actions">
      <span
        className="eq-edit-scope"
        title="Editing a design preset does not select the amplifier’s active preset"
      >
        Editing P{preset}
        <small>{livePreset ? `Amp P${livePreset}` : 'Offline'}</small>
      </span>
      <button
        disabled={busy}
        onClick={onDefault}
        title="Default frequencies and zero gain; preserve Q and whole-EQ bypass"
      >
        <RotateCcw size={12} />
        Default EQ
      </button>
      <button
        disabled={busy}
        onClick={onCopyAll}
        title={`Copy these nine bands to all three ${designScope} design presets; retain each preset’s whole-EQ bypass`}
      >
        <Copy size={12} />
        Copy to all designs
      </button>
      <button
        disabled={busy || !connected}
        onClick={() => onSaveAll(false)}
        title={`Program these nine bands into all three ${role} amp presets; retain their live EQ bypass flags`}
      >
        <Upload size={12} />
        Save to all
      </button>
      <details className="eq-transfer-menu">
        <summary
          aria-label="EQ bank transfer options"
          title={clipboardLabel || 'Copy or write all three EQ sets'}
        >
          Bank transfer{clipboardLabel && <i />}
          <ChevronDown size={12} />
        </summary>
        <div className="eq-transfer-options">
          <strong>{clipboardLabel || 'No EQ bank copied'}</strong>
          <button disabled={busy} onClick={() => onBank('copy-design')}>
            <Copy size={12} />
            Copy three design EQ sets
          </button>
          <button disabled={busy || !connected} onClick={() => onBank('copy-device')}>
            <Download size={12} />
            Copy three EQ sets from amp
          </button>
          <button disabled={busy || !clipboardLabel} onClick={() => onBank('apply-design')}>
            Apply copied bank to {designScope} designs
          </button>
          <button
            disabled={busy || !clipboardLabel || !connected}
            onClick={() => onBank('write-device')}
          >
            Write copied bank to {role}
          </button>
          <button
            disabled={busy || !clipboardLabel || !pairConnected}
            onClick={() => onBank('write-device', true)}
          >
            Write copied bank to both amps
          </button>
          <hr />
          <button disabled={busy || !pairConnected} onClick={onSaveBoth}>
            Save this EQ preset to both amps
          </button>
          <button disabled={busy || !pairConnected} onClick={() => onSaveAll(true)}>
            Save current EQ to all presets on both
          </button>
          <button disabled={busy || !clipboardLabel} onClick={() => onBank('clear')}>
            Clear copied bank
          </button>
          <small>The copied bank stays in this tab until reload or close.</small>
        </div>
      </details>
    </div>
  );
}
