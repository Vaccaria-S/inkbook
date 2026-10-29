/**
 * 工具长条 + 右下角浮标 + 侧栏 回归测试。
 *
 * 覆盖六条主线：
 *   1. 顶栏工具行：6 个工具 + 立即保存 + 侧栏开关 + 阅读开关
 *   2. 长条**不遮挡滚动条**（用户反馈"边上的框会挡住滑动页面的那个条"）
 *   3. 右下角浮标：翻页常驻、缩放**只在缩放时**浮现并显示确切倍数
 *   4. 侧栏收纳全部工具：导出 / 导入 / 撤销 / 输入方式都在里面
 *   5. 图标**真的看得见**（用户反馈"每一个框里面都看不到图标"）
 *   6. 立即保存：点一下就落盘，干净时不重复写，存不下去时必须说清楚
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

/**
 * Notice 在 obsidian-stub 里只打一行 console.log，页面上看不见。
 * 截下来当"提示真的弹了"的可观测信号——否则只能断言"没写盘"，
 * 分不清是给了提示还是静默什么都没做。
 */
const noticeTexts: string[] = [];
const rawConsoleLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  const s = args.map((a) => String(a)).join(" ");
  if (s.startsWith("[Notice]")) noticeTexts.push(s);
  rawConsoleLog(...args);
};

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

/**
 * 正文写盘次数（不含 .bak 备份）。
 *
 * 「立即保存」的代价必须能量出来：点一次 = 写一次磁盘，
 * 干净状态下点一次 = 一次都不能多写。
 */
let bodyWrites = 0;

