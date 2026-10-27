export type ToolId =
  | "pen"
  | "ballpoint"
  | "highlighter"
  | "eraser"
  | "lasso"
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
}

export interface InkBook {
  /** 文件格式版本。当前支持 1，见 storage.ts 的 CURRENT_VERSION */
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
}

export interface InkbookSettings {
  defaultTemplate: TemplateId;
  defaultPaper: PaperId;
  penOnly: boolean;
  pressure: number;
  /** 手写平滑 0–1：去手抖，越大越稳 */
  smoothing: number;
  /** 笔画预测：墨迹跑在笔尖前面 */
  prediction: boolean;
  autosave: boolean;
  sidebarOpen: boolean;
  defaultPenSize: number;
  lastPenColor: string;
  lastHighlighterColor: string;
  /**
   * 写字时屏蔽「左缘右滑弹出文件列表」。
   *
   * 安卓/iPad Obsidian 有这个系统级手势，
   * 用触控笔从左往右写字会被误判成右滑。
   */
  blockEdgeSwipe: boolean;
}

export const A4_WIDTH = 794;
export const A4_HEIGHT = 1123;

export const DEFAULT_SETTINGS: InkbookSettings = {
  defaultTemplate: "grid",
  defaultPaper: "white",
  penOnly: false,
  pressure: 1,
  smoothing: 0.55,
  prediction: true,
  autosave: true,
  sidebarOpen: true,
  defaultPenSize: 2.8,
  lastPenColor: "#1A1A1A",
  lastHighlighterColor: "#F6E05E",
  blockEdgeSwipe: true,
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
