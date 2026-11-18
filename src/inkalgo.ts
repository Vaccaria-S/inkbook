/**
 * 手写笔迹增强算法：平滑、贝塞尔补点、速度外推预测与递细线宽。
 *
 * 实时链路：
 *   采样 → 3-tap 平滑（0/1/2 次）
 *        → 二次贝塞尔补点（控制点系数 1.6/3，按 t 步长 0.2 采样）
 *        → 速度外推预测（9 点滑窗 + 速度差分窗口）
 *        → 8 段二次贝塞尔预测轨迹（t = i/8）
 *        → 递细线宽（w → 0.25w）
 *
 * 预测器还按速度 / 加速度 / 曲率自适应预测时长，并做三次最小二乘拟合修正、
 * 限幅与过冲修正、起笔 transient 与转角门控。
 *
 * 纯函数 + 状态机，不碰 DOM、不碰存档：落笔数据仍是 `[x, y, pressure]`，
 * 预测只用于 overlay 实时预览，抬笔后不写入 `.inkbook`。
 */
import type { Pt } from "./types";

/** 算法关键常量（拟合系数与阈值）。 */
export const ALGO = Object.freeze({
  /** Bezier.a(prev,cur)=prev+(cur-prev)*1.6/3 @0x2ce420 */
  BEZIER_A: 1.6 / 3,
  /** 笔迹内核.generalBezierPoints：t 步长 0.2、上界 0.8001、强制收尾 0.9 */
  BEZIER_STEP: 0.2,
  BEZIER_LIMIT: 0.8001,
  BEZIER_LAST_T: 0.9,
  /** 补点间距 <1px 丢弃 */
  BEZIER_MIN_DIST: 1.0,
  /** Pen.getRenderablePoints 的 3-tap 核 */
  TAP: [0.25, 0.5, 0.25] as readonly number[],
  /** XVelocityTracker：窗口 4，velocityUnit=300.0f */
  VELOCITY_WINDOW: 4,
  VELOCITY_UNIT: 300.0,
  /** PathPrediction MIN_POINTS / refreshRate / bigQuickFactor */
  MIN_POINTS: 9,
  REFRESH_RATE: 60.0,
  BIG_QUICK_FACTOR: 2.1,
  /** onTouch：setMaxPredictTime(40.0f)、距离 >250 拒绝 */
  MAX_PREDICT_TIME: 40.0,
  REJECT_DISTANCE: 250.0,
  /** PenAction：8 段预测轨迹，taper 1-((i-1)/7)*0.75 */
  PREDICTION_SEGMENTS: 8,
  TAPER_END: 0.25,
  /** 手写引擎 常量表 @0xa33b0 = ln(1.5) */
  LN_1_5: 0.4054651081081644,
  /** 手写引擎 预测 的速度夹取 ±3（屏幕 px/ms） */
  MAX_VELOCITY: 3.0,
});

