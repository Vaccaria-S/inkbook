/**
 * 缩放锚点回归测试。
 *
 * 这个文件锁住一个曾经很严重的 bug：
 * **Ctrl+滚轮缩放时，页面会跳到别的地方去。**
 *
 * 根因有三个，全部叠加：
 *   1. 锚点用的是「当前页」，不是光标实际所在的那一页
 *   2. 补偿量把「页面坐标 × 缩放比」又除了以页面高度（差 1123 倍）
 *   3. 补偿执行了两次（同步一次 + rAF 一次），误差叠加
 *
 * 修好上面三条之后，又暴露了第四个根因——**页间距测量误差**：
 * `measurePageMetrics()` 原来用 `offsetTop` 量间距，而 offsetTop
 * 被浏览器取整到整数像素。页高 1123 × 1.12 = 1257.76，
 * 取整后间距被量成 24.24 而不是 24。这 0.24px 会被
 * 「页序号 × 间距」的推算放大：第 10 页 2.4px，第 100 页 24px（整一页）。
 *
 * 现在缩放补偿完全改成**从 DOM 实测**：缩放后直接量内容点此刻的
 * 真实屏幕位置，跟光标位置一减就是要补偿的量。模型误差全部消失。
 *
 * 残留误差只有浏览器把 scrollTop 取整带来的 ±0.5px，
 * 而且它**不累积**（每轮重新实测）。
 *
 * 另外锁住一个精度性质：文档顶端的缩小是**物理上无法补偿**的
 * （scrollTop 不能为负），此时必然有漂移——这是正确行为，
 * 不能算失败。测试把它单独拎出来，断言漂移量在理论上限之内。
 */
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

/** 造一个跟真实 Obsidian 一致的容器 */
function makeHost(): HTMLElement {
  const root = document.createElement("div");
  root.className = "mb-root";
  root.style.cssText =
    "position:absolute;left:0;top:0;width:900px;height:700px;overflow:hidden;display:flex;flex-direction:column";
  const host = document.createElement("div");
  host.className = "mb-host";
  root.appendChild(host);
  document.body.appendChild(root);
  return host;
}

function makeBook(n: number): InkBook {
  const book = createBook("缩放锚点", "blank", "white");
  book.pages = [];
  for (let i = 0; i < n; i++) book.pages.push(createPage("blank", "white"));
  return book;
}

/**
 * 锚点：哪一页 + 页内相对位置。
 *
 * 用「页内比例」而不是绝对像素——页面是等比缩放的，
 * 同一个比例在缩放前后指向的是同一个内容。
 */
interface Anchor {
  index: number;
  fx: number;
  fy: number;
}

/**
 * 量出「锚点内容点」在屏幕上的位置。
 *
 * 锚点由 (index, fx, fy) 唯一确定——即「哪一页 + 页内什么位置」。
 * 这个内容点在缩放前后是**同一个内容**，屏幕位置应该不变。
 */
function probe(ed: any, anchor: Anchor): { x: number; y: number } {
  const rec = ed.recs[anchor.index];
  const r = rec.pageEl.getBoundingClientRect();
  return {
    x: r.left + anchor.fx * r.width,
    y: r.top + anchor.fy * r.height,
  };
}

