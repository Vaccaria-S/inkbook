import { BookEditor } from "../src/editor";
import { BookStore } from "../src/store";
import { createBook, createPage, type Pt, type Stroke } from "../src/types";
import { readBook, writeBook } from "../src/storage";
import { straightenPoints } from "../src/geometry";
import { buildIndexMarkdown, indexPathFor, writeTextIndex } from "../src/indexer";

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

  /* 文字：添加、编辑、删除、撤销、导出 */
  {
    editor.setTool("text");
    pageEl().dispatchEvent(ev("pointerdown", 200, 300, 1, 21));
    pageEl().dispatchEvent(ev("pointerup", 200, 300, 0, 21));
    await sleep(60);
    const ta = pageEl().querySelector(".mb-text-edit") as HTMLTextAreaElement;
    pass(!!ta, "文字工具点页面后出现输入框");
    pass(!!ta && document.activeElement === ta, "输入框自动获得焦点");

    if (ta) {
      ta.value = "第一行文字";
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
    await sleep(60);

    // 字号：新建的文字应该用当前设定
    editor.setTextSize(24);
    editor.setTool("pen");
    editor.setTool("text");
    pageEl().dispatchEvent(ev("pointerdown", 300, 420, 1, 23));
    pageEl().dispatchEvent(ev("pointerup", 300, 420, 0, 23));
    await sleep(60);
    const taBig = pageEl().querySelector(".mb-text-edit") as HTMLTextAreaElement;
    if (taBig) {
      taBig.value = "大字";
      taBig.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
    await sleep(60);
    const big = (store.data.pages[0].texts || []).find((t) => t.text === "大字");
    pass(big?.size === 24, "字号按设定写入（" + (big?.size ?? "-") + "）");
    editor.setTextSize(18);
    // 收尾：只留前面那条，后面的断言按 1 条算
    editor.undo();
    await sleep(40);

    const texts = store.data.pages[0].texts || [];
    pass(texts.length === 1, "文字已写入页面数据（" + texts.length + " 条）");
    pass(texts[0]?.source === "user", "来源标记为 user");
    pass(texts[0]?.text === "第一行文字", "内容正确：" + JSON.stringify(texts[0]?.text || ""));
    pass(Math.abs((texts[0]?.x ?? 0) - 200) < 2, "横向位置落在点击处（" + (texts[0]?.x ?? 0).toFixed(0) + "）");
    pass(!pageEl().querySelector(".mb-text-edit"), "提交后输入框已移除");

    const spans = pageEl().querySelectorAll(".mb-text.is-user");
    pass(spans.length === 1 && spans[0].textContent === "第一行文字", "文字层渲染出可见文字");

    /*
     * 点同一处：第一下只选中，浮出属性条。
     * 用户原话是「没法选中这段文字进行编辑和删除」——选中态就是为这个加的。
     */
    pageEl().dispatchEvent(ev("pointerdown", 206, 300, 1, 22));
    pageEl().dispatchEvent(ev("pointerup", 206, 300, 0, 22));
    await sleep(60);
    const bar = pageEl().querySelector(".mb-textbar") as HTMLElement;
    pass(!!bar, "点已有文字先选中，纸上浮出属性条");
    pass(!!editor.selectedText, "editor 记住了选中的那段文字");
    pass(!pageEl().querySelector(".mb-text-edit"), "第一下选中，不会直接弹输入框");
    pass(
      (bar?.querySelectorAll(".mb-tb-dot").length ?? 0) >= 4,
      "属性条上有颜色点（" + (bar?.querySelectorAll(".mb-tb-dot").length ?? 0) + " 个）"
    );
    pass(!!bar?.querySelector(".mb-tb-font"), "属性条上有字体下拉");

    // 再点一次才进编辑
    pageEl().dispatchEvent(ev("pointerdown", 206, 300, 1, 24));
    pageEl().dispatchEvent(ev("pointerup", 206, 300, 0, 24));
    await sleep(60);
    const ta2 = pageEl().querySelector(".mb-text-edit") as HTMLTextAreaElement;
    pass(!!ta2 && ta2.value === "第一行文字", "再点一次进入编辑（预填原文）");

    // Esc 只取消编辑，不删原文
    ta2?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(60);
    pass((store.data.pages[0].texts || []).length === 1, "Esc 只取消编辑，原文还在");

    /* ---------------- 选中后改字号 / 字体 / 颜色 ---------------- */
    editor.selectText((store.data.pages[0].texts || [])[0].id);
    await sleep(30);

    editor.updateSelectedText({ size: 28 });
    await sleep(30);
    pass(
      store.data.pages[0].texts?.[0]?.size === 28,
      "选中后改字号生效（" + (store.data.pages[0].texts?.[0]?.size ?? "-") + "）"
    );

    editor.updateSelectedText({ font: "serif" });
    await sleep(30);
    pass(
      store.data.pages[0].texts?.[0]?.font === "serif",
      "选中后改字体生效（" + (store.data.pages[0].texts?.[0]?.font ?? "-") + "）"
    );

    editor.updateSelectedText({ color: "#D64545" });
    await sleep(30);
    pass(
      store.data.pages[0].texts?.[0]?.color === "#D64545",
      "选中后改颜色生效（" + (store.data.pages[0].texts?.[0]?.color ?? "-") + "）"
    );

    const userSpan = pageEl().querySelector(".mb-text.is-user") as HTMLElement;
    pass(userSpan?.style.fontSize === "28px", "文字层字号跟着变（" + userSpan?.style.fontSize + "）");
    pass(
      (userSpan?.style.fontFamily || "").indexOf("Songti") >= 0 ||
        (userSpan?.style.fontFamily || "").indexOf("serif") >= 0,
      "文字层字体跟着变（" + (userSpan?.style.fontFamily || "").slice(0, 24) + "）"
    );
    pass(
      (userSpan?.style.color || "").replace(/\s/g, "") !== "" &&
        userSpan.style.color !== "rgb(26, 26, 26)",
      "文字层颜色跟着变（" + userSpan?.style.color + "）"
    );

    /* ---------------- 属性条上的删除按钮 ---------------- */
    const barNow = pageEl().querySelector(".mb-textbar") as HTMLElement;
    const delBtn = Array.from(barNow?.querySelectorAll(".mb-tb-btn") ?? []).find(
      (b) => (b.textContent || "").trim() === "删除"
    ) as HTMLElement | undefined;
    pass(!!delBtn, "属性条上有「删除」按钮");
    delBtn?.click();
    await sleep(60);
    pass((store.data.pages[0].texts || []).length === 0, "属性条删除按钮能删掉这段文字");
    pass(!pageEl().querySelector(".mb-textbar"), "删除后属性条自动消失");
    pass(editor.selectedText === null, "删除后选中态清空");

    editor.undo();
    await sleep(60);
    pass((store.data.pages[0].texts || []).length === 1, "撤销后文字回来");
    pass(
      pageEl().querySelectorAll(".mb-text.is-user").length === 1,
      "撤销后文字层同步刷新（不是只在数据里）"
    );

    /*
     * 键盘删除（Delete / Esc）在 view 里做，这里没有 view 实例，
     * 挪到 dock-harness 去测。
     */

    // 导出画布必须画出用户文字，否则导出件"少一行字"
    const c = editor.exportPageCanvas(0, 1);
    const ctx = c.getContext("2d")!;
    const px = ctx.getImageData(190, 250, 240, 80).data;
    let ink = 0;
    for (let i = 0; i < px.length; i += 4) {
      const [r, g, b, a] = [px[i], px[i + 1], px[i + 2], px[i + 3]];
      if (a > 0 && (r < 240 || g < 240 || b < 240)) ink++;
    }
    pass(ink > 5, "导出画布里画出了文字（非白像素 " + ink + "）");
  }

  /* 文本层：PDF 原文透明、书写时穿透、仅阅读可选 */
  {
    const page = store.data.pages[0];
    page.texts = [
      { id: "t_pdf1", source: "pdf", x: 120, y: 200, size: 12, text: "PDF 原文一行" },
      { id: "t_pdf2", source: "pdf", x: 120, y: 230, size: 12, text: "Second line" },
    ];
    editor.renderPages();
    await sleep(80);

    const layer = pageEl().querySelector(".mb-textlayer") as HTMLElement;
    pass(!!layer, "页面里有文字层 .mb-textlayer");
    const pdfSpans = pageEl().querySelectorAll(".mb-text.is-pdf");
    pass(pdfSpans.length === 2, "PDF 原文进了文字层（" + pdfSpans.length + " 行）");

    const cs = getComputedStyle(pdfSpans[0] as HTMLElement);
    const transparent =
      cs.color === "rgba(0, 0, 0, 0)" ||
      (cs as any).webkitTextFillColor === "rgba(0, 0, 0, 0)";
    pass(transparent, "原文画成透明文字（视觉交给底图，避免重影）");

    pass(
      getComputedStyle(layer).pointerEvents === "none",
      "书写时文字层穿透（不抢触摸）"
    );

    // 仅阅读：文字层接管指针，才能拖选复制
    host.classList.add("mb-root", "is-reading");
    await sleep(30);
    pass(
      getComputedStyle(layer).pointerEvents === "auto",
      "仅阅读时文字层可选中（pointer-events:auto）"
    );
    pass(
      getComputedStyle(layer).userSelect === "text",
      "仅阅读时允许选择文字"
    );

    // 跨行选中要能复制成两行（否则粘出来是 "A行B行" 一长串）
    const rg = document.createRange();
    rg.setStart(pdfSpans[0], 0);
    const lastNode = pdfSpans[1].firstChild;
    if (lastNode) rg.setEnd(lastNode, (lastNode.textContent || "").length);
    else rg.setEndAfter(pdfSpans[1]);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(rg);
    const picked = sel?.toString() || "";
    pass(picked.includes("\n"), "拖选两行，复制内容带换行：" + JSON.stringify(picked));
    sel?.removeAllRanges();
    host.classList.remove("is-reading");
    host.classList.remove("mb-root");

    // 收尾：别让这批文字影响后面的形状测试
    page.texts = [];
    editor.renderPages();
    await sleep(80);
  }

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

  /* 全局搜索索引（纯函数，不碰磁盘） */
  {
    const mockFile = {
      path: "笔记/数学.inkbook",
      basename: "数学",
      parent: { path: "笔记" },
    } as any;
    const bk = createBook("数学", "grid", "white");
    bk.pages[0].texts = [
      { id: "p1", source: "pdf", x: 90, y: 400, size: 12, text: "下半页的原文" },
      { id: "p2", source: "pdf", x: 90, y: 120, size: 12, text: "傅里叶变换的定义" },
      { id: "u1", source: "user", x: 120, y: 260, size: 20, color: "#D64545", text: "我的批注" },
    ];
    bk.pages.push(createPage("lined", "cream"));
    bk.pages[1].texts = [
      { id: "p3", source: "pdf", x: 90, y: 100, size: 12, text: "第二页正文" },
    ];

    const md = buildIndexMarkdown(mockFile, bk);
    pass(md.includes("傅里叶变换的定义"), "索引 md 含 PDF 原文");
    pass(md.includes("我的批注"), "索引 md 含手动添加的文字");
    pass(md.includes("## 第 1 页") && md.includes("## 第 2 页"), "索引 md 按页分节");
    pass(
      md.includes("obsidian://inkbook?file=") && md.includes("page=2"),
      "索引 md 带跳页链接（含第 2 页）"
    );
    pass(
      md.indexOf("傅里叶变换的定义") < md.indexOf("我的批注") &&
        md.indexOf("我的批注") < md.indexOf("下半页的原文"),
      "同一页内按 y 从上到下排列"
    );
    pass(!md.includes("undefined") && !md.includes("null"), "索引 md 没有 undefined/null");
    pass(
      indexPathFor(mockFile) === "笔记/数学.墨本文字.md",
      "索引文件与本子同目录、同名前缀：" + indexPathFor(mockFile)
    );
    // 没有文字的书也不能崩
    const empty = buildIndexMarkdown(mockFile, createBook("空", "grid", "white"));
    pass(empty.includes("还没有可搜索的文字"), "没有文字的本子给出说明而不是空文件");

    /* 真的写一遍：用内存 adapter 替身，验"内容没变就不重写" */
    const fsMap = new Map<string, string>();
    let writes = 0;
    const mockApp = {
      vault: {
        adapter: {
          exists: async (p: string) => fsMap.has(p),
          read: async (p: string) => fsMap.get(p) || "",
          write: async (p: string, d: string) => {
            writes += 1;
            fsMap.set(p, d);
          },
          remove: async (p: string) => {
            fsMap.delete(p);
          },
        },
      },
    } as any;

    await writeTextIndex(mockApp, mockFile, bk);
    const written = fsMap.get("笔记/数学.墨本文字.md") || "";
    pass(written.includes("傅里叶变换的定义"), "writeTextIndex 真的写出了索引文件");
    const w1 = writes;
    await writeTextIndex(mockApp, mockFile, bk);
    pass(writes === w1, "内容没变化时不重复写（省同步与重解析）");

    bk.pages[0].texts!.push({
      id: "u2",
      source: "user",
      x: 100,
      y: 500,
      size: 18,
      text: "新加的一句",
    });
    await writeTextIndex(mockApp, mockFile, bk);
    pass(
      writes === w1 + 1 && (fsMap.get("笔记/数学.墨本文字.md") || "").includes("新加的一句"),
      "文字变了会更新索引"
    );
  }

  log("DONE");
  document.title = "DONE";
  (window as any).__harness = { editor, store };
}

main().catch((e) => {
  log("FATAL " + (e && e.stack ? e.stack : e));
  document.title = "FATAL";
});
