/**
 * 笔记内嵌入（INK-105）：把 `.inkbook` 的一页渲染成位图，贴进 Markdown 笔记。
 *
 * 定位是**引用 / 预览**，不是内嵌编辑器：手写本的编辑状态（选区、笔、撤销栈、
 * 缩放、触摸仲裁）全都挂在 BookEditor 上，在一篇 md 里塞十个真编辑器等于
 * 让十个状态机抢同一批全局监听（真机上第一个表现出来的症状是「写字时
 * 别的块跟着抖」）。所以这里只画一张静态位图，要写就点进去写。
 *
 * 三条产品取舍（已定）：
 *   1. 渲染成位图 canvas，不内嵌真编辑器；
 *   2. 默认第 1 页，要别的页写 `#3`；
 *   3. 只认 `|宽`（像素），不写就占满栏宽。
 *
 * 为什么绘制逻辑要复用 paper.ts / ink.ts / textwrap.ts 而不是另写一套：
 * 嵌入图和主编辑器、导出图必须是**同一份**笔迹轮廓、同一份纸面线、同一份
 * 折行规则，否则「笔记里看着两行、点进去变成三行」这类不一致会永远漂移。
 */

import { drawStroke } from "./ink";
import { drawPaper } from "./paper";
import { textFontStack } from "./editor";
import { ensureHandFont } from "./handfont";
import { openPdf, renderPdfPage, type PdfDoc } from "./pdf";
import { readBook } from "./storage";
import { layoutUserText } from "./textwrap";
import { A4_HEIGHT, A4_WIDTH, type InkBook, type Page } from "./types";

/* ------------------------------- 对外类型 ------------------------------- */

/** 一条嵌入链接解析出来的东西 */
export interface EmbedTarget {
  /** 库里用来查文件的链接文本（已去掉 `#页码` 与 `|宽度`） */
  linktext: string;
  /** 页码，1 起；无效/缺省 = 1 */
  page: number;
  /** 显示宽度（CSS 像素）；无效/缺省 = null（占满栏宽） */
  width: number | null;
}

/** 嵌入只关心文件的这几个字段（TFile 是它的超集，测试里给个纯对象也行） */
export interface EmbedFile {
  path: string;
  basename: string;
  stat?: { mtime?: number };
}

/**
 * 绘制一页要用到的宿主能力。
 *
 * 只声明真正用到的三个成员：这是为了让 embed.ts 不 import main.ts（否则
 * main → embed → main 成环），也方便测试里塞一个纯对象当宿主。
 */
export interface EmbedApp {
  vault?: {
    adapter?: any;
    getAbstractFileByPath?(path: string): any;
  };
  metadataCache?: {
    getFirstLinkpathDest?(linktext: string, sourcePath: string): any;
  };
}

/** 挂 postprocessor / 点开本子，都需要插件本体 */
export interface EmbedHost {
  app: EmbedApp;
  registerMarkdownPostProcessor(cb: (el: HTMLElement, ctx: any) => void): unknown;
  /**
   * 打开某本手写本的第 page 页（1 起）。
   *
   * `newTab` 来自点击时的修饰键（Ctrl/Cmd / 中键）：默认沿用 Obsidian 原生
   * 内部链接的语义——替换当前 leaf；带修饰键才另开一个标签页。
   */
  openBookAt(
    path: string,
    page: number,
    opts?: { newTab?: boolean }
  ): Promise<void> | void;
}

/** 一页嵌入的渲染结果 */
export interface EmbedRenderResult {
  canvas: HTMLCanvasElement;
  /** 实际画出来的页码（1 起）；越界时是最后一页 */
  actualPage: number;
  /** 链接里请求的页码（1 起，可能越界） */
  requestedPage: number;
  /** 请求的页码越界、被夹到最后一页 */
  clamped: boolean;
  /** 这本书一共几页（角标要写「第 3 页 / 共 3 页」） */
  pageCount: number;
}

/* ------------------------------- 解析 ------------------------------- */

/** 去掉 `![[` / `]]` 之类的链接外壳（正常情况 Obsidian 不会带，防御性处理） */
function stripLinkSyntax(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/^!?\[\[/, "")
    .replace(/\]\]$/, "")
    .trim();
}

/**
 * 解析 `.internal-embed` 的 `src` 属性。
 *
 * Obsidian 的 `src` 里同时带着子路径和尺寸，形如 `本子.inkbook#3|300`：
 *   · `|` 之后是尺寸（只支持纯宽度；`300x200` 这种也取宽度，不报错）；
 *   · `#` 之后是子路径，对本子就是页码。
 * 页码从 1 开始；写 `#abc`、写 `0`、写负数都当作「没写」→ 第 1 页。
 * 宽度同理，非数字当作「没写」→ null（由调用方按栏宽算）。
 */
export function parseEmbedSrc(src: string): EmbedTarget {
  const raw = stripLinkSyntax(src);
  if (!raw) return { linktext: "", page: 1, width: null };

  let rest = raw;
  let width: number | null = null;
  let page = 1;

  // 尺寸在最后一段：`名字#页|宽`
  const pipe = rest.lastIndexOf("|");
  if (pipe >= 0) {
    const sizePart = rest.slice(pipe + 1).trim();
    rest = rest.slice(0, pipe).trim();
    const m = sizePart.match(/^\s*(\d+(?:\.\d+)?)/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) width = n;
    }
  }

  /*
   * 子路径（页码）在 `#` 之后。
   *
   * **不能见 `#` 就切**：文件名本身可能带 `#`（`C#笔记.inkbook`）。
   * 以前按第一个 `#` 切，`C#笔记.inkbook` 被切成「C」+「笔记.inkbook」，
   * 查不到文件，整块嵌入退化成占位符（INK-170）。
   *
   * 判据是「`#` 前面那段是不是一个**完整的文件名**」：
   *   · `本子.inkbook#abc` → 前面是 `.inkbook` 结尾的文件名 → `#` 是子路径；
   *   · `C#笔记.inkbook`   → 前面只是「C」，不是文件名 → `#` 属于文件名。
   * 取最后一个 `#`，这样 `C#笔记.inkbook#3` 也能正确切成「文件名 + 第 3 页」。
   */
  const hash = rest.lastIndexOf("#");
  if (hash > 0) {
    const head = rest.slice(0, hash).trim();
    if (/\.inkbook$/i.test(head)) {
      const sub = rest.slice(hash + 1).trim();
      rest = head;
      if (/^\d+$/.test(sub)) {
        const n = Number(sub);
        if (Number.isFinite(n) && n >= 1) page = Math.floor(n);
      }
    }
  }

  return { linktext: rest || raw, page, width };
}

/**
 * 从真实 DOM 节点读出目标。
 *
 * `#3` 有可能落在 `src` 也可能落在 `data-src`（Obsidian 不同版本/不同
 * 渲染路径不一样），所以两边都解析一遍再合并：页码/宽度谁写得更具体用谁。
 */
export function readEmbedTarget(node: HTMLElement): EmbedTarget {
  const fromSrc = parseEmbedSrc(node.getAttribute("src") || "");
  const fromData = parseEmbedSrc(node.getAttribute("data-src") || "");
  const page = fromSrc.page !== 1 ? fromSrc.page : fromData.page;
  const width = fromSrc.width ?? fromData.width;
  const linktext = fromSrc.linktext || fromData.linktext;
  return { linktext, page, width };
}

