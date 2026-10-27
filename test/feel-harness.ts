import { OneEuroFilter, shapePressure, speedWidthFactor } from "../src/filter";
import { predictTail, effectivePressures } from "../src/ink";
import type { Pt } from "../src/types";

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

  await sleep(60);
  log(failures === 0 ? "ALL PASS" : failures + " FAILED");
  document.title = "DONE";
}

main();
