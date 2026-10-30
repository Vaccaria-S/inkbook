import { Notice, type TFile, type Vault } from "obsidian";
import { PDFDocument } from "pdf-lib";
import type { BookEditor } from "./editor";

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

/** 页面坐标系（794×1123）→ A4 的 pt（595.28×841.89），比例正好 0.7497 */
const PT_PER_UNIT = 595.28 / 794;
const A4_W = 595.28;
const A4_H = 841.89;

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
  /** 原 PDF 文件只解析一次（同一份 PDF 可能有很多页） */
  const srcDocs = new Map<string, PDFDocument | null>();
  let vectorPages = 0;

  for (let i = 0; i < state.pageCount; i++) {
    const page = pages[i];
    const pdfRef = page?.background?.pdf;
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
            const overlay = editor.exportOverlayCanvas(i, scale);
            const png = await doc.embedPng(overlay.toDataURL("image/png"));
            out.drawImage(png, { x: 0, y: 0, width: A4_W, height: A4_H });
            vectorPages += 1;
            done = true;
          }
        } catch (e) {
          console.warn("[inkbook] 复制原 PDF 页失败，这一页退回位图", e);
        }
      }
    }

    if (!done) {
      const canvas = editor.exportPageCanvas(i, scale);
      const png = await doc.embedPng(canvas.toDataURL("image/png"));
      const out = doc.addPage([A4_W, A4_H]);
      out.drawImage(png, { x: 0, y: 0, width: A4_W, height: A4_H });
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
  new Notice(
    `已导出：${folder}${name}` +
      (vectorPages ? `（${vectorPages} 页保留了 PDF 原文，可选中可搜索）` : ""),
    7000
  );
  return folder + name;
}