/** 这个 `.internal-embed` 是不是指向手写本（忽略大小写，忽略 `#页码` / `|宽`） */
export function isInkbookEmbed(node: HTMLElement): boolean {
  for (const attr of ["src", "data-src"]) {
    const raw = node.getAttribute(attr);
    if (!raw) continue;
    const base = stripLinkSyntax(raw).split("|")[0].split("#")[0].trim().toLowerCase();
    if (base.endsWith(".inkbook")) return true;
  }
  return false;
}

/**
 * 链接文本 → 库里的文件。
 *
 * 优先 `metadataCache.getFirstLinkpathDest`：它认 Obsidian 那套「最短唯一路径」，
 * `![[本子.inkbook]]` 写在哪个文件夹里都能解析到。拿不到再按库内路径硬找
 * （用户手写全路径时也成立）。**找不到返回 null，不抛错**——一篇笔记里
 * 有一处坏链接不该把整篇渲染搞崩。
 */
export function resolveEmbedFile(
  app: EmbedApp | null,
  linktext: string,
  sourcePath: string
): EmbedFile | null {
  if (!app || !linktext) return null;
  const name = linktext.trim();

  const cache = app.metadataCache;
  if (cache && typeof cache.getFirstLinkpathDest === "function") {
    try {
      const hit = cache.getFirstLinkpathDest(name, sourcePath || "");
      const ext = String((hit as any)?.extension ?? "").toLowerCase();
      if (hit && typeof (hit as any).path === "string" && ext === "inkbook") {
        return hit as EmbedFile;
      }
    } catch (_) {
      /* 缓存没准备好就退回按路径找 */
    }
  }

  const vault = app.vault;
  if (vault && typeof vault.getAbstractFileByPath === "function") {
    try {
      const byPath: any = vault.getAbstractFileByPath(name);
      const ext = String(byPath?.extension ?? "").toLowerCase();
      if (byPath && typeof byPath.path === "string" && ext === "inkbook") {
        return byPath as EmbedFile;
      }
    } catch (_) {
      /* 路径非法就当没找到 */
    }
  }
  return null;
}

/* ------------------------------- 页码 ------------------------------- */

/** 页码（1 起）→ 数组下标；越界夹到最后一页，非法值当第 1 页 */
export function clampPageIndex(pageCount: number, page1: number): number {
  const count = Math.floor(Number(pageCount));
  if (!Number.isFinite(count) || count <= 0) return 0;
  const p = Math.floor(Number(page1));
  if (!Number.isFinite(p) || p < 1) return 0;
  return Math.min(p, count) - 1;
}

/** 嵌入画布的设备像素比：跟主视图一致（上限 2），低 dpr 屏也别缩到 1 以下 */
export function embedDpr(): number {
  const raw = Number((globalThis as any).devicePixelRatio || 1);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(Math.max(raw, 1), 2);
}

/** 出图宽度的下限：只防 0 宽这种病态值 */
const MIN_EMBED_WIDTH = 24;

/**
 * 出图宽度的硬上限（CSS 像素）。
 *
 * `|3000` 这种手写宽度必须有天花板：`|100000` 名义上是 53GB，画布根本
 * 分配不出来（只会白屏）。2000 已经比 A4 纸在 4K 屏上的显示宽度还宽。
 *
 * **注意这只是一道保险，真正的约束是下面的设备像素上限**：dpr=2 时
 * 2000 CSS px 会渲染成 4000×5658 = 86MB 一张，那是内存事故。
 */
export const MAX_EMBED_WIDTH = 2000;

/**
 * 单张位图的**设备像素**上限：4M ≈ 16MB @4Bpp。
 *
 * 按 64MB 预算算能放四张满栏嵌入，既能命中缓存又不至于一保存重画就重新分配
 * 几十 MB。这是给平板/手机设的：dpr=2 的 iPad 上，`|2000` 的**位图**宽
 * 折成 841 CSS px（841×2 = 1682 像素宽），肉眼和 2000 看不出差别，
 * 内存差一个量级。
 *
 * 注意这里约束的只是**位图**：显示宽度另走 `embedDisplayWidth`，不折 dpr。
 */
export const MAX_EMBED_DEVICE_PIXELS = 4_000_000;

/** A4 的纵横比：算"给定像素预算能画多宽"时要乘上它 */
const PAGE_ASPECT = A4_HEIGHT / A4_WIDTH;

/**
 * 给定 dpr 下允许的最大 CSS 宽度。
 *
 * 目标：`round(cssW * dpr) * round(cssW * dpr * ASPECT) <= MAX_EMBED_DEVICE_PIXELS`。
 * 反解得 cssW <= sqrt(P / ASPECT) / dpr（取整后略有偏差，几个像素级，可接受）。
 * dpr=1 → 1682（再被 MAX_EMBED_WIDTH 夹到 2000 以内的原值）；dpr=2 → 841；dpr=3 → 561。
 */
export function maxCssWidthForDpr(dpr: number): number {
  const safe = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const maxBacking = Math.sqrt(MAX_EMBED_DEVICE_PIXELS / PAGE_ASPECT);
  return Math.max(MIN_EMBED_WIDTH, Math.floor(maxBacking / Math.max(1, safe)));
}

/**
 * 统一的宽度夹取：非法/缺省 → fallback，然后夹进
 * `[24, min(MAX_EMBED_WIDTH, maxCssWidthForDpr(dpr))]`。
 *
 * dpr 显式传参（默认取真实设备的），不在这里读全局：测试要能指定 dpr
 * 验证 dpr=2/3 的行为，而真机上调用方本来就知道自己用的 dpr。
 *
 * 只夹上限，不用栏宽去限制：`|300` 塞进 90px 窄栏时仍按 300 出图、
 * 交给 CSS 缩放——那样才是清晰的，按栏宽出图放大后会糊。
 */
export function clampEmbedWidth(
  px: number,
  fallback: number,
  dpr: number = embedDpr()
): number {
  const n = Number.isFinite(px) && px > 0 ? px : fallback;
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  /*
   * dpr <= 1：沿用老的 2000 上限。
   * 这一步是刻意的——2000 CSS px 在 dpr=1 下是 5.66M 设备像素（22.6MB），
   * 仍在 64MB 缓存预算内，不会造成"画完即弃"；而桌面一直是这个行为，
   * 改小只会让人发现"嵌入变糊了"，没有任何收益。
   * dpr > 1：按设备像素预算往回折（dpr=2 → 840 CSS px ≈ 16MB 一张），
   * 这才是平板/手机上的内存事故来源。
   */
  const ceiling =
    safeDpr <= 1 ? MAX_EMBED_WIDTH : Math.min(MAX_EMBED_WIDTH, maxCssWidthForDpr(safeDpr));
  return Math.min(Math.max(Math.round(n), MIN_EMBED_WIDTH), ceiling);
}

