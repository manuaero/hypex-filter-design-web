import { describe, expect, it } from 'vitest';
import {
  newProject,
  type Channel,
  type HfdMeasurementOptions,
  type Measurement,
} from '../src/domain/model';
import { processMeasurement, spectrum } from '../src/domain/measurement';
import {
  defaultsHfdMeasurementOptions,
  defaultHfdMeasurementOptions,
  validateHfdMeasurementOptions,
  effectiveHfdCropStart,
  useHfdNative,
  useBrowserMeasurement,
  updateHfdMeasurement,
  recomputeHfdMeasurement,
  processChannelMeasurement,
  setSharedHfdCrop,
  enablePresetHfdMeasurement,
  hfdMeasurementStatus,
  hfdSmoothInterp,
  hfdSmoothPlot,
  hfdMedianDb,
  importChannelMeasurement,
} from '../src/domain/hfd-measurement';

function fixture(values = [1, 0, 0, 0, 0, 0, 0, 0]): Channel {
  const channel = newProject().presets[0].channels[0];
  channel.measurement = {
    ...spectrum(values, 48000),
    name: 'Owned original impulse',
    processing: {
      window: { start: 0, end: values.length, taper: 0, timeZero: 0 },
      smoothingOctaves: 0,
      calibrationEnabled: false,
    },
  };
  return channel;
}
const grid = () =>
  Array.from({ length: 1024 }, (_, j) => 10 * Math.exp((Math.log(46875 / 10) * j) / 1024));
function dtft(values: number[], bin: number, n = 65536) {
  let real = 0,
    imaginary = 0;
  values.forEach((v, i) => {
    real += v * Math.cos((-2 * Math.PI * bin * i) / n);
    imaginary += v * Math.sin((-2 * Math.PI * bin * i) / n);
  });
  return { magnitude: Math.hypot(real, imaginary), phase: Math.atan2(imaginary, real) };
}
function directGaussian(values: number[], x: number, kind: 'magnitude' | 'phase') {
  const a = (Math.sqrt(Math.log(2)) * (2 ** 0.0125 + 1)) / (x * (2 ** 0.0125 - 1)),
    radius = Math.sqrt(-Math.log(0.001)) / a;
  let sum = 0,
    normalization = 0;
  for (let k = Math.floor(x - radius); k <= Math.ceil(x + radius); k++) {
    const weight = Math.exp(-(((k - x) * a) ** 2));
    sum += dtft(values, k)[kind] * weight;
    normalization += weight;
  }
  return sum / normalization;
}

