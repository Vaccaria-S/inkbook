import { BookEditor, TEXT_FONTS, textFontStack } from "../src/editor";
import { BookStore } from "../src/store";
import { createBook, createPage, type Pt, type Stroke } from "../src/types";
import { readBook, writeBook } from "../src/storage";
import { straightenPoints } from "../src/geometry";
import { availableTextWidth, layoutUserText, wrapText } from "../src/textwrap";
import {
  buildPageIndex,
  indexDirFor,
  indexFileName,
  indexPagePath,
  isLegacyIndexPageName,
  parseIndexPath,
  removeTextIndex,
  writeTextIndex,
} from "../src/indexer";
import { importPdf } from "../src/importer";

const lines: string[] = [];
const out = document.getElementById("out")!;
function log(s: string) {
  lines.push(s);
  out.textContent = lines.join("\n");
}
function pass(ok: boolean, msg: string) {
  log((ok ? "PASS " : "FAIL ") + msg);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
window.addEventListener("error", (e) => log("ERROR " + e.message + " @ " + e.filename + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => log("REJECT " + (e.reason?.stack || e.reason)));

const book = createBook("测试手写本", "grid", "white");
book.pages.push(createPage("lined", "cream"));
const store = new BookStore(book);
const host = document.getElementById("view-host")!;
let editor: BookEditor;
editor = new BookEditor(host, store, {
  penOnly: false,
  pressure: 1,
  onState: () => {},
  onChange: () => {},
  onPageChange: () => {},
});

function pageEl(): HTMLElement {
  return document.querySelector(".mb-page") as HTMLElement;
}
function ev(type: string, x: number, y: number, buttons: number, pointerId = 7): PointerEvent {
  const r = pageEl().getBoundingClientRect();
  const k = r.width / 794;
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons,
    clientX: r.left + x * k,
    clientY: r.top + y * k,
    pressure: type === "pointerup" ? 0 : 0.5,
  });
}
async function draw(points: Array<[number, number]>, pointerId = 7) {
  pageEl().dispatchEvent(ev("pointerdown", points[0][0], points[0][1], 1, pointerId));
  for (let i = 1; i < points.length; i++) {
    pageEl().dispatchEvent(ev("pointermove", points[i][0], points[i][1], 1, pointerId));
    await sleep(2);
  }
  const last = points[points.length - 1];
  pageEl().dispatchEvent(ev("pointerup", last[0], last[1], 0, pointerId));
  await sleep(30);
}

/** 自定义 pointerType / pressure 的事件（橡皮圈、双指捏合用） */
function ptr(
  type: string,
  x: number,
  y: number,
  buttons: number,
  pointerId: number,
  pointerType = "mouse",
  pressure = 0.5
): PointerEvent {
  const r = pageEl().getBoundingClientRect();
  const k = r.width / 794;
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId,
    pointerType,
    isPrimary: true,
    button: 0,
    buttons,
    clientX: r.left + x * k,
    clientY: r.top + y * k,
    pressure: type === "pointerup" ? 0 : pressure,
  });
}

/** 从当前页 overlay 的圆心/圆周取像素，判断橡皮圈画没画 */
function overlayAlphaAt(x: number, y: number): number {
  const cv = document.querySelector(".mb-overlay") as HTMLCanvasElement;
  const k = cv.width / 794;
  const d = cv.getContext("2d")!.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data;
  return d[3];
}

