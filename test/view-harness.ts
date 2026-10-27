import { InkbookView } from "../src/view";
import { createBook, createPage, DEFAULT_SETTINGS, type Pt } from "../src/types";
import { NewBookModal } from "../src/modals";

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


function bez(a: [number, number], b: [number, number], c: [number, number], d: [number, number], n = 160): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const x = u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0];
    const y = u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1];
    out.push([x, y, 0.15 + 0.8 * Math.pow(Math.sin(Math.PI * t), 0.55)]);
  }
  return out;
}
function sampleStrokes() {
  // 三条不同节奏的笔迹，用来展示"入锋轻、行笔重、出锋轻"的粗细变化
  const loops: Pt[] = [];
  for (let i = 0; i <= 260; i++) {
    const t = i / 260;
    // 起收笔轻、中段重
    const env = Math.sin(Math.PI * t) ** 0.6;
    loops.push([
      110 + t * 560,
      430 + Math.sin(t * Math.PI * 7) * (50 - t * 10),
      0.14 + 0.78 * env,
    ]);
  }
  const sig: Pt[] = [];
  const anchors: Array<[number, number]> = [[110, 620], [180, 520], [280, 700], [400, 550], [520, 680], [690, 580]];
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i], b = anchors[i + 1];
    const seg = bez(a, [a[0] + 40, a[1] - 70], [b[0] - 40, b[1] + 70], b, 50);
    sig.push(...seg);
  }
  const hl: Pt[] = [];
  for (let i = 0; i <= 70; i++) hl.push([105 + i * 8, 330, 0.5]);
  const curve = bez([95, 220], [260, 90], [470, 350], [695, 200], 220);
  return [
    { id: "s1", tool: "pen" as const, color: "#1A1A1A", size: 3.4, opacity: 1, points: curve },
    { id: "s2", tool: "pen" as const, color: "#1F5FBF", size: 2.8, opacity: 1, points: loops },
    { id: "s3", tool: "pen" as const, color: "#D64545", size: 2.2, opacity: 1, points: sig },
    { id: "s4", tool: "highlighter" as const, color: "#F6E05E", size: 26, opacity: 0.32, points: hl },
    { id: "s5", tool: "shape" as const, color: "#7C5CD6", size: 1.8, opacity: 1, points: [[520, 790, 0.5], [700, 900, 0.5]] as Pt[], shape: "rect" as const },
  ];
}

