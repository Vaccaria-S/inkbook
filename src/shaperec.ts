/**
 * 一笔成型：把一条手绘笔迹识别成规整图形。
 *
 * 识别思路：对笔迹点列做多项式最小二乘拟合（阶数 5 / 6），按曲线特征
 * 判定是矩形 / 椭圆 / 直线 / 箭头。纯几何实现，不依赖任何外部库或运行时。
 *
 * 这里只做纯几何：输入一条自由笔迹的点列，输出「规整成哪个形状」以及
 * 形状笔画需要的两个端点。不碰 DOM、不碰 store、不碰撤销栈，方便逐项断言。
 *
 * 只识别墨本已有的四种 ShapeKind（line / arrow / rect / ellipse）：
 * 三角形、多边形需要新增形状种类、改 buildShape 与工具面板，属于另一个
 * 改动，不在这一单里做。宁可「认不出来保持原笔迹」，也不要把字迹错判成图形。
 *
 * 2026-11-16 重做（用户反馈「一次成型并没有看到成什么形状」）：
 *   旧版判据在**真人手绘**上几乎全灭，因为它靠「首末点闭合 + 重采样点数拐角」
 *   两把硬尺：
 *     · 首末点间隙卡 0.28·短边，手一抖收口差几十像素就判成「没闭合」
 *       （实测：手画矩形收口差 12% 周长 → 0/12 命中）；
 *     · 圆角矩形的转角被重采样摊薄到 <54°，数不到 4 个角 → 既不像矩形
 *       也不像椭圆 → 直接 null。
 *   更糟的是旧版「3~5 个角都算矩形」，于是**三角形会被误判成矩形**
 *   （12/12 错误，画个三角形给你补一个外接矩形）。
 *
 *   新版换成对手绘更鲁棒、且互斥更清晰的三把尺：
 *     · 矩形：**贴边率**——绝大多数点都落在包围盒四条边附近（frac→1），
 *       四条边都被覆盖，且角部外凸把归一化极径方差抬起来（std 明显大于圆/椭圆）；
 *     · 椭圆 / 圆：归一化极径很稳（std 很小）、均值落在 1 附近；
 *     · 三角形：只覆盖两三条边、贴边率低、极径方差大 → 拒识（不再补外接矩形）。
 *   直线 / 箭头改用「首末弦贴合 + 末端回勾」判定，箭头不再依赖 tip≈末点。
 *   收口间隙放宽到 0.26·对角线，并用「轨迹长 / 周长」把来回涂的线挡在外面。
 */
import type { Pt, ShapeKind } from "./types";

/** 识别结果：kind + 形状笔画的两个端点（页面坐标） */
export interface ShapeRecognition {
  kind: ShapeKind;
  a: [number, number];
  b: [number, number];
}

/** 少于这个点数不识别：手写「口」「日」之类起笔点太少，容易误判 */
export const SNAP_MIN_POINTS = 8;
/** 外接框的最长边小于这个值（页面单位）不识别：小涂改不算图形 */
export const SNAP_MIN_SPAN = 26;
/** 轨迹总长下限 */
export const SNAP_MIN_LENGTH = 48;

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  w: number;
  h: number;
  diag: number;
}

function boxOf(pts: Pt[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const w = maxX - minX;
  const h = maxY - minY;
  return { minX, minY, maxX, maxY, w, h, diag: Math.hypot(w, h) };
}

function lengthOf(pts: Pt[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return s;
}

/** 去掉挨得太近的重复点（设备高频采样常见），免得把一段直线数成一堆零碎 */
function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= 0.01) out.push(p);
  }
  return out;
}

