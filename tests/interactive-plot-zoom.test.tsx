// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import InteractivePlot, { DEFAULT_RANGE, type PlotRange } from '../src/components/InteractivePlot';
import type { PlotMode } from '../src/components/ResponsePlot';
import { newFilter, newProject, unity, type Channel, type Filter } from '../src/domain/model';
import type { MagnitudeLayers } from '../src/domain/plot-layers';
import manualNative from './fixtures/hfd-gui-manual-filter-coefficients.json';

vi.mock('../src/components/ResponsePlot', () => ({ default: () => null }));
let host: HTMLDivElement, root: Root;
const project = newProject(),
  changed = vi.fn(),
  begin = vi.fn(),
  end = vi.fn(),
  viewGestures: string[] = [],
  updates: PlotRange[] = [];
const initial: PlotRange = {
  ...DEFAULT_RANGE,
  timeMinMs: -20,
  timeMaxMs: 80,
  amplitudeMin: -2,
  amplitudeMax: 6,
  frequencyMin: 10,
  frequencyMax: 10000,
  dbMin: -40,
  dbMax: 20,
};
function Harness({ mode, contextKey = 'original' }: { mode: PlotMode; contextKey?: string }) {
  const [range, setRange] = useState(initial);
  return (
    <InteractivePlot
      channels={project.presets[0].channels}
      preset={project.presets[0]}
      mode={mode}
      sum={false}
      measured={false}
      activeChannel={0}
      activeFilter={0}
      range={range}
      onRange={(next) => {
        viewGestures.push('range');
        updates.push(next);
        setRange(next);
      }}
      contextKey={contextKey}
      onRangeGestureStart={(kind) => viewGestures.push(`start:${kind}`)}
      onRangeGestureCommit={() => viewGestures.push('commit')}
      onRangeGestureCancel={() => viewGestures.push('cancel')}
      onSelect={vi.fn()}
      onChange={changed}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
      onToggle={vi.fn()}
      begin={begin}
      end={end}
    />
  );
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(468);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(262);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    top: 50,
    width: 468,
    height: 262,
    right: 568,
    bottom: 312,
    x: 100,
    y: 50,
    toJSON() {},
  });
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  changed.mockClear();
  begin.mockClear();
  end.mockClear();
  updates.length = 0;
  viewGestures.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(mode: PlotMode, contextKey?: string) {
  await act(async () => root.render(<Harness mode={mode} contextKey={contextKey} />));
}
async function pointer(
  type: string,
  x: number,
  y: number,
  button = 1,
  target: Element = host.querySelector('.plot-interaction')!,
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x + 100,
    clientY: y + 50,
    button,
    buttons: type === 'pointerup' ? 0 : button === 1 ? 4 : 1,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  await act(async () => target.dispatchEvent(event));
}
async function drag(start = { x: 148, y: 74 }, stop = { x: 348, y: 174 }) {
  await pointer('pointerdown', start.x, start.y);
  await pointer('pointermove', stop.x, stop.y);
  await pointer('pointerup', stop.x, stop.y);
}
const reverse = () => drag({ x: 348, y: 174 }, { x: 148, y: 74 });

