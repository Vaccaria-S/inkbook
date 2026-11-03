/**
 * QA 终验（INK-105 第二轮）——工程师修完 F1/F2 + 三条产品决策之后的独立验证。
 *
 * 与前三套的分工：
 *   · embed-harness  —— 工程师自己写的（80 项），本套不复用它的断言方式；
 *   · qa-embed2      —— 上一轮我写的几何 / 解析 / LRU / 失败路径（回归用）；
 *   · qa-embed3      —— 上一轮我写的 main.ts 真接线（回归用）；
 *   · **本套**        —— 这轮新增的六块，全部自己造数据、自己量：
 *       1. F1：`|25` / `|2000` / `|3000` / `|100000` 的出图宽与缓存字节（自己算，
 *          不信工程师报的 21.6MB）；连画 5 张不同大图是否真淘汰；2000px 位图的
 *          耗时与堆增量。
 *       2. F2：先钉前提（边框真的 1px），再钉 box-sizing 与不越栏；**另外造一个
 *          没有任何主题变量的宿主**（iframe，content-box），看退回"边框消失"时
 *          布局是否仍然不越栏。
 *       3. 点击落点：默认 `opts === undefined`（不是 {newTab:false}）、Ctrl/Cmd、
 *          **中键 auxclick button=1**、右键 button=2 不触发、回车/空格；以及真链路
 *          `getLeaf("tab")` + `openFile(正确 TFile)`。
 *       4. 保存后重画：真计时（不用假时钟）、范围（视口内 2 个 / 6000px 外 1 个 /
 *          别的本子 2 个）、并发（rendering 期间再来的请求记 repaintQueued）、
 *          缓存真的清了、20 轮不泄漏。
 *       5. 角标：未 hover opacity=0、越界常显、文案、dataset；hover 规则自己查
 *          （真 hover 在 qa-embed5 + CDP 强制伪类里验）。
 *
 * 全部用**真插件**（new InkbookPlugin + onload），这样点的链路是插件真方法。
 */
import InkbookPlugin from "../src/main";
import {
  embedCacheStats,
  invalidateEmbedCache,
  MAX_EMBED_WIDTH,
  MAX_EMBED_DEVICE_PIXELS,
  maxCssWidthForDpr,
  renderEmbedForFile,
  type EmbedFile,
} from "../src/embed";
import { TFile } from "obsidian";
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
const NUM: Array<[string, string]> = [];
const num = (k: string, v: string) => {
  NUM.push([k, v]);
  log("  · " + k + " = " + v);
};
const check = (ok: boolean, label: string, detail = "") => {
  checks += 1;
  if (!ok) failures += 1;
  log((ok ? "PASS " : "FAIL ") + label + (detail ? "  ← " + detail : ""));
};
const group = (t: string) => log("\n== " + t + " ==");

const uncaught: string[] = [];
window.addEventListener("error", (e) => uncaught.push("error: " + e.message));
window.addEventListener("unhandledrejection", (e) =>
  uncaught.push("reject: " + ((e as any).reason?.stack || (e as any).reason))
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 12000): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(30);
  }
  return pred();
}

/* --------------------- 定时器记账（泄漏检测用） --------------------- */

const liveTimers = new Set<number>();
const rawSetTimeout = window.setTimeout.bind(window);
const rawClearTimeout = window.clearTimeout.bind(window);
(window as any).setTimeout = (fn: any, ms?: number, ...args: any[]): number => {
  const id = rawSetTimeout(() => {
    liveTimers.delete(id);
    if (typeof fn === "function") fn(...args);
  }, ms);
  liveTimers.add(id);
  return id;
};
(window as any).clearTimeout = (id: any): void => {
  liveTimers.delete(id);
  rawClearTimeout(id);
};

/* ------------------------------- 素材 ------------------------------- */

/** 3 页：第 1 页手写笔迹、第 2 页笔迹、第 3 页批注（越界角标用） */
function makeBook(title: string): InkBook {
  const book = createBook(title, "blank", "white");
  book.pages = [];
  for (let i = 0; i < 3; i += 1) book.pages.push(createPage("blank", "white"));
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
      [560, 330, 0.6],
    ],
  };
  book.pages[0].layers[0].strokes.push(stroke);
  book.pages[1].layers[0].strokes.push({ ...stroke, id: "s2" });
  book.pages[2].texts = [
    { id: "t1", source: "user", x: 60, y: 140, size: 30, text: "末页批注", color: "#1A1A1A" },
  ];
  return book;
}

const JSON_MAIN = JSON.stringify(makeBook("主本"));
const JSON_REFRESH = JSON.stringify(makeBook("刷新本"));
const JSON_OTHER = JSON.stringify(makeBook("别本"));
const JSON_SLOW = JSON.stringify(makeBook("慢本"));
const JSON_LEAK = JSON.stringify(makeBook("泄漏本"));

const P_MAIN = "笔记/主本.inkbook";
const P_REFRESH = "笔记/刷新本.inkbook";
const P_OTHER = "笔记/别本.inkbook";
const P_SLOW = "笔记/慢本.inkbook";
const P_LEAK = "笔记/泄漏本.inkbook";

/** 每本 → JSON；`slow` 里的路径读起来故意慢 2.2s（用来制造"渲染中又来请求"） */
const texts: Record<string, string> = {
  [P_MAIN]: JSON_MAIN,
  [P_REFRESH]: JSON_REFRESH,
  [P_OTHER]: JSON_OTHER,
  [P_SLOW]: JSON_SLOW,
  [P_LEAK]: JSON_LEAK,
};
const SLOW_MS: Record<string, number> = { [P_SLOW]: 2200 };

const reads: Record<string, number> = {};

