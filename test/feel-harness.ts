import { OneEuroFilter, shapePressure, speedWidthFactor } from "../src/filter";
import { predictTail, effectivePressures, strokePath, drawStroke, paintStroke, invalidateStroke } from "../src/ink";
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

async function main() {
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

  await sleep(60);
  log(failures === 0 ? "ALL PASS" : failures + " FAILED");
  document.title = "DONE";
}

main();
