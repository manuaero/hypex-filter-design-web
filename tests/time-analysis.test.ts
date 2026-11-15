import { describe, expect, it } from 'vitest';
import { channelResponse, presetResponse } from '../src/domain/dsp';
import { FS, newFilter, newProject, type Channel, type Measurement } from '../src/domain/model';
import { analyzeTimeResponses } from '../src/domain/time-analysis';
import { fitTimeSeries } from '../src/domain/time-series';
import {
  useHfdNative,
  updateHfdMeasurement,
  enablePresetHfdMeasurement,
  setSharedHfdCrop,
  defaultsHfdMeasurementOptions,
} from '../src/domain/hfd-measurement';

function channel(samples = [1, 0], rate = FS): Channel {
  const c = newProject().presets[0].channels[0];
  c.measurement = {
    name: 'Original impulse',
    sampleRate: rate,
    impulse: samples,
    processing: {
      window: { start: 0, end: samples.length, taper: 0, timeZero: 0 },
      smoothingOctaves: 0,
      calibrationEnabled: false,
    },
  };
  return c;
}
const samples = (x: ArrayLike<number> | undefined) => Array.from(x ?? []);
function nativeFitChannel(start: number, stopInclusive: number): Channel {
  const c = channel(
    Array.from({ length: 128 }, (_, i) => (i === 20 ? 1 : 0)),
    48000,
  );
  c.hfdMeasurement = {
    ...defaultsHfdMeasurementOptions(48000),
    localStart: start,
    stopInclusive,
  };
  return c;
}
function near(actual: ArrayLike<number>, expected: ArrayLike<number>, precision = 10) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) expect(actual[i]).toBeCloseTo(expected[i], precision);
}

/** Independent O(N*M + N²) definition, not the implementation FFT/chirp-z path.
 * Literal native convention: double only positive-half bins, then take real IDFT. */
function nativeDft(
  input: number[],
  n: number,
  rate: number,
  transfer: (f: number) => [number, number] = () => [1, 0],
) {
  const bins: [number, number][] = [];
  for (let k = 0; k < n / 2; k++) {
    let re = 0,
      im = 0;
    input.forEach((v, j) => {
      re += v * Math.cos((-2 * Math.PI * k * j) / n);
      im += v * Math.sin((-2 * Math.PI * k * j) / n);
    });
    const [a, b] = transfer((k * rate) / n);
    bins.push([re * a - im * b, re * b + im * a]);
  }
  return Array.from({ length: n }, (_, j) =>
    bins.reduce((total, [r, i], k) => {
      const phase = (2 * Math.PI * k * j) / n;
      return total + (2 / n) * (r * Math.cos(phase) - i * Math.sin(phase));
    }, 0),
  );
}

