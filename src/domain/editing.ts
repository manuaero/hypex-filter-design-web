import { rootChannel } from './links';
import { normalizeHfdManualFrequencyText } from './manual-frequency';
import {
  normalizeHfdManualQText,
  normalizeHfdManualGainText,
  formatHfdManualQValue,
} from './manual-parameter';
import { hfdManualParameterWheelNext, type HfdManualWheelResult } from './parameter-wheel';
import { hfdManualGraphQNext, supportsHfdGraphQ } from './manual-graph-q';
import { designHfd } from './hfd-math';
import {
  CHANNELS,
  emptyFir,
  unity,
  type Channel,
  type Coefficients,
  type Filter,
  type Preset,
  type Project,
  type Slot,
} from './model';

export type ManualFilterParameter = 'q' | 'q2' | 'gain';
export interface ManualFilterWheelRequest {
  presetIndex: number;
  channelIndex: number;
  filterIndex: number;
  parameter: ManualFilterParameter;
  direction: -1 | 1;
  basis?: 'each' | Slot;
  surface?: 'field' | 'graph';
}
export interface ManualFilterWheelPlan {
  request: ManualFilterWheelRequest;
  changedSlots: Slot[];
  roles: {
    slot: Slot;
    before: number;
    value: number;
    text: string;
    changed: boolean;
    beforeFilter: Filter;
    additionalGain: number;
  }[];
}
export function isManualFilterParameterActive(
  filter: Pick<Filter, 'kind'>,
  parameter: ManualFilterParameter,
): boolean {
  if (parameter === 'q2') return filter.kind === 'asymmetric';
  if (parameter === 'gain')
    return ['peak', 'lowshelf1', 'highshelf1', 'lowshelf2', 'highshelf2'].includes(filter.kind);
  return [
    'lowpass2',
    'highpass2',
    'peak',
    'lowshelf2',
    'highshelf2',
    'asymmetric',
    'allpass2',
  ].includes(filter.kind);
}

/** Preflight every target before any workspace edit. Source-basis events mirror
 * one native callback; a source unchanged-Text event does not invoke a mirror. */
