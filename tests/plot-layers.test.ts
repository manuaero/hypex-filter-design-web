import { describe, expect, it } from 'vitest';
import { newFilter, newProject, unity, type Channel, type Filter } from '../src/domain/model';
import { channelResponse, response } from '../src/domain/dsp';
import { designHfd } from '../src/domain/hfd-math';
import { useHfdNative } from '../src/domain/hfd-measurement';
import {
  defaultMagnitudeLayers,
  selectedSectionCoefficients,
  selectedSectionResponse,
  selectedSectionAnalysisChannel,
  filterMarkerAnchor,
  buildMagnitudeLayers,
} from '../src/domain/plot-layers';
import manualNative from './fixtures/hfd-gui-manual-filter-coefficients.json';

function measurement(channel: Channel, amplitude = 1, phase = 0) {
  channel.measurement = {
    name: `${channel.name}.frd`,
    sampleRate: 48000,
    frequency: [10, 1000, 46875],
    magnitude: [amplitude, amplitude, amplitude].map((x) => 20 * Math.log10(x)),
    phase: [phase, phase, phase],
  };
}
function fixture() {
  const preset = newProject().presets[0];
  measurement(preset.channels[0]);
  measurement(preset.channels[1]);
  return preset;
}

it('other filtered output results are independent from current result and raw overlays', () => {
  const preset = fixture(),
    layers = { ...defaultMagnitudeLayers(), section: false, otherResults: true };
  preset.channels[1].gain = -9;
  const data = buildMagnitudeLayers(preset.channels, {
    preset,
    layers,
    referenceChannel: 1,
    measured: false,
  });
  expect(data.curves.map((curve) => [curve.kind, curve.channel, curve.color])).toEqual([
    ['result', 0, '#efb45d'],
    ['result', 1, '#58d6bb'],
    ['result', 2, '#a596f5'],
  ]);
  expect(data.curves[1].db[100]).toBeCloseTo(-9, 8);
  const hiddenCurrent = buildMagnitudeLayers(preset.channels, {
    preset,
    layers: { ...layers, currentResult: false },
    referenceChannel: 1,
    measured: false,
  });
  expect(hiddenCurrent.curves.map((curve) => curve.channel)).toEqual([0, 2]);
  const currentOnly = buildMagnitudeLayers(preset.channels, {
    preset,
    layers: { ...layers, otherResults: false },
    referenceChannel: 1,
    measured: false,
  });
  expect(currentOnly.curves).toHaveLength(1);
  expect(currentOnly.curves[0].color).toBe('#efb45d');
  const measured = buildMagnitudeLayers(preset.channels, {
    preset,
    layers,
    referenceChannel: 1,
    measured: true,
  });
  expect(measured.curves.map((curve) => curve.channel)).toEqual([0, 1]);
  expect(() =>
    buildMagnitudeLayers(preset.channels, { layers: { ...layers, otherResults: 'yes' as never } }),
  ).toThrow(/selection/);
});

