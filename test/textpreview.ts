/**
 * 文字层预览页：拿真实 PDF 跑一遍"抽取 → 映射 → 渲染"。
 *
 * 存在的意义是**肉眼对齐检查**：文字层在真实界面里是透明的，
 * 看不出来有没有偏。这里把 PDF 原文染成半透明红色（见 html 里的
 * 覆盖样式），红色字应该和底图上的字重合；偏了就一眼能看见。
 *
 * 打开：http://127.0.0.1:8901/textpreview.html
 */
import { BookEditor } from "../src/editor";
import { BookStore } from "../src/store";
import { createBook, createPage } from "../src/types";
import { extractPdfText, fitBackground, openPdf, pdfPageSize } from "../src/pdf";

const out = document.getElementById("out")!;
const log = (s: string) => {
  out.textContent = s;
};
window.addEventListener("error", (e) => log("ERROR " + e.message));
window.addEventListener("unhandledrejection", (e: any) =>
  log("REJECT " + (e.reason?.stack || e.reason))
);

(async () => {
  const host = document.getElementById("view-host")!;
  const file = "/test/sample.pdf";

  const doc = await openPdf(file);
  const size = await pdfPageSize(doc, 1);
  const fit = fitBackground(size.width, size.height, 0);
  const rows = await extractPdfText(doc, 1);

  const book = createBook("文字层预览", "blank", "white");
  book.pages = [];
  const page = createPage("blank", "white");
  page.background = {
    pdf: { path: file, page: 1 },
    sourceName: "sample.pdf",
    sourcePage: 1,
    x: fit.x,
    y: fit.y,
    width: fit.width,
    height: fit.height,
    kind: "pdf",
  };
  const sx = fit.width / size.width;
  const sy = fit.height / size.height;
  page.texts = rows.map((r, i) => ({
    id: "t" + i,
    source: "pdf" as const,
    x: fit.x + r.x * sx,
    y: fit.y + r.y * sy,
    size: Math.max(1, r.size * sy),
    text: r.text,
    width: Math.max(0, r.width * sx),
  }));
  book.pages.push(page);

  const store = new BookStore(book);
  const editor = new BookEditor(host, store, {
    app: {
      vault: { adapter: { getResourcePath: () => file } },
    },
    penOnly: false,
    pressure: 1,
    onState: () => {},
    onChange: () => {},
    onPageChange: () => {},
  });

  /*
   * ?reading=1 → 进入仅阅读并打上 .mb-root.is-reading：
   * 这时文字层才接管指针、允许选择，用来验证"能拖选复制"。
   */
  if (new URLSearchParams(location.search).get("reading") === "1") {
    host.classList.add("mb-root", "is-reading");
    editor.setReadOnly(true);
  }

  (window as any).__preview = { editor, store, rows, fit, size };
  log(
    `PDF ${size.width.toFixed(0)}×${size.height.toFixed(0)} → 底图 ${fit.width.toFixed(
      0
    )}×${fit.height.toFixed(0)}；抽出 ${rows.length} 行`
  );
  document.title = "ready";
})().catch((e) => log("FATAL " + (e?.stack || e)));