export interface NoteSample {
  /** 页面坐标 */
  x: number;
  y: number;
  t: number;
  p: number;
  /** 采样时的缩放归一化因子（等价 setDpi 的 dpi/160） */
  s: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function fin(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function fclamp(v: number, fallback: number, lo: number, hi: number): number {
  return clamp(fin(v, fallback), lo, hi);
}

/* ------------------------------------------------------------------ *
 * 一、平滑与贝塞尔（引擎 Bezier / 笔迹内核 / Pen）
 * ------------------------------------------------------------------ */

/** Bezier.a(F,F)F：控制点系数 1.6/3 */
export function bezierControl(prev: number, cur: number): number {
  const a = fin(prev, 0);
  const b = fin(cur, a);
  return a + (b - a) * ALGO.BEZIER_A;
}

/** getBezierValue(P0,P1,P2,t) @手写引擎 0x42fdc / CalculateBezierPointForQuadratic */
export function bezierValue(p0: number, p1: number, p2: number, t: number): number {
  const q = clamp(fin(t, 0), 0, 1);
  const u = 1 - q;
  const a = fin(p0, 0);
  const b = fin(p1, a);
  const c = fin(p2, b);
  return u * u * a + 2 * u * q * b + q * q * c;
}

/** getWidth(w0,w1,t) @Bezier #21145：线宽沿轨迹线性插值 */
export function interpolateWidth(w0: number, w1: number, t: number): number {
  const a = fin(w0, 0);
  const b = fin(w1, a);
  return a + (b - a) * clamp(fin(t, 0), 0, 1);
}

/** drawTaperedPrediction：w_i = w0 * (1 - ((i-1)/7)*0.75)，末端 0.25w0 */
export function predictionTaper(i: number, segments: number = ALGO.PREDICTION_SEGMENTS): number {
  const n = Math.max(1, Math.round(fin(segments, 8)));
  const k = clamp(fin(i, 1), 1, n);
  const raw = 1 - ((k - 1) / Math.max(1, n - 1)) * (1 - ALGO.TAPER_END);
  return clamp(raw, ALGO.TAPER_END, 1);
}

/**
 * Pen.getRenderablePoints：0/1/2 次 3-tap `[0.25, 0.5, 0.25]`，端点保持。
 * 只对 x/y 平滑，压力原样带回（DEX 里 x[]/y[] 与 width 分开处理）。
 */
export function smoothStrokePoints(points: Pt[], iterations = 1): Pt[] {
  const n = Math.max(0, Math.min(2, Math.round(fin(iterations, 1))));
  if (n === 0 || points.length < 3) return points.map((p) => [p[0], p[1], p[2]] as Pt);
  let cur: Pt[] = points.map((p) => [fin(p[0], 0), fin(p[1], 0), fin(p[2], 0.5)] as Pt);
  const [w0, w1, w2] = ALGO.TAP;
  for (let k = 0; k < n; k++) {
    const next: Pt[] = cur.map((p) => [p[0], p[1], p[2]] as Pt);
    for (let i = 1; i < cur.length - 1; i++) {
      next[i] = [
        w0 * cur[i - 1][0] + w1 * cur[i][0] + w2 * cur[i + 1][0],
        w0 * cur[i - 1][1] + w1 * cur[i][1] + w2 * cur[i + 1][1],
        cur[i][2],
      ] as Pt;
    }
    cur = next;
  }
  return cur;
}

/**
 * 笔迹内核.generalBezierPoints：t=0.01 起步长 0.2、上界 0.8001、强制收尾 0.9，
 * 相邻点距 <1px 丢弃。返回不含 P0 的补点。
 */
export function bezierPoints(p0: Pt, p1: Pt, p2: Pt, minDist = ALGO.BEZIER_MIN_DIST): Pt[] {
  const ts: number[] = [];
  for (let t = 0.01; t <= ALGO.BEZIER_LIMIT + 1e-9; t += ALGO.BEZIER_STEP) ts.push(t);
  ts.push(ALGO.BEZIER_LAST_T);
  const out: Pt[] = [];
  let lx = p0[0];
  let ly = p0[1];
  for (const t of ts) {
    const x = bezierValue(p0[0], p1[0], p2[0], t);
    const y = bezierValue(p0[1], p1[1], p2[1], t);
    const w = interpolateWidth(p0[2], p2[2], t);
    if (Math.hypot(x - lx, y - ly) < minDist) continue;
    out.push([x, y, clamp(w, 0.04, 1)] as Pt);
    lx = x;
    ly = y;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 二、压感 / 速度 → 线宽（手写引擎 的 native 公式，含 NaN 兜底）
 * ------------------------------------------------------------------ */

/** getPressureWidth(a,b) @0x42504 = a/3 + 2a*b^1.6 */
export function pressureWidth(base: number, pressure: number): number {
  const a = Math.max(0, fin(base, 1));
  const b = clamp(fin(pressure, 0.5), 0, 1);
  return a / 3 + 2 * a * Math.pow(b, 1.6);
}

/** getPenV(a,b) @0x425b4 = 1.8a*(b/16)^1.3 */
export function penVelocityWidth(base: number, velocity: number): number {
  const a = Math.max(0, fin(base, 1));
  const b = Math.max(0, fin(velocity, 0));
  return 1.8 * a * Math.pow(b / 16, 1.3);
}

/** getPencilV(a,b) @0x4254c = 0.5a*(0.6 + ln1.5/ln(b/12+1.2)) */
export function pencilVelocityWidth(base: number, velocity: number): number {
  const a = Math.max(0, fin(base, 1));
  const d = Math.max(0, fin(velocity, 0)) / 12 + 1.2;
  const lg = Math.log(d);
  if (!Number.isFinite(lg) || Math.abs(lg) < 1e-9) return 0.5 * a * 0.6;
  return 0.5 * a * (0.6 + ALGO.LN_1_5 / lg);
}

/** getBrushWidth(a,b,c) @0x42600 = 1.8a*(b/c)^1.3 */
export function brushWidth(base: number, b: number, c: number): number {
  const a = Math.max(0, fin(base, 1));
  const denom = Math.abs(fin(c, 1)) < 1e-6 ? 1 : fin(c, 1);
  const ratio = Math.max(0, fin(b, 0) / denom);
  return 1.8 * a * Math.pow(ratio, 1.3);
}

/** getPenWidth(a,b,c) @0x42644 = 0.5a*(K - ln1.5/ln(b/c))，c<20 时 K=1 */
export function penWidth(base: number, b: number, c: number): number {
  const a = Math.max(0, fin(base, 1));
  const cc = fin(c, 1);
  const ratio = Math.max(1e-6, Math.abs(fin(b, 1) / (Math.abs(cc) < 1e-6 ? 1 : cc)));
  const lg = Math.log(ratio);
  const K = cc < 20 ? 1 : 1.2999999523162842;
  if (!Number.isFinite(lg) || Math.abs(lg) < 1e-9) return 0.5 * a * K;
  return 0.5 * a * (K - ALGO.LN_1_5 / lg);
}

/** gs(a,b) @0x43230：速度越大平滑增益越小（快笔不拖尾） */
export function smoothingGain(a: number, b: number): number {
  const w = fin(a, 1);
  const v = Math.max(0, fin(b, 0));
  if (v < 2) return 1;
  if (v < 5) return 0.5;
  if (v < 10) return 5 / v;
  if (v < 30) return (w <= 5.9 ? 7 : 5.6) / v;
  return (w <= 5.9 ? 8 : 5.6) / v;
}

/**
 * gw @0x43430 的等价线宽下限。
 *
 * 实测只覆盖了分段常量 `1.1 / 3.1 / 0.1 / 8.1 / 9.5` 与
 * `5a/b、3a/b、4a/b、0.4a、a*c` 三个速度衰减式，30+ 分支未逐条线性化；
 * 这里按「快笔给一个不归零的宽度底、且不低于 a*c」重建等价行为，
 * 常量沿用分析值，不假装是逐指令复刻。
 */
export function widthFloor(a: number, b: number, c: number): number {
  const w = Math.max(0, fin(a, 1));
  const v = Math.max(0, fin(b, 0));
  const floor = Math.max(0.1, w * clamp(fin(c, 0.1), 0, 1));
  const dv = Math.max(1, v);
  if (w < 1.1) return Math.max(5 * w / dv, floor);
  if (w < 3.1) return Math.max(3 * w / dv, floor);
  if (w < 8.1) return Math.max(4 * w / dv, floor);
  return Math.max(0.4 * w, floor);
}

/**
 * 把 getPressureWidth 的 `p^1.6` 动态范围映射回本插件的 0..1 压力域，
 * 以 p=0.5 为 1 做归一，并夹在 [0.55, 1.45]：整体平均粗细不变，
 * 只是「轻的更轻、重的更重」，和经典手写应用的压感响应一致。
 */
export function pressureResponse(pressure: number): number {
  const q = clamp(fin(pressure, 0.5), 0, 1);
  const mid = pressureWidth(1, 0.5);
  if (!Number.isFinite(mid) || mid <= 0) return 1;
  return clamp(pressureWidth(1, q) / mid, 0.55, 1.45);
}

/* ------------------------------------------------------------------ *
 * 三、速度跟踪（XVelocityTracker #36616，窗口 4 / velocityUnit 300）
 * ------------------------------------------------------------------ */

export class XVelocityTracker {
  private events: Array<{ x: number; y: number; t: number }> = [];

  reset(): void {
    this.events.length = 0;
  }

  addMovement(x: number, y: number, t: number): void {
    if (![x, y, t].every(Number.isFinite)) return;
    const last = this.events[this.events.length - 1];
    const tt = last && t <= last.t ? last.t + 1 : t;
    this.events.push({ x, y, t: tt });
    while (this.events.length > ALGO.VELOCITY_WINDOW) this.events.shift();
  }

  /** vx = (dx*300)/dt，dt 为窗口首尾事件时间差（ms） */
  velocity(): { vx: number; vy: number } {
    const n = this.events.length;
    if (n < 2) return { vx: 0, vy: 0 };
    const a = this.events[0];
    const b = this.events[n - 1];
    const dt = Math.max(1, b.t - a.t);
    const k = ALGO.VELOCITY_UNIT / dt;
    return { vx: (b.x - a.x) * k, vy: (b.y - a.y) * k };
  }
}

/* ------------------------------------------------------------------ *
 * 四、三次最小二乘（手写引擎 拟合 / 矩阵求逆）
 * ------------------------------------------------------------------ */

/** 4×4 高斯消元（部分主元）；奇异矩阵返回 null */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    if (pivot !== col) {
      const tmp = M[pivot];
      M[pivot] = M[col];
      M[col] = tmp;
    }
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const out = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let v = M[i][n];
    for (let j = i + 1; j < n; j++) v -= M[i][j] * out[j];
    out[i] = v / M[i][i];
  }
  return out.every(Number.isFinite) ? out : null;
}

function horner(c: number[], u: number): number {
  let v = 0;
  for (let i = c.length - 1; i >= 0; i--) v = v * u + c[i];
  return v;
}

/**
 * 用最近窗口里的点拟合 x(u)、y(u) 的三次多项式。
 * 原生库用 ms 作为基（A 行 `[1,dt,dt²,dt³]`）；这里把时间轴按窗口跨度
 * 归一化到 [0,1]，只是一次等價的基变换，拟合出的曲线空间完全相同，
 * 但避开了 dt³ ~ 1e6 带来的病态条件数。
 */
function fitCubic(samples: NoteSample[], t0: number, span: number): [number[], number[]] | null {
  if (samples.length < 4) return null;
  const m = 4;
  const A: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  const bx = new Array<number>(m).fill(0);
  const by = new Array<number>(m).fill(0);
  for (const s of samples) {
    const u = clamp((s.t - t0) / span, 0, 2);
    const row = [1, u, u * u, u * u * u];
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) A[i][j] += row[i] * row[j];
      bx[i] += row[i] * s.x * s.s;
      by[i] += row[i] * s.y * s.s;
    }
  }
  const cx = solveLinear(A, bx);
  const cy = solveLinear(A, by);
  return cx && cy ? [cx, cy] : null;
}

