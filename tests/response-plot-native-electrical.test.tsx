// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import ResponsePlot from '../src/components/ResponsePlot';
import { newFilter, newProject } from '../src/domain/model';
import { defaultsHfdMeasurementOptions } from '../src/domain/hfd-measurement';
import { channelResponse } from '../src/domain/dsp';
import { defaultPlotRange } from '../src/domain/plot-viewport';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(['Magnitude', 'Phase', 'Group delay'] as const)(
  'draws bare %s with native frequency projection limited to Magnitude/Phase',
  async (mode) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    let clipped = false,
      points: number[][] = [];
    const strokes: number[][][] = [];
    const ctx = {
      scale() {},
      clearRect() {},
      fillText() {},
      measureText: () => ({ width: 5 }),
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
        if (clipped) strokes.push(points.slice());
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
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((kind: string) =>
      kind === '2d' ? ctx : null) as never);
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
    const c = newProject().presets[0].channels[0];
    c.hfdMeasurement = defaultsHfdMeasurementOptions();
    // Native M/P remain visible with stored Mute; Group delay is intentionally
    // tested unmuted so its nonzero cached derivative distinguishes the paths.
    c.muted = mode !== 'Group delay';
    c.filters[0] = {
      ...newFilter('peak'),
      frequency: 2300,
      q: 1.15,
      gain: 7.5,
      coefficients: { b0: 0.75, b1: 0.125, b2: 0.0625, f1: 0.25, f2: -0.125 },
    };
    const before = structuredClone(c),
      host = document.createElement('div'),
      root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <ResponsePlot
            channels={[c]}
            mode={mode}
            sum={false}
            measured={false}
            range={{
              ...defaultPlotRange(mode),
              frequencyMin: 1000,
              frequencyMax: 5000,
              dbMin: mode === 'Magnitude' ? -60 : -180,
              dbMax: mode === 'Magnitude' ? 20 : 180,
            }}
          />,
        ),
      );
      if (mode === 'Group delay') {
        // Group delay remains the existing cached browser extension. Compare a
        // nonzero derivative, so switching it to the new parameter curve fails.
        const f = 1000 * 5 ** (1 / 899),
          a = channelResponse(c, 1000),
          b = channelResponse(c, f),
          delay =
            (-(Math.atan2(b[1], b[0]) - Math.atan2(a[1], a[0])) / (2 * Math.PI * (f - 1000))) *
            1000;
        expect(Math.abs(delay)).toBeGreaterThan(0.00001);
        expect(strokes[0][1][1]).toBeCloseTo(24 + ((180 - delay) / 360) * 200, 8);
      } else {
        const value = mode === 'Magnitude' ? 2.6136991985395195 : 22.93321212711359;
        const expectedY =
          24 +
          (((mode === 'Magnitude' ? 20 : 180) - value) / (mode === 'Magnitude' ? 80 : 360)) * 200;
        expect(strokes[0][0][1]).toBeCloseTo(expectedY, 8);
      }
      expect(c).toEqual(before);
    } finally {
      await act(async () => root.unmount());
    }
  },
);
