import type { Channel, HfdImpulseZoom, Project, Slot } from '../domain/model';
import { validatePlotRange, type PlotRange } from '../domain/plot-viewport';
import type { PlotViewController } from './plot-view';

export interface NativeImpulseBinding {
  readonly slot: Slot;
  /** Zero-based preset and output indices, independent of linked edit roles. */
  readonly preset: number;
  readonly channelIndex: number;
  readonly channelId: string;
  readonly documentRevision: number;
}
export interface NativeImpulseWorkspace {
  readonly documents: Record<Slot, Project>;
  readonly slot: Slot;
  readonly preset: number;
  readonly channel: number;
  readonly documentRevision?: number;
}
export interface NativeImpulseViewOptions {
  plots: PlotViewController;
  state(): NativeImpulseWorkspace;
  edit(
    slots: Slot[],
    change: (project: Project) => void,
    options: { synchronizeLinks: false },
  ): void;
}
export interface NativeImpulseRestoreResult {
  restored: boolean;
  /** True once per newly observed binding/tuple, or an explicit force request. */
  changed: boolean;
  bindingChanged: boolean;
  tupleChanged: boolean;
  reason?: 'unchanged' | 'missing' | 'disabled' | 'invalid';
}

/** Raw native X is seconds, whereas browser time viewports use milliseconds.
 * False/default sentinel tuples are deliberately not normalized or applied. */
export function projectNativeImpulseZoom(
  zoom: HfdImpulseZoom | undefined,
  base: Readonly<PlotRange>,
): PlotRange | undefined {
  if (
    !zoom?.use ||
    ![zoom.left, zoom.right, zoom.top, zoom.bottom].every(Number.isFinite) ||
    zoom.left >= zoom.right ||
    zoom.bottom >= zoom.top
  )
    return;
  const timeMinMs = zoom.left * 1000,
    timeMaxMs = zoom.right * 1000;
  if (!Number.isFinite(timeMinMs) || !Number.isFinite(timeMaxMs) || timeMinMs >= timeMaxMs) return;
  const projected: PlotRange = {
    ...base,
    timeMinMs,
    timeMaxMs,
    amplitudeMin: zoom.bottom,
    amplitudeMax: zoom.top,
  };
  // Finite stored endpoints can still overflow their span, or inherit an
  // unsupported browser axis from the runtime base. Keep such native metadata
  // intact and let the host choose a view-only fit instead of throwing in a
  // passive React effect.
  if (!Number.isFinite(timeMaxMs - timeMinMs) || !Number.isFinite(zoom.top - zoom.bottom)) return;
  try {
    validatePlotRange(projected);
    return projected;
  } catch {
    return;
  }
}

export function nativeImpulseZoomFromRange(range: Readonly<PlotRange>): HfdImpulseZoom {
  if (
    !range ||
    ![range.timeMinMs, range.timeMaxMs, range.amplitudeMin, range.amplitudeMax].every(
      Number.isFinite,
    ) ||
    range.timeMinMs >= range.timeMaxMs ||
    range.amplitudeMin >= range.amplitudeMax ||
    !Number.isFinite(range.timeMaxMs - range.timeMinMs) ||
    !Number.isFinite(range.amplitudeMax - range.amplitudeMin)
  )
    throw new Error('Impulse bounds must be finite with each minimum below its maximum');
  const result: HfdImpulseZoom = {
    left: range.timeMinMs / 1000,
    right: range.timeMaxMs / 1000,
    top: range.amplitudeMax,
    bottom: range.amplitudeMin,
    use: true,
  };
  if (result.left >= result.right)
    throw new Error('Impulse time bounds cannot be represented in native seconds');
  return result;
}

const equalZoom = (a: HfdImpulseZoom | undefined, b: HfdImpulseZoom) =>
  a?.left === b.left &&
  a.right === b.right &&
  a.top === b.top &&
  a.bottom === b.bottom &&
  a.use === b.use;
const key = (binding: NativeImpulseBinding) =>
  `${binding.slot}:${binding.preset}:${binding.channelIndex}:${binding.channelId}`;
const fingerprint = (zoom: HfdImpulseZoom | undefined) =>
  zoom ? JSON.stringify([zoom.left, zoom.right, zoom.top, zoom.bottom, zoom.use]) : 'missing';

/** HFD5.2.4.24 persists one options tuple per ptImpulse group, not per chart
 * mode. c6c908/c6c990 save all ImpChart axes on mouse-up; c6c99c saves them
 * on forward zoom and separately copies only X to Step. Fit c6d57c/c6d6fc
 * also calls c6c908. Selection c66da2..66ebe reads saved bounds without
 * changing the tuple. Restore must never imitate the forward zoom callback.
 *
 * This controller writes only the captured output in one role, with link
 * normalization disabled. The host must call commit after the final range
 * action, not during pointer moves; a canceled gesture never commits. Browser
 * Reset is a separate action: no native ZoomUse=false callback is inferred. */
