// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ResponsePlot from '../src/components/ResponsePlot';
import { newProject, type Channel } from '../src/domain/model';
import { defaultsHfdMeasurementOptions } from '../src/domain/hfd-measurement';
import { buildHfdResponseView } from '../src/domain/hfd-response-view';
import type { PhaseViewState } from '../src/application/graph-view';

let host: HTMLDivElement, root: Root;
let clipped = false,
  points: number[][] = [];
const strokes: { color: string; points: number[][] }[] = [];
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
    if (clipped) strokes.push({ color: this.strokeStyle, points: points.map((p) => p.slice()) });
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
function source(channel: Channel, db: number, dedicated: number) {
  const frequency = Array.from(
    { length: 1024 },
    (_, i) => 10 * Math.exp((Math.log(46875 / 10) * i) / 1024),
  );
  channel.hfdMeasurement = { ...defaultsHfdMeasurementOptions(), smoothPostBw: 0.0001 };
  // Synthetic pre-plot caches isolate renderer composition from independently
  // tested FFT generation; actual GUI uses this dedicated unit-phase source.
  channel.measurement = {
    name: 'Synthetic phase cache',
    sampleRate: 48000,
    impulse: [1, 0],
    frequency,
    magnitude: frequency.map(() => db),
    phase: frequency.map(() => 0),
    hfdMagnitude: {
      frequency: frequency.slice(),
      linearMagnitude: frequency.map(() => 10 ** (db / 20)),
      medianDb: db,
    },
    hfdPhase: { frequency: frequency.slice(), phase: frequency.map(() => dedicated) },
  };
}
function fixture() {
  const preset = newProject().presets[0];
  source(preset.channels[0], 0, 0);
  source(preset.channels[1], -60, 90);
  return preset;
}
const sumStroke = () => strokes.find((stroke) => stroke.color === '#f1ede6')!;

it('hides phase curves independently while the native sum retains all canonical UseInSum sources with unit measurement amplitude', async () => {
  const preset = fixture(),
    before = structuredClone(preset);
  const render = (phaseLayers: PhaseViewState, sum = false) =>
    root.render(
      <ResponsePlot
        channels={preset.channels}
        preset={preset}
        mode="Phase"
        measured
        sum={sum}
        phaseLayers={phaseLayers}
      />,
    );
  await act(async () => render({ channels: [true, false, false], sum: true }));
  expect(strokes.map((stroke) => stroke.color)).toEqual(['#efb162', '#f1ede6']);
  // atan2(1,1)=+45deg: the hidden -60dB driver's phase still contributes equally.
  // With top180/bottom-180 and plot height200 this lies at y24+75=99px.
  expect(sumStroke().points[500][1]).toBeCloseTo(99, 10);
  const sum = sumStroke().points;
  await act(async () => render({ channels: [false, true, false], sum: true }));
  expect(strokes.map((stroke) => stroke.color)).toEqual(['#9cc6d1', '#f1ede6']);
  expect(sumStroke().points).toEqual(sum);
  expect(preset).toEqual(before);
});
it('phase sum visibility overrides the magnitude/time sum flag in both directions', async () => {
  const preset = fixture();
  const render = (globalSum: boolean, phaseSum: boolean) =>
    root.render(
      <ResponsePlot
        channels={preset.channels}
        mode="Phase"
        measured
        sum={globalSum}
        phaseLayers={{ channels: [false, true, false], sum: phaseSum }}
      />,
    );
  await act(async () => render(true, false));
  expect(strokes.map((stroke) => stroke.color)).toEqual(['#9cc6d1']);
  await act(async () => render(false, true));
  expect(strokes.map((stroke) => stroke.color)).toEqual(['#9cc6d1', '#f1ede6']);
});
it('uses canonical inclusion rather than visibility for the recovered phase sum', async () => {
  const preset = fixture();
  preset.channels[1].includeInSum = false;
  const before = structuredClone(preset);
  const native = buildHfdResponseView(preset.channels, { measured: true, sum: true })!;
  expect(native.sum!.phase[500]).toBeCloseTo(0, 12);
  await act(async () =>
    root.render(
      <ResponsePlot
        channels={preset.channels}
        preset={preset}
        mode="Phase"
        measured
        sum={false}
        phaseLayers={{ channels: [false, true, false], sum: true }}
      />,
    ),
  );
  expect(strokes.map((stroke) => stroke.color)).toEqual(['#9cc6d1', '#f1ede6']);
  expect(sumStroke().points[500][1]).toBeCloseTo(124, 10);
  expect(preset).toEqual(before);
});
it('keeps unavailable checked native curves hidden and never applies phase masks to Magnitude', async () => {
  const preset = fixture();
  await act(async () =>
    root.render(
      <ResponsePlot
        channels={preset.channels}
        mode="Phase"
        measured
        sum={false}
        phaseLayers={{ channels: [false, false, true], sum: false }}
      />,
    ),
  );
  expect(strokes).toHaveLength(0);
  await act(async () =>
    root.render(
      <ResponsePlot
        channels={preset.channels}
        mode="Magnitude"
        measured={false}
        sum={false}
        phaseLayers={{ channels: [false, false, false], sum: true }}
      />,
    ),
  );
  expect(strokes.map((stroke) => stroke.color)).toEqual(['#efb162', '#9cc6d1', '#b3a3d6']);
});
it('supports independent electrical phase rendering and retains the legacy renderer when no phase state is supplied', async () => {
  const preset = newProject().presets[0];
  await act(async () =>
    root.render(
      <ResponsePlot
        channels={preset.channels}
        mode="Phase"
        measured={false}
        sum={false}
        phaseLayers={{ channels: [false, true, false], sum: false }}
      />,
    ),
  );
  expect(strokes.map((stroke) => stroke.color)).toEqual(['#9cc6d1']);
  await act(async () =>
    root.render(
      <ResponsePlot channels={preset.channels} mode="Phase" measured={false} sum={false} />,
    ),
  );
  expect(strokes.map((stroke) => stroke.color)).toEqual(['#efb162', '#9cc6d1', '#b3a3d6']);
});
