import { FuzzySuggestModal, Notice, Plugin, TFile, WorkspaceLeaf, type App } from "obsidian";
import { InkbookView, VIEW_TYPE } from "./view";
import { InkbookSettingTab, DEFAULT_SETTINGS } from "./settings";
import { NewBookModal } from "./modals";
import { normalizeShapeSnap, type InkbookSettings } from "./types";
import { sanitizeHotkeys } from "./hotkeys";
import { parseIndexPath, removeTextIndex, sweepOrphanIndexDirs, writeTextIndex } from "./indexer";
import { installSwitcherIndexGuard } from "./switcher";
import { migrateAllGeneratedFiles, moveBookDataDirOnRename } from "./bookdata";
import { readBook } from "./storage";
import {
  disposeEmbeds,
  invalidateEmbedCache,
  refreshEmbedsForPath,
  registerEmbed,
  type EmbedHost,
} from "./embed";

/**
 * 手感 / 粗细数值字段的合法区间：与设置页滑杆的 setLimits、
 * 侧栏粗细 range 的 min/max 一致。取 UI 的真实范围而不是更宽的兜底——
 * 超出这个范围的值在面板上根本显示不出来，留着只会继续误导用户。
 */
const NUMERIC_SETTING_RANGES: Array<[keyof InkbookSettings, number, number]> = [
  ["pressure", 0.3, 1.5],
  ["smoothing", 0, 1],
  ["defaultPenSize", 1, 8],
  ["defaultBallpointSize", 1, 8],
  ["defaultHighlighterSize", 4, 40],
  ["thumbCols", 1, 4],
  ["favoriteCols", 1, 4],
  ["lastEraserSize", 6, 60],
];

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
  /**
   * 设置页实例（`onExternalSettingsChange` 要靠它重绘）。
   *
   * Obsidian 的 `addSettingTab` 不返回句柄，只能自己存一份——
   * 否则多窗口同步改了设置，已打开的设置页还显示旧值。
   */
  private settingTab: InkbookSettingTab | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new InkbookView(leaf, this));

    try {
      this.registerExtensions(["inkbook"], VIEW_TYPE);
    } catch (e) {
      console.warn("[inkbook] .inkbook 扩展名已被占用", e);
    }

    this.addRibbonIcon("notebook", "墨本：新建手写本", () => this.openNewBook());
    // 核心快速切换器本身不过滤 `.inkbook`，所以只承诺“打开文件”，
    // 不再暗示这里只会列出墨本本子。
    this.addRibbonIcon("book-open", "墨本：打开手写本（快速切换 / 打开文件）", () => this.openPicker());

    /*
     * 笔记里 `![[本子.inkbook]]` 的渲染（INK-105）。
     *
     * 之前整个插件没有 postprocessor，md 里只能看到一个宿主自带的嵌入占位
     * ——双击能进本子，但“引用/预览”这条路是断的。
     * 现在把一整页画成位图贴进去：只做预览，要写就点进去写。
     */
    registerEmbed(this as unknown as EmbedHost);
    this.registerEmbedCacheEvents();

    this.addCommand({
      id: "inkbook-new",
      name: "新建手写本（A4 手写笔记）",
      callback: () => this.openNewBook(),
    });

    this.addCommand({
      id: "inkbook-open",
      name: "打开手写本（快速切换 / 打开文件）",
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

    /*
     * 在当前手写本里查找文字：命令面板里能找到，也能自己绑快捷键。
     * 顶栏放大镜按钮和 Ctrl/⌘+F 是同一条入口（见 InkbookView.openFindBar）。
     */
    this.addCommand({
      id: "inkbook-find",
      name: "在当前笔记中查找文字",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(InkbookView);
        if (!view || !view.editor) return false;
        if (checking) return true;
        view.openFindBar();
        return true;
      },
    });

    // 存一份引用：多窗口同步改了设置时，要靠它重绘已打开的设置页
    this.settingTab = new InkbookSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    /*
     * 补建历史索引。
     *
     * 旧版用 adapter.write 直接落盘，Obsidian 的文件表可能压根没收录那些
     * 索引 md（真机上表现为「文件在磁盘上、全局搜索却一个字都搜不到」）。
     * 这条命令把库里每一本都重新走一遍 vault.create/modify，
     * 让它们真正进到检索里。
     *
     * 注意：墨本里默认屏蔽了命令面板，所以在设置页也放了一颗同样的按钮。
     */
    this.addCommand({
      id: "inkbook-rebuild-index",
      name: "重建文字索引（让全局搜索能搜到所有手写本）",
      callback: () => void this.rebuildTextIndex(),
    });

    /*
     * 启动时扫一遍孤儿索引目录（2026-11-10）。
     *
     * `delete` 事件只在「在本库里删本子」时来。用户在同步工具、手机端、
     * 资源管理器里删了本子，或者旧版本插件只删文件不删目录，
     * `.墨本索引/` 就会永久留在笔记文件夹里——用户看到的是
     * 「我删了那些测试本子，文件夹里还是一堆东西」。
     *
     * 放在 onLayoutReady 之后、且用 `void` 异步跑：扫目录要走磁盘，
     * 绝不能拖慢插件加载；失败也只是派生数据没清掉，不影响任何功能。
     */
    this.app.workspace.onLayoutReady(() => {
      const timer = window.setTimeout(() => {
        void sweepOrphanIndexDirs(this.app).catch(() => undefined);
      }, 3000);
      // 插件被禁用/重载时别让这颗定时器再去碰已经拆掉的 app
      this.register(() => window.clearTimeout(timer));
    });

    /*
     * 一次性把旧版散落的插件生成物收进「墨本文件/」（迁移旧本子）。
     *
     * 只跑一次（settings.filesMigrated），避免每次启动全库重读大文件。
     * 同样放在 onLayoutReady 之后、用 setTimeout 异步跑，失败不影响任何功能。
     * 迁移会改写有导入底图/原件的那些本子的引用（其余本子不动、不重写）。
     */
    if (!this.settings.filesMigrated) {
      this.app.workspace.onLayoutReady(() => {
        const timer = window.setTimeout(() => {
          void (async () => {
            try {
              const r = await migrateAllGeneratedFiles(this.app);
              // 有失败也先置位：失败的本子会在下次打开时按需重试，别让启动每次都读全库
              this.settings.filesMigrated = true;
              await this.saveSettings();
              if (r.migrated > 0) {
                new Notice(`墨本：已把 ${r.migrated} 本笔记的索引/底图/原件收进「墨本文件」。`, 6000);
              }
            } catch (e) {
              console.warn("[inkbook] 迁移生成文件失败", e);
            }
          })();
        }, 4500);
        this.register(() => window.clearTimeout(timer));
      });
    }

    this.installSwipeGuard();
    this.installPaletteGuard();
    // 索引页只用来让全局搜索能搜到，不该占着快速切换的结果位。
    this.switcherUninstall = installSwitcherIndexGuard(this.app);

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
     * 正路是下面的 `installIndexOpenGuard()`：在 leaf 真正打开文件之前
     * 就把「索引页」换成「本子那一页」，索引 md 根本不进入视图，也就不会
     * 进入导航历史（否则「后退」先退回索引 md、本插件又把它弹回本子，
     * 成了退不出去的死循环 —— 用户报的正是这个）。
     *
     * 这里保留 file-open 兜底：万一某条宿主路径绕过了 leaf.openFile
     * （别的客户端 / 第三方插件直接 setViewState 打开索引页），仍然能
     * 落到本子上，而不是停在 md。
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

    this.installIndexOpenGuard();
  }

  /**
   * 把库里所有手写本的文字索引重建一遍。
   *
   * 用途有二：
   *   1. 旧版索引用 adapter 裸写，Obsidian 的文件表可能没收录 —— 重建一次就进检索了
   *   2. 用户关掉过「生成文字索引」，后来想补回来
   *
   * 逐本读、逐本写：一本坏掉不影响其余，最后报个总数。
   */
  async rebuildTextIndex(): Promise<{ books: number; pages: number; failed: number }> {
    const files = this.app.vault
      .getFiles()
      .filter((f) => (f.extension || "").toLowerCase() === "inkbook");
    let books = 0;
    let pages = 0;
    let failed = 0;
    /*
     * 先扫掉孤儿索引目录再重建（2026-11-10）。
     *
     * 「重建索引」是用户手里唯一一个「把索引收拾干净」的显式动作，
     * 所以顺手把本子已经不在的 `.墨本索引/` 目录也清掉：
     * 否则重建完，笔记文件夹里那些空目录还在，用户会以为按钮没生效。
     * 放在重建**之前**：少扫一遍已删本子的目录，也不会有本子被
     * 本次重建出来的目录误判成孤儿（本子文件本身在，判据看本子）。
     */
    let swept = 0;
    try {
      const sweep = await sweepOrphanIndexDirs(this.app);
      swept = sweep.removed;
    } catch (_) {
      /* 清理失败不影响重建 */
    }
    for (const f of files) {
      try {
        const book = await readBook(this.app.vault.adapter, f.path, f.basename);
        const indexResult = await writeTextIndex(this.app, f, book);
        if (!indexResult.ok) {
          // 索引失败原因已由 writeTextIndex 弹过 Notice，这里只计数
          failed += 1;
          continue;
        }
        books += 1;
        pages += indexResult.pages;
      } catch (e) {
        failed += 1;
        console.warn("[inkbook] 重建索引时读不出这一本，已跳过：" + f.path, e);
      }
    }
    const msg =
      files.length === 0
        ? "墨本：库里还没有 .inkbook 手写本。" + (swept ? `已清掉 ${swept} 个残留的索引目录。` : "")
        : failed
        ? `墨本：${books} 本 / ${pages} 页已重建索引；${failed} 本生成失败（原因见上方提示，本子本身不受影响）。` +
          (swept ? `另清掉 ${swept} 个残留的索引目录。` : "")
        : `墨本：${books} 本 / ${pages} 页有文字，已重建索引。全局搜索现在能搜到这些页，点结果直接落在纸上。` +
          (swept ? `另清掉 ${swept} 个残留的索引目录。` : "");
    new Notice(msg, 10000);
    return { books, pages, failed };
  }

  /**
   * 本子改动 / 改名前清掉笔记内嵌入的缓存，并让视口内的嵌入重画。
   *
   * 注意「显示旧图」不是风险：缓存键里带着 mtime，文件一改就是另一个键，
   * 下次渲染自然重画。这里清的是**旧的那一份**——不清的话，一本书改十次
   * 就留下十份位图和十份页面 JSON，一直占着内存到进程结束；
   * rename 之后旧路径的条目更是永远命中不了，纯泄漏。
   *
   * modify 还额外叫醒已经画好的那些块（1.5s 防抖，见 embed.ts）：
   * 用户在墨本里写了两笔、切回笔记，看到的不该是旧图。
   */
  private registerEmbedCacheEvents(): void {
    const vault: any = this.app?.vault as any;
    // 测试桩里的 vault 未必有事件总线；真机上一定有
    if (!vault || typeof vault.on !== "function") return;

    const dropIfBook = (f: any): void => {
      if (f && String(f.extension || "").toLowerCase() === "inkbook") {
        invalidateEmbedCache(f.path);
      }
    };

    this.registerEvent(
      vault.on("modify", (f: any) => {
        if (!f || String(f.extension || "").toLowerCase() !== "inkbook") return;
        // 先同步清缓存：内存立刻释放，也保证随后任何一次读取都不会命中旧位图
        invalidateEmbedCache(f.path);
        // 再排队把视口内的块重画（1.5s 防抖，内部还会再清一次缓存 → 幂等）
        refreshEmbedsForPath(f.path);
      })
    );
    const isBook = (f: any): boolean =>
      !!f && String(f.extension || "").toLowerCase() === "inkbook";
    this.registerEvent(
      vault.on("delete", (f: any) => {
        if (!isBook(f)) return;
        dropIfBook(f);
        // 本子删了：对应的索引 md 也该从搜索结果里消失
        void removeTextIndex(this.app, f);
      })
    );
    this.registerEvent(
      vault.on("rename", (f: any, oldPath: string) => {
        // 旧路径下的缓存再也命中不了，直接丢掉（不清会一直占着内存）
        if (oldPath) invalidateEmbedCache(oldPath);
        dropIfBook(f);
        /*
         * 改名后旧 `.墨本索引/` 目录还留着旧本子名：
         * 搜索结果会点开不存在的文件，下次保存又多出一份新目录。
         * 用 oldPath 删旧目录（f 已经是新路径，按它算会删错）。
         */
        if (oldPath && isBook(f)) {
          void (async () => {
            try {
              /*
               * 必须 await，且必须传 oldPath（INK-176）。
               *
               * removeTextIndex 内部会排到 `oldPath` 那条单飞链的**尾部**：
               * 改名时旧本子可能还有一轮 writeTextIndexNow 在半途，它写的正是
               * 旧目录。删得太早，那轮写完会把旧目录的 md 重建回来，之后再无
               * 事件清理 → 搜索结果残留旧本子名、点开报「找不到这本手写本」。
               * 排队 + await 保证「旧链的活全干完 → 删干净 → 再建新索引」。
               * 别把这里的 await 改成 void，也别省掉 oldPath。
               */
              /*
               * 先把这本的数据叶子（索引页 + 底图/原件）整体搬到新 token
               * 目录，并改写盘上引用；再删旧索引、重建新索引。
               * 顺序很重要：先搬资产，避免 removeTextIndex 把旧叶子连资产删掉。
               */
              const moved = await moveBookDataDirOnRename(this.app, oldPath, f.path);
              if (moved) {
                for (const leaf of this.app.workspace.getLeavesOfType?.(VIEW_TYPE) || []) {
                  const v: any = leaf.view;
                  if (v && typeof v.remapBookAssetDir === "function") {
                    v.remapBookAssetDir(moved.oldDir, moved.newDir);
                  }
                }
              }
              await removeTextIndex(this.app, f, oldPath);
              /*
               * **立刻重建新索引**（2026-11-07 补）。
               *
               * 老代码只删旧索引，指望「随后 modify/save 的
               * scheduleTextIndex 自动重建」—— 但本子**没开着**的时候
               * 根本不会有保存，于是全局搜索里这本书整本消失，
               * 用户搜「傅里叶」0 结果，会以为笔记丢了。
               * 改名是显式动作，当场重建最稳妥。
               */
              const book = await readBook(this.app.vault.adapter, f.path, f.basename);
              await writeTextIndex(this.app, f, book);
            } catch (e) {
              // 读不出/写不进都不影响改名本身；失败原因 writeTextIndex 自己会提示
              console.warn("[inkbook] 改名后重建索引失败：" + f.path, e);
            }
          })();
        }
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

  /**
   * 打开指定路径的手写本并跳到第 page 页（1 起）。
   *
   * 公开：笔记内嵌入（embed.ts）点一下要落到链接里写的那一页。
   *
   * `opts.newTab` 来自点击时的修饰键（Ctrl/Cmd / 中键）：默认沿用 Obsidian
   * 原生内部链接的语义——替换当前 leaf；带修饰键才另开一个标签页。
   *
   * `opts.leaf` 指定「就用这个 leaf 打开」（内部给索引页拦截用）：
   * 全局搜索点索引页时，我们要在它原本要打开的那个 leaf 里直接换成
   * 本子，不能走 `getLeaf(false)` 去猜当前活动 leaf——否则多栏布局下会开错。
   */
  async openBookAt(
    path: string,
    page: number,
    opts?: { newTab?: boolean; leaf?: WorkspaceLeaf }
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice("墨本：找不到这本手写本 —— " + path);
      return;
    }
    const newTab = opts?.newTab === true;
    // 已经停在这本上：不重新打开，直接翻页（避免闪一下）。
    // 要求新开标签时跳过这条捷径——用户明确表达了"另开一页看"。
    if (!newTab) {
      const active = this.app.workspace.getActiveFile?.();
      if (active && active.path === file.path) {
        const open = this.app.workspace.getActiveViewOfType?.(InkbookView);
        if (open) {
          open.gotoPageFromLink(page);
          return;
        }
      }
    }
    /*
     * 同一本已经在**别的叶子**开着：切过去，别再开第二份 store。
     *
     * 两个 view 各持一份 store、各自保存，正常的保存会变成一对
     * `-disk-` / `-mine-` 冲突副本——内容不丢，但用户会困惑，而且
     * 后保存的一方会卡在「怎么保存都不生效」。
     *
     * 用 reveal 而不是禁止：既延续「已在这本就只翻页」的既有语义，
     * 也保住了 newTab「两页对照」的用法。
     *
     * 边界：文件浏览器里手动「在新标签页打开」/ 拖分栏不经过这里；
     * 那条路交给 view.ts 的 onLoadFile 兜底——检测到同本双开时**只读**
     * 打开第二个标签（INK-172），不会产生两份可写 store。
     */
    const sameBook = (
      this.app.workspace.getLeavesOfType?.(VIEW_TYPE) || []
    ).find((leaf: any) => {
      const v: any = leaf?.view;
      return v && v.file && v.file.path === file.path && typeof v.gotoPageFromLink === "function";
    });
    if (sameBook) {
      if (!newTab) {
        /*
         * revealLeaf 失败不能连翻页一起丢（2026-11-07 修）：
         * 老写法 `void revealLeaf?.(...)` 在 API 缺失 / 抛错 / reject 时
         * 只是静默 —— 标签没切过去，用户以为「点了没反应」。
         * 这里显式 await + catch，失败就退回「新开一个 leaf 打开」的兜底。
         */
        let revealed = false;
        try {
          const r: any = this.app.workspace.revealLeaf?.(sameBook);
          if (r && typeof r.then === "function") await r;
          revealed = true;
        } catch (e) {
          console.warn("[inkbook] revealLeaf 失败，退回新开标签", e);
        }
        if (revealed) {
          (sameBook.view as InkbookView).gotoPageFromLink(page);
          return;
        }
        // 落到下面的 getLeaf(false).openFile 兜底
      } else {
        /*
         * 用户明确要新标签（Ctrl/Cmd+点击、中键）。仍按他的意思开，
         * 但新视图的 onLoadFile 会检测到同本已开并**只读**打开；
         * 先把预期说清楚，别等用户写了半天才发现存不进去。
         */
        new Notice(
          "这本已在另一个标签页打开：新标签页将以只读方式打开，避免两边互相覆盖。",
          8000
        );
      }
    }
    const leaf =
      opts?.leaf ??
      (newTab ? this.app.workspace.getLeaf("tab") : this.app.workspace.getLeaf(false));
    await leaf.openFile(file);
    const view = leaf.view;
    if (view instanceof InkbookView) view.gotoPageFromLink(page);
  }

  /** 被替换掉的原型方法，卸载时原样放回 */
  private swipeRestore: Array<() => void> = [];
  /** 被替换掉的 `WorkspaceLeaf.openFile`，卸载时原样放回 */
  private indexOpenRestore: Array<() => void> = [];
  /** 快速切换 / 文件建议弹窗里隐去索引页：卸载时还原 */
  private switcherUninstall: (() => void) | null = null;

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
  /** 最近一次真实触摸的时间戳（用来区分「手势误触」和「键盘 Ctrl+P」） */
  private lastTouchAt = 0;
  private touchWatchers: Array<() => void> = [];

  /**
   * 在墨本里吞掉「触摸误触打开命令面板」这条命令，但**放行键盘 Ctrl+P**。
   *
   * 真机现象：平板上拖右缘滑条往下，宿主把这段触摸认成
   * 「下拉打开命令面板」，一拖就弹一层搜索面板糊在纸上。
   *
   * 手势本身拦不住——它挂 window 捕获阶段，比插件早注册（右滑那条踩过一模一样的坑）。
   * 但它最后一定要走 commands.executeCommandById("command-palette:open")。
   *
   * 旧做法把这条命令**无条件**吞掉，连 Ctrl+P 打开的面板也一起没了——
   * 于是墨本自己注册的 4 条命令在 Obsidian 里根本搜不到。
   * 现在按「最近 600ms 内有没有真实触摸」区分：
   *   · 下拉手势一定伴随 pointerdown/touchstart → 拦
   *   · 键盘快捷键没有触摸 → 放行，命令面板可用
   * 判定出错时一律放行（宁可不拦，也不能把别的命令一起堵死）。
   */
  private installPaletteGuard(): void {
    if (this.paletteRestore.length) return;
    const commands = (this.app as any)?.commands;
    if (!commands || typeof commands.executeCommandById !== "function") return;

    // 触摸打点：捕获阶段、被动监听，不干扰书写
    const markTouch = () => {
      this.lastTouchAt = Date.now();
    };
    const watch = (name: string) => {
      document.addEventListener(name, markTouch, { capture: true, passive: true });
      this.touchWatchers.push(() => document.removeEventListener(name, markTouch, true));
    };
    watch("pointerdown");
    watch("touchstart");

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
          self.isInkbookActive() &&
          Date.now() - self.lastTouchAt < 600
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
    for (const off of this.touchWatchers) {
      try {
        off();
      } catch (_) {
        /* 同上 */
      }
    }
    this.touchWatchers = [];
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

  /**
   * 让「打开索引页」这件事在**进入视图之前**就变成「打开本子那一页」。
   *
   * 为什么必须这么早：Obsidian 每个标签页维护一条导航历史。以前是靠
   * `file-open` 事件事后补救——先真把索引 md 打开（进历史），再 `openFile`
   * 换成 .inkbook（又进历史）。于是历史是 [上一个文件, 索引md, 本子]：
   * 用户点「后退」→ 退到索引 md → `file-open` 又把它弹回本子 → 永远退不回
   * 上一个文件。用户报的「点回退又跳回这个笔记」就是这条死循环。
   *
   * 现在直接把 `WorkspaceLeaf.prototype.openFile` 包一层：要打开的文件若
   * 是索引页，就在同一个 leaf 里改成打开对应本子并翻到那一页。索引 md 从
   * 头到尾没有被真正打开过，自然不进历史，后退就一步回到原来的文件。
   *
   * 所有打开路径（全局搜索、快速切换、文件浏览器……）最终都经过
   * `leaf.openFile`（`openLinkText` 内部也是），所以一处拦截即可覆盖。
   * 卸载时原样放回；`__inkbookOrig` 防止热重载层层套娃。
   */
  private installIndexOpenGuard(): void {
    if (this.indexOpenRestore.length) return;
    const proto: any = (WorkspaceLeaf as any)?.prototype;
    if (!proto || typeof proto.openFile !== "function") return;
    const orig = (proto.openFile as any).__inkbookOrig ?? proto.openFile;
    const plugin = this;
    const patched = function (this: any, file: TFile, openState?: unknown) {
      try {
        const hit = file && typeof (file as any).path === "string" ? parseIndexPath((file as any).path) : null;
        if (hit && plugin.app.vault.getAbstractFileByPath(hit.bookPath)) {
          // 用「本来要打开的那个 leaf」打开本子：多栏布局下也不会开错栏
          return plugin.openBookAt(hit.bookPath, hit.page, { leaf: this });
        }
      } catch (_) {
        // 判定出错就退回宿主原生行为，绝不能因为拦截把文件打开搞坏
      }
      return orig.call(this, file, openState);
    };
    (patched as any).__inkbookPatched = true;
    (patched as any).__inkbookOrig = orig;
    proto.openFile = patched;
    this.indexOpenRestore.push(() => {
      if (proto.openFile === patched) proto.openFile = orig;
    });
  }

  private uninstallIndexOpenGuard(): void {
    for (const restore of this.indexOpenRestore) {
      try {
        restore();
      } catch (_) {
        /* 卸载失败不影响禁用流程 */
      }
    }
    this.indexOpenRestore = [];
  }

  onunload(): void {
    this.uninstallSwipeGuard();
    this.uninstallPaletteGuard();
    this.uninstallIndexOpenGuard();
    this.switcherUninstall?.();
    this.switcherUninstall = null;
    // 笔记内嵌入：停掉懒加载观察器并释放位图/页面缓存
    disposeEmbeds();
    invalidateEmbedCache();
  }

  private openNewBook(): void {
    new NewBookModal(this.app, this, (file) => {
      this.app.workspace.getLeaf("tab").openFile(file);
    }, () => {
      // 复用空视图的选源→导入→建本链路，避免在插件入口重写页码选择和三段兜错。
      const leaf = this.app.workspace.getLeaf("tab");
      void leaf.setViewState({ type: VIEW_TYPE, active: true }).then(() => {
        const view = leaf.view;
        if (view instanceof InkbookView) view.startImportNewBook();
        else new Notice("无法打开墨本视图，请重试导入。", 8000);
      }).catch((e: unknown) => {
        new Notice("无法打开墨本视图：" + (e instanceof Error ? e.message : String(e)), 8000);
      });
    }).open();
  }

  private openBookPickerFallback(): void {
    new BookPickerModal(this.app, (file) => {
      this.app.workspace.getLeaf("tab").openFile(file);
    }).open();
  }

  /**
   * 优先打开 Obsidian 核心的快速切换器。
   *
   * 核心 Quick Switcher 本身**不按文件类型过滤**：用户能搜到全库笔记。
   * 这正是“打开文件”的通用语义；墨本不再承诺只列 `.inkbook`。
   * 唯一的例外是墨本自己生成的文字索引页——它们只为全局搜索而存在，
   * 由 `installSwitcherIndexGuard` 在弹窗结果层统一隐去（不影响搜索）。
   * 只有明确返回 `false`、API 缺失或同步抛错时才退回旧的 BookPickerModal，
   * `undefined`（很多命令回调没有返回值）视为已成功派发，不能误弹两层。
   */
  private openPicker(): void {
    let dispatched: unknown;
    try {
      const commands = (this.app as any)?.commands;
      if (!commands || typeof commands.executeCommandById !== "function") {
        this.openBookPickerFallback();
        return;
      }
      dispatched = commands.executeCommandById("switcher:open");
    } catch (e) {
      console.warn("[inkbook] 快速切换器不可用，退回本子选择器", e);
      this.openBookPickerFallback();
      return;
    }
    if (dispatched === false) {
      this.openBookPickerFallback();
      return;
    }
    // 极少数宿主把命令回调做成 Promise；异步 reject / resolve(false) 也兜底。
    if (dispatched && typeof (dispatched as any).then === "function") {
      void Promise.resolve(dispatched)
        .then((ok) => {
          if (ok === false) this.openBookPickerFallback();
        })
        .catch(() => this.openBookPickerFallback());
    }
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) || {};
    /*
     * 旧版本遗留的死字段：曾经打算把浮层工具盘的位置存进 settings.toolPanel，
     * 后来工具盘并进了顶栏，源码里已经没有任何地方读它（types.ts 里的
     * 声明也一并删了）。老 data.json 里可能还留着这个键，读到就丢掉，
     * 免得下次保存又写回去、让后来的人以为它有用。
     */
    delete data.toolPanel;
    const settings = Object.assign({}, DEFAULT_SETTINGS, data) as InkbookSettings;
    // 一笔成型只有 开/关 两态（旧值 hold 会回落成 lift）；野值一律回落关闭。
    settings.shapeSnap = normalizeShapeSnap(settings.shapeSnap);
    /*
     * 数值字段必须自己校验，不能只靠面板滑杆的 setLimits。
     * data.json 会被同步工具 / 手工编辑 / 别的版本写进 null、"abc"、
     * NaN（JSON 里通常是 null）甚至越界值；`Object.assign` 会把它们
     * 原样盖掉默认值。NaN 一旦流到 shapePressure → pressureFor →
     * stroke.points 就会被写进 .inkbook，存档永久污染（INK-179）。
     * 非法一律回落 DEFAULT_SETTINGS 的对应项，合法但越界的夹到边界。
     */
    for (const [key, min, max] of NUMERIC_SETTING_RANGES) {
      const v = (settings as any)[key];
      const fallback = (DEFAULT_SETTINGS as any)[key];
      // 粗细类字段下界 > 0：0 / 负数按非法值回落默认，别夹出一个画不出的笔尖
      (settings as any)[key] = !Number.isFinite(v) || (min > 0 && v <= 0)
        ? fallback
        : Math.max(min, Math.min(max, v));
    }
    /*
     * 形状线宽是「每种形状一份」的 Record，塞不进上面的标量区间表，单独校验。
     * 老 data.json 没有这个字段 / 值非法 → 该形状回落 DEFAULT_SETTINGS；
     * 合法但越界 → 夹到 1~8（与形状滑杆一致）。必须重建一个新对象，
     * 避免直接改到模块级 DEFAULT_SETTINGS 上那份共享引用。
     */
    const rawShapeSizes = (settings as any).defaultShapeSizes;
    const shapeDefaults = DEFAULT_SETTINGS.defaultShapeSizes;
    const shapeSizes: Record<string, number> = {};
    for (const k of ["line", "arrow", "rect", "ellipse"] as const) {
      const v = rawShapeSizes && typeof rawShapeSizes === "object" ? Number(rawShapeSizes[k]) : NaN;
      shapeSizes[k] =
        !Number.isFinite(v) || v <= 0 ? shapeDefaults[k] : Math.max(1, Math.min(8, v));
    }
    settings.defaultShapeSizes = shapeSizes as InkbookSettings["defaultShapeSizes"];
    /*
     * 快捷键覆盖表同样得校验：data.json 可能被同步工具 / 手工编辑 / 旧版本
     * 写成数组、字符串或带陌生动作 id 的对象。只留下已知动作 id + 字符串值，
     * 其余一律丢弃，避免脏数据进内存后让派发或设置页崩掉。
     */
    settings.hotkeys = sanitizeHotkeys((settings as any).hotkeys);
    // 橡皮模式是枚举字符串，同样防止脏数据（数组 / 陌生值）流进编辑器
    if (settings.lastEraserMode !== "whole" && settings.lastEraserMode !== "part") {
      settings.lastEraserMode = DEFAULT_SETTINGS.lastEraserMode;
    }
    this.settings = settings;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * 另一窗口 / 另一台设备改了 data.json 时由宿主调用（Sync、iCloud、
   * Obsidian 多窗口都是这条路）。
   *
   * 不实现这个钩子的话，本窗口内存里的 settings 会一直停留在启动时的
   * 旧快照；用户下一次点任何控件（选笔色、切侧栏、新建本子都调
   * saveSettings）都会用这份旧快照全量覆盖别人刚写的值 —— 真机表现就是
   * 「改了设置、重启就没了 / 两台设备互相覆盖」。这里重新读盘并让已经
   * 打开的编辑器立刻跟上。
   *
   * 不做「写前读盘再按字段合并」：那份逻辑分不清「本窗口刚删掉的旧字段」
   * 和「别的窗口刚加的新字段」，反而会把 toolPanel 这类已废弃的键又捞回来；
   * 而且读-改-写之间仍有竞态窗口。交给宿主的外部变更通知是更干净的解法：
   * 谁最后写盘谁生效，另一方随后被通知并刷新内存，不会静默回滚用户操作。
   */
  async onExternalSettingsChange(): Promise<void> {
    await this.loadSettings();
    this.refreshViews();
    /*
     * 已经打开的设置页也要重绘（INK-202）。
     *
     * 别的窗口改了设置 → data.json 变了 → 这里重读并刷新视图，
     * 但设置页的控件是打开时按当时的值建的 DOM，不重绘就还是旧值
     * ——用户看着「关闭自动保存」的开关是关的，实际磁盘上已经开了。
     * 不会冲掉正在拖的控件（onChange 实时读 plugin.settings），
     * 只是让显示跟上真实值。
     */
    const tab: any = this.settingTab;
    if (tab && typeof tab.display === "function" && tab.containerEl?.isShown?.()) {
      tab.display();
    }
  }

  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const v = leaf.view as any;
      if (v && typeof v.syncSettings === "function") v.syncSettings();
      // 关「自动保存」时，已经排队的那次落盘不能等定时器到点再写
      if (!this.settings.autosave && typeof v?.cancelPendingSaves === "function") {
        v.cancelPendingSaves();
      }
    }
  }
}
