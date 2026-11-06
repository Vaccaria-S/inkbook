/**
 * 「打开 300 多页的大本子很慢」——分阶段计时 + 常驻性能断言。
 *
 * 为什么要这个套件：用户反馈打开 300+ 页的手写本很慢。改代码之前必须先知道
 * 时间花在哪一段，"感觉慢"不能作为优化的理由。这里把整条打开链路拆成计时点，
 * 并把结果固化成上界断言，防止以后的改动把它悄悄拖回去。
 *
 * 分两段测，因为它们是两件事：
 *   · 真实视图链路 —— new InkbookView → onOpen → onLoadFile
 *     （含 readBook / buildUI / mountEditor / 侧栏 300 个缩略图条目），
 *     这一段就是用户点开文件时真正发生的事。
 *   · 组件级 —— readBook 之后 new BookEditor，逐个函数计时，用来定位瓶颈。
 *
 * 顺序上先跑视图段：视图段最"干净"，放在一堆 72MB 的大对象之后跑会被
 * GC 和内存压力污染（同一份代码在饱和的页面里能慢十倍，那是环境不是代码）。
 *
 * 计时全部靠给原型方法套一层皮（见 timed()），不往生产代码里塞埋点。
 */
import { parseBook, readBook, bookStats, type ReadAdapter } from "../src/storage";
import { BookEditor } from "../src/editor";
import { BookStore } from "../src/store";
import { InkbookView } from "../src/view";
import { DEFAULT_SETTINGS, type InkBook } from "../src/types";

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

/* ------------------------------------------------------------------ */
/* 样本（由 test/make-open-samples.mjs 生成，不入库）                    */
/* ------------------------------------------------------------------ */

interface Sample {
  key: string;
  file: string;
  label: string;
  expectPages: number;
  /**
   * 这一档的上界（毫秒）。取「实测中位数 × 2 再向上取整到整数百」。
   *
   * 为什么不按体积线性外推：打开耗时不只跟字节数有关，还跟笔迹数、
   * 文字条数、是否带底图有关。每档各自量、各自定，才不会被别的档带偏。
   *
   * 为什么留 2 倍而不是 1.2 倍：无头浏览器跑在共享机器上，一次 GC、
   * 一个后台任务就能让同样的代码慢一倍。卡太紧会变成随机红灯，
   * 那时候大家就开始无视这个套件——比没有套件更糟。
   */
  limit: {
    /** onLoadFile 全程 */
    openMs: number;
    /** 首屏（打开落在的那一页的笔迹画布真的挂上并画出来） */
    firstReadyMs: number;
    /** normalizeBook 单独一段（这一段的成本跟笔迹点数成正比） */
    normalizeMs: number;
  };
}

const SAMPLES: Sample[] = [
  {
    key: "A",
    file: "A-300p-ink.inkbook",
    label: "A 纯手写 300 页（30 笔迹/页，10.6MB）",
    expectPages: 300,
    // 实测 open 122ms / 首屏就绪 138ms / normalize 2.5ms → 上界取 ~2 倍
    limit: { openMs: 400, firstReadyMs: 500, normalizeMs: 20 },
  },
  {
    key: "B",
    file: "B-300p-ink-text.inkbook",
    label: "B 手写+文字层 300 页（1500 字/页，12.6MB）",
    expectPages: 300,
    // 实测 open 128ms / 首屏就绪 147ms / normalize 5.3ms → 上界取 ~2 倍
    limit: { openMs: 400, firstReadyMs: 500, normalizeMs: 30 },
  },
  {
    key: "C",
    file: "C-300p-ink-text-pdf.inkbook",
    label: "C 手写+文字层+PDF底图 300 页（12.6MB）",
    expectPages: 300,
    // 实测 open 124ms / 首屏就绪 146ms / normalize 2.8ms → 上界取 ~2 倍
    limit: { openMs: 400, firstReadyMs: 500, normalizeMs: 30 },
  },
  {
    key: "D",
    file: "D-real-857p.inkbook",
    label: "D 真实本子 857 页（PDF 导入，4.9MB）",
    expectPages: 857,
    // 实测 open 94ms / 首屏就绪 133ms / normalize 1.6ms → 上界取 ~2 倍
    limit: { openMs: 400, firstReadyMs: 500, normalizeMs: 20 },
  },
  {
    key: "E",
    file: "E-300p-dense.inkbook",
    label: "E 300 页超密手写（200 笔迹/页，72MB）",
    expectPages: 300,
    /*
     * 实测 open 最快 677ms（同机中位数会被 GC/磁盘缓存带到 923~1067ms，波动 1.6×）、
     * 首屏最快 717ms、normalize 14~60ms。
     *
     * 判定口径已改成「暖机后最快值」（openBest），单轮抖动基本不影响结果，
     * 所以 2000 对 677ms 是 3× 余量——仍有意义（能抓「慢到三倍」），但不算敏感。
     * 想更敏感可以收到 1400（2.1×）；别低于 1200，否则磁盘冷缓存那一轮会误报。
     */
    limit: { openMs: 2000, firstReadyMs: 2000, normalizeMs: 150 },
  },
];

