/**
 * 导入 PDF / Word 到手写本。
 *
 * PDF 采用**按需渲染**：
 *   导入时只记录"第几页来自哪个 PDF"，不渲染任何像素。
 *   翻到哪一页，编辑器才去渲染那一页。
 *
 * 好处很直接：
 *   - 300 页 PDF 的导入是瞬时的（而不是阻塞几分钟）
 *   - 磁盘零膨胀（不会在库里堆 300 个 PNG）
 *   - 内存由 LRU 缓存封顶，翻一百页也不会撑爆
 *
 * Word 文档的文字量有限，仍然渲染成静态图存盘——但改成
 * 逐页流式处理，不会把所有页的 dataURL 一次性堆在内存里。
 */

import { Notice, TFile, type App } from "obsidian";
import {
  A4_HEIGHT,
  A4_WIDTH,
  createPage,
  uid,
  type InkBook,
  type Page,
  type PageBackground,
} from "./types";
import { extractPdfText, fitBackground, openPdf, pdfPageSize, type PdfDoc } from "./pdf";
import { parseDocxParagraphs, readZipText, renderDocxToPages } from "./word";

export type ImportKind = "pdf" | "word";

/** 资源文件夹名（放在 .inkbook 同级） */
const ASSET_DIR = ".inkbook-assets";

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.split(",")[1] || "";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 把 PNG dataURL 存到库里。
 *
 * `written` 传入时，路径会在**写盘之前**就记进去：调用方靠它做失败回滚。
 * 提前记的理由是「写到一半失败」——那时文件可能已经存在（半截），
 * 也必须被清掉。清不掉最多留个脏文件，比漏删好。
 */
async function saveAsset(
  app: App,
  bookPath: string,
  name: string,
  dataUrl: string,
  written?: string[]
): Promise<string> {
  const folder = bookPath.includes("/") ? bookPath.slice(0, bookPath.lastIndexOf("/")) : "";
  const dir = folder ? `${folder}/${ASSET_DIR}` : ASSET_DIR;
  if (!app.vault.getAbstractFileByPath(dir)) {
    try {
      await app.vault.createFolder(dir);
    } catch (_) {
      await app.vault.adapter.mkdir(dir);
    }
  }
  const fileName = `${name}.png`;
  let path = `${dir}/${fileName}`;
  let n = 1;
  while (await app.vault.adapter.exists(path)) {
    path = `${dir}/${name}-${++n}.png`;
  }
  written?.push(path);
  const bytes = dataUrlToBytes(dataUrl);
  await app.vault.adapter.writeBinary(
    path,
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  );
  return path;
}

/** 从 vault 里读文件二进制 */
async function readFileBytes(app: App, file: TFile): Promise<Uint8Array> {
  const buf = await app.vault.adapter.readBinary(file.path);
  return new Uint8Array(buf);
}

/** 把库里的相对路径转成可加载的 URL */
export function assetUrl(app: App, path: string): string {
  const adapter = (app as any).vault?.adapter;
  if (adapter?.getResourcePath) {
    try {
      return adapter.getResourcePath(path);
    } catch (_) {}
  }
  return path;
}

export interface ImportResult {
  pages: Page[];
  source: InkBook["source"];
}

/**
 * 打开 PDF 只为读页数（不建页、不抽文字）。
 *
 * 用于「导入前问页码范围」：页数要打开文档才知道，但 pdf.js 只读
 * 目录结构、不光栅化，所以这一步很快。
 *
 * **返回已打开的 doc**（而不是只返回数字）—— 调用方拿到后可以直接
 * 传给 `importPdf` 复用，避免同一个几十 MB 的 PDF 被读两遍。
 * 用完必须自己 `destroy()`（或交给 importPdf，它会负责释放）。
 *
 * @returns `{ doc, total }`；读不出来（加密 / 损坏）时 `doc` 为 null
 */
export async function peekPdf(
  app: App,
  file: TFile
): Promise<{ doc: PdfDoc | null; total: number }> {
  try {
    const doc = await openPdf(assetUrl(app, file.path));
    return { doc, total: doc.numPages || 0 };
  } catch (_) {
    return { doc: null, total: 0 };
  }
}

