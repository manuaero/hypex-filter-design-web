import type { Project, Slot } from '../domain/model';
import {
  applyNativeGlobalDelayReconciliation,
  planNativeGlobalDelayReconciliation,
  type NativeGlobalDelayReconciliationPlan,
} from '../domain/native-global-delay';

export interface NativeOrdinarySavePostPlan {
  readonly slot: Slot;
  readonly presetIndex: number;
  readonly changed: boolean;
  readonly globalDelay: NativeGlobalDelayReconciliationPlan;
}

function requireSlot(slot: Slot): void {
  if (slot !== 'left' && slot !== 'right')
    throw new Error('Native Save post-state requires an explicit workspace role');
}

/** Inert current-preset post-state only. The caller owns the immutable serialized
 * preimage, actual writer return, full workspace fences and publication timing. */
export function planNativeOrdinarySavePostState(
  project: Readonly<Project>,
  slot: Slot,
  presetIndex: number,
): NativeOrdinarySavePostPlan {
  requireSlot(slot);
  const globalDelay = planNativeGlobalDelayReconciliation(project, presetIndex);
  return Object.freeze({ slot, presetIndex, changed: globalDelay.changed, globalDelay });
}

/** Apply on a validated detached proposal after the admitted serializer returns.
 * A normal Boolean-false return is not a success gate. This pure helper does not
 * admit a writer outcome, retain project references, select a preset or clear
 * dirty flags; those responsibilities remain with the outer lifecycle. */
export function applyNativeOrdinarySavePostState(
  detached: Project,
  slot: Slot,
  plan: NativeOrdinarySavePostPlan,
): void {
  requireSlot(slot);
  if (
    !plan?.globalDelay ||
    plan.slot !== slot ||
    plan.presetIndex !== plan.globalDelay.presetIndex ||
    plan.changed !== plan.globalDelay.changed
  )
    throw new Error('Native Save post-state role or plan context changed');
  applyNativeGlobalDelayReconciliation(detached, plan.globalDelay);
}
