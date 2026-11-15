import { type Channel, type HfdGraphOptions, type Slot } from '../domain/model';
import { restoreNativeGraphSelection } from '../domain/plot-layers';

export interface PhaseViewState {
  readonly channels: readonly boolean[];
  readonly sum: boolean;
}
export interface PhaseViewPatch {
  channels?: readonly boolean[];
  sum?: boolean;
}
export const phaseCurveAvailable = (channel: Channel) =>
  !!(channel.measurement?.impulse?.length || channel.measurement?.frequency?.length);

export interface GraphViewState {
  readonly sum: boolean;
  readonly measured: boolean;
  readonly rawMeasurements: readonly boolean[];
  readonly currentResult: boolean;
  readonly otherResults: boolean;
  readonly section: boolean;
  readonly sectionScope: 'selected' | 'channel';
  readonly nativeTracking: boolean;
  readonly phase: PhaseViewState;
}
export interface GraphViewContext {
  slot: Slot;
  channels: readonly Channel[];
  channelIndex: number;
  /** Opaque caller binding, for example the current project/preset identity. */
  binding?: string;
}
export interface GraphViewPatch {
  sum?: boolean;
  measured?: boolean;
  preset?: 'hfd' | 'outputs';
  rawMeasurements?: readonly boolean[];
  currentResult?: boolean;
  otherResults?: boolean;
  section?: boolean;
  sectionScope?: 'selected' | 'channel';
  phase?: PhaseViewPatch;
}
export interface GraphViewPlan {
  readonly slot: Slot;
  readonly channelIndex: number;
  readonly channelId: string;
  readonly binding?: string;
  readonly revision: number;
  readonly next: GraphViewState;
  readonly writeback?: Readonly<HfdGraphOptions>;
}
export type GraphViewSnapshot = Readonly<Record<Slot, GraphViewState>>;
export interface GraphViewController {
  getSnapshot(): GraphViewSnapshot;
  subscribe(listener: () => void): () => void;
  plan(context: GraphViewContext, patch: GraphViewPatch): GraphViewPlan;
  selection(
    context: GraphViewContext,
    options: { normalize: boolean; selectSection?: boolean; refreshPhase?: boolean },
  ): GraphViewPlan;
  commit(plan: GraphViewPlan): GraphViewState;
}

const loaded = (channel: Channel) =>
  !!(channel.measurement?.impulse?.length || channel.measurement?.frequency?.length);
const freezeState = (value: GraphViewState): GraphViewState =>
  Object.freeze({
    ...value,
    rawMeasurements: Object.freeze([...value.rawMeasurements]),
    phase: Object.freeze({ ...value.phase, channels: Object.freeze([...value.phase.channels]) }),
  });
const defaults = (): GraphViewState =>
  freezeState({
    sum: true,
    measured: false,
    rawMeasurements: [false, false, false],
    currentResult: true,
    otherResults: true,
    section: false,
    sectionScope: 'selected',
    nativeTracking: false,
    phase: { channels: [false, false, false], sum: false },
  });
const sameState = (a: GraphViewState, b: GraphViewState) =>
  a.sum === b.sum &&
  a.measured === b.measured &&
  a.currentResult === b.currentResult &&
  a.otherResults === b.otherResults &&
  a.section === b.section &&
  a.sectionScope === b.sectionScope &&
  a.nativeTracking === b.nativeTracking &&
  a.phase.sum === b.phase.sum &&
  a.phase.channels.every((value, index) => value === b.phase.channels[index]) &&
  a.rawMeasurements.every((value, index) => value === b.rawMeasurements[index]);

/** Temporary graph overlays are role-local, never project processing state.
 * A plan is deliberately inert: the caller validates its workspace binding and
 * applies optional native flag writeback before synchronously committing it.
 * Discarding a plan leaves both the view and model untouched. */
