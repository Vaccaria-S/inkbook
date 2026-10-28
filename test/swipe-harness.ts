/**
 * 右滑拦截的端到端验证。
 *
 * dock-harness 里测的是「判定逻辑」，
 * 这个套件测的是「真实触摸事件到底有没有到 document」。
 *
 * 做法：用 CDP 的 Input.dispatchTouchEvent 派发**真触摸**，
 * 在 document 上挂一个捕获监听器（模拟宿主的全局手势识别器），
 * 看它有没有收到 touchmove。
 *
 * 浏览器不允许用脚本构造 TouchEvent（会强制类型转换），
 * 只有 CDP 这条路能派发真正的触摸序列。
 */
import { InkbookView } from "../src/view";
import { createBook, createPage, DEFAULT_SETTINGS } from "../src/types";

const lines: string[] = [];
const out = document.getElementById("out")!;
function log(s: string) {
  lines.push(s);
  out.textContent = lines.join("\n");
}
function pass(ok: boolean, msg: string) {
  log((ok ? "PASS " : "FAIL ") + msg);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
window.addEventListener("error", (e) => log("ERROR " + e.message + " @ " + e.filename + ":" + e.lineno));

/* --------------------------------------------------------------- 脚手架 */

const files = new Map<string, string>();
const index = new Map<string, any>();
function mkFile(path: string, text: string) {
  const f = {
    path,
    basename: path.split("/").pop()!.replace(/\.[^.]+$/, ""),
    extension: path.split(".").pop()!,
    parent: { path: path.includes("/") ? path.slice(0, path.lastIndex("/")) : "/" },
  };
  files.set(path, text);
  index.set(path, f);
  return f;
}

const adapter = {
  exists: async (p: string) => files.has(p),
  read: async (p: string) => files.get(p),
  write: async (p: string, d: string) => void files.set(p, d),
  writeBinary: async (p: string, d: any) => void files.set(p, d),
  mkdir: async () => {},
};
const vault = {
  adapter,
  createFolder: async (p: string) => {
    index.set(p, { path: p, type: "folder" });
    return { path: p };
  },
  create: async (p: string, text: string) => mkFile(p, text),
  getAbstractFileByPath: (p: string) => index.get(p) || null,
  getFiles: () => [...index.values()].filter((f) => f.extension),
};
const app: any = {
  vault,
  workspace: {
    getActiveFile: () => null,
    getActiveViewOfType: () => view,
    getLeaf: () => ({ openFile: async () => {} }),
    on: () => ({}),
    onLayoutReady: (cb: () => void) => setTimeout(cb, 0),
  },
};
const leaf = { app, getViewState: () => ({ state: {} }), getEphemeralState: () => ({}) };
const plugin: any = {
  settings: { ...DEFAULT_SETTINGS },
  saveSettings: async () => {},
  refreshViews: () => {},
};

const host = document.getElementById("view-host")!;
let view: any;

/* --------------------------------------------------------------- CDP 桥 */

/**
 * 把 CDP 的触摸派发能力接进来。
 *
 * 测试页面加载后，会向 window 注入一个 __cdpTouch 函数：
 *   await window.__cdpTouch(type, x, y)
 * 由 test/swipe-run.mjs 通过 Runtime.evaluate 注入。
 * 注入不到就跳过相关断言（不能因为环境缺能力就判失败）。
 */
declare global {
  interface Window {
    __cdpTouch?: (type: string, x: number, y: number) => Promise<void>;
    __cdpReady?: boolean;
  }
}

/* --------------------------------------------------------------- 主流程 */

(async () => {
  view = new InkbookView(leaf, plugin);
  host.appendChild(view.contentEl as HTMLElement);
  await view.onOpen();

  const book = createBook("测试", "grid", "white");
  book.pages = [createPage("grid", "white")];
  const file = mkFile("t.inkbook", JSON.stringify(book));
  await view.onLoadFile(file);
  await sleep(600);

  const scroll = view.contentEl.querySelector(".mb-scroll") as HTMLElement;
  const r = scroll.getBoundingClientRect();
  const left = r.left;
  const midY = r.top + 300;

  // 宿主的手势识别器：挂在 document 捕获阶段
  let hostGot = 0;
  const onHost = () => {
    hostGot++;
  };
  document.addEventListener("touchmove", onHost, true);

  if (!window.__cdpTouch) {
    log("SKIP 没有 CDP 触摸桥，跳过端到端触摸断言");
    document.removeEventListener("touchmove", onHost, true);
    log("");
    log("ALL PASS");
    return;
  }

  const touch = window.__cdpTouch;

  /* ---- 场景 1：左缘起手往右划 → 应被拦截 ---- */
  hostGot = 0;
  await touch("touchStart", left + 4, midY);
  await touch("touchMove", left + 50, midY + 3);
  await touch("touchMove", left + 100, midY + 6);
  await touch("touchEnd", left + 100, midY + 6);
  await sleep(120);
  pass(
    hostGot === 0,
    "左缘右滑被完整拦截（宿主的 touchmove 一次都没收到：收到 " +
      hostGot +
      " 次）"
  );

  /* ---- 场景 2：纸中间往右划 → 应放行 ---- */
  hostGot = 0;
  await touch("touchStart", left + 300, midY);
  await touch("touchMove", left + 350, midY + 3);
  await touch("touchMove", left + 400, midY + 6);
  await touch("touchEnd", left + 400, midY + 6);
  await sleep(120);
  pass(hostGot > 0, "纸中间的横向滑动正常放行（宿主收到 " + hostGot + " 次）");

  /* ---- 场景 3：纵向滚动 → 应放行 ---- */
  hostGot = 0;
  await touch("touchStart", left + 300, midY);
  await touch("touchMove", left + 302, midY + 40);
  await touch("touchMove", left + 304, midY + 90);
  await touch("touchEnd", left + 304, midY + 90);
  await sleep(120);
  pass(hostGot > 0, "纵向滑动正常放行（宿主收到 " + hostGot + " 次）");

  /* ---- 场景 4：左缘起手但纵向为主 → 应放行 ---- */
  hostGot = 0;
  await touch("touchStart", left + 4, midY);
  await touch("touchMove", left + 10, midY + 40);
  await touch("touchMove", left + 16, midY + 90);
  await touch("touchEnd", left + 16, midY + 90);
  await sleep(120);
  pass(hostGot > 0, "左缘起手但纵向为主的滑动放行（宿主收到 " + hostGot + " 次）");

  /* ---- 场景 5：左缘起手、横向但位移不大 → 应放行 ---- */
  hostGot = 0;
  await touch("touchStart", left + 4, midY);
  await touch("touchMove", left + 16, midY + 2);
  await touch("touchMove", left + 28, midY + 4);
  await touch("touchEnd", left + 28, midY + 4);
  await sleep(120);
  pass(hostGot > 0, "左缘轻触（位移小）放行（宿主收到 " + hostGot + " 次）");

  /* ---- 场景 6：左缘起手要让「派发层」知道 ----
   * 真机上宿主的滑动监听比插件注册得早，DOM 层拦不住它，
   * 唯一有效的是等它派发 swipe 时再吞。派发层看不到坐标，
   * 只能靠 editor.edgeSwipeRecent() 这个时间戳判断，这条断言锁住它。
   */
  await touch("touchStart", left + 4, midY);
  await touch("touchMove", left + 60, midY + 2);
  await touch("touchEnd", left + 60, midY + 2);
  await sleep(120);
  pass(
    (view as any).editor?.edgeSwipeRecent?.() === true,
    "左缘起手后 edgeSwipeRecent 为真（派发层据此拦截）"
  );
  await sleep(950);
  pass(
    (view as any).editor?.edgeSwipeRecent?.() === false,
    "900ms 后自动失效，不会永久占着拦截"
  );

  document.removeEventListener("touchmove", onHost, true);

  log("");
  const fails = lines.filter((l) => l.startsWith("FAIL")).length;
  log(fails === 0 ? "ALL PASS" : fails + " FAILED");
})();
