/**
 * 平板手势仲裁。
 *
 * 平板上"笔 + 手"是同时存在的：
 *   - 笔尖在写字 → 必须一直是笔
 *   - 手指在滚动/缩放 → 必须是手势
 *   - 掌根压到屏幕 → 不能画出线
 *
 * 这里用一个仲裁器决定"当前这一笔到底算不算落笔"：
 *   1. 笔（pointerType=pen）永远优先，掌根（touch）不影响它
 *   2. 手指 touch 若在笔活动期间落下 → 判为掌根/误触，不落笔
 *   3. 两根以上手指 → 进入多指手势（缩放/平移），取消当前笔画
 *   4. 单指 touch → 只有在允许触摸书写时才落笔
 */

export type TouchRole = "none" | "draw" | "pan" | "gesture" | "ignore";

export interface PointerInfo {
  id: number;
  type: "pen" | "touch" | "mouse";
  x: number;
  y: number;
  pressure: number;
}

interface Tracked {
  id: number;
  type: "pen" | "touch" | "mouse";
  x: number;
  y: number;
  startX: number;
  startY: number;
  startTime: number;
  moved: boolean;
  /** 被判为掌根/误触的手指，不计入双指手势 */
  ignored: boolean;
}

/**
 * 双指手势的实时状态。
 *
 * 用**绝对量**而不是每帧的相对增量，理由有两个：
 *
 * 1. 正确性：浏览器每根手指各发一次 pointermove，
 *    两根手指的移动是**分两次事件**到达的。
 *    用相对增量的话，第一根手指移动时第二根还停在原地，
 *    算出来的距离只有真实值的一半（实测 174/160，应为 188/160）。
 *    绝对量永远取「两指当前的最新位置」，不存在这个半程问题。
 *
 * 2. 无累积误差：缩放比由「当前距离 / 起始距离」直接得出，
 *    不会因为逐帧相乘而漂移。
 */
export interface PinchInfo {
  /** 两指当前距离（px） */
  dist: number;
  /** 两指中心的视口横坐标 */
  cx: number;
  /** 两指中心的视口纵坐标 */
  cy: number;
}

export interface GestureCallbacks {
  /** 判定这一指是否要落笔 */
  onRoleChange?: (role: TouchRole, info: PointerInfo) => void;
  /** 多指手势开始（此时要取消正在写的笔画） */
  onGestureStart?: (info: PinchInfo) => void;
  /** 双指缩放：每次移动回调一次，info 是**当前**的绝对状态 */
  onGestureMove?: (info: PinchInfo) => void;
  onGestureEnd?: () => void;
}

export class TouchArbiter {
  private pointers = new Map<number, Tracked>();
  private penActive = false;
  private touchCount = 0;
  private gesturing = false;
  /**
   * 双指手势结束后的「余指禁行」。
   *
   * 真机现象：捏合放大缩小，松手时两根手指几乎不可能同时离开屏幕——
   * 第一根抬起就结束手势，第二根还按在纸上。那一瞬间它从「手势的一根手指」
   * 变成「一根普通手指」，会被判成 pan，页面立刻跟着它跑；
   * 抬手时再补一下惯性。用户看到的就是「捏合完页面自己跳走了」。
   *
   * 所以：手势一结束就把标记立起来，剩下的手指在**全部抬起之前**
   * 一律不产生任何动作（既不滚动也不落笔）。只有新的双指组合
   * 才允许重新开始手势。
   */
  private holdAfterGesture = false;
  private cb: GestureCallbacks;

  constructor(cb: GestureCallbacks = {}) {
    this.cb = cb;
  }

  get isGesturing(): boolean {
    return this.gesturing;
  }

  get hasPen(): boolean {
    return this.penActive;
  }

  /** 当前活跃的笔（有笔在用时，手指一律不算落笔） */
  get penDown(): boolean {
    return this.penActive;
  }

  /** 触点数（不含笔与鼠标） */
  get touchCountNow(): number {
    return this.touchCount;
  }

  down(e: PointerInfo): TouchRole {
    const prev = this.pointers.get(e.id);
    this.pointers.set(e.id, {
      id: e.id,
      type: e.type,
      x: e.x,
      y: e.y,
      startX: e.x,
      startY: e.y,
      startTime: performance.now(),
      moved: prev?.moved ?? false,
      ignored: prev?.ignored ?? false,
    });

    if (e.type === "pen") {
      this.penActive = true;
      this.cancelGesture();
      const role: TouchRole = "draw";
      this.cb.onRoleChange?.(role, e);
      return role;
    }

    if (e.type === "touch") {
      this.touchCount++;
      // 笔正在写的时候落下的手指 = 掌根
      if (this.penActive) {
        const p = this.pointers.get(e.id);
        if (p) p.ignored = true;
        const role: TouchRole = "ignore";
        this.cb.onRoleChange?.(role, e);
        return role;
      }
      // 只有"有效手指"才算双指：忽略之前被判为掌根的手指
      const liveTouches = [...this.pointers.values()].filter(
        (p) => p.type === "touch" && !p.ignored
      ).length;
      this.touchCount = liveTouches;
      if (this.touchCount >= 2) {
        // 又凑齐两根：上一个手势的余指禁行立刻作废，开始新手势
        this.holdAfterGesture = false;
        this.beginGesture();
        const role: TouchRole = "gesture";
        this.cb.onRoleChange?.(role, e);
        return role;
      }
      /*
       * 上一个双指手势还有手指没抬完：这一根是"余指"，什么都不做。
       * 不能判成 pan —— 那会让页面跟着它跑（见 holdAfterGesture 注释）。
       */
      if (this.holdAfterGesture) {
        const role: TouchRole = "ignore";
        this.cb.onRoleChange?.(role, e);
        return role;
      }
      // 单指：交给上层决定是滚动还是书写
      const role: TouchRole = "pan";
      this.cb.onRoleChange?.(role, e);
      return role;
    }

    // 鼠标
    const role: TouchRole = "draw";
    this.cb.onRoleChange?.(role, e);
    return role;
  }

