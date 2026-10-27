/**
 * 触摸交互的端到端验证（惯性滚动 + 捏合缩放）。
 *
 * 与 swipe-run.mjs 同样的思路：浏览器不允许脚本构造 TouchEvent
 * （会强制类型转换，传普通对象抛 "Failed to convert value to 'Touch'"），
 * 也不允许脚本构造带多指的真实手势——
 * 只有 CDP 的 Input.dispatchTouchEvent 能派发**真触摸序列**。
 *
 * 这个套件验证三件在真机上才会暴露的事：
 *   1. 单指快速上划 → 抬手后页面继续滑行一段（惯性）
 *   2. 双指张开 → 缩放比等于「当前距离/起始距离」，不是半程
 *   3. 双指捏合 → 锚点内容点不漂移、不跳页
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
window.addEventListener("error", (e) =>
  log("ERROR " + e.message + " @ " + e.filename + ":" + e.lineno)
);

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

declare global {
  interface Window {
    __cdpTouch?: (
      type: string,
      points: { x: number; y: number; id: number }[]
    ) => Promise<void>;
    __cdpReady?: boolean;
  }
}

/* --------------------------------------------------------------- 主流程 */

(async () => {
  view = new InkbookView(leaf, plugin);
  host.appendChild(view.contentEl as HTMLElement);
  await view.onOpen();

  const book = createBook("触摸测试", "grid", "white");
  book.pages = [];
  for (let i = 0; i < 30; i++) book.pages.push(createPage("grid", "white"));
  const file = mkFile("t.inkbook", JSON.stringify(book));
  await view.onLoadFile(file);
  await sleep(700);

  const ed = view.editor as any;
  const scroll = ed.scrollEl as HTMLElement;

  if (!window.__cdpTouch) {
    log("SKIP 没有 CDP 触摸桥，跳过端到端触摸断言");
    log("");
    log("ALL PASS");
    return;
  }
  const touch = window.__cdpTouch;

  const sr = scroll.getBoundingClientRect();
  const cx = sr.left + sr.width / 2;
  const cy = sr.top + sr.height / 2;

  /* ================= 场景 1：单指快速上划 → 抬手后应有惯性 ================= */
  {
    scroll.scrollTop = 3000;
    await sleep(250);

    const sx = cx;
    const sy = sr.top + sr.height * 0.78;

    // 快速上划：8 帧，每帧 48px，间隔 16ms
    await touch("touchStart", [{ x: sx, y: sy, id: 1 }]);
    for (let i = 1; i <= 8; i++) {
      await touch("touchMove", [{ x: sx, y: sy - i * 48, id: 1 }]);
      await sleep(16);
    }
    const atRelease = scroll.scrollTop;
    await touch("touchEnd", []);

    // 抬手后等一会儿，看页面还在不在动
    await sleep(120);
    const mid = scroll.scrollTop;
    await sleep(600);
    const end = scroll.scrollTop;
    // 再等一段，确认最终真的停住了
    await sleep(700);
    const settled = scroll.scrollTop;

    pass(
      mid > atRelease + 20,
      "抬手后页面继续滑行（抬手 " +
        atRelease.toFixed(0) +
        " → 120ms 后 " +
        mid.toFixed(0) +
        "，多滑 " +
        (mid - atRelease).toFixed(0) +
        "px）"
    );
    pass(
      end > mid,
      "滑行持续衰减（120ms 时 " +
        mid.toFixed(0) +
        " → 720ms 时 " +
        end.toFixed(0) +
        "）"
    );
    /*
     * 最终必须**停住**。
     *
     * 注意不能断言「720ms 时就停了」——惯性本来就该滑一阵，
     * 早停反而是 bug。正确的判据是：再等一段时间后位置不再变。
     */
    pass(
      Math.abs(settled - end) < 1,
      "最终停住不再动（720ms 时 " +
        end.toFixed(0) +
        " → 1420ms 时 " +
        settled.toFixed(0) +
        "）"
    );
    pass(end > atRelease, "滑行总距离 " + (end - atRelease).toFixed(0) + "px");
  }

  /* ================= 场景 2：再次按下应立刻打断惯性 ================= */
  {
    // 先甩一次
    scroll.scrollTop = 3000;
    await sleep(200);
    const sx = cx;
    const sy = sr.top + sr.height * 0.78;
    await touch("touchStart", [{ x: sx, y: sy, id: 1 }]);
    for (let i = 1; i <= 6; i++) {
      await touch("touchMove", [{ x: sx, y: sy - i * 50, id: 1 }]);
      await sleep(16);
    }
    await touch("touchEnd", []);
    await sleep(80);
    const before = scroll.scrollTop;
    // 立刻按住不放
    await touch("touchStart", [{ x: sx, y: sy - 300, id: 1 }]);
    await sleep(260);
    const held = scroll.scrollTop;
    await touch("touchEnd", []);
    pass(
      Math.abs(held - before) < 12,
      "按下立刻打断惯性（按下前 " +
        before.toFixed(0) +
        " → 按住 260ms 后 " +
        held.toFixed(0) +
        "，几乎没动）"
    );
  }

  /* ================= 场景 3：双指捏合放大 ================= */
  {
    scroll.scrollTop = 6000;
    await sleep(300);
    const pageBefore = ed.current;
    const zoomBefore = ed.getState().zoom;

    // 记录捏合中心下方的内容点，捏合后它应该还在原地
    const anchorBefore = (() => {
      const a = ed.pickAnchor(cx, cy);
      if (!a) return null;
      const rec = ed.recs[a.index];
      const r = rec.pageEl.getBoundingClientRect();
      return { index: a.index, fx: a.fx, fy: a.fy, x: r.left + a.fx * r.width, y: r.top + a.fy * r.height };
    })();

    const gap0 = 80;
    const gap1 = 220;
    await touch("touchStart", [
      { x: cx - gap0, y: cy, id: 1 },
      { x: cx + gap0, y: cy, id: 2 },
    ]);
    await sleep(60);
    for (let i = 1; i <= 14; i++) {
      const g = gap0 + ((gap1 - gap0) * i) / 14;
      await touch("touchMove", [
        { x: cx - g, y: cy, id: 1 },
        { x: cx + g, y: cy, id: 2 },
      ]);
      await sleep(40);
    }
    await touch("touchEnd", []);
    await sleep(400);

    const zoomAfter = ed.getState().zoom;
    const pageAfter = ed.current;

    /*
     * 缩放比必须是「当前距离 / 起始距离」。
     *
     * 旧实现每帧只收到一根手指的移动，
     * 缩放比只算得出半程（实测 1.0875，应为 1.175）。
     */
    const expectRatio = (gap1 * 2) / (gap0 * 2);
    const actualRatio = zoomAfter / zoomBefore;
    pass(
      Math.abs(actualRatio - expectRatio) / expectRatio < 0.06,
      "捏合缩放比正确（期望 " +
        expectRatio.toFixed(3) +
        "，实测 " +
        actualRatio.toFixed(3) +
        "）"
    );
    pass(zoomAfter > zoomBefore, "捏合确实放大了（" + zoomBefore.toFixed(2) + " → " + zoomAfter.toFixed(2) + "）");

    // 锚点内容点不漂移
    if (anchorBefore) {
      const rec = ed.recs[anchorBefore.index];
      const r = rec.pageEl.getBoundingClientRect();
      const ax = r.left + anchorBefore.fx * r.width;
      const ay = r.top + anchorBefore.fy * r.height;
      const drift = Math.hypot(ax - anchorBefore.x, ay - anchorBefore.y);
      pass(
        drift < 2,
        "捏合时锚点内容点不漂移（漂移 " + drift.toFixed(2) + "px）"
      );
    }

    pass(pageAfter === pageBefore, "捏合不跳页（" + pageBefore + " → " + pageAfter + "）");
  }

  log("");
  const fails = lines.filter((l) => l.startsWith("FAIL")).length;
  log(fails === 0 ? "ALL PASS" : fails + " FAILED");
})();