describe('native HFD measurement options and explicit migration', () => {
  it('keeps marker-absent legacy arrays and processing unchanged until an explicit conversion', () => {
    const c = fixture();
    c.measurement!.magnitude![0] += 2.4; // Historical processed snapshot, intentionally not recomputed.
    const before = structuredClone(c);
    expect(recomputeHfdMeasurement(c)).toBe(c);
    expect(useBrowserMeasurement(c)).toBe(c);
    expect(c).toEqual(before);
    const patch = {
        window: { start: 0, end: 6, taper: 0.5, timeZero: 1.5 },
        smoothingOctaves: 1 / 3,
      },
      expected = processMeasurement(before.measurement!, patch);
    processChannelMeasurement(c, patch);
    expect(c.hfdMeasurement).toBeUndefined();
    expect(c.measurement).toEqual(expected);
  });

  it('provides web-explicit defaults and validates only the recovered ordinary FFT configuration', () => {
    const options = defaultsHfdMeasurementOptions();
    expect(defaultHfdMeasurementOptions()).toEqual(options);
    expect(options).toEqual({
      sampleRate: 48000,
      localStart: 0,
      stopInclusive: 65535,
      phaseStart: -1,
      sharedStart: -1,
      sharedGroupId: -1,
      fftLength: 65536,
      smoothBw: 0.0125,
      smoothPostBw: 0.125,
      applyMicCorrection: false,
    });
    expect(() => validateHfdMeasurementOptions(options)).not.toThrow();
    for (const patch of [
      { fftLength: 2048 },
      { sampleRate: NaN },
      { localStart: 0.2 },
      { phaseStart: -(2 ** 31) - 1 },
      { sharedGroupId: 0 },
      { applyMicCorrection: 1 },
      { smoothBw: -1 },
    ])
      expect(() =>
        validateHfdMeasurementOptions({ ...options, ...patch } as HfdMeasurementOptions),
      ).toThrow();
    expect(() =>
      validateHfdMeasurementOptions({
        ...options,
        localStart: 100,
        stopInclusive: 1,
        phaseStart: 300,
      }),
    ).not.toThrow();
    expect(() => validateHfdMeasurementOptions({ ...options, smoothPostBw: 10 })).not.toThrow();
  });

  it('maps a legacy window explicitly, retains original data and legacy settings, and generates the exact native log grid', () => {
    const c = fixture([0, 0, 1, 0.5, 0, 0, 0, 0]);
    Object.assign(c.measurement!.processing!.window!, {
      start: 2,
      end: 7,
      timeZero: 3.9,
      taper: 0.4,
    });
    const original = structuredClone(c.measurement!);
    expect(useHfdNative(c)).toBe(c);
    expect(c.hfdMeasurement).toMatchObject({
      localStart: 2,
      stopInclusive: 6,
      phaseStart: 3,
      smoothPostBw: 0.0001,
    });
    expect(c.measurement!.impulse).toEqual(original.impulse);
    expect(c.measurement!.processing).toEqual(original.processing);
    expect(c.measurement!.frequency).toHaveLength(1024);
    expect(c.measurement!.frequency![0]).toBe(10);
    expect(c.measurement!.frequency![512]).toBeCloseTo(684.6531968814579, 10);
    expect(c.measurement!.frequency![1023]).toBeCloseTo(46489.660764248794, 9);
    expect(hfdMeasurementStatus(c).warnings.join(' ')).toContain('retained browser taper');
    useBrowserMeasurement(c);
    expect(c.hfdMeasurement).toBeUndefined();
    expect(c.measurement!.hfdPhase).toBeUndefined();
    expect(c.measurement!.hfdMagnitude).toBeUndefined();
    expect(c.measurement).toEqual(
      processMeasurement(original, { smoothingOctaves: original.processing!.smoothingOctaves }),
    );
  });

  it('uses independent packed phase-start samples rather than rotating the magnitude-crop FFT', () => {
    const raw = [0.5, 0, 0, 1, 0, 0, 0.3, 0],
      c = fixture(raw);
    useHfdNative(c, { localStart: 2, stopInclusive: 7, phaseStart: 0 });
    const j = 512,
      frequency = c.measurement!.frequency![j],
      x = (65536 * frequency) / 48000,
      crop = raw.slice(2, 8);
    expect(c.measurement!.hfdMagnitude!.linearMagnitude[j]).toBeCloseTo(
      directGaussian(crop, x, 'magnitude'),
      11,
    );
    expect(c.measurement!.phase![j]).toBeCloseTo(
      (directGaussian(crop, x, 'phase') * 180) / Math.PI,
      10,
    );
    expect(c.measurement!.hfdPhase!.phase[j]).toBeCloseTo(
      (directGaussian(raw, x, 'phase') * 180) / Math.PI,
      10,
    );
    expect(Math.abs(c.measurement!.hfdPhase!.phase[j] - c.measurement!.phase![j])).toBeGreaterThan(
      1,
    );
    const before = structuredClone(c.measurement!.hfdMagnitude);
    updateHfdMeasurement(c, { phaseStart: 3 });
    expect(c.measurement!.hfdMagnitude).toEqual(before);
    expect(c.measurement!.hfdPhase!.phase[j]).not.toBeCloseTo(
      (directGaussian(raw, x, 'phase') * 180) / Math.PI,
      6,
    );
  });

  it('applies a loaded browser correction to the crop source only and keeps flag/resource transitions coherent', () => {
    const c = fixture([0, 0, 1, 0.3, 0, 0, 0, 0]);
    useHfdNative(c);
    const before = structuredClone(c.measurement!),
      calibration = {
        name: 'Browser curve',
        sampleRate: 48000,
        frequency: [10, 24000],
        magnitude: [6, 6],
        phase: [30, 30],
      };
    processChannelMeasurement(c, { calibration, calibrationEnabled: true });
    expect(c.hfdMeasurement!.applyMicCorrection).toBe(true);
    expect(c.measurement!.processing!.calibrationEnabled).toBe(true);
    expect(c.measurement!.hfdPhase).toEqual(before.hfdPhase);
    expect(c.measurement!.hfdMagnitude!.linearMagnitude[512]).toBeCloseTo(
      before.hfdMagnitude!.linearMagnitude[512] / 10 ** (6 / 20),
      11,
    );
    expect(c.measurement!.phase![512]).toBeCloseTo(before.phase![512] - 30, 9);
    expect(hfdMeasurementStatus(c).warnings.join(' ')).toContain('legacy browser correction curve');
    processChannelMeasurement(c, { calibration: null });
    expect(c.hfdMeasurement!.applyMicCorrection).toBe(false);
    expect(c.measurement!.processing!.calibration).toBeUndefined();
    expect(c.measurement!.hfdMagnitude).toEqual(before.hfdMagnitude);
  });

  it('retains a requested-but-missing native correction resource honestly without inventing data', () => {
    const c = fixture();
    useHfdNative(c, { applyMicCorrection: true });
    expect(c.measurement!.hfdMagnitude!.linearMagnitude[512]).toBeCloseTo(1, 12);
    expect(hfdMeasurementStatus(c).warnings.join(' ')).toContain('resource is not loaded');
    const before = structuredClone(c);
    expect(() => processChannelMeasurement(c, { calibrationEnabled: true })).toThrow(
      'loaded correction',
    );
    expect(c).toEqual(before);
  });

  it('maps native legacy-compatible processing commands without replacing archived browser windows and rejects taper atomically', () => {
    const c = fixture(),
      legacyWindow = structuredClone(c.measurement!.processing!.window);
    useHfdNative(c);
    processChannelMeasurement(c, {
      window: { start: 2, end: 51, taper: 0, timeZero: 4 },
      smoothingOctaves: 0,
    });
    expect(c.hfdMeasurement).toMatchObject({
      localStart: 2,
      stopInclusive: 50,
      phaseStart: 4,
      smoothBw: 0.0125,
      smoothPostBw: 0.0001,
    });
    expect(c.measurement!.processing!.window).toEqual(legacyWindow);
    const before = structuredClone(c);
    expect(() =>
      processChannelMeasurement(c, { window: { start: 0, end: 8, taper: 0.1, timeZero: 0 } }),
    ).toThrow('rectangular');
    expect(c).toEqual(before);
    expect(() => updateHfdMeasurement(c, { fftLength: 1024 })).toThrow('65536');
    expect(c).toEqual(before);
  });

  it('keeps unloaded native settings and synthesizes a legitimate all-zero magnitude for an empty native crop', () => {
    const unloaded = newProject().presets[0].channels[0];
    useHfdNative(unloaded, { localStart: 12, phaseStart: -1 });
    expect(unloaded.measurement).toBeUndefined();
    const options = structuredClone(unloaded.hfdMeasurement);
    recomputeHfdMeasurement(unloaded);
    expect(unloaded.hfdMeasurement).toEqual(options);
    expect(hfdMeasurementStatus(unloaded).hasImpulse).toBe(false);
    const c = fixture();
    useHfdNative(c, { localStart: 100, stopInclusive: 4 });
    expect(c.measurement!.hfdMagnitude!.linearMagnitude.every((v) => v === 0)).toBe(true);
    expect(c.measurement!.magnitude!.every((v) => v === -200)).toBe(true);
    expect(c.measurement!.hfdMagnitude!.medianDb).toBeCloseTo(199.9, 12);
  });

  it('applies the native original-sample capacity without changing the retained full source', () => {
    const c = newProject().presets[0].channels[0],
      raw = Array.from({ length: 65538 }, (_, i) => (i === 65537 ? 1 : 0));
    c.measurement = { name: 'Long source', sampleRate: 48000, impulse: raw };
    useHfdNative(c);
    expect(c.measurement!.impulse).toEqual(raw);
    expect(c.measurement!.hfdMagnitude!.linearMagnitude.every((v) => v === 0)).toBe(true);
    expect(hfdMeasurementStatus(c).warnings.join(' ')).toContain('first 65536');
  });
});

