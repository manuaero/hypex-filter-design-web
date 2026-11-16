import type { Slot } from '../domain/model';
import {
  parseFirmwareBundle,
  describeFirmwarePacketPlan,
  type FirmwareBundle,
} from '../domain/firmware';
import { lookupKnownFirmwareProfile } from '../domain/firmware-profile';
import {
  parseExecutionPrincipal,
  type ToolExecutionContext,
} from '../application/execution-context';
import {
  FIRMWARE_JOURNAL_STEPS,
  createFirmwareJournalStore,
  parseFirmwareJournalEnvelope,
  firmwareBeforeSha256,
  firmwareImageSha256,
  firmwareSourceSha256,
  MAX_FIRMWARE_EXECUTION_SOURCE_BYTES,
  type FirmwareJournalBinding,
  type FirmwareJournalBefore,
  type FirmwareJournalRecord,
  type FirmwareJournalRole,
  type FirmwareJournalSource,
  type FirmwareJournalEnvelope,
  type FirmwareJournalStore,
  type FirmwareJournalStream,
} from '../application/firmware-update-storage';
import {
  programNativeFirmware,
  FirmwareProgramError,
  type FirmwareBootloaderIdentity,
  type FirmwareProgramChannel,
  type FirmwareProgramResult,
  type FirmwareExecutionQualifier,
} from './firmware-program';

export type FirmwareUpdateTarget = Slot | 'both';
export interface FirmwareUpdateSource extends FirmwareJournalSource {
  stageId: string;
}
export interface FirmwareLoaderConnection {
  identity: FirmwareBootloaderIdentity;
  channel: FirmwareProgramChannel;
}
export interface FirmwareEntryContext {
  requestId: string;
  payload: Uint8Array;
  timeoutMs: 5000;
  beforeWireSend(): void;
}
/** Coordinator port contract shared by explicit reference fixtures and the
 * separate guarded WebHID adapter. Physical I/O requires its source-issued
 * profile; the production registry currently issues no such profile. */
export interface FirmwareReferenceUpdatePort {
  reserve<T>(
    bindings: readonly FirmwareJournalBinding[],
    work: () => Promise<T>,
    hooks?: { signal?: AbortSignal; assertCurrent?(): void },
  ): Promise<T>;
  preflightRuntime(binding: FirmwareJournalBinding): Promise<FirmwareJournalBinding>;
  captureBefore(binding: FirmwareJournalBinding): Promise<FirmwareJournalBefore>;
  enterBootloader(
    binding: FirmwareJournalBinding,
    context: FirmwareEntryContext,
  ): Promise<'sent' | 'unconfirmed' | 'not-sent'>;
  discoverBootloader(
    binding: FirmwareJournalBinding,
    recovery: boolean,
  ): Promise<FirmwareLoaderConnection>;
  discoverRuntime(
    binding: FirmwareJournalBinding,
    expectedAfter: FirmwareJournalSource['expectedAfter'],
  ): Promise<FirmwareJournalBinding>;
  captureAfter(binding: FirmwareJournalBinding): Promise<FirmwareJournalBefore>;
}
export interface FirmwareUpdateAvailability {
  available: boolean;
  qualifier: FirmwareExecutionQualifier | 'unqualified-physical';
  route: 'reference' | 'physical';
  qualified: boolean;
  reasons: readonly string[];
}
export interface FirmwarePhysicalUpdatePort extends FirmwareReferenceUpdatePort {
  availability(
    binding?: Readonly<FirmwareJournalBinding>,
    source?: Readonly<FirmwareJournalSource>,
  ): FirmwareUpdateAvailability;
}
declare const adapterBrand: unique symbol;
export interface FirmwareUpdateAdapter {
  readonly [adapterBrand]: true;
}
const adapters = new WeakMap<
  FirmwareUpdateAdapter,
  {
    port: FirmwareReferenceUpdatePort;
    qualifier: FirmwareExecutionQualifier;
    availability(
      binding?: Readonly<FirmwareJournalBinding>,
      source?: Readonly<FirmwareJournalSource>,
    ): FirmwareUpdateAvailability;
  }
>();
/** Only trusted source code can construct this reference capability. It is not
 * a serialized/tool-settable qualification and cannot enable a physical route. */
export function createReferenceFirmwareUpdateAdapter(
  port: FirmwareReferenceUpdatePort,
): FirmwareUpdateAdapter {
  if (
    !port ||
    ![
      'reserve',
      'preflightRuntime',
      'captureBefore',
      'enterBootloader',
      'discoverBootloader',
      'discoverRuntime',
      'captureAfter',
    ].every((key) => typeof port[key as keyof FirmwareReferenceUpdatePort] === 'function')
  )
    throw new Error('Invalid injected firmware update port');
  const adapter = Object.freeze({}) as FirmwareUpdateAdapter;
  adapters.set(adapter, {
    port,
    qualifier: 'reference-simulation',
    availability: () => ({
      available: true,
      qualifier: 'reference-simulation',
      route: 'reference',
      qualified: true,
      reasons: [],
    }),
  });
  return adapter;
}
/** Registers a guarded production route, not a qualification. The private port
 * must enforce its source-owned physical profile before every I/O method. */
