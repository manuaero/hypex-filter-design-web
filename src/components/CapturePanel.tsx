'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Mic, Settings2, Square, Play, RefreshCw, X } from 'lucide-react';
import Numeric from './Numeric';
import { captureConfigSchema } from '../application/measurement-capture';
import type {
  CaptureConfig,
  CaptureController,
  CaptureDevice,
  CaptureTarget,
} from '../application/measurement-capture';
import type { ToolExecutionContext } from '../application/execution-context';

const running = new Set(['enabling', 'preparing', 'clearing', 'recording', 'processing', 'saving']);
const describeTarget = (target: CaptureTarget) =>
  `${target.slot === 'left' ? 'Left' : 'Right'} · P${target.preset + 1} · Output ${target.channel + 1}`;

export default function CapturePanel({
  controller,
  context,
  target,
  revision,
  targetName,
  onComplete,
}: {
  controller: CaptureController;
  context: ToolExecutionContext;
  target: CaptureTarget;
  revision: () => number;
  targetName: string;
  onComplete: () => void;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState<CaptureConfig>(snapshot.config),
    [devices, setDevices] = useState<CaptureDevice[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null),
    completed = useRef<string | undefined>(undefined);
  const active = running.has(snapshot.phase);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  useEffect(() => {
    if (
      snapshot.phase === 'complete' &&
      snapshot.requestId &&
      completed.current !== snapshot.requestId
    ) {
      completed.current = snapshot.requestId;
      onComplete();
    }
  }, [snapshot.phase, snapshot.requestId, onComplete]);
  const attempt = async (action: () => unknown | Promise<unknown>) => {
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const refresh = async () => {
    setLoading(true);
    try {
      setDevices(await controller.devices(context));
    } finally {
      setLoading(false);
    }
  };
  const setup = () => {
    setDraft({ ...snapshot.config });
    setOpen(true);
    void attempt(refresh);
  };
  const update = <K extends keyof CaptureConfig>(key: K, value: CaptureConfig[K]) =>
    setDraft((old) => ({ ...old, [key]: value }));
  const options = (kind: CaptureDevice['kind'], selected: string) => {
    const found = devices.filter((device) => device.kind === kind && device.deviceId);
    return (
      <>
        <option value="">System default</option>
        {selected && !found.some((device) => device.deviceId === selected) && (
          <option value={selected}>Previously selected device · refresh to check</option>
        )}
        {found.map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label ||
              `${kind === 'audioinput' ? 'Input' : 'Output'} device ${index + 1} · permission needed for name`}
          </option>
        ))}
      </>
    );
  };
  const runtime = snapshot.runtime;
  const viewTarget = active || snapshot.hasResult ? (snapshot.target ?? target) : target;
  return (
    <>
      <section className="capture-panel" aria-label="Live measurement capture">
        <div className="capture-controls">
          <button
            className={snapshot.enabled ? 'active' : ''}
            disabled={active}
            aria-pressed={snapshot.enabled}
            onClick={() =>
              void attempt(() =>
                snapshot.enabled ? controller.disable(context) : controller.enable(context),
              )
            }
          >
            <Mic size={13} />
            {snapshot.enabled ? 'Recording enabled' : 'Enable recording'}
          </button>
          <button disabled={active} onClick={setup} title="Select the measurement input and output">
            <Settings2 size={13} />
            Audio setup
          </button>
          <Numeric
            label="Sweep gain"
            value={snapshot.config.outputGainDb}
            unit="dB"
            step={0.5}
            commitOnly
            disabled={active}
            onChange={(outputGainDb) =>
              void attempt(() =>
                controller.configure(context, { ...snapshot.config, outputGainDb }),
              )
            }
          />
          <button
            className="primary"
            disabled={!snapshot.enabled || active || snapshot.hasResult}
            title={`Play the sweep and replace ${describeTarget(target)} · ${targetName}`}
            onClick={() =>
              void attempt(() =>
                controller.start(context, {
                  requestId: crypto.randomUUID(),
                  target: { ...target },
                  expectedRevision: revision(),
                  name: `${targetName} measurement`,
                }),
              )
            }
          >
            <Play size={13} />
            Take measurement
          </button>
          {active && (
            <button
              className="capture-stop"
              onClick={() => void attempt(() => controller.cancel(context, snapshot.requestId))}
            >
              <Square size={12} />
              Cancel
            </button>
          )}
        </div>
        <div className="capture-status" role="status">
          <span title={describeTarget(viewTarget)}>
            {describeTarget(viewTarget)}
            {runtime ? ` · ${runtime.sampleRate.toLocaleString()} Hz` : ''}
            {` · In ${snapshot.config.inputChannel + 1} → Out ${snapshot.config.outputChannel + 1}`}
          </span>
          {active && (
            <progress
              aria-label="Measurement recording progress"
              max={snapshot.totalFrames}
              value={snapshot.recordedFrames}
            />
          )}
          <strong>{snapshot.phase === 'disabled' ? 'No audio opened' : snapshot.phase}</strong>
        </div>
        {snapshot.hasResult && (
          <div className="capture-pending">
            <span>Captured result retained for {describeTarget(snapshot.target!)}.</span>
            <button
              disabled={active}
              onClick={() =>
                void attempt(() => controller.apply(context, snapshot.requestId!, revision()))
              }
            >
              Apply to this target
            </button>
            <button
              disabled={active}
              onClick={() => void attempt(() => controller.discard(context, snapshot.requestId!))}
            >
              Discard
            </button>
          </div>
        )}
        {(error || snapshot.error) && (
          <p className="capture-error" role="alert">
            {error || snapshot.error}
          </p>
        )}
        {snapshot.config.outputGainDb > 0 && (
          <p className="capture-warning">
            Positive sweep gain can exceed full scale at the selected output.
          </p>
        )}
        {!!runtime?.clippedInputSamples && (
          <p className="capture-warning">
            The last input had {runtime.clippedInputSamples.toLocaleString()} samples at or above
            full scale. Check input gain.
          </p>
        )}
      </section>
      <dialog
        ref={dialog}
        className="capture-dialog"
        aria-labelledby="capture-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
      >
        <div className="panel-heading">
          <h2 id="capture-dialog-title">Measurement audio</h2>
          <button aria-label="Close audio setup" onClick={() => setOpen(false)}>
            <X size={15} />
          </button>
        </div>
        <p>
          Choose your audio interface and channels. Amplifier USB is used for control; measurement
          audio uses the output selected here.
        </p>
        <div className="capture-device-grid">
          <label>
            Input device
            <select
              aria-label="Measurement input device"
              value={draft.inputDeviceId}
              onChange={(e) => update('inputDeviceId', e.target.value)}
            >
              {options('audioinput', draft.inputDeviceId)}
            </select>
          </label>
          <label>
            Output device
            <select
              aria-label="Measurement output device"
              value={draft.outputDeviceId}
              onChange={(e) => update('outputDeviceId', e.target.value)}
            >
              {options('audiooutput', draft.outputDeviceId)}
            </select>
          </label>
          <Numeric
            label="Input channel"
            value={draft.inputChannel + 1}
            min={1}
            max={32}
            step={1}
            commitOnly
            onChange={(value) => update('inputChannel', Math.trunc(value) - 1)}
          />
          <Numeric
            label="Output channel"
            value={draft.outputChannel + 1}
            min={1}
            max={32}
            step={1}
            commitOnly
            onChange={(value) => update('outputChannel', Math.trunc(value) - 1)}
          />
          <label>
            Requested sample rate
            <input
              type="number"
              aria-label="Requested sample rate"
              min={8000}
              max={384000}
              step={1}
              placeholder="Device default"
              value={draft.requestedSampleRate ?? ''}
              onChange={(e) =>
                update(
                  'requestedSampleRate',
                  e.target.value === '' ? undefined : e.target.valueAsNumber,
                )
              }
            />
          </label>
          <Numeric
            label="Playback gain"
            value={draft.outputGainDb}
            unit="dB"
            step={0.5}
            commitOnly
            onChange={(value) => update('outputGainDb', value)}
          />
        </div>
        <div className="capture-device-actions">
          <button disabled={loading} onClick={() => void attempt(refresh)}>
            <RefreshCw size={12} />
            Refresh devices
          </button>
          <button
            onClick={() =>
              void attempt(async () => {
                const id = await controller.chooseOutput(context);
                update('outputDeviceId', id);
                await refresh();
              })
            }
          >
            Choose output…
          </button>
        </div>
        {runtime && (
          <dl className="capture-runtime">
            <div>
              <dt>Actual rate</dt>
              <dd>{runtime.sampleRate.toLocaleString()} Hz</dd>
            </div>
            <div>
              <dt>Available channels</dt>
              <dd>
                {runtime.inputChannels} input · {runtime.outputChannels} output
              </dd>
            </div>
            <div>
              <dt>Reported latency</dt>
              <dd>
                {runtime.baseLatency === undefined
                  ? 'Base unknown'
                  : `Base ${(runtime.baseLatency * 1000).toFixed(2)} ms`}
                {' · '}
                {runtime.outputLatency === undefined
                  ? 'output unknown'
                  : `output ${(runtime.outputLatency * 1000).toFixed(2)} ms`}
              </dd>
            </div>
          </dl>
        )}
        {runtime?.inputSampleRate && runtime.inputSampleRate !== runtime.sampleRate && (
          <p className="capture-warning">
            Input reports {runtime.inputSampleRate.toLocaleString()} Hz; the browser audio graph
            runs at {runtime.sampleRate.toLocaleString()} Hz and resamples it.
          </p>
        )}
        {runtime &&
          [runtime.echoCancellation, runtime.noiseSuppression, runtime.autoGainControl].some(
            (value) => value === undefined,
          ) && (
            <p className="capture-warning">
              This browser did not report every voice-processing setting. An unprocessed input is
              not fully verified.
            </p>
          )}
        <p className="capture-note">
          Enable recording opens the input silently. Take plays a sweep and replaces the selected
          measurement. Cancel stops output; Undo can restore cleared data. Browser capture retains
          interface/acoustic delay and does not automatically align peaks.
        </p>
        {(error || snapshot.error) && (
          <p className="capture-error" role="alert">
            {error || snapshot.error}
          </p>
        )}
        <div className="dialog-actions">
          <button onClick={() => setOpen(false)}>Cancel</button>
          <button
            className="primary"
            onClick={() =>
              void attempt(async () => {
                // Settings are staged until Apply; Cancel leaves the active route alone.
                const validated = captureConfigSchema.parse(draft);
                if (snapshot.enabled) await controller.disable(context);
                controller.configure(context, validated);
                setOpen(false);
              })
            }
          >
            Apply settings
          </button>
        </div>
      </dialog>
    </>
  );
}
