import { editManualFilter } from './editing';
import { assertProjectLinks } from './links';
import { normalizeManualGraphDrag, type ManualGraphDragPointer } from './manual-graph-drag';
import { type Channel, type Filter, type FilterKind, type Project, type Slot } from './model';

export interface ManualFilterDragLocation {
  presetIndex: number;
  channelIndex: number;
  filterIndex: number;
}
type LinkContext = { id: string; linkedTo: number | undefined; filterIds: string[] }[];
interface CapturedRole {
  slot: Slot;
  originFilter: Filter;
  expectedFilter: Filter;
  channelId: string;
  links: LinkContext;
  expectedCoefficientCache: Channel['coefficientCache'];
}
export interface ManualFilterDragCapture {
  location: Readonly<ManualFilterDragLocation>;
  slots: readonly Slot[];
  revision?: number;
  roles: readonly Readonly<CapturedRole>[];
}
export interface ManualFilterDragPlan {
  capture: ManualFilterDragCapture;
  changedSlots: Slot[];
  roles: {
    slot: Slot;
    beforeFilter: Filter;
    nextFilter: Filter;
    patch: Partial<Filter>;
    changed: boolean;
    beforeCoefficientCache: Channel['coefficientCache'];
    nextCoefficientCache: Channel['coefficientCache'];
  }[];
  nextCapture: ManualFilterDragCapture;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
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
  const ak = Object.keys(a),
    bk = Object.keys(b);
  return (
    ak.length === bk.length &&
    ak.every(
      (key) =>
        Object.hasOwn(b, key) &&
        same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}
function validRevision(revision: number | undefined) {
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0))
    throw new Error('Invalid graph drag document revision');
}
export function supportsManualGraphDrag(kind: FilterKind): boolean {
  return [
    'lowpass1',
    'lowpass2',
    'highpass1',
    'highpass2',
    'peak',
    'lowshelf1',
    'highshelf1',
    'lowshelf2',
    'highshelf2',
    'asymmetric',
    'allpass1',
    'allpass2',
  ].includes(kind);
}

function target(project: Project, location: Readonly<ManualFilterDragLocation>) {
  if (
    !project ||
    project.model !== 'FA503' ||
    project.sampleRate !== 93750 ||
    project.presets.length !== 3
  )
    throw new Error('Ordinary graph drag requires an independent FA503 design');
  const { presetIndex, channelIndex, filterIndex } = location;
  if (
    ![presetIndex, channelIndex, filterIndex].every(Number.isSafeInteger) ||
    presetIndex < 0 ||
    presetIndex > 2 ||
    channelIndex < 0 ||
    channelIndex > 2 ||
    filterIndex < 0 ||
    filterIndex > 14
  )
    throw new Error('Invalid graph drag target');
  const channels = project.presets.flatMap((preset) => preset.channels);
  if (
    new Set(project.presets).size !== 3 ||
    channels.length !== 9 ||
    new Set(channels).size !== 9 ||
    project.presets.some((preset) => preset.channels.length !== 3)
  )
    throw new Error('Aliased or malformed graph channels');
  for (const channel of channels)
    if (
      channel.filters.length !== 15 ||
      channels.some((other) => other !== channel && other.filters === channel.filters)
    )
      throw new Error('Aliased or malformed graph biquad arrays');
  assertProjectLinks(project);
  const preset = project.presets[presetIndex],
    channel = preset.channels[channelIndex],
    filter = channel.filters[filterIndex];
  if (channel.linkedTo !== undefined) throw new Error('A linked graph destination is read-only');
  if (!filter || !supportsManualGraphDrag(filter.kind))
    throw new Error('This section has no ordinary graph marker');
  if (
    !filter.id ||
    !channel.id ||
    ![filter.frequency, filter.q, filter.gain, filter.frequency2, filter.q2].every(Number.isFinite)
  )
    throw new Error('Malformed ordinary graph filter');
  if (
    filter.frequency <= 0 ||
    filter.q <= 0 ||
    (filter.kind === 'asymmetric' && (filter.frequency2 <= 0 || filter.q2 <= 0))
  )
    throw new Error('Malformed ordinary graph frequency/Q');
  if (
    filter.coefficients !== undefined &&
    !['b0', 'b1', 'b2', 'f1', 'f2'].every((key) =>
      Number.isFinite(filter.coefficients![key as keyof NonNullable<Filter['coefficients']>]),
    )
  )
    throw new Error('Malformed graph coefficient cache');
  return {
    channel,
    filter,
    links: preset.channels.map((c) => ({
      id: c.id,
      linkedTo: c.linkedTo,
      filterIds: c.filters.map((f) => f.id),
    })),
  };
}
function currentRole(
  project: Project,
  capture: ManualFilterDragCapture,
  role: Readonly<CapturedRole>,
) {
  const current = target(project, capture.location);
  if (
    current.channel.id !== role.channelId ||
    !same(current.links, role.links) ||
    !same(current.filter, role.expectedFilter) ||
    !Object.is(current.channel.coefficientCache, role.expectedCoefficientCache)
  )
    throw new Error('The graph drag role or target changed');
  return current;
}

