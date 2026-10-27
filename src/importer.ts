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
  type InkBook,
  type Page,
  type PageBackground,
} from "./types";
import { fitBackground, openPdf, pdfPageSize } from "./pdf";
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

/** 把 PNG dataURL 存到库里 */
async function saveAsset(
  app: App,
  bookPath: string,
  name: string,
  dataUrl: string
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
 * 把 PDF 导入成页面。
 *
 * **不渲染任何像素**——只建立"页 → PDF 页码"的映射。
 * 真正的渲染推迟到用户翻到那一页时。
 *
 * @param pageLimit 最多导入多少页（0 = 全部）
 */
export async function importPdf(
  app: App,
  file: TFile,
  bookPath: string,
  pageLimit = 0,
  onProgress?: (done: number, total: number) => void
): Promise<ImportResult> {
  // 打开 PDF 只为拿页数和页面尺寸——这一步很快，
  // 因为 pdf.js 只读目录结构，不光栅化内容。
  const url = assetUrl(app, file.path);
  const doc = await openPdf(url, onProgress);
  const total = doc.numPages;
  const limit = pageLimit > 0 ? Math.min(pageLimit, total) : total;

  const pages: Page[] = [];
  for (let i = 1; i <= limit; i++) {
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
    pages.push(page);
    onProgress?.(i, limit);
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
  onProgress?: (done: number, total: number) => void
): Promise<ImportResult> {
  const bytes = await readFileBytes(app, file);
  const xml = await readZipText(bytes, "word/document.xml");
  if (!xml) throw new Error("这不是 Word 文档（.docx），缺少 word/document.xml");

  const paras = parseDocxParagraphs(xml);
  if (!paras.length) throw new Error("文档里没有找到文字内容");

  const base = file.basename.replace(/[^\w一-龥-]/g, "_");
  const pages: Page[] = [];

  // 逐页渲染：拿到一页就立刻存盘，然后丢掉它的 dataURL
  let pageNo = 0;
  for await (const dataUrl of renderDocxToPages(paras)) {
    pageNo++;
    const img = await loadImageSize(dataUrl);
    const fit = fitBackground(img.w, img.h, 0);
    const assetPath = await saveAsset(app, bookPath, `${base}-p${pageNo}`, dataUrl);

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
    onProgress?.(pageNo, pageNo);
  }

  return {
    pages,
    source: { name: file.name, kind: "word", pageCount: pages.length },
  };
}

/** 读一张 dataURL 图片的像素尺寸 */
export function loadImageSize(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = dataUrl;
  });
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