const files = new Map<string, any>();
const index = new Map<string, any>();
function mkFile(path: string, text: string) {
  const f = {
    path,
    basename: path.split("/").pop()!.replace(/\.[^.]+$/, ""),
    extension: path.split(".").pop()!,
    parent: { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/" },
  };
  files.set(path, text);
  index.set(path, f);
  return f;
}

const book = createBook("测试手写本", "grid", "white");
book.pages.push(createPage("lined", "cream"));
const file = mkFile("测试手写本.inkbook", JSON.stringify(book));

const adapter = {
  exists: async (p: string) => files.has(p),
  read: async (p: string) => files.get(p),
  write: async (p: string, d: string) => void files.set(p, d),
  writeBinary: async (p: string, d: any) => void files.set(p, d),
  mkdir: async () => {},
};
const vault = {
  adapter,
  createFolder: async (p: string) => {
    index.set(p, { path: p, type: "folder" });
    return { path: p };
  },
  create: async (p: string, text: string) => mkFile(p, text),
  getAbstractFileByPath: (p: string) => index.get(p) || null,
  getFiles: () => [...index.values()].filter((f) => f.extension),
};
const app: any = {
  vault,
  workspace: {
    getActiveFile: () => null,
    getActiveViewOfType: () => null,
    getLeaf: () => ({ openFile: async () => {} }),
    on: () => ({}),
    onLayoutReady: (cb: () => void) => setTimeout(cb, 0),
  },
};
const leaf = { app, getViewState: () => ({ state: {} }), getEphemeralState: () => ({}) };
const plugin: any = {
  settings: { ...DEFAULT_SETTINGS },
  saveSettings: async () => {},
  refreshViews: () => {},
};

async function main() {
  const view = new InkbookView(leaf, plugin);
  await view.onOpen();
  await view.onLoadFile(file);
  await sleep(600);

  pass(!!view.editor, "编辑器已挂载");
  pass(
    view.contentEl.querySelectorAll(".mb-rail-tool").length >= 7,
    "墨具坞工具按钮已生成"
  );
  pass(!!view.contentEl.querySelector(".mb-rail"), "墨具坞工具长条已生成");
  pass(!!view.contentEl.querySelector(".mb-rail-side"), "长条侧栏开关已生成");
  pass(!!view.contentEl.querySelector(".mb-rail-read"), "长条仅阅读按钮已生成");
  pass(view.sideEl.textContent!.includes("笔盒"), "侧栏有笔盒");
  pass(view.sideEl.querySelectorAll(".mb-tpl").length === 6, "6 个纸张模板");
  pass(view.sideEl.querySelectorAll(".mb-paper-chip").length === 3, "3 种纸色");
  pass(view.sideEl.querySelectorAll(".mb-thumb").length === 3, "2 页 + 加页按钮");
  pass(view.sideEl.querySelectorAll(".mb-layer").length === 1, "1 个图层");

  /* 真实指针落笔 */
  const pageEl = view.contentEl.querySelector(".mb-page") as HTMLElement;
  const r = pageEl.getBoundingClientRect();
  const k = r.width / 794;
  const pe = (type: string, x: number, y: number, buttons: number) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 21,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons,
      clientX: r.left + x * k,
      clientY: r.top + y * k,
      pressure: type === "pointerup" ? 0 : 0.55,
    });
  pageEl.dispatchEvent(pe("pointerdown", 100, 200, 1));
  for (let i = 1; i <= 30; i++) pageEl.dispatchEvent(pe("pointermove", 100 + i * 12, 200 + Math.sin(i / 3) * 30, 1));
  pageEl.dispatchEvent(pe("pointerup", 460, 205, 0));
  await sleep(80);
  pass(view.store!.strokeCount === 1, "视图里落笔写入 1 条：" + view.store!.strokeCount);
  pass(view.statusEl.textContent !== "已保存", "状态变为未保存");

  await view.flushSave();
  const saved = JSON.parse(files.get("测试手写本.inkbook"));
  pass(saved.pages[0].layers[0].strokes.length === 1, "保存文件里有 1 条笔迹");
  pass(saved.updated > 0, "保存更新了 updated 时间");

  /* 模板 / 纸色 */
  const tplCard = [...view.sideEl.querySelectorAll(".mb-tpl")].find((el) =>
    (el.textContent || "").includes("周计划")
  ) as HTMLElement;
  tplCard.click();
  await sleep(60);
  pass(view.store!.page.template === "planner", "点模板卡切换到周计划");
  const paperChip = [...view.sideEl.querySelectorAll(".mb-paper-chip")].find((el) =>
    (el.textContent || "").includes("米黄")
  ) as HTMLElement;
  paperChip.click();
  await sleep(60);
  pass(view.store!.page.paper === "cream", "点纸色切到米黄");

  /* 图层 */
  const addLayer = [...view.sideEl.querySelectorAll(".mb-link")].find((el) =>
    (el.textContent || "").includes("新图层")
  ) as HTMLElement;
  addLayer.click();
  await sleep(80);
  pass(view.store!.page.layers.length === 2, "新增图层");
  pass(view.sideEl.querySelectorAll(".mb-layer").length === 2, "侧栏出现 2 个图层");

  /* 页面 */
  // 「加一页」现在在侧栏的「页面」区里
  const addPageBtn = [...view.contentEl.querySelectorAll(".mb-link")].find(
    (el) => (el as HTMLElement).textContent?.includes("加一页")
  ) as HTMLElement;
  addPageBtn.click();
  await sleep(200);
  pass(view.store!.pageCount === 3, "加页后 3 页");
  pass(view.sideEl.querySelectorAll(".mb-thumb").length === 4, "缩略图 3 + 加页");
  view.editor!.undo();
  await sleep(100);
  pass(view.store!.pageCount === 2, "撤销加页回 2 页");
  view.editor!.redo();
  await sleep(100);
  pass(view.store!.pageCount === 3, "重做回 3 页");

  /* 导出 */
  await (view as any).runExport("png");
  await sleep(300);
  pass([...files.keys()].some((p) => p.endsWith(".png")), "导出 PNG 文件");
  await (view as any).runExport("pdf");
  await sleep(1200);
  const pdf = [...files.keys()].find((p) => p.endsWith(".pdf"));
  pass(!!pdf, "导出 PDF 文件：" + pdf);

  /* 新建弹窗 */
  let created: any = null;
  const modal = new NewBookModal(app, plugin, (f) => (created = f));
  modal.open();
  (modal as any).name = "新本子";
  (modal as any).folder = "笔记";
  await (modal as any).create();
  await sleep(80);
  pass(!!created && created.extension === "inkbook", "新建弹窗创建文件");
  pass(!!files.get("笔记/新本子.inkbook"), "新建路径正确");

  /* 重新加载 */
  await view.onUnloadFile();
  await view.onLoadFile(file);
  await sleep(500);
  pass(view.store!.strokeCount === 1, "重新打开后笔迹还在");
  pass(view.store!.pageCount === 3, "重新打开后页数还在");

  /* 展示本：丰富笔迹，用于截图 */
  const show = createBook("墨本 · 手感展示", "grid", "white");
  show.pages[0].layers[0].strokes.push(...sampleStrokes());
  show.pages.push(createPage("lined", "cream"));
  const showFile = mkFile("展示.inkbook", JSON.stringify(show));
  await view.onUnloadFile();
  await view.onLoadFile(showFile);
  await sleep(700);
  (window as any).__view = view;

  log("DONE");
  document.title = "DONE";
}

main().catch((e) => {
  log("FATAL " + (e && e.stack ? e.stack : e));
  document.title = "FATAL";
});
