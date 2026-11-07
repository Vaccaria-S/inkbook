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

    /*
     * 2.6.1 滚动跨行**不重建**窗口内条目的 DOM。
     *
     * 用户真机反馈「侧栏缩略图滑动时一闪一闪」：旧实现每次跨行
     * list.empty() + 整屏新建，窗口里的旧 canvas 被摘下、新 canvas
     * 还没画完，中间必然空一帧。这里直接比对对象身份：
     *   · 跨行后仍留在窗口里的页 → canvas 和条目必须是同一个对象；
     *   · 滚回原位置时，刚被回收的页 → 从复用池取回同一个 canvas（像素还在）。
     */
    {
      // 先把页列表滚进视口，让窗口是「完整一屏 + overscan」，才有足够的重叠行
      const bodyRect = sideBody.getBoundingClientRect();
      const listOffset = listEl.getBoundingClientRect().top - bodyRect.top + sideBody.scrollTop;
      sideBody.scrollTop = listOffset;
      sideBody.dispatchEvent(new Event("scroll"));
      await sleep(300);

      const beforeLo = (view as any).pageWinRowLo as number;
      const beforeCv = new Map<number, HTMLCanvasElement>();
      for (const [i, cv] of (view as any).thumbCanvases as Map<number, HTMLCanvasElement>) {
        beforeCv.set(i, cv);
      }
      const rowH = ((view as any).pageWinRowH as number) || 90;

      // 往下滚 3 行：overscan 是 2 行，窗口会真正下移一行
      sideBody.scrollTop = sideBody.scrollTop + rowH * 3 + 2;
      sideBody.dispatchEvent(new Event("scroll"));
      await sleep(300);

      const afterLo = (view as any).pageWinRowLo as number;
      const afterCv = (view as any).thumbCanvases as Map<number, HTMLCanvasElement>;
      pass(
        afterLo > beforeLo,
        "滚动跨行后窗口确实下移（rowLo " + beforeLo + " → " + afterLo + "）"
      );

      const stayed: number[] = [];
      let sameCanvas = true;
      let sameItem = true;
      for (const [i, cv] of beforeCv) {
        const now = afterCv.get(i);
        if (!now) continue;
        stayed.push(i);
        if (now !== cv) sameCanvas = false;
        if (now.parentElement !== cv.parentElement) sameItem = false;
      }
      pass(
        stayed.length >= 4,
        "跨行后仍有 " + stayed.length + " 页留在窗口里（可验证不重建）"
      );
      pass(
        stayed.length > 0 && sameCanvas && sameItem,
        "跨行后窗口内的缩略图仍是同一个 canvas/条目对象（没有整屏重建）"
      );

      // 滚回原来的位置：刚回收的条目应从复用池原样取回，canvas 不被清空
      const leaving = Array.from(beforeCv.keys()).filter((i) => !afterCv.has(i));
      sideBody.scrollTop = listOffset;
      sideBody.dispatchEvent(new Event("scroll"));
      await sleep(300);
      const backCv = (view as any).thumbCanvases as Map<number, HTMLCanvasElement>;
      const reused = leaving.filter((i) => backCv.get(i) === beforeCv.get(i));
      pass(
        leaving.length > 0 && reused.length === leaving.length,
        "滚回原位置时回收条目按页号复用（" +
          reused.length +
          "/" +
          leaving.length +
          " 个 canvas 是同一对象）"
      );
    }

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

    /*
     * 从回收池复用条目时，`dataset.pageId` 必须与当前页序一致
     * （2026-11-07 补）：条目按页号进池、按页号复用，历史上页序不变时
     * 恰好一致；但拖拽的 click 守卫是**按 pageId 比对**的，
     * 页序变过就会对不上。这里滚一遍再滚回来，逐条核对 pageId。
     */
    {
      const pages = view.store!.data.pages;
      const mismatched: string[] = [];
      for (const el of Array.from(listEl.querySelectorAll(".mb-thumb:not(.mb-thumb-add)"))) {
        const idx = Number((el as HTMLElement).dataset.page);
        const pid = (el as HTMLElement).dataset.pageId;
        const real = pages[idx]?.id ?? "";
        if (pid !== real) mismatched.push(`#${idx}: ${pid}≠${real}`);
      }
      pass(
        mismatched.length === 0,
        "复用池条目后 dataset.pageId 与当前页序一致（" +
          (mismatched.length ? mismatched.slice(0, 3).join(";") : "全部一致") +
          "）"
      );
    }

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

  /* ============ 2.7 缩略图长按拖拽重排 ============ */
  /*
   * 用户原话：「侧边栏里页面这一栏就是缩略图，我想要长按具体的页面（比如第一页），
   * 就可以把它拖动到任何地方。比如把第一页拖到第二页后面，那么第二页变成第一页、
   * 第一页变成第二页。」
   *
   * 这条路径要走**真的 pointer 事件**（不是直接调 store.movePage）：
   *   按下 → 等 450ms 让菜单弹出 → 移动超 8px 承接成拖拽 →
   *   移到目标条目的下半 → 抬手。
   *
   * 这里同时验三件容易互相打架的事：
   *   1. 拖完页序真的换了（且换到用户说的位置）；
   *   2. 拖拽的中间态不把侧栏窗口化搞崩（被拖条目不能被重建掉）；
   *   3. 拖完 / 取消之后不留幽灵（ghost、指示线、is-dragging、document 监听）。
   */
  {
    const listEl = sideEl.querySelector(".mb-pages") as HTMLElement;
    const sideBody = sideEl.querySelector(".mb-side-body") as HTMLElement;
    /*
     * 先把页列表滚进侧栏可视区（否则条目在视口外，拖拽时的边缘自动滚动
     * 会把布局滚走，落点坐标全乱）。滚到顶 + 20px，留足上下空间。
     */
    {
      const br = sideBody.getBoundingClientRect();
      const lr = listEl.getBoundingClientRect();
      sideBody.scrollTop += lr.top - br.top - 20;
      sideBody.dispatchEvent(new Event("scroll"));
      await sleep(250);
    }
    const thumbAt = (i: number) =>
      listEl.querySelector(`.mb-thumb[data-page="${i}"]`) as HTMLElement | null;
    /** 当前页序（页 id 顺序），比下标更能说明「哪一页跑到哪了」 */
    const order = () => view.store!.data.pages.map((p: any) => p.id);
    /** 侧栏条目渲染出来的页序 */
    const domOrder = () =>
      [...listEl.querySelectorAll(".mb-thumb:not(.mb-thumb-add)")].map(
        (el: any) => el.dataset.pageId
      );

    /**
     * 真 pointer 事件：按下 → 等待 → 移动若干点 → 抬手。
     *
     * 事件派发到**目标元素**上（bubbles:true 会一路冒到 document，
     * document 级的长按监听因此收得到）。
     */
    const pe = (
      target: HTMLElement,
      type: string,
      x: number,
      y: number,
      id = 91
    ) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          pointerId: id,
          pointerType: "touch",
          isPrimary: true,
          clientX: Math.round(x),
          clientY: Math.round(y),
        })
      );

    const before = order();
    const beforeDom = domOrder();
    pass(
      before.length === 3 && beforeDom.join(",") === before.join(","),
      "2.7 前置：3 页且侧栏条目与 store 顺序一致"
    );

    /* ---- ① 长按 → 移动 → 拖到第 2 页下半 → 抬手 ---- */
    const src = thumbAt(0)!;
    const dst = thumbAt(1)!;
    const srcR = src.getBoundingClientRect();
    const dstR = dst.getBoundingClientRect();
    const grabX = srcR.left + srcR.width / 2;
    const grabY = srcR.top + srcR.height / 2;

    pe(src, "pointerdown", grabX, grabY);
    // 等 450ms：菜单弹出（长按态确立）
    await sleep(600);
    const menuOpen = !!thumbAt(0)?.querySelector(".mb-thumb-menu");
    pass(menuOpen, "2.7 长按第 1 页 450ms 后弹出「上移/下移」菜单（菜单保留）");

    // 移动超 8px → 承接成拖拽
    pe(src, "pointermove", grabX + 20, grabY);
    await sleep(60);
    const dragging = (view as any).thumbDragActive === true;
    pass(dragging, "2.7 菜单开着时移动超 8px 承接成拖拽（thumbDragActive）");
    pass(
      !!document.querySelector(".mb-thumb-ghost"),
      "2.7 拖拽中生成拖拽影像 .mb-thumb-ghost"
    );
    pass(
      !!document.querySelector(".mb-thumb-drop-bar"),
      "2.7 拖拽中生成落点指示竖条 .mb-thumb-drop-bar"
    );
    pass(
      !document.querySelector(".mb-thumb-drop-line"),
      "2.7 拖拽中不再有旧的横线指示 .mb-thumb-drop-line（只留竖条）"
    );
    /*
     * 拖拽影像里必须有**真缩略图**，不是空白框。
     *
     * 用户原话：「显示的缩略图还是不太直观」——以前 ghost 只是个带边框的
     * 空 div，用户看到的是块空白。位图靠 cloneNode 复制不过来（克隆出来是
     * 0×0 的空 canvas），必须用 drawImage 画过去。
     */
    {
      const g = document.querySelector(".mb-thumb-ghost") as HTMLElement | null;
      const gcv = g?.querySelector(".mb-thumb-ghost-canvas") as HTMLCanvasElement | null;
      let painted = false;
      if (gcv && gcv.width > 0 && gcv.height > 0) {
        const gctx = gcv.getContext("2d");
        if (gctx) {
          const data = gctx.getImageData(0, 0, gcv.width, gcv.height).data;
          // 纸面底色不透明 → 画过 = 有 alpha≠0 的像素
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] !== 0) {
              painted = true;
              break;
            }
          }
        }
      }
      pass(
        !!gcv && painted,
        "2.7 拖拽影像里是**真缩略图**（ghost canvas 有内容，不是空白框）"
      );
    }
    pass(
      src.classList.contains("mb-thumb-dragging"),
      "2.7 被拖条目带 is-dragging 虚化态"
    );

    /*
     * 窗口化共存：拖拽期间侧栏滚动 / 重算窗口**不能**把被拖条目换掉。
     * 这里直接比对对象身份——换了节点，拖拽态就断了。
     */
    const stillSameNode = thumbAt(0) === src;
    pass(
      stillSameNode,
      "2.7 拖拽期间被拖条目没有被窗口重建换掉（同一 DOM 节点）"
    );

    // 移到第 2 页的**下半**（下半 = 插到它后面）
    const dstX = dstR.left + dstR.width / 2;
    const dstY = dstR.bottom - 3;
    pe(src, "pointermove", dstX, dstY);
    await sleep(60);
    const insertPos = (view as any).thumbDragInsertPos as number;
    pass(
      insertPos === 1,
      "2.7 落在第 2 页下半 → 换算出的最终下标是 1（" + insertPos + "）"
    );

    /*
     * 紫色竖条：用户原话「长按页面挪动的时候，得加一个紫色的竖条，
     * 这样能更直观地看到我挪到哪儿了」。
     *
     * 竖条画在**插入位置**：
     *   插到目标前面 → 目标缩略图的**左**边缘；
     *   插到目标后面 → 目标缩略图的**右**边缘。
     * 这里落在第 2 页下半 = 插到它**后面** → 竖条应在目标右边缘。
     */
    {
      const bar = document.querySelector(".mb-thumb-drop-bar") as HTMLElement | null;
      pass(!!bar, "2.7 拖拽中存在落点竖条 .mb-thumb-drop-bar");
      if (bar) {
        // 现量一次目标 rect（拖拽期间侧栏可能被边缘自动滚动量挪过）
        const tR = dst.getBoundingClientRect();
        const br = bar.getBoundingClientRect();
        // 竖条：细长的一条（宽度远小于缩略图宽度）
        pass(
          br.width > 0 && br.width <= 8 && br.width < tR.width / 2,
          "2.7 竖条是细长的一条（宽 " + br.width.toFixed(1) + "px ≤ 8px）"
        );
        // 竖直方向覆盖目标缩略图的高度（别高出一截、也别短一截）
        pass(
          Math.abs(br.height - tR.height) <= 2,
          "2.7 竖条高度覆盖目标缩略图（" +
            br.height.toFixed(1) +
            " vs " +
            tR.height.toFixed(1) +
            "）"
        );
        pass(
          Math.abs(br.top - tR.top) <= 2 && Math.abs(br.bottom - tR.bottom) <= 2,
          "2.7 竖条上下沿与目标缩略图对齐（上 " +
            br.top.toFixed(1) +
            " / 下 " +
            br.bottom.toFixed(1) +
            "）"
        );
        /*
         * 插到目标**后面** → 竖条贴在目标的**右边缘**（条身在那条缝里，
         * 左沿 == 目标右沿）。
         */
        pass(
          Math.abs(br.left - tR.right) <= 2,
          "2.7 插到目标后面 → 竖条在目标缩略图的右边缘（左 " +
            br.left.toFixed(1) +
            " vs 目标右 " +
            tR.right.toFixed(1) +
            "）"
        );
        // 颜色：主题强调色（Obsidian 默认紫色），不是透明/白
        const cs = getComputedStyle(bar);
        const bg = cs.backgroundColor;
        const m = /rgba?\(([^)]+)\)/.exec(bg);
        const parts = m ? m[1].split(",").map((s) => parseFloat(s.trim())) : [];
        const alpha = parts.length >= 4 ? parts[3] : parts.length >= 3 ? 1 : 0;
        const accent = getComputedStyle(document.documentElement)
          .getPropertyValue("--interactive-accent")
          .trim();
        pass(
          alpha > 0.5 && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)",
          "2.7 竖条用不透明的强调色（background " + bg + "）"
        );
        // 强调色确实解析成了紫色系（Obsidian 默认 #6c5ce7 / 类似紫）
        const isPurple =
          /#([0-9a-f]{6})/i.test(accent) &&
          (() => {
            const hex = /#([0-9a-f]{6})/i.exec(accent)![1];
            const r = parseInt(hex.slice(0, 2), 16);
            const g = parseInt(hex.slice(2, 4), 16);
            const b = parseInt(hex.slice(4, 6), 16);
            return b > g && r > g; // 紫：蓝和红都压过绿
          })();
        pass(
          !!accent && isPurple,
          "2.7 竖条颜色跟随主题强调色 --interactive-accent（" + accent + "）"
        );
      }
    }

    /*
     * 插到目标**前面**时，竖条挪到目标的**左边缘**。
     * 这里再拖一次：移到第 2 页的**上半**（= 插到它前面），看条是否换边。
     *
     * 注意：指针靠近侧栏视口上缘时 maybeAutoScroll 会轻推侧栏，
     * 所以断言只比**水平**关系（竖向位移与本断言无关），
     * 看完再把指针挪回下半，保证抬手时落点仍是"插到第 2 页后面"。
     */
    {
      const tR2 = dst.getBoundingClientRect();
      const dstTopY = tR2.top + 3;
      pe(src, "pointermove", dstX, dstTopY);
      await sleep(60);
      const bar = document.querySelector(".mb-thumb-drop-bar") as HTMLElement | null;
      const tR3 = dst.getBoundingClientRect();
      // 插到前面 → 条身贴在目标的**左沿外侧**（右沿 == 目标左沿）
      pass(
        !!bar && Math.abs(bar.getBoundingClientRect().right - tR3.left) <= 2,
        "2.7 插到目标前面 → 竖条换到目标缩略图的左边缘"
      );
      // 插到目标前面时，落点下标也要跟着变（第 1 页插到第 2 页前 = 下标 0）
      pass(
        (view as any).thumbDragInsertPos === 0,
        "2.7 落在第 2 页上半 → 换算出的最终下标是 0（" +
          (view as any).thumbDragInsertPos +
          "）"
      );
      // 挪回下半：把落点恢复到「插到第 2 页后面」
      const tR4 = dst.getBoundingClientRect();
      pe(src, "pointermove", dstX, tR4.bottom - 3);
      await sleep(60);
      pass(
        (view as any).thumbDragInsertPos === 1,
        "2.7 挪回下半 → 落点恢复成插到第 2 页后面（下标 1）"
      );
    }

    // 抬手 → 落库（用当前实时坐标，避免自动滚动后坐标过期）
    {
      const tR5 = dst.getBoundingClientRect();
      pe(src, "pointerup", dstX, tR5.bottom - 3);
    }
    await sleep(300);

    const after = order();
    pass(
      after[0] === before[1] && after[1] === before[0] && after[2] === before[2],
      "2.7 第 1 页拖到第 2 页后面 → 顺序变成 [原2, 原1, 原3]（实际 " +
        after.map((id: string) => before.indexOf(id)).join(",") +
        "）"
    );
    const afterDom = domOrder();
    pass(
      afterDom.join(",") === after.join(","),
      "2.7 拖完侧栏条目跟着换序（" +
        afterDom.map((id: string) => before.indexOf(id)).join(",") +
        "）"
    );

    /* ---- ② 幽灵状态必须收干净 ---- */
    pass(
      !document.querySelector(".mb-thumb-ghost"),
      "2.7 松手后拖拽影像已移除"
    );
    pass(
      !document.querySelector(".mb-thumb-drop-bar"),
      "2.7 松手后落点竖条已移除"
    );
    pass(
      !document.querySelector(".mb-thumb-dragging"),
      "2.7 松手后 is-dragging 虚化态已摘掉"
    );
    pass(
      (view as any).thumbDragActive === false &&
        (view as any).thumbDragInsertPos === -1 &&
        (view as any).thumbDragItem === null,
      "2.7 松手后拖拽内部状态复位（active/insertPos/item）"
    );
    pass(
      (view as any).thumbDragDocAbort === null &&
        (view as any).thumbPressMoveAbort === null &&
        (view as any).thumbTouchGuardAbort === null,
      "2.7 松手后 document 监听与 touch guard 全部解除"
    );

    /* ---- ③ 撤销后顺序换回来 ---- */
    view.editor.undo();
    await sleep(300);
    const undone = order();
    pass(
      undone.join(",") === before.join(","),
      "2.7 撤销后页序换回来（" +
        undone.map((id: string) => before.indexOf(id)).join(",") +
        "）"
    );

    /* ---- ④ 纯点击缩略图仍然能翻页（拖拽守卫没误伤） ---- */
    const curBefore = view.editor.getState().pageIndex;
    const clickTarget = thumbAt(2);
    if (clickTarget) {
      const cr = clickTarget.getBoundingClientRect();
      const cxp = cr.left + cr.width / 2;
      const cyp = cr.top + cr.height / 2;
      // 纯点击：按下即抬手，不等 450ms，也不移动
      pe(clickTarget, "pointerdown", cxp, cyp, 92);
      await sleep(40);
      pe(clickTarget, "pointerup", cxp, cyp, 92);
      await sleep(80);
      // click 由浏览器在 pointerup 后合成；脚本里手动补一个
      (clickTarget as any).click();
      await sleep(400);
    }
    pass(
      view.editor.getState().pageIndex === 2,
      "2.7 纯点击缩略图仍然翻到那一页（" +
        curBefore +
        " → " +
        view.editor.getState().pageIndex +
        "，期望 2）"
    );

    /* ---- ④b 拖完那一下的 click 守卫只挡「被拖的那一页」（2026-11-07 修） ---- */
    /*
     * 旧实现用**一个全局布尔**当守卫：拖完设 true，任何缩略图的 click
     * 都先消费它。触屏 pointerup 的落点可能偏到相邻条目，于是「点了别的
     * 条目」也会被吞掉一次（用户点了没反应，还白吃掉标志）。
     * 现在按页 id 命中：只有被拖那一页的 click 被挡，别的照常翻页。
     */
    {
      const v3 = view as any;
      const pages = view.store!.data.pages;
      // 假装刚拖完第 1 页（id = pages[0].id）
      v3.thumbDragClickGuard = true;
      v3.thumbDragClickGuardId = pages[0].id;
      const beforeClick = view.editor.getState().pageIndex;
      // 点**另一页**（下标 1 的条目）—— 应该正常翻页，不被吞
      const other = thumbAt(1);
      if (other) {
        other.click();
        await sleep(300);
      }
      pass(
        view.editor.getState().pageIndex === 1,
        "2.7 拖完后点「别的页」照常翻页（守卫按页 id 命中，不误吞；" +
          beforeClick +
          " → " +
          view.editor.getState().pageIndex +
          "）"
      );
      pass(
        !v3.thumbDragClickGuard,
        "2.7 点别的页后守卫被清掉（不会一直挂着挡住后续点击）"
      );
      // 再验：被拖的那一页的 click 仍然被挡
      v3.thumbDragClickGuard = true;
      v3.thumbDragClickGuardId = pages[0].id;
      const selfBefore = view.editor.getState().pageIndex;
      thumbAt(0)?.click();
      await sleep(200);
      pass(
        view.editor.getState().pageIndex === selfBefore,
        "2.7 拖完那一下点「被拖的那一页」仍被挡住（不顺手翻页）"
      );
      // 复位，别影响后面
      v3.thumbDragClickGuard = false;
      v3.thumbDragClickGuardId = "";
      view.editor.goToPage(2, false);
      await sleep(200);
    }

    /* ---- ⑤ 长按期间（未到 450ms）移动超 8px → 当滚动，不重排 ---- */
    const orderBeforeScroll = order();
    const pageBeforeScroll = view.editor.getState().pageIndex;
    const s5 = thumbAt(0)!;
    const s5r = s5.getBoundingClientRect();
    const sx = s5r.left + s5r.width / 2;
    const sy = s5r.top + s5r.height / 2;
    pe(s5, "pointerdown", sx, sy, 93);
    // 还没到 450ms 就移动超 8px → 视作滚动
    await sleep(60);
    pe(s5, "pointermove", sx + 30, sy + 30, 93);
    await sleep(500);
    pass(
      !thumbAt(0)?.querySelector(".mb-thumb-menu"),
      "2.7 长按未满 450ms 就移动 >8px → 不弹菜单（当滚动处理）"
    );
    pass(
      (view as any).thumbDragActive === false,
      "2.7 长按未满 450ms 就移动 >8px → 不进拖拽"
    );
    pe(s5, "pointerup", sx + 30, sy + 30, 93);
    await sleep(150);
    pass(
      order().join(",") === orderBeforeScroll.join(",") &&
        view.editor.getState().pageIndex === pageBeforeScroll,
      "2.7 长按期间移动（滚动）不触发任何重排"
    );

    /* ---- ⑥ 拖拽中取消（pointercancel）也必须收干净 ---- */
    const c1 = thumbAt(0)!;
    const c2 = thumbAt(1)!;
    const c1r = c1.getBoundingClientRect();
    const c2r = c2.getBoundingClientRect();
    const cx = c1r.left + c1r.width / 2;
    const cy = c1r.top + c1r.height / 2;
    pe(c1, "pointerdown", cx, cy, 94);
    await sleep(600);
    pe(c1, "pointermove", cx + 20, cy, 94);
    await sleep(60);
    const inDrag = (view as any).thumbDragActive === true;
    pe(c1, "pointercancel", c2r.left + c2r.width / 2, c2r.bottom - 3, 94);
    await sleep(150);
    pass(
      inDrag && (view as any).thumbDragActive === false,
      "2.7 拖拽被 pointercancel 掐掉后状态复位"
    );
    pass(
      !document.querySelector(".mb-thumb-ghost") &&
        !document.querySelector(".mb-thumb-drop-bar") &&
        !document.querySelector(".mb-thumb-dragging"),
      "2.7 取消后不留 ghost / 竖条 / 虚化态"
    );
    pass(
      order().join(",") === orderBeforeScroll.join(","),
      "2.7 取消拖拽不改变页序"
    );

    /* ---- ⑦ 拖到「列缝」/列表外侧也不能丢落点（2026-11-07 修） ---- */
    /*
     * 旧实现要求指针横向**必须落在条目 left~right 之间**才算命中，
     * 于是拖到 4 列网格的列缝里、或拖到列表最左/最右外侧时，
     * 落点直接变 null → 竖条消失、松手不重排。
     * 用户手感上就是「拖到一半突然没反应」。
     *
     * 现在按「先定行、再定该行内横向最近的一条」来吸附。
     * 这里验三处：列缝、列表左外侧、列表右外侧 —— 都必须仍有落点。
     */
    {
      const listEl2 = sideEl.querySelector(".mb-pages") as HTMLElement;
      const items = [...listEl2.querySelectorAll(".mb-thumb:not(.mb-thumb-add)")] as HTMLElement[];
      // 取第一行两个相邻条目之间的缝
      const r0 = items[0].getBoundingClientRect();
      const r1 = items[1] ? items[1].getBoundingClientRect() : null;
      const listRect = listEl2.getBoundingClientRect();
      const sameRow = r1 ? Math.abs(r0.top - r1.top) < 2 : false;
      const seamX = r1 && sameRow ? (r0.right + r1.left) / 2 : r0.right + 3;
      const rowY = r0.top + r0.height / 2;

      /*
       * findThumbDropTarget 在 fromIndex < 0 时直接返回 null（不在拖拽态）。
       * 这里只想验「吸附算法」本身，所以临时把 fromIndex 设成 0
       * （= 假装正在拖第 1 页），验完还原。
       */
      const v2 = view as any;
      const savedFrom = v2.thumbDragFromIndex;
      v2.thumbDragFromIndex = 0;
      const probe = (x: number, y: number) =>
        v2.findThumbDropTarget(x, y) as { index: number; rect: DOMRect } | null;
      const atSeam = probe(seamX, rowY);
      pass(
        !!atSeam,
        "2.7 拖到列缝里仍有落点（缝 x=" +
          seamX.toFixed(0) +
          "，命中 " +
          (atSeam ? "#" + atSeam.index : "无") +
          "）"
      );
      const atLeft = probe(listRect.left - 40, rowY);
      pass(
        !!atLeft,
        "2.7 拖到列表左外侧仍有落点（x=" +
          (listRect.left - 40).toFixed(0) +
          "，命中 " +
          (atLeft ? "#" + atLeft.index : "无") +
          "）"
      );
      const atRight = probe(listRect.right + 40, rowY);
      pass(
        !!atRight,
        "2.7 拖到列表右外侧仍有落点（x=" +
          (listRect.right + 40).toFixed(0) +
          "，命中 " +
          (atRight ? "#" + atRight.index : "无") +
          "）"
      );
      /*
       * 吸附必须**落在同一行**：列缝探测到的条目，其纵向中心应与指针
       * 所在行接近（否则「先定行」这步就没生效，会吸到别的行去）。
       */
      pass(
        !!atSeam && Math.abs((atSeam.rect.top + atSeam.rect.bottom) / 2 - rowY) < 4,
        "2.7 列缝吸附落在同一行（纵向偏差 " +
          (atSeam ? Math.abs((atSeam.rect.top + atSeam.rect.bottom) / 2 - rowY).toFixed(1) : "-") +
          "px）"
      );
      // 而且不能吸到「被拖的自己」（fromIndex=0 时不该返回 #0）
      pass(
        !!atSeam && atSeam.index !== 0,
        "2.7 吸附不会落到被拖的那一条上（命中 " +
          (atSeam ? "#" + atSeam.index : "无") +
          "）"
      );
      v2.thumbDragFromIndex = savedFrom;
    }

    /*
     * 收尾：把本段留下的历史痕迹清干净。
     *
     * 上面 ③ 用过一次 undo()，那会把重做栈填上（undo → redoStack 有东西）。
     * 后面第 4 段断言「还没有可撤销/可重做的内容时，两键都置灰」，
     * 前提是**两个栈都空**——不清理的话那条会假失败（不是产品坏了，
     * 是上一段测试留下的状态）。
     *
     * 直接把两个栈掏空最干净，也不依赖栈里恰好有几条。
     */
    const st = view.store as any;
    if (st?.undoStack) st.undoStack.length = 0;
    if (st?.redoStack) st.redoStack.length = 0;
    if (st?.pendingBefore) st.pendingBefore = null;
    view.editor.emitState?.();
    await sleep(120);
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

  /*
   * 撤销 / 重做也必须常驻在浮标里。
   *
   * 平板默认收起侧栏，写错一笔要「点侧栏 → 滚到顶部 → 点撤销」，
   * 没键盘时等于撤不了。这两键和翻页组并列，不展开侧栏就能点。
   */
  const editGrp = root.querySelector(".mb-float-edit") as HTMLElement;
  const floatUndo = editGrp?.querySelector(
    'button[aria-label="撤销"]'
  ) as HTMLButtonElement;
  const floatRedo = editGrp?.querySelector(
    'button[aria-label="重做"]'
  ) as HTMLButtonElement;
  pass(
    !!editGrp && editGrp.querySelectorAll(".mb-float-btn").length === 2,
    "浮标里有撤销/重做两键"
  );
  pass(
    !!floatUndo?.querySelector("svg.mb-ic path") &&
      !!floatRedo?.querySelector("svg.mb-ic path"),
    "浮标撤销/重做的图标都画出来了（不是空框）"
  );
  pass(
    !!floatUndo &&
      !!floatRedo &&
      floatUndo.classList.contains("is-disabled") &&
      floatRedo.classList.contains("is-disabled"),
    "还没有可撤销/可重做的内容时，两键都置灰"
  );

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

  /* ============ 6.6 浮标上的撤销 / 重做能直接点 ============ */
  {
    pass(
      floatUndo?.classList.contains("is-disabled") === false &&
        floatRedo?.classList.contains("is-disabled") === true,
      "刚落完一笔：浮标撤销可用、重做置灰"
    );
    const nUndo = strokeCountAll();
    floatUndo?.click();
    await sleep(250);
    pass(
      strokeCountAll() === nUndo - 1,
      "点浮标上的撤销真能撤掉一笔（" + nUndo + " → " + strokeCountAll() + "）"
    );
    pass(
      floatRedo?.classList.contains("is-disabled") === false,
      "撤销后浮标重做键变可用"
    );
    floatRedo?.click();
    await sleep(250);
    pass(
      strokeCountAll() === nUndo,
      "点浮标上的重做能恢复那一笔（" + (nUndo - 1) + " → " + strokeCountAll() + "）"
    );
  }

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

  // 浮标里的撤销/重做是手指直接点的，平板档必须 ≥ 36px
  const fBtnEl = float.querySelector(".mb-float-edit .mb-float-btn") as HTMLElement;
  const fBtnRect = fBtnEl.getBoundingClientRect();
  pass(
    fBtnRect.width >= 36 && fBtnRect.height >= 36,
    "平板端浮标撤销/重做按钮 ≥ 36px（实测 " +
      fBtnRect.width.toFixed(0) +
      "×" +
      fBtnRect.height.toFixed(0) +
      "px）"
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

    /*
     * 文字工具区扁平化（用户真机：「输入文字的字体在侧边栏上下占的
     * 面积太大」「电脑端选择字体的那个框已经到页面外了」）。
     *
     * 旧布局四组控件直接塞在 .mb-dyn（nowrap 单行）里：
     * 提示文字 ~220px + 字号组 ~106px + 字体下拉 234px + 色点行，
     * 最小内容宽 400px+，而侧栏内容区只有 234px：
     *   · 字体下拉被推到侧栏右缘之外（横向看不见）；
     *   · 色点行被压成 18px 宽，8 个点竖排 → 整区被撑到约 200px 高。
     * 现在两行：字号+字体一行、8 个色点一行（nowrap）。
     */
    {
      const v = view as any;
      v.sideShown = true;
      v.applySideVisibility();
      const sideBody = view.sideEl.querySelector(".mb-side-body") as HTMLElement;
      sideBody.scrollTop = 0;
      await sleep(30);

      const dyn = view.sideEl.querySelector(".mb-sec-dyn") as HTMLElement;
      const tools = dyn?.querySelector(".mb-text-tools") as HTMLElement | null;
      const seg = dyn?.querySelector(".mb-seg") as HTMLElement;
      const fsel = dyn?.querySelector(".mb-font-sel") as HTMLSelectElement;
      const dots = [...(dyn?.querySelectorAll(".mb-tcolor") ?? [])] as HTMLElement[];
      pass(!!tools, "文字工具区有独立的两行容器 .mb-text-tools");
      pass(!dyn?.querySelector(".mb-hint"), "文字工具区不再常驻一行提示（信息收进 title）");
      pass(dots.length === 8, "8 个文字色点齐全（" + dots.length + " 个）");

      const dynRect = dyn.getBoundingClientRect();
      const segRect = seg.getBoundingClientRect();
      const fontRect = fsel.getBoundingClientRect();
      const bodyRect = sideBody.getBoundingClientRect();
      const bodyCS = getComputedStyle(sideBody);
      // 滚动容器**可视内容区**的四条边（clientWidth/Height 已扣掉滚动条）
      const contentLeft =
        bodyRect.left + sideBody.clientLeft + parseFloat(bodyCS.paddingLeft);
      const contentRight =
        bodyRect.left + sideBody.clientLeft + sideBody.clientWidth - parseFloat(bodyCS.paddingRight);
      const contentTop =
        bodyRect.top + sideBody.clientTop + parseFloat(bodyCS.paddingTop);
      const contentBottom =
        bodyRect.top + sideBody.clientTop + sideBody.clientHeight - parseFloat(bodyCS.paddingBottom);

      // 高度：旧布局约 200px（色点被挤成竖排），两行方案 ~50px
      pass(
        dynRect.height <= 64,
        "文字工具区高度 ≤64px（实测 " + dynRect.height.toFixed(1) + "px，改前约 200px）"
      );
      // 字号与字体同一行（纵向区间重叠）
      pass(
        fontRect.top < segRect.bottom && segRect.top < fontRect.bottom,
        "字号组与字体下拉在同一行（seg " +
          segRect.top.toFixed(1) +
          "~" +
          segRect.bottom.toFixed(1) +
          " / font " +
          fontRect.top.toFixed(1) +
          "~" +
          fontRect.bottom.toFixed(1) +
          "）"
      );
      // 字体下拉真的可用，不是被挤成一条缝
      pass(
        fontRect.width >= 80,
        "字体下拉宽度 ≥80px（实测 " + fontRect.width.toFixed(1) + "px）"
      );
      // 纵向在侧栏可视区内（不靠滚动也看得到）
      pass(
        fontRect.top >= contentTop - 1 && fontRect.bottom <= contentBottom + 1,
        "字体下拉在侧栏可视区纵向范围内（font bottom " +
          fontRect.bottom.toFixed(1) +
          " ≤ 可视区 bottom " +
          contentBottom.toFixed(1) +
          "）"
      );
      // 横向在侧栏内容区内（旧布局正是在这里溢出到页面外）
      pass(
        fontRect.left >= contentLeft - 1 && fontRect.right <= contentRight + 1,
        "字体下拉在侧栏内容区内（font right " +
          fontRect.right.toFixed(1) +
          " ≤ " +
          contentRight.toFixed(1) +
          "）"
      );
      pass(
        dyn.scrollWidth <= dyn.clientWidth + 1,
        "文字工具区不横向溢出（scrollWidth " +
          dyn.scrollWidth +
          " / clientWidth " +
          dyn.clientWidth +
          "）"
      );
      // 8 个色点必须在同一行，且排在字号/字体行的下面
      const tops = [...new Set(dots.map((d) => Math.round(d.getBoundingClientRect().top)))];
      pass(tops.length === 1, "8 个色点在同一行（top: " + tops.join(",") + "）");
      pass(
        Math.round(dots[0].getBoundingClientRect().top) >= Math.round(segRect.bottom) - 1,
        "色点行排在字号/字体行下方（两行布局）"
      );
      pass(
        dots[0].getBoundingClientRect().width >= 16,
        "电脑端色点 ≥16px 可点（" + dots[0].getBoundingClientRect().width + "px）"
      );
      pass(
        !!seg.querySelector('[data-mb-text-style="1"]') &&
          fsel.getAttribute("data-mb-text-style") === "1" &&
          dots.every((d) => d.getAttribute("data-mb-text-style") === "1"),
        "字号 / 字体 / 色点都带 data-mb-text-style（编辑框开着时点它们不提交）"
      );

      /* ---- 侧栏字号步进：按住连调不能断（2026-11-07 修的真回归） ---- */
      /*
       * 侧栏每按一次步进都会 `setTextSize → emitState → updateUI →
       * renderDynamicTools`。旧实现每次都 `empty()` 重建 `.mb-dyn`，
       * 按钮 DOM 被换掉、旧按钮的 pointerup 永远等不到 → 连调只走一步。
       * 现在按「结构签名」判定：字号数值变化不进签名，走就地刷新，
       * 所以按钮节点能活过整个按住过程。
       */
      {
        const plus = dyn.querySelector(".mb-size-step-add") as HTMLElement | null;
        const minus = dyn.querySelector(".mb-size-step-sub") as HTMLElement | null;
        pass(
          !!plus && !!minus,
          "侧栏有色点行最左的 −/＋ 步进按钮"
        );
        if (plus && minus) {
          // 先归到一个干净起点
          view.editor!.setTextSize(20);
          await sleep(120);
          const stepNodeBefore = dyn.querySelector(".mb-size-step-add") as HTMLElement;
          const peStep = (t: string, id: number) =>
            stepNodeBefore.dispatchEvent(
              new PointerEvent(t, {
                bubbles: true,
                cancelable: true,
                button: 0,
                buttons: t === "pointerup" ? 0 : 1,
                pointerId: id,
                pointerType: "touch",
                isPrimary: true,
              })
            );
          // 按住不放：pointerdown 后等 700ms（够走 1 + 约 3 个连调步）
          peStep("pointerdown", 401);
          await sleep(700);
          const held = view.editor!.textSize;
          pass(
            held >= 23,
            "侧栏按住「＋」700ms 连续加：20 → " +
              held +
              "（应 ≥23，即至少走了 3 步）"
          );
          /*
           * 关键：按住期间**按钮节点没有被重建**（对象身份不变）。
           * 这是连调能持续的根因 —— 节点一换，pointerup 就等不到了。
           */
          pass(
            (dyn.querySelector(".mb-size-step-add") as HTMLElement) === stepNodeBefore,
            "按住期间步进按钮节点没被重建（DOM 身份不变，连调不断）"
          );
          peStep("pointerup", 401);
          await sleep(200);
          const settled = view.editor!.textSize;
          await sleep(400);
          pass(
            view.editor!.textSize === settled,
            "松手后连调停住：停在 " + settled + "（400ms 后没有再变）"
          );
        }
      }

      // 平板：色点放大到 ≥22px 触摸目标（CSS 用 .mb-root.is-tablet 区分）
      root.classList.add("is-tablet");
      await sleep(30);
      const tabletDot = dyn.querySelector(".mb-tcolor") as HTMLElement;
      pass(
        tabletDot.getBoundingClientRect().width >= 22,
        "平板色点 ≥22px 可点（" + tabletDot.getBoundingClientRect().width + "px）"
      );

      /*
       * 平板：字号框不许把色点挤出屏幕（INK-160）。
       *
       * 用户原话：「自定义字体大小框占满了一整行，导致后面的颜色啥的
       * 都挤到屏幕外面去了」。
       *
       * 判据用**真实 DOM rect**：每个色点的右边缘都必须落在侧栏内容区
       * 的右边缘之内（不是算宽度，是量位置）—— 这才对应「看得见、点得到」。
       * 顺带验字号框没占满一整行（宽度上限），以及色点仍在一行内
       * （没被挤成竖排，那是 INK-154 修过的退步）。
       */
      {
        const sideBody2 = view.sideEl.querySelector(".mb-side-body") as HTMLElement;
        const bRect2 = sideBody2.getBoundingClientRect();
        const cs2 = getComputedStyle(sideBody2);
        const contentRight2 =
          bRect2.left + sideBody2.clientLeft + sideBody2.clientWidth - parseFloat(cs2.paddingRight);
        const tabletDots = [...dyn.querySelectorAll(".mb-tcolor")] as HTMLElement[];
        const dotRights = tabletDots.map((d) => d.getBoundingClientRect().right);
        const overflowDots = dotRights.filter((r) => r > contentRight2 + 0.5);
        pass(
          overflowDots.length === 0,
          "平板：8 个色点全在侧栏内容区内（最右 " +
            Math.max(...dotRights).toFixed(1) +
            " / 内容区右缘 " +
            contentRight2.toFixed(1) +
            "，溢出 " +
            overflowDots.length +
            " 个）"
        );
        const sizeIn2 = dyn.querySelector(".mb-size-in") as HTMLElement | null;
        pass(
          !!sizeIn2 && sizeIn2.getBoundingClientRect().width <= 36,
          "平板：字号框不占满一整行（宽 " +
            (sizeIn2 ? sizeIn2.getBoundingClientRect().width.toFixed(1) : "缺失") +
            "px ≤ 36px）"
        );
        const tabletTops = [
          ...new Set(tabletDots.map((d) => Math.round(d.getBoundingClientRect().top))),
        ];
        pass(
          tabletTops.length === 1,
          "平板：色点仍在一行内（没被挤成竖排，top 档数 " + tabletTops.length + "）"
        );
      }

      root.classList.remove("is-tablet");
      await sleep(30);
    }

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

    /*
     * 滑杆跨入口同步（2026-11-07 修的真回归）：
     * 加了「结构签名」之后，签名不变就不再重建 DOM —— 于是所有靠
     * 重建时才刷的显示值都必须就地补刷，否则会停在旧值。
     * 这里从**笔盒**（buildSide 的静态按钮）改粗细，然后看 `.mb-dyn`
     * 里的滑杆与数值标签是否跟着变。
     */
    {
      view.editor!.setTool("pen");
      await sleep(80);
      const dynEl2 = root.querySelector(".mb-sec-dyn .mb-dyn") as HTMLElement | null;
      const rangeEl = dynEl2?.querySelector(".mb-range") as HTMLInputElement | null;
      const lblEl = dynEl2?.querySelector(".mb-size-lbl") as HTMLElement | null;
      pass(!!rangeEl && !!lblEl, "钢笔工具区有粗细滑杆与数值标签");
      if (rangeEl && lblEl) {
        // 模拟「笔盒点粗」：直接走 editor 的 setter（会 emitState）
        const PEN_SIZES_LOCAL = [1.6, 2.8, 4.6]; // 与 types.ts 的 PEN_SIZES 一致
        view.editor!.setPenSize(PEN_SIZES_LOCAL[2]);
        await sleep(200);
        pass(
          Math.abs(Number(rangeEl.value) - PEN_SIZES_LOCAL[2]) < 0.11,
          "外部改钢笔粗细后滑杆跟着刷新（滑杆 " +
            rangeEl.value +
            "，期望 " +
            PEN_SIZES_LOCAL[2] +
            "）"
        );
        pass(
          lblEl.textContent === String(Math.round(PEN_SIZES_LOCAL[2] * 10) / 10),
          "外部改钢笔粗细后数值标签跟着刷新（" + lblEl.textContent + "）"
        );
      }
    }
  }

  /* ============ 13. 搜索 / 链接跳转后的落点提示 ============ */
  /*
   * 全局搜索只给插件文件路径，拿不到命中行号和搜索词，无法高亮具体文字。
   * 这里验证换的思路：从索引页跳进某一页后，目标页本身要有可观察的
   * 落点标记（页面级高亮 + 「已跳到第 N 页」），而且：
   *   · 只是视觉提示：跳转语义不变、页面数据不变、不拦指针；
   *   · 约 2 秒自动消失，不在页面上留垃圾节点；
   *   · 设置里可以关掉。
   * 调用链与「全局搜索点索引页」一致：
   *   file-open → openBookAt → view.gotoPageFromLink(页码)
   */
  {
    const pagesBefore = JSON.stringify(view.store!.data.pages);

    view.gotoPageFromLink(2);
    await sleep(80);
    const located = Array.from(
      root.querySelectorAll(".mb-page-wrap.is-located")
    ) as HTMLElement[];
    const hint = located[0]?.querySelector(".mb-locate-hint") as HTMLElement | null;
    pass(
      located.length === 1 && located[0]?.dataset.page === "1",
      "跳到第 2 页后只有目标页带落点高亮（" + located.length + " 页）"
    );
    pass(
      hint?.textContent?.includes("第 2 页") === true,
      "目标页浮出「已跳到第 2 页」定位标记：" + (hint?.textContent || "无")
    );
    pass(
      hint ? getComputedStyle(hint).pointerEvents === "none" : false,
      "落点标记不拦指针（pointer-events:none，平板可继续落笔）"
    );
    pass(
      view.editor!.getState().pageIndex === 1 &&
        JSON.stringify(view.store!.data.pages) === pagesBefore,
      "落点提示不改变跳转语义与页面数据（仍落在第 2 页，book 不变）"
    );

    await sleep(2000);
    pass(
      root.querySelectorAll(".mb-page-wrap.is-located").length === 0 &&
        !root.querySelector(".mb-locate-hint"),
      "约 2 秒后落点提示自动消失（class 与标记都摘干净）"
    );

    (view as any).plugin.settings.jumpHint = false;
    view.gotoPageFromLink(3);
    await sleep(80);
    pass(
      root.querySelectorAll(".mb-page-wrap.is-located").length === 0 &&
        !root.querySelector(".mb-locate-hint"),
      "设置关掉「跳转后轻提示落点」后，跳转不再出现任何标记"
    );
    (view as any).plugin.settings.jumpHint = true;
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
