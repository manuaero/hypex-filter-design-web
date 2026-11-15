import type { Project, Slot, Filter } from '../domain/model';
import {
  DeviceCloneStepError,
  type PanelSession,
  type Identity,
  type CloneTargetSnapshot,
} from '../hardware/session';
import { parseExecutionPrincipal, type ToolExecutionContext } from './execution-context';
import { buildClonePlan, type DeviceClonePlan } from '../hardware/clone-plan';
import { nativeCloneTemplateSchema, type NativeCloneTemplate } from '../domain/clone-template';
import { captureNativeCloneTemplate } from '../hardware/clone-capture';
import { deviceDefaultsStatusMask } from '../hardware/device-defaults';
import { decodeStatus, decodeEq, settings, hex, unhex } from '../hardware/codec';
import { decodeHardwareOverview, decodeLimiter } from '../hardware/device-settings';
import { Sha256 } from './file-transfers';
import { CLONE_MASTER_INPUT_SOURCES, CLONE_SLAVE_INPUT_SOURCES } from '../hardware/input-sources';
import {
  CLONE_PHASES,
  MAX_DEVICE_CLONE_RECORDS,
  createDeviceCloneStorage,
  parseDeviceCloneEnvelope,
  type CloneOverrides,
  type CloneJournalRecord,
  type CloneJournalEnvelope,
  type CloneMemoryImage,
  type DeviceCloneStorage,
} from './device-clone-storage';

export type DeviceCloneTarget = Slot | 'both';
export interface DeviceCloneBinding {
  session: PanelSession;
  identity: Pick<Identity, 'serial' | 'product' | 'core' | 'firmware'>;
}
export interface DeviceCloneDesign {
  project: Project;
  documentRevision: number;
  templateRevision: number;
}
export interface DeviceCloneReview {
  id: string;
  target: DeviceCloneTarget;
  revision: number;
  createdAt: number;
  roles: {
    slot: Slot;
    identity: DeviceCloneBinding['identity'];
    projectName: string;
    templateProvenance?: Pick<
      NativeCloneTemplate['provenance'],
      'kind' | 'sourceSerial' | 'capturedAt'
    >;
    documentRevision: number;
    templateRevision: number;
    overrides: CloneOverrides;
    before: DeviceCloneSummary;
    after: DeviceCloneSummary;
    steps: string[];
    warnings: string[];
  }[];
}
export interface DeviceCloneSummary {
  dspName: string;
  preset: number;
  volume: number;
  muted: boolean;
  channelMutes: boolean[];
  settings: ReturnType<typeof settings>;
  hardware: ReturnType<typeof decodeHardwareOverview>;
  limiter: (Omit<ReturnType<typeof decodeLimiter>['channels'][number], 'attackMs' | 'releaseMs'> & {
    attackMs: number | null;
    releaseMs: number | null;
  })[];
  presets: {
    source: number;
    sourceLock: boolean;
    volumeLock: boolean;
    eqEnabled: boolean;
    adcOutput: boolean;
    firFlags: number;
    firPlacement: 0 | 1;
  }[];
  eqBanks: {
    preset: number;
    sha256: string;
    bands?: Pick<Filter, 'kind' | 'enabled' | 'frequency' | 'q' | 'gain'>[];
    reason?: string;
  }[];
  iirBanks: { preset: number; sha256: string }[];
  firBanks: {
    preset: number;
    flags: number;
    placement: 0 | 1;
    filenames: { address: number; name: string }[];
    sectors: { address: number; sha256: string }[];
  }[];
}
export interface DeviceCloneSnapshot {
  phase: 'idle' | 'loading' | 'ready' | 'busy' | 'error';
  busy: boolean;
  revision: number;
  roles: Record<
    Slot,
    { connected: boolean; identity?: DeviceCloneBinding['identity']; overrides?: CloneOverrides }
  >;
  activeReview?: DeviceCloneReview;
  /** New operation outcome shared by UI and MCP. Read-only history hydration does not select it. */
  latestOutcome?: { record: CloneJournalRecord; persistence: 'verified' | 'unavailable' };
  records: CloneJournalRecord[];
  error?: string;
}
export interface DeviceCloneControllerOptions {
  binding(slot: Slot): DeviceCloneBinding | undefined;
  design(slot: Slot): DeviceCloneDesign;
  operate<T>(label: string, work: () => Promise<T>): Promise<T>;
  replaceTemplates?(
    entries: readonly { slot: Slot; template: NativeCloneTemplate }[],
    expectedDocumentRevision: number,
  ): void;
  storage?: DeviceCloneStorage;
  withLock?<T>(name: string, work: () => Promise<T>): Promise<T>;
  now?: () => number;
  id?: () => string;
}
export interface DeviceCloneController {
  getSnapshot(): Readonly<DeviceCloneSnapshot>;
  subscribe(listener: () => void): () => void;
  hydrate(context: ToolExecutionContext): Promise<void>;
  /** Cached only: no USB or storage I/O. */
  status(context: ToolExecutionContext): Readonly<DeviceCloneSnapshot>;
  /** Explicit read-only hardware capture, then one fenced workspace metadata edit. */
  reload(
    target: DeviceCloneTarget,
    context: ToolExecutionContext,
  ): Promise<Readonly<DeviceCloneSnapshot>>;
  editOverrides(
    target: DeviceCloneTarget,
    context: ToolExecutionContext,
    input: { expectedRevision: number; overrides: CloneOverrides },
  ): Readonly<DeviceCloneSnapshot>;
  review(
    target: DeviceCloneTarget,
    context: ToolExecutionContext,
    input: { expectedRevision: number },
  ): Promise<DeviceCloneReview>;
  apply(
    reviewId: string,
    context: ToolExecutionContext,
    confirmation: { confirm: true },
  ): Promise<CloneJournalRecord>;
  discard(reviewId: string, context: ToolExecutionContext): void;
  exportRecord(recordId: string, context: ToolExecutionContext): DeviceCloneRecordExport;
  refreshBindings(): void;
  dispose(): void;
}
export type DeviceCloneRecordExport = CloneJournalRecord & {
  exportPersistence: 'verified' | 'unavailable';
};
export class DeviceCloneError extends Error {
  constructor(
    message: string,
    readonly result?: CloneJournalRecord,
    readonly persistence: 'verified' | 'unavailable' = 'verified',
  ) {
    super(message);
    this.name = 'DeviceCloneError';
  }
}