describe('native isolated selected section', () => {
  it('rebuilds a bypassed parameter filter whose imported compiled cache is Unity', () => {
    const filter = {
        ...newFilter('lowpass2'),
        frequency: 350,
        q: 0.707,
        enabled: false,
        coefficients: unity(),
        provenance: 'hfd' as const,
      },
      original = structuredClone(filter),
      expected = designHfd({ ...filter, enabled: true });
    expect(selectedSectionCoefficients(filter)).toEqual(expected);
    expect(selectedSectionResponse(filter, 3000)).toEqual(response(expected, 3000));
    expect(Math.hypot(...selectedSectionResponse(filter, 3000))).toBeLessThan(0.03);
    expect(filter).toEqual(original);
  });
  it('native recalculation uses parameter metadata for enabled sections too, without consuming stale effective-gain caches', () => {
    const filter = {
      ...newFilter('peak'),
      frequency: 1000,
      gain: -6,
      coefficients: { ...unity(), b0: 4 },
    };
    const value = selectedSectionResponse(filter, 1000);
    expect(20 * Math.log10(Math.hypot(...value))).toBeCloseTo(-6, 4);
    expect(filter.coefficients.b0).toBe(4);
  });
  it('preserves exact free coefficients including bypassed free sections and returns detached copies', () => {
    const coefficients = { b0: 0.25, b1: 0.125, b2: -0.0625, f1: -0.2, f2: 0.1 },
      filter = { ...newFilter('raw'), enabled: false, gain: 18, coefficients },
      copy = selectedSectionCoefficients(filter);
    expect(selectedSectionResponse(filter, 1000)).toEqual(response(coefficients, 1000));
    expect(copy).toEqual(coefficients);
    copy.b0 = 999;
    expect(filter.coefficients.b0).toBe(0.25);
  });
  it('rejects missing/nonfinite free coefficients and invalid frequency instead of inventing a Unity response', () => {
    expect(() => selectedSectionCoefficients(newFilter('raw'))).toThrow(/original coefficients/);
    expect(() =>
      selectedSectionCoefficients({ ...newFilter('raw'), coefficients: { ...unity(), b0: NaN } }),
    ).toThrow();
    expect(() => selectedSectionResponse(newFilter('unity'), -1)).toThrow();
    expect(() => selectedSectionResponse(newFilter('unity'), Infinity)).toThrow();
  });
  it('makes an isolated analysis channel whilst the ordinary disabled signal chain remains Unity', () => {
    const channel = newProject().presets[0].channels[0];
    channel.filters[0] = {
      ...newFilter('lowpass2'),
      frequency: 500,
      enabled: false,
      coefficients: unity(),
    };
    const original = structuredClone(channel),
      isolated = selectedSectionAnalysisChannel(channel, channel.filters[0], 0);
    expect(channelResponse(channel, 5000)).toEqual([1, 0]);
    const preview = channelResponse(isolated, 5000);
    expect(Math.hypot(...preview)).toBeLessThan(0.02);
    expect(Math.abs(Math.atan2(preview[1], preview[0]))).toBeGreaterThan(2.5);
    expect(channel).toEqual(original);
    expect(isolated.filters).toHaveLength(15);
    expect(new Set(isolated.filters).size).toBe(15);
  });
  it('drops all channel processing/measurements/links without copying or aliasing their large resources', () => {
    const channel = newProject().presets[0].channels[0];
    channel.filters[4] = { ...newFilter('raw'), coefficients: { ...unity(), b0: 0.5 } };
    channel.gain = -12;
    channel.additionalGain = 3;
    channel.invert = true;
    channel.muted = true;
    channel.delayUs = 700;
    channel.globalDelayUs = -100;
    channel.fir = { name: 'source-fir', enabled: true, taps: [0.1, 0.2] };
    channel.linkedTo = 1;
    measurement(channel);
    channel.hfdMeasurement = {
      sampleRate: 48000,
      localStart: 0,
      stopInclusive: 65535,
      phaseStart: -1,
      sharedStart: -1,
      sharedGroupId: -1,
      fftLength: 65536,
      smoothBw: 0.0125,
      smoothPostBw: 0.125,
      applyMicCorrection: true,
    };
    const before = structuredClone(channel),
      isolated = selectedSectionAnalysisChannel(channel, channel.filters[4], 4);
    expect(isolated).toMatchObject({
      gain: 0,
      additionalGain: 0,
      invert: false,
      muted: false,
      delayUs: 0,
      globalDelayUs: 0,
      fir: { enabled: false, taps: [] },
    });
    expect(isolated.measurement).toBeUndefined();
    expect(isolated.hfdMeasurement).toBeUndefined();
    expect(isolated.linkedTo).toBeUndefined();
    expect(channelResponse(isolated, 1234)).toEqual([0.5, 0]);
    isolated.filters[0].coefficients!.b0 = 99;
    isolated.fir.taps.push(99);
    expect(channel).toEqual(before);
  });
  it('refuses an unresolved first free cache and mismatched selection, whilst parameter regeneration remains available', () => {
    const channel = newProject().presets[0].channels[0];
    channel.coefficientCache = 'unresolved';
    channel.filters[0] = { ...newFilter('raw'), coefficients: unity() };
    expect(() => selectedSectionAnalysisChannel(channel, channel.filters[0], 0)).toThrow(/Resolve/);
    expect(() => selectedSectionAnalysisChannel(channel, channel.filters[0], 1)).toThrow(/index/);
    channel.filters[0] = { ...newFilter('highpass1'), enabled: false, coefficients: unity() };
    expect(
      selectedSectionAnalysisChannel(channel, channel.filters[0], 0).filters[0].coefficients,
    ).not.toEqual(unity());
  });
});

