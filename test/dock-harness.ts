/**
 * 工具长条 + 右下角浮标 + 侧栏 回归测试。
 *
 * 覆盖五条主线：
 *   1. 竖长条结构：常驻右缘、7 个工具 + 侧栏开关 + 阅读开关
 *   2. 长条**不遮挡滚动条**（用户反馈"边上的框会挡住滑动页面的那个条"）
 *   3. 右下角浮标：翻页常驻、缩放**只在缩放时**浮现并显示确切倍数
 *   4. 侧栏收纳全部工具：导出 / 导入 / 撤销 / 输入方式都在里面
 *   5. 图标**真的看得见**（用户反馈"每一个框里面都看不到图标"）
 */
import { InkbookView } from "../src/view";
import { createBook, createPage, DEFAULT_SETTINGS, type Pt } from "../src/types";

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
window.addEventListener("unhandledrejection", (e) => log("REJECT " + (e.reason?.stack || e.reason)));

/* --------------------------------------------------------------- 脚手架 */

const files = new Map<string, string>();
const index = new Map<string, any>();
function mkFile(path: string, text: string) {
  const f = {
    path,
    basename: path.split("/").pop()!.replace(/\.[^.]+$/, ""),
    extension: path.split(".").pop()!,
    parent: { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/" },
  };
  files.set(path, text);
  index.set(path, f);
  return f;
}

function makeBook(pages = 3) {
  const book = createBook("测试手写本", "grid", "white");
  book.pages = [];
  for (let i = 0; i < pages; i++) {
    book.pages.push(createPage(i % 2 ? "lined" : "grid", i % 2 ? "cream" : "white"));
  }
  return book;
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
    // 快捷键只在「本视图是活跃视图」时才响应，
    // 所以这里必须真的返回 view，否则测不到 Esc 之类的行为。
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

/* --------------------------------------------------------------- 工具 */

const host = document.getElementById("view-host")!;
let view: any;
let root!: HTMLElement;

function strokeCountAll(): number {
  const pages = view.store?.data.pages ?? [];
  let n = 0;
  for (const p of pages) for (const l of p.layers) n += l.strokes.length;
  return n;
}

/** 在纸上按下-移动-抬起，模拟一次真实落笔 */
function drawAt(x: number, y: number, pointerType = "mouse") {
  const pageEl = root.querySelector(".mb-page") as HTMLElement;
  const r = pageEl.getBoundingClientRect();
  const mk = (type: string, cx: number, cy: number, buttons: number) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 77,
      pointerType,
      isPrimary: true,
      button: 0,
      buttons,
      clientX: cx,
      clientY: cy,
    });
  const px = r.left + x;
  const py = r.top + y;
  pageEl.dispatchEvent(mk("pointerdown", px, py, 1));
  pageEl.dispatchEvent(mk("pointermove", px + 30, py + 12, 1));
  pageEl.dispatchEvent(mk("pointermove", px + 60, py + 24, 1));
  pageEl.dispatchEvent(mk("pointerup", px + 60, py + 24, 0));
}

/* --------------------------------------------------------------- 主流程 */

