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

/** 导入 PDF 之后的页数（导入会加页，后面「重新打开后页数还在」按它算） */
let pagesAfterImport = 0;

const adapter = {
  exists: async (p: string) => files.has(p),
  read: async (p: string) => files.get(p),
  write: async (p: string, d: string) => void files.set(p, d),
  writeBinary: async (p: string, d: any) => void files.set(p, d),
  mkdir: async () => {},
  remove: async (p: string) => {
    files.delete(p);
    index.delete(p);
  },
  list: async (p: string) => ({
    files: [...files.keys()].filter((k) => k.startsWith(p + "/")),
    folders: [],
  }),
  // PDF 底图 / 文字层要能真的加载：指向测试服务上的样例 PDF
  getResourcePath: (p: string) => (p.endsWith(".pdf") ? "/test/sample.pdf" : p),
};
const vault = {
  adapter,
  createFolder: async (p: string) => {
    index.set(p, { path: p, type: "folder" });
    return { path: p };
  },
  create: async (p: string, text: string) => mkFile(p, text),
  modify: async (f: any, text: string) => {
    files.set(f.path, text);
  },
  delete: async (f: any) => {
    files.delete(f.path);
    index.delete(f.path);
  },
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
    view.containerEl.querySelectorAll(".mb-top-tool").length >= 7,
    "顶栏工具按钮已生成"
  );
  pass(!!view.containerEl.querySelector(".mb-toprow"), "顶栏工具行已生成");
  pass(!!view.containerEl.querySelector(".mb-rail-side"), "顶栏侧栏开关已生成");
  pass(!!view.containerEl.querySelector(".mb-rail-read"), "顶栏仅阅读按钮已生成");
  pass(view.sideEl.textContent!.includes("笔盒"), "侧栏有笔盒");
  pass(view.sideEl.querySelectorAll(".mb-tpl").length === 6, "6 个纸张模板");
  pass(view.sideEl.querySelectorAll(".mb-paper-chip").length === 3, "3 种纸色");
  pass(view.sideEl.querySelectorAll(".mb-thumb").length === 3, "2 页 + 加页按钮");
  pass(view.sideEl.querySelectorAll(".mb-layer").length === 1, "1 个图层");

  /*
   * 侧栏收起时不能预渲染缩略图（大本子打开提速）。
   * 用户那本 857 页的本子，打开时侧栏是收起的：以前照样建 857 个条目、
   * 还立刻用 pdf.js 渲 5 页缩略图，和首屏抢同一份 PDF。
   */
  {
    const v = view as any;
    const orig = view.editor!.renderThumbnail.bind(view.editor!);
    let calls = 0;
    view.editor!.renderThumbnail = ((cv: HTMLCanvasElement, i: number) => {
      calls += 1;
      return orig(cv, i);
    }) as any;

    v.sideShown = false;
    v.applySideVisibility();
    calls = 0;
    v.refreshThumbs();
    pass(calls === 0, "侧栏收起：refreshThumbs 不渲染任何缩略图（实际 " + calls + " 次）");

    v.sideShown = true;
    v.applySideVisibility();
    pass(calls > 0, "展开侧栏：自动补画当前页附近的缩略图（" + calls + " 次）");

    /*
     * 「从未建过列表」的路径：收起状态打开文件时列表根本不建。
     * 展开必须能补建出完整列表，不能是空白。
     */
    v.sideShown = false;
    v.applySideVisibility();
    v.pageListEl.empty();
    v.thumbCanvases = [];
    v.pageCountSig = -1;
    calls = 0;
    v.refreshThumbs();
    pass(
      view.sideEl.querySelectorAll(".mb-thumb").length === 0,
      "侧栏收起且列表未建：打开时不创建缩略图条目（" + view.sideEl.querySelectorAll(".mb-thumb").length + " 个）"
    );
    v.sideShown = true;
    v.applySideVisibility();
    pass(
      view.sideEl.querySelectorAll(".mb-thumb").length === 3,
      "首次展开：补建完整页列表（2 页 + 加页，实际 " + view.sideEl.querySelectorAll(".mb-thumb").length + " 个）"
    );

    view.editor!.renderThumbnail = orig;
  }

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

  /*
   * 导入 PDF → 索引 的端到端（视图层）。
   *
   * 用户原话：「我导入了一个 PDF 文件之后……这个笔记文件里导入的 PDF
   * 文件的文字，仍然可以被直接搜索到。」
   *
   * 这里走的是**真正的导入路径**（view.runImport → importPdf → 落盘 →
   * 写索引），不是直接调 writeTextIndex：只有走完整条链，才能验到
   * 「导入完立刻就能搜到」这个要求——以前就是索引定时器还没到点就被
   * 销毁，PDF 原文根本进不了索引。
   */
  {
    const idxDir = "测试手写本.墨本索引";
    const before = new Set(files.keys());

    // 造一个「库里的 PDF」：importPdf 只会读它的路径 + 抽文字
    const pdfFile = mkFile("样例.pdf", "%PDF-1.4");
    pdfFile.path = "/test/sample.pdf";
    pdfFile.name = "sample.pdf";
    pdfFile.basename = "sample";
    files.delete("样例.pdf");
    index.delete("样例.pdf");

    await (view as any).runImport("pdf", pdfFile);
    await sleep(400);

    const newIdx = [...files.keys()].filter((p) => !before.has(p) && p.endsWith(".md"));
    pass(
      newIdx.length > 0,
      "导入 PDF 后当场写出了索引页（" + newIdx.length + " 个：" + newIdx.join(", ") + "）"
    );
    pass(
      newIdx.some((p) => p.includes("测试手写本 · 第")),
      "导入后的索引文件名带本子名（全局搜索直接显示「测试手写本 · 第 N 页」）"
    );
    const idxContent = newIdx.map((p) => files.get(p) || "").join("\n");
    const pdfTexts = (view.store!.data.pages || [])
      .flatMap((p: any) => p.texts || [])
      .filter((t: any) => t.source === "pdf" && (t.text || "").trim());
    pass(
      pdfTexts.length > 0,
      "导入 PDF 抽出了 " + pdfTexts.length + " 条原文（进了本子数据）"
    );
    const inIdx = pdfTexts.filter((t: any) => idxContent.includes(t.text)).length;
    pass(
      pdfTexts.length > 0 && inIdx === pdfTexts.length,
      "导入 PDF 后索引正文含全部 " + inIdx + "/" + pdfTexts.length + " 条 PDF 原文"
    );
    pass(
      idxContent.includes("PDF Page 1"),
      "导入 PDF 后索引正文里有样例 PDF 的真实文字（PDF Page 1）"
    );
    pass(
      !!files.get("测试手写本.inkbook"),
      "导入后本子本体也落盘了"
    );
    // 导入往本子里加了页，后面的「重新打开后页数还在」要按加完之后的数算
    pagesAfterImport = view.store!.pageCount;
  }

  /*
   * 导入完**马上切走**，PDF 原文还得在索引里。
   *
   * 这是用户报的第二个症状：「我导入了一个 PDF 文件之后，
   * 这个笔记文件里导入的 PDF 文件的文字，仍然可以被直接搜索到」。
   *
   * 以前这条路是断的：导入只置了 dirty，等 0.85s 防抖才保存，
   * 保存完才排一个 1s 的索引定时器——用户在这 2 秒内切走/关标签页，
   * destroyEditor 把定时器清掉，PDF 原文就永远进不了索引。
   *
   * 用**一本全新的本子**做：不能复用上一段那本，否则它早就写过索引了，
   * 断言会假通过。
   */
  {
    const freshBook = createBook("切走测试", "grid", "white");
    const freshFile = mkFile("切走测试.inkbook", JSON.stringify(freshBook));
    const otherBook = createBook("另一本", "grid", "white");
    const otherFile = mkFile("另一本.inkbook", JSON.stringify(otherBook));

    await view.onUnloadFile();
    await view.onLoadFile(freshFile);
    await sleep(300);

    // 导入（这次不等它自己写完索引就走）
    const pdfFile2 = mkFile("样例2.pdf", "%PDF-1.4");
    pdfFile2.path = "/test/sample.pdf";
    pdfFile2.name = "sample.pdf";
    pdfFile2.basename = "sample";
    files.delete("样例2.pdf");
    index.delete("样例2.pdf");

    await (view as any).runImport("pdf", pdfFile2);
    // 导入完的页数：切走再切回来必须是这个数（说明导入的内容真的落盘了）
    const pagesAfterImport2 = view.store!.pageCount;
    // 不 sleep：立刻切走（索引定时器还在去抖窗口里）
    await view.onUnloadFile();
    await view.onLoadFile(otherFile);
    await sleep(300);

    const idxAfter = [...files.keys()].filter((p) =>
      p.startsWith("切走测试.墨本索引/") && p.endsWith(".md")
    );
    const contentAfter = idxAfter.map((p) => files.get(p) || "").join("\n");
    pass(
      idxAfter.length > 0 && contentAfter.includes("PDF Page 1"),
      "导入后立刻切走：PDF 原文仍然进了索引（" + idxAfter.length + " 个索引页）"
    );
    pass(
      idxAfter.some((p) => p.includes("切走测试 · 第")),
      "导入后立刻切走：索引文件名也带本子名（" + (idxAfter[0] || "-") + "）"
    );

    // 切回原来那本，确认内容还在
    await view.onUnloadFile();
    await view.onLoadFile(file);
    await sleep(400);
    pass(
      view.store!.pageCount === pagesAfterImport,
      "切回来后页数没丢（" + view.store!.pageCount + " 页，导入后是 " + pagesAfterImport + " 页）"
    );
    pagesAfterImport = view.store!.pageCount;
  }

  /*
   * 索引定时器被销毁了，但内容还没进索引 → flushSave 必须补写一次。
   *
   * 这是「切文件/关标签页」那条路的最后一道保险：
   * `destroyEditor()` 会 `clearTimeout(this.indexTimer)`，
   * 1 秒去抖窗口内的改动就此丢掉。以前判据是「定时器非零」，
   * 定时器一被清掉就看不出「还有东西没写」——PDF 原文因此永远进不了索引。
   *
   * 这里直接模拟那个瞬间：让定时器被清掉、待写标志还在，
   * 再调 flushSave，断言索引照样被写出来。
   */
  {
    const tBook = createBook("定时器测试", "grid", "white");
    tBook.pages[0].texts = [
      { id: "tt1", source: "pdf", x: 90, y: 100, size: 12, text: "定时器被销毁也要写进索引" },
    ];
    const tFile = mkFile("定时器测试.inkbook", JSON.stringify(tBook));
    await view.onUnloadFile();
    await view.onLoadFile(tFile);
    await sleep(300);

    // 让内容变脏 → 触发一次保存（saveNow 内部会 scheduleTextIndex）
    (view.store!.data.pages[0].texts as any)[0].text = "定时器被销毁也要写进索引（改过）";
    (view as any).markDirty();
    await view.saveNow();
    await sleep(50);

    // 模拟 destroyEditor 把定时器清掉：待写的内容还在，但定时器没了
    (view as any).indexTimer = 0;

    await view.flushSave();
    await sleep(100);

    const idxPath = "定时器测试.墨本索引/定时器测试 · 第 1 页.md";
    const content = files.get(idxPath) || "";
    pass(
      content.includes("定时器被销毁也要写进索引"),
      "索引定时器被销毁后 flushSave 仍补写了索引（" + (content ? "有内容" : "空") + "）"
    );
    pass(
      index.has(idxPath),
      "补写的索引页进了 vault 文件表（全局搜索搜得到）"
    );
  }

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
  pass(
    view.store!.pageCount === pagesAfterImport,
    "重新打开后页数还在（" + view.store!.pageCount + " 页，导入时加了页）"
  );

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
