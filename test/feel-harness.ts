import { OneEuroFilter, shapePressure, speedWidthFactor, zoomNormalization } from "../src/filter";
import { predictTail, effectivePressures, strokePath, drawStroke, paintStroke, invalidateStroke } from "../src/ink";
import {
  BookEditor,
  inkRenderDpr,
  inkRenderDprForZoom,
  SUPERSAMPLE_MAX_ZOOM,
} from "../src/editor";
import { BookStore } from "../src/store";
import { createBook } from "../src/types";
import type { Pt, Stroke } from "../src/types";

const lines: string[] = [];
const out = document.getElementById("out")!;
const log = (s: string) => {
  lines.push(s);
  out.textContent = lines.join("\n");
};
let failures = 0;
const pass = (ok: boolean, label: string) => {
  if (!ok) failures++;
  log((ok ? "PASS " : "FAIL ") + label);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ============================================================================
 * 跨缩放手感一致性（双 zoom A/B）
 *
 * 用户报「放大之后再写，笔迹识别得比较粗糙」。根因：输入管线把**屏幕尺度**
 * 的手速/位移当成了**页面单位**——同一手速在 2.8 倍时换算到页面坐标只剩
 * 1/3.5，于是滤波过度平滑（滞后 9.5px vs 3.1px）、采样阈值变大
 * （1.54px vs 0.44px）、快笔收窄失效（压力 0.97 vs 0.80）。
 *
 * 修复（src/filter.ts 的 zoomNormalization + editor.ts 三处接入）之后，
 * **同一条屏幕轨迹**在 0.8 倍与 2.8 倍下应该得到同一条**屏幕上的**笔迹：
 * 路径一致、压力一致。
 *
 * 这段是**真指针事件**的 A/B：真的派发 pointerdown/pointermove/pointerup，
 * 走完整的 editor 输入管线（1€ 滤波 → 采样阈值 → 压力整形 → 速度收窄），
 * 而不是直接调纯函数——纯函数测试锁不住「有没有漏接一处归一化」。
 *
 * 时间轴用 Object.defineProperty 覆盖 event.timeStamp 写死，
 * 这样两次 A/B 拿到**完全相同**的时间戳，差异只可能来自缩放本身。
 * （PointerEvent 的 timeStamp 是可覆盖的自有属性，实测生效。）
 * ========================================================================== */

/** 一条屏幕轨迹：相对页面左上角的 CSS px 位移 + 时间戳 */
interface TrackPoint {
  /** 相对页面左上角的屏幕位移（CSS px） */
  sx: number;
  sy: number;
  /** 事件时间戳（ms） */
  t: number;
}

/**
 * 屏幕轨迹：微移动 + 一个小转折。
 *
 * 微移动每步 0.5 屏幕 px——这是关键：旧实现里 2.8 倍的采样阈值是
 * 1.54 **屏幕** px（0.55 页面单位），所以这些微移会被整段丢掉；
 * 新实现里阈值是 0.44 屏幕 px（0.55/3.5 页面单位），两个缩放都采得到。
 * 后面的快笔段（每步 12 屏幕 px）把速度拉起来，让压力差显现出来。
 */
function buildScreenTrack(): TrackPoint[] {
  const raw: Array<[number, number]> = [];
  let x = 0;
  let y = 0;
  raw.push([x, y]); // 落笔
  for (let i = 0; i < 20; i++) {
    x += 0.5; // 细密微移动 0.5px/步
    raw.push([x, y]);
  }
  for (let i = 0; i < 8; i++) {
    x += 12; // 快笔 12px/步
    raw.push([x, y]);
  }
  for (let i = 0; i < 8; i++) {
    y += 12; // 小转折
    raw.push([x, y]);
  }
  // 时间轴写死：两次 A/B 完全一致，差异只可能来自缩放
  return raw.map((p, i) => ({ sx: p[0], sy: p[1], t: 1000 + i * 16 }));
}

/** 一次 A/B 的结果：页面坐标路径 + 压力序列 */
interface AbRun {
  /** 页面坐标路径（未经缩放换算） */
  points: Pt[];
}

/**
 * 造一个跟真实 Obsidian 一致的编辑器宿主。
 *
 * 尺寸必须够大：2.8 倍时页面是 794×2.8 = 2223px 宽，
 * 容器放不下就画不到纸上，轨迹会被裁掉。
 */
function makeAbHost(): { host: HTMLElement; editor: BookEditor; store: BookStore } {
  const root = document.createElement("div");
  root.className = "mb-root";
  root.style.cssText =
    "position:absolute;left:0;top:0;width:2600px;height:3400px;overflow:auto;display:flex;flex-direction:column";
  const host = document.createElement("div");
  host.className = "mb-host";
  root.appendChild(host);
  document.body.appendChild(root);
  const book = createBook("缩放一致性", "blank", "white");
  const store = new BookStore(book);
  const editor = new BookEditor(host, store, {
    penOnly: false,
    pressure: 1,
    onState: () => {},
    onChange: () => {},
    onPageChange: () => {},
  });
  return { host, editor, store };
}

/**
 * 把整条屏幕轨迹派发成真指针事件，返回这次落笔写出的笔迹。
 */
async function drawTrack(
  editor: BookEditor,
  store: BookStore,
  zoom: number,
  track: TrackPoint[],
  pointerId: number
): Promise<AbRun> {
  editor.setZoom(zoom);
  await sleep(200); // 等布局与页宽稳定

  const rec = (editor as any).recs[0];
  const pageEl = rec.pageEl as HTMLElement;
  const rect = pageEl.getBoundingClientRect();
  const before = store.strokeCount;

  /*
   * 派发真指针事件。
   *
   * timeStamp 用 defineProperty 写死（PointerEvent 的 timeStamp 是可覆盖的
   * 自有属性），让两次 A/B 的时间轴逐点相同。
   * clientX/clientY 用构造器给小数——PointerEvent 保留亚像素，实测 100.5
   * 原样传到 handler，微移动的 0.5px 步长才不会被抹平。
   */
  const fire = (type: string, p: TrackPoint, buttons: number) => {
    const e = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId,
      pointerType: "pen",
      isPrimary: true,
      button: 0,
      buttons,
      clientX: rect.left + p.sx,
      clientY: rect.top + p.sy,
      pressure: type === "pointerup" ? 0 : 0.5,
    });
    Object.defineProperty(e, "timeStamp", { value: p.t, configurable: true });
    pageEl.dispatchEvent(e);
  };

  fire("pointerdown", track[0], 1);
  for (let i = 1; i < track.length; i++) fire("pointermove", track[i], 1);
  const last = track[track.length - 1];
  fire("pointerup", last, 0);
  await sleep(120);

  const strokes = store.page.layers[0].strokes;
  const stroke = strokes[strokes.length - 1];
  if (strokes.length !== before + 1 || !stroke) return { points: [] };
  return { points: stroke.points };
}

