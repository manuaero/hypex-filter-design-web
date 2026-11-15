import type { Project, Slot } from '../domain/model';
import type { ProjectFile } from '../domain/project-io';
import type { Identity } from '../hardware/session';
import type { NativeSaveSnapshot } from '../hardware/native-save-capture';
import type { ToolExecutionContext } from './execution-context';
import type { DirectorySaveBinding, DirectoryExportTicket } from './project-directory-writer';
import { z } from 'zod';
import { projectSchema } from '../domain/files';
import { projectFiles } from '../domain/project-io';
import { nativeCloneProjectFiles } from '../domain/clone-project';
import { captureNativeSaveTemplate } from '../hardware/native-save-capture';
import { parseExecutionPrincipal } from './execution-context';
import { MAX_UI_TEXT_CHARACTERS, MAX_UI_TOTAL_BYTES } from './file-budget';

export type NativeProjectSaveTarget = Slot | 'both';
export type NativeProjectSaveMode = 'auto' | 'design';
export type NativeProjectSaveIdentity = Pick<Identity, 'serial' | 'product' | 'core' | 'firmware'>;
export interface NativeProjectSaveSession {
  readonly lockOrder: number;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  captureNativeSaveSnapshotInternal(
    expected: NativeProjectSaveIdentity,
  ): Promise<NativeSaveSnapshot>;
}
export interface NativeProjectSaveRoleSummary {
  slot: Slot;
  source: 'connected' | 'design';
  identity?: NativeProjectSaveIdentity;
  capturedAt?: string;
  error?: string;
}
export interface NativeProjectSaveSummary {
  id: string;
  target: NativeProjectSaveTarget;
  expectedRevision: number;
  mode: NativeProjectSaveMode;
  phase: 'staged' | 'capturing' | 'ready' | 'error';
  roles: readonly NativeProjectSaveRoleSummary[];
  error?: string;
}
export interface NativeProjectSaveArtifact {
  id: string;
  expectedRevision: number;
  roles: readonly (NativeProjectSaveRoleSummary & {
    project: Project;
    files: readonly ProjectFile[];
  })[];
}
export interface NativeProjectSaveSnapshot {
  captures: readonly NativeProjectSaveSummary[];
  busy: boolean;
}
export interface NativeProjectSaveControllerOptions {
  state(): { documents: Record<Slot, Project>; documentRevision?: number };
  binding(
    slot: Slot,
  ): { session: NativeProjectSaveSession; identity: NativeProjectSaveIdentity } | undefined;
  operate?<T>(label: string, action: () => Promise<T>): Promise<T>;
  now?: () => number;
  id?: () => string;
  /** Optional lower-only budgets, also useful for constrained hosts and tests. */
  limits?: { characters?: number; bytes?: number };
}
export interface NativeProjectSaveController {
  getSnapshot(): NativeProjectSaveSnapshot;
  subscribe(listener: () => void): () => void;
  status(context: ToolExecutionContext): NativeProjectSaveSnapshot;
  stage(
    input: {
      target: NativeProjectSaveTarget;
      expectedRevision: number;
      mode: NativeProjectSaveMode;
    },
    context: ToolExecutionContext,
  ): NativeProjectSaveSummary;
  resolve(id: string, context: ToolExecutionContext): Promise<NativeProjectSaveArtifact>;
  release(id: string, context: ToolExecutionContext): void;
  ticket(binding: Readonly<DirectorySaveBinding>, project: Project): DirectoryExportTicket;
  dispose(): void;
}

export const MAX_NATIVE_PROJECT_SAVE_CAPTURES = 8;
export class NativeProjectSaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeProjectSaveError';
  }
}
const inputSchema = z
  .object({
    target: z.enum(['left', 'right', 'both']),
    expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    mode: z.enum(['auto', 'design']),
  })
  .strict();
const identitySchema = z
  .object({
    serial: z.string().min(1).max(512),
    product: z.number().int().min(0).max(255),
    core: z.string().min(1).max(512),
    firmware: z.string().min(1).max(512),
  })
  .strict();
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const problem = (failure: unknown) =>
  (failure instanceof Error ? failure.message : 'Native project capture failed').slice(0, 2048);
const slotsFor = (target: NativeProjectSaveTarget): Slot[] =>
  target === 'both' ? ['left', 'right'] : [target];
const sameIdentity = (a: NativeProjectSaveIdentity, b: NativeProjectSaveIdentity) =>
  a.serial === b.serial &&
  a.product === b.product &&
  a.core === b.core &&
  a.firmware === b.firmware;