/**
 * 显示宽度（CSS 像素）：**只受 MAX_EMBED_WIDTH 限制，不按 dpr 折**。
 *
 * 为什么要和 `clampEmbedWidth` 分开（这是 INK-105 的一处显示回退）：
 * `clampEmbedWidth` 夹的是**设备像素预算**（dpr=2 → 840 CSS px），那是
 * 内存约束；而 `canvas.style.width` 是**排版**约束。早先两处共用同一个值，
 * 于是 iPad / Retina / 手机（dpr≥2）上，栏宽 1200 的笔记里嵌入图右侧会
 * 空出 359px —— 用户看到的是"图没占满"，完全猜不到这是为了省内存。
 *
 * 现在两条线各走各的：位图按预算夹（840 CSS px × dpr2 = 1680 设备像素，
 * ≈16MB），显示宽按 `|宽` / 栏宽给到 1198、1200 这样的真实排版宽度。
 * 代价是位图被 CSS 放大——常见 1200px 栏里约 1.4 倍（1680 设备像素铺满
 * 1198 CSS px），肉眼很难分辨；换回来的是排版正确。
 *
 * 注意：**这个值不进缓存键**。位图内容只由 backing 尺寸（即 840）决定，
 * `|2000` 和 `|1200` 在 dpr=2 下共用同一条位图缓存，只是显示宽不同。
 *
 * @param px 请求宽度（来自 `|宽` 或量出来的栏宽）；非法/缺省用 fallback
 * @param fallback 缺省宽度（通常是纸张宽）
 */
export function embedDisplayWidth(px: number, fallback: number): number {
  const n = Number.isFinite(px) && px > 0 ? px : fallback;
  return Math.min(Math.max(Math.round(n), MIN_EMBED_WIDTH), MAX_EMBED_WIDTH);
}

/* ------------------------------- 资源 / PDF ------------------------------- */

/** 模块级宿主引用：纯函数 renderEmbedPage 要在脱离 editor 的情况下取到 PDF */
let embedApp: EmbedApp | null = null;

/** 登记宿主 app（registerEmbed 里自动调用；测试也可以直接调） */
export function setEmbedContext(app: EmbedApp | null): void {
  embedApp = app;
}

/** 库内相对路径 → 可加载的 URL（与 editor 里的做法一致） */
function resolveAssetUrl(src: string): string {
  const adapter = embedApp?.vault?.adapter;
  if (adapter && typeof adapter.getResourcePath === "function") {
    try {
      return adapter.getResourcePath(src);
    } catch (_) {
      /* 拿不到就按相对路径试试 */
    }
  }
  return src;
}

/** PDF 文档缓存：同一份 PDF 的多页嵌入不该各解析一次 */
const pdfDocs = new Map<string, Promise<PdfDoc>>();
const MAX_PDF_DOCS = 4;

function getPdfDoc(path: string): Promise<PdfDoc> {
  const hit = pdfDocs.get(path);
  if (hit) return hit;
  const p = openPdf(resolveAssetUrl(path)).catch((e) => {
    // 失败不要缓存：PDF 可能是同步到一半，下次嵌入还能再试
    pdfDocs.delete(path);
    throw e;
  });
  pdfDocs.set(path, p);
  while (pdfDocs.size > MAX_PDF_DOCS) {
    const oldest = pdfDocs.keys().next().value;
    if (oldest === undefined) break;
    const evicted = pdfDocs.get(oldest);
    pdfDocs.delete(oldest);
    /*
     * 淘汰必须 destroy：PDFDocumentProxy 背后挂着 worker 和解析出来的
     * 字体/页面结构，只 delete Map 条目这些资源会活到进程结束。
     * destroy 是异步的，失败也只影响内存回收，绝不能反过来影响渲染主流程。
     */
    if (evicted) {
      void evicted.then((doc) => doc?.destroy?.()).catch(() => {
        /* 已经失败 / 已销毁的文档没有句柄要释放 */
      });
    }
  }
  return p;
}

function releasePdfDocs(): void {
  for (const p of pdfDocs.values()) {
    void p
      .then((doc) => doc?.destroy?.())
      .catch(() => {
        /* 已经失败的文档没有句柄要释放 */
      });
  }
  pdfDocs.clear();
}

/**
 * 给异步步骤加一个上限。
 *
 * PDF 底图是网络/磁盘 IO：文件被移走、同步中断、加密 PDF 都可能让
 * pdf.js 一直不给结果。嵌入块不能因此永远停在占位上——到点就画灰块继续，
 * 笔迹和批注照常显示。
 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(label + " 超时")), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * 嵌入 IO（读本子 / 加载底图）的上限，与 PDF 底图同一档 10 秒。
 *
 * 没有上限的话，同步盘卡住、资源被删但 URL 还挂着时 Promise 可能永远
 * 不 settle：paintEmbed 卡在 await → state.rendering 永远是 true →
 * 这块嵌入永久停在占位，之后每次保存的刷新请求也全被 `if (rendering)`
 * 吞掉。超时后走 reject，由 paintEmbed 的 catch 复位并保留错误占位。
 */
const EMBED_IO_TIMEOUT_MS = 10_000;
let embedIoTimeoutMs = EMBED_IO_TIMEOUT_MS;

/** 仅测试用：把 IO 超时压短，否则要等 10 秒才看得到结果 */
export function setEmbedIoTimeoutForTest(ms: number): void {
  embedIoTimeoutMs = Number.isFinite(ms) && ms > 0 ? ms : EMBED_IO_TIMEOUT_MS;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  const loaded = new Promise<HTMLImageElement | null>((resolve) => {
    try {
      const img = new Image();
      img.onload = () => resolve(img);
      // 404 / 格式坏：这是「确定读不到」，resolve(null) 走浅灰底图，
      // 笔迹和批注照常显示（与 PDF 底图取不到时的处理一致）
      img.onerror = () => resolve(null);
      img.src = url;
    } catch (_) {
      resolve(null);
    }
  });
  /*
   * 超时则 reject（而不是 null）：「根本没回来」与「确定 404」不同，
   * 交给 paintEmbed 的 catch 保留错误占位，rendering 也能复位。
   */
  return withTimeout(loaded, embedIoTimeoutMs, "底图加载");
}

/** 底图取不到时的浅灰块：证明「这页有底图，只是没画出来」，不是空白页 */
function fillBgPlaceholder(ctx: CanvasRenderingContext2D, page: Page): void {
  const bg = page.background;
  if (!bg) return;
  ctx.save();
  ctx.fillStyle = "#F2F1EE";
  ctx.fillRect(bg.x, bg.y, bg.width, bg.height);
  ctx.restore();
}

/* ------------------------------- 一页的绘制 ------------------------------- */

/**
 * 把一本书的第 index 页（0 起）画成一张 canvas。
 *
 * 层序与主编辑器完全一致：纸 → 底图 → 笔迹 → 用户批注。
 * canvas 的 CSS 显示宽度是 `embedDisplayWidth(widthPx)`（高度由 CSS 按纸张
 * 比例算），backing store 按"位图宽 × dpr（上限 2）"分配——这样在高分屏上
 * 是清楚的，在 300px 宽的窄嵌入里也不会画出 794px 的位图再去缩放。
 *
 * 两种宽度**刻意分开**：位图宽受设备像素预算（内存）约束，显示宽受排版
 * 约束，dpr>1 时两者可以差近一倍，见 embedDisplayWidth 的说明。
 *
 * @param index 0 起的页下标；越界自动夹到最后一页
 * @param widthPx 请求的 CSS 宽度（来自 `|宽` 或量到的栏宽），不是最终的显示宽
 */