const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const identityOf = ({ serial, product, core, firmware }: DeviceCloneBinding['identity']) => ({
  serial,
  product,
  core,
  firmware,
});
const sameIdentity = (a: DeviceCloneBinding['identity'], b: DeviceCloneBinding['identity']) =>
  a.serial === b.serial &&
  a.product === b.product &&
  a.core === b.core &&
  a.firmware === b.firmware;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const problem = (error: unknown) =>
  (error instanceof Error ? error.message : 'Clone did not complete').slice(0, 1024);
const hash = (value: unknown) =>
  new Sha256().update(new TextEncoder().encode(JSON.stringify(value))).digest();
const targets = (target: DeviceCloneTarget): Slot[] => {
  if (!['left', 'right', 'both'].includes(target))
    throw new DeviceCloneError('Invalid Clone target');
  return target === 'both' ? ['left', 'right'] : [target];
};
const overrideFor = (project: Project): CloneOverrides => {
  const t = nativeCloneTemplateSchema.parse(project.hfdCloneTemplate);
  return {
    mode: t.settings.options & 4 ? 'slave' : 'master',
    presets: t.settings.presets.map((p) => ({
      forceInput: p.forceInput,
      sourceLock: p.sourceLock,
      volumeLock: p.volumeLock,
    })),
  };
};
function checkedOverrides(value: CloneOverrides): CloneOverrides {
  if (!value || !['master', 'slave'].includes(value.mode) || value.presets?.length !== 3)
    throw new DeviceCloneError('Clone requires a mode and three preset source overrides');
  const choices = value.mode === 'master' ? CLONE_MASTER_INPUT_SOURCES : CLONE_SLAVE_INPUT_SOURCES;
  return {
    mode: value.mode,
    presets: value.presets.map((p) => {
      if (
        !p ||
        !choices.some((source) => source.id === p.forceInput) ||
        typeof p.sourceLock !== 'boolean' ||
        typeof p.volumeLock !== 'boolean'
      )
        throw new DeviceCloneError('Clone source or lock override is invalid for this mode');
      return {
        forceInput: p.forceInput,
        sourceLock: value.mode === 'slave' && p.sourceLock,
        volumeLock: value.mode === 'slave' && p.volumeLock,
      };
    }),
  };
}
const reserve = async <T>(sessions: PanelSession[], work: () => Promise<T>): Promise<T> => {
  const ordered = [...sessions].sort((a, b) => a.lockOrder - b.lockOrder);
  const enter = (n: number): Promise<T> =>
    n === ordered.length ? work() : ordered[n].exclusive(() => enter(n + 1));
  return enter(0);
};
async function browserLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks)
    throw new DeviceCloneError('Clone requires browser Web Locks');
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
    if (!lock) throw new DeviceCloneError('Another browser tab is operating Clone');
    return work();
  });
}
function assertProjection(before: CloneTargetSnapshot, actual: CloneTargetSnapshot, full: boolean) {
  const mask = deviceDefaultsStatusMask();
  if (
    !sameIdentity(before.identity, actual.identity) ||
    before.configuration.some((v, i) => v !== actual.configuration[i]) ||
    before.deviceConfiguration.some((v, i) => i > 1 && v !== actual.deviceConfiguration[i]) ||
    before.status.some((v, i) => ((v ^ actual.status[i]) & mask[i]) !== 0) ||
    before.dspName.some((v, i) => i !== 1 && v !== actual.dspName[i]) ||
    hex(before.serial) !== hex(actual.serial) ||
    (full &&
      (!equal(
        before.flash.map((s) => [s.address, hex(s.bytes)]),
        actual.flash.map((s) => [s.address, hex(s.bytes)]),
      ) ||
        !equal(
          before.filenames.map((s) => [s.address, hex(s.bytes)]),
          actual.filenames.map((s) => [s.address, hex(s.bytes)]),
        )))
  )
    throw new DeviceCloneError(
      'Clone target settings, identity or saved bytes changed; review again',
    );
}

