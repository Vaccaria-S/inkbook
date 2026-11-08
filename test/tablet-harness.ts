/**
 * 平板与缩放相关测试：
 *   - 手势仲裁：笔优先、掌根忽略、双指进入手势
 *   - Ctrl+滚轮缩放：锚点位置不变
 *   - 双指捏合缩放
 *   - Word 解析：zip 解包 + 段落抽取
 */
import { TouchArbiter } from "../src/touch";
import { BookEditor } from "../src/editor";
import { BookStore } from "../src/store";
import { createBook } from "../src/types";
import { parseDocxParagraphs, parseZip } from "../src/word";

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

async function main() {
  /* -------------------- 手势仲裁 -------------------- */
  {
    const roles: string[] = [];
    const arb = new TouchArbiter({
      onRoleChange: (r) => roles.push(r),
      onGestureStart: () => roles.push("gesture-start"),
    });

    // 笔落下 → 应该能画
    let r = arb.down({ id: 1, type: "pen", x: 100, y: 100, pressure: 0.5 });
    pass(r === "draw", "笔按下 → 落笔");
    pass(arb.penDown, "检测到笔在用");

    // 笔活动期间手指落下 → 掌根，忽略
    r = arb.down({ id: 2, type: "touch", x: 200, y: 300, pressure: 0.5 });
    pass(r === "ignore", "笔活动时手指落下 → 判为掌根，忽略");

    // 笔抬起后，单指 → 滚动
    arb.up({ id: 1, type: "pen", x: 100, y: 100, pressure: 0 });
    r = arb.down({ id: 3, type: "touch", x: 50, y: 50, pressure: 0.5 });
    pass(r === "pan", "无笔时单指 → 滚动页面");

    // 第二根手指落下 → 进入手势
    r = arb.down({ id: 4, type: "touch", x: 150, y: 50, pressure: 0.5 });
    pass(r === "gesture", "第二根手指 → 进入双指手势");
    pass(roles.includes("gesture-start"), "触发了手势开始回调");

    /*
     * 双指移动 → 缩放回调。
     *
     * 现在回调传的是**绝对量**（当前两指距离 dist + 中心 cx/cy），
     * 不是每帧的相对增量。
     *
     * 为什么改：浏览器给每根手指各发一套 pointermove，
     * 两根手指的移动是分两次事件到达的。
     * 用相对增量的话，第一根手指移动时第二根还停在原地，
     * 算出来的距离只有真实值的一半
     * （实测 174/160，应为 188/160）。
     */
    let pinch: { dist: number; cx: number; cy: number } | null = null;
    const arb2 = new TouchArbiter({
      onGestureMove: (info) => (pinch = info),
    });
    arb2.down({ id: 1, type: "touch", x: 100, y: 100, pressure: 0.5 });
    arb2.down({ id: 2, type: "touch", x: 200, y: 100, pressure: 0.5 });
    // 起始距离 100
    arb2.move({ id: 2, type: "touch", x: 300, y: 100, pressure: 0.5 });
    pass(
      !!pinch && Math.abs(pinch.dist - 200) < 0.5,
      "双指分开 → 距离 " + (pinch ? pinch.dist.toFixed(1) : "-") + "（应为 200）"
    );
    pass(
      !!pinch && Math.abs(pinch.cx - 200) < 0.5,
      "两指中心 x = " + (pinch ? pinch.cx.toFixed(1) : "-") + "（应为 200）"
    );

    // 双指靠近 → 距离变小
    arb2.move({ id: 2, type: "touch", x: 110, y: 100, pressure: 0.5 });
    pass(
      !!pinch && Math.abs(pinch.dist - 10) < 0.5,
      "双指靠拢 → 距离 " + (pinch ? pinch.dist.toFixed(1) : "-") + "（应为 10）"
    );

    /*
     * 两指**同时**移动时，距离必须是两指新位置的差。
     *
     * 这是本轮修复的核心断言：旧实现按 pointerId 过滤，
     * 第二根手指的 pointermove 被丢掉，距离只算得出半程。
     */
    const arb2b = new TouchArbiter({
      onGestureMove: (info) => (pinch = info),
    });
    arb2b.down({ id: 1, type: "touch", x: 100, y: 100, pressure: 0.5 });
    arb2b.down({ id: 2, type: "touch", x: 200, y: 100, pressure: 0.5 });
    // 两指各往外挪 50：第一指 →50，第二指 →250
    arb2b.move({ id: 1, type: "touch", x: 50, y: 100, pressure: 0.5 });
    arb2b.move({ id: 2, type: "touch", x: 250, y: 100, pressure: 0.5 });
    pass(
      !!pinch && Math.abs(pinch.dist - 200) < 0.5,
      "两指同时张开 → 距离 " + (pinch ? pinch.dist.toFixed(1) : "-") + "（应为 200，不是半程 150）"
    );

    // 抬起一根 → 手势结束
    let ended = false;
    const arb3 = new TouchArbiter({ onGestureEnd: () => (ended = true) });
    arb3.down({ id: 1, type: "touch", x: 100, y: 100, pressure: 0.5 });
    arb3.down({ id: 2, type: "touch", x: 200, y: 100, pressure: 0.5 });
    arb3.up({ id: 2, type: "touch", x: 200, y: 100, pressure: 0 });
    pass(ended, "抬起一根手指 → 手势结束");
    pass(!arb3.isGesturing, "不再处于手势状态");

    // 笔优先于手指：笔活动时即使双指也不该抢
    const arb4 = new TouchArbiter();
    arb4.down({ id: 1, type: "pen", x: 10, y: 10, pressure: 0.5 });
    const rr = arb4.down({ id: 2, type: "touch", x: 20, y: 20, pressure: 0.5 });
    pass(rr === "ignore", "笔优先：双指也不会打断正在写的笔画");
  }

  /*
   * INK-191 🔴 掌根计数泄漏 → 幽灵手势卡死。
   *
   * 真实场景：页底写字时掌根 + 腕同时贴屏。老代码 `touchCount++`
   * 在 `penActive` 判断之前，掌根被标 ignored 却已计数；`up()` 又按
   * ignored 不减 → 每只掌根永久 +1。抬笔后 touchCount 已是 2，
   * 手在屏上一滑就触发 beginGesture；可两指全是 ignored、
   * pinchState() 为 null，仍以 (0,0) 为锚点启动手势 → gesturing
   * 再也退不出去，滚动/捏合全失灵。
   */
  {
    const starts: Array<{ dist: number; cx: number; cy: number }> = [];
    const arbP = new TouchArbiter({ onGestureStart: (s) => starts.push(s) });

    // 笔在写，掌根 + 腕同时贴屏
    arbP.down({ id: 1, type: "pen", x: 300, y: 1000, pressure: 0.5 });
    arbP.down({ id: 2, type: "touch", x: 250, y: 1050, pressure: 0.5 });
    arbP.down({ id: 3, type: "touch", x: 400, y: 1060, pressure: 0.5 });
    pass(
      arbP.touchCountNow === 0,
      "INK-191 笔写时掌根+腕贴屏：touchCount 仍是 0（实际 " + arbP.touchCountNow + "）"
    );

    // 抬笔
    arbP.up({ id: 1, type: "pen", x: 300, y: 1000, pressure: 0 });
    pass(
      arbP.touchCountNow === 0,
      "INK-191 抬笔后 touchCount 仍是 0（实际 " + arbP.touchCountNow + "）"
    );

    // 手在屏上一滑：两指都是掌根，绝不能启动手势
    const mv = arbP.move({ id: 2, type: "touch", x: 260, y: 1055, pressure: 0.5 });
    pass(
      mv !== "gesture" && starts.length === 0,
      "INK-191 掌根滑动不触发手势（role=" + mv + "，gestureStart 次数 " + starts.length + "）"
    );

    // 掌根抬起后计数仍为 0，之后真正的两指能正常工作
    arbP.up({ id: 2, type: "touch", x: 260, y: 1055, pressure: 0 });
    arbP.up({ id: 3, type: "touch", x: 400, y: 1060, pressure: 0 });
    pass(arbP.touchCountNow === 0, "INK-191 掌根全抬起后 touchCount 归零");
    arbP.down({ id: 4, type: "touch", x: 100, y: 200, pressure: 0.5 });
    const g = arbP.down({ id: 5, type: "touch", x: 300, y: 200, pressure: 0.5 });
    pass(g === "gesture" && starts.length === 1, "INK-191 之后真正的两指仍能正常起手势");
    pass(
      starts[0].dist > 0,
      "INK-191 手势起始几何有效（dist=" + starts[0].dist.toFixed(1) + "，不再是 (0,0)）"
    );
  }

  /* -------------------- Ctrl+滚轮缩放 -------------------- */
  {
    const book = createBook("缩放测试", "grid", "white");
    const store = new BookStore(book);
    const host = document.createElement("div");
    // 放一个可见但被裁剪的容器，保证能滚动（内容比视口宽）
    host.style.cssText =
      "position:absolute;left:0;top:0;width:400px;height:600px;overflow:hidden";
    document.body.appendChild(host);
    const editor = new BookEditor(host, store, { smoothing: 0.5 });
    await sleep(250);

    const z0 = editor.getState().zoom;
    editor.zoomAt(400, 300, 1.5);
    const z1 = editor.getState().zoom;
    pass(z1 > z0, "缩放生效：" + z0.toFixed(2) + " → " + z1.toFixed(2));

    // 缩放有上下限
    editor.setZoom(99);
    pass(editor.getState().zoom <= 2.8, "缩放上限 2.8");
    editor.setZoom(0.01);
    pass(editor.getState().zoom >= 0.3, "缩放下限 0.3");

    /*
     * 锚点缩放：**光标指向的那个内容点**在缩放前后屏幕位置不变。
     *
     * 早先这里测的是「页面坐标 (300,250) 这个点相对光标的偏移」——
     * 但锚点并不是那个点，而是光标正下方的内容点。
     * 两者只有在光标恰好落在 (300,250) 上时才等价，
     * 而光标在屏幕 (rect.left+300, rect.top+250)，
     * 对应的页面坐标是 (420, 228)——前提根本不成立。
     *
     * 这个错误前提以前没暴露，是因为 tablet.html 当时**没加载 CSS**，
     * 布局是坏的，页面位置和滚动都不对，误差互相抵消了。
     * 补上 CSS 后布局正常了，错误前提才显形。
     *
     * 现在直接用 pickAnchor 拿到真正的锚点，再量它漂不漂。
     */
    editor.setZoom(1);
    await sleep(120);
    const scroll = (editor as any).scrollEl;
    scroll.scrollLeft = 120;
    await sleep(60);
    const rect = scroll.getBoundingClientRect();
    const ax = 300;
    const ay = 250;

    const anchor = (editor as any).pickAnchor(rect.left + ax, rect.top + ay) as {
      index: number;
      fx: number;
      fy: number;
    };
    // 量出锚点内容点此刻的屏幕位置
    const probeAt = () => {
      const rec = (editor as any).recs[anchor.index];
      const r = rec.pageEl.getBoundingClientRect();
      return { x: r.left + anchor.fx * r.width, y: r.top + anchor.fy * r.height };
    };
    const before = probeAt();

    editor.zoomAt(rect.left + ax, rect.top + ay, 1.4);
    await sleep(150);

    const after = probeAt();
    const drift = Math.hypot(after.x - before.x, after.y - before.y);
    pass(
      drift < 1.5,
      "锚点缩放：光标下的内容点不漂移（漂移 " + drift.toFixed(2) + "px）"
    );

    // 滚轮事件：ctrl+wheel 应改变缩放
    const zBefore = editor.getState().zoom;
    scroll.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -100,
        ctrlKey: true,
        clientX: rect.left + 200,
        clientY: rect.top + 200,
        bubbles: true,
        cancelable: true,
      })
    );
    await sleep(80);
    pass(editor.getState().zoom > zBefore, "Ctrl+滚轮放大生效");

    // 不带 ctrl 的滚轮不改缩放
    const zBefore2 = editor.getState().zoom;
    scroll.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -100,
        clientX: rect.left + 200,
        clientY: rect.top + 200,
        bubbles: true,
        cancelable: true,
      })
    );
    await sleep(80);
    pass(
      Math.abs(editor.getState().zoom - zBefore2) < 0.001,
      "普通滚轮不改变缩放（留给页面滚动）"
    );
  }

  /* -------------------- Word 解析 -------------------- */
  {
    // 造一个最小 docx：zip 里放 word/document.xml
    const xml =
      '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>第一章</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>这是正文段落。</w:t></w:r><w:r><w:t>第二段文字</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>列表项</w:t></w:r></w:p>' +
      "</w:body></w:document>";

    const paras = parseDocxParagraphs(xml);
    pass(paras.length === 3, "抽出 3 个段落：" + paras.length);
    pass(paras[0].text === "第一章", "第一段文字：" + paras[0].text);
    pass(paras[0].level === 1, "识别为一级标题");
    pass(paras[0].bold, "识别加粗");
    pass(paras[1].text === "这是正文段落。第二段文字", "拼接同一段里的多个 run");
    pass(paras[2].list, "识别列表项");

    // XML 实体
    const ents = parseDocxParagraphs(
      '<w:document><w:body><w:p><w:r><w:t>a &amp; b &lt;c&gt;</w:t></w:r></w:p></w:body></w:document>'
    );
    pass(ents[0].text === "a & b <c>", "XML 实体解码：" + ents[0].text);
  }

  await sleep(60);
  log(failures === 0 ? "ALL PASS" : failures + " FAILED");
  document.title = "DONE";
}

main();