async function main() {
  await sleep(500);
  const s0 = editor.getState();
  pass(s0.pageCount === 2, "2 页已渲染");
  pass(document.querySelectorAll(".mb-page").length === 2, "DOM 页数 = 2");
  pass(document.querySelectorAll(".mb-canvas").length >= 1, "当前页画布已挂载");
  pass(!!pageEl(), "拿到页面元素");

  /* 实时预览：还没抬笔时 overlay 上就应该有墨 */
  editor.setTool("pen");
  pageEl().dispatchEvent(ev("pointerdown", 500, 650, 1, 5));
  for (let i = 1; i <= 12; i++) {
    pageEl().dispatchEvent(ev("pointermove", 500 + i * 8, 650 + Math.sin(i / 2) * 12, 1, 5));
    await sleep(2);
  }
  await sleep(60);
  const overlay = document.querySelector(".mb-overlay") as HTMLCanvasElement;
  const ictx = overlay.getContext("2d")!;
  const pixels = ictx.getImageData(0, 0, overlay.width, overlay.height).data;
  let inkPixels = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 12) inkPixels++;
  pass(inkPixels > 30, "抬笔前 overlay 有 " + inkPixels + " 个墨点像素");
  pageEl().dispatchEvent(ev("pointerup", 596, 650, 0, 5));
  await sleep(40);
  editor.undo();
  await sleep(40);
  pass(store.strokeCount === 0, "预览测试笔迹可撤销");

  /* 落笔 */
  const wave: Array<[number, number]> = [];
  for (let i = 0; i < 48; i++) wave.push([110 + i * 9, 220 + Math.sin(i / 4) * 40]);
  await draw(wave);
  pass(store.strokeCount === 1, "落笔写入 1 条笔迹：" + store.strokeCount);
  const stroke = store.page.layers[0].strokes[0];
  pass(!!stroke && stroke.points.length > 20, "点数 " + (stroke?.points.length || 0));
  pass(!!stroke && stroke.points.some((p) => p[2] !== 0.5), "记录了非恒定压力");

  /*
   * 单击（按下即抬起、不移动）也必须留下一个点。
   * 用户报「用钢笔点了一个点，它就是不显示」——先钉住数据层：
   * 如果这里就没有笔迹，问题在落笔/提交路径；如果这里有，问题在渲染。
   */
  {
    const n0 = store.strokeCount;
    await draw([[300, 500]], 11);
    pass(store.strokeCount === n0 + 1, "单击不移动也写入 1 条笔迹（" + n0 + " → " + store.strokeCount + "）");
    const dot = store.page.layers[0].strokes[store.page.layers[0].strokes.length - 1];
    pass(!!dot && dot.points.length === 1, "单击笔迹只有 1 个点（" + (dot?.points.length ?? 0) + "）");
    /*
     * 渲染层：低缩放下单点必须有**看得见**的面积。
     * 修复前这里只有 2 个深色像素（几何半径 0.86 设备像素），
     * 用户看到的就是「点了一下没画上」。修复后要求至少 4 个。
     */
    await sleep(60);
    const cv = document.querySelector(".mb-canvas") as HTMLCanvasElement;
    const ctx2 = cv.getContext("2d")!;
    const z = editor.getState().zoom;
    const k2 = cv.width / 794;
    const cx = Math.round(300 * k2);
    const cy = Math.round(500 * k2);
    const pad = Math.max(4, Math.round(6 * k2));
    const img = ctx2.getImageData(
      Math.max(0, cx - pad),
      Math.max(0, cy - pad),
      pad * 2,
      pad * 2
    ).data;
    let dark = 0;
    for (let i = 0; i < img.length; i += 4) {
      if ((img[i] + img[i + 1] + img[i + 2]) / 3 < 160) dark++;
    }
    pass(
      dark >= 4,
      "单击点在低缩放下也看得见（" + dark + " 个深色像素，zoom " + z.toFixed(2) + "，修复前 2 个）"
    );
    // 收尾：把这个点撤掉，后面的断言仍按原来的笔迹条数算
    editor.undo();
    await sleep(40);
    pass(store.strokeCount === n0, "单击测试收尾：撤销后回到 " + n0 + " 条");
  }

  /*
   * 放大后细写：同样的屏幕小步移动，在 2.8 倍下必须仍然被采样。
   * 旧实现的采样阈值固定 0.55 页面单位（2.8 倍时 = 1.54 CSS px），
   * 细小的转折会被整段丢掉，用户感觉「放大再写识别得比较粗糙」。
   */
  {
    const zPrev = editor.getState().zoom;
    editor.setZoom(2.8);
    await sleep(220);
    const r2 = pageEl().getBoundingClientRect();
    const n0 = store.strokeCount;
    const pid = 12;
    const at = (type: string, dx: number, dy: number, buttons: number) =>
      pageEl().dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: pid,
          pointerType: "pen",
          isPrimary: true,
          button: 0,
          buttons,
          clientX: r2.left + dx,
          clientY: r2.top + dy,
          pressure: 0.5,
        })
      );
    at("pointerdown", 300, 300, 1);
    for (let i = 1; i <= 80; i += 1) {
      at("pointermove", 300 + i * 0.5, 300 + Math.sin(i / 6) * 2, 1);
      if (i % 8 === 0) await sleep(8);
    }
    at("pointerup", 340, 300, 0);
    await sleep(80);
    const fine = store.page.layers[0].strokes[store.page.layers[0].strokes.length - 1];
    pass(store.strokeCount === n0 + 1, "2.8 倍细写：写入了 1 条笔迹");
    pass(
      !!fine && fine.points.length >= 50,
      "2.8 倍细写：微小位移仍被采样（" + (fine?.points.length ?? 0) + " 点，旧阈值会只剩约 1/3）"
    );
    editor.undo();
    await sleep(40);
    editor.setZoom(zPrev);
    await sleep(220);
  }

  /*
   * 放大后**右键拖动**画面（2026-11-07 用户要求）。
   *
   * 放大后纸比屏幕大，靠滚动条拖很别扭；鼠标用户习惯「按住右键拖画布」。
   * 中键早就是这个行为（`button === 1`），右键补齐。
   *
   * 三个要点：
   *   1. 右键按下要真的滚（scrollTop 变化）；
   *   2. 右键**不能落笔**（笔迹数不变）；
   *   3. `contextmenu` 要被拦掉（否则系统菜单一弹，拖动就中断）。
   */
  {
    const zPrev = editor.getState().zoom;
    editor.setZoom(2.8);
    await sleep(250);
    const sc = (editor as any).scrollEl as HTMLElement;
    const topOriginal = sc.scrollTop;
    sc.scrollTop = 400;
    await sleep(60);
    const topBefore = sc.scrollTop;
    const n0 = store.strokeCount;

    const r3 = pageEl().getBoundingClientRect();
    const right = (type: string, dy: number, buttons: number) =>
      pageEl().dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 77,
          pointerType: "mouse",
          isPrimary: true,
          button: 2, // 右键
          buttons,
          clientX: r3.left + 300,
          clientY: r3.top + 300 + dy,
          pressure: 0,
        })
      );
    right("pointerdown", 0, 2);
    for (let i = 1; i <= 10; i++) {
      right("pointermove", -i * 10, 2); // 往上拖 → 内容下移 → scrollTop 减小
      await sleep(4);
    }
    right("pointerup", -100, 0);
    await sleep(80);

    /*
     * 向上拖（clientY 减小）→ 纸跟手上移 → scrollTop **变大**。
     * 这是「抓住纸往上拽」的直觉，和中键/手指拖动一致。
     */
    pass(
      sc.scrollTop > topBefore + 40,
      "右键拖动会滚动画面（scrollTop " + topBefore + " → " + Math.round(sc.scrollTop) + "）"
    );
    pass(store.strokeCount === n0, "右键拖动不落笔（笔迹 " + n0 + " → " + store.strokeCount + "）");

    // contextmenu 必须被拦掉
    const cm = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    pageEl().dispatchEvent(cm);
    pass(cm.defaultPrevented, "右键菜单被拦掉（defaultPrevented=" + cm.defaultPrevented + "）");

    editor.setZoom(zPrev);
    await sleep(200);
    // 恢复滚动位置：后面的荧光笔/擦除用例依赖页面停在原处
    sc.scrollTop = topOriginal;
    await sleep(120);
  }

  /* 撤销 / 重做 */
  editor.undo();
  pass(store.strokeCount === 0, "撤销后 0 条");
  editor.redo();
  pass(store.strokeCount === 1, "重做后 1 条");

  /*
   * 有挂起快照时 redo 仍要生效（2026-11-07 修）：
   * 老实现 redo() 开头 `settleHistory()` → `pushHistory()` 会清空 redoStack，
   * 紧接着 `redoStack.pop()` 拿到 undefined → 首次重做直接返回 false。
   * 这里人为挂一个 pendingBefore，再验 redo 仍能重做。
   */
  {
    editor.undo();
    await sleep(40);
    pass(store.strokeCount === 0, "挂起快照测试：先撤销到 0 条");
    // 人为制造「挂起的快照」（真实场景：snapshotPage 之后、touch 之前）
    (store as any).snapshotPage(store.data.activePage);
    const ok = store.redo();
    await sleep(40);
    pass(ok && store.strokeCount === 1, "有挂起快照时 redo 仍生效（不会误清 redoStack）");
    // 清理人为挂起的快照，别污染后续断言
    (store as any).pendingBefore = null;
    (store as any).settleHistory?.(true);
    (store as any).undoStack.length = 0;
    (store as any).redoStack.length = 0;
  }

  /* 荧光笔 */
  editor.setTool("highlighter");
  await draw([
    [120, 330],
    [300, 332],
    [520, 330],
  ]);
  pass(store.strokeCount === 2, "荧光笔新增 1 条");
  const hl = store.page.layers[0].strokes[1];
  pass(hl?.tool === "highlighter" && hl.opacity < 0.5, "荧光笔半透明");

  /* 整笔擦除 */
  editor.setTool("eraser");
  editor.setEraserMode("whole");
  editor.eraserSize = 30;
  await draw([[300, 332]]);
  pass(store.strokeCount === 1, "整笔擦掉荧光笔，剩 " + store.strokeCount);
  editor.undo();
  pass(store.strokeCount === 2, "擦除可撤销");

  /* 局部擦除 */
  editor.setEraserMode("part");
  editor.eraserSize = 24;
  await draw([[300, 332], [330, 332]]);
  pass(store.strokeCount >= 2, "局部擦后笔迹条数：" + store.strokeCount);
  editor.undo();
  pass(store.strokeCount === 2, "局部擦可撤销");

  /*
   * 擦除性能：手势期间不允许整页重画。
   *
   * 旧实现每个 pointermove 都 renderRec：清整页 + 重画全部笔迹，
   * 1000 笔的页面上平板上要 10~30ms/帧，擦字明显发滞。
   * 现在只局部重绘受影响的矩形，抬手才整页重画一次兜底。
   */
  {
    editor.setTool("eraser");
    editor.setEraserMode("part");
    // 比默认稍大：擦出的缺口要明显宽于荧光笔两端的圆帽，
    // 否则采样点会压到切口的半圆笔帽上，纸色断言不稳
    editor.eraserSize = 40;
    await sleep(40);
    const n0 = store.strokeCount;
    const cv = document.querySelector(".mb-canvas") as HTMLCanvasElement;
    const mctx = cv.getContext("2d")!;
    const sx = cv.width / store.data.width;
    const sy = cv.height / store.data.height;
    // 9×9 平均色：避开单像素抗锯齿的抖动
    const avg = (x: number, y: number) => {
      const r = 4;
      const d = mctx.getImageData(
        Math.max(0, Math.round(x * sx) - r),
        Math.max(0, Math.round(y * sy) - r),
        r * 2 + 1,
        r * 2 + 1
      ).data;
      let R = 0,
        G = 0,
        B = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        R += d[i];
        G += d[i + 1];
        B += d[i + 2];
      }
      return { r: R / n, g: G / n, b: B / n };
    };
    const inkedBefore = avg(300, 332);
    pass(
      inkedBefore.b < 220,
      "擦除前 (300,332) 是荧光笔墨色（b=" + inkedBefore.b.toFixed(0) + "）"
    );

    // renderRec 是唯一的整页重画入口，挂探针数次数
    const realRenderRec = editor.renderRec.bind(editor);
    let fullRenders = 0;
    (editor as any).renderRec = (r: any) => {
      fullRenders++;
      realRenderRec(r);
    };

    const pid = 31;
    pageEl().dispatchEvent(ev("pointerdown", 300, 332, 1, pid));
    for (const x of [312, 324, 336]) {
      pageEl().dispatchEvent(ev("pointermove", x, 332, 1, pid));
      await sleep(4);
    }
    await sleep(30);
    pass(fullRenders === 0, "擦除过程中没有整页重画（renderRec 0 次）");
    const during = avg(300, 332);
    pass(
      during.b > 235,
      "擦除过程中被擦处已是纸色（局部重绘生效，b=" + during.b.toFixed(0) + "）"
    );
    pass(
      avg(150, 330).b < 230,
      "擦除过程中未擦到的部分仍在（局部重绘没有多擦）"
    );

    pageEl().dispatchEvent(ev("pointerup", 336, 332, 0, pid));
    await sleep(40);
    pass(fullRenders === 1, "抬手后整页重画恰好 1 次（" + fullRenders + "）");
    pass(
      store.strokeCount > n0,
      "抬手后被擦的荧光笔已切分（" + n0 + " → " + store.strokeCount + "）"
    );
    pass(avg(300, 332).b > 235, "抬手后被擦处保持纸色");
    // 撤掉探针，恢复原型上的 renderRec
    delete (editor as any).renderRec;

    editor.undo();
    await sleep(60);
    pass(
      store.strokeCount === n0,
      "一条擦除手势只记一条撤销（撤销后回到 " + n0 + " 条）"
    );
    pass(avg(300, 332).b < 230, "撤销后荧光笔墨迹像素恢复");
  }

  /* ================= INK-186：橡皮圈 = 光标 = 真实擦除范围 =================
   *
   * 用户报的两条：① 橡皮工具下鼠标进了笔记就完全不显示，只有按下才冒圈；
   * ② 擦出来的范围比圈大（圈 13、实际擦 20）。
   * 外加审查员挖出的 1 个 🔴（双指捏合打断擦除会吞掉撤销记录）
   * 与几个 🟡（幽灵圈 / 隐藏层 / 切层 / 合并事件漏擦）。
   */
  {
    editor.setTool("eraser");
    editor.setEraserMode("part");
    editor.eraserSize = 26;
    await sleep(50);
    const hx = 250;
    const hy = 500;
    const doc = document.querySelector(".mb-doc") as HTMLElement;

    /* ---- ① 悬停（不按下）就该有圈 ---- */
    pageEl().dispatchEvent(ev("pointermove", hx, hy, 0, 61));
    await sleep(60);
    const hoverCircle = (editor as any).eraserPos;
    pass(!!hoverCircle, "INK-186 鼠标悬停不按下：overlay 有橡皮圈数据");
    pass(
      !!hoverCircle && Math.abs(hoverCircle.x - hx) < 2 && Math.abs(hoverCircle.y - hy) < 2,
      "INK-186 悬停圈落在鼠标位置（页面坐标 " +
        (hoverCircle ? hoverCircle.x.toFixed(0) + "," + hoverCircle.y.toFixed(0) : "-") + "）"
    );
    pass(overlayAlphaAt(hx, hy) > 12, "INK-186 悬停时 overlay 圆心真的画出了像素");

    /* ---- ② 圈半径 = 实际擦除半径（同一个公式） ---- */
    const expectedR = (editor as any).eraserRadiusAt(null);
    pass(
      !!hoverCircle && Math.abs(hoverCircle.r - expectedR) < 0.001,
      "INK-186 悬停圈半径 = eraserRadiusAt (" +
        (hoverCircle ? hoverCircle.r.toFixed(2) : "-") + " / " + expectedR.toFixed(2) + ")"
    );
    pass(
      Math.abs(expectedR - 26 / 2 * 1.55) < 0.001,
      "INK-186 鼠标（press=1）半径是 20.15，不再是旧的恒定 13"
    );

    /*
     * 行为层面的边界验证：把橡皮圆心放在笔迹的**垂直方向**上，
     * 才能用「距圆心多远」干净地量半径（水平方向圆心会落在线段上，距离恒为 0）。
     *
     * r = 20.15，penSize/2 = 1.4，strokeHit 的 reach = 21.55。
     *  · 距 30 > reach：不该擦到；
     *  · 距 17 < reach：该擦到，且**圈的半径必须 ≥ 17 才盖得住这段笔迹**。
     *    旧代码画圈用 13（< 17）却擦掉 17 处的笔迹，正是用户报的
     *    「擦出的范围跟圈有出入」——这条断言会当场失败。
     */
    const r = expectedR;
    const nBefore = store.strokeCount;
    editor.setTool("pen");
    /*
     * 用**多个点**画：1€ 滤波会把「只有两个点」的线段严重收缩
     * （起点 210 → 终点 290，滤波后实际只到 212），
     * 那样测出来的笔迹根本不是水平的 80 单位长，边界断言就失真了。
     */
    const lineePts: Array<[number, number]> = [];
    for (let i = 0; i <= 16; i++) lineePts.push([hx - 40 + i * 5, hy]);
    await draw(lineePts, 62);
    pass(store.strokeCount === nBefore + 1, "INK-186 边缘测试：先画好一条水平笔迹");
    editor.setTool("eraser");
    editor.setEraserMode("whole"); // 整笔模式：擦到就整条删，条数好数
    await draw([[hx, hy + 30]], 63);
    pass(
      store.strokeCount === nBefore + 1,
      "INK-186 距圆心 30 (> reach 21.55) 的笔迹擦不到"
    );
    await draw([[hx, hy + 17]], 64);
    pass(
      store.strokeCount === nBefore,
      "INK-186 距圆心 17 (< reach) 的笔迹确实被擦掉"
    );
    pass(
      r >= 17,
      "INK-186 圈半径 " + r.toFixed(2) + " ≥ 17，盖得住刚被擦到的笔迹（旧圈 13 会失败）"
    );
    editor.undo();
    await sleep(40);
    pass(store.strokeCount === nBefore + 1, "INK-186 圈内擦除可撤销");
    editor.undo();
    await sleep(40);
    pass(store.strokeCount === nBefore, "INK-186 边缘测试笔迹撤干净");
    editor.setEraserMode("part");

    /*
     * ---- ②b 短笔迹的**端部外**也要能擦到（INK-188）----
     *
     * `strokeHit` 的第一道门是按 `strokeBounds` 判包围盒，而那个包围盒
     * 只外扩了 `size/2 + 5`（够画抗锯齿，**不够判命中**）。
     * 一条只有十几单位长的短笔迹，包围盒右边界离笔迹末端只有 6.4，
     * 橡皮半径 20 盖到 26 —— 在 20 处擦，距末端只有 20 < reach 21.55，
     * 明明该擦到，却被包围盒挡掉。用户感受：「圈罩住了笔迹就是擦不掉」。
     */
    {
      const n0 = store.strokeCount;
      editor.setTool("pen");
      // 一条很短的横线（末端约在 hx+12）
      const shortPts: Array<[number, number]> = [];
      for (let i = 0; i <= 8; i++) shortPts.push([hx, hy + 200 + i * 1.5]);
      await draw(shortPts, 80);
      const shortStroke = store.page.layers[0].strokes[store.page.layers[0].strokes.length - 1];
      const endY = Math.max(...shortStroke.points.map((p) => p[1]));
      editor.setTool("eraser");
      editor.setEraserMode("whole");
      // 在笔迹末端**下方 18 单位**擦：距末端 18 < reach 21.55，但远在包围盒外
      await draw([[hx, endY + 18]], 81);
      pass(
        store.strokeCount === n0,
        "INK-188 短笔迹端部外侧 18 单位（圈内）能擦到（包围盒不该当硬门槛）"
      );
      for (let i = 0; i < 4 && store.strokeCount !== n0; i++) {
        editor.undo();
        await sleep(40);
      }
      editor.setEraserMode("part");
    }

    /* ---- ③ 移出纸面 / 切工具 / 页间空隙：幽灵圈必须消失 ---- */
    pageEl().dispatchEvent(ev("pointermove", hx, hy, 0, 65));
    await sleep(50);
    pass(!!(editor as any).eraserPos, "INK-186 幽灵圈：先悬停造出一个圈");
    doc.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true, pointerId: 65, pointerType: "mouse" }));
    await sleep(50);
    pass(!(editor as any).eraserPos, "INK-186 鼠标移出纸面后圈被清掉");
    pass(overlayAlphaAt(hx, hy) < 12, "INK-186 移出纸面后 overlay 上不再有圈像素");

    pageEl().dispatchEvent(ev("pointermove", hx, hy, 0, 66));
    await sleep(50);
    editor.setTool("pen");
    await sleep(50);
    pass(!(editor as any).eraserPos, "INK-186 切走橡皮工具后圈被清掉");
    pass(overlayAlphaAt(hx, hy) < 12, "INK-186 切工具后 overlay 上不再有幽灵圈像素");

    /* ---- ④ 手指 / 笔不该有悬停圈（只有鼠标有 hover） ---- */
    editor.setTool("eraser");
    pageEl().dispatchEvent(ptr("pointermove", hx, hy, 0, 67, "touch", 0.5));
    await sleep(50);
    pass(!(editor as any).eraserPos, "INK-186 手指没有 hover，不画悬停圈");
    pageEl().dispatchEvent(ptr("pointermove", hx, hy, 0, 68, "pen", 0.5));
    await sleep(50);
    pass(!(editor as any).eraserPos, "INK-186 笔尖悬停不画范围圈（只有笔尖预览）");

    /* ---- ⑤ 缩放后圈仍落在正确位置 ---- */
    const zPrev = editor.getState().zoom;
    editor.setZoom(2.0);
    await sleep(200);
    pageEl().dispatchEvent(ev("pointermove", hx, hy, 0, 69));
    await sleep(60);
    const zoomed = (editor as any).eraserPos;
    pass(
      !!zoomed && Math.abs(zoomed.x - hx) < 2 && Math.abs(zoomed.y - hy) < 2,
      "INK-186 2 倍缩放后悬停圈仍在页面坐标 (" +
        (zoomed ? zoomed.x.toFixed(0) + "," + zoomed.y.toFixed(0) : "-") + ")"
    );
    editor.setZoom(zPrev);
    await sleep(200);
    doc.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true, pointerId: 69, pointerType: "mouse" }));
    await sleep(30);

    /* ---- ⑥ 🔴 双指捏合打断擦除手势，撤销记录不能丢 ---- */
    {
      const n0 = store.strokeCount;
      editor.setTool("pen");
      // 多点画线：只有两个点会被 1€ 滤波收缩，笔迹长度不够就擦不到（同边缘测试）
      const pinchLine: Array<[number, number]> = [];
      for (let i = 0; i <= 16; i++) pinchLine.push([400 + i * 10, 900]);
      await draw(pinchLine, 70);
      pass(store.strokeCount === n0 + 1, "INK-186 捏合测试：先画一条笔迹");
      const beforeErase = store.strokeCount;
      editor.setTool("eraser");
      editor.setEraserMode("whole");
      editor.setTouchDraw(true);
      // 手指按下开始擦（擦掉刚画的笔迹）
      pageEl().dispatchEvent(ptr("pointerdown", 480, 900, 1, 71, "touch", 0.5));
      pageEl().dispatchEvent(ptr("pointermove", 481, 900, 1, 71, "touch", 0.5));
      await sleep(20);
      pass(store.strokeCount === n0, "INK-186 捏合测试：第一指已擦掉笔迹");
      // 第二根手指落下 → 仲裁器进入双指手势 → beginPinch 打断擦除手势
      pageEl().dispatchEvent(ptr("pointerdown", 300, 700, 1, 72, "touch", 0.5));
      await sleep(40);
      pass((editor as any).gesture !== "erase", "INK-186 捏合打断后 gesture 已复位");
      // 关键：这一段擦除必须进撤销栈，Ctrl+Z 能撤回来
      editor.undo();
      await sleep(50);
      pass(
        store.strokeCount === beforeErase,
        "INK-186 🔴 双指打断后擦除仍可撤销（" + store.strokeCount + " → " + beforeErase + "）"
      );
      // 收尾：抬掉两根手指，还原手势状态与测试笔迹
      for (const id of [71, 72]) {
        pageEl().dispatchEvent(ptr("pointerup", 300, 700, 0, id, "touch", 0));
      }
      await sleep(60);
      editor.setTouchDraw(false);
      editor.undo();
      await sleep(40);
      pass(store.strokeCount === n0, "INK-186 捏合测试收尾：笔迹撤干净");
    }

    /* ---- ⑦ 🟡 隐藏层不该被擦 ---- */
    {
      const n0 = store.strokeCount;
      editor.setTool("pen");
      await draw([
        [120, 1000],
        [240, 1000],
      ], 73);
      const layer = store.page.layers[0];
      const nWith = store.strokeCount;
      // 直接改 visible：toggleLayer 会 snapshotPage，多出历史会打乱收尾的 undo 计数
      layer.visible = false;
      pass(!layer.visible, "INK-186 隐藏层测试：当前层已隐藏");
      editor.setTool("eraser");
      editor.setEraserMode("whole");
      await draw([[180, 1000]], 74);
      pass(
        store.strokeCount === nWith,
        "INK-186 🟡 在隐藏层上擦不删数据（条数仍 " + nWith + "）"
      );
      layer.visible = true; // 恢复显示
      editor.setTool("pen");
      editor.undo();
      await sleep(40);
      pass(store.strokeCount === n0, "INK-186 隐藏层测试收尾");
    }

    /* ---- ⑧ 🟡 合并事件（一帧多个坐标）不能漏擦 ---- */
    {
      const n0 = store.strokeCount;
      editor.setTool("pen");
      // 多点画线（同前：两个点会被 1€ 滤波收缩）
      const mergeLine: Array<[number, number]> = [];
      for (let i = 0; i <= 16; i++) mergeLine.push([300 + i * 12.5, 1050]);
      await draw(mergeLine, 75);
      editor.setTool("eraser");
      editor.setEraserMode("part");
      editor.eraserSize = 10;
      /*
       * 直接在 eraseAt 上挂探针数它被调用了几次：
       * 一帧里 3 个合并坐标就必须擦 3 次，旧实现只用帧末坐标会只调 1 次，
       * 相邻点间距超过橡皮直径时留下「断带」。
       * 比数切分段数稳——段数会被 splitStrokeByEraser 的重密化吃掉。
       */
      const realEraseAt = (editor as any).eraseAt.bind(editor);
      let eraseCalls = 0;
      (editor as any).eraseAt = (...args: any[]) => {
        eraseCalls++;
        return realEraseAt(...args);
      };
      const down = ev("pointerdown", 360, 1050, 1, 76);
      const move = ev("pointermove", 420, 1050, 1, 76);
      const merged = [
        ev("pointermove", 340, 1050, 1, 76),
        ev("pointermove", 380, 1050, 1, 76),
        ev("pointermove", 420, 1050, 1, 76),
      ];
      Object.defineProperty(move, "getCoalescedEvents", { value: () => merged });
      pageEl().dispatchEvent(down);
      pageEl().dispatchEvent(move);
      pageEl().dispatchEvent(ev("pointerup", 420, 1050, 0, 76));
      await sleep(60);
      delete (editor as any).eraseAt;
      pass(
        eraseCalls === 4,
        "INK-186 🟡 合并事件每个坐标都擦到（eraseAt 调用 " + eraseCalls + " 次，旧实现 2 次）"
      );
      /*
       * 收尾：撤到画这条线之前。
       *
       * 不用固定次数——这条线被局部擦除后可能切成多段，一次手势只记
       * **一条**历史，但前面还有「画线」那一条。撤到 strokeCount === n0
       * 为止最稳（最多撤 5 次兜底）。
       */
      for (let i = 0; i < 5 && store.strokeCount !== n0; i++) {
        editor.undo();
        await sleep(40);
      }
      editor.eraserSize = 26;
      pass(store.strokeCount === n0, "INK-186 合并事件测试收尾");
    }

    editor.setTool("pen");
    doc.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true, pointerId: 79, pointerType: "mouse" }));
    await sleep(30);
  }

  /* 文字：添加、编辑、删除、撤销、导出 */
  {
    editor.setTool("text");
    pageEl().dispatchEvent(ev("pointerdown", 200, 300, 1, 21));
    pageEl().dispatchEvent(ev("pointerup", 200, 300, 0, 21));
    await sleep(60);
    const ta = pageEl().querySelector(".mb-text-edit") as HTMLTextAreaElement;
    pass(!!ta, "文字工具点页面后出现输入框");
    pass(!!ta && document.activeElement === ta, "输入框自动获得焦点");

    if (ta) {
      ta.value = "第一行文字";
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
    await sleep(60);

    // 字号：新建的文字应该用当前设定
    editor.setTextSize(24);
    editor.setTool("pen");
    editor.setTool("text");
    pageEl().dispatchEvent(ev("pointerdown", 300, 420, 1, 23));
    pageEl().dispatchEvent(ev("pointerup", 300, 420, 0, 23));
    await sleep(60);
    const taBig = pageEl().querySelector(".mb-text-edit") as HTMLTextAreaElement;
    if (taBig) {
      taBig.value = "大字";
      taBig.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
    await sleep(60);
    const big = (store.data.pages[0].texts || []).find((t) => t.text === "大字");
    pass(big?.size === 24, "字号按设定写入（" + (big?.size ?? "-") + "）");
    editor.setTextSize(18);
    // 收尾：只留前面那条，后面的断言按 1 条算
    editor.undo();
    await sleep(40);

    const texts = store.data.pages[0].texts || [];
    pass(texts.length === 1, "文字已写入页面数据（" + texts.length + " 条）");
    pass(texts[0]?.source === "user", "来源标记为 user");
    pass(texts[0]?.text === "第一行文字", "内容正确：" + JSON.stringify(texts[0]?.text || ""));
    pass(Math.abs((texts[0]?.x ?? 0) - 200) < 2, "横向位置落在点击处（" + (texts[0]?.x ?? 0).toFixed(0) + "）");
    pass(!pageEl().querySelector(".mb-text-edit"), "提交后输入框已移除");

    /*
     * 输入框开着时点纸面空白：**只提交，不新建**。
     * 旧行为是「提交旧框 → 又在落点弹一个新框」，用户想结束输入要点好几下，
     * 框越点越多（真机：文字工具在平板上「点不出去」）。
     *
     * 这里刻意**不输入文字**：空框提交是 no-op，不会动 texts 计数，
     * 后面的断言仍按 1 条算。
     */
    {
      const nTexts0 = (store.data.pages[0].texts || []).length;
      editor.setTool("text");
      // 点一处**没有文字**的空白（200,300 已有文字，点它会走「选中」而不是新建）
      pageEl().dispatchEvent(ev("pointerdown", 500, 850, 1, 21));
      pageEl().dispatchEvent(ev("pointerup", 500, 850, 0, 21));
      await sleep(60);
      const ta2 = pageEl().querySelector(".mb-text-edit") as HTMLTextAreaElement;
      pass(!!ta2, "再点一处空白：新开一个输入框");
      if (ta2) {
        pageEl().dispatchEvent(ev("pointerdown", 500, 600, 1, 22));
        pageEl().dispatchEvent(ev("pointerup", 500, 600, 0, 22));
        await sleep(60);
        pass(
          !pageEl().querySelector(".mb-text-edit"),
          "已有输入框时点纸面空白：只提交关闭，不再新建一个"
        );
        pass(
          (store.data.pages[0].texts || []).length === nTexts0,
          "点空白提交空框后文字条数不变（" +
            (store.data.pages[0].texts || []).length +
            " 条）"
        );
      }
    }

    const spans = pageEl().querySelectorAll(".mb-text.is-user");
    pass(spans.length === 1 && spans[0].textContent === "第一行文字", "文字层渲染出可见文字");

    /*
     * 点同一处：第一下只选中，浮出属性条。
     * 用户原话是「没法选中这段文字进行编辑和删除」——选中态就是为这个加的。
     */
    pageEl().dispatchEvent(ev("pointerdown", 206, 300, 1, 22));
    pageEl().dispatchEvent(ev("pointerup", 206, 300, 0, 22));
    await sleep(60);
    const bar = pageEl().querySelector(".mb-textbar") as HTMLElement;
    pass(!!bar, "点已有文字先选中，纸上浮出属性条");
    pass(!!editor.selectedText, "editor 记住了选中的那段文字");
    pass(!pageEl().querySelector(".mb-text-edit"), "第一下选中，不会直接弹输入框");
    pass(
      (bar?.querySelectorAll(".mb-tb-dot").length ?? 0) >= 4,
      "属性条上有颜色点（" + (bar?.querySelectorAll(".mb-tb-dot").length ?? 0) + " 个）"
    );
    pass(!!bar?.querySelector(".mb-tb-font"), "属性条上有字体下拉");

    // 再点一次才进编辑
    pageEl().dispatchEvent(ev("pointerdown", 206, 300, 1, 24));
    pageEl().dispatchEvent(ev("pointerup", 206, 300, 0, 24));
    await sleep(60);
    const ta2 = pageEl().querySelector(".mb-text-edit") as HTMLTextAreaElement;
    pass(!!ta2 && ta2.value === "第一行文字", "再点一次进入编辑（预填原文）");

    // Esc 只取消编辑，不删原文
    ta2?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(60);
    pass((store.data.pages[0].texts || []).length === 1, "Esc 只取消编辑，原文还在");

    /* ---------------- 选中后改字号 / 字体 / 颜色 ---------------- */
    editor.selectText((store.data.pages[0].texts || [])[0].id);
    await sleep(30);

    editor.updateSelectedText({ size: 28 });
    await sleep(30);
    pass(
      store.data.pages[0].texts?.[0]?.size === 28,
      "选中后改字号生效（" + (store.data.pages[0].texts?.[0]?.size ?? "-") + "）"
    );

    editor.updateSelectedText({ font: "serif" });
    await sleep(30);
    pass(
      store.data.pages[0].texts?.[0]?.font === "serif",
      "选中后改字体生效（" + (store.data.pages[0].texts?.[0]?.font ?? "-") + "）"
    );

    editor.updateSelectedText({ color: "#D64545" });
    await sleep(30);
    pass(
      store.data.pages[0].texts?.[0]?.color === "#D64545",
      "选中后改颜色生效（" + (store.data.pages[0].texts?.[0]?.color ?? "-") + "）"
    );

    const userSpan = pageEl().querySelector(".mb-text.is-user") as HTMLElement;
    pass(userSpan?.style.fontSize === "28px", "文字层字号跟着变（" + userSpan?.style.fontSize + "）");
    pass(
      (userSpan?.style.fontFamily || "").indexOf("Songti") >= 0 ||
        (userSpan?.style.fontFamily || "").indexOf("serif") >= 0,
      "文字层字体跟着变（" + (userSpan?.style.fontFamily || "").slice(0, 24) + "）"
    );
    pass(
      (userSpan?.style.color || "").replace(/\s/g, "") !== "" &&
        userSpan.style.color !== "rgb(26, 26, 26)",
      "文字层颜色跟着变（" + userSpan?.style.color + "）"
    );

    /* ---------------- 属性条上的删除按钮 ---------------- */
    const barNow = pageEl().querySelector(".mb-textbar") as HTMLElement;
    const delBtn = Array.from(barNow?.querySelectorAll(".mb-tb-btn") ?? []).find(
      (b) => (b.textContent || "").trim() === "删除"
    ) as HTMLElement | undefined;
    pass(!!delBtn, "属性条上有「删除」按钮");
    delBtn?.click();
    await sleep(60);
    pass((store.data.pages[0].texts || []).length === 0, "属性条删除按钮能删掉这段文字");
    pass(!pageEl().querySelector(".mb-textbar"), "删除后属性条自动消失");
    pass(editor.selectedText === null, "删除后选中态清空");

    editor.undo();
    await sleep(60);
    pass((store.data.pages[0].texts || []).length === 1, "撤销后文字回来");
    pass(
      pageEl().querySelectorAll(".mb-text.is-user").length === 1,
      "撤销后文字层同步刷新（不是只在数据里）"
    );

    /*
     * 键盘删除（Delete / Esc）在 view 里做，这里没有 view 实例，
     * 挪到 dock-harness 去测。
     */

    // 导出画布必须画出用户文字，否则导出件"少一行字"
    const c = editor.exportPageCanvas(0, 1);
    const ctx = c.getContext("2d")!;
    const px = ctx.getImageData(190, 250, 240, 80).data;
    let ink = 0;
    for (let i = 0; i < px.length; i += 4) {
      const [r, g, b, a] = [px[i], px[i + 1], px[i + 2], px[i + 3]];
      if (a > 0 && (r < 240 || g < 240 || b < 240)) ink++;
    }
    pass(ink > 5, "导出画布里画出了文字（非白像素 " + ink + "）");
  }

  /* 文本层：PDF 原文透明、书写时穿透、仅阅读可选 */
  {
    const page = store.data.pages[0];
    page.texts = [
      { id: "t_pdf1", source: "pdf", x: 120, y: 200, size: 12, text: "PDF 原文一行" },
      { id: "t_pdf2", source: "pdf", x: 120, y: 230, size: 12, text: "Second line" },
    ];
    editor.renderPages();
    await sleep(80);

    const layer = pageEl().querySelector(".mb-textlayer") as HTMLElement;
    pass(!!layer, "页面里有文字层 .mb-textlayer");
    const pdfSpans = pageEl().querySelectorAll(".mb-text.is-pdf");
    pass(pdfSpans.length === 2, "PDF 原文进了文字层（" + pdfSpans.length + " 行）");

    const cs = getComputedStyle(pdfSpans[0] as HTMLElement);
    const transparent =
      cs.color === "rgba(0, 0, 0, 0)" ||
      (cs as any).webkitTextFillColor === "rgba(0, 0, 0, 0)";
    pass(transparent, "原文画成透明文字（视觉交给底图，避免重影）");

    pass(
      getComputedStyle(layer).pointerEvents === "none",
      "书写时文字层穿透（不抢触摸）"
    );

    // 仅阅读：文字层接管指针，才能拖选复制
    host.classList.add("mb-root", "is-reading");
    await sleep(30);
    pass(
      getComputedStyle(layer).pointerEvents === "auto",
      "仅阅读时文字层可选中（pointer-events:auto）"
    );
    pass(
      getComputedStyle(layer).userSelect === "text",
      "仅阅读时允许选择文字"
    );

    // 跨行选中要能复制成两行（否则粘出来是 "A行B行" 一长串）
    const rg = document.createRange();
    rg.setStart(pdfSpans[0], 0);
    const lastNode = pdfSpans[1].firstChild;
    if (lastNode) rg.setEnd(lastNode, (lastNode.textContent || "").length);
    else rg.setEndAfter(pdfSpans[1]);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(rg);
    const picked = sel?.toString() || "";
    pass(picked.includes("\n"), "拖选两行，复制内容带换行：" + JSON.stringify(picked));
    sel?.removeAllRanges();
    host.classList.remove("is-reading");
    host.classList.remove("mb-root");

    // 收尾：别让这批文字影响后面的形状测试
    page.texts = [];
    editor.renderPages();
    await sleep(80);
  }

  /* 形状 */
  editor.setTool("shape");
  editor.setShapeKind("arrow");
  await draw([
    [480, 620],
    [700, 760],
  ], 9);
  const shape = store.page.layers[0].strokes.find((x) => x.tool === "shape");
  pass(!!shape && shape.shape === "arrow", "箭头形状已写入");

  /* 图层 */
  editor.addLayer();
  pass(store.page.layers.length === 2, "新增图层");
  const activeId = store.page.activeLayerId;
  editor.setTool("pen");
  await draw([
    [120, 860],
    [220, 870],
    [320, 860],
  ], 10);
  const activeLayer = store.page.layers.find((l) => l.id === activeId)!;
  pass(activeLayer.strokes.length === 1, "新笔迹进当前图层");
  editor.toggleLayer(activeId);
  pass(store.page.layers.find((l) => l.id === activeId)!.visible === false, "图层可隐藏");
  editor.toggleLayer(activeId);
  editor.deleteLayer(activeId);
  pass(store.page.layers.length === 1, "删除图层");

  /* 页面 */
  editor.addPage();
  pass(store.pageCount === 3, "加页到 3");
  editor.duplicatePage(0);
  pass(store.pageCount === 4, "复制页到 4");
  editor.deletePage(1);
  pass(store.pageCount === 3, "删页回 3");

  /* 模板 / 纸色 */
  editor.setTemplate("planner");
  pass(store.page.template === "planner", "模板改为周计划");
  editor.setPaper("cream");
  pass(store.page.paper === "cream", "纸色改为米黄");

  /* 导出 */
  const canvas = editor.exportPageCanvas(0, 2);
  pass(canvas.width === 1588 && canvas.height === 2246, "导出画布 1588×2246");
  const ctx = canvas.getContext("2d")!;
  const data = ctx.getImageData(10, 10, 1, 1).data;
  pass(data[0] > 240 && data[1] > 240 && data[2] > 220, "导出画布有纸色");

  /* 存储 roundtrip */
  const files = new Map<string, string>();
  const adapter = {
    exists: async (p: string) => files.has(p),
    read: async (p: string) => files.get(p)!,
    write: async (p: string, d: string) => void files.set(p, d),
  };
  await writeBook(adapter, "a.inkbook", store.data);
  const back = await readBook(adapter, "a.inkbook", "a");
  pass(back.pages.length === store.data.pages.length, "存储读出页数一致");
  pass(back.kind === "inkbook", "kind = inkbook");

  /* ---- 直线识别（纯函数） ---- */
  {
    // 手抖的横线：首尾 (100,100)→(400,110)，中间上下抖 1.5px
    const jitter: Pt[] = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      jitter.push([100 + 300 * t, 100 + 10 * t + (i % 2 ? 1.5 : -1.5), 0.5 + 0.02 * i]);
    }
    const flat = straightenPoints(jitter);
    pass(!!flat, "近直线被识别（抖动 ±1.5px）");
    if (flat) {
      // 所有点到首尾连线的垂距应接近 0
      const a = flat[0];
      const b = flat[flat.length - 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let maxDev = 0;
      for (const p of flat) {
        const t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (len * len);
        const px = a[0] + (b[0] - a[0]) * t;
        const py = a[1] + (b[1] - a[1]) * t;
        maxDev = Math.max(maxDev, Math.hypot(p[0] - px, p[1] - py));
      }
      pass(maxDev < 0.01, "拉直后严格共线（最大垂距 " + maxDev.toFixed(4) + "px）");
      pass(flat.length === jitter.length, "点数保留：" + flat.length + " / " + jitter.length);
      pass(
        Math.abs(flat[7][2] - jitter[7][2]) < 1e-9,
        "压感保留（第 7 点 " + jitter[7][2].toFixed(3) + "）"
      );
    }
    // 明显弧线：中点偏离 40px
    const arc: Pt[] = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      arc.push([100 + 300 * t, 100 + 400 * Math.sin(Math.PI * t), 0.5]);
    }
    pass(straightenPoints(arc) === null, "弧线不被误判为直线");
    // 太短
    pass(
      straightenPoints([
        [0, 0, 0.5],
        [5, 0, 0.5],
        [10, 1, 0.5],
      ]) === null,
      "过短的笔画不处理（长度 10px）"
    );
    // 圆圈（首尾重合）
    const loop: Pt[] = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      loop.push([200 + 60 * Math.cos(a), 200 + 60 * Math.sin(a), 0.5]);
    }
    loop.push([...loop[0]] as Pt);
    pass(straightenPoints(loop) === null, "圆圈不被误判为直线");
  }

  /* 全局搜索索引：一页一个 md，打开即跳回本子 */
  {
    const mockFile = {
      path: "笔记/数学.inkbook",
      basename: "数学",
      parent: { path: "笔记" },
    } as any;
    const bk = createBook("数学", "grid", "white");
    bk.pages[0].texts = [
      { id: "p1", source: "pdf", x: 90, y: 400, size: 12, text: "下半页的原文" },
      { id: "p2", source: "pdf", x: 90, y: 120, size: 12, text: "傅里叶变换的定义" },
      { id: "u1", source: "user", x: 120, y: 260, size: 20, color: "#D64545", text: "我的批注" },
    ];
    bk.pages.push(createPage("lined", "cream"));
    bk.pages[1].texts = [
      { id: "p3", source: "pdf", x: 90, y: 100, size: 12, text: "第二页正文" },
    ];

    const p1 = buildPageIndex(mockFile, bk, 0);
    pass(p1.includes("傅里叶变换的定义"), "第 1 页索引含 PDF 原文");
    pass(p1.includes("我的批注"), "第 1 页索引含手动添加的文字");
    pass(p1.includes("# 数学 · 第 1 页"), "索引页标题带本子名与页码");
    pass(
      p1.includes("obsidian://inkbook?file=") && p1.includes("page=1"),
      "索引页带跳页链接"
    );
    pass(
      p1.indexOf("傅里叶变换的定义") < p1.indexOf("我的批注") &&
        p1.indexOf("我的批注") < p1.indexOf("下半页的原文"),
      "同一页内按 y 从上到下排列"
    );
    pass(!p1.includes("undefined") && !p1.includes("null"), "索引页没有 undefined/null");

    const p2 = buildPageIndex(mockFile, bk, 1);
    pass(
      p2.includes("第二页正文") && !p2.includes("傅里叶"),
      "每页各写各的内容，不串页"
    );

    pass(
      indexDirFor(mockFile) === "笔记/数学.墨本索引",
      "索引目录与本子同目录、同名前缀：" + indexDirFor(mockFile)
    );
    pass(
      indexPagePath(mockFile, 12) === "笔记/数学.墨本索引/数学 · 第 12 页.md",
      "索引页文件名带本子名与页码：" + indexPagePath(mockFile, 12)
    );
    pass(
      indexFileName(mockFile, 12) === "数学 · 第 12 页.md",
      "索引页文件名（不含目录）带本子名：" + indexFileName(mockFile, 12)
    );
    pass(
      indexFileName(mockFile, 12).includes("数学"),
      "全局搜索结果显示的是文件名——文件名里必须能看到是哪本本子"
    );

    /*
     * 本子名超长时要截断：Windows 的文件名上限 255 字符，
     * 本子名占满 240 时再加「 · 第 12 页.md」就超了，文件根本建不出来。
     * 截断只影响文件名，目录名不变，反查照样对得上。
     */
    {
      const longName = "长".repeat(200);
      const longFile = {
        path: "笔记/长名字.inkbook",
        basename: longName,
        parent: { path: "笔记" },
      } as any;
      const nm = indexFileName(longFile, 12);
      pass(
        Array.from(nm).length <= 255,
        "超长本子名：索引文件名被截断到 255 字符内（实际 " + Array.from(nm).length + "）"
      );
      pass(
        indexDirFor(longFile) === "笔记/" + longName + ".墨本索引",
        "超长本子名：索引目录名不截断（反查靠它）"
      );
    }

    const parsed = parseIndexPath("笔记/数学.墨本索引/数学 · 第 12 页.md");
    pass(
      parsed?.bookPath === "笔记/数学.inkbook" && parsed?.page === 12,
      "新命名索引页路径能反查出本子与页码"
    );
    const parsedOld = parseIndexPath("笔记/数学.墨本索引/第 12 页.md");
    pass(
      parsedOld?.bookPath === "笔记/数学.inkbook" && parsedOld?.page === 12,
      "旧命名索引页仍能反查（迁移期间搜索结果里的旧链接不失效）"
    );
    const parsedDot = parseIndexPath("笔记/高数 · 下册.墨本索引/高数 · 下册 · 第 3 页.md");
    pass(
      parsedDot?.bookPath === "笔记/高数 · 下册.inkbook" && parsedDot?.page === 3,
      "本子名里本身带「·」也能正确反查"
    );
    pass(parseIndexPath("笔记/数学.md") === null, "普通 md 不会被当成索引页");
    pass(parseIndexPath("笔记/数学.墨本索引/说明.md") === null, "索引目录里的非页文件不误判");

    /* 真的写一遍：内存 adapter 替身 */
    const fsMap = new Map<string, string>();
    const dirs = new Set<string>();
    let writes = 0;
    const adapter = {
      exists: async (p: string) => fsMap.has(p) || dirs.has(p),
      read: async (p: string) => fsMap.get(p) || "",
      write: async (p: string, d: string) => {
        writes += 1;
        fsMap.set(p, d);
      },
      remove: async (p: string) => {
        fsMap.delete(p);
      },
      mkdir: async (p: string) => {
        dirs.add(p);
      },
      list: async (p: string) => ({
        files: [...fsMap.keys()].filter((k) => k.startsWith(p + "/")),
        folders: [],
      }),
    };
    const mockApp = { vault: { adapter } } as any;

    // 旧方案的一本一个大 md：迁移时要被删掉
    fsMap.set("笔记/数学.墨本文字.md", "旧索引");
    // 旧命名的一页一个 md：同一页会以新名字重建，旧的必须清掉
    fsMap.set("笔记/数学.墨本索引/第 1 页.md", "旧命名第 1 页");
    fsMap.set("笔记/数学.墨本索引/第 7 页.md", "旧命名第 7 页（这一页已经不存在）");

    await writeTextIndex(mockApp, mockFile, bk);
    const f1 = fsMap.get("笔记/数学.墨本索引/数学 · 第 1 页.md") || "";
    pass(
      dirs.has("笔记/数学.墨本索引") && f1.includes("傅里叶变换的定义"),
      "writeTextIndex 建好索引目录并写出第 1 页（文件名带本子名）"
    );
    pass(
      fsMap.has("笔记/数学.墨本索引/数学 · 第 2 页.md"),
      "有文字的第 2 页也生成了索引页"
    );
    pass(
      !fsMap.has("笔记/数学.墨本索引/数学 · 第 3 页.md"),
      "没有文字的页不生成文件"
    );
    pass(!fsMap.has("笔记/数学.墨本文字.md"), "旧版单文件索引被清理掉");
    pass(
      !fsMap.has("笔记/数学.墨本索引/第 1 页.md") &&
        !fsMap.has("笔记/数学.墨本索引/第 7 页.md"),
      "旧命名的索引页被清理掉（不会和新命名重复出现在搜索里）"
    );

    /*
     * 旧命名的识别口径必须和清理口径是同一把尺子。
     * 认得出、却删不掉 —— 或者认错了、删掉了别的东西 —— 都是 bug。
     */
    pass(isLegacyIndexPageName("第 12 页.md"), "旧命名识别：第 12 页.md 是旧索引页");
    pass(
      !isLegacyIndexPageName("数学 · 第 12 页.md"),
      "旧命名识别：新命名不算旧索引页（不能被误删）"
    );
    pass(
      !isLegacyIndexPageName("说明.md") && !isLegacyIndexPageName("数学.md"),
      "旧命名识别：普通 md 不算旧索引页"
    );

    /*
     * 本子改名/删除：旧索引目录必须跟着清掉。
     * removeTextIndex 以前写了却从没被调用，改名后旧目录留在原地，
     * 搜索结果点开报「找不到这本手写本」。
     * rename 时 vault 传进来的 f 已经是新路径，必须靠 oldPath 删旧目录。
     */
    {
      const renamed = { ...mockFile, path: "笔记/数学（新）.inkbook", basename: "数学（新）" } as any;
      await removeTextIndex(mockApp, renamed, "笔记/数学.inkbook");
      pass(
        !fsMap.has("笔记/数学.墨本索引/数学 · 第 1 页.md") &&
          !fsMap.has("笔记/数学.墨本索引/数学 · 第 2 页.md"),
        "本子改名：旧索引目录被删掉（搜索结果不再指向不存在的路径）"
      );
      // 重新按新名字写一遍，确认新目录能正常生成
      await writeTextIndex(mockApp, renamed, bk);
      pass(
        fsMap.has("笔记/数学（新）.墨本索引/数学（新） · 第 1 页.md"),
        "本子改名：按新名字重建了索引目录"
      );
      // 删除：新目录也要清掉
      await removeTextIndex(mockApp, renamed);
      pass(
        !fsMap.has("笔记/数学（新）.墨本索引/数学（新） · 第 1 页.md"),
        "本子删除：索引目录一并清掉"
      );
      // 还原本段开始时的状态，别带红后面的断言
      await writeTextIndex(mockApp, mockFile, bk);
    }

    const w1 = writes;
    await writeTextIndex(mockApp, mockFile, bk);
    pass(writes === w1, "内容没变化时不重复写（省同步与重解析）");

    bk.pages[1].texts = [];
    await writeTextIndex(mockApp, mockFile, bk);
    pass(
      !fsMap.has("笔记/数学.墨本索引/数学 · 第 2 页.md"),
      "某页文字清空后删掉对应索引页"
    );

    /*
     * 并发写索引必须串行（2026-11-07 补）：
     * writeTextIndex 有 `void` 异步启动的调用点，两轮并发时前一轮在
     * 「清理旧索引」阶段按它当时的 wanted 删文件，会删掉后一轮刚写的新页，
     * 随后 verify 报「索引失败」、全局搜索缺页。
     * 这里同时发起两轮，两轮都必须成功、且最终索引页齐全。
     */
    {
      // 恢复第 2 页有文字，确保 wanted 里有两页
      bk.pages[1].texts = [{ id: "t2", source: "user", x: 60, y: 60, text: "第二页的字", size: 18 }];
      const [r1, r2] = await Promise.all([
        writeTextIndex(mockApp, mockFile, bk),
        writeTextIndex(mockApp, mockFile, bk),
      ]);
      pass(
        r1.ok && r2.ok,
        "并发两轮写索引都成功（r1=" + r1.ok + " r2=" + r2.ok + "，pages " + r1.pages + "/" + r2.pages + "）"
      );
      pass(
        fsMap.has("笔记/数学.墨本索引/数学 · 第 1 页.md") &&
          fsMap.has("笔记/数学.墨本索引/数学 · 第 2 页.md"),
        "并发两轮之后两页索引都在（没被对方清理阶段删掉）"
      );
    }

    /*
     * 导入 PDF 的端到端索引：
     *   真实 sample.pdf（第 1 页）→ importPdf 抽文字 → 组装成书 → writeTextIndex
     * 断言抽出来的每一条 PDF 原文都进入了索引 md，且文件名带本子名。
     */
    {
      const pdfFile = { path: "/test/sample.pdf", name: "sample.pdf", basename: "sample" } as any;
      const imported = await importPdf(mockApp, pdfFile, mockFile.path, { from: 1, to: 1 });
      pass(imported.pages.length === 1, "导入 PDF：只取第 1 页（range 1..1）");
      const pdfTexts = (imported.pages[0].texts || []).filter(
        (t) => t.source === "pdf" && (t.text || "").trim()
      );
      pass(
        pdfTexts.length > 0,
        "导入 PDF：第 1 页抽出 " + pdfTexts.length + " 条 PDF 文字"
      );

      /*
       * 页码范围导入（2026-11-07 加 INK-163）：
       * sample.pdf 有 20 页，导 2..4 应当正好 3 页，且底图页码是真实的
       * PDF 页码（2/3/4），不是从 1 重新编号 —— 否则翻到那页会显示错内容。
       */
      {
        const mid = await importPdf(mockApp, pdfFile, mockFile.path, { from: 2, to: 4 });
        pass(
          mid.pages.length === 3,
          "范围导入 2..4：正好 3 页（实际 " + mid.pages.length + "）"
        );
        const pgNos = mid.pages.map((p) => p.background?.pdf?.page ?? -1);
        pass(
          pgNos.join(",") === "2,3,4",
          "范围导入保留真实 PDF 页码（" + pgNos.join(",") + "，期望 2,3,4）"
        );
        // 越界范围要被夹住而不是抛错
        let clamped = 0;
        try {
          const over = await importPdf(mockApp, pdfFile, mockFile.path, {
            from: 19,
            to: 999,
          });
          clamped = over.pages.length;
        } catch (_) {
          clamped = -1;
        }
        pass(clamped === 2, "范围导入越界被夹到末页（19..999 → 2 页，实际 " + clamped + "）");
        /*
         * 起止颠倒 → 明确报错，**不静默导整本**（2026-11-07 改）：
         * 用户只想要 3 页却因为写反了拿到 300 页，比报个错难收拾。
         */
        let revThrew = "";
        try {
          await importPdf(mockApp, pdfFile, mockFile.path, { from: 5, to: 2 });
        } catch (e: any) {
          revThrew = String(e?.message || e);
        }
        pass(
          revThrew.includes("页码范围不合法"),
          "范围导入起止颠倒 → 明确报错而不是静默导整本（" + revThrew + "）"
        );
      }

      const importedBook = createBook("数学", "grid", "white");
      importedBook.pages = imported.pages;
      importedBook.source = imported.source;
      await writeTextIndex(mockApp, mockFile, importedBook);
      const idxPath = "笔记/数学.墨本索引/数学 · 第 1 页.md";
      const idx = fsMap.get(idxPath) || "";
      const hit = pdfTexts.filter((t) => idx.includes(t.text)).length;
      pass(
        hit === pdfTexts.length,
        "导入 PDF 后，索引内容含全部 " + hit + "/" + pdfTexts.length + " 条 PDF 原文"
      );
      pass(idx.includes("# 数学 · 第 1 页"), "导入后索引标题仍是「本子名 · 第 N 页」");
      pass(
        idxPath.split("/").pop() === "数学 · 第 1 页.md",
        "导入后索引文件名带本子名（全局搜索直接显示「数学 · 第 1 页」）"
      );
      const back = parseIndexPath(idxPath);
      pass(
        back?.bookPath === "笔记/数学.inkbook" && back?.page === 1,
        "导入后的索引页路径能反查回本子第 1 页"
      );
      pass(
        pdfTexts.every((t) => (t.text || "").trim().length > 0),
        "导入 PDF：抽出的 " + pdfTexts.length + " 条文字都不是空串（空串进不了索引）"
      );
    }

    /*
     * 导入 PDF → 索引 → **进 vault 文件表** 的端到端。
     *
     * 前面的用例只验了「内容写对了」，没验「Obsidian 认得这个文件」。
     * 而「全局搜索搜不到」的真因正是：文件在磁盘上，却不在 Obsidian 的
     * 文件表里。这里把导入结果真的写进一个带文件表的 vault，
     * 断言索引页进了文件表、且文件里的内容含全部 PDF 原文。
     */
    {
      const disk = new Map<string, string>();
      const folders = new Set<string>();
      const registry = new Map<string, { path: string }>();
      const vault = {
        adapter: {
          exists: async (p: string) => disk.has(p) || folders.has(p),
          read: async (p: string) => disk.get(p) || "",
          write: async (p: string, d: string) => disk.set(p, d),
          remove: async (p: string) => {
            disk.delete(p);
            registry.delete(p);
          },
          mkdir: async (p: string) => folders.add(p),
          list: async (p: string) => ({
            files: [...disk.keys()].filter((k) => k.startsWith(p + "/")),
            folders: [],
          }),
        },
        getAbstractFileByPath: (p: string) => registry.get(p) ?? null,
        createFolder: async (p: string) => {
          folders.add(p);
          registry.set(p, { path: p });
        },
        create: async (p: string, d: string) => {
          const parent = p.split("/").slice(0, -1).join("/");
          if (parent && !registry.has(parent)) throw new Error("Parent folder does not exist.");
          disk.set(p, d);
          registry.set(p, { path: p });
        },
        modify: async (f: { path: string }, d: string) => disk.set(f.path, d),
        delete: async (f: { path: string }) => {
          disk.delete(f.path);
          registry.delete(f.path);
        },
      };
      const e2eApp = { vault } as any;

      const pdfFile = { path: "/test/sample.pdf", name: "sample.pdf", basename: "sample" } as any;
      const imported = await importPdf(e2eApp, pdfFile, mockFile.path, { from: 1, to: 1 });
      const pdfTexts = (imported.pages[0].texts || []).filter(
        (t) => t.source === "pdf" && (t.text || "").trim()
      );
      const e2eBook = createBook("数学", "grid", "white");
      e2eBook.pages = imported.pages;
      await writeTextIndex(e2eApp, mockFile, e2eBook);

      const e2ePath = "笔记/数学.墨本索引/数学 · 第 1 页.md";
      pass(
        registry.has(e2ePath),
        "✓ 导入 PDF 后索引页进了 vault 文件表（全局搜索才搜得到）"
      );
      const e2eContent = disk.get(e2ePath) || "";
      const e2eHit = pdfTexts.filter((t) => e2eContent.includes(t.text)).length;
      pass(
        e2eHit === pdfTexts.length && pdfTexts.length > 0,
        "✓ 导入 PDF 后索引文件里有全部 " + e2eHit + "/" + pdfTexts.length + " 条 PDF 原文"
      );
      pass(
        registry.has(e2ePath) &&
          parseIndexPath(e2ePath)?.bookPath === "笔记/数学.inkbook",
        "✓ 导入后的索引页既在文件表里、又能反查回本子"
      );
    }

    /*
     * 文件表路径：有 vault 一等 API 时必须走 create / modify。
     *
     * 真机故障复现：索引 md 明明写在磁盘上，Obsidian 的全局搜索却一个字
     * 都搜不到——因为它压根不在 vault 的文件表里。
     * 只有 vault.create / vault.modify 会登记；adapter.write 是裸写。
     */
    {
      const disk = new Map<string, string>();
      const folders = new Set<string>();
      const registry = new Map<string, { path: string }>();
      const calls: string[] = [];

      const a2 = {
        exists: async (p: string) => disk.has(p) || folders.has(p),
        read: async (p: string) => disk.get(p) || "",
        write: async (p: string, d: string) => {
          calls.push("adapter.write");
          disk.set(p, d);
        },
        remove: async (p: string) => {
          calls.push("adapter.remove");
          disk.delete(p);
          registry.delete(p);
        },
        mkdir: async (p: string) => {
          folders.add(p);
        },
        list: async (p: string) => ({
          files: [...disk.keys()].filter((k) => k.startsWith(p + "/")),
          folders: [],
        }),
      };
      const vault = {
        adapter: a2,
        getAbstractFileByPath: (p: string) => registry.get(p) ?? null,
        createFolder: async (p: string) => {
          calls.push("createFolder");
          if (folders.has(p)) throw new Error("Folder already exists.");
          folders.add(p);
          registry.set(p, { path: p });
        },
        create: async (p: string, d: string) => {
          calls.push("create");
          // 真机上"磁盘上有、文件表没有"的遗留文件也会让 create 抛已存在
          if (registry.has(p) || disk.has(p)) throw new Error("File already exists.");
          const parent = p.split("/").slice(0, -1).join("/");
          // 模拟 Obsidian：父目录不在文件表里就建不了文件
          if (parent && !registry.has(parent)) throw new Error("Parent folder does not exist.");
          disk.set(p, d);
          registry.set(p, { path: p });
        },
        modify: async (f: { path: string }, d: string) => {
          calls.push("modify");
          disk.set(f.path, d);
        },
        delete: async (f: { path: string }) => {
          calls.push("delete");
          disk.delete(f.path);
          registry.delete(f.path);
        },
      };
      const vApp = { vault } as any;

      const bk2 = createBook("数学", "grid", "white");
      bk2.pages[0].texts = [
        { id: "v1", source: "pdf", x: 90, y: 100, size: 12, text: "要能被搜到的原文" },
      ];
      await writeTextIndex(vApp, mockFile, bk2);

      pass(calls.includes("createFolder"), "✓ 索引目录走 vault.createFolder（Obsidian 才认得这个目录）");
      pass(
        calls.includes("create") && !calls.includes("adapter.write"),
        "✓ 索引页走 vault.create，不是裸写 adapter（否则文件表里没有、全局搜索搜不到）"
      );
      pass(
        registry.has("笔记/数学.墨本索引") &&
          registry.has("笔记/数学.墨本索引/数学 · 第 1 页.md"),
        "✓ 目录与索引页都进了 vault 文件表"
      );

      calls.length = 0;
      bk2.pages[0].texts![0].text = "改过的原文";
      await writeTextIndex(vApp, mockFile, bk2);
      pass(
        calls.includes("modify") && !calls.includes("adapter.write"),
        "✓ 内容变化走 vault.modify（检索能立刻看到新文字）"
      );

      /*
       * 旧版遗留：文件在磁盘上、文件表里没有。
       * create 会因"已存在"失败 —— 必须先删再建，否则这个文件永远进不了检索。
       */
      calls.length = 0;
      const ghost = "笔记/数学.墨本索引/数学 · 第 2 页.md";
      disk.set(ghost, "旧内容");
      bk2.pages.push(createPage("lined", "white"));
      bk2.pages[1].texts = [
        { id: "v2", source: "user", x: 10, y: 10, size: 14, text: "第二页新文字" },
      ];
      await writeTextIndex(vApp, mockFile, bk2);
      pass(
        registry.has(ghost) && disk.get(ghost)?.includes("第二页新文字"),
        "✓ 磁盘上已有但未登记的索引页会被重建成登记态（旧版遗留能救回来）"
      );

      /*
       * 删除也必须走文件表。
       *
       * `adapter.remove` 是绕过 Obsidian 的裸删：文件在磁盘上没了，
       * 但 Obsidian 的文件表里还留着那条记录 —— 全局搜索里依然能搜到
       * 这份「已经不存在」的索引内容，点进去就是「文件不存在」。
       * 旧命名的索引页清理时最容易踩到：同一页出现两条搜索结果，
       * 其中一条点不开。
       */
      calls.length = 0;
      bk2.pages[1].texts = [];
      await writeTextIndex(vApp, mockFile, bk2);
      pass(
        calls.includes("delete") && !calls.includes("adapter.remove"),
        "✓ 删索引页走 vault.delete，不是裸删 adapter（否则搜索里还留着已删内容）"
      );
      pass(
        !registry.has("笔记/数学.墨本索引/数学 · 第 2 页.md"),
        "✓ 删掉的索引页也从 vault 文件表里消失了"
      );

      /*
       * 索引写失败**不能**把保存报成失败。
       *
       * 索引是派生物：它坏了，最多让用户搜不到，
       * 绝不能反过来把「本子已保存」变成「保存失败」。
       */
      {
        const brokenVault = {
          adapter: {
            exists: async () => true,
            read: async () => {
              throw new Error("磁盘读不出来");
            },
            write: async () => {
              throw new Error("磁盘写不进去");
            },
            remove: async () => {},
            mkdir: async () => {},
            list: async () => {
              throw new Error("列目录失败");
            },
          },
          getAbstractFileByPath: () => null,
          create: async () => {
            throw new Error("创建失败");
          },
        };
        const brokenApp = { vault: brokenVault } as any;
        let threw = false;
        let brokenResult: Awaited<ReturnType<typeof writeTextIndex>> | null = null;
        try {
          brokenResult = await writeTextIndex(brokenApp, mockFile, bk2);
        } catch (_) {
          threw = true;
        }
        pass(!threw, "✓ 索引写失败被兜底住，不会把保存/导入报成失败");
        pass(
          brokenResult?.ok === false && !!brokenResult?.error,
          "✓ 索引失败时返回可展示的原因，不再静默成功：" + (brokenResult?.error || "")
        );
      }
    }

    /*
     * 真机故障回归（2026-11-06）：索引目录**已经在磁盘上、但不在
     * Obsidian 的文件表里**（旧版裸建 / 同步工具外部建目录 / watcher 漏事件）。
     *
     * 旧实现：
     *   createFolder 因「Folder already exists.」抛错 → catch 吞掉；
     *   adapter.exists(dir) 为真 → 跳过 adapter.mkdir；
     *   目录永远不登记 → vault.create 写出的 md 挂不进 vault 文件表那棵树
     *   → 全局搜索 0 结果，而且 writeTextIndex 一声不吭。
     *
     * 这里用「磁盘层」和「文件表层」分开的桩复现：磁盘上预置目录 + 旧命名
     * 文件，文件表里什么都没有。断言它会 rmdir 旧目录、重建登记目录，
     * 并真的生成可反查的新索引页。
     */
    {
      const disk = new Map<string, string>();
      const diskFolders = new Set<string>();
      const table = new Map<string, { path: string; kind: "file" | "folder" }>();
      const calls3: string[] = [];
      const adapter3 = {
        exists: async (p: string) => disk.has(p) || diskFolders.has(p),
        read: async (p: string) => disk.get(p) || "",
        write: async (p: string, d: string) => {
          calls3.push("adapter.write");
          disk.set(p, d);
        },
        remove: async (p: string) => {
          calls3.push("adapter.remove");
          disk.delete(p);
        },
        mkdir: async (p: string) => {
          calls3.push("adapter.mkdir");
          diskFolders.add(p);
        },
        rmdir: async (p: string, recursive?: boolean) => {
          calls3.push("adapter.rmdir");
          diskFolders.delete(p);
          if (recursive) {
            for (const k of [...disk.keys()]) if (k.startsWith(p + "/")) disk.delete(k);
          }
          table.delete(p);
          for (const k of [...table.keys()]) if (k.startsWith(p + "/")) table.delete(k);
        },
        list: async (p: string) => ({
          files: [...disk.keys()].filter((k) => k.startsWith(p + "/")),
          folders: [],
        }),
      };
      const vault3 = {
        adapter: adapter3,
        getAbstractFileByPath: (p: string) => table.get(p) ?? null,
        createFolder: async (p: string) => {
          calls3.push("createFolder");
          // 真机：磁盘上已有目录 → 直接抛，而且**不会**补登记
          if (diskFolders.has(p)) throw new Error("Folder already exists.");
          diskFolders.add(p);
          table.set(p, { path: p, kind: "folder" });
        },
        create: async (p: string, d: string) => {
          calls3.push("create");
          if (table.has(p)) throw new Error("File already exists.");
          const parent = p.split("/").slice(0, -1).join("/");
          // 真机：父目录不在文件表里 → 创建失败（不能靠它自愈）
          if (parent && !table.has(parent)) throw new Error("Parent folder does not exist.");
          disk.set(p, d);
          table.set(p, { path: p, kind: "file" });
        },
        modify: async (f: { path: string }, d: string) => disk.set(f.path, d),
        delete: async (f: { path: string }) => {
          disk.delete(f.path);
          table.delete(f.path);
        },
      };

      // 故障态：目录在磁盘上 + 旧命名文件还在；文件表里连目录都没有
      diskFolders.add("笔记/数学.墨本索引");
      disk.set("笔记/数学.墨本索引/第 1 页.md", "旧命名索引");
      const bk3 = createBook("数学", "grid", "white");
      bk3.pages[0].texts = [
        { id: "r1", source: "pdf", x: 10, y: 10, size: 12, text: "自愈后要能搜到的原文" },
      ];
      const r3 = await writeTextIndex({ vault: vault3 } as any, mockFile, bk3);
      const idx3 = "笔记/数学.墨本索引/数学 · 第 1 页.md";

      pass(r3.ok === true, "✓ 已存在但未登记的索引目录能自愈（不再静默失败）");
      pass(
        calls3.includes("adapter.rmdir") && calls3.includes("createFolder"),
        "✓ 自愈方式：删掉未登记旧目录，再用 vault.createFolder 重建登记"
      );
      pass(
        !!vault3.getAbstractFileByPath("笔记/数学.墨本索引") &&
          !!vault3.getAbstractFileByPath(idx3),
        "✓ 自愈后目录与索引页都在 vault 文件表里（全局搜索才看得到）"
      );
      pass(
        (disk.get(idx3) || "").includes("自愈后要能搜到的原文"),
        "✓ 自愈后索引 md 内容正确：" + (disk.get(idx3) || "").slice(0, 28)
      );
      pass(
        !disk.has("笔记/数学.墨本索引/第 1 页.md"),
        "✓ 自愈时旧命名文件一并清掉（搜索里不会出现两份）"
      );
      pass(
        parseIndexPath(idx3)?.bookPath === "笔记/数学.inkbook" &&
          parseIndexPath(idx3)?.page === 1,
        "✓ 端到端：本子数据 → 索引 md 真的生成，且能反查回第 1 页"
      );
    }

    /*
     * 如果宿主就是不让文件进文件表（权限 / 目录被占用 / 私有实现变化），
     * 必须返回 ok=false 并带上可展示的原因，供上层弹 Notice。
     */
    {
      const disk4 = new Map<string, string>();
      const orphanVault = {
        adapter: {
          exists: async (p: string) => disk4.has(p),
          read: async (p: string) => disk4.get(p) || "",
          write: async (p: string, d: string) => void disk4.set(p, d),
          remove: async (p: string) => void disk4.delete(p),
          mkdir: async () => {},
          list: async (p: string) => ({
            files: [...disk4.keys()].filter((k) => k.startsWith(p + "/")),
            folders: [],
          }),
        },
        getAbstractFileByPath: () => null, // 永远不登记
        createFolder: async () => {},
        create: async (p: string, d: string) => void disk4.set(p, d), // 落盘但不入表
        modify: async () => {},
        delete: async () => {},
      };
      const bk4 = createBook("数学", "grid", "white");
      bk4.pages[0].texts = [
        { id: "x1", source: "pdf", x: 1, y: 1, size: 12, text: "落盘但进不了表" },
      ];
      const r4 = await writeTextIndex({ vault: orphanVault } as any, mockFile, bk4);
      pass(
        r4.ok === false && /文件表/.test(r4.error || ""),
        "✓ 索引进不了文件表时返回失败原因（交给可见 Notice）：" + (r4.error || "")
      );
      pass(
        (disk4.get("笔记/数学.墨本索引/数学 · 第 1 页.md") || "").includes("落盘但进不了表"),
        "✓ 即使文件已落盘，也要如实报告「搜索不可用」，而不是假装成功"
      );
    }
  }

  /*
   * 批注折行（wrapText）。
   *
   * 用「每个字符固定 20 宽」的假 measure 测，折行逻辑跟真实字体解耦——
   * 真字体的宽度会随系统装了什么字而变，拿它做断言就会在别人机器上红。
   * 真正的「导出不丢字」由 export 套件用真实字体端到端验。
   */
  {
    const m = (s: string) => Array.from(s).length * 20;

    const short = wrapText("短句", 400, m);
    pass(short.length === 1 && short[0] === "短句", "折行：短文本不折（" + short.length + " 行）");

    const long = "墨本把批注按纸宽自动折行以后，长句子不会再画到纸外面被裁掉了";
    const lines = wrapText(long, 200, m);
    pass(lines.length > 1, "折行：长中文按宽度折行（" + lines.length + " 行）");
    pass(lines.join("") === long, "折行：一个字都不丢（拼回去等于原文）");
    pass(
      lines.every((l) => m(l) <= 200),
      "折行：每行都不超宽（最宽 " + Math.max(...lines.map(m)) + " ≤ 200）"
    );

    const hard = wrapText("第一行\n第二行", 400, m);
    pass(
      hard.length === 2 && hard[0] === "第一行" && hard[1] === "第二行",
      "折行：用户敲的回车保留（" + JSON.stringify(hard) + "）"
    );

    const blank = wrapText("A\n\nB", 400, m);
    pass(
      blank.length === 3 && blank[1] === "" && blank[0] === "A" && blank[2] === "B",
      "折行：空行保留（" + JSON.stringify(blank) + "）"
    );

    // 英文优先在空格处断：宽 100 = 10 个字符，正好断在 "the quick " 后面
    const en = wrapText("the quick brown fox jumps", 100, (s) => s.length * 10);
    pass(
      en.length > 1 && en[0].replace(/\s+$/, "") === "the quick",
      "折行：英文在空格处断（" + JSON.stringify(en) + "）"
    );
    pass(en.join("") === "the quick brown fox jumps", "折行：英文断行不吞空格（断点处的空格留在行尾）");

    /*
     * 为了凑空格会把行断得太短时，宁可硬断：
     * 宽 100 时 "ab cdefghi" 正好塞满，接着要放 'j' 就得回退到空格处，
     * 那只有 30 宽（< 100×0.6），所以应该直接硬断成 10 个字。
     */
    const hardBreak = wrapText("ab cdefghijklmn", 100, (s) => s.length * 10);
    pass(
      hardBreak[0] === "ab cdefghi",
      "折行：空格断行会让这行太短时改硬断（" + JSON.stringify(hardBreak) + "）"
    );
    pass(hardBreak.join("") === "ab cdefghijklmn", "折行：硬断同样不丢字");

    // maxWidth 极小（比一个字还窄）：每个字单独一行，绝不能死循环
    const tiny = wrapText("极小宽度也不能卡住", 1, m);
    pass(
      tiny.length === 9 && tiny.join("") === "极小宽度也不能卡住",
      "折行：maxWidth 极小时逐字成行且不死循环（" + tiny.length + " 行）"
    );

    const zero = wrapText("abc", 0, m);
    pass(zero.length === 1 && zero[0] === "abc", "折行：maxWidth=0 当作不折行");
  }

  /*
   * 越界夹取（availableTextWidth / layoutUserText）。
   *
   * 这两条是上一版漏掉的：折行只夹了"每行多宽"，没夹"起点多靠右"和
   * "整段多靠下"，于是 x=700 时每行右端被推到 820 出纸、y=1100 时折出的
   * 下面几行整行落到页外——症状还是"字不完整"，只是从横向换成了纵向。
   * 用"每个字 = 字号宽"的假度量，规则跟真实字体解耦。
   */
  {
    const W = 794;
    const H = 1123;
    const bySize = (size: number) => (s: string) => Array.from(s).length * size;

    const w700 = availableTextWidth(W, 700);
    pass(
      700 + w700 <= W - 8 + 0.01,
      "右缘夹取：x=700 时每行右缘 " + (700 + w700).toFixed(0) + " ≤ 786（可用宽度 " + w700.toFixed(0) + "）"
    );
    const w760 = availableTextWidth(W, 760);
    pass(
      w760 >= 1 && 760 + w760 <= W - 8 + 0.01,
      "右缘夹取：x=760 时既不出纸也不会退成 0 宽（可用 " + w760.toFixed(0) + "）"
    );
    pass(
      availableTextWidth(W, 634) === 120,
      "右缘夹取：纸还够宽时仍保底 120（x=634 → " + availableTextWidth(W, 634).toFixed(0) + "）"
    );

    /*
     * 非有限值兜底（INK-193）：这几条以前全是 NaN。
     * NaN 宽度喂给 wrapText 等价于"不折行"，长句直接画出纸外，
     * 症状和越界一样是「我自己打的字不完整」，但更难查（数值一路是 NaN）。
     */
    for (const bad of [NaN, Infinity, -Infinity]) {
      const w = availableTextWidth(W, bad);
      pass(
        Number.isFinite(w) && w > 0,
        "NaN 兜底：x=" + String(bad) + " 时可用宽度仍是有限正数（" + w.toFixed(0) + "）"
      );
    }
    pass(
      availableTextWidth(W, NaN) === availableTextWidth(W, 0),
      "NaN 兜底：x=NaN 按页左缘 0 处理（宽度取满）"
    );
    for (const bad of [NaN, Infinity, -Infinity]) {
      const w = availableTextWidth(bad, 100);
      pass(
        Number.isFinite(w) && w >= 1,
        "NaN 兜底：pageWidth=" + String(bad) + " 时可用宽度有限且 ≥ 1（" + w.toFixed(0) + "）"
      );
    }

    const longH = "横向越界扫描用的长句不能让纸边裁掉".repeat(3);
    for (const x of [634, 674, 700, 760]) {
      const l = layoutUserText({ x, y: 300, size: 16, text: longH }, W, H, bySize(16));
      const widest = Math.max(...l.lines.map(bySize(16)));
      pass(l.lines.join("") === longH, "右缘夹取：x=" + x + " 一个字都不丢（起点收到 " + l.x.toFixed(0) + "）");
      pass(
        l.x + widest <= W - 8 + 0.01,
        "右缘夹取：x=" + x + " 排版后最宽行右缘 " + (l.x + widest).toFixed(0) + " ≤ 786"
      );
    }

    const longV = "纵向越界扫描用的长句不能落到纸张外面".repeat(4);
    for (const y of [1050, 1100, 1120]) {
      const l = layoutUserText({ x: 60, y, size: 20, text: longV }, W, H, bySize(20));
      const lastBaseline = l.y + (l.lines.length - 1) * l.lineHeight;
      pass(
        lastBaseline <= H - 8 + 0.01,
        "纵向夹取：y=" + y + " 最后一行基线 " + lastBaseline.toFixed(0) + " ≤ 1115（首行压到 " + l.y.toFixed(0) + "）"
      );
      pass(l.lines.join("") === longV, "纵向夹取：y=" + y + " 一个字都不丢");
      pass(l.y >= 20 * 1.2 - 0.01, "纵向夹取：y=" + y + " 不会为了塞下而顶出页顶");
    }

    /*
     * 负 y（往上拖过头的老数据）也必须被兜住。
     * 这是上一版漏得最狠的一处：y 是负数时 `Math.min(t.y, …)` 原样放行，
     * 整段跑到纸顶之上，屏幕上被 .mb-page 裁掉、导出后基线在 /MediaBox 之外，
     * 54 字变 0 字。
     */
    for (const y of [-100, -198, -1000]) {
      const l = layoutUserText({ x: 60, y, size: 20, text: longV }, W, H, bySize(20));
      pass(
        l.y >= 20 * 1.2 - 0.01,
        "负 y 夹取：y=" + y + " 首行基线被抬到 " + l.y.toFixed(0) + " ≥ 24（否则整段在纸外）"
      );
      pass(l.lines.join("") === longV, "负 y 夹取：y=" + y + " 一个字都不丢");
      const lastBaseline = l.y + (l.lines.length - 1) * l.lineHeight;
      pass(lastBaseline <= H - 8 + 0.01, "负 y 夹取：y=" + y + " 最后一行仍在纸内（" + lastBaseline.toFixed(0) + " ≤ 1115）");
    }

    /*
     * 内容比纸还高（超大字号 + 超长文本，INK-192）：物理上装不下时按可用高度
     * **裁行**，不能再「从页顶开始画、底部溢出接受」——溢出的行会被
     * .mb-page / /MediaBox 整行裁掉，用户看到的就是「我打的字不见了」。
     * 裁的是渲染结果：PageText.text / wrapText 里原文一个字都不动，
     * 调小字号或拖宽文字框后被裁的字会重新出现。
     *
     * 断言条数保持 2 条，别动 run-all.mjs 里 test.html 的期望数。
     */
    {
      const huge = "超高内容".repeat(50); // 200 字
      const l = layoutUserText({ x: 40, y: 500, size: 96, text: huge }, W, H, bySize(96));
      const full = wrapText(huge, availableTextWidth(W, 40), bySize(96));
      const wantMax = Math.max(1, Math.floor((H - 8 - 96 * 1.2) / (96 * 1.32)) + 1);
      const lastBaseline = l.y + (l.lines.length - 1) * l.lineHeight;
      pass(
        full.join("") === huge &&
          l.lines.length <= wantMax &&
          (l.hidden ?? 0) === full.length - l.lines.length &&
          l.lines.join("") === full.slice(0, l.lines.length).join(""),
        "超高内容：按纸高裁行（" + l.lines.length + "/" + full.length + " 行，hidden " +
          (l.hidden ?? 0) + "），wrapText 拼回去仍是完整原文（数据不丢）"
      );
      pass(
        l.y >= 96 * 1.2 - 0.01 && lastBaseline <= H - 8 + 0.01,
        "超高内容：裁行后首行不低于页顶、末行基线 " + lastBaseline.toFixed(0) +
          " ≤ 1115（不再整行掉出页底）"
      );
    }
  }

  /*
   * 手动框宽（PageText.width，INK-121）。
   *
   * 核心性质：显式宽度只改「一行放多少字」，不改 x/y 夹取、不丢字、
   * 更不能把字推出纸右缘。老数据没有 width 时行为必须和改造前逐字一致
   * ——这是防「改了默认行为」的回归闸门。
   */
  {
    const W = 794;
    const H = 1123;
    const bySize = (size: number) => (s: string) => Array.from(s).length * size;
    const text = "手动拖窄以后一行放不下的字就会自动换到下一行继续写完".repeat(2);

    const wide = layoutUserText({ x: 60, y: 300, size: 16, text, width: 600 }, W, H, bySize(16));
    const narrow = layoutUserText({ x: 60, y: 300, size: 16, text, width: 160 }, W, H, bySize(16));
    pass(wide.width === Math.min(600, availableTextWidth(W, wide.x)), "框宽：显式宽度进 l.width（" + wide.width.toFixed(0) + "）");
    pass(narrow.width === 160, "框宽：窄框 l.width = 160");
    pass(narrow.lines.length > wide.lines.length, "框宽：窄框行数更多（" + wide.lines.length + " → " + narrow.lines.length + "）");
    pass(narrow.lines.join("") === text && wide.lines.join("") === text, "框宽：宽窄两种都不丢字");
    pass(
      narrow.lines.every((ln) => bySize(16)(ln) <= narrow.width + 0.01),
      "框宽：窄框每行都不超折行宽度"
    );
    pass(wide.x === narrow.x && wide.y === narrow.y, "框宽：改宽度不动 x/y 夹取结果");

    // 老数据无 width → 完全回落自动算法
    const auto = layoutUserText({ x: 60, y: 300, size: 16, text }, W, H, bySize(16));
    pass(auto.width === availableTextWidth(W, auto.x), "框宽：无 width 时 l.width = availableTextWidth(x)");
    pass(auto.lines.join("") === text, "框宽：无 width 时折行结果与改造前一致（不丢字）");
    const autoAt634 = layoutUserText({ x: 634, y: 300, size: 16, text }, W, H, bySize(16));
    pass(autoAt634.width === 120, "框宽：贴右缘无 width 仍保底 120");

    // 显式宽度超过 x 到纸右缘的物理余量时必须被夹住（INK-116 回归）
    for (const x of [634, 660, 674, 700, 760]) {
      const l = layoutUserText({ x, y: 300, size: 16, text, width: 600 }, W, H, bySize(16));
      const avail = availableTextWidth(W, l.x);
      pass(l.width <= avail + 0.01, "框宽：x=" + x + " 显式 600 被夹到 " + l.width.toFixed(0) + " ≤ " + avail.toFixed(0));
      const widest = Math.max(...l.lines.map(bySize(16)));
      pass(l.x + widest <= W - 8 + 0.01, "框宽：x=" + x + " 最宽行右缘 " + (l.x + widest).toFixed(0) + " ≤ 786（不出纸）");
      pass(l.lines.join("") === text, "框宽：x=" + x + " 一个字都不丢");
    }

    // 极端值：非法值回落、合法值夹到 [MIN_BOX_WIDTH, avail]，绝不喂 0 给 wrapText
    for (const bad of [0, -50, NaN, Infinity, -Infinity]) {
      const l = layoutUserText({ x: 60, y: 300, size: 16, text, width: bad }, W, H, bySize(16));
      pass(l.width === availableTextWidth(W, l.x), "框宽：width=" + String(bad) + " 回落自动算法且不抛错");
      pass(l.lines.join("") === text, "框宽：width=" + String(bad) + " 不死循环、不丢字");
    }
    const tinyBox = layoutUserText({ x: 60, y: 300, size: 16, text, width: 1 }, W, H, bySize(16));
    pass(tinyBox.width >= 24, "框宽：width=1 被夹到下限 24（不会退化成一行一个字）");
    pass(tinyBox.lines.join("") === text, "框宽：极窄框仍一个字都不丢");
  }

  /*
   * 撤销栈按**字节**封顶（INK-197）。
   *
   * 只按条数（60）封顶不够：`addPage` / `deletePage` / `insertPages` /
   * `duplicatePage` / `setAllTemplates` 存的是**整本 JSON 快照**。
   * 实测真实本子：4MB 的本子 × 60 层 = **241MB**，加上位图缓存
   * （160+32+8+64 = 264MB）平板直接 OOM。而且这些快照内容大部分重复
   * （加一页只改页数，却把整本存一遍）。
   */
  {
    const big = createBook("撤销字节上限", "grid", "white");
    // 造一个「单层快照就很大」的本子：每页塞满笔迹
    for (let i = 0; i < 40; i++) {
      const p = createPage("grid", "white");
      for (let j = 0; j < 120; j++) {
        p.layers[0].strokes.push({
          id: `s${i}_${j}`,
          tool: "pen",
          color: "#1A1A1A",
          size: 2.8,
          opacity: 1,
          points: Array.from({ length: 12 }, (_, k) => [100 + k * 4, 200 + k * 3, 0.5]),
        } as any);
      }
      big.pages.push(p);
    }
    const st = new BookStore(big);
    const oneSnap = JSON.stringify({ pages: big.pages, activePage: 0 }).length * 2;
    log("  单层整本快照约 " + (oneSnap / 1048576).toFixed(1) + "MB");

    // 连加 30 页：每次都是整本快照
    for (let i = 0; i < 30; i++) st.addPage(0);
    const used = st.historyUsedBytes;
    pass(
      used <= 32 * 1024 * 1024 + oneSnap,
      "INK-197 连加 30 页后撤销栈被字节封顶（实测 " + (used / 1048576).toFixed(1) +
        "MB ≤ 32MB + 一层余量；不加封顶会是 " + ((oneSnap * 30) / 1048576).toFixed(0) + "MB）"
    );
    pass(
      (st as any).undoStack.length < 30,
      "INK-197 确实丢了最旧的记录（剩 " + (st as any).undoStack.length + " 条 < 30）"
    );
    pass(st.canUndo(), "INK-197 至少保留 1 条可撤销（不能一封顶就撤销全废）");
    // 撤销仍然工作
    const pagesBefore = big.pages.length;
    st.undo();
    pass(big.pages.length === pagesBefore - 1, "INK-197 封顶后撤销仍生效（页数 " + pagesBefore + " → " + big.pages.length + "）");
    // redo 后字节计数不能漂
    const usedAfterUndo = st.historyUsedBytes;
    st.redo();
    pass(
      st.historyUsedBytes > usedAfterUndo,
      "INK-197 redo 后字节计数加回来（" + (usedAfterUndo / 1048576).toFixed(1) + " → " +
        (st.historyUsedBytes / 1048576).toFixed(1) + "MB）"
    );
  }

  /*
   * 字体回退链（INK-193）。
   *
   * 导出 PDF 只有一款 Noto Sans SC，屏幕却可能回退到 SimSun / Consolas：
   * 拉丁字宽差 18.5%，屏幕 3 行的字导出来变 4 行。回退链必须以导出同款
   * （Noto Sans SC → 系统无衬线）收尾；首选字体仍排最前，选楷体要看到楷体。
   */
  {
    for (const f of TEXT_FONTS) {
      pass(/"Noto Sans SC"/.test(f.stack), "字体 " + f.id + "：回退链包含导出同款 Noto Sans SC");
      pass(/sans-serif\s*$/.test(f.stack), "字体 " + f.id + "：末尾是系统无衬线（不再落到 serif/monospace 通用族）");
    }
    pass(textFontStack("kai") === TEXT_FONTS.find((f) => f.id === "kai")!.stack, "字体：按 id 取回对应栈（首选字体不被回退覆盖）");
    pass(textFontStack("不存在的id") === TEXT_FONTS[0].stack && textFontStack(undefined) === TEXT_FONTS[0].stack, "字体：未知/id 缺省落回黑体栈");
  }

  /*
   * 屏幕侧：越界的老批注渲染时被夹回纸内。
   *
   * 这条查的是 DOM span 的真实几何（不是再算一遍 layoutUserText）——
   * 屏幕、画布、导出必须落在同一个框里，否则"屏幕上看没事、导出缺一段"
   * 这种割裂会一直在。
   */
  {
    const page = store.data.pages[0];
    page.texts = [
      {
        id: "t_clip",
        source: "user",
        x: 700,
        y: 1100,
        size: 20,
        color: "#1A1A1A",
        text: "屏幕侧越界扫描的长批注不能让纸边裁掉也不能落到页脚外面",
      },
    ];
    editor.renderPages();
    await sleep(150);

    const el = pageEl().querySelector(".mb-text.is-user") as HTMLElement | null;
    const pr = pageEl().getBoundingClientRect();
    const sr = el?.getBoundingClientRect();
    const zoom = pr.width / 794;
    const lineH = 20 * 1.32 * zoom;
    pass(!!sr, "屏幕：批注 span 渲染出来了");
    if (sr) {
      pass(
        sr.right <= pr.right + 0.5,
        "屏幕：贴右缘起的批注不出纸（span 右缘 " + (sr.right - pr.left).toFixed(0) + " ≤ " + pr.width.toFixed(0) + "）"
      );
      pass(
        sr.bottom <= pr.bottom + 0.5,
        "屏幕：贴页底的长批注最后一行仍在纸内（span 底 " + (sr.bottom - pr.top).toFixed(0) + " ≤ " + pr.height.toFixed(0) + "）"
      );
      pass(
        sr.height / lineH > 1.5,
        "屏幕：长批注被折成多行（约 " + (sr.height / lineH).toFixed(1) + " 行高）"
      );
    }

    page.texts = [];
    editor.renderPages();
    await sleep(80);
  }

  /*
   * 拖动批注：上 / 下 / 左 / 右各拖过头一次，落点必须还在纸内。
   *
   * 上一版把拖动原来的 `clamp(…, size, height-4)` 换成了 `target.y = l.y`，
   * 而当时 l.y 只有上限没有下限，于是往上猛拖能把整块滑出纸顶：
   * 数据存成 y=-198，屏幕被裁、导出 0 字。夹取补全后再拖就不该出去了。
   */
  {
    const page = store.data.pages[0];
    const longDrag = "拖动越界扫描的长批注不能被拖出纸外也不能整块消失掉";
    page.texts = [
      { id: "t_drag", source: "user", x: 200, y: 300, size: 20, color: "#1A1A1A", text: longDrag },
    ];
    editor.setTool("select");
    editor.renderPages();
    await sleep(120);

    const dragTo = async (toX: number, toY: number) => {
      const el = pageEl();
      const item = (store.data.pages[0].texts || [])[0];
      const lay = (editor as any).textLayout(item);
      el.dispatchEvent(ev("pointerdown", lay.x + 6, lay.y - 4, 1, 31));
      el.dispatchEvent(ev("pointermove", toX, toY, 1, 31));
      el.dispatchEvent(ev("pointerup", toX, toY, 0, 31));
      await sleep(70);
      return (store.data.pages[0].texts || [])[0];
    };

    const size = 20;
    const cases: Array<[string, number, number]> = [
      ["往上拖过头", 200, -500],
      ["往下拖过头", 200, 5000],
      ["往左拖过头", -600, 300],
      ["往右拖过头", 2000, 300],
    ];
    for (const [label, tx, ty] of cases) {
      const item = await dragTo(tx, ty);
      const lay = (editor as any).textLayout(item);
      const lastBaseline = lay.y + (lay.lines.length - 1) * lay.lineHeight;
      const sp = pageEl().querySelector(".mb-text.is-user") as HTMLElement | null;
      const pr = pageEl().getBoundingClientRect();
      const sr = sp?.getBoundingClientRect();
      pass(
        lay.y >= size * 1.2 - 0.01 && lastBaseline <= 1123 - 8 + 0.01,
        "拖动" + label + "：落点 (x=" + item.x.toFixed(0) + ", y=" + item.y.toFixed(0) + ") 仍在纸内（首行 " +
          lay.y.toFixed(0) + " / 末行基线 " + lastBaseline.toFixed(0) + "）"
      );
      pass(
        item.x >= -0.01 && item.x <= 794 - 120 + 0.01,
        "拖动" + label + "：横向落点被夹住（x=" + item.x.toFixed(0) + " ⊂ 0~674）"
      );
      pass(
        !!sr && sr.right <= pr.right + 0.5 && sr.bottom <= pr.bottom + 0.5 && sr.top >= pr.top - 0.5,
        "拖动" + label + "：屏幕上的 span 没出纸（上/右/下都在纸内）"
      );
    }

    editor.setTool("pen");
    page.texts = [];
    editor.renderPages();
    await sleep(80);
  }

  /*
   * 点太靠右新建：x 会被夹到 634，编辑框必须**出现在夹取后的位置**，
   * 否则用户点了 750 却在 634 看到框，会觉得"字跑了"。
   */
  {
    const page = store.data.pages[0];
    page.texts = [];
    editor.setTool("text");
    editor.renderPages();
    await sleep(100);

    const el = pageEl();
    el.dispatchEvent(ev("pointerdown", 750, 400, 1, 41));
    el.dispatchEvent(ev("pointerup", 750, 400, 0, 41));
    await sleep(80);

    const ta = pageEl().querySelector(".mb-text-edit") as HTMLTextAreaElement | null;
    const zoom = pageEl().getBoundingClientRect().width / 794;
    const left = ta ? parseFloat(ta.style.left) : -1;
    pass(
      !!ta && Math.abs(left - 634 * zoom) < 2,
      "点在 x=750 新建：编辑框出现在夹取后的 634（" + (ta ? left.toFixed(0) + "px / zoom " + zoom.toFixed(2) : "没有编辑框") + "）"
    );
    ta?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(60);
    pass((store.data.pages[0].texts || []).length === 0, "Esc 取消后没有留下空批注");
    editor.setTool("pen");
    editor.renderPages();
    await sleep(60);
  }

  log("DONE");
  document.title = "DONE";
  (window as any).__harness = { editor, store };
}

main().catch((e) => {
  log("FATAL " + (e && e.stack ? e.stack : e));
  document.title = "FATAL";
});
