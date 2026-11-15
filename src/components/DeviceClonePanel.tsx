'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Project, Slot } from '../domain/model';
import type { ToolExecutionContext } from '../application/execution-context';
import {
  type DeviceCloneController,
  type DeviceCloneSummary,
  type DeviceCloneTarget,
} from '../application/device-clone';
import type { CloneJournalRecord, CloneOverrides } from '../application/device-clone-storage';
import {
  CLONE_MASTER_INPUT_SOURCES,
  CLONE_SLAVE_INPUT_SOURCES,
  inputSourceLabel,
} from '../hardware/input-sources';
import { download } from '../domain/files';
import styles from './DeviceClonePanel.module.css';

export interface DeviceClonePanelProps {
  controller: DeviceCloneController;
  slot: Slot;
  connectedRoles: readonly Slot[];
  getContext: () => ToolExecutionContext;
  contextReady?: boolean;
  externalBusy?: boolean;
  projects: Readonly<Record<Slot, Project>>;
  onExportNative?: (slot: Slot, format: 'xml' | 'folder') => void | Promise<void>;
}
const label = (value: DeviceCloneTarget) =>
  value === 'both' ? 'Left + Right' : value === 'left' ? 'Left' : 'Right';
const slots = (target: DeviceCloneTarget): Slot[] =>
  target === 'both' ? ['left', 'right'] : [target];
const on = (value: boolean) => (value ? 'On' : 'Off');
const number = (value: number | null) =>
  value === null || !Number.isFinite(value) ? 'Unavailable' : String(Number(value.toPrecision(9)));
const mute = (value: boolean | null | undefined) => (value == null ? 'Unknown' : on(value));
const problem = (value: unknown) =>
  value instanceof Error ? value.message : 'Clone operation did not complete';