/** 每个样本跑几次取中位数——单次测量受 GC 抖动影响太大，不能拿一次下结论 */
const REPEATS = 3;

/** 打开 300 页后 JS 堆增量上界（performance.memory 可用时才检查） */
const HEAP_DELTA_LIMIT = 400 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* 计时基础设施                                                         */
/* ------------------------------------------------------------------ */

interface Acc {
  ms: number;
  n: number;
}
const acc = (): Acc => ({ ms: 0, n: 0 });

/** 给原型方法套一层计时器（跑完一次测量就还回去，避免重复累加） */
function timed(proto: any, name: string, box: Acc, undo: Array<() => void>): boolean {
  const orig = proto[name];
  if (typeof orig !== "function") return false;
  proto[name] = function (this: any, ...args: any[]) {
    const t = performance.now();
    try {
      return orig.apply(this, args);
    } finally {
      box.ms += performance.now() - t;
      box.n += 1;
    }
  };
  undo.push(() => {
    proto[name] = orig;
  });
  return true;
}

/** 给原型方法套一层"打点"（只在排查时用，用来找"打开之后那一秒去哪了"） */
function traced(
  proto: any,
  name: string,
  undo: Array<() => void>,
  t0: number,
  sink: string[]
): void {
  const orig = proto[name];
  if (typeof orig !== "function") return;
  proto[name] = function (this: any, ...args: any[]) {
    const s = performance.now();
    try {
      return orig.apply(this, args);
    } finally {
      const d = performance.now() - s;
      if (d > 1) sink.push(`${name} ${d.toFixed(1)}ms @${Math.round(performance.now() - t0)}ms`);
    }
  };
  undo.push(() => {
    proto[name] = orig;
  });
}

/**
 * 取最小值；全是 0/负数（说明每一轮都没测出来）就返回 -1。
 *
 * 不能直接 Math.min(...[])：空数组返回 Infinity，`Infinity <= limit` 虽然是
 * false（断言会红），但打印出来是 "最快 Infinity ms"，看不出是"没测到"还是"很慢"。
 */
