import { rootChannel } from './links';
import { normalizeHfdManualFrequencyText } from './manual-frequency';
import { normalizeHfdManualQText, normalizeHfdManualGainText } from './manual-parameter';
import {
  CHANNELS,
  emptyFir,
  unity,
  type Channel,
  type Filter,
  type Preset,
  type Project,
} from './model';

/** Explicit manual edits only: never normalize imported or untouched fields. */
export function editManualFilter(
  current: Filter,
  patch: Partial<Filter>,
  {
    redesign = false,
    manualFrequency = true,
    manualParameters = true,
  }: { redesign?: boolean; manualFrequency?: boolean; manualParameters?: boolean } = {},
): Filter {
  const next = { ...current, ...patch, id: current.id };
  if (Object.hasOwn(current, 'sourceId')) next.sourceId = current.sourceId;
  else delete next.sourceId;
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
  if (redesign && next.kind !== 'raw' && patch.coefficients === undefined) {
    delete next.coefficients;
    delete next.provenance;
  }
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
