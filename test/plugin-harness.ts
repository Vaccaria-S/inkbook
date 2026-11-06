import InkbookPlugin from "../src/main";
import { TFile } from "obsidian";

const lines: string[] = [];
const out = document.getElementById("out")!;
const log = (s: string) => {
  lines.push(s);
  out.textContent = lines.join("\n");
};
window.addEventListener("error", (e) => log("WINDOW ERROR: " + e.message));
window.addEventListener("unhandledrejection", (e) => log("UNHANDLED: " + (e.reason?.stack || e.reason)));

/** 宿主派发过的 swipe 事件（打桩记录） */
const swipeCalls: any[] = [];
/** getLeavesOfType 的返回值，测试里按需改 */
let inkbookLeaves: any[] = [];
/** getActiveFile 的返回值 */
let activeFile: any = null;
/** revealLeaf 的调用记录（多标签防呆用） */
const revealed: any[] = [];
/** getLeaf(mode) 的调用记录 */
const leafRequests: string[] = [];
/** getAbstractFileByPath 的返回值（默认 null = 找不到文件） */
let abstractFile: any = null;

/** 原型上带 trigger：插件只该改这个原型，不该落到 Object.prototype */
const wsProto: any = {
  trigger(this: any, name: string, data?: any) {
    swipeCalls.push([name, data]);
  },
};
const workspace: any = Object.create(wsProto);
Object.assign(workspace, {
  on: (evt: string, cb: any) => {
    if (evt === "file-open") fileOpenCb = cb;
    return {};
  },
  onLayoutReady: (cb: () => void) => setTimeout(cb, 0),
  getLeaf: (mode?: any) => {
    leafRequests.push(String(mode));
    return { openFile: async () => {}, setViewState: async () => {} };
  },
  revealLeaf: (leaf: any) => {
    revealed.push(leaf);
  },
  getActiveFile: () => activeFile,
  getActiveViewOfType: () => null,
  getLeavesOfType: () => inkbookLeaves,
});

/** commands.executeCommandById 的调用记录（打桩：被拦下的不会走到这里） */
const cmdCalls: string[] = [];
const commandsApi: any = {
  executeCommandById(id: string) {
    cmdCalls.push(id);
    return true;
  },
};

const app: any = {
  commands: commandsApi,
  viewRegistry: { typeByExtension: { pdf: "pdf", md: "markdown" }, trigger() {} },
  vault: {
    adapter: { exists: async () => false, read: async () => "", write: async () => {}, mkdir: async () => {}, writeBinary: async () => {}, readBinary: async () => new ArrayBuffer(0), getFullPath: (p: string) => p },
    getFiles: () => [],
    getAbstractFileByPath: () => abstractFile,
  },
  workspace,
};

const manifest = { id: "inkbook", name: "墨本 Inkbook", version: "0.1.0", dir: ".obsidian/plugins/inkbook" };

/** file-open 事件的回调（插件注册在 workspace.on("file-open") 上） */
let fileOpenCb: ((f: any) => void) | null = null;
/** openBookAt 打开时记下的路径 + 页码 */
const openedAt: Array<{ path: string; page: number }> = [];