describe('current-preset shared crop snapshots', () => {
  it('broadcasts the effective numeric start to linked, excluded and unloaded groups, preserves locals and does not follow later edits', () => {
    const preset = newProject().presets[0];
    preset.channels[0] = fixture();
    preset.channels[1] = fixture();
    preset.channels[1].linkedTo = 0;
    preset.channels[1].includeInSum = false;
    enablePresetHfdMeasurement(preset);
    updateHfdMeasurement(preset.channels[0], { localStart: 2 });
    updateHfdMeasurement(preset.channels[1], { localStart: 4 });
    setSharedHfdCrop(preset, 0);
    expect(
      preset.channels.map((c) => [
        c.hfdMeasurement!.sharedGroupId,
        effectiveHfdCropStart(c.hfdMeasurement!),
      ]),
    ).toEqual([
      [1, 2],
      [1, 2],
      [1, 2],
    ]);
    expect(preset.channels[2].measurement).toBeUndefined();
    updateHfdMeasurement(preset.channels[0], { localStart: 6 });
    expect(preset.channels.map((c) => effectiveHfdCropStart(c.hfdMeasurement!))).toEqual([2, 2, 2]);
    setSharedHfdCrop(preset, 1); // source is already shared: copy effective2, not local4.
    expect(preset.channels.map((c) => c.hfdMeasurement!.sharedGroupId)).toEqual([2, 2, 2]);
    expect(preset.channels.map((c) => c.hfdMeasurement!.sharedStart)).toEqual([2, 2, 2]);
    setSharedHfdCrop(preset, null);
    expect(preset.channels.map((c) => effectiveHfdCropStart(c.hfdMeasurement!))).toEqual([6, 4, 0]);
    expect(
      preset.channels.every(
        (c) => c.hfdMeasurement!.sharedStart === -1 && c.hfdMeasurement!.sharedGroupId === -1,
      ),
    ).toBe(true);
    updateHfdMeasurement(preset.channels[2], { localStart: 7 });
    setSharedHfdCrop(preset, 2); // An unloaded group can still own the numeric snapshot.
    expect(preset.channels.map((c) => c.hfdMeasurement!.sharedStart)).toEqual([7, 7, 7]);
  });

  it('never converts legacy groups silently and commits a preset only after every proposal is valid', () => {
    const preset = newProject().presets[0],
      before = structuredClone(preset);
    expect(() => setSharedHfdCrop(preset, 0)).toThrow('all three');
    expect(preset).toEqual(before);
    enablePresetHfdMeasurement(preset);
    preset.channels[2].hfdMeasurement!.fftLength = 2048;
    const invalid = structuredClone(preset);
    expect(() => setSharedHfdCrop(preset, 0)).toThrow('65536');
    expect(preset).toEqual(invalid);
    expect(() => setSharedHfdCrop(preset, 3)).toThrow('source channel');
  });

  it('rolls back the entire conversion proposal on late invalid input and rejects aliased channel objects', () => {
    const preset = newProject().presets[0];
    preset.channels = [fixture(), fixture(), fixture()];
    preset.channels[2].measurement!.impulse![0] = Number.NaN;
    const before = structuredClone(preset);
    expect(() => enablePresetHfdMeasurement(preset)).toThrow('original impulse');
    expect(preset).toEqual(before);
    preset.channels[2] = preset.channels[1];
    expect(() => enablePresetHfdMeasurement(preset)).toThrow('distinct channel');
    expect(preset.channels.every((c) => !c.hfdMeasurement)).toBe(true);
  });
});

