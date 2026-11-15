import { expect, it } from 'vitest';
import { newProject, type Fir } from '../src/domain/model';
import { applyReadFir, type ReadFirDesign } from '../src/domain/fir-editing';
import { firIsEffective } from '../src/domain/fir-state';

const native = (capacity: number, amplitude = 0.5, used = true): Fir => ({
  name: 'Local.txt',
  enabled: true,
  taps: Array.from({ length: capacity }, (_, i) => (i === 1 ? amplitude : 0)),
  hfdState: { loaded: true, used, tapCount: capacity },
});
const unloaded = (capacity: number): Fir => ({
  name: 'Old hardware name.txt',
  enabled: false,
  taps: [],
  hfdState: { loaded: false, used: true, tapCount: capacity },
});

it('output read refreshes raw input enable while retaining its inactive local cache/name/Loaded and independent linked output banks', () => {
  const p = newProject().presets[0];
  p.inputFir = native(4500);
  p.channels[1].linkedTo = 0;
  const original = structuredClone(p.inputFir),
    inputTaps = p.inputFir.taps,
    filters = [native(1500, 0.125), native(1500, 0.25), unloaded(1500)],
    result: ReadFirDesign = { placement: 'output', flags: 0x3b, filters };
  applyReadFir(p, result);
  expect(p.inputFir).toEqual({ ...original, hfdState: { ...original.hfdState!, used: false } });
  expect(p.inputFir.taps).not.toBe(inputTaps);
  expect(p.channels.map((c) => c.fir.enabled)).toEqual([true, true, false]);
  expect(p.channels.map((c) => c.fir.hfdState!.loaded)).toEqual([true, true, false]);
  expect(p.channels[1].fir.taps[1]).toBe(0.25);
  expect(p.channels[1].linkedTo).toBe(0);
  expect(p.channels[0].fir).not.toBe(filters[0]);
  expect(p.channels[0].fir.taps).not.toBe(filters[0].taps);
  expect(p.channels[0].fir.hfdState).not.toBe(filters[0].hfdState);
  expect(firIsEffective(p.inputFir)).toBe(false);
  filters[0].taps[1] = 1;
  expect(p.channels[0].fir.taps[1]).toBe(0.125);
});

it('input read retains inactive output caches and refreshes each output enable bit without inferring samples from inactive loaded bits', () => {
  const p = newProject().presets[0];
  p.firPlacement = 'output';
  p.channels[0].fir = native(1500, 0.25);
  p.channels[1].fir = unloaded(1500);
  const before = structuredClone(p.channels.map((c) => c.fir));
  // Inactive output2 Loaded is set in hardware but no samples were read.
  applyReadFir(p, { placement: 'input', flags: 0xaa, filters: [native(4500, 0.125)] });
  expect(p.inputFir).toMatchObject({
    enabled: true,
    hfdState: { loaded: true, used: true, tapCount: 4500 },
  });
  expect(p.inputFir.taps[1]).toBe(0.125);
  expect(p.channels.map((c) => c.fir.enabled)).toEqual([false, true, false]);
  expect(p.channels[0].fir.name).toBe(before[0].name);
  expect(p.channels[0].fir.taps).toEqual(before[0].taps);
  expect(p.channels[0].fir.hfdState!.loaded).toBe(true);
  expect(p.channels[1].fir.hfdState!.loaded).toBe(false);
  expect(p.channels[1].fir.taps).toEqual([]);
  expect(p.channels.every((c) => !c.fir.hfdState!.used && !firIsEffective(c.fir))).toBe(true);
});

it('loaded=false selected reads retain the actual hardware enable bit as a latent flag and require no fabricated taps', () => {
  const p = newProject().presets[0];
  applyReadFir(p, { placement: 'input', flags: 8, filters: [unloaded(4500)] });
  expect(p.inputFir).toEqual({
    name: 'Old hardware name.txt',
    enabled: true,
    taps: [],
    hfdState: { loaded: false, used: true, tapCount: 4500 },
  });
  expect(firIsEffective(p.inputFir)).toBe(false);
});

it('rejects incomplete/inconsistent selected read banks and malformed local caches before any design mutation', () => {
  const cases: ReadFirDesign[] = [
    { placement: 'input', flags: 128, filters: [] },
    { placement: 'input', flags: 128, filters: [unloaded(4500)] },
    { placement: 'input', flags: 0, filters: [native(4500)] },
    { placement: 'output', flags: 0x70, filters: [native(1500), native(1500), native(4500)] },
    { placement: 'input', flags: 256, filters: [native(4500)] },
  ];
  for (const result of cases) {
    const p = newProject().presets[0],
      before = structuredClone(p);
    expect(() => applyReadFir(p, result)).toThrow(/FIR/);
    expect(p).toEqual(before);
  }
  const p = newProject().presets[0];
  p.channels[2].fir = native(1500);
  p.channels[2].fir.hfdState!.tapCount = 1;
  const before = structuredClone(p);
  expect(() =>
    applyReadFir(p, { placement: 'input', flags: 128, filters: [native(4500)] }),
  ).toThrow(/native FIR/);
  expect(p).toEqual(before);
});