it('actual Impulse pointer drag changes both physical time and amplitude axes, without filter edits or Undo gesture callbacks', async () => {
  await mount('Impulse');
  await drag();
  expect(updates).toEqual([
    { ...initial, timeMinMs: 5, timeMaxMs: 55, amplitudeMin: 0, amplitudeMax: 4 },
  ]);
  expect(changed).not.toHaveBeenCalled();
  expect(begin).not.toHaveBeenCalled();
  expect(end).not.toHaveBeenCalled();
});
it('actual pointer interaction ignores an X-only rectangle and native16-pixel-sized Y drag', async () => {
  await mount('Impulse');
  await drag({ x: 148, y: 74 }, { x: 348, y: 74 });
  await drag({ x: 148, y: 74 }, { x: 348, y: 90 });
  expect(updates).toEqual([]);
});
it('Impulse reverse restores the first XY snapshot after two rectangle zooms', async () => {
  await mount('Impulse');
  await drag();
  await drag();
  await reverse();
  expect(updates.length).toBe(3);
  expect(updates.at(-1)).toEqual(initial);
  await reverse();
  expect(updates.length).toBe(3);
});
it.each(['Step', 'Magnitude'] as const)(
  '%s uses native History=true and reverses one XY zoom at a time',
  async (mode) => {
    await mount(mode);
    await drag();
    const first = { ...updates[0] };
    await drag();
    await reverse();
    expect(updates.at(-1)).toEqual(first);
    await reverse();
    if (mode === 'Magnitude') {
      expect(first.frequencyMin).toBeCloseTo(10 ** 1.75, 12);
      expect(first.frequencyMax).toBeCloseTo(10 ** 3.25, 10);
      expect([first.dbMin, first.dbMax]).toEqual([-25, 5]);
      expect(updates.at(-1)?.frequencyMin).toBeCloseTo(initial.frequencyMin, 10);
      expect(updates.at(-1)?.frequencyMax).toBeCloseTo(initial.frequencyMax, 10);
      expect(updates.at(-1)?.dbMin).toBe(initial.dbMin);
      expect(updates.at(-1)?.dbMax).toBe(initial.dbMax);
      expect(updates[0].timeMinMs).toBe(initial.timeMinMs);
      expect(updates[0].amplitudeMin).toBe(initial.amplitudeMin);
    } else expect(updates.at(-1)).toEqual(initial);
  },
);
it('keeps each graph history separate and reverses only its axes after switching frequency/time views', async () => {
  await mount('Magnitude');
  await drag();
  await mount('Impulse');
  await drag();
  const timed = { ...updates.at(-1)! };
  await mount('Magnitude');
  await reverse();
  expect(updates.at(-1)).toEqual({
    ...timed,
    frequencyMin: initial.frequencyMin,
    frequencyMax: initial.frequencyMax,
    dbMin: initial.dbMin,
    dbMax: initial.dbMax,
  });
  await mount('Impulse');
  await reverse();
  expect(updates.at(-1)).toEqual(initial);
});
it('cancelled pointer rectangles neither zoom nor add a future reverse snapshot', async () => {
  await mount('Impulse');
  await pointer('pointerdown', 148, 74);
  await pointer('pointermove', 348, 174);
  await pointer('pointercancel', 348, 174);
  await pointer('pointerup', 348, 174);
  await reverse();
  expect(updates).toEqual([]);
});

it('commits a view once after the final rectangle action, and commits plain mouse-up clicks without filter Undo gestures', async () => {
  await mount('Impulse');
  await pointer('pointerdown', 148, 74);
  await pointer('pointermove', 348, 174);
  expect(viewGestures).toEqual(['start:zoom']);
  await pointer('pointerup', 348, 174);
  expect(viewGestures).toEqual(['start:zoom', 'range', 'commit']);
  viewGestures.length = 0;
  await pointer('pointerdown', 200, 120, 0);
  await pointer('pointerup', 200, 120, 0);
  expect(viewGestures).toEqual(['start:pan', 'commit']);
  expect(begin).not.toHaveBeenCalled();
  expect(end).not.toHaveBeenCalled();
});

it('pan moves remain preview-only until one mouse-up commit, while cancellation and context changes cancel without a write callback', async () => {
  await mount('Impulse');
  await pointer('pointerdown', 148, 74, 0);
  await pointer('pointermove', 200, 100, 0);
  await pointer('pointermove', 250, 120, 0);
  expect(viewGestures).toEqual(['start:pan', 'range', 'range']);
  await pointer('pointerup', 250, 120, 0);
  expect(viewGestures.at(-1)).toBe('commit');
  expect(viewGestures.filter((value) => value === 'commit')).toHaveLength(1);
  viewGestures.length = 0;
  await pointer('pointerdown', 148, 74);
  await pointer('pointercancel', 200, 120);
  await pointer('pointerup', 200, 120);
  expect(viewGestures).toEqual(['start:zoom', 'cancel']);
  viewGestures.length = 0;
  await pointer('pointerdown', 148, 74);
  await mount('Impulse', 'replacement-output');
  await pointer('pointerup', 348, 174);
  expect(viewGestures).toEqual(['start:zoom', 'cancel']);
});

it('reverse rectangles commit only after native reverse geometry has restored the first snapshot', async () => {
  await mount('Impulse');
  await drag();
  viewGestures.length = 0;
  await reverse();
  expect(viewGestures).toEqual(['start:zoom', 'range', 'commit']);
  expect(updates.at(-1)).toEqual(initial);
});

