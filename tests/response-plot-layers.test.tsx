// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ResponsePlot from '../src/components/ResponsePlot';
import { newFilter, newProject, unity } from '../src/domain/model';
import { channelResponse } from '../src/domain/dsp';
import { defaultMagnitudeLayers, selectedSectionAnalysisChannel } from '../src/domain/plot-layers';
import { defaultPlotRange } from '../src/domain/plot-viewport';

let host: HTMLDivElement, root: Root;
const strokes: { color: unknown; width: number; points: number[][] }[] = [];
let points: number[][] = [],
  clipped = false;
const context = {
  strokeStyle: '',
  fillStyle: '',
  lineWidth: 1,
  font: '',
  scale() {},
  clearRect() {
    strokes.length = 0;
    clipped = false;
  },
  fillText() {},
  measureText(text: string) {
    return { width: text.length * 6 };
  },
  beginPath() {
    points = [];
  },
  moveTo(x: number, y: number) {
    points.push([x, y]);
  },
  lineTo(x: number, y: number) {
    points.push([x, y]);
  },
  stroke() {
    if (clipped)
      strokes.push({
        color: this.strokeStyle,
        width: this.lineWidth,
        points: points.map((p) => p.slice()),
      });
  },
  save() {},
  rect() {},
  clip() {
    clipped = true;
  },
  restore() {
    clipped = false;
  },
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((kind: string) =>
    kind === '2d' ? context : null) as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 468,
    height: 262,
    right: 468,
    bottom: 262,
    x: 0,
    y: 0,
    toJSON() {},
  });
  strokes.length = 0;
  points = [];
  clipped = false;
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

it('actual selected-section Magnitude/Phase preview is unbypassed while the source signal chain stays bypassed', async () => {
  const source = newProject().presets[0].channels[0];
  source.filters[0] = {
    ...newFilter('lowpass2'),
    frequency: 500,
    enabled: false,
    coefficients: unity(),
  };
  const before = structuredClone(source),
    channel = selectedSectionAnalysisChannel(source, source.filters[0], 0);
  await act(async () =>
    root.render(
      <ResponsePlot channels={[channel]} mode="Magnitude" sum={false} measured={false} compact />,
    ),
  );
  expect(strokes).toHaveLength(1);
  const magnitude = strokes[0].points;
  expect(
    Math.max(...magnitude.map((point) => point[1])) -
      Math.min(...magnitude.map((point) => point[1])),
  ).toBeGreaterThan(30);
  await act(async () =>
    root.render(
      <ResponsePlot channels={[channel]} mode="Phase" sum={false} measured={false} compact />,
    ),
  );
  expect(strokes).toHaveLength(1);
  const phase = strokes[0].points;
  expect(
    Math.max(...phase.map((point) => point[1])) - Math.min(...phase.map((point) => point[1])),
  ).toBeGreaterThan(30);
  expect(channelResponse(source, 5000)).toEqual([1, 0]);
  expect(source).toEqual(before);
});

it('actual main plot renders explicit independent layer data and describes only visible measurement overlays', async () => {
  const preset = newProject().presets[0],
    layers = defaultMagnitudeLayers();
  for (let c = 0; c < 2; c++)
    preset.channels[c].measurement = {
      name: `ch${c}.frd`,
      sampleRate: 48000,
      frequency: [10, 1000, 40000],
      magnitude: [0, -3, 0],
      phase: [0, 0, 0],
    };
  const render = () =>
    root.render(
      <ResponsePlot
        channels={preset.channels}
        preset={preset}
        mode="Magnitude"
        sum
        measured
        magnitudeLayers={layers}
        selectedFilter={null}
      />,
    );
  await act(async () => render());
  expect(strokes).toHaveLength(3);
  expect(host.querySelector('[role="img"]')!.getAttribute('aria-description')).toBe(
    'Current filtered result; Selected channel sum; Electrical cascade',
  );
  const previousResult = strokes.find((stroke) => stroke.color === '#efb45d')!.points;
  // A new immutable view-state object mirrors the parent's normal React update.
  await act(async () =>
    root.render(
      <ResponsePlot
        channels={preset.channels}
        preset={preset}
        mode="Magnitude"
        sum
        measured
        magnitudeLayers={{ ...layers, rawMeasurements: [false, true, true] }}
        selectedFilter={null}
      />,
    ),
  );
  expect(strokes).toHaveLength(4);
  expect(host.querySelector('[role="img"]')!.getAttribute('aria-description')).toContain(
    `${preset.channels[1].name} measured`,
  );
  expect(host.querySelector('[role="img"]')!.getAttribute('aria-description')).not.toContain(
    `${preset.channels[2].name} measured`,
  );
  expect(strokes.find((stroke) => stroke.color === '#efb45d')!.points).toEqual(previousResult);
});

it('unresolved first free cache is unavailable explicitly rather than rendering a guessed isolated preview', () => {
  const channel = newProject().presets[0].channels[0];
  channel.coefficientCache = 'unresolved';
  channel.filters[0] = { ...newFilter('raw'), coefficients: unity() };
  expect(() => selectedSectionAnalysisChannel(channel, channel.filters[0], 0)).toThrow(/Resolve/);
  expect(strokes).toHaveLength(0);
});

it('actual main plot renders distinct other output results and independently hides the current result', async () => {
  const preset = newProject().presets[0],
    layers = { ...defaultMagnitudeLayers(), section: false, otherResults: true };
  preset.channels[1].gain = -12;
  preset.channels[2].gain = -24;
  const render = (currentResult: boolean) =>
    root.render(
      <ResponsePlot
        channels={preset.channels}
        preset={preset}
        mode="Magnitude"
        sum={false}
        measured={false}
        referenceChannel={1}
        magnitudeLayers={{ ...layers, currentResult }}
      />,
    );
  await act(async () => render(true));
  expect(strokes.map((stroke) => stroke.color)).toEqual(['#efb45d', '#58d6bb', '#a596f5']);
  expect(strokes[0].points[20][1]).toBeLessThan(strokes[1].points[20][1]);
  expect(strokes[1].points[20][1]).toBeLessThan(strokes[2].points[20][1]);
  const others = [strokes[0].points, strokes[2].points];
  await act(async () => render(false));
  expect(strokes.map((stroke) => stroke.color)).toEqual(['#efb45d', '#a596f5']);
  expect(strokes.map((stroke) => stroke.points)).toEqual(others);
  expect(host.querySelector('[role="img"]')?.getAttribute('aria-description')).not.toContain(
    'Current electrical result',
  );
});

it.each(['Phase', 'Group delay'] as const)(
  'actual %s renderer honors its own numeric Y viewport',
  async (mode) => {
    const channel = newProject().presets[0].channels[0];
    channel.filters[0] = { ...newFilter('lowpass1'), frequency: 500 };
    const original = defaultPlotRange(mode),
      zoomed = {
        ...original,
        dbMin: mode === 'Phase' ? -90 : -1,
        dbMax: mode === 'Phase' ? 90 : 1,
      };
    const render = (range: typeof original) =>
      root.render(
        <ResponsePlot
          channels={[channel]}
          mode={mode}
          measured={false}
          sum={false}
          range={range}
        />,
      );
    await act(async () => render(original));
    const span = (p: number[][]) =>
      Math.max(...p.map((point) => point[1])) - Math.min(...p.map((point) => point[1]));
    const oldSpan = span(strokes[0].points);
    await act(async () => render(zoomed));
    expect(span(strokes[0].points) / oldSpan).toBeCloseTo(mode === 'Phase' ? 2 : 15, 8);
  },
);
