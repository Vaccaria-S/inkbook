import InkbookPlugin from "../src/main";

const lines: string[] = [];
const out = document.getElementById("out")!;
const log = (s: string) => {
  lines.push(s);
  out.textContent = lines.join("\n");
};
window.addEventListener("error", (e) => log("WINDOW ERROR: " + e.message));
window.addEventListener("unhandledrejection", (e) => log("UNHANDLED: " + (e.reason?.stack || e.reason)));

const app: any = {
  viewRegistry: { typeByExtension: { pdf: "pdf", md: "markdown" }, trigger() {} },
  vault: {
    adapter: { exists: async () => false, read: async () => "", write: async () => {}, mkdir: async () => {}, writeBinary: async () => {}, readBinary: async () => new ArrayBuffer(0), getFullPath: (p: string) => p },
    getFiles: () => [],
    getAbstractFileByPath: () => null,
  },
  workspace: {
    on: () => ({}),
    onLayoutReady: (cb: () => void) => setTimeout(cb, 0),
    getLeaf: () => ({ openFile: async () => {}, setViewState: async () => {} }),
    getActiveFile: () => null,
    getActiveViewOfType: () => null,
    getLeavesOfType: () => [],
  },
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
  } catch (e: any) {
    log("FAIL " + (e && e.stack ? e.stack : e));
  }
  document.title = "DONE";
}
main();
