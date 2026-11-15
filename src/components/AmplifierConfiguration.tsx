'use client';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Slot } from '../domain/model';
import type { ToolExecutionContext } from '../application/execution-context';
import {
  type AmplifierModesController,
  type AmplifierModesResult,
  type AmplifierModesTarget,
} from '../application/amplifier-modes';
import type {
  AmplifierModes,
  AmplifierModesSummary,
  AmplifierModesIdentity,
} from '../hardware/amplifier-modes';
export type { AmplifierModes } from '../hardware/amplifier-modes';

export interface AmplifierConfigurationProps {
  controller: AmplifierModesController;
  slot: Slot;
  connectedRoles: readonly Slot[];
  getContext(): ToolExecutionContext;
  contextReady?: boolean;
  externalBusy?: boolean;
}
const modes = [
  ['master', 'Master unit'],
  ['bridge', 'Bridged CH1 + CH2'],
  ['softClip', 'Soft clip enabled'],
] as const;
const label = (target: AmplifierModesTarget) =>
  target === 'both' ? 'Left + Right' : target === 'left' ? 'Left' : 'Right';
const slots = (target: AmplifierModesTarget): Slot[] =>
  target === 'both' ? ['left', 'right'] : [target];
const on = (value: boolean) => (value ? 'On' : 'Off');
const sameIdentity = (a: AmplifierModesIdentity | undefined, b: AmplifierModesIdentity) =>
  !!a &&
  a.serial === b.serial &&
  a.product === b.product &&
  a.core === b.core &&
  a.firmware === b.firmware;
const problem = (error: unknown) =>
  error instanceof Error ? error.message : 'Configuration was not confirmed';
const fields = (value: AmplifierModesSummary) => [
  ['Master unit', on(value.master)],
  ['Bridged CH1 + CH2', on(value.bridge)],
  ['Soft clip', on(value.softClip)],
  ['Wake on mains', on(value.wakeOnLine)],
  ['Signal detection', on(value.signalDetection)],
  ['Fixed startup volume', value.startupVolume === -200 ? 'Disabled' : `${value.startupVolume} dB`],
  [
    'Shutdown mode',
    value.standbyMode === 0
      ? 'Standby'
      : value.standbyMode === 1
        ? 'Low power'
        : String(value.standbyMode),
  ],
  ['Preset source locks · 1 / 2 / 3', value.sourceLocks.map(on).join(' / ')],
  ['Preset volume locks · 1 / 2 / 3', value.volumeLocks.map(on).join(' / ')],
];
const modeText = (value: AmplifierModes) =>
  `${value.master ? 'Master' : 'Slave'} · Bridge ${on(value.bridge)} · Soft clip ${on(value.softClip)}`;

