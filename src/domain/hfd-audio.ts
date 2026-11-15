import { fft } from './fft';
import { hfdCalibrationPhase } from './hfd-calibration';

export const HFD_SWEEP_SAMPLES = 65536;
export const HFD_RECORD_SAMPLES = 2 * HFD_SWEEP_SAMPLES;
const START_FREQUENCY = 6;
const ATTACK_SAMPLES = 8192;
const RELEASE_SAMPLES = 512;

export interface HfdAudioKernel {
  real: Float64Array;
  imaginary: Float64Array;
}
export interface HfdPreparedAudio {
  sampleRate: number;
  outputGainDb: number;
  gain: number;
  /** Native double-precision stimulus, including the trailing silent half. */
  stimulus: Float64Array;
  /** Gain-applied native AudioOut, before the audio backend's Float32 conversion. */
  output: Float64Array;
  kernel: HfdAudioKernel;
}

function validateSampleRate(sampleRate: number) {
  if (!Number.isFinite(sampleRate) || sampleRate / 2 <= START_FREQUENCY)
    throw new Error('Native sweep sample rate must be finite with Nyquist above 6 Hz');
}
function gainFactor(outputGainDb: number) {
  const gain = 10 ** (outputGainDb / 20);
  if (!Number.isFinite(outputGainDb) || !Number.isFinite(gain) || gain <= 0)
    throw new Error('Native sweep output gain must produce a finite positive factor');
  return gain;
}

/** Native 99f678 copies bins0..N-1 from a 2N-point FFT, omitting Nyquist.
 * Its omitted destination bin is zero from allocation; it does not halve DC. */
function nativeForward(samples: ArrayLike<number>): HfdAudioKernel {
  const real = Float64Array.from(samples),
    imaginary = new Float64Array(HFD_RECORD_SAMPLES);
  fft(real, imaginary);
  real[HFD_SWEEP_SAMPLES] = imaginary[HFD_SWEEP_SAMPLES] = 0;
  return {
    real: real.slice(0, HFD_SWEEP_SAMPLES + 1),
    imaginary: imaginary.slice(0, HFD_SWEEP_SAMPLES + 1),
  };
}

/** HFD 5.2.4.24 a84ef8..a852ff; static reconstruction, not a native recording
 * fixture. See docs/HFD-AUDIO-SEMANTICS.md for formulas/addresses/uncertainties.
 * Preparation is keyed explicitly by the actual backend sample rate. No driver,
 * playback, gain-range policy, clipping, latency or peak alignment occurs here. */
export function prepareHfdAudio(sampleRate: number, outputGainDb = 0): HfdPreparedAudio {
  validateSampleRate(sampleRate);
  const gain = gainFactor(outputGainDb),
    n = HFD_SWEEP_SAMPLES,
    duration = n / sampleRate,
    exponent = Math.log(sampleRate / 2 / START_FREQUENCY) / duration,
    phaseScale = (2 * Math.PI * START_FREQUENCY) / exponent,
    stimulus = new Float64Array(HFD_RECORD_SAMPLES),
    inverse = new Float64Array(HFD_RECORD_SAMPLES),
    output = new Float64Array(HFD_RECORD_SAMPLES);
  for (let i = 0; i < n; i++) {
    const window =
      i < ATTACK_SAMPLES
        ? (1 - Math.cos((Math.PI * i) / ATTACK_SAMPLES)) / 2
        : i > n - RELEASE_SAMPLES
          ? (1 + Math.cos((Math.PI * (i - n + RELEASE_SAMPLES)) / RELEASE_SAMPLES)) / 2
          : 1;
    const risingFrequency = Math.exp((exponent * i) / sampleRate);
    stimulus[i] = window * Math.cos(phaseScale * risingFrequency);
    inverse[n - i] = stimulus[i] * START_FREQUENCY * risingFrequency;
    output[i] = stimulus[i] * gain;
    if (
      !Number.isFinite(stimulus[i]) ||
      !Number.isFinite(inverse[n - i]) ||
      !Number.isFinite(output[i])
    )
      throw new Error('Native sweep preparation exceeds finite sample range');
  }
  const sweep = nativeForward(stimulus),
    kernel = nativeForward(inverse),
    magnitude = new Float64Array(n + 1),
    argument = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const real = sweep.real[i] * kernel.real[i] - sweep.imaginary[i] * kernel.imaginary[i],
      imaginary = sweep.real[i] * kernel.imaginary[i] + sweep.imaginary[i] * kernel.real[i];
    magnitude[i] = Math.hypot(real, imaginary);
    argument[i] = real === 0 && imaginary === 0 ? 0 : Math.atan2(imaginary, real);
  }
  // Same native 99fb24 helper as microphone correction: negative Hilbert of
  // even log amplitude, floor1e-10. Preserve magnitude; do not divide by H.
  const minimumPhase = hfdCalibrationPhase(magnitude);
  for (let i = 0; i <= n; i++) {
    const phase = minimumPhase[i] - argument[i],
      cos = Math.cos(phase),
      sin = Math.sin(phase),
      real = kernel.real[i],
      imaginary = kernel.imaginary[i];
    kernel.real[i] = real * cos - imaginary * sin;
    kernel.imaginary[i] = real * sin + imaginary * cos;
  }
  return { sampleRate, outputGainDb, gain, stimulus, output, kernel };
}