export async function renderEmbedPage(
  book: InkBook,
  index: number,
  widthPx: number
): Promise<HTMLCanvasElement> {
  const pageW = Number(book?.width) > 0 ? Number(book.width) : A4_WIDTH;
  const pageH = Number(book?.height) > 0 ? Number(book.height) : A4_HEIGHT;
  const pages = Array.isArray(book?.pages) ? book.pages : [];
  const safeIndex = clampPageIndex(pages.length, index + 1);
  const page: Page | undefined = pages[safeIndex];

  /*
   * dpr 先定下来：宽度上限本身就依赖它（dpr=2 时 2000 CSS px 会画出
   * 86MB 的位图，见 MAX_EMBED_DEVICE_PIXELS），不能先夹宽度再定 dpr。
   *
   * 两条宽度从这里分开：
   *   · cssW   = 位图宽（设备像素预算夹出来的，dpr=2 时 ≤840），决定 canvas.width；
   *   · displayW = 显示宽（只受 MAX_EMBED_WIDTH 限制，不折 dpr），决定 style.width。
   * 合二为一时 dpr≥2 的设备在宽栏里会右边空一大块（见 embedDisplayWidth 的说明）。
   */
  const dpr = embedDpr();
  const cssW = clampEmbedWidth(widthPx, pageW, dpr);
  const displayW = embedDisplayWidth(widthPx, pageW);
  const cssH = Math.max(1, Math.round((cssW * pageH) / pageW));

  const canvas = document.createElement("canvas");
  canvas.className = "mb-embed-canvas";
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  /*
   * 只写宽度，不写高度：高度交给 CSS 的 `height: auto` 按 canvas 的
   * 内在比例算。宿主栏宽比我们出图时窄一点（改窗口尺寸、分栏、移动端）
   * 时，`max-width: 100%` 会把宽度压下来——如果高度是写死的 px，
   * 这一压就把 A4 页面压成竖条（真机上表现为"笔记里的本子被拉长了"）。
   *
   * 这里写 displayW 而不是 cssW：cssW 是按内存预算折过的出图宽，拿它当
   * 显示宽会让高分屏上宽栏里的嵌入图右边空出一大块。
   */
  canvas.style.width = displayW + "px";
  canvas.dataset.page = String(page ? safeIndex + 1 : 0);

  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  // 后面所有绘制都用**页面坐标**（794×1123 那套），跟文件里的数据同一单位
  ctx.save();
  ctx.scale(canvas.width / pageW, canvas.height / pageH);

  // 纸面：线宽按"约 0.9 个 CSS 像素"折算，缩到 300px 宽时网格才不会糊成一片
  drawPaper(
    ctx,
    page?.template ?? "blank",
    page?.paper ?? "white",
    pageW,
    pageH,
    (0.9 * pageW) / cssW
  );

  if (page) {
    await drawEmbedBackground(ctx, page, pageW, cssW, dpr);
    // 插入的图片：与主编辑器同层序（底图之上、笔迹之下）
    await drawEmbedImages(ctx, page);

    for (const layer of page.layers ?? []) {
      if (layer.visible === false) continue;
      const alpha = typeof layer.opacity === "number" ? layer.opacity : 1;
      for (const stroke of layer.strokes ?? []) drawStroke(ctx, stroke, alpha);
    }

    /*
     * 手写批注要等自带字体就绪再画（INK-224）：canvas 的 font 解析不到
     * `"Inkbook Hand"` 就直接用回退字体，笔记里那块嵌入图会显示成黑体，
     * 而点进本子里是手写 —— 同一段字两个样子。
     * 等不到（老环境 / 字体坏了）也只是回落到 Noto，不影响出图。
     */
    await ensureHandFont();
    drawUserTexts(ctx, page, pageW, pageH);
  }

  ctx.restore();
  return canvas;
}

/**
 * 画底图（导入的 PDF / Word 页）。
 *
 * 这是**脱离 editor 的独立渲染**：不 new BookEditor（那会把整套交互状态
 * 搬进笔记里），只借 pdf.ts 的 openPdf / renderPdfPage。
 * 拿不到就画浅灰占位 + console.warn，绝不抛错——一块嵌入坏掉不该让整篇
 * 笔记的渲染流程（Obsidian 会 catch 后丢掉这个块）变空白。
 */
async function drawEmbedBackground(
  ctx: CanvasRenderingContext2D,
  page: Page,
  pageW: number,
  cssW: number,
  dpr: number
): Promise<void> {
  const bg = page.background;
  if (!bg) return;

  if (bg.pdf) {
    try {
      const doc = await withTimeout(getPdfDoc(bg.pdf.path), 10000, "PDF 底图");
      // 目标位图宽度 = 底图在页面里占的比例 × 显示宽度 × dpr；封顶 2048 防显存爆掉
      const want = Math.round((bg.width / pageW) * cssW * dpr);
      const targetPx = Math.min(Math.max(want, 64), 2048);
      const rendered = await withTimeout(
        renderPdfPage(doc, bg.pdf.page, targetPx),
        10000,
        "PDF 页渲染"
      );
      ctx.save();
      // 嵌入 PDF 位图通常比栏宽大：高质量降采样让既有导入本子无需迁移就变清楚。
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(rendered.bitmap, bg.x, bg.y, bg.width, bg.height);
      ctx.restore();
      rendered.bitmap.close?.();
      return;
    } catch (e) {
      console.warn(
        "[inkbook] 嵌入：PDF 底图取不到，改为浅灰占位（笔迹照常显示）",
        bg.pdf.path,
        e
      );
      fillBgPlaceholder(ctx, page);
      return;
    }
  }

  if (!bg.src) return;
  const img = await loadImage(resolveAssetUrl(bg.src));
  if (!img || img.naturalWidth === 0) {
    console.warn("[inkbook] 嵌入：底图图片读不出来，改为浅灰占位", bg.src);
    fillBgPlaceholder(ctx, page);
    return;
  }
  ctx.save();
  // Word 静态底图按原分辨率加载，缩到嵌入宽度时显式走高质量采样。
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, bg.x, bg.y, bg.width, bg.height);
  ctx.restore();
}

/**
 * 画页面上插入的图片（层序与主编辑器一致：底图之上、笔迹之下）。
 *
 * 每张图异步加载、带超时；单张取不到就跳过（不阻塞其余内容，也不影响
 * 笔迹和批注）。用 loadImage 的单张 `.catch(() => null)` 把「超时 reject」
 * 也当成取不到，避免一张坏图把整块嵌入渲染带崩。
 */
async function drawEmbedImages(ctx: CanvasRenderingContext2D, page: Page): Promise<void> {
  const imgs = page.images;
  if (!imgs?.length) return;
  const loaded = await Promise.all(
    imgs.map((im) =>
      im && im.src && im.width > 0 && im.height > 0
        ? loadImage(resolveAssetUrl(im.src)).catch(() => null)
        : Promise.resolve(null)
    )
  );
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  imgs.forEach((im, i) => {
    const img = loaded[i];
    if (img && img.naturalWidth > 0 && im.width > 0 && im.height > 0) {
      ctx.drawImage(img, im.x, im.y, im.width, im.height);
    }
  });
  ctx.restore();
}

/** 批注的 CSS font 串（与 editor 的 textFontCss 同一套规则） */
function embedTextFont(t: { size?: number; font?: string; bold?: boolean }): string {
  const size = typeof t.size === "number" && t.size > 0 ? t.size : 14;
  return `${t.bold ? "600 " : ""}${size}px ${textFontStack(t.font)}`;
}

