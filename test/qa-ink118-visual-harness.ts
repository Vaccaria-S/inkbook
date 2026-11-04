/**
 * QA 独立终验（INK-118）：短批注导出 PDF 的「隔字缺字」。
 *
 * 这套链路刻意**不复用** pdftext-harness.ts / export-harness.ts 的任何断言：
 *   · 工程师那两条链路都是「从 pdf.js getTextContent() 的 item.transform 切逐字格，
 *     再数深色像素，绝对阈值 MIN_INK=5」。抽文字走 ToUnicode CMap，正是上一轮
 *     假绿的来源；我不想把「取样位置」也押在同一份可疑数据上。
 *   · 这里改走 **A/B 差分**：自己用 pdf-lib 直接画一份「黄金参照」（subset:false，
 *     同字体 / 同字号 / 同颜色 / 同坐标），再画一份「已知坏参照」（subset:true，
 *     复现旧行为）。把三份 PDF 都用 pdf.js 渲染成 canvas，在**整段批注的包围盒**
 *     上算深色像素掩膜的 IoU / 覆盖率，再按**源数据几何**（layoutUserText +
 *     字体宽度，完全不碰 getTextContent 的 transform）切逐字格做比例判定。
 *
 * 护栏（缺一不可，否则又是假绿）：
 *   ① 空白对照页：无批注，phantom 取样矩形应为 0 墨；
 *   ② 黄金参照自校验：每个非空格字的格子里必须有墨（证明取样真落在字上）；
 *   ③ 负对照：subset:true 的坏参照必须至少有一个字 0 墨 + 结构上 short loca /
 *      numberOfContours 越界，证明这套检测真能抓到「隔字缺字」；
 *   ④ 双重判定：抽回文字逐字一致 + 像素可见，两路都过才算过。
 *
 * 另外把「字符集兜底」做成常驻断言：fontkit 直解字符集 / PDFFont.getCharacterSet()
 * 的存在性与码点数、含常用汉字不含 emoji、以及 pageHasUnsupportedChars 的
 * 保守分支（charset=null 时必须退回位图）。
 */
import { BookEditor, textFontStack } from "../src/editor";
import { BookStore } from "../src/store";
import { createBook, createPage, type PageText } from "../src/types";
import { exportBookPdf, pageHasUnsupportedChars } from "../src/export";
import { chineseCharacterSet, chineseFontBytes } from "../src/fontasset";
import { fitBackground, initPdfjs } from "../src/pdf";
import { layoutUserText } from "../src/textwrap";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
  rgb,
  type PDFFont,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

/* ------------------------------------------------------------------ */
const lines: string[] = [];
const out = document.getElementById("out")!;
const log = (s: string): void => {
  lines.push(s);
  out.textContent = lines.join("\n");
};
let failures = 0;
const pass = (ok: boolean, label: string): void => {
  if (!ok) failures++;
  log((ok ? "PASS " : "FAIL ") + label);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const PT = 595.28 / 794;
const A4_W = 595.28;
const A4_H = 841.89;
const PAGE_W = 794;
const PAGE_H = 1123;
const SCALE = 2;
const DARK = 170;
const BLANK_URL = "/test/blank.pdf";
const norm = (s: string): string => s.replace(/\s+/g, "");
const nChars = (s: string): number => Array.from(norm(s)).length;

interface TextSpec {
  text: string;
  x: number;
  y: number;
  size: number;
  color?: string;
}
interface Scenario {
  id: string;
  label: string;
  texts: TextSpec[];
  /** 集外字：按设计整页退回位图 */
  fallback?: boolean;
  /** 只为算取样矩形的影子批注（空白对照页用，不真正画） */
  phantom?: TextSpec;
}
interface Cell {
  ch: string;
  /** PDF 坐标（y 朝上）矩形 */
  rect: [number, number, number, number];
}
interface Mask {
  m: Uint8Array;
  w: number;
  h: number;
  vp: any;
}
interface PageMeta {
  s: Scenario;
  withBg: boolean;
  index: number;
  scenarioIndex: number;
}

const at = (text: string, x = 80, y = 300, size = 20): TextSpec => ({ text, x, y, size });

/** 覆盖清单：长度 / 混排 / 标点 / 空格 / 硬换行 / 字号 / 边界 / 多条 / 集外字 / 空白 */
const SCENARIOS: Scenario[] = [
  { id: "cn2", label: "2 字纯中文", texts: [at("中文")] },
  { id: "cn4", label: "4 字纯中文（用户原报「大承气汤」）", texts: [at("大承气汤")] },
  { id: "cn8", label: "8 字纯中文", texts: [at("阴阳五行藏象经络")] },
  { id: "cn20", label: "20 字纯中文", texts: [at("这是一段正好二十字左右的中文批注验证用")] },
  {
    id: "cn60",
    label: "60 字纯中文（折行）",
    texts: [at("这一段批注故意写得比纸还长，用来验证导出时会按纸宽自动折行，而不是被页面右边界裁掉，那样内容就不完整了，用户会以为字丢了")],
  },
  { id: "mixed", label: "中英混排", texts: [at("Hello世界ABC")] },
  { id: "digit", label: "中文+数字", texts: [at("第123页备注")] },
  { id: "punct", label: "中文标点", texts: [at("中文，标点。测试")] },
  { id: "space", label: "带空格", texts: [at("中 文 测 试")] },
  { id: "newline", label: "硬换行", texts: [at("第一行\n第二行")] },
  { id: "size14", label: "字号 14", texts: [at("小字批注", 80, 300, 14)] },
  { id: "size20", label: "字号 20", texts: [at("正常字号", 80, 300, 20)] },
  { id: "size60", label: "字号 60", texts: [at("大字", 80, 300, 60)] },
  { id: "right", label: "靠右 x=700", texts: [at("靠右批注", 700, 300, 20)] },
  { id: "bottom", label: "贴底 y=1100", texts: [at("贴底批注", 80, 1100, 20)] },
  {
    id: "multi",
    label: "一页 3 条批注",
    texts: [at("第一条批注", 80, 200, 20), at("第二条批注", 80, 360, 20), at("第三条批注", 80, 520, 20)],
  },
  { id: "emoji", label: "emoji 整页退回位图", texts: [at("这里有表情 😀 写不出来")], fallback: true },
  { id: "rare", label: "生僻字 整页退回位图", texts: [at("𰻝𰻝面条真好吃")], fallback: true },
  { id: "blank", label: "空白对照（无批注）", texts: [], phantom: at("大承气汤") },
];

function makeHost(): [HTMLElement, () => void] {
  const root = document.createElement("div");
  root.className = "mb-root";
  root.style.cssText =
    "position:absolute;left:0;top:0;width:900px;height:700px;overflow:hidden;display:flex;flex-direction:column";
  const host = document.createElement("div");
  host.className = "mb-host";
  root.appendChild(host);
  document.body.appendChild(root);
  return [host, () => root.remove()];
}

/* ---------------------------- 渲染 / 掩膜 ---------------------------- */

async function maskOf(doc: any, pageNo: number): Promise<Mask> {
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale: SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  await page.render({ canvasContext: ctx, viewport: vp, background: "#ffffff" }).promise;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const m = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, p = 0; i < img.length; i += 4, p += 1) {
    if ((img[i] + img[i + 1] + img[i + 2]) / 3 < DARK) m[p] = 1;
  }
  try { page.cleanup(); } catch (_) { /* noop */ }
  return { m, w: canvas.width, h: canvas.height, vp };
}