/* ------------------------------------------------------------------ *
 * 五、实时预测器
 * ------------------------------------------------------------------ */

export interface InkPredictorOptions {
  /** 预热帧数：起笔前直接报原始点（vivo transients=5） */
  warmup?: number;
  /** 单段最大步长（页面单位），限住甩尾 */
  maxStep?: number;
  /** 预测轨迹段数（PenAction 为 8） */
  segments?: number;
  /** 显示刷新率，决定帧时长 */
  refreshRate?: number;
  /** 最大预测时长 ms（onTouch=40） */
  maxPredictTime?: number;
  /** 是否启用三次拟合修正（手写引擎 链路） */
  cubic?: boolean;
}

/**
 * 一笔一个实例：落笔 reset，逐点 push，previewStroke 读 `tail`。
 * `push` 里一次性算好尾巴，`tail` 是纯读，overlay 一帧重画多次也不会
 * 累加状态（原生库 Predict 每个新点只调用一次）。
 */
export class InkPredictor {
  private buf: NoteSample[] = [];
  private tracker = new XVelocityTracker();
  private cached: Pt[] = [];
  private transient = 0;
  private lastPredicted: { x: number; y: number } | null = null;
  private scale = 1;

  readonly warmup: number;
  readonly maxStep: number;
  readonly segments: number;
  readonly cubic: boolean;
  private frameTime: number = 1000 / ALGO.REFRESH_RATE;
  private maxPredictTime: number = ALGO.MAX_PREDICT_TIME;

