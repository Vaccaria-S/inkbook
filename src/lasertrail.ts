/**
 * 激光笔光迹的几何：把原始指针采样点变成一条**平滑、跟手、按时间淡出**的折线。
 *
 * 设计：激光笔只做发光指示、不落墨，光迹平滑跟随笔尖并按时间整段淡出。
 *
 * 2026-11-16 重做（用户反馈「激光笔的笔迹也很粗糙」）：
 *   旧版把每个 pointermove 采样点直接 lineTo 连起来，且**逐段**设置 alpha/线宽、
 *   每段都带圆头 → 相邻两段在拐点处圆头叠加，alpha 翻倍成一串「珠子」；
 *   快速拖动时采样点稀疏、段与段之间是硬折角，看着又顿又糙。
 *
 *   新版：
 *     1) 去重复点后，用**向心 Catmull-Rom（centripetal）**把折线插值成平滑曲线——
 *        曲线经过每个原始点（峰值不塌、跟手），只在拐点处圆滑过渡，且向心参数化
 *        不会像均匀 Catmull-Rom 那样在尖角处过冲；
 *     2) 每个插值采样点带插值后的时间戳，渲染时按年龄算 life = 1 - age/寿命；
 *     3) 渲染端把相邻、life 相近的采样点**合并成一条子路径一次描边**
 *        （见 editor.renderOverlay），避免逐段圆头叠加的「珠子」；
 *     4) 头部另画一个径向渐变光点 + 外发光，像真正的激光笔。
 *
 * 这里是纯函数（不碰 DOM），输入原始轨迹、当前时刻、寿命，输出平滑采样点 + 头部
 * 位置，方便逐项断言（连续性 / life 单调 / 峰值保真 / 平滑度）。
 */

/** 原始指针采样点（页面坐标 + 落点时刻 performance.now()） */
export interface LaserRawPoint {
  x: number;
  y: number;
  t: number;
}

/** 平滑后的采样点：页面坐标 + 剩余生命 [0,1]（1=刚落下，0=该消失） */
export interface LaserSample {
  x: number;
  y: number;
  life: number;
}

export interface LaserGeometry {
  /** 从尾（旧）到头（新）的平滑采样点，life 单调不减；已剔除 life≤0 的点 */
  samples: LaserSample[];
  /** 头部光点（最新、最亮）；没有有效点时是 null */
  head: LaserSample | null;
}

/** 原始相邻点重合到这个距离内就去重（高频设备会一次吐一堆同位置的点） */
const MIN_SEG = 0.25;
/** 插值曲线的采样步长（页面单位）：越小越圆滑、越费 */
const CURVE_STEP = 3;
/** 单段最多细分点数，防止一次巨大跳变把点数拉爆 */
const MAX_SUB = 24;

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 去掉几乎重合的相邻点（保留较新的时间戳） */
function dedupeTrail(points: LaserRawPoint[]): LaserRawPoint[] {
  const out: LaserRawPoint[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.t)) continue;
    const q = out[out.length - 1];
    if (!q || dist(p, q) >= MIN_SEG) out.push(p);
    else out[out.length - 1] = { x: p.x, y: p.y, t: Math.max(q.t, p.t) };
  }
  return out;
}

/**
 * 向心 Catmull-Rom（Barry–Goldman 形式）：返回 p1→p2 段上参数 u∈[0,1] 的点。
 * alpha=0.5 的向心参数化能避免均匀参数在尖角处的「打结 / 过冲」。
 */
function centripetalCR(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  u: number
): { x: number; y: number } {
  const alpha = 0.5;
  const knot = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.max(1e-4, Math.pow(Math.hypot(a.x - b.x, a.y - b.y), alpha));
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const lerp = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    ta: number,
    tb: number
  ): { x: number; y: number } => {
    const w = tb - ta > 1e-9 ? (t - ta) / (tb - ta) : 0;
    return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
  };
  const A1 = lerp(p0, p1, t0, t1);
  const A2 = lerp(p1, p2, t1, t2);
  const A3 = lerp(p2, p3, t2, t3);
  const B1 = lerp(A1, A2, t0, t2);
  const B2 = lerp(A2, A3, t1, t3);
  return lerp(B1, B2, t1, t2);
}

