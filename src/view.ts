import { FileView, Menu, Notice, type TFile } from "obsidian";
import { setIcon } from "./icons";
import { BookEditor, bindHoldStepBtn, TEXT_FONTS } from "./editor";
import { indexDirFor, writeTextIndex } from "./indexer";
import { BookStore } from "./store";
import {
  bookStats,
  fingerprint,
  readBook,
  recoverFromBackup,
  TooNewError,
  writeBook,
  type FileFingerprint,
} from "./storage";
import {
  A4_HEIGHT,
  A4_WIDTH,
  HIGHLIGHTER_SIZES,
  PAPERS,
  PEN_COLORS,
  PEN_SIZES,
  TEMPLATES,
  type InkBook,
  type InkbookSettings,
  type Outline,
  type PaperId,
  type ShapeKind,
  type TemplateId,
  type ToolId,
} from "./types";
import { paintPaperPreview } from "./paper";
import {
  NewBookModal,
  JumpPageModal,
  PromptModal,
  OutlineModal,
  ImportSourceModal,
  ImportRangeModal,
} from "./modals";
import { importPdf, importWord } from "./importer";
import { ExportCancelledError, exportBookPdf, exportPagePng } from "./export";

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
  { id: "pen", icon: "pen-tool", name: "钢笔 (P)", short: "钢笔" },
  { id: "ballpoint", icon: "pencil", name: "圆珠笔 (B)", short: "圆珠" },
  { id: "highlighter", icon: "highlighter", name: "荧光笔 (H)", short: "荧光" },
  { id: "eraser", icon: "eraser", name: "橡皮 (E)", short: "橡皮" },
  { id: "text", icon: "type", name: "文字 (T)", short: "文字" },
  { id: "select", icon: "cursor", name: "选择 / 移动 (V)", short: "选择" },
  { id: "shape", icon: "square", name: "形状 (R)", short: "形状" },
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
 *   · pen / ballpoint / highlighter —— 颜色和粗细都在笔盒区，而且顶栏新增的
 *     当前笔 chip 已经露出「什么色、多粗」；这三支换得最勤，每换一次就把
 *     侧栏盖到纸上（平板）反而碍事。
 *   · select / hand —— 没有可调参数，侧栏里只有一句操作提示。
 */
const TOOLS_NEED_SIDE = new Set<ToolId>(["text", "eraser", "shape"]);

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
/** 量不到真实条目时的兜底行高（px） */
const OUTLINE_ROW_H = 24;
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

export interface InkbookPluginLike {
  settings: InkbookSettings;
  saveSettings(): Promise<void>;
  refreshViews(): void;
}

export class InkbookView extends FileView {
  plugin: InkbookPluginLike;
  file: TFile | null = null;
  store: BookStore | null = null;
  editor: BookEditor | null = null;

