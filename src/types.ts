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
 * 两种来源合在一个数组里，渲染、选中、搜索、导出都走同一条链路：
 *   · `pdf`  —— 导入 PDF 时抽取的原文，只读，画成透明文字（视觉由底图承担）
 *   · `user` —— 手动添加，可编辑、可删除，正常显示颜色
 *
 * 坐标是**页面坐标系**（A4 794×1123），与笔迹共用同一套，缩放时不用换算。
 */
export interface PageText {
  id: string;
  source: "pdf" | "user";
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
   * 宽度（页面坐标），两种 source 含义不同：
   * · pdf —— 从 PDF 抽出来的真实行宽，用于选中高亮对齐，比重新量一遍准；
   * · user —— 用户手动拖出来的折行宽度上限，决定「一行能放多少字」。
   * 老文件没有这个字段，渲染时按 x 到纸右缘自动算，不升版本、不迁移。
   */
  width?: number;
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
   * 页面上的文字：PDF 原文 + 手动添加的。
   * 可选——没有文字的页面不写这个字段，省体积。
   */
  texts?: PageText[];
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
   * 用户显式设过的缩放比（0.3–2.8）。
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
  defaultPenSize: number;
  /** 荧光笔粗细默认值（侧栏「荧光 细/中/粗」选的会写回这里） */
  defaultHighlighterSize: number;
  lastPenColor: string;
  lastHighlighterColor: string;
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
}

export const A4_WIDTH = 794;
export const A4_HEIGHT = 1123;

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
  defaultPenSize: 2.8,
  /**
   * 荧光笔粗细默认值（侧栏「荧光 细/中/粗」选的会写回这里）。
   * 取 HIGHLIGHTER_SIZES 的中间档（16/24/34），与老设置回落值一致。
   */
  defaultHighlighterSize: 24,
  lastPenColor: "#1A1A1A",
  lastHighlighterColor: "#F6E05E",
  blockEdgeSwipe: true,
  blockCommandPalette: true,
  straightLine: false,
  searchIndex: true,
  jumpHint: true,
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
export const HIGHLIGHTER_OPACITY = 0.32;

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
