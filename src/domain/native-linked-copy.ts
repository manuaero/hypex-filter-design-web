import type { Channel, Coefficients, Filter, Project } from './model';
import { designHfd } from './hfd-math';
import { assertProjectLinks } from './links';
import { importHfd } from './files';
import {
  captureNativeCacheWitness,
  classifyNativeCache,
  finiteCoefficients,
  sameCoefficients,
  validNativeCacheWitness,
} from './native-cache';

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
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
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function destination(project: Project, presetIndex: number, channelIndex: number): Channel {
  assert(
    project?.model === 'FA503' && project.sampleRate === 93750 && project.presets.length === 3,
    'Native linked copy requires an FA503 project',
  );
  assert(
    [presetIndex, channelIndex].every((i) => Number.isInteger(i) && i >= 0 && i < 3),
    'Invalid native linked copy target',
  );
  const channels = project.presets.flatMap((p) => p.channels);
  assert(
    channels.length === 9 &&
      new Set(channels).size === 9 &&
      project.presets.every((p) => p.channels.length === 3) &&
      new Set(channels.map((c) => c.filters)).size === 9 &&
      new Set(channels.flatMap((c) => c.filters)).size === 135 &&
      channels.every(
        (c) =>
          c.filters.length === 15 &&
          [c.gain, c.additionalGain ?? 0, c.delayUs, c.globalDelayUs].every(Number.isFinite) &&
          typeof c.invert === 'boolean' &&
          typeof c.muted === 'boolean',
      ),
    'Malformed or aliased native linked channels',
  );
  assertProjectLinks(project);
  return project.presets[presetIndex].channels[channelIndex];
}
function filterData(filter: Filter) {
  const { id: _id, sourceId: _sourceId, coefficients: _coefficients, ...data } = filter;
  return data;
}
function legacyData(filter: Filter) {
  const { id: _id, enabled: _enabled, ...data } = filter;
  return data;
}
function slotCopy(source: Filter, slot: Filter): Filter {
  const copy = structuredClone(source);
  copy.id = slot.id;
  if (Object.hasOwn(slot, 'sourceId')) copy.sourceId = slot.sourceId;
  else delete copy.sourceId;
  return copy;
}
function legacyRawFirst(project: Project, presetIndex: number, channelIndex: number): Coefficients {
  const channel = project.presets[presetIndex].channels[channelIndex];
  assert(
    project.sourceXml,
    'Native effective cache has no valid raw witness. Reimport the native XML or explicitly redesign/resolve the first section.',
  );
  let imported: Project;
  try {
    imported = importHfd(project.sourceXml, 'Native cache witness repair');
  } catch {
    throw new Error(
      'Cannot verify the native effective cache against its original XML. Reimport or redesign the first section.',
    );
  }
  const baseline = imported.presets[presetIndex].channels[channelIndex];
  assert(
    baseline.coefficientCache === channel.coefficientCache &&
      channel.filters.every(
        (filter, i) =>
          typeof filter.sourceId === 'string' &&
          typeof baseline.filters[i].sourceId === 'string' &&
          same(legacyData(filter), legacyData(baseline.filters[i])),
      ),
    'Native effective cache XML binding is stale or incomplete. Reimport or redesign the first section.',
  );
  const witness = validNativeCacheWitness(baseline);
  assert(
    witness,
    'Original XML cannot prove the native direct cache. Reimport or redesign the first section.',
  );
  return finiteCoefficients(witness.native);
}
function rawSections(project: Project, presetIndex: number, channelIndex: number): Coefficients[] {
  const channel = project.presets[presetIndex].channels[channelIndex];
  return channel.filters.map((filter, i) => {
    if (i === 0 && channel.coefficientCache === 'effective') {
      const witness = validNativeCacheWitness(channel);
      return witness
        ? finiteCoefficients(witness.native)
        : legacyRawFirst(project, presetIndex, channelIndex);
    }
    if (i === 0 && channel.coefficientCache === 'unresolved') {
      assert(
        filter.coefficients,
        'Unresolved native first cache requires its original finite vector',
      );
      return finiteCoefficients(filter.coefficients);
    }
    return finiteCoefficients(filter.coefficients ?? designHfd({ ...filter, enabled: true }));
  });
}
function processing(channel: Channel) {
  return {
    gain: channel.gain,
    invert: channel.invert,
    muted: channel.muted,
    delayUs: channel.delayUs,
    globalDelayUs: channel.globalDelayUs,
    hfdDelay: channel.hfdDelay,
    filters: channel.filters,
    fir: channel.fir,
    coefficientCache: channel.coefficientCache,
    linkedTo: channel.linkedTo,
  };
}
interface Admission {
  destination: Channel;
  processing: ReturnType<typeof processing>;
  raw: Coefficients;
  forced?: 'base' | 'unresolved';
}
const admitted = new WeakMap<Project, Map<string, Admission>>();

/** Detached native CopyTo, using the immediate pointer represented by linkedTo.
 * It does not establish a link, flatten chains, change a peer or grant upload
 * permission. All materialization/refusals precede destination mutation. */
