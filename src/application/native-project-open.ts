import type { Project, Slot } from '../domain/model';
import { assertProjectLinks } from '../domain/links';
import {
  defaultHfdMeasurementOptions,
  reconcileProjectHfdCalibration,
  recomputeHfdMeasurement,
} from '../domain/hfd-measurement';
import { applyColdNativeFileOpenGraph } from './native-graph-entry';
import { copyNativeLinkedChannel, settleNativeLinkedCopyCache } from '../domain/native-linked-copy';
import { phaseCurveAvailable } from './graph-view';
import {
  applyNativeGlobalDelayReconciliation,
  planNativeGlobalDelayReconciliation,
  type NativeGlobalDelayReconciliationPlan,
} from '../domain/native-global-delay';

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
export interface NativeProjectOpenLinkResolution {
  /** Original saved preset, before the later runtime selection is applied. */
  readonly resolvedPresetIndex: number;
  readonly unresolvedLinks: readonly Readonly<{
    presetIndex: number;
    channelIndex: number;
    channelId: string;
    linkedTo: number;
  }>[];
  /** Browser explanation of actual deactivation, not a native popup claim. */
  readonly warning?: string;
}
export interface NativeProjectOpenPatch {
  /** Raw loader reconciliation in the ORIGINAL saved preset, before selection. */
  readonly globalDelayReconciliation?: NativeGlobalDelayReconciliationPlan;
  readonly hfdSelectedPreset?: number;
  readonly linkResolution?: NativeProjectOpenLinkResolution;
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

function linkResolution(project: Readonly<Project>): NativeProjectOpenLinkResolution | undefined {
  if (!project.presets.some((preset) => preset.channels.some((c) => c.linkedTo !== undefined)))
    return undefined;
  const savedPreset = project.hfdSelectedPreset;
  assert(
    savedPreset !== undefined && savedPreset >= 1 && savedPreset <= 3,
    'Native Open with channel links requires original saved preset 1–3',
  );
  const resolvedPresetIndex = savedPreset - 1,
    unresolvedLinks = Object.freeze(
      project.presets.flatMap((preset, presetIndex) =>
        presetIndex === resolvedPresetIndex
          ? []
          : preset.channels.flatMap((channel, channelIndex) =>
              channel.linkedTo === undefined
                ? []
                : [
                    Object.freeze({
                      presetIndex,
                      channelIndex,
                      channelId: channel.id,
                      linkedTo: channel.linkedTo,
                    }),
                  ],
            ),
      ),
    ),
    explanation = `Native Open resolved channel links only in saved preset ${savedPreset}; ${unresolvedLinks.length} unresolved ${unresolvedLinks.length === 1 ? 'link' : 'links'} in other presets were deactivated.`;
  return Object.freeze({
    resolvedPresetIndex,
    unresolvedLinks,
    ...(unresolvedLinks.length && !project.warnings.includes(explanation)
      ? { warning: explanation }
      : {}),
  });
}

function savedGlobalDelayReconciliation(
  project: Readonly<Project>,
): NativeGlobalDelayReconciliationPlan | undefined {
  const savedPreset = project.hfdSelectedPreset;
  if (savedPreset !== undefined && savedPreset >= 1 && savedPreset <= 3) {
    const plan = planNativeGlobalDelayReconciliation(project, savedPreset - 1);
    return plan.changed ? plan : undefined;
  }
  // Retained legacy selection can be absent or unsupported. Only accept it
  // when every possible loader target proves inert, without guessing a preset
  // or requiring maximum metadata that a no-op never reads.
  assert(
    project.presets.every((preset) =>
      preset.channels.every(
        (channel) =>
          Number.isFinite(channel.globalDelayUs) &&
          channel.globalDelayUs === preset.channels[0].globalDelayUs,
      ),
    ),
    'Native Open requires original saved preset 1–3 to reconcile differing Global delays; reopen the original HFD project',
  );
  return undefined;
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
  const resolution = linkResolution(project),
    globalDelayReconciliation = savedGlobalDelayReconciliation(project),
    group = project.hfdSelectedGroupId,
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
      ...(globalDelayReconciliation ? { globalDelayReconciliation } : {}),
      ...(Object.is(project.hfdSelectedPreset, request.presetIndex + 1)
        ? {}
        : { hfdSelectedPreset: request.presetIndex + 1 }),
      ...(resolution ? { linkResolution: resolution } : {}),
      microphoneChanges,
    });
  const plan: NativeProjectOpenPlan = Object.freeze({
    slot,
    presetIndex: request.presetIndex,
    route: request.route,
    channelIndex,
    ...(channelIndex === null ? {} : { channelId: channels[channelIndex].id }),
    changed:
      globalDelayReconciliation !== undefined ||
      patch.hfdSelectedPreset !== undefined ||
      microphoneChanges.length > 0 ||
      (resolution?.unresolvedLinks.length ?? 0) > 0 ||
      resolution?.warning !== undefined,
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
  if (plan.patch.globalDelayReconciliation)
    applyNativeGlobalDelayReconciliation(project, plan.patch.globalDelayReconciliation);
  if (plan.patch.hfdSelectedPreset !== undefined)
    project.hfdSelectedPreset = plan.patch.hfdSelectedPreset;
  if (plan.patch.linkResolution) {
    for (const change of plan.patch.linkResolution.unresolvedLinks)
      delete project.presets[change.presetIndex].channels[change.channelIndex].linkedTo;
    const warning = plan.patch.linkResolution.warning;
    if (warning !== undefined && !project.warnings.includes(warning))
      project.warnings.push(warning);
  }
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
    const linked =
      project.presets[selection.presetIndex].channels[selection.channelIndex].linkedTo !==
      undefined;
    if (linked) copyNativeLinkedChannel(project, selection.presetIndex, selection.channelIndex);
    applyColdNativeFileOpenGraph(
      project,
      { slot, presetIndex: selection.presetIndex, channelIndex: selection.channelIndex },
      request.route,
    );
    if (linked) settleNativeLinkedCopyCache(project, selection.presetIndex, selection.channelIndex);
    const channel = project.presets[selection.presetIndex].channels[selection.channelIndex];
    if (channel.hfdGraph?.showMeasuredResponse && !phaseCurveAvailable(channel))
      channel.hfdGraph = { ...channel.hfdGraph, showMeasuredResponse: false };
  }
  // The outer dialog reconciles the CHOSEN preset after OpenFile's selected
  // Graph construction. Inner OpenFile routes have only the loader stage.
  // This is raw document reconciliation, separate from notified delay fields.
  if (request.route === 'dialog') {
    const global = planNativeGlobalDelayReconciliation(project, request.presetIndex);
    if (global.changed) applyNativeGlobalDelayReconciliation(project, global);
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
