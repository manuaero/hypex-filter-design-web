import { assertProjectLinks, rootChannel, synchronizeLinkedGroup } from './links';
import type { Channel, Filter, Project, Slot } from './model';
import {
  hardwareGainPresentation,
  normalizeHardwareGainCallback,
  type HardwareGainCallbackResult,
} from './hardware-gain';

export type ChannelEditValues = Pick<
  Channel,
  'name' | 'outputName' | 'includeInSum' | 'gain' | 'invert' | 'muted' | 'delayUs' | 'globalDelayUs'
>;
export type ChannelEditPatch = Partial<ChannelEditValues> & { hardwareGain?: boolean };
/** Existing browser/MCP authoring bounds, not native callback qualification.
 * Values are validated exactly: no new rounding, clamping or import changes. */
export const CHANNEL_EDIT_BOUNDS = Object.freeze({
  gain: Object.freeze({ min: -96, max: 18 }),
  delayUs: Object.freeze({ min: 0, max: 32000 }),
  globalDelayUs: Object.freeze({ min: 0, max: 74666.6666667 }),
});
export interface ChannelEditRequest {
  presetIndex: number;
  channelIndex: number;
  patch: ChannelEditPatch;
}
export interface ChannelEditOptions {
  /** Trusted current visible view context, never caller-supplied command data.
   * A latched view remains available after Off; absent views use fresh state. */
  hardwareGainContext?: Partial<Record<Slot, { available: boolean; gainText?: string }>>;
}
interface ChannelContext {
  id: string;
  linkedTo: number | undefined;
  values: ChannelEditValues;
  additionalGain: number | undefined;
  coefficientCache: Channel['coefficientCache'];
  filters: Filter[];
}
export interface ChannelEditPlan {
  request: ChannelEditRequest;
  revision?: number;
  changedSlots: Slot[];
  /** applyChannelEdit synchronizes only roles with actual processing changes.
   * The publishing workspace must not perform a second global link copy. */
  synchronizeLinks: false;
  roles: {
    slot: Slot;
    before: ChannelEditValues;
    value: ChannelEditValues;
    changed: boolean;
    synchronizeLinks: boolean;
    context: ChannelContext[];
    hardwareGain?: { beforeHint: boolean | undefined; result: HardwareGainCallbackResult };
    changes: {
      channelIndex: number;
      before: ChannelEditValues;
      value: ChannelEditValues;
      patch: ChannelEditPatch;
    }[];
  }[];
}
const fields = [
  'name',
  'outputName',
  'includeInSum',
  'gain',
  'invert',
  'muted',
  'delayUs',
  'globalDelayUs',
] as const;
const processing = ['gain', 'invert', 'muted', 'delayUs'] as const;
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    !a ||
    !b ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
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
const values = (channel: Channel): ChannelEditValues => ({
  name: channel.name,
  outputName: channel.outputName,
  includeInSum: channel.includeInSum,
  gain: channel.gain,
  invert: channel.invert,
  muted: channel.muted,
  delayUs: channel.delayUs,
  globalDelayUs: channel.globalDelayUs,
});
function checkedPatch(input: ChannelEditPatch): ChannelEditPatch {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid channel patch');
  if (Object.hasOwn(input, 'hardwareGain')) {
    if (Object.keys(input).length !== 1 || typeof input.hardwareGain !== 'boolean')
      throw new Error('Hardware gain compensation must be a sole boolean intent');
    return { hardwareGain: input.hardwareGain };
  }
  const result: ChannelEditPatch = {};
  for (const key of Object.keys(input)) {
    if (!(fields as readonly string[]).includes(key))
      throw new Error('Unsupported channel edit field: ' + key);
    const field = key as keyof ChannelEditValues,
      value = input[field];
    if (value === undefined) continue;
    if (field === 'name' || field === 'outputName') {
      if (typeof value !== 'string') throw new Error('Channel labels must be strings');
    } else if (field === 'includeInSum' || field === 'invert' || field === 'muted') {
      if (typeof value !== 'boolean') throw new Error('Channel flags must be boolean');
    } else {
      const bounds = CHANNEL_EDIT_BOUNDS[field];
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < bounds.min ||
        value > bounds.max
      )
        throw new Error('Channel ' + field + ' outside existing authoring bounds');
    }
    Object.assign(result, { [field]: value });
  }
  return result;
}
function target(
  project: Project,
  request: Pick<ChannelEditRequest, 'presetIndex' | 'channelIndex'>,
) {
  if (
    !project ||
    project.model !== 'FA503' ||
    project.sampleRate !== 93750 ||
    project.presets.length !== 3
  )
    throw new Error('Channel editing requires an independent FA503 design');
  if (
    ![request.presetIndex, request.channelIndex].every(Number.isSafeInteger) ||
    request.presetIndex < 0 ||
    request.presetIndex > 2 ||
    request.channelIndex < 0 ||
    request.channelIndex > 2
  )
    throw new Error('Invalid channel edit target');
  const channels = project.presets.flatMap((p) => p.channels);
  if (
    new Set(project.presets).size !== 3 ||
    channels.length !== 9 ||
    new Set(channels).size !== 9 ||
    project.presets.some((p) => p.channels.length !== 3)
  )
    throw new Error('Aliased or malformed channel structure');
  for (const channel of channels)
    if (
      channel.filters.length !== 15 ||
      channels.some((other) => other !== channel && other.filters === channel.filters)
    )
      throw new Error('Aliased or malformed channel biquad arrays');
  assertProjectLinks(project);
  const preset = project.presets[request.presetIndex];
  const context: ChannelContext[] = preset.channels.map((channel) => {
    if (
      !channel.id ||
      typeof channel.name !== 'string' ||
      typeof channel.outputName !== 'string' ||
      ![channel.gain, channel.delayUs, channel.globalDelayUs].every(Number.isFinite) ||
      (channel.additionalGain !== undefined && !Number.isFinite(channel.additionalGain)) ||
      typeof channel.invert !== 'boolean' ||
      typeof channel.muted !== 'boolean' ||
      (channel.includeInSum !== undefined && typeof channel.includeInSum !== 'boolean')
    )
      throw new Error('Malformed channel edit context');
    return {
      id: channel.id,
      linkedTo: channel.linkedTo,
      values: values(channel),
      additionalGain: channel.additionalGain,
      coefficientCache: channel.coefficientCache,
      filters: structuredClone(channel.filters),
    };
  });
  return { preset, context };
}

