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

  /*
   * 手指惯性倍率是用户明确要求过的体感参数（"还是不够远" → 调到 3）。
   * 钉一条断言不是测实现细节，是防止以后重构时被顺手改回 1。
   */
  pass(
    (view.editor as any).constructor.FLING_GAIN.touch >= 3,
    "手指惯性倍率 ≥ 3（当前 " +
      (view.editor as any).constructor.FLING_GAIN.touch +
      "）"
  );

  if (!window.__cdpTouch) {
    log("SKIP 没有 CDP 触摸桥，跳过端到端触摸断言");
    log("");
    log("ALL PASS");
    return;
  }
  const touch = window.__cdpTouch;

  /**
   * 直接派发 PointerEvent。
   *
   * 脚本造不出多指 TouchEvent，但 PointerEvent 是可以手造的——
   * editor 的整个手势层都建在 pointer 事件上，用它就能精确复现
   * 「先抬第二根手指」这种 CDP 触摸桥做不出来的顺序。
   */
  function ptrTo(el: HTMLElement, type: string, id: number, x: number, y: number) {
    el.dispatchEvent(
      new PointerEvent(type, {
        pointerId: id,
        pointerType: "touch",
        isPrimary: id === 11 || id === 21,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
        pressure: 1,
      })
    );
  }

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
    /*
     * 按下之后再取一次基准。
     *
     * 从「读 before」到「按下真的生效」之间有一次 CDP 往返（几十 ms），
     * 这期间页面**还在按惯性滑**——手指惯性放大到 3 倍后，这一段能有上百 px。
     * 那是测晚了，不是没打断。真正的判据是：按下之后不再移动。
     */
    const atPress = scroll.scrollTop;
    await sleep(260);
    const held = scroll.scrollTop;
    await touch("touchEnd", []);
    pass(
      Math.abs(held - atPress) < 2,
      "按下立刻打断惯性（按下后 260ms 只动 " +
        Math.abs(held - atPress).toFixed(1) +
        "px）"
    );
    pass(
      Math.abs(held - before) < 80,
      "打断点仍然在抬手附近（" +
        before.toFixed(0) +
        " → " +
        held.toFixed(0) +
        "）"
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

  /* ============ 场景 4：先抬一根手指，余指不能把页面拽走 ============ */
  /*
   * 真机最坏顺序：两根手指捏合，**先抬起第二根**。
   *
   * 这时 onUp 会因为 pointerId 是第一根而早退，gesture 仍停在 "pan"；
   * 剩下那根手指一动就走 `scrollTop = pan.top - dy`，
   * 而 pan.top 是捏合前的滚动位置——页面瞬间跳回去几千像素。
   * 用户报的「捏合放大缩小，页面会跳」就是这一下。
   */
  {
    scroll.scrollTop = 8000;
    await sleep(300);
    const topBefore = scroll.scrollTop;
    const pageBefore = ed.current;
    const zoomBefore = ed.getState().zoom;

    const pageEl = ed.recs[ed.current].pageEl as HTMLElement;
    const px = cx;
    const py = cy;
    const ptr = (type: string, id: number, x: number, y: number) =>
      ptrTo(pageEl, type, id, x, y);

    ptr("pointerdown", 11, px - 60, py);
    await sleep(30);
    ptr("pointerdown", 12, px + 60, py);
    await sleep(30);

    for (let i = 1; i <= 8; i++) {
      const g = 60 + i * 15;
      ptr("pointermove", 11, px - g, py);
      ptr("pointermove", 12, px + g, py);
      await sleep(25);
    }
    await sleep(80);
    const zoomMid = ed.getState().zoom;

    // 先抬第二根
    ptr("pointerup", 12, px + 180, py);
    await sleep(40);
    const topAfterUp = scroll.scrollTop;

    // 余指大幅移动——旧实现会在这里把 scrollTop 设回 pan.top
    for (let i = 1; i <= 6; i++) {
      ptr("pointermove", 11, px - 180, py - i * 40);
      await sleep(30);
    }
    const topAfterMove = scroll.scrollTop;

    ptr("pointerup", 11, px - 180, py - 240);
    await sleep(350);

    pass(
      zoomMid > zoomBefore,
      "余指场景：捏合照样生效（" + zoomBefore.toFixed(2) + " → " + zoomMid.toFixed(2) + "）"
    );
    pass(
      Math.abs(topAfterMove - topAfterUp) < 2,
      "先抬第二根后，余指移动不滚页面（" +
        topAfterUp.toFixed(0) +
        " → " +
        topAfterMove.toFixed(0) +
        "，起始 " +
        topBefore.toFixed(0) +
        "）"
    );
    pass(ed.current === pageBefore, "余指移动不跳页（" + pageBefore + " → " + ed.current + "）");
  }

  /* ======== 场景 5：两指中心落在纸外（页缝 / 首尾之外）也不能跳 ======== */
  /*
   * 缩小之后纸张之间是背景，双指中心常常正好落在两页之间的缝里。
   * 旧实现把锚点的 fy 夹到 [0,1]，等于把「缝里那个点」谎报成「纸边缘」，
   * 缩放后拼命把纸边缘往手指上拽 —— 整页平移一大段，就是"捏合会跳"。
   */
  {
    ed.setZoom(0.45);
    await sleep(320);

    const rec = ed.recs[ed.current];
    const srNow = scroll.getBoundingClientRect();
    const pageTopInScroll =
      rec.pageEl.getBoundingClientRect().top - srNow.top + scroll.scrollTop;
    // 页上方留出 150px 空白，好让"纸外"的点落在视口里
    scroll.scrollTop = Math.max(0, pageTopInScroll - 150);
    await sleep(250);

    const r0 = rec.pageEl.getBoundingClientRect();
    const bx = r0.left + r0.width / 2;
    const by = r0.top - 12; // 正上方那一页与本页之间 24px 缝的正中

    const a0 = ed.pickAnchor(bx, by);
    pass(
      !!a0 && (a0.fy > 1.001 || a0.fy < -0.001),
      "页缝里的锚点保留外推值，不再被夹到 [0,1]（fy=" +
        (a0 ? a0.fy.toFixed(3) : "null") +
        "）"
    );

    if (a0) {
      const recA = ed.recs[a0.index];
      const ra = recA.pageEl.getBoundingClientRect();
      const ax0 = ra.left + a0.fx * ra.width;
      const ay0 = ra.top + a0.fy * ra.height;
      const z0 = ed.getState().zoom;

      ptrTo(rec.pageEl as HTMLElement, "pointerdown", 21, bx - 50, by);
      await sleep(30);
      ptrTo(rec.pageEl as HTMLElement, "pointerdown", 22, bx + 50, by);
      await sleep(30);
      for (let i = 1; i <= 8; i++) {
        const g = 50 + i * 8;
        ptrTo(rec.pageEl as HTMLElement, "pointermove", 21, bx - g, by);
        ptrTo(rec.pageEl as HTMLElement, "pointermove", 22, bx + g, by);
        await sleep(25);
      }
      await sleep(80);
      const z1 = ed.getState().zoom;

      const ra2 = recA.pageEl.getBoundingClientRect();
      const ax1 = ra2.left + a0.fx * ra2.width;
      const ay1 = ra2.top + a0.fy * ra2.height;
      const drift = Math.hypot(ax1 - ax0, ay1 - ay0);

      ptrTo(rec.pageEl as HTMLElement, "pointerup", 22, bx + 114, by);
      await sleep(40);
      ptrTo(rec.pageEl as HTMLElement, "pointerup", 21, bx - 114, by);
      await sleep(200);

      pass(z1 > z0, "纸外捏合确实放大了（" + z0.toFixed(2) + " → " + z1.toFixed(2) + "）");
      pass(drift < 3, "纸外锚点不漂移（漂移 " + drift.toFixed(2) + "px）");
    }
  }

  /* ==== 场景 6：缩到最小后两指全落在纸外空白里，仍必须能放大（INK-211） ==== */
  /*
   * 真机反馈：Word 文档导入后缩到最小，再想双指张开就永远放不大。
   *
   * 根因是纸外的 pointermove / pointerup 从来没进仲裁器：
   *   · move 只在有 .mb-page 时走 onMove，纸外只 onLeave → 两指距离
   *     永远停在开始值，applyPinch 一次都不执行；
   *   · up 同理不喂仲裁器 → touchCount 不减、gesturing 永真，
   *     手势卡死，后续触摸全被吞掉。
   * 缩到 0.3 时纸只剩三百多像素高，两指几乎必然落在纸外，所以必现。
   */
  {
    ed.setZoom(0.3);
    await sleep(320);
    const zoomMin = ed.getState().zoom;
    const docEl = ed.docEl as HTMLElement;
    const sr2 = scroll.getBoundingClientRect();
    // 取滚动容器底部附近的空白：纸已经缩得很小，这里必然没有 .mb-page
    const blankY = sr2.bottom - 24;
    const blankX = sr2.left + sr2.width / 2;
    pass(
      !docEl.querySelector(".mb-page")?.contains(document.elementFromPoint(blankX, blankY)),
      "INK-211 前置：所选位置确实在纸外（y=" + blankY.toFixed(0) + "）"
    );

    const g0 = 40;
    ptrTo(docEl, "pointerdown", 31, blankX - g0, blankY);
    await sleep(30);
    ptrTo(docEl, "pointerdown", 32, blankX + g0, blankY);
    await sleep(30);
    for (let i = 1; i <= 10; i++) {
      const g = g0 + i * 12;
      ptrTo(docEl, "pointermove", 31, blankX - g, blankY);
      ptrTo(docEl, "pointermove", 32, blankX + g, blankY);
      await sleep(25);
    }
    await sleep(80);
    const zoomOut = ed.getState().zoom;
    pass(
      zoomOut > zoomMin + 0.05,
      "INK-211 纸外两指张开真的放大了（" + zoomMin.toFixed(2) + " → " + zoomOut.toFixed(2) + "）"
    );

    // 纸外抬手也必须收干净，否则手势卡死、下一轮捏合完全失灵
    ptrTo(docEl, "pointerup", 32, blankX + g0 + 120, blankY);
    await sleep(40);
    ptrTo(docEl, "pointerup", 31, blankX - g0 - 120, blankY);
    await sleep(150);
    pass(
      !ed.arbiter.isGesturing && ed.arbiter.touchCountNow === 0,
      "INK-211 纸外抬手后手势已复位（gesturing=" + ed.arbiter.isGesturing +
        "；touchCount=" + ed.arbiter.touchCountNow + "）"
    );

    // 再来一轮：证明不是「第一次侥幸」，手势没有残留死状态
    const zoomBefore2 = ed.getState().zoom;
    ptrTo(docEl, "pointerdown", 41, blankX - 30, blankY);
    await sleep(30);
    ptrTo(docEl, "pointerdown", 42, blankX + 30, blankY);
    await sleep(30);
    for (let i = 1; i <= 8; i++) {
      const g = 30 + i * 14;
      ptrTo(docEl, "pointermove", 41, blankX - g, blankY);
      ptrTo(docEl, "pointermove", 42, blankX + g, blankY);
      await sleep(25);
    }
    await sleep(80);
    pass(
      ed.getState().zoom > zoomBefore2 + 0.03,
      "INK-211 连续第二次纸外捏合仍然有效（" + zoomBefore2.toFixed(2) + " → " +
        ed.getState().zoom.toFixed(2) + "）"
    );
    ptrTo(docEl, "pointerup", 42, blankX + 142, blankY);
    await sleep(30);
    ptrTo(docEl, "pointerup", 41, blankX - 142, blankY);
    await sleep(150);
  }

  /* ==== 场景 7：纸外单指拖动也能滚页（INK-215） ==== */
  /*
   * 缩到 0.3 后大片是空白，`touch-action: none` 又关了浏览器原生滚动。
   * 纸外按下原先只记账不设 pan → 从空白处往下拖页面纹丝不动，
   * 必须精确按到那三百多像素高的纸上才能滚。这是老缺口。
   */
  {
    ed.setZoom(0.45);
    await sleep(320);
    scroll.scrollTop = 1200;
    await sleep(200);
    const docEl2 = ed.docEl as HTMLElement;
    const sr3 = scroll.getBoundingClientRect();
    const by = sr3.bottom - 24;
    const bx = sr3.left + sr3.width / 2;
    const top0 = scroll.scrollTop;

    ptrTo(docEl2, "pointerdown", 51, bx, by);
    await sleep(30);
    for (let i = 1; i <= 8; i++) {
      ptrTo(docEl2, "pointermove", 51, bx, by - i * 12);
      await sleep(25);
    }
    const top1 = scroll.scrollTop;
    pass(
      top1 > top0 + 40,
      "INK-215 纸外单指上拖真的滚页了（" + top0.toFixed(0) + " → " + top1.toFixed(0) + "）"
    );
    ptrTo(docEl2, "pointerup", 51, bx, by - 96);
    await sleep(400);
    pass(
      ed.gesture === "none" && ed.pointerId === null,
      "INK-215 纸外平移抬手后手势已复位（gesture=" + ed.gesture + "）"
    );
  }

  log("");
  const fails = lines.filter((l) => l.startsWith("FAIL")).length;
  log(fails === 0 ? "ALL PASS" : fails + " FAILED");
})();