/** Shared mode drafts; no device reads or setters are initiated on mount. */
export default function AmplifierConfiguration({
  controller,
  slot,
  connectedRoles,
  getContext,
  contextReady = true,
  externalBusy = false,
}: AmplifierConfigurationProps) {
  const snapshot = useSyncExternalStore(
      controller.subscribe,
      controller.getSnapshot,
      controller.getSnapshot,
    ),
    [target, setTarget] = useState<AmplifierModesTarget>(slot),
    [authorizedOwner, setAuthorizedOwner] = useState<string>(),
    [failure, setFailure] = useState(''),
    [accessError, setAccessError] = useState(''),
    [localBusy, setLocalBusy] = useState(false),
    [outcome, setOutcome] = useState<AmplifierModesResult>();
  let caller: ToolExecutionContext | undefined,
    contextError = '';
  if (contextReady)
    try {
      caller = getContext();
    } catch (error) {
      contextError = problem(error);
    }
  const owner = caller?.owner,
    review = snapshot.activeReview,
    selected = review?.target ?? target,
    selectedSlots = slots(selected),
    connectionKey = JSON.stringify(
      (['left', 'right'] as const).map((role) => [
        role,
        connectedRoles.includes(role),
        snapshot.roles[role].connected,
        snapshot.roles[role].identity,
      ]),
    ),
    viewKey = JSON.stringify([slot, owner, connectionKey]),
    busy = localBusy || snapshot.busy || externalBusy,
    authorized = !!owner && owner === authorizedOwner && !accessError && !contextError,
    available = selectedSlots.every(
      (role) => connectedRoles.includes(role) && snapshot.roles[role].connected,
    ),
    reviewCurrent =
      !review ||
      review.roles.every(
        (row) =>
          connectedRoles.includes(row.slot) &&
          snapshot.roles[row.slot].connected &&
          sameIdentity(snapshot.roles[row.slot].identity, row.identity),
      ),
    changed = selectedSlots.some((role) => snapshot.roles[role].changed),
    valid = selectedSlots.every((role) => {
      const state = snapshot.roles[role];
      return (
        !!state.current &&
        !!state.draft &&
        !!state.preview &&
        !state.error &&
        modes.every(([key]) => state.current![key] === state.draft![key] || state.allowed?.[key])
      );
    });
  const mounted = useRef(false),
    flight = useRef(false),
    generation = useRef(0),
    context = useRef(getContext),
    observedResult = useRef(snapshot.lastResult),
    ignoreFlight = useRef(false),
    latestView = useRef(viewKey);
  context.current = getContext;
  latestView.current = viewKey;
  useLayoutEffect(() => {
    mounted.current = true;
    controller.refreshBindings();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [controller]);
  useLayoutEffect(() => {
    generation.current++;
    observedResult.current = snapshot.lastResult;
    ignoreFlight.current = snapshot.busy;
    setOutcome(undefined);
    setFailure('');
  }, [controller, viewKey]);
  useLayoutEffect(() => {
    if (!caller || contextError) {
      setAuthorizedOwner(undefined);
      setAccessError(contextError);
      return;
    }
    try {
      controller.status(caller);
      setAuthorizedOwner(caller.owner);
      setAccessError('');
    } catch (error) {
      setAuthorizedOwner(undefined);
      setAccessError(problem(error));
    }
  }, [controller, owner, contextReady, contextError]);
  useEffect(() => {
    setTarget(slot);
  }, [slot]);
  useEffect(() => {
    if (review) {
      setTarget(review.target);
      setFailure('');
      setOutcome(undefined);
    }
  }, [review?.id]);
  useEffect(() => {
    const result = snapshot.lastResult;
    if (result !== observedResult.current) {
      observedResult.current = result;
      if (!result) setOutcome(undefined);
      if (
        result &&
        authorized &&
        !ignoreFlight.current &&
        result.roles.every(
          (row) =>
            snapshot.roles[row.slot].connected &&
            connectedRoles.includes(row.slot) &&
            sameIdentity(snapshot.roles[row.slot].identity, row.identity),
        )
      )
        setOutcome(result);
    }
    if (!snapshot.busy) ignoreFlight.current = false;
  }, [snapshot.lastResult, snapshot.busy, authorized, connectionKey]);
  const invoke = (work: (actor: ToolExecutionContext) => void) => {
    if (busy || !authorized) return;
    try {
      work(context.current());
      setFailure('');
    } catch (error) {
      setFailure(problem(error));
    }
  };
  const apply = async () => {
    if (
      flight.current ||
      busy ||
      !authorized ||
      !available ||
      !reviewCurrent ||
      !valid ||
      (!changed && !review)
    )
      return;
    flight.current = true;
    setLocalBusy(true);
    setFailure('');
    setOutcome(undefined);
    const capturedGeneration = generation.current,
      capturedView = latestView.current;
    try {
      const actor = context.current(),
        captured =
          controller.getSnapshot().activeReview ??
          (await controller.review(selected, actor, {
            expectedRevision: controller.getSnapshot().revision,
          }));
      if (
        !mounted.current ||
        capturedGeneration !== generation.current ||
        capturedView !== latestView.current
      )
        return;
      const currentActor = context.current();
      if (currentActor.owner !== actor.owner)
        throw new Error('Workspace changed; configuration was not applied');
      await controller.apply(captured.id, currentActor, { confirm: true });
    } catch (error) {
      if (
        mounted.current &&
        capturedGeneration === generation.current &&
        capturedView === latestView.current
      )
        setFailure(problem(error));
    } finally {
      flight.current = false;
      if (mounted.current) setLocalBusy(false);
    }
  };
  return (
    <section className="feature-card amplifier-configuration" aria-label="Amplifier configuration">
      <div className="button-row">
        <h2>Amplifier configuration</h2>
        <label>
          Apply to{' '}
          <select
            aria-label="Configuration target"
            value={selected}
            disabled={busy || !!review || !authorized}
            onChange={(event) => {
              setTarget(event.target.value as AmplifierModesTarget);
              setFailure('');
              setOutcome(undefined);
            }}
          >
            <option value="left">Left</option>
            <option value="right">Right</option>
            <option value="both">Left + Right</option>
          </select>
        </label>
      </div>
      {!authorized ? (
        <p role={accessError || contextError ? 'alert' : undefined} className="hint">
          {accessError || contextError || 'Workspace access is loading.'}
        </p>
      ) : (
        <>
          <div className="amplifier-mode-roles">
            {selectedSlots.map((role) => {
              const state = snapshot.roles[role],
                captured = review?.roles.find((row) => row.slot === role),
                before = captured?.before ?? state.current,
                after = captured?.after ?? state.preview ?? state.current;
              return (
                <section
                  key={role}
                  className="amplifier-mode-role"
                  aria-label={`${label(role)} configuration draft`}
                >
                  <h3>
                    {label(role)} · {state.identity?.serial ?? 'Offline'}
                  </h3>
                  {state.draft && before && after ? (
                    <>
                      <div className="button-row">
                        {modes.map(([key, text]) => (
                          <label className="toggle-label" key={key}>
                            <input
                              type="checkbox"
                              aria-label={`${label(role)} ${text}`}
                              checked={state.draft![key]}
                              disabled={
                                busy || !connectedRoles.includes(role) || !state.allowed?.[key]
                              }
                              onChange={(event) => {
                                const value = event.target.checked;
                                invoke((actor) =>
                                  controller.edit(role, actor, {
                                    expectedRevision: controller.getSnapshot().revision,
                                    patch: { [key]: value },
                                  }),
                                );
                              }}
                            />
                            <span className="switch" />
                            {text}
                            <small>Actual {on(before[key])}</small>
                          </label>
                        ))}
                      </div>
                      {state.changed && (captured || state.preview) && (
                        <table
                          className="protection-table"
                          aria-label={`${label(role)} planned configuration changes`}
                        >
                          <thead>
                            <tr>
                              <th>Changed field</th>
                              <th>Actual</th>
                              <th>Planned</th>
                            </tr>
                          </thead>
                          <tbody>
                            {fields(after).flatMap(([name, value], index) => {
                              const previous = fields(before)[index][1];
                              return previous === value
                                ? []
                                : [
                                    <tr key={name}>
                                      <th scope="row">{name}</th>
                                      <td>{previous}</td>
                                      <td>{value}</td>
                                    </tr>,
                                  ];
                            })}
                          </tbody>
                        </table>
                      )}
                      {before.master !== after.master && (
                        <p className="hint">
                          {after.master
                            ? 'Master mode clears source and volume locks in all three presets.'
                            : 'Slave mode clears wake on mains, signal detection and fixed startup volume, and uses Standby shutdown.'}
                        </p>
                      )}
                      {before.bridge !== after.bridge && (
                        <p>
                          Bridge changes require matching output wiring and limiter settings, then a
                          DSP restart.
                        </p>
                      )}
                      {before.softClip && !after.softClip && (
                        <p>Disabling soft clip removes this limiter from the amplifier outputs.</p>
                      )}
                      {state.error && <p role="alert">{state.error}</p>}
                    </>
                  ) : (
                    <p className="hint">
                      Connect the {label(role)} amplifier to edit its configuration.
                    </p>
                  )}
                </section>
              );
            })}
          </div>
          {review && (
            <p className="hint">
              Reviewed {label(review.target)} · {review.id}
            </p>
          )}
          <div className="button-row">
            <button
              className="primary"
              disabled={busy || !available || !reviewCurrent || !valid || (!changed && !review)}
              onClick={() => void apply()}
            >
              {localBusy ? 'Applying…' : 'Apply configuration'}
            </button>
            {(changed || review) && (
              <button
                disabled={busy}
                onClick={() =>
                  invoke((actor) => {
                    if (review) controller.discard(review.id, actor);
                    controller.cancel(selected, actor);
                    setOutcome(undefined);
                  })
                }
              >
                {review ? 'Cancel reviewed changes' : 'Cancel changes'}
              </button>
            )}
          </div>
          <p className="hint">
            Draft changes apply only with this action. Runtime volume and mute are preserved; no
            restart is sent.
          </p>
          {(failure || snapshot.error) && <p role="alert">{failure || snapshot.error}</p>}
          {outcome && (
            <section aria-label="Configuration outcome">
              <h3>
                {outcome.complete
                  ? 'Configuration verified'
                  : outcome.partial
                    ? 'Configuration partially confirmed'
                    : 'Configuration was not applied'}
              </h3>
              <table className="protection-table">
                <thead>
                  <tr>
                    <th>Amplifier</th>
                    <th>Outcome</th>
                    <th>Configuration</th>
                  </tr>
                </thead>
                <tbody>
                  {outcome.roles.map((row) => (
                    <tr key={row.slot}>
                      <th scope="row">
                        {label(row.slot)} · {row.identity.serial}
                      </th>
                      <td>
                        {
                          (
                            {
                              pending: 'Not sent',
                              unchanged: 'Unchanged',
                              verified: 'Verified',
                              failed: 'Blocked before send',
                              unconfirmed: 'Unconfirmed',
                            } as const
                          )[row.state]
                        }
                        {row.error && <small>{row.error}</small>}
                      </td>
                      <td>
                        {row.confirmed
                          ? modeText(row.confirmed)
                          : `${row.state === 'unchanged' ? 'Unchanged: ' : 'Planned: '}${modeText(row.planned)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {outcome.error && <p role="alert">{outcome.error}</p>}
            </section>
          )}
        </>
      )}
    </section>
  );
}