/** Capture actual role keys once. Imported duplicate IDs do not identify a role.
 * Origin gains stay fixed; expected filters track only accepted own updates. */
export function captureManualFilterDrag(
  documents: Record<Slot, Project>,
  slots: readonly Slot[],
  location: ManualFilterDragLocation,
  revision?: number,
): ManualFilterDragCapture {
  validRevision(revision);
  if (
    !slots.length ||
    slots.length > 2 ||
    new Set(slots).size !== slots.length ||
    slots.some((slot) => slot !== 'left' && slot !== 'right')
  )
    throw new Error('Invalid graph drag roles');
  if (new Set(slots.map((slot) => documents[slot])).size !== slots.length)
    throw new Error('Graph drag roles alias the same design');
  const targets = slots.map((slot) => ({ slot, ...target(documents[slot], location) }));
  if (
    new Set(targets.map((role) => role.channel)).size !== targets.length ||
    new Set(targets.map((role) => role.filter)).size !== targets.length
  )
    throw new Error('Graph drag roles alias processing objects');
  const processing = slots.map(
    (slot) =>
      new Set<object>(
        documents[slot].presets.flatMap((preset) => [
          preset,
          preset.channels,
          ...preset.channels.flatMap((channel) => [channel, channel.filters, ...channel.filters]),
        ]),
      ),
  );
  if (processing.length === 2 && [...processing[0]].some((value) => processing[1].has(value)))
    throw new Error('Graph drag roles alias processing objects');
  return freeze({
    location: { ...location },
    slots: [...slots],
    ...(revision === undefined ? {} : { revision }),
    roles: targets.map(({ slot, channel, filter, links }) => ({
      slot,
      originFilter: structuredClone(filter),
      expectedFilter: structuredClone(filter),
      channelId: channel.id,
      links,
      expectedCoefficientCache: channel.coefficientCache,
    })),
  });
}

/** Preflight every role before any mutation. Pointer X is absolute and common;
 * each gain uses its own captured origin and the cumulative native Y delta.
 * The caller adopts nextCapture only after its atomic workspace edit succeeds. */
export function planManualFilterDrag(
  documents: Record<Slot, Project>,
  capture: ManualFilterDragCapture,
  pointer: Readonly<ManualGraphDragPointer>,
  revision?: number,
): ManualFilterDragPlan {
  validRevision(revision);
  if (capture.revision !== undefined && revision !== capture.revision)
    throw new Error('The graph drag document revision changed');
  const targets = capture.roles.map((role) => ({
    role,
    ...currentRole(documents[role.slot], capture, role),
  }));
  const roles = targets.map(({ role, channel, filter }) => {
    const native = normalizeManualGraphDrag(role.originFilter, pointer),
      patch: Partial<Filter> = {};
    for (const field of ['frequency', 'gain'] as const)
      if (native[field] !== undefined && !Object.is(native[field], filter[field]))
        patch[field] = native[field];
    const changed = Object.keys(patch).length > 0;
    const nextFilter = changed
      ? editManualFilter(filter, patch, {
          redesign: true,
          manualFrequency: false,
          manualParameters: false,
        })
      : structuredClone(filter);
    return {
      slot: role.slot,
      beforeFilter: structuredClone(filter),
      nextFilter,
      patch,
      changed,
      beforeCoefficientCache: channel.coefficientCache,
      nextCoefficientCache:
        changed && capture.location.filterIndex === 0
          ? ('base' as const)
          : channel.coefficientCache,
    };
  });
  const changedSlots = roles.filter((role) => role.changed).map((role) => role.slot);
  const nextRevision =
    capture.revision === undefined ? undefined : capture.revision + (changedSlots.length ? 1 : 0);
  validRevision(nextRevision);
  const nextCapture = changedSlots.length
    ? freeze({
        ...capture,
        ...(nextRevision === undefined ? {} : { revision: nextRevision }),
        roles: capture.roles.map((role) => {
          const next = roles.find((value) => value.slot === role.slot)!;
          return {
            ...role,
            expectedFilter: structuredClone(next.nextFilter),
            expectedCoefficientCache: next.nextCoefficientCache,
          };
        }),
      })
    : capture;
  return freeze({ capture, changedSlots, roles, nextCapture });
}

/** Apply a preflighted explicit role to a detached transaction copy. The
 * workspace owns linked-follower synchronization after every role validates. */
export function applyManualFilterDrag(
  project: Project,
  slot: Slot,
  plan: ManualFilterDragPlan,
): void {
  const captured = plan.capture.roles.find((role) => role.slot === slot),
    role = plan.roles.find((role) => role.slot === slot);
  if (!captured || !role) throw new Error('Graph drag role was not captured');
  const current = currentRole(project, plan.capture, captured);
  if (
    !same(current.filter, role.beforeFilter) ||
    !Object.is(current.channel.coefficientCache, role.beforeCoefficientCache)
  )
    throw new Error('The graph drag apply target changed');
  if (!role.changed) return;
  current.channel.filters[plan.capture.location.filterIndex] = structuredClone(role.nextFilter);
  if (role.nextCoefficientCache === undefined) delete current.channel.coefficientCache;
  else current.channel.coefficientCache = role.nextCoefficientCache;
}
