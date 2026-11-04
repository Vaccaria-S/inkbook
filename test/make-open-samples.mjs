/**
 * 生成「打开大本子」性能测试用的 .inkbook 样本。
 *
 * 三档覆盖真实量级：
 *   A  300 页纯手写（每页 30 条笔迹 × 60 点）
 *   B  A + 每页 1500 字 texts[]（模拟 PDF 抽出来的文字层）
 *   C  B + 每页 background.pdf 引用（模拟导入 PDF 得到的本子）
 *
 * 为什么要有 A：本子慢不只见于 PDF 导入，纯手写写满了同样慢。
 * 为什么 B 的字数取 1500：真实样本（未命名笔记 2.inkbook，857 页 5.16MB）
 * 是 21605 条 texts / 506563 字，平均每页 ≈590 字、每条 ≈23 字。
 * 1500 字/页 是「一页排得很满的教材页」的上限档，用来压最坏情况。
 *
 * 产物落在 test/samples/（已 gitignore），由 harness 通过 HTTP 读取——
 * 不写进仓库，避免几百 MB 的二进制跟着版本走。
 */
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const OUT_DIR = path.resolve("test/samples");

const PAGE_W = 794;
const PAGE_H = 1123;

let idSeed = 0;
const uid = (prefix) => `${prefix}_${(idSeed++).toString(36).padStart(6, "0")}`;

/** 一条笔迹：60 个点，坐标像真人手写那样在页面中间画圈 */
function makeStroke(pageIndex, strokeIndex) {
  const points = [];
  const cx = 120 + ((strokeIndex * 37 + pageIndex * 13) % 550);
  const cy = 150 + ((strokeIndex * 53 + pageIndex * 7) % 800);
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    points.push([
      Math.round((cx + Math.cos(a) * 40) * 100) / 100,
      Math.round((cy + Math.sin(a) * 22) * 100) / 100,
      Math.round((0.3 + (i % 7) * 0.1) * 100) / 100,
    ]);
  }
  return {
    id: uid("stroke"),
    tool: "pen",
    color: "#1A1A1A",
    size: 2.8,
    opacity: 1,
    points,
  };
}

/** 一页 PDF 文字层：按真实样本的粒度切成 ~23 字一条 */
function makeTexts(pageIndex, targetChars) {
  const texts = [];
  let left = targetChars;
  let line = 0;
  while (left > 0) {
    const n = Math.min(23, left);
    // 用可读的中文片段，方便肉眼确认文字层真的渲染出来了
    const body = "中西医结合妇产科学第三版第十二章妊娠期高血压疾病临床表现与诊断要点";
    const text = body.repeat(10).slice(pageIndex % 7, (pageIndex % 7) + n);
    texts.push({
      id: uid("text"),
      source: "pdf",
      x: 64 + (line % 3) * 220,
      y: 90 + Math.floor(line / 3) * 18,
      text,
      size: 12,
      width: n * 12,
    });
    left -= n;
    line++;
  }
  return texts;
}

function makePage(pageIndex, { strokesPerPage, textChars, withPdf, pdfName }) {
  const page = {
    id: uid("page"),
    template: withPdf ? "blank" : "grid",
    paper: "white",
    layers: [
      {
        id: uid("layer"),
        name: "笔迹层",
        visible: true,
        opacity: 1,
        strokes: [],
      },
    ],
    activeLayerId: "",
  };
  page.activeLayerId = page.layers[0].id;
  for (let s = 0; s < strokesPerPage; s++) {
    page.layers[0].strokes.push(makeStroke(pageIndex, s));
  }
  if (textChars > 0) page.texts = makeTexts(pageIndex, textChars);
  if (withPdf) {
    page.background = {
      sourceName: pdfName,
      sourcePage: pageIndex + 1,
      x: 0,
      y: 47.73529411764707,
      width: PAGE_W,
      height: PAGE_H - 47.73529411764707 - 47.73529411764707,
      kind: "pdf",
      pdf: { path: pdfName, page: pageIndex + 1 },
    };
  }
  return page;
}

/** 统计笔迹数（与 storage.ts 的 bookStats 口径一致：只数有点的笔迹） */
function bookStats(book) {
  let strokeCount = 0;
  for (const page of book.pages) {
    for (const layer of page.layers || []) {
      for (const stroke of layer.strokes || []) {
        if (stroke && Array.isArray(stroke.points) && stroke.points.length) strokeCount += 1;
      }
    }
  }
  return { pageCount: book.pages.length, strokeCount };
}