  constructor(opts: InkPredictorOptions = {}) {
    this.warmup = clamp(Math.round(fin(opts.warmup, 5)), 0, 20);
    // 每段最多 8 页面单位：8 段合计 ≤64，和旧 predictTail 的 3×24 同一量级
    this.maxStep = clamp(fin(opts.maxStep, 8), 2, 120);
    this.segments = clamp(Math.round(fin(opts.segments, 8)), 2, 16);
    this.cubic = opts.cubic !== false;
    this.setRefreshRate(fin(opts.refreshRate, ALGO.REFRESH_RATE));
    this.setMaxPredictTime(fin(opts.maxPredictTime, ALGO.MAX_PREDICT_TIME));
  }

  setRefreshRate(hz: number): void {
    const r = clamp(fin(hz, 60), 30, 144);
    this.frameTime = 1000 / r;
  }

  setMaxPredictTime(ms: number): void {
    this.maxPredictTime = clamp(fin(ms, 40), 1, 60);
  }

  /** 等价 setDpi(xdpi,ydpi) 的 dpi/160：屏幕尺度 → 页面尺度 */
  setScale(s: number): void {
    this.scale = clamp(fin(s, 1), 0.1, 20);
  }

  reset(): void {
    this.buf.length = 0;
    this.tracker.reset();
    this.cached = [];
    this.transient = 0;
    this.lastPredicted = null;
  }

