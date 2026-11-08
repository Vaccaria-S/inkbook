/**
 * 纸面模板渲染（src/paper.ts）的独立验证。
 *
 * 为什么值得单测：纸面是**视觉核心**，同一份绘制代码被屏幕、导出 PDF、
 * 笔记内嵌入三处共用。这里最容易出的不是崩溃，而是「三处各说各话」——
 * 屏幕上看着是网格，导出的 PDF 里却变成横线；或者导出矢量页时忘了
 * 关掉底色，把原文糊死。肉眼扫一遍看不出来，所以全部按像素/线条位置量。
 *
 * 覆盖：
 *   1. paperBackground()：3 种纸色各不相同、是合法颜色、未知值回落纯白；
 *   2. 6 种模板 × 3 种纸色都真的画出东西（blank 必须只有底色）；
 *   3. 每种模板的结构特征（线在哪、间距多少、点阵没有连线）；
 *   4. fill=false 不填底色（导出矢量叠加层用），背景 alpha = 0；
 *   5. scale 参数：导出 scale=2 时线条间距翻倍、位置仍是页面几何的两倍；
 *   6. **三处一致**：屏幕 renderRec / 导出 exportPageCanvas / 嵌入
 *      renderEmbedPage 的模板、纸色、宽高、线条位置逐项比对；
 *   7. 非 A4 尺寸（600×800）下三处仍然一致（防宽高被写死）；
 *   8. paintPaperPreview 的尺寸与内容。
 *
 * 三处比对刻意用**三条真实调用路径**，不直接调 drawPaper 冒充：
 * 把三个函数各自画出来的东西归一化到同一尺寸再比线条中心位置，
 * 任何一处传错模板/纸色/宽高都会在结构上露馅。
 */
import { drawPaper, paperBackground, paintPaperPreview } from "../src/paper";
import { BookEditor } from "../src/editor";
import { BookStore } from "../src/store";
import { renderEmbedPage } from "../src/embed";
import {
  createBook,
  createPage,
  PAPERS,
  TEMPLATES,
  type PaperId,
  type TemplateId,
} from "../src/types";

const lines: string[] = [];
const outEl = document.getElementById("out")!;
const log = (s: string) => {
  lines.push(s);
  outEl.textContent = lines.join("\n");
};
let failures = 0;
let checks = 0;
const pass = (ok: boolean, label: string) => {
  checks += 1;
  if (!ok) failures += 1;
  log((ok ? "PASS " : "FAIL ") + label);
};
/** 只报数字、不判定的观察项 */
const note = (label: string) => log("INFO " + label);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

window.addEventListener("error", (e) => log("ERROR " + e.message));
window.addEventListener("unhandledrejection", (e) =>
  log("REJECT " + ((e.reason && e.reason.stack) || e.reason))
);

const PAGE_W = 794;
const PAGE_H = 1123;
const TEMPLATE_IDS: TemplateId[] = TEMPLATES.map((t) => t.id);
const PAPER_IDS: PaperId[] = PAPERS.map((p) => p.id);
const NON_BLANK: TemplateId[] = TEMPLATE_IDS.filter((t) => t !== "blank");
/** 每种模板配一种纸色：三处比对时顺带验「纸色参数有没有传丢」 */
const PAPER_FOR: Record<TemplateId, PaperId> = {
  blank: "gray",
  lined: "white",
  grid: "cream",
  dotted: "gray",
  cornell: "cream",
  planner: "white",
};
/** 用于像素判定的「有墨」阈值：纸色与线色之间的通道差远大于它 */
const INK_TOL = 4;

/* ------------------------------- 像素工具 ------------------------------- */

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function hexRgb(hex: string): [number, number, number] {
  const s = String(hex).replace("#", "");
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

function hexOf(rgba: number[]): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return "#" + h(rgba[0]) + h(rgba[1]) + h(rgba[2]) + (rgba[3] === 255 ? "" : ` a=${rgba[3]}`);
}

