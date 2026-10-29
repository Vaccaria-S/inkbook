import { FuzzySuggestModal, Notice, Plugin, TFile, type App } from "obsidian";
import { InkbookView, VIEW_TYPE } from "./view";
import { InkbookSettingTab, DEFAULT_SETTINGS } from "./settings";
import { NewBookModal } from "./modals";
import type { InkbookSettings } from "./types";
import { parseIndexPath } from "./indexer";

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
    this.installPaletteGuard();

    /*
     * 文字索引里的跳页链接：`obsidian://inkbook?file=<本子路径>&page=N`
     *
     * 全局搜索命中索引 md 后，点这条链接就回到本子的第 N 页。
     * 用协议而不是内部链接，是因为内部链接只能打开文件、定位不到页。
     */
    this.registerObsidianProtocolHandler("inkbook", (params) => {
      void this.openFromLink(params);
    });

    /*
     * 打开索引页 = 想回本子那一页。
     *
     * 索引是「一页一个 md」，所以 file-open 时能直接从路径反查出
     * 本子与页码，立刻换成 .inkbook 并滚过去——用户从全局搜索点结果，
     * 落在纸上而不是停在 md 里。这是「搜索直接跳笔记」的实现方式。
     */
    this.registerEvent(
      this.app.workspace.on("file-open", (file: TFile | null) => {
        if (!file) return;
        const hit = parseIndexPath(file.path);
        if (!hit) return;
        // 等这一轮 md 打开流程走完再切，否则 Obsidian 会把我们刚打开的视图顶掉
        window.setTimeout(() => {
          void this.openBookAt(hit.bookPath, hit.page);
        }, 60);
      })
    );
  }

  /** 处理 obsidian://inkbook?file=…&page=N */
  private async openFromLink(params: Record<string, string>): Promise<void> {
    let path = params.file || "";
    if (!path) return;
    // 协议参数一般已经解码过；没解开的再试一次（路径里带空格/中文时常见）
    if (!this.app.vault.getAbstractFileByPath(path)) {
      try {
        path = decodeURIComponent(path);
      } catch (_) {
        /* 解不开就用原值 */
      }
    }
    await this.openBookAt(path, Number(params.page || "1") || 1);
  }

  /** 打开指定路径的手写本并跳到第 page 页（1 起） */
  private async openBookAt(path: string, page: number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice("墨本：找不到这本手写本 —— " + path);
      return;
    }
    // 已经停在这本上：不重新打开，直接翻页（避免闪一下）
    const active = this.app.workspace.getActiveFile?.();
    if (active && active.path === file.path) {
      const open = this.app.workspace.getActiveViewOfType?.(InkbookView);
      if (open) {
        open.gotoPageFromLink(page);
        return;
      }
    }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    const view = leaf.view;
    if (view instanceof InkbookView) view.gotoPageFromLink(page);
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
    const shouldBlock = (): boolean => {
      if (!this.settings.blockEdgeSwipe) return false;
      if (this.isInkbookActive()) return true;
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

  /**
   * 当前是不是停在墨本里。
   *
   * 两个判据都用：扩展名（最可靠）＋ 活动 leaf 的视图类型
   * （文件刚切换、getActiveFile 还没跟上时兜底）。
   */
  private isInkbookActive(): boolean {
    const file = this.app.workspace.getActiveFile?.();
    if (file && (file.extension || "").toLowerCase() === "inkbook") return true;
    const active: any = (this.app.workspace as any).activeLeaf?.view;
    if (active && typeof active.getViewType === "function" && active.getViewType() === VIEW_TYPE) {
      return true;
    }
    return false;
  }

  /** 被替换掉的 commands 方法，卸载时原样放回 */
  private paletteRestore: Array<() => void> = [];

  /**
   * 在墨本里吞掉「打开命令面板」这条命令。
   *
   * 真机现象：平板上拖右缘滑条往下，宿主把这段触摸认成
   * 「下拉打开命令面板」，一拖就弹一层搜索面板糊在纸上。
   *
   * 手势本身拦不住——它挂 window 捕获阶段，比插件早注册（右滑那条踩过一模一样的坑）。
   * 但它最后一定要走 commands.executeCommandById("command-palette:open")，
   * 在派发层把这条命令丢掉，比跟手势坐标较劲可靠得多；快捷键 Ctrl/Cmd+P 也一并失效。
   */
  private installPaletteGuard(): void {
    if (this.paletteRestore.length) return;
    const commands = (this.app as any)?.commands;
    if (!commands || typeof commands.executeCommandById !== "function") return;

    // 热重载时先剥掉上一次的包装，避免层层套娃
    const orig =
      (commands.executeCommandById as any).__inkbookOrig ?? commands.executeCommandById;
    const self = this;
    const patched = function (this: unknown, id: string, ...args: any[]) {
      try {
        if (
          typeof id === "string" &&
          id.indexOf("command-palette:") === 0 &&
          self.settings.blockCommandPalette !== false &&
          self.isInkbookActive()
        ) {
          return false;
        }
      } catch (_) {
        // 判定出错时放行，不能把别的命令一起堵死
      }
      return orig.apply(this, [id, ...args]);
    };
    (patched as any).__inkbookPatched = true;
    (patched as any).__inkbookOrig = orig;
    commands.executeCommandById = patched;

    this.paletteRestore.push(() => {
      if (commands.executeCommandById === patched) commands.executeCommandById = orig;
    });
  }

  private uninstallPaletteGuard(): void {
    for (const restore of this.paletteRestore) {
      try {
        restore();
      } catch (_) {
        /* 卸载失败不影响禁用流程 */
      }
    }
    this.paletteRestore = [];
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
    this.uninstallPaletteGuard();
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