export function planManualFilterWheel(
  documents: Record<Slot, Project>,
  slots: readonly Slot[],
  request: ManualFilterWheelRequest,
  sourceEvent?: {
    slot: Slot;
    filterId: string;
    before: number;
    additionalGain: number;
    result: Pick<HfdManualWheelResult, 'value' | 'text' | 'changed'>;
  },
): ManualFilterWheelPlan {
  if (
    !slots.length ||
    slots.length > 2 ||
    new Set(slots).size !== slots.length ||
    slots.some((slot) => slot !== 'left' && slot !== 'right')
  )
    throw new Error('Invalid wheel targets');
  if (
    !['q', 'q2', 'gain'].includes(request.parameter) ||
    (request.direction !== -1 && request.direction !== 1)
  )
    throw new Error('Invalid parameter wheel action');
  const basis = request.basis ?? 'each',
    surface = request.surface ?? 'field';
  if (!['field', 'graph'].includes(surface) || (surface === 'graph' && request.parameter !== 'q'))
    throw new Error('Graph adjustment supports primary Q only');
  if (basis !== 'each' && !slots.includes(basis))
    throw new Error('Wheel source must be a selected role');
  const targets = slots.map((slot) => {
    const preset = presetAt(documents[slot], request.presetIndex);
    const channel = editableChannel(preset, request.channelIndex);
    index(request.filterIndex, channel.filters.length, 'biquad');
    const filter = channel.filters[request.filterIndex],
      additionalGain = channel.additionalGain ?? 0;
    if (!Number.isFinite(additionalGain)) throw new Error('Additional gain must be finite');
    if (
      surface === 'graph' &&
      (basis === 'each' || basis === slot) &&
      !supportsHfdGraphQ(filter.kind)
    )
      throw new Error(`Graph Q is unavailable for ${slot} ${filter.kind}; use its Q control`);
    if (
      surface === 'field' &&
      (basis === 'each' || basis === slot) &&
      !isManualFilterParameterActive(filter, request.parameter)
    )
      throw new Error(`${request.parameter} is inactive for ${slot} ${filter.kind}`);
    return { slot, filter, additionalGain };
  });
  const next = (target: (typeof targets)[number]) =>
    surface === 'graph'
      ? hfdManualGraphQNext(target.filter.q, request.direction)
      : hfdManualParameterWheelNext(target.filter[request.parameter], request.direction, {
          parameter: request.parameter === 'gain' ? 'gain' : 'q',
          additionalGain: target.additionalGain,
        });
  let sourceResult: Pick<HfdManualWheelResult, 'value' | 'text' | 'changed'> | undefined;
  if (basis !== 'each') {
    const source = targets.find((target) => target.slot === basis)!;
    if (sourceEvent) {
      if (
        sourceEvent.slot !== basis ||
        sourceEvent.filterId !== source.filter.id ||
        sourceEvent.before !== source.filter[request.parameter] ||
        sourceEvent.additionalGain !== source.additionalGain ||
        !Number.isFinite(sourceEvent.result.value)
      )
        throw new Error('The parameter wheel source changed');
      sourceResult = sourceEvent.result;
    } else sourceResult = next(source);
  } else if (sourceEvent) throw new Error('A UI source event requires a fixed source basis');
  if (surface === 'graph' && basis !== 'each') {
    const source = targets.find((target) => target.slot === basis)!;
    // Plot publishes no callback for a canonical source no-op. Match that
    // event while retaining every structural/read-only check above. Once the
    // source would change, admit every peer before planning any mutation.
    if (sourceResult!.changed && sourceResult!.value !== source.filter.q)
      for (const target of targets)
        if (!supportsHfdGraphQ(target.filter.kind))
          throw new Error(
            `Graph Q is unavailable for ${target.slot} ${target.filter.kind}; use its Q control`,
          );
  }
  const roles = targets.map((target) => {
    const result = sourceResult ?? next(target);
    const before = target.filter[request.parameter];
    const changed = result.changed && result.value !== before;
    return {
      slot: target.slot,
      before,
      value: changed ? result.value : before,
      text: surface === 'graph' && !changed ? formatHfdManualQValue(before) : result.text,
      changed,
      beforeFilter: structuredClone(target.filter),
      additionalGain: target.additionalGain,
    };
  });
  return {
    request: { ...request, basis, surface },
    roles,
    changedSlots: roles.filter((role) => role.changed).map((role) => role.slot),
  };
}

/** Apply only a preflighted changed slot. Matching complete filter/context values
 * avoids relying on a workspace adapter's callback order or project UUIDs. */
export function applyManualFilterWheel(project: Project, plan: ManualFilterWheelPlan): void {
  const { presetIndex, channelIndex, filterIndex, parameter } = plan.request;
  const preset = presetAt(project, presetIndex),
    channel = editableChannel(preset, channelIndex);
  index(filterIndex, channel.filters.length, 'biquad');
  const current = channel.filters[filterIndex];
  const matches = plan.roles.filter(
    (role) =>
      role.changed &&
      role.additionalGain === (channel.additionalGain ?? 0) &&
      JSON.stringify(role.beforeFilter) === JSON.stringify(current),
  );
  if (!matches.length || matches.some((role) => role.value !== matches[0].value))
    throw new Error('The parameter wheel target changed');
  const value = matches[0].value;
  if (value === current[parameter]) return;
  channel.filters[filterIndex] = editManualFilter(
    current,
    { [parameter]: value },
    {
      redesign: true,
      manualFrequency: false,
      manualParameters: false,
    },
  );
  if (filterIndex === 0 && current.kind !== 'raw') channel.coefficientCache = 'base';
  synchronizeFollowers(preset, channelIndex);
}

export type ManualFilterPatch = Omit<Partial<Filter>, 'coefficients'> & {
  coefficients?: Partial<Coefficients>;
};

