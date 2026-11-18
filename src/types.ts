export type ToolId =
  | "pen"
  | "ballpoint"
  | "highlighter"
  | "eraser"
  | "text"
  | "select"
  | "shape"
  | "hand";

export type ShapeKind = "line" | "arrow" | "rect" | "ellipse";
export type TemplateId = "blank" | "lined" | "grid" | "dotted" | "cornell" | "planner";
export type PaperId = "white" | "cream" | "gray";
export type StrokeTool = "pen" | "ballpoint" | "highlighter" | "shape";

export type Pt = [x: number, y: number, pressure: number];

export interface Stroke {
  id: string;
  tool: StrokeTool;
  color: string;
  size: number;
  opacity: number;
  points: Pt[];
  shape?: ShapeKind;
}

/**
 * 页面上的一段文字。
 *
 * 三种来源合在一个数组里，渲染、选中、搜索、导出都走同一条链路：
 *   · `pdf`  —— 导入 PDF 时抽取的原文，只读，画成透明文字（视觉由底图承担）
 *   · `word` —— 导入 Word 时排版的原文，只读，透明文字叠在 PNG 底图上
 *   · `user` —— 手动添加，可编辑、可删除，正常显示颜色
 *
 * 坐标是**页面坐标系**（A4 794×1123），与笔迹共用同一套，缩放时不用换算。
 */
export interface PageText {
  id: string;
  source: "pdf" | "word" | "user";
  /** 左端、基线位置（页面坐标） */
  x: number;
  y: number;
  /** 文本内容；用户文字可以带 \n 换行 */
  text: string;
  /** 字号（页面坐标 px） */
  size: number;
  /** 颜色，仅 user 用 */
  color?: string;
  /** 字体 id（见 editor.ts 的 TEXT_FONTS），仅 user 用；缺省 = 黑体 */
  font?: string;
  /** 字重，仅 user 用 */
  bold?: boolean;
  /**
   * 宽度（页面坐标），导入原文与用户批注含义不同：
   * · pdf / word —— 抽取或排版的真实行宽，用于选中高亮对齐；
   * · user —— 用户手动拖出来的折行宽度上限，决定「一行能放多少字」。
   * 老文件没有这个字段，渲染时按 x 到纸右缘自动算，不升版本、不迁移。
   */
  width?: number;
}

/**
 * 「文件块」的源引用（`PageImage.source`，可选，不升版本）。
 *
 * 文件块的形态是「一张生成好的快照图 + 记住它来自哪个文件」：
 * `src` 是渲染 / 导出出来的快照 PNG，`source` 指回库里的原文件。
 * 有了它，选中文件块时才能显示「打开源文件 / 刷新快照」，并在源文件
 * mtime 变化时提示「源已更新」。
 */
export type PageFileSourceType = "excalidraw" | "markdown" | "text";

export interface PageFileSource {
  /** 源文件库内路径 */
  path: string;
  /** 源文件类型：Excalidraw 导图 / Markdown 笔记 / 纯文本 */
  type: PageFileSourceType;
  /** 生成快照时源文件的 mtime，用来判断「源已更新」；缺省 = 不判断 */
  mtime?: number;
}

/**
 * 页面上插入的一张图片。
 *
 * 与底图（`PageBackground`）区分：底图是"整页的 PDF / Word 原页"，
 * 图片是用户自己插进来的一张图（贴纸 / 截图 / 照片），可以有任意多张、
 * 任意位置大小，和笔迹一样能选中、拖动、缩放、删除、撤销。
 *
 * `src` 存的是**库内路径**（`墨本文件/<token>.墨本/xxx.png`），
 * 和 Word 底板一样用 `adapter.getResourcePath` 加载；不把二进制塞进 JSON，
 * 否则每敲一笔都要重写整张图，几百 KB 的图会让自动保存卡死。
 * 坐标是页面坐标系（A4 794×1123），与笔迹共用同一套。
 */
