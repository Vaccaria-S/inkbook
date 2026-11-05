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
import { exportBookPdf, pageHasUserText } from "../src/export";
import { chineseFontBytes } from "../src/fontasset";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";
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
  /*
   * 第 4 页：一段**比纸还宽**的长批注。
   *
   * 用户原话是「我自己打的那个字，导出到 PDF 之后，那段字并不完整」——
   * 不折行的实现会把整句排在一条基线上，超出 /MediaBox 的部分阅读器直接
   * 不显示，抽回来的文字就少了一截。这一页专门盯这个回归。
   * 60 个常用汉字（不碰生僻字/emoji，否则这页会按设计退回位图）。
   */
  const LONG_TEXT =
    "这一段批注故意写得比纸还长，用来验证导出时会按纸宽自动折行，而不是被页面右边界裁掉，那样内容就不完整了，用户会以为字丢了";
  const p4 = createPage("blank", "white");
  p4.texts = [
    {
      id: "t4",
      source: "user",
      x: 100,
      y: 400,
      size: 20,
      text: LONG_TEXT,
      color: "#1A1A1A",
    },
  ];
  book.pages.push(p4);

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
  pass(doc.numPages === 4, "导出的 PDF 有 " + doc.numPages + " 页");

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
   * INK-118 的结构护栏：**绝不能对已手工子集化的 TTF 再做二次子集化**。
   *
   * 旧断言是「导出件 < 400KB」，盯着的是 subset:true 的体积收益。但正是
   * subset:true 让 fontkit 重新拼 glyf，short loca 的 `offset >>> 1` 把奇数长度
   * 字形之后的边界吞掉 1 字节，一半 CID 解码成垃圾 → 用户真机「4 个字只显示 2 个」。
   * ToUnicode CMap 不受影响，所以只验抽字的话全绿也抓不到（详见 pdftext-harness.ts）。
   *
   * 现在改成直接检查导出件里嵌的字体程序：必须是构建期那份**完整**手工子集字体
   * （1.85MB、head.indexToLocFormat=1 即 long loca）。二次子集化出来的字体只有几 KB、
   * indexToLocFormat=0（short loca），一眼就能分辨。体积上限放宽到 2MB，
   * 既容纳完整字体，也仍能挡住「把好几份字体重复塞进去」这类回归。
   */
  {
    const reload = await PDFDocument.load(bytes!);
    const fonts = reload.getPages()[1].node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
    let program: Uint8Array | null = null;
    if (fonts) {
      for (const key of fonts.keys()) {
        const fd = fonts.lookup(key, PDFDict);
        const descendants = fd.lookupMaybe(PDFName.of("DescendantFonts"), PDFArray);
        const cid = descendants?.lookup(0, PDFDict);
        const desc = cid?.lookupMaybe(PDFName.of("FontDescriptor"), PDFDict);
        const file = desc?.lookupMaybe(PDFName.of("FontFile2"), PDFRawStream);
        if (file) {
          program = decodePDFRawStream(file).decode();
          break;
        }
      }
    }
    pass(!!program, "导出件里能取到嵌入的中文 TTF 字体程序");
    if (program) {
      const view = new DataView(program.buffer, program.byteOffset, program.byteLength);
      const tableCount = view.getUint16(4, false);
      let headOff = -1;
      for (let i = 0; i < tableCount; i += 1) {
        const off = 12 + i * 16;
        const tag = String.fromCharCode(
          program[off], program[off + 1], program[off + 2], program[off + 3]
        );
        if (tag === "head") headOff = view.getUint32(off + 8, false);
      }
      const locaFormat = headOff >= 0 ? view.getInt16(headOff + 50, false) : -1;
      pass(
        program.length > 1024 * 1024,
        "嵌的是完整手工子集字体（" + Math.round(program.length / 1024) + " KB），不是二次裁剪的碎片"
      );
      pass(
        locaFormat === 1,
        "字体用 long loca（indexToLocFormat=" + locaFormat + "），不会因为 odd glyf 截断边界"
      );
    }
  }
  pass(
    bytes!.length < 2 * 1024 * 1024,
    "导出件体积 " + Math.round(bytes!.length / 1024) + " KB（完整字体只嵌一次，不重复塞包）"
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

  /*
   * 第 4 页：长批注必须**按纸宽折行**，一个字都不能少、一行都不能出纸。
   *
   * 三条断言是同一个 bug 的三面：
   *   1. 拼起来等于原文 → 没被页边界裁掉（裁掉就少字）；
   *   2. 每个 item 右缘 ≤ 页宽 → 折行后每行都在纸内；
   *   3. 基线不止一条 → 真的折了行，而不是硬画一条超长基线。
   * 比较前先去掉所有空白：pdf.js 在两条指令间距较大时会自己插空格，
   * 那是它为了"复制出来像人话"，不是我们少画了字。
   */
  {
    const page4 = await doc.getPage(4);
    const tc4 = await page4.getTextContent();
    const items4 = ((tc4.items as any[]) || []).filter((it) => String(it.str || "").trim());
    const joined4 = items4.map((it) => String(it.str || "")).join("");
    const PAGE_W = 595.28;

    pass(
      joined4.replace(/\s+/g, "") === LONG_TEXT,
      "长批注导出后一个字都不少（" + joined4.replace(/\s+/g, "").length + " / " + LONG_TEXT.length + " 字）"
    );

    const right = items4.map((it) => Number(it.transform[4]) + Number(it.width || 0));
    const maxRight = right.length ? Math.max(...right) : 0;
    pass(
      items4.length > 0 && maxRight <= PAGE_W + 0.5,
      "长批注每行都在纸内（最右缘 " + maxRight.toFixed(1) + " ≤ " + PAGE_W + "）"
    );

    const baselines = new Set(items4.map((it) => Math.round(Number(it.transform[5]) * 10) / 10));
    pass(
      items4.length > 1 && baselines.size > 1,
      "长批注被折成多行（" + items4.length + " 段 / " + baselines.size + " 条基线）"
    );
  }

  try {
    await doc.destroy();
  } catch (_) {}

  editor.destroy();
  cleanup();

  /*
   * 反向护栏：**没有批注的本子不该多背一份字体**。
   * 字体是 1.85MB（INK-118 后整份嵌入，不再二次裁剪），纯手写本更没理由为它胖一圈。
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

  /*
   * 越界扫描：横向贴右缘、纵向贴页底，一个字都不能丢。
   *
   * 上一版只夹住了"每行多宽"，没夹"起点多靠右 / 整段多靠下"：
   *   · x=700 时"至少 120 宽"把每行右端推到 820 > 794，被页边界裁掉；
   *   · y=1100 时折出的下面几行整行落到 /MediaBox 之外，阅读器不显示。
   * 两个都是同一个用户症状"我自己打的那段字不完整"。
   *
   * 每一档都用**同一本单页本子**改文字后重新导出：一是省掉重复挂载，
   * 二是每档只有一段批注，抽回来的字数可以直接跟原文逐字比。
   */
  {
    const scanBook = createBook("越界扫描", "blank", "white");
    scanBook.pages = [createPage("blank", "white")];
    const scanStore = new BookStore(scanBook);
    const [scanHost, scanCleanup] = makeHost();
    const scanEd = new BookEditor(scanHost, scanStore, { app, smoothing: 0.5 });
    await sleep(300);
    const scanFile = { path: "越界扫描.inkbook", basename: "越界扫描", parent: { path: "" } } as any;

    /** 导出这一页、抽回文字，返回"正文 / 段数 / 基线数 / 最右缘 / 基线范围" */
    const probe = async (t: { x: number; y: number; size: number; text: string; width?: number }) => {
      scanStore.data.pages[0].texts = [{ id: "scan", source: "user", color: "#1A1A1A", ...t }];
      const path = await exportBookPdf(vault, scanEd, scanFile, 1);
      const d = await pdfjs.getDocument({ data: written.get(path)!.slice() }).promise;
      const pg = await d.getPage(1);
      const tc = await pg.getTextContent();
      const items = ((tc.items as any[]) || []).filter((it) => String(it.str || "").trim());
      const joined = items.map((it) => String(it.str || "")).join("").replace(/\s+/g, "");
      const rights = items.map((it) => Number(it.transform[4]) + Number(it.width || 0));
      const baselines = items.map((it) => Number(it.transform[5]));
      await d.destroy();
      return {
        joined,
        n: items.length,
        maxRight: rights.length ? Math.max(...rights) : 0,
        maxBaseline: baselines.length ? Math.max(...baselines) : 0,
        minBaseline: baselines.length ? Math.min(...baselines) : 0,
        rows: new Set(baselines.map((b) => b.toFixed(1))).size,
      };
    };

    // 54 字 / 108 字：够长，旧实现下必然要折行、必然被裁
    const LONG_H = "横向越界扫描用的长句不能让纸边把它裁掉".repeat(3);
    const LONG_V = "纵向越界扫描用的长句不能落到纸张外面去再也看不见".repeat(4);
    const PAGE_W = 595.28;
    const PAGE_H = 841.89;

    for (const x of [634, 660, 674, 680, 700, 760]) {
      const r = await probe({ x, y: 300, size: 16, text: LONG_H });
      pass(
        r.joined === LONG_H,
        "横向边界 x=" + x + "：字数完整（" + r.joined.length + "/" + LONG_H.length + "）"
      );
      pass(
        r.n > 0 && r.maxRight <= PAGE_W + 0.5,
        "横向边界 x=" + x + "：每行都在纸内（最右缘 " + r.maxRight.toFixed(1) + " ≤ " + PAGE_W + "）"
      );
    }

    /*
     * 纵向：贴页底 + 负 y。
     *
     * 负 y 是「往上拖过头」存下来的老数据（上一版拖到 y=-198，整段跑到
     * 纸顶之上）。这是所有丢字形态里最彻底的一种：屏幕被 .mb-page 裁掉、
     * 导出后基线全在 /MediaBox 之外，阅读器一个字节都不显示——所以
     * 除了贴底，还要专门扫一遍负数。
     */
    for (const y of [1050, 1100, 1110, 1120, -100, -198, -1000]) {
      const r = await probe({ x: 60, y, size: 20, text: LONG_V });
      pass(
        r.joined === LONG_V,
        "纵向边界 y=" + y + "：字数完整（" + r.joined.length + "/" + LONG_V.length + "）"
      );
      pass(
        r.rows > 1,
        "纵向边界 y=" + y + "：确实折成多行（" + r.rows + " 条基线）"
      );
      pass(
        r.minBaseline >= -0.5 && r.maxBaseline <= PAGE_H + 0.5,
        "纵向边界 y=" + y + "：所有基线都在页内（" +
          r.minBaseline.toFixed(1) + " ~ " + r.maxBaseline.toFixed(1) + " ⊂ 0~" + PAGE_H + "）"
      );
    }

    /*
     * INK-121：用户手动拖窄的框宽，导出必须跟屏幕吃同一份 width 语义。
     * 关键反证是「导出侧的 layoutUserText 忘了传 width」——那会静默按纸宽折，
     * 屏幕上两行、导出来一行，且这一行还可能被纸右缘裁掉。
     */
    for (const x of [60, 634, 700, 760]) {
      const auto = await probe({ x, y: 300, size: 16, text: LONG_H });
      const narrow = await probe({ x, y: 300, size: 16, text: LONG_H, width: 160 });
      pass(narrow.joined === LONG_H, "框宽导出 x=" + x + "：窄框一个字都不丢（" + narrow.n + " 行）");
      /*
       * 贴右缘时纸面物理余量本来就小于 160，width 被 min(width, avail) 夹成
       * 跟自动宽度一样，行数相同是**正确行为**，不是「忘了传 width」。
       * 只有纸够宽时才要求窄框折得更多。
       */
      const avail = 794 - x - 40;
      if (avail > 160) {
        pass(narrow.rows > auto.rows, "框宽导出 x=" + x + "：窄框比自动宽度折得更多（" + auto.rows + " → " + narrow.rows + "）");
      } else {
        pass(narrow.rows === auto.rows, "框宽导出 x=" + x + "：显式宽度被纸面余量夹住，行数与自动一致（" + auto.rows + " 行）");
      }
      pass(
        narrow.n > 0 && narrow.maxRight <= PAGE_W + 0.5,
        "框宽导出 x=" + x + "：窄框每行都在纸内（最右缘 " + narrow.maxRight.toFixed(1) + " ≤ " + PAGE_W + "）"
      );
    }
    // 显式宽度超过纸面余量时同样要被夹住，不能因为"用户拖得宽"就出纸
    for (const x of [634, 700, 760]) {
      const r = await probe({ x, y: 300, size: 16, text: LONG_H, width: 600 });
      pass(r.joined === LONG_H, "框宽导出 x=" + x + "：超宽被夹后仍不丢字");
      pass(r.maxRight <= PAGE_W + 0.5, "框宽导出 x=" + x + "：超宽被夹后不出纸（" + r.maxRight.toFixed(1) + "）");
    }

    /*
     * 位图/画布这一路（纯手写页的批注是烤进位图的）也得在纸内：
     * 画布跟纸一样大，出了纸就是被裁掉，所以直接查最右边/最下面
     * 那个"非底色"像素。底色取左上角像素——blank 纸只有一层底色。
     */
    scanStore.data.pages[0].texts = [
      { id: "scan", source: "user", x: 700, y: 1100, size: 16, color: "#1A1A1A", text: LONG_H },
    ];
    {
      const cv = scanEd.exportPageCanvas(0, 1);
      const data = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
      const bg = [data[0], data[1], data[2]];
      let maxX = -1;
      let maxY = -1;
      for (let py = 0; py < cv.height; py++) {
        for (let px = 0; px < cv.width; px++) {
          const i = (py * cv.width + px) * 4;
          const diff =
            Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
          if (diff > 60) {
            if (px > maxX) maxX = px;
            if (py > maxY) maxY = py;
          }
        }
      }
      pass(
        maxX >= 0 && maxX <= cv.width - 8,
        "画布：画出来的字不出右边界（最右像素 " + maxX + " ≤ " + (cv.width - 8) + "）"
      );
      pass(
        maxY >= 0 && maxY <= cv.height - 1,
        "画布：画出来的字不出下边界（最下像素 " + maxY + " ≤ " + (cv.height - 1) + "）"
      );
    }

    scanEd.destroy();
    scanCleanup();
  }

  /*
   * INK-118：短批注「隔字缺字」的像素级常驻护栏（export 套件内）。
   *
   * 上面所有「字数完整」断言都只走 getTextContent()（ToUnicode CMap）。
   * 二次子集化把 glyf 边界截断时，抽字依然 100% 完整、视觉上却是一排空格，
   * 所以这里必须再渲染成 canvas，在**每个字自己的矩形**里数深色像素。
   * 用纯中文 4 字：CJK 全角等宽，按 item.width/4 切格就是精确的逐字边界。
   * 完整矩阵（26 个样本 × 两条导出路径）见 pdftext-harness.ts。
   */
  {
    const SHORT = "大承气汤";
    const shortBook = createBook("短批注像素", "blank", "white");
    shortBook.pages = [createPage("blank", "white")];
    shortBook.pages[0].texts = [
      { id: "st", source: "user", x: 80, y: 300, size: 20, text: SHORT, color: "#1A1A1A" },
    ];
    const shortStore = new BookStore(shortBook);
    const [shortHost, shortCleanup] = makeHost();
    const shortEd = new BookEditor(shortHost, shortStore, { app, smoothing: 0.5 });
    await sleep(300);
    const shortPath = await exportBookPdf(
      vault,
      shortEd,
      { path: "短批注像素.inkbook", basename: "短批注像素", parent: { path: "" } } as any,
      1
    );
    const shortBytes = written.get(shortPath)!;
    const shortDoc = await pdfjs.getDocument({ data: shortBytes.slice() }).promise;
    const shortPage = await shortDoc.getPage(1);
    const shortTc = await shortPage.getTextContent();
    const shortItems = ((shortTc.items as any[]) || []).filter((it) => String(it.str || "").trim());
    const shortJoined = shortItems.map((it) => String(it.str || "")).join("").replace(/\s+/g, "");
    pass(shortJoined === SHORT, "短批注：抽回文字完整（" + shortJoined.length + "/" + SHORT.length + " 字）");

    const vp = shortPage.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    await shortPage.render({ canvasContext: ctx, viewport: vp, background: "#ffffff" }).promise;

    const hit = shortItems.find((it) => String(it.str || "").replace(/\s+/g, "") === SHORT);
    let inks: number[] = [];
    if (hit) {
      const tr = hit.transform as number[];
      const x0 = Number(tr[4]);
      const yBase = Number(tr[5]);
      const sizePt = 20 * (595.28 / 794);
      const cellW = Number(hit.width || 0) / SHORT.length;
      inks = Array.from({ length: SHORT.length }, (_, i) => {
        const rect: [number, number, number, number] = [
          x0 + i * cellW,
          yBase - 0.12 * sizePt,
          x0 + (i + 1) * cellW,
          yBase + 0.9 * sizePt,
        ];
        const v = vp.convertToViewportRectangle(rect);
        const rx0 = Math.max(0, Math.floor(Math.min(v[0], v[2])));
        const ry0 = Math.max(0, Math.floor(Math.min(v[1], v[3])));
        const rx1 = Math.min(canvas.width, Math.ceil(Math.max(v[0], v[2])));
        const ry1 = Math.min(canvas.height, Math.ceil(Math.max(v[1], v[3])));
        if (rx1 <= rx0 || ry1 <= ry0) return 0;
        const data = ctx.getImageData(rx0, ry0, rx1 - rx0, ry1 - ry0).data;
        let n = 0;
        for (let k = 0; k < data.length; k += 4) {
          if ((data[k] + data[k + 1] + data[k + 2]) / 3 < 170) n++;
        }
        return n;
      });
    }
    pass(inks.length === SHORT.length, "短批注：找到 " + SHORT.length + " 个逐字取样格");
    pass(
      inks.length === SHORT.length && inks.every((n) => n >= 5),
      "短批注：4 个字每个都有字形像素（逐字墨 [" + inks.join(",") + "]）"
    );
    await shortDoc.destroy();
    shortEd.destroy();
    shortCleanup();
  }

  /*
   * 导出完成后的 Notice 会报「N 页的批注文字可选中」。
   * 以前是无条件按页累加：300 页的本子只有 2 页写了批注也会报 300 页。
   * 这里直接钉判定函数（Notice 的计数只按它来），防止又退回按页数算。
   */
  {
    const pUser = createPage("blank", "white");
    pUser.texts = [
      { id: "u1", source: "user", x: 60, y: 300, size: 16, text: "有字" },
      { id: "p1", source: "pdf", x: 60, y: 340, size: 16, text: "原文" },
    ];
    const pPdfOnly = createPage("blank", "white");
    pPdfOnly.texts = [{ id: "p2", source: "pdf", x: 60, y: 300, size: 16, text: "只有原文" }];
    const pBlank = createPage("blank", "white");
    pBlank.texts = [];
    const pSpaces = createPage("blank", "white");
    pSpaces.texts = [{ id: "u3", source: "user", x: 60, y: 300, size: 16, text: "   \n " }];

    pass(pageHasUserText(pUser), "Notice 计数：有用户批注的页算 1 页");
    pass(!pageHasUserText(pPdfOnly), "Notice 计数：只有 PDF 原文的页不算（原文不是批注）");
    pass(!pageHasUserText(pBlank), "Notice 计数：空 texts 的页不算");
    pass(!pageHasUserText(pSpaces), "Notice 计数：只有空白字符的批注不算");
    pass(!pageHasUserText(undefined), "Notice 计数：缺页数据不抛错、不算");
  }

  log("");
  log(failures === 0 ? "ALL PASS" : failures + " FAILED");
  document.title = "DONE";
}

main().catch((e) => {
  log("FATAL " + (e?.stack || e));
  document.title = "FATAL";
});
