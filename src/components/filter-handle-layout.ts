export interface FilterHandleAnchor {
  index: number;
  x: number;
  y: number;
}
export interface FilterHandleBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
export interface FilterHandlePosition extends FilterHandleAnchor {
  anchorX: number;
  anchorY: number;
}
const SPACING = 24;
const SPACING_SQUARED = SPACING * SPACING;
const EPSILON = 1e-7;
const distanceSquared = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Spread crowded graph controls without changing their electrical anchors.
 * Selection is deliberately absent: inspecting a section never moves its handle.
 * Isolated anchors reserve their original positions before crowded groups fan out.
 */
export function layoutFilterHandles(
  anchors: readonly FilterHandleAnchor[],
  bounds: FilterHandleBounds,
): FilterHandlePosition[] {
  if (
    !Object.values(bounds).every(Number.isFinite) ||
    bounds.left > bounds.right ||
    bounds.top > bounds.bottom
  )
    throw new Error('Invalid filter handle bounds');
  if (
    anchors.some((p) => !Number.isFinite(p.index) || !Number.isFinite(p.x) || !Number.isFinite(p.y))
  )
    throw new Error('Filter handle anchors must be finite');
  const points = anchors.map((p, order) => ({
    ...p,
    order,
    anchorX: p.x,
    anchorY: p.y,
    x: clamp(p.x, bounds.left, bounds.right),
    y: clamp(p.y, bounds.top, bounds.bottom),
  }));
  const placed: FilterHandlePosition[] = [];
  const result = new Map<number, FilterHandlePosition>();
  const ordered = [...points].sort(
    (a, b) =>
      a.index - b.index || a.anchorX - b.anchorX || a.anchorY - b.anchorY || a.order - b.order,
  );
  const place = (p: (typeof points)[number], q: { x: number; y: number }) => {
    const value = { index: p.index, x: q.x, y: q.y, anchorX: p.anchorX, anchorY: p.anchorY };
    result.set(p.order, value);
    placed.push(value);
  };
  const isolated = new Set(
    points
      .filter(
        (p) => !points.some((q) => q !== p && distanceSquared(p, q) < SPACING_SQUARED - EPSILON),
      )
      .map((p) => p.order),
  );
  for (const p of ordered) if (isolated.has(p.order)) place(p, p);
  for (const p of ordered) {
    if (isolated.has(p.order)) continue;
    const candidates: { x: number; y: number }[] = [],
      seen = new Set<string>();
    const add = (x: number, y: number) => {
      x = clamp(x, bounds.left, bounds.right);
      y = clamp(y, bounds.top, bounds.bottom);
      const key = `${x},${y}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push({ x, y });
      }
    };
    const extent = Math.max(1, anchors.length);
    for (let dx = -extent; dx <= extent; dx++)
      for (let dy = -extent; dy <= extent; dy++) add(p.x + dx * SPACING, p.y + dy * SPACING);
    const preference = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      distanceSquared(a, p) - distanceSquared(b, p) ||
      Math.abs(a.x - p.x) - Math.abs(b.x - p.x) ||
      Number(a.y < p.y) - Number(b.y < p.y) ||
      Number(a.x < p.x) - Number(b.x < p.x) ||
      a.y - b.y ||
      a.x - b.x;
    candidates.sort(preference);
    const clearance = (q: { x: number; y: number }) =>
      placed.reduce((nearest, r) => Math.min(nearest, distanceSquared(q, r)), Infinity);
    let target = candidates.find((q) => clearance(q) >= SPACING_SQUARED - EPSILON);
    if (!target) {
      // A second grid helps anchors from neighboring clusters use free gaps.
      const xs = [bounds.left, bounds.right, ...placed.map((q) => q.x)].sort((a, b) => a - b);
      const ys = [bounds.top, bounds.bottom, ...placed.map((q) => q.y)].sort((a, b) => a - b);
      const xMid = xs.slice(1).map((x, i) => (x + xs[i]) / 2),
        yMid = ys.slice(1).map((y, i) => (y + ys[i]) / 2);
      for (const x of [...xs, ...xMid]) for (const y of [...ys, ...yMid]) add(x, y);
      candidates.sort(preference);
      target = candidates.find((q) => clearance(q) >= SPACING_SQUARED - EPSILON);
      // Tiny plots cannot hold every control at 24px. Stay bounded and choose
      // the largest available clearance, then the shortest/vertical-first move.
      target ??= [...candidates].sort((a, b) => clearance(b) - clearance(a) || preference(a, b))[0];
    }
    place(p, target ?? p);
  }
  return points.map((p) => result.get(p.order)!);
}
