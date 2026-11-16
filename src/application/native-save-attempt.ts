import type { Project, Slot } from '../domain/model';
import { projectSchema } from '../domain/files';
import { parseExecutionPrincipal, type ExecutionPrincipal } from './execution-context';
import {
  planNativeOrdinarySavePostState,
  type NativeOrdinarySavePostPlan,
} from './native-save-lifecycle';

export interface NativeOrdinarySaveContext {
  readonly slot: Slot;
  /** Original current workspace reference, never an exported snapshot. */
  readonly project: Project;
  readonly presetIndex: number;
  readonly expectedRevision: number;
}
export interface NativeOrdinarySaveSettlement {
  readonly changed: boolean;
  readonly published: boolean;
  readonly durable: boolean;
  readonly normalResult: boolean;
}
export interface NativeOrdinarySaveAttemptSnapshot {
  readonly phase: 'ready' | 'writing' | 'published' | 'complete' | 'unconfirmed';
  readonly changed: boolean;
  readonly normalResult?: boolean;
}
export interface NativeOrdinarySaveAttempt {
  beforeWrite(principal: ExecutionPrincipal): void;
  returned(
    principal: ExecutionPrincipal,
    value: boolean,
  ): Promise<Readonly<NativeOrdinarySaveSettlement>>;
  notReturned(): void;
  retryPersistence(): Promise<Readonly<NativeOrdinarySaveSettlement>>;
  getSnapshot(): Readonly<NativeOrdinarySaveAttemptSnapshot>;
}
export interface NativeOrdinarySaveAttemptOptions {
  state(): { documents: Record<Slot, Project>; documentRevision?: number };
  currentPresetIndex(slot: Slot): number;
  /** Synchronous, independent, atomic workspace publication for all plans. */
  publish(plans: readonly NativeOrdinarySavePostPlan[]): void;
  persist(): Promise<void>;
}

const fail = (message: string): never => {
  throw new Error(`Native ordinary Save ${message}`);
};
const preset = (value: number) => Number.isInteger(value) && value >= 0 && value < 3;

/** Page-local authority for one actual folder-writer attempt. This controller
 * does not serialize files or admit directory receipts. Its trusted adapter
 * calls returned only after a normal writer return; throws remain unconfirmed.
 * Historical receipts cannot reconstruct this capability after a reload. */
