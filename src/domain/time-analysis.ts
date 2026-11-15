import { design, effectiveSections } from './dsp';
import { fft } from './fft';
import { firFrequencyGrid } from './chirp-z';
import { validateMeasurement } from './measurement';
import { effectiveFirTaps } from './fir-state';
import { effectiveHfdCropStart, validateHfdMeasurementOptions } from './hfd-measurement';
import { FS, type Channel, type Coefficients, type Preset } from './model';
import type { TimeSeries } from './time-series';

export interface TimeCurve {
  impulse: TimeSeries | null;
  step: TimeSeries | null;
  source: 'electrical' | 'measured-impulse' | 'unavailable';
  reason?: string;
  warnings: string[];
}
export interface TimeAnalysisOptions {
  preset?: Preset;
  measured?: boolean;
  sum?: boolean;
  /** Final display crop only; never changes the native synthesis FFT length. */
  length?: number;
  /** Zero-based graph selection, which determines native FFT length for all curves. */
  referenceChannel?: number;
}
export interface TimeAnalysis {
  channels: TimeCurve[];
  sum?: TimeCurve;
  warnings: string[];
  /** Native Fit truncated bounds remain in original measurement coordinates. */
  windowBounds?: { minMs: number; maxMs: number };
}

const CAPACITY = 65536;
const ENDPOINT_WARNING =
  'Recovered native timed synthesis doubles positive bins including DC and omits Nyquist; this endpoint convention is inferred from static code and awaits a native GUI fixture.';
const PERIODIC_WARNING =
  'Native timed synthesis is a finite periodic IFFT; electrical tails and delays can wrap across its record boundary.';
const unique = (warnings: string[]) => [...new Set(warnings)];
const unavailable = (reason: string, warnings: string[] = []): TimeCurve => ({
  impulse: null,
  step: null,
  source: 'unavailable',
  reason,
  warnings,
});

/** c6a1d0: shift left two before checking the absolute inclusive stop. The
 * default stop is 65535 even for a short loaded impulse; stop64 still gives64,
 * so a 65-sample source can fold. Preserve that recovered native behavior. */
function nativeLength(channel: Channel | undefined) {
  const native = channel?.hfdMeasurement;
  if (native) validateHfdMeasurementOptions(native);
  const end = channel?.measurement?.processing?.window?.end;
  const stop = native?.stopInclusive ?? (end === undefined ? CAPACITY - 1 : end - 1);
  if (!Number.isInteger(stop) || (!native && stop < 0))
    throw new Error('Invalid reference impulse window');
  let n = 1;
  do n *= 4;
  while (n < stop && n < CAPACITY);
  return n;
}

interface Prepared {
  sampleRate: number;
  source: 'electrical' | 'measured-impulse';
  samples?: number[];
  start: number;
  stop: number;
  sections: Coefficients[];
  taps?: number[];
  delaySeconds: number;
  muted: boolean;
  warnings: string[];
  windowBounds?: { minMs: number; maxMs: number };
}
const isUnity = (c: Coefficients) =>
  c.b0 === 1 && c.b1 === 0 && c.b2 === 0 && c.f1 === 0 && c.f2 === 0;