  get tail(): Pt[] {
    return this.cached;
  }

  /** 预热是否结束：未结束时 editor 回落到旧的 3 点外推，避免起笔没有预览尾巴 */
  get ready(): boolean {
    return this.transient > this.warmup && this.buf.length >= 4;
  }

  /** 供取证/测试读取内部诊断 */
  diagnostics(): { samples: number; transient: number; frameTime: number; maxPredictTime: number; tail: number } {
    return {
      samples: this.buf.length,
      transient: this.transient,
      frameTime: this.frameTime,
      maxPredictTime: this.maxPredictTime,
      tail: this.cached.length,
    };
  }

  push(x: number, y: number, t: number, p: number, scale = this.scale): void {
    if (![x, y, t, p].every(Number.isFinite)) {
      this.cached = [];
      return;
    }
    const last = this.buf[this.buf.length - 1];
    const tt = last && t <= last.t ? last.t + 1 : t;
    const s = clamp(fin(scale, 1), 0.1, 20);
    const q: NoteSample = { x, y, t: tt, p: clamp(fin(p, 0.5), 0.04, 1), s };
    this.buf.push(q);
    if (this.buf.length > 50) this.buf.shift();
    this.tracker.addMovement(q.x * s, q.y * s, tt);
    this.transient++;
    this.cached = this.computeTail();
  }

  /** 方向余弦（vivo c1f0 / Lenovo tailingFilter 的转角门控） */
  private directionCosine(): number {
    const n = this.buf.length;
    if (n < 3) return 1;
    const a = this.buf[n - 3];
    const b = this.buf[n - 2];
    const c = this.buf[n - 1];
    const ux = (b.x - a.x) * a.s;
    const uy = (b.y - a.y) * a.s;
    const vx = (c.x - b.x) * b.s;
    const vy = (c.y - b.y) * b.s;
    const la = Math.hypot(ux, uy);
    const lb = Math.hypot(vx, vy);
    if (la < 1e-6 || lb < 1e-6) return 1;
    return clamp((ux * vx + uy * vy) / (la * lb), -1, 1);
  }

