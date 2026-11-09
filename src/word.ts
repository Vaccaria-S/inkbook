/**
 * Word（.docx）解析与渲染。
 *
 * .docx 本质是个 zip，里面 word/document.xml 是正文。
 * 这里不引入第三方库：自己解开 zip（用浏览器自带的 DecompressionStream），
 * 自己按段落解析 w:p / w:r / w:t，再按 A4 版面画成图片当底图。
 */

import { A4_HEIGHT, A4_WIDTH, type Pt } from "./types";
import { wrapText } from "./textwrap";

/* ------------------------------- zip 解包 ------------------------------- */

interface ZipEntry {
  name: string;
  /** 压缩方法：0 = store，8 = deflate，其余一律不支持 */
  method: number;
  /** 压缩后的原始字节（解压前） */
  raw: Uint8Array;
}

/**
 * 解析 zip 中央目录，拿到所有条目。
 * 只支持 deflate（方法 8）和 store（方法 0），够 .docx 用了。
 */
export function parseZip(bytes: Uint8Array): ZipEntry[] {
  /*
   * 老式 .doc（OLE 复合文档）和加了密码的 docx 都不是 zip。
   * 它们的文件头是 `D0 CF 11 E0`，直接说清楚比「找不到 zip 结构」有用得多。
   */
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  ) {
    throw new Error(
      "这个文件是 OLE 格式（老式 .doc，或加了密码的 .docx）。请用 Word / WPS 另存为 .docx（并取消密码）后再导入。"
    );
  }

  // 找 EOCD（End of Central Directory）
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 66000; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 docx（找不到 zip 结构）");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);

  /*
   * ZIP64（2026-11-08）。条目数 / 目录偏移超范围时，EOCD 里写的是
   * 哨兵值 0xFFFF / 0xFFFFFFFF，真实值在紧邻 EOCD 之前的 ZIP64 EOCD 里。
   *
   * 老代码直接用哨兵值当偏移：`bytes[0xFFFFFFFF]` 是 undefined，
   * 循环第一轮就 break，out 为空 —— 于是一个**合法**的大 docx 被报成
   * 「缺少 word/document.xml」，用户完全不知道发生了什么。
   * 正常 docx 几乎不会走到 ZIP64（几 MB 而已），但既然成本只有十几行，
   * 顺手兜住；真兜不住时也给一句能照做的中文，而不是内部术语。
   */
  if (count === 0xffff || off === 0xffffffff) {
    const locatorAt = eocd - 20;
    const hasLocator =
      locatorAt >= 0 && view.getUint32(locatorAt, true) === 0x07064b50;
    // ZIP64 EOCD 记录本身在 locator 的「相对偏移」字段里
    const z64 = hasLocator ? view.getUint32(locatorAt + 8, true) : -1;
    if (z64 < 0 || z64 + 56 > bytes.length) {
      throw new Error(
        "这个 Word 文档用了 ZIP64 格式，墨本暂不支持。请用 Word / WPS 另存为 .docx 后重试，或先导出 PDF 再导入。"
      );
    }
    // 低 32 位够用：单本 Word 不可能超过 4GB 条目数 / 偏移
    count = view.getUint32(z64 + 32, true);
    off = view.getUint32(z64 + 48, true);
  }

  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    /*
     * 目录被截断时 `getUint16(off + …)` 会抛
     * 「Offset is outside the bounds of the DataView」—— 英文内部错误。
     * 每轮先确认整个固定头都在文件内，再读。
     */
    if (off + 46 > bytes.length) {
      throw new Error("Word 文件不完整（zip 目录被截断）。请重新导出后再导入。");
    }
    if (bytes[off] !== 0x50 || bytes[off + 1] !== 0x4b) break;
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const name = new TextDecoder("utf-8").decode(bytes.subarray(off + 46, off + 46 + nameLen));

    // 局部头的 extra 长度可能与中央目录不同，要重新读
    if (localOff + 30 > bytes.length) {
      throw new Error("Word 文件不完整（条目头越界）。请重新导出后再导入。");
    }
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);

    out.push({ name, method, raw });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * 用浏览器自带的 DecompressionStream 解 deflate。
 *
 * `deflate-raw` 是 Compression Streams 规范里较早加入的格式，Chromium 103+
 * 才有。旧版安卓 WebView / 老 Electron 上要么没有 `DecompressionStream`，
 * 要么只认 `deflate` / `gzip` —— 直接 new 会抛 TypeError，而错误原文是
 * 「The provided value 'deflate-raw' is not a valid enum value…」，
 * 用户完全看不懂。这里换成能照做的中文提示。
 *
 * 注意：`deflate`（带 zlib 头 + Adler-32 校验）不能拿来解 raw 数据，
 * 所以没有「换个格式名重试」这种便宜兜底 —— 只能明确告诉用户升级或换文件。
 */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "当前系统的解压组件不支持 .docx（缺少 DecompressionStream）。请更新 Obsidian / 系统 WebView 后重试，或先把文档另存为 PDF 再导入。"
    );
  }
  let ds: DecompressionStream;
  try {
    ds = new DecompressionStream("deflate-raw");
  } catch (e) {
    throw new Error(
      "当前系统不支持解压 .docx（deflate-raw 格式不可用）。请更新 Obsidian / 系统 WebView 后重试，或先把文档另存为 PDF 再导入。"
    );
  }
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** 解出 zip 里的某个文件（返回文本） */
export async function readZipText(bytes: Uint8Array, target: string): Promise<string | null> {
  const entries = parseZip(bytes);
  const hit = entries.find((e) => e.name === target);
  if (!hit) return null;
  /*
   * **只认 store(0) 和 deflate(8)**（2026-11-08）。
   *
   * 老代码 `method === 0 ? raw : raw` 两边一样，等于所有非 0 方法
   * 都硬塞给 deflate。真遇上别的算法（12 = bzip2、99 = AES 加密）
   * 会抛各内核文案不一的底层错误（invalid stored block lengths /
   * TypeError），用户完全看不懂，也不知道下一步该做什么。
   */
  if (hit.method !== 0 && hit.method !== 8) {
    throw new Error(
      hit.method === 99
        ? "这个 .docx 是加密文档，墨本暂不支持。请在 Word 里取消密码后另存为 .docx，或先导出 PDF 再导入。"
        : `这个 .docx 用了不支持的压缩方式（method ${hit.method}）。请用 Word / WPS「另存为 .docx」后重试，或先导出 PDF。`
    );
  }
  let data: Uint8Array;
  if (hit.method === 0) {
    data = hit.raw;
  } else {
    try {
      data = await inflateRaw(hit.raw);
    } catch (e) {
      /*
       * inflateRaw 自己抛的是「系统不支持解压」这类可操作提示，
       * 别用通用文案盖掉它 —— 那种情况用户该去更新 WebView，
       * 而不是以为文件坏了。
       */
      const msg = String((e as any)?.message || e || "");
      if (msg.includes("解压") || msg.includes("DecompressionStream")) throw e;
      throw new Error("文档内容解压失败（文件可能已损坏）。请用 Word 另存为 .docx 后重试。");
    }
  }
  return new TextDecoder("utf-8").decode(data);
}