/**
 * 构建激光光迹几何。
 *
 * @param points   原始轨迹（按时间从旧到新），页面坐标
 * @param now      当前时刻（performance.now()）
 * @param fadeMs   光迹寿命：超过这个年龄的点丢弃
 */
export function buildLaserGeometry(
  points: LaserRawPoint[],
  now: number,
  fadeMs: number
): LaserGeometry {
  const deduped = dedupeTrail(points);
  if (!deduped.length || !(fadeMs > 0)) return { samples: [], head: null };

  // 只保留还没过期的点（多留一个刚过期的锚点，尾部不会切得太生硬）
  let firstAlive = deduped.findIndex((p) => now - p.t < fadeMs);
  if (firstAlive < 0) return { samples: [], head: null };
  if (firstAlive > 0) firstAlive -= 1;
  const live = deduped.slice(firstAlive);
  if (live.length === 1) {
    const life = 1 - (now - live[0].t) / fadeMs;
    if (life <= 0) return { samples: [], head: null };
    const s = { x: live[0].x, y: live[0].y, life: Math.min(1, life) };
    return { samples: [s], head: s };
  }

  // 逐段向心 Catmull-Rom 插值：曲线经过每个原始点，拐点圆滑，峰值保真
  const curve: LaserRawPoint[] = [{ ...live[0] }];
  for (let i = 0; i < live.length - 1; i++) {
    const p0 = live[i - 1] ?? live[i];
    const p1 = live[i];
    const p2 = live[i + 1];
    const p3 = live[i + 2] ?? live[i + 1];
    const segLen = dist(p1, p2);
    const steps = Math.max(1, Math.min(MAX_SUB, Math.ceil(segLen / CURVE_STEP)));
    for (let s = 1; s <= steps; s++) {
      const u = s / steps;
      const pt = centripetalCR(p0, p1, p2, p3, u);
      curve.push({ x: pt.x, y: pt.y, t: p1.t + (p2.t - p1.t) * u });
    }
  }

  const samples: LaserSample[] = [];
  for (const p of curve) {
    const life = 1 - (now - p.t) / fadeMs;
    if (life > 0) samples.push({ x: p.x, y: p.y, life: Math.min(1, life) });
  }
  if (!samples.length) return { samples: [], head: null };
  return { samples, head: samples[samples.length - 1] };
}

/**
 * 把采样点按 life 分到若干条「等生命带」，返回一个可一次描边的子路径集合。
 * 同一条带内的点连续描边一次 → 不会出现逐段圆头在拐点叠加的「珠子」。
 * 返回的每条带：points（点列，至少 2 个）+ life（该带中点的剩余生命）。
 */
export interface LaserBand {
  points: Array<{ x: number; y: number }>;
  life: number;
}

export function bandLaserSamples(samples: LaserSample[], bands = 10): LaserBand[] {
  if (samples.length < 2) return [];
  const n = Math.max(2, Math.min(24, bands));
  const out: LaserBand[] = [];
  let bucket: Array<{ x: number; y: number }> = [];
  let bucketLifeSum = 0;
  let bucketCount = 0;
  let bucketIdx = -1;
  const flush = () => {
    if (bucket.length >= 2) {
      out.push({ points: bucket, life: bucketLifeSum / Math.max(1, bucketCount) });
    }
    bucket = [];
    bucketLifeSum = 0;
    bucketCount = 0;
  };
  for (const s of samples) {
    let idx = Math.min(n - 1, Math.floor(s.life * n));
    if (idx < 0) idx = 0;
    if (idx !== bucketIdx) {
      // 换桶时把上一个桶的末点接到新桶开头，保证相邻带首尾相连、不裂开
      const prevLast = bucket[bucket.length - 1];
      flush();
      bucketIdx = idx;
      if (prevLast) {
        bucket.push(prevLast);
        bucketLifeSum += s.life;
        bucketCount += 1;
      }
    }
    bucket.push({ x: s.x, y: s.y });
    bucketLifeSum += s.life;
    bucketCount += 1;
  }
  flush();
  return out;
}
