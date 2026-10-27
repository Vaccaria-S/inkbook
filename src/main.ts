import { FuzzySuggestModal, Plugin, type App, type TFile } from "obsidian";
import { InkbookView, VIEW_TYPE } from "./view";
import { InkbookSettingTab, DEFAULT_SETTINGS } from "./settings";
import { NewBookModal } from "./modals";
import type { InkbookSettings } from "./types";

class BookPickerModal extends FuzzySuggestModal<TFile> {
  private choose: (file: TFile) => void;

  constructor(app: App, open: (file: TFile) => void) {
    super(app);
    this.choose = open;
    this.setPlaceholder("选择一本 .inkbook 手写本…");
  }

  getItems(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((f) => (f.extension || "").toLowerCase() === "inkbook")
      .sort((a, b) => a.basename.localeCompare(b.basename));
  }

  getItemText(item: TFile): string {
    return item.path;
  }

  onChooseItem(item: TFile): void {
    this.choose(item);
  }
}

export default class InkbookPlugin extends Plugin {
  settings: InkbookSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new InkbookView(leaf, this));

    try {
      this.registerExtensions(["inkbook"], VIEW_TYPE);
    } catch (e) {
      console.warn("[inkbook] .inkbook 扩展名已被占用", e);
    }

    this.addRibbonIcon("notebook", "墨本：新建手写本", () => this.openNewBook());
    this.addRibbonIcon("book-open", "墨本：打开手写本", () => this.openPicker());

    this.addCommand({
      id: "inkbook-new",
      name: "新建手写本（A4 手写笔记）",
      callback: () => this.openNewBook(),
    });

    this.addCommand({
      id: "inkbook-open",
      name: "打开手写本（从库中选择）",
      callback: () => this.openPicker(),
    });

    this.addCommand({
      id: "inkbook-current",
      name: "用墨本打开当前文件",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || (f.extension || "").toLowerCase() !== "inkbook") return false;
        if (checking) return true;
        this.app.workspace.getLeaf("tab").openFile(f);
        return true;
      },
    });

    this.addSettingTab(new InkbookSettingTab(this.app, this));

    this.installSwipeGuard();
  }

  /**
   * 拦截宿主的横向滑动事件派发。
   *
   * 安卓/iPad Obsidian 从左缘右滑会弹出文件列表（左边框）。
   * 用触控笔从左往右写字时，那一笔会被误判成右滑。
   *
   * Obsidian 识别出滑动手势后，通过 `workspace.trigger('swipe', …)`
   * 派发事件。这里把这个通道掐掉——
   * 但**只在刚写过字的一小段时间内**掐，
   * 用户真想去翻文件列表时（没在写字）不受影响。
   *
   * DOM 层（捕获阶段 stopPropagation）已经挡了一路，
   * 这一层是兜底：万一宿主在捕获阶段就读了事件，DOM 层会漏。
   */
  private installSwipeGuard(): void {
    const app = this.app as any;
    const ws = app?.workspace;
    if (!ws) return;

    // 已经被别的插件（或本次热重载）装过就别重复装
    if ((ws as any).__inkbookSwipeGuard) return;

    const isBlocked = () => {
      if (!this.settings.blockEdgeSwipe) return false;
      // 没有任何视图在写字 → 放行
      let inked = false;
      for (const leaf of app.workspace.getLeavesOfType?.(VIEW_TYPE) || []) {
        const v = leaf.view as any;
        if (v?.editor?.recentlyInked?.()) {
          inked = true;
          break;
        }
      }
      return inked;
    };

    const targets = [ws, ws.rootSplit, ws.activeLeaf].filter(Boolean);
    for (const t of targets) {
      const proto = Object.getPrototypeOf(t);
      if (!proto || typeof proto.trigger !== "function") continue;
      if ((proto.trigger as any).__inkbookPatched) continue;
      const orig = proto.trigger;
      const patched = function (this: unknown, event: string, data: any) {
        try {
          if (
            event === "swipe" &&
            data &&
            data.direction === "x" &&
            data.points === 1 &&
            isBlocked()
          ) {
            // 误触：吞掉，不派发
            return;
          }
        } catch (_) {
          // 判定出错时宁可放行，不能把用户的正常操作也堵死
        }
        return orig.call(this, event, data);
      };
      (patched as any).__inkbookPatched = true;
      proto.trigger = patched;
    }
    (ws as any).__inkbookSwipeGuard = true;
  }

  private openNewBook(): void {
    new NewBookModal(this.app, this, (file) => {
      this.app.workspace.getLeaf("tab").openFile(file);
    }).open();
  }

  private openPicker(): void {
    new BookPickerModal(this.app, (file) => {
      this.app.workspace.getLeaf("tab").openFile(file);
    }).open();
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const v = leaf.view as any;
      if (v && typeof v.syncSettings === "function") v.syncSettings();
    }
  }
}