/**
 * 画用户批注。
 *
 * 只画 `user`：`pdf` 那批是原文的透明文字层（屏幕上只用来选中/搜索，
 * 视觉由底图承担），画出来就是重影。
 * 折行 + 位置夹取一律走 textwrap.layoutUserText —— 同一段字在嵌入图、
 * 主视图、导出的 PDF 里必须断在同一个地方。
 */
function drawUserTexts(
  ctx: CanvasRenderingContext2D,
  page: Page,
  pageW: number,
  pageH: number
): void {
  const texts = (page.texts ?? []).filter((t) => t.source === "user" && (t.text || "").trim());
  if (!texts.length) return;

  for (const t of texts) {
    ctx.save();
    ctx.fillStyle = t.color || "#1A1A1A";
    ctx.font = embedTextFont(t);
    ctx.textBaseline = "alphabetic";
    /*
     * ctx 已经按 dpr × 缩放比例变换过，measureText 返回的仍是**页面坐标**下
     * 的宽度（跟 x / y / size / 纸宽同一套单位），不需要再乘缩放。
     */
    const layout = layoutUserText(
      // 嵌入页也要吃同一份显式宽度，否则同一段字在编辑器里两行、笔记里三行
      { x: t.x, y: t.y, size: t.size || 14, text: t.text, width: t.width },
      pageW,
      pageH,
      (s) => ctx.measureText(s).width
    );
    for (let i = 0; i < layout.lines.length; i += 1) {
      const line = layout.lines[i];
      if (!line) continue;
      ctx.fillText(line, layout.x, layout.y + i * layout.lineHeight);
    }
    ctx.restore();
  }
}

/* ------------------------------- 缓存 ------------------------------- */

/**
 * 缓存上限 64MB（INK-117）。
 *
 * 以前是 32MB：一张满栏嵌入（dpr=2、位图宽 840、A4 比例）约 16MB，
 * 32MB 只放得下 2 张，一篇笔记里 3 个以上满栏嵌入时，滚回去就得
 * 用 pdf.js 重画（单张 40–60ms），用户感觉「滚一下卡一下」。
 * 抬到 64MB 正好放下 4 张，来回滚动不再重画。
 *
 * 仍然远低于主视图的 160MiB 挂载预算，且不碰 MAX_CANVAS_PIXELS=16M。
 * 单条位图超预算时 evictBitmaps 照样把它淘汰掉，不会无限涨。
 */
export const EMBED_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_BYTES = EMBED_CACHE_BYTES;
/** 页面数据（InkBook）缓存条数：一本几十 MB 的 JSON 不能按嵌入数复制几十份 */
const MAX_BOOK_CACHE = 6;

interface BitmapEntry {
  key: string;
  bitmap: ImageBitmap;
  pxW: number;
  pxH: number;
  /**
   * 这张位图对应的 **CSS 宽度（位图宽，已按设备像素预算折过）**。
   * 只用来对账/排查：**不要**拿它当 `style.width` —— 显示宽是
   * `embedDisplayWidth()` 的事，两者在 dpr>1 时可以差一倍（见那里的说明）。
   */
  cssW: number;
  bytes: number;
}

const bitmapCache = new Map<string, BitmapEntry>();
let bitmapBytes = 0;
const bookCache = new Map<string, Promise<InkBook>>();

/** 缓存键的公共前缀：`路径|mtime` */
export function embedBookKey(file: EmbedFile): string {
  return `${file.path}|${mtimeOf(file)}`;
}

