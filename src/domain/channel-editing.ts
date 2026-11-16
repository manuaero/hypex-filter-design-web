import { assertProjectLinks, rootChannel, synchronizeLinkedGroup } from './links';
import type { Channel, Filter, Project, Slot } from './model';
import {
  hardwareGainPresentation,
  normalizeHardwareGainCallback,
  type HardwareGainCallbackResult,
} from './hardware-gain';
import {
  formatHfdChannelGainValue,
  hfdChannelGainWheelNext,
  normalizeHfdChannelGainText,
  type HfdChannelGainResult,
  type HfdChannelGainWheelResult,
} from './channel-gain';
import {
  formatHfdChannelDelayValue,
  hfdChannelDelayWheelNext,
  normalizeHfdChannelDelayText,
  readHfdChannelDelayText,
  type HfdChannelDelayResult,
  type HfdChannelDelayWheelResult,
} from './channel-delay';
import { resolveChannelDelayProfiles, type ChannelDelayRuntime } from './channel-delay-profile';
import { copyNativeLinkedChannel, settleNativeLinkedCopyCache } from './native-linked-copy';

export type ChannelEditValues = Pick<
  Channel,
  'name' | 'outputName' | 'includeInSum' | 'gain' | 'invert' | 'muted' | 'delayUs' | 'globalDelayUs'
>;
export interface ChannelGainWheelIntent {
  direction: -1 | 1;
  basis?: 'each' | Slot;
}
export interface ChannelDelayWheelIntent {
  parameter: 'local' | 'global';
  direction: -1 | 1;
  basis?: 'each' | Slot;
}
export type ChannelEditPatch = Partial<
  Omit<ChannelEditValues, 'gain' | 'delayUs' | 'globalDelayUs'>