function makeBook(title, pages, extra) {
  const book = {
    version: 2,
    kind: "inkbook",
    title,
    width: PAGE_W,
    height: PAGE_H,
    created: Date.now(),
    updated: Date.now(),
    activePage: 0,
    pages,
    ...extra,
  };
  book.integrity = bookStats(book);
  return book;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

/**
 * 造一份"够多页"的底图 PDF。
 *
 * 为什么必须有：C 档每页都引用 `background.pdf` 的第 N 页。如果这份 PDF
 * 只有 1 页，pdf.js 会对第 2~300 页全部报 `Invalid page request`——
 * 于是 C 这条线测的其实是"底图加载失败的路径"，等于没测底图。
 * （D 档引用了 857 页，所以这里直接给 900 页，一份文件同时满足两档。）
 *
 * 每页画一个边框 + 页码 + 一段文字：让光栅化真的干活，
 * 而不是纯空白页——空白页解码太快，测不出底图这条链路的真实成本。
 */
const PDF_PAGES = 900;
const SAMPLE_PDF = path.join(OUT_DIR, "大文档.pdf");

async function makeSamplePdf() {
  if (fs.existsSync(SAMPLE_PDF)) {
    console.log(`沿用已有 ${path.basename(SAMPLE_PDF)}（${PDF_PAGES} 页）`);
    return;
  }
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < PDF_PAGES; i++) {
    const page = doc.addPage([595.28, 841.89]); // A4 pt
    page.drawRectangle({
      x: 24,
      y: 24,
      width: 595.28 - 48,
      height: 841.89 - 48,
      borderColor: rgb(0.75, 0.75, 0.78),
      borderWidth: 1,
    });
    page.drawText(`Sample page ${i + 1} / ${PDF_PAGES}`, {
      x: 40,
      y: 800,
      size: 14,
      font,
      color: rgb(0.2, 0.2, 0.22),
    });
    // 每页再铺几行假正文，让缩略图/主视图的光栅化有真实工作量
    for (let line = 0; line < 24; line++) {
      page.drawText("Lorem ipsum dolor sit amet consectetur adipiscing elit sed do".slice(0, 40 + (line % 20)), {
        x: 40,
        y: 760 - line * 28,
        size: 9,
        font,
        color: rgb(0.45, 0.45, 0.48),
      });
    }
  }
  fs.writeFileSync(SAMPLE_PDF, await doc.save());
  console.log(`生成 ${path.basename(SAMPLE_PDF)}：${PDF_PAGES} 页 / ${(fs.statSync(SAMPLE_PDF).size / 1048576).toFixed(2)} MB`);
}

await makeSamplePdf();

const N = 300;
const PDF_NAME = "大文档.pdf";

const specs = [
  {
    file: "A-300p-ink.inkbook",
    title: "A 300页纯手写",
    opts: { strokesPerPage: 30, textChars: 0, withPdf: false },
    extra: {},
  },
  {
    file: "B-300p-ink-text.inkbook",
    title: "B 300页手写+文字层",
    opts: { strokesPerPage: 30, textChars: 1500, withPdf: false },
    extra: {},
  },
  {
    file: "C-300p-ink-text-pdf.inkbook",
    title: "C 300页手写+文字层+PDF底图",
    opts: { strokesPerPage: 30, textChars: 1500, withPdf: true, pdfName: PDF_NAME },
    extra: { source: { name: PDF_NAME, kind: "pdf", pageCount: N, path: PDF_NAME } },
  },
  {
    /*
     * E 是**压力档**：一页写满 200 条笔迹（密集手写 + 批注的真实上限），
     * 300 页就是 72MB。它存在的意义是让"打开耗时随体积线性增长"这条曲线
     * 在套件里留一个远端的观测点——只测 13MB 看不出量级差异。
     */
    file: "E-300p-dense.inkbook",
    title: "E 300页超密手写",
    opts: { strokesPerPage: 200, textChars: 0, withPdf: false },
    extra: {},
  },
];

/**
 * D 是真实本子的副本，不在这里生成——它是用户库里实际的一本 857 页
 * PDF 导入本子，比任何程序化样本都真实。样本生成脚本只负责提醒：
 * 没有 D 时套件会直接报"样本读取失败"，而不是静默跳过。
 */

const rows = [];
for (const spec of specs) {
  idSeed = 0;
  const pages = [];
  for (let i = 0; i < N; i++) pages.push(makePage(i, spec.opts));
  const book = makeBook(spec.title, pages, spec.extra);
  const target = path.join(OUT_DIR, spec.file);
  const json = JSON.stringify(book);
  fs.writeFileSync(target, json);
  const bytes = Buffer.byteLength(json);
  rows.push({ file: spec.file, bytes, mb: (bytes / 1048576).toFixed(2), pages: N });
  console.log(`${spec.file}\t${bytes} 字节\t${(bytes / 1048576).toFixed(2)} MB\t${N} 页`);
}

fs.writeFileSync(
  path.join(OUT_DIR, "index.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), samples: rows }, null, 2)
);
console.log(`\n写入 ${OUT_DIR}`);