const labelBytes = (bytes: Uint8Array) =>
  Array.from(bytes)
    .slice(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0))
    .map((byte) =>
      byte >= 32 && byte <= 126
        ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).padStart(2, '0')}`,
    )
    .join('');
function assertExecutablePlan(plan: DeviceClonePlan) {
  const reportMatches = (
    report: DeviceClonePlan['reports'][number],
    saved: { requestHex: string; expectedHex: string; maskHex: string },
  ) =>
    hex(report.request) === saved.requestHex &&
    hex(report.verification.expected) === saved.expectedHex &&
    hex(report.verification.mask) === saved.maskHex;
  if (
    plan.reports.length !== 4 ||
    plan.presetActivations.length !== 3 ||
    plan.presets.length !== 3 ||
    plan.reports.some(
      (report, index) =>
        report.id !== plan.desired.reports[index].id ||
        !reportMatches(report, plan.desired.reports[index]),
    ) ||
    plan.presetActivations.some(
      (report, index) => !reportMatches(report, plan.desired.presetActivations[index]),
    ) ||
    hex(plan.dspNameRequest) !== plan.desired.dspNameHex
  )
    throw new DeviceCloneError('Clone executable reports differ from the immutable recovery plan');
  for (const [index, preset] of plan.presets.entries()) {
    const sameImage = (
      image: { address: number; bytes: Uint8Array },
      saved: readonly CloneMemoryImage[],
    ) => saved.some((s) => s.address === image.address && s.hex === hex(image.bytes));
    if (
      preset.preset !== index + 1 ||
      preset.iir.address !== 0x22000 + index * 4096 ||
      preset.eq.address !== 0x25000 + index * 4096 ||
      !sameImage(preset.iir, plan.desired.flash) ||
      !sameImage(preset.eq, plan.desired.flash) ||
      preset.fir.sectors.some(
        (s) =>
          s.address < 0x10000 + index * 0x6000 ||
          s.address >= 0x16000 + index * 0x6000 ||
          !sameImage(s, plan.desired.flash),
      ) ||
      preset.fir.filenames.some(
        (s) =>
          s.address < 0x200 + index * 0x80 ||
          s.address >= 0x280 + index * 0x80 ||
          !sameImage(s, plan.desired.filenames),
      )
    )
      throw new DeviceCloneError(
        'Clone executable memory images differ from the immutable recovery plan',
      );
  }
}
function summarize(
  status: Uint8Array,
  configuration: Uint8Array,
  device: Uint8Array,
  dspName: string,
  flash: readonly CloneMemoryImage[],
  filenames: readonly CloneMemoryImage[],
): DeviceCloneSummary {
  const decoded = decodeStatus(status),
    presetSettings = [0, 1, 2].map((i) => ({
      source: status[12 + i] & 15,
      sourceLock: !!(status[12 + i] & 128),
      volumeLock: !!(status[12 + i] & 32),
      eqEnabled: !!(status[12 + i] & 16),
      adcOutput: !!(status[12 + i] & 64),
      firFlags: status[28 + i],
      firPlacement: ((status[31] >> i) & 1) as 0 | 1,
    }));
  return {
    dspName,
    preset: decoded.preset,
    volume: decoded.volume,
    muted: decoded.muted,
    channelMutes: decoded.channelMutes.slice(),
    settings: settings(decoded),
    hardware: decodeHardwareOverview(configuration, device),
    limiter: decodeLimiter(device).channels.map((channel) => ({
      ...channel,
      attackMs: Number.isFinite(channel.attackMs) ? channel.attackMs : null,
      releaseMs: Number.isFinite(channel.releaseMs) ? channel.releaseMs : null,
    })),
    presets: presetSettings,
    eqBanks: [0, 1, 2].map((i) => {
      const sector = flash.find((s) => s.address === 0x25000 + i * 4096)!;
      const bytes = unhex(sector.hex),
        raw = bytes.slice(0, 256),
        result = { preset: i + 1, sha256: sector.sha256 };
      if (raw.every((n) => n === 0) || raw.every((n) => n === 255))
        return { ...result, reason: 'Uninitialized native EQ page; original bytes are retained.' };
      try {
        return {
          ...result,
          bands: decodeEq(bytes).map(({ kind, enabled, frequency, q, gain }) => ({
            kind,
            enabled,
            frequency,
            q,
            gain,
          })),
        };
      } catch (error) {
        return { ...result, reason: problem(error) };
      }
    }),
    iirBanks: [0, 1, 2].map((i) => ({
      preset: i + 1,
      sha256: flash.find((s) => s.address === 0x22000 + i * 4096)!.sha256,
    })),
    firBanks: [0, 1, 2].map((i) => ({
      preset: i + 1,
      flags: presetSettings[i].firFlags,
      placement: presetSettings[i].firPlacement,
      filenames: filenames
        .filter((s) => s.address >= 0x200 + i * 0x80 && s.address < 0x280 + i * 0x80)
        .map((s) => ({ address: s.address, name: labelBytes(unhex(s.hex)) })),
      sectors: flash
        .filter((s) => s.address >= 0x10000 + i * 0x6000 && s.address < 0x16000 + i * 0x6000)
        .map(({ address, sha256 }) => ({ address, sha256 })),
    })),
  };
}

/** Public results deliberately exclude recovery bytes and executable reports. */
export function deviceCloneRecordSummary(r: CloneJournalRecord) {
  return freeze({
    id: r.id,
    target: r.target,
    phase: r.phase,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    documentRevision: r.documentRevision,
    templateRevision: r.templateRevision,
    overrideRevision: r.overrideRevision,
    roles: r.roles.map(
      ({
        slot,
        identity,
        documentRevision,
        templateRevision,
        overrides,
        preflight,
        lastConfirmedMuted,
        steps,
        error,
      }) => ({
        slot,
        identity,
        documentRevision,
        templateRevision,
        overrides,
        preflight,
        lastConfirmedMuted,
        steps,
        error,
      }),
    ),
    error: r.error,
  });
}
/** Cached, bounded status page. This performs no storage or device I/O. */
export function deviceCloneSnapshotPage(
  snapshot: Readonly<DeviceCloneSnapshot>,
  offset = 0,
  limit = 10,
) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new DeviceCloneError('Invalid Clone history page');
  const totalRecords = snapshot.records.length,
    next = offset + limit;
  return freeze({
    ...snapshot,
    latestOutcome: snapshot.latestOutcome
      ? {
          record: deviceCloneRecordSummary(snapshot.latestOutcome.record),
          persistence: snapshot.latestOutcome.persistence,
        }
      : undefined,
    totalRecords,
    offset,
    nextOffset: next < totalRecords ? next : null,
    records: snapshot.records.slice(offset, next).map(deviceCloneRecordSummary),
  });
}

/** Commercial module9 only. Reviews are ephemeral; consumed durable journals are
 * never resumed automatically. Protected Clone is a browser-unlocked-only scope,
 * not a claim that the native Clone menu has that same permission policy. */
export function createDeviceCloneController(
  options: DeviceCloneControllerOptions,
): DeviceCloneController {
  const storage = options.storage ?? createDeviceCloneStorage(),
    now = options.now ?? Date.now,
    nextId = options.id ?? (() => crypto.randomUUID()),
    withLock = options.withLock ?? browserLock,
    listeners = new Set<() => void>(),
    runtimeResults = new Map<string, { owner: string; record: CloneJournalRecord }>();
  const observedSessions: Partial<Record<Slot, PanelSession>> = {};
  type Capture = {
    slot: Slot;
    binding: DeviceCloneBinding;
    design: DeviceCloneDesign;
    sourceProject: Project;
    overrides: CloneOverrides;
    before: CloneTargetSnapshot;
    plan: DeviceClonePlan;
  };
  let envelope: CloneJournalEnvelope = { version: 1, revision: 0, records: [] },
    loaded = false,
    owner: string | undefined,
    flight = false,
    disposed = false,
    epoch = 0,
    pending:
      | {
          owner: string;
          scope: string;
          review: DeviceCloneReview;
          captures: Capture[];
          designSha256: string;
          templateSha256: string;
        }
      | undefined,
    writes: Promise<unknown> = Promise.resolve(),
    snapshot: Readonly<DeviceCloneSnapshot> = freeze({
      phase: 'idle',
      busy: false,
      revision: 0,
      roles: { left: { connected: false }, right: { connected: false } },
      records: [],
    });
  const actor = (ctx: ToolExecutionContext) => {
    const value = parseExecutionPrincipal({ owner: ctx?.owner, scope: ctx?.scope });
    if (!/^workspace:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value.owner))
      throw new DeviceCloneError('Clone requires trusted workspace admission');
    if (disposed) throw new DeviceCloneError('Clone is disposed');
    if (owner && owner !== value.owner)
      throw new DeviceCloneError('Clone state belongs to another workspace');
    owner ??= value.owner;
    return value;
  };
  const publish = (patch: Partial<DeviceCloneSnapshot> = {}) => {
    if (disposed) return;
    snapshot = freeze({
      ...snapshot,
      busy: flight,
      activeReview: pending?.review,
      records: structuredClone(envelope.records.filter((r) => r.owner === owner)),
      ...patch,
    });
    listeners.forEach((fn) => {
      try {
        fn();
      } catch {
        /* Views cannot interrupt programming. */
      }
    });
  };
  const refreshBindings = () => {
    if (disposed) return;
    let changed = false;
    let clearOutcome = false;
    const roles = { ...snapshot.roles };
    for (const slot of ['left', 'right'] as const) {
      const b = options.binding(slot),
        role = roles[slot];
      if (
        b?.session !== observedSessions[slot] ||
        !!b !== role.connected ||
        (b && (!role.identity || !sameIdentity(b.identity, role.identity)))
      ) {
        changed = true;
        if (snapshot.latestOutcome?.record.roles.some((recordRole) => recordRole.slot === slot))
          clearOutcome = true;
        observedSessions[slot] = b?.session;
        roles[slot] = b
          ? { connected: true, identity: identityOf(b.identity) }
          : { connected: false };
      }
    }
    if (pending?.captures.some((c) => !current(c))) {
      pending = undefined;
      changed = true;
    }
    if (changed)
      publish({
        roles,
        revision: snapshot.revision + 1,
        ...(clearOutcome ? { latestOutcome: undefined } : {}),
      });
  };
  const outcome = (record: CloneJournalRecord, persistence: 'verified' | 'unavailable') => {
    if (!disposed && record.owner === owner)
      publish({ latestOutcome: { record: freeze(structuredClone(record)), persistence } });
  };
  const current = (c: Pick<Capture, 'slot' | 'binding' | 'design' | 'sourceProject'>) => {
    const b = options.binding(c.slot),
      d = options.design(c.slot);
    return (
      !disposed &&
      !!b &&
      b.session === c.binding.session &&
      sameIdentity(b.identity, c.binding.identity) &&
      d.project === c.sourceProject &&
      d.documentRevision === c.design.documentRevision &&
      d.templateRevision === c.design.templateRevision
    );
  };
  const assertCurrent = (c: Pick<Capture, 'slot' | 'binding' | 'design' | 'sourceProject'>) => {
    if (!current(c))
      throw new DeviceCloneError('Clone role, session or source design changed; review again');
  };
  const read = async () => {
    const beforeEpoch = epoch,
      value = await storage.read();
    if (disposed || beforeEpoch !== epoch)
      throw new DeviceCloneError('Clone context changed during storage read');
    envelope = value;
    loaded = true;
  };
  const mutate = (fn: (value: CloneJournalEnvelope) => void) => {
    const work = writes.then(async () => {
      const fresh = await storage.read(),
        next = structuredClone(fresh);
      fn(next);
      next.revision++;
      const proposed = parseDeviceCloneEnvelope(next);
      await storage.compareAndSwap(fresh.revision, proposed);
      const verified = await storage.read();
      if (!equal(proposed, verified))
        throw new DeviceCloneError('Clone durable journal readback mismatch');
      envelope = verified;
      publish();
    });
    writes = work.catch(() => {});
    return work;
  };
  const savedRecord = (id: string) => {
    const r = envelope.records.find((r) => r.id === id && r.owner === owner);
    if (!r) throw new DeviceCloneError('Clone journal is unavailable');
    return r;
  };
  const setRecord = (id: string, fn: (value: CloneJournalRecord) => void) =>
    mutate((value) => {
      const r = value.records.find((r) => r.id === id && r.owner === owner);
      if (!r) throw new DeviceCloneError('Clone journal is unavailable');
      fn(r);
      r.updatedAt = now();
    });
  const replay = (record: CloneJournalRecord) => {
    const copy = freeze(structuredClone(record));
    if (record.phase === 'complete') return copy;
    throw new DeviceCloneError(
      'This Clone request was already consumed; inspect its recovery record. No setter was retried.',
      copy,
    );
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async hydrate(ctx) {
      actor(ctx);
      if (flight) throw new DeviceCloneError('A Clone operation is running');
      flight = true;
      publish({ phase: 'loading', error: undefined });
      try {
        await read();
        refreshBindings();
        publish({ phase: 'ready' });
      } catch (e) {
        publish({ phase: 'error', error: problem(e) });
        throw new DeviceCloneError(problem(e));
      } finally {
        flight = false;
        publish();
      }
    },
    status(ctx) {
      actor(ctx);
      return snapshot;
    },
    async reload(target, ctx) {
      actor(ctx);
      if (flight) throw new DeviceCloneError('A Clone operation is running');
      if (!options.replaceTemplates)
        throw new DeviceCloneError('This workspace cannot replace captured Clone metadata');
      const sources = targets(target).map((slot) => {
        const binding = options.binding(slot),
          design = options.design(slot);
        if (!binding) throw new DeviceCloneError(`${slot} amplifier is disconnected`);
        return {
          slot,
          binding: { session: binding.session, identity: identityOf(binding.identity) },
          design,
          sourceProject: design.project,
        };
      });
      if (
        new Set(sources.map((c) => c.binding.session)).size !== sources.length ||
        new Set(sources.map((c) => c.binding.identity.serial)).size !== sources.length
      )
        throw new DeviceCloneError('Reload requires distinct physical amplifiers');
      if (new Set(sources.map((c) => c.design.documentRevision)).size !== 1)
        throw new DeviceCloneError(
          'Reload requires one captured workspace revision for every target',
        );
      flight = true;
      epoch++;
      pending = undefined;
      publish({ phase: 'busy', error: undefined });
      try {
        ctx.signal?.throwIfAborted();
        const entries = await options.operate('Reading native Clone metadata', () =>
          reserve(
            sources.map((c) => c.binding.session),
            async () => {
              const results = await Promise.allSettled(
                sources.map(async (c) => {
                  assertCurrent(c);
                  const raw = await c.binding.session.captureCloneTemplateInternal(
                    c.binding.identity,
                  );
                  assertCurrent(c);
                  return {
                    slot: c.slot,
                    template: captureNativeCloneTemplate(raw, new Date(now()).toISOString()),
                  };
                }),
              );
              const failed = results.find((r) => r.status === 'rejected');
              if (failed?.status === 'rejected') throw failed.reason;
              return results.map(
                (r) =>
                  (r as PromiseFulfilledResult<{ slot: Slot; template: NativeCloneTemplate }>)
                    .value,
              );
            },
          ),
        );
        ctx.signal?.throwIfAborted();
        sources.forEach(assertCurrent);
        // One synchronous callback is essential: two role callbacks could
        // advance the workspace revision after the first and partially apply.
        options.replaceTemplates(
          entries.map((entry) => structuredClone(entry)),
          sources[0].design.documentRevision,
        );
        const roles = { ...snapshot.roles };
        for (const source of sources)
          roles[source.slot] = { ...roles[source.slot], overrides: undefined };
        publish({ roles, revision: snapshot.revision + 1, phase: 'ready' });
      } catch (error) {
        publish({ phase: 'error', error: problem(error) });
        throw new DeviceCloneError(problem(error));
      } finally {
        flight = false;
        publish();
      }
      return snapshot;
    },
    editOverrides(target, ctx, input) {
      actor(ctx);
      if (flight || input.expectedRevision !== snapshot.revision)
        throw new DeviceCloneError('Clone is busy or its revision changed');
      const overrides = checkedOverrides(structuredClone(input.overrides)),
        roles = { ...snapshot.roles };
      for (const slot of targets(target))
        roles[slot] = { ...roles[slot], overrides: structuredClone(overrides) };
      pending = undefined;
      epoch++;
      publish({ roles, revision: snapshot.revision + 1, error: undefined });
      return snapshot;
    },
    async review(target, ctx, input) {
      const principal = actor(ctx),
        slots = targets(target);
      if (flight || input.expectedRevision !== snapshot.revision)
        throw new DeviceCloneError('Clone is busy or its revision changed');
      const sources = slots.map((slot) => {
        const b = options.binding(slot),
          d = options.design(slot);
        if (!b) throw new DeviceCloneError(`${slot} amplifier is disconnected`);
        nativeCloneTemplateSchema.parse(d.project.hfdCloneTemplate);
        return {
          slot,
          binding: { session: b.session, identity: identityOf(b.identity) },
          design: { ...d, project: structuredClone(d.project) },
          sourceProject: d.project,
          overrides: checkedOverrides(snapshot.roles[slot].overrides ?? overrideFor(d.project)),
        };
      });
      if (
        new Set(sources.map((c) => c.binding.session)).size !== sources.length ||
        new Set(sources.map((c) => c.binding.identity.serial)).size !== sources.length
      )
        throw new DeviceCloneError('Clone requires distinct physical amplifiers');
      flight = true;
      epoch++;
      pending = undefined;
      publish({ phase: 'busy', error: undefined, latestOutcome: undefined });
      try {
        if (!loaded) await read();
        ctx.signal?.throwIfAborted();
        const captures = await options.operate('Reviewing amplifier Clone', () =>
          reserve(
            sources.map((c) => c.binding.session),
            async () => {
              const result = await Promise.allSettled(
                sources.map(async (c) => {
                  const before = await c.binding.session.captureCloneInternal(c.binding.identity),
                    plan = await buildClonePlan(
                      c.design.project,
                      c.design.project.hfdCloneTemplate!,
                      before,
                      c.overrides,
                    ),
                    capture = { ...c, before, plan };
                  assertExecutablePlan(plan);
                  assertCurrent(capture);
                  return capture;
                }),
              );
              const failure = result.find((item) => item.status === 'rejected');
              if (failure?.status === 'rejected') throw failure.reason;
              return result.map((item) => (item as PromiseFulfilledResult<Capture>).value);
            },
          ),
        );
        ctx.signal?.throwIfAborted();
        captures.forEach(assertCurrent);
        const review: DeviceCloneReview = freeze({
          id: nextId(),
          target,
          revision: snapshot.revision,
          createdAt: now(),
          roles: captures.map((c) => ({
            slot: c.slot,
            identity: c.binding.identity,
            projectName: c.design.project.name,
            templateProvenance: {
              kind: c.design.project.hfdCloneTemplate!.provenance.kind,
              sourceSerial: c.design.project.hfdCloneTemplate!.provenance.sourceSerial,
              capturedAt: c.design.project.hfdCloneTemplate!.provenance.capturedAt,
            },
            documentRevision: c.design.documentRevision,
            templateRevision: c.design.templateRevision,
            overrides: c.overrides,
            before: summarize(
              c.before.status,
              c.before.configuration,
              c.before.deviceConfiguration,
              labelBytes(c.before.dspName.slice(2)),
              c.plan.before.flash,
              c.plan.before.filenames,
            ),
            after: summarize(
              c.plan.presetActivations[2].request,
              c.before.configuration,
              c.plan.reports.find((report) => report.id === 'configuration')!.request,
              c.plan.dspName,
              c.plan.desired.flash,
              c.plan.desired.filenames,
            ),
            steps: [...CLONE_PHASES],
            warnings: [
              ...c.plan.warnings,
              'Commercial module9 only; browser policy requires an unlocked target.',
              'Outputs remain muted at -96 dB. Native acceptance requires a power cycle before audio.',
            ],
          })),
        });
        pending = {
          owner: principal.owner,
          scope: principal.scope,
          review,
          captures,
          designSha256: hash(captures.map((c) => c.design.project)),
          templateSha256: hash(captures.map((c) => c.design.project.hfdCloneTemplate)),
        };
        publish({ phase: 'ready' });
        return review;
      } catch (e) {
        publish({ phase: 'error', error: problem(e) });
        throw new DeviceCloneError(problem(e));
      } finally {
        flight = false;
        publish();
      }
    },
    async apply(id, ctx, confirmation) {
      const principal = actor(ctx);
      if (confirmation?.confirm !== true)
        throw new DeviceCloneError('Explicitly confirm the reviewed Clone');
      const old = envelope.records.find((r) => r.id === id);
      if (old) {
        if (old.owner !== principal.owner)
          throw new DeviceCloneError('Clone record belongs to another workspace');
        return replay(old);
      }
      if (runtimeResults.size >= MAX_DEVICE_CLONE_RECORDS && !runtimeResults.has(id))
        throw new DeviceCloneError(
          'Clone runtime recovery capacity is full; existing uncertain outcomes were retained',
        );
      if (flight || !pending || pending.owner !== principal.owner || pending.review.id !== id)
        throw new DeviceCloneError(
          'Clone review is missing, stale or belongs to another workspace',
        );
      const captured = pending;
      pending = undefined;
      flight = true;
      epoch++;
      publish({ phase: 'busy', error: undefined, latestOutcome: undefined });
      let journal: CloneJournalRecord | undefined,
        runtime: CloneJournalRecord | undefined,
        durable = false;
      const persist = async (fn: (value: CloneJournalRecord) => void) => {
        if (runtime) {
          fn(runtime);
          runtime.updatedAt = now();
        }
        // Retain every synchronously observed send even if its first journal
        // update failed. A later terminal update must never turn that known
        // send into a successful "blocked before send" persistence record.
        await setRecord(id, (record) => {
          if (!runtime) throw new DeviceCloneError('Clone runtime ledger is unavailable');
          Object.assign(record, structuredClone(runtime));
        });
      };
      try {
        return await options.operate('Cloning amplifier settings and filter banks', () =>
          withLock('fusion-studio-device-clone', () =>
            reserve(
              captured.captures.map((c) => c.binding.session),
              async () => {
                const freshEnvelope = await storage.read();
                envelope = freshEnvelope;
                const duplicate = freshEnvelope.records.find((r) => r.id === id);
                if (duplicate) {
                  if (duplicate.owner !== principal.owner)
                    throw new DeviceCloneError('Clone request belongs to another workspace');
                  return replay(duplicate);
                }
                const serials = captured.captures.map((c) => c.binding.identity.serial);
                const knownRecords = new Map(
                  freshEnvelope.records.map((record) => [record.id, record]),
                );
                for (const [key, value] of runtimeResults) knownRecords.set(key, value.record);
                if (
                  [...knownRecords.values()].some(
                    (r) =>
                      ['prepared', 'running', 'partial'].includes(r.phase) &&
                      r.roles.some((role) => serials.includes(role.identity.serial)),
                  )
                )
                  throw new DeviceCloneError(
                    'An unfinished Clone journal requires inspection and explicit recovery before another Clone',
                  );
                ctx.signal?.throwIfAborted();
                const preflight = await Promise.allSettled(
                  captured.captures.map(async (c) => {
                    assertCurrent(c);
                    const actual = await c.binding.session.captureCloneInternal(c.binding.identity);
                    assertCurrent(c);
                    assertProjection(c.before, actual, true);
                  }),
                );
                const preflightFailure = preflight.find((item) => item.status === 'rejected');
                if (preflightFailure?.status === 'rejected') throw preflightFailure.reason;
                ctx.signal?.throwIfAborted();
                journal = {
                  id,
                  owner: principal.owner,
                  scope: captured.scope,
                  appliedScope: principal.scope,
                  target: captured.review.target,
                  templateSha256: captured.templateSha256,
                  designSha256: captured.designSha256,
                  documentRevision: Math.max(
                    ...captured.captures.map((c) => c.design.documentRevision),
                  ),
                  templateRevision: Math.max(
                    ...captured.captures.map((c) => c.design.templateRevision),
                  ),
                  overrideRevision: captured.review.revision,
                  createdAt: captured.review.createdAt,
                  updatedAt: now(),
                  phase: 'prepared',
                  roles: captured.captures.map((c) => ({
                    slot: c.slot,
                    identity: c.binding.identity,
                    documentRevision: c.design.documentRevision,
                    templateRevision: c.design.templateRevision,
                    overrides: c.overrides,
                    before: c.plan.before,
                    desired: c.plan.desired,
                    preflight: 'verified',
                    lastConfirmedMuted: !!(c.before.status[6] & 128),
                    steps: CLONE_PHASES.map((phase) => ({
                      id: phase,
                      attempted: false,
                      state: phase === 'product-configuration' ? 'skipped' : 'pending',
                    })),
                  })),
                };
                runtime = structuredClone(journal);
                await mutate((value) => value.records.push(structuredClone(journal!)));
                durable = true;
                await persist((r) => {
                  r.phase = 'running';
                });
                let hardwareStarted = false;
                const expected = captured.captures.map((c) => structuredClone(c.before)),
                  ready = new Set<number>();
                let release!: () => void, reject!: (error: unknown) => void;
                const barrier = new Promise<void>((resolve, fail) => {
                  release = resolve;
                  reject = fail;
                });
                void barrier.catch(() => {});
                const run = async (index: number, phase: (typeof CLONE_PHASES)[number]) => {
                  const c = captured.captures[index],
                    stepIndex = CLONE_PHASES.indexOf(phase);
                  let attempted = false,
                    intent = false,
                    staging = false;
                  try {
                    await c.binding.session.withCloneMutationScopeInternal(
                      {
                        beforeRequest: async (request) => {
                          assertCurrent(c);
                          if (!intent) {
                            await persist((r) => {
                              r.roles[index].steps[stepIndex].state = 'ready';
                            });
                            intent = true;
                          }
                          // 64/00 starts a device-side page/EEPROM transaction.
                          // Native sends its64/01 chunks and64/02 commit without
                          // unrelated reads; do not invent interleaving while that
                          // staging buffer may be live. The synchronous current-
                          // binding/cancellation hook still runs before every send.
                          if (staging) {
                            if (request[0] !== 0x64 || ![1, 2].includes(request[1]))
                              throw new DeviceCloneError(
                                'Unexpected command inside a Clone memory transaction',
                              );
                            return;
                          }
                          const actual = await c.binding.session.captureCloneInternal(
                            c.binding.identity,
                            false,
                          );
                          if (runtime)
                            runtime.roles[index].lastConfirmedMuted = !!(actual.status[6] & 128);
                          assertProjection(expected[index], actual, false);
                          if (phase !== 'mute' && !(actual.status[6] & 128))
                            throw new DeviceCloneError(
                              'Every Clone phase requires verified global mute',
                            );
                          if (request[0] === 0x64 && request[1] === 4) {
                            const address = request[2] | (request[3] << 8) | (request[4] << 16),
                              original = c.before.flash.find((s) => s.address === address);
                            if (
                              !original ||
                              hex(await c.binding.session.readMemoryInternal(address, 4096)) !==
                                hex(original.bytes)
                            )
                              throw new DeviceCloneError(
                                'Clone flash sector changed before erase; no unreviewed sector was overwritten',
                              );
                          }
                          if (phase === 'mute' && !ready.has(index)) {
                            ready.add(index);
                            if (ready.size === captured.captures.length) release();
                            await barrier;
                          }
                        },
                        beforeExchange: () => {
                          assertCurrent(c);
                          if (!hardwareStarted) {
                            ctx.signal?.throwIfAborted();
                            captured.captures.forEach(assertCurrent);
                          }
                          hardwareStarted = true;
                          attempted = true;
                          if (runtime) {
                            const step = runtime.roles[index].steps[stepIndex];
                            step.attempted = true;
                            step.state = 'attempted';
                          }
                        },
                        afterExchange: async (request, reply) => {
                          if (request[0] === 0x64 && request[1] === 0) staging = true;
                          if (request[0] === 0x64 && request[1] === 2) staging = false;
                          if (request[0] === 5) expected[index].status = reply.slice();
                          if (request[0] === 0x66) {
                            expected[index].deviceConfiguration = request.slice();
                            expected[index].deviceConfiguration[1] = 0;
                          }
                          if (request[0] === 3) expected[index].dspName = request.slice();
                          if (savedRecord(id).roles[index].steps[stepIndex].attempted === false)
                            await persist((r) => {
                              const s = r.roles[index].steps[stepIndex];
                              s.attempted = true;
                              s.state = 'attempted';
                            });
                        },
                      },
                      async () => {
                        if (['mute', 'settings', 'configuration', 'display'].includes(phase)) {
                          const report = c.plan.reports.find((r) => r.id === phase)!;
                          await c.binding.session.writeCloneReportInternal({
                            ...report,
                            id: phase as 'mute' | 'settings' | 'configuration' | 'display',
                          });
                        } else if (phase.startsWith('eq-') && phase !== 'eq-reload') {
                          const plan = c.plan.presets[Number(phase.slice(3)) - 1];
                          await c.binding.session.writeCloneEqInternal(
                            plan.eq.address,
                            plan.eq.bytes,
                          );
                        } else if (phase === 'eq-reload')
                          await c.binding.session.reloadCloneEqInternal();
                        else if (phase.startsWith('filters-'))
                          await c.binding.session.writeCloneFiltersInternal(
                            c.plan.presets[Number(phase.slice(8)) - 1],
                            c.plan.dspNameRequest,
                            c.plan.presetActivations[Number(phase.slice(8)) - 1],
                          );
                        else throw new DeviceCloneError('Unsupported Clone phase');
                      },
                    );
                    const final = await c.binding.session.captureCloneInternal(
                      c.binding.identity,
                      false,
                    );
                    assertCurrent(c);
                    assertProjection(expected[index], final, false);
                    const status = decodeStatus(final.status);
                    if (!status.muted) throw new DeviceCloneError('Clone mute was not retained');
                    expected[index].status = status.raw.slice();
                    await persist((r) => {
                      const role = r.roles[index];
                      role.steps[stepIndex].state = 'verified';
                      role.lastConfirmedMuted = status.muted;
                    });
                  } catch (e) {
                    if (phase === 'mute') reject(e);
                    const sent = attempted || (e instanceof DeviceCloneStepError && e.attempted);
                    await persist((r) => {
                      const role = r.roles[index],
                        step = role.steps[stepIndex];
                      step.attempted ||= sent;
                      step.state = sent ? 'unconfirmed' : 'failed';
                      step.error = problem(e);
                      role.error = problem(e);
                      const last = c.binding.session.lastStatus;
                      if (last) role.lastConfirmedMuted = last.muted;
                    }).catch(() => {});
                    throw e;
                  }
                };
                const mutes = await Promise.allSettled(
                  captured.captures.map((_, i) => run(i, 'mute')),
                );
                if (mutes.some((r) => r.status === 'rejected'))
                  throw new DeviceCloneError(
                    'Mute was not verified on all Clone targets; no filter/settings phase began',
                  );
                const results = await Promise.allSettled(
                  captured.captures.map(async (_, i) => {
                    for (const phase of CLONE_PHASES.slice(2)) await run(i, phase);
                  }),
                );
                if (results.some((r) => r.status === 'rejected'))
                  throw new DeviceCloneError(
                    'Clone was not completely verified; inspect each role and phase',
                  );
                await persist((r) => {
                  r.phase = 'complete';
                });
                const result = freeze(structuredClone(savedRecord(id)));
                outcome(result, 'verified');
                return result;
              },
            ),
          ),
        );
      } catch (e) {
        let persistence: 'verified' | 'unavailable' = 'verified';
        if (journal && durable) {
          // Recover a completed CAS whose readback delivery was lost. A local
          // in-memory completion alone never establishes durable success.
          try {
            envelope = await storage.read();
          } catch {
            persistence = 'unavailable';
          }
          const completed = envelope.records.find(
            (r) => r.id === id && r.owner === principal.owner && r.phase === 'complete',
          );
          if (completed) {
            const result = freeze(structuredClone(completed));
            outcome(result, 'verified');
            return result;
          }
          if (runtime?.phase === 'complete') runtime.phase = 'partial';
          await persist((r) => {
            if (r.phase !== 'complete') {
              r.phase = r.roles.some((role) => role.steps.some((s) => s.attempted))
                ? 'partial'
                : 'failed';
              r.error = problem(e);
            }
          }).catch(() => {
            persistence = 'unavailable';
          });
          journal = envelope.records.find((r) => r.id === id && r.owner === principal.owner);
          if (persistence === 'unavailable' && runtime) {
            journal = runtime;
            runtimeResults.set(id, {
              owner: principal.owner,
              record: freeze(structuredClone(runtime)),
            });
          }
        } else journal = undefined;
        if (journal) outcome(journal, persistence);
        publish({ phase: 'error', error: problem(e) });
        throw new DeviceCloneError(
          problem(e),
          journal ? freeze(structuredClone(journal)) : undefined,
          persistence,
        );
      } finally {
        flight = false;
        publish({ phase: snapshot.error ? 'error' : 'ready' });
      }
    },
    discard(id, ctx) {
      const principal = actor(ctx);
      if (flight || !pending || pending.owner !== principal.owner || pending.review.id !== id)
        throw new DeviceCloneError('Clone review is unavailable');
      pending = undefined;
      epoch++;
      publish();
    },
    exportRecord(id, ctx) {
      const principal = actor(ctx),
        latest = runtimeResults.get(id),
        saved = envelope.records.find(
          (record) => record.id === id && record.owner === principal.owner,
        );
      if (latest && latest.owner === principal.owner && !equal(latest.record, saved))
        return freeze({
          ...structuredClone(latest.record),
          exportPersistence: 'unavailable' as const,
        });
      if (!saved) throw new DeviceCloneError('Clone journal is unavailable');
      return freeze({ ...structuredClone(saved), exportPersistence: 'verified' as const });
    },
    refreshBindings,
    dispose() {
      disposed = true;
      epoch++;
      pending = undefined;
      runtimeResults.clear();
      listeners.clear();
      snapshot = freeze({
        phase: 'idle',
        busy: false,
        revision: snapshot.revision + 1,
        roles: { left: { connected: false }, right: { connected: false } },
        records: [],
      });
    },
  };
}
