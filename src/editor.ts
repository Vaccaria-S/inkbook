import {
  activeLayer,
  PEN_COLORS,
  type Page,
  type PageBackground,
  type PageText,
  type PaperId,
  type Pt,
  type ShapeKind,
  type Stroke,
  type TemplateId,
  type ToolId,
  uid,
} from "./types";
import { BookStore, type HistoryEntry } from "./store";
import { drawStroke, invalidateStroke, predictTail } from "./ink";
import { OneEuroFilter, shapePressure, speedWidthFactor } from "./filter";
import { TouchArbiter, type PinchInfo, type PointerInfo, type TouchRole } from "./touch";
import { drawPaper, paperBackground } from "./paper";
import { BitmapCache } from "./cache";
import { extractPdfText, openPdf, pdfPageSize, renderPdfPage, type PdfDoc } from "./pdf";
import {
  clamp,
  splitStrokeByEraser,
  straightenPoints,
  strokeBounds,
  strokeHit,
} from "./geometry";
import {
  availableTextWidth,
  layoutUserText,
  maxTextStartX,
  TEXT_LINE_HEIGHT,
  type TextLayout,
} from "./textwrap";

export interface EditorState {
  pageIndex: number;
  pageCount: number;
  zoom: number;
  tool: ToolId;
  penColor: string;
  penSize: number;
  highlighterColor: string;
  highlighterSize: number;
  shapeKind: ShapeKind;
  /** 新建文字用的字号 / 字体 / 颜色 */
  textSize: number;
  textFont: string;
  textColor: string;
  /** 当前选中的文字对象；null = 没选中 */
  textSelected: {
    id: string;
    text: string;
    size: number;
    font: string;
    color: string;
  } | null;
  canUndo: boolean;
  canRedo: boolean;
  penOnly: boolean;
  activeLayerId: string;
  layers: Array<{ id: string; name: string; visible: boolean; count: number }>;
}

/**
 * 缩放锚点：光标指向的那个**内容点**。
 *
 * 用「第几页 + 页内相对位置（0..1）」表示，而不是屏幕坐标。
 *
 * 为什么不用屏幕坐标：屏幕坐标会随滚动变化，连续缩放时反推回去
 * 会把上一轮的亚像素量化误差带进下一轮，越滚越偏。
 *
 * 为什么不用「绝对文档坐标」（页序号 × 页高 + 页内偏移）：
 * 那种算法依赖页间距这个**测量值**，而 offsetTop 是整数——
 * 0.24px 的误差乘以页序号，到第 100 页就是 24px，整整一页。
 * 「哪一页 + 页内比例」不含任何测量误差，缩放前后严格稳定。
 */
interface ZoomAnchor {
  /** 第几页 */
  index: number;
  /** 页内横向相对位置 0..1 */
  fx: number;
  /** 页内纵向相对位置 0..1 */
  fy: number;
}

interface PageRec {
  index: number;
  wrap: HTMLElement;
  pageEl: HTMLElement;
  canvas: HTMLCanvasElement | null;
  /** 文字层：PDF 原文（透明）+ 手动添加的文字 */
  textLayer: HTMLElement | null;
  overlay: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  octx: CanvasRenderingContext2D | null;
  mounted: boolean;
  /**
   * IO 最近一次回调的 isIntersecting：
   * true = 在预挂范围内（含视口外的 600px 边距）。
   *
   * 这个字段只由 IO 回调写，mount()/unmount() 都不许碰它——
   * 它记的是「IO 怎么判的」，不是「现在挂没挂」。
   * enforceMountLimit() 靠它一票否决：范围内的页绝不卸。
   */
  ioVisible: boolean;
}

type Gesture = "none" | "draw" | "shape" | "erase" | "pan" | "moveText";

/**
 * 文字可用字体。
 *
 * 只用系统自带字体，不打包（打包中文字体动辄几 MB，自用不值）。
 * 屏幕渲染、编辑框、导出画布三处都走 `textFontStack()`，
 * 否则「编辑时是这个宽度、存下来变另一个宽度」。
 *
 * id 会写进文件，所以别随便改名；新增可以，老 id 要留着。
 */
export const TEXT_FONTS: Array<{ id: string; label: string; stack: string }> = [
  {
    id: "sans",
    label: "黑体",
    stack:
      '-apple-system, BlinkMacSystemFont, "Noto Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif',
  },
  {
    id: "serif",
    label: "宋体",
    stack: '"Songti SC", "Noto Serif SC", "Source Han Serif SC", "SimSun", serif',
  },
  {
    id: "kai",
    label: "楷体",
    stack: '"Kaiti SC", "STKaiti", "KaiTi", "Noto Serif SC", serif',
  },
  {
    id: "mono",
    label: "等宽",
    stack: 'ui-monospace, SFMono-Regular, "Cascadia Code", Consolas, "Courier New", monospace',
  },
];

/** 字体 id → CSS font-family；未知 id 落回黑体 */
export function textFontStack(id?: string): string {
  const hit = TEXT_FONTS.find((f) => f.id === id);
  return (hit || TEXT_FONTS[0]).stack;
}

/** 兼容旧代码里的单字体引用（PDF 原文也用黑体） */
const TEXT_FONT = TEXT_FONTS[0].stack;

/**
 * 新建批注的编辑框宽度（页面坐标）。
 *
 * 太窄了打字体验很差（一上来就折行），太宽了又会顶到纸边，
 * 所以取「可用宽度」和这个值里的小者。
 */
const TEXT_EDIT_WIDTH = 320;

/** 编辑框的左右内边距 + 边框（CSS px）：算 width 时要补上，否则折行位置比渲染早一步 */
const TEXT_EDIT_CHROME = 10;

/**
 * 量文字宽度用的离屏 canvas。
 *
 * 整个模块复用一块：measureTextWidth 会被命中判定、选中框、属性条
 * 反复调用，每次 new 一块 canvas 比测量本身贵两个数量级。
 * ctx.font 只在字体串变化时才重设——赋值会让浏览器重新解析整条字体栈。
 */
let measureCanvas: HTMLCanvasElement | null = null;
let measureCtx: CanvasRenderingContext2D | null = null;
let measureFontKey = "";

/** 拿到按 font 配好的测量 ctx；环境不支持 canvas 时返回 null（调用方退回估算） */
function measureContext(font: string): CanvasRenderingContext2D | null {
  if (!measureCanvas) {
    measureCanvas = document.createElement("canvas");
    measureCanvas.width = 8;
    measureCanvas.height = 8;
    measureCtx = measureCanvas.getContext("2d");
  }
  if (!measureCtx) return null;
  if (measureFontKey !== font) {
    measureCtx.font = font;
    measureFontKey = font;
  }
  return measureCtx;
}

/**
 * 单张画布允许的最大像素数。
 *
 * 每页有两块画布（底图层 + 笔迹层），各自都是
 * `794×zoom×dpr` × `1123×zoom×dpr`。
 * 在 2.8 倍缩放 + 2x 屏上，这是 5558×7861 = 4370 万像素，
 * 单块就是 175MB——两页就能把平板的内存吃光。
 *
 * 所以要给 dpr 封顶：像素预算不够时自动降采样，
 * 保证「总内存」而不是「缩放倍数」优先。
 *
 * ⚠️ 单块上限保持不变：降到 8M 会让 2.8 倍下 dpr 从 1.51 掉到 1.07
 * （2 倍屏上等于 1.87 倍拉伸），中文小字会糊成一片——这是被产品明确
 * 否决过的方案。内存的乘数是「同时挂几页」，不是单块上限。
 * 真正的解是 P3 的 tile 渲染（只画视口内那几块瓦片，分辨率与缩放解耦），
 * 届时才动这里。
 */
const MAX_CANVAS_PIXELS = 16_000_000;

/** 导出的底图位图宽度上限（设备像素） */
const MAX_EXPORT_PX = 4096;

/**
 * 同时挂载的所有画布总字节预算（不含 PDF 位图缓存）。
 *
 * 这是**软目标**，不是硬上界：实际挂载量会被 MIN_MOUNTED 抬到 2 页
 * （2.8 倍时 2×122 = 244MB）。预算真正的作用是削掉低倍率下的多余挂载
 * ——0.8 倍时一页才 17MB，不按字节算的话光看页数会挂满 12 页。
 *
 * 为什么不用它压死高倍率：高倍率下真正致命的不是内存超一点，
 * 而是「当前页没有画布」——那是一片永久空白（见 MIN_MOUNTED）。
 */
const MOUNT_BUDGET_BYTES = 160 * 1024 * 1024;

/**
 * 页数硬上限：低倍率下页很小，光看字节会挂太多页——
 * 几十个 canvas 元素本身就够拖慢合成，跟每块多小无关。
 */
const MAX_MOUNTED = 8;

/**
 * 页数下限 2：当前页 + 一页预挂。
 *
 * 2.8 倍时预算只够 1 页，但绝不能把邻页卸掉——卸了滚过去就是整页空白：
 * IntersectionObserver 只在**跨越交叉阈值**时回调，邻页是「已进视口、
 * 又在本回调里被卸掉」，状态没变化，IO 不会再触发第二次；
 * 而 updateCurrentFromScroll() 只改 current 不挂画布。
 * 结果就是滚到那页时 current 变了、画布却没有，一直白到你滚出去再滚回来。
 * 所以宁可超预算，也不留这个空洞。
 */
const MIN_MOUNTED = 2;

export interface EditorOptions {
  app?: unknown;
  penOnly?: boolean;
  pressure?: number;
  /** 输入平滑强度 0–1，越大越稳、跟手性略降 */
  smoothing?: number;
  /** 笔画预测：墨迹跑在笔尖前面 */
  prediction?: boolean;
  /**
   * 是否屏蔽「从纸张左缘右滑」这个宿主手势。
   *
   * 默认 true；关掉后左缘右滑交还给宿主（用于打开文件列表）。
   */
  edgeSwipeBlock?: boolean;
  /**
   * 画完自动把「看起来是直线」的笔迹拉直。
   *
   * 只对自由笔迹生效（荧光笔、圆珠笔、钢笔），不碰形状工具。
   */
  straighten?: boolean;
  onState?: () => void;
  onChange?: () => void;
  onPageChange?: (index: number) => void;
  /**
   * 某页的底图（PDF / 图片）渲染好了，通知侧栏重画那一页的缩略图。
   *
   * 缩略图是懒渲染的：进视口时先画一张（那时 PDF 位图多半还没有），
   * 位图渲染完必须补一次，否则侧栏会一直停在灰底占位上。
   */
  onThumbNeedsRedraw?: (index: number) => void;
}

export class BookEditor {
  readonly host: HTMLElement;
  readonly scrollEl: HTMLElement;
  readonly docEl: HTMLElement;
  readonly store: BookStore;

  tool: ToolId = "pen";
  penColor = "#1A1A1A";
  penSize = 2.8;
  highlighterColor = "#F2C84B";
  highlighterSize = 24;
  shapeKind: ShapeKind = "rect";
  /** 自动把直线画直的开关（由设置同步进来） */
  private straighten = false;
  eraserMode: "whole" | "part" = "part";
  eraserSize = 26;
  zoom = 0.8;
  fitMode = true;

  private opts: EditorOptions;
  private recs: PageRec[] = [];
  private observer: IntersectionObserver | null = null;
  private current = 0;
  private gesture: Gesture = "none";
  /** 正在编辑的文字框（同一时刻只有一个） */
  private textEdit: {
    rec: PageRec;
    el: HTMLTextAreaElement;
    id: string | null;
    x: number;
    y: number;
    size: number;
    color: string;
    font: string;
  } | null = null;
  /** 正在补抽文字的页（防止重复触发） */
  private textExtracting = new Set<number>();
  /** 新建文字用的字号（页面坐标）；已有文字编辑时保持它自己的字号 */
  private textSizeValue = 18;
  /** 新建文字用的字体 id 与颜色 */
  private textFontValue = "sans";
  private textColorValue = "#1A1A1A";
  /** 当前选中的文字对象 id（文字 / 选择工具下有意义） */
  private selectedTextId: string | null = null;
  /** 正在拖动的文字（选择工具） */
  private moveText: {
    rec: PageRec;
    id: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null = null;
  /** 上一次点文字的时间，用来识别双击（双击进编辑） */
  private lastTextTap: { id: string; t: number } | null = null;
  /** 选中文字后浮在纸上方的属性条 */
  private textBarEl: HTMLElement | null = null;
  private pointerId: number | null = null;
  private draft: Stroke | null = null;
  private draftRec: PageRec | null = null;
  private eraserPos: { x: number; y: number; r: number } | null = null;
  private undoPushed = false;
  private lastPoint: { x: number; y: number; t: number } | null = null;
  private lastPressure: number | null = null;
  /** 输入滤波：去掉手抖和采样噪声 */
  private smoother = new OneEuroFilter(1.4, 0.035, 1.0);
  /** 上一笔的速度（页面单位/秒），用于速度—粗细联动 */
  private lastSpeed = 0;
  private pan: { x: number; y: number; left: number; top: number } | null = null;

  /**
   * 惯性滚动的状态。
   *
   * 为什么自己做而不靠浏览器：实测 pointercancel = 0，
   * 说明浏览器全程没接管滚动（是我们一行行设 scrollTop 的），
   * 浏览器只当「被命令搬动的容器」，不会给任何惯性。
   */
  private fling: {
    /** 当前速度（px/ms，正数向下） */
    vel: number;
    /** 上一次更新的时间戳 */
    last: number;
    /** rAF 句柄 */
    raf: number;
  } | null = null;
  /**
   * 滚动速度采样。
   *
   * 抬手时要按「最近这一小段时间的平均速度」起算，
   * 而不是整段滑动的平均——用户最后减速了，
   * 用整段平均会让页面在已经慢下来时又猛地窜出去。
   */
  private velSamples: { t: number; y: number }[] = [];
  private overlayRaf = 0;
  private scrollRaf = 0;
  private destroyed = false;
  private globalUp = (e: PointerEvent) => {
    if (this.gesture === "none" || this.pointerId !== e.pointerId) return;
    const rec = this.recs[this.current];
    if (rec) this.onUp(e, rec);
  };
  private resizeObserver: ResizeObserver | null = null;
  private resizeRaf = 0;
  /** 平板手势仲裁：笔 / 手指 / 多指手势 */
  private arbiter: TouchArbiter;
  /** 当前这一指的角色 */
  private role: TouchRole = "none";
  /**
   * 允许手指书写（平板没笔时也能写）。
   *
   * **默认关**：手指的第一职责是滚动，笔才是用来写的。
   * 开着它意味着单指不再滚页（一碰就落笔），滚动只能靠双指或右缘滑条——
   * 这是用户主动打开「允许手指书写」时才该承担的代价，不能默认塞给他。
   *
   * 2026-10-30 之前它其实是死开关：`role === "pan"` 那一支无条件走滚动并
   * return，而 arbiter 给单指 touch 的 role 永远是 "pan"，所以写不写都轮不到它。
   */
  touchDraw = false;
  /**
   * 仅阅读模式。
   *
   * 控制坞收起时置位：所有「改内容」的操作一律拒绝，
   * 但「看内容」的操作（滚动、翻页、缩放）照常。
   *
   * 为什么不做成「只是隐藏工具栏」：
   * 隐藏了工具栏，手指照样能落在纸上画一道——
   * 阅读时手不自觉一蹭，纸上就多了一笔 unwanted 痕迹。
   * 所以必须在输入层真正拦住。
   */
  private readOnly = false;
  /** 笔尖悬停位置（悬停预览） */
  private hoverPos: { x: number; y: number; p: number } | null = null;
  /** 底图缓存：路径 → 已加载的 Image（Word 静态底图） */
  private bgImages = new Map<string, HTMLImageElement>();
  /** 底图正在加载的路径 */
  private bgLoading = new Set<string>();
  /**
   * PDF 页位图缓存：按字节预算淘汰，内存有上限。
   * 翻几百页也不会把显存撑爆。
   *
   * 160MB：128MB 实测只够 14 张位图（30 页 PDF 翻一遍占满 121.9/128MB），
   * 往回翻必然重渲、页面白闪一下。回到 160MB 换回 2 页余量，
   * 代价是纯手写本的画布预算（52–168MB）加上它最坏 328MB——
   * 但两者的峰值极少同时出现（手写本用不到 PDF 缓存）。
   * 真正该降的时候再降：P3 的 tile 落地后画布会大幅缩小，届时可把这里调回 192MB。
   */
  private bgBitmaps = new BitmapCache({ budget: 160 * 1024 * 1024 });
  /**
   * 侧栏缩略图专用的 PDF 位图缓存。
   *
   * 为什么不跟主视图共用一份：
   *   主视图要的是"当前缩放下的清晰度"（放大到 2.8 倍时一张 2000px 宽、约 10MB），
   *   缩略图只要 160px 宽、约 150KB。共用同一个 LRU 的话，用户在侧栏
   *   翻上几十页就会把高清位图全挤出去，回到主视图又得重新光栅化、白闪一片。
   *   分开之后：缩略图浏览再狠也只吃自己那 32MB。
   */
  private thumbBitmaps = new BitmapCache({ budget: 32 * 1024 * 1024 });
  /**
   * 缩略图渲染队列。
   *
   * 侧栏一滚，IntersectionObserver 会一次叫醒七八张缩略图；不排队的话
   * 就是七八个 pdf.js 渲染任务同时压上来（每张还要 getPage + 建 canvas）。
   * 一次只跑两张：视觉上还是"一下子都出来了"，但主线程不会被咬住。
   */
  private thumbQueue: { pdfPath: string; pageNo: number; key: string; want: number }[] = [];
  private thumbQueued = new Set<string>();
  private thumbActive = 0;
  /** 正在渲染的缩略图底图（同一页不重复光栅化） */
  private thumbRendering = new Set<string>();
  /** 已打开的 PDF 文档（按路径缓存），避免每页都重新解析 */
  private pdfDocs = new Map<string, Promise<PdfDoc>>();
  /** 每页 PDF 期望的位图宽度（设备像素）——用户放大时随之提高 */
  private bgTarget = new Map<string, number>();
  /** 正在渲染的 PDF 页，避免同一页并发渲染多次 */
  private bgRendering = new Set<string>();
  /** 底图渲染完成后需要重画的页 */
  private bgDirty = new Set<number>();
  /**
   * 左缘右滑手势拦截器。
   *
   * 安卓 Obsidian 从屏幕左缘右滑会弹出文件列表。
   * 用触控笔从左往右写字时，这一笔会被宿主误判成右滑。
   *
   * 这里在**捕获阶段**吞掉这类触摸事件，宿主就收不到，
   * 也就不会弹列表。
   */
  private edgeGuard = { x0: 0, y0: 0, active: false, armed: false };
  /**
   * 最近一次「贴着容器左缘起手」的时间戳。
   *
   * 派发层（main.ts 的 swipe 拦截）只能看到 direction，看不到坐标，
   * 由这里把坐标判定结果带过去——只有从最左缘起手的滑动才可能是写字误触。
   */
  private edgeSwipeAt = 0;
  /** 手势拦截器的反注册函数 */
  private guardTeardown: (() => void) | null = null;
  /** 页面之间的间距（px），从 CSS 读一次，用于算术定位 */
  private pageGap = 24;
  /** 首页顶部在滚动内容里的位置（算术定位的基准） */
  private pageOrigin = 0;
  /** docEl 顶部在滚动内容里的位置 */
  private docOrigin = 0;
  /** 事件委托是否已绑定 */
  private eventsBound = false;
  /** 滚轮缩放累积量（每帧结算一次） */
  private wheelAccum = 0;
  /** 滚轮缩放的待处理帧 */
  private wheelRaf = 0;
  /** 滚轮位置（锚点用） */
  private wheelX = 0;
  private wheelY = 0;
  /**
   * 锁定的锚点：光标指向的那个**内容点**。
   *
   * 连续缩放时必须复用同一个内容点，不能每次都从光标重新反推——
   * 重新反推会把上一轮的亚像素量化误差带进下一轮，
   * 几十次缩放后能攒到几十像素，表现为「越滚越偏」。
   *
   * 锁定后，缩放只改变这个内容点的**显示位置**，内容本身始终不动。
   */
  private lockedAnchor: (ZoomAnchor & {
    clientX: number;
    clientY: number;
  }) | null = null;
  /**
   * 捏合手势的状态。
   *
   * 捏合和滚轮缩放是**两套模型**：
   *   · 滚轮：每次事件独立，锚点跟着光标走
   *   · 捏合：一个手势是一个整体，锚点必须从头到尾固定
   *
   * 锚点固定才不跳页——两指中心在动，如果每帧重取锚点，
   * 等于每帧都在追一个不同的内容点。
   */
  private pinch: {
    /** 手势开始时两指的距离 */
    baseDist: number;
    /** 手势开始时的缩放比 */
    baseZoom: number;
    /** 固定的锚点（手势开始时两指中心下的那个内容点） */
    anchor: ZoomAnchor;
  } | null = null;
  /** 捏合手势进行中（屏蔽锚点锁的「用户滚动」判定） */
  private pinchActive = false;
  /** 捏合开始时的当前页（手势结束后要锁回它，缩放不是翻页） */
  private pinchStartPage = 0;
  /** 手势结束后继续冻结页码判定的定时器（补偿还会再触发几帧 scroll） */
  private pinchReleaseTimer = 0;
  /**
   * 锁定锚点时的 scrollTop。
   *
   * 用来判断「用户是不是自己滚动了」：
   * 用户滚动后，之前锁定的内容点已经不在光标下了，锚点必须失效；
   * 而程序自己做的滚动补偿会把这里同步更新，不会误伤。
   *
   * 比用布尔标志可靠——布尔标志会被无关的 scroll 事件消费掉。
   */
  private anchorScrollTop = 0;
  /** 擦除手势开始前的层状态（用于合成一条历史） */
  private eraseBefore: HistoryEntry | null = null;
  /** 擦除手势的当前层状态 */
  private eraseAfter: HistoryEntry | null = null;

  constructor(host: HTMLElement, store: BookStore, opts: EditorOptions = {}) {
    this.host = host;
    this.store = store;
    this.opts = opts;
    this.current = clamp(store.data.activePage || 0, 0, store.pageCount - 1);
    this.arbiter = new TouchArbiter({
      onGestureStart: (info) => this.beginPinch(info),
      onGestureMove: (info) => this.applyPinch(info),
      onGestureEnd: () => this.endPinch(),
    });

    this.host.classList.add("mb-host");
    this.host.innerHTML = "";
    this.scrollEl = document.createElement("div");
    this.scrollEl.className = "mb-scroll";
    this.docEl = document.createElement("div");
    this.docEl.className = "mb-doc";
    this.scrollEl.appendChild(this.docEl);
    this.host.appendChild(this.scrollEl);

    window.addEventListener("pointerup", this.globalUp, true);
    window.addEventListener("pointercancel", this.globalUp, true);

    this.scrollEl.addEventListener(
      "scroll",
      () => {
        /*
         * 用户自己滚动 → 锚点失效。
         *
         * 缩放补偿也会触发 scroll 事件，但补偿完会把 anchorScrollTop
         * 更新成新的 scrollTop，所以这里用「实际值 vs 记录值」判断，
         * 比用布尔标志可靠——布尔标志会被无关的 scroll 事件消费掉。
         */
        if (
          !this.pinchActive &&
          this.lockedAnchor &&
          Math.abs(this.scrollEl.scrollTop - this.anchorScrollTop) > 1.5
        ) {
          this.lockedAnchor = null;
        }
        if (this.scrollRaf) return;
        this.scrollRaf = requestAnimationFrame(() => {
          this.scrollRaf = 0;
          /*
           * 捏合缩放期间不判定当前页。
           *
           * 缩放补偿本身会改 scrollTop，每帧都重算会让页码在相邻页之间乱跳
           * （用户看到的就是「捏合时跳到别的页」）。手势结束后统一算一次。
           */
          if (this.pinchActive) return;
          this.updateCurrentFromScroll();
        });
      },
      { passive: true }
    );

    // 电脑端：Ctrl + 滚轮缩放，以光标位置为锚点
    //
    // 触控板一次滑动会连发几十个 wheel 事件，逐个处理会
    // 触发几十次完整重排+重绘。这里累积 deltaY，
    // 每帧只处理一次。
    this.scrollEl.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        // 阻止浏览器的页面级缩放
        e.stopPropagation();
        this.wheelAccum += e.deltaY;
        this.wheelX = e.clientX;
        this.wheelY = e.clientY;
        if (this.wheelRaf) return;
        this.wheelRaf = requestAnimationFrame(() => {
          this.wheelRaf = 0;
          const d = this.wheelAccum;
          this.wheelAccum = 0;
          if (!d) return;
          // 滚轮每一"格"约 100 单位，对应一次 1.12 倍缩放。
          // 用指数映射，触控板的小幅 delta 也能有连续手感。
          const steps = d / 100;
          this.zoomAt(this.wheelX, this.wheelY, Math.pow(1.12, -steps));
        });
      },
      { passive: false }
    );