export interface PageImage {
  id: string;
  /** 图片在库里的路径（相对 .inkbook 所在目录） */
  src: string;
  /** 左上角与大小（页面坐标） */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * 文件块源引用。普通插入的图片没有这个字段；
   * 文件块（Excalidraw / 笔记 / 文本）才有，用来打开源文件与刷新快照。
   */
  source?: PageFileSource;
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  strokes: Stroke[];
}

/**
 * 页面的底图：导入的 PDF / Word 页面。
 *
 * 两种模式：
 * - `src`  —— 已渲染好的静态图（Word 文档、旧的 PNG 底图）
 * - `pdf`  —— 指向 PDF 的某一页，**翻到时才渲染**
 *
 * PDF 用按需渲染而不是预渲染成 PNG：一份几百页的 PDF 预渲染会
 * 阻塞主线程几分钟、把几百 MB 塞进内存、还会在库里堆几百个 PNG。
 */
export interface PageBackground {
  /** 已渲染好的静态底图路径（相对 .inkbook 所在目录）；没有就是普通纸 */
  src?: string;
  /** 按需渲染的 PDF 底图 */
  pdf?: PdfBackgroundRef;
  /** 原始文档名，用于显示 */
  sourceName: string;
  /** 原始文档里的页码（从 1 开始） */
  sourcePage: number;
  /** 底图在页面坐标系里的位置与大小 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 底图类型：pdf 渲染图 / word 文本渲染图 */
  kind: "pdf" | "word";
}

/** 指向 PDF 里的一页 */
export interface PdfBackgroundRef {
  /** PDF 在库里的路径（vault 绝对路径） */
  path: string;
  /** PDF 里的页码（从 1 开始） */
  page: number;
}

export interface Page {
  id: string;
  template: TemplateId;
  paper: PaperId;
  layers: Layer[];
  activeLayerId: string;
  /** 底图（导入的 PDF / Word）；没有就是普通纸 */
  background?: PageBackground;
  /**
   * 页面上的文字：PDF / Word 原文 + 手动添加的。
   * 可选——没有文字的页面不写这个字段，省体积。
   */
  texts?: PageText[];
  /**
   * 页面上插入的图片。
   * 可选——没有图片的页面不写这个字段，省体积。
   */
  images?: PageImage[];
  /**
   * 这一页是否被收藏（左侧抽屉「收藏」标签里能直接看到 / 直接跳过去）。
   * 可选——没收藏的页不写这个字段，省体积。
   */
  favorite?: boolean;
}

/**
 * 本子里的一条目录：名字 + 它指向的页。
 *
 * 用户自己在侧栏加的条目（仿书签）：存的是**页面下标**（0 起），
 * 点击目录项 = 跳到这一页。页序重排后它指向的是"当时的那一页"
 * 在新顺序里的位置——这是下标语义的固有局限，与缩略图长按菜单一致。
 */
export interface Outline {
  id: string;
  title: string;
  /** 指向的目标页（0 起下标） */
  page: number;
}

