import type { Project, Slot } from '../domain/model';
import { assertProjectLinks } from '../domain/links';
import { normalizeHardwareGainCallback } from '../domain/hardware-gain';
import { defaultHfdMeasurementOptions } from '../domain/hfd-measurement';
import type { NativeProjectOpenRoute } from './native-project-open';

export interface NativeGraphEntryRequest {
  slot: Slot;
  presetIndex: number;
  channelIndex: number;
  /** A qualified channel-navigation action, independently of construction. */
  explicitChannelSelection?: boolean;
}
export interface NativeGraphEntryPatch {
  gain?: number;
  additionalGain?: number;
  hfdGainLowered?: boolean;
  applyMicCorrection?: boolean;
  hfdSelectedGroupId?: number;
}
export interface NativeGraphEntryPlan {
  readonly slot: Slot;
  readonly presetIndex: number;
  readonly channelIndex: number;
  readonly channelId: string;
  readonly revision: number;
  readonly generation: number;
  readonly fresh: boolean;
  readonly changed: boolean;
  readonly patch: Readonly<NativeGraphEntryPatch>;
}
export interface NativeGraphEntryWorkspace {
  documents: Readonly<Record<Slot, Project>>;
  documentRevision?: number;
}
export interface NativeGraphEntryController {
  plan(request: NativeGraphEntryRequest): NativeGraphEntryPlan;
  /** Only a newly loaded role generation may receive native file-open effects. */
  planNativeFileOpen(
    request: Omit<NativeGraphEntryRequest, 'explicitChannelSelection'>,
    route: NativeProjectOpenRoute,
  ): NativeGraphEntryPlan;
  /** The trusted publisher combines this apply function with other view deltas
   * in its one synchronous transaction. It is also called for canonical no-ops. */
  commit(
    plan: NativeGraphEntryPlan,
    publish: (apply: (project: Project, slot: Slot) => void) => void,
  ): NativeGraphEntryPlan;
  invalidateRoles(slots: readonly Slot[]): void;
}

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
function target(project: Project, request: NativeGraphEntryRequest) {
  assert(
    project?.model === 'FA503' && project.sampleRate === 93750 && project.presets.length === 3,
    'Native graph entry requires an FA503 project',
  );
  const channels = project.presets.flatMap((p) => p.channels);
  assert(
    project.presets.every((p) => p.channels.length === 3) && new Set(channels).size === 9,
    'Aliased or malformed graph channels',
  );
  assertProjectLinks(project);
  const channel = project.presets[request.presetIndex].channels[request.channelIndex];
  assert(
    typeof channel.id === 'string' &&
      channel.id.length &&
      channel.filters.length === 15 &&
      Number.isFinite(channel.gain) &&
      Number.isFinite(channel.additionalGain ?? 0),
    'Invalid native graph channel',
  );
  assert(
    project.hfdCalibration === undefined || typeof project.hfdCalibration.loaded === 'boolean',
    'Invalid native microphone context',
  );
  return channel;
}
function context(project: Project, request: NativeGraphEntryRequest) {
  const channel = target(project, request);
  return {
    id: channel.id,
    gain: channel.gain,
    additionalGain: channel.additionalGain,
    linkedTo: channel.linkedTo,
    coefficientCache: channel.coefficientCache,
    filters: channel.filters,
    hfdMeasurement: channel.hfdMeasurement,
    hfdGainLowered: project.hfdGainLowered,
    hfdSelectedGroupId: project.hfdSelectedGroupId,
    microphoneLoaded: project.hfdCalibration?.loaded,
  };
}