export function createGraphViewController(): GraphViewController {
  let snapshot: GraphViewSnapshot = Object.freeze({ left: defaults(), right: defaults() });
  const revisions: Record<Slot, number> = { left: 0, right: 0 },
    listeners = new Set<() => void>(),
    pending = new WeakSet<GraphViewPlan>(),
    phaseSelections = new WeakMap<GraphViewPlan, string>(),
    phaseBindings: Partial<Record<Slot, string>> = {};
  function check(context: GraphViewContext) {
    if (
      !context ||
      (context.slot !== 'left' && context.slot !== 'right') ||
      !Array.isArray(context.channels) ||
      context.channels.length !== 3 ||
      !Number.isInteger(context.channelIndex) ||
      context.channelIndex < 0 ||
      context.channelIndex >= context.channels.length ||
      !context.channels.every((channel) => channel && typeof channel.id === 'string') ||
      (context.binding !== undefined && typeof context.binding !== 'string')
    )
      throw new Error('Invalid graph view context');
    return context.channels[context.channelIndex];
  }
  function make(
    context: GraphViewContext,
    next: GraphViewState,
    writeback?: HfdGraphOptions,
  ): GraphViewPlan {
    const result: GraphViewPlan = Object.freeze({
      slot: context.slot,
      channelIndex: context.channelIndex,
      channelId: context.channels[context.channelIndex].id,
      ...(context.binding === undefined ? {} : { binding: context.binding }),
      revision: revisions[context.slot],
      next: freezeState(next),
      ...(writeback ? { writeback: Object.freeze({ ...writeback }) } : {}),
    });
    pending.add(result);
    return result;
  }
  function restore(context: GraphViewContext, state: GraphViewState): GraphViewState {
    const restored = restoreNativeGraphSelection(
      [...context.channels],
      state.rawMeasurements,
      context.channelIndex,
    );
    return { ...state, rawMeasurements: restored.rawMeasurements, sum: restored.showSum };
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    plan(context, patch) {
      const channel = check(context),
        before = snapshot[context.slot];
      if (!patch || typeof patch !== 'object') throw new Error('Invalid graph view patch');
      const allowed = new Set([
        'sum',
        'measured',
        'preset',
        'rawMeasurements',
        'currentResult',
        'otherResults',
        'section',
        'sectionScope',
        'phase',
      ]);
      if (Object.keys(patch).some((key) => !allowed.has(key)))
        throw new Error('Unknown graph view patch field');
      for (const key of ['sum', 'measured', 'currentResult', 'otherResults', 'section'] as const)
        if (patch[key] !== undefined && typeof patch[key] !== 'boolean')
          throw new Error('Invalid graph view toggle');
      if (patch.preset !== undefined && patch.preset !== 'hfd' && patch.preset !== 'outputs')
        throw new Error('Invalid graph view preset');
      if (
        patch.sectionScope !== undefined &&
        patch.sectionScope !== 'selected' &&
        patch.sectionScope !== 'channel'
      )
        throw new Error('Invalid section scope');
      if (patch.rawMeasurements !== undefined) {
        if (
          !Array.isArray(patch.rawMeasurements) ||
          patch.rawMeasurements.length !== 3 ||
          !patch.rawMeasurements.every((value) => typeof value === 'boolean')
        )
          throw new Error('Invalid raw measurement selection');
        if (patch.rawMeasurements.some((value, index) => value && !loaded(context.channels[index])))
          throw new Error('Load a measurement before showing its raw response');
      }
      if (patch.phase !== undefined) {
        if (
          !patch.phase ||
          typeof patch.phase !== 'object' ||
          Array.isArray(patch.phase) ||
          Object.keys(patch.phase).some((key) => key !== 'channels' && key !== 'sum')
        )
          throw new Error('Invalid phase view patch');
        if (patch.phase.sum !== undefined && typeof patch.phase.sum !== 'boolean')
          throw new Error('Invalid phase sum toggle');
        const selected = patch.phase.channels;
        if (selected !== undefined) {
          if (
            !Array.isArray(selected) ||
            selected.length !== 3 ||
            !selected.every((value) => typeof value === 'boolean')
          )
            throw new Error('Invalid phase curve selection');
          if (
            selected.some(
              (value, index) =>
                value !== before.phase.channels[index] &&
                !phaseCurveAvailable(context.channels[index]),
            )
          )
            throw new Error('Load a measurement before changing its phase visibility');
        }
      }
      let next: GraphViewState = { ...before },
        writeback: HfdGraphOptions | undefined;
      if (patch.preset === 'hfd') {
        next = restore(context, {
          ...next,
          measured: true,
          currentResult: true,
          otherResults: false,
          section: true,
          sectionScope: 'selected',
          nativeTracking: true,
        });
        if (channel.hfdGraph?.showMeasuredResponse && !loaded(channel))
          writeback = { ...channel.hfdGraph, showMeasuredResponse: false };
      } else if (patch.preset === 'outputs') {
        next = {
          ...next,
          currentResult: true,
          otherResults: true,
          section: false,
          nativeTracking: false,
        };
      }
      const restored = next;
      next = {
        ...next,
        ...(patch.sum === undefined ? {} : { sum: patch.sum }),
        ...(patch.measured === undefined ? {} : { measured: patch.measured }),
        ...(patch.rawMeasurements === undefined
          ? {}
          : { rawMeasurements: [...patch.rawMeasurements] }),
        ...(patch.currentResult === undefined ? {} : { currentResult: patch.currentResult }),
        ...(patch.otherResults === undefined ? {} : { otherResults: patch.otherResults }),
        ...(patch.section === undefined ? {} : { section: patch.section }),
        ...(patch.sectionScope === undefined ? {} : { sectionScope: patch.sectionScope }),
        ...(patch.phase === undefined
          ? {}
          : {
              phase: {
                channels: patch.phase.channels ?? next.phase.channels,
                sum: patch.phase.sum ?? next.phase.sum,
              },
            }),
      };
      if (
        (channel.hfdGraph || next.nativeTracking) &&
        (patch.sum !== undefined ||
          (patch.rawMeasurements !== undefined &&
            next.rawMeasurements[context.channelIndex] !==
              restored.rawMeasurements[context.channelIndex]))
      )
        writeback = {
          showMeasuredResponse: next.rawMeasurements[context.channelIndex],
          showSum: next.sum,
        };
      return make(context, next, writeback);
    },
    selection(context, options) {
      const channel = check(context);
      if (
        !options ||
        typeof options.normalize !== 'boolean' ||
        (options.selectSection !== undefined && typeof options.selectSection !== 'boolean') ||
        (options.refreshPhase !== undefined && typeof options.refreshPhase !== 'boolean')
      )
        throw new Error('Invalid graph view selection');
      let next = snapshot[context.slot],
        writeback: HfdGraphOptions | undefined;
      if (channel.hfdGraph || next.nativeTracking) {
        next = restore(context, next);
        if (options.normalize && channel.hfdGraph?.showMeasuredResponse && !loaded(channel))
          writeback = { ...channel.hfdGraph, showMeasuredResponse: false };
      }
      if (options.selectSection !== undefined)
        next = { ...next, sectionScope: options.selectSection ? 'selected' : 'channel' };
      // c5fc2d..47 checks the current group's phase box on selection and the
      // explicit Load/Clear refresh. Other redraws retain an explicit uncheck.
      const phaseBinding = `${context.binding ?? ''}:${context.channelIndex}:${channel.id}`;
      if (options.refreshPhase || phaseBindings[context.slot] !== phaseBinding) {
        const channels = [...next.phase.channels];
        channels[context.channelIndex] = true;
        next = { ...next, phase: { ...next.phase, channels } };
      }
      const plan = make(context, next, writeback);
      phaseSelections.set(plan, phaseBinding);
      return plan;
    },
    commit(plan) {
      if (!pending.has(plan) || plan.revision !== revisions[plan.slot])
        throw new Error('Graph view plan is stale or does not belong to this controller');
      pending.delete(plan);
      const phaseBinding = phaseSelections.get(plan);
      if (phaseBinding !== undefined) phaseBindings[plan.slot] = phaseBinding;
      revisions[plan.slot]++;
      // Native selection can restore the already-visible flags. Still consume
      // its revision/plan, without publishing a new React external-store value.
      if (sameState(snapshot[plan.slot], plan.next)) return snapshot[plan.slot];
      snapshot = Object.freeze({ ...snapshot, [plan.slot]: plan.next });
      listeners.forEach((listener) => listener());
      return plan.next;
    },
  };
}
