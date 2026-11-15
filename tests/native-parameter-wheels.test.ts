// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { HFD_TEMPLATE } from '../src/domain/hfd-template';
import { exportHfd, importHfd } from '../src/domain/files';
import { editManualFilter } from '../src/domain/editing';
import { designHfd } from '../src/domain/hfd-math';
import { encodeChannel, q24 } from '../src/domain/dsp';
import { hfdManualParameterWheelNext } from '../src/domain/parameter-wheel';
import type { Coefficients, Filter, FilterKind } from '../src/domain/model';
import {
  nativeAdditionalGainWheelEvents,
  nativeParameterWheelStates,
  nativeUnstableWheelEvents,
  nativeWheelEndpoints,
  nativeWheelEvents,
  syntheticAdditionalGainInput,
} from './data/hfd-native-parameter-wheels';

interface NativeState {
  kind: FilterKind;
  enabled: boolean;
  additionalGain: number;
  gainlowered: boolean;
  parameters: Record<string, string>;
  coefficients: Record<string, string>;
}
function nativeProject(fixture: NativeState) {
  const xml = new DOMParser().parseFromString(HFD_TEMPLATE, 'application/xml'),
    node = xml.querySelector('preset[index="1"] processobj[processtype="ptBiQuad"][groupid="1"]')!,
    gain = xml.querySelector('preset[index="1"] processobj[processtype="ptGain"][groupid="1"]')!;
  xml.documentElement.removeAttribute('fusion-studio-coefficient-cache');
  xml.querySelector('device')!.setAttribute('gainlowered', String(fixture.gainlowered));
  gain
    .querySelector(':scope > additionalgain')!
    .setAttribute('value', String(fixture.additionalGain));
  node.setAttribute('enabled', String(fixture.enabled));
  for (const [name, value] of Object.entries({ ...fixture.parameters, ...fixture.coefficients }))
    node.querySelector(`:scope > ${name}`)!.setAttribute('value', value);
  return importHfd(new XMLSerializer().serializeToString(xml), 'Native wheel fixture');
}
const coefficients = (fixture: NativeState): Coefficients => ({
  b0: Number(fixture.coefficients.b0),
  b1: Number(fixture.coefficients.b1),
  b2: Number(fixture.coefficients.b2),
  f1: Number(fixture.coefficients.a1),
  f2: Number(fixture.coefficients.a2),
});
const scalarWords = (value: Coefficients) =>
  [value.b2, value.b1, value.b0, value.f2, value.f1].map(q24);
function firstWords(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: 5 }, (_, index) => view.getInt32(4 + 4 * index, true));
}
function doubleHex(value: number) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function expectNativeDesign(filter: Filter, fixture: NativeState, tolerance = 1e-12) {
  const generated = designHfd(filter),
    expected = coefficients(fixture);
  for (const key of ['b0', 'b1', 'b2', 'f1', 'f2'] as const)
    expect(Math.abs(generated[key] - expected[key])).toBeLessThan(tolerance);
}

it.each(nativeWheelEvents)(
  'matches saved native $name and independent section words without altering another parameter',
  (fixture) => {
    const project = nativeProject(fixture.before),
      original = structuredClone(project),
      channel = project.presets[0].channels[0],
      old = channel.filters[0],
      result = hfdManualParameterWheelNext(old[fixture.field], fixture.direction, {
        parameter: fixture.parameter,
        displayedText: fixture.textBefore,
        additionalGain: channel.additionalGain,
      });
    // The actual native event was one +360 for two of these rows; the shared
    // domain contract consumes its direction once, rather than three steps.
    expect(result).toMatchObject({
      text: fixture.expectedText,
      value: fixture.expectedValue,
      changed: true,
    });
    expect(doubleHex(result.value)).toBe(fixture.doubleHex);
    const next = editManualFilter(
      old,
      { [fixture.field]: result.value },
      {
        redesign: true,
        manualParameters: false,
      },
    );
    expect(next).toMatchObject({
      id: old.id,
      sourceId: old.sourceId,
      kind: fixture.after.kind,
      enabled: fixture.after.enabled,
      frequency: Number(fixture.after.parameters.f1),
      frequency2: Number(fixture.after.parameters.f2),
      q: Number(fixture.after.parameters.q1),
      q2: Number(fixture.after.parameters.q2),
      gain: Number(fixture.after.parameters.gain),
    });
    expect(next.coefficients).toBeUndefined();
    expectNativeDesign(next, fixture.after);
    const saved = nativeProject(fixture.after).presets[0].channels[0];
    expect(saved.filters[0].coefficients).toEqual(coefficients(fixture.after));
    expect(firstWords(encodeChannel(saved))).toEqual(fixture.after.q24SectionWords);
    expect(
      firstWords(encodeChannel({ ...channel, filters: [next, ...channel.filters.slice(1)] })),
    ).toEqual(fixture.after.q24SectionWords);
    expect(project).toEqual(original);
  },
);