const adapter = {
  exists: async (p: string) => files.has(p),
  read: async (p: string) => files.get(p),
  write: async (p: string, d: string) => {
    if (!p.endsWith(".bak")) bodyWrites += 1;
    files.set(p, d);
  },
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

  /* ============ 1. 顶栏工具行 ============ */
  pass(!!view.editor, "编辑器已挂载");

  const paper = root.querySelector(".mb-paper") as HTMLElement;
  const scroll = root.querySelector(".mb-scroll") as HTMLElement;
  const sideEl = root.querySelector(".mb-side") as HTMLElement;
  const headerEl = view.containerEl as HTMLElement;
  const topRow = headerEl.querySelector(".mb-toprow") as HTMLElement;
  const sideBtn = headerEl.querySelector(".mb-rail-side") as HTMLElement;
  const readBtn = headerEl.querySelector(".mb-rail-read") as HTMLElement;

  pass(!!topRow, "标题栏里有 .mb-toprow 一行");
  pass(!!paper, "存在纸面列 .mb-paper");
  pass(!!sideBtn, "顶栏上有「侧栏」开关");
  pass(!!readBtn, "顶栏上有「仅阅读」按钮");

  // 工具搬上顶栏后，纸上那块可拖动浮层必须彻底消失
  pass(!root.querySelector(".mb-rail"), "纸上不再有浮层工具盘 .mb-rail");

  // 旧的抽屉结构必须已经消失
  pass(!root.querySelector(".mb-dock-panel"), "旧抽屉面板已移除");
  pass(!root.querySelector(".mb-dock-tab"), "旧标签页已移除");
  pass(!root.querySelector(".mb-rail-more"), "旧「更多」按钮已移除");

  // 6 个工具 + 3 个动作 = 9 个按钮，挤在同一行
  const tools = topRow.querySelectorAll(".mb-top-tool");
  pass(tools.length === 6, "顶栏上 6 个工具按钮（" + tools.length + "）");

  const rowBtns = Array.from(
    topRow.querySelectorAll(".mb-topbtn")
  ) as HTMLElement[];
  pass(rowBtns.length === 9, "一行里 9 个按钮（6 笔 + 3 动作）：" + rowBtns.length);

  /*
   * 用户要求："把钢笔、橡皮啊，侧边的这些东西都挪到最上面去"，
   * 而且要先看看"到底能不能放得下"。放不下的表现就是换行——
   * 所以直接量顶边：同一行的话差不超过 2px，换行会差一整行。
   */
  const tops = rowBtns.map((b) => Math.round(b.getBoundingClientRect().top));
  const rowSpread = Math.max(...tops) - Math.min(...tops);
  pass(rowSpread <= 2, "9 个按钮在同一水平线上（顶边最大差 " + rowSpread + "px）");

  // 顺序：笔在左，视图动作在右
  const lastToolRight = (
    tools[tools.length - 1] as HTMLElement
  ).getBoundingClientRect().right;
  const firstActionLeft = (
    headerEl.querySelector(".mb-rail-save") as HTMLElement
  ).getBoundingClientRect().left;
  pass(lastToolRight <= firstActionLeft, "笔在左、保存/侧栏/阅读在右");

  // 顶栏塞不下文字，全名必须进 title（悬停 / 长按能看到）
  pass(
    Array.from(tools).every((t) => (t.getAttribute("title") || "").length > 0),
    "每个工具都有 title 全名（顶栏只放图标）"
  );

  /* ============ 2. 工具搬走后纸面通栏 ============ */
  /*
   * 长条原来在纸面右边占一整列（平板 86px）。
   * 现在工具上顶栏，那一列整块还给纸——这才是用户要的"塞到最上面去"。
   */
  const editorRect = (
    root.querySelector(".mb-editor") as HTMLElement
  ).getBoundingClientRect();
  const scrollRect = scroll.getBoundingClientRect();
  pass(
    editorRect.width - scrollRect.width <= 2,
    "纸面通栏（编辑区 " +
      editorRect.width.toFixed(0) +
      " − 纸宽 " +
      scrollRect.width.toFixed(0) +
      " ≤ 2px）"
  );

  /* ============ 2.5 侧边拖动滑条 ============ */
  /*
   * 系统滚动条在平板上拖不动（只能甩），几十页的本子想跳页只能一页页滑。
   * 这条自己画的滑条必须：常显、贴右缘、拖得动、松手退出拖动态。
   */
  const sb = root.querySelector(".mb-sb") as HTMLElement;
  const thumb = sb?.querySelector(".mb-sb-thumb") as HTMLElement;
  const track = sb?.querySelector(".mb-sb-track") as HTMLElement;
  pass(!!sb, "纸面右缘有拖动滑条 .mb-sb");
  pass(!!thumb, "滑条上有滑块 .mb-sb-thumb");

  const sbRect = sb.getBoundingClientRect();
  pass(
    !sb.classList.contains("is-idle") && sbRect.width >= 10,
    "多页时滑条常显（宽 " + sbRect.width.toFixed(0) + "px）"
  );
  pass(
    Math.abs(sbRect.right - scrollRect.right) <= 16,
    "滑条贴着滚动区右缘（差 " +
      (scrollRect.right - sbRect.right).toFixed(0) +
      "px）"
  );

  const peSb = (type: string, y: number) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 9,
      pointerType: "touch",
      clientX: Math.round(track.getBoundingClientRect().left + 3),
      clientY: Math.round(y),
    });
  const tr = track.getBoundingClientRect();
  const beforeTop = scroll.scrollTop;
  sb.dispatchEvent(peSb("pointerdown", tr.top + 8));
  sb.dispatchEvent(peSb("pointermove", tr.bottom - 8));
  await sleep(150);
  const afterTop = scroll.scrollTop;
  sb.dispatchEvent(peSb("pointerup", tr.bottom - 8));
  await sleep(120);
  pass(
    afterTop > beforeTop + 50,
    "拖滑条能一路滚下去（" + beforeTop.toFixed(0) + " → " + afterTop.toFixed(0) + "）"
  );
  pass(!sb.classList.contains("is-drag"), "松手后退出拖动态");
  scroll.scrollTop = 0;
  await sleep(120);

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
    iconSizes.every((w) => w >= 17),
    "电脑端图标 ≥ 17px（实测 " + Math.min(...iconSizes).toFixed(1) + "px）"
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
    "侧栏顶部的图标按钮齐全（刷新/撤销/重做/导入/导出，" + ibs.length + " 个）"
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

  // 撤销 / 重做全部失效
  view.editor.undo();
  view.editor.redo();
  await sleep(100);
  pass(strokeCountAll() === before, "仅阅读模式下撤销/重做不改动内容");

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
  headerEl.classList.add("mb-tablet");
  await sleep(250);

  const tIcon = tools[0].querySelector(".mb-ic") as SVGElement;
  const tIconRect = tIcon.getBoundingClientRect();
  pass(
    tIconRect.width >= 20,
    "平板端图标 ≥ 20px（实测 " + tIconRect.width.toFixed(1) + "px）"
  );
  const tRect = (tools[0] as HTMLElement).getBoundingClientRect();
  pass(
    tRect.height >= 32,
    "平板端按钮 ≥ 32px（实测 " + tRect.height.toFixed(0) + "px）"
  );

  /*
   * 用户反馈："平板上这 3 个图标间距有点近"。
   * 平板一律把间距拉到 7px，这一条专门盯着它。
   */
  const t0 = (tools[0] as HTMLElement).getBoundingClientRect();
  const t1 = (tools[1] as HTMLElement).getBoundingClientRect();
  pass(
    t1.left - t0.right >= 5,
    "平板端按钮间距 ≥ 5px（实测 " + (t1.left - t0.right).toFixed(1) + "px）"
  );

  // 平板上也得挤在一行里（放不下就会换行）
  const tTops = Array.from(tools).map(
    (t) => Math.round((t as HTMLElement).getBoundingClientRect().top)
  );
  pass(new Set(tTops).size === 1, "平板端 6 个工具仍是一行（没有换行）");

  root.classList.remove("is-tablet");
  headerEl.classList.remove("mb-tablet");
  await sleep(200);

  /* ============ 10. 长条「立即保存」 ============ */
  /*
   * 用户场景（平板）：落几笔 → 点一下 → 立刻落盘。
   * 自动保存有 850ms 防抖，等不了那一下。
   */
  const saveBtn = headerEl.querySelector(".mb-rail-save") as HTMLButtonElement | null;
  pass(
    !!saveBtn && !!saveBtn.querySelector("svg.mb-ic path"),
    "长条上有「立即保存」按钮，且图标真的画出来了（不是空框）"
  );

  /*
   * 关掉自动保存：这样"有没有写盘"完全由这次点击决定，
   * 不会被 850ms 防抖在断言之前偷偷存掉（那会让第 3、4 条全部失真）。
   */
  plugin.settings.autosave = false;
  await view.flushSave();
  await sleep(150);

  const statusEl = root.querySelector(".mb-side-status") as HTMLElement;

  drawAt(240, 320);
  await sleep(200);
  pass(
    statusEl.textContent!.includes("未保存") && saveBtn!.classList.contains("is-dirty"),
    "落一笔后状态是「" +
      statusEl.textContent +
      "」且按钮亮起未保存点（is-dirty=" +
      saveBtn!.classList.contains("is-dirty") +
      "）"
  );

  // 点一下 → 必须真的落盘，且只写一次正文
  const beforeClick = bodyWrites;
  saveBtn!.click();
  await sleep(400);
  pass(
    bodyWrites === beforeClick + 1 &&
      statusEl.textContent!.includes("已保存") &&
      !saveBtn!.classList.contains("is-dirty"),
    "点「立即保存」→ 写盘 " +
      beforeClick +
      " → " +
      bodyWrites +
      "（+" +
      (bodyWrites - beforeClick) +
      " 次），状态变「" +
      statusEl.textContent +
      "」，未保存点消失"
  );

  // 干净状态下再点一次 → 一次都不能多写
  const beforeIdle = bodyWrites;
  saveBtn!.click();
  await sleep(400);
  pass(
    bodyWrites === beforeIdle,
    "干净状态下再点一次不重复写盘（写盘次数停在 " + bodyWrites + "）"
  );

  /*
   * 仅阅读模式下点：没有新内容可存 → 不写盘，但要明确告知，
   * 不能"点了没反应"。
   */
  (readBtn as HTMLElement).click();
  await sleep(200);
  const beforeReading = bodyWrites;
  const noticesBeforeReading = noticeTexts.length;
  saveBtn!.click();
  await sleep(300);
  const readingNotice = noticeTexts.slice(noticesBeforeReading).join(" | ");
  pass(
    bodyWrites === beforeReading && readingNotice.includes("无需保存"),
    "仅阅读模式下点「立即保存」不写盘（" +
      beforeReading +
      " → " +
      bodyWrites +
      "），提示：" +
      (readingNotice || "（没有提示！）")
  );

  /*
   * 只读态（从备份恢复 / 原文件打不开）：这份笔记**存不下去**。
   * 点按钮必须说清楚，不能静默返回——否则用户会以为写进去了。
   */
  view.readOnly = true;
  view.dirty = true;
  view.saveState = "dirty";
  view.updateStatus();
  const beforeReadOnly = bodyWrites;
  const noticesBeforeReadOnly = noticeTexts.length;
  saveBtn!.click();
  await sleep(300);
  const roNotice = noticeTexts.slice(noticesBeforeReadOnly).join(" | ");
  pass(
    bodyWrites === beforeReadOnly && roNotice.includes("只读"),
    "只读态下点「立即保存」不写盘（" +
      beforeReadOnly +
      " → " +
      bodyWrites +
      "），提示：" +
      (roNotice || "（没有提示！）")
  );

  view.readOnly = false;
  view.dirty = false;
  view.saveState = "saved";
  view.updateStatus();
  (readBtn as HTMLElement).click(); // 退出仅阅读
  await sleep(200);

  /* ============ 11. 标题栏放不下 → 整行搬进自建顶栏条 ============ */
  /*
   * 真机（平板）：宿主的 action 容器窄，十个按钮被 flex 压成一团，
   * 看着就像"整排只剩一个按钮"。这里把容器压到 150px 复现，
   * 断言整行会整体搬进 .mb-topbar 且宽度不变形。
   */
  const rowInHeader = headerEl.querySelector(".mb-toprow") as HTMLElement;
  pass(!!rowInHeader, "默认整行挂在标题栏里");

  /*
   * 祖先裁剪判定（真机上"右边三个还在、左边七个笔没了"就是被父容器切掉）。
   * 直接构造一个 overflow:hidden 的窄盒子来验，不依赖宿主布局。
   */
  {
    const wrap = document.createElement("div");
    wrap.style.cssText = "overflow:hidden;width:100px;height:40px";
    const inner = document.createElement("div");
    inner.style.cssText = "width:400px;height:20px";
    wrap.appendChild(inner);
    document.body.appendChild(wrap);
    const innerRect = inner.getBoundingClientRect();
    pass(
      (view as any).isClippedByAncestor(inner, innerRect) === true,
      "父容器 overflow:hidden 把右半切掉时能判出来"
    );
    wrap.style.overflow = "visible";
    pass(
      (view as any).isClippedByAncestor(inner, innerRect) === false,
      "overflow:visible 时不误报"
    );
    wrap.remove();
  }
  const rowW0 = rowInHeader.getBoundingClientRect().width;
  {
    headerEl.style.width = "150px";
    headerEl.style.overflow = "hidden";
    window.dispatchEvent(new Event("resize"));
    await sleep(200);

    const bar = root.querySelector(".mb-topbar") as HTMLElement;
    pass(!!bar, "标题栏窄到放不下时，整行搬进自建顶栏条 .mb-topbar");
    const btns = bar ? bar.querySelectorAll(".mb-topbtn").length : 0;
    pass(btns === 9, "搬下来后 9 个按钮都在（没被压扁）：" + btns);
    const rowNow = bar ? (bar.querySelector(".mb-toprow") as HTMLElement) : null;
    const rowW1 = rowNow ? rowNow.getBoundingClientRect().width : 0;
    pass(
      rowW1 >= rowW0 - 1,
      "搬下来后整行宽度不变（" +
        rowW0.toFixed(0) +
        " → " +
        rowW1.toFixed(0) +
        "px）"
    );

    headerEl.style.width = "";
    headerEl.style.overflow = "";
    window.dispatchEvent(new Event("resize"));
    await sleep(200);
    pass(
      !!headerEl.querySelector(".mb-toprow") && !root.querySelector(".mb-topbar"),
      "窗口变宽后自动搬回标题栏"
    );
  }

  log("");
  const fails = lines.filter((l) => l.startsWith("FAIL")).length;
  log(fails === 0 ? "ALL PASS" : fails + " FAILED");
})();
