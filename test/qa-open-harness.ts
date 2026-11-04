/**
 * QA 独立验证：「打开 300+ 页很慢」优化的**行为侧**验证。
 *
 * 和工程师的 perf-open-harness 互不重叠：
 *   · 那边测耗时上界；这边测**行为**——占位的真实生命周期、失败路径、
 *     连点切书、同进程二次打开的资源残留、最后一页是否真的画出来了。
 *   · 全部用真时钟 + 真 DOM + 真布局，不用假定时器/假 DOM。
 *   · 不从源码里 import 私有实现来"验证自己"，测的都是用户点开文件后的实际路径
 *     （new InkbookView → onOpen → onLoadFile）。
 */
import { InkbookView } from "../src/view";
import { DEFAULT_SETTINGS } from "../src/types";

const lines: string[] = [];
const out = document.getElementById("out")!;
const log = (s: string) => {
  lines.push(s);
  out.textContent = lines.join("\n");
};
let failures = 0;
let passes = 0;
const pass = (ok: boolean, label: string, extra = "") => {
  if (ok) passes++;
  else failures++;
  log((ok ? "PASS " : "FAIL ") + label + (extra ? "（" + extra + "）" : ""));
};
const info = (s: string) => log("INFO " + s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const mb = (n: number) => (n / 1048576).toFixed(1);

/* ------------------------------------------------------------------ */
/* 样本                                                                */
/* ------------------------------------------------------------------ */

interface SampleSpec {
  file: string;
  key: string;
  pages: number;
}
const A: SampleSpec = { file: "A-300p-ink.inkbook", key: "A", pages: 300 };
const D: SampleSpec = { file: "D-real-857p.inkbook", key: "D", pages: 857 };
/** 压力档：300 页 200 笔迹/页，70MB。最坏情况下占位要扛住约 1 秒 */
const E: SampleSpec = { file: "E-300p-dense.inkbook", key: "E", pages: 300 };

const sampleUrl = (f: string) => `/test/samples/${encodeURIComponent(f)}`;
/** 已取到的样本正文 / 字节数（预热，避免测"读盘"时把 fetch 抖动算进来） */
const sampleText = new Map<string, string>();
const sampleBytes = new Map<string, number>();

async function prefetch(f: string): Promise<void> {
  const r = await fetch(sampleUrl(f), { cache: "no-store" });
  if (!r.ok) throw new Error("样本读取失败 " + f + " → HTTP " + r.status);
  const t = await r.text();
  sampleText.set(f, t);
  sampleBytes.set(f, new TextEncoder().encode(t).length);
}

/* ------------------------------------------------------------------ */
/* 视图环境（可注入延迟 / 缺失 / 坏 JSON）                              */
/* ------------------------------------------------------------------ */

interface ReadRecord {
  path: string;
  start: number;
  end: number;
  /** 读盘开始时占位是否已经在 DOM 里 */
  loadingAtStart: boolean;
  /** 读盘返回时占位是否还在（= 接下来那段同步 JSON.parse 期间它在屏幕上） */
  loadingAtEnd: boolean;
  /** 读盘开始时占位的布局盒（宽高 > 0 才谈得上"看得见"） */
  loadingRect: { w: number; h: number };
  /** 读盘开始时纸上是否已经铺了页（不应该有） */
  pagesInDom: number;
}

class Env {
  readLog: ReadRecord[] = [];
  /** 合成的小书（键 = 路径） */
  files = new Map<string, string>();
  /** 这些路径 exists() 返回 false */
  missing = new Set<string>();
  /** 读盘人为延迟（毫秒，按路径） */
  delays = new Map<string, number>();
  /** 这些路径读出来是坏 JSON */
  broken = new Set<string>();
  /** 读盘时是否绕过预热缓存（模拟真实读盘一次） */
  fresh = new Set<string>();

  adapter: any;
  vault: any;
  app: any;
  leaf: any;
  plugin: any;
  fileOf: (p: string) => any;

  constructor() {
    const mkFile = (p: string) => ({
      path: p,
      basename: p.split("/").pop()!.replace(/\.[^.]+$/, ""),
      extension: p.split(".").pop()!,
      parent: { path: "/" },
    });
    this.fileOf = mkFile;

    this.adapter = {
      exists: async (p: string) =>
        !this.missing.has(p) && (this.files.has(p) || sampleText.has(p) || this.broken.has(p)),
      read: async (p: string) => this.read(p),
      write: async (p: string, d: string) => void this.files.set(p, d),
      writeBinary: async (p: string) => void this.files.set(p, ""),
      mkdir: async () => {},
      stat: async (p: string) => ({ mtime: Date.now(), size: this.sizeOf(p) }),
      rename: async (a: string, b: string) => {
        const v = this.files.get(a);
        if (v != null) {
          this.files.set(b, v);
          this.files.delete(a);
        }
      },
      remove: async (p: string) => void this.files.delete(p),
      list: async () => ({ files: [], folders: [] }),
    };

    this.vault = {
      adapter: this.adapter,
      createFolder: async (p: string) => ({ path: p, type: "folder" }),
      create: async (p: string, text: string) => {
        this.files.set(p, text);
        return mkFile(p);
      },
      getAbstractFileByPath: (p: string) => (this.files.has(p) ? mkFile(p) : null),
      getFiles: () => [],
    };

    this.app = {
      vault: this.vault,
      workspace: {
        getActiveFile: () => null,
        getActiveViewOfType: () => null,
        getLeaf: () => ({ openFile: async () => {} }),
        on: () => ({}),
        onLayoutReady: (cb: () => void) => setTimeout(cb, 0),
      },
    };
    this.leaf = { app: this.app, getViewState: () => ({ state: {} }), getEphemeralState: () => ({}) };
    this.plugin = { settings: { ...DEFAULT_SETTINGS }, saveSettings: async () => {}, refreshViews: () => {} };
  }

  sizeOf(p: string): number {
    if (sampleBytes.has(p)) return sampleBytes.get(p)!;
    const t = this.files.get(p);
    return t ? new TextEncoder().encode(t).length : 0;
  }

  private async read(p: string): Promise<string> {
    const start = performance.now();
    const el = document.querySelector(".mb-loading") as HTMLElement | null;
    const r = el ? el.getBoundingClientRect() : { width: 0, height: 0 };
    const rec: ReadRecord = {
      path: p,
      start,
      end: 0,
      loadingAtStart: !!el,
      loadingAtEnd: false,
      loadingRect: { w: r.width, h: r.height },
      pagesInDom: document.querySelectorAll(".mb-page-wrap").length,
    };
    this.readLog.push(rec);

    const d = this.delays.get(p) ?? 0;
    if (d) await sleep(d);

    let text: string;
    if (this.broken.has(p)) {
      text = '{"version":2,"pages":[';
    } else if (this.files.has(p)) {
      text = this.files.get(p)!;
    } else if (sampleText.has(p)) {
      if (this.fresh.has(p)) {
        // 真的走一次 HTTP（本地 ~几十毫秒），模拟真实读盘
        const resp = await fetch(sampleUrl(p), { cache: "no-store" });
        text = await resp.text();
      } else {
        text = sampleText.get(p)!;
      }
    } else {
      throw new Error("文件不存在");
    }

    rec.end = performance.now();
    rec.loadingAtEnd = !!document.querySelector(".mb-loading");
    return text;
  }
}

let host: HTMLElement;
function ensureHost(): HTMLElement {
  if (!host) {
    host = document.getElementById("view-host") as HTMLElement;
  }
  host.innerHTML = "";
  return host;
}

const origRegisterDomEvent = (InkbookView as any).prototype.registerDomEvent;

/** 起一个干净的视图（registerDomEvent 打空：stub 的监听器摘不掉，会污染后续测量） */
async function newView(env: Env): Promise<any> {
  (InkbookView as any).prototype.registerDomEvent = () => {};
  ensureHost();
  const view: any = new InkbookView(env.leaf, env.plugin);
  await view.onOpen();
  await sleep(20);
  return view;
}

function teardown(view: any): void {
  try {
    view.destroyEditor?.();
  } catch (_) {
    /* 忽略 */
  }
  (InkbookView as any).prototype.registerDomEvent = origRegisterDomEvent;
  ensureHost();
}

/** 页面是否"真的画出来了"：canvas 挂上、有设备像素尺寸、布局里有面积、且有非透明像素 */
function pagePainted(scope: ParentNode, index: number, needPixels: boolean): { ok: boolean; why: string } {
  const wrap = scope.querySelector(`.mb-page-wrap[data-page='${index}']`) as HTMLElement | null;
  if (!wrap || !wrap.isConnected) return { ok: false, why: "页容器没挂上" };
  const canvas = wrap.querySelector("canvas.mb-canvas") as HTMLCanvasElement | null;
  if (!canvas) return { ok: false, why: "没有 canvas" };
  if (!(canvas.width > 0 && canvas.height > 0)) return { ok: false, why: "canvas 设备像素为 0" };
  const r = canvas.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return { ok: false, why: "canvas 布局面积为 0" };
  if (!needPixels) return { ok: true, why: "" };
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, why: "拿不到 2d 上下文" };
  const w = canvas.width;
  const h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h).data;
  let ink = 0;
  for (let i = 3; i < data.length; i += 4 * 7) if (data[i] > 8) ink++;
  return ink > 0 ? { ok: true, why: `${ink} 个采样点有墨` } : { ok: false, why: "canvas 全透明（白页）" };
}

