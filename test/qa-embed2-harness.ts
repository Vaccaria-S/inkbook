/**
 * QA 独立验证：笔记内嵌入（INK-105）。
 *
 * 与 test/embed-harness.ts 的分工：
 *   · 那套验「逻辑对不对」（解析结果、readBook 次数、dataset.page）；
 *   · 这套验「真机上会不会难看 / 卡死 / 泄漏」——**全部用真实布局量**，
 *     不看代码里写了什么样式，只看 canvas.getBoundingClientRect() 的真实像素。
 *
 * 七块：
 *   1. 观察器泄漏（20 块 + disposeEmbeds，用计数桩，必须最先跑）
 *   2. 链接解析往边界外再推一圈（#0 / #-1 / |0 / |-5 / 空 linktext / %20 / 超长 / 巨页码）
 *   3. 物理尺寸：90 / 92 / 300 / 800 栏宽 + 「|300 塞进 90px 栏」——量真实矩形
 *   4. 缓存：mtime 失效 / 页与宽度分键 / LRU 上限 / InkBook 只读一次
 *   5. 失败路径：删文件 / 改路径 / 坏 JSON / 0 页 / 底图丢失
 *   6. 幂等：同一个块连跑 4 次 postprocessor
 *   7. 超大 |宽 的健壮性（放最后，可能触发巨量分配）
 */
import {
  clampPageIndex,
  disposeEmbeds,
  embedCacheStats,
  invalidateEmbedCache,
  isInkbookEmbed,
  parseEmbedSrc,
  processEmbedEl,
  readEmbedTarget,
  registerEmbed,
  renderEmbedForFile,
  renderEmbedPage,
  setEmbedContext,
  type EmbedFile,
  type EmbedHost,
} from "../src/embed";
import { createBook, createPage, type InkBook, type Stroke } from "../src/types";

/* ------------------------------- 输出 ------------------------------- */

const lines: string[] = [];
const out = document.getElementById("out")!;
const log = (s: string) => {
  lines.push(s);
  out.textContent = lines.join("\n");
};

let checks = 0;
let failures = 0;
/** 规格缺口：不是回归，是规格里写了、源码没做到的项（单独计数，避免和"变红了"混在一起） */
let gaps = 0;
const NUM: Array<{ label: string; value: string }> = [];

/** 记录一条结论；detail 附在行尾（数字都留在这里，方便对照） */
const check = (ok: boolean, label: string, detail = "") => {
  checks += 1;
  if (!ok) failures += 1;
  log((ok ? "PASS " : "FAIL ") + label + (detail ? "  ← " + detail : ""));
};
/** 规格缺口：期望的健壮性没做到，但不影响正常路径 */
const gap = (ok: boolean, label: string, detail = "") => {
  checks += 1;
  if (!ok) gaps += 1;
  log((ok ? "PASS " : "GAP  ") + label + (detail ? "  ← " + detail : ""));
};
const num = (label: string, value: string) => {
  NUM.push({ label, value });
  log("  · " + label + " = " + value);
};
const group = (t: string) => log("\n== " + t + " ==");

/* 未捕获异常 / reject / console 记账 */
const uncaught: string[] = [];
const warns: string[] = [];
window.addEventListener("error", (e) => uncaught.push("error: " + e.message));
window.addEventListener("unhandledrejection", (e) =>
  uncaught.push("reject: " + ((e as any).reason?.stack || (e as any).reason))
);
const rawWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  warns.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  rawWarn(...args);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 8000): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(40);
  }
  return pred();
}

/* ------------------------------- 素材 ------------------------------- */

function makeBook(pageCount = 3): InkBook {
  const book = createBook("QA 嵌入本", "blank", "white");
  book.pages = [];
  for (let i = 0; i < pageCount; i += 1) {
    book.pages.push(createPage("blank", "white"));
  }
  if (!book.pages.length) return book;
  const stroke: Stroke = {
    id: "s1",
    tool: "pen",
    color: "#1A1A1A",
    size: 9,
    opacity: 1,
    points: [
      [80, 160, 0.6],
      [220, 150, 0.7],
      [360, 200, 0.8],
      [500, 300, 0.7],
    ],
  };
  book.pages[0].layers[0].strokes.push(stroke);
  const last = book.pages[book.pages.length - 1];
  if (book.pages.length > 1) {
    last.texts = [
      { id: "t1", source: "user", x: 60, y: 140, size: 30, text: "末页批注", color: "#1A1A1A" },
    ];
  }
  return book;
}

interface FakeFile {
  text: string;
  mtime: number;
}