interface CapturedRole {
  slot: Slot;
  source: 'connected' | 'design';
  original: Project;
  project: Project;
  binding?: { session: NativeProjectSaveSession; identity: NativeProjectSaveIdentity };
}
interface Capture {
  owner: string;
  scope: string;
  live: boolean;
  summary: NativeProjectSaveSummary;
  roles: CapturedRole[];
  signal?: AbortSignal;
  promise?: Promise<NativeProjectSaveArtifact>;
  artifact?: NativeProjectSaveArtifact;
  characters: number;
  bytes: number;
}
async function reserve<T>(
  sessions: NativeProjectSaveSession[],
  work: () => Promise<T>,
): Promise<T> {
  const ordered = [...sessions].sort((a, b) => a.lockOrder - b.lockOrder);
  const next = (index: number): Promise<T> =>
    index === ordered.length ? work() : ordered[index].exclusive(() => next(index + 1));
  return next(0);
}

/** Detached save artifacts only. This service never publishes workspace metadata,
 * changes a design EQ, writes a device, or owns a filesystem capability. */
export function createNativeProjectSaveController(
  options: NativeProjectSaveControllerOptions,
): NativeProjectSaveController {
  const captures = new Map<string, Capture>(),
    flights = new Set<Capture>(),
    listeners = new Set<() => void>();
  let disposed = false,
    snapshot: NativeProjectSaveSnapshot = freeze({ captures: [], busy: false });
  const lowerLimit = (value: number | undefined, maximum: number) => {
      if (value === undefined) return maximum;
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new NativeProjectSaveError('Invalid native Save retention budget');
      return value;
    },
    maxCharacters = lowerLimit(options.limits?.characters, MAX_UI_TEXT_CHARACTERS),
    maxBytes = lowerLimit(options.limits?.bytes, MAX_UI_TOTAL_BYTES);
  const textCost = (text: string) => ({
    characters: text.length,
    bytes: new TextEncoder().encode(text).byteLength,
  });
  const checkBudget = (extra: { characters: number; bytes: number }) => {
    const retained = [...new Set([...captures.values(), ...flights])].reduce(
      (sum, entry) => ({
        characters: sum.characters + entry.characters,
        bytes: sum.bytes + entry.bytes,
      }),
      { characters: 0, bytes: 0 },
    );
    if (
      retained.characters + extra.characters > maxCharacters ||
      retained.bytes + extra.bytes > maxBytes
    )
      throw new NativeProjectSaveError(
        'Native Save capture exceeds the aggregate retained project/file budget; release an unused capture',
      );
  };
  const clearData = (entry: Capture) => {
    entry.roles = [];
    entry.artifact = undefined;
    entry.characters = entry.bytes = 0;
  };
  const actor = (context: ToolExecutionContext) => {
    if (disposed) throw new NativeProjectSaveError('Native project capture is disposed');
    const principal = parseExecutionPrincipal({ owner: context?.owner, scope: context?.scope });
    if (!/^workspace:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(principal.owner))
      throw new NativeProjectSaveError(
        'Native project capture requires trusted workspace admission',
      );
    context.signal?.throwIfAborted();
    return principal;
  };
  const publish = () => {
    snapshot = freeze({
      captures: [...captures.values()].map((entry) => entry.summary),
      busy: flights.size > 0,
    });
    listeners.forEach((listener) => listener());
  };
  const owned = (id: string, context: ToolExecutionContext) => {
    const principal = actor(context),
      entry = captures.get(id);
    if (!entry || entry.owner !== principal.owner)
      throw new NativeProjectSaveError('Native project capture is unavailable for this workspace');
    return entry;
  };
  const assertCurrent = (entry: Capture, signal?: AbortSignal) => {
    if (disposed || !entry.live || captures.get(entry.summary.id) !== entry)
      throw new NativeProjectSaveError('Native project capture was released');
    entry.signal?.throwIfAborted();
    signal?.throwIfAborted();
    // Offline/design exports are immutable snapshots, not a request to read
    // current hardware. Later design edits must not invalidate their download.
    if (!entry.roles.some((role) => role.binding)) return;
    const state = options.state();
    if (
      (state.documentRevision ?? 0) !== entry.summary.expectedRevision ||
      entry.roles.some((role) => state.documents[role.slot] !== role.original)
    )
      throw new NativeProjectSaveError(
        'The design changed during native project capture; stage Save again',
      );
    for (const role of entry.roles)
      if (role.binding) {
        const current = options.binding(role.slot);
        if (
          !current ||
          current.session !== role.binding.session ||
          !sameIdentity(current.identity, role.binding.identity)
        )
          throw new NativeProjectSaveError(
            `${role.slot} amplifier connection or identity changed during native project capture`,
          );
      }
  };
  const stage = (
    raw: { target: NativeProjectSaveTarget; expectedRevision: number; mode: NativeProjectSaveMode },
    context: ToolExecutionContext,
  ) => {
    const principal = actor(context),
      input = inputSchema.parse(raw),
      state = options.state();
    if ((state.documentRevision ?? 0) !== input.expectedRevision)
      throw new NativeProjectSaveError('The design changed before Save could be staged');
    if (new Set([...captures.values(), ...flights]).size >= MAX_NATIVE_PROJECT_SAVE_CAPTURES)
      throw new NativeProjectSaveError(
        'Eight save captures are retained; release an unused capture before starting another',
      );
    const roles = slotsFor(input.target).map((slot): CapturedRole => {
      const original = state.documents[slot];
      projectSchema.parse(original); // Validate without changing legacy JSON key order/absence.
      const project = structuredClone(original),
        current = input.mode === 'auto' ? options.binding(slot) : undefined;
      return {
        slot,
        original,
        project,
        source: current ? 'connected' : 'design',
        ...(current
          ? {
              binding: {
                session: current.session,
                identity: identitySchema.parse({
                  serial: current.identity.serial,
                  product: current.identity.product,
                  core: current.identity.core,
                  firmware: current.identity.firmware,
                }),
              },
            }
          : {}),
      };
    });
    const cost = roles.reduce(
      (sum, role) => {
        const size = textCost(JSON.stringify(role.project));
        return {
          characters: sum.characters + size.characters,
          bytes: sum.bytes + size.bytes,
        };
      },
      { characters: 0, bytes: 0 },
    );
    checkBudget(cost);
    const connected = roles.flatMap((role) => (role.binding ? [role.binding] : []));
    if (
      new Set(connected.map((binding) => binding.session)).size !== connected.length ||
      new Set(connected.map((binding) => binding.identity.serial)).size !== connected.length
    )
      throw new NativeProjectSaveError(
        'Save capture requires distinct physical amplifiers for Left and Right',
      );
    const id = options.id?.() ?? crypto.randomUUID();
    if (!/^[a-zA-Z0-9._:-]{1,256}$/.test(id) || captures.has(id))
      throw new NativeProjectSaveError('Invalid or repeated native project capture ID');
    const summary = freeze({
      id,
      target: input.target,
      expectedRevision: input.expectedRevision,
      mode: input.mode,
      phase: 'staged' as const,
      roles: roles.map((role) => ({
        slot: role.slot,
        source: role.source,
        ...(role.binding ? { identity: role.binding.identity } : {}),
      })),
    });
    captures.set(id, {
      owner: principal.owner,
      scope: principal.scope,
      live: true,
      summary,
      roles,
      signal: context.signal,
      ...cost,
    });
    publish();
    return summary;
  };
  const resolve = async (
    id: string,
    context: ToolExecutionContext,
  ): Promise<NativeProjectSaveArtifact> => {
    const entry = owned(id, context);
    // A resolved artifact is historical and detached. It never recaptures a changed device.
    if (entry.artifact) return entry.artifact;
    if (entry.promise) return entry.promise;
    if (entry.summary.phase === 'error')
      throw new NativeProjectSaveError(
        entry.summary.error ?? 'Release the failed capture and stage Save again',
      );
    assertCurrent(entry, context.signal);
    flights.add(entry);
    entry.summary = freeze({ ...entry.summary, phase: 'capturing' });
    publish();
    entry.promise = (async () => {
      try {
        const work = () =>
          reserve(
            entry.roles.flatMap((role) => (role.binding ? [role.binding.session] : [])),
            async () => {
              assertCurrent(entry, context.signal);
              const results = await Promise.allSettled(
                entry.roles.map(async (role) => {
                  const project = structuredClone(role.project);
                  let saved: NativeProjectSaveArtifact['roles'][number];
                  if (!role.binding)
                    saved = {
                      slot: role.slot,
                      source: role.source,
                      project,
                      files: projectFiles(project),
                    };
                  else {
                    assertCurrent(entry, context.signal);
                    const raw = await role.binding.session.captureNativeSaveSnapshotInternal(
                      role.binding.identity,
                    );
                    assertCurrent(entry, context.signal);
                    const capturedAt = new Date(options.now?.() ?? Date.now()).toISOString();
                    project.hfdCloneTemplate = captureNativeSaveTemplate(raw, capturedAt);
                    projectSchema.parse(project);
                    saved = {
                      slot: role.slot,
                      source: role.source,
                      identity: role.binding.identity,
                      capturedAt,
                      project,
                      files: nativeCloneProjectFiles(project),
                    };
                  }
                  const output = saved.files.reduce(
                    (sum, file) => {
                      const size = textCost(file.content);
                      return {
                        characters: sum.characters + size.characters,
                        bytes: sum.bytes + size.bytes,
                      };
                    },
                    textCost(JSON.stringify(saved.project)),
                  );
                  checkBudget(output);
                  entry.characters += output.characters;
                  entry.bytes += output.bytes;
                  return saved;
                }),
              );
              const failed = results.find((result) => result.status === 'rejected');
              if (failed?.status === 'rejected') throw failed.reason;
              assertCurrent(entry, context.signal);
              return results.map(
                (result) =>
                  (result as PromiseFulfilledResult<NativeProjectSaveArtifact['roles'][number]>)
                    .value,
              );
            },
          );
        const roles =
          options.operate && entry.roles.some((role) => role.binding)
            ? await options.operate('Capturing native project Save', work)
            : await work();
        assertCurrent(entry, context.signal);
        entry.artifact = freeze({ id, expectedRevision: entry.summary.expectedRevision, roles });
        entry.summary = freeze({
          ...entry.summary,
          phase: 'ready',
          roles: roles.map(({ slot, source, identity, capturedAt }) => ({
            slot,
            source,
            ...(identity ? { identity } : {}),
            ...(capturedAt ? { capturedAt } : {}),
          })),
        });
        return entry.artifact;
      } catch (failure) {
        if (entry.live && captures.get(id) === entry)
          entry.summary = freeze({ ...entry.summary, phase: 'error', error: problem(failure) });
        clearData(entry);
        throw new NativeProjectSaveError(problem(failure));
      } finally {
        flights.delete(entry);
        if (!entry.live) clearData(entry);
        publish();
      }
    })();
    return entry.promise;
  };
  const release = (id: string, context: ToolExecutionContext) => {
    const principal = actor(context),
      entry = captures.get(id);
    if (!entry) return;
    if (entry.owner !== principal.owner)
      throw new NativeProjectSaveError('Native project capture belongs to another workspace');
    entry.live = false;
    captures.delete(id);
    if (!flights.has(entry)) clearData(entry);
    publish();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status(context) {
      const principal = actor(context);
      return freeze({
        captures: snapshot.captures.filter(
          (summary) => captures.get(summary.id)?.owner === principal.owner,
        ),
        busy: flights.size > 0,
      });
    },
    stage,
    resolve,
    release,
    ticket(binding, project) {
      const context = { ...binding.principal },
        provided = projectSchema.parse(project),
        implicit = binding.exportId === undefined;
      const id =
        binding.exportId ??
        stage(
          {
            target: binding.slot,
            expectedRevision: binding.expectedRevision,
            mode: binding.metadata ?? 'auto',
          },
          context,
        ).id;
      const entry = owned(id, context),
        role = entry.roles.find((role) => role.slot === binding.slot);
      if (
        !role ||
        entry.summary.expectedRevision !== binding.expectedRevision ||
        (binding.metadata !== undefined && entry.summary.mode !== binding.metadata) ||
        JSON.stringify(projectSchema.parse(role.project)) !== JSON.stringify(provided)
      ) {
        if (implicit) release(id, context);
        throw new NativeProjectSaveError(
          'Save capture does not match the fixed role, revision or design',
        );
      }
      return {
        async resolve() {
          const artifact = await resolve(id, context),
            saved = artifact.roles.find((role) => role.slot === binding.slot)!;
          return { project: saved.project, files: saved.files };
        },
        assertCurrent() {
          assertCurrent(entry);
        },
        dispose() {
          if (implicit && entry.live) {
            entry.live = false;
            captures.delete(id);
            if (!flights.has(entry)) clearData(entry);
            publish();
          }
        },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of captures.values()) {
        entry.live = false;
        if (!flights.has(entry)) clearData(entry);
      }
      captures.clear();
      publish();
      listeners.clear();
    },
  };
}