/* ------------------------------------------------------------------ */
/* 1. 占位的真实生命周期                                                */
/* ------------------------------------------------------------------ */

async function testPlaceholderLifecycle(): Promise<void> {
  log("");
  log("===== 1. 「正在打开…」占位的生命周期（真时钟 / 真 DOM）=====");
  const env = new Env();
  env.fresh.add(A.file); // 这一轮走真实读盘
  const view = await newView(env);

  /* 用 MutationObserver 记"占位第一次出现/最后一次消失"的真实时刻 */
  let tAppear = 0;
  let tGone = 0;
  const obs = new MutationObserver(() => {
    const el = document.querySelector(".mb-loading");
    if (el && !tAppear) tAppear = performance.now();
    if (!el && tAppear && !tGone) tGone = performance.now();
  });
  obs.observe(host, { childList: true, subtree: true, attributes: false, characterData: true });

  /* 屏幕上有几帧：用来判断占位有没有机会被浏览器画出来（无头里 rAF 会被压到 1Hz） */
  let frames = 0;
  let watching = true;
  const raf = () => {
    frames++;
    if (watching) requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);

  const file = env.fileOf(A.file);
  const t0 = performance.now();
  await view.onLoadFile(file);
  const tOpen = performance.now() - t0;
  await sleep(120);
  watching = false;
  obs.disconnect();

  const rec = env.readLog[env.readLog.length - 1];
  const realBytes = env.sizeOf(A.file);

  info(`样本 ${A.file}：真实 ${mb(realBytes)}MB / ${A.pages} 页`);
  info(`onLoadFile 全程 ${tOpen.toFixed(1)}ms；读盘 ${(rec.end - rec.start).toFixed(1)}ms`);
  info(`占位出现 ${(tAppear - t0).toFixed(1)}ms；占位消失 ${tGone ? (tGone - t0).toFixed(1) : "?"}ms`);
  info(`占位在屏时长 ${tGone ? (tGone - tAppear).toFixed(1) : "?"}ms；期间 rAF 帧数 ${frames}`);

  pass(tAppear > 0, "占位真的进过 DOM");
  pass(
    tAppear > 0 && tAppear - t0 < 60,
    "占位在 onLoadFile 进入后立刻出现（< 60ms）",
    `${(tAppear - t0).toFixed(1)}ms`
  );
  pass(
    rec.loadingAtStart,
    "占位在**开始读盘之前**就已经在 DOM 里（关键：否则用户看到的是白屏）"
  );
  pass(
    rec.loadingRect.w > 0 && rec.loadingRect.h > 0,
    "占位在屏时真的有布局面积（不是 display:none 的空壳）",
    `${rec.loadingRect.w.toFixed(0)}×${rec.loadingRect.h.toFixed(0)}`
  );
  pass(rec.pagesInDom === 0, "占位显示期间纸上还没有页（占位没盖在纸上）", `页数 ${rec.pagesInDom}`);
  pass(rec.loadingAtEnd, "读盘返回、JSON.parse 开始的那一刻占位仍在 DOM 里（覆盖了那段主线程冻结）");

  const el = document.querySelector(".mb-loading");
  pass(!el, "打开完成后占位消失（全文档范围内都没有 .mb-loading）");
  pass(
    (view.contentEl.textContent || "").indexOf("正在打开") < 0,
    "打开完成后不留「正在打开…」的残字"
  );
  const painted = pagePainted(view.contentEl, 0, true);
  pass(painted.ok, "打开完成后首屏真的画出来了（有墨）", painted.why);

  /* 占位文案：书名 + 真实体积 */
  const env2 = new Env();
  const view2 = await newView(env2);
  view2.showLoading("A-300p-ink", env2.sizeOf(A.file));
  const box = view2.contentEl.querySelector(".mb-loading") as HTMLElement | null;
  const txt = box?.textContent || "";
  pass(!!box, "占位节点能建出来");
  pass(txt.includes("A-300p-ink"), "占位写明正在打开哪一本", txt.replace(/\s+/g, " ").slice(0, 60));
  pass(txt.includes(mb(env2.sizeOf(A.file)) + "MB"), "占位显示的是真实体积", `${mb(env2.sizeOf(A.file))}MB`);
  pass(!/undefined|NaN/.test(txt), "占位文案里没有 undefined / NaN");
  teardown(view2);
  teardown(view);
}