export function createGuardedPhysicalFirmwareUpdateAdapter(
  port: FirmwarePhysicalUpdatePort,
): FirmwareUpdateAdapter {
  if (
    !port ||
    ![
      'reserve',
      'preflightRuntime',
      'captureBefore',
      'enterBootloader',
      'discoverBootloader',
      'discoverRuntime',
      'captureAfter',
      'availability',
    ].every((key) => typeof port[key as keyof FirmwarePhysicalUpdatePort] === 'function')
  )
    throw new Error('Invalid guarded physical firmware port');
  const adapter = Object.freeze({}) as FirmwareUpdateAdapter;
  adapters.set(adapter, {
    port,
    qualifier: 'qualified-physical',
    availability: (binding, source) => port.availability(binding, source),
  });
  return adapter;
}
export interface FirmwareUpdateReview {
  id: string;
  target: FirmwareUpdateTarget;
  qualifier: FirmwareExecutionQualifier;
  sourceRecordId?: string;
  roles: {
    slot: Slot;
    binding: FirmwareJournalBinding;
    source: Omit<FirmwareUpdateSource, 'text'>;
    knownImageCount: number;
    beforeSha256: string;
    gaps: string[];
    packetsPerPass: number;
  }[];
}
export interface FirmwareUpdateSnapshot {
  busy: boolean;
  availability: Readonly<Record<Slot, FirmwareUpdateAvailability>>;
  phase: 'idle' | 'ready' | 'busy' | 'error';
  activeReview?: FirmwareUpdateReview;
  records: ReturnType<typeof firmwareUpdateRecordSummary>[];
  latestOutcome?: {
    record: ReturnType<typeof firmwareUpdateRecordSummary>;
    persistence: 'verified' | 'unavailable';
  };
  error?: string;
}
export interface FirmwareUpdateOptions {
  adapter: FirmwareUpdateAdapter;
  source(slot: Slot): FirmwareUpdateSource | undefined;
  binding(slot: Slot): FirmwareJournalBinding | undefined;
  /** Remains stable during an expected USB disconnect, changes on role reassignment. */
  assignmentId(slot: Slot): string | undefined;
  /** Trusted, synchronous metadata-only adoption after validated recovery
   * eligibility. Never acquires an interface or substitutes loader correlation. */
  prepareRecovery?(
    roles: readonly Readonly<{ slot: Slot; binding: FirmwareJournalBinding }>[],
  ): void;
  journal?: FirmwareJournalStore;
  withLock?<T>(name: string, work: () => Promise<T>): Promise<T>;
  now?: () => number;
  id?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
}
export interface FirmwareUpdateCoordinator {
  getSnapshot(): Readonly<FirmwareUpdateSnapshot>;
  subscribe(listener: () => void): () => void;
  availability(target: FirmwareUpdateTarget): Readonly<FirmwareUpdateAvailability>;
  /** Trusted binding/source lifecycle hook; never performs hardware I/O. */
  invalidateReview(): void;
  hydrate(context: ToolExecutionContext): Promise<void>;
  status(context: ToolExecutionContext): Readonly<FirmwareUpdateSnapshot>;
  review(
    target: FirmwareUpdateTarget,
    context: ToolExecutionContext,
  ): Promise<FirmwareUpdateReview>;
  reviewRecovery(
    recordId: string,
    target: FirmwareUpdateTarget,
    context: ToolExecutionContext,
  ): Promise<FirmwareUpdateReview>;
  apply(
    id: string,
    context: ToolExecutionContext,
    confirmation: { confirm: true },
  ): Promise<Readonly<FirmwareJournalRecord>>;
  discard(id: string, context: ToolExecutionContext): void;
  exportRecord(
    id: string,
    context: ToolExecutionContext,
  ): FirmwareJournalRecord & { exportPersistence: 'verified' | 'unavailable' };
  dispose(): void;
}
export class FirmwareUpdateError extends Error {
  constructor(
    message: string,
    readonly result?: Readonly<FirmwareJournalRecord>,
    readonly persistence: 'verified' | 'unavailable' = 'verified',
  ) {
    super(message);
    this.name = 'FirmwareUpdateError';
  }
}
const gaps = [
  'original-pic32-program-not-captured',
  'factory-calibration-preservation-unqualified',
  'physical-bootloader-transition-replay-recovery-unqualified',
];
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const clone = <T>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const problem = (error: unknown) =>
  (error instanceof Error ? error.message : 'Firmware update did not complete').slice(0, 1024);
const slotsFor = (target: FirmwareUpdateTarget): Slot[] => {
  if (!['left', 'right', 'both'].includes(target))
    throw new FirmwareUpdateError('Choose an explicit firmware target');
  return target === 'both' ? ['left', 'right'] : [target];
};
const sameStable = (a: FirmwareJournalBinding, b: FirmwareJournalBinding) =>
  ['assignmentId', 'serial', 'hidSerial', 'family', 'product'].every(
    (key) => a[key as keyof FirmwareJournalBinding] === b[key as keyof FirmwareJournalBinding],
  );
