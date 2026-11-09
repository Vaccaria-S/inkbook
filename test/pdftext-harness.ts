/**
 * INK-118：短批注导出 PDF 的「隔字缺字」复现与常驻回归。
 *
 * 用户原话：用「添加文字」打了 4 个字，导出 PDF 之后只显示 2 个，字体断断续续。
 * 与 INK-116（长句被纸边裁掉）不同：这次是**中间的字凭空消失**，不是尾部被裁。
 *
 * 为什么这个套件必须做「双重判定」：
 *   上一轮所有「字数完整」断言都用 pdf.js 的 getTextContent() 抽回文字。
 *   抽文字走的是 ToUnicode CMap —— 映射表在、字形丢了，抽回的字数照样完整。
 *   所以 1131 项全绿也抓不到这个 bug。这里两路都验，缺一不可：
 *     ① pdf.js 抽回文字：逐字比对（字数 + 内容）；
 *     ② pdf.js 把 PDF 页**渲染成 canvas**，在「每个字自己的矩形」里数深色像素。
 *   这样能明确区分：
 *     · 「抽得到但看不见」：① 全、② 某些格 0 墨 —— 正是本 bug 的形态；
 *     · 「真的没有」：① 就缺字（字根本没画进 PDF）。
 *
 * 取样位置怎么算（上一轮 QA 踩过的坑：取样点落在空白纸面，等于没比）：
 *   · 矢量页：从 pdf.js 的 getTextContent() item 拿真实基线 transform[4]/[5]，
 *     再用导出时同一个字体的 widthOfTextAtSize 把整行切成逐字格；
 *   · 位图退回页：用屏幕/画布同一份 layoutUserText + canvas measureText 算格。
 *   格子都落在「字该在的那一小块矩形」里，且额外做了空白对照页（应为 0 墨），
 *   证明取样区既不是纯白纸、也没有被纸面线污染。
 *
 * 本子一次性导出（一页一个样本），因此跟真机一样：整本书共用同一个嵌入字体，
 * 字形登记顺序与页数相关 —— 这正是二次子集化的触发条件之一。
 */
import { BookEditor, textFontStack } from "../src/editor";
import { BookStore } from "../src/store";
import { importWord } from "../src/importer";
import { normalizeBook } from "../src/storage";
import { createBook, createPage, type PageText } from "../src/types";
import { exportBookPdf, pageHasUnsupportedChars } from "../src/export";
import { chineseCharacterSet, chineseFontBytes } from "../src/fontasset";
import { fitBackground, initPdfjs } from "../src/pdf";
import { layoutUserText } from "../src/textwrap";
import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

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

/** 页面坐标（794×1123）→ A4 pt 的比例，与 src/export.ts 保持一致 */
const PT_PER_UNIT = 595.28 / 794;
const A4_W = 595.28;
const A4_H = 841.89;
const PAGE_W = 794;
const PAGE_H = 1123;
/** pdf.js 渲染倍率；导出用 scale=1（矢量字与倍率无关，能省掉大量 PNG 编解码） */
const RENDER_SCALE = 2;
/** 空白底图：走 copyPages 那条路径时，底下不能自带文字，否则深色像素分不清是谁的墨 */
const BLANK_URL = "/test/blank.pdf";
/** 深色阈值：#1A1A1A 文字约 26，白纸 255，网格线 #DCE6F0 约 230 */
const DARK_LUM = 170;
/** 一个「看得见的字」至少要有这么多深色像素（空格/标点另算，见下） */
const MIN_INK = 5;

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
  /** 含集外字（生僻字 / emoji）：按设计整页退回位图，不该有矢量文字 */
  fallback?: boolean;
  /** 只为算取样矩形、并不真正画上去的文字（空白对照页用） */
  phantom?: TextSpec;
  /**
   * 集外字退回位图页里「应该看得见的字」数量（按码点、不含空白）。
   * 用来把「整页退回位图后字还在」钉成常驻断言，而不是只跑一次看日志。
   */
  fallbackVisible?: number;
}
interface Cell {
  ch: string;
  /** PDF 坐标系（y 朝上）的矩形 [x0, y0, x1, y1] */
  rect: [number, number, number, number];
}
interface PageMeta {
  s: Scenario;
  withBg: boolean;
  index: number;
}