/* ------------------------------------------------------------------ */
/* 1b. 最坏情况：70MB 的超密本子，占位要扛住约 1 秒的主线程冻结          */
/* ------------------------------------------------------------------ */

async function testWorstCasePlaceholder(): Promise<void> {
  log("");
  log("===== 1b. 最坏情况占位（E：300 页 200 笔迹/页，70MB）=====");
  const env = new Env();
  const view = await newView(env);

  let tAppear = 0;
  let tGone = 0;
  const obs = new MutationObserver(() => {
    const el = document.querySelector(".mb-loading");
    if (el && !tAppear) tAppear = performance.now();
    if (!el && tAppear && !tGone) tGone = performance.now();
  });
  obs.observe(host, { childList: true, subtree: true, characterData: true });

  let frames = 0;
  let watching = true;
  const raf = () => {
    frames++;
    if (watching) requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);

  const t0 = performance.now();
  await view.onLoadFile(env.fileOf(E.file));
  const tOpen = performance.now() - t0;
  await sleep(150);
  watching = false;
  obs.disconnect();

  const txt = (document.querySelector(".mb-loading")?.textContent || "").slice(0, 80);
  info(`${E.file}：${mb(env.sizeOf(E.file))}MB / ${E.pages} 页；onLoadFile ${tOpen.toFixed(0)}ms；占位在屏 ${tGone ? (tGone - tAppear).toFixed(0) : "?"}ms；rAF ${frames} 帧`);
  pass(tAppear > 0 && tAppear - t0 < 60, "E：占位立刻出现（< 60ms）", `${(tAppear - t0).toFixed(1)}ms`);
  pass(!!tGone && tGone - tAppear > 200, "E：占位在屏时间足够长（说明真的覆盖住了那段冻结）", `${tGone ? (tGone - tAppear).toFixed(0) : "?"}ms`);
  pass(frames >= 1, "E：冻结期间浏览器出过帧（占位不是画不出来的空壳）", `${frames} 帧`);
  pass(document.querySelectorAll(".mb-loading").length === 0, "E：打开完成后占位消失");
  pass(!!view.store && view.store.pageCount === E.pages, "E：真的打开了 300 页", `页数 ${view.store?.pageCount}`);
  pass(!txt, "E：打开后界面里没有残留的占位文案");
  teardown(view);
}