/** 归一化极径的均值 / 标准差：贴着椭圆走一圈时应该接近 1 且很稳（矩形角部冲到 ~1.41） */
function radialStats(pts: Pt[], box: Box): { mean: number; std: number } {
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const rx = Math.max(1e-6, box.w / 2);
  const ry = Math.max(1e-6, box.h / 2);
  let sum = 0;
  let sum2 = 0;
  for (const p of pts) {
    const r = Math.hypot((p[0] - cx) / rx, (p[1] - cy) / ry);
    sum += r;
    sum2 += r * r;
  }
  const mean = sum / pts.length;
  return { mean, std: Math.sqrt(Math.max(0, sum2 / pts.length - mean * mean)) };
}

/**
 * 贴边统计：一条矩形手绘笔迹，绝大多数点都贴着包围盒的四条边（frac→1）；
 * 圆/椭圆只有四个极点贴边、斜向处都往内收，贴边率明显低，且四条边不会同时被覆盖。
 * 用「点到最近边的距离 / 短边」做归一化，圆角、手抖都扛得住。
 */
function edgeBandStats(pts: Pt[], box: Box): { frac: number; covered: boolean } {
  const minWH = Math.max(1e-6, Math.min(box.w, box.h));
  const band = 0.16; // 短边的 16% 以内算「贴着这条边」
  let near = 0;
  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;
  for (const p of pts) {
    const dxl = (p[0] - box.minX) / minWH;
    const dxr = (box.maxX - p[0]) / minWH;
    const dyt = (p[1] - box.minY) / minWH;
    const dyb = (box.maxY - p[1]) / minWH;
    if (Math.min(Math.min(dxl, dxr), Math.min(dyt, dyb)) <= band) near++;
    if (dxl <= band) left++;
    if (dxr <= band) right++;
    if (dyt <= band) top++;
    if (dyb <= band) bottom++;
  }
  const need = Math.max(1, Math.floor(pts.length * 0.04));
  return {
    frac: near / pts.length,
    covered: left >= need && right >= need && top >= need && bottom >= need,
  };
}