function mtimeOf(file: EmbedFile): number {
  const raw = file?.stat?.mtime;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function touchBitmap(key: string): void {
  const entry = bitmapCache.get(key);
  if (!entry) return;
  // Map 的插入顺序就是 LRU 顺序：取出来再塞回去 = 标记为最近使用
  bitmapCache.delete(key);
  bitmapCache.set(key, entry);
}

function evictBitmaps(): void {
  /*
   * 这里**不能**保底「至少留一条」。
   *
   * 单条位图本身就可能超过预算（`|2000` 在 dpr=2 下 ~90MB；旧版
   * `|3000` 一轮就 49MB）。保底会让缓存永远停在超限状态——实测
   * 32MB 上限下稳稳躺在 50,916,000B。宁可把刚存进来的这条也淘汰掉：
   * 它下次要显示时再画一遍，代价远小于把手机内存吃满。
   */
  while (bitmapBytes > MAX_CACHE_BYTES && bitmapCache.size > 0) {
    const oldest = bitmapCache.keys().next().value;
    if (oldest === undefined) break;
    const entry = bitmapCache.get(oldest);
    bitmapCache.delete(oldest);
    if (!entry) continue;
    bitmapBytes -= entry.bytes;
    entry.bitmap.close?.();
  }
  if (bitmapBytes < 0) bitmapBytes = 0;
}

function putBitmap(entry: BitmapEntry): void {
  const old = bitmapCache.get(entry.key);
  if (old) {
    bitmapCache.delete(entry.key);
    bitmapBytes -= old.bytes;
    old.bitmap.close?.();
  }
  bitmapCache.set(entry.key, entry);
  bitmapBytes += entry.bytes;
  evictBitmaps();
}

/**
 * 读一本书（带缓存）：同一本子只 `readBook` 一次。
 *
 * 没有这层缓存，一篇笔记里十个 `![[本子.inkbook]]` 就会把同一份几十 MB 的
 * JSON 解析十遍——滚动一次卡十次。
 */
export function getEmbedBook(app: EmbedApp | null, file: EmbedFile): Promise<InkBook> {
  const key = embedBookKey(file);
  const hit = bookCache.get(key);
  if (hit) {
    // 命中也要重排：最近用过的书不该被下一条挤出去
    bookCache.delete(key);
    bookCache.set(key, hit);
    return hit;
  }

  const adapter = (app ?? embedApp)?.vault?.adapter;
  if (!adapter) return Promise.reject(new Error("拿不到 vault.adapter，无法读取手写本"));

  const p = withTimeout(
    readBook(adapter, file.path, file.basename),
    embedIoTimeoutMs,
    "读取手写本"
  ).catch((e) => {
    // 读失败 / 超时都不缓存：文件可能正在同步，下次嵌入还能再试
    bookCache.delete(key);
    throw e;
  });
  bookCache.set(key, p);
  while (bookCache.size > MAX_BOOK_CACHE) {
    const oldest = bookCache.keys().next().value;
    if (oldest === undefined) break;
    bookCache.delete(oldest);
  }
  return p;
}

/**
 * 清掉一本（或全部）的嵌入缓存。
 *
 * **这里刻意不做「同 mtime = 重复信号」的去重**（2026-11-07 试过，已撤）。
 * 判据不成立：同一版内容确实会有两条刷新信号（vault modify + saveNow
 * 主动通知），但**真实的第二次修改**同样可能 mtime 不变——同秒内写两次、
 * 同步盘回写、外部工具保留 mtime 都会这样。两者在时间上无法区分，
 * 按 mtime 吞信号会把「渲染期间又保存了一次」「滚回视口要补画」这些
 * **必须重画**的场景一起吞掉（qa-embed4 的 4c / 4c2 当场抓到）。
 *
 * 代价只是慢盘下偶尔重画两次（一次 drawImage），远小于「该更新的块
 * 停在旧图」。1.5s 去抖窗口已经把同一批 modify 合并掉了，实际重复很少。
 *
 * @param path 只清这一本；不传则全清
 */
export function invalidateEmbedCache(path?: string): void {
  if (!path) {
    for (const entry of bitmapCache.values()) entry.bitmap.close?.();
    bitmapCache.clear();
    bitmapBytes = 0;
    bookCache.clear();
    releasePdfDocs();
    return;
  }

  const prefix = path + "|";
  for (const [key, entry] of Array.from(bitmapCache)) {
    if (!key.startsWith(prefix)) continue;
    bitmapCache.delete(key);
    bitmapBytes -= entry.bytes;
    entry.bitmap.close?.();
  }
  if (bitmapBytes < 0) bitmapBytes = 0;
  for (const key of Array.from(bookCache.keys())) {
    if (key.startsWith(prefix)) bookCache.delete(key);
  }
}

/** 缓存现状（测试断言 / 排查内存用）；limit 一起给，避免测试硬编码预算数字 */
export function embedCacheStats(): {
  bitmaps: number;
  bytes: number;
  books: number;
  limit: number;
} {
  return {
    bitmaps: bitmapCache.size,
    bytes: bitmapBytes,
    books: bookCache.size,
    limit: EMBED_CACHE_BYTES,
  };
}

/**
 * 用缓存里的位图拼一张等尺寸 canvas（位图不能在两个地方同时用，只能复制）。
 *
 * `displayW` 由调用方传：它**不属于**缓存内容。位图只由 backing 尺寸决定，
 * 而显示宽是排版问题——dpr=2 下 `|2000` 和 `|1200` 的位图都是 840，
 * 共用一条缓存，却要分别显示成 1198 和 1200。所以命中缓存时只给新 canvas
 * 设 style.width，绝不重画位图。
 */
function canvasFromBitmap(entry: BitmapEntry, displayW: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.className = "mb-embed-canvas";
  canvas.width = entry.pxW;
  canvas.height = entry.pxH;
  // 高度同样交给 CSS 的 height:auto（见 renderEmbedPage 里的说明）
  canvas.style.width = displayW + "px";
  canvas.dataset.page = entry.key.split("|")[2] ?? "1";
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.drawImage(entry.bitmap, 0, 0);
  return canvas;
}

/* ------------------------------- 带缓存的一页 ------------------------------- */

/**
 * 按文件渲染一页：带「页面数据 + 位图」两级缓存。
 *
 * 缓存键 = `路径|mtime|页码|位图宽`：本子一改（mtime 变）或换页/换宽度就自然失效，
 * 不需要谁记得手动清。
 *
 * 键里放的是 **cssW（位图宽）**，不是请求宽也不是显示宽：位图内容只由
 * backing 尺寸决定，所以 dpr=2 下 `|2000` 与 `|1200` 共用同一条缓存
 * （位图都夹到 840），只是 displayW 分别是 2000 / 1200（在 1200 栏里
 * 都被 `max-width: 100%` 压到 1198，右侧不再留白）。
 */
export async function renderEmbedForFile(
  app: EmbedApp | null,
  file: EmbedFile,
  requestedPage: number,
  widthPx: number
): Promise<EmbedRenderResult> {
  const book = await getEmbedBook(app, file);
  const pages = Array.isArray(book?.pages) ? book.pages : [];
  const index = clampPageIndex(pages.length, requestedPage);
  const actualPage = pages.length ? index + 1 : 1;
  const pageW = Number(book?.width) > 0 ? Number(book.width) : A4_WIDTH;
  const cssW = clampEmbedWidth(widthPx, pageW, embedDpr());
  const displayW = embedDisplayWidth(widthPx, pageW);
  const clamped = actualPage !== requestedPage;
  /** 书一共几页（空书按 1 算，角标不至于写「共 0 页」） */
  const pageCount = Math.max(1, pages.length);
  const key = [file.path, mtimeOf(file), actualPage, cssW].join("|");

  const hit = bitmapCache.get(key);
  if (hit) {
    touchBitmap(key);
    // 命中：位图不重画，只把显示宽设成本次请求的（可能与上次不同）
    const canvas = canvasFromBitmap(hit, displayW);
    canvas.dataset.page = String(actualPage);
    return { canvas, actualPage, requestedPage, clamped, pageCount };
  }

  /*
   * 传**请求宽**而不是 cssW：renderEmbedPage 内部会各夹各的
   * （cssW 受设备像素预算、displayW 只受 MAX_EMBED_WIDTH）。
   * 传 cssW 的话显示宽会被二次折成 840，白栏又回来了。
   */
  const canvas = await renderEmbedPage(book, index, widthPx);

  /*
   * 转成位图再缓存：canvas 留着等于多占一块绘图表面，ImageBitmap 更省。
   * 转不出来（老环境没 createImageBitmap）就只是不缓存，功能不受影响。
   */
  try {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(canvas);
      putBitmap({
        key,
        bitmap,
        pxW: canvas.width,
        pxH: canvas.height,
        cssW,
        bytes: canvas.width * canvas.height * 4,
      });
    }
  } catch (_) {
    /* 缓存失败不影响这一屏 */
  }

  return { canvas, actualPage, requestedPage, clamped, pageCount };
}

/* ------------------------------- postprocessor ------------------------------- */

/** 处理过的块打这个标记，防止 postprocessor 反复触发时重复插入 */
const EMBED_DONE_CLASS = "mb-embed-done";
/** 加在 `.internal-embed` 上，让宿主原有的 inline 样式让位 */
const EMBED_HOST_CLASS = "mb-embed-host";

interface EmbedState {
  host: EmbedHost;
  file: EmbedFile;
  page: number;
  width: number | null;
  container: HTMLElement;
  placeholder: HTMLElement | null;
  rendered: boolean;
  rendering: boolean;
  /** 渲染期间又被要求重画（本子刚保存）：画完立刻补一轮，别丢请求 */
  repaintQueued: boolean;
  /**
   * 本子保存过、但这一块当时在视口外，没重画。
   *
   * 不能只靠观察器「滚回来再画」：块第一次画完就 unobserve 了，
   * 之后不会再有回调。标脏并在滚进视口时按新内容重画。
   */
  stale: boolean;
}

/** 键是容器 `.mb-embed` 本身：重画时直接在 DOM 里按容器找状态 */
let states = new WeakMap<Element, EmbedState>();
let observer: IntersectionObserver | null = null;

/**
 * 懒加载观察器：进入视口（提前 200px）才读文件、画位图。
 *
 * 一篇笔记可能有几十个嵌入，全部立刻渲染等于一次读几十份 JSON。
 * 只观察一次：画完就 unobserve，之后 Obsidian 重渲染会重建 DOM 重新走流程。
 */
function ensureObserver(): IntersectionObserver | null {
  if (observer) return observer;
  if (typeof IntersectionObserver !== "function") return null;
  observer = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        if (!el.isConnected) {
          obs.unobserve(el);
          continue;
        }
        if (!entry.isIntersecting) continue;
        obs.unobserve(el);
        const state = states.get(el);
        if (state) void paintEmbed(state);
      }
    },
    { rootMargin: "200px" }
  );
  return observer;
}

/**
 * 卸载时调用：断开观察器、取消待执行的重画。
 * 缓存由 invalidateEmbedCache 负责（onunload 里两个都调）。
 */
export function disposeEmbeds(): void {
  observer?.disconnect();
  observer = null;
  if (refreshTimer) {
    window.clearTimeout(refreshTimer);
    refreshTimer = 0;
  }
  pendingRefresh.clear();
  states = new WeakMap<Element, EmbedState>();
}

