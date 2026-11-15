import { fft } from './fft';

/** Native microphone files contain frequency (Hz) and response (dB), not phase. */
export interface HfdCalibrationCurve {
  name: string;
  frequency: number[];
  magnitude: number[];
}

// Generated native Settings.xml a86ca0; separate from measurement smoothing.
export const DEFAULT_HFD_MIC_SMOOTHING = 0.015;

export function validateHfdCalibrationCurve(curve: HfdCalibrationCurve): void {
  if (
    !curve ||
    typeof curve !== 'object' ||
    Array.isArray(curve) ||
    Object.keys(curve).some((k) => !['name', 'frequency', 'magnitude'].includes(k)) ||
    typeof curve.name !== 'string' ||
    !Array.isArray(curve.frequency) ||
    !Array.isArray(curve.magnitude) ||
    !curve.frequency.length ||
    curve.frequency.length > 2e6 ||
    curve.frequency.length !== curve.magnitude.length ||
    curve.frequency.some((f) => !Number.isFinite(f)) ||
    curve.magnitude.some((db) => !Number.isFinite(db))
  )
    throw new Error('Invalid native microphone correction curve');
}

/** a8c8f0 accepts two numeric fields; a third phase column is ignored. Native
 * header markers are double quote, apostrophe or asterisk. Decimal commas are
 * accepted inside numbers; comma-separated columns are not a supported format.
 * File order (including duplicate/unsorted frequencies) is retained. */
export function parseHfdCalibration(text: string, name: string): HfdCalibrationCurve {
  const frequency: number[] = [],
    magnitude: number[] = [];
  const numeric = (c: string) => '+,-.0123456789Ee'.includes(c);
  const lines = text.split(/\r?\n/);
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row].replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').slice(0, 255);
    if (!line || ['"', "'", '*'].includes(line[0])) continue;
    const pair: number[] = [];
    let i = 0;
    for (let field = 0; field < 2; field++) {
      while (i < line.length && !numeric(line[i])) i++;
      const start = i;
      while (i < line.length && numeric(line[i])) i++;
      // Delphi Copy uses end-start+1: the first nonnumeric delimiter is
      // included, then ASCII whitespace trimmed. A semicolon/letter delimiter
      // therefore fails StrToFloat, while a space/tab delimiter succeeds.
      const token = line
        .slice(start, Math.min(i + 1, line.length))
        .replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')
        .replaceAll(',', '.');
      const value =
        token && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)
          ? Number(token)
          : NaN;
      if (!Number.isFinite(value))
        throw new Error(
          `Invalid native microphone correction data on line ${row + 1}; expected frequency and dB`,
        );
      pair.push(value);
    }
    frequency.push(pair[0]);
    magnitude.push(pair[1]);
  }
  const curve = { name, frequency, magnitude };
  validateHfdCalibrationCurve(curve);
  return curve;
}

/** Stateful native a8c370 sampler, including its first-crossed-point behavior.
 * It is deliberately not linear interpolation or a conventional sample hold:
 * when a target skips several input points, only the first crossed gain loads. */
export function hfdCalibrationSample(
  curve: HfdCalibrationCurve,
  target: ArrayLike<number>,
  linear = true,
): Float64Array {
  validateHfdCalibrationCurve(curve);
  for (let i = 0; i < target.length; i++)
    if (!Number.isFinite(target[i])) throw new Error('Non-finite native correction frequency');
  const value = (i: number) => (linear ? 10 ** (curve.magnitude[i] / 20) : curve.magnitude[i]);
  const output = new Float64Array(target.length);
  let point = 0,
    index = 0,
    current = value(0);
  if (!Number.isFinite(current))
    throw new Error('Native correction magnitude exceeds finite range');
  if (target.length && curve.frequency[0] > target[0])
    while (index < target.length && target[index] <= curve.frequency[0]) output[index++] = current;
  for (; index < target.length; index++) {
    if (!Number.isFinite(target[index])) throw new Error('Non-finite native correction frequency');
    if (point < curve.frequency.length && target[index] >= curve.frequency[point]) {
      current = value(point);
      while (point < curve.frequency.length && target[index] >= curve.frequency[point]) point++;
    }
    if (!Number.isFinite(current))
      throw new Error('Native correction magnitude exceeds finite range');
    output[index] = current;
  }
  return output;
}

/** a8bf30 operates on an output prefix while its kernel and right boundary use
 * different lengths. The ordinary call uses input L+1, kernel P=L, prefix1024.
 * Preserve the untouched tail used by subsequent magnitude-derived phase. */