/**
 * 导入进度回调。
 *
 * **两个阶段的量纲不一样**，调用方要分开显示：
 *   · `loading`：pdf.js 在读文件，`done`/`total` 是**字节数**；
 *   · `pages`：在建页并抽文字，`done`/`total` 是**页数**。
 *
 * 老实现只给 `(done, total)` 两个数字，调用方没法区分，于是把字节数
 * 当成页数显示成「正在读取 PDF：52428800/69500000 页」。
 */
export type ImportProgress = (
  phase: "loading" | "pages",
  done: number,
  total: number
) => void;

/** 把字节数说成人话（进度提示用，不需要精确） */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 MB";
  const mb = n / 1048576;
  if (mb >= 1024) return (mb / 1024).toFixed(1) + " GB";
  if (mb >= 10) return mb.toFixed(0) + " MB";
  return mb.toFixed(1) + " MB";
}

/**
 * 把 PDF 导入成页面。
 *
 * **不渲染任何像素**——只建立"页 → PDF 页码"的映射。
 * 真正的渲染推迟到用户翻到那一页时。
 *
 * @param range 要导入的页码范围（1 起、闭区间）。不传 = 整本。
 */
export async function importPdf(
  app: App,
  file: TFile,
  bookPath: string,
  range?: { from: number; to: number },
  onProgress?: ImportProgress,
  /** 是否抽取文字层（默认抽；扫描版没有文字层，抽出来是空） */
  extract = true,
  /**
   * 已经打开好的文档（由 `peekPdf` 返回）。
   *
   * 传了就直接用，**不再自己 openPdf** —— 几十 MB 的 PDF 没必要读两遍。
   * 传了的话**本函数负责 destroy 它**（与不传时的行为一致）。
   */
  preopened?: PdfDoc | null
): Promise<ImportResult> {
  /*
   * 打开 PDF 只为拿页数和页面尺寸——这一步很快，
   * 因为 pdf.js 只读目录结构，不光栅化内容。
   */
  const url = assetUrl(app, file.path);
  const doc =
    preopened ??
    (await openPdf(url, (loaded, totalBytes) => {
      onProgress?.("loading", loaded, totalBytes);
    }));
  const total = doc.numPages;
  /*
   * 页码范围：不传就整本；传了就夹到 [1, total]。
   * 夹取放在这里而不是调用方 —— 调用方拿不到 total（要开文档才知道）。
   *
   * **传了非法范围就抛错，不静默退化成整本**（2026-11-07 修）：
   * 用户只想要 3 页却因为起止颠倒拿到 300 页，比报个错难收拾得多。
   * 调用方（导入流程）自己有兜底 —— 它只在页数 > 阈值时才传范围，
   * 拿到错误会提示用户。
   */
  let from = 1;
  let to = total;
  if (range) {
    const a = Math.floor(Number(range.from));
    const b = Math.floor(Number(range.to));
    if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) {
      try {
        await doc.destroy();
      } catch (_) {
        /* 释放失败无所谓 */
      }
      throw new Error(`页码范围不合法（${range.from}–${range.to}）`);
    }
    from = Math.max(1, Math.min(total, a));
    to = Math.max(1, Math.min(total, b));
  }
  const limit = to - from + 1;

  const pages: Page[] = [];
  for (let k = 0; k < limit; k++) {
    // PDF 里的真实页码（1 起）；`k` 只是本次导入的第几页
    const i = from + k;
    const page = createPage("blank", "white");
    const size = await pdfPageSize(doc, i);
    const fit = fitBackground(size.width, size.height, 0);
    const bg: PageBackground = {
      pdf: { path: file.path, page: i },
      sourceName: file.name,
      sourcePage: i,
      x: fit.x,
      y: fit.y,
      width: fit.width,
      height: fit.height,
      kind: "pdf",
    };
    page.background = bg;

    /*
     * 文字层（v2）：把这一页的原文抽出来存进本子。
     *
     * 为什么不"用的时候再抽"：原文抽出来之后，即使 PDF 被移动、
     * 删除，或换设备打开，文字仍然可选、可搜、可导出。
     * 抽不到（扫描版 PDF）就跳过，页面照常显示底图。
     */
    if (extract) {
      try {
        const lines = await extractPdfText(doc, i);
        if (lines.length) {
          const sx = size.width > 0 ? fit.width / size.width : 1;
          const sy = size.height > 0 ? fit.height / size.height : 1;
          page.texts = lines.map((t) => ({
            id: uid("text"),
            source: "pdf" as const,
            x: fit.x + t.x * sx,
            y: fit.y + t.y * sy,
            size: Math.max(1, t.size * sy),
            text: t.text,
            width: Math.max(0, t.width * sx),
          }));
        }
      } catch (_) {
        // 单页抽取失败不影响导入：底图照旧，只是这页文字不可选
      }
    }

    pages.push(page);
    onProgress?.("pages", k + 1, limit);
  }

  // 立刻释放 PDF 文档句柄——渲染时会重新打开
  try {
    await doc.destroy();
  } catch (_) {}

  return {
    pages,
    source: { name: file.name, kind: "pdf", pageCount: total, path: file.path },
  };
}