export interface InkBook {
  /** 文件格式版本。当前是 2（v2 起页面可以带 texts），见 storage.ts 的 CURRENT_VERSION */
  version: number;
  kind: "inkbook";
  title: string;
  width: number;
  height: number;
  /**
   * 落盘时的自检记录：页数 + 笔迹数。
   *
   * 读回来对不上就说明文件不完整（写一半被打断、同步冲突、磁盘满…），
   * 这时宁可提示用户去翻备份，也不要静默按读到的残缺内容打开。
   */
  integrity?: {
    pageCount: number;
    strokeCount: number;
  };
  /** 关联的源文档（导入 PDF / Word 时记录） */
  source?: {
    name: string;
    kind: "pdf" | "word";
    pageCount: number;
    /** 源 PDF 在库里的路径（按需渲染时用） */
    path?: string;
  };
  created: number;
  updated: number;
  activePage: number;
  pages: Page[];
  /**
   * 本子目录：`{ id, title, page }` 数组，page 是 0 起页面下标。
   *
   * 可选字段——老文件没有它，读出来是 undefined，UI 一律按空目录处理。
   * 与 `Page.texts` 同为**不升版本**新增的字段（见 storage.ts 的
   * CURRENT_VERSION 注释）：旧版插件读到未知字段直接忽略，不拒绝打开；
   * 但 normalizeBook 的白名单必须同步重建它，否则第一次保存就会把它抹掉。
   * 空目录不写回字段——保存时不会出现 `"outlines": []`。
   */
  outlines?: Outline[];
  /**
   * 用户显式设过的缩放比（0.3–3.5）。
   *
   * 可选字段，与 `outlines` 同为**不升版本**新增：老文件没有它，
   * 读出来是 undefined = 从未手动缩放过，打开时按窗口大小重新 fit。
   *
   * fit 模式下**不写**这个字段：fit 的 zoom 是按当时窗口尺寸算出来的，
   * 不是用户的选择；存下来换台设备 / 转个方向就会被旧比例锁死。
   * 「字段不存在」本身就表达「下次重新 fit」，不需要再加一个布尔标志
   * （两个字段一旦不同步，就会出现"fit 模式却带着用户 zoom"的坏状态）。
   */
  zoom?: number;
  /**
   * 上次关文件时的页内滚动位置（相对滚动容器的 CSS 像素）。
   *
   * 与 zoom 不同，fit 模式下也保存：窗口尺寸没变时它就是精确落点；
   * 变了也只是略有偏移——仍然比每次回到页首好。0 不写回字段，
   * 「停在页首」是默认行为，没必要为它占体积。
   */
  scrollTop?: number;
  /**
   * 上次关文件时的**水平**页内滚动位置（相对滚动容器的 CSS 像素）。
   *
   * 为什么单独存：放大后纸比容器宽，用户会向右滚去看右边的内容；
   * 以前只记 scrollTop，重开就跳回左边（INK-209）。与 zoom / scrollTop
   * 同为不升版本新增，老文件没有它 = 停在左边。
   *
   * 只有放大到出现横向滚动时才可能有值；未放大时纸是居中的，
   * scrollLeft 恒为 0，这种情况不写回字段（0 是默认行为）。
   */
  scrollLeft?: number;
}