/* ------------------------------- docx 解析 ------------------------------- */

export interface DocParagraph {
  text: string;
  /** 段落级别：标题层级，0 = 正文 */
  level: number;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right" | "justify";
  /** 列表项 */
  list: boolean;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

/** 从 document.xml 里抽出段落 */
export function parseDocxParagraphs(xml: string): DocParagraph[] {
  const paras: DocParagraph[] = [];

  // 按 <w:p> 切分
  const pRe = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>|<w:p(?:\s[^>]*)?\/>/g;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(xml))) {
    const body = m[1] || "";

    // 段落属性
    const pPrMatch = body.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/);
    const pPr = pPrMatch ? pPrMatch[1] : "";
    const styleMatch = pPr.match(/<w:pStyle[^>]*w:val="([^"]+)"/);
    const style = styleMatch ? styleMatch[1].toLowerCase() : "";
    let level = 0;
    if (style.startsWith("heading")) {
      const n = parseInt(style.replace(/\D/g, ""), 10);
      level = Number.isFinite(n) ? Math.min(4, Math.max(1, n)) : 1;
    } else if (style === "title") {
      level = 0;
    }
    // <w:numPr> 可能带内容，也可能自闭合
    const numPr = /<w:numPr\b/.test(pPr);
    const jcMatch = pPr.match(/<w:jc[^>]*w:val="([^"]+)"/);
    const jc = jcMatch ? jcMatch[1] : "left";
    const align: DocParagraph["align"] =
      jc === "center" ? "center" : jc === "right" || jc === "end" ? "right" : jc === "both" ? "justify" : "left";

    // 文本与行内格式
    let text = "";
    let bold = false;
    let italic = false;
    const rRe = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g;
    let rm: RegExpExecArray | null;
    while ((rm = rRe.exec(body))) {
      const run = rm[1];
      const rPr = run.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/);
      const rPrBody = rPr ? rPr[1] : "";
      const isBold = /<w:b(?:\s[^>]*)?\/?>/.test(rPrBody);
      const isItalic = /<w:i(?:\s[^>]*)?\/?>/.test(rPrBody);
      const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>/g;
      let tm: RegExpExecArray | null;
      while ((tm = tRe.exec(run))) {
        if (tm[0].startsWith("<w:tab")) {
          text += "    ";
        } else {
          text += decodeXmlEntities(tm[1] ?? "");
        }
      }
      if (isBold) bold = true;
      if (isItalic) italic = true;
      // 换行
      if (/<w:br\s*\/>/.test(run)) text += "\n";
    }

    text = text.replace(/\s+$/, "");
    if (!text.trim() && !level) {
      // 空段落也保留一个换行，段落间距才对
      paras.push({ text: "", level: 0, bold: false, italic: false, align, list: numPr });
      continue;
    }
    paras.push({ text, level, bold, italic, align, list: numPr });
  }

  return paras;
}