describe('recovered native timed synthesis', () => {
  it('preserves the statically recovered DC/Nyquist convention rather than silently using a Hermitian inverse', () => {
    const curve = analyzeTimeResponses([channel()], { measured: true }).channels[0];
    near(curve.impulse!.samples, [1, 0.5, 0, 0.5]);
    near(curve.step!.samples, [1, 1.5, 1.5, 2]);
    expect(curve.impulse!.startTimeMs).toBe(0);
    expect(curve.warnings.join(' ')).toMatch(/including DC.*omits Nyquist/);
    expect(curve.warnings.join(' ')).toContain('awaits a native GUI fixture');
  });

  it('uses the native default65536 even for short source data, and crops only after full synthesis', () => {
    const c = channel();
    delete c.measurement!.processing;
    const full = analyzeTimeResponses([c], { measured: true }).channels[0],
      cropped = analyzeTimeResponses([c], { measured: true, length: 8 }).channels[0];
    expect(full.impulse!.samples.length).toBe(65536);
    near(cropped.impulse!.samples, samples(full.impulse!.samples).slice(0, 8));
    expect(cropped.impulse!.samples[1]).toBeCloseTo(2 / 65536, 12);
    expect(cropped.warnings.join(' ')).toContain('cropped after full native synthesis');
  });

  it('takes one common power-of-four length from the selected reference channel and retains the native boundary fold', () => {
    const short = channel(),
      boundary = channel(Array.from({ length: 65 }, (_, i) => (i === 64 ? 1 : 0))),
      before = structuredClone([short, boundary]);
    const analysis = analyzeTimeResponses([short, boundary], {
      measured: true,
      referenceChannel: 1,
    });
    expect(analysis.channels.map((c) => c.impulse!.samples.length)).toEqual([64, 64]);
    near(analysis.channels[1].impulse!.samples, nativeDft(boundary.measurement!.impulse!, 64, FS));
    expect(analysis.channels[1].warnings.join(' ')).toContain('folds periodically');
    expect([short, boundary]).toEqual(before);
    const longer = channel([...boundary.measurement!.impulse!, 0]);
    expect(
      analyzeTimeResponses([longer], { measured: true }).channels[0].impulse!.samples.length,
    ).toBe(256);
  });

  it('rectangular-crops end-exclusive model samples, packs at zero, and leaves phase-start/calibration/smoothing/taper out of timed bins', () => {
    const c = channel([0.2, 0.3, 1, 0.5, -0.25, 0.1, 0, 0], 48000),
      window = c.measurement!.processing!.window!;
    Object.assign(window, { start: 2, end: 5, timeZero: 4, taper: 1 });
    Object.assign(c.measurement!.processing!, {
      smoothingOctaves: 1 / 3,
      calibrationEnabled: true,
      calibration: {
        name: 'Magnitude correction',
        sampleRate: 48000,
        frequency: [10, 24000],
        magnitude: [6, 6],
        phase: [70, 70],
      },
    });
    Object.assign(c.measurement!, {
      frequency: [10, 24000],
      magnitude: [-120, -120],
      phase: [0, 0],
    });
    const before = structuredClone(c),
      analysis = analyzeTimeResponses([c], { measured: true }),
      curve = analysis.channels[0];
    near(curve.impulse!.samples, nativeDft([1, 0.5, -0.25], 4, 48000));
    expect(curve.impulse!.sampleRate).toBe(48000);
    expect(curve.impulse!.startTimeMs).toBe(0);
    expect(analysis.windowBounds).toEqual({ minMs: (2 / 48000) * 1000, maxMs: (4 / 48000) * 1000 });
    const warnings = curve.warnings.join(' ');
    expect(warnings).toContain('Microphone calibration');
    expect(warnings).toContain('Frequency smoothing');
    expect(warnings).toContain('Phase-start/time-zero');
    expect(warnings).toContain('rectangular crop');
    expect(warnings).toContain('original source-time');
    expect(c).toEqual(before);
  });

  it('keeps original inter-driver arrival offsets and applies signed electrical delays independently of phase-start', () => {
    const c = channel(Array.from({ length: 10 }, (_, i) => (i === 3 ? 1 : 0)));
    c.delayUs = (3 / FS) * 1e6;
    c.globalDelayUs = (-1 / FS) * 1e6;
    c.measurement!.processing!.window!.timeZero = 3;
    const curve = analyzeTimeResponses([c], { measured: true }).channels[0];
    near(
      curve.impulse!.samples,
      nativeDft(c.measurement!.impulse!, 16, FS, (f) => channelResponse(c, f)),
    );
    expect(
      samples(curve.impulse!.samples).indexOf(Math.max(...samples(curve.impulse!.samples))),
    ).toBe(5);
    c.globalDelayUs = (-4 / FS) * 1e6;
    const advanced = analyzeTimeResponses([c], { measured: true }).channels[0];
    expect(
      samples(advanced.impulse!.samples).indexOf(Math.max(...samples(advanced.impulse!.samples))),
    ).toBe(2);
  });

  it.each(['input', 'output'] as const)(
    'evaluates physical-frequency BQs, gain, input EQ and %s FIR at the measurement rate without tap resampling',
    (placement) => {
      const preset = newProject().presets[0],
        c = channel([0.5, 1, -0.25, 0.1, 0, 0, 0, 0, 0, 0], 48000);
      preset.channels[0] = c;
      c.gain = -3;
      c.additionalGain = 1.25;
      c.invert = true;
      c.filters[0] = { ...newFilter('lowpass2'), frequency: 1500 };
      c.fir = { name: 'output', enabled: true, taps: [0.25, 0.5, -0.1] };
      preset.inputFir = { name: 'input', enabled: true, taps: [0, 0.3, 0.6, -0.2] };
      preset.firPlacement = placement;
      preset.eqEnabled = true;
      preset.inputEq[0] = { ...newFilter('peak'), frequency: 700, gain: 4, q: 1.2 };
      const curve = analyzeTimeResponses([c], { measured: true, preset }).channels[0];
      near(
        curve.impulse!.samples,
        nativeDft(c.measurement!.impulse!, 16, 48000, (f) => presetResponse(preset, 0, f)),
        9,
      );
      const values = samples(curve.impulse!.samples);
      let total = 0;
      near(
        curve.step!.samples,
        values.map((n) => (total += n)),
      );
    },
  );

  it('complex-sums before inverse transform, cancels opposite polarity, honors inclusion and preview mute', () => {
    const a = channel([0, 0.2, 1, -0.3, 0, 0, 0, 0, 0, 0]),
      b = structuredClone(a);
    b.invert = true;
    const cancelled = analyzeTimeResponses([a, b], { measured: true, sum: true });
    expect(samples(cancelled.sum!.impulse!.samples).every((x) => Math.abs(x) < 1e-12)).toBe(true);
    expect(samples(cancelled.sum!.step!.samples).every((x) => Math.abs(x) < 1e-12)).toBe(true);
    b.includeInSum = false;
    const included = analyzeTimeResponses([a, b], { measured: true, sum: true });
    near(included.sum!.impulse!.samples, included.channels[0].impulse!.samples);
    a.muted = true;
    const muted = analyzeTimeResponses([a, b], { measured: true, sum: true });
    expect(samples(muted.channels[0].impulse!.samples).every((x) => x === 0)).toBe(true);
    expect(samples(muted.sum!.impulse!.samples).every((x) => x === 0)).toBe(true);
  });

  it('returns explicit unavailable curves for absent/FRD-only data and omits them honestly from a native measured sum', () => {
    const loaded = channel(),
      absent = newProject().presets[0].channels[1],
      frd = structuredClone(absent);
    frd.measurement = {
      name: 'FRD with phase',
      sampleRate: 48000,
      frequency: [10, 1000],
      magnitude: [0, 0],
      phase: [0, -70],
    };
    const analysis = analyzeTimeResponses([loaded, absent, frd], { measured: true, sum: true });
    expect(analysis.channels.map((c) => c.source)).toEqual([
      'measured-impulse',
      'unavailable',
      'unavailable',
    ]);
    expect(analysis.channels[1].reason).toContain('No original');
    expect(analysis.channels[2].reason).toContain('frequency-only');
    near(analysis.sum!.impulse!.samples, analysis.channels[0].impulse!.samples);
    expect(analysis.sum!.warnings.join(' ')).toContain('Channels 2, 3');
    expect(
      analyzeTimeResponses([absent, frd], { measured: true, sum: true }).sum!.impulse,
    ).toBeNull();
  });

  it('preserves each measurement rate but refuses a mixed-rate sum instead of guessing a resampler', () => {
    const a = channel([1, 0], 48000),
      b = channel([1, 0], 96000);
    const analysis = analyzeTimeResponses([a, b], { measured: true, sum: true });
    expect(analysis.channels.map((c) => c.impulse!.sampleRate)).toEqual([48000, 96000]);
    expect(analysis.sum!.source).toBe('unavailable');
    expect(analysis.sum!.reason).toContain('matching sample rates');
    b.includeInSum = false;
    expect(
      analyzeTimeResponses([a, b], { measured: true, sum: true }).sum!.impulse!.sampleRate,
    ).toBe(48000);
  });

  it('preserves relative arrivals with common crop starts and explicitly warns when independent packing changes alignment', () => {
    const a = channel(Array.from({ length: 10 }, (_, i) => (i === 3 ? 1 : 0))),
      b = channel(Array.from({ length: 10 }, (_, i) => (i === 5 ? 1 : 0))),
      peak = (data: ArrayLike<number>) => samples(data).indexOf(Math.max(...samples(data)));
    const aligned = analyzeTimeResponses([a, b], { measured: true, sum: true });
    expect(aligned.channels.map((c) => peak(c.impulse!.samples))).toEqual([3, 5]);
    b.measurement!.processing!.window!.start = 2;
    const separatelyPacked = analyzeTimeResponses([a, b], { measured: true, sum: true });
    expect(separatelyPacked.channels.map((c) => peak(c.impulse!.samples))).toEqual([3, 3]);
    expect(separatelyPacked.sum!.warnings.join(' ')).toContain(
      'shared-crop-origin controls are not modeled',
    );
  });

  it('caps original data at native65536, reports it, and refuses a window wholly outside that capacity', () => {
    const c = channel(Array.from({ length: 65538 }, (_, i) => (i === 65537 ? 1 : 0)));
    const analysis = analyzeTimeResponses([c], { measured: true, length: 8 });
    expect(samples(analysis.channels[0].impulse!.samples).every((x) => x === 0)).toBe(true);
    expect(analysis.warnings.join(' ')).toContain('first 65536');
    c.measurement!.processing!.window!.start = 65536;
    expect(analyzeTimeResponses([c], { measured: true }).channels[0].reason).toContain(
      'native capacity',
    );
  });

  it('supports electrical-only prediction without measurement and validates requests without mutating channels', () => {
    const c = newProject().presets[0].channels[0],
      before = structuredClone(c);
    c.gain = -6;
    const analysis = analyzeTimeResponses([c], { length: 4, sum: true });
    expect(analysis.channels[0].source).toBe('electrical');
    expect(analysis.channels[0].impulse!.sampleRate).toBe(FS);
    expect(analysis.channels[0].impulse!.samples[0]).toBeCloseTo(10 ** (-6 / 20), 12);
    expect(c).toEqual({ ...before, gain: -6 });
    for (const length of [0, -1, 1.5, Infinity])
      expect(() => analyzeTimeResponses([c], { length })).toThrow('length');
    expect(() => analyzeTimeResponses([c], { referenceChannel: 1 })).toThrow('reference');
    c.coefficientCache = 'unresolved';
    expect(analyzeTimeResponses([c], { length: 4 }).channels[0].reason).toContain('Resolve');
  });

  it('uses canonical marked native crop/rate/reference sizing while retaining and ignoring legacy window/phase-start metadata', () => {
    const raw = [0.2, 0.3, 1, 0.5, -0.2, 0.1, 0, 0, 0, 0],
      c = channel(raw);
    useHfdNative(c, { sampleRate: 48000, localStart: 2, stopInclusive: 3, phaseStart: 8 });
    expect(c.measurement!.processing!.window!.end).toBe(10);
    const before = structuredClone(c),
      curve = analyzeTimeResponses([c], { measured: true }).channels[0];
    expect(curve.impulse!.samples.length).toBe(4);
    expect(curve.impulse!.sampleRate).toBe(48000);
    near(curve.impulse!.samples, nativeDft(raw.slice(2, 4), 4, 48000));
    expect(c).toEqual(before);
    updateHfdMeasurement(c, { phaseStart: 0 });
    near(
      analyzeTimeResponses([c], { measured: true }).channels[0].impulse!.samples,
      curve.impulse!.samples,
    );
  });

  it('shares an explicit crop-start snapshot across loaded/unloaded native groups without peak alignment', () => {
    const preset = newProject().presets[0],
      a = channel(Array.from({ length: 10 }, (_, i) => (i === 3 ? 1 : 0))),
      b = channel(Array.from({ length: 10 }, (_, i) => (i === 5 ? 1 : 0))),
      peak = (data: ArrayLike<number>) => samples(data).indexOf(Math.max(...samples(data)));
    preset.channels[0] = a;
    preset.channels[1] = b;
    enablePresetHfdMeasurement(preset);
    updateHfdMeasurement(preset.channels[0], { localStart: 2 });
    updateHfdMeasurement(preset.channels[1], { localStart: 4 });
    setSharedHfdCrop(preset, 0);
    const shared = analyzeTimeResponses(preset.channels, { preset, measured: true, sum: true });
    expect(shared.channels.slice(0, 2).map((c) => peak(c.impulse!.samples))).toEqual([1, 3]);
    expect(shared.sum!.warnings.join(' ')).not.toContain('different crop starts');
    setSharedHfdCrop(preset, null);
    const local = analyzeTimeResponses(preset.channels, { preset, measured: true, sum: true });
    expect(local.channels.slice(0, 2).map((c) => peak(c.impulse!.samples))).toEqual([1, 1]);
    expect(local.sum!.warnings.join(' ')).toContain('shared native crop-start snapshot');
  });

  it('treats an empty marked native crop as a loaded zero response and refuses unsupported custom FFT lengths explicitly', () => {
    const c = channel();
    useHfdNative(c, { localStart: 100, stopInclusive: 4 });
    const analysis = analyzeTimeResponses([c], { measured: true, sum: true });
    expect(analysis.channels[0].source).toBe('measured-impulse');
    expect(samples(analysis.channels[0].impulse!.samples).every((n) => n === 0)).toBe(true);
    expect(samples(analysis.sum!.step!.samples).every((n) => n === 0)).toBe(true);
    c.hfdMeasurement = { ...defaultsHfdMeasurementOptions(), fftLength: 2048 };
    expect(() => analyzeTimeResponses([c], { measured: true })).toThrow('65536');
  });

  it('matches the captured shared10/48000 Fit request at grid11 without shifting the timed peak', () => {
    const c = nativeFitChannel(30, 65535);
    Object.assign(c.hfdMeasurement!, { sharedStart: 10, sharedGroupId: 1, phaseStart: 12 });
    const before = structuredClone(c),
      analysis = analyzeTimeResponses([c], { measured: true }),
      impulse = analysis.channels[0].impulse!;
    // Native01 saved zoomleft=.000229166666666667s and zoomright=1.3653125s.
    expect(analysis.windowBounds).toEqual({ minMs: 0.22916666666666666, maxMs: 1365.3125 });
    expect(analysis.windowBounds!.minMs).not.toBe((10 / 48000) * 1000);
    expect(impulse.samples.length).toBe(65536);
    expect(samples(impulse.samples).indexOf(Math.max(...samples(impulse.samples)))).toBe(10);
    expect(impulse.samples[10]).toBeCloseTo(1, 12);
    expect(c).toEqual(before);

    c.hfdMeasurement!.stopInclusive = 127;
    const shorter = analyzeTimeResponses([c], { measured: true });
    expect(shorter.windowBounds).toEqual({ minMs: 0.22916666666666666, maxMs: 2.6458333333333335 });
    near(
      shorter.channels[0].impulse!.samples,
      nativeDft(c.measurement!.impulse!.slice(10), 256, 48000),
    );
  });

  it.each([
    [1, 0.020833333333333332],
    [11, 0.22916666666666666],
    [12, 0.25],
    [30, 0.625],
    [64, 1.3333333333333333],
    [127, 2.6458333333333335],
    [65535, 1365.3125],
  ])(
    'keeps grid-exact native start%d rather than applying a universal one-sample increment',
    (start, minMs) => {
      const analysis = analyzeTimeResponses([nativeFitChannel(start, 65535)], {
        measured: true,
        length: 4,
      });
      expect(analysis.windowBounds).toEqual({ minMs, maxMs: 1365.3125 });
    },
  );

  it('uses only the selected native reference bounds even when another channel has a wider window', () => {
    const selected = nativeFitChannel(10, 127),
      other = nativeFitChannel(0, 65535),
      before = structuredClone([selected, other]);
    const first = analyzeTimeResponses([selected, other], { measured: true, referenceChannel: 0 });
    expect(first.windowBounds).toEqual({ minMs: 0.22916666666666666, maxMs: 2.6458333333333335 });
    expect(first.channels.map((c) => c.impulse!.samples.length)).toEqual([256, 256]);
    const second = analyzeTimeResponses([selected, other], { measured: true, referenceChannel: 1 });
    expect(second.windowBounds).toEqual({ minMs: 0, maxMs: 1365.3125 });
    expect(second.channels.map((c) => c.impulse!.samples.length)).toEqual([65536, 65536]);
    expect([selected, other]).toEqual(before);
  });

  it('retains the two-second right default when stop64 is outside the64-point grid, even for a cropped view', () => {
    const analysis = analyzeTimeResponses([nativeFitChannel(1, 64)], {
      measured: true,
      length: 8,
    });
    expect(analysis.windowBounds).toEqual({ minMs: 0.020833333333333332, maxMs: 2000 });
    expect(analysis.channels[0].impulse!.samples.length).toBe(8);
    expect(analysis.channels[0].warnings.join(' ')).toContain(
      'cropped after full native synthesis',
    );
  });

  it.each([
    [-10, 127, 0, 2.6458333333333335],
    [12, 10, 0, 0.22916666666666666],
    [100, 64, 0, 2000],
    [-10, -1, 0, 0],
  ])(
    'preserves bounded native scan defaults for start%d/stop%d without sorting the request',
    (start, stop, minMs, maxMs) => {
      const c = nativeFitChannel(start, stop),
        before = structuredClone(c),
        analysis = analyzeTimeResponses([c], { measured: true });
      expect(analysis.windowBounds).toEqual({ minMs, maxMs });
      expect(c).toEqual(before);
      if (minMs === maxMs)
        expect(() => fitTimeSeries([analysis.channels[0].impulse!], analysis.windowBounds)).toThrow(
          'Invalid time fit bounds',
        );
    },
  );

  it('does not borrow another native channel crop when the selected reference has no measured impulse', () => {
    const absent = newProject().presets[0].channels[0];
    absent.hfdMeasurement = defaultsHfdMeasurementOptions();
    const analysis = analyzeTimeResponses([absent, nativeFitChannel(10, 127)], {
      measured: true,
      referenceChannel: 0,
    });
    expect(analysis.channels[0].source).toBe('unavailable');
    expect(analysis.channels[1].source).toBe('measured-impulse');
    expect(analysis.windowBounds).toBeUndefined();
  });
});
