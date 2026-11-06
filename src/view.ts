import { FileView, Menu, Notice, type TFile } from "obsidian";
import { setIcon } from "./icons";
import { BookEditor, TEXT_FONTS } from "./editor";
import { writeTextIndex } from "./indexer";
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
  type PaperId,
  type ShapeKind,
  type TemplateId,
  type ToolId,
} from "./types";
import { paintPaperPreview } from "./paper";
import { NewBookModal, JumpPageModal, PromptModal, ImportSourceModal, ImportRangeModal } from "./modals";
import { importPdf, importWord } from "./importer";
import { exportBookPdf, exportPagePng } from "./export";

export const VIEW_TYPE = "inkbook-view";

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
  private stylusBtn!: HTMLButtonElement;
  private toolButtons = new Map<ToolId, HTMLButtonElement>();
  private sideBtn!: HTMLElement;
  private layerListEl: HTMLElement | null = null;
  private pageListEl: HTMLElement | null = null;
  private templateGrid: HTMLElement | null = null;
  private paperRow: HTMLElement | null = null;
  private statsEl: HTMLElement | null = null;
  private thumbCanvases: HTMLCanvasElement[] = [];
  /** 缩略图懒渲染：滚进视口才画，避免几百页时卡顿 */
  private thumbObserver: IntersectionObserver | null = null;
  private templateCards = new Map<TemplateId, HTMLElement>();
  private paperChips = new Map<PaperId, HTMLElement>();
  private layerSig = "";
  private pageCountSig = -1;
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
  private readOnly = false;
  private saveState: "saved" | "dirty" | "saving" = "saved";
  /** 打开中的占位（见 showLoading）；没有占位时是 null */
  private loadingEl: HTMLElement | null = null;
  private _loadToken = 0;
  // 连写一整页时每笔都重置 850ms 尾沿，必须有个最大等待兜底（10s）
  private saveDebounce = debounce(() => this.saveNow(), 850, 10_000);
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
      if (document.visibilityState === "hidden") void this.flushSave();
    });
    this.registerDomEvent(window, "pagehide", () => void this.flushSave());
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
    if (this.savedActivePage !== this.store.data.activePage) this.metaDirty = true;
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
        const cv = this.thumbCanvases[i];
        if (cv && cv.isConnected) this.editor?.renderThumbnail(cv, i);
      },
    });
    this.editor.penColor = this.plugin.settings.lastPenColor || "#1A1A1A";
    this.editor.penSize = this.plugin.settings.defaultPenSize || 2.8;
    this.editor.highlighterColor = this.plugin.settings.lastHighlighterColor || "#F6E05E";
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
      this.pendingPage = null;
      requestAnimationFrame(() => this.editor?.goToPage(p, false));
    }
  }

  private destroyEditor(): void {
    this.editor?.destroy();
    this.editor = null;
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
    this.floatEl = null as any;
    this.layerListEl = null;
    this.pageListEl = null;
    this.templateGrid = null;
    this.paperRow = null;
    this.statsEl = null;
    // 侧栏收起时列表可能还没建，观察器只在 renderPageList 里断会漏
    this.thumbObserver?.disconnect();
    this.thumbObserver = null;
    this.thumbCanvases = [];
    this.activeThumbEl = null;
    this.templateCards.clear();
    this.paperChips.clear();
    this.layerSig = "";
    this.pageCountSig = -1;
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
     */
    if (visible) this.refreshThumbs();
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
      b.onclick = () => this.editor?.setTool(t.id);
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
      };
      return;
    }

    if (s.tool === "text") {
      this.dynEl.createSpan({
        cls: "mb-hint",
        text: "点页面输入；点已有文字选中，再点一次编辑",
      });

      /*
       * 这三组控制「新建文字」的默认样式；
       * 如果此刻已选中某段文字，改这里会直接改那段（editor 的 setter 会转发）。
       */

      // 字号
      const seg = this.dynEl.createDiv("mb-seg");
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

      // 字体
      const fontSel = this.dynEl.createEl("select", {
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

      // 颜色
      const crow = this.dynEl.createDiv("mb-tcolor-row");
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
    // 编辑框里没提交的文字先落库，否则导出的文件会少这一段
    this.editor.commitTextEditNow();
    try {
      const scale = 2;
      if (kind === "png") await exportPagePng(this.app.vault, this.editor, this.file, scale);
      else await exportBookPdf(this.app.vault, this.editor, this.file, scale, range);
    } catch (e: any) {
      new Notice("导出失败：" + (e && e.message ? e.message : e), 8000);
    }
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
      b.onclick = () => {
        this.editor?.setTool("pen");
        this.editor?.setPenColor(c);
        this.updateUI();
      };
    }
    const penSizes = penSec.createDiv("mb-size-row");
    penSizes.createSpan({ cls: "mb-row-label", text: "钢笔" });
    for (let i = 0; i < PEN_SIZES.length; i++) {
      const b = penSizes.createEl("button", {
        cls: "mb-size-btn",
        text: ["细", "中", "粗"][i],
      });
      b.onclick = () => {
        this.editor?.setTool("pen");
        this.editor?.setPenSize(PEN_SIZES[i]);
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
        this.updateUI();
      };
    }
    const hlSizes = penSec.createDiv("mb-size-row");
    hlSizes.createSpan({ cls: "mb-row-label", text: "荧光" });
    for (let i = 0; i < HIGHLIGHTER_SIZES.length; i++) {
      const b = hlSizes.createEl("button", {
        cls: "mb-size-btn",
        text: ["细", "中", "粗"][i],
      });
      b.onclick = () => {
        this.editor?.setTool("highlighter");
        this.editor?.setHighlighterSize(HIGHLIGHTER_SIZES[i]);
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
      p.layers.map((l) => `${l.id}:${l.name}:${l.visible}:${l.strokes.length}`).join(",")
    );
  }

  /**
   * 渲染侧栏页列表。
   *
   * 大 PDF 可能有几百页——每页都建 canvas 并立刻绘制会明显卡顿。
   * 所以改成**懒渲染**：先只建 DOM（便宜），真正画缩略图
   * 交给 IntersectionObserver，只在缩略图滚进可视区时才画。
   */
  private renderPageList(): void {
    if (!this.pageListEl || !this.store || !this.editor) return;
    this.pageListEl.empty();
    this.thumbCanvases = [];
    this.thumbObserver?.disconnect();
    this.thumbObserver = null;
    const count = this.store.pageCount;
    const current = this.store.data.activePage;
    for (let i = 0; i < count; i++) {
      const item = this.pageListEl.createDiv("mb-thumb" + (i === current ? " is-active" : ""));
      item.dataset.page = String(i);
      const cv = document.createElement("canvas");
      cv.className = "mb-thumb-canvas";
      item.appendChild(cv);
      item.createDiv({ cls: "mb-thumb-num", text: String(i + 1) });
      const dup = item.createEl("button", { cls: "mb-thumb-act mb-thumb-dup", attr: { "aria-label": "复制本页" } });
      setIcon(dup, "copy");
      dup.onclick = (e) => {
        e.stopPropagation();
        this.editor?.duplicatePage(i);
      };
      if (count > 1) {
        const del = item.createEl("button", {
          cls: "mb-thumb-act mb-thumb-del",
          attr: { "aria-label": "删除本页" },
        });
        setIcon(del, "trash-2");
        del.onclick = (e) => {
          e.stopPropagation();
          this.editor?.deletePage(i);
        };
      }
      item.onclick = () => this.editor?.goToPage(i);
      this.thumbCanvases.push(cv);
    }
    const add = this.pageListEl.createDiv("mb-thumb mb-thumb-add");
    add.createDiv({ cls: "mb-thumb-plus", text: "+" });
    add.createDiv({ cls: "mb-thumb-add-label", text: "加一页" });
    add.onclick = () => this.editor?.addPage();
    this.pageCountSig = count;
    this.activeThumbEl = (this.thumbCanvases[current]?.parentElement as HTMLElement) ?? null;

    // 只在缩略图进入可视区时才绘制
    this.observeThumbs();
    /*
     * 先只画当前页；相邻页延到空闲时再画。
     * 857 页的本子打开时，5 张缩略图会同时排进 pdf.js 的渲染队列，
     * 和首屏那一页抢 IO/CPU，用户感觉就是「打开半天」。
     */
    this.drawThumbRange(current, 0);
    const idle = (window as any).requestIdleCallback as
      | ((cb: () => void, opts?: { timeout: number }) => number)
      | undefined;
    if (typeof idle === "function") idle(() => this.drawThumbRange(current, 2), { timeout: 1200 });
    else window.setTimeout(() => this.drawThumbRange(current, 2), 300);
  }

  /** 只切换新旧两个缩略图的选中态（不扫全列表） */
  private setActiveThumb(index: number): void {
    const next = (this.thumbCanvases[index]?.parentElement as HTMLElement) ?? null;
    if (next === this.activeThumbEl) return;
    this.activeThumbEl?.classList.remove("is-active");
    next?.classList.add("is-active");
    this.activeThumbEl = next;
  }

  /** 监听缩略图可见性，进入视口才渲染 */
  private observeThumbs(): void {
    if (typeof IntersectionObserver === "undefined") {
      // 兜底：没有 IO 就全画
      for (let i = 0; i < this.thumbCanvases.length; i++) {
        this.editor?.renderThumbnail(this.thumbCanvases[i], i);
      }
      return;
    }
    this.thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          const idx = Number(el.dataset.page);
          if (!Number.isFinite(idx)) continue;
          this.editor?.renderThumbnail(this.thumbCanvases[idx], idx);
        }
      },
      { root: this.pageListEl?.parentElement ?? null, rootMargin: "300px 0px" }
    );
    const list = this.pageListEl;
    if (!list) return;
    for (const item of Array.from(list.children)) {
      if (item.classList.contains("mb-thumb-add")) continue;
      this.thumbObserver.observe(item);
    }
  }

  /** 画一段范围内的缩略图（当前页附近） */
  private drawThumbRange(center: number, span: number): void {
    const lo = Math.max(0, center - span);
    const hi = Math.min(this.thumbCanvases.length - 1, center + span);
    for (let i = lo; i <= hi; i++) {
      this.editor?.renderThumbnail(this.thumbCanvases[i], i);
    }
  }

  private refreshThumbs(): void {
    if (!this.editor || !this.store) return;
    this.renderStats();
    /*
     * 侧栏收起 / 仅阅读：页列表和缩略图都看不见，什么活都不用干。
     * 这条也覆盖了「写字时 markDirty → thumbDebounce → refreshThumbs」——
     * 侧栏没开时不会在每次停顿后去重画 5 张缩略图（PDF 页很贵）。
     */
    if (!this.thumbVisible()) return;
    if (this.pageCountSig !== this.store.pageCount) {
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

  private updateUI(): void {
    if (!this.editor) return;
    const s = this.editor.getState();

    for (const [id, btn] of this.toolButtons) btn.toggleClass("is-active", id === s.tool);

    if (this.pageLbl) this.pageLbl.setText(`${s.pageIndex + 1} / ${s.pageCount}`);
    if (this.sbTip) this.sbTip.setText(`${s.pageIndex + 1} / ${s.pageCount}`);
    // 页数变了滑条的高度比例也变了；合并到一帧里算，别每笔都量一遍
    this.requestScrollbarSync();
    // 宿主重建标题栏时会把我们那一行一起清掉，发现掉了就重装
    if (this.topRowEl && !this.topRowEl.parentElement) this.buildHeaderActions();
    if (this.zoomLbl) this.zoomLbl.setText(Math.round(s.zoom * 100) + "%");
    if (this.undoBtn) this.undoBtn.toggleClass("is-disabled", !s.canUndo);
    if (this.redoBtn) this.redoBtn.toggleClass("is-disabled", !s.canRedo);
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

    this.renderColors();
    this.renderDynamicTools();

    if (this.layerSig !== this.layerSignature()) this.renderLayers();
    // 侧栏收起时不建页列表（首次展开由 applySideVisibility → refreshThumbs 补建）
    if (this.thumbVisible() && this.pageCountSig !== s.pageCount) this.renderPageList();

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
    if (page !== this.savedActivePage) this.metaDirty = true;
    this.updateUI();
    this.thumbDebounce();
  }

  private markDirty(): void {
    this.dirty = true;
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
   */
  gotoPageFromLink(page1: number): void {
    const idx = Math.max(0, Math.round(Number(page1) || 1) - 1);
    if (this.editor) {
      this.editor.goToPage(idx, false);
      this.pendingPage = null;
    } else {
      this.pendingPage = idx;
    }
  }

  async saveNow(): Promise<void> {
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

      await writeBook(adapter, path, this.store.data);
      this.dirty = false;
      this.metaDirty = false;
      this.saveState = "saved";
      this.savedActivePage = this.store.data.activePage;
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
    this.saveDebounce.cancel();
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
    if (k === "p") this.editor.setTool("pen");
    else if (k === "b") this.editor.setTool("ballpoint");
    else if (k === "h") this.editor.setTool("highlighter");
    else if (k === "e") this.editor.setTool("eraser");
    else if (k === "v") this.editor.setTool("select");
    else if (k === "r") this.editor.setTool("shape");
    else if (k === "t") this.editor.setTool("text");
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
    this.editor.setPressure(this.plugin.settings.pressure);
    this.editor.setSmoothing(this.plugin.settings.smoothing ?? 0.55);
    this.editor.setPrediction(this.plugin.settings.prediction !== false);
    this.editor.setEdgeSwipeBlock(this.plugin.settings.blockEdgeSwipe !== false);
    this.editor.setStraighten(this.plugin.settings.straightLine === true);
    this.editor.penSize = this.plugin.settings.defaultPenSize;
    this.updateUI();
  }
}
