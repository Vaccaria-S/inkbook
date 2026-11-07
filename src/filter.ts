/**
 * 1€ 滤波器（One Euro Filter）
 *
 * 用来滤掉手抖和数位笔的采样噪声。普通低通滤波会把快笔也抹平，
 * 1€ 滤波会根据速度动态调整截止频率：慢的时候滤得狠（去抖），
 * 快的时候滤得轻（不拖尾），所以写快写慢都跟手。
 *
 * 参考 Casiez et al. 2012, "1€ Filter: A Simple Speed-based Low-pass Filter".
 */
export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;

  private xPrev = 0;
  private dxPrev = 0;
  private yPrev = 0;
  private dyPrev = 0;
  private hasPrev = false;
  private lastTime = 0;

  constructor(minCutoff = 1.2, beta = 0.03, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  /** 换档时只改参数，不要换实例，否则历史状态就丢了 */
  configure(minCutoff: number, beta: number, dCutoff = 1.0): void {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  reset(): void {
    this.hasPrev = false;
    this.xPrev = 0;
    this.yPrev = 0;
    this.dxPrev = 0;
    this.dyPrev = 0;
    this.lastTime = 0;
  }

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  private static lowpass(value: number, prev: number, alpha: number): number {
    return alpha * value + (1 - alpha) * prev;
  }

  filter(x: number, y: number, timestamp: number): { x: number; y: number } {
    if (!this.hasPrev) {
      this.hasPrev = true;
      this.xPrev = x;
      this.yPrev = y;
      this.dxPrev = 0;
      this.dyPrev = 0;
      this.lastTime = timestamp;
      return { x, y };
    }

    // 时间倒退（切页、时钟跳变）时按 16ms 处理，避免除零
    let dt = (timestamp - this.lastTime) / 1000;
    if (!Number.isFinite(dt) || dt <= 0) dt = 0.016;
    dt = Math.min(dt, 0.1);
    this.lastTime = timestamp;

    const dx = (x - this.xPrev) / dt;
    const dy = (y - this.yPrev) / dt;

    const aD = OneEuroFilter.alpha(this.dCutoff, dt);
    const dxHat = OneEuroFilter.lowpass(dx, this.dxPrev, aD);
    const dyHat = OneEuroFilter.lowpass(dy, this.dyPrev, aD);

    const speed = Math.hypot(dxHat, dyHat);
    const cutoff = this.minCutoff + this.beta * speed;
    const a = OneEuroFilter.alpha(cutoff, dt);

    const xHat = OneEuroFilter.lowpass(x, this.xPrev, a);
    const yHat = OneEuroFilter.lowpass(y, this.yPrev, a);

    this.xPrev = xHat;
    this.yPrev = yHat;
    this.dxPrev = dxHat;
    this.dyPrev = dyHat;

    return { x: xHat, y: yHat };
  }
}

/**
 * 缩放手感归一化因子（以 0.8 倍为基准）。
 *
 * 输入管线里的速度、采样距离、滤波 beta 都是按**页面坐标**算的：
 * 同一屏幕手速在 2.8 倍时换算成页面速度只有 1/3.5，于是
 *   · 1€ 滤波的 cutoff 变低 → 放大后拐角被抹圆、细节变差；
 *   · 采样阈值 0.55 页面单位在屏幕上变成 1.54px → 点变稀、曲率被切角；
 *   · 速度联动失效 → 快笔不再收窄。
 * 把速度/距离乘上这个因子，等价于在**屏幕尺度**上调参，不同缩放下手感一致。
 *
 * 0.8 是 fit 默认值：<=0.8 不放大（避免低倍时采样过密）。
 */
export function zoomNormalization(zoom: number): number {
  // 非法值直接回基准 1：不能先兜底成 z=1 再去算 max(1, 1/0.8)——那是 1.25
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.max(1, zoom / 0.8);
}

/**
 * 压感整形：把设备原始压力映射成"看起来自然"的力度。
 *
 * 原始压力是线性且下限很低的，直接用会出现两种难看的效果：
 * 轻碰几乎没线、重按糊成一团。曲线做三件事：
 * 1. 抬底噪：低于阈值直接判为没按；
 * 2. 提亮段：让轻到中等压力的区分度更高（这一段是人最敏感的）；
 * 3. 压上限：重按时趋于饱和，不会无限变粗。
 */
export function shapePressure(raw: number, sensitivity = 1, gamma = 0.72): number {
  if (!Number.isFinite(raw)) return 0.5;
  let p = Math.max(0, Math.min(1, raw));

  /*
   * 灵敏度：围绕 0.5 做对比拉伸。
   *
   * 必须先判 isFinite：Math.max(0.1, NaN) 是 NaN（不是 0.1），
   * 一旦 sensitivity 是 NaN/Infinity，下面所有运算都会把 NaN 传回
   * pressureFor → stroke.points → 存档（INK-179）。这是最后一层纯函数
   * 防线，非法值按默认灵敏度 1 处理，绝不把脏值往下游传。
   */
  const s = Number.isFinite(sensitivity) ? Math.max(0.1, sensitivity) : 1;
  p = Math.max(0, Math.min(1, 0.5 + (p - 0.5) * s));

  // 提底噪
  p = p < 0.03 ? 0 : (p - 0.03) / 0.97;

  // 提亮段 + 压上限
  const shaped = Math.pow(p, gamma) * (1 - 0.12 * p * p);

  return Math.max(0.04, Math.min(1, shaped));
}

/**
 * 速度 → 粗细系数。写得快的地方笔画自然变细，这是真笔记 App 的手感来源之一。
 * 返回 0.55–1.08 之间的倍率。
 */
export function speedWidthFactor(speed: number, maxSpeed = 2.2): number {
  const t = Math.max(0, Math.min(1, speed / maxSpeed));
  // 快速书写时收窄，但不至于断掉
  return 1.06 - 0.5 * Math.pow(t, 0.85);
}