const nativeCenterDb: Record<string, number> = {
  'asymmetric Low normalization': 4.582832114903331,
  'asymmetric High normalization': -7.458367711656704,
  'second-order high shelf +6 dB': 3.0000003736199545,
  'second-order high shelf -6 dB': -3.0000003736203062,
  'boost/cut +7.5 dB': 7.500008716167609,
  'boost/cut -7.5 dB': -7.500008716167583,
  'boost/cut zero gain after edit': 0,
  'low-pass 2 real-pole Q 0.4': -7.970118835525309,
};
function nativeCenter(index: number) {
  const name = manualNative.cases[index].name,
    db = nativeCenterDb[name];
  if (!Number.isFinite(db)) throw new Error(`Missing independent native center oracle: ${name}`);
  return db;
}
function markerChannels(fixtureIndex = 2) {
  const channels = newProject().presets[0].channels,
    fixture = manualNative.cases[fixtureIndex];
  channels[0].filters[0] = {
    ...newFilter(fixture.kind as Filter['kind']),
    frequency: Number(fixture.parameters.f1),
    frequency2: Number(fixture.parameters.f2),
    q: Number(fixture.parameters.q1),
    q2: Number(fixture.parameters.q2),
    gain: Number(fixture.parameters.gain),
    shelfDirection: fixture.direction as 'low' | 'high',
    enabled: false,
    coefficients: unity(),
    provenance: 'hfd',
  };
  return channels;
}
let markerState: Channel[];
function MarkerHarness({
  source,
  measured = false,
  layers,
}: {
  source: Channel[];
  measured?: boolean;
  layers?: MagnitudeLayers;
}) {
  const [channels, setChannels] = useState(source),
    [selected, setSelected] = useState(0);
  markerState = channels;
  return (
    <InteractivePlot
      channels={channels}
      mode="Magnitude"
      sum={true}
      measured={measured}
      magnitudeLayers={layers}
      nativeCentered={true}
      activeChannel={0}
      activeFilter={selected}
      range={initial}
      onRange={vi.fn()}
      onSelect={setSelected}
      onChange={(patch) => {
        changed(patch);
        setChannels((current) => {
          const next = structuredClone(current);
          Object.assign(next[0].filters[selected], patch);
          return next;
        });
      }}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
      onToggle={vi.fn()}
      begin={begin}
      end={end}
    />
  );
}
const marker = (index = 0) => host.querySelector<HTMLButtonElement>(`[data-filter="${index}"]`)!;
const coordinates = (element: HTMLElement) => ({
  x: Number.parseFloat(element.style.left),
  y: Number.parseFloat(element.style.top),
});
const expectedMarker = (frequency: number, db: number) => ({
  x:
    48 +
    (Math.log(Math.fround(frequency) / initial.frequencyMin) /
      Math.log(initial.frequencyMax / initial.frequencyMin)) *
      400,
  y: 24 + ((initial.dbMax - Math.fround(db)) / (initial.dbMax - initial.dbMin)) * 200,
});

it.each(manualNative.cases.map((fixture, index) => ({ fixture, index })))(
  'actual graph places the bypassed native $fixture.name marker on the own-section response',
  async ({ fixture, index }) => {
    const channels = markerChannels(index),
      before = structuredClone(channels);
    await act(async () => root.render(<MarkerHarness source={channels} />));
    const expected = expectedMarker(Number(fixture.parameters.f1), nativeCenter(index)),
      actual = coordinates(marker());
    // DOM style serialization rounds CSS pixel values to three decimals.
    expect(actual.x).toBeCloseTo(expected.x, 2);
    expect(actual.y).toBeCloseTo(expected.y, 2);
    expect(marker().classList.contains('bypassed')).toBe(true);
    expect(channels).toEqual(before);
    expect(changed).not.toHaveBeenCalled();
  },
);

