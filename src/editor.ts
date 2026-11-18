import {
  activeLayer,
  normalizeShapeSnap,
  MAX_ZOOM,
  MIN_ZOOM,
  PEN_COLORS,
  type Page,
  type PageBackground,
  type PageFileSource,
  type PageImage,
  type PageText,
  type PaperId,
  type Pt,
  type ShapeKind,
  type Stroke,
  type TemplateId,
  type Layer,
  type ToolId,
  uid,
} from "./types";
import { BookStore, type HistoryEntry } from "./store";
import { drawStroke, invalidateStroke, predictTail } from "./ink";
import {
  recognizeShape,
  recognitionPoints,
} from "./shaperec";
import { bandLaserSamples, buildLaserGeometry } from "./lasertrail";
import { InkPredictor, pressureResponse } from "./inkalgo";
import { OneEuroFilter, shapePressure, speedWidthFactor, zoomNormalization } from "./filter";
import { TouchArbiter, type PinchInfo, type PointerInfo, type TouchRole } from "./touch";
import { drawPaper, paperBackground } from "./paper";
import { BitmapCache } from "./cache";
import {
  extractPdfText,
  openPdf,
  pdfPageSize,
  pdfTargetWidthPx,
  renderPdfPage,
  type PdfDoc,
} from "./pdf";
import {
  clamp,
  invalidateStrokeBounds,
  pointSegmentDistance,
  splitStrokeByEraser,
  straightenPoints,
  strokeBounds,
  strokeHit,
  type Bounds,
} from "./geometry";
import {
  availableTextWidth,
  layoutUserText,
  maxTextStartX,
  MIN_BOX_WIDTH,
  reserveTextX,
  TEXT_LINE_HEIGHT,
  type TextLayout,
} from "./textwrap";
import {
  ensureHandFont,
  ensureHandFontIdle,
  HAND_FONT_FAMILY_CSS,
  onHandFontReady,
} from "./handfont";
import { fitImageRect } from "./images";
import { countMatchesBefore, findInText, type FindMatch } from "./find";
import { findWikiLinks, stripWikiLinkSyntax, type LinkTarget } from "./wikilinks";

export interface EditorState {
  pageIndex: number;
  pageCount: number;
  zoom: number;
  tool: ToolId;
  penColor: string;
  /** 钢笔粗细 */
  penSize: number;
  /** 圆珠笔粗细（与钢笔分开记忆） */
  ballpointSize: number;
  highlighterColor: string;
  highlighterSize: number;
  shapeKind: ShapeKind;
  /** 当前形状（shapeKind）自己的线宽；形状的粗细按种类各记各的 */
  shapeSize: number;
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

interface CachedTextLayer {
  /** 已脱离 DOM、但保存着全部 span 的整层，可直接重新插入复用。 */
  el: HTMLElement;
  /** 内容/尺寸/字体时代的签名；变了就整层作废，绝不复用旧文字。 */
  signature: string;
}

/**
 * 脱离 DOM 的**主笔迹画布**缓存条目（INK-229 平板上下滑卡顿）。
 *
 * 为什么缓存整块 canvas 而不是位图：老实现每跨一页都要 `mount()` →
 * `resizeRec()` —— 写 canvas.width/height 让浏览器重新分配整块 backing
 * 并清空，随后 renderRec 全量重画该页所有笔迹 + renderOverlay。平板 dpr=2
 * 时一页两块约 12–18MB，笔迹多的页一次重绘 10–30ms，跨越页边界就卡一下，
 * 正是「每滑一页顿一下」的直接来源。
 *
 * 这里把卸载时已经画好的主画布整块留着；滚回来时若签名（backing 尺寸 +
 * 内容 epoch）没变，直接重新插回 DOM，跳过重分配与全量重绘。
 * 只缓存主 canvas：overlay（草稿 / 光标 / 选中框）依赖实时状态，每次挂载
 * 都新建并 renderOverlay，绝不缓存（否则选中框 / 橡皮圈会显示过期内容）。
 */
interface CachedRaster {
  /** 脱离 DOM、仍保存着整页笔迹像素的主画布。 */
  canvas: HTMLCanvasElement;
  /** backing 宽高（像素）与内容 epoch 的签名；不一致就作废，绝不复用旧像素。 */
  signature: string;
  /** 估算字节，用来按总预算做 LRU 淘汰。 */
  bytes: number;
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

type Gesture =
  | "none"
  | "draw"
  | "shape"
  | "erase"
  | "pan"
  | "moveText"
  | "resizeText"
  | "moveShape"
  | "resizeShape"
  | "moveImage"
  | "resizeImage"
  | "laser";

/** 激光笔光迹存活时长（毫秒）：越老越淡，到点整段丢掉 */
const LASER_FADE_MS = 850;

/** 形状选框上的缩放手柄方位：四角 + 四条边中点 */
type ShapeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/**
 * 文字可用字体。
 *
 * 只用系统自带字体，不打包（打包中文字体动辄几 MB，自用不值）。
 * 屏幕渲染、编辑框、导出画布三处都走 `textFontStack()`，
 * 否则「编辑时是这个宽度、存下来变另一个宽度」。
 *
 * 回退链统一以「Noto Sans SC, sans-serif」收尾（INK-193）：
 * 导出 PDF 只有一款字体（Noto Sans SC，见 fontasset.ts），而系统未必装了
 * 用户选的宋体/楷体/等宽——旧的尾部 `serif` / `monospace` 通用回退在 Windows
 * 上会落到 SimSun / Consolas，拉丁字宽和导出差 18.5%，屏幕上 3 行的字
 * 导出来变成 4 行。首选字体仍排在最前，「选了楷体就该看到楷体」不受影响；
 * 只有首选字体缺失时才回退到导出同款的 Noto/系统无衬线，量宽尽量贴近导出。
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
    stack:
      '"Songti SC", "Noto Serif SC", "Source Han Serif SC", "SimSun", "Noto Sans SC", sans-serif',
  },
  {
    id: "kai",
    label: "楷体",
    // 不把 "Noto Serif SC" 留在楷体的回退里：它不是楷体，字宽又和导出字体差得远，
    // 首选楷体缺失时直接回退到导出同款，比"看起来像宋体"更重要。
    stack: '"Kaiti SC", "STKaiti", "KaiTi", "Noto Sans SC", sans-serif',
  },
  {
    id: "mono",
    label: "等宽",
    // 等宽字体没有汉字：西文仍用等宽（用户选的），汉字按字回落到导出同款无衬线，
    // 不再落到 `monospace` 通用族的 CJK 回退（各平台差异极大）。
    stack:
      'ui-monospace, SFMono-Regular, "Cascadia Code", Consolas, "Courier New", "Noto Sans SC", sans-serif',
  },
  {
    id: "hand",
    label: "手写",
    /*
     * 手写体（2026-11-09 用户要求；2026-11-10 修正，见 INK-224）。
     *
     * **首选是本插件自带的小赖（Xiaolai）子集**，由 src/handfont.ts 在运行时
     * 经 `FontFace` 注册进 `document.fonts`，家族名 `"Inkbook Hand"`。
     *
     * 上一版写的是 `"Excalifont", "Xiaolai"`，指望借用 Obsidian Excalidraw
     * 插件注册的同名字体。这条路在真机上不成立：
     *   · Excalifont 只有西文（7 个 woff2 分片共 63KB，一个汉字都没有）；
     *   · Xiaolai 要 Excalidraw 打开「中文字体」开关（默认关闭）才会去加载
     *     本地中文字体资源。
     * 于是中文落到回退链尾部的 Noto Sans SC —— 用户看到的就是
     * 「选了手写，字体没变」（INK-224）。
     *
     * 现在字体随插件走，不依赖别的插件，也不依赖设备装没装。
     * 后面两项仍保留同名字体：用户自己装了 Excalidraw 并开了中文字体、
     * 或者系统里装了 Xiaolai，就用他那份（优先级更高，效果一致）。
     * 尾部按 INK-193 以导出同款 "Noto Sans SC", sans-serif 收尾：
     * 子集里缺的字（生僻字、emoji）按字回落到导出同款，量宽仍与导出一致。
     */
    stack: `${HAND_FONT_FAMILY_CSS}, "Excalifont", "Xiaolai", "Noto Sans SC", sans-serif`,
  },
  {
    id: "xingkai",
    label: "行楷",
    /*
     * 「行楷」单独成一档（2026-11-09 用户要求：原「手写」用的就是这套字体栈，
     * 现在拆出来做独立选项）。
     *
     * **中文字体名必须写实际安装的名字**：Windows 方正行楷简体 / 楷体，
     * macOS Xingkai SC / STKaiti / Kaiti SC；西文用 Segoe Script（Win）/
     * Bradley Hand（mac）/ Ink Free（Win10+），都比 Comic Sans 更像手写。
     * 尾部仍按 INK-193 以导出同款 "Noto Sans SC", sans-serif 收尾。
     */
    stack:
      '"方正行楷简体", "FZ Xingkai", "楷体", "KaiTi", "楷体_GB2312", "Xingkai SC", "STXingkai", "STKaiti", "Kaiti SC", "Segoe Script", "Bradley Hand", "Ink Free", "Comic Sans MS", cursive, "Noto Sans SC", sans-serif',
  },
];

/** 字体 id → CSS font-family；未知 id 落回黑体 */
export function textFontStack(id?: string): string {
  const hit = TEXT_FONTS.find((f) => f.id === id);
  return (hit || TEXT_FONTS[0]).stack;
}

/** 兼容旧代码里的单字体引用（PDF 原文也用黑体） */
const TEXT_FONT = TEXT_FONTS[0].stack;

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
 * 在旧上限 2.8 倍缩放 + 2x 屏上，这是 5558×7861 = 4370 万像素，
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
/*
 * 手动上限现为 3.5（不用 4.0 是为了少担平板内存风险）；renderDpr() 的
 * 动态 dpr 夹取继续把单块画布钉在 16M 像素内，上面的测量值保留作旧基线。
 */
export const MAX_CANVAS_PIXELS = 16_000_000;

/**
 * 笔迹画布的**渲染超采样倍数**（INK-162）。
 *
 * 纯函数：只吃「设备像素比」，不碰编辑器状态 —— 测试可以直接跑它，
 * 也不依赖测试机的实际 dpr（无头 Edge 可能是 1 也可能是 2）。
 *
 * ── 为什么桌面要补到 1.25 ──
 *
 * 根因（实测：5 个 seed × 2 种笔画 × 真 Chrome 合成，每格 n=10）：
 * dpr=1 时画布 backing 只有 1 个设备像素/页面单位，笔迹边缘
 * **一次采样就定了** → 呈台阶状，用户看到的正是「边缘不够丝滑」。
 * 超采样后 backing 变 1.25 倍，浏览器用**非整数比**降采样，
 * 每个输出像素按 1 或 2 个源像素加权 → 灰阶过渡摊开 → 边缘细腻。
 *
 * 实测硬台阶占比（越低越丝滑）：
 *   z=0.8   鼠标 17.61% → 5.26%（-70%）  笔 17.14% → 5.77%（-66%）
 *   z=2.8   鼠标  7.34% → 2.80%（-62%）  笔  8.47% → 3.87%（-54%）
 *
 * 为什么是 1.25 而不是 2：**整数比会被重新量化**。dpr=2 时浏览器做
 * 2:1 降采样，每个输出像素恰好是 2×2 源像素的平均 → 已经抗锯齿过
 * 的边缘被压成一档灰阶 → 硬台阶反弹回 17.37%（比 1.25 差 3 倍多）。
 * 非整数比（1.25）没有这个问题。实测 dpr=1.5 是 6.85%，也不如 1.25。
 *
 * 为什么 dpr=2 的设备（平板）**不动**：用户天天用平板写字，
 * 平板现在的手感没被抱怨，不拿没问题的场景去冒险。实测平板的
 * dpr=2 → 17.14%，改 1.25（5.77%）确实更平滑，但那属于
 * 「用户没要求的大改动」，等真机验证过再说。
 *
 * @param deviceDpr 设备的 devicePixelRatio（会先被夹到 ≤2）
 * @returns 画布 backing 相对 CSS 尺寸的倍数
 */
export function inkRenderDpr(deviceDpr: number): number {
  const raw = Math.min(deviceDpr || 1, 2);
  // 桌面（dpr=1）补到 1.25；dpr≥2 的设备（平板）保持原样
  return raw < 1.5 ? 1.25 : raw;
}

/**
 * 超采样只在「日常书写倍率」生效，高倍时退回设备原生 dpr。
 *
 * 为什么要这一层（2026-11-07 补）：`inkRenderDpr` 无条件补到 1.25，
 * 在桌面旧上限 2.8 倍时会把单页画布推到 83MB（两块 167MB），
 * 超过 `MOUNT_BUDGET_BYTES`(160MB) —— 而 `MIN_MOUNTED=2` 是硬下限
 * （绝不能卸邻页，卸了滚过去是永久空白），所以预算被突破。
 * 原来的 dpr=1 在那一档只用 107MB，抬到 1.25 反而把安全余量吃掉了。
 *
 * 收益上也不值得：旧上限 2.8 倍时笔画在屏幕上已经很粗（一笔约 8 个设备像素），
 * 边缘的亚像素过渡本来就明显，超采样带来的相对改善远不如 0.8~1.25 倍。
 * 而 0.8~1.25 是用户**真正在写**的倍率，那里内存余量充足（38MB）。
 *
 * 所以：**zoom ≤ SUPERSAMPLE_MAX_ZOOM 才超采样**，超过就用原生 dpr。
 * 阈值取 1.25（= 最大超采样倍率本身）：fit（0.3~1.25）全部在内 ——
 * 那是用户**真正在写**的区间；1.3 倍以上算「放大看细节」，清晰度交给
 * 画布自身分辨率。实测这个阈值下最坏占用 139MB（1.6 倍那档），
 * 仍留 21MB 余量；取 1.5 会多出一档 1.3 倍的 144MB，余量只剩 16MB。
 */
export const SUPERSAMPLE_MAX_ZOOM = 1.25;

/**
 * 导入文档页（PDF/Word 位图正文）在「日常书写倍率」档的**超采样目标 dpr**。
 *
 * 为什么普通手写页用 1.25、导入文档页要用到 3.0（2026-11-11，100% 清晰度专项）：
 * 桌面 dpr=1、100% 缩放下，页面 CSS 宽 794，画布 backing 无论多少最后都要被
 * 浏览器合成器缩到 794 设备像素。手写笔画是矢量，1.25 超采样已足够丝滑；
 * 而导入文档的正文是一张位图（Word 底图 3335px 宽 / PDF 光栅），它的清晰度
 * 取决于「源位图 → backing → 794」这条链上**中间 backing 保留了多少源细节**。
 *
 * 实测（真实 BookEditor + 真实 Word 位图 + Chromium 真机截图，dpr=1、100%、
 * 量正文墨迹包围盒的拉普拉斯锐度 / 墨色均值，越低越黑）：
 *   backing 993（1.25×）：锐度 129.7、墨色均值 152.6（现状）
 *   1588（2.0×）：149.2 / 145.6
 *   1985（2.5×）：215.4 / 119.3
 *   2382（3.0×）：**272.1（+110%）/ 89.6（最黑）**  ← 甜点
 *   2779（3.5×）：236.4 / 109.6   （继续加只在噪声区抖动，且更吃内存）
 *   3335（4.2×=源宽）：248.8 / 104.2
 * 结论：backing 越接近源宽，中间损失越小、字越清越黑；3.0× 是收益/内存的甜点。
 *
 * 平板（dpr=2）同样吃这条（2026-11-11 后续：用户反馈平板正文仍不够清）：
 * 平板 backing 只有 794×zoom×2≈1588，源 Word/PDF 位图约 3335 宽，仍有 2 倍多
 * 下采样损失；抬到 3.0×（backing≈2382）把源细节更多留在中间层，再交合成器
 * 降到设备像素，小字更锐。>1.25 的高倍缩放仍退回原生（字够大）。
 * 始终经 `inkEffectiveRenderDpr()` 的单块像素 + MIN_MOUNTED 页总字节两道预算夹取，
 * 绝不越红线（3.0× 在 100% 时单页 backing 约 2382×3369≈8.0M px，两块画布两页
 * 共约 128MB，仍在 160MiB 预算内）。
 */
export const DOCUMENT_READ_SUPERSAMPLE = 3.0;

/**
 * 按缩放档决定最终渲染 dpr。
 *
 * @param deviceDpr 设备 devicePixelRatio
 * @param zoom      当前缩放
 */
export function inkRenderDprForZoom(deviceDpr: number, zoom: number): number {
  const raw = Math.min(deviceDpr || 1, 2);
  // 平板（dpr≥2）与高倍缩放都保持原生：不动没问题的场景，也不吃内存余量
  if (raw >= 1.5) return raw;
  if (!(zoom > 0) || zoom > SUPERSAMPLE_MAX_ZOOM) return raw;
  return inkRenderDpr(raw);
}

/**
 * 取证/回归用：临时关闭「导入文档页用 3.0× 超采样」这条改动，重现改动前的
 * 1.25× 行为。与 `setDocxRasterDprForTest` 同款用意：Before / After 两张图必须跑
 * **同一条真实渲染路径**、只有这一个变量不同。正常运行时没人调它，生产行为
 * 永远等于「导入文档页用 DOCUMENT_READ_SUPERSAMPLE」。
 */
let documentSupersampleOverride: boolean | null = null;
export function setDocumentSupersampleForTest(on: boolean | null): void {
  documentSupersampleOverride = on;
}

/**
 * 取证/调参用：临时覆盖「导入文档页超采样目标 dpr」的具体值。
 *
 * 用来在平板 dpr=2 上扫 2.5 / 3.0 / 3.5 找清晰度/内存甜点（见
 * `test/textsharp-tablet-capture.mjs`）。正常运行没人调它，生产行为永远等于
 * `DOCUMENT_READ_SUPERSAMPLE`。
 */
let documentReadSupersampleValue: number | null = null;
export function setDocumentReadSupersampleForTest(v: number | null): void {
  documentReadSupersampleValue = Number.isFinite(v) && (v as number) > 0 ? (v as number) : null;
}

/** 导出的底图位图宽度上限（设备像素） */
const MAX_EXPORT_PX = 4096;

/**
 * 缩略图快照缓存（LRU）的两条上限。
 *
 * 侧栏窗口化后，滚出视口的条目连 canvas 一起回收；滚回来时条目重建，
 * 以前会把「纸面线 + 笔迹 + PDF 底图」整张再画一遍。现在把画好的小图
 * 按页 id 存一份，窗口重建后直接 drawImage。
 *
 * 每条只是缩略图尺寸（60×84 CSS @dpr2 ≈ 120×168×4 ≈ 80KB），
 * 但侧栏宽度会变、dpr 会变，不同尺寸各存一份，所以既按字节也按条数封顶。
 * 8MB 约等于 100 张 60×84@2x；实际按条数先到 80 张，对平板内存可忽略，
 * 也远小于 PDF 位图的 32MB thumbBitmaps。
 */
const THUMB_SHOT_BUDGET = 8 * 1024 * 1024;
const THUMB_SHOT_MAX = 80;

/**
 * 导出前等静态底图（Word 转出的 PNG 等）的上限。
 *
 * 和 embed.ts 的 `EMBED_IO_TIMEOUT_MS` 同一档：10 秒足够慢盘读一张图，
 * 又短到用户不会以为「导出卡死了」。超时按「取不到」处理，导出继续。
 */
const BACKGROUND_WAIT_TIMEOUT_MS = 10_000;

/**
 * 测试用：压短导出底图等待超时。
 *
 * 和 embed.ts 的 `setEmbedIoTimeoutForTest` 同一套做法——10 秒的路径
 * 在自动化测试里等不起，但「卡住不返回」恰恰是最需要断言的行为。
 */
let bgWaitTimeoutMs = BACKGROUND_WAIT_TIMEOUT_MS;
export function setBackgroundWaitTimeoutForTest(ms: number): void {
  bgWaitTimeoutMs = Number.isFinite(ms) && ms > 0 ? ms : BACKGROUND_WAIT_TIMEOUT_MS;
}

/**
 * 给一个 Promise 加超时上限，超时 reject。
 *
 * 和 `embed.ts` 里那个同名函数是同一套思路（那边是私有的，不跨模块共享，
 * 避免为一个十行的工具函数制造依赖）。**超时后原 Promise 仍在跑**，
 * 只是我们不再等它——导出场景要的就是「不卡住」，剩下的交给它自己收尾。
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(label + " 超时")), ms);
  });
  return Promise.race([p, timeout]).finally(() => window.clearTimeout(timer)) as Promise<T>;
}

/** 缩略图快照的 key：页 id + 目标像素尺寸（尺寸变了要重画一份） */
function thumbShotKey(pageId: string, w: number, h: number): string {
  return `${pageId}@${w}x${h}`;
}

/** 一张画好的缩略图快照（不在 DOM 里，平板内存按 w×h×4 记账） */
interface ThumbShot {
  canvas: HTMLCanvasElement;
  bytes: number;
  touched: number;
}

/**
 * 同时挂载的所有画布总字节预算（不含 PDF 位图缓存）。
 *
 * 这是**软目标**，不是硬上界：IO 预挂范围内的页一票不卸，实际挂载量可能
 * 比按字节算出的 limit 多几页。预算还同时驱动 `inkEffectiveRenderDpr()`：
 * 高倍率时把 dpr 压到「MIN_MOUNTED=2 页也不超 160MiB」，避免旧实现靠软目标
 * 兜不住硬下限。低倍率下它仍负责削掉多余挂载——0.8 倍时一页才 17MB，
 * 不按字节算的话光看页数会挂满 12 页。
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
 * 旧上限 2.8 倍时预算只够 1 页，但绝不能把邻页卸掉——卸了滚过去就是整页空白：
 * IntersectionObserver 只在**跨越交叉阈值**时回调，邻页是「已进视口、
 * 又在本回调里被卸掉」，状态没变化，IO 不会再触发第二次；
 * 而 updateCurrentFromScroll() 只改 current 不挂画布。
 * 结果就是滚到那页时 current 变了、画布却没有，一直白到你滚出去再滚回来。
 * 所以宁可超预算，也不留这个空洞。
 */
const MIN_MOUNTED = 2;

/**
 * 脱离 DOM 主画布 LRU 的字节预算（INK-229 平板上下滑卡顿）。
 *
 * 缓存只是「滚回来时能秒复用」，不是常驻显存：总占用必须封顶，否则来回滑
 * 几十页会把几十块高倍率画布全留在内存里，平板上直接闪退。
 *
 * 取 96MiB：dpr=2、1 倍时一页两块约 12–18MB，能留住 5–8 页「刚滑过去」的
 * 近邻；高倍率（如 3.5 倍一页 83MB）时只留 1 页也会被预算淘汰，等于退回
 * 老路径但不超支。它和 MOUNT_BUDGET_BYTES 互不叠加冲突：
 * MOUNT_BUDGET_BYTES 管「此刻挂载」的页，本预算只管「已卸载待复用」的页。
 */
const RASTER_CACHE_BYTES = 96 * 1024 * 1024;

/**
 * 脱离 DOM 主画布 LRU 的**条数**上限（INK-229）。
 *
 * 只按字节封顶不够：低倍率下一页才 2MB，96MiB 能塞 40 多块画布，
 * 几十个脱离 DOM 的 canvas 节点本身就是负担，还让 LRU 的 Map 越滚越长。
 * 与文字层缓存对齐，同样取 MAX_MOUNTED=8：留住「刚滑过去」的近邻，
 * 再往回滚就正常重画（那条路径本来就有，不空白、不卡死）。
 */
const MAX_RASTER_CACHED = MAX_MOUNTED;

/**
 * `renderDpr()` 与 feel.html 共用的**最终**渲染 dpr（含单块像素和挂载字节两道预算）。
 *
 * 为什么再加一道字节预算（2026-11-10）：手动上限抬到 3.5 倍后，
 * `MAX_CANVAS_PIXELS` 只把 dpr 夹到 sqrt(16M/(794×1123×3.5²)) ≈ 1.210，
 * 而桌面 dpr=1 的原策略本来就是 1。于是单页两块画布约 83.35MiB，
 * `MIN_MOUNTED=2` 是硬下限、卸不掉邻页，总共 166.69MiB > 160MiB。
 * 不能改 MIN_MOUNTED，也不能降 16M 单块红线；正确做法是按总预算反推 dpr：
 *
 *   MIN_MOUNTED × 2 块 × 4 字节 × (794×1123×zoom²×dpr²) ≤ MOUNT_BUDGET_BYTES
 *   ⇒ dpr ≤ sqrt(BUDGET / (MIN_MOUNTED × 8 × 794×1123×zoom²))
 *
 * A4 在 3.5 倍时约 0.9798：比原来的 1 只低约 2%，仍远高于既有 0.75 地板，
 * 低倍率、平板原生 dpr 与 `inkRenderDprForZoom()` 的策略完全不变。
 *
 * ⚠️ `resizeRec()` 会把 backing 宽高 `Math.round()`；直接用连续 dpr 反推预算，
 * 整数向上舍入仍可能多出几 KB（实测 3.5 倍时 160.008MiB）。所以这里按**真实整数
 * 画布尺寸**判据二分出不超过两道上界的最大 dpr，不塞任何魔数裕量；
 * feel.html 也调用本函数并用同样的取整公式算内存，测的就是真实 renderDpr 路径。
 */
export function inkEffectiveRenderDpr(
  deviceDpr: number,
  zoom: number,
  pageWidth = 794,
  pageHeight = 1123,
  wantOverride?: number
): number {
  // wantOverride：给「导入文档页」这类需要更高超采样的页面用；仍受下面两道预算夹取。
  const want =
    wantOverride && wantOverride > 0 ? wantOverride : inkRenderDprForZoom(deviceDpr, zoom);
  const cssW = pageWidth * zoom;
  const cssH = pageHeight * zoom;
  const basePx = cssW * cssH;
  if (!(cssW > 0 && cssH > 0) || !Number.isFinite(basePx) || !(want > 0)) {
    return want;
  }
  const pixelCapDpr = Math.sqrt(MAX_CANVAS_PIXELS / basePx);
  const budgetCapDpr = Math.sqrt(MOUNT_BUDGET_BYTES / (MIN_MOUNTED * basePx * 4 * 2));
  const upper = Math.min(want, pixelCapDpr, budgetCapDpr);
  // 与旧 clamp(x, 0.75, want) 一致：want 本身低于 0.75 时仍保留 want。
  const floor = Math.min(0.75, want);
  const fits = (d: number): boolean => {
    const w = Math.round(cssW * d);
    const h = Math.round(cssH * d);
    if (!(w > 0 && h > 0)) return false;
    const px = w * h;
    return (
      px <= MAX_CANVAS_PIXELS &&
      MIN_MOUNTED * px * 4 * 2 <= MOUNT_BUDGET_BYTES
    );
  };
  if (!fits(floor)) return floor; // 极端自定义纸张仍守住既有地板
  if (fits(upper)) return upper;
  let lo = floor;
  let hi = upper;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

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
  /**
   * 一笔成型：off / lift（抬笔即识别）。只有开 / 关两态。
   * 只作用于钢笔 / 圆珠笔；荧光笔的半透明叠加与形状工具都不参与。
   */
  shapeSnap?: "off" | "lift";
  /** 激光笔：落笔只留会淡出的指示光迹，不写进本子 */
  laserPointer?: boolean;
  onState?: () => void;
  onChange?: () => void;
  onPageChange?: (index: number) => void;
  /**
   * 一次墨水手势（落笔 / 形状 / 擦除）结束了。
   *
   * 自动保存在书写期间会避让；收到这个回调时 view 重新排一次保存，
   * 这样不依赖「抬手刚好又改脏了」——橡皮停住不动再抬手时
   * 最后一次擦除早已 markDirty 过，不会再有新的 onChange。
   */
  onInkGestureEnd?: () => void;
  /**
   * 某页的底图（PDF / 图片）渲染好了，通知侧栏重画那一页的缩略图。
   *
   * 缩略图是懒渲染的：进视口时先画一张（那时 PDF 位图多半还没有），
   * 位图渲染完必须补一次，否则侧栏会一直停在灰底占位上。
   */
  onThumbNeedsRedraw?: (index: number) => void;
  /**
   * 批注文字装不下纸面、有行被裁掉时回调（参数是被裁的行数）。
   *
   * 排版层必须裁（不裁就是溢出纸外被静默吃掉，屏幕/导出/嵌入三处
   * 一致地"字不见了"）。原文不丢，但用户看不到就得告诉他。
   */
  onTextOverflow?: (hiddenLines: number) => void;
  /**
   * 点了文字里的 `[[双链]]`。由 view 负责解析目标并打开笔记
   * （Markdown 走 workspace.openLinkText、.inkbook 走 openBookAt）。
   * href 是「目标[#标题]」，page 只在 `.inkbook#数字` 时有值。
   */
  onOpenWikiLink?: (href: string, page: number | undefined, newTab: boolean) => void;
  /**
   * 文件块属性条上点了「打开源文件」：由 view 解析并打开源笔记 / Excalidraw 文件。
   */
  onOpenFileSource?: (path: string) => void;
  /**
   * 文件块属性条上点了「刷新快照」：由 view 重新生成快照，再调用
   * `editor.updateFileBlockSnapshot` 替换。参数是当前选中的图片对象。
   */
  onRefreshFileBlock?: (image: PageImage) => void;
  /**
   * 文字输入框里打 `[[` 时，返回可链接的库内文件（像原生 Obsidian 的链接补全）。
   * 由 view 提供（它拿得到 app.vault）；没有这个回调时自动补全整体不启用，
   * 不影响手打 `[[...]]` 的原有行为。
   */
  getLinkTargets?: () => LinkTarget[];
}

/** 按住连调：第一次重复前的等待（先 400ms 再开始加速） */
const SIZE_STEP_WAIT_MS = 400;
/** 按住连调：之后每步的间隔（平板单步太慢） */
const SIZE_STEP_REPEAT_MS = 100;

/**
 * 按住按钮连续步进的交互绑定（点一下走一档，按住连调）。
 *
 * 平板上字号一档一档点太慢：按下立刻走第一步（pointerdown 当场
 * 触发），400ms 后开始加速重复（每 100ms 一步），松指 / 指针离开
 * 按钮 / 窗口失焦 都停。
 *
 * 停摆判据挂在 document（**不是按钮上**）：侧栏的字号工具区每次
 * setTextSize 都会整体重建（setTextSize → emitState → updateUI →
 * renderDynamicTools），按住中的按钮会被换掉——按钮自身的 pointerup
 * 永远等不到，timer 会一路跑到底（− 按到底 8、＋ 按到底 96）。重建
 * 出的新按钮由下次 renderDynamicTools 重新绑定，旧闭包的监听随这次
 * pointerup 到 document 后随之移除，不泄漏。
 *
 * @param btn   目标按钮
 * @param onStep 每步动作（调用方只负责「走一档」，clamp 由内部完成）
 */
export function bindHoldStepBtn(btn: HTMLElement, onStep: () => void): () => void {
  let timer: number | null = null;
  /** 是否正处在一轮按住（防止重复 pointerdown 叠加多套监听与多个 timer） */
  let holding = false;
  /** 编辑器销毁后要彻底停手（否则 timer 会继续往已销毁的对象上写） */
  let disposed = false;

  function stop(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    /*
     * 四个监听都要摘掉，**包括按钮自己的 pointerleave**。
     *
     * 侧栏每次 setTextSize 都会重建工具区（按钮 DOM 换新），旧闭包随之作废；
     * 但在**不重建**的路径上（输入框样式条只在编辑期间存在），同一个按钮
     * 会被反复按下，只加不摘会累积监听。累积本身不致命（stop 幂等），
     * 但属于该收没收拾干净。
     */
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("blur", onWinBlur);
    btn.removeEventListener("pointerleave", stop);
    btn.classList.remove("is-held");
    holding = false;
  }

  const repeat = (): void => {
    if (disposed) return;
    onStep();
    timer = window.setTimeout(repeat, SIZE_STEP_REPEAT_MS);
  };

  function onUp(): void {
    stop();
  }

  function onCancel(): void {
    stop();
  }

  function onWinBlur(): void {
    stop();
  }

  btn.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    /* 只认主指针：鼠标右键留给浏览器菜单 */
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (disposed) return;
    // 上一轮还没收尾（例如 pointerup 丢在窗口外）：先收干净再重新开始
    if (holding) stop();
    holding = true;
    onStep();
    btn.classList.add("is-held");
    timer = window.setTimeout(repeat, SIZE_STEP_WAIT_MS);
    btn.addEventListener("pointerleave", stop);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onWinBlur);
  });

  /*
   * 返回「彻底停手」句柄：编辑器 destroy 时调它。
   *
   * 为什么必须显式停：手指按着步进按钮的同时切文件 / 关标签页，
   * 编辑器被销毁，但 pointerup 可能永远等不到（DOM 已拆）→
   * timer 会一路按到底，反复对已销毁的编辑器调 setTextSize。
   */
  return () => {
    disposed = true;
    stop();
  };
}

export class BookEditor {
  readonly host: HTMLElement;
  readonly scrollEl: HTMLElement;
  readonly docEl: HTMLElement;
  readonly store: BookStore;

  tool: ToolId = "pen";
  penColor = "#1A1A1A";
  penSize = 2.8;
  ballpointSize = 2.8;
  highlighterColor = "#F2C84B";
  highlighterSize = 24;
  shapeKind: ShapeKind = "rect";
  /*
   * 形状线宽：每种形状各记各的（用户要求「不同的形状不再共用同一个粗细」）。
   * 用 Record 而不是单个字段，切换形状种类时线宽自动跟着那一类走。
   */
  shapeSizes: Record<ShapeKind, number> = { line: 2.8, arrow: 2.8, rect: 2.8, ellipse: 2.8 };
  /** 自动把直线画直的开关（由设置同步进来） */
  private straighten = false;
  /** ========== 经典手写应用移植功能（默认关） ========== */
  /** 一笔成型：off / lift（抬笔即识别），只有开 / 关两态 */
  private shapeSnap: "off" | "lift" = "off";
  /** 激光笔光迹：页面坐标 + 落点时刻，按时间淡出 */
  private laserOn = false;
  private laserTrail: Array<{ x: number; y: number; t: number }> = [];
  private laserRaf = 0;
  /** 光迹属于哪一页：滚动到别的页时别把光迹画错地方 */
  private laserPage = -1;
  eraserMode: "whole" | "part" = "part";
  eraserSize = 26;
  zoom = 0.8;
  fitMode = true;