/**
 * 按弧长重采样一条路径。
 *
 * 为什么不能直接逐点比：两个缩放下采样点**数量**可能不同
 * （旧实现 34 vs 22 点），逐点比就变成了「拿第 5 点比第 5 点」，
 * 后面整段都错位。按弧长重采样是形状层面的比较，公平且稳定。
 */
function resampleByArcLength(pts: Pt[], n: number): Pt[] {
  if (!pts.length) return [];
  if (pts.length === 1) return Array.from({ length: n }, () => pts[0]);
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = cum[cum.length - 1];
  const out: Pt[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / (n - 1)) * total;
    while (j < cum.length - 2 && cum[j + 1] < target) j++;
    const seg = cum[j + 1] - cum[j];
    const t = seg > 1e-9 ? (target - cum[j]) / seg : 0;
    const a = pts[j];
    const b = pts[j + 1];
    out.push([
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ]);
  }
  return out;
}

/** 页面坐标 → 屏幕坐标：页面 1 单位 = zoom 个 CSS px */
function toScreen(pts: Pt[], zoom: number): Pt[] {
  return pts.map((p) => [p[0] * zoom, p[1] * zoom, p[2]] as Pt);
}

/** 两条路径逐点最大距离 */
function maxDev(a: Pt[], b: Pt[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
  return m;
}

async function main() {
  /* -------------------- 缩放手感归一化 -------------------- */
  {
    pass(zoomNormalization(0.8) === 1, "缩放归一化：0.8 倍是基准（1.0）");
    pass(
      Math.abs(zoomNormalization(2.8) - 3.5) < 1e-9,
      "缩放归一化：2.8 倍 = 3.5（速度/采样阈值换回屏幕尺度）"
    );
    pass(zoomNormalization(0.5) === 1, "缩放归一化：低倍不放大（下限 1）");
    pass(zoomNormalization(NaN) === 1, "缩放归一化：非法 zoom 回落 1");
  }

  /* -------------------- 手感参数边界（INK-179 / INK-180） --------------------
   *
   * `Math.max(0.1, NaN) === NaN`：旧实现只做了下限兜底，sensitivity 一旦
   * 是 NaN（脏 data.json、同步工具写进来的 null），整条压感链路会把 NaN
   * 传回 stroke.points 并写进存档，永久污染这一笔。下面锁住四层防线里
   * 纯函数与运行时入口这两层。
   * ------------------------------------------------------------------------ */
  {
    const nanP = shapePressure(0.5, NaN);
    pass(
      Number.isFinite(nanP) && Math.abs(nanP - shapePressure(0.5, 1)) < 1e-12,
      "shapePressure：sensitivity=NaN 回落默认 1，绝不返回 NaN（得到 " + nanP + "）"
    );
    pass(
      Number.isFinite(shapePressure(0.5, Infinity)) &&
        Number.isFinite(shapePressure(0.5, -Infinity)),
      "shapePressure：sensitivity=±Infinity 也不返回 NaN"
    );
    pass(
      Number.isFinite(shapePressure(NaN, 1)),
      "shapePressure：原始压力 NaN 本身也按中性 0.5 兜住"
    );
  }
  {
    const { host, editor, store } = makeAbHost();
    editor.setPressure(NaN);
    editor.setSmoothing(NaN);
    const opts = (editor as any).opts;
    pass(
      opts.pressure === 1 && opts.smoothing === 0.55,
      "setPressure/setSmoothing：NaN 回落默认（" + opts.pressure + "/" + opts.smoothing + "）"
    );
    editor.setPressure(99);
    editor.setSmoothing(-3);
    pass(
      opts.pressure === 1.5 && opts.smoothing === 0,
      "setPressure/setSmoothing：越界值夹到面板区间（" + opts.pressure + "/" + opts.smoothing + "）"
    );
    // 构造时直接传进来的脏 opts（不经过 setter）也不能把 NaN 写进笔迹
    const badHost = document.createElement("div");
    badHost.className = "mb-host";
    host.parentElement!.appendChild(badHost);
    const badStore = new BookStore(createBook("脏手感", "blank", "white"));
    const badEditor = new BookEditor(badHost, badStore, {
      pressure: NaN,
      smoothing: NaN,
      onState: () => {},
      onChange: () => {},
      onPageChange: () => {},
    });
    (badEditor as any).pressureFor({ pointerType: "pen", pressure: 0.5 } as any, 1, 16);
    pass(
      Number.isFinite((badEditor as any).lastPressure) && (badEditor as any).lastPressure > 0,
      "构造时脏 opts 也兜住：pressureFor 不产出 NaN（" + (badEditor as any).lastPressure + "）"
    );
    badEditor.destroy();
    editor.destroy();
    store.page.layers[0].strokes.length = 0;
    document.querySelectorAll(".mb-root").forEach((el) => el.remove());
  }

  /* -------------------- 桌面端渲染超采样（INK-162） --------------------
   *
   * 用户报「用电脑写的时候边缘不够丝滑」。根因（实测 5 seed × 2 笔画 ×
   * 真 Chrome 合成，每格 n=10）：dpr=1 时画布 backing 只有 1 个设备像素/
   * 页面单位，笔迹边缘**一次采样就定了** → 呈台阶状。
   *
   * 实测硬台阶占比（越低越丝滑）：
   *   z=0.8  鼠标 17.61% → 5.26%（dpr 1→1.25）   笔 17.14% → 5.77%
   *   z=2.8  鼠标  7.34% → 2.80%                  笔  8.47% → 3.87%
   *
   * 为什么是 1.25 而不是 2：**整数比会被重新量化**——dpr=2 时浏览器做
   * 2:1 降采样，每个输出像素恰是 2×2 源像素的平均 → 已抗锯齿的边缘被
   * 压成一档灰阶 → 硬台阶反弹回 17.37%（比 1.25 差 3 倍多）。
   * 非整数比（1.25）没有这个问题。
   *
   * 断言怎么写才能**不依赖测试机实际 dpr**：
   * 无头 Edge 的 devicePixelRatio 可能是 1 也可能是 2，两种都要能过。
   * 所以分两层：
   *   ① 纯函数层：inkRenderDpr(1) === 1.25、inkRenderDpr(2) === 2 —— 与机器无关
   *   ② 集成层：现读 window.devicePixelRatio，按它推出应有的渲染 dpr，
   *      再跟编辑器实际画出来的 backing 比
   * ------------------------------------------------------------------ */
  {
    /* ① 纯函数层：跟测试机 dpr 完全无关 */
    pass(
      inkRenderDpr(1) === 1.25,
      "超采样：设备 dpr=1 → 渲染 dpr 补到 1.25（桌面端笔迹边缘更丝滑）"
    );
    pass(
      inkRenderDpr(2) === 2,
      "超采样：设备 dpr=2 → 渲染 dpr 仍是 2（平板手感不动）"
    );
    pass(
      inkRenderDpr(1.5) === 1.5 && inkRenderDpr(0) === 1.25,
      "超采样：dpr=1.5 保持 1.5、非法值按 1 处理"
    );

    /*
     * 超采样只在小倍率生效（2026-11-07 补）：
     * 桌面 dpr=1.25 在最大缩放 2.8 倍时单页 83MB、两块 167MB，
     * 超过 MOUNT_BUDGET_BYTES(160MB)，而 MIN_MOUNTED=2 是硬下限卸不掉。
     * 所以高倍时退回原生 dpr —— 那一档笔画本身已经很粗，超采样收益小。
     */
    pass(
      inkRenderDprForZoom(1, 0.8) === 1.25 &&
        inkRenderDprForZoom(1, SUPERSAMPLE_MAX_ZOOM) === 1.25,
      "超采样：日常书写倍率（0.8 / " +
        SUPERSAMPLE_MAX_ZOOM +
        " 倍）仍然超采样到 1.25"
    );
    pass(
      inkRenderDprForZoom(1, 2.8) === 1 && inkRenderDprForZoom(1, 1.6) === 1,
      "超采样：高倍缩放（1.6 / 2.8 倍）退回原生 dpr=1（内存不超预算）"
    );
    pass(
      inkRenderDprForZoom(2, 0.8) === 2 && inkRenderDprForZoom(2, 2.8) === 2,
      "超采样：平板（dpr=2）在任何倍率都不动"
    );
    pass(
      inkRenderDprForZoom(1, 0) === 1 && inkRenderDprForZoom(1, -1) === 1,
      "超采样：非法 zoom（0 / 负数）退回原生 dpr，不会误超采样"
    );
    /*
     * 内存红线：按「挂载上限 × 单页」扫全档缩放，任何一档都不许超
     * MOUNT_BUDGET_BYTES(160MB)。这条锁住上面那个阈值不被随手改大。
     */
    {
      const BUDGET = 160 * 1024 * 1024;
      const MIN_MOUNTED = 2;
      const MAX_MOUNTED = 8;
      let worst = 0;
      let worstZoom = 0;
      for (const z of [0.3, 0.5, 0.67, 0.8, 1, 1.25, 1.3, 1.6, 2, 2.8]) {
        const d = inkRenderDprForZoom(1, z);
        const perPage = 794 * z * d * 1123 * z * d * 4 * 2; // 两块画布
        const limit = Math.max(MIN_MOUNTED, Math.min(MAX_MOUNTED, Math.floor(BUDGET / perPage)));
        const used = limit * perPage;
        if (used > worst) {
          worst = used;
          worstZoom = z;
        }
      }
      pass(
        worst <= BUDGET,
        "超采样：全档缩放最坏占用 " +
          (worst / 1048576).toFixed(0) +
          "MB（zoom=" +
          worstZoom +
          "）≤ MOUNT_BUDGET_BYTES 160MB"
      );
    }

    /* ② 集成层：编辑器实际画出来的 backing */
    const { editor, store } = makeAbHost();
    await sleep(500); // 等页面挂载

    const rawDpr = Math.min(window.devicePixelRatio || 1, 2);
    const wantDpr = inkRenderDprForZoom(rawDpr, 0.8);

    editor.setZoom(0.8);
    await sleep(400);

    const rec = (editor as any).recs[0];
    const canvas = rec.canvas as HTMLCanvasElement;
    const cssW = canvas.getBoundingClientRect().width;
    const actualDpr = cssW > 0 ? canvas.width / cssW : 0;

    pass(
      canvas.width > 0 && cssW > 0,
      "超采样：画布已挂载（backing " + canvas.width + "×" + canvas.height + "）"
    );
    pass(
      Math.abs(actualDpr - wantDpr) < 0.02,
      "超采样：实际渲染 dpr = " +
        actualDpr.toFixed(3) +
        "（期望 " +
        wantDpr.toFixed(2) +
        "，设备 dpr=" +
        rawDpr +
        "）"
    );

    /*
     * 内存账（红线 MAX_CANVAS_PIXELS = 16M 不许降，这里是加不是减）：
     * 单块画布 = 794×zoom×dpr × 1123×zoom×dpr 像素，必须仍然远小于 16M。
     */
    const zoom = 0.8;
    const perCanvasPx = 794 * zoom * wantDpr * 1123 * zoom * wantDpr;
    pass(
      perCanvasPx < 16_000_000,
      "超采样：单块画布 " +
        (perCanvasPx / 1e6).toFixed(2) +
        "M px，仍在 16M 红线内"
    );

    editor.destroy();
    document.querySelectorAll(".mb-root").forEach((el) => el.remove());
    void store;
  }

  /* -------------------- 1€ 滤波：去抖 -------------------- */
  {
    const f = new OneEuroFilter(1.0, 0.02, 1.0);
    // 静止抖动：同一个真值 + ±0.8 的噪声
    let sum = 0;
    let n = 0;
    let t = 0;
    for (let i = 0; i < 60; i++) {
      t += 16;
      const noisy = 100 + (i % 2 === 0 ? 0.8 : -0.8);
      const outp = f.filter(noisy, 50, t);
      sum += outp.x;
      n++;
    }
    const avg = sum / n;
    pass(Math.abs(avg - 100) < 0.35, "滤波后静止抖动幅度收敛到 " + (Math.abs(avg - 100)).toFixed(3));

    // 快速移动时不能被滤掉（拖尾）
    const g = new OneEuroFilter(1.0, 0.02, 1.0);
    let tt = 0;
    let last = 0;
    for (let i = 0; i < 20; i++) {
      tt += 16;
      const outp = g.filter(100 + i * 20, 50, tt);
      last = outp.x;
    }
    const target = 100 + 19 * 20;
    pass(last > target - 60, "快速移动时滤波不拖尾（落后 " + (target - last).toFixed(0) + "）");
  }

  /* -------------------- 压感整形 -------------------- */
  {
    const light = shapePressure(0.1, 1);
    const mid = shapePressure(0.5, 1);
    const heavy = shapePressure(0.95, 1);
    pass(light < mid && mid < heavy, "压感单调递增：" + light.toFixed(3) + " / " + mid.toFixed(3) + " / " + heavy.toFixed(3));
    pass(light > 0.03, "轻触仍可见（下限不归零）：" + light.toFixed(3));
    pass(heavy < 1.0, "重按趋于饱和不无限粗：" + heavy.toFixed(3));

    // 灵敏度提高后，中段区分度应该变大
    const d1 = shapePressure(0.7, 1) - shapePressure(0.3, 1);
    const d2 = shapePressure(0.7, 1.5) - shapePressure(0.3, 1.5);
    pass(d2 > d1, "提高灵敏度后中段区分度变大：" + d1.toFixed(3) + " → " + d2.toFixed(3));

    // 极端输入不崩
    pass(Number.isFinite(shapePressure(NaN)), "NaN 压力安全兜底");
    pass(shapePressure(5, 1) <= 1 && shapePressure(-3, 1) >= 0, "越界压力被夹住");
  }

  /* -------------------- 速度—粗细联动 -------------------- */
  {
    const slow = speedWidthFactor(0.05);
    const fast = speedWidthFactor(2.0);
    pass(slow > fast, "写得快笔画更细：" + slow.toFixed(3) + " → " + fast.toFixed(3));
    pass(speedWidthFactor(999) > 0.3, "极速时仍保留可见粗细");
  }

  /* -------------------- 笔画预测 -------------------- */
  {
    const pts: Pt[] = [];
    for (let i = 0; i <= 10; i++) pts.push([100 + i * 10, 200, 0.6]);
    const tail = predictTail(pts, 3, 0.7, 24);
    pass(tail.length > 0, "预测尾巴有 " + tail.length + " 个点");
    const last = pts[pts.length - 1];
    const tip = tail[tail.length - 1];
    pass(tip[0] > last[0], "预测方向与运笔方向一致（向右）");
    const gap = tip[0] - last[0];
    pass(gap > 0 && gap < 80, "预测距离合理：" + gap.toFixed(1) + "px");
    pass(tail.every((p) => Math.abs(p[1] - 200) < 0.001), "直线运动预测不偏");

    // 拐弯时预测应跟随转向
    const curve: Pt[] = [];
    for (let i = 0; i <= 12; i++) curve.push([200 + i * 8, 200 + i * i * 1.2, 0.6]);
    const ctail = predictTail(curve, 3, 0.7, 24);
    pass(ctail.length > 0 && ctail[ctail.length - 1][1] > curve[curve.length - 1][1], "转弯时预测跟随曲率");

    // 点太少时不预测，避免乱飞
    pass(predictTail([[10, 10, 0.5]], 3).length === 0, "单点不预测");
  }

  /* -------------------- 入锋/出锋包络 -------------------- */
  {
    const pts: Pt[] = [];
    let x = 0;
    for (let i = 0; i < 80; i++) {
      const t = i / 79;
      const step = 0.8 + 4.6 * Math.sin(Math.PI * t);
      x += step;
      pts.push([x, 300, 0.7]);
    }
    const stroke = {
      id: "env",
      tool: "pen" as const,
      color: "#000",
      size: 4.2,
      opacity: 1,
      points: pts,
    };
    const ps = effectivePressures(stroke);
    const head = ps.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    const mid = ps.slice(37, 42).reduce((a, b) => a + b, 0) / 5;
    const tail = ps.slice(-5).reduce((a, b) => a + b, 0) / 5;
    pass(head < mid, "起笔比行笔轻：" + head.toFixed(3) + " < " + mid.toFixed(3));
    pass(tail < mid, "收笔比行笔轻：" + tail.toFixed(3) + " < " + mid.toFixed(3));
    const range = Math.max(...ps) / Math.max(0.01, Math.min(...ps));
    pass(range > 2, "粗细动态范围 " + range.toFixed(2) + " > 2");

    // 很短的笔画（点一下）不该被包络吃掉
    const dot: Pt[] = [[0, 0, 0.7], [1, 0, 0.7], [2, 0, 0.7], [3, 0, 0.7]];
    const dps = effectivePressures({ ...stroke, points: dot });
    pass(Math.min(...dps) > 0.3, "短笔画不被包络吃掉：" + Math.min(...dps).toFixed(3));
  }

  /* -------------------- 轮廓几何（INK-109：边缘发毛） -------------------- */
  {
    const mk = (points: Pt[], size = 6): Stroke => ({
      id: "outline",
      tool: "pen",
      color: "#000000",
      size,
      opacity: 1,
      points,
    });
    /** 画一条笔迹，返回深色素引集合与包围盒 */
    const render = (s: Stroke, w = 400, h = 300) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#000";
      ctx.fill(strokePath(s));
      const data = ctx.getImageData(0, 0, w, h).data;
      let minX = w, minY = h, maxX = -1, maxY = -1, dark = 0;
      const cols = new Map<number, number>();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3] > 100) {
            dark++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            cols.set(x, (cols.get(x) ?? 0) + 1);
          }
        }
      }
      return { dark, minX, minY, maxX, maxY, cols, data, w, h };
    };

    // 1) 闭合缝：画一个首尾相接的圆环笔迹，闭合处不应出现「缝外突然判内」的空洞
    {
      const pts: Pt[] = [];
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        pts.push([200 + 90 * Math.cos(a), 150 + 90 * Math.sin(a), 0.7]);
      }
      const r = render(mk(pts, 5));
      /*
       * 沿圆环一周采样笔迹带。起收笔各约 1/12 圈是 perfect-freehand 的 taper
       * 收尖区，本来就没墨，不该算「缺口」；这里只验中段连续。
       * 另外「硬折角」的特征是**连续**掉一段，所以额外断言缺口不相邻。
       */
      let gaps = 0;
      let consecutive = 0;
      let maxConsecutive = 0;
      for (let i = 0; i < 48; i++) {
        if (i < 4 || i > 43) {
          consecutive = 0; // taper 区跳过，不算连续
          continue;
        }
        const a = (i / 48) * Math.PI * 2;
        const x = Math.round(200 + 90 * Math.cos(a));
        const y = Math.round(150 + 90 * Math.sin(a));
        if (r.data[(y * r.w + x) * 4 + 3] <= 100) {
          gaps++;
          consecutive++;
          maxConsecutive = Math.max(maxConsecutive, consecutive);
        } else {
          consecutive = 0;
        }
      }
      pass(gaps === 0, "闭合轮廓中段一圈无空洞/硬折（缺口 " + gaps + " 处）");
      pass(maxConsecutive <= 1, "闭合缝没有连续掉一段（最大连续缺口 " + maxConsecutive + "）");
      pass(r.dark > 2000, "闭合轮廓确实画出来了（深色像素 " + r.dark + "）");
    }

    // 2) 不丢细节：带快速转折的笔迹，包围盒与深色像素量在合理区间（没被抹圆/缩细）
    {
      const pts: Pt[] = [];
      for (let i = 0; i < 60; i++) {
        const t = i / 59;
        // 一段横 + 一个直角转折 + 一段竖
        const x = t < 0.5 ? 40 + t * 2 * 160 : 200;
        const y = t < 0.5 ? 80 : 80 + (t - 0.5) * 2 * 140;
        pts.push([x, y, 0.7]);
      }
      const r = render(mk(pts, 7));
      pass(r.maxX - r.minX > 150 && r.maxY - r.minY > 130,
        "转折笔迹的包围盒没被平滑抹小（" + (r.maxX - r.minX) + "×" + (r.maxY - r.minY) + "）");
      // 直角拐点附近仍要有墨（没被抹成圆角缺口）
      const cx = 200, cy = 80;
      let cornerInk = 0;
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++)
          if (r.data[((cy + dy) * r.w + cx + dx) * 4 + 3] > 100) cornerInk++;
      pass(cornerInk > 20, "直角拐点仍保留笔迹（拐点邻域深色像素 " + cornerInk + "）");
    }

    // 3) 宽度抖动：给压力塞高频小噪声，画出来的轮廓宽度高频抖动应小于输入噪声幅度
    {
      const pts: Pt[] = [];
      for (let i = 0; i < 120; i++) {
        // 相邻点压力 ±0.18 的高频噪声，正是 120Hz 手写笔的设备噪声
        pts.push([20 + i * 3, 150, 0.7 + (i % 2 === 0 ? 0.18 : -0.18)]);
      }
      const r = render(mk(pts, 10));
      const widths: number[] = [];
      for (const [, cnt] of r.cols) widths.push(cnt);
      let jump = 0;
      for (let i = 1; i < widths.length; i++) jump += Math.abs(widths[i] - widths[i - 1]);
      const avgJump = widths.length > 1 ? jump / (widths.length - 1) : 0;
      // 平滑后逐列跳变应该是「个位数像素」，远小于 size=10 的整笔宽度
      pass(avgJump < 4, "高频压力噪声被压住，轮廓逐列跳变 " + avgJump.toFixed(2) + "px（< 4）");
      pass(widths.length > 300, "整条笔迹连续不断（列数 " + widths.length + "）");
    }

    // 4) 导出/嵌入共用：paintStroke 与 drawStroke 画到两块画布逐像素一致
    {
      const pts: Pt[] = [];
      for (let i = 0; i < 40; i++) pts.push([30 + i * 8, 120 + Math.sin(i / 4) * 20, 0.6]);
      const s = mk(pts, 6);
      const a = document.createElement("canvas"); a.width = 400; a.height = 300;
      const b = document.createElement("canvas"); b.width = 400; b.height = 300;
      drawStroke(a.getContext("2d")!, s);
      paintStroke(b.getContext("2d")!, s);
      const da = a.getContext("2d")!.getImageData(0, 0, 400, 300).data;
      const db = b.getContext("2d")!.getImageData(0, 0, 400, 300).data;
      let diff = 0;
      for (let i = 0; i < da.length; i += 4) if (da[i + 3] !== db[i + 3]) diff++;
      pass(diff === 0, "导出位图路径与屏幕路径共用同一份轮廓（像素差 " + diff + "）");
    }

    // 5) 性能红线：200 点笔迹构建 100 次不得超过 200ms（闭合曲线比旧写法多点算术）
    {
      const pts: Pt[] = [];
      for (let i = 0; i < 200; i++) pts.push([20 + i * 1.6, 150 + Math.sin(i / 9) * 30, 0.65]);
      const s = mk(pts, 8);
      const t0 = performance.now();
      // 每次强制失效缓存，测的是真实构建耗时而不是 WeakMap 命中
      for (let k = 0; k < 100; k++) {
        invalidateStroke(s);
        strokePath(s);
      }
      const ms = performance.now() - t0;
      pass(ms < 200, "200 点笔迹 ×100 次 path 构建 " + ms.toFixed(1) + "ms（< 200ms）");
    }
  }


  /* -------------------- 跨缩放手感一致性（双 zoom A/B） -------------------- */
  {
    const { editor, store } = makeAbHost();
    await sleep(500); // 等页面挂载

    const track = buildScreenTrack();
    const Z_LOW = 0.8;
    const Z_HIGH = 2.8;

    const low = await drawTrack(editor, store, Z_LOW, track, 61);
    const high = await drawTrack(editor, store, Z_HIGH, track, 62);

    pass(
      low.points.length >= 20 && high.points.length >= 20,
      "双 zoom A/B：两个缩放都写出了足量点（0.8 倍 " +
        low.points.length +
        " 点 / 2.8 倍 " +
        high.points.length +
        " 点）"
    );

    /*
     * ① 路径一致：把两次的页面坐标换算回屏幕尺度再比。
     *
     * 旧实现这里差 100+ 屏幕 px（采样阈值在 2.8 倍下变成 1.54px，
     * 微移整段被丢掉，路径形状都不一样了）。
     */
    const lowScreen = toScreen(low.points, Z_LOW);
    const highScreen = toScreen(high.points, Z_HIGH);
    const lowShape = resampleByArcLength(lowScreen, 120);
    const highShape = resampleByArcLength(highScreen, 120);
    const pathDev = maxDev(lowShape, highShape);
    pass(
      pathDev < 0.5,
      "跨缩放路径一致：同一屏幕轨迹在 0.8/2.8 倍下换算回屏幕尺度后偏差 " +
        pathDev.toFixed(4) +
        "px（< 0.5，旧实现约 100px）"
    );

    /*
     * ② 压力一致：同一屏幕手速在两个缩放下给出的压力必须一样。
     *
     * 旧实现：0.8 倍压力约 0.80、2.8 倍约 0.97，差 0.17。
     * 新实现：两者完全一致（速度按屏幕尺度算），差 ~0。
     */
    const lowP = lowShape.map((p) => p[2]);
    const highP = highShape.map((p) => p[2]);
    let pressureDiff = 0;
    for (let i = 0; i < lowP.length; i++) {
      pressureDiff = Math.max(pressureDiff, Math.abs(lowP[i] - highP[i]));
    }
    pass(
      pressureDiff < 0.05,
      "跨缩放压力一致：同一屏幕手速在 0.8/2.8 倍下压力最大差 " +
        pressureDiff.toFixed(4) +
        "（< 0.05，旧实现约 0.17）"
    );

    // 附带的诊断信息：两次的实际压力水平，便于人肉核对
    log(
      "  [诊断] 0.8 倍压力 " +
        lowP[0].toFixed(3) +
        "→" +
        lowP[lowP.length - 1].toFixed(3) +
        "，2.8 倍压力 " +
        highP[0].toFixed(3) +
        "→" +
        highP[highP.length - 1].toFixed(3)
    );

    editor.destroy();
    document.querySelectorAll(".mb-root").forEach((el) => el.remove());
  }


  await sleep(60);
  log(failures === 0 ? "ALL PASS" : failures + " FAILED");
  document.title = "DONE";
}

main();
