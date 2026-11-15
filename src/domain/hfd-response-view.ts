import type { Channel, Preset } from './model';
import { channelResponse, presetResponse } from './dsp';
import { measurementResponse } from './measurement';
import { hfdSmoothPlot } from './hfd-measurement';

export interface HfdViewCurve {
  db: number[];
  phase: number[];
  visible?: boolean;
}
export interface HfdResponseView {
  frequency: number[];
  channels: HfdViewCurve[];
  sum?: HfdViewCurve;
  centerOffsetDb: number;
  centered: boolean;
  warnings: string[];
}
const multiply = ([a, b]: [number, number], [c, d]: [number, number]): [number, number] => [
  a * c - b * d,
  a * d + b * c,
];
const loaded = (c: Channel) =>
  !!(c.measurement?.impulse?.length || c.measurement?.frequency?.length);

export function hfdCentering(channels: Channel[], enabled = true) {
  const allLoaded = channels.filter(loaded),
    available =
      allLoaded.length > 0 &&
      allLoaded.every((c) => c.hfdMeasurement && c.measurement?.hfdMagnitude),
    centered = enabled && available;
  return {
    available,
    centered,
    offsetDb: centered
      ? allLoaded.reduce((sum, c) => sum + c.measurement!.hfdMagnitude!.medianDb, 0) /
        allLoaded.length
      : 0,
  };
}

function phaseReference(channel: Channel, frequency: number): [number, number] {
  const reference = channel.hfdMeasurement && channel.measurement?.hfdPhase;
  if (!reference) {
    const [re, im] = channel.measurement
        ? measurementResponse(channel.measurement, frequency)
        : [1, 0],
      phase = Math.atan2(im, re);
    return [Math.cos(phase), Math.sin(phase)];
  }
  const fs = reference.frequency;
  let lo = 0,
    hi = fs.length - 1;
  if (!fs.length) return [1, 0];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fs[mid] <= frequency) lo = mid;
    else hi = mid;
  }
  if (frequency <= fs[0]) hi = lo = 0;
  if (frequency >= fs.at(-1)!) hi = lo = fs.length - 1;
  const t = lo === hi ? 0 : Math.log(frequency / fs[lo]) / Math.log(fs[hi] / fs[lo]),
    phase =
      ((reference.phase[lo] + t * (reference.phase[hi] - reference.phase[lo])) * Math.PI) / 180;
  return [Math.cos(phase), Math.sin(phase)];
}

/** Native GUI display layer: correct sources -> electrical cascade -> wrapped
 * phase or floor-clamped dB -> common centering -> post Gaussian. Stored complex
 * sources remain pre-post, so changing a display option cannot corrupt sums. */
export function buildHfdResponseView(
  channels: Channel[],
  options: {
    preset?: Preset;
    measured: boolean;
    sum?: boolean;
    centered?: boolean;
    referenceChannel?: number;
    showUnloadedFilters?: boolean;
  },
): HfdResponseView | null {
  const native = channels.find((c) => c.hfdMeasurement && loaded(c) && c.measurement?.hfdMagnitude);
  if (!options.measured || !native) return null;
  const frequency = native.measurement!.hfdMagnitude!.frequency.slice(),
    center = hfdCentering(channels, options.centered ?? true),
    centered = center.centered,
    centerOffsetDb = center.offsetDb,
    warnings: string[] = [];
  if (channels.filter(loaded).some((c) => !c.hfdMeasurement || !c.measurement?.hfdMagnitude))
    warnings.push(
      'Mixed browser/native sources: recovered native FFT semantics apply only to converted drivers.',
    );
  if ((options.centered ?? true) && !center.available)
    warnings.push(
      'Native centering requires every loaded driver to use HFD analysis; absolute dB is shown for this mixed preset.',
    );
  if (Math.abs(centerOffsetDb) > 100)
    warnings.push(
      'A silent or out-of-window native response creates an extreme common centering offset. Absolute dB is available.',
    );
  const electrical = (index: number, f: number) =>
    options.preset
      ? presetResponse(options.preset, index, f, false)
      : channelResponse(channels[index], f, false);
  const magnitude = (index: number, f: number) =>
    options.preset
      ? presetResponse(options.preset, index, f, true)
      : channelResponse(channels[index], f, true);
  const dedicated = (index: number, f: number) =>
    multiply(electrical(index, f), phaseReference(channels[index], f));
  const finish = (
    mag: [number, number][],
    phase: [number, number][],
    bw: number,
  ): HfdViewCurve => ({
    db: Array.from(
      hfdSmoothPlot(
        mag.map((v) => 20 * Math.log10(Math.max(1e-10, Math.hypot(...v))) - centerOffsetDb),
        frequency,
        bw,
      ),
    ),
    phase: Array.from(
      hfdSmoothPlot(
        phase.map((v) => (Math.atan2(v[1], v[0]) * 180) / Math.PI),
        frequency,
        bw,
      ),
    ),
  });
  const curves = channels.map((channel, index) => ({
    ...finish(
      frequency.map((f) => magnitude(index, f)),
      frequency.map((f) => dedicated(index, f)),
      channel.hfdMeasurement?.smoothPostBw ?? 0,
    ),
    visible: loaded(channel) || !!options.showUnloadedFilters,
  }));
  const result: HfdResponseView = {
    frequency,
    channels: curves,
    centerOffsetDb,
    centered,
    warnings,
  };
  if (options.sum) {
    const included = channels.flatMap((c, i) =>
        c.includeInSum === false || !loaded(c) ? [] : [i],
      ),
      sum = (evaluate: (index: number, f: number) => [number, number]) =>
        frequency.map((f) =>
          included.reduce<[number, number]>(
            (v, i) => {
              const [a, b] = evaluate(i, f);
              return [v[0] + a, v[1] + b];
            },
            [0, 0],
          ),
        );
    result.sum = finish(
      sum(magnitude),
      sum(dedicated),
      channels[options.referenceChannel ?? 0]?.hfdMeasurement?.smoothPostBw ?? 0,
    );
  }
  return result;
}

/** Values on the actual native log-grid polyline; no extrapolation beyond it. */
export function sampleHfdView(
  view: Pick<HfdResponseView, 'frequency'>,
  values: number[],
  frequency: number,
): number | null {
  const fs = view.frequency;
  if (frequency < fs[0] || frequency > fs.at(-1)!) return null;
  let lo = 0,
    hi = fs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fs[mid] <= frequency) lo = mid;
    else hi = mid;
  }
  const t = lo === hi ? 0 : Math.log(frequency / fs[lo]) / Math.log(fs[hi] / fs[lo]);
  return values[lo] + t * (values[hi] - values[lo]);
}