  private opts: EditorOptions;
  private recs: PageRec[] = [];
  private observer: IntersectionObserver | null = null;
  private current = 0;
  /**
   * 程序化翻页锁：点「下一页/上一页」后页码已经先切到目标页，平滑滚动途中
   * 探针仍停在旧页附近；这里在滚动到位（或超时）前压住 updateCurrentFromScroll，
   * 免得页码被中间页改回去又跳回来（用户要的是「页码先到、页面再滑过去」）。
   */
  private navLockTarget: { top: number; until: number } | null = null;
  /** 快滑结束后的收尾定时器：只在停稳后补挂当前页 / 广播一次页码 */
  private scrollSettleTimer = 0;
  /** 落点提示（locatePage）的自动清理定时器；0 = 当前没有提示 */
  private locateTimer = 0;
  /** 当前打着落点提示的页：同一时刻只保留一个，新提示先收掉旧的 */
  private locateRec: PageRec | null = null;
  /**
   * 上次 renderPages 时的页顺序版本（store.pageOrderRev）。
   *
   * 撤销/重做原来只比页数：页数不变但顺序变了（上移/下移）就不重建 DOM，
   * 主视图会「第 3 页的位置显示第 1 页的内容」。靠这个版本号捕捉换序。
   */
  private pageOrderRev = -1;
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
  /**
   * 输入框是否正在 IME 组字（拼音 / 假名还没上屏）。
   *
   * 组字期间 `textarea.value` 里混着未上屏的拼音，直接读它提交会把
   * 「半截拼音」写进本子。`commitTextEditNow` 在组字中默认推迟到
   * compositionend；必须立刻离开（销毁 / 关页）时只提交组字前的内容。
   */
  private textEditComposing = false;
  /** 最近一次组字开始前的 value（不含未上屏内容，强制离开时的兜底） */
  private textEditValueBeforeComp = "";
  /** 组字期间收到过提交请求：等 compositionend（词上屏）后再提交 */
  private textEditCommitPending = false;
  /**
   * 本次 pointerdown 是否落在「文字样式控件」上（带 data-mb-text-style）。
   *
   * 为什么不用 blur 的 relatedTarget 判断：iPad WKWebView 上点 button/select
   * 经常不转移焦点，relatedTarget 是 null，空框会被当成"点到别处"提交掉，
   * 「先选样式再输入」在平板（主场景）直接失效。
   * pointerdown 在 blur 之前到达，用捕获阶段的标记判断，跨平台稳定。
   */
  private textEditStylePress = false;
  private textEditPointerHandler: ((e: PointerEvent) => void) | null = null;
  /**
   * 文字输入框里打 `[[` 后弹出的「链接到哪篇笔记」候选列表
   * （类原生 Obsidian 的链接补全）。挂在 document.body 上、fixed 定位，
   * 因为输入框在缩放容器里，挂在页面内会被 `.mb-textlayer` / 页面 overflow 裁掉。
   */
  private linkSuggestEl: HTMLElement | null = null;
  /** 当前候选（已按已输入内容过滤），以及高亮项下标 */
  private linkSuggestItems: LinkTarget[] = [];
  private linkSuggestIndex = 0;
  /** 触发 `[[` 在 textarea.value 里的起点；-1 = 当前没有补全 */
  private linkSuggestStart = -1;
  /** 候选列表贴着哪个输入框定位 */
  private linkSuggestAnchor: HTMLTextAreaElement | null = null;
  /** 打开期间监听滚动 / 尺寸变化，重新贴回输入框 */
  private linkSuggestReposition: (() => void) | null = null;
  /** 本次编辑会话的候选缓存（库文件在编辑期间基本不变，避免每次按键都全量扫描） */
  private linkTargetsCache: LinkTarget[] | null = null;
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
  /** 正在拖右下角手柄改宽度（选择工具） */
  private resizeText: {
    rec: PageRec;
    id: string;
    startX: number;
    originW: number;
    moved: boolean;
  } | null = null;
  /** 上一次点文字的时间，用来识别双击（双击进编辑） */
  private lastTextTap: { id: string; t: number } | null = null;
  /**
   * 当前选中的**形状**笔迹 id（选择工具下有意义）。
   *
   * 只针对 `tool === "shape"` 画出的矩形 / 椭圆 / 直线 / 箭头：用户明确要求
   * 「选择功能能选中画出的形状并调整位置和大小」，普通笔迹仍不参与选择
   * （与 INK-100 移除通用笔迹选区一致）。与 `selectedTextId` 互斥。
   */
  private selectedShapeId: string | null = null;
  /** 正在拖动选中的形状（选择工具） */
  private moveShape: {
    rec: PageRec;
    id: string;
    startX: number;
    startY: number;
    /** 拖动起点时的原始采样点（只读，用来每帧从原点重算） */
    origin: Pt[];
    /** 拖动起点的包围盒（含笔宽外扩），用于把整块夹在纸内 */
    origBox: Bounds;
    /** 上一帧的包围盒，用来把「旧位置 + 新位置」并成一次局部重绘 */
    prevBounds: Bounds | null;
    moved: boolean;
  } | null = null;
  /** 正在拖动形状选框上的缩放手柄（选择工具） */
  private resizeShape: {
    rec: PageRec;
    id: string;
    handle: ShapeHandle;
    startX: number;
    startY: number;
    origin: Pt[];
    origBox: Bounds;
    prevBounds: Bounds | null;
    moved: boolean;
  } | null = null;
  /**
   * 当前选中的**插入图片** id（选择工具下有意义）。
   *
   * 与 `selectedTextId` / `selectedShapeId` 三者互斥：一次只选中一个对象，
   * 否则三个选框会叠在一起。图片是"贴纸"，选中后能拖动 / 四角缩放 / 删除。
   */
  private selectedImageId: string | null = null;
  /** 正在拖动选中的图片（选择工具） */
  private moveImage: {
    rec: PageRec;
    id: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    prevBox: Bounds | null;
    moved: boolean;
  } | null = null;
  /** 正在拖动图片选框的角手柄改大小（选择工具，保持长宽比） */
  private resizeImage: {
    rec: PageRec;
    id: string;
    handle: ShapeHandle;
    startX: number;
    startY: number;
    origBox: Bounds;
    aspect: number;
    prevBox: Bounds | null;
    moved: boolean;
  } | null = null;
  /** 选中图片后浮在图片上方的属性条（尺寸 + 删除） */
  private imageBarEl: HTMLElement | null = null;
  /** 选中文字后浮在纸上方的属性条 */
  private textBarEl: HTMLElement | null = null;
  /**
   * **新建**输入框正上方的就近样式条（字号 / 颜色）。
   *
   * 与 textBarEl 分开：那条是"选中已有文字"的属性条，这条只在空键新写时出现，
   * 让用户先定字号颜色再打字（打完再回头调是用户明确抱怨的流程）。
   * 只挂一份，编辑框关闭时随 commitTextEdit 一起移除。
   */
  private textEditBarEl: HTMLElement | null = null;
  /**
   * 样式条上「−/＋」步进按钮的停手句柄。
   *
   * 每次 `syncTextEditBar` 重建样式条都会新建一对，旧的在重建前调用。
   * `destroy()` 时全部调用，否则手指按着步进按钮切文件，timer 会继续
   * 往已销毁的编辑器上写（pointerup 可能永远等不到）。
   */
  private stepBtnStoppers: Array<() => void> = [];
  private pointerId: number | null = null;
  private draft: Stroke | null = null;
  private draftRec: PageRec | null = null;
  /**
   * 橡皮范围圈：既是"按下时擦到哪"，也是"没按下时鼠标在哪"。
   *
   * 为什么两种状态共用一个字段：CSS 里 `cursor: none` 把系统光标藏了，
   * 这个圈就是唯一的光标。悬停（不按下）和拖动（按下）都要显示，
   * 且都得用**同一个半径公式**（见 eraserRadiusAt），否则用户看到的圈
   * 和真正擦掉的范围对不上。
   *
   * pageIndex 记圈在哪一页：每页各有自己的 overlay，跨页移动时要能
   * 把上一页残留的圈抹掉；坐标是页面坐标系（pointFromEvent），
   * 所以缩放 / 滚动后不用重算。
   */
  private eraserPos: { x: number; y: number; r: number; pageIndex: number } | null = null;
  private undoPushed = false;
  /**
   * 擦除手势锁定的「页 + 层 id」。
   *
   * 为什么锁：手势期间用户可能切到别的层，若每次 eraseAt 都重新取
   * activeLayer，前态（eraseBefore）记的是 A 层、后态却又抓了 B 层，
   * 撤销记录就废了。开手势时定死，整段手势只动这一层。
   *
   * 存 id 而不是 Layer 对象引用：undo/redo 会用 JSON 快照整页重建，
   * 那一瞬间所有旧 Layer 对象都成了孤儿，持引用会改到看不见的死数据。
   */
  private eraseLayer: { pageIndex: number; layerId: string } | null = null;
  private lastPoint: { x: number; y: number; t: number } | null = null;
  private lastPressure: number | null = null;
  /** 输入滤波：去掉手抖和采样噪声 */
  private smoother = new OneEuroFilter(1.4, 0.035, 1.0);
  /**
   * 实时笔迹预测器：自适应预测时长 + 拟合修正 + 限幅。
   * 只在 overlay 预览里生成递细的贝塞尔尾巴，落笔数据仍是原始采样点，
   * 抬笔后尾巴自动丢弃——存档格式不变。
   */
  private inkPredictor = new InkPredictor();
  /** 上一笔的速度（页面单位/秒），用于速度—粗细联动 */
  private lastSpeed = 0;
  private pan: { x: number; y: number; left: number; top: number } | null = null;

  /**
   * 待恢复的滚动位置（页面像素，来自上次保存的 scrollTop）。
   *
   * 不能立刻写进 scrollEl：构造函数末尾排了一帧 rAF，里面会
   * goToPage(activePage)，把滚动位置拉到当前页顶部。必须等那一帧跑完
   * 再落，否则用户重开本子永远回到页首（INK-173）。
   */
  private pendingScrollTop: number | null = null;