interface Img {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}
interface Prof {
  /** 横向线条的中心行（页面坐标） */
  rows: number[];
  /** 纵向线条的中心列（页面坐标） */
  cols: number[];
  /** 非纸色像素总数 */
  ink: number;
  /** 单行最多的墨迹像素数（点阵靠它证明「没有连线」） */
  maxRow: number;
}

const imgCache = new WeakMap<HTMLCanvasElement, Img>();
const profCache = new WeakMap<HTMLCanvasElement, { bg: string; p: Prof }>();
const alphaCache = new WeakMap<HTMLCanvasElement, number>();

function invalidate(c: HTMLCanvasElement): void {
  imgCache.delete(c);
  profCache.delete(c);
  alphaCache.delete(c);
}

function imgOf(c: HTMLCanvasElement): Img {
  const hit = imgCache.get(c);
  if (hit) return hit;
  const ctx = c.getContext("2d")!;
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const img = { w: c.width, h: c.height, data: d.data };
  imgCache.set(c, img);
  return img;
}

/** 连续 >min 的计数行/列合成一个中心点（一条 1px 线通常就是 1 个） */
function runs(counts: Uint32Array, min: number): number[] {
  const res: number[] = [];
  let start = -1;
  for (let i = 0; i < counts.length; i += 1) {
    const on = counts[i] > min;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      res.push((start + i - 1) / 2);
      start = -1;
    }
  }
  if (start >= 0) res.push((start + counts.length - 1) / 2);
  return res;
}

/**
 * 一次扫描出「线条位置 + 墨迹总量」。
 *
 * 行/列超过自身长度一半才算「线」——横线比纸宽、竖线比纸高，点阵/文字
 * 这类零散墨迹永远达不到，不需要为每种模板写一套识别规则。
 */
function profOf(c: HTMLCanvasElement, bgHex: string): Prof {
  const cached = profCache.get(c);
  if (cached && cached.bg === bgHex) return cached.p;
  const img = imgOf(c);
  const bg = hexRgb(bgHex);
  const rowCount = new Uint32Array(img.h);
  const colCount = new Uint32Array(img.w);
  const d = img.data;
  let ink = 0;
  let maxRow = 0;
  for (let y = 0; y < img.h; y += 1) {
    let rc = 0;
    const base = y * img.w * 4;
    for (let x = 0; x < img.w; x += 1) {
      const i = base + x * 4;
      if (
        d[i + 3] > 8 &&
        (Math.abs(d[i] - bg[0]) > INK_TOL ||
          Math.abs(d[i + 1] - bg[1]) > INK_TOL ||
          Math.abs(d[i + 2] - bg[2]) > INK_TOL)
      ) {
        rc += 1;
        colCount[x] += 1;
        ink += 1;
      }
    }
    rowCount[y] = rc;
    if (rc > maxRow) maxRow = rc;
  }
  const p: Prof = {
    rows: runs(rowCount, img.w * 0.5),
    cols: runs(colCount, img.h * 0.5),
    ink,
    maxRow,
  };
  profCache.set(c, { bg: bgHex, p });
  return p;
}

/** 单个像素的颜色（x/y 是画布设备像素） */
function bgAt(c: HTMLCanvasElement, x: number, y: number): number[] {
  const d = c.getContext("2d")!.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}

function colorOk(actual: number[], hex: string, tol = 3): boolean {
  const e = hexRgb(hex);
  return (
    actual[3] === 255 &&
    Math.abs(actual[0] - e[0]) <= tol &&
    Math.abs(actual[1] - e[1]) <= tol &&
    Math.abs(actual[2] - e[2]) <= tol
  );
}

function alphaAt(c: HTMLCanvasElement, x: number, y: number): number {
  return c.getContext("2d")!.getImageData(x, y, 1, 1).data[3];
}

function countAlpha(c: HTMLCanvasElement): number {
  const hit = alphaCache.get(c);
  if (hit !== undefined) return hit;
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n += 1;
  alphaCache.set(c, n);
  return n;
}