/** 把一段任意 canvas 缩放成与参照掩膜同尺寸的掩膜（位图退回页用） */
function maskOfCanvasScaled(src: HTMLCanvasElement, w: number, h: number): Uint8Array {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h).data;
  const m = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < img.length; i += 4, p += 1) {
    if ((img[i] + img[i + 1] + img[i + 2]) / 3 < DARK) m[p] = 1;
  }
  return m;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** PDF 坐标矩形 → canvas 像素矩形 [x0,y0,x1,y1]（已归一化） */
function toPx(vp: any, r: [number, number, number, number], mask: Mask): [number, number, number, number] {
  const v = vp.convertToViewportRectangle([r[0], r[1], r[2], r[3]]);
  return [
    clamp(Math.floor(Math.min(v[0], v[2])), 0, mask.w),
    clamp(Math.floor(Math.min(v[1], v[3])), 0, mask.h),
    clamp(Math.ceil(Math.max(v[0], v[2])), 0, mask.w),
    clamp(Math.ceil(Math.max(v[1], v[3])), 0, mask.h),
  ];
}

function inkIn(mask: Mask, px: [number, number, number, number]): number {
  const [x0, y0, x1, y1] = px;
  if (x1 <= x0 || y1 <= y0) return 0;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    const row = y * mask.w;
    for (let x = x0; x < x1; x += 1) n += mask.m[row + x];
  }
  return n;
}

/** 两块掩膜在同一像素矩形里的交集统计 */
function regionStats(a: Mask, b: Uint8Array, px: [number, number, number, number]) {
  const [x0, y0, x1, y1] = px;
  let na = 0, nb = 0, inter = 0;
  for (let y = y0; y < y1; y += 1) {
    const row = y * a.w;
    for (let x = x0; x < x1; x += 1) {
      const va = a.m[row + x];
      const vb = b[row + x];
      na += va; nb += vb;
      if (va && vb) inter += 1;
    }
  }
  const iou = na + nb - inter > 0 ? inter / (na + nb - inter) : 1;
  const coverage = na > 0 ? inter / na : 1; // 黄金的墨有多少被真实导出复现
  const extra = na > 0 ? (nb - inter) / na : 0; // 多出来的杂墨
  return { na, nb, inter, iou, coverage, extra };
}

/** 所有格子围成的包围盒（PDF 坐标），略微外扩 */
function bboxOf(cells: Cell[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cells) {
    x0 = Math.min(x0, Math.min(c.rect[0], c.rect[2]));
    x1 = Math.max(x1, Math.max(c.rect[0], c.rect[2]));
    y0 = Math.min(y0, Math.min(c.rect[1], c.rect[3]));
    y1 = Math.max(y1, Math.max(c.rect[1], c.rect[3]));
  }
  if (!cells.length) return [0, 0, A4_W, A4_H];
  const padX = 3, padY = 3;
  return [x0 - padX, y0 - padY, x1 + padX, y1 + padY];
}

