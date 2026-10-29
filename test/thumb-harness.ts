/**
 * 侧栏缩略图的底图（PDF）渲染。
 *
 * 真机反馈：「展开侧栏，导入 PDF 的那几页只能显示是空白的」——
 * 旧实现为了省 CPU 干脆不在缩略图里画 PDF 底图。
 * 现在改成「懒渲染 + 小尺寸位图 + 独立缓存」，这个套件守住三件事：
 *   1. 位图没就绪时是干净占位，不伪造内容；
 *   2. 渲染完能真的画出 PDF 内容（不是一片空白）；
 *   3. 位图只有缩略图那么大（≤384px），不去抢主视图的高清缓存。
 *
 * 单独一个页面而不是塞进 perf.html：perf 那边前面几十个测试会对着
 * 不存在的 PDF 发起大量渲染请求，容易把 pdf.js 的失败状态带进来。
 */
import { BookEditor } from "../src/editor";
import { BookStore } from "../src/store";
import { createBook, createPage } from "../src/types";
import { openPdf, renderPdfPage } from "../src/pdf";

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

async function main() {
  /* -------------------- 环境自检：这个页面里 pdf.js 能干活 -------------------- */
  {
    try {
      const doc = await openPdf(PDF_URL);
      pass(doc.numPages === 20, "环境自检：打开 PDF，" + doc.numPages + " 页");
      const one = await renderPdfPage(doc, 1, 120);
      pass(one.bitmap.width > 0, "环境自检：能渲染出位图 " + one.bitmap.width + "px");
      one.bitmap.close();
      await doc.destroy();
    } catch (e: any) {
      pass(false, "环境自检失败：" + (e?.name || "") + " / " + (e?.message || e));
    }
  }

  /* -------------------- 缩略图画出 PDF 底图 -------------------- */
  {
    const book = createBook("缩略图底图", "blank", "white");
    book.pages = [];
    for (let i = 0; i < 10; i += 1) {
      const p = createPage("blank", "white");
      /*
       * 第 1 页：当前页，主视图一定会渲染（缩略图能借它的位图）。
       * 第 8 页：离视口很远，主视图的挂载范围（IO rootMargin 600px）够不着，
       *          缩略图只能自己渲染——这正是要验证的路径。
       */
      if (i === 0 || i === 7) {
        const pdfPage = i === 0 ? 1 : 5;
        p.background = {
          pdf: { path: PDF_URL, page: pdfPage },
          sourceName: "sample.pdf",
          sourcePage: pdfPage,
          x: 0,
          y: 0,
          width: 794,
          height: 1123,
        };
      }
      book.pages.push(p);
    }
    const store = new BookStore(book);
    const [host, cleanup] = makeHost();
    const editor = new BookEditor(host, store, { smoothing: 0.5 });
    // 等主视图把第 1 页的底图渲染出来
    await sleep(900);

    const cv = document.createElement("canvas");
    cv.style.width = "60px";
    cv.style.height = "84px";
    document.body.appendChild(cv);

    /** 数缩略图里的深色像素（PDF 文字/线条） */
    const darkCount = () => {
      const ctx = cv.getContext("2d")!;
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let k = 0; k < d.length; k += 4) {
        if (d[k] < 200 && d[k + 3] > 0) n += 1;
      }
      return n;
    };

    /*
     * 场景 A：主视图已经渲染过这一页 → 缩略图应该**直接借用**它的位图，
     * 不再光栅化一次（省一次渲染，也不占 thumbBitmaps）。
     */
    const targetBefore = (editor as any).bgTarget.size;
    editor.renderThumbnail(cv, 0);
    const dark0 = darkCount();
    pass(
      dark0 > 40,
      "缩略图第一遍就画出 PDF 内容（深色像素 " + dark0 + "，尺寸 " + cv.width + "×" + cv.height + "）"
    );
    pass(
      (editor as any).bgTarget.size === targetBefore,
      "缩略图没有把主视图的高清请求拉起来（bgTarget 条数 " +
        (editor as any).bgTarget.size +
        " 不变）"
    );

    /*
     * 场景 B：主视图够不着的第 8 页 → 缩略图自己渲染一张**小图**，
     * 宽度不能超过 384px，别去抢主视图那份高清。
     */
    const key2 = PDF_URL + "#5";
    editor.renderThumbnail(cv, 7);
    let w2 = 0;
    for (let i = 0; i < 80; i += 1) {
      await sleep(100);
      w2 = (editor as any).thumbBitmaps.getEntry(key2)?.width ?? 0;
      if (w2 > 0) break;
      editor.renderThumbnail(cv, 7);
    }
    pass(w2 > 0 && w2 <= 384, "自己渲染时位图只有 " + w2 + "px 宽（0 < w ≤ 384）");

    editor.renderThumbnail(cv, 7);
    const dark1 = darkCount();
    pass(dark1 > 40, "第 8 页缩略图也画出了 PDF 内容（深色像素 " + dark1 + "）");

    editor.destroy();
    cleanup();
    cv.remove();
  }

  log("");
  log(failures === 0 ? "ALL PASS" : failures + " FAILED");
  document.title = "DONE";
}

main().catch((e) => {
  log("FATAL " + (e?.stack || e));
  document.title = "FATAL";
});
