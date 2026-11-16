import type { Project, Slot } from '../domain/model';
import { assertProjectLinks } from '../domain/links';
import {
  defaultHfdMeasurementOptions,
  reconcileProjectHfdCalibration,
  recomputeHfdMeasurement,
} from '../domain/hfd-measurement';
import { applyColdNativeFileOpenGraph } from './native-graph-entry';
import { phaseCurveAvailable } from './graph-view';

export type NativeProjectOpenRoute = 'dialog' | 'inner';
/** Trusted parser/source outcome, never a caller-supplied command flag. */
export type ProjectReplacementIntent =
  | { kind: 'native-file-open'; route: NativeProjectOpenRoute }
  | { kind: 'snapshot' | 'new-project' };

export interface NativeProjectOpenRequest {
  /** Chosen runtime preset: offline P1 or a separately validated panel status. */
  presetIndex: number;
  route: NativeProjectOpenRoute;
}
export interface NativeProjectOpenPatch {
  readonly hfdSelectedPreset?: number;
  /** The opened Graph owns its own final microphone state. */
  readonly microphoneChanges: readonly Readonly<{
    channelIndex: number;
    channelId: string;
    applyMicCorrection: true;
  }>[];
}
export interface NativeProjectOpenPlan {
  readonly slot: Slot;
  readonly presetIndex: number;
  readonly route: NativeProjectOpenRoute;
  readonly channelIndex: number | null;
  readonly channelId?: string;
  readonly changed: boolean;
  readonly patch: NativeProjectOpenPatch;
}
export interface PreparedNativeProjectOpen {
  /** Complete caller-owned proposal; never published by this preparer. */
  readonly project: Project;
  readonly plan: NativeProjectOpenPlan;
  readonly selection: Readonly<{
    presetIndex: number;
    channelIndex: number;
    channelId: string;
  }> | null;
}

const bindings = new WeakMap<
  NativeProjectOpenPlan,
  {
    project: Readonly<Project>;
    before: Project;
  }
>();
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}
function checkProject(project: Readonly<Project>) {
  assert(
    project?.model === 'FA503' && project.sampleRate === 93750 && project.presets?.length === 3,
    'Native Open requires an FA503 project',
  );
  const channels = project.presets.flatMap((preset) => preset.channels);
  assert(
    project.presets.every((preset) => preset.channels.length === 3) &&
      new Set(channels).size === 9 &&
      channels.every(
        (channel) =>
          typeof channel.id === 'string' &&
          channel.id.length &&
          channel.filters.length === 15 &&
          Number.isFinite(channel.gain) &&
          Number.isFinite(channel.additionalGain ?? 0),
      ),
    'Invalid or aliased Native Open channels',
  );
  for (const value of [project.hfdSelectedGroupId, project.hfdSelectedPreset])
    assert(
      value === undefined ||
        (Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1),
      'Invalid native saved selection',
    );
  assertProjectLinks(project);
}

/** Inert document delta. The runtime preset is supplied by trusted coordination,
 * never inferred from saved XML or a Clone template. No Graph is claimed here. */
