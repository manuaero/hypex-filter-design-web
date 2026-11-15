'use client';

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Slot } from '../domain/model';
import type { DeviceAuthController } from '../application/device-auth';
import {
  decodeRecoveryEmail,
  encodePassword,
  validatePasswordChangeInput,
  validateRecoveryEmailInput,
  type CredentialEncoding,
  type CredentialInput,
} from '../domain/credential-encoding';
import { OEM_ITEMS } from '../hardware/protection';
import PasswordRecoveryPanel from './PasswordRecoveryPanel';

const encodings: { value: CredentialEncoding; label: string }[] = [
  { value: 'ascii', label: 'ASCII' },
  { value: 'windows-1252', label: 'Windows-1252' },
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'hex', label: 'Byte hex' },
];
const maskText = (value: number) => `0x${value.toString(16).padStart(4, '0')}`;
function Encoding({
  label,
  value,
  change,
  disabled,
}: {
  label: string;
  value: CredentialEncoding;
  change: (value: CredentialEncoding) => void;
  disabled: boolean;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => change(e.target.value as CredentialEncoding)}
    >
      {encodings.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  );
}
function byteCount(input: CredentialInput) {
  let bytes: Uint8Array | undefined;
  try {
    bytes = encodePassword(input);
    return `${bytes.length}/16 bytes`;
  } catch {
    return 'Check encoding / 16-byte limit';
  } finally {
    bytes?.fill(0);
  }
}
function isEmptyPassword(input: CredentialInput) {
  let bytes: Uint8Array | undefined;
  try {
    bytes = encodePassword(input);
    return bytes.length === 0;
  } catch {
    return false;
  } finally {
    bytes?.fill(0);
  }
}

