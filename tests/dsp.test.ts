import { describe, it, expect } from 'vitest';
import { newFilter, newProject, exampleProject, unity } from '../src/domain/model';
import {
  design,
  roundEven,
  q24,
  response,
  encodeChannel,
  compileSector,
  effectiveSections,
  channelResponse,
  stable,
} from '../src/domain/dsp';
import { FILTER_NAMES } from '../src/domain/dsp';
import guiFixtures from './fixtures/hfd-gui-filter-coefficients.json';
describe('DSP numerical behavior', () => {
  it('keeps runtime mute and analysis-only global delay out of FA503 coefficient blocks', () => {
    const c = newProject().presets[0].channels[0];
    c.delayUs = 32;
    const before = encodeChannel(c);
    c.muted = true;
    c.globalDelayUs = 40000;
    expect(encodeChannel(c)).toEqual(before);
    c.delayUs = 32000;
    expect(new DataView(encodeChannel(c).buffer).getUint32(0, true)).toBe(3000);
    c.delayUs = 32010;
    expect(() => encodeChannel(c)).toThrow('32,000');
  });
  it('matches screenshot-operated HFD first-order and all-pass fixtures', () => {
    const kinds = {
      ftLowPass1: 'lowpass1',
      ftHighPass1: 'highpass1',
      ftAllPass1: 'allpass1',
      ftAllPass2: 'allpass2',
    } as const;
    for (const f of guiFixtures) {
      const kind = kinds[f.filtertype as keyof typeof kinds];
      if (!kind) throw Error('Unexpected fixture');
      const c = design({
        ...newFilter(kind),
        frequency: Number(f.f1),
        q: Number(f.q1),
        gain: Number(f.gain),
      });
      [c.b0, c.b1, c.b2, c.f1, c.f2].forEach((n, i) =>
        expect(n).toBeCloseTo(Number([f.b0, f.b1, f.b2, f.a1, f.a2][i]), 12),
      );
    }
  });
  it('uses signed round-to-nearest-even and rejects overflow', () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, -2.5].map(roundEven)).toEqual([0, 2, 2, 0, -2, -2]);
    expect(q24(1)).toBe(16777216);
    expect(() => q24(128)).toThrow();
  });
  it('matches independently recovered HFD low-pass and shelf fixtures', () => {
    const cases = [
      {
        kind: 'lowpass2',
        frequency: 202.031448364258,
        q: 0.7,
        gain: 0,
        expected: [0.000181302833978531, 0, 0, 1.98066105199979, -0.980842626534427],
      },
      {
        kind: 'lowshelf1',
        frequency: 30,
        q: 0.707,
        gain: 6,
        expected: [1.00070833175372, -0.997870276843851, 0, 0.99857760311052, 0],
      },
      {
        kind: 'highshelf2',
        frequency: 18000,
        q: 0.707,
        gain: 12,
        expected: [
          2.19453270084061, -1.97494594514026, 0.655723375311081, 0.214503322913722,
          -0.0897930470087748,
        ],
      },
    ];
    for (const t of cases) {
      const c = design({
        ...newFilter(t.kind as keyof typeof FILTER_NAMES),
        frequency: t.frequency,
        q: t.q,
        gain: t.gain,
      });
      [c.b0, c.b1, c.b2, c.f1, c.f2].forEach((n, i) => expect(n).toBeCloseTo(t.expected[i], 11));
    }
  });
  it('keeps all-pass magnitude unity', () => {
    for (const kind of ['allpass1', 'allpass2'] as const) {
      for (const hz of [10, 100, 1000, 10000, 40000])
        expect(Math.hypot(...response(design(newFilter(kind)), hz))).toBeCloseTo(1, 9);
    }
  });
  it('matches HFD boost/cut fixture and AP1 polarity', () => {
    const c = design({ ...newFilter('peak'), frequency: 58.5, q: 2.44, gain: 6 });
    expect(c.b0).toBeCloseTo(1.00079961585211, 12);
    expect(c.f1).toBeCloseTo(1.99837908331296, 12);
    expect(response(design(newFilter('allpass1')), 0)[0]).toBeCloseTo(-1, 12);
  });
  it('matches native minimum-gain real-root snapping while refusing its marginal pole', () => {
    // V39 native10_GainMin: F2300/Q1.15/gain-125, Fs93750. These are
    // literal native saved coefficients, not generated reference values.
    const filter = { ...newFilter('peak'), frequency: 2300, q: 1.15, gain: -125 },
      coefficients = design(filter),
      native = {
        b0: 4.49498817986139e-6,
        b1: -8.32633707729407e-6,
        b2: 3.93110969729619e-6,
        f1: 1,
        f2: 0,
      };
    for (const field of ['b0', 'b1', 'b2', 'f1', 'f2'] as const)
      expect(Math.abs(coefficients[field] - native[field])).toBeLessThan(1e-18);
    expect(coefficients.f1).toBe(1);
    expect(stable(coefficients)).toBe(false);
    // Pure integer representation does not authorize compilation/upload.
    expect(
      Array.from(
        Int32Array.from(
          [coefficients.b2, coefficients.b1, coefficients.b0, coefficients.f2, coefficients.f1],
          q24,
        ),
      ),
    ).toEqual([66, -140, 75, 0, 16777216]);
    const channel = newProject().presets[0].channels[0];
    channel.filters[0] = filter;
    expect(() => encodeChannel(channel)).toThrow('Unstable or non-finite biquad');
    channel.filters[0] = { ...filter, coefficients: native };
    expect(() => encodeChannel(channel)).toThrow('Unstable or non-finite biquad');
  });
  it('keeps the nearby real-pole case and unrelated tiny coefficients unsnapped', () => {
    // Independent unsnapped Double calculation at-124: 1-sqrt(...) is
    // 1.053046538856961e-12, above the native inclusive1e-12 threshold.
    const channel = newProject().presets[0].channels[0];
    channel.filters[0] = { ...newFilter('peak'), frequency: 2300, q: 1.15, gain: -124 };
    const coefficients = design(channel.filters[0]);
    expect(coefficients.f1).toBeCloseTo(0.9999998881448119, 15);
    expect(coefficients.f1).toBeLessThan(1);
    expect(stable(coefficients)).toBe(true);
    expect(() => encodeChannel(channel)).not.toThrow();
    // This is not a general coefficient floor or an import normalization.
    const tiny = design({ ...newFilter('lowpass1'), frequency: 1e-9 });
    expect(tiny.b0).toBeGreaterThan(0);
    expect(tiny.b0).toBeLessThan(1e-12);
  });
  it('compiles every supported filter kind and bypasses disabled raw data', () => {
    for (const kind of Object.keys(FILTER_NAMES)) {
      if (kind === 'raw') continue;
      const p = newProject();
      p.presets[0].channels[0].filters[0] = newFilter(kind as keyof typeof FILTER_NAMES);
      expect(encodeChannel(p.presets[0].channels[0]).length).toBe(512);
    }
    expect(
      design({
        ...newFilter('raw'),
        enabled: false,
        coefficients: { b0: 7, b1: 0, b2: 0, f1: 2, f2: 0 },
      }),
    ).toEqual(unity());
  });
  it('applies gain/polarity once and serializes wire order', () => {
    const c = newProject().presets[0].channels[0];
    c.gain = -6;
    c.invert = true;
    c.delayUs = 32;
    const data = encodeChannel(c),
      v = new DataView(data.buffer);
    expect(v.getUint32(0, true)).toBe(3);
    expect(v.getInt32(4, true)).toBe(0);
    expect(v.getInt32(12, true)).toBe(q24(-(10 ** (-6 / 20))));
    expect(data.slice(304).every((b) => b === 255)).toBe(true);
  });
  it('rejects filters unstable after Q24 quantization', () => {
    const c = newProject().presets[0].channels[0];
    c.filters[0] = { ...newFilter('raw'), coefficients: { ...unity(), f1: 1 - 1e-10 } };
    expect(() => encodeChannel(c)).toThrow('quantization');
  });
  it('preserves bytes outside all three channel blocks', () => {
    const p = newProject().presets[0],
      original = Uint8Array.from({ length: 4096 }, (_, i) => i % 251),
      output = compileSector(p, original);
    expect(output.slice(1536)).toEqual(original.slice(1536));
    expect(original[0]).toBe(0);
  });
  it('cancels identical channels with opposite polarity in complex sum', () => {
    const c = exampleProject().presets[0].channels[1],
      inverse = { ...c, invert: true };
    for (const hz of [20, 100, 350, 1000, 2500, 10000]) {
      const a = channelResponse(c, hz),
        b = channelResponse(inverse, hz);
      expect(Math.hypot(a[0] + b[0], a[1] + b[1])).toBeLessThan(1e-12);
    }
  });
});
