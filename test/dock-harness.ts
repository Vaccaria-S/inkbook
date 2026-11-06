/**
 * 工具长条 + 右下角浮标 + 侧栏 回归测试。
 *
 * 覆盖六条主线：
 *   1. 顶栏工具行：8 个工具 + 立即保存 + 侧栏开关 + 阅读开关
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
/**
 * 真计时轮询：等某个 DOM 状态出现 / 消失。
 *
 * 滑条淡出是 setTimeout(1300) + CSS opacity 过渡驱动的，必须用真时间等；
 * 用假时钟会让「停手后自己淡出」永远等不到。
 */
async function waitUntil(
  pred: () => boolean,
  timeout = 3000,
  step = 40
): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) {
    if (pred()) return true;
    await sleep(step);
  }
  return pred();
}
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

  // 8 个工具 + 3 个动作 = 11 个按钮，挤在同一行
  const tools = topRow.querySelectorAll(".mb-top-tool");
  pass(tools.length === 8, "顶栏上 8 个工具按钮（" + tools.length + "）");

  const rowBtns = Array.from(
    topRow.querySelectorAll(".mb-topbtn")
  ) as HTMLElement[];
  pass(rowBtns.length === 11, "一行里 11 个按钮（8 工具 + 3 动作）：" + rowBtns.length);

  /*
   * 用户要求："把钢笔、橡皮啊，侧边的这些东西都挪到最上面去"，
   * 而且要先看看"到底能不能放得下"。放不下的表现就是换行——
   * 所以直接量顶边：同一行的话差不超过 2px，换行会差一整行。
   */
  const tops = rowBtns.map((b) => Math.round(b.getBoundingClientRect().top));
  const rowSpread = Math.max(...tops) - Math.min(...tops);
  pass(rowSpread <= 2, "11 个按钮在同一水平线上（顶边最大差 " + rowSpread + "px）");

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

  /* ============ 2.5 右缘小滑块：只有滑块可拖 / 滚动才显现 ============ */
  /*
   * 用户要的是「享做笔记」那种：右缘只有一枚小滑块，没有长轨道。
   *   · 平时藏起来，滚动页面才浮现，停手约 1.3s 自己淡出
   *   · 只有 thumb 收 pointer；容器和轨道 pointer-events:none 穿透
   *   · 点轨道空白 / 右缘非滑块处**不能**跳页——以前掌根一压就飞
   *   · 拖动期间保持可见；内容不足一屏彻底隐藏（is-idle）
   *
   * 注意：thumb 默认 pointer-events:none，只有 is-visible 时才 auto；
   * 所以凡是测拖动，都先触发一次 scroll 让滑块可见（模拟真实用户）。
   */
  const sb = root.querySelector(".mb-sb") as HTMLElement;
  const thumb = sb?.querySelector(".mb-sb-thumb") as HTMLElement;
  const track = sb?.querySelector(".mb-sb-track") as HTMLElement;
  pass(!!sb, "纸面右缘有拖动滑条 .mb-sb");
  pass(!!thumb, "滑条上有滑块 .mb-sb-thumb");
  pass(!!track, "滑块有定位容器 .mb-sb-track");

  const sbRect = sb.getBoundingClientRect();
  pass(
    !sb.classList.contains("is-idle") &&
      sbRect.width >= 10 &&
      sbRect.width <= 24,
    "多页时不 is-idle，且只是窄窄一枚滑块（宽 " +
      sbRect.width.toFixed(0) +
      "px）"
  );
  pass(
    Math.abs(sbRect.right - scrollRect.right) <= 16,
    "滑条贴着滚动区右缘（差 " +
      (scrollRect.right - sbRect.right).toFixed(0) +
      "px）"
  );

  // 长轨道不再可见：track 只当定位容器，背景 / 边框 / 阴影都不能画出来
  const trackCs = getComputedStyle(track);
  const transparentBg =
    trackCs.backgroundColor === "rgba(0, 0, 0, 0)" ||
    trackCs.backgroundColor === "transparent";
  pass(
    transparentBg &&
      trackCs.backgroundImage === "none" &&
      (trackCs.boxShadow === "none" || trackCs.boxShadow === ""),
    "轨道没有可见背景线（bg=" +
      trackCs.backgroundColor +
      " image=" +
      trackCs.backgroundImage +
      "）"
  );

  // 容器与轨道永远穿透；否则笔尖落在纸面右缘会被拦下
  pass(
    getComputedStyle(sb).pointerEvents === "none" &&
      trackCs.pointerEvents === "none",
    "容器与轨道不吃指针事件（pointer-events:none）"
  );

  // 滑块本身要够大：电脑下限 28px
  const thumbH0 = parseFloat(thumb.style.height || "0");
  pass(thumbH0 >= 28, "滑块高度下限 28px（实测 " + thumbH0.toFixed(0) + "px）");

  /*
   * 打开本子 / resize / updateUI 只是「布局同步」（woke=false），
   * 不能把滑块闪出来——用户要的是没滚动时看不见。
   * 这里在触发任何 scroll 之前断言，正好卡住「一打开就闪」的回归。
   */
  pass(
    !sb.classList.contains("is-visible"),
    "有内容但没滚动时滑块不带 is-visible（打开不闪）"
  );
  pass(
    getComputedStyle(sb).opacity === "0" &&
      getComputedStyle(thumb).pointerEvents === "none",
    "隐藏态 opacity 0 且滑块不吃事件（opacity=" +
      getComputedStyle(sb).opacity +
      "）"
  );

  // 触发一次真滚动 → 立刻浮现
  scroll.scrollTop = 320;
  scroll.dispatchEvent(new Event("scroll"));
  await sleep(350); // rAF 合并 + 0.22s opacity 过渡
  pass(
    sb.classList.contains("is-visible"),
    "触发 scroll 后滑块浮现（is-visible）"
  );
  pass(
    getComputedStyle(sb).opacity === "1" &&
      getComputedStyle(thumb).pointerEvents === "auto" &&
      getComputedStyle(sb).pointerEvents === "none" &&
      getComputedStyle(track).pointerEvents === "none",
    "浮现后只有 thumb 可点（thumb auto，容器/轨道仍 none）"
  );

  /*
   * 触摸兜底只该挂在 thumb 上。
   * 以前整条右缘都吞 touchstart，宿主会以为用户在下拉，弹出命令面板；
   * 现在纸面右缘的触摸必须原样穿透，只有按在滑块上才吃。
   */
  const touchPrevented = (target: HTMLElement) => {
    const ev = new TouchEvent("touchstart", {
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  pass(
    !touchPrevented(track),
    "轨道不吞触摸（touchstart defaultPrevented=false）"
  );
  pass(
    touchPrevented(thumb),
    "只有 thumb 吞触摸（防宿主下拉命令面板）"
  );

  // 停手约 1.5s（真计时）→ 自动淡出
  const faded = await waitUntil(
    () => !sb.classList.contains("is-visible"),
    3000
  );
  await sleep(300); // 等 opacity 过渡走完
  pass(faded, "停手约 1.5s 后滑块自己淡出（无 is-visible）");
  pass(getComputedStyle(sb).opacity === "0", "淡出后 opacity 回到 0");

  /*
   * 平板手指粗：thumb 按比例算出来很小时，下限必须从 28px 抬到 34px。
   *
   * 只有三页时按比例算出的滑块已经远高于 34px，看不出差别；
   * 临时把页高撑到 15000px，让「可视比例」小到 13px 左右，
   * 再分别用桌面 / 平板模式同步，才能量到真正的下限分支。
   */
  const sbDocEl = root.querySelector(".mb-doc") as HTMLElement;
  const savedPageH = sbDocEl.style.getPropertyValue("--mb-page-h");
  sbDocEl.style.setProperty("--mb-page-h", "15000px");
  (view as any).tabletMode = true;
  scroll.dispatchEvent(new Event("scroll"));
  await sleep(250);
  const thumbTablet = parseFloat(thumb.style.height || "0");
  (view as any).tabletMode = false;
  scroll.dispatchEvent(new Event("scroll"));
  await sleep(250);
  const thumbDesktopMin = parseFloat(thumb.style.height || "0");
  sbDocEl.style.setProperty("--mb-page-h", savedPageH);
  scroll.dispatchEvent(new Event("scroll"));
  await sleep(250);
  pass(
    thumbTablet >= 34 && thumbTablet > thumbDesktopMin,
    "平板模式滑块下限 34px（桌面 " +
      thumbDesktopMin.toFixed(0) +
      " → 平板 " +
      thumbTablet.toFixed(0) +
      "px）"
  );

  /* ---------------- 只有 thumb 能拖；轨道空白不响应 ---------------- */
  // 先把滑块滚到顶再唤醒，thumb 就停在轨道顶部，下面一大片是「空白」
  scroll.scrollTop = 0;
  scroll.dispatchEvent(new Event("scroll"));
  await sleep(350);

  const peSb = (target: HTMLElement, type: string, y: number, pid: number) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: pid,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: Math.round(
          track.getBoundingClientRect().left + track.clientWidth / 2
        ),
        clientY: Math.round(y),
      })
    );

  // 盯住 setPointerCapture：轨道空白处绝不能抢指针
  let captureCalls = 0;
  const origSetCapture = thumb.setPointerCapture.bind(thumb);
  (thumb as any).setPointerCapture = (id: number) => {
    captureCalls += 1;
    return origSetCapture(id);
  };

  const trackRect = track.getBoundingClientRect();
  const thumbRect = thumb.getBoundingClientRect();
  const blankY = Math.round(trackRect.bottom - 10);
  const blankOutsideThumb =
    blankY < thumbRect.top - 6 || blankY > thumbRect.bottom + 6;

  const beforeBlank = scroll.scrollTop;
  // ① 轨道空白处 ② .mb-sb 右缘但非滑块处，两套完整 pointer 序列
  peSb(track, "pointerdown", blankY, 21);
  peSb(track, "pointermove", trackRect.top + 10, 21);
  peSb(sb, "pointerdown", blankY, 22);
  peSb(sb, "pointermove", trackRect.top + 10, 22);
  await sleep(180);
  const afterBlank = scroll.scrollTop;
  peSb(track, "pointerup", blankY, 21);
  peSb(sb, "pointerup", blankY, 22);
  await sleep(120);
  pass(
    blankOutsideThumb && afterBlank === beforeBlank,
    "点轨道空白 / 右缘非滑块处不跳页（" +
      beforeBlank.toFixed(0) +
      " → " +
      afterBlank.toFixed(0) +
      "）"
  );
  pass(
    !sb.classList.contains("is-drag") && captureCalls === 0,
    "轨道空白不进入拖动态、不抢指针（capture=" + captureCalls + "）"
  );

  // 拖 thumb：派发到 thumb 本身（clientX 取 thumb 中心）
  const beforeTop = scroll.scrollTop;
  const thumbCenterX = Math.round(
    thumb.getBoundingClientRect().left + thumb.getBoundingClientRect().width / 2
  );
  const peThumb = (type: string, y: number) =>
    thumb.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 23,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: thumbCenterX,
        clientY: Math.round(y),
      })
    );

  peThumb("pointerdown", thumb.getBoundingClientRect().top + 8);
  await sleep(250); // 等 tip 的 0.14s 过渡
  pass(
    sb.classList.contains("is-drag") && sb.classList.contains("is-visible"),
    "按下滑块立即进入拖动态并保持可见"
  );
  const tipCs = getComputedStyle(sb.querySelector(".mb-sb-tip") as HTMLElement);
  pass(tipCs.opacity === "1", "拖动时页码提示可见（tip opacity=1）");

  // 拖住不放 1.5s：远超 1.3s 的淡出时限，滑块必须还在
  await sleep(1300);
  pass(
    sb.classList.contains("is-visible") && sb.classList.contains("is-drag"),
    "拖动 1.5s 期间滑块不消失（不被淡出计时器收走）"
  );

  peThumb("pointermove", trackRect.bottom - 10);
  await sleep(200);
  const afterTop = scroll.scrollTop;
  pass(
    afterTop > beforeTop + 50,
    "拖 thumb 按比例滚动（" +
      beforeTop.toFixed(0) +
      " → " +
      afterTop.toFixed(0) +
      "）"
  );
  pass(
    captureCalls === 1,
    "只有 thumb 抢指针（setPointerCapture 调了 " + captureCalls + " 次）"
  );

  peThumb("pointerup", trackRect.bottom - 10);
  await sleep(80);
  pass(!sb.classList.contains("is-drag"), "松手后退出拖动态");
  pass(sb.classList.contains("is-visible"), "刚松手滑块仍可见");
  await sleep(400);
  pass(
    sb.classList.contains("is-visible"),
    "松手 0.4s 内不立刻消失（留出看清位置的时间）"
  );
  const dragFaded = await waitUntil(
    () => !sb.classList.contains("is-visible"),
    2500
  );
  pass(dragFaded, "松手约 0.9s 后滑块淡出");

  /* ---------------- 内容不足一屏：彻底隐藏（is-idle） ---------------- */
  /*
   * 把每一页临时缩矮，让 scrollHeight 不再超出一屏，再触发 sync。
   * 真实行为对应「打开一本只有一页、且整页放得下的本子」。
   *
   * 这里改每页的 inline height，而不是 .mb-doc 上的 --mb-page-h：
   * 编辑器的 ResizeObserver 会调 applyLayout 重写 CSS 变量，
   * inline height 不受它影响，测量才稳定。
   */
  const idlePages = Array.from(
    root.querySelectorAll(".mb-page")
  ) as HTMLElement[];
  const savedPageHeights = idlePages.map((p) => p.style.height);
  for (const p of idlePages) p.style.height = "120px";
  scroll.scrollTop = 0;
  scroll.dispatchEvent(new Event("scroll"));
  await sleep(250);
  const idleRange = scroll.scrollHeight - scroll.clientHeight;
  pass(
    idleRange <= 2,
    "缩到不足一屏（range " + idleRange.toFixed(0) + "px）"
  );
  pass(
    sb.classList.contains("is-idle") && !sb.classList.contains("is-visible"),
    "内容不足一屏时滑条彻底隐藏（is-idle，无 is-visible）"
  );
  await sleep(300);
  pass(
    getComputedStyle(sb).opacity === "0" &&
      getComputedStyle(sb).pointerEvents === "none",
    "is-idle 时 opacity 0 且不吃事件"
  );

  // 恢复页面尺寸，别把后面的断言带歪
  idlePages.forEach((p, i) => (p.style.height = savedPageHeights[i]));
  scroll.dispatchEvent(new Event("scroll"));
  await sleep(250);
  pass(!sb.classList.contains("is-idle"), "恢复多页后退出 is-idle");
  scroll.scrollTop = 0;
  await sleep(120);

  /* ============ 2.6 侧栏页列表窗口化（大本子不一次建满） ============ */
  /*
   * 用户那本 857 页：旧实现给每页建 canvas + 3 个子节点，侧栏展开时一次
   * 建 857 个条目（实测 46ms，占打开时间一半）。现在只建「可视行 ± overscan」，
   * 滚动时再按行补建 / 回收。这里用 400 页验证四件事：
   *   1. 一开始只建可视区那一小批（远小于 400）；
   *   2. 滚下去条目变多、能见到最后一页；
   *   3. 滚回顶部，后面的条目被回收（不是只增不减）；
   *   4. 上下 spacer 撑住总高度（否则根本滚不到最后一页）。
   */
  {
    const sideBody = sideEl.querySelector(".mb-side-body") as HTMLElement;
    const listEl = sideEl.querySelector(".mb-pages") as HTMLElement;
    const origPages = view.store!.data.pages;
    const N = 400;
    const big = origPages.slice();
    for (let i = big.length; i < N; i++) big.push(createPage("blank", "white"));
    const thumbCount = () =>
      listEl.querySelectorAll(".mb-thumb:not(.mb-thumb-add)").length;

    sideBody.scrollTop = 0;
    view.store!.data.pages = big;
    (view as any).pageCountSig = -1;
    (view as any).renderPageList();
    await sleep(120);

    const first = thumbCount();
    pass(
      first > 0 && first < 80,
      "400 页侧栏初始只建可视区条目（" + first + " 个，远小于 400）"
    );
    pass(
      !listEl.querySelector('.mb-thumb[data-page="399"]'),
      "初始窗口里没有第 400 页（没有一次性建满）"
    );

    // 滚到页列表底部：可视区换了，窗口应该按需补建到最后一页
    sideBody.scrollTop = sideBody.scrollHeight;
    sideBody.dispatchEvent(new Event("scroll"));
    await sleep(300);
    const bottom = thumbCount();
    pass(bottom > first, "滚动后按需补建条目（" + first + " → " + bottom + "）");
    pass(
      !!listEl.querySelector('.mb-thumb[data-page="399"]'),
      "滚到底能看到最后一页条目（data-page=399）"
    );
    pass(!!listEl.querySelector(".mb-thumb-add"), "滚到底时「加一页」条目也在");

    // 总高度守恒：窗口化不能把列表缩短（否则滚动条变短、最后一页到不了）
    const cs = getComputedStyle(listEl);
    const cols = Math.max(1, cs.gridTemplateColumns.split(/\s+/).filter((s) => s.endsWith("px")).length || 4);
    let gap = parseFloat(cs.rowGap);
    if (!Number.isFinite(gap)) gap = 7;
    const rowThumb = listEl.querySelector(".mb-thumb:not(.mb-thumb-add)") as HTMLElement | null;
    const rowH = rowThumb ? rowThumb.getBoundingClientRect().height + gap : 0;
    const expectH = rowH > 0 ? Math.ceil((N + 1) / cols) * rowH - gap : 0;
    const listH = listEl.getBoundingClientRect().height;
    pass(
      expectH > 0 && Math.abs(listH - expectH) < Math.max(10, rowH),
      "窗口化后列表总高度仍对应 400 页（" +
        listH.toFixed(0) +
        "px，约 " +
        expectH.toFixed(0) +
        "px）"
    );

    // 滚回顶部：窗口后面的条目要回收，不能只增不减
    sideBody.scrollTop = 0;
    sideBody.dispatchEvent(new Event("scroll"));
    await sleep(300);
    const back = thumbCount();
    pass(
      back < bottom && !listEl.querySelector('.mb-thumb[data-page="399"]'),
      "滚回顶部后多余条目被回收（" + bottom + " → " + back + "）"
    );

    // 还原成原来的 3 页，后面的断言仍按原书
    sideBody.scrollTop = 0;
    view.store!.data.pages = origPages;
    (view as any).pageCountSig = -1;
    (view as any).renderPageList();
    await sleep(120);
    const restored = sideEl.querySelectorAll(".mb-thumb").length;
    pass(
      restored === 4,
      "还原 3 页后侧栏条目恢复（3 页 + 加页，实际 " + restored + " 个）"
    );
  }

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

  /*
   * 切模式不能动排版。
   *
   * 曾经 `is-reading` 把 .mb-scroll 的 padding 从 22/90 改成 10/22、
   * .mb-doc 的 gap 从 24 改成 28：一进阅读模式，上半页少 12px、
   * 下半页少 88px、每页间距多 4px，第 20 页偏出 80px。
   * 真机表现就是「一开仅阅读，平板上的页面会变」。
   */
  const scrollEl = root.querySelector(".mb-scroll") as HTMLElement;
  const docEl = root.querySelector(".mb-doc") as HTMLElement;
  const layoutSig = () => {
    const s = getComputedStyle(scrollEl);
    const d = getComputedStyle(docEl);
    return [s.paddingTop, s.paddingBottom, d.gap].join(" | ");
  };
  const layoutWrite = layoutSig();

  (readBtn as HTMLElement).click();
  await sleep(200);
  pass(isReading(), "点「阅读」按钮进入仅阅读模式");
  pass(
    layoutSig() === layoutWrite,
    "仅阅读不改页面排版（padding/gap 前后一致：" + layoutSig() + "）"
  );
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

  /* ============ 6.5 「允许手指书写」必须真的能写 ============ */
  /*
   * 真机 bug：开着仅阅读（或开着「只认触控笔」）时点「允许手指书写」，
   * 开关亮了但手指还是写不出字——因为那两个状态各自都把落笔拦在前面
   * （readOnly 直接 return，penOnly 把 touch 判成 pan）。
   * 用户点的是"让我用手指写"，就该真的能写。
   */
  {
    // 先造出"点了按钮也写不了"的两个前提
    (view as any).plugin.settings.penOnly = true;
    view.editor.setPenOnly(true);
    view.editor.setTouchDraw(false);
    (readBtn as HTMLElement).click();
    await sleep(150);
    pass(isReading(), "前置：仅阅读 + 只认触控笔 + 手指书写关闭");

    const touchBtn = document.querySelector(
      '.mb-ib[aria-label="允许手指书写"]'
    ) as HTMLElement | null;
    pass(!!touchBtn, "侧栏「输入方式」里有允许手指书写按钮");
    touchBtn?.click();
    await sleep(200);

    pass(!isReading(), "点「允许手指书写」会自动退出仅阅读（否则根本落不了笔）");
    pass(
      (view as any).plugin.settings.penOnly === false,
      "同时关掉「只认触控笔」（它也会把 touch 判成滚动）"
    );
    pass(view.editor.touchDraw === true, "手指书写开关已打开");

    const n0 = strokeCountAll();
    drawAt(240, 320, "touch");
    await sleep(160);
    pass(
      strokeCountAll() > n0,
      "手指真的写出了笔迹（" + n0 + " → " + strokeCountAll() + "）"
    );

    // 还原，别给后面的用例留下"允许手指书写"
    view.editor.setTouchDraw(false);
    await sleep(60);
  }
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
  pass(new Set(tTops).size === 1, "平板端 8 个工具仍是一行（没有换行）");

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
    pass(btns === 11, "搬下来后 11 个按钮都在（没被压扁）：" + btns);
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

  /* ============ 12. 文字：选中 / 属性条 / 键盘删除 ============ */
  {
    const pg = view.store!.data.pages[0];
    pg.texts = [
      {
        id: "t_dock",
        source: "user",
        x: 120,
        y: 240,
        size: 20,
        color: "#1A1A1A",
        font: "sans",
        text: "可编辑文字",
      },
    ];
    view.editor!.renderPages();
    await sleep(200);
    view.editor!.setTool("text");
    view.editor!.selectText("t_dock");
    await sleep(80);

    const tbar = root.querySelector(".mb-textbar") as HTMLElement;
    pass(!!tbar, "选中文字后纸上浮出属性条 .mb-textbar");
    pass(
      (tbar?.querySelectorAll(".mb-tb-btn").length ?? 0) >= 4,
      "属性条按钮齐全（字号−/＋、编辑、删除）：" + (tbar?.querySelectorAll(".mb-tb-btn").length ?? 0)
    );

    // 侧栏里文字工具应该有字体下拉与色点
    const fontSel = root.querySelector(".mb-font-sel") as HTMLSelectElement;
    pass(!!fontSel && fontSel.options.length >= 4, "侧栏文字面板有字体下拉（4 种）");
    pass(
      (root.querySelectorAll(".mb-tcolor").length ?? 0) >= 6,
      "侧栏文字面板有颜色点（" + root.querySelectorAll(".mb-tcolor").length + " 个）"
    );

    // Esc：先取消选中，不该顺手切到仅阅读
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(80);
    pass(view.editor!.selectedText === null, "Esc 取消选中");
    pass(!root.classList.contains("is-reading"), "Esc 取消选中时不会误切仅阅读");

    // Delete：删掉选中文字，可撤销
    view.editor!.selectText("t_dock");
    await sleep(60);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    await sleep(100);
    pass((view.store!.data.pages[0].texts || []).length === 0, "Delete 删掉选中的文字");
    view.editor!.undo();
    await sleep(100);
    pass((view.store!.data.pages[0].texts || []).length === 1, "Delete 删除可撤销");

    // 选择工具：点中可拖，拖动可撤销
    view.editor!.setTool("select");
    await sleep(80);
    const beforeXY = { x: view.store!.data.pages[0].texts![0].x, y: view.store!.data.pages[0].texts![0].y };
    const pageEl = root.querySelector(".mb-page") as HTMLElement;
    const pr = pageEl.getBoundingClientRect();
    const k = pr.width / 794;
    const put = (type: string, x: number, y: number, id: number) =>
      pageEl.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: id,
          pointerType: "mouse",
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: Math.round(pr.left + x * k),
          clientY: Math.round(pr.top + y * k),
        })
      );
    put("pointerdown", 130, 234, 41);
    put("pointerup", 130, 234, 41);
    await sleep(80);
    pass(
      view.editor!.selectedText?.id === "t_dock",
      "选择工具点文字就选中（不必先切文字工具）"
    );

    put("pointerdown", 130, 234, 42);
    put("pointermove", 190, 300, 42);
    await sleep(80);
    put("pointerup", 190, 300, 42);
    await sleep(120);
    const moved = view.store!.data.pages[0].texts![0];
    pass(
      Math.abs(moved.x - beforeXY.x) > 20 && Math.abs(moved.y - beforeXY.y) > 20,
      "拖动文字改坐标（" +
        beforeXY.x +
        "," +
        beforeXY.y +
        " -> " +
        Math.round(moved.x) +
        "," +
        Math.round(moved.y) +
        "）"
    );
    view.editor!.undo();
    await sleep(120);
    const back = view.store!.data.pages[0].texts![0];
    pass(
      Math.abs(back.x - beforeXY.x) < 2 && Math.abs(back.y - beforeXY.y) < 2,
      "拖动可撤销回原位"
    );

    // 形状面板：颜色点（粗细滑杆本来就有）
    view.editor!.setTool("shape");
    await sleep(80);
    pass(
      (root.querySelectorAll(".mb-tcolor").length ?? 0) >= 6,
      "形状面板也有颜色点（" + root.querySelectorAll(".mb-tcolor").length + " 个）"
    );
    pass(!!root.querySelector(".mb-range"), "形状面板仍有粗细滑杆");
  }

  log("");
  const fails = lines.filter((l) => l.startsWith("FAIL")).length;
  log(fails === 0 ? "ALL PASS" : fails + " FAILED");
  /*
   * 必须置 DONE：run.mjs 靠 document.title 判断结束。
   * 漏了这一行时，整套明明跑完了也要把 180s 超时耗光（每次全量跑白等 3 分钟）。
   */
  document.title = "DONE";
})();
