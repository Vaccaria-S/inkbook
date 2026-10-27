/**
 * 手感对比：同一条带抖动的轨迹，分别用
 *   A：旧参数（无滤波、线性压感、无速度联动）
 *   B：新参数（1€ 滤波 + 压感整形 + 速度联动）
 * 渲染出来，肉眼就能看出差别。
 */
import { shapePressure, speedWidthFactor, OneEuroFilter } from "../src/filter";
import { drawStroke } from "../src/ink";
import type { Pt, Stroke } from "../src/types";

const W = 820;
const H = 560;

const cv = document.createElement("canvas");
cv.width = W;
cv.height = H;
cv.style.cssText = `display:block;width:${W}px;height:${H}px`;
document.body.appendChild(cv);
const ctx = cv.getContext("2d")!;
ctx.fillStyle = "#ffffff";
ctx.fillRect(0, 0, W, H);

/** 生成一条"人手写的"轨迹：直线 + 抖动 + 起笔收笔速度变化 */
function humanPath(x0: number, y0: number, len: number, noise: number, seed: number) {
  let seedv = seed >>> 0;
  const rnd = () => {
    seedv = (seedv * 1664525 + 1013904223) >>> 0;
    return seedv / 4294967296 - 0.5;
  };
  const pts: Array<[number, number, number]> = [];
  let x = x0;
  let y = y0;
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const v = 1.7 + 2.4 * Math.sin(Math.PI * t);
    x += v * (0.85 + rnd() * 0.3);
    y += Math.sin(t * Math.PI * 2.1) * 1.4 + rnd() * noise;
    const pr = 0.3 + 0.6 * Math.sin(Math.PI * t) + rnd() * 0.14;
    pts.push([x, y, Math.max(0.05, Math.min(1, pr))]);
  }
  return pts;
}

/** 把原始采样转成笔迹点；mode 决定用旧管线还是新管线 */
function toStrokePoints(
  raw: Array<[number, number, number]>,
  mode: "old" | "new"
): Pt[] {
  const pts: Pt[] = [];
  const filter =
    mode === "new" ? new OneEuroFilter(1.6, 0.05, 1.0) : new OneEuroFilter(60, 0, 1.0);
  let last: { x: number; y: number; t: number } | null = null;
  let lastP: number | null = null;
  let t = 0;

  for (const [rx, ry, rp] of raw) {
    t += 16;
    let x = rx;
    let y = ry;
    if (mode === "new") {
      const f = filter.filter(rx, ry, t);
      x = f.x;
      y = f.y;
    }
    const dt = last ? t - last.t : 16;
    const dist = last ? Math.hypot(x - last.x, y - last.y) : 0;
    const speed = dist / Math.max(1, dt);

    let p: number;
    if (mode === "new") {
      p = shapePressure(rp, 1) * speedWidthFactor(speed);
    } else {
      const vel = Math.max(0.3, Math.min(0.95, 1 - speed / 2.3));
      p = rp * 0.82 + vel * 0.18;
    }
    if (lastP != null) p = lastP * 0.32 + p * 0.68;
    lastP = p;
    last = { x, y, t };
    pts.push([x, y, p]);
  }
  return pts;
}

function draw(
  label: string,
  sub: string,
  raw: Array<[number, number, number]>,
  mode: "old" | "new"
) {
  const pts = toStrokePoints(raw, mode);
  const stroke: Stroke = {
    id: "demo",
    tool: "pen",
    color: "#1A1A1A",
    size: 4.2,
    opacity: 1,
    points: pts,
  };
  if (mode === "old") {
    // 旧管线：没有包络，直接按原始压力画粗细一致的线
    ctx.save();
    ctx.strokeStyle = "#1A1A1A";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
    ctx.restore();
  } else {
    drawStroke(ctx, stroke);
  }

  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minY = Math.min(...ys);

  ctx.fillStyle = "#2b2b2b";
  ctx.font = "600 16px system-ui, -apple-system, sans-serif";
  ctx.fillText(label, 28, minY - 34);
  ctx.fillStyle = "#8a8a8a";
  ctx.font = "12px system-ui, -apple-system, sans-serif";
  ctx.fillText(sub, 28, minY - 16);

  // 标出起笔 / 收笔位置
  ctx.fillStyle = "#c0392b";
  ctx.beginPath();
  ctx.arc(pts[0][0], pts[0][1], 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#2471a3";
  ctx.beginPath();
  const e = pts[pts.length - 1];
  ctx.arc(e[0], e[1], 4, 0, Math.PI * 2);
  ctx.fill();
}

// 同一个随机种子 → 抖动完全一致，唯一差别是渲染管线
const a = humanPath(60, 140, 130, 3.4, 7);
const b = humanPath(60, 420, 130, 3.4, 7);

draw("A · 旧手感", "无滤波 / 线性压感 / 无速度联动", a, "old");
draw("B · 新手感", "1€ 抖动滤波 / 压感曲线整形 / 速度—粗细联动", b, "new");

ctx.fillStyle = "#b0b0b0";
ctx.font = "11px system-ui, sans-serif";
ctx.fillText("● 起笔    ● 收笔", 28, H - 18);

document.title = "DONE";
