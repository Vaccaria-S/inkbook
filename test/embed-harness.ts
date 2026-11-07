/**
 * 笔记内嵌入（INK-105）测试。
 *
 * 这个套件守住四件在真机上真的会坏的事：
 *   1. 链接写法（`#3` / `|300` / 带路径 / 写错）解析得对——用户手一抖就写成 `#abc`；
 *   2. 一页真的画出了笔迹和批注（不是一张白纸），尺寸按 `|宽` 且按 dpr 放大；
 *   3. 同一本子只读一次（一篇笔记里十个嵌入不能解析十遍几十 MB 的 JSON），
 *      本子一改（invalidate）就能重读；
 *   4. postprocessor 端到端：默认第 1 页、`#3` 第 3 页、`|300` 生效、
 *      找不到文件只是占位不抛错、点一下落到链接里写的那一页。
 *
 * 手工构造 `.internal-embed` DOM + 假 ctx 直接调用注册进去的回调，
 * 不依赖 Obsidian 的真实渲染时机（那东西在无头浏览器里等不到）。
 */
import {
  clampEmbedWidth,
  clampPageIndex,
  disposeEmbeds,
  embedCacheStats,
  embedDisplayWidth,
  embedDpr,
  invalidateEmbedCache,
  isInkbookEmbed,
  parseEmbedSrc,
  maxCssWidthForDpr,
  readEmbedTarget,
  refreshEmbedsForPath,
  registerEmbed,
  renderEmbedForFile,
  renderEmbedPage,
  setEmbedContext,
  type EmbedFile,
  type EmbedHost,
} from "../src/embed";
import { createBook, createPage, type InkBook, type Stroke } from "../src/types";

const lines: string[] = [];
const out = document.getElementById("out")!;
const log = (s: string) => {
  lines.push(s);
  out.textContent = lines.join("\n");
};
let failures = 0;
const pass = (ok: boolean, label: string) => {
  if (!ok) failures += 1;
  log((ok ? "PASS " : "FAIL ") + label);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
window.addEventListener("error", (e) => log("ERROR " + e.message));
window.addEventListener("unhandledrejection", (e) => log("REJECT " + (e.reason?.stack || e.reason)));

/** 数一张 canvas 里的深色像素（笔迹 / 文字），纸张底色和网格线不算 */
function darkCount(canvas: HTMLCanvasElement, limit = 200): number {
  return darkCountRegion(canvas, 0, 0, canvas.width, canvas.height, limit);
}

/**
 * 只数一块区域里的深色像素。
 *
 * 大图（|2000 → 2000×2828）整张 getImageData 是 22MB 的临时缓冲，
 * dpr=2 时更狠；查"有没有画出笔迹"只需要看笔迹所在的那一角。
 */
function darkCountRegion(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
  limit = 200
): number {
  const ctx = canvas.getContext("2d");
  if (!ctx) return -1;
  const sx = Math.max(0, Math.min(canvas.width - 1, Math.round(x)));
  const sy = Math.max(0, Math.min(canvas.height - 1, Math.round(y)));
  const sw = Math.max(1, Math.min(canvas.width - sx, Math.round(w)));
  const sh = Math.max(1, Math.min(canvas.height - sy, Math.round(h)));
  const d = ctx.getImageData(sx, sy, sw, sh).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 0 && d[i] < limit && d[i + 1] < limit && d[i + 2] < limit) n += 1;
  }
  return n;
}

/**
 * 遍历样式表里的规则（含 @media 内的）。
 *
 * 无头浏览器不能合成 :hover，只能退一步直接读规则——配合"未 hover 时
 * computed opacity = 0"一起断言，效果等同。
 */
function findCssRules(
  pred: (selectorText: string, style: CSSStyleDeclaration) => boolean
): CSSStyleRule[] {
  const out: CSSStyleRule[] = [];
  const walk = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      const anyRule = rule as any;
      if (typeof anyRule.selectorText === "string" && anyRule.style) {
        if (pred(anyRule.selectorText as string, anyRule.style as CSSStyleDeclaration)) {
          out.push(rule as CSSStyleRule);
        }
      }
      if (anyRule.cssRules) walk(anyRule.cssRules as CSSRuleList);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch (_) {
      rules = null; // 跨域样式表拿不到规则，跳过
    }
    if (rules) walk(rules);
  }
  return out;
}

/** 第 1 页的笔迹落在这一角（页面坐标 80–540 × 140–340），按 canvas 比例换算 */
function strokeRegion(canvas: HTMLCanvasElement): [number, number, number, number] {
  const k = canvas.width / 794;
  return [40 * k, 100 * k, 560 * k, 320 * k];
}

function centerPixel(canvas: HTMLCanvasElement): [number, number, number] {
  const ctx = canvas.getContext("2d");
  if (!ctx) return [-1, -1, -1];
  const d = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
  return [d[0], d[1], d[2]];
}

/** 第 1 页有一条手写笔迹；第 2 页空白；第 3 页只有一段批注 */
function makeBook(): InkBook {
  const book = createBook("嵌入测试本", "blank", "white");
  book.pages = [];

  const p1 = createPage("blank", "white");
  const stroke: Stroke = {
    id: "s1",
    tool: "pen",
    color: "#1A1A1A",
    size: 9,
    opacity: 1,
    points: [
      [80, 160, 0.6],
      [200, 150, 0.7],
      [320, 190, 0.8],
      [430, 280, 0.9],
      [540, 330, 0.7],
    ],
  };
  p1.layers[0].strokes.push(stroke);
  book.pages.push(p1);

  book.pages.push(createPage("blank", "white"));

  const p3 = createPage("blank", "white");
  p3.texts = [
    { id: "t1", source: "user", x: 60, y: 140, size: 30, text: "嵌入批注", color: "#1A1A1A" },
  ];
  book.pages.push(p3);

  return book;
}

const BOOK_JSON = JSON.stringify(makeBook());

/** 假宿主：记录 readBook 调用次数、metadataCache 解析、点击打开的页 */
function makeFakeApp() {
  const files: Record<string, string> = {
    "缓存本.inkbook": BOOK_JSON,
    // 第二本：用于验证"只重画目标 path，别的块不动"
    "另一本.inkbook": BOOK_JSON,
    // 坏文件：故意不是完整 JSON（模拟同步中断 / 磁盘写一半）
    "坏文件.inkbook": '{ "kind": "inkbook", "pages": [',
  };
  const meta: Record<string, any> = {};
  for (const path of Object.keys(files)) {
    meta[path] = {
      path,
      basename: path.replace(/\.inkbook$/, ""),
      extension: "inkbook",
      stat: { mtime: 111 },
    };
  }

  let reads = 0;
  const adapter = {
    exists: async (p: string) => Object.prototype.hasOwnProperty.call(files, p),
    read: async (p: string) => {
      reads += 1;
      return files[p] ?? "";
    },
    getResourcePath: (p: string) => p,
  };

  const app = {
    vault: {
      adapter,
      getAbstractFileByPath: (p: string) => meta[p] ?? null,
      on: () => ({}),
    },
    metadataCache: {
      getFirstLinkpathDest: (linktext: string) =>
        Object.prototype.hasOwnProperty.call(meta, linktext) ? meta[linktext] : null,
    },
  };

  return { app, reads: () => reads, meta };
}

