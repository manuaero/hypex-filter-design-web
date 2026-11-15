import { expect, it } from 'vitest';
import {
  layoutFilterHandles,
  type FilterHandlePosition,
} from '../src/components/filter-handle-layout';
const bounds = { left: 0, right: 160, top: 0, bottom: 100 };
function separated(points: FilterHandlePosition[]) {
  for (let i = 0; i < points.length; i++) {
    expect(points[i].x).toBeGreaterThanOrEqual(bounds.left);
    expect(points[i].x).toBeLessThanOrEqual(bounds.right);
    expect(points[i].y).toBeGreaterThanOrEqual(bounds.top);
    expect(points[i].y).toBeLessThanOrEqual(bounds.bottom);
    for (let j = i + 1; j < points.length; j++)
      expect(
        Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y),
      ).toBeGreaterThanOrEqual(24 - 1e-7);
  }
}
it('fans fifteen coincident anchors deterministically while preserving their leader-line anchors', () => {
  const anchors = Array.from({ length: 15 }, (_, index) => ({ index, x: 80, y: 50 })),
    before = structuredClone(anchors);
  const positions = layoutFilterHandles(anchors, bounds);
  separated(positions);
  expect(anchors).toEqual(before);
  expect(positions.every((p) => p.anchorX === 80 && p.anchorY === 50)).toBe(true);
  expect(positions[0]).toMatchObject({ x: 80, y: 50 });
  expect(positions[1]).toMatchObject({ x: 80, y: 74 });
  expect(layoutFilterHandles(anchors, bounds)).toEqual(positions);
  expect(
    layoutFilterHandles([...anchors].reverse(), bounds).sort((a, b) => a.index - b.index),
  ).toEqual(positions);
});
it.each([
  [0, 0],
  [160, 0],
  [0, 100],
  [160, 100],
])('keeps fifteen corner controls separated and within bounds at %s,%s', (x, y) => {
  separated(
    layoutFilterHandles(
      Array.from({ length: 15 }, (_, index) => ({ index, x, y })),
      bounds,
    ),
  );
});
it('reserves isolated anchors so a nearby crowded group cannot displace them', () => {
  const anchors = [
    { index: 0, x: 50, y: 50 },
    { index: 1, x: 50, y: 50 },
    { index: 2, x: 50, y: 80 },
    { index: 3, x: 140, y: 10 },
  ];
  const positions = layoutFilterHandles(anchors, bounds);
  separated(positions);
  expect(positions[2]).toMatchObject({ x: 50, y: 80 });
  expect(positions[3]).toMatchObject({ x: 140, y: 10 });
});
it('separates neighboring clusters without moving their input anchors', () => {
  const anchors = [
    ...Array.from({ length: 7 }, (_, index) => ({ index, x: 55, y: 45 })),
    ...Array.from({ length: 7 }, (_, i) => ({ index: i + 7, x: 92, y: 54 })),
    { index: 14, x: 150, y: 5 },
  ];
  const positions = layoutFilterHandles(anchors, bounds);
  separated(positions);
  expect(positions.map((p) => ({ index: p.index, x: p.anchorX, y: p.anchorY }))).toEqual(anchors);
});
it('leaves already-separated controls exactly at their anchors', () => {
  const anchors = [
    { index: 8, x: 12, y: 9 },
    { index: 2, x: 80, y: 50 },
    { index: 5, x: 150, y: 92 },
  ];
  expect(layoutFilterHandles(anchors, bounds)).toEqual(
    anchors.map((p) => ({ ...p, anchorX: p.x, anchorY: p.y })),
  );
});
it('uses bounded best-effort positions when spacing is geometrically impossible', () => {
  const tiny = { left: 4, right: 14, top: 3, bottom: 8 };
  const anchors = Array.from({ length: 15 }, (_, index) => ({ index, x: 9, y: 5 }));
  const positions = layoutFilterHandles(anchors, tiny);
  expect(positions).toHaveLength(15);
  expect(positions.every((p) => p.x >= 4 && p.x <= 14 && p.y >= 3 && p.y <= 8)).toBe(true);
  expect(new Set(positions.map((p) => `${p.x},${p.y}`)).size).toBeGreaterThan(4);
  expect(layoutFilterHandles(anchors, tiny)).toEqual(positions);
});