const at = (text: string, x = 80, y = 300, size = 20): TextSpec => ({ text, x, y, size });

/** 短文本矩阵：见交付说明，覆盖纯中文组合 / 长度 / 混排 / 字号位置 / 多条 / 退回 */
const SCENARIOS: Scenario[] = [
  // A. 纯中文 4 字，多种不同汉字组合（用来确认「是不是固定某几个字丢」）
  { id: "cn4-1", label: "纯中文4字·大承气汤", texts: [at("大承气汤")] },
  { id: "cn4-2", label: "纯中文4字·测试文字", texts: [at("测试文字")] },
  { id: "cn4-3", label: "纯中文4字·你好世界", texts: [at("你好世界")] },
  { id: "cn4-4", label: "纯中文4字·阴阳五行", texts: [at("阴阳五行")] },
  { id: "cn4-5", label: "纯中文4字·春夏秋冬", texts: [at("春夏秋冬")] },
  { id: "cn4-6", label: "纯中文4字·天气真好", texts: [at("天气真好")] },
  { id: "cn4-7", label: "纯中文4字·墨本手写", texts: [at("墨本手写")] },
  { id: "cn4-8", label: "纯中文4字·一二三四", texts: [at("一二三四")] },
  // B. 长度梯度
  { id: "len2", label: "2字", texts: [at("中文")] },
  { id: "len8", label: "8字", texts: [at("阴阳五行藏象经络")] },
  { id: "len20", label: "20字", texts: [at("这是一段正好二十字左右的中文批注验证用")] },
  {
    id: "len60",
    label: "60字（会折行）",
    texts: [at("这一段批注故意写得比纸还长，用来验证导出时会按纸宽自动折行，而不是被页面右边界裁掉，那样内容就不完整了，用户会以为字丢了")],
  },
  // C. 混排
  { id: "digit", label: "中文+数字", texts: [at("第123页备注")] },
  { id: "mixed", label: "中英混排", texts: [at("Hello世界ABC")] },
  { id: "punct", label: "带标点", texts: [at("中文，标点。测试")] },
  { id: "space", label: "带空格", texts: [at("中 文 测 试")] },
  { id: "newline", label: "带硬换行", texts: [at("第一行\n第二行")] },
  // D. 字号与位置
  { id: "size14", label: "字号14", texts: [at("小字批注", 80, 300, 14)] },
  { id: "size20", label: "字号20", texts: [at("正常字号", 80, 300, 20)] },
  { id: "size60", label: "字号60", texts: [at("大字", 80, 300, 60)] },
  { id: "right", label: "靠右 x=700", texts: [at("靠右批注", 700, 300, 20)] },
  { id: "bottom", label: "贴底 y=1100", texts: [at("贴底批注", 80, 1100, 20)] },
  // E. 一页多条 user 批注
  {
    id: "multi",
    label: "一页3条批注",
    texts: [at("第一条批注", 80, 200, 20), at("第二条批注", 80, 360, 20), at("第三条批注", 80, 520, 20)],
  },
  // F. 集外字：整页退回位图，字仍应全部看得见
  {
    id: "emoji",
    label: "emoji 整页退回位图",
    texts: [at("这里有表情 😀 写不出来")],
    fallback: true,
    fallbackVisible: 10,
  },
  {
    id: "rare",
    label: "生僻字 整页退回位图",
    texts: [at("𰻝𰻝面条真好吃")],
    fallback: true,
    fallbackVisible: 7,
  },
  // G. 空白对照：证明取样矩形不是「空白纸面」，且没有纸面线污染
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

const norm = (s: string): string => s.replace(/\s+/g, "");
/** 逐「码点」计数：emoji / 生僻字是代理对，用 String.length 会多数一倍 */
const nChars = (s: string): number => Array.from(norm(s)).length;

/** 数一个矩形里的深色像素；只截这一小块 getImageData，不开整页 8MB 的大数组 */
function inkInRect(ctx: CanvasRenderingContext2D, r: [number, number, number, number]): number {
  const x0 = Math.max(0, Math.floor(Math.min(r[0], r[2])));
  const y0 = Math.max(0, Math.floor(Math.min(r[1], r[3])));
  const x1 = Math.min(ctx.canvas.width, Math.ceil(Math.max(r[0], r[2])));
  const y1 = Math.min(ctx.canvas.height, Math.ceil(Math.max(r[1], r[3])));
  if (x1 <= x0 || y1 <= y0) return 0;
  const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i] + data[i + 1] + data[i + 2]) / 3 < DARK_LUM) n++;
  }
  return n;
}