export function hfdSmoothCalibration(
  values: ArrayLike<number>,
  frequency: ArrayLike<number>,
  bandwidth: number,
  kernelPoints: number,
  outputPoints: number,
): Float64Array {
  if (
    values.length !== frequency.length ||
    !Number.isInteger(kernelPoints) ||
    kernelPoints < 2 ||
    kernelPoints > frequency.length ||
    !Number.isInteger(outputPoints) ||
    outputPoints < 0 ||
    outputPoints > values.length ||
    !Number.isFinite(bandwidth) ||
    bandwidth < 0
  )
    throw new Error('Unsupported native correction smoothing dimensions');
  const source = Float64Array.from(values);
  const bw = bandwidth === 0 ? 1e-5 : bandwidth,
    s = (kernelPoints * bw * Math.LN2) / Math.log(frequency[kernelPoints - 1] / frequency[0]),
    a = Math.sqrt(Math.LN2) / s,
    radius = Math.ceil(4 * s);
  if (!Number.isFinite(s) || s <= 0 || radius >= kernelPoints)
    throw new Error('Native correction smoothing exceeds the recovered kernel bounds');
  const kernel = Float64Array.from({ length: kernelPoints }, (_, i) => Math.exp(-((i * a) ** 2)));
  let normalizer = kernel[0];
  for (let i = 1; i < kernel.length; i++) normalizer += 2 * kernel[i];
  for (let i = 0; i < kernel.length; i++) kernel[i] /= normalizer;
  const output = source.slice();
  for (let j = 0; j < outputPoints; j++) {
    let value = source[j] * kernel[0];
    for (let i = 1; i <= radius; i++)
      value +=
        kernel[i] * (source[Math.max(0, j - i)] + source[Math.min(source.length - 1, j + i)]);
    if (!Number.isFinite(value)) throw new Error('Non-finite native correction smoothing result');
    output[j] = value;
  }
  return output;
}

export interface HfdCalibrationResponse {
  sampleRate: number;
  frequency: Float64Array;
  magnitude: Float64Array;
  phase: Float64Array;
}

export function buildHfdCalibration(
  curve: HfdCalibrationCurve,
  sampleRate: number,
  fftLength = 65536,
  smoothingOctaves = DEFAULT_HFD_MIC_SMOOTHING,
  graphPointCount = 1024,
): HfdCalibrationResponse {
  if (
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    fftLength < 2 ||
    fftLength > 65536 ||
    (fftLength & (fftLength - 1)) !== 0
  )
    throw new Error('Unsupported native correction sample rate or FFT length');
  const frequency = Float64Array.from({ length: fftLength + 1 }, (_, i) =>
    i === 0 ? 0.01 : (i * sampleRate) / fftLength,
  );
  const sampled = hfdCalibrationSample(curve, frequency);
  const magnitude = hfdSmoothCalibration(
    sampled,
    frequency,
    smoothingOctaves,
    fftLength,
    graphPointCount,
  );
  return { sampleRate, frequency, magnitude, phase: hfdCalibrationPhase(magnitude) };
}

/** Native correction-curve display smooths sampled dB on the graph grid. It
 * does not display the separately sampled/smoothed linear FFT resource. */
export function displayHfdCalibration(
  curve: HfdCalibrationCurve,
  frequency: number[],
  smoothingOctaves = DEFAULT_HFD_MIC_SMOOTHING,
): number[] {
  const sampled = hfdCalibrationSample(curve, frequency, false);
  return Array.from(
    hfdSmoothCalibration(sampled, frequency, smoothingOctaves, frequency.length, frequency.length),
  );
}

/** HFD 5.2.4.24 99fb24: negative Hilbert transform of log magnitude.
 * The supplied half of an even 2N-point sequence has N+1 values. Its endpoint
 * represents the resource's full measurement sample rate, not audio Nyquist.
 * Returned values are radians. See HFD-CALIBRATION-SEMANTICS.md. */
export function hfdCalibrationPhase(amplitude: ArrayLike<number>): Float64Array {
  const n = amplitude.length - 1;
  if (n < 1 || n > 65536 || (n & (n - 1)) !== 0)
    throw new Error('Native correction phase requires a power-of-two length plus one');
  const real = new Float64Array(2 * n),
    imaginary = new Float64Array(2 * n);
  for (let i = 0; i <= n; i++) {
    if (!Number.isFinite(amplitude[i])) throw new Error('Non-finite native correction magnitude');
    real[i] = Math.log(Math.max(Math.abs(amplitude[i]), 1e-10));
  }
  for (let i = n + 1; i < 2 * n; i++) real[i] = real[2 * n - i];
  fft(real, imaginary);
  real[0] = imaginary[0] = real[n] = imaginary[n] = 0;
  for (let i = 1; i < 2 * n; i++) {
    if (i === n) continue;
    const r = real[i],
      sign = i < n ? 1 : -1;
    real[i] = -sign * imaginary[i];
    imaginary[i] = sign * r;
  }
  fft(real, imaginary, true);
  return real.slice(0, n + 1);
}