async function main() {
  try {
    const plugin = new InkbookPlugin(app, manifest);
    log("PASS 构造函数");
    await plugin.onload();
    log("PASS onload");
    const map = app.viewRegistry.typeByExtension;
    log((map.inkbook === "inkbook-view" ? "PASS" : "FAIL") + " inkbook 扩展名 = " + map.inkbook);
    log((app.__views && app.__views["inkbook-view"] ? "PASS" : "FAIL") + " 视图已注册");
    const cmds = (window as any).__commands || [];
    const hasRebuild = cmds.some((c: any) => c.id === "inkbook-rebuild-index");
    log(
      (cmds.length === 4 && hasRebuild ? "PASS" : "FAIL") +
        " 命令 4 条（含重建索引）：" +
        cmds.map((c: any) => c.id).join(",")
    );
    log((window as any).__settingTab ? "PASS 设置面板已注册" : "FAIL 设置面板缺失");
    const v = app.__views["inkbook-view"]({ app });
    log((v && v.getViewType() === "inkbook-view" ? "PASS" : "FAIL") + " 视图工厂可创建");

    /* ---- 派发层 swipe 拦截（真机唯一有效的那一层） ---- */
    const fire = (): number => {
      const before = swipeCalls.length;
      workspace.trigger("swipe", { direction: "x", points: 1 });
      return swipeCalls.length - before;
    };
    const leafWith = (edge: boolean) => [{ view: { editor: { edgeSwipeRecent: () => edge } } }];

    plugin.settings.blockEdgeSwipe = true;
    inkbookLeaves = leafWith(true);
    log((fire() === 0 ? "PASS" : "FAIL") + " 左缘起手的横滑被吞掉：宿主收到 0 次");
    inkbookLeaves = leafWith(false);
    log((fire() === 1 ? "PASS" : "FAIL") + " 纸面中间的横滑照常派发：1 次");
    inkbookLeaves = leafWith(true);
    plugin.settings.blockEdgeSwipe = false;
    log((fire() === 1 ? "PASS" : "FAIL") + " 设置关掉后放行：1 次");
    plugin.settings.blockEdgeSwipe = true;

    let before = swipeCalls.length;
    workspace.trigger("swipe", { direction: "y", points: 1 });
    log((swipeCalls.length - before === 1 ? "PASS" : "FAIL") + " 竖滑不受影响：1 次");

    log(
      (Object.prototype.hasOwnProperty.call(Object.prototype, "trigger") ? "FAIL" : "PASS") +
        " 未污染 Object.prototype"
    );

    /* 活动文件是 .inkbook 时，不看坐标也不看时间，一律拦 */
    plugin.settings.blockEdgeSwipe = true;
    inkbookLeaves = [];
    activeFile = { extension: "inkbook" };
    log((fire() === 0 ? "PASS" : "FAIL") + " 活动文件是 .inkbook 时直接拦（宿主收到 0 次）");
    activeFile = { extension: "md" };
    log((fire() === 1 ? "PASS" : "FAIL") + " 活动文件是 md 时放行（1 次）");
    activeFile = { extension: "inkbook" };
    plugin.settings.blockEdgeSwipe = false;
    log((fire() === 1 ? "PASS" : "FAIL") + " 开关关掉后即使活动文件是 .inkbook 也放行（1 次）");
    plugin.settings.blockEdgeSwipe = true;

    /* ---- 派发层：墨本里屏蔽命令面板（平板拖滑条会误触它） ---- */
    const fireCmd = (id: string): number => {
      const b = cmdCalls.length;
      commandsApi.executeCommandById(id);
      return cmdCalls.length - b;
    };
    /** 模拟一次真实触摸（下拉手势一定伴随它） */
    const touch = () =>
      document.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 99 })
      );
    activeFile = { extension: "inkbook" };
    plugin.settings.blockCommandPalette = true;
    touch();
    log(
      (fireCmd("command-palette:open") === 0 ? "PASS" : "FAIL") +
        " 墨本里触摸误触命令面板被吞掉：宿主收到 0 次"
    );
    /*
     * 键盘 Ctrl+P 不该被拦：否则墨本自己注册的 4 条命令在 Obsidian 里
     * 根本搜不到。判据是「最近 600ms 内没有触摸」。
     */
    (plugin as any).lastTouchAt = 0;
    log(
      (fireCmd("command-palette:open") === 1 ? "PASS" : "FAIL") +
        " 墨本里键盘 Ctrl+P 放行：宿主收到 1 次（墨本命令可搜）"
    );
    log(
      (fireCmd("editor:save-file") === 1 ? "PASS" : "FAIL") + " 别的命令照常派发：1 次"
    );
    activeFile = { extension: "md" };
    log(
      (fireCmd("command-palette:open") === 1 ? "PASS" : "FAIL") +
        " 非墨本文件里命令面板照常：1 次"
    );
    activeFile = { extension: "inkbook" };
    plugin.settings.blockCommandPalette = false;
    log(
      (fireCmd("command-palette:open") === 1 ? "PASS" : "FAIL") + " 开关关掉后放行：1 次"
    );
    plugin.settings.blockCommandPalette = true;

    /* ---- 同一本已开在别的标签：默认切过去，不新开第二份 store ---- */
    {
      const bookFile: any = new TFile();
      bookFile.path = "笔记/代数.inkbook";
      bookFile.extension = "inkbook";
      abstractFile = bookFile;
      activeFile = null;
      const jumped: number[] = [];
      const leaf: any = {
        view: { file: bookFile, gotoPageFromLink: (p: number) => jumped.push(p) },
      };
      inkbookLeaves = [leaf];
      revealed.length = 0;
      leafRequests.length = 0;

      await (plugin as any).openBookAt(bookFile.path, 12);
      log(
        (revealed.length === 1 &&
        revealed[0] === leaf &&
        jumped.join(",") === "12" &&
        leafRequests.length === 0
          ? "PASS"
          : "FAIL") +
          " 同一本已在别的标签 → reveal 原叶并翻页，不新建 leaf（reveal " +
          revealed.length +
          " / 新建 " +
          leafRequests.length +
          "）"
      );

      await (plugin as any).openBookAt(bookFile.path, 5, { newTab: true });
      log(
        (revealed.length === 1 && leafRequests[0] === "tab" ? "PASS" : "FAIL") +
          " 明确 newTab → 照开新标签，不抢原标签（新建 " +
          leafRequests.length +
          "）"
      );

      abstractFile = null;
      inkbookLeaves = [];
    }

    plugin.onunload();
    log(
      ((wsProto.trigger as any).__inkbookPatched ? "FAIL" : "PASS") + " 卸载后原型已还原（无残留补丁）"
    );
    log(
      (fireCmd("command-palette:open") === 1 ? "PASS" : "FAIL") +
        " 卸载后命令面板恢复（commands 未被残留包装）"
    );
    inkbookLeaves = leafWith(true);
    log((fire() === 1 ? "PASS" : "FAIL") + " 卸载后不再拦截：1 次");

    /* ---- 搜索结果点开 → 直接落到本子那一页 ---- */
    /*
     * 用户原话：「在笔记文件里搜索打的字时……我想要的是直接显示出是这个文件」。
     *
     * 索引页的文件名带本子名（全局搜索结果显示的就是文件名），
     * 点开之后靠 parseIndexPath 反查出「哪本 + 第几页」，
     * 然后换成本子并滚到那一页——不停在 md 里。
     */
    {
      const bookFile = { path: "笔记/数学.inkbook", extension: "inkbook" };
      (app.vault as any).getAbstractFileByPath = (p: string) =>
        p === bookFile.path ? bookFile : null;
      const origOpen = (plugin as any).openBookAt.bind(plugin);
      (plugin as any).openBookAt = async (path: string, page: number) => {
        openedAt.push({ path, page });
      };

      // 新命名：数学 · 第 12 页.md
      fileOpenCb?.({ path: "笔记/数学.墨本索引/数学 · 第 12 页.md" });
      await new Promise((r) => setTimeout(r, 120));
      log(
        (openedAt.length === 1 &&
          openedAt[0].path === "笔记/数学.inkbook" &&
          openedAt[0].page === 12
          ? "PASS"
          : "FAIL") +
          " 点开新命名的索引页 → 跳到「笔记/数学.inkbook」第 12 页：" +
          JSON.stringify(openedAt[0] || null)
      );

      // 旧命名（迁移期残留）：第 12 页.md —— 点开也得能跳回去
      openedAt.length = 0;
      fileOpenCb?.({ path: "笔记/数学.墨本索引/第 12 页.md" });
      await new Promise((r) => setTimeout(r, 120));
      log(
        (openedAt.length === 1 &&
          openedAt[0].path === "笔记/数学.inkbook" &&
          openedAt[0].page === 12
          ? "PASS"
          : "FAIL") +
          " 点开旧命名的索引页 → 同样跳到第 12 页：" +
          JSON.stringify(openedAt[0] || null)
      );

      // 普通 md 不能被当成索引页
      openedAt.length = 0;
      fileOpenCb?.({ path: "笔记/普通笔记.md" });
      await new Promise((r) => setTimeout(r, 120));
      log(
        (openedAt.length === 0 ? "PASS" : "FAIL") + " 普通 md 不会被当成索引页"
      );

      (plugin as any).openBookAt = origOpen;
    }
  } catch (e: any) {
    log("FAIL " + (e && e.stack ? e.stack : e));
  }
  document.title = "DONE";
}
main();