const categories = ['General', 'Limiter', 'Hardware', 'Settings'] as const;
type Category = (typeof categories)[number];
type Row = { name: string; value: string };
function rows(value: DeviceCloneSummary, category: Category): Row[] {
  if (category === 'Limiter')
    return value.limiter.flatMap((channel, index) => [
      {
        name: `CH${index + 1} power / impedance`,
        value: `${number(channel.watts)} W / ${number(channel.ohms)} Ω`,
      },
      {
        name: `CH${index + 1} threshold / attack / release`,
        value: [channel.threshold, channel.attack, channel.release].map(number).join(' / '),
      },
      {
        name: `CH${index + 1} attack / release time`,
        value: `${number(channel.attackMs)} / ${number(channel.releaseMs)} ms`,
      },
    ]);
  if (category === 'Hardware') {
    const h = value.hardware;
    return [
      {
        name: 'Module / amplifier',
        value: `${h.moduleType === 9 ? 'FA503' : `Module ${h.moduleType}`} / ${h.amplifier === 5 ? 'NC502MP' : `Amplifier ${h.amplifier}`}`,
      },
      { name: 'Product / system setup', value: `${h.product} / 0x${h.systemSetup.toString(16)}` },
      {
        name: 'Third channel / fan',
        value: `${on(h.thirdChannelEnabled)} / ${on(h.fanConnected)}`,
      },
      { name: 'Stereo DSP / OLED capability', value: `${on(h.stereoDsp)} / ${on(h.oledCapable)}` },
      {
        name: 'Temperature / DSP peak settings · raw',
        value: `${h.temperatureSetpoint} / ${h.dspPeakSetpoint}`,
      },
      { name: 'OLED version · numeric', value: String(h.oledVersion) },
    ];
  }
  if (category === 'Settings') {
    const s = value.settings;
    return [
      {
        name: 'Master / soft clip / bridge',
        value: [s.master, s.softClip, s.bridge].map(on).join(' / '),
      },
      { name: 'Wake / signal detection', value: `${on(s.wakeOnLine)} / ${on(s.signalDetection)}` },
      {
        name: 'Auto-off / shutdown mode',
        value: `${s.powerOffMinutes} min / ${s.standbyMode === 0 ? 'Standby' : s.standbyMode === 1 ? 'Low power' : s.standbyMode}`,
      },
      {
        name: 'Fixed startup volume',
        value: s.startupVolume === -200 ? 'Disabled' : `${number(s.startupVolume)} dB`,
      },
      { name: 'Detection ON / OFF · wire indices', value: `${s.detectionOn} / ${s.detectionOff}` },
      { name: 'Preset offsets', value: `${s.presetOffsets.map(number).join(' / ')} dB` },
      {
        name: 'DAC filter / quality / FIR mode',
        value: `${s.dacFilter} / ${s.soundQuality} / ${s.firMode}`,
      },
      {
        name: 'Analogue gain · XLR / RCA',
        value: `${on(s.analogGainXlr)} / ${on(s.analogGainRca)}`,
      },
      {
        name: 'OLED max / dimmed / standby LED',
        value: `${s.oledMaximumBrightness} / ${s.oledDimmedBrightness} / ${['Off', '100%', '50%', '25%'][s.standbyLedMode] ?? s.standbyLedMode}`,
      },
      ...value.presets.map((preset, index) => ({
        name: `P${index + 1} source / source lock / volume lock / EQ / ADC out`,
        value: `${inputSourceLabel(preset.source)} / ${on(preset.sourceLock)} / ${on(preset.volumeLock)} / ${on(preset.eqEnabled)} / ${on(preset.adcOutput)}`,
      })),
    ];
  }
  return [
    { name: 'DSP filename', value: value.dspName || '(empty)' },
    {
      name: 'Hardware active preset / volume',
      value: `P${value.preset} / ${number(value.volume)} dB`,
    },
    {
      name: 'Master mute / channel mutes',
      value: `${on(value.muted)} / ${value.channelMutes.map(on).join(' / ')}`,
    },
    ...value.eqBanks.map((bank) => ({
      name: `P${bank.preset} physical EQ SHA-256`,
      value: bank.sha256,
    })),
    ...value.iirBanks.map((bank) => ({
      name: `P${bank.preset} filter SHA-256`,
      value: bank.sha256,
    })),
    ...value.firBanks.flatMap((bank) => [
      {
        name: `P${bank.preset} FIR placement / flags`,
        value: `${bank.placement === 0 ? 'Input' : 'Output'} / 0x${bank.flags.toString(16).padStart(2, '0')}`,
      },
      ...bank.filenames.map((file, i) => ({
        name: `P${bank.preset} FIR ${i === 0 ? 'input' : `CH${i}`} filename`,
        value: file.name || '(empty)',
      })),
      ...bank.sectors.map((sector) => ({
        name: `FIR sector 0x${sector.address.toString(16)} SHA-256`,
        value: sector.sha256,
      })),
    ]),
    ...value.eqBanks.flatMap((bank) => [
      {
        name: `P${bank.preset} EQ metadata`,
        value: bank.bands ? `${bank.bands.length} bands` : (bank.reason ?? 'Unavailable'),
      },
      ...(bank.bands
        ? bank.bands.map((band, i) => ({
            name: `P${bank.preset} EQ ${i + 1}`,
            value: `${band.kind} · ${on(band.enabled)} · ${number(band.frequency)} Hz · Q ${number(band.q)} · ${number(band.gain)} dB`,
          }))
        : []),
    ]),
  ];
}
function projectOverrides(project: Project): CloneOverrides | undefined {
  const template = project.hfdCloneTemplate;
  return template
    ? {
        mode: template.settings.options & 4 ? 'slave' : 'master',
        presets: template.settings.presets.map((p) => ({
          forceInput: p.forceInput,
          sourceLock: p.sourceLock,
          volumeLock: p.volumeLock,
        })),
      }
    : undefined;
}
function choices(overrides: CloneOverrides) {
  return overrides.mode === 'master' ? CLONE_MASTER_INPUT_SOURCES : CLONE_SLAVE_INPUT_SOURCES;
}
function phaseLabel(step: CloneJournalRecord['roles'][number]['steps'][number]) {
  if (step.state === 'verified') return 'Verified';
  if (step.state === 'skipped') return 'Not applicable';
  if (step.state === 'failed') return step.attempted ? 'Unconfirmed' : 'Blocked';
  if (step.state === 'pending') return 'Not sent';
  if (step.state === 'ready') return 'Intent saved · inspect if interrupted';
  return 'Unconfirmed';
}

