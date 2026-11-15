import type { Slot } from '../domain/model';
import type { FirmwareRuntimeReport } from '../hardware/firmware-runtime-inspector';
import type { ToolExecutionContext } from './execution-context';
import { parseExecutionPrincipal } from './execution-context';
import { KNOWN_FIRMWARE_PROFILES } from '../domain/firmware-profile';

export type FirmwareRuntimeTarget = Slot | 'both';
export interface FirmwareRuntimeBinding {
  key: string;
  serial?: string;
  source: 'connected-session' | 'staged-device' | 'chosen-device' | 'remembered-device';
}
export interface FirmwareRuntimeRoleState {
  phase: 'empty' | 'reading' | 'ready' | 'error';
  report?: FirmwareRuntimeReport;
  observedAt?: string;
  source?: FirmwareRuntimeBinding['source'];
  stale: boolean;
  error?: string;
}
export interface FirmwareRuntimeSnapshot {
  busy: boolean;
  revision: number;
  roles: Record<Slot, FirmwareRuntimeRoleState>;
}
export interface FirmwareRuntimeControllerOptions {
  binding(slot: Slot): FirmwareRuntimeBinding | undefined;
  read(
    slot: Slot,
    binding: Readonly<FirmwareRuntimeBinding>,
    hooks: {
      assertCurrent(): void;
      signal?: AbortSignal;
    },
  ): Promise<FirmwareRuntimeReport>;
  now?: () => number;
}
export interface FirmwareRuntimeController {
  getSnapshot(): Readonly<FirmwareRuntimeSnapshot>;
  subscribe(listener: () => void): () => void;
  availability(slot: Slot): { available: boolean; reason?: string };
  status(context: ToolExecutionContext): Readonly<FirmwareRuntimeSnapshot>;
  read(
    target: FirmwareRuntimeTarget,
    context: ToolExecutionContext,
  ): Promise<Readonly<FirmwareRuntimeSnapshot>>;
  clear(target: FirmwareRuntimeTarget, context: ToolExecutionContext): void;
  refreshBindings(): void;
  dispose(): void;
}

export class FirmwareRuntimeDiagnosticError extends Error {
  constructor(
    message: string,
    readonly runtime: FirmwareRuntimeReport,
  ) {
    super(message);
    this.name = 'FirmwareRuntimeDiagnosticError';
  }
}

const slots = (target: FirmwareRuntimeTarget): Slot[] => {
  if (!['left', 'right', 'both'].includes(target)) throw new Error('Choose Left, Right or Both');
  return target === 'both' ? ['left', 'right'] : [target];
};
const frozen = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
};
const exactSerial = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x20-\x7e]{1,32}$/.test(value);
const problem = (error: unknown) =>
  (error instanceof Error ? error.message : 'Firmware runtime identity was not confirmed').slice(
    0,
    1024,
  );
const same = (a: FirmwareRuntimeBinding | undefined, b: FirmwareRuntimeBinding | undefined) =>
  !!a && !!b && a.key === b.key && a.serial === b.serial && a.source === b.source;
const checkedReport = (report: FirmwareRuntimeReport): FirmwareRuntimeReport => {
  const profile = KNOWN_FIRMWARE_PROFILES.find((value) => value.id === report?.profileId);
  if (
    !profile ||
    !exactSerial(report.identity?.serial) ||
    report.identity.product !== 22 ||
    report.identity.core !== profile.coreVersion ||
    report.identity.firmware !== profile.bundleVersion ||
    typeof report.identity.name !== 'string' ||
    !/^[\x20-\x7e]{0,32}$/.test(report.identity.name) ||
    report.hardware?.amplifier !== 5 ||
    report.hardware.presets !== 3 ||
    report.hardware.channels !== 3 ||
    !Number.isInteger(report.hardware.moduleType) ||
    report.hardware.moduleType < 0 ||
    report.hardware.moduleType > 255 ||
    report.controlsQualified !== (profile.coreVersion === '5.1') ||
    report.familyProof !== 'not-established-by-runtime-reports' ||
    report.imageProof !== 'not-established-by-runtime-reports' ||
    report.consistency !== 'double-read-matched'
  )
    throw new Error('Invalid firmware runtime identity report');
  return frozen(structuredClone(report));
};

/** Shared read-only UI/MCP state. A report never authorizes a controls session,
 * descriptor family, installed image, bootloader entry, programming or recovery. */