/* ---------------------------- 逐字格（源数据几何） ---------------------------- */

const canvasMeasureCache = new Map<number, CanvasRenderingContext2D>();
function canvasMeasure(size: number): CanvasRenderingContext2D {
  let ctx = canvasMeasureCache.get(size);
  if (!ctx) {
    ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = `${size}px ${textFontStack()}`;
    canvasMeasureCache.set(size, ctx);
  }
  return ctx;
}

/**
 * 只从**源数据**（text/x/y/size）+ 字体度量算格子，完全不读 pdf.js 的
 * getTextContent().transform —— 那是上一轮假绿链条里最不该信的一环。
 */
function cellsFromSpecs(specs: TextSpec[], font: PDFFont, useCanvasFont: boolean): Cell[] {
  const cells: Cell[] = [];
  for (const s of specs) {
    const sizePt = s.size * PT;
    const measure = useCanvasFont
      ? (str: string): number => canvasMeasure(s.size).measureText(str).width
      : (str: string): number => font.widthOfTextAtSize(str, sizePt) / PT;
    const l = layoutUserText({ x: s.x, y: s.y, size: s.size, text: s.text }, PAGE_W, PAGE_H, measure);
    for (let i = 0; i < l.lines.length; i += 1) {
      const chars = Array.from(l.lines[i]);
      const yBase = (PAGE_H - (l.y + i * l.lineHeight)) * PT;
      let prev = 0;
      for (let j = 0; j < chars.length; j += 1) {
        const prefix = chars.slice(0, j + 1).join("");
        /*
         * 单位别混：layoutUserText 的 measure 必须返回**页面坐标**（除以 PT），
         * 但逐字格的 x 是 PDF 的 pt。矢量页用 widthOfTextAtSize 的原始 pt 值，
         * 位图页用 canvas measureText 的页面坐标值再乘 PT。混用会让格子随字数
         * 逐渐向右漂，最后几个字落到字外 —— 那是测试的假缺字，不是产品的缺字。
         */
        const cum = useCanvasFont
          ? canvasMeasure(s.size).measureText(prefix).width
          : font.widthOfTextAtSize(prefix, sizePt);
        const x0 = useCanvasFont ? (l.x + prev) * PT : l.x * PT + prev;
        const x1 = useCanvasFont ? (l.x + cum) * PT : l.x * PT + cum;
        prev = cum;
        cells.push({
          ch: chars[j],
          rect: [Math.min(x0, x1), yBase - 0.15 * sizePt, Math.max(x0, x1), yBase + 1.05 * sizePt],
        });
      }
    }
  }
  return cells;
}

/* ---------------------------- 参照 PDF ---------------------------- */

function drawSpecs(page: any, font: PDFFont, specs: TextSpec[]): void {
  for (const s of specs) {
    const sizePt = s.size * PT;
    const l = layoutUserText(
      { x: s.x, y: s.y, size: s.size, text: s.text },
      PAGE_W,
      PAGE_H,
      (str) => font.widthOfTextAtSize(str, sizePt) / PT
    );
    for (let i = 0; i < l.lines.length; i += 1) {
      if (!l.lines[i]) continue;
      page.drawText(l.lines[i], {
        x: l.x * PT,
        y: (PAGE_H - (l.y + i * l.lineHeight)) * PT,
        size: sizePt,
        font,
        color: rgb(0x1a / 255, 0x1a / 255, 0x1a / 255),
      });
    }
  }
}

/** 黄金参照：一份文档 19 页，每页对应一个场景（同一份字体，只嵌一次） */
async function buildGoldDoc(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(chineseFontBytes(), { subset: false });
  for (const s of SCENARIOS) {
    const page = doc.addPage([A4_W, A4_H]);
    drawSpecs(page, font, s.phantom ? [] : s.texts);
  }
  return doc.save();
}

/**
 * 已知会缺字的负对照：只画用户原报的那 4 个字，用旧行为 subset:true。
 * 单独一页 / 单独一份文档，避免把 emoji / 生僻字混进子集干扰复现。
 */
async function buildBrokenDoc(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(chineseFontBytes(), { subset: true });
  const page = doc.addPage([A4_W, A4_H]);
  drawSpecs(page, font, [at("大承气汤")]);
  return doc.save();
}

/* ---------------------------- FontFile2 自解析 ---------------------------- */