/** Shared authoring transaction. All selected role roots validate even for equal
 * requested processing values. Native compensation is an explicit, conditional
 * callback intent; ordinary scalar patches retain their existing validation. */
export function planChannelEdit(
  documents: Record<Slot, Project>,
  slots: readonly Slot[],
  request: ChannelEditRequest,
  revision?: number,
  options: ChannelEditOptions = {},
): ChannelEditPlan {
  if (
    !slots.length ||
    slots.length > 2 ||
    new Set(slots).size !== slots.length ||
    slots.some((slot) => slot !== 'left' && slot !== 'right')
  )
    throw new Error('Invalid channel edit roles');
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0))
    throw new Error('Invalid channel edit revision');
  const patch = checkedPatch(request.patch),
    checkedRequest = {
      presetIndex: request.presetIndex,
      channelIndex: request.channelIndex,
      patch,
    };
  const targets = slots.map((slot) => ({ slot, ...target(documents[slot], request) }));
  const structural = slots.map(
    (slot) =>
      new Set<object>([
        documents[slot],
        ...documents[slot].presets.flatMap((p) => [
          p,
          p.channels,
          ...p.channels.flatMap((c) => [c, c.filters, ...c.filters]),
        ]),
      ]),
  );
  if (structural.length === 2 && [...structural[0]].some((value) => structural[1].has(value)))
    throw new Error('Channel edit roles alias processing objects');
  const requestsHardware = Object.hasOwn(patch, 'hardwareGain');
  const requestsProcessing =
    requestsHardware || processing.some((field) => Object.hasOwn(patch, field));
  for (const role of targets)
    if (
      requestsProcessing &&
      rootChannel(role.preset, request.channelIndex) !== request.channelIndex
    )
      throw new Error(`${role.slot} channel is linked; edit its master or unlink it first`);
  const roles = targets.map(({ slot, preset, context }) => {
    const channel = preset.channels[request.channelIndex];
    let hardwareGain: ChannelEditPlan['roles'][number]['hardwareGain'];
    let ordinaryPatch = patch;
    if (requestsHardware) {
      const trusted = options.hardwareGainContext?.[slot];
      if (
        trusted &&
        (typeof trusted.available !== 'boolean' ||
          (trusted.gainText !== undefined && typeof trusted.gainText !== 'string'))
      )
        throw new Error('Invalid trusted hardware gain context');
      if (!(trusted?.available ?? hardwareGainPresentation(channel).available))
        throw new Error(
          `${slot} hardware gain compensation is unavailable in this channel context`,
        );
      const result = normalizeHardwareGainCallback(channel, patch.hardwareGain!, {
        gainText: trusted?.gainText,
      });
      hardwareGain = { beforeHint: documents[slot].hfdGainLowered, result };
      ordinaryPatch = { gain: result.gain };
    }
    let synchronizeLinks = false;
    const patches = new Map<number, ChannelEditPatch>();
    for (const field of fields) {
      const value = ordinaryPatch[field];
      if (value === undefined) continue;
      const indices = field === 'globalDelayUs' ? [0, 1, 2] : [request.channelIndex];
      for (const index of indices) {
        const current = preset.channels[index][field];
        if (field === 'includeInSum' ? (current !== false) === value : Object.is(current, value))
          continue;
        const next = patches.get(index) ?? {};
        Object.assign(next, { [field]: value });
        patches.set(index, next);
        if ((processing as readonly string[]).includes(field)) synchronizeLinks = true;
      }
    }
    const changes = [...patches]
      .sort(([a], [b]) => a - b)
      .map(([channelIndex, patch]) => {
        const before = context[channelIndex].values;
        return { channelIndex, before, value: { ...before, ...patch }, patch };
      });
    const before = context[request.channelIndex].values;
    const hardwareChanged =
      hardwareGain !== undefined &&
      (!Object.is(channel.additionalGain, hardwareGain.result.additionalGain) ||
        !Object.is(documents[slot].hfdGainLowered, hardwareGain.result.hfdGainLowered));
    return {
      slot,
      before,
      value: changes.find((change) => change.channelIndex === request.channelIndex)?.value ?? {
        ...before,
      },
      changed: changes.length > 0 || hardwareChanged,
      synchronizeLinks,
      context,
      changes,
      ...(hardwareGain ? { hardwareGain } : {}),
    };
  });
  return freeze({
    request: checkedRequest,
    ...(revision === undefined ? {} : { revision }),
    changedSlots: roles.filter((role) => role.changed).map((role) => role.slot),
    synchronizeLinks: false,
    roles,
  });
}

/** Explicit role, detached project. The caller preflights once and atomically
 * publishes changedSlots using the plan's synchronization policy. */
export function applyChannelEdit(project: Project, slot: Slot, plan: ChannelEditPlan): void {
  const role = plan.roles.find((role) => role.slot === slot);
  if (!role) throw new Error('Channel edit role was not planned');
  const current = target(project, plan.request);
  if (!same(current.context, role.context))
    throw new Error('The channel edit role or context changed');
  if (role.hardwareGain && !Object.is(project.hfdGainLowered, role.hardwareGain.beforeHint))
    throw new Error('The hardware gain document hint changed');
  for (const change of role.changes)
    Object.assign(current.preset.channels[change.channelIndex], change.patch);
  if (role.hardwareGain) {
    current.preset.channels[plan.request.channelIndex].additionalGain =
      role.hardwareGain.result.additionalGain;
    project.hfdGainLowered = role.hardwareGain.result.hfdGainLowered;
  }
  if (role.synchronizeLinks) synchronizeLinkedGroup(current.preset, plan.request.channelIndex);
}