function mkFile(path: string): any {
  const f: any = new TFile();
  Object.assign(f, {
    path,
    basename: path.replace(/^.*\//, "").replace(/\.inkbook$/, ""),
    extension: "inkbook",
    stat: { mtime: 111 },
  });
  return f;
}
const fileOf: Record<string, any> = {};
for (const p of Object.keys(texts)) fileOf[p] = mkFile(p);

/* ------------------------------- 假宿主 ------------------------------- */

const handlers: Record<string, Array<(...a: any[]) => void>> = {};
const vaultOn = (name: string, cb: (...a: any[]) => void) => {
  (handlers[name] = handlers[name] || []).push(cb);
  return { unsubscribe() {} };
};
const emit = (name: string, ...args: any[]) => {
  for (const h of handlers[name] || []) h(...args);
};

/** getLeaf 的入参（false / "tab"）与 openFile 收到的文件都记下来 */
const leafArgs: any[] = [];
const openFiles: any[] = [];

const workspace: any = Object.create({ trigger() {} });
Object.assign(workspace, {
  on: () => ({}),
  onLayoutReady: (cb: () => void) => rawSetTimeout(cb, 0),
  getLeaf: (arg?: any) => {
    leafArgs.push(arg);
    return {
      openFile: async (f: any) => {
        openFiles.push(f);
      },
      setViewState: async () => {},
      view: {},
    };
  },
  getActiveFile: () => null,
  getActiveViewOfType: () => null,
  getLeavesOfType: () => [],
});

const adapter = {
  exists: async (p: string) => Object.prototype.hasOwnProperty.call(texts, p),
  read: async (p: string) => {
    reads[p] = (reads[p] || 0) + 1;
    const d = SLOW_MS[p];
    if (d) await sleep(d);
    return texts[p] ?? "";
  },
  write: async () => {},
  mkdir: async () => {},
  writeBinary: async () => {},
  readBinary: async () => new ArrayBuffer(0),
  getFullPath: (p: string) => p,
  getResourcePath: (p: string) => p,
};

const app: any = {
  commands: { executeCommandById: () => true },
  viewRegistry: { typeByExtension: { pdf: "pdf", md: "markdown" }, trigger() {} },
  vault: {
    adapter,
    on: vaultOn,
    getFiles: () => Object.values(fileOf),
    getAbstractFileByPath: (p: string) => fileOf[p] ?? null,
  },
  metadataCache: {
    getFirstLinkpathDest: (linktext: string) => fileOf[linktext] ?? null,
  },
  workspace,
};

/* ------------------------------- 工具 ------------------------------- */

const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
const MB = 1024 * 1024;

/** 深色像素计数（只看一块区域，避免大图整张 getImageData） */
function darkIn(canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number): number {
  const ctx = canvas.getContext("2d");
  if (!ctx) return -1;
  const sx = Math.max(0, Math.min(canvas.width - 1, Math.round(x)));
  const sy = Math.max(0, Math.min(canvas.height - 1, Math.round(y)));
  const sw = Math.max(1, Math.min(canvas.width - sx, Math.round(w)));
  const sh = Math.max(1, Math.min(canvas.height - sy, Math.round(h)));
  const d = ctx.getImageData(sx, sy, sw, sh).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 0 && d[i] < 190 && d[i + 1] < 190 && d[i + 2] < 190) n += 1;
  }
  return n;
}
/** 笔迹落在页面坐标 40–600 × 100–360（第 1/2 页都画在这一带） */
function inkOf(canvas: HTMLCanvasElement): number {
  const k = canvas.width / 794;
  return darkIn(canvas, 40 * k, 100 * k, 570 * k, 270 * k);
}

/** 造一个 `.internal-embed`（可选设外层栅格宽度） */
function mkEmbed(parent: HTMLElement, src: string, cellWidth?: number): HTMLElement {
  const cell = document.createElement("div");
  if (cellWidth) {
    cell.style.cssText = `width:${cellWidth}px;flex:0 0 ${cellWidth}px;min-width:0`;
  }
  const node = document.createElement("div");
  node.className = "internal-embed";
  node.setAttribute("src", src);
  node.style.cssText = "display:block";
  cell.appendChild(node);
  parent.appendChild(cell);
  return node;
}

/* ------------------------------- 主流程 ------------------------------- */