/* ------------------------------------------------------------------ */
/* 2. 失败路径：占位不能残留                                            */
/* ------------------------------------------------------------------ */

async function testFailurePaths(): Promise<void> {
  log("");
  log("===== 2. 失败路径：占位不残留 + 错误提示正确 =====");

  /* 2.1 文件不存在 */
  {
    const env = new Env();
    env.missing.add("nope.inkbook");
    const view = await newView(env);
    await view.onLoadFile(env.fileOf("nope.inkbook"));
    await sleep(60);
    const loading = document.querySelectorAll(".mb-loading").length;
    const err = view.contentEl.querySelector(".mb-error") as HTMLElement | null;
    pass(loading === 0, "文件不存在：占位已清掉", `剩 ${loading}`);
    pass(!!err, "文件不存在：显示错误提示");
    pass(!!err && /文件不存在/.test(err.textContent || ""), "文件不存在：提示写明原因", err?.textContent?.slice(0, 40) || "");
    teardown(view);
  }

  /* 2.2 坏 JSON */
  {
    const env = new Env();
    env.files.set("bad.inkbook", '{"version":2,"pages":[');
    const view = await newView(env);
    await view.onLoadFile(env.fileOf("bad.inkbook"));
    await sleep(60);
    pass(document.querySelectorAll(".mb-loading").length === 0, "坏 JSON：占位已清掉");
    const err = view.contentEl.querySelector(".mb-error") as HTMLElement | null;
    pass(!!err && /JSON|读不完整/.test(err.textContent || ""), "坏 JSON：提示说明文件读不完整", err?.textContent?.slice(0, 50) || "");
    teardown(view);
  }

  /* 2.3 版本过新 */
  {
    const env = new Env();
    const raw = JSON.parse(sampleText.get(A.file)!);
    raw.version = 99;
    env.files.set("new.inkbook", JSON.stringify(raw));
    const view = await newView(env);
    await view.onLoadFile(env.fileOf("new.inkbook"));
    await sleep(60);
    pass(document.querySelectorAll(".mb-loading").length === 0, "版本过新：占位已清掉");
    const err = view.contentEl.querySelector(".mb-error") as HTMLElement | null;
    const et = err?.textContent || "";
    pass(!!err && /更新版本|升级/.test(et), "版本过新：提示让用户升级墨本", et.slice(0, 50));
    pass(view.readOnly === true, "版本过新：视图进入只读（不会被写回覆盖）");
    teardown(view);
  }

  /* 2.4 完整性对不上（截断） */
  {
    const env = new Env();
    const raw = JSON.parse(sampleText.get(A.file)!);
    raw.integrity = { pageCount: 300, strokeCount: 12345 };
    env.files.set("trunc.inkbook", JSON.stringify(raw));
    const view = await newView(env);
    await view.onLoadFile(env.fileOf("trunc.inkbook"));
    await sleep(60);
    pass(document.querySelectorAll(".mb-loading").length === 0, "完整性对不上：占位已清掉");
    const err = view.contentEl.querySelector(".mb-error") as HTMLElement | null;
    pass(!!err && /不完整/.test(err.textContent || ""), "完整性对不上：提示文件可能不完整", err?.textContent?.slice(0, 50) || "");
    teardown(view);
  }

  /* 2.5 失败之后还能正常打开下一本 */
  {
    const env = new Env();
    env.missing.add("gone.inkbook");
    const view = await newView(env);
    await view.onLoadFile(env.fileOf("gone.inkbook"));
    await sleep(40);
    await view.onLoadFile(env.fileOf(A.file));
    await sleep(80);
    pass(document.querySelectorAll(".mb-loading").length === 0, "失败后再打开正常书：占位已清掉");
    pass(!!view.store && view.store.pageCount === A.pages, "失败后再打开正常书：真的打开了", `页数 ${view.store?.pageCount}`);
    pass(!view.contentEl.querySelector(".mb-error"), "失败后再打开正常书：错误提示被清掉");
    teardown(view);
  }
}