function inkAt(c: HTMLCanvasElement, x: number, y: number, bgHex: string): boolean {
  const bg = hexRgb(bgHex);
  const d = c.getContext("2d")!.getImageData(x, y, 1, 1).data;
  return (
    d[3] > 8 &&
    (Math.abs(d[0] - bg[0]) > INK_TOL ||
      Math.abs(d[1] - bg[1]) > INK_TOL ||
      Math.abs(d[2] - bg[2]) > INK_TOL)
  );
}

/** 把任意分辨率的画布归一化到 pageW×pageH，先铺一层纸色（方便套同一套阈值） */
function normalize(src: HTMLCanvasElement, pageW: number, pageH: number, bgHex: string): HTMLCanvasElement {
  const c = makeCanvas(pageW, pageH);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = bgHex;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, c.width, c.height);
  return c;
}

/** 两组线条中心位置逐项比对（长度必须一致，位置允许 ±tol 像素的取整误差） */
function sameProfile(a: number[], b: number[], tol = 2): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (Math.abs(a[i] - b[i]) > tol) return false;
  return true;
}

function gapsOk(centers: number[], expected: number, tol = 1.5): boolean {
  if (centers.length < 2) return false;
  for (let i = 1; i < centers.length; i += 1) {
    if (Math.abs(centers[i] - centers[i - 1] - expected) > tol) return false;
  }
  return true;
}

function avgGap(centers: number[]): number {
  if (centers.length < 2) return NaN;
  return (centers[centers.length - 1] - centers[0]) / (centers.length - 1);
}

function hasNear(arr: number[], target: number, tol = 2): boolean {
  return arr.some((v) => Math.abs(v - target) <= tol);
}

/** 直接调 drawPaper（paper.ts 自身的单元级验证） */
function renderDirect(
  template: TemplateId,
  paper: PaperId,
  fill = true,
  scale = 1
): HTMLCanvasElement {
  const c = makeCanvas(PAGE_W * scale, PAGE_H * scale);
  const ctx = c.getContext("2d")!;
  if (scale !== 1) ctx.scale(scale, scale);
  drawPaper(ctx, template, paper, PAGE_W, PAGE_H, 1, fill);
  return c;
}

/* ------------------------------- 主流程 ------------------------------- */