    if (this.opts.edgeSwipeBlock !== false) this.installEdgeSwipeGuard();
    this.straighten = this.opts.straighten === true;

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        if (!this.fitMode || this.destroyed || this.resizeRaf) return;
        this.resizeRaf = requestAnimationFrame(() => {
          this.resizeRaf = 0;
          if (this.fitMode && !this.destroyed) this.applyLayout();
        });
      });
      this.resizeObserver.observe(this.scrollEl);
    }

    this.renderPages();
    this.applyTouchAction();
    requestAnimationFrame(() => {
      this.applyLayout();
      this.measurePageMetrics();
      this.goToPage(this.current, false);
      this.emitState();
    });
  }

  /**
   * 量一次页面布局参数：页间距、首页在滚动内容里的偏移基准。
   *
   * 只在布局变化时量（不是每次滚动），量完就用算术定位，
   * 滚动时不再碰 getBoundingClientRect。
   */
  private measurePageMetrics(): void {
    if (!this.recs.length) return;
    const first = this.recs[0].wrap;
    const second = this.recs[1];
    if (second) {
      // 两页顶部之差 = 页高 + 间距
      //
      // 必须用 getBoundingClientRect 而不是 offsetTop：
      // offsetTop 被浏览器取整到整数像素。页高 1123 × 1.12 = 1257.76，
      // 取整后间距会量成 24.24 而不是 24。这 0.24px 会被
      // 「页序号 × 间距」的推算放大成好几像素。
      const t0 = first.getBoundingClientRect().top;
      const t1 = second.wrap.getBoundingClientRect().top;
      const pageH = this.store.data.height * this.zoom;
      const gap = t1 - t0 - pageH;
      if (Number.isFinite(gap) && gap >= 0 && gap < 200) this.pageGap = gap;
    }
    // 首页偏移基准：offsetTop 是相对 docEl 的，
    // 而 scrollTop 是相对滚动内容的——两者差一个容器内边距。
    // 直接量出"首页顶部对应的 scrollTop"，后面就能纯算术定位。
    const docRect = this.docEl.getBoundingClientRect();
    const scrollRect = this.scrollEl.getBoundingClientRect();
    const firstTop = first.getBoundingClientRect().top;
    // 首页顶部在滚动内容里的位置
    this.pageOrigin =
      firstTop - scrollRect.top + this.scrollEl.scrollTop;
    this.docOrigin = docRect.top - scrollRect.top + this.scrollEl.scrollTop;
  }

  /* ------------------------------- 状态 ------------------------------- */

  getState(): EditorState {
    const page = this.store.page;
    const layer = activeLayer(page);
    return {
      pageIndex: this.current,
      pageCount: this.store.pageCount,
      zoom: this.zoom,
      tool: this.tool,
      penColor: this.penColor,
      penSize: this.penSize,
      highlighterColor: this.highlighterColor,
      highlighterSize: this.highlighterSize,
      shapeKind: this.shapeKind,
      textSize: this.textSizeValue,
      textFont: this.textFontValue,
      textColor: this.textColorValue,
      textSelected: (() => {
        const t = this.selectedText;
        return t
          ? {
              id: t.id,
              text: t.text,
              size: t.size,
              font: t.font || "sans",
              color: t.color || "#1A1A1A",
            }
          : null;
      })(),
      canUndo: this.store.canUndo(),
      canRedo: this.store.canRedo(),
      penOnly: !!this.opts.penOnly,
      activeLayerId: layer ? layer.id : "",
      layers: page.layers.map((l) => ({
        id: l.id,
        name: l.name,
        visible: l.visible,
        count: l.strokes.length,
      })),
    };
  }

  private emitState(): void {
    /*
     * 选中对象失效就丢掉：
     *   · 换了页（selectedText 只在当前页找）
     *   · 撤销 / 删除把那一段去掉了
     * 不在这里清的话，属性条会挂在已经不存在（或不在当前页）的文字上。
     */
    if (this.selectedTextId && !this.selectedText) {
      this.selectedTextId = null;
      this.textBarEl?.remove();
      this.textBarEl = null;
    }
    if (this.opts.onState) this.opts.onState();
  }

  private changed(): void {
    if (this.opts.onChange) this.opts.onChange();
  }

  setPenOnly(on: boolean): void {
    this.opts.penOnly = on;
    this.applyTouchAction();
    this.emitState();
  }

  setPressure(v: number): void {
    this.opts.pressure = v;
  }

  setSmoothing(v: number): void {
    this.opts.smoothing = v;
  }

  setPrediction(on: boolean): void {
    this.opts.prediction = on;
  }

  setTool(tool: ToolId): void {
    if (this.tool === tool) return;
    this.tool = tool;
    this.eraserPos = null;
    // 离开文字/选择工具就没有"选中文字"这回事了，属性条一并收掉
    if (tool !== "text" && tool !== "select") this.selectText(null);
    this.applyTouchAction();
    this.emitState();
  }

  get textSize(): number {
    return this.textSizeValue;
  }

  setTextSize(size: number): void {
    const v = clamp(Math.round(size), 8, 96);
    if (v === this.textSizeValue) return;
    this.textSizeValue = v;
    /* 选中的那段文字跟着改——"选中它再改字号"是最自然的手势 */
    const sel = this.selectedText;
    if (sel) this.updateSelectedText({ size: v });
    else this.emitState();
  }

  get textFont(): string {
    return this.textFontValue;
  }

  setTextFont(id: string): void {
    if (!TEXT_FONTS.some((f) => f.id === id)) return;
    this.textFontValue = id;
    const sel = this.selectedText;
    if (sel) this.updateSelectedText({ font: id });
    else this.emitState();
  }

  get textColor(): string {
    return this.textColorValue;
  }

  setTextColor(color: string): void {
    if (!color) return;
    this.textColorValue = color;
    const sel = this.selectedText;
    if (sel) this.updateSelectedText({ color });
    else this.emitState();
  }

  /* --------------------------- 选中文字对象 --------------------------- */

  /** 当前页选中的那段文字；页面里找不到就是 null */
  get selectedText(): PageText | null {
    if (!this.selectedTextId) return null;
    const page = this.store.data.pages[this.current];
    return page?.texts?.find((t) => t.id === this.selectedTextId) ?? null;
  }

  /**
   * 选中 / 取消选中一段文字。
   *
   * 为什么要"先选中、再编辑"：直接点一下就弹输入框的话，
   * 想改字号颜色根本没有落脚点，手指也没法在纸上精确点两次。
   * 选中后浮一条属性条，字号 / 字体 / 颜色 / 编辑 / 删除都在上面。
   */
  selectText(id: string | null): void {
    if (this.selectedTextId === id) return;
    this.selectedTextId = id;
    const rec = this.recs[this.current];
    if (rec) this.renderOverlay(rec);
    this.syncTextBar();
    this.emitState();
  }

  /** 改选中文字的属性（字号 / 字体 / 颜色 / 加粗），一次改动一条历史 */
  updateSelectedText(patch: Partial<Pick<PageText, "size" | "font" | "color" | "bold">>): void {
    if (this.readOnly) return;
    const sel = this.selectedText;
    const rec = this.recs[this.current];
    if (!sel || !rec) return;
    const page = this.store.data.pages[rec.index];
    const target = page?.texts?.find((t) => t.id === sel.id);
    if (!target) return;

    let dirty = false;
    if (typeof patch.size === "number") {
      const v = clamp(Math.round(patch.size), 8, 96);
      if (v !== target.size) {
        target.size = v;
        dirty = true;
      }
    }
    if (typeof patch.font === "string" && TEXT_FONTS.some((f) => f.id === patch.font)) {
      if (patch.font !== target.font) {
        target.font = patch.font;
        dirty = true;
      }
    }
    if (typeof patch.color === "string" && patch.color !== target.color) {
      target.color = patch.color;
      dirty = true;
    }
    if (typeof patch.bold === "boolean" && patch.bold !== !!target.bold) {
      target.bold = patch.bold;
      dirty = true;
    }
    if (!dirty) return;

    this.store.snapshotPage(rec.index);
    this.store.touch();
    this.changed();
    this.renderTextLayer(rec);
    this.renderOverlay(rec);
    this.syncTextBar();
    this.emitState();
  }

  /** 删除选中文字（Delete / 属性条上的「删除」） */
  deleteSelectedText(): void {
    if (this.readOnly) return;
    const sel = this.selectedText;
    const rec = this.recs[this.current];
    if (!sel || !rec) return;
    const page = this.store.data.pages[rec.index];
    if (!page?.texts?.length) return;
    this.store.snapshotPage(rec.index);
    page.texts = page.texts.filter((t) => t.id !== sel.id);
    this.store.touch();
    this.changed();
    this.selectedTextId = null;
    this.renderTextLayer(rec);
    this.renderOverlay(rec);
    this.syncTextBar();
    this.emitState();
  }

  /**
   * 选中文字上方那一条属性工具。
   *
   * 落在页面上（而不是侧栏）是因为：选中文字时视线在纸上，
   * 侧栏可能是收起的，跑过去点一下再回来太远。
   * 每次改动都重建——它是十几个节点的小东西，重建比手动同步状态省心。
   */
  private syncTextBar(): void {
    this.textBarEl?.remove();
    this.textBarEl = null;
    const sel = this.selectedText;
    const rec = this.recs[this.current];
    if (!sel || !rec || !rec.mounted || this.readOnly) return;

    const bar = document.createElement("div");
    bar.className = "mb-textbar";
    // 属性条上的手势一律不许传到画布，否则点一下字号会顺手画一笔
    const eat = (e: Event) => e.stopPropagation();
    for (const evName of ["pointerdown", "mousedown", "touchstart"]) {
      bar.addEventListener(evName, eat, { passive: true });
    }

    const mkBtn = (label: string, title: string, cb: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mb-tb-btn";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        cb();
      });
      return b;
    };

    // 字号：− 当前 +
    const minSize = Math.max(8, sel.size - 2);
    const plusSize = Math.min(96, sel.size + 2);
    const dec = mkBtn("−", "缩小字号", () => this.updateSelectedText({ size: minSize }));
    const sizeLbl = document.createElement("span");
    sizeLbl.className = "mb-tb-size";
    sizeLbl.textContent = String(Math.round(sel.size));
    const inc = mkBtn("+", "放大字号", () => this.updateSelectedText({ size: plusSize }));
    bar.append(dec, sizeLbl, inc);
    bar.appendChild(this.textBarSep());

    // 字体
    const fontSel = document.createElement("select");
    fontSel.className = "mb-tb-font";
    fontSel.title = "字体";
    for (const f of TEXT_FONTS) {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.label;
      if ((sel.font || "sans") === f.id) opt.selected = true;
      fontSel.appendChild(opt);
    }
    fontSel.addEventListener("change", () => this.updateSelectedText({ font: fontSel.value }));
    fontSel.addEventListener("pointerdown", eat);
    bar.appendChild(fontSel);
    bar.appendChild(this.textBarSep());

    // 颜色
    for (const c of PEN_COLORS.slice(0, 6)) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "mb-tb-dot" + ((sel.color || "").toLowerCase() === c.toLowerCase() ? " is-active" : "");
      dot.style.background = c;
      dot.title = "改成这个颜色";
      dot.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.updateSelectedText({ color: c });
      });
      bar.appendChild(dot);
    }
    bar.appendChild(this.textBarSep());

    // 编辑 / 删除
    bar.appendChild(
      mkBtn("编辑", "修改文字内容", () => {
        const t = this.selectedText;
        const live = this.recs[this.current];
        if (!t || !live) return;
        this.beginTextEdit(live, t.x + 4, t.y - t.size * 0.4);
      })
    );
    const del = mkBtn("删除", "删掉这段文字（可撤销）", () => this.deleteSelectedText());
    del.classList.add("is-danger");
    bar.appendChild(del);

    rec.pageEl.appendChild(bar);
    this.textBarEl = bar;
    this.positionTextBar();
  }

  private textBarSep(): HTMLElement {
    const sep = document.createElement("span");
    sep.className = "mb-tb-sep";
    return sep;
  }

  /** 属性条跟着文字走：优先放在文字上方，顶到页眉就翻到下方 */
  private positionTextBar(): void {
    const bar = this.textBarEl;
    const sel = this.selectedText;
    if (!bar || !sel) return;
    const z = this.zoom;
    const pageW = this.store.data.width * z;
    const w = bar.offsetWidth || 320;
    const h = bar.offsetHeight || 32;
    // 跟着排版后的位置走：越界的老批注渲染时被夹回纸内，属性条也得跟进去
    const l = this.textLayout(sel);
    const left = Math.max(4, Math.min(l.x * z, pageW - w - 4));
    const above = (l.y - sel.size * 1.18) * z - h - 8;
    /*
     * 「放到文字下方」要躲开**最后一行**：折行的长批注有好几行，
     * 按第一行算高度会让属性条压在文字身上。
     */
    const lines = Math.max(1, l.lines.length);
    const below = (l.y + (lines - 1) * l.lineHeight + sel.size * 0.5) * z + 8;
    const top = above >= 4 ? above : below;
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
  }

  setPenColor(color: string): void {
    this.penColor = color;
    this.emitState();
  }

  setPenSize(size: number, silent = false): void {
    this.penSize = size;
    if (!silent) this.emitState();
  }

  setHighlighterColor(color: string): void {
    this.highlighterColor = color;
    this.emitState();
  }

  setHighlighterSize(size: number, silent = false): void {
    this.highlighterSize = size;
    if (!silent) this.emitState();
  }

  setShapeKind(kind: ShapeKind): void {
    this.shapeKind = kind;
    this.emitState();
  }

  setEraserMode(mode: "whole" | "part"): void {
    this.eraserMode = mode;
    this.emitState();
  }

  /* ------------------------------- 页面 ------------------------------- */

  private createPageRec(index: number, page: Page): PageRec {
    const wrap = document.createElement("div");
    wrap.className = "mb-page-wrap";
    wrap.dataset.page = String(index);
    if (page.background) wrap.classList.add("has-bg");
    const pageEl = document.createElement("div");
    pageEl.className = "mb-page";
    pageEl.style.background = paperBackground(page.paper);
    const num = document.createElement("div");
    num.className = "mb-page-num";
    num.textContent = String(index + 1);
    wrap.appendChild(pageEl);
    wrap.appendChild(num);

    /*
     * 事件用**委托**处理，不给每页挂监听器。
     * 500 页 × 6 个监听器 = 3000 个监听器，既占内存，
     * 挂载/卸载的开销也大。委托后只有 docEl 上 6 个。
     */

    const rec: PageRec = {
      index,
      wrap,
      pageEl,
      canvas: null,
      textLayer: null,
      overlay: null,
      ctx: null,
      octx: null,
      mounted: false,
      ioVisible: false,
    };
    return rec;
  }

  /**
   * 在 docEl 上挂事件委托。
   * 事件目标往上找到 .mb-page，再反查它属于哪一页。
   */
  private bindDelegatedEvents(): void {
    // renderPages 会反复调用，但 docEl 本身不换——
    // 所以监听器只绑一次，否则会重复触发。
    if (this.eventsBound) return;
    this.eventsBound = true;

    const findRec = (target: EventTarget | null): PageRec | null => {
      let el = target as HTMLElement | null;
      while (el && el !== this.docEl) {
        if (el.classList?.contains("mb-page")) {
          const wrap = el.parentElement;
          const idx = Number(wrap?.dataset.page);
          if (Number.isFinite(idx)) return this.recs[idx] ?? null;
        }
        el = el.parentElement;
      }
      return null;
    };

    this.docEl.addEventListener("pointerdown", (e) => {
      const rec = findRec(e.target);
      if (rec) this.onDown(e as PointerEvent, rec);
    });
    this.docEl.addEventListener("pointermove", (e) => {
      const rec = findRec(e.target);
      if (rec) this.onMove(e as PointerEvent, rec);
    });
    this.docEl.addEventListener("pointerup", (e) => {
      const rec = findRec(e.target);
      if (rec) this.onUp(e as PointerEvent, rec);
    });
    this.docEl.addEventListener("pointercancel", (e) => {
      const rec = findRec(e.target);
      if (rec) this.onUp(e as PointerEvent, rec);
    });
    this.docEl.addEventListener("pointerleave", (e) => {
      const rec = findRec(e.target);
      if (rec) this.onLeave(e as PointerEvent, rec);
    });
    this.docEl.addEventListener("contextmenu", (e) => {
      if (this.tool !== "hand") e.preventDefault();
    });
  }

  renderPages(): void {
    // 编辑框挂在页面 DOM 上，重建前先落盘，否则输入的内容跟着 DOM 一起消失
    this.commitTextEdit();
    // 页面全部重建，旧的锚点索引失效
    this.lockedAnchor = null;
    this.draft = null;
    this.draftRec = null;
    this.gesture = "none";
    this.pointerId = null;
    this.eraserPos = null;
    this.hoverPos = null;
    this.moveText = null;
    this.arbiter.reset();
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    // 页对象重建了，旧的 ioVisible 状态随 rec 一起作废
    this.recs = [];
    this.docEl.innerHTML = "";
    this.store.data.pages.forEach((page, i) => {
      const rec = this.createPageRec(i, page);
      this.recs.push(rec);
      this.docEl.appendChild(rec.wrap);
    });
    const add = document.createElement("button");
    add.className = "mb-add-page";
    add.textContent = "＋ 添加一页";
    add.addEventListener("click", () => this.addPage());
    this.docEl.appendChild(add);

    // 事件委托只需要在 docEl 上绑一次（docEl 本身不会被替换）
    this.bindDelegatedEvents();

    this.current = clamp(this.store.data.activePage, 0, this.store.pageCount - 1);
    this.applyLayout();
    this.applyTouchAction();
    this.observePages();
    this.syncTextBar();
    requestAnimationFrame(() => this.goToPage(this.current, false));
  }

  /**
   * 应用布局：设置页面尺寸。
   *
   * 性能关键：这里**不能**遍历所有页逐个写 style。
   * 500 页时 1000 次样式写入会触发 1000 次样式重算——
   * 实测缩放一次要 1.1 秒，完全卡死。
   *
   * 改法：把尺寸写成 docEl 上的 CSS 变量，让所有页继承。
   * 一次写入，所有页生效，O(1)。
   * 只有"已挂载"（真正在视口里）的页需要重建 canvas 尺寸。
   */
  applyLayout(): void {
    if (this.fitMode) {
      const availW = Math.max(240, this.scrollEl.clientWidth - 64);
      const availH = Math.max(240, this.scrollEl.clientHeight - 46);
      this.zoom = clamp(
        Math.min(availW / this.store.data.width, availH / this.store.data.height),
        0.3,
        1.25
      );
    }
    const w = this.store.data.width * this.zoom;
    const h = this.store.data.height * this.zoom;
    // 一次写入，所有页继承
    this.docEl.style.setProperty("--mb-page-w", `${w}px`);
    this.docEl.style.setProperty("--mb-page-h", `${h}px`);
    // 文字层按页面坐标写死尺寸，整体用这个变量缩放
    this.docEl.style.setProperty("--mb-zoom", String(this.zoom));
    // 属性条是按像素定位的，缩放后得重算一次
    this.positionTextBar();
    // 只重建已挂载页的 canvas（数量很少，通常 1-3 个）
    for (const rec of this.recs) {
      if (rec.mounted) this.resizeRec(rec);
    }
    this.emitState();
  }

  setZoom(z: number): void {
    this.fitMode = false;
    this.zoom = clamp(z, 0.3, 2.8);
    this.applyLayout();
  }

  zoomBy(factor: number): void {
    this.setZoom(this.zoom * factor);
  }

  fit(): void {
    this.fitMode = true;
    this.applyLayout();
  }

  /**
   * 以某个屏幕坐标为锚点缩放。
   *
   * 锚点缩放 = 缩放前后，**光标指向的那个内容点**在屏幕上不动。
   *
   * 之前的实现有三个错误叠加，导致滚一下就跳好几页：
   *   1. 锚点用的是 `this.current`（当前页），不是光标实际所在的那一页。
   *      光标在别的页上时，锚点算出来完全是另一页的坐标。
   *   2. 补偿量把「页面坐标 × 缩放比」又除了以页面高度，
   *      单位混乱——差了一整个 1123 的倍数。
   *   3. `keep()` 被调用两次（同步一次 + rAF 一次），
   *      两次都用过期数据，误差叠加。
   *
   * 现在改成：先量出光标下的**内容点**（哪一页 + 页内什么位置），
   * 缩放后把这个内容点重新对回光标。
   */
  zoomAt(clientX: number, clientY: number, factor: number): void {
    // 缩放和惯性滚动不能同时进行
    this.stopFling();
    const before = this.zoom;
    const after = clamp(before * factor, 0.3, 2.8);
    if (after === before) return;
    this.fitMode = false;

    // 1. 确定锚点：光标指向的内容点
    //
    // 连续滚轮缩放时必须复用同一个内容点——重新反推会把上一轮的
    // 亚像素量化误差带进来，几十次缩放后能攒到几十像素。
    //
    // 但用户中途自己滚动了的话，锁定的内容点已经不在光标下了，
    // 必须重新取。
    const locked = this.lockedAnchor;
    const reuse =
      !!locked &&
      Math.abs(locked.clientX - clientX) < 1 &&
      Math.abs(locked.clientY - clientY) < 1 &&
      Math.abs(this.scrollEl.scrollTop - this.anchorScrollTop) <= 1.5;

    let anchor: ZoomAnchor | null = null;
    if (reuse && locked) {
      anchor = { index: locked.index, fx: locked.fx, fy: locked.fy };
    } else {
      const picked = this.pickAnchor(clientX, clientY);
      if (picked) {
        anchor = picked;
        this.lockedAnchor = { ...picked, clientX, clientY };
        this.anchorScrollTop = this.scrollEl.scrollTop;
      } else {
        this.lockedAnchor = null;
      }
    }

    // 2. 缩放
    this.zoom = after;
    this.applyLayout();

    // 3. 把内容点对回光标
    if (anchor) {
      this.restoreAnchor(anchor, clientX, clientY);
    }

    // 4. 布局变了，间距和基准要重新量
    this.measurePageMetrics();
    this.emitState();
  }

  /**
   * 找出光标指向的内容点。
   *
   * 返回「哪一页 + 该页内的相对位置（0..1）」。
   *
   * 用**相对位置**而不是绝对像素：页面是等比缩放的，
   * 所以同一个相对位置在缩放前后指向的是同一个内容——
   * 这就是锚点能锁住的关键。
   */
  /**
   * 某个屏幕纵坐标落在第几页（纯算术，不碰 DOM）。
   *
   * 和 updateCurrentFromScroll 用同一套模型，但可以问任意一点——
   * 捏合开始时要问的是「**视口中心**现在是第几页」，
   * 而 this.current 是上一次 scroll 事件算出来的，可能已经滞后一页。
   * 锁页锁错了，手势结束后页码就会跳。
   */
  private pageIndexAt(clientY: number): number {
    if (!this.recs.length) return 0;
    const sr = this.scrollEl.getBoundingClientRect();
    const stride = this.store.data.height * this.zoom + this.pageGap;
    if (stride <= 0) return 0;
    const rel = clientY - sr.top + this.scrollEl.scrollTop - this.pageOrigin;
    return clamp(Math.floor(rel / stride), 0, this.recs.length - 1);
  }

  private pickAnchor(clientX: number, clientY: number): ZoomAnchor | null {
    // 光标可能在某一页上，也可能在页与页之间的缝隙里。
    // 逐页测 getBoundingClientRect 会触发强制重排，页数多时很慢，
    // 所以先用算术定位出一个候选，再精确验证。
    const sr = this.scrollEl.getBoundingClientRect();
    const rel = clientY - sr.top + this.scrollEl.scrollTop - this.pageOrigin;
    const stride = this.store.data.height * this.zoom + this.pageGap;
    let idx = stride > 0 ? Math.floor(rel / stride) : 0;
    idx = clamp(idx, 0, this.recs.length - 1);

    /*
     * 候选页及其相邻页都试一遍。
     *
     * 关键是**不能因为「光标不在任何一页里」就放弃锚定**：
     * 页与页之间有 24px 的缝隙，缩得越小缝隙占的比例越大。
     * 早先用「fy ∈ [-0.02, 1.02]」判定，光标正好落在缝隙里时
     * 三个候选全都不满足 → 返回 null → 这次缩放完全没有补偿，
     * 整篇文档直接跳一个页高。
     *
     * 2026-10-29 真机（平板捏合）再修正一次：
     *
     * **不能把 fy / fx 夹到 [0,1]**。两指中心经常落在纸外——缩小看整页时，
     * 页面上下都是大片背景，双指自然落在空白处。夹到 [0,1] 等于把
     * 「纸外 200px 的那个点」谎报成「纸边缘」，缩放后 restoreAnchor 拼命
     * 把纸边缘对到手指上，整页猛地平移一段 —— 用户看到的就是「捏合时页面跳」。
     *
     * 现在 fy / fx 保持原值，可以做负值 / 大于 1 的外推：
     * restoreAnchor 里是 `r.top + fy * r.height`，外推在数学上完全成立，
     * 纸外的那个点能被精确对回手指。
     *
     * 选页的判据也顺势改了：取「页中心离光标最近」的候选页。
     * 因为不夹之后 fy 自带正确性——就算选到隔壁页，fy 会变成 1.3 / -0.3
     * 之类的值，算出来的内容点还是同一个位置。
     */
    let best: ZoomAnchor | null = null;
    let bestDist = Infinity;
    for (const probe of [idx, idx - 1, idx + 1]) {
      const rec = this.recs[clamp(probe, 0, this.recs.length - 1)];
      if (!rec) continue;
      const r = rec.pageEl.getBoundingClientRect();
      if (!r.height || !r.width) continue;
      const fy = (clientY - r.top) / r.height;
      const fx = (clientX - r.left) / r.width;
      const dist = Math.abs(fy - 0.5);
      if (dist < bestDist - 1e-6) {
        bestDist = dist;
        best = { index: rec.index, fx, fy };
      }
    }
    return best;
  }

  /**
   * 缩放后把内容点对回光标。
   *
   * ### 关键：不推算，只实测
   *
   * 页面是纵向流式排列的，缩放时**前面每一页的高度都变了**。
   * 这才是「滚一下跳好几页」的真正来源——第 10 页往后，
   * 前面 10 页每页都长高了 (after-before)×页高，
   * 累积起来就是几千像素的位移。
   *
   * 早期实现用「页序号 × (页高+间距)」在文档坐标系里推算，
   * 但页间距是从 offsetTop 量出来的——offsetTop 是整数，
   * 0.24px 的误差乘以页序号，到第 100 页就是 24px，整整一页。
   * 这是「跳好几页」的第二个来源。
   *
   * 现在改成**直接从 DOM 实测**：缩放后页面已经重新布局，
   * getBoundingClientRect 拿到的就是内容点此刻的真实屏幕位置，
   * 跟光标位置一减就是要补偿的量。模型误差全部消失。
   *
   * 残留误差只有浏览器把 scrollTop 取整带来的 ±0.5px，
   * 而且它**不累积**——下一轮是重新实测的，误差不会滚雪球。
   *
   * ### 横向
   *
   * 页面是居中的（align-items: safe center），缩放后宽度变了，
   * 居中位置也跟着变——没法用算术推。
   * 所以横向也直接量实际位置再补回去。
   */
  private restoreAnchor(
    anchor: ZoomAnchor,
    clientX: number,
    clientY: number
  ): void {
    const rec = this.recs[anchor.index];
    if (!rec) return;

    // getBoundingClientRect 会强制同步布局，拿到的是缩放后的新位置
    const r2 = rec.pageEl.getBoundingClientRect();
    if (!r2.width || !r2.height) return;

    // 内容点此刻的屏幕位置（页内相对位置在缩放前后不变）
    const curY = r2.top + anchor.fy * r2.height;
    const curX = r2.left + anchor.fx * r2.width;

    // 补偿：内容点该往哪挪多少
    const dy = curY - clientY;
    const dx = curX - clientX;
    if (Math.abs(dy) > 0.01) this.scrollEl.scrollTop += dy;
    if (Math.abs(dx) > 0.01) this.scrollEl.scrollLeft += dx;

    // 记录补偿后的滚动位置——用户后续自己滚动的话，锚点就会失效
    this.anchorScrollTop = this.scrollEl.scrollTop;
  }

  /**
   * 捏合手势开始。
   *
   * 记下基准：两指初始距离、当前缩放比，以及**当前光标下的内容点**。
   *
   * 锚点在这一刻定死，整个手势期间不再变——这是不跳页的关键。
   */
  private beginPinch(info: PinchInfo): void {
    this.cancelStroke();

    /*
     * 把单指滚动那个"半残状态"清干净。
     *
     * 双指手势的第一根手指落下时，onDown 走的是 role === "pan" 分支：
     * 于是 gesture="pan"、pointerId=第一根手指、pan={按下时的 scrollTop}。
     * 第二根手指落下才切进手势——但上面这三个值**没人清**。
     *
     * 平时看不出来（手势期间所有移动都被 role="gesture" 挡在前面）。
     * 真正出事的是**手势结束的那一刻**：如果先抬起的是第二根手指，
     * onUp 会因 pointerId 不匹配而早退，gesture 仍然停在 "pan"；
     * 剩下那根手指一动，就走进 `scrollTop = this.pan.top - dy` ——
     * 而 pan.top 是**捏合开始前**的滚动位置，缩放补偿早把 scrollTop 改了几千像素。
     * 页面于是瞬间跳回去，正是用户报的「捏合放大缩小，页面会跳」。
     */
    this.gesture = "none";
    this.pointerId = null;
    this.pan = null;

    /*
     * 锚点取两指中心正下方的内容点。
     *
     * 用「中心下方」而不是「第一根手指下方」：
     * 用户捏合时，两只手指合拢的那块纸才是他真正在看的区域。
     */
    const anchor = this.pickAnchor(info.cx, info.cy);

    this.pinch = {
      baseDist: Math.max(1, info.dist),
      baseZoom: this.zoom,
      anchor: anchor ?? { index: this.current, fx: 0.5, fy: 0.5 },
    };

    /*
     * 缩放期间要屏蔽锚点锁的「用户滚动」判定。
     *
     * 缩放补偿本身会改 scrollTop，scroll 事件随后触发；
     * 如果不屏蔽，锚点会在第一次缩放后就被判为失效，
     * 下一帧重新 pickAnchor → 锚点漂移 → 跳页。
     */
    /*
     * 锁「捏合开始时用户眼睛在哪一页」，而不是 this.current。
     *
     * this.current 由 scroll 事件算，最后一次事件的时机与手势开始之间
     * 可能差着一次滚动；直接拿它当锁页目标，手势一结束就会把页码
     * 拽回上一页——又一个"捏合完页面跳了"的来源。
     * 这里按视口中心重新算一次，当下看到的是哪页就锁哪页。
     */
    this.pinchStartPage = this.pageIndexAt(
      this.scrollEl.getBoundingClientRect().top + this.scrollEl.clientHeight * 0.42
    );
    window.clearTimeout(this.pinchReleaseTimer);
    this.pinchReleaseTimer = 0;
    this.pinchActive = true;
  }

  /**
   * 捏合手势结束。
   *
   * 这里**不能**用视口中线重算当前页：缩放补偿有 1px 误差就会落到相邻页，
   * 用户看到的就是「一放大缩小，页码跳到别的页」。
   * 缩放是围绕锚点做的，没有翻页意图，所以直接锁回手势开始时的页。
   */
  private endPinch(): void {
    const keep = clamp(this.pinchStartPage, 0, Math.max(0, this.recs.length - 1));
    this.pinch = null;
    this.measurePageMetrics();

    if (this.recs.length && this.current !== keep) {
      this.current = keep;
      this.store.setPage(keep);
      this.mount(this.recs[keep]);
    }
    this.emitState();

    // 手势结束了，滚轮用的锚点锁没有意义了，留着会在下一次滚动时判成"用户没动"
    this.lockedAnchor = null;

    /*
     * 补偿引起的 scroll 事件还会再跑几帧。若这里立刻把 pinchActive 放开，
     * 那些 scroll 会走 updateCurrentFromScroll，前面锁的页白锁了。
     *
     * 而且**手指可能还没抬完**：一根指尖抬起就算手势结束，另一根可能
     * 还按在纸上继续滑。只要还有手指在屏上就一直冻结，全部抬起后再等
     * 240ms 让 clamp 引起的滚动走完（上限约 5 秒，防止某次 up 丢失后
     * 页码永久冻住）。
     */
    this.freezeAfterPinch(0);
  }

  /** 捏合结束后的页码冻结期（见 endPinch） */
  private freezeAfterPinch(retries: number): void {
    window.clearTimeout(this.pinchReleaseTimer);
    this.pinchReleaseTimer = window.setTimeout(() => {
      if (this.arbiter.touchCountNow > 0 && retries < 20) {
        this.freezeAfterPinch(retries + 1);
        return;
      }
      this.pinchReleaseTimer = 0;
      this.pinchActive = false;
    }, 240);
  }

  /**
   * 平板双指：捏合缩放。
   *
   * ### 为什么用「相对手势起点的总缩放比」
   *
   * 收到的是**绝对量**（当前两指距离 dist、当前中心 cx/cy）。
   * 缩放比 = dist / baseDist —— 一个手势从头到尾只有一个比例，
   * 不会因为事件顺序或丢失而算错。
   *
   * ### 为什么锚点要固定
   *
   * 两指中心在移动时，如果每帧重新 pickAnchor，
   * 锚点就会每帧换一个内容点 —— 视觉上就是「跳页」。
   * 固定锚点后：缩放只改变内容的**大小**，
   * 位置始终由「把锚点对回当前中心」决定。
   *
   * ### 双指平移去哪了
   *
   * 不用单独处理。锚点被对回**当前**中心，
   * 中心移动了多少，内容就跟着平移了多少 ——
   * 这正是双指平移应有的语义。
   */
  private applyPinch(info: PinchInfo): void {
    const pinch = this.pinch;
    if (!pinch) return;

    const scale = info.dist / pinch.baseDist;
    if (Math.abs(scale - 1) < 0.0005) return; // 距离没变，不用动

    const before = this.zoom;
    const after = clamp(pinch.baseZoom * scale, 0.3, 2.8);
    if (after === before) return;

    this.fitMode = false;
    this.zoom = after;
    this.applyLayout();

    // 把固定的锚点对回当前两指中心
    this.restoreAnchor(pinch.anchor, info.cx, info.cy);
    this.measurePageMetrics();
    this.emitState();
  }

  /* ------------------------------- 惯性滚动 ------------------------------- */

  /**
   * 松手后惯性的「加油系数」，按输入方式分。
   *
   * 平板真机反馈：一页 A4 有 1100px 高，甩一下只滑半页，想翻两页得甩好几下。
   * 先后调过两轮：1.0 → 1.6（"还是不够远"）→ 3.0。
   *
   * 只放大**初速**，不动阻尼（0.90/60fps）：
   *   · 距离 ∝ 初速，所以 3.0 倍就是 3 倍距离
   *   · 停止时长 ∝ ln(初速)，3 倍只从 729ms 拖到 907ms
   * 调阻尼也能变远，但那是"延长滑行时间"——实测 0.94 时像在冰上溜，
   * 页面不肯停，人会觉得它不听话。加初速是"更远但不更飘"。
   *
   * 参照：中等力度甩动（约 3px/ms）
   *   · 鼠标 1.0 → 475px / 停 729ms
   *   · 手指 3.0 → 1425px / 停 907ms（一页多）
   */
  private static readonly FLING_GAIN: Record<string, number> = {
    touch: 3,
    pen: 2,
    mouse: 1,
  };

  /**
   * 记一个滚动速度样本。
   *
   * 只保留最近 90ms 的样本：更早的样本代表不了抬手瞬间的真实速度。
   */
  private pushVelSample(y: number, t: number): void {
    const s = this.velSamples;
    s.push({ t, y });
    while (s.length > 2 && t - s[0].t > 90) s.shift();
  }

  /**
   * 起算惯性滚动。
   *
   * @param upY 抬手时最后一次采样的滚动位置
   * @param upT 抬手时的时间戳
   * @param pointerType 手指 / 笔 / 鼠标（决定要不要给惯性加油）
   */
  private startFling(upY: number, upT: number, pointerType = "mouse"): void {
    this.stopFling();

    const s = this.velSamples;
    if (s.length < 2) return;

    /*
     * 取最近一段样本算速度。
     *
     * 用「最后一段位移 / 最后一段耗时」，而不是「总位移 / 总耗时」：
     * 用户收手前通常会减速，总平均会把已经慢下来的速度算高，
     * 结果是页面在手指离开后又猛地窜一下。
     */
    const first = s[0];
    const dt = upT - first.t;
    if (dt <= 8) return; // 样本太密，算不准

    const vel = (upY - first.y) / dt; // px/ms，正数向下
    // 太慢就不甩了：低于 0.05px/ms（约 3px/帧）几乎看不出差别
    if (Math.abs(vel) < 0.05) return;

    const gain = BookEditor.FLING_GAIN[pointerType] ?? 1;
    this.fling = { vel: vel * gain, last: upT, raf: 0 };
    this.fling.raf = requestAnimationFrame(this.stepFling);
  }

  /**
   * 惯性滚动的一帧。
   *
   * 用「按时间衰减」而不是「按帧衰减」：
   * 120Hz 屏和 60Hz 屏的滑动距离必须一样，
   * 按帧衰减会让高刷屏滑得更远。
   */
  private stepFling = (): void => {
    const f = this.fling;
    if (!f) return;

    const now = performance.now();
    const dt = Math.min(64, now - f.last); // 卡顿时钳一下，别一帧跳太远
    f.last = now;

    /*
     * 阻尼 0.90/60fps。
     *
     * 调过三档：
     *   · 0.94 → 滑行 1400ms 才停，手感偏「飘」，像页面在滑冰
     *   · 0.92 → 约 900ms 停住
     *   · 0.90 → 约 600ms 停住 —— 跟系统原生滚动手感接近
     *
     * 判据是「滑多远」而不是「滑多久」：
     * 甩得快就该滑得远（速度正比于初速），
     * 但停下前的**总时长**要短，否则会让人觉得页面没在听指挥。
     */
    const decay = Math.pow(0.9, dt / 16.667);
    f.vel *= decay;

    const el = this.scrollEl;
    const max = el.scrollHeight - el.clientHeight;
    let next = el.scrollTop + f.vel * dt;

    // 撞到边界就停
    if (next <= 0) {
      el.scrollTop = 0;
      this.stopFling();
      return;
    }
    if (next >= max) {
      el.scrollTop = max;
      this.stopFling();
      return;
    }
    el.scrollTop = next;

    // 慢到看不出来就收工（0.03px/ms ≈ 1.8px/帧，肉眼看不动了）
    if (Math.abs(f.vel) < 0.03) {
      this.stopFling();
      return;
    }
    f.raf = requestAnimationFrame(this.stepFling);
  };

  /** 停止惯性滚动 */
  private stopFling(): void {
    const f = this.fling;
    if (!f) return;
    this.fling = null;
    if (f.raf) cancelAnimationFrame(f.raf);
  }

  /** 手势打断了正在写的笔画：整笔撤销，不留半截线 */
  private cancelStroke(): void {
    if (this.gesture === "draw" || this.gesture === "shape") {
      this.draft = null;
      this.draftRec = null;
      this.gesture = "none";
      this.pointerId = null;
      this.smoother.reset();
      const rec = this.recs[this.current];
      if (rec) this.renderOverlay(rec);
    }
  }

  private resizeRec(rec: PageRec): void {
    if (!rec.canvas || !rec.overlay) return;
    const dpr = this.renderDpr();
    const w = Math.round(this.store.data.width * this.zoom * dpr);
    const h = Math.round(this.store.data.height * this.zoom * dpr);
    for (const c of [rec.canvas, rec.overlay]) {
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    }
    rec.ctx = rec.canvas.getContext("2d");
    rec.octx = rec.overlay.getContext("2d");
    const k = dpr * this.zoom;
    rec.ctx?.setTransform(k, 0, 0, k, 0, 0);
    rec.octx?.setTransform(k, 0, 0, k, 0, 0);
    this.renderRec(rec);
    this.renderOverlay(rec);
  }

  private mount(rec: PageRec): void {
    if (rec.mounted) return;
    const page = this.store.data.pages[rec.index];
    if (!page) return;
    const canvas = document.createElement("canvas");
    canvas.className = "mb-canvas";
    const overlay = document.createElement("canvas");
    overlay.className = "mb-overlay";
    rec.pageEl.insertBefore(overlay, rec.pageEl.firstChild);
    rec.pageEl.insertBefore(canvas, overlay);
    /*
     * 文字层夹在笔迹画布和 overlay 之间：
     *   · 必须在 canvas 之后——底图（PDF 位图）就画在 canvas 上，不透明，
     *     放到下面会被整块盖住；
     *   · 必须在 overlay 之前——overlay 是草稿与光标，要压在文字上面。
     */
    const textLayer = document.createElement("div");
    textLayer.className = "mb-textlayer";
    // 层的尺寸跟着页面数据走（A4 是 794×1123，但别把这个数字写死两遍）
    textLayer.style.width = `${this.store.data.width}px`;
    textLayer.style.height = `${this.store.data.height}px`;
    rec.pageEl.insertBefore(textLayer, overlay);
    rec.textLayer = textLayer;
    rec.canvas = canvas;
    rec.overlay = overlay;
    rec.mounted = true;
    this.renderTextLayer(rec);
    this.ensurePageTexts(rec);
    this.resizeRec(rec);
    // 页面重新挂载（卸载过又滚回来）时，选中还在就把属性条挂回去
    if (rec.index === this.current) this.syncTextBar();
  }

  private unmount(rec: PageRec, force = false): void {
    if (!rec.mounted) return;
    // 正在这一页写字时不卸载（会打断笔画）
    if (!force && rec.index === this.current && this.gesture !== "none") return;
    this.commitTextEdit();
    // 属性条挂在这一页的 DOM 上，随页面一起收掉；引用要清，否则会指向死节点
    if (rec.index === this.current) {
      this.textBarEl?.remove();
      this.textBarEl = null;
    }
    rec.canvas?.remove();
    rec.textLayer?.remove();
    rec.overlay?.remove();
    rec.canvas = null;
    rec.textLayer = null;
    rec.overlay = null;
    rec.ctx = null;
    rec.octx = null;
    rec.mounted = false;
    rec.pageEl.style.background = paperBackground(
      this.store.data.pages[rec.index]?.paper || "white"
    );
  }

  private observePages(): void {
    if (typeof IntersectionObserver === "undefined") {
      for (const rec of this.recs) this.mount(rec);
      return;
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const rec = this.recs[Number((entry.target as HTMLElement).dataset.page)];
          if (!rec) continue;
          // 先记 IO 的判定，再决定挂/卸——enforceMountLimit() 要读它
          rec.ioVisible = entry.isIntersecting;
          if (entry.isIntersecting) this.mount(rec);
          else this.unmount(rec);
        }
        // 兜底：挂载数要压回预算内。
        // enforceMountLimit() 只削「已经滚出预挂范围」的页，
        // 绝不碰 ioVisible 的那些（见 PageRec.ioVisible）。
        this.enforceMountLimit();
      },
      { root: this.scrollEl, rootMargin: "600px 0px" }
    );
    for (const rec of this.recs) this.observer.observe(rec.wrap);
    const cur = this.recs[this.current];
    if (cur) this.mount(cur);
  }

  /**
   * 当前缩放 / 像素比下的挂载预算，折算成页数。
   *
   * 按字节预算（160MB）反算，再夹在 [MIN_MOUNTED, MAX_MOUNTED] 之间。
   *
   * ⚠️ 这是**软目标**，不是实际上限：
   * 实际挂载数 = max(limit, IO 预挂范围内的页数)。
   * 范围内的页一票不卸（卸了就是永久空白，见 PageRec.ioVisible），
   * 所以 1.4 倍时范围内 3 页会比 limit=2 多挂一页——这是有意的。
   *
   * 2 倍屏参考值（dpr 被单块上限夹住后）：
   *   - 2.8 倍：一页 122MB → limit 2（预算只够 1，被下限抬起）
   *   - 2.0 倍：一页 109MB → limit 2（同上）
   *   - 1.5 倍：一页 61MB → limit 2
   *   - 1.0 倍：一页 27MB → limit 5
   *   - 0.8 倍及以下：一页 ≤18MB → 撞页数硬上限 8
   *
   * 只在 IntersectionObserver 回调里调，不在滚动帧里——算一次很便宜，
   * 没必要加缓存，加了反而要和 zoom / dpr 的变化手动同步。
   */
  private mountLimit(): number {
    const dpr = this.renderDpr();
    const w = this.store.data.width * this.zoom * dpr;
    const h = this.store.data.height * this.zoom * dpr;
    const perPage = w * h * 4 * 2; // 两块画布，4 字节/像素
    if (!(perPage > 0)) return MIN_MOUNTED;
    const byBytes = Math.floor(MOUNT_BUDGET_BYTES / perPage);
    return clamp(byBytes, MIN_MOUNTED, MAX_MOUNTED);
  }

  /**
   * 保证同时挂载的页数尽量不超预算。
   *
   * 削减顺序按**离视口矩形的像素距离**排，远的先卸。
   * 索引距离不够用：回滚时 current 两侧的页索引差会打平，
   * 稳定排序正好把「下一屏就要看的那页」牺牲掉。
   */
  private enforceMountLimit(): void {
    const limit = this.mountLimit();
    if (this.recs.length <= limit) return;
    const mounted = this.recs.filter((r) => r.mounted);
    if (mounted.length <= limit) return;

    const sr = this.scrollEl.getBoundingClientRect();
    /*
     * 先把每页到视口的像素距离量一次存表，再排序。
     * 不要在 sort 的比较函数里调 getBoundingClientRect：比较函数会被调用
     * O(n log n) 次，每次都强制同步布局——这正是本文件里反复强调
     * 「不要遍历 getBoundingClientRect」的原因。
     */
    const dist = new Map<PageRec, number>();
    for (const rec of mounted) {
      const b = rec.wrap.getBoundingClientRect();
      dist.set(rec, b.bottom < sr.top ? sr.top - b.bottom : b.top > sr.bottom ? b.top - sr.bottom : 0);
    }
    const farthestFirst = (a: PageRec, b: PageRec): number =>
      (dist.get(b) ?? 0) - (dist.get(a) ?? 0);

    /*
     * 只卸「IO 判定不在预挂范围内」的页。
     *
     * 为什么绝不能卸范围内的页：IO 只在跨越交叉阈值时回调。把范围内的页
     * 卸掉之后，它再进入视口时状态没变化，IO 不会二次触发，也没有别的地方
     * 补挂 → 用户会停在一直空白的页上
     * （实测 1.4/1.5 倍回滚必现：可见页 overlap 179px 却 mounted=false，
     * 静置 1.5s 不自愈）。
     * 所以 limit 在这儿是**软目标**：范围内本身就超过 limit 时，宁可爱超。
     */
    const cand = mounted
      .filter((r) => !r.ioVisible && r.index !== this.current)
      .sort(farthestFirst);

    let excess = mounted.length - limit;
    for (const rec of cand) {
      if (excess <= 0) break;
      this.unmount(rec);
      excess--;
    }

    /*
     * 极端兜底：布局塌陷时 IO 可能把几百页全判为可见，
     * 上面那条规则一页都卸不掉，会瞬间吃掉几百 MB 显存——平板上直接闪退。
     * 这种情况下按页数硬上限强卸最远的（范围几何正常时不会走到这里：
     * 同时最多 2-3 页在范围内）。
     */
    if (this.recs.filter((r) => r.mounted).length > MAX_MOUNTED) {
      const rest = this.recs
        .filter((r) => r.mounted && r.index !== this.current)
        .sort(farthestFirst);
      for (const rec of rest) {
        if (this.recs.filter((r) => r.mounted).length <= MAX_MOUNTED) break;
        this.unmount(rec);
      }
    }
  }

  /**
   * 画页面底图（导入的 PDF / Word 页）。
   *
   * PDF 底图是**按需渲染**的：位图没就绪时先画一个占位框，
   * 渲染完再自动补画这一页。用户永远不用等。
   */
  private drawBackground(ctx: CanvasRenderingContext2D, page: Page): void {
    const bg = page.background;
    if (!bg) return;

    // PDF 按需渲染
    if (bg.pdf) {
      this.drawPdfBackground(ctx, page);
      return;
    }

    if (!bg.src) return;
    const img = this.bgImages.get(bg.src);
    if (!img) {
      this.loadBackground(bg.src);
      return;
    }
    if (!img.complete || img.naturalWidth === 0) return;
    ctx.save();
    ctx.drawImage(img, bg.x, bg.y, bg.width, bg.height);
    ctx.restore();
  }

  /**
   * 画布与底图统一使用的设备像素比。
   *
   * 两处必须用同一个值，否则底图会被拉伸/压缩：
   *   - 画布 backing store：794×zoom×dpr
   *   - PDF 位图宽度：bg.width×zoom×dpr
   *
   * 上限按「单张画布的像素预算」算。缩放很大时 dpr 自动下降，
   * 宁可略微软一点，也不能让内存爆掉。
   */
  private renderDpr(): number {
    const raw = Math.min(window.devicePixelRatio || 1, 2);
    const perZoom = this.store.data.width * this.store.data.height * this.zoom * this.zoom;
    if (perZoom <= 0) return raw;
    const maxDpr = Math.sqrt(MAX_CANVAS_PIXELS / perZoom);
    return clamp(Math.min(raw, maxDpr), 0.75, raw);
  }

  /**
   * 画 PDF 底图。
   *
   * 位图是缓存的（LRU），没缓存就发起渲染，渲染完补画。
   * 关键点：渲染在异步进行，主线程不阻塞——所以翻页永远流畅。
   */
  private drawPdfBackground(ctx: CanvasRenderingContext2D, page: Page): void {
    const bg = page.background;
    if (!bg || !bg.pdf) return;

    const key = `${bg.pdf.path}#${bg.pdf.page}`;
    const bmp = this.bgBitmaps.get(key);
    if (bmp) {
      ctx.save();
      ctx.drawImage(bmp, bg.x, bg.y, bg.width, bg.height);
      ctx.restore();
      // 缓存里的分辨率不够（用户又放大了）→ 升级渲染
      const have = this.bgBitmaps.getEntry(key)?.width ?? 0;
      const want = this.pdfTargetWidth(bg);
      if (want > have * 1.25) {
        this.requestPdfBackground(bg.pdf.path, bg.pdf.page, key, want);
      }
      return;
    }

    // 还没渲染好：画个浅灰占位，并发起渲染
    ctx.save();
    ctx.fillStyle = "#F2F1EE";
    ctx.fillRect(bg.x, bg.y, bg.width, bg.height);
    ctx.restore();

    this.requestPdfBackground(bg.pdf.path, bg.pdf.page, key, this.pdfTargetWidth(bg));
  }

  /**
   * 底图在屏幕上占多宽（CSS 像素）。
   *
   * 页面坐标系里底图占 bg.width 宽，缩放后就是 bg.width × zoom。
   */
  private pdfScreenWidth(bg: PageBackground): number {
    return bg.width * this.zoom;
  }

  /**
   * 渲染 PDF 页需要的目标位图宽度（设备像素）。
   *
   * 这就是之前模糊的根源：
   * 旧代码用 `zoom × dpr` 当渲染倍率，但那是**页面坐标**的倍率；
   * PDF 的原生尺寸单位是 **point**（A4 = 595.28pt 宽），
   * 而底图在页面坐标系里占 794 单位宽——中间差了一个 794/595.28 ≈ 1.334
   * 的换算系数。漏掉它，位图就比显示尺寸小 1.33 倍，
   * 被拉伸显示 → 明显发虚。
   *
   * 现在直接算「屏幕上的设备像素宽度」，一步到位：
   *   设备像素宽 = CSS 宽度 × dpr
   * 其中 CSS 宽度已经含了 PDF→页面的换算（bg.width）。
   */
  private pdfTargetWidth(bg: PageBackground): number {
    const dpr = this.renderDpr();
    const css = this.pdfScreenWidth(bg);
    // 封顶：超大图会吃光显存，而且超过 2.8 倍缩放后肉眼也看不出差别
    return Math.min(Math.round(css * dpr), 4096);
  }

  /**
   * 导出时 PDF 页需要的目标位图宽度（设备像素）。
   *
   * 导出画布是 `794×exportScale` 宽，底图在其中占 `bg.width`，
   * 所以位图宽度 = bg.width × exportScale。
   * 注意这里**不乘 dpr**——导出是生成文件，不受屏幕像素比影响。
   */
  private pdfExportWidth(bg: PageBackground, exportScale: number): number {
    return Math.min(Math.round(bg.width * exportScale), MAX_EXPORT_PX);
  }

  /**
   * 请求渲染某页 PDF。渲染完成后重画对应的页。
   *
   * 同一页只会有一个进行中的渲染请求（bgPending 去重），
   * 快速来回翻页也不会重复光栅化。
   *
   * @param targetPx 目标位图宽度（设备像素）。传入更大的值会替换掉旧的。
   */
  private requestPdfBackground(
    pdfPath: string,
    pageNo: number,
    key: string,
    targetPx: number
  ): void {
    // 记录「这一页想要多清晰」——永远取最大值
    const want = Math.max(this.bgTarget.get(key) ?? 0, targetPx);
    this.bgTarget.set(key, want);
    // 已经在渲染了：渲染结束后会检查是否达标
    if (this.bgRendering.has(key)) return;
    this.bgRendering.add(key);

    void (async () => {
      try {
        const doc = await this.openPdfDoc(pdfPath);
        for (;;) {
          const need = this.bgTarget.get(key) ?? 0;
          const have = this.bgBitmaps.getEntry(key)?.width ?? 0;
          // 已经够清晰了 → 收工
          if (have > 0 && need <= have * 1.15) break;
          const rendered = await renderPdfPage(doc, pageNo, Math.max(need, 64));
          this.bgBitmaps.set(key, rendered.bitmap, rendered.bitmap.width);
          this.markBgDirty(pdfPath, pageNo);
          // 渲染期间目标又变高 → 继续渲染更清晰的
          if ((this.bgTarget.get(key) ?? 0) <= rendered.bitmap.width * 1.15) break;
        }
      } catch (e) {
        console.error("[inkbook] PDF 页渲染失败", e);
      } finally {
        this.bgRendering.delete(key);
      }
    })();
  }

  /** 打开（或复用）一份 PDF 文档 */
  private openPdfDoc(pdfPath: string): Promise<PdfDoc> {
    let p = this.pdfDocs.get(pdfPath);
    if (!p) {
      const url = this.resolveAssetUrl(pdfPath);
      p = openPdf(url).catch((e) => {
        // 失败就别缓存，下次重试
        this.pdfDocs.delete(pdfPath);
        throw e;
      });
      this.pdfDocs.set(pdfPath, p);
    }
    return p;
  }

  /** 某页 PDF 渲染好了，标脏以便重画 */
  private markBgDirty(pdfPath: string, pageNo: number): void {
    for (const rec of this.recs) {
      const bg = this.store.data.pages[rec.index]?.background;
      if (bg?.pdf && bg.pdf.path === pdfPath && bg.pdf.page === pageNo) {
        this.bgDirty.add(rec.index);
      }
    }
    if (this.bgDirty.size) {
      requestAnimationFrame(() => {
        const dirty = Array.from(this.bgDirty);
        this.bgDirty.clear();
        for (const i of dirty) {
          const rec = this.recs[i];
          if (!rec || !rec.mounted) continue;
          this.renderRec(rec);
          this.renderOverlay(rec);
        }
      });
    }
  }

  /** 异步加载底图，加载完重画所在页 */
  private loadBackground(src: string): void {
    if (this.bgLoading.has(src) || this.bgImages.has(src)) return;
    this.bgLoading.add(src);
    const img = new Image();
    // 底图存在库里，用 app:// 协议读
    img.onload = () => {
      this.bgLoading.delete(src);
      this.bgImages.set(src, img);
      for (const rec of this.recs) {
        const page = this.store.data.pages[rec.index];
        if (page?.background?.src === src) {
          this.renderRec(rec);
          this.renderOverlay(rec);
        }
      }
      // 侧栏缩略图也要补一次：它第一次画的时候图片还没加载完
      const thumbCb = this.opts.onThumbNeedsRedraw;
      if (thumbCb) {
        for (let i = 0; i < this.store.data.pages.length; i += 1) {
          if (this.store.data.pages[i].background?.src === src) thumbCb(i);
        }
      }
    };
    img.onerror = () => {
      this.bgLoading.delete(src);
    };
    img.src = this.resolveAssetUrl(src);
  }
  /** 把库内相对路径转成可加载的 URL */
  private resolveAssetUrl(src: string): string {
    const app: any = this.opts.app;
    const adapter = app?.vault?.adapter;
    if (adapter?.getResourcePath) {
      try {
        return adapter.getResourcePath(src);
      } catch (_) {}
    }
    // 兜底：直接当相对路径
    return src;
  }

  renderRec(rec: PageRec): void {
    const page = this.store.data.pages[rec.index];
    if (!page || !rec.ctx) return;
    const ctx = rec.ctx;
    ctx.clearRect(0, 0, this.store.data.width, this.store.data.height);
    drawPaper(ctx, page.template, page.paper, this.store.data.width, this.store.data.height, 1);
    this.drawBackground(ctx, page);
    for (const layer of page.layers) {
      if (!layer.visible) continue;
      for (const stroke of layer.strokes) drawStroke(ctx, stroke, layer.opacity);
    }
  }

  /** 实时预览用的笔迹：真实点 + 预测尾巴 */
  private previewStroke(): Stroke | null {
    const draft = this.draft;
    if (!draft) return null;
    if (this.opts.prediction === false) return draft;
    if (draft.tool === "highlighter" || draft.tool === "shape") return draft;
    if (draft.points.length < 2) return draft;
    const tail = predictTail(draft.points, 3, 0.7, 24);
    if (!tail.length) return draft;
    return { ...draft, points: draft.points.concat(tail) };
  }

  private renderOverlay(rec: PageRec): void {
    if (!rec.octx) return;
    const ctx = rec.octx;
    const w = this.store.data.width;
    const h = this.store.data.height;
    ctx.clearRect(0, 0, w, h);
    if (rec.index !== this.current) return;

    if (this.draft && this.draftRec === rec) {
      // 实时预览带上预测尾巴：墨迹跑在笔尖前面一点，落笔更跟手
      const preview = this.previewStroke();
      if (preview) drawStroke(ctx, preview);
    }

    if (this.hoverPos && this.gesture === "none") {
      const h = this.hoverPos;
      const r = Math.max(3, (this.penSize * (0.35 + h.p * 0.65)) / 2);
      ctx.save();
      ctx.beginPath();
      ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(28,28,32,0.34)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1 / this.zoom;
      ctx.stroke();
      ctx.restore();
    }

    if (this.eraserPos) {
      const e = this.eraserPos;
      ctx.save();
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.fill();
      ctx.strokeStyle = "rgba(60,60,60,0.7)";
      ctx.lineWidth = 1 / this.zoom;
      ctx.stroke();
      ctx.restore();
    }

    /*
     * 选中文字的虚线框。
     *
     * 画在 overlay 而不是用 DOM：overlay 本来就按页面坐标缩放好了，
     * 缩放、滚动都不用管；而且它压在文字层之上，框不会被字盖住。
     */
    const sel =
      this.tool === "text" || this.tool === "select" ? this.selectedText : null;
    if (sel) {
      /*
       * 位置和高度都按**排版后**的几何：折了行的长批注有好几行，
       * 越界的老批注还会被夹回纸内——框要跟着走，否则框在纸外、字在纸内。
       */
      const l = this.textLayout(sel);
      const bw = Math.max(24, this.measureTextWidth(sel, l.lines));
      const top = l.y - sel.size * 1.18;
      const bh = l.lineHeight * Math.max(1, l.lines.length) + sel.size * 0.24;
      ctx.save();
      ctx.strokeStyle = "#6C5CE7";
      ctx.lineWidth = 1.4 / this.zoom;
      ctx.setLineDash([5 / this.zoom, 4 / this.zoom]);
      ctx.strokeRect(l.x - 3, top, bw + 8, bh);
      ctx.restore();
    }
  }

  /* ------------------------------- 文字层 ------------------------------- */

  /**
   * 按页数据重建文字层的 DOM。
   *
   * 每段文字一个绝对定位的 span，坐标直接用**页面坐标系**，
   * 整层再用 CSS 变量 --mb-zoom 缩放——这样缩放时不用重算每个字的位置。
   *
   * PDF 原文是透明的：视觉上的字由底图位图承担，这层只负责
   * 「能被选中、能被复制、能被搜到」。用户添加的文字才真正显示颜色。
   */
  private renderTextLayer(rec: PageRec): void {
    const layer = rec.textLayer;
    if (!layer) return;
    layer.textContent = "";
    const page = this.store.data.pages[rec.index];
    const texts = page?.texts;
    if (!texts || !texts.length) return;

    for (const t of texts) {
      const el = document.createElement("span");
      el.className = "mb-text " + (t.source === "user" ? "is-user" : "is-pdf");
      /*
       * PDF 原文每行末尾补一个换行：拖选多行时复制出来才是分开的句子。
       * 绝对定位的 span 之间浏览器不会自动插入分隔符，不补就成了
       * "Line 0 of page 1Line 1 of page 1" 一长串。
       * 用户文字不补——它自己的 \n 就是用户想要的换行。
       */
      el.textContent = t.text + (t.source === "pdf" ? "\n" : "");
      el.dataset.id = t.id;
      el.style.left = `${t.x}px`;
      el.style.top = `${t.y}px`;
      el.style.fontSize = `${t.size}px`;
      el.style.fontFamily = textFontStack(t.font);
      // 数据里 y 是基线，span 的定位点是顶边，往上挪约 0.82 个字高
      el.style.transform = "translateY(-0.82em)";
      if (t.source === "user") {
        el.style.color = t.color || "#1A1A1A";
        if (t.bold) el.style.fontWeight = "600";
        /*
         * 长批注在屏幕上也要按纸宽折行。
         *
         * 之前 span 不设宽度，一直往右长，超出纸面的部分被 .mb-textlayer
         * 的 overflow:hidden 吃掉——屏幕上就已经"少半句"了，只是没人细看。
         * 宽度定成可用宽度交给 CSS 的 pre-wrap 折；位置也用**排版后**的
         * x/y（越界的老批注会被夹回纸内），这样屏幕和导出看到的是同一份排版。
         * 折行后的行距要跟画布/导出对齐（TEXT_LINE_HEIGHT），
         * 所以 transform 用 0.82 + 半个行距补偿基线上移。
         */
        const l = this.textLayout(t);
        el.style.left = `${l.x}px`;
        el.style.top = `${l.y}px`;
        el.style.width = `${this.textAvailWidth(l.x)}px`;
        el.style.lineHeight = String(TEXT_LINE_HEIGHT);
        el.style.transform = `translateY(-${0.82 + (TEXT_LINE_HEIGHT - 1) / 2}em)`;
      }
      layer.appendChild(el);
    }
  }

  /**
   * 给老本子补抽文字层。
   *
   * v2 之前的本子只记了「这页来自哪个 PDF」，没有 texts。
   * 翻到这一页时后台抽一次并存下来，用户不用重新导入。
   * 判别用「texts 是不是数组」而不是「有没有内容」：
   * 抽过但没文字（扫描版）要写空数组，否则每次挂载都白抽一遍。
   */
  private ensurePageTexts(rec: PageRec): void {
    const page = this.store.data.pages[rec.index];
    const pdf = page?.background?.pdf;
    if (!pdf) return;
    if (Array.isArray(page.texts)) return;
    if (this.textExtracting.has(rec.index)) return;
    this.textExtracting.add(rec.index);

    void (async () => {
      try {
        const doc = await this.openPdfDoc(pdf.path);
        const [lines, size] = await Promise.all([
          extractPdfText(doc, pdf.page),
          pdfPageSize(doc, pdf.page),
        ]);
        const target = this.store.data.pages[rec.index];
        const bg = target?.background;
        if (!target || !bg || Array.isArray(target.texts)) return;
        const sx = size.width > 0 ? bg.width / size.width : 1;
        const sy = size.height > 0 ? bg.height / size.height : 1;
        target.texts = lines.map((l) => ({
          id: uid("text"),
          source: "pdf" as const,
          x: bg.x + l.x * sx,
          y: bg.y + l.y * sy,
          size: Math.max(1, l.size * sy),
          text: l.text,
          width: Math.max(0, l.width * sx),
        }));
        const live = this.recs[rec.index];
        if (live) this.renderTextLayer(live);
        this.store.touch();
        this.changed();
      } catch (_) {
        // 抽不出来（PDF 被移走 / 扫描版）：记一个空数组，别每次挂载都重试
        const target = this.store.data.pages[rec.index];
        if (target && !Array.isArray(target.texts)) target.texts = [];
      } finally {
        this.textExtracting.delete(rec.index);
      }
    })();
  }

  /** 这段批注在屏幕上用的 CSS font 串（屏幕测量、画布绘制共用） */
  private textFontCss(t: { size: number; font?: string; bold?: boolean }): string {
    return `${t.bold ? "600 " : ""}${t.size}px ${textFontStack(t.font)}`;
  }

  /**
   * 批注可用的横向宽度（页面坐标）。
   *
   * 规则在 textwrap 里（屏幕/画布/导出共用一份），这里只是把本子的纸宽喂进去。
   */
  private textAvailWidth(x: number): number {
    return availableTextWidth(this.store.data.width, x);
  }

  /**
   * 一段批注的最终排版（折行 + 位置夹取）。
   *
   * 渲染、命中判定、选中框、属性条、编辑框全部走这一份结果——
   * 各算各的必然出现「看着两行、点不中第二行」，或者屏幕上在纸内、
   * 导出的 PDF 里下面几行掉到页外。
   * 生产环境里 measure 用模块级那块离屏 canvas，没有 canvas 时退回硬换行。
   */
  private textLayout(t: {
    x: number;
    y: number;
    size: number;
    text: string;
    font?: string;
    bold?: boolean;
  }): TextLayout {
    const ctx = measureContext(this.textFontCss(t));
    if (!ctx) {
      const lines = String(t.text ?? "").split("\n");
      return { x: t.x, y: t.y, lines, lineHeight: t.size * TEXT_LINE_HEIGHT };
    }
    return layoutUserText(
      t,
      this.store.data.width,
      this.store.data.height,
      (s) => ctx.measureText(s).width
    );
  }

  /**
   * 折行后的行数组（页面坐标）。
   *
   * 多数调用方只关心「断在哪」，不想要整个 TextLayout，所以留这个薄入口；
   * 排版规则仍然只有 textLayout 一份。
   */
  private textLines(t: {
    x: number;
    y: number;
    size: number;
    text: string;
    font?: string;
    bold?: boolean;
  }): string[] {
    return this.textLayout(t).lines;
  }

  /**
   * 一段批注的宽度（页面坐标），取折行后最宽的那行。
   *
   * 原来是 `字数 × 字号 × 0.62` 估的：中文实际接近 1 个字宽，
   * 0.62 严重低估，选中框和编辑框只有实际宽度的一半多点。
   * 现在按真实字体测量，量出来就是画出来/导出时占的宽度。
   */
  private measureTextWidth(t: PageText, lines?: string[]): number {
    // PDF 原文带的是抽出来的真实行宽，比重新量一遍准（也省一次测量）
    if (t.source === "pdf" && t.width) return t.width;
    const ctx = measureContext(this.textFontCss(t));
    const text = String(t.text ?? "");
    if (!ctx) return Math.max(1, text.length * t.size * 0.62);
    let max = 0;
    for (const line of lines ?? this.textLines(t)) {
      max = Math.max(max, ctx.measureText(line).width);
    }
    return Math.max(1, max);
  }

  private hitText(texts: PageText[], x: number, y: number): PageText | null {
    for (let i = texts.length - 1; i >= 0; i--) {
      const t = texts[i];
      if (t.source !== "user") continue;
      /*
       * 命中区要按**排版后**的几何算，不能按数据里的 x/y：
       * 越界的老批注渲染时被夹回纸内了，命中区还留在纸外的话，
       * 用户点得到字却选不中（或者反过来）。
       */
      const l = this.textLayout(t);
      const w = this.measureTextWidth(t, l.lines);
      const top = l.y - t.size * 1.18;
      const h = t.size * 1.6 * Math.max(1, l.lines.length);
      if (x >= l.x - 3 && x <= l.x + w + 8 && y >= top && y <= top + h) return t;
    }
    return null;
  }

  /**
   * 开始编辑：点在已有文字上就改它，点在空白处就新建。
   *
   * 编辑框是页面里的一个 textarea，位置按当前缩放换算——
   * 所见即所得，提交后交给文字层渲染。
   */
  /**
   * 选择工具下点了一下页面：选中 + 准备拖动，双击进编辑。
   *
   * 为什么单独做一个工具而不是扛在文字工具上：
   * 文字工具的第一下必须是「新建」，否则想随手加一段字就得先点空白。
   * 选择和移动是另一种意图，混在一起两边都不好用。
   */
  private handleSelectPointer(rec: PageRec, px: number, py: number, e: PointerEvent): void {
    if (this.readOnly) return;
    const page = this.store.data.pages[rec.index];
    if (!page) return;
    const hit = this.hitText(page.texts ?? [], px, py);

    if (!hit) {
      this.selectText(null);
      return;
    }
    this.selectText(hit.id);
    this.gesture = "moveText";
    this.pointerId = e.pointerId;
    /*
     * 拖动起点用**屏幕上看到的位置**（排版后的 x/y），不是数据里的原值：
     * 越界的老批注渲染时已经被夹回纸内，如果按数据的 x 起算，
     * 一开始拖就会"往回跳"或者几像素内完全不动。
     */
    const l = this.textLayout(hit);
    this.moveText = {
      rec,
      id: hit.id,
      startX: px,
      startY: py,
      originX: l.x,
      originY: l.y,
      moved: false,
    };
    try {
      rec.pageEl.setPointerCapture?.(e.pointerId);
    } catch (_) {}
    e.preventDefault();
  }

  /**
   * 文字工具下点了一下页面。
   *
   * 三种情况，按"最不容易误操作"排序：
   *   · 点在空白处 → 取消选中，直接开一个新输入框（这是最常见的动作）
   *   · 点在没选中的文字上 → **只选中**，浮出属性条（改字号/字体/颜色/删除）
   *   · 点在已选中的文字上 → 进入编辑（第二下才是改内容，避免一点就弹框）
   */
  private handleTextPointer(rec: PageRec, px: number, py: number): void {
    if (this.readOnly) return;
    const page = this.store.data.pages[rec.index];
    if (!page) return;
    const hit = this.hitText(page.texts ?? [], px, py);

    if (!hit) {
      this.selectText(null);
      this.beginTextEdit(rec, px, py);
      return;
    }
    if (this.selectedTextId === hit.id) {
      // 用文字内部坐标，保证 beginTextEdit 里的命中判定还能选中它
      this.beginTextEdit(rec, hit.x + 4, hit.y - hit.size * 0.4);
      return;
    }
    this.selectText(hit.id);
  }

  private beginTextEdit(rec: PageRec, px: number, py: number): void {
    if (this.readOnly) return;
    this.commitTextEdit();
    const page = this.store.data.pages[rec.index];
    if (!page) return;

    const hit = this.hitText(page.texts ?? [], px, py);
    const size = hit?.size ?? this.textSizeValue;
    const color = hit?.color ?? this.textColorValue;
    const font = hit?.font ?? this.textFontValue;
    /*
     * 新建时的位置要先夹一下，否则"打出来的字不完整"从第一秒就注定了：
     *   · 横向：点击点贴着右边缘时可用宽度只剩几十像素，甚至一个字都放不下，
     *     存进去的就是一列竖字或者干脆在纸外；
     *   · 纵向：点击点贴近页底时基线就在页脚，折行后下面几行整行掉出纸外。
     * 夹取规则跟渲染共用 layoutUserText（单行时的 yMax 就是"最后一行在纸内"）。
     */
    const layout = hit
      ? this.textLayout(hit)
      : this.textLayout({
          x: Math.min(px, maxTextStartX(this.store.data.width)),
          y: py + size * 0.82,
          size,
          text: "",
          font,
        });
    const x = layout.x;
    const y = layout.y;

    const ta = document.createElement("textarea");
    ta.className = "mb-text-edit";
    ta.spellcheck = false;
    ta.value = hit?.text ?? "";
    ta.style.fontFamily = textFontStack(font);
    ta.style.fontSize = `${size * this.zoom}px`;
    ta.style.lineHeight = String(TEXT_LINE_HEIGHT);
    ta.style.color = color;
    ta.style.left = `${x * this.zoom}px`;
    ta.style.top = `${(y - size * 0.82) * this.zoom}px`;
    /*
     * 编辑框宽度不再是「min-width 140 / 撑到内容有多宽」。
     *
     * 以前只给 min-width（140px），textarea 的 `white-space: pre` 又不折行，
     * 于是长句一路向右滚、看着像打完了，提交后超出纸面的部分才被裁掉
     * ——用户看到的就是「导出后那段字不完整」。
     * 现在按可用宽度定死 + CSS 用 pre-wrap，框里折在哪、提交后就折在哪。
     * 补 TEXT_EDIT_CHROME 是因为 CSS 用 border-box：内边距会吃掉内容宽度。
     */
    const avail = this.textAvailWidth(x);
    /*
     * 新建：给个不算窄的初始框；改已有文字：至少放得下它自己。
     * 本来要折行的长批注直接给满可用宽度——只有宽度等于可折行宽度，
     * 框里断字的位置才跟提交后的渲染一致（这是这个 bug 的关键）。
     * 两者都封顶 avail，不顶出纸面。
     */
    const wantW = hit
      ? Math.min(avail, Math.max(TEXT_EDIT_WIDTH, this.measureTextWidth(hit) + 24))
      : Math.min(avail, TEXT_EDIT_WIDTH);
    ta.style.width = `${wantW * this.zoom + TEXT_EDIT_CHROME}px`;
    rec.pageEl.appendChild(ta);

    this.textEdit = { rec, el: ta, id: hit?.id ?? null, x, y, size, color, font };

    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      this.commitTextEdit(save);
    };

    // 编辑框里的手势不交给画布（否则点一下会顺手画一笔）
    ta.addEventListener("pointerdown", (e) => e.stopPropagation());
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        finish(true);
      }
    });
    ta.addEventListener("blur", () => finish(true));
    // 高度跟着内容长，别让两行字挤在一行的高度里
    ta.addEventListener("input", () => {
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
    });

    requestAnimationFrame(() => {
      ta.focus();
      ta.select();
      ta.style.height = `${ta.scrollHeight}px`;
    });
  }

  /** 收掉编辑框。save=false 用于 Esc / 页面被卸载时丢弃 */
  private commitTextEdit(save = true): void {
    const ed = this.textEdit;
    if (!ed) return;
    this.textEdit = null;
    const value = ed.el.value.replace(/\s+$/g, "");
    ed.el.remove();
    if (!save) return;

    const rec = ed.rec;
    const page = this.store.data.pages[rec.index];
    if (!page) return;
    const arr = page.texts ?? [];
    const old = ed.id ? arr.find((t) => t.id === ed.id) : undefined;

    /*
     * 改的是"已有文字"，但数组里已经没有它了（撤销、快照恢复把 texts 整个换掉了）。
     * 这时如果继续走下面的"新建"分支，就会用新 id 把这段字复活成**第二条**——
     * 用户按了 Esc/撤销，纸上却多出一个副本。宁可丢掉这次输入。
     */
    if (ed.id && !old) return;

    if (old) {
      if (!value) {
        this.store.snapshotPage(rec.index);
        page.texts = arr.filter((t) => t.id !== old.id);
      } else if (value !== old.text) {
        this.store.snapshotPage(rec.index);
        old.text = value;
      } else {
        return; // 没改动
      }
    } else if (value) {
      this.store.snapshotPage(rec.index);
      const item: PageText = {
        id: uid("text"),
        source: "user",
        x: ed.x,
        y: ed.y,
        size: ed.size,
        color: ed.color,
        font: ed.font,
        text: value,
      };
      page.texts = arr.concat(item);
    } else {
      return; // 新建但没输入
    }

    this.store.touch();
    this.changed();
    this.renderTextLayer(rec);
    this.emitState();
  }

  /**
   * 导出时把用户添加的文字画进位图。
   *
   * PDF 原文不用画：底图位图里已经有那些字了。
   * 用户文字不画就会"导出的文件里少了字"，这是必须补的一步。
   */
  private drawUserTexts(ctx: CanvasRenderingContext2D, page: Page): void {
    const texts = page.texts?.filter((t) => t.source === "user");
    if (!texts || !texts.length) return;
    for (const t of texts) {
      ctx.save();
      ctx.fillStyle = t.color || "#1A1A1A";
      ctx.font = this.textFontCss(t);
      ctx.textBaseline = "alphabetic";
      /*
       * 排版（折行 + 位置夹取）走 textwrap 里那唯一一份规则。
       *
       * 不折行的话长句会一路画到画布外——画布宽度就是纸宽，超出的部分
       * 直接被裁掉，导出的 PDF 里那段字就"不完整"了；只折行不夹 y 的话，
       * 页底的长批注会折成好几行，下面几行整行掉到纸外，一样是丢字。
       *
       * 单位说明：这块 ctx 已经按 zoom×dpr scale 过，measureText 返回的是
       * **页面坐标**下的宽度（跟 t.x、t.size、纸宽同一套单位），
       * 所以不用再乘缩放。
       */
      const l = this.textLayout(t);
      for (let i = 0; i < l.lines.length; i++) {
        if (!l.lines[i]) continue;
        ctx.fillText(l.lines[i], l.x, l.y + i * l.lineHeight);
      }
      ctx.restore();
    }
  }

  private scheduleOverlay(rec: PageRec): void {
    if (this.overlayRaf) return;
    this.overlayRaf = requestAnimationFrame(() => {
      this.overlayRaf = 0;
      if (rec.mounted) this.renderOverlay(rec);
    });
  }

  /* ------------------------------- 坐标与压力 ------------------------------- */

  private pointFromEvent(e: PointerEvent, rec: PageRec): Pt {
    const r = rec.pageEl.getBoundingClientRect();
    const k = this.store.data.width / (r.width || 1);
    return [
      (e.clientX - r.left) * k,
      (e.clientY - r.top) * k,
      0.5,
    ];
  }

  /** 原始坐标 → 滤波后坐标。手抖没了，线条才干净。 */
  private filteredPoint(e: PointerEvent, rec: PageRec): Pt {
    const raw = this.pointFromEvent(e, rec);
    const smooth = this.opts.smoothing ?? 0.55;
    if (smooth <= 0.02) return raw;
    // 平滑强度映射到 1€ 滤波器的 minCutoff：越强越稳
    const minCutoff = 0.6 + (1 - smooth) * 3.4;
    this.smoother.configure(minCutoff, 0.012 + smooth * 0.05, 1.0);
    const out = this.smoother.filter(raw[0], raw[1], e.timeStamp || performance.now());
    return [out.x, out.y, 0.5];
  }

  private pressureFor(e: PointerEvent, dist: number, dt: number): number {
    if (this.tool === "ballpoint") return 0.62;
    // 速度：页面单位 / 毫秒
    const speed = dist / Math.max(1, dt);
    this.lastSpeed = speed;

    let raw: number;
    if (e.pointerType === "pen") {
      // 数位笔：设备压力为主，速度做一点补充（写快了自然细一点）
      const p = e.pressure > 0 ? e.pressure : 0.5;
      const vel = clamp(1 - speed / 2.6, 0.55, 1);
      raw = p * 0.86 + vel * 0.14;
    } else {
      // 鼠标 / 手指：没有压力，用速度反推力度，写得慢=重、写得快=轻
      raw = clamp(0.92 - speed * 0.34, 0.24, 0.95);
    }

    // 压感曲线整形：让轻到中等压力的区分度更高，重按趋于饱和
    const sens = this.opts.pressure ?? 1;
    raw = shapePressure(raw, sens);

    // 速度—粗细联动：快笔收窄，避免飞白成一团
    raw *= speedWidthFactor(speed);

    if (this.lastPressure != null) raw = this.lastPressure * 0.28 + raw * 0.72;
    this.lastPressure = raw;
    return clamp(raw, 0.04, 1);
  }

  /**
   * 安装「左缘右滑」拦截器。
   *
   * 判定条件（三条同时满足才拦）：
   *   1. 起点在视口左缘 26px 以内（只有从边缘起手才算系统手势）
   *   2. 位移以水平为主（|dx| > |dy| * 1.4）
   *   3. 位移总量超过 42px（够得着触发阈值）
   *
   * 第 2、3 条是关键：不加的话，在纸中间正常写字也会被拦，
   * 手势仲裁器和双指缩放会一起失灵。
   */
  private installEdgeSwipeGuard(): void {
    this.uninstallEdgeSwipeGuard();

    const guard = this.edgeGuard;

    /** 事件是不是发生在编辑区内 */
    const inEditor = (e: Event): boolean => {
      const t = e.target as Node | null;
      return !!t && this.scrollEl.contains(t);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (!inEditor(e) || e.touches.length !== 1) {
        guard.armed = false;
        return;
      }
      const t = e.touches[0];
      const left = this.scrollEl.getBoundingClientRect().left;
      // 起点必须贴着左缘（宿主弹出文件列表的触发区）
      guard.armed = t.clientX - left < 26 && t.clientX - left >= -4;
      guard.x0 = t.clientX;
      guard.y0 = t.clientY;
      guard.active = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!guard.armed || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - guard.x0;
      const dy = t.clientY - guard.y0;

      // 横向为主 + 够长 → 这是宿主要认的「右滑」
      if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        guard.active = true;
        /*
         * 只 stopPropagation，不 preventDefault。
         *
         * preventDefault 会连带禁掉浏览器原生的滚动，
         * 纵向滚动必须照常能用；
         * 而我们要的只是「别让宿主看见这次滑动」。
         *
         * stopImmediatePropagation 是为了防住**同一个节点**上的其他
         * 监听器——宿主有可能也挂在 window 上。
         */
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (guard.active) {
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
      guard.armed = false;
      guard.active = false;
    };

    /*
     * 记录「从左缘起手」的时刻，供派发层判断这次滑动是不是写字误触。
     *
     * 用 pointerdown 而不是 touchstart：触控笔在部分安卓机上只派发 pointer 系列，
     * 只监听 touch 会漏掉笔（这正是上一版在真机上失效的原因之一）。
     * 左缘区间给到 48px：宿主的滑动识别区贴着屏幕左边，笔尖落点常有几像素误差。
     */
    const onPointerDown = (e: PointerEvent) => {
      if (!inEditor(e)) return;
      const left = this.scrollEl.getBoundingClientRect().left;
      /*
       * 两个条件满足其一就算「贴着左缘起手」：
       * - 距容器左边 0~48px：纸张贴着屏幕左边时的正常情况；
       * - 屏幕坐标 <= 48px：容器本身有内缩（页面居中、侧栏留白）时，
       *   宿主的滑动识别区仍然贴屏幕边，只按容器坐标算会漏掉。
       */
      const nearContainer = e.clientX - left >= -4 && e.clientX - left <= 48;
      const nearScreen = e.clientX <= 48;
      if (nearContainer || nearScreen) this.edgeSwipeAt = Date.now();
    };

    /*
     * 挂在 window 的**捕获阶段**——整条事件路径上第一个执行。
     *
     * 挂在这一层只能挡住「比我们晚注册」的监听器。宿主的滑动监听在插件加载前
     * 就挂好了，所以真实环境里这条链挡不住它——真正的拦截在 main.ts 的派发层。
     * 这里保留，是为了让能挡的那部分（原生滚动、其他插件）少走一遍。
     */
    const opts = { capture: true, passive: false } as const;
    window.addEventListener("pointerdown", onPointerDown, opts);
    window.addEventListener("touchstart", onTouchStart, opts);
    window.addEventListener("touchmove", onTouchMove, opts);
    window.addEventListener("touchend", onTouchEnd, opts);
    window.addEventListener("touchcancel", onTouchEnd, opts);

    this.guardTeardown = () => {
      window.removeEventListener("pointerdown", onPointerDown, opts);
      window.removeEventListener("touchstart", onTouchStart, opts);
      window.removeEventListener("touchmove", onTouchMove, opts);
      window.removeEventListener("touchend", onTouchEnd, opts);
      window.removeEventListener("touchcancel", onTouchEnd, opts);
    };
  }

  /**
   * 最近是否发生过「贴着容器左缘起手」的指针动作。
   *
   * 给 main.ts 的派发层用：宿主的滑动识别发生在它自己的监听器里，我们拦不住
   * （它的监听器比插件注册得早），只能等它派发 swipe 事件时再吞。900ms 足够覆盖
   * 一次滑动手势从起手到识别的全过程。
   */
  edgeSwipeRecent(ms = 900): boolean {
    return this.edgeSwipeAt > 0 && Date.now() - this.edgeSwipeAt <= ms;
  }

  private uninstallEdgeSwipeGuard(): void {
    this.guardTeardown?.();
    this.guardTeardown = null;
  }

  /** 设置里切换「写字时屏蔽右滑」时调用；重复调用必须安全（内部会先卸再装）。 */
  setEdgeSwipeBlock(on: boolean): void {
    this.opts.edgeSwipeBlock = on;
    if (on) this.installEdgeSwipeGuard();
    else this.uninstallEdgeSwipeGuard();
  }

  /** 设置里切换「自动把直线画直」时调用 */
  setStraighten(on: boolean): void {
    this.straighten = on;
  }

  private applyTouchAction(): void {
    // 用 docEl 上的 data 属性统一控制工具态，CSS 里靠继承生效——
    // 逐页写的话几百页时每次切换工具都要几百次样式写入。
    this.docEl.dataset.tool = this.tool;
    /*
     * 写入模式：**touch-action: none**。
     *
     * 以前是 `pan-x pan-y`，本意是"手指始终允许滚动"。但那会让浏览器
     * 也参与滚动：单指拖动时我们的 pan 在改 scrollTop、浏览器原生滚动
     * 同时也在跑，两边叠加；双指捏合时浏览器还会自己平移一把，和我们的
     * 锚点补偿抢同一块画布——真机上的「捏合时页面跳」有一半是它干的。
     * 更糟的是原生滚动一启动，浏览器就发 pointercancel 把手势抢走，
     * 我们这边的 pan / pinch 直接断在半路。
     *
     * 滚动本来就是我们自己实现的（BookEditor.pan，1:1 跟手 + 自算惯性），
     * 禁掉原生滚动不会丢能力，反而让手势只有一个主人。
     *
     * 阅读模式例外：文字层要能拖选、要能长按选词，那些是浏览器原生能力，
     * 必须放开；此时滚动也交给浏览器（handlePointer 里不再接管触摸）。
     */
    this.docEl.style.touchAction = this.readOnly ? "auto" : "none";
  }

  /**
   * 切换仅阅读模式。
   *
   * 进阅读模式时收掉未完成的笔画：手势已经失效，
   * 留着半截草稿会让人以为还能继续写。
   */
  setReadOnly(on: boolean): void {
    if (this.readOnly === on) return;
    this.readOnly = on;
    if (on) {
      this.cancelStroke();
      this.commitTextEdit();
    }
    // 阅读模式要放开原生手势（选字），退出时要收回——touch-action 跟着变
    this.applyTouchAction();
    this.emitState();
  }

  /** 是否允许手指书写 */
  setTouchDraw(on: boolean): void {
    this.touchDraw = on;
    this.applyTouchAction();
    this.emitState();
  }

  /* ------------------------------- 指针 ------------------------------- */

  /** 把 PointerEvent 转成仲裁器用的信息 */
  private pointerInfo(e: PointerEvent): PointerInfo {
    const t =
      e.pointerType === "pen" ? "pen" : e.pointerType === "touch" ? "touch" : "mouse";
    return { id: e.pointerId, type: t, x: e.clientX, y: e.clientY, pressure: e.pressure };
  }

  private onDown(e: PointerEvent, rec: PageRec): void {
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) return;

    /*
     * 新的按下立刻打断惯性。
     *
     * 用户想在滑行中抓住页面停下来，就必须一碰就停，
     * 否则手指已经按下了页面还在自己跑，手感非常别扭。
     */
    this.stopFling();
    this.velSamples = [];

    // 手势仲裁：笔优先；笔活动期间的手指视为掌根；双指进入手势
    const role = this.arbiter.down(this.pointerInfo(e));
    this.role = role;

    if (role === "ignore") return;
    if (role === "gesture") {
      e.preventDefault();
      return;
    }
    if (role === "pan") {
      // 单指：默认滚动页面（touch-action 已放开）
      if (this.arbiter.touchCountNow >= 2) return;
      /*
       * 文字工具例外：平板上用手指点一下就该出输入框，
       * 不然"添加文字"在平板上等于不能用（手指只会滚动）。
       */
      if (this.tool === "text" && !this.readOnly) {
        const p = this.pointFromEvent(e, rec);
        this.current = rec.index;
        this.store.setPage(rec.index);
        this.handleTextPointer(rec, p[0], p[1]);
        e.preventDefault();
        return;
      }
      if (this.tool === "select" && !this.readOnly) {
        const p = this.pointFromEvent(e, rec);
        this.current = rec.index;
        this.store.setPage(rec.index);
        this.handleSelectPointer(rec, p[0], p[1], e);
        e.preventDefault();
        return;
      }

      /*
       * 手指落笔的判定必须放在这里。
       *
       * 2026-10-30 真机 bug：「允许手指写字」开关亮着，手指还是只能滚动，
       * 一个字都写不出来。原因就在于这一支**无条件走滚动并 return**——
       * 而 arbiter 给单指 touch 的 role 永远是 "pan"，永远不会是 "draw"，
       * 所以下面那段「手指书写」的代码（`e.pointerType === "touch"`）
       * 是彻底的死代码，从来执行不到。
       *
       * 现在把判定提到前面来：
       *   · 允许手指书写 + 没开「只认触控笔」+ 非只读 + 不是手型工具 → 落笔
       *   · 其余情况（含默认）一律滚动
       */
      const fingerDraws =
        e.pointerType === "touch" &&
        !this.readOnly &&
        !this.opts.penOnly &&
        this.touchDraw &&
        this.tool !== "hand";
      if (!fingerDraws) {
        this.gesture = "pan";
        this.pointerId = e.pointerId;
        this.pan = {
          x: e.clientX,
          y: e.clientY,
          left: this.scrollEl.scrollLeft,
          top: this.scrollEl.scrollTop,
        };
        return;
      }
      // fingerDraws 为真：不 return，继续走下面共用的落笔流程
    }

    if (this.gesture !== "none") return;

    /*
     * 仅阅读模式：不落笔。
     *
     * 放这里（在角色仲裁之后、画笔逻辑之前）是关键：
     *   · 笔（role === "draw"）在这里被拦下 → 不会画出笔迹
     *   · 触摸交给浏览器原生滚动 / 选字（这时 touch-action 是 auto）
     *
     * 2026-10-29：触摸不再由这里接管。
     * 阅读模式下 touch-action 必须放开才能拖选文字，而一旦放开，
     * 浏览器就会自己滚动——我们再 set 一次 scrollTop 就是双倍速，
     * 手指一动页面飞出去两倍距离。让浏览器独占这条路更稳。
     * 鼠标不在 touch-action 的管辖内（不会"自动滚动"），所以照旧接管。
     */
    if (this.readOnly) {
      if (e.pointerType !== "mouse") return;
      if ((e.target as HTMLElement)?.closest?.(".mb-textlayer")) return;
      this.gesture = "pan";
      this.pointerId = e.pointerId;
      this.pan = {
        x: e.clientX,
        y: e.clientY,
        left: this.scrollEl.scrollLeft,
        top: this.scrollEl.scrollTop,
      };
      /*
       * 捕获指针要包 try/catch：
       * 指针可能已经抬起（pointerup 先于 pointerdown 到），
       * 此时 setPointerCapture 会抛 NotFoundError，
       * 一抛就整个 onDown 崩掉，滚动也跟着失灵。
       */
      try {
        rec.pageEl.setPointerCapture?.(e.pointerId);
      } catch (_) {}
      e.preventDefault();
      return;
    }

    this.current = rec.index;
    this.store.setPage(rec.index);
    this.emitState();

    if (this.tool === "text") {
      const tp = this.pointFromEvent(e, rec);
      this.handleTextPointer(rec, tp[0], tp[1]);
      return;
    }

    if (this.tool === "select") {
      const sp = this.pointFromEvent(e, rec);
      this.handleSelectPointer(rec, sp[0], sp[1], e);
      return;
    }

    if (this.tool === "hand" || (e.pointerType === "mouse" && e.button === 1)) {
      this.gesture = "pan";
      this.pointerId = e.pointerId;
      this.pan = {
        x: e.clientX,
        y: e.clientY,
        left: this.scrollEl.scrollLeft,
        top: this.scrollEl.scrollTop,
      };
      try {
        rec.pageEl.setPointerCapture?.(e.pointerId);
      } catch (_) {}
      e.preventDefault();
      return;
    }

    /*
     * 兜底：正常路径已经在上面 role === "pan" 分支里分流过了
     * （手指书写走落笔、其余走滚动），走到这里的 touch 属于异常情况。
     * 留着这一条，防止以后重构时手指突然能写字。
     */
    if (e.pointerType === "touch" && (this.opts.penOnly || !this.touchDraw)) {
      this.gesture = "pan";
      this.pointerId = e.pointerId;
      this.pan = {
        x: e.clientX,
        y: e.clientY,
        left: this.scrollEl.scrollLeft,
        top: this.scrollEl.scrollTop,
      };
      return;
    }

    e.preventDefault();
    this.pointerId = e.pointerId;
    try {
      rec.pageEl.setPointerCapture(e.pointerId);
    } catch (_) {}

    this.smoother.reset();
    const p = this.filteredPoint(e, rec);
    this.lastPoint = { x: p[0], y: p[1], t: e.timeStamp || performance.now() };
    this.lastPressure = null;
    this.lastSpeed = 0;
    this.undoPushed = false;
    // 用户开始操作 → 锚点失效
    this.lockedAnchor = null;
    // 新手势：清掉上一轮擦除的中间状态
    this.eraseBefore = null;
    this.eraseAfter = null;

    if (this.tool === "eraser") {
      this.gesture = "erase";
      this.eraseAt(rec, p[0], p[1], e);
      return;
    }

    if (this.tool === "shape") {
      this.gesture = "shape";
      this.draftRec = rec;
      this.draft = {
        id: uid("draft"),
        tool: "shape",
        color: this.penColor,
        size: this.penSize,
        opacity: 1,
        points: [
          [p[0], p[1], 0.5],
          [p[0], p[1], 0.5],
        ],
        shape: this.shapeKind,
      };
      this.scheduleOverlay(rec);
      return;
    }

    const highlighter = this.tool === "highlighter";
    const ballpoint = this.tool === "ballpoint";
    this.gesture = "draw";
    this.draftRec = rec;
    this.draft = {
      id: uid("draft"),
      tool: highlighter ? "highlighter" : ballpoint ? "ballpoint" : "pen",
      color: highlighter ? this.highlighterColor : this.penColor,
      size: highlighter ? this.highlighterSize : this.penSize,
      opacity: highlighter ? 0.32 : 1,
      points: [[p[0], p[1], this.pressureFor(e, 0, 16)]],
    };
    this.scheduleOverlay(rec);
  }

  private onMove(e: PointerEvent, rec: PageRec): void {
    /* 拖动文字：每帧改坐标，重建文字层（文字条数很少，重建比逐节点改省心） */
    if (this.gesture === "moveText" && this.moveText) {
      const m = this.moveText;
      const p = this.pointFromEvent(e, m.rec);
      const dx = p[0] - m.startX;
      const dy = p[1] - m.startY;
      if (!m.moved && Math.hypot(dx, dy) < 3) return;
      if (!m.moved) {
        // 第一次真正拖动才记历史：点一下（没动）不该产生一条撤销
        this.store.snapshotPage(m.rec.index);
        m.moved = true;
      }
      const target = this.store.data.pages[m.rec.index]?.texts?.find((t) => t.id === m.id);
      if (!target) return;
      /*
       * 拖动后的落点同样要过一遍排版夹取：拖到纸边时不光横向会顶出去，
       * 拖到页底时折行后的下面几行也会整行掉出纸外。
       */
      const l = this.textLayout({
        x: m.originX + dx,
        y: m.originY + dy,
        size: target.size,
        text: target.text,
        font: target.font,
        bold: target.bold,
      });
      target.x = l.x;
      target.y = l.y;
      this.renderTextLayer(m.rec);
      this.renderOverlay(m.rec);
      this.positionTextBar();
      e.preventDefault();
      return;
    }

    /*
     * 捏合时**不能**按 pointerId 过滤。
     *
     * 浏览器给每根手指各发一套 pointermove。两根手指轮流移动，
     * 如果这里按 pointerId 把第二根手指的移动丢掉，
     * 仲裁器就只收到一根手指的新坐标——两指距离只算得出半程。
     *
     * 实测：手指从 ±80 张到 ±94（距离 160→188），
     * 实际缩放比只有 174/160 = 1.0875，应为 188/160 = 1.175。
     * 这个半程误差会让每一次捏合都「缩不到位」，
     * 累积起来手感完全不对。
     *
     * 判据用「仲裁器是否处在手势态」——多指手势期间，
     * 所有手指的移动都必须喂给仲裁器。
     */
    if (!this.arbiter.isGesturing) {
      if (this.pointerId != null && e.pointerId !== this.pointerId) return;
    }

    // 笔尖悬停：没有按下时也显示笔尖位置，方便对准
    if (e.pointerType === "pen" && this.gesture === "none" && !this.arbiter.penDown) {
      const hp = this.pointFromEvent(e, rec);
      this.hoverPos = { x: hp[0], y: hp[1], p: e.pressure || 0.5 };
      this.scheduleOverlay(rec);
      return;
    }

    const role = this.arbiter.move(this.pointerInfo(e));
    if (role === "ignore") return;
    if (role === "gesture") {
      e.preventDefault();
      return;
    }

    const p = this.pointFromEvent(e, rec);

    if (this.gesture === "pan" && this.pan) {
      // 手指拖动：直接跟随手指滚动（比"抓取"更符合平板直觉）
      this.scrollEl.scrollLeft = this.pan.left - (e.clientX - this.pan.x);
      this.scrollEl.scrollTop = this.pan.top - (e.clientY - this.pan.y);
      // 采样滚动速度，抬手时用来起算惯性
      this.pushVelSample(this.scrollEl.scrollTop, e.timeStamp || performance.now());
      return;
    }

    if (this.tool === "eraser" && this.gesture !== "draw") {
      this.eraserPos = { x: p[0], y: p[1], r: this.eraserSize / 2 };
      this.scheduleOverlay(rec);
      if (this.gesture === "erase") this.eraseAt(rec, p[0], p[1], e);
      return;
    }

    if (this.gesture === "draw" || this.gesture === "shape") {
      const raw =
        typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() || [] : [];
      const events = raw.length ? raw : [e];
      for (const ev of events) this.appendPoint(ev, rec);
      this.scheduleOverlay(rec);
    }
  }

  private appendPoint(e: PointerEvent, rec: PageRec): void {
    if (!this.draft) return;
    const p = this.filteredPoint(e, rec);
    const now = e.timeStamp || performance.now();

    if (this.draft.tool === "shape") {
      let x = p[0];
      let y = p[1];
      const start = this.draft.points[0];
      if (e.shiftKey) {
        if (this.draft.shape === "line" || this.draft.shape === "arrow") {
          const ang = Math.atan2(y - start[1], x - start[0]);
          const snapped = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(x - start[0], y - start[1]);
          x = start[0] + Math.cos(snapped) * len;
          y = start[1] + Math.sin(snapped) * len;
        } else {
          const size = Math.max(Math.abs(x - start[0]), Math.abs(y - start[1]));
          x = start[0] + Math.sign(x - start[0] || 1) * size;
          y = start[1] + Math.sign(y - start[1] || 1) * size;
        }
      }
      this.draft.points[1] = [x, y, 0.5];
      invalidateStroke(this.draft);
      return;
    }

    const last = this.draft.points[this.draft.points.length - 1];
    const dist = last ? Math.hypot(p[0] - last[0], p[1] - last[1]) : 0;
    if (dist < 0.55) return;
    const dt = this.lastPoint ? now - this.lastPoint.t : 16;
    // 撤销记录由 commitDraft → addStroke 自动记增量，
    // 这里不用再拍全页快照（大页面上那一下要几毫秒）。
    const pressure =
      this.draft.tool === "highlighter" ? 0.5 : this.pressureFor(e, dist, Math.max(1, dt));
    this.draft.points.push([p[0], p[1], pressure]);
    invalidateStroke(this.draft);
    this.lastPoint = { x: p[0], y: p[1], t: now };
  }

  private onUp(e: PointerEvent, rec: PageRec): void {
    // 先通知仲裁器（可能结束多指手势）
    this.arbiter.up(this.pointerInfo(e));
    if (e.pointerType === "pen") this.hoverPos = null;
    if (this.pointerId != null && e.pointerId !== this.pointerId) return;
    try {
      rec.pageEl.releasePointerCapture?.(e.pointerId);
    } catch (_) {}
    const gesture = this.gesture;
    this.gesture = "none";
    this.pointerId = null;
    this.pan = null;

    /*
     * 抬手时起算惯性。
     *
     * 只对「滚动」手势起算：写字、擦除、套索结束时不该甩一下。
     */
    if (gesture === "pan") {
      const s = this.velSamples;
      if (s.length) {
        this.startFling(
          s[s.length - 1].y,
          e.timeStamp || performance.now(),
          e.pointerType
        );
      }
    }
    this.velSamples = [];

    if (gesture === "moveText") {
      const m = this.moveText;
      this.moveText = null;
      if (m?.moved) {
        // 拖动结束：一条撤销记录
        this.store.touch();
        this.changed();
        this.emitState();
      } else if (m) {
        /*
         * 拖动判定放在抬手时，而不是按下时：
         * 用户「点一下选中，再按住同一处拖」时，两次按下相隔可能只有 100ms，
         * 按下就判双击会直接弹出输入框，拖都拖不了。
         * 抬手时没移动过，才是真正的「点了第二下」。
         */
        const now = e.timeStamp || performance.now();
        const last = this.lastTextTap;
        if (last && last.id === m.id && now - last.t < 300) {
          this.lastTextTap = null;
          const t = this.store.data.pages[m.rec.index]?.texts?.find((x) => x.id === m.id);
          if (t) this.beginTextEdit(m.rec, t.x + 4, t.y - t.size * 0.4);
        } else {
          this.lastTextTap = { id: m.id, t: now };
        }
      }
    } else if (gesture === "draw" || gesture === "shape") {
      this.commitDraft(rec);
    } else if (gesture === "erase") {
      this.eraserPos = null;
      // 擦除手势结束，这时才把整条历史入栈
      if (this.eraseBefore && this.eraseAfter) {
        this.store.recordLayerChange(this.eraseBefore, this.eraseAfter);
      }
      this.eraseBefore = null;
      this.eraseAfter = null;
      this.undoPushed = false;
      this.renderOverlay(rec);
    }
    this.emitState();
  }

  private onLeave(e: PointerEvent, rec: PageRec): void {
    if (this.gesture === "erase" && this.eraserPos) {
      this.eraserPos = null;
      this.scheduleOverlay(rec);
    }
  }

  private commitDraft(rec: PageRec): void {
    const draft = this.draft;
    this.draft = null;
    this.draftRec = null;
    if (!draft) return;
    if (draft.tool === "shape") {
      const a = draft.points[0];
      const b = draft.points[draft.points.length - 1];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 2) {
        this.renderOverlay(rec);
        return;
      }
      const stroke: Stroke = {
        ...draft,
        id: uid("stroke"),
        points: [
          [a[0], a[1], 0.5],
          [b[0], b[1], 0.5],
        ],
      };
      // addStroke 自己记增量撤销
      this.store.addStroke(stroke, rec.index);
    } else {
      if (!draft.points.length) return;
      let stroke: Stroke = { ...draft, id: uid("stroke") };
      if (this.straighten) {
        const straight = straightenPoints(stroke.points);
        if (straight) stroke = { ...stroke, points: straight };
      }
      // addStroke 自己记增量撤销
      this.store.addStroke(stroke, rec.index);
    }
    this.renderRec(rec);
    this.renderOverlay(rec);
    this.changed();
    this.emitState();
  }

  private eraseAt(rec: PageRec, x: number, y: number, e: PointerEvent): void {
    const page = this.store.data.pages[rec.index];
    const layer = activeLayer(page);
    const base = this.eraserSize / 2;
    const press = e.pointerType === "pen" ? clamp(e.pressure || 0.5, 0.05, 1) : 1;
    const radius = base * (0.55 + press * 1.0);
    let changed = false;
    const remove = new Set<string>();
    const replacements: Array<{ oldId: string; pieces: Stroke[] }> = [];

    for (const s of layer.strokes) {
      if (!strokeHit(s, x, y, radius)) continue;
      if (this.eraserMode === "whole" || s.tool === "shape") {
        remove.add(s.id);
        changed = true;
        continue;
      }
      const pieces = splitStrokeByEraser(s.points, x, y, radius);
      if (!pieces.length) {
        remove.add(s.id);
        changed = true;
        continue;
      }
      const made = pieces.map((pts) => ({
        ...s,
        id: uid("stroke"),
        points: pts,
      }));
      replacements.push({ oldId: s.id, pieces: made });
      changed = true;
    }

    if (!changed) return;
    /*
     * 一次擦除手势 = 一条历史记录。
     *
     * 拖动橡皮时会连续触发 eraseAt（每个 pointermove 一次），
     * 如果每次都推一条历史，撤销一次只能回退一小步——
     * 看起来就是"擦不掉"。
     *
     * 所以用 undoPushed 标记：手势期间只记第一次的前态，
     * 每次擦完都更新"后态"，手势结束才真正入栈。
     */
    const store = this.store;
    if (!this.undoPushed) {
      this.eraseBefore = store.captureLayerState(rec.index, layer.id);
      this.undoPushed = true;
    }
    if (remove.size) store.removeStrokes(remove, rec.index, true);
    for (const r of replacements) store.replaceStroke(r.oldId, r.pieces, rec.index, true);
    const after = store.captureLayerState(rec.index, layer.id);
    if (this.eraseBefore && after) {
      // 只更新后态，不入栈——手势结束才 push
      this.eraseAfter = after;
    }
    store.touch();
    this.renderRec(rec);
    this.changed();
  }

  /* ------------------------------- 页面操作 ------------------------------- */

  addPage(): void {
    const index = this.store.addPage(this.current);
    this.current = index;
    this.renderPages();
    requestAnimationFrame(() => this.goToPage(index, false));
  }

  deletePage(index = this.current): void {
    if (!this.store.deletePage(index)) return;
    this.current = clamp(index, 0, this.store.pageCount - 1);
    this.renderPages();
    requestAnimationFrame(() => this.goToPage(this.current, false));
  }

  duplicatePage(index = this.current): void {
    const at = this.store.duplicatePage(index);
    this.current = at;
    this.renderPages();
    requestAnimationFrame(() => this.goToPage(at, false));
  }

  setTemplate(template: TemplateId, all = false): void {
    if (all) this.store.setAllTemplates(template);
    else this.store.setTemplate(this.current, template);
    for (const rec of this.recs) {
      const page = this.store.data.pages[rec.index];
      if (page) rec.pageEl.style.background = paperBackground(page.paper);
      if (rec.mounted) this.renderRec(rec);
    }
    this.changed();
    this.emitState();
  }

  setPaper(paper: PaperId): void {
    this.store.setPaper(this.current, paper);
    const rec = this.recs[this.current];
    if (rec) {
      rec.pageEl.style.background = paperBackground(paper);
      if (rec.mounted) this.renderRec(rec);
    }
    this.changed();
    this.emitState();
  }

  /* ------------------------------- 图层 ------------------------------- */

  addLayer(): void {
    this.store.addLayer(this.current);
    const rec = this.recs[this.current];
    if (rec?.mounted) this.renderRec(rec);
    this.changed();
    this.emitState();
  }

  setActiveLayer(id: string): void {
    this.store.setActiveLayer(this.current, id);
    this.emitState();
  }

  toggleLayer(id: string): void {
    this.store.toggleLayer(this.current, id);
    const rec = this.recs[this.current];
    if (rec?.mounted) this.renderRec(rec);
    this.changed();
    this.emitState();
  }

  deleteLayer(id: string): void {
    if (!this.store.deleteLayer(this.current, id)) return;
    const rec = this.recs[this.current];
    if (rec?.mounted) this.renderRec(rec);
    this.changed();
    this.emitState();
  }

  renameLayer(id: string, name: string): void {
    this.store.renameLayer(this.current, id, name);
    this.changed();
    this.emitState();
  }

  /* ------------------------------- 缩放与页面定位 ------------------------------- */

  scrollToPage(index: number, smooth = true): void {
    const rec = this.recs[clamp(index, 0, this.recs.length - 1)];
    if (!rec) return;
    this.current = rec.index;
    this.store.setPage(rec.index);
    this.mount(rec);
    const sr = this.scrollEl.getBoundingClientRect();
    const top = rec.wrap.getBoundingClientRect().top - sr.top + this.scrollEl.scrollTop - 16;
    this.scrollEl.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
    this.emitState();
    if (this.opts.onPageChange) this.opts.onPageChange(rec.index);
  }

  goToPage(index: number, smooth = true): void {
    this.scrollToPage(index, smooth);
  }

  /**
   * 滚动时更新"当前第几页"。
   *
   * 旧实现遍历所有页调 getBoundingClientRect()——500 页时每帧
   * 500 次强制同步重排，直接把帧率打到个位数。
   *
   * 现在改成**算术定位**：
   *   - 所有页高度相同（A4）、间距相同，所以第 i 页的顶部
   *     = 首页顶部 + i × (页高 + 间距)
   *   - 页高和间距在布局变化时才量一次，平时直接算
   *
   * 一次滚动只读一次 scrollTop，不触发任何重排。
   */
  private updateCurrentFromScroll(): void {
    if (!this.recs.length) return;
    const n = this.recs.length;
    const pageH = this.store.data.height * this.zoom;
    if (pageH <= 0) return;

    const stride = pageH + this.pageGap;
    // 视口中线在滚动内容里的位置
    const mid = this.scrollEl.scrollTop + Math.min(this.scrollEl.clientHeight * 0.42, 460);
    // 减去首页顶部，得到"第几页 × stride"
    const rel = mid - this.pageOrigin;

    // 二分查找：找最大的 i 使 i * stride <= rel
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const midIdx = (lo + hi + 1) >> 1;
      if (midIdx * stride <= rel) lo = midIdx;
      else hi = midIdx - 1;
    }
    const best = lo;

    if (best !== this.current) {
      this.current = best;
      this.store.setPage(best);
      /*
       * 兜底挂载：翻页时保证当前页一定有画布。
       *
       * 挂载上限是按字节预算算的，高倍率下被下限抬到只有 2 格；
       * IO 回调里「挂上第 3 页 → 同一轮回调被 enforceMountLimit 卸掉」之后，
       * IO 已经记过 isIntersecting，**不会再触发第二次**。
       * 没有这一行，翻过去的页面就是一片空白，直到滚出预挂范围再滚回来。
       * mount() 幂等，已挂载时是空操作。
       */
      this.mount(this.recs[best]);
      this.emitState();
      if (this.opts.onPageChange) this.opts.onPageChange(best);
    }
  }

  /* ------------------------------- 撤销 ------------------------------- */

  undo(): void {
    if (this.readOnly) return;
    if (!this.store.undo()) return;
    if (this.recs.length !== this.store.pageCount) {
      this.current = this.store.data.activePage;
      this.renderPages();
    } else {
      this.current = clamp(this.store.data.activePage, 0, this.recs.length - 1);
      /*
       * 整页快照替换后 page 对象是新的，文字层必须跟着重建——
       * 只重画 canvas 的话，撤销掉一段文字，纸面上那行字还在。
       */
      for (const rec of this.recs) {
        if (!rec.mounted) continue;
        this.renderRec(rec);
        this.renderTextLayer(rec);
      }
      const rec = this.recs[this.current];
      if (rec) this.renderOverlay(rec);
    }
    this.changed();
    this.emitState();
  }

  redo(): void {
    if (this.readOnly) return;
    if (!this.store.redo()) return;
    if (this.recs.length !== this.store.pageCount) {
      this.current = this.store.data.activePage;
      this.renderPages();
    } else {
      this.current = clamp(this.store.data.activePage, 0, this.recs.length - 1);
      /*
       * 整页快照替换后 page 对象是新的，文字层必须跟着重建——
       * 只重画 canvas 的话，撤销掉一段文字，纸面上那行字还在。
       */
      for (const rec of this.recs) {
        if (!rec.mounted) continue;
        this.renderRec(rec);
        this.renderTextLayer(rec);
      }
      const rec = this.recs[this.current];
      if (rec) this.renderOverlay(rec);
    }
    this.changed();
    this.emitState();
  }

  /* ------------------------------- 导出/缩略图 ------------------------------- */

  /**
   * 渲染侧栏缩略图。
   *
   * 底图（PDF / 图片）以前是**故意跳过**的：侧栏几百页，每页都触发一次
   * PDF 光栅化会瞬间打满 CPU。但代价是导入的 PDF 页在侧栏里全是一片空白，
   * 用户分不出哪页是哪页（真机反馈：「导入 PDF 的那几页只能显示是空白的」）。
   *
   * 现在改成**可控地画**：
   *   · 缩略图本身是懒渲染的（view 里的 IntersectionObserver 只管视口内那几张），
   *     一屏最多 5–8 张，不会一次点爆；
   *   · PDF 位图走独立的小缓存 `thumbBitmaps`（32MB），只要 160px 宽；
   *   · 主视图已经渲染过同一页就借它的位图，省一次光栅化；
   *   · 位图没就绪先画一层浅灰占位，渲染完由 onThumbNeedsRedraw 补画。
   */
  renderThumbnail(canvas: HTMLCanvasElement, index: number): void {
    const page = this.store.data.pages[index];
    if (!page) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width || 60;
    const cssH = rect.height || 84;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const kx = (cssW * dpr) / this.store.data.width;
    const ky = (cssH * dpr) / this.store.data.height;
    ctx.scale(kx, ky);
    drawPaper(
      ctx,
      page.template,
      page.paper,
      this.store.data.width,
      this.store.data.height,
      (0.85 * dpr) / kx
    );
    /*
     * 底图：PDF 走缩略图专用的小尺寸渲染；图片（Word 导入）照旧。
     * 这里**不能**调 drawBackground —— 它对 PDF 会按主视图缩放去请求
     * 2000px 级别的高清位图，侧栏滚一遍等于把整个 PDF 重新光栅化一遍。
     */
    const bg = page.background;
    if (bg?.pdf) this.drawPdfThumb(ctx, bg, cssW);
    else if (bg?.src) this.drawBackground(ctx, page);
    for (const layer of page.layers) {
      if (!layer.visible) continue;
      for (const s of layer.strokes) drawStroke(ctx, s, layer.opacity);
    }
  }

  /**
   * 在缩略图里画 PDF 底图（小尺寸）。
   *
   * ctx 已经按「页面坐标 → 缩略图设备像素」缩放过，所以 bg.x/y/width/height
   * 可以直接用，和主视图是同一套坐标。
   */
  private drawPdfThumb(
    ctx: CanvasRenderingContext2D,
    bg: PageBackground,
    cssW: number
  ): void {
    const pdf = bg.pdf;
    if (!pdf) return;
    const key = `${pdf.path}#${pdf.page}`;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // 1.4 倍余量：缩略图在 hover / 窄侧栏里会有几像素的尺寸浮动
    const want = clamp(Math.round(cssW * dpr * 1.4), 96, 384);

    // 先看缩略图自己的缓存，再借主视图的（主视图那份通常更清晰）
    const bmp = this.thumbBitmaps.get(key) ?? this.bgBitmaps.get(key);
    if (bmp) {
      ctx.save();
      ctx.drawImage(bmp, bg.x, bg.y, bg.width, bg.height);
      ctx.restore();
      return;
    }

    /*
     * 位图还没好：画一层浅灰。
     *
     * 用 #F0EDE8 而不是纸白，是为了和"空白的纸"区分开——
     * 一眼能看出这页有底图，只是还在渲染。
     */
    ctx.save();
    ctx.fillStyle = "#F0EDE8";
    ctx.fillRect(bg.x, bg.y, bg.width, bg.height);
    ctx.restore();

    this.requestPdfThumb(pdf.path, pdf.page, key, want);
  }

  /**
   * 请求渲染一张缩略图尺寸的 PDF 位图。
   *
   * 同一页只跑一个：侧栏快速滚动时 renderThumbnail 会被连续调用，
   * 靠 thumbQueued / thumbRendering 去重，否则同一页能排出十几次光栅化。
   */
  private requestPdfThumb(
    pdfPath: string,
    pageNo: number,
    key: string,
    want: number
  ): void {
    const have = this.thumbBitmaps.getEntry(key)?.width ?? 0;
    // 已经够清晰（或主视图缓存里有更大的）就不重复渲染
    if (have >= want * 0.8) return;
    if (this.bgBitmaps.getEntry(key)) return;
    if (this.thumbRendering.has(key) || this.thumbQueued.has(key)) return;
    /*
     * 队列封顶 20 条：侧栏快速滚动时，用户早就滑过去的那些页还会往队列里排。
     * 丢最旧的（FIFO）——它最可能是已经滚出视野的，用户根本不会回头看。
     */
    if (this.thumbQueue.length >= 20) {
      const dropped = this.thumbQueue.shift();
      if (dropped) this.thumbQueued.delete(dropped.key);
    }
    this.thumbQueued.add(key);
    this.thumbQueue.push({ pdfPath, pageNo, key, want });
    this.pumpThumbQueue();
  }

  /** 最多两张同时渲染，其余排队 */
  private pumpThumbQueue(): void {
    while (this.thumbActive < 2 && this.thumbQueue.length) {
      const job = this.thumbQueue.shift();
      if (!job) break;
      this.thumbQueued.delete(job.key);
      this.thumbActive += 1;
      this.thumbRendering.add(job.key);
      void (async () => {
        try {
          const doc = await this.openPdfDoc(job.pdfPath);
          const nowHave = this.thumbBitmaps.getEntry(job.key)?.width ?? 0;
          if (nowHave >= job.want * 0.8 || this.bgBitmaps.getEntry(job.key)) return;
          const rendered = await renderPdfPage(doc, job.pageNo, job.want);
          this.thumbBitmaps.set(job.key, rendered.bitmap, rendered.bitmap.width);
          this.notifyThumb(job.pdfPath, job.pageNo);
        } catch (e) {
          console.warn("[inkbook] 缩略图 PDF 底图渲染失败", e);
        } finally {
          this.thumbRendering.delete(job.key);
          this.thumbActive -= 1;
          this.pumpThumbQueue();
        }
      })();
    }
  }

  /** 通知侧栏：这一页的底图好了，重画缩略图 */
  private notifyThumb(pdfPath: string, pageNo: number): void {
    if (!this.opts.onThumbNeedsRedraw) return;
    const pages = this.store.data.pages;
    for (let i = 0; i < pages.length; i += 1) {
      const bg = pages[i].background;
      if (bg?.pdf && bg.pdf.path === pdfPath && bg.pdf.page === pageNo) {
        this.opts.onThumbNeedsRedraw(i);
      }
    }
  }

  /**
   * 导出整页位图。
   *
   * `withText = false` 时不画用户文字——给"文字要矢量输出"的场景用：
   * 文字改成 PDF 的 drawText 叠在上面，这里再画一遍就重影了。
   */
  exportPageCanvas(index: number, scale = 2, withText = true): HTMLCanvasElement {
    const page = this.store.data.pages[index];
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(this.store.data.width * scale);
    canvas.height = Math.round(this.store.data.height * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    drawPaper(ctx, page.template, page.paper, this.store.data.width, this.store.data.height, 1);
    // 底图也要导出，否则导入的 PDF/Word 内容会丢失
    this.drawBackground(ctx, page);
    for (const layer of page.layers) {
      if (!layer.visible) continue;
      for (const s of layer.strokes) drawStroke(ctx, s, layer.opacity);
    }
    // 文字最后画：跟屏幕上的层序一致（文字层在笔迹之上）
    if (withText) this.drawUserTexts(ctx, page);
    return canvas;
  }

  /**
   * 导出用的**透明叠加层**：只有"纸上的墨"，没有纸张底色和底图。
   *
   * 给矢量导出（INK-102 三期）用：新 PDF 里那一页是**原 PDF 的矢量页**，
   * 原文保持可选中、可搜索；这层透明 PNG 只负责笔迹、手写文字、
   * 纸面线（横线/网格），叠在原文上面。
   *
   * 所以这里**不能**调 drawPaper 的默认行为——它会填一层纸色，
   * 整页原文就被糊死了。`fill = false` 只画线条。
   *
   * `withText = false` 时用户文字不进位图（改用 PDF 的 drawText 矢量输出）。
   */
  exportOverlayCanvas(index: number, scale = 2, withText = true): HTMLCanvasElement {
    const page = this.store.data.pages[index];
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(this.store.data.width * scale);
    canvas.height = Math.round(this.store.data.height * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    // 纸面线（不填底色）；模板是 blank 时什么也不画
    drawPaper(
      ctx,
      page.template,
      page.paper,
      this.store.data.width,
      this.store.data.height,
      1,
      false
    );
    for (const layer of page.layers) {
      if (!layer.visible) continue;
      for (const s of layer.strokes) drawStroke(ctx, s, layer.opacity);
    }
    if (withText) this.drawUserTexts(ctx, page);
    return canvas;
  }

  /**
   * 某页 PDF 底图的可读字节（导出矢量页要用原始 PDF 文件）。
   *
   * `bg.pdf.path` 存的是**库内路径**（导入时记的是 `file.path`），
   * 所以直接走 vault.adapter.readBinary 最可靠——不依赖 app:// 能否 fetch。
   */
  async readPdfBytes(pdfPath: string): Promise<Uint8Array | null> {
    const app: any = this.opts.app;
    const adapter = app?.vault?.adapter;
    try {
      if (adapter?.readBinary) {
        const buf = await adapter.readBinary(pdfPath);
        return new Uint8Array(buf);
      }
      if (adapter?.read) {
        const text = await adapter.read(pdfPath);
        const bin = atob(text);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
    } catch (e) {
      console.warn("[inkbook] 读原 PDF 失败，这一页退回位图导出", pdfPath, e);
    }
    return null;
  }

  /**
   * 底图是否都已加载完（导出前需要）。
   *
   * PDF 页是按需渲染的，所以这里要**主动等它渲染完**——
   * 否则导出的 PDF 会缺底图内容。
   */
  async waitBackgrounds(indexes: number[], exportScale = 2): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const i of indexes) {
      const page = this.store.data.pages[i];
      const bg = page?.background;
      if (!bg) continue;

      if (bg.pdf) {
        // 等这一页的 PDF 渲染完（按导出倍率渲染，保证清晰）
        const key = `${bg.pdf.path}#${bg.pdf.page}`;
        const target = this.pdfExportWidth(bg, exportScale ?? 2);
        const have = this.bgBitmaps.getEntry(key)?.width ?? 0;
        if (have >= target) continue;
        pending.push(
          (async () => {
            try {
              const doc = await this.openPdfDoc(bg.pdf!.path);
              const rendered = await renderPdfPage(doc, bg.pdf!.page, target);
              this.bgBitmaps.set(key, rendered.bitmap, rendered.bitmap.width);
              this.markBgDirty(bg.pdf!.path, bg.pdf!.page);
            } catch (e) {
              console.error("[inkbook] 导出等待 PDF 渲染失败", e);
            }
          })()
        );
        continue;
      }

      const src = bg.src;
      if (!src) continue;
      if (this.bgImages.has(src)) continue;
      pending.push(
        new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            this.bgImages.set(src, img);
            resolve();
          };
          img.onerror = () => resolve();
          img.src = this.resolveAssetUrl(src);
        })
      );
    }
    await Promise.all(pending);
  }

  destroy(): void {
    this.stopFling();
    this.destroyed = true;
    this.uninstallEdgeSwipeGuard();
    window.removeEventListener("pointerup", this.globalUp, true);
    window.removeEventListener("pointercancel", this.globalUp, true);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeRaf) cancelAnimationFrame(this.resizeRaf);
    this.resizeRaf = 0;
    if (this.observer) this.observer.disconnect();
    this.observer = null;
    if (this.overlayRaf) cancelAnimationFrame(this.overlayRaf);
    if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
    if (this.wheelRaf) cancelAnimationFrame(this.wheelRaf);
    // 释放位图显存和 PDF 文档句柄
    this.bgBitmaps.clear();
    this.thumbBitmaps.clear();
    this.thumbRendering.clear();
    this.thumbQueue.length = 0;
    this.thumbQueued.clear();
    this.bgImages.clear();
    for (const p of this.pdfDocs.values()) {
      void p.then((doc) => doc?.destroy?.()).catch(() => {});
    }
    this.pdfDocs.clear();
    window.clearTimeout(this.pinchReleaseTimer);
    this.pinchReleaseTimer = 0;
    this.moveText = null;
    this.textBarEl = null;
    this.selectedTextId = null;
    this.host.innerHTML = "";
  }
}
