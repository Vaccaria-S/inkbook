import { getStroke } from "perfect-freehand";
import type { Pt, Stroke } from "./types";

const pathCache = new WeakMap<Stroke, Path2D>();

export function invalidateStroke(stroke: Stroke): void {
  pathCache.delete(stroke);
}

/** 平滑过渡，t 从 0 到 1 */
function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/**
 * 入锋/出锋包络：沿弧长把压力做成"轻→重→轻"。
 *
 * 真笔迹一定是两头细、中间粗；只有设备压力（数位笔）时靠压力曲线，
 * 鼠标没有压力，就用这个包络补上，笔画立刻有"写"的味道。
 */
function envelopePressures(points: Pt[], size: number): Pt[] {
  const n = points.length;
  if (n < 4) return points.map((p) => [p[0], p[1], p[2]]);

  const taper = Math.min(48, Math.max(9, size * 4.2));
  const d: number[] = [0];
  for (let i = 1; i < n; i++) {
    d.push(d[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  const total = d[n - 1];
  // 笔画太短就不过包络，不然整条都没了
  if (total < taper * 1.4) return points.map((p) => [p[0], p[1], p[2]]);

  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const head = smoothstep(d[i] / taper);
    const tail = smoothstep((total - d[i]) / taper);
    const env = Math.min(head, tail);
    out.push([points[i][0], points[i][1], points[i][2] * (0.3 + 0.7 * env)]);
  }
  return out;
}

function smoothPressures(points: Pt[]): number[][] {
  const n = points.length;
  const raw = points.map((p) => Math.max(0.06, Math.min(1, p[2])));
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let weight = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      const w = 3 - Math.abs(k);
      sum += raw[j] * w;
      weight += w;
    }
    out.push([points[i][0], points[i][1], sum / weight]);
  }
  return out;
}

function outlineToPath(outline: number[][]): Path2D {
  const path = new Path2D();
  if (outline.length < 2) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length - 1; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[i + 1];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  const last = outline[outline.length - 1];
  path.lineTo(last[0], last[1]);
  path.closePath();
  return path;
}

function buildInkPath(stroke: Stroke): Path2D {
  const smooth = smoothPressures(envelopePressures(stroke.points, stroke.size));
  const isBallpoint = stroke.tool === "ballpoint";
  const outline = getStroke(smooth, {
    size: stroke.size,
    thinning: isBallpoint ? 0.08 : 0.68,
    smoothing: 0.6,
    streamline: 0.52,
    simulatePressure: false,
    last: true,
    easing: (t) => t,
    start: {
      cap: true,
      taper: isBallpoint ? 0 : Math.min(stroke.size * 1.6, 7),
    },
    end: {
      cap: true,
      taper: isBallpoint ? 0 : Math.min(stroke.size * 1.6, 7),
    },
  });
  return outlineToPath(outline);
}

function buildPolyline(stroke: Stroke): Path2D {
  const path = new Path2D();
  const pts = stroke.points;
  if (!pts.length) return path;
  path.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 1) {
    path.lineTo(pts[0][0] + 0.01, pts[0][1] + 0.01);
    return path;
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    path.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const last = pts[pts.length - 1];
  path.lineTo(last[0], last[1]);
  return path;
}

function buildShape(stroke: Stroke): Path2D {
  const path = new Path2D();
  const pts = stroke.points;
  if (pts.length < 2) return path;
  const [x1, y1] = pts[0];
  const [x2, y2] = pts[pts.length - 1];
  const kind = stroke.shape ?? "rect";
  if (kind === "rect") {
    path.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  } else if (kind === "ellipse") {
    path.ellipse(
      (x1 + x2) / 2,
      (y1 + y2) / 2,
      Math.abs(x2 - x1) / 2,
      Math.abs(y2 - y1) / 2,
      0,
      0,
      Math.PI * 2
    );
  } else {
    path.moveTo(x1, y1);
    path.lineTo(x2, y2);
    if (kind === "arrow") {
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.max(10, stroke.size * 4);
      const spread = Math.PI / 7;
      path.moveTo(x2, y2);
      path.lineTo(x2 - head * Math.cos(angle - spread), y2 - head * Math.sin(angle - spread));
      path.moveTo(x2, y2);
      path.lineTo(x2 - head * Math.cos(angle + spread), y2 - head * Math.sin(angle + spread));
    }
  }
  return path;
}

/**
 * 笔画预测：根据最近几点的速度与加速度外推一小段，
 * 让墨迹"跑"在笔尖前面一点，落笔的跟手感立刻不一样。
 * 真笔迹 App（Apple Notes / GoodNotes / 享做）都有这一层。
 */
export function predictTail(
  points: Pt[],
  count = 3,
  damping = 0.7,
  maxStep = 26
): Pt[] {
  const n = points.length;
  if (n < 2) return [];
  const p1 = points[n - 1];
  const p2 = points[n - 2];
  const p3 = n >= 3 ? points[n - 3] : p2;

  let vx = p1[0] - p2[0];
  let vy = p1[1] - p2[1];
  let ax = p1[0] - 2 * p2[0] + p3[0];
  let ay = p1[1] - 2 * p2[1] + p3[1];

  const out: Pt[] = [];
  let cx = p1[0];
  let cy = p1[1];
  let budget = maxStep * count;

  for (let i = 0; i < count; i++) {
    vx += ax * 0.5;
    vy += ay * 0.5;
    const len = Math.hypot(vx, vy);
    if (len < 0.001) break;
    const step = Math.min(maxStep, len, budget);
    cx += (vx / len) * step;
    cy += (vy / len) * step;
    budget -= step;
    out.push([cx, cy, p1[2]]);
    vx *= damping;
    vy *= damping;
    ax *= 0.55;
    ay *= 0.55;
    if (budget <= 0) break;
  }
  return out;
}

/** 供测试用：这条笔迹最终生效的压力曲线（含入锋/出锋包络） */
export function effectivePressures(stroke: Stroke): number[] {
  if (stroke.tool === "highlighter" || stroke.tool === "shape") {
    return stroke.points.map((p) => p[2]);
  }
  return smoothPressures(envelopePressures(stroke.points, stroke.size)).map((p) => p[2]);
}

export function strokePath(stroke: Stroke): Path2D {
  const cached = pathCache.get(stroke);
  if (cached) return cached;
  let path: Path2D;
  if (stroke.tool === "shape") path = buildShape(stroke);
  else if (stroke.tool === "highlighter") path = buildPolyline(stroke);
  else path = buildInkPath(stroke);
  pathCache.set(stroke, path);
  return path;
}

export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, alpha = 1): void {
  const pts = stroke.points;
  if (!pts.length) return;
  ctx.save();
  ctx.globalAlpha = stroke.opacity * alpha;

  if (stroke.tool === "highlighter") {
    ctx.globalCompositeOperation = "multiply";
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], stroke.size / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.stroke(strokePath(stroke));
    }
    ctx.restore();
    return;
  }

  if (stroke.tool === "shape") {
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke(strokePath(stroke));
    ctx.restore();
    return;
  }

  ctx.fillStyle = stroke.color;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0], pts[0][1], Math.max(0.45, stroke.size * 0.46), 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fill(strokePath(stroke));
  }
  ctx.restore();
}

/** 画到离屏画布/导出时用；不改全局状态 */
export function paintStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, alpha = 1): void {
  drawStroke(ctx, stroke, alpha);
}
