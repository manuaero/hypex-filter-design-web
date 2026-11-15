import {
  type Measurement,
  type MeasurementSpectrum,
  type MeasurementCalibration,
  type MeasurementProcessing,
  type MeasurementProcessingPatch,
  type ImpulseWindow,
} from './model';
import { fft } from './fft';
export type {
  MeasurementSpectrum,
  MeasurementCalibration,
  MeasurementProcessing,
  MeasurementProcessingPatch,
  ImpulseWindow,
} from './model';

// A two-million-sample impulse can require a 2^21-point FFT.
export const MAX_MEASUREMENT_SPECTRUM_POINTS = 2 ** 20;

function objectFields(value: unknown, allowed: string[], label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(`Unexpected field in ${label}`);
}
function validRate(rate: number) {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Invalid measurement sample rate');
}
function validSpectrum(value: MeasurementSpectrum, label: string) {
  const { frequency, magnitude, phase } = value;
  if (
    !Array.isArray(frequency) ||
    !Array.isArray(magnitude) ||
    !frequency.length ||
    frequency.length > MAX_MEASUREMENT_SPECTRUM_POINTS ||
    magnitude.length !== frequency.length ||
    (phase !== undefined && (!Array.isArray(phase) || phase.length !== frequency.length))
  )
    throw new Error(`Invalid ${label} array lengths`);
  if (
    frequency.some((f, i) => !Number.isFinite(f) || f <= 0 || (i > 0 && f <= frequency[i - 1])) ||
    magnitude.some((n) => !Number.isFinite(n)) ||
    phase?.some((n) => !Number.isFinite(n))
  )
    throw new Error(`Invalid ${label}: frequencies must be positive/increasing and values finite`);
}
function validCalibration(calibration: MeasurementCalibration) {
  objectFields(
    calibration,
    ['name', 'sampleRate', 'frequency', 'magnitude', 'phase'],
    'calibration',
  );
  if (typeof calibration.name !== 'string') throw new Error('Invalid calibration name');
  validRate(calibration.sampleRate);
  validSpectrum(calibration, 'calibration');
}
function validWindow(window: ImpulseWindow, length: number | undefined) {
  objectFields(window, ['start', 'end', 'taper', 'timeZero'], 'impulse window');
  if (length === undefined) throw new Error('An impulse window requires original impulse samples');
  if (
    !Number.isInteger(window.start) ||
    !Number.isInteger(window.end) ||
    window.start < 0 ||
    window.end > length ||
    window.end <= window.start ||
    !Number.isFinite(window.taper) ||
    window.taper < 0 ||
    window.taper > 1 ||
    !Number.isFinite(window.timeZero) ||
    window.timeZero < 0 ||
    window.timeZero > length
  )
    throw new Error('Invalid impulse window range');
}

/** Validate stored data without recalculating legacy processed responses. */
export function validateMeasurement(measurement: Measurement): void {
  if (!measurement || typeof measurement !== 'object' || typeof measurement.name !== 'string')
    throw new Error('Invalid measurement');
  validRate(measurement.sampleRate);
  if (
    measurement.impulse !== undefined &&
    (!Array.isArray(measurement.impulse) ||
      !measurement.impulse.length ||
      measurement.impulse.length > 2e6 ||
      measurement.impulse.some((n) => !Number.isFinite(n)))
  )
    throw new Error('Invalid original impulse samples');
  const hasSpectrum =
    measurement.frequency !== undefined ||
    measurement.magnitude !== undefined ||
    measurement.phase !== undefined;
  if (hasSpectrum) validSpectrum(measurement as MeasurementSpectrum, 'measurement');
  if (measurement.sourceSpectrum !== undefined) {
    objectFields(
      measurement.sourceSpectrum,
      ['frequency', 'magnitude', 'phase'],
      'source spectrum',
    );
    validSpectrum(measurement.sourceSpectrum, 'source spectrum');
  }
  const processing = measurement.processing;
  if (processing !== undefined) {
    if (!measurement.impulse && !hasSpectrum && !measurement.sourceSpectrum)
      throw new Error('Load data for this measurement before processing');
    objectFields(
      processing,
      ['window', 'smoothingOctaves', 'calibration', 'calibrationEnabled'],
      'measurement processing',
    );
    if (
      !Number.isFinite(processing.smoothingOctaves) ||
      processing.smoothingOctaves < 0 ||
      processing.smoothingOctaves > 3
    )
      throw new Error('Invalid octave smoothing');
    if (typeof processing.calibrationEnabled !== 'boolean')
      throw new Error('Invalid calibration enabled state');
    if (processing.window !== undefined)
      validWindow(processing.window, measurement.impulse?.length);
    if (processing.calibration !== undefined) validCalibration(processing.calibration);
    if (processing.calibrationEnabled && !processing.calibration)
      throw new Error('Enabling calibration requires a loaded correction curve');
  }
}
function copySpectrum(source: MeasurementSpectrum): MeasurementSpectrum {
  return {
    frequency: source.frequency.slice(),
    magnitude: source.magnitude.slice(),
    ...(source.phase === undefined ? {} : { phase: source.phase.slice() }),
  };
}
function copyCalibration(source: MeasurementCalibration): MeasurementCalibration {
  return { name: source.name, sampleRate: source.sampleRate, ...copySpectrum(source) };
}