function checkedSource(source: FirmwareUpdateSource): {
  source: FirmwareUpdateSource;
  bundle: FirmwareBundle;
} {
  const copy = clone(source);
  if (
    !copy ||
    typeof copy.stageId !== 'string' ||
    !copy.stageId ||
    new TextEncoder().encode(copy.text).length > MAX_FIRMWARE_EXECUTION_SOURCE_BYTES ||
    firmwareSourceSha256(copy.text) !== copy.sha256 ||
    copy.family !== 'FUSION32'
  )
    throw new FirmwareUpdateError('Invalid, changed or unsupported firmware execution source');
  const bundle = parseFirmwareBundle(copy.text, copy.name);
  describeFirmwarePacketPlan(bundle);
  if (bundle.family !== copy.family || !copy.expectedAfter?.core || !copy.expectedAfter.firmware)
    throw new FirmwareUpdateError(
      'Firmware execution requires explicit reference or proved content version expectations',
    );
  if (copy.expectedAfter.source === 'known-content-profile') {
    const profile = lookupKnownFirmwareProfile(copy.sha256);
    if (
      !profile ||
      profile.coreVersion !== copy.expectedAfter.core ||
      profile.bundleVersion !== copy.expectedAfter.firmware
    )
      throw new FirmwareUpdateError(
        'Expected firmware versions differ from the exact known content profile',
      );
  }
  return { source: copy, bundle };
}
function checkedBefore(input: FirmwareJournalBefore): FirmwareJournalBefore {
  const value = clone(input);
  if (
    !value ||
    value.images.length !== 43 ||
    firmwareBeforeSha256(value) !== value.sha256 ||
    value.images.some((image) => firmwareImageSha256(image.hex) !== image.sha256)
  )
    throw new FirmwareUpdateError('Firmware preservation snapshot checksum is invalid');
  value.gaps = [...new Set([...value.gaps, ...gaps])];
  value.sha256 = firmwareBeforeSha256(value);
  return value;
}
function changedImages(before: FirmwareJournalBefore, after: FirmwareJournalBefore): string[] {
  checkedBefore(after);
  return before.images
    .filter((image) => {
      const actual = after.images.find(
        (item) =>
          item.id === image.id && item.kind === image.kind && item.address === image.address,
      );
      if (!actual || actual.hex.length !== image.hex.length) return true;
      const mask = image.compareMaskHex ?? 'ff'.repeat(image.hex.length / 2);
      for (let n = 0; n < image.hex.length; n += 2)
        if (
          ((parseInt(image.hex.slice(n, n + 2), 16) ^ parseInt(actual.hex.slice(n, n + 2), 16)) &
            parseInt(mask.slice(n, n + 2), 16)) !==
          0
        )
          return true;
      return false;
    })
    .map((image) => image.id);
}
function sameBeforeProjection(
  before: FirmwareJournalBefore,
  fresh: FirmwareJournalBefore,
): boolean {
  const manifest = (value: FirmwareJournalBefore) =>
    value.images.map(({ id, kind, address, compareMaskHex }) => ({
      id,
      kind,
      address,
      compareMaskHex,
    }));
  return (
    same(manifest(before), manifest(fresh)) &&
    same(before.gaps, fresh.gaps) &&
    changedImages(before, fresh).length === 0
  );
}
export function firmwareUpdateRecordSummary(record: FirmwareJournalRecord) {
  return freeze({
    id: record.id,
    target: record.target,
    qualifier: record.qualifier,
    sourceRecordId: record.sourceRecordId,
    phase: record.phase,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    error: record.error,
    roles: record.roles.map(({ slot, binding, source, before, steps, stream, after, error }) => ({
      slot,
      binding,
      source: {
        name: source.name,
        sha256: source.sha256,
        family: source.family,
        expectedAfter: source.expectedAfter,
      },
      before: { sha256: before.sha256, knownImageCount: before.images.length, gaps: before.gaps },
      steps,
      stream,
      after,
      error,
    })),
  });
}
async function browserLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks)
    throw new FirmwareUpdateError('Firmware execution requires a browser-global update lock');
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
    if (!lock) throw new FirmwareUpdateError('Another firmware operation holds the global lock');
    return work();
  });
}
let activeUpdate: object | undefined;

/** Shared journaled workflow. Reference and guarded physical routes are
 * separately registered; unavailable physical profiles permit cached history
 * but refuse review/execution before hardware acquisition. */