  private railReadBtn!: HTMLElement;
  private railSideBtn!: HTMLElement;
  /**
   * 顶栏上的「立即保存」按钮。
   *
   * 自动保存有 850ms 防抖：写完最后一笔想马上确认"已经存住了"时没有入口。
   * 按钮常驻在顶栏上，不用先展开侧栏。
   */
  private railSaveBtn!: HTMLElement;
  private readHintEl!: HTMLElement;
  private floatEl!: HTMLElement;
  private floatZoomEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private editorHost!: HTMLElement;
  private paperHost!: HTMLElement;
  private sideEl!: HTMLElement;
  private dynEl!: HTMLElement;
  private pageLbl!: HTMLElement;
  /** 顶栏那一行：7 支笔 + 保存/侧栏/仅阅读，全部挤在标题栏同一行 */
  private topRowEl: HTMLElement | null = null;
  /** 顶栏里的工具组（仅阅读时整组收起） */
  private topToolsEl: HTMLElement | null = null;
  /** 标题栏里原本挂 action 的那个容器（放不下时把整行搬回来用） */
  private actionsHostEl: HTMLElement | null = null;
  /** 放不下时，整行搬进视图自己画的这条顶栏条 */
  private topBarEl: HTMLElement | null = null;
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
  private stylusBtn!: HTMLButtonElement;
  private toolButtons = new Map<ToolId, HTMLButtonElement>();
  /**
   * 顶栏上的「当前笔」提示：一枚色点 + 粗细数值。
   *
   * 平板侧栏默认收起，顶栏又只亮工具图标——写之前看不到自己拿的
   * 是什么颜色、多粗。这枚 chip 常驻在工具组右侧，点它开合侧栏。
   * 由 updatePenChip 在 updateUI 里刷新（纯显示，绝不在这里自动展开侧栏）。
   */
  private penChipEl: HTMLElement | null = null;
  private penChipDotEl: HTMLElement | null = null;
  private penChipSizeEl: HTMLElement | null = null;
  private sideBtn!: HTMLElement;
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
   * 仅阅读模式。
   *
   * 与「侧栏开合」是**两件独立的事**：
   *   · 侧栏收起 → 只是收起工具，照样能写字
   *   · 仅阅读 → 显式切过去，长条淡出、编辑器只读
   *
   * 之前这两件事是绑在一起的（面板收起 = 仅阅读），
   * 那在「面板是唯一入口」时成立；长条常驻后就不成立了——
   * 工具一直可点却不能生效，说不通。
   */
  private reading = false;
  /** 仅阅读提示的自动消失定时器 */
  private hintTimer = 0;
  /** 缩放指示器：缩放时才浮现，2.6 秒后自己退回去 */
  private zoomHintTimer = 0;
  /** 缩放指示器是否被指针悬停（悬停时不自动隐藏） */
  private zoomHintHover = false;
  /** 上一次的缩放值，用来判断"这次状态变化是不是缩放引起的" */
  private lastZoom = -1;
  private touchBtn!: HTMLButtonElement;
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
  /** 上次成功写盘时的 activePage，用来看"翻页后到底要不要写一次" */
  private savedActivePage = -1;
  /** 检测到外部改动后置真：此后不再写主文件，等用户自己处理两份副本 */
  private conflict = false;
  /** 只读态的"改动不会保存"提示是否已经弹过（每本书一次，别刷屏） */
  private readOnlyNoticeShown = false;
  /** 是否正在装配视图（装配期的 setReading / markDirty 不算用户操作） */
  private assembling = false;
  /** 只读恢复时另存出来的副本**文件名**；有它才能告诉用户"改用那份" */
  private recoveredCopyName: string | null = null;
  private saving = false;
  private saveAgain = false;
  /** 导出进行中：重复点导出只提示，不并发跑第二份（大本会双倍吃内存） */
  private exporting = false;
  private readOnly = false;
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
    this.registerDomEvent(window, "resize", () => this.scheduleTopRowFit());
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
    this.syncActivePage();
    await this.flushSave();
    // 冲突还没解决就关窗：内存里的内容必须落到磁盘上，不能静默丢
    await this.preserveConflictCopy();
    this.destroyEditor();
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
  }

  /** 装载一本书（首次读成功、以及从备份恢复时共用） */
  private openBook(book: InkBook, readOnly: boolean): void {
    this.store = new BookStore(book);
    this.store.onChange = () => this.markDirty();
    this.readOnly = readOnly;
    this.conflict = false;
    this.metaDirty = false;
    // dirty 必须一起复位：上一本书留下的"未保存"标记会跟着新文件走，
    // 导致打开另一本书什么都不做就白写一次整本
    this.dirty = false;
    this.saveAgain = false;
    this.recoveredCopyName = null;
    this.savedActivePage = book.activePage || 0;
    this.destroyEditor();
    /*
     * 装配期（buildUI → buildRail → setReading）会顺手动到 setReading /
     * markDirty，那不是用户操作。用 assembling 挡住它，否则"每本一次"的
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
     * 只读提示的复位必须放在装配**之后**：buildUI → buildRail → setReading
     * 会在装配期就调一次 warning，若在这里之前复位，那一次就把"每本一次"
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
    this.fp = null;
    this.recoveredCopyName = null;
    this.dirty = false;
    this.metaDirty = false;
    this.conflict = false;
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

  async onLoadFile(file: TFile): Promise<void> {
    const token = ++this._loadToken;
    await this.flushSave();
    if (token !== this._loadToken) return;
    this.file = file;
    const ext = (file.extension || "").toLowerCase();
    if (ext !== "inkbook") {
      this.showError(`墨本只处理 .inkbook 文件，${file.name} 打不开。`);
      return;
    }
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
      const book = await readBook(adapter, file.path, file.basename);
      if (token !== this._loadToken) return;
      this.openBook(book, false);
      this.fp = await fingerprint(adapter, file.path);
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
    await this.flushSave();
    // 冲突还没解决就切文件：内存里的内容必须落到磁盘上，不能静默丢
    await this.preserveConflictCopy();
    this.destroyEditor();
    this.store = null;
    this.file = null;
    this.fp = null;
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
      pressure: this.plugin.settings.pressure,
      smoothing: this.plugin.settings.smoothing,
      prediction: this.plugin.settings.prediction,
      edgeSwipeBlock: this.plugin.settings.blockEdgeSwipe !== false,
      straighten: this.plugin.settings.straightLine === true,
      onState: () => this.updateUI(),
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
        // 侧栏收起/仅阅读时不要画：隐藏状态的 rect 是 0，会走 60×84 的回退尺寸，
        // 白白把 PDF 页排进光栅化队列（展开时会统一补画）
        if (!this.thumbVisible()) return;
        const cv = this.thumbCanvases.get(i);
        // 页号可能不在当前窗口里（大本子只物化可视区），拿不到就等它滚进来再画
        if (cv && cv.isConnected) this.editor?.renderThumbnail(cv, i);
      },
    });
    this.editor.penColor = this.plugin.settings.lastPenColor || "#1A1A1A";
    this.editor.penSize = this.plugin.settings.defaultPenSize || 2.8;
    this.editor.highlighterColor = this.plugin.settings.lastHighlighterColor || "#F6E05E";
    this.editor.highlighterSize = this.plugin.settings.defaultHighlighterSize || 24;
    // 「允许手指书写」以前只活在编辑器实例上，每次打开都回默认 false；
    // 现在从 settings 恢复（侧栏开关 / 设置页都会写回这里）。
    this.editor.touchDraw = this.plugin.settings.touchDraw === true;
    this.buildHeaderActions();
    // 标题栏放不下十个按钮时（平板常见），下一帧会把整行搬到自建顶栏条
    this.scheduleTopRowFit();
    this.buildFloat();
    this.buildScrollbar();
    this.buildSide();
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
   * 只做一次轻量检查 + 异步写，不阻塞打开；失败由 writeTextIndex 自己弹可见提示。
   */
  private ensureTextIndexIfMissing(): void {
    if (!this.file || !this.store || this.plugin.settings.searchIndex === false) return;
    const book = this.store.data;
    const hasText = book.pages.some((p) =>
      (p?.texts ?? []).some((t) => (t.text || "").trim())
    );
    if (!hasText) return;
    const adapter = this.app.vault.adapter as any;
    if (typeof adapter?.list !== "function") return;
    const dir = indexDirFor(this.file);
    void (async () => {
      try {
        const listed = await adapter.list(dir);
        const files: string[] = listed?.files || [];
        // 有新命名的索引页就算健康；只有旧命名 / 空目录才需要重建
        const hasNew = files.some((p) => {
          const name = String(p).split("/").pop() || "";
          return /^.+ · 第 \d+ 页\.md$/.test(name);
        });
        if (hasNew) return;
        await writeTextIndex(this.app, this.file!, book);
      } catch (_) {
        /* 索引是派生物，打不开就算了，writeTextIndex 自己会兜底 */
      }
    })();
  }

  private destroyEditor(): void {
    this.editor?.destroy();
    this.editor = null;
    this.cancelInkDeferRetry();
    this.inkDeferAt = 0;
    // 顶栏那一行挂在标题栏/自建条上，不跟着 editorHost 走，得单独摘
    this.topRowEl?.remove();
    this.topBarEl?.remove();
    this.topRowEl = null;
    this.topBarEl = null;
    window.clearTimeout(this.hintTimer);
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

  /** 侧栏显隐：仅阅读时一律收起来，把屏幕让给纸 */
  private applySideVisibility(): void {
    const visible = !this.reading && this.sideShown;
    this.sideEl?.toggleClass("is-hidden", !visible);
    /*
     * 展开侧栏（或退出仅阅读）时补建/补画缩略图。
     * 收起状态下不建页列表、不渲染缩略图：857 页的本子光建 DOM 就要几十毫秒，
     * 更贵的是会立刻用 pdf.js 渲 5 页缩略图，和首屏抢同一份 PDF。
     *
     * 顺序：先把页列表窗口按当前滚动位置摆好（display:none 期间量不到尺寸），
     * 再补画缩略图——否则 refreshThumbs 画的还是收起前那批 canvas。
     */
    if (visible) {
      this.updatePageWindow(false);
      this.refreshThumbs();
    }
  }

  /** 缩略图/页列表现在有必要维护吗（侧栏收起或仅阅读时都不必要） */
  private thumbVisible(): boolean {
    return !this.reading && this.sideShown;
  }

  private buildUI(): void {
    const root = this.contentEl;
    this.loadingEl = null;
    root.empty();
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
    const btn = box.createEl("button", { cls: "mod-cta", text: "新建手写本" });
    btn.onclick = () => this.openNewBook();
  }

  private openNewBook(): void {
    new NewBookModal(this.app, this.plugin as any, (file) => {
      this.app.workspace.getLeaf("tab").openFile(file);
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
    this.toolButtons.clear();
    const wrap = row.createDiv("mb-top-tools");
    this.topToolsEl = wrap;
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
      b.onclick = () => this.chooseTool(t.id);
      wrap.appendChild(b);
      this.toolButtons.set(t.id, b);
    }

    /* ---------------------------- 仅阅读提示 ---------------------------- */
    // 自愈重装顶栏时别再挂一条重复的提示
    if (!this.readHintEl || !this.readHintEl.parentElement) {
      this.readHintEl = this.editorHost.createDiv({
        cls: "mb-read-hint",
        text: "仅阅读模式 · 点顶栏的眼睛图标开始书写",
      });
    }
  }

  /**
   * 顶栏上的「当前笔」提示：一枚色点 + 粗细数值。
   *
   * 侧栏收起时（平板默认如此）顶栏只有工具图标亮着，看不出当前是
   * 什么颜色、多粗。这枚 chip 只占 30px 高、约 40px 宽，挂在工具组右侧，
   * 不把顶栏塞满；点它开合侧栏——调参入口也就在手边。
   *
   * 注意：这里只建 DOM，显示内容全交给 updatePenChip（updateUI 里刷新）。
   * 任何「自动展开侧栏」的逻辑都不能跑到 updateUI 里，否则用户手动收起后
   * 落笔 / 翻页又会把它弹回来。
   */
  private buildPenChip(row: HTMLElement): void {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "mb-pen-chip";
    chip.setAttribute("aria-label", "当前笔色 / 粗细");
    const dot = chip.createSpan({ cls: "mb-pen-chip-dot" });
    const size = chip.createSpan({ cls: "mb-pen-chip-size" });
    chip.onclick = () => this.toggleSide();
    row.appendChild(chip);
    this.penChipEl = chip;
    this.penChipDotEl = dot;
    this.penChipSizeEl = size;
    this.updatePenChip();
  }

  /** 当前工具的颜色 / 粗细；text / select / hand 没有笔参数，整枚收起 */
  private updatePenChip(): void {
    const chip = this.penChipEl;
    const dot = this.penChipDotEl;
    const size = this.penChipSizeEl;
    if (!chip || !dot || !size || !this.editor) return;

    const s = this.editor.getState();
    const fmt = (v: number) => String(Math.round(v * 10) / 10);
    let name = "";
    let color = "";
    let text = "";
    if (s.tool === "pen" || s.tool === "ballpoint" || s.tool === "shape") {
      /*
       * 圆珠笔和形状也用 penColor / penSize 落笔（见 editor.onDown 的
       * draft 组装），所以三支共用同一组显示，换哪支都不会读错参数。
       */
      name = s.tool === "ballpoint" ? "圆珠笔" : s.tool === "shape" ? "形状" : "钢笔";
      color = s.penColor;
      text = fmt(s.penSize);
    } else if (s.tool === "highlighter") {
      name = "荧光笔";
      color = s.highlighterColor;
      text = fmt(s.highlighterSize);
    } else if (s.tool === "eraser") {
      name = "橡皮";
      text = (this.editor.eraserMode === "whole" ? "整笔 " : "局部 ") + fmt(this.editor.eraserSize);
    } else {
      chip.toggleClass("is-hidden", true);
      return;
    }

    chip.toggleClass("is-hidden", false);
    dot.style.background = color;
    dot.toggleClass("is-eraser", !color);
    size.setText(text);
    chip.title = color
      ? `当前：${name} · ${color} · 粗细 ${text}（点按展开侧栏调参）`
      : `当前：${name} · ${text}（点按展开侧栏调参）`;
    chip.setAttribute("aria-label", chip.title);
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
    // 仅阅读时纸面优先；侧栏已经开着也不用动
    if (this.reading || this.sideShown) return;
    this.sideShown = true;
    this.applySideVisibility();
    this.updateUI();
  }

  /* --------------------------- 顶栏上的那一行 --------------------------- */

  /**
   * 顶栏那一行：**7 支笔 + 保存 / 侧栏 / 仅阅读**，一起挂到标题栏。
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

    const read = mk("eye", "仅阅读模式", "mb-rail-read");
    read.setAttr("aria-pressed", "false");
    read.onclick = () => this.setReading(!this.reading);
    this.railReadBtn = read;

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
    this.buildToolRow(row);
    // 当前笔色 / 粗细：紧挨着工具组，不占额外一整排
    this.buildPenChip(row);
    row.appendChild(row.createDiv("mb-sep"));
    row.appendChild(save);
    row.appendChild(side);
    row.appendChild(read);
    this.topRowEl = row;
  }

  /* ------------------ 标题栏放不下时：整行搬到自建顶栏条 ------------------ */

  private topFitRaf = 0;

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
      if (st) this.editor?.goToPage(Math.max(0, st.pageIndex - 1));
    };
    this.pageLbl = nav.createEl("button", {
      cls: "mb-float-num",
      attr: { "aria-label": "跳到指定页" },
    });
    this.pageLbl.title = "跳到指定页";
    this.pageLbl.onclick = () => {
      if (!this.editor) return;
      const st = this.editor.getState();
      new JumpPageModal(this.app, st.pageCount, st.pageIndex, (i) =>
        this.editor?.goToPage(i)
      ).open();
    };
    const next = nav.createEl("button", {
      cls: "mb-float-btn",
      attr: { "aria-label": "下一页" },
    });
    setIcon(next, "chevron-right");
    next.title = "下一页";
    next.onclick = () => {
      const st = this.editor?.getState();
      if (st) this.editor?.goToPage(Math.min(st.pageCount - 1, st.pageIndex + 1));
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
    this.sideShown = !this.sideShown;
    this.plugin.settings.sidebarOpen = this.sideShown;
    void this.plugin.saveSettings();
    this.applySideVisibility();
    this.updateUI();
  }

  /**
   * 切换仅阅读模式。
   *
   * 进去以后：长条淡出、编辑器拒绝落笔，
   * 但翻页、缩放、滚动照常——「看」笔记不该被「写」的能力打扰。
   */
  private setReading(on: boolean): void {
    /*
     * 只读恢复态（readOnly）是"不能保存"的硬约束。
     *
     * 在这里直接放开编辑器 = 让用户写字、却永远存不下去：saveNow 会因
     * readOnly 早退，状态栏停在"未保存"，切走就全丢。
     * 所以编辑器是否可写由 reading || readOnly 共同决定。
     */
    this.reading = on;
    this.contentEl.toggleClass("is-reading", on);
    this.applyEditorReadOnly();
    this.applySideVisibility();

    if (this.railReadBtn) {
      this.railReadBtn.classList.toggle("is-active", on);
      this.railReadBtn.setAttribute("aria-pressed", String(on));
      this.railReadBtn.setAttribute(
        "aria-label",
        on ? "退出仅阅读模式" : "进入仅阅读模式"
      );
      this.railReadBtn.title = on ? "退出仅阅读模式 · 开始书写" : "仅阅读模式";
    }
    this.showReadHint(on);
    // 想退出仅阅读却被 readOnly 卡住时说清原因，否则像是"按钮坏了"
    if (!on && this.readOnly) this.warnReadOnly();
  }

  /**
   * 编辑器是否可写：仅阅读 或 只读恢复态，任一成立就不能落笔。
   */
  private applyEditorReadOnly(): void {
    this.editor?.setReadOnly(this.reading || this.readOnly);
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
    const msg = this.recoveredCopyName
      ? "这是只读状态（从备份恢复或原文件不可写），改动不会保存。已另存为 recovered 副本，请改用那份。"
      : "这是只读状态（从备份恢复或原文件不可写），改动不会保存。要接着写，请把同目录的 .bak 复制一份并改名。";
    new Notice(msg, 8000);
  }


  /** 仅阅读提示：浮出来几秒再自己消失，不打扰 */
  private showReadHint(show: boolean): void {
    window.clearTimeout(this.hintTimer);
    this.readHintEl?.toggleClass("is-show", show);
    if (show) {
      this.hintTimer = window.setTimeout(() => {
        this.readHintEl?.removeClass("is-show");
      }, 4200);
    }
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

  private renderDynamicTools(): void {
    if (!this.editor) return;
    const s = this.editor.getState();
    if (!this.dynEl) {
      // 侧栏里的"当前工具"区，随工具变化重建
      const sec = this.sideEl?.querySelector(".mb-sec-dyn");
      if (!sec) return;
      this.dynEl = sec.createDiv("mb-dyn");
    }
    this.dynEl.empty();

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
        // 橡皮大小是直接改字段（不发 state），顶栏 chip 手动跟一下
        this.updatePenChip();
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
        cls: "mb-font-sel",
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
        bindHoldStepBtn(step, () => {
          // 每步走 editor 内的 clamp（8~96），不绕过 setTextSize
          this.editor?.stepTextSize(d);
        });
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
      return;
    }
    if (s.tool === "select") {
      this.dynEl.createSpan({
        cls: "mb-hint",
        text: "点文字选中后可拖动；双击改内容，Delete 删除",
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
    }

    const hl = s.tool === "highlighter";
    const v = hl ? s.highlighterSize : s.penSize;
    const min = hl ? 4 : 1;
    const max = hl ? 40 : 8;
    const range = this.dynEl.createEl("input", {
      cls: "mb-range",
      attr: { type: "range", min: String(min), max: String(max), step: "0.1", value: String(v) },
    });
    const lbl = this.dynEl.createSpan({
      cls: "mb-size-lbl",
      text: String(Math.round(v * 10) / 10),
    });
    range.oninput = () => {
      if (!this.editor) return;
      if (hl) this.editor.setHighlighterSize(Number(range.value), true);
      else this.editor.setPenSize(Number(range.value), true);
      lbl.setText(String(Math.round(Number(range.value) * 10) / 10));
    };
    // 拖滑杆也是一次明确的粗细选择：松手（change）时写回设置。
    // 不在 input 里写盘，避免拖一次滑块就 saveData 几十次。
    range.onchange = () => {
      if (!this.editor) return;
      const size = Number(range.value);
      if (hl) this.plugin.settings.defaultHighlighterSize = size;
      else this.plugin.settings.defaultPenSize = size;
      void this.plugin.saveSettings();
    };
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
   * 导入流程：选源文档 → 选页码范围 → 导入 → 插入。
   *
   * PDF 是按需渲染的，所以导入只是建立页码映射——瞬时完成。
   * 真正的渲染推迟到翻到那一页时，不会卡住界面。
   */
  private async runImport(kind: "pdf" | "word", file: TFile): Promise<void> {
    if (!this.store || !this.file) return;
    const notice = new Notice(
      kind === "pdf" ? "正在读取 PDF…" : "正在解析 Word…",
      0
    );
    try {
      const bookPath = this.file.path;
      const result =
        kind === "pdf"
          ? await importPdf(this.app, file, bookPath, 0, (done, total) => {
              notice.setMessage(`正在读取 PDF：${done}/${total} 页`);
            })
          : await importWord(this.app, file, bookPath, (done, total) => {
              notice.setMessage(`正在生成页面：${done}/${total} 页`);
            });

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
      new Notice("导入失败：" + (e && e.message ? e.message : e), 8000);
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
        .setIcon("file-text")
        .onClick(() => this.runExport("pdf"))
    );
    menu.addItem((item) =>
      item
        .setTitle("导出指定页 PDF…")
        .setIcon("file-text")
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
    menu.showAtMouseEvent(e);
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
        new Notice("导出失败：" + (e && e.message ? e.message : e || "未知错误"), 8000);
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
  private buildSide(): void {
    if (!this.store || !this.editor) return;
    const side = this.sideEl;
    side.empty();
    side.id = "mb-side";
    const head = side.createDiv("mb-side-head");
    const headText = head.createDiv("mb-side-headtext");
    headText.createDiv({ cls: "mb-side-title", text: this.file ? this.file.basename : "手写本" });
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
    // 页列表的窗口随这个滚动容器移动；侧栏尺寸/断点变化也要重算行高
    this.attachPageListScroll(body);

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
    const impBtn = actRow.createEl("button", {
      cls: "mb-ib",
      attr: { "aria-label": "导入 PDF / Word" },
    });
    impBtn.title = "导入 PDF / Word，在上面手写批注";
    setIcon(impBtn, "import");
    impBtn.onclick = (e) => this.showImportMenu(e);
    const expBtn = actRow.createEl("button", {
      cls: "mb-ib",
      attr: { "aria-label": "导出" },
    });
    expBtn.title = "导出 PNG / PDF";
    setIcon(expBtn, "download");
    expBtn.onclick = (e) => this.showExportMenu(e);

    /* ---------------------------- 笔盒 ---------------------------- */
    const penSec = body.createDiv("mb-sec");
    penSec.createDiv({ cls: "mb-sec-title", text: "笔盒" });
    const penRow = penSec.createDiv("mb-pen-row");
    for (const c of PEN_COLORS) {
      const b = penRow.createDiv("mb-swatch");
      b.style.background = c;
      b.dataset.color = c;
      b.dataset.kind = "pen";
      b.title = "钢笔 / 圆珠笔颜色";
      /*
       * 只改颜色，**不切工具**。
       *
       * 以前这里第一句是 setTool("pen")：圆珠笔用户点一下色板，
       * 手里的笔就被悄悄换回钢笔了。钢笔和圆珠笔共用 penColor，
       * 这排色板本来就该作用于「当前那支笔」，而不是替用户选笔。
       */
      b.onclick = () => {
        this.editor?.setPenColor(c);
        this.plugin.settings.lastPenColor = c;
        void this.plugin.saveSettings();
        this.updateUI();
      };
    }
    const penSizes = penSec.createDiv("mb-size-row");
    penSizes.createSpan({ cls: "mb-row-label", text: "钢笔" });
    for (let i = 0; i < PEN_SIZES.length; i++) {
      const b = penSizes.createEl("button", {
        // 当前粗细要看得见：以前粗细按钮没有选中态，选了「粗」也不知道现在多粗
        cls:
          "mb-size-btn" +
          (Math.abs(this.editor.penSize - PEN_SIZES[i]) < 0.01 ? " is-active" : ""),
        text: ["细", "中", "粗"][i],
        attr: { "data-size": String(PEN_SIZES[i]) },
      });
      /*
       * 同色板：只调粗细，不切工具。penSize 是钢笔 / 圆珠笔 / 形状
       * 三者共用的落笔参数（见 editor.onDown），切到钢笔会让正在画的
       * 形状或圆珠笔断掉，也是同一种「偷切工具」。
       */
      b.onclick = () => {
        this.editor?.setPenSize(PEN_SIZES[i]);
        // 粗细要跟着用户走：重启后 mountEditor 读的是 settings.defaultPenSize
        this.plugin.settings.defaultPenSize = PEN_SIZES[i];
        void this.plugin.saveSettings();
        this.updateUI();
      };
    }
    const hlRow = penSec.createDiv("mb-pen-row");
    for (const c of HIGHLIGHTER_PALETTE) {
      const b = hlRow.createDiv("mb-swatch mb-swatch-hl");
      b.style.background = c;
      b.dataset.color = c;
      b.dataset.kind = "hl";
      b.title = "荧光笔颜色";
      b.onclick = () => {
        this.editor?.setTool("highlighter");
        this.editor?.setHighlighterColor(c);
        this.plugin.settings.lastHighlighterColor = c;
        void this.plugin.saveSettings();
        this.updateUI();
      };
    }
    const hlSizes = penSec.createDiv("mb-size-row");
    hlSizes.createSpan({ cls: "mb-row-label", text: "荧光" });
    for (let i = 0; i < HIGHLIGHTER_SIZES.length; i++) {
      const b = hlSizes.createEl("button", {
        // 与钢笔同理：当前粗细要有选中态
        cls:
          "mb-size-btn" +
          (Math.abs(this.editor.highlighterSize - HIGHLIGHTER_SIZES[i]) < 0.01
            ? " is-active"
            : ""),
        text: ["细", "中", "粗"][i],
        attr: { "data-size": String(HIGHLIGHTER_SIZES[i]) },
      });
      b.onclick = () => {
        this.editor?.setTool("highlighter");
        this.editor?.setHighlighterSize(HIGHLIGHTER_SIZES[i]);
        // 与钢笔同理：粗细选择写回设置，重启后仍生效
        this.plugin.settings.defaultHighlighterSize = HIGHLIGHTER_SIZES[i];
        void this.plugin.saveSettings();
        this.updateUI();
      };
    }

    /* ---------------------------- 当前工具 ---------------------------- */
    /*
     * 这一区随当前工具变化：橡皮出整笔/局部，形状出形状选择，
     * 钢笔/荧光笔出粗细滑杆。放在笔盒正下方，
     * 换工具时下面的控件跟着换，不用另开面板。
     */
    const dynSec = body.createDiv("mb-sec mb-sec-dyn");
    this.dynEl = dynSec.createDiv("mb-dyn");

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
       * 打开「手指书写」时，必须把另外两个会**抵消它**的状态一起处理掉。
       *
       * 真机反馈：「点了允许手指写字，还是没法用手指写字，只能用手写笔」——
       * 因为这两个开关各管一段，任何一个开着都写不出来：
       *   · 仅阅读模式：编辑器整个拒绝落笔（pointer 在 readOnly 分支就被拦了）
       *   · 只认触控笔：touch 一落下就判成 pan，连落笔分支都进不去
       * 用户点的是「让我用手指写」，那就该真的能写，别让他自己去猜还有哪个开关。
       */
      if (this.readOnly) {
        this.warnReadOnly();
        return;
      }
      const undone: string[] = [];
      if (this.reading) {
        this.setReading(false);
        undone.push("已退出仅阅读模式");
      }
      if (this.plugin.settings.penOnly) {
        this.plugin.settings.penOnly = false;
        void this.plugin.saveSettings();
        this.editor?.setPenOnly(false);
        undone.push("已关闭「只认触控笔」");
      }
      this.editor?.setTouchDraw(true);
      // 写回 settings：以前只在编辑器实例上置位，重启就复位了
      this.plugin.settings.touchDraw = true;
      void this.plugin.saveSettings();
      this.updateUI();
      new Notice(
        (undone.length ? "已允许手指书写（" + undone.join("，") + "）。" : "已允许手指书写。") +
          "此时单指用来写字，滚动请用双指或右缘滑条。",
        3600
      );
    };
    this.stylusBtn = inputRow.createEl("button", {
      cls: "mb-ib",
      attr: { "aria-label": "只认触控笔 (I)" },
    });
    this.stylusBtn.title = "只认触控笔：手指只滚动，掌根不落笔 (I)";
    setIcon(this.stylusBtn, "tablet");
    this.stylusBtn.onclick = () => {
      const on = !this.plugin.settings.penOnly;
      this.plugin.settings.penOnly = on;
      void this.plugin.saveSettings();
      this.editor?.setPenOnly(on);
      this.updateUI();
      // 打开"只认触控笔"等于把手指书写暂停掉，说清楚，否则用户会以为书写坏了
      new Notice(
        on
          ? this.editor?.touchDraw
            ? "只认触控笔：手指只滚动（手指书写已暂停）"
            : "只认触控笔：手指只滚动"
          : "手指和鼠标也能写",
        2600
      );
    };

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

    /* ---------------------------- 目录 ---------------------------- */
    /*
     * 目录放在「页面」区**上方**——目录比缩略图常用（它是用户自己写的
     * 路标，翻本子时第一眼看的就是它），缩略图区有几百上千格，
     * 放上面会把路标挤到屏幕外。
     */
    const outSec = body.createDiv("mb-sec mb-sec-outline");
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
    /* ---------------------------- 页面 ---------------------------- */
    const pageSec = body.createDiv("mb-sec");
    const pageHead = pageSec.createDiv("mb-sec-head");
    pageHead.createDiv({ cls: "mb-sec-title", text: "页面" });
    const addPage = pageHead.createEl("button", { cls: "mb-link", text: "+ 加一页" });
    addPage.onclick = () => this.editor?.addPage();
    this.pageListEl = pageSec.createDiv("mb-pages");
    // 侧栏收起时先不建：857 页 × (缩略图 + 画布) 没必要在打开文件时付
    if (this.thumbVisible()) this.renderPageList();

    this.statsEl = body.createDiv("mb-stats");

    /* ---------------------------- 底部导出 ---------------------------- */
    const foot = side.createDiv("mb-side-foot");
    const b1 = foot.createEl("button", { cls: "mb-foot-btn", text: "导出 PDF" });
    b1.onclick = () => this.runExport("pdf");
    const b2 = foot.createEl("button", { cls: "mb-foot-btn", text: "导出本页 PNG" });
    b2.onclick = () => this.runExport("png");

    this.statusEl = side.createDiv("mb-status mb-side-status");
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
      p.layers
        .map((l) => `${l.id}:${l.name}:${l.visible}:${l.strokes.length}:${l.opacity}`)
        .join(",")
    );
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
     */
    if (!this.outlineRowH) {
      const probe = list.createDiv("mb-outline");
      this.outlineRowH = probe.getBoundingClientRect().height || OUTLINE_ROW_H;
      probe.remove();
    }
    const rowH = this.outlineRowH;
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
    const current = this.store.data.activePage;
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
    const current = this.store?.data.activePage ?? 0;
    let prev: Element | null = topPad;
    for (let i = firstCell; i < lastCell; i += 1) {
      if (i < count) {
        let item = this.thumbItems.get(i);
        if (!item) {
          const pooled = this.thumbItemPool.get(i);
          if (pooled) {
            this.thumbItemPool.delete(i);
            item = pooled;
            // 躺在池里的这段时间当前页可能变了；把高亮和长按标记刷正
            item.classList.toggle("is-active", i === current);
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

  private createThumbItem(index: number, active: boolean): HTMLElement {
    const item = document.createElement("div");
    item.className = "mb-thumb" + (active ? " is-active" : "");
    item.dataset.page = String(index);
    /*
     * 页 id 一起写进 dataset：条目会在回收池里进出，页数/页序变化时整窗重置，
     * 长按菜单的动作必须按 id 回查当前下标，闭包里的 index 可能过期。
     */
    item.dataset.pageId = this.store?.data.pages[index]?.id ?? "";
    item.title = "长按可上移 / 下移";
    const cv = document.createElement("canvas");
    cv.className = "mb-thumb-canvas";
    item.appendChild(cv);
    item.createDiv({ cls: "mb-thumb-num", text: String(index + 1) });
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
        this.editor?.deletePage(index);
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
   * 等条目被物化时 createThumbItem 会按 store.data.activePage 补上 is-active。
   */
  private setActiveThumb(index: number): void {
    const next = (this.thumbCanvases.get(index)?.parentElement as HTMLElement | undefined) ?? null;
    if (next === this.activeThumbEl) return;
    this.activeThumbEl?.classList.remove("is-active");
    next?.classList.add("is-active");
    this.activeThumbEl = next;
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
  private attachPageListScroll(body: HTMLElement): void {
    this.pageListAbort?.abort();
    this.pageListResizeObs?.disconnect();
    const ac = new AbortController();
    this.pageListAbort = ac;
    this.pageListViewportEl = body;
    body.addEventListener("scroll", () => this.schedulePageWindowUpdate(), {
      passive: true,
      signal: ac.signal,
    });
    /*
     * 侧栏宽度在三种断点（258 / 280 / 340）之间变化时，网格列宽和行高都变；
     * 视口高度变化也会改变「可视几行」。两者都只能重算窗口。
     * 只观察滚动容器本身：观察列表会被我们自己的 spacer 改高反馈成循环。
     */
    if (typeof ResizeObserver !== "undefined") {
      this.pageListResizeObs = new ResizeObserver(() => this.schedulePageWindowUpdate());
      this.pageListResizeObs.observe(body);
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
     * 侧栏收起 / 仅阅读：页列表和缩略图都看不见，什么活都不用干。
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
    const current = this.store.data.activePage;
    this.drawThumbRange(current, 2);
    this.setActiveThumb(current);
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

    this.syncPenSizeButtons();

    if (this.pageLbl) this.pageLbl.setText(`${s.pageIndex + 1} / ${s.pageCount}`);
    if (this.sbTip) this.sbTip.setText(`${s.pageIndex + 1} / ${s.pageCount}`);
    // 页数变了滑条的高度比例也变了；合并到一帧里算，别每笔都量一遍
    this.requestScrollbarSync();
    // 宿主重建标题栏时会把我们那一行一起清掉，发现掉了就重装
    if (this.topRowEl && !this.topRowEl.parentElement) this.buildHeaderActions();
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
    if (this.stylusBtn) this.stylusBtn.toggleClass("is-active", s.penOnly);
    if (this.touchBtn) this.touchBtn.toggleClass("is-active", !!this.editor?.touchDraw);
    if (this.sideBtn) this.sideBtn.toggleClass("is-active", this.sideShown);
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

    // 顶栏「当前笔」提示：色点 + 粗细。纯显示，放 updateUI 不会弹侧栏
    this.updatePenChip();
    this.renderColors();
    this.renderDynamicTools();

    if (this.layerSig !== this.layerSignature()) this.renderLayers();
    /*
     * 目录区：只在内容真的变了才重建（store.outlineRev）。
     * 落笔时 updateUI 会跑几十次，目录不变 → 一次 DOM 都不动。
     */
    this.renderOutlines();
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
    this.updateUI();
    this.thumbDebounce();
  }

  private markDirty(): void {
    this.dirty = true;
    this.dirtyEpoch += 1;
    this.saveState = "dirty";
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
    if (this.dirty && this.plugin.settings.autosave) this.saveDebounce();
  }

  /** 硬上限到点后来敲门：不 busy 了就正常存，还 busy 就让 saveNow 强制存 */
  private armInkDeferRetry(delayMs: number): void {
    this.cancelInkDeferRetry();
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
      new Notice("当前处于冲突状态，未写入原文件。请先处理冲突副本。", 8000);
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
    } else {
      this.pendingPage = idx;
      this.pendingPageHint = hint;
    }
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
    const path = this.file.path;
    try {
      if (this.editor) this.store.data.activePage = this.editor.getState().pageIndex;

      // 写之前先看磁盘上的文件有没有被别处改过（同步、别的窗口、外部编辑器）
      const now = await fingerprint(adapter, path);
      if (this.fp && now && (now.mtime !== this.fp.mtime || now.size !== this.fp.size)) {
        await this.saveConflictCopies(adapter, path);
        this.conflict = true;
        this.saveState = "dirty";
        new Notice(
          "检测到文件已被外部修改，已另存为两份副本，本次未覆盖原文件。请手动检查后选择保留哪一份。",
          15000
        );
        return;
      }

      /*
       * 记下代次再进 writeBook：它一进去就 stringify，之后备份 / tmp 写入
       * 都在 await——那段时间用户再落的笔**不在这一版 JSON 里**。
       * 存完对比代次，变了就保留 dirty 并再排一次，不能把「已保存」当终点。
       */
      const dirtyEpoch = this.dirtyEpoch;
      const metaEpoch = this.metaEpoch;
      await writeBook(adapter, path, this.store.data);
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
        this.savedActivePage = this.store.data.activePage;
      }
      this.fp = await fingerprint(adapter, path);
      /*
       * 本子落盘之后再更新文字索引：索引是派生物，
       * 万一它写失败，不能反过来把「本子已保存」报成失败。
       */
      this.scheduleTextIndex();
    } catch (e: any) {
      console.error("[inkbook] 保存失败", e);
      this.saveState = "dirty";
      new Notice("保存失败：" + (e && e.message ? e.message : e), 8000);
    } finally {
      this.saving = false;
      this.updateStatus();
      if (this.saveAgain) {
        this.saveAgain = false;
        this.saveDebounce();
      }
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
    path: string
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
    const mine = this.store ? this.store.data : null;
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
    const base = this.file.path.replace(/\.inkbook$/i, "");
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

  async flushSave(): Promise<void> {
    /*
     * 编辑框里没按回车、也没失焦的文字先落库：切文件（onLoadFile /
     * onUnloadFile）、关标签页（onClose）都从这条路过。移动端 textarea
     * 自带的 blur 兜底不可靠（点别处 / 切后台未必触发），不在这里主动
     * 提交就会整段丢字。force：等不到 compositionend，组字中只写已上屏部分。
     */
    this.editor?.commitTextEditNow(true);
    this.saveDebounce.cancel();
    /*
     * 显式落盘路径，**不避让书写**：切后台 / 关文件 / 切文件时，
     * 正在写的那一笔会先由 `finishInkGesture()` 收尾提交（见 visibilitychange
     * 处理器），这里负责把已提交的内容一条不落地写下去。
     * 即便 gesture 仍是 "draw"（收尾失败等异常情况），也照样 saveNow——
     * 已提交的笔迹一条都不能少。
     */
    if (this.dirty || this.metaDirty) await this.saveNow();
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
  }

  /* ------------------------------- 快捷键 ------------------------------- */

  private onKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
    if (target && target.isContentEditable) return;
    if (this.app.workspace.getActiveViewOfType(InkbookView) !== this) return;
    if (!this.editor) return;

    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      this.saveNow();
      return;
    }
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) this.editor.redo();
      else this.editor.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      this.editor.redo();
      return;
    }
    if (mod || e.altKey) return;

    const k = e.key.toLowerCase();
    if ((e.key === "Delete" || e.key === "Backspace") && this.editor.selectedText) {
      e.preventDefault();
      this.editor.deleteSelectedText();
      return;
    }
    if (e.key === "Escape") {
      // 有选中的文字：先取消选中，别一下子跳到"切换仅阅读"
      if (this.editor.selectedText) {
        this.editor.selectText(null);
        return;
      }
      // 逐级退出：收起侧栏 → 最后切仅阅读
      if (this.sideShown) {
        this.toggleSide();
      } else {
        this.setReading(!this.reading);
      }
      return;
    }
    /*
     * 键盘切工具也走 chooseTool：和点顶栏是同一种「用户动作入口」。
     * 这样按 E / R 切到橡皮 / 形状时同样会展开侧栏（参数只住在那里），
     * 而按 P / B / H 不会——展开策略只维护一处。
     */
    if (k === "p") this.chooseTool("pen");
    else if (k === "b") this.chooseTool("ballpoint");
    else if (k === "h") this.chooseTool("highlighter");
    else if (k === "e") this.chooseTool("eraser");
    else if (k === "v") this.chooseTool("select");
    else if (k === "r") this.chooseTool("shape");
    else if (k === "t") this.chooseTool("text");
    else if (k === "i") {
      const on = !this.plugin.settings.penOnly;
      this.plugin.settings.penOnly = on;
      this.plugin.saveSettings();
      this.editor.setPenOnly(on);
      this.updateUI();
      new Notice(on ? "只认触控笔：手指只滚动" : "手指和鼠标也能写", 2500);
    } else if (k === "0") this.editor.fit();
    else if (k === "+" || k === "=") this.editor.zoomBy(1.15);
    else if (k === "-") this.editor.zoomBy(1 / 1.15);
  }

  syncSettings(): void {
    if (!this.editor) return;
    this.editor.setPenOnly(!!this.plugin.settings.penOnly);
    // 设置页现在也能改「允许手指书写」：同步到已打开的视图，
    // 不能让设置页里改完、当前笔记还是老样子。
    this.editor.setTouchDraw(this.plugin.settings.touchDraw === true);
    this.editor.setPressure(this.plugin.settings.pressure);
    this.editor.setSmoothing(this.plugin.settings.smoothing ?? 0.55);
    this.editor.setPrediction(this.plugin.settings.prediction !== false);
    this.editor.setEdgeSwipeBlock(this.plugin.settings.blockEdgeSwipe !== false);
    this.editor.setStraighten(this.plugin.settings.straightLine === true);
    this.editor.penSize = this.plugin.settings.defaultPenSize;
    // 设置页里的「上次用的笔色 / 荧光色 / 荧光粗细」改完立即生效
    this.editor.penColor = this.plugin.settings.lastPenColor || "#1A1A1A";
    this.editor.highlighterColor = this.plugin.settings.lastHighlighterColor || "#F6E05E";
    this.editor.highlighterSize = this.plugin.settings.defaultHighlighterSize || 24;
    this.updateUI();
  }
}
