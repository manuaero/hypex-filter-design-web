'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Slot } from '../domain/model';
import type { FirmwareInspectionToken, FirmwareWorkspace } from '../application/firmware-workspace';
import { MAX_UI_TEXT_CHARACTERS, readFileText } from '../application/file-budget';
import type { UsbDescriptorVerifier, UsbDescriptorSnapshot } from '../hardware/usb-descriptor';
import type { FirmwareRuntimeController } from '../application/firmware-runtime';
import type { ToolExecutionContext } from '../application/execution-context';

const emptyDescriptors: UsbDescriptorSnapshot = Object.freeze({
  left: Object.freeze({ phase: 'empty' as const }),
  right: Object.freeze({ phase: 'empty' as const }),
});
const noSubscription = () => () => {};
const noDescriptors = () => emptyDescriptors;

type PickerTarget = {
  workspace: FirmwareWorkspace;
  slot: Slot;
  token: FirmwareInspectionToken;
  generation: number;
};
type LocalRead = { workspace: FirmwareWorkspace; reading: boolean; error?: string };

export interface FirmwarePanelProps {
  workspace: FirmwareWorkspace;
  slot: Slot;
  descriptorVerifier?: UsbDescriptorVerifier;
  runtime?: FirmwareRuntimeController;
  externalBusy?: boolean;
  getContext?: () => ToolExecutionContext;
  contextReady?: boolean;
}

/** Cached presentation only until the user explicitly requests a read. The
 * controller owns target/session/owner fences and does not enable controls. */