function coldPatch(
  project: Project,
  request: NativeGraphEntryRequest,
  route?: NativeProjectOpenRoute,
): NativeGraphEntryPatch {
  const channel = target(project, request),
    patch: NativeGraphEntryPatch = {};
  if ((channel.additionalGain ?? 0) !== 0) {
    const result = normalizeHardwareGainCallback(channel, true);
    // Native +f8 suppresses Gain storage, not the local offset/hint callback.
    if (channel.linkedTo === undefined && !Object.is(channel.gain, result.gain))
      patch.gain = result.gain;
    if (!Object.is(channel.additionalGain, result.additionalGain))
      patch.additionalGain = result.additionalGain;
    if (!Object.is(project.hfdGainLowered, result.hfdGainLowered))
      patch.hfdGainLowered = result.hfdGainLowered;
  }
  if (route === 'dialog') {
    const finalMic = project.hfdCalibration?.loaded !== false;
    if (channel.hfdMeasurement?.applyMicCorrection !== finalMic)
      patch.applyMicCorrection = finalMic;
  } else if (
    project.hfdCalibration?.loaded === false &&
    channel.hfdMeasurement?.applyMicCorrection === true
  )
    patch.applyMicCorrection = false;
  return patch;
}
function applyPatch(
  project: Project,
  request: NativeGraphEntryRequest,
  patch: Readonly<NativeGraphEntryPatch>,
) {
  const channel = target(project, request);
  if (patch.gain !== undefined) channel.gain = patch.gain;
  if (patch.additionalGain !== undefined) channel.additionalGain = patch.additionalGain;
  if (patch.hfdGainLowered !== undefined) project.hfdGainLowered = patch.hfdGainLowered;
  if (patch.applyMicCorrection !== undefined)
    channel.hfdMeasurement = {
      ...(channel.hfdMeasurement ?? defaultHfdMeasurementOptions()),
      applyMicCorrection: patch.applyMicCorrection,
    };
  if (patch.hfdSelectedGroupId !== undefined) project.hfdSelectedGroupId = patch.hfdSelectedGroupId;
}
/** Shared cold constructor operation for a caller-owned detached native import.
 * It grants no lifetime authority and performs no workspace or I/O operation. */
export function applyColdNativeFileOpenGraph(
  project: Project,
  request: Omit<NativeGraphEntryRequest, 'explicitChannelSelection'>,
  route: NativeProjectOpenRoute,
): Readonly<NativeGraphEntryPatch> {
  assert(
    request &&
      (request.slot === 'left' || request.slot === 'right') &&
      [request.presetIndex, request.channelIndex].every(
        (n) => Number.isInteger(n) && n >= 0 && n < 3,
      ) &&
      Object.keys(request).every((key) => ['slot', 'presetIndex', 'channelIndex'].includes(key)) &&
      (route === 'dialog' || route === 'inner'),
    'Invalid cold native file-open graph request',
  );
  const patch = Object.freeze(coldPatch(project, request, route));
  applyPatch(project, request, patch);
  return patch;
}

/** Native Graph lifetime is an application context, not a Numeric mount, file
 * parser or status getter. Planning is inert; only an admitted synchronous
 * publication claims a visit. Undo restores model bytes without replaying it. */