/** 假宿主：记录每个路径的 read 次数，metadataCache 按 linktext 精确命中 */
function makeApp(files: Record<string, FakeFile>) {
  const reads: Record<string, number> = {};
  const meta: Record<string, any> = {};
  for (const p of Object.keys(files)) {
    meta[p] = {
      path: p,
      basename: p.replace(/^.*\//, "").replace(/\.inkbook$/, ""),
      extension: "inkbook",
      stat: { mtime: files[p].mtime },
    };
  }
  const adapter = {
    exists: async (p: string) => Object.prototype.hasOwnProperty.call(files, p),
    read: async (p: string) => {
      reads[p] = (reads[p] || 0) + 1;
      return files[p]?.text ?? "";
    },
    getResourcePath: (p: string) => p,
  };
  const app = {
    vault: {
      adapter,
      getAbstractFileByPath: (p: string) => meta[p] ?? null,
    },
    metadataCache: {
      getFirstLinkpathDest: (linktext: string) =>
        Object.prototype.hasOwnProperty.call(meta, linktext) ? meta[linktext] : null,
    },
  };
  return {
    app,
    meta,
    totalReads: () => Object.values(reads).reduce((a, b) => a + b, 0),
    readsOf: (p: string) => reads[p] || 0,
  };
}

/** 假宿主：注册回调 + 记录 openBookAt */
function makeHost(app: any) {
  const cbs: Array<(el: HTMLElement, ctx: any) => void> = [];
  const opened: Array<[string, number]> = [];
  const host: EmbedHost = {
    app,
    registerMarkdownPostProcessor: (cb: (el: HTMLElement, ctx: any) => void) => {
      cbs.push(cb);
      return { unregister() {} };
    },
    openBookAt: (path: string, page: number) => {
      opened.push([path, page]);
      return Promise.resolve();
    },
  };
  return { host, cbs, opened };
}

/** 造一个 `.internal-embed` 单元格 */
function addCell(
  parent: HTMLElement,
  width: number | null,
  src: string,
  dataSrc?: string
): { cell: HTMLElement; node: HTMLElement } {
  const cell = document.createElement("div");
  cell.className = "cell";
  if (width !== null) {
    cell.style.width = width + "px";
    cell.style.flex = `0 0 ${width}px`;
  }
  const node = document.createElement("div");
  node.className = "internal-embed";
  node.setAttribute("src", src);
  if (dataSrc) node.setAttribute("data-src", dataSrc);
  cell.appendChild(node);
  parent.appendChild(cell);
  return { cell, node };
}

const BOOK = makeBook(3);
const BOOK_JSON = JSON.stringify(BOOK);

/* ------------------------------- 主流程 ------------------------------- */

async function main() {
  /* ===== 1. 观察器 / 泄漏（必须最先跑：模块里的 observer 还是 null） ===== */
  group("1. 懒加载观察器与 disposeEmbeds 泄漏");
  {
    const RealIO = (window as any).IntersectionObserver;
    let observes = 0;
    let unobserves = 0;
    let disconnects = 0;
    let roots: Array<string | undefined> = [];
    class CountingIO {
      constructor(_cb: any, opts: any) {
        roots.push(opts?.rootMargin);
      }
      observe() {
        observes += 1;
      }
      unobserve() {
        unobserves += 1;
      }
      disconnect() {
        disconnects += 1;
      }
      takeRecords() {
        return [];
      }
    }
    (window as any).IntersectionObserver = CountingIO;

    const { app } = makeApp({ "泄漏.inkbook": { text: BOOK_JSON, mtime: 1 } });
    setEmbedContext(app as any);
    const { host, cbs } = makeHost(app);
    registerEmbed(host);

    const leakHost = document.getElementById("leak-host")!;
    for (let i = 0; i < 20; i += 1) {
      addCell(leakHost, 100, i % 2 ? "泄漏.inkbook#2" : "泄漏.inkbook");
    }
    cbs[0](leakHost, { sourcePath: "n.md" });
    check(observes === 20, "20 个嵌入块都被 observe（实际 " + observes + "）");
    check(roots[0] === "200px", "rootMargin 是 200px（实际 " + String(roots[0]) + "）");
    check(
      leakHost.querySelectorAll(".mb-embed-canvas").length === 0,
      "未进入视口时不渲染（canvas " + leakHost.querySelectorAll(".mb-embed-canvas").length + " 张）"
    );

    disposeEmbeds();
    check(disconnects === 1, "disposeEmbeds 断开观察器（disconnect 调用 " + disconnects + " 次）");

    invalidateEmbedCache();
    const st = embedCacheStats();
    check(st.bitmaps === 0 && st.books === 0 && st.bytes === 0, "dispose + invalidate 后缓存归零 " + JSON.stringify(st));

    (window as any).IntersectionObserver = RealIO;
    leakHost.innerHTML = "";
  }

  /* ===== 2. 解析边界 ===== */
  group("2. 链接解析边界（不抛异常 / 页码合法 / 宽度非负）");
  {
    const cases = [
      "本子.inkbook",
      "本子.inkbook#0",
      "本子.inkbook#-1",
      "本子.inkbook#-0",
      "本子.inkbook|0",
      "本子.inkbook|-5",
      "本子.inkbook|300x200",
      "本子.inkbook#abc",
      "本子.inkbook|abc",
      "本子.inkbook#",
      "本子.inkbook|",
      "本子.inkbook#3|",
      "本子.inkbook#3|300",
      "本子.inkbook|300#3",
      "笔记/数学/我的 本子.inkbook#2|100",
      "笔记%20副本/本子.inkbook",
      "![[本子.inkbook#3|300]]",
      "",
      "   ",
      "|300",
      "#3",
      "本子.inkbook#999999999999999999999",
      "本子.inkbook|999999999999999999999",
      "本子.inkbook" + "a".repeat(2000),
    ];
    let threw = "";
    let badPage = "";
    let badWidth = "";
    for (const c of cases) {
      let t: { linktext: string; page: number; width: number | null } | null = null;
      try {
        t = parseEmbedSrc(c);
      } catch (e) {
        threw = JSON.stringify(c) + " → " + e;
        break;
      }
      const pageOk = Number.isFinite(t.page) && Number.isInteger(t.page) && t.page >= 1;
      const widthOk =
        t.width === null || (Number.isFinite(t.width) && t.width > 0);
      if (!pageOk) badPage = JSON.stringify(c) + " → page=" + t.page;
      if (!widthOk) badWidth = JSON.stringify(c) + " → width=" + t.width;
    }
    check(!threw, `${cases.length} 种写法逐个解析都不抛异常`, threw || "ok");
    check(!badPage, "页码恒为 ≥1 的整数", badPage || "ok");
    check(!badWidth, "宽度恒为 null 或 >0 的有限数", badWidth || "ok");

    // 关键语义逐个钉死
    check(parseEmbedSrc("本子.inkbook#0").page === 1, "#0 → 第 1 页");
    check(parseEmbedSrc("本子.inkbook#-1").page === 1, "#-1 → 第 1 页");
    check(parseEmbedSrc("本子.inkbook|0").width === null, "|0 → 不限宽");
    check(parseEmbedSrc("本子.inkbook|-5").width === null, "|-5 → 不限宽");
    check(parseEmbedSrc("本子.inkbook|300x200").width === 300, "|300x200 → 只取 300");
    check(parseEmbedSrc("本子.inkbook#3|").width === null, "#3| → 页 3 无宽度");
    check(
      parseEmbedSrc("本子.inkbook|300#3").page === 1 && parseEmbedSrc("本子.inkbook|300#3").width === 300,
      "|300#3（写反顺序）不崩：取宽 300、页 1"
    );
    const encoded = parseEmbedSrc("笔记%20副本/本子.inkbook");
    check(
      encoded.linktext === "笔记%20副本/本子.inkbook",
      "%20 路径原样保留（不自行解码，交给 metadataCache）",
      "linktext=" + encoded.linktext
    );
    check(parseEmbedSrc("").linktext === "" && parseEmbedSrc("").page === 1, "空串 → 空 linktext + 第 1 页");
    check(parseEmbedSrc("|300").width === 300 && parseEmbedSrc("|300").linktext === "|300", "只有 |300 也不崩");

    // isInkbookEmbed
    const mk = (attrs: Record<string, string>) => {
      const n = document.createElement("div");
      n.className = "internal-embed";
      for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
      return n;
    };
    check(isInkbookEmbed(mk({ src: "本子.inkbook" })), "src=本子.inkbook 认");
    check(isInkbookEmbed(mk({ src: "本子.INKBOOK#2|200" })), "大写 + 页 + 宽 认");
    check(isInkbookEmbed(mk({ src: " 本子.inkbook " })), "前后空格 认");
    check(!isInkbookEmbed(mk({ src: "本子.inkbookx" })), "本子.inkbookx 不认");
    check(!isInkbookEmbed(mk({ src: "本子.inkbook.md" })), "本子.inkbook.md 不认");
    check(!isInkbookEmbed(mk({ src: "笔记.md" })), "普通 md 不认");
    check(!isInkbookEmbed(mk({ src: "#3" })), "只有 #3 不认");
    check(isInkbookEmbed(mk({ "data-src": "a/b/本子.inkbook" })), "只在 data-src 里也认");

    // readEmbedTarget 合并
    const merged = mk({ src: "本子.inkbook#1", "data-src": "本子.inkbook#5|200" });
    const mt = readEmbedTarget(merged);
    num("src=#1 / data-src=#5|200", JSON.stringify(mt));
    check(mt.page === 5 && mt.width === 200, "两边都写时 data-src 更具体的那份生效", JSON.stringify(mt));

    // clampPageIndex
    check(clampPageIndex(0, 1) === 0 && clampPageIndex(-3, 1) === 0, "页数 ≤0 / 负数都不会出负下标");
    check(clampPageIndex(3, 1e21) === 2, "巨页码夹到最后一页");
    check(clampPageIndex(3, 0) === 0 && clampPageIndex(3, -9) === 0, "0 / 负页码 → 第 1 页");
  }

  /* ===== 3. 物理尺寸（真实布局） ===== */
  group("3. 物理尺寸：canvas 真实矩形 vs 容器");
  {
    const geo = document.getElementById("geo")!;
    const { app } = makeApp({ "geo.inkbook": { text: BOOK_JSON, mtime: 1 } });
    setEmbedContext(app as any);
    const { host, cbs } = makeHost(app);
    registerEmbed(host);

    /** 量一格：canvas 与 .mb-embed / .cell 的真实关系 */
    const measure = async (cell: HTMLElement, label: string) => {
      const cont = cell.querySelector(".mb-embed") as HTMLElement | null;
      const canvas = cell.querySelector(".mb-embed-canvas") as HTMLCanvasElement | null;
      if (!cont || !canvas) {
        check(false, label + "：没渲染出 canvas");
        return;
      }
      const cellRect = cell.getBoundingClientRect();
      const contRect = cont.getBoundingClientRect();
      const cr = canvas.getBoundingClientRect();
      const styleW = parseFloat(canvas.style.width || "0");
      const ratio = cr.height / cr.width;
      const wantRatio = 1123 / 794;
      const ratioErr = Math.abs(ratio - wantRatio) / wantRatio;

      num(
        label,
        `cell=${cellRect.width.toFixed(1)} cont=${contRect.width.toFixed(1)}(client ${cont.clientWidth}) ` +
          `canvas=${cr.width.toFixed(1)}×${cr.height.toFixed(1)} styleW=${styleW} ` +
          `ratio=${ratio.toFixed(4)} backing=${canvas.width}×${canvas.height}`
      );

      // ① 宽度：canvas 真实宽 == 容器内容宽（1px 边框不算内容）
      check(
        Math.abs(cr.width - cont.clientWidth) <= 1.5,
        label + "：canvas 真实宽 ≈ 容器内容宽",
        `canvas ${cr.width.toFixed(1)} vs client ${cont.clientWidth}（差 ${(cr.width - cont.clientWidth).toFixed(1)}px）`
      );
      // ② 比例：A4 竖版 1123/794，误差 < 2%（当初"高度写死 px 被压成竖条"的回归点）
      check(ratioErr < 0.02, label + "：高/宽 ≈ 1.4144（误差 <2%）", `实际 ${ratio.toFixed(4)}，偏差 ${(ratioErr * 100).toFixed(2)}%`);
      // ③ canvas 不越过自己的父盒
      check(cr.right <= contRect.right + 0.5, label + "：canvas 不越过嵌入块右缘", `right ${cr.right.toFixed(1)} ≤ ${contRect.right.toFixed(1)}`);
      // ④ 出图宽度不该远大于容器（当初「下限抬到 120」的回归点）
      gap(
        styleW <= cellRect.width + 0.5,
        label + "：出图宽度没有超过栏宽（下限没被抬高）",
        `style.width=${styleW} vs cell=${cellRect.width.toFixed(1)}`
      );
      // ⑤ 整块不越过栏宽：取决于宿主是否全局 border-box，故记为条件性缺口
      gap(
        contRect.right <= cellRect.right + 0.5,
        label + "：整块不越过栏宽右缘",
        `block right ${contRect.right.toFixed(1)} / cell right ${cellRect.right.toFixed(1)}，canvas 比栏宽窄 ${(cellRect.width - cr.width).toFixed(1)}px`
      );
    };

    // 两轮：浏览器的默认 content-box，以及 Obsidian 主题常见的全局 border-box。
    // 两块数据都要，才知道「2px 边框溢出」到底是宿主的问题还是插件的问题。
    for (const mode of ["content-box（浏览器默认）", "border-box（宿主全局 reset）"]) {
      const bb = mode.startsWith("border-box");
      geo.className = bb ? "bb" : "";
      log("  -- " + mode);
      for (const w of [90, 92, 300]) {
        geo.innerHTML = "";
        const { cell } = addCell(geo, w, "geo.inkbook");
        cbs[0](geo, { sourcePath: "n.md" });
        const ok = await waitFor(() => !!cell.querySelector(".mb-embed-canvas"));
        if (!ok) check(false, "栏宽 " + w + "：等不到 canvas");
        else await measure(cell, "栏宽 " + w + "px");
      }
      // 800px 单独一行（横排放不下，后面的块会被挤出视口）
      geo.innerHTML = "";
      const { cell: wide } = addCell(geo, 800, "geo.inkbook");
      cbs[0](geo, { sourcePath: "n.md" });
      const okWide = await waitFor(() => !!wide.querySelector(".mb-embed-canvas"));
      if (!okWide) check(false, "栏宽 800：等不到 canvas");
      else await measure(wide, "栏宽 800px");

      // 用户写死 300，但栏只有 90：max-width 该把它压到栏内且比例不变
      geo.innerHTML = "";
      const { cell: narrow } = addCell(geo, 90, "geo.inkbook|300");
      cbs[0](geo, { sourcePath: "n.md" });
      const okNarrow = await waitFor(() => !!narrow.querySelector(".mb-embed-canvas"));
      if (!okNarrow) check(false, "90px 栏 + |300：等不到 canvas");
      else {
        const canvas = narrow.querySelector(".mb-embed-canvas") as HTMLCanvasElement;
        const cr = canvas.getBoundingClientRect();
        const cellRect = narrow.getBoundingClientRect();
        const ratio = cr.height / cr.width;
        num("90px 栏 + |300", `canvas=${cr.width.toFixed(1)}×${cr.height.toFixed(1)} styleW=${canvas.style.width} ratio=${ratio.toFixed(4)}`);
        gap(cr.right <= cellRect.right + 0.5, "90px 栏 + |300：canvas 不横向溢出", `${cr.right.toFixed(1)} ≤ ${cellRect.right.toFixed(1)}`);
        check(Math.abs(ratio - 1123 / 794) / (1123 / 794) < 0.02, "90px 栏 + |300：比例没被压扁", ratio.toFixed(4));
      }
    }
    geo.className = "";

    /*
     * 宽栏（> dpr=2 的位图上限 840）：这一格是「显示宽回退」修复的正中心。
     *   · 显示宽必须仍然铺满容器（修复前 dpr=2 这里会空出 ~359px）；
     *   · 但位图会被设备像素预算夹小，于是位图/显示 的比值 < 1 —— 这是
     *     刻意换内存的取舍，不是 bug；我要把它**量出来并设下限**，
     *     免得以后有人把预算继续调小、把图调糊了还没人发现。
     */
    {
      const dprHere = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
      geo.innerHTML = "";
      const { cell } = addCell(geo, 1200, "geo.inkbook");
      cbs[0](geo, { sourcePath: "n.md" });
      const okW = await waitFor(() => !!cell.querySelector(".mb-embed-canvas"));
      if (!okW) check(false, "1200px 宽栏：等不到 canvas");
      else {
        const cont = cell.querySelector(".mb-embed") as HTMLElement;
        const canvas = cell.querySelector(".mb-embed-canvas") as HTMLCanvasElement;
        const cr = canvas.getBoundingClientRect();
        const bitmapCss = Math.round(canvas.width / dprHere);
        const eff = canvas.width / (cr.width * dprHere);
        const ratio = cr.height / cr.width;
        num(
          "1200px 宽栏",
          `显示 ${cr.width.toFixed(1)} / 位图 ${bitmapCss} CSS px / backing ${canvas.width}×${canvas.height} / dpr ${dprHere} / ` +
            `有效分辨率 ${eff.toFixed(2)}（1=原生清晰）/ 比例 ${ratio.toFixed(4)}`
        );
        check(
          Math.abs(cr.width - cont.clientWidth) <= 1.5,
          "1200px 宽栏：显示宽铺满容器（显示宽没被 dpr 折）",
          `canvas ${cr.width.toFixed(1)} vs client ${cont.clientWidth}`
        );
        check(cr.right <= cont.getBoundingClientRect().right + 0.5, "1200px 宽栏：不横向溢出");
        check(Math.abs(ratio - 1123 / 794) / (1123 / 794) < 0.02, "1200px 宽栏：比例不变形", ratio.toFixed(4));
        check(
          dprHere <= 1 ? eff >= 0.98 : eff >= 0.65,
          dprHere <= 1 ? "1200px 宽栏（dpr≤1）：位图 1:1 不缩水" : "1200px 宽栏（dpr>1）：分辨率不低于预算下限 0.65",
          `有效分辨率 ${eff.toFixed(2)}`
        );
      }
      geo.innerHTML = "";
    }

    // 每个嵌入块只有一个 canvas（占位被换掉，不是叠着）
    {
      geo.innerHTML = "";
      const { cell } = addCell(geo, 300, "geo.inkbook#2");
      cbs[0](geo, { sourcePath: "n.md" });
      await waitFor(() => !!cell.querySelector(".mb-embed-canvas"));
      check(cell.querySelectorAll("canvas").length === 1, "渲染完成后只有 1 张 canvas（无叠层）");
      check(!cell.querySelector(".mb-embed-ph"), "占位已移除，不留空占位撑高度");
    }
    geo.innerHTML = "";
  }

  /* ===== 4. 缓存 ===== */
  group("4. 缓存：mtime / 分键 / LRU / 只读一次");
  {
    const BOOK5_JSON = JSON.stringify(makeBook(5));
    const files: Record<string, FakeFile> = { "缓存.inkbook": { text: BOOK5_JSON, mtime: 1000 } };
    for (let i = 0; i < 8; i += 1) {
      files["书" + i + ".inkbook"] = { text: BOOK5_JSON, mtime: 5 };
    }
    const { app, meta, totalReads } = makeApp(files);
    setEmbedContext(app as any);
    invalidateEmbedCache();

    const f1: EmbedFile = meta["缓存.inkbook"];
    for (let p = 1; p <= 5; p += 1) {
      await renderEmbedForFile(app as any, f1, p, 300);
    }
    check(totalReads() === 1, "同一 path+mtime 渲 5 个不同页，readBook 只 1 次", "实际 " + totalReads());
    check(embedCacheStats().bitmaps === 5, "5 个不同页 = 5 条位图缓存", "实际 " + embedCacheStats().bitmaps);
    check(embedCacheStats().books === 1, "InkBook 缓存 1 条", "实际 " + embedCacheStats().books);

    await renderEmbedForFile(app as any, f1, 1, 400);
    check(embedCacheStats().bitmaps === 6, "同页换宽度是另一条键", "实际 " + embedCacheStats().bitmaps);

    // mtime 变 → 必须重读（键里带 mtime）
    const f2: EmbedFile = { ...f1, stat: { mtime: 2000 } };
    await renderEmbedForFile(app as any, f2, 1, 300);
    check(totalReads() === 2, "mtime 从 1000 → 2000 后重新 readBook", "实际 " + totalReads());
    check(embedCacheStats().books === 2, "新旧 mtime 各一条书缓存（旧的不串用）", "实际 " + embedCacheStats().books);

    // 反向确认：拿旧 mtime 再渲一次不该重读
    const before = totalReads();
    await renderEmbedForFile(app as any, f1, 2, 300);
    check(totalReads() === before, "旧 mtime 仍在缓存里（不重复读）", "reads " + totalReads() + " → " + before);

    // ---- LRU 上限 ----
    invalidateEmbedCache();
    const st0 = embedCacheStats();
    check(st0.bitmaps === 0 && st0.bytes === 0, "清空后归零 " + JSON.stringify(st0));

    const KEY_W0 = 400;
    // 64MB 预算下 60 条约 62MB 放得下、不会淘汰；用 90 条（约 94MB）逼出 LRU 淘汰。
    // 这组断言验的是「预算到了真的会淘汰」，不是验某个固定张数。
    const N = 90;
    for (let i = 0; i < N; i += 1) {
      await renderEmbedForFile(app as any, f1, (i % 3) + 1, KEY_W0 + i);
    }
    const st1 = embedCacheStats();
    const perEntry = KEY_W0 * Math.round((KEY_W0 * 1123) / 794) * 4;
    num("LRU 后 stats", JSON.stringify(st1));
    num("单张估算", Math.round(perEntry / 1024) + " KB（未乘 dpr）");
    check(st1.bitmaps < N, `${N} 个不同键后确实发生了淘汰`, `剩 ${st1.bitmaps} 条`);
    check(
      st1.bytes <= st1.limit,
      "缓存字节数不超预算",
      Math.round(st1.bytes / 1024 / 1024 * 10) / 10 + " MB / 上限 " +
        Math.round(st1.limit / 1024 / 1024) + " MB"
    );

    // 最新那条仍在缓存：再渲一次不该增加字节
    const newestW = KEY_W0 + (N - 1);
    const afterBurst = embedCacheStats();
    await renderEmbedForFile(app as any, f1, ((N - 1) % 3) + 1, newestW);
    const afterNewest = embedCacheStats();
    check(
      afterNewest.bytes === afterBurst.bytes,
      "最新一条命中缓存（未重画）",
      `${afterBurst.bytes} → ${afterNewest.bytes}`
    );
    // 最早那条已被淘汰：再渲一次会让字节数变化（命中则一个字节都不动）
    await renderEmbedForFile(app as any, f1, 1, KEY_W0);
    const afterOldest = embedCacheStats();
    check(
      afterOldest.bytes !== afterNewest.bytes,
      "最早一条已被淘汰（重渲触发重画，不是命中）",
      `bytes ${afterNewest.bytes} → ${afterOldest.bytes}`
    );

    // ---- InkBook 缓存条数上限 ----
    invalidateEmbedCache();
    for (let i = 0; i < 8; i += 1) {
      const f: EmbedFile = meta["书" + i + ".inkbook"];
      await renderEmbedForFile(app as any, f, 1, 120);
    }
    check(
      embedCacheStats().books === 6,
      "书缓存条数受 MAX_BOOK_CACHE=6 约束（8 本 → 6 条）",
      "实际 " + embedCacheStats().books
    );

    /*
     * 缓存键里放的是**位图宽**（不是请求宽）：dpr>1 时 2000 与 1200 都被夹到
     * 同一个位图宽，于是共用一条缓存 —— 但显示宽必须各按各的请求给。
     * 这是新设计里最容易藏 bug 的地方（命中缓存时忘了重设 style.width，
     * 就会「|1200 显示成 2000 宽」或反之），所以专门钉一次。
     */
    {
      const dprC = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
      if (dprC > 1) {
        invalidateEmbedCache();
        const r2000 = await renderEmbedForFile(app as any, f1, 1, 2000);
        const r1200 = await renderEmbedForFile(app as any, f1, 1, 1200);
        const w2000 = parseFloat(r2000.canvas.style.width || "0");
        const w1200 = parseFloat(r1200.canvas.style.width || "0");
        num(
          "共用位图 / 各按请求显示",
          `|2000 → 显示 ${w2000} 位图 ${r2000.canvas.width}；|1200 → 显示 ${w1200} 位图 ${r1200.canvas.width}；` +
            `缓存 ${embedCacheStats().bitmaps} 条`
        );
        check(r2000.canvas.width === r1200.canvas.width, "dpr>1：|2000 与 |1200 共用同一张位图（键是位图宽）");
        check(w2000 === 2000 && w1200 === 1200, "命中缓存时显示宽仍按本次请求（不串用上次的）", `${w2000} / ${w1200}`);
        check(embedCacheStats().bitmaps === 1, "共用位图只占 1 条缓存", "实际 " + embedCacheStats().bitmaps);
        // 位图不变、只换显示宽：像素内容必须一模一样（没有重画）
        const px = (c: HTMLCanvasElement) => {
          const g = c.getContext("2d")!;
          return Array.from(g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data).join(",");
        };
        check(
          px(r2000.canvas) === px(r1200.canvas),
          "两次中心像素一致（确实没重画）",
          `${px(r2000.canvas)} vs ${px(r1200.canvas)}`
        );
      } else {
        num("共用位图 / 各按请求显示", "dpr=1 下 2000 与 1200 是两条不同位图，本项跳过（在 dpr=2 页里跑才有效）");
      }
      invalidateEmbedCache();
    }
  }

  /* ===== 5. 失败路径 ===== */
  group("5. 失败路径：占位有字、不抛错、不白屏");
  {
    const zeroPages = JSON.stringify({ version: 2, kind: "inkbook", title: "空本", pages: [] });
    const brokenBg = (() => {
      const b = makeBook(1);
      b.pages[0].background = {
        src: "/test/根本没有这张图.png",
        sourceName: "x.png",
        sourcePage: 1,
        x: 0,
        y: 0,
        width: 794,
        height: 1123,
        kind: "word",
      };
      return JSON.stringify(b);
    })();

    const { app, meta } = makeApp({
      "坏.inkbook": { text: '{ "kind": "inkbook", "pages": [', mtime: 1 },
      "空页.inkbook": { text: zeroPages, mtime: 1 },
      "缺底图.inkbook": { text: brokenBg, mtime: 1 },
    });
    setEmbedContext(app as any);
    invalidateEmbedCache();
    const { host, cbs } = makeHost(app);
    registerEmbed(host);

    const failHost = document.getElementById("fail-host")!;
    failHost.innerHTML = "";
    const cells: Record<string, HTMLElement> = {};
    const mkFail = (key: string, src: string) => {
      const { cell } = addCell(failHost, 200, src);
      cells[key] = cell;
    };
    mkFail("deleted", "已删除.inkbook"); // 库里没有这个文件
    mkFail("moved", "旧目录/移走了.inkbook"); // 只存在于新目录
    mkFail("broken", "坏.inkbook");
    mkFail("zero", "空页.inkbook");
    mkFail("nobg", "缺底图.inkbook");

    let threw = "";
    try {
      cbs[0](failHost, { sourcePath: "n.md" });
    } catch (e) {
      threw = String(e);
    }
    check(!threw, "整段失败块一起渲染不抛错", threw || "ok");
    await waitFor(
      () =>
        !!cells.deleted.querySelector(".mb-embed-ph-err") &&
        !!cells.broken.querySelector(".mb-embed-ph-err") &&
        !!cells.nobg.querySelector(".mb-embed-canvas")
    );
    await sleep(600); // 给坏 JSON 的 await 一点时间落地

    const textOf = (k: string) => (cells[k].textContent || "").replace(/\s+/g, " ").trim();
    check(
      !!cells.deleted.querySelector(".mb-embed-ph-err") && textOf("deleted").indexOf("找不到本子") >= 0,
      "文件被删除 → 有文字的占位（不是空白）",
      textOf("deleted")
    );
    check(
      !!cells.moved.querySelector(".mb-embed-ph-err") && textOf("moved").indexOf("找不到本子") >= 0,
      "文件被移走（旧路径失效）→ 有文字的占位",
      textOf("moved")
    );
    check(
      !!cells.broken.querySelector(".mb-embed-ph-err") &&
        /读不出来|找不到本子/.test(textOf("broken")),
      "坏 JSON → 有文字的占位",
      textOf("broken")
    );

    // 0 页本子：走 readBook 时 normalizeBook 会补 1 页；直接喂空 pages 会怎样？
    const zeroCanvas = cells.zero.querySelector(".mb-embed-canvas") as HTMLCanvasElement | null;
    check(!!zeroCanvas, "0 页 JSON 经 readBook 后仍出图（normalizeBook 兜底补 1 页）", "canvas=" + !!zeroCanvas);
    const emptyBook = { ...makeBook(0), pages: [] as any[] };
    const c0 = await renderEmbedPage(emptyBook as InkBook, 0, 200);
    const ctx0 = c0.getContext("2d")!;
    const d0 = ctx0.getImageData(0, 0, c0.width, c0.height).data;
    let darkPx = 0;
    for (let i = 0; i < d0.length; i += 4) {
      if (d0[i + 3] > 0 && d0[i] < 200 && d0[i + 1] < 200 && d0[i + 2] < 200) darkPx += 1;
    }
    num("直接渲 pages=[] 的页", `深色像素 ${darkPx}（0=空白纸面、没有文字说明）`);
    gap(darkPx > 0, "pages=[] 时画布上应有文字说明（规格：页数为 0 要出占位）", "实际深色像素 " + darkPx);

    // 底图丢失：不能是空白 canvas
    const bgCanvas = cells.nobg.querySelector(".mb-embed-canvas") as HTMLCanvasElement | null;
    if (bgCanvas) {
      const c2 = bgCanvas.getContext("2d")!;
      const mid = c2.getImageData(Math.floor(bgCanvas.width / 2), Math.floor(bgCanvas.height / 2), 1, 1).data;
      num("缺底图页面中心像素", `${mid[0]},${mid[1]},${mid[2]},${mid[3]}`);
      check(
        mid[3] > 0 && mid[0] > 200 && mid[0] < 252 && Math.abs(mid[0] - mid[1]) < 6,
        "底图丢失 → 画浅灰块（不是透明空白）",
        mid.join(",")
      );
    } else {
      check(false, "缺底图时应仍有 canvas");
    }

    check(
      failHost.querySelectorAll(".mb-embed").length === 5,
      "5 个坏块都挂了容器、没有互相牵连",
      "实际 " + failHost.querySelectorAll(".mb-embed").length
    );
    failHost.innerHTML = "";
  }

  /* ===== 6. 幂等 + 点击 ===== */
  group("6. 幂等与点击");
  {
    const { app, meta } = makeApp({ "幂等.inkbook": { text: BOOK_JSON, mtime: 1 } });
    setEmbedContext(app as any);
    invalidateEmbedCache();
    const { host, cbs, opened } = makeHost(app);
    registerEmbed(host);

    const idHost = document.getElementById("idem-host")!;
    idHost.innerHTML = "";
    const { cell } = addCell(idHost, 300, "幂等.inkbook#2");
    const node = cell.firstElementChild as HTMLElement;

    processEmbedEl(host, cell, { sourcePath: "n.md" });
    processEmbedEl(host, cell, { sourcePath: "n.md" });
    processEmbedEl(host, cell, { sourcePath: "n.md" });
    await waitFor(() => !!cell.querySelector(".mb-embed-canvas"));
    processEmbedEl(host, cell, { sourcePath: "n.md" });
    processEmbedEl(host, cell, { sourcePath: "n.md" });
    await sleep(200);

    check(cell.querySelectorAll(".mb-embed").length === 1, "连跑 5 次只有 1 个 .mb-embed", "实际 " + cell.querySelectorAll(".mb-embed").length);
    check(cell.querySelectorAll("canvas").length === 1, "连跑 5 次只有 1 张 canvas", "实际 " + cell.querySelectorAll("canvas").length);
    check(node.children.length === 1, ".internal-embed 下只有 1 个孩子", "实际 " + node.children.length);

    const canvas = cell.querySelector(".mb-embed-canvas") as HTMLCanvasElement;
    check(canvas.dataset.page === "2", "dataset.page = 2", String(canvas.dataset.page));

    // 点击 → openBookAt(path, 页)
    (cell.querySelector(".mb-embed") as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
    check(opened.length === 1 && opened[0][1] === 2, "点击落到链接里写的第 2 页", JSON.stringify(opened[0] || null));

    // 越界：显示最后一页 + 角标；点击仍按用户写的页码（由 view 层夹取）
    idHost.innerHTML = "";
    const over = addCell(idHost, 300, "幂等.inkbook#99");
    cbs[0](idHost, { sourcePath: "n.md" });
    await waitFor(() => !!over.cell.querySelector(".mb-embed-canvas"));
    const overCanvas = over.cell.querySelector(".mb-embed-canvas") as HTMLCanvasElement;
    const badge = over.cell.querySelector(".mb-embed-badge") as HTMLElement | null;
    check(overCanvas.dataset.page === "3", "越界 #99 渲染最后一页", "dataset.page=" + overCanvas.dataset.page);
    check(!!badge && /第 3 页/.test(badge.textContent || ""), "越界有角标标注真实页", badge?.textContent || "(无)");
    (over.cell.querySelector(".mb-embed") as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
    num("越界块点击参数", JSON.stringify(opened[opened.length - 1] || null));
    check(opened[opened.length - 1]?.[1] === 99, "点击传的是链接里写的 99（夹取交给 view 层）");
    idHost.innerHTML = "";
  }

  /* ===== 汇总异常 ===== */
  group("7. 异常与告警");
  check(uncaught.length === 0, "全程没有未捕获异常 / 未处理 reject", uncaught.slice(0, 3).join(" | ") || "ok");
  num("console.warn 次数", String(warns.length));
  num("未捕获异常", String(uncaught.length));

  /* ===== 8. 超大 |宽（放最后，可能触发巨量分配） ===== */
  group("8. 超大 |宽 的健壮性（最后跑）");
  {
    log("  （如果这里之后没有输出，说明浏览器在这一步被巨量分配拖垮）");
    const { app } = makeApp({ "大.inkbook": { text: BOOK_JSON, mtime: 1 } });
    setEmbedContext(app as any);
    invalidateEmbedCache();
    const { host, cbs } = makeHost(app);
    registerEmbed(host);

    const bigHost = document.getElementById("big-host")!;
    for (const w of [1200, 3000, 100000]) {
      bigHost.innerHTML = "";
      const { cell } = addCell(bigHost, 300, "大.inkbook|" + w);
      const t0 = performance.now();
      let err = "";
      try {
        cbs[0](bigHost, { sourcePath: "n.md" });
        await waitFor(() => !!cell.querySelector(".mb-embed-canvas"), 10000);
      } catch (e) {
        err = String(e);
      }
      const c = cell.querySelector(".mb-embed-canvas") as HTMLCanvasElement | null;
      const ms = Math.round(performance.now() - t0);
      const mb = c ? Math.round((c.width * c.height * 4) / 1024 / 1024) : 0;
      num(`|${w}（栏宽 300）`, c ? `backing ${c.width}×${c.height} = ${mb}MB，${ms}ms` : `无 canvas，${ms}ms，err=${err || "无"}`);
      // 硬要求：不能抛异常 / 不能挂死
      check(!err && ms < 10000, `|${w} 不抛异常、不挂死`, `err=${err || "无"} ${ms}ms`);
      /*
       * 规格（已由产品拍板）：只夹**上限** 2000px，不按栏宽压。
       * 上一版这里写的是 `backing <= 900`（当时根本没有上限，3000→3000px）。
       * 现在 `|1200` 合法地出 1200px —— 按栏宽压会让窄栏里的图放大后变糊，
       * 所以断言改成"≤ 2000 × dpr"。
       */
      gap(
        !!c && c.width <= 2000 * Math.max(1, Math.min(window.devicePixelRatio || 1, 2)) + 1,
        `|${w} 出图宽度不超过上限 2000px（按 dpr 放大）`,
        c ? `backing ${c.width}px / ${mb}MB` : "无 canvas"
      );
      const st = embedCacheStats();
      num(`|${w} 之后缓存`, JSON.stringify(st));
    }
    bigHost.innerHTML = "";
  }

  log("");
  log(`合计 ${checks} 项检查：失败 ${failures} 项、规格缺口 ${gaps} 项`);
  log(failures === 0 ? "QA-ALL-PASS（缺口 " + gaps + "）" : "QA-FAILED=" + failures);
  document.title = "DONE";
}

main().catch((e) => {
  log("FATAL " + (e?.stack || e));
  document.title = "FATAL";
});