async function main() {
  invalidateEmbedCache();
  const plugin: any = new InkbookPlugin(app, { id: "inkbook", name: "墨本", version: "0.1.0", dir: ".obsidian/plugins/inkbook" });
  await plugin.onload();
  const pps: Array<(el: HTMLElement, ctx: any) => void> = (window as any).__markdownPostProcessors || [];
  const pp = pps[0];
  const ctx = { sourcePath: "笔记/入口.md" };
  check(!!pp, "插件 onload 后拿到了 markdown postprocessor");

  /* ============ 1. F1：出图宽上限与缓存字节（自己量） ============ */
  group("1. F1 — |25 / |2000 / |3000 / |100000 出图宽、缓存字节、是否白屏");
  {
    const host = document.getElementById("w-host")!;
    const rows: Array<{ w: number; cssW: number; displayW: number; backing: string; entryMB: number; cacheMB: number; ink: number; ms: number; ok: boolean }> = [];
    /** 本机 dpr 下实际生效的 CSS 宽度上限 */
    const ceiling =
      dpr <= 1 ? MAX_EMBED_WIDTH : Math.min(MAX_EMBED_WIDTH, maxCssWidthForDpr(dpr));
    num(
      "宽度上限",
      `dpr=${dpr} → ${ceiling}px（maxCssWidthForDpr(${dpr})=${maxCssWidthForDpr(dpr)}，` +
        `设备像素预算 ${MAX_EMBED_DEVICE_PIXELS / 1e6}M）`
    );
    // 公式在 dpr=3 上给 560；但 embedDpr() 把真实 dpr 夹在 2，真机走不到这条
    num("公式参考值", `maxCssWidthForDpr(1)=${maxCssWidthForDpr(1)} / (2)=${maxCssWidthForDpr(2)} / (3)=${maxCssWidthForDpr(3)}`);

    for (const w of [25, 2000, 3000, 100000]) {
      invalidateEmbedCache();
      host.innerHTML = "";
      const node = mkEmbed(host, `${P_MAIN}|${w}`, 300);
      const t0 = performance.now();
      let err = "";
      try {
        pp(host, ctx);
        await waitFor(() => !!node.querySelector(".mb-embed-canvas"), 20000);
      } catch (e: any) {
        err = String(e?.message || e);
      }
      const ms = performance.now() - t0;
      const c = node.querySelector(".mb-embed-canvas") as HTMLCanvasElement | null;
      /*
       * 两种宽度分开量（INK-105 显示回退修好之后）：
       *   · 位图宽 = backing / dpr —— 受设备像素预算约束，也进缓存键；
       *   · 显示宽 = inline style.width —— 只受 MAX_EMBED_WIDTH 约束，管排版。
       * 早先只有 cssW 一个值，于是 dpr=2 时显示宽也被折成 840、右边空一块。
       */
      const cssW = c ? Math.round(c.width / dpr) : 0;
      const displayW = c ? parseFloat(c.style.width || "0") : 0;
      const entryBytes = c ? c.width * c.height * 4 : 0;
      const st = embedCacheStats();
      const ink = c ? inkOf(c) : -1;
      rows.push({
        w,
        cssW,
        displayW,
        backing: c ? `${c.width}×${c.height}` : "(无 canvas)",
        entryMB: entryBytes / MB,
        cacheMB: st.bytes / MB,
        ink,
        ms,
        ok: !!c && !err,
      });
      num(
        `|${w}`,
        `位图宽 ${cssW}px / 显示宽 ${displayW}px / backing ${c ? c.width + "×" + c.height : "-"} / 单张 ${(entryBytes / MB).toFixed(1)}MB ` +
          `/ 缓存 ${(st.bytes / MB).toFixed(1)}MB(${st.bitmaps} 条) / 笔迹像素 ${ink} / ${Math.round(ms)}ms`
      );
      check(!err && !!c, `|${w} 出图不抛异常`, err || "ok");
      /*
       * 位图宽的上限随 dpr 变（R1 之后的规格）：
       *   dpr ≤ 1 → 2000（桌面行为不变，2000 CSS 在 dpr=1 下 22.6MB，仍在 32MB 内）
       *   dpr > 1 → min(2000, maxCssWidthForDpr(dpr))（dpr=2 → 840）
       */
      const want = Math.min(Math.max(w, 24), ceiling);
      check(
        cssW === want,
        `|${w} 位图宽 = ${want}px（实际 ${cssW}px）`,
        `本机 dpr=${dpr}，生效上限 ${ceiling}px`
      );
      /*
       * 显示宽只受 MAX_EMBED_WIDTH 限制、**不折 dpr**：拿 840 当显示宽会让
       * 高分屏宽栏里的嵌入图右边空一大块（本轮的显示回退）。
       */
      check(
        displayW === Math.min(Math.max(w, 24), MAX_EMBED_WIDTH),
        `|${w} 显示宽 = ${Math.min(Math.max(w, 24), MAX_EMBED_WIDTH)}px（实际 ${displayW}px，不折 dpr）`
      );
      check(
        !!c && Math.abs(c.width - Math.round(want * dpr)) <= 1,
        `|${w} backing store 按同一个 dpr 放大（${c ? c.width : 0} vs ${Math.round(want * dpr)}，dpr=${dpr}）`
      );
      if (dpr > 1) {
        check(
          entryBytes <= MAX_EMBED_DEVICE_PIXELS * 4,
          `|${w} 单张位图不超设备像素预算（${(entryBytes / MB).toFixed(1)}MB ≤ 16MB）`,
          `${c ? c.width + "×" + c.height : "-"} = ${c ? c.width * c.height : 0}px`
        );
      }
      const inkNeed = w < 100 ? 1 : 30; // 25px 宽的图总共才 25×35 个点，阈值不能按大图定
      check(ink >= inkNeed, `|${w} 没白屏，笔迹照常画出（区域深色像素 ${ink}）`);
      check(st.bytes <= 32 * MB, `|${w} 之后缓存不超 32MB（${(st.bytes / MB).toFixed(1)}MB）`);

      /*
       * 真实排版：displayW 只是给 CSS 的上限，最终被 `max-width:100%` 压到栏内。
       * 这里量真实矩形——「显示宽 ≈ 容器内容宽、右侧空隙 ≤ 2px」才是用户看到的。
       * （上一版 dpr=2 时这一格里会是 840 / 359px 的空隙。）
       */
      const cont = node.querySelector(".mb-embed") as HTMLElement | null;
      const contW = cont ? cont.clientWidth : 0;
      const shown = c ? c.getBoundingClientRect().width : 0;
      const gap = c && cont ? cont.getBoundingClientRect().right - c.getBoundingClientRect().right : -1;
      const expectShown = Math.min(Math.min(Math.max(w, 24), MAX_EMBED_WIDTH), contW);
      num(`|${w} 真实排版`, `容器内容宽 ${contW} / 显示 ${shown.toFixed(1)}（期望 ${expectShown}）/ 右侧空隙 ${gap.toFixed(1)}px`);
      check(
        !!c && Math.abs(shown - expectShown) <= 1.5,
        `|${w} 真实显示宽 ≈ min(请求宽, 栏宽)（${shown.toFixed(1)} vs ${expectShown}）`
      );
      if (Math.min(Math.max(w, 24), MAX_EMBED_WIDTH) >= contW) {
        check(gap <= 2, `|${w} 右侧空隙 ≤ 2px（${gap.toFixed(1)}px，dpr=${dpr}）`);
      }
    }
    num("dpr", String(dpr));
    // 单条也不该突破预算：|2000 一轮 ~22.6MB(dpr=1) 仍要在 32MB 内
    check(rows.every((r) => r.cacheMB <= 32), "四种宽度单独出现时缓存都在预算内");
  }

  /* ============ 1b. 连画多张大图：缓存不超预算 + 是否真淘汰 ============ */
  group("1b. 连画大图 → 缓存 ≤32MB；dpr=1 要真淘汰，dpr>1 要能留住 ≥2 条");
  {
    const file = fileOf[P_MAIN] as EmbedFile;
    invalidateEmbedCache();
    /*
     * dpr=1：5 个不同宽度 = 5 个不同的键，单张最大 21.6MB → 必须淘汰到 1 条。
     * dpr=2：宽度都会被夹到同一个 840，只能靠"不同页"造出不同的键；
     *        单张 15.2MiB，32MB 预算正好放 2 张 → 断言"不再画完即弃"。
     */
    const widths = dpr > 1 ? [2000, 2000, 2000] : [1000, 1300, 1600, 1900, 2000];
    const pagesFor = dpr > 1 ? [1, 2, 3] : [2, 2, 2, 2, 2];
    const steps: string[] = [];
    for (let i = 0; i < widths.length; i += 1) {
      const r = await renderEmbedForFile(app, file, pagesFor[i], widths[i]);
      const entryBytes = r.canvas.width * r.canvas.height * 4;
      const st = embedCacheStats();
      steps.push(
        `|${widths[i]}(第${pagesFor[i]}页): 单张 ${(entryBytes / MB).toFixed(1)}MB → 缓存 ${st.bitmaps} 条 ${(st.bytes / MB).toFixed(1)}MB`
      );
    }
    for (const s of steps) log("    " + s);
    const st = embedCacheStats();
    num("连画大图后", `${st.bitmaps} 条 / ${(st.bytes / MB).toFixed(1)}MB`);
    check(st.bytes <= 32 * MB, `缓存字节受限（${(st.bytes / MB).toFixed(1)}MB ≤ 32MB）`);
    if (dpr > 1) {
      check(
        st.bitmaps >= 2,
        `dpr=${dpr} 下同书不同页能同时留在缓存里（${st.bitmaps} 条，不再"画完即弃"）`
      );
    } else {
      check(st.bitmaps < 5, `真的淘汰了（剩 ${st.bitmaps} 条 < 5）`);
    }
    // 命中证明：把**最后一张**（一定还在缓存里）再画一次，字节数一个都不变。
    // 也顺带证明"夹宽度用的 cssW"和"真正出图用的 cssW"是同一个，键才对得上。
    const lastPage = pagesFor[pagesFor.length - 1];
    const lastW = widths[widths.length - 1];
    const beforeHit = embedCacheStats();
    await renderEmbedForFile(app, file, lastPage, lastW);
    const afterHit = embedCacheStats();
    check(
      beforeHit.bytes === afterHit.bytes && beforeHit.bitmaps === afterHit.bitmaps,
      "同样的页 + 宽度再画一次是缓存命中（键与出图尺寸一致）",
      `第${lastPage}页|${lastW}：${JSON.stringify(beforeHit)} → ${JSON.stringify(afterHit)}`
    );
    num("|2000 单张理论字节", ((2000 * Math.round((2000 * 1123) / 794) * 4 * dpr * dpr) / MB).toFixed(1) + "MB（dpr=" + dpr + " 的理论值，实际按上限夹后更小）");
  }

  /* ============ 1b2. 显示宽不能漏进缓存键（这轮的核心设计） ============ */
  group("1b2. 同一页先 |2000 再 |1200：显示宽不同，位图该共用一条缓存");
  {
    const file = fileOf[P_MAIN] as EmbedFile;
    invalidateEmbedCache();
    const a = await renderEmbedForFile(app, file, 1, 2000);
    const stA = embedCacheStats();
    const b = await renderEmbedForFile(app, file, 1, 1200);
    const stB = embedCacheStats();
    num(
      "|2000 → |1200",
      `style.width ${a.canvas.style.width} → ${b.canvas.style.width}；` +
        `backing ${a.canvas.width}×${a.canvas.height} → ${b.canvas.width}×${b.canvas.height}；` +
        `缓存 ${stA.bitmaps} → ${stB.bitmaps} 条`
    );
    check(a.canvas.style.width === "2000px", "|2000 的显示宽是 2000px（不折 dpr、不按栏宽夹）", a.canvas.style.width);
    check(b.canvas.style.width === "1200px", "|1200 的显示宽是 1200px", b.canvas.style.width);
    const sameBitmap = a.canvas.width === b.canvas.width;
    check(
      sameBitmap ? stB.bitmaps === 1 : stB.bitmaps === 2,
      sameBitmap
        ? "位图相同（都被预算夹到同一宽度）→ 缓存仍只有 1 条（显示宽没漏进键）"
        : "dpr=1 下两个宽度就是两张位图 → 2 条缓存",
      `backing ${a.canvas.width} vs ${b.canvas.width}，缓存 ${stB.bitmaps} 条`
    );
    // 反向确认：同一页同一位图宽，第二次必须是命中（字节不变）
    const beforeHit2 = embedCacheStats();
    const again = await renderEmbedForFile(app, file, 1, 1200);
    const afterHit2 = embedCacheStats();
    check(
      again.canvas.style.width === "1200px" &&
        beforeHit2.bytes === afterHit2.bytes &&
        beforeHit2.bitmaps === afterHit2.bitmaps,
      "再画一次 |1200：命中缓存但显示宽仍是 1200px（命中时也重设 style.width）",
      `${JSON.stringify(beforeHit2)} → ${JSON.stringify(afterHit2)}`
    );
    invalidateEmbedCache();
  }

  /* ============ 1c. 2000px 位图的耗时 / 堆增量 ============ */
  group("1c. 压测：一次 2000px 位图的耗时与堆增量（画完即弃的取舍）");
  {
    const file = fileOf[P_MAIN] as EmbedFile;
    const mem = (performance as any).memory;
    invalidateEmbedCache();
    const heap0 = mem?.usedJSHeapSize ?? 0;
    const times: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      invalidateEmbedCache();
      const t0 = performance.now();
      await renderEmbedForFile(app, file, 1, 2000);
      times.push(performance.now() - t0);
    }
    const heap1 = mem?.usedJSHeapSize ?? 0;
    const st = embedCacheStats();
    num("单次 2000px 渲染耗时", times.map((t) => Math.round(t) + "ms").join(" / "));
    num("3 轮后缓存", `${st.bitmaps} 条 / ${(st.bytes / MB).toFixed(1)}MB`);
    if (mem) num("JS 堆增量", `${((heap1 - heap0) / MB).toFixed(1)}MB（${(heap0 / MB).toFixed(0)} → ${(heap1 / MB).toFixed(0)}MB）`);
    else num("JS 堆增量", "performance.memory 不可用（跳过）");
    check(times.every((t) => t < 3000), `单次渲染都在 3s 内（最长 ${Math.round(Math.max(...times))}ms）`);
    check(st.bytes <= 32 * MB, `画完即弃：缓存不累积（${(st.bytes / MB).toFixed(1)}MB）`);
    // 渲染期间主线程还能跑（不卡死）：这两次 await 之间事件循环转得动
    check(uncaught.length === 0, "压测过程无未捕获异常", uncaught.slice(0, 2).join(" | ") || "ok");
  }

  /* ============ 2. F2：边框前提 + box-sizing + 不越栏 ============ */
  group("2. F2 — 先钉前提（边框真的 1px），再钉 box-sizing 与不越栏");
  {
    const host = document.getElementById("geo-host")!;
    host.className = "content-box-host";
    host.innerHTML = "";
    const node = mkEmbed(host, P_MAIN, 200);
    pp(host, ctx);
    const ready = await waitFor(() => !!node.querySelector(".mb-embed-canvas"));
    check(ready, "布局夹具渲染完成");
    const cont = node.querySelector(".mb-embed") as HTMLElement;
    const canvas = node.querySelector(".mb-embed-canvas") as HTMLCanvasElement;
    const cs = getComputedStyle(cont);
    const hostRect = host.getBoundingClientRect();
    const contRect = cont.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();

    num("宿主 box-sizing", getComputedStyle(host).boxSizing + " / 宿主内容宽 " + host.clientWidth);
    num("computed border", `${cs.borderLeftWidth} ${cs.borderLeftStyle} ${cs.borderLeftColor}`);
    num("computed box-sizing", cs.boxSizing);

    // 前提：主题变量存在 → border 这条 shorthand 才不会被 "invalid at computed-value time" 干掉
    check(
      cs.borderLeftStyle === "solid" && cs.borderLeftWidth === "1px",
      "前提成立：.mb-embed 左边框真的是 1px solid（不是 0px / none）",
      `${cs.borderLeftWidth} ${cs.borderLeftStyle}`
    );
    check(cs.boxSizing === "border-box", ".mb-embed 自己声明 border-box（实际 " + cs.boxSizing + "）");
    check(
      contRect.right <= hostRect.right + 0.5,
      "嵌入块不越出栏宽（块右缘 " + contRect.right.toFixed(1) + " ≤ " + hostRect.right.toFixed(1) + "）"
    );
    check(
      cr.right <= hostRect.right + 0.5,
      "canvas 不越出栏宽（" + cr.right.toFixed(1) + " ≤ " + hostRect.right.toFixed(1) + "）"
    );
    check(
      Math.abs(cr.width - cont.clientWidth) <= 1,
      "canvas 宽 = 容器内容宽（" + cr.width.toFixed(1) + " vs clientWidth " + cont.clientWidth + "）"
    );
    const ratio = cr.height / cr.width;
    check(
      Math.abs(ratio - 1123 / 794) / (1123 / 794) < 0.02,
      "高宽比仍是 A4（" + ratio.toFixed(4) + "）"
    );
    num("块宽 / canvas 宽 / 宿主内容宽", `${contRect.width.toFixed(1)} / ${cr.width.toFixed(1)} / ${host.clientWidth}`);
  }

  /* ============ 2b. 没有主题变量的宿主（iframe, content-box） ============ */
  group("2b. 造一个没有主题变量的宿主：边框会不会退回「消失」，布局还越不越栏");
  {
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;left:460px;top:0;width:230px;height:460px;border:0";
    iframe.srcdoc =
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head>' +
      '<body style="margin:0;background:#fff"><div id="h" style="width:200px"></div></body></html>';
    const loaded = new Promise<void>((res) => {
      iframe.onload = () => res();
    });
    document.body.appendChild(iframe);
    await loaded;
    const win = iframe.contentWindow!;
    const doc = iframe.contentDocument!;
    const ih = doc.getElementById("h") as HTMLElement;

    // 拿一个真渲染出来的块，原样搬进无变量宿主（canvas 位图会丢，但尺寸/样式都在）
    const srcHost = document.getElementById("geo-host")!;
    const srcCont = srcHost.querySelector(".mb-embed") as HTMLElement;
    const clone = doc.importNode(srcCont, true) as HTMLElement;
    ih.appendChild(clone);

    const styled = await waitFor(() => win.getComputedStyle(clone).position === "relative", 6000);
    check(styled, "styles.css 在 iframe 里生效（.mb-embed 定位 relative）");
    const cs = win.getComputedStyle(clone);
    const varVal = win.getComputedStyle(doc.documentElement).getPropertyValue("--background-modifier-border");
    num("iframe 宿主 --background-modifier-border", varVal === "" ? "(未定义)" : varVal);
    check(varVal.trim() === "", "前提：这个宿主确实没有 --background-modifier-border 变量");
    num("无变量宿主的 computed border", `${cs.borderLeftWidth} ${cs.borderLeftStyle}`);
    num("无变量宿主的 box-sizing", cs.boxSizing);

    const hRect = ih.getBoundingClientRect();
    const cRect = clone.getBoundingClientRect();
    const cvs = clone.querySelector(".mb-embed-canvas") as HTMLElement | null;
    const cvsRect = cvs ? cvs.getBoundingClientRect() : null;

    // R3 之后：没有主题变量也必须还有 1px solid 边框（走 var() 的 fallback）
    const borderGone = cs.borderLeftStyle === "none" || parseFloat(cs.borderLeftWidth) === 0;
    num("边框是否消失", borderGone ? "是（border 整条失效）" : "否");
    num("无变量宿主的边框色", cs.borderLeftColor);
    check(
      cs.borderLeftWidth === "1px" && cs.borderLeftStyle === "solid",
      "R3：无主题变量时边框仍有 1px solid（var() 的 fallback 生效，不再整条失效）",
      `${cs.borderLeftWidth} ${cs.borderLeftStyle} ${cs.borderLeftColor}`
    );
    check(
      /rgba\(128,\s*128,\s*128/.test(cs.borderLeftColor),
      "R3：退化时用的是 fallback 色 rgba(128,128,128,0.28)",
      cs.borderLeftColor
    );
    check(
      cRect.right <= hRect.right + 0.5,
      "无变量宿主里嵌入块不越出栏宽（" + cRect.right.toFixed(1) + " ≤ " + hRect.right.toFixed(1) + "）"
    );
    check(
      !!cvsRect && cvsRect.right <= hRect.right + 0.5,
      "无变量宿主里 canvas 不越出栏宽（" + (cvsRect ? cvsRect.right.toFixed(1) : "?") + " ≤ " + hRect.right.toFixed(1) + "）"
    );
    /*
     * 这一条测的是"canvas 不会横向溢出"，不是"canvas 一定铺满"。
     * 块是从另一个宿主搬过来的（那边边框占 1px，出图宽 198）；这个宿主没有
     * 边框变量 → 内容宽 200，canvas 198，右边留 2px 空隙——不溢出就对了。
     */
    check(
      !!cvsRect && cvsRect.width <= clone.clientWidth + 0.5,
      "无变量宿主里 canvas 不横向溢出（" + (cvsRect ? cvsRect.width.toFixed(1) : "?") + " ≤ " + clone.clientWidth + "）"
    );
    if (borderGone) {
      num("风险提示", "缺 --background-modifier-border 的宿主上边框消失（真机 Obsidian 一定定义该变量，仅记录）");
    }
    iframe.remove();
  }

  /* ============ 3. 点击落点 ============ */
  group("3. 点击落点：默认替换 leaf / 修饰键与中键开新 tab / 右键不动 / 键盘就地");
  {
    const host = document.getElementById("click-host")!;
    host.innerHTML = "";
    invalidateEmbedCache();
    const node = mkEmbed(host, `${P_MAIN}#3`, 300);
    pp(host, ctx);
    await waitFor(() => !!node.querySelector(".mb-embed-canvas"));
    const cont = node.querySelector(".mb-embed") as HTMLElement;

    // 真插件方法外面包一层，记录 opts（mountEmbed 里是 host.openBookAt(...) 动态取属性）
    const calls: Array<{ path: string; page: number; opts: any }> = [];
    const orig = plugin.openBookAt.bind(plugin);
    plugin.openBookAt = (path: string, page: number, opts?: any) => {
      calls.push({ path, page, opts });
      return orig(path, page, opts);
    };
    const reset = () => {
      calls.length = 0;
      leafArgs.length = 0;
      openFiles.length = 0;
    };
    const click = (init: MouseEventInit) =>
      cont.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
    const aux = (button: number) =>
      cont.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button }));
    const key = (k: string) =>
      cont.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

    reset();
    click({});
    await sleep(60);
    check(
      calls.length === 1 && calls[0].opts === undefined,
      "默认点击 → openBookAt 收到的 opts 是 undefined（不是 {newTab:false}）",
      JSON.stringify(calls[0] || null)
    );
    check(
      calls[0]?.path === P_MAIN && calls[0]?.page === 3,
      "默认点击传的是链接里写的路径与页码（" + JSON.stringify(calls[0] || null) + "）"
    );
    check(leafArgs.length === 1 && leafArgs[0] === false, "默认点击 → getLeaf(false)（替换当前 leaf）", JSON.stringify(leafArgs));
    check(openFiles.length === 1 && openFiles[0] === fileOf[P_MAIN], "默认点击 → openFile 收到的是那本 TFile");

    reset();
    click({ ctrlKey: true });
    await sleep(60);
    check(calls.length === 1 && calls[0].opts?.newTab === true, "Ctrl+点击 → {newTab:true}", JSON.stringify(calls[0] || null));
    check(leafArgs[0] === "tab", "Ctrl+点击 → getLeaf(\"tab\")", JSON.stringify(leafArgs));
    check(openFiles.length === 1 && openFiles[0] === fileOf[P_MAIN], "Ctrl+点击 → openFile 仍是那本 TFile");

    reset();
    click({ metaKey: true });
    await sleep(60);
    check(calls.length === 1 && calls[0].opts?.newTab === true, "Cmd+点击 → {newTab:true}", JSON.stringify(calls[0] || null));
    check(leafArgs[0] === "tab", "Cmd+点击 → getLeaf(\"tab\")", JSON.stringify(leafArgs));

    reset();
    aux(1);
    await sleep(60);
    check(calls.length === 1 && calls[0].opts?.newTab === true, "中键（auxclick button=1）→ {newTab:true}", JSON.stringify(calls[0] || null));
    check(leafArgs[0] === "tab", "中键 → getLeaf(\"tab\")", JSON.stringify(leafArgs));

    reset();
    aux(2);
    await sleep(60);
    check(calls.length === 0 && leafArgs.length === 0, "右键（auxclick button=2）不触发打开", `calls=${calls.length} leaf=${leafArgs.length}`);

    reset();
    key("Enter");
    await sleep(60);
    check(calls.length === 1 && calls[0].opts === undefined, "回车 → 无 newTab", JSON.stringify(calls[0] || null));
    check(leafArgs[0] === false, "回车 → getLeaf(false)", JSON.stringify(leafArgs));

    reset();
    key(" ");
    await sleep(60);
    check(calls.length === 1 && calls[0].opts === undefined, "空格 → 无 newTab", JSON.stringify(calls[0] || null));

    reset();
    key("a");
    await sleep(60);
    check(calls.length === 0, "其它键（a）不触发打开");

    plugin.openBookAt = orig;
  }

  /* ============ 4. 保存后重画（真计时 / 范围 / 并发 / 缓存 / 泄漏） ============ */
  group("4a. 保存后重画：真计时（1.5s 防抖）+ 只看视口内 + 只动这本");
  {
    const near = document.getElementById("refresh-host")!;
    const far = document.getElementById("far-host")!;
    near.innerHTML = "";
    far.innerHTML = "";
    invalidateEmbedCache();

    const a1 = mkEmbed(near, P_REFRESH, 110);
    const a2 = mkEmbed(near, `${P_REFRESH}#3`, 110);
    const b1 = mkEmbed(near, P_OTHER, 110);
    const b2 = mkEmbed(near, P_OTHER, 110);
    const f1 = mkEmbed(far, P_REFRESH, 110);

    pp(near, ctx);
    pp(far, ctx);
    const okNear = await waitFor(() => near.querySelectorAll(".mb-embed-canvas").length >= 4);
    check(okNear, "刷新夹具：视口内 4 个块都渲染了（" + near.querySelectorAll(".mb-embed-canvas").length + " 张）");
    await sleep(300);
    check(!f1.querySelector(".mb-embed-canvas"), "6000px 之外的块没进视口 → 没渲染（懒加载仍生效）");

    const canvasOf = (n: HTMLElement) => n.querySelector(".mb-embed-canvas") as HTMLCanvasElement | null;
    const beforeA1 = canvasOf(a1);
    const beforeA2 = canvasOf(a2);
    const beforeB1 = canvasOf(b1);
    const beforeB2 = canvasOf(b2);

    // 记录每次新增 canvas 的时刻
    const addedAt: number[] = [];
    const t0 = performance.now();
    const mo = new MutationObserver((recs) => {
      for (const rec of recs) {
        rec.addedNodes.forEach((nd) => {
          if ((nd as HTMLElement).classList?.contains("mb-embed-canvas")) addedAt.push(performance.now() - t0);
        });
      }
    });
    mo.observe(near, { childList: true, subtree: true });

    const readsBefore = reads[P_REFRESH] || 0;
    const otherReadsBefore = reads[P_OTHER] || 0;
    const stBefore = embedCacheStats();
    num("modify 前的缓存", JSON.stringify(stBefore));

    // 5 次 modify，间隔 200ms（= 自动保存连发）
    const emitAt: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      emitAt.push(performance.now() - t0);
      emit("modify", fileOf[P_REFRESH]);
      if (i === 0) {
        /*
         * invalidate 是**按路径**清的（这正是设计）：别的本子的条目该留着。
         * 所以断言"这本的 2 条（page1 + page3, 110px）当场没了"，而不是全局归零。
         */
        const st = embedCacheStats();
        check(
          stBefore.bitmaps - st.bitmaps === 2 && st.bytes < stBefore.bytes,
          "modify 一进来这本的 2 条位图缓存就同步清掉了（不等防抖）",
          `${JSON.stringify(stBefore)} → ${JSON.stringify(st)}`
        );
      }
      await sleep(200);
    }
    const lastEmit = emitAt[emitAt.length - 1];
    num("5 次 modify 的时刻(ms)", emitAt.map((t) => Math.round(t)).join(", "));

    await sleep(2600);
    mo.disconnect();

    num("新增 canvas 的时刻(ms)", addedAt.map((t) => Math.round(t)).join(", ") || "(无)");
    check(addedAt.length > 0, "确实发生了重画（新增 canvas " + addedAt.length + " 张）");
    check(
      addedAt.length === 2,
      "只有视口内那 2 个同路径块被重画（新增 " + addedAt.length + " 张，期望 2）"
    );
    check(
      addedAt.every((t) => t >= lastEmit + 1400),
      "1.5s 内没有重画（最早一次在末次 modify 后 " + Math.round((addedAt[0] ?? 0) - lastEmit) + "ms）"
    );
    check(
      addedAt.some((t) => t <= lastEmit + 2200),
      "1.5s 之后确实重画了（最晚一次在末次 modify 后 " + Math.round((addedAt[addedAt.length - 1] ?? 0) - lastEmit) + "ms）"
    );
    check(
      canvasOf(a1) !== beforeA1 && canvasOf(a2) !== beforeA2,
      "视口内两个同路径块的 canvas 都换成了新元素"
    );
    check(canvasOf(b1) === beforeB1 && canvasOf(b2) === beforeB2, "别的本子的 2 个块引用没动（canvas 还是原来那张）");
    check(!f1.querySelector(".mb-embed-canvas"), "视口外的同路径块没有被提前光栅化");

    const readsAfter = reads[P_REFRESH] || 0;
    check(
      readsAfter === readsBefore + 1,
      "重画只重读一次本子（readBook " + readsBefore + " → " + readsAfter + "，同一批共用）"
    );
    check(reads[P_OTHER] === otherReadsBefore, "别的本子没有被重读（" + (reads[P_OTHER] || 0) + "）");
    check(
      near.querySelectorAll(".mb-embed-canvas").length === 4,
      "重画后 canvas 数量没膨胀（" + near.querySelectorAll(".mb-embed-canvas").length + " 张）"
    );
    num("重画后缓存", JSON.stringify(embedCacheStats()));
  }

  /* ============ 4b. 连发 3 次：不能重复渲染、也不能丢最后一次 ============ */
  group("4b. 并发：对一个块连发 3 次 refresh → 最终只多一张 canvas");
  {
    const host = document.getElementById("conc-host")!;
    host.innerHTML = "";
    invalidateEmbedCache();
    const node = mkEmbed(host, P_REFRESH, 160);
    pp(host, ctx);
    await waitFor(() => !!node.querySelector(".mb-embed-canvas"));
    const cont = node.querySelector(".mb-embed") as HTMLElement;
    const before = node.querySelector(".mb-embed-canvas");

    let added = 0;
    const mo = new MutationObserver((recs) => {
      for (const rec of recs) {
        rec.addedNodes.forEach((nd) => {
          if ((nd as HTMLElement).classList?.contains("mb-embed-canvas")) added += 1;
        });
      }
    });
    mo.observe(node, { childList: true, subtree: true });

    const readsBefore = reads[P_REFRESH] || 0;
    for (let i = 0; i < 3; i += 1) {
      emit("modify", fileOf[P_REFRESH]);
      await sleep(80);
    }
    await sleep(2400);
    mo.disconnect();
    const after = node.querySelector(".mb-embed-canvas");
    num("连发 3 次 modify 后新增 canvas", String(added));
    check(added === 1, "3 次请求只画一轮（新增 " + added + " 张，期望 1）");
    check(after !== before && !!after, "最终 canvas 是新画的那张（最后一次没被丢）");
    check(cont.querySelectorAll("canvas").length === 1, "块里只有 1 张 canvas（没有叠层/重复渲染）");
    check(
      (reads[P_REFRESH] || 0) === readsBefore + 1,
      "只重读一次（readBook " + readsBefore + " → " + (reads[P_REFRESH] || 0) + "）"
    );
  }

  /* ============ 4c. 渲染中再来请求 → repaintQueued 补一轮 ============ */
  group("4c. 渲染期间又来了 refresh（慢本 2.2s）→ 记 repaintQueued，最后一次不丢");
  {
    const host = document.getElementById("conc-host")!;
    host.innerHTML = "";
    invalidateEmbedCache();
    const node = mkEmbed(host, P_SLOW, 160);
    pp(host, ctx);
    // 首屏就要 2.2s；等它画完，避免把首次渲染和重画混在一起
    const firstOk = await waitFor(() => !!node.querySelector(".mb-embed-canvas"), 15000);
    check(firstOk, "慢本首屏渲染完成（读文件 2.2s）");

    let added = 0;
    const mo = new MutationObserver((recs) => {
      for (const rec of recs) {
        rec.addedNodes.forEach((nd) => {
          if ((nd as HTMLElement).classList?.contains("mb-embed-canvas")) added += 1;
        });
      }
    });
    mo.observe(node, { childList: true, subtree: true });

    // 第一轮重画在 1.5s 后开始，读文件要 2.2s（到 3.7s 才结束）；
    // 1.6s 时再 emit → 第二轮在 3.1s 触发，此刻 rendering=true → 走 repaintQueued
    emit("modify", fileOf[P_SLOW]);
    await sleep(1600);
    emit("modify", fileOf[P_SLOW]);
    await sleep(6000);
    mo.disconnect();

    const c = node.querySelector(".mb-embed-canvas");
    num("并发期间新增 canvas", String(added));
    check(added >= 1, "至少画了一轮（" + added + " 张）");
    check(!!c, "最终仍有 canvas（没有因为并发丢图）");
    check(node.querySelectorAll("canvas").length === 1, "块里始终只有 1 张 canvas");
    check(added <= 2, "补的一轮没有变成无限重画（" + added + " ≤ 2）");
  }

  /* ============ 4d. 20 轮不泄漏 ============ */
  group("4d. 20 轮重画：DOM 不增长、定时器只剩 0/1 个");
  {
    const host = document.getElementById("leak-host")!;
    host.innerHTML = "";
    invalidateEmbedCache();
    const n1 = mkEmbed(host, P_LEAK, 100);
    const n2 = mkEmbed(host, `${P_LEAK}#2`, 100);
    pp(host, ctx);
    await waitFor(() => host.querySelectorAll(".mb-embed-canvas").length >= 2);
    const embeds0 = host.querySelectorAll(".mb-embed").length;
    const canvases0 = host.querySelectorAll(".mb-embed-canvas").length;

    // 20 次 refresh，分 4 批（每批 5 次连发 + 等防抖落地）
    for (let round = 0; round < 4; round += 1) {
      for (let i = 0; i < 5; i += 1) {
        emit("modify", fileOf[P_LEAK]);
        await sleep(40);
      }
      await sleep(1700);
    }
    await sleep(300);

    const embeds1 = host.querySelectorAll(".mb-embed").length;
    const canvases1 = host.querySelectorAll(".mb-embed-canvas").length;
    const perBlock = Array.from(host.querySelectorAll(".mb-embed")).map((c) => c.querySelectorAll("canvas").length);
    num("20 次 refresh 后", `.mb-embed ${embeds0} → ${embeds1}，canvas ${canvases0} → ${canvases1}，每块 canvas 数 ${perBlock.join(",")}`);
    check(embeds0 === embeds1, "嵌入块数量不增长（" + embeds0 + " → " + embeds1 + "）");
    check(canvases0 === canvases1, "canvas 数量不增长（" + canvases0 + " → " + canvases1 + "）");
    check(
      perBlock.every((n) => n === 1),
      "每个块里始终只有 1 张 canvas（没有叠层）",
      perBlock.join(",")
    );
    num("仍挂着的定时器", String(liveTimers.size));
    check(liveTimers.size <= 1, "防抖定时器没有堆积（剩 " + liveTimers.size + " 个）");
    num("readBook ×20 轮后", String(reads[P_LEAK] || 0));
    check((reads[P_LEAK] || 0) <= 5, "重读次数与轮数同阶（" + (reads[P_LEAK] || 0) + " ≤ 5，说明没有每轮多读）");
  }

  /* ============ 4e. 滚出视口的块在保存后是"旧图"（记录风险，不算失败） ============ */
  group("4e. 已画过又滚出视口的块：保存后不会重画（记录成风险，不计失败）");
  {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;width:180px;display:block";
    document.body.appendChild(host);
    invalidateEmbedCache();
    const node = mkEmbed(host, `${P_LEAK}#3`, 180);
    pp(host, ctx);
    const painted = await waitFor(() => !!node.querySelector(".mb-embed-canvas"));
    check(painted, "块先画出来了（在视口里）");
    const before = node.querySelector(".mb-embed-canvas");

    // 模拟"滚出视口"：整块搬到 6000px 之外（布局位置变，和真滚动对 isEmbedVisible 等价）
    host.style.top = "6000px";
    await sleep(120);
    emit("modify", fileOf[P_LEAK]);
    await sleep(2200);
    host.style.top = "0px";
    await sleep(300);
    const after = node.querySelector(".mb-embed-canvas");
    num("滚出去又滚回来之后的 canvas", after === before ? "还是旧的那张（没重画）" : "换成了新图");
    if (after === before) {
      num(
        "风险记录",
          "视口外的块在保存后保留旧图，滚回来也不会补画（观察器画完就 unobserve）。" +
          "单开笔记里重建 DOM 会自动更新，只有「分栏同时开着笔记 + 墨本」时能看到旧图"
      );
    }
    host.remove();
  }

  /* ============ 5. 角标 ============ */
  group("5. 角标：非越界隐藏 / 越界常显 / hover 规则自己查");
  {
    const host = document.getElementById("badge-host")!;
    host.innerHTML = "";
    invalidateEmbedCache();
    const nNormal = mkEmbed(host, P_MAIN, 200);
    const nClamp = mkEmbed(host, `${P_MAIN}#99`, 200);
    pp(host, ctx);
    await waitFor(() => host.querySelectorAll(".mb-embed-canvas").length >= 2);

    const normalCont = nNormal.querySelector(".mb-embed") as HTMLElement;
    const normalBadge = nNormal.querySelector(".mb-embed-badge") as HTMLElement;
    const clampCont = nClamp.querySelector(".mb-embed") as HTMLElement;
    const clampBadge = nClamp.querySelector(".mb-embed-badge") as HTMLElement;

    check(!!normalBadge, "非越界块有角标");
    check(!!clampBadge, "越界块有角标");
    if (!normalBadge || !clampBadge) throw new Error("角标没生成，后面的断言无从谈起");
    const normalOp = getComputedStyle(normalBadge).opacity;
    const clampOp = getComputedStyle(clampBadge).opacity;
    num("非越界角标", `text="${normalBadge.textContent}" opacity=${normalOp}`);
    check(normalOp === "0", "非越界：未 hover 时 computed opacity === \"0\"", normalOp);
    check(normalBadge.textContent === "第 1 页", "非越界文案 = 「第 1 页」", normalBadge.textContent || "");
    check(
      normalCont.dataset.inkbookClamped === "0" && normalCont.dataset.inkbookPage === "1",
      "非越界容器 data-inkbook-clamped=0 / page=1",
      JSON.stringify({ c: normalCont.dataset.inkbookClamped, p: normalCont.dataset.inkbookPage })
    );
    check(!normalCont.classList.contains("is-clamped") && !normalBadge.classList.contains("is-clamped"), "非越界没有 is-clamped");

    num("越界角标", `text="${clampBadge.textContent}" opacity=${clampOp}`);
    check(clampOp === "1", "越界：computed opacity === \"1\"（常显）", clampOp);
    check(clampBadge.classList.contains("is-clamped") && clampCont.classList.contains("is-clamped"), "越界：角标与容器都带 is-clamped");
    check(/共 3 页/.test(clampBadge.textContent || ""), "越界文案含「共 3 页」", clampBadge.textContent || "");
    check(
      clampCont.dataset.inkbookClamped === "1" && clampCont.dataset.inkbookPage === "3",
      "越界容器 data-inkbook-clamped=1 / page=3",
      JSON.stringify({ c: clampCont.dataset.inkbookClamped, p: clampCont.dataset.inkbookPage })
    );
    const clampColor = getComputedStyle(clampBadge).backgroundColor;
    num("越界角标底色", clampColor);
    check(clampColor !== "rgba(0, 0, 0, 0)", "越界角标有底色（警示色生效，不是透明）", clampColor);

    /* hover 规则：自己遍历样式表，不用工程师的辅助函数 */
    const wanted: Array<{ sel: string; opacity: string }> = [];
    const walk = (rules: CSSRuleList) => {
      for (const r of Array.from(rules)) {
        const any = r as any;
        if (typeof any.selectorText === "string" && any.style && any.selectorText.includes(".mb-embed-badge")) {
          wanted.push({ sel: any.selectorText, opacity: any.style.opacity || "(未设)" });
        }
        if (any.cssRules) walk(any.cssRules as CSSRuleList);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        if (sheet.cssRules) walk(sheet.cssRules);
      } catch (_) {
        /* 跨域表跳过 */
      }
    }
    for (const w of wanted) log("    规则 " + w.sel + " → opacity: " + w.opacity);
    const hoverRule = wanted.find((w) => w.sel.includes(":hover"));
    check(!!hoverRule, "存在命中 .mb-embed-badge 的 :hover 规则");
    check(
      !!hoverRule && parseFloat(hoverRule.opacity) > 0,
      "hover 规则里 opacity > 0（" + (hoverRule ? hoverRule.opacity : "无") + "）"
    );
    check(
      !!hoverRule && /\.mb-embed:hover\s+\.mb-embed-badge/.test(hoverRule.sel),
      "hover 规则的选择器是 .mb-embed:hover .mb-embed-badge",
      hoverRule?.sel || ""
    );
    // 越界角标的显形规则不能只在 hover 里 —— 未 hover 已经验过 opacity=1
    const clampRule = wanted.find((w) => w.sel.includes("is-clamped"));
    check(!!clampRule && parseFloat(clampRule.opacity) === 1, "is-clamped 规则的 opacity 是 1", clampRule?.opacity || "无");
    num("相关规则条数", String(wanted.length));
  }

  /* ============ 汇总 ============ */
  group("6. 异常记账");
  check(uncaught.length === 0, "全程没有未捕获异常 / 未处理 reject", uncaught.slice(0, 3).join(" | ") || "ok");
  num("未捕获异常", String(uncaught.length));

  disposePlugin(plugin);
  log("");
  log(`合计 ${checks} 项检查：失败 ${failures} 项`);
  log(failures === 0 ? "QA-ALL-PASS" : "QA-FAILED=" + failures);
  document.title = "DONE";
}

/** onunload 里会清缓存 + 断观察器；跑到这里 DOM 已经测完了 */
function disposePlugin(plugin: any): void {
  try {
    plugin.onunload();
  } catch (e) {
    log("WARN onunload 抛错：" + String((e as any)?.message || e));
  }
  invalidateEmbedCache();
}

main().catch((e) => {
  log("FATAL " + (e?.stack || e));
  document.title = "FATAL";
});
