import { BookEditor } from "../src/editor";
import { BookStore } from "../src/store";
import { createBook, createPage, type Pt, type Stroke } from "../src/types";
import { readBook, writeBook } from "../src/storage";
import { straightenPoints } from "../src/geometry";

const lines: string[] = [];
const out = document.getElementById("out")!;
function log(s: string) {
  lines.push(s);
  out.textContent = lines.join("\n");
}
function pass(ok: boolean, msg: string) {
  log((ok ? "PASS " : "FAIL ") + msg);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
window.addEventListener("error", (e) => log("ERROR " + e.message + " @ " + e.filename + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => log("REJECT " + (e.reason?.stack || e.reason)));

const book = createBook("测试手写本", "grid", "white");
book.pages.push(createPage("lined", "cream"));
const store = new BookStore(book);
const host = document.getElementById("view-host")!;
let editor: BookEditor;
editor = new BookEditor(host, store, {
  penOnly: false,
  pressure: 1,
  onState: () => {},
  onChange: () => {},
  onPageChange: () => {},
});

function pageEl(): HTMLElement {
  return document.querySelector(".mb-page") as HTMLElement;
}
function ev(type: string, x: number, y: number, buttons: number, pointerId = 7): PointerEvent {
  const r = pageEl().getBoundingClientRect();
  const k = r.width / 794;
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons,
    clientX: r.left + x * k,
    clientY: r.top + y * k,
    pressure: type === "pointerup" ? 0 : 0.5,
  });
}
async function draw(points: Array<[number, number]>, pointerId = 7) {
  pageEl().dispatchEvent(ev("pointerdown", points[0][0], points[0][1], 1, pointerId));
  for (let i = 1; i < points.length; i++) {
    pageEl().dispatchEvent(ev("pointermove", points[i][0], points[i][1], 1, pointerId));
    await sleep(2);
  }
  const last = points[points.length - 1];
  pageEl().dispatchEvent(ev("pointerup", last[0], last[1], 0, pointerId));
  await sleep(30);
}

