/**
 * 端到端手感模拟：用真实 PointerEvent 走一遍完整落笔流程，
 * 记录每个采样点，导出成 PNG 让人眼直接判断"像不像手写"。
 */
import { BookEditor } from "../src/editor";
import { BookStore } from "../src/store";
import { createBook, type Pt } from "../src/types";

const W = 760;
const H = 520;

const cv = document.createElement("canvas");
cv.width = W;
cv.height = H;
cv.style.cssText = `display:block;width:${W}px;height:${H}px`;
document.body.appendChild(cv);
const ctx = cv.getContext("2d")!;
ctx.fillStyle = "#fff";
ctx.fillRect(0, 0, W, H);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 造一个"手写汉字"的轨迹：带抖动、起收笔轻、行笔重 */
function handwriting(cx: number, cy: number, scale: number): Array<[number, number, number]> {
  let seedv = 20261026 >>> 0;
  const rnd = () => {
    seedv = (seedv * 1664525 + 1013904223) >>> 0;
    return seedv / 4294967296 - 0.5;
  };
  const pts: Array<[number, number, number]> = [];
  const push = (x: number, y: number, pr: number) =>
    pts.push([cx + x * scale + rnd() * 1.4, cy + y * scale + rnd() * 1.4, pr]);

  // 一横
  for (let i = 0; i <= 34; i++) {
    const t = i / 34;
    push(-120 + t * 240, -60, 0.25 + 0.55 * Math.sin(Math.PI * t) * (0.7 + 0.3 * t));
  }
  // 一竖
  for (let i = 0; i <= 28; i++) {
    const t = i / 28;
    push(-10, -70 + t * 150, 0.3 + 0.5 * Math.sin(Math.PI * Math.min(1, t * 1.3)));
  }
  // 一撇
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    push(-60 + t * 130, -10 + t * 95, 0.3 + 0.6 * t);
  }
  // 一捺
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    push(-5 + t * 135, 15 + t * 80, 0.3 + 0.6 * (1 - t) + 0.2);
  }
  // 一点
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    push(90 + t * 26, 115 + t * 8, 0.25 + 0.5 * Math.sin(Math.PI * t));
  }
  return pts;
}

async function main() {
  const book = createBook("手感测试", "grid", "white");
  const store = new BookStore(book);
  const host = document.createElement("div");
  host.style.cssText = `position:absolute;left:-9999px;width:${W}px;height:${H}px`;
  document.body.appendChild(host);

  const editor = new BookEditor(host, store, {
    smoothing: 0.55,
    prediction: true,
  });
  await sleep(200);

  const pageEl = host.querySelector(".mb-page") as HTMLElement;
  if (!pageEl) {
    document.title = "FATAL";
    return;
  }
  const rect = pageEl.getBoundingClientRect();
  const k = book.width / rect.width;

  const path = handwriting(300, 260, 1);
  const toClient = (p: Pt) => ({
    x: rect.left + p[0] / k,
    y: rect.top + p[1] / k,
  });

  const fire = (type: string, p: Pt, pressure: number, buttons = 1) => {
    const c = toClient(p);
    const ev = new PointerEvent(type, {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      bubbles: true,
      cancelable: true,
      clientX: c.x,
      clientY: c.y,
      pressure,
      buttons,
      button: type === "pointerup" ? 0 : 0,
    });
    pageEl.dispatchEvent(ev);
  };

  // 分成若干"笔画"，每笔独立 down/up
  const strokes: Array<Array<[number, number, number]>> = [];
  let cur: Array<[number, number, number]> = [];
  for (const p of path) {
    cur.push(p);
    // 每 32 个点断一笔
    if (cur.length >= 32) {
      strokes.push(cur);
      cur = [];
    }
  }
  if (cur.length) strokes.push(cur);

  for (const seg of strokes) {
    const first = seg[0];
    fire("pointerdown", first, first[2]);
    for (let i = 1; i < seg.length; i++) {
      const p = seg[i];
      fire("pointermove", p, p[2]);
      await sleep(8);
    }
    const last = seg[seg.length - 1];
    fire("pointerup", last, 0, 0);
    await sleep(20);
  }

  await sleep(200);

  // 把写出来的笔迹画到展示画布上
  const page = store.page;
  const layer = page.layers[0];
  ctx.save();
  ctx.scale(1, 1);
  const { drawStroke } = await import("../src/ink");
  for (const s of layer.strokes) {
    drawStroke(ctx, s);
  }
  ctx.restore();

  ctx.fillStyle = "#333";
  ctx.font = "600 15px system-ui, sans-serif";
  ctx.fillText("鼠标模拟手写 · 新手感引擎", 24, 34);
  ctx.fillStyle = "#999";
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText(`共 ${layer.strokes.length} 笔 / ${layer.strokes.reduce((n, s) => n + s.points.length, 0)} 个采样点`, 24, 54);

  document.title = "DONE";
}

main();