export function createNativeGraphEntryController(options: {
  current: () => NativeGraphEntryWorkspace;
}): NativeGraphEntryController {
  const generations: Record<Slot, number> = { left: 0, right: 0 };
  const visits: Record<Slot, Set<string>> = { left: new Set(), right: new Set() };
  type Binding = {
    request: NativeGraphEntryRequest;
    workspace: NativeGraphEntryWorkspace;
    project: Project;
    before: ReturnType<typeof context>;
    key: string;
    nativeFileOpen?: boolean;
  };
  const pending = new WeakMap<NativeGraphEntryPlan, Binding>();
  const current = () => {
    const value = options.current();
    assert(
      value &&
        typeof value.documentRevision === 'number' &&
        Number.isSafeInteger(value.documentRevision) &&
        value.documentRevision >= 0 &&
        value.documents?.left &&
        value.documents.right &&
        value.documents.left !== value.documents.right,
      'Invalid native graph workspace',
    );
    const channels = Object.values(value.documents).flatMap((project) =>
      project.presets.flatMap((preset) => preset.channels),
    );
    assert(new Set(channels).size === 18, 'Aliased native graph roles');
    return { documents: value.documents, documentRevision: value.documentRevision };
  };
  const check = (plan: NativeGraphEntryPlan, binding: Binding) => {
    const latest = current();
    assert(
      generations[plan.slot] === plan.generation &&
        latest.documentRevision === plan.revision &&
        latest.documents === binding.workspace.documents &&
        latest.documents[plan.slot] === binding.project &&
        (!binding.nativeFileOpen || visits[plan.slot].size === 0) &&
        plan.fresh === !visits[plan.slot].has(binding.key) &&
        same(context(latest.documents[plan.slot], binding.request), binding.before),
      'Native graph entry target changed',
    );
  };
  const controller: NativeGraphEntryController = {
    plan(request) {
      assert(
        request &&
          (request.slot === 'left' || request.slot === 'right') &&
          [request.presetIndex, request.channelIndex].every(
            (n) => Number.isInteger(n) && n >= 0 && n < 3,
          ) &&
          (request.explicitChannelSelection === undefined ||
            typeof request.explicitChannelSelection === 'boolean') &&
          Object.keys(request).every((k) =>
            ['slot', 'presetIndex', 'channelIndex', 'explicitChannelSelection'].includes(k),
          ),
        'Invalid native graph entry request',
      );
      const workspace = current(),
        project = workspace.documents[request.slot],
        channel = target(project, request);
      const generation = generations[request.slot],
        key = JSON.stringify([generation, request.presetIndex, request.channelIndex, channel.id]);
      const fresh = !visits[request.slot].has(key),
        patch: NativeGraphEntryPatch = {};
      if (fresh) Object.assign(patch, coldPatch(project, request));
      if (
        request.explicitChannelSelection &&
        !Object.is(project.hfdSelectedGroupId, request.channelIndex + 1)
      )
        patch.hfdSelectedGroupId = request.channelIndex + 1;
      const plan: NativeGraphEntryPlan = Object.freeze({
        slot: request.slot,
        presetIndex: request.presetIndex,
        channelIndex: request.channelIndex,
        channelId: channel.id,
        revision: workspace.documentRevision,
        generation,
        fresh,
        changed: Object.keys(patch).length > 0,
        patch: Object.freeze(patch),
      });
      pending.set(plan, {
        request: { ...request },
        workspace: { ...workspace },
        project,
        before: structuredClone(context(project, request)),
        key,
      });
      return plan;
    },
    planNativeFileOpen(request, route) {
      assert(
        request &&
          (request.slot === 'left' || request.slot === 'right') &&
          Object.keys(request).every((key) =>
            ['slot', 'presetIndex', 'channelIndex'].includes(key),
          ) &&
          (route === 'dialog' || route === 'inner'),
        'Invalid native file-open graph request or route',
      );
      assert(
        visits[request.slot].size === 0,
        'Native file-open graph requires a fresh role generation',
      );
      const initial = controller.plan(request),
        binding = pending.get(initial)!,
        patch = coldPatch(binding.project, request, route);
      const plan: NativeGraphEntryPlan = Object.freeze({
        ...initial,
        changed: Object.keys(patch).length > 0,
        patch: Object.freeze(patch),
      });
      pending.delete(initial);
      pending.set(plan, { ...binding, nativeFileOpen: true });
      return plan;
    },
    commit(plan, publish) {
      const binding = pending.get(plan);
      assert(binding && typeof publish === 'function', 'Unknown native graph entry plan');
      check(plan, binding);
      pending.delete(plan);
      let applied = false;
      const result: unknown = (
        publish as (apply: (project: Project, slot: Slot) => void) => unknown
      )((project, slot) => {
        check(plan, binding);
        assert(
          slot === plan.slot &&
            project !== binding.workspace.documents.left &&
            project !== binding.workspace.documents.right &&
            same(context(project, binding.request), binding.before),
          'Native graph entry requires its matching detached role proposal',
        );
        applyPatch(project, binding.request, plan.patch);
        applied = true;
      });
      if (
        result &&
        (typeof result === 'object' || typeof result === 'function') &&
        typeof (result as PromiseLike<unknown>).then === 'function'
      ) {
        void Promise.resolve(result).catch(() => {});
        throw new Error('Native graph entry publication must be synchronous');
      }
      assert(
        generations[plan.slot] === plan.generation &&
          plan.fresh === !visits[plan.slot].has(binding.key) &&
          (!binding.nativeFileOpen || visits[plan.slot].size === 0) &&
          (!plan.changed || applied),
        'Native graph entry was not published in its current generation',
      );
      const after = current(),
        expected = structuredClone(binding.before),
        patch = plan.patch;
      if (patch.gain !== undefined) expected.gain = patch.gain;
      if (patch.additionalGain !== undefined) expected.additionalGain = patch.additionalGain;
      if (patch.hfdGainLowered !== undefined) expected.hfdGainLowered = patch.hfdGainLowered;
      if (patch.applyMicCorrection !== undefined)
        expected.hfdMeasurement = {
          ...(expected.hfdMeasurement ?? defaultHfdMeasurementOptions()),
          applyMicCorrection: patch.applyMicCorrection,
        };
      if (patch.hfdSelectedGroupId !== undefined)
        expected.hfdSelectedGroupId = patch.hfdSelectedGroupId;
      assert(
        same(context(after.documents[plan.slot], binding.request), expected) &&
          (!plan.changed ||
            (after.documentRevision > plan.revision &&
              after.documents[plan.slot] !== binding.project)),
        'Native graph entry proposal was not published',
      );
      visits[plan.slot].add(binding.key);
      return plan;
    },
    invalidateRoles(slots) {
      assert(
        Array.isArray(slots) &&
          new Set(slots).size === slots.length &&
          slots.every((slot) => slot === 'left' || slot === 'right'),
        'Invalid native graph roles',
      );
      slots.forEach((slot: Slot) => {
        generations[slot]++;
        visits[slot].clear();
      });
    },
  };
  return controller;
}