describe('atomic measurement imports shared by UI and MCP', () => {
  const frd = (): Measurement => ({
    name: 'Owned FRD',
    sampleRate: 48000,
    frequency: [10, 1000],
    magnitude: [2, -3],
    phase: [20, -70],
  });

  it('retains browser mode and supplied historical response arrays when analysis is omitted', () => {
    const target = fixture(),
      incoming = fixture([0, 1, 0, 0, 0, 0, 0, 0]).measurement!;
    incoming.magnitude![0] = 12.3;
    const before = structuredClone(incoming);
    expect(importChannelMeasurement(target, incoming)).toBe(target);
    expect(target.hfdMeasurement).toBeUndefined();
    expect(target.measurement).toEqual(before);
    expect(incoming).toEqual(before);
    expect(target.measurement).not.toBe(incoming);
  });

  it('retains native crop/shared options while adopting an incoming impulse sample rate and rebuilding caches', () => {
    const target = fixture();
    useHfdNative(target, { localStart: 2, stopInclusive: 6, sharedStart: 1, sharedGroupId: 2 });
    const incoming = fixture([0, 0, 1, 0.5, 0, 0, 0, 0]).measurement!;
    incoming.sampleRate = 96000;
    importChannelMeasurement(target, incoming);
    expect(target.hfdMeasurement).toMatchObject({
      sampleRate: 96000,
      localStart: 2,
      stopInclusive: 6,
      sharedStart: 1,
      sharedGroupId: 2,
    });
    expect(target.measurement!.sampleRate).toBe(96000);
    expect(target.measurement!.hfdMagnitude!.frequency).toHaveLength(1024);
    expect(target.measurement!.impulse).toEqual(incoming.impulse);
  });

  it('explicitly enables native mode or imports browser data while dropping every native cache', () => {
    const target = fixture(),
      incoming = fixture().measurement!;
    importChannelMeasurement(target, incoming, 'hfd');
    expect(target.hfdMeasurement).toBeDefined();
    expect(target.measurement!.hfdPhase).toBeDefined();
    const browser = frd();
    browser.hfdPhase = { frequency: [10, 1000], phase: [999, 999] };
    browser.hfdMagnitude = { frequency: [10, 1000], linearMagnitude: [999, 999], medianDb: 999 };
    const before = structuredClone(browser);
    importChannelMeasurement(target, browser, 'browser');
    expect(target.hfdMeasurement).toBeUndefined();
    expect(target.measurement!.hfdPhase).toBeUndefined();
    expect(target.measurement!.hfdMagnitude).toBeUndefined();
    expect(target.measurement!.frequency).toEqual(browser.frequency);
    expect(target.measurement!.magnitude).toEqual(browser.magnitude);
    expect(browser).toEqual(before);
  });

  it.each(['explicit', 'retained', 'direct conversion'])(
    'rejects native FRD-only input atomically for %s native intent',
    (intent) => {
      const target = fixture();
      if (intent === 'retained') useHfdNative(target, { sampleRate: 96000, localStart: 3 });
      if (intent === 'direct conversion') target.measurement = frd();
      const before = structuredClone(target),
        incoming = frd(),
        source = structuredClone(incoming);
      expect(() =>
        intent === 'direct conversion'
          ? useHfdNative(target)
          : importChannelMeasurement(target, incoming, intent === 'explicit' ? 'hfd' : undefined),
      ).toThrow('requires original impulse');
      expect(target).toEqual(before);
      expect(incoming).toEqual(source);
    },
  );

  it('clears original data without discarding native settings unless browser mode is explicitly requested', () => {
    const target = fixture();
    useHfdNative(target, { sampleRate: 96000, localStart: 7, phaseStart: 3 });
    const options = structuredClone(target.hfdMeasurement);
    importChannelMeasurement(target, undefined);
    expect(target.measurement).toBeUndefined();
    expect(target.hfdMeasurement).toEqual(options);
    importChannelMeasurement(target, undefined, 'browser');
    expect(target.measurement).toBeUndefined();
    expect(target.hfdMeasurement).toBeUndefined();
    importChannelMeasurement(target, undefined, 'hfd');
    expect(target.hfdMeasurement).toEqual(defaultsHfdMeasurementOptions());
  });

  it('allows unloaded references and synchronizes their displayed sample rate to canonical native options', () => {
    const target = newProject().presets[0].channels[0],
      incoming = { name: 'Unloaded.dat', sampleRate: 44100 };
    useHfdNative(target, { sampleRate: 96000 });
    importChannelMeasurement(target, incoming);
    expect(target.measurement).toEqual({ name: 'Unloaded.dat', sampleRate: 96000 });
    updateHfdMeasurement(target, { sampleRate: 88200 });
    expect(target.measurement!.sampleRate).toBe(88200);
    expect(incoming.sampleRate).toBe(44100);
    expect(target.measurement!.hfdPhase).toBeUndefined();
    expect(target.measurement!.hfdMagnitude).toBeUndefined();
  });

  it('does not share original data, processing resources or native caches between roles or with the caller', () => {
    const first = fixture(),
      second = fixture(),
      incoming = fixture().measurement!;
    incoming.processing!.calibration = {
      name: 'Detached correction',
      sampleRate: 48000,
      frequency: [10, 24000],
      magnitude: [1, 2],
      phase: [0, 20],
    };
    importChannelMeasurement(first, incoming, 'hfd');
    importChannelMeasurement(second, incoming, 'hfd');
    const before = structuredClone(incoming),
      other = structuredClone(second);
    first.measurement!.impulse![0] = -10;
    first.measurement!.processing!.window!.start = 2;
    first.measurement!.processing!.calibration!.magnitude[0] = 234;
    first.measurement!.hfdPhase!.phase[0] = 123;
    first.measurement!.hfdMagnitude!.linearMagnitude[0] = 321;
    expect(second).toEqual(other);
    expect(incoming).toEqual(before);
  });

  it('leaves the complete target unchanged when validation of incoming original data fails', () => {
    const target = fixture();
    useHfdNative(target);
    const before = structuredClone(target),
      incoming = fixture().measurement!;
    incoming.impulse![3] = Number.NaN;
    expect(() => importChannelMeasurement(target, incoming, 'browser')).toThrow('original impulse');
    expect(target).toEqual(before);
  });
});