const minOrNeg = (xs: number[]): number => {
  const ok = xs.filter((v) => v > 0);
  return ok.length ? Math.min(...ok) : -1;
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const mb = (n: number) => (n / 1048576).toFixed(2);
const heapNow = (): number => (performance as any).memory?.usedJSHeapSize ?? 0;
const sampleUrl = (file: string) => `/test/samples/${encodeURIComponent(file)}`;

/** 从本机测试服务读样本（等价于 Obsidian 的 vault.adapter.read） */
async function readSampleText(file: string): Promise<string> {
  const r = await fetch(sampleUrl(file), { cache: "no-store" });
  if (!r.ok) throw new Error("样本读取失败 " + file + " → HTTP " + r.status);
  return await r.text();
}

function makeFetchAdapter(): ReadAdapter {
  return {
    exists: async () => true,
    read: async (path: string) => await readSampleText(path),
  };
}

/**
 * 底图 PDF 的自检：**必须**是 900 页那份样本，不能是任何备用的小 PDF。
 *
 * 为什么要有这一条（QA 踩到的假绿）：样本里每页都引用 `background.pdf` 的第 N 页。
 * 如果测试服务陈旧 / 没有 samples 路由，`/大文档.pdf` 会退回到 763 字节的
 * `test/blank.pdf`（只有 1 页）。这时 pdf.js 对第 2 页往后全报
 * `Invalid page request`，C/D 两档的底图走的是**加载失败分支**，
 * 而所有断言依然会绿——等于白测一档还看不出来。
 *
 * 所以先量一下这个 URL 的字节数：小于 100KB 一律当作环境坏了，
 * 直接判 FAIL 并说清怎么修，而不是在坏环境上跑出一张漂亮的表。
 */
const SAMPLE_PDF_MIN_BYTES = 100 * 1024;

async function checkSamplePdf(): Promise<void> {
  let size = 0;
  let err = "";
  try {
    const r = await fetch("/大文档.pdf", { cache: "no-store" });
    if (r.ok) {
      const buf = await r.arrayBuffer();
      size = buf.byteLength;
    } else {
      err = "HTTP " + r.status;
    }
  } catch (e: any) {
    err = e?.message || String(e);
  }
  pass(
    size >= SAMPLE_PDF_MIN_BYTES,
    `底图 PDF 自检：/大文档.pdf = ${size} 字节（需 ≥ ${SAMPLE_PDF_MIN_BYTES}；` +
      `763 字节的 blank.pdf 说明测试服务陈旧，请用 test/run-with-server.mjs 起服务）` +
      (err ? " 错误：" + err : "")
  );
}

/**
 * 「首屏就绪」的判定：**打开时落在的那一页**（activePage）的笔迹画布已经挂上、
 * 有非零设备像素尺寸、并且在布局里有真实面积。
 *
 * 为什么必须按 activePage 而不是第 0 页：本子会记住上次读到第几页，
 * 857 页的真实样本 activePage 是 119——打开时页 0 根本不在视口里，
 * 用页 0 判定会永远等不到。
 *
 * 为什么不用「页面 wrap 出现在 DOM 里」：那在建 DOM 的循环第一轮就成立了，
 * 用户看到的还是白屏。必须等到画布那一步，才算"看得见"。
 */
function pagePainted(scope: ParentNode, index: number): boolean {
  const wrap = scope.querySelector(`.mb-page-wrap[data-page='${index}']`) as HTMLElement | null;
  if (!wrap || !wrap.isConnected) return false;
  const canvas = wrap.querySelector("canvas.mb-canvas") as HTMLCanvasElement | null;
  if (!canvas) return false;
  if (!(canvas.width > 0 && canvas.height > 0)) return false;
  const r = canvas.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/**
 * 让出一次主线程（macrotask），用来轮询"画出来没有"。
 *
 * **刻意不用 requestAnimationFrame。** 无头 Edge 会把 rAF 压到 1Hz
 * （页面被判定不可见 / 合成器空转），同一份代码能因此量出 1000ms、
 * 5000ms 的"首屏耗时"——那是测量环境在打鼾，不是插件慢。实测同一份代码
 * 同一个样本，这一轮 140ms、下一轮 1140ms，两态之间毫无规律。
 *
 * 用 setTimeout(0) 轮询得到的是「画布挂上并绘制完成」的时刻。
 * 它比用户真正看到画面早了**最多一帧（~16ms）**——这个差额是固定的、
 * 可解释的，比一个会在 1 秒和 5 秒之间乱跳的数字有用得多。
 */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}


/* ------------------------------------------------------------------ */
/* 第一段：真实视图链路（new InkbookView → onLoadFile）                  */
/* ------------------------------------------------------------------ */

interface ViewRun {
  openTotal: number;
  openBook: number;
  buildUI: number;
  mountEditor: number;
  buildSide: number;
  renderPageList: number;
  firstReady: number;
  thumbs: number;
  pageCountOk: boolean;
  lastPageOk: boolean;
  errors: string[];
}

interface ViewResult {
  key: string;
  label: string;
  openTotal: number;
  /** 暖机轮里最快的一次「打开全程」。
   *  和首屏同理：无头环境的偶发停顿（GC / 合成器 / 后台任务）会让某一轮
   *  凭空多出几百毫秒，中位数会被拖走；最小值才是"这段代码需要多久"的稳定估计。 */
  openBest: number;
  openBook: number;
  buildUI: number;
  mountEditor: number;
  buildSide: number;
  renderPageList: number;
  firstReady: number;
  /** 暖机轮里最快的一次首屏：无头浏览器的 rAF 节流会让个别轮次凭空多出 1-5 秒，
   *  取最小值才是"这段代码到底需要多久"的稳定估计（中位数会被那几次拖走） */
  firstReadyBest: number;
  thumbs: number;
  pageCountOk: boolean;
  lastPageOk: boolean;
  errors: string[];
}

/** 造一个够用的 Obsidian app / vault / plugin 替身（照 view-harness 的做法） */
function makeViewEnv(sample: Sample) {
  const path = sample.file;
  const files = new Map<string, string>();
  const index = new Map<string, any>();
  const mk = (p: string) => ({
    path: p,
    basename: p.split("/").pop()!.replace(/\.[^.]+$/, ""),
    extension: p.split(".").pop()!,
    parent: { path: "/" },
  });
  const fileObj = mk(path);
  index.set(path, fileObj);

  const adapter = {
    exists: async (p: string) => p === path || files.has(p),
    read: async (p: string) => (p === path ? await readSampleText(path) : files.get(p) ?? ""),
    write: async (p: string, d: string) => void files.set(p, d),
    writeBinary: async (p: string) => void files.set(p, ""),
    mkdir: async () => {},
    stat: async (p: string) => ({ mtime: Date.now(), size: files.get(p)?.length ?? 0 }),
    rename: async (a: string, b: string) => {
      const v = files.get(a);
      if (v != null) {
        files.set(b, v);
        files.delete(a);
      }
    },
    remove: async (p: string) => void files.delete(p),
    list: async () => ({ files: [], folders: [] }),
  };
  const vault = {
    adapter,
    createFolder: async (p: string) => {
      const f = { path: p, type: "folder" };
      index.set(p, f);
      return f;
    },
    create: async (p: string, text: string) => {
      files.set(p, text);
      const f = mk(p);
      index.set(p, f);
      return f;
    },
    getAbstractFileByPath: (p: string) => index.get(p) || null,
    getFiles: () => [...index.values()].filter((f: any) => f.extension),
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
  return { app, leaf, plugin, fileObj, files };
}

/**
 * 跑一次完整的「新建视图 → onOpen → onLoadFile」。
 *
 * 每轮都换一个干净的 #view-host：obsidian-stub 的 ItemView 会把容器挂到
 * 这个节点上，不清掉的话上一轮那几百页 DOM 会留在页面里，越跑越慢。
 */
async function openViewOnce(sample: Sample, collectProbe: boolean): Promise<ViewRun> {
  let host = document.getElementById("view-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "view-host";
    document.body.appendChild(host);
  }
  host.innerHTML = "";

  const env = makeViewEnv(sample);
  const proto: any = (InkbookView as any).prototype;
  const undo: Array<() => void> = [];
  const bOpenBook = acc();
  const bBuildUI = acc();
  const bMountEditor = acc();
  const bBuildSide = acc();
  const bPageList = acc();
  for (const [name, box] of [
    ["openBook", bOpenBook],
    ["buildUI", bBuildUI],
    ["mountEditor", bMountEditor],
    ["buildSide", bBuildSide],
    ["renderPageList", bPageList],
  ] as Array<[string, Acc]>) {
    timed(proto, name, box, undo);
  }

  const errors: string[] = [];
  const traceSink: string[] = [];
  const view: any = new InkbookView(env.leaf, env.plugin);

  /*
   * 把 registerDomEvent 打成空操作。
   *
   * 为什么必须这么做：obsidian-stub 的 registerDomEvent 就是裸的
   * `el.addEventListener`，没有任何反注册机制。视图会在 document / window
   * 上挂 keydown / resize 监听，而监听器的闭包**指回这个 view**。
   * 结果：每跑一轮（5 个样本 × 4 轮 = 20 个 view）就多挂一批永远摘不掉的
   * 监听器，把几百页的 DOM、13MB 的字符串、pdf.js 的 worker 一起钉在内存里。
   *
   * 实测后果非常具体：单跑 C 时首屏 165ms，让 A、B 先跑过之后 C 变成
   * 5500ms——那不是"打开慢了"，那是一次被逼出来的大 GC。测性能的套件
   * 自己制造 GC 停顿，量出来的数字没法用。
   *
   * 这两个监听器测的是键盘和窗口缩放，本轮一个都不测，所以直接不要。
   */
  const viewProto: any = (InkbookView as any).prototype;
  viewProto.registerDomEvent = () => {};

  await view.onOpen();
  // onOpen 是一次性的（建顶栏 / 侧栏 / 状态栏），不计入「打开文件」的耗时
  await sleep(40);

  if (collectProbe) {
    for (const name of ["markDirty", "saveNow", "flushSave", "scheduleTextIndex", "updateUI"]) {
      traced(proto, name, undo, performance.now(), traceSink);
    }
  }

  const t0 = performance.now();
  try {
    await view.onLoadFile(env.fileObj);
  } catch (e: any) {
    errors.push("onLoadFile: " + (e?.message || e));
  }
  const t1 = performance.now();

  /* ---- 首屏：等那一页真的画出来 ---- */
  let visibleAt = -1;
  const firstIdx = view.store?.data.activePage || 0;
  const waitStart = performance.now();
  let polls = 0;
  while (performance.now() - waitStart < 8000) {
    await nextTick();
    polls++;
    if (pagePainted(view.contentEl, firstIdx)) {
      visibleAt = performance.now();
      break;
    }
  }

  /* ---- 滚到最后一页：懒加载必须仍然正确（不能出现空白页） ---- */
  let lastPageOk = false;
  try {
    view.editor?.goToPage(sample.expectPages - 1, false);
    await sleep(260);
    const lastWrap = view.contentEl.querySelector(
      `.mb-page-wrap[data-page='${sample.expectPages - 1}']`
    ) as HTMLElement | null;
    const cv = lastWrap?.querySelector("canvas.mb-canvas") as HTMLCanvasElement | null;
    lastPageOk = !!(cv && cv.width > 0 && cv.height > 0);
  } catch (e: any) {
    errors.push("滚到最后一页: " + (e?.message || e));
  }

  /*
   * store 为空 = readBook 抛错、页面已经切到错误态。
   * 最常见的原因是测试服务在跑到一半时挂了（fetch failed），
   * 这时必须明确报"读不出来"，否则后面的数字会变成一堆无意义的 2ms/0 条。
   */
  if (!view.store) errors.push("onLoadFile 后 store 为空（读盘/解析失败，检查测试服务是否还在）");

  const thumbs = view.contentEl.querySelectorAll(".mb-thumb").length;
  const pageCountOk = view.store?.pageCount === sample.expectPages;
  for (const fn of undo) fn();

  if (collectProbe && visibleAt - t0 > 1500) {
    log(`    （首屏慢，落在第 ${firstIdx + 1} 页，轮询了 ${polls} 次）`);
    for (const t of traceSink.slice(0, 12)) log("      · " + t);
  }

  const run: ViewRun = {
    openTotal: t1 - t0,
    openBook: bOpenBook.ms,
    buildUI: bBuildUI.ms,
    mountEditor: bMountEditor.ms,
    buildSide: bBuildSide.ms,
    renderPageList: bPageList.ms,
    firstReady: visibleAt >= 0 ? visibleAt - t0 : -1,
    thumbs,
    pageCountOk,
    lastPageOk,
    errors,
  };

  try {
    view.destroyEditor?.();
  } catch (_) {
    /* 忽略：视图只是测试替身，销毁失败不影响结论 */
  }
  host.innerHTML = "";
  await sleep(120);
  return run;
}

/** 同一个样本跑 REPEATS+1 次：第一次当暖机丢掉，其余取中位数 */
async function measureView(sample: Sample): Promise<ViewResult> {
  const runs: ViewRun[] = [];
  for (let i = 0; i <= REPEATS; i++) {
    runs.push(await openViewOnce(sample, i === 1));
  }
  const warm = runs.slice(1);
  const pick = (k: keyof ViewRun) => median(warm.map((r) => Number(r[k])));
  const result: ViewResult = {
    key: sample.key,
    label: sample.label,
    openTotal: pick("openTotal"),
    openBest: minOrNeg(warm.map((r) => r.openTotal)),
    openBook: pick("openBook"),
    buildUI: pick("buildUI"),
    mountEditor: pick("mountEditor"),
    buildSide: pick("buildSide"),
    renderPageList: pick("renderPageList"),
    firstReady: pick("firstReady"),
    firstReadyBest: minOrNeg(warm.map((r) => r.firstReady)),
    thumbs: warm[warm.length - 1].thumbs,
    pageCountOk: warm.every((r) => r.pageCountOk),
    lastPageOk: warm.every((r) => r.lastPageOk),
    errors: warm.flatMap((r) => r.errors),
  };

  const row = (name: string, v: number, note = "") =>
    log(`  ${name.padEnd(22, " ")}${v.toFixed(1).padStart(9)} ms  ${note}`);
  log("");
  log(`===== 真实视图链路：${sample.label}（${REPEATS} 次中位数，已暖机）=====`);
  row("onLoadFile 全程（中位数）", result.openTotal);
  row("onLoadFile 全程（最快）", result.openBest);
  row("  openBook 合计", result.openBook);
  row("    buildUI", result.buildUI);
  row("    mountEditor 合计", result.mountEditor);
  row("      buildSide 合计", result.buildSide);
  row("        renderPageList", result.renderPageList, `（${result.thumbs} 个缩略图条目）`);
  row("      mountEditor 其余", Math.max(0, result.mountEditor - result.buildSide));
  row("首屏就绪（中位数）", result.firstReady);
  row("首屏就绪（最快）", result.firstReadyBest);
  log(
    `  [每轮首屏] ${runs
      .map((r, i) => `${i === 0 ? "暖机" : "#" + i}=${r.firstReady.toFixed(0)}`)
      .join(" / ")} ms`
  );
  log(
    `  页数正确：${result.pageCountOk ? "是" : "否"}　最后一页能挂载：${
      result.lastPageOk ? "是" : "否"
    }`
  );
  if (result.errors.length) log("  错误：" + result.errors.join(" / "));
  return result;
}

/* ------------------------------------------------------------------ */
/* 附加检查：「正在打开…」占位                                            */
/* ------------------------------------------------------------------ */

/**
 * 占位是"感知优化"里唯一能被机器验证的部分，所以单独测一遍：
 * 它必须真的出现、写明是哪一本、写对体积，并且**打开完成后必须消失**。
 *
 * 最后那条最重要：占位如果留在纸上，用户会以为本子打不开。
 */
async function checkLoadingPlaceholder(): Promise<void> {
  const sample = SAMPLES[0];
  const env = makeViewEnv(sample);
  const viewProto: any = (InkbookView as any).prototype;
  const origReg = viewProto.registerDomEvent;
  viewProto.registerDomEvent = () => {};

  const view: any = new InkbookView(env.leaf, env.plugin);
  await view.onOpen();

  // 直接调（私有方法在 JS 里就是普通方法），模拟 onLoadFile 的第一步
  view.showLoading("未命名笔记 2", 13 * 1024 * 1024);
  const box = view.contentEl.querySelector(".mb-loading") as HTMLElement | null;
  pass(!!box, "打开中的占位能显示出来");
  pass(!!box && (box.textContent || "").includes("未命名笔记 2"), "占位写明正在打开哪一本");
  pass(!!box && /13\.0MB/.test(box.textContent || ""), "占位显示真实体积（13.0MB）");

  try {
    await view.onLoadFile(env.fileObj);
  } catch (e: any) {
    pass(false, "占位检查：onLoadFile 抛错 " + (e?.message || e));
  }
  pass(!view.contentEl.querySelector(".mb-loading"), "打开完成后占位消失，不会盖在纸上");

  try {
    view.destroyEditor?.();
  } catch (_) {
    /* 忽略 */
  }
  viewProto.registerDomEvent = origReg;
  document.getElementById("view-host")!.innerHTML = "";
  await sleep(150);
}

/* ------------------------------------------------------------------ */
/* 第二段：组件级分阶段计时                                             */
/* ------------------------------------------------------------------ */

interface StageResult {
  key: string;
  label: string;
  bytes: number;
  pages: number;
  stages: Record<string, number>;
  readBookMs: number;
  heapDelta: number;
  errors: string[];
}

/** 造一个跟真实 Obsidian 一致的容器（.mb-root > .mb-host > .mb-scroll） */
function makeEditorHost(): [HTMLElement, () => void] {
  const root = document.createElement("div");
  root.className = "mb-root";
  root.style.cssText =
    "position:absolute;left:0;top:0;width:900px;height:700px;overflow:hidden;display:flex;flex-direction:column";
  const host = document.createElement("div");
  host.className = "mb-host";
  root.appendChild(host);
  document.body.appendChild(root);
  return [host, () => root.remove()];
}

async function measureStages(sample: Sample): Promise<StageResult> {
  const runs: Array<Record<string, number>> = [];
  let bytes = 0;
  let pages = 0;
  let readBookMs = 0;
  let heapDelta = 0;
  const errors: string[] = [];

  for (let run = 0; run < REPEATS; run++) {
    /* 1. 读盘 */
    const r0 = performance.now();
    const text = await readSampleText(sample.file);
    const r1 = performance.now();
    bytes = text.length;

    /* 2. JSON.parse */
    const p0 = performance.now();
    const raw = JSON.parse(text) as any;
    const p1 = performance.now();

    /* 3. normalizeBook（白名单重建整本书） */
    const n0 = performance.now();
    const book: InkBook = parseBook(raw, sample.label);
    const n1 = performance.now();
    pages = book.pages.length;

    /* 4. 完整性核对（bookStats 遍历全书） */
    const i0 = performance.now();
    bookStats(book);
    const i1 = performance.now();

    /* 5. 建页 DOM + 首帧（原型方法埋点） */
    const proto: any = (BookEditor as any).prototype;
    const undo: Array<() => void> = [];
    const bCreate = acc();
    const bLayout = acc();
    const bObserve = acc();
    const bMount = acc();
    const bRenderPages = acc();
    timed(proto, "createPageRec", bCreate, undo);
    timed(proto, "applyLayout", bLayout, undo);
    timed(proto, "observePages", bObserve, undo);
    timed(proto, "mount", bMount, undo);
    timed(proto, "renderPages", bRenderPages, undo);

    // 主线程冻结监测：rAF 相邻两帧的最大间隔 = 最长一次同步阻塞
    let last = performance.now();
    let maxGap = 0;
    let watching = true;
    const rafLoop = () => {
      const now = performance.now();
      if (now - last > maxGap) maxGap = now - last;
      last = now;
      if (watching) requestAnimationFrame(rafLoop);
    };
    requestAnimationFrame(rafLoop);

    const heapBefore = heapNow();
    const e0 = performance.now();
    const store = new BookStore(book);
    const [host, cleanup] = makeEditorHost();
    const editor = new BookEditor(host, store, { smoothing: 0.5, pressure: true });
    const e1 = performance.now();
    const heapAfter = heapNow();

    let visibleAt = -1;
    const waitStart = performance.now();
    while (performance.now() - waitStart < 8000) {
      await nextTick();
      if (pagePainted(host, book.activePage || 0)) {
        visibleAt = performance.now();
        break;
      }
    }
    watching = false;
    for (const fn of undo) fn();

    /* 6. 真实 readBook 端到端（含 exists / parse / 完整性核对） */
    const rb0 = performance.now();
    try {
      await readBook(makeFetchAdapter(), sample.file, sample.label);
      readBookMs = performance.now() - rb0;
    } catch (e: any) {
      errors.push("readBook: " + (e?.message || e));
    }

    runs.push({
      read: r1 - r0,
      parse: p1 - p0,
      normalize: n1 - n0,
      integrity: i1 - i0,
      domBuild: bCreate.ms,
      domAppend: Math.max(0, bRenderPages.ms - bCreate.ms - bLayout.ms - bObserve.ms),
      layout: bLayout.ms,
      observe: bObserve.ms,
      mount: bMount.ms,
      firstReady: visibleAt >= 0 ? visibleAt - e0 : -1,
      blocking: maxGap,
      editorCtor: e1 - e0,
    });
    heapDelta = heapAfter - heapBefore;

    editor.destroy();
    cleanup();
    // 让上一轮的 DOM / 画布有机会被回收，否则下一轮带着别人的垃圾测
    await sleep(150);
  }

  const pick = (k: string) => median(runs.map((r) => r[k]));
  const stages: Record<string, number> = {};
  for (const k of Object.keys(runs[0])) stages[k] = pick(k);

  const result: StageResult = {
    key: sample.key,
    label: sample.label,
    bytes,
    pages,
    stages,
    readBookMs,
    heapDelta,
    errors,
  };

  /* ---- 打印分段表 ---- */
  const m = stages;
  const total = m.read + m.parse + m.normalize + m.integrity + m.editorCtor;
  const pct = (v: number) => (total > 0 ? ((v / total) * 100).toFixed(1) + "%" : "-");
  const row = (name: string, v: number) =>
    log(`  ${name.padEnd(24, " ")}${v.toFixed(1).padStart(9)} ms  ${pct(v).padStart(6)}`);
  log("");
  log(`===== 组件级：${sample.label}（${mb(bytes)}MB / ${pages} 页，${REPEATS} 次中位数）=====`);
  row("读盘 adapter.read", m.read);
  row("JSON.parse", m.parse);
  row("normalizeBook", m.normalize);
  row("完整性核对 bookStats", m.integrity);
  row(`createPageRec × ${pages}`, m.domBuild);
  row(`appendChild × ${pages}`, m.domAppend);
  row("applyLayout", m.layout);
  row(`observePages × ${pages}`, m.observe);
  row("REST: new BookEditor", m.editorCtor);
  log("  " + "-".repeat(45));
  log(`  ${"同步合计".padEnd(24, " ")}${total.toFixed(1).padStart(9)} ms`);
  log(
    `  ${"其中首次 mount（含绘制）".padEnd(22, " ")}${m.mount.toFixed(1).padStart(9)} ms（已含在 BookEditor 里）`
  );
  log(`  ${"最长一次主线程阻塞".padEnd(22, " ")}${m.blocking.toFixed(1).padStart(9)} ms`);
  log(`  ${"首屏就绪".padEnd(24, " ")}${m.firstReady.toFixed(1).padStart(9)} ms`);
  log(`  ${"readBook 端到端".padEnd(22, " ")}${result.readBookMs.toFixed(1).padStart(9)} ms`);
  log(`  ${"堆增量".padEnd(25, " ")}${(result.heapDelta / 1048576).toFixed(1).padStart(9)} MB`);
  if (result.errors.length) log("  错误：" + result.errors.join(" / "));
  return result;
}

/* ------------------------------------------------------------------ */

async function main() {
  // 调试用：?only=view 只跑视图段，?only=stage 只跑组件段，?pick=D 只跑某个样本
  const qs = new URLSearchParams(location.search);
  const only = qs.get("only") || "";
  const pickKey = qs.get("pick") || "";
  const samples = pickKey ? SAMPLES.filter((s) => s.key === pickKey) : SAMPLES;

  log("打开大本子性能测量（无头 Edge）");
  log(`performance.memory：${(performance as any).memory ? "可用" : "不可用（内存断言跳过）"}`);

  /* 先验环境：底图 PDF 不对，后面 C/D 两档的数字全部作废 */
  if (!pickKey || pickKey === "C" || pickKey === "D") await checkSamplePdf();

  /* ---------------- 视图段（先跑：这一段对内存压力最敏感） ---------------- */
  const viewResults: ViewResult[] = [];
  if (only !== "stage") {
    for (const sample of samples) viewResults.push(await measureView(sample));
  }

  /* ---------------- 附加检查：打开中的占位 ---------------- */
  if (!pickKey && only !== "stage") {
    log("");
    log("===== 附加检查：正在打开…占位 =====");
    await checkLoadingPlaceholder();
  }

  /* ---------------- 组件段 ---------------- */
  const stageResults: StageResult[] = [];
  if (only !== "view") {
    for (const sample of samples) stageResults.push(await measureStages(sample));
  }

  /* ---------------- 断言 ---------------- */
  log("");
  log("===== 断言 =====");

  for (const r of viewResults) {
    const sample = SAMPLES.find((s) => s.key === r.key)!;
    pass(r.pageCountOk, `${r.key}：视图里页数正确（应为 ${sample.expectPages}）`);
    pass(r.errors.length === 0, `${r.key}：视图链路无异常${r.errors.length ? "：" + r.errors[0] : ""}`);
    /*
     * 页列表按可视窗口懒建：条目数应远小于页数，但必须真的建出了可视区那一批
     * （0 个 = 列表没建 / 窗口算错；接近全量 = 窗口化失效）。
     */
    pass(
      r.thumbs > 0 && r.thumbs < sample.expectPages + 1,
      `${r.key}：侧栏只建可视窗口条目 ${r.thumbs} 个（全量 ${sample.expectPages + 1}）`
    );
    pass(
      r.openBest > 0 && r.openBest <= sample.limit.openMs,
      `${r.key}：打开全程（最快 ${r.openBest.toFixed(0)}ms / 中位 ${r.openTotal.toFixed(
        0
      )}ms）≤ ${sample.limit.openMs}ms`
    );
    pass(
      r.firstReadyBest > 0 && r.firstReadyBest <= sample.limit.firstReadyMs,
      `${r.key}：首屏就绪（最快 ${r.firstReadyBest.toFixed(0)}ms / 中位 ${r.firstReady.toFixed(
        0
      )}ms）≤ ${sample.limit.firstReadyMs}ms`
    );
    pass(r.lastPageOk, `${r.key}：滚到第 ${sample.expectPages} 页能正常挂载（没有空白页）`);
  }

  for (const r of stageResults) {
    const sample = SAMPLES.find((s) => s.key === r.key)!;
    const m = r.stages;
    pass(r.pages === sample.expectPages, `${r.key}：组件段页数正确（${r.pages}）`);
    pass(r.errors.length === 0, `${r.key}：组件段无异常${r.errors.length ? "：" + r.errors[0] : ""}`);
    pass(
      m.normalize >= 0 && m.normalize <= sample.limit.normalizeMs,
      `${r.key}：normalizeBook ${m.normalize.toFixed(1)}ms ≤ ${sample.limit.normalizeMs}ms`
    );
    pass(
      m.firstReady > 0 && m.firstReady <= sample.limit.firstReadyMs,
      `${r.key}：组件段首屏 ${m.firstReady.toFixed(0)}ms ≤ ${sample.limit.firstReadyMs}ms`
    );
    if ((performance as any).memory) {
      /*
       * 堆增量有时是**负数**：测量点附近的 GC 把上一轮的对象回收了。
       * 负数说明这次测量没意义（不是"省了内存"），跳过而不是判失败。
       */
      if (r.heapDelta < 0) {
        log(`SKIP ${r.key}：堆增量 ${(r.heapDelta / 1048576).toFixed(0)}MB 为负（GC 干扰），本次不判`);
      } else {
        pass(
          r.heapDelta <= HEAP_DELTA_LIMIT,
          `${r.key}：打开后堆增量 ${(r.heapDelta / 1048576).toFixed(0)}MB ≤ ${
            HEAP_DELTA_LIMIT / 1048576
          }MB`
        );
      }
    }
  }

  log(failures === 0 ? "ALL PASS" : failures + " FAILED");
  document.title = "DONE";
}

main().catch((e) => {
  log("FATAL " + (e?.stack || e));
  document.title = "FATAL";
});