export function copyNativeLinkedChannel(
  project: Project,
  presetIndex: number,
  channelIndex: number,
): boolean {
  const target = destination(project, presetIndex, channelIndex);
  if (target.linkedTo === undefined) return false;
  const sourceIndex = target.linkedTo,
    source = project.presets[presetIndex].channels[sourceIndex],
    raw = rawSections(project, presetIndex, sourceIndex),
    sourceClass = source.coefficientCache ?? 'base',
    forced = sourceClass === 'effective' ? undefined : sourceClass;
  const filters = source.filters.map((filter, i) => ({
    ...slotCopy(filter, target.filters[i]),
    coefficients: raw[i],
  }));
  const result = classifyNativeCache(
    raw[0],
    filters[0],
    {
      gain: source.gain,
      invert: source.invert,
      additionalGain: target.additionalGain,
    },
    forced,
  );
  filters[0].coefficients = result.coefficients;
  const proposal: Channel = {
    ...target,
    gain: source.gain,
    invert: source.invert,
    muted: source.muted,
    delayUs: source.delayUs,
    globalDelayUs: source.globalDelayUs,
    filters,
    fir: structuredClone(source.fir),
    coefficientCache: result.coefficientCache,
  };
  // Both native Delay objects copy their MaxDelay alongside their value.
  // Absent legacy metadata remains unknown rather than retaining a target bound.
  if (source.hfdDelay !== undefined) proposal.hfdDelay = structuredClone(source.hfdDelay);
  else delete proposal.hfdDelay;
  const targetRawFirst =
    target.coefficientCache === 'effective'
      ? validNativeCacheWitness(target)?.native
      : (target.filters[0].coefficients ?? designHfd({ ...target.filters[0], enabled: true }));
  // Do not create caches/witnesses/provenance or turn optional base into an
  // explicit property when all copied canonical processing is already equal.
  const equal =
    same(
      {
        gain: target.gain,
        invert: target.invert,
        muted: target.muted,
        delayUs: target.delayUs,
        globalDelayUs: target.globalDelayUs,
        hfdDelay: target.hfdDelay,
        fir: target.fir,
      },
      {
        gain: proposal.gain,
        invert: proposal.invert,
        muted: proposal.muted,
        delayUs: proposal.delayUs,
        globalDelayUs: proposal.globalDelayUs,
        hfdDelay: proposal.hfdDelay,
        fir: proposal.fir,
      },
    ) &&
    (target.coefficientCache ?? 'base') === result.coefficientCache &&
    targetRawFirst !== undefined &&
    sameCoefficients(targetRawFirst, raw[0]) &&
    target.filters.every(
      (filter, i) =>
        same(filterData(filter), filterData(filters[i])) &&
        sameCoefficients(
          finiteCoefficients(filter.coefficients ?? designHfd({ ...filter, enabled: true })),
          filters[i].coefficients,
        ),
    );
  if (!equal) {
    proposal.hfdDirectCacheWitness = captureNativeCacheWitness(proposal, raw[0]);
    Object.assign(target, {
      gain: proposal.gain,
      invert: proposal.invert,
      muted: proposal.muted,
      delayUs: proposal.delayUs,
      globalDelayUs: proposal.globalDelayUs,
      filters: proposal.filters,
      fir: proposal.fir,
      coefficientCache: proposal.coefficientCache,
      hfdDirectCacheWitness: proposal.hfdDirectCacheWitness,
    });
    if (proposal.hfdDelay !== undefined) target.hfdDelay = proposal.hfdDelay;
    else delete target.hfdDelay;
  }
  const records = admitted.get(project) ?? new Map<string, Admission>();
  records.set(`${presetIndex}:${channelIndex}`, {
    destination: target,
    processing: structuredClone(processing(target)),
    raw: finiteCoefficients(raw[0]),
    forced,
  });
  admitted.set(project, records);
  return !equal;
}

/** Only an immediately preceding trusted copy can settle after cold callbacks.
 * A view refresh cannot globally reinterpret imported unknown coefficients. */
export function settleNativeLinkedCopyCache(
  project: Project,
  presetIndex: number,
  channelIndex: number,
): boolean {
  const target = destination(project, presetIndex, channelIndex),
    key = `${presetIndex}:${channelIndex}`,
    records = admitted.get(project),
    record = records?.get(key);
  records?.delete(key);
  assert(
    record && record.destination === target && same(processing(target), record.processing),
    'Native linked cache settlement requires its unchanged copied processing',
  );
  const result = classifyNativeCache(record.raw, target.filters[0], target, record.forced);
  const currentRaw =
    target.coefficientCache === 'effective'
      ? validNativeCacheWitness(target)?.native
      : (target.filters[0].coefficients ?? designHfd({ ...target.filters[0], enabled: true }));
  if (
    (target.coefficientCache ?? 'base') === result.coefficientCache &&
    currentRaw !== undefined &&
    sameCoefficients(currentRaw, record.raw) &&
    sameCoefficients(
      finiteCoefficients(
        target.filters[0].coefficients ?? designHfd({ ...target.filters[0], enabled: true }),
      ),
      result.coefficients,
    )
  )
    return false;
  const proposal = {
    ...target,
    coefficientCache: result.coefficientCache,
    filters: target.filters.map((filter, i) =>
      i === 0 ? { ...filter, coefficients: result.coefficients } : filter,
    ),
  };
  const witness = captureNativeCacheWitness(proposal, record.raw);
  target.filters = proposal.filters;
  target.coefficientCache = result.coefficientCache;
  target.hfdDirectCacheWitness = witness;
  return true;
}
