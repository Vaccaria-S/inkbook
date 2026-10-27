import { FileView, Menu, Notice, type TFile } from "obsidian";
import { setIcon } from "./icons";
import { BookEditor } from "./editor";
import { BookStore } from "./store";
import { readBook, writeBook } from "./storage";
import {
  A4_HEIGHT,
  A4_WIDTH,
  HIGHLIGHTER_SIZES,
  PAPERS,
  PEN_COLORS,
  PEN_SIZES,
  TEMPLATES,
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
  { id: "lasso", icon: "lasso", name: "套索 (L)", short: "套索" },
  { id: "shape", icon: "square", name: "形状 (R)", short: "形状" },
  { id: "hand", icon: "hand", name: "拖动画布", short: "拖动" },
];

const SHAPES: Array<{ id: ShapeKind; label: string }> = [
  { id: "rect", label: "矩形" },
  { id: "ellipse", label: "椭圆" },
  { id: "line", label: "直线" },
  { id: "arrow", label: "箭头" },
];

function debounce<T extends (...args: any[]) => void>(fn: T, wait: number): T & {
  cancel: () => void;
} {
  let t: number | null = null;
  const wrapped = ((...args: any[]) => {
    if (t) window.clearTimeout(t);
    t = window.setTimeout(() => {
      t = null;
      fn(...args);
    }, wait);
  }) as T & { cancel: () => void };
  wrapped.cancel = () => {
    if (t) window.clearTimeout(t);
    t = null;
  };
  return wrapped;
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

  private railEl!: HTMLElement;
  private railReadBtn!: HTMLButtonElement;
  private railSideBtn!: HTMLButtonElement;
  private readHintEl!: HTMLElement;
  private floatEl!: HTMLElement;
  private floatZoomEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private editorHost!: HTMLElement;
  private paperHost!: HTMLElement;
  private sideEl!: HTMLElement;
  private dynEl!: HTMLElement;
  private pageLbl!: HTMLElement;
  private zoomLbl!: HTMLElement;
  private statusEl!: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private delSelBtn!: HTMLButtonElement;
  private stylusBtn!: HTMLButtonElement;
  private toolButtons = new Map<ToolId, HTMLButtonElement>();
  private sideBtn!: HTMLButtonElement;
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
  private saving = false;
  private saveAgain = false;
  private readOnly = false;
  private saveState: "saved" | "dirty" | "saving" = "saved";
  private _loadToken = 0;
  private saveDebounce = debounce(() => this.saveNow(), 850);
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
  }

  async onClose(): Promise<void> {
    if (this.store && this.editor) this.store.data.activePage = this.editor.getState().pageIndex;
    await this.flushSave();
    this.destroyEditor();
  }

  /* ------------------------------- 文件 ------------------------------- */

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
    try {
      const book = await readBook(this.app.vault.adapter, file.path, file.basename);
      if (token !== this._loadToken) return;
      this.store = new BookStore(book);
      this.store.onChange = () => this.markDirty();
      this.readOnly = false;
      this.destroyEditor();
      this.buildUI();
      this.mountEditor(book.activePage || 0);
    } catch (e: any) {
      console.error("[inkbook] 读取失败", e);
      this.showError("打不开：" + (e && e.message ? e.message : e));
      this.readOnly = true;
    }
  }

  async onUnloadFile(): Promise<void> {
    if (this.store && this.editor) this.store.data.activePage = this.editor.getState().pageIndex;
    if (this.store && this.editor) this.dirty = true;
    await this.flushSave();
    this.destroyEditor();
    this.store = null;
    this.file = null;
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
      onState: () => this.updateUI(),
      onChange: () => this.markDirty(),
      onPageChange: () => this.onPageChanged(),
    });
    this.editor.penColor = this.plugin.settings.lastPenColor || "#1A1A1A";
    this.editor.penSize = this.plugin.settings.defaultPenSize || 2.8;
    this.editor.highlighterColor = this.plugin.settings.lastHighlighterColor || "#F6E05E";
    this.buildRail();
    this.buildFloat();
    this.buildSide();
    this.updateUI();
    this.saveState = "saved";
    this.updateStatus();
  }

  private destroyEditor(): void {
    this.editor?.destroy();
    this.editor = null;
    window.clearTimeout(this.hintTimer);
    window.clearTimeout(this.zoomHintTimer);
    this.railEl?.remove();
    this.floatEl?.remove();
    this.sideEl?.empty();
    this.toolButtons.clear();
    this.railEl = null as any;
    this.floatEl = null as any;
    this.layerListEl = null;
    this.pageListEl = null;
    this.templateGrid = null;
    this.paperRow = null;
    this.statsEl = null;
    this.thumbCanvases = [];
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
    this.applySideVisibility();
  }

  /** 侧栏显隐：仅阅读时一律收起来，把屏幕让给纸 */
  private applySideVisibility(): void {
    this.sideEl?.toggleClass("is-hidden", this.reading || !this.sideShown);
  }

  private buildUI(): void {
    const root = this.contentEl;
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
    this.railEl?.remove();
    this.floatEl?.remove();
    this.sideEl?.empty();
    this.editorHost.empty();
    const box = this.editorHost.createDiv("mb-empty");
    box.createDiv({ cls: "mb-empty-mark", text: "墨" });
    box.createEl("h3", { text: "新建一本手写本" });
    box.createEl("p", {
      text: "A4 纸、压感笔锋、纸张模板、图层、套索、连续翻页。写满一页就往下加。",
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
    if (!this.editorHost) return;
    this.editorHost.empty();
    const el = this.editorHost.createDiv("mb-error");
    el.createEl("h3", { text: "打不开" });
    el.createEl("p", { text: msg });
  }

  /* ------------------------------- 竖长条 ------------------------------- */

  /**
   * 构建右侧的**竖长条**（工具栏）。
   *
   * 布局上是编辑区右缘的一整列，不是浮在纸上的浮层——
   * 之前浮层压在滚动条上，想拖滚动条得先把工具挪开，
   * 用户反馈"边上的那个框会挡住滑动页面的那个条"。
   *
   * 长条上只留三样东西：
   *   · 7 个笔工具（大图标 + 文字标签）
   *   · 侧栏开关（展开/收起右侧栏）
   *   · 仅阅读开关
   *
   * 其余功能（颜色、导出、导入、模板、图层……）全在右侧栏里，
   * 不再塞进长条，也不再有"更多"抽屉。
   */
  private buildRail(): void {
    this.railEl?.remove();
    const rail = this.editorHost.createDiv("mb-rail");
    this.railEl = rail;
    this.toolButtons.clear();

    const toolCol = rail.createDiv("mb-rail-tools");
    for (const t of TOOLS) {
      const b = toolCol.createEl("button", {
        cls: "mb-rail-tool",
        attr: { "aria-label": t.name },
      });
      setIcon(b, t.icon);
      b.createSpan({ cls: "mb-rail-lbl", text: t.short });
      b.title = t.name;
      b.onclick = () => this.editor?.setTool(t.id);
      this.toolButtons.set(t.id, b);
    }

    /* 分隔线：把"选笔"和"开关"在视觉上分开 */
    rail.createDiv("mb-rail-sep");

    /*
     * 侧栏开关。
     *
     * 之前这个按钮藏在控制坞的"更多"页里，用户反馈
     * "不用再叠放到其他图标里面了"——所以直接放到长条上，
     * 一眼就能看见、一按就能展开侧栏。
     */
    const railSide = rail.createEl("button", {
      cls: "mb-rail-side",
      attr: {
        "aria-label": "显示 / 隐藏侧栏",
        "aria-expanded": "false",
        "aria-controls": "mb-side",
      },
    });
    setIcon(railSide, "panel-right");
    railSide.title = "显示 / 隐藏侧栏";
    railSide.onclick = () => this.toggleSide();
    this.railSideBtn = railSide;
    this.sideBtn = railSide;

    /* 「仅阅读」开关：进去就只剩纸，长条淡出 */
    const railRead = rail.createEl("button", {
      cls: "mb-rail-read",
      attr: {
        "aria-label": "进入仅阅读模式",
        "aria-pressed": "false",
      },
    });
    setIcon(railRead, "eye");
    railRead.title = "仅阅读模式";
    railRead.onclick = () => this.setReading(!this.reading);
    this.railReadBtn = railRead;

    /* ---------------------------- 仅阅读提示 ---------------------------- */
    const hint = this.editorHost.createDiv({
      cls: "mb-read-hint",
      text: "仅阅读模式 · 点右侧长条开始书写",
    });
    this.readHintEl = hint;

    this.setReading(this.reading);
  }

  /* ------------------------------ 右下角浮标 ------------------------------ */

  /**
   * 右下角浮标：翻页 + 缩放。
   *
   * 为什么放到外边（而不是侧栏里）：
   *   翻页和缩放是**看**笔记时最常用的两个动作，
   *   却藏在侧栏深处，每次都要展开侧栏才能够到。
   *   浮在纸的右下角，随时可点。
   *
   * 缩放那一组**平时不显示**，只在真的缩放了才浮现：
   *   · 不操作的时候右下角干干净净，不干扰写字
   *   · 一缩放就报出确切数值（150% / 80%），不用猜
   *   · 停止操作几秒后自动淡出，鼠标悬停时保持可见
   */
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
    this.reading = on;
    this.contentEl.toggleClass("is-reading", on);
    this.editor?.setReadOnly(on);
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

    if (s.tool === "lasso") {
      this.dynEl.createSpan({ cls: "mb-hint", text: "圈选笔迹，拖动可移动，Del 删除" });
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
      this.markDirty();
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
    menu.showAtMouseEvent(e);
  }

  private async runExport(kind: "png" | "pdf"): Promise<void> {
    if (!this.editor || !this.file) return;
    try {
      const scale = 2;
      if (kind === "png") await exportPagePng(this.app.vault, this.editor, this.file, scale);
      else await exportBookPdf(this.app.vault, this.editor, this.file, scale);
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
    this.delSelBtn = actRow.createEl("button", {
      cls: "mb-ib mb-del-sel",
      attr: { "aria-label": "删除选中的笔迹" },
    });
    this.delSelBtn.title = "删除选中的笔迹 (Delete)";
    setIcon(this.delSelBtn, "trash-2");
    this.delSelBtn.onclick = () => this.editor?.deleteSelection();
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
      this.editor?.setTouchDraw(!!on);
      this.updateUI();
      new Notice(on ? "已允许手指书写" : "手指只负责滚动页面", 2200);
    };
    this.stylusBtn = inputRow.createEl("button", {
      cls: "mb-ib",
      attr: { "aria-label": "只认触控笔 (T)" },
    });
    this.stylusBtn.title = "只认触控笔：手指只滚动，掌根不落笔 (T)";
    setIcon(this.stylusBtn, "tablet");
    this.stylusBtn.onclick = () => {
      const on = !this.plugin.settings.penOnly;
      this.plugin.settings.penOnly = on;
      void this.plugin.saveSettings();
      this.editor?.setPenOnly(on);
      this.updateUI();
      new Notice(on ? "只认触控笔：手指只滚动" : "手指和鼠标也能写", 2500);
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
    this.renderPageList();

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

    // 只在缩略图进入可视区时才绘制
    this.observeThumbs();
    // 当前页和相邻几页先画出来，其余等滚动
    this.drawThumbRange(current, 2);
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
    if (this.pageCountSig !== this.store.pageCount) {
      this.renderPageList();
      return;
    }
    // 只重画当前页附近的缩略图——其余等滚进视口时再画
    this.drawThumbRange(this.store.data.activePage, 2);
    const current = this.store.data.activePage;
    this.pageListEl?.querySelectorAll(".mb-thumb").forEach((el) => {
      if (!(el as HTMLElement).dataset.page) return;
      el.toggleClass("is-active", Number((el as HTMLElement).dataset.page) === current);
    });
    this.renderStats();
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
    if (this.zoomLbl) this.zoomLbl.setText(Math.round(s.zoom * 100) + "%");
    if (this.undoBtn) this.undoBtn.toggleClass("is-disabled", !s.canUndo);
    if (this.redoBtn) this.redoBtn.toggleClass("is-disabled", !s.canRedo);
    if (this.delSelBtn) this.delSelBtn.toggleClass("is-hidden", s.selectionCount === 0);
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
    if (this.pageCountSig !== s.pageCount) this.renderPageList();

    if (this.pageListEl) {
      this.pageListEl.querySelectorAll(".mb-thumb").forEach((el) => {
        const page = (el as HTMLElement).dataset.page;
        if (!page) return;
        el.toggleClass("is-active", Number(page) === s.pageIndex);
      });
    }

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
    this.dirty = true;
    if (this.plugin.settings.autosave) this.saveDebounce();
    this.updateUI();
    this.thumbDebounce();
  }

  private markDirty(): void {
    this.dirty = true;
    this.saveState = "dirty";
    this.updateStatus();
    if (this.plugin.settings.autosave) this.saveDebounce();
    this.thumbDebounce();
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    const text =
      this.saveState === "saving" ? "保存中…" : this.saveState === "dirty" ? "未保存" : "已保存";
    this.statusEl.setText(text);
    this.statusEl.toggleClass("is-dirty", this.saveState !== "saved");
  }

  /* ------------------------------- 保存 ------------------------------- */

  async saveNow(): Promise<void> {
    if (!this.store || !this.file || this.readOnly) return;
    if (this.saving) {
      this.saveAgain = true;
      return;
    }
    this.saving = true;
    this.saveAgain = false;
    this.saveState = "saving";
    this.updateStatus();
    try {
      if (this.editor) this.store.data.activePage = this.editor.getState().pageIndex;
      await writeBook(this.app.vault.adapter, this.file.path, this.store.data);
      this.dirty = false;
      this.saveState = "saved";
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

  async flushSave(): Promise<void> {
    this.saveDebounce.cancel();
    if (this.dirty) await this.saveNow();
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
    if (e.key === "Delete" || e.key === "Backspace") {
      if (this.editor.getState().selectionCount) {
        e.preventDefault();
        this.editor.deleteSelection();
      }
      return;
    }
    if (e.key === "Escape") {
      // 逐级退出：有选区先清选区 → 再收起侧栏 → 最后切仅阅读
      if (this.editor.getState().selectionCount) {
        this.editor.clearSelection();
      } else if (this.sideShown) {
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
    else if (k === "l") this.editor.setTool("lasso");
    else if (k === "r") this.editor.setTool("shape");
    else if (k === "t") {
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
    this.editor.penSize = this.plugin.settings.defaultPenSize;
    this.updateUI();
  }
}