export function createNativeOrdinarySaveAttempt(
  input: {
    principal: ExecutionPrincipal;
    contexts: readonly NativeOrdinarySaveContext[];
  },
  options: NativeOrdinarySaveAttemptOptions,
): NativeOrdinarySaveAttempt {
  const principal = parseExecutionPrincipal({
    owner: input?.principal?.owner,
    scope: input?.principal?.scope,
  });
  if (!/^workspace:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(principal.owner))
    fail('requires trusted workspace admission');
  if (!Array.isArray(input.contexts) || input.contexts.length < 1 || input.contexts.length > 2)
    fail('requires one or two explicit role contexts');
  const seen = new Set<Slot>();
  let contexts = input.contexts.map((context): NativeOrdinarySaveContext => {
    if (
      !context ||
      (context.slot !== 'left' && context.slot !== 'right') ||
      seen.has(context.slot) ||
      !preset(context.presetIndex) ||
      !Number.isSafeInteger(context.expectedRevision) ||
      context.expectedRevision < 0
    )
      fail('requires distinct roles, valid presets and revisions');
    seen.add(context.slot);
    projectSchema.parse(context.project);
    return Object.freeze({ ...context });
  });
  if (contexts.some((context) => context.expectedRevision !== contexts[0].expectedRevision))
    fail('requires one workspace revision for every role');
  const plans = Object.freeze(
      contexts.map((context) =>
        planNativeOrdinarySavePostState(context.project, context.slot, context.presetIndex),
      ),
    ),
    changed = plans.some((plan) => plan.changed);
  let phase: NativeOrdinarySaveAttemptSnapshot['phase'] = 'ready',
    normalResult: boolean | undefined,
    settlement: Readonly<NativeOrdinarySaveSettlement> | undefined,
    persistence: Promise<Readonly<NativeOrdinarySaveSettlement>> | undefined;

  const actor = (value: ExecutionPrincipal) => {
    const current = parseExecutionPrincipal({ owner: value?.owner, scope: value?.scope });
    // Directory authority already admits the execution scope. A save started
    // in the UI may be continued from an admitted MCP scope of the same owner.
    if (current.owner !== principal.owner) fail('belongs to another workspace');
  };
  const unconfirmed = () => {
    contexts = [];
    phase = 'unconfirmed';
  };
  const fence = () => {
    try {
      const state = options.state();
      for (const [index, context] of contexts.entries()) {
        if (
          (state.documentRevision ?? 0) !== context.expectedRevision ||
          state.documents[context.slot] !== context.project ||
          options.currentPresetIndex(context.slot) !== context.presetIndex
        )
          fail('workspace, role or current preset changed');
        const before = plans[index].globalDelay.beforeChannels,
          current = planNativeOrdinarySavePostState(
            context.project,
            context.slot,
            context.presetIndex,
          ).globalDelay.beforeChannels;
        if (
          current.some(
            (channel, i) =>
              channel.channelId !== before[i].channelId ||
              channel.channelIndex !== before[i].channelIndex ||
              !Object.is(channel.globalDelayUs, before[i].globalDelayUs) ||
              !Object.is(channel.globalMaximum, before[i].globalMaximum),
          )
        )
          fail('raw Global Delay context changed');
      }
    } catch (error) {
      unconfirmed();
      throw error;
    }
  };
  // Validate every target before the adapter can admit its first writer.
  fence();

  const persist = (): Promise<Readonly<NativeOrdinarySaveSettlement>> => {
    if (persistence) return persistence;
    if (phase !== 'published' || !settlement) fail('has no pending published state to persist');
    const pending = Promise.resolve()
      .then(() => options.persist())
      .then(() => {
        phase = 'complete';
        settlement = Object.freeze({ ...settlement!, durable: true });
        return settlement;
      });
    persistence = pending.finally(() => {
      persistence = undefined;
    });
    return persistence;
  };

  return Object.freeze({
    beforeWrite(value: ExecutionPrincipal) {
      actor(value);
      if (phase !== 'ready' && phase !== 'writing') fail('attempt has already been consumed');
      fence();
      phase = 'writing';
    },
    async returned(value: ExecutionPrincipal, result: boolean) {
      actor(value);
      if (typeof result !== 'boolean') fail('requires an explicit normal Boolean return');
      if ((phase === 'complete' || phase === 'published') && settlement) return settlement;
      if (phase !== 'writing') fail('has no admitted normal writer return');
      fence();
      normalResult = result;
      if (!changed) {
        contexts = [];
        phase = 'complete';
        settlement = Object.freeze({
          changed: false,
          published: false,
          durable: true,
          normalResult: result,
        });
        return settlement;
      }
      try {
        // Both true and false are normal returns. The serializer's Boolean is
        // recorded, not used as a gate for the source-qualified posthook.
        options.publish(plans);
      } catch (error) {
        unconfirmed();
        throw error;
      }
      contexts = [];
      phase = 'published';
      settlement = Object.freeze({
        changed: true,
        published: true,
        durable: false,
        normalResult: result,
      });
      return persist();
    },
    notReturned() {
      if (phase === 'ready' || phase === 'writing') unconfirmed();
    },
    retryPersistence() {
      if (phase === 'complete' && settlement) return Promise.resolve(settlement);
      return persist();
    },
    getSnapshot() {
      return Object.freeze({
        phase,
        changed,
        ...(normalResult === undefined ? {} : { normalResult }),
      });
    },
  });
}