export function createNativeImpulseView(options: NativeImpulseViewOptions) {
  const issued = new WeakSet<NativeImpulseBinding>(),
    observed: Partial<Record<Slot, { key: string; fingerprint: string }>> = {};
  function current(): { binding: NativeImpulseBinding; channel: Channel } {
    const state = options.state(),
      channel = state.documents[state.slot]?.presets[state.preset]?.channels[state.channel],
      revision = state.documentRevision ?? 0;
    if (
      !['left', 'right'].includes(state.slot) ||
      !Number.isInteger(state.preset) ||
      state.preset < 0 ||
      state.preset > 2 ||
      !Number.isInteger(state.channel) ||
      state.channel < 0 ||
      state.channel > 2 ||
      !channel ||
      typeof channel.id !== 'string' ||
      !channel.id ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    )
      throw new Error('Invalid native Impulse view selection');
    return {
      channel,
      binding: Object.freeze({
        slot: state.slot,
        preset: state.preset,
        channelIndex: state.channel,
        channelId: channel.id,
        documentRevision: revision,
      }),
    };
  }
  function observe(binding: NativeImpulseBinding, channel: Channel) {
    observed[binding.slot] = {
      key: key(binding),
      fingerprint: fingerprint(channel.hfdImpulseZoom),
    };
  }
  return {
    /** Explicit full replacements may retain the same IDs and raw tuple. Mark
     * those roles unobserved now, including when Impulse is not visible yet. */
    invalidate(slots: readonly Slot[]): void {
      if (!Array.isArray(slots) || slots.some((slot) => slot !== 'left' && slot !== 'right'))
        throw new Error('Invalid native Impulse view roles');
      for (const slot of new Set<Slot>(slots)) delete observed[slot];
    },
    capture(): NativeImpulseBinding {
      const { binding } = current();
      issued.add(binding);
      return binding;
    },
    restore(input?: { force?: boolean }): NativeImpulseRestoreResult {
      const { binding, channel } = current(),
        previous = observed[binding.slot],
        signature = fingerprint(channel.hfdImpulseZoom),
        bindingChanged = previous?.key !== key(binding),
        tupleChanged = previous?.fingerprint !== signature,
        change = {
          changed: !!input?.force || bindingChanged || tupleChanged,
          bindingChanged,
          tupleChanged,
        };
      if (!change.changed) return { ...change, restored: false, reason: 'unchanged' };
      observe(binding, channel);
      if (!channel.hfdImpulseZoom) return { ...change, restored: false, reason: 'missing' };
      if (!channel.hfdImpulseZoom.use) return { ...change, restored: false, reason: 'disabled' };
      const context = { slot: binding.slot, mode: 'Impulse' as const },
        range = projectNativeImpulseZoom(
          channel.hfdImpulseZoom,
          options.plots.getSnapshot()[binding.slot].Impulse.range,
        );
      if (!range) return { ...change, restored: false, reason: 'invalid' };
      options.plots.restore(context, range);
      return { ...change, restored: true };
    },
    commit(binding: NativeImpulseBinding, range?: Readonly<PlotRange>) {
      if (!issued.has(binding))
        throw new Error('Capture a fresh Impulse view binding before saving');
      issued.delete(binding);
      const latest = current();
      if (
        key(latest.binding) !== key(binding) ||
        latest.binding.documentRevision !== binding.documentRevision
      )
        throw new Error('The Impulse target changed during this action; choose the view again');
      const zoom = nativeImpulseZoomFromRange(
        range ?? options.plots.getSnapshot()[binding.slot].Impulse.range,
      );
      if (equalZoom(latest.channel.hfdImpulseZoom, zoom)) {
        observe(latest.binding, latest.channel);
        return { changed: false, zoom: Object.freeze(zoom) };
      }
      options.edit(
        [binding.slot],
        (project) => {
          const destination = project.presets[binding.preset]?.channels[binding.channelIndex];
          if (destination?.id !== binding.channelId) throw new Error('The Impulse output changed');
          destination.hfdImpulseZoom = { ...zoom };
        },
        { synchronizeLinks: false },
      );
      const after = current();
      if (key(after.binding) === key(binding)) observe(after.binding, after.channel);
      return { changed: true, zoom: Object.freeze(zoom) };
    },
  };
}

export type NativeImpulseView = ReturnType<typeof createNativeImpulseView>;