/** PDF 坐标矩形 → canvas 像素矩形（pdf.js 的 viewport 会翻 y 轴） */
function toViewportRect(vp: any, r: [number, number, number, number]): [number, number, number, number] {
  const v = vp.convertToViewportRectangle([r[0], r[1], r[2], r[3]]);
  return [v[0], v[1], v[2], v[3]];
}

/** 把一个 pdf.js 文本 item 按真实字体宽度切成逐字格（矢量页用） */
function cellsFromItem(item: any, sizePt: number, font: PDFFont): Cell[] {
  const tr = item.transform as number[];
  const x0 = Number(tr[4]);
  const yBase = Number(tr[5]);
  const chars = Array.from(String(item.str || ""));
  const cells: Cell[] = [];
  let prev = 0;
  for (let j = 0; j < chars.length; j++) {
    const cum = font.widthOfTextAtSize(chars.slice(0, j + 1).join(""), sizePt);
    const w = Math.max(0, cum - prev);
    prev = cum;
    cells.push({
      ch: chars[j],
      rect: [x0 + cum - w, yBase - 0.12 * sizePt, x0 + cum, yBase + 0.9 * sizePt],
    });
  }
  return cells;
}

/** 位图退回页：屏幕上/画布上用的是 layoutUserText + canvas measureText，按这套算格 */
function cellsFromCanvasLayout(specs: TextSpec[]): Cell[] {
  const ctx = document.createElement("canvas").getContext("2d")!;
  const cells: Cell[] = [];
  for (const s of specs) {
    ctx.font = `${s.size}px ${textFontStack(undefined)}`;
    const measure = (str: string): number => ctx.measureText(str).width;
    const l = layoutUserText({ x: s.x, y: s.y, size: s.size, text: s.text }, PAGE_W, PAGE_H, measure);
    for (let i = 0; i < l.lines.length; i++) {
      const lineChars = Array.from(l.lines[i]);
      const baseline = l.y + i * l.lineHeight;
      let prev = 0;
      for (let j = 0; j < lineChars.length; j++) {
        const cum = measure(lineChars.slice(0, j + 1).join(""));
        const w = Math.max(0, cum - prev);
        prev = cum;
        // 页面坐标 y 朝下 → PDF y 朝上
        const yTopPage = baseline - 0.9 * s.size;
        const yBotPage = baseline + 0.12 * s.size;
        cells.push({
          ch: lineChars[j],
          rect: [
            (l.x + cum - w) * PT_PER_UNIT,
            (PAGE_H - yBotPage) * PT_PER_UNIT,
            (l.x + cum) * PT_PER_UNIT,
            (PAGE_H - yTopPage) * PT_PER_UNIT,
          ],
        });
      }
    }
  }
  return cells;
}

/** 渲染一页到 canvas（白底），返回 ctx 与 viewport */
async function renderPage(doc: any, pageNo: number): Promise<{ ctx: CanvasRenderingContext2D; vp: any }> {
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale: RENDER_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  await page.render({ canvasContext: ctx, viewport: vp, background: "#ffffff" }).promise;
  return { ctx, vp };
}