  /**
   * 转角增益：Lenovo tailingFilter 的 4 档系数 `[0, 0.3, 0.35, 0.4]`。
   * 那组值是 240Hz 采样下的「拖尾泄漏系数」，直接当预测时长倍数会让
   * 60Hz 浏览器里任何轻微弧线都只剩 0.4 倍、尾巴比不预测还短。
   * 这里把档位当作**衰减权重**叠在 0.8 的基线上：直笔 1.0、缓弯 0.88、
   * 急弯 0.87/0.86，四档的相对次序与阈值不变；cos<0.77 仍是硬关断。
   * 基线取 0.8 是为了让普通弧线的预测距离不低于旧三点外推（取证里
   * cos≈0.99 的弧线旧值 45、新值 <15，反而更不跟手）。
   */
  private turnGain(cos: number): number {
    if (cos < 0.77) return 0;
    let raw = 0.3;
    if (cos >= 0.9995) raw = 1;
    else if (cos >= 0.92) raw = 0.4;
    else if (cos >= 0.87) raw = 0.35;
    return 0.8 + 0.2 * raw;
  }

  /** onTouch2 的分段速度增益（8/15/23/34 与 1.6/2.1/2.5 的等价归一） */
  private speedGain(speed: number): number {
    if (speed < 8) return 0.5;
    if (speed < 15) return 0.8;
    if (speed < 23) return 1.2;
    if (speed < 34) return 1.3;
    return 1.0;
  }

