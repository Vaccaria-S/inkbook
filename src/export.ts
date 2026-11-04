import { Notice, type TFile, type Vault } from "obsidian";
import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { BookEditor } from "./editor";
import { chineseCharacterSet, chineseFontBytes } from "./fontasset";
import type { Page, PageText } from "./types";
import { layoutUserText } from "./textwrap";

function safeName(s: string): string {
  return String(s).replace(/[\\/:*?"<>|#^[\]]/g, "_").trim() || "手写本";
}

function canvasBytes(canvas: HTMLCanvasElement): Uint8Array {
  const data = canvas.toDataURL("image/png").split(",")[1] || "";
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function exportPagePng(
  vault: Vault,
  editor: BookEditor,
  file: TFile,
  scale = 2
): Promise<string> {
  await editor.waitBackgrounds([editor.getState().pageIndex], scale);
  const canvas = editor.exportPageCanvas(editor.getState().pageIndex, scale);
  const bytes = canvasBytes(canvas);
  const folder = file.parent && file.parent.path !== "/" ? file.parent.path + "/" : "";
  const base = safeName(file.basename);
  const page = editor.getState().pageIndex + 1;
  let name = `${base}-第${page}页.png`;
  let n = 1;
  while (await vault.adapter.exists(folder + name)) {
    name = `${base}-第${page}页 ${++n}.png`;
  }
  await vault.adapter.writeBinary(folder + name, bytes.buffer as ArrayBuffer);
  new Notice(`已导出：${folder}${name}`, 6000);
  return folder + name;
}

/**
 * 一页的 user 批注里是否含字体写不出的字符（生僻字 / emoji / 代理对）。
 *
 * 纯函数：导出链路和测试共用同一份判定，避免"代码里保守、测试里乐观"漂移。
 *
 * `charset === null` 表示字符集没解析出来（字体文件异常、fontkit 不可用等），
 * 这时**一律返回 true**：宁可整页退回位图（字都在、只是选不中），也不能把
 * 集外字送进矢量层硬画成 .notdef 方块/空白 —— 后者位图层又不画，字就真丢了。
 *
 * \n / \r 是排版用的硬换行，不是要画的字，跳过。
 * 用 codePointAt(0) 而不是 charCodeAt(0)，保证 emoji 这类代理对按整码点判定。
 */
export function pageHasUnsupportedChars(
  texts: PageText[] | undefined,
  charset: Set<number> | null
): boolean {
  if (!charset) return true;
  for (const t of texts || []) {
    if (t.source !== "user") continue;
    for (const ch of t.text || "") {
      if (ch === "\n" || ch === "\r") continue;
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      if (!charset.has(cp)) return true;
    }
  }
  return false;
}

/** 页面坐标系（794×1123）→ A4 的 pt（595.28×841.89），比例正好 0.7497 */
const PT_PER_UNIT = 595.28 / 794;
const A4_W = 595.28;
const A4_H = 841.89;

function parseColor(hex?: string): RGB {
  const s = String(hex || "#1A1A1A").replace("#", "").trim();
  const full = s.length === 3 ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2] : s;
  const v = parseInt(full, 16);
  if (!Number.isFinite(v)) return rgb(0.1, 0.1, 0.1);
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}

/**
 * 把一页里用户添加的文字画成**真正的 PDF 文字**（不是像素）。
 *
 * 坐标换算要点：
 *   · 屏幕上是 `fillText(line, x, y + i × size × 1.32)`，textBaseline 为 alphabetic，
 *     也就是 `y` 就是**基线**——正好对上 pdf-lib 的 drawText（y 也是基线）。
 *   · PDF 原点在左下、y 朝上，所以要翻成 `(页高 − y)`。
 *   · drawText 不认 `\n`，逐行调用。
 *
 * 字体只有一款 Regular（见 fontasset.ts）：屏幕上选的宋体/楷体等在这里统一成
 * Noto Sans SC，`bold` 也不描粗——PDF 里没有对应的字重文件。
 * 这是有意的取舍：优先保证「能选中、能搜索」，字形一致度次之。
 */
function drawUserTextsPdf(page: PDFPage, src: Page, font: PDFFont, pageH: number): void {
  const texts = (src.texts || []).filter((t) => t.source === "user" && (t.text || "").trim());
  if (!texts.length) return;
  /*
   * 纸宽换回页面坐标（794 那套）：textwrap 里的排版规则全程用页面坐标，
   * 量的宽度也换成页面坐标（除以 PT_PER_UNIT），画的时候再乘回去。
   * 混着单位算的话，「折行宽度」和「字体度量」会差 25%，右边一截照样出纸。
   */
  const pageWUnits = page.getWidth() / PT_PER_UNIT;
  for (const t of texts) {
    const sizePt = (t.size || 14) * PT_PER_UNIT;
    const color = parseColor(t.color);
    /*
     * 折行 + 位置夹取都交给 layoutUserText。
     *
     * 只折行不夹位置是不够的：pdf-lib 不认页边界，基线排在 y=1100 的批注
     * 折成 4 行后，下面 3 行整个落在 /MediaBox 之外，阅读器直接不显示
     * ——横向裁字的问题解决了，纵向又漏一行，症状一样是「字不完整」。
     */
    const l = layoutUserText(
      // width 必须一起传：屏幕侧按用户拖过的宽度折行，导出不传就会静默按纸宽折
      { x: t.x, y: t.y, size: t.size || 14, text: t.text, width: t.width },
      pageWUnits,
      pageH,
      // 度量换算成页面坐标，跟 maxWidth / x / y 同一套单位
      (s) => font.widthOfTextAtSize(s, sizePt) / PT_PER_UNIT
    );
    for (let i = 0; i < l.lines.length; i += 1) {
      const line = l.lines[i];
      if (!line) continue;
      const y = l.y + i * l.lineHeight;
      page.drawText(line, {
        x: l.x * PT_PER_UNIT,
        y: (pageH - y) * PT_PER_UNIT,
        size: sizePt,
        font,
        color,
      });
    }
  }
}

export async function exportBookPdf(
  vault: Vault,
  editor: BookEditor,
  file: TFile,
  scale = 2
): Promise<string> {
  const state = editor.getState();
  new Notice(`正在导出 ${state.pageCount} 页 PDF…`, 3000);
  // 等底图加载完，否则导出的 PDF 会缺内容
  await editor.waitBackgrounds(
    Array.from({ length: state.pageCount }, (_, i) => i),
    scale
  );

  const doc = await PDFDocument.create();
  const pages = editor.store.data.pages;
  const pageH = editor.store.data.height;

  /*
   * 三期第 2 步（INK-102）：用户批注也走矢量。
   *
   * 之前批注是跟笔迹一起烤在位图里的，导出后一个字都选不中。
   * 现在从位图层剥离出来，用嵌入的中文字体 drawText 画在**最上面**——
   * 层序跟屏幕一致（底图 → 笔迹 → 文字），批注也能选中、能搜索。
   *
   * 字体只在真有批注时才嵌：一本纯手写的本子不该为它多背一份字体。
   */
  const hasUserText = pages.some((p) =>
    (p?.texts || []).some((t) => t.source === "user" && (t.text || "").trim())
  );
  let zhFont: PDFFont | null = null;
  /*
   * 字体能写出的码点集合。必须来自 fontkit 直接解析字体文件（见 fontasset.ts），
   * 不能依赖 PDFFont.getCharacterSet()：那是随 embedder 变的非公开 API。
   * 拿不到时**按保守处理**（当作"全都不支持" → 整页退回位图），绝不乐观放行。
   */
  let charset: Set<number> | null = hasUserText ? chineseCharacterSet() : null;
  if (hasUserText) {
    try {
      doc.registerFontkit(fontkit);
      /*
       * 这里必须是 subset: false —— 不能再对已经手工子集化的 TTF 做二次子集化。
       *
       * INK-118（用户真机：「打了 4 个字，导出 PDF 只显示 2 个，字体断断续续」）：
       * assets/NotoSansSC-subset.ttf 是构建期按 GB2312 手工子集好的 TTF，
       * 它的 glyf 各字形长度可以是奇数。pdf-lib 的 subset:true 会调 fontkit 的
       * TTFSubset，把这些字形「按原始字节长度原样拼接」成一份新字体；新字体较小，
       * head.indexToLocFormat 会退化成 0（short loca），而 loca.preEncode() 对每个
       * offset 做 `>>> 1`（只存半偏移）。奇数长度的字形会把后面所有边界向左吞掉
       * 1 字节，CID 读到的是错位的 numberOfContours（实测 -28160 / 11776 之类），
       * 阅读器画不出这些字形 —— 于是「4 个字只显示 2 个」，且缺哪些字随整本书的
       * 字形登记顺序变化，看起来断断续续。
       *
       * 更要命的是 ToUnicode CMap 是按「登记过的字符」生成的，跟 glyf 字节无关：
       * 抽回的文字一个不少，视觉上却是空白。上一轮只验 getTextContent() 的断言
       * 因此全绿也没抓到（见 test/pdftext-harness.ts 的像素级逐字检查）。
       *
       * 关掉二次子集化后，嵌入的就是构建期那份完整手工子集字体（long loca，
       * indexToLocFormat=1），字形边界不再被截断。代价是每份导出 PDF 多约
       * 1.2MB（字体本来就已内联进 main.js，插件包体积不变）；相对「看得见的字
       * 导出后消失」，按「内容不丢第一原则」这个体积可以接受。
       */
      zhFont = await doc.embedFont(chineseFontBytes(), { subset: false });
    } catch (e) {
      // 嵌字体失败不能让导出整个失败：退回"文字烤进位图"，至少内容不丢
      console.warn("[inkbook] 嵌入中文字体失败，批注将按图片导出", e);
      zhFont = null;
    }
  }

  /**
   * 这一页的批注里有没有字体写不出的字（生僻字、emoji）。
   *
   * 子集只覆盖 GB2312，遇到集外字硬画会变成空白或方块——
   * 那比"文字不可选"更糟（内容看起来像丢了）。这种页整页退回位图，
   * 批注照样看得见，只是选不中。
   *
   * `charset` 为 null 表示字符集解析失败（字体文件异常 / fontkit 不可用）：
   * 此时返回 true（**保守**），让所有带批注的页都退回位图。绝不能返回 false
   * 乐观放行 —— 那会把集外字送进矢量层画成 .notdef，同时位图层又不画，字就丢了。
   *
   * 抽成纯函数是为了能在 pdftext-harness.ts 里直接断言这个保守分支，
   * 而不是只能靠"字体正常时侥幸没走到"来间接验证。
   */
  const hasUnsupported = (p: Page | undefined): boolean =>
    pageHasUnsupportedChars(p?.texts, charset);

  /** 原 PDF 文件只解析一次（同一份 PDF 可能有很多页） */
  const srcDocs = new Map<string, PDFDocument | null>();
  let vectorPages = 0;
  let textPages = 0;
  let fallbackPages = 0;

  for (let i = 0; i < state.pageCount; i++) {
    const page = pages[i];
    const pdfRef = page?.background?.pdf;
    /* 这一页的批注能不能写成矢量文字？写不了就烤进位图（内容不能丢） */
    const vectorText = !!zhFont && !hasUnsupported(page);
    if (zhFont && !vectorText) fallbackPages += 1;
    const canvasWithText = !vectorText;
    let done = false;

    /*
     * 三期（INK-102 第一步）：PDF 底图页保留**矢量**。
     *
     * 老做法是把整页画成 canvas 贴成图片，原文自然不可选、不可搜。
     * 现在用 pdf-lib 的 copyPages 把原页整页搬进导出文档，
     * 再把笔迹/手写文字做成**透明 PNG** 叠上去——原文这层始终是矢量。
     */
    if (pdfRef) {
      if (!srcDocs.has(pdfRef.path)) {
        const bytes = await editor.readPdfBytes(pdfRef.path);
        let loaded: PDFDocument | null = null;
        if (bytes) {
          try {
            loaded = await PDFDocument.load(bytes, {
              ignoreEncryption: true,
              updateMetadata: false,
            });
          } catch (e) {
            console.warn("[inkbook] 原 PDF 解析失败，这几页退回位图", pdfRef.path, e);
          }
        }
        srcDocs.set(pdfRef.path, loaded);
      }
      const src = srcDocs.get(pdfRef.path);
      const bg = page.background;
      if (src && bg && pdfRef.page >= 1 && pdfRef.page <= src.getPageCount()) {
        try {
          const [copied] = await doc.copyPages(src, [pdfRef.page - 1]);
          /*
           * 旋转过的页（扫描件常见 /Rotate 90）不能用这条路径：
           * Form XObject 不带 /Rotate，画上去会横过来。宁可退回位图也不错页。
           */
          const rot = Math.abs(Number((copied as any).getRotation?.()?.angle ?? 0)) % 360;
          if (rot === 0) {
            const out = doc.addPage([A4_W, A4_H]);
            // drawPage 要的是"嵌入页"（embedPage），不是 copyPages 得到的 PDFPage
            const embedded = await doc.embedPage(copied);
            out.drawPage(embedded, {
              x: bg.x * PT_PER_UNIT,
              // PDF 的 y 轴朝上：页面坐标系里"距顶部 bg.y"要翻成"距底部"
              y: (pageH - bg.y - bg.height) * PT_PER_UNIT,
              width: bg.width * PT_PER_UNIT,
              height: bg.height * PT_PER_UNIT,
            });
            const overlay = editor.exportOverlayCanvas(i, scale, canvasWithText);
            const png = await doc.embedPng(overlay.toDataURL("image/png"));
            out.drawImage(png, { x: 0, y: 0, width: A4_W, height: A4_H });
            if (vectorText && zhFont) {
              drawUserTextsPdf(out, page, zhFont, pageH);
              textPages += 1;
            }
            vectorPages += 1;
            done = true;
          }
        } catch (e) {
          console.warn("[inkbook] 复制原 PDF 页失败，这一页退回位图", e);
        }
      }
    }

    if (!done) {
      const canvas = editor.exportPageCanvas(i, scale, canvasWithText);
      const png = await doc.embedPng(canvas.toDataURL("image/png"));
      const out = doc.addPage([A4_W, A4_H]);
      out.drawImage(png, { x: 0, y: 0, width: A4_W, height: A4_H });
      if (vectorText && zhFont) {
        drawUserTextsPdf(out, page, zhFont, pageH);
        textPages += 1;
      }
    }
  }

  const bytes = await doc.save();
  const folder = file.parent && file.parent.path !== "/" ? file.parent.path + "/" : "";
  const base = safeName(file.basename);
  let name = `${base}-手写本.pdf`;
  let n = 1;
  while (await vault.adapter.exists(folder + name)) {
    name = `${base}-手写本 ${++n}.pdf`;
  }
  await vault.adapter.writeBinary(
    folder + name,
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  );

  const notes: string[] = [];
  if (vectorPages) notes.push(`${vectorPages} 页保留了 PDF 原文，可选中可搜索`);
  if (textPages) notes.push(`${textPages} 页的批注文字可选中`);
  if (fallbackPages) {
    notes.push(`${fallbackPages} 页批注含生僻字，按图片导出（看得见但选不中）`);
  }
  new Notice(
    `已导出：${folder}${name}` + (notes.length ? `（${notes.join("；")}）` : ""),
    7000
  );
  return folder + name;
}
