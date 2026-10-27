import type { Pt, Stroke } from "./types";

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const boundsCache = new WeakMap<Stroke, Bounds>();

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

export function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return distance(px, py, ax, ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = clamp(t, 0, 1);
  return distance(px, py, ax + t * dx, ay + t * dy);
}

export function pointInPolygon(x: number, y: number, polygon: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonBounds(points: Array<[number, number]>): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function strokeBounds(stroke: Stroke): Bounds {
  const cached = boundsCache.get(stroke);
  if (cached) return cached;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of stroke.points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) minX = minY = maxX = maxY = 0;
  const pad = stroke.size / 2 + 5;
  const b = { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
  boundsCache.set(stroke, b);
  return b;
}

export function invalidateStrokeBounds(stroke: Stroke): void {
  boundsCache.delete(stroke);
}

export function boundsContain(b: Bounds, x: number, y: number): boolean {
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
}

export function strokeHit(stroke: Stroke, x: number, y: number, tolerance: number): boolean {
  const b = strokeBounds(stroke);
  if (!boundsContain(b, x, y)) return false;
  if (stroke.tool === "shape") return true;
  const pts = stroke.points;
  if (pts.length === 0) return false;
  const reach = tolerance + stroke.size / 2;
  if (pts.length === 1) return distance(x, y, pts[0][0], pts[0][1]) <= reach;
  for (let i = 1; i < pts.length; i++) {
    if (pointSegmentDistance(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= reach) {
      return true;
    }
  }
  return false;
}

export function strokeInPolygon(stroke: Stroke, polygon: Array<[number, number]>): boolean {
  const pts = stroke.points;
  if (!pts.length) return false;
  let inside = 0;
  for (const [x, y] of pts) if (pointInPolygon(x, y, polygon)) inside++;
  if (inside / pts.length >= 0.55) return true;
  const b = strokeBounds(stroke);
  return pointInPolygon((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, polygon);
}

export function selectionBounds(strokes: Stroke[]): Bounds | null {
  if (!strokes.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of strokes) {
    const b = strokeBounds(s);
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  return { minX, minY, maxX, maxY };
}

export function translateStroke(stroke: Stroke, dx: number, dy: number): void {
  for (const p of stroke.points) {
    p[0] += dx;
    p[1] += dy;
  }
  invalidateStrokeBounds(stroke);
}

/**
 * 把一笔被橡皮擦到的部分切掉，返回剩下的若干段。
 * 先把长线段补密，避免荧光笔那种点很少的笔迹被整条删掉。
 */
export function splitStrokeByEraser(
  points: Pt[],
  x: number,
  y: number,
  radius: number
): Pt[][] {
  const step = Math.max(1, Math.min(3, radius / 3));
  const dense: Pt[] = [];
  for (let i = 0; i < points.length; i++) {
    dense.push([points[i][0], points[i][1], points[i][2]]);
    if (i >= points.length - 1) continue;
    const a = points[i];
    const b = points[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.floor(len / step);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      dense.push([
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
      ]);
    }
  }

  const out: Pt[][] = [];
  let cur: Pt[] = [];
  const r2 = radius * radius;
  for (const p of dense) {
    const dx = p[0] - x;
    const dy = p[1] - y;
    if (dx * dx + dy * dy <= r2) {
      if (cur.length >= 2) out.push(cur);
      cur = [];
    } else {
      cur.push([p[0], p[1], p[2]]);
    }
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}
