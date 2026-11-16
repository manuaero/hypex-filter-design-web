import type { Channel, Preset } from './model';
import { channelResponse, presetResponse } from './dsp';
import { designHfd } from './hfd-math';

/** Analysis-only native frequency projection. Native BQ evaluation uses the
 * parameter/root cascade, independently of the saved direct-coefficient cache.
 * Raw coefficients remain the browser's exact-vector extension. This never
 * changes cache interpretation, compilation or time-domain processing. */
export function prepareNativeElectricalView(channels: Channel[], preset?: Preset) {
  const projected = channels.map((channel) =>
      channel.hfdMeasurement
        ? {
            ...channel,
            // Native electrical Magnitude/Phase omit the stored Gain.Mute bit.
            // The original channel still owns compiler/time/mute semantics.
            muted: false,
            filters: channel.filters.map((filter) =>
              filter.enabled && filter.kind !== 'raw' && filter.kind !== 'unity'
                ? { ...filter, coefficients: designHfd(filter) }
                : filter,
            ),
          }
        : channel,
    ),
    // Input EQ and placement-gated FIR retain their existing response semantics.
    projectedPreset = preset ? { ...preset, channels: projected } : undefined;
  return {
    evaluate(index: number, frequency: number, measured = false): [number, number] {
      return projectedPreset
        ? presetResponse(projectedPreset, index, frequency, measured)
        : channelResponse(projected[index], frequency, measured);
    },
  };
}