/* ------------------------------------------------------------------ */
/* 3. 连续快速切两本（用户连点）                                        */
/* ------------------------------------------------------------------ */

async function testRapidSwitch(): Promise<void> {
  log("");
  log("===== 3. 连续快速切两本（模拟用户连点）=====");
  const env = new Env();
  // 第一本读得慢（200ms），第二本读得快：制造"第一本还在读，第二本已经开了"的竞态
  env.delays.set(A.file, 200);
  const view = await newView(env);

  let maxLoading = 0;
  let polling = true;
  const poll = async () => {
    while (polling) {
      const n = document.querySelectorAll(".mb-loading").length;
      if (n > maxLoading) maxLoading = n;
      await sleep(5);
    }
  };
  const poller = poll();

  const p1 = view.onLoadFile(env.fileOf(A.file));
  await sleep(40); // 此时 A 还在读，占位是 A 的
  const nameWhileA = (document.querySelector(".mb-loading")?.textContent || "").includes("A-300p-ink");
  const p2 = view.onLoadFile(env.fileOf(D.file));
  await Promise.all([p1, p2]);
  await sleep(150);
  polling = false;
  await poller;

  pass(nameWhileA, "连点：第一本的占位先出现了（打开是真的异步进去的）");
  pass(maxLoading <= 1, "连点：任何时刻 DOM 里最多一个占位（不会叠两层）", `峰值 ${maxLoading}`);
  pass(document.querySelectorAll(".mb-loading").length === 0, "连点：全都结束后占位清空");
  pass(!!view.store && view.store.pageCount === D.pages, "连点：最终显示的是后点的那本（857 页）", `页数 ${view.store?.pageCount}`);
  const leftover = (view.contentEl.textContent || "").includes("A-300p-ink");
  pass(!leftover, "连点：前一本的书名没残留在界面上");
  /* 读盘记录：两本都读了，但只有后者被采用；不能出现"两个占位同时在 DOM" */
  info(`读盘次数 ${env.readLog.length}；最后一本读到 ${mb(env.sizeOf(D.file))}MB`);
  teardown(view);
}

