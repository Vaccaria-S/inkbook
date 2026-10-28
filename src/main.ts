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

  /** 被替换掉的原型方法，卸载时原样放回 */
  private swipeRestore: Array<() => void> = [];

  /**
   * 拦住宿主的「从左缘右滑 → 弹出文件列表」。
   *
   * 2026-10-28 真机教训：一开始只靠 editor 里 window 捕获阶段的
   * stopPropagation，测试环境能过、真机完全无效——宿主的滑动监听在插件加载
   * 之前就挂在 window 捕获阶段，同节点同阶段按注册顺序执行，我们永远排在它
   * 后面，等我们拦已经晚了。所以只能在派发层吞掉 swipe 事件。
   *
   * 与更早那版补丁的区别（那版删掉是对的，这版补回了它唯一有效的部分）：
   * - 只有「刚从容器左缘起手」的滑动才吞（editor.edgeSwipeRecent()），
   *   不是按「刚写过字」粗判，也不影响纸面中间的滑动；
   * - onunload 会把原型方法原样放回，禁用插件后不再残留；
   * - 补丁函数上保留真正的原函数（__inkbookOrig），热重载反复安装也不会层层包装。
   */
  private installSwipeGuard(): void {
    if (this.swipeRestore.length) return;
    const ws = (this.app as any)?.workspace;
    if (!ws) return;

    /*
     * 判据：当前文件是 .inkbook 就整条吃掉横向滑动。
     *
     * 一开始想用「这次滑动是不是从容器左缘起手」做精判，真机证明不可靠：
     * 缩小（纸张小于视口）时手/笔落点经常落在纸张外的空白区，
     * 坐标判据抓不到；而放大时又因为别的原因根本不触发。
     * 用户要的语义其实更简单——**在墨本里就别让这个手势工作**。
     *
     * 代价：在墨本里用这个手势打开文件列表会失效（左侧栏按钮 / 命令面板仍可用），
     * 关掉设置里的开关即可恢复。
     */
    const isInkbookActive = (): boolean => {
      const file = this.app.workspace.getActiveFile?.();
      if (file && (file.extension || "").toLowerCase() === "inkbook") return true;
      const active: any = (this.app.workspace as any).activeLeaf?.view;
      if (active && typeof active.getViewType === "function" && active.getViewType() === VIEW_TYPE) {
        return true;
      }
      return false;
    };

    const shouldBlock = (): boolean => {
      if (!this.settings.blockEdgeSwipe) return false;
      if (isInkbookActive()) return true;
      // 兜底：活动文件拿不到时，看有没有墨本编辑器刚记录过左缘起手
      for (const leaf of this.app.workspace.getLeavesOfType?.(VIEW_TYPE) || []) {
        const ed = (leaf.view as any)?.editor;
        if (ed && typeof ed.edgeSwipeRecent === "function" && ed.edgeSwipeRecent()) return true;
      }
      return false;
    };

    const seen = new Set<object>();
    for (const target of [ws, ws.rootSplit, ws.activeLeaf]) {
      if (!target) continue;
      const proto = Object.getPrototypeOf(target);
      // 千万别落到 Object.prototype 上（测试桩里的 workspace 就是普通对象）
      if (!proto || proto === Object.prototype || seen.has(proto)) continue;
      seen.add(proto);

      const current = proto.trigger;
      if (typeof current !== "function") continue;
      // 上一次没卸干净（热重载）时先还原，避免包装层越叠越深
      const orig = (current as any).__inkbookOrig ?? current;

      const patched = function (this: unknown, event: string, ...args: any[]) {
        try {
          const data = args[0];
          const horizontal = data?.direction === "x" || data?.direction === "horizontal";
          const singleTouch = data?.points == null || data.points <= 1;
          if (event === "swipe" && horizontal && singleTouch && shouldBlock()) return;
        } catch (_) {
          // 判定出错时宁可放行，不能把正常操作也堵死
        }
        return orig.apply(this, [event, ...args]);
      };
      (patched as any).__inkbookPatched = true;
      (patched as any).__inkbookOrig = orig;
      proto.trigger = patched;

      this.swipeRestore.push(() => {
        if (proto.trigger === patched) proto.trigger = orig;
      });
    }
  }

  private uninstallSwipeGuard(): void {
    for (const restore of this.swipeRestore) {
      try {
        restore();
      } catch (_) {
        /* 卸载失败不影响禁用流程 */
      }
    }
    this.swipeRestore = [];
  }

  onunload(): void {
    this.uninstallSwipeGuard();
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