function RuntimeIdentity({
  runtime,
  slot,
  getContext,
  contextReady,
  externalBusy,
}: {
  runtime: FirmwareRuntimeController;
  slot: Slot;
  getContext?: () => ToolExecutionContext;
  contextReady: boolean;
  externalBusy: boolean;
}) {
  const snapshot = useSyncExternalStore(
      runtime.subscribe,
      runtime.getSnapshot,
      runtime.getSnapshot,
    ),
    state = snapshot.roles[slot],
    role = slot === 'left' ? 'Left' : 'Right',
    [authorizedOwner, setAuthorizedOwner] = useState<string>(),
    [accessError, setAccessError] = useState(''),
    [failure, setFailure] = useState(''),
    [pending, setPending] = useState(false),
    generation = useRef(0),
    mounted = useRef(false),
    flight = useRef(false),
    context = useRef(getContext);
  context.current = getContext;
  let caller: ToolExecutionContext | undefined,
    contextError = '';
  if (contextReady && getContext)
    try {
      caller = getContext();
    } catch (error) {
      contextError = error instanceof Error ? error.message : String(error);
    }
  const owner = caller?.owner,
    authorized = !!owner && owner === authorizedOwner && !accessError && !contextError;
  let availability: { available: boolean; reason?: string };
  try {
    availability = runtime.availability(slot);
  } catch (error) {
    availability = {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [runtime]);
  useLayoutEffect(() => {
    generation.current++;
    setFailure('');
  }, [runtime, slot, owner, contextReady]);
  useLayoutEffect(() => {
    if (!caller || contextError) {
      setAuthorizedOwner(undefined);
      setAccessError(contextError);
      return;
    }
    try {
      runtime.status(caller);
      setAuthorizedOwner(caller.owner);
      setAccessError('');
    } catch (error) {
      setAuthorizedOwner(undefined);
      setAccessError(error instanceof Error ? error.message : String(error));
    }
  }, [runtime, slot, owner, contextReady, contextError]);
  const read = async () => {
    if (
      flight.current ||
      pending ||
      snapshot.busy ||
      externalBusy ||
      !authorized ||
      !availability.available ||
      !context.current
    )
      return;
    const captured = generation.current,
      target = slot;
    flight.current = true;
    setPending(true);
    setFailure('');
    try {
      await runtime.read(target, context.current());
    } catch (error) {
      if (mounted.current && captured === generation.current)
        setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      flight.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const clear = () => {
    if (!authorized || externalBusy || !context.current) return;
    try {
      runtime.clear(slot, context.current());
      generation.current++;
      setFailure('');
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  };
  const source =
      state.source &&
      (
        {
          'connected-session': 'Connected session',
          'staged-device': 'Serial captured with staged file',
          'chosen-device': 'Already granted device',
          'remembered-device': 'Remembered granted target',
        } as const
      )[state.source],
    report = authorized ? state.report : undefined;
  return (
    <section className="firmware-runtime" aria-label={`${role} runtime identity`}>
      <div className="button-row">
        <strong>Reported runtime · {role}</strong>
        <button
          type="button"
          disabled={
            !authorized || !availability.available || snapshot.busy || pending || externalBusy
          }
          onClick={() => void read()}
        >
          Read runtime identity
        </button>
        <button
          type="button"
          disabled={
            !authorized ||
            externalBusy ||
            (!state.report && !state.error && state.phase === 'empty')
          }
          onClick={clear}
        >
          Clear runtime report
        </button>
      </div>
      {!authorized ? (
        <p className="hint" role={accessError || contextError ? 'alert' : undefined}>
          {accessError ||
            contextError ||
            'Workspace access is required for runtime identity actions.'}
        </p>
      ) : (
        <>
          {!availability.available && <p className="hint">{availability.reason}</p>}
          {state.phase === 'reading' && <p role="status">Reading {role} runtime identity…</p>}
          {(failure || state.error) && (
            <p role="alert" className="hint error">
              {failure || state.error}
            </p>
          )}
          {report ? (
            <>
              <p className="hint">
                <strong>{report.identity.serial}</strong> · firmware {report.identity.firmware} ·
                core {report.identity.core} · product {report.identity.product}
                {report.identity.name ? ` · ${report.identity.name}` : ''}
              </p>
              <p className="hint">
                Hardware: amplifier {report.hardware.amplifier}, module {report.hardware.moduleType}
                , {report.hardware.presets} presets / {report.hardware.channels} outputs · profile{' '}
                {report.profileId}
              </p>
              <p className="hint">
                Ordinary controls:{' '}
                {report.controlsQualified
                  ? 'existing core 5.1 profile; separate operation checks apply'
                  : 'unavailable for this reported profile'}
                . Diagnostic reads do not enable programming.
              </p>
              <p className="hint">
                {state.observedAt && <time dateTime={state.observedAt}>{state.observedAt}</time>}
                {source ? ` · ${source}` : ''} · double-read matched
              </p>
              {state.stale && (
                <p role="alert" className="hint">
                  This cached runtime report is stale; its target context changed or a fresh read
                  failed.
                </p>
              )}
              <p className="hint">
                Runtime reports do not establish the installed image hash or bundle family.
              </p>
            </>
          ) : (
            state.phase !== 'reading' && (
              <p className="hint">
                No runtime identity report for {role}. Reading is explicit and sends no setters.
              </p>
            )
          )}
        </>
      )}
    </section>
  );
}

/** Offline file inspection and explicitly requested read-only diagnostics. */
export default function FirmwarePanel({
  workspace,
  slot,
  descriptorVerifier,
  runtime,
  externalBusy = false,
  getContext,
  contextReady = true,
}: FirmwarePanelProps) {
  const snapshot = useSyncExternalStore(
      workspace.subscribe,
      workspace.getSnapshot,
      workspace.getSnapshot,
    ),
    state = snapshot[slot],
    stage = state.stage,
    descriptors = useSyncExternalStore(
      descriptorVerifier?.subscribe ?? noSubscription,
      descriptorVerifier?.getSnapshot ?? noDescriptors,
      descriptorVerifier?.getSnapshot ?? noDescriptors,
    ),
    descriptorState = descriptors[slot],
    descriptorAvailability = descriptorVerifier?.availability(slot),
    picker = useRef<HTMLInputElement>(null),
    pickerTarget = useRef<PickerTarget | undefined>(undefined),
    generations = useRef<Record<Slot, number>>({ left: 0, right: 0 }),
    mounted = useRef(true),
    currentWorkspace = useRef(workspace),
    [localReads, setLocalReads] = useState<Partial<Record<Slot, LocalRead>>>({}),
    [previewOpen, setPreviewOpen] = useState(false),
    [previewPass, setPreviewPass] = useState<0 | 1>(0),
    [previewOffset, setPreviewOffset] = useState(0);
  currentWorkspace.current = workspace;
  const local = localReads[slot]?.workspace === workspace ? localReads[slot] : undefined,
    failure = local?.error ?? state.error,
    busy = local?.reading || state.phase === 'inspecting',
    role = slot === 'left' ? 'Left' : 'Right';
  useEffect(() => {
    workspace.refreshTarget(slot);
  }, [workspace, slot, descriptorState.proof, descriptorState.phase]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generations.current.left++;
      generations.current.right++;
    };
  }, []);
  useEffect(() => {
    setPreviewOpen(false);
    setPreviewPass(0);
    setPreviewOffset(0);
  }, [workspace, slot, stage?.id]);
  const preview = useMemo(() => {
    if (!previewOpen || !stage) return undefined;
    try {
      return { page: workspace.packetPreview(slot, previewPass, previewOffset, 4) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [workspace, slot, stage?.id, previewOpen, previewPass, previewOffset]);
  const choose = () => {
    try {
      // Capture both role and ordinary identity BEFORE the browser chooser opens.
      const token = workspace.captureTarget(slot),
        generation = ++generations.current[slot];
      pickerTarget.current = { workspace, slot, token, generation };
      setLocalReads((previous) => ({ ...previous, [slot]: { workspace, reading: false } }));
      picker.current?.click();
    } catch (error) {
      setLocalReads((previous) => ({
        ...previous,
        [slot]: {
          workspace,
          reading: false,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };
  const read = async (file: File | undefined) => {
    const target = pickerTarget.current;
    pickerTarget.current = undefined;
    if (!file || !target) return;
    const current = () =>
      mounted.current &&
      currentWorkspace.current === target.workspace &&
      generations.current[target.slot] === target.generation;
    if (!current()) return;
    setLocalReads((previous) => ({
      ...previous,
      [target.slot]: { workspace: target.workspace, reading: true },
    }));
    let inspectionStarted = false;
    try {
      // Firmware syntax/hash must see original BOM and reject malformed UTF-8.
      const text = await readFileText(file, MAX_UI_TEXT_CHARACTERS, {
        preserveBom: true,
        fatal: true,
      });
      if (!current()) return;
      inspectionStarted = true;
      await target.workspace.inspect(target.slot, text, file.name, target.token);
    } catch (error) {
      if (!current()) return;
      // The shared workspace already publishes parser/hash errors. File read
      // errors happen before inspect and need their own visible message.
      if (!inspectionStarted || target.workspace.getSnapshot()[target.slot].phase !== 'error')
        setLocalReads((previous) => ({
          ...previous,
          [target.slot]: {
            workspace: target.workspace,
            reading: false,
            error: `Could not inspect ${JSON.stringify(file.name)}: ${error instanceof Error ? error.message : String(error)}.`,
          },
        }));
    } finally {
      if (current())
        setLocalReads((previous) => ({
          ...previous,
          [target.slot]: { ...previous[target.slot], workspace: target.workspace, reading: false },
        }));
    }
  };
  const clear = () => {
    generations.current[slot]++;
    if (pickerTarget.current?.workspace === workspace && pickerTarget.current.slot === slot)
      pickerTarget.current = undefined;
    workspace.clear(slot);
    setLocalReads((previous) => ({ ...previous, [slot]: { workspace, reading: false } }));
    setPreviewOpen(false);
    if (picker.current) picker.current.value = '';
  };
  const verifyDescriptor = async (recheck = false) => {
    if (!descriptorVerifier) return;
    const selectedWorkspace = workspace,
      selectedSlot = slot,
      verifier = descriptorVerifier;
    try {
      if (recheck) await verifier.revalidate(selectedSlot);
      else await verifier.request(selectedSlot);
    } catch {
      /* The verifier publishes the role-bound error. */
    } finally {
      selectedWorkspace.refreshTarget(selectedSlot);
    }
  };

  return (
    <section className="feature-card firmware-panel" aria-label={`${role} firmware inspection`}>
      <h2>Firmware · {role}</h2>
      <p className="hint">
        Inspect a native HEX bundle offline. Staging is temporary and sends no amplifier commands.
      </p>
      <div className="button-row">
        <button type="button" onClick={choose}>
          Choose firmware (.hex)
        </button>
        <button type="button" onClick={clear}>
          Clear staged firmware
        </button>
        <button
          type="button"
          disabled
          title="Firmware programming has no verified bootloader adapter."
        >
          Program firmware · unavailable
        </button>
      </div>
      <input
        ref={picker}
        type="file"
        accept=".hex"
        hidden
        aria-label="Choose firmware HEX file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          void read(file);
        }}
      />
      {runtime && (
        <RuntimeIdentity
          runtime={runtime}
          slot={slot}
          getContext={getContext}
          contextReady={contextReady}
          externalBusy={externalBusy}
        />
      )}
      {descriptorVerifier && (
        <div className="firmware-descriptor">
          <div className="button-row">
            <button
              type="button"
              disabled={!descriptorAvailability?.available}
              title={descriptorAvailability?.reason}
              onClick={() => void verifyDescriptor()}
            >
              Verify USB identity
            </button>
            <button
              type="button"
              disabled={!descriptorState.proof}
              onClick={() => void verifyDescriptor(true)}
            >
              Recheck granted identity
            </button>
            <button
              type="button"
              onClick={() => {
                descriptorVerifier.clear(slot);
                workspace.refreshTarget(slot);
              }}
            >
              Clear USB proof
            </button>
          </div>
          {!descriptorAvailability?.available && (
            <p className="hint">{descriptorAvailability?.reason}</p>
          )}
          {(descriptorState.phase === 'requesting' || descriptorState.phase === 'checking') && (
            <p role="status">
              {descriptorState.phase === 'requesting' ? 'Choose' : 'Checking'} the {role} USB
              descriptor…
            </p>
          )}
          {descriptorState.error && (
            <p role="alert" className="hint">
              {descriptorState.error}
            </p>
          )}
          {descriptorState.proof && (
            <p className="hint">
              Current USB identity: <strong>{descriptorState.proof.hidSerial}</strong> ·{' '}
              {descriptorState.proof.family}. Programming remains unavailable.
            </p>
          )}
        </div>
      )}
      {busy && <p role="status">Reading and inspecting {state.pendingName ?? 'firmware'}…</p>}
      {failure && (
        <p role="alert" className="hint error">
          {failure}
        </p>
      )}
      {stage ? (
        <>
          <dl className="firmware-facts">
            <dt>File</dt>
            <dd>{stage.name}</dd>
            <dt>Bundle family</dt>
            <dd>{stage.family} · file identity only</dd>
            <dt>Known file content</dt>
            <dd>
              {stage.contentProfile
                ? `Exact known-content match · firmware ${stage.contentProfile.bundleVersion} · core ${stage.contentProfile.coreVersion} · ${stage.contentProfile.id}`
                : 'Unknown content hash · no known runtime version inferred'}
              <p className="hint">
                This classifies the staged file; it does not prove the installed image hash.
              </p>
            </dd>
            <dt>SHA-256</dt>
            <dd className="firmware-hash">{stage.sha256}</dd>
            <dt>Data</dt>
            <dd>
              {stage.dataBytes.toLocaleString()} bytes · {stage.recordCount.toLocaleString()}{' '}
              records · {stage.segmentCount} segments
            </dd>
            <dt>Transfer plan</dt>
            <dd>
              2 passes · {stage.plan.packetsPerPass.toLocaleString()} packets/pass ·{' '}
              {(stage.plan.packetsPerPass * 2).toLocaleString()} total
            </dd>
            <dt>Captured EEPROM identity</dt>
            <dd>
              {stage.boundDevice
                ? `${stage.boundDevice.serial} · core ${stage.boundDevice.core} · firmware ${stage.boundDevice.firmware}`
                : 'Offline · no amplifier identity bound'}
            </dd>
            <dt>Target descriptor</dt>
            <dd>
              {stage.target
                ? `${stage.target.hidSerial} · ${stage.target.family} · ${stage.target.compatibleWithBundle ? 'matches bundle family' : 'bundle family mismatch'}`
                : 'No matching USB descriptor proof attached'}
            </dd>
          </dl>
          {stage.target && !stage.target.compatibleWithBundle && (
            <p role="alert" className="hint">
              The bundle family does not match the observed USB identity.
            </p>
          )}
          {descriptorState.proof && !stage.target && (
            <p className="hint">Reinspect this file to bind it to the verified amplifier.</p>
          )}
          {stage.bindingChangedDuringInspection && (
            <p role="alert" className="hint">
              Device assignment changed during inspection. The original captured identity was
              retained; inspect again for the current assignment.
            </p>
          )}
          <div className="firmware-programming-reasons">
            <p className="hint">
              Target compatibility, programming and recovery are not yet verified.
            </p>
            <details>
              <summary>Why programming is unavailable</summary>
              <ul>
                {stage.programming.reasons.map((reason) => (
                  <li key={reason.code}>{reason.message}</li>
                ))}
              </ul>
            </details>
          </div>
          <button
            type="button"
            aria-expanded={previewOpen}
            onClick={() => setPreviewOpen((open) => !open)}
          >
            Transfer preview
          </button>
          {previewOpen && (
            <div className="firmware-preview">
              <label>
                Pass{' '}
                <select
                  aria-label="Firmware preview pass"
                  value={previewPass}
                  onChange={(event) => {
                    setPreviewPass(Number(event.target.value) as 0 | 1);
                    setPreviewOffset(0);
                  }}
                >
                  <option value={0}>0 · first</option>
                  <option value={1}>1 · second</option>
                </select>
              </label>
              {preview?.error ? (
                <p role="alert">{preview.error}</p>
              ) : (
                preview?.page && (
                  <>
                    <p className="hint">
                      Packets {preview.page.offset + 1}–
                      {preview.page.offset + preview.page.packets.length} of{' '}
                      {preview.page.total.toLocaleString()}. Preview only.
                    </p>
                    <div className="button-row">
                      <button
                        type="button"
                        aria-label="Previous firmware packets"
                        disabled={previewOffset === 0}
                        onClick={() => setPreviewOffset((offset) => Math.max(0, offset - 4))}
                      >
                        Previous
                      </button>
                      <button
                        type="button"
                        aria-label="Next firmware packets"
                        disabled={preview.page.nextOffset === null}
                        onClick={() => {
                          if (
                            preview.page?.nextOffset !== null &&
                            preview.page?.nextOffset !== undefined
                          )
                            setPreviewOffset(preview.page.nextOffset);
                        }}
                      >
                        Next
                      </button>
                    </div>
                    <table>
                      <thead>
                        <tr>
                          <th>Packet</th>
                          <th>Original records</th>
                          <th>Completed records</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.page.packets.map((packet) => (
                          <tr key={packet.index}>
                            <td>{packet.index + 1}</td>
                            <td>
                              {packet.firstRecord + 1}–{packet.firstRecord + packet.recordCount}
                            </td>
                            <td>
                              {packet.completedRecords}/{stage.plan.totalRecords}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )
              )}
            </div>
          )}
        </>
      ) : (
        !busy && !failure && <p className="hint">No firmware staged for {role}.</p>
      )}
    </section>
  );
}