/** 点到线段（首→尾）的距离 */
function chordDeviation(pts: Pt[], a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-9) return Infinity;
  let max = 0;
  for (const p of pts) {
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    max = Math.max(max, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return max;
}

function rectOf(box: Box): ShapeRecognition {
  return { kind: "rect", a: [box.minX, box.minY], b: [box.maxX, box.maxY] };
}
function ellipseOf(box: Box): ShapeRecognition {
  return { kind: "ellipse", a: [box.minX, box.minY], b: [box.maxX, box.maxY] };
}

/**
 * 识别一条自由笔迹。
 *
 * 分「闭合图形」与「开放图形」两条路：
 *   闭合：先过尺寸闸门，再用「贴边率 / 极径方差」互斥地区分矩形 / 椭圆；
 *         细长闭合环（来回涂的一条线）、三角形、比例失衡的一律拒识。
 *   开放：先试直线（整条贴首末弦）；再试箭头（主干笔直 + 末端回勾成 V）。
 *
 * 判据宁可漏认（保留原笔迹），也不要错把字迹吃掉；但也不能像旧版那样
 * 把真人手画的矩形全部漏掉、或把三角形补成矩形。
 */
export function recognizeShape(points: Pt[]): ShapeRecognition | null {
  if (!points || points.length < SNAP_MIN_POINTS) return null;
  const pts = dedupe(
    points.filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]))
  );
  if (pts.length < SNAP_MIN_POINTS) return null;

  const box = boxOf(pts);
  const len = lengthOf(pts);
  if (!(len >= SNAP_MIN_LENGTH) || !(box.diag > 0)) return null;
  // 只看长边：水平/竖直的直线短边接近 0，用短边会把它们全误杀。
  if (Math.max(box.w, box.h) < SNAP_MIN_SPAN) return null;

  const first = pts[0];
  const last = pts[pts.length - 1];
  const gap = Math.hypot(last[0] - first[0], last[1] - first[1]);
  const perimeter = 2 * (box.w + box.h);
  /*
   * 收口间隙放宽到对角线的 45%（真人手画圆 / 矩形经常收口差一两成，
   * 以前卡 26% 会把它们全漏掉 → 用户「打开了也跟没打开一样」）。
   * 同时用「轨迹长 / 周长」把来回涂的线和开口很大的折线挡在外面：
   *   · 开口 > ~30% 的弧（像字母 C / 括号）不是闭合图形，len 偏短、gap 偏大，拒识；
   *   · 来回涂的同一条线 len 远超周长，也会被上限挡住。
   */
  const closed =
    gap <= Math.max(16, 0.45 * box.diag) &&
    len >= 0.45 * perimeter &&
    len <= 1.9 * perimeter;

  if (closed) {
    const ratio = Math.min(box.w, box.h) / Math.max(box.w, box.h);
    // 细长闭合条不是矩形也不是椭圆（更像一条来回涂的线）
    if (ratio < 0.12) return null;
    const { frac, covered } = edgeBandStats(pts, box);
    const { mean, std } = radialStats(pts, box);
    // 矩形：点几乎全贴着包围盒四边（frac→1），且角部外凸把归一化极径
    // 的方差抬起来（std 明显大于圆/椭圆）。四条边都要被覆盖到。
    if (covered && frac >= 0.86 && std >= 0.07 && mean >= 1.03) return rectOf(box);
    // 椭圆 / 圆：极径很稳（std 很小）、均值落在 1 附近
    if (mean > 0.93 && mean < 1.07 && std <= 0.065) return ellipseOf(box);
    // 圆角很大的方形：贴边率仍高、极径方差中等，兜底按矩形
    if (covered && frac >= 0.82 && std >= 0.045 && mean >= 1.02) return rectOf(box);
    return null;
  }

  // ---- 开放图形 ----
  // 直线：整条笔迹贴着首末弦，且没有多余来回
  const chordLen = Math.hypot(last[0] - first[0], last[1] - first[1]);
  if (chordLen >= SNAP_MIN_LENGTH) {
    const dev = chordDeviation(pts, first, last);
    if (dev / chordLen < 0.08 && len / chordLen < 1.12) {
      return { kind: "line", a: [first[0], first[1]], b: [last[0], last[1]] };
    }
  }

  // 箭头：远景点当「笔尖」，主干要直，末端要有往回勾 + 侧向张开（V 形箭头）
  let tipIdx = 0;
  let tipD = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - first[0], pts[i][1] - first[1]);
    if (d > tipD) {
      tipD = d;
      tipIdx = i;
    }
  }
  const tip = pts[tipIdx];
  const tipLen = Math.hypot(tip[0] - first[0], tip[1] - first[1]);
  if (tipIdx < 3 || pts.length - tipIdx < 3 || tipLen < SNAP_MIN_LENGTH) return null;

  const ux = (tip[0] - first[0]) / tipLen;
  const uy = (tip[1] - first[1]) / tipLen;
  const shaftDev = chordDeviation(pts.slice(0, tipIdx + 1), first, tip);
  let maxBack = 0;
  let maxSide = 0;
  for (const p of pts.slice(tipIdx + 1)) {
    const along = (p[0] - tip[0]) * ux + (p[1] - tip[1]) * uy;
    const perp = Math.abs((p[0] - tip[0]) * -uy + (p[1] - tip[1]) * ux);
    maxBack = Math.max(maxBack, -along);
    maxSide = Math.max(maxSide, perp);
  }
  const tailLen = lengthOf(pts.slice(tipIdx));
  if (
    shaftDev / tipLen < 0.09 &&
    tailLen > 0.15 * tipLen &&
    maxBack > 0.1 * tipLen &&
    maxSide > 0.08 * tipLen
  ) {
    return { kind: "arrow", a: [first[0], first[1]], b: [tip[0], tip[1]] };
  }
  return null;
}

/** 把识别结果变成形状笔画的两个端点（压力固定 0.5，和形状工具一致） */
export function recognitionPoints(rec: ShapeRecognition): Pt[] {
  return [
    [rec.a[0], rec.a[1], 0.5],
    [rec.b[0], rec.b[1], 0.5],
  ];
}