describe('independent static native Gaussian and centering fixtures', () => {
  it('matches the recovered linear-bin Gaussian fixture and singular/above-Nyquist behavior', () => {
    const input = new Float64Array(65536);
    input[100] = 1;
    input[101] = 3;
    expect(hfdSmoothInterp(input, 100.25, 0.0125, 65536)).toBeCloseTo(1.2702598263710903, 12);
    expect(hfdSmoothInterp(input, 32769, 0.0125, 65536)).toBe(0);
    expect(hfdSmoothInterp(input, 100.25, 0, 65536)).toBe(0);
  });

  it('matches globally normalized, edge-repeated native post smoothing without boundary renormalization', () => {
    const input = new Float64Array(1024);
    input[0] = 1;
    const output = hfdSmoothPlot(input, grid(), 0.125);
    expect(output[0]).toBeCloseTo(0.5223527377210826, 12);
    expect(output[1]).toBeCloseTo(0.4776461866637149, 12);
    expect(output[2]).toBeCloseTo(0.4332194696924997, 12);
    expect(hfdSmoothPlot(new Float64Array(1024).fill(1), grid(), 0.125)[512]).toBeCloseTo(
      0.9999989243847974,
      12,
    );
    expect(Array.from(hfdSmoothPlot(input, grid(), 0))).toEqual(Array.from(input));
    const frequencies = grid(),
      s = (1024 * 10 * Math.LN2) / Math.log(frequencies[1023] / frequencies[0]),
      a = Math.sqrt(Math.LN2) / s;
    let z = 1;
    for (let i = 1; i < 1024; i++) z += 2 * Math.exp(-((i * a) ** 2));
    const wide = hfdSmoothPlot(input, frequencies, 10);
    expect(wide[0]).toBeCloseTo((1 + 1 / z) / 2, 12);
    expect(wide[1023]).toBeCloseTo(Math.exp(-((1023 * a) ** 2)) / z, 12);
    expect(hfdSmoothPlot(new Float64Array(1024).fill(1), frequencies, 10)[0]).toBeCloseTo(1, 12);
  });

  it('retains native histogram scan biases and refuses out-of-range histogram writes', () => {
    expect(hfdMedianDb(new Float64Array(1024).fill(1))).toBeCloseTo(0.1, 12);
    expect(hfdMedianDb(new Float64Array(1024))).toBeCloseTo(199.9, 12);
    expect(hfdMedianDb([...Array(512).fill(1), ...Array(512).fill(2)])).toBeCloseTo(6.1, 12);
    expect(() => hfdMedianDb([1e20])).toThrow('histogram range');
  });
});
