import InkbookPlugin from "../src/main";

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

/** 原型上带 trigger：插件只该改这个原型，不该落到 Object.prototype */
const wsProto: any = {
  trigger(this: any, name: string, data?: any) {
    swipeCalls.push([name, data]);
  },
};
const workspace: any = Object.create(wsProto);
Object.assign(workspace, {
  on: () => ({}),
  onLayoutReady: (cb: () => void) => setTimeout(cb, 0),
  getLeaf: () => ({ openFile: async () => {}, setViewState: async () => {} }),
  getActiveFile: () => activeFile,
  getActiveViewOfType: () => null,
  getLeavesOfType: () => inkbookLeaves,
});

const app: any = {
  viewRegistry: { typeByExtension: { pdf: "pdf", md: "markdown" }, trigger() {} },
  vault: {
    adapter: { exists: async () => false, read: async () => "", write: async () => {}, mkdir: async () => {}, writeBinary: async () => {}, readBinary: async () => new ArrayBuffer(0), getFullPath: (p: string) => p },
    getFiles: () => [],
    getAbstractFileByPath: () => null,
  },
  workspace,
};

const manifest = { id: "inkbook", name: "墨本 Inkbook", version: "0.1.0", dir: ".obsidian/plugins/inkbook" };

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
    log((cmds.length === 3 ? "PASS" : "FAIL") + " 命令 3 条：" + cmds.map((c: any) => c.id).join(","));
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

    plugin.onunload();
    log(
      ((wsProto.trigger as any).__inkbookPatched ? "FAIL" : "PASS") + " 卸载后原型已还原（无残留补丁）"
    );
    inkbookLeaves = leafWith(true);
    log((fire() === 1 ? "PASS" : "FAIL") + " 卸载后不再拦截：1 次");
  } catch (e: any) {
    log("FAIL " + (e && e.stack ? e.stack : e));
  }
  document.title = "DONE";
}
main();