export default function DeviceAuthPanel({
  controller,
  slot,
  externalBusy = false,
  refresh,
  view,
  onViewChange,
}: {
  controller: DeviceAuthController;
  slot: Slot;
  externalBusy?: boolean;
  refresh?: () => Promise<void>;
  view?: 'closed' | 'password' | 'permissions';
  onViewChange?: (view: 'closed' | 'password' | 'permissions') => void;
}) {
  const snapshot = useSyncExternalStore(
      controller.subscribe,
      controller.getSnapshot,
      controller.getSnapshot,
    ),
    state = snapshot[slot],
    protection = state.protection,
    role = slot === 'left' ? 'Left' : 'Right';
  const [tab, setTab] = useState<'closed' | 'password' | 'permissions'>('password'),
    [current, setCurrent] = useState(''),
    [next, setNext] = useState(''),
    [confirm, setConfirm] = useState(''),
    [currentEncoding, setCurrentEncoding] = useState<CredentialEncoding>('ascii'),
    [nextEncoding, setNextEncoding] = useState<CredentialEncoding>('ascii'),
    [email, setEmail] = useState(''),
    [emailEncoding, setEmailEncoding] = useState<CredentialEncoding>('ascii'),
    [emailNote, setEmailNote] = useState(''),
    [draftMask, setDraftMask] = useState(7),
    [maskEdited, setMaskEdited] = useState(false),
    [localError, setLocalError] = useState('');
  const mounted = useRef(true),
    request = useRef(0);
  const activeView = view ?? tab;
  useLayoutEffect(() => {
    if (activeView !== 'closed') return;
    request.current++;
    setCurrent('');
    setNext('');
    setConfirm('');
    setEmail('');
    setEmailNote('');
    setLocalError('');
    controller.discardOemProposal(slot);
    controller.recovery?.clear(slot);
  }, [controller, slot, activeView]);
  const changeView = (nextView: 'closed' | 'password' | 'permissions') =>
    onViewChange ? onViewChange(nextView) : setTab(nextView);
  useLayoutEffect(() => {
    mounted.current = true;
    request.current++;
    setCurrent('');
    setNext('');
    setConfirm('');
    setEmail('');
    setEmailNote('');
    setLocalError('');
    setCurrentEncoding('ascii');
    setNextEncoding('ascii');
    setEmailEncoding('ascii');
    setMaskEdited(false);
    setDraftMask(7);
    setTab('password');
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, [
    controller,
    slot,
    state.target?.serial,
    state.target?.core,
    state.target?.firmware,
    state.target?.product,
  ]);
  useEffect(() => {
    mounted.current = true;
    if (state.connected && !state.busy) void controller.status(slot).catch(() => {});
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, [
    controller,
    slot,
    state.connected,
    state.target?.serial,
    state.target?.core,
    state.target?.firmware,
    state.target?.product,
  ]);
  useEffect(() => {
    if (protection && !maskEdited) setDraftMask((protection.rawMask & 0x0ff8) | 7);
  }, [protection?.rawMask, maskEdited]);
  const busy = externalBusy || state.busy,
    unlocked = !!protection && !protection.locked,
    clearsPassword = isEmptyPassword({ text: next, encoding: nextEncoding }),
    proposal =
      state.proposal?.requestedMask === draftMask &&
      state.proposal.previousMask === protection?.rawMask
        ? state.proposal
        : undefined;
  const run = async (
    operation: (isCurrent: () => boolean) => Promise<unknown>,
    after?: () => void,
  ) => {
    const generation = ++request.current;
    const isCurrent = () => mounted.current && generation === request.current;
    setLocalError('');
    try {
      await operation(isCurrent);
      if (!isCurrent()) return;
      after?.();
      await refresh?.();
    } catch (error) {
      if (mounted.current && generation === request.current)
        setLocalError(
          error instanceof Error
            ? error.message
            : 'The amplifier operation could not be confirmed.',
        );
    }
  };
  const loadEmail = async () => {
    if (!mounted.current) return;
    const generation = request.current;
    let bytes: Uint8Array | undefined;
    try {
      bytes = await controller.readEmail(slot);
      const decoded = decodeRecoveryEmail(bytes, emailEncoding);
      if (mounted.current && generation === request.current) {
        setEmail(decoded.text);
        setEmailEncoding(decoded.encoding);
        setEmailNote(
          decoded.fallback
            ? 'The stored address uses a different encoding; exact bytes are shown.'
            : 'Saved address read from this amplifier.',
        );
      }
    } finally {
      bytes?.fill(0);
    }
  };
  let validation = '';
  try {
    const bytes = validatePasswordChangeInput({
      oldPassword: { text: current, encoding: currentEncoding },
      newPassword: { text: next, encoding: nextEncoding },
      retypePassword: { text: confirm, encoding: nextEncoding },
      email: { text: email, encoding: emailEncoding },
      protected: protection?.passwordProtected ?? false,
    });
    bytes.oldPassword?.fill(0);
    bytes.newPassword.fill(0);
    bytes.email.fill(0);
  } catch (error) {
    validation =
      error instanceof Error ? error.message : 'Check the password and recovery address.';
  }
  let emailValid = false;
  try {
    const bytes = validateRecoveryEmailInput({ text: email, encoding: emailEncoding });
    bytes.fill(0);
    emailValid = true;
  } catch {}
  const error = localError || state.error,
    result = state.lastResult,
    unconfirmed =
      !!result &&
      ('passwordWrite' in result
        ? result.passwordWrite === 'unconfirmed' || result.emailWrite === 'unconfirmed'
        : 'write' in result && result.write === 'unconfirmed');
  if (!state.connected) return null;
  return (
    <section className="feature-card auth-panel" aria-label={`${role} amplifier access`}>
      <div className="panel-heading">
        <div>
          <h2>Access & password</h2>
          <span className="auth-target">
            {role} · {state.target?.serial} · firmware {state.target?.firmware}
          </span>
        </div>
        <strong className="auth-state">
          {!protection
            ? 'Reading access…'
            : !protection.passwordProtected
              ? 'No password set'
              : protection.passwordMatched
                ? 'Password verified'
                : 'Password protected'}
        </strong>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => controller.status(slot))}
        >
          Refresh access
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => changeView(activeView === 'closed' ? 'password' : 'closed')}
        >
          {activeView === 'closed' ? 'Manage access' : 'Close access editor'}
        </button>
      </div>
      {activeView !== 'closed' && (
        <>
          <div className="auth-tabs" role="tablist" aria-label="Amplifier access settings">
            <button
              role="tab"
              aria-selected={activeView === 'password'}
              onClick={() => changeView('password')}
            >
              Password & recovery address
            </button>
            <button
              role="tab"
              aria-selected={activeView === 'permissions'}
              onClick={() => changeView('permissions')}
            >
              Allowed features
            </button>
          </div>
          <div className="auth-grid">
            <div>
              {activeView === 'password' ? (
                <fieldset disabled={busy} className="auth-fields">
                  <legend>Password & recovery address</legend>
                  <label className="auth-secret">
                    <span>
                      Current password{' '}
                      <small>{byteCount({ text: current, encoding: currentEncoding })}</small>
                    </span>
                    <input
                      aria-label="Current amplifier password"
                      type="password"
                      autoComplete="off"
                      value={current}
                      maxLength={256}
                      onChange={(e) => setCurrent(e.target.value)}
                    />
                    <Encoding
                      label="Current password encoding"
                      value={currentEncoding}
                      change={setCurrentEncoding}
                      disabled={busy}
                    />
                  </label>
                  <div className="button-row">
                    <button
                      type="button"
                      disabled={!protection || !current}
                      onClick={() =>
                        void run(async (isCurrent) => {
                          await controller.unlock(slot, {
                            text: current,
                            encoding: currentEncoding,
                          });
                          if (isCurrent()) await loadEmail();
                        })
                      }
                    >
                      Unlock amplifier
                    </button>
                    <small>Match the encoding used when this password was created.</small>
                  </div>
                  <div className="auth-two-fields">
                    <label className="auth-secret">
                      <span>
                        New password{' '}
                        <small>{byteCount({ text: next, encoding: nextEncoding })}</small>
                      </span>
                      <input
                        aria-label="New amplifier password"
                        type="password"
                        autoComplete="off"
                        value={next}
                        maxLength={256}
                        disabled={!unlocked}
                        onChange={(e) => setNext(e.target.value)}
                      />
                      <Encoding
                        label="New password encoding"
                        value={nextEncoding}
                        change={setNextEncoding}
                        disabled={busy || !unlocked}
                      />
                    </label>
                    <label className="auth-secret auth-retype">
                      <span>Retype new password</span>
                      <input
                        aria-label="Retype new amplifier password"
                        type="password"
                        autoComplete="off"
                        value={confirm}
                        maxLength={256}
                        disabled={!unlocked}
                        onChange={(e) => setConfirm(e.target.value)}
                      />
                    </label>
                  </div>
                  <label className="auth-secret">
                    <span>Recovery email</span>
                    <input
                      aria-label="Amplifier recovery email"
                      type="text"
                      inputMode={emailEncoding === 'hex' ? 'text' : 'email'}
                      autoComplete="off"
                      value={email}
                      maxLength={256}
                      disabled={!unlocked}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        setEmailNote('');
                      }}
                    />
                    <Encoding
                      label="Recovery email encoding"
                      value={emailEncoding}
                      change={(value) => {
                        setEmailEncoding(value);
                        setEmailNote('');
                      }}
                      disabled={busy || !unlocked}
                    />
                  </label>
                  <div className="button-row">
                    <button type="button" disabled={!unlocked} onClick={() => void run(loadEmail)}>
                      Read saved address
                    </button>
                    <button
                      type="button"
                      disabled={!unlocked || !emailValid}
                      onClick={() =>
                        void run(
                          () =>
                            controller.writeEmail(slot, { text: email, encoding: emailEncoding }),
                          () => setEmailNote('Address written and read back.'),
                        )
                      }
                    >
                      Save address
                    </button>
                  </div>
                  {emailNote && <p className="hint">{emailNote}</p>}
                  <div className="button-row">
                    <button
                      className="primary"
                      type="button"
                      disabled={!unlocked || !!validation}
                      onClick={() =>
                        void run(
                          () =>
                            controller.change(slot, {
                              current: { text: current, encoding: currentEncoding },
                              next: { text: next, encoding: nextEncoding },
                              confirm: { text: confirm, encoding: nextEncoding },
                              email: { text: email, encoding: emailEncoding },
                            }),
                          () => {
                            setCurrent('');
                            setNext('');
                            setConfirm('');
                            setEmail('');
                            setEmailNote('');
                          },
                        )
                      }
                    >
                      {clearsPassword
                        ? 'Clear password'
                        : protection?.passwordProtected
                          ? 'Change password'
                          : 'Set password'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        request.current++;
                        setCurrent('');
                        setNext('');
                        setConfirm('');
                        setEmail('');
                        setEmailNote('');
                        setLocalError('');
                        controller.clear(slot);
                        void controller.status(slot).catch(() => {});
                      }}
                    >
                      Clear form
                    </button>
                  </div>
                  {validation && unlocked && (
                    <p className="hint" role="status">
                      {validation}
                    </p>
                  )}
                  {controller.recovery ? (
                    <PasswordRecoveryPanel
                      controller={controller.recovery}
                      slot={slot}
                      paused={busy}
                    />
                  ) : (
                    <details className="auth-recovery-help">
                      <summary>Forgotten password</summary>
                      <p>
                        Recovery requests and support-code entry still require HFD. This app does
                        not send recovery requests yet.
                      </p>
                    </details>
                  )}
                </fieldset>
              ) : (
                <fieldset
                  disabled={busy || !unlocked || !protection?.isOemConfigured}
                  className="auth-fields"
                >
                  <legend>Features usable without a password</legend>
                  <div className="auth-permission-grid">
                    {OEM_ITEMS.filter((item) => item.ordinal <= 11).map((item) => (
                      <label key={item.id}>
                        <input
                          type="checkbox"
                          checked={item.ordinal < 3 || !!(draftMask & item.mask)}
                          disabled={item.ordinal < 3}
                          onChange={(e) => {
                            controller.discardOemProposal(slot);
                            setMaskEdited(true);
                            setDraftMask((old) =>
                              e.target.checked ? old | item.mask : old & ~item.mask,
                            );
                          }}
                        />
                        {item.label}
                      </label>
                    ))}
                  </div>
                  <p className="hint">
                    Input source, volume/mute and preset are always enabled. Save replaces the
                    native FusionAmp permission mask.
                  </p>
                  <div className="button-row">
                    <button
                      type="button"
                      onClick={() => void run(() => controller.proposeOem(slot, draftMask))}
                    >
                      Review permissions
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={!proposal}
                      onClick={() =>
                        proposal &&
                        void run(
                          () => controller.saveOem(slot, proposal.id),
                          () => setMaskEdited(false),
                        )
                      }
                    >
                      Save reviewed permissions
                    </button>
                  </div>
                </fieldset>
              )}
            </div>
            <aside className="auth-context" aria-label={`${role} access context`}>
              <dl>
                <dt>Target</dt>
                <dd>{role} amplifier</dd>
                <dt>Serial</dt>
                <dd>{state.target?.serial}</dd>
                <dt>Access</dt>
                <dd>
                  {protection?.locked ? 'Password required' : protection ? 'Unlocked' : 'Reading…'}
                </dd>
                <dt>Module</dt>
                <dd>
                  {protection?.moduleType ?? 'Unknown'}
                  {protection?.isOemConfigured ? ' · OEM' : ''}
                </dd>
                <dt>Stored mask</dt>
                <dd>{protection ? maskText(protection.rawMask) : 'Reading…'}</dd>
              </dl>
              {activeView === 'permissions' && (
                <>
                  {!protection?.isOemConfigured && (
                    <p className="hint">Permission editing requires a configured OEM module.</p>
                  )}
                  {protection?.locked && (
                    <p className="hint">Unlock this amplifier to edit its permissions.</p>
                  )}
                  <dl>
                    <dt>Draft mask</dt>
                    <dd>{maskText(draftMask)}</dd>
                  </dl>
                  {proposal && (
                    <div className="auth-proposal">
                      <strong>Reviewed replacement</strong>
                      <dl>
                        <dt>New mask</dt>
                        <dd>{maskText(proposal.targetMask)}</dd>
                        <dt>Forced on</dt>
                        <dd>{maskText(proposal.forcedMask)}</dd>
                        <dt>Bits cleared</dt>
                        <dd>{maskText(proposal.clearedMask)}</dd>
                      </dl>
                      {proposal.clearedMask !== 0 && (
                        <p>The listed cleared bits will be removed from this amplifier.</p>
                      )}
                    </div>
                  )}
                  {protection && (protection.rawMask & 0xf000) !== 0 && (
                    <p className="hint">
                      Stored unsupported bits {maskText(protection.rawMask & 0xf000)} are cleared by
                      the native FusionAmp replacement.
                    </p>
                  )}
                </>
              )}
              {state.busy && <p role="status">{state.operation?.replaceAll('-', ' ')}…</p>}
              {unconfirmed && (
                <p className="inline-warning">
                  A write is unconfirmed. Inspect fresh amplifier state before another write.
                </p>
              )}
              {result && (
                <div className="auth-result">
                  <strong>Last operation</strong>
                  {'steps' in result ? (
                    <>
                      <p>
                        Password: {result.passwordWrite} · Address: {result.emailWrite}
                      </p>
                      <ol>
                        {result.steps.map((step, index) => (
                          <li key={`${step.name}:${index}`}>
                            <span>{step.name.replaceAll('-', ' ')}</span>
                            <strong>{step.state}</strong>
                          </li>
                        ))}
                      </ol>
                    </>
                  ) : (
                    <p>
                      {'write' in result
                        ? 'Permission write unconfirmed'
                        : 'Permissions verified by readback.'}
                    </p>
                  )}
                </div>
              )}
              {error && (
                <p role="alert" className="inline-error">
                  {error}
                </p>
              )}
            </aside>
          </div>
        </>
      )}
    </section>
  );
}
