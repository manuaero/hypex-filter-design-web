// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { HFD_TEMPLATE } from '../src/domain/hfd-template';
import { exportHfd, importHfd } from '../src/domain/files';
import { channelResponse, effectiveSections, encodeChannel } from '../src/domain/dsp';
import {
  filterMarkerAnchor,
  selectedSectionAnalysisChannel,
  selectedSectionResponse,
} from '../src/domain/plot-layers';
import {
  nativeChannelCacheSection as section,
  nativeChannelCacheStates,
  nativeChannelCacheSectionResponse as isolated,
} from './data/hfd-native-channel-cache';

type NativeState = (typeof nativeChannelCacheStates)[number];

function reconstruction(state: NativeState) {
  // This container is synthetic. The fixture SHA records the separate complete
  // native save; no claim is made that HFD_TEMPLATE reproduces its whole bytes.
  const xml = new DOMParser().parseFromString(HFD_TEMPLATE, 'application/xml'),
    node = xml.querySelector('preset[index="1"] processobj[processtype="ptBiQuad"][groupid="1"]')!,
    gain = xml.querySelector('preset[index="1"] processobj[processtype="ptGain"][groupid="1"]')!;
  xml.documentElement.removeAttribute('fusion-studio-coefficient-cache');
  node.setAttribute('enabled', String(section.enabled));
  for (const [name, value] of Object.entries({
    ...section.parameters,
    ...section.roots,
    ...section.coefficients,
  }))
    node.querySelector(`:scope > ${name}`)!.setAttribute('value', value);
  for (const [name, value] of Object.entries({
    gain: state.channelGain,
    invert: String(state.invert),
    additionalgain: '0',
    mute: 'false',
  }))
    gain.querySelector(`:scope > ${name}`)!.setAttribute('value', value);
  return importHfd(new XMLSerializer().serializeToString(xml), 'Native cache reconstruction');
}

const nativeBase = {
  b0: Number(section.coefficients.b0),
  b1: Number(section.coefficients.b1),
  b2: Number(section.coefficients.b2),
  f1: Number(section.coefficients.a1),
  f2: Number(section.coefficients.a2),
};

function firstWords(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: 5 }, (_, index) => view.getInt32(4 + index * 4, true));
}

it.each(nativeChannelCacheStates)(
  'imports native $name as a base cache and compiles channel gain/inversion once',
  (state) => {
    const project = reconstruction(state),
      before = structuredClone(project),
      channel = project.presets[0].channels[0],
      filter = channel.filters[0];
    expect(channel).toMatchObject({
      gain: Number(state.channelGain),
      additionalGain: 0,
      invert: state.invert,
      muted: false,
      coefficientCache: 'base',
    });
    expect(filter).toMatchObject({
      sourceId: section.sourceId,
      sourceType: 'ftBoostCut',
      kind: 'peak',
      enabled: true,
      frequency: 2300,
      frequency2: 988.101806640625,
      q: 1.15,
      q2: 0.7,
      gain: 7.5,
      coefficients: nativeBase,
    });
    // Here saved native cache and browser canonical cache coincide. The five
    // saves do not exercise a gain-baked import/de-embedding transition.
    expect(firstWords(encodeChannel(channel))).toEqual(state.effectiveQ24Words);
    const effective = effectiveSections(channel);
    expect(effective[0].f1).toBe(nativeBase.f1);
    expect(effective[0].f2).toBe(nativeBase.f2);
    expect(
      effective
        .slice(1)
        .every((c) => c.b0 === 1 && c.b1 === 0 && c.b2 === 0 && c.f1 === 0 && c.f2 === 0),
    ).toBe(true);
    expect(project).toEqual(before);
  },
);

it('keeps the selected Peak response untrimmed while the channel retains −6 dB and inversion', () => {
  const project = reconstruction(nativeChannelCacheStates[4]),
    before = structuredClone(project),
    channel = project.presets[0].channels[0],
    filter = channel.filters[0],
    selected = selectedSectionAnalysisChannel(channel, filter, 0),
    [real, imaginary] = selectedSectionResponse(filter, isolated.frequency),
    [selectedReal, selectedImaginary] = channelResponse(selected, isolated.frequency),
    [channelReal, channelImaginary] = channelResponse(channel, isolated.frequency);
  expect(real).toBeCloseTo(isolated.real, 11);
  expect(imaginary).toBeCloseTo(isolated.imaginary, 11);
  expect(selectedReal).toBeCloseTo(isolated.real, 11);
  expect(selectedImaginary).toBeCloseTo(isolated.imaginary, 11);
  expect(20 * Math.log10(Math.hypot(channelReal, channelImaginary))).toBeCloseTo(
    isolated.db - 6,
    10,
  );
  expect(channelReal).toBeLessThan(0);
  expect(channelImaginary).toBeLessThan(0);
  expect(filterMarkerAnchor(filter)).toEqual({
    frequency: isolated.frequency,
    db: isolated.markerSingleDb,
  });
  expect(selected).toMatchObject({ gain: 0, additionalGain: 0, invert: false, muted: false });
  expect(project).toEqual(before);
});

it('round-trips all five cache states through standalone XML without baking gain into saved coefficients', () => {
  for (const state of nativeChannelCacheStates) {
    const project = reconstruction(state),
      before = structuredClone(project),
      xml = exportHfd(project),
      saved = new DOMParser().parseFromString(xml, 'application/xml'),
      node = saved.querySelector(
        'preset[index="1"] processobj[processtype="ptBiQuad"][groupid="1"]',
      )!,
      reopened = importHfd(xml, 'Reopened cache reconstruction').presets[0].channels[0];
    // This checks cache/root fields, not whole native XML identity: export may
    // normalize inactive direction metadata and adds browser cache metadata.
    for (const [name, value] of Object.entries({ ...section.coefficients, ...section.roots }))
      expect(node.querySelector(`:scope > ${name}`)!.getAttribute('value')).toBe(value);
    expect(reopened).toMatchObject({
      coefficientCache: 'base',
      gain: Number(state.channelGain),
      additionalGain: 0,
      invert: state.invert,
      muted: false,
    });
    expect(reopened.filters[0].coefficients).toEqual(nativeBase);
    expect(firstWords(encodeChannel(reopened))).toEqual(state.effectiveQ24Words);
    expect(project).toEqual(before);
  }
});
