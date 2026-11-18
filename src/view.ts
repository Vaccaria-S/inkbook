import { FileView, Menu, Notice, type TFile } from "obsidian";
import { setIcon } from "./icons";
import { keyCombo, resolveHotkeys, hotkeyLabelFor } from "./hotkeys";
import { BookEditor, bindHoldStepBtn, TEXT_FONTS } from "./editor";
import { ensureTextIndexOnOpen, writeTextIndex } from "./indexer";
import { BookStore } from "./store";
import {
  bookStats,
  fingerprint,
  hashText,
  readBookWithText,
  recoverFromBackup,
  TooNewError,
  writeBook,
  type FileFingerprint,
} from "./storage";
import {
  A4_HEIGHT,
  A4_WIDTH,
  createBook,
  HIGHLIGHTER_SIZES,
  PAPERS,
  PEN_COLORS,
  PEN_SIZES,
  TEMPLATES,
  normalizeShapeSnap,
  type InkBook,
  type InkbookSettings,
  type Outline,
  type PageImage,
  type PaperId,
  type ShapeKind,
  type TemplateId,
  type ToolId,
} from "./types";
import { paintPaperPreview } from "./paper";
import {
  NewBookModal,
  PromptModal,
  DeletePageModal,
  OutlineModal,
  ImportSourceModal,
  ImportRangeModal,
  InsertImageModal,
  InsertLinkModal,
  InsertFileBlockModal,
  ShareModal,
  safeName,
  collectLinkTargets,
  type ShareChoice,
} from "./modals";
import {
  humanBytes,
  importPdf,
  importWord,
  peekPdf,
  type ImportProgress,
} from "./importer";
import { ExportCancelledError, exportBookPdf, exportPagePng, exportPagePngAt } from "./export";
import { refreshEmbedsForPath } from "./embed";
import { adoptIncomingSource, remapAssetPrefix } from "./bookdata";
import { findInNote, MAX_FIND_MATCHES, type FindMatch } from "./find";
import { makeFileBlockSnapshot } from "./fileblocks";

export const VIEW_TYPE = "inkbook-view";

/**
 * 自动保存为「正在书写的笔」让路的最长时间。
 *
 * 正常情况抬笔就会恢复排程；这个上限只兜底事件丢失（pointerup 永远不来、
 * gesture 卡在 "draw"）——到点强制落一次盘，不能永远不存（INK-129）。
 */
const INK_DEFER_MAX_MS = 10_000;

const HIGHLIGHTER_PALETTE = ["#F6E05E", "#9AE6B4", "#90CDF4", "#FBB6CE", "#FBD38D"];

const TOOLS: Array<{ id: ToolId; icon: string; name: string; short: string }> = [
  { id: "pen", icon: "pen-tool", name: "钢笔", short: "钢笔" },
  { id: "ballpoint", icon: "pencil", name: "圆珠笔", short: "圆珠" },
  { id: "highlighter", icon: "highlighter", name: "荧光笔", short: "荧光" },
  { id: "eraser", icon: "eraser", name: "橡皮", short: "橡皮" },
  { id: "text", icon: "type", name: "文字", short: "文字" },
  { id: "select", icon: "cursor", name: "选择 / 移动", short: "选择" },
  { id: "shape", icon: "square", name: "形状", short: "形状" },
  { id: "hand", icon: "hand", name: "拖动画布", short: "拖动" },
];

const SHAPES: Array<{ id: ShapeKind; label: string }> = [
  { id: "rect", label: "矩形" },
  { id: "ellipse", label: "椭圆" },
  { id: "line", label: "直线" },
  { id: "arrow", label: "箭头" },
];

/**
 * 切过去时要自动展开侧栏的工具。
 *
 * 判据是「专属参数控件是不是只住在侧栏 .mb-sec-dyn 里」：
 *   · text   —— 字号 / 字体 / 颜色
 *   · eraser —— 整笔 / 局部 + 橡皮大小
 *   · shape  —— 形状种类（矩形 / 椭圆 / 直线 / 箭头）
 *
 * 不展开：
 *   · pen / ballpoint / highlighter —— 颜色和粗细都在笔盒区（顶栏按钮二次点击
 *     弹快捷笔盒 / 侧栏笔盒）；这三支换得最勤，每换一次就把
 *     侧栏盖到纸上（平板）反而碍事。
 *   · select / hand —— 没有可调参数，侧栏里只有一句操作提示。
 */
const TOOLS_NEED_SIDE = new Set<ToolId>(["text", "eraser", "shape"]);

/**
 * 顶栏工具按钮「二次点击」会在正下方弹出快捷笔盒的工具。
 *
 * 只有这三支有真正意义上的笔参数（颜色 + 粗细），也正好对应侧栏「笔盒」区：
 *   · pen / ballpoint —— 共用 PEN_COLORS（颜色）与 PEN_SIZES 档位，但粗细各记各的
 *   · highlighter     —— HIGHLIGHTER_PALETTE + HIGHLIGHTER_SIZES
 *
 * 橡皮没有颜色；形状虽然也用 penColor 落笔、按形状种类各记线宽，但它的种类
 * 选择只住在侧栏，点第二下已经会展开侧栏，再叠一个浮层反而碍事；
 * 文字 / 选择 / 抓手没有笔参数（见 TOOLS_NEED_SIDE 的说明）。
 */
const PEN_POP_TOOLS = new Set<ToolId>(["pen", "ballpoint", "highlighter"]);

/**
 * 侧栏「导出」入口与「导出整本 PDF」菜单项共用图标名。
 * 用户明确要求两处是同一个 file-text 图标；抽成常量，避免以后改菜单
 * 时忘了同步按钮（share-2 只留给「分享…」）。
 */
const EXPORT_ICON = "file-text";

/**
 * 侧栏页列表窗口化。
 *
 * `.mb-pages` 是「固定列数的等高网格」：同一行里每个条目、以及每一行
 * 的高度都由列宽 × `aspect-ratio` 决定，所以行高一致，可以按「第几行」
 * 算窗口，不用逐条测量。但**列宽会随侧栏宽度 / 断点变**（258 / 280 / 340），
 * 行高必须按真实条目现量（量不到时才用宽度兜底估算），
 * 并由 ResizeObserver 在侧栏尺寸变化时重算。
 *
 * 视口上下各多建 OVERSCAN 行：滚动时不至于先看到一片空白再补。
 * 行数不多时窗口化没有意义，直接全建。
 */
const PAGE_GRID_OVERSCAN_ROWS = 2;
const PAGE_GRID_FULL_ROWS = 24;

/**
 * 导入 PDF 时，页数超过这个值才弹「选页码范围」。
 *
 * 小文档（≤20 页）弹一次范围选择纯属打断，直接整本导入更顺手；
 * 大文档（教材、扫描件）往往有几百页，全导进来本子会变得很长，
 * 而用户通常只想要前几十页。
 */
const IMPORT_RANGE_THRESHOLD = 20;
/**
 * 滚出窗口的缩略图条目回收池上限。
 *
 * 条目连同 canvas 像素一起留着，滚回来时插回 DOM 就能立刻显示，
 * 不会出现「canvas 新建成空白 → IO 补画」那一帧。约两屏条目：
 * 平板上一屏 3–5 行 × 4 列，48 条足够覆盖来回滚动的范围；
 * 再远由 editor 的 thumbShots LRU（8MB）兜底，命中后只 blit 一次。
 */
const PAGE_THUMB_POOL_MAX = 48;
/** 与 styles.css 里 `.mb-thumb { aspect-ratio: 794 / 1123 }` 一致，只在量不到真实条目时兜底 */
const PAGE_THUMB_ASPECT = 1123 / 794;

/**
 * 侧栏「目录」区的窗口化参数。
 *
 * 目录是用户自己写的条目，几十条很常见、上百条也不稀奇。
 * 一次建几百个 DOM 还能忍，但没必要——目录区有自己的滚动容器，
 * 只建可视区附近的那几条就够，滚到哪儿建到哪儿。
 *
 * 少于 FULL 条时直接全建：窗口化反而添乱（还要量高度、算偏移）。
 */
const OUTLINE_WINDOW_MAX = 60;
/** 目录区可视区上下各多建几条 */
const OUTLINE_OVERSCAN = 4;
/**
 * 量不到真实条目时的兜底行高（px）。
 *
 * 必须贴近 CSS 实际高度（`.mb-outline` 是 `min-height:24px` +
 * `padding:3px 4px 3px 7px` + `font-size:10.5px` → 实测约 30px）。
 * 兜底值偏小会让 spacer 总高度算少，滚动条比例失真、滚到底时还有内容
 * 没到；偏大则留空白。取 30。
 */
const OUTLINE_ROW_H = 30;
/** 量不到可视区高度时的兜底值（px） */
const OUTLINE_VIEWPORT_H = 200;

/**
 * 尾沿防抖，可带最大等待（maxWait）。
 *
 * 为什么保存必须带 maxWait：纯尾沿防抖每来一次改动就重置定时器，
 * 用户连续写几分钟、每笔间隔 <850ms 时**一次都不会落盘**——
 * 这时被系统杀掉/切 App 就丢内容。maxWait 保证「再忙也最多等这么久」。
 * 缩略图刷新不需要它（纯尾沿即可，重画越晚越好）。
 */
export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  wait: number,
  maxWait = 0
): T & { cancel: () => void } {
  let t: number | null = null;
  let firstAt = 0;
  const wrapped = ((...args: any[]) => {
    const now = Date.now();
    if (!firstAt) firstAt = now;
    if (t) window.clearTimeout(t);
    const fire = () => {
      t = null;
      firstAt = 0;
      fn(...args);
    };
    if (maxWait > 0 && now - firstAt >= maxWait) {
      fire();
      return;
    }
    t = window.setTimeout(fire, maxWait > 0 ? Math.min(wait, maxWait - (now - firstAt)) : wait);
  }) as T & { cancel: () => void };
  wrapped.cancel = () => {
    if (t) window.clearTimeout(t);
    t = null;
    firstAt = 0;
  };
  return wrapped;
}

/** 冲突副本的时间戳：yyyyMMdd-HHmm */
function conflictStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}`;
}

/**
 * 把导入时的异常翻译成用户能看懂的话（2026-11-07 修 INK-164）。
 *
 * pdf.js 抛的是英文原文，直接弹给用户就是
 * 「导入失败：No password given」/「Invalid PDF structure」——
 * 用户不知道该怎么办。这里按关键词映射成中文，认不出来的保留原文
 * （总比吞掉好，至少能贴给我排查）。
 */
export function describeImportError(e: any, kind?: "pdf" | "word"): string {
  const raw = String((e && e.message) || e || "").trim();
  const low = raw.toLowerCase();
  if (!raw) return "未知错误";
  /*
   * **Word 的错不走 PDF 的关键词映射**（2026-11-08）。
   *
   * 下面「加密 / 需要密码」那条是按 pdf.js 的措辞写的，但它匹配的是
   * 裸关键词 `encrypted` —— docx 是加密 zip（Word 的「用密码保护」）
   * 时，解压阶段抛的错里也带这个词，会被误映射成
   * 「这个 PDF 有密码」：用户导的明明是 Word，却被告知 PDF 有密码。
   *
   * 用**调用方传入的类型**判断，不靠猜错误文本 —— 错误消息里是否出现
   * ".docx" 完全看抛出点怎么写，不可靠。word.ts 抛的都是中文，原样透出
   * 已经足够清楚。
   */
  if (kind === "word") return raw;
  // 加密 / 需要密码
  if (
    low.includes("password") ||
    low.includes("encrypted") ||
    (e && e.name === "PasswordException")
  ) {
    return "这个 PDF 有密码，墨本打不开。请先用其他工具去掉密码再导入。";
  }
  // 结构损坏 / 不是 PDF
  if (
    low.includes("invalid pdf") ||
    low.includes("invalidpdf") ||
    low.includes("structure") ||
    (e && e.name === "InvalidPDFException")
  ) {
    return "文件损坏或不是有效的 PDF。";
  }
  // 缺少 PDF 头（常见于改了扩展名的文件）
  if (low.includes("missing pdf") || low.includes("missingpdf")) {
    return "这不是 PDF 文件（可能只是改了扩展名）。";
  }
  // 读取失败（文件被移动 / 权限 / 同步中）
  if (
    low.includes("unexpected server response") ||
    low.includes("failed to fetch") ||
    low.includes("network") ||
    low.includes("not found") ||
    low.includes("enoent") ||
    low.includes("no such file")
  ) {
    return "读不到这个文件。确认它还在库里、没有正在同步，然后重试。";
  }
  // 认不出来就保留原文（中文原样，英文也留着便于贴给我排查）
  return raw;
}

/**
 * 把导出时的异常翻译成用户能看懂的话（INK-176）。
 *
 * 导出写盘走的是 adapter，抛的是 Node/系统原文：
 * 「ENOSPC: no space left on device」/「EACCES: permission denied」——
 * 直接弹到平板上用户完全不知道该怎么办。这里照 describeImportError
 * 的样子按关键词映射，认不出来保留原文（便于贴回来排查）。
 *
 * 注意：ExportCancelledError 由 runExport 提前单独处理，不进这里。
 *
 * 导出给测试用：映射规则必须能被直接断言，而不是靠真机撞上 ENOSPC 才发现。
 */
export function describeExportError(e: any): string {
  const raw = String((e && e.message) || e || "").trim();
  const low = raw.toLowerCase();
  if (!raw) return "未知错误";
  // 空间不足（Node 的 ENOSPC / 浏览器的配额错误）
  if (
    low.includes("enospc") ||
    low.includes("no space") ||
    low.includes("quota") ||
    low.includes("out of memory") ||
    low.includes("storage full")
  ) {
    return "磁盘空间不足，导出的 PDF 没能写进去。清理一些空间后重试。";
  }
  // 权限 / 文件被占用
  if (
    low.includes("eacces") ||
    low.includes("eperm") ||
    low.includes("permission") ||
    low.includes("denied") ||
    low.includes("not allowed")
  ) {
    return "没有写入权限。换个保存位置，或检查这个文件夹的权限。";
  }
  // 目标文件 / 目录不存在（被移动、同步中、原 PDF 被删）
  if (
    low.includes("enoent") ||
    low.includes("not found") ||
    low.includes("no such file") ||
    low.includes("does not exist")
  ) {
    return "找不到目标文件或文件夹。确认它还在库里、没有正在同步，然后重试。";
  }
  // 认不出来就保留原文
  return raw;
}

export interface InkbookPluginLike {
  settings: InkbookSettings;
  saveSettings(): Promise<void>;
  refreshViews(): void;
  /** 关掉自动保存时收回已经排队的落盘（main.ts 实现；测试桩可不给） */
  cancelPendingSaves?: () => void;
  /** 打开某本 .inkbook 的指定页（main.ts 实现；测试桩可不给） */
  openBookAt?: (path: string, page: number, opts?: { newTab?: boolean }) => Promise<void>;
}

/**
 * 手感 / 粗细字段的合法区间，与设置页滑杆的 setLimits、侧栏粗细
 * range 的 min/max 一致。syncSettings 是运行时入口，拿到的值未必经过
 * loadSettings 校验（别的窗口同步、手工改 data.json、测试桩注入），
 * 所以在这里再兜一次，避免非法值直接落到 editor 上。
 */
function finiteSetting(v: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return fallback;
  const n = v as number;
  // 粗细类字段的下界 > 0：0 / 负数没有「笔尖」语义（旧代码用 `|| 默认值`
  // 兜的正是这个），按非法值回落，不要夹成 min 后画出一条几乎看不见的线。
  if (min > 0 && n <= 0) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** 校验「每种形状一份线宽」，任一形状缺失 / 非法就用 fallback 兜底。 */
function finiteShapeSizes(src: unknown, fallback: number): Record<ShapeKind, number> {
  const out: Record<ShapeKind, number> = {
    line: fallback,
    arrow: fallback,
    rect: fallback,
    ellipse: fallback,
  };
  if (src && typeof src === "object") {
    for (const k of Object.keys(out) as ShapeKind[]) {
      out[k] = finiteSetting((src as Record<string, unknown>)[k] as number, fallback, 1, 8);
    }
  }
  return out;
}

/**
 * 分段控件里的「滑动高亮片」。
 *
 * 以前选中态是把强调色直接铺在按钮自己身上，从钢笔切到橡皮时紫色底
 * 会整块「蹦」过去。这里改成容器里放一枚绝对定位的紫色玻璃片，选中项
 * 变化时用 transform 平移 + 宽高过渡滑到新按钮下面（像 iOS segmented
 * control 的指示器）。按钮自己选中时只保留「透明底 + 强调色文字」，
 * 高亮统一由这片提供，所以能连续滑动而不是瞬移。
 *
 * 只在**选中项变化**时播放滑动；首次布局 / 容器尺寸变化（窗口缩放、
 * 面板开合、桌面↔平板）直接瞬时对齐，免得从角落滑进来或跟着抖。
 * 尊重系统「减少动态效果」：开了就直接就位、不播滑动。
 */
class SlidePill {
  readonly host: HTMLElement;
  readonly el: HTMLElement;
  private ro: ResizeObserver | null = null;
  private shown = false;
  private raf = 0;
  /** 高亮片相对目标四周外扩的像素（色点玻璃框需要圈住圆点） */
  private readonly expand: number;
  /** 只认这些直接子元素里的 .is-active；null = 任意直接子元素 */
  private readonly activeSelector: string | null;
  /** true = 用 offset* 量（不受父级 scale 动画影响），false = 用 getBoundingClientRect */
  private readonly measureOffsets: boolean;

  constructor(
    host: HTMLElement,
    opts?: { className?: string; expand?: number; activeSelector?: string; measure?: "rect" | "offset" }
  ) {
    this.host = host;
    host.addClass("mb-slide-host");
    const el = document.createElement("span");
    el.className = "mb-slide-pill" + (opts?.className ? " " + opts.className : "");
    el.setAttribute("aria-hidden", "true");
    host.insertBefore(el, host.firstChild);
    this.el = el;
    this.expand = Math.max(0, opts?.expand ?? 0);
    this.activeSelector = opts?.activeSelector ?? null;
    this.measureOffsets = opts?.measure === "offset";
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.layout(true));
      this.ro.observe(host);
    }
  }

  destroy(): void {
    this.ro?.disconnect();
    this.ro = null;
    if (this.raf && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(this.raf);
    }
    this.raf = 0;
    this.el.remove();
  }

  /** 当前的 .is-active 直接子元素（跳过高亮片自己） */
  private activeChild(): HTMLElement | null {
    for (const node of Array.from(this.host.children)) {
      if (node === this.el) continue;
      if (this.activeSelector && !node.matches(this.activeSelector)) continue;
      if (node.classList.contains("is-active")) return node as HTMLElement;
    }
    return null;
  }

  private reducedMotion(): boolean {
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (_) {
      return false;
    }
  }

  /**
   * 对齐高亮片（排到下一帧）。
   * @param instant true = 不播滑动、直接就位（首次 / 尺寸变化 / 减少动态效果）
   */
  layout(instant = false): void {
    if (this.raf && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(this.raf);
    }
    if (typeof window.requestAnimationFrame === "function") {
      this.raf = window.requestAnimationFrame(() => {
        this.raf = 0;
        this.applyLayout(instant);
      });
    } else {
      this.raf = 0;
      this.applyLayout(instant);
    }
  }

  /**
   * **立刻**对齐高亮片（不排到下一帧）。
   *
   * 抽屉展开时宽度是瞬间给足的（.mb-pagedock-body 没有宽度动画、只做
   * translateX 滑入），layout() 却要等下一个 rAF 才量尺寸。那一帧画出来的
   * 就是收起期间按 min-content 量出的「只盖住半个『缩略图』」的紫框，
   * 再靠 0.30s 的 width 过渡长到全宽——用户说的「刚打开紫框只有一半、
   * 卡一下才加载好」。展开的同一个任务里同步量一次，第一帧就是全宽。
   */
  layoutNow(instant = false): void {
    if (this.raf && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(this.raf);
    }
    this.raf = 0;
    this.applyLayout(instant);
  }

  private applyLayout(instant: boolean): void {
    const active = this.activeChild();
    if (!active) {
      this.el.style.opacity = "0";
      this.shown = false;
      return;
    }
    const hr = this.host.getBoundingClientRect();
    const ar = active.getBoundingClientRect();
    // 容器或按钮被隐藏（面板收起 / 后台标签页 / 还没排版）→ 先藏起来
    if (ar.width <= 0 || ar.height <= 0 || hr.width <= 0) {
      this.el.style.opacity = "0";
      // 顺手清掉上次的宽高：收起期间别留一份「半宽」内联值，下次展开
      // 即使尺寸还没落定，也不会把半片紫框画出来。
      this.el.style.width = "0px";
      this.el.style.height = "0px";
      this.shown = false;
      return;
    }
    let left: number;
    let top: number;
    let width: number;
    let height: number;
    if (this.measureOffsets && active.offsetParent === this.host) {
      // offset* 不受祖先 transform: scale 影响，浮层出场动画期间也能量准
      left = active.offsetLeft;
      top = active.offsetTop;
      width = active.offsetWidth;
      height = active.offsetHeight;
    } else {
      left = ar.left - hr.left - this.host.clientLeft;
      top = ar.top - hr.top - this.host.clientTop;
      width = ar.width;
      height = ar.height;
    }
    const pad = this.expand;
    const doInstant = instant || !this.shown || this.reducedMotion();
    if (doInstant) this.el.style.transition = "none";
    this.el.style.width = width + pad * 2 + "px";
    this.el.style.height = height + pad * 2 + "px";
    this.el.style.transform = "translate(" + (left - pad) + "px," + (top - pad) + "px)";
    if (doInstant) {
      // 钉住即时位置：强制一次重排，之后的选中变化才走过渡
      void this.el.offsetWidth;
      this.el.style.transition = "";
    }
    this.el.style.opacity = "1";
    this.shown = true;
  }
}

export class InkbookView extends FileView {
  plugin: InkbookPluginLike;
  file: TFile | null = null;
  store: BookStore | null = null;
  editor: BookEditor | null = null;
  /**
   * 允许在没有绑定文件的情况下打开本视图（INK-210）。
   *
   * `FileView` 默认 false —— 宿主只允许「打开某个 .inkbook」时创建它。
   * 但 `onOpen` 里本来就无条件 `renderEmpty()`（画「新建手写本」/
   * 「导入文档开始」那个空状态），说明代码一直预期「无文件」是可能的；
   * 缺这一行导致用户**根本开不出一个空的墨本标签页**，
   * 「导入文档开始」这个入口永远够不着。
   */
  allowNoFile = true;

  private railSideBtn!: HTMLElement;
  /**
   * 顶栏上的「立即保存」按钮。
   *
   * 自动保存有 850ms 防抖：写完最后一笔想马上确认"已经存住了"时没有入口。
   * 按钮常驻在顶栏上，不用先展开侧栏。
   */
  private railSaveBtn!: HTMLElement;
  /** 顶栏上的「插入图片」按钮（null 只在极老宿主里可能出现） */
  private railImageBtn: HTMLElement | null = null;
  /** 顶栏上的「插入文件块」按钮（Excalidraw / 笔记 / 文本） */
  private railFileBlockBtn: HTMLElement | null = null;
  /** 顶栏上的「在当前笔记中查找」按钮 */
  private railFindBtn: HTMLElement | null = null;
  private floatEl!: HTMLElement;
  private floatZoomEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private editorHost!: HTMLElement;
  private paperHost!: HTMLElement;
  private sideEl!: HTMLElement;
  /** 侧栏顶部的文件名标题（点它可内联重命名笔记文件） */
  private sideTitleEl: HTMLElement | null = null;
  private dynEl!: HTMLElement;
  /**
   * 侧栏「−/＋」步进按钮的停手句柄。
   *
   * `renderDynamicTools` 每次都会整体重建 `.mb-dyn`（`setTextSize` 也会
   * 触发重建），旧按钮的 pointerup 等不到 → 按住中的 timer 会一路跑到底。
   * 重建前调用这些句柄把旧的停掉。
   */
  private dynStepStoppers: Array<() => void> = [];
  /**
   * 上次建工具区用的结构签名。相同则只刷数值、不重建 DOM ——
   * 这样按住字号步进连调时，按钮不会被换掉、连调不会断。
   */
  private dynToolsSig = "";
  private pageLbl!: HTMLElement;
  /** 底部页码点开后的「点页码直接跳」浮层；存关闭函数便于收起 */
  private closePagePicker: (() => void) | null = null;
  /** 顶栏那一行：8 支笔 + 保存/侧栏，全部挤在标题栏同一行 */
  private topRowEl: HTMLElement | null = null;
  /** 顶栏里的工具组 */
  private topToolsEl: HTMLElement | null = null;
  /** 标题栏里原本挂 action 的那个容器（放不下时把整行搬回来用） */
  private actionsHostEl: HTMLElement | null = null;
  /** 放不下时，整行搬进视图自己画的这条顶栏条 */
  private topBarEl: HTMLElement | null = null;
  /**
   * 「笔记内查找」浮条。
   *
   * 挂在 `.mb-paper` 里（它自己 position:relative），右上角浮在纸面上，
   * 仿 Obsidian 文件内搜索那条；不进 `document.body`，免得切标签后残留。
   */
  private findBarEl: HTMLElement | null = null;
  private findInputEl: HTMLInputElement | null = null;
  private findCountEl: HTMLElement | null = null;
  /** 本次查找的全部命中 + 当前第几条（0 起）；null = 查找框没开 */
  private findState: { query: string; matches: FindMatch[]; index: number } | null = null;
  /** 输入防抖：几百页 PDF 本子里逐字重扫全文，不防抖会卡输入 */
  private findTimer = 0;
  /**
   * 从 `obsidian://inkbook?page=N` 跳进来时，编辑器还没建好就先记下来，
   * mountEditor 之后再滚过去。
   */
  private pendingPage: number | null = null;
  /** pendingPage 落到的那一页要不要带落点提示（跟随 jumpHint 设置） */
  private pendingPageHint = false;
  /** 文字索引的去抖定时器（保存后 1s 写一次，避免连续保存反复重写） */
  private indexTimer = 0;
  /**
   * 还没进索引的内容（文件 + 那时的书内容）。
   *
   * 为什么要单独记一份：以前「立刻写索引」是靠 `indexTimer` 非零来判断
   * 「有东西要写」。但定时器会被 `destroyEditor()` 清掉（切文件 / 关标签页），
   * 一旦清完，`indexTimer` 归零，看起来就像「没有待写的内容」——
   * 正好把「刚导入的 PDF 原文」这一批内容漏掉，用户看到的就是
   * 「PDF 导进来了，可一个字都搜不到」。
   *
   * 存下**文件与内容快照**还有一个好处：切文件以后再冲，也不会把
   * 新本子的内容写进旧本子的索引（或反过来）。
   */
  private indexPending: { file: TFile; book: InkBook } | null = null;
  /** 侧边可拖动滑条（替代系统滚动条，手指也抓得住） */
  private sbEl: HTMLElement | null = null;
  private sbTrack: HTMLElement | null = null;
  private sbThumb: HTMLElement | null = null;
  private sbTip: HTMLElement | null = null;
  private sbAbort: AbortController | null = null;
  private sbRaf = 0;
  /** 本帧里有没有真的滚动事件（区别于打开/resize/updateUI 的布局同步） */
  private sbWoke = false;
  /**
   * 挂载后的头两帧：编辑器会用 goToPage 做程序化定位（恢复上次阅读页），
   * 那也会派发 scroll 事件，但不是用户滑动，别把滑块闪出来。
   */
  private sbQuiet = false;
  /** 防止快速重建时旧的 rAF 把新挂载的静默期提前清掉 */
  private sbQuietSeq = 0;
  /** 停手后让滑块淡出的定时器（滚动停下 / 拖动松手都走它） */
  private sbHideTimer = 0;
  private sbThumbH = 0;
  private sbThumbTop = 0;
  private sbDrag: { pid: number; grab: number } | null = null;
  private zoomLbl!: HTMLElement;
  private statusEl!: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  /** 右下浮标里的撤销 / 重做（常驻，不依赖侧栏是否展开） */
  private floatUndoBtn: HTMLButtonElement | null = null;
  private floatRedoBtn: HTMLButtonElement | null = null;
  /** 面板滑入动画的收尾定时器（按元素存，连续开合只留最后一个） */
  private slideTimers = new WeakMap<HTMLElement, number>();
  private toolButtons = new Map<ToolId, HTMLButtonElement>();
  /** 工具行选中态的滑动高亮片（见 SlidePill） */
  private toolPill: SlidePill | null = null;
  /** 上次对齐工具高亮片时的工具，用来只在工具变化时重排一次，落笔高频 updateUI 不重排 */
  private slideToolSig: ToolId | null = null;
  /** 「缩略图 / 目录 / 收藏」标签的滑动高亮片 */
  private sidePill: SlidePill | null = null;
  /** 「每行几张」1/2/3/4 的滑动高亮片 */
  private thumbColsPill: SlidePill | null = null;
  /** 收藏面板「每行几张」1/2/3/4 的滑动高亮片 */
  private favoriteColsPill: SlidePill | null = null;
  /** 收藏面板里的缩略图 canvas（与页列表窗口的 thumbCanvases 分开记） */
  private favoriteThumbCanvases = new Map<number, HTMLCanvasElement>();
  /** 收藏列表 / 当前页按钮的上次签名，避免每次落笔重建 DOM */
  private favoriteListSig = "";
  private favoriteBtnSig = "";
  /** 缩略图小星标上次同步时的收藏版本号（只在收藏变化时刷，落笔高频 updateUI 不刷） */
  private thumbFavRev = -1;
  /** 收藏页缩略图补画合并到下一帧 */
  private favoritePaintRaf = 0;
  /** 各颜色点行里的玻璃框（快捷笔盒 / 文字弹层 / 侧栏文字/形状色板） */
  private colorPills: SlidePill[] = [];
  /** 弹层里「细/中/粗 · 字号 · 形状种类」这类分段控件的滑动高亮片 */
  private segPills: SlidePill[] = [];
  /**
   * 顶栏笔按钮二次点击弹出的快捷笔盒（.mb-pen-pop）。
   *
   * 挂在 document.body + position:fixed：顶栏在标题栏里，祖先可能有
   * overflow/transform，绝对定位会被裁；fixed 不受影响，平板竖屏也能
   * 贴着按钮左右夹住不越界（见 positionPenPop）。
   */
  private penPopEl: HTMLElement | null = null;
  /** 当前浮层挂在哪枚按钮上；再点同一枚按钮即收起 */
  private penPopAnchorEl: HTMLElement | null = null;
  /**
   * 当前浮层画的是哪支笔 / 哪个形状的粗细。
   *
   * 用来把「读哪份粗细、写回哪份默认值」钉在浮层打开的这支笔上，
   * 而不是跟着 editor.tool 走（钢笔、圆珠笔各有各的粗细，浮层打开期间
   * 也可能被外部改工具）。形状统一记作 "shape"，具体读 shapeKind 对应的那份。
   */
  private penPopTool: ToolId | null = null;
  /** 浮层打开期间挂上的 document/window 监听，关闭时逐个摘掉 */
  private penPopDetach: Array<() => void> = [];
  /** 出场动画结束后摘掉临时类用的定时器（避免动画残留 transform） */
  private penPopAnimTimer = 0;
  /** 收起动画期间仍留在 DOM 的浮层（动画结束再移除），以及它的兜底定时器 */
  private penPopClosingEl: HTMLElement | null = null;
  private penPopCloseTimer = 0;
  private sideBtn!: HTMLElement;
  /** 顶栏上的「页面/目录（缩略图）抽屉」开关：和钢笔同一排，仿原生 PDF 阅读器 */
  private dockBtn: HTMLElement | null = null;
  private layerListEl: HTMLElement | null = null;
  private pageListEl: HTMLElement | null = null;
  /**
   * 侧栏「目录」区的条目容器。
   *
   * 目录项可以很多（用户在一个 857 页的本子里手写几十条目录很正常），
   * 所以这里**不**一次建几千个 DOM：
   *   · 目录区有自己的滚动容器，超出可视区的条目不建；
   *   · 只在内容真的变了（store.outlineRev 变了）才重建，
   *     落笔时 updateUI 会跑几十次，但目录不变 → 一次 DOM 都不动。
   */
  private outlineListEl: HTMLElement | null = null;
  /** 目录区的滚动容器（窗口化用） */
  private outlineViewportEl: HTMLElement | null = null;
  /** 上次建目录时用的 store.outlineRev（内容变了才重建） */
  private outlineRev = -1;
  /** 目录窗口：已建的条目区间 [lo, hi) */
  private outlineWinLo = 0;
  private outlineWinHi = 0;
  /** 量到的条目行高（量一次就够，别每次滚动都 reflow 一遍） */
  private outlineRowH = 0;
  private templateGrid: HTMLElement | null = null;
  private paperRow: HTMLElement | null = null;
  private statsEl: HTMLElement | null = null;
  /**
   * 页序号 → 缩略图 canvas。
   *
   * **键是页号，不是数组下标**：窗口化后只有可视区附近的页有 DOM，
   * 锚点必须是页号，否则滚动后整个列表的页号会错位
   * （drawThumbRange / onThumbNeedsRedraw 都按页号取）。
   */
  private thumbCanvases = new Map<number, HTMLCanvasElement>();
  /** 缩略图懒渲染：滚进视口才画，避免几百页时卡顿 */
  private thumbObserver: IntersectionObserver | null = null;
  private templateCards = new Map<TemplateId, HTMLElement>();
  private paperChips = new Map<PaperId, HTMLElement>();
  private layerSig = "";
  private pageCountSig = -1;
  /**
   * 上次建页列表时的页顺序版本（store.pageOrderRev）。
   * 上移/下移不改页数，只比 pageCount 会让侧栏停留在旧顺序上。
   */
  private pageOrderRev = -1;
  /** 页序长按菜单（同一时刻只允许一个） */
  private thumbMenuEl: HTMLElement | null = null;
  private thumbMenuOwner: HTMLElement | null = null;
  private thumbMenuAbort: AbortController | null = null;
  /** 长按计时器：450ms 内没抬手/没滚动才弹菜单 */
  private thumbPressTimer = 0;
  private thumbPressItem: HTMLElement | null = null;
  private thumbPressId = -1;
  private thumbPressX = 0;
  private thumbPressY = 0;
  /** 计时器已开、菜单已弹后手指仍按着：移动超阈值就承接到拖拽 */
  private thumbPressDown = false;
  /** 长按期的 document 级 pointermove 监听（菜单弹前判滚动 / 弹后转拖拽） */
  private thumbPressMoveAbort: AbortController | null = null;
  /** 拖拽进行中（菜单已关，松手/取消才结束） */
  private thumbDragActive = false;
  private thumbDragItem: HTMLElement | null = null;
  private thumbDragPointerId = -1;
  private thumbDragFromIndex = -1;
  /** 抓取偏移：image 保持在同一相对位置，拖起来不会跳 */
  private thumbDragGrabDX = 0;
  private thumbDragGrabDY = 0;
  private thumbDragPointerY = 0;
  private thumbDragBefore = false;
  private thumbDragTargetIndex = -1;
  /** movePage 要的「最终下标」（0 起），算出后松手才调用 */
  private thumbDragInsertPos = -1;
  /**
   * 松手自带的 click 屏蔽位：拖完那一下不能顺手翻页。
   *
   * 必须**按页 id 命中**（`thumbDragClickGuardId`），不能只用一个全局布尔：
   * 触屏 pointerup 的落点可能偏到相邻条目，全局布尔会把别的条目的正常
   * 点击也吞掉一次。空 id = 没有待挡的点击。
   */
  private thumbDragClickGuard = false;
  private thumbDragClickGuardId = "";
  private thumbDragGhost: HTMLElement | null = null;
  /** 落点指示（紫色竖条） */
  private thumbDragIndicator: HTMLElement | null = null;
  /** 竖条的实测宽度（CSS 里定的 3~4px）：定位时用它把条压在目标边缘上 */
  private thumbDropBarW = 3;
  private thumbDragDocAbort: AbortController | null = null;
  /**
   * 触屏防抢手势：在 document 上挡 touchmove。
   *
   * touch-action 在手势开始时就定型，中途改 CSS 没用；这里用非 passive 的
   * touchmove 监听，**仅当拖拽已启**时 preventDefault，让浏览器不把这次移动
   * 判成侧栏滚动（否则会 pointcancel 把拖拽掐掉）。平时手指一移动浏览器正常
   * 竖滚侧栏，不受影响（监听挂在 document，只在拖拽态吞掉默认动作）。
   */
  private thumbTouchGuardAbort: AbortController | null = null;
  /**
   * 侧栏页列表窗口化（`.mb-pages` 网格）。
   *
   * 侧栏展开时不再给 857 页各建一个条目，只建「可视行 ± overscan」，
   * 滚出视口的行随窗口一起回收。未建的行用上下两个整行 spacer 撑高度，
   * 保证滚动条长度不变、跳转位置不漂。
   */
  private pageListViewportEl: HTMLElement | null = null;
  /** 重建侧栏时取消旧滚动监听（旧节点随后就被丢弃） */
  private pageListAbort: AbortController | null = null;
  private pageListResizeObs: ResizeObserver | null = null;
  /** 窗口刷新已排进下一帧（scroll 每帧只算一次） */
  private pageListRaf = 0;
  /** 当前已建窗口按「行」记（不是页）：[pageWinRowLo, pageWinRowHi) */
  private pageWinRowLo = -1;
  private pageWinRowHi = -1;
  /** 建窗口时用的行高 / 列数；侧栏宽度变化时与实时测量对比后重算 */
  private pageWinRowH = 0;
  private pageWinCols = 0;
  /**
   * 当前窗口内的条目：页号 → `.mb-thumb` 元素。
   *
   * 滚动跨行时窗口按页号**增量**进出：还在窗口里的页 DOM 保持不动
   * （同一个 canvas 对象、像素不丢），只给新进入的页补条目、回收离开的页。
   * 这是「缩略图一闪一闪」的修法——旧实现每跨一行 `list.empty()` 整屏重建，
   * 旧 canvas 被摘下、新 canvas 还没画完，中间必然空一帧。
   */
  private thumbItems = new Map<number, HTMLElement>();
  /**
   * 滚出窗口的条目回收池：页号 → 元素。
   *
   * 回收时只把元素移出 DOM，**不重置 canvas.width/height**，像素原样保留；
   * 滚回来直接插回列表。池满时按回收先后淘汰最旧的（像素同时由
   * editor 的 thumbShots LRU 持有副本，淘汰后最多多一次 blit）。
   */
  private thumbItemPool = new Map<number, HTMLElement>();
  /** 窗口末尾的「加一页」格子（没有页号，单独记；不进复用池） */
  private addThumbEl: HTMLElement | null = null;
  /** 上下整行 spacer；增量更新时只改高度，不重建 */
  private pageTopPadEl: HTMLElement | null = null;
  private pageBottomPadEl: HTMLElement | null = null;
  /**
   * 当前高亮的缩略图条目。
   *
   * 只切换「旧的 / 新的」两个元素，不要每次状态变化都
   * querySelectorAll(".mb-thumb") 扫全列表——857 页的本子每次抬笔
   * 都要扫一遍，打开时也会连着扫好几次。
   */
  private activeThumbEl: HTMLElement | null = null;
  private templatePaperSig = "";

  /** 平板模式：底部浮动工具条 + 大按钮 */
  private tabletMode = false;
  /**
   * 侧栏是否展开。
   *
   * 侧栏是**所有工具的家**：笔盒、编辑、导入导出、图层、页面……
   * 竖长条上有一枚「侧栏」按钮专门开关它。
   */
  private sideShown = false;
  /**
   * 侧栏下方「缩略图 / 目录 / 收藏」当前显示哪一页。
   *
   * 三个面板共用一个标签区（像 Obsidian 原生 PDF 阅读器的缩略图栏），
   * 同一时间只显示一个；没显示的那个保留自己的滚动容器和窗口化状态，
   * 切回来时只需按新尺寸重算窗口，不用重建 DOM。
   */
  private sideTab: "thumbs" | "outlines" | "favorites" = "thumbs";
  /** 三个标签页容器（buildPageDock 里建，切换时切 is-hidden） */
  private sideThumbPane: HTMLElement | null = null;
  private sideOutlinePane: HTMLElement | null = null;
  private sideFavoritePane: HTMLElement | null = null;
  /** 收藏面板：列表 / 空状态 / 「收藏当前页」按钮 */
  private favoriteListEl: HTMLElement | null = null;
  private favoriteEmptyEl: HTMLElement | null = null;
  private favoriteCurrentBtn: HTMLButtonElement | null = null;
  private favoriteCurrentLabel: HTMLElement | null = null;
  private sideTabBtns: HTMLButtonElement[] = [];
  /** 「每行几张」按钮（buildPageDock 里建，切列数时更新选中态） */
  private thumbColsBtns: Array<[number, HTMLButtonElement]> = [];
  /** 收藏面板「每行几张」按钮（1/2/3/4） */
  private favoriteColsBtns: Array<[number, HTMLButtonElement]> = [];
  /** 左侧「页面」抽屉（缩略图 + 目录），像 Obsidian 原生 PDF 阅读器 */
  private pagedockEl: HTMLElement | null = null;
  private pagedockBodyEl: HTMLElement | null = null;
  private pagedockHandleEl: HTMLButtonElement | null = null;
  /** 抽屉是否展开。默认收起，只留左上角一个按钮 */
  private pagedockOpen = false;
  /** 三个面板的容器（缩略图侧边滑动条挂这上面，避免跟着内容滚） */
  private sidePanesEl: HTMLElement | null = null;
  /** 缩略图面板右缘的自绘滑动条（拖不动系统条时的替代，和纸面那条同款） */
  private thumbSbEl: HTMLElement | null = null;
  private thumbSbTrack: HTMLElement | null = null;
  private thumbSbThumb: HTMLElement | null = null;
  private thumbSbThumbH = 0;
  private thumbSbDrag: { pid: number; grab: number } | null = null;
  private thumbSbHideTimer = 0;
  private thumbSbAbort: AbortController | null = null;
  /** 缩放指示器：缩放时才浮现，2.6 秒后自己退回去 */
  private zoomHintTimer = 0;
  /** 缩放指示器是否被指针悬停（悬停时不自动隐藏） */
  private zoomHintHover = false;
  /** 上一次的缩放值，用来判断"这次状态变化是不是缩放引起的" */
  private lastZoom = -1;
  private touchBtn!: HTMLButtonElement;
  /*
   * 侧栏「演示」区（激光笔，经典手写应用移植）。
   * 全局开关，和当前工具无关，放独立静态区；选中态由 syncAuxControls() 统一刷
   * （工具切换、快捷键、设置页改动都会走到 updateUI）。
   */
  private laserBtn?: HTMLButtonElement;
  private dirty = false;
  /**
   * 「内容变脏」代次：markDirty 一次加一。
   *
   * 保存要跨好几个 await（指纹、备份、tmp 写入）。期间用户可能又落了一笔，
   * 而这一笔**不在已经 stringify 出去的那版 JSON 里**。只有 dirty 布尔的话，
   * 保存成功时会把这一笔的脏标记一起清掉，它就悄悄等不到下一次落盘。
   * 保存结束对比代次：变了 = 存完再排一次。
   */
  private dirtyEpoch = 0;
  /** 元数据（activePage）代次，用途同 dirtyEpoch；翻页本身不触发整本写盘 */
  private metaEpoch = 0;
  /**
   * 自动保存开始避让书写的时刻（0 = 当前没在避让）。
   *
   * 只用来算 10s 硬上限：如果手势因为事件丢失卡在 "draw"（pointerup 永远不来），
   * 不能一直「等抬笔」——上限一到就强制存一次，宁可让这一笔卡一下，
   * 也不能让整本书永远不落盘（INK-129 的教训）。
   */
  private inkDeferAt = 0;
  /** 硬上限的唤醒定时器 */
  private inkDeferRetry = 0;
  /** 只有翻页/切页这类「没动笔迹的改动」变脏，单独一个标记，避免整本写盘 */
  private metaDirty = false;
  /** 上次成功写盘时文件在磁盘上的指纹；null = 拿不到指纹，不做冲突检测 */
  private fp: FileFingerprint | null = null;
  /**
   * 上次读到 / 写入的**正文字节**的内容哈希（见 storage.hashText）。
   *
   * 指纹（mtime + size）只能说明「文件被动过」，分不清是「有别的程序真改了内容」
   * 还是「同步盘把同一份文件重写/摸了一下」。同步客户端下载、校验、回写时常常只
   * 更新 mtime、字节一个不变；只看指纹就会把这种情况误判成外部改动，反复生成
   * `-disk-` / `-mine-` 副本并停写主文件（用户原话：一写字就说同步失败、还多出
   * 备份文件）。所以指纹对不上时再比一次内容哈希：与基线一致就当作「没动过」，
   * 收下新指纹照常保存；只有内容真的变了才走冲突副本。
   *
   * null = 还没有基线（打开失败 / 只读恢复 / 刚改名），此时退回旧的保守判定。
   */
  private diskHash: string | null = null;
  /**
   * 磁盘上「已读/已写」版本的实质内容签名（pages + outlines）。
   * 同步盘/另一台设备只改时间/当前页等元数据时，用它判断正文其实没变，
   * 避免误判冲突并反复生成副本。
   */
  private diskContentSig: string | null = null;
  /** 上次成功写盘时的 activePage，用来看"翻页后到底要不要写一次" */
  private savedActivePage = -1;
  /**
   * 上次成功写盘时的视图状态（zoom / scrollTop / scrollLeft），用途同
   * savedActivePage：只缩放或只滚动时也要在关文件时落一次，但**不能**
   * 每次滚动都写整本。
   * `savedZoom === undefined` 表示上次落盘时是 fit 模式（字段没写）。
   */
  private savedZoom: number | undefined;
  private savedScrollTop: number | undefined;
  /** 水平基线：放大后向右滚过才非 0，见 types.ts 的 scrollLeft */
  private savedScrollLeft: number | undefined;
  /** 检测到外部改动后置真：此后不再写主文件，等用户自己处理两份副本 */
  private conflict = false;
  /** 只读态的"改动不会保存"提示是否已经弹过（每本书一次，别刷屏） */
  private readOnlyNoticeShown = false;
  /** 是否正在装配视图（装配期的 markDirty 不算用户操作） */
  private assembling = false;
  /** 只读恢复时另存出来的副本**文件名**；有它才能告诉用户"改用那份" */
  private recoveredCopyName: string | null = null;
  private saving = false;
  private saveAgain = false;
  /**
   * 正在跑的那一次写盘。
   *
   * `saving` 只是个布尔，`flushSave` 的 `await saveNow()` 在「已经有一次
   * 保存在写」时以前会立刻返回——切本子时上一本的写盘还在飞，新一本的
   * 数据就被写进了旧文件（INK-167）。有这条 promise，显式路径才能真正等到写完。
   */
  private savePromise: Promise<void> | null = null;
  /** 上一次写盘的失败原因（null = 上次成功）；切文件时据此判断要不要抢救内容 */
  private lastSaveError: string | null = null;
  /**
   * 这本书的未落盘内容是否已经抢救过。
   *
   * `onUnloadFile` 抢救完把 store 清掉、`onClose` 再走一遍时，
   * `dirty` 还挂着（这是事实：主文件确实没更新），会被再抢救一次，
   * 每关一次标签就多一份副本。用这个标志保证「一本书只抢救一次」。
   */
  private rescued = false;
  /**
   * 当前 `store` 里这本书对应的磁盘路径。
   *
   * `this.file` 归宿主管（切文件时它先变成新路径，之后才轮到我们读盘），
   * 而 `store` 还是上一本的——两者错位时**绝不能写盘**，
   * 否则就是「A 的内容写进 B 的文件」。saveNow 用它做最后一道校验。
   */
  private bookPath: string | null = null;
  /** 导出进行中：重复点导出只提示，不并发跑第二份（大本会双倍吃内存） */
  private exporting = false;
  private readOnly = false;
  /**
   * 只读的原因：
   *   · duplicate —— 同一本已在另一个标签页打开（INK-172，避免两边互相覆盖）
   *   · recovered —— 正文读不出来，只读打开的是 .bak 备份
   *
   * 只影响提示措辞（warnReadOnly），不参与写盘判定——那个看 `readOnly`。
   */
  private readOnlyReason: "duplicate" | "recovered" | null = null;
  private saveState: "saved" | "dirty" | "saving" = "saved";
  /** 打开中的占位（见 showLoading）；没有占位时是 null */
  private loadingEl: HTMLElement | null = null;
  private _loadToken = 0;
  // 连写一整页时每笔都重置 850ms 尾沿，必须有个最大等待兜底（10s）。
  // 到点后走 runAutoSave：正在落笔的话会先避让，抬手后再排。
  private saveDebounce = debounce(() => this.runAutoSave(), 850, 10_000);
  private thumbDebounce = debounce(() => this.refreshThumbs(), 320);

  constructor(leaf: any, plugin: InkbookPluginLike) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file ? this.file.basename : "墨本";
  }

  getIcon(): string {
    return "notebook";
  }

  canAcceptExtension(ext: string): boolean {
    return ext === "inkbook";
  }

  async onOpen(): Promise<void> {
    this.buildUI();
    this.renderEmpty();
    this.registerDomEvent(document, "keydown", (e) => this.onKeyDown(e));
    // Ctrl/⌘+F 在捕获期就接管，别被宿主的全局搜索抢走（详见 onFindHotkeyCapture）
    this.registerDomEvent(document, "keydown", (e) => this.onFindHotkeyCapture(e), true);
    this.registerDomEvent(window, "resize", () => this.scheduleTopRowFit());
    /*
     * 平板交互：缩略图抽屉 / 右侧栏打开后，点它们以外的地方自动收起
     * （像 Obsidian 原生 PDF 阅读器，点一下文档就把侧边栏收起来）。
     * 用 pointerdown 捕获：手指按下即收，抬起来时不会误触被点到的元素。
     */
    this.registerDomEvent(
      document,
      "pointerdown",
      (e) => this.onGlobalPointerDown(e),
      true
    );
    /*
     * 切到后台 / 关页面前把没落盘的内容冲掉。
     *
     * 平板上被系统回收、或用户直接切去别的应用时，onClose 不一定来得及跑；
     * 这时 850ms 尾沿防抖里还压着最后几笔。flushSave 会把它们写完
     * （saveNow 自带并发保护，重复调用安全）。
     */
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        /*
         * 先把编辑框里的文字提交（打完字没按回车就切 App 的那一段），
         * 再把正在画的一笔收尾（commitDraft 提交成正式笔迹），最后强制落盘。
         * 顺序不能反：flushSave 只写已提交内容，文字还在 textarea 里、
         * 半笔还躺在 draft 里的话，这次切后台就全丢了。
         * force：可能直接进后台被系统回收，等不到 compositionend，
         * 组字中只写已上屏部分（不写半截拼音）。
         * editor 自己也监听 visibilitychange，这里是提前、确定性的那一次
         * （重复调用是安全的空操作）。
         */
        this.editor?.commitTextEditNow(true);
        this.editor?.finishInkGesture();
        void this.flushSave();
      }
    });
    this.registerDomEvent(window, "pagehide", () => {
      // 页面即将卸载：输入框里的字必须在 DOM 被回收前提交出来
      this.editor?.commitTextEditNow(true);
      this.editor?.finishInkGesture();
      void this.flushSave();
    });
  }

  async onClose(): Promise<void> {
    // 浮层挂在 document.body 上，视图关了它不会自己消失，先摘干净
    this.closePenPop();
    for (const pill of this.colorPills) pill.destroy();
    this.colorPills = [];
    for (const pill of this.segPills) pill.destroy();
    this.segPills = [];
    this.syncActivePage();
    const ok = await this.flushSave();
    // 关窗时写不进去：至少把内容另存出来，别跟着视图一起消失
    if (!ok) await this.rescueUnsaved(this.lastSaveError || "未知原因");
    // 冲突还没解决就关窗：内存里的内容必须落到磁盘上，不能静默丢
    await this.preserveConflictCopy();
    this.destroyEditor();
  }

  /**
   * 文件被改名 / 移动（宿主只改 file 路径，**不重载视图**）。
   *
   * 必须在这里把 `bookPath` 跟上，否则它永远停在旧路径上：
   * `saveNow` 优先用 `bookPath` 写盘（那是 INK-167 防串写的手段），
   * 于是改名后每次保存都在**旧路径重新造一个文件**，新名字的文件
   * 一直停在改名前的版本——用户看到「已保存」，关掉重开就少了后半段
   * （INK-174 复查发现的回归，`bookPath` 是 INK-167 引入的）。
   *
   * 顺序：先把在途保存等完（它捕获的是旧路径、写的是改名前的正确内容，
   * 不用打断），再换路径、清指纹——新路径的 mtime/size 与旧记录无关，
   * 不清会把改名后的第一次保存误判成「外部改动」。
   *
   * 索引不用管：`main.ts` 的 vault rename 事件负责删旧目录 + 重建。
   */
  async onRename(file: TFile): Promise<void> {
    if (this.savePromise) {
      try {
        await this.savePromise;
      } catch (_) {
        /* 失败原因已经记进 lastSaveError */
      }
    }
    this.file = file;
    this.bookPath = file.path;
    this.fp = null;
    // 改名不改内容，但新路径的基线要重新建立；先清掉，等下一次读/写再设
    this.diskHash = null;
    this.diskContentSig = null;
  }

  /**
   * 本子改名时，`main.ts` 把它的数据叶子整体搬到了新 token 目录，
   * 这里同步改写打开中的这份内存副本里的底图/原件引用，并标脏。
   *
   * 不这么做的话，界面仍指向已搬走的旧路径（当场翻页底图丢失），
   * 而且下一次自动保存会把旧引用又写回磁盘。
   */
  remapBookAssetDir(oldDir: string, newDir: string): void {
    if (!this.store) return;
    if (remapAssetPrefix(this.store.data, oldDir, newDir)) this.markDirty();
  }

  /* ------------------------------- 文件 ------------------------------- */

  /**
   * 把编辑器当前的页码同步回内存里的书，并判断这次翻页是否需要写盘。
   *
   * 只在页码**与上次写盘时不同**才置 metaDirty —— 打开看一眼、
   * 一页没翻就关掉，不该产生任何写盘。
   */
  private syncActivePage(): void {
    if (!this.store || !this.editor) return;
    this.store.data.activePage = this.editor.getState().pageIndex;
    if (this.savedActivePage !== this.store.data.activePage) {
      this.metaDirty = true;
      this.metaEpoch += 1;
    }
    /*
     * 缩放 / 页内滚动位置同样是「打开看一眼就可能变」的元数据：
     * 只标 metaDirty，等关文件 / 切文件时随下一次写盘落一次，
     * 绝不在这里排整本保存（和翻页同一套机制，见本方法开头）。
     *
     * 比较对象必须是「将要写进文件的形态」——fit 模式下 zoom 根本不落盘，
     * 所以拿 undefined 去比，不能拿 applyLayout 算出来的 this.zoom 比：
     * 否则打开一本没手动缩放过的本子、什么都不动直接关，也会白写一次整本。
     * scrollTop / scrollLeft 有滚动取整 / 亚像素抖动，留 2px 容差。
     */
    const zoom = this.editor.fitMode ? undefined : this.editor.zoom;
    // getScrollTop / getScrollLeft 把「还没落下去的恢复值」也算进来：
    // 隐藏标签页 / 折叠面板里关闭文件时，不能把待恢复的位置误判成 0
    // 再写回磁盘
    const rawTop = this.editor.getScrollTop();
    const scrollTop = rawTop > 0 ? rawTop : undefined;
    const rawLeft = this.editor.getScrollLeft();
    const scrollLeft = rawLeft > 0 ? rawLeft : undefined;
    const zoomChanged =
      zoom === undefined
        ? this.savedZoom !== undefined
        : this.savedZoom === undefined || Math.abs(zoom - this.savedZoom) > 1e-6;
    const topChanged =
      scrollTop === undefined
        ? this.savedScrollTop !== undefined
        : this.savedScrollTop === undefined || Math.abs(scrollTop - this.savedScrollTop) > 2;
    // 水平必须单独比较：只向右滚、纵向没动时，不判它就不会标脏，
    // 关文件时这次水平位移根本不会写进文件（INK-209）
    const leftChanged =
      scrollLeft === undefined
        ? this.savedScrollLeft !== undefined
        : this.savedScrollLeft === undefined ||
          Math.abs(scrollLeft - this.savedScrollLeft) > 2;
    if (zoomChanged || topChanged || leftChanged) {
      this.metaDirty = true;
      this.metaEpoch += 1;
    }
  }

  /**
   * 把编辑器当前的视图状态写进 book（只改内存对象，落盘交给 writeBook）。
   *
   * fit 模式下刻意 `delete book.zoom`：fit 的比例是窗口算出来的，
   * 不是用户的选择，存下来下次会被旧窗口尺寸锁死（平板上转个方向就错位）。
   * scrollTop / scrollLeft 两种模式都存——至少回到上次的位置附近。
   * 值缺省时删字段而不是写 0/undefined：老文件、停在页首或页左边时
   * 不产生多余字段。
   */
  private captureViewState(book: InkBook): {
    zoom: number | undefined;
    scrollTop: number | undefined;
    scrollLeft: number | undefined;
  } {
    const ed = this.editor;
    if (!ed) {
      return {
        zoom: this.savedZoom,
        scrollTop: this.savedScrollTop,
        scrollLeft: this.savedScrollLeft,
      };
    }
    const zoom = !ed.fitMode && Number.isFinite(ed.zoom) ? ed.zoom : undefined;
    const rawTop = ed.getScrollTop();
    const scrollTop = Number.isFinite(rawTop) && rawTop > 0 ? rawTop : undefined;
    // 没放大时纸是居中的，scrollLeft 恒为 0 → 不写字段（见 types.ts）
    const rawLeft = ed.getScrollLeft();
    const scrollLeft = Number.isFinite(rawLeft) && rawLeft > 0 ? rawLeft : undefined;
    if (zoom === undefined) delete book.zoom;
    else book.zoom = zoom;
    if (scrollTop === undefined) delete book.scrollTop;
    else book.scrollTop = scrollTop;
    if (scrollLeft === undefined) delete book.scrollLeft;
    else book.scrollLeft = scrollLeft;
    return { zoom, scrollTop, scrollLeft };
  }

  /** 装载一本书（首次读成功、以及从备份恢复时共用） */
  private openBook(
    book: InkBook,
    readOnly: boolean,
    readOnlyReason: "duplicate" | "recovered" | null = readOnly ? "recovered" : null
  ): void {
    this.store = new BookStore(book);
    /*
     * 换书时强制重建收藏列表：两本书可能页数、favoriteRev 都刚好相同，
     * 只比签名会把上一本的收藏页当成这一本的。
     */
    this.favoriteListSig = "";
    this.favoriteBtnSig = "";
    this.favoriteThumbCanvases.clear();
    // 记住这本书属于哪个路径：之后 `view.file` 被宿主换掉也不会写错地方
    this.bookPath = this.file ? this.file.path : null;
    this.store.onChange = () => this.markDirty();
    this.readOnly = readOnly;
    this.readOnlyReason = readOnly ? readOnlyReason : null;
    this.conflict = false;
    // 内容基线由 onLoadFile 读到原文后设置；这里先清掉上一本的，防止串本比较
    this.diskHash = null;
    this.diskContentSig = null;
    this.metaDirty = false;
    // dirty 必须一起复位：上一本书留下的"未保存"标记会跟着新文件走，
    // 导致打开另一本书什么都不做就白写一次整本
    this.dirty = false;
    this.saveAgain = false;
    // 上一本的保存失败 / 抢救记录不能带到新本上，否则一打开就判成「没落盘」去抢救
    this.lastSaveError = null;
    this.rescued = false;
    this.recoveredCopyName = null;
    this.savedActivePage = book.activePage || 0;
    // 基线取文件里读到的形态：undefined 的 zoom = 上次是 fit，不能拿
    // 编辑器算出来的 fit 比例当基线，否则关文件时会误判成"用户缩放过了"
    this.savedZoom = book.zoom;
    this.savedScrollTop = book.scrollTop;
    this.savedScrollLeft = book.scrollLeft;
    this.destroyEditor();
    /*
     * 装配期（buildUI → buildRail）会顺手动到 markDirty，那不是用户操作。用 assembling 挡住它，否则"每本一次"的
     * 只读提示会在打开的一瞬间就被消耗掉，用户真正改内容时反而一声不响。
     */
    this.assembling = true;
    try {
      this.buildUI();
      this.mountEditor(book.activePage || 0);
      this.applyEditorReadOnly();
    } finally {
      this.assembling = false;
    }
    this.saveState = "saved";
    this.updateStatus();
    /*
     * 只读提示的复位必须放在装配**之后**：mountEditor 会在装配期
     * 就调一次 warning，若在这里之前复位，那一次就把"每本一次"
     * 的额度用光了，等用户真正动手改内容时反而一声不响。
     */
    this.readOnlyNoticeShown = false;
    // 装配过程中编辑器会先报一次第 0 页再滚到 activePage，
    // 那不是用户翻页，不能因此记一笔"待落盘"
    this.metaDirty = false;
  }

  /** 丢掉当前书的全部内存状态（读失败时用，避免旧 store 绑到新文件路径上） */
  private dropBook(): void {
    this.destroyEditor();
    this.loadingEl = null;
    this.store = null;
    this.bookPath = null;
    this.fp = null;
    this.diskHash = null;
    this.diskContentSig = null;
    this.recoveredCopyName = null;
    this.dirty = false;
    this.metaDirty = false;
    this.conflict = false;
    this.lastSaveError = null;
    this.rescued = false;
    this.readOnlyReason = null;
    this.savedZoom = undefined;
    this.savedScrollTop = undefined;
    this.savedScrollLeft = undefined;
  }

  /**
   * 只读恢复之后，把恢复出来的内容落成一份**能用的新文件**。
   *
   * 只读页面只能让用户看清"丢了什么"，真正能接着写的是这份副本——
   * 之前提示写"请先另存为新文件"，可插件根本没有"另存为 .inkbook"
   * 这个功能，等于把人领到一扇不存在的门前。
   *
   * 文件名必须**绝不重名**：提示里让用户"改用这个副本"，用户就会在那上面
   * 接着写；同一分钟内再恢复一次如果覆盖同名文件，等于把用户刚写的字抹掉。
   */
  private async saveRecoveredCopy(book: InkBook): Promise<{ path: string | null; error: string }> {
    if (!this.file) return { path: null, error: "没有文件路径" };
    const adapter = this.app.vault.adapter;
    const base = this.file.path.replace(/\.inkbook$/i, "");
    const stamp = conflictStamp(new Date());
    try {
      // 撞名时由 uniqueCopyPath 加 -2/-3…，绝不覆盖用户已经在用的副本
      const target = await this.uniqueCopyPath(adapter, `${base}.recovered-${stamp}.inkbook`);
      // 走 writeBook：同样是 tmp+rename 原子写，integrity 由它自己记
      await writeBook(adapter, target, book);
      this.recoveredCopyName = target.split("/").pop() || target;
      return { path: target, error: "" };
    } catch (e: any) {
      console.error("[inkbook] 另存恢复副本失败", e);
      return { path: null, error: e && e.message ? e.message : String(e) };
    }
  }

  /**
   * 同一本手写本是否已经在**另一个**标签页（leaf）里打开。
   *
   * 为什么放在 view 层而不是只靠 main.openBookAt：文件浏览器里
   * Ctrl/Cmd+点击「在新标签页打开」、拖到分栏等宿主路径根本不经过
   * openBookAt，只能在这里兜底。
   *
   * **每次 onLoadFile 现算，不能缓存**：用户关掉另一个标签页后再打开
   * 本页，应该恢复可写；缓存会把只读态永久粘住。
   * `getLeavesOfType` 在测试桩 / 极老宿主里可能缺失或抛错，一律当作
   * 「没有别的标签页」——检测失败不能影响打开文件。
   */
  private hasBookOpenInOtherLeaf(path: string): boolean {
    try {
      const leaves = this.app.workspace.getLeavesOfType?.(VIEW_TYPE) || [];
      return leaves.some((leaf: any) => {
        if (!leaf || leaf === (this as any).leaf) return false;
        const view: any = leaf.view;
        if (!view || view === this) return false;
        return !!view.file && String(view.file.path) === path;
      });
    } catch (_) {
      return false;
    }
  }

  async onLoadFile(file: TFile): Promise<void> {
    const token = ++this._loadToken;
    /*
     * 切走之前必须先确认上一本真的落盘了。
     *
     * 保存失败时宿主不会给我们「拦住这次切换」的能力（onLoadFile 是它
     * 直接调的），所以至少要把内存里那份抢救成副本，再继续打开新文件——
     * 否则 store 一换，没写下的内容就再也找不回来了（INK-169）。
     */
    const ok = await this.flushSave();
    if (token !== this._loadToken) return;
    if (!ok) await this.rescueUnsaved(this.lastSaveError || "未知原因");
    if (token !== this._loadToken) return;
    /*
     * 同一本已在别的标签页打开 → 这里只读打开（INK-172）。
     *
     * 两个 InkbookView 各持一份 store、各自自动保存：后保存的一方会先
     * 触发指纹冲突，转成 -disk-/-mine- 副本并停止写原文件——内容不丢，
     * 但用户会卡在「怎么保存都不生效」。只读是更早、更清楚的拦截。
     *
     * 必须在每次 onLoadFile 现算（见 hasBookOpenInOtherLeaf）：关掉
     * 另一个标签页后重新打开本页，要能恢复正常可写。
     */
    const duplicateTab = this.hasBookOpenInOtherLeaf(file.path);
    const ext = (file.extension || "").toLowerCase();
    if (ext !== "inkbook") {
      /*
       * **绝不能把非 .inkbook 的文件留在 `this.file` 上**（INK-184）。
       *
       * 老代码先 `this.file = file` 再判扩展名，于是打开一个 .pdf
       * （用户导出后点开成品、或宿主把导出的文件塞进同一个标签页）时，
       * `this.file` 变成了那个 .pdf，而 `bookPath` 可能已被
       * `onUnloadFile` 清成 null —— 下一次 `saveNow` 的
       * `this.bookPath || this.file.path` 就取到了 **.pdf 路径**，
       * 把整本 .inkbook 的 JSON 写进导出的 PDF 文件里。
       *
       * 真实现场（2026-11-07）：`未命名笔记 3-手写本.pdf` 内容变成了
       * `{"version":2,...}`，用户「导出的 PDF 打不开」；
       * 真正的 PDF 被挤进了 `.pdf.bak`（7MB，完好）。
       *
       * 所以这里把 file / bookPath 一起清干净，让这个视图回到「没打开
       * 任何本子」的状态——它本来也显示不出这个文件。
       */
      this.file = null;
      this.bookPath = null;
      this.showError(`墨本只处理 .inkbook 文件，${file.name} 打不开。`);
      return;
    }
    this.file = file;
    const adapter = this.app.vault.adapter;
    /*
     * 先立占位再读盘。
     *
     * 顺序很关键：占位必须在 `readBook` **之前**进 DOM。
     * `adapter.read` 是异步的，那段时间事件循环是空的，浏览器正好能把占位画出来；
     * 等 `JSON.parse` 一开始（大本子几百毫秒），主线程就再也不出帧了——
     * 那时候再想加占位已经晚了，用户看到的只会是白屏。
     */
    this.showLoading(file.basename, await this.fileSizeHint(file.path));
    if (token !== this._loadToken) return;
    try {
      const { book, text } = await readBookWithText(adapter, file.path, file.basename);
      if (token !== this._loadToken) return;
      this.openBook(book, duplicateTab, duplicateTab ? "duplicate" : null);
      if (duplicateTab) {
        new Notice(
          "这本手写本已在另一个标签页打开。为避免两个标签页互相覆盖，这里以只读方式打开；关掉另一个标签页后重新打开本页即可编辑。",
          12000
        );
      }
      this.fp = await fingerprint(adapter, file.path);
      // 记下读到的原文作为内容基线：之后同步盘只改 mtime 不改字节时不会误判冲突
      this.diskHash = hashText(text);
      this.diskContentSig = this.bookContentSignature(book);
    } catch (e: any) {
      console.error("[inkbook] 读取失败", e);
      if (token !== this._loadToken) return;
      /*
       * 版本过新：备份必然也是旧一代的文件，救不回新格式。
       * 拿旧备份糊上去不但救不了，还会把"请升级墨本"这唯一正确的
       * 提示盖成"最近一分钟可能没保存"，用户就真以为只是同步丢了一点。
       * 所以这种情况**不走备份**，直接如实报错。
       */
      if (e instanceof TooNewError) {
        this.dropBook();
        this.readOnly = true;
        this.showError(e.message);
        return;
      }
      // 正文读不出来（残缺/截断）→ 先试备份。备份能读出来就只读打开，
      // 绝不拿残缺内容去覆盖原文件。
      const backup = await recoverFromBackup(adapter, file.path, file.basename);
      if (token !== this._loadToken) return;
      if (backup) {
        this.openBook(backup, true);
        this.fp = await fingerprint(adapter, file.path);
        // 只读页面只是让用户看清丢了什么；真正能接着写的是落出来的副本
        const copy = await this.saveRecoveredCopy(backup);
        if (copy.path) {
          const name = copy.path.split("/").pop() || copy.path;
          new Notice(
            `已从备份恢复，并另存为 「${name}」：这是上一次成功保存时的内容，` +
              `之后的笔迹可能没有保存。当前页面只读，可直接改用这个副本。`,
            15000
          );
        } else {
          new Notice(
            `已从备份恢复，但另存副本失败（${copy.error}）。` +
              `请手动把同目录的 .bak 复制一份并改名成 .inkbook。`,
            10000
          );
        }
        return;
      }
      this.dropBook();
      this.readOnly = true;
      // showError 的标题已经是「打不开」，这里只放原因，别再叠一层"打不开："
      this.showError(e && e.message ? e.message : String(e));
    }
  }

  async onUnloadFile(): Promise<void> {
    // 翻页只算「元数据脏」，不置 dirty —— 否则看一眼就整本写一次盘
    this.syncActivePage();
    const ok = await this.flushSave();
    if (!ok) await this.rescueUnsaved(this.lastSaveError || "未知原因");
    // 冲突还没解决就切文件：内存里的内容必须落到磁盘上，不能静默丢
    await this.preserveConflictCopy();
    this.destroyEditor();
    this.store = null;
    this.bookPath = null;
    this.file = null;
    this.fp = null;
    this.diskHash = null;
    this.diskContentSig = null;
    this.conflict = false;
    this.renderEmpty();
  }

  private mountEditor(activePage: number): void {
    if (!this.store) return;
    this.store.data.activePage = Math.max(
      0,
      Math.min(this.store.data.pages.length - 1, activePage || 0)
    );
    this.editor = new BookEditor(this.paperHost, this.store, {
      app: this.app,
      penOnly: this.plugin.settings.penOnly,
      pressure: finiteSetting(this.plugin.settings.pressure, 1, 0.3, 1.5),
      smoothing: finiteSetting(this.plugin.settings.smoothing, 0.55, 0, 1),
      prediction: this.plugin.settings.prediction,
      edgeSwipeBlock: this.plugin.settings.blockEdgeSwipe !== false,
      straighten: this.plugin.settings.straightLine === true,
      // 经典手写应用移植功能（默认关，由设置与快捷键控制）
      shapeSnap: normalizeShapeSnap(this.plugin.settings.shapeSnap),
      laserPointer: this.plugin.settings.laserPointer === true,
      onState: () => this.scheduleUIUpdate(),
      onChange: () => this.markDirty(),
      onPageChange: () => this.onPageChanged(),
      // 抬笔 / 擦除收手：把书写期间避让掉的自动保存重新排上
      onInkGestureEnd: () => this.onInkGestureEnd(),
      /*
       * 底图（PDF 页 / 图片）渲染好了 → 补画那一页的缩略图。
       *
       * 缩略图是"进视口就画一次"，那时候 PDF 位图基本还没光栅化完，
       * 所以第一遍只能画灰底。没有这个回调，侧栏会一直停在灰底上，
       * 用户以为那页是空的。
       */
      onThumbNeedsRedraw: (i: number) => {
        // 侧栏收起/目录标签时不要画：隐藏状态的 rect 是 0，会走 60×84 的回退尺寸，
        // 白白把 PDF 页排进光栅化队列（展开时会统一补画）
        if (this.thumbVisible()) {
          const cv = this.thumbCanvases.get(i);
          // 页号可能不在当前窗口里（大本子只物化可视区），拿不到就等它滚进来再画
          if (cv && cv.isConnected) this.editor?.renderThumbnail(cv, i);
        }
        if (this.favoritesVisible()) {
          const cv = this.favoriteThumbCanvases.get(i);
          if (cv && cv.isConnected) this.editor?.renderThumbnail(cv, i);
        }
      },
      /*
       * 文字装不下纸面（INK-192）。
       *
       * 排版层会裁掉超出的行——不裁就是溢出到纸外被静默吃掉，
       * 屏幕/导出/嵌入三处一致地"字不见了"。原文一个字没丢，
       * 但用户看不到就必须当场告诉他，否则他会以为字打丢了。
       */
      onTextOverflow: (hidden: number) => {
        new Notice(
          `这段文字太长，有 ${hidden} 行超出纸面没有显示（原文没有丢）。` +
            `调小字号、把文字框拖宽，或者分成两段写。`,
          8000
        );
      },
      // 点了文字里的 [[双链]]：由 view 解析目标并打开（Markdown / .inkbook 均可）
      onOpenWikiLink: (href, page, newTab) => this.openWikiLink(href, page, newTab),
      // 文件块属性条：「打开源文件」复用双链解析；「刷新」重新生成快照
      onOpenFileSource: (path) => this.openWikiLink(path, undefined, false),
      onRefreshFileBlock: (image) => void this.refreshFileBlock(image),
      // 文字输入框里打 `[[` 时列出可链接的库内笔记（与「插入双链」弹窗同一份清单）
      getLinkTargets: () => collectLinkTargets(this.app),
    });
    this.editor.penColor = this.plugin.settings.lastPenColor || "#1A1A1A";
    this.editor.penSize = finiteSetting(this.plugin.settings.defaultPenSize, 2.8, 1, 8);
    this.editor.ballpointSize = finiteSetting(this.plugin.settings.defaultBallpointSize, 2.8, 1, 8);
    this.editor.shapeSizes = finiteShapeSizes(this.plugin.settings.defaultShapeSizes, 2.8);
    this.editor.highlighterColor = this.plugin.settings.lastHighlighterColor || "#F6E05E";
    this.editor.highlighterSize = finiteSetting(
      this.plugin.settings.defaultHighlighterSize,
      24,
      4,
      40
    );
    // 橡皮「记忆」：恢复上次选的模式与大小（按下橡皮不再弹框，直接用这个）。
    this.editor.eraserMode = this.plugin.settings.lastEraserMode === "whole" ? "whole" : "part";
    this.editor.eraserSize = finiteSetting(this.plugin.settings.lastEraserSize, 26, 6, 60);
    // 「允许手指书写」以前只活在编辑器实例上，每次打开都回默认 false；
    // 现在从 settings 恢复（侧栏开关 / 设置页都会写回这里）。
    this.editor.touchDraw = this.plugin.settings.touchDraw === true;
    /*
     * 恢复上次的缩放与页内滚动位置（INK-173 / INK-209）。
     *
     * 必须在编辑器构造之后、第一帧布局之前调用：zoom 会立即生效并关掉
     * fitMode；scrollTop / scrollLeft 由编辑器挂到下一帧，等构造函数里的
     * goToPage(activePage) 跑完、容器量出真实尺寸后再落，不然会被它拉回
     * 页首 / 页左边。字段缺省时（老文件）restoreViewState 是空操作。
     */
    this.editor.restoreViewState({
      zoom: this.store.data.zoom,
      scrollTop: this.store.data.scrollTop,
      scrollLeft: this.store.data.scrollLeft,
    });
    this.buildHeaderActions();
    // 标题栏放不下十个按钮时（平板常见），下一帧会把整行搬到自建顶栏条
    this.scheduleTopRowFit();
    this.buildFloat();
    this.buildScrollbar();
    this.buildSide();
    // 缩略图 / 目录搬到左侧抽屉（Obsidian 原生 PDF 阅读器那种）
    this.buildPageDock();
    // 工具 / 撤销重做按钮的 tooltip 里带上当前（可自定义的）快捷键
    this.syncHotkeyLabels();
    this.updateUI();
    this.saveState = "saved";
    this.updateStatus();

    // 从索引链接跳进来：布局完成后再滚，否则拿到的页偏移是 0
    if (this.pendingPage != null) {
      const p = this.pendingPage;
      const hint = this.pendingPageHint;
      this.pendingPage = null;
      this.pendingPageHint = false;
      requestAnimationFrame(() => {
        this.editor?.goToPage(p, false);
        // 滚到位之后再标，否则提示会跟着滚动一起飞走
        if (hint) this.editor?.locatePage(p);
      });
    }

    /*
     * 首屏布局稳定后，把「当前视图」记为已保存基线。
     *
     * 老文件的 activePage 可能 >0：打开时编辑器会自动滚到那一页，
     * 但那不是用户的滚动。不更新基线的话，什么都不做直接关文件也会被
     * syncActivePage 判成「滚动位置变了」，白写一次整本。
     * 双 rAF：等构造函数的 goToPage、restoreViewState 的滚动恢复、
     * 以及上面 pendingPage 的跳页都跑完再取。
     */
    const mountedEditor = this.editor;
    const mountedStore = this.store;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        // 同一 leaf 的 A→B→后退 A 可在两帧内重挂；旧回调绝不能
        // 用新编辑器的位置覆盖新书的已保存基线。
        if (!mountedEditor || this.editor !== mountedEditor || this.store !== mountedStore) return;
        this.savedZoom = mountedEditor.fitMode ? undefined : mountedEditor.zoom;
        const rawTop = mountedEditor.getScrollTop();
        this.savedScrollTop = rawTop > 0 ? rawTop : undefined;
        const rawLeft = mountedEditor.getScrollLeft();
        this.savedScrollLeft = rawLeft > 0 ? rawLeft : undefined;
      })
    );

    this.ensureTextIndexIfMissing();
  }

  /**
   * 打开本子时若发现「本子有文字、但索引目录里没有新命名的索引页」，异步补建一次。
   *
   * 为什么需要它：`scheduleTextIndex()` 只在**保存成功后**触发，用户光打开一本
   * 老本子（不改动、不保存）时不会重建索引。而真机上确实出现过索引目录建了、
   * 却因为「目录在磁盘上、没进 Obsidian 文件表」导致一个 md 都写不出来（全局搜索
   * 0 结果）。`writeTextIndex` 现在会自愈这种目录，但得有人调用它。
   *
   * 索引目录还不存在、甚至 `list` 抛 ENOENT 时也按缺索引补建（Word 导入新建本子
   * 不会自动保存，最容易卡在这里）。只做一次轻量检查 + 异步写，不阻塞打开；
   * 失败由 writeTextIndex 自己弹可见提示。
   */
  private ensureTextIndexIfMissing(): void {
    if (!this.file || !this.store || this.plugin.settings.searchIndex === false) return;
    void ensureTextIndexOnOpen(this.app, this.file, this.store.data).catch(() => {
      /* 索引是派生物，补建失败不该影响打开本子 */
    });
  }

  private destroyEditor(): void {
    // 换本子 / 关标签页：查找态属于这一本，不能带到下一本上
    this.closeFindBar();
    this.editor?.destroy();
    this.editor = null;
    this.cancelUIUpdateRaf();
    this.cancelInkDeferRetry();
    this.inkDeferAt = 0;
    // 顶栏那一行挂在标题栏/自建条上，不跟着 editorHost 走，得单独摘
    this.topRowEl?.remove();
    this.topBarEl?.remove();
    this.topRowEl = null;
    this.topBarEl = null;
    window.clearTimeout(this.zoomHintTimer);
    window.clearTimeout(this.indexTimer);
    this.indexTimer = 0;
    /*
     * `indexPending` **不清**：定时器被销毁不代表内容已经进索引了。
     * 紧接着的 flushSave 会看这个标志，决定要不要补写一次——
     * 这正是「导入 PDF 后马上切走，PDF 原文搜不到」的修法。
     */
    this.floatEl?.remove();
    // 滑条挂在 paperHost 上，跟着编辑器一起拆；监听器走 AbortController 一并断掉
    this.sbAbort?.abort();
    this.sbAbort = null;
    if (this.sbRaf) {
      window.cancelAnimationFrame?.(this.sbRaf);
      this.sbRaf = 0;
    }
    window.clearTimeout(this.sbHideTimer);
    this.sbHideTimer = 0;
    this.sbWoke = false;
    this.sbQuiet = false;
    this.sbQuietSeq++;
    this.sbEl?.remove();
    this.sbEl = null;
    this.sbTrack = null;
    this.sbThumb = null;
    this.sbTip = null;
    this.sbDrag = null;
    this.sbThumbH = 0;
    this.sbThumbTop = 0;
    this.sideEl?.empty();
    this.toolButtons.clear();
    // 步进按钮的连调 timer：侧栏 DOM 已拆，不停会一直往已销毁的编辑器上写
    for (const stop of this.dynStepStoppers) stop();
    this.dynStepStoppers = [];
    // dynEl 已随 sideEl.empty() 脱离文档：清掉引用与签名，别留悬空指针
    this.dynEl = null as any;
    this.dynToolsSig = "";
    // 拖拽态要收干净：ghost / 指示线挂在 document.body 上，不随侧栏一起走
    this.cancelThumbDrag();
    this.cancelThumbPress();
    this.closeThumbMenu();
    this.floatEl = null as any;
    this.layerListEl = null;
    this.pageListEl = null;
    this.outlineListEl = null;
    this.outlineViewportEl = null;
    this.outlineRev = -1;
    this.outlineWinLo = 0;
    this.outlineWinHi = 0;
    this.outlineRowH = 0;
    this.templateGrid = null;
    this.paperRow = null;
    this.statsEl = null;
    // 侧栏收起时列表可能还没建，观察器只在 renderPageList 里断会漏
    this.thumbObserver?.disconnect();
    this.thumbObserver = null;
    this.thumbCanvases.clear();
    this.thumbItems.clear();
    this.thumbItemPool.clear();
    this.addThumbEl = null;
    this.pageTopPadEl = null;
    this.pageBottomPadEl = null;
    this.activeThumbEl = null;
    // 页列表窗口化：旧节点已经随 sideEl.empty() 一起拆掉，监听/观察一并断
    this.pageListAbort?.abort();
    this.pageListAbort = null;
    this.pageListResizeObs?.disconnect();
    this.pageListResizeObs = null;
    this.pageListViewportEl = null;
    this.cancelPageListRaf();
    this.pageWinRowLo = -1;
    this.pageWinRowHi = -1;
    this.pageWinRowH = 0;
    this.pageWinCols = 0;
    this.templateCards.clear();
    this.paperChips.clear();
    this.layerSig = "";
    this.pageCountSig = -1;
    this.pageOrderRev = -1;
    this.cancelThumbPress();
    this.closeThumbMenu();
    this.templatePaperSig = "";
  }

  /* ------------------------------- UI ------------------------------- */

  /**
   * 判断是不是平板。
   *
   * 判据是「主指针是不是手指」，而不是「有没有触摸屏」——
   * 后者会把带触控屏的笔记本也算成平板，那些机器有鼠标有键盘，
   * 却被迫用手指大小的按钮，纯属误伤。
   *
   * 浏览器给出的信号：
   *   · (pointer: coarse)  主指针是粗指针（手指）→ 触摸优先的设备
   *   · (any-pointer: fine) 存在精确指针（鼠标/触控板）
   *   · navigator.maxTouchPoints  触摸点数量
   *
   * 老浏览器没有 pointer 媒体查询时，退回「有触摸点且完全没有鼠标」。
   */
  private detectTablet(): boolean {
    const mq = (q: string) => window.matchMedia?.(q)?.matches ?? false;

    // 主指针是手指 → 触摸优先
    const primaryCoarse = mq("(pointer: coarse)");
    // 完全没有鼠标可用
    const noMouse = !mq("(any-pointer: fine)");
    // 兜底：老浏览器只给触摸点数
    const touchOnly = (navigator.maxTouchPoints ?? 0) > 0 && noMouse;

    const touchFirst = primaryCoarse || touchOnly;
    const minSide = Math.min(window.innerWidth, window.innerHeight);
    // 手机（窄边 < 500）不算平板，它塞不下 A4 纸
    return touchFirst && minSide >= 500;
  }

  private applyTabletMode(): void {
    this.contentEl.toggleClass("is-tablet", this.tabletMode);
    /*
     * 顶栏那一行挂在视图头部（containerEl）里，不在 .mb-root 内部——
     * 所以「平板上按钮放大、间距拉开」的规则必须挂在 containerEl 上，
     * 之前写在 .mb-root.is-tablet 下面，选择器根本匹配不到，
     * 平板一直是电脑尺寸（用户反馈"平板上这 3 个图标间距有点近"）。
     */
    this.containerEl.toggleClass("mb-tablet", this.tabletMode);
    this.applySideVisibility();
  }

  /** 侧栏显隐：只由 sideShown 决定 */
  private applySideVisibility(): void {
    const visible = this.sideShown;
    this.sideEl?.toggleClass("is-hidden", !visible);
    /*
     * 平板上侧栏是**绝对定位盖在纸面上**的（见 styles.css 的
     * `.mb-root.is-tablet .mb-side`）。展开后它压住右侧约 340px：
     * 800px 竖屏 fit 出来纸宽 736px，被盖掉 42% —— 而纸本来就不宽于
     * 视口，横向没有可滚空间，用户既看不见也够不着被盖的那部分。
     *
     * 给纸面列留出同等宽度的右侧空间（CSS 里靠这个类），fit 就会按
     * **真正看得见的区域**算缩放，纸整体缩进可见区。
     * 收起时移除，纸恢复满宽。
     */
    this.bodyEl?.toggleClass("mb-side-open", visible);
    /*
     * 展开侧栏时补建/补画缩略图。
     * 收起状态下不建页列表、不渲染缩略图：857 页的本子光建 DOM 就要几十毫秒，
     * 更贵的是会立刻用 pdf.js 渲 5 页缩略图，和首屏抢同一份 PDF。
     *
     * 顺序：先把页列表窗口按当前滚动位置摆好（display:none 期间量不到尺寸），
     * 再补画缩略图——否则 refreshThumbs 画的还是收起前那批 canvas。
     */
    if (visible) {
      this.updatePageWindow(false);
      /*
       * 目录窗口也要重算（2026-11-07 补）：
       * 收起期间 `renderOutlines` 可能已经用**兜底行高/视口高**建过一轮
       * （display:none 时量不到真实尺寸），而展开时 `refreshThumbs →
       * renderOutlines` 会因 `outlineRev` 没变直接早退，永远不会重测。
       * 结果：目录区在 >60 条时可能少建几条或位置偏，要等用户滚一下才恢复。
       * 这里强制重建一次窗口（目录视口没有 ResizeObserver，只能靠这个入口）。
       */
      this.outlineWinLo = -1;
      this.outlineWinHi = -1;
      this.outlineRowH = 0; // 重新量一次真实行高
      this.buildOutlineWindow(true);
      this.refreshThumbs();
    }
  }

  /**
   * 用户点开面板时，从侧边缓缓滑入（Obsidian 那种感觉）。
   *
   * 只加一个临时类触发 CSS keyframes，动画里**只动 transform**：宽度保持
   * 瞬时到位，缩略图按最终尺寸排版 / 光栅化，不会每帧重排、也不会糊
   * （见 styles.css 的 .mb-pagedock-body 注释与 mb-*-in 关键帧）。
   *
   * 之所以不把 animation 直接挂在 .is-open / :not(.is-hidden) 上：那样首次
   * 渲染、平板模式切换、程序化改状态都会误播；而这里只在**用户点开**时播。
   * 动画结束（或超时兜底）后摘掉类，避免残留 transform 影响之后量尺寸，
   * 也避免下次 display:none → flex 时把旧动画又放一遍。
   */
  private playPanelSlideIn(el: HTMLElement | null | undefined): void {
    this.playPanelSlide(el, "in");
  }

  /**
   * 用户点「收起」时，从侧边缓缓滑出，别瞬间消失。
   *
   * 与展开对称：临时给面板加 `mb-slide-out`，CSS 里用更高优先级把收起态的
   * `display:none` / `width:0` / 子元素 `visibility:hidden` 压回可见，让面板在
   * **保持最终尺寸**的前提下只做 transform 滑出；动画结束再摘类。状态类
   * （is-hidden / 非 is-open）其实在点击瞬间就已经切好，所以各类「收起后
   * is-hidden / 非 is-open」的断言不受影响。
   */
  private playPanelSlideOut(el: HTMLElement | null | undefined): void {
    // 尊重「减少动态效果」：没有动画就别把面板临时压回可见，
    // 否则它会僵在原地 240ms 才消失——干脆不加类，维持瞬时收起。
    if (this.prefersReducedMotion()) return;
    this.playPanelSlide(el, "out");
  }

  /**
   * 面板滑入 / 滑出的统一实现：临时加类触发 CSS keyframes，超时兜底后摘掉。
   * 只动 transform（见 styles.css），不碰宽度 / 布局。同一个元素只保留一个
   * 定时器 + 一个方向类，连续快速开合能互相取消、从头重放。
   */
  private playPanelSlide(el: HTMLElement | null | undefined, dir: "in" | "out"): void {
    if (!el) return;
    const inCls = "mb-slide-in";
    const outCls = "mb-slide-out";
    const cls = dir === "in" ? inCls : outCls;
    // 两个类都清掉，保证换方向时不会两个 keyframes 打架
    el.classList.remove(inCls, outCls);
    // 强制重排：连续快速开合时让 keyframes 能从头重放
    void el.offsetWidth;
    el.classList.add(cls);
    const prev = this.slideTimers.get(el);
    if (prev !== undefined) window.clearTimeout(prev);
    const timer = window.setTimeout(() => {
      el.classList.remove(cls);
      this.slideTimers.delete(el);
    }, 320);
    this.slideTimers.set(el, timer);
  }

  /** 用户是否开启了系统级「减少动态效果」。 */
  private prefersReducedMotion(): boolean {
    try {
      return !!(
        typeof window !== "undefined" &&
        window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      );
    } catch (_) {
      return false;
    }
  }

  /**
   * 把工具 / 撤销重做按钮 tooltip 里的快捷键更新成当前生效值。
   * 快捷键可在设置页自定义，刷新视图时（syncSettings）会重跑这里。
   */
  private syncHotkeyLabels(): void {
    const overrides = this.plugin.settings.hotkeys;
    const suffix = (id: string) => {
      const l = hotkeyLabelFor(id, overrides);
      return l ? ` (${l})` : "";
    };
    for (const [id, btn] of this.toolButtons) {
      const t = TOOLS.find((x) => x.id === id);
      if (!t) continue;
      const title = t.name + suffix(id);
      btn.title = title;
      btn.setAttribute("aria-label", title);
    }
    const apply = (btn: HTMLElement | null, base: string, id: string) => {
      if (btn) btn.title = base + suffix(id);
    };
    apply(this.undoBtn, "撤销", "undo");
    apply(this.redoBtn, "重做", "redo");
    apply(this.floatUndoBtn, "撤销", "undo");
    apply(this.floatRedoBtn, "重做", "redo");
    apply(this.railFindBtn, "在当前笔记中查找文字", "find");
  }

  /**
   * 缩略图/页列表现在有必要维护吗。
   *
   * 侧栏收起时当然不用；显示「目录」标签时页列表被 display:none，
   * 量不到尺寸也画不出来，同样不必维护（切回缩略图标签时会强制补建）。
   */
  private thumbVisible(): boolean {
    // 缩略图现在住在左侧抽屉里：抽屉展开 + 当前是缩略图标签才需要维护
    return this.pagedockOpen && this.sideTab === "thumbs";
  }

  /** 收藏面板的缩略图现在能按真实尺寸画吗 */
  private favoritesVisible(): boolean {
    return this.pagedockOpen && this.sideTab === "favorites";
  }

  /**
   * 缩略图要对齐的「当前页」：以编辑器实时状态为准。
   *
   * 屏幕上的选中高亮（updateUI）一直用的是 editor.getState().pageIndex。
   * store.data.activePage 是给文件落盘用的镜像：普通翻页时编辑器会顺手
   * setPage，但快滑（armScrollSettle）会推迟到停稳、缩放 quiet 刷新会跳过，
   * 两者就可能短暂不一致。缩略图是纯 UI，和选中高亮同源才不会在抽屉
   * 展开那一下按旧页建窗口、补画隔壁页的邻居。
   */
  private activeThumbPage(): number {
    const live = this.editor?.getState().pageIndex;
    return typeof live === "number" && Number.isFinite(live)
      ? Math.max(0, live)
      : Math.max(0, this.store?.data.activePage ?? 0);
  }

  private buildUI(): void {
    const root = this.contentEl;
    this.loadingEl = null;
    root.empty();
    // 查找浮条也挂在刚被清空的 contentEl 里，旧引用必须一起丢掉
    this.findBarEl = null;
    this.findInputEl = null;
    this.findCountEl = null;
    root.addClass("mb-root");
    this.tabletMode = this.detectTablet();
    this.bodyEl = root.createDiv("mb-body");
    /*
     * 编辑区 = 纸面滚动区 + 右侧工具长条，**并排的两列**。
     *
     * 之前长条是绝对定位浮在纸面上（position:absolute），
     * 结果它压在滚动条上——想拖滚动条得先把长条挪开，
     * 鼠标根本够不着。用户反馈"边上的框会挡住滑动页面的那个条"。
     *
     * 改成 flex 并排之后：
     *   · 滚动条在滚动区自己的右缘，永远露在外面
     *   · 长条不覆盖纸面，纸的可用宽度不缩水
     *   · 长条常驻，点击目标稳定，不会随滚动跑位
     */
    this.editorHost = this.bodyEl.createDiv("mb-editor");
    this.paperHost = this.editorHost.createDiv("mb-paper");
    this.sideEl = this.bodyEl.createDiv("mb-side");
    // 侧栏的展开状态：平板默认收起（屏幕窄），电脑沿用上次设置
    this.sideShown = this.tabletMode ? false : this.plugin.settings.sidebarOpen;
    this.applyTabletMode();
  }

  private renderEmpty(): void {
    if (!this.editorHost) return;
    this.loadingEl = null;
    this.floatEl?.remove();
    this.sideEl?.empty();
    this.editorHost.empty();
    const box = this.editorHost.createDiv("mb-empty");
    box.createDiv({ cls: "mb-empty-mark", text: "墨" });
    box.createEl("h3", { text: "新建一本手写本" });
    box.createEl("p", {
      text: "A4 纸、压感笔锋、纸张模板、图层、连续翻页。写满一页就往下加。",
    });
    /*
     * 两个入口：
     *   · 新建手写本 —— 原来就有；
     *   · 导入文档开始 —— 很多用户的第一反应是「我有个 PDF 想在上面写」，
     *     先让他挑文档、再自动建本子，比「先建空本、再在工具栏里找导入」
     *     少一步，也避免建完空本又忘了导入。
     */
    const actions = box.createDiv("mb-empty-actions");
    const btn = actions.createEl("button", { cls: "mod-cta", text: "新建手写本" });
    btn.onclick = () => this.openNewBook();
    const imp = actions.createEl("button", { text: "导入文档开始" });
    imp.onclick = () => this.startImportNewBook();
  }

  private openNewBook(): void {
    new NewBookModal(this.app, this.plugin as any, (file) => {
      this.app.workspace.getLeaf("tab").openFile(file);
    }, () => this.startImportNewBook()).open();
  }

  /** 空视图和新建弹窗共用选源入口，避免两处复制导入建本流程。 */
  startImportNewBook(): void {
    new ImportSourceModal(this.app, "any", (file) => {
      void this.importAsNewBook(file);
    }).open();
  }

  private showError(msg: string): void {
    this.loadingEl = null;
    if (!this.editorHost) return;
    this.editorHost.empty();
    const el = this.editorHost.createDiv("mb-error");
    el.createEl("h3", { text: "打不开" });
    el.createEl("p", { text: msg });
  }

  /* ----------------------------- 打开中的占位 ----------------------------- */

  /**
   * 显示「正在打开…」占位。
   *
   * 为什么需要它：`.inkbook` 是**单个 JSON 文件**，打开时必须整份读出来、
   * 整份 `JSON.parse`。这两步没有任何办法分片——实测 13MB 的本子约 130ms，
   * 72MB 的约 960ms，其中 85% 花在读盘和解析上（解析期间主线程一帧都出不来）。
   *
   * 也就是说：页数一多，用户点开之后**必然**有一段时间什么都看不到。
   * 这段时间在同步盘 / 网络盘上会更长。没有占位，用户看到的是白屏，
   * 会以为插件卡死了，然后开始反复点、反复切——那才是真的灾难。
   *
   * 有了占位，同一段等待就变成"它在干活"，能等下去。
   *
   * 注意：这里**只**影响观感，不改变任何打开逻辑；
   * 占位会被 buildUI / showError / renderEmpty 里的 empty() 顺带清掉。
   */
  private showLoading(name: string, bytes: number): void {
    this.loadingEl = null;
    if (!this.editorHost) return;
    // 上一本书的编辑器和浮层必须先收掉，否则占位会盖在纸上
    this.destroyEditor();
    this.floatEl = null as any;
    this.editorHost.empty();
    const box = this.editorHost.createDiv("mb-loading");
    box.createDiv({ cls: "mb-loading-mark", text: "墨" });
    box.createEl("h3", { text: `正在打开「${name}」` });
    // 体积是**真实**读到的文件大小；拿不到就说"页数较多"，
    // 不编造页数——页数要解析完才知道。
    const sizeText =
      bytes > 0 ? `${(bytes / 1048576).toFixed(1)}MB` : "页数较多";
    box.createEl("p", {
      text: `${sizeText} · 正在读取并解析整本笔记，页数多时需要一两秒。`,
    });
    this.loadingEl = box;
  }

  /**
   * 只为占位显示文件大小而取一次 stat。
   *
   * 拿不到（适配器没有 stat / 报错）就返回 0，占位退化成"页数较多"的文案，
   * 绝不因为拿不到体积而影响打开。
   */
  private async fileSizeHint(path: string): Promise<number> {
    const adapter = this.app.vault.adapter as any;
    if (typeof adapter?.stat !== "function") return 0;
    try {
      const st = await adapter.stat(path);
      return st ? Number(st.size) || 0 : 0;
    } catch (_) {
      return 0;
    }
  }

  /* ------------------------------- 工具行 ------------------------------- */

  /**
   * 顶栏那一行里的**工具组**：7 支笔，横着排。
   *
   * 之前它们是浮在纸上的一块可拖动浮层（还能横竖切换、记位置），
   * 平板上一列 86px 全是纸的损失，而顶栏明明还有空。
   * 挪上来之后：纸面通栏，笔也还在拇指够得着的地方。
   *
   * 只放图标不放文字——顶栏高度撑不起「钢笔」两个字，
   * 全名放在 title 里，长按 / 悬停能看到。
   */
  private buildToolRow(row: HTMLElement): void {
    // 顶栏重建（换文件 / 宿主清空标题栏）时旧浮层的锚点就不在了，先收掉
    this.closePenPop();
    this.toolButtons.clear();
    // 重建工具行时旧的滑动高亮片连同其 ResizeObserver 一起销毁
    this.toolPill?.destroy();
    this.toolPill = null;
    this.slideToolSig = null;
    const wrap = row.createDiv("mb-top-tools");
    this.topToolsEl = wrap;
    // 选中态的紫色高亮片：放在按钮前面（绝对定位，不在 flex 流里）
    this.toolPill = new SlidePill(wrap);
    for (const t of TOOLS) {
      /*
       * 用 `clickable-icon` 这一套，而不是裸 `<button>`。
       *
       * 真机教训（2026-10-29 平板）：同样是我们的 .mb-ic，宿主 addAction
       * 造出来的三个动作按钮图标正常，自己 createElement 的七个笔全是空白。
       * 唯一的结构差异就是少了这个类——Obsidian 对图标按钮的 svg 尺寸/颜色
       * 是挂在 .clickable-icon 这条链上的，没有它就轮到别的全局规则说了算。
       * 所以别"优化"成纯 button，这里就跟宿主保持一致。
       */
      const b = document.createElement("button");
      b.className = "clickable-icon mb-topbtn mb-top-tool";
      b.type = "button";
      setIcon(b, t.icon);
      b.title = t.name;
      b.setAttribute("aria-label", t.name);
      b.onclick = () => this.activateTool(t.id);
      wrap.appendChild(b);
      this.toolButtons.set(t.id, b);
    }

  }

  /**
   * 「激活某支工具」的唯一入口：顶栏按钮点击和工具快捷键都走这里，
   * 保证两条「用户动作入口」行为完全一致。
   *
   * 第一次触发 = 切到这支工具；已经在这支工具上再触发一次 = 在它的
   * 顶栏按钮正下方弹出快捷参数浮层（三支笔 / 形状 / 文字 / 橡皮各自的
   * 浮层），浮层已开则再触发一次收起——保持「点一下开、再点一下关」。
   *
   * 用户反馈（本次）：电脑快捷键此前直接走 chooseTool，没接上这层开关，
   * 所以按第二下不弹颜色框；而且形状这类 TOOLS_NEED_SIDE 工具还会连带
   * 展开侧栏（点顶栏按钮却不会）。统一到本方法后两处行为一致。
   *
   * anchor 默认取这支工具的顶栏按钮；顶栏还没建好（极少见）时退化为
   * 只切工具，绝不因为拿不到锚点就报错。
   */
  private activateTool(id: ToolId): void {
    const b = this.toolButtons.get(id);
    const cur = this.editor?.getState().tool;
    if (!b) {
      // 顶栏按钮还没建出来：只切工具（chooseTool 内部已处理重复点/侧栏策略）
      this.chooseTool(id);
      return;
    }
    /*
     * 形状：点一下就切到形状，并在按钮正下方弹出形状选项框
     * （矩形/椭圆/直线/箭头 + 笔色），不再自动展开侧栏
     * （用户原话：「选择形状之后直接在按钮的底下弹出选项框」）。
     * 同一颗按钮的浮层已开时再点则收起。
     */
    if (id === "shape") {
      if (this.penPopEl && this.penPopAnchorEl === b) {
        this.closePenPop(true); // 再点一次收起：播收起动画
        return;
      }
      this.editor?.setTool("shape");
      this.updateUI();
      this.openPenPop(b, "shape");
      return;
    }
    /*
     * 文字：点一下切工具并在按钮下弹出选项框，不再自动展开侧栏
     * （用户原话：「文字点完直接在下边弹出字号/颜色/字体框」）。
     */
    if (id === "text") {
      if (this.penPopEl && this.penPopAnchorEl === b) {
        this.closePenPop(true); // 再点一次收起：播收起动画
        return;
      }
      this.editor?.setTool(id);
      this.updateUI();
      this.openTextPop(b);
      return;
    }
    /*
     * 橡皮：**按下不再每次都弹调节框**（用户原话：「每次按下橡皮的时候
     * 不用都弹出来底下的那个调节框，橡皮只需要有记忆功能」）。
     * 第一次点只切到橡皮，直接用上次记住的模式/大小落笔；已经在这支
     * 橡皮上再点一下，才弹出调节框改设置（和钢笔「再点一下」一致）。
     */
    if (id === "eraser") {
      if (this.penPopEl && this.penPopAnchorEl === b) {
        this.closePenPop(true); // 调节框开着，再点收起
        return;
      }
      const already = cur === "eraser";
      this.editor?.setTool("eraser");
      this.updateUI();
      if (already) this.openEraserPop(b);
      return;
    }
    /*
     * 第一次点 = 切到这支笔；已经在这支笔上再点一下 = 按钮正下方
     * 弹出快捷笔盒（用户原话：「再点一下 就直接能在钢笔下边弹出
     * 一个笔盒 能直接切换颜色和粗细」）。浮层已开着再点则收起——
     * 保持"点一下开、再点一下关"的开关手感。
     */
    if (id === cur && PEN_POP_TOOLS.has(id)) {
      if (this.penPopEl && this.penPopAnchorEl === b) this.closePenPop(true); // 再点一次收起：播收起动画
      else this.openPenPop(b, id);
      return;
    }
    this.closePenPop();
    this.chooseTool(id);
  }

  /**
   * 切工具，并处理「这个工具的参数面板在侧栏里」的情况。
   *
   * 文字的字号 / 字体 / 颜色，橡皮的整笔 / 局部，形状的种类，
   * 都只住在侧栏「当前工具」区（.mb-sec-dyn），而平板上侧栏默认收起：
   * 用户点顶栏换工具后只切了工具，找不到调参入口（真机反馈：
   * 「点击输入的按钮后，侧边栏不会弹出来，无法调整字体大小和颜色」）。
   *
   * 只在**工具真的从别的工具切到这些工具**这一下展开一次
   * （见 TOOLS_NEED_SIDE；钢笔 / 圆珠笔 / 荧光笔刻意不展开）。
   * 不能放进 updateUI：那样用户手动收起侧栏后，落笔 / 翻页触发的
   * updateUI 又会把它弹出来。
   */
  private chooseTool(id: ToolId): void {
    const prev = this.editor?.getState().tool;
    this.editor?.setTool(id);
    // 重复点同一支笔：不重新弹侧栏（用户可能刚手动收起）
    if (id === prev) return;
    if (!TOOLS_NEED_SIDE.has(id)) return;
    // 侧栏已经开着也不用动
    if (this.sideShown) return;
    this.sideShown = true;
    this.applySideVisibility();
    this.playPanelSlideIn(this.sideEl);
    this.updateUI();
  }

  /* --------------------------- 快捷笔盒浮层 --------------------------- */

  /**
   * 在当前工具按钮正下方弹出快捷笔盒：颜色点 + 粗细档位。
   *
   * 数据和侧栏「笔盒」用的是同一份常量（PEN_COLORS / PEN_SIZES /
   * HIGHLIGHTER_PALETTE / HIGHLIGHTER_SIZES），不复制第二套色值；
   * 点色点 / 粗细**只改参数、不切工具**（与侧栏一致，见 buildSide 的注释），
   * 且浮层保持打开，方便连续调。
   */
  private openPenPop(anchor: HTMLElement, tool: ToolId): void {
    this.closePenPop();
    this.penPopTool = tool;
    const hl = tool === "highlighter";
    const isShape = tool === "shape";
    const el = document.body.createDiv("mb-pen-pop");
    // 平板：浮层整体缩小一些（桌面保持原尺寸）
    if (this.tabletMode) el.addClass("mb-pen-pop-tablet");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", isShape ? "形状选项" : hl ? "荧光笔颜色与粗细" : "笔颜色与粗细");

    const colorRow = el.createDiv("mb-pen-pop-row mb-pen-pop-colors");
    for (const c of hl ? HIGHLIGHTER_PALETTE : PEN_COLORS) {
      const dot = colorRow.createEl("button", {
        cls: "mb-pen-pop-dot" + (hl ? " is-hl" : ""),
        attr: { type: "button", "aria-label": "颜色 " + c },
      });
      dot.style.background = c;
      dot.dataset.color = c;
      dot.title = hl ? "荧光笔颜色" : "笔颜色";
      dot.onclick = () => {
        if (hl) {
          this.editor?.setHighlighterColor(c);
          this.plugin.settings.lastHighlighterColor = c;
        } else {
          this.editor?.setPenColor(c);
          this.plugin.settings.lastPenColor = c;
        }
        void this.plugin.saveSettings();
        this.updateUI();
        this.syncPenPopActive();
      };
    }
    this.mountColorGlassRing(colorRow, ".mb-pen-pop-dot");

    if (isShape) {
      /*
       * 形状：种类（矩形/椭圆/直线/箭头）一排按钮。形状用 penColor 落笔，
       * 上面的色点行就是它的颜色；这里不再放粗细（形状没有粗细档，只有滑杆）。
       */
      const kindRow = el.createDiv("mb-pen-pop-row mb-pen-pop-shapes");
      for (const sh of SHAPES) {
        const b = kindRow.createEl("button", {
          cls: "mb-pen-pop-shape",
          text: sh.label,
          attr: { type: "button", "data-shape": sh.id },
        });
        b.onclick = () => {
          this.editor?.setShapeKind(sh.id);
          this.syncPenPopActive();
        };
      }
      this.mountSegPill(kindRow, ".mb-pen-pop-shape");
      // 形状用 penSize 当线宽：把粗细滑杆也放进它自己的浮层（侧栏不再有滑动条）
      this.addPenThicknessSlider(el, "shape");
    } else {
      const sizeRow = el.createDiv("mb-pen-pop-row");
      const sizes = hl ? HIGHLIGHTER_SIZES : PEN_SIZES;
      for (let i = 0; i < sizes.length; i++) {
        const b = sizeRow.createEl("button", {
          cls: "mb-pen-pop-size",
          text: ["细", "中", "粗"][i],
          attr: { type: "button", "data-size": String(sizes[i]) },
        });
        b.title = (hl ? "荧光笔" : "笔") + "粗细：" + b.textContent;
        b.onclick = () => {
          if (hl) {
            this.editor?.setHighlighterSize(sizes[i]);
            this.plugin.settings.defaultHighlighterSize = sizes[i];
          } else if (tool === "ballpoint") {
            // 圆珠笔有自己的一份粗细，不写进钢笔的 defaultPenSize
            this.editor?.setBallpointSize(sizes[i]);
            this.plugin.settings.defaultBallpointSize = sizes[i];
          } else {
            this.editor?.setPenSize(sizes[i]);
            this.plugin.settings.defaultPenSize = sizes[i];
          }
          void this.plugin.saveSettings();
          this.updateUI();
          this.syncPenPopActive();
        };
      }
      this.mountSegPill(sizeRow, ".mb-pen-pop-size");
      // 预置「细/中/粗」之外，再加一根滑杆，直接拖到任意具体粗细
      this.addPenThicknessSlider(el, tool);
      // 一笔成型：钢笔 / 圆珠笔的弹框里放一个开 / 关（用户要求「加在每个笔下边
      // 弹出的框里，只有打开和关闭，画完立马识别」）。荧光笔不参与识别，不放。
      if (tool === "pen" || tool === "ballpoint") this.addPenPopSnapToggle(el);
    }

    this.mountPopover(el, anchor, () => this.syncPenPopActive());
  }

  /**
   * 在同一支笔的弹出调节框里加一根「具体粗细」滑杆 + 数值标签。
   *
   * 用户要求把调粗细全部放到每支笔自己的调节框里，不再去侧栏拖滑动条：
   * 预置档（细/中/粗）给习惯快速切的，这根滑杆给要微调的情况，二者共用
   * 同一份粗细值。取值范围与设置页滑杆一致：钢笔 1~8、荧光笔 4~40、形状 1~8。
   *
   * 拖动时用 `silent=true`（不 emitState），避免一次拖动触发几十次整块
   * updateUI；松手（change）再写回 settings，和侧栏旧滑杆的做法一致。
   */
  private addPenThicknessSlider(el: HTMLElement, tool: ToolId): void {
    const hl = tool === "highlighter";
    const st = this.editor?.getState();
    /*
     * 读哪份粗细由**浮层属于哪支笔 / 哪个形状**决定（tool），不是 editor.tool：
     * 钢笔 / 圆珠笔 / 每种形状各记各的，浮层打开期间切工具也不能串。
     */
    const cur = hl
      ? st?.highlighterSize ?? HIGHLIGHTER_SIZES[1]
      : tool === "ballpoint"
        ? st?.ballpointSize ?? PEN_SIZES[1]
        : tool === "shape"
          ? st?.shapeSize ?? PEN_SIZES[1]
          : st?.penSize ?? PEN_SIZES[1];
    const row = el.createDiv("mb-pen-pop-row mb-pen-pop-thickness");
    const range = row.createEl("input", {
      cls: "mb-range mb-pen-pop-range",
      attr: {
        type: "range",
        min: hl ? "4" : "1",
        max: hl ? "40" : "8",
        step: "0.1",
        value: String(cur),
        "aria-label": hl ? "荧光笔粗细" : tool === "shape" ? "形状线宽" : "笔粗细",
      },
    });
    const lbl = row.createSpan({ cls: "mb-size-lbl", text: String(Math.round(cur * 10) / 10) });
    range.oninput = () => {
      if (!this.editor) return;
      const v = Number(range.value);
      if (hl) this.editor.setHighlighterSize(v, true);
      else if (tool === "ballpoint") this.editor.setBallpointSize(v, true);
      else if (tool === "shape") this.editor.setShapeSize(this.editor.shapeKind, v, true);
      else this.editor.setPenSize(v, true);
      lbl.setText(String(Math.round(v * 10) / 10));
      // 顺带把预置档的高亮跟着滑杆走（滑到非预置值时三个档都不亮）
      this.syncPenPopActive();
    };
    range.onchange = () => {
      if (!this.editor) return;
      const v = Number(range.value);
      if (hl) this.plugin.settings.defaultHighlighterSize = v;
      else if (tool === "ballpoint") this.plugin.settings.defaultBallpointSize = v;
      else if (tool === "shape") {
        // 写回这一类形状自己的默认值，别的形状与笔不受影响
        const kind = this.editor.shapeKind;
        this.plugin.settings.defaultShapeSizes = {
          ...this.plugin.settings.defaultShapeSizes,
          [kind]: v,
        };
      } else this.plugin.settings.defaultPenSize = v;
      void this.plugin.saveSettings();
    };
  }

  /**
   * 钢笔 / 圆珠笔弹框里的「一笔成型」开 / 关。
   *
   * 用户要求（2026-11-17）：一笔成型只留在每支笔的弹框里，只有打开和关闭，
   * 画完立刻识别——不再有侧栏「关 / 停留 / 抬笔」三态，也不再需要先停笔预览。
   * 打开 = shapeSnap 置 "lift"（抬笔即识别），关闭 = "off"。与当前笔无关，
   * 是全局开关；改完写回 settings，和其它视图 / 设置页同步。
   */
  private addPenPopSnapToggle(el: HTMLElement): void {
    const row = el.createDiv("mb-pen-pop-row mb-pen-pop-snaprow");
    row.createSpan({ cls: "mb-pen-pop-snaplabel", text: "一笔成型" });
    const seg = row.createDiv("mb-seg mb-pen-pop-snap");
    for (const m of [
      { id: "off", label: "关" },
      { id: "on", label: "开" },
    ] as const) {
      const b = seg.createEl("button", {
        cls: "mb-pen-pop-snapbtn",
        text: m.label,
        attr: { type: "button", "data-snap": m.id },
      });
      b.title = m.id === "on" ? "开启：画完一笔自动识别成矩形 / 椭圆 / 直线 / 箭头" : "关闭：保持原始手写笔迹";
      b.onclick = () => {
        if (!this.editor) return;
        const on = m.id === "on";
        this.plugin.settings.shapeSnap = on ? "lift" : "off";
        this.editor.setShapeSnap(on ? "lift" : "off");
        void this.plugin.saveSettings();
        this.syncPenPopActive();
      };
    }
    this.mountSegPill(seg, ".mb-pen-pop-snapbtn");
  }

  /**
   * 把一个已建好的浮层挂到 body：定位到锚点按钮正下方，并挂上「点外部 /
   * Esc / 滚动或转屏就收起」的监听。笔、形状、文字、橡皮四种浮层共用这段。
   */
  private mountPopover(el: HTMLElement, anchor: HTMLElement, sync?: () => void): void {
    this.penPopEl = el;
    this.penPopAnchorEl = anchor;
    anchor.setAttribute("aria-expanded", "true");
    /*
     * 把所有控件包进一层 .mb-pen-pop-inner：外层 .mb-pen-pop 承载磨砂玻璃
     * （backdrop-filter），只做透明度淡入、**不缩放**；缩放动画作用在这层
     * 内容容器上。这样磨砂层始终按最终尺寸栅格化，打开时不会先糊一下再变清
     * （用户反馈的「一开始很模糊，得加载一下才变成那种质感」）。详见 styles.css
     * 里 .mb-pen-pop / @keyframes mb-pen-pop-inner-* 的注释。
     */
    const inner = document.createElement("div");
    inner.className = "mb-pen-pop-inner";
    while (el.firstChild) inner.appendChild(el.firstChild);
    el.appendChild(inner);
    document.body.appendChild(el);
    sync?.();
    this.positionPenPop(el, anchor);

    /*
     * 关闭条件：点外部 / Esc / 滚动或转屏（位置会飘）。
     * 用 pointerdown 而不是 click：手指还没抬起就把浮层收掉，不会
     * 出现"点完别处又触发一次那边按钮"的错位。当次点击的 pointerdown
     * 早已在 onclick 之前派发完毕，所以监听挂上时不会立刻自关。
     */
    const onDown = (e: Event) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (el.contains(t) || anchor.contains(t)) return;
      this.closePenPop(true); // 点外部收起：播收起动画
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 别让 Esc 继续传下去（编辑框等还有自己的 Esc 处理）
      e.stopPropagation();
      this.closePenPop(true); // Esc 收起：播收起动画
    };
    const onMove = () => this.closePenPop(true); // 滚动 / 转屏收起：播收起动画
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    this.penPopDetach = [
      () => document.removeEventListener("pointerdown", onDown, true),
      () => document.removeEventListener("keydown", onKey, true),
      () => window.removeEventListener("resize", onMove),
      () => window.removeEventListener("scroll", onMove, true),
    ];
  }

  /**
   * 浮层定位：按钮正下方居中，窄屏时左右夹进视口，下面放不下就翻到上方。
   *
   * 先 visibility:hidden 挂到 (0,0) 量自然尺寸——position:fixed 且
   * left/top 都为 0 时是 shrink-to-fit，量到的就是它真正要占的宽高；
   * 拿到宽高后再夹 left，横竖屏 / 平板窄边都不会被裁掉。
   */
  private positionPenPop(el: HTMLElement, anchor: HTMLElement): void {
    const r = anchor.getBoundingClientRect();
    el.style.visibility = "hidden";
    el.style.left = "0px";
    el.style.top = "0px";
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const margin = 8;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
    let top = r.bottom + 6;
    let above = false;
    if (top + h > window.innerHeight - margin) {
      // 下方真的放不下（横屏顶栏贴近底边等极端情况）：翻到按钮上方
      top = Math.max(margin, r.top - h - 6);
      above = true;
    }
    const leftPx = Math.round(left);
    const topPx = Math.round(top);
    el.style.left = leftPx + "px";
    el.style.top = topPx + "px";
    // 缩放原点钉在锚点按钮的中心：看上去像从这枚方形按钮里弹出来 / 缩回去
    // （iPhone 菜单从触发点展开那种感觉），而不是从浮层自身的边缘缩放。
    // 用像素值写进自定义属性，CSS 的 transform-origin 直接取用。
    el.style.setProperty("--mb-pop-origin-x", Math.round(r.left + r.width / 2 - leftPx) + "px");
    el.style.setProperty("--mb-pop-origin-y", Math.round(r.top + r.height / 2 - topPx) + "px");
    // 出场动画的位移方向跟着放在按钮上边还是下边走
    el.toggleClass("mb-pen-pop-above", above);
    el.style.visibility = "visible";
    this.playPenPopIn(el);
  }

  /**
   * 弹出调节框的出场动画：从锚点按钮那一侧「弹」出来。
   *
   * 只在量好位置、可见之后再加临时类，动画时钟才不会在 visibility:hidden
   * 期间空跑；keyframes 只动 transform + opacity（GPU 合成，不触发布局）。
   * 动画结束（或超时兜底）摘掉类，避免残留 transform 影响下次量尺寸。
   */
  private playPenPopIn(el: HTMLElement): void {
    const cls = "mb-pen-pop-anim";
    el.classList.remove(cls);
    void el.offsetWidth; // 强制重排：连续快速开合时也能从头重放
    el.classList.add(cls);
    if (this.penPopAnimTimer) window.clearTimeout(this.penPopAnimTimer);
    this.penPopAnimTimer = window.setTimeout(() => {
      el.classList.remove(cls);
      this.penPopAnimTimer = 0;
    }, 320);
  }

  /**
   * 给一行颜色点挂一枚会滑动的玻璃选中框。
   *
   * 颜色点和工具行不同：不能把紫色底铺在圆点下面，否则会把用户选的颜色
   * 洗掉。这里用一圈透明玻璃框圈住当前色点，切换颜色时由 SlidePill 平移
   * 过去；色点自己只保留玻璃珠高光，不再画静态描边（否则会叠成双层）。
   */
  private mountColorGlassRing(host: HTMLElement, activeSelector: string): SlidePill {
    host.addClass("mb-color-glass-host");
    const pill = new SlidePill(host, {
      className: "mb-color-glass-pill",
      expand: 3,
      activeSelector,
      // 浮层内层有 scale 出场动画；offset* 不受祖先缩放影响，量得更稳
      measure: "offset",
    });
    this.colorPills.push(pill);
    pill.layout(true);
    return pill;
  }

  /** 颜色选中态变化后让玻璃框滑到新的色点；顺手清掉随 DOM 重建掉队的框 */
  private syncColorGlassRings(): void {
    const keep: SlidePill[] = [];
    for (const pill of this.colorPills) {
      if (!pill.host.isConnected) {
        pill.destroy();
        continue;
      }
      pill.layout();
      keep.push(pill);
    }
    this.colorPills = keep;
  }

  /**
   * 给「细/中/粗、字号、形状种类」这样的一排按钮挂一枚会滑动的紫色高亮片，
   * 效果和顶栏切换各个笔时一致（SlidePill）。measure:"offset" 保证在浮层
   * 出场 scale 动画期间也量得准。
   */
  private mountSegPill(host: HTMLElement, activeSelector: string): SlidePill {
    host.addClass("mb-seg-row");
    const pill = new SlidePill(host, { activeSelector, measure: "offset" });
    this.segPills.push(pill);
    pill.layout(true);
    return pill;
  }

  /** 选中项变化后让分段高亮片滑过去；顺手清掉随 DOM 重建掉队的片 */
  private syncSegPills(): void {
    const keep: SlidePill[] = [];
    for (const pill of this.segPills) {
      if (!pill.host.isConnected) {
        pill.destroy();
        continue;
      }
      pill.layout();
      keep.push(pill);
    }
    this.segPills = keep;
  }

  /** 同步浮层里的选中态（当前色 / 当前粗细 / 当前形状种类），不重建 DOM */
  private syncPenPopActive(): void {
    const el = this.penPopEl;
    if (!el || !this.editor) return;
    const s = this.editor.getState();
    // 以「浮层属于哪支笔」为准：钢笔 / 圆珠笔 / 各形状的粗细是分开的
    const tool = this.penPopTool ?? s.tool;
    const hl = tool === "highlighter";
    const color = (hl ? s.highlighterColor : s.penColor).toLowerCase();
    const size = hl
      ? s.highlighterSize
      : tool === "ballpoint"
        ? s.ballpointSize
        : tool === "shape"
          ? s.shapeSize
          : s.penSize;
    for (const dot of Array.from(el.querySelectorAll<HTMLElement>(".mb-pen-pop-dot"))) {
      dot.toggleClass("is-active", (dot.dataset.color || "").toLowerCase() === color);
    }
    for (const b of Array.from(el.querySelectorAll<HTMLElement>(".mb-pen-pop-size"))) {
      b.toggleClass("is-active", Math.abs(Number(b.dataset.size) - size) < 0.01);
    }
    // 具体粗细滑杆与数值标签：形状读当前 shapeKind 对应的那份线宽
    const thickVal = size;
    const range = el.querySelector<HTMLInputElement>(".mb-pen-pop-range");
    if (range && document.activeElement !== range) range.value = String(Math.round(thickVal * 10) / 10);
    const thickLbl = el.querySelector<HTMLElement>(".mb-pen-pop-thickness .mb-size-lbl");
    if (thickLbl) thickLbl.setText(String(Math.round(thickVal * 10) / 10));
    if (tool === "shape") {
      const kind = this.editor.shapeKind;
      for (const b of Array.from(el.querySelectorAll<HTMLElement>(".mb-pen-pop-shape"))) {
        b.toggleClass("is-active", (b.dataset.shape || "") === kind);
      }
    }
    if (tool === "pen" || tool === "ballpoint") {
      const on = normalizeShapeSnap(this.plugin.settings.shapeSnap) !== "off";
      for (const b of Array.from(el.querySelectorAll<HTMLElement>(".mb-pen-pop-snapbtn"))) {
        b.toggleClass("is-active", (b.dataset.snap === "on") === on);
      }
    }
    this.syncColorGlassRings();
    this.syncSegPills();
  }

  /* -------------------- 文字 / 橡皮 浮层（与笔同款） -------------------- */

  /** 文字工具：字号档 + 字体 + 颜色，按钮正下方弹出 */
  private openTextPop(anchor: HTMLElement): void {
    this.closePenPop();
    const el = document.body.createDiv("mb-pen-pop");
    if (this.tabletMode) el.addClass("mb-pen-pop-tablet");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "文字字号、字体与颜色");

    const sizeRow = el.createDiv("mb-pen-pop-row");
    for (const n of [14, 18, 24, 32]) {
      const b = sizeRow.createEl("button", {
        cls: "mb-pen-pop-size",
        text: String(n),
        attr: { type: "button", "data-size": String(n) },
      });
      b.title = "字号 " + n;
      b.onclick = () => {
        this.editor?.setTextSize(n);
        this.syncTextPopActive();
      };
    }
    this.mountSegPill(sizeRow, ".mb-pen-pop-size");

    const fontRow = el.createDiv("mb-pen-pop-row");
    const fontSel = fontRow.createEl("select", { cls: "mb-font-sel mb-pen-pop-font dropdown" });
    fontSel.title = "字体";
    for (const f of TEXT_FONTS) {
      const opt = fontSel.createEl("option", { text: f.label, value: f.id });
      if (this.editor?.getState().textFont === f.id) opt.selected = true;
    }
    fontSel.onchange = () => this.editor?.setTextFont(fontSel.value);

    const colorRow = el.createDiv("mb-pen-pop-row mb-pen-pop-colors");
    for (const c of PEN_COLORS) {
      const dot = colorRow.createEl("button", {
        cls: "mb-pen-pop-dot",
        attr: { type: "button", "aria-label": "文字颜色 " + c },
      });
      dot.style.background = c;
      dot.dataset.color = c;
      dot.title = c;
      dot.onclick = () => {
        this.editor?.setTextColor(c);
        this.syncTextPopActive();
      };
    }
    this.mountColorGlassRing(colorRow, ".mb-pen-pop-dot");

    // 「插入双链」：选一篇笔记，在当前文字框里插入 [[笔记名]]，之后点它即可跳转
    const linkRow = el.createDiv("mb-pen-pop-row");
    const linkBtn = linkRow.createEl("button", {
      cls: "mb-pen-pop-link",
      text: "插入双链…",
      attr: { type: "button", "aria-label": "插入双链到其他笔记" },
    });
    linkBtn.title = "插入双链：选一篇笔记，插入 [[笔记名]]，点它即可跳转到那篇笔记";
    linkBtn.onclick = () => {
      this.closePenPop();
      this.openInsertLink();
    };

    this.mountPopover(el, anchor, () => this.syncTextPopActive());
  }

  private syncTextPopActive(): void {
    const el = this.penPopEl;
    if (!el || !this.editor) return;
    const s = this.editor.getState();
    const size = Math.round(s.textSize);
    for (const b of Array.from(el.querySelectorAll<HTMLElement>(".mb-pen-pop-size"))) {
      b.toggleClass("is-active", Number(b.dataset.size) === size);
    }
    const fs = el.querySelector<HTMLSelectElement>(".mb-pen-pop-font");
    if (fs && fs.value !== s.textFont) fs.value = s.textFont;
    const tc = (s.textColor || "").toLowerCase();
    for (const d of Array.from(el.querySelectorAll<HTMLElement>(".mb-pen-pop-dot"))) {
      d.toggleClass("is-active", (d.dataset.color || "").toLowerCase() === tc);
    }
    this.syncColorGlassRings();
    this.syncSegPills();
  }

  /** 橡皮工具：整笔/局部 + 大小滑杆，按钮正下方弹出 */
  private openEraserPop(anchor: HTMLElement): void {
    this.closePenPop();
    const el = document.body.createDiv("mb-pen-pop");
    if (this.tabletMode) el.addClass("mb-pen-pop-tablet");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "橡皮模式与大小");

    const modeRow = el.createDiv("mb-pen-pop-row");
    for (const m of [
      { id: "whole", label: "整笔" },
      { id: "part", label: "局部" },
    ] as const) {
      const b = modeRow.createEl("button", {
        cls: "mb-pen-pop-shape",
        text: m.label,
        attr: { type: "button", "data-mode": m.id },
      });
      b.onclick = () => {
        this.editor?.setEraserMode(m.id);
        // 记忆到设置：下次按下橡皮直接沿用，切本/重启也不丢
        this.plugin.settings.lastEraserMode = m.id;
        void this.plugin.saveSettings();
        this.syncEraserPopActive();
      };
    }
    this.mountSegPill(modeRow, ".mb-pen-pop-shape");

    const sizeRow = el.createDiv("mb-pen-pop-row");
    const range = sizeRow.createEl("input", {
      cls: "mb-range mb-pen-pop-range",
      attr: {
        type: "range",
        min: "6",
        max: "60",
        step: "1",
        value: String(this.editor?.eraserSize ?? 26),
      },
    });
    const lbl = sizeRow.createSpan({
      cls: "mb-size-lbl",
      text: String(this.editor?.eraserSize ?? 26),
    });
    range.oninput = () => {
      if (!this.editor) return;
      this.editor.eraserSize = Number(range.value);
      lbl.setText(range.value);
    };
    range.onchange = () => {
      // 松手才写盘（拖动期间会连发几十个 oninput，避免反复存盘）
      this.plugin.settings.lastEraserSize = Number(range.value);
      void this.plugin.saveSettings();
    };

    this.mountPopover(el, anchor, () => this.syncEraserPopActive());
  }

  private syncEraserPopActive(): void {
    const el = this.penPopEl;
    if (!el || !this.editor) return;
    const mode = this.editor.eraserMode === "whole" ? "whole" : "part";
    for (const b of Array.from(el.querySelectorAll<HTMLElement>(".mb-pen-pop-shape"))) {
      b.toggleClass("is-active", (b.dataset.mode || "") === mode);
    }
    const range = el.querySelector<HTMLInputElement>(".mb-range");
    if (range && document.activeElement !== range) range.value = String(this.editor.eraserSize);
    const lbl = el.querySelector<HTMLElement>(".mb-size-lbl");
    if (lbl) lbl.setText(String(this.editor.eraserSize));
    this.syncSegPills();
  }

  /**
   * 收起快捷笔盒，并摘掉打开期间挂上的所有监听。
   *
   * `animate=true` 用于**用户主动收起**（再点按钮 / 点外部 / Esc / 滚动转屏）：
   * 浮层先缩回按钮方向、淡出，动画结束再从 DOM 移除，做到「有始有终」。
   * 内部重建 / 切换浮层 / 关视图这类程序化收起一律用默认的立即移除，
   * `penPopEl` 在返回时已经为 null，调用方可以马上打开新的浮层。
   */
  private closePenPop(animate = false): void {
    for (const off of this.penPopDetach) off();
    this.penPopDetach = [];
    if (this.penPopAnimTimer) {
      window.clearTimeout(this.penPopAnimTimer);
      this.penPopAnimTimer = 0;
    }
    const el = this.penPopEl;
    this.penPopEl = null;
    this.penPopTool = null;
    this.penPopAnchorEl?.setAttribute("aria-expanded", "false");
    this.penPopAnchorEl = null;
    // 先清掉上一条仍在做收起动画的节点，避免快速开合时叠出两个浮层
    if (this.penPopCloseTimer) {
      window.clearTimeout(this.penPopCloseTimer);
      this.penPopCloseTimer = 0;
    }
    this.penPopClosingEl?.remove();
    this.penPopClosingEl = null;
    if (!el) return;
    if (animate && !this.prefersReducedMotion()) {
      el.classList.remove("mb-pen-pop-anim");
      void el.offsetWidth; // 重排：保证收起 keyframes 从头播
      el.classList.add("mb-pen-pop-anim-out");
      this.penPopClosingEl = el;
      this.penPopCloseTimer = window.setTimeout(() => {
        el.remove();
        this.syncColorGlassRings();
        if (this.penPopClosingEl === el) this.penPopClosingEl = null;
        this.penPopCloseTimer = 0;
      }, 220);
      return;
    }
    el.remove();
    this.syncColorGlassRings();
  }

  /* --------------------------- 顶栏上的那一行 --------------------------- */

  /**
   * 顶栏那一行：**8 支笔 + 保存 / 侧栏**，一起挂到标题栏。
   *
   * 用宿主的 addAction 拿到原生位置与点击区域，再把图标换成自绘的：
   * 宿主图标集里查不到的 name 会画成空框，这个坑踩过。
   *
   * 笔原先浮在纸上（可拖动、可切横竖），平板上一列 86px 白白占掉；
   * 顶栏本来就有空位，一行排得下——纸面因此通栏。
   */
  private buildHeaderActions(): void {
    // 同一视图里换文件会重装顶栏：先把上一轮的整行摘掉，否则越堆越多
    this.topRowEl?.remove();
    this.topBarEl?.remove();
    this.topRowEl = null;
    this.topBarEl = null;

    const mk = (icon: string, title: string, cls: string): HTMLElement => {
      let el: HTMLElement | null = null;
      const make = (this as unknown as {
        addAction?: (i: string, t: string, cb: () => void) => HTMLElement | undefined;
      }).addAction;
      if (typeof make === "function") {
        const made = make.call(this, icon, title, () => {});
        // 测试桩的 addAction 是空实现（返回 undefined），必须判一下
        if (made && typeof (made as HTMLElement).addClass === "function") el = made;
      }
      if (!el) {
        /*
         * 宿主没有 addAction（测试桩 / 极老版本）：退到容器里自己建一个。
         * 位置不完美，但点击行为与真实环境一致，
         * 「点一下写不写盘」这类断言就不用依赖宿主实现。
         */
        el = document.createElement("div");
        const host = this.containerEl as unknown as { appendChild?: (n: Node) => void } | undefined;
        if (host && typeof host.appendChild === "function") host.appendChild(el);
      }
      el.addClass(cls);
      el.addClass("mb-topbtn");
      el.empty();
      setIcon(el, icon);
      el.setAttr("aria-label", title);
      el.title = title;
      return el;
    };

    const save = mk("save", "保存（立即写入磁盘）", "mb-rail-save");
    save.onclick = () => void this.requestSave();
    this.railSaveBtn = save;

    const side = mk("panel-right", "显示 / 隐藏侧栏", "mb-rail-side");
    side.setAttr("aria-expanded", "false");
    side.setAttr("aria-controls", "mb-side");
    side.onclick = () => this.toggleSide();
    this.railSideBtn = side;
    this.sideBtn = side;

    /*
     * 「页面/目录」抽屉开关：放进顶栏工具行（和钢笔同一排），
     * 取代原先浮在纸面左上角的手柄——用户要求像 Obsidian 原生 PDF 阅读器
     * 那样，把缩略图开关放到顶部那一框里。
     */
    const dock = mk("layout-grid", "页面与目录", "mb-rail-dock");
    dock.setAttr("aria-expanded", String(this.pagedockOpen));
    dock.onclick = () => this.togglePageDock();
    this.dockBtn = dock;

    /*
     * 「插入图片」：把一张图片贴到当前页。放在顶栏动作行（与保存/侧栏/目录并列），
     * 这是"往纸上放东西"的入口，和画/写一样常用，不该埋进菜单里找不到。
     */
    const insertImg = mk("image", "插入图片", "mb-rail-image");
    insertImg.onclick = () => this.openInsertImage();
    this.railImageBtn = insertImg;

    /*
     * 「插入文件块」：把 Excalidraw 导图 / 笔记 / 文本文件作为可摆放的卡片贴到当前页，
     * 直接显示内容，像 Obsidian 白板的文件卡片。
     */
    const insertBlock = mk("file-text", "插入文件块（Excalidraw / 笔记 / 文本）", "mb-rail-fileblock");
    insertBlock.onclick = () => this.openInsertFileBlock();
    this.railFileBlockBtn = insertBlock;

    /*
     * 「在当前笔记里查找」：平板上没有 Ctrl/⌘+F，得留一颗能直接点的按钮。
     * 顶栏放不下时 fitTopRow 会把整行搬进自建顶栏，按钮一样够得着。
     */
    const findBtn = mk("search", "在当前笔记中查找文字", "mb-rail-find");
    findBtn.onclick = () => this.openFindBar();
    this.railFindBtn = findBtn;

    /*
     * 组装：宿主 action 原本挂在 .view-actions 里，
     * 把整行塞进同一个父容器，才能和宿主自己的按钮并排成一行。
     * 父容器摸不到（测试桩 / 老旧版本）就退到视图自己身上。
     */
    const row = document.createElement("div");
    row.className = "mb-toprow";
    const host = (save.parentElement as HTMLElement | null) || this.containerEl;
    this.actionsHostEl = host;
    host.appendChild(row);
    /*
     * 顺序按用户要求：左边抽屉（缩略图）开关放到整行最左，
     * 右边侧栏开关放到整行最右。中间仍是「笔工具组 | 竖线 | 其余动作」，
     * 13 个按钮一个不少，便于从两端一眼找到两个面板开关。
     */
    row.appendChild(dock);
    this.buildToolRow(row);
    row.appendChild(row.createDiv("mb-sep"));
    row.appendChild(save);
    row.appendChild(insertImg);
    row.appendChild(insertBlock);
    row.appendChild(findBtn);
    row.appendChild(side);
    this.topRowEl = row;
  }

  /* ------------------ 标题栏放不下时：整行搬到自建顶栏条 ------------------ */

  private topFitRaf = 0;
  /** 高频状态 / 翻页通知合并到下一帧的 updateUI，避免捏合和快滚时重复刷整条 UI */
  private uiUpdateRaf = 0;

  /**
   * 捏合、连续滚动会连发 onState / onPageChange；编辑器自己已有 rAF 合并，
   * 这里再合并一次，保证同一帧最多跑一次较重的 updateUI。其他用户动作
   * 仍直接调用 updateUI()，保持「点完立刻反馈」。
   */
  private scheduleUIUpdate(): void {
    if (this.uiUpdateRaf) return;
    const raf =
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : (fn: FrameRequestCallback) => window.setTimeout(() => fn(0), 16);
    this.uiUpdateRaf = raf(() => {
      this.uiUpdateRaf = 0;
      this.updateUI();
    });
  }

  /** 视图卸载时撤掉在途帧，别让旧编辑器的 UI 回调跨文件残留 */
  private cancelUIUpdateRaf(): void {
    if (!this.uiUpdateRaf) return;
    if (typeof window.cancelAnimationFrame === "function")
      window.cancelAnimationFrame(this.uiUpdateRaf);
    else window.clearTimeout(this.uiUpdateRaf);
    this.uiUpdateRaf = 0;
  }

  private scheduleTopRowFit(): void {
    if (this.topFitRaf) return;
    const raf =
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : (fn: FrameRequestCallback) => window.setTimeout(() => fn(0), 16);
    this.topFitRaf = raf(() => {
      this.topFitRaf = 0;
      this.fitTopRow();
    });
  }

  /**
   * 十个按钮在标题栏里排不下时怎么办。
   *
   * 平板真机：宿主的 action 容器比这一行窄得多，行被压成一小团，
   * 看着就像"整排只剩一个按钮"。压着不是办法——那样按钮根本点不到。
   * 所以量一下：越界就把整行搬到视图自己画的一条顶栏里（宽度我们自己说了算），
   * 窗口变宽、标题栏装得下了再搬回去。
   */
  private fitTopRow(): void {
    const row = this.topRowEl;
    const host = this.actionsHostEl;
    if (!row || !host || !host.isConnected) return;
    const hr = host.getBoundingClientRect();
    const view = this.containerEl.getBoundingClientRect();
    if (!hr.width || !view.width) return;

    const need = row.scrollWidth;
    if (!need) return;

    if (this.topBarEl && row.parentElement === this.topBarEl) {
      // 已经搬下来了：只有容器明显宽裕才搬回，免得跟裁剪判断来回横跳
      if (need + 80 <= hr.width) this.undockTopRow();
      return;
    }

    const rr = row.getBoundingClientRect();
    if (rr.width <= 0) return;
    /*
     * 三种"放不下"都要认：
     *   · 容器比整行窄（flex 把行压扁，看着像只剩一个按钮）
     *   · 整行被挤出视图右缘（裁剪掉了，后面的按钮点不到）
     *   · **被祖先裁掉左半边**——真机上最常见：行里最右三个动作按钮还露着，
     *     左边七个笔全被切走，看着像"笔没有图标"。父容器宽度可能正好等于整行，
     *     量 rect 量不出来，只能点一下试试：那个位置现在是不是还属于这一行。
     */
    const clipped =
      need > hr.width + 1 ||
      rr.right > view.right + 1 ||
      rr.left < view.left - 1 ||
      this.isClippedByAncestor(row, rr);
    if (clipped) this.dockTopRow(row);
  }

  /**
   * 这一行有没有被某个祖先裁掉一部分。
   *
   * 真机上最常见的形态不是"压扁"，而是被 `overflow:hidden` 的父容器
   * 切掉左半边——右边三个动作按钮还露着，左边七个笔全没了，
   * 看上去就像"笔没有图标"。父容器宽度可能正好等于整行，量 rect 量不出来，
   * 只能顺着祖先往上找：谁家设了 overflow，就比一次框。
   *
   * 不用 elementFromPoint：测试页的输出面板是 fixed 盖在左上角的，
   * 那种"被别人压着"不等于"被裁掉"，会误判。
   */
  private isClippedByAncestor(el: HTMLElement, rect: DOMRect): boolean {
    let p = el.parentElement;
    let guard = 0;
    while (p && p !== document.body && guard++ < 40) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        const pr = p.getBoundingClientRect();
        if (
          rect.left < pr.left - 1 ||
          rect.right > pr.right + 1 ||
          rect.top < pr.top - 1 ||
          rect.bottom > pr.bottom + 1
        ) {
          return true;
        }
      }
      p = p.parentElement;
    }
    return false;
  }

  private dockTopRow(row: HTMLElement): void {
    const bar = this.contentEl.createDiv("mb-topbar");
    bar.appendChild(row);
    this.contentEl.insertBefore(bar, this.contentEl.firstChild);
    this.topBarEl = bar;
    this.contentEl.addClass("has-topbar");
  }

  private undockTopRow(): void {
    const row = this.topRowEl;
    const host = this.actionsHostEl;
    if (!row || !host) return;
    host.appendChild(row);
    this.topBarEl?.remove();
    this.topBarEl = null;
    this.contentEl.removeClass("has-topbar");
  }

  private buildFloat(): void {
    this.floatEl?.remove();
    const float = this.paperHost.createDiv("mb-float");
    this.floatEl = float;
    this.floatUndoBtn = null;
    this.floatRedoBtn = null;

    /*
     * 撤销组：常驻，与翻页组并列。
     *
     * 侧栏默认收起（平板上尤其如此），撤销/重做又只能进侧栏找——
     * 写错一笔要「点侧栏 → 滚到顶部 → 点撤销」，没键盘就撤不了。
     * 放在浮标里，落笔后手不用离开纸面右下角。
     *
     * 放在翻页组**左边**：浮标右对齐，翻页组仍在最右角，
     * 原有肌肉记忆不变，新增的两键只向左延伸一点。
     */
    const edit = float.createDiv("mb-float-edit");
    const undo = edit.createEl("button", {
      cls: "mb-float-btn",
      attr: { "aria-label": "撤销" },
    });
    setIcon(undo, "undo-2");
    undo.title = "撤销 (Ctrl+Z)";
    undo.onclick = () => this.editor?.undo();
    this.floatUndoBtn = undo;
    const redo = edit.createEl("button", {
      cls: "mb-float-btn",
      attr: { "aria-label": "重做" },
    });
    setIcon(redo, "redo-2");
    redo.title = "重做 (Ctrl+Shift+Z)";
    redo.onclick = () => this.editor?.redo();
    this.floatRedoBtn = redo;

    /* 翻页组：常驻，很小 */
    const nav = float.createDiv("mb-float-nav");
    const prev = nav.createEl("button", {
      cls: "mb-float-btn",
      attr: { "aria-label": "上一页" },
    });
    setIcon(prev, "chevron-left");
    prev.title = "上一页";
    prev.onclick = () => {
      const st = this.editor?.getState();
      if (!st) return;
      const target = Math.max(0, st.pageIndex - 1);
      // 页码先跳到目标页，页面再平滑滑过去（用户要的「页码先到、页面同步滑」）
      this.pageLbl?.setText(`${target + 1} / ${st.pageCount}`);
      this.editor?.goToPage(target);
    };
    this.pageLbl = nav.createEl("button", {
      cls: "mb-float-num",
      attr: { "aria-label": "跳到指定页" },
    });
    this.pageLbl.title = "跳到指定页";
    this.pageLbl.onclick = () => this.openPagePicker();
    const next = nav.createEl("button", {
      cls: "mb-float-btn",
      attr: { "aria-label": "下一页" },
    });
    setIcon(next, "chevron-right");
    next.title = "下一页";
    next.onclick = () => {
      const st = this.editor?.getState();
      if (!st) return;
      const target = Math.min(st.pageCount - 1, st.pageIndex + 1);
      this.pageLbl?.setText(`${target + 1} / ${st.pageCount}`);
      this.editor?.goToPage(target);
    };

    /*
     * 缩放组：默认隐藏，缩放时才出现。
     *
     * 用 `is-show` 控制显隐，宽度用 max-width 过渡，
     * 这样出现/消失是"展开"而不是"突然冒出来"。
     */
    const zoom = float.createDiv("mb-float-zoom");
    this.floatZoomEl = zoom;
    const zo = zoom.createEl("button", {
      cls: "mb-float-btn",
      attr: { "aria-label": "缩小" },
    });
    setIcon(zo, "zoom-out");
    zo.title = "缩小";
    zo.onclick = () => this.editor?.zoomBy(1 / 1.15);
    this.zoomLbl = zoom.createEl("button", {
      cls: "mb-float-num",
      attr: { "aria-label": "整页适应" },
    });
    this.zoomLbl.title = "点一下整页适应";
    this.zoomLbl.onclick = () => this.editor?.fit();
    const zi = zoom.createEl("button", {
      cls: "mb-float-btn",
      attr: { "aria-label": "放大" },
    });
    setIcon(zi, "zoom-in");
    zi.title = "放大";
    zi.onclick = () => this.editor?.zoomBy(1.15);

    /* 悬停时保持缩放组可见，方便连点 */
    float.addEventListener("pointerenter", () => {
      this.zoomHintHover = true;
      window.clearTimeout(this.zoomHintTimer);
    });
    float.addEventListener("pointerleave", () => {
      this.zoomHintHover = false;
      this.scheduleZoomHintHide();
    });
  }

  /**
   * 底部页码点开「点页码直接跳」浮层。
   *
   * 用户要求：每按一下底下的页码就跳到那一页、屏幕滚动到对应位置。
   * 原来这里弹窗再输数字，平板上多一步又慢；改成直接列页码，点哪个跳哪个。
   */
  private openPagePicker(): void {
    if (!this.editor) return;
    this.closePagePicker?.();
    const st = this.editor.getState();
    const total = st.pageCount;
    if (total <= 0) return;
    const cur = st.pageIndex;
    const anchor = this.pageLbl;
    const r = anchor.getBoundingClientRect();

    const pop = document.body.createDiv("mb-pagepick");
    // 与其它弹层同款 q 弹出场（见 styles.css 的 mb-pagepick-in）
    pop.addClass("mb-pagepick-pop");
    pop.style.right = Math.max(8, window.innerWidth - r.right) + "px";
    pop.style.bottom = Math.max(8, window.innerHeight - r.top + 6) + "px";
    pop.style.maxHeight = Math.min(Math.round(window.innerHeight * 0.5), 360) + "px";

    pop.createDiv("mb-pagepick-head").setText(`跳到第几页 · 共 ${total} 页`);
    // 用户要求：直接弹输入框（搜索框），不再列一版页码网格。
    const search = pop.createDiv("mb-pagepick-search");
    const inp = search.createEl("input", {
      cls: "mb-pagepick-input",
      attr: {
        type: "number",
        inputmode: "numeric",
        min: "1",
        max: String(total),
        placeholder: "输入页码",
        "aria-label": "输入要跳到的页码",
      },
    });
    inp.value = String(cur + 1);
    const goBtn = search.createEl("button", {
      cls: "mb-pagepick-go",
      text: "跳转",
      attr: { type: "button" },
    });
    const go = () => {
      const v = Math.round(Number(inp.value));
      if (!Number.isFinite(v)) return;
      const target = Math.min(total - 1, Math.max(0, v - 1));
      this.editor?.goToPage(target);
      this.closePagePicker?.();
    };
    goBtn.onclick = go;
    inp.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        go();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.closePagePicker?.();
      }
    };

    const onDown = (e: Event) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (pop.contains(t) || anchor.contains(t)) return;
      this.closePagePicker?.();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.closePagePicker?.();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    this.closePagePicker = () => {
      pop.remove();
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      this.closePagePicker = null;
    };

    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        inp.focus();
        try { inp.select(); } catch (_) { /* 老引擎不支持就算了 */ }
      });
    }
  }

  /* --------------------------- 笔记内查找文字 --------------------------- */

  /**
   * 打开「在当前笔记中查找」浮条。
   *
   * 交互照 Obsidian 的文件内搜索：Ctrl/⌘+F 或顶栏放大镜打开，输入框里
   * 逐字出结果，Enter / Shift+Enter 或 ↑↓ 上下翻，`N/N` 显示第几条，
   * Esc 收起；命中的字在纸上标黄，当前那条标得更深。
   *
   * 为什么自己画一条而不是直接调宿主的「搜索当前文件」：
   * `.inkbook` 是单个 JSON，正文是 Canvas + 透明文字层，不是 CodeMirror
   * 里的 Markdown 文档。宿主那条命令只认编辑器自己的文档，在这张纸面前
   * 一个字也搜不到。所以搜索逻辑走 `findInNote()`（按页扫 `texts[]`），
   * 高亮走编辑器的文字层，键盘/按钮/浮条的行为跟它保持一致。
   */
  openFindBar(): void {
    if (!this.editor || !this.store || !this.paperHost) return;
    this.buildFindBar();
    this.findState = { query: "", matches: [], index: 0 };
    this.findBarEl?.addClass("is-open");
    const inp = this.findInputEl;
    if (inp) {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          inp.focus();
          try { inp.select(); } catch (_) { /* 老引擎不支持就算了 */ }
        });
      }
    }
    this.runFind();
  }

  /** 懒建浮条：挂在 `.mb-paper` 里，随视图一起生灭，不会残留到别的标签页。 */
  private buildFindBar(): void {
    if (this.findBarEl || !this.paperHost) return;
    const bar = this.paperHost.createDiv("mb-find");
    bar.setAttribute("role", "search");
    bar.setAttribute("aria-label", "在当前笔记中查找文字");
    // 按下浮条别传到纸面（避免在输入框里点一下就落一笔）
    bar.addEventListener("pointerdown", (e) => e.stopPropagation());

    const inp = bar.createEl("input", {
      cls: "mb-find-input",
      attr: {
        type: "text",
        placeholder: "在当前笔记中查找",
        "aria-label": "查找文字",
        spellcheck: "false",
        autocomplete: "off",
      },
    }) as HTMLInputElement;
    this.findInputEl = inp;
    this.findCountEl = bar.createSpan({
      cls: "mb-find-count",
      text: "0/0",
      attr: { "aria-live": "polite" },
    });

    const mkBtn = (icon: string, title: string, cls: string): HTMLElement => {
      const b = bar.createEl("button", {
        cls: "mb-find-btn " + cls,
        attr: { type: "button", "aria-label": title },
      });
      b.title = title;
      setIcon(b, icon);
      return b;
    };
    const prev = mkBtn("chevron-up", "上一个匹配 (Shift+Enter)", "mb-find-prev");
    const next = mkBtn("chevron-down", "下一个匹配 (Enter)", "mb-find-next");
    const close = mkBtn("x", "关闭查找 (Esc)", "mb-find-close");
    prev.onclick = () => { this.flushFind(); this.gotoFindMatch((this.findState?.index ?? 0) - 1); };
    next.onclick = () => { this.flushFind(); this.gotoFindMatch((this.findState?.index ?? 0) + 1); };
    close.onclick = () => this.closeFindBar();

    inp.addEventListener("input", () => this.scheduleFind());
    inp.addEventListener("keydown", (e) => {
      // 输入框里的按键一律不冒给全局快捷键（否则打个 p 就切了钢笔）
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeFindBar();
      } else if (e.key === "Enter") {
        e.preventDefault();
        this.flushFind();
        this.gotoFindMatch((this.findState?.index ?? 0) + (e.shiftKey ? -1 : 1));
      }
    });
    this.findBarEl = bar;
  }

  /** 输入防抖：几百页的本子里逐字重扫全文，不防抖会卡手。 */
  private scheduleFind(): void {
    window.clearTimeout(this.findTimer);
    this.findTimer = window.setTimeout(() => {
      this.findTimer = 0;
      this.runFind();
    }, 140);
  }

  /** Enter / 上下翻之前先把还在排队的那次搜索吃掉，别按旧结果跳。 */
  private flushFind(): void {
    if (!this.findTimer) return;
    window.clearTimeout(this.findTimer);
    this.findTimer = 0;
    this.runFind();
  }

  /** 按当前输入重新收集命中，并落在「当前页起」的第一条上。 */
  private runFind(): void {
    if (!this.findState) return;
    const query = this.findInputEl?.value ?? "";
    const pages = this.store?.data.pages ?? [];
    const matches = findInNote(pages, query, MAX_FIND_MATCHES);
    this.findState = { query, matches, index: 0 };
    if (!matches.length) {
      this.editor?.setFindHighlight(query, null);
      this.updateFindCount();
      return;
    }
    // 从当前所在页往下找，符合「我先在这一页搜」的直觉；到底就回卷到第一页
    const cur = this.editor?.getState().pageIndex ?? 0;
    let start = matches.findIndex((m) => m.page >= cur);
    if (start < 0) start = 0;
    this.gotoFindMatch(start);
  }

  /** 翻到第 i 条命中（越界回卷），翻页 + 高亮 + 刷计数。 */
  private gotoFindMatch(i: number): void {
    const st = this.findState;
    if (!st || !st.matches.length) return;
    const n = st.matches.length;
    const index = ((Math.round(i) % n) + n) % n;
    st.index = index;
    const hit = st.matches[index];
    this.editor?.goToPage(hit.page, false);
    this.editor?.setFindHighlight(st.query, hit);
    this.updateFindCount();
  }

  private updateFindCount(): void {
    const el = this.findCountEl;
    if (!el) return;
    const st = this.findState;
    if (!st || !st.query) {
      el.setText("0/0");
      el.removeAttribute("data-state");
      return;
    }
    if (!st.matches.length) {
      el.setText("无结果");
      el.setAttribute("data-state", "empty");
      return;
    }
    el.removeAttribute("data-state");
    el.setText(
      `${st.index + 1}/${st.matches.length}${st.matches.length >= MAX_FIND_MATCHES ? "+" : ""}`
    );
  }

  /** 收起浮条、清掉纸上所有高亮。换本子 / 关标签页时也走这里。 */
  private closeFindBar(): void {
    window.clearTimeout(this.findTimer);
    this.findTimer = 0;
    const wasOpen = !!this.findState;
    this.findState = null;
    if (wasOpen) this.editor?.clearFindHighlight();
    this.findBarEl?.removeClass("is-open");
    this.findInputEl?.blur();
  }

  /**
   * Ctrl/⌘+F 的捕获期入口。
   *
   * 宿主自己也监听 Ctrl/⌘+F（全局搜索 / 编辑器内查找），冒泡期的
   * `onKeyDown` 可能被它先吃掉或跟它打架，所以在捕获期就认下这一下：
   * 只在**当前活动视图就是本墨水本**、且焦点不在输入框里时接管，
   * 并且尊重设置页里可自定义的键位（被改走就不再占位）。
   */
  private onFindHotkeyCapture(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && /^(input|textarea|select)$/i.test(t.tagName)) return;
    if (t && t.isContentEditable) return;
    if (this.app.workspace.getActiveViewOfType(InkbookView) !== this) return;
    if (!this.editor) return;
    const combo = keyCombo(e);
    if (!combo || resolveHotkeys(this.plugin.settings.hotkeys).get(combo) !== "find") return;
    e.preventDefault();
    e.stopPropagation();
    this.openFindBar();
  }

  /** 缩放提示：缩放后浮现，几秒后自己退回去 */
  private showZoomHint(): void {
    window.clearTimeout(this.zoomHintTimer);
    this.floatZoomEl?.addClass("is-show");
    this.scheduleZoomHintHide();
  }

  private scheduleZoomHintHide(): void {
    window.clearTimeout(this.zoomHintTimer);
    this.zoomHintTimer = window.setTimeout(() => {
      if (this.zoomHintHover) return;
      this.floatZoomEl?.removeClass("is-show");
    }, 2600);
  }

  /* ---------------------------- 侧边拖动滑条 ---------------------------- */

  /**
   * 纸面右缘一枚可拖动的小滑块（不是长轨道）。
   *
   * 为什么自己画：
   *   · 平板上系统滚动条只有滚轮/甩动，**拖不了**
   *   · 几十页的本子想从第 3 页跳到第 27 页，只能一页页滑
   *
   * 交互边界是防误触的关键：
   *   · **只有滑块本身**收 pointer / touch；容器与轨道一律穿透，
   *     笔尖落在纸面右缘时和没有滑条时完全一样
   *   · 不画长轨道，平时整枚滑块淡出，滚动 / 拖动时才浮现
   *   · 滑块高度按可视比例算，拖它按比例改 scrollTop，
   *     拖动时旁边浮一枚页码，松手稍后整个淡出
   */
  private buildScrollbar(): void {
    this.sbAbort?.abort();
    window.clearTimeout(this.sbHideTimer);
    this.sbHideTimer = 0;
    const ac = new AbortController();
    this.sbAbort = ac;

    // 默认就是隐藏态：由 scroll / 拖动 / syncScrollbar 加 is-visible 唤醒
    const el = this.paperHost.createDiv("mb-sb");
    this.sbEl = el;
    const track = el.createDiv("mb-sb-track");
    this.sbTrack = track;
    const thumb = track.createDiv("mb-sb-thumb");
    this.sbThumb = thumb;
    this.sbTip = el.createDiv("mb-sb-tip");

    const sc = this.editor?.scrollEl;
    if (!sc) return;

    /*
     * 挂载期编辑器会 goToPage(current) 做一次程序化定位（恢复上次阅读页），
     * 即使不是用户滑动也会派发 scroll。头两帧把它当布局同步处理：
     * 挂载的 scroll 事件在同一帧的 scroll steps 里派发，早于下一帧 rAF，
     * 所以双 rAF 之后解除是安全的。否则打开非首页的本子会闪一下滑块。
     */
    this.sbQuiet = true;
    const quietSeq = ++this.sbQuietSeq;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.sbQuietSeq === quietSeq) this.sbQuiet = false;
      });
    });

    sc.addEventListener(
      "scroll",
      () => this.requestScrollbarSync(!this.sbQuiet),
      {
        passive: true,
        signal: ac.signal,
      }
    );
    window.addEventListener("resize", () => this.requestScrollbarSync(), {
      signal: ac.signal,
    });

    /*
     * 拖到哪算哪：保持"手指按在滑块上的相对位置"，按比例改 scrollTop。
     * 只有按在滑块上才会走到这里（监听挂在 thumb 上），轨道空白不响应。
     */
    const apply = (clientY: number, grab: number) => {
      const range = sc.scrollHeight - sc.clientHeight;
      const usable = Math.max(1, track.clientHeight - this.sbThumbH);
      const y = clientY - track.getBoundingClientRect().top - grab;
      const r = Math.min(1, Math.max(0, y / usable));
      sc.scrollTop = r * range;
      this.updateSbTip();
    };

    thumb.addEventListener(
      "pointerdown",
      (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const tr = thumb.getBoundingClientRect();
        const grab = e.clientY - tr.top;
        this.sbDrag = { pid: e.pointerId, grab };
        el.addClass("is-drag");
        // 拖动期间必须一直看得见，别拖到一半淡出
        el.addClass("is-visible");
        window.clearTimeout(this.sbHideTimer);
        this.sbHideTimer = 0;
        try {
          thumb.setPointerCapture(e.pointerId);
        } catch (_) {}
        e.preventDefault();
        e.stopPropagation();
        apply(e.clientY, grab);
        this.updateSbTip();
      },
      { signal: ac.signal }
    );

    thumb.addEventListener(
      "pointermove",
      (e) => {
        const d = this.sbDrag;
        if (!d || e.pointerId !== d.pid) return;
        apply(e.clientY, d.grab);
        e.preventDefault();
      },
      { signal: ac.signal }
    );

    const finish = (e: PointerEvent) => {
      const d = this.sbDrag;
      if (!d || e.pointerId !== d.pid) return;
      this.sbDrag = null;
      el.removeClass("is-drag");
      try {
        thumb.releasePointerCapture(e.pointerId);
      } catch (_) {}
      // 刚松手先留一会儿，让人看清滑块停在哪，再淡出
      this.scheduleSbHide(900);
    };
    thumb.addEventListener("pointerup", finish, { signal: ac.signal });
    thumb.addEventListener("pointercancel", finish, { signal: ac.signal });
    // 兜底：指针被系统抢走（通知栏 / 手势）时 capture 会丢，别卡在拖动态
    thumb.addEventListener("lostpointercapture", finish, { signal: ac.signal });

    /*
     * 触摸兜底：平板上从滑块往下拖，宿主会当成「下拉打开命令面板」。
     *
     * pointer 事件宿主未必看，touch 才是它认的东西——在元素捕获阶段
     * 就把 touchstart / touchmove 吃掉（必须 passive:false 才能 preventDefault）。
     * 只挂在 thumb 上：整条右缘不再吞触摸，纸面该画画该滚就滚。
     * 注意：宿主若把监听挂在 window 捕获阶段，我们拦不住（它比插件早注册），
     * 那种情况靠设置里的「屏蔽命令面板」在命令层兜底。
     */
    const eatTouch = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
    };
    thumb.addEventListener("touchstart", eatTouch, {
      passive: false,
      capture: true,
      signal: ac.signal,
    });
    thumb.addEventListener("touchmove", eatTouch, {
      passive: false,
      capture: true,
      signal: ac.signal,
    });

    this.requestScrollbarSync();
  }

  /**
   * 滚动事件很密：合并到一帧里算，别每次都读 clientHeight。
   *
   * `woke` 区分「真的滚动了」和「只是布局/状态同步」：
   * 打开本子、resize、updateUI 都会调它一次，但那些不该把滑块闪出来——
   * 用户要的是「没滑动时看不见，滑动了才显现」。只有 scroll 事件传 true。
   */
  private requestScrollbarSync(woke = false): void {
    if (this.sbRaf) {
      if (woke) this.sbWoke = true;
      return;
    }
    if (woke) this.sbWoke = true;
    const raf =
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : (fn: FrameRequestCallback) => window.setTimeout(() => fn(0), 16);
    this.sbRaf = raf(() => {
      this.sbRaf = 0;
      const wake = this.sbWoke;
      this.sbWoke = false;
      this.syncScrollbar(wake);
    });
  }

  /** 按「可视高度 / 内容高度」摆滑块 */
  private syncScrollbar(woke = false): void {
    const sc = this.editor?.scrollEl;
    const el = this.sbEl;
    const track = this.sbTrack;
    const thumb = this.sbThumb;
    if (!sc || !el || !track || !thumb) return;

    const vh = sc.clientHeight;
    const sh = sc.scrollHeight;
    const range = sh - vh;
    // 内容没超出一屏就不给拖：一条拖不动的滑块只会让人以为坏了
    if (vh < 60 || range <= 2) {
      el.addClass("is-idle");
      el.removeClass("is-visible");
      window.clearTimeout(this.sbHideTimer);
      this.sbHideTimer = 0;
      this.sbThumbH = 0;
      return;
    }
    el.removeClass("is-idle");
    /*
     * 只有「真的滚动了」或「正在拖」才浮现。
     * 打开本子 / resize / updateUI 只是布局同步（woke=false），
     * 别把它们当成滚动——否则一打开就闪一下滑块，且每次状态同步
     * 都把淡出计时重置，滑块一直赖着不走。
     */
    if (woke || this.sbDrag) {
      el.addClass("is-visible");
      this.scheduleSbHide();
    }

    const trackH = track.clientHeight || el.clientHeight;
    // 平板上手指粗，滑块再高一点才好按
    const minThumbH = this.tabletMode ? 34 : 28;
    const thumbH = Math.max(minThumbH, Math.round((trackH * vh) / sh));
    const top = Math.round(
      (trackH - thumbH) * Math.min(1, Math.max(0, sc.scrollTop / range))
    );
    this.sbThumbH = thumbH;
    this.sbThumbTop = top;
    thumb.style.height = thumbH + "px";
    thumb.style.transform = "translateY(" + top + "px)";
    if (this.sbDrag) this.updateSbTip();
  }

  /**
   * 停手后延时淡出。滚动事件很密，每次进来都重置计时；
   * 拖动期间不排程——松手时 `finish` 会重新起表，免得拖到一半消失。
   */
  private scheduleSbHide(delay = 1300): void {
    window.clearTimeout(this.sbHideTimer);
    this.sbHideTimer = 0;
    if (this.sbDrag) return;
    this.sbHideTimer = window.setTimeout(() => {
      this.sbHideTimer = 0;
      if (this.sbDrag) return;
      this.sbEl?.removeClass("is-visible");
    }, delay);
  }

  /** 拖动页数提示：跟着滑块走，平时不可见 */
  private updateSbTip(): void {
    const tip = this.sbTip;
    if (!tip) return;
    if (this.editor) {
      const s = this.editor.getState();
      tip.setText(s.pageIndex + 1 + " / " + s.pageCount);
    }
    const y = this.sbThumbTop + this.sbThumbH / 2 - 13;
    tip.style.transform = "translateY(" + Math.max(0, y) + "px)";
  }

  /** 切换侧栏展开 / 收起（兼容旧命令入口） */
  public toggleDock(): void {
    this.toggleSide();
  }

  /** 显示 / 隐藏右侧栏 */
  private toggleSide(): void {
    const wasOpen = this.sideShown;
    this.sideShown = !this.sideShown;
    this.plugin.settings.sidebarOpen = this.sideShown;
    void this.plugin.saveSettings();
    this.applySideVisibility();
    // 展开时从侧边滑入、收起时滑出（都只动 transform；状态类已瞬时切好）
    if (!wasOpen && this.sideShown) this.playPanelSlideIn(this.sideEl);
    else if (wasOpen && !this.sideShown) this.playPanelSlideOut(this.sideEl);
    this.updateUI();
  }

  /**
   * 编辑器是否可写：只读恢复态（文件不可写）成立时就不能落笔。
   */
  private applyEditorReadOnly(): void {
    this.editor?.setReadOnly(this.readOnly);
  }

  /** 提醒"这份笔记现在存不下去"。同一份笔记只提醒一次。 */
  private warnReadOnly(): void {
    if (this.assembling) return;
    if (this.readOnlyNoticeShown) return;
    this.readOnlyNoticeShown = true;
    /*
     * 措辞必须和事实一致：
     *   · 有 recovered 副本 → 让用户改用那份（这才是能继续写的文件）
     *   · 其它只读路径（原文件打不开）→ 别许诺"另存为"，
     *     插件没有这个功能，只能让用户自己复制 .bak
     */
    const msg =
      this.readOnlyReason === "duplicate"
        ? "这本手写本已在另一个标签页打开，这里只读，改动不会保存。要编辑，请先关掉另一个标签页，再重新打开本页。"
        : this.recoveredCopyName
          ? "这是只读状态（从备份恢复或原文件不可写），改动不会保存。已另存为 recovered 副本，请改用那份。"
          : "这是只读状态（从备份恢复或原文件不可写），改动不会保存。要接着写，请把同目录的 .bak 复制一份并改名。";
    new Notice(msg, 8000);
  }

  /**
   * 侧栏里的当前工具色板。
   *
   * 之前控制坞有一份独立的色板，侧栏又有一份，
   * 两处同步来同步去。现在统一：**只有侧栏一份**，
   * 选中态由 updateUI 统一打点。
   */
  private renderColors(): void {
    if (!this.editor) return;
    const s = this.editor.getState();
    const hl = s.tool === "highlighter";
    this.sideEl?.querySelectorAll<HTMLElement>(".mb-swatch").forEach((el) => {
      const kind = el.dataset.kind;
      const c = (el.dataset.color || "").toLowerCase();
      const active = kind === "hl"
        ? c === s.highlighterColor.toLowerCase()
        : c === s.penColor.toLowerCase();
      el.toggleClass("is-active", active);
      el.toggleClass("is-dim", hl && kind !== "hl");
    });
  }

  /**
   * 工具区的「结构签名」：只有它变了才需要重建 DOM。
   *
   * 判据是「这个东西变了会不会改变 DOM 的**结构/节点集合**」。
   * 只是改 class、属性、value 的（四档高亮、数字框值、is-custom 描边、
   * 字体下拉 selected、色点 is-active、滑杆 value）都**不进签名**，
   * 由 `syncDynamicValues` 就地刷 —— 这样按住步进连调时 DOM 不被换掉，
   * 连调不会断（这是实测踩出来的：20→21 时「是否命中四档」翻转，
   * 签名跟着变 → 重建 → 按钮被换 → timer 被停 → 连调只走一步）。
   *
   * 真正进签名的只有**节点集合会变**的量：
   *   · 工具种类（不同工具的控件完全不同）
   *   · 橡皮模式（整笔/局部只是高亮，可 sync，但这里留着更保险）
   *   · 形状种类（按钮文字会变，sync 里也能刷，这里留着保险）
   */
  private dynToolsSignature(s: any): string {
    if (!this.editor) return "";
    if (s.tool === "eraser") return `eraser|${this.editor.eraserMode}`;
    if (s.tool === "text") return "text";
    if (s.tool === "shape") return `shape|${(s as any).shapeKind ?? ""}`;
    return String(s.tool);
  }

  /**
   * 结构没变时就地刷新数值（不碰 DOM、不动监听）。
   *
   * 为什么需要它：加了「结构签名」之后，签名相同就不再重建 DOM，
   * 于是**所有靠重建时才刷的显示值都必须在里补刷**，否则会停在旧值。
   * 已覆盖三类：
   *   · 文字工具：四档高亮、数字框值、is-custom 描边、字体下拉、色点高亮
   *   · 橡皮：整笔/局部高亮、大小滑杆
   *   · 形状：色点高亮（粗细已移进形状自己的浮层）
   */
  private syncDynamicValues(s: any): void {
    const el = this.dynEl;
    if (!el || !this.editor) return;

    if (s.tool === "text") {
      const size = Math.round(s.textSize);
      for (const b of Array.from(el.querySelectorAll<HTMLElement>(".mb-seg-btn"))) {
        const n = Number(b.textContent);
        b.classList.toggle("is-active", n === size);
      }
      const sizeIn = el.querySelector<HTMLInputElement>(".mb-size-in");
      if (sizeIn && document.activeElement !== sizeIn) {
        // 用户正在这个框里打字时不要覆盖（会把光标位置冲掉）
        sizeIn.value = String(size);
      }
      sizeIn?.classList.toggle("is-custom", ![14, 18, 24, 32].includes(size));
      // 字体下拉：`selected` 只是 option 属性，改它不涉及结构，就地刷
      const fs2 = el.querySelector<HTMLSelectElement>(".mb-font-sel");
      if (fs2 && fs2.value !== s.textFont) fs2.value = s.textFont;
      // 文字色点高亮
      const tc = (s.textColor || "").toLowerCase();
      for (const d of Array.from(el.querySelectorAll<HTMLElement>(".mb-tcolor"))) {
        if (!d.style.background) continue;
        d.classList.toggle("is-active", this.colorMatches(d.title, tc));
      }
      this.syncColorGlassRings();
      return;
    }

    if (s.tool === "eraser") {
      for (const b of Array.from(el.querySelectorAll<HTMLElement>(".mb-seg-btn"))) {
        b.classList.toggle("is-active", b.textContent === (this.editor.eraserMode === "whole" ? "整笔" : "局部"));
      }
      this.syncRange(el, this.editor.eraserSize);
      return;
    }

    // 形状：色点高亮（形状粗细已移进它自己的浮层，侧栏不再有滑杆）
    if (s.tool === "shape") {
      const pc = (s.penColor || "").toLowerCase();
      for (const d of Array.from(el.querySelectorAll<HTMLElement>(".mb-tcolor"))) {
        d.classList.toggle("is-active", this.colorMatches(d.title, pc));
      }
      this.syncColorGlassRings();
    }
  }

  /** 把 `.mb-range` 与其数值标签刷成当前值（没有滑杆就什么都不做） */
  private syncRange(el: HTMLElement, value: number): void {
    const range = el.querySelector<HTMLInputElement>(".mb-range");
    if (!range) return;
    const v = Math.round(value * 10) / 10;
    // 正在拖这根滑杆时不要回写（会把拖动位置跳掉）
    if (document.activeElement !== range) range.value = String(v);
    const lbl = el.querySelector<HTMLElement>(".mb-size-lbl");
    if (lbl) lbl.setText(String(v));
  }

  /** 色点的 title 存的是十六进制色值；比较时统一小写 */
  private colorMatches(title: string | null | undefined, lower: string): boolean {
    return !!title && title.toLowerCase() === lower;
  }

  /**
   * 刷侧栏「演示」区（激光笔）的选中态（只改 class / aria，不重建 DOM）。
   * 数据源统一读 plugin.settings：设置页改、快捷键切、别的窗口同步，
   * 最终都会经 refreshViews → syncSettings → updateUI 走到这里。
   */
  private syncAuxControls(): void {
    if (!this.plugin) return;
    const laserOn = this.plugin.settings.laserPointer === true;
    if (this.laserBtn) {
      this.laserBtn.toggleClass("is-active", laserOn);
      this.laserBtn.setAttr("aria-pressed", String(laserOn));
    }
  }

  private renderDynamicTools(): void {
    if (!this.editor) return;
    const s = this.editor.getState();
    if (!this.dynEl) {
      // 侧栏里的"当前工具"区，随工具变化重建
      const sec = this.sideEl?.querySelector(".mb-sec-dyn");
      if (!sec) return;
      this.dynEl = sec.createDiv("mb-dyn");
    }
    /*
     * 钢笔 / 圆珠笔 / 荧光笔的粗细与颜色已经全部搬进各自的弹出调节框，
     * 侧栏这一区没有控件了；整块隐藏，避免留下一条只有 padding + min-height
     * 的空白（切到橡皮 / 文字 / 形状再显示回来）。
     */
    const dynSec = this.dynEl.parentElement as HTMLElement | null;
    const noSideTools = s.tool === "pen" || s.tool === "ballpoint" || s.tool === "highlighter";
    if (dynSec) dynSec.style.display = noSideTools ? "none" : "";
    if (noSideTools) {
      if (this.dynEl.childElementCount) this.dynEl.empty();
      this.dynToolsSig = "";
      return;
    }
    /*
     * **结构没变就只刷新数值，不重建 DOM**（2026-11-07 修）。
     *
     * 原来每次 `updateUI` 都 `empty()` 重建整块：按住「−/＋」连调时
     * `setTextSize → emitState → updateUI → 这里重建`，按钮 DOM 被换掉、
     * 旧按钮的 pointerup 永远等不到 → 连调只会走一步（真回归）。
     *
     * 现在按「工具 + 关键结构量」做签名：签名相同 → 走 `syncDynamicValues`
     * 就地刷数值（不碰 DOM、不动事件监听），按住连调可以一直跑下去；
     * 签名不同（切工具、四档高亮变化、字体/颜色变化等）才重建。
     */
    const sig = this.dynToolsSignature(s);
    if (this.dynEl.childElementCount > 0 && sig === this.dynToolsSig) {
      this.syncDynamicValues(s);
      return;
    }
    this.dynToolsSig = sig;
    /*
     * 真要重建了：先停掉旧步进按钮的连调 timer。
     * 按钮 DOM 马上被移除，按住中的 pointerup 等不到，不停的话 timer
     * 会一路按到底（− 按到 8、＋ 按到 96）。
     */
    for (const stop of this.dynStepStoppers) stop();
    this.dynStepStoppers = [];
    this.dynEl.empty();
    // 旧色点行刚被摘掉，先回收它那枚玻璃框，再按新结构重建
    this.syncColorGlassRings();

    if (s.tool === "eraser") {
      const seg = this.dynEl.createDiv("mb-seg");
      for (const m of [
        { id: "whole", label: "整笔" },
        { id: "part", label: "局部" },
      ] as const) {
        const b = seg.createEl("button", {
          cls: "mb-seg-btn" + (this.editor.eraserMode === m.id ? " is-active" : ""),
          text: m.label,
        });
        b.onclick = () => {
          this.editor?.setEraserMode(m.id);
          this.plugin.settings.lastEraserMode = m.id;
          void this.plugin.saveSettings();
          this.renderDynamicTools();
        };
      }
      const range = this.dynEl.createEl("input", {
        cls: "mb-range",
        attr: { type: "range", min: "6", max: "60", step: "1", value: String(this.editor.eraserSize) },
      });
      const lbl = this.dynEl.createSpan({ cls: "mb-size-lbl", text: String(this.editor.eraserSize) });
      range.oninput = () => {
        if (!this.editor) return;
        this.editor.eraserSize = Number(range.value);
        lbl.setText(range.value);
      };
      range.onchange = () => {
        this.plugin.settings.lastEraserSize = Number(range.value);
        void this.plugin.saveSettings();
      };
      return;
    }

    if (s.tool === "text") {
      /*
       * 文字工具参数压成**两行**（电脑端侧栏内容区只有 234px 宽）：
       *   第一行：[字号 14 18 24 32] [字体下拉，占剩余宽度]
       *   第二行：[自定义字号输入框] [8 个色点，强制一行不折]
       *
       * 用户要「在字号前面再加一个可以自由选字号的按钮」。入口挂
       * 色点行最左的原因：放第一行会把字体下拉压到 80px 以下
       * （dock 用例锁着它 ≥80px）；单独起一行又把 INK-154 刚压下去的
       * 高度还回来。42px 宽不挤任何现控件，平板上高 30px 够点。
       *
       * 旧实现把提示 / 字号 / 字体 / 色点四组直接塞进 .mb-dyn
       * （nowrap 单行）：提示文字的最小宽度就 ~220px，整行最小内容宽
       * 400px+，字体下拉被推到侧栏右缘之外（用户：「选择字体的那个框
       * 已经到页面外了」）；色点行被挤到 18px 宽，8 个点竖着排，
       * 整区被撑到约 200px 高（用户：「上下占的面积太大」）。
       *
       * 提示文字不再常驻占一行，收进容器的 title（悬停可见）。
       * 三组控件都带 data-mb-text-style：编辑框开着时点它们不提交。
       */
      const tools = this.dynEl.createDiv("mb-text-tools");
      tools.title = "点页面输入文字；点已有文字选中，再点一次编辑";

      // 第一行：字号 + 字体（并排，字号定宽、字体吃掉剩余宽度）
      const row = tools.createDiv("mb-text-tools-row");

      // 字号
      const seg = row.createDiv("mb-seg");
      for (const n of [14, 18, 24, 32]) {
        const b = seg.createEl("button", {
          cls: "mb-seg-btn" + (s.textSize === n ? " is-active" : ""),
          text: String(n),
          // 标记为「文字样式控件」：编辑框开着时点它不能把框提交掉
          attr: { "data-mb-text-style": "1" },
        });
        b.onclick = () => {
          this.editor?.setTextSize(n);
          this.renderDynamicTools();
        };
      }

      // 字体（不再 width:100% 独占一行，见 .mb-text-tools .mb-font-sel）
      const fontSel = row.createEl("select", {
        cls: "mb-font-sel dropdown",
        attr: { "data-mb-text-style": "1" },
      });
      fontSel.title = "字体";
      for (const f of TEXT_FONTS) {
        const opt = fontSel.createEl("option", { text: f.label, value: f.id });
        if (s.textFont === f.id) opt.selected = true;
      }
      fontSel.onchange = () => {
        this.editor?.setTextFont(fontSel.value);
        this.renderDynamicTools();
      };

      // 颜色（第二行；.mb-text-tools .mb-tcolor-row 强制 nowrap）
      // + 自定义字号入口：挂在色点行最左（.mb-size-in，42px），不挤
      // 第一行的字体下拉，也不额外起一行（INK-154 压下去的高度不还回来）
      const crow = tools.createDiv("mb-tcolor-row");
      const sizeIn = crow.createEl("input", {
        cls: "mb-size-in",
        attr: {
          type: "text",
          inputmode: "numeric",
          value: String(s.textSize),
          title: "自定义字号（8~96）：直接输入数字",
          "data-mb-text-style": "1",
        },
      });
      // 当前是自定义值（不是四档之一）时给入口加个强调描边
      sizeIn.classList.toggle("is-custom", ![14, 18, 24, 32].includes(Math.round(s.textSize)));
      // 编辑框开着时点它不能把框提交掉（blur 判定靠上面的标记，不能用
      // relatedTarget：iPad 上常为 null）。
      // setTextSize → emitState → updateUI 会重建整个 .mb-text-tools
      // （输入框 DOM 一起换掉）：重建后把打字内容与焦点补回新框，连续
      // 输入不断。input 事件里做（正在打字）；change/离开时不做——
      // 用户要去点导出 / 撤销，抢回焦点框里没提交的内容就静默丢了。
      const applySize = (refocus: boolean) => {
        const n = parseInt(sizeIn.value.replace(/\D/g, ""), 10);
        if (Number.isNaN(n)) return;
        this.editor?.setTextSize(n);
        if (refocus) {
          const again = this.dynEl?.querySelector<HTMLInputElement>(".mb-size-in");
          if (again && document.activeElement !== again) {
            again.value = sizeIn.value;
            again.focus();
            again.setSelectionRange(again.value.length, again.value.length);
          }
        }
      };
      sizeIn.addEventListener("input", () => applySize(true));
      sizeIn.addEventListener("change", () => {
        // 离开输入框：不重复 setTextSize（会把焦点从用户要去的元素上抢走）；
        // 输入时已逐键应用过，这里只把显示值整理成 clamp 后的实际值
        const t = this.editor?.textSize;
        if (t !== undefined) sizeIn.value = String(t);
      });
      sizeIn.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          applySize(false);
          sizeIn.blur();
        }
      });
      /* −/＋ 字号步进：点一下 ±1，按住连调（见 bindHoldStepBtn）。
       * 挂在色点行里、紧跟输入框右边：色点行是 nowrap 的固定行，
       * 两枚小按钮各占 ~14px（比字号框更窄，不把 8 色点挤出一行）。 */
      for (const d of [-1, 1] as const) {
        const step = crow.createEl("button", {
          cls:
            "mb-size-step" + (d < 0 ? " mb-size-step-sub" : " mb-size-step-add"),
          attr: {
            // 编辑框开着时点它不能把框提交掉（blur 判定靠这个标记）
            "data-mb-text-style": "1",
            "aria-label": d < 0 ? "字号减一（按住连减）" : "字号加一（按住连加）",
          },
        });
        step.textContent = d < 0 ? "−" : "＋";
        step.title = d < 0 ? "字号 −1（按住连减）" : "字号 +1（按住连加）";
        /*
         * 侧栏这一步不进 stepBtnStoppers：`renderDynamicTools` 每次重建时
         * 整块 `.mb-dyn` 会被换掉，旧按钮的 pointerup 等不到，
         * 所以停手句柄要**在重建前**调用（见 renderDynamicTools 开头）。
         */
        this.dynStepStoppers.push(
          bindHoldStepBtn(step, () => {
            // 每步走 editor 内的 clamp（8~96），不绕过 setTextSize
            this.editor?.stepTextSize(d);
          })
        );
      }
      for (const c of PEN_COLORS) {
        const dot = crow.createEl("button", {
          cls:
            "mb-tcolor" +
            (s.textColor.toLowerCase() === c.toLowerCase() ? " is-active" : ""),
          attr: { "data-mb-text-style": "1" },
        });
        dot.style.background = c;
        dot.title = c;
        dot.onclick = () => {
          this.editor?.setTextColor(c);
          this.renderDynamicTools();
        };
      }
      this.mountColorGlassRing(crow, ".mb-tcolor");
      return;
    }
    if (s.tool === "select") {
      this.dynEl.createSpan({
        cls: "mb-hint",
        text: "点文字或形状选中；拖动改位置，拖手柄改大小，Delete 删除",
      });
      return;
    }
    if (s.tool === "hand") {
      this.dynEl.createSpan({ cls: "mb-hint", text: "拖动画布；滚轮 / 双指也可以" });
      return;
    }

    if (s.tool === "shape") {
      const btn = this.dynEl.createEl("button", { cls: "mb-mini-btn" });
      const paint = () => {
        const cur = SHAPES.find((x) => x.id === this.editor?.shapeKind);
        btn.setText(cur ? cur.label : "矩形");
      };
      paint();
      btn.onclick = (e) => this.showShapeMenu(e);

      /*
       * 形状用的是笔的颜色（创建时取 penColor），所以这里放的是笔色色板。
       * 之前只有下面的粗细滑杆，颜色得跑去侧栏最上面找，藏得太深。
       */
      const crow = this.dynEl.createDiv("mb-tcolor-row");
      for (const c of PEN_COLORS) {
        const dot = crow.createEl("button", {
          cls:
            "mb-tcolor" +
            (s.penColor.toLowerCase() === c.toLowerCase() ? " is-active" : ""),
        });
        dot.style.background = c;
        dot.title = c;
        dot.onclick = () => {
          this.editor?.setPenColor(c);
          /*
           * 形状拿 penColor 落笔，所以这也是一次「选笔色」，必须写回
           * settings.lastPenColor。否则下次打开（mountEditor 按它恢复）
           * 或设置页任意改动触发 syncSettings 时，颜色会被打回旧值。
           */
          this.plugin.settings.lastPenColor = c;
          void this.plugin.saveSettings();
          this.renderDynamicTools();
        };
      }
      this.mountColorGlassRing(crow, ".mb-tcolor");
    }
  }

  private showShapeMenu(e: MouseEvent): void {
    const menu = new Menu();
    for (const s of SHAPES) {
      menu.addItem((item) =>
        item
          .setTitle(s.label)
          .setChecked(this.editor?.shapeKind === s.id)
          .onClick(() => {
            this.editor?.setShapeKind(s.id);
            this.renderDynamicTools();
          })
      );
    }
    menu.showAtMouseEvent(e);
  }

  private showImportMenu(e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("导入 PDF…")
        .setIcon("file-text")
        .onClick(() => this.startImport("pdf"))
    );
    menu.addItem((item) =>
      item
        .setTitle("导入 Word（.docx）…")
        .setIcon("file-text")
        .onClick(() => this.startImport("word"))
    );
    menu.showAtMouseEvent(e);
  }

  /** 导入流程：选源文档 → 选页码范围 → 渲染 → 插入 */
  private startImport(kind: "pdf" | "word"): void {
    if (!this.store || !this.file) return;
    new ImportSourceModal(this.app, kind, (file) => {
      void this.runImport(kind, file);
    }).open();
  }

  /**
   * 「插入图片」入口：先切到选择工具（插入后立刻能拖动 / 缩放），再弹选图窗。
   * 选到图后交给 editor.insertImage 决定摆放；它内部会选中新图并刷新界面。
   */
  private openInsertImage(): void {
    if (!this.editor || !this.file) return;
    this.editor.setTool("select");
    this.updateUI();
    new InsertImageModal(this.app, this.file.path, (src, w, h) => {
      this.editor?.insertImage(src, w, h);
      this.updateUI();
    }).open();
  }

  /**
   * 「插入文件块」入口：选一个 Excalidraw / 笔记 / 文本文件，生成快照后当作
   * 可摆放的卡片放到当前页（拖动 / 缩放 / 删除 / 撤销复用插入图片管线）。
   */
  private openInsertFileBlock(): void {
    if (!this.editor || !this.file) return;
    const bookPath = this.file.path;
    new InsertFileBlockModal(this.app, this.bookPath || bookPath, (f) => {
      void this.createFileBlock(f, bookPath);
    }).open();
  }

  /** 生成文件块快照并插入当前页；生成期间给一条可消失的 Notice（Excalidraw 导出可能几秒） */
  private async createFileBlock(file: TFile, bookPath: string): Promise<void> {
    if (!this.editor) return;
    const notice = new Notice(`正在生成「${file.basename}」的文件块…`, 0);
    try {
      const snap = await makeFileBlockSnapshot(this.app, bookPath, file);
      this.editor.setTool("select");
      this.editor.insertImage(snap.src, snap.width, snap.height, snap.source);
      this.updateUI();
    } catch (e: any) {
      const msg = e && e.message ? e.message : String(e);
      new Notice("插入文件块失败：" + msg, 9000);
      console.error("[inkbook] 插入文件块失败", e);
    } finally {
      notice.hide?.();
    }
  }

  /** 刷新文件块：源文件改了之后重新生成快照并替换 */
  private async refreshFileBlock(img: PageImage): Promise<void> {
    if (!this.editor || !this.file) return;
    const path = img.source?.path;
    if (!path) return;
    const srcFile = this.app.vault.getAbstractFileByPath(path) as TFile | null;
    if (!srcFile) {
      new Notice(`找不到源文件：${path}`);
      return;
    }
    const notice = new Notice("正在刷新文件块…", 0);
    try {
      const snap = await makeFileBlockSnapshot(this.app, this.file.path, srcFile);
      this.editor.updateFileBlockSnapshot(img.id, {
        src: snap.src,
        width: snap.width,
        height: snap.height,
        mtime: snap.source.mtime,
      });
      this.updateUI();
    } catch (e: any) {
      const msg = e && e.message ? e.message : String(e);
      new Notice("刷新文件块失败：" + msg, 9000);
      console.error("[inkbook] 刷新文件块失败", e);
    } finally {
      notice.hide?.();
    }
  }

  /**
   * 「插入双链」入口：选一篇笔记 → 在正在编辑的文字框光标处插入 `[[名字]]`；
   * 没有打开的输入框就在当前页新建一个文字框。插入后点它即可跳转。
   */
  private openInsertLink(): void {
    if (!this.editor) return;
    new InsertLinkModal(this.app, this.bookPath || (this.file ? this.file.path : ""), (name) => {
      this.editor?.insertWikiLink(name);
    }).open();
  }

  /**
   * 打开文字里的 `[[双链]]`。
   *
   * 解析优先走 `metadataCache.getFirstLinkpathDest`（和嵌入一样认 Obsidian
   * 「最短唯一路径」），拿不到再按路径 / basename 兜底；找不到给可见提示。
   * `.inkbook` 目标走插件的 `openBookAt`（可带页码，切到已开的标签页），
   * 其余（Markdown 等）走 `workspace.openLinkText`（支持 #标题锚点）。
   */
  private openWikiLink(href: string, page?: number, newTab?: boolean): void {
    const raw = String(href || "").trim();
    if (!raw) return;
    const nameOnly = raw.split("#")[0].trim();
    if (!nameOnly) return;
    const sourcePath = this.bookPath || (this.file ? this.file.path : "");
    let file: TFile | null = null;
    try {
      const cache: any = (this.app as any).metadataCache;
      if (cache && typeof cache.getFirstLinkpathDest === "function") {
        file = cache.getFirstLinkpathDest(nameOnly, sourcePath) || null;
      }
    } catch (_) {
      /* 元数据缓存偶发异常时走下面的兜底，不让一次跳转把视图搞崩 */
    }
    if (!file) {
      file =
        this.app.vault
          .getFiles()
          .find(
            (f) =>
              f.path === nameOnly ||
              f.path === nameOnly + ".md" ||
              f.basename === nameOnly
          ) || null;
    }
    if (!file) {
      new Notice(`找不到笔记：${nameOnly}`);
      return;
    }
    const ext = (file.extension || "").toLowerCase();
    if (ext === "inkbook") {
      const pg = page && page > 0 ? page : 1;
      if (this.plugin.openBookAt) {
        void this.plugin.openBookAt(file.path, pg, newTab ? { newTab: true } : undefined);
      } else {
        void this.app.workspace.openLinkText(raw, sourcePath, !!newTab);
      }
      return;
    }
    void this.app.workspace.openLinkText(raw, sourcePath, !!newTab);
  }

  /**
   * 选源文档之后、真正导入之前：问一下页码范围。
   *
   * **只在 PDF 页数多的时候问**（2026-11-07 加 INK-163）：
   * 小文档（≤ 20 页）弹一次「选范围」纯属打断，直接整本导入。
   * 大文档才给选择 —— 300 页的 PDF 全导进来，本子会变得很长，
   * 而用户往往只想要前几十页。
   *
   * 页数要先打开 PDF 才知道（pdf.js 只读目录，很快），所以这里
   * 先 `peekPdf` 读页数（顺带拿到已打开的 doc 复用），再决定弹不弹。
   */
  private async runImport(kind: "pdf" | "word", file: TFile): Promise<void> {
    /*
     * 在**最开始**就把「目标本子」记下来（2026-11-07 修）。
     * 后面要 await 读页数、等用户选范围 —— 这期间用户可能切本子。
     * 如果等到 doImport 才记，切本子后捕获到的就是新本子，
     * 于是几百页被导进新本（或者新本还没加载完、this.store 为 null 直接抛错）。
     */
    const startFile = this.file;
    const startStore = this.store;
    if (!startFile || !startStore) return;
    let range: { from: number; to: number } | undefined;
    /*
     * 只打开一次 PDF：`peekPdf` 返回已打开的 doc，直接交给 `doImport`
     * 复用 —— 几十 MB 的 PDF 没必要为了「读页数」再读一遍。
     */
    let preopened: any = null;
    if (kind === "pdf") {
      const peeked = await peekPdf(this.app, file);
      preopened = peeked.doc;
      const picked = await this.askPdfRange(peeked.total);
      if (picked === null) {
        // 用户取消：把已经打开的 doc 释放掉，别让它挂着
        try {
          await preopened?.destroy();
        } catch (_) {
          /* 释放失败无所谓 */
        }
        return;
      }
      range = picked;
    }
    // 从设备选进来的原件搬进这本的数据叶子；库内已有文件原样返回、按引用使用。
    // 放在这里（页码确认之后）才搬：用户若是取消选范围，就不该往本子目录里留文件。
    file = await adoptIncomingSource(this.app, file, startFile.path);
    await this.doImport(kind, file, range, preopened, startFile, startStore);
  }

  /**
   * 问用户要导入 PDF 的哪几页。
   *
   * **只在页数多的时候问**（≤ `IMPORT_RANGE_THRESHOLD` 直接整本）：
   * 小文档弹一次范围选择纯属打断。
   *
   * @returns `undefined` = 不用选（整本）；`null` = 用户取消；对象 = 选定范围
   */
  private async askPdfRange(
    total: number
  ): Promise<{ from: number; to: number } | null | undefined> {
    if (!(total > IMPORT_RANGE_THRESHOLD)) return undefined;
    /*
     * 取消判定的写法要小心：真实 Obsidian 的 `Modal.close()` 会
     * **同步**调用 `onClose()`。所以用「确认标志」而不是靠时序 ——
     * `onDone` 先跑（`finish()` 已改成先回调再 close），
     * `onClose` 时若没确认过才当取消。
     *
     * （`test/dist-harness.ts` 的 Modal.close 不调 onClose，
     * 自动测试测不出这类时序问题，所以这里逻辑要自己站得住。）
     */
    let confirmed = false;
    return await new Promise<{ from: number; to: number } | null>((resolve) => {
      let settled = false;
      const done = (v: { from: number; to: number } | null) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      const modal = new ImportRangeModal(this.app, "pdf", total, (from, to) => {
        confirmed = true;
        done({ from, to });
      });
      const origClose = modal.onClose.bind(modal);
      modal.onClose = () => {
        origClose();
        if (!confirmed) done(null); // 没确认就关窗 = 用户取消
      };
      modal.open();
    });
  }

  /**
   * 空视图「导入文档开始」的整条动线：选中的文档 → 新建一本本子 → 打开。
   *
   * **为什么先导入、再建文件，而不是先建空本子再调 runImport**：
   *   · 新本子的第一页就是文档第一页，不会先留一张白纸（用户要的是
   *     「从这份讲义开始」，不是「一份讲义前面还有一页空白」）；
   *   · 导入可能要几十秒，失败时不该在库里留下一个打不开的空本子；
   *   · 不用先把文件切过去再等 `onLoadFile` 完成，省掉「导入结果落到
   *     哪个本子」的竞态（runImport 里专门防过这个问题）。
   *
   * 观感上和「新建并打开」一致：进度 Notice 一直转，成功后切到新本子、
   * 停在第 1 页（`createBook` 的 activePage 默认 0）。
   */
  private async importAsNewBook(source: TFile): Promise<void> {
    const ext = (source.extension || "").toLowerCase();
    const kind: "pdf" | "word" | null = ext === "pdf" ? "pdf" : ext === "docx" ? "word" : null;
    if (!kind) {
      new Notice(`只能导入 PDF 或 Word（.docx），${source.name} 打不开。`, 8000);
      return;
    }

    let preopened: any = null;
    let range: { from: number; to: number } | undefined;
    if (kind === "pdf") {
      const peeked = await peekPdf(this.app, source);
      preopened = peeked.doc;
      const picked = await this.askPdfRange(peeked.total);
      if (picked === null) {
        try {
          await preopened?.destroy();
        } catch (_) {
          /* 释放失败无所谓 */
        }
        return;
      }
      range = picked;
    }

    /*
     * 本子名用源文件名（`讲义.pdf` → 「讲义」）。safeName 会处理
     * `/ \ : * ? " < > | # ^ [ ]` 这些路径里非法的字符；再掐掉结尾的
     * 点和空格、限制长度——Windows 上以点 / 空格结尾的路径会建不出来。
     */
    const name =
      safeName(source.basename || "未命名笔记")
        .slice(0, 80)
        .replace(/[. ]+$/g, "")
        .trim() || "未命名笔记";
    const path = await this.uniqueBookPath(name);
    // 从设备选进来的原件先搬进新本的数据叶子，导入引用才落在「墨本文件」里
    const adopted = await adoptIncomingSource(this.app, source, path);
    const notice = new Notice(kind === "pdf" ? "正在读取 PDF…" : "正在解析 Word…", 0);

    /*
     * 分成「导入 → 建文件 → 打开」三段各自兜错。
     *
     * 不合成一个大 try 是为了文案准确：导入成功、只是最后打开失败时，
     * 不能让用户以为文档白导了——本子其实已经在库里。
     */
    let result: Awaited<ReturnType<typeof importPdf>>;
    try {
      result =
        kind === "pdf"
          ? await importPdf(this.app, adopted, path, range, this.importProgressTo(notice), true, preopened)
          : await importWord(this.app, adopted, path, this.importProgressTo(notice));
    } catch (e: any) {
      notice.hide();
      // importPdf 成功后 doc 已释放；这里只兜「中途失败」的那一份
      try {
        await preopened?.destroy();
      } catch (_) {
        /* 已释放 / 释放失败都无所谓 */
      }
      new Notice("导入失败，未新建手写本：" + describeImportError(e, kind), 8000);
      console.error("[inkbook] 导入并新建失败", e);
      return;
    }

    /*
     * 把导入结果直接当成新本子的全部页面，而不是 createBook 的空白首页
     * 后面追加——见方法注释。
     */
    const book = createBook(
      name,
      this.plugin.settings.defaultTemplate,
      this.plugin.settings.defaultPaper
    );
    book.pages = result.pages;
    book.source = result.source;
    book.activePage = 0;

    let file: TFile;
    try {
      notice.setMessage("正在新建手写本…");
      file = await this.app.vault.create(path, JSON.stringify(book, null, 2));
    } catch (e: any) {
      notice.hide();
      // 注意措辞：文档已经读完了，失败的是落盘，别让用户重复导入
      new Notice(
        "文档已读取，但新建手写本失败：" + (e && e.message ? e.message : e),
        10000
      );
      console.error("[inkbook] 新建手写本失败", e);
      return;
    }

    notice.hide();
    new Notice(`已新建「${name}」，导入 ${result.pages.length} 页`, 4000);

    /*
     * 在**当前标签页**打开：空视图本身就是 InkbookView，复用这个标签
     * 最自然（不会突然多一个标签）。拿不到 leaf.openFile 的环境
     * （旧版本 / 测试桩）退回原来的「新标签页」写法。
     */
    try {
      const leaf: any = (this as any).leaf;
      if (leaf && typeof leaf.openFile === "function") {
        await leaf.openFile(file);
      } else {
        await this.app.workspace.getLeaf("tab").openFile(file);
      }
    } catch (e: any) {
      // 本子已经在库里，打开失败要如实说清位置，别让用户以为它没建成
      new Notice(
        `已新建「${name}」（${path}），但打开失败：${e && e.message ? e.message : e}。` +
          "可以在文件列表里手动打开它。",
        12000
      );
      console.error("[inkbook] 新建后打开失败", e);
    }
  }

  /**
   * 新本子的落点：库根目录，撞名就 `名字 2.inkbook`、`名字 3.inkbook`…
   *
   * 空视图里没有「当前文件」，拿不到所在文件夹；放根目录用户一眼能找到，
   * 之后想挪再挪。撞名绝不能覆盖——那可能是用户已有的另一本。
   */
  private async uniqueBookPath(name: string): Promise<string> {
    const adapter = this.app.vault.adapter;
    let path = name + ".inkbook";
    let n = 1;
    while (await adapter.exists(path)) path = `${name} ${++n}.inkbook`;
    return path;
  }

  /**
   * 导入进度 → Notice 文案。
   *
   * `doImport`（往当前本子追加）和 `importAsNewBook`（新建本子）共用，
   * 免得两处对「字节 / 页数」的解释慢慢走样。
   */
  private importProgressTo(notice: Notice): ImportProgress {
    return (phase, done, total) => {
      if (phase === "loading") {
        notice.setMessage(
          total > 0
            ? `正在读取 PDF：${humanBytes(done)} / ${humanBytes(total)}`
            : `正在读取 PDF：${humanBytes(done)}`
        );
      } else if (total > 0) {
        notice.setMessage(`正在处理第 ${done}/${total} 页…`);
      } else {
        // 总数未知（Word 是流式分页）：只报已完成多少，别显示「N/N」装成满了
        notice.setMessage(`已生成 ${done} 页…`);
      }
    };
  }

  /**
   * 真正干活的那一段（`runImport` 选完范围后调）。
   */
  private async doImport(
    kind: "pdf" | "word",
    file: TFile,
    range: { from: number; to: number } | undefined,
    /** `peekPdf` 已打开的文档：复用，不再读第二遍（本函数负责释放） */
    preopened: any,
    /** 开始导入时的本子（由 `runImport` 在 await 之前捕获） */
    startFile: TFile,
    startStore: BookStore
  ): Promise<void> {
    if (!startStore || !startFile) return;
    const notice = new Notice(
      kind === "pdf" ? "正在读取 PDF…" : "正在解析 Word…",
      0
    );
    try {
      const bookPath = startFile.path;
      /*
       * 进度分两个阶段显示（2026-11-07 修 INK-165）：
       *   · loading —— pdf.js 在读文件，数字是**字节**，显示成 MB；
       *   · pages   —— 在建页抽文字，数字是**页数**。
       * 老代码把两者都当页数，于是出现「正在读取 PDF：52428800/69500000 页」。
       */
      const onProg = this.importProgressTo(notice);
      const result =
        kind === "pdf"
          ? await importPdf(this.app, file, bookPath, range, onProg, true, preopened)
          : await importWord(this.app, file, bookPath, onProg);

      /*
       * 导入期间用户切了本子 / 关了本子 → 丢弃这次结果，别插进别的本子。
       * 这是「宁可不导入，也不能污染另一本」的取舍：重试一次很便宜，
       * 把几百页混进别的本子很难收拾。
       */
      if (this.file !== startFile || this.store !== startStore) {
        notice.hide();
        new Notice(
          `导入期间切换了本子，这次导入已取消（${result.pages.length} 页没有写入）。请在本子里重新导入。`,
          8000
        );
        return;
      }

      notice.setMessage(`已导入 ${result.pages.length} 页，正在写入…`);
      // 插到当前页后面
      const at = this.store.pageCount;
      this.store.insertPages(result.pages, at, result.source);
      this.editor?.renderPages();
      this.editor?.goToPage(at);
      this.updateUI();
      this.refreshThumbs();
      /*
       * 导入是显式动作：当场落盘、当场写索引，不等自动保存的 0.85s 防抖。
       *
       * 否则「导入 PDF → 马上去全局搜索（或马上切走）」时，索引定时器
       * 还没到点就被销毁，PDF 出来的原文根本进不了索引——用户看到的就是
       * 「PDF 导进来了，但一个字都搜不到」。
       *
       * 顺序很重要：先 saveNow（把本子落盘），再 scheduleTextIndex + flushTextIndex
       * （把索引写掉）。索引失败绝不能把「导入成功」报成失败——writeTextIndex 自己兜底。
       *
       * 为什么这里要再 schedule 一次：saveNow 在「已经有一次保存正在进行」时会
       * 直接返回（排队 saveAgain），那次保存还没走到 scheduleTextIndex，
       * 这时 indexPending 可能还是空的——不补这一次 schedule，
       * 紧接着的 flushTextIndex 就没有东西可写。
       */
      this.markDirty();
      this.saveDebounce.cancel();
      await this.saveNow();
      this.scheduleTextIndex();
      await this.flushTextIndex();
      notice.setMessage(`已导入 ${result.pages.length} 页`);
      setTimeout(() => notice.hide(), 2500);
    } catch (e: any) {
      notice.hide();
      new Notice("导入失败：" + describeImportError(e, kind), 8000);
      console.error("[inkbook] 导入失败", e);
    }
  }

  private showTemplateMenu(e: MouseEvent): void {
    if (!this.editor) return;
    const cur = this.store?.page.template;
    const menu = new Menu();
    for (const t of TEMPLATES) {
      menu.addItem((item) =>
        item
          .setTitle(t.label)
          .setChecked(cur === t.id)
          .onClick(() => this.editor?.setTemplate(t.id))
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("把这个模板应用到整本").onClick(() => this.editor?.setTemplate(cur || "grid", true))
    );
    menu.showAtMouseEvent(e);
  }

  private showExportMenu(e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("导出当前页 PNG")
        .setIcon("image")
        .onClick(() => this.runExport("png"))
    );
    menu.addItem((item) =>
      item
        .setTitle("导出整本 PDF")
        .setIcon(EXPORT_ICON)
        .onClick(() => this.runExport("pdf"))
    );
    menu.addItem((item) =>
      item
        .setTitle("导出指定页 PDF…")
        .setIcon(EXPORT_ICON)
        .onClick(() => {
          const st = this.editor?.getState();
          if (!st) return;
          new ImportRangeModal(
            this.app,
            "pdf",
            st.pageCount,
            (from, to) => void this.runExport("pdf", { from, to }),
            "导出"
          ).open();
        })
    );
    menu.addSeparator();
    /*
     * 分享：先弹窗选「分享格式（图片 / PDF）」和「分享哪些页（全部 / 范围）」，
     * 再导出并调起系统分享面板。
     */
    menu.addItem((item) =>
      item
        .setTitle("分享…")
        .setIcon("share-2")
        .onClick(() => this.openShare())
    );
    menu.showAtMouseEvent(e);
  }

  /** 打开「分享」弹窗（先选格式与页范围） */
  private openShare(): void {
    const st = this.editor?.getState();
    if (!st) return;
    new ShareModal(this.app, st.pageCount, (choice) => void this.runShare(choice)).open();
  }

  /** 按用户选择导出并分享：图片=逐页 PNG，PDF=合并整本；再交给系统分享 */
  private async runShare(choice: ShareChoice): Promise<void> {
    if (!this.editor || !this.file) return;
    if (this.exporting) {
      new Notice("正在导出中，请稍候…", 2500);
      return;
    }
    const range = choice.all ? undefined : { from: choice.from, to: choice.to };
    this.exporting = true;
    const notice = new Notice("正在准备分享…", 0);
    try {
      // 编辑框里没提交的文字先落库，否则分享出去会少这一段
      this.editor.commitTextEditNow(true);
    } catch (_) {
      /* 忽略 */
    }
    try {
      if (choice.format === "pdf") {
        const path = await exportBookPdf(this.app.vault, this.editor, this.file, 2, range, {
          onRangeAdjusted: (norm) => {
            if (norm.from !== (range?.from ?? 1) || norm.to !== (range?.to ?? norm.to)) {
              new Notice(`实际分享第 ${norm.from}–${norm.to} 页。`, 4000);
            }
          },
        });
        await this.sharePaths([path], "application/pdf");
      } else {
        const pages = this.pagesToShare(choice);
        const paths: string[] = [];
        for (let i = 0; i < pages.length; i++) {
          notice.setMessage(`正在导出第 ${i + 1}/${pages.length} 页…`);
          paths.push(
            await exportPagePngAt(this.app.vault, this.editor, this.file, pages[i], 2, {
              notice: false,
            })
          );
        }
        await this.sharePaths(paths, "image/png");
      }
    } catch (e) {
      if (e instanceof ExportCancelledError) {
        new Notice("已取消分享。", 3500);
      } else {
        new Notice("分享失败：" + describeExportError(e), 8000);
        console.error("[inkbook] 分享失败", e);
      }
    } finally {
      notice.hide();
      this.exporting = false;
    }
  }

  /** 分享页选择 → 0 基页索引数组 */
  private pagesToShare(choice: ShareChoice): number[] {
    const total = this.editor?.getState().pageCount ?? 0;
    const from = choice.all ? 1 : Math.max(1, Math.min(choice.from, choice.to));
    const to = choice.all ? total : Math.max(choice.from, choice.to);
    const out: number[] = [];
    for (let p = from; p <= Math.min(to, total); p++) out.push(p - 1);
    return out;
  }

  /** 读出已导出文件 → 交给系统分享；不支持时提示路径让用户手动发送 */
  private async sharePaths(paths: string[], mime: string): Promise<void> {
    const files: File[] = [];
    for (const p of paths) {
      const data = await this.app.vault.adapter.readBinary(p);
      const name = p.split("/").pop() || "墨本";
      files.push(new File([data], name, { type: mime }));
    }
    const nav = navigator as Navigator & {
      canShare?: (data?: { files?: File[] }) => boolean;
      share?: (data: { files?: File[]; title?: string }) => Promise<void>;
    };
    if (nav.share && (!nav.canShare || nav.canShare({ files }))) {
      try {
        await nav.share({ files, title: this.file?.basename ?? "墨本" });
        return;
      } catch (e) {
        if ((e as DOMException)?.name === "AbortError") return; // 用户取消分享面板
        // 落到下面的降级提示
      }
    }
    new Notice(
      `已导出 ${files.length} 个文件到：${paths.join("、")}\n当前环境不支持系统分享，请从文件里手动发送。`,
      9000
    );
  }

  private async runExport(
    kind: "png" | "pdf",
    range?: { from: number; to: number }
  ): Promise<void> {
    if (!this.editor || !this.file) return;
    if (this.exporting) {
      new Notice("正在导出中，请稍候…", 2500);
      return;
    }
    /*
     * 编辑框里没提交的文字先落库，否则导出的文件会少这一段。
     * force：导出是显式动作，不能等 compositionend；组字中只写已上屏部分。
     */
    this.editor.commitTextEditNow(true);
    this.exporting = true;
    let progress: Notice | null = null;
    try {
      const scale = 2;
      if (kind === "png") {
        await exportPagePng(this.app.vault, this.editor, this.file, scale);
        return;
      }

      /*
       * 动线审查第 5 条：大本导出（用户有 857 页的 PDF 本子）必须看得见
       * 进度、能取消。老实现只弹一个 3 秒的 Notice，之后全程静默像卡死。
       *
       * · 时长传 0 = 不自动消失（默认 3 秒）；
       * · 每导完一页 exportBookPdf 回调一次，这里只更新文字节点；
       * · 「取消」按钮挂在 Notice 上，点一下 abort，导出侧在页边界退出，
       *   正式文件不写、已经写出的 .tmp 会被清掉。
       */
      const controller = new AbortController();
      const notice = new Notice(
        range ? `准备导出第 ${range.from}–${range.to} 页 PDF…` : "准备导出整本 PDF…",
        0
      );
      progress = notice;
      const setMessage = this.attachExportProgress(notice, controller);
      await exportBookPdf(this.app.vault, this.editor, this.file, scale, range, {
        signal: controller.signal,
        /*
         * 页范围被夹取 / 起止颠倒时别静默：老实现回落整本，进度 Notice 却还
         * 写着「第 9–2 页」，用户以为只导几页结果跑了 857 页。
         * 回调发生在开跑前，进度文案随后会覆盖它，所以这里另弹一条独立 Notice。
         */
        onRangeAdjusted: (norm) => {
          new Notice(
            `页码范围无效，已改为整本（第 1–${norm.total} 页）。` +
              `实际导出第 ${norm.from}–${norm.to} 页。`,
            6000
          );
        },
        onProgress: (done, total, phase) => {
          if (phase === "saving") {
            setMessage(`正在生成 PDF（${total} 页）…`);
          } else {
            setMessage(
              done > 0 ? `正在导出第 ${done}/${total} 页…` : `准备导出 ${total} 页…`
            );
          }
        },
      });
      notice.hide();
      progress = null;
    } catch (e: any) {
      if (e instanceof ExportCancelledError) {
        new Notice("已取消导出，没有写入文件。", 4000);
      } else {
        new Notice("导出失败：" + describeExportError(e), 8000);
        console.error("[inkbook] 导出失败", e);
      }
    } finally {
      if (progress) progress.hide();
      this.exporting = false;
    }
  }

  /**
   * 给导出进度的 Notice 搭一条「文字 + 取消按钮」的内容，返回更新文字的函数。
   *
   * 为什么不直接用 notice.setMessage：Obsidian 的 setMessage 会整块替换
   * noticeEl 的文本，挂上去的按钮会被一并清掉（第二次进度更新后就没法取消了）。
   * 这里自己建 span/button，只改 span 的文字，按钮始终在。
   *
   * 测试桩的 Notice 没有 noticeEl，退回 setMessage——核心取消能力在
   * exportBookPdf 的 signal 上，不依赖这个按钮。
   */
  private attachExportProgress(
    notice: Notice,
    controller: AbortController
  ): (message: string) => void {
    const el = (notice as any).noticeEl as HTMLElement | undefined;
    if (!el || typeof el.createEl !== "function" || typeof el.empty !== "function") {
      return (message: string) => notice.setMessage(message);
    }
    el.empty();
    const text = el.createSpan({ cls: "mb-export-msg" });
    const btn = el.createEl("button", { cls: "mb-export-cancel", text: "取消" });
    btn.onclick = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      btn.disabled = true;
      btn.setText("取消中…");
    };
    return (message: string) => text.setText(message);
  }

  /* ------------------------------- 侧栏 ------------------------------- */

  /**
   * 构建右侧栏。
   *
   * 侧栏现在是**所有工具的收纳处**：
   *   笔盒（颜色/粗细）、撤销重做、导入、导出、输入方式、
   *   纸张模板、图层、页面列表……
   *
   * 之前这些散在控制坞的三个标签页里，用户反馈
   * "导出 PDF 这种工具，可以直接统一全部放在侧边栏里面"——
   * 统一之后想找任何功能只需要展开一个面板，不用在三页之间翻。
   */
  /**
   * 侧栏顶部标题：内联编辑，回车 / 失焦真正重命名这个 .inkbook 文件。
   * 用 Obsidian 的 fileManager.renameFile，链接与索引由宿主维护。
   */
  private beginRenameFromSidebar(): void {
    const file = this.file;
    const titleEl = this.sideTitleEl;
    if (!file || !titleEl || !titleEl.isConnected) return;
    const parent = titleEl.parentElement;
    if (!parent) return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "mb-side-title-edit";
    input.value = file.basename;
    input.setAttribute("aria-label", "重命名笔记");
    /*
     * 输入框必须**原地覆盖文件名**，不能 append 到副标题后面：原来 appendChild
     * 会让编辑框掉到第三行，把侧栏顶部整块撑高，用户一眼就觉得「占了好大一块」。
     * 这里保留标题在文档流里的占位（只 visibility:hidden），再把绝对定位的输入框
     * 按标题的实时 rect 对齐；父容器宽度变化时 ResizeObserver 跟着重算。
     */
    titleEl.style.visibility = "hidden";
    titleEl.insertAdjacentElement("afterend", input);
    const align = () => {
      if (!input.isConnected) return;
      const pr = parent.getBoundingClientRect();
      const tr = titleEl.getBoundingClientRect();
      input.style.left = tr.left - pr.left + "px";
      input.style.top = tr.top - pr.top + "px";
      input.style.width = tr.width + "px";
      input.style.height = tr.height + "px";
    };
    align();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(align);
      ro.observe(parent);
    }
    input.focus();
    input.select();

    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      ro?.disconnect();
      ro = null;
      let name = input.value.trim();
      input.remove();
      titleEl.style.visibility = "";
      if (!commit || !name || name === file.basename) return;
      if (name.includes("/") || name.includes("\\")) {
        new Notice("文件名不能包含斜杠");
        return;
      }
      const ext = file.extension ? "." + file.extension : "";
      // 用户可能连扩展名一起打了：去掉重复扩展名
      if (ext && name.toLowerCase().endsWith(ext.toLowerCase())) {
        name = name.slice(0, -ext.length).trim();
      }
      if (!name) return;
      const folder = file.parent ? file.parent.path : "";
      const newPath = (folder ? folder + "/" : "") + name + ext;
      void this.app.fileManager
        .renameFile(file, newPath)
        .then(() => {
          // renameFile 会把同一个 TFile 的 path / basename 更新掉
          this.sideTitleEl?.setText(name);
          new Notice("已重命名：" + name);
        })
        .catch((err: unknown) => {
          new Notice("重命名失败：" + ((err as Error)?.message ?? String(err)));
        });
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }

  private buildSide(): void {
    if (!this.store || !this.editor) return;
    const side = this.sideEl;
    side.empty();
    side.id = "mb-side";
    const head = side.createDiv("mb-side-head");
    const headText = head.createDiv("mb-side-headtext");
    this.sideTitleEl = headText.createDiv({
      cls: "mb-side-title",
      text: this.file ? this.file.basename : "手写本",
    });
    this.sideTitleEl.title = "点击可重命名笔记";
    this.sideTitleEl.setAttribute("role", "button");
    this.sideTitleEl.setAttribute("tabindex", "0");
    this.sideTitleEl.onclick = () => this.beginRenameFromSidebar();
    this.sideTitleEl.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.beginRenameFromSidebar();
      }
    };
    headText.createDiv({ cls: "mb-side-sub", text: "A4 · 自动保存" });
    // 侧栏收起按钮（窄屏下侧栏是盖在纸上的，必须有地方关）
    const closeBtn = head.createEl("button", {
      cls: "mb-side-close",
      attr: { "aria-label": "收起侧栏" },
    });
    setIcon(closeBtn, "x");
    closeBtn.title = "收起侧栏";
    closeBtn.onclick = () => this.toggleSide();

    const body = side.createDiv("mb-side-body");
    // 页列表已经搬到左侧抽屉（见 buildPageDock），那里再挂滚动监听
    this.attachPageListScroll(null);

    /* ---------------------------- 工具行 ---------------------------- */
    /*
     * 常用动作放在最上面，一排图标按钮。
     *
     * 撤销/重做/删除是写字时最高频的三个编辑动作，
     * 埋在一堆文字控件里找不到，等于没有。
     */
    const actSec = body.createDiv("mb-sec mb-sec-act");
    const actRow = actSec.createDiv("mb-ib-row");
    this.undoBtn = actRow.createEl("button", {
      cls: "mb-ib",
      attr: { "aria-label": "撤销" },
    });
    this.undoBtn.title = "撤销 (Ctrl+Z)";
    setIcon(this.undoBtn, "undo-2");
    this.undoBtn.onclick = () => this.editor?.undo();
    this.redoBtn = actRow.createEl("button", {
      cls: "mb-ib",
      attr: { "aria-label": "重做" },
    });
    this.redoBtn.title = "重做 (Ctrl+Shift+Z)";
    setIcon(this.redoBtn, "redo-2");
    this.redoBtn.onclick = () => this.editor?.redo();
    /*
     * 导入 / 导出**带文字标签**（2026-11-09）。
     *
     * 之前是两个纯图标按钮，先后试过 import/download 和
     * file-input/file-output —— 用户两次反馈「这俩太像，分不出来」。
     * 形状相近的图标在平板上本来就难分辨，与其再换一对图标，
     * 不如直接把字写出来：一眼就知道哪个是进、哪个是出。
     */
    const impBtn = actRow.createEl("button", {
      cls: "mb-ib mb-ib-labeled",
      attr: { "aria-label": "导入文档" },
    });
    impBtn.title = "导入文档：把 PDF / Word 放进本子，在上面手写批注";
    setIcon(impBtn, "file-input");
    impBtn.createSpan({ cls: "mb-ib-label", text: "导入" });
    impBtn.onclick = (e) => this.showImportMenu(e);
    const expBtn = actRow.createEl("button", {
      cls: "mb-ib mb-ib-labeled",
      attr: { "aria-label": "导出本子" },
    });
    expBtn.title = "导出本子：存成 PDF 或本页 PNG";
    /*
     * 用户要求侧栏入口与「导出整本 PDF」菜单项一致，统一用 file-text。
     * 与导入的 file-input 仍是两种形状，且保留「导出」文字标签；
     * share-2 只用于「分享…」，不再把导出误表达成分享。
     */
    setIcon(expBtn, EXPORT_ICON);
    expBtn.createSpan({ cls: "mb-ib-label", text: "导出" });
    expBtn.onclick = (e) => this.showExportMenu(e);
    const imgBtn = actRow.createEl("button", {
      cls: "mb-ib mb-ib-labeled",
      attr: { "aria-label": "插入图片" },
    });
    imgBtn.title = "插入图片：把一张图片贴到当前页，可拖动 / 缩放 / 删除";
    setIcon(imgBtn, "image");
    imgBtn.createSpan({ cls: "mb-ib-label", text: "图片" });
    imgBtn.onclick = () => this.openInsertImage();

    /*
     * 侧栏「笔盒」整块已移除：钢笔 / 圆珠笔 / 荧光笔 的颜色和粗细，
     * 用顶栏工具按钮「二次点击」弹出的快捷笔盒（openPenPop）调就够了，
     * 侧栏再放一套属于功能重复，用户要求去掉。
     */

    /* ---------------------------- 当前工具 ---------------------------- */
    /*
     * 这一区随当前工具变化：橡皮出整笔/局部 + 大小滑杆，文字出字号/字体/颜色，
     * 形状出形状种类 + 色点。钢笔 / 圆珠笔 / 荧光笔没有控件了
     * （粗细与颜色都移进了各自的弹出调节框），renderDynamicTools 会把这一区隐藏。
     */
    const dynSec = body.createDiv("mb-sec mb-sec-dyn");
    this.dynEl = dynSec.createDiv("mb-dyn");
    // 新建的空节点：签名要清掉，否则会误判「结构没变」而跳过首建
    this.dynToolsSig = "";

    /* ---------------------------- 输入方式 ---------------------------- */
    const inputSec = body.createDiv("mb-sec");
    inputSec.createDiv({ cls: "mb-sec-title", text: "输入方式" });
    const inputRow = inputSec.createDiv("mb-ib-row");
    this.touchBtn = inputRow.createEl("button", {
      cls: "mb-ib",
      attr: { "aria-label": "允许手指书写" },
    });
    this.touchBtn.title = "允许手指书写：平板没有笔时用手指写（打开后请小心掌根）";
    setIcon(this.touchBtn, "hand");
    this.touchBtn.onclick = () => {
      const on = !this.editor?.touchDraw;
      if (!on) {
        this.editor?.setTouchDraw(false);
        // 关掉也要写回：否则下次打开 Obsidian 又从 settings 恢复成「开」
        this.plugin.settings.touchDraw = false;
        void this.plugin.saveSettings();
        this.updateUI();
        new Notice("手指只负责滚动页面", 2200);
        return;
      }

      /*
       * 打开「手指书写」时，必须把会**抵消它**的状态一起处理掉。
       *
       * 真机反馈：「点了允许手指写字，还是没法用手指写字，只能用手写笔」——
       * 「只认触控笔」开着时 touch 一落下就判成 pan，连落笔分支都进不去。
       * 文件只读（readOnly）是硬约束，不能靠这个开关绕过，只能如实拒绝。
       */
      if (this.readOnly) {
        this.warnReadOnly();
        return;
      }
      const undone: string[] = [];
      if (this.plugin.settings.penOnly) {
        this.plugin.settings.penOnly = false;
        this.editor?.setPenOnly(false);
        undone.push("已关闭「只认触控笔」");
      }
      this.editor?.setTouchDraw(true);
      // 写回 settings：以前只在编辑器实例上置位，重启就复位了
      this.plugin.settings.touchDraw = true;
      /*
       * 两个字段一起写盘，只调一次 saveSettings。
       * saveData 是整份 settings 全量覆盖，连写两次时两次之间另一个
       * 窗口刚保存的改动会被第二次用同一份旧快照抹掉（INK-179）。
       */
      void this.plugin.saveSettings();
      this.updateUI();
      new Notice(
        (undone.length ? "已允许手指书写（" + undone.join("，") + "）。" : "已允许手指书写。") +
          "此时单指用来写字，滚动请用双指或右缘滑条。",
        3600
      );
    };
    /*
     * 「只认触控笔」按钮已去掉：它和上面这颗「允许手指书写」是同一件事的两面
     * ——关掉手指书写，手指本来就只负责滚动、掌根不落笔。两颗并排放着只会让人
     * 以为是两个独立功能。设置页里的「只认触控笔」开关与 I 快捷键仍保留，
     * 老本子里存下来的 penOnly 也能被上面这段逻辑正常清掉。
     */

    /* --------------------------- 演示（经典手写应用移植） --------------------------- */
    /*
     * 激光笔是全局开关、和当前工具无关，放独立静态区；选中态由
     * syncAuxControls() 统一刷（快捷键、设置页改动都会走到 updateUI）。
     *
     * 一笔成型不再是侧栏三态按钮：用户要求「加在每个笔下边弹出的框里，
     * 只有打开和关闭，画完立马识别」，所以搬到钢笔 / 圆珠笔的快捷笔盒
     * （见 openPenPop）。隐藏笔迹内容已整体移除（和「隐藏笔迹层」冲突）。
     */
    const auxSec = body.createDiv("mb-sec");
    auxSec.createDiv({ cls: "mb-sec-title", text: "演示" });

    const auxRow = auxSec.createDiv("mb-ib-row");
    // 激光笔：只指示不落墨的开关
    this.laserBtn = auxRow.createEl("button", {
      cls: "mb-ib mb-ib-labeled",
      attr: { type: "button", "aria-label": "激光笔", "aria-pressed": "false" },
    });
    this.laserBtn.title = "激光笔：落笔只在页面上留一条会淡出的红色指示光迹，不落墨、不进撤销、不进导出";
    setIcon(this.laserBtn, "laser-pointer");
    this.laserBtn.createSpan({ cls: "mb-ib-label", text: "激光笔" });
    this.laserBtn.onclick = () => {
      if (!this.editor) return;
      const on = this.plugin.settings.laserPointer !== true;
      this.plugin.settings.laserPointer = on;
      this.editor.setLaserPointer(on);
      void this.plugin.saveSettings();
      this.syncAuxControls();
      new Notice(on ? "激光笔：开（只指示，不落墨）" : "激光笔：关", 2000);
    };
    this.syncAuxControls();

    /* ---------------------------- 纸张 ---------------------------- */
    const tplSec = body.createDiv("mb-sec");
    const tplHead = tplSec.createDiv("mb-sec-head");
    tplHead.createDiv({ cls: "mb-sec-title", text: "纸张" });
    const allTpl = tplHead.createEl("button", { cls: "mb-link", text: "应用到整本" });
    allTpl.onclick = () => this.editor?.setTemplate(this.store?.page.template || "grid", true);
    this.templateGrid = tplSec.createDiv("mb-templates");
    this.renderTemplates();

    this.paperRow = tplSec.createDiv("mb-papers");
    this.renderPapers();

    /* ---------------------------- 图层 ---------------------------- */
    const layerSec = body.createDiv("mb-sec");
    const layerHead = layerSec.createDiv("mb-sec-head");
    layerHead.createDiv({ cls: "mb-sec-title", text: "图层" });
    const addLayer = layerHead.createEl("button", { cls: "mb-link", text: "+ 新图层" });
    addLayer.onclick = () => this.editor?.addLayer();
    this.layerListEl = layerSec.createDiv("mb-layers");
    this.renderLayers();

    this.statsEl = body.createDiv("mb-stats");

    this.statusEl = side.createDiv("mb-status mb-side-status");
  }

  /**
   * 左侧「页面」抽屉：缩略图 + 目录，像 Obsidian 原生 PDF 阅读器那样。
   *
   * 用户原话：「让这个笔记的缩略图和 Obsidian 原生 PDF 阅读器里的缩略图
   * 形式一样：在屏幕左边最上面的框里有一个按钮，点一下就能出来缩略图」。
   *
   * 结构：
   *   .mb-editor
   *     ├─ .mb-pagedock（左侧抽屉，默认收起，只留一条 40px 的把手）
   *     │    ├─ .mb-pagedock-handle（左上角按钮，点击开合）
   *     │    └─ .mb-pagedock-body（标签 + 两个面板）
   *     └─ .mb-paper（纸面）
   *
   * 放在 `.mb-editor` 内部而不是 `.mb-body`：它应该只占纸面区的高度，
   * 不把右侧工具侧栏也挤走。
   */
  private buildPageDock(): void {
    if (!this.editorHost) return;
    this.pagedockEl?.remove();
    const dock = this.editorHost.createDiv("mb-pagedock");
    // 插到纸面列前面：左侧抽屉要在左边
    this.editorHost.insertBefore(dock, this.paperHost);
    this.pagedockEl = dock;

    const handle = dock.createEl("button", {
      cls: "mb-pagedock-handle",
      attr: { "aria-label": "页面与目录", "aria-expanded": "false" },
    });
    setIcon(handle, "layout-grid");
    handle.title = "页面与目录";
    handle.onclick = () => this.togglePageDock();
    this.pagedockHandleEl = handle;

    const bodyEl = dock.createDiv("mb-pagedock-body");
    this.pagedockBodyEl = bodyEl;

    const tabRow = bodyEl.createDiv({
      cls: "mb-side-tabs",
      attr: { role: "tablist", "aria-label": "缩略图、目录与收藏" },
    });
    this.sideTabBtns = [];
    const mkTab = (
      id: "thumbs" | "outlines" | "favorites",
      label: string
    ): HTMLButtonElement => {
      const b = tabRow.createEl("button", {
        cls: "mb-side-tab",
        text: label,
        attr: { role: "tab", "data-tab": id },
      });
      b.onclick = () => this.setSideTab(id);
      this.sideTabBtns.push(b);
      return b;
    };
    mkTab("thumbs", "缩略图");
    mkTab("outlines", "目录");
    // 用户要求：第三个「收藏」标签放在「目录」右边
    mkTab("favorites", "收藏");
    // 三个标签共用同一枚紫色高亮片：切到收藏时也是滑过去，不是瞬移
    this.sidePill?.destroy();
    this.sidePill = new SlidePill(tabRow);

    this.sidePanesEl = bodyEl.createDiv("mb-side-panes");
    this.sideThumbPane = this.sidePanesEl.createDiv("mb-side-pane mb-side-pane-thumbs");
    this.sideOutlinePane = this.sidePanesEl.createDiv("mb-side-pane mb-side-pane-outlines");
    this.sideFavoritePane = this.sidePanesEl.createDiv("mb-side-pane mb-side-pane-favorites");
    /*
     * 先把显隐落好，再建内容：
     * 隐藏的面板量不到尺寸，窗口化会按兜底值建错（行高 / 视口高都是 0）。
     */
    this.applySideTab();

    const pageSec = this.sideThumbPane.createDiv("mb-sec");
    const pageHead = pageSec.createDiv("mb-sec-head");
    pageHead.createDiv({ cls: "mb-sec-title", text: "页面" });
    const addPage = pageHead.createEl("button", { cls: "mb-link", text: "+ 加一页" });
    addPage.onclick = () => this.editor?.addPage();
    /*
     * 每行几张：1/2/3/4（默认 4）。放在缩略图面板顶部，选择写回设置，
     * 并即时按新列宽重排 + 重画可见缩略图（换列后单元格尺寸变了，必须重画，否则发糊）。
     */
    const colsRow = pageSec.createDiv("mb-thumb-cols-row");
    colsRow.createEl("span", { cls: "mb-thumb-cols-label", text: "每行" });
    this.thumbColsBtns = [];
    for (const n of [1, 2, 3, 4]) {
      const b = colsRow.createEl("button", {
        cls: "mb-thumb-cols-btn",
        text: String(n),
        attr: { type: "button", "aria-label": n + " 张每行", title: n + " 张每行" },
      });
      b.onclick = () => this.setThumbCols(n);
      this.thumbColsBtns.push([n, b]);
    }
    // 「每行几张」1/2/3/4 的紫色高亮片（切列数时滑过去）
    this.thumbColsPill?.destroy();
    this.thumbColsPill = new SlidePill(colsRow);
    this.pageListEl = pageSec.createDiv("mb-pages");
    this.applyThumbColsToGrid();
    this.syncThumbColsBtns();
    /*
     * 滚动容器是**面板**（.mb-side-pane-thumbs），列表在它内部。
     *
     * 不能把列表自己当视口：updatePageWindow 要用「视口 rect − 列表 rect」
     * 算可见行范围，两者是同一元素时差值恒为 0，窗口化会退化成「全建」。
     */
    this.attachPageListScroll(this.sideThumbPane);
    if (this.thumbVisible()) this.renderPageList();

    const outSec = this.sideOutlinePane.createDiv("mb-sec mb-sec-outline");
    const outHead = outSec.createDiv("mb-sec-head");
    outHead.createDiv({ cls: "mb-sec-title", text: "目录" });
    const addOutline = outHead.createEl("button", { cls: "mb-link", text: "+ 添加目录" });
    addOutline.onclick = () => this.showAddOutline();
    // 目录区自己的滚动视口：条目多了只建可视区附近的那几条
    this.outlineViewportEl = outSec.createDiv("mb-outlines");
    this.outlineListEl = this.outlineViewportEl.createDiv("mb-outline-list");
    this.renderOutlines(true);
    // 滚动 → 重算窗口（只建可视区附近的条目）
    this.outlineViewportEl.addEventListener(
      "scroll",
      () => {
        this.buildOutlineWindow();
      },
      { passive: true }
    );

    /*
     * 收藏面板：直接列出被标了收藏的页缩略图，点卡片跳页、点星标取消。
     * 「收藏当前页」按钮给平板一个不用长按也能收藏当前页的入口。
     */
    const favSec = this.sideFavoritePane.createDiv("mb-sec mb-sec-favorites");
    const favHead = favSec.createDiv("mb-sec-head");
    favHead.createDiv({ cls: "mb-sec-title", text: "收藏" });
    const favBtn = favHead.createEl("button", {
      cls: "mb-link mb-fav-current",
      attr: { type: "button", "aria-label": "收藏当前页", title: "收藏当前页" },
    });
    const favIc = favBtn.createSpan("mb-fav-current-ic");
    setIcon(favIc, "star");
    this.favoriteCurrentBtn = favBtn;
    this.favoriteCurrentLabel = favBtn.createSpan("mb-fav-current-label");
    this.favoriteCurrentLabel.setText("收藏当前页");
    favBtn.onclick = () => this.toggleCurrentFavorite();
    /*
     * 收藏面板「每行几张」1/2/3/4。
     *
     * 用户要求收藏页也能调布局，并要「紫色框滑过去」的动效。这里复用
     * 缩略图面板同款分段控件（.mb-thumb-cols-row / .mb-slide-pill），
     * 选中项变化时紫框连续滑动，而不是瞬移。
     */
    const favColsRow = favSec.createDiv("mb-thumb-cols-row mb-fav-cols-row");
    favColsRow.createEl("span", { cls: "mb-thumb-cols-label", text: "每行" });
    this.favoriteColsBtns = [];
    for (const n of [1, 2, 3, 4]) {
      const b = favColsRow.createEl("button", {
        cls: "mb-thumb-cols-btn",
        text: String(n),
        attr: { type: "button", "aria-label": n + " 张每行", title: n + " 张每行" },
      });
      b.onclick = () => this.setFavoriteCols(n);
      this.favoriteColsBtns.push([n, b]);
    }
    this.favoriteColsPill?.destroy();
    this.favoriteColsPill = new SlidePill(favColsRow);
    this.favoriteEmptyEl = favSec.createDiv("mb-fav-empty");
    this.favoriteEmptyEl.setText("还没有收藏页。点「收藏当前页」把这一页放进来。");
    this.favoriteListEl = favSec.createDiv("mb-favorites");
    this.applyFavoriteColsToGrid();
    this.syncFavoriteColsBtns();
    // 新建 DOM 后必须强制重建一次（签名可能和上一份 DOM 完全相同）
    this.favoriteListSig = "";
    this.favoriteBtnSig = "";
    // 建完立刻把按钮态与列表落到当前 store；之后 updateUI 只在签名变了才重建
    this.syncFavoritesUI();

    this.applyPageDock();
    // 缩略图面板右缘的自绘滑动条（和纸面那条同款，平板上能拖）
    this.buildThumbScrollbar(this.sideThumbPane, this.sidePanesEl);
    this.syncThumbScrollbar();
  }

  /** 左侧页面抽屉开合 */
  private togglePageDock(): void {
    const wasOpen = this.pagedockOpen;
    this.pagedockOpen = !this.pagedockOpen;
    this.applyPageDock();
    if (!wasOpen && this.pagedockOpen) this.playPanelSlideIn(this.pagedockBodyEl);
    else if (wasOpen && !this.pagedockOpen) this.playPanelSlideOut(this.pagedockBodyEl);
    if (this.pagedockOpen) {
      /*
       * **首帧对齐**：赶在浏览器第一次绘制之前把「看什么」摆好。
       *
       * applyPageDock 已经让 body 瞬间拿到最终宽度（宽度没有动画，只有
       * translateX 滑入），playPanelSlideIn 又强制过一次重排，此刻量得到
       * 真实尺寸。以前把这些活全塞进两帧后的 finishOpen，于是动画露出的
       * 前两帧是空列表 / 第 1 页 / 半片紫框，再跳到当前页——用户说的
       * 「还是先在第一页然后才加载过来」「紫框只占一半、卡一下才加载好」。
       * 这里只做便宜的窗口 DOM + 滚动定位 + 高亮片测量，一张缩略图都不画；
       * 光栅化仍延到动画起步之后，首帧不会被 pdf.js 占住。
       */
      if (this.sideTab === "thumbs") {
        this.primeThumbsToActivePage();
        this.thumbColsPill?.layoutNow(true);
      }
      this.sidePill?.layoutNow(true);

      const finishOpen = () => {
        if (!this.pagedockOpen) return; // 建的过程中用户又收起了
        if (this.sideTab === "thumbs") {
          // 首帧若因为宽度还没落定没能建窗口（无头 / 极端环境），这里兜底补建
          if (!this.pageListEl?.firstElementChild) this.updatePageWindow(true);
          this.refreshThumbs();
          // 抽屉展开动画结束后兜底补画漏掉的缩略图（IO 刚展开时偶尔不回调）
          if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => this.sweepUnpaintedThumbs());
          }
          window.setTimeout(() => this.sweepUnpaintedThumbs(), 360);
        } else if (this.sideTab === "outlines") {
          this.outlineWinLo = -1;
          this.outlineWinHi = -1;
          this.outlineRowH = 0;
          this.buildOutlineWindow(true);
        } else {
          this.renderFavorites();
          this.scheduleFavoritePaint();
        }
      };
      /*
       * 用户：平板打开缩略图会先卡一下，有时干脆直接蹦出来没有动画。
       * 根因是「切换面板」和「同步建页列表 + 光栅化缩略图」挤在同一帧：
       * 首帧被主线程占住，滑入动画还没开始画就结束了。窗口 DOM 已经在
       * 上面同步建好，这里只把剩下的光栅化 / 统计推到动画起步之后；期间再收起则跳过。
       */
      if (this.prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
        finishOpen();
      } else {
        requestAnimationFrame(() => requestAnimationFrame(finishOpen));
      }
    }
  }

  /**
   * 展开抽屉的**首帧**就把缩略图窗口对准当前页（同步，赶在第一次绘制之前）。
   *
   * 只做三件便宜的事：按当前 scrollTop 建一次窗口（撑出上下 spacer、
   * 列表才有可滚动高度）、把 scrollTop 落到编辑器当前页、按新位置就地
   * 重建窗口。光栅化一张都不画，留给两帧后的 finishOpen。
   *
   * 顺序不能换：空列表 scrollHeight=0，先设 scrollTop 会被浏览器夹回 0，
   * 于是又从第 1 页建窗口——正是「先在第一页，然后才加载过来」的老路。
   */
  private primeThumbsToActivePage(): void {
    if (!this.store || !this.editor || !this.thumbVisible()) return;
    const list = this.pageListEl;
    const viewport = this.pageListViewportEl;
    if (!list || !viewport || list.clientWidth <= 0) return;
    // ① 撑出完整滚动高度（初次展开时列表还是空的）
    this.updatePageWindow(true);
    // ② 同步落到编辑器当前页，并按新位置重建窗口
    const cur = this.activeThumbPage();
    this.revealThumbForPage(cur, true);
    this.setActiveThumb(cur);
    this.syncThumbScrollbar();
  }

  private applyPageDock(): void {
    this.pagedockEl?.toggleClass("is-open", this.pagedockOpen);
    this.pagedockHandleEl?.setAttribute("aria-expanded", String(this.pagedockOpen));
    this.dockBtn?.toggleClass("is-active", this.pagedockOpen);
    this.dockBtn?.setAttribute("aria-expanded", String(this.pagedockOpen));
    this.syncThumbScrollbar();
  }

  /** 当前「每行几张」（1–4，越界回落 4） */
  private currentThumbCols(): number {
    const raw = this.plugin.settings.thumbCols;
    const n = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : 4;
    return Math.min(4, Math.max(1, n));
  }

  /** 把列数落到页列表的 grid 上（inline style，覆盖默认 4 列） */
  private applyThumbColsToGrid(): void {
    if (!this.pageListEl) return;
    this.pageListEl.style.gridTemplateColumns = `repeat(${this.currentThumbCols()}, minmax(0, 1fr))`;
  }

  private syncThumbColsBtns(): void {
    const n = this.currentThumbCols();
    for (const [val, b] of this.thumbColsBtns) b.toggleClass("is-active", val === n);
    // 列数切换后把紫色高亮片滑到新的那一档
    this.thumbColsPill?.layout();
  }

  /** 切换「每行几张」：写回设置、重排并重画（换列后单元格尺寸变，必须重画否则发糊） */
  private setThumbCols(n: number): void {
    const v = Math.min(4, Math.max(1, Math.round(n)));
    if (this.plugin.settings.thumbCols !== v) {
      this.plugin.settings.thumbCols = v;
      void this.plugin.saveSettings();
    }
    this.applyThumbColsToGrid();
    this.syncThumbColsBtns();
    if (!this.thumbVisible()) return;
    /*
     * 列数变了 → 单元格宽高全变。强制重建窗口（pageWinRowLo=-1 会走
     * resetPageWindowDom），让每张按新尺寸重新光栅化；否则复用旧画布会被
     * CSS 拉伸成糊的。
     */
    this.pageWinRowLo = -1;
    this.pageWinRowHi = -1;
    this.pageWinCols = 0;
    this.pageWinRowH = 0;
    this.updatePageWindow(true);
    this.refreshThumbs();
  }

  /** 收藏面板当前「每行几张」（1–4，越界回落 2） */
  private currentFavoriteCols(): number {
    const raw = this.plugin.settings.favoriteCols;
    const n = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : 2;
    return Math.min(4, Math.max(1, n));
  }

  /** 把列数落到收藏列表的 grid 上（inline style，覆盖默认 2 列） */
  private applyFavoriteColsToGrid(): void {
    if (!this.favoriteListEl) return;
    this.favoriteListEl.style.gridTemplateColumns = `repeat(${this.currentFavoriteCols()}, minmax(0, 1fr))`;
  }

  private syncFavoriteColsBtns(): void {
    const n = this.currentFavoriteCols();
    for (const [val, b] of this.favoriteColsBtns) b.toggleClass("is-active", val === n);
    // 切列数时把紫色高亮片滑到新的那一档
    this.favoriteColsPill?.layout();
  }

  /** 切换收藏面板「每行几张」：写回设置、重排并重画（单元格尺寸变了必须重画） */
  private setFavoriteCols(n: number): void {
    const v = Math.min(4, Math.max(1, Math.round(n)));
    if (this.plugin.settings.favoriteCols !== v) {
      this.plugin.settings.favoriteCols = v;
      void this.plugin.saveSettings();
    }
    this.applyFavoriteColsToGrid();
    this.syncFavoriteColsBtns();
    /*
     * 列数变了 → 卡片宽高全变。重建卡片让画布按新尺寸重新光栅化，
     * 否则复用旧画布会被 CSS 拉伸成糊的（与缩略图面板同一处理）。
     */
    this.renderFavorites();
    this.scheduleFavoritePaint();
  }

  /**
   * 平板：点「抽屉 / 侧栏」以外的地方自动收起。
   *
   * 只在平板生效——桌面上右侧栏是常驻面板，点画布不该把它关掉。
   * 只处理落到本视图内的点击；点开它们的那个开关本身不算「外部」，
   * 由开关自己的 click 负责开合，避免同一次点击先被关掉又被打开。
   */
  private onGlobalPointerDown(e: PointerEvent): void {
    if (!this.tabletMode) return;
    const t = e.target as Node | null;
    if (!t || !this.containerEl.contains(t)) return;

    let closed = false;
    if (this.pagedockOpen) {
      const inDock =
        (this.pagedockEl?.contains(t) ?? false) ||
        (this.dockBtn?.contains(t) ?? false) ||
        (this.pagedockHandleEl?.contains(t) ?? false);
      if (!inDock) {
        this.togglePageDock();
        closed = true;
      }
    }

    if (this.sideShown) {
      /*
       * 侧栏按钮本身要算作「侧栏内部」，否则捕获阶段先收起、
       * 随后 onclick 又展开，用户第二下永远关不掉侧栏。
       */
      const inSide =
        (this.sideEl?.contains(t) ?? false) ||
        (this.sideBtn?.contains(t) ?? false) ||
        (this.railSideBtn?.contains(t) ?? false);
      if (!inSide) {
        this.toggleSide();
        closed = true;
      }
    }
    /*
     * 点纸面空白处收起面板：这一下不该落笔（用笔点一下只是想关面板，
     * 不希望顺手画出一道笔迹）。本监听在 document 捕获阶段，早于画布的
     * pointerdown；命中纸面时拦截掉，画布的 onDown 就收不到。
     */
    if (closed) {
      const onPaper = this.editor?.scrollEl?.contains(t) ?? false;
      if (onPaper) {
        e.stopPropagation();
        e.preventDefault();
      }
    }
  }

  /** 切换侧栏下方面板：缩略图 ⇄ 目录 ⇄ 收藏 */
  private setSideTab(tab: "thumbs" | "outlines" | "favorites"): void {
    if (this.sideTab === tab) return;
    this.sideTab = tab;
    this.applySideTab();
    if (tab === "thumbs") {
      // 别的标签期间页列表是 display:none，量不到尺寸、也没建过条目
      this.updatePageWindow(true);
      this.refreshThumbs();
      // 切回缩略图时同样同步定位到当前页（同一帧内建好窗口，不闪第 1 页）
      this.syncThumbsToActivePage();
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => this.sweepUnpaintedThumbs());
      }
      window.setTimeout(() => this.sweepUnpaintedThumbs(), 120);
    } else if (tab === "outlines") {
      // 目录标签期间视口可能是隐藏的，强制重测行高并重建窗口
      this.outlineWinLo = -1;
      this.outlineWinHi = -1;
      this.outlineRowH = 0;
      this.buildOutlineWindow(true);
    } else {
      this.renderFavorites();
      this.scheduleFavoritePaint();
    }
  }

  /** 把当前 sideTab 反映到标签选中态和三个面板的显隐上 */
  private applySideTab(): void {
    this.sideThumbPane?.toggleClass("is-hidden", this.sideTab !== "thumbs");
    this.sideOutlinePane?.toggleClass("is-hidden", this.sideTab !== "outlines");
    this.sideFavoritePane?.toggleClass("is-hidden", this.sideTab !== "favorites");
    for (const b of this.sideTabBtns) {
      const on = b.dataset.tab === this.sideTab;
      b.toggleClass("is-active", on);
      b.setAttribute("aria-selected", String(on));
    }
    this.syncThumbScrollbar();
    // 标签切换后紫色高亮片滑到目标位置（第三个标签同样连续滑过去）
    this.sidePill?.layout();
  }

  /** 收藏 / 取消收藏指定页；真的变了才刷 UI、记历史和自动保存 */
  private setPageFavorite(index: number, on: boolean): void {
    if (!this.store?.setFavorite(index, on)) return;
    this.updateUI();
  }

  /** 「收藏当前页」按钮：以编辑器实时页为准，不用落盘里的 activePage 镜像 */
  private toggleCurrentFavorite(): void {
    if (!this.store) return;
    const index = this.activeThumbPage();
    this.setPageFavorite(index, !this.store.data.pages[index]?.favorite);
  }

  /** 收藏列表 / 当前页按钮的轻量同步（updateUI 每帧都可能跑） */
  private syncFavoritesUI(): void {
    if (!this.store) return;
    const listSig = [
      this.store.favoriteRev,
      this.store.pageOrderRev,
      this.store.pageCount,
    ].join(":");
    if (listSig !== this.favoriteListSig) {
      this.favoriteListSig = listSig;
      this.renderFavorites();
      this.scheduleFavoritePaint();
    }
    const cur = this.activeThumbPage();
    const on = this.store.data.pages[cur]?.favorite === true;
    const btnSig = cur + ":" + on;
    if (btnSig !== this.favoriteBtnSig) {
      this.favoriteBtnSig = btnSig;
      this.syncFavoriteCurrentBtn(cur, on);
    }
    this.favoriteListEl?.querySelectorAll(".mb-fav-card").forEach((el) => {
      el.toggleClass("is-active", Number((el as HTMLElement).dataset.page) === cur);
    });
    // 收藏变化时把可见缩略图的小星标一起刷正（落笔时 favoriteRev 不变，不重刷）
    if (this.store.favoriteRev !== this.thumbFavRev) {
      this.thumbFavRev = this.store.favoriteRev;
      for (const [i, item] of this.thumbItems) this.applyThumbFavMark(item, i);
    }
  }

  private syncFavoriteCurrentBtn(index: number, on: boolean): void {
    const btn = this.favoriteCurrentBtn;
    const label = this.favoriteCurrentLabel;
    if (!btn || !label) return;
    const text = on ? "取消收藏当前页" : "收藏当前页";
    label.setText(text);
    btn.toggleClass("is-active", on);
    btn.setAttr("aria-pressed", String(on));
    btn.setAttr("aria-label", text);
    btn.title = text;
  }

  /** 重建收藏页缩略图列表（收藏页通常很少，不需要窗口化） */
  private renderFavorites(): void {
    const list = this.favoriteListEl;
    if (!list || !this.store) return;
    list.empty();
    this.favoriteThumbCanvases.clear();
    const pages = this.store.favoritePages;
    this.favoriteEmptyEl?.toggleClass("is-hidden", pages.length > 0);
    const cur = this.activeThumbPage();
    for (const index of pages) {
      const card = list.createDiv("mb-fav-card" + (index === cur ? " is-active" : ""));
      card.dataset.page = String(index);
      card.dataset.pageId = this.store.data.pages[index]?.id ?? "";
      card.setAttr("aria-label", `跳到第 ${index + 1} 页`);
      card.title = `跳到第 ${index + 1} 页`;
      const cv = document.createElement("canvas");
      cv.className = "mb-fav-canvas";
      card.appendChild(cv);
      this.favoriteThumbCanvases.set(index, cv);
      card.createDiv({ cls: "mb-fav-num", text: String(index + 1) });
      const remove = card.createEl("button", {
        cls: "mb-fav-remove",
        attr: { type: "button", "aria-label": "取消收藏", title: "取消收藏" },
      });
      setIcon(remove, "star");
      remove.onclick = (e) => {
        e.stopPropagation();
        this.setPageFavorite(index, false);
      };
      card.onclick = () => this.editor?.goToPage(index);
    }
  }

  /** 把收藏缩略图补画合并到下一帧；面板隐藏时直接跳过（量不到尺寸） */
  private scheduleFavoritePaint(): void {
    if (this.favoritePaintRaf) return;
    const run = () => {
      this.favoritePaintRaf = 0;
      this.paintFavoriteThumbs();
    };
    if (typeof window.requestAnimationFrame === "function") {
      this.favoritePaintRaf = window.requestAnimationFrame(run);
    } else {
      this.favoritePaintRaf = window.setTimeout(run, 16);
    }
  }

  private paintFavoriteThumbs(): void {
    if (!this.editor || !this.favoritesVisible()) return;
    for (const [index, cv] of this.favoriteThumbCanvases) {
      if (cv.isConnected) this.editor.renderThumbnail(cv, index);
    }
  }

  private templateIndex(id: TemplateId): number {
    return TEMPLATES.findIndex((t) => t.id === id);
  }

  private renderTemplates(): void {
    if (!this.templateGrid || !this.store) return;
    this.templateGrid.empty();
    this.templateCards.clear();
    const cur = this.store.page.template;
    for (const t of TEMPLATES) {
      const card = this.templateGrid.createDiv("mb-tpl" + (t.id === cur ? " is-active" : ""));
      const art = card.createDiv("mb-tpl-art");
      const cv = document.createElement("canvas");
      art.appendChild(cv);
      paintPaperPreview(cv, t.id, this.store.page.paper, A4_WIDTH, A4_HEIGHT);
      card.createDiv({ cls: "mb-tpl-name", text: t.label });
      card.onclick = () => {
        this.editor?.setTemplate(t.id);
        this.updateUI();
      };
      this.templateCards.set(t.id, card);
    }
    this.templatePaperSig = this.store.page.paper;
  }

  private renderPapers(): void {
    if (!this.paperRow || !this.store) return;
    this.paperRow.empty();
    this.paperChips.clear();
    const cur = this.store.page.paper;
    for (const p of PAPERS) {
      const b = this.paperRow.createDiv("mb-paper-chip" + (p.id === cur ? " is-active" : ""));
      b.style.background = p.id === "cream" ? "#FCF8EC" : p.id === "gray" ? "#F5F5F3" : "#FFFFFF";
      b.title = p.label;
      b.createSpan({ cls: "mb-paper-name", text: p.label });
      b.onclick = () => {
        this.editor?.setPaper(p.id);
        this.updateUI();
      };
      this.paperChips.set(p.id, b);
    }
  }

  private renderLayers(): void {
    if (!this.layerListEl || !this.store) return;
    this.layerListEl.empty();
    const page = this.store.page;
    for (const layer of page.layers) {
      const row = this.layerListEl.createDiv("mb-layer");
      row.toggleClass("is-active", layer.id === page.activeLayerId);
      const eye = row.createEl("button", { cls: "mb-layer-eye", attr: { "aria-label": "显示 / 隐藏" } });
      setIcon(eye, layer.visible ? "eye" : "eye-off");
      eye.onclick = (e) => {
        e.stopPropagation();
        this.editor?.toggleLayer(layer.id);
      };
      const name = row.createSpan({ cls: "mb-layer-name", text: layer.name });
      name.ondblclick = (e) => {
        e.stopPropagation();
        new PromptModal(this.app, "重命名图层", layer.name, (v) => {
          this.editor?.renameLayer(layer.id, v);
        }).open();
      };
      row.createSpan({ cls: "mb-layer-count", text: String(layer.strokes.length) });
      if (page.layers.length > 1) {
        const del = row.createEl("button", { cls: "mb-layer-del", attr: { "aria-label": "删除图层" } });
        setIcon(del, "trash-2");
        del.onclick = (e) => {
          e.stopPropagation();
          this.editor?.deleteLayer(layer.id);
        };
      }
      /*
       * 透明度滑杆。
       *
       * `Layer.opacity` 一直参与渲染（editor 的 renderRec / 导出都按它画），
       * 但以前侧栏没有入口，只能改文件。这里补上「看得到、改得动」。
       *
       * 交互细节：
       *   · 滑杆上的点击不能冒泡到行，否则会触发 setActiveLayer → updateUI；
       *     一旦图层签名变了整行会重建，正在拖的滑杆就从 DOM 里消失了。
       *   · 一次拖动只在第一次 input 时拍撤销快照（editor.setLayerOpacity 的
       *     snapshot 参数），否则拖一下就能塞满 60 层撤销栈。
       */
      const op = row.createDiv("mb-layer-op");
      op.addEventListener("pointerdown", (e) => e.stopPropagation());
      op.addEventListener("click", (e) => e.stopPropagation());
      const opRange = op.createEl("input", {
        cls: "mb-layer-op-range",
        attr: {
          type: "range",
          min: "0",
          max: "100",
          step: "1",
          value: String(Math.round(layer.opacity * 100)),
          "aria-label": "图层透明度",
        },
      });
      const opVal = op.createSpan({
        cls: "mb-layer-op-val",
        text: Math.round(layer.opacity * 100) + "%",
      });
      let opDragging = false;
      opRange.oninput = () => {
        const v = Number(opRange.value) / 100;
        this.editor?.setLayerOpacity(layer.id, v, !opDragging);
        opDragging = true;
        opVal.setText(String(opRange.value) + "%");
      };
      // 一次拖动结束（鼠标/触摸松开、键盘调整完失焦）：下一次重新记撤销
      const endOpacityDrag = () => {
        opDragging = false;
      };
      opRange.onchange = endOpacityDrag;
      opRange.onpointerup = endOpacityDrag;
      row.onclick = () => {
        this.editor?.setActiveLayer(layer.id);
      };
    }
    this.layerSig = this.layerSignature();
  }

  private layerSignature(): string {
    if (!this.store) return "";
    const p = this.store.page;
    return (
      p.activeLayerId +
      "|" +
      // 带上 opacity：撤销 / 重做改了透明度时，侧栏滑杆要跟着回位。
      // 拖动过程中不经过这里——oninput 只 markDirty，不触发 updateUI。
      //
      // **刻意不含 strokes.length**（2026-11-07 修）：每落一笔
      // （onUp → emitState → updateUI）笔迹数都会变，带着它就会**每写一笔
      // 整块重建图层列表 DOM** —— 行里的透明度滑杆、双击改名的监听全被换掉。
      // 笔迹数只是个数字，由 `syncLayerCounts()` 就地刷 textContent 即可。
      p.layers.map((l) => `${l.id}:${l.name}:${l.visible}:${l.opacity}`).join(",")
    );
  }

  /**
   * 就地刷新图层行里的「笔迹数」（不重建 DOM）。
   *
   * 每次 updateUI 都调，代价是「图层数」次 `querySelector`，通常 1~3 行。
   * 比每写一笔重建整个图层列表便宜得多。
   */
  private syncLayerCounts(): void {
    if (!this.store || !this.layerListEl) return;
    const layers = this.store.page.layers;
    const rows = this.layerListEl.querySelectorAll<HTMLElement>(".mb-layer");
    for (let i = 0; i < rows.length && i < layers.length; i += 1) {
      const el = rows[i].querySelector<HTMLElement>(".mb-layer-count");
      const n = String(layers[i].strokes.length);
      if (el && el.textContent !== n) el.textContent = n;
    }
  }

  /* ------------------------------- 目录 ------------------------------- */

  /**
   * 渲染侧栏「目录」区。
   *
   * **只在内容真的变了才重建**：落笔时 updateUI 会跑几十次，
   * 目录不变的话一次 DOM 都不动（`store.outlineRev` 是内容版本号，
   * 改名/挪位置都会让它变，条数不够）。
   *
   * 条目多了也不一次建几千个 DOM：目录区有自己的滚动容器，
   * 只建可视区附近的条目（见 buildOutlineWindow）。
   */
  private renderOutlines(force = false): void {
    if (!this.outlineListEl || !this.store) return;
    const rev = this.store.outlineRev;
    if (!force && rev === this.outlineRev) return;
    this.outlineRev = rev;
    // 内容变了 → 窗口失效，重建可视区那几条
    this.outlineWinLo = -1;
    this.outlineWinHi = -1;
    this.buildOutlineWindow(true);
  }

  /**
   * 目录窗口：只建可视区附近的条目。
   *
   * 条目高度固定（单行），所以按「条」算就行：
   *   · 可视区高 / 条高 = 能放几条；
   *   · 上下各多建几条（overscan），滚动时不至于先看到空白；
   *   · 上下用两个整块 spacer 撑高度（跟页列表的 buildPageWindow 一个路子），
   *     滚动条长度与滚动位置都不变——加了目录不会把滚动位置顶走。
   *
   * 目录区是**独立滚动容器**（.mb-outlines 自己滚），所以可视区起点
   * 就是它自己的 scrollTop。
   */
  private buildOutlineWindow(force = false): void {
    const list = this.outlineListEl;
    const viewport = this.outlineViewportEl;
    if (!list) return;
    const items = this.store?.outlines ?? [];
    const total = items.length;

    // 条目不多：全建（省掉量高度那点开销，几十条 DOM 无所谓）
    if (!viewport || total <= OUTLINE_WINDOW_MAX) {
      if (force || this.outlineWinLo !== 0 || this.outlineWinHi !== total) {
        list.empty();
        for (const o of items) this.buildOutlineRow(list, o);
        this.outlineWinLo = 0;
        this.outlineWinHi = total;
      }
      return;
    }

    /*
     * 条目高度是 CSS 定死的（单行），量一次就够——
     * 每次滚动都插一条探针再量一遍，白白多一次 reflow。
     *
     * **量到 0 时不要缓存**：侧栏可能是 display:none（收起状态），
     * 探针量出 0 会被 `|| OUTLINE_ROW_H` 兜底成常量并存下来，
     * 之后就再也不会重测 —— 一旦常量与真实行高不符，spacer 总高度
     * 会一直算错（滚动条比例失真）。所以只有量到正数才缓存。
     */
    if (!this.outlineRowH) {
      const probe = list.createDiv("mb-outline");
      const measured = probe.getBoundingClientRect().height;
      probe.remove();
      // 量到正数才缓存；量到 0（不可见）就用兜底算这一次，下次再量
      if (measured > 0) this.outlineRowH = measured;
    }
    const rowH = this.outlineRowH || OUTLINE_ROW_H;
    const vpH = viewport.clientHeight || OUTLINE_VIEWPORT_H;
    const visible = Math.max(1, Math.ceil(vpH / rowH));
    const scrollTop = viewport.scrollTop || 0;
    const lo = Math.max(0, Math.floor(scrollTop / rowH) - OUTLINE_OVERSCAN);
    const hi = Math.min(total, lo + visible + OUTLINE_OVERSCAN * 2);

    // 窗口没变就不用重建（滚动时只有跨过边界才变）
    if (!force && lo === this.outlineWinLo && hi === this.outlineWinHi) {
      this.updateOutlineSpacers(lo, hi, rowH, total);
      return;
    }
    this.outlineWinLo = lo;
    this.outlineWinHi = hi;

    list.empty();
    // 上 spacer：高度 = 未建条数 × 行高
    if (lo > 0) {
      const pad = list.createDiv("mb-outline-pad");
      pad.style.height = Math.max(0, lo * rowH) + "px";
    }
    for (let i = lo; i < hi; i++) this.buildOutlineRow(list, items[i]);
    // 下 spacer
    if (hi < total) {
      const pad = list.createDiv("mb-outline-pad");
      pad.style.height = Math.max(0, (total - hi) * rowH) + "px";
    }
  }

  /**
   * 上下 spacer 的高度（窗口没变但行高变了也要跟着改）。
   */
  private updateOutlineSpacers(lo: number, hi: number, rowH: number, total: number): void {
    const list = this.outlineListEl;
    if (!list) return;
    const pads = list.querySelectorAll<HTMLElement>(".mb-outline-pad");
    if (pads.length === 2) {
      pads[0].style.height = Math.max(0, lo * rowH) + "px";
      pads[1].style.height = Math.max(0, (total - hi) * rowH) + "px";
    }
  }

  /**
   * 建一条目录条目。
   *
   * 每条显示：名字 + 页码（1 起给人看；存的是 0 起下标）。
   * 点击整条 → 跳到那一页；双击名字 → 改名；垃圾桶 → 删除。
   */
  private buildOutlineRow(list: HTMLElement, o: Outline): void {
    const store = this.store;
    if (!store) return;
    const row = list.createDiv("mb-outline");
    row.dataset.outlineId = o.id;
    // 指向的页可能已经不存在了（页被删过）——夹到有效范围，绝不抛异常
    const page = store.clampOutlinePage(o.page);
    const stale = page !== o.page;

    const name = row.createSpan({ cls: "mb-outline-name", text: o.title });
    name.title = stale ? `${o.title}（原指向第 ${o.page + 1} 页，已超出范围）` : o.title;
    name.ondblclick = (e) => {
      e.stopPropagation();
      this.showRenameOutline(o.id);
    };
    const pageTag = row.createSpan({
      cls: "mb-outline-page" + (stale ? " is-stale" : ""),
      text: `第 ${page + 1} 页`,
    });

    const act = row.createDiv("mb-outline-act");
    const edit = act.createEl("button", { cls: "mb-outline-btn", attr: { "aria-label": "编辑目录" } });
    setIcon(edit, "pencil");
    edit.title = "改名 / 改页码";
    edit.onclick = (e) => {
      e.stopPropagation();
      this.showEditOutline(o.id);
    };
    const del = act.createEl("button", { cls: "mb-outline-btn", attr: { "aria-label": "删除目录" } });
    setIcon(del, "trash-2");
    del.title = "删除";
    del.onclick = (e) => {
      e.stopPropagation();
      store.removeOutline(o.id);
      this.updateUI();
    };

    row.onclick = () => {
      const at = store.clampOutlinePage(o.page);
      this.editor?.goToPage(at);
      this.updateUI();
    };
  }

  /** 「+ 添加目录」：弹窗输入名字 + 页码 */
  private showAddOutline(): void {
    if (!this.store) return;
    const total = this.store.pageCount;
    const current = this.store.data.activePage;
    new OutlineModal(
      this.app,
      total,
      current,
      "",
      current,
      (title, page) => {
        this.store?.addOutline(title, page);
        this.updateUI();
      }
    ).open();
  }

  /** 编辑一条目录：改名 + 改页码（一次操作 = 一条撤销记录） */
  private showEditOutline(id: string): void {
    if (!this.store) return;
    const item = this.store.outlines.find((o) => o.id === id);
    if (!item) return;
    new OutlineModal(
      this.app,
      this.store.pageCount,
      this.store.data.activePage,
      item.title,
      item.page,
      (title, page) => {
        this.store?.updateOutline(id, title, page);
        this.updateUI();
      }
    ).open();
  }

  /** 双击名字 → 只改名（页码不动） */
  private showRenameOutline(id: string): void {
    if (!this.store) return;
    const item = this.store.outlines.find((o) => o.id === id);
    if (!item) return;
    new PromptModal(this.app, "重命名目录", item.title, (v) => {
      this.store?.renameOutline(id, v);
      this.updateUI();
    }).open();
  }

  /**
   * 渲染侧栏页列表。
   *
   * 大本子（857 页）不能给每页都建 canvas + 3 个子节点：光建 DOM 就是
   * 几十毫秒，等于打开时间的一半。现在按「行」窗口化：
   *   · `.mb-pages` 是固定列数的等高网格，行高 = 列宽 × aspect-ratio + 行距；
   *   · 只给可视区上下各 OVERSCAN 行建条目，其余用两个整行 spacer 撑高度；
   *   · 滚动时按行**增量挪动窗口**：还在窗口里的条目 DOM 不动，只回收离开的、
   *     补建新进入的；回收条目连 canvas 像素一起进复用池（见 buildPageWindow）；
   *   · 缩略图仍由 IntersectionObserver 负责「进视口才画」——
   *     窗口只决定「有哪些条目」，不改变懒画语义。
   */
  private renderPageList(): void {
    if (!this.pageListEl || !this.store || !this.editor) return;
    // 页数变了：立刻失效窗口（不跨页复用 DOM，闭包里捕获的页号会过期）
    this.pageWinRowLo = -1;
    this.pageWinRowHi = -1;
    this.updatePageWindow(true);

    /*
     * 先只画当前页；相邻页延到空闲时再画。
     * 857 页的本子打开时，5 张缩略图会同时排进 pdf.js 的渲染队列，
     * 和首屏那一页抢 IO/CPU，用户感觉就是「打开半天」。
     * 窗口里没有当前页时 drawThumbRange 会自然跳过，等滚进来由 IO 补画。
     */
    const current = this.activeThumbPage();
    this.drawThumbRange(current, 0);
    const idle = (window as any).requestIdleCallback as
      | ((cb: () => void, opts?: { timeout: number }) => number)
      | undefined;
    if (typeof idle === "function") idle(() => this.drawThumbRange(current, 2), { timeout: 1200 });
    else window.setTimeout(() => this.drawThumbRange(current, 2), 300);
  }

  /**
   * 按当前滚动位置重算页列表窗口。
   *
   * @param force 忽略「窗口没变」的快路径（页数变化 / 展开侧栏时用）
   */
  private updatePageWindow(force: boolean): void {
    const list = this.pageListEl;
    const viewport = this.pageListViewportEl;
    if (!list || !viewport || !this.store || !this.editor) return;
    if (!this.thumbVisible()) return;
    // display:none / 尚未布局时量不到宽度，等展开事件或 ResizeObserver 再来
    if (list.clientWidth <= 0) return;

    const count = this.store.pageCount;
    const { cols, gap, rowH } = this.measurePageGrid(list);
    if (!(cols > 0) || !(rowH > 0)) return;
    // 每页一格 + 末尾一个「加一页」
    const totalRows = Math.ceil((count + 1) / cols);
    const full = totalRows <= PAGE_GRID_FULL_ROWS;

    let rowLo = 0;
    let rowHi = totalRows;
    if (!full) {
      const listRect = list.getBoundingClientRect();
      const vpRect = viewport.getBoundingClientRect();
      const top = Math.max(0, vpRect.top - listRect.top);
      const bottom = Math.min(listRect.height, vpRect.bottom - listRect.top);
      if (bottom <= top) {
        /*
         * 页列表整个在视口外（很常见：刚展开侧栏，页列表还在下面没滚到）。
         * 先只建第一行：一是给用户滚下来时立刻有内容，
         * 二是靠真实条目把行高量准——下方 spacer 有上万像素，估错会累积。
         */
        rowLo = 0;
        rowHi = Math.min(totalRows, 1);
      } else {
        const topRow = this.pageListYToRow(top, rowH);
        const bottomRow = this.pageListYToRow(bottom, rowH);
        rowLo = Math.max(0, Math.floor(topRow) - PAGE_GRID_OVERSCAN_ROWS);
        rowHi = Math.min(totalRows, Math.ceil(bottomRow) + PAGE_GRID_OVERSCAN_ROWS);
        if (rowHi <= rowLo) rowHi = Math.min(totalRows, rowLo + 1);
        rowLo = Math.min(rowLo, totalRows - 1);
      }
    }
    // DOM 被外部清空（测试 / 宿主重置）时窗口状态不可信，必须重建
    if (!list.firstElementChild) force = true;
    if (
      !force &&
      rowLo === this.pageWinRowLo &&
      rowHi === this.pageWinRowHi &&
      cols === this.pageWinCols &&
      Math.abs(rowH - this.pageWinRowH) < 1 &&
      count === this.pageCountSig &&
      (this.store?.pageOrderRev ?? 0) === this.pageOrderRev
    ) {
      return;
    }
    /*
     * 注意：窗口范围没变但页数/页序变了（删页后仍停在同一个窗口、
     * 侧栏收起期间撤销了加页……）也必须走 buildPageWindow。
     * 那里会比 pageCountSig / pageOrderRev 走全量重置，
     * 避免增量复用把旧 dataset.pageId 和旧闭包下标留下来。
     */
    this.buildPageWindow(rowLo, rowHi, cols, gap, rowH, totalRows, count);
  }

  /**
   * 列表纵坐标（px）→ 行号。
   *
   * 侧栏宽度变化后，旧 spacer 还是按旧行高撑的，条目却按新行高排。
   * 直接 y / 新行高 会在「上 spacer + 已建行 + 下 spacer」三段之间算错，
   * 这里分段换算：上 spacer 用旧行高，已建行用新行高，下 spacer 继续按
   * 新行高外推。重建后视口仍落在同一页附近，不会跳到列表另一端。
   */
  private pageListYToRow(y: number, rowH: number): number {
    const prevLo = this.pageWinRowLo;
    const prevHi = this.pageWinRowHi;
    const prevH = this.pageWinRowH;
    if (prevLo <= 0 || prevH <= 0) return y / rowH;
    const firstRowY = prevLo * prevH; // 上 spacer 占 prevLo 行；行距已含在 rowH 里
    if (y <= firstRowY) return y / prevH;
    const renderedEndY = firstRowY + Math.max(0, prevHi - prevLo) * rowH;
    if (y <= renderedEndY) return prevLo + (y - firstRowY) / rowH;
    return prevHi + (y - renderedEndY) / rowH;
  }

  /** 量网格：列数、行距、行高（真实条目优先；量不到才按列宽估） */
  private measurePageGrid(list: HTMLElement): { cols: number; gap: number; rowH: number } {
    const cs = window.getComputedStyle(list);
    const tracks = (cs.gridTemplateColumns || "")
      .trim()
      .split(/\s+/)
      .filter((s) => /^-?\d+(\.\d+)?px$/.test(s));
    const cols = Math.max(1, tracks.length || 4);
    let gap = parseFloat(cs.rowGap);
    if (!Number.isFinite(gap)) gap = 7;

    const probe = list.querySelector(".mb-thumb:not(.mb-thumb-add)") as HTMLElement | null;
    let itemH = probe ? probe.getBoundingClientRect().height : 0;
    if (!(itemH > 2)) {
      // 还没有条目（首次渲染）：按列宽 × 宽高比估一个，建完再用真实条目校准
      let colW = tracks.length ? parseFloat(tracks[0]) : 0;
      if (!(colW > 0)) colW = (list.clientWidth - gap * (cols - 1)) / cols;
      itemH = Math.max(1, colW) * PAGE_THUMB_ASPECT;
    }
    return { cols, gap, rowH: Math.max(1, itemH + gap) };
  }

  /**
   * 按行区间更新页列表 DOM（**增量**，不整屏重建）。
   *
   * 高度守恒：上下 spacer + 已建行的总高度 = 未窗口化时整个网格的高度，
   * 所以滚动条长度与滚动位置都不变（滑到底、跳页都不会漂）。
   *
   * 滚动跨行时：
   *   · 还在窗口里的页 → DOM 一个节点都不动，canvas 元素对象和像素都保留；
   *   · 新进入窗口的页 → 先从回收池按页号取（取到就是原 canvas，直接有图），
   *     取不到才新建；
   *   · 离开窗口的页 → 连 canvas 一起移出 DOM 放进回收池，不重置尺寸。
   * 这样就不会出现「旧 canvas 被摘下、新 canvas 还没画完」的空白帧。
   *
   * 只有首建 / 页数或页序变化（renderPageList 会把 pageWinRowLo 置 -1）/
   * 宿主清空过 DOM 时才走 resetPageWindowDom 全量重置。
   */
  private buildPageWindow(
    rowLo: number,
    rowHi: number,
    cols: number,
    gap: number,
    rowH: number,
    totalRows: number,
    count: number,
    allowRemeasure = true
  ): void {
    const list = this.pageListEl;
    if (!list) return;
    // 拖拽期间冻结窗口：不回收/补建条目，否则被拖的 DOM 节点会被换掉
    if (this.thumbDragActive) return;
    const firstCell = rowLo * cols;
    const lastCell = Math.min(rowHi * cols, count + 1);

    /*
     * 全量重置的判据：
     *   · 首建 / 页数、页序变化：dataset.pageId 和闭包里的下标都会过期；
     *     侧栏收起期间发生的变化不会走 renderPageList，所以这里也要比一次。
     *   · DOM 被宿主/测试清空。
     * 正常滚动时这几个条件都不成立，走下面的增量路径。
     */
    if (
      this.pageWinRowLo < 0 ||
      this.pageWinCols <= 0 ||
      !list.firstElementChild ||
      count !== this.pageCountSig ||
      (this.store?.pageOrderRev ?? 0) !== this.pageOrderRev
    ) {
      this.resetPageWindowDom(list);
    }
    // 长按计时器挂在条目上；取消计时，但**不重建节点**
    this.cancelThumbPress();

    /* ---------- 上 spacer：高度 = 未建行 × 行高 - 一个行距 ---------- */
    let topPad = this.pageTopPadEl;
    if (rowLo > 0) {
      if (!topPad) {
        topPad = document.createElement("div");
        topPad.className = "mb-thumb-pad";
        this.pageTopPadEl = topPad;
      }
      topPad.style.height = Math.max(0, rowLo * rowH - gap) + "px";
      if (topPad.parentElement !== list || list.firstElementChild !== topPad) {
        list.insertBefore(topPad, list.firstElementChild);
      }
    } else if (topPad) {
      topPad.remove();
      this.pageTopPadEl = null;
      topPad = null;
    }

    /* ---------- 1. 回收离开窗口的条目（像素留在 canvas 上，进池） ---------- */
    for (const [idx, item] of Array.from(this.thumbItems)) {
      if (idx < firstCell || idx >= lastCell) this.recycleThumbItem(idx, item);
    }
    const addInWindow = count >= firstCell && count < lastCell;
    if (this.addThumbEl && !addInWindow) {
      this.addThumbEl.remove();
      this.addThumbEl = null;
    }

    /* ---------- 2. 新进入窗口的页：池里按页号取，取不到才新建 ---------- */
    const current = this.activeThumbPage();
    let prev: Element | null = topPad;
    for (let i = firstCell; i < lastCell; i += 1) {
      if (i < count) {
        let item = this.thumbItems.get(i);
        if (!item) {
          const pooled = this.thumbItemPool.get(i);
          if (pooled) {
            this.thumbItemPool.delete(i);
            item = pooled;
            /*
             * 躺在池里的这段时间，当前页、页序都可能变过；把状态刷正。
             *
             * `dataset.pageId` **必须重写**：条目按页号复用时它还是旧值。
             * 池本身按 index 存，页序不变时两者恰好一致，所以历史上没暴露；
             * 但拖拽的 click 守卫（`thumbDragClickGuardId`）是**按 pageId
             * 比对**的，一旦哪天页序变后走了复用路径，就会对不上、误挡或漏挡。
             * 顺手写一行，比靠「调用方保证页序不变」更稳。
             */
            item.dataset.pageId = this.store?.data.pages[i]?.id ?? "";
            item.classList.toggle("is-active", i === current);
            // 收藏态可能在条目躺池期间改过（比如在收藏面板里取消），复用时要刷正
            this.applyThumbFavMark(item, i);
            delete item.dataset.longPressAt;
            const cv = item.querySelector(".mb-thumb-canvas") as HTMLCanvasElement | null;
            if (cv) this.thumbCanvases.set(i, cv);
          } else {
            item = this.createThumbItem(i, i === current);
          }
          this.thumbItems.set(i, item);
          list.insertBefore(item, prev ? prev.nextSibling : list.firstChild);
          // 先入 DOM 再观察：没有 IO 的兜底路径要量到真实尺寸（detached 元素量不到）
          this.watchThumbItem(item);
        }
        prev = item;
      } else {
        let add = this.addThumbEl;
        if (!add) {
          add = this.createAddThumb();
          this.addThumbEl = add;
          list.insertBefore(add, prev ? prev.nextSibling : list.firstChild);
        }
        prev = add;
      }
    }

    /* ---------- 下 spacer：放在所有条目之后 ---------- */
    let bottomPad = this.pageBottomPadEl;
    if (rowHi < totalRows) {
      if (!bottomPad) {
        bottomPad = document.createElement("div");
        bottomPad.className = "mb-thumb-pad";
        this.pageBottomPadEl = bottomPad;
      }
      bottomPad.style.height = Math.max(0, (totalRows - rowHi) * rowH - gap) + "px";
      if (bottomPad.parentElement !== list || list.lastElementChild !== bottomPad) {
        list.appendChild(bottomPad);
      }
    } else if (bottomPad) {
      bottomPad.remove();
      this.pageBottomPadEl = null;
    }

    this.pageCountSig = count;
    this.pageOrderRev = this.store?.pageOrderRev ?? 0;
    this.pageWinRowLo = rowLo;
    this.pageWinRowHi = rowHi;
    this.pageWinCols = cols;
    this.pageWinRowH = rowH;
    /*
     * 当前页不在窗口里时保持 null：updateUI 里的 setActiveThumb 会安全地
     * 清掉旧高亮，绝不滚动侧栏。
     */
    if (this.activeThumbEl && !this.activeThumbEl.isConnected) this.activeThumbEl = null;
    this.setActiveThumb(current);

    /*
     * 首次渲染没有条目可量，行高是估的。建完立刻用真实条目校准：
     * 857 页时下 spacer 约 200 行，每行差 0.5px 就是上百像素的滚动误差。
     * 重入时窗口范围相同，走增量路径，只改 spacer 高度。
     */
    if (allowRemeasure) {
      const probe = list.querySelector(".mb-thumb:not(.mb-thumb-add)") as HTMLElement | null;
      const measured = probe ? probe.getBoundingClientRect().height + gap : 0;
      if (measured > 2 && Math.abs(measured - rowH) > 0.5) {
        this.buildPageWindow(rowLo, rowHi, cols, gap, measured, totalRows, count, false);
      }
    }
  }

  /**
   * 全量重置页列表窗口 DOM。
   *
   * 只在页数/页序变化、侧栏重建、宿主清空 DOM 时调用。
   * 正常滚动**不该**走这里——整屏重建正是缩略图闪烁的来源。
   */
  private resetPageWindowDom(list: HTMLElement): void {
    // 若拖拽还在（不该发生，但为兜底）：先收掉 drag 态，避免 ghost/指示线
    // 残留在 list.empty() 之后的文档里
    if (this.thumbDragActive) this.cancelThumbDrag();
    this.thumbObserver?.disconnect();
    this.thumbObserver = null;
    // 长按菜单和计时器都挂在旧节点上，重建前先收掉（否则引用悬空）
    this.cancelThumbPress();
    this.closeThumbMenu();
    list.empty();
    this.thumbCanvases.clear();
    this.thumbItems.clear();
    this.thumbItemPool.clear();
    this.addThumbEl = null;
    this.pageTopPadEl = null;
    this.pageBottomPadEl = null;
    this.activeThumbEl = null;
  }

  /**
   * 条目滚出窗口：移出 DOM，按页号放进回收池。
   *
   * 关键：**不碰 canvas.width/height**。重置尺寸会清空画布，滚回来就得
   * 重新画一帧——那一帧正是肉眼看到的「闪」。像素由条目自己保留，
   * 同时 editor 的 thumbShots LRU 也持有副本（池被淘汰后仍有兜底）。
   */
  private recycleThumbItem(index: number, item: HTMLElement): void {
    // 中防御：正常拖拽期间 buildPageWindow 已被守卫冻结，不会走到回收；
    // 万一命中（侧栏重建 / 宿主清空 DOM），安全取消拖拽并照常回收，绝不搬走
    // 还在被拖的节点。
    if (this.thumbDragItem === item) this.cancelThumbDrag();
    this.thumbObserver?.unobserve(item);
    if (this.thumbPressItem === item) this.cancelThumbPress();
    if (this.thumbMenuOwner === item) this.closeThumbMenu();
    item.remove();
    this.thumbCanvases.delete(index);
    this.thumbItems.delete(index);
    if (this.activeThumbEl === item) this.activeThumbEl = null;
    this.thumbItemPool.delete(index);
    this.thumbItemPool.set(index, item);
    // 池满：淘汰最早回收的（Map 保持插入顺序）
    while (this.thumbItemPool.size > PAGE_THUMB_POOL_MAX) {
      const oldest = this.thumbItemPool.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.thumbItemPool.delete(oldest);
    }
  }

  /** 条目是否需要懒渲染（新建成 / 从池里取回时都要重新观察） */
  private watchThumbItem(item: HTMLElement): void {
    if (item.classList.contains("mb-thumb-add")) return;
    const idx = Number(item.dataset.page);
    if (!Number.isFinite(idx)) return;
    if (typeof IntersectionObserver === "undefined") {
      // 兜底：没有 IO 就立刻画这一张（窗口本来就只有可视区附近几十条）
      const cv = this.thumbCanvases.get(idx);
      if (cv) this.editor?.renderThumbnail(cv, idx);
      return;
    }
    this.ensureThumbObserver()?.observe(item);
  }

  /** 把某一页的收藏态刷到缩略图上的小星标（实心 = 已收藏） */
  private applyThumbFavMark(item: HTMLElement, index: number): void {
    const on = this.store?.data.pages[index]?.favorite === true;
    item.classList.toggle("is-fav", on);
    const btn = item.querySelector(".mb-thumb-fav") as HTMLButtonElement | null;
    if (!btn) return;
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-pressed", String(on));
    const label = on ? "取消收藏本页" : "收藏本页";
    btn.setAttribute("aria-label", label);
    btn.title = label;
  }

  private createThumbItem(index: number, active: boolean): HTMLElement {
    const item = document.createElement("div");
    item.className = "mb-thumb" + (active ? " is-active" : "");
    item.dataset.page = String(index);
    /*
     * 页 id 一起写进 dataset：条目会在回收池里进出，页数/页序变化时整窗重置，
     * 长按菜单的动作必须按 id 回查当前下标，闭包里的 index 可能过期。
     */
    item.dataset.pageId = this.store?.data.pages[index]?.id ?? "";
    item.title = "长按：上移 / 下移 / 复制 / 收藏 / 删除";
    const cv = document.createElement("canvas");
    cv.className = "mb-thumb-canvas";
    item.appendChild(cv);
    item.createDiv({ cls: "mb-thumb-num", text: String(index + 1) });
    /*
     * 收藏按钮：用户要求和「复制 / 删除」并排放在缩略图最上方。
     * 桌面端悬停才出现（与另两枚一致），平板统一收进长按菜单。
     */
    const fav = item.createEl("button", {
      cls: "mb-thumb-act mb-thumb-fav",
      attr: { type: "button", "aria-label": "收藏本页" },
    });
    setIcon(fav, "star");
    fav.onclick = (e) => {
      e.stopPropagation();
      this.setPageFavorite(index, this.store?.data.pages[index]?.favorite !== true);
    };
    this.applyThumbFavMark(item, index);
    const dup = item.createEl("button", { cls: "mb-thumb-act mb-thumb-dup", attr: { "aria-label": "复制本页" } });
    setIcon(dup, "copy");
    dup.onclick = (e) => {
      e.stopPropagation();
      this.editor?.duplicatePage(index);
    };
    if ((this.store?.pageCount ?? 0) > 1) {
      const del = item.createEl("button", {
        cls: "mb-thumb-act mb-thumb-del",
        attr: { "aria-label": "删除本页" },
      });
      setIcon(del, "trash-2");
      del.onclick = (e) => {
        e.stopPropagation();
        const pageId = item.dataset.pageId;
        new DeletePageModal(this.app, index + 1, () => {
          // 确认期间页序可能已经变化：按页 id 找回原页，绝不误删新的同序号页。
          const at = this.store?.data.pages.findIndex((page) => page.id === pageId) ?? -1;
          if (at >= 0) this.editor?.deletePage(at);
        }).open();
      };
    }
    // 长按：不动弹「上移/下移」菜单，移动即承接到拖拽重排（见 onThumbPressMove）
    item.addEventListener("pointerdown", (e) => this.onThumbPointerDown(e, item));
    /*
     * pointerleave **故意什么都不做**。
     *
     * 以前这里调 cancelThumbPress()：鼠标按住第 1 页想拖到第 2 页时，
     * 指针一离开第 1 页的边界就收到 leave，长按态被整个收掉——
     * 而 pointermove 只投递给命中目标，离开后 move 也不再回到这条元素上，
     * 于是菜单虽已弹出，拖拽却再也接不上（用户要的就是这个动作）。
     *
     * 现在移动判据统一在 document 级（armThumbPressMove）：
     * 移够了 8px → 菜单开着就转拖拽、没开就当滚动取消。
     */
    // 触屏长按会触发系统菜单，盖掉；桌面右键保持原样
    item.addEventListener("contextmenu", (e) => {
      if (this.thumbMenuEl) e.preventDefault();
    });
    item.onclick = () => {
      /*
       * 只挡「刚被拖的那一页」的抬手 click，别的条目照常翻页。
       * 按页 id 命中：条目会在回收池里进出、页序刚变过，闭包里的 index
       * 可能已经过期，只有 id 是稳的。
       */
      if (this.thumbDragClickGuard && item.dataset.pageId === this.thumbDragClickGuardId) {
        this.thumbDragClickGuard = false;
        this.thumbDragClickGuardId = "";
        return;
      }
      // 不是被拖的那一条：把过期的守卫清掉，别留着挡住下一次正常点击
      if (this.thumbDragClickGuard) {
        this.thumbDragClickGuard = false;
        this.thumbDragClickGuardId = "";
      }
      const at = Number(item.dataset.longPressAt || 0);
      if (at && Date.now() - at < 1200) {
        // 这次 click 是长按抬手带出来的，不能当成"翻到这一页"
        delete item.dataset.longPressAt;
        return;
      }
      if (this.thumbMenuEl) {
        this.closeThumbMenu();
        return;
      }
      this.editor?.goToPage(index);
    };
    this.thumbCanvases.set(index, cv);
    return item;
  }

  /* --------------------------- 页序长按菜单 --------------------------- */

  private onThumbPointerDown(e: PointerEvent, item: HTMLElement): void {
    if (e.button !== 0) return;
    // 拖拽中再来的第二指不参与，免得破坏当前拖拽
    if (this.thumbDragActive) return;
    // 点在复制/删除按钮上不参与长按
    if ((e.target as Element | null)?.closest?.(".mb-thumb-act")) return;
    // 解除上一次拖拽留下的 click 屏蔽
    this.thumbDragClickGuard = false;
    this.thumbDragClickGuardId = "";
    this.cancelThumbPress();
    this.armThumbTouchGuard();
    this.thumbPressItem = item;
    this.thumbPressId = e.pointerId;
    this.thumbPressX = e.clientX;
    this.thumbPressY = e.clientY;
    this.thumbPressDown = true;
    /*
     * document 级 pointermove：按住之后**离开**那条条目，move 就不会再回到它身上
     * （鼠标的 pointermove 只投递给命中目标；手指抬起前也不再有 pointerleave）。
     * 不挂这个监听，「按住第 1 页 → 移到第 2 页」这条路径根本收不到移动，
     * 菜单弹出后就再也接不上拖拽——用户要的就是这个动作。
     *
     * 菜单弹出前它兼做「滚动判定」（移动超 8px = 用户在滚侧栏，取消长按）；
     * 菜单弹出后它把移动转交给拖拽（见 onThumbPressMove）。
     */
    this.armThumbPressMove();
    this.thumbPressTimer = window.setTimeout(() => {
      this.thumbPressTimer = 0;
      const it = this.thumbPressItem;
      /*
       * **故意不清 thumbPressItem**：菜单开后手指还按着，移动超阈值要顺
       * 利承接到拖拽（beginThumbDrag 靠它取源条目）。它只在 pointerup /
       * 取消 / 窗口重建时由 cancelThumbPress 收掉。
       */
      // 条目可能已经被滚动重建掉；菜单已开时也不再叠加
      if (!it || !it.isConnected || this.thumbMenuEl) return;
      it.dataset.longPressAt = String(Date.now());
      this.openThumbMenu(it);
    }, 450);
  }

  /** 长按期间挂在 document 上的 pointermove（菜单弹前判滚动，弹后转拖拽） */
  private armThumbPressMove(): void {
    this.thumbPressMoveAbort?.abort();
    const ac = new AbortController();
    this.thumbPressMoveAbort = ac;
    document.addEventListener(
      "pointermove",
      (e: PointerEvent) => this.onThumbPressMove(e),
      { passive: true, signal: ac.signal }
    );
    /*
     * 抬手 / 取消也挂 document：指针**离开**条目后在别处抬手，条目上的
     * pointerup 收不到，长按态就会漏在「按着」上（下次按下时状态错乱、
     * touch guard 也一直挂着）。这里兜住。
     */
    document.addEventListener(
      "pointerup",
      (e: PointerEvent) => {
        if (e.pointerId !== this.thumbPressId) return;
        // 拖拽已经接手时，抬手由拖拽自己的监听处理（finishThumbDrag）
        if (this.thumbDragActive) return;
        this.disarmThumbTouchGuard();
        this.cancelThumbPress();
      },
      { signal: ac.signal }
    );
    document.addEventListener(
      "pointercancel",
      (e: PointerEvent) => {
        if (e.pointerId !== this.thumbPressId) return;
        if (this.thumbDragActive) return;
        this.disarmThumbTouchGuard();
        this.cancelThumbPress();
      },
      { signal: ac.signal }
    );
  }

  /**
   * 长按移动判据（挂在 document 上）。
   *
   * 必须挂 document：指针**离开**按下的那条条目后，pointermove 不再投递给它
   * （鼠标的 move 只给命中目标），只有 document 级监听才收得到——
   * 而「按住第 1 页 → 拖到第 2 页」正是要离开第 1 页的。
   *
   * 两条分支：
   *   · 菜单已开 → 移动超 8px = 用户要拖，接手成拖拽；
   *   · 菜单还没开（还在 450ms 计时）→ 移动超 8px = 用户在滚侧栏，取消长按。
   */
  private onThumbPressMove(e: PointerEvent): void {
    if (this.thumbDragActive) return; // 拖拽中由 document 级监听接管
    if (e.pointerId !== this.thumbPressId) return;
    const moved =
      Math.abs(e.clientX - this.thumbPressX) > 8 ||
      Math.abs(e.clientY - this.thumbPressY) > 8;
    if (!moved) return;
    // 菜单已开、手指仍按着：移动超阈值 → 关菜单、进拖拽
    if (this.thumbMenuEl && this.thumbPressDown) {
      this.beginThumbDrag();
      return;
    }
    // 菜单尚未开（长按计时中）：移动超阈值视为侧栏滚动，取消
    if (this.thumbPressTimer) this.cancelThumbPress();
  }

  private cancelThumbPress(): void {
    if (this.thumbPressTimer) {
      window.clearTimeout(this.thumbPressTimer);
      this.thumbPressTimer = 0;
    }
    // 长按期的 document 监听：拖拽接手后由 drag 自己挂 document 监听，这里必须收掉
    if (!this.thumbDragActive) {
      this.thumbPressMoveAbort?.abort();
      this.thumbPressMoveAbort = null;
    }
    this.thumbPressItem = null;
    this.thumbPressDown = false;
    // 拖拽中不动 touchmove 兜底；松手/取消时收掉
    if (!this.thumbDragActive) this.disarmThumbTouchGuard();
  }

  private openThumbMenu(item: HTMLElement): void {
    this.closeThumbMenu();
    const at = this.pageIndexOfThumb(item);
    const n = this.store?.pageCount ?? 0;
    if (at < 0 || n <= 0) return;
    const menu = item.createDiv("mb-thumb-menu");
    const up = menu.createEl("button", { cls: "mb-thumb-menu-btn", text: "上移" });
    up.disabled = at <= 0;
    up.onclick = (e) => {
      e.stopPropagation();
      this.movePageBy(item, -1);
    };
    const down = menu.createEl("button", { cls: "mb-thumb-menu-btn", text: "下移" });
    down.disabled = at >= n - 1;
    down.onclick = (e) => {
      e.stopPropagation();
      this.movePageBy(item, 1);
    };
    /*
     * 复制 / 删除也放进长按菜单（平板不再常显那两枚 30px 大按钮，见 styles.css）。
     * 删除仍走二次确认，按页 id 找回原页，避免确认期间页序变化误删。
     */
    const dup = menu.createEl("button", { cls: "mb-thumb-menu-btn", text: "复制本页" });
    dup.onclick = (e) => {
      e.stopPropagation();
      this.closeThumbMenu();
      this.editor?.duplicatePage(at);
    };
    const del = menu.createEl("button", { cls: "mb-thumb-menu-btn", text: "删除本页" });
    del.disabled = n <= 1;
    del.onclick = (e) => {
      e.stopPropagation();
      const pageId = item.dataset.pageId || this.store?.data.pages[at]?.id || "";
      this.closeThumbMenu();
      if (!pageId) return;
      new DeletePageModal(this.app, at + 1, () => {
        const idx = this.store?.data.pages.findIndex((p) => p.id === pageId) ?? -1;
        if (idx >= 0) this.editor?.deletePage(idx);
      }).open();
    };
    // 收藏也从长按菜单进：不会在缩略图中间再加一颗挡跳页的常显按钮
    const favOn = this.store?.data.pages[at]?.favorite === true;
    const fav = menu.createEl("button", {
      cls: "mb-thumb-menu-btn",
      text: favOn ? "取消收藏" : "收藏本页",
    });
    fav.onclick = (e) => {
      e.stopPropagation();
      this.closeThumbMenu();
      this.setPageFavorite(at, !favOn);
    };
    this.thumbMenuEl = menu;
    this.thumbMenuOwner = item;
    item.classList.add("is-menu");
    // 点菜单外面关掉（捕获阶段，先于任何翻页/按钮逻辑）
    const ac = new AbortController();
    this.thumbMenuAbort = ac;
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!item.contains(e.target as Node)) this.closeThumbMenu();
      },
      { capture: true, signal: ac.signal }
    );
  }

  private closeThumbMenu(): void {
    this.thumbMenuAbort?.abort();
    this.thumbMenuAbort = null;
    this.thumbMenuOwner?.classList.remove("is-menu");
    this.thumbMenuOwner = null;
    this.thumbMenuEl?.remove();
    this.thumbMenuEl = null;
  }

  /**
   * 条目 → **当前**页下标。
   *
   * 以 dataset.pageId 回查为准（重排/重建后下标会变），dataset.page 只做兜底。
   * 绝不能用创建闭包时捕获的旧 index——审查时明确指出的坑。
   */
  private pageIndexOfThumb(item: HTMLElement): number {
    if (!this.store) return -1;
    const id = item.dataset.pageId;
    if (id) {
      const at = this.store.data.pages.findIndex((p) => p.id === id);
      if (at >= 0) return at;
    }
    const at = Number(item.dataset.page);
    return Number.isFinite(at) && at >= 0 && at < this.store.pageCount ? at : -1;
  }

  private movePageBy(item: HTMLElement, delta: number): void {
    const at = this.pageIndexOfThumb(item);
    const n = this.store?.pageCount ?? 0;
    const to = at + delta;
    this.closeThumbMenu();
    if (at < 0 || to < 0 || to >= n) return;
    /*
     * editor.movePage 里 renderPages → emitState → updateUI 会检测到
     * pageOrderRev 变化并同步重建侧栏，这里不用再调 renderPageList
     * （否则同一帧建两遍窗口、缩略图白画一次）。
     */
    this.editor?.movePage(at, to);
  }

  /* ------------------------- 缩略图拖拽重排 ------------------------- */

  /** 长按菜单已开、又移动超阈值 → 从「菜单」切到「拖拽」 */
  private beginThumbDrag(): void {
    const item = this.thumbPressItem;
    if (!item || !item.isConnected) {
      this.cancelThumbPress();
      return;
    }
    const from = this.pageIndexOfThumb(item);
    if (from < 0) {
      this.cancelThumbPress();
      return;
    }
    // 菜单 → 拖拽交接：关菜单、撤掉 capture 监听、press 字段让位给 drag
    this.closeThumbMenu();
    // 长按期的 document 监听交棒给拖拽自己的那份，先收掉（否则两套判据同时跑）
    this.thumbPressMoveAbort?.abort();
    this.thumbPressMoveAbort = null;
    this.thumbPressItem = null;
    this.thumbPressTimer = 0;
    this.thumbPressDown = false;
    this.thumbDragPointerY = this.thumbPressY;
    this.thumbDragBefore = false;
    this.thumbDragTargetIndex = -1;
    this.thumbDragInsertPos = -1;
    const r = item.getBoundingClientRect();
    this.thumbDragActive = true;
    this.thumbDragItem = item;
    this.thumbDragPointerId = this.thumbPressId;
    this.thumbDragFromIndex = from;
    item.classList.add("mb-thumb-dragging");
    /*
     * 拖拽影像（document.body 独立节点，松手即删）。
     *
     * 这里复制被拖缩略图的**真内容**：以前只做了个带边框的空白框，
     * 用户看到的其实是块空白（"显示的缩略图还是不太直观"）。
     *
     * canvas 的位图**不能靠 cloneNode 带过来**——克隆出来是一块 0×0 的空
     * canvas，必须用 drawImage 把原 canvas 的像素画过去。
     */
    const srcCv = item.querySelector(".mb-thumb-canvas") as HTMLCanvasElement | null;
    /*
     * 缩略图是懒渲染的（进视口才画）：还没画过的那格此刻是块空 canvas，
     * 直接复制过去仍是空白。这里补画一次（editor 侧有 LRU，
     * 画过的话只是一次 blit）。
     */
    if (srcCv && !this.thumbCanvasPainted(srcCv)) {
      this.editor?.renderThumbnail(srcCv, from);
    }
    /*
     * 影像的尺寸取**缩略图本体**（canvas 的 CSS 尺寸），不是条目框：
     * 条目还有 1px 边框，拿条目的尺寸会把画面横向/纵向各撑 2px。
     * 拿不到 canvas 就退回条目尺寸（空白框也比没有强）。
     */
    const cvRect = srcCv ? srcCv.getBoundingClientRect() : null;
    const ghostW = cvRect && cvRect.width > 0 ? cvRect.width : r.width;
    const ghostH = cvRect && cvRect.height > 0 ? cvRect.height : r.height;
    /*
     * 抓取偏移：影像保持在手指相对原缩略图的同一个位置，拖起来不跳。
     *
     * 用 canvas 的 rect（不是条目框的）当基准——影像画的是缩略图**内容**，
     * 条目的 1px 边框不属于内容，拿条目框当基准会差 1px。
     */
    const anchor = cvRect && cvRect.width > 0 ? cvRect : r;
    this.thumbDragGrabDX = this.thumbPressX - anchor.left;
    this.thumbDragGrabDY = this.thumbPressY - anchor.top;
    this.thumbDragGhost = this.makeThumbGhost(ghostW, ghostH, srcCv);
    document.body.appendChild(this.thumbDragGhost);
    this.positionThumbGhost(this.thumbPressX, this.thumbPressY);
    /*
     * 落点指示：紫色竖条。
     *
     * 以前是一条横线，横跨整个页列表宽度——4 列网格里根本看不出
     * 要插到哪一列，横线反而误导。现在改成竖条，画在**插入位置**：
     *   插到目标前面 → 目标缩略图的左边缘；
     *   插到目标后面 → 目标缩略图的右边缘。
     * 横线就此去掉（只留竖条），理由见 updateThumbDragTarget 的注释。
     */
    this.thumbDragIndicator = document.createElement("div");
    this.thumbDragIndicator.className = "mb-thumb-drop-bar";
    document.body.appendChild(this.thumbDragIndicator);
    /*
     * 竖条宽度由 CSS 定（3~4px），定位时要用它把条压在边缘上。
     * 元素刚挂上、还没设高度，此刻量出来的宽度就是 CSS 里那个值。
     */
    this.thumbDropBarW = this.thumbDragIndicator.getBoundingClientRect().width || 3;
    // document 级监听：手指移到任意条目之外也继续跟
    const ac = new AbortController();
    this.thumbDragDocAbort = ac;
    document.addEventListener(
      "pointermove",
      (e: PointerEvent) => {
        if (e.pointerId !== this.thumbDragPointerId) return;
        this.thumbDragPointerY = e.clientY;
        this.positionThumbGhost(e.clientX, e.clientY);
        /*
         * 顺序要紧：**先**轻推侧栏（边缘自动滚动），**再**算落点。
         *
         * 反过来的话，条目被滚动带走之后竖条还停在滚动前的位置，
         * 视觉上「条指着的那一格」和「实际要插进去的那一格」对不上。
         */
        this.maybeAutoScroll(e.clientY);
        this.updateThumbDragTarget(e.clientX, e.clientY);
      },
      { passive: true, signal: ac.signal }
    );
    document.addEventListener(
      "pointerup",
      (e: PointerEvent) => {
        if (e.pointerId !== this.thumbDragPointerId) return;
        this.finishThumbDrag(e.clientX, e.clientY);
      },
      { signal: ac.signal }
    );
    document.addEventListener(
      "pointercancel",
      (e: PointerEvent) => {
        if (e.pointerId !== this.thumbDragPointerId) return;
        this.cancelThumbDrag();
      },
      { signal: ac.signal }
    );
    // 按当前落点初始化指示线
    this.updateThumbDragTarget(this.thumbPressX, this.thumbPressY);
  }

  /**
   * 拖拽影像：被拖缩略图的**真缩略图**（不是空框）。
   *
   * canvas 的位图不会被 cloneNode 复制——克隆出来是块 0×0 的空 canvas，
   * 必须用 drawImage 把原 canvas 的像素画到新 canvas 上。
   *
   * 尺寸：w/h 是**缩略图本体**（canvas 的 CSS 尺寸）。缩略图是 aspect-ratio
   * 撑的，取 canvas 的 rect 正好是这个比例；条目的 1px 边框不算内容。
   */
  private makeThumbGhost(
    w: number,
    h: number,
    srcCv: HTMLCanvasElement | null
  ): HTMLElement {
    const g = document.createElement("div");
    g.className = "mb-thumb-ghost";
    g.style.width = Math.max(1, Math.round(w)) + "px";
    g.style.height = Math.max(1, Math.round(h)) + "px";
    if (!srcCv) return g;
    const sw = srcCv.width;
    const sh = srcCv.height;
    if (!(sw > 0 && sh > 0)) return g;
    const cv = document.createElement("canvas");
    cv.className = "mb-thumb-ghost-canvas";
    // ghost 的 CSS 尺寸就是 w×h，按 dpr 铺满，免得发虚
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    const ctx = cv.getContext("2d");
    if (!ctx) return g;
    try {
      ctx.drawImage(srcCv, 0, 0, cv.width, cv.height);
    } catch (_) {
      /* 源 canvas 不可用（已回收 / 上下文丢失）：保持空白，不拖垮拖拽 */
      return g;
    }
    g.appendChild(cv);
    return g;
  }

  /**
   * 这块 canvas 画过东西没有（缩略图是懒渲染的，没进视口时是块空布）。
   *
   * 判据用**尺寸**而不是读像素：renderThumbnail 每次都会把 canvas.width/
   * height 设成算好的缩略图尺寸（cssW×dpr × cssH×dpr），没画过的 canvas
   * 保持浏览器默认的 300×150。这个组合（宽=300 且 高=150）不可能是缩略图
   * 尺寸（两者比值恒为 794/1123 ≈ 0.707），所以判定是准的，而且比
   * getImageData 便宜（不用把像素读回 JS）。
   */
  private thumbCanvasPainted(cv: HTMLCanvasElement): boolean {
    const w = cv.width;
    const h = cv.height;
    if (!(w > 0 && h > 0)) return false;
    // 浏览器给 canvas 的默认尺寸 300×150 = 没被 renderThumbnail 碰过
    if (w === 300 && h === 150) return false;
    /*
     * 再兜一道：缩略图铺满 aspect-ratio 的条目，长宽比恒为 794/1123 ≈ 0.707。
     * 比值明显不符的 canvas 也不是缩略图（别把别的东西当成"画过了"）。
     */
    const ratio = w / h;
    if (ratio < 0.6 || ratio > 0.8) return false;
    return true;
  }

  private positionThumbGhost(x: number, y: number): void {
    if (!this.thumbDragGhost) return;
    const dx = x - this.thumbDragGrabDX;
    const dy = y - this.thumbDragGrabDY;
    this.thumbDragGhost.style.transform =
      "translate(" + Math.round(dx) + "px," + Math.round(dy) + "px)";
  }

  /**
   * 落点：当前**可见窗口**条目里，纵向最近一条（跳过被拖的自己）。
   *
   * 用「相对其他条目的上/下半」算插入位置，**不按 clientY/行高硬算**——
   * 窗口化后行高会变、上下还垫了 spacer，硬算必错。
   *
   * movePage(from, to) 的 `to` 是「移动完成后的最终下标」（splice 语义）：
   *   插到目标 t 之前：(t<from ? t : t−1)
   *   插到目标 t 之后：(t<from ? t+1 : t)
   *   验证：第 1 页(from=0)拖到第 2 页(t=1)之后 → to=1；
   *   movePage(0,1) = splice(0,1)+splice(1,0) ⇔ [第二页, 第一页]，正好对上。
   *
   * **横向不做「必须落在条目内」的硬判定**（2026-11-07 修）：
   * 原来的 `if (x < r.left || x > r.right) continue` 会在两个地方丢命中：
   *   · 拖到**列缝**里（4 列网格列间距 7px）—— 缝隙不属于任何条目；
   *   · 拖到列表**最左/最右的外侧**—— 越出所有条目。
   * 表现为竖条突然消失、松手不重排（用户会觉得「拖到一半没反应」）。
   * 现在改成**按列吸附**：先看指针横向离哪一列最近（列区间按条目实际
   * 左右边 + 半缝外扩），再在该列里找纵向最近的一条。
   * 这样拖到缝里会吸到相邻列、拖到外侧会吸到最近的一列，落点不会丢。
   */
  private findThumbDropTarget(x: number, y: number): { index: number; rect: DOMRect } | null {
    const want = this.thumbDragFromIndex;
    if (want < 0) return null;
    /*
     * 分两步：先定「行」，再在该行内定「列」。
     *
     * 为什么不合成一个加权和：行距（~90px）与列距（~7px）差一个量级，
     * 加权和的权重怎么取都会在某个边界上判错。分两步语义清楚：
     *   1. 找纵向中心最近的那一行（dy 最小）；
     *   2. 该行内（dy 落在最小值的容差内）选横向最近的一条。
     * 容差用半行高：同一行的条目 cy 完全相同，dy 也完全相同，容差只是
     * 为了吸收亚像素取整，不会把相邻行吞进来。
     */
    const cands: Array<{ index: number; rect: DOMRect; dy: number; dx: number }> = [];
    for (const [idx, item] of this.thumbItems) {
      if (idx === want) continue; // 跳过被拖的自己
      const r = item.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const cy = (r.top + r.bottom) / 2;
      const dy = Math.abs(y - cy);
      // 横向距离：落在条目内为 0，落在左右外侧（列缝/列表边缘）为实际距离
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      cands.push({ index: idx, rect: r, dy, dx });
    }
    if (!cands.length) return null;

    // ① 纵向最近的一行
    const minDy = Math.min(...cands.map((c) => c.dy));
    const rowH = Math.max(...cands.map((c) => c.rect.height));
    const tol = Math.max(1, rowH / 2);
    // ② 该行内横向最近的一条（列缝里会吸到相邻列，列表外侧会吸到最近列）
    let best: { index: number; rect: DOMRect } | null = null;
    let bestDx = Infinity;
    for (const c of cands) {
      if (c.dy > minDy + tol) continue;
      if (c.dx < bestDx) {
        bestDx = c.dx;
        best = { index: c.index, rect: c.rect };
      }
    }
    return best;
  }

  private updateThumbDragTarget(x: number, y: number): void {
    if (!this.thumbDragIndicator) return;
    const t = this.findThumbDropTarget(x, y);
    if (!t) {
      this.thumbDragIndicator.style.display = "none";
      this.thumbDragInsertPos = -1;
      this.thumbDragBefore = false;
      return;
    }
    const from = this.thumbDragFromIndex;
    const before = y < (t.rect.top + t.rect.bottom) / 2;
    this.thumbDragBefore = before;
    this.thumbDragTargetIndex = t.index;
    this.thumbDragInsertPos = before
      ? t.index < from
        ? t.index
        : t.index - 1
      : t.index < from
        ? t.index + 1
        : t.index;
    /*
     * 指示：**紫色竖条**，画在插入位置。
     *
     *   插到目标前面（before）→ 竖条在目标缩略图的**左边缘**（条身靠在左沿外侧的缝里）；
     *   插到目标后面          → 竖条在目标缩略图的**右边缘**（条身靠在右沿外侧的缝里）。
     *
     * 竖直方向严格覆盖目标缩略图的高度（top→bottom），不高出一截。
     *
     * 条身**放在缝里（贴着边缘的外侧）**而不是压在缩略图上：
     * 压上去会盖住页面内容，看着像"页面被划了一道"，不像"插在这里"。
     * 网格列间距 7px，条宽 3px，正好塞得下。
     *
     * 为什么不留原来那条横线：
     *   横线横跨**整个页列表**的宽度，在 4 列网格里根本看不出要插到哪一列
     *   ——它画的是"某一行之间的缝"，用户真正想知道的是"插到哪一格旁边"。
     *   两条同时显示更乱（一条说行、一条说列），所以横线直接去掉。
     */
    const barW = this.thumbDropBarW > 0 ? this.thumbDropBarW : 3;
    // 插前：条身贴在左沿外侧（右沿 == 目标左沿）
    // 插后：条身贴在右沿外侧（左沿 == 目标右沿）
    const barX = before ? t.rect.left - barW : t.rect.right;
    const barY = t.rect.top;
    const barH = t.rect.height;
    this.thumbDragIndicator.style.display = "";
    this.thumbDragIndicator.style.width = Math.max(1, Math.round(barW)) + "px";
    this.thumbDragIndicator.style.height = Math.max(1, Math.round(barH)) + "px";
    this.thumbDragIndicator.style.transform =
      "translate(" + Math.round(barX) + "px," + Math.round(barY) + "px)";
  }

  /** 落点靠近视口上/下缘时轻推侧栏，把已有条目挪到指下（窗口冻结，不重建） */
  private maybeAutoScroll(clientY: number): void {
    const vp = this.pageListViewportEl;
    if (!vp) return;
    const r = vp.getBoundingClientRect();
    const edge = 56;
    if (clientY < r.top + edge) {
      vp.scrollTop -= Math.round((r.top + edge - clientY) * 0.5);
    } else if (clientY > r.bottom - edge) {
      vp.scrollTop += Math.round((clientY - (r.bottom - edge)) * 0.5);
    }
  }

  private finishThumbDrag(x: number, y: number): void {
    // 以松手落点再算一次最终目标
    this.updateThumbDragTarget(x, y);
    const from = this.thumbDragFromIndex;
    const to = this.thumbDragInsertPos;
    /*
     * 记下「被拖的那一页的 id」再清理——清理会把 fromIndex 复位成 -1。
     * 守卫要按 id 命中，不能用一个全局布尔：拖完的抬手 click 理论上落在
     * 被拖条目上，但触屏 pointerup 的落点可能偏到相邻条目（手指抖动），
     * 那种情况下全局布尔会把**别的**条目的正常点击也吞掉一次
     * （用户点了没反应，还白吃掉标志）。
     */
    const draggedId = this.store?.data.pages[from]?.id ?? "";
    this.cleanupThumbDrag();
    if (from < 0 || to < 0) return;
    /*
     * movePage → emitState → updateUI → refreshThumbs 检测到 pageOrderRev
     * 变化会重建侧栏窗口（含被拖条目）。清理必须先于这次重建，
     * 否则 is-dragging / ghost / 指示线会残留在即将被空的旧文档里。
     */
    this.editor?.movePage(from, to);
    // 拖完自带的抬手 click：只挡「被拖的那一页」，别的条目的点击照常翻页
    this.thumbDragClickGuard = true;
    this.thumbDragClickGuardId = draggedId;
  }

  private cancelThumbDrag(): void {
    this.cleanupThumbDrag();
  }

  private cleanupThumbDrag(): void {
    this.thumbDragDocAbort?.abort();
    this.thumbDragDocAbort = null;
    // 长按期的 document 监听（拖拽中途被取消时可能还挂着）
    this.thumbPressMoveAbort?.abort();
    this.thumbPressMoveAbort = null;
    this.thumbDragGhost?.remove();
    this.thumbDragGhost = null;
    this.thumbDragIndicator?.remove();
    this.thumbDragIndicator = null;
    this.thumbDragItem?.classList.remove("mb-thumb-dragging");
    this.thumbDragItem = null;
    this.thumbDragActive = false;
    this.thumbDragPointerId = -1;
    this.thumbDragFromIndex = -1;
    this.thumbDragTargetIndex = -1;
    this.thumbDragInsertPos = -1;
    this.thumbDragBefore = false;
    this.thumbPressDown = false;
    this.thumbPressItem = null;
    this.disarmThumbTouchGuard();
  }

  /**
   * 装一个 document 级非-passive touchmove 监听：仅在拖拽态吞掉默认滚动，
   * 让浏览器不把这次移动判成侧栏滚动（否则 pointcancel 掐掉拖拽）。
   */
  private armThumbTouchGuard(): void {
    if (this.thumbTouchGuardAbort) return;
    const ac = new AbortController();
    this.thumbTouchGuardAbort = ac;
    document.addEventListener(
      "touchmove",
      (e: TouchEvent) => {
        if (this.thumbDragActive) e.preventDefault();
      },
      { passive: false, signal: ac.signal }
    );
  }

  private disarmThumbTouchGuard(): void {
    this.thumbTouchGuardAbort?.abort();
    this.thumbTouchGuardAbort = null;
  }

  private createAddThumb(): HTMLElement {
    const add = document.createElement("div");
    add.className = "mb-thumb mb-thumb-add";
    add.createDiv({ cls: "mb-thumb-plus", text: "+" });
    add.createDiv({ cls: "mb-thumb-add-label", text: "加一页" });
    add.onclick = () => this.editor?.addPage();
    return add;
  }

  /**
   * 只切换新旧两个缩略图的选中态（不扫全列表）。
   *
   * 窗口化后当前页可能不在窗口里（用户把侧栏滚到了别的页段）：
   * 这时 next 为 null，只是清掉旧高亮，**绝不滚动侧栏**；
   * 等条目被物化时 createThumbItem 会按 activeThumbPage() 补上 is-active。
   */
  private setActiveThumb(index: number): void {
    const next = (this.thumbCanvases.get(index)?.parentElement as HTMLElement | undefined) ?? null;
    if (next === this.activeThumbEl) return;
    this.activeThumbEl?.classList.remove("is-active");
    next?.classList.add("is-active");
    this.activeThumbEl = next;
  }

  /**
   * 展开抽屉 / 切回缩略图标签时，**同步**把页列表定位到当前页并就地建窗口。
   *
   * 旧做法是在当前 scrollTop（往往 0）上先 build 出第 1 页，再只改 scrollTop，
   * 靠随后的 scroll 事件在**下一帧**才重建窗口。于是用户先看到第 1 页 / 一段
   * 空白，然后才跳到当前页，大本子上这一下一跳很显眼、也白建了一屏。
   *
   * `revealThumbForPage` 会先把 scrollTop 落到当前页、再**同一帧内**重建窗口，
   * 这样从第一帧起就是当前页那一屏，没有中间态。
   */
  private syncThumbsToActivePage(): void {
    if (!this.store) return;
    const cur = this.activeThumbPage();
    this.revealThumbForPage(cur);
    // reveal 在「当前页已在可视区」时会早退，这里补画一次附近的缩略图并同步选中态
    this.drawThumbRange(cur, 2);
    this.setActiveThumb(cur);
    this.syncThumbScrollbar();
  }

  /**
   * 给缩略图面板右缘挂一条自绘滑动条（和纸面 `.mb-sb` 同款）。
   *
   * 系统滚动条在平板上拖不动，几百页的缩略图想从第 3 页跳到第 30 页只能
   * 一页页滑；这里加一枚可拖动的小滑块，交互原则和笔记纸面那条一致。
   * 滑块挂在 `.mb-side-panes` 上（不是滚动容器内），所以不会跟着内容滚走。
   */
  private buildThumbScrollbar(scroller: HTMLElement, host: HTMLElement): void {
    this.thumbSbAbort?.abort();
    window.clearTimeout(this.thumbSbHideTimer);
    this.thumbSbHideTimer = 0;
    const ac = new AbortController();
    this.thumbSbAbort = ac;

    const el = host.createDiv("mb-sb mb-pane-sb");
    this.thumbSbEl = el;
    const track = el.createDiv("mb-sb-track");
    this.thumbSbTrack = track;
    const thumb = track.createDiv("mb-sb-thumb");
    this.thumbSbThumb = thumb;

    // 缩略图面板不涉及在纸面落笔，滑动条常驻可见即可（不必像纸面那样淡出）
    el.addClass("is-visible");

    scroller.addEventListener("scroll", () => this.syncThumbScrollbar(), {
      passive: true,
      signal: ac.signal,
    });

    const apply = (clientY: number, grab: number) => {
      const range = scroller.scrollHeight - scroller.clientHeight;
      const usable = Math.max(1, track.clientHeight - this.thumbSbThumbH);
      const y = clientY - track.getBoundingClientRect().top - grab;
      const r = Math.min(1, Math.max(0, y / usable));
      scroller.scrollTop = r * range;
    };

    thumb.addEventListener(
      "pointerdown",
      (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const tr = thumb.getBoundingClientRect();
        const grab = e.clientY - tr.top;
        this.thumbSbDrag = { pid: e.pointerId, grab };
        el.addClass("is-drag");
        el.addClass("is-visible");
        window.clearTimeout(this.thumbSbHideTimer);
        this.thumbSbHideTimer = 0;
        try {
          thumb.setPointerCapture(e.pointerId);
        } catch (_) {}
        e.preventDefault();
        e.stopPropagation();
        apply(e.clientY, grab);
      },
      { signal: ac.signal }
    );

    thumb.addEventListener(
      "pointermove",
      (e) => {
        const d = this.thumbSbDrag;
        if (!d || e.pointerId !== d.pid) return;
        apply(e.clientY, d.grab);
        e.preventDefault();
      },
      { signal: ac.signal }
    );

    const finish = (e: PointerEvent) => {
      const d = this.thumbSbDrag;
      if (!d || e.pointerId !== d.pid) return;
      this.thumbSbDrag = null;
      el.removeClass("is-drag");
      try {
        thumb.releasePointerCapture(e.pointerId);
      } catch (_) {}
      this.syncThumbScrollbar();
    };
    thumb.addEventListener("pointerup", finish, { signal: ac.signal });
    thumb.addEventListener("pointercancel", finish, { signal: ac.signal });

    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => this.syncThumbScrollbar());
      ro.observe(scroller);
      ac.signal.addEventListener("abort", () => ro.disconnect());
    }
  }

  /** 按缩略图滚动容器的滚动位置/比例刷新滑块高度与位置；不需要时隐藏 */
  private syncThumbScrollbar(): void {
    const el = this.thumbSbEl;
    const track = this.thumbSbTrack;
    const thumb = this.thumbSbThumb;
    const sc = this.sideThumbPane;
    if (!el || !track || !thumb || !sc) return;
    if (sc.clientHeight <= 0) {
      el.style.display = "none";
      return;
    }
    const scrollH = sc.scrollHeight;
    const range = scrollH - sc.clientHeight;
    if (range <= 2) {
      el.style.display = "none";
      return;
    }
    el.style.display = "";
    const trackH = track.clientHeight || el.clientHeight;
    if (trackH <= 0) return;
    /*
     * 缩略图抽屉的滑块刻意做得短：它常驻可见，太长会盖住缩略图/目录内容。
     * 轨道本身也只占面板中段（见 .mb-pane-sb），这里再给比例高度封顶，
     * 页数少时不会长成一条几乎贯穿面板的黑条。拖动范围用的 thumbSbThumbH
     * 与这里必须同步更新。
     */
    const minTh = this.tabletMode ? 28 : 22;
    const maxTh = this.tabletMode ? 56 : 64;
    const th = Math.min(
      maxTh,
      Math.max(minTh, Math.round(trackH * (sc.clientHeight / Math.max(1, scrollH))))
    );
    this.thumbSbThumbH = th;
    thumb.style.height = th + "px";
    const maxTop = Math.max(0, trackH - th);
    const r = Math.min(1, Math.max(0, sc.scrollTop / range));
    thumb.style.transform = `translateY(${Math.round(maxTop * r)}px)`;
  }

  /**
   * 懒加载观察器：缩略图进入视口（±300px）才画。
   *
   * root 必须是真正的滚动容器 `.mb-side-body`。以前用 `.mb-sec`（页列表的
   * 父节点）当 root，所有条目都在它里面，等于全部「相交」——几百页时会
   * 一次画满整个列表。
   *
   * 观察器**跨窗口更新复用**：滚动跨行时只 observe 新进入的条目、
   * unobserve 被回收的条目，不用整表断开重连。
   */
  private ensureThumbObserver(): IntersectionObserver | null {
    if (typeof IntersectionObserver === "undefined") return null;
    if (this.thumbObserver) return this.thumbObserver;
    const list = this.pageListEl;
    if (!list) return null;
    this.thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          const idx = Number(el.dataset.page);
          if (!Number.isFinite(idx)) continue;
          /*
           * 条目可能已经被回收 / 换成了别的页（滚动很快时 IO 回调会迟到）：
           * 只画「还在文档里、且映射对得上」的那张 canvas。
           */
          const cv = this.thumbCanvases.get(idx);
          if (cv && cv.isConnected && el.isConnected && el.dataset.page === String(idx)) {
            this.editor?.renderThumbnail(cv, idx);
          }
        }
      },
      {
        root: this.pageListViewportEl ?? list.parentElement ?? null,
        rootMargin: "300px 0px",
      }
    );
    return this.thumbObserver;
  }

  /** 画一段范围内的缩略图（当前页附近；窗口里没有的页等滚进来再画） */
  private drawThumbRange(center: number, span: number): void {
    if (!this.store) return;
    const lo = Math.max(0, center - span);
    const hi = Math.min(this.store.pageCount - 1, center + span);
    for (let i = lo; i <= hi; i++) {
      const cv = this.thumbCanvases.get(i);
      if (cv && cv.isConnected) this.editor?.renderThumbnail(cv, i);
    }
  }

  /**
   * 兜底补画：抽屉刚展开 / 从「目录」切回「缩略图」时，IntersectionObserver
   * 偶尔漏掉回调，个别已经物化的缩略图会一直空白（真机反馈「打开缩略图后
   * 有的页加载不出来」）。这里扫一遍窗口里连着的 canvas，凡没画过、又量得到
   * 尺寸的都补画一次；已经画过的直接跳过，不重复光栅化。
   */
  private sweepUnpaintedThumbs(): void {
    if (!this.editor || !this.store || !this.thumbVisible()) return;
    for (const [idx, cv] of this.thumbCanvases) {
      if (!cv.isConnected || this.thumbCanvasPainted(cv)) continue;
      const r = cv.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      this.editor.renderThumbnail(cv, idx);
    }
  }

  /**
   * 页列表滚动 / 侧栏尺寸变化 → 下一帧重算窗口。
   *
   * 不直接同步跑：一次滚动会连发几十个 scroll，按帧合并后最多每跨一行更新一次。
   */
  private schedulePageWindowUpdate(): void {
    // 拖拽中：冻结窗口更新（见 buildPageWindow 守卫），也不排下一帧
    if (this.thumbDragActive) return;
    if (this.pageListRaf) return;
    const run = () => {
      this.pageListRaf = 0;
      this.updatePageWindow(false);
    };
    if (typeof window.requestAnimationFrame === "function") {
      this.pageListRaf = window.requestAnimationFrame(run);
    } else {
      this.pageListRaf = window.setTimeout(run, 16);
    }
  }

  private cancelPageListRaf(): void {
    if (!this.pageListRaf) return;
    if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(this.pageListRaf);
    else window.clearTimeout(this.pageListRaf);
    this.pageListRaf = 0;
  }

  /** 把页列表接到侧栏滚动容器上（重建侧栏时换新，旧的走 abort） */
  /**
   * 把「页列表滚动 → 重算窗口」的监听挂到**真正的滚动容器**上。
   *
   * 缩略图搬到左侧抽屉后，滚动的是 `.mb-pages` 自己（它带 overflow-y:auto），
   * 不再是整个侧栏 body —— 抽屉里还有标签栏和目录面板，滚整个 body 会
   * 把标签一起滚走。传 null 表示「还没建，稍后再挂」。
   */
  private attachPageListScroll(scroller: HTMLElement | null): void {
    this.pageListAbort?.abort();
    this.pageListResizeObs?.disconnect();
    if (!scroller) {
      this.pageListViewportEl = null;
      return;
    }
    const ac = new AbortController();
    this.pageListAbort = ac;
    this.pageListViewportEl = scroller;
    scroller.addEventListener("scroll", () => this.schedulePageWindowUpdate(), {
      passive: true,
      signal: ac.signal,
    });
    /*
     * 抽屉宽度 / 高度变化时，网格列宽和行高都变，可视几行也变，
     * 只能重算窗口。只观察滚动容器本身：观察列表会被我们自己的
     * spacer 改高反馈成循环。
     */
    if (typeof ResizeObserver !== "undefined") {
      this.pageListResizeObs = new ResizeObserver(() => this.schedulePageWindowUpdate());
      this.pageListResizeObs.observe(scroller);
    }
  }

  private refreshThumbs(): void {
    if (!this.editor || !this.store) return;
    this.renderStats();
    /*
     * 目录区跟着刷。
     *
     * 放在 `thumbVisible()` 早退**之前**：侧栏收起时目录 DOM 还在
     * （只是看不见），内容也得是最新的——否则收起状态下加了目录、
     * 再展开时看到的还是旧的。
     */
    this.renderOutlines();
    /*
     * 侧栏收起 / 显示目录标签：页列表和缩略图都看不见，什么活都不用干。
     * 这条也覆盖了「写字时 markDirty → thumbDebounce → refreshThumbs」——
     * 侧栏没开时不会在每次停顿后去重画 5 张缩略图（PDF 页很贵）。
     */
    if (!this.thumbVisible()) return;
    // 页数变了要建新条目；页数没变但换序了（上移/下移、撤销换序）也要重建
    if (
      this.pageCountSig !== this.store.pageCount ||
      this.pageOrderRev !== this.store.pageOrderRev
    ) {
      this.renderPageList();
      return;
    }
    // 只重画当前页附近的缩略图——其余等滚进视口时再画
    const current = this.activeThumbPage();
    this.drawThumbRange(current, 2);
    this.setActiveThumb(current);
    // 收藏面板同页的缩略图也跟着内容更新（只有几张，不进窗口化）
    if (this.favoritesVisible()) this.scheduleFavoritePaint();
  }

  private renderStats(): void {
    if (!this.statsEl || !this.store) return;
    this.statsEl.setText(
      `${this.store.pageCount} 页 · ${this.store.strokeCount} 条笔迹 · ${this.store.page.layers.length} 图层`
    );
  }

  /* ------------------------------- 状态同步 ------------------------------- */

  /**
   * 同步侧栏「钢笔 / 荧光」粗细按钮的选中态。
   *
   * 粗细按钮是 buildSide 里一次性建的静态 DOM，不会随 updateUI 重建，
   * 所以选中态必须单独刷（颜色点同理，但它们在 buildSide 时算过）。
   * 没有这个的话：选了「粗」侧栏上还是三个一样的按钮，写字时不知道笔有多粗。
   */
  private syncPenSizeButtons(): void {
    const rows = this.sideEl?.querySelectorAll(".mb-size-row");
    if (!rows || rows.length < 2) return;
    const pen = this.editor?.penSize ?? 0;
    const hl = this.editor?.highlighterSize ?? 0;
    const mark = (row: Element, value: number, sizes: number[]) => {
      // NodeList 没有迭代器（target/lib 限制），用 Array.from 取
      for (const b of Array.from(row.querySelectorAll(".mb-size-btn"))) {
        const idx = sizes.indexOf(Number(b.getAttribute("data-size")));
        b.classList.toggle("is-active", idx >= 0 && Math.abs(sizes[idx] - value) < 0.01);
      }
    };
    mark(rows[0], pen, PEN_SIZES);
    mark(rows[1], hl, HIGHLIGHTER_SIZES);
  }

  private updateUI(): void {
    if (!this.editor) return;
    const s = this.editor.getState();

    for (const [id, btn] of this.toolButtons) btn.toggleClass("is-active", id === s.tool);
    // 工具切换时把紫色高亮片滑到新工具；同一工具不重复量（落笔时高频跑这里）
    if (this.toolPill && s.tool !== this.slideToolSig) {
      this.slideToolSig = s.tool;
      this.toolPill.layout();
    }

    /*
     * 快捷笔盒跟着工具 / 参数走：
     *   · 用键盘切到没有笔参数的工具（P→T 等）时，浮层没有意义了，收起；
     *   · 还在这支笔上就只同步选中态，不重建 DOM（连续落笔会高频跑这里）。
     */
    if (this.penPopEl) {
      if (PEN_POP_TOOLS.has(s.tool) || s.tool === "shape") this.syncPenPopActive();
      else if (s.tool === "text") this.syncTextPopActive();
      else if (s.tool === "eraser") this.syncEraserPopActive();
      else this.closePenPop();
    }

    this.syncPenSizeButtons();

    if (this.pageLbl) this.pageLbl.setText(`${s.pageIndex + 1} / ${s.pageCount}`);
    if (this.sbTip) this.sbTip.setText(`${s.pageIndex + 1} / ${s.pageCount}`);
    // 页数变了滑条的高度比例也变了；合并到一帧里算，别每笔都量一遍
    this.requestScrollbarSync();
    // 宿主重建标题栏时会把我们那一行一起清掉，发现掉了就重装
    if (this.topRowEl && !this.topRowEl.parentElement) this.buildHeaderActions();
    /*
     * 侧栏被宿主清空（主题重载 / 布局切换）时也要重建（2026-11-07 补）。
     *
     * 老代码只检测 topRowEl，侧栏没有。sideEl 被清空后 `dynEl` /
     * `layerListEl` / `pageListEl` 等引用全部悬空 —— 侧栏永久空白，
     * 而 `renderXxx` 还在往那些已脱离文档的节点里写，用户什么都看不到。
     * 判据用 `sideEl.firstElementChild`：`buildSide` 一定会建出内容。
     */
    if (this.sideEl && !this.sideEl.firstElementChild) {
      this.buildSide();
      this.updatePageWindow(true);
      this.refreshThumbs();
    }
    if (this.zoomLbl) this.zoomLbl.setText(Math.round(s.zoom * 100) + "%");
    if (this.undoBtn) this.undoBtn.toggleClass("is-disabled", !s.canUndo);
    if (this.redoBtn) this.redoBtn.toggleClass("is-disabled", !s.canRedo);
    // 浮标里的两键与侧栏按钮同一套表达：不可用就置灰、不接收点击
    if (this.floatUndoBtn) {
      this.floatUndoBtn.toggleClass("is-disabled", !s.canUndo);
      this.floatUndoBtn.setAttribute("aria-disabled", String(!s.canUndo));
    }
    if (this.floatRedoBtn) {
      this.floatRedoBtn.toggleClass("is-disabled", !s.canRedo);
      this.floatRedoBtn.setAttribute("aria-disabled", String(!s.canRedo));
    }
    if (this.touchBtn) this.touchBtn.toggleClass("is-active", !!this.editor?.touchDraw);
    if (this.sideBtn) this.sideBtn.toggleClass("is-active", this.sideShown);
    // 侧栏「演示」区（激光笔）：工具切换 / 快捷键 / 设置页改动后都要跟上
    this.syncAuxControls();
    if (this.railSideBtn) {
      this.railSideBtn.setAttribute("aria-expanded", String(this.sideShown));
      this.railSideBtn.setAttribute(
        "aria-label",
        this.sideShown ? "收起侧栏" : "展开侧栏"
      );
      this.railSideBtn.title = this.sideShown ? "收起侧栏" : "展开侧栏";
    }

    /*
     * 缩放指示器：只在**真的缩放了**才浮现。
     *
     * 判据是 zoom 值变了——而不是"用户可能想缩放"。
     * 平时右下角干干净净，一缩放就报出确切倍数（150% / 80%），
     * 停止操作后 2.6 秒自己淡回去。
     */
    if (Math.abs(s.zoom - this.lastZoom) > 1e-6) {
      this.lastZoom = s.zoom;
      this.showZoomHint();
    }

    this.renderColors();
    this.renderDynamicTools();

    if (this.layerSig !== this.layerSignature()) this.renderLayers();
    // 笔迹数不进结构签名，每帧就地刷数字（比重建整块 DOM 便宜得多）
    else this.syncLayerCounts();
    /*
     * 目录区：只在内容真的变了才重建（store.outlineRev）。
     * 落笔时 updateUI 会跑几十次，目录不变 → 一次 DOM 都不动。
     */
    this.renderOutlines();
    // 收藏列表与「收藏当前页」按钮：签名没变就一次 DOM 都不动
    this.syncFavoritesUI();
    // 侧栏收起时不建页列表（首次展开由 applySideVisibility → refreshThumbs 补建）
    if (
      this.thumbVisible() &&
      this.store &&
      (this.pageCountSig !== s.pageCount || this.pageOrderRev !== this.store.pageOrderRev)
    ) {
      this.renderPageList();
    }

    if (this.thumbVisible()) this.setActiveThumb(s.pageIndex);

    if (this.store) {
      if (this.templatePaperSig !== this.store.page.paper) this.renderTemplates();
      for (const [id, card] of this.templateCards)
        card.toggleClass("is-active", id === this.store!.page.template);
      for (const [id, chip] of this.paperChips)
        chip.toggleClass("is-active", id === this.store!.page.paper);
      const activeLayer = this.store.page.activeLayerId;
      this.layerListEl?.querySelectorAll(".mb-layer").forEach((el, i) => {
        el.toggleClass("is-active", this.store!.page.layers[i]?.id === activeLayer);
      });
    }

    this.renderStats();
    this.updateStatus();
  }

  private onPageChanged(): void {
    /*
     * 只是翻了一页：笔迹一条没变，变的是 activePage。
     *
     * 以前这里直接 dirty = true + 防抖保存 —— 翻 60 页就是 60 次整本覆盖写，
     * 每次几十 MB 的序列化。现在只记「元数据脏」，真正的写在
     * 关文件 / 切文件时由 flushSave 落一次。
     */
    const page = this.editor
      ? this.editor.getState().pageIndex
      : this.store
      ? this.store.data.activePage
      : -1;
    // 页码和上次写盘时一样 → 这次翻页没产生任何需要落盘的改动
    if (page !== this.savedActivePage) {
      this.metaDirty = true;
      this.metaEpoch += 1;
    }
    // 翻页元数据的脏标记仍同步记，只有重 UI 刷新建到下一帧
    this.scheduleUIUpdate();
    this.thumbDebounce();
  }

  private markDirty(): void {
    this.dirty = true;
    this.dirtyEpoch += 1;
    this.saveState = "dirty";
    /*
     * 又有新内容要存了 → 上一轮「已经抢救过」的记录作废。
     *
     * `rescued` 防的是**同一份**未落盘内容被重复另存（切文件救过之后
     * onClose 又救一次）。但用户接着写，现在脏的是**新内容**，
     * 必须允许再救一次，否则下次切走时这部分就没人管了（INK-174 复查）。
     */
    this.rescued = false;
    this.updateStatus();
    // 只读态（备份恢复 / 打不开）下的改动一律不会落盘，必须当场说清楚，
    // 否则用户会以为写着写着就存上了
    if (this.readOnly) this.warnReadOnly();
    if (this.plugin.settings.autosave) this.saveDebounce();
    this.thumbDebounce();
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    const text =
      this.saveState === "saving" ? "保存中…" : this.saveState === "dirty" ? "未保存" : "已保存";
    this.statusEl.setText(text);
    this.statusEl.toggleClass("is-dirty", this.saveState !== "saved");

    /*
     * 长条上的「立即保存」跟着保存状态走：
     *   · 有未保存改动 → 右上角一个点（不改变按钮尺寸/位置）
     *   · 保存中 → 禁用。否则点下去只会进 saveNow 的 saveAgain 分支，
     *     按钮看起来"没反应"，用户会以为没点上。
     */
    if (this.railSaveBtn) {
      this.railSaveBtn.toggleClass("is-dirty", this.saveState === "dirty");
      this.railSaveBtn.toggleClass("is-saving", this.saveState === "saving");
      // 顶栏按钮是 div（addAction 给的壳），没有 disabled，用 aria + 类名表达
      this.railSaveBtn.setAttr("aria-disabled", this.saveState === "saving" ? "true" : "false");
      this.railSaveBtn.title =
        this.saveState === "saving"
          ? "正在保存…"
          : this.saveState === "dirty"
            ? "有未保存的改动，点击立即保存"
            : "保存（立即写入磁盘）";
    }
  }

  /* ------------------------------- 保存 ------------------------------- */

  /** 编辑器是否有一笔墨压在纸上（见 BookEditor.isInkBusy） */
  private isInkBusy(): boolean {
    return !!this.editor && this.editor.isInkBusy();
  }

  /**
   * 自动保存的唯一入口（850ms 尾沿 / 10s maxWait 到点后走这里）。
   *
   * 是否避让由 saveNow(false) 自己判断——这样所有自动路径都从同一道门过，
   * markDirty() 绝不拦截（它还驱动 thumbDebounce，拦了缩略图会停更）。
   */
  private runAutoSave(): void {
    /*
     * 关掉「自动保存」只挡住了 markDirty 的排程，可已经在飞的定时器
     * （850ms 尾沿 / 10s 上限 / 抬笔补排 / saveNow 的 saveAgain 补排）
     * 到点仍会走这里落盘，用户看到的就是「明明了自动保存还是存了」。
     * 这一道门是所有自动路径的共同出口，挡在这里才不会漏。
     */
    if (!this.plugin.settings.autosave) return;
    void this.saveNow(false);
  }

  /**
   * 一次墨水手势结束（抬笔 / 擦除收手 / 手势被取消）。
   *
   * 自动保存避让期间是不排定时器的，抬手必须把那次「欠着的保存」重新排上。
   * 不能只靠 markDirty：橡皮停住不动再抬手时，最后一次擦除早就入了改脏，
   * 抬手本身不会再触发 onChange——没有这一步，那次保存就永远排不上。
   *
   * 但**不能顺手清掉 10s 硬上限**：连续书写时每笔间隔 < 850ms，
   * 每次抬手都重置上限的话，一笔接一笔写下去就又变回「永远不落盘」
   * （INK-129）。上限的时间戳和兜底定时器要一直留到真正存成功为止。
   */
  private onInkGestureEnd(): void {
    // 关掉自动保存后，抬笔也不能再把自动落盘排回来
    if (this.dirty && this.plugin.settings.autosave) this.saveDebounce();
  }

  /** 硬上限到点后来敲门：不 busy 了就正常存，还 busy 就让 saveNow 强制存 */
  private armInkDeferRetry(delayMs: number): void {
    this.cancelInkDeferRetry();
    // 用户中途关掉自动保存时，10s 硬上限这条兜底也不能再敲门
    if (!this.plugin.settings.autosave) return;
    this.inkDeferRetry = window.setTimeout(() => {
      this.inkDeferRetry = 0;
      if (!this.dirty && !this.metaDirty) return;
      this.runAutoSave();
    }, Math.max(0, delayMs) + 50);
  }

  private cancelInkDeferRetry(): void {
    if (this.inkDeferRetry) window.clearTimeout(this.inkDeferRetry);
    this.inkDeferRetry = 0;
  }

  /**
   * 设置页关掉「自动保存」时调用：把已经排上但还没到点的自动落盘收回。
   *
   * 只清定时器、不动 dirty 状态：用户关掉自动保存不代表这一笔不要了，
   * 显式保存（Ctrl+S / 顶栏按钮 / 切文件时的 flushSave）仍要能写下去。
   */
  cancelPendingSaves(): void {
    this.saveDebounce.cancel();
    this.cancelInkDeferRetry();
    this.inkDeferAt = 0;
  }

  /**
   * 长条「立即保存」按钮的入口。
   *
   * 三种"没写盘"的情况都要给明确反馈，不能静默返回——
   * 用户点了一下按钮什么都没发生，会以为存上了。
   */
  private async requestSave(): Promise<void> {
    if (this.saveState === "saving") return; // 正在写，别再排队
    if (!this.store || !this.file) {
      new Notice("这份笔记还没加载完成，暂时无法保存。", 4000);
      return;
    }
    if (this.readOnly) {
      this.warnReadOnly();
      return;
    }
    if (this.conflict) {
      new Notice(
        "当前处于冲突状态，未写入原文件。请先处理冲突副本，" +
          "然后关掉这个标签页重新打开本子即可恢复保存。",
        10000
      );
      return;
    }
    if (!this.dirty && !this.metaDirty) {
      new Notice("已是最新，无需保存。", 1500);
      return;
    }
    await this.saveNow();
    // saveNow 里冲突/失败都会把状态退回 dirty 并自己弹提示，这里只在真存成时道喜
    if (this.saveState === "saved") new Notice("已保存。", 1500);
  }

  /**
   * 保存后延迟写文字索引。
   *
   * 去抖 1 秒：写字时每 0.85 秒就会保存一次，逐次重写索引会让
   * 同步盘和 Obsidian 的搜索索引一直忙。只在停笔一阵后写一次。
   *
   * 调度时就把 file / book 捕获下来：切文件以后旧定时器回调
   * 也不会把新本子的内容写进旧索引。
   */
  private scheduleTextIndex(): void {
    if (!this.file || !this.store) return;
    if (this.plugin.settings.searchIndex === false) return;
    const file = this.file;
    const book = this.store.data;
    // 有东西等着进索引——哪怕定时器随后被销毁，这条事实也还在
    this.indexPending = { file, book };
    window.clearTimeout(this.indexTimer);
    this.indexTimer = window.setTimeout(() => {
      this.indexTimer = 0;
      void writeTextIndex(this.app, file, book);
    }, 1000);
  }

  /**
   * 把还在去抖里的索引立刻写掉。
   *
   * 平时 1 秒的去抖没问题，但 `flushSave()`（切文件 / 关标签页）之后
   * `destroyEditor()` 会直接 `clearTimeout(this.indexTimer)`——最后 1 秒内
   * 的改动就永远进不了索引。以前「导入 PDF 后马上切走，结果 PDF 原文搜不到」
   * 走的就是这条路。所以在 flushSave 末尾主动冲一次。
   *
   * 判据是 `indexPending` 而不是「定时器非零」：定时器可能已经被销毁了，
   * 但内容确实还没进索引——这种情况同样要写。
   */
  private async flushTextIndex(): Promise<void> {
    if (!this.indexPending) return;
    if (this.plugin.settings.searchIndex === false) return;
    const pending = this.indexPending;
    window.clearTimeout(this.indexTimer);
    this.indexTimer = 0;
    // 先取走：writeTextIndex 失败也不该让「待写」永远挂着，
    // 否则每次保存都要重试一次写失败的索引。
    this.indexPending = null;
    try {
      await writeTextIndex(this.app, pending.file, pending.book);
    } catch (_) {
      // writeTextIndex 自己已经兜底；索引是派生物，绝不能影响保存/导入的结果
    }
  }

  /**
   * 从索引里的链接跳进来：打开到指定页（1 起）。
   *
   * 编辑器可能还没建好（文件刚打开），那时先记下，mountEditor 后消费。
   *
   * `opts.hint` 是落点提示（页面轻亮一下 + 「已跳到第 N 页」）的开关：
   * 缺省跟随设置 `jumpHint`。这里只增加视觉提示，跳转语义不变。
   */
  gotoPageFromLink(page1: number, opts?: { hint?: boolean }): void {
    const idx = Math.max(0, Math.round(Number(page1) || 1) - 1);
    const hint = opts?.hint !== false && this.plugin.settings?.jumpHint !== false;
    if (this.editor) {
      this.editor.goToPage(idx, false);
      this.pendingPage = null;
      this.pendingPageHint = false;
      if (hint) this.editor.locatePage(idx);
      /*
       * **显式跳页**时把侧栏缩略图滚到当前页（2026-11-07 补）。
       *
       * 普通翻页刻意不滚侧栏（会和用户手动浏览缩略图打架，见
       * `setActiveThumb` 的注释）；但「从搜索 / 目录 / 跳页弹窗跳过来」
       * 是用户明确要去那一页 —— 857 页的本子里如果侧栏还停在第 1 页，
       * 用户完全看不出自己在哪，也没法看邻近几页。
       */
      this.revealThumbForPage(idx);
    } else {
      this.pendingPage = idx;
      this.pendingPageHint = hint;
    }
  }

  /**
   * 把侧栏滚到某一页的缩略图，让它进入可视区。
   *
   * 只给**显式跳页**用（见 `gotoPageFromLink`）。侧栏收起 / 页列表还没建时
   * 静默返回 —— 展开时会由 `applySideVisibility → updatePageWindow` 补建。
   *
   * **坐标系要换算**（踩过）：`rowTop = row × rowH` 是**列表内部**坐标，
   * 而 `viewport.scrollTop` 是**侧栏**坐标。页列表在侧栏底部（笔盒 / 纸张 /
   * 图层 / 目录之后），列表顶部离侧栏顶部有几百像素。直接拿 rowTop 跟
   * scrollTop 比会误判「已经在可视区」，于是什么都不滚（实测：3 页的本子
   * 缩略图停在 y=853，而视口只到 750，用户根本看不到）。
   * 所以先把列表顶部在侧栏坐标系里的位置算出来，再加上行偏移。
   */
  private revealThumbForPage(index: number, force = false): void {
    const viewport = this.pageListViewportEl;
    const list = this.pageListEl;
    if (!viewport || !list) return;
    // 显式跳页时用户要「看见这一页」：抽屉开着但停在目录标签，就切回缩略图
    if (this.pagedockOpen && this.sideTab !== "thumbs") this.setSideTab("thumbs");
    if (!this.thumbVisible()) return;
    if (list.clientWidth <= 0) return; // 还没布局（侧栏刚展开）
    const count = this.store?.pageCount ?? 0;
    if (index < 0 || index >= count) return;
    const { cols, gap, rowH } = this.measurePageGrid(list);
    if (!(cols > 0) || !(rowH > 0)) return;
    const row = Math.floor(index / cols);
    const rowTop = row * rowH; // 列表内部坐标
    const rowBottom = rowTop + rowH - gap;
    /*
     * 列表顶部在侧栏滚动坐标系里的位置：
     *   rect 差值（当前相对位置）+ 当前 scrollTop = 滚动内容里的绝对位置
     * 只在这里调一次 getBoundingClientRect —— 显式跳页才走，不是每帧。
     */
    const vpRect = viewport.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const listTopInScroll = listRect.top - vpRect.top + viewport.scrollTop;
    const absTop = listTopInScroll + rowTop;
    const absBottom = listTopInScroll + rowBottom;
    const vpTop = viewport.scrollTop;
    const vpBottom = vpTop + viewport.clientHeight;
    // 已经在可视区里就不动，别打断用户；首帧对齐（force）要强制落位 + 重建
    if (!force && absTop >= vpTop && absBottom <= vpBottom) return;
    // 滚到「让这一行落在视口中部偏上」，上下都留点邻居
    const target = Math.max(0, absTop - Math.round(viewport.clientHeight * 0.3));
    viewport.scrollTop = target;
    // 滚完立刻按新位置重建窗口，别等 scroll 事件（无头环境可能不触发）。
    // force 时禁用「窗口没变」的快路径，确保首屏一定是当前页那一屏。
    this.updatePageWindow(force);
  }

  /**
   * 写盘。
   *
   * `force = false` 只给**自动保存**用：正在落笔时先避让（不 stringify），
   * 把那次保存欠着。显式路径——切后台 / 关文件 / Ctrl+S / 手动保存 / 导入——
   * 一律用默认的 `force = true`，必须当场写，不能被书写挡住。
   *
   * 避让判断的位置很讲究：放在「保存中 → saveAgain 排队」**之后**、
   * 置 saving **之前**。放在前面会把正在进行的保存误当成「又排一次」，
   * 放在后面则会让 UI 永远卡在「保存中…」。
   */
  async saveNow(force = true): Promise<void> {
    if (!this.store || !this.file || this.readOnly || this.conflict) {
      /*
       * 兜底：只读态下有改动却走到这里（万一以后又冒出别的只读路径），
       * 至少要让用户知道"这些字存不下去"，而不是安静地丢掉。
       */
      if (this.readOnly && (this.dirty || this.metaDirty)) this.warnReadOnly();
      return;
    }
    if (this.saving) {
      this.saveAgain = true;
      /*
       * 显式路径（切文件 / 关标签页 / Ctrl+S）必须**真的等到写完**。
       *
       * 以前这里直接 return，调用方的 `await saveNow()` 立刻返回，
       * 而上一本的写盘还在飞：`onLoadFile` 紧接着把 file 换成新本子，
       * 在途的那次写盘读到的却是新的 `this.store.data` —— 新本子的内容
       * 被写进旧本子的文件（INK-167）。等它写完，切换才真正安全。
       *
       * 自动保存（force=false）照旧只排队，不阻塞书写。
       */
      if (force && this.savePromise) {
        try {
          await this.savePromise;
        } catch (_) {
          /* 失败原因由那次保存自己记进 lastSaveError */
        }
      }
      return;
    }
    if (!force && this.isInkBusy()) {
      const now = Date.now();
      if (!this.inkDeferAt) this.inkDeferAt = now;
      if (now - this.inkDeferAt < INK_DEFER_MAX_MS) {
        // 只欠着，不序列化；抬笔（onInkGestureEnd）或 10s 上限会再来
        this.armInkDeferRetry(INK_DEFER_MAX_MS - (now - this.inkDeferAt));
        return;
      }
      // 手势卡死超过上限（事件丢失）：不等了，强制写一次
      console.warn("[inkbook] 书写手势超过 10s 未结束，强制保存一次");
    }
    this.inkDeferAt = 0;
    this.cancelInkDeferRetry();
    this.saving = true;
    this.saveAgain = false;
    this.saveState = "saving";
    this.updateStatus();
    const adapter = this.app.vault.adapter;
    /*
     * 这一版要写的东西**必须在第一个 await 之前钉死**。
     *
     * `path` 和 `book` 一旦捕获，后面不管用户切到哪一本，
     * 这次写盘写的都是「属于这个路径的那份内容」——
     * 以前是 await 之后才去读 `this.store.data` / `this.file.path`，
     * 切本子的瞬间就变成「B 的数据写进 A 的文件」（INK-167）。
     * `store` 引用留着只为判断「写完时还是不是同一本」。
     */
    /*
     * 用 `bookPath` 而不是 `this.file.path`：宿主在切文件时可能**先**
     * 把 `view.file` 换成新文件、再调 `onLoadFile`，那时 store 还是上一本，
     * 按 `this.file.path` 写就等于把上一本的内容写进新文件。
     */
    const path = this.bookPath || this.file.path;
    /*
     * 最后一道防线：**只往 .inkbook 写**（INK-184）。
     *
     * 上面已经保证 `this.file` 不会留成 .pdf，但保存链路是数据安全里
     * 最不能靠「上游应该做对了」的地方——一旦路径不是 .inkbook，
     * 写下去就是把整本 JSON 灌进用户的 PDF/图片/别的笔记里，
     * 而且**原文件当场被毁**（真实现场：导出的 7MB PDF 被换成 128KB JSON）。
     * 宁可这次不存（dirty 还挂着，下次切本子会走 rescueUnsaved 另存副本），
     * 也不能写错地方。
     */
    if (!/\.inkbook$/i.test(path)) {
      console.error("[inkbook] 拒绝往非 .inkbook 路径写盘：", path);
      this.saving = false;
      this.saveState = "dirty";
      this.updateStatus();
      this.lastSaveError = `目标路径不是 .inkbook（${path}）`;
      return;
    }
    const store = this.store;
    const book = store.data;
    /*
     * 指纹也要一起捕获：`this.fp` 会在切本子时被换成新本的，
     * 拿新本的指纹去比旧文件，会把一次正常保存误判成「外部改动」，
     * 平白多产出两份冲突副本。
     */
    const fp = this.fp;
    /*
     * 内容基线同样在第一个 await 之前钉死：切本子会把 this.diskHash 清掉/换掉，
     * 拿新本的基线去比旧文件没有意义（会漏判或误判冲突）。
     */
    const baseline = this.diskHash;
    const baselineSig = this.diskContentSig;
    const run = (async () => {
      try {
        if (this.editor && this.store === store) {
          book.activePage = this.editor.getState().pageIndex;
        }

        // 写之前先看磁盘上的文件有没有被别处改过（同步、别的窗口、外部编辑器）
        const now = await fingerprint(adapter, path);
        if (fp && now && (now.mtime !== fp.mtime || now.size !== fp.size)) {
          /*
           * 指纹（mtime + size）对不上，**先别急着判冲突**。
           *
           * 同步客户端（Obsidian Sync / iCloud / OneDrive / Syncthing…）在下载、
           * 校验、回写时经常只更新 mtime，正文一个字节没变。旧逻辑一看指纹变了
           * 就另存 `-disk-` / `-mine-` 两份副本并停写主文件——用户看到的就是
           * 「一写字就说同步失败、还反复生成备份文件」。
           *
           * 所以这里再比一次**内容哈希**：只要磁盘字节和上次读到/写入的基线一致，
           * 就是「文件被动过、但内容没变」，收下新指纹、照常保存即可。
           *
           * 只有内容确实不同（含 size 不同，或同 size 但哈希不同）才走冲突副本。
           * 读不出磁盘内容时无法确认，保守按真冲突处理，绝不覆盖未知内容。
           */
          let benign = false;
          if (baseline != null && typeof adapter.read === "function") {
            try {
              const diskText = await adapter.read(path);
              if (typeof diskText === "string") {
                if (hashText(diskText) === baseline) {
                  benign = true;
                } else {
                  /*
                   * 整份 JSON 的哈希不只含正文，还含 `updated` / `activePage` /
                   * zoom / scrollTop 这些易变元数据：另一台设备只是打开同一本、
                   * 翻了一页或滚了下，整份哈希就变了。旧逻辑把它当真正冲突，
                   * 每次保存都另存一对 `-disk-` / `-mine-` 副本——用户看到的
                   * 就是「电脑端不同步回来，只会不停生成副本」。
                   *
                   * 所以哈希不一致时再比**实质内容**（pages + outlines，忽略
                   * 更新时间和视图状态）。实质相同＝只是元数据被同步盘/另一
                   * 设备摸过，安全收下新指纹继续写正文，不再产副本。
                   */
                  try {
                    const diskRaw = JSON.parse(diskText);
                    const diskSig = this.bookContentSignature(diskRaw);
                    if (baselineSig != null && diskSig === baselineSig) {
                      benign = true;
                    }
                  } catch (_) {
                    /* 解析失败就按真冲突处理，绝不覆盖未知内容 */
                  }
                }
              }
            } catch (e) {
              console.warn("[inkbook] 冲突复核读取磁盘失败，按外部改动保守处理", e);
            }
          }
          if (benign) {
            // 内容与基线一致：同步盘只是摸了 mtime，不算冲突。收下新指纹继续写。
            if (this.store === store) this.fp = now;
          } else {
            await this.saveConflictCopies(adapter, path, book);
            if (this.store !== store) return;
            this.conflict = true;
            this.saveState = "dirty";
            /*
             * 提示里必须给出**怎么退出这个状态**（INK-206）。
             *
             * 进入冲突后 `saveNow` 整个跳过，本标签页再也不会写主文件。
             * 老文案只说「请手动检查后选择保留哪一份」，没告诉用户
             * 处理完之后怎么继续写——他改完副本回到这个标签页，
             * 发现还是存不进去，只能自己猜。
             * 实际自救路径就是「关掉本子重新打开」（`openBook` 会复位
             * `conflict`），必须写出来。
             */
            new Notice(
              "检测到文件已被外部修改，已另存为两份副本，本次未覆盖原文件。" +
                "请手动检查后选择保留哪一份；处理完后**关掉这个标签页重新打开本子**即可恢复保存。",
              15000
            );
            return;
          }
        }

        /*
         * 记下代次再进 writeBook：它一进去就 stringify，之后备份 / tmp 写入
         * 都在 await——那段时间用户再落的笔**不在这一版 JSON 里**。
         * 存完对比代次，变了就保留 dirty 并再排一次，不能把「已保存」当终点。
         */
        const dirtyEpoch = this.dirtyEpoch;
        const metaEpoch = this.metaEpoch;
        /*
         * 视图状态（缩放 / 页内滚动位置）在 stringify 前一刻才写进 book：
         * 放在第一个 await（指纹 / 冲突检测）之前的话，用户在那段时间里
         * 缩放或滚动，落盘的仍是旧落点，下次打开「记得的位置」就差一截。
         *
         * 只有 store 还是同一本时才从编辑器取值。切本子抢先发生的话，
         * this.editor 已经是新本子的，读它会把 B 的缩放/滚动写进 A 的文件；
         * 那种情况保持 book 上已有的字段不动（它们属于 A）。
         */
        const view =
          this.editor && this.store === store
            ? this.captureViewState(book)
            : { zoom: book.zoom, scrollTop: book.scrollTop, scrollLeft: book.scrollLeft };
        const writtenJson = await writeBook(adapter, path, book);
        /*
         * 主动通知嵌入重画。
         *
         * 以前只靠 vault 的 `modify` 事件，但我们是走 `adapter.write` 直接写的，
         * 这条路径**不保证**触发宿主事件（各平台/版本表现不一致）。
         * 于是平板上「笔记里嵌的那一页」一直显示旧图，直到别的操作顺手刷新
         * （INK-170）。这里在写成功后无条件通知一次，不依赖宿主事件。
         *
         * 放在 store 校验**之前**：即便用户已经切走，写下去的那份文件也该刷新。
         */
        refreshEmbedsForPath(path);
        /*
         * 已经切到别的本子：这次写的是上一本，**不能**去改新本的
         * dirty / fp / 保存状态，否则新本会被误标成「已保存」而漏写。
         */
        if (this.store !== store) return;
        this.lastSaveError = null;
        if (this.dirtyEpoch === dirtyEpoch) {
          this.dirty = false;
          this.saveState = "saved";
        } else {
          // 写盘期间又有新改动：这一版写的是旧内容，存完再存一次
          this.dirty = true;
          this.saveState = "dirty";
          this.saveAgain = true;
        }
        if (this.metaEpoch === metaEpoch) {
          this.metaDirty = false;
          this.savedActivePage = book.activePage;
          // 基线跟着这次真正写下去的值走；代次对不上说明期间又变了，
          // 保持旧基线、让下一次 flush 继续把它们写掉
          this.savedZoom = view.zoom;
          this.savedScrollTop = view.scrollTop;
          this.savedScrollLeft = view.scrollLeft;
        }
        const fpAfter = await fingerprint(adapter, path);
        /*
         * 取指纹也是 await：期间用户可能已经切走（store 换成新的）。
         * 不判这一下，旧路径的指纹会赋给新本，下次保存拿它去比新文件
         * → 误判成「外部改动」，白产两份冲突副本并停写主文件（INK-174）。
         */
        if (this.store !== store) return;
        this.fp = fpAfter;
        // 这次真正写下去的字节就是新的磁盘基线，下次据此分辨「摸 mtime」和「真改了」
        this.diskHash = hashText(writtenJson);
        this.diskContentSig = this.bookContentSignature(book);
        /*
         * 本子落盘之后再更新文字索引：索引是派生物，
         * 万一它写失败，不能反过来把「本子已保存」报成失败。
         */
        this.scheduleTextIndex();
      } catch (e: any) {
        console.error("[inkbook] 保存失败", e);
        const msg = e && e.message ? e.message : String(e);
        /*
         * 失败原因要留着：切文件时（INK-169）得靠它判断「内存里这份还没落盘」，
         * 只弹一条 8 秒就消失的 Notice，用户根本没机会看到就已经切走了。
         */
        this.lastSaveError = msg;
        if (this.store === store) {
          this.saveState = "dirty";
          new Notice("保存失败：" + msg, 8000);
        }
      } finally {
        this.saving = false;
        if (this.store === store) this.updateStatus();
        if (this.saveAgain) {
          this.saveAgain = false;
          // 关掉自动保存后不再补排；这一笔仍留在 dirty，显式保存/flush 会写掉
          if (this.plugin.settings.autosave) this.saveDebounce();
        }
      }
    })();
    this.savePromise = run;
    try {
      await run;
    } finally {
      if (this.savePromise === run) this.savePromise = null;
    }
  }

  /**
   * 给「副本」类文件取一个不会撞名的路径：**只增不改**。
   *
   * 副本名里的时间戳只精确到分钟，同一分钟内发生第二次就会覆盖
   * 用户已经拿去用的那一份（恢复副本踩过这个坑，冲突副本同理）。
   * 撞名时依次试 -2、-3…；拿不到 exists 能力就按「不存在」处理 ——
   * 宁可多产出一份，也不能因为探不了名就不生成副本。
   */
  private async uniqueCopyPath(
    adapter: { exists?: (path: string) => Promise<boolean> },
    wanted: string
  ): Promise<string> {
    const exists = adapter?.exists;
    if (typeof exists !== "function") return wanted;
    const suffix = ".inkbook";
    const hasExt = wanted.toLowerCase().endsWith(suffix);
    const stem = hasExt ? wanted.slice(0, -suffix.length) : wanted;
    const ext = hasExt ? wanted.slice(-suffix.length) : "";
    const taken = async (p: string): Promise<boolean> => {
      try {
        return await exists.call(adapter, p);
      } catch (_) {
        return false;
      }
    };
    if (!(await taken(wanted))) return wanted;
    for (let n = 2; n < 100; n += 1) {
      const cand = `${stem}-${n}${ext}`;
      if (!(await taken(cand))) return cand;
    }
    return `${stem}-${Date.now().toString(36)}${ext}`;
  }

  /**
   * 一本书的「实质内容」签名：版本格式、标题/尺寸/来源、pages 与 outlines。
   *
   * 刻意排除 `version` / `updated` / `activePage` / `zoom` / `scrollTop` /
   * `integrity` 这些易变或可升级的元数据——否则另一台设备随手翻页/滚动，
   * 或旧文件被 normalize 升级版本号，整份哈希变化就会被误判成正文冲突并
   * 不断生成副本（见 saveNow 的 benign 复核）。
   */
  private bookContentSignature(raw: any): string | null {
    if (!raw || !Array.isArray(raw.pages)) return null;
    try {
      return JSON.stringify({
        /*
         * 不比 version：老文件读进来会被 normalizeBook 升到当前版本，
         * 磁盘上的旧 version 与新内存版本只因格式升级而不同，正文其实没变。
         */
        kind: raw.kind,
        title: raw.title,
        width: raw.width,
        height: raw.height,
        source: raw.source ?? null,
        created: raw.created,
        pages: raw.pages,
        outlines: raw.outlines ?? null,
      });
    } catch (_) {
      return null;
    }
  }

  /**
   * 冲突时把两份内容都另存出来，**主文件一个字节都不写**。
   *
   * 这里不能猜哪一份是用户想要的：磁盘上那份可能是同步下来的新版本，
   * 内存里那份可能是刚写了半小时的笔记。所以两份都给，让用户自己挑。
   *
   * 两份副本各自探名（`-disk-` 与 `-mine-` 不共用编号），同分钟再冲突
   * 只会多出新副本，不会覆盖用户已经拿去用的那份。
   */
  private async saveConflictCopies(
    adapter: {
      read: (p: string) => Promise<string>;
      write: (p: string, d: string) => Promise<void>;
      exists?: (p: string) => Promise<boolean>;
    },
    path: string,
    /** 要另存的那本书；不传 = 当前这本（切本子的在途保存必须显式传，否则会存错本） */
    source?: InkBook
  ): Promise<void> {
    const base = path.replace(/\.inkbook$/i, "");
    const stamp = conflictStamp(new Date());

    // 磁盘上的版本：原样抄一份，不经过任何解析，保证一字不差
    let diskText = "";
    let diskPages = 0;
    try {
      diskText = await adapter.read(path);
      const raw = JSON.parse(diskText);
      diskPages = Array.isArray(raw?.pages) ? raw.pages.length : 0;
    } catch (e) {
      console.warn("[inkbook] 读取磁盘版本用于另存失败", e);
      diskText = "";
    }
    if (diskText) {
      try {
        const target = await this.uniqueCopyPath(
          adapter,
          `${base}.conflict-${stamp}-disk-p${diskPages}.inkbook`
        );
        await adapter.write(target, diskText);
      } catch (e) {
        console.error("[inkbook] 另存磁盘版本失败", e);
      }
    }

    // 内存里的版本
    const mine = source ?? (this.store ? this.store.data : null);
    if (mine) {
      try {
        mine.integrity = bookStats(mine);
        const target = await this.uniqueCopyPath(
          adapter,
          `${base}.conflict-${stamp}-mine-p${mine.pages.length}.inkbook`
        );
        await adapter.write(target, JSON.stringify(mine));
      } catch (e) {
        console.error("[inkbook] 另存内存版本失败", e);
      }
    }
  }

  /**
   * 冲突未解决就关文件 / 切文件时的兜底：把内存里的内容再抄一份。
   *
   * `conflict` 为真时 saveNow 整个跳过（不能写主文件），但用户可能
   * 在冲突之后又写了半小时——那些笔迹只在内存里。关掉视图就等于丢掉。
   * 所以关文件前无条件另存一份 `-mine-` 副本，主文件依然一个字节不动。
   */
  private async preserveConflictCopy(): Promise<void> {
    if (!this.conflict || !this.store || !this.file) return;
    if (!this.dirty && !this.metaDirty) return;
    const base = (this.bookPath || this.file.path).replace(/\.inkbook$/i, "");
    const mine = this.store.data;
    mine.integrity = bookStats(mine);
    try {
      const adapter = this.app.vault.adapter;
      const target = await this.uniqueCopyPath(
        adapter,
        `${base}.conflict-${conflictStamp(new Date())}-mine-p${mine.pages.length}.inkbook`
      );
      await adapter.write(target, JSON.stringify(mine));
      new Notice("冲突未解决：当前内容已另存为副本，原文件未被改动。", 10000);
    } catch (e) {
      console.error("[inkbook] 冲突兜底另存失败", e);
      new Notice("冲突未解决，且另存副本失败：请先别关闭这个标签页。", 0);
    }
  }

  /**
   * 显式落盘（切文件 / 关文件 / 关标签页）。
   *
   * @returns 是否真的写成功了。`false` = 内存里还有没落盘的内容，
   *   调用方必须抢救（见 `rescueUnsaved`），不能当没事发生。
   */
  async flushSave(): Promise<boolean> {
    /*
     * 先把页码 / 缩放 / 滚动位置同步回内存并标记元数据脏。
     *
     * onClose / onUnloadFile 各自会调一次 syncActivePage，但切后台
     * （visibilitychange / pagehide）只走 flushSave——不在入口统一同步的话，
     * 用户只是缩放了或滚了几屏就切 App，这些位置信息永远不会落盘。
     */
    this.syncActivePage();
    /*
     * 编辑框里没按回车、也没失焦的文字先落库：切文件（onLoadFile /
     * onUnloadFile）、关标签页（onClose）都从这条路过。移动端 textarea
     * 自带的 blur 兜底不可靠（点别处 / 切后台未必触发），不在这里主动
     * 提交就会整段丢字。force：等不到 compositionend，组字中只写已上屏部分。
     */
    this.editor?.commitTextEditNow(true);
    /*
     * 手还按在纸上就关标签页 → 这一笔只活在 draft 里，从没进过 book。
     *
     * 以前只有 visibilitychange / pagehide 会收尾，而关标签页在桌面上
     * 走的是 onClose（页面并不 hidden），那一笔就这么没了（INK-168）。
     * finishInkGesture 会 commitDraft 并触发 markDirty，下面的 saveNow 才写得进去。
     */
    this.editor?.finishInkGesture();
    this.saveDebounce.cancel();
    /*
     * 显式落盘路径，**不避让书写**：切后台 / 关文件 / 切文件时，
     * 正在写的那一笔上面已经收尾提交，这里负责把内容一条不落地写下去。
     *
     * 循环最多 3 轮：`saveNow` 遇到「已经有一次保存在写」时会先等它写完
     * 再返回（INK-167），那一版可能还不包含最新改动——必须再存一次才干净。
     * 有失败就立刻停手，交给 rescueUnsaved 抢救，别在同一个错误上空转。
     */
    for (let round = 0; round < 3; round++) {
      if (!this.dirty && !this.metaDirty) break;
      await this.saveNow();
      // 写不进去 / 只读 / 冲突：这几种再存多少次都是同一个结果
      if (this.lastSaveError || this.readOnly || this.conflict) break;
    }
    // 循环里那次保存可能又排了一个 850ms 后的自动保存，切文件前没意义
    this.saveDebounce.cancel();
    /*
     * 3 轮跑完还脏：说明用户在这段时间里一直在写（每轮都写不完）。
     * 这**不是写盘失败**，只是内容还没追上——但不能当成成功放过去，
     * 否则那些笔迹就跟着视图一起消失了。标记一下，让调用方去抢救副本，
     * 提示措辞也要和真正的 IO 失败区分开（INK-174 复查）。
     *
     * 只读 / 冲突要排除：这两种情况下 dirty 本来就永远清不掉
     * （只读不写盘、冲突只出副本），不是"没来得及写完"，
     * 当成失败会每关一次文件就白抢救一份（H3 用例当场抓到）。
     */
    if (
      !this.lastSaveError &&
      !this.readOnly &&
      !this.conflict &&
      (this.dirty || this.metaDirty)
    ) {
      this.lastSaveError = "还有内容没来得及写完";
    }
    /*
     * saveNow 成功时只负责「排一个 1 秒后的索引定时器」，而随后 destroyEditor()
     * 会把它取消。这里等索引真正写完，搜索里才不会缺最后一次保存的内容。
     *
     * 补一次 schedule：saveNow 在「已经有一次保存正在进行」时会直接返回
     * （排队 saveAgain），那次保存还没走到 scheduleTextIndex，
     * 这时 indexPending 可能还是空的——不补这一次，就没东西可冲。
     */
    if (this.dirty || this.metaDirty) this.scheduleTextIndex();
    await this.flushTextIndex();
    /*
     * 判定「落盘成功」：没有失败记录，且脏标记真的清了。
     *
     * **先判 conflict 再判 lastSaveError**（INK-174 复查）：早先失败过一次
     * （比如盘满）之后又转成冲突状态时，主文件确实没写——但那条路由
     * preserveConflictCopy 兜底另存副本，此时再让调用方去 rescueUnsaved
     * 会同时产出 conflict 副本和 unsaved 副本两份，提示还会说错原因。
     */
    if (this.conflict) return true;
    if (this.lastSaveError) return false;
    /*
     * 只读本上的改动本来就存不下去，而且已经弹过「改动不会保存」。
     * 这里若算成失败，每切一次文件就抢救出一份副本，越攒越多——
     * 用户改的到底要不要留，得由他自己决定（提示已经给过了）。
     */
    if (this.readOnly) return true;
    return !this.dirty && !this.metaDirty;
  }

  /**
   * 保存失败还要切走时，把内存里这份内容抢救成一份副本。
   *
   * 磁盘满 / 无权限 / 文件被占用时，`saveNow` 只能弹一条 8 秒的 Notice；
   * 用户紧接着切本子，`onUnloadFile` 会把 store 清掉——那半小时的笔记
   * 就彻底没了（INK-169）。真正拦住切换在 Obsidian 的 API 里做不到
   * （onLoadFile 是宿主直接调的），所以退一步：**先把内容另存出来**，
   * 再用一条不会自动消失的提示告诉用户副本在哪。
   */
  private async rescueUnsaved(reason: string): Promise<void> {
    if (!this.store || !this.file) return;
    if (!this.dirty && !this.metaDirty) return;
    // 同一份未落盘内容只抢救一次：切文件时救过，紧接着 onClose 不该再产出一份
    if (this.rescued) return;
    const mine = this.store.data;
    mine.integrity = bookStats(mine);
    const base = (this.bookPath || this.file.path).replace(/\.inkbook$/i, "");
    try {
      const adapter = this.app.vault.adapter;
      const target = await this.uniqueCopyPath(
        adapter,
        `${base}.unsaved-${conflictStamp(new Date())}-p${mine.pages.length}.inkbook`
      );
      await adapter.write(target, JSON.stringify(mine));
      /*
       * **写成功之后**才置位（INK-174 复查）。
       *
       * 以前在写之前就置 true：第一次抢救因为磁盘满失败后，用户继续写、
       * 再切本子时会被 `rescued` 直接挡掉——真正该救的内容反而没救。
       * 成功才置位，失败时下次切走还能再试一次。
       */
      this.rescued = true;
      const name = target.split("/").pop() || target;
      new Notice(
        `保存失败（${reason}），内容已另存为「${name}」。` +
          `原文件可能不是最新的，请检查这份副本后再继续使用。`,
        0
      );
    } catch (e: any) {
      console.error("[inkbook] 抢救未保存内容失败", e);
      new Notice(
        `保存失败（${reason}），且另存副本也失败：请先别关闭这个标签页。`,
        0
      );
    }
  }

  /* ------------------------------- 快捷键 ------------------------------- */

  private onKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
    if (target && target.isContentEditable) return;
    if (this.app.workspace.getActiveViewOfType(InkbookView) !== this) return;
    if (!this.editor) return;

    /*
     * 快捷键全部走设置里可自定义的映射：把这次按键规范化成 combo，再查动作表。
     * 表里没有的键一律放行（不 preventDefault），交给宿主处理（如 Ctrl+P）。
     * 默认值完全复刻旧行为（含 Ctrl+Y 重做、Delete/Backspace 删字、+ 与 = 放大）。
     */
    const combo = keyCombo(e);
    if (!combo) return; // 只按了修饰键
    const action = resolveHotkeys(this.plugin.settings.hotkeys).get(combo);
    if (!action) return;
    this.runHotkeyAction(action, e);
  }

  /**
   * 执行一个快捷键动作。e 只用于对系统级组合（保存 / 撤销 / 重做 / 删字）
   * preventDefault，其余动作按旧行为不拦截默认事件。
   */
  private runHotkeyAction(action: string, e: KeyboardEvent): void {
    const editor = this.editor!;
    switch (action) {
      case "save":
        e.preventDefault();
        this.saveNow();
        return;
      case "undo":
        e.preventDefault();
        editor.undo();
        return;
      case "redo":
        e.preventDefault();
        editor.redo();
        return;
      case "deleteText":
        // 没有选中文字 / 形状 / 图片时不拦截 Delete / Backspace（保持旧行为）
        if (editor.selectedText) {
          e.preventDefault();
          editor.deleteSelectedText();
        } else if (editor.selectedShape) {
          e.preventDefault();
          editor.deleteSelectedShape();
        } else if (editor.selectedImage) {
          e.preventDefault();
          editor.deleteSelectedImage();
        }
        return;
      case "cancel":
        // 有选中的文字 / 形状 / 图片先取消选中，别顺手去收侧栏
        if (editor.selectedText) editor.selectText(null);
        else if (editor.selectedShape) editor.selectShape(null);
        else if (editor.selectedImage) editor.selectImage(null);
        else if (this.sideShown) this.toggleSide();
        return;
      case "find":
        // 捕获期通常已经接管了；这里是自定义键位 / 非捕获路径的兜底
        e.preventDefault();
        this.openFindBar();
        return;
      // ---- 切工具：走 activateTool，和点顶栏按钮是同一种「用户动作入口」，
      //      第一次切工具、已在该工具上再按一下弹出/收起快捷参数浮层。
      //      形状 / 文字 / 橡皮不再因为切工具而连带展开侧栏（浮层里就够调参）----
      case "pen":
      case "ballpoint":
      case "highlighter":
      case "eraser":
      case "text":
      case "select":
      case "shape":
      case "hand":
        this.activateTool(action as ToolId);
        return;
      case "penOnly": {
        const on = !this.plugin.settings.penOnly;
        this.plugin.settings.penOnly = on;
        void this.plugin.saveSettings();
        editor.setPenOnly(on);
        this.updateUI();
        new Notice(on ? "只认触控笔：手指只滚动" : "手指和鼠标也能写", 2500);
        return;
      }
      case "fit":
        editor.fit();
        return;
      case "zoomIn":
        editor.zoomBy(1.15);
        return;
      case "zoomOut":
        editor.zoomBy(1 / 1.15);
        return;
      case "toggleSide":
        this.toggleSide();
        return;
      case "toggleDock":
        this.togglePageDock();
        return;
      /* 经典手写应用移植功能：快捷键只切运行时状态，同时写回设置并同步所有视图 */
      case "cycleShapeSnap": {
        const on = normalizeShapeSnap(this.plugin.settings.shapeSnap) === "off";
        this.plugin.settings.shapeSnap = on ? "lift" : "off";
        void this.plugin.saveSettings();
        this.plugin.refreshViews();
        new Notice(on ? "一笔成型：开（画完立刻识别）" : "一笔成型：关", 2200);
        return;
      }
      case "toggleLaser": {
        const on = this.plugin.settings.laserPointer !== true;
        this.plugin.settings.laserPointer = on;
        void this.plugin.saveSettings();
        this.plugin.refreshViews();
        new Notice(on ? "激光笔：开（只指示，不落墨）" : "激光笔：关", 2200);
        return;
      }
    }
  }

  syncSettings(): void {
    if (!this.editor) return;
    this.editor.setPenOnly(!!this.plugin.settings.penOnly);
    // 设置页现在也能改「允许手指书写」：同步到已打开的视图，
    // 不能让设置页里改完、当前笔记还是老样子。
    this.editor.setTouchDraw(this.plugin.settings.touchDraw === true);
    this.editor.setPressure(finiteSetting(this.plugin.settings.pressure, 1, 0.3, 1.5));
    this.editor.setSmoothing(finiteSetting(this.plugin.settings.smoothing, 0.55, 0, 1));
    this.editor.setPrediction(this.plugin.settings.prediction !== false);
    this.editor.setEdgeSwipeBlock(this.plugin.settings.blockEdgeSwipe !== false);
    this.editor.setStraighten(this.plugin.settings.straightLine === true);
    // 经典手写应用移植功能：设置页改完立刻对所有已打开的视图生效
    this.editor.setShapeSnap(normalizeShapeSnap(this.plugin.settings.shapeSnap));
    this.editor.setLaserPointer(this.plugin.settings.laserPointer === true);
    // 与 mountEditor 一致地兜底：0 / NaN / null 会让笔尖宽度变成非法值，
    // 落笔线条消失、Path2D 也会拿到 NaN。别让「改了别的设置」顺手弄坏笔。
    this.editor.penSize = finiteSetting(this.plugin.settings.defaultPenSize, 2.8, 1, 8);
    this.editor.ballpointSize = finiteSetting(this.plugin.settings.defaultBallpointSize, 2.8, 1, 8);
    this.editor.shapeSizes = finiteShapeSizes(this.plugin.settings.defaultShapeSizes, 2.8);
    // 设置页里的「上次用的笔色 / 荧光色 / 荧光粗细」改完立即生效
    this.editor.penColor = this.plugin.settings.lastPenColor || "#1A1A1A";
    this.editor.highlighterColor = this.plugin.settings.lastHighlighterColor || "#F6E05E";
    this.editor.highlighterSize = finiteSetting(
      this.plugin.settings.defaultHighlighterSize,
      24,
      4,
      40
    );
    // 橡皮记忆：设置页/其他窗口改了也同步（同样做非法值兜底）。
    this.editor.eraserMode = this.plugin.settings.lastEraserMode === "whole" ? "whole" : "part";
    this.editor.eraserSize = finiteSetting(this.plugin.settings.lastEraserSize, 26, 6, 60);
    // 快捷键可能刚在设置页改过：刷新按钮 tooltip 上显示的键位
    this.syncHotkeyLabels();
    this.updateUI();
  }
}
