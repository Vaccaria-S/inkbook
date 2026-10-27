/**
 * 「Ctrl+滚轮缩放跳页」回归测试。
 *
 * 这个文件锁住用户实际报告的那个 bug：
 * **用 Ctrl+滚轮缩放时，页面会跳到别的地方去。**
 *
 * 用户原话：「往下滑滚轮，它就往下跳转页面，而且跳转的幅度很大」。
 *
 * 根因有三层，全部叠加：
 *   1. 锚点用的是「当前页」，不是光标实际所在的那一页
 *   2. 补偿量把「页面坐标 × 缩放比」又除了以页面高度（差 1123 倍）
 *   3. 页间距是用 offsetTop 量的——offsetTop 被取整到整数像素，
 *      0.24px 的误差乘以页序号，到第 100 页就是 24px，整整一页
 *
 * 现在缩放补偿完全改成**从 DOM 实测**：缩放后直接量内容点此刻的
 * 真实屏幕位置，跟光标位置一减就是要补偿的量。模型误差全部消失。
 *
 * 残留误差只有浏览器把 scrollTop 取整带来的 ±0.5px，
 * 而且它**不累积**（每轮重新实测）。
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

function makeBook(n: number): InkBook {
  const book = createBook("跳页回归", "grid", "white");
  book.pages = [];
  for (let i = 0; i < n; i++) book.pages.push(createPage("grid", "white"));
  return book;
}

/** 造一个能滚动的宿主（内容比视口高） */
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

interface Anchor {
  index: number;
  fx: number;
  fy: number;
}