function clearChildren(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function makePlaceholder(name: string, page: number, missing: boolean): HTMLElement {
  const ph = document.createElement("div");
  ph.className = "mb-embed-ph" + (missing ? " mb-embed-ph-err" : "");
  const title = document.createElement("span");
  title.className = "mb-embed-ph-name";
  title.textContent = missing ? `找不到本子：${name}` : name;
  ph.appendChild(title);
  if (!missing) {
    const label = document.createElement("span");
    label.className = "mb-embed-ph-page";
    label.textContent = `第 ${page} 页`;
    ph.appendChild(label);
  }
  return ph;
}

/**
 * 写角标 + 三份 dataset。
 *
 * 角标策略：平时 hover 才浮出来（不抢注意力）；页码越界时常显 + 警示色，
 * 因为那正是「用户想看第 99 页、结果只看到第 3 页」最需要解释的一刻。
 */
function applyBadge(
  container: HTMLElement,
  actualPage: number,
  pageCount: number,
  clamped: boolean
): void {
  let badge = container.querySelector(".mb-embed-badge") as HTMLElement | null;
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "mb-embed-badge";
    container.appendChild(badge);
  }
  badge.classList.toggle("is-clamped", clamped);
  badge.textContent = clamped
    ? `第 ${actualPage} 页 / 共 ${pageCount} 页`
    : `第 ${actualPage} 页`;
  badge.title = clamped
    ? `链接里的页码超出了页数，已显示最后一页（第 ${actualPage} 页 / 共 ${pageCount} 页）`
    : `第 ${actualPage} 页（点开这本手写本）`;

  container.classList.toggle("is-clamped", clamped);
  // dataset 供 CSS / 测试 / 排查读取（data-inkbook-page / -clamped）
  container.dataset.inkbookPage = String(actualPage);
  container.dataset.inkbookClamped = clamped ? "1" : "0";
}

/** 不写宽度时按容器宽度算：占满栏宽 */
function measureContainerWidth(container: HTMLElement): number {
  let w = 0;
  /*
   * 优先 clientWidth：它已经排除了我们自己的 1px 边框，量出来的就是
   * **内容宽**——canvas 只有按内容宽出图才不会被 max-width 再压一次，
   * 位图与显示尺寸 1:1，最清晰。
   */
  try {
    w = container.clientWidth || container.getBoundingClientRect().width || 0;
  } catch (_) {
    /* 还没布局时拿不到 */
  }
  if (!(w > 0)) {
    try {
      w = container.parentElement?.getBoundingClientRect().width || 0;
    } catch (_) {
      /* 同上 */
    }
  }
  if (!(w > 0)) w = 600;
  /*
   * 下限只防"0 宽"这种病态值，不能往上抬：栏宽本来就可能只有 90px
   * （并排分栏 / 移动端），把它抬到 120 会画出一张比容器宽的图，
   * 再被 max-width 压扁——页面就被拉成竖条了。
   *
   * 这里量到的是**布局宽度**，必须走 embedDisplayWidth（不折 dpr）：
   * 折了 dpr 就是那个"dpr=2 的宽栏里右边空 359px"的回退。
   */
  return embedDisplayWidth(w, 600);
}

/**
 * 真正画这一块：占位换成 canvas，补上角标。
 *
 * `force = true` 是「本子刚保存，把旧图换掉」的重画路径：
 * 调用方已经清过缓存，这里只负责把新图画出来并顶替旧 canvas。
 */
async function paintEmbed(state: EmbedState, force = false): Promise<void> {
  if (state.rendering) {
    // 正在画又有新请求：记一笔，画完立刻补一轮（否则这次保存就白丢了）
    if (force || state.stale) state.repaintQueued = true;
    return;
  }
  // stale = 保存时在视口外，滚回来必须用新内容重画（不能因为 rendered 就跳过）
  if (state.rendered && !force && !state.stale) return;

  state.rendering = true;
  try {
    /*
     * 这里**不夹宽度**，只把"用户写的 / 量到的"请求宽原样交下去：
     * 位图宽（受设备像素预算）和显示宽（只受 MAX_EMBED_WIDTH）是两个
     * 东西，在这里先夹一次就等于把两者又合并回去——`|3000` 会被折成
     * 840 当显示宽，高分屏宽栏里右边就空出来了。
     * `|0` / `#abc` 这类非法值在解析阶段已经是 null，这里拿到的要么是
     * 正数要么是量出来的栏宽。
     */
    const requestedW = state.width ?? measureContainerWidth(state.container);
    const result = await renderEmbedForFile(state.host.app, state.file, state.page, requestedW);

    if (state.placeholder && state.placeholder.parentNode) {
      state.placeholder.parentNode.removeChild(state.placeholder);
    }
    state.placeholder = null;

    // 重画：先把旧 canvas 摘掉再挂新的，避免叠在一起
    const old = state.container.querySelector(".mb-embed-canvas");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    state.container.appendChild(result.canvas);
    state.container.classList.add("mb-embed-loaded");

    applyBadge(state.container, result.actualPage, result.pageCount, result.clamped);
    state.rendered = true;
    state.stale = false;
  } catch (e) {
    console.warn("[inkbook] 嵌入：这一页渲染失败（占位保留，点开可以试试）", state.file.path, e);
    /*
     * 重画失败时占位可能已经不在了（上一次成功后就置 null），旧 canvas
     * 还留在 DOM 里 = 用户看到的是一张**过期内容**，比"读不出来"更误导。
     * 摘掉旧 canvas，重新挂一个错误占位，宁可显示错误也不要显示旧图。
     */
    const old = state.container.querySelector(".mb-embed-canvas");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    state.container.classList.remove("mb-embed-loaded");
    let ph = state.placeholder;
    if (!ph || !ph.parentNode) {
      ph = makePlaceholder(state.file?.basename || state.file?.path || "手写本", state.page, false);
      state.container.appendChild(ph);
      state.placeholder = ph;
    }
    ph.classList.add("mb-embed-ph-err");
    ph.textContent = "这本手写本暂时读不出来（点开可以试试）";
    // 容器里已经没有 canvas：让下一次 paintEmbed（哪怕非 force）重试
    state.rendered = false;
    state.stale = false;
  } finally {
    state.rendering = false;
    if (state.repaintQueued) {
      state.repaintQueued = false;
      void paintEmbed(state, true);
    }
  }
}