export function createFirmwareUpdateCoordinator(
  options: FirmwareUpdateOptions,
): FirmwareUpdateCoordinator {
  const registered = adapters.get(options.adapter),
    port = registered?.port;
  if (!registered || !port)
    throw new FirmwareUpdateError(
      'Firmware adapter is unqualified; no production writer is enabled',
    );
  const registration = registered,
    qualifier = registration.qualifier;
  const availability = (target: FirmwareUpdateTarget): Readonly<FirmwareUpdateAvailability> => {
    const reasons: string[] = [];
    for (const slot of slotsFor(target)) {
      try {
        const value = registration.availability(options.binding(slot), options.source(slot));
        if (!value.available) reasons.push(...value.reasons.map((reason) => `${slot}: ${reason}`));
      } catch (error) {
        reasons.push(`${slot}: ${problem(error)}`);
      }
    }
    const available = reasons.length === 0;
    return freeze({
      available,
      qualifier:
        qualifier === 'qualified-physical' && !available ? 'unqualified-physical' : qualifier,
      route: qualifier === 'reference-simulation' ? 'reference' : 'physical',
      qualified: qualifier === 'reference-simulation' || available,
      reasons,
    });
  };
  const roleAvailability = () => ({ left: availability('left'), right: availability('right') });
  const journal = options.journal ?? createFirmwareJournalStore(),
    withLock = options.withLock ?? browserLock,
    now = options.now ?? Date.now,
    nextId = options.id ?? (() => crypto.randomUUID()),
    listeners = new Set<() => void>(),
    overlays = new Map<string, FirmwareJournalRecord>();
  type Capture = {
    slot: Slot;
    binding: FirmwareJournalBinding;
    source: FirmwareUpdateSource;
    bundle: FirmwareBundle;
    before: FirmwareJournalBefore;
    recovery: boolean;
    invalidation: number;
  };
  let envelope: FirmwareJournalEnvelope = { version: 1, revision: 0, records: [] },
    loaded = false,
    owner: string | undefined,
    flight = false,
    disposed = false,
    epoch = 0,
    invalidation = 0,
    pending:
      | { owner: string; scope: string; review: FirmwareUpdateReview; captures: Capture[] }
      | undefined,
    writes: Promise<unknown> = Promise.resolve(),
    snapshot: Readonly<FirmwareUpdateSnapshot> = freeze({
      busy: false,
      availability: roleAvailability(),
      phase: 'idle',
      records: [],
    });
  const actor = (context: ToolExecutionContext) => {
    const value = parseExecutionPrincipal({ owner: context?.owner, scope: context?.scope });
    if (
      !/^workspace:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value.owner) ||
      disposed ||
      (owner && owner !== value.owner)
    )
      throw new FirmwareUpdateError('Firmware requires the current trusted workspace');
    owner ??= value.owner;
    return value;
  };
  const publish = (patch: Partial<FirmwareUpdateSnapshot> = {}) => {
    if (disposed) return;
    snapshot = freeze({
      ...snapshot,
      busy: flight,
      availability: roleAvailability(),
      activeReview: pending?.review,
      records: envelope.records.filter((r) => r.owner === owner).map(firmwareUpdateRecordSummary),
      ...patch,
    });
    listeners.forEach((fn) => {
      try {
        fn();
      } catch {
        /* View-only observer. */
      }
    });
  };
  const current = (capture: Capture) => {
    if (
      disposed ||
      capture.invalidation !== invalidation ||
      options.assignmentId(capture.slot) !== capture.binding.assignmentId ||
      (!capture.recovery && options.source(capture.slot)?.stageId !== capture.source.stageId)
    )
      throw new FirmwareUpdateError('Firmware role assignment or source changed');
  };
  const mutate = (fn: (value: FirmwareJournalEnvelope) => void) => {
    const work = writes.then(async () => {
      const old = await journal.read(),
        next = clone(old);
      fn(next);
      next.revision++;
      const proposed = parseFirmwareJournalEnvelope(next);
      await journal.compareAndSwap(old.revision, proposed);
      const verified = await journal.read();
      if (!same(proposed, verified))
        throw new FirmwareUpdateError('Firmware journal verified readback failed');
      envelope = verified;
      publish();
    });
    writes = work.catch(() => {});
    return work;
  };
  const record = (id: string) => {
    const value = envelope.records.find((r) => r.id === id && r.owner === owner);
    if (!value) throw new FirmwareUpdateError('Firmware record is unavailable');
    return value;
  };
  const outcome = (value: FirmwareJournalRecord, persistence: 'verified' | 'unavailable') =>
    publish({ latestOutcome: { record: firmwareUpdateRecordSummary(value), persistence } });
  const replay = (value: FirmwareJournalRecord) => {
    const known = overlays.get(value.id) ?? value;
    if (known.phase === 'complete' && !overlays.has(value.id)) return freeze(clone(known));
    throw new FirmwareUpdateError(
      'Consumed firmware request was not retried; explicitly review recovery',
      freeze(clone(known)),
      overlays.has(value.id) ? 'unavailable' : 'verified',
    );
  };
  async function load() {
    const start = epoch,
      value = await journal.read();
    if (disposed || epoch !== start)
      throw new FirmwareUpdateError('Firmware context changed during storage read');
    envelope = value;
    loaded = true;
  }
  async function review(
    target: FirmwareUpdateTarget,
    context: ToolExecutionContext,
    sourceRecordId?: string,
  ) {
    const principal = actor(context);
    if (flight || activeUpdate) throw new FirmwareUpdateError('A firmware operation is running');
    flight = true;
    epoch++;
    pending = undefined;
    publish({ phase: 'busy', error: undefined });
    try {
      if (!sourceRecordId) {
        const eligible = availability(target);
        if (!eligible.available) throw new FirmwareUpdateError(eligible.reasons.join('; '));
      }
      if (!loaded) await load();
      const parent = sourceRecordId
        ? envelope.records.find((r) => r.id === sourceRecordId && r.owner === owner)
        : undefined;
      if (sourceRecordId && !parent)
        throw new FirmwareUpdateError('Firmware recovery source is unavailable');
      if (parent && parent.qualifier !== qualifier)
        throw new FirmwareUpdateError('Firmware recovery belongs to a different execution route');
      const captures = slotsFor(target).map((slot) => {
        const previous = parent?.roles.find((r) => r.slot === slot),
          binding = clone(previous?.binding ?? options.binding(slot));
        if (!binding) throw new FirmwareUpdateError(`${slot} firmware target is disconnected`);
        if (sourceRecordId && !previous)
          throw new FirmwareUpdateError('Recovery target was not in the original operation');
        const staged = previous
          ? {
              ...clone(previous.source),
              stageId: `recovery:${sourceRecordId}:${previous.source.sha256}`,
            }
          : options.source(slot);
        if (!staged) throw new FirmwareUpdateError(`${slot} has no staged firmware`);
        const checked = checkedSource(staged);
        return {
          slot,
          binding,
          ...checked,
          before: previous ? clone(previous.before) : undefined,
          recovery: !!previous,
          invalidation,
        };
      });
      for (const capture of captures) {
        const eligible = registration.availability(capture.binding, capture.source);
        if (!eligible.available) throw new FirmwareUpdateError(eligible.reasons.join('; '));
      }
      if (
        new Set(captures.map((c) => c.binding.serial)).size !== captures.length ||
        new Set(captures.map((c) => c.binding.assignmentId)).size !== captures.length
      )
        throw new FirmwareUpdateError('Firmware targets must be distinct physical assignments');
      if (parent && options.prepareRecovery) {
        context.signal?.throwIfAborted();
        const result: unknown = options.prepareRecovery(
          freeze(captures.map(({ slot, binding }) => ({ slot, binding: clone(binding) }))),
        );
        if (
          result &&
          (typeof result === 'object' || typeof result === 'function') &&
          'then' in result &&
          typeof result.then === 'function'
        ) {
          void Promise.resolve(result).catch(() => {});
          throw new FirmwareUpdateError('Firmware recovery adoption must be synchronous');
        }
        // Adopting an empty page's historical leases may invalidate an older
        // facade context. The new review captures the generation afterwards.
        captures.forEach((capture) => {
          capture.invalidation = invalidation;
        });
      }
      const prepared = await port!.reserve(
        captures.map((c) => c.binding),
        async () => {
          const results = await Promise.allSettled(
            captures.map(async (c) => {
              current(c as Capture);
              context.signal?.throwIfAborted();
              if (c.recovery) {
                const loader = await port!.discoverBootloader(c.binding, true);
                if (
                  loader.identity.serial !== c.binding.serial ||
                  loader.identity.family !== c.binding.family
                )
                  throw new FirmwareUpdateError(
                    'Recovery loader is not correlated to this amplifier',
                  );
              } else {
                const fresh = await port!.preflightRuntime(c.binding);
                if (!same(c.binding, fresh))
                  throw new FirmwareUpdateError('Firmware runtime binding changed');
              }
              const before = c.before ?? checkedBefore(await port!.captureBefore(c.binding));
              const result = { ...c, before } as Capture;
              current(result);
              return result;
            }),
          );
          const failed = results.find((r) => r.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
          return results.map((r) => (r as PromiseFulfilledResult<Capture>).value);
        },
        {
          signal: context.signal,
          assertCurrent: () => captures.forEach((c) => current(c as Capture)),
        },
      );
      context.signal?.throwIfAborted();
      prepared.forEach(current);
      const value: FirmwareUpdateReview = freeze({
        id: nextId(),
        target,
        qualifier,
        ...(sourceRecordId ? { sourceRecordId } : {}),
        roles: prepared.map((c) => {
          const { text: _text, ...source } = c.source;
          return {
            slot: c.slot,
            binding: c.binding,
            source,
            knownImageCount: c.before.images.length,
            beforeSha256: c.before.sha256,
            gaps: c.before.gaps,
            packetsPerPass: describeFirmwarePacketPlan(c.bundle).packetsPerPass,
          };
        }),
      });
      pending = {
        owner: principal.owner,
        scope: principal.scope,
        review: value,
        captures: prepared,
      };
      publish({ phase: 'ready' });
      return value;
    } catch (error) {
      publish({ phase: 'error', error: problem(error) });
      throw new FirmwareUpdateError(problem(error));
    } finally {
      flight = false;
      publish();
    }
  }
  return {
    getSnapshot: () => snapshot,
    availability,
    invalidateReview() {
      pending = undefined;
      epoch++;
      invalidation++;
      publish();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    status(context) {
      actor(context);
      return snapshot;
    },
    async hydrate(context) {
      actor(context);
      if (flight) throw new FirmwareUpdateError('Firmware is busy');
      flight = true;
      try {
        await load();
        publish({ phase: 'ready' });
      } finally {
        flight = false;
        publish();
      }
    },
    review: (target, context) => review(target, context),
    reviewRecovery: (id, target, context) => review(target, context, id),
    async apply(id, context, confirmation) {
      const principal = actor(context);
      if (confirmation?.confirm !== true)
        throw new FirmwareUpdateError('Explicit firmware confirmation is required');
      const historical = envelope.records.find((r) => r.id === id);
      if (historical) {
        if (historical.owner !== owner) throw new FirmwareUpdateError('Foreign firmware record');
        return replay(historical);
      }
      if (flight || !pending || pending.owner !== owner || pending.review.id !== id)
        throw new FirmwareUpdateError('Firmware review is stale or consumed');
      const captured = pending;
      pending = undefined;
      flight = true;
      epoch++;
      publish({ phase: 'busy', error: undefined, latestOutcome: undefined });
      let runtime: FirmwareJournalRecord | undefined,
        durable = false,
        persistence: 'verified' | 'unavailable' = 'verified';
      const lease = {};
      const persist = async (fn: (value: FirmwareJournalRecord) => void) => {
        if (!runtime) throw new FirmwareUpdateError('Firmware runtime ledger unavailable');
        fn(runtime);
        runtime.updatedAt = now();
        await mutate((value) => {
          const old = value.records.find((r) => r.id === id && r.owner === owner);
          if (!old) throw new FirmwareUpdateError('Firmware journal unavailable');
          Object.assign(old, clone(runtime!));
        });
      };
      try {
        for (const capture of captured.captures) {
          const eligible = registration.availability(capture.binding, capture.source);
          if (!eligible.available) throw new FirmwareUpdateError(eligible.reasons.join('; '));
        }
        return await withLock('fusion-studio-firmware-update', async () => {
          if (activeUpdate)
            throw new FirmwareUpdateError(
              'A firmware family/re-enumeration operation is already active',
            );
          activeUpdate = lease;
          return port!.reserve(
            captured.captures.map((c) => c.binding),
            async () => {
              envelope = await journal.read();
              const duplicate = envelope.records.find((r) => r.id === id);
              if (duplicate) {
                if (duplicate.owner !== owner)
                  throw new FirmwareUpdateError('Foreign firmware record');
                return replay(duplicate);
              }
              context.signal?.throwIfAborted();
              const known = new Map(envelope.records.map((saved) => [saved.id, saved]));
              for (const [key, value] of overlays) known.set(key, value);
              const knownRecords = [...known.values()];
              // Recovery receipts remain historical. Follow their immutable
              // ancestry so a verified second recovery resolves earlier failed
              // recovery attempts without rewriting any original outcome.
              const recoveryRoot = (value: FirmwareJournalRecord): string => {
                let result = value;
                const visited = new Set<string>();
                while (result.sourceRecordId) {
                  if (visited.has(result.id))
                    throw new FirmwareUpdateError('Invalid firmware recovery ancestry');
                  visited.add(result.id);
                  const parent = known.get(result.sourceRecordId);
                  if (!parent || parent.owner !== result.owner)
                    throw new FirmwareUpdateError('Firmware recovery ancestry is unavailable');
                  result = parent;
                }
                return result.id;
              };
              if (
                !captured.review.sourceRecordId &&
                knownRecords.some((r, recordIndex) =>
                  r.roles.some(
                    (role) =>
                      captured.captures.some((c) => c.binding.serial === role.binding.serial) &&
                      !(
                        role.after?.preservation === 'matched-known-ranges' &&
                        role.stream?.streamComplete &&
                        role.steps.every((step) => ['verified', 'skipped'].includes(step.state))
                      ) &&
                      role.steps.some(
                        (s) =>
                          s.attempted ||
                          (['entry', 'stream', 'exit'].includes(s.id) && s.state === 'intent'),
                      ) &&
                      !knownRecords
                        .slice(recordIndex + 1)
                        .some(
                          (later) =>
                            later.owner === r.owner &&
                            later.phase === 'complete' &&
                            !!later.sourceRecordId &&
                            recoveryRoot(later) === recoveryRoot(r) &&
                            later.roles.some(
                              (restored) =>
                                restored.slot === role.slot &&
                                sameStable(restored.binding, role.binding) &&
                                restored.after?.preservation === 'matched-known-ranges',
                            ),
                        ),
                  ),
                )
              )
                throw new FirmwareUpdateError(
                  'An interrupted firmware target requires explicit recovery',
                );
              const preflight = await Promise.allSettled(
                captured.captures.map(async (c) => {
                  current(c);
                  if (c.recovery) {
                    const loader = await port!.discoverBootloader(c.binding, true);
                    if (
                      loader.identity.serial !== c.binding.serial ||
                      loader.identity.family !== c.binding.family
                    )
                      throw new FirmwareUpdateError('Firmware recovery loader changed');
                  } else {
                    if (
                      !same(await port!.preflightRuntime(c.binding), c.binding) ||
                      firmwareSourceSha256(options.source(c.slot)!.text) !== c.source.sha256
                    )
                      throw new FirmwareUpdateError('Firmware source or runtime changed');
                    const fresh = checkedBefore(await port!.captureBefore(c.binding));
                    if (!sameBeforeProjection(c.before, fresh))
                      throw new FirmwareUpdateError('Firmware preservation snapshot changed');
                  }
                  current(c);
                }),
              );
              const failed = preflight.find((r) => r.status === 'rejected');
              if (failed?.status === 'rejected') throw failed.reason;
              runtime = {
                id,
                owner: principal.owner,
                scope: captured.scope,
                target: captured.review.target,
                qualifier,
                ...(captured.review.sourceRecordId
                  ? { sourceRecordId: captured.review.sourceRecordId }
                  : {}),
                createdAt: now(),
                updatedAt: now(),
                phase: 'prepared',
                roles: captured.captures.map((c) => {
                  const { text: sourceText, ...rest } = c.source;
                  const { stageId: _stage, ...source } = rest;
                  return {
                    slot: c.slot,
                    binding: c.binding,
                    source: { ...source, text: sourceText },
                    before: c.before,
                    steps: FIRMWARE_JOURNAL_STEPS.map((step) => ({
                      id: step,
                      state: step === 'entry' && c.recovery ? 'skipped' : 'pending',
                      attempted: false,
                    })),
                  };
                }),
              };
              await mutate((value) => value.records.push(clone(runtime!)));
              durable = true;
              await persist((r) => {
                r.phase = 'running';
              });
              // Recheck EVERY target after durable backups, before any transition.
              const ready = await Promise.allSettled(
                captured.captures.map(async (c) => {
                  current(c);
                  if (!c.recovery && !same(await port!.preflightRuntime(c.binding), c.binding))
                    throw new FirmwareUpdateError('Firmware target changed after backup');
                  current(c);
                }),
              );
              const blocked = ready.find((r) => r.status === 'rejected');
              if (blocked?.status === 'rejected') throw blocked.reason;
              for (const [index, c] of captured.captures.entries()) {
                const step = (name: (typeof FIRMWARE_JOURNAL_STEPS)[number]) =>
                    runtime!.roles[index].steps[FIRMWARE_JOURNAL_STEPS.indexOf(name)],
                  intent = (name: (typeof FIRMWARE_JOURNAL_STEPS)[number]) =>
                    persist(() => {
                      step(name).state = 'intent';
                    }),
                  admit = (name: (typeof FIRMWARE_JOURNAL_STEPS)[number]) => {
                    current(c);
                    context.signal?.throwIfAborted();
                    step(name).attempted = true;
                  },
                  verified = (name: (typeof FIRMWARE_JOURNAL_STEPS)[number]) =>
                    persist(() => {
                      step(name).state = 'verified';
                    });
                try {
                  if (!c.recovery) {
                    await intent('entry');
                    const fresh = await port!.preflightRuntime(c.binding);
                    if (!same(fresh, c.binding))
                      throw new FirmwareUpdateError(
                        'Firmware target changed immediately before entry',
                      );
                    current(c);
                    let delivery: 'sent' | 'unconfirmed' | 'not-sent' = 'unconfirmed';
                    try {
                      delivery = await port!.enterBootloader(c.binding, {
                        requestId: `${id}:${c.slot}:entry`,
                        payload: Uint8Array.of(0x40, 0, ...Array(62).fill(0)),
                        timeoutMs: 5000,
                        beforeWireSend: () => admit('entry'),
                      });
                    } catch (error) {
                      step('entry').error = problem(error);
                    }
                    if (delivery === 'not-sent' && !step('entry').attempted)
                      throw new FirmwareUpdateError('Bootloader entry was not sent');
                  }
                  await intent('loader');
                  const loader = await port!.discoverBootloader(c.binding, c.recovery);
                  current(c);
                  if (
                    loader.identity.serial !== c.binding.serial ||
                    loader.identity.family !== c.binding.family
                  )
                    throw new FirmwareUpdateError(
                      'Discovered bootloader belongs to another amplifier',
                    );
                  if (!c.recovery) await verified('entry');
                  await verified('loader');
                  let stream: Readonly<FirmwareProgramResult>;
                  try {
                    stream = await programNativeFirmware(c.bundle, loader.channel, {
                      operationId: `${id}:${c.slot}`,
                      expected: loader.identity,
                      signal: context.signal,
                      sleep: options.sleep,
                      assertCurrent: () => current(c),
                      beforeFirstProgramRequest: () => intent('stream'),
                      onWireSend: () => {
                        step('stream').attempted = true;
                      },
                      onExitWireSend: () => {
                        step('exit').attempted = true;
                      },
                      onProgress: (progress) => {
                        runtime!.roles[index].stream = streamState(progress);
                        publish();
                      },
                      checkpointPass: async (_pass, progress) => {
                        await persist((r) => {
                          r.roles[index].stream = streamState(progress);
                        });
                      },
                      beforeExit: async () => {
                        await verified('stream');
                        await intent('exit');
                      },
                    });
                  } catch (error) {
                    if (error instanceof FirmwareProgramError) {
                      runtime.roles[index].stream = streamState(error.result);
                      step('stream').state =
                        error.result.outcome === 'rejected'
                          ? 'rejected'
                          : error.result.outcome === 'cancelled'
                            ? 'cancelled'
                            : error.result.outcome === 'blocked'
                              ? 'rejected'
                              : 'unconfirmed';
                    }
                    throw error;
                  }
                  runtime.roles[index].stream = streamState(stream);
                  if (stream.exit.state === 'acknowledged') await verified('exit');
                  else {
                    step('exit').state = 'unconfirmed';
                    step('exit').error = stream.exit.error;
                    await persist(() => {});
                  }
                  await intent('runtime');
                  const post = await port!.discoverRuntime(c.binding, c.source.expectedAfter);
                  current(c);
                  if (
                    !sameStable(c.binding, post) ||
                    post.connectionId === c.binding.connectionId ||
                    post.connectionEpoch <= c.binding.connectionEpoch ||
                    post.core !== c.source.expectedAfter!.core ||
                    post.firmware !== c.source.expectedAfter!.firmware
                  )
                    throw new FirmwareUpdateError('Fresh runtime identity/version is unverified');
                  await verified('runtime');
                  if (step('exit').state === 'unconfirmed') await verified('exit');
                  await intent('preservation');
                  const after = await port!.captureAfter(post),
                    changes = changedImages(c.before, after);
                  runtime.roles[index].after = {
                    binding: clone(post),
                    controlsDialect: post.core === '5.1' ? 'supported' : 'unqualified',
                    preservation: changes.length ? 'changed' : 'matched-known-ranges',
                    changedImages: changes,
                  };
                  if (changes.length)
                    throw new FirmwareUpdateError(
                      'Known settings/filter areas changed; no automatic restoration was attempted',
                    );
                  await verified('preservation');
                } catch (error) {
                  runtime.roles[index].error = problem(error);
                  const unfinished = runtime.roles[index].steps.find((s) => s.state === 'intent');
                  if (unfinished) {
                    unfinished.state = unfinished.attempted
                      ? 'unconfirmed'
                      : context.signal?.aborted
                        ? 'cancelled'
                        : 'rejected';
                    unfinished.error = problem(error);
                  }
                  throw error;
                }
              }
              await persist((r) => {
                r.phase = 'complete';
              });
              const result = freeze(clone(record(id)));
              outcome(result, 'verified');
              return result;
            },
            { signal: context.signal, assertCurrent: () => captured.captures.forEach(current) },
          );
        });
      } catch (error) {
        if (runtime && durable) {
          try {
            envelope = await journal.read();
            const completed = envelope.records.find(
              (r) => r.id === id && r.owner === owner && r.phase === 'complete',
            );
            if (completed) {
              outcome(completed, 'verified');
              return freeze(clone(completed));
            }
          } catch {
            persistence = 'unavailable';
          }
          await persist((r) => {
            r.phase = r.roles.some((role) => role.steps.some((s) => s.attempted))
              ? 'partial'
              : context.signal?.aborted
                ? 'cancelled'
                : 'failed';
            r.error = problem(error);
          }).catch(() => {
            persistence = 'unavailable';
          });
          const latest =
            persistence === 'unavailable'
              ? runtime
              : envelope.records.find((r) => r.id === id && r.owner === owner);
          if (latest) {
            if (persistence === 'unavailable') overlays.set(id, freeze(clone(latest)));
            outcome(latest, persistence);
            runtime = latest;
          }
        } else runtime = undefined;
        publish({ phase: 'error', error: problem(error) });
        throw new FirmwareUpdateError(
          problem(error),
          runtime ? freeze(clone(runtime)) : undefined,
          persistence,
        );
      } finally {
        if (activeUpdate === lease) activeUpdate = undefined;
        flight = false;
        publish({ phase: snapshot.error ? 'error' : 'ready' });
      }
    },
    discard(id, context) {
      actor(context);
      if (flight || pending?.review.id !== id)
        throw new FirmwareUpdateError('Firmware review unavailable');
      pending = undefined;
      epoch++;
      publish();
    },
    exportRecord(id, context) {
      actor(context);
      const overlay = overlays.get(id),
        saved = envelope.records.find((r) => r.id === id && r.owner === owner);
      if (overlay) return freeze({ ...clone(overlay), exportPersistence: 'unavailable' as const });
      if (!saved) throw new FirmwareUpdateError('Firmware recovery record unavailable');
      return freeze({ ...clone(saved), exportPersistence: 'verified' as const });
    },
    dispose() {
      disposed = true;
      epoch++;
      pending = undefined;
      overlays.clear();
      listeners.clear();
      snapshot = freeze({
        busy: false,
        availability: roleAvailability(),
        phase: 'idle',
        records: [],
      });
    },
  };
}
function streamState(result: Readonly<FirmwareProgramResult>): FirmwareJournalStream {
  return {
    acceptedPackets: result.acceptedPackets,
    acceptedRecords: result.acceptedRecords,
    nativeProgressRecords: result.nativeProgressRecords,
    transportAttempts: result.transportAttempts,
    wireRequests: result.wireRequests,
    streamComplete: result.streamComplete,
    ...(result.lastAccepted ? { lastAccepted: result.lastAccepted } : {}),
    ...(result.targetStatus === undefined ? {} : { targetStatus: result.targetStatus }),
  };
}