async function main() {
  pass(
    typeof document.createElement("canvas").getContext("2d")?.getImageData === "function",
    "2D canvas 像素读取可用（下面全部断言的测量前提）"
  );
  note(
    `环境：devicePixelRatio=${window.devicePixelRatio || 1}，纸面 ${PAGE_W}×${PAGE_H}，` +
      `${TEMPLATE_IDS.length} 模板 × ${PAPER_IDS.length} 纸色`
  );

  /* ---------- 1. paperBackground：三种纸色 ---------- */
  {
    const expected: Record<PaperId, string> = {
      white: "#FFFFFF",
      cream: "#FCF8EC",
      gray: "#F5F5F3",
    };
    for (const p of PAPER_IDS) {
      const v = paperBackground(p);
      pass(
        v === expected[p] && /^#[0-9A-Fa-f]{6}$/.test(v),
        `纸色 ${p}：paperBackground()=${v}（期望 ${expected[p]}，合法 6 位色值）`
      );
    }
    const all = PAPER_IDS.map((p) => paperBackground(p));
    pass(new Set(all).size === PAPER_IDS.length, `三种纸色互不相同（${all.join(" / ")}）`);
    pass(
      paperBackground("nope" as PaperId) === paperBackground("white"),
      `未知纸色回落纯白（paperBackground("nope")=${paperBackground("nope" as PaperId)}）`
    );
  }

  /* ---------- 2. blank 填底色：每种纸色都精确等于 paperBackground ---------- */
  for (const p of PAPER_IDS) {
    const c = renderDirect("blank", p, true);
    const px = bgAt(c, 5, 5);
    const ink = profOf(c, paperBackground(p)).ink;
    pass(
      colorOk(px, paperBackground(p)) && px[3] === 255 && ink === 0,
      `blank/${p}：整张纸只有底色（(5,5)=${hexOf(px)}，非底色像素 ${ink}）`
    );
  }

  /* ---------- 3. 6 模板 × 3 纸色：都真的画出东西 ---------- */
  for (const p of PAPER_IDS) {
    const bg = paperBackground(p);
    for (const t of TEMPLATE_IDS) {
      const c = renderDirect(t, p, true);
      const ink = profOf(c, bg).ink;
      pass(
        t === "blank" ? ink === 0 : ink > 500,
        `${t}/${p}：${t === "blank" ? "保持空白" : "画出线条"}（非底色像素 ${ink}）`
      );
    }
  }

  /* ---------- 4. 每种模板的结构特征（不只是「有几个像素」） ---------- */
  const whiteCanvases: Partial<Record<TemplateId, HTMLCanvasElement>> = {};
  for (const t of TEMPLATE_IDS) whiteCanvases[t] = renderDirect(t, "white", true);

  {
    const p = profOf(whiteCanvases.lined!, "#FFFFFF");
    pass(p.rows.length >= 20, `横线：检出 ${p.rows.length} 条横线（≥20）`);
    pass(
      p.rows.length > 0 && Math.abs(p.rows[0] - 112) <= 2,
      `横线：首条在 y≈112（实测 ${p.rows[0] ?? "-"}）`
    );
    pass(gapsOk(p.rows, 34), `横线：行距恒为 34（实测 ${avgGap(p.rows).toFixed(2)}）`);
    pass(
      p.cols.length === 1 && Math.abs(p.cols[0] - 78.5) <= 2,
      `横线：左侧页边线只有一条、在 x≈78（实测 [${p.cols.join(",")}]）`
    );
  }
  {
    const p = profOf(whiteCanvases.grid!, "#FFFFFF");
    pass(p.rows.length >= 40, `网格：检出 ${p.rows.length} 条横线（≥40）`);
    pass(p.cols.length >= 30, `网格：检出 ${p.cols.length} 条竖线（≥30）`);
    pass(
      p.rows.length > 0 &&
        p.cols.length > 0 &&
        Math.abs(p.rows[0] - 24) <= 2 &&
        Math.abs(p.cols[0] - 24) <= 2,
      `网格：首行/首列都在 24（实测 ${p.rows[0] ?? "-"} / ${p.cols[0] ?? "-"}）`
    );
    pass(gapsOk(p.rows, 24), `网格：横线间距 24（实测 ${avgGap(p.rows).toFixed(2)}）`);
    pass(gapsOk(p.cols, 24), `网格：竖线间距 24（实测 ${avgGap(p.cols).toFixed(2)}）`);
  }
  {
    const c = whiteCanvases.dotted!;
    const p = profOf(c, "#FFFFFF");
    pass(
      p.maxRow < PAGE_W * 0.3,
      `点阵：没有连续横线（单行最多 ${p.maxRow}px 墨迹 < ${Math.round(PAGE_W * 0.3)}）`
    );
    pass(p.ink > 2000, `点阵：点得足够多（${p.ink} 个非底色像素）`);
    pass(inkAt(c, 12, 12, "#FFFFFF"), "点阵：第一个点 (12,12) 上有墨");
    pass(!inkAt(c, 24, 12, "#FFFFFF"), "点阵：两点的中点 (24,12) 是纸色（点距 24）");
  }
  {
    const p = profOf(whiteCanvases.cornell!, "#FFFFFF");
    pass(hasNear(p.rows, 132), `康奈尔：顶部标题线在 y≈132（${p.rows.length} 条横线）`);
    pass(hasNear(p.rows, PAGE_H * 0.76), `康奈尔：底部总结线在 y≈${Math.round(PAGE_H * 0.76)}`);
    pass(hasNear(p.cols, PAGE_W * 0.3), `康奈尔：左侧竖线在 x≈${Math.round(PAGE_W * 0.3)}`);
    pass(p.rows.length >= 25, `康奈尔：正文横线够多（${p.rows.length} 条）`);
  }
  {
    const p = profOf(whiteCanvases.planner!, "#FFFFFF");
    pass(hasNear(p.cols, PAGE_W * 0.24), `周计划：左侧竖线在 x≈${Math.round(PAGE_W * 0.24)}`);
    pass(hasNear(p.cols, PAGE_W - 40), `周计划：右侧页边线在 x≈${PAGE_W - 40}`);
    pass(hasNear(p.rows, 112), "周计划：顶部标题线在 y≈112");
    pass(
      hasNear(p.rows, 168) && hasNear(p.rows, 168 + 6 * 128),
      `周计划：第一/最后一条周线在 y≈168 / ${168 + 6 * 128}`
    );
    const week = p.rows.filter((y) => y > 160 && y < 950);
    pass(gapsOk(week, 128), `周计划：7 条周线间距 128（检出 ${week.length} 条）`);
  }

  /* ---------- 5. fill=false：不填底色 ---------- */
  for (const t of NON_BLANK) {
    const c = renderDirect(t, "white", false);
    pass(alphaAt(c, 5, 5) === 0, `${t}：fill=false 时背景透明（(5,5) alpha=0）`);
    const n = countAlpha(c);
    pass(n > 500, `${t}：fill=false 仍画线条（${n} 个不透明像素）`);
  }
  {
    const c = renderDirect("blank", "white", false);
    pass(countAlpha(c) === 0, "blank + fill=false：整张画布全透明（什么都没画）");
  }

  /* ============================ 三处共用同一条 drawPaper ============================ */
  /* 屏幕：真调 editor.renderRec（它内部就是 drawPaper + 底图 + 笔迹） */
  const book = createBook("纸面一致性", "grid", "white");
  book.pages = [
    createPage("grid", "cream"),
    createPage("lined", "white"),
    createPage("planner", "gray"),
  ];
  const store = new BookStore(book);
  const root = document.createElement("div");
  root.className = "mb-root";
  root.style.cssText =
    "position:absolute;left:0;top:0;width:900px;height:700px;overflow:hidden;display:flex;flex-direction:column";
  const host = document.createElement("div");
  host.className = "mb-host";
  root.appendChild(host);
  document.getElementById("stage")!.appendChild(root);
  const emptyAdapter = {
    exists: async () => false,
    read: async () => "",
    readBinary: async () => new ArrayBuffer(0),
    write: async () => {},
    writeBinary: async () => {},
  };
  const editor = new BookEditor(host, store, {
    app: { vault: { adapter: emptyAdapter } },
    smoothing: 0.5,
  });
  await sleep(100);

  /**
   * 屏幕渲染：直接给 renderRec 一个离屏 ctx。
   *
   * renderRec 只读 rec.index / rec.ctx，页面尺寸和模板都从 store 里取，
   * 这就是屏幕上真正跑的那段代码（不经过 DOM canvas 只是省掉缩放取整，
   * 页面坐标与真实屏幕完全一样）。
   */
  function screenCanvas(index: number): HTMLCanvasElement {
    const c = makeCanvas(store.data.width, store.data.height);
    const ctx = c.getContext("2d")!;
    (editor as any).renderRec({ index, ctx });
    return c;
  }

  /* ---------- 6. 六种模板的三处一致性（屏幕 / 导出 / 嵌入） ---------- */
  for (const t of TEMPLATE_IDS) {
    const paper = PAPER_FOR[t];
    const bg = paperBackground(paper);
    const page = store.data.pages[0];
    page.template = t;
    page.paper = paper;

    const screenC = screenCanvas(0);
    const exportC = editor.exportPageCanvas(0, 2);
    const embedC = await renderEmbedPage(store.data, 0, PAGE_W);

    pass(
      colorOk(bgAt(screenC, 2, 2), bg),
      `${t}/${paper}：屏幕底色 ${hexOf(bgAt(screenC, 2, 2))} = ${bg}`
    );
    pass(
      colorOk(bgAt(exportC, 2, 2), bg),
      `${t}/${paper}：导出底色 ${hexOf(bgAt(exportC, 2, 2))} = ${bg}`
    );
    pass(
      colorOk(bgAt(embedC, 2, 2), bg),
      `${t}/${paper}：嵌入底色 ${hexOf(bgAt(embedC, 2, 2))} = ${bg}`
    );

    const sP = profOf(screenC, bg);
    const eP = profOf(normalize(exportC, PAGE_W, PAGE_H, bg), bg);
    const mP = profOf(normalize(embedC, PAGE_W, PAGE_H, bg), bg);

    pass(
      sameProfile(sP.rows, eP.rows),
      `${t}：屏幕与导出横线位置一致（${sP.rows.length} / ${eP.rows.length} 条）`
    );
    pass(
      sameProfile(sP.cols, eP.cols),
      `${t}：屏幕与导出竖线位置一致（${sP.cols.length} / ${eP.cols.length} 条）`
    );
    pass(
      sameProfile(eP.rows, mP.rows),
      `${t}：导出与嵌入横线位置一致（${eP.rows.length} / ${mP.rows.length} 条）`
    );
    pass(
      sameProfile(eP.cols, mP.cols),
      `${t}：导出与嵌入竖线位置一致（${eP.cols.length} / ${mP.cols.length} 条）`
    );
    const cls = (n: number) => (n > 0 ? 1 : 0);
    pass(
      cls(sP.ink) === cls(eP.ink) && cls(eP.ink) === cls(mP.ink),
      `${t}：三处「有没有墨」一致（屏幕 ${sP.ink} / 导出 ${eP.ink} / 嵌入 ${mP.ink}）`
    );
  }

  /* ---------- 7. 导出矢量叠加层：fill=false 且线条位置不变 ---------- */
  store.data.pages[0].template = "grid";
  store.data.pages[0].paper = "white";
  {
    const ov = editor.exportOverlayCanvas(0, 1, false);
    pass(alphaAt(ov, 5, 5) === 0, "导出叠加层（grid）：不填纸色，(5,5) 完全透明");
    pass(countAlpha(ov) > 500, `导出叠加层（grid）：纸面线条还在（${countAlpha(ov)} 个不透明像素）`);
  }

  /* ---------- 8. scale：导出 2 倍时线条间距也翻倍 ---------- */
  store.data.pages[0].template = "lined";
  store.data.pages[0].paper = "white";
  {
    const e1 = editor.exportPageCanvas(0, 1);
    const e2 = editor.exportPageCanvas(0, 2);
    const g1 = avgGap(profOf(e1, "#FFFFFF").rows);
    const g2 = avgGap(profOf(e2, "#FFFFFF").rows);
    const first2 = profOf(e2, "#FFFFFF").rows[0];
    pass(Math.abs(g1 - 34) <= 1, `导出 scale=1：横线间距 ${g1.toFixed(2)} ≈ 34`);
    pass(Math.abs(g2 - 68) <= 1, `导出 scale=2：横线间距 ${g2.toFixed(2)} ≈ 68（设备像素翻倍）`);
    pass(Math.abs(g2 / g1 - 2) < 0.03, `scale 翻倍间距也翻倍（比值 ${(g2 / g1).toFixed(3)}）`);
    pass(
      Math.abs(first2 - 225) <= 3,
      `导出 scale=2：首条线在设备 y≈225（页面 y=112 ×2，实测 ${first2 ?? "-"}）`
    );
  }

  /* ---------- 9. 非 A4 尺寸：宽高没有被三处任何一处写死 ---------- */
  {
    const oldW = store.data.width;
    const oldH = store.data.height;
    store.data.width = 600;
    store.data.height = 800;
    store.data.pages[0].template = "grid";
    store.data.pages[0].paper = "white";
    const s = screenCanvas(0);
    const e = editor.exportPageCanvas(0, 2);
    const m = await renderEmbedPage(store.data, 0, 600);
    const sP = profOf(s, "#FFFFFF");
    const eP = profOf(normalize(e, 600, 800, "#FFFFFF"), "#FFFFFF");
    const mP = profOf(normalize(m, 600, 800, "#FFFFFF"), "#FFFFFF");
    pass(
      sameProfile(sP.rows, eP.rows),
      `自定义纸 600×800：屏幕/导出横线一致（${sP.rows.length} / ${eP.rows.length} 条）`
    );
    pass(
      sameProfile(sP.cols, eP.cols),
      `自定义纸 600×800：屏幕/导出竖线一致（${sP.cols.length} / ${eP.cols.length} 条）`
    );
    pass(
      sameProfile(eP.rows, mP.rows),
      `自定义纸 600×800：导出/嵌入横线一致（${eP.rows.length} / ${mP.rows.length} 条）`
    );
    pass(
      sameProfile(eP.cols, mP.cols),
      `自定义纸 600×800：导出/嵌入竖线一致（${eP.cols.length} / ${mP.cols.length} 条）`
    );
    pass(
      colorOk(bgAt(s, 2, 2), "#FFFFFF") &&
        colorOk(bgAt(e, 2, 2), "#FFFFFF") &&
        colorOk(bgAt(m, 2, 2), "#FFFFFF"),
      "自定义纸 600×800：三处底色都是纯白"
    );
    store.data.width = oldW;
    store.data.height = oldH;
  }

  /* ---------- 10. paintPaperPreview：侧栏预览 ---------- */
  {
    const stage = document.getElementById("stage")!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const small = document.createElement("canvas");
    small.style.cssText = "display:block;width:64px;height:90px";
    stage.appendChild(small);
    paintPaperPreview(small, "blank", "white", PAGE_W, PAGE_H);
    pass(
      Math.abs(small.width - Math.round(64 * dpr)) <= 1 &&
        Math.abs(small.height - Math.round(90 * dpr)) <= 1,
      `预览：backing store 跟着 CSS×dpr（${small.width}×${small.height}，dpr=${dpr}）`
    );
    pass(
      profOf(small, "#FFFFFF").ink === 0,
      `预览 blank：只有纸色，没有线条（非底色像素 ${profOf(small, "#FFFFFF").ink}）`
    );
    small.remove();

    const big = document.createElement("canvas");
    big.style.cssText = "display:block;width:160px;height:226px";
    stage.appendChild(big);

    for (const t of TEMPLATE_IDS) {
      invalidate(big);
      paintPaperPreview(big, t, "cream", PAGE_W, PAGE_H);
      const n = profOf(big, "#FCF8EC").ink;
      pass(
        t === "blank" ? n === 0 : n > 50,
        `预览 ${t}/cream：${t === "blank" ? "保持空白" : "画出内容"}（非底色像素 ${n}）`
      );
    }

    invalidate(big);
    paintPaperPreview(big, "grid", "cream", PAGE_W, PAGE_H);
    pass(
      colorOk(bgAt(big, 2, 2), "#FCF8EC"),
      `预览 grid/cream：底色是米黄（${hexOf(bgAt(big, 2, 2))}）`
    );

    invalidate(big);
    paintPaperPreview(big, "grid", "white", PAGE_W, PAGE_H);
    pass(colorOk(bgAt(big, 2, 2), "#FFFFFF"), "预览换纸色（cream→white）：底色跟着变");

    invalidate(big);
    paintPaperPreview(big, "lined", "white", PAGE_W, PAGE_H);
    pass(
      profOf(big, "#FFFFFF").rows.length >= 20,
      `预览 lined：横线清晰可辨（${profOf(big, "#FFFFFF").rows.length} 条）`
    );
    pass(
      Math.abs(big.width / big.height - 160 / 226) < 0.01,
      `预览：宽高比跟着 CSS 尺寸（${big.width}×${big.height}）`
    );
    big.remove();
  }

  editor.destroy();
  root.remove();

  log("");
  log(`共 ${checks} 项，失败 ${failures} 项`);
  log(failures === 0 ? "ALL PASS" : failures + " FAILED");
  if (checks !== 131) log(`INFO 断言条数与预期 131 不符（实际 ${checks}），请同步 run-all.mjs`);
  document.title = "DONE";
}

main().catch((e) => {
  log("FATAL " + ((e && e.stack) || e));
  document.title = "FATAL";
});