/* ------------------------------- 排版渲染 ------------------------------- */

const MARGIN = 56;
const BODY_SIZE = 15;
const LINE_H = 24;

/** Word 页中一行文字的 A4 页面坐标；y 是基线，width 为真实画布字宽。 */
export interface DocxLine {
  text: string;
  x: number;
  y: number;
  size: number;
  width: number;
}

/** 排版与 PNG 绘制共用这一份行数据，导入的透明文字层也照此定位。 */
function layout(paras: DocParagraph[], ctx: CanvasRenderingContext2D): DocxLine[][] {
  const pages: DocxLine[][] = [];
  let cur: DocxLine[] = [];
  let y = MARGIN;

  const pushPage = () => {
    pages.push(cur);
    cur = [];
    y = MARGIN;
  };

  for (const p of paras) {
    const size = p.level === 0 ? BODY_SIZE : BODY_SIZE + (5 - p.level) * 2;
    const indent = p.list ? 22 : p.level * 18;
    const x = MARGIN + indent;
    const maxW = A4_WIDTH - MARGIN - x;
    ctx.font = `${size}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    const measure = (s: string) => ctx.measureText(s).width;

    if (!p.text.trim()) {
      if (y + LINE_H > A4_HEIGHT - MARGIN) pushPage();
      else y += LINE_H * 0.6;
      continue;
    }

    const prefix = p.list ? "• " : "";
    // 行折分只用 textwrap.ts 的规则；分页、字号、坐标在此逐行确定。
    const lines = wrapText(prefix + p.text, maxW, measure);
    for (const text of lines) {
      if (y + size > A4_HEIGHT - MARGIN && cur.length) pushPage();
      if (text) cur.push({ text, x, y: y + size, size, width: measure(text) });
      y += size * 1.5;
    }
    if (y + LINE_H > A4_HEIGHT - MARGIN) pushPage();
  }

  if (cur.length) pages.push(cur);
  return pages.length ? pages : [[]];
}

/** 渲染出的一页：图片 + 像素尺寸（尺寸由渲染方直接给出，省一次解码） */
export interface RenderedDocxPage {
  dataUrl: string;
  width: number;
  height: number;
  /** 坐标仍是 794×1123 页面单位，不随 PNG 的 3x 像素倍率变化。 */
  lines: DocxLine[];
}

/**
 * 把 Word 段落渲染成一张张 A4 图片（PNG dataURL）。
 *
 * 用异步生成器逐页产出：调用方拿到一页就能立刻存盘，
 * 不必等所有页渲染完——避免几十页的文档把内存堆满。
 *
 * **画布必须在 yield 之前释放**（2026-11-08）。老代码是先 yield 再
 * `canvas.width = 0`，但生成器的 yield 是**把控制权交回调用方**：
 * 调用方解码 dataURL、写盘的那几帧里，这张 794×1123×3² ≈ 800 万像素、
 * 约 32MB 的画布还活着。再叠加调用方为量尺寸解码出的 Image（又 32MB），
 * 低端平板会直接 OOM。现在先 toDataURL、立刻清画布，再把尺寸一起带出去
 * ——调用方不必再解码一次。
 */
export async function* renderDocxToPages(
  paragraphs: DocParagraph[]
): AsyncGenerator<RenderedDocxPage> {
  // 用同一款浏览器字体度量和绘制，避免估算行宽造成透明选择层错位。
  const measureCanvas = document.createElement("canvas");
  const pages = layout(paragraphs, measureCanvas.getContext("2d")!);
  measureCanvas.width = 0;

  for (const lines of pages) {
    const canvas = document.createElement("canvas");
    // 用 3 倍分辨率：Word 底图是静态位图，放大后无法再升级，
    // 所以一次性渲染到足够高（3x 覆盖到 2.8 倍缩放仍有 1.07x 余量）
    const dpr = 3;
    const width = A4_WIDTH * dpr;
    const height = A4_HEIGHT * dpr;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, A4_WIDTH, A4_HEIGHT);

    for (const line of lines) {
      ctx.fillStyle = "#1a1a1a";
      ctx.font = `${line.size}px "Segoe UI", "Microsoft YaHei", sans-serif`;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(line.text, line.x, line.y);
    }
    const dataUrl = canvas.toDataURL("image/png");
    // 先释放画布，再把结果交出去（见上方说明）
    canvas.width = 0;
    canvas.height = 0;
    yield { dataUrl, width, height, lines };
  }
}

export type { Pt };