/** 造一份「已知全字可见」的参照 PDF（subset:false），证明像素检查本身能测到墨 */
async function buildReferencePdf(subset: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(chineseFontBytes(), { subset });
  const page = doc.addPage([A4_W, A4_H]);
  const size = 20 * PT_PER_UNIT;
  page.drawText("大承气汤", {
    x: 80 * PT_PER_UNIT,
    y: (PAGE_H - 300) * PT_PER_UNIT,
    size,
    font,
    color: rgb(0.1, 0.1, 0.1),
  });
  return doc.save();
}

async function main(): Promise<void> {
  const blankRes = await fetch(BLANK_URL);
  const blankBytes = new Uint8Array(await blankRes.arrayBuffer());
  pass(blankBytes.length > 200, "拿到空白底图 PDF（" + blankBytes.length + " 字节）");

  const pdfjs = initPdfjs();
  // 量字宽必须用导出时同一个字体（两种 embedder 的 widthOfTextAtSize 是同一份实现）
  const probeDoc = await PDFDocument.create();
  probeDoc.registerFontkit(fontkit);
  const measureFont = await probeDoc.embedFont(chineseFontBytes(), { subset: false });

  /* ---------------- 集外字兜底的常驻护栏（INK-118 附带风险） ----------------
   * 关掉 subset 后，导出端不能再依赖 PDFFont.getCharacterSet()（随 embedder 变的
   * 非公开 API）。这里验证：字符集来自字体文件本身、判定纯函数对 null 字符集
   * 一律保守，并且集外字确实会被判为「写不出」→ 整页退回位图。
   */
  {
    const cs = chineseCharacterSet();
    pass(!!cs && cs.size > 5000, "字体字符集可直接解析（" + (cs?.size ?? 0) + " 个码点，不依赖 PDFFont 私有方法）");
    if (cs) {
      pass(
        ["大", "承", "气", "汤", "A", "1"].every((c) => cs.has(c.codePointAt(0)!)),
        "常用中英文字都在字符集内"
      );
      pass(
        [0x1f600, 0x30e3d, 0x9f98].every((cp) => !cs.has(cp)),
        "emoji / 𰻝 / 龘 等集外字不在字符集内"
      );
    }
    const userText = (text: string): PageText[] => [
      { id: "u", source: "user", x: 80, y: 300, size: 20, text },
    ];
    pass(
      pageHasUnsupportedChars(userText("大承气汤"), null),
      "字符集拿不到时按保守处理：纯中文也退回位图（不乐观放行）"
    );
    pass(
      pageHasUnsupportedChars(undefined, null),
      "字符集拿不到时：无批注页也走保守分支"
    );
    pass(
      !!cs && !pageHasUnsupportedChars(userText("大承气汤"), cs),
      "纯中文批注判为可矢量输出"
    );
    pass(
      !!cs && pageHasUnsupportedChars(userText("这里有表情 😀 写不出来"), cs),
      "emoji 批注判为写不出 → 整页退回位图"
    );
    pass(
      !!cs && pageHasUnsupportedChars(userText("𰻝𰻝面条真好吃"), cs),
      "生僻字（代理对）批注判为写不出 → 整页退回位图"
    );
    pass(
      !!cs && !pageHasUnsupportedChars(userText("第一行\n第二行\r第三行"), cs),
      "硬换行 \\n / \\r 不算集外字"
    );
    pass(
      !!cs && !pageHasUnsupportedChars(
        [{ id: "p", source: "pdf", x: 0, y: 0, size: 20, text: "😀" }],
        cs
      ),
      "非 user 来源的文字不参与集外字判定"
    );
  }

  /* ---------------- 参照：像素检查本身能测到墨 ---------------- */
  for (const subset of [true, false]) {
    const refBytes = await buildReferencePdf(subset);
    const d = await pdfjs.getDocument({ data: refBytes.slice() }).promise;
    const pg = await d.getPage(1);
    const tc = await pg.getTextContent();
    const item = (tc.items as any[]).find((it) => String(it.str || "").trim());
    const sizePt = 20 * PT_PER_UNIT;
    const cells = item ? cellsFromItem(item, sizePt, measureFont) : [];
    const { ctx, vp } = await renderPage(d, 1);
    const inks = cells.map((c) => inkInRect(ctx, toViewportRect(vp, c.rect)));
    const visible = inks.filter((n) => n >= MIN_INK).length;
    log(
      `  [参照 subset=${subset}] 抽到 ${item ? String(item.str).length : 0} 字，可见字形 ${visible}/${cells.length}，逐字墨=${inks.join(",")}`
    );
    if (!subset) {
      pass(cells.length === 4 && visible === 4, "参照（不二次子集化）4 字全部看得见（像素）");
    }
    await d.destroy();
  }

  /* ---------------- 构造复现本子：每个样本两页，覆盖两条导出路径 ---------------- */
  const book = createBook("短文本复现矩阵", "blank", "white");
  book.pages = [];
  const meta: PageMeta[] = [];
  for (const s of SCENARIOS) {
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
          id: `t_${s.id}_${withBg ? "bg" : "plain"}_${i}`,
          source: "user",
          x: t.x,
          y: t.y,
          size: t.size,
          text: t.text,
          color: t.color || "#1A1A1A",
        })
      );
      book.pages.push(p);
      meta.push({ s, withBg, index: book.pages.length - 1 });
    }
  }
  pass(book.pages.length === SCENARIOS.length * 2, "构造 " + book.pages.length + " 页（每个样本两条导出路径）");

  /* ---------------- vault 桩 ---------------- */
  const written = new Map<string, Uint8Array>();
  const files = new Map<string, ArrayBuffer>();
  files.set(BLANK_URL, blankBytes.buffer as ArrayBuffer);
  const adapter = {
    exists: async (p: string) => written.has(p),
    read: async () => "",
    readBinary: async (p: string) => files.get(p) ?? new ArrayBuffer(0),
    write: async () => {},
    writeBinary: async (p: string, buf: ArrayBuffer) => {
      written.set(p, new Uint8Array(buf));
    },
  };
  const app = { vault: { adapter } };
  const vault = { adapter } as any;

  const store = new BookStore(book);
  const [host, cleanup] = makeHost();
  const editor = new BookEditor(host, store, { app, smoothing: 0.5 });
  await sleep(400);

  const file = { path: "短文本复现矩阵.inkbook", basename: "短文本复现矩阵", parent: { path: "" } } as any;
  const t0 = performance.now();
  const outPath = await exportBookPdf(vault, editor, file, 1);
  const bytes = written.get(outPath);
  pass(!!bytes && bytes.length > 10000, "导出 " + (bytes?.length ?? 0) + " 字节（" + (performance.now() - t0).toFixed(0) + "ms）");
  if (!bytes) {
    log("FATAL 导出失败");
    document.title = "FATAL";
    return;
  }

  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  pass(doc.numPages === meta.length, "导出 PDF 有 " + doc.numPages + " 页");

  let totalExtractMissing = 0;
  let totalInvisible = 0;
  const brokenIds: string[] = [];

  for (const m of meta) {
    const pageNo = m.index + 1;
    const tag = `${m.s.id}/${m.withBg ? "底图" : "纯纸"}`;
    const page = await doc.getPage(pageNo);
    const tc = await page.getTextContent();
    const items = ((tc.items as any[]) || []).filter((it) => String(it.str || "").trim());
    const got = items.map((it) => String(it.str || "")).join("");
    const want = m.s.texts.map((t) => t.text).join("");
    const sizePt = (m.s.texts[0]?.size ?? 20) * PT_PER_UNIT;

    // ① 抽回文字
    if (m.s.fallback) {
      pass(items.length === 0, `${tag}：集外字整页退回位图（可抽文字 ${items.length} 条）`);
    } else if (m.s.phantom) {
      pass(items.length === 0, `${tag}：空白对照页没有文字`);
    } else {
      const ok = norm(got) === norm(want);
      if (!ok) totalExtractMissing++;
      pass(ok, `${tag}：抽回文字完整（${nChars(got)}/${nChars(want)} 字）`);
    }

    // ② 渲染成 canvas，在逐字格里数深色像素
    const { ctx, vp } = await renderPage(doc, pageNo);
    let cells: Cell[];
    if (m.s.phantom) {
      cells = cellsFromCanvasLayout([m.s.phantom]);
    } else if (m.s.fallback) {
      cells = cellsFromCanvasLayout(m.s.texts);
    } else if (items.length) {
      cells = items.flatMap((it) => cellsFromItem(it, sizePt, measureFont));
    } else {
      cells = cellsFromCanvasLayout(m.s.texts);
    }
    const inks = cells.map((c) => inkInRect(ctx, toViewportRect(vp, c.rect)));
    const judged = cells.filter((c) => !/\s/.test(c.ch)); // 空格本来就没有墨
    const invisible = cells
      .map((c, i) => ({ ch: c.ch, ink: inks[i] }))
      .filter((x) => !/\s/.test(x.ch) && x.ink < MIN_INK);
    const totalInk = inks.reduce((a, b) => a + Math.max(0, b), 0);
    log(
      `  [${tag}] 抽字 ${nChars(got)}/${nChars(want)}｜格 ${cells.length}｜可见 ${judged.length - invisible.length}/${judged.length}｜总墨 ${totalInk}｜逐字墨 [${inks.join(",")}]${invisible.length ? "｜缺字 " + invisible.map((x) => `${x.ch}:${x.ink}`).join(" ") : ""}`
    );

    if (m.s.phantom) {
      pass(totalInk === 0, `${tag}：取样矩形在空白页上应为 0 墨（实得 ${totalInk}）`);
    } else {
      // 取样有效性：整段必须有墨，否则等于又在比白纸
      pass(totalInk > 0, `${tag}：取样矩形确实落在字上（总墨 ${totalInk} > 0）`);
      const ok = invisible.length === 0;
      if (!ok) {
        totalInvisible += invisible.length;
        brokenIds.push(tag);
      }
      pass(ok, `${tag}：每个字都看得见（缺 ${invisible.length} 字：${invisible.map((x) => x.ch).join("") || "无"}）`);
      if (m.s.fallback) {
        const visible = judged.length - invisible.length;
        pass(
          visible === m.s.fallbackVisible,
          `${tag}：退回位图后字全部可见（${visible}/${m.s.fallbackVisible} 字，可抽文字 0 条）`
        );
        // 结构证据：这一页不能有任何 showText / showSpacedText 指令。
        // 有就说明集外字被当成矢量硬画了（.notdef 方块/空白），而位图层又没画。
        const ops = await page.getOperatorList();
        const textOps = (ops.fnArray as number[]).filter((fn) => fn === 44 || fn === 45).length;
        pass(
          textOps === 0,
          `${tag}：页内没有矢量文字指令（showText/showSpacedText ${textOps} 条，排除 .notdef 硬画）`
        );
      }
    }
    page.cleanup();
  }

  /* ---------------- 真实 Word 导入 → 存档重读 → 导出文字可选 ---------------- */
  {
    const original = "墨本Word文字可选";
    const xml = `<w:document><w:body><w:p><w:r><w:t>${original}</w:t></w:r></w:p></w:body></w:document>`;
    const payload = new TextEncoder().encode(xml);
    const name = new TextEncoder().encode("word/document.xml");
    // 最小 ZIP（store method）：真实经过 readZipText/parse/layout/importWord 链路。
    const zip = new Uint8Array(30 + name.length + payload.length + 46 + name.length + 22);
    const view = new DataView(zip.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(8, 0, true);
    view.setUint32(18, payload.length, true);
    view.setUint32(22, payload.length, true);
    view.setUint16(26, name.length, true);
    zip.set(name, 30);
    zip.set(payload, 30 + name.length);
    const central = 30 + name.length + payload.length;
    view.setUint32(central, 0x02014b50, true);
    view.setUint16(central + 10, 0, true);
    view.setUint32(central + 20, payload.length, true);
    view.setUint32(central + 24, payload.length, true);
    view.setUint16(central + 28, name.length, true);
    zip.set(name, central + 46);
    const end = central + 46 + name.length;
    view.setUint32(end, 0x06054b50, true);
    view.setUint16(end + 8, 1, true);
    view.setUint16(end + 10, 1, true);
    view.setUint32(end + 12, 46 + name.length, true);
    view.setUint32(end + 16, central, true);

    const assets = new Map<string, ArrayBuffer>();
    assets.set("test.docx", zip.buffer);
    const assetUrls = new Map<string, string>();
    const wordAdapter = {
      exists: async (p: string) => assets.has(p),
      readBinary: async (p: string) => assets.get(p) ?? new ArrayBuffer(0),
      writeBinary: async (p: string, buf: ArrayBuffer) => { assets.set(p, buf); },
      remove: async (p: string) => { assets.delete(p); },
      getResourcePath: (p: string) => {
        if (!assetUrls.has(p)) assetUrls.set(p, URL.createObjectURL(new Blob([assets.get(p)!], { type: "image/png" })));
        return assetUrls.get(p)!;
      },
    };
    const wordApp = { vault: { adapter: wordAdapter, getAbstractFileByPath: () => true } } as any;
    const imported = await importWord(wordApp, { path: "test.docx", name: "test.docx", basename: "test" } as any, "word.inkbook");
    pass(imported.pages.length === 1 && imported.pages[0].texts?.[0]?.source === "word", "Word 导入产生 source=word 的文字行");
    const wordBook = createBook("Word原文", "blank", "white");
    wordBook.pages = imported.pages;
    const restored = normalizeBook(JSON.parse(JSON.stringify(wordBook)), "Word原文");
    pass(restored.pages[0].texts?.[0]?.source === "word", "Word 文字来源经存档规范化仍保留");
    const wordStore = new BookStore(restored);
    const [wordHost, wordCleanup] = makeHost();
    const wordEditor = new BookEditor(wordHost, wordStore, { app: wordApp, smoothing: 0.5 });
    const wordWritten = new Map<string, Uint8Array>();
    const wordVault = { adapter: {
      exists: async (p: string) => wordWritten.has(p),
      writeBinary: async (p: string, buf: ArrayBuffer) => { wordWritten.set(p, new Uint8Array(buf)); },
    } } as any;
    const wordPath = await exportBookPdf(wordVault, wordEditor, { path: "word.inkbook", basename: "word", parent: { path: "" } } as any, 1);
    const wordBytes = wordWritten.get(wordPath);
    pass(!!wordBytes && wordBytes.length > 1000, "Word 底图页导出 PDF 文件");
    if (wordBytes) {
      const wordPdf = await pdfjs.getDocument({ data: wordBytes.slice() }).promise;
      const wordPdfPage = await wordPdf.getPage(1);
      const wordText = (await wordPdfPage.getTextContent()).items.map((item: any) => item.str).join("");
      pass(wordText.includes(original), "Word 导出 PDF 的 getTextContent 能抽回完整原文");
      wordPdfPage.cleanup();
      await wordPdf.destroy();
    }
    wordEditor.destroy();
    wordCleanup();
    for (const url of assetUrls.values()) URL.revokeObjectURL(url);
  }

  log("");
  log(
    `复现汇总：抽字缺失页 ${totalExtractMissing} 个｜像素不可见字 ${totalInvisible} 个｜受影响样本 ${brokenIds.length} 个`
  );
  if (brokenIds.length) log("受影响样本前 12 个：" + brokenIds.slice(0, 12).join("、"));

  try {
    await doc.destroy();
  } catch (_) {}
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