  move(e: PointerInfo): TouchRole {
    const p = this.pointers.get(e.id);
    if (!p) return "ignore";
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    if (Math.abs(e.x - p.startX) > 3 || Math.abs(e.y - p.startY) > 3) p.moved = true;
    p.x = e.x;
    p.y = e.y;

    if (e.type === "pen") {
      this.cb.onRoleChange?.("draw", e);
      return "draw";
    }

    if (e.type === "touch") {
      if (this.penActive) {
        this.cb.onRoleChange?.("ignore", e);
        return "ignore";
      }
      if (this.gesturing) {
        this.updateGesture();
        this.cb.onRoleChange?.("gesture", e);
        return "gesture";
      }
      // 手势已结束但还有手指没抬：这根手指的移动一律不算数
      if (this.holdAfterGesture) {
        this.cb.onRoleChange?.("ignore", e);
        return "ignore";
      }
      if (this.touchCount >= 2) {
        this.holdAfterGesture = false;
        this.beginGesture();
        this.cb.onRoleChange?.("gesture", e);
        return "gesture";
      }
      this.cb.onRoleChange?.("pan", e);
      return "pan";
    }

    this.cb.onRoleChange?.("draw", e);
    return "draw";
  }

  up(e: PointerInfo): TouchRole {
    const p = this.pointers.get(e.id);
    /*
     * 幂等保护：同一根手指的 pointerup 可能被处理两次
     * （window 捕获阶段的 globalUp + docEl 冒泡阶段的委托）。
     * 没有这道闸，touchCount 会被多减一次。
     */
    if (!p) return "ignore";
    this.pointers.delete(e.id);

    if (e.type === "pen") {
      this.penActive = this.hasTrackedPen();
      const role: TouchRole = "draw";
      this.cb.onRoleChange?.(role, e);
      return role;
    }

    if (e.type === "touch") {
      // 掌根（被忽略的手指）从没计入 touchCount，抬起时也不能减
      if (!p.ignored) this.touchCount = Math.max(0, this.touchCount - 1);
      if (this.gesturing) {
        if (this.touchCount < 2) this.endGesture();
        this.cb.onRoleChange?.("ignore", e);
        return "ignore";
      }
      // 所有手指都抬完了，余指禁行解除
      if (this.touchCount === 0) this.holdAfterGesture = false;
      if (this.holdAfterGesture) {
        this.cb.onRoleChange?.("ignore", e);
        return "ignore";
      }
      this.cb.onRoleChange?.("pan", e);
      return "pan";
    }

    this.cb.onRoleChange?.("draw", e);
    return "draw";
  }

  private hasTrackedPen(): boolean {
    for (const p of this.pointers.values()) if (p.type === "pen") return true;
    return false;
  }

  private beginGesture(): void {
    if (this.gesturing) return;
    this.gesturing = true;
    const st = this.pinchState();
    this.cb.onGestureStart?.(st ?? { dist: 0, cx: 0, cy: 0 });
  }

  private endGesture(): void {
    if (!this.gesturing) return;
    this.gesturing = false;
    // 还有手指按在屏上 → 它们从这一刻起是"余指"，不许产生滚动
    this.holdAfterGesture = this.touchCount > 0;
    this.cb.onGestureEnd?.();
  }

  private cancelGesture(): void {
    this.endGesture();
  }

  private pinchState(): { dist: number; cx: number; cy: number } | null {
    const touches = [...this.pointers.values()].filter(
      (p) => p.type === "touch" && !p.ignored
    );
    if (touches.length < 2) return null;
    const [a, b] = touches;
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    };
  }

  /**
   * 双指状态更新。
   *
   * 只报绝对量（当前距离 + 当前中心），不报每帧增量。
   * 缩放比由调用方拿「当前距离 / 手势起始距离」自己算。
   */
  private updateGesture(): void {
    const now = this.pinchState();
    if (!now) return;
    this.cb.onGestureMove?.(now);
  }

  reset(): void {
    this.pointers.clear();
    this.penActive = false;
    this.touchCount = 0;
    this.gesturing = false;
    this.holdAfterGesture = false;
  }
}

/** 判断两个点是否接近（用于双击检测） */
export function isDoubleTap(
  a: { x: number; y: number; t: number },
  b: { x: number; y: number; t: number } | null,
  maxDist = 28,
  maxDelay = 320
): boolean {
  if (!b) return false;
  return (
    Math.hypot(a.x - b.x, a.y - b.y) <= maxDist && a.t - b.t <= maxDelay
  );
}