async function main() {
  const host = makeHost();
  const store = new BookStore(makeBook(30));
  const editor = new BookEditor(host, store, { smoothing: 0.5 });
  await sleep(400);

  const ed = editor as any;
  const scroll = ed.scrollEl;
  const sr = scroll.getBoundingClientRect();

  /* ---------------- 场景 1：单页放大，锚点内容点不动 ---------------- */
  {
    editor.setZoom(1);
    await sleep(150);
    scroll.scrollTop = 0;
    await sleep(100);

    const clientY = ed.recs[0].pageEl.getBoundingClientRect().top + 560;
    const clientX = sr.left + 400;

    const anchor = ed.pickAnchor(clientX, clientY) as Anchor;
    pass(!!anchor, "锚点定位成功");
    const before = probe(ed, anchor);
    editor.zoomAt(clientX, clientY, 1.12);
    await sleep(200);
    const after = probe(ed, anchor);

    // 纵向：浏览器把 scrollTop 取整到整数像素，误差有 ±0.5px 的物理下限
    const driftY = Math.abs(after.y - before.y);
    pass(
      driftY < 1,
      `单页放大：锚点纵向不漂移（漂移 ${driftY.toFixed(2)}px）`
    );
  }

  /* ---------------- 场景 2：第 10 页（前面有 10 页高） ---------------- */
  {
    editor.setZoom(1);
    await sleep(150);
    ed.current = 10;
    store.setPage(10);
    scroll.scrollTop = ed.recs[10].wrap.offsetTop;
    await sleep(150);

    const clientY = ed.recs[10].pageEl.getBoundingClientRect().top + 560;
    const clientX = sr.left + 400;

    const anchor = ed.pickAnchor(clientX, clientY) as Anchor;
    pass(anchor?.index === 10, "锚点定位到光标所在的第 10 页（不是当前页）");
    const before = probe(ed, anchor);
    editor.zoomAt(clientX, clientY, 1.12);
    await sleep(200);
    const after = probe(ed, anchor);

    /*
     * 这一条是本轮的核心断言。
     *
     * 旧实现（用 offsetTop 量间距）在第 10 页会漂移 2.30px，
     * 因为间距被量成 24.24 而不是 24，误差被页序号放大 10 倍。
     * 误差还会随页数线性增长——第 100 页就是 24px，整整跳一页。
     */
    const driftY = Math.abs(after.y - before.y);
    pass(
      driftY < 1,
      `第 10 页放大：锚点纵向不漂移（漂移 ${driftY.toFixed(2)}px）`
    );

    // 独立校验：页间距必须被量成 24.00，不能是 24.24
    const gap = ed.pageGap;
    pass(
      Math.abs(gap - 24) < 0.05,
      `页间距测量精确（量得 ${gap.toFixed(3)}px，应为 24.000px）`
    );
  }

  /* ---------------- 场景 3：连续缩放，误差不累积 ---------------- */
  {
    editor.setZoom(1);
    await sleep(150);
    scroll.scrollTop = 0;
    await sleep(100);

    const clientY = ed.recs[0].pageEl.getBoundingClientRect().top + 560;
    const clientX = sr.left + 400;

    const anchor = ed.pickAnchor(clientX, clientY) as Anchor;
    const before = probe(ed, anchor);
    for (let i = 0; i < 5; i++) {
      editor.zoomAt(clientX, clientY, 1.12);
    }
    await sleep(300);
    const after = probe(ed, anchor);

    const driftY = Math.abs(after.y - before.y);
    pass(
      driftY < 1.5,
      `连滚 5 次：纵向误差不累积（总漂移 ${driftY.toFixed(2)}px）`
    );
    // 旧实现这里会偏 39000+px（35 页）
    pass(
      Math.abs(scroll.scrollTop) < 2000,
      `连滚 5 次后 scrollTop 仍在合理范围（${scroll.scrollTop.toFixed(0)}px）`
    );
    // 锚点必须锁死在同一个内容点上
    const locked = ed.lockedAnchor;
    pass(
      !!locked &&
        locked.index === anchor.index &&
        Math.abs(locked.fy - anchor.fy) < 0.0001 &&
        Math.abs(locked.fx - anchor.fx) < 0.0001,
      `锚点锁死在同一个内容点（页${locked?.index} fy=${locked?.fy.toFixed(5)}）`
    );
  }

  /* ---------------- 场景 4：缩小也要锚定 ---------------- */
  {
    /*
     * 放在文档**中部**缩放，这样上下都有滚动余量。
     *
     * 为什么不放在文档顶端：scrollTop 不能为负，
     * 顶端缩小在物理上无法补偿（内容点必须上移，但无处可上）。
     * 那个 case 见场景 4b。
     */
    editor.setZoom(2);
    await sleep(200);
    // 滚到第 5 页，留出上下余量
    scroll.scrollTop = ed.recs[5].wrap.offsetTop;
    await sleep(150);

    const rec = ed.recs[5];
    const clientY = rec.pageEl.getBoundingClientRect().top + 400;
    const clientX = sr.left + 400;

    const anchor = ed.pickAnchor(clientX, clientY) as Anchor;
    const before = probe(ed, anchor);
    editor.zoomAt(clientX, clientY, 1 / 1.12);
    await sleep(200);
    const after = probe(ed, anchor);

    const driftY = Math.abs(after.y - before.y);
    pass(
      driftY < 1.5,
      `缩小：锚点纵向不漂移（漂移 ${driftY.toFixed(2)}px）`
    );
  }

  /* ---------------- 场景 4b：文档顶端缩小的漂移有物理上限 ---------------- */
  {
    /*
     * 文档顶端（scrollTop = 0）缩小：内容点必须上移，
     * 而 scrollTop 不能为负——所以**必然**有漂移。
     *
     * 这不是 bug，是滚动容器的物理约束。早先的测试把它当成
     * 「缩小失败」，实际上它只是「缩小在最顶端时无法锚定」。
     *
     * 这里断言漂移量在理论上限内：
     * 锚点上方有 h 像素的内容，缩小到 1/1.12 后变成 h/1.12，
     * 最多上移 h × (1 - 1/1.12) 像素。
     */
    editor.setZoom(2);
    await sleep(200);
    scroll.scrollTop = 0;
    await sleep(150);

    const rec = ed.recs[0];
    const pageTop = rec.pageEl.getBoundingClientRect().top;
    const clientY = pageTop + 400;
    const clientX = sr.left + 400;

    const anchor = ed.pickAnchor(clientX, clientY) as Anchor;
    const before = probe(ed, anchor);
    editor.zoomAt(clientX, clientY, 1 / 1.12);
    await sleep(200);
    const after = probe(ed, anchor);

    const drift = Math.abs(after.y - before.y);
    // 锚点上方内容 = 400px（页内）+ 顶部留白
    const theoretical = 400 * (1 - 1 / 1.12) + 24;
    pass(
      drift <= theoretical + 1.5,
      `文档顶端缩小：漂移在物理上限内（漂移 ${drift.toFixed(2)}px ≤ 上限 ${theoretical.toFixed(2)}px）`
    );
  }

  /* ---------------- 场景 5：光标在页与页的缝隙里 ---------------- */
  {
    editor.setZoom(1);
    await sleep(150);
    scroll.scrollTop = 0;
    await sleep(100);

    const r0 = ed.recs[0].pageEl.getBoundingClientRect();
    const gapY = r0.bottom + 10;
    const clientX = sr.left + 400;

    const before = scroll.scrollTop;
    editor.zoomAt(clientX, gapY, 1.12);
    await sleep(200);

    /*
     * 关键：光标在缝隙里时**也必须找到锚点**。
     * 旧实现判定 fy ∈ [-0.02, 1.02]，缝隙正中会三个候选全落空
     * → 返回 null → 这次缩放零补偿 → 整篇文档跳一整页。
     */
    const anchor = ed.pickAnchor(clientX, gapY) as Anchor;
    pass(!!anchor, "光标在页缝隙：仍然能找到锚点（不放弃锚定）");
    pass(
      Math.abs(scroll.scrollTop - before) < 300,
      `光标在页缝隙：scrollTop 变化可控（${(scroll.scrollTop - before).toFixed(0)}px）`
    );
  }

  /* ---------------- 场景 6：滚轮事件走的是同一条路径 ---------------- */
  {
    editor.setZoom(1);
    await sleep(150);
    scroll.scrollTop = 0;
    await sleep(100);

    const clientY = ed.recs[0].pageEl.getBoundingClientRect().top + 560;
    const clientX = sr.left + 400;

    const anchor = ed.pickAnchor(clientX, clientY) as Anchor;
    const before = probe(ed, anchor);
    scroll.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -100,
        ctrlKey: true,
        clientX,
        clientY,
        bubbles: true,
        cancelable: true,
      })
    );
    await sleep(250);
    const after = probe(ed, anchor);

    const driftY = Math.abs(after.y - before.y);
    pass(
      driftY < 1,
      `Ctrl+滚轮：锚点纵向不漂移（漂移 ${driftY.toFixed(2)}px）`
    );
    pass(
      editor.getState().zoom > 1.05,
      `Ctrl+滚轮确实放大了（${editor.getState().zoom.toFixed(3)}）`
    );
  }

  /* ---------------- 场景 7：缩放后当前页不变 ---------------- */
  {
    editor.setZoom(1);
    await sleep(150);
    ed.current = 5;
    store.setPage(5);
    scroll.scrollTop = ed.recs[5].wrap.offsetTop;
    await sleep(200);

    const before = ed.current;
    const r5 = ed.recs[5].pageEl.getBoundingClientRect();
    editor.zoomAt(sr.left + 400, r5.top + 500, 1.2);
    await sleep(250);

    pass(
      Math.abs(ed.current - before) <= 1,
      `缩放后当前页不跳（${before} → ${ed.current}）`
    );
    /*
     * INK-107：页码要在缩放结束的那一刻就正确，不能等下一次 scroll。
     * 拿「缩放后立刻读到的 current」和「补派一次 scroll 后再读」比：
     * 旧实现前者滞旧、后者才刷新，两者会差一页。
     */
    const rightAfterZoom = ed.current;
    scroll.dispatchEvent(new Event("scroll"));
    await sleep(80);
    pass(
      ed.current === rightAfterZoom,
      `缩放后页码即时刷新，不必等一次滚动（缩放后 ${rightAfterZoom} / 补派 scroll 后 ${ed.current}）`
    );
  }

  /* ---------------- 场景 8：横向锚定（页面溢出时） ---------------- */
  {
    // 缩放到页面比容器宽 → 出现横向滚动 → scrollLeft 补偿生效
    editor.setZoom(1.6);
    await sleep(250);
    const rec = ed.recs[0];
    const rr = rec.pageEl.getBoundingClientRect();
    const clientY = rr.top + 300;
    const clientX = rr.left + 200;
    const clientX2 = rr.left + rr.width - 200;

    for (const [cx, label] of [
      [clientX, "左"],
      [clientX2, "右"],
    ] as Array<[number, string]>) {
      const anchor = ed.pickAnchor(cx, clientY) as Anchor;
      const before = probe(ed, anchor);
      editor.zoomAt(cx, clientY, 1.1);
      await sleep(200);
      const after = probe(ed, anchor);
      const driftX = Math.abs(after.x - before.x);
      pass(
        driftX < 2,
        `横向锚定（光标在页面${label}侧）：不漂移（漂移 ${driftX.toFixed(2)}px）`
      );
    }
  }

  /* ---------------- 场景 9：深页（第 25 页）不累积误差 ---------------- */
  {
    /*
     * 这是页间距误差累积最狠的地方：
     * 旧实现用 offsetTop 量间距，误差 0.24px × 25 页 = 6px。
     * 现在改成 DOM 实测，应该完全不累积。
     */
    editor.setZoom(1);
    await sleep(150);
    scroll.scrollTop = ed.recs[25].wrap.offsetTop;
    await sleep(200);

    const clientY = ed.recs[25].pageEl.getBoundingClientRect().top + 300;
    const clientX = sr.left + 400;

    const anchor = ed.pickAnchor(clientX, clientY) as Anchor;
    pass(anchor?.index === 25, "锚点定位到第 25 页");
    const before = probe(ed, anchor);
    editor.zoomAt(clientX, clientY, 1.12);
    await sleep(200);
    const after = probe(ed, anchor);

    const driftY = Math.abs(after.y - before.y);
    pass(
      driftY < 1,
      `第 25 页放大：锚点纵向不漂移（漂移 ${driftY.toFixed(2)}px）`
    );
  }

  log("");
  log(failures === 0 ? "ALL PASS" : failures + " FAILED");
  document.title = "DONE";
}

main().catch((e) => {
  log("FATAL " + (e?.stack || e));
  document.title = "FATAL";
});