/* ------------------------------------------------------------------ */
/* 4. 同一进程二次/多次打开：资源不累积                                 */
/* ------------------------------------------------------------------ */

async function testSecondOpenLeak(): Promise<void> {
  log("");
  log("===== 4. 同一进程连续打开 4 次（关掉再打开）=====");
  const env = new Env();
  const view = await newView(env);

  const nodes: number[] = [];
  const canvases: number[] = [];
  const wraps: number[] = [];
  const heaps: number[] = [];
  const durations: number[] = [];

  for (let i = 0; i < 4; i++) {
    const t = performance.now();
    await view.onLoadFile(env.fileOf(A.file));
    durations.push(performance.now() - t);
    await sleep(260); // 等编辑器把首屏/缩略图都挂完，再数
    nodes.push(document.getElementsByTagName("*").length);
    canvases.push(document.querySelectorAll("canvas").length);
    wraps.push(document.querySelectorAll(".mb-page-wrap").length);
    heaps.push((performance as any).memory?.usedJSHeapSize ?? 0);
  }

  info(`每次打开耗时：${durations.map((d) => d.toFixed(0) + "ms").join(" / ")}`);
  info(`DOM 节点数：${nodes.join(" / ")}`);
  info(`canvas 数：${canvases.join(" / ")}`);
  info(`.mb-page-wrap 数：${wraps.join(" / ")}`);
  if (heaps[0]) info(`堆：${heaps.map((h) => (h / 1048576).toFixed(0) + "MB").join(" / ")}`);
  else info("performance.memory 不可用（堆断言跳过）");

  pass(nodes[3] - nodes[0] < 400, "4 次打开后 DOM 节点没有线性增长", `${nodes[0]} → ${nodes[3]}`);
  pass(canvases[3] <= canvases[0] + 2, "4 次打开后 canvas 数量没有累积", `${canvases[0]} → ${canvases[3]}`);
  pass(wraps[3] <= wraps[0] + 2, "4 次打开后页容器没有累积（上一本被拆掉了）", `${wraps[0]} → ${wraps[3]}`);
  pass(
    durations[3] < durations[1] * 2.5 + 200,
    "第 4 次打开不比第 2 次明显更慢（没有越开越慢）",
    `#2 ${durations[1].toFixed(0)}ms → #4 ${durations[3].toFixed(0)}ms`
  );
  if (heaps[0]) {
    const grow = heaps[3] - heaps[0];
    pass(grow < 300 * 1048576, "4 次打开后堆增长 < 300MB（没有明显泄漏）", `${(grow / 1048576).toFixed(0)}MB`);
  }
  teardown(view);
}

