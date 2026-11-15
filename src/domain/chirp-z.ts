import { fft } from './fft';

const MAX_TAPS = 4500;
const MAX_COUNT = 2 ** 20;
const MAX_FFT_SIZE = 2 ** 22;
const SPLITTER = 134217729;

/**
 * FIR response on the linear angular-frequency grid k * stepRadians.
 * Bluestein's convolution evaluates the original taps without resampling:
 * a[n] = taps[n] exp(-j theta n²/2), b[m] = exp(+j theta m²/2).
 * See https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.CZT.html.
 */
export function firFrequencyGrid(
  taps: ArrayLike<number>,
  count: number,
  stepRadians: number,
): { real: Float64Array; imaginary: Float64Array } {
  if (!Number.isInteger(taps.length) || taps.length < 0 || taps.length > MAX_TAPS)
    throw new RangeError(`FIR tap count must be between 0 and ${MAX_TAPS}`);
  if (!Number.isInteger(count) || count < 0 || count > MAX_COUNT)
    throw new RangeError(`Frequency count must be between 0 and ${MAX_COUNT}`);
  if (!Number.isFinite(stepRadians) || stepRadians < 0)
    throw new RangeError('Frequency step must be finite and nonnegative');
  for (let i = 0; i < taps.length; i++)
    if (!Number.isFinite(taps[i])) throw new RangeError('FIR taps must be finite');

  const real = new Float64Array(count);
  const imaginary = new Float64Array(count);
  if (!count || !taps.length) return { real, imaginary };
  if (stepRadians === 0) {
    let dc = 0;
    for (let i = 0; i < taps.length; i++) dc += taps[i];
    real.fill(dc);
    return { real, imaginary };
  }

  const size = 2 ** Math.ceil(Math.log2(taps.length + count - 1));
  if (size > MAX_FFT_SIZE) throw new RangeError('Chirp convolution is too large');
  const ar = new Float64Array(size);
  const ai = new Float64Array(size);
  const br = new Float64Array(size);
  const bi = new Float64Array(size);
  // Principal reduction also keeps finite, very large user-supplied angles safe.
  const theta =
    stepRadians <= 2 * Math.PI
      ? stepRadians
      : Math.atan2(Math.sin(stepRadians), Math.cos(stepRadians));
  const half = theta / 2;
  const splitHalf = SPLITTER * half;
  const halfHigh = splitHalf - (splitHalf - half);
  const halfLow = half - halfHigh;

  for (let n = 0; n < Math.max(taps.length, count); n++) {
    // Keep the multiplication's low part: rounding theta*n² before taking its
    // sine otherwise introduces avoidable phase errors at large grid indices.
    const square = n * n;
    const phase = half * square;
    const splitSquare = SPLITTER * square;
    const squareHigh = splitSquare - (splitSquare - square);
    const squareLow = square - squareHigh;
    const error =
      halfHigh * squareHigh -
      phase +
      halfHigh * squareLow +
      halfLow * squareHigh +
      halfLow * squareLow;
    const cp = Math.cos(phase);
    const sp = Math.sin(phase);
    const ce = Math.cos(error);
    const se = Math.sin(error);
    const cr = cp * ce - sp * se;
    const ci = sp * ce + cp * se;
    if (n < count) {
      // Retain the chirp in the output arrays until the convolution is ready.
      real[n] = cr;
      imaginary[n] = ci;
      br[n] = cr;
      bi[n] = ci;
    }
    if (n < taps.length) {
      ar[n] = taps[n] * cr;
      ai[n] = -taps[n] * ci;
      if (n) {
        br[size - n] = cr;
        bi[size - n] = ci;
      }
    }
  }

  fft(ar, ai);
  fft(br, bi);
  for (let i = 0; i < size; i++) {
    const productReal = ar[i] * br[i] - ai[i] * bi[i];
    ai[i] = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = productReal;
  }
  fft(ar, ai, true);
  for (let k = 0; k < count; k++) {
    const cr = real[k];
    const ci = imaginary[k];
    real[k] = ar[k] * cr + ai[k] * ci;
    imaginary[k] = ai[k] * cr - ar[k] * ci;
  }
  return { real, imaginary };
}