interface TtfInfo {
  len: number;
  locaFormat: number;
  numGlyphs: number;
  badContours: number;
  glyphLens: number[];
  oddGlyphs: number;
}
/** 自己解析 TTF 表目录 + head/maxp/loca/glyf，不借用 export-harness 的解析代码 */
function parseTtf(buf: Uint8Array): TtfInfo {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const numTables = view.getUint16(4, false);
  const tables: Record<string, number> = {};
  for (let i = 0; i < numTables; i += 1) {
    const o = 12 + i * 16;
    const tag = String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
    tables[tag] = view.getUint32(o + 8, false);
  }
  const head = tables.head ?? -1;
  const maxp = tables.maxp ?? -1;
  const locaOff = tables.loca ?? -1;
  const glyfOff = tables.glyf ?? -1;
  const locaFormat = head >= 0 ? view.getInt16(head + 50, false) : -1;
  const numGlyphs = maxp >= 0 ? view.getUint16(maxp + 4, false) : 0;
  const glyphLens: number[] = [];
  let badContours = 0;
  let oddGlyphs = 0;
  if (locaOff >= 0 && glyfOff >= 0 && numGlyphs > 0) {
    const offs: number[] = [];
    for (let i = 0; i <= numGlyphs; i += 1) {
      offs.push(locaFormat === 0 ? view.getUint16(locaOff + i * 2, false) * 2 : view.getUint32(locaOff + i * 4, false));
    }
    for (let i = 0; i < numGlyphs; i += 1) {
      const len = offs[i + 1] - offs[i];
      glyphLens.push(len);
      if (len % 2 === 1) oddGlyphs += 1;
      if (len > 0) {
        const nc = view.getInt16(glyfOff + offs[i], false);
        // 简单字形 numberOfContours 一般是 0..几百；复合字形是 -1。
        // short-loca 错位后会读出 -28160 / 11776 这类垃圾值。
        if (nc < -1 || nc > 4096) badContours += 1;
      }
    }
  }
  return { len: buf.length, locaFormat, numGlyphs, badContours, glyphLens, oddGlyphs };
}

async function fontProgramsOf(bytes: Uint8Array): Promise<{ programs: Uint8Array[]; refs: number }> {
  const doc = await PDFDocument.load(bytes);
  const programs: Uint8Array[] = [];
  let refs = 0;
  for (const page of doc.getPages()) {
    const fonts = page.node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
    if (!fonts) continue;
    for (const key of fonts.keys()) {
      const fd = fonts.lookup(key, PDFDict);
      const desc = fd.lookupMaybe(PDFName.of("DescendantFonts"), PDFArray)?.lookup(0, PDFDict);
      const file = desc?.lookupMaybe(PDFName.of("FontDescriptor"), PDFDict)
        ?.lookupMaybe(PDFName.of("FontFile2"), PDFRawStream);
      if (file) {
        refs += 1;
        programs.push(decodePDFRawStream(file).decode());
      }
    }
  }
  return { programs, refs };
}

/** 内容指纹：取头中尾各 256 字节求和，够区分「一份」还是「多份」 */
function fp(b: Uint8Array): string {
  let s = 0;
  const idx = [0, Math.floor(b.length / 2), Math.max(0, b.length - 256)];
  for (const st of idx) for (let i = st; i < Math.min(b.length, st + 256); i += 1) s = (s * 31 + b[i]) | 0;
  return `${b.length}:${s}`;
}

/* -------------------------------- main -------------------------------- */