/** Recalculate from original data, never from a previous correction/smoothing result.
 * Loading a curve preserves its enabled state; pass calibrationEnabled:true to apply it.
 * Null window/calibration patches clear that control. An empty patch does not migrate legacy data. */
export function processMeasurement(
  measurement: Measurement,
  patch: MeasurementProcessingPatch,
): Measurement {
  validateMeasurement(measurement);
  objectFields(
    patch,
    ['window', 'smoothingOctaves', 'calibration', 'calibrationEnabled'],
    'processing patch',
  );
  if (
    patch.smoothingOctaves !== undefined &&
    (!Number.isFinite(patch.smoothingOctaves) ||
      patch.smoothingOctaves < 0 ||
      patch.smoothingOctaves > 3)
  )
    throw new Error('Invalid octave smoothing');
  if (patch.calibrationEnabled !== undefined && typeof patch.calibrationEnabled !== 'boolean')
    throw new Error('Invalid calibration enabled state');
  if (!Object.values(patch).some((value) => value !== undefined))
    return structuredClone(measurement);
  if (!measurement.impulse && !measurement.sourceSpectrum && !measurement.frequency)
    throw new Error('Load data for this measurement before processing');
  const previous = measurement.processing;
  const processing: MeasurementProcessing = {
    smoothingOctaves: patch.smoothingOctaves ?? previous?.smoothingOctaves ?? 0,
    calibrationEnabled: patch.calibrationEnabled ?? previous?.calibrationEnabled ?? false,
    ...(previous?.window ? { window: { ...previous.window } } : {}),
    ...(previous?.calibration ? { calibration: copyCalibration(previous.calibration) } : {}),
  };
  if (patch.window !== undefined) {
    if (patch.window === null) delete processing.window;
    else processing.window = { ...patch.window };
  }
  if (patch.calibration !== undefined) {
    if (patch.calibration === null) {
      delete processing.calibration;
      processing.calibrationEnabled = false;
    } else {
      validCalibration(patch.calibration);
      processing.calibration = copyCalibration(patch.calibration);
    }
  }
  const sourceSpectrum = measurement.sourceSpectrum
    ? copySpectrum(measurement.sourceSpectrum)
    : measurement.impulse
      ? undefined
      : copySpectrum(measurement as MeasurementSpectrum);
  const candidate: Measurement = {
    ...measurement,
    processing,
    ...(measurement.impulse ? { impulse: measurement.impulse.slice() } : {}),
    ...(sourceSpectrum ? { sourceSpectrum } : {}),
  };
  validateMeasurement(candidate);
  let calculated: Measurement = measurement.impulse
    ? {
        ...spectrum(measurement.impulse, measurement.sampleRate, processing.window),
        name: measurement.name,
      }
    : {
        name: measurement.name,
        sampleRate: measurement.sampleRate,
        ...copySpectrum(sourceSpectrum!),
      };
  if (processing.calibrationEnabled)
    calculated = applyCalibration(calculated, processing.calibration!);
  calculated = smoothMeasurement(calculated, processing.smoothingOctaves);
  return {
    ...candidate,
    frequency: calculated.frequency,
    magnitude: calculated.magnitude,
    phase: calculated.phase,
  };
}