it('keeps electrical marker anchors independent of external processing, measured centering and layer visibility', async () => {
  const channels = markerChannels();
  await act(async () => root.render(<MarkerHarness source={channels} />));
  const baseline = coordinates(marker());
  const processed = structuredClone(channels),
    channel = processed[0];
  channel.gain = 12;
  channel.additionalGain = -3;
  channel.invert = true;
  channel.muted = true;
  channel.delayUs = 1200;
  channel.globalDelayUs = -100;
  channel.fir = { name: 'synthetic', enabled: true, taps: [4, 2] };
  channel.filters[0].coefficients = { ...unity(), b0: 8 };
  channel.filters[1] = { ...newFilter('peak'), frequency: 300, gain: 18 };
  channel.measurement = {
    name: 'synthetic',
    sampleRate: 48000,
    frequency: [10, 1000, 20000],
    magnitude: [100, 100, 100],
    hfdMagnitude: { frequency: [10, 1000, 20000], linearMagnitude: [1e5, 1e5, 1e5], medianDb: 100 },
  };
  channel.hfdMeasurement = {
    sampleRate: 48000,
    localStart: 0,
    stopInclusive: 65535,
    phaseStart: -1,
    sharedStart: -1,
    sharedGroupId: -1,
    fftLength: 65536,
    smoothBw: 0.0125,
    smoothPostBw: 1,
    applyMicCorrection: false,
  };
  await act(async () =>
    root.render(
      <MarkerHarness
        key="processed"
        source={processed}
        measured
        layers={{
          rawMeasurements: [true, true, true],
          currentResult: false,
          otherResults: false,
          section: false,
        }}
      />,
    ),
  );
  expect(coordinates(marker())).toEqual(baseline);
  expect(changed).not.toHaveBeenCalled();
});

it('omits one malformed marker without fabricating zero dB or dropping valid/manual neighbors', async () => {
  const channels = markerChannels(1);
  channels[0].filters[1] = { ...newFilter('peak'), frequency: NaN };
  channels[0].filters[2] = { ...newFilter('raw'), coefficients: { ...unity(), b0: 0.5 } };
  await act(async () => root.render(<MarkerHarness source={channels} />));
  expect(host.querySelectorAll('[data-filter]')).toHaveLength(1);
  expect(coordinates(marker()).y).toBeCloseTo(expectedMarker(800, nativeCenter(1)).y, 2);
});

it('fans overlapping markers while preserving true electrical leader endpoints and anchor hit selection', async () => {
  const channels = markerChannels();
  channels[0].filters[1] = { ...channels[0].filters[0], id: 'synthetic-second-marker' };
  await act(async () => root.render(<MarkerHarness source={channels} />));
  const anchor = expectedMarker(1500, nativeCenter(2)),
    fanned = coordinates(marker(1)),
    line = host.querySelector('line')!;
  expect(Math.hypot(fanned.x - anchor.x, fanned.y - anchor.y)).toBeGreaterThanOrEqual(24 - 1e-7);
  expect(Number(line.getAttribute('x1'))).toBeCloseTo(anchor.x, 10);
  expect(Number(line.getAttribute('y1'))).toBeCloseTo(anchor.y, 10);
  expect(Number(line.getAttribute('x2'))).toBeCloseTo(fanned.x, 2);
  expect(Number(line.getAttribute('y2'))).toBeCloseTo(fanned.y, 2);
  await pointer('contextmenu', anchor.x, anchor.y, 2);
  expect(
    [...host.querySelectorAll('.plot-menu button')].filter((b) =>
      b.textContent?.startsWith('Select BQ'),
    ),
  ).toHaveLength(2);
});

it('uses absolute native pixel frequency while preserving the shelf gain origin and one-times delta', async () => {
  const channels = markerChannels();
  channels[0].filters[1] = { ...channels[0].filters[0], id: 'synthetic-drag-marker' };
  await act(async () => root.render(<MarkerHarness source={channels} />));
  const target = marker(1),
    start = coordinates(target);
  await pointer('pointerdown', start.x, start.y, 0, target);
  await pointer('pointermove', start.x, start.y, 0);
  // The observed338px axis point maps to this literal Single; zeroY
  // does not publish a gain field or reformat its captured model value.
  expect(changed.mock.lastCall?.[0]).toEqual({ frequency: 1496.235595703125 });
  await pointer('pointermove', start.x + 20, start.y, 0);
  const frequency = 2113.489013671875; // absolute358px, not an origin-frequency ratio
  expect(changed.mock.lastCall?.[0]).toEqual({ frequency });
  await pointer('pointermove', start.x + 20, start.y - 20, 0);
  expect(changed.mock.lastCall?.[0]).toEqual({ frequency, gain: 12 });
  await pointer('pointermove', start.x + 20, start.y - 20, 0);
  expect(changed.mock.lastCall?.[0]).toEqual({ frequency, gain: 12 });
  await pointer('pointerup', start.x + 20, start.y - 20, 0);
  expect(markerState[0].filters[0].gain).toBe(6);
  expect(markerState[0].filters[1]).toMatchObject({ frequency, gain: 12, enabled: false });
  expect(begin).toHaveBeenCalledTimes(1);
  expect(end).toHaveBeenCalledTimes(1);
  expect(end).toHaveBeenCalledWith();
});
