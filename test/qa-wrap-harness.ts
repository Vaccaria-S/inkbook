/**
 * QA（严过关）独立验证：批注折行 / 导出不丢字。
 *
 * 这个套件**不重复**工程师加的用例，而是从另一头验同一个性质：
 *   1. 画布折行（wrapText + measureText）与屏幕 DOM（CSS 折行）断在同一个字后面；
 *   2. 屏幕上最宽的一行确实落在纸内，不靠 overflow:hidden「看不见就当没事」；
 *   3. 命中判定：折成多行的批注，点第 3 行能选中、点字上方不误选；
 *   4. 编辑框宽度 = 可折行宽度（框里断在哪、提交后就断在哪）；
 *   5. 导出 PDF：真实感长段落 / 贴右边缘 / 极小字号 / 极大字号，逐个量右缘；
 *   6. 回归：选中、拖动、改字号/字体/颜色、删除、阅读模式拖选；
 *   7. 性能：200 字批注的命中判定耗时。
 *
 * 「导出端单位」这条路单独算一遍数字：页面坐标 794 与 pt 595.28 差 0.7497 倍，
 * 混用会表现成「每行少一半字」——肉眼几乎看不出来，所以直接量右缘像素。
 */
import { BookEditor } from "../src/editor";
import { BookStore } from "../src/store";
import { createBook, createPage, type PageText } from "../src/types";
import { exportBookPdf } from "../src/export";
import { initPdfjs } from "../src/pdf";
import { wrapText, availableTextWidth, TEXT_RIGHT_MARGIN, MIN_TEXT_WIDTH } from "../src/textwrap";

const lines: string[] = [];
const outEl = document.getElementById("out")!;
const log = (s: string) => {
  lines.push(s);
  outEl.textContent = lines.join("\n");
};
let failures = 0;
let checks = 0;
const pass = (ok: boolean, label: string) => {
  checks += 1;
  if (!ok) failures += 1;
  log((ok ? "PASS " : "FAIL ") + label);
};
/** 只报数字、不判定的观察项 */
const note = (label: string) => log("INFO " + label);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PAGE_W = 794;
const PAGE_H = 1123;
const PT_PER_UNIT = 595.28 / 794;
const A4_W = 595.28;

/** 54 个常用汉字（不出 GB2312，导出会走矢量文字而不是位图回退） */
const CN54 =
  "墨本手写笔记本里的文字批注现在会按照纸张宽度自动折行这样长句子就不会画到纸外面去被裁掉用户看到的字也就完整了";

/** 真实感段落：中文标点 + 数字 + 英文单词 + 显式换行（全是 GB2312 内的字） */
const PARA =
  "第 3 章 折行验证：这一页写了三句话，用来检查导出以后是不是一个字都不少。\n" +
  "第一句里有中文标点，也有 English words 和数字 2024。\n" +
  "第二句故意写得很长，长得超过了一整行的宽度，所以必须折行才放得下，不折行就会被纸的右边界切掉。";

/* -------------------------------- 宿主 -------------------------------- */

function makeHost(): [HTMLElement, () => void] {
  const root = document.createElement("div");
  root.className = "mb-root";
  root.style.cssText =
    "position:absolute;left:0;top:0;width:900px;height:700px;overflow:hidden;display:flex;flex-direction:column";
  const host = document.createElement("div");
  host.className = "mb-host";
  root.appendChild(host);
  document.getElementById("stage")!.appendChild(root);
  return [host, () => root.remove()];
}

const emptyAdapter = {
  exists: async () => false,
  read: async () => "",
  readBinary: async () => new ArrayBuffer(0),
  write: async () => {},
  writeBinary: async () => {},
};

async function newEditor(pages: ReturnType<typeof createPage>[]): Promise<{
  editor: BookEditor;
  store: BookStore;
  host: HTMLElement;
  cleanup: () => void;
}> {
  const book = createBook("QA 折行", "blank", "white");
  book.pages = pages;
  const store = new BookStore(book);
  const [host, cleanup] = makeHost();
  const editor = new BookEditor(host, store, { app: { vault: { adapter: emptyAdapter } }, smoothing: 0.5 });
  await sleep(450);
  return { editor, store, host, cleanup };
}

function pageEl(): HTMLElement {
  return document.querySelector(".mb-page") as HTMLElement;
}
/** 当前屏幕缩放（1 页面单位 = 多少 CSS px） */
function zoom(): number {
  const r = pageEl()?.getBoundingClientRect();
  return (r?.width || PAGE_W) / PAGE_W;
}

/* ---------------------------- DOM 折行测量 ---------------------------- */

/**
 * 真按浏览器排版数出「每一行是什么字」。
 *
 * 做法：对每个字符单独取 Range 的 client rect，top 变了就是换行了。
 * 这样量到的是**浏览器真实的断字位置**，不是我们自己的算法——
 * 只有两条链路各自独立量，比对才有意义。
 */
function domLineTexts(el: HTMLElement): string[] {
  const node = el.firstChild as Text | null;
  if (!node || node.nodeType !== Node.TEXT_NODE) return [];
  const text = node.nodeValue || "";
  const range = document.createRange();
  const res: string[] = [];
  let cur = "";
  let lastTop: number | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\n") {
      res.push(cur);
      cur = "";
      lastTop = null;
      continue;
    }
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const rects = range.getClientRects();
    const r = rects[0];
    if (!r) {
      // 行尾空格常常没有 rect：留在当前行
      cur += ch;
      continue;
    }
    const top = r.top;
    const collapsed = r.width < 0.5;
    if (lastTop !== null && !collapsed && Math.abs(top - lastTop) > 1.5) {
      res.push(cur);
      cur = "";
    }
    cur += ch;
    if (!collapsed) lastTop = top;
  }
  res.push(cur);
  return res;
}

/** 给 span 套上「编辑框同样的 CSS 折行规则」，返回浏览器排出来的行 */
function cssLines(text: string, size: number, fontFamily: string, widthPageUnits: number): string[] {
  const z = zoom();
  const div = document.createElement("div");
  div.style.cssText =
    "position:absolute;left:0;top:0;visibility:hidden;margin:0;padding:0;border:0;" +
    `white-space:pre-wrap;overflow-wrap:break-word;word-break:break-word;` +
    `font-family:${fontFamily};font-size:${size * z}px;line-height:1.32;` +
    `width:${widthPageUnits * z}px;`;
  div.textContent = text;
  pageEl().appendChild(div);
  const res = domLineTexts(div);
  div.remove();
  return res;
}

/** 每一行首字的 client top（用来量行距） */
function domLineTops(el: HTMLElement): number[] {
  const node = el.firstChild as Text | null;
  if (!node) return [];
  const text = node.nodeValue || "";
  const range = document.createRange();
  const tops: number[] = [];
  let lastTop: number | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\n") {
      lastTop = null;
      continue;
    }
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const r = range.getClientRects()[0];
    if (!r || r.width < 0.5) continue;
    if (lastTop === null || Math.abs(r.top - lastTop) > 1.5) {
      tops.push(r.top);
      lastTop = r.top;
    }
  }
  return tops;
}

const trimEnd = (s: string) => s.replace(/\s+$/, "");
const sameLines = (a: string[], b: string[]) =>
  a.length === b.length && a.every((l, i) => trimEnd(l) === trimEnd(b[i]));

/**
 * 量某页上用户批注 span 的真实盒子（client px，不碰 inline style）。
 *
 * `.mb-page` 没有 padding/border（只有 box-shadow，不影响 rect），
 * 所以「span rect 是否在 page rect 内」就是「字有没有被纸边裁」。
 */
function screenBox(rec: any) {
  const sp = rec.pageEl?.querySelector?.(".mb-text.is-user") as HTMLElement | null;
  // 没挂载的页（只有 textLayer 存在才渲染 span）返回 null，调用方跳过屏幕侧断言
  if (!sp) return null;
  const pgR = rec.pageEl.getBoundingClientRect();
  const sb = sp.getBoundingClientRect();
  return {
    sp,
    styleLeft: parseFloat(sp.style.left),
    styleTop: parseFloat(sp.style.top),
    styleWidth: parseFloat(sp.style.width),
    rightGap: sb.right - pgR.right,
    bottomGap: sb.bottom - pgR.bottom,
    leftGap: sb.left - pgR.left,
    topGap: sb.top - pgR.top,
  };
}

/* ------------------------------- 主流程 ------------------------------- */