export function resetMeasurementProcessing(measurement: Measurement): Measurement {
  return processMeasurement(measurement, {
    window: null,
    smoothingOctaves: 0,
    calibration: null,
    calibrationEnabled: false,
  });
}
export function spectrum(
  impulse: ArrayLike<number>,
  sampleRate: number,
  window?: ImpulseWindow,
): Measurement {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !impulse.length || impulse.length > 2e6)
    throw new Error('Invalid impulse or sample rate');
  const start = window?.start ?? 0,
    end = window?.end ?? impulse.length,
    taper = window?.taper ?? 0,
    timeZero = window?.timeZero ?? 0;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > impulse.length ||
    end <= start ||
    taper < 0 ||
    taper > 1 ||
    !Number.isFinite(timeZero)
  )
    throw new Error('Invalid impulse window');
  const size = 2 ** Math.ceil(Math.log2(Math.max(1024, end))),
    re = new Float64Array(size),
    im = new Float64Array(size),
    length = end - start;
  for (let i = start; i < end; i++) {
    const x = impulse[i];
    if (!Number.isFinite(x)) throw new Error('Impulse contains non-finite data');
    const edge = (taper * length) / 2,
      dist = Math.min(i - start, end - 1 - i),
      weight = edge > 0 && dist < edge ? 0.5 * (1 - Math.cos((Math.PI * dist) / edge)) : 1;
    re[i] = x * weight;
  }
  fft(re, im);
  const frequency: number[] = [],
    magnitude: number[] = [],
    phase: number[] = [];
  for (let i = 1; i <= size / 2; i++) {
    const f = (i * sampleRate) / size;
    frequency.push(f);
    magnitude.push(20 * Math.log10(Math.max(1e-15, Math.hypot(re[i], im[i]))));
    phase.push((Math.atan2(im[i], re[i]) * 180) / Math.PI + (360 * f * timeZero) / sampleRate);
  }
  return {
    name: 'Impulse response',
    sampleRate,
    impulse: Array.from(impulse),
    frequency,
    magnitude,
    phase,
  };
}
function interpolateMeasurement(
  m: Measurement,
  frequency: number,
  phase = m.phase,
  shortestPhase = true,
): [number, number] {
  if (!m.frequency?.length || !m.magnitude?.length) return [0, 0];
  const linear = m.hfdMagnitude?.linearMagnitude;
  const fs = m.hfdMagnitude?.frequency ?? m.frequency;
  let lo = 0,
    hi = fs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fs[mid] <= frequency) lo = mid;
    else hi = mid;
  }
  if (frequency <= fs[0]) hi = lo = 0;
  if (frequency >= fs.at(-1)!) hi = lo = fs.length - 1;
  const t = lo === hi ? 0 : Math.log(frequency / fs[lo]) / Math.log(fs[hi] / fs[lo]),
    db = linear
      ? 20 * Math.log10(Math.max(0, linear[lo] + t * (linear[hi] - linear[lo])))
      : m.magnitude[lo] + t * (m.magnitude[hi] - m.magnitude[lo]);
  let delta = (phase?.[hi] ?? 0) - (phase?.[lo] ?? 0);
  if (shortestPhase) delta = ((((delta + 180) % 360) + 360) % 360) - 180;
  return [db, (phase?.[lo] ?? 0) + t * delta];
}
export function measurementResponse(m: Measurement, frequency: number): [number, number] {
  const [db, degrees] = interpolateMeasurement(m, frequency);
  const phase = (degrees * Math.PI) / 180,
    gain = 10 ** (db / 20);
  return [gain * Math.cos(phase), gain * Math.sin(phase)];
}
export function smoothMeasurement(m: Measurement, octaves: number): Measurement {
  if (!m.frequency || !m.magnitude || octaves === 0) return m;
  if (!Number.isFinite(octaves) || octaves < 0 || octaves > 3)
    throw new Error('Invalid octave smoothing');
  const fs = m.frequency,
    db = m.magnitude,
    prefix = [0];
  for (const x of db) prefix.push(prefix.at(-1)! + 10 ** (x / 10));
  let lo = 0,
    hi = 0;
  const magnitude = fs.map((f) => {
    while (lo < fs.length - 1 && fs[lo] < f / 2 ** (octaves / 2)) lo++;
    while (hi < fs.length && fs[hi] <= f * 2 ** (octaves / 2)) hi++;
    return 10 * Math.log10(Math.max(1e-30, (prefix[hi] - prefix[lo]) / Math.max(1, hi - lo)));
  });
  return { ...m, magnitude };
}
export function applyCalibration(m: Measurement, calibration: Measurement): Measurement {
  if (!m.frequency || !m.magnitude) return m;
  // Unwrap the calibration on its own grid, rather than the measurement grid:
  // sparse measurement points must not introduce an artificial full-turn jump.
  // Retaining its first phase also preserves an existing unwrapped phase origin.
  const calibrationPhase = calibration.phase?.slice();
  if (calibrationPhase)
    for (let i = 1; i < calibrationPhase.length; i++) {
      const delta = calibration.phase![i] - calibration.phase![i - 1];
      calibrationPhase[i] = calibrationPhase[i - 1] + (((((delta + 180) % 360) + 360) % 360) - 180);
    }
  const magnitude: number[] = [];
  const phase = m.phase === undefined ? undefined : ([] as number[]);
  for (let i = 0; i < m.frequency.length; i++) {
    const [correctionDb, correctionPhase] = interpolateMeasurement(
      calibration,
      m.frequency[i],
      calibrationPhase,
      false,
    );
    magnitude.push(m.magnitude[i] - Math.max(-300, correctionDb));
    if (phase) phase.push(m.phase![i] - correctionPhase);
  }
  return {
    ...m,
    magnitude,
    ...(phase === undefined ? {} : { phase }),
  };
}
export function parseImpulse(text: string, name: string, sampleRate = 48000): Measurement {
  const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^[#;*]/.test(l)),
    values = lines.map(Number);
  if (values.length < 2 || !values.every(Number.isFinite))
    throw new Error('Expected an impulse response with one finite sample per line');
  return { ...spectrum(values, sampleRate), name };
}
export function decodeWav(buffer: ArrayBuffer, name: string): Measurement {
  const v = new DataView(buffer),
    tag = (o: number, n: number) => String.fromCharCode(...new Uint8Array(buffer, o, n));
  if (buffer.byteLength < 44 || tag(0, 4) !== 'RIFF' || tag(8, 4) !== 'WAVE')
    throw new Error('Expected a RIFF WAVE file');
  let format = 0,
    channels = 0,
    rate = 0,
    bits = 0,
    block = 0,
    data = 0,
    length = 0;
  for (let o = 12; o + 8 <= v.byteLength;) {
    const size = v.getUint32(o + 4, true),
      id = tag(o, 4);
    if (o + 8 + size > v.byteLength) throw new Error('Truncated WAVE chunk');
    if (id === 'fmt ') {
      if (size < 16) throw new Error('Invalid WAVE format');
      format = v.getUint16(o + 8, true);
      channels = v.getUint16(o + 10, true);
      rate = v.getUint32(o + 12, true);
      block = v.getUint16(o + 20, true);
      bits = v.getUint16(o + 22, true);
    }
    if (id === 'data') {
      data = o + 8;
      length = size;
    }
    o += 8 + size + (size % 2);
  }
  if (
    !data ||
    ![1, 3].includes(format) ||
    !channels ||
    !rate ||
    block !== (channels * bits) / 8 ||
    !(format === 3 ? [32, 64] : [16, 24, 32]).includes(bits)
  )
    throw new Error('Supported WAVE formats: PCM16/24/32 or float32/64');
  const count = Math.floor(length / block);
  if (count > 2e6) throw new Error('WAVE exceeds two million frames');
  const samples = Array.from({ length: count }, (_, i) => {
    const o = data + i * block;
    if (format === 3) return bits === 32 ? v.getFloat32(o, true) : v.getFloat64(o, true);
    if (bits === 16) return v.getInt16(o, true) / 32768;
    if (bits === 32) return v.getInt32(o, true) / 2 ** 31;
    let n = v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getUint8(o + 2) << 16);
    if (n & 0x800000) n -= 0x1000000;
    return n / 2 ** 23;
  });
  return { ...spectrum(samples, rate), name };
}