  /**
   * 待恢复的**水平**滚动位置，语义与 pendingScrollTop 完全相同。
   *
   * 放大到纸比容器宽时才可能出现非 0 的 scrollLeft（没放大时纸居中，
   * 横向根本没得滚）。单独存一份是因为两者可能只有其一：纵向停在页首、
   * 横向却在右半边，或者反过来。恢复同样要等构造函数那帧 goToPage
   * 跑完、容器量出真实 scrollWidth 之后再落，否则会被夹成 0（INK-209）。
   */
  private pendingScrollLeft: number | null = null;

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
    /**
     * 本次惯性期间的最大可滚动距离（scrollHeight - clientHeight，px）。
     *
     * INK-229：原来每帧都读 `el.scrollHeight - el.clientHeight`，这是强制同步
     * 布局；而惯性期间页 DOM 结构不变（只是挂/卸画布，不改变 scrollHeight），
     * 所以起手时算一次就够，整个滑行复用。
     */
    max: number;
  } | null = null;
  /** 快速滑动的尾部宽限期；IO 在这段时间内新挂的页先不建几百/几千个文字 span。 */
  private fastScrollUntil = 0;
  /**
   * 快滑期间挂起的「软挂载预算」检查。
   *
   * IO 每跨一页都会回调，旧实现每次都遍历挂载页、读一堆 getBoundingClientRect
   * 再排序卸载；平板快速上下滑动时这些强制同步布局和 mount/unmount 抖动正是
   * 一卡一卡的来源。这里把软预算合并到一帧、快滑期直接延后到静止点；
   * 只有 MAX_MOUNTED 页数硬上限仍立即兜底，当前页挂载与视觉内容不变。
   */
  private mountLimitPending = false;
  /** 合并非快滑期多次 IO 回调的 rAF；0 = 没有排队。 */
  private mountLimitRaf = 0;
  /** 120ms 没有新的滑动帧就一次性补齐所有延后的文字层。 */
  private textLayerIdleTimer = 0;
  /** 快滑期间已挂载、尚未补建文字层的页（被卸载时自动移除）。 */
  private deferredTextLayers = new Set<PageRec>();
  /** 拆下来的文字层 LRU，最多 MAX_MOUNTED 条，避免重复 mount 重建大量 span。 */
  private textLayerCache = new Map<string, CachedTextLayer>();
  /**
   * 「笔记内查找」当前的查询词与**当前那条**命中（其余命中只标普通高亮）。
   *
   * 只作为渲染态：不进 store、不写盘、不参与撤销。文字 span 是按页数据
   * 重建的，所以查询词一变就要重画已挂载的文字层，并把旧缓存整批作废——
   * 否则滚回来复用的还是上一轮带（或不带）高亮的那层 DOM。
   */
  private findQuery = "";
  private findHit: FindMatch | null = null;
  /**
   * 拆下来的**主画布** LRU（INK-229 平板上下滑卡顿）。
   *
   * 卸载页时把已经画好的主 canvas 整块留着，滚回来签名一致就秒复用，
   * 不再每跨一页重分配 backing + 全量重绘（这正是「每滑一页顿一下」的根因）。
   * 按 **字节 + 条数** 双上限做 LRU（见 RASTER_CACHE_BYTES / MAX_RASTER_CACHED），
   * 不是只按页数：高倍率下一页两块能到 83MB，按页数会爆显存。
   * 条目里只放主画布，overlay 每次重画。
   */
  private rasterCache = new Map<string, CachedRaster>();
  private rasterCacheBytes = 0;
  /**
   * 整本内容年代号：只在「多页像素一起变」（撤销重做 / 整本换模板 /
   * 页对象重建）时 +1，rasterCache 里所有旧画布随之作废。
   *
   * 单页改动不走它：那些只把该页的缓存条目删掉（invalidateRaster），
   * 不惊动其它页——否则 PDF/Word 笔记首轮滚动时逐页补抽文字会把刚画好
   * 的画布一次次全清空。签名带上它，保证整本回滚后绝不复用旧像素。
   */
  private contentEpoch = 0;
  /** 手写字体就绪会改变字宽，缓存里的旧 span 一律失效。 */
  private handFontEpoch = 0;
  /**
   * 滚动速度采样。
   *
   * 抬手时要按「最近这一小段时间的平均速度」起算，
   * 而不是整段滑动的平均——用户最后减速了，
   * 用整段平均会让页面在已经慢下来时又猛地窜出去。
   */
  private velSamples: { t: number; y: number }[] = [];
  private overlayRaf = 0;
  /** 待重画的页（跨页移动时可能同时有新旧两页） */
  private overlayPending = new Set<number>();
  private scrollRaf = 0;
  /** 捏合期间 onState 的每帧合并（避免每帧刷整条工具栏） */
  private pinchStateRaf = 0;
  private destroyed = false;
  /**
   * 取消订阅「手写字体就绪」（见 src/handfont.ts）。
   *
   * 字体是异步解码的，第一屏文字往往在它到位之前就渲染完了：那时 span 的
   * font-family 已经写了 `"Inkbook Hand"`，浏览器按字回落到 Noto，等字体
   * 注册好**不会自动重排**。所以在构造时订阅一次，到位后重排文字层。
   */
  private offHandFont: (() => void) | null = null;
  private globalUp = (e: PointerEvent) => {
    if (this.gesture === "none" || this.pointerId !== e.pointerId) return;
    const rec = this.recs[this.current];
    if (rec) this.onUp(e, rec);
  };
  /**
   * 切后台 / 窗口失焦：提交文字框 + 收尾墨水手势。
   *
   * 平板上切 App 时 pointerup 可能永远不来，gesture 会卡在 "draw"，
   * 自动保存一避让就成了「永远不落盘」。这里主动结束手势：
   * 正在画的那一笔提交（而不是丢），橡皮则补好撤销记录。
   * 之后 view 的 flushSave 一定能把这部分写下去。
   *
   * 文字同理：打完字没按回车就切走，textarea 里那段字只在 DOM 里，
   * 移动端切后台未必触发 blur，不主动提交就会整段丢。
   * 组字中（拼音未上屏）先挂起，由 compositionend 补交。
   */
  private onWindowBlur = () => {
    this.commitTextEditNow();
    this.finishInkGesture();
    /*
     * 仲裁器也要复位（INK-191）。
     *
     * 切后台时笔的 pointerup / pointercancel 可能永远不来，
     * `penActive` 就残留成 true。回来之后所有手指都被判成「掌根」，
     * 页面滚不动、也写不了字，得等下一次落笔才自愈。
     * `reset()` 清空 pointers / penActive / touchCount / gesturing。
     */
    this.arbiter.reset();
    // 手势可能被切后台 / 笔落下打断，收不到 onGestureEnd：别把糊图留下来
    this.abortPinch();
  };
  private onVisibilityHidden = () => {
    if (document.visibilityState === "hidden") {
      // hidden 之后可能被系统直接回收：不等 compositionend，强制提交已上屏部分
      this.commitTextEditNow(true);
      this.finishInkGesture();
      // 同上：切后台等于「所有指针都不可信了」，必须清干净
      this.arbiter.reset();
      this.abortPinch();
    }
  };
  private resizeObserver: ResizeObserver | null = null;
  private resizeRaf = 0;
  /** 平板手势仲裁：笔 / 手指 / 多指手势 */
  private arbiter: TouchArbiter;
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
   *   主视图要的是"当前缩放下的清晰度"（放大到 3.5 倍时一张更大位图，旧上限 2.8 倍时约 2000px 宽、10MB），
   *   缩略图只要 160px 宽、约 150KB。共用同一个 LRU 的话，用户在侧栏
   *   翻上几十页就会把高清位图全挤出去，回到主视图又得重新光栅化、白闪一片。
   *   分开之后：缩略图浏览再狠也只吃自己那 32MB。
   */
  private thumbBitmaps = new BitmapCache({ budget: 32 * 1024 * 1024 });
  /**
   * 已经**画完的缩略图快照**（HTMLCanvasElement 小图）LRU。
   *
   * 与 thumbBitmaps 的区别：
   *   · thumbBitmaps 存的是 PDF 页的**原始位图**，只有导入的 PDF 页用得上；
   *   · 这里存的是整张缩略图的**最终像素**（纸面线 + 笔迹 + PDF/图片底图），
   *     滚出窗口再滚回来时直接 drawImage，连纸面线和笔迹都不用重画。
   *
   * key 是「页 id + 目标像素尺寸」，不是页号：
   *   · 上移/下移、插入、删除页后页号会变，页 id 跟着内容走；
   *   · 侧栏宽度 / dpr 变了会得到新尺寸，按新尺寸另画一份，不会拿小图硬拉。
   * 上限见 THUMB_SHOT_BUDGET / THUMB_SHOT_MAX；内容改变时按页失效（见 changed）。
   */
  private thumbShots = new Map<string, ThumbShot>();
  private thumbShotBytes = 0;
  private thumbShotClock = 0;
  /** 真正画过几眼缩略图（命中缓存不算）——诊断 / 测试用 */
  private thumbRasterized = 0;
  /** 缩略图缓存命中次数——诊断 / 测试用 */
  private thumbHits = 0;
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
  /**
   * 捏合期间是否已经走过 fast 路径（位图被 CSS 拉伸、尚未按新 zoom 重画）。
   * endPinch 据此补一次清晰度；窗口失焦 / 仲裁器复位收不到 endPinch 时也用它兜底。
   */
  private pinchNeedsRedraw = false;
  /** 手势结束后继续冻结页码判定的定时器（补偿还会再触发几帧 scroll） */
  private pinchReleaseTimer = 0;
  /** 同一帧只保留最后一次绝对 PinchInfo，避免两根手指各发一次 move 就全量重排两次。 */
  private pendingPinchInfo: PinchInfo | null = null;
  /** 捏合合流帧；0 = 当前没有排队，测试可据此确认一帧至多一次 applyPinch。 */
  private pinchFrameRaf = 0;
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
      onGestureMove: (info) => this.queuePinch(info),
      // 手势结束前必须先把这一帧的尾部坐标落下去，否则最终 zoom 会少一截。
      onGestureEnd: () => {
        this.flushPendingPinch();
        this.endPinch();
      },
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
    window.addEventListener("blur", this.onWindowBlur);
    document.addEventListener("visibilitychange", this.onVisibilityHidden);

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
    this.shapeSnap = normalizeShapeSnap(this.opts.shapeSnap);
    this.laserOn = this.opts.laserPointer === true;

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.destroyed || this.resizeRaf) return;
        // 显式缩放不需要重算比例，但后退切文件时容器可能暂时没有尺寸：
        // 之前 pending 滚动值三帧重试耗尽后，仍要等容器重新可见才能真正落下。
        if (!this.fitMode && this.pendingScrollTop == null && this.pendingScrollLeft == null) return;
        this.resizeRaf = requestAnimationFrame(() => {
          this.resizeRaf = 0;
          if (this.destroyed) return;
          if (this.fitMode) this.applyLayout();
          else this.applyPendingScroll();
        });
      });
      this.resizeObserver.observe(this.scrollEl);
    }

    this.renderPages();
    this.applyTouchAction();
    /*
     * 手写字体（INK-224）：注册是异步的（要解码 1.6MB base64 + 解析 woff2），
     * 第一屏文字大概率在它到位之前就渲染完了。那时 span 的 font-family
     * 已经写着 `"Inkbook Hand"`，浏览器按字回落到 Noto Sans SC ——
     * 字体注册完成**不会**自动重排（CSS 只认家族名，不认加载状态）。
     *
     * 所以这里订阅一次：字体到位后重排所有已挂载页的文字层。
     * 只重排文字层，不重画笔迹（笔迹与字体无关，重画是白烧一遍 CPU）。
     */
    ensureHandFontIdle();
    this.offHandFont = onHandFontReady(() => {
      if (this.destroyed) return;
      // 手写字体改变字宽：拆下来的旧文字层绝不能再复用。
      this.handFontEpoch += 1;
      this.invalidateTextLayerCache();
      for (const rec of this.recs) {
        if (rec.mounted) this.renderTextLayer(rec);
      }
      /*
       * 正在编辑的 textarea 也要跟着换字体：它是独立的 DOM 元素，
       * 不跟着文字层走。用户在字体到位前就开始打字时能看到字形突然变化，
       * 比"提交后跳一下"自然。
       *
       * 这里只改样式，不走 applyTextEditStyle —— 那个函数末尾会把焦点
       * 抢回 textarea，而字体到位是**异步**的，可能发生在用户已经去点
       * 侧栏的时候，抢焦点会打断他。
       */
      const ed = this.textEdit;
      if (ed) ed.el.style.fontFamily = textFontStack(ed.font);
    });
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
    /*
     * **容器/页面还没布局时不要污染基准**（INK-211）。
     *
     * 这三个 rect 全是 0 说明元素还没进渲染树（标签页刚重建、容器
     * display:none、Word 大底图正把主线程占满导致这一帧没布局）。
     * 此时算出来的 `pageOrigin` 是个垃圾值（通常是 0 或负的容器高），
     * 而它被 `pickAnchor` 用来定位「手指下方是哪一页的哪个点」——
     * 基准一错，锚点就选错，`restoreAnchor` 再按错误锚点补偿，
     * 会把页面推到滚动极限并卡在那儿（用户描述：「缩小后卡在最下面，
     * 再也放不大」）。保留上一次的有效值，等布局好了再量。
     */
    const laidOut =
      (scrollRect.width > 0 || scrollRect.height > 0) &&
      (firstTop !== 0 || this.scrollEl.scrollTop === 0);
    if (!laidOut) return;
    // 首页顶部在滚动内容里的位置
    this.pageOrigin =
      firstTop - scrollRect.top + this.scrollEl.scrollTop;
    this.docOrigin = docRect.top - scrollRect.top + this.scrollEl.scrollTop;
  }

  /* ------------------------------- 状态 ------------------------------- */

  /**
   * 是否有一笔「墨」还压在纸上：落笔 / 画形状 / 擦除。
   *
   * 自动保存据此避让：笔还压着时去 `JSON.stringify(整本)`，平板大本子
   * 会把主线程冻 1.5~2.5s，这一笔卡在半空。
   *
   * 判据是**手势 + pointerId**，不是 `draft !== null`：橡皮没有 draft，
   * 只看 draft 会漏掉橡皮；翻页 / 捏合 / 甩滚动（pan）不算——页面在滚，
   * 它们不改内容，不该为它们推迟落盘。
   */
  isInkBusy(): boolean {
    return (
      this.pointerId != null &&
      (this.gesture === "draw" ||
        this.gesture === "shape" ||
        this.gesture === "erase" ||
        this.gesture === "moveShape" ||
        this.gesture === "resizeShape")
    );
  }

  /**
   * 强制收尾当前墨水手势（切后台 / 窗口失焦 / 事件丢失兜底）。
   *
   * 为什么必须「提交」而不是丢弃：view 的 flushSave 只写已提交内容，
   * 正在画的 draft 若不提交，这一笔就永远只活在内存里。
   * 橡皮的改动本来就是实时写进 layer 的，这里只需补上撤销记录并结束手势，
   * 否则 gesture 会一直停在 "erase"，把自动保存永远挡在门外。
   *
   * 返回是否真的结束了一个墨水手势。
   */
  finishInkGesture(): boolean {
    // 激光笔不改内容，失焦时只把光迹收掉，不能走「提交草稿」那条路
    if (this.gesture === "laser") {
      this.gesture = "none";
      this.pointerId = null;
      this.laserTrail = [];
      this.stopLaserFade();
      this.repaintOverlays();
      return false;
    }
    if (this.gesture === "draw" || this.gesture === "shape") {
      const rec = this.draftRec;
      // 先把手势状态清掉，再提交：commitDraft → changed → markDirty
      // 期间若有人问 isInkBusy，答案应该是「已经结束了」。
      this.gesture = "none";
      this.pointerId = null;
      this.smoother.reset();
      this.inkPredictor.reset();
      if (rec) {
        this.commitDraft(rec);
      } else {
        this.draft = null;
        this.draftRec = null;
      }
      if (this.opts.onInkGestureEnd) this.opts.onInkGestureEnd();
      return true;
    }
    if (this.gesture === "erase") {
      this.gesture = "none";
      this.pointerId = null;
      // 切后台 / 丢事件兜底：圈不该在回来后还挂在旧位置
      this.eraserPos = null;
      // 与 onUp 的 erase 分支保持一致：整条擦除手势合成一条历史，并补一次整页重画
      this.finishEraseGesture(this.recs[this.current] ?? null);
      this.emitState();
      if (this.opts.onInkGestureEnd) this.opts.onInkGestureEnd();
      return true;
    }
    if (this.gesture === "moveShape" || this.gesture === "resizeShape") {
      this.finishShapeEdit();
      return true;
    }
    return false;
  }

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
      ballpointSize: this.ballpointSize,
      highlighterColor: this.highlighterColor,
      highlighterSize: this.highlighterSize,
      shapeKind: this.shapeKind,
      shapeSize: this.shapeSizes[this.shapeKind] ?? this.penSize,
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
     * 捏合每帧都改 zoom，工具栏的百分比不能一直停在手势开始前的值。
     * onState → view.updateUI() 会 setText 并排一次滑条同步，直接每帧调
     * 又是主线程活儿；合并到一帧里只跑一次。手势外的状态变化仍走同步路径。
     */
    if (this.pinch) {
      if (this.pinchStateRaf) return;
      this.pinchStateRaf = requestAnimationFrame(() => {
        this.pinchStateRaf = 0;
        if (this.opts.onState) this.opts.onState();
      });
      return;
    }
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
    // 形状选择同理：换了页 / 撤销 / 删除把笔迹去掉了，就丢掉这个 id
    if (this.selectedShapeId && !this.selectedShape) {
      this.selectedShapeId = null;
    }
    // 图片选择同理：换页 / 撤销 / 删除后当前页找不到它了，连属性条一起收掉
    if (this.selectedImageId && !this.selectedImage) {
      this.selectedImageId = null;
      this.imageBarEl?.remove();
      this.imageBarEl = null;
    }
    if (this.opts.onState) this.opts.onState();
  }

  private changed(): void {
    /*
     * 内容变了 → 当前页的缩略图快照作废。
     *
     * 缩略图不能显示旧笔迹。所有内容改动都会在改完后走到这里，而且改的
     * 就是 current 页：落笔 / 擦除在 onDown 里先把 current 对齐到按下的页，
     * 模板 / 纸张 / 图层 / 撤销重做也都作用在当前页（撤销会把 activePage
     * 设到被改的那页）。整本范围的改动（全部换模板、整本快照撤销）另外
     * 在调用点 clearThumbShots()。
     *
     * 这里只按页 id 删，不会误伤其他页滚回来时还能用的快照；
     * 文字改动其实不进缩略图（renderThumbnail 不画 texts），多失效一次
     * 只是下次刷新重画一张小图，不追求零成本。
     */
    const page = this.store.page;
    if (page) this.invalidateThumb(page.id);
    /*
     * 内容变了 → 该页脱离 DOM 的旧主画布像素作废（INK-229）。
     *
     * 所有「改变某页像素」的入口（落笔 / 擦除 / 模板纸张 / 图层 / 撤销重做）
     * 最后都会走到 changed()。这里只作废**当前页**那一条：
     *   · 改动作用的就是 current 页，其余页像素没变，没有理由一起丢；
     *   · 更关键的是首轮滚动——PDF/Word 笔记每页首次挂载都会异步补抽文字
     *     并调一次 changed()，若这里全局清空，刚滑过去那几页已画好的画布
     *     会被全部丢掉，「滚回去秒开」的复用机会一次都用不上。
     * 多页一起变的路径（整本换模板 / 撤销重做 / 页对象重建 / 底图到位）
     * 各自显式调 invalidateRasterCache()，绝不错画。
     */
    if (page) this.invalidateRaster(page.id);
    if (this.opts.onChange) this.opts.onChange();
  }

  setPenOnly(on: boolean): void {
    this.opts.penOnly = on;
    this.applyTouchAction();
    this.emitState();
  }

  /*
   * 二次夹取：settings 的 loadSettings 已经校验过一轮，但 setPressure /
   * setSmoothing 是运行时入口（syncSettings、测试 harness、未来新调用方
   * 都可能直接传值）。非法值一旦落到 opts 上，pressureFor 会把它一路带进
   * stroke.points 写盘；平滑为负还会让 1€ 的 minCutoff 变 21、beta 变负，
   * alpha 成负数导致坐标发散。所以这里拒绝 NaN/Infinity 并夹到面板区间。
   */
  setPressure(v: number): void {
    this.opts.pressure = Number.isFinite(v) ? clamp(v, 0.3, 1.5) : 1;
  }

  setSmoothing(v: number): void {
    this.opts.smoothing = Number.isFinite(v) ? clamp(v, 0, 1) : 0.55;
  }

  setPrediction(on: boolean): void {
    this.opts.prediction = on;
    // 关掉再打开时不能接着上一笔的滑窗预测，否则尾巴会跳到旧位置
    this.inkPredictor.reset();
  }

  setTool(tool: ToolId): void {
    if (this.tool === tool) return;
    this.tool = tool;
    /*
     * 切走橡皮时圈必须真的从屏幕上消失：eraserPos 只清了数据，
     * 不重画 overlay 的话上一帧画的圈会一直留着（"幽灵圈"）。
     */
    this.clearEraserPos();
    // 离开文字/选择工具就没有"选中文字"这回事了，属性条一并收掉
    if (tool !== "text" && tool !== "select") this.selectText(null);
    // 形状选择只在「选择」工具下有意义：切到别的工具就取消
    if (tool !== "select") this.selectShape(null);
    // 图片选择同理：只在「选择」工具下有意义
    if (tool !== "select") this.selectImage(null);
    this.applyTouchAction();
    this.emitState();
  }

  get textSize(): number {
    return this.textSizeValue;
  }

  setTextSize(size: number): void {
    const v = clamp(Math.round(size), 8, 96);
    const changed = v !== this.textSizeValue;
    this.textSizeValue = v;
    /*
     * 编辑框开着时优先照顾框里的预览（新建或改已有文字都一样）。
     * 改已有文字时同时写回 store，保持"选中它再改字号"的既有语义；
     * 不能走 else 分支的早退——旧实现里 v === 默认值 时直接 return，
     * 编辑 30 号文字时点「18」会毫无反应。
     */
    const ed = this.textEdit;
    if (ed) {
      if (ed.id && this.selectedText) this.updateSelectedText({ size: v });
      this.applyTextEditStyle({ size: v });
      this.emitState();
      return;
    }
    const sel = this.selectedText;
    if (sel) this.updateSelectedText({ size: v });
    else if (changed) this.emitState();
  }

  /**
   * 字号步进按钮的「走一档」动作（值 ±1）。
   *
   * 编辑框开着时按框里**待提交**的值算（新建框 = 预览值），
   * 否则按当前字号算；结果永远交给 setTextSize 的 clamp 8~96，
   * 调用方不许直接写字段。
   *
   * 「值取哪个」判据放在这里而不在按钮侧：编辑已有文字（.mb-textbar
   * 那条）时框里的值与 textSizeValue 可能不一致（比如选中 30 号文字、
   * 当前字号默认 18，按 textSizeValue 步进会从 18 起步而不是 30）。
   */
  stepTextSize(delta: number): void {
    const ed = this.textEdit;
    const cur = ed ? ed.size : this.textSizeValue;
    this.setTextSize(cur + delta);
  }

  /**
   * 把样式改动实时喂给正在打开的输入框。
   *
   * 只改**预览**（textarea 的样式与待提交的 size/color/font），
   * 不碰 store、不记历史；提交时 commitTextEdit 会用更新后的值写入。
   */
  private applyTextEditStyle(patch: { size?: number; color?: string; font?: string }): void {
    const ed = this.textEdit;
    if (!ed) return;
    if (typeof patch.size === "number") {
      ed.size = patch.size;
      /*
       * 字号变了要重新过一遍排版夹取：否则在页底放大字号，
       * 框会伸到纸外，提交后 layout 又把它拉回纸内——用户看到的是「跳一下」。
       * 已有文字保留了手动框宽，预览也要用同一个宽度，断行才和提交后一致。
       */
      const src = ed.id
        ? this.store.data.pages[ed.rec.index]?.texts?.find((t) => t.id === ed.id)
        : null;
      const l = this.textLayout({
        x: ed.x,
        y: ed.y,
        size: ed.size,
        text: ed.el.value,
        font: ed.font,
        width: src?.width,
      });
      ed.y = l.y;
    }
    if (patch.color) ed.color = patch.color;
    if (patch.font) ed.font = patch.font;
    const ta = ed.el;
    ta.style.fontSize = `${ed.size * this.zoom}px`;
    ta.style.fontFamily = textFontStack(ed.font);
    ta.style.color = ed.color;
    // 基线固定在 y，字号变了顶边要跟着重算（0.82 个字高是基线上方的距离）
    ta.style.top = `${(ed.y - ed.size * 0.82) * this.zoom}px`;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
    // 字号变了输入框顶边会跟着动，样式条的高亮和位置都要跟上
    this.updateTextEditBar();
    /*
     * 点侧栏按钮会把焦点抢走，这里夺回来，用户改完样式可以直接接着打。
     * <select> 的下拉此时已经关闭（change 才触发），不会被打断。
     * 但焦点在「自定义字号输入框」（.mb-tb-sizein / .mb-size-in）上时
     * 不能抢：用户正在那儿打字，夺回来会把下一个字符落到 textarea 里。
     */
    const ae = document.activeElement as HTMLElement | null;
    const keep = !!ae && (ae.matches(".mb-tb-sizein") || ae.matches(".mb-size-in"));
    ta.focus();
    if (keep && ae) ae.focus();
  }

  get textFont(): string {
    return this.textFontValue;
  }

  setTextFont(id: string): void {
    if (!TEXT_FONTS.some((f) => f.id === id)) return;
    const changed = id !== this.textFontValue;
    this.textFontValue = id;
    const ed = this.textEdit;
    if (ed) {
      if (ed.id && this.selectedText) this.updateSelectedText({ font: id });
      this.applyTextEditStyle({ font: id });
      this.emitState();
      return;
    }
    const sel = this.selectedText;
    if (sel) this.updateSelectedText({ font: id });
    else if (changed) this.emitState();
  }

  get textColor(): string {
    return this.textColorValue;
  }

  setTextColor(color: string): void {
    if (!color) return;
    const changed = color !== this.textColorValue;
    this.textColorValue = color;
    const ed = this.textEdit;
    if (ed) {
      if (ed.id && this.selectedText) this.updateSelectedText({ color });
      this.applyTextEditStyle({ color });
      this.emitState();
      return;
    }
    const sel = this.selectedText;
    if (sel) this.updateSelectedText({ color });
    else if (changed) this.emitState();
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
    if (id) this.clearImageSelection();
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

  /* --------------------------- 选中形状对象 --------------------------- */

  /** 当前页选中的形状笔迹；页面里找不到（或被撤销/删除）就是 null */
  get selectedShape(): Stroke | null {
    if (!this.selectedShapeId) return null;
    const page = this.store.data.pages[this.current];
    if (!page) return null;
    const s = this.findStrokeById(page, this.selectedShapeId);
    return s && s.tool === "shape" ? s : null;
  }

  /** 按 id 在整页各层里找一条笔迹 */
  private findStrokeById(page: Page, id: string): Stroke | null {
    for (const layer of page.layers) {
      const s = layer.strokes.find((x) => x.id === id);
      if (s) return s;
    }
    return null;
  }

  /**
   * 选中 / 取消选中一条形状笔迹。
   *
   * 与 `selectText` 互斥：选中形状时先清掉文字选择，避免两个选框同时出现。
   */
  selectShape(id: string | null): void {
    if (this.selectedShapeId === id) return;
    this.selectedShapeId = id;
    if (id) {
      this.selectText(null);
      this.clearImageSelection();
    }
    const rec = this.recs[this.current];
    if (rec) this.renderOverlay(rec);
    this.emitState();
  }

  /**
   * 形状选框的几何：紧贴笔迹点集的包围盒（含笔宽/箭头外扩余量）。
   *
   * 画框、手柄命中都读这一份；缩放的坐标映射另用 `rawPointBounds`（不含
   * 外扩），否则按含 padding 的框做比例映射会让没拖动的那条边也漂移几像素。
   */
  private shapeSelBox(s: Stroke): Bounds {
    return strokeBounds(s);
  }

  /** 只按点集算的裸包围盒（不做笔宽外扩），缩放映射用 */
  private rawPointBounds(s: Stroke): Bounds {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of s.points) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
    if (!Number.isFinite(minX)) minX = minY = maxX = maxY = 0;
    return { minX, minY, maxX, maxY };
  }

  /** 形状选框上的 8 个手柄位置（页面坐标） */
  private shapeHandlePoints(b: Bounds): Array<{ h: ShapeHandle; x: number; y: number }> {
    const mx = (b.minX + b.maxX) / 2;
    const my = (b.minY + b.maxY) / 2;
    return [
      { h: "nw", x: b.minX, y: b.minY },
      { h: "n", x: mx, y: b.minY },
      { h: "ne", x: b.maxX, y: b.minY },
      { h: "e", x: b.maxX, y: my },
      { h: "se", x: b.maxX, y: b.maxY },
      { h: "s", x: mx, y: b.maxY },
      { h: "sw", x: b.minX, y: b.maxY },
      { h: "w", x: b.minX, y: my },
    ];
  }

  /** 命中了哪个缩放手柄（半径按屏幕像素反算，照顾手指） */
  private hitShapeHandle(b: Bounds, px: number, py: number, hitR: number): ShapeHandle | null {
    for (const hp of this.shapeHandlePoints(b)) {
      if (Math.hypot(px - hp.x, py - hp.y) <= hitR) return hp.h;
    }
    return null;
  }

  /**
   * 点是否落在某条形状笔迹的可选区域内。
   *
   * 矩形 / 椭圆的**内部**也算命中（形状是空心描边，只认边线的话很难点中）；
   * 直线 / 箭头按到线段的距离判。容差按屏幕像素反算，缩放下手感一致。
   */
  private shapeStrokeHit(s: Stroke, x: number, y: number): boolean {
    const pts = s.points;
    if (pts.length < 2) return false;
    const [x1, y1] = pts[0];
    const [x2, y2] = pts[pts.length - 1];
    const tol = Math.max(7 / this.zoom, s.size / 2 + 2);
    const kind = s.shape ?? "rect";
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);
    const w = maxX - minX;
    const h = maxY - minY;
    if (kind === "rect" || kind === "ellipse") {
      // 退化成一条线（宽或高≈0）时按线段判，否则点不到
      if (w < 1 || h < 1) return pointSegmentDistance(x, y, x1, y1, x2, y2) <= tol;
      if (kind === "rect") {
        return x >= minX - tol && x <= maxX + tol && y >= minY - tol && y <= maxY + tol;
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const rx = w / 2 + tol;
      const ry = h / 2 + tol;
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      return nx * nx + ny * ny <= 1;
    }
    return pointSegmentDistance(x, y, x1, y1, x2, y2) <= tol;
  }

  /** 选择工具下，取点处最上层（后画）的形状笔迹 */
  private hitShape(page: Page, x: number, y: number): Stroke | null {
    for (let li = page.layers.length - 1; li >= 0; li--) {
      const layer = page.layers[li];
      if (!layer.visible) continue;
      for (let si = layer.strokes.length - 1; si >= 0; si--) {
        const s = layer.strokes[si];
        if (s.tool !== "shape") continue;
        if (this.shapeStrokeHit(s, x, y)) return s;
      }
    }
    return null;
  }

  /**
   * 按下形状选框、开始拖动/缩放。
   *
   * 历史在**第一次真正移动**时才 snapshot（点一下选中不该产生一条撤销记录），
   * 拖动期间原地改 points 并做局部重绘，抬手时 touch() 结算成一条历史。
   */
  private beginShapeGesture(
    rec: PageRec,
    stroke: Stroke,
    px: number,
    py: number,
    e: PointerEvent,
    handle: ShapeHandle | null
  ): void {
    const origin = stroke.points.map((p) => [p[0], p[1], p[2]] as Pt);
    const box = strokeBounds(stroke);
    const raw = this.rawPointBounds(stroke);
    this.pointerId = e.pointerId;
    if (handle) {
      this.gesture = "resizeShape";
      this.resizeShape = {
        rec,
        id: stroke.id,
        handle,
        startX: px,
        startY: py,
        origin,
        origBox: raw,
        prevBounds: { ...box },
        moved: false,
      };
      this.moveShape = null;
    } else {
      this.gesture = "moveShape";
      this.moveShape = {
        rec,
        id: stroke.id,
        startX: px,
        startY: py,
        origin,
        origBox: { ...box },
        prevBounds: { ...box },
        moved: false,
      };
      this.resizeShape = null;
    }
    try {
      rec.pageEl.setPointerCapture?.(e.pointerId);
    } catch (_) {}
    e.preventDefault();
  }

  /**
   * 结束形状拖动/缩放：结算一条撤销记录并整页重画一次（收掉局部重绘可能
   * 残留的半像素）。onUp / 切后台 / 笔落下打断都走这一处。
   */
  private finishShapeEdit(): void {
    const m = this.moveShape ?? this.resizeShape;
    const rec = m?.rec ?? null;
    const moved = !!m?.moved;
    if (this.gesture === "moveShape" || this.gesture === "resizeShape") this.gesture = "none";
    this.pointerId = null;
    this.moveShape = null;
    this.resizeShape = null;
    if (!moved || !rec) return;
    this.store.touch();
    this.changed();
    this.renderRec(rec);
    this.renderOverlay(rec);
    this.emitState();
    if (this.opts.onInkGestureEnd) this.opts.onInkGestureEnd();
  }

  /**
   * 把裸包围盒按拖动的手柄、按位移量算成新包围盒。
   *
   * 用位移（dx/dy）而不是绝对坐标：手柄画在含笔宽外扩的选框上，而坐标映射
   * 用的是裸点集，两者相差一个 padding；按位移改边就不会把那点 padding
   * 带进结果，没被拖的边严格不动。
   * 只动被拖的那条边 / 角；小于最小尺寸时绕中心撑开，最后夹在纸内。
   */
  private resizeRawBox(
    ob: Bounds,
    handle: ShapeHandle,
    dx: number,
    dy: number
  ): Bounds {
    let minX = ob.minX;
    let maxX = ob.maxX;
    let minY = ob.minY;
    let maxY = ob.maxY;
    if (handle.includes("w")) minX = ob.minX + dx;
    if (handle.includes("e")) maxX = ob.maxX + dx;
    if (handle.includes("n")) minY = ob.minY + dy;
    if (handle.includes("s")) maxY = ob.maxY + dy;
    let x0 = Math.min(minX, maxX);
    let x1 = Math.max(minX, maxX);
    let y0 = Math.min(minY, maxY);
    let y1 = Math.max(minY, maxY);
    const MIN = 6;
    if (x1 - x0 < MIN) {
      const c = (x0 + x1) / 2;
      x0 = c - MIN / 2;
      x1 = c + MIN / 2;
    }
    if (y1 - y0 < MIN) {
      const c = (y0 + y1) / 2;
      y0 = c - MIN / 2;
      y1 = c + MIN / 2;
    }
    const W = this.store.data.width;
    const H = this.store.data.height;
    return {
      minX: clamp(x0, 0, W),
      minY: clamp(y0, 0, H),
      maxX: clamp(x1, 0, W),
      maxY: clamp(y1, 0, H),
    };
  }

  /** 把两块包围盒并成一块（外扩 pad），用于拖动时一次局部重绘旧+新位置 */
  private dirtyUnion(a: Bounds | null, b: Bounds, pad: number): Bounds {
    if (!a) {
      return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
    }
    return {
      minX: Math.min(a.minX, b.minX) - pad,
      minY: Math.min(a.minY, b.minY) - pad,
      maxX: Math.max(a.maxX, b.maxX) + pad,
      maxY: Math.max(a.maxY, b.maxY) + pad,
    };
  }

  /** 删掉选中的形状（Delete / Backspace） */
  deleteSelectedShape(): void {
    if (this.readOnly) return;
    const sel = this.selectedShape;
    const rec = this.recs[this.current];
    if (!sel || !rec) return;
    this.store.removeStrokes(new Set([sel.id]), rec.index);
    this.selectedShapeId = null;
    this.changed();
    this.renderRec(rec);
    this.renderOverlay(rec);
    this.emitState();
  }

  /* --------------------------- 插入图片对象 --------------------------- */

  /** 当前页选中的图片；页面里找不到就是 null */
  get selectedImage(): PageImage | null {
    if (!this.selectedImageId) return null;
    const page = this.store.data.pages[this.current];
    return page?.images?.find((im) => im.id === this.selectedImageId) ?? null;
  }

  /** 只是把「选中图片」这个状态清掉（不重画，调用方自己会重画） */
  private clearImageSelection(): void {
    if (!this.selectedImageId && !this.imageBarEl) return;
    this.selectedImageId = null;
    this.imageBarEl?.remove();
    this.imageBarEl = null;
  }

  /**
   * 选中 / 取消选中一张图片。与文字、形状选择三者互斥。
   */
  selectImage(id: string | null): void {
    if (this.selectedImageId === id) return;
    this.selectedImageId = id;
    if (id) {
      this.selectText(null);
      this.selectShape(null);
    }
    const rec = this.recs[this.current];
    if (rec) this.renderOverlay(rec);
    this.syncImageBar();
    this.emitState();
  }

  /** 图片选框的几何：就是它自己的矩形 */
  private imageSelBox(im: PageImage): Bounds {
    return { minX: im.x, minY: im.y, maxX: im.x + im.width, maxY: im.y + im.height };
  }

  /**
   * 图片选框的 4 个角手柄。
   *
   * 图片只给四个角（不给四条边中点）：缩放要保持长宽比，边中点拖起来
   * 要么只能单向拉伸导致变形，要么语义含糊。四角 + 锁比例最直观。
   */
  private imageHandlePoints(b: Bounds): Array<{ h: ShapeHandle; x: number; y: number }> {
    return [
      { h: "nw", x: b.minX, y: b.minY },
      { h: "ne", x: b.maxX, y: b.minY },
      { h: "se", x: b.maxX, y: b.maxY },
      { h: "sw", x: b.minX, y: b.maxY },
    ];
  }

  private hitImageHandle(b: Bounds, px: number, py: number, hitR: number): ShapeHandle | null {
    for (const hp of this.imageHandlePoints(b)) {
      if (Math.hypot(px - hp.x, py - hp.y) <= hitR) return hp.h;
    }
    return null;
  }

  /** 选择工具下取点处最上层（后插入）的图片 */
  private hitImage(page: Page, x: number, y: number): PageImage | null {
    const imgs = page.images;
    if (!imgs?.length) return null;
    for (let i = imgs.length - 1; i >= 0; i--) {
      const im = imgs[i];
      if (x >= im.x && x <= im.x + im.width && y >= im.y && y <= im.y + im.height) return im;
    }
    return null;
  }

  /**
   * 按下图片选框，开始拖动 / 缩放。
   * 历史与形状一致：第一次真正移动才 snapshot，抬手时 touch() 结算成一条。
   */
  private beginImageGesture(
    rec: PageRec,
    im: PageImage,
    px: number,
    py: number,
    e: PointerEvent,
    handle: ShapeHandle | null
  ): void {
    this.pointerId = e.pointerId;
    const box = this.imageSelBox(im);
    if (handle) {
      this.gesture = "resizeImage";
      this.resizeImage = {
        rec,
        id: im.id,
        handle,
        startX: px,
        startY: py,
        origBox: box,
        aspect: im.height > 0 ? im.width / im.height : 1,
        prevBox: { ...box },
        moved: false,
      };
      this.moveImage = null;
    } else {
      this.gesture = "moveImage";
      this.moveImage = {
        rec,
        id: im.id,
        startX: px,
        startY: py,
        originX: im.x,
        originY: im.y,
        prevBox: { ...box },
        moved: false,
      };
      this.resizeImage = null;
    }
    try {
      rec.pageEl.setPointerCapture?.(e.pointerId);
    } catch (_) {}
    e.preventDefault();
  }

  /** 结束图片拖动/缩放：结算一条撤销记录并整页重画一次 */
  private finishImageEdit(): void {
    const m = this.moveImage ?? this.resizeImage;
    const rec = m?.rec ?? null;
    const moved = !!m?.moved;
    if (this.gesture === "moveImage" || this.gesture === "resizeImage") this.gesture = "none";
    this.pointerId = null;
    this.moveImage = null;
    this.resizeImage = null;
    if (!moved || !rec) return;
    this.store.touch();
    this.changed();
    this.renderRec(rec);
    this.renderOverlay(rec);
    this.syncImageBar();
    this.emitState();
    if (this.opts.onInkGestureEnd) this.opts.onInkGestureEnd();
  }

  /**
   * 四角缩放：保持长宽比，锚定对角，夹在纸内、最小 24px。
   * 用位移（dx/dy）而不是绝对坐标，理由与形状缩放一致（手柄有外扩，
   * 按位移改边才不会让没拖的那边漂移）。
   */
  private resizeImageBox(
    orig: Bounds,
    handle: ShapeHandle,
    dx: number,
    dy: number,
    aspect: number
  ): Bounds {
    const W = this.store.data.width;
    const H = this.store.data.height;
    const ow = Math.max(1, orig.maxX - orig.minX);
    const ratio = aspect > 0 ? aspect : ow / Math.max(1, orig.maxY - orig.minY);
    const MIN = 24;
    const anchorX = handle.includes("e") ? orig.minX : orig.maxX;
    const anchorY = handle.includes("s") ? orig.minY : orig.maxY;
    let newW = ow + (handle.includes("e") ? dx : -dx);
    const maxWByPage = handle.includes("e") ? W - anchorX : anchorX;
    const maxHByPage = handle.includes("s") ? H - anchorY : anchorY;
    // 同时受页宽、页高约束（高度 = 宽 / 比例）
    newW = Math.min(newW, maxWByPage, maxHByPage * ratio);
    newW = Math.max(MIN, newW);
    const newH = newW / ratio;
    let x = handle.includes("e") ? anchorX : anchorX - newW;
    let y = handle.includes("s") ? anchorY : anchorY - newH;
    x = clamp(x, 0, Math.max(0, W - newW));
    y = clamp(y, 0, Math.max(0, H - newH));
    return { minX: x, minY: y, maxX: x + newW, maxY: y + newH };
  }

  /** 删掉选中的图片（Delete / 属性条上的「删除」）。图片文件保留：撤销要能找回来 */
  deleteSelectedImage(): void {
    if (this.readOnly) return;
    const sel = this.selectedImage;
    const rec = this.recs[this.current];
    if (!sel || !rec) return;
    const page = this.store.data.pages[rec.index];
    if (!page?.images?.length) return;
    this.store.snapshotPage(rec.index);
    page.images = page.images.filter((im) => im.id !== sel.id);
    if (!page.images.length) delete page.images;
    this.store.touch();
    this.changed();
    this.selectedImageId = null;
    this.imageBarEl?.remove();
    this.imageBarEl = null;
    this.renderRec(rec);
    this.renderOverlay(rec);
    this.emitState();
  }

  /** 当前页（可见区域中心）在页面坐标里的点，用来决定新图片落点 */
  private pageViewportCenter(rec: PageRec): [number, number] {
    const W = this.store.data.width;
    const H = this.store.data.height;
    try {
      const r = rec.pageEl.getBoundingClientRect();
      const sr = this.scrollEl?.getBoundingClientRect?.();
      if (r.width > 0 && r.height > 0 && sr && sr.width > 0) {
        const kx = W / r.width;
        const ky = H / r.height;
        const cx = (sr.left + sr.width / 2 - r.left) * kx;
        const cy = (sr.top + sr.height / 2 - r.top) * ky;
        if (Number.isFinite(cx) && Number.isFinite(cy)) {
          return [clamp(cx, 0, W), clamp(cy, 0, H)];
        }
      }
    } catch (_) {
      /* 布局拿不到就退回纸中心 */
    }
    return [W / 2, H / 2];
  }

  /**
   * 在当前页插入一张图片（对外入口：view 选好文件、量好尺寸后调用）。
   *
   * 落点默认在可见区域中心，按原始比例缩到页面的一小块里（见 fitImageRect）。
   * 插入后立即选中它，用户切到「选择」工具就能直接拖动 / 缩放 / 删除。
   * 走与文字/形状相同的 store.snapshotPage + touch：一次插入 = 一条撤销。
   *
   * `source` 非空时表示这是一块「文件块」（Excalidraw / 笔记 / 文本的快照），
   * 选中后属性条会多出「打开源文件 / 刷新快照」。
   */
  insertImage(
    src: string,
    naturalWidth: number,
    naturalHeight: number,
    source?: PageFileSource
  ): PageImage | null {
    if (this.readOnly) return null;
    const index = this.current;
    const rec = this.recs[index];
    const page = this.store.data.pages[index];
    if (!rec || !page || !src) return null;
    const W = this.store.data.width;
    const H = this.store.data.height;
    const [cx, cy] = this.pageViewportCenter(rec);
    const rect = fitImageRect(naturalWidth, naturalHeight, W, H, cx, cy);
    const img: PageImage = {
      id: uid(),
      src,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
    if (source) img.source = { ...source };
    this.store.snapshotPage(index);
    if (!page.images) page.images = [];
    page.images.push(img);
    this.store.touch();
    this.changed();
    this.renderRec(rec);
    // 触发异步加载；加载完 loadBackground 的 onload 会重画这一页
    this.loadBackground(src);
    this.selectImage(img.id);
    this.emitState();
    return img;
  }

  /**
   * 用一张新快照替换指定文件块的图片与尺寸（刷新用，一条撤销）。
   *
   * 源文件改了之后由 view 重新生成快照再调这里：替换 src / 宽高、更新
   * `source.mtime`，让「源已更新」提示消失。旧快照从 bgImages 缓存里删掉避免残留。
   */
  updateFileBlockSnapshot(
    id: string,
    snap: { src: string; width: number; height: number; mtime?: number }
  ): void {
    if (this.readOnly) return;
    const index = this.current;
    const rec = this.recs[index];
    const page = this.store.data.pages[index];
    const img = page?.images?.find((im) => im.id === id);
    if (!rec || !page || !img || !snap?.src) return;
    const oldSrc = img.src;
    this.store.snapshotPage(index);
    img.src = snap.src;
    if (snap.width > 0) img.width = snap.width;
    if (snap.height > 0) img.height = snap.height;
    if (img.source && Number.isFinite(Number(snap.mtime))) {
      img.source = { ...img.source, mtime: Number(snap.mtime) };
    }
    this.store.touch();
    this.changed();
    if (oldSrc && oldSrc !== snap.src) this.bgImages.delete(oldSrc);
    this.invalidateRaster(page.id);
    this.loadBackground(snap.src);
    this.renderRec(rec);
    this.syncImageBar();
    this.emitState();
  }

  /**
   * 选中图片 / 文件块后浮在它上方的属性条。
   *
   * 普通图片：尺寸 + 删除。
   * 文件块（有 `source`）：额外给「打开源文件」「刷新」「源已更新」提示。
   */
  private syncImageBar(): void {
    this.imageBarEl?.remove();
    this.imageBarEl = null;
    const sel = this.selectedImage;
    const rec = this.recs[this.current];
    if (!sel || !rec || !rec.mounted || this.readOnly) return;

    const bar = document.createElement("div");
    bar.className = "mb-textbar mb-imagebar";
    const eat = (e: Event) => e.stopPropagation();
    for (const evName of ["pointerdown", "mousedown", "touchstart"]) {
      bar.addEventListener(evName, eat, { passive: true });
    }

    const lbl = document.createElement("span");
    lbl.className = "mb-tb-width mb-tb-imgsize";
    lbl.title = sel.source ? "文件块大小（拖动四角手柄按比例缩放）" : "图片大小（拖动四角手柄按比例缩放）";
    lbl.textContent = `${Math.round(sel.width)} × ${Math.round(sel.height)}`;
    bar.appendChild(lbl);
    bar.appendChild(this.textBarSep());

    if (sel.source) {
      const src = sel.source;
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "mb-tb-btn mb-fileblock-open";
      openBtn.textContent = "打开源文件";
      openBtn.title = `打开源文件：${src.path}`;
      openBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.opts.onOpenFileSource?.(src.path);
      });
      bar.appendChild(openBtn);

      const refreshBtn = document.createElement("button");
      refreshBtn.type = "button";
      refreshBtn.className = "mb-tb-btn mb-fileblock-refresh";
      refreshBtn.textContent = "刷新";
      refreshBtn.title = "源文件改了？点这里重新生成快照";
      refreshBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.opts.onRefreshFileBlock?.(sel);
      });
      bar.appendChild(refreshBtn);

      if (this.fileSourceStale(sel)) {
        const hint = document.createElement("span");
        hint.className = "mb-tb-stale";
        hint.textContent = "源已更新";
        hint.title = "源文件已改动，点「刷新」重新生成快照";
        bar.appendChild(hint);
      }
      bar.appendChild(this.textBarSep());
    }

    const del = document.createElement("button");
    del.type = "button";
    del.className = "mb-tb-btn is-danger";
    del.textContent = "删除";
    del.title = sel.source ? "删掉这个文件块（可撤销）" : "删掉这张图片（可撤销）";
    del.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.deleteSelectedImage();
    });
    bar.appendChild(del);

    rec.pageEl.appendChild(bar);
    this.imageBarEl = bar;
    this.positionImageBar();
  }

  /** 文件块的源文件 mtime 是否和快照记录的不一致（= 源已更新） */
  private fileSourceStale(im: PageImage): boolean {
    const src = im.source;
    if (!src || src.mtime == null) return false;
    const app: any = this.opts.app;
    try {
      const f = app?.vault?.getAbstractFileByPath?.(src.path);
      const m = Number(f?.stat?.mtime);
      return Number.isFinite(m) && m !== Number(src.mtime);
    } catch (_) {
      return false;
    }
  }

  /** 属性条跟着图片走：优先放在图片上方，顶到页眉就翻到下方 */
  private positionImageBar(): void {
    const bar = this.imageBarEl;
    const sel = this.selectedImage;
    if (!bar || !sel) return;
    const z = this.zoom;
    const pageW = this.store.data.width * z;
    const w = bar.offsetWidth || 160;
    const h = bar.offsetHeight || 32;
    const left = Math.max(4, Math.min(sel.x * z, pageW - w - 4));
    const above = sel.y * z - h - 8;
    const below = (sel.y + sel.height) * z + 8;
    const top = above >= 4 ? above : below;
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
  }

  /**
   * 把一页里的插入图片画进 ctx（屏幕、缩略图、导出、嵌入共用）。
   *
   * 层序：纸面 → 底图 → **图片** → 笔迹。图片压在笔迹下面，这样在图片上
   * 写字的笔迹永远盖在图上（批注照片的直觉）；文字（DOM 层）本来就在最上面。
   * 图片是异步加载的：没加载完先画一层淡灰占位（避免整块消失让人以为图没了），
   * 同时触发加载，加载完由 loadBackground 回调重画。
   */
  private drawInsertedImages(ctx: CanvasRenderingContext2D, page: Page): void {
    const imgs = page.images;
    if (!imgs?.length) return;
    for (const im of imgs) {
      if (!(im.width > 0) || !(im.height > 0)) continue;
      const img = this.bgImages.get(im.src);
      if (!img) this.loadBackground(im.src);
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, im.x, im.y, im.width, im.height);
        ctx.restore();
      } else {
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,0.05)";
        ctx.fillRect(im.x, im.y, im.width, im.height);
        ctx.restore();
      }
    }
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
    // 编辑框开着时点它不能把框提交掉（与侧栏样式控件同一套标记）
    dec.dataset.mbTextStyle = "1";
    inc.dataset.mbTextStyle = "1";
    bar.append(dec, sizeLbl, inc);
    bar.appendChild(this.textBarSep());

    // 宽度只读显示：拖手柄时给个精确反馈，但不开放输入——
    // 输入框和拖动是两套状态，同步起来只会出「改了没反应」的怪事
    const widthLbl = document.createElement("span");
    widthLbl.className = "mb-tb-width";
    widthLbl.title = "一行能放多少字：拖动选中框右下角的手柄调整";
    widthLbl.textContent = `宽 ${Math.round(this.textLayout(sel).width)}`;
    bar.appendChild(widthLbl);
    bar.appendChild(this.textBarSep());

    // 字体
    const fontSel = document.createElement("select");
    fontSel.className = "mb-tb-font dropdown";
    fontSel.title = "字体";
    fontSel.dataset.mbTextStyle = "1";
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
      dot.dataset.mbTextStyle = "1";
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

  /* --------------------- 新建输入框上方的就近样式条 --------------------- */

  /**
   * 为空输入框建一条字号 / 颜色样式条，挂在页面坐标容器上。
   *
   * 只在 `beginTextEdit` 的**新键**分支调用；改已有文字时用的是选中属性条
   * （syncTextBar），两条不能同时出现。
   */
  private syncTextEditBar(): void {
    this.textEditBarEl?.remove();
    this.textEditBarEl = null;
    /*
     * 旧样式条上的步进按钮要停手：DOM 马上被移除，按住中的 pointerup
     * 再也等不到，timer 会一路跑到底。重建前先把旧的全部停掉。
     */
    for (const stop of this.stepBtnStoppers) stop();
    this.stepBtnStoppers = [];
    const ed = this.textEdit;
    // 只给"新建"用：改已有文字的框自带 .mb-textbar，不重复
    if (!ed || ed.id || !ed.rec.mounted) return;

    const bar = document.createElement("div");
    // 复用属性条的基础外观，再加扁平单行的尺寸修饰类（见 .mb-texteditbar）
    bar.className = "mb-textbar mb-texteditbar";
    // 手势一律不传到画布，否则点一下字号会顺手画一笔
    const eat = (e: Event) => e.stopPropagation();
    for (const evName of ["pointerdown", "mousedown", "touchstart"]) {
      bar.addEventListener(evName, eat, { passive: true });
    }

    // 自定义字号：紧凑输入框（≤44px，见 .mb-texteditbar .mb-tb-sizein），
    // 放在四档前面。数字直打 → setTextSize（内部 clamp 8~96）→
    // applyTextEditStyle 实时预览（不重建 DOM，打字不断）。
    const sizeIn = document.createElement("input");
    sizeIn.type = "text";
    sizeIn.className = "mb-tb-sizein";
    sizeIn.inputMode = "numeric";
    sizeIn.value = String(Math.round(ed.size));
    sizeIn.title = "自定义字号（8~96）：直接输入数字";
    // 没有这个标记，pointerdown 后 blur 会把空框提交掉（"先选样式再打字"直接断）
    sizeIn.dataset.mbTextStyle = "1";
    const applySize = () => {
      const n = parseInt(sizeIn.value.replace(/\D/g, ""), 10);
      if (Number.isNaN(n)) return;
      // setTextSize → applyTextEditStyle：实时预览 + 高亮同步
      this.setTextSize(n);
    };
    sizeIn.addEventListener("input", applySize);
    sizeIn.addEventListener("change", () => {
      // 离开输入框：不重复 setTextSize（会把焦点从用户要去的元素上抢走，
      // 框里没提交的内容正需要焦点留在外面）；输入时已逐键应用，
      // 这里只把显示值整理成 clamp 后的实际值（updateTextEditBar
      // 也会兜一次，但输入框失焦后才会写回，change 时主动补一次）
      const t = this.textEdit;
      if (t) sizeIn.value = String(Math.round(t.size));
    });
    sizeIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        applySize();
        sizeIn.blur();
      }
    });
    bar.appendChild(sizeIn);

    // −/＋ 字号步进：点一下走一档，按住连调（见 bindHoldStepBtn），
    // 与四档数字按钮并存——直接输入框旁边既给精确改值（4 档）也给
    // 微调步进（±1）。clamp 8~96 由 setTextSize 统一兜底。
    for (const d of [-1, 1] as const) {
      const step = document.createElement("button");
      step.type = "button";
      step.className = "mb-tb-sizestep" + (d < 0 ? " mb-tb-sizestep-sub" : " mb-tb-sizestep-add");
      step.textContent = d < 0 ? "−" : "＋";
      step.title = d < 0 ? "字号 −1（按住连减）" : "字号 +1（按住连加）";
      // 编辑框开着时点它不能把框提交掉（blur 判定靠这个标记）
      step.dataset.mbTextStyle = "1";
      // 收集停手句柄：编辑器销毁时要能把按住中的 timer 停掉
      this.stepBtnStoppers.push(
        bindHoldStepBtn(step, () => {
          // setTextSize → applyTextEditStyle：实时预览 + 高亮同步
          this.stepTextSize(d);
          // updateTextEditBar 不敢覆盖正在输入的框；既然按了步进按钮，
          // 说明这一格的输入已结束，主动把显示值同步成新值
          const bi = bar.querySelector<HTMLInputElement>(".mb-tb-sizein");
          if (bi) bi.value = String(this.textSize);
        })
      );
      bar.appendChild(step);
    }

    // 字号：4 档常用大小，当前值高亮。数字按钮比 −/＋ 少一半点击次数
    for (const v of [14, 18, 24, 32]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mb-tb-btn" + (Math.round(ed.size) === v ? " is-active" : "");
      b.textContent = String(v);
      b.title = `字号 ${v}`;
      b.dataset.mbSize = String(v);
      // 没有这个标记，pointerdown 后 blur 会把空框提交掉（"先选样式再打字"直接断）
      b.dataset.mbTextStyle = "1";
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // setTextSize → applyTextEditStyle：实时改预览并 focus 回 textarea
        this.setTextSize(v);
      });
      bar.appendChild(b);
    }

    bar.appendChild(this.textBarSep());

    // 颜色：与属性条同一组 6 个色点
    for (const c of PEN_COLORS.slice(0, 6)) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className =
        "mb-tb-dot" + ((ed.color || "").toLowerCase() === c.toLowerCase() ? " is-active" : "");
      dot.style.background = c;
      dot.title = "文字颜色";
      dot.dataset.mbColor = c;
      dot.dataset.mbTextStyle = "1";
      dot.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setTextColor(c);
      });
      bar.appendChild(dot);
    }

    ed.rec.pageEl.appendChild(bar);
    this.textEditBarEl = bar;
    this.positionTextEditBar();
  }

  /** 缩放后把正在输入的 textarea 的像素样式重算一遍（编辑期间捏合要用） */
  private applyTextEditZoom(): void {
    const ed = this.textEdit;
    if (!ed) return;
    const ta = ed.el;
    const z = this.zoom;
    ta.style.fontSize = `${ed.size * z}px`;
    ta.style.left = `${ed.x * z}px`;
    ta.style.top = `${(ed.y - ed.size * 0.82) * z}px`;
    // 新建框的折行宽可用纸宽决定；改已有文字时要尊重它手动拖过的框宽
    const hit = ed.id
      ? this.hitText(this.store.data.pages[ed.rec.index]?.texts ?? [], ed.x, ed.y)
      : null;
    const layout = this.textLayout({
      x: ed.x,
      y: ed.y,
      size: ed.size,
      text: ta.value,
      font: ed.font,
      width: hit?.width,
    });
    ta.style.width = `${layout.width * z + TEXT_EDIT_CHROME}px`;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
    this.updateTextEditBar();
    // 缩放时输入框尺寸 / 位置都变了，候选列表要重新贴过去
    if (this.linkSuggestEl) this.positionLinkSuggest();
  }

  /** 样式值变了以后同步高亮与位置（不重建 DOM，避免点按钮时把它自己换掉） */
  private updateTextEditBar(): void {
    const bar = this.textEditBarEl;
    const ed = this.textEdit;
    if (!bar || !ed) return;
    // 自定义入口：用户正在输入框里打字时不写回（会把正在输入的内容冲掉）；
    // 失焦 / 其它样式变更时把显示值与强调态同步成实际值。
    const sizeIn = bar.querySelector<HTMLInputElement>(".mb-tb-sizein");
    if (sizeIn) {
      if (document.activeElement !== sizeIn) {
        sizeIn.value = String(Math.round(ed.size));
      }
      sizeIn.classList.toggle("is-custom", ![14, 18, 24, 32].includes(Math.round(ed.size)));
    }
    for (const b of Array.from(bar.querySelectorAll<HTMLElement>(".mb-tb-btn[data-mb-size]"))) {
      b.classList.toggle("is-active", Number(b.dataset.mbSize) === Math.round(ed.size));
    }
    for (const d of Array.from(bar.querySelectorAll<HTMLElement>(".mb-tb-dot[data-mb-color]"))) {
      d.classList.toggle(
        "is-active",
        (d.dataset.mbColor || "").toLowerCase() === (ed.color || "").toLowerCase()
      );
    }
    this.positionTextEditBar();
  }

  /**
   * 样式条跟着输入框走：默认在框顶上方 8px。
   *
   * 像素换算与 beginTextEdit 写 textarea 的 top 完全一致（页面坐标 × zoom），
   * 缩放时由 applyLayout 重算。框贴着页顶导致上方放不下时翻到框下方——
   * 宁可换边，也不能让样式条半截悬在纸外。
   *
   * 样式条是**单行不折行**的（见 styles.css .mb-texteditbar）。纸窄到
   * 放不下整条时（侧栏 fit 到 0.3 倍，纸只有 ~238px），这里把整条等比
   * 缩小到纸宽以内：.mb-page 是 overflow:hidden，超出纸缘的内容会被
   * 直接裁掉（用户看到的「被挤到一边 / 字号按钮点不到」就是它）。
   * 纸足够宽时 fit=1，控件保持设计尺寸。
   */
  private positionTextEditBar(): void {
    const bar = this.textEditBarEl;
    const ed = this.textEdit;
    if (!bar || !ed) return;
    const z = this.zoom;
    const pageW = this.store.data.width * z;
    const pageH = this.store.data.height * z;
    const w = bar.offsetWidth || 277;
    const h = bar.offsetHeight || 32;
    // 左右各留 4px，超出纸面就按比例缩（transform 不影响 offsetWidth）
    const fit = pageW > 8 ? Math.min(1, (pageW - 8) / Math.max(1, w)) : 1;
    const shownW = w * fit;
    const shownH = h * fit;
    bar.style.transform = fit < 1 ? `scale(${fit})` : "";
    const taTop = (ed.y - ed.size * 0.82) * z;
    const taLeft = ed.x * z;
    const left = Math.max(4, Math.min(taLeft, pageW - shownW - 4));
    const above = taTop - shownH - 8;
    const below = taTop + (ed.el.offsetHeight || 0) + 8;
    const top = above >= 4 ? above : Math.max(4, Math.min(below, pageH - shownH - 4));
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

  setBallpointSize(size: number, silent = false): void {
    this.ballpointSize = size;
    if (!silent) this.emitState();
  }

  /** 设定某一类形状自己的线宽（不影响别的形状，也不影响笔） */
  setShapeSize(kind: ShapeKind, size: number, silent = false): void {
    this.shapeSizes[kind] = size;
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
    // 页 id 才是身份：重排后下标全变，测试/排查靠它确认 DOM 顺序与数据一致
    wrap.dataset.pageId = page.id;
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
      if (rec) {
        this.onDown(e as PointerEvent, rec);
        return;
      }
      /*
       * 落在纸面之外（缩小后的空白区 / 页缝）的指针，也要**喂给仲裁器**
       * （INK-191）。
       *
       * 老代码 `if (rec) onDown(...)` 直接把这类事件丢掉，于是：
       * 两指从空白处捏合时，第二根手指仲裁器根本没看见（它只知道
       * 第一根），第一根照旧当 pan 滚页 —— 用户想缩小，页面反而滚走。
       * 甩动过程中按在空白处也停不住惯性。
       *
       * 这里只做「记账」：让 arbiter 知道有几根手指、是不是双指。
       * 真正的手势处理仍在 onMove 里按 rec 走（纸外没有页面可以落笔）。
       */
      const role = this.arbiter.down(this.pointerInfo(e as PointerEvent));
      if (role === "gesture") {
        e.preventDefault();
        return;
      }
      /*
       * 纸外单指 / 鼠标拖动 = 平移画面（INK-215）。
       *
       * 写入模式下 `touch-action: none` 把浏览器原生滚动关了（见
       * applyTouchAction），滚动全靠我们自己的 pan。而纸外按下原先只
       * 「记账」不设 pan —— 缩到 0.3 以后大片都是空白，用户从空白处
       * 往下拖，页面纹丝不动，只能精确地把手指按到那三百多像素高的
       * 纸上才能滚。这是老缺口，不是 INK-211 引入的，但同属「缩小后
       * 操作失灵」，一起补掉。
       *
       * 纸外没有页面，所以不需要区分工具：一律平移。笔不参与（笔的
       * 职责是写字，纸外没有纸可写，落笔即无效）。
       */
      const wantsPan =
        e.pointerType === "mouse"
          ? e.button === 0 || e.button === 1 || e.button === 2
          : e.pointerType === "touch" && role === "pan";
      if (!wantsPan) return;
      // 纸外点一下也要能收起文字输入框（和 onDown 里纸上点空白处一致）
      if (this.textEdit && this.tool === "text") this.commitTextEdit(true);
      this.stopFling();
      this.velSamples = [];
      this.gesture = "pan";
      this.pointerId = e.pointerId;
      this.pan = {
        x: e.clientX,
        y: e.clientY,
        left: this.scrollEl.scrollLeft,
        top: this.scrollEl.scrollTop,
      };
      e.preventDefault();
    });
    this.docEl.addEventListener("pointermove", (e) => {
      const rec = findRec(e.target);
      if (rec) this.onMove(e as PointerEvent, rec);
      /*
       * 纸外（缩小后的空白区 / 页缝）的移动也必须喂给仲裁器（INK-211）。
       *
       * 老代码这里只有 onLeave。于是：缩到 0.3 后 Word 页只剩三百多像素高，
       * 手指多半落在纸外空白里 —— 双指手势虽然已经由纸外的 pointerdown
       * 起了头（INK-191 修过），但后续 move 全被丢掉，`applyPinch` 一次都
       * 不执行，两指距离永远停在开始值。用户看到的就是「缩到最小以后
       * 再怎么张手指都放不大」。
       *
       * 这里只把事件送进仲裁器（它会算距离并回调 applyPinch），
       * 不落笔；纸外依然没有页面可以承载落笔。
       */
      else {
        const role = this.arbiter.move(this.pointerInfo(e as PointerEvent));
        if (role === "gesture") {
          e.preventDefault();
          return;
        }
        /*
         * 纸外起步的平移（INK-215）：和 onMove 的 pan 分支同一套算法，
         * 1:1 跟手 + 采样速度，抬手时由 globalUp 起算惯性。
         */
        if (this.gesture === "pan" && this.pan && e.pointerId === this.pointerId) {
          this.markFastScroll();
          const nextLeft = this.pan.left - (e.clientX - this.pan.x);
          const nextTop = this.pan.top - (e.clientY - this.pan.y);
          this.scrollEl.scrollLeft = nextLeft;
          this.scrollEl.scrollTop = nextTop;
          // 速度采样读真实 scrollTop（夹到边界后的值），理由见 onMove pan 分支
          this.pushVelSample(
            this.scrollEl.scrollTop,
            e.timeStamp || performance.now()
          );
          e.preventDefault();
          return;
        }
        /*
         * 页与页之间有空隙（gap / 添加页按钮），那些地方没有 .mb-page：
         * 鼠标从一页滑到另一页会经过空隙，onMove 收不到，上一页的圈
         * 就会一直挂着。经过空隙时按"离开纸面"处理，收掉圈。
         */
        this.onLeave(e as PointerEvent);
      }
    });
    /*
     * 纸外的抬起同样要送进仲裁器（INK-211）。
     *
     * 不送的话 `touchCount` 永远不减、`gesturing` 永远为真：
     * 手势进入一个退不出去的死状态，之后所有触摸移动都被当成手势吞掉，
     * 缩放和滚动一起失灵，只能等下一次落笔才自愈。
     *
     * 纸外平移（INK-215）通常已经被 window 捕获阶段的 globalUp 收尾
     * （它会按 pointerId 调 onUp，起算惯性）。这里只兜 globalUp 够不着
     * 的情况：`recs[current]` 不存在时 globalUp 会直接 return，手势就
     * 永远停在 "pan"。用 `gesture === "pan"` 判重，globalUp 收过就不会
     * 二次起算惯性。
     */
    const endOutsidePan = (e: PointerEvent) => {
      if (this.gesture !== "pan" || this.pointerId !== e.pointerId) return;
      const s = this.velSamples;
      if (s.length) {
        this.startFling(
          s[s.length - 1].y,
          e.timeStamp || performance.now(),
          e.pointerType
        );
      }
      this.velSamples = [];
      this.gesture = "none";
      this.pointerId = null;
      this.pan = null;
    };
    this.docEl.addEventListener("pointerup", (e) => {
      const rec = findRec(e.target);
      if (rec) this.onUp(e as PointerEvent, rec);
      else {
        this.arbiter.up(this.pointerInfo(e as PointerEvent));
        endOutsidePan(e as PointerEvent);
      }
    });
    this.docEl.addEventListener("pointercancel", (e) => {
      const rec = findRec(e.target);
      if (rec) this.onUp(e as PointerEvent, rec);
      else {
        this.arbiter.up(this.pointerInfo(e as PointerEvent));
        endOutsidePan(e as PointerEvent);
      }
    });
    /*
     * pointerleave 挂在 docEl 上：冒泡到这里的事件 target 就是 docEl 本身，
     * findRec 沿 target 往上找 .mb-page 永远返回 null → onLeave 从来没跑过，
     * 鼠标移出纸面后圈会一直挂在最后的位置（幽灵圈）。
     * 所以这里不查 target，直接收掉圈并重画所有已挂载页的 overlay。
     */
    this.docEl.addEventListener("pointerleave", (e) => {
      this.onLeave(e as PointerEvent);
    });
    this.docEl.addEventListener("contextmenu", (e) => {
      /*
       * **拦掉纸面上的系统菜单**（2026-11-07）。
       *
       * 老条件是 `tool !== "hand"` —— 抓手工具下放行菜单。但现在右键
       * 也是平移手势，鼠标用户按住右键拖动时若弹菜单，拖动直接中断。
       * 纸面上没有需要浏览器原生菜单的东西（文字编辑有自己的属性条）。
       *
       * 但**输入框例外**（2026-11-08，平板专项）：文字编辑的 textarea
       * 就挂在 pageEl 里，事件会冒泡到这里。无条件 preventDefault 会把
       * 输入框里长按的「粘贴 / 全选 / 复制」菜单也吞掉 —— 平板上没有
       * 别的办法把文字粘进去，等于输入功能残废。
       */
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) {
        return;
      }
      e.preventDefault();
    });
  }

  renderPages(): void {
    // 编辑框挂在页面 DOM 上，重建前先落盘，否则输入的内容跟着 DOM 一起消失
    this.commitTextEdit();
    // 页面 DOM 马上全部重建，旧的落点提示引用要一起清掉（含定时器）
    this.clearLocateHint();
    // 页面全部重建，旧的锚点索引失效
    this.lockedAnchor = null;
    /*
     * 页 DOM 马上整批重建：正在擦的手势必须先把撤销记录结算掉。
     * 以前这里直接把 gesture 抹成 "none"，finishEraseGesture 永远不跑，
     * 擦掉的笔迹留在数据里却进不了撤销栈（Ctrl+Z 撤不回来）。
     * 只处理 erase——正在画的草稿照旧丢弃，不改变落笔的既有语义。
     */
    if (this.gesture === "erase") {
      this.finishEraseGesture(this.recs[this.current] ?? null);
      if (this.opts.onInkGestureEnd) this.opts.onInkGestureEnd();
    }
    this.draft = null;
    this.draftRec = null;
    this.gesture = "none";
    this.pointerId = null;
    this.eraserPos = null;
    // 页面整批重建：光迹坐标属于旧 rec，一起作废
    this.laserTrail = [];
    this.stopLaserFade();
    this.hoverPos = null;
    this.moveText = null;
    this.resizeText = null;
    this.arbiter.reset();
    // 页对象整批重建（手势中切页 / 新建页）：旧 rec 已失效；
    // 新页 mount 时会按当前 zoom 自己 resizeRec，不会残留糊图。
    // 页码冻结 / 定时器也一并收掉，否则手势的残留状态会压住新页。
    this.pinch = null;
    this.clearPendingPinch();
    this.pinchNeedsRedraw = false;
    this.pinchActive = false;
    window.clearTimeout(this.pinchReleaseTimer);
    this.pinchReleaseTimer = 0;
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    // 页对象重建了，旧的 ioVisible 状态随 rec 一起作废
    this.recs = [];
    this.docEl.innerHTML = "";
    // 页对象整批换新：旧脱离 DOM 的文字层不再有复用价值。
    this.textLayerCache.clear();
    this.deferredTextLayers.clear();
    // 页对象整批换新 / 页 id 可能复用：脱离 DOM 的主画布一律作废（INK-229）
    this.invalidateRasterCache();
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
    // 记下这次渲染对应的页顺序版本（undo/redo 靠它判断要不要重建）
    this.pageOrderRev = this.store.pageOrderRev;
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
  applyLayout(fast = false): void {
    /*
     * 正在输入文字时**冻结 fit 比例**（2026-11-08，平板专项）。
     *
     * 平板软键盘弹出会把 scrollEl 高度压掉约 300px（宿主 adjustResize），
     * ResizeObserver 随即触发 applyLayout。fit 模式下 availH 变小 →
     * zoom 变小 → **整页跟着缩小**，用户正在打字的那一页突然跳一下；
     * 而 textarea 的 inline left/top/fontSize 是按旧 zoom 写的，
     * 页面缩了它不缩，输入框和纸面错位。
     *
     * 键盘收起时会再次 resize，那时 zoom 会正常重算，所以冻结只是
     * 「输入期间不重排」，不会留下错误的缩放。
     *
     * fast（捏合手势专用）：这一帧的 zoom 已经由 applyPinch 定好，
     * 不再按视口重算 fit 比例，也跳过下面的 resizeRec 循环。
     * `.mb-canvas/.mb-overlay` 的显示尺寸是 100%（跟 backing 解耦），
     * 只改 --mb-page-w/h 浏览器就会缩放已有位图，视觉跟手且无需重绘。
     */
    if (this.fitMode && !this.textEdit && !fast) {
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
    this.positionImageBar();
    // 新建输入框上方的样式条同理（页面坐标 × zoom）
    this.positionTextEditBar();
    /*
     * 正在输入的 textarea 的 inline left/top/fontSize/width 是按像素写死的
     * （不是 CSS 变量），纸面被 CSS 拉伸时它不会跟着变——手势期间也要重排，
     * 否则输入框和纸面错位。只在 textEdit 存在时才有这点开销。
     */
    if (this.textEdit) this.applyTextEditZoom();
    /*
     * 只重建已挂载页的 canvas（数量很少，通常 1-3 个）。
     * 但捏合手势期间**必须跳过**：写 canvas.width/height 会让浏览器重新
     * 分配整块 backing 内存并清空，随后 renderRec + renderOverlay 全量重绘
     * 该页所有笔迹。60fps 下每帧都做这件事，页数多 / 笔迹多时必然卡。
     */
    if (!fast) {
      for (const rec of this.recs) {
        if (rec.mounted) this.resizeRec(rec);
      }
    }
    /*
     * 尺寸就绪后补落待恢复的滚动位置。
     *
     * 编辑器可能在隐藏的标签页 / 折叠面板里创建，那一刻 clientHeight=0，
     * restoreViewState 的 rAF 落不下去（见 applyPendingScroll）。
     * 等第一次真实的 applyLayout（容器可见后由 ResizeObserver 触发）
     * 再补一次，用户看到的才是上次的位置。横向同理：只有水平 pending
     * 时也要补落，否则「纵向在页首、横向在右半边」的读者永远回左边。
     */
    if (
      (this.pendingScrollTop != null || this.pendingScrollLeft != null) &&
      this.scrollEl.clientHeight > 0
    ) {
      requestAnimationFrame(() => this.applyPendingScroll());
    }
    this.emitState();
  }

  /*
   * 缩放后页码滞旧（INK-107）：页高变了，但 current 只有 scroll 事件才重算，
   * 于是页码要等用户再滚一下才跟上。缩放结束后按新 zoom 现算一次（纯算术、
   * 不触发重排）。**只放在真正的缩放入口**：applyLayout 还被 renderPages /
   * mount / resize 调用，在那儿刷 current 会把测试预设的当前页拉走，
   * 选中文字、编辑框、拖动全跟着失效。
   */
  private refreshCurrentAfterZoom(): void {
    this.updateCurrentFromScroll(true);
    this.emitState();
  }

  setZoom(z: number): void {
    this.fitMode = false;
    this.zoom = clamp(z, MIN_ZOOM, MAX_ZOOM);
    this.applyLayout();
    this.refreshCurrentAfterZoom();
  }

  zoomBy(factor: number): void {
    this.setZoom(this.zoom * factor);
  }

  fit(): void {
    this.fitMode = true;
    this.applyLayout();
    this.refreshCurrentAfterZoom();
  }

  /**
   * 恢复上次保存的视图状态（缩放 + 页内滚动位置）。
   *
   * 为什么不能由调用方直接写 `zoom` / `scrollEl.scrollTop`：
   *   1. 构造函数末尾排了一帧 rAF（applyLayout → measurePageMetrics →
   *      goToPage(activePage)），那次 goToPage 会把滚动位置拉到页顶；
   *      构造后直接写 scrollTop 会被它盖掉。
   *   2. fit 的 zoom 要等容器有尺寸后才算得准，早写没有意义。
   *
   * 所以 zoom 立即落（并关掉 fitMode，让构造函数那一帧按它排版；
   * 字段存在 = 用户显式缩放过，见 types.ts），纵向 / 横向滚动位置
   * 挂成 pending，由构造后的下一帧统一落。
   */
  restoreViewState(view: { zoom?: number; scrollTop?: number; scrollLeft?: number }): void {
    if (typeof view.zoom === "number" && Number.isFinite(view.zoom)) {
      this.fitMode = false;
      this.zoom = clamp(view.zoom, MIN_ZOOM, MAX_ZOOM);
    }
    if (
      typeof view.scrollTop === "number" &&
      Number.isFinite(view.scrollTop) &&
      view.scrollTop > 0
    ) {
      this.pendingScrollTop = view.scrollTop;
    }
    // 水平只在大缩放、纸比容器宽时才不为 0；0 是默认（纸居中），不必恢复
    if (
      typeof view.scrollLeft === "number" &&
      Number.isFinite(view.scrollLeft) &&
      view.scrollLeft > 0
    ) {
      this.pendingScrollLeft = view.scrollLeft;
    }
    if (this.pendingScrollTop != null || this.pendingScrollLeft != null) {
      requestAnimationFrame(() => this.applyPendingScroll());
    }
  }

  /**
   * 把 pending 的纵向 / 横向滚动位置真正落到滚动容器上。
   *
   * 必须晚于构造函数的 rAF（它里面 goToPage 会滚到 activePage），
   * 否则恢复值会被覆盖。落之前重新量一次页高 / 首页偏移：fit 模式下
   * zoom 刚在上一帧算出来，滚动高度可能和构造时不同。
   *
   * 纵向和横向分别判就绪、分别落：可能只有其一在 pending（纵向在页首
   * 但横向在右半边），不能因为另一个是 null 就跳过。
   */
  private applyPendingScroll(): void {
    if (this.destroyed) return;
    const topTarget = this.pendingScrollTop;
    const leftTarget = this.pendingScrollLeft;
    if (topTarget == null && leftTarget == null) return;
    /*
     * 容器还没完成布局（clientHeight / scrollHeight 为 0）时**保留**
     * pending，绝不把恢复值落成 0——那等于用户又回到页首，而且下次
     * 关闭还会把 0 写回文件（被隐藏标签页打开的场景）。
     * 水平同理：scrollWidth 还没量出来时 max 会被算成 0，恢复值就被
     * 覆盖成「贴左边」，所以横向 pending 也要求 clientWidth 就绪。
     * 先自己重试 3 帧；仍没尺寸就等 applyLayout 末尾那一次补落
     * （容器可见 / ResizeObserver 触发时）。
     * 不能用「max<=0」判断：内容本来就装得下时 max 也是 0，
     * 那属于合法地只能停在页首 / 页左边，不该重试。
     */
    const verticalReady =
      this.scrollEl.clientHeight > 0 && this.scrollEl.scrollHeight > 0;
    const horizontalReady =
      leftTarget == null ||
      (this.scrollEl.clientWidth > 0 && this.scrollEl.scrollWidth > 0);
    if (!verticalReady || !horizontalReady) {
      if (this.restoreScrollRetry < 3) {
        this.restoreScrollRetry += 1;
        requestAnimationFrame(() => this.applyPendingScroll());
      }
      return;
    }
    this.restoreScrollRetry = 0;
    this.pendingScrollTop = null;
    this.pendingScrollLeft = null;
    this.measurePageMetrics();
    if (topTarget != null) {
      const maxTop = Math.max(0, this.scrollEl.scrollHeight - this.scrollEl.clientHeight);
      this.scrollEl.scrollTop = Math.min(topTarget, maxTop);
    }
    if (leftTarget != null) {
      // 缩放变了可滚动宽度也跟着变，夹到当前真正能滚到的最右位置
      const maxLeft = Math.max(0, this.scrollEl.scrollWidth - this.scrollEl.clientWidth);
      this.scrollEl.scrollLeft = Math.min(leftTarget, maxLeft);
    }
    // 位置可能落在另一页上（窗口尺寸 / fit 比例变了）：页码立刻跟上，
    // 别等异步 scroll 事件——返回后马上读 getState() 的调用方会拿到旧页码
    this.updateCurrentFromScroll(true);
    this.emitState();
  }

  /** applyPendingScroll 的重试计数（见该方法的说明） */
  private restoreScrollRetry = 0;

  /**
   * 当前应落盘的滚动位置。
   *
   * 恢复值还没落下（容器尺寸没就绪）时返回 pending：否则在隐藏的
   * 后台标签页里关闭文件，会把「上次保存的位置」当成 0 覆盖掉——
   * 下次打开就真的回页首了，而且用户完全不知道是这次关闭弄丢的。
   */
  getScrollTop(): number {
    return this.pendingScrollTop ?? this.scrollEl.scrollTop;
  }

  /**
   * 当前应落盘的**水平**滚动位置，语义与 getScrollTop 完全对称。
   *
   * 为什么需要 pending：和纵向一样，在隐藏标签页里关闭文件时容器
   * 还没恢复布局，直接读 scrollEl.scrollLeft 会得到 0，把上次的
   * 水平位置抹掉。放大后向右看的那半边内容就这么丢了（INK-209）。
   */
  getScrollLeft(): number {
    return this.pendingScrollLeft ?? this.scrollEl.scrollLeft;
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
    const after = clamp(before * factor, MIN_ZOOM, MAX_ZOOM);
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
    /*
     * restoreAnchor 刚把 scrollTop 挪过，且捏合期间 scroll 事件被冻结，
     * 必须按补偿后的位置现算一次，页码才不会停在错页（INK-107）。
     */
    this.refreshCurrentAfterZoom();
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
     * 第二根手指落下会打断正在擦的手势：先把这一段的撤销记录结算掉。
     * 否则下面把 gesture 抹成 "none" 后 finishEraseGesture 永远不执行，
     * 擦掉的笔迹留在数据里却撤不回来（🔴 数据丢失）。
     */
    if (this.gesture === "erase") {
      this.finishEraseGesture(this.recs[this.current] ?? null);
      if (this.opts.onInkGestureEnd) this.opts.onInkGestureEnd();
    }

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
     * 捏合打断正在进行的「拖文字 / 改宽」时，要**先把那条历史结算掉**
     * （INK-191）。
     *
     * `moveText` 第一次真正拖动时已经调过 `snapshotPage()` 挂了个
     * `pendingBefore`，而 `store.touch()` 只在 `onUp` 里调。被捏合打断后
     * 这个 pending 就一直悬着，会被**下一个不相干操作**的 `touch()` 结算成
     * 一条错误的历史条目（撤销时撤错东西）。
     */
    if (this.moveText?.moved || this.resizeText?.moved) this.store.touch();
    // 捏合开始前若拖着改宽手柄，残留状态会让余指一动就继续改宽度（INK-112 同类坑）
    this.moveText = null;
    this.resizeText = null;

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
      this.scrollEl.getBoundingClientRect().top + this.currentPageProbeOffset()
    );
    window.clearTimeout(this.pinchReleaseTimer);
    this.pinchReleaseTimer = 0;
    this.pinchActive = true;
    this.pinchNeedsRedraw = false;
  }

  /**
   * 补回捏合期间被 CSS 拉伸的位图清晰度。
   *
   * 正常路径由 endPinch 调；窗口失焦 / 仲裁器复位 / renderPages 时
   * onGestureEnd 不会来，这条兜底保证不会永远停在糊图上。
   * 只 resizeRec、不走完整 applyLayout：zoom / CSS 变量 / 属性条位置
   * 手势每帧都已经落好了，没必要再写一遍，也不该在这里重算 fit 比例。
   */
  private flushPinchRedraw(): void {
    if (!this.pinchNeedsRedraw) return;
    this.pinchNeedsRedraw = false;
    for (const rec of this.recs) {
      if (rec.mounted) this.resizeRec(rec);
    }
    // 手势期间可能重算过正在输入的 textarea，补清晰度时一并对齐
    if (this.textEdit) this.applyTextEditZoom();
  }

  /**
   * 手势被切后台 / 仲裁器复位打断，onGestureEnd 不会来。
   * 补清晰度的同时把页码冻结放开，否则 pinchActive 会一直压着 current。
   */
  private abortPinch(): void {
    this.clearPendingPinch();
    if (!this.pinch && !this.pinchNeedsRedraw) return;
    this.pinch = null;
    this.pinchActive = false;
    window.clearTimeout(this.pinchReleaseTimer);
    this.pinchReleaseTimer = 0;
    this.flushPinchRedraw();
    this.measurePageMetrics();
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
    // 手势期间只改过 CSS 变量，位图还是旧 zoom 下画的；一次性补回清晰度
    this.flushPinchRedraw();
    this.measurePageMetrics();

    if (this.recs.length && this.current !== keep) {
      this.current = keep;
      this.store.setPage(keep);
      this.mount(this.recs[keep]);
    }
    this.emitState();
    /*
     * emitState 在手势期间是 rAF 合并的，endPinch 里 pinch=null 后走同步路径，
     * 但那一帧排队的 rAF 仍会跑一次；无害（只是多刷一次工具栏），
     * 且能保证手势最后一帧的 zoom 百分比一定落到 UI 上。
     */

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
      /*
       * 解冻时**补算一次页码**（INK-191）。
       *
       * 冻结期间 `pinchActive` 抑制了 `updateCurrentFromScroll`，
       * 而这段时间里缩放已经改变了页高、scrollTop 也被锚点补偿挪过。
       * 不补算的话页码会停在捏合前的值，用户换另一只手滚页时
       * 才「突然跳」一下——看起来像页码卡住了最长 4.8 秒（20×240ms）。
       */
      this.updateCurrentFromScroll(true);
      this.emitState();
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
  /**
   * 把一个绝对 PinchInfo 合并进下一帧。
   *
   * 每根手指的 pointermove 都会触发仲裁器回调；一帧内可能来十几次。
   * 这里只保留最新绝对量，rAF 里至多调用一次 applyPinch —— 手势仍按最终
   * 两指位置收敛，CSS fast 路径和固定锚点都不变。
   */
  private queuePinch(info: PinchInfo): void {
    this.pendingPinchInfo = info;
    if (this.pinchFrameRaf) return;
    this.pinchFrameRaf = requestAnimationFrame(() => {
      this.pinchFrameRaf = 0;
      this.flushPendingPinch();
    });
  }

  /** 手势收尾 / 帧回调：把暂存的最后一组坐标真正应用一次。 */
  private flushPendingPinch(): void {
    if (this.pinchFrameRaf) {
      cancelAnimationFrame(this.pinchFrameRaf);
      this.pinchFrameRaf = 0;
    }
    const info = this.pendingPinchInfo;
    this.pendingPinchInfo = null;
    if (info && this.pinch) this.applyPinch(info);
  }

  /** 页重建 / 失焦时丢弃过期手势帧，避免旧坐标打到新页对象上。 */
  private clearPendingPinch(): void {
    if (this.pinchFrameRaf) cancelAnimationFrame(this.pinchFrameRaf);
    this.pinchFrameRaf = 0;
    this.pendingPinchInfo = null;
  }

  private applyPinch(info: PinchInfo): void {
    const pinch = this.pinch;
    if (!pinch) return;

    const scale = info.dist / pinch.baseDist;
    const before = this.zoom;
    const after = clamp(pinch.baseZoom * scale, MIN_ZOOM, MAX_ZOOM);
    /*
     * **zoom 没变也要走 restoreAnchor**（INK-191）。
     *
     * 老代码这里有两道早退：`|scale-1| < 0.0005` 和 `after === before`，
     * 都会跳过下面的 `restoreAnchor`。而它不只是"缩放后对锚点"——
     * **两指等距平移（scale 恰好 = 1）时页面靠它跟随手指移动**，
     * 这是 touchDraw 开着时双指滚页的主要方式。早退的结果就是
     * 「两指并排滑动，页面完全不动」；缩放到 0.3/3.5 极限后同理。
     */
    const zoomChanged = Math.abs(after - before) > 1e-9;
    if (zoomChanged) {
      this.fitMode = false;
      this.zoom = after;
      /*
       * fast 路径：只写 CSS 变量 + 属性条位置，让浏览器缩放已有位图。
       * 不碰 canvas backing、不全量重绘——这是捏合跟手的关键。
       * 手势结束后 endPinch 会按最终 zoom 补一次清晰度。
       */
      this.applyLayout(true);
      this.pinchNeedsRedraw = true;
    }

    // 把固定的锚点对回当前两指中心（zoom 没变时这一步就是纯平移）
    this.restoreAnchor(pinch.anchor, info.cx, info.cy);
    if (zoomChanged) {
      /*
       * measurePageMetrics 做 4 次 getBoundingClientRect（强制同步布局），
       * 而它量出来的 pageGap / pageOrigin 只被 pickAnchor / 页码推算用：
       *   · 捏合期间锚点已固定、pinchActive 又冻结了页码；
       *   · CSS 变量同样是等比缩放，pageGap / pageOrigin 并不会变。
       * 所以手势期间整段跳过，endPinch 里统一量一次。
       * restoreAnchor 那一次 rect 是锚点补偿必需的实时量，不能省。
       */
      this.emitState();
    }
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
    // 起手时算一次可滚动上限，整个滑行复用（避免每帧强制布局，INK-229）
    const max = Math.max(0, this.scrollEl.scrollHeight - this.scrollEl.clientHeight);
    this.fling = { vel: vel * gain, last: upT, raf: 0, max };
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
    // 惯性帧里 IO 会连续跨页：打点让新页文字层只排一次队。
    this.markFastScroll();

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
    const max = f.max;
    // 仍读真实 scrollTop：滑行中若被外部跳转 / 拖滚动条改了位置，必须跟着走
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
    // 滑行真的结束：把快滑期间攒下的文字层一次性补齐，不留空层。
    this.fastScrollUntil = 0;
    this.flushDeferredTextLayers(true);
  }

  /** 手势打断了正在写的笔画：整笔撤销，不留半截线 */
  private cancelStroke(): void {
    if (this.gesture === "draw" || this.gesture === "shape") {
      this.draft = null;
      this.draftRec = null;
      this.gesture = "none";
      this.pointerId = null;
      this.smoother.reset();
      this.inkPredictor.reset();
      const rec = this.recs[this.current];
      if (rec) this.renderOverlay(rec);
      // 手势结束要通知 view：避让中的自动保存该恢复排程了
      if (this.opts.onInkGestureEnd) this.opts.onInkGestureEnd();
    }
  }

  private resizeRec(rec: PageRec): void {
    if (!rec.canvas || !rec.overlay) return;
    // 导入文档页按页取更高超采样 dpr（把源位图细节更多留在 backing 里），
    // 手写页/空白页照旧。backing 与下面 repaintEraseRegion 的 transform 必须同源。
    const dpr = this.renderDprFor(this.store.data.pages[rec.index]);
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

  /** 文字层的内容签名：文字、画布尺寸或手写字体时代一变，旧 span 就不可复用。 */
  private textLayerSignature(page: Page): string {
    /*
     * 查找高亮也是渲染产物：查询词 / 当前命中变了，缓存里那一层就已经过期。
     * 不带进签名的话，滚走再滚回来会复用旧 DOM（高亮不跟手或关不掉）。
     */
    const hit = this.findHit;
    const find = this.findQuery
      ? `|find:${this.findQuery}|${hit ? `${hit.page}:${hit.textId}:${hit.start}-${hit.end}` : ""}`
      : "";
    return `${this.store.data.width}x${this.store.data.height}|${this.handFontEpoch}|${JSON.stringify(page.texts ?? [])}${find}`;
  }

  /** 取回同页的脱离 DOM 文字层；签名不一致时直接丢弃。 */
  private takeTextLayer(page: Page): HTMLElement | null {
    const hit = this.textLayerCache.get(page.id);
    if (!hit) return null;
    this.textLayerCache.delete(page.id);
    if (hit.signature !== this.textLayerSignature(page) || hit.el.dataset.textRendered !== "1") {
      return null;
    }
    return hit.el;
  }

  /** 卸载时保留整层 span；LRU 条数不超过 MAX_MOUNTED，平板内存可控。 */
  private cacheTextLayer(rec: PageRec): void {
    const layer = rec.textLayer;
    const page = this.store.data.pages[rec.index];
    if (!layer || !page || layer.dataset.textRendered !== "1") return;
    this.textLayerCache.delete(page.id);
    this.textLayerCache.set(page.id, {
      el: layer,
      signature: this.textLayerSignature(page),
    });
    while (this.textLayerCache.size > MAX_MOUNTED) {
      const oldest = this.textLayerCache.keys().next().value;
      if (!oldest) break;
      this.textLayerCache.delete(oldest);
    }
  }

  /** 内容/字体变化后作废旧层，避免回滚时显示旧文字。 */
  private invalidateTextLayerCache(pageId?: string): void {
    if (pageId) this.textLayerCache.delete(pageId);
    else this.textLayerCache.clear();
  }

  /* ---------------- 脱离 DOM 主画布 LRU（INK-229 平板上下滑卡顿） ---------------- */

  /**
   * 主画布的复用签名。
   *
   * 必须含 backing 尺寸（zoom 或 renderDpr 一变，宽高就变，旧像素尺寸对不上）
   * 和内容 epoch（内容一变，旧像素就是错的）。两者都命中才敢复用。
   */
  private rasterSignature(page: Page, w: number, h: number): string {
    return `${page.id}|${w}x${h}|${this.contentEpoch}`;
  }

  /**
   * 取回同页可复用的主画布。
   *
   * 命中就把条目从缓存里摘出并减掉字节计数（调用方负责插回 DOM 复用）；
   * 签名不一致则直接丢弃、返回 null，走正常重建路径。绝不复用旧像素。
   */
  private takeRaster(rec: PageRec, w: number, h: number): HTMLCanvasElement | null {
    const page = this.store.data.pages[rec.index];
    if (!page) return null;
    const hit = this.rasterCache.get(page.id);
    if (!hit) return null;
    this.rasterCache.delete(page.id);
    this.rasterCacheBytes -= hit.bytes;
    if (hit.signature !== this.rasterSignature(page, w, h)) return null;
    return hit.canvas;
  }

  /**
   * 卸载时把已经画好的主画布留着，按字节预算做 LRU。
   *
   * 只收：mounted 且有 canvas、backing 尺寸与当前一致（否则留着也用不上）、
   * 且当前不在被 force 销毁的路径上。overlay 不收（每页重画）。
   */
  private cacheRaster(rec: PageRec): void {
    const canvas = rec.canvas;
    const page = this.store.data.pages[rec.index];
    if (!canvas || !page) return;
    if (canvas.width <= 0 || canvas.height <= 0) return;
    // 尺寸必须是「按当前 zoom/dpr 应有的尺寸」，否则滚回来签名也不匹配，别占地方。
    // 必须用 renderDprFor(page)：INK-228 起导入文档页会按页超采样到 3.0×，
    // 用统一的 renderDpr() 会算错 backing 尺寸，导致导入文档笔记整本缓存不上。
    const dpr = this.renderDprFor(page);
    const w = Math.round(this.store.data.width * this.zoom * dpr);
    const h = Math.round(this.store.data.height * this.zoom * dpr);
    if (canvas.width !== w || canvas.height !== h) return;
    const bytes = w * h * 4;
    this.rasterCache.delete(page.id);
    this.rasterCache.set(page.id, {
      canvas,
      signature: this.rasterSignature(page, w, h),
      bytes,
    });
    this.rasterCacheBytes += bytes;
    while (
      (this.rasterCacheBytes > RASTER_CACHE_BYTES && this.rasterCache.size > 1) ||
      (this.rasterCache.size > MAX_RASTER_CACHED && this.rasterCache.size > 1)
    ) {
      const oldest = this.rasterCache.keys().next().value;
      if (!oldest) break;
      const dropped = this.rasterCache.get(oldest);
      this.rasterCache.delete(oldest);
      if (dropped) this.rasterCacheBytes -= dropped.bytes;
    }
  }

  /**
   * 只作废某一页脱离 DOM 的旧主画布（单页内容改动用）。
   *
   * 缓存里只有「已卸载」的页；改动当前页时它正挂载着、本来就没有缓存条目，
   * 这一下几乎总是空操作，但能兜住「改到某张恰好已卸载的页」的边界。
   * 关键是不做全局清空：PDF/Word 笔记首次滚过时 `ensurePageTexts()` 会对每页
   * 异步补抽文字并调一次 `changed()`，若每页都全局清空，整个首轮滑动的
   * 复用机会会被全部抹掉——而文字只在 DOM 文字层里，根本不改变画布像素。
   */
  private invalidateRaster(pageId: string): void {
    const hit = this.rasterCache.get(pageId);
    if (!hit) return;
    this.rasterCache.delete(pageId);
    this.rasterCacheBytes -= hit.bytes;
  }

  /**
   * 整本 / 全局内容变了：让所有脱离 DOM 的旧主画布作废（epoch +1 并清空）。
   *
   * 撤销重做、整本换模板纸张、页对象重建等会改动**多页**像素的地方必须
   * 调它，否则复用旧像素会错画。单页改动 / 单页底图到位走
   * invalidateRaster(pageId)，只丢那一条。清空 Map 只丢引用，JS 自行回收
   * backing，无需逐块置零。宁可多失效几次，绝不错画。
   */
  private invalidateRasterCache(): void {
    this.contentEpoch += 1;
    this.rasterCache.clear();
    this.rasterCacheBytes = 0;
  }

  /** 手势拖页、惯性帧与 120ms 宽限期都算「快滑中」。 */
  private isFastScrolling(): boolean {
    return !!this.fling || this.gesture === "pan" || performance.now() < this.fastScrollUntil;
  }

  /** 快滑活动打点：每次都把一次性补画推到最后一个活动之后。 */
  private markFastScroll(): void {
    this.fastScrollUntil = performance.now() + 120;
    this.scheduleDeferredTextFlush();
  }

  /**
   * 安排「静止点」补画文字层。
   *
   * INK-229：原来是**每次** pointermove / 惯性帧都 `clearTimeout` + `setTimeout`
   * 重建一个定时器——一秒钟上百次定时器的创建与销毁。现在改成幂等：
   * 已有定时器就让打点只延长 `fastScrollUntil`，等它到点再看还剩多少宽限期，
   * 按剩余时间重排；没有滑动就打点重排、到点补画。行为不变，任务数大幅下降。
   */
  private scheduleDeferredTextFlush(): void {
    if (this.textLayerIdleTimer) return;
    this.armTextLayerIdleFlush(Math.max(0, this.fastScrollUntil - performance.now()) || 120);
  }

  private armTextLayerIdleFlush(delay: number): void {
    this.textLayerIdleTimer = window.setTimeout(() => {
      this.textLayerIdleTimer = 0;
      // destroy() 之后不再补画、也不再重排定时器（页面关闭时编辑器已失效）
      if (this.destroyed) return;
      const remain = this.fastScrollUntil - performance.now();
      if (remain > 0) {
        // 滑动仍在继续（又被打了点）：按剩余宽限期再等，别在滑动中补文字层
        this.armTextLayerIdleFlush(remain);
        return;
      }
      this.flushDeferredTextLayers();
    }, Math.max(0, delay));
  }

  /** 滑行停止或短空闲后，把仍挂载的延后文字层一次性补齐。 */
  private flushDeferredTextLayers(force = false): void {
    if (!force && this.isFastScrolling()) {
      this.scheduleDeferredTextFlush();
      return;
    }
    if (this.deferredTextLayers.size) {
      const pending = [...this.deferredTextLayers];
      this.deferredTextLayers.clear();
      for (const rec of pending) {
        if (rec.mounted && rec.textLayer) this.renderTextLayer(rec);
      }
    }
    // 软预算检查复用同一个静止点，不另起定时器；文字层为空时也要补跑。
    this.flushPendingMountLimit(force);
  }

  /**
   * IO 回调只排队挂载预算检查，不在滑动帧里直接量布局。
   *
   * 软预算只卸「IO 预挂范围外」的离屏页，晚一帧/等到静止再卸没有视觉差别；
   * 但 `MAX_MOUNTED` 页数硬上限是显存红线，超了仍立即执行（且只跑硬上限，
   * 跳过软预算那轮 getBoundingClientRect 排序）。当前页挂载完全不受影响。
   */
  private queueMountLimitEnforcement(): void {
    if (this.destroyed) return;
    this.mountLimitPending = true;
    let mounted = 0;
    for (const rec of this.recs) if (rec.mounted) mounted++;
    if (mounted > MAX_MOUNTED) this.enforceMountLimit(true);
    if (this.isFastScrolling()) {
      // markFastScroll() 已排了 120ms 静止点；这里只防它意外缺失。
      if (!this.textLayerIdleTimer) this.scheduleDeferredTextFlush();
      return;
    }
    this.scheduleMountLimitFrame();
  }

  /** 非快滑期把一帧内的多次 IO 回调合并成一次软预算检查。 */
  private scheduleMountLimitFrame(): void {
    if (this.destroyed || this.mountLimitRaf) return;
    this.mountLimitRaf = requestAnimationFrame(() => {
      this.mountLimitRaf = 0;
      if (this.destroyed || !this.mountLimitPending) return;
      if (this.isFastScrolling()) {
        if (!this.textLayerIdleTimer) this.scheduleDeferredTextFlush();
        return;
      }
      this.mountLimitPending = false;
      this.enforceMountLimit();
    });
  }

  /** 滑行停止 / 120ms 静止点：把挂起的软预算检查补跑一次。 */
  private flushPendingMountLimit(force = false): void {
    if (!this.mountLimitPending) return;
    if (!force && this.isFastScrolling()) return;
    this.mountLimitPending = false;
    if (this.mountLimitRaf) cancelAnimationFrame(this.mountLimitRaf);
    this.mountLimitRaf = 0;
    if (!this.destroyed) this.enforceMountLimit();
  }

  private mount(rec: PageRec): void {
    if (rec.mounted) return;
    const page = this.store.data.pages[rec.index];
    if (!page) return;
    /*
     * 先看有没有可复用的主画布（INK-229 平板上下滑卡顿）。
     *
     * 命中：直接插回已画好像素的 canvas，跳过 resizeRec 的 backing 重分配
     * 与 renderRec 的全量重绘——这正是「每滑一页顿一下」的主要来源。
     * overlay 永远新建（依赖实时草稿 / 光标 / 选中），命中路径也会 renderOverlay。
     *
     * 期望 backing 尺寸必须与 resizeRec 同源：INK-228 起导入文档页按页超采样，
     * 所以这里也用 renderDprFor(page)，否则签名永远对不上、导入笔记缓存不命中。
     */
    const dpr = this.renderDprFor(page);
    const bw = Math.round(this.store.data.width * this.zoom * dpr);
    const bh = Math.round(this.store.data.height * this.zoom * dpr);
    const reused = this.takeRaster(rec, bw, bh);

    let canvas: HTMLCanvasElement;
    let ctx: CanvasRenderingContext2D | null;
    let reusedRaster = false;
    if (reused) {
      canvas = reused;
      ctx = canvas.getContext("2d");
      // 同一元素的 context 还在，但 zoom 已可能变过：重设变换保证页面坐标正确
      const k = dpr * this.zoom;
      ctx?.setTransform(k, 0, 0, k, 0, 0);
      reusedRaster = true;
    } else {
      canvas = document.createElement("canvas");
      ctx = null;
    }
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
    const cachedLayer = this.takeTextLayer(page);
    const textLayer = cachedLayer ?? document.createElement("div");
    textLayer.className = "mb-textlayer";
    // 层的尺寸跟着页面数据走（A4 是 794×1123，但别把这个数字写死两遍）
    textLayer.style.width = `${this.store.data.width}px`;
    textLayer.style.height = `${this.store.data.height}px`;
    rec.pageEl.insertBefore(textLayer, overlay);
    rec.textLayer = textLayer;
    rec.canvas = canvas;
    rec.overlay = overlay;
    rec.ctx = ctx;
    rec.mounted = true;
    /*
     * 快滑跨页不建几百/几千个透明 span：画布与笔迹仍同步创建、当前页不空白，
     * 文字层留在松手后的一次性补画里；缓存命中则连补画都不需要。
     */
    if (!cachedLayer) {
      if (this.isFastScrolling()) this.deferredTextLayers.add(rec);
      else this.renderTextLayer(rec);
    }
    this.ensurePageTexts(rec);
    if (reusedRaster) {
      /*
       * 主画布像素已经在缓存里，只需重建 overlay（依赖实时状态，不缓存）。
       * 注意：跳过 resizeRec 后它原本负责的 octx / overlay 变换要在这里补上，
       * 否则 renderOverlay 因 octx=null 直接返回、选中框 / 橡皮圈 / 草稿全不显示。
       */
      rec.octx = overlay.getContext("2d");
      const k = dpr * this.zoom;
      rec.octx?.setTransform(k, 0, 0, k, 0, 0);
      this.renderOverlay(rec);
    } else {
      this.resizeRec(rec);
    }
    // 页面重新挂载（卸载过又滚回来）时，选中还在就把属性条挂回去
    if (rec.index === this.current) {
      this.syncTextBar();
      this.syncImageBar();
    }
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
    this.deferredTextLayers.delete(rec);
    this.cacheTextLayer(rec);
    // 主画布留作复用（overlay / 文字层照常丢弃）；force 销毁不收
    if (!force) this.cacheRaster(rec);
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
        // 兜底：挂载数要压回预算内，但快滑时不逐回调强制量布局。
        // 软预算检查合并/延后到静止点；它只削「已经滚出预挂范围」的页，
        // 绝不碰 ioVisible 的那些（见 PageRec.ioVisible），所以没有视觉变化。
        this.queueMountLimitEnforcement();
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
   * 只在 IO 合并帧或快滑静止点调，不在滑动帧里逐回调算——算一次很便宜，
   * 没必要加缓存，加了反而要和 zoom / dpr 的变化手动同步。
   */
  private mountLimit(): number {
    const dpr = this.mountBudgetDpr();
    const w = this.store.data.width * this.zoom * dpr;
    const h = this.store.data.height * this.zoom * dpr;
    const perPage = w * h * 4 * 2; // 两块画布，4 字节/像素
    if (!(perPage > 0)) return MIN_MOUNTED;
    const byBytes = Math.floor(MOUNT_BUDGET_BYTES / perPage);
    return clamp(byBytes, MIN_MOUNTED, MAX_MOUNTED);
  }

  /**
   * 估挂载预算时用的每页 dpr。
   *
   * 书里只要有导入文档页，就按文档页可能用到的更高超采样 dpr（3.0×）估每页字节：
   * 否则按手写页的 1.25 估、放过 8 页，实际每页 3.0× 会越过挂载预算。
   * 纯手写书（没有文档页）仍按 1.25 估，不因这条降低预挂页数。
   * `documentRenderDpr()` 已按 MIN_MOUNTED=2 页夹取过，所以这里反推的 limit 必 ≥2。
   */
  private mountBudgetDpr(): number {
    const hasDoc = this.store.data.pages.some((p) => this.pageIsImportedDoc(p));
    if (!hasDoc) return this.renderDpr();
    return Math.max(this.renderDpr(), this.documentRenderDpr());
  }

  /**
   * 保证同时挂载的页数尽量不超预算。
   *
   * 削减顺序按**离视口矩形的像素距离**排，远的先卸。
   * 索引距离不够用：回滚时 current 两侧的页索引差会打平，
   * 稳定排序正好把「下一屏就要看的那页」牺牲掉。
   *
   * `hardCapOnly`：快滑帧只立即守住 MAX_MOUNTED 页数硬上限，
   * 不去算软预算 / 读 rect；静止后由 queueMountLimitEnforcement 再跑完整版。
   */
  private enforceMountLimit(hardCapOnly = false): void {
    const limit = hardCapOnly ? MAX_MOUNTED : this.mountLimit();
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
    // 导入本子已有高分辨率底图：缩小显示时用高质量降采样，避免 Word/PDF 小字发糊。
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
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
   * 上限同时按「单张画布 16M 像素」和「MIN_MOUNTED 页的 160MiB 总预算」算。
   * 后者由下面调用的 `inkEffectiveRenderDpr()` 负责：3.5 倍时单块 16M 没超，
   * 但两页仍超总预算，只降约 2% 的 dpr 即可；宁可略微软一点，也不留空白页或爆内存。
   *
   * ── 桌面端（devicePixelRatio = 1）超采样到 1.25 ──
   *
   * 根因（实测：5 个 seed × 2 种笔画 × 真 Chrome 合成，每格 n=10）：
   * dpr=1 时画布 backing 只有 1 个设备像素/页面单位，笔迹边缘
   * **一次采样就定了** → 呈台阶状，用户看到的正是「边缘不够丝滑」。
   * 超采样后 backing 变 1.25 倍，浏览器用**非整数比**降采样，
   * 每个输出像素按 1 或 2 个源像素加权 → 灰阶过渡摊开 → 边缘细腻。
   *
   * 实测硬台阶占比（越低越丝滑）：
   *   z=0.8   鼠标 17.61% → 5.26%（-70%）  笔 17.14% → 5.77%（-66%）
   *   z=2.8   鼠标  7.34% → 2.80%（-62%）  笔  8.47% → 3.87%（-54%）
   *
   * 为什么是 1.25 而不是 2：**整数比会被重新量化**。dpr=2 时浏览器做
   * 2:1 降采样，每个输出像素恰好是 2×2 源像素的平均 → 已经抗锯齿过
   * 的边缘被压成一档灰阶 → 硬台阶反弹回 17.37%（比 1.25 差 3 倍多）。
   * 非整数比（1.25）没有这个问题。实测 dpr=1.5 是 6.85%，也不如 1.25。
   *
   * 为什么 dpr=2 的设备（平板）**不动**：用户天天用平板写字，
   * 平板现在的手感没被抱怨，不拿没问题的场景去冒险。实测平板的
   * dpr=2 → 17.14%，改 1.25（5.77%）确实更平滑，但那属于
   * 「用户没要求的大改动」，等真机验证过再说。
   *
   * 内存（fit 档 zoom≈0.8，794×1123 页面）：
   *   dpr=1     → 635×898  = 0.57M px = 2.2MB/块，两块/页 4.4MB
   *   dpr=1.25  → 794×1123 = 0.89M px = 3.4MB/块，两块/页 6.8MB
   *   8 页挂满：35MB → 54MB，仍远低于 MOUNT_BUDGET_BYTES(160MB)。
   *   单块 0.89M px 远小于 MAX_CANVAS_PIXELS(16M)，红线未动。
   */
  private renderDpr(): number {
    // 策略与测试共用同一个纯函数：单块像素 + MIN_MOUNTED 页总字节都在这里夹取。
    return inkEffectiveRenderDpr(
      window.devicePixelRatio || 1,
      this.zoom,
      this.store.data.width,
      this.store.data.height
    );
  }

  /**
   * 这一页是不是「导入文档页」——正文是位图（PDF 光栅图 / Word 渲染出来的 PNG）。
   * 这类页面的正文清晰度靠提高 backing 超采样来保（见 DOCUMENT_READ_SUPERSAMPLE），
   * 手写页/空白页没有位图正文，不需要额外超采样。
   */
  private pageIsImportedDoc(page: Page | undefined): boolean {
    const bg = page?.background;
    return !!(bg && (bg.pdf || bg.src));
  }

  /**
   * 导入文档页在「日常书写倍率」档的目标超采样 dpr（经两道内存上限夹取）。
   *
   * 桌面（dpr=1）与平板（dpr=2）都要抬到 `DOCUMENT_READ_SUPERSAMPLE`：
   * 导入文档正文是一张位图，清晰度取决于「源位图 → backing → 屏幕」这条链上
   * **中间 backing 保留了多少源细节**。平板虽然原生 2×，但 backing 只有
   * 794×zoom×2≈1588，源 Word/PDF 位图约 3335 宽，仍有 2 倍多的下采样损失；
   * 抬到 3.0× 让 backing 到约 2382、把源细节更多留在中间层，再交给合成器
   * 降到设备像素，小字更锐更黑（平板实测见 PR 证据）。
   *
   * 只在 zoom ≤ SUPERSAMPLE_MAX_ZOOM（日常阅读/书写倍率）时抬；>1.25 的高倍
   * 缩放字已经够大，退回原生、也不吃内存。返回值已经过 `inkEffectiveRenderDpr`
   * 的单块像素 + MIN_MOUNTED 页总字节两道预算，绝不越红线；zoom 偏高时自动夹低。
   */
  private documentRenderDpr(): number {
    if (documentSupersampleOverride === false) return this.renderDpr();
    const zoom = this.zoom;
    if (!(zoom > 0) || zoom > SUPERSAMPLE_MAX_ZOOM) return this.renderDpr();
    const target = documentReadSupersampleValue ?? DOCUMENT_READ_SUPERSAMPLE;
    return inkEffectiveRenderDpr(
      window.devicePixelRatio || 1,
      zoom,
      this.store.data.width,
      this.store.data.height,
      target
    );
  }

  /**
   * 某页最终渲染 dpr：导入文档页用 `documentRenderDpr()`（可能抬到 3.0×），
   * 手写页/空白页照旧用 `renderDpr()`。`resizeRec`、`repaintEraseRegion` 都走它，
   * 保证「画布 backing / 擦除局部重绘」用同一个 dpr。
   */
  private renderDprFor(page: Page | undefined): number {
    return this.pageIsImportedDoc(page) ? this.documentRenderDpr() : this.renderDpr();
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
      // PDF 位图长期超采样，落到当前画布常是缩小：显式开高质量采样。
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
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
   * 渲染 PDF 页需要的目标位图宽度（设备像素）。
   *
   * 这就是之前模糊的根源：
   * 旧代码用 `zoom × dpr` 当渲染倍率，但那是**页面坐标**的倍率；
   * PDF 的原生尺寸单位是 **point**（A4 = 595.28pt 宽），
   * 而底图在页面坐标系里占 794 单位宽——中间差了一个 794/595.28 ≈ 1.334
   * 的换算系数。漏掉它，位图就比显示尺寸小 1.33 倍，
   * 被拉伸显示 → 明显发虚。
   *
   * 现在直接算「屏幕上的设备像素宽度」：
   *   设备像素宽 = CSS 宽度 × dpr = 页面单位宽 × （zoom × dpr）
   *
   * 但**不能**让目标宽度跟着 zoom 一起降——那正是「缩小就糊」：
   * zoom 0.5 时只剩 1.33 设备像素/pt，zoom 0.35 时只剩 0.47，
   * pdf.js 被迫在亚像素倍率上光栅化中文，笔画粘连；而位图是手上唯一的
   * 那张图，糊下去就回不来了。所以给「每页面单位设备像素」设一个
   * 与 zoom、dpr 都无关的地板（PDF_FLOOR_PPU，见 src/pdf.ts）：
   * 位图永远超采样，缩小靠画布 drawImage 高质量降采样，
   * 放大时目标提高（max 的机制不变）继续重渲染更清的那份。
   */
  private pdfTargetWidth(bg: PageBackground): number {
    // 设备像素 / 页面单位 = 缩放 × 渲染像素比
    // 用 documentRenderDpr()：PDF 页是导入文档页，画布 backing 可能被抬到 3.0×，
    // 目标位图必须同步跟着抬，否则底图比 backing 小 → 被放大反而更糊。
    return pdfTargetWidthPx(bg.width, this.zoom * this.documentRenderDpr());
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
          const cached = this.bgBitmaps.set(key, rendered.bitmap, rendered.bitmap.width);
          this.markBgDirty(pdfPath, pageNo);
          /*
           * 没进缓存（单张就超预算）→ 立刻收工，别再循环。
           *
           * 否则：这一轮渲完没缓存 → markBgDirty 重画 → drawPdfBackground
           * 拿不到图 → 又请求渲染 → 又超预算 → 无限重渲，CPU 打满。
           * 位图本身已经画到屏幕上了（markBgDirty 用的是刚渲染的这张），
           * 只是留不住 —— 那就不留。
           */
          if (!cached) {
            console.warn("[inkbook] PDF 位图超出缓存预算，本页不缓存", key, rendered.bitmap.width);
            break;
          }
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
          if (!rec) continue;
          /*
           * 底图到位只改变这一页的像素（INK-229）：逐页作废它脱离 DOM 的
           * 旧主画布，避免下次滚回来复用「还没画上底图」的旧像素。
           * 不全局清空——连续滑 PDF 时位图一张接一张到位，全局清空会把
           * 刚滑过去那几页的复用机会全抹掉。
           */
          const page = this.store.data.pages[rec.index];
          if (page) this.invalidateRaster(page.id);
          if (!rec.mounted) continue;
          this.renderRec(rec);
          this.renderOverlay(rec);
        }
      });
    }
    /*
     * 侧栏缩略图也要补一次（INK-183）。
     *
     * 主视图的 PDF 底图渲染好了，但缩略图那边可能**早就放弃了**：
     * `requestPdfThumb` 开头有 `if (this.bgBitmaps.getEntry(key)) return;`
     * ——主视图正在渲染这一页时缓存里还没有图，缩略图请求被直接跳过，
     * 而且它不会自己重试（第一次画完就 unobserve 了）。结果就是
     * 主视图显示正常、侧栏那几页永远停在灰底。
     *
     * 静态底图（`loadBackground`）那条路径早就有这个补画回调，PDF 这条漏了。
     */
    const thumbCb = this.opts.onThumbNeedsRedraw;
    if (thumbCb) {
      for (let i = 0; i < this.store.data.pages.length; i += 1) {
        const bg = this.store.data.pages[i]?.background;
        if (bg?.pdf && bg.pdf.path === pdfPath && bg.pdf.page === pageNo) thumbCb(i);
      }
    }
  }

  /**
   * 异步加载一张图（底图或插入的图片），加载完重画所有引用它的页。
   *
   * 两者共用一个 `bgImages` 缓存：都是"库内路径 → HTMLImageElement"，
   * 用同一个 key（src 路径）不会冲突；共用还能让同一张图既当底图又被插入时
   * 只解码一次。
   */
  private pageUsesImageSrc(page: Page, src: string): boolean {
    if (page?.background?.src === src) return true;
    return !!page?.images?.some((im) => im.src === src);
  }

  private loadBackground(src: string): void {
    if (this.bgLoading.has(src) || this.bgImages.has(src)) return;
    this.bgLoading.add(src);
    const img = new Image();
    // 图片存在库里，用 app:// 协议读
    img.onload = () => {
      this.bgLoading.delete(src);
      this.bgImages.set(src, img);
      for (const rec of this.recs) {
        const page = this.store.data.pages[rec.index];
        if (this.pageUsesImageSrc(page, src)) {
          /*
           * 底图到位改变这一页的像素：只作废这一页脱离 DOM 的旧主画布
           * （INK-229）。逐页作废而非全局清空——导入文档里多页共用同一张
           * 底图时，别把刚滑过去那几页已经画好的画布一起丢掉。
           */
          this.invalidateRaster(page.id);
          this.renderRec(rec);
          this.renderOverlay(rec);
        }
      }
      // 侧栏缩略图也要补一次：它第一次画的时候图片还没加载完
      const thumbCb = this.opts.onThumbNeedsRedraw;
      if (thumbCb) {
        for (let i = 0; i < this.store.data.pages.length; i += 1) {
          if (this.pageUsesImageSrc(this.store.data.pages[i], src)) thumbCb(i);
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
    /*
     * 兜底（INK-229）：只要重画了某页，它脱离 DOM 的旧主画布就一律作废。
     * 绝大多数调用时该页正挂载、本来没有缓存条目（纯 O(1) 空查），
     * 但能挡住任何将来新增的「改了内容却忘了清缓存」的路径，避免错画。
     * 必须放在 `!rec.ctx` 之前：底图异步到位时对未挂载页也会走到这里。
     */
    if (page) this.invalidateRaster(page.id);
    if (!page || !rec.ctx) return;
    const ctx = rec.ctx;
    ctx.clearRect(0, 0, this.store.data.width, this.store.data.height);
    drawPaper(ctx, page.template, page.paper, this.store.data.width, this.store.data.height, 1);
    this.drawBackground(ctx, page);
    this.drawInsertedImages(ctx, page);
    for (const layer of page.layers) {
      if (!layer.visible) continue;
      for (const stroke of layer.strokes) drawStroke(ctx, stroke, layer.opacity);
    }
  }

  /**
   * 橡皮手势期间的局部重绘：只把**受影响的矩形**按 renderRec 的顺序重画一遍。
   *
   * 旧实现每个 pointermove 都走 renderRec——清整页 + 重画全部笔迹，
   * 1000 笔的页面上要 10~30ms/帧，平板上擦字明显发滞。
   * 局部重绘的工作量只和「擦除点附近的笔迹数」有关，与整页笔迹总数无关
   * （全页笔迹数仍要扫一遍包围盒，但那是缓存过的 WeakMap 查询，不是逐点绘制）。
   *
   * 为什么不用 overlay 做预览补丁：
   *   · overlay 下面还压着文字层（DOM），铺一块不透明的纸色补丁会把
   *     附近的文字批注在擦除过程中遮住，抬手才重新出现；
   *   · 荧光笔用 multiply 合成，画在透明 overlay 上再 source-over 贴回主画布，
   *     结果和直接乘在纸面上不一致；
   *   · 主画布反正要更新，直接在原地做 dirty-rect 重绘没有合成接缝。
   *
   * 裁剪区先切到设备像素（transform 置 1:1）再切回页面坐标：
   * 否则切边落在半像素上，半透明笔迹会在边界处二次混合出一条细线。
   */
  private repaintEraseRegion(rec: PageRec, b: Bounds): void {
    const ctx = rec.ctx;
    const page = this.store.data.pages[rec.index];
    if (!ctx || !page) return;
    const w = this.store.data.width;
    const h = this.store.data.height;
    // 画布变换是 resizeRec 设的等比缩放；拿实际值，别用可能已经变过的 this.zoom
    let k = this.zoom * this.renderDprFor(page);
    try {
      const m = ctx.getTransform?.();
      const km = m ? Math.hypot(m.a, m.b) : 0;
      if (Number.isFinite(km) && km > 0.0001) k = km;
    } catch (_) {}
    if (!(k > 0.0001)) return;

    const x0 = Math.max(0, Math.floor(Math.max(0, b.minX) * k));
    const y0 = Math.max(0, Math.floor(Math.max(0, b.minY) * k));
    const x1 = Math.min(Math.ceil(w * k), Math.ceil(Math.min(w, b.maxX) * k));
    const y1 = Math.min(Math.ceil(h * k), Math.ceil(Math.min(h, b.maxY) * k));
    if (x1 <= x0 || y1 <= y0) return;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    // 顺序必须和 renderRec 一致：纸面 → 底图 → 插入图片 → 各层笔迹
    drawPaper(ctx, page.template, page.paper, w, h, 1);
    this.drawBackground(ctx, page);
    this.drawInsertedImages(ctx, page);
    for (const layer of page.layers) {
      if (!layer.visible) continue;
      for (const stroke of layer.strokes) {
        if (!this.strokeTouchesRegion(stroke, b)) continue;
        drawStroke(ctx, stroke, layer.opacity);
      }
    }
    ctx.restore();
  }

  /**
   * 笔迹轮廓可能超出 strokeBounds 的额外余量。
   *
   * strokeBounds 只按点集算、并留了 size/2+5；但完美自由手在拐弯处会略微过冲，
   * 而箭头的头部是从端点**往回**画 max(10, size*4)——短箭头的头会伸到
   * 点集包围盒外面。局部重绘漏掉这一点，整笔擦除后会残留半截箭头。
   */
  private strokeExtraPad(s: Stroke): number {
    let pad = s.size / 2 + 2;
    if (s.tool === "shape") pad = Math.max(pad, Math.max(10, s.size * 4) + 2);
    return pad;
  }

  /** 笔迹包围盒（含外扩余量）是否与重绘区相交 */
  private strokeTouchesRegion(stroke: Stroke, b: Bounds): boolean {
    const sb = strokeBounds(stroke);
    const pad = this.strokeExtraPad(stroke);
    return (
      sb.maxX + pad >= b.minX &&
      sb.minX - pad <= b.maxX &&
      sb.maxY + pad >= b.minY &&
      sb.minY - pad <= b.maxY
    );
  }

  /** 实时预览用的笔迹：真实点 + 预测尾巴 */
  private previewStroke(): Stroke | null {
    const draft = this.draft;
    if (!draft) return null;
    if (this.opts.prediction === false) return draft;
    if (draft.tool === "highlighter" || draft.tool === "shape") return draft;
    if (draft.points.length < 2) return draft;
    /*
     * 经典手写应用等价预测器预热完就用它：按速度/转角自适应时长、三次拟合修正、
     * 8 段二次贝塞尔 + 递细压力。起笔前几帧（预热）沿用旧的三点外推，
     * 免得第一笔完全看不到预览尾巴。tail 只在 push 时算一次，
     * 这里一帧里被 renderOverlay 反复调用也不会累加预测状态。
     */
    const tail = this.inkPredictor.ready
      ? this.inkPredictor.tail
      : predictTail(draft.points, 3, 0.7, 24);
    if (!tail.length) return draft;
    return { ...draft, points: draft.points.concat(tail) };
  }

  /**
   * 选中文字的框几何：虚线框 + 右下角改宽手柄。
   *
   * 画和命中都读这一份，避免手柄画在一个位置、却去另一个位置判命中。
   * 框宽用**实测最长行**（点文字按字的实际占位命中），手柄用**排版宽度**
   * l.width（折行边界）——两者各司其职，不能合并成一个数。
   */
  private textSelGeom(t: PageText): {
    left: number;
    top: number;
    boxW: number;
    boxH: number;
    handleX: number;
    handleY: number;
    handleR: number;
  } {
    const l = this.textLayout(t);
    const boxW = Math.max(24, this.measureTextWidth(t, l.lines)) + 8;
    const top = l.y - t.size * 1.18;
    const boxH = l.lineHeight * Math.max(1, l.lines.length) + t.size * 0.24;
    // 手柄贴在折行边界的右端，而不是实测文字右缘：拖它才是在改「一行放多少字」
    const handleX = l.x + l.width;
    const handleY = top + boxH;
    // 半径按 zoom 反算，屏幕上恒为 6px；命中半径放大到 10px 照顾手指
    return {
      left: l.x - 3,
      top,
      boxW,
      boxH,
      handleX,
      handleY,
      handleR: 6 / this.zoom,
    };
  }

  private renderOverlay(rec: PageRec): void {
    if (!rec.octx) return;
    const ctx = rec.octx;
    const w = this.store.data.width;
    const h = this.store.data.height;
    ctx.clearRect(0, 0, w, h);

    /*
     * 橡皮范围圈放在 current 判定**之前**：鼠标可能悬停在非当前页上
     * （长本子滚动后视口里同时有好几页），圈得跟着鼠标走，不能只画在 current 页。
     * 其余 overlay 内容（草稿 / 笔尖 / 选中框）仍只属于当前页。
     *
     * 圈是橡皮本身的范围；strokeHit 里另有 `+ stroke.size / 2`（笔迹自身
     * 的粗细），所以实际擦掉的笔迹边缘可能略超出这个圈——这是有意为之，
     * 用来把粗笔迹的外沿一起擦掉，不是半径对不上。
     */
    if (this.eraserPos && this.eraserPos.pageIndex === rec.index) {
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
     * 经典手写应用「点状激光笔 / 线条激光笔」移植：一条按时间淡出的红色光迹 +
     * 笔尖光点。和橡皮圈一样放在 current 判定之前：激光可能指在非当前页上。
     * 只画在 overlay 上，抬手后光迹自然消散，不进 store、不进撤销、不进导出。
     * 点的透明度按 (1 - age/寿命) 逐段算，尾端先灭，视觉上像尾迹。
     */
    if (this.laserTrail.length && this.laserPage === rec.index) {
      const now = performance.now();
      // 先把原始采样点平滑成一条曲线、按年龄算好剩余生命（lasertrail.ts）。
      const geo = buildLaserGeometry(this.laserTrail, now, LASER_FADE_MS);
      const bands = bandLaserSamples(geo.samples, 10);
      const tracePath = (pts: Array<{ x: number; y: number }>) => {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      };
      if (bands.length) {
        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        // 外层柔光：淡、略宽，兜住本体让整条 alpha 平稳（不糊成一坨）
        for (const band of bands) {
          if (band.points.length < 2) continue;
          tracePath(band.points);
          ctx.strokeStyle = `rgba(255,66,66,${(0.16 * band.life).toFixed(3)})`;
          ctx.lineWidth = (5 + 6 * band.life) / this.zoom;
          ctx.stroke();
        }
        // 激光本体：饱和红、够亮够实。不再叠一根亚像素细白芯——那种亚像素
        // 描边采样出来是一串毛刺（亮珠），只叠「外发光 + 本体」两层最干净。
        for (const band of bands) {
          if (band.points.length < 2) continue;
          tracePath(band.points);
          ctx.strokeStyle = `rgba(255,60,60,${(0.85 * band.life).toFixed(3)})`;
          ctx.lineWidth = (2 + 2.8 * band.life) / this.zoom;
          ctx.stroke();
        }
        ctx.restore();
      }
      // 头部光点：小而亮的白芯红晕，像激光笔落在纸上那一点
      const head = geo.head;
      if (head) {
        const r = (2.2 + 1.6 * head.life) / this.zoom;
        const g = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, r * 2.0);
        g.addColorStop(0, `rgba(255,255,255,${(0.98 * head.life).toFixed(3)})`);
        g.addColorStop(0.35, `rgba(255,120,120,${(0.85 * head.life).toFixed(3)})`);
        g.addColorStop(1, "rgba(255,50,50,0)");
        ctx.save();
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(head.x, head.y, r * 2.0, 0, Math.PI * 2);
        ctx.fill();
        // 中心实心亮点：任何底色上都留一点锐利的白，指向感更强
        ctx.fillStyle = `rgba(255,255,255,${(0.95 * head.life).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(head.x, head.y, Math.max(0.8, r * 0.5), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    if (rec.index !== this.current) return;

    if (this.draft && this.draftRec === rec) {
      // 实时预览带上预测尾巴：墨迹跑在笔尖前面一点，落笔更跟手
      const preview = this.previewStroke();
      if (preview) drawStroke(ctx, preview);
    }

    if (this.hoverPos && this.gesture === "none") {
      const h = this.hoverPos;
      // 笔尖预览点也跟着当前这支笔 / 这类形状自己的粗细走
      const tip =
        this.tool === "highlighter"
          ? this.highlighterSize
          : this.tool === "ballpoint"
            ? this.ballpointSize
            : this.tool === "shape"
              ? this.shapeSizes[this.shapeKind] ?? this.penSize
              : this.penSize;
      const r = Math.max(3, (tip * (0.35 + h.p * 0.65)) / 2);
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
      const g = this.textSelGeom(sel);
      ctx.save();
      ctx.strokeStyle = "#6C5CE7";
      ctx.lineWidth = 1.4 / this.zoom;
      ctx.setLineDash([5 / this.zoom, 4 / this.zoom]);
      ctx.strokeRect(g.left, g.top, g.boxW, g.boxH);
      ctx.restore();

      /*
       * 改宽手柄在选择 / 文字工具下都画：用户输入完文字后（还停在文字工具）
       * 选中它也要能拖右下角的圆点改框宽——之前只在「选择」工具画，文字
       * 工具里选中文字看不到圆点，用户以为这个功能没了。文字工具里点手柄
       * 会被下面的 handleTextPointer 优先判成 resizeText，不会误开新输入框。
       */
      if (this.tool === "select" || this.tool === "text") {
        ctx.save();
        ctx.beginPath();
        ctx.arc(g.handleX, g.handleY, g.handleR, 0, Math.PI * 2);
        ctx.fillStyle = "#FFFFFF";
        ctx.fill();
        ctx.strokeStyle = "#6C5CE7";
        ctx.lineWidth = 1.6 / this.zoom;
        ctx.stroke();
        ctx.restore();
      }
    }

    /*
     * 选中形状的虚线选框 + 8 个缩放手柄。
     *
     * 和文字选框一样画在 overlay 上：overlay 已按页面坐标缩放好，缩放、
     * 滚动都不用管。手柄画成白色小方块 + 紫色描边，和文字那个圆点手柄区分。
     */
    const selShape = this.tool === "select" ? this.selectedShape : null;
    if (selShape) {
      const b = this.shapeSelBox(selShape);
      ctx.save();
      ctx.strokeStyle = "#6C5CE7";
      ctx.lineWidth = 1.4 / this.zoom;
      ctx.setLineDash([5 / this.zoom, 4 / this.zoom]);
      ctx.strokeRect(b.minX, b.minY, Math.max(1, b.maxX - b.minX), Math.max(1, b.maxY - b.minY));
      ctx.restore();

      const hr = 4.5 / this.zoom;
      ctx.save();
      for (const hp of this.shapeHandlePoints(b)) {
        ctx.beginPath();
        ctx.rect(hp.x - hr, hp.y - hr, hr * 2, hr * 2);
        ctx.fillStyle = "#FFFFFF";
        ctx.fill();
        ctx.strokeStyle = "#6C5CE7";
        ctx.lineWidth = 1.6 / this.zoom;
        ctx.stroke();
      }
      ctx.restore();
    }

    /*
     * 选中图片的虚线选框 + 4 个角手柄。
     * 只有「选择」工具能选中图片（切工具时 selectImage(null) 已清），
     * 所以这里按 selectedImage 有无判断即可。
     */
    const selImg = this.selectedImage;
    if (selImg) {
      const b = this.imageSelBox(selImg);
      ctx.save();
      ctx.strokeStyle = "#6C5CE7";
      ctx.lineWidth = 1.4 / this.zoom;
      ctx.setLineDash([5 / this.zoom, 4 / this.zoom]);
      ctx.strokeRect(b.minX, b.minY, Math.max(1, b.maxX - b.minX), Math.max(1, b.maxY - b.minY));
      ctx.restore();

      const hr = 4.5 / this.zoom;
      ctx.save();
      for (const hp of this.imageHandlePoints(b)) {
        ctx.beginPath();
        ctx.rect(hp.x - hr, hp.y - hr, hr * 2, hr * 2);
        ctx.fillStyle = "#FFFFFF";
        ctx.fill();
        ctx.strokeStyle = "#6C5CE7";
        ctx.lineWidth = 1.6 / this.zoom;
        ctx.stroke();
      }
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
    const page = this.store.data.pages[rec.index];
    const signature = page ? this.textLayerSignature(page) : "";
    if (layer.dataset.textSig !== signature) this.invalidateTextLayerCache(page?.id);
    layer.dataset.textSig = signature;
    layer.dataset.textRendered = "1";
    layer.textContent = "";
    const texts = page?.texts;
    if (!texts || !texts.length) {
      layer.classList.remove("has-find-hits");
      return;
    }

    for (const t of texts) {
      const el = document.createElement("span");
      el.className = "mb-text " + (t.source === "user" ? "is-user" : "is-pdf");
      /*
       * 非用户来源（PDF 原文 / Word 正文）每行末尾补一个换行：
       * 拖选多行时复制出来才是分开的句子。绝对定位的 span 之间浏览器
       * 不会自动插入分隔符，不补就成了 "第一行第二行" 一长串。
       * 用户文字不补——它自己的 \n 就是用户想要的换行。
       */
      let content = t.text + (t.source !== "user" ? "\n" : "");
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
         * **屏幕断行必须用 layoutUserText 的结果**（INK-192）。
         *
         * 以前只给 span 写 `width`，折行交给 CSS（`white-space: pre-wrap`
         * + `overflow-wrap: break-word`）。但 `wrapText` 有一套自己的规则：
         * 「空格处断，但断出来的行不满 60% 就逐字硬断」。两套规则在窄框
         * 英文上**必然不同**——实测框宽 160 时 `Introduction` 被 `wrapText`
         * 劈成 `Introducti` / `on`，而 CSS 会在空格处断成完整单词。
         * 结果就是「屏幕上两行、导出三行」，正是「排版规则只能有一份」
         * 这条红线被破坏的样子。
         *
         * 改法：把 `l.lines` 用**显式换行**拼起来，再 `white-space: pre`
         * 关掉浏览器自己的折行。断点完全由排版源决定。
         *
         * 为什么不拆成多个 span：拆开会让**跨行选中/复制**断掉
         * （拖选一段多行批注只能选中一行）。单 span + 显式 \n 既锁死
         * 断点，又保住整段文字的可选性。
         */
        const l = this.textLayout(t);
        content = l.lines.join("\n");
        el.style.whiteSpace = "pre";
        el.style.left = `${l.x}px`;
        el.style.top = `${l.y}px`;
        el.style.width = `${l.width}px`;
        el.style.lineHeight = String(TEXT_LINE_HEIGHT);
        el.style.transform = `translateY(-${0.82 + (TEXT_LINE_HEIGHT - 1) / 2}em)`;
        /*
         * 纵向装不下时的可见提示（INK-192）：被裁掉的行不能**静默**消失，
         * 在可见文字块下方挂一条「还有 N 行未显示」。
         *
         * 为什么不把提示拼进 span 的 textContent：那样在阅读模式拖选/复制时
         * 会把这句 UI 文案混进原文，违反「一个字都不能少/多」。用独立元素 +
         * `user-select:none` 才能既看得见又不污染数据。
         * 徽标只挂在屏幕上：导出 PDF / 嵌入图没有 DOM，那两处按同一份
         * `l.lines` 裁行，原文仍在 PageText.text 里（数据不丢）。
         * 位置按最后一行的基线再往下 half 个行高；上限减 24 是因为
         * .mb-textlayer 有 overflow:hidden，徽标自身约 17px 高，顶到
         * 纸底再画会被裁掉半截——「看得见的提示」不能被裁。
         */
        if (l.hidden && l.hidden > 0) {
          const more = document.createElement("span");
          more.className = "mb-text-more";
          more.textContent = `还有 ${l.hidden} 行未显示`;
          more.style.left = `${l.x}px`;
          more.style.top = `${Math.min(
            this.store.data.height - 24,
            l.y + (l.lines.length - 1) * l.lineHeight + l.lineHeight * 0.5
          )}px`;
          layer.appendChild(more);
        }
      }
      if (t.source === "user" && !this.findQuery) {
        this.fillUserTextWithLinks(el, content);
      } else {
        this.fillTextSpanContent(el, content, rec.index, t);
      }
      layer.appendChild(el);
    }
    /*
     * 有命中时整层与画布正片叠底：浅色高光只染白纸，canvas 上导入文档的
     * 深色字仍透在最上面（视觉上就是「高光在文字底下」）。文字层带 transform，
     * 合成组必须挂 class 到这一层；挂在单个 <mark> 上碰不到下面的 canvas。
     */
    layer.classList.toggle("has-find-hits", !!layer.querySelector("mark.mb-find-hit"));
  }

  /**
   * 把用户批注的文字写进 span，并把其中的 `[[双链]]` 包成可点击的
   * `<span class="mb-wikilink">`（强调色 + 下划线，见 styles.css）。
   *
   * 为什么不用 innerHTML：链接目标来自用户任意输入，拼字符串会既破坏排版
   * 又落入 XSS。这里只用 createTextNode / createElement，纯文本进文本节点。
   *
   * 文字层整体 `pointer-events: none`（写字要穿透），只给链接 span 单独
   * `pointer-events: auto`：其余文字照常穿透给画布，链接才接得到点击。
   * 链接 span 的 pointerdown 必须 stopPropagation，否则会冒泡到 docEl 的
   * 委托、被当成落笔/选择。
   */
  private fillUserTextWithLinks(el: HTMLElement, content: string): void {
    const links = findWikiLinks(content);
    if (!links.length) {
      el.textContent = content;
      return;
    }
    el.textContent = "";
    let cursor = 0;
    for (const link of links) {
      if (link.start > cursor) {
        el.appendChild(document.createTextNode(content.slice(cursor, link.start)));
      }
      const a = document.createElement("span");
      a.className = "mb-wikilink";
      // 像原生 Obsidian：非编辑态隐藏两边的 [[ ]]，只显示链接文字（有别名的用别名）；
      // 编辑态是输入框里的原文，仍保留完整 [[...]] 语法。
      a.textContent = link.display;
      a.dataset.wikilinkHref = link.href;
      if (link.page != null) a.dataset.wikilinkPage = String(link.page);
      a.title = `打开笔记：${link.label}`;
      a.addEventListener("pointerdown", (e) => {
        // 别让画布把手势判成落笔 / 选择
        e.stopPropagation();
      });
      a.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const page = a.dataset.wikilinkPage ? Number(a.dataset.wikilinkPage) : undefined;
        const newTab = !!(e.metaKey || e.ctrlKey || e.button === 1);
        this.openWikiLink(a.dataset.wikilinkHref || "", page, newTab);
      });
      el.appendChild(a);
      cursor = link.end;
    }
    if (cursor < content.length) {
      el.appendChild(document.createTextNode(content.slice(cursor)));
    }
  }

  /** 转发给 view：解析 + 打开目标笔记。解析依赖 app / 本子路径，放在 view 更合适。 */
  private openWikiLink(href: string, page: number | undefined, newTab: boolean): void {
    if (this.opts.onOpenWikiLink) this.opts.onOpenWikiLink(href, page, newTab);
  }

  /**
   * 「插入双链」：把一个 `[[名字]]` 插到正在编辑的输入框光标处；
   * 没有打开的输入框时，在当前页新建一个文字框并写入。
   *
   * 只在用户从「插入双链」选择器选了目标后调用；手动直接打 `[[...]]`
   * 也走同一条渲染/点击链路，不需要这个入口。
   */
  insertWikiLink(name: string): void {
    const clean = String(name ?? "").trim();
    if (!clean) return;
    const snippet = `[[${clean}]]`;
    const ed = this.textEdit;
    if (ed) {
      const ta = ed.el;
      ta.focus();
      const v = ta.value;
      const s = typeof ta.selectionStart === "number" ? ta.selectionStart : v.length;
      const e = typeof ta.selectionEnd === "number" ? ta.selectionEnd : s;
      ta.value = v.slice(0, s) + snippet + v.slice(e);
      const pos = s + snippet.length;
      try {
        ta.setSelectionRange(pos, pos);
      } catch (_) {
        /* 某些 WebView 上 setSelectionRange 偶发抛错，忽略即可 */
      }
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const rec = this.recs[this.current];
    if (!rec || !rec.mounted) return;
    const px = Math.min(this.store.data.width * 0.1, maxTextStartX(this.store.data.width));
    const py = this.textSizeValue * 1.2 + 16;
    this.beginTextEdit(rec, px, py, { initialText: snippet });
  }

  /* ---------------- `[[` 链接自动补全（类原生 Obsidian） ---------------- */

  /** 编辑框输入变化 / 光标移动后，重新判断要不要弹、弹哪些候选。 */
  private updateLinkSuggest(ta: HTMLTextAreaElement): void {
    if (!this.opts.getLinkTargets || this.textEditComposing) {
      this.hideLinkSuggest();
      return;
    }
    const value = ta.value;
    const caret = typeof ta.selectionStart === "number" ? ta.selectionStart : value.length;
    const before = value.slice(0, caret);
    // 从光标往回找最近的 `[[`；它到光标之间若是 `]]`、换行、`|`、`#`，
    // 说明这段双链已经写完或在改别名/锚点，不再弹候选，别打断输入。
    const open = before.lastIndexOf("[[");
    if (open < 0) {
      this.hideLinkSuggest();
      return;
    }
    const inner = before.slice(open + 2);
    if (/[\]\n|#]/.test(inner)) {
      this.hideLinkSuggest();
      return;
    }
    // `[[` 前还紧贴一个 `[`（如 `[[[`）不算双链起点
    if (open > 0 && before[open - 1] === "[") {
      this.hideLinkSuggest();
      return;
    }
    const query = inner.trim().toLowerCase();
    let all = this.linkTargetsCache;
    if (all === null) {
      try {
        all = this.opts.getLinkTargets() || [];
      } catch (_) {
        all = [];
      }
      this.linkTargetsCache = all;
    }
    const items = (
      query
        ? all.filter(
            (t) => t.label.toLowerCase().includes(query) || t.name.toLowerCase().includes(query)
          )
        : all
    ).slice(0, 60);
    this.linkSuggestStart = open;
    this.linkSuggestAnchor = ta;
    this.linkSuggestItems = items;
    // 每次输入变化都回到第一项（过滤后旧的选中位置已无意义）
    this.linkSuggestIndex = 0;
    this.renderLinkSuggest();
  }

  /** 补全列表当前是否展开（键盘处理用）。 */
  private linkSuggestOpen(): boolean {
    return !!this.linkSuggestEl;
  }

  private renderLinkSuggest(): void {
    const ta = this.linkSuggestAnchor;
    if (!ta) {
      this.hideLinkSuggest();
      return;
    }
    let el = this.linkSuggestEl;
    if (!el) {
      el = document.createElement("div");
      el.className = "mb-link-suggest";
      el.setAttribute("data-mb-link-suggest", "");
      el.setAttribute("role", "listbox");
      document.body.appendChild(el);
      this.linkSuggestEl = el;
      this.installLinkSuggestReposition();
    }
    el.textContent = "";
    const items = this.linkSuggestItems;
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "mb-link-suggest-empty";
      empty.textContent = "没有匹配的笔记";
      el.appendChild(empty);
    } else {
      items.forEach((t, i) => {
        const row = document.createElement("div");
        row.className = "mb-link-suggest-item";
        row.setAttribute("role", "option");
        /*
         * 点候选时不能让输入框失焦提交（blur → commit 会把编辑框和候选一起拆掉），
         * 否则点击根本落不到 click 上。
         *
         *   · pointerdown 只 stopPropagation：别让画布把手势当落笔；
         *   · mousedown 才 preventDefault：桌面端保住 textarea 焦点，且 click 照常触发。
         * 不用 pointerdown.preventDefault —— 平板上它可能把后续 click 一并取消，
         * 主场景反而点不中。
         */
        row.addEventListener("pointerdown", (e) => e.stopPropagation());
        row.addEventListener("mousedown", (e) => e.preventDefault());
        const name = document.createElement("span");
        name.className = "mb-link-suggest-name";
        name.textContent = t.label;
        const kind = document.createElement("span");
        kind.className = "mb-link-suggest-kind";
        kind.textContent = t.kind === "inkbook" ? "手写本" : "笔记";
        row.appendChild(name);
        row.appendChild(kind);
        row.title = t.path;
        row.addEventListener("mousemove", () => {
          if (this.linkSuggestIndex !== i) {
            this.linkSuggestIndex = i;
            this.syncLinkSuggestActive();
          }
        });
        row.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.applyLinkSuggestion(ta, t);
        });
        el!.appendChild(row);
      });
    }
    this.syncLinkSuggestActive();
    this.positionLinkSuggest();
  }

  private syncLinkSuggestActive(): void {
    const el = this.linkSuggestEl;
    if (!el) return;
    const rows = el.querySelectorAll<HTMLElement>(".mb-link-suggest-item");
    rows.forEach((row, i) => {
      const on = i === this.linkSuggestIndex;
      row.classList.toggle("is-active", on);
      row.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  /** 候选列表贴着输入框显示：优先在下方，放不下就翻到上方。 */
  private positionLinkSuggest(): void {
    const el = this.linkSuggestEl;
    const ta = this.linkSuggestAnchor;
    if (!el || !ta || !ta.isConnected) return;
    const r = ta.getBoundingClientRect();
    const gap = 4;
    const w = Math.max(200, Math.min(340, Math.max(r.width, 200)));
    el.style.width = `${Math.round(w)}px`;
    let left = r.left;
    const maxLeft = window.innerWidth - w - 8;
    if (left > maxLeft) left = maxLeft;
    if (left < 8) left = 8;
    const h = el.offsetHeight;
    let top = r.bottom + gap;
    if (top + h > window.innerHeight - 8) {
      const above = r.top - h - gap;
      top = above >= 8 ? above : Math.max(8, window.innerHeight - h - 8);
    }
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  private installLinkSuggestReposition(): void {
    if (this.linkSuggestReposition) return;
    const fn = () => this.positionLinkSuggest();
    this.linkSuggestReposition = fn;
    this.scrollEl.addEventListener("scroll", fn, { passive: true });
    window.addEventListener("resize", fn);
    // 捕获阶段：Obsidian 里滚动容器可能不是 scrollEl，捕获能兜住内层滚动
    window.addEventListener("scroll", fn, true);
  }

  private removeLinkSuggestReposition(): void {
    const fn = this.linkSuggestReposition;
    if (!fn) return;
    this.linkSuggestReposition = null;
    this.scrollEl.removeEventListener("scroll", fn);
    window.removeEventListener("resize", fn);
    window.removeEventListener("scroll", fn, true);
  }

  private hideLinkSuggest(): void {
    this.removeLinkSuggestReposition();
    this.linkSuggestEl?.remove();
    this.linkSuggestEl = null;
    this.linkSuggestItems = [];
    this.linkSuggestIndex = 0;
    this.linkSuggestStart = -1;
    this.linkSuggestAnchor = null;
  }

  /** 键盘上下移动时把高亮项滚进可视区。 */
  private moveLinkSuggest(delta: number): void {
    const n = this.linkSuggestItems.length;
    if (!n) return;
    this.linkSuggestIndex = (this.linkSuggestIndex + delta + n) % n;
    this.syncLinkSuggestActive();
    const el = this.linkSuggestEl;
    const active = el?.querySelector<HTMLElement>(".mb-link-suggest-item.is-active");
    active?.scrollIntoView({ block: "nearest" });
  }

  /**
   * 选中一个候选：把光标所在的 `[[查询` 替换成 `[[链接名]]`。
   *
   * 若光标后已经跟着 `]]`（用户在括号中间选），一并吃掉，避免变成 `]]]]`。
   */
  private applyLinkSuggestion(ta: HTMLTextAreaElement, target: LinkTarget): void {
    const start = this.linkSuggestStart;
    if (start < 0) return;
    const value = ta.value;
    const caret = typeof ta.selectionStart === "number" ? ta.selectionStart : value.length;
    let end = caret;
    if (value.slice(end, end + 2) === "]]") end += 2;
    else if (value.slice(end, end + 1) === "]") end += 1;
    const snippet = `[[${target.name}]]`;
    ta.value = value.slice(0, start) + snippet + value.slice(end);
    const pos = start + snippet.length;
    ta.focus();
    try {
      ta.setSelectionRange(pos, pos);
    } catch (_) {
      /* 某些 WebView 上 setSelectionRange 偶发抛错，忽略即可 */
    }
    this.hideLinkSuggest();
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /**
   * 往一个文字 span 里写内容；正在「笔记内查找」时把命中处包成 `<mark>`。
   *
   * 用 textContent / 文本节点拼，而不是 innerHTML：查询词和原文都可能带
   * `<`、`&`，拼字符串会既破坏排版又落入 XSS。`<mark>` 只影响外观，
   * 复制、拖选、导出都不读它（导出走 canvas / pdf-lib 重画）。
   *
   * PDF / Word 原文是**透明字**（视觉由底图承担），CSS 里对这一种 mark
   * 也保持透明，只留底色。整层用正片叠底把底色放到视觉字后面，既不会
   * 把底图上的字重影成黑字，也不会遮住它们。
   *
   * `content` 是屏幕上真正显示的那串字：用户批注被 `wrapText` 插过换行，
   * 与 `t.text` 的字符下标不一定一一对应。所以「当前命中」按**第几个**
   * 出现来认（数原文里排在它前面的命中数），而不是直接拿 start 去切
   * 屏幕字符串——这样跨折行的命中也能稳定对上。
   */
  private fillTextSpanContent(
    el: HTMLElement,
    content: string,
    pageIndex: number,
    t: PageText
  ): void {
    const query = this.findQuery;
    if (!query) {
      el.textContent = content;
      return;
    }
    const ranges = findInText(content, query);
    if (!ranges.length) {
      el.textContent = content;
      return;
    }
    let activeOrdinal = -1;
    const hit = this.findHit;
    if (hit && hit.page === pageIndex && hit.textId === t.id) {
      activeOrdinal = countMatchesBefore(t.text, query, hit.start);
    }
    el.textContent = "";
    let cursor = 0;
    ranges.forEach((r, i) => {
      if (r.start > cursor) el.appendChild(document.createTextNode(content.slice(cursor, r.start)));
      const mark = document.createElement("mark");
      mark.className = "mb-find-hit" + (i === activeOrdinal ? " is-active" : "");
      mark.textContent = content.slice(r.start, r.end);
      el.appendChild(mark);
      cursor = r.end;
    });
    if (cursor < content.length) el.appendChild(document.createTextNode(content.slice(cursor)));
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
        // PDF 文字抽完会让签名变化：旧缓存作废，快滑中则并进末尾的一次性补画。
        this.invalidateTextLayerCache();
        if (live?.mounted) {
          if (this.isFastScrolling()) this.deferredTextLayers.add(live);
          else this.renderTextLayer(live);
        }
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
    width?: number;
  }): TextLayout {
    const ctx = measureContext(this.textFontCss(t));
    if (!ctx) {
      // 没有离屏 canvas 时也要返回同一套宽度语义，否则退化路径和正常路径会折得不一样
      const lines = String(t.text ?? "").split("\n");
      const custom = Number.isFinite(t.width) ? (t.width as number) : 0;
      const boxW = custom > 0 ? Math.max(custom, MIN_BOX_WIDTH) : 0;
      // x 的夹取也跟 layoutUserText 同一套（窄框按框宽留白、能贴到纸右缘）
      const x = reserveTextX(this.store.data.width, t.x, boxW);
      const avail = availableTextWidth(this.store.data.width, x);
      const width = boxW > 0 ? Math.min(boxW, avail) : avail;
      // hidden: 0 —— 这条退化路径量不了宽、也就排不了版，谈不上裁行；
      // 补上字段只为让返回类型和正常路径一致（调用方统一读 l.hidden）
      return { x, y: t.y, lines, lineHeight: t.size * TEXT_LINE_HEIGHT, width, hidden: 0 };
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
    /*
     * 导入来源（PDF 原文 / Word 正文）带的是排版时的真实行宽，
     * 比重新量一遍准（也省一次测量）。Word 的行宽来自 layout()，
     * 与底图上画出来的字严格同源。
     */
    if (t.source !== "user" && t.width) return t.width;
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

    /*
     * 改宽手柄必须先判：它落在文字命中框的 +8 容差里，
     * 不先判就会被当成「拖动文字」，宽度永远拖不动。
     * 命中半径按屏幕 10px 反算（照顾手指），与画出来的 6px 分开。
     */
    const sel0 = this.selectedText;
    // 捏合期间不认手柄：双指第一根落下的位置可能正好压在柄上，
    // 一旦起 resizeText 手势，会和 beginPinch 抢 pointerId
    if (sel0 && !this.pinchActive) {
      const g = this.textSelGeom(sel0);
      const hitR = 10 / this.zoom;
      if (Math.hypot(px - g.handleX, py - g.handleY) <= hitR) {
        const l = this.textLayout(sel0);
        this.gesture = "resizeText";
        this.pointerId = e.pointerId;
        // 起点取排版后的有效宽：老数据没有 width 字段，取 t.width 会是 undefined
        this.resizeText = {
          rec,
          id: sel0.id,
          startX: px,
          originW: l.width,
          moved: false,
        };
        try {
          rec.pageEl.setPointerCapture?.(e.pointerId);
        } catch (_) {}
        e.preventDefault();
        return;
      }
    }

    /*
     * 形状缩放手柄：选中形状后，四角/四边的手柄优先级最高，
     * 否则它们会被「拖动形状」的包围盒命中吃掉，永远拉不动大小。
     */
    const shape0 = this.selectedShape;
    if (shape0 && !this.pinchActive) {
      const b = this.shapeSelBox(shape0);
      const h = this.hitShapeHandle(b, px, py, 10 / this.zoom);
      if (h) {
        this.beginShapeGesture(rec, shape0, px, py, e, h);
        return;
      }
    }

    /*
     * 图片缩放角手柄：选中图片后优先级最高，否则会被「拖动图片」的
     * 矩形命中吃掉，角手柄永远拉不动。
     */
    const img0 = this.selectedImage;
    if (img0 && !this.pinchActive) {
      const b = this.imageSelBox(img0);
      const h = this.hitImageHandle(b, px, py, 10 / this.zoom);
      if (h) {
        this.beginImageGesture(rec, img0, px, py, e, h);
        return;
      }
    }

    const hit = this.hitText(page.texts ?? [], px, py);

    if (hit) {
      // 选中文字时清掉形状选择（两者互斥，避免两个选框同时出现）
      this.selectShape(null);
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
      return;
    }

    /*
     * 已经选中某个形状，且点还在它的选框内 → 直接拖动这个形状。
     * 这样选中后随手一拖就能移动，不用精确点回边线上。
     */
    if (shape0 && !this.pinchActive) {
      const b = this.shapeSelBox(shape0);
      const pad = 6 / this.zoom;
      if (px >= b.minX - pad && px <= b.maxX + pad && py >= b.minY - pad && py <= b.maxY + pad) {
        this.selectText(null);
        this.beginShapeGesture(rec, shape0, px, py, e, null);
        return;
      }
    }

    // 命中一个形状 → 选中并开始拖动
    const shapeHit = this.hitShape(page, px, py);
    if (shapeHit) {
      this.selectText(null);
      this.selectImage(null);
      this.selectShape(shapeHit.id);
      this.beginShapeGesture(rec, shapeHit, px, py, e, null);
      return;
    }

    // 命中一张图片 → 选中并开始拖动
    const imgHit = this.hitImage(page, px, py);
    if (imgHit) {
      this.selectText(null);
      this.selectShape(null);
      this.selectImage(imgHit.id);
      this.beginImageGesture(rec, imgHit, px, py, e, null);
      return;
    }

    // 点空白：取消所有选中
    this.selectText(null);
    this.selectShape(null);
    this.selectImage(null);
  }

  /**
   * 文字工具下点了一下页面。
   *
   * 三种情况，按"最不容易误操作"排序：
   *   · 点在空白处 → 取消选中，直接开一个新输入框（这是最常见的动作）
   *   · 点在没选中的文字上 → **只选中**，浮出属性条（改字号/字体/颜色/删除）
   *   · 点在已选中的文字上 → 进入编辑（第二下才是改内容，避免一点就弹框）
   */
  private handleTextPointer(rec: PageRec, px: number, py: number, e?: PointerEvent): void {
    if (this.readOnly) return;
    const page = this.store.data.pages[rec.index];
    if (!page) return;
    // 改宽手柄优先（和「选择」工具一致）：文字工具下选中文字后也能拖圆点改宽
    const sel0 = this.selectedText;
    if (sel0 && e && !this.pinchActive) {
      const g = this.textSelGeom(sel0);
      const hitR = 10 / this.zoom;
      if (Math.hypot(px - g.handleX, py - g.handleY) <= hitR) {
        const l = this.textLayout(sel0);
        this.gesture = "resizeText";
        this.pointerId = e.pointerId;
        this.resizeText = { rec, id: sel0.id, startX: px, originW: l.width, moved: false };
        try {
          rec.pageEl.setPointerCapture?.(e.pointerId);
        } catch (_) {}
        e.preventDefault();
        return;
      }
    }
    const hit = this.hitText(page.texts ?? [], px, py);

    if (!hit) {
      this.selectText(null);
      /*
       * 已经有一个输入框开着时，点纸面空白**只提交、不再新建**。
       *
       * 旧行为是「提交旧框 → 又在落点弹一个新框」，用户想结束输入就得
       * 再点一次，越点框越多（真机反馈：文字工具在平板上「点不出去」）。
       * 现在：第一次点空白新建，之后点空白就是「写完了，收起」。
       */
      if (this.textEdit) {
        this.commitTextEdit(true);
        return;
      }
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

  private beginTextEdit(
    rec: PageRec,
    px: number,
    py: number,
    opts?: { initialText?: string }
  ): void {
    if (this.readOnly) return;
    this.commitTextEdit();
    // 新的编辑会话：重新取一次库文件清单（编辑期间可能新建了笔记）
    this.linkTargetsCache = null;
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
    /*
     * 空框提示「请输入」：用原生 placeholder，输入第一个字就自动消失，
     * 而且永远不会混进 value（提交时不需要额外过滤）。
     * 它的字号/颜色继承 textarea 的当前样式，正好用来预览。
     */
    ta.placeholder = "请输入";
    ta.value = opts?.initialText != null ? opts.initialText : hit?.text ?? "";
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
    // 可折行宽度取排版结果：手动拖窄过的批注，编辑框要跟框一样窄，
    // 否则框里断字的位置和提交后的渲染对不上（INK-116 的老坑）。
    const avail = layout.width;
    /*
     * 新建和改已有文字都用同一个宽度：排版结果的 l.width。
     *
     * 新建时不再把框宽封顶到 320（旧的 TEXT_EDIT_WIDTH）：新建文字落盘时
     * **不写 width**，渲染/导出都按 availableTextWidth 折行；框里却按 320 折，
     * 于是「框里看着 4 行、提交后按纸宽变成 2 行」，位置全跳了（INK-193）。
     * 现在框宽 = 折行宽 = 落盘后的渲染宽，三者同源。
     *
     * 「太宽顶到纸边」不用担心：l.width 来自 availableTextWidth，右缘已经
     * 留了 TEXT_RIGHT_MARGIN、物理上不会出纸——旧上限想防的事它本来就防住了。
     */
    const wantW = avail;
    ta.style.width = `${wantW * this.zoom + TEXT_EDIT_CHROME}px`;
    rec.pageEl.appendChild(ta);

    this.textEdit = { rec, el: ta, id: hit?.id ?? null, x, y, size, color, font };
    // 组字状态跟着新输入框复位，上一框遗留的 pending 不能带到这一框
    this.textEditComposing = false;
    this.textEditValueBeforeComp = ta.value;
    this.textEditCommitPending = false;
    /*
     * IME 组字跟踪：组字期间 value 里有还没上屏的拼音，提交它等于把
     * 半个词写死。记下组字前的值，作为「等不到 compositionend 的强制
     * 离开」（销毁 / pagehide）时的兜底；如果只是暂时失焦 / 切后台，
     * 则挂起提交，等 compositionend 把词真正上屏后再补交。
     */
    ta.addEventListener("compositionstart", () => {
      this.textEditComposing = true;
      this.textEditValueBeforeComp = ta.value;
    });
    ta.addEventListener("compositionend", () => {
      this.textEditComposing = false;
      this.textEditValueBeforeComp = ta.value;
      if (this.textEditCommitPending) {
        this.textEditCommitPending = false;
        this.commitTextEdit(true);
      }
    });
    /*
     * 新键才给就近样式条：用户要先定字号/颜色再打字。
     * 改已有文字走的是选中属性条（.mb-textbar），这里不再叠一条。
     */
    if (!hit) this.syncTextEditBar();

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
      /*
       * 中文/日文输入法选词时按回车，浏览器会先发一个 isComposing=true
       * （或 keyCode 229）的 keydown。这时提交会把「候选词还没上屏」的内容
       * 当成最终文字写进本子，用户看到的是「词只打了一半就固定了」。
       * 组字期间一律放行给 IME，等 compositionend 之后再判回车。
       */
      const composing = (e as any).isComposing || e.keyCode === 229;
      if (composing) return;
      /*
       * `[[` 补全展开时，方向键 / Enter / Tab / Esc 先归候选列表：
       * 否则回车会把编辑框直接提交，Esc 会关掉编辑框而不是收起列表。
       */
      if (this.linkSuggestOpen()) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this.moveLinkSuggest(1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          this.moveLinkSuggest(-1);
          return;
        }
        // Shift+Enter 保留为换行，不抢去选候选
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          if (this.linkSuggestItems.length) {
            e.preventDefault();
            e.stopPropagation();
            const t = this.linkSuggestItems[this.linkSuggestIndex];
            if (t) this.applyLinkSuggestion(ta, t);
            return;
          }
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this.hideLinkSuggest();
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        finish(true);
      }
    });
    /*
     * 点字号/字体/颜色这些「文字样式控件」时**不能提交**：
     * 用户是在「先选样式、再输入」，空框一提交就等于把框关掉。
     *
     * 判定用 pointerdown 捕获阶段的标记，**不用 blur 的 relatedTarget**：
     * iPad WKWebView 上点 button/select 常常不转移焦点（relatedTarget=null），
     * 用 relatedTarget 会在平板主场景失效。pointerdown 一定先于 blur 到达。
     * 点其它任何地方（画布、导出、撤销、窗口外）标记为 false，照常提交。
     */
    this.textEditStylePress = false;
    const markStylePress = (ev: PointerEvent) => {
      const el = ev.target as HTMLElement | null;
      this.textEditStylePress = !!el?.closest?.(
        "[data-mb-text-style], [data-mb-link-suggest]"
      );
    };
    document.addEventListener("pointerdown", markStylePress, true);
    this.textEditPointerHandler = markStylePress;

    ta.addEventListener("blur", () => {
      if (this.textEditStylePress) {
        this.textEditStylePress = false;
        return;
      }
      /*
       * 走 commitTextEditNow：组字中（拼音还没上屏）先挂起，
       * 等 compositionend 再提交，别把半截拼音写进本子。
       */
      this.commitTextEditNow();
    });
    // 高度跟着内容长，别让两行字挤在一行的高度里
    ta.addEventListener("input", () => {
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
      // 输入内容变化时重判 `[[` 补全（继续打字即过滤候选）
      this.updateLinkSuggest(ta);
    });
    // 鼠标 / 手指点了输入框内某处，光标可能移到别的位置：重新判断触发区间
    ta.addEventListener("click", () => this.updateLinkSuggest(ta));

    requestAnimationFrame(() => {
      ta.focus();
      /*
       * 编辑已有文字：光标放末尾，别 ta.select() 全选——
       * 用户点开旧批注只是想补一句，一打字就把整段覆盖掉是最恼人的。
       * 新建空框无所谓（没有内容可选），保持全选行为一致。
       */
      if (opts?.initialText != null) {
        // 插入双链新建的框：光标放到片段末尾，别全选（否则一按键盘就把链接覆盖掉）
        const end = ta.value.length;
        ta.setSelectionRange(end, end);
      } else if (hit) {
        const end = ta.value.length;
        ta.setSelectionRange(end, end);
      } else {
        ta.select();
      }
      ta.style.height = `${ta.scrollHeight}px`;
      this.keepTextEditVisible(ta);
    });
  }

  /**
   * 把输入框滚进「软键盘上方」的可见区（2026-11-08，平板专项）。
   *
   * 平板上点纸张下半部分写字时，软键盘会盖住屏幕下 1/3 —— 输入框
   * 正好落在被盖住的位置，用户看不见自己在打什么。浏览器不会自动
   * 帮我们滚（滚动容器是我们自己的 div，不是 document）。
   *
   * 用 visualViewport 拿**真实可视高度**：键盘弹出后它才变小，
   * 比 window.innerHeight 准。拿不到时（老 WebView）退回 clientHeight。
   * 键盘动画有 200~300ms，所以在 focus 后多补两次。
   */
  private keepTextEditVisible(ta: HTMLTextAreaElement): void {
    const reveal = () => {
      if (this.destroyed || this.textEdit?.el !== ta) return;
      const vv = window.visualViewport;
      const visibleBottom = vv ? vv.height + vv.offsetTop : this.scrollEl.clientHeight;
      const taRect = ta.getBoundingClientRect();
      const scrollRect = this.scrollEl.getBoundingClientRect();
      // 输入框底边超出可视区多少（>0 就是被键盘/屏幕底边盖住）
      const overflow = taRect.bottom - visibleBottom + 24;
      if (overflow > 0) {
        this.scrollEl.scrollTop += overflow;
      }
      // 顶边跑到可视区上方（滚动补偿过头时）也拉回来
      const above = scrollRect.top - taRect.top + 8;
      if (above > 0) this.scrollEl.scrollTop -= above;
      // 样式条跟着重定位：它按纸面坐标算，scrollTop 变了屏幕位置也变了
      this.positionTextEditBar();
    };
    reveal();
    window.setTimeout(reveal, 120);
    window.setTimeout(reveal, 320);
  }

  /** 拆掉编辑框期间挂的 document 级 pointerdown 监听 */
  private detachTextEditStyleWatcher(): void {
    if (this.textEditPointerHandler) {
      document.removeEventListener("pointerdown", this.textEditPointerHandler, true);
      this.textEditPointerHandler = null;
    }
    this.textEditStylePress = false;
  }

  /**
   * 外部动作（导出 / 撤销 / 翻页 / 切后台 / 失焦 / 切文件 / 销毁）前，
   * 把编辑框里还没提交的文字落库。
   *
   * 移动端点按钮不一定触发 blur，光靠 blur 提交会漏字（导出少一段）。
   *
   * @param force 组字中也立刻提交。未上屏的拼音会被丢弃，只写
   *              compositionstart 之前已经上屏的内容——用于销毁 / pagehide
   *              这类「等不到 compositionend 了」的最后时刻。
   */
  commitTextEditNow(force = false): void {
    if (!this.textEdit) return;
    if (this.textEditComposing) {
      if (!force) {
        // 词还没上屏：先挂起，compositionend 时由监听器补交
        this.textEditCommitPending = true;
        return;
      }
      /*
       * 不能等 compositionend（销毁 / 关页）：交给 commitTextEdit
       * 只取组字前的值，绝不把 textarea.value 里的半截拼音写进去。
       */
    }
    this.commitTextEdit(true);
  }

  /**
   * 收掉编辑框。save=false 用于 Esc / 页面被卸载时丢弃。
   *
   * 组字中提交时只写组字开始前的内容：任何「收框」动作都无法让 IME
   * 继续组字，写半截拼音比丢掉这次未上屏的输入更糟。
   */
  private commitTextEdit(save = true): void {
    // 提交 / Esc / 翻页重建时，候选列表与输入框同生共死，不能留下孤儿节点
    this.hideLinkSuggest();
    this.linkTargetsCache = null;
    // 样式条与输入框同生共死：提交、Esc、翻页重建都不能留下孤儿节点
    this.textEditBarEl?.remove();
    this.textEditBarEl = null;
    /*
     * 样式条上的步进按钮也一起停手：DOM 已移除，按住中的 pointerup
     * 等不到，timer 会继续对已关闭的编辑框步进直到用户松手。
     */
    for (const stop of this.stepBtnStoppers) stop();
    this.stepBtnStoppers = [];
    const ed = this.textEdit;
    if (!ed) return;
    /*
     * 先取内容再清状态：组字中 value 里是未上屏的拼音，
     * 只提交 compositionstart 之前已经上屏的部分。
     */
    const raw = this.textEditComposing ? this.textEditValueBeforeComp : ed.el.value;
    this.textEdit = null;
    this.textEditComposing = false;
    this.textEditValueBeforeComp = "";
    this.textEditCommitPending = false;
    this.detachTextEditStyleWatcher();
    const value = raw.replace(/\s+$/g, "");
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
      /*
       * 新建文字**不写 width**（INK-193）。编辑框的宽度已经按
       * availableTextWidth 打开（见 beginTextEdit），落盘后渲染/导出/嵌入
       * 也各自从同一个 availableTextWidth 折行，三处自然一致；
       * 这里再补一个 width 反而把新批注永久钉在某个宽度上。
       * 只有用户手动拖过框宽时才由 resizeText 写 width（INK-121）。
       */
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
    /*
     * 文字装不下时提示用户（INK-192）。
     *
     * 排版层会把超出行数的部分裁掉（不裁就是溢出纸外被静默裁掉，
     * 三处一致地"字不见了"）。原文一个字没丢，但用户看不到就得告诉他，
     * 否则他会以为字打丢了。
     * 提示里给可操作的建议：调小字号、把框拖宽，或者分到下一段。
     */
    const target = old ?? (page.texts ?? [])[(page.texts ?? []).length - 1];
    if (target) {
      const lay = this.textLayout(target);
      if (lay.hidden && lay.hidden > 0) {
        this.opts.onTextOverflow?.(lay.hidden);
      }
    }
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
        /*
         * 双链在非编辑态隐藏 `[[ ]]`（与屏幕 DOM 同一份显示规则），
         * 导出/缩略图/嵌入预览里也不会再冒出完整语法。画布只负责外观，
         * 原文字（含括号）仍完整存在 PageText.text 里。
         */
        ctx.fillText(stripWikiLinkSyntax(l.lines[i]), l.x, l.y + i * l.lineHeight);
      }
      ctx.restore();
    }
  }

  private scheduleOverlay(rec: PageRec): void {
    /*
     * 按页收集待重画，而不是只记一个 rec：鼠标从一页滑到另一页时
     * 同一帧里可能先排了旧页再排新页，旧实现 `if (overlayRaf) return`
     * 会把新页丢掉，圈就少画一帧。
     */
    this.overlayPending.add(rec.index);
    if (this.overlayRaf) return;
    this.overlayRaf = requestAnimationFrame(() => {
      this.overlayRaf = 0;
      const pages = [...this.overlayPending];
      this.overlayPending.clear();
      for (const i of pages) {
        const r = this.recs[i];
        if (r?.mounted) this.renderOverlay(r);
      }
    });
  }

  /**
   * 收掉橡皮圈，并把它原来所在页的 overlay 重画一次（否则残留像素擦不掉）。
   * @returns 圈原来在哪一页；没有圈时返回 -1
   */
  private clearEraserPos(): number {
    if (!this.eraserPos) return -1;
    const pageIndex = this.eraserPos.pageIndex;
    this.eraserPos = null;
    const rec = this.recs[pageIndex];
    if (rec) this.renderOverlay(rec);
    return pageIndex;
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
    const rawSmooth = this.opts.smoothing ?? 0.55;
    // 构造时直接传进来的 opts 也要兜住（不经过 setSmoothing 的那条路）
    const smooth = Number.isFinite(rawSmooth) ? clamp(rawSmooth, 0, 1) : 0.55;
    if (smooth <= 0.02) return raw;
    // 平滑强度映射到 1€ 滤波器的 minCutoff：越强越稳
    const minCutoff = 0.6 + (1 - smooth) * 3.4;
    /*
     * beta 乘 zoom 归一化因子：beta 的单位是「每单位速度」，
     * 而速度是页面坐标/秒。放大 2.8 倍时同一手速的页面速度只剩 1/3.5，
     * cutoff 跟着变低、滤波滞后从约 3px 涨到 9.5px（拐角被抹圆）。
     * 乘上因子等价于用屏幕速度调参，各缩放档手感一致。
     * 仍然只 configure 单实例，不 new。
     */
    this.smoother.configure(minCutoff, (0.012 + smooth * 0.05) * zoomNormalization(this.zoom), 1.0);
    const out = this.smoother.filter(raw[0], raw[1], e.timeStamp || performance.now());
    return [out.x, out.y, 0.5];
  }

  private pressureFor(e: PointerEvent, dist: number, dt: number): number {
    if (this.tool === "ballpoint") return 0.62;
    /*
     * 速度：页面单位 / 毫秒，再乘 zoom 归一化因子换成屏幕尺度。
     * 不归一化的话，同一手速在 2.8 倍下算出来的速度只有 0.8 倍的 1/3.5：
     * 快笔收窄失效（笔画偏粗约 21%）、鼠标虚拟压力也失真。
     */
    const speed = (dist / Math.max(1, dt)) * zoomNormalization(this.zoom);
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
    const rawSens = this.opts.pressure ?? 1;
    const sens = Number.isFinite(rawSens) ? clamp(rawSens, 0.3, 1.5) : 1;
    raw = shapePressure(raw, sens);

    /*
     * 经典手写应用 手写引擎 getPressureWidth 的 p^1.6 压感响应：轻的更轻、重的更重。
     * shapePressure 自身已做过一次对比拉伸，这里只按 0.3 权重混入，
     * 避免两次放大把中间调压扁；p=0.5 时系数恒为 1，平均粗细不变。
     */
    raw *= 0.7 + 0.3 * pressureResponse(raw);

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

  /* --------------------- 经典手写应用移植功能 --------------------- */

  /** 一笔成型开关：只有开 / 关两态（开 = 抬笔立刻识别） */
  setShapeSnap(mode: "off" | "lift"): void {
    this.shapeSnap = normalizeShapeSnap(mode);
  }

  /** 激光笔开关：关掉时把光迹与帧循环一起收干净 */
  setLaserPointer(on: boolean): void {
    this.laserOn = on;
    if (!on) {
      this.laserTrail = [];
      this.stopLaserFade();
      this.repaintOverlays();
    }
  }

  private repaintOverlays(): void {
    if (this.destroyed) return;
    for (const rec of this.recs) {
      if (rec.mounted) this.renderOverlay(rec);
    }
  }

  /** 激光笔光迹淡出：帧循环只在有迹可画时跑，结束后自动停 */
  private armLaserFade(): void {
    if (this.laserRaf) return;
    const step = () => {
      this.laserRaf = 0;
      if (this.destroyed) return;
      const now = performance.now();
      this.laserTrail = this.laserTrail.filter((p) => now - p.t < LASER_FADE_MS);
      // 拖动期间可能滑到相邻页：每帧按当前 laserPage 找 rec，别抓着旧的
      const rec = this.recs[this.laserPage];
      if (rec) this.renderOverlay(rec);
      if (this.laserTrail.length) this.laserRaf = requestAnimationFrame(step);
    };
    this.laserRaf = requestAnimationFrame(step);
  }

  private stopLaserFade(): void {
    if (this.laserRaf) cancelAnimationFrame(this.laserRaf);
    this.laserRaf = 0;
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
      // 阅读模式不画橡皮圈（CSS 也把光标还给用户了），把悬停圈收掉
      this.clearEraserPos();
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
    /*
     * 鼠标只处理左键(0) / 中键(1) / **右键(2)**。
     *
     * 右键 = 平移（2026-11-07 用户要求：放大后用右键拖界面）。
     * 其他键（侧键 3/4 等）仍然忽略。
     */
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1 && e.button !== 2) {
      return;
    }

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

    if (role === "ignore") return;
    if (role === "gesture") {
      e.preventDefault();
      return;
    }
    /*
     * 激光笔（经典手写应用移植）：只指示、不落墨，所以放在只读判定之前，
     * 也放在 pan 之前 —— 单指/单键都得能指一指，双指缩放仍然优先。
     * 不走 draft、不走 store、不走撤销栈，也不改 current 页。
     */
    if (
      this.laserOn &&
      this.gesture === "none" &&
      (e.pointerType !== "mouse" || e.button === 0)
    ) {
      e.preventDefault();
      this.pointerId = e.pointerId;
      this.gesture = "laser";
      this.laserPage = rec.index;
      const lp = this.pointFromEvent(e, rec);
      this.laserTrail = [{ x: lp[0], y: lp[1], t: performance.now() }];
      try {
        rec.pageEl.setPointerCapture(e.pointerId);
      } catch (_) {}
      this.armLaserFade();
      this.renderOverlay(rec);
      return;
    }
    if (role === "pan") {
      // 单指：默认滚动页面（touch-action 已放开）
      if (this.arbiter.touchCountNow >= 2) return;
      /*
       * **鼠标右键：直接平移，不参与任何「点一下做点什么」的分支**。
       *
       * 下面几个分支（文字工具弹输入框、选择工具选中）都是为「手指/左键
       * 点一下」设计的。右键按下的语义只有一个：拖动画面。放它进去会出现
       * 「右键拖动画布，结果在文字工具下弹出一个输入框」这种怪事。
       */
      if (e.pointerType === "mouse" && e.button === 2) {
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
       * 文字工具例外：平板上用手指点一下就该出输入框，
       * 不然"添加文字"在平板上等于不能用（手指只会滚动）。
       *
       * 但**已经有输入框开着**时就不这么干了：那一次触摸应该是
       * 「写完了，收起」——顺手还能滚动页面。以前手指一点就又弹一个新框，
       * 想滚也滚不动（真机反馈：文字工具在平板上「点不出去」）。
       */
      if (this.tool === "text" && !this.readOnly && !this.textEdit) {
        const p = this.pointFromEvent(e, rec);
        this.current = rec.index;
        this.store.setPage(rec.index);
        this.handleTextPointer(rec, p[0], p[1], e);
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
        /*
         * 已经有输入框开着时，这一指是「写完了、点掉输入框」。
         * 先提交再放行滚动——提交完这次触摸继续拖就是正常翻页，
         * 用户既收了尾又能顺手滚，不至于卡住。
         */
        if (this.textEdit && this.tool === "text") {
          this.commitTextEdit(true);
        }
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

    /*
     * 笔落时如果已经有一个「手指/掌根」起的 pan 在跑，**无条件收掉它再落笔**。
     *
     * 真机高频场景：手掌先贴到屏幕上（触屏把它判成 touch → 走 pan 滚动），
     * 紧接着笔尖落下。老代码在下面这行 `gesture !== "none"` 直接 return，
     * 于是**第一笔根本写不进去**，页面反而被掌根滚走 —— 用户感觉是
     * 「偶尔写不上字，纸还自己动」。
     *
     * 收掉 pan 的写法照 `beginPinch`：清 pointerId 与 pan 状态、把 gesture
     * 复位。笔才是真正要写的那根，掌根只是误触，所以笔有更高优先级。
     * 只收 "pan"：其他手势（pinch / draw / erase）不该被笔打断。
     */
    if (e.pointerType === "pen" && this.gesture === "pan") {
      this.stopFling();
      this.gesture = "none";
      this.pointerId = null;
      this.pan = null;
    }
    /*
     * 笔落下时也要收掉「正在拖文字框」的手势（INK-191）。
     *
     * 老代码只收 "pan"，`gesture === "moveText"` 会一路走到下面的
     * `if (this.gesture !== "none") return;` 被直接 return 掉——
     * 用户正用手指拖文字框、笔落下来想写字，**第一笔就丢了**。
     * 收尾方式和 pan 一样：停掉拖动、复位手势，让笔接管。
     * `moveText` 的位移已经实时写进 store，收掉不会丢内容。
     */
    if (e.pointerType === "pen" && this.gesture === "moveText") {
      this.moveText = null;
      this.gesture = "none";
      this.pointerId = null;
    }
    /*
     * 形状拖动/缩放同样可能被笔落下打断：先把这次拖动结算成一条撤销记录，
     * 再让笔接管去写字，否则 `gesture !== "none"` 会把第一笔丢掉。
     */
    if (
      e.pointerType === "pen" &&
      (this.gesture === "moveShape" || this.gesture === "resizeShape")
    ) {
      this.finishShapeEdit();
    }
    // 图片拖动/缩放被笔落下打断：同样先结算再让笔接管
    if (
      e.pointerType === "pen" &&
      (this.gesture === "moveImage" || this.gesture === "resizeImage")
    ) {
      this.finishImageEdit();
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
      this.handleTextPointer(rec, tp[0], tp[1], e);
      return;
    }

    if (this.tool === "select") {
      const sp = this.pointFromEvent(e, rec);
      this.handleSelectPointer(rec, sp[0], sp[1], e);
      return;
    }

    /*
     * 抓手 / 中键 / **右键** 都走平移。
     *
     * 右键拖动（2026-11-07 用户要求）：放大后纸比屏幕大，靠滚动条拖很别扭；
     * 鼠标用户习惯「按住右键拖画布」。中键早就是这个行为，右键补上即可。
     *
     * 配套：`contextmenu` 必须无条件 preventDefault（见 DOM 绑定处），
     * 否则右键一按就弹系统菜单，拖动根本开始不了。
     */
    if (
      this.tool === "hand" ||
      (e.pointerType === "mouse" && (e.button === 1 || e.button === 2))
    ) {
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
    // 每一笔都从干净的预测状态开始：滑窗、速度跟踪、预热计数全清。
    this.inkPredictor.reset();
    this.inkPredictor.setScale(zoomNormalization(this.zoom));
    const p = this.filteredPoint(e, rec);
    this.lastPoint = { x: p[0], y: p[1], t: e.timeStamp || performance.now() };
    this.lastPressure = null;
    this.lastSpeed = 0;
    this.undoPushed = false;
    // 用户开始操作 → 锚点失效
    this.lockedAnchor = null;
    // 新手势：清掉上一轮擦除的中间状态（层锁也要重置，见 erasingLayer）
    this.eraseBefore = null;
    this.eraseAfter = null;
    this.eraseLayer = null;

    if (this.tool === "eraser") {
      this.gesture = "erase";
      // 按下就画圈：半径和 eraseAt 用的同一个公式
      this.eraserPos = { x: p[0], y: p[1], r: this.eraserRadiusAt(e), pageIndex: rec.index };
      this.scheduleOverlay(rec);
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
        size: this.shapeSizes[this.shapeKind] ?? this.penSize,
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
      size: highlighter
        ? this.highlighterSize
        : ballpoint
          ? this.ballpointSize
          : this.penSize,
      opacity: highlighter ? 0.32 : 1,
      points: [[p[0], p[1], this.pressureFor(e, 0, 16)]],
    };
    if (!highlighter) {
      const first = this.draft.points[0];
      this.inkPredictor.push(first[0], first[1], e.timeStamp || performance.now(), first[2]);
    }
    this.scheduleOverlay(rec);
  }

  private onMove(e: PointerEvent, rec: PageRec): void {
    /* 激光笔：只往光迹里加页面坐标，别的分支一概不碰 */
    if (this.gesture === "laser" && e.pointerId === this.pointerId) {
      e.preventDefault();
      const lp = this.pointFromEvent(e, rec);
      this.laserPage = rec.index;
      this.laserTrail.push({ x: lp[0], y: lp[1], t: performance.now() });
      if (this.laserTrail.length > 240) this.laserTrail.shift();
      this.armLaserFade();
      this.renderOverlay(rec);
      return;
    }
    /* 拖动文字：每帧改坐标，重建文字层（文字条数很少，重建比逐节点改省心） */
    if (this.gesture === "moveText" && this.moveText) {
      /*
       * **只有发起这次拖动的那根指针能改文字位置**（INK-191）。
       *
       * `resizeText` 早就有这道自校验，`moveText` 漏了。缺了它的后果：
       * 手指正拖着文字框时笔落下来（笔的 pointerId 不同），笔的
       * pointermove 会走进这个分支把文本框拖着跑——用户看到的是
       * 「笔一落，文字框自己跳走了」，而且那一笔也画不出来。
       */
      if (e.pointerId !== this.pointerId) return;
      const m = this.moveText;
      const p = this.pointFromEvent(e, m.rec);
      const dx = p[0] - m.startX;
      const dy = p[1] - m.startY;
      if (!m.moved && Math.hypot(dx, dy) < 3) return;
      // 先判 target 再 snapshot（理由同 resizeText：别留悬挂的 pendingBefore）
      const target = this.store.data.pages[m.rec.index]?.texts?.find((t) => t.id === m.id);
      if (!target) return;
      if (!m.moved) {
        // 第一次真正拖动才记历史：点一下（没动）不该产生一条撤销
        this.store.snapshotPage(m.rec.index);
        m.moved = true;
      }
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
        width: target.width,
      });
      target.x = l.x;
      target.y = l.y;
      this.renderTextLayer(m.rec);
      this.renderOverlay(m.rec);
      this.positionTextBar();
      e.preventDefault();
      return;
    }

    /* 拖右下角手柄改宽度：一次拖动一条撤销，照抄 moveText 的骨架 */
    if (this.gesture === "resizeText" && this.resizeText) {
      // 捏合/多指时别的指针的 move 也会进来，必须自校验，别继承 moveText 的缺陷
      if (e.pointerId !== this.pointerId) return;
      const m = this.resizeText;
      const p = this.pointFromEvent(e, m.rec);
      const dx = p[0] - m.startX;
      if (!m.moved && Math.abs(dx) < 3) return;
      /*
       * 先判 target 再 snapshot（2026-11-07 修）：反过来的话，文字已经不存在
       * 时 snapshotPage 已经挂上 pendingBefore，然后 return —— 这个挂起的
       * 快照会被下一次 touch() 结算成「上一条的 after」，污染撤销历史。
       */
      const target = this.store.data.pages[m.rec.index]?.texts?.find((t) => t.id === m.id);
      if (!target) return;
      if (!m.moved) {
        this.store.snapshotPage(m.rec.index);
        m.moved = true;
      }
      // 上限用排版后的 x 现算：拖到纸右缘时不能把每行右端推出纸外（INK-116）
      const l = this.textLayout(target);
      const avail = availableTextWidth(this.store.data.width, l.x);
      target.width = Math.min(avail, Math.max(MIN_BOX_WIDTH, m.originW + dx));
      this.renderTextLayer(m.rec);
      this.renderOverlay(m.rec);
      this.positionTextBar();
      // 每帧只改宽度标签的文字，不重建整条属性条（重建十几个节点会拖平板手感）
      const lbl = this.textBarEl?.querySelector(".mb-tb-width");
      if (lbl) lbl.textContent = `宽 ${Math.round(this.textLayout(target).width)}`;
      e.preventDefault();
      return;
    }

    /* 拖动选中的形状：原点 + 位移重算两点，局部重绘旧/新位置 */
    if (this.gesture === "moveShape" && this.moveShape) {
      if (e.pointerId !== this.pointerId) return;
      const m = this.moveShape;
      const p = this.pointFromEvent(e, m.rec);
      let dx = p[0] - m.startX;
      let dy = p[1] - m.startY;
      if (!m.moved && Math.hypot(dx, dy) < 3) return;
      const target = this.store.data.pages[m.rec.index]
        ? this.findStrokeById(this.store.data.pages[m.rec.index], m.id)
        : null;
      if (!target) return;
      if (!m.moved) {
        this.store.snapshotPage(m.rec.index);
        m.moved = true;
      }
      // 夹取：整块包围盒不出纸，避免拖丢
      dx = clamp(dx, -m.origBox.minX, this.store.data.width - m.origBox.maxX);
      dy = clamp(dy, -m.origBox.minY, this.store.data.height - m.origBox.maxY);
      for (let i = 0; i < target.points.length && i < m.origin.length; i++) {
        target.points[i][0] = m.origin[i][0] + dx;
        target.points[i][1] = m.origin[i][1] + dy;
      }
      invalidateStrokeBounds(target);
      invalidateStroke(target);
      const nb = strokeBounds(target);
      this.repaintEraseRegion(m.rec, this.dirtyUnion(m.prevBounds, nb, this.strokeExtraPad(target)));
      m.prevBounds = nb;
      this.renderOverlay(m.rec);
      e.preventDefault();
      return;
    }

    /* 拖形状选框的手柄改大小：按手柄算出新包围盒，再把原始点按比例映射进去 */
    if (this.gesture === "resizeShape" && this.resizeShape) {
      if (e.pointerId !== this.pointerId) return;
      const m = this.resizeShape;
      const p = this.pointFromEvent(e, m.rec);
      if (!m.moved && Math.hypot(p[0] - m.startX, p[1] - m.startY) < 3) return;
      const target = this.store.data.pages[m.rec.index]
        ? this.findStrokeById(this.store.data.pages[m.rec.index], m.id)
        : null;
      if (!target) return;
      if (!m.moved) {
        this.store.snapshotPage(m.rec.index);
        m.moved = true;
      }
      const nb = this.resizeRawBox(m.origBox, m.handle, p[0] - m.startX, p[1] - m.startY);
      const ob = m.origBox;
      const ow = ob.maxX - ob.minX;
      const oh = ob.maxY - ob.minY;
      for (let i = 0; i < target.points.length && i < m.origin.length; i++) {
        const fx = ow > 1e-6 ? (m.origin[i][0] - ob.minX) / ow : 0.5;
        const fy = oh > 1e-6 ? (m.origin[i][1] - ob.minY) / oh : 0.5;
        target.points[i][0] = nb.minX + fx * (nb.maxX - nb.minX);
        target.points[i][1] = nb.minY + fy * (nb.maxY - nb.minY);
      }
      invalidateStrokeBounds(target);
      invalidateStroke(target);
      const cb = strokeBounds(target);
      this.repaintEraseRegion(m.rec, this.dirtyUnion(m.prevBounds, cb, this.strokeExtraPad(target)));
      m.prevBounds = cb;
      this.renderOverlay(m.rec);
      e.preventDefault();
      return;
    }

    /* 拖动选中的图片：整块夹在纸内，局部重绘旧/新位置 */
    if (this.gesture === "moveImage" && this.moveImage) {
      if (e.pointerId !== this.pointerId) return;
      const m = this.moveImage;
      const p = this.pointFromEvent(e, m.rec);
      const dx = p[0] - m.startX;
      const dy = p[1] - m.startY;
      if (!m.moved && Math.hypot(dx, dy) < 3) return;
      const target = this.store.data.pages[m.rec.index]?.images?.find((im) => im.id === m.id);
      if (!target) return;
      if (!m.moved) {
        this.store.snapshotPage(m.rec.index);
        m.moved = true;
      }
      const cdx = clamp(dx, -m.originX, this.store.data.width - target.width - m.originX);
      const cdy = clamp(dy, -m.originY, this.store.data.height - target.height - m.originY);
      target.x = m.originX + cdx;
      target.y = m.originY + cdy;
      const nb = this.imageSelBox(target);
      this.repaintEraseRegion(m.rec, this.dirtyUnion(m.prevBox, nb, 2));
      m.prevBox = nb;
      this.renderOverlay(m.rec);
      this.positionImageBar();
      const lbl = this.imageBarEl?.querySelector(".mb-tb-imgsize");
      if (lbl) lbl.textContent = `${Math.round(target.width)} × ${Math.round(target.height)}`;
      e.preventDefault();
      return;
    }

    /* 拖图片角手柄改大小（保持长宽比）：按手柄算出新框，锚定对角 */
    if (this.gesture === "resizeImage" && this.resizeImage) {
      if (e.pointerId !== this.pointerId) return;
      const m = this.resizeImage;
      const p = this.pointFromEvent(e, m.rec);
      if (!m.moved && Math.hypot(p[0] - m.startX, p[1] - m.startY) < 3) return;
      const target = this.store.data.pages[m.rec.index]?.images?.find((im) => im.id === m.id);
      if (!target) return;
      if (!m.moved) {
        this.store.snapshotPage(m.rec.index);
        m.moved = true;
      }
      const nb = this.resizeImageBox(m.origBox, m.handle, p[0] - m.startX, p[1] - m.startY, m.aspect);
      target.x = nb.minX;
      target.y = nb.minY;
      target.width = nb.maxX - nb.minX;
      target.height = nb.maxY - nb.minY;
      const cb = this.imageSelBox(target);
      this.repaintEraseRegion(m.rec, this.dirtyUnion(m.prevBox, cb, 2));
      m.prevBox = cb;
      this.renderOverlay(m.rec);
      this.positionImageBar();
      const lbl = this.imageBarEl?.querySelector(".mb-tb-imgsize");
      if (lbl) lbl.textContent = `${Math.round(target.width)} × ${Math.round(target.height)}`;
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
      if (this.tool === "eraser") {
        /*
         * 橡皮工具下笔尖悬停不画范围圈（笔压要等落笔才有意义，
         * 且平板主要用手指，不该有一个甩不掉的悬停圈）。
         * 但鼠标刚切到笔时要把上一个圈收掉，否则会留幽灵圈。
         */
        this.clearEraserPos();
      }
      const hp = this.pointFromEvent(e, rec);
      this.hoverPos = { x: hp[0], y: hp[1], p: e.pressure || 0.5 };
      this.scheduleOverlay(rec);
      return;
    }

    /*
     * 橡皮工具下鼠标悬停（没按下）就画范围圈。
     *
     * 为什么必须放在 arbiter.move 之前：没按下时仲裁器里没有这根指针，
     * move() 直接返回 "ignore"，后面的擦除分支根本走不到 —— 这正是
     * `cursor:none` 让鼠标完全消失、只有按下才冒出圈的根因。
     *
     * 只认 mouse：手指 / 触控笔没有真正的 hover（手指贴屏即 pointerdown，
     * 笔悬停归上面的 hoverPos 管），给它们画圈会在抬手后留一个甩不掉的圈。
     */
    if (
      this.tool === "eraser" &&
      e.pointerType === "mouse" &&
      this.gesture === "none" &&
      e.buttons === 0 &&
      !this.readOnly
    ) {
      // 从笔尖悬停切回鼠标：笔尖小圆点不该和橡皮圈叠在一起
      this.hoverPos = null;
      const hp = this.pointFromEvent(e, rec);
      const prev = this.eraserPos;
      this.eraserPos = {
        x: hp[0],
        y: hp[1],
        r: this.eraserRadiusAt(null),
        pageIndex: rec.index,
      };
      // 跨页移动：上一页的 overlay 要单独重画一次，把旧圈擦掉
      if (prev && prev.pageIndex !== rec.index) {
        const old = this.recs[prev.pageIndex];
        if (old) this.renderOverlay(old);
      }
      this.scheduleOverlay(rec);
      return;
    }

    const role = this.arbiter.move(this.pointerInfo(e));
    if (role === "ignore") return;
    if (role === "gesture") {
      e.preventDefault();
      return;
    }

    if (this.gesture === "pan" && this.pan) {
      /*
       * 手指拖动：直接跟随手指滚动（比"抓取"更符合平板直觉）。
       *
       * INK-229：这里原来有一句 `const p = this.pointFromEvent(e, rec)`——
       * pan 分支根本用不到它，却每一个 pointermove 都强制一次
       * `getBoundingClientRect()`（同步布局），跟着手指滚动时每帧都掐住主线程，
       * 是「拖动一顿一顿」的隐藏元凶，已删除。
       *
       * 速度采样仍读**真实**的 scrollTop（浏览器夹到边界后的值），不能用
       * 上面算出的 nextTop：手指拖出内容边界时两者会差很远，惯性初速会被
       * 算得过大；而且外部如果改了 scrollTop（跳转 / 恢复位置），速度样本
       * 必须跟着实际位置走，否则会甩出一段错误的滑行。
       */
      this.markFastScroll();
      const nextLeft = this.pan.left - (e.clientX - this.pan.x);
      const nextTop = this.pan.top - (e.clientY - this.pan.y);
      this.scrollEl.scrollLeft = nextLeft;
      this.scrollEl.scrollTop = nextTop;
      this.pushVelSample(this.scrollEl.scrollTop, e.timeStamp || performance.now());
      return;
    }

    if (this.tool === "eraser" && this.gesture !== "draw") {
      /*
       * 快速划动时一帧能来好几个坐标：绘制路径会遍历 coalesced events，
       * 橡皮以前只用最后一个点，120Hz 笔下相邻点间距可能超过橡皮直径，
       * 留下没擦到的「断带」。这里同样遍历，但把 dirty 并起来，
       * 一帧只局部重绘一次（不退化成每个点都重画整块）。
       */
      const raw =
        typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() || [] : [];
      const events = this.gesture === "erase" && raw.length ? raw : [e];
      // 圈跟最后一个（最新的）坐标与笔压，和这一帧最后一次擦除完全一致
      const last = events[events.length - 1];
      const lp = this.pointFromEvent(last, rec);
      this.eraserPos = {
        x: lp[0],
        y: lp[1],
        r: this.eraserRadiusAt(last),
        pageIndex: rec.index,
      };
      this.scheduleOverlay(rec);
      if (this.gesture === "erase") {
        if (events.length <= 1) {
          this.eraseAt(rec, lp[0], lp[1], last);
        } else {
          const dirty: Bounds = {
            minX: Infinity,
            minY: Infinity,
            maxX: -Infinity,
            maxY: -Infinity,
          };
          for (const ev of events) {
            const q = this.pointFromEvent(ev, rec);
            this.eraseAt(rec, q[0], q[1], ev, dirty);
          }
          if (dirty.minX !== Infinity) this.repaintEraseRegion(rec, dirty);
        }
      }
      return;
    }

    if (this.gesture === "draw" || this.gesture === "shape") {
      const raw =
        typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() || [] : [];
      const events = raw.length ? raw.slice() : [e];
      /*
       * 一定要把**派发事件本身** e 也算进去。
       *
       * 规范只说 `getCoalescedEvents()` 返回"被合并进来的指针事件"，没保证
       * 它一定包含/结尾就是当前这次 e —— 各浏览器实现有差异（有的实现里
       * 列表是"之前合并的若干子事件"，不含 e 本身）。漏掉 e 的后果是：每帧
       * 最新的那个真实位置没进笔迹，快速书写时墨迹永远差笔尖一截，
       * 用户感觉「不跟手、笔划到过的地方没墨」。这里缺了就在末尾补上 e。
       */
      if (raw.length) {
        const lastRaw = events[events.length - 1];
        if (
          !lastRaw ||
          Math.abs(lastRaw.clientX - e.clientX) > 0.01 ||
          Math.abs(lastRaw.clientY - e.clientY) > 0.01
        ) {
          events.push(e);
        }
      }
      for (const ev of events) this.appendPoint(ev, rec);
      this.scheduleOverlay(rec);
    }
  }

  private appendPoint(e: PointerEvent, rec: PageRec): void {
    if (!this.draft) return;
    const p = this.filteredPoint(e, rec);
    const now = e.timeStamp || performance.now();

    if (this.draft.tool === "shape") {
      const [x, y] = this.shapeEndFromPoint(e, p);
      this.draft.points[1] = [x, y, 0.5];
      invalidateStroke(this.draft);
      return;
    }

    const last = this.draft.points[this.draft.points.length - 1];
    const dist = last ? Math.hypot(p[0] - last[0], p[1] - last[1]) : 0;
    /*
     * 采样阈值按 zoom 归一化：0.55 页面单位在 0.8 倍时约 0.44 CSS px，
     * 到 2.8 倍就是 1.54 CSS px——放大后点变稀，转角/曲率被切掉，
     * 用户感觉「放大再写识别得比较粗糙」。除以因子后各缩放档的
     * 屏幕采样密度一致（只影响慢速移动，正常书写点数基本不变）。
     */
    const minStep = 0.55 / zoomNormalization(this.zoom);
    if (dist < minStep) return;
    const dt = this.lastPoint ? now - this.lastPoint.t : 16;
    // 撤销记录由 commitDraft → addStroke 自动记增量，
    // 这里不用再拍全页快照（大页面上那一下要几毫秒）。
    const pressure =
      this.draft.tool === "highlighter" ? 0.5 : this.pressureFor(e, dist, Math.max(1, dt));
    this.draft.points.push([p[0], p[1], pressure]);
    invalidateStroke(this.draft);
    // shape 分支在函数开头就 return 了，这里只剩 pen / ballpoint / highlighter
    if (this.draft.tool !== "highlighter") {
      this.inkPredictor.push(p[0], p[1], now, pressure);
    }
    this.lastPoint = { x: p[0], y: p[1], t: now };
  }

  /**
   * 形状第二个点的落点（含 Shift 吸附）。appendPoint 与 appendFinalPoint 共用，
   * 保证「拖动中」和「抬手补最后一点」用同一套几何规则。
   */
  private shapeEndFromPoint(e: PointerEvent, p: Pt): [number, number] {
    const start = this.draft!.points[0];
    let x = p[0];
    let y = p[1];
    if (e.shiftKey && this.draft!.tool === "shape") {
      if (this.draft!.shape === "line" || this.draft!.shape === "arrow") {
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
    return [x, y];
  }

  /**
   * 抬手前把**指针最终所在的原始位置**补进草稿。
   *
   * 为什么必须补：
   *   · 书写预览会带预测尾巴（画在 overlay），但提交用的是草稿点本身；
   *     若抬手点没补进来，抬笔那一刻墨迹会从预览位置「缩回去」；
   *   · 1€ 滤波在快速运笔时会滞后——最后一个 pointermove 的滤波点明显
   *     落后于笔尖。若只提交到那个滤波点，笔画尾端就停在笔尖后面，
   *     用户看到「笔明明划过那里，却没有笔迹」。
   * 这里取**未滤波的原始点**收尾，保证墨迹终于笔尖实际抬起的位置，
   * 把过滤波滞后丢掉的那一段补回来。只在真正的 pointerup 补，
   * pointercancel 没有可靠坐标（有的实现给 0,0），补了会拉出一条到原点的线。
   *
   * 距离过近（点一下/微抖）就不补，保留单点，交给 drawStroke 画成圆点；
   * 否则会变成两个几乎重合的点，perfect-freehand 反而渲染成一小团看不见的东西。
   */
  private appendFinalPoint(rec: PageRec, e: PointerEvent): void {
    if (!this.draft) return;
    if (e.type !== "pointerup") return;
    const p = this.pointFromEvent(e, rec);
    if (this.draft.tool === "shape") {
      const [x, y] = this.shapeEndFromPoint(e, p);
      this.draft.points[1] = [x, y, 0.5];
      invalidateStroke(this.draft);
      return;
    }
    const last = this.draft.points[this.draft.points.length - 1];
    const dist = last ? Math.hypot(p[0] - last[0], p[1] - last[1]) : 0;
    if (dist < 0.75) return;
    const now = e.timeStamp || performance.now();
    const dt = this.lastPoint ? now - this.lastPoint.t : 16;
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

    // 激光笔：抬手后光迹继续淡出，不提交任何内容、不触发墨水手势回调
    if (gesture === "laser") {
      this.armLaserFade();
      this.emitState();
      return;
    }

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
    } else if (gesture === "resizeText") {
      const m = this.resizeText;
      this.resizeText = null;
      // 拖完宽度就清掉双击计时：否则 300ms 内点一下会被误判成「双击进编辑」
      this.lastTextTap = null;
      if (m?.moved) {
        this.store.touch();
        this.changed();
        this.emitState();
      }
    } else if (gesture === "moveShape" || gesture === "resizeShape") {
      this.finishShapeEdit();
    } else if (gesture === "moveImage" || gesture === "resizeImage") {
      this.finishImageEdit();
    } else if (gesture === "draw" || gesture === "shape") {
      /*
       * 用 draftRec 而不是 onUp 拿到的 rec：globalUp 用 `recs[current]` 调进来，
       * 若书写期间 current 变了（滚动/翻页），按 current 提交会把这一笔记到别的页、
       * 而用户写字的那页上就「没有笔迹」。draftRec 才是这笔真正落下的页。
       */
      const draftRec = this.draftRec ?? rec;
      // 抬手点补进草稿：让墨迹终于笔尖实际抬起处，弥合滤波滞后 / 漏掉最后一段
      this.appendFinalPoint(draftRec, e);
      this.commitDraft(draftRec);
    } else if (gesture === "erase") {
      /*
       * 鼠标抬手后仍悬停在纸上：圈要留在抬手处继续当光标，
       * 否则 cursor:none 又让鼠标凭空消失，用户得再动一下才找得到。
       * 手指 / 笔没有 hover，直接收掉。
       */
      if (e.pointerType === "mouse") {
        const up = this.pointFromEvent(e, rec);
        this.eraserPos = {
          x: up[0],
          y: up[1],
          r: this.eraserRadiusAt(null),
          pageIndex: rec.index,
        };
      } else {
        this.eraserPos = null;
      }
      // 擦除手势结束：这时才结算整条历史，并整页重画一次
      this.finishEraseGesture(rec);
    }
    this.emitState();
    // 抬手了：自动保存可以从「避让」恢复排程（橡皮尤其需要，
    // 它最后一次 eraseAt 早已 markDirty 过，抬手本身不再产生 onChange）
    if (gesture === "draw" || gesture === "shape" || gesture === "erase") {
      if (this.opts.onInkGestureEnd) this.opts.onInkGestureEnd();
    }
  }

  /**
   * 鼠标离开纸面：收掉橡皮圈。
   *
   * 以前这里只在 `gesture === "erase"` 时清，悬停画的圈清不掉；
   * 而且事件委托挂 docEl、target 恒为 docEl，findRec 返回 null 导致
   * 整个回调从不执行 —— 圈会一直留在最后的位置（幽灵圈）。
   * 现在不依赖 target，直接清数据并重画所有已挂载页的 overlay。
   *
   * 正在擦除的手势不清：指针被 pageEl 捕获着，中途离开纸面只是
   * 擦到了边缘，抬手时 onUp 会自己收尾。
   */
  private onLeave(_e: PointerEvent): void {
    if (this.gesture === "erase") return;
    this.clearEraserPos();
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
      /*
       * 一笔成型（经典手写应用「画完立刻自动识别」移植）：只剩开 / 关两态，
       * 开 = 抬笔这一刻立刻把自由笔迹换成规整图形（不再有「停留识别」）。
       * 只作用于自由笔迹：形状工具本来就是规整图形，荧光笔的半透明叠加
       * 换成 shape 会变实心，也不参与。
       * 识别失败一律保留原笔迹；下面原有的自动拉直只在没成型时生效。
       */
      let snapped = false;
      if (
        this.shapeSnap !== "off" &&
        (draft.tool === "pen" || draft.tool === "ballpoint")
      ) {
        const found = recognizeShape(stroke.points);
        if (found) {
          stroke = {
            ...stroke,
            tool: "shape",
            shape: found.kind,
            opacity: 1,
            points: recognitionPoints(found),
          };
          snapped = true;
        }
      }
      // 已经成型就不必再拉直：两个端点本来就是直的
      if (!snapped && this.straighten) {
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

  /**
   * 橡皮实际半径：画圈和擦除**共用这一处**。
   *
   * 为什么抽出来：以前画圈用 eraserSize/2（恒定 13），擦除却乘了
   * (0.55 + press)，鼠标 press=1 时是 20.15 —— 圈 13 却擦掉 20，
   * 用户直接报「擦出的范围跟圈有出入」。
   *
   * 选 (a) 保留压感：用力大擦得多对触控笔是有意义的手感，不能因为
   * 鼠标 press 恒为 1 就把笔的能力砍掉。代价是圈的半径会随笔压变，
   * 但这正是「圈 = 真实擦除范围」——轻按圈就小，重按圈就大。
   * 悬停（没按下、没有真实笔压）按满压算，和鼠标按下时一致。
   */
  private eraserRadiusAt(e: PointerEvent | null): number {
    const base = this.eraserSize / 2;
    const press = e && e.pointerType === "pen" ? clamp(e.pressure || 0.5, 0.05, 1) : 1;
    return base * (0.55 + press * 1.0);
  }

  /**
   * 擦一次（可带 dirty 外接矩形用于合并重绘）。
   *
   * @param dirty 传入时把本轮改动区域并进去、且不立即重绘；
   *              不传时（pointerdown 的第一次）自己重绘一次。
   */
  private eraseAt(
    rec: PageRec,
    x: number,
    y: number,
    e: PointerEvent,
    dirty?: Bounds
  ): void {
    const page = this.store.data.pages[rec.index];
    if (!page) return;
    // 隐藏层看不见却仍会被擦掉，静默删数据；直接跳过
    const layer = this.erasingLayer(rec.index);
    if (!layer || !layer.visible) return;
    const radius = this.eraserRadiusAt(e);
    let changed = false;
    const remove = new Set<string>();
    const replacements: Array<{ oldId: string; pieces: Stroke[] }> = [];
    /*
     * 这次擦除实际会改到哪些像素：被删 / 被替换笔迹的包围盒并集。
     * 手势期间只重绘这一块（见 repaintEraseRegion），不再整页重画。
     * 新切出的碎片都在老笔迹的包围盒内，所以不用再算一遍碎片的范围。
     * 合并事件一次能来好几个坐标，用外部传入的 dirty 把它们并成一帧重绘。
     */
    const region: Bounds = dirty ?? {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    };
    const isEmpty = () =>
      region.minX === Infinity || region.maxX === -Infinity;
    const unionBounds = (s: Stroke) => {
      const b = strokeBounds(s);
      const pad = this.strokeExtraPad(s);
      if (isEmpty()) {
        region.minX = b.minX - pad;
        region.minY = b.minY - pad;
        region.maxX = b.maxX + pad;
        region.maxY = b.maxY + pad;
        return;
      }
      if (b.minX - pad < region.minX) region.minX = b.minX - pad;
      if (b.minY - pad < region.minY) region.minY = b.minY - pad;
      if (b.maxX + pad > region.maxX) region.maxX = b.maxX + pad;
      if (b.maxY + pad > region.maxY) region.maxY = b.maxY + pad;
    };

    for (const s of layer.strokes) {
      if (!strokeHit(s, x, y, radius)) continue;
      unionBounds(s);
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
     * 手势结束才把前后态一起入栈（后态由 finishEraseGesture 统一抓，
     * 手势期间不再每个 move 都做一次 O(笔迹数) 的数组拷贝）。
     */
    const store = this.store;
    if (!this.undoPushed) {
      this.eraseBefore = store.captureLayerState(rec.index, layer.id);
      this.undoPushed = true;
    }
    if (remove.size) store.removeStrokes(remove, rec.index, true);
    for (const r of replacements) store.replaceStroke(r.oldId, r.pieces, rec.index, true);
    // 没传 dirty = 单独一次擦除，立刻重画；传了 = 合并事件的一帧，等外层画一次
    if (!dirty) this.repaintEraseRegion(rec, region);
    store.touch();
    this.changed();
  }

  /**
   * 取本次擦除手势锁定的层。
   *
   * 手势第一次擦到东西时把「页 + 层 id」定死，之后不再跟着 activeLayer 变：
   * 手势中途切层的话，前后态必须落在同一层，否则撤销记录前后对不上。
   * 存 id 每次现查，是为了避开 undo/redo 整页重建后拿着旧 Layer 对象。
   */
  private erasingLayer(pageIndex: number): Layer | null {
    const lock = this.eraseLayer;
    if (lock && lock.pageIndex === pageIndex) {
      const page = this.store.data.pages[pageIndex];
      return page?.layers.find((l) => l.id === lock.layerId) ?? null;
    }
    const page = this.store.data.pages[pageIndex];
    if (!page) return null;
    const layer = activeLayer(page);
    this.eraseLayer = { pageIndex, layerId: layer.id };
    return layer;
  }

  /**
   * 擦除手势收尾（抬手 / 切后台共用）。
   *
   * 三件事：
   *   1. 现在才抓「后态」并和「前态」合成**一条**撤销记录——
   *      手势期间每次 move 都抓的话，1000 笔的页面上每帧要白拷贝一次
   *      O(笔迹数) 的数组，而历史本来就只在抬手入栈；
   *   2. 丢掉中间状态；
   *   3. 主画布整页重画一次。手势期间只做了局部重绘，这一步保证
   *      最终画面和落盘数据完全一致（局部重绘边界、底图异步加载等
   *      任何意外都被这一下抹平）。
   */
  private finishEraseGesture(rec: PageRec | null): void {
    const before = this.eraseBefore;
    // eraseBefore 非空 ⇔ 这次手势真的擦到过东西
    const edited = !!before;
    if (before && before.kind === "layer") {
      const after = this.store.captureLayerState(before.pageIndex, before.layerId);
      if (after) this.eraseAfter = after;
    }
    if (this.eraseBefore && this.eraseAfter) {
      this.store.recordLayerChange(this.eraseBefore, this.eraseAfter);
    }
    this.eraseBefore = null;
    this.eraseAfter = null;
    this.undoPushed = false;
    // 手势结束，下一轮重新按当下的 activeLayer 锁定
    this.eraseLayer = null;
    if (rec) {
      // 没擦到东西的点击（比如空页上点一下）不值得整页重画，只清 overlay
      if (edited) this.renderRec(rec);
      this.renderOverlay(rec);
    }
  }

  /* ------------------------------- 页面操作 ------------------------------- */

  addPage(): void {
    const index = this.store.addPage(this.current);
    this.current = index;
    this.renderPages();
    requestAnimationFrame(() => this.goToPage(index, false));
  }

  deletePage(index = this.current): void {
    // 页 id 是缓存的身份：删掉的页立刻把它的快照释放掉
    // （撤销恢复的是同一页对象、同一 id，即便留着也不会错，但没必要占内存）
    const gone = this.store.data.pages[index];
    if (!this.store.deletePage(index)) return;
    if (gone) this.invalidateThumb(gone.id);
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

  /**
   * 调整页顺序（侧栏上移/下移）。
   *
   * 页数没变，主视图必须整页重建：页 DOM 是按数组顺序建的，
   * 只重画 canvas 的话位置和内容会错位。当前页由 store 按 id 跟随。
   */
  movePage(from: number, to: number): boolean {
    // store.movePage 已 touch（→ view.markDirty），这里只负责重建主视图
    if (!this.store.movePage(from, to)) return false;
    this.current = clamp(this.store.data.activePage, 0, this.store.pageCount - 1);
    this.renderPages();
    return true;
  }

  setTemplate(template: TemplateId, all = false): void {
    if (all) {
      this.store.setAllTemplates(template);
      // 整本都换了纸面线，所有页的缩略图快照一起作废
      this.clearThumbShots();
    } else this.store.setTemplate(this.current, template);
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

  /**
   * 设置图层透明度（0–1），立即重绘当前页。
   *
   * `snapshot` 只在一次拖动/一次键盘调整的**第一次**调用时传 true：
   * 撤销栈里只留一条「拖动前 → 拖动后」。每来一个 input 都拍快照的话，
   * 拖一次滑杆就能塞满 60 层撤销栈，之前写的字全部撤不回去。
   */
  setLayerOpacity(id: string, opacity: number, snapshot = false): void {
    const layer = this.store.page.layers.find((l) => l.id === id);
    if (!layer) return;
    const v = Math.max(0, Math.min(1, opacity));
    if (Math.abs(layer.opacity - v) < 1e-9) return;
    if (snapshot) this.store.snapshotPage(this.current);
    layer.opacity = v;
    const rec = this.recs[this.current];
    if (rec?.mounted) this.renderRec(rec);
    this.changed();
    this.store.touch();
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
    /*
     * 第 0 页上面没有"上一页"，目标就是 0。
     * 公式里的 -16 会把顶部留白算成 scrollTop≈6；把它写进去等于
     * 内容纹丝不动却触发一次真 scroll 事件——右缘滑块会在本子刚
     * 打开时白闪一下（用户要的是"滑动才显现"）。
     */
    const target = rec.index === 0 ? 0 : Math.max(0, top);
    // 已经在目标位置（差值 ≤1px）就别写：scrollTo 同值也会派发 scroll
    if (Math.abs(target - this.scrollEl.scrollTop) > 1) {
      if (smooth) this.navLockTarget = { top: target, until: performance.now() + 600 };
      this.scrollEl.scrollTo({
        top: target,
        behavior: smooth ? "smooth" : "auto",
      });
    }
    this.emitState();
    if (this.opts.onPageChange) this.opts.onPageChange(rec.index);
  }

  goToPage(index: number, smooth = true): void {
    // 翻页前先落库：编辑框里没提交的文字不能跟着页面一起被晾着
    this.commitTextEdit();
    this.scrollToPage(index, smooth);
  }

  /**
   * 设置「笔记内查找」的高亮。
   *
   * `query` 为空即清除。高亮只改文字层 DOM：不碰 store、不写盘、不进撤销，
   * 也不影响画布 / 导出 / 嵌入（它们都按页面数据重画，不读这层 mark）。
   *
   * 所有**已挂载**页里出现的查询词都标普通高亮，当前那条命中标得更醒目，
   * 跟 Obsidian 文件内搜索「全文标色 + 当前项加深」的观感一致；没挂载的页
   * 等滚到时由 `renderTextLayer` 按同一份 `findQuery` 自己补上。
   */
  setFindHighlight(query: string, hit: FindMatch | null): void {
    this.findQuery = String(query ?? "");
    this.findHit = this.findQuery ? hit : null;
    // 旧层带着上一轮的高亮（或没有高亮），一律不能复用
    this.invalidateTextLayerCache();
    for (const rec of this.recs) {
      if (!rec.mounted || !rec.textLayer) continue;
      this.deferredTextLayers.delete(rec);
      rec.textLayer.dataset.textSig = "";
      this.renderTextLayer(rec);
    }
    if (this.findHit) this.revealFindHit(this.findHit);
  }

  /** 收起查找框时调用：清掉全部高亮。 */
  clearFindHighlight(): void {
    this.setFindHighlight("", null);
  }

  /**
   * 把当前命中滚进视口。
   *
   * 只补一段纵向偏移：调用方通常已经 `goToPage` 翻到那一页了，但一页
   * A4 有 1123 个页面单位，命中可能在纸的下半截；停在那里用户还是看不见。
   */
  private revealFindHit(hit: FindMatch): void {
    const rec = this.recs[hit.page];
    if (!rec) return;
    if (!rec.mounted) this.mount(rec);
    const layer = rec.textLayer;
    if (!layer) return;
    let span: HTMLElement | null = null;
    for (const child of Array.from(layer.children)) {
      if ((child as HTMLElement).dataset?.id === hit.textId) {
        span = child as HTMLElement;
        break;
      }
    }
    if (!span) return;
    const er = span.getBoundingClientRect();
    const sr = this.scrollEl.getBoundingClientRect();
    if (!er.height || !sr.height) return;
    if (er.top >= sr.top + 48 && er.bottom <= sr.bottom - 48) return;
    const delta = er.top - sr.top - Math.max(48, (sr.height - er.height) / 2);
    this.scrollEl.scrollBy({ top: delta, behavior: "auto" });
  }

  /**
   * 轻轻标一下「刚跳到这一页」。
   *
   * 为什么只做页面级提示（而不是高亮搜索到的文字）：
   * Obsidian 的全局搜索打开索引 md 时只给插件一个文件路径，命中行号没有、
   * 搜索词也没有——读 ephemeralState / 搜索面板 DOM 都属于跨版本易断的
   * 内部实现，已评估为不做。所以能做且值得做的是让目标页自己"亮一下"：
   *   · 页面四周一圈柔和的主色描边，淡入后 1.8 秒内淡出；
   *   · 页顶浮出「已跳到第 N 页」，给一个明确的落点确认；
   *   · 右上角的页码同时变成实心小胶囊，远看也能找到这一页。
   *
   * 全部是 DOM class + 定时器：
   *   · 不碰 store / 页面数据，所以文件格式不变；
   *   · 导出 PDF 走的是矢量重绘，从不读页面 DOM，页面上这圈高亮不会被导出；
   *   · 标记 pointer-events:none，写字、翻页、缩放都不受影响；
   *   · 页面重建 / 编辑器销毁时由 clearLocateHint 收干净。
   *
   * @param index 0 起的页下标；非法或越界时静默忽略
   * @param ms 提示存活时间（毫秒）
   */
  locatePage(index: number, ms = 1800): void {
    this.clearLocateHint();
    if (!Number.isFinite(index) || !this.recs.length) return;
    const rec = this.recs[clamp(Math.round(index), 0, this.recs.length - 1)];
    if (!rec) return;

    rec.wrap.classList.add("is-located");
    let badge = rec.wrap.querySelector(".mb-locate-hint") as HTMLElement | null;
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "mb-locate-hint";
      // 纯视觉提示，不进无障碍朗读队列（否则每次跳页都念一句）
      badge.setAttribute("aria-hidden", "true");
      rec.wrap.appendChild(badge);
    }
    badge.textContent = `已跳到第 ${rec.index + 1} 页`;
    this.locateRec = rec;
    this.locateTimer = window.setTimeout(
      () => this.clearLocateHint(),
      Math.max(300, ms)
    );
  }

  /** 收掉落点提示：撤 class、摘标记、清定时器（可重复调用） */
  private clearLocateHint(): void {
    if (this.locateTimer) window.clearTimeout(this.locateTimer);
    this.locateTimer = 0;
    const rec = this.locateRec;
    this.locateRec = null;
    if (!rec) return;
    rec.wrap.classList.remove("is-located");
    rec.wrap.querySelector(".mb-locate-hint")?.remove();
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
  /**
   * 「当前页」取样点距视口顶部的距离（视口高度的 42%，最多 460px）。
   *
   * **必须只有一个来源**（2026-11-08）。以前 beginPinch 自己写
   * `clientHeight * 0.42`、updateCurrentFromScroll 写
   * `min(clientHeight * 0.42, 460)` —— 屏幕高超过约 1095px 时两者
   * 落在不同页：捏合期间锁的是「偏下那页」，手势结束先回跳到它，
   * 240ms 解冻后再跳回真正那页，用户看到页码闪两下。
   *
   * 上限 460 的理由：大屏上 42% 会跑到下一屏去，取样点离顶部太远
   * 就不是「用户正在看的那页」了。
   */
  private currentPageProbeOffset(): number {
    return Math.min(this.scrollEl.clientHeight * 0.42, 460);
  }

  private updateCurrentFromScroll(quiet = false): void {
    if (!this.recs.length) return;
    if (this.navLockTarget) {
      const { top, until } = this.navLockTarget;
      const near = Math.abs(this.scrollEl.scrollTop - top) <= 2;
      if (!near && performance.now() < until) return; // 平滑滚动途中：页码保持目标页
      this.navLockTarget = null;
    }
    const n = this.recs.length;
    const pageH = this.store.data.height * this.zoom;
    if (pageH <= 0) return;

    const stride = pageH + this.pageGap;
    // 视口中线在滚动内容里的位置
    const mid = this.scrollEl.scrollTop + this.currentPageProbeOffset();
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
    const fast = this.isFastScrolling();

    if (best !== this.current) {
      this.current = best;
      this.store.setPage(best);
      /*
       * quiet 只用于「缩放后刷新页码」（INK-107）：那时页面没真的翻过去，
       * 不能顺手 mount / 广播翻页回调，否则测试里预设的 current 会被拉走，
       * 选中文字、编辑框、拖动全跟着失效。emitState 由调用方在后面统一发。
       * 正常滚动路径仍走完整的兜底挂载。
       */
      if (quiet) return;
      /*
       * 快滑中先不逐页 mount / 广播：fling 时一帧跨好几页，每跨一页都挂画布 +
       * emitState -> 重建侧栏/刷新页码，主线程被塞满就会「一卡一卡」。
       * 页码 / 当前页在停稳后由 armScrollSettle 统一补一次；滚动中文本层
       * 也已经按快滑规则延后。慢速翻页仍走下面的即时路径，行为不变。
       */
      if (fast) {
        this.armScrollSettle();
        return;
      }
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

  /**
   * 快滑停稳后补一次「当前页挂载 + 页码广播」。
   *
   * 快滑期间 updateCurrentFromScroll 只更新 current / store，不每页 mount、
   * 不 emitState；这里等 isFastScrolling() 彻底结束（宽限期也过了）再补，
   * 用户看到的是滚动顺滑、停稳后页码和画布一次到位。
   */
  private armScrollSettle(): void {
    if (this.scrollSettleTimer) return;
    const tick = () => {
      this.scrollSettleTimer = 0;
      if (this.destroyed) return;
      if (this.isFastScrolling()) {
        this.armScrollSettle();
        return;
      }
      // 程序化翻页（上一页/下一页）还在平滑滚动途中：别用中间页覆盖页码
      if (this.navLockTarget) {
        this.armScrollSettle();
        return;
      }
      if (!this.recs.length) return;
      this.mount(this.recs[this.current]);
      this.emitState();
      if (this.opts.onPageChange) this.opts.onPageChange(this.current);
    };
    this.scrollSettleTimer = window.setTimeout(tick, 160);
  }

  /* ------------------------------- 撤销 ------------------------------- */

  undo(): void {
    if (this.readOnly) return;
    // 还在编辑框里的文字先落库（移动端点按钮不一定触发 blur），否则会漏字
    this.commitTextEdit();
    if (!this.store.undo()) return;
    /*
     * 撤销可能恢复整本快照（加/删页、全部换模板），被改的不一定只有当前页；
     * 缩略图快照又便宜（最多 8MB），直接全丢，别去猜哪几页受影响。
     */
    this.clearThumbShots();
    /*
     * 页数不变但顺序可能变了（撤销一次上移/下移）：
     * 页 DOM 是按数组顺序建的，不重建就会「第 3 页的位置还是第 1 页的内容」。
     */
    if (this.recs.length !== this.store.pageCount || this.pageOrderRev !== this.store.pageOrderRev) {
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
    this.commitTextEdit();
    if (!this.store.redo()) return;
    // 同 undo：整本快照可能被恢复，缩略图快照全丢（见上）
    this.clearThumbShots();
    // 同 undo：顺序变化也要重建（见上）
    if (this.recs.length !== this.store.pageCount || this.pageOrderRev !== this.store.pageOrderRev) {
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
   *   · 位图没就绪先画一层浅灰占位，渲染完由 onThumbNeedsRedraw 补画；
   *   · 画完的整张缩略图进 thumbShots 小 LRU（8MB / 80 张），滚回来直接 blit。
   */
  renderThumbnail(canvas: HTMLCanvasElement, index: number): void {
    const page = this.store.data.pages[index];
    if (!page) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width || 60;
    const cssH = rect.height || 84;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));

    /*
     * 缓存命中：窗口重建换了一块新 canvas，但这一页内容没变——
     * 直接把上次画好的小图 blit 过去。纸面线、笔迹、PDF 底图都不用再画，
     * 滚回看过的页就是一次 drawImage。
     *
     * key 里带页 id 而不是页号：上移/下移、插入、删除页后页号会漂，
     * 但页 id 跟着内容走；尺寸也进 key，侧栏变宽 / dpr 变了按新尺寸重画。
     */
    const key = thumbShotKey(page.id, w, h);
    const hit = this.thumbShots.get(key);
    if (hit) {
      hit.touched = ++this.thumbShotClock;
      this.thumbHits += 1;
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d")?.drawImage(hit.canvas, 0, 0);
      return;
    }

    /*
     * 先画到一块**离屏小画布**，画完再 blit 到目标：
     * 同一份像素既给当前窗口用，也进 LRU 给下次滚回来用。
     * 直接画目标 canvas 的话还得再复制一份才能缓存，白画一遍。
     */
    const shot = document.createElement("canvas");
    shot.width = w;
    shot.height = h;
    const sctx = shot.getContext("2d");
    if (!sctx) {
      // 极端环境拿不到离屏 ctx：退回直接画目标，不缓存（正确性优先）
      canvas.width = w;
      canvas.height = h;
      const direct = canvas.getContext("2d");
      if (!direct) return;
      this.paintThumb(direct, page, cssW, dpr, w, h);
      this.thumbRasterized += 1;
      return;
    }

    const bgReady = this.paintThumb(sctx, page, cssW, dpr, w, h);
    this.thumbRasterized += 1;
    /*
     * 底图没就绪（PDF 位图还在渲染 / 图片还没加载完）时**不缓存**：
     * 存下来的会是灰占位 / 空底图，底图好了回调重画时会命中这张假图，
     * 用户就永远看不到内容。等就绪后的那一遍再进缓存。
     */
    if (bgReady) this.putThumbShot(key, shot, w, h);

    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")?.drawImage(shot, 0, 0);
  }

  /**
   * 把一页画进给定 ctx（缩略图尺寸）。
   *
   * @returns 底图是否已就绪。false = 画的是占位/空底图，这一张不能进缓存。
   */
  private paintThumb(
    ctx: CanvasRenderingContext2D,
    page: Page,
    cssW: number,
    dpr: number,
    w: number,
    h: number
  ): boolean {
    const kx = w / this.store.data.width;
    const ky = h / this.store.data.height;
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
     * 这里**不能**调 drawBackground 的 PDF 分支——它对 PDF 会按主视图缩放
     * 去请求 2000px 级别的高清位图，侧栏滚一遍等于把整个 PDF 重新光栅化一遍。
     */
    const bg = page.background;
    let bgReady = true;
    if (bg?.pdf) {
      bgReady = this.drawPdfThumb(ctx, bg, cssW);
    } else if (bg?.src) {
      // 图片底图是异步加载的，没加载完时 drawBackground 什么都不画
      const img = this.bgImages.get(bg.src);
      bgReady = !!img && img.complete && img.naturalWidth > 0;
      this.drawBackground(ctx, page);
    }
    // 插入的图片也是异步加载：没加载完就画淡灰占位，且这张缩略图不进缓存
    if (page.images?.length) {
      for (const im of page.images) {
        const im2 = this.bgImages.get(im.src);
        if (!(im2 && im2.complete && im2.naturalWidth > 0)) {
          bgReady = false;
          this.loadBackground(im.src);
        }
      }
      this.drawInsertedImages(ctx, page);
    }
    for (const layer of page.layers) {
      if (!layer.visible) continue;
      for (const s of layer.strokes) drawStroke(ctx, s, layer.opacity);
    }
    return bgReady;
  }

  /**
   * 在缩略图里画 PDF 底图（小尺寸）。
   *
   * ctx 已经按「页面坐标 → 缩略图设备像素」缩放过，所以 bg.x/y/width/height
   * 可以直接用，和主视图是同一套坐标。
   *
   * @returns 是否画上了真实位图（false = 只画了灰占位，调用方不要缓存这一张）
   */
  private drawPdfThumb(
    ctx: CanvasRenderingContext2D,
    bg: PageBackground,
    cssW: number
  ): boolean {
    const pdf = bg.pdf;
    if (!pdf) return true;
    const key = `${pdf.path}#${pdf.page}`;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // 1.4 倍余量：缩略图在 hover / 窄侧栏里会有几像素的尺寸浮动
    const want = clamp(Math.round(cssW * dpr * 1.4), 96, 384);

    /*
     * 取最清晰的一张：缩略图专用位图 or 主视图位图，谁宽用谁。
     * 以前是 `thumbBitmaps ?? bgBitmaps`——若缩略图位图比主视图那张小，
     * 就会宁可画更糊的；改成取更大的那张。
     */
    const thumbEntry = this.thumbBitmaps.getEntry(key);
    const mainEntry = this.bgBitmaps.getEntry(key);
    let best: ImageBitmap | null = null;
    let bestW = 0;
    if (thumbEntry && thumbEntry.width > bestW) {
      best = thumbEntry.bitmap;
      bestW = thumbEntry.width;
    }
    if (mainEntry && mainEntry.width > bestW) {
      best = mainEntry.bitmap;
      bestW = mainEntry.width;
    }

    if (best && bestW >= want * 0.8) {
      ctx.save();
      ctx.drawImage(best, bg.x, bg.y, bg.width, bg.height);
      ctx.restore();
      return true;
    }

    if (best) {
      /*
       * 有图但不够清：先画这张当过渡（比灰块好看），同时请求更清晰的。
       * 返回 false → 这一张不进快照缓存，等高清就绪后 notifyThumb 会重画。
       */
      ctx.save();
      ctx.drawImage(best, bg.x, bg.y, bg.width, bg.height);
      ctx.restore();
      this.requestPdfThumb(pdf.path, pdf.page, key, want);
      return false;
    }

    /*
     * 完全没图：画一层浅灰。
     *
     * 用 #F0EDE8 而不是纸白，是为了和"空白的纸"区分开——
     * 一眼能看出这页有底图，只是还在渲染。
     */
    ctx.save();
    ctx.fillStyle = "#F0EDE8";
    ctx.fillRect(bg.x, bg.y, bg.width, bg.height);
    ctx.restore();

    this.requestPdfThumb(pdf.path, pdf.page, key, want);
    return false;
  }

  /* --------------------- 缩略图快照 LRU（诊断 / 测试可见） --------------------- */

  /** 缩略图快照缓存统计；只读，不参与渲染决策 */
  get thumbCacheStats(): {
    count: number;
    bytes: number;
    budget: number;
    max: number;
    rasterized: number;
    hits: number;
  } {
    return {
      count: this.thumbShots.size,
      bytes: this.thumbShotBytes,
      budget: THUMB_SHOT_BUDGET,
      max: THUMB_SHOT_MAX,
      rasterized: this.thumbRasterized,
      hits: this.thumbHits,
    };
  }

  /** 放进 LRU；超预算 / 超条数就淘汰最久没用的 */
  private putThumbShot(key: string, canvas: HTMLCanvasElement, w: number, h: number): void {
    this.dropThumbShot(key);
    const bytes = w * h * 4;
    // 单张就超预算：不缓存（正常缩略图远到不了，防尺寸异常时吃光内存）
    if (bytes > THUMB_SHOT_BUDGET) return;
    this.thumbShots.set(key, { canvas, bytes, touched: ++this.thumbShotClock });
    this.thumbShotBytes += bytes;
    while (this.thumbShotBytes > THUMB_SHOT_BUDGET || this.thumbShots.size > THUMB_SHOT_MAX) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [k, e] of this.thumbShots) {
        if (e.touched < oldest) {
          oldest = e.touched;
          oldestKey = k;
        }
      }
      if (!oldestKey) break;
      this.dropThumbShot(oldestKey);
    }
  }

  private dropThumbShot(key: string): void {
    const e = this.thumbShots.get(key);
    if (!e) return;
    this.thumbShots.delete(key);
    this.thumbShotBytes -= e.bytes;
    /*
     * 把 backing store 缩到 0，别等 GC。
     * 平板上一次滚动可能淘汰几十张，等 GC 的话峰值内存会多顶一会儿。
     */
    e.canvas.width = 0;
    e.canvas.height = 0;
  }

  /** 某页内容变了：丢掉它所有尺寸的快照 */
  private invalidateThumb(pageId?: string): void {
    if (!pageId) return;
    const prefix = pageId + "@";
    for (const key of Array.from(this.thumbShots.keys())) {
      if (key.startsWith(prefix)) this.dropThumbShot(key);
    }
  }

  /** 整本范围改动（全部换模板 / 撤销整本快照）：全部丢掉 */
  private clearThumbShots(): void {
    for (const key of Array.from(this.thumbShots.keys())) this.dropThumbShot(key);
    this.thumbShotBytes = 0;
    /*
     * 整本范围改动同时作废所有脱离 DOM 的主画布（INK-229）。
     *
     * 这里是「多页像素可能一起变」的唯一集中点：全部换模板 / 纸张、
     * 撤销重做恢复整本快照都走它。单页改动不走这里（见 changed() 的
     * 按页作废），所以首轮滚动时逐页补抽文字不会把复用机会全抹掉。
     */
    this.invalidateRasterCache();
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
    const haveThumb = this.thumbBitmaps.getEntry(key)?.width ?? 0;
    const haveMain = this.bgBitmaps.getEntry(key)?.width ?? 0;
    // 已经够清晰就不重复渲染。主视图那张只要够大也算数。
    if (Math.max(haveThumb, haveMain) >= want * 0.8) return;
    /*
     * 注意：**不再**「有 bgBitmap 就 return」。
     * 主视图那张可能比缩略图需要的还小（例如缩小状态渲的），
     * 这时仍要渲一张缩略图专用的高清位图，否则缩略图会一直低清（真机「糊成一片」）。
     */
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
          const nowThumb = this.thumbBitmaps.getEntry(job.key)?.width ?? 0;
          const nowMain = this.bgBitmaps.getEntry(job.key)?.width ?? 0;
          if (Math.max(nowThumb, nowMain) >= job.want * 0.8) return;
          const rendered = await renderPdfPage(doc, job.pageNo, job.want);
          const cached = this.thumbBitmaps.set(job.key, rendered.bitmap, rendered.bitmap.width);
          if (!cached) {
            // 单张超缩略图缓存预算（正常不会，尺寸夹在 96~384）：释放，不重试
            try {
              rendered.bitmap.close();
            } catch (_) {
              /* 已关闭就算了 */
            }
            return;
          }
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
    // 插入的图片同样要导出（导出前 waitBackgrounds 已把图加载好）
    this.drawInsertedImages(ctx, page);
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
    // 插入的图片是用户内容，必须在透明叠加层上一起导出（PDF 矢量页也一样）
    this.drawInsertedImages(ctx, page);
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
   * 导出结束后把「超出阅读所需」的 PDF 位图从缓存里丢掉。
   *
   * 为什么需要（2026-11-07 补）：导出会按 `pdfExportWidth`（最长边 4096）
   * 渲染，单张可达 **90.5MB**（4096×5793×4）。这些巨型位图塞进
   * `bgBitmaps`（预算 160MB）后只放得下 1.8 张，把正常阅读用的 1588 位图
   * 全挤出去 —— 用户导出完回到阅读，每翻一页都要重渲。
   *
   * 这里遍历缓存，凡是**比当前阅读目标还宽 1.25 倍以上**的都删掉，
   * 让 LRU 回到「够读就行」的状态。阅读目标由 `pdfTargetWidth` 现算，
   * 所以缩放过的用户也能保住他那档需要的那张。
   */
  pruneOversizedBackgrounds(): void {
    const pages = this.store.data.pages;
    for (const page of pages) {
      const bg = page.background;
      if (!bg?.pdf) continue;
      const key = `${bg.pdf.path}#${bg.pdf.page}`;
      const entry = this.bgBitmaps.getEntry(key);
      if (!entry) continue;
      const need = this.pdfTargetWidth(bg);
      // 只删明显超标的（1.25 倍以内留着，免得缩放一点点就重渲）
      if (entry.width > need * 1.25) this.bgBitmaps.delete(key);
    }
  }

  /**
   * 等「手写」字体就绪（导出/嵌入前需要）。
   *
   * `drawUserTexts` 是把字**画进 canvas**：canvas 的 `font` 一旦解析不到
   * 某个家族就直接用回退字体，而字体是异步解码的 —— 不等它，导出的 PNG/PDF
   * 里手写批注会变成 Noto（黑体），屏幕上却是手写，导出件与屏幕不一致。
   *
   * 失败/环境不支持时也只是不等待（`ensureHandFont` 自己吞掉异常），
   * 导出不会因此失败——顶多是手写档回落到 Noto，和屏幕上的回退一致。
   */
  async waitFonts(): Promise<void> {
    try {
      await ensureHandFont();
      /*
       * 注册完还要等**浏览器真正解码到可用**：`document.fonts.add()` 之后
       * `FontFace.load()` 已经 await 过了，但 canvas 侧要等 `document.fonts.ready`
       * 才保证 measureText/drawText 用的是新字体而不是回退字体。
       */
      await document.fonts?.ready;
    } catch (e) {
      console.warn("[inkbook] 等待手写字体失败，导出可能回落到 Noto", e);
    }
  }

  /**
   * 底图是否都已加载完（导出前需要）。
   *
   * PDF 页是按需渲染的，所以这里要**主动等它渲染完**——
   * 否则导出的 PDF 会缺底图内容。
   */
  /**
   * 导出前**只**等「插入的图片」加载好。
   *
   * 给矢量 PDF 页用：那条路径刻意不渲染底图（省内存），但插入的图片仍要画到
   * 透明叠加层上，所以这里单独等它们，不牵连 PDF 位图。
   */
  async waitInsertedImages(indexes: number[]): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const i of indexes) {
      const imgs = this.store.data.pages[i]?.images;
      if (!imgs?.length) continue;
      for (const im of imgs) {
        if (im?.src && !this.bgImages.has(im.src)) pending.push(this.waitStaticImage(im.src));
      }
    }
    await Promise.all(pending);
  }

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
              /*
               * PDF 这条路径**也要超时**（INK-182）。
               *
               * 上一轮只给静态底图（`new Image()`）加了超时，PDF 渲染这条
               * 漏了——`renderPdfPage` 里 `doc.getPage` / `task.promise` /
               * `createImageBitmap` 任何一步卡住（损坏的 PDF、pdf.js worker
               * 挂掉、显存不足），`await` 就永远不返回 → 整次导出卡死，
               * 取消按钮也无效（取消检查在页循环里，这里还没进循环）。
               * 同一个 bug 的两半，必须一起补。
               */
              const doc = await withTimeout(
                this.openPdfDoc(bg.pdf!.path),
                bgWaitTimeoutMs,
                "打开 PDF"
              );
              const rendered = await withTimeout(
                renderPdfPage(doc, bg.pdf!.page, target),
                bgWaitTimeoutMs,
                "渲染 PDF 页"
              );
              const cached = this.bgBitmaps.set(key, rendered.bitmap, rendered.bitmap.width);
              /*
               * 没进缓存（单张超预算）→ 这张图谁都不持有，必须在这里释放，
               * 否则一张 90MB 的 ImageBitmap 泄漏。导出只用 canvas 画，
               * 不需要它留在缓存里。
               */
              if (!cached) {
                try {
                  rendered.bitmap.close();
                } catch (_) {
                  /* 已关闭就算了 */
                }
                return;
              }
              this.markBgDirty(bg.pdf!.path, bg.pdf!.page);
            } catch (e) {
              console.error("[inkbook] 导出等待 PDF 渲染失败", e);
            }
          })()
        );
        continue;
      }

      const src = bg.src;
      if (src && !this.bgImages.has(src)) pending.push(this.waitStaticImage(src));
    }

    /*
     * 插入的图片也要在导出前加载好，否则导出的 PNG / PDF 里会缺图。
     * 单独一轮扫所有页（包括只有图片、没有底图的页），去重后等它加载完。
     */
    for (const i of indexes) {
      const imgs = this.store.data.pages[i]?.images;
      if (!imgs?.length) continue;
      for (const im of imgs) {
        if (im?.src && !this.bgImages.has(im.src)) pending.push(this.waitStaticImage(im.src));
      }
    }
    await Promise.all(pending);
  }

  /**
   * 导出一张静态图片（底图或插入图片）并等它加载完，带超时。
   *
   * **必须带超时**（INK-181 / 本功能沿用）：`img.onload` / `onerror` 一个都不来
   * （同步盘卡住、资源被删但 URL 还挂着、宿主拦截了资源加载）时，这个 Promise
   * 永不 resolve → `Promise.all` 永不返回 → 整个导出卡死。超时当「取不到」
   * 处理（resolve 而非 reject），导出照常继续，这一张按占位导出。
   */
  private waitStaticImage(src: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const img = new Image();
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(() => {
        if (settled) return;
        console.warn("[inkbook] 导出等待图片超时，这一张按占位导出", src);
        done();
      }, bgWaitTimeoutMs);
      img.onload = () => {
        if (settled) return;
        this.bgImages.set(src, img);
        done();
      };
      img.onerror = () => done();
      img.src = this.resolveAssetUrl(src);
    });
  }

  destroy(): void {
    /*
     * 销毁前兜底提交编辑框里的字：destroy 之后 DOM 清空，textarea 里的
     * 内容再也读不到。force：等不到 compositionend，组字中只提交已上屏部分。
     */
    this.commitTextEditNow(true);
    // commitTextEditNow 在没有编辑框时会提前返回，这里再兜一次，确保候选列表不残留
    this.hideLinkSuggest();
    this.linkTargetsCache = null;
    this.stopFling();
    if (this.scrollSettleTimer) {
      window.clearTimeout(this.scrollSettleTimer);
      this.scrollSettleTimer = 0;
    }
    /*
     * 停掉步进按钮的连调 timer：手指还按着按钮时切文件 / 关标签页，
     * DOM 已拆、pointerup 可能永远等不到，不停的话 timer 会一路按到底，
     * 反复对已销毁的编辑器调 setTextSize。
     */
    for (const stop of this.stepBtnStoppers) stop();
    this.stepBtnStoppers = [];
    this.destroyed = true;
    // 字体到位回调里会重排文字层，销毁后那些 rec 已经没意义了
    this.offHandFont?.();
    this.offHandFont = null;
    this.uninstallEdgeSwipeGuard();
    this.laserTrail = [];
    this.stopLaserFade();
    window.removeEventListener("pointerup", this.globalUp, true);
    window.removeEventListener("pointercancel", this.globalUp, true);
    window.removeEventListener("blur", this.onWindowBlur);
    document.removeEventListener("visibilitychange", this.onVisibilityHidden);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeRaf) cancelAnimationFrame(this.resizeRaf);
    this.resizeRaf = 0;
    if (this.observer) this.observer.disconnect();
    this.observer = null;
    if (this.overlayRaf) cancelAnimationFrame(this.overlayRaf);
    this.overlayRaf = 0;
    this.overlayPending.clear();
    if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
    if (this.wheelRaf) cancelAnimationFrame(this.wheelRaf);
    if (this.pinchStateRaf) cancelAnimationFrame(this.pinchStateRaf);
    this.pinchStateRaf = 0;
    // 释放位图显存和 PDF 文档句柄
    this.bgBitmaps.clear();
    this.thumbBitmaps.clear();
    this.clearThumbShots();
    this.thumbRendering.clear();
    this.thumbQueue.length = 0;
    this.thumbQueued.clear();
    this.bgImages.clear();
    /*
     * `bgTarget` 记的是「每页想要多清晰」，只增不减。
     * 它虽然是实例字段（editor 每次 mountEditor 都重建，能跟着 GC），
     * 但这里其他所有 bg* 容器都清了、独独漏掉它，属于不对称——
     * 将来谁把它改成模块级就会变成真泄漏。顺手清掉，成本为零。
     */
    this.bgTarget.clear();
    this.bgRendering.clear();
    this.bgDirty.clear();
    this.bgLoading.clear();
    for (const p of this.pdfDocs.values()) {
      void p.then((doc) => doc?.destroy?.()).catch(() => {});
    }
    this.pdfDocs.clear();
    window.clearTimeout(this.pinchReleaseTimer);
    this.pinchReleaseTimer = 0;
    this.clearPendingPinch();
    window.clearTimeout(this.textLayerIdleTimer);
    this.textLayerIdleTimer = 0;
    if (this.mountLimitRaf) cancelAnimationFrame(this.mountLimitRaf);
    this.mountLimitRaf = 0;
    this.mountLimitPending = false;
    this.deferredTextLayers.clear();
    // 释放脱离 DOM 的主画布缓存（INK-229）；textLayerCache 同理（旧版漏了）
    this.rasterCache.clear();
    this.rasterCacheBytes = 0;
    this.textLayerCache.clear();
    this.clearLocateHint();
    this.moveText = null;
    this.resizeText = null;
    this.textBarEl = null;
    this.textEditBarEl = null;
    this.selectedTextId = null;
    this.host.innerHTML = "";
  }
}
