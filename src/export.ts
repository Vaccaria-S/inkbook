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
  for (let i = 0; i < state.pageCount; i++) {
    const canvas = editor.exportPageCanvas(i, scale);
    const png = await doc.embedPng(canvas.toDataURL("image/png"));
    const page = doc.addPage([595.28, 841.89]);
    page.drawImage(png, { x: 0, y: 0, width: 595.28, height: 841.89 });
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
  new Notice(`已导出：${folder}${name}`, 6000);
  return folder + name;
}
