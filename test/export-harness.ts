/**
 * 导出 PDF 的矢量保真（INK-102 第一步）。
 *
 * 用户要的是：导出的 PDF 在系统阅读器里**能选中、能搜索原文**，
 * 而不是整页糊成一张图。
 *
 * 这个套件验证三件事：
 *   1. 有 PDF 底图的页：导出页里能抽出文字（原页是矢量搬过去的）；
 *   2. 纯手写页：仍然走位图，内容不丢；
 *   3. 笔迹/手写文字是透明叠加层，不会把原文糊死（导出页仍能抽到文字）。
 */
import { BookEditor } from "../src/editor";
import { BookStore } from "../src/store";
import { createBook, createPage, type Stroke } from "../src/types";
import { exportBookPdf } from "../src/export";
import { fitBackground, initPdfjs, openPdf } from "../src/pdf";

const lines: string[] = [];
const out = document.getElementById("out")!;
const log = (s: string) => {
  lines.push(s);
  out.textContent = lines.join("\n");
};
let failures = 0;
const pass = (ok: boolean, label: string) => {
  if (!ok) failures++;
  log((ok ? "PASS " : "FAIL ") + label);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PDF_URL = "/test/sample.pdf";

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

/** 一条横贯页面的笔迹，确保导出后能看出"叠加层画上去了" */
function makeStroke(): Stroke {
  return {
    id: "s1",
    tool: "pen",
    color: "#1A1A1A",
    size: 6,
    opacity: 1,
    points: [
      [120, 200, 0.5],
      [300, 240, 0.5],
      [520, 260, 0.5],
    ],
  };
}

async function main() {
  /* -------------------- 准备原件 -------------------- */
  const res = await fetch(PDF_URL);
  const srcBytes = new Uint8Array(await res.arrayBuffer());
  pass(srcBytes.length > 1000, "拿到 sample.pdf（" + srcBytes.length + " 字节）");

  const size = { width: 595.28, height: 841.89 };
  const fit = fitBackground(size.width, size.height, 0);

  const book = createBook("导出测试", "blank", "white");
  book.pages = [];
  // 第 1 页：PDF 原文 + 一条手写笔迹
  const p1 = createPage("blank", "white");
  p1.background = {
    pdf: { path: PDF_URL, page: 1 },
    sourceName: "sample.pdf",
    sourcePage: 1,
    x: fit.x,
    y: fit.y,
    width: fit.width,
    height: fit.height,
  };
  p1.layers[0].strokes.push(makeStroke());
  book.pages.push(p1);
  // 第 2 页：纯手写（应该走位图路径）
  book.pages.push(createPage("grid", "white"));

  /* -------------------- vault 桩 -------------------- */
  const written = new Map<string, Uint8Array>();
  const files = new Map<string, ArrayBuffer>();
  files.set(PDF_URL, srcBytes.buffer as ArrayBuffer);
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

  /* -------------------- 导出 -------------------- */
  const file = {
    path: "导出测试.inkbook",
    basename: "导出测试",
    parent: { path: "" },
  } as any;
  const t0 = performance.now();
  const outPath = await exportBookPdf(vault, editor, file, 2);
  const ms = performance.now() - t0;
  const bytes = written.get(outPath);
  pass(!!bytes && bytes.length > 10000, "导出了 " + (bytes?.length ?? 0) + " 字节（" + ms.toFixed(0) + "ms）");

  /* -------------------- 用 pdf.js 读回来验原文 -------------------- */
  const pdfjs = initPdfjs();
  const doc = await pdfjs.getDocument({ data: bytes!.slice() }).promise;
  pass(doc.numPages === 2, "导出的 PDF 有 " + doc.numPages + " 页");

  const page1 = await doc.getPage(1);
  const tc = await page1.getTextContent();
  const text1 = (tc.items as any[]).map((it) => it.str || "").join("");
  pass(
    text1.length > 50,
    "第 1 页（PDF 原文页）能抽出文字：" + text1.length + " 字"
  );

  /*
   * 最强的断言：**导出页的文字量要和原 PDF 一致**。
   * 只要原文是"整页位图"，这里就一个字都抽不到；反过来，
   * 抽到的字数对得上就说明 copyPages 真的把矢量搬过去了。
   */
  const probe = await openPdf(PDF_URL);
  const srcPage = await probe.getPage(1);
  const srcTc = await srcPage.getTextContent();
  const srcText = (srcTc.items as any[]).map((it) => it.str || "").join("");
  pass(
    srcText.length > 0 &&
      Math.abs(srcText.length - text1.length) / srcText.length < 0.1,
    "导出页文字量与原 PDF 一致（原 " +
      srcText.length +
      " 字 vs 导出 " +
      text1.length +
      " 字）"
  );
  await probe.destroy();

  const page2 = await doc.getPage(2);
  const tc2 = await page2.getTextContent();
  pass(((tc2.items as any[]) ?? []).length === 0, "第 2 页（纯手写）没有可抽文字，符合预期");

  // 两页都应该有内容（图片或矢量），不能是空白页
  const op1 = await page1.getOperatorList();
  const op2 = await page2.getOperatorList();
  pass(op1.fnArray.length > 20, "第 1 页有实际绘制指令（" + op1.fnArray.length + "）");
  pass(op2.fnArray.length > 5, "第 2 页有实际绘制指令（" + op2.fnArray.length + "）");

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