> & {
  /** Original request, normalized separately for each role's AdditionalGain. */
  gain?: number | string;
  hardwareGain?: boolean;
  gainWheel?: ChannelGainWheelIntent;
  delayUs?: number | string;
  globalDelayUs?: number | string;
  delayWheel?: ChannelDelayWheelIntent;
};
export interface ChannelDelayWheelSourceEvent {
  slot: Slot;
  channelId: string;
  expectedValue: number;
  expectedContextKey: string;
  result: Pick<
    HfdChannelDelayWheelResult,
    'text' | 'value' | 'changed' | 'notified' | 'maximumValue'
  >;
}
export interface ChannelGainWheelSourceEvent {
  slot: Slot;
  channelId: string;
  expectedGain: number;
  expectedAdditionalGain: number;
  result: Pick<HfdChannelGainWheelResult, 'text' | 'value' | 'changed'>;
}
export interface ChannelEditRequest {
  presetIndex: number;
  channelIndex: number;
  patch: ChannelEditPatch;
}
export interface ChannelEditOptions {
  /** Trusted current visible view context, never caller-supplied command data.
   * A latched view remains available after Off; absent views use fresh state. */
  hardwareGainContext?: Partial<Record<Slot, { available: boolean; gainText?: string }>>;
  /** Trusted current human source event; opaque wheel state stays in Numeric. */
  gainWheelSourceEvent?: ChannelGainWheelSourceEvent;
  /** Current application session and visible Global Text, never command data. */
  delayContext?: Partial<Record<Slot, { runtime?: ChannelDelayRuntime; globalText?: string }>>;
  delayWheelSourceEvent?: ChannelDelayWheelSourceEvent;
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
    gainResult?: HfdChannelGainResult;
    gainWheelResult?: Pick<HfdChannelGainWheelResult, 'text' | 'value' | 'changed'>;
    delayResult?: HfdChannelDelayResult;
    delayWheelResult?: ChannelDelayWheelSourceEvent['result'];
    /** Full native callback proposals are materialized for every role before publication. */
    delayProposal?: { before: Project; value: Project };
    changes: {
      channelIndex: number;
      before: ChannelEditValues;
      value: ChannelEditValues;
      patch: Partial<ChannelEditValues>;
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
  if (Object.hasOwn(input, 'delayWheel')) {
    const wheel = input.delayWheel;
    if (
      Object.keys(input).length !== 1 ||
      !wheel ||
      typeof wheel !== 'object' ||
      Array.isArray(wheel) ||
      Object.keys(wheel).some((key) => !['parameter', 'direction', 'basis'].includes(key)) ||
      !['local', 'global'].includes(wheel.parameter) ||
      (wheel.direction !== -1 && wheel.direction !== 1) ||
      (wheel.basis !== undefined && !['each', 'left', 'right'].includes(wheel.basis))
    )
      throw new Error('Channel delay wheel must be a sole valid intent');
    return {
      delayWheel: {
        parameter: wheel.parameter,
        direction: wheel.direction,
        basis: wheel.basis ?? 'each',
      },
    };
  }
  for (const field of ['delayUs', 'globalDelayUs'] as const) {
    if (!Object.hasOwn(input, field)) continue;
    const value = input[field];
    if (
      Object.keys(input).length !== 1 ||
      (typeof value !== 'string' && typeof value !== 'number') ||
      (typeof value === 'number' && !Number.isFinite(value))
    )
      throw new Error('A channel delay callback must be a sole finite numeric Text intent');
    return { [field]: value };
  }
  if (Object.hasOwn(input, 'gainWheel')) {
    const wheel = input.gainWheel;
    if (
      Object.keys(input).length !== 1 ||
      !wheel ||
      typeof wheel !== 'object' ||
      Array.isArray(wheel) ||
      Object.keys(wheel).some((key) => !['direction', 'basis'].includes(key)) ||
      (wheel.direction !== -1 && wheel.direction !== 1) ||
      (wheel.basis !== undefined && !['each', 'left', 'right'].includes(wheel.basis))
    )
      throw new Error('Channel gain wheel must be a sole valid intent');
    return { gainWheel: { direction: wheel.direction, basis: wheel.basis ?? 'each' } };
  }
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
    } else if (field === 'gain') {
      if (
        (typeof value !== 'number' && typeof value !== 'string') ||
        (typeof value === 'number' && !Number.isFinite(value))
      )
        throw new Error('Channel gain must be finite numeric Text or a number');
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

function planDelayEdit(
  documents: Record<Slot, Project>,
  slots: readonly Slot[],
  request: ChannelEditRequest,
  targets: { slot: Slot; preset: Project['presets'][number]; context: ChannelContext[] }[],
  revision: number | undefined,
  options: ChannelEditOptions,
): ChannelEditPlan {
  const wheel = request.patch.delayWheel;
  const parameter =
    wheel?.parameter ?? (Object.hasOwn(request.patch, 'delayUs') ? 'local' : 'global');
  const field = parameter === 'local' ? 'delayUs' : 'globalDelayUs';
  if (options.gainWheelSourceEvent)
    throw new Error('A gain source event cannot authorize a delay callback');
  if (options.delayWheelSourceEvent && (!wheel || wheel.basis === 'each'))
    throw new Error('A delay source event requires a fixed wheel basis');
  if (wheel && wheel.basis !== 'each' && !slots.includes(wheel.basis!))
    throw new Error('Channel delay wheel source must be a selected role');
  const contexts = targets.map((role) => {
    try {
      return {
        ...role,
        profiles: resolveChannelDelayProfiles(
          documents[role.slot],
          request.presetIndex,
          request.channelIndex,
          options.delayContext?.[role.slot]?.runtime,
        ),
      };
    } catch (error) {
      throw new Error(`${role.slot}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  // All requested local roots validate even for a no-notification wheel event.
  for (const role of contexts)
    if (parameter === 'local' && role.preset.channels[request.channelIndex].linkedTo !== undefined)
      throw new Error(`${role.slot} channel is linked; edit its master or unlink it first`);
  let sourceResult: ChannelDelayWheelSourceEvent['result'] | undefined;
  if (wheel && wheel.basis !== 'each') {
    const source = contexts.find((role) => role.slot === wheel.basis)!;
    const channel = source.preset.channels[request.channelIndex];
    const event = options.delayWheelSourceEvent;
    if (event) {
      const result = event.result;
      const profile = source.profiles[parameter];
      if (
        event.slot !== source.slot ||
        event.channelId !== channel.id ||
        !Object.is(event.expectedValue, channel[field]) ||
        event.expectedContextKey !== source.profiles.contextKey ||
        !result ||
        typeof result.text !== 'string' ||
        !Number.isFinite(result.value) ||
        typeof result.notified !== 'boolean' ||
        typeof result.changed !== 'boolean' ||
        result.changed !== !Object.is(result.value, channel[field]) ||
        (result.notified
          ? !Object.is(readHfdChannelDelayText(result.text), result.value) ||
            !Object.is(result.maximumValue, readHfdChannelDelayText(profile.maximumText))
          : result.changed || result.maximumValue !== undefined)
      )
        throw new Error('The channel delay wheel source or profile context changed');
      sourceResult = {
        text: result.text,
        value: result.value,
        changed: result.changed,
        notified: result.notified,
        ...(result.maximumValue === undefined ? {} : { maximumValue: result.maximumValue }),
      };
    } else {
      const result = hfdChannelDelayWheelNext(channel[field], wheel.direction, {
        profile: source.profiles[parameter],
      });
      sourceResult = {
        text: result.text,
        value: result.value,
        changed: result.changed,
        notified: result.notified,
        ...(result.maximumValue === undefined ? {} : { maximumValue: result.maximumValue }),
      };
    }
  }
  const roles: ChannelEditPlan['roles'] = contexts.map(({ slot, preset, context, profiles }) => {
    const original = documents[slot],
      channel = preset.channels[request.channelIndex];
    const profile = profiles[parameter];
    let result: HfdChannelDelayResult | undefined;
    let wheelResult: ChannelDelayWheelSourceEvent['result'] | undefined;
    if (!wheel) {
      const raw = request.patch[field]!;
      result = normalizeHfdChannelDelayText(typeof raw === 'string' ? raw : String(raw), {
        profile,
      });
    } else if (sourceResult) {
      if (slot === wheel.basis) wheelResult = { ...sourceResult };
      else if (!sourceResult.changed || !sourceResult.notified)
        wheelResult = {
          text: formatHfdChannelDelayValue(channel[field], { profile }),
          value: channel[field],
          changed: false,
          notified: false,
        };
      else {
        const normalized = normalizeHfdChannelDelayText(String(sourceResult.value), { profile });
        wheelResult = {
          ...normalized,
          changed: !Object.is(normalized.value, channel[field]),
          notified: true,
        };
      }
    } else {
      const normalized = hfdChannelDelayWheelNext(channel[field], wheel.direction, { profile });
      wheelResult = {
        text: normalized.text,
        value: normalized.value,
        changed: normalized.changed,
        notified: normalized.notified,
        ...(normalized.maximumValue === undefined ? {} : { maximumValue: normalized.maximumValue }),
      };
    }
    const notified = result !== undefined || wheelResult?.notified === true;
    if (!notified)
      return {
        slot,
        before: values(channel),
        value: values(channel),
        changed: false,
        synchronizeLinks: false,
        context,
        changes: [],
        ...(wheelResult ? { delayWheelResult: wheelResult } : {}),
      };
    const next = structuredClone(original),
      nextPreset = next.presets[request.presetIndex],
      selected = nextPreset.channels[request.channelIndex];
    if (notified) {
      const normalized = result ?? wheelResult!;
      selected[field] = normalized.value;
      selected.hfdDelay = {
        ...selected.hfdDelay,
        [parameter === 'local' ? 'localMaximum' : 'globalMaximum']: normalized.maximumValue!,
      };
      if (parameter === 'local') {
        // Native GroupCopyTo runs for immediate resolved followers before the
        // current Global widget getter is fanned across this preset.
        for (let index = 0; index < nextPreset.channels.length; index++) {
          if (nextPreset.channels[index].linkedTo !== request.channelIndex) continue;
          // An implicit browser factory maximum is known, while an imported
          // missing maximum has already refused during profile resolution.
          if (selected.hfdDelay.globalMaximum === undefined)
            selected.hfdDelay.globalMaximum = readHfdChannelDelayText(profiles.global.maximumText);
          copyNativeLinkedChannel(next, request.presetIndex, index);
          settleNativeLinkedCopyCache(next, request.presetIndex, index);
        }
      }
      const globalText = options.delayContext?.[slot]?.globalText;
      if (globalText !== undefined && typeof globalText !== 'string')
        throw new Error('Invalid trusted Global Delay Text');
      const global =
        parameter === 'global'
          ? normalized.value
          : readHfdChannelDelayText(
              globalText ??
                formatHfdChannelDelayValue(channel.globalDelayUs, { profile: profiles.global }),
            );
      for (const target of nextPreset.channels) target.globalDelayUs = global;
    }
    const changes = nextPreset.channels.flatMap((nextChannel, channelIndex) => {
      const before = context[channelIndex].values,
        value = values(nextChannel);
      const patch: Partial<ChannelEditValues> = {};
      for (const key of fields)
        if (!Object.is(before[key], value[key])) Object.assign(patch, { [key]: value[key] });
      return Object.keys(patch).length ? [{ channelIndex, before, value, patch }] : [];
    });
    return {
      slot,
      before: values(channel),
      value: values(selected),
      changed: !same(original, next),
      synchronizeLinks: false,
      context,
      changes,
      ...(result ? { delayResult: result } : {}),
      ...(wheelResult ? { delayWheelResult: wheelResult } : {}),
      delayProposal: { before: structuredClone(original), value: next },
    };
  });
  return freeze({
    request,
    ...(revision === undefined ? {} : { revision }),
    changedSlots: roles.filter((role) => role.changed).map((role) => role.slot),
    synchronizeLinks: false,
    roles,
  });
}

/** Shared authoring transaction. All selected role roots validate even for equal
 * requested processing values. Native compensation is an explicit, conditional
 * callback intent. Ordinary gain Text and wheel requests share its native field
 * profile without changing passive imports or retained coefficient vectors. */
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
  if (Object.hasOwn(patch, 'delayUs') || Object.hasOwn(patch, 'globalDelayUs') || patch.delayWheel)
    return planDelayEdit(documents, slots, checkedRequest, targets, revision, options);
  if (options.delayWheelSourceEvent)
    throw new Error('A delay source event requires a delay wheel intent');
  const requestsHardware = Object.hasOwn(patch, 'hardwareGain');
  const wheel = patch.gainWheel;
  if (options.gainWheelSourceEvent && (!wheel || wheel.basis === 'each'))
    throw new Error('A channel gain source event requires a fixed wheel basis');
  if (wheel && wheel.basis !== 'each' && !slots.includes(wheel.basis!))
    throw new Error('Channel gain wheel source must be a selected role');
  const requestsProcessing =
    requestsHardware ||
    wheel !== undefined ||
    processing.some((field) => Object.hasOwn(patch, field));
  for (const role of targets)
    if (
      requestsProcessing &&
      rootChannel(role.preset, request.channelIndex) !== request.channelIndex
    )
      throw new Error(`${role.slot} channel is linked; edit its master or unlink it first`);
  let sourceResult: Pick<HfdChannelGainWheelResult, 'text' | 'value' | 'changed'> | undefined;
  if (wheel && wheel.basis !== 'each') {
    const source = targets.find((role) => role.slot === wheel.basis)!.preset.channels[
      request.channelIndex
    ];
    const event = options.gainWheelSourceEvent;
    if (event) {
      if (
        event.slot !== wheel.basis ||
        event.channelId !== source.id ||
        !Object.is(event.expectedGain, source.gain) ||
        !Object.is(event.expectedAdditionalGain, source.additionalGain ?? 0) ||
        !Number.isFinite(event.result.value) ||
        typeof event.result.text !== 'string' ||
        typeof event.result.changed !== 'boolean' ||
        event.result.changed !== !Object.is(event.result.value, source.gain)
      )
        throw new Error('The channel gain wheel source changed');
      sourceResult = {
        text: event.result.text,
        value: event.result.value,
        changed: event.result.changed,
      };
    } else {
      const result = hfdChannelGainWheelNext(source.gain, wheel.direction, {
        additionalGain: source.additionalGain ?? 0,
      });
      sourceResult = { text: result.text, value: result.value, changed: result.changed };
    }
  }
  const roles = targets.map(({ slot, preset, context }) => {
    const channel = preset.channels[request.channelIndex];
    let hardwareGain: ChannelEditPlan['roles'][number]['hardwareGain'];
    let gainResult: HfdChannelGainResult | undefined;
    let gainWheelResult: ChannelEditPlan['roles'][number]['gainWheelResult'];
    const {
      gain: rawGain,
      hardwareGain: _hardware,
      gainWheel: _wheel,
      delayUs: _localDelay,
      globalDelayUs: _globalDelay,
      delayWheel: _delayWheel,
      ...scalarPatch
    } = patch;
    let ordinaryPatch: Partial<ChannelEditValues> = scalarPatch;
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
    } else if (rawGain !== undefined) {
      gainResult = normalizeHfdChannelGainText(
        typeof rawGain === 'string' ? rawGain : String(rawGain),
        {
          additionalGain: channel.additionalGain ?? 0,
        },
      );
      ordinaryPatch.gain = gainResult.value;
    } else if (wheel) {
      if (sourceResult) {
        if (slot === wheel.basis) gainWheelResult = { ...sourceResult };
        else if (!sourceResult.changed)
          gainWheelResult = {
            text: formatHfdChannelGainValue(channel.gain),
            value: channel.gain,
            changed: false,
          };
        else {
          const result = normalizeHfdChannelGainText(String(sourceResult.value), {
            additionalGain: channel.additionalGain ?? 0,
          });
          gainWheelResult = { ...result, changed: !Object.is(result.value, channel.gain) };
        }
      } else {
        const result = hfdChannelGainWheelNext(channel.gain, wheel.direction, {
          additionalGain: channel.additionalGain ?? 0,
        });
        gainWheelResult = { text: result.text, value: result.value, changed: result.changed };
      }
      if (gainWheelResult.changed) ordinaryPatch.gain = gainWheelResult.value;
    }
    let synchronizeLinks = false;
    const patches = new Map<number, Partial<ChannelEditValues>>();
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
      ...(gainResult ? { gainResult } : {}),
      ...(gainWheelResult ? { gainWheelResult } : {}),
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
  if (role.delayProposal) {
    if (!same(project, role.delayProposal.before))
      throw new Error('The channel delay project context changed');
    for (const key of Object.keys(project))
      delete (project as unknown as Record<string, unknown>)[key];
    Object.assign(project, structuredClone(role.delayProposal.value));
    return;
  }
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
