/**
 * Word（.docx）解析与渲染。
 *
 * .docx 本质是个 zip，里面 word/document.xml 是正文。
 * 这里不引入第三方库：自己解开 zip（用浏览器自带的 DecompressionStream），
 * 自己按段落解析 w:p / w:r / w:t，再按 A4 版面画成图片当底图。
 */

import { A4_HEIGHT, A4_WIDTH, type Pt } from "./types";

/* ------------------------------- zip 解包 ------------------------------- */

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/**
 * 解析 zip 中央目录，拿到所有条目。
 * 只支持 deflate（方法 8）和 store（方法 0），够 .docx 用了。
 */
export function parseZip(bytes: Uint8Array): ZipEntry[] {
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
  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);

  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (bytes[off] !== 0x50 || bytes[off + 1] !== 0x4b) break;
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const name = new TextDecoder("utf-8").decode(bytes.subarray(off + 46, off + 46 + nameLen));

    // 局部头的 extra 长度可能与中央目录不同，要重新读
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);

    out.push({ name, data: method === 0 ? raw : raw }); // deflate 在下面解压
    (out[out.length - 1] as any)._method = method;
    (out[out.length - 1] as any)._raw = raw;

    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 用浏览器自带的 DecompressionStream 解 deflate */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** 解出 zip 里的某个文件（返回文本） */
export async function readZipText(bytes: Uint8Array, target: string): Promise<string | null> {
  const entries = parseZip(bytes);
  const hit = entries.find((e) => e.name === target);
  if (!hit) return null;
  const method = (hit as any)._method;
  const raw = (hit as any)._raw as Uint8Array;
  const data = method === 0 ? raw : await inflateRaw(raw);
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

/** 把段落排成 A4 页面，返回每页的行 */
function layout(paras: DocParagraph[]): string[][] {
  const pages: string[][] = [];
  let cur: string[] = [];
  let y = MARGIN;

  const pushPage = () => {
    pages.push(cur);
    cur = [];
    y = MARGIN;
  };

  for (const p of paras) {
    const size = p.level === 0 ? BODY_SIZE : BODY_SIZE + (5 - p.level) * 2;
    const indent = p.list ? 22 : p.level * 18;
    const maxW = A4_WIDTH - MARGIN * 2 - indent;

    // 粗略估算宽度：中文按 size，英文按 size*0.55
    const measure = (s: string) => {
      let w = 0;
      for (const ch of s) w += ch.charCodeAt(0) > 255 ? size : size * 0.55;
      return w;
    };

    if (!p.text.trim()) {
      if (y + LINE_H > A4_HEIGHT - MARGIN) pushPage();
      else y += LINE_H * 0.6;
      continue;
    }

    const prefix = p.list ? "• " : "";
    let line = prefix;
    let lineW = measure(line);
    const chars = [...p.text];

    for (const ch of chars) {
      const cw = measure(ch);
      if (lineW + cw > maxW) {
        if (y + size * 1.5 > A4_HEIGHT - MARGIN) {
          cur.push(line);
          pushPage();
          line = prefix;
          lineW = measure(line);
        } else {
          y += size * 1.5;
        }
        cur.push(line);
        line = prefix;
        lineW = measure(line);
      }
      line += ch;
      lineW += cw;
    }
    if (line.trim()) {
      cur.push(line);
      y += size * 1.5;
    }
    if (y + LINE_H > A4_HEIGHT - MARGIN) pushPage();
  }

  if (cur.length) pages.push(cur);
  return pages.length ? pages : [[]];
}

/**
 * 把 Word 段落渲染成一张张 A4 图片（PNG dataURL）。
 *
 * 用异步生成器逐页产出：调用方拿到一页就能立刻存盘，
 * 不必等所有页渲染完——避免几十页的文档把内存堆满。
 */
export async function* renderDocxToPages(
  paragraphs: DocParagraph[]
): AsyncGenerator<string> {
  const pages = layout(paragraphs);

  for (const lines of pages) {
    const canvas = document.createElement("canvas");
    // 用 3 倍分辨率：Word 底图是静态位图，放大后无法再升级，
    // 所以一次性渲染到足够高（3x 覆盖到 2.8 倍缩放仍有 1.07x 余量）
    const dpr = 3;
    canvas.width = A4_WIDTH * dpr;
    canvas.height = A4_HEIGHT * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, A4_WIDTH, A4_HEIGHT);

    let y = MARGIN;
    for (const line of lines) {
      ctx.fillStyle = "#1a1a1a";
      ctx.font = `${BODY_SIZE}px "Segoe UI", "Microsoft YaHei", sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(line, MARGIN, y);
      y += LINE_H;
    }
    yield canvas.toDataURL("image/png");
    // 立刻释放画布
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** 快速取 Word 的前 N 段文字（用于预览标题） */
export function previewText(paras: DocParagraph[], max = 60): string {
  const t = paras
    .map((p) => p.text)
    .filter(Boolean)
    .join(" ")
    .slice(0, max);
  return t;
}

export type { Pt };