it('matches the four native endpoint value/Text results and requests no canonical edit', () => {
  for (const fixture of nativeWheelEndpoints) {
    const project = nativeProject(fixture.state),
      original = structuredClone(project),
      filter = project.presets[0].channels[0].filters[0],
      result = hfdManualParameterWheelNext(filter[fixture.field], fixture.direction, {
        parameter: fixture.parameter,
        displayedText: fixture.text,
      });
    expect(result).toMatchObject({ text: fixture.text, value: fixture.value, changed: false });
    expect(project).toEqual(original);
  }
  // The Q/gain maximum and Q minimum GUI cases included typing before the
  // wheel, without an intermediate save. This test claims only the observed
  // endpoint values and pure helper no-op; not wheel-only byte identity.
});

it.each(nativeUnstableWheelEvents)(
  'matches native $name while refusing both literal and regenerated pole-at-one compilation',
  (fixture) => {
    const before = nativeProject(fixture.before).presets[0].channels[0],
      result = hfdManualParameterWheelNext(before.filters[0].gain, fixture.direction, {
        parameter: 'gain',
        displayedText: fixture.textBefore,
      }),
      next = editManualFilter(
        before.filters[0],
        { gain: result.value },
        {
          redesign: true,
          manualParameters: false,
        },
      ),
      saved = nativeProject(fixture.after).presets[0].channels[0];
    expect(result).toMatchObject({
      text: fixture.expectedText,
      value: fixture.expectedValue,
      changed: true,
    });
    expect(doubleHex(result.value)).toBe(fixture.doubleHex);
    expect(saved.filters[0].coefficients).toEqual(coefficients(fixture.after));
    expectNativeDesign(next, fixture.after, 1e-18);
    expect(scalarWords(coefficients(fixture.after))).toEqual(fixture.after.q24SectionWords);
    expect(() => encodeChannel(saved)).toThrow('Unstable or non-finite biquad');
    expect(() => encodeChannel({ ...before, filters: [next, ...before.filters.slice(1)] })).toThrow(
      'Unstable or non-finite biquad',
    );
  },
);

it.each(nativeAdditionalGainWheelEvents)(
  'matches native AdditionalGain $name with capped Text and separately saved canonical gain',
  (fixture) => {
    const result = hfdManualParameterWheelNext(fixture.inputValue, 1, {
      parameter: 'gain',
      displayedText: fixture.inputText,
      additionalGain: 10,
    });
    expect(result).toMatchObject({
      text: fixture.expectedText,
      value: fixture.expectedValue,
      changed: true,
    });
    expect(Number(result.text)).not.toBe(result.value);
    expect(doubleHex(result.value)).toBe(fixture.doubleHex);
    const project = nativeProject(nativeParameterWheelStates.additionalGainReload),
      original = structuredClone(project),
      channel = project.presets[0].channels[0],
      next = editManualFilter(
        channel.filters[0],
        { gain: result.value },
        {
          redesign: true,
          manualParameters: false,
        },
      ),
      savedProject = nativeProject(fixture.after),
      saved = savedProject.presets[0].channels[0],
      literal = coefficients(fixture.after);
    expect(saved.additionalGain).toBe(10);
    expect(saved.filters[0]).toMatchObject({ gain: fixture.expectedValue, coefficients: literal });
    // In particular, native22 b1 must remain the exact parsed Double. The old
    // divide/multiply reconstruction changed it by one ULP when AddGain=10.
    expect(saved.filters[0].coefficients).toEqual(literal);
    expect(next.gain).toBe(fixture.expectedValue);
    expectNativeDesign(next, fixture.after);
    expect(scalarWords(designHfd(next))).toEqual(fixture.after.q24SectionWords);
    expect(firstWords(encodeChannel({ ...saved, additionalGain: 0 }))).toEqual(
      fixture.after.q24SectionWords,
    );
    const reopened = importHfd(exportHfd(savedProject), 'Reopened native stored gain').presets[0]
      .channels[0];
    expect(reopened).toMatchObject({ additionalGain: 10 });
    expect(reopened.filters[0]).toMatchObject({
      gain: fixture.expectedValue,
      coefficients: literal,
    });
    expect(project).toEqual(original);
  },
);

it('preserves passive synthetic AdditionalGain6 imports separately from native21 load normalization to10', () => {
  const input = syntheticAdditionalGainInput,
    synthetic = nativeProject({
      ...input.sourceState,
      additionalGain: input.additionalGain,
      gainlowered: false,
    }),
    nativeReload = nativeProject(nativeParameterWheelStates.additionalGainReload);
  expect(synthetic.presets[0].channels[0].additionalGain).toBe(6);
  expect(nativeReload.presets[0].channels[0].additionalGain).toBe(10);
  expect(synthetic.presets[0].channels[0].filters[0].coefficients).toEqual(
    coefficients(input.sourceState),
  );
  expect(nativeReload.presets[0].channels[0].filters[0].coefficients).toEqual(
    coefficients(input.sourceState),
  );
  expect(
    importHfd(exportHfd(synthetic), 'Reopened passive synthetic input').presets[0].channels[0]
      .additionalGain,
  ).toBe(6);
  expect(synthetic.sourceXml).toContain('gainlowered="false"');
  expect(nativeReload.sourceXml).toContain('gainlowered="true"');
});