export function createFirmwareRuntimeController(
  options: FirmwareRuntimeControllerOptions,
): FirmwareRuntimeController {
  const listeners = new Set<() => void>(),
    generations = { left: 0, right: 0 },
    sources: Partial<Record<Slot, FirmwareRuntimeBinding>> = {};
  let disposed = false,
    flight = false,
    owner: string | undefined,
    snapshot: Readonly<FirmwareRuntimeSnapshot> = frozen({
      busy: false,
      revision: 0,
      roles: { left: { phase: 'empty', stale: false }, right: { phase: 'empty', stale: false } },
    });
  const publish = (roles: FirmwareRuntimeSnapshot['roles']) => {
    const next = frozen({ busy: flight, revision: snapshot.revision + 1, roles });
    snapshot = next;
    if (!disposed)
      for (const listener of listeners)
        try {
          listener();
        } catch {
          /* Views cannot interrupt a read. */
        }
    return next;
  };
  const actor = (context: ToolExecutionContext) => {
    if (disposed) throw new Error('Firmware runtime inspection is disposed');
    const principal = parseExecutionPrincipal({ owner: context?.owner, scope: context?.scope });
    if (!/^workspace:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(principal.owner))
      throw new Error('Firmware runtime inspection requires trusted workspace admission');
    if (owner && owner !== principal.owner)
      throw new Error('Firmware runtime report belongs to another workspace');
    owner ??= principal.owner;
    return principal;
  };
  const binding = (slot: Slot): FirmwareRuntimeBinding | undefined => {
    const value = options.binding(slot);
    if (!value) return undefined;
    if (
      typeof value.key !== 'string' ||
      !value.key.length ||
      value.key.length > 512 ||
      !['connected-session', 'staged-device', 'chosen-device', 'remembered-device'].includes(
        value.source,
      ) ||
      (value.serial !== undefined && !exactSerial(value.serial)) ||
      (value.serial === undefined && value.source !== 'chosen-device')
    )
      throw new Error('Invalid captured firmware runtime target');
    return { ...value };
  };
  const refreshBindings = () => {
    if (disposed) return;
    const roles = { ...snapshot.roles };
    let changed = false;
    for (const slot of ['left', 'right'] as const) {
      if (!roles[slot].report || roles[slot].stale) continue;
      let current: FirmwareRuntimeBinding | undefined;
      try {
        current = binding(slot);
      } catch {
        /* A malformed replacement is not the read source. */
      }
      if (!same(sources[slot], current)) {
        roles[slot] = { ...roles[slot], stale: true };
        changed = true;
      }
    }
    if (changed) publish(roles);
  };
  const available = (slot: Slot) => {
    try {
      if (disposed) return { available: false, reason: 'Firmware runtime inspection is closed.' };
      if (!['left', 'right'].includes(slot)) throw new Error('Choose Left or Right');
      if (!binding(slot))
        return {
          available: false,
          reason:
            'Connect this amplifier, or use its identity retained from a connection or firmware stage.',
        };
      return { available: true };
    } catch (error) {
      return { available: false, reason: problem(error) };
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    availability: available,
    status(context) {
      actor(context);
      refreshBindings();
      return snapshot;
    },
    async read(target, context) {
      actor(context);
      context.signal?.throwIfAborted();
      if (flight) throw new Error('A firmware runtime identity read is running');
      const selected = slots(target),
        captures = selected.map((slot) => {
          const source = binding(slot);
          if (!source) throw new Error(`${slot} has no captured amplifier identity to inspect`);
          return { slot, source, generation: generations[slot] };
        });
      if (
        captures.length > 1 &&
        (captures.some((value) => !value.source.serial) ||
          new Set(captures.map((value) => value.source.serial)).size !== captures.length)
      )
        throw new Error('Both runtime reads require distinct captured amplifier serials');
      const assertCurrent = (capture: (typeof captures)[number]) => {
        context.signal?.throwIfAborted();
        if (
          disposed ||
          generations[capture.slot] !== capture.generation ||
          !same(capture.source, binding(capture.slot))
        )
          throw new Error('Captured firmware runtime target changed; its replacement was not read');
      };
      captures.forEach(assertCurrent);
      flight = true;
      const reading = { ...snapshot.roles };
      for (const capture of captures)
        reading[capture.slot] = { ...reading[capture.slot], phase: 'reading', error: undefined };
      publish(reading);
      let completed: Readonly<FirmwareRuntimeSnapshot> | undefined;
      try {
        const results: {
          slot: Slot;
          source: FirmwareRuntimeBinding;
          report: FirmwareRuntimeReport;
        }[] = [];
        // A provider may temporarily open an already-permitted interface. Finish
        // its owned close before probing the next role, avoiding duplicate HID readers.
        for (const capture of captures) {
          captures.forEach(assertCurrent);
          const report = checkedReport(
            await options.read(capture.slot, frozen({ ...capture.source }), {
              assertCurrent: () => captures.forEach(assertCurrent),
              ...(context.signal ? { signal: context.signal } : {}),
            }),
          );
          if (
            capture.source.serial !== undefined &&
            report.identity.serial !== capture.source.serial
          )
            throw new Error('Firmware runtime report belongs to another amplifier');
          results.push({ slot: capture.slot, source: capture.source, report });
        }
        captures.forEach(assertCurrent);
        const observedAt = new Date((options.now ?? Date.now)()).toISOString(),
          roles = { ...snapshot.roles };
        for (const result of results) {
          sources[result.slot] = result.source;
          roles[result.slot] = {
            phase: 'ready',
            stale: false,
            source: result.source.source,
            report: result.report,
            observedAt,
          };
        }
        publish(roles);
      } catch (error) {
        if (!disposed) {
          const roles = { ...snapshot.roles };
          for (const capture of captures)
            if (generations[capture.slot] === capture.generation)
              roles[capture.slot] = {
                ...roles[capture.slot],
                phase: 'error',
                stale: !!roles[capture.slot].report,
                error: problem(error),
              };
          publish(roles);
          refreshBindings();
        }
        throw error;
      } finally {
        flight = false;
        completed = disposed ? snapshot : publish({ ...snapshot.roles });
      }
      return completed;
    },
    clear(target, context) {
      actor(context);
      const roles = { ...snapshot.roles };
      for (const slot of slots(target)) {
        generations[slot]++;
        delete sources[slot];
        roles[slot] = { phase: 'empty', stale: false };
      }
      publish(roles);
    },
    refreshBindings,
    dispose() {
      if (disposed) return;
      disposed = true;
      generations.left++;
      generations.right++;
      delete sources.left;
      delete sources.right;
      snapshot = frozen({
        busy: false,
        revision: snapshot.revision + 1,
        roles: { left: { phase: 'empty', stale: false }, right: { phase: 'empty', stale: false } },
      });
      listeners.clear();
    },
  };
}