(async () => {
  view = new InkbookView(leaf, plugin);
  root = view.contentEl as HTMLElement;
  host.appendChild(root);
  await view.onOpen();

  const book = makeBook(3);
  const file = mkFile("测试手写本.inkbook", JSON.stringify(book));
  await view.onLoadFile(file);
  await sleep(700);

  /* ============ 1. 竖长条结构 ============ */
  pass(!!view.editor, "编辑器已挂载");

  const rail = root.querySelector(".mb-rail") as HTMLElement;
  const paper = root.querySelector(".mb-paper") as HTMLElement;
  const scroll = root.querySelector(".mb-scroll") as HTMLElement;
  const sideEl = root.querySelector(".mb-side") as HTMLElement;
  const sideBtn = root.querySelector(".mb-rail-side") as HTMLElement;
  const readBtn = root.querySelector(".mb-rail-read") as HTMLElement;

  pass(!!rail, "存在工具长条 .mb-rail");
  pass(!!paper, "存在纸面列 .mb-paper");
  pass(!!sideBtn, "长条上有「侧栏」开关");
  pass(!!readBtn, "长条上有「仅阅读」按钮");

  // 旧的抽屉结构必须已经消失
  pass(!root.querySelector(".mb-dock-panel"), "旧抽屉面板已移除");
  pass(!root.querySelector(".mb-dock-tab"), "旧标签页已移除");
  pass(!root.querySelector(".mb-rail-more"), "旧「更多」按钮已移除");

  // 7 个工具
  const tools = root.querySelectorAll(".mb-rail-tool");
  pass(tools.length === 7, "长条上 7 个工具按钮（" + tools.length + "）");

  // 每个工具都有字（图标下面有名字，不靠猜）
  const labelled = Array.from(tools).every(
    (t) => !!t.querySelector(".mb-rail-lbl")?.textContent?.trim()
  );
  pass(labelled, "每个工具都有文字标签");

  // 工具在长条上是竖排的
  const toolTops = Array.from(tools).map(
    (t) => Math.round((t as HTMLElement).getBoundingClientRect().top)
  );
  pass(
    new Set(toolTops).size === toolTops.length,
    "工具在长条上是竖着排的（每个都有不同的 top）"
  );

  /* ============ 2. 长条不遮挡滚动条 ============ */
  /*
   * 用户反馈："边上的框会挡住滑动页面的那个条"。
   *
   * 旧实现里长条是浮在纸上的（absolute），正好压在滚动条上，
   * 想拖滚动条得先把长条挪开。
   * 现在长条是纸面列**右边的一整列**，滚动条在纸面列自己的右缘，
   * 两者永远不重叠。
   */
  const scrollRect = scroll.getBoundingClientRect();
  const railRect = rail.getBoundingClientRect();
  pass(
    railRect.left >= scrollRect.right - 1,
    "长条在滚动区右侧，不压滚动条（长条左沿 " +
      railRect.left.toFixed(0) +
      " ≥ 滚动区右沿 " +
      scrollRect.right.toFixed(0) +
      "）"
  );

  // 长条和纸面列是并排的两列
  const paperRect = paper.getBoundingClientRect();
  pass(
    Math.abs(railRect.left - paperRect.right) < 2,
    "长条紧贴纸面列右缘（是并排的两列，不是浮层）"
  );

  /*
   * 长条宽度要真的等于设计值。
   *
   * content-box 下 74px 会变成 74 + padding*2 + border = 87px，
   * 磁贴被挤到一边，长条比设计值宽一截——这里守住。
   */
  pass(
    railRect.width <= 78,
    "长条宽度符合设计值（实测 " + railRect.width.toFixed(0) + "px ≤ 78px）"
  );

  /* ============ 3. 图标真的看得见 ============ */
  /*
   * 用户反馈："每一个框里面也都还是看不到图标"。
   *
   * 根因：用的是 Obsidian 的 .svg-icon，主题能覆盖它的尺寸；
   * 而且 Obsidian 内置的 Lucide 版本可能没有我们用的图标名，
   * 查不到时它**什么都不画**，按钮就成了空框。
   *
   * 现在自绘图标（.mb-ic），路径固定、尺寸写死，主题碰不到。
   */
  const icons = Array.from(tools).map(
    (t) => t.querySelector(".mb-ic") as SVGElement | null
  );
  pass(
    icons.every((i) => !!i),
    "每个工具都有自绘图标（.mb-ic）"
  );

  // 尺寸真的被撑起来了（不是 0，也不是被主题压回 16px）
  const iconSizes = icons.map((i) => (i ? i.getBoundingClientRect().width : 0));
  pass(
    iconSizes.every((w) => w >= 24),
    "电脑端图标 ≥ 24px（实测 " + Math.min(...iconSizes).toFixed(1) + "px）"
  );

  // 图标真的有绘制内容（路径非空），不是空白方框
  const hasPath = icons.every(
    (i) =>
      !!i &&
      !!i.querySelector("path") &&
      (i.querySelector("path")!.getAttribute("d") || "").length > 5
  );
  pass(hasPath, "图标都带真实路径（不是空 svg）");

  // 图标没有被主题压成不可见
  const iconVisible = icons.every((i) => {
    if (!i) return false;
    const cs = getComputedStyle(i);
    return (
      cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.1
    );
  });
  pass(iconVisible, "图标可见（display/visibility/opacity 正常）");

  /* ============ 4. 右下角浮标 ============ */
  const float = root.querySelector(".mb-float") as HTMLElement;
  const zoomGrp = root.querySelector(".mb-float-zoom") as HTMLElement;
  const zoomLbl = root.querySelector(".mb-float-zoom .mb-float-num") as HTMLElement;
  const pageLbl = root.querySelector(".mb-float-nav .mb-float-num") as HTMLElement;

  pass(!!float, "存在右下角浮标 .mb-float");
  pass(!!zoomGrp, "浮标里有缩放组");
  pass(!!pageLbl, "浮标里有页码");

  // 浮标在右下角
  const floatRect = float.getBoundingClientRect();
  const paperRect2 = paper.getBoundingClientRect();
  pass(
    floatRect.right <= paperRect2.right + 2 &&
      floatRect.bottom <= paperRect2.bottom + 2,
    "浮标贴着纸面列右下角"
  );

  /*
   * 缩放组平时是收起的。
   *
   * 注意：编辑器首帧会 fit() 一次（整页适应），zoom 变了会浮现缩放组，
   * 所以这里要先等它自己淡出（2.6s），再断言"平时不显示"。
   */
  await sleep(3000);
  pass(
    !zoomGrp.classList.contains("is-show"),
    "缩放组平时不显示（只有缩放时才浮现）"
  );

  // 缩放一下 → 浮标浮现并报出确切倍数
  view.editor.zoomBy(1.15);
  await sleep(200);
  pass(
    zoomGrp.classList.contains("is-show"),
    "缩放后缩放组浮现"
  );
  const pct = zoomLbl.textContent || "";
  pass(/\d+%\s*$/.test(pct), "缩放组显示确切倍数：" + pct);

  // 缩放组在浮标里（不是侧栏里）
  pass(
    !!float.querySelector(".mb-float-zoom"),
    "缩放控件在浮标里（不在侧栏里）"
  );
  pass(
    !sideEl.querySelector(".mb-float-zoom"),
    "侧栏里已经没有缩放控件"
  );

  /* ============ 5. 侧栏收纳全部工具 ============ */
  /*
   * 用户要求："导出 PDF 这种工具，可以直接统一全部放在侧边栏里面"。
   */
  pass(
    sideEl.textContent!.includes("导出 PDF"),
    "侧栏里有「导出 PDF」"
  );
  pass(
    sideEl.textContent!.includes("导出本页 PNG"),
    "侧栏里有「导出本页 PNG」"
  );
  const ibs = sideEl.querySelectorAll(".mb-ib");
  pass(
    ibs.length >= 5,
    "侧栏顶部的图标按钮齐全（撤销/重做/删除/导入/导出，" + ibs.length + " 个）"
  );
  pass(!!sideEl.querySelector(".mb-side-close"), "侧栏有关闭按钮");

  // 侧栏开关能开能关
  const isSideOpen = () => !sideEl.classList.contains("is-hidden");
  const wasOpen = isSideOpen();
  (sideBtn as HTMLElement).click();
  await sleep(120);
  pass(isSideOpen() !== wasOpen, "点「侧栏」开关能切换侧栏显隐");
  if (!isSideOpen()) {
    (sideBtn as HTMLElement).click();
    await sleep(120);
  }
  pass(isSideOpen(), "侧栏重新打开");

  /* ============ 6. 仅阅读模式 ============ */
  const isReading = () => root.classList.contains("is-reading");
  (readBtn as HTMLElement).click();
  await sleep(200);
  pass(isReading(), "点「阅读」按钮进入仅阅读模式");
  pass(
    (readBtn as HTMLElement).getAttribute("aria-pressed") === "true",
    "aria-pressed 同步为 true"
  );

  // 真的不能落笔
  const before = strokeCountAll();
  drawAt(200, 300);
  await sleep(150);
  pass(
    strokeCountAll() === before,
    "仅阅读模式下鼠标落笔不产生笔迹（" + before + " → " + strokeCountAll() + "）"
  );

  drawAt(220, 340, "pen");
  await sleep(150);
  pass(strokeCountAll() === before, "仅阅读模式下触控笔落笔不产生笔迹");

  // 撤销 / 重做 / 删除全部失效
  view.editor.undo();
  view.editor.redo();
  view.editor.deleteSelection();
  await sleep(100);
  pass(strokeCountAll() === before, "仅阅读模式下撤销/重做/删除不改动内容");

  // 但翻页和缩放仍然可用
  const pageBefore = view.editor.getState().pageIndex;
  view.editor.goToPage(1, false);
  await sleep(400);
  pass(
    view.editor.getState().pageIndex === 1,
    "仅阅读模式下仍可翻页（" + pageBefore + " → " + view.editor.getState().pageIndex + "）"
  );
  const zoomBefore = view.editor.getState().zoom;
  view.editor.zoomBy(1.2);
  await sleep(150);
  pass(view.editor.getState().zoom > zoomBefore, "仅阅读模式下仍可缩放");

  // 退出仅阅读
  (readBtn as HTMLElement).click();
  await sleep(200);
  pass(!isReading(), "再点一次退出仅阅读模式");
  const beforeEdit = strokeCountAll();
  drawAt(200, 300);
  await sleep(200);
  pass(
    strokeCountAll() > beforeEdit,
    "退出后能正常落笔（" + beforeEdit + " → " + strokeCountAll() + "）"
  );

  /* ============ 7. 浮标翻页可用 ============ */
  const cur = view.editor.getState().pageIndex;
  const nextBtn = float.querySelector(
    ".mb-float-nav .mb-float-btn:last-of-type"
  ) as HTMLElement;
  nextBtn.click();
  await sleep(250);
  pass(
    view.editor.getState().pageIndex > cur,
    "浮标上的「下一页」能翻页"
  );

  /* ============ 8. Esc 快捷键 ============ */
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );
  await sleep(150);
  pass(!isSideOpen(), "Esc 收起侧栏");

  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );
  await sleep(150);
  pass(isReading(), "再按 Esc 切到仅阅读模式");

  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );
  await sleep(150);
  pass(!isReading(), "再按 Esc 退出仅阅读模式");

  /* ============ 9. 平板形态 ============ */
  root.classList.add("is-tablet");
  await sleep(250);

  const tIcon = tools[0].querySelector(".mb-ic") as SVGElement;
  const tIconRect = tIcon.getBoundingClientRect();
  pass(
    tIconRect.width >= 28,
    "平板端图标 ≥ 28px（实测 " + tIconRect.width.toFixed(1) + "px）"
  );
  const tRect = (tools[0] as HTMLElement).getBoundingClientRect();
  pass(
    tRect.height >= 48,
    "平板端工具按钮 ≥ 48px（实测 " + tRect.height.toFixed(0) + "px）"
  );

  // 平板上工具仍然是竖排（不换行）
  const tTops = Array.from(tools).map(
    (t) => Math.round((t as HTMLElement).getBoundingClientRect().top)
  );
  pass(
    new Set(tTops).size === tTops.length,
    "平板端工具依然是竖排（没有挤成两行）"
  );

  // 平板上长条仍然不挡滚动条
  const tScrollRect = (
    root.querySelector(".mb-scroll") as HTMLElement
  ).getBoundingClientRect();
  const tRailRect = (
    root.querySelector(".mb-rail") as HTMLElement
  ).getBoundingClientRect();
  pass(
    tRailRect.left >= tScrollRect.right - 1,
    "平板端长条也不挡滚动条"
  );

  root.classList.remove("is-tablet");
  await sleep(200);

  log("");
  const fails = lines.filter((l) => l.startsWith("FAIL")).length;
  log(fails === 0 ? "ALL PASS" : fails + " FAILED");
})();