describe('native manual filter marker anchors', () => {
  // Independently evaluated from the saved native coefficient literals at f1,
  // before the native marker's final Double-to-Single store.
  const literalCenterDb = [
    4.582832114903331, -7.458367711656704, 3.0000003736199545, -3.0000003736203062,
  ];
  it.each(
    manualNative.cases.map((fixture, index) => ({ fixture, expected: literalCenterDb[index] })),
  )(
    'places $fixture.name at its own native response instead of the gain parameter',
    ({ fixture, expected }) => {
      const f: Filter = {
        ...newFilter(fixture.kind as Filter['kind']),
        frequency: Number(fixture.parameters.f1),
        frequency2: Number(fixture.parameters.f2),
        q: Number(fixture.parameters.q1),
        q2: Number(fixture.parameters.q2),
        gain: Number(fixture.parameters.gain),
        shelfDirection: fixture.direction as 'low' | 'high',
        enabled: false,
        provenance: 'hfd',
        // Disabled/effective direct caches are not the native roots/Kz source.
        coefficients: unity(),
      };
      const before = structuredClone(f);
      expect(filterMarkerAnchor(f)).toEqual({
        frequency: Math.fround(Number(fixture.parameters.f1)),
        db: Math.fround(expected),
      });
      expect(f).toEqual(before);
      f.coefficients = { b0: 12, b1: -24, b2: 12, f1: 0.8, f2: -0.2 };
      expect(filterMarkerAnchor(f)?.db).toBe(Math.fround(expected));
    },
  );
  it('stores both coordinates at Single precision without normalizing the filter parameters', () => {
    const f = {
      ...newFilter('asymmetric'),
      frequency: 1000.123456789,
      frequency2: 400,
      q: 0.7,
      q2: 1.3,
      shelfDirection: 'high' as const,
    };
    const before = structuredClone(f),
      frequency = Math.fround(f.frequency),
      doubleDb = 20 * Math.log10(Math.hypot(...selectedSectionResponse(f, frequency))),
      anchor = filterMarkerAnchor(f)!;
    expect(frequency).not.toBe(f.frequency);
    expect(Math.fround(doubleDb)).not.toBe(doubleDb);
    expect(anchor).toEqual({ frequency, db: Math.fround(doubleDb) });
    expect(f).toEqual(before);
  });
  it('evaluates every existing manual type and keeps raw/unity or malformed sections unavailable', () => {
    const kinds = [
      'lowpass1',
      'lowpass2',
      'highpass1',
      'highpass2',
      'peak',
      'lowshelf1',
      'highshelf1',
      'lowshelf2',
      'highshelf2',
      'asymmetric',
      'allpass1',
      'allpass2',
    ] as const;
    for (const kind of kinds) {
      const f = { ...newFilter(kind), frequency: 1500, gain: 6, q: 0.65 };
      expect(filterMarkerAnchor(f)).toMatchObject({ frequency: 1500 });
      expect(Number.isFinite(filterMarkerAnchor(f)?.db)).toBe(true);
    }
    for (const kind of ['lowshelf1', 'highshelf1'] as const)
      expect(filterMarkerAnchor({ ...newFilter(kind), frequency: 1500, gain: 6 })!.db).toBeCloseTo(
        3,
        3,
      );
    for (const f of [
      newFilter(),
      newFilter('raw'),
      { ...newFilter('peak'), frequency: NaN },
      { ...newFilter('peak'), frequency: 1e-50 },
      { ...newFilter('peak'), q: 0 },
      { ...newFilter('asymmetric'), frequency2: Infinity },
    ])
      expect(filterMarkerAnchor(f)).toBeUndefined();
  });
});