async function main() {
  await sleep(500);
  const s0 = editor.getState();
  pass(s0.pageCount === 2, "2 页已渲染");
  pass(document.querySelectorAll(".mb-page").length === 2, "DOM 页数 = 2");
  pass(document.querySelectorAll(".mb-canvas").length >= 1, "当前页画布已挂载");
  pass(!!pageEl(), "拿到页面元素");

  /* 实时预览：还没抬笔时 overlay 上就应该有墨 */
  editor.setTool("pen");
  pageEl().dispatchEvent(ev("pointerdown", 500, 650, 1, 5));
  for (let i = 1; i <= 12; i++) {
    pageEl().dispatchEvent(ev("pointermove", 500 + i * 8, 650 + Math.sin(i / 2) * 12, 1, 5));
    await sleep(2);
  }
  await sleep(60);
  const overlay = document.querySelector(".mb-overlay") as HTMLCanvasElement;
  const ictx = overlay.getContext("2d")!;
  const pixels = ictx.getImageData(0, 0, overlay.width, overlay.height).data;
  let inkPixels = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 12) inkPixels++;
  pass(inkPixels > 30, "抬笔前 overlay 有 " + inkPixels + " 个墨点像素");
  pageEl().dispatchEvent(ev("pointerup", 596, 650, 0, 5));
  await sleep(40);
  editor.undo();
  await sleep(40);
  pass(store.strokeCount === 0, "预览测试笔迹可撤销");

  /* 落笔 */
  const wave: Array<[number, number]> = [];
  for (let i = 0; i < 48; i++) wave.push([110 + i * 9, 220 + Math.sin(i / 4) * 40]);
  await draw(wave);
  pass(store.strokeCount === 1, "落笔写入 1 条笔迹：" + store.strokeCount);
  const stroke = store.page.layers[0].strokes[0];
  pass(!!stroke && stroke.points.length > 20, "点数 " + (stroke?.points.length || 0));
  pass(!!stroke && stroke.points.some((p) => p[2] !== 0.5), "记录了非恒定压力");

  /* 撤销 / 重做 */
  editor.undo();
  pass(store.strokeCount === 0, "撤销后 0 条");
  editor.redo();
  pass(store.strokeCount === 1, "重做后 1 条");

  /* 荧光笔 */
  editor.setTool("highlighter");
  await draw([
    [120, 330],
    [300, 332],
    [520, 330],
  ]);
  pass(store.strokeCount === 2, "荧光笔新增 1 条");
  const hl = store.page.layers[0].strokes[1];
  pass(hl?.tool === "highlighter" && hl.opacity < 0.5, "荧光笔半透明");

  /* 整笔擦除 */
  editor.setTool("eraser");
  editor.setEraserMode("whole");
  editor.eraserSize = 30;
  await draw([[300, 332]]);
  pass(store.strokeCount === 1, "整笔擦掉荧光笔，剩 " + store.strokeCount);
  editor.undo();
  pass(store.strokeCount === 2, "擦除可撤销");

  /* 局部擦除 */
  editor.setEraserMode("part");
  editor.eraserSize = 24;
  await draw([[300, 332], [330, 332]]);
  pass(store.strokeCount >= 2, "局部擦后笔迹条数：" + store.strokeCount);
  editor.undo();
  pass(store.strokeCount === 2, "局部擦可撤销");

  /* 形状 */
  editor.setTool("shape");
  editor.setShapeKind("arrow");
  await draw([
    [480, 620],
    [700, 760],
  ], 9);
  const shape = store.page.layers[0].strokes.find((x) => x.tool === "shape");
  pass(!!shape && shape.shape === "arrow", "箭头形状已写入");

  /* 图层 */
  editor.addLayer();
  pass(store.page.layers.length === 2, "新增图层");
  const activeId = store.page.activeLayerId;
  editor.setTool("pen");
  await draw([
    [120, 860],
    [220, 870],
    [320, 860],
  ], 10);
  const activeLayer = store.page.layers.find((l) => l.id === activeId)!;
  pass(activeLayer.strokes.length === 1, "新笔迹进当前图层");
  editor.toggleLayer(activeId);
  pass(store.page.layers.find((l) => l.id === activeId)!.visible === false, "图层可隐藏");
  editor.toggleLayer(activeId);
  editor.deleteLayer(activeId);
  pass(store.page.layers.length === 1, "删除图层");

  /* 页面 */
  editor.addPage();
  pass(store.pageCount === 3, "加页到 3");
  editor.duplicatePage(0);
  pass(store.pageCount === 4, "复制页到 4");
  editor.deletePage(1);
  pass(store.pageCount === 3, "删页回 3");

  /* 模板 / 纸色 */
  editor.setTemplate("planner");
  pass(store.page.template === "planner", "模板改为周计划");
  editor.setPaper("cream");
  pass(store.page.paper === "cream", "纸色改为米黄");

  /* 导出 */
  const canvas = editor.exportPageCanvas(0, 2);
  pass(canvas.width === 1588 && canvas.height === 2246, "导出画布 1588×2246");
  const ctx = canvas.getContext("2d")!;
  const data = ctx.getImageData(10, 10, 1, 1).data;
  pass(data[0] > 240 && data[1] > 240 && data[2] > 220, "导出画布有纸色");

  /* 存储 roundtrip */
  const files = new Map<string, string>();
  const adapter = {
    exists: async (p: string) => files.has(p),
    read: async (p: string) => files.get(p)!,
    write: async (p: string, d: string) => void files.set(p, d),
  };
  await writeBook(adapter, "a.inkbook", store.data);
  const back = await readBook(adapter, "a.inkbook", "a");
  pass(back.pages.length === store.data.pages.length, "存储读出页数一致");
  pass(back.kind === "inkbook", "kind = inkbook");

  /* ---- 直线识别（纯函数） ---- */
  {
    // 手抖的横线：首尾 (100,100)→(400,110)，中间上下抖 1.5px
    const jitter: Pt[] = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      jitter.push([100 + 300 * t, 100 + 10 * t + (i % 2 ? 1.5 : -1.5), 0.5 + 0.02 * i]);
    }
    const flat = straightenPoints(jitter);
    pass(!!flat, "近直线被识别（抖动 ±1.5px）");
    if (flat) {
      // 所有点到首尾连线的垂距应接近 0
      const a = flat[0];
      const b = flat[flat.length - 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let maxDev = 0;
      for (const p of flat) {
        const t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (len * len);
        const px = a[0] + (b[0] - a[0]) * t;
        const py = a[1] + (b[1] - a[1]) * t;
        maxDev = Math.max(maxDev, Math.hypot(p[0] - px, p[1] - py));
      }
      pass(maxDev < 0.01, "拉直后严格共线（最大垂距 " + maxDev.toFixed(4) + "px）");
      pass(flat.length === jitter.length, "点数保留：" + flat.length + " / " + jitter.length);
      pass(
        Math.abs(flat[7][2] - jitter[7][2]) < 1e-9,
        "压感保留（第 7 点 " + jitter[7][2].toFixed(3) + "）"
      );
    }
    // 明显弧线：中点偏离 40px
    const arc: Pt[] = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      arc.push([100 + 300 * t, 100 + 400 * Math.sin(Math.PI * t), 0.5]);
    }
    pass(straightenPoints(arc) === null, "弧线不被误判为直线");
    // 太短
    pass(
      straightenPoints([
        [0, 0, 0.5],
        [5, 0, 0.5],
        [10, 1, 0.5],
      ]) === null,
      "过短的笔画不处理（长度 10px）"
    );
    // 圆圈（首尾重合）
    const loop: Pt[] = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      loop.push([200 + 60 * Math.cos(a), 200 + 60 * Math.sin(a), 0.5]);
    }
    loop.push([...loop[0]] as Pt);
    pass(straightenPoints(loop) === null, "圆圈不被误判为直线");
  }

  log("DONE");
  document.title = "DONE";
  (window as any).__harness = { editor, store };
}

main().catch((e) => {
  log("FATAL " + (e && e.stack ? e.stack : e));
  document.title = "FATAL";
});