export function planNativeProjectOpen(
  project: Readonly<Project>,
  slot: Slot,
  request: NativeProjectOpenRequest,
): NativeProjectOpenPlan {
  assert(
    (slot === 'left' || slot === 'right') &&
      request &&
      Number.isInteger(request.presetIndex) &&
      request.presetIndex >= 0 &&
      request.presetIndex < 3 &&
      (request.route === 'dialog' || request.route === 'inner') &&
      Object.keys(request).every((key) => ['presetIndex', 'route'].includes(key)),
    'Invalid Native Open request',
  );
  checkProject(project);
  const group = project.hfdSelectedGroupId,
    channelIndex =
      group === -1 ? 0 : group !== undefined && group >= 1 && group <= 3 ? group - 1 : null,
    channels = project.presets[request.presetIndex].channels,
    microphoneChanges: NativeProjectOpenPatch['microphoneChanges'] = Object.freeze(
      request.route === 'dialog'
        ? channels.flatMap((channel, index) =>
            index === channelIndex || channel.hfdMeasurement?.applyMicCorrection === true
              ? []
              : [
                  Object.freeze({
                    channelIndex: index,
                    channelId: channel.id,
                    applyMicCorrection: true as const,
                  }),
                ],
          )
        : [],
    ),
    patch: NativeProjectOpenPatch = Object.freeze({
      ...(Object.is(project.hfdSelectedPreset, request.presetIndex + 1)
        ? {}
        : { hfdSelectedPreset: request.presetIndex + 1 }),
      microphoneChanges,
    });
  const plan: NativeProjectOpenPlan = Object.freeze({
    slot,
    presetIndex: request.presetIndex,
    route: request.route,
    channelIndex,
    ...(channelIndex === null ? {} : { channelId: channels[channelIndex].id }),
    changed: patch.hfdSelectedPreset !== undefined || microphoneChanges.length > 0,
    patch,
  });
  bindings.set(plan, { project, before: structuredClone(project) });
  return plan;
}

/** All roles must validate against their captured original before publication. */
export function validateNativeProjectOpen(
  plan: NativeProjectOpenPlan,
  project: Readonly<Project>,
  slot: Slot,
): void {
  const binding = bindings.get(plan);
  assert(
    binding && slot === plan.slot && project === binding.project && same(project, binding.before),
    'Native Open target changed or plan belongs to another role',
  );
}

/** Apply to a detached matching proposal before the selected Graph-entry delta.
 * There is no global link synchronization or file/measurement processing. */
export function applyNativeProjectOpen(
  project: Project,
  slot: Slot,
  plan: NativeProjectOpenPlan,
): void {
  const binding = bindings.get(plan);
  assert(
    binding &&
      slot === plan.slot &&
      project !== binding.project &&
      same(binding.project, binding.before) &&
      same(project, binding.before),
    'Native Open requires its matching detached role proposal',
  );
  if (plan.patch.hfdSelectedPreset !== undefined)
    project.hfdSelectedPreset = plan.patch.hfdSelectedPreset;
  for (const change of plan.patch.microphoneChanges) {
    const channel = project.presets[plan.presetIndex].channels[change.channelIndex];
    channel.hfdMeasurement = {
      ...(channel.hfdMeasurement ?? defaultHfdMeasurementOptions()),
      applyMicCorrection: true,
    };
  }
}

/** Finish native load and cold Graph effects before replacement/receipt storage.
 * The post-publication controller only claims the real visit on this final data. */
export function prepareNativeProjectOpen(
  importedProject: Readonly<Project>,
  slot: Slot,
  request: NativeProjectOpenRequest,
): PreparedNativeProjectOpen {
  const plan = planNativeProjectOpen(importedProject, slot, request),
    project = structuredClone(importedProject),
    selection =
      plan.channelIndex === null
        ? null
        : Object.freeze({
            presetIndex: plan.presetIndex,
            channelIndex: plan.channelIndex,
            channelId: plan.channelId!,
          });
  applyNativeProjectOpen(project, slot, plan);
  if (selection) {
    applyColdNativeFileOpenGraph(
      project,
      { slot, presetIndex: selection.presetIndex, channelIndex: selection.channelIndex },
      request.route,
    );
    const channel = project.presets[selection.presetIndex].channels[selection.channelIndex];
    if (channel.hfdGraph?.showMeasuredResponse && !phaseCurveAvailable(channel))
      channel.hfdGraph = { ...channel.hfdGraph, showMeasuredResponse: false };
  }
  if (project.hfdCalibration) reconcileProjectHfdCalibration(project, importedProject);
  else
    for (let p = 0; p < project.presets.length; p++)
      for (let c = 0; c < project.presets[p].channels.length; c++) {
        const channel = project.presets[p].channels[c];
        if (
          channel.hfdMeasurement &&
          !same(channel.hfdMeasurement, importedProject.presets[p].channels[c].hfdMeasurement)
        )
          recomputeHfdMeasurement(channel);
      }
  return Object.freeze({ project, plan, selection });
}