async function main() {
  const host = makeHost();
  const store = new BookStore(makeBook(30));
  const editor = new BookEditor(host, store, { smoothing: 0.5 });
  await sleep(500);

  const ed = editor as any;
  const scroll = ed.scrollEl;
  const sr = scroll.getBoundingClientRect();

  /* ---------------- 场景 1：滚到中间页再缩放 ---------------- */
  {
    editor.setZoom(1);
    await sleep(200);
    scroll.scrollTop = ed.recs[12].wrap.offsetTop;
    await sleep(200);

    const clientX = sr.left + 400;
    const clientY = ed.recs[12].pageEl.getBoundingClientRect().top + 500;
    const anchor = ed.pickAnchor(clientX, clientY) as Anchor;

    const probeAt = () => {
      const rec = ed.recs[anchor.index];
      const r = rec.pageEl.getBoundingClientRect();
      return { x: r.left + anchor.fx * r.width, y: r.top + anchor.fy * r.height };
    };
    const before = probeAt();

    editor.zoomAt(clientX, clientY, 1.12);
    await sleep(150);
    const after = probeAt();

    const drift = Math.abs(after.y - before.y);
    pass(
      drift < 1.5,
      `第 12 页放大：锚点纵向不漂移（漂移 ${drift.toFixed(2)}px）`
    );
  }

  /* ---------------- 场景 2：连续 8 次 Ctrl+滚轮放大 ---------------- */
  {
    editor.setZoom(1);
    await sleep(200);
    scroll.scrollTop = ed.recs[12].wrap.offsetTop;
    await sleep(200);

    const clientX = sr.left + 400;
    const clientY = ed.recs[12].pageEl.getBoundingClientRect().top + 500;
    const anchor = ed.pickAnchor(clientX, clientY) as Anchor;
    const probeAt = () => {
      const rec = ed.recs[anchor.index];
      const r = rec.pageEl.getBoundingClientRect();
      return { x: r.left + anchor.fx * r.width, y: r.top + anchor.fy * r.height };
    };

    const start = probeAt();
    let maxDrift = 0;
    const pageBefore = ed.current;

    for (let i = 0; i < 8; i++) {
      const b = probeAt();
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
      await sleep(120);
      const a = probeAt();
      maxDrift = Math.max(maxDrift, Math.abs(a.y - b.y));
    }

    pass(
      maxDrift < 3,
      `连续 Ctrl+滚轮放大 8 次：单次最大纵向漂移 ${maxDrift.toFixed(2)}px`
    );

    const end = probeAt();
    const total = Math.hypot(end.x - start.x, end.y - start.y);
    pass(
      total < 3,
      `连续 8 次放大后总位移 ${total.toFixed(2)}px（旧实现滚 5 次就偏 35 页）`
    );
    pass(
      ed.current === pageBefore,
      `连续缩放不跳页（当前页 ${pageBefore} → ${ed.current}）`
    );
  }

  /* ---------------- 场景 3：连续 8 次 Ctrl+滚轮缩小 ---------------- */
  {
    const clientX = sr.left + 400;
    const clientY = ed.recs[12].pageEl.getBoundingClientRect().top + 500;
    const anchor = ed.pickAnchor(clientX, clientY) as Anchor;
    const probeAt = () => {
      const rec = ed.recs[anchor.index];
      const r = rec.pageEl.getBoundingClientRect();
      return { x: r.left + anchor.fx * r.width, y: r.top + anchor.fy * r.height };
    };

    const start = probeAt();
    let maxDrift = 0;
    const pageBefore = ed.current;

    for (let i = 0; i < 8; i++) {
      const b = probeAt();
      scroll.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: 100,
          ctrlKey: true,
          clientX,
          clientY,
          bubbles: true,
          cancelable: true,
        })
      );
      await sleep(120);
      const a = probeAt();
      maxDrift = Math.max(maxDrift, Math.abs(a.y - b.y));
    }

    pass(
      maxDrift < 3,
      `连续 Ctrl+滚轮缩小 8 次：单次最大纵向漂移 ${maxDrift.toFixed(2)}px`
    );
    const end = probeAt();
    const total = Math.hypot(end.x - start.x, end.y - start.y);
    pass(
      total < 3,
      `连续 8 次缩小后总位移 ${total.toFixed(2)}px`
    );
    pass(
      ed.current === pageBefore,
      `连续缩放不跳页（当前页 ${pageBefore} → ${ed.current}）`
    );
  }

  /* ---------------- 场景 4：滚轮方向正确 ---------------- */
  {
    editor.setZoom(1);
    await sleep(200);
    const z0 = editor.getState().zoom;
    const clientX = sr.left + 400;
    const clientY = ed.recs[0].pageEl.getBoundingClientRect().top + 300;

    // 向上滚（deltaY < 0）= 放大
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
    await sleep(200);
    const zUp = editor.getState().zoom;
    pass(zUp > z0, `Ctrl+向上滚 = 放大（${z0.toFixed(2)} → ${zUp.toFixed(2)}）`);

    // 向下滚 = 缩小
    scroll.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: 100,
        ctrlKey: true,
        clientX,
        clientY,
        bubbles: true,
        cancelable: true,
      })
    );
    await sleep(200);
    const zDown = editor.getState().zoom;
    pass(
      zDown < zUp,
      `Ctrl+向下滚 = 缩小（${zUp.toFixed(2)} → ${zDown.toFixed(2)}）`
    );
  }

  /* ---------------- 场景 5：横向锚定的已知边界 ---------------- */
  {
    /*
     * 页面**居中**时，缩放会让居中位置变化，
     * 横向内容点必然位移——这是居中布局的几何后果，不是 bug。
     *
     * 数学模型：漂移 = pageW×(k-1)×(fx-0.5)
     *   fx=0.5（页面正中）→ 漂移 0
     *   fx=0 或 1（页面边缘）→ 漂移最大
     *
     * 页面**溢出**容器时（有横向滚动空间），scrollLeft 能精确补偿，
     * 漂移接近 0。
     *
     * 这里锁定这两个性质。
     */
    editor.setZoom(1);
    await sleep(200);

    // 页面正中
    const rec = ed.recs[0];
    const r0 = rec.pageEl.getBoundingClientRect();
    const cxMid = r0.left + r0.width / 2;
    const cy = r0.top + 300;
    const aMid = ed.pickAnchor(cxMid, cy) as Anchor;
    const pMid = () => {
      const rr = ed.recs[aMid.index].pageEl.getBoundingClientRect();
      return rr.left + aMid.fx * rr.width;
    };
    const midBefore = pMid();
    editor.zoomAt(cxMid, cy, 1.12);
    await sleep(150);
    const midAfter = pMid();
    pass(
      Math.abs(midAfter - midBefore) < 1.5,
      `页面正中缩放：横向漂移 ${Math.abs(midAfter - midBefore).toFixed(2)}px`
    );
    editor.zoomAt(cxMid, cy, 1 / 1.12);
    await sleep(150);

    // 页面溢出容器（有横向滚动空间）
    editor.setZoom(1.8);
    await sleep(250);
    const r1 = ed.recs[0].pageEl.getBoundingClientRect();
    const cxEdge = r1.left + 40;
    const cy1 = r1.top + 200;
    const aEdge = ed.pickAnchor(cxEdge, cy1) as Anchor;
    const pEdge = () => {
      const rr = ed.recs[aEdge.index].pageEl.getBoundingClientRect();
      return rr.left + aEdge.fx * rr.width;
    };
    const edgeBefore = pEdge();
    editor.zoomAt(cxEdge, cy1, 1.12);
    await sleep(150);
    const edgeAfter = pEdge();
    pass(
      Math.abs(edgeAfter - edgeBefore) < 1.5,
      `页面溢出时缩放：横向精确锚定（漂移 ${Math.abs(edgeAfter - edgeBefore).toFixed(2)}px）`
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