/* ------------------------------------------------------------------ */
/* 5. 滚到最后一页：300 页 / 857 页 都要真的画出来                      */
/* ------------------------------------------------------------------ */

async function testLastPage(): Promise<void> {
  log("");
  log("===== 5. 滚到最后一页（300 页 / 857 页）=====");

  /* 5.1 A：最后一页有 30 条笔迹 → 可以直接查像素 */
  {
    const env = new Env();
    const view = await newView(env);
    await view.onLoadFile(env.fileOf(A.file));
    await sleep(120);
    view.editor?.goToPage(A.pages - 1, false);
    await sleep(400);
    const r = pagePainted(view.contentEl, A.pages - 1, true);
    pass(r.ok, `A：第 ${A.pages} 页滚过去能挂载且**有墨**（不是空白页）`, r.why);
    const num = view.contentEl.querySelector(`.mb-page-wrap[data-page='${A.pages - 1}'] .mb-page-num`) as HTMLElement | null;
    pass(num?.textContent === String(A.pages), "A：最后一页的页码正确", num?.textContent || "无");
    teardown(view);
  }

  /* 5.2 D：857 页真实本子。最后一页本身没有手写（只有 PDF 底图），
         所以"不是空白页"的判据是：页挂上 + 底图类在 + 页码对；
         另外回头滚一页有笔迹的（第 2 页）验证画布真的有墨 */
  {
    const env = new Env();
    const view = await newView(env);
    await view.onLoadFile(env.fileOf(D.file));
    await sleep(150);
    view.editor?.goToPage(D.pages - 1, false);
    await sleep(500);
    const lastIdx = D.pages - 1;
    const wrap = view.contentEl.querySelector(`.mb-page-wrap[data-page='${lastIdx}']`) as HTMLElement | null;
    const canvas = wrap?.querySelector("canvas.mb-canvas") as HTMLCanvasElement | null;
    pass(!!wrap && wrap.isConnected, "D：第 857 页容器挂上了");
    pass(!!canvas && canvas.width > 0 && canvas.height > 0, "D：第 857 页的笔迹画布有设备像素尺寸", canvas ? `${canvas.width}×${canvas.height}` : "无");
    pass(!!wrap && wrap.classList.contains("has-bg"), "D：第 857 页带着 PDF 底图（不是一张纯白纸）");
    const num = wrap?.querySelector(".mb-page-num") as HTMLElement | null;
    pass(num?.textContent === String(D.pages), "D：最后一页页码正确", num?.textContent || "无");

    view.editor?.goToPage(1, false);
    await sleep(400);
    const ink = pagePainted(view.contentEl, 1, true);
    pass(ink.ok, "D：第 2 页（本子里唯一有手写的页）画出了墨", ink.why);
    teardown(view);
  }
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  log("QA 独立验证：打开 300+ 页优化（行为侧）");
  log(`performance.memory：${(performance as any).memory ? "可用" : "不可用"}`);
  await prefetch(A.file);
  await prefetch(D.file);
  log(`样本：${A.file} ${mb(sampleBytes.get(A.file)!)}MB / ${D.file} ${mb(sampleBytes.get(D.file)!)}MB`);

  await testPlaceholderLifecycle();
  await prefetch(E.file); // 70MB，放在 A 之后再取，免得把首个样本的耗时算进冷启动
  log(`样本：${E.file} ${mb(sampleBytes.get(E.file)!)}MB`);
  await testWorstCasePlaceholder();
  await testFailurePaths();
  await testRapidSwitch();
  await testSecondOpenLeak();
  await testLastPage();

  log("");
  log(failures === 0 ? `ALL PASS（${passes} 项）` : `${failures} FAILED / ${passes} PASSED`);
  document.title = "DONE";
}

main().catch((e) => {
  log("FATAL " + (e?.stack || e));
  document.title = "FATAL";
});
