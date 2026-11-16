import type { Filter } from './model';
import { HFD_MANUAL_GAIN_BOUNDS } from './manual-parameter';
import { normalizeManualNumberDragGain } from './manual-number';

export interface ManualGraphDragPointer {
  /** Absolute current axis X after the chart's coordinate conversion/clamp. */
  frequency: number;
  /** Captured mouse-down axis Y and current clamped axis Y, both Doubles. */
  originAxisY: number;
  axisY: number;
}

/** Native ordinary Magnitude drag only. Frequency is a Single point, distinct
 * from typed one-decimal frequency. Gain uses the captured role's own origin;
 * no field-wheel state, AdditionalGain ceiling or Input EQ profile applies. */
export function normalizeManualGraphDrag(
  originFilter: Readonly<Filter>,
  pointer: Readonly<ManualGraphDragPointer>,
): Partial<Filter> {
  if ([pointer.frequency, pointer.originAxisY, pointer.axisY].some((v) => !Number.isFinite(v)))
    throw new Error('Graph drag requires finite axis coordinates');
  const frequency = Math.fround(pointer.frequency);
  if (!Number.isFinite(frequency)) throw new Error('Graph frequency cannot be stored as Single');
  const patch: Partial<Filter> = frequency > 0 ? { frequency } : {};
  // c63d01..10: native enums5/6/8, independently of Q availability.
  if (['peak', 'lowshelf1', 'highshelf1', 'lowshelf2', 'highshelf2'].includes(originFilter.kind)) {
    const gain = normalizeManualNumberDragGain(
      originFilter.gain,
      pointer.originAxisY,
      pointer.axisY,
      HFD_MANUAL_GAIN_BOUNDS,
    );
    if (gain) patch.gain = gain.value;
  }
  return patch;
}