/** Native a85528/a853e4: cancel requested playback gain, multiply the prepared
 * inverse spectrum, conjugate-mirror, inverse-transform and retain first N.
 * Recording is exactly131072 retained samples. Backend-origin adjustments
 * (including native ASIO's initial-block discard) belong outside this function. */
export function deconvolveHfdAudio(
  prepared: HfdPreparedAudio,
  recording: ArrayLike<number>,
): Float64Array {
  validateSampleRate(prepared.sampleRate);
  const gain = gainFactor(prepared.outputGainDb),
    n = HFD_SWEEP_SAMPLES;
  if (prepared.gain !== gain) throw new Error('Native audio preparation gain is inconsistent');
  if (!recording || recording.length !== HFD_RECORD_SAMPLES)
    throw new Error(`Native recording requires exactly ${HFD_RECORD_SAMPLES} retained samples`);
  if (
    !prepared.kernel ||
    prepared.kernel.real.length !== n + 1 ||
    prepared.kernel.imaginary.length !== n + 1
  )
    throw new Error('Invalid native audio deconvolution kernel length');
  const samples = new Float64Array(HFD_RECORD_SAMPLES);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = recording[i] / gain;
    if (!Number.isFinite(recording[i]) || !Number.isFinite(samples[i]))
      throw new Error('Native recording contains a non-finite or unrepresentable sample');
  }
  const recorded = nativeForward(samples),
    real = new Float64Array(HFD_RECORD_SAMPLES),
    imaginary = new Float64Array(HFD_RECORD_SAMPLES);
  for (let i = 0; i <= n; i++) {
    const kr = prepared.kernel.real[i],
      ki = prepared.kernel.imaginary[i];
    if (!Number.isFinite(kr) || !Number.isFinite(ki))
      throw new Error('Native audio kernel contains a non-finite value');
    real[i] = recorded.real[i] * kr - recorded.imaginary[i] * ki;
    imaginary[i] = recorded.real[i] * ki + recorded.imaginary[i] * kr;
    if (!Number.isFinite(real[i]) || !Number.isFinite(imaginary[i]))
      throw new Error('Native deconvolution exceeds finite sample range');
    if (i > 0 && i < n) {
      real[HFD_RECORD_SAMPLES - i] = real[i];
      imaginary[HFD_RECORD_SAMPLES - i] = -imaginary[i];
    }
  }
  fft(real, imaginary, true);
  for (let i = 0; i < n; i++)
    if (!Number.isFinite(real[i]))
      throw new Error('Native deconvolution exceeds finite sample range');
  return real.slice(0, n);
}