async function main(): Promise<void> {
  const blankRes = await fetch(BLANK_URL);
  const blankBytes = new Uint8Array(await blankRes.arrayBuffer());
  pass(blankBytes.length > 200, "空白底图夹具可加载（" + blankBytes.length + " 字节）");

  const pdfjs = initPdfjs();

  /* ===== 1. 字符集兜底：常驻断言（不因以后换 embedder 而漂移） ===== */
  const charset = chineseCharacterSet();
  pass(!!charset && charset.size > 1000, "chineseCharacterSet() 可用，含 " + (charset?.size ?? 0) + " 个码点");
  const COMMON = ["大", "承", "气", "汤", "中", "文", "测", "试", "阴", "阳", "A", "0", "，"];
  const missingCommon = charset ? COMMON.filter((c) => !charset.has(c.codePointAt(0)!)) : COMMON;
  pass(missingCommon.length === 0, "字符集含常用汉字/ASCII/中文标点（缺 " + missingCommon.join("") + "）");
  const cpEmoji = "😀".codePointAt(0)!;
  const cpRare = "𰻝".codePointAt(0)!;
  pass(!!charset && !charset.has(cpEmoji) && !charset.has(cpRare), "字符集不含 emoji(U+1F600) / 生僻字(U+30EDD)");

  // 用 fontkit 直接查每个矢量字是否落到 .notdef（gid 0）
  const fkFont: any = fontkit.create(chineseFontBytes());
  const notdef: string[] = [];
  for (const s of SCENARIOS) {
    if (s.fallback || s.phantom) continue;
    for (const t of s.texts) {
      for (const ch of Array.from(t.text)) {
        if (/\s/.test(ch)) continue;
        const cp = ch.codePointAt(0)!;
        const g = fkFont.glyphForCodePoint(cp);
        if (!g || g.id === 0) notdef.push(ch);
      }
    }
  }
  pass(notdef.length === 0, "所有矢量批注字符都映射到真实字形，无 .notdef（" + notdef.length + " 个）");

  // 团队交办的原始问题：subset:false 下 PDFFont.getCharacterSet() 到底还在不在
  const probeDoc = await PDFDocument.create();
  probeDoc.registerFontkit(fontkit);
  const measureFont = await probeDoc.embedFont(chineseFontBytes(), { subset: false });
  const hasGetter = typeof (measureFont as any).getCharacterSet === "function";
  let pdfCs: number[] = [];
  if (hasGetter) {
    try { pdfCs = (measureFont as any).getCharacterSet() || []; } catch (_) { pdfCs = []; }
  }
  log(`  [实测] subset:false 下 getCharacterSet 存在=${hasGetter} 返回码点数=${Array.isArray(pdfCs) ? pdfCs.length : "非数组"}`);
  pass(hasGetter, "subset:false 下 PDFFont.getCharacterSet() 存在（非公开 API，实测）");
  pass(Array.isArray(pdfCs) && pdfCs.length === charset?.size,
    "getCharacterSet() 返回 " + (Array.isArray(pdfCs) ? pdfCs.length : 0) + " 个码点，与 fontkit 直解一致（" + charset?.size + "）");
  if (Array.isArray(pdfCs) && pdfCs.length) {
    const s2 = new Set(pdfCs);
    pass(!s2.has(cpEmoji) && !s2.has(cpRare) && s2.has("大".codePointAt(0)!),
      "getCharacterSet() 同样含常用汉字、不含 emoji");
  }

  // 保守分支：charset 解析失败时必须退回位图，绝不乐观放行
  const dummy: PageText[] = [{ id: "d", source: "user", x: 80, y: 300, size: 20, text: "纯中文批注" }];
  pass(pageHasUnsupportedChars(dummy, null) === true, "pageHasUnsupportedChars(charset=null) 保守返回 true（整页退回位图）");
  pass(pageHasUnsupportedChars(dummy, charset) === false, "pageHasUnsupportedChars(正常中文) = false（走矢量）");
  pass(pageHasUnsupportedChars([{ ...dummy[0], text: "这里有表情 😀" }], charset) === true,
    "pageHasUnsupportedChars(含 emoji) = true");

  /* ===== 2. 黄金参照 / 已知坏参照 ===== */
  const goldBytes = await buildGoldDoc();
  const goldDoc = await pdfjs.getDocument({ data: goldBytes.slice() }).promise;
  pass(goldDoc.numPages === SCENARIOS.length, "黄金参照 " + goldDoc.numPages + " 页");

  let brokenBytes: Uint8Array | null = null;
  let brokenDoc: any = null;
  try {
    brokenBytes = await buildBrokenDoc();
    brokenDoc = await pdfjs.getDocument({ data: brokenBytes.slice() }).promise;
  } catch (e) {
    log("  [警告] subset:true 坏参照构造失败：" + String(e));
  }
  pass(!!brokenDoc, "已知会缺字的负对照（subset:true）可加载");

  // 根因条件：构建期那份手工子集字体本身就是 long loca、且大量字形长度为奇数。
  // 正是这些奇数长度字形被 TTFSubset 原样拼接后才会让 short loca 边界错位。
  const srcTtf = parseTtf(chineseFontBytes());
  log(`  [源字体结构] len=${srcTtf.len}B indexToLocFormat=${srcTtf.locaFormat} numGlyphs=${srcTtf.numGlyphs} 奇数长度字形=${srcTtf.oddGlyphs}｜「大承气汤」所在前若干字形长度=[${srcTtf.glyphLens.slice(1, 5).join(",")}]`);
  pass(srcTtf.locaFormat === 1, "构建期手工子集字体本来就是 long loca（indexToLocFormat=1）");
  pass(srcTtf.oddGlyphs > 0, "构建期字体确有奇数长度字形（" + srcTtf.oddGlyphs + " 个）—— 二次子集化的触发条件");

  // 负对照的结构证据：short loca + 越界 numberOfContours
  if (brokenBytes) {
    const brokenProgs = await fontProgramsOf(brokenBytes);
    const brokenTtf = brokenProgs.programs.length ? parseTtf(brokenProgs.programs[0]) : null;
    if (brokenTtf) {
      log(`  [负对照结构] len=${brokenTtf.len}B indexToLocFormat=${brokenTtf.locaFormat} numGlyphs=${brokenTtf.numGlyphs} 奇数长度字形=${brokenTtf.oddGlyphs} numberOfContours越界=${brokenTtf.badContours}｜前4字形长度=[${brokenTtf.glyphLens.slice(0, 4).join(",")}]`);
      pass(brokenTtf.locaFormat === 0, "负对照确实是 short loca（indexToLocFormat=0）");
      pass(brokenTtf.badContours > 0, "负对照确有 numberOfContours 越界字形（" + brokenTtf.badContours + " 个）");
      pass(brokenTtf.len < srcTtf.len / 100, "负对照字体只有 " + brokenTtf.len + " B（原字体 " + srcTtf.len + " B 的 1/" + Math.round(srcTtf.len / brokenTtf.len) + "）");
    } else {
      pass(false, "负对照能解析出 FontFile2");
    }
  }

  /* ===== 3. 构造复现本子：每个样本两条导出路径 ===== */
  const book = createBook("INK118-QA独立终验", "blank", "white");
  book.pages = [];
  const meta: PageMeta[] = [];
  SCENARIOS.forEach((s, si) => {
    for (const withBg of [false, true]) {
      const p = createPage("blank", "white");
      if (withBg) {
        const fit = fitBackground(A4_W, A4_H, 0);
        p.background = {
          pdf: { path: BLANK_URL, page: 1 },
          sourceName: "blank.pdf",
          sourcePage: 1,
          x: fit.x,
          y: fit.y,
          width: fit.width,
          height: fit.height,
          kind: "pdf",
        };
      }
      p.texts = s.texts.map(
        (t, i): PageText => ({
          id: `qa_${s.id}_${withBg ? "bg" : "plain"}_${i}`,
          source: "user",
          x: t.x, y: t.y, size: t.size, text: t.text,
          color: t.color || "#1A1A1A",
        })
      );
      book.pages.push(p);
      meta.push({ s, withBg, index: book.pages.length - 1, scenarioIndex: si });
    }
  });
  pass(book.pages.length === SCENARIOS.length * 2, "构造 " + book.pages.length + " 页（每样本纯纸 / PDF 底图两条路径）");

  const written = new Map<string, Uint8Array>();
  const files = new Map<string, ArrayBuffer>();
  files.set(BLANK_URL, blankBytes.buffer as ArrayBuffer);
  const adapter = {
    exists: async (p: string) => written.has(p),
    read: async () => "",
    readBinary: async (p: string) => files.get(p) ?? new ArrayBuffer(0),
    write: async () => {},
    writeBinary: async (p: string, buf: ArrayBuffer) => { written.set(p, new Uint8Array(buf)); },
  };
  const app = { vault: { adapter } };
  const vault = { adapter } as any;
  const store = new BookStore(book);
  const [host, cleanup] = makeHost();
  const editor = new BookEditor(host, store, { app, smoothing: 0.5 });
  await sleep(400);

  const file = { path: "QA独立终验.inkbook", basename: "QA独立终验", parent: { path: "" } } as any;
  const t0 = performance.now();
  const outPath = await exportBookPdf(vault, editor, file, 1);
  const bytes = written.get(outPath);
  pass(!!bytes && bytes.length > 10000, "真实 exportBookPdf 导出 " + (bytes?.length ?? 0) + " 字节（" + (performance.now() - t0).toFixed(0) + "ms）");
  if (!bytes) { log("FATAL 导出失败"); document.title = "FATAL"; return; }
  log(`  [体积] ${meta.length} 页导出件 = ${bytes.length} 字节 (${(bytes.length / 1024 / 1024).toFixed(2)} MB)`);

  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  pass(doc.numPages === meta.length, "导出 PDF " + doc.numPages + " 页");

  /* ===== 4. 产物结构：FontFile2 只嵌一份 + long loca + 字形边界自洽 ===== */
  const progs = await fontProgramsOf(bytes);
  const distinct = new Set(progs.programs.map(fp));
  log(`  [FontFile2] 引用次数=${progs.refs} 去重后字体程序=${distinct.size} 单份长度=${progs.programs[0]?.length ?? 0} 字节`);
  pass(progs.programs.length > 0, "能从导出件里自己解析出 FontFile2");
  pass(distinct.size === 1, "整本书（" + meta.length + " 页）只嵌一份中文 TTF（去重 " + distinct.size + " 份）");
  if (progs.programs.length) {
    const info = parseTtf(progs.programs[0]);
    log(`  [TTF] len=${info.len}B (${(info.len / 1024 / 1024).toFixed(2)}MB) indexToLocFormat=${info.locaFormat} numGlyphs=${info.numGlyphs} 奇数长度字形=${info.oddGlyphs} numberOfContours越界=${info.badContours}`);
    pass(info.len > 1024 * 1024, "嵌的是完整手工子集字体（" + Math.round(info.len / 1024) + " KB）");
    pass(info.locaFormat === 1, "字体用 long loca（indexToLocFormat=1）");
    pass(info.badContours === 0, "全部 " + info.numGlyphs + " 个字形 numberOfContours 都在合理范围（越界 " + info.badContours + "）");
  }

  /* ===== 5. 逐页 A/B 差分 ===== */
  let totalPages = 0;
  let totalChars = 0;
  let totalInvisible = 0;
  let totalExtractBad = 0;
  let blankRealInk = -1;
  let minCoverage = 1;
  let minIou = 1;
  /** 黄金掩膜按场景缓存：两条导出路径共用同一份，省一半渲染 */
  const goldCache = new Map<number, Mask>();

  for (const mm of meta) {
    const pageNo = mm.index + 1;
    const tag = `${mm.s.id}/${mm.withBg ? "底图" : "纯纸"}`;
    const page = await doc.getPage(pageNo);
    const tc = await page.getTextContent();
    const items = ((tc.items as any[]) || []).filter((it) => String(it.str || "").trim());
    const got = items.map((it) => String(it.str || "")).join("");
    const want = mm.s.texts.map((t) => t.text).join("");

    // ① 抽回文字（双重判定之一）
    if (mm.s.fallback || mm.s.phantom) {
      const ok = items.length === 0;
      if (!ok) totalExtractBad += 1;
      pass(ok, `${tag}：集外字整页退回位图 / 空白页无文字（可抽文字 ${items.length} 条）`);
      if (mm.s.fallback) {
        pass(pageHasUnsupportedChars(book.pages[mm.index].texts || [], charset) === true,
          `${tag}：pageHasUnsupportedChars 判定该页含集外字`);
      }
    } else {
      const ok = norm(got) === norm(want);
      if (!ok) totalExtractBad += 1;
      pass(ok, `${tag}：抽回文字逐字一致（${nChars(got)}/${nChars(want)} 字）`);
    }

    // ② 渲染真实导出页 + 黄金参照（按场景缓存）
    const real = await maskOf(doc, pageNo);
    let gold = goldCache.get(mm.scenarioIndex);
    if (!gold) {
      gold = await maskOf(goldDoc, mm.scenarioIndex + 1);
      goldCache.set(mm.scenarioIndex, gold);
    }

    // 位图退回页：黄金改成「app 自己画的那张 canvas」（PDF 里嵌的就是它）
    let goldM = gold.m;
    if (mm.s.fallback) {
      const appCanvas = editor.exportPageCanvas(mm.index, 1, true);
      goldM = maskOfCanvasScaled(appCanvas, real.w, real.h);
    }

    const useCanvasFont = !!mm.s.fallback;
    const specsForCells = mm.s.phantom ? [mm.s.phantom] : mm.s.texts;
    const cells = cellsFromSpecs(specsForCells, measureFont, useCanvasFont);
    const pxRects = cells.map((c) => toPx(real.vp, c.rect, real));
    const boxPx = toPx(real.vp, bboxOf(cells), real);

    const goldInk = cells.map((_, i) => inkIn({ ...gold, m: goldM }, pxRects[i]));
    const realInk = cells.map((_, i) => inkIn(real, pxRects[i]));

    const stats = regionStats({ ...gold, m: goldM }, real.m, boxPx);
    if (!mm.s.phantom && !mm.s.fallback) {
      minCoverage = Math.min(minCoverage, stats.coverage);
      minIou = Math.min(minIou, stats.iou);
    }

    const judged = cells.map((c, i) => ({ ch: c.ch, gi: goldInk[i], ri: realInk[i] }))
      .filter((x) => !/\s/.test(x.ch));
    const invisible = judged.filter((x) => x.ri < Math.max(2, 0.25 * x.gi));
    const calibration = judged.filter((x) => x.gi < 2);
    const totalInk = realInk.reduce((a, b) => a + b, 0);

    log(`  [${tag}] 抽字 ${nChars(got)}/${nChars(want)}｜格 ${cells.length}｜黄金墨 ${stats.na}｜交集 ${stats.inter}｜cov=${stats.coverage.toFixed(3)} IoU=${stats.iou.toFixed(3)} extra=${stats.extra.toFixed(3)}｜真实总墨 ${totalInk}｜逐字真实墨 [${realInk.join(",")}]`);

    if (mm.s.phantom) {
      // 护栏①：空白对照页必须为 0 墨
      blankRealInk = Math.max(blankRealInk, totalInk);
      pass(stats.na === 0, `${tag}：黄金参照在取样矩形内应为 0 墨（实得 ${stats.na}）`);
      pass(totalInk === 0, `${tag}：空白对照页取样矩形 0 墨（实得 ${totalInk}）`);
    } else {
      // 护栏②：取样确实落在字上
      pass(stats.na > 0, `${tag}：黄金参照在取样矩形内有墨（${stats.na} > 0）`);
      pass(calibration.length === 0, `${tag}：逐字格几何自校验通过（失准格 ${calibration.length}）`);
      // 主判定：整段包围盒的掩膜差分
      pass(mm.s.fallback || stats.coverage >= 0.7,
        `${tag}：黄金墨复现率 ${(stats.coverage * 100).toFixed(1)}% ≥ 70%`);
      pass(mm.s.fallback || stats.iou >= 0.5,
        `${tag}：整段掩膜 IoU ${stats.iou.toFixed(3)} ≥ 0.5`);
      pass(stats.extra <= 0.6, `${tag}：无额外杂墨（extra=${stats.extra.toFixed(3)} ≤ 0.6）`);
      // 主判定：每个字都有可见墨（比例制，自适应字号）
      totalChars += judged.length;
      totalInvisible += invisible.length;
      pass(invisible.length === 0,
        `${tag}：每个字都有可见墨（${judged.length - invisible.length}/${judged.length}，缺 ${invisible.map((x) => x.ch).join("") || "无"}）`);
    }

    totalPages += 1;
    try { page.cleanup(); } catch (_) { /* noop */ }
  }

  /* ===== 5b. 护栏③：负对照必须真的被这套像素检测抓到隔字缺字 ===== */
  let negativeControlCaught = false;
  let negativeControlMissing = 0;
  if (brokenDoc) {
    const cn4Index = SCENARIOS.findIndex((s) => s.id === "cn4");
    const gold4 = goldCache.get(cn4Index) ?? (await maskOf(goldDoc, cn4Index + 1));
    const broken4 = await maskOf(brokenDoc, 1);
    const cells4 = cellsFromSpecs([at("大承气汤")], measureFont, false);
    const px4 = cells4.map((c) => toPx(gold4.vp, c.rect, gold4));
    const gi = cells4.map((_, i) => inkIn(gold4, px4[i]));
    const bi = cells4.map((_, i) => inkIn(broken4, px4[i]));
    const bx = toPx(gold4.vp, bboxOf(cells4), gold4);
    const st = regionStats(gold4, broken4.m, bx);
    negativeControlMissing = cells4.filter((_, i) => gi[i] >= 2 && bi[i] < Math.max(2, 0.25 * gi[i])).length;
    // 旧 bug 的标志性现象：ToUnicode 完好 → 抽字一个不少，glyf 错位 → 渲染没墨
    const bPage = await brokenDoc.getPage(1);
    const bTc = await bPage.getTextContent();
    const bGot = ((bTc.items as any[]) || []).map((it) => String(it.str || "")).join("");
    log(`  [负对照 cn4 大承气汤] 抽字="${norm(bGot)}"（${nChars(bGot)}/4）｜黄金逐字墨=[${gi.join(",")}] 旧行为逐字墨=[${bi.join(",")}]｜覆盖率=${st.coverage.toFixed(3)} IoU=${st.iou.toFixed(3)}｜被判缺字 ${negativeControlMissing}/4`);
    pass(norm(bGot) === "大承气汤", "负对照复现「抽字完整但视觉空白」：ToUnicode 抽回 4 字");
    negativeControlCaught = negativeControlMissing >= 1;
    pass(negativeControlCaught, "护栏③：负对照（旧 subset:true 行为）被这套像素检测抓到隔字缺字（缺 " + negativeControlMissing + " 字）");
    pass(st.coverage < 0.95, "护栏③：负对照的覆盖率明显低于修复后（" + (st.coverage * 100).toFixed(1) + "% < 95%）");
    log(`  [对照] 修复后 cn4 黄金墨=${gi.reduce((a, b) => a + b, 0)}，负对照墨=${bi.reduce((a, b) => a + b, 0)}，掩膜尺寸 ${gold4.w}×${gold4.h}`);
  } else {
    pass(false, "护栏③：负对照可用");
  }

  log("");
  log(`差分汇总：检查页 ${totalPages}｜逐字判定 ${totalChars} 字｜不可见 ${totalInvisible} 字｜抽字异常页 ${totalExtractBad}｜最低覆盖率 ${minCoverage.toFixed(3)}｜最低 IoU ${minIou.toFixed(3)}`);
  pass(blankRealInk === 0, "护栏①：空白对照页 0 墨（两条路径合计最大 " + blankRealInk + "）");

  try { await goldDoc.destroy(); } catch (_) { /* noop */ }
  try { await brokenDoc?.destroy(); } catch (_) { /* noop */ }
  try { await doc.destroy(); } catch (_) { /* noop */ }

  /* ===== 6. 小体积回归：单批注 / 无批注 ===== */
  {
    const one = createBook("单批注", "blank", "white");
    one.pages = [createPage("blank", "white")];
    one.pages[0].texts = [{ id: "o", source: "user", x: 80, y: 300, size: 20, text: "大承气汤", color: "#1A1A1A" }];
    const st = new BookStore(one);
    const [h, cl] = makeHost();
    const ed = new BookEditor(h, st, { app, smoothing: 0.5 });
    await sleep(250);
    const p1 = await exportBookPdf(vault, ed, { path: "单批注.inkbook", basename: "单批注", parent: { path: "" } } as any, 1);
    const b1 = written.get(p1)!;
    log(`  [体积] 单页单批注导出件 = ${b1.length} 字节 (${(b1.length / 1024).toFixed(1)} KB)`);
    pass(b1.length > 1024 * 1024, "单批注导出件含完整字体（> 1MB）");
    pass(b1.length < 2 * 1024 * 1024, "单批注导出件 < 2MB（" + Math.round(b1.length / 1024) + " KB）");
    ed.destroy(); cl();
  }
  {
    const none = createBook("无批注", "lined", "white");
    none.pages = [createPage("lined", "white")];
    const st = new BookStore(none);
    const [h, cl] = makeHost();
    const ed = new BookEditor(h, st, { app, smoothing: 0.5 });
    await sleep(250);
    const p2 = await exportBookPdf(vault, ed, { path: "无批注.inkbook", basename: "无批注", parent: { path: "" } } as any, 1);
    const b2 = written.get(p2)!;
    const no = await fontProgramsOf(b2);
    log(`  [体积] 无批注本子导出件 = ${b2.length} 字节 (${(b2.length / 1024).toFixed(1)} KB)，FontFile2 ${no.programs.length} 份`);
    pass(b2.length < 200 * 1024, "无批注本子导出件仍然很小（" + Math.round(b2.length / 1024) + " KB < 200 KB）");
    pass(no.programs.length === 0, "无批注本子不嵌任何字体（FontFile2 = 0）");
    ed.destroy(); cl();
  }

  editor.destroy();
  cleanup();
  log("");
  log(failures === 0 ? "ALL PASS" : failures + " FAILED");
  document.title = "DONE";
}

main().catch((e) => {
  log("FATAL " + (e?.stack || e));
  document.title = "FATAL";
});
