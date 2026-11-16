import type { Channel, Project } from './model';

export interface NativeGlobalDelayState {
  readonly globalDelayUs: number;
  readonly globalMaximum: number | undefined;
}
export interface NativeGlobalDelayChannelBefore extends NativeGlobalDelayState {
  readonly channelIndex: number;
  readonly channelId: string;
}
export interface NativeGlobalDelayChannelChange {
  readonly channelIndex: number;
  readonly channelId: string;
  readonly before: Readonly<NativeGlobalDelayState>;
  readonly value: Readonly<{ globalDelayUs: number; globalMaximum: number }>;
}
export interface NativeGlobalDelayReconciliationPlan {
  readonly presetIndex: number;
  readonly changed: boolean;
  readonly beforeChannels: readonly Readonly<NativeGlobalDelayChannelBefore>[];
  readonly channelChanges: readonly Readonly<NativeGlobalDelayChannelChange>[];
}

function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function channels(project: Readonly<Project>, presetIndex: number): Channel[] {
  requireValue(
    project?.model === 'FA503' &&
      Array.isArray(project.presets) &&
      project.presets.length === 3 &&
      Number.isInteger(presetIndex) &&
      presetIndex >= 0 &&
      presetIndex < 3 &&
      project.presets.every(
        (preset) => Array.isArray(preset?.channels) && preset.channels.length === 3,
      ),
    'Native Global Delay reconciliation requires a valid FA503 preset',
  );
  const all = project.presets.flatMap((preset) => preset.channels);
  requireValue(
    new Set(project.presets).size === 3 && new Set(all).size === 9,
    'Native Global Delay channels must not alias',
  );
  const selected = project.presets[presetIndex].channels;
  requireValue(
    selected.every(
      (channel) =>
        channel &&
        typeof channel.id === 'string' &&
        channel.id.length > 0 &&
        typeof channel.globalDelayUs === 'number' &&
        Number.isFinite(channel.globalDelayUs),
    ),
    'Native Global Delay values and channel identities must be finite and complete',
  );
  return selected;
}

function changes(
  before: readonly NativeGlobalDelayChannelBefore[],
): NativeGlobalDelayChannelChange[] {
  const first = before[0];
  // Native comparison is numeric equality, including +0/-0. The stored maximum
  // is irrelevant on this no-op path, even for legacy input without metadata.
  const mismatch = before.some((channel) => channel.globalDelayUs !== first.globalDelayUs);
  if (!mismatch) return [];
  requireValue(
    typeof first.globalMaximum === 'number' && Number.isFinite(first.globalMaximum),
    'Native Global Delay reconciliation needs the first saved maximum when values differ',
  );
  return before.flatMap((channel) =>
    Object.is(channel.globalDelayUs, first.globalDelayUs) &&
    Object.is(channel.globalMaximum, first.globalMaximum)
      ? []
      : [
          {
            channelIndex: channel.channelIndex,
            channelId: channel.channelId,
            before: Object.freeze({
              globalDelayUs: channel.globalDelayUs,
              globalMaximum: channel.globalMaximum,
            }),
            value: Object.freeze({
              globalDelayUs: first.globalDelayUs,
              globalMaximum: first.globalMaximum as number,
            }),
          },
        ],
  );
}

/** c7af20's current-preset raw Double operation. The application owns when it
 * runs; this helper does not select presets or enter a Graph. */
export function planNativeGlobalDelayReconciliation(
  project: Readonly<Project>,
  presetIndex: number,
): NativeGlobalDelayReconciliationPlan {
  const beforeChannels = channels(project, presetIndex).map((channel, channelIndex) =>
    Object.freeze({
      channelIndex,
      channelId: channel.id,
      globalDelayUs: channel.globalDelayUs,
      globalMaximum: channel.hfdDelay?.globalMaximum,
    }),
  );
  const channelChanges = changes(beforeChannels).map((change) => Object.freeze(change));
  return Object.freeze({
    presetIndex,
    changed: channelChanges.length > 0,
    beforeChannels: Object.freeze(beforeChannels),
    channelChanges: Object.freeze(channelChanges),
  });
}

/** Preflight all three raw states before applying any change. Only tiny scalar
 * records are captured: complete project/revision authority belongs upstream. */
export function applyNativeGlobalDelayReconciliation(
  project: Project,
  plan: NativeGlobalDelayReconciliationPlan,
): void {
  requireValue(
    plan &&
      Array.isArray(plan.beforeChannels) &&
      plan.beforeChannels.length === 3 &&
      Array.isArray(plan.channelChanges) &&
      plan.channelChanges.length <= 3,
    'Invalid native Global Delay reconciliation plan',
  );
  const selected = channels(project, plan.presetIndex);
  for (let index = 0; index < 3; index++) {
    const before = plan.beforeChannels[index],
      channel = selected[index];
    requireValue(
      before?.channelIndex === index &&
        before.channelId === channel.id &&
        Object.is(before.globalDelayUs, channel.globalDelayUs) &&
        Object.is(before.globalMaximum, channel.hfdDelay?.globalMaximum),
      'Native Global Delay channel or raw context changed',
    );
  }
  const expected = changes(plan.beforeChannels);
  requireValue(
    plan.changed === expected.length > 0 &&
      plan.channelChanges.length === expected.length &&
      expected.every((value, index) => {
        const actual = plan.channelChanges[index];
        return (
          actual?.channelIndex === value.channelIndex &&
          actual.channelId === value.channelId &&
          Object.is(actual.before?.globalDelayUs, value.before.globalDelayUs) &&
          Object.is(actual.before?.globalMaximum, value.before.globalMaximum) &&
          Object.is(actual.value?.globalDelayUs, value.value.globalDelayUs) &&
          Object.is(actual.value?.globalMaximum, value.value.globalMaximum)
        );
      }),
    'Invalid native Global Delay reconciliation changes',
  );
  for (const change of expected) {
    const channel = selected[change.channelIndex];
    channel.globalDelayUs = change.value.globalDelayUs;
    channel.hfdDelay = { ...channel.hfdDelay, globalMaximum: change.value.globalMaximum };
  }
}