function prepare(channel: Channel, options: TimeAnalysisOptions): Prepared | TimeCurve {
  const warnings: string[] = [],
    preset = options.preset,
    taps = effectiveFirTaps(channel, preset),
    delaySeconds = (channel.delayUs + channel.globalDelayUs) / 1e6;
  if (!Number.isFinite(delaySeconds)) throw new Error('Non-finite electrical delay');
  const sections = channel.muted ? [] : effectiveSections(channel);
  if (preset?.eqEnabled) sections.push(...preset.inputEq.map(design));
  if (sections.some((c) => !Object.values(c).every(Number.isFinite)))
    throw new Error('Non-finite electrical response');
  if (taps)
    warnings.push(
      'FIR time-view parity uses the browser transfer model and awaits a native fixture.',
    );
  if (delaySeconds !== 0)
    warnings.push(
      'Signed electrical delays are included in timed analysis; native fractional-delay parity awaits a fixture.',
    );
  const common = {
    sections: sections.filter((c) => !isUnity(c)),
    taps,
    delaySeconds,
    muted: channel.muted,
    warnings,
  };
  if (!options.measured)
    return { ...common, sampleRate: FS, source: 'electrical', start: 0, stop: 0 };

  const measurement = channel.measurement;
  if (!measurement?.impulse?.length)
    return unavailable(
      measurement?.frequency?.length || measurement?.sourceSpectrum?.frequency.length
        ? 'A frequency-only measurement has no original impulse; a verified time response cannot be inferred from FRD magnitude or phase.'
        : 'No original measurement impulse is loaded for this channel.',
      warnings,
    );
  validateMeasurement(measurement);
  const processing = measurement.processing,
    window = processing?.window,
    native = channel.hfdMeasurement;
  if (native) validateHfdMeasurementOptions(native);
  const start = native ? effectiveHfdCropStart(native) : (window?.start ?? 0),
    stop = Math.min(
      native?.stopInclusive ?? (window ? window.end - 1 : CAPACITY - 1),
      CAPACITY - 1,
    ),
    sampleRate = native?.sampleRate ?? measurement.sampleRate;
  if (measurement.impulse.length > CAPACITY)
    warnings.push(
      'Native timed analysis uses only the first 65536 original samples; browser data beyond that capacity is excluded.',
    );
  if (!native && (start > stop || start >= measurement.impulse.length))
    return unavailable(
      'The selected window has no impulse samples within native capacity.',
      warnings,
    );
  if (native ? native.applyMicCorrection : processing?.calibrationEnabled)
    warnings.push(
      'Microphone calibration affects frequency displays and is not applied to native timed responses.',
    );
  if (
    native
      ? native.smoothBw > 0 || native.smoothPostBw > 0
      : (processing?.smoothingOctaves ?? 0) > 0
  )
    warnings.push('Frequency smoothing is not applied to native timed responses.');
  if (native ? native.phaseStart !== -1 : (window?.timeZero ?? 0) !== 0)
    warnings.push(
      native
        ? 'Native phase-start independently crops the phase display source; timed synthesis retains the arrival offset within the magnitude crop.'
        : 'Phase-start/time-zero changes displayed phase only; native timed synthesis retains the original arrival offset within the packed crop.',
    );
  if ((window?.taper ?? 0) !== 0)
    warnings.push(
      'Native timed analysis uses a rectangular crop; the browser frequency-window taper is not applied.',
    );
  if (start !== 0)
    warnings.push(
      'Native timed samples start at zero after crop packing; Fit truncated bounds remain in original source-time coordinates.',
    );
  return {
    ...common,
    sampleRate,
    source: 'measured-impulse',
    samples: measurement.impulse,
    start,
    stop,
    windowBounds: { minMs: (start / sampleRate) * 1000, maxMs: (stop / sampleRate) * 1000 },
  };
}

function bins(prepared: Prepared, n: number) {
  const re = new Float64Array(n),
    im = new Float64Array(n);
  if (prepared.samples) {
    const start = Math.max(0, prepared.start),
      stop = Math.min(prepared.stop, prepared.samples.length - 1, CAPACITY - 1);
    // FFT_L[k*floor(L/N)] equals FFT_N of these folded packed samples, since
    // every native N divides L. This preserves folding instead of truncating.
    for (let i = start; i <= stop; i++) re[(i - start) % n] += prepared.samples[i];
    if (stop - start + 1 > n)
      prepared.warnings.push(
        'The packed measurement exceeds the selected native FFT length and folds periodically.',
      );
    fft(re, im);
  } else re.fill(1);
  const step = (2 * Math.PI * prepared.sampleRate) / (n * FS),
    fir = prepared.taps ? firFrequencyGrid(prepared.taps, n / 2, step) : undefined;
  for (let k = 0; k < n / 2; k++) {
    if (prepared.muted) {
      re[k] = im[k] = 0;
      continue;
    }
    const theta = step * k,
      cr = Math.cos(theta),
      ci = -Math.sin(theta),
      c2 = cr * cr - ci * ci,
      s2 = 2 * cr * ci;
    let a = 1,
      b = 0;
    const multiply = (r: number, i: number) => {
      [a, b] = [a * r - b * i, a * i + b * r];
    };
    for (const c of prepared.sections) {
      const nr = c.b0 + c.b1 * cr + c.b2 * c2,
        ni = c.b1 * ci + c.b2 * s2,
        dr = 1 - c.f1 * cr - c.f2 * c2,
        di = -c.f1 * ci - c.f2 * s2,
        den = dr * dr + di * di;
      multiply((nr * dr + ni * di) / den, (ni * dr - nr * di) / den);
    }
    if (fir) multiply(fir.real[k], fir.imaginary[k]);
    const phase = (-2 * Math.PI * k * prepared.sampleRate * prepared.delaySeconds) / n;
    multiply(Math.cos(phase), Math.sin(phase));
    const r = re[k] * a - im[k] * b,
      i = re[k] * b + im[k] * a;
    re[k] = r;
    im[k] = i;
  }
  return { re, im };
}

/** c753e4/c4f3a8: positive half k=0..N/2-1 is doubled, no mirror is inserted,
 * then plain inverse FFT real parts are copied. Keep this known endpoint quirk
 * explicit rather than silently replacing the native path with irfft. */