async function waitFor(pred: () => boolean, ms = 6000): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(50);
  }
  return pred();
}

async function main() {
  /* ========================= 1. 链接解析 ========================= */
  {
    const t1 = parseEmbedSrc("本子.inkbook");
    pass(
      t1.page === 1 && t1.width === null && t1.linktext === "本子.inkbook",
      "无参：第 1 页、不限定宽度 → " + JSON.stringify(t1)
    );

    const t2 = parseEmbedSrc("本子.inkbook#3");
    pass(
      t2.page === 3 && t2.width === null && t2.linktext === "本子.inkbook",
      "#3 → 第 3 页 → " + JSON.stringify(t2)
    );

    const t3 = parseEmbedSrc("本子.inkbook|300");
    pass(
      t3.width === 300 && t3.page === 1 && t3.linktext === "本子.inkbook",
      "|300 → 宽 300px、第 1 页 → " + JSON.stringify(t3)
    );

    const t4 = parseEmbedSrc("本子.inkbook#3|300");
    pass(
      t4.page === 3 && t4.width === 300 && t4.linktext === "本子.inkbook",
      "#3|300 → 第 3 页 + 宽 300px → " + JSON.stringify(t4)
    );

    const t5 = parseEmbedSrc("笔记/数学/本子.inkbook#7");
    pass(
      t5.linktext === "笔记/数学/本子.inkbook" && t5.page === 7,
      "带文件夹路径照样解析 → " + JSON.stringify(t5)
    );

    const t6 = parseEmbedSrc("本子.inkbook#abc|abc");
    pass(
      t6.page === 1 && t6.width === null && t6.linktext === "本子.inkbook",
      "#abc / |abc 当作没写（第 1 页、不限宽）→ " + JSON.stringify(t6)
    );

    const t7 = parseEmbedSrc("本子.inkbook#0|0");
    pass(t7.page === 1 && t7.width === null, "#0 / |0 也当作没写 → " + JSON.stringify(t7));

    const t8 = parseEmbedSrc("本子.inkbook|300x200");
    pass(t8.width === 300, "|300x200 只取宽度、不报错 → " + JSON.stringify(t8));

    /*
     * 文件名里带 `#`（INK-170）：以前见 `#` 就切，`C#笔记.inkbook`
     * 被切成「C」+「笔记.inkbook」，查不到文件，整块嵌入退化成占位符。
     */
    const t9 = parseEmbedSrc("C#笔记.inkbook");
    pass(
      t9.linktext === "C#笔记.inkbook" && t9.page === 1,
      "文件名自带 # 不被当成页码 → " + JSON.stringify(t9)
    );
    const t10 = parseEmbedSrc("C#笔记.inkbook#3");
    pass(
      t10.linktext === "C#笔记.inkbook" && t10.page === 3,
      "文件名带 # 且真的指定了页码 → " + JSON.stringify(t10)
    );
  }

  /* ========================= 2. DOM 侧读取 ========================= */
  {
    const node = document.createElement("div");
    node.className = "internal-embed";
    node.setAttribute("src", "本子.inkbook");
    // `#3` 有时被放进 data-src（Obsidian 不同版本行为不同）
    node.setAttribute("data-src", "本子.inkbook#3");
    const t = readEmbedTarget(node);
    pass(t.page === 3 && t.linktext === "本子.inkbook", "data-src 里的 #3 也能读到 → " + JSON.stringify(t));

    const upper = document.createElement("div");
    upper.className = "internal-embed";
    upper.setAttribute("src", "本子.INKBOOK#2|200");
    pass(isInkbookEmbed(upper), "扩展名忽略大小写，且带 #页/|宽 也认得");
    pass(readEmbedTarget(upper).page === 2 && readEmbedTarget(upper).width === 200, "大写扩展名的页/宽同样解析");

    const md = document.createElement("div");
    md.className = "internal-embed";
    md.setAttribute("src", "笔记.md");
    pass(!isInkbookEmbed(md), "普通 md 嵌入不归我们处理");
  }

  /* ========================= 3. 画一页 ========================= */
  const book = makeBook();
  const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
  {
    const c1 = await renderEmbedPage(book, 0, 300);
    pass(c1.style.width === "300px", "宽度 300 时 canvas 的 CSS 宽是 300px（实际 " + c1.style.width + "）");
    pass(
      Math.abs(c1.width - Math.round(300 * dpr)) <= 1,
      "内部按 dpr 放大：backing store " + c1.width + "px（dpr=" + dpr + "）"
    );
    pass(
      Math.abs(c1.height - Math.round((300 * 1123) / 794 * dpr)) <= 2,
      "高度按纸张比例 1123/794：" + c1.height + "px"
    );

    const dark1 = darkCount(c1);
    pass(dark1 > 30, "纯手写页画出了笔迹（深色像素 " + dark1 + "）");

    const c2 = await renderEmbedPage(book, 1, 300);
    pass(darkCount(c2) === 0, "空白页没有深色像素（" + darkCount(c2) + "），说明纸面线没被画黑");

    const c3 = await renderEmbedPage(book, 2, 300);
    pass(darkCount(c3) > 20, "批注页画出了文字（深色像素 " + darkCount(c3) + "）");

    const cOver = await renderEmbedPage(book, 99, 300);
    pass(cOver.dataset.page === "3", "页号越界时渲染最后一页（dataset.page=" + cOver.dataset.page + "）");
  }

  {
    pass(
      clampPageIndex(3, 99) === 2 && clampPageIndex(3, 1) === 0 && clampPageIndex(3, 2) === 1,
      "clampPageIndex：1 起页码 → 0 起下标，越界夹到最后一页"
    );
    pass(clampPageIndex(3, 0) === 0 && clampPageIndex(3, Number.NaN) === 0, "非法页码（0 / NaN）当第 1 页");
    pass(clampPageIndex(0, 5) === 0, "空本子不会算出负下标");
  }

  /* ========================= 4. 缓存 ========================= */
  const { app, reads, meta } = makeFakeApp();
  setEmbedContext(app as any);
  {
    invalidateEmbedCache();
    const file: EmbedFile = meta["缓存本.inkbook"];

    const a1 = await renderEmbedForFile(app as any, file, 1, 240);
    const a2 = await renderEmbedForFile(app as any, file, 1, 240);
    pass(reads() === 1, "同一路径连续渲染两次，readBook 只调用 1 次（实际 " + reads() + " 次）");
    pass(
      a2.canvas.width === a1.canvas.width && a2.canvas.height === a1.canvas.height,
      "第二屏走缓存，尺寸一致（" + a2.canvas.width + "×" + a2.canvas.height + "）"
    );
    pass(
      embedCacheStats().bitmaps >= 1,
      "位图进了缓存（条数 " + embedCacheStats().bitmaps + "，约 " +
        Math.round(embedCacheStats().bytes / 1024) + " KB）"
    );

    await renderEmbedForFile(app as any, file, 1, 300);
    pass(embedCacheStats().bitmaps === 2, "换宽度是另一条缓存（键里带宽度，条数 " + embedCacheStats().bitmaps + "）");

    const r99 = await renderEmbedForFile(app as any, file, 99, 240);
    pass(
      r99.actualPage === 3 && r99.clamped === true,
      "越界页码：actualPage=" + r99.actualPage + "、clamped=" + r99.clamped
    );

    invalidateEmbedCache("缓存本.inkbook");
    const st = embedCacheStats();
    pass(st.bitmaps === 0 && st.books === 0, "invalidateEmbedCache(path) 后缓存清空（位图 " + st.bitmaps + " / 书 " + st.books + "）");

    await renderEmbedForFile(app as any, file, 1, 240);
    pass(reads() === 2, "清缓存后重新读文件（readBook 第 " + reads() + " 次）");
  }

  /* ========================= 4b. 手写宽度的天花板（F1） ========================= */
  {
    const file: EmbedFile = meta["缓存本.inkbook"];
    const MB = 1024 * 1024;

    invalidateEmbedCache();
    const big = await renderEmbedForFile(app as any, file, 1, 3000);
    const bigW = parseFloat(big.canvas.style.width || "0");
    pass(bigW > 0 && bigW <= 2000, "|3000 出图宽被夹到 2000 以内（" + bigW + "px）");
    pass(
      big.canvas.width <= Math.round(2000 * dpr),
      "|3000 的 backing store 也受限（" + big.canvas.width + "px，dpr=" + dpr + "）"
    );
    const [rx, ry, rw, rh] = strokeRegion(big.canvas);
    const ink = darkCountRegion(big.canvas, rx, ry, rw, rh);
    pass(ink > 30, "|3000 没有白屏，笔迹照常画出（区域深色像素 " + ink + "）");

    const stBig = embedCacheStats();
    pass(
      stBig.bytes <= stBig.limit,
      "|3000 之后缓存不超预算（" + (stBig.bytes / MB).toFixed(1) + "MB / 上限 " +
        (stBig.limit / MB).toFixed(0) + "MB / " + stBig.bitmaps + " 条）"
    );

    invalidateEmbedCache();
    let err100k: any = null;
    let huge: HTMLCanvasElement | null = null;
    try {
      huge = (await renderEmbedForFile(app as any, file, 1, 100000)).canvas;
    } catch (e) {
      err100k = e;
    }
    const hugeW = huge ? parseFloat(huge.style.width || "0") : 0;
    const stHuge = embedCacheStats();
    pass(
      !err100k && !!huge && hugeW > 0 && hugeW <= 2000,
      "|100000 不抛异常，宽度同样夹到 2000 以内（" + hugeW + "px）"
    );
    pass(
      stHuge.bytes <= stHuge.limit,
      "|100000 之后缓存不超预算（" + (stHuge.bytes / MB).toFixed(1) + "MB / 上限 " +
        (stHuge.limit / MB).toFixed(0) + "MB）"
    );
    if (huge) {
      const [hx, hy, hw, hh] = strokeRegion(huge);
      const inkHuge = darkCountRegion(huge, hx, hy, hw, hh);
      pass(inkHuge > 30, "|100000 也没有白屏，笔迹照常画出（区域深色像素 " + inkHuge + "）");
    }

    /*
     * INK-117：4 张满栏嵌入（不同宽度）要能同时留在缓存里，
     * 滚回去不用重新光栅化。旧 32MB 预算下这里会淘汰到 2~3 条。
     * 同时仍要求缓存不超预算——evictBitmaps 不能保底「至少留一条」。
     */
    invalidateEmbedCache();
    for (const w of [1400, 1600, 1800, 2000]) {
      await renderEmbedForFile(app as any, file, 2, w);
    }
    const st4 = embedCacheStats();
    pass(
      st4.bytes <= st4.limit,
      "连续 4 张满栏嵌入后缓存仍不超预算（" + st4.bitmaps + " 条 / " +
        (st4.bytes / MB).toFixed(1) + "MB / 上限 " + (st4.limit / MB).toFixed(0) + "MB）"
    );
    pass(
      st4.bitmaps >= 4,
      "INK-117：4 张满栏嵌入能同时缓存，来回滚动不重画（" + st4.bitmaps + " 条）"
    );
    invalidateEmbedCache();
  }

  /* ========================= 4c. 上限按设备像素算（R1） ========================= */
  {
    const file: EmbedFile = meta["缓存本.inkbook"];
    const MB = 1024 * 1024;

    const w1 = clampEmbedWidth(2000, 600, 1);
    const w2 = clampEmbedWidth(2000, 600, 2);
    const w3 = clampEmbedWidth(2000, 600, 3);
    pass(w1 === 2000, "dpr=1：|2000 仍是 2000（桌面行为不变，实际 " + w1 + "）");
    pass(w2 <= 841 && w2 > 800, "dpr=2：|2000 折到 ≤841 CSS px（实际 " + w2 + "）");
    pass(w3 <= 561, "dpr=3：|2000 折到 ≤561 CSS px（实际 " + w3 + "）");
    pass(
      maxCssWidthForDpr(2) < maxCssWidthForDpr(1),
      "dpr 越高允许的 CSS 宽越小（dpr1=" + maxCssWidthForDpr(1) + " > dpr2=" + maxCssWidthForDpr(2) + "）"
    );

    /*
     * 模拟 dpr=2 的真机（平板）。devicePixelRatio 是只读访问器，
     * 在 window 上 defineProperty 一个自有属性就能覆盖它。
     */
    const originalDpr = window.devicePixelRatio;
    let patched = false;
    try {
      Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
      patched = window.devicePixelRatio === 2;
    } catch (_) {
      patched = false;
    }
    pass(patched, "测试环境能把 devicePixelRatio 切成 2（否则下面几条没法验）");

    if (patched) {
      try {
        invalidateEmbedCache();
        const c = await renderEmbedPage(book, 0, 2000);
        const bytes = c.width * c.height * 4;
        pass(c.width <= 1682, "dpr=2 渲染 |2000：backing 宽 " + c.width + " px ≤ 1682");
        pass(
          bytes <= 16 * MB,
          "dpr=2 单张位图 ≤ 16MB（" + (bytes / MB).toFixed(1) + "MB，旧实现是 86MB）"
        );

        await renderEmbedForFile(app as any, file, 1, 2000);
        await renderEmbedForFile(app as any, file, 3, 2000);
        const st = embedCacheStats();
        pass(
          st.bitmaps >= 2,
          "dpr=2 的 |2000 位图能缓存 ≥2 条，不再画完即弃（实际 " +
            st.bitmaps + " 条 / " + (st.bytes / MB).toFixed(1) + "MB）"
        );
        pass(
          st.bytes <= st.limit,
          "dpr=2 两张之后缓存仍不超预算（" + (st.bytes / MB).toFixed(1) + "MB / 上限 " +
            (st.limit / MB).toFixed(0) + "MB）"
        );
      } finally {
        invalidateEmbedCache();
      }
      try {
        Object.defineProperty(window, "devicePixelRatio", { value: originalDpr, configurable: true });
      } catch (_) {
        /* 还原失败不影响后续（后续断言用显式 dpr） */
      }
    }
  }

  /* ========================= 5. postprocessor 端到端 ========================= */
  const opened: Array<{ path: string; page: number; opts?: { newTab?: boolean } }> = [];
  const callbacks: Array<(el: HTMLElement, ctx: any) => void> = [];
  const host: EmbedHost = {
    app: app as any,
    registerMarkdownPostProcessor: (cb: (el: HTMLElement, ctx: any) => void) => {
      callbacks.push(cb);
      return { unregister() {} };
    },
    openBookAt: (path: string, page: number, opts?: { newTab?: boolean }) => {
      opened.push({ path, page, opts });
      return Promise.resolve();
    },
  };

  registerEmbed(host);
  pass(callbacks.length === 1, "registerEmbed 注册了 1 个 markdown postprocessor");

  const ppHost = document.getElementById("pp-host")!;
  const cells = new Map<string, HTMLElement>();
  const addNode = (key: string, src: string, dataSrc?: string) => {
    const cell = document.createElement("div");
    cell.className = "cell";
    const node = document.createElement("div");
    node.className = "internal-embed";
    node.setAttribute("src", src);
    if (dataSrc) node.setAttribute("data-src", dataSrc);
    cell.appendChild(node);
    ppHost.appendChild(cell);
    cells.set(key, node);
    return node;
  };

  const nDefault = addNode("default", "缓存本.inkbook");
  const nPage3 = addNode("page3", "缓存本.inkbook#3");
  const nWidth = addNode("width", "缓存本.inkbook|300");
  const nMissing = addNode("missing", "不存在.inkbook");
  const nMd = addNode("md", "普通笔记.md");
  const nOver = addNode("over", "缓存本.inkbook#99");
  const nBroken = addNode("broken", "坏文件.inkbook");

  const ctx = { sourcePath: "笔记/入口.md" };
  let threw = false;
  try {
    callbacks[0](ppHost, ctx);
  } catch (e) {
    threw = true;
    log("抛出异常：" + (e as any)?.stack);
  }
  pass(!threw, "渲染整段不抛错（含找不到文件 / 坏文件 / 普通 md 嵌入）");

  pass(
    ppHost.querySelectorAll(".mb-embed").length === 6,
    "6 个 .inkbook 嵌入都挂上了容器（实际 " + ppHost.querySelectorAll(".mb-embed").length + "）"
  );
  pass(!nMd.querySelector(".mb-embed"), "普通 md 嵌入没被我们接管");
  pass(
    !!nMissing.querySelector(".mb-embed-ph-err") &&
      (nMissing.textContent || "").indexOf("找不到本子") >= 0,
    "找不到文件时显示占位文字：" + (nMissing.textContent || "").trim()
  );

  const canvasIn = (node: HTMLElement) => node.querySelector(".mb-embed-canvas") as HTMLCanvasElement | null;

  // 4 张：默认、#3、|300、#99（找不到文件 / 坏文件 / 普通 md 都不出图）
  const rendered = await waitFor(() => ppHost.querySelectorAll(".mb-embed-canvas").length >= 4);
  pass(rendered, "进入视口后渲染出位图（canvas " + ppHost.querySelectorAll(".mb-embed-canvas").length + " 张）");

  const cDefault = canvasIn(nDefault);
  pass(!!cDefault && cDefault.dataset.page === "1", "默认渲染第 1 页（dataset.page=" + cDefault?.dataset.page + "）");
  pass(
    !!cDefault && parseFloat(cDefault.style.width || "0") > 0,
    "不写宽度时按栏宽出图（CSS 宽 " + cDefault?.style.width + "）"
  );

  const cPage3 = canvasIn(nPage3);
  pass(!!cPage3 && cPage3.dataset.page === "3", "#3 渲染第 3 页（dataset.page=" + cPage3?.dataset.page + "）");
  pass(darkCount(cPage3!) > 20, "#3 这一页画出了批注（深色像素 " + (cPage3 ? darkCount(cPage3) : -1) + "）");

  const cWidth = canvasIn(nWidth);
  pass(!!cWidth && cWidth.style.width === "300px", "|300 生效（CSS 宽 " + cWidth?.style.width + "）");

  const cOver = canvasIn(nOver);
  const overEmbed = nOver.querySelector(".mb-embed") as HTMLElement;
  const badge = nOver.querySelector(".mb-embed-badge") as HTMLElement | null;
  pass(
    !!cOver && cOver.dataset.page === "3" && !!badge && (badge.textContent || "").indexOf("第 3 页") >= 0,
    "越界页码显示最后一页并标注真实页码：" + (badge?.textContent || "(无角标)")
  );
  pass(
    !!badge &&
      (badge.textContent || "").indexOf("共 3 页") >= 0 &&
      badge.classList.contains("is-clamped") &&
      getComputedStyle(badge).opacity === "1",
    "越界时角标常显（opacity=" + (badge ? getComputedStyle(badge).opacity : "?") +
      "）且文案说明总页数：" + (badge?.textContent || "")
  );
  pass(
    overEmbed.classList.contains("is-clamped") &&
      overEmbed.dataset.inkbookClamped === "1" &&
      overEmbed.dataset.inkbookPage === "3",
    "越界状态同时写在容器上（is-clamped + data-inkbook-clamped=1 + data-inkbook-page=3）"
  );

  const normalEmbed = nDefault.querySelector(".mb-embed") as HTMLElement;
  const normalBadge = nDefault.querySelector(".mb-embed-badge") as HTMLElement | null;
  pass(
    !!normalBadge &&
      (normalBadge.textContent || "") === "第 1 页" &&
      getComputedStyle(normalBadge).opacity === "0",
    "非越界角标默认隐藏（opacity=" + (normalBadge ? getComputedStyle(normalBadge).opacity : "?") +
      "、文案 " + (normalBadge?.textContent || "") + "）"
  );
  pass(
    !normalEmbed.classList.contains("is-clamped") &&
      normalEmbed.dataset.inkbookClamped === "0" &&
      normalEmbed.dataset.inkbookPage === "1",
    "非越界容器标记为 clamped=0 / page=1"
  );

  /*
   * hover 才显示：无头浏览器没法合成 :hover（touch-run.mjs 就是为此才走
   * CDP 派发真实触摸），所以这里把样式表里的 hover 规则读出来断言，
   * 加上面那条"未 hover 时 opacity=0"，两头都钉住。
   */
  const badgeHoverRules = findCssRules(
    (sel) => sel.indexOf(":hover") >= 0 && sel.indexOf(".mb-embed-badge") >= 0
  );
  pass(
    badgeHoverRules.length > 0 &&
      badgeHoverRules.some((r) => parseFloat(r.style.opacity || "0") > 0),
    "存在 .mb-embed:hover .mb-embed-badge 的显形规则（" + badgeHoverRules.length + " 条）"
  );

  const brokenErr = await waitFor(() => !!nBroken.querySelector(".mb-embed-ph-err"));
  pass(brokenErr, "坏文件只显示占位、不抛错：" + (nBroken.textContent || "").trim());

  /* 重复触发 postprocessor 不该重复插入 */
  const before = ppHost.querySelectorAll(".mb-embed").length;
  callbacks[0](ppHost, ctx);
  pass(
    ppHost.querySelectorAll(".mb-embed").length === before &&
      ppHost.querySelectorAll(".mb-embed-canvas").length === 4,
    "postprocessor 再次触发是幂等的（容器 " + ppHost.querySelectorAll(".mb-embed").length +
      " 个、canvas " + ppHost.querySelectorAll(".mb-embed-canvas").length + " 张）"
  );

  /* ============ 5a. 点击落点：默认替换当前 leaf，修饰键开新 tab（①） ============ */
  const clickable = nPage3.querySelector(".mb-embed") as HTMLElement;
  clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  pass(
    opened.length === 1 &&
      opened[0].path === "缓存本.inkbook" &&
      opened[0].page === 3 &&
      opened[0].opts === undefined,
    "默认点击：openBookAt(路径, 页) 不带 newTab（替换当前 leaf）→ " +
      JSON.stringify(opened[0] || null)
  );

  clickable.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })
  );
  pass(
    opened.length === 2 && opened[1].opts?.newTab === true,
    "Ctrl+点击 → newTab 开新标签页 → " + JSON.stringify(opened[1] || null)
  );

  clickable.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true })
  );
  pass(
    opened.length === 3 && opened[2].opts?.newTab === true,
    "Cmd+点击 → newTab → " + JSON.stringify(opened[2] || null)
  );

  // 中键在浏览器里走 auxclick（click 收不到），一律当"另开"
  clickable.dispatchEvent(
    new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })
  );
  pass(
    opened.length === 4 && opened[3].opts?.newTab === true,
    "中键（auxclick button=1）→ newTab → " + JSON.stringify(opened[3] || null)
  );

  // 右键（auxclick button=2）不是"打开"
  clickable.dispatchEvent(
    new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 })
  );
  pass(
    opened.length === 4,
    "右键（auxclick button=2）不打开（调用次数仍是 " + opened.length + "）"
  );

  clickable.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
  );
  pass(
    opened.length === 5 && opened[4].page === 3 && opened[4].opts === undefined,
    "回车键同样能打开那一页（就地替换，不带 newTab）→ " +
      JSON.stringify(opened[4] || null)
  );

  /* 点击失败路径不该调 openBookAt（没有文件就没有目标） */
  (nMissing.querySelector(".mb-embed") as HTMLElement).dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true })
  );
  pass(opened.length === 5, "找不到文件时点击不会去打开（调用次数仍是 " + opened.length + "）");

  /* ============ 5b. 真实布局：|3000 的天花板 + 边框不越栏（F1 / F2） ============ */
  {
    /*
     * 单独一块布局夹具，宽度 200、**content-box**：
     * 模拟"宿主没给全局 border-box"的环境（主题/版本/别的插件都可能改）。
     * 我们的 .mb-embed 自己写死 border-box 之后，整块和 canvas 都不该
     * 越过容器右缘。
     */
    const geoHost = document.createElement("div");
    geoHost.id = "pp-geo";
    geoHost.style.cssText =
      "position:fixed;left:0;top:0;width:200px;box-sizing:content-box;display:block";
    document.body.appendChild(geoHost);

    const mkNode = (src: string): HTMLElement => {
      const n = document.createElement("div");
      n.className = "internal-embed";
      n.setAttribute("src", src);
      geoHost.appendChild(n);
      return n;
    };
    const nGeoDefault = mkNode("缓存本.inkbook");
    const nGeoBig = mkNode("缓存本.inkbook|3000");

    callbacks[0](geoHost, ctx);
    const geoReady = await waitFor(() => geoHost.querySelectorAll(".mb-embed-canvas").length >= 2);
    pass(geoReady, "布局夹具里的 2 个嵌入都渲染出来了");

    const embedEl = nGeoDefault.querySelector(".mb-embed") as HTMLElement;
    const canvasEl = nGeoDefault.querySelector(".mb-embed-canvas") as HTMLCanvasElement;
    const hostRect = geoHost.getBoundingClientRect();
    // 前提自检：边框真的生效（缺主题变量时 border 会整条失效，"不越栏"会变成假绿）
    pass(
      getComputedStyle(embedEl).borderLeftWidth === "1px",
      "前提：.mb-embed 的 1px 边框确实生效（" + getComputedStyle(embedEl).borderLeftWidth + "）"
    );
    pass(
      getComputedStyle(embedEl).boxSizing === "border-box",
      ".mb-embed 自己声明了 border-box（不依赖宿主全局样式，实际 " +
        getComputedStyle(embedEl).boxSizing + "）"
    );
    pass(
      embedEl.getBoundingClientRect().right <= hostRect.right + 0.5,
      "嵌入块不越出栏宽（块右缘 " + embedEl.getBoundingClientRect().right.toFixed(1) +
        " ≤ 栏右缘 " + hostRect.right.toFixed(1) + "）"
    );
    pass(
      canvasEl.getBoundingClientRect().right <= hostRect.right + 0.5,
      "canvas 右缘不越出栏（" + canvasEl.getBoundingClientRect().right.toFixed(1) +
        " ≤ " + hostRect.right.toFixed(1) + "）"
    );
    pass(
      Math.abs(canvasEl.getBoundingClientRect().width - embedEl.clientWidth) <= 1,
      "canvas 宽度 = 容器内容宽（" + canvasEl.getBoundingClientRect().width.toFixed(1) +
        " vs " + embedEl.clientWidth + "）"
    );

    const geoCanvas = nGeoBig.querySelector(".mb-embed-canvas") as HTMLCanvasElement;
    const geoW = parseFloat(geoCanvas.style.width || "0");
    pass(
      geoW > 0 && geoW <= 2000,
      "|3000 在真实布局里出图宽也夹到 2000 以内（" + geoW + "px）"
    );
    pass(
      embedCacheStats().bytes <= embedCacheStats().limit,
      "|3000 走完 postprocessor 后缓存仍不超预算（" +
        (embedCacheStats().bytes / 1024 / 1024).toFixed(1) + "MB / 上限 " +
        (embedCacheStats().limit / 1024 / 1024).toFixed(0) + "MB）"
    );

    geoHost.remove();
    invalidateEmbedCache();
  }

  /* ============ 5c. 本子保存后：视口内自动重画 + 1.5s 防抖（②） ============ */
  {
    const refreshHost = document.createElement("div");
    refreshHost.style.cssText =
      "position:fixed;left:220px;top:0;width:360px;display:flex;gap:6px;z-index:5";
    document.body.appendChild(refreshHost);

    // 放到视口外（6000px 下方）：可见性判定应当把它跳过
    const farHost = document.createElement("div");
    farHost.style.cssText = "position:absolute;left:0;top:6000px;width:120px;display:block";
    document.body.appendChild(farHost);

    const mkEmbed = (parent: HTMLElement, src: string): HTMLElement => {
      const n = document.createElement("div");
      n.className = "internal-embed";
      n.setAttribute("src", src);
      n.style.cssText = "display:block;width:110px";
      parent.appendChild(n);
      return n;
    };

    const rA = mkEmbed(refreshHost, "缓存本.inkbook");
    const rB = mkEmbed(refreshHost, "缓存本.inkbook#3");
    const rOther = mkEmbed(refreshHost, "另一本.inkbook");
    const rFar = mkEmbed(farHost, "缓存本.inkbook");

    callbacks[0](refreshHost, ctx);
    callbacks[0](farHost, ctx);

    const ready = await waitFor(
      () => refreshHost.querySelectorAll(".mb-embed-canvas").length >= 3
    );
    pass(
      ready,
      "刷新夹具：视口内的 3 个嵌入已渲染（" +
        refreshHost.querySelectorAll(".mb-embed-canvas").length + " 张）"
    );

    const canvasOf = (n: HTMLElement) =>
      n.querySelector(".mb-embed-canvas") as HTMLCanvasElement | null;
    const beforeA = canvasOf(rA);
    const beforeB = canvasOf(rB);
    const beforeOther = canvasOf(rOther);
    const farBefore = canvasOf(rFar);

    /*
     * 数"新增 canvas"的次数：防抖生效的话，一轮每个块只换一次。
     * 只盯 refreshHost：ppHost 里也挂着同一本书的 4 个嵌入（同样会被
     * 重画，那是对的），统计整个 document 会把它们算进来。
     */
    let addedCanvases = 0;
    const mo = new MutationObserver((recs) => {
      for (const rec of recs) {
        rec.addedNodes.forEach((nd) => {
          if ((nd as HTMLElement).classList?.contains("mb-embed-canvas")) addedCanvases += 1;
        });
      }
    });
    mo.observe(refreshHost, { childList: true, subtree: true });

    const readsBefore = reads();
    // 300ms 内连发 5 次（自动保存一次会连着触发好几条 modify）
    for (let i = 0; i < 5; i += 1) {
      refreshEmbedsForPath("缓存本.inkbook");
      await sleep(60);
    }
    await sleep(2300);
    mo.disconnect();

    const afterA = canvasOf(rA);
    const afterB = canvasOf(rB);
    pass(
      !!afterA && !!afterB && afterA !== beforeA && afterB !== beforeB,
      "视口内的 2 个同路径嵌入被重画（canvas 换成了新元素）"
    );
    pass(
      addedCanvases === 2,
      "防抖生效：5 次 modify 只重画一轮（refreshHost 内新增 canvas " +
        addedCanvases + " 张，期望 2）"
    );
    pass(
      canvasOf(rOther) === beforeOther,
      "不同路径的嵌入不受影响（canvas 仍是原来那张）"
    );
    pass(
      !farBefore && !canvasOf(rFar),
      "视口外的嵌入不提前光栅化（重画前后都没有 canvas）"
    );
    pass(
      reads() > readsBefore,
      "重画前清了缓存，确实重新读了本子（readBook " + readsBefore + " → " + reads() + "）"
    );
    const stRefresh = embedCacheStats();
    pass(
      stRefresh.bitmaps >= 1 && stRefresh.bytes <= stRefresh.limit,
      "重画后缓存重新填充且未超限（" + stRefresh.bitmaps + " 条 / " +
        (stRefresh.bytes / 1024 / 1024).toFixed(1) + "MB）"
    );

    refreshHost.remove();
    farHost.remove();
    invalidateEmbedCache();
  }

  /* ============ 5d. 越界角标 hover 覆盖（N1）+ 缺变量宿主的边框（R3） ============ */
  {
    const norm = (sel: string) => sel.replace(/\s+/g, " ").trim();
    const ruleOf = (sel: string): CSSStyleRule | undefined =>
      findCssRules((s) => norm(s) === sel)[0];

    /*
     * 这几个选择器只有 class 与伪类（没有 id / 元素），所以"特异性权重"
     * 用 class+伪类计数就够了。
     */
    const classWeight = (sel: string): number =>
      (sel.match(/\.[\w-]+/g) || []).length + (sel.match(/:(?!:)[\w-]+/g) || []).length;

    const hoverRule = ruleOf(".mb-embed:hover .mb-embed-badge");
    const clampedRule = ruleOf(".mb-embed-badge.is-clamped");
    const hoverClampedRule = ruleOf(".mb-embed:hover .mb-embed-badge.is-clamped");

    pass(
      !!hoverClampedRule && hoverClampedRule.style.opacity === "1",
      "存在 .mb-embed:hover .mb-embed-badge.is-clamped { opacity: 1 }（" +
        (hoverClampedRule ? hoverClampedRule.style.opacity : "缺失") + "）"
    );
    pass(
      !!hoverRule &&
        !!clampedRule &&
        !!hoverClampedRule &&
        classWeight(".mb-embed:hover .mb-embed-badge.is-clamped") >
          classWeight(".mb-embed:hover .mb-embed-badge") &&
        classWeight(".mb-embed:hover .mb-embed-badge.is-clamped") >
          classWeight(".mb-embed-badge.is-clamped"),
      "它的特异性（" + classWeight(".mb-embed:hover .mb-embed-badge.is-clamped") +
        "）压过 hover 规则（" +
        (hoverRule ? classWeight(".mb-embed:hover .mb-embed-badge") : "?") +
        "）与越界规则（" + (clampedRule ? classWeight(".mb-embed-badge.is-clamped") : "?") +
        "）→ hover 时越界角标仍然是 opacity: 1"
    );

    /*
     * 缺主题变量的宿主：把变量设成"保证无效值"，等价于宿主从未定义它。
     * 没有 fallback 时 border 会在计算值阶段整条失效（width 变 0、style 变 none）。
     */
    const bare = document.createElement("div");
    bare.style.setProperty("--background-modifier-border", "initial");
    const fake = document.createElement("div");
    fake.className = "mb-embed";
    bare.appendChild(fake);
    document.body.appendChild(bare);
    const cs = getComputedStyle(fake);
    pass(
      cs.borderLeftWidth === "1px" && cs.borderLeftStyle === "solid",
      "宿主缺 --background-modifier-border 时边框仍生效（" +
        cs.borderLeftWidth + " " + cs.borderLeftStyle + "）"
    );
    pass(
      cs.borderLeftColor !== "" && cs.borderLeftColor !== "rgba(0, 0, 0, 0)",
      "回退边框色不是全透明（" + cs.borderLeftColor + "）"
    );
    bare.remove();
  }

  /* ======== 5e. 显示宽 vs 位图宽：dpr 只夹位图、不夹排版（显示回退） ======== */
  {
    const MB = 1024 * 1024;
    /** 量测行（不判对错，只留数；与 QA 的量测页对得上） */
    const num = (label: string, text: string) => log("    " + label + "：" + text);
    /*
     * 这一节守的是 QA 实测出来的回退：dpr≥2 的设备（iPad / 手机 / Retina
     * Mac）在 1200px 宽的栏里，嵌入图右边空出 359px。原因不是尺寸算错，
     * 而是**显示宽和位图宽用了同一个夹取**——840 是内存预算，不该管排版。
     *
     * 夹具：1200px 一栏（QA 那张表用的档位）。无头视口只有 800px 宽，
     * 但固定定位的元素可以更宽，而 IntersectionObserver 只要有一点交叠
     * 就算"可见"，所以量得到；横排多格会跑出视口不渲染，故一格一格量。
     */
    const COL = 1200;
    const realDpr = Number(window.devicePixelRatio) || 1;

    /** 把真实 dpr 切成 wish（真机是只读访问器，defineProperty 覆盖最稳） */
    const setDpr = (wish: number): boolean => {
      try {
        Object.defineProperty(window, "devicePixelRatio", {
          configurable: true,
          get: () => wish,
        });
        return window.devicePixelRatio === wish;
      } catch (_) {
        return false;
      }
    };
    const restoreDpr = (): void => {
      try {
        Object.defineProperty(window, "devicePixelRatio", {
          configurable: true,
          value: realDpr,
        });
      } catch (_) {
        /* 还原失败不影响后续（后面的断言不再依赖真实 dpr） */
      }
    };

    /* 纯函数层先钉住两条宽度**不是**同一个东西 */
    pass(
      clampEmbedWidth(2000, 794, 2) === 840 && embedDisplayWidth(2000, 794) === 2000,
      "两条宽度分道：位图宽 clampEmbedWidth(2000,dpr2)=" + clampEmbedWidth(2000, 794, 2) +
        "，显示宽 embedDisplayWidth(2000)=" + embedDisplayWidth(2000, 794)
    );
    pass(
      embedDisplayWidth(3000, 794) === 2000 && embedDisplayWidth(0, 794) === 794,
      "显示宽仍受 MAX_EMBED_WIDTH=2000 兜底、非法值退回 fallback（" +
        embedDisplayWidth(3000, 794) + " / " + embedDisplayWidth(0, 794) + "）"
    );

    const columnHost = document.createElement("div");
    columnHost.id = "pp-wide";
    columnHost.style.cssText =
      "position:fixed;left:0;top:0;width:" + COL + "px;display:block;z-index:6";
    document.body.appendChild(columnHost);

    /** 在 1200px 栏里量一格：显示宽（真实布局）、style.width、backing、空隙 */
    const measureCase = async (src: string) => {
      columnHost.innerHTML = "";
      const node = document.createElement("div");
      node.className = "internal-embed";
      node.setAttribute("src", src);
      columnHost.appendChild(node);
      callbacks[0](columnHost, { sourcePath: "笔记/宽栏.md" });
      const ok = await waitFor(() => !!node.querySelector(".mb-embed-canvas"), 20000);
      const canvas = node.querySelector(".mb-embed-canvas") as HTMLCanvasElement | null;
      const cont = node.querySelector(".mb-embed") as HTMLElement | null;
      // 让 max-width:100% 的布局稳定下来再量
      await sleep(60);
      const rect = canvas ? canvas.getBoundingClientRect() : null;
      const contRect = cont ? cont.getBoundingClientRect() : null;
      return {
        ok,
        canvas,
        styleW: canvas ? parseFloat(canvas.style.width || "0") : 0,
        shownW: rect ? rect.width : 0,
        backing: canvas ? canvas.width : 0,
        bytes: canvas ? canvas.width * canvas.height * 4 : 0,
        gap: rect && contRect ? contRect.right - rect.right : -1,
        cache: embedCacheStats().bitmaps,
      };
    };

    const dpr2 = setDpr(2);
    pass(dpr2, "测试环境能把 devicePixelRatio 切成 2（模拟 iPad / Retina，否则这一节没法验）");

    if (dpr2) {
      try {
        /* ① dpr=2 + 栏宽 1200 + |2000：显示宽铺满栏，位图仍按 4M 预算夹 */
        invalidateEmbedCache();
        const a = await measureCase("缓存本.inkbook|2000");
        num(
          "dpr=2 |2000",
          `style.width=${a.styleW} 显示=${a.shownW.toFixed(1)} 空隙=${a.gap.toFixed(1)} ` +
            `backing=${a.backing} 单张=${(a.bytes / MB).toFixed(1)}MB 缓存=${a.cache}条`
        );
        pass(a.ok && !!a.canvas, "dpr=2 |2000：渲染出来了");
        pass(
          a.styleW !== 840 && a.styleW >= 1198,
          "dpr=2 |2000：canvas.style.width 不再被折成 840（实际 " + a.styleW + "px）"
        );
        pass(
          Math.abs(a.shownW - 1198) <= 1.5 && a.gap <= 2,
          "dpr=2 |2000：真实显示宽 ≈ 栏宽 1198（实际 " + a.shownW.toFixed(1) +
            "），右侧空隙 " + a.gap.toFixed(1) + "px（改之前是 359px）"
        );
        pass(
          a.backing === 1680,
          "dpr=2 |2000：backing 仍是 840×dpr2 = 1680（实际 " + a.backing + "）"
        );
        pass(
          a.bytes <= 16 * MB,
          "dpr=2 |2000：单张位图 ≤16MB（" + (a.bytes / MB).toFixed(1) + "MB）"
        );

        /* ② dpr=2 + |700：窄于预算上限，显示宽与位图宽都是 700 */
        invalidateEmbedCache();
        const b = await measureCase("缓存本.inkbook|700");
        num(
          "dpr=2 |700",
          `style.width=${b.styleW} 显示=${b.shownW.toFixed(1)} backing=${b.backing}`
        );
        pass(
          b.styleW === 700 && Math.abs(b.shownW - 700) <= 1,
          "dpr=2 |700：显示宽 700（" + b.shownW.toFixed(1) + "），style.width=" + b.styleW
        );
        pass(b.backing === 1400, "dpr=2 |700：backing = 700×2 = 1400（实际 " + b.backing + "）");

        /* ③ dpr=2：|2000 与 |1200 先后渲染 → 显示宽各按请求，位图共用 1 条缓存 */
        invalidateEmbedCache();
        const c1 = await measureCase("缓存本.inkbook|2000");
        const c2 = await measureCase("缓存本.inkbook|1200");
        num(
          "dpr=2 |2000 → |1200",
          `显示宽 ${c1.styleW} / ${c2.styleW}，真实 ${c1.shownW.toFixed(1)} / ${c2.shownW.toFixed(1)}，` +
            `backing ${c1.backing} / ${c2.backing}，缓存 ${c2.cache} 条`
        );
        pass(
          c1.styleW === 2000 && c2.styleW === 1200,
          "dpr=2：|2000 与 |1200 的显示宽各按自己的请求（" + c1.styleW + " / " + c2.styleW + "）"
        );
        pass(
          Math.abs(c1.shownW - 1198) <= 1.5 && Math.abs(c2.shownW - 1198) <= 1.5,
          "dpr=2：两者真实显示宽都铺满栏（" + c1.shownW.toFixed(1) + " / " + c2.shownW.toFixed(1) + "）"
        );
        pass(
          c1.backing === 1680 && c2.backing === 1680 && c2.cache === 1,
          "dpr=2：位图都夹到 840（backing " + c2.backing + "），只占 1 条缓存（" +
            c2.cache + " 条）——显示宽不进缓存键"
        );
        /*
         * 再验一层"确实命中缓存、而且没串用上一次的显示宽"：两张 canvas 的**笔迹**
         * 必须一模一样（同一份位图复制出来的）。只比尺寸比不出来——命中时忘了设
         * style.width 会静默沿用默认 100%，这类 bug 看不出痕迹；而中心像素在空白
         * 页上恒为白，也等于没比，所以取笔迹所在那一小块来比。
         */
        const inkBox = (cv: HTMLCanvasElement): [number, number, number, number] => {
          const [rx, ry, rw, rh] = strokeRegion(cv);
          const box = 300;
          return [rx + rw / 2 - box / 2, ry + rh / 2 - box / 2, box, box];
        };
        const ink1 = c1.canvas ? darkCountRegion(c1.canvas, ...inkBox(c1.canvas)) : -1;
        const ink2 = c2.canvas ? darkCountRegion(c2.canvas, ...inkBox(c2.canvas)) : -1;
        num("dpr=2 两次的笔迹像素", ink1 + " / " + ink2);
        pass(
          ink1 > 30 && ink1 === ink2,
          "dpr=2：|2000 与 |1200 的位图内容完全相同（笔迹像素 " + ink1 + " / " + ink2 +
            "）——命中缓存没重画，也没把上一次的显示宽串过来"
        );

        /* ⑤ embedDpr() 把真实 dpr 夹在 2：dpr=3 的真机走的是 dpr=2 那条路 */
        const dpr3 = setDpr(3);
        pass(dpr3 && embedDpr() === 2, "devicePixelRatio=3 时 embedDpr() 夹到 2（实际 " + embedDpr() + "）");
        invalidateEmbedCache();
        const d = await measureCase("缓存本.inkbook|2000");
        num(
          "dpr=3 的机器 |2000",
          `embedDpr=${embedDpr()} style.width=${d.styleW} backing=${d.backing} ` +
            `（公式 maxCssWidthForDpr(3)=${maxCssWidthForDpr(3)} 只是参考值，真机走不到）`
        );
        pass(
          d.backing === 1680 && d.styleW === 2000,
          "dpr=3 的机器：位图按 embedDpr()=2 出（backing " + d.backing +
            "，不是 maxCssWidthForDpr(3)=560 → 1120），显示宽仍是 " + d.styleW
        );
      } finally {
        invalidateEmbedCache();
      }
    }

    /* ④ dpr=1：桌面行为一个像素都不许变 */
    setDpr(1);
    invalidateEmbedCache();
    const e = await measureCase("缓存本.inkbook|2000");
    num(
      "dpr=1 |2000",
      `style.width=${e.styleW} 显示=${e.shownW.toFixed(1)} 空隙=${e.gap.toFixed(1)} backing=${e.backing}`
    );
    pass(
      e.styleW === 2000 && Math.abs(e.shownW - 1198) <= 1.5,
      "dpr=1 |2000：显示宽 1198（style.width=" + e.styleW + "、实际 " + e.shownW.toFixed(1) + "）"
    );
    pass(e.backing === 2000, "dpr=1 |2000：backing 仍是 2000（桌面行为不变，实际 " + e.backing + "）");

    restoreDpr();
    columnHost.remove();
    invalidateEmbedCache();
  }

  /* ========================= 6. 底图取不到 → 浅灰占位 ========================= */
  {
    const b1 = createBook("缺底图", "blank", "white");
    b1.pages[0].background = {
      src: "/test/根本没有这张图.png",
      sourceName: "x.png",
      sourcePage: 1,
      x: 0,
      y: 0,
      width: 794,
      height: 1123,
      kind: "word",
    };
    let err: any = null;
    let c1: HTMLCanvasElement | null = null;
    try {
      c1 = await renderEmbedPage(b1, 0, 200);
    } catch (e) {
      err = e;
    }
    const px = c1 ? centerPixel(c1) : [-1, -1, -1];
    pass(
      !err && !!c1 && px[0] > 200 && px[0] < 252,
      "静态底图丢了 → 画浅灰占位，不抛错（中心像素 " + px.join(",") + "）"
    );

    const b2 = createBook("缺PDF", "blank", "white");
    b2.pages[0].background = {
      pdf: { path: "/test/根本没有这份.pdf", page: 1 },
      sourceName: "x.pdf",
      sourcePage: 1,
      x: 0,
      y: 0,
      width: 794,
      height: 1123,
      kind: "pdf",
    };
    let err2: any = null;
    let c2: HTMLCanvasElement | null = null;
    try {
      c2 = await renderEmbedPage(b2, 0, 200);
    } catch (e) {
      err2 = e;
    }
    const px2 = c2 ? centerPixel(c2) : [-1, -1, -1];
    pass(
      !err2 && !!c2 && px2[0] > 200 && px2[0] < 252,
      "PDF 底图读不出来 → 浅灰占位、笔迹照常（中心像素 " + px2.join(",") + "）"
    );
  }

  disposeEmbeds();
  ppHost.innerHTML = "";

  log("");
  log(failures === 0 ? "ALL PASS" : failures + " FAILED");
  document.title = "DONE";
}

main().catch((e) => {
  log("FATAL " + (e?.stack || e));
  document.title = "FATAL";
});