/**
 * 把 Word 导入成页面。
 *
 * Word 的文字量可控，渲染成静态图存盘最省事。
 * 但改成**逐页处理**：渲染一页存一页，不把所有 dataURL 堆在内存里。
 */
export async function importWord(
  app: App,
  file: TFile,
  bookPath: string,
  onProgress?: ImportProgress
): Promise<ImportResult> {
  const bytes = await readFileBytes(app, file);
  const xml = await readZipText(bytes, "word/document.xml");
  if (!xml) throw new Error("这不是 Word 文档（.docx），缺少 word/document.xml");

  const paras = parseDocxParagraphs(xml);
  if (!paras.length) throw new Error("文档里没有找到文字内容");

  const base = file.basename.replace(/[^\w一-龥-]/g, "_");
  const pages: Page[] = [];
  /*
   * 本次实际写进去的图片路径。任何一页失败都要把它们删掉（见 catch）：
   * 否则导入失败会在 `.inkbook-assets` 里留下一堆孤儿 PNG，用户看不到、
   * 也删不掉，只会在同步和磁盘占用上一直碍事。
   *
   * **只删本次写的**：不能用 `${base}-p*` 前缀批量删 —— 同一个 Word
   * 之前成功导入过的话，那些图正被旧本子用着（saveAsset 的 -2 去重
   * 就是为同名共存准备的）。
   */
  const written: string[] = [];
  try {
    // 逐页渲染：拿到一页就立刻存盘，然后丢掉它的 dataURL
    let pageNo = 0;
    for await (const shot of renderDocxToPages(paras)) {
      pageNo++;
      const fit = fitBackground(shot.width, shot.height, 0);
      const assetPath = await saveAsset(
        app,
        bookPath,
        `${base}-p${pageNo}`,
        shot.dataUrl,
        written
      );

      const page = createPage("blank", "white");
      page.background = {
        src: assetPath,
        sourceName: file.name,
        sourcePage: pageNo,
        x: fit.x,
        y: fit.y,
        width: fit.width,
        height: fit.height,
        kind: "word",
      };
      pages.push(page);
      /*
       * Word 的页数要渲染完才知道（每页文字量不同、分页是流式的），
       * 所以 `total` 传 **0 表示未知** —— 调用方据此只显示「已生成 N 页」，
       * 而不是永远「第 N/N 页」（看着像没进度）。
       */
      onProgress?.("pages", pageNo, 0);
      /*
       * 每 3 页让出一次事件循环：渲染 + 编码 + 写盘是连续的重活，
       * 中间不让出的话，平板上进度提示会一直不刷新（看着像卡死）。
       */
      if (pageNo % 3 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  } catch (e) {
    for (const p of written.reverse()) {
      try {
        await app.vault.adapter.remove(p);
      } catch (_) {
        /* 删不掉就留着，不能因为清理失败把原始错误盖掉 */
      }
    }
    throw e;
  }

  return {
    pages,
    source: { name: file.name, kind: "word", pageCount: pages.length },
  };
}

/**
 * 把导入的页面追加到手写本里。
 * 已有内容保留，导入的页面接在后面。
 */
export function appendImportedPages(
  book: InkBook,
  imported: ImportResult,
  startIndex: number
): void {
  const pages = imported.pages;
  for (let i = 0; i < pages.length; i++) {
    book.pages.splice(startIndex + i, 0, pages[i]);
  }
  book.source = imported.source;
}

/** 导入时的提示文案 */
export function importNotice(kind: ImportKind, count: number, total: number): string {
  const name = kind === "pdf" ? "PDF" : "Word";
  if (count < total) return `已导入 ${count}/${total} 页${name}，其余可用「追加页」继续`;
  return `已导入 ${count} 页${name}`;
}

export { Notice, A4_HEIGHT, A4_WIDTH };
