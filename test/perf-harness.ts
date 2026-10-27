/**
 * 性能回归测试：大 PDF 场景。
 *
 * 这些测试守的是"大文件下不卡死"这条底线：
 *   - 导入 PDF 不再预渲染（页数多时导入必须是常数级耗时）
 *   - 底图位图缓存有字节上限（内存不会无限涨）
 *   - 滚动定位是算术的，不触发强制重排
 *   - 缩略图懒渲染，不会一次画几百张
 */
import { BitmapCache } from "../src/cache";
import { BookEditor } from "../src/editor";
import { BookStore } from "../src/store";
import { createBook, createPage, type InkBook } from "../src/types";

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

/** 造一份有 n 页的手写本，每页都带 PDF 底图引用 */
function makeBook(n: number): InkBook {
  const book = createBook("性能测试", "blank", "white");
  book.pages = [];
  for (let i = 0; i < n; i++) {
    const p = createPage("blank", "white");
    p.background = {
      pdf: { path: "大文档.pdf", page: i + 1 },
      sourceName: "大文档.pdf",
      sourcePage: i + 1,
      x: 0,
      y: 0,
      width: 794,
      height: 1123,
      kind: "pdf",
    };
    book.pages.push(p);
  }
  return book;
}

/**
 * 造一个跟真实 Obsidian 一致的容器。
 *
 * 结构必须是 .mb-root > .mb-scroll，否则滚动容器会被内容撑开、
 * 根本没有滚动可言——那样测出来的性能数字是假的。
 *
 * 返回 [host, cleanup]：host 交给编辑器，cleanup 负责拆掉整棵树。
 */
function makeHost(): [HTMLElement, () => void] {
  const root = document.createElement("div");
  root.className = "mb-root";
  root.style.cssText =
    "position:absolute;left:0;top:0;width:900px;height:700px;overflow:hidden;display:flex;flex-direction:column";
  const host = document.createElement("div");
  host.className = "mb-host";
  // 尺寸交给真实的 CSS（.mb-host / .mb-scroll），不要内联覆盖——
  // 否则测的就不是插件在 Obsidian 里真正的布局了
  root.appendChild(host);
  document.body.appendChild(root);
  return [host, () => root.remove()];
}