const coefficientFields = ['b0', 'b1', 'b2', 'f1', 'f2'] as const;
function coefficientPatchKeys(input: unknown): (keyof Coefficients)[] {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Coefficient patch must be a nonempty object');
  const keys = Reflect.ownKeys(input);
  if (
    !keys.length ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !coefficientFields.includes(key as keyof Coefficients) ||
        !Number.isFinite((input as Coefficients)[key as keyof Coefficients]),
    )
  )
    throw new Error('Coefficient patch requires known fields with finite values');
  return keys as (keyof Coefficients)[];
}
function completeCoefficients(input: unknown): Coefficients {
  if (coefficientPatchKeys(input).length !== coefficientFields.length)
    throw new Error('A complete finite coefficient vector is required');
  return { ...(input as Coefficients) };
}

/** Full vectors may repair malformed data. Partial edits require a complete
 * baseline; no missing component is invented, normalized or stability-clamped. */
export function mergeRawCoefficients(
  current: Coefficients | undefined,
  patch: Partial<Coefficients>,
): Coefficients {
  const keys = coefficientPatchKeys(patch);
  if (keys.length === coefficientFields.length) return completeCoefficients(patch);
  return { ...completeCoefficients(current), ...patch };
}

function rawCoefficients(current: Filter): Coefficients {
  if (current.kind === 'unity') return unity();
  if (current.coefficients !== undefined) return completeCoefficients(current.coefficients);
  if (current.kind === 'raw') throw new Error('Raw section requires complete finite coefficients');
  // Bypass is independent of the retained section. Converting a disabled
  // section must capture its own unbypassed response, without channel gain.
  return completeCoefficients(designHfd({ ...current, enabled: true }));
}

/** Explicit manual edits only: never normalize imported or untouched fields.
 * Conversion to raw captures the current section before simultaneous parameter
 * patches; those parameters become latent metadata of the retained response. */
export function editManualFilter(
  current: Filter,
  patch: ManualFilterPatch,
  {
    redesign = false,
    manualFrequency = true,
    manualParameters = true,
  }: { redesign?: boolean; manualFrequency?: boolean; manualParameters?: boolean } = {},
): Filter {
  const { coefficients: coefficientPatch, ...parameters } = patch;
  const next = { ...current, ...parameters, id: current.id };
  if (Object.hasOwn(current, 'sourceId')) next.sourceId = current.sourceId;
  else delete next.sourceId;
  const shelfOrder =
    next.kind === 'lowshelf1' || next.kind === 'highshelf1'
      ? 1
      : next.kind === 'lowshelf2' || next.kind === 'highshelf2'
        ? 2
        : undefined;
  if (patch.shelfDirection !== undefined) {
    // This is an explicit direction choice, even when Unknown previously had
    // the same effective meaning. Do not resurrect Unknown on a later edit.
    const direction = patch.shelfDirection;
    if (
      shelfOrder &&
      patch.kind !== undefined &&
      next.kind.startsWith(direction === 'low' ? 'high' : 'low')
    )
      throw new Error('Filter kind and shelf direction conflict');
    next.sourceShelfDirection = direction === 'low' ? 'stLowShelf' : 'stHighShelf';
    if (shelfOrder)
      next.kind =
        shelfOrder === 1
          ? direction === 'low'
            ? 'lowshelf1'
            : 'highshelf1'
          : direction === 'low'
            ? 'lowshelf2'
            : 'highshelf2';
  } else if (patch.kind !== undefined && next.sourceShelfDirection !== undefined) {
    if (shelfOrder) {
      const requested = next.kind.startsWith('low') ? 'low' : 'high',
        effective = next.sourceShelfDirection === 'stHighShelf' ? 'high' : 'low';
      // Browser shelf kinds combine Function and direction. Retain the native
      // enum if compatible; an explicitly contrary kind chooses Low or High.
      if (requested !== effective)
        next.sourceShelfDirection = requested === 'low' ? 'stLowShelf' : 'stHighShelf';
      next.shelfDirection = requested;
    } else if (next.kind === 'asymmetric') {
      // Native Asym tests Low==0, unlike Shelf1/2's High==1 test. Reinterpret
      // the retained enum for the new Function, not the former effective value.
      next.shelfDirection = next.sourceShelfDirection === 'stLowShelf' ? 'low' : 'high';
    }
  }
  if (manualFrequency) {
    for (const field of ['frequency', 'frequency2'] as const) {
      if (patch[field] === undefined) continue;
      if (!Number.isFinite(patch[field])) throw new Error('Frequency must be finite');
      next[field] = normalizeHfdManualFrequencyText(String(patch[field]), {
        previousValue: current[field],
      }).value;
    }
  }
  if (manualParameters) {
    for (const field of ['q', 'q2', 'gain'] as const) {
      if (patch[field] === undefined) continue;
      if (!Number.isFinite(patch[field])) throw new Error('Manual parameter must be finite');
      const normalize = field === 'gain' ? normalizeHfdManualGainText : normalizeHfdManualQText;
      next[field] = normalize(String(patch[field]), { previousValue: current[field] }).value;
    }
  }
  if (Object.hasOwn(patch, 'coefficients')) {
    const keys = coefficientPatchKeys(coefficientPatch);
    if (next.kind !== 'raw' && keys.length !== coefficientFields.length)
      throw new Error('Partial coefficient edits require a raw section');
    next.coefficients =
      keys.length === coefficientFields.length
        ? completeCoefficients(coefficientPatch)
        : mergeRawCoefficients(rawCoefficients(current), coefficientPatch!);
  } else if (next.kind === 'raw') next.coefficients = rawCoefficients(current);
  else if (redesign) {
    delete next.coefficients;
    delete next.provenance;
  }
  if (
    (next.kind === 'raw' || Object.hasOwn(patch, 'coefficients')) &&
    coefficientFields.some(
      (key) => !Object.is(current.coefficients?.[key], next.coefficients![key]),
    )
  )
    delete next.provenance;
  return next;
}