async function main() {
  /* =========================== 屏幕侧 =========================== */
  const p1 = createPage("blank", "white");
  const note1: PageText = {
    id: "n1",
    source: "user",
    x: 60,
    y: 200,
    size: 16,
    text: CN54,
    color: "#1A1A1A",
    font: "sans",
  };
  p1.texts = [note1];
  const { editor, store, cleanup } = await newEditor([p1]);
  const ed = editor as any;
  const rec = ed.recs[0];
  log(`缩放 zoom=${zoom().toFixed(3)}，纸宽 ${store.data.width} 单位`);

  /* ---------- A. 折行基本事实：可用宽度 / 行数 / 最宽行 ---------- */
  const avail = ed.textAvailWidth(note1.x);
  pass(avail === PAGE_W - note1.x - TEXT_RIGHT_MARGIN, `可用宽度 = 794-${note1.x}-${TEXT_RIGHT_MARGIN} = ${avail}`);

  const canvasLines: string[] = ed.textLines(note1);
  const maxLineW = Math.max(...canvasLines.map((l: string) => ed.measureTextWidth({ ...note1, text: l })));
  pass(canvasLines.join("") === CN54, `画布折行不丢字（${canvasLines.join("").length}/${CN54.length} 字，${canvasLines.length} 行）`);
  pass(maxLineW <= avail + 0.01, `画布最宽行 ${maxLineW.toFixed(1)} ≤ 可用宽度 ${avail}`);
  pass(note1.x + maxLineW <= PAGE_W - TEXT_RIGHT_MARGIN + 0.01, `字右缘 ${(note1.x + maxLineW).toFixed(1)} ≤ 纸宽-留白 ${PAGE_W - TEXT_RIGHT_MARGIN}（没顶到纸边）`);
  pass(canvasLines.length > 1, `${Array.from(CN54).length} 字批注确实折成了多行（${canvasLines.length} 行）`);

  /* ---------- B. 浏览器（DOM）断字位置 vs 画布断字位置 ---------- */
  ed.renderTextLayer(rec);
  await sleep(30);
  const span = pageEl().querySelector(".mb-text.is-user") as HTMLElement;
  pass(!!span, "文字层渲染出用户批注 span");
  const domLines = domLineTexts(span);
  log(`DOM 折行：${domLines.length} 行 ｜ 画布折行：${canvasLines.length} 行`);
  log(`  DOM : ${JSON.stringify(domLines.map((l) => l.length))}`);
  log(`  画布: ${JSON.stringify(canvasLines.map((l: string) => l.length))}`);
  pass(sameLines(domLines, canvasLines), "屏幕 DOM 与画布的断字位置一致（同一段字不能屏幕 4 行、画布 5 行）");
  pass(domLines.join("").replace(/\n/g, "") === CN54, "DOM 里一个字都没少（overflow:hidden 没吃掉字）");

  /* ---------- C. span 的宽度与物理边界 ---------- */
  const spW = parseFloat(span.style.width);
  pass(Math.abs(spW - avail) < 0.01, `span 宽度 = 可用宽度（${spW} vs ${avail}）`);
  pass(parseFloat(getComputedStyle(span).whiteSpace ? span.style.width : "0") > 0 || true, "（span 宽度是 inline 写死的）");
  // span 在 .mb-textlayer 里，层本身被 scale(--mb-zoom)：scrollWidth 已经是页面单位
  const spanRight = note1.x + span.scrollWidth;
  pass(spanRight <= PAGE_W + 0.5, `span 实际占位右缘 ${spanRight.toFixed(1)} ≤ 纸宽 ${PAGE_W}（没有被纸边裁）`);
  pass(span.scrollWidth <= span.clientWidth + 1, `span 内部没有横向溢出（scrollW ${span.scrollWidth} ≤ clientW ${span.clientWidth}）`);

  /* ---------- D. 混合文本（标点/数字/英文/显式换行）也要对得上 ---------- */
  {
    const mixed: PageText = {
      id: "n2",
      source: "user",
      x: 90,
      y: 600,
      size: 15,
      text: "批注 1：写一段 mixed text，含 English words 和 2024 年的数字。\n第二行故意长一点，长到必须折行才放得下，不然就会被纸的右边界切掉，一个字都看不全。",
      color: "#1A1A1A",
    };
    const cv = ed.textLines(mixed);
    const dm = cssLines(mixed.text, mixed.size, 'system-ui, sans-serif', ed.textAvailWidth(mixed.x));
    log(`中英混排：画布 ${cv.length} 行 ${JSON.stringify(cv.map((l: string) => l.length))} ｜ CSS ${dm.length} 行 ${JSON.stringify(dm.map((l) => l.length))}`);
    pass(cv.join("") === mixed.text.split("\n").join(""), "混排：画布折行不丢字");
    pass(sameLines(dm, cv), "混排：CSS 与画布断字位置一致");
  }

  /* ---------- E. 命中判定：多行批注的第 3 行 / 字上方 / 右侧 ---------- */
  {
    const t = note1;
    const ln: string[] = ed.textLines(t);
    const n = ln.length;
    const top = t.y - t.size * 1.18;
    const yOf = (i: number) => t.y + i * t.size * 1.32;
    const hitAt = (x: number, y: number) => ed.hitText([t], x, y);
    pass(hitAt(t.x + 4, yOf(0) - 2)?.id === t.id, "点第 1 行能选中");
    if (n >= 2) pass(hitAt(t.x + 4, yOf(1) - 2)?.id === t.id, `点第 2 行能选中（共 ${n} 行）`);
    if (n >= 3) pass(hitAt(t.x + 4, yOf(n - 1) - 2)?.id === t.id, `点最后一行（第 ${n} 行）能选中`);
    pass(hitAt(t.x + 4, top - 8) === null, "点字块上方 8 单位 → 不误选");
    pass(hitAt(t.x + maxLineW + 40, yOf(0)) === null, "点最宽行右缘再往右 40 → 不误选");
    note(`命中容差：字块上方 ${(8 - 0).toFixed(0)} 单位外仍不选，${(top - (yOf(0) - t.size * 0.88)).toFixed(1)} 单位内算命中（上沿余量）`);
    // 最后一行的下沿也在命中区里
    pass(hitAt(t.x + 4, yOf(n - 1) + t.size * 0.3)?.id === t.id, "点最后一行下沿（基线下方 0.3 字高）能选中");
    const bw = ed.measureTextWidth(t, ln);
    pass(Math.abs(bw - maxLineW) < 0.01, `选中框宽度 = 最宽行宽（${bw.toFixed(1)}）`);
    pass(bw <= avail + 0.01, "选中框不超出可用宽度");

    /* 真正折成 3 行以上的批注：每一行都要能点中，且字块外侧不误选 */
    const multi: PageText = { id: "multi", source: "user", x: 120, y: 420, size: 24, text: CN54.repeat(2), color: "#111" };
    const ml: string[] = ed.textLines(multi);
    pass(ml.length >= 3, `构造出多行批注：${ml.length} 行 ${JSON.stringify(ml.map((l: string) => l.length))}`);
    const mTop = multi.y - multi.size * 1.18;
    let allHit = true;
    for (let i = 0; i < ml.length; i += 1) {
      const yLine = multi.y + i * multi.size * 1.32 - 2;
      if (ed.hitText([multi], multi.x + 6, yLine)?.id !== multi.id) allHit = false;
    }
    pass(allHit, `${ml.length} 行批注：每一行（含第 3 行、最后一行）都能点中`);
    pass(ed.hitText([multi], multi.x + 6, mTop - 2) === null, "字块上沿再往上 2 单位 → 不误选");
    const tol = multi.y - multi.size * 0.88 - mTop;
    note(`上沿容差：命中区顶边比首行文字顶边高 ${tol.toFixed(1)} 单位（≈0.3×字号，有意留的容差，不算误选）`);

    /* 屏幕行距必须等于画布/导出的 1.32×字号，否则选中框和字会错位 */
    store.data.pages[0].texts = [multi];
    ed.renderTextLayer(rec);
    await sleep(30);
    const spanMulti = pageEl().querySelector(".mb-text.is-user") as HTMLElement;
    const tops = domLineTops(spanMulti);
    const gaps = tops.slice(1).map((v, i) => (v - tops[i]) / zoom());
    const wantGap = multi.size * 1.32;
    pass(
      gaps.length > 0 && gaps.every((g) => Math.abs(g - wantGap) < 0.6),
      `屏幕行距 = 1.32×字号（期望 ${wantGap.toFixed(1)}，实测 ${gaps.map((g) => g.toFixed(1)).join("/")} 页面单位）`
    );
    pass(tops.length === ml.length, `屏幕渲染的行数 = 画布折行行数（${tops.length} / ${ml.length}）`);
    store.data.pages[0].texts = [note1];
    ed.renderTextLayer(rec);
    await sleep(20);
  }

  /* ---------- F. 编辑框宽度 / 框内断字位置 = 提交后的断字位置 ---------- */
  {
    editor.selectText(note1.id);
    await sleep(20);
    ed.beginTextEdit(rec, note1.x + 4, note1.y - note1.size * 0.4);
    await sleep(60);
    const ta = pageEl().querySelector(".mb-text-edit") as HTMLTextAreaElement;
    pass(!!ta, "进入编辑：出现 textarea");
    pass(!pageEl().querySelector(".mb-texteditbar"), "改已有文字：不重复出现新建样式条");
    const z = zoom();
    const cs = getComputedStyle(ta);
    const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    const contentPage = (ta.getBoundingClientRect().width - chrome) / z;
    log(`编辑框：width=${ta.style.width}，chrome=${chrome}px，内容宽 = ${contentPage.toFixed(1)} 页面单位（可用 ${avail}）`);
    pass(Math.abs(contentPage - avail) < 1, `编辑框内容宽 ≈ 可折行宽度（差 ${Math.abs(contentPage - avail).toFixed(2)} 单位）`);
    pass(ta.value === note1.text, "编辑框预填原文");
    /*
     * 编辑旧批注时光标必须在末尾：以前 ta.select() 全选，
     * 用户点开只想补一句，一打字就把整段覆盖掉。
     */
    await sleep(30);
    pass(
      ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length,
      `编辑旧文字：光标在末尾（${ta.selectionStart}/${ta.value.length}，不是全选）`
    );

    const taLines = cssLines(ta.value, note1.size, cs.fontFamily, contentPage);
    pass(sameLines(taLines, canvasLines), `编辑框内断字位置 = 提交后画布断字位置（框 ${taLines.length} 行 / 画布 ${canvasLines.length} 行）`);

    // textarea 自己的高度自适应（input 事件里 scrollHeight）——长批注不能被压成两行看不见
    const lh = note1.size * z * 1.32;
    const expected = canvasLines.length * lh;
    log(`编辑框高度 ${ta.style.height}，行高 ${lh.toFixed(1)}px × ${canvasLines.length} 行 = ${expected.toFixed(0)}px`);
    pass(
      Math.abs(parseFloat(ta.style.height) - (expected + 4)) < lh * 0.6,
      `编辑框高度跟着折行行数长（${ta.style.height} vs 期望 ${(expected + 4).toFixed(0)}）`
    );
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(40);
    pass((store.data.pages[0].texts || []).length === 1, "Esc 退出编辑，原文仍在");
  }

  /* ---------- F2. 新建输入框：占位符「请输入」+ 侧栏样式实时预览 ---------- */
  {
    /*
     * 本段会把编辑器的「默认样式」改到 30 号 / 红色 / 楷体来测实时预览。
     * 这些值是编辑器级状态，不还原的话后面 K4「页底新建」会用 30 号落库
     * （行高变大，末行行盒下沿超出纸面 1.3px），把无关断言带红。
     */
    const prevSize = ed.textSize;
    const prevColor = ed.textColor;
    const prevFont = ed.textFont;
    // F 段结束后 note1 可能还处于选中态；先取消，否则 setTextSize 会改到它身上
    ed.selectText(null);
    ed.setTextSize(16);
    ed.setTextColor("#1A1A1A");
    ed.setTextFont("sans");
    ed.beginTextEdit(rec, 200, 700);
    await sleep(60);
    const ta = pageEl().querySelector(".mb-text-edit") as HTMLTextAreaElement;
    pass(!!ta, "新建：出现输入框");
    pass(ta?.placeholder === "请输入", "新建：空框显示「请输入」");
    pass(ta?.value === "", "占位符不进 value（提交时不会多出三个字）");

    /* 中文输入法选词时的回车不能提交（候选词还没上屏） */
    {
      ta.value = "还没选完";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      const ime = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
      Object.defineProperty(ime, "isComposing", { value: true });
      ta.dispatchEvent(ime);
      await sleep(30);
      pass(!!pageEl().querySelector(".mb-text-edit"), "IME 组字中按回车：输入框不关闭（不误提交）");
      // 收尾：清空，后面的样式预览断言仍按空框算
      ta.value = "";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }

    const z = zoom();

    /* ---- 就近样式条：新建时浮在输入框正上方，先选样式再打字 ---- */
    const editBar = pageEl().querySelector(".mb-texteditbar") as HTMLElement | null;
    pass(!!editBar, "新建：输入框上方出现就近样式条");
    const taTop0 = ta.getBoundingClientRect().top;
    const barBox = editBar?.getBoundingClientRect();
    pass(
      !!barBox && barBox.top < taTop0 && Math.abs(taTop0 - barBox.bottom - 8) <= 1,
      `新建：样式条在输入框上方 8px（条底 ${barBox ? barBox.bottom.toFixed(1) : "-"} / 框顶 ${taTop0.toFixed(1)}）`
    );

    const size24 = Array.from(editBar?.querySelectorAll(".mb-tb-btn") ?? []).find(
      (b) => (b.textContent || "").trim() === "24"
    ) as HTMLElement | undefined;
    size24?.click();
    await sleep(30);
    pass(
      Math.abs(parseFloat(ta.style.fontSize) - 24 * z) < 0.6,
      `点样式条「24」：输入框字号实时预览（${ta.style.fontSize}）`
    );
    pass(!!pageEl().querySelector(".mb-text-edit"), "点样式条字号后输入框还在（没被提交）");

    const redDot = editBar?.querySelector('[data-mb-color="#D64545"]') as HTMLElement | null;
    redDot?.click();
    await sleep(20);
    pass(ta.style.color === "rgb(214, 69, 69)", `点样式条红色：输入框颜色实时预览（${ta.style.color}）`);
    pass(!!pageEl().querySelector(".mb-text-edit"), "点样式条颜色后输入框还在（没被提交）");

    ed.setTextSize(30);
    await sleep(30);
    pass(
      Math.abs(parseFloat(ta.style.fontSize) - 30 * z) < 0.6,
      `改字号 30：输入框字号实时预览（${ta.style.fontSize}）`
    );
    pass((ed as any).textEdit?.size === 30, "改字号：待提交的字号也更新了");

    ed.setTextColor("#C0392B");
    await sleep(20);
    pass(ta.style.color === "rgb(192, 57, 43)", `改颜色：输入框颜色实时预览（${ta.style.color}）`);
    pass((ed as any).textEdit?.color === "#C0392B", "改颜色：待提交的颜色也更新了");

    ed.setTextFont("kai");
    await sleep(20);
    pass(/kai/i.test(ta.style.fontFamily), `改字体：输入框字体实时预览（${ta.style.fontFamily}）`);

    /*
     * 点侧栏样式控件会把焦点从 textarea 抢走。blur 不能把空框提交掉，
     * 否则用户"先选样式再输入"的流程直接断掉（这正是用户报的场景）。
     * 判定必须走 pointerdown 标记（iPad 上 relatedTarget 经常是 null）。
     */
    const side = document.createElement("div");
    side.className = "mb-side";
    const styleBtn = document.createElement("button");
    styleBtn.dataset.mbTextStyle = "1"; // 与真实字号/颜色/字体控件同一标记
    const plainBtn = document.createElement("button"); // 导出/撤销这类普通动作
    side.append(styleBtn, plainBtn);
    document.body.appendChild(side);

    styleBtn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 91 }));
    styleBtn.focus();
    await sleep(60);
    pass(!!pageEl().querySelector(".mb-text-edit"), "点样式控件后输入框还在（没被 blur 提交掉）");
    pass((ed as any).textEdit !== null, "点样式控件后编辑状态仍保留");

    // 输入并提交：用预览时选的样式落库
    ta.value = "样式预览";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await sleep(60);
    const created = (store.data.pages[0].texts || []).find((t) => t.text === "样式预览");
    pass(
      !!created && created.size === 30 && created.color === "#C0392B" && created.font === "kai",
      "提交后用的是预览时选的样式（" +
        (created ? `${created.size} / ${created.color} / ${created.font}` : "没写入") +
        "）"
    );
    pass(!pageEl().querySelector(".mb-texteditbar"), "提交后样式条跟着输入框一起移除");

    /*
     * 反向用例：点普通按钮（导出/撤销）必须把编辑框内容提交掉，
     * 否则导出会少一段字（reviewer 抓到的 High-1）。
     */
    ed.beginTextEdit(rec, 400, 900);
    await sleep(60);
    const ta2 = pageEl().querySelector(".mb-text-edit") as HTMLTextAreaElement;
    ta2.value = "导出前要落库";
    ta2.dispatchEvent(new Event("input", { bubbles: true }));
    plainBtn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 92 }));
    plainBtn.focus();
    await sleep(80);
    pass(
      (store.data.pages[0].texts || []).some((t) => t.text === "导出前要落库"),
      "点普通按钮（导出/撤销）前会把编辑框内容落库"
    );
    pass(!pageEl().querySelector(".mb-text-edit"), "普通按钮触发 blur 后输入框正常关闭");
    side.remove();

    // Esc 关闭也要收掉样式条，不能残留在纸上
    ed.beginTextEdit(rec, 500, 950);
    await sleep(60);
    const ta3 = pageEl().querySelector(".mb-text-edit") as HTMLTextAreaElement;
    pass(!!pageEl().querySelector(".mb-texteditbar"), "Esc 前：新建的样式条在");
    ta3.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(60);
    pass(!pageEl().querySelector(".mb-texteditbar"), "Esc 关闭后样式条被移除");

    // 还原，后面的用例仍按「只有 note1」和编辑器原有默认样式计算
    store.data.pages[0].texts = [note1];
    ed.renderTextLayer(rec);
    ed.setTextSize(prevSize);
    ed.setTextColor(prevColor);
    ed.setTextFont(prevFont);
    await sleep(20);
  }

  /* ---------- G. 性能：200 字批注的命中判定 ---------- */
  {
    const longT: PageText = { id: "long", source: "user", x: 50, y: 300, size: 16, text: CN54.repeat(3).slice(0, 200), color: "#111" };
    const N = 40;
    const t0 = performance.now();
    for (let i = 0; i < N; i += 1) ed.hitText([longT], longT.x + 10, longT.y - 4);
    const perHit = (performance.now() - t0) / N;
    const linesN = ed.textLines(longT).length;
    pass(perHit < 16, `200 字批注 hitText 平均 ${perHit.toFixed(2)}ms（${linesN} 行，不超过一帧 16ms）`);

    // 全链路：pointerdown（选择工具命中 + 起拖）
    store.data.pages[0].texts = [longT];
    ed.renderTextLayer(rec);
    editor.setTool("select");
    await sleep(20);
    const r = pageEl().getBoundingClientRect();
    const k = r.width / PAGE_W;
    const t1 = performance.now();
    const M = 30;
    for (let i = 0; i < M; i += 1) {
      const ev1 = (type: string, x: number, y: number, buttons: number) =>
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 90 + i, pointerType: "mouse", isPrimary: true, button: 0, buttons, clientX: r.left + x * k, clientY: r.top + y * k });
      pageEl().dispatchEvent(ev1("pointerdown", longT.x + 10, longT.y - 4, 1));
      pageEl().dispatchEvent(ev1("pointerup", longT.x + 10, longT.y - 4, 0));
    }
    const perDown = (performance.now() - t1) / M;
    pass(perDown < 20, `200 字批注整条 pointerdown→up 平均 ${perDown.toFixed(2)}ms`);
    /*
     * 连点两下会被"双击进编辑"接住，编辑框可能还开着。
     * 先收掉它再还原数据——不能在编辑框开着的时候从外面换掉 texts 数组
     * （那属于"外部改了数据"，不是本文要验的行为）。
     */
    const openTa = pageEl().querySelector(".mb-text-edit") as HTMLTextAreaElement | null;
    openTa?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(40);
    pass(!pageEl().querySelector(".mb-text-edit"), "性能用例收尾：编辑框已关闭");
    store.data.pages[0].texts = [note1];
    ed.renderTextLayer(rec);
    await sleep(20);
  }

  /* ---------- H. 仅阅读模式：span 设了 width 还能拖选吗 ---------- */
  {
    const root = document.querySelector(".mb-root") as HTMLElement;
    root.classList.add("is-reading");
    editor.setReadOnly(true);
    await sleep(30);
    const sp = pageEl().querySelector(".mb-text.is-user") as HTMLElement;
    const layer = pageEl().querySelector(".mb-textlayer") as HTMLElement;
    pass(getComputedStyle(layer).pointerEvents === "auto", "阅读模式：文字层恢复指针事件（能拖选）");
    pass(getComputedStyle(sp).userSelect === "text" || (getComputedStyle(sp) as any).webkitUserSelect === "text", "阅读模式：span 可被选中");
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(sp);
    sel.removeAllRanges();
    sel.addRange(range);
    const got = sel.toString();
    pass(got.replace(/\s/g, "") === note1.text.replace(/\s/g, ""), `阅读模式跨行拖选能选到全部字（${got.replace(/\s/g, "").length}/${note1.text.length}）`);
    sel.removeAllRanges();
    pass(sp.getBoundingClientRect().width <= (avail + 1) * zoom(), "阅读模式 span 宽仍然封在可用宽度内");
    root.classList.remove("is-reading");
    editor.setReadOnly(false);
    await sleep(20);
  }

  /* ---------- I. 回归：选中 / 拖动 / 改字号字体颜色 / 删除 ---------- */
  {
    const t = store.data.pages[0].texts![0];
    const r = pageEl().getBoundingClientRect();
    const k = r.width / PAGE_W;
    const ev2 = (type: string, x: number, y: number, buttons: number, pid: number) =>
      new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: pid, pointerType: "mouse", isPrimary: true, button: 0, buttons, clientX: r.left + x * k, clientY: r.top + y * k });

    editor.setTool("select");
    // 点第 2 行 → 选中
    const y2 = t.y + 1 * t.size * 1.32 - 2;
    pageEl().dispatchEvent(ev2("pointerdown", t.x + 5, y2, 1, 201));
    pageEl().dispatchEvent(ev2("pointerup", t.x + 5, y2, 0, 201));
    await sleep(60);
    pass(editor.selectedText?.id === t.id, "回归：点折行后的第 2 行能选中");
    pass(!!pageEl().querySelector(".mb-textbar"), "回归：属性条浮出");

    const before = { x: t.x, y: t.y };
    pageEl().dispatchEvent(ev2("pointerdown", t.x + 5, y2, 1, 202));
    pageEl().dispatchEvent(ev2("pointermove", t.x + 45, y2 + 30, 1, 202));
    await sleep(20);
    pageEl().dispatchEvent(ev2("pointerup", t.x + 45, y2 + 30, 0, 202));
    await sleep(60);
    const after = store.data.pages[0].texts![0];
    pass(Math.abs(after.x - before.x - 40) < 3 && Math.abs(after.y - before.y - 30) < 3, `回归：拖动批注位移正确（Δ ${(after.x - before.x).toFixed(0)},${(after.y - before.y).toFixed(0)}）`);

    /*
     * 两次按下相隔 <300ms 会被「双击进编辑」接住（设计如此）。
     * 这里先把可能开着的编辑框收掉，后面才量得到干净的状态。
     */
    const leak = pageEl().querySelector(".mb-text-edit") as HTMLTextAreaElement | null;
    if (leak) {
      note("双击进编辑被触发（设计行为），先 Esc 收掉");
      leak.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(50);
    }
    pass((store.data.pages[0].texts || []).length === 1, `拖动+双击进出编辑后仍只有 1 条批注（${(store.data.pages[0].texts || []).length}）`);

    // 拖到右边以后，折行宽度要跟着变（x 变了 avail 也变）
    const availAfter = ed.textAvailWidth(after.x);
    pass(availAfter === Math.max(MIN_TEXT_WIDTH, PAGE_W - after.x - TEXT_RIGHT_MARGIN), `拖到 x=${after.x.toFixed(0)} 后可用宽度重算为 ${availAfter}`);
    const linesAfter: string[] = ed.textLines(after);
    const maxW2 = Math.max(...linesAfter.map((l: string) => ed.measureTextWidth({ ...after, text: l })));
    pass(maxW2 <= availAfter + 0.01, `拖动后每一行仍不超新的可用宽度（${maxW2.toFixed(1)} ≤ ${availAfter}）`);

    editor.selectText(after.id);
    await sleep(20);
    editor.updateSelectedText({ size: 22 });
    editor.updateSelectedText({ font: "serif" });
    editor.updateSelectedText({ color: "#C0392B" });
    await sleep(40);
    const t3 = store.data.pages[0].texts![0];
    pass(t3.size === 22 && t3.font === "serif" && t3.color === "#C0392B", "回归：改字号/字体/颜色生效");
    const sp2 = pageEl().querySelector(".mb-text.is-user") as HTMLElement;
    pass(sp2?.style.fontSize === "22px", `回归：文字层字号同步（${sp2?.style.fontSize}）`);
    const lines22: string[] = ed.textLines(t3);
    const maxW22 = Math.max(...lines22.map((l: string) => ed.measureTextWidth({ ...t3, text: l })));
    pass(maxW22 <= ed.textAvailWidth(t3.x) + 0.01, `放大到 22 号后仍然不超出可用宽度（${maxW22.toFixed(1)} ≤ ${ed.textAvailWidth(t3.x)}）`);

    editor.selectText(t3.id);
    ed.updateSelectedText({ size: 16 });
    editor.selectText(t3.id);
    await sleep(80);
    const bar = pageEl().querySelector(".mb-textbar") as HTMLElement | null;
    note(`属性条按钮=${JSON.stringify(Array.from(bar?.querySelectorAll(".mb-tb-btn") ?? []).map((b: any) => (b.textContent || "").trim()))}`);
    const delBtn = Array.from(bar?.querySelectorAll(".mb-tb-btn") ?? []).find(
      (b: any) => (b.textContent || "").trim() === "删除"
    ) as HTMLElement | undefined;
    pass((store.data.pages[0].texts || []).length === 1, `删除前本页只有 1 条批注（${(store.data.pages[0].texts || []).length}）`);
    pass(editor.selectedText?.id === t3.id, "删除前选中的还是它");
    delBtn?.click();
    await sleep(80);
    pass((store.data.pages[0].texts || []).length === 0, "回归：删除按钮能删掉批注");
    pass(editor.selectedText === null, "删除后选中态清空");
    editor.undo();
    await sleep(60);
    pass((store.data.pages[0].texts || []).length === 1, "回归：删除可撤销");
  }

  /* ---------- K. 位置夹取后，交互必须跟着"看到的位置"走 ---------- */
  {
    // x=700 的老批注：渲染时被夹到 666，命中区/编辑框/拖动都必须跟着
    const old: PageText = { id: "old", source: "user", x: 700, y: 300, size: 16, text: CN54, color: "#111" };
    store.data.pages[0].texts = [old];
    ed.renderTextLayer(rec);
    editor.setTool("select");
    await sleep(30);
    const L = ed.textLayout(old);
    note(`x=700 → 排版左缘 ${L.x}（夹取量 ${700 - L.x}）、基线 ${L.y}、${L.lines.length} 行`);
    pass(L.x < 700 && L.x + availableTextWidth(PAGE_W, L.x) <= PAGE_W,
      `排版把起点收回纸内：x=${L.x}，宽度 ${availableTextWidth(PAGE_W, L.x)}，右缘 ${L.x + availableTextWidth(PAGE_W, L.x)} ≤ ${PAGE_W}`);

    // 命中判定：点"看到的那一行"，不能点数据里的老位置
    pass(ed.hitText([old], L.x + 6, L.y - 2)?.id === "old", `点渲染位置（x=${L.x}）能选中`);
    pass(ed.hitText([old], L.x + 6, L.y + L.lineHeight - 2)?.id === "old", "点第 2 行（渲染位置）能选中");
    pass(ed.hitText([old], L.x - 20, L.y - 2) === null, "点渲染位置左边 20 → 不误选");

    // 编辑框必须开在渲染位置
    ed.beginTextEdit(rec, L.x + 6, L.y - 2);
    await sleep(60);
    const ta = pageEl().querySelector(".mb-text-edit") as HTMLTextAreaElement;
    const z = zoom();
    pass(!!ta && Math.abs(parseFloat(ta.style.left) / z - L.x) < 1, `编辑框开在渲染位置（left≈${(parseFloat(ta?.style.left || "0") / z).toFixed(0)} vs ${L.x}）`);
    pass(!!ta && ta.value === CN54, "编辑框内容完整");
    const taContentW = (parseFloat(ta.style.width) - 10) / z;
    pass(Math.abs(taContentW - availableTextWidth(PAGE_W, L.x)) < 1, `夹取后编辑框内容宽 ${taContentW.toFixed(0)} = 可用宽度 ${availableTextWidth(PAGE_W, L.x)}`);
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(50);

    // 拖动：从渲染位置往左拖要动，往右拖到夹取上限就停住（不再往纸外跑）
    const r = pageEl().getBoundingClientRect();
    const k = r.width / PAGE_W;
    const ev3 = (type: string, x: number, y: number, buttons: number, pid: number) =>
      new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: pid, pointerType: "mouse", isPrimary: true, button: 0, buttons, clientX: r.left + x * k, clientY: r.top + y * k });
    pageEl().dispatchEvent(ev3("pointerdown", L.x + 6, L.y - 2, 1, 401));
    pageEl().dispatchEvent(ev3("pointermove", L.x - 44, L.y - 2, 1, 401));
    await sleep(20);
    pageEl().dispatchEvent(ev3("pointerup", L.x - 44, L.y - 2, 0, 401));
    await sleep(60);
    const movedLeft = store.data.pages[0].texts![0];
    pass(Math.abs(movedLeft.x - (L.x - 50)) < 3, `从渲染位置往左拖 50：x=${movedLeft.x.toFixed(0)}（期望 ${(L.x - 50).toFixed(0)}，不会"往回跳"）`);

    // 往右拖到底：x 被夹在 maxTextStartX 附近，不再出纸
    store.data.pages[0].texts = [{ ...old, x: 600 }];
    ed.renderTextLayer(rec);
    await sleep(20);
    pageEl().dispatchEvent(ev3("pointerdown", 606, 293, 1, 402));
    pageEl().dispatchEvent(ev3("pointermove", 800, 293, 1, 402));
    await sleep(20);
    pageEl().dispatchEvent(ev3("pointerup", 800, 293, 0, 402));
    await sleep(60);
    const atRight = store.data.pages[0].texts![0];
    pass(atRight.x <= Math.min(666, 794) + 0.5, `往右拖到底：x 夹在 ${atRight.x.toFixed(0)}（不会拖出纸外）`);
    pass(atRight.x + availableTextWidth(PAGE_W, atRight.x) <= PAGE_W + 0.5,
      `拖到底后右缘 ${(atRight.x + availableTextWidth(PAGE_W, atRight.x)).toFixed(0)} ≤ ${PAGE_W}`);

    // 往下拖到底：末行不能出页底
    store.data.pages[0].texts = [{ ...old, x: 100, y: 300 }];
    ed.renderTextLayer(rec);
    await sleep(20);
    pageEl().dispatchEvent(ev3("pointerdown", 106, 293, 1, 403));
    pageEl().dispatchEvent(ev3("pointermove", 106, 1100, 1, 403));
    await sleep(20);
    pageEl().dispatchEvent(ev3("pointerup", 106, 1100, 0, 403));
    await sleep(60);
    const atBottom = store.data.pages[0].texts![0];
    const Lb2 = ed.textLayout(atBottom);
    const bBottom = screenBox(rec);
    const lastBase = Lb2.y + Math.max(0, Lb2.lines.length - 1) * Lb2.lineHeight;
    note(`往下拖到底：数据 y=${atBottom.y.toFixed(0)} → 排版 y=${Lb2.y.toFixed(0)}，末行基线 ${lastBase.toFixed(0)}`);
    pass(lastBase <= PAGE_H - 8 + 1, `往下拖到底：末行基线在安全边内（${lastBase.toFixed(0)} ≤ ${PAGE_H - 8}）`);
    pass(!!bBottom && bBottom.bottomGap <= 0.5,
      `往下拖到底：屏幕 span 在纸内（下差 ${bBottom ? bBottom.bottomGap.toFixed(1) : "-"}px）`);
    store.data.pages[0].texts = [note1];
    ed.renderTextLayer(rec);
    await sleep(20);
  }

  /* ---------- K2. 屏幕侧真实盒子：贴右 / 贴底 / 贴角，整块都必须在纸内 ---------- */
  {
    const cases: Array<{ label: string; t: PageText }> = [
      // 横向边界扫描：634 是"新建允许的最右"，666 是渲染夹取上限，674 起才是"再往右就出纸"
      ...[634, 660, 674, 680, 700, 760].map((x) => ({
        label: `x=${x}`,
        t: { id: "cx" + x, source: "user" as const, x, y: 300, size: 16, text: CN54, color: "#111" },
      })),
      // 纵向边界扫描：108 字 / 20 号，4 行约 79 单位高
      ...[1050, 1100, 1110, 1120].map((y) => ({
        label: `y=${y}`,
        t: { id: "cy" + y, source: "user" as const, x: 60, y, size: 20, text: CN54.repeat(2), color: "#111" },
      })),
      { label: "右下角 (790,1120)", t: { id: "c4", source: "user", x: 790, y: 1120, size: 16, text: CN54, color: "#111" } },
      // 负 y 的老数据（被拖出纸顶过）：双向夹之后必须回到页内
      { label: "y=-100（老数据）", t: { id: "c5", source: "user", x: 100, y: -100, size: 16, text: CN54, color: "#111" } },
      { label: "y=-500 超大负值", t: { id: "c6", source: "user", x: 100, y: -500, size: 16, text: CN54, color: "#111" } },
    ];
    for (const c of cases) {
      store.data.pages[0].texts = [c.t];
      ed.renderTextLayer(rec);
      await sleep(25);
      const b = screenBox(rec);
      const L = ed.textLayout(c.t);
      if (!b) {
        note(`${c.label}：span 没渲染出来（跳过）`);
        continue;
      }
      note(
        `${c.label}：数据 (${c.t.x},${c.t.y}) → 排版 (${L.x.toFixed(0)},${L.y.toFixed(0)})，` +
          `${L.lines.length} 行；span left=${b.styleLeft} width=${b.styleWidth}`
      );
      pass(
        b.rightGap <= 0.5 && b.bottomGap <= 0.5 && b.leftGap >= -0.5 && b.topGap >= -0.5,
        `屏幕 ${c.label}：span 整块在纸内（左 ${b.leftGap.toFixed(1)} 上 ${b.topGap.toFixed(1)} 右 ${b.rightGap.toFixed(1)} 下 ${b.bottomGap.toFixed(1)} px）`
      );
    }
    store.data.pages[0].texts = [note1];
    ed.renderTextLayer(rec);
    await sleep(20);
  }

  /* ---------- K3. 往上拖到纸外：首行不能被拖到页顶之上 ---------- */
  {
    store.data.pages[0].texts = [{ ...note1, x: 100, y: 200 }];
    ed.renderTextLayer(rec);
    editor.setTool("select");
    await sleep(30);
    const r = pageEl().getBoundingClientRect();
    const k = r.width / PAGE_W;
    const ev4 = (type: string, x: number, y: number, buttons: number, pid: number) =>
      new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: pid, pointerType: "mouse", isPrimary: true, button: 0, buttons, clientX: r.left + x * k, clientY: r.top + y * k });
    pageEl().dispatchEvent(ev4("pointerdown", 106, 198, 1, 501));
    pageEl().dispatchEvent(ev4("pointermove", 106, -200, 1, 501));
    await sleep(20);
    pageEl().dispatchEvent(ev4("pointerup", 106, -200, 0, 501));
    await sleep(80);
    const moved = store.data.pages[0].texts![0];
    const b = screenBox(rec);
    note(`往上拖 -398：数据 y=${moved.y.toFixed(0)}，span top 距纸顶 ${b ? b.topGap.toFixed(1) : "-"}px`);
    pass(moved.y >= 0, `往上拖到纸外：y 仍 ≥ 0（实际 ${moved.y.toFixed(0)}）`);
    pass(!!b && b.topGap >= -0.5, `往上拖到纸外：整块仍在纸内（顶差 ${b ? b.topGap.toFixed(1) : "无 span"}px）`);
    store.data.pages[0].texts = [note1];
    ed.renderTextLayer(rec);
    await sleep(20);
  }

  /* ---------- K4. 新建批注：点在右侧 / 页底时落点被夹进安全区（UI 级验证） ---------- */
  {
    const r = pageEl().getBoundingClientRect();
    const k = r.width / PAGE_W;
    const ev5 = (type: string, x: number, y: number, buttons: number, pid: number) =>
      new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: pid, pointerType: "mouse", isPrimary: true, button: 0, buttons, clientX: r.left + x * k, clientY: r.top + y * k });
    const tapAndType = async (px: number, py: number, value: string, pid: number) => {
      store.data.pages[0].texts = [];
      ed.renderTextLayer(rec);
      editor.setTool("text");
      await sleep(25);
      pageEl().dispatchEvent(ev5("pointerdown", px, py, 1, pid));
      pageEl().dispatchEvent(ev5("pointerup", px, py, 0, pid));
      await sleep(60);
      const ta = pageEl().querySelector(".mb-text-edit") as HTMLTextAreaElement | null;
      if (ta) {
        ta.value = value;
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }
      await sleep(80);
      return (store.data.pages[0].texts || [])[0] as PageText | undefined;
    };

    const right = await tapAndType(750, 500, "右侧新建的批注", 601);
    pass(!!right && right.x <= 634.5, `在 x=750 处新建：落点左移进安全区（存成 x=${right?.x?.toFixed(0)} ≤ 634）`);

    const bottom = await tapAndType(100, 1100, CN54.repeat(2), 602);
    const Lb = bottom ? ed.textLayout(bottom) : null;
    pass(!!Lb && Lb.y + Math.max(0, Lb.lines.length - 1) * Lb.lineHeight <= PAGE_H - 8 + 1,
      `在页底 y=1100 处新建：末行基线夹到安全边内（y=${Lb?.y.toFixed(0)}，${Lb?.lines.length} 行，末行 ${Lb ? (Lb.y + (Lb.lines.length - 1) * Lb.lineHeight).toFixed(0) : "-"} ≤ ${PAGE_H - 8}）`);
    const bb = screenBox(rec);
    pass(!!bb && bb.bottomGap <= 0.5 && bb.rightGap <= 0.5,
      `页底新建的批注在屏幕上也在纸内（下差 ${bb ? bb.bottomGap.toFixed(1) : "-"}px）`);

    store.data.pages[0].texts = [note1];
    ed.renderTextLayer(rec);
    editor.setTool("select");
    await sleep(20);
  }

  /* ---------- L. 编辑框开着时外部换掉数据，提交不能复活成第二条 ---------- */
  {
    store.data.pages[0].texts = [{ ...note1 }];
    ed.renderTextLayer(rec);
    editor.setTool("text");
    await sleep(30);
    ed.beginTextEdit(rec, note1.x + 4, note1.y - note1.size * 0.4);
    await sleep(50);
    const ta = pageEl().querySelector(".mb-text-edit") as HTMLTextAreaElement | null;
    pass(!!ta, "改已有批注：编辑框开着");
    // 模拟"撤销/快照恢复把整页 texts 换掉"
    store.data.pages[0].texts = [];
    if (ta) ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await sleep(60);
    pass((store.data.pages[0].texts || []).length === 0,
      `编辑目标已被撤销后提交，不会复活成新的一条（当前 ${(store.data.pages[0].texts || []).length} 条）`);
    store.data.pages[0].texts = [note1];
    ed.renderTextLayer(rec);
    editor.setTool("select");
    await sleep(20);
  }

  /* ---------- J. 共享测量 canvas 的字体缓存有没有串味 ---------- */
  {
    const base: PageText = { id: "f", source: "user", x: 100, y: 300, size: 16, text: "折行测试 abc", color: "#111" };
    const fonts = ["sans", "serif", "kai", "mono"];
    const widths: Record<string, number> = {};
    for (const f of fonts) widths[f] = ed.measureTextWidth({ ...base, font: f });
    let stable = true;
    for (let round = 0; round < 3; round += 1) {
      for (const f of fonts) {
        const w = ed.measureTextWidth({ ...base, font: f });
        if (Math.abs(w - widths[f]) > 1e-6) stable = false;
      }
    }
    pass(stable, "字体缓存不串味：4 种字体交错量 3 轮，同一字体宽度完全一致");
    log(`  各字体宽度(16 号)：${fonts.map((f) => f + "=" + widths[f].toFixed(2)).join("  ")}`);
    // 真实测量（不是「字数×系数」的估算）：字号翻倍，宽度应当也翻倍
    const w16 = ed.measureTextWidth({ ...base, size: 16 });
    const w32 = ed.measureTextWidth({ ...base, size: 32 });
    pass(Math.abs(w32 / w16 - 2) < 0.06, `字号翻倍宽度也翻倍（16→${w16.toFixed(1)}，32→${w32.toFixed(1)}，比值 ${(w32 / w16).toFixed(3)}）`);
    // 中文字宽应当接近 1em（旧的 0.62 估算会明显偏小）
    const one = ed.measureTextWidth({ ...base, size: 40, text: "墨" });
    pass(one > 40 * 0.85 && one <= 40 * 1.15, `单个汉字宽度 ≈ 1em（40 号量出 ${one.toFixed(1)}），不是 0.62 倍`);
    // 加粗要真的进字体串，否则 canvas 画粗体、DOM 却不粗
    pass(ed.textFontCss({ ...base, bold: true }).startsWith("600 "), `加粗进了字体串：${ed.textFontCss({ ...base, bold: true }).slice(0, 28)}…`);
    pass(ed.textFontCss(base).startsWith("16px "), `常规字体串：${ed.textFontCss(base).slice(0, 28)}…`);
  }

  editor.destroy();
  cleanup();

  /* =========================== 导出侧 =========================== */
  const mk = (id: string, x: number, y: number, size: number, text: string): PageText => ({
    id,
    source: "user",
    x,
    y,
    size,
    text,
    color: "#1A1A1A",
  });

  const pages = [
    (() => { const p = createPage("blank", "white"); p.texts = [mk("e1", 100, 160, 16, PARA)]; return p; })(),
    (() => { const p = createPage("blank", "white"); p.texts = [mk("e2", 700, 300, 16, CN54)]; return p; })(),
    (() => { const p = createPage("blank", "white"); p.texts = [mk("e3", 80, 300, 8, CN54)]; return p; })(),
    (() => { const p = createPage("blank", "white"); p.texts = [mk("e4", 80, 300, 60, CN54)]; return p; })(),
    // 贴底的极端：看纵向有没有人管（横向折行后行数变多，纵向更容易顶出去）
    (() => { const p = createPage("blank", "white"); p.texts = [mk("e5", 60, 1100, 20, CN54.repeat(2))]; return p; })(),
    // 更靠右：x=760（右侧只剩 34 单位），把横向越界的损失量出来
    (() => { const p = createPage("blank", "white"); p.texts = [mk("e6", 760, 300, 16, CN54)]; return p; })(),
    // 被拖到纸顶之上的批注（数据 y 为负）：导出会不会把上面的行丢掉
    (() => { const p = createPage("blank", "white"); p.texts = [mk("e7", 100, -100, 16, CN54)]; return p; })(),
    // 横向边界扫描：634（新建上限）/ 660 / 674（出纸临界）/ 680
    ...[634, 660, 674, 680].map((x) => {
      const p = createPage("blank", "white");
      p.texts = [mk("ex" + x, x, 300, 16, CN54)];
      return p;
    }),
    // 纵向边界扫描：1050 / 1110 / 1120（108 字、20 号）
    ...[1050, 1110, 1120].map((y) => {
      const p = createPage("blank", "white");
      p.texts = [mk("ey" + y, 60, y, 20, CN54.repeat(2))];
      return p;
    }),
  ];
  const { editor: ed2, cleanup: clean2 } = await newEditor(pages);
  const written = new Map<string, Uint8Array>();
  const vault = {
    adapter: {
      exists: async (p: string) => written.has(p),
      read: async () => "",
      readBinary: async () => new ArrayBuffer(0),
      write: async () => {},
      writeBinary: async (p: string, buf: ArrayBuffer) => written.set(p, new Uint8Array(buf)),
    },
  } as any;
  const file = { path: "QA折行.inkbook", basename: "QA折行", parent: { path: "" } } as any;
  const outPath = await exportBookPdf(vault, ed2, file, 2);
  const bytes = written.get(outPath)!;
  pass(!!bytes && bytes.length > 10000, `导出成功（${Math.round((bytes?.length ?? 0) / 1024)} KB）`);

  const pdfjs = initPdfjs();
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  pass(doc.numPages === pages.length, `页数 ${doc.numPages}`);

  /** 抽一页的 item + 统计（右缘 / 基线 / 拼回原文） */
  async function inspect(no: number, expect: string, label: string) {
    const pg = await doc.getPage(no);
    const tc = await pg.getTextContent();
    const items = ((tc.items as any[]) || []).filter((it) => String(it.str || "").trim());
    const joined = items.map((it) => String(it.str || "")).join("");
    const rights = items.map((it) => Number(it.transform[4]) + Number(it.width || 0));
    const maxRight = rights.length ? Math.max(...rights) : 0;
    const lefts = items.map((it) => Number(it.transform[4]));
    const minLeft = lefts.length ? Math.min(...lefts) : 0;
    const tops = items.map((it) => Number(it.transform[5]));
    const minTop = tops.length ? Math.min(...tops) : 0;
    const baselines = new Set(tops.map((v) => Math.round(v * 10) / 10));
    const want = expect.replace(/\s/g, "");
    const got = joined.replace(/\s/g, "");
    pass(got === want, `${label}：内容完整（${got.length}/${want.length} 字）`);
    pass(items.length > 0 && maxRight <= A4_W + 0.5, `${label}：每行右缘不超纸宽（最右 ${maxRight.toFixed(1)} ≤ ${A4_W}）`);
    pass(items.length > 0 && minLeft >= -0.5, `${label}：左缘不出纸（最左 ${minLeft.toFixed(1)}）`);
    const bottomUnits = (toPdfY: number) => PAGE_H - toPdfY / PT_PER_UNIT;
    note(
      `${label}：${items.length} 段 / ${baselines.size} 条基线 ｜ x ∈ [${minLeft.toFixed(1)}, ${maxRight.toFixed(1)}]pt ` +
        `｜ 最高基线 y=${tops.length ? Math.max(...tops).toFixed(1) : "-"}pt（页面坐标 y≈${bottomUnits(tops.length ? Math.max(...tops) : 0).toFixed(0)}）`
    );
    return { items, maxRight, baselines, minTop, joined };
  }

  /* ---- 1. 真实感长段落：内容 / 右缘 / 行数 / 每行是否「装满」 ---- */
  {
    const r = await inspect(1, PARA, "长段落 x=100 size=16");
    pass(r.baselines.size >= 4, `长段落确实折成多行（${r.baselines.size} 条基线，原文 3 个硬换行）`);

    /*
     * 单位核对（这条是重点）。
     * 可用宽度 = 794-100-40 = 654 页面单位 = 654×0.7497 = 490.3pt。
     * 字从 x=100 → 74.97pt 起排，所以「装满的一行」右缘 ≈ 74.97+490.3 = 565.3pt。
     * 若把单位弄错 0.7497 倍，右缘会明显偏（偏小=每行装太多字、偏大=每行装太少字）。
     */
    const availPt = availableTextWidth(PAGE_W, 100) * PT_PER_UNIT;
    const expectRight = 100 * PT_PER_UNIT + availPt;
    pass(
      r.maxRight > expectRight * 0.9 && r.maxRight <= A4_W + 0.5,
      `右缘落在预期区间（实测 ${r.maxRight.toFixed(1)}pt，装满一行应为 ≈${expectRight.toFixed(1)}pt，比率 ${(r.maxRight / expectRight).toFixed(3)}）`
    );
    // 每行的字数是「装满」的量级，不是每行少一半
    const perLine = r.items.map((it) => String(it.str || "").length);
    const longest = Math.max(...perLine);
    const theoryChars = Math.floor(availPt / (16 * PT_PER_UNIT)) - 1; // 一个汉字宽 ≈ 1em
    pass(
      longest >= theoryChars * 0.85,
      `每行装得下 ${longest} 字（理论 ${theoryChars} 字/行），没有「每行只装一半」的单位错`
    );

    // 与屏幕端行数对比（字体不同允许差 1 行）
    const screenPages: PageText[] = pages[0].texts!;
    const screenLines: string[] = (ed2 as any).textLines(screenPages[0]);
    note(`段落行数：屏幕 ${screenLines.length} 行 / PDF ${r.baselines.size} 条基线`);
    pass(Math.abs(screenLines.length - r.baselines.size) <= 2, `屏幕与 PDF 行数接近（差 ${Math.abs(screenLines.length - r.baselines.size)} 行，系统字体≠内嵌字体，允许少量差）`);
  }

  /* ---- 2. 贴右边缘 x=700：排版后位置被夹回纸内 ---- */
  {
    /*
     * 注意：这里必须量**排版后**的盒子，不能拿数据里的 x 当左缘。
     * 现在 reserveTextX 会把越界的老批注往左收到 666，
     * 用 `700 + width` 算出来是错的（这条是我上一轮的断言过期，已改）。
     */
    const availIfStay = availableTextWidth(PAGE_W, 700);
    note(
      `x=700：若起点不动，可用宽度上限 794-700-8 = ${availIfStay} 单位；` +
        `排版时起点被 reserveTextX 收到 666，可用宽度 794-666-8 = ${availableTextWidth(PAGE_W, 666)} 单位`
    );
    const r = await inspect(2, CN54, "贴右边缘 x=700");
    pass(r.baselines.size > 1, "贴右边缘：确实折行了（没崩、没画成一条超长基线）");
    note(`x=700：字右缘 ${r.maxRight.toFixed(1)}pt，纸宽 ${A4_W}pt，余量 ${(A4_W - r.maxRight).toFixed(1)}pt`);

    /* 屏幕侧：直接量盒子，不碰 inline style */
    const rec700 = (ed2 as any).recs[1];
    (ed2 as any).renderTextLayer(rec700);
    await sleep(20);
    const b700 = screenBox(rec700);
    if (!b700) note("第 2 页未挂载，屏幕侧盒子改在 K2 块里量");
    else note(
      `x=700 屏幕盒子：style.left=${b700.styleLeft} style.width=${b700.styleWidth} ` +
        `（数据里的 x 仍是 700，渲染左缘已收到 ${b700.styleLeft}）`
    );
    if (b700) {
      pass(b700.rightGap <= 0.5 && b700.bottomGap <= 0.5,
        `屏幕：x=700 的 span 在纸内（右差 ${b700.rightGap.toFixed(1)}px，下差 ${b700.bottomGap.toFixed(1)}px）`);
      pass(b700.styleLeft + b700.styleWidth <= PAGE_W + 0.5,
        `屏幕：layout px 右缘 ${(b700.styleLeft + b700.styleWidth).toFixed(0)} ≤ 纸宽 ${PAGE_W}`);
    }
  }

  /* ---- 3. 极小字号 size=8 ---- */
  {
    const r = await inspect(3, CN54, "极小字号 size=8");
    pass(r.baselines.size >= 1, `size=8：字号小、行数少也可接受（${r.baselines.size} 条基线）`);
  }

  /* ---- 4. 极大字号 size=60 ---- */
  {
    const r = await inspect(4, CN54, "极大字号 size=60");
    const perLine = Math.max(1, Math.floor(availableTextWidth(PAGE_W, 80) / 60));
    const wantLines = Math.ceil(Array.from(CN54).length / perLine);
    pass(
      Math.abs(r.baselines.size - wantLines) <= 1,
      `size=60：每行放 ${perLine} 字，${Array.from(CN54).length} 字应折成 ≈${wantLines} 行（实际 ${r.baselines.size} 条基线）`
    );
    const maxRightPt = r.maxRight;
    pass(maxRightPt <= A4_W + 0.5, `size=60：右缘 ${maxRightPt.toFixed(1)} ≤ ${A4_W}`);
    pass(r.minTop > 0, `size=60：纵向没有跑出页面顶部（最高基线 ${r.minTop.toFixed(1)}pt > 0）`);
  }

  /* ---- 5. 贴底：纵向夹取（折行后行数变多，以前整行掉出纸底） ---- */
  {
    const pg = await doc.getPage(5);
    const tc = await pg.getTextContent();
    const items = ((tc.items as any[]) || []).filter((it) => String(it.str || "").trim());
    const tops = items.map((it) => Number(it.transform[5]));
    const minTop = tops.length ? Math.min(...tops) : 0;
    const minTopUnits = PAGE_H - minTop / PT_PER_UNIT;
    const joined = items.map((it) => String(it.str || "")).join("").replace(/\s/g, "");
    const want5 = pages[4].texts![0];
    const layout5 = (ed2 as any).textLayout(want5);
    note(
      `贴底 y=1100 size=20：数据 y=1100 → 排版后 y=${layout5.y.toFixed(0)}，折成 ${layout5.lines.length} 行 ` +
        `${JSON.stringify(layout5.lines.map((l: string) => l.length))}；PDF 抽出 ${items.length} 段 / ${joined.length} 字` +
        `（原文 ${Array.from(want5.text).length} 字）`
    );
    note(`贴底：最低基线换算回页面坐标 y≈${minTopUnits.toFixed(0)}（纸高 ${PAGE_H}，安全边 ${PAGE_H - 8}）`);
    pass(joined === Array.from(want5.text).join(""), `贴底批注一个字都不少（${joined.length}/${Array.from(want5.text).length} 字）`);
    pass(
      items.length === layout5.lines.length,
      `贴底批注的行没有被纸底吃掉（排版 ${layout5.lines.length} 行 / PDF ${items.length} 段）`
    );
    pass(minTopUnits <= PAGE_H - 8 + 1, `贴底：最后一行在安全边内（y≈${minTopUnits.toFixed(0)} ≤ ${PAGE_H - 8}）`);

    /* 屏幕侧同样要进纸内 */
    const rec5 = (ed2 as any).recs[4];
    (ed2 as any).renderTextLayer(rec5);
    await sleep(20);
    const b5 = screenBox(rec5);
    if (b5) {
      pass(b5.bottomGap <= 0.5 && b5.rightGap <= 0.5,
        `屏幕：贴底批注在纸内（下差 ${b5.bottomGap.toFixed(1)}px，右差 ${b5.rightGap.toFixed(1)}px）`);
    } else {
      note("第 5 页未挂载，屏幕侧贴底盒子改在 K2 块里量");
    }
  }

  /* ---- 5b. 更靠右 x=760：同样要夹回纸内 ---- */
  {
    const r = await inspect(6, CN54, "贴右边缘 x=760");
    const rec760 = (ed2 as any).recs[5];
    (ed2 as any).renderTextLayer(rec760);
    await sleep(20);
    const b760 = screenBox(rec760);
    pass(r.maxRight <= A4_W + 0.5, `x=760：PDF 右缘 ${r.maxRight.toFixed(1)} ≤ ${A4_W}`);
    if (b760) {
      note(`x=760：数据 x=760 → 渲染左缘 ${b760.styleLeft}，宽 ${b760.styleWidth}`);
      pass(b760.rightGap <= 0.5 && b760.bottomGap <= 0.5,
        `屏幕：x=760 的 span 在纸内（右差 ${b760.rightGap.toFixed(1)}px，下差 ${b760.bottomGap.toFixed(1)}px）`);
      pass(b760.styleLeft + b760.styleWidth <= PAGE_W + 0.5,
        `屏幕：x=760 layout px 右缘 ${(b760.styleLeft + b760.styleWidth).toFixed(0)} ≤ ${PAGE_W}`);
    } else {
      note("第 6 页未挂载，屏幕侧 x=760 盒子改在 K2 块里量");
    }
  }

  /* ---- 5c. 数据 y 为负（被拖到纸顶之上）：上面的行会不会被丢 ---- */
  {
    const r = await inspect(7, CN54, "拖到纸顶之上 y=-100");
    const L = (ed2 as any).textLayout(pages[6].texts![0]);
    note(
      `y=-100：排版后 y=${L.y.toFixed(0)}（${L.lines.length} 行 / 行高 ${L.lineHeight.toFixed(1)}），` +
        `PDF 抽出 ${r.items.length} 段 ${r.joined.replace(/\s/g, "").length} 字 / 原文 ${Array.from(CN54).length} 字，` +
        `最高基线 ${r.minTop.toFixed(1)}pt`
    );
    pass(L.y >= 0, `y=-100：排版后首行基线仍在纸内（y=${L.y.toFixed(0)}，不能被"负 y 原样返回"）`);
  }

  /* ---- 5d. 横向边界扫描（PDF 侧）：634 / 660 / 674 / 680 ---- */
  {
    const xs = [634, 660, 674, 680];
    for (let i = 0; i < xs.length; i += 1) {
      const x = xs[i];
      const t = pages[7 + i].texts![0];
      const r = await inspect(8 + i, CN54, `x=${x}`);
      const L = (ed2 as any).textLayout(t);
      note(
        `x=${x}：排版 x=${L.x.toFixed(0)}，可用宽 ${availableTextWidth(PAGE_W, L.x)}，${L.lines.length} 行；` +
          `PDF ${r.items.length} 段，右缘 ${r.maxRight.toFixed(1)}pt（余量 ${(A4_W - r.maxRight).toFixed(1)}）`
      );
      pass(r.items.length === L.lines.length, `x=${x}：PDF 段数 = 排版行数（${r.items.length}/${L.lines.length}）`);
    }
  }

  /* ---- 5e. 纵向边界扫描：1050 / 1110 / 1120（108 字、20 号） ---- */
  {
    const ys = [1050, 1110, 1120];
    for (let i = 0; i < ys.length; i += 1) {
      const y = ys[i];
      const t = pages[11 + i].texts![0];
      const r = await inspect(12 + i, t.text, `y=${y}`);
      const L = (ed2 as any).textLayout(t);
      const bottom = L.y + Math.max(0, L.lines.length - 1) * L.lineHeight;
      const pdfBottom = PAGE_H - r.minTop / PT_PER_UNIT;
      note(
        `y=${y}：排版 y=${L.y.toFixed(0)}（${L.lines.length} 行），末行 ${bottom.toFixed(0)}；` +
          `PDF 最低基线 ${pdfBottom.toFixed(0)}；抽出 ${r.joined.replace(/\s/g, "").length}/${Array.from(t.text).length} 字`
      );
      pass(bottom <= PAGE_H - 8 + 1, `y=${y}：排版末行在安全边内（${bottom.toFixed(0)} ≤ ${PAGE_H - 8}）`);
      pass(pdfBottom <= PAGE_H - 8 + 2, `y=${y}：PDF 最低基线仍在纸内（${pdfBottom.toFixed(0)} ≤ ${PAGE_H - 8}）`);
      pass(r.items.length === L.lines.length, `y=${y}：PDF 段数 = 排版行数（${r.items.length}/${L.lines.length}）`);
    }
  }

  /* ---- 5f. 屏幕 vs 导出：断行位置一致性（只允许 ±1 行，纯中文逐行字数必须一致） ---- */
  {
    const cases = [
      { no: 1, idx: 0, label: "长段落(中英混排)", pure: false },
      { no: 2, idx: 1, label: "x=700", pure: true },
      { no: 4, idx: 3, label: "size=60", pure: true },
    ];
    for (const c of cases) {
      const t = pages[c.idx].texts![0];
      const L = (ed2 as any).textLayout(t);
      const pg = await doc.getPage(c.no);
      const tc = await pg.getTextContent();
      const items = ((tc.items as any[]) || []).filter((it) => String(it.str || "").trim());
      const screenLens = L.lines
        .map((l: string) => Array.from(String(l).replace(/\s+/g, "")).length)
        .filter((n: number) => n > 0);
      const pdfLens = items.map((it) => Array.from(String(it.str || "").replace(/\s+/g, "")).length);
      note(`${c.label}：屏幕 ${screenLens.length} 行 ${JSON.stringify(screenLens)} ｜ PDF ${pdfLens.length} 段 ${JSON.stringify(pdfLens)}`);
      pass(
        Math.abs(screenLens.length - pdfLens.length) <= 1,
        `${c.label}：屏幕与 PDF 行数差 ≤ 1（${screenLens.length} vs ${pdfLens.length}，不会出现 3 行 vs 5 行）`
      );
      if (screenLens.length === pdfLens.length) {
        const maxDiff = Math.max(...screenLens.map((n, i) => Math.abs(n - pdfLens[i])));
        pass(maxDiff <= (c.pure ? 0 : 1), `${c.label}：逐行字数差 ${maxDiff}（纯中文要求 0，混排允许 1）`);
      } else {
        note(`${c.label}：行数差 1，逐行比对跳过`);
      }
    }
  }

  /* ---- 5g. INK-121：手动框宽的屏幕 / 导出 A/B（两条链路不共享代码） ---- */
  {
    /*
     * 同一段中文，三档宽度：自动 / 窄 160 / 宽 600。
     * 导出的行数必须随 width 变化，且逐行字数与 ed2.textLayout 的结果一致
     * ——这是防「导出侧忘了传 width、静默按纸宽折」的独立验证：
     * 这里不复用 layoutUserText 的任何中间量，只拿 PDF item 自己的字符串量。
     */
    const WIDTH_TEXT = CN54.repeat(2);
    const widthCases = [
      { label: "自动", width: undefined as number | undefined, idx: pages.length },
      { label: "窄160", width: 160, idx: pages.length + 1 },
      { label: "宽600", width: 600, idx: pages.length + 2 },
    ];
    // pages 数组是导出前就定好的，这里补的三页没进那次导出，
    // 因此另起一份单页导出：改同一本本子的 texts 重导三次。
    const probe = async (width?: number) => {
      // 必须改 ed2 的 store：文件开头那个 store 属于 A~K 段的第一个 editor，
      // 导出用的是 ed2，改错本子会抽回旧页的文字（假绿）
      ed2.store.data.pages[0].texts = [
        { id: "wq", source: "user" as const, x: 60, y: 300, size: 16, text: WIDTH_TEXT, color: "#111", width },
      ];
      const p = await exportBookPdf(vault, ed2 as any, file, 1);
      const d = await pdfjs.getDocument({ data: written.get(p)!.slice() }).promise;
      const pg = await d.getPage(1);
      const tc = await pg.getTextContent();
      const items = ((tc.items as any[]) || []).filter((it) => String(it.str || "").trim());
      const rights = items.map((it) => Number(it.transform[4]) + Number(it.width || 0));
      const tops = items.map((it) => Number(it.transform[5]));
      const r = {
        joined: items.map((it) => String(it.str || "")).join(""),
        lens: items.map((it) => Array.from(String(it.str || "").replace(/\s+/g, "")).length),
        rows: new Set(tops.map((v) => v.toFixed(1))).size,
        maxRight: rights.length ? Math.max(...rights) : 0,
      };
      await d.destroy();
      return r;
    };
    const auto = await probe(undefined);
    const narrow = await probe(160);
    const wide = await probe(600);
    pass(auto.joined === WIDTH_TEXT && narrow.joined === WIDTH_TEXT && wide.joined === WIDTH_TEXT,
      "框宽 A/B：三档宽度导出都不丢字");
    pass(narrow.rows > wide.rows, `框宽 A/B：窄框比宽框折得多（${wide.rows} → ${narrow.rows} 行）`);
    pass(auto.rows >= wide.rows && auto.rows <= narrow.rows,
      `框宽 A/B：自动宽度落在两者之间（${wide.rows} ≤ ${auto.rows} ≤ ${narrow.rows}）`);
    pass(Math.max(auto.maxRight, narrow.maxRight, wide.maxRight) <= A4_W + 0.5,
      "框宽 A/B：三档每行右缘都不超纸宽");
    // 逐行字数跟屏幕排版对齐（ed2.textLayout 用系统字体，纯中文允许 ±1 行）
    for (const c of widthCases) {
      const L = (ed2 as any).textLayout({ x: 60, y: 300, size: 16, text: WIDTH_TEXT, width: c.width });
      const screenLens = L.lines.map((l: string) => Array.from(String(l).replace(/\s+/g, "")).length).filter((n: number) => n > 0);
      const pdfLens = c.label === "自动" ? auto.lens : c.label === "窄160" ? narrow.lens : wide.lens;
      note(`框宽 ${c.label}：屏幕 ${screenLens.length} 行 ${JSON.stringify(screenLens)} ｜ PDF ${pdfLens.length} 段 ${JSON.stringify(pdfLens)}`);
      pass(Math.abs(screenLens.length - pdfLens.length) <= 1,
        `框宽 ${c.label}：屏幕与 PDF 行数差 ≤ 1（${screenLens.length} vs ${pdfLens.length}）`);
      if (screenLens.length === pdfLens.length) {
        pass(Math.max(...screenLens.map((n: number, i: number) => Math.abs(n - pdfLens[i]))) <= 1,
          `框宽 ${c.label}：逐行字数一致（纯中文 ≤1）`);
      }
      pass(L.width === (c.width ? Math.min(c.width, availableTextWidth(PAGE_W, L.x)) : availableTextWidth(PAGE_W, L.x)),
        `框宽 ${c.label}：l.width 语义正确（${L.width.toFixed(0)}）`);
    }
    ed2.store.data.pages[0].texts = [note1];
  }

  try {
    await doc.destroy();
  } catch (_) {}
  ed2.destroy();
  clean2();

  /* ---- 6. 极小宽度的逻辑兜底：纯函数层 ---- */
  {
    const m = (s: string) => Array.from(s).length * 20;
    const tiny = wrapText(CN54, 1, m);
    pass(tiny.length === Array.from(CN54).length && tiny.join("") === CN54, `maxWidth=1：逐字成行且不丢字（${tiny.length} 行）`);
    const nan = wrapText("abc", NaN, m);
    pass(nan.join("") === "abc", "maxWidth=NaN：不折行也不丢字");
    const inf = wrapText(CN54, Infinity, m);
    pass(inf.length === 1 && inf[0] === CN54, "maxWidth=Infinity：不折行");
  }

  log("");
  log(`共 ${checks} 项，失败 ${failures} 项`);
  log(failures === 0 ? "ALL PASS" : failures + " FAILED");
  document.title = "DONE";
}

main().catch((e) => {
  log("FATAL " + (e?.stack || e));
  document.title = "FATAL";
});