function synthesize(
  spectrum: { re: Float64Array; im: Float64Array },
  sampleRate: number,
  source: TimeCurve['source'],
  warnings: string[],
  length: number | undefined,
): TimeCurve {
  const n = spectrum.re.length,
    re = new Float64Array(n),
    im = new Float64Array(n);
  for (let k = 0; k < n / 2; k++) {
    re[k] = 2 * spectrum.re[k];
    im[k] = 2 * spectrum.im[k];
  }
  fft(re, im, true);
  const count = Math.min(n, length ?? n),
    impulse = re.slice(0, count),
    step = new Float64Array(count);
  let integral = 0;
  for (let i = 0; i < count; i++) step[i] = integral += impulse[i];
  if (!impulse.every(Number.isFinite)) throw new Error('Timed response contains non-finite values');
  if (count < n) warnings.push('The returned view is cropped after full native synthesis.');
  return {
    impulse: { samples: impulse, sampleRate, startTimeMs: 0 },
    step: { samples: step, sampleRate, startTimeMs: 0 },
    source,
    warnings: unique([...warnings, ENDPOINT_WARNING, PERIODIC_WARNING]),
  };
}

/** Recovered native timed analysis, not a resampler or minimum-phase FRD
 * reconstruction. Raw/windowed measurement bins multiply the electrical model
 * at physical f=k*MeasFs/N; calibration/smoothing/phase-start never enter them.
 * One selected graph channel determines N for every series. Marked native
 * channels consume canonical local/shared crop snapshots; unmarked legacy
 * channels retain their earlier browser-window compatibility behavior. */
export function analyzeTimeResponses(
  channels: Channel[],
  options: TimeAnalysisOptions = {},
): TimeAnalysis {
  const reference = options.referenceChannel ?? 0;
  if (!Number.isInteger(reference) || reference < 0 || reference >= Math.max(1, channels.length))
    throw new Error('Invalid reference channel');
  if (options.length !== undefined && (!Number.isInteger(options.length) || options.length < 1))
    throw new Error('Time response length must be a positive integer');
  const n = nativeLength(channels[reference]),
    prepared: (Prepared | null)[] = [],
    spectra: ({ re: Float64Array; im: Float64Array } | null)[] = [];
  const curves = channels.map((channel) => {
    try {
      const p = prepare(channel, options);
      if ('impulse' in p) {
        prepared.push(null);
        spectra.push(null);
        return p;
      }
      const spectrum = bins(p, n);
      const curve = synthesize(spectrum, p.sampleRate, p.source, p.warnings, options.length);
      prepared.push(p);
      spectra.push(spectrum);
      return curve;
    } catch (error) {
      prepared.push(null);
      spectra.push(null);
      return unavailable(error instanceof Error ? error.message : String(error));
    }
  });
  const result: TimeAnalysis = {
    channels: curves,
    warnings: unique(curves.flatMap((c) => c.warnings)),
  };
  const bounds = prepared.flatMap((p) => (p?.windowBounds ? [p.windowBounds] : []));
  if (bounds.length)
    result.windowBounds = {
      minMs: Math.min(...bounds.map((b) => b.minMs)),
      maxMs: Math.max(...bounds.map((b) => b.maxMs)),
    };
  if (options.sum) {
    const included = channels.flatMap((c, i) => (c.includeInSum === false ? [] : [i])),
      available = included.filter((i) => prepared[i] && spectra[i]),
      skipped = included.filter((i) => !prepared[i]),
      warnings = unique(available.flatMap((i) => curves[i].warnings));
    if (options.measured && new Set(available.map((i) => prepared[i]!.start)).size > 1)
      warnings.push(
        available.every((i) => channels[i].hfdMeasurement)
          ? 'Per-channel crops are packed independently; different crop starts alter relative driver alignment. Use a shared native crop-start snapshot when a common origin is required.'
          : 'Per-channel crops are packed independently; different crop starts alter relative driver alignment. Native shared-crop-origin controls are not modeled for legacy channels.',
      );
    if (skipped.length)
      warnings.push(
        `Channels ${skipped.map((i) => i + 1).join(', ')} have no available time response and are omitted from the native sum.`,
      );
    if (!available.length)
      result.sum = unavailable('No included channels have an available time response.', warnings);
    else if (new Set(available.map((i) => prepared[i]!.sampleRate)).size !== 1)
      result.sum = unavailable(
        'A native measured time sum requires matching sample rates; no resampling is inferred.',
        warnings,
      );
    else {
      const re = new Float64Array(n),
        im = new Float64Array(n);
      for (const i of available)
        for (let k = 0; k < n / 2; k++) {
          re[k] += spectra[i]!.re[k];
          im[k] += spectra[i]!.im[k];
        }
      result.sum = synthesize(
        { re, im },
        prepared[available[0]]!.sampleRate,
        options.measured ? 'measured-impulse' : 'electrical',
        warnings,
        options.length,
      );
    }
    result.warnings = unique([...result.warnings, ...result.sum.warnings]);
  }
  return result;
}