export interface InkbookSettings {
  defaultTemplate: TemplateId;
  defaultPaper: PaperId;
  penOnly: boolean;
  /**
   * 允许手指书写（平板没笔时用手指写）。
   *
   * 侧栏「输入方式」里的开关会写回这里；重启后按这个值恢复。
   * 默认关：手指的第一职责是滚动，单指书写要用户主动打开并承担
   * 「一碰就落笔、滚动改用双指」的代价。
   */
  touchDraw: boolean;
  pressure: number;
  /** 手写平滑 0–1：去手抖，越大越稳 */
  smoothing: number;
  /** 笔画预测：墨迹跑在笔尖前面 */
  prediction: boolean;
  autosave: boolean;
  sidebarOpen: boolean;
  /** 左侧缩略图面板每行显示几页（1–4，默认 4）。 */
  thumbCols: number;
  /** 收藏面板每行显示几页（1–4，默认 2）。 */
  favoriteCols: number;
  /**
   * 钢笔笔尖粗细默认值。
   *
   * 用户要求「每种笔、每种形状各记各的粗细」，所以这里只保存**钢笔**的，
   * 圆珠笔见 defaultBallpointSize，形状见 defaultShapeSizes。
   */
  defaultPenSize: number;
  /** 圆珠笔笔尖粗细默认值（与钢笔分开记忆，互不影响） */
  defaultBallpointSize: number;
  /**
   * 形状线宽默认值：直线 / 箭头 / 矩形 / 椭圆**各记各的**。
   *
   * 老 data.json 没有这个字段时，loadSettings 会从 DEFAULT_SETTINGS 补齐。
   */
  defaultShapeSizes: Record<ShapeKind, number>;
  /** 荧光笔粗细默认值（侧栏「荧光 细/中/粗」选的会写回这里） */
  defaultHighlighterSize: number;
  lastPenColor: string;
  lastHighlighterColor: string;
  /**
   * 橡皮「记忆」：上次选的模式（整笔 / 局部）和大小。
   *
   * 用户要求：按下橡皮不再每次都弹调节框，而是沿用上次设置。光靠编辑器
   * 实例字段只在同一次打开本子期间有效，切本 / 重启就丢；写进设置才能真的
   * 「记住」，和笔色 / 粗细的做法一致。
   */
  lastEraserMode: "whole" | "part";
  lastEraserSize: number;
  /**
   * 写字时屏蔽「左缘右滑弹出文件列表」。
   *
   * 安卓/iPad Obsidian 有这个系统级手势，
   * 用触控笔从左往右写字会被误判成右滑。
   */
  blockEdgeSwipe: boolean;
  /**
   * 在墨本里屏蔽命令面板。
   *
   * 平板上拖右侧滑条（从屏幕上方往下拽的那种手势）会被宿主认成
   * 「下拉打开命令面板」，一拖就弹一层面板出来，写不了字。
   * 开启后命令面板在墨本视图里打不开（命令 id 前缀 command-palette: 一律丢掉），
   * 快捷键 Ctrl/Cmd+P 同样拦下；离开墨本文件即恢复。
   */
  blockCommandPalette: boolean;
  /** 画完自动把笔直的笔迹拉直（只认直线） */
  straightLine: boolean;
  /**
   * 一笔成型（移植自经典手写应用「开启后书写的笔迹会自动识别成相关图形」）。
   * off = 关；lift = 画完立刻自动识别。只有开 / 关两态，开关放在每支笔的
   * 弹出调节框里（钢笔 / 圆珠笔），默认关：老笔记的书写手感一点不变。
   */
  shapeSnap: "off" | "lift";
  /**
   * 激光笔（移植自经典手写应用「点状激光笔 / 线条激光笔」）。
   * 打开后落笔只留一条会淡出的指示光迹，不写进本子、不进撤销栈、不导出。
   */
  laserPointer: boolean;
  /**
   * 生成「文字索引」md，让 Obsidian 全局搜索能搜到本子里的文字。
   *
   * 索引文件与本子同目录、同名前缀（`数学.墨本文字.md`），
   * 里面每页一节 + 一个 `obsidian://inkbook?page=N` 跳页链接。
   * 属于派生数据：删掉不影响本子，下次保存会重建。
   */
  searchIndex: boolean;
  /**
   * 从搜索结果 / 内部链接跳到某一页后，给目标页一个轻微的落点提示。
   *
   * 全局搜索只把「文件路径」交给插件，既拿不到命中行号、也拿不到搜索词，
   * 没法高亮具体那几个字。这句提示只负责「确认落在哪一页、把视线拉回来」，
   * 约 1.8 秒后自动消失，不拦指针、不写进本子文件，也不影响导出的 PDF。
   * 关掉后跳转行为完全不变，只是不再闪这一下。
   */
  jumpHint: boolean;
  /**
   * 自定义快捷键覆盖（动作 id → 键位串，见 src/hotkeys.ts）。
   *
   * 只存**用户改过**的动作；缺省的动作用内置默认键位，所以老 data.json
   * 没有这个字段也能正常工作（无需迁移）。值为空串表示「主动禁用该快捷键」。
   * 动作清单与默认值统一放在 hotkeys.ts 的 HOTKEY_ACTIONS 里。
   */
  hotkeys?: Record<string, string>;
  /**
   * 是否已把旧版散落的插件生成物迁移进「墨本文件/」（一次性）。
   *
   * 老 data.json 没有这个字段 → 视为 false，启动时跑一次迁移后置 true。
   * 之后不再全库读取每本本子，避免每次启动都重读大文件。
   */
  filesMigrated?: boolean;
}

export const A4_WIDTH = 794;
export const A4_HEIGHT = 1123;