  private computeTail(): Pt[] {
    const n = this.buf.length;
    const E = this.buf[n - 1];
    if (!E) return [];

    // 起笔预热（vivo transients=5；浏览器采样率低于 240Hz，取 5 帧）
    if (this.transient <= this.warmup || n < 4) {
      this.lastPredicted = { x: E.x * E.s, y: E.y * E.s };
      return [];
    }

    const cos = this.directionCosine();
    const gate = this.turnGain(cos);
    if (gate <= 0) {
      this.lastPredicted = { x: E.x * E.s, y: E.y * E.s };
      return [];
    }

    // XVelocityTracker 输出的是 300·px/ms，除回 velocityUnit 得 px/ms
    const vel = this.tracker.velocity();
    const vx = clamp(vel.vx / ALGO.VELOCITY_UNIT, -ALGO.MAX_VELOCITY, ALGO.MAX_VELOCITY);
    const vy = clamp(vel.vy / ALGO.VELOCITY_UNIT, -ALGO.MAX_VELOCITY, ALGO.MAX_VELOCITY);
    const speed = Math.hypot(vx, vy);
    if (speed < 1e-4) {
      this.lastPredicted = { x: E.x * E.s, y: E.y * E.s };
      return [];
    }

    // onTouch2 的 8/15/23/34 阈值按「每帧位移」计；转角与速度共同决定预测时长。
    // 上限直接用 onTouch 的 setMaxPredictTime(40)，不再额外乘阻尼系数：
    // 那样会把 browser 60Hz 下的尾巴压到比旧三点外推还短，反而更不跟手。
    const perFrame = speed * this.frameTime;
    const predictTime = clamp(
      this.frameTime * this.speedGain(perFrame) * gate * ALGO.BIG_QUICK_FACTOR,
      0,
      this.maxPredictTime
    );
    if (predictTime < 1) {
      this.lastPredicted = { x: E.x * E.s, y: E.y * E.s };
      return [];
    }

    const ex = E.x * E.s;
    const ey = E.y * E.s;
    let ox = ex + vx * predictTime;
    let oy = ey + vy * predictTime;

    // 手写引擎：三次拟合 + 线性速度 50/50 + 限幅
    if (this.cubic && predictTime >= 8) {
      const t0 = E.t - Math.max(25, 2 * predictTime);
      const win = this.buf.filter((q) => q.t >= t0);
      const span = Math.max(1, win[win.length - 1].t - win[0].t);
      const fit = fitCubic(win, t0, span);
      if (fit) {
        const u = 0.8 * (E.t + predictTime - t0) / span;
        const px = horner(fit[0], u);
        const py = horner(fit[1], u);
        const radius = speed > 1.5 ? 0.8 * speed : speed;
        const cap = radius >= 1.5 ? 30 : radius > 0.5 ? 15 : 10 + 15 * radius;
        const inv = speed > 1e-6 ? 1 / speed : 0;
        const bx = ex + vx * inv * radius * predictTime;
        const by = ey + vy * inv * radius * predictTime;
        let dx = px - bx;
        let dy = py - by;
        const d = Math.hypot(dx, dy);
        if (d > cap && d > 0) {
          dx = dx / d * cap;
          dy = dy / d * cap;
        }
        if (Number.isFinite(dx) && Number.isFinite(dy)) {
          ox = 0.5 * (bx + dx + ox);
          oy = 0.5 * (by + dy + oy);
        }
      }
    }

    // MotionPredictor::Adjust：以倒数第 2 点为锚修过冲
    const R = this.buf[n - 2];
    const rx = R.x * R.s;
    const ry = R.y * R.s;
    let dx = ox - rx;
    let dy = oy - ry;
    const L = Math.hypot(dx, dy);
    if (L > 1e-6) {
      const lp = this.lastPredicted ?? { x: ex, y: ey };
      const dist = Math.hypot(lp.x - rx, lp.y - ry);
      let dirx = dx / L;
      let diry = dy / L;
      let scale = L;
      if (dist > L) {
        const gx = ox + lp.x - 2 * rx;
        const gy = oy + lp.y - 2 * ry;
        const gl = Math.hypot(gx, gy);
        if (gl > 1e-6) {
          dirx = gx / gl;
          diry = gy / gl;
        }
        scale = dist;
      }
      ox = rx + dirx * scale;
      oy = ry + diry * scale;
    }
    this.lastPredicted = { x: ox, y: oy };

    // 8 段二次贝塞尔：控制点沿入笔方向，长度按 Bezier.a 的 1.6/3
    const P = this.buf[n - 2];
    let dxPrev = ex - P.x * P.s;
    let dyPrev = ey - P.y * P.s;
    const lp = Math.hypot(dxPrev, dyPrev);
    if (lp > 1e-6) {
      dxPrev /= lp;
      dyPrev /= lp;
    } else {
      dxPrev = vx / speed;
      dyPrev = vy / speed;
    }
    let reach = Math.hypot(ox - ex, oy - ey);
    const cap = Math.min(ALGO.REJECT_DISTANCE, this.maxStep * this.segments * E.s);
    if (!Number.isFinite(reach) || reach < 0.5) return [];
    reach = Math.min(reach, cap);
    const ux = vx / speed;
    const uy = vy / speed;
    const p2x = ex + ux * reach;
    const p2y = ey + uy * reach;
    const c1x = ex + dxPrev * reach * ALGO.BEZIER_A;
    const c1y = ey + dyPrev * reach * ALGO.BEZIER_A;

    const out: Pt[] = [];
    const floorP = clamp(widthFloor(3, Math.abs(perFrame), 0.25) / 3, 0.04, 0.22);
    let lx = E.x;
    let ly = E.y;
    for (let i = 1; i <= this.segments; i++) {
      const t = i / this.segments;
      const sx = bezierValue(ex, c1x, p2x, t);
      const sy = bezierValue(ey, c1y, p2y, t);
      const x = sx / E.s;
      const y = sy / E.s;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const p = Math.max(floorP, clamp(E.p * predictionTaper(i, this.segments), 0.04, 1));
      // 相邻尾点过密时跳过，避免 perfect-freehand 生成毛刺
      if (Math.hypot(x - lx, y - ly) < 0.35) continue;
      out.push([x, y, p] as Pt);
      lx = x;
      ly = y;
    }
    // Pen.getRenderablePoints 的 LIGHT 档：预测轨迹再做一次 3-tap，端点保持
    return smoothStrokePoints(out, 1);
  }
}

/** 默认实例工厂，便于 editor 每笔一份 */
export function createInkPredictor(opts?: InkPredictorOptions): InkPredictor {
  return new InkPredictor(opts);
}