/** Native Add considers the Unity type unused, independently of Enabled. */
export function isUnusedBiquad(filter: Pick<Filter, 'kind'>): boolean {
  return filter.kind === 'unity';
}

function index(value: number, length: number, label: string) {
  if (!Number.isInteger(value) || value < 0 || value >= length)
    throw new Error(`Invalid ${label} index`);
}

function presetAt(project: Project, presetIndex: number): Preset {
  index(presetIndex, project.presets.length, 'preset');
  const preset = project.presets[presetIndex];
  if (project.presets.filter((p) => p === preset).length !== 1)
    throw new Error('Aliased presets cannot be edited independently');
  if (preset.channels.length !== CHANNELS) throw new Error('FA503 requires three channels');
  const channels = project.presets.flatMap((p) => p.channels);
  for (const channel of preset.channels) {
    if (channels.filter((c) => c === channel).length !== 1)
      throw new Error('Aliased channels cannot be edited independently');
    if (channel.filters.length !== 15)
      throw new Error('FA503 requires 15 biquad slots per channel');
    if (channels.some((c) => c !== channel && c.filters === channel.filters))
      throw new Error('Aliased biquad arrays cannot be edited independently');
  }
  // Validate every link before making any mutation, including followers that
  // will receive updated processing after a master is edited.
  for (let channel = 0; channel < CHANNELS; channel++) rootChannel(preset, channel);
  return preset;
}

function editableChannel(preset: Preset, channelIndex: number): Channel {
  index(channelIndex, preset.channels.length, 'channel');
  const channel = preset.channels[channelIndex];
  if (channel.linkedTo !== undefined) throw new Error('Linked destination channel is read-only');
  return channel;
}

function atSlot(parameters: Filter, slot: Filter): Filter {
  const copy = structuredClone(parameters);
  copy.id = slot.id;
  if (slot.sourceId === undefined) delete copy.sourceId;
  else copy.sourceId = slot.sourceId;
  return copy;
}

/** HFD channel CopyTo copies processing nodes, not the impulse/driver object.
 * Native evidence: c7298c/c72898; gain a93638 excludes AdditionalGain.
 * Keep this shared contract aligned with links.ts. */
function copyProcessing(source: Channel, destination: Channel) {
  const filters = source.filters.map((filter, i) => atSlot(filter, destination.filters[i]));
  const fir = structuredClone(source.fir);
  destination.gain = source.gain;
  destination.invert = source.invert;
  destination.muted = source.muted;
  destination.delayUs = source.delayUs;
  destination.globalDelayUs = source.globalDelayUs;
  destination.filters = filters;
  destination.fir = fir;
  destination.coefficientCache = source.coefficientCache === 'unresolved' ? 'unresolved' : 'base';
}