/**
 * 全插件共用的手动缩放上下限。
 *
 * 3.5 而不是 4.0：单个画布仍由 editor.ts 的 MAX_CANVAS_PIXELS 动态夹住 dpr，
 * 但更高倍率会同时抬高 MIN_MOUNTED=2 的平板峰值内存，选 3.5 留出安全余量。
 */
export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 3.5;

/**
 * data.json 里可能是旧版本 / 手改的野值，统一处理：
 *   · "hold"（旧版「画线停留识别」）现在并入「开」= 画完立刻识别 → 回落 lift；
 *     用户以前选过停留识别，升级后立刻生效，不再出现「打开了跟没打开一样」；
 *   · "lift" 保留；其余一律 off。
 */
export function normalizeShapeSnap(v: unknown): InkbookSettings["shapeSnap"] {
  return v === "lift" || v === "hold" ? "lift" : "off";
}

export const DEFAULT_SETTINGS: InkbookSettings = {
  defaultTemplate: "grid",
  defaultPaper: "white",
  penOnly: false,
  touchDraw: false,
  pressure: 1,
  smoothing: 0.55,
  prediction: true,
  autosave: true,
  sidebarOpen: true,
  thumbCols: 4,
  favoriteCols: 2,
  defaultPenSize: 2.8,
  defaultBallpointSize: 2.8,
  defaultShapeSizes: { line: 2.8, arrow: 2.8, rect: 2.8, ellipse: 2.8 },
  /**
   * 荧光笔粗细默认值（侧栏「荧光 细/中/粗」选的会写回这里）。
   * 取 HIGHLIGHTER_SIZES 的中间档（16/24/34），与老设置回落值一致。
   */
  defaultHighlighterSize: 24,
  lastPenColor: "#1A1A1A",
  lastHighlighterColor: "#F6E05E",
  lastEraserMode: "part",
  lastEraserSize: 26,
  blockEdgeSwipe: true,
  blockCommandPalette: true,
  straightLine: false,
  // 移植功能默认全关：升级后不改动任何既有书写 / 显示行为。
  shapeSnap: "off",
  laserPointer: false,
  searchIndex: true,
  jumpHint: true,
  filesMigrated: false,
};

export const PEN_COLORS = [
  "#1A1A1A",
  "#1F5FBF",
  "#D64545",
  "#2E8B57",
  "#E08A1E",
  "#7C5CD6",
  "#D64C8F",
  "#6B7280",
];

export const PEN_SIZES = [1.6, 2.8, 4.6];
export const HIGHLIGHTER_SIZES = [16, 24, 34];

export const TEMPLATES: Array<{ id: TemplateId; label: string }> = [
  { id: "blank", label: "空白" },
  { id: "lined", label: "横线" },
  { id: "grid", label: "网格" },
  { id: "dotted", label: "点阵" },
  { id: "cornell", label: "康奈尔" },
  { id: "planner", label: "周计划" },
];

export const PAPERS: Array<{ id: PaperId; label: string }> = [
  { id: "white", label: "纯白" },
  { id: "cream", label: "米黄" },
  { id: "gray", label: "浅灰" },
];

export function uid(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function createLayer(name = "笔迹层"): Layer {
  return { id: uid("layer"), name, visible: true, opacity: 1, strokes: [] };
}

export function createPage(template: TemplateId, paper: PaperId): Page {
  const layer = createLayer();
  return {
    id: uid("page"),
    template,
    paper,
    layers: [layer],
    activeLayerId: layer.id,
  };
}

export function createBook(
  title: string,
  template: TemplateId = "grid",
  paper: PaperId = "white"
): InkBook {
  return {
    version: 1,
    kind: "inkbook",
    title: title || "未命名笔记",
    width: A4_WIDTH,
    height: A4_HEIGHT,
    created: Date.now(),
    updated: 0,
    activePage: 0,
    pages: [createPage(template, paper)],
  };
}

export function activeLayer(page: Page): Layer {
  return page.layers.find((l) => l.id === page.activeLayerId) ?? page.layers[0];
}
