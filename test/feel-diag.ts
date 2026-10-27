/**
 * 诊断：统计真实落笔后的压力分布与粗细动态范围，
 * 确认"起笔轻、行笔重、收笔轻"这条曲线是否真的成立。
 */
import { BookEditor } from "../src/editor";
import { BookStore } from "../src/store";
import { createBook, type Pt } from "../src/types";
import { effectivePressures } from "../src/ink";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const book = createBook("诊断", "blank", "white");
  const store = new BookStore(book);
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:-9999px;width:700px;height:900px";
  document.body.appendChild(host);
  const editor = new BookEditor(host, store, { smoothing: 0.55, prediction: true });
  await sleep(150);

  const pageEl = host.querySelector(".mb-page") as HTMLElement;
  const rect = pageEl.getBoundingClientRect();
  const k = book.width / rect.width;

  const fire = (type: string, x: number, y: number, pressure: number) => {
    pageEl.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        bubbles: true,
        cancelable: true,
        clientX: rect.left + x / k,
        clientY: rect.top + y / k,
        pressure,
        buttons: type === "pointerup" ? 0 : 1,
      })
    );
  };

  // 一条直线，速度先慢后快再慢（模拟真实行笔）
  const N = 80;
  const pts: Array<[number, number]> = [];
  let x = 100;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const step = 0.8 + 4.6 * Math.sin(Math.PI * t); // 起笔慢、行笔快、收笔慢
    x += step;
    pts.push([x, 300]);
  }

  fire("pointerdown", pts[0][0], pts[0][1], 0.5);
  for (let i = 1; i < N; i++) {
    fire("pointermove", pts[i][0], pts[i][1], 0.5);
    await sleep(10);
  }
  fire("pointerup", pts[N - 1][0], pts[N - 1][1], 0);
  await sleep(150);

  const strokes = store.page.layers[0].strokes;
  const s = strokes[0];
  if (!s) {
    document.title = "FATAL";
    return;
  }
  const ps = effectivePressures(s);
  const min = Math.min(...ps);
  const max = Math.max(...ps);
  const avg = ps.reduce((a, b) => a + b, 0) / ps.length;
  const first5 = ps.slice(0, 5).map((v) => v.toFixed(2)).join(" ");
  const mid5 = ps.slice(Math.floor(ps.length / 2) - 2, Math.floor(ps.length / 2) + 3)
    .map((v) => v.toFixed(2))
    .join(" ");
  const last5 = ps.slice(-5).map((v) => v.toFixed(2)).join(" ");

  const lines: string[] = [];
  const log = (t: string) => {
    lines.push(t);
    document.getElementById("out")!.textContent = lines.join("\n");
  };

  log(`采样点 ${s.points.length}`);
  log(`压力 min=${min.toFixed(3)} max=${max.toFixed(3)} avg=${avg.toFixed(3)}`);
  log(`起笔 5 点: ${first5}`);
  log(`中段 5 点: ${mid5}`);
  log(`收笔 5 点: ${last5}`);
  log(`动态范围 max/min = ${(max / Math.max(0.01, min)).toFixed(2)}`);
  log(`起笔 < 中段 : ${(ps.slice(0, 5).reduce((a, b) => a + b, 0) / 5 <
    ps.slice(Math.floor(ps.length / 2) - 2, Math.floor(ps.length / 2) + 3).reduce((a, b) => a + b, 0) / 5) ? "成立" : "不成立"}`);
  log(`收笔 < 中段 : ${(ps.slice(-5).reduce((a, b) => a + b, 0) / 5 <
    ps.slice(Math.floor(ps.length / 2) - 2, Math.floor(ps.length / 2) + 3).reduce((a, b) => a + b, 0) / 5) ? "成立" : "不成立"}`);

  document.title = "DONE";
}

main();