export default function DeviceClonePanel({
  controller,
  slot,
  connectedRoles,
  getContext,
  contextReady = true,
  externalBusy = false,
  projects,
  onExportNative,
}: DeviceClonePanelProps) {
  const snapshot = useSyncExternalStore(
      controller.subscribe,
      controller.getSnapshot,
      controller.getSnapshot,
    ),
    [target, setTarget] = useState<DeviceCloneTarget>(slot),
    [category, setCategory] = useState<Category>('General'),
    [confirmedId, setConfirmedId] = useState<string>(),
    [failure, setFailure] = useState(''),
    [notice, setNotice] = useState(''),
    [localBusy, setLocalBusy] = useState(false),
    [historyLimit, setHistoryLimit] = useState(5),
    [result, setResult] = useState<CloneJournalRecord>(),
    [persistence, setPersistence] = useState<'verified' | 'unavailable'>('verified');
  const context = useRef(getContext),
    mounted = useRef(false),
    flight = useRef(false),
    viewContext = useRef(''),
    reviewElement = useRef<HTMLDivElement>(null),
    seenOutcome = useRef(snapshot.latestOutcome);
  context.current = getContext;
  const review = snapshot.activeReview,
    busy = localBusy || snapshot.busy || externalBusy,
    selected = review?.target ?? target,
    selectedSlots = slots(selected),
    available = selectedSlots.every(
      (role) => connectedRoles.includes(role) && snapshot.roles[role].connected,
    ),
    editorOverrides = (role: Slot) =>
      snapshot.roles[role].overrides ?? projectOverrides(projects[role]),
    sourceAvailable = selectedSlots.every(
      (role) => projects[role].hfdCloneTemplate?.configuration.valid,
    ),
    validSources = selectedSlots.every((role) => {
      const value = editorOverrides(role);
      return (
        !!value &&
        value.presets.length === 3 &&
        value.presets.every((p) => choices(value).some((c) => c.id === p.forceInput))
      );
    });
  const connectionKey = JSON.stringify(
    (['left', 'right'] as const).map((role) => [
      snapshot.roles[role].connected && connectedRoles.includes(role),
      snapshot.roles[role].identity?.serial,
      snapshot.roles[role].identity?.product,
      snapshot.roles[role].identity?.core,
      snapshot.roles[role].identity?.firmware,
    ]),
  );
  const outcomeContext = useRef<{ owner?: string; connectionKey: string; slot: Slot }>({
    connectionKey,
    slot,
  });
  viewContext.current = `${slot}:${selected}:${selectedSlots.map((role) => `${role}:${snapshot.roles[role].identity?.serial ?? ''}:${snapshot.roles[role].identity?.firmware ?? ''}`).join('|')}`;
  useEffect(() => {
    mounted.current = true;
    let active = true;
    if (contextReady && controller.getSnapshot().phase === 'idle')
      try {
        void controller.hydrate(context.current()).catch((error) => {
          if (active) setFailure(problem(error));
        });
      } catch (error) {
        setFailure(problem(error));
      }
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [controller, contextReady]);
  useEffect(() => {
    setTarget(slot);
    setFailure('');
    setNotice('');
    setResult(undefined);
  }, [slot]);
  useEffect(() => {
    const incoming = snapshot.latestOutcome;
    let owner: string | undefined;
    try {
      if (contextReady) owner = context.current().owner;
    } catch {
      /* An unavailable authority cannot expose an earlier owner's outcome. */
    }
    const previous = outcomeContext.current,
      changed =
        previous.owner !== owner ||
        previous.connectionKey !== connectionKey ||
        previous.slot !== slot;
    outcomeContext.current = { owner, connectionKey, slot };
    if (changed || !owner) {
      seenOutcome.current = incoming;
      setResult(undefined);
      setFailure('');
      setNotice('');
      return;
    }
    if (seenOutcome.current === incoming) return;
    seenOutcome.current = incoming;
    if (!incoming) {
      setResult(undefined);
      return;
    }
    const sameTargets = incoming.record.roles.every((role) => {
      const current = snapshot.roles[role.slot];
      return (
        current.connected &&
        connectedRoles.includes(role.slot) &&
        current.identity?.serial === role.identity.serial &&
        current.identity.product === role.identity.product &&
        current.identity.core === role.identity.core &&
        current.identity.firmware === role.identity.firmware
      );
    });
    if (incoming.record.owner !== owner || !sameTargets) {
      setResult(undefined);
      return;
    }
    setResult(incoming.record);
    setPersistence(incoming.persistence);
  }, [snapshot.latestOutcome, connectionKey, slot, contextReady, getContext]);
  useEffect(() => {
    setConfirmedId(undefined);
    if (review) {
      setTarget(review.target);
      setFailure('');
      setNotice('');
      setResult(undefined);
      reviewElement.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [review?.id]);
  const perform = async (work: () => void | Promise<unknown>, success?: string) => {
    if (flight.current || !contextReady) return;
    flight.current = true;
    setLocalBusy(true);
    setFailure('');
    setNotice('');
    const captured = viewContext.current;
    try {
      await work();
      if (mounted.current && captured === viewContext.current && success) setNotice(success);
    } catch (error) {
      if (mounted.current && captured === viewContext.current) {
        setFailure(problem(error));
      }
    } finally {
      flight.current = false;
      if (mounted.current) setLocalBusy(false);
    }
  };
  const edit = (role: Slot, value: CloneOverrides) => {
    if (busy || !contextReady) return;
    setConfirmedId(undefined);
    setFailure('');
    setNotice('');
    try {
      controller.editOverrides(role, context.current(), {
        expectedRevision: controller.getSnapshot().revision,
        overrides: value,
      });
    } catch (error) {
      setFailure(problem(error));
    }
  };
  const exportJournal = (id: string) =>
    perform(() => {
      const record = controller.exportRecord(id, context.current());
      download(`Clone-${record.id}.json`, JSON.stringify(record, null, 2));
    }, 'Recovery record exported.');
  const currentReview = review?.roles.every((role) => {
    const current = snapshot.roles[role.slot];
    return (
      current.connected &&
      current.identity?.serial === role.identity.serial &&
      current.identity.core === role.identity.core &&
      current.identity.firmware === role.identity.firmware &&
      current.identity.product === role.identity.product
    );
  });
  return (
    <section className={`feature-card ${styles.panel}`} aria-label="Device clone">
      <header className={styles.header}>
        <div>
          <h2>Clone settings</h2>
          <p>Device settings, three physical EQ banks and all three filter presets.</p>
        </div>
        <label className={styles.target}>
          Apply to{' '}
          <select
            aria-label="Clone target"
            value={selected}
            disabled={busy || !!review}
            onChange={(event) => {
              setTarget(event.target.value as DeviceCloneTarget);
              setFailure('');
              setNotice('');
              setResult(undefined);
            }}
          >
            <option value="left">Left</option>
            <option value="right">Right</option>
            <option value="both">Left + Right</option>
          </select>
        </label>
      </header>
      <div className={styles.identities}>
        {selectedSlots.map((role) => (
          <span key={role}>
            <strong>{label(role)}</strong> · {snapshot.roles[role].identity?.serial ?? 'Offline'}
            {snapshot.roles[role].identity && ` · ${snapshot.roles[role].identity!.firmware}`}
          </span>
        ))}
      </div>
      {!review ? (
        <>
          <div className={styles.toolbar}>
            <button
              disabled={busy || !contextReady || !available}
              onClick={() =>
                perform(
                  () => controller.reload(target, context.current()),
                  'Captured device settings and physical EQ into the selected projects.',
                )
              }
            >
              Capture / Reload settings
            </button>
            <button
              disabled={
                busy ||
                !contextReady ||
                !available ||
                !sourceAvailable ||
                !validSources ||
                snapshot.phase !== 'ready'
              }
              onClick={() =>
                perform(() =>
                  controller.review(target, context.current(), {
                    expectedRevision: controller.getSnapshot().revision,
                  }),
                )
              }
            >
              Review clone
            </button>
            {snapshot.phase === 'error' && (
              <button
                disabled={busy || !contextReady}
                onClick={() => perform(() => controller.hydrate(context.current()))}
              >
                Retry journal
              </button>
            )}
          </div>
          <p className={styles.hint}>
            Capture / Reload reads current settings and saved physical EQ. Staged filters and
            editable EQ stay unchanged. Both applies each amplifier's own project and overrides.
          </p>
          <div className={styles.editors}>
            {selectedSlots.map((role) => {
              const project = projects[role],
                template = project.hfdCloneTemplate,
                value = editorOverrides(role),
                menu = value ? choices(value) : [];
              return (
                <section
                  className={styles.role}
                  key={role}
                  aria-label={`${label(role)} Clone overrides`}
                >
                  <div className={styles.roleHeader}>
                    <h3>
                      {label(role)} · {project.name}
                    </h3>
                    <span>
                      {template
                        ? `${template.provenance.kind === 'device-capture' ? 'Captured device' : 'Saved HFD project'} · ${template.provenance.sourceSerial || 'Source serial unavailable'}`
                        : 'No captured template'}
                    </span>
                  </div>
                  {template?.provenance.capturedAt && (
                    <p className={styles.hint}>Captured {template.provenance.capturedAt}</p>
                  )}
                  {value ? (
                    <>
                      <label className={styles.mode}>
                        {label(role)} mode{' '}
                        <select
                          aria-label={`${label(role)} Clone mode`}
                          value={value.mode}
                          disabled={busy || !contextReady}
                          onChange={(event) => {
                            const mode = event.target.value as CloneOverrides['mode'],
                              allowed =
                                mode === 'master'
                                  ? CLONE_MASTER_INPUT_SOURCES
                                  : CLONE_SLAVE_INPUT_SOURCES;
                            edit(role, {
                              mode,
                              presets: value.presets.map((p) => ({
                                ...p,
                                forceInput: allowed.some((c) => c.id === p.forceInput)
                                  ? p.forceInput
                                  : 1,
                                sourceLock: mode === 'slave' && p.sourceLock,
                                volumeLock: mode === 'slave' && p.volumeLock,
                              })),
                            });
                          }}
                        >
                          <option value="master">Master</option>
                          <option value="slave">Slave</option>
                        </select>
                      </label>
                      <table className={styles.overrides}>
                        <thead>
                          <tr>
                            <th>Preset</th>
                            <th>Forced source</th>
                            <th>Source lock</th>
                            <th>Volume lock</th>
                          </tr>
                        </thead>
                        <tbody>
                          {value.presets.map((preset, index) => (
                            <tr key={index}>
                              <th scope="row">{index + 1}</th>
                              <td>
                                <select
                                  aria-label={`${label(role)} preset ${index + 1} source`}
                                  value={preset.forceInput}
                                  disabled={busy || !contextReady}
                                  onChange={(event) =>
                                    edit(role, {
                                      ...value,
                                      presets: value.presets.map((p, i) =>
                                        i === index
                                          ? { ...p, forceInput: Number(event.target.value) }
                                          : p,
                                      ),
                                    })
                                  }
                                >
                                  {!menu.some((c) => c.id === preset.forceInput) && (
                                    <option value={preset.forceInput} disabled>
                                      {inputSourceLabel(preset.forceInput)} · choose source
                                    </option>
                                  )}
                                  {menu.map((source) => (
                                    <option key={source.id} value={source.id}>
                                      {source.label}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              {(['sourceLock', 'volumeLock'] as const).map((field) => (
                                <td key={field}>
                                  <input
                                    type="checkbox"
                                    aria-label={`${label(role)} preset ${index + 1} ${field === 'sourceLock' ? 'source' : 'volume'} lock`}
                                    checked={value.mode === 'slave' && preset[field]}
                                    disabled={busy || !contextReady || value.mode === 'master'}
                                    onChange={(event) =>
                                      edit(role, {
                                        ...value,
                                        presets: value.presets.map((p, i) =>
                                          i === index ? { ...p, [field]: event.target.checked } : p,
                                        ),
                                      })
                                    }
                                  />
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  ) : (
                    <p className={styles.hint}>
                      Open a valid HFD template or explicitly capture the connected amplifier.
                    </p>
                  )}
                  <div className={styles.exports}>
                    <span className={styles.hint}>Export captured template</span>
                    <button
                      disabled={busy || !contextReady || !template || !onExportNative}
                      onClick={() => perform(() => onExportNative?.(role, 'xml'))}
                    >
                      {label(role)} captured XML
                    </button>
                    <button
                      disabled={busy || !contextReady || !template || !onExportNative}
                      onClick={() => perform(() => onExportNative?.(role, 'folder'))}
                    >
                      {label(role)} captured folder
                    </button>
                  </div>
                  <p className={styles.hint}>
                    Draft Clone overrides are excluded from captured-template exports.
                  </p>
                </section>
              );
            })}
          </div>
          {!available && (
            <p className={styles.hint}>
              Connect every selected amplifier to review or capture. Offline template export remains
              available.
            </p>
          )}
          {sourceAvailable && !validSources && (
            <p className={styles.warning}>
              Choose a supported source for every preset before reviewing. Saved values were
              retained.
            </p>
          )}
          {selectedSlots
            .filter(
              (role) =>
                projects[role].hfdCloneTemplate &&
                !projects[role].hfdCloneTemplate!.configuration.valid,
            )
            .map((role) => (
              <p className={styles.warning} key={role}>
                {label(role)} captured template is marked invalid. Inspection and export are
                available; a valid source is required to review a clone.
              </p>
            ))}
        </>
      ) : (
        <div className={styles.review} ref={reviewElement}>
          <div className={styles.reviewHeader}>
            <h3>Review clone · {label(review.target)}</h3>
            <span>Review {review.id}</span>
          </div>
          <div className={styles.reviewSources}>
            {review.roles.map((role) => (
              <span key={role.slot}>
                <strong>
                  {label(role.slot)} · {role.identity.serial}
                </strong>{' '}
                · {role.projectName} · design {role.documentRevision}, template{' '}
                {role.templateRevision}
                {role.templateProvenance &&
                  ` · ${role.templateProvenance.kind} from ${role.templateProvenance.sourceSerial || 'unknown source'}`}
              </span>
            ))}
          </div>
          <div className={styles.tabs} role="tablist" aria-label="Clone information categories">
            {categories.map((value) => (
              <button
                key={value}
                role="tab"
                aria-selected={category === value}
                onClick={() => setCategory(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <div
            className={styles.details}
            role="tabpanel"
            aria-label={`${category} before and after`}
          >
            <table className={styles.comparison}>
              <thead>
                <tr>
                  <th>Amplifier / field</th>
                  <th>Before</th>
                  <th>Planned</th>
                </tr>
              </thead>
              <tbody>
                {review.roles.flatMap((role) => {
                  const before = new Map(
                      rows(role.before, category).map((row) => [row.name, row.value]),
                    ),
                    after = new Map(rows(role.after, category).map((row) => [row.name, row.value])),
                    names = [...new Set([...after.keys(), ...before.keys()])];
                  return names.map((name) => (
                    <tr key={`${role.slot}:${name}`}>
                      <th scope="row">
                        <span>{label(role.slot)}</span>
                        {name}
                      </th>
                      <td>{before.get(name) ?? 'Unavailable'}</td>
                      <td>{after.get(name) ?? 'Unavailable'}</td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
          {review.roles.some((role) => role.warnings.length > 0) && (
            <details className={styles.warnings}>
              <summary>
                Plan qualifications ·{' '}
                {review.roles.reduce((sum, role) => sum + role.warnings.length, 0)}
              </summary>
              {review.roles.map((role) =>
                role.warnings.map((warning, index) => (
                  <p key={`${role.slot}:${index}`}>
                    {label(role.slot)}: {warning}
                  </p>
                )),
              )}
            </details>
          )}
          <div className={styles.confirmation}>
            <label>
              <input
                type="checkbox"
                checked={confirmedId === review.id}
                disabled={busy || !contextReady || !currentReview}
                onChange={(event) => setConfirmedId(event.target.checked ? review.id : undefined)}
              />{' '}
              Apply this reviewed clone to {label(review.target)}
            </label>
            <div className={styles.toolbar}>
              <button
                disabled={busy || !contextReady}
                onClick={() => {
                  try {
                    controller.discard(review.id, context.current());
                    setConfirmedId(undefined);
                    setFailure('');
                  } catch (error) {
                    setFailure(problem(error));
                  }
                }}
              >
                Cancel review
              </button>
              <button
                disabled={busy || !contextReady || confirmedId !== review.id || !currentReview}
                onClick={() => {
                  void perform(async () => {
                    await controller.apply(review.id, context.current(), {
                      confirm: true,
                    });
                  }, 'Clone completed and its recovery record was verified.');
                }}
              >
                Apply clone
              </button>
            </div>
          </div>
          <p className={styles.hint}>
            Original bytes and the complete plan must be durably verified before setters. Amplifiers
            complete independently; an interrupted request is not automatically retried.
          </p>
        </div>
      )}
      {(failure || snapshot.error) && (
        <p role="alert" className={styles.error}>
          {failure || snapshot.error}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.hint}>
          {notice}
        </p>
      )}
      {result && (
        <section className={styles.outcome} aria-label="Clone outcome">
          <div className={styles.reviewHeader}>
            <h3>
              {result.phase === 'complete'
                ? 'Verified clone completion'
                : `Clone ${result.phase} · inspect before continuing`}{' '}
              · {label(result.target)}
            </h3>
            <button disabled={busy || !contextReady} onClick={() => exportJournal(result.id)}>
              Export recovery record
            </button>
          </div>
          <div className={styles.identities}>
            {result.roles.map((role) => (
              <span key={role.slot}>
                {label(role.slot)} · {role.identity.serial}
              </span>
            ))}
          </div>
          {persistence === 'unavailable' && (
            <p className={styles.error}>
              Journal persistence is unconfirmed. Keep this outcome visible; no retry was sent.
            </p>
          )}
          <div className={styles.resultScroll}>
            <table className={styles.comparison}>
              <thead>
                <tr>
                  <th>Amplifier / phase</th>
                  <th>Outcome</th>
                  <th>Last confirmed mute</th>
                </tr>
              </thead>
              <tbody>
                {result.roles.flatMap((role) =>
                  role.steps.map((step) => (
                    <tr key={`${role.slot}:${step.id}`}>
                      <th scope="row">
                        {label(role.slot)} · {step.id}
                      </th>
                      <td>
                        {phaseLabel(step)}
                        {step.error && <small>{step.error}</small>}
                      </td>
                      <td>{mute(role.lastConfirmedMuted)}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
          {result.phase !== 'complete' && (
            <p className={styles.hint}>
              This request is consumed. Inspect or export its record; reusing its ID does not
              restart setters.
            </p>
          )}
        </section>
      )}
      <details className={styles.history}>
        <summary>Clone history · {snapshot.records.length} records</summary>
        <p className={styles.hint}>
          Historical completion is not a fresh device check. Recovery records contain local original
          and planned bytes.
        </p>
        {snapshot.records
          .slice(-historyLimit)
          .reverse()
          .map((record) => (
            <div className={styles.historyRow} key={record.id}>
              <span>
                {label(record.target)} · {record.phase} · {record.id}
              </span>
              <div className={styles.toolbar}>
                <button
                  disabled={busy || !contextReady}
                  onClick={() => {
                    try {
                      if (context.current().owner !== record.owner)
                        throw new Error(
                          'This historical Clone record belongs to another workspace',
                        );
                      setResult(record);
                      setPersistence('verified');
                    } catch (error) {
                      setFailure(problem(error));
                    }
                  }}
                >
                  View outcome
                </button>
                <button disabled={busy || !contextReady} onClick={() => exportJournal(record.id)}>
                  Export record
                </button>
              </div>
            </div>
          ))}
        {historyLimit < snapshot.records.length && (
          <button onClick={() => setHistoryLimit((limit) => Math.min(32, limit + 5))}>
            Show older records
          </button>
        )}
      </details>
    </section>
  );
}
