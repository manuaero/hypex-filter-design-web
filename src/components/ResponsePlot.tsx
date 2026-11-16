'use client';
import type { PlotRange, PlotMode } from '../domain/plot-viewport';
export type { PlotMode } from '../domain/plot-viewport';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Channel, Preset } from '../domain/model';
import { channelResponse, presetResponse } from '../domain/dsp';
import { analyzeTimeResponses } from '../domain/time-analysis';
import { DEFAULT_TIME_RANGE, plotTimeSeries } from '../domain/time-series';
import { buildHfdResponseView } from '../domain/hfd-response-view';
import { prepareNativeElectricalView } from '../domain/native-electrical-view';
import { buildMagnitudeLayers, type MagnitudeLayers } from '../domain/plot-layers';
import type { PhaseViewState } from '../application/graph-view';
export const COLORS = ['#efb45d', '#58d6bb', '#a596f5'];
export default function ResponsePlot({
  channels,
  preset,
  mode,
  sum,
  measured,
  onFrequency,
  range,
  compact = false,
  referenceChannel = 0,
  nativeCentered = true,
  showUnloadedFilters = false,
  magnitudeLayers,
  selectedFilter,
  phaseLayers,
}: {
  channels: Channel[];
  preset?: Preset;
  mode: PlotMode;
  sum: boolean;
  measured: boolean;
  onFrequency?: (f: number) => void;
  range?: PlotRange;
  compact?: boolean;
  referenceChannel?: number;
  nativeCentered?: boolean;
  showUnloadedFilters?: boolean;
  magnitudeLayers?: MagnitudeLayers;
  selectedFilter?: number | null;
  phaseLayers?: PhaseViewState;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    overlay = useRef<HTMLCanvasElement>(null),
    [cursor, setCursor] = useState(''),
    [renderer, setRenderer] = useState('');
  const timed = mode === 'Impulse' || mode === 'Step';
  const showSum = mode === 'Phase' ? (phaseLayers?.sum ?? sum) : sum;
  const electricalData = useMemo(() => {
    if (mode !== 'Magnitude' && mode !== 'Phase') return { view: null, error: '' };
    try {
      return { view: prepareNativeElectricalView(channels, preset), error: '' };
    } catch (error) {
      return { view: null, error: String(error) };
    }
  }, [channels, preset, mode]);
  const magnitudeData = useMemo(() => {
    if (mode !== 'Magnitude' || !magnitudeLayers) return { view: null, error: '' };
    try {
      return {
        view: buildMagnitudeLayers(channels, {
          preset,
          layers: magnitudeLayers,
          referenceChannel,
          selectedFilter,
          sum,
          measured,
          centered: nativeCentered,
          showUnloadedFilters,
        }),
        error: '',
      };
    } catch (error) {
      return { view: null, error: String(error) };
    }
  }, [
    channels,
    preset,
    magnitudeLayers,
    referenceChannel,
    selectedFilter,
    sum,
    measured,
    nativeCentered,
    showUnloadedFilters,
    mode,
  ]);
  const nativeData = useMemo(() => {
    if (mode !== 'Magnitude' && mode !== 'Phase') return { view: null, error: '' };
    if (mode === 'Magnitude' && magnitudeLayers) return { view: null, error: '' };
    try {
      return {
        view: buildHfdResponseView(channels, {
          preset,
          measured,
          sum: showSum,
          referenceChannel,
          centered: nativeCentered,
          showUnloadedFilters,
        }),
        error: '',
      };
    } catch (error) {
      return { view: null, error: String(error) };
    }
  }, [
    channels,
    preset,
    measured,
    showSum,
    referenceChannel,
    nativeCentered,
    showUnloadedFilters,
    mode,
    magnitudeLayers,
  ]);
  const timeData = useMemo(() => {
    if (!timed) return { analysis: undefined, error: '' };
    try {
      return {
        analysis: analyzeTimeResponses(channels, { preset, measured, sum, referenceChannel }),
        error: '',
      };
    } catch (error) {
      return { analysis: undefined, error: String(error) };
    }
  }, [channels, preset, timed, measured, sum, referenceChannel]);
  const availableTimeCount = timeData.analysis?.channels.filter((c) => c.impulse).length ?? 0;
  const timeNotice =
    timeData.error ||
    (measured
      ? availableTimeCount === 0
        ? (timeData.analysis?.channels.find((c) => c.reason)?.reason ??
          'Load original impulse responses for the measured time view.')
        : `${availableTimeCount}/${channels.length} measured impulses${sum && !timeData.analysis?.sum?.impulse ? ` · Sum unavailable: ${timeData.analysis?.sum?.reason ?? ''}` : ''} · Raw crop; correction, smoothing and phase zero affect frequency plots`
      : 'Calculated electrical response · native time fixture comparison pending');
  const nativeContext =
    nativeData.view ??
    (channels.some((channel) => channel.hfdMeasurement) ? magnitudeData.view : null);
  useEffect(() => {
    const target = canvas.current,
      labels = overlay.current;
    if (!target || !labels) return;
    const draw = () => {
      const rect = target.getBoundingClientRect(),
        dpr = window.devicePixelRatio || 1,
        width = Math.round(rect.width * dpr),
        height = Math.round(rect.height * dpr);
      target.width = labels.width = width;
      target.height = labels.height = height;
      const ctx = labels.getContext('2d')!;
      ctx.scale(dpr, dpr);
      const W = rect.width,
        H = rect.height,
        L = compact ? 32 : 48,
        R = compact ? 12 : 20,
        T = compact ? 18 : 24,
        B = compact ? 24 : 38,
        pw = W - L - R,
        ph = H - T - B;
      ctx.clearRect(0, 0, W, H);
      ctx.font = `${compact ? 9 : 11}px ui-monospace, monospace`;
      ctx.strokeStyle = '#ffffff0e';
      ctx.fillStyle = '#718083';
      ctx.lineWidth = 1;
      const xMin = range?.frequencyMin ?? 10,
        xMax = range?.frequencyMax ?? 40000,
        ratio = xMax / xMin;
      const timeRange = range ?? DEFAULT_TIME_RANGE;
      const min =
          mode === 'Magnitude'
            ? (range?.dbMin ?? -60)
            : mode === 'Phase'
              ? (range?.dbMin ?? -180)
              : mode === 'Group delay'
                ? (range?.dbMin ?? -5)
                : timeRange.amplitudeMin,
        max =
          mode === 'Magnitude'
            ? (range?.dbMax ?? 20)
            : mode === 'Phase'
              ? (range?.dbMax ?? 180)
              : mode === 'Group delay'
                ? (range?.dbMax ?? 25)
                : timeRange.amplitudeMax;
      const ySteps = ph >= 168 ? 8 : ph >= 80 ? 4 : 2;
      for (let i = 0; i <= ySteps; i++) {
        const y = T + (ph * i) / ySteps;
        ctx.beginPath();
        ctx.moveTo(L, y);
        ctx.lineTo(W - R, y);
        ctx.stroke();
        const value = max - ((max - min) * i) / ySteps;
        ctx.fillText(timed ? +value.toPrecision(3) + '' : value.toFixed(0), 4, y + 4);
      }
      const freqs = [
        1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 40000, 50000,
      ];
      let lastLabelRight = -Infinity;
      for (const f of freqs) {
        if (timed || f < xMin || f > xMax) continue;
        const x = L + (Math.log10(f / xMin) / Math.log10(ratio)) * pw;
        ctx.beginPath();
        ctx.moveTo(x, T);
        ctx.lineTo(x, H - B);
        ctx.stroke();
        const label = f >= 1000 ? `${f / 1000}k` : String(f),
          textWidth = ctx.measureText(label).width,
          left = x - textWidth / 2;
        if (!timed && left > lastLabelRight + 8) {
          ctx.fillText(label, left, H - 7);
          lastLabelRight = left + textWidth;
        }
      }
      if (timed) {
        const ticks = compact || pw < 500 ? 4 : 8;
        for (let i = 0; i <= ticks; i++) {
          const x = L + (pw * i) / ticks;
          ctx.beginPath();
          ctx.moveTo(x, T);
          ctx.lineTo(x, H - B);
          ctx.stroke();
          const t = timeRange.timeMinMs + (i / ticks) * (timeRange.timeMaxMs - timeRange.timeMinMs);
          const label = +t.toFixed(3) + '';
          ctx.fillText(label, x - ctx.measureText(label).width / 2, H - 13);
        }
      }
      ctx.fillStyle = '#899896';
      ctx.fillText(
        timed
          ? 'amplitude · ms'
          : mode === 'Magnitude'
            ? nativeContext?.centered
              ? 'HFD relative dB · Hz'
              : 'dB · Hz'
            : mode === 'Phase'
              ? 'degrees · Hz'
              : 'ms · Hz',
        L,
        14,
      );
      const curves: { points: number[]; color: string; width?: number }[] = [];
      try {
        if (magnitudeData.error) throw new Error(magnitudeData.error);
        if (nativeData.error) throw new Error(nativeData.error);
        if (magnitudeData.view) {
          const view = magnitudeData.view;
          view.curves.forEach((curve) =>
            curves.push({
              color: curve.color,
              width: curve.width,
              points: view.frequency.flatMap((f, i) => [
                L + (Math.log(f / xMin) / Math.log(ratio)) * pw,
                T + ((max - curve.db[i]) / (max - min)) * ph,
              ]),
            }),
          );
        } else if (nativeData.view && (mode === 'Magnitude' || mode === 'Phase')) {
          const view = nativeData.view;
          const add = (curve: (typeof view.channels)[number] | undefined, color: string) => {
            if (!curve || curve.visible === false) return;
            const values = mode === 'Phase' ? curve.phase : curve.db;
            curves.push({
              color,
              points: view.frequency.flatMap((f, i) => [
                L + (Math.log(f / xMin) / Math.log(ratio)) * pw,
                T + ((max - values[i]) / (max - min)) * ph,
              ]),
            });
          };
          view.channels.forEach((curve, index) => {
            if (mode !== 'Phase' || !phaseLayers || phaseLayers.channels[index])
              add(curve, COLORS[index % COLORS.length]);
          });
          if (showSum) add(view.sum, '#e9eddf');
        } else if (timed) {
          if (timeData.error) throw new Error(timeData.error);
          const analysis = timeData.analysis;
          const add = (
            curve: NonNullable<typeof analysis>['channels'][number] | undefined,
            color: string,
          ) => {
            const series = mode === 'Step' ? curve?.step : curve?.impulse;
            if (!series) return;
            const points = plotTimeSeries(
              series,
              timeRange,
              Math.max(1, Math.min(16384, Math.ceil(pw))),
            ).flatMap(({ timeMs, value }) => [
              L +
                ((timeMs - timeRange.timeMinMs) / (timeRange.timeMaxMs - timeRange.timeMinMs)) * pw,
              T + ((max - value) / (max - min)) * ph,
            ]);
            curves.push({ points, color });
          };
          analysis?.channels.forEach((curve, index) => add(curve, COLORS[index % COLORS.length]));
          if (sum) add(analysis?.sum, '#e9eddf');
        } else {
          if (electricalData.error) throw new Error(electricalData.error);
          const N = 900;
          const evaluate = (index: number, frequency: number): [number, number] =>
            electricalData.view
              ? electricalData.view.evaluate(index, frequency, measured)
              : preset
                ? presetResponse(preset, index, frequency, measured)
                : channelResponse(channels[index], frequency, measured);
          const makeCurve = (evaluate: (frequency: number) => [number, number]) => {
            let lastPhase = 0;
            const curve: number[] = [];
            for (let n = 0; n < N; n++) {
              const frequency = xMin * ratio ** (n / (N - 1)),
                [re, im] = evaluate(frequency),
                phase = Math.atan2(im, re);
              let value =
                mode === 'Magnitude'
                  ? 20 * Math.log10(Math.max(1e-12, Math.hypot(re, im)))
                  : mode === 'Phase'
                    ? (phase * 180) / Math.PI
                    : 0;
              if (mode === 'Group delay' && n > 0) {
                let diff = phase - lastPhase;
                while (diff > Math.PI) diff -= 2 * Math.PI;
                while (diff < -Math.PI) diff += 2 * Math.PI;
                value =
                  (-diff / (2 * Math.PI * (frequency - xMin * ratio ** ((n - 1) / (N - 1))))) *
                  1000;
              }
              lastPhase = phase;
              curve.push(L + (n / (N - 1)) * pw, T + ((max - value) / (max - min)) * ph);
            }
            return curve;
          };
          channels.forEach((ch, index) => {
            if (mode === 'Phase' && phaseLayers && !phaseLayers.channels[index]) return;
            curves.push({
              color: COLORS[index % COLORS.length],
              points: makeCurve((f) => evaluate(index, f)),
            });
          });
          if (showSum)
            curves.push({
              color: '#e9eddf',
              points: makeCurve((f) =>
                channels.reduce<[number, number]>(
                  ([a, b], ch, index) => {
                    if (
                      ch.includeInSum === false ||
                      (measured && !ch.measurement?.frequency?.length)
                    )
                      return [a, b];
                    const [r, i] = evaluate(index, f);
                    return [a + r, b + i];
                  },
                  [0, 0],
                ),
              ),
            });
        }
      } catch (e) {
        ctx.fillStyle = '#efb45d';
        ctx.fillText(String(e), L + 20, T + 25);
      }
      const gl = target.getContext('webgl2', { alpha: true, antialias: true });
      if (gl) {
        setRenderer('WebGL 2');
        const shader = (type: number, source: string) => {
          const s = gl.createShader(type)!;
          gl.shaderSource(s, source);
          gl.compileShader(s);
          return s;
        };
        const v = shader(
            gl.VERTEX_SHADER,
            '#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.,1.);}',
          ),
          f = shader(
            gl.FRAGMENT_SHADER,
            '#version 300 es\nprecision highp float;uniform vec3 color;out vec4 outputColor;void main(){outputColor=vec4(color,1.);}',
          ),
          program = gl.createProgram()!;
        gl.attachShader(program, v);
        gl.attachShader(program, f);
        gl.linkProgram(program);
        gl.useProgram(program);
        gl.viewport(0, 0, width, height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        const position = gl.getAttribLocation(program, 'p');
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(L * dpr, B * dpr, pw * dpr, ph * dpr);
        curves.forEach(({ points: curve, color, width: lineWidth }) => {
          gl.lineWidth((lineWidth ?? 1.5) * dpr);
          const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
          gl.uniform3fv(gl.getUniformLocation(program, 'color'), rgb);
          gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array(curve.map((x, i) => (i % 2 ? 1 - (x / H) * 2 : (x / W) * 2 - 1))),
            gl.STATIC_DRAW,
          );
          gl.drawArrays(gl.LINE_STRIP, 0, curve.length / 2);
        });
        gl.disable(gl.SCISSOR_TEST);
        gl.deleteBuffer(buffer);
        gl.deleteProgram(program);
        gl.deleteShader(v);
        gl.deleteShader(f);
      } else {
        setRenderer('Canvas');
        ctx.save();
        ctx.beginPath();
        ctx.rect(L, T, pw, ph);
        ctx.clip();
        curves.forEach(({ points: curve, color, width: lineWidth }) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = lineWidth ?? 1.5;
          ctx.beginPath();
          for (let n = 0; n < curve.length; n += 2) {
            if (n === 0) ctx.moveTo(curve[n], curve[n + 1]);
            else ctx.lineTo(curve[n], curve[n + 1]);
          }
          ctx.stroke();
        });
        ctx.restore();
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(target);
    return () => observer.disconnect();
  }, [
    channels,
    preset,
    mode,
    sum,
    showSum,
    phaseLayers,
    measured,
    range,
    compact,
    timed,
    timeData,
    nativeData,
    magnitudeData,
    electricalData,
  ]);
  return (
    <div
      className="plot"
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect(),
          x = Math.max(0, Math.min(1, (e.clientX - r.left - 48) / (r.width - 68))),
          f =
            (range?.frequencyMin ?? 10) *
            ((range?.frequencyMax ?? 40000) / (range?.frequencyMin ?? 10)) ** x;
        setCursor(
          timed
            ? `${((range?.timeMinMs ?? DEFAULT_TIME_RANGE.timeMinMs) + x * ((range?.timeMaxMs ?? DEFAULT_TIME_RANGE.timeMaxMs) - (range?.timeMinMs ?? DEFAULT_TIME_RANGE.timeMinMs))).toFixed(3)} ms`
            : `${f.toFixed(f < 100 ? 1 : 0)} Hz`,
        );
      }}
      onDoubleClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        if (timed) return;
        onFrequency?.(
          (range?.frequencyMin ?? 10) *
            ((range?.frequencyMax ?? 40000) / (range?.frequencyMin ?? 10)) **
              ((e.clientX - r.left - 48) / (r.width - 68)),
        );
      }}
    >
      <canvas
        ref={canvas}
        role="img"
        aria-label={`${mode} response graph`}
        aria-description={
          timed ? timeNotice : magnitudeData.view?.curves.map((curve) => curve.label).join('; ')
        }
      />
      <canvas ref={overlay} />
      <span className="plot-cursor">{cursor}</span>
      {timed && (
        <span className="plot-analysis-note" role="status">
          {timeNotice}
        </span>
      )}
      {nativeContext && (
        <span className="plot-native-context" role="status">
          {mode === 'Phase'
            ? 'Independent phase crop · unit-phasor sum · Gaussian display'
            : nativeContext.centered
              ? `Common display offset ${nativeContext.centerOffsetDb.toFixed(2)} dB · Gaussian display`
              : 'Absolute magnitude · Gaussian display'}
          {nativeContext.warnings.some((w) => /extreme/i.test(w))
            ? ' · Extreme centering; choose absolute dB'
            : nativeContext.warnings.length
              ? ' · Analysis warning'
              : ''}
        </span>
      )}
      <span className="plot-renderer">{renderer}</span>
    </div>
  );
}
