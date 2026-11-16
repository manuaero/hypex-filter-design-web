// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { HFD_TEMPLATE } from '../src/domain/hfd-template';
import { exportHfd, importHfd, parseProject } from '../src/domain/files';
import { editManualFilter } from '../src/domain/editing';
import { selectedSectionResponse } from '../src/domain/plot-layers';
import { newFilter } from '../src/domain/model';

const cache = {
  b0: 1.0000000000000002,
  b1: 0.01234567890123456,
  b2: 0.03456789012345678,
  f1: 0.25,
  f2: -0.125,
};

function reconstruction(type: string, direction: string) {
  // Synthetic container and deliberately distinct retained cache. The direction
  // oracle is the native branch, not a claim that these are native saved bytes:
  // Shelf1/2 a90b40/a90d30 test High==1; Asym a91070 tests Low==0 instead.
  const doc = new DOMParser().parseFromString(HFD_TEMPLATE, 'application/xml'),
    node = doc.querySelector('preset[index="1"] processobj[processtype="ptBiQuad"][groupid="1"]')!;
  node.setAttribute('enabled', 'true');
  for (const [name, value] of Object.entries({
    filtertype: type,
    shelfhl: direction,
    f1: 1500,
    f2: 400,
    q1: 0.65,
    q2: 1.3,
    gain: 6,
    b0: cache.b0,
    b1: cache.b1,
    b2: cache.b2,
    a1: cache.f1,
    a2: cache.f2,
  }))
    node.querySelector(`:scope > ${name}`)!.setAttribute('value', String(value));
  return importHfd(new XMLSerializer().serializeToString(doc), 'Unknown shelf reconstruction');
}

const db = (response: [number, number]) => 20 * Math.log10(Math.hypot(...response));

it.each([
  ['ftShelf1', 'lowshelf1', 'highshelf1'],
  ['ftShelf2', 'lowshelf2', 'highshelf2'],
] as const)(
  'uses the native low fallback for %s Unknown without applying it to its saved cache',
  (type, low, high) => {
    const project = reconstruction(type, 'stUnknown'),
      filter = project.presets[0].channels[0].filters[0],
      before = structuredClone(project);
    expect(filter).toMatchObject({
      kind: low,
      shelfDirection: 'low',
      sourceShelfDirection: 'stUnknown',
      coefficients: cache,
    });
    // Selected-section inspection regenerates the parameter response independently
    // of the retained cache; a positive low shelf boosts DC rather than the top.
    expect(db(selectedSectionResponse(filter, 0))).toBeGreaterThan(
      db(selectedSectionResponse(filter, 30000)) + 3,
    );
    const edited = editManualFilter(filter, { gain: 3 }, { redesign: true });
    expect(edited.kind).toBe(low);
    expect(edited.coefficients).toBeUndefined();
    expect(db(selectedSectionResponse(edited, 0))).toBeGreaterThan(
      db(selectedSectionResponse(edited, 30000)) + 1,
    );
    expect(project).toEqual(before);

    const reopened = importHfd(exportHfd(project), 'Reopened Unknown shelf reconstruction');
    expect(reopened.presets[0].channels[0].filters[0]).toMatchObject({
      kind: low,
      shelfDirection: 'low',
      sourceShelfDirection: 'stUnknown',
      coefficients: cache,
    });
    // A genuine High value still selects High. Do not reverse the valid enum.
    expect(reconstruction(type, 'stHighShelf').presets[0].channels[0].filters[0].kind).toBe(high);
  },
);

it('keeps the different native Asym Unknown fallback high and retains its cached vector', () => {
  const project = reconstruction('ftAsymShelf', 'stUnknown'),
    filter = project.presets[0].channels[0].filters[0];
  expect(filter).toMatchObject({ kind: 'asymmetric', shelfDirection: 'high', coefficients: cache });
  const explicitHigh = reconstruction('ftAsymShelf', 'stHighShelf').presets[0].channels[0]
    .filters[0];
  expect(selectedSectionResponse(filter, 1500)).toEqual(
    selectedSectionResponse(explicitHigh, 1500),
  );
  expect(
    reconstruction('ftAsymShelf', 'stLowShelf').presets[0].channels[0].filters[0].shelfDirection,
  ).toBe('low');
});

it('keeps the native enum through ordinary edits and only replaces Unknown on an explicit contrary shelf direction', () => {
  const original = reconstruction('ftShelf2', 'stUnknown').presets[0].channels[0].filters[0],
    before = structuredClone(original),
    ordinary = editManualFilter(
      original,
      { frequency: 1600, q: 0.7, gain: 3, enabled: false },
      { redesign: true },
    );
  expect(ordinary).toMatchObject({
    sourceShelfDirection: 'stUnknown',
    kind: 'lowshelf2',
    shelfDirection: 'low',
    enabled: false,
  });
  const high = editManualFilter(ordinary, { kind: 'highshelf2' }, { redesign: true }),
    low = editManualFilter(high, { kind: 'lowshelf2' }, { redesign: true }),
    asym = editManualFilter(low, { kind: 'asymmetric' }, { redesign: true });
  expect(high).toMatchObject({ sourceShelfDirection: 'stHighShelf', shelfDirection: 'high' });
  expect(low).toMatchObject({ sourceShelfDirection: 'stLowShelf', shelfDirection: 'low' });
  expect(asym).toMatchObject({ sourceShelfDirection: 'stLowShelf', shelfDirection: 'low' });
  expect(original).toEqual(before);
});

it('records an explicit direction even when it matches Unknown’s effective direction and rejects contradictory combined choices', () => {
  const original = reconstruction('ftShelf2', 'stUnknown').presets[0].channels[0].filters[0],
    before = structuredClone(original),
    low = editManualFilter(original, { shelfDirection: 'low' }, { redesign: true }),
    high = editManualFilter(original, { shelfDirection: 'high' }, { redesign: true });
  expect(low).toMatchObject({ kind: 'lowshelf2', sourceShelfDirection: 'stLowShelf' });
  expect(high).toMatchObject({ kind: 'highshelf2', sourceShelfDirection: 'stHighShelf' });
  expect(() =>
    editManualFilter(original, { kind: 'lowshelf2', shelfDirection: 'high' }, { redesign: true }),
  ).toThrow(/conflict/);
  expect(original).toEqual(before);
});

it('preserves legacy filters without a native enum and validates new persisted enum metadata', () => {
  const legacy = newFilter('highshelf2'),
    changed = editManualFilter(legacy, { kind: 'asymmetric' });
  expect(changed.sourceShelfDirection).toBeUndefined();
  expect(changed.shelfDirection).toBeUndefined();
  const project = reconstruction('ftShelf2', 'stUnknown'),
    serialized = JSON.parse(JSON.stringify(project));
  serialized.presets[0].channels[0].filters[0].sourceShelfDirection = 'stBroken';
  expect(() => parseProject(JSON.stringify(serialized))).toThrow();
});