describe('main editor magnitude layers', () => {
  it('defaults raw overlays off with automatic result/section, using independent arrays', () => {
    const left = defaultMagnitudeLayers(),
      right = defaultMagnitudeLayers();
    expect(left).toEqual({
      rawMeasurements: [false, false, false],
      currentResult: true,
      section: true,
    });
    left.rawMeasurements[0] = true;
    expect(right.rawMeasurements).toEqual([false, false, false]);
    expect(() => defaultMagnitudeLayers(0)).toThrow();
  });
  it('raw visibility does not change filtered result, channel sum, original data or inclusion flags', () => {
    const preset = fixture(),
      before = structuredClone(preset),
      hidden = buildMagnitudeLayers(preset.channels, {
        preset,
        layers: { ...defaultMagnitudeLayers(), section: false },
        sum: true,
      }),
      visible = buildMagnitudeLayers(preset.channels, {
        preset,
        layers: {
          ...defaultMagnitudeLayers(),
          rawMeasurements: [true, true, true],
          section: false,
        },
        sum: true,
      });
    expect(hidden.curves.map((x) => x.kind)).toEqual(['result', 'sum']);
    expect(visible.curves.map((x) => x.kind)).toEqual(['raw', 'raw', 'result', 'sum']);
    expect(visible.curves.filter((x) => x.kind !== 'raw')).toEqual(hidden.curves);
    expect(visible.availability).toEqual([true, true, false]);
    expect(preset).toEqual(before);
  });
  it('other overlays are raw measurements, independent of their electrical filters, channel gain and Sum selection', () => {
    const preset = fixture(),
      other = preset.channels[1];
    other.gain = -18;
    other.invert = true;
    other.includeInSum = false;
    other.filters[0] = { ...newFilter('lowpass2'), frequency: 100 };
    other.fir = { name: 'Gain', enabled: true, taps: [0.5] };
    const layers = {
        ...defaultMagnitudeLayers(),
        rawMeasurements: [false, true, false],
        section: false,
      },
      data = buildMagnitudeLayers(preset.channels, { preset, layers, sum: true });
    expect(data.curves.filter((x) => x.kind === 'raw')).toHaveLength(1);
    expect(data.curves.find((x) => x.kind === 'raw')!.db.every((x) => Math.abs(x) < 1e-12)).toBe(
      true,
    );
    expect(data.curves.find((x) => x.kind === 'sum')!.db).toEqual(
      data.curves.find((x) => x.kind === 'result')!.db,
    );
  });
  it('renders only the selected current filtered result and keeps explicit raw overlays independent in electrical mode', () => {
    const preset = fixture();
    preset.channels[1].gain = -6;
    const data = buildMagnitudeLayers(preset.channels, {
      preset,
      referenceChannel: 1,
      measured: false,
      layers: {
        ...defaultMagnitudeLayers(),
        rawMeasurements: [true, false, false],
        section: false,
      },
    });
    expect(data.curves.map((x) => [x.kind, x.channel])).toEqual([
      ['raw', 0],
      ['result', 1],
    ]);
    expect(data.curves.find((x) => x.kind === 'raw')!.db[0]).toBeCloseTo(0, 12);
    expect(data.curves.find((x) => x.kind === 'result')!.db[0]).toBeCloseTo(-6, 10);
  });
  it('isolated section ignores all channel and preset processing; no selection means one full electrical cascade', () => {
    const preset = fixture(),
      channel = preset.channels[0];
    channel.filters[0] = {
      ...newFilter('peak'),
      frequency: 1000,
      gain: 6,
      enabled: false,
      coefficients: unity(),
    };
    channel.gain = -12;
    channel.additionalGain = -3;
    channel.invert = true;
    channel.delayUs = 500;
    channel.globalDelayUs = -300;
    channel.fir = { name: 'out', enabled: true, taps: [0.5] };
    preset.firPlacement = 'output';
    preset.eqEnabled = true;
    preset.inputEq[0] = { ...newFilter('peak'), frequency: 1000, gain: -6 };
    const layers = { ...defaultMagnitudeLayers(), currentResult: false },
      isolate = () => buildMagnitudeLayers(preset.channels, { preset, layers, selectedFilter: 0 }),
      before = structuredClone(preset),
      first = isolate();
    channel.muted = true;
    const muted = isolate();
    expect(muted.curves[0].db).toEqual(first.curves[0].db);
    const all = buildMagnitudeLayers(preset.channels, { preset, layers, selectedFilter: null });
    expect(all.curves).toHaveLength(1);
    expect(all.curves[0].label).toBe('Electrical cascade');
    expect(all.curves[0].db.every((x) => x === -200)).toBe(true);
    channel.muted = before.channels[0].muted;
    expect(preset).toEqual(before);
  });
  it('does not create flat raw/filtered measurements from unloaded references or original-only data without a spectrum', () => {
    const preset = newProject().presets[0];
    preset.channels[0].measurement = { name: 'missing.dat', sampleRate: 48000 };
    preset.channels[1].measurement = { name: 'not-processed.dat', sampleRate: 48000, impulse: [1] };
    const data = buildMagnitudeLayers(preset.channels, {
      preset,
      layers: { ...defaultMagnitudeLayers(), rawMeasurements: [true, true, true] },
      sum: true,
    });
    expect(data.availability).toEqual([false, false, false]);
    expect(data.curves.map((x) => x.kind)).toEqual(['section']);
  });
  it('preserves native raw centering/post display and cancellation independently of checkbox visibility', () => {
    const preset = newProject().presets[0];
    for (let c = 0; c < 2; c++) {
      preset.channels[c].measurement = {
        name: `delta${c}.dat`,
        sampleRate: 48000,
        impulse: [c === 0 ? 1 : -1, ...new Array<number>(127).fill(0)],
      };
      useHfdNative(preset.channels[c], { sampleRate: 48000 });
    }
    const options = {
        preset,
        layers: {
          ...defaultMagnitudeLayers(),
          rawMeasurements: [true, true, false],
          section: false,
        },
        sum: true,
      },
      shown = buildMagnitudeLayers(preset.channels, options),
      hidden = buildMagnitudeLayers(preset.channels, {
        ...options,
        layers: { ...options.layers, rawMeasurements: [false, false, false] },
      });
    expect(shown.centered).toBe(true);
    expect(shown.curves.find((x) => x.kind === 'raw' && x.channel === 0)!.db).toEqual(
      shown.curves.find((x) => x.kind === 'result')!.db,
    );
    expect(shown.curves.find((x) => x.kind === 'sum')!.db).toEqual(
      hidden.curves.find((x) => x.kind === 'sum')!.db,
    );
    expect(shown.curves.find((x) => x.kind === 'sum')!.db[100]).toBeLessThan(-190);
  });
  it('uses explicit warnings for an unresolved first free-section gain cache without losing other layers', () => {
    const preset = fixture(),
      channel = preset.channels[0];
    channel.coefficientCache = 'unresolved';
    channel.filters[0] = { ...newFilter('raw'), coefficients: unity() };
    const data = buildMagnitudeLayers(preset.channels, { preset, selectedFilter: 0 });
    expect(data.curves.some((x) => x.kind === 'result')).toBe(true);
    expect(data.curves.some((x) => x.kind === 'section')).toBe(false);
    expect(data.warnings.join(' ')).toMatch(/Resolve the first free section/);
  });
  it('native isolated magnitude floors overflowing free responses instead of emitting nonfinite plot coordinates', () => {
    const preset = fixture();
    preset.channels[0].filters[1] = {
      ...newFilter('raw'),
      coefficients: { ...unity(), b0: 1e101 },
    };
    const data = buildMagnitudeLayers(preset.channels, {
      preset,
      selectedFilter: 1,
      layers: { ...defaultMagnitudeLayers(), currentResult: false },
    });
    expect(data.curves[0].kind).toBe('section');
    expect(data.curves[0].db.every((value) => value === -200)).toBe(true);
  });
  it('validates arrays and selected indices before producing data', () => {
    const preset = fixture();
    for (const options of [
      { referenceChannel: 3 },
      { selectedFilter: 15 },
      { selectedFilter: -1 },
      { layers: { ...defaultMagnitudeLayers(), rawMeasurements: [true] } },
    ])
      expect(() => buildMagnitudeLayers(preset.channels, options)).toThrow(/selection/);
  });
});