function synchronizeFollowers(preset: Preset, master: number) {
  for (let follower = 0; follower < CHANNELS; follower++)
    if (follower !== master && rootChannel(preset, follower) === master)
      copyProcessing(preset.channels[master], preset.channels[follower]);
}

/** Native Delete (c69810) changes the same slot to Unity, retaining Enabled
 * and latent design parameters. It is not the broader browser Reset action. */
export function deleteBiquad(
  project: Project,
  presetIndex: number,
  channelIndex: number,
  filterIndex: number,
): void {
  const preset = presetAt(project, presetIndex),
    channel = editableChannel(preset, channelIndex);
  index(filterIndex, channel.filters.length, 'biquad');
  const filter = { ...channel.filters[filterIndex], kind: 'unity' as const, coefficients: unity() };
  delete filter.provenance;
  if (filter.sourceType !== undefined) filter.sourceType = 'ftUnity';
  channel.filters[filterIndex] = filter;
  // Only replacing the first section resolves its formerly ambiguous gain cache.
  if (filterIndex === 0) channel.coefficientCache = 'base';
  synchronizeFollowers(preset, channelIndex);
}

/** Exchange complete biquad parameters, including disabled/raw coefficient
 * caches, while retaining each graph slot's id/sourceId (HFD a924c0).
 * An unresolved first-section gain cache must be resolved before moving it. */
export function exchangeBiquads(
  project: Project,
  presetIndex: number,
  channelIndex: number,
  first: number,
  second: number,
): void {
  const preset = presetAt(project, presetIndex);
  const channel = editableChannel(preset, channelIndex);
  index(first, channel.filters.length, 'biquad');
  index(second, channel.filters.length, 'biquad');
  const a = channel.filters[first];
  const b = channel.filters[second];
  if (first === second || a === b || a.id === b.id)
    throw new Error('Exchange requires two different biquad slots');
  if (channel.coefficientCache === 'unresolved' && (first === 0 || second === 0))
    throw new Error('Resolve the first-section gain cache before exchanging its slot');
  const replacementA = atSlot(b, a);
  const replacementB = atSlot(a, b);
  channel.filters[first] = replacementA;
  channel.filters[second] = replacementB;
  if (channel.coefficientCache !== 'unresolved') channel.coefficientCache = 'base';
  synchronizeFollowers(preset, channelIndex);
}

/** Copy gain/invert/mute, local/global delay, all 15 biquads and output FIR
 * from the source's linked master. Retain destination labels, measurement,
 * additional gain, sum inclusion, graph identities and link relationships.
 * Input EQ/FIR and FIR placement are preset properties and stay unchanged. */
export function copyChannelProcessing(
  project: Project,
  presetIndex: number,
  source: number,
  destination: number,
): void {
  const preset = presetAt(project, presetIndex);
  index(source, preset.channels.length, 'channel');
  const target = editableChannel(preset, destination);
  const master = rootChannel(preset, source);
  if (master === destination || preset.channels[master] === target)
    throw new Error('Copy requires two different processing channels');
  copyProcessing(preset.channels[master], target);
  synchronizeFollowers(preset, destination);
}

/** Exact native Clear preset filter-parameter scope (c79b44 -> c72054):
 * reset gain/inversion and all biquad parameters to unity, clear input FIR,
 * and retain each biquad's enabled flag. Preserve delay, mute, output FIR,
 * links, labels/measurements, additional gain, input EQ and FIR placement.
 * This deliberately does not perform a broader new-project reset. */
export function clearPreset(project: Project, presetIndex: number): void {
  const preset = presetAt(project, presetIndex);
  for (const channel of preset.channels) {
    channel.filters = channel.filters.map((filter) => {
      const cleared: Filter = {
        id: filter.id,
        kind: 'unity',
        enabled: filter.enabled,
        frequency: 1000,
        frequency2: 1000,
        q: 0.7,
        q2: 0.7,
        gain: 0,
      };
      if (filter.sourceId !== undefined) cleared.sourceId = filter.sourceId;
      return cleared;
    });
    channel.gain = 0;
    channel.invert = false;
    channel.coefficientCache = 'base';
  }
  preset.inputFir = emptyFir();
}