function mountEmbed(host: EmbedHost, node: HTMLElement, sourcePath: string): void {
  const target = readEmbedTarget(node);
  const container = document.createElement("div");
  container.className = "mb-embed";
  container.setAttribute("data-inkbook-embed", "1");
  // 记得下路径：本子保存后要靠它在 DOM 里找回所有引用（不维护额外映射表）
  container.dataset.inkbookPath = target.linktext;
  container.dataset.inkbookPage = String(target.page);
  container.dataset.inkbookClamped = "0";
  container.tabIndex = 0;
  container.setAttribute("role", "button");

  // Obsidian 自带的那层占位（文件名 + 图标）先清掉，换成我们自己的
  clearChildren(node);
  node.appendChild(container);

  const file = resolveEmbedFile(host.app, target.linktext, sourcePath);
  if (!file) {
    container.classList.add("mb-embed-missing");
    container.appendChild(makePlaceholder(target.linktext || "（空链接）", target.page, true));
    return;
  }

  // dataset 用 TFile 的规范路径（链接文本可能是短名 / 相对路径，各处写法不同）
  container.dataset.inkbookPath = file.path;

  const name = file.basename || target.linktext;
  container.title = `打开《${name}》第 ${target.page} 页`;
  const placeholder = makePlaceholder(name, target.page, false);
  container.appendChild(placeholder);

  const state: EmbedState = {
    host,
    file,
    page: target.page,
    width: target.width,
    container,
    placeholder,
    rendered: false,
    rendering: false,
    repaintQueued: false,
    stale: false,
  };
  states.set(container, state);

  /** 点开这一块：修饰键决定新开标签页还是就地替换 */
  const openIt = (newTab: boolean): void => {
    void state.host.openBookAt(file.path, target.page, newTab ? { newTab: true } : undefined);
  };

  /*
   * 整块可点：点进去用真编辑器写。
   * 必须拦下宿主的默认行为——`.internal-embed` 自带"打开文件"的 click 处理器
   * 走的是默认页（activePage），我们要的是链接里写的那一页。
   */
  container.addEventListener("click", (ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    openIt(ev.ctrlKey || ev.metaKey);
  });
  /*
   * 中键走的是 auxclick 不是 click（浏览器规范），单靠 click 收不到。
   * 中键在用户的肌肉记忆里等于"后台开新标签"，所以一律 newTab。
   */
  container.addEventListener("auxclick", (ev: MouseEvent) => {
    if (ev.button !== 1) return;
    ev.preventDefault();
    ev.stopPropagation();
    openIt(true);
  });
  container.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    ev.stopPropagation();
    // 键盘只有一条路径：就地打开（跟原生内部链接一致）
    openIt(false);
  });

  const io = ensureObserver();
  if (io) io.observe(container);
  else void paintEmbed(state); // 没有 IntersectionObserver（老环境/测试桩）：直接画
}

/* ---------------------- 本子保存后重画视口内的块 ---------------------- */

/** 防抖窗口：保存一次会连着触发几次 modify，攒一批再画 */
const REFRESH_DEBOUNCE_MS = 1500;
/** 与观察器的 rootMargin 对齐：视口上下各留 200px 都算"看得见" */
const REFRESH_MARGIN = 200;

let refreshTimer = 0;
const pendingRefresh = new Set<string>();

/** 属性选择器里的值要转义（路径里有引号/反斜杠时否则会拼出非法选择器） */
function cssEscapeValue(value: string): string {
  const api = (window as any).CSS;
  if (api && typeof api.escape === "function") return api.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

/** 按本子路径找 DOM 里的嵌入容器（顺序即文档顺序） */
function findEmbedsByPath(path: string): HTMLElement[] {
  const sel = `.mb-embed[data-inkbook-path="${cssEscapeValue(path)}"]`;
  try {
    return Array.from(document.querySelectorAll(sel)) as HTMLElement[];
  } catch (_) {
    return [];
  }
}

/** 这一块现在看得见吗（视口上下各放宽 REFRESH_MARGIN） */
function isEmbedVisible(el: HTMLElement): boolean {
  try {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0) && !(r.height > 0)) return false;
    const top = -REFRESH_MARGIN;
    const bottom = (window.innerHeight || 0) + REFRESH_MARGIN;
    return r.bottom >= top && r.top <= bottom;
  } catch (_) {
    return false;
  }
}

/**
 * 把一批路径的嵌入重画一遍。
 *
 * 只**现在画**视口内的：屏幕外的块提前光栅化只是白烧 CPU。
 * 但屏幕外的不能就这么算了——块第一次画完就 unobserve 了，滚回来不会再有回调，
 * 只跳过的话它会永远停在旧图上。所以标脏并重新挂观察器，进视口时再画。
 */
function redrawPaths(paths: string[]): void {
  for (const path of paths) {
    // 先清缓存：不清就会读到旧 mtime 的位图，等于没重画
    invalidateEmbedCache(path);
    for (const container of findEmbedsByPath(path)) {
      const state = states.get(container);
      if (!state) continue;
      if (isEmbedVisible(container)) {
        void paintEmbed(state, true);
        continue;
      }
      state.stale = true;
      const io = ensureObserver();
      // 没有 IntersectionObserver 的老环境只能现在就画（宁可多烧一点）
      if (io) io.observe(container);
      else void paintEmbed(state, true);
    }
  }
}

/**
 * 通知：这本手写本保存过了，视口内的嵌入该重画了。
 *
 * 不维护「路径 → 节点表」：表会随笔记反复开关泄漏，而且 Obsidian 重渲染
 * 段落时节点会被整个换掉，表还得跟着修。直接查 DOM —— 节点消失 = 自动清理。
 * 防抖 1.5s：自动保存一次会连着发好几条 modify。
 */
export function refreshEmbedsForPath(path: string): void {
  if (!path) return;
  pendingRefresh.add(path);
  if (refreshTimer) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = 0;
    const paths = Array.from(pendingRefresh);
    pendingRefresh.clear();
    redrawPaths(paths);
  }, REFRESH_DEBOUNCE_MS);
}

function collectEmbeds(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  try {
    if (el.matches?.(".internal-embed")) out.push(el);
  } catch (_) {
    /* matches 在极老的宿主上可能没有 */
  }
  if (el.querySelectorAll) {
    el.querySelectorAll(".internal-embed").forEach((n) => out.push(n as HTMLElement));
  }
  return out;
}

/**
 * 一个渲染段落里所有 `.inkbook` 嵌入的处理入口。
 *
 * 导出是为了让测试能直接调用（手工构造 DOM + 假 ctx），
 * 不必猜 postprocessor 的触发时机。
 */
export function processEmbedEl(
  host: EmbedHost,
  el: HTMLElement,
  ctx?: { sourcePath?: string }
): void {
  if (!host || !el) return;
  const sourcePath = ctx?.sourcePath || "";
  for (const node of collectEmbeds(el)) {
    // 幂等：滚动、编辑、窗口尺寸变化都会让 postprocessor 再跑一遍
    if (node.classList.contains(EMBED_DONE_CLASS)) continue;
    if (!isInkbookEmbed(node)) continue;
    node.classList.add(EMBED_DONE_CLASS);
    node.classList.add(EMBED_HOST_CLASS);
    try {
      mountEmbed(host, node, sourcePath);
    } catch (e) {
      // 单个块出错不能影响整篇笔记的渲染
      console.warn("[inkbook] 嵌入：挂载失败，已跳过这一块", e);
      node.appendChild(makePlaceholder("", 1, true));
    }
  }
}

/**
 * 注册 Markdown postprocessor。
 *
 * 注意：`plugin.registerMarkdownPostProcessor` 由 Obsidian 托管，
 * 卸载时自动清理，不需要我们手动反注册；这里只把 app 记进模块上下文
 * （纯绘制函数要用它取 PDF 底图）。
 */
export function registerEmbed(host: EmbedHost): void {
  if (!host) return;
  setEmbedContext(host.app ?? null);

  if (typeof host.registerMarkdownPostProcessor !== "function") {
    // 测试桩 / 极老宿主没有这个 API：不注册，功能降级为"显示宿主自己的占位"
    console.warn("[inkbook] 宿主没有 registerMarkdownPostProcessor，笔记内嵌入不可用");
    return;
  }

  host.registerMarkdownPostProcessor((el: HTMLElement, ctx: any) => {
    processEmbedEl(host, el, ctx);
  });
}