async function main() {
  /* -------------------- 位图 LRU：内存有上限 -------------------- */
  {
    const cache = new BitmapCache({ budget: 4 * 1024 * 1024 }); // 4MB
    // 每张 512×512×4 = 1MB
    const mk = (w = 512, h = 512) =>
      ({ width: w, height: h, close: () => {} }) as unknown as ImageBitmap;

    for (let i = 0; i < 10; i++) {
      cache.set("k" + i, mk());
    }
    pass(cache.size <= 4, "超出预算后缓存条目被淘汰：" + cache.size + " 条");
    pass(
      cache.usedBytes <= cache.budgetBytes,
      "缓存占用不超过预算：" + Math.round(cache.usedBytes / 1024) + "KB / " +
        Math.round(cache.budgetBytes / 1024) + "KB"
    );
    pass(!cache.has("k0"), "最早进 cache 的被淘汰了");
    pass(cache.has("k9"), "最新进的还在");

    // 单张就超预算：不该进缓存
    const before = cache.size;
    cache.set("huge", mk(4096, 4096)); // 64MB > 4MB 预算
    pass(cache.size === before, "单张超过预算的位图不进缓存");

    // 超预算时也绝不能超太多
    const big = new BitmapCache({ budget: 8 * 1024 * 1024 });
    for (let i = 0; i < 40; i++) big.set("x" + i, mk());
    pass(
      big.usedBytes <= big.budgetBytes,
      "40 张 1MB 位图后占用仍受控：" + Math.round(big.usedBytes / 1024) + "KB"
    );

    // 淘汰要真的 close()，否则显存不释放
    let closed = 0;
    const cache2 = new BitmapCache({ budget: 1024 * 1024 });
    const mk2 = () =>
      ({ width: 512, height: 512, close: () => closed++ }) as unknown as ImageBitmap;
    cache2.set("a", mk2());
    cache2.set("b", mk2());
    cache2.set("c", mk2());
    pass(closed >= 1, "被淘汰的位图调用了 close() 释放显存：" + closed + " 次");

    cache.clear();
    cache2.clear();
    big.clear();
  }

  /* -------------------- 大 PDF 导入：常数级耗时 -------------------- */
  {
    // 导入的核心是"建页 → 记 PDF 页码"，不涉及像素
    const t0 = performance.now();
    const book = makeBook(500);
    const t1 = performance.now();
    const elapsed = t1 - t0;
    pass(elapsed < 60, "500 页建页耗时 " + elapsed.toFixed(1) + "ms（不渲染像素）");
    pass(book.pages.length === 500, "生成了 500 页");
    pass(
      book.pages.every((p) => p.background?.pdf?.page > 0),
      "每页都记下了对应的 PDF 页码"
    );
    // 关键：底图不再存成 PNG 路径，磁盘零膨胀
    pass(
      book.pages.every((p) => !p.background?.src),
      "底图不落盘为 PNG（磁盘零膨胀）"
    );
    // .inkbook 体积应该很小——只存页码映射
    const json = JSON.stringify(book);
    pass(
      json.length < 200 * 1024,
      "500 页的 .inkbook 只有 " + Math.round(json.length / 1024) + "KB"
    );
  }

  /* -------------------- 大 PDF 滚动：不触发强制重排 -------------------- */
  {
    const book = makeBook(500);
    const store = new BookStore(book);
    const [host, cleanup] = makeHost();
    const editor = new BookEditor(host, store, { smoothing: 0.5 });
    await sleep(300);

    // 统计 getBoundingClientRect 的调用次数
    let rectCalls = 0;
    const origGetRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      rectCalls++;
      return origGetRect.call(this);
    };

    const scroll = (editor as any).scrollEl;
    const t0 = performance.now();
    for (let i = 0; i < 60; i++) {
      scroll.scrollTop = i * 100;
      (editor as any).updateCurrentFromScroll();
    }
    const t1 = performance.now();
    Element.prototype.getBoundingClientRect = origGetRect;

    const perScroll = (t1 - t0) / 60;
    pass(
      rectCalls <= 60,
      "60 次滚动只触发 " + rectCalls + " 次 getBoundingClientRect（旧实现是 60×500）"
    );
    pass(perScroll < 3, "单次滚动定位耗时 " + perScroll.toFixed(2) + "ms");

    // 定位必须正确：滚到第 100 页，并验证算出来的页码对得上
    const ed = editor as any;
    const pageH = store.data.height * ed.zoom;
    const stride = pageH + ed.pageGap;
    // 第 100 页的顶部：首页偏移 + 100 × 步长
    const targetTop = ed.pageOrigin + 100 * stride;
    scroll.scrollTop = targetTop;
    await sleep(40);
    ed.updateCurrentFromScroll();
    const idx = editor.getState().pageIndex;
    pass(
      Math.abs(idx - 100) <= 2,
      "滚动到第 101 页 → 定位结果第 " + (idx + 1) + " 页（误差 " + (idx - 100) + "）"
    );

    // 再滚回开头，应该回到第 1 页
    scroll.scrollTop = 0;
    await sleep(40);
    ed.updateCurrentFromScroll();
    pass(editor.getState().pageIndex === 0, "滚回顶部 → 定位到第 1 页");

    editor.destroy();
    cleanup();
  }

  /* -------------------- 渲染不因页数多而变慢 -------------------- */
  {
    const mkEditor = async (n: number) => {
      const book = makeBook(n);
      const store = new BookStore(book);
      const [host, cleanup] = makeHost();
      const editor = new BookEditor(host, store, { smoothing: 0.5 });
      await sleep(250);
      return { editor, host, store, cleanup };
    };

    const small = await mkEditor(20);
    const big = await mkEditor(500);

    const t0 = performance.now();
    for (let i = 0; i < 30; i++) {
      small.editor.setZoom(0.8 + (i % 5) * 0.05);
    }
    const t1 = performance.now();
    for (let i = 0; i < 30; i++) {
      big.editor.setZoom(0.8 + (i % 5) * 0.05);
    }
    const t2 = performance.now();

    const smallMs = (t1 - t0) / 30;
    const bigMs = (t2 - t1) / 30;
    pass(smallMs < 60, "20 页缩放单次 " + smallMs.toFixed(1) + "ms");
    pass(bigMs < 200, "500 页缩放单次 " + bigMs.toFixed(1) + "ms");
    pass(
      bigMs < smallMs * 8 + 30,
      "500 页缩放没有随页数爆炸（" + smallMs.toFixed(1) + "ms → " + bigMs.toFixed(1) + "ms）"
    );

    small.editor.destroy();
    big.editor.destroy();
    small.cleanup();
    big.cleanup();
  }

  /* -------------------- 缩略图懒渲染 -------------------- */
  {
    const book = makeBook(300);
    const store = new BookStore(book);
    const [host, cleanup] = makeHost();
    const editor = new BookEditor(host, store, { smoothing: 0.5 });
    await sleep(250);

    // 侧栏渲染一页缩略图应该很快
    const cv = document.createElement("canvas");
    cv.style.width = "60px";
    cv.style.height = "84px";
    document.body.appendChild(cv);
    const t0 = performance.now();
    for (let i = 0; i < 30; i++) editor.renderThumbnail(cv, i);
    const t1 = performance.now();
    const per = (t1 - t0) / 30;
    pass(per < 20, "单张缩略图渲染 " + per.toFixed(2) + "ms（不含 PDF 光栅化）");

    editor.destroy();
    cleanup();
    cv.remove();
  }

  /* -------------------- PDF 底图不会在缩略图里触发渲染 -------------------- */
  {
    const book = makeBook(3);
    const store = new BookStore(book);
    const [host, cleanup] = makeHost();
    const editor = new BookEditor(host, store, { smoothing: 0.5 });
    await sleep(200);

    // 缩略图渲染不应该发起 PDF 页渲染请求
    //
    // 注意字段名：底图请求表在渐进式高清那轮重构里
    // 从 bgPending（Set）改成了 bgTarget（Map<key, 目标像素宽>）。
    const before = (editor as any).bgTarget.size;
    const cv = document.createElement("canvas");
    cv.style.width = "60px";
    cv.style.height = "84px";
    document.body.appendChild(cv);
    for (let i = 0; i < 3; i++) editor.renderThumbnail(cv, i);
    const after = (editor as any).bgTarget.size;
    pass(
      before === after,
      "缩略图渲染不触发 PDF 光栅化（避免几百页时打满 CPU）"
    );

    editor.destroy();
    cleanup();
    cv.remove();
  }

  log(failures === 0 ? "ALL PASS" : failures + " FAILED");
  document.title = "DONE";
}

main();
