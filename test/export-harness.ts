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
import { chineseFontBytes } from "../src/fontasset";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
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
  /*
   * 三期第 2 步的关键样本：一条**中文批注**。
   * 导出后它必须能作为文字被抽出来（而不是烤在图片里），
   * 否则「用户自己加的字也能选中」这条就没做成。
   */
  p1.texts = [
    {
      id: "t1",
      source: "user",
      x: 80,
      y: 400,
      size: 20,
      text: "大承气汤主之",
      color: "#C0392B",
    },
  ];
  book.pages.push(p1);
  // 第 2 页：纯手写（底图走位图，但批注仍应是矢量）
  const p2 = createPage("grid", "white");
  p2.texts = [
    {
      id: "t2",
      source: "user",
      x: 100,
      y: 300,
      size: 16,
      text: "批注：\n这是纯手写页上的笔记",
      color: "#1A1A1A",
    },
  ];
  book.pages.push(p2);
  /*
   * 第 3 页：批注里含字体写不出的字（emoji）。
   * 硬画会变成空白/方块，看起来像内容丢了——这种页必须整页退回位图。
   */
  const p3 = createPage("blank", "white");
  p3.texts = [
    {
      id: "t3",
      source: "user",
      x: 100,
      y: 300,
      size: 18,
      text: "这里有表情 😀 写不出来",
      color: "#1A1A1A",
    },
  ];
  book.pages.push(p3);

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
  pass(doc.numPages === 3, "导出的 PDF 有 " + doc.numPages + " 页");

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
  const text2 = (tc2.items as any[]).map((it) => it.str || "").join("");
  pass(
    text1.includes("大承气汤主之"),
    "第 1 页的中文批注能抽出来（该页共 " + text1.length + " 字）"
  );

  /*
   * 位置也要对。坐标换算是这里最容易错的地方：
   * 页面坐标 y 向下、PDF y 向上，翻错了批注会跑到页面另一头。
   * 第 1 页批注在页面坐标 (80, 400)，字号 20。
   */
  {
    const items = (tc.items as any[]) || [];
    const hit = items.find((it) => String(it.str || "").includes("大承气"));
    const K = 595.28 / 794;
    const expX = 80 * K;
    const expY = (editor.store.data.height - 400) * K;
    pass(
      !!hit &&
        Math.abs(hit.transform[4] - expX) < 4 &&
        Math.abs(hit.transform[5] - expY) < 4,
      "批注坐标正确（期望 x≈" +
        expX.toFixed(1) +
        " y≈" +
        expY.toFixed(1) +
        "，实际 " +
        (hit ? hit.transform[4].toFixed(1) + " / " + hit.transform[5].toFixed(1) : "缺失") +
        "）"
    );
  }
  pass(
    text2.includes("纯手写页上的笔记"),
    "第 2 页（位图页）的中文批注也能抽出来：" + text2.replace(/\s+/g, "")
  );

  /*
   * 字体子集化的护栏。
   *
   * 真字体是 1.85MB，如果 embedFont 没做 subset（或以后谁改成 subset:false），
   * 每一份导出都会白白胖一圈——这条断言就是盯着这个回归。
   * 反过来，中文能抽出来 + 没退回 Helvetica，已经证明字体确实嵌进去了。
   */
  pass(
    bytes!.length < 400 * 1024,
    "字体按需子集化：导出件只有 " + Math.round(bytes!.length / 1024) + " KB（没把整包字体塞进去）"
  );
  const raw = new TextDecoder("latin1").decode(bytes!);
  pass(
    !raw.includes("/BaseFont /Helvetica"),
    "没有退回 Helvetica（否则中文会变方块）"
  );

  /*
   * 字体资源层面再确认一次：第 2 页（纯位图页，原 PDF 没给它带字体）
   * 的资源字典里必须有一个 Font —— 那就是我们嵌进去的子集。
   */
  {
    const reload = await PDFDocument.load(bytes!);
    const pg2 = reload.getPages()[1];
    const fontDict = pg2.node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
    const fontCount = fontDict ? fontDict.keys().length : 0;
    pass(fontCount >= 1, "第 2 页资源里有 " + fontCount + " 个嵌入字体");
  }

  /* 字体资源自检：base64 解出来得是一份能用的字体，不能是空壳 */
  {
    const fb = chineseFontBytes();
    pass(
      fb.length > 500 * 1024,
      "内联字体解出 " + Math.round(fb.length / 1024) + " KB 字节"
    );
    pass(
      fb[0] === 0x00 && fb[1] === 0x01 && fb[2] === 0x00,
      "是标准 TrueType（文件头 00 01 00 00）"
    );
  }

  // 两页都应该有内容（图片或矢量），不能是空白页
  const op1 = await page1.getOperatorList();
  const op2 = await page2.getOperatorList();
  pass(op1.fnArray.length > 20, "第 1 页有实际绘制指令（" + op1.fnArray.length + "）");
  pass(op2.fnArray.length > 5, "第 2 页有实际绘制指令（" + op2.fnArray.length + "）");

  /* -------------------- 第 3 页：字体写不出的字 → 整页退回位图 -------------------- */
  {
    const page3 = await doc.getPage(3);
    const tc3 = await page3.getTextContent();
    const items3 = ((tc3.items as any[]) || []).filter((it) => String(it.str || "").trim());
    pass(
      items3.length === 0,
      "含 emoji 的批注整页退回位图（不硬画成方块，可抽文字 " + items3.length + " 条）"
    );
    const op3 = await page3.getOperatorList();
    pass(op3.fnArray.length > 5, "退回位图的页内容仍在（绘制指令 " + op3.fnArray.length + "）");
  }

  try {
    await doc.destroy();
  } catch (_) {}

  editor.destroy();
  cleanup();

  /*
   * 反向护栏：**没有批注的本子不该多背一份字体**。
   * 字体是 1.85MB，就算 subset 后只剩几十 KB，也没理由为纯手写本嵌它。
   */
  {
    const plain = createBook("无批注", "lined", "white");
    plain.pages = [createPage("lined", "white")];
    const store2 = new BookStore(plain);
    const [host2, cleanup2] = makeHost();
    const ed2 = new BookEditor(host2, store2, { app, smoothing: 0.5 });
    await sleep(300);
    const out2 = await exportBookPdf(
      vault,
      ed2,
      { path: "无批注.inkbook", basename: "无批注", parent: { path: "" } } as any,
      1
    );
    const b2 = written.get(out2)!;
    const reload2 = await PDFDocument.load(b2);
    const fd2 = reload2.getPages()[0].node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
    const n2 = fd2 ? fd2.keys().length : 0;
    pass(n2 === 0, "没有批注的本子不嵌字体（字体资源 " + n2 + " 个）");
    ed2.destroy();
    cleanup2();
  }

  log("");
  log(failures === 0 ? "ALL PASS" : failures + " FAILED");
  document.title = "DONE";
}

main().catch((e) => {
  log("FATAL " + (e?.stack || e));
  document.title = "FATAL";
});
