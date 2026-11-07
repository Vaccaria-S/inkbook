import { Notice, type TFile, type Vault } from "obsidian";
import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { BookEditor } from "./editor";
import { chineseCharacterSet, chineseFontBytes } from "./fontasset";
import type { Page, PageText } from "./types";
import { layoutUserText } from "./textwrap";

function safeName(s: string): string {
  return String(s).replace(/[\\/:*?"<>|#^[\]]/g, "_").trim() || "手写本";
}

function canvasBytes(canvas: HTMLCanvasElement): Uint8Array {
  const data = canvas.toDataURL("image/png").split(",")[1] || "";
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 导出被用户取消时抛出：调用方据此提示「已取消」，而不是当成「导出失败」。 */
export class ExportCancelledError extends Error {
  constructor(message = "导出已取消") {
    super(message);
    this.name = "ExportCancelledError";
  }
}

/** 导出进度阶段：page = 逐页渲染；saving = 合并 / 写文件 */
export type ExportPhase = "page" | "saving";

/**
 * 大本导出的可选控制：取消信号 + 进度回调。
 *
 * 不传时保持旧行为（纯导出、无界面）。界面层（view.ts 的 runExport）
 * 传一个 AbortController 和一个常驻 Notice，就能做到「有进度、能取消」。
 */
export interface ExportBookOptions {
  /**
   * 协作式取消信号。每页开始 / 结束、写文件前后都会检查；
   * 取消后不留下任何导出文件（已经写出的 `.tmp` 会被删掉）。
   */
  signal?: AbortSignal;
  /**
   * 进度回调。`done` 是**已完成**的页数（0 = 还没开始第一页），
   * `total` 是本次导出的总页数（指定页范围时就是范围内的页数）。
   */
  onProgress?: (done: number, total: number, phase: ExportPhase) => void;
  /**
   * 用户填的页范围非法（起止颠倒 / 越界 / 非整数）被夹取或回落整本时回调。
   * 界面层据此明确告诉用户「已改为整本」，别静默导完 857 页。
   */
  onRangeAdjusted?: (range: ExportRangeResult) => void;
}

/**
 * 夹取页范围后的结果。`adjusted` 表示与用户输入不一致（界面层要提示）。
 */
export interface ExportRangeResult {
  /** 1 起的闭区间起点 */
  from: number;
  /** 1 起的闭区间终点 */
  to: number;
  /** 总页数 */
  total: number;
  /** 用户输入被夹取 / 回落过 */
  adjusted: boolean;
}

/**
 * 夹取导出页范围：非法一律回落整本。
 *
 * 抽成纯函数是为了界面层（进度 Notice 的文案）和导出主体用**同一把尺子**，
 * 否则「Notice 写第 9–2 页、实际导 1–857 页」这种自相矛盾的提示会一直漂移。
 * 也是为了能在 export-harness.ts 里直接穷举边界，而不是靠肉眼挑几个例子。
 */
export function normalizeExportRange(
  total: number,
  range?: { from: number; to: number } | null
): ExportRangeResult {
  const n = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  if (!range) return { from: 1, to: n, total: n, adjusted: false };
  /*
   * 空本子（total = 0）单独处理：下面那套夹取是 `max(1, min(n, x))`，
   * n=0 时 `min(0, x)` 得 0、再被 `max(1, …)` 顶回 1，于是返回
   * 「第 1–1 页 / 共 0 页」——to 比 total 还大，自相矛盾。
   * 空本子就该是空范围（from=1, to=0），且用户填了范围要报 adjusted。
   */
  if (n === 0) return { from: 1, to: 0, total: 0, adjusted: true };
  const rawFrom = Number(range.from);
  const rawTo = Number(range.to);
  // 填了范围但根本不是数字：当「没填」处理，并明确告诉用户已回落整本
  if (!Number.isFinite(rawFrom) || !Number.isFinite(rawTo)) {
    return { from: 1, to: n, total: n, adjusted: true };
  }
  const a = Math.max(1, Math.min(n, Math.floor(rawFrom)));
  const b = Math.max(1, Math.min(n, Math.floor(rawTo)));
  // 起止颠倒：保持老行为，回落整本（不要猜用户想反着导）
  if (a > b) return { from: 1, to: n, total: n, adjusted: true };
  if (a !== rawFrom || b !== rawTo) return { from: a, to: b, total: n, adjusted: true };
  return { from: a, to: b, total: n, adjusted: false };
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExportCancelledError();
}

/** 尽力删掉临时文件；删不掉也不吭声（带着 .tmp 后缀，不会污染正式产物） */
async function removeQuietly(adapter: Vault["adapter"], path: string): Promise<void> {
  try {
    if (typeof adapter.exists === "function" && !(await adapter.exists(path))) return;
    await adapter.remove(path);
  } catch (_) {
    /* 清理失败无所谓：临时文件带 .tmp 后缀，不影响正式文件 */
  }
}

/**
 * 原子写导出文件：先写 `<目标>.tmp`，成功后再 rename 顶掉目标。
 *
 * 和 storage.ts 的 writeBook 不是一回事：那个是 .inkbook JSON 正文
 * （备份 + integrity 自检），这里是二进制 PDF；但「半截文件不能顶上
 * 正式文件」这条原则一样适用。rename 不可用的老适配器回落直接写。
 *
 * 取消发生在写 .tmp 期间时，删掉 .tmp 再抛 ExportCancelledError——
 * 用户取消后目录里不会多出一个残缺的 .pdf 或 .tmp。
 */
async function writeExportFile(
  vault: Vault,
  path: string,
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<void> {
  throwIfCancelled(signal);
  const adapter = vault.adapter;
  /*
   * 别整份复制字节（2026-11-07 修）。
   *
   * 老写法 `bytes.buffer.slice(offset, offset+len)` 会再分配一份同样大小的
   * ArrayBuffer —— 300 页的导出件几十 MB，峰值内存直接翻倍，平板上容易卡死。
   *
   * 两个来源（`doc.save()` 与 `canvasBytes`）都是**整块新分配**的
   * Uint8Array（offset=0、length=buffer.byteLength），可以直接传 `.buffer`。
   * 只有视图不对齐时才复制（防御，正常走不到）。
   */
  const whole =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  const buffer = (whole ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;

  /*
   * 无论走不走 rename，**先写 `.tmp`**。
   *
   * 老写法在 rename 不可用/失败时直接 `writeBinary(path, buffer)`：写失败
   * （ENOSPC 最常见）会在正式文件名留下一个打不开的半截 PDF；而且取消
   * 检查在 :116 之后就没了，用户点了取消文件照样写出去、还弹「已导出」。
   * 现在所有路径都先落 .tmp、检查取消、再决定 rename 还是复制，失败一律清干净。
   */
  const tmp = path + ".tmp";
  try {
    await adapter.writeBinary(tmp, buffer);
  } catch (e) {
    await removeQuietly(adapter, tmp);
    throw e;
  }
  // 写 .tmp 期间用户点了取消：正式文件一个字节都不写
  if (signal?.aborted) {
    await removeQuietly(adapter, tmp);
    throw new ExportCancelledError();
  }
  if (typeof adapter.rename === "function") {
    try {
      await adapter.rename(tmp, path);
      return;
    } catch (e) {
      // rename 不是所有适配器都可靠；清掉临时文件、确认没被取消后走下面的裸写
      await removeQuietly(adapter, tmp);
      console.warn("[inkbook] 导出文件原子改名失败，改回直接写入", e);
      throwIfCancelled(signal);
    }
  }
  /*
   * 没有 rename（或 rename 失败）：只能直接写正式文件。
   * 写失败必须把半截文件删掉，别让用户看到一个打不开的 PDF。
   */
  throwIfCancelled(signal);
  try {
    await adapter.writeBinary(path, buffer);
  } catch (e) {
    await removeQuietly(adapter, path);
    throw e;
  } finally {
    await removeQuietly(adapter, tmp);
    // 写正式文件期间点了取消：这份文件不该留下，也不该报「已导出」
    if (signal?.aborted) {
      await removeQuietly(adapter, path);
      throw new ExportCancelledError();
    }
  }
}

export async function exportPagePng(
  vault: Vault,
  editor: BookEditor,
  file: TFile,
  scale = 2
): Promise<string> {
  await editor.waitBackgrounds([editor.getState().pageIndex], scale);
  const canvas = editor.exportPageCanvas(editor.getState().pageIndex, scale);
  const bytes = canvasBytes(canvas);
  const folder = file.parent && file.parent.path !== "/" ? file.parent.path + "/" : "";
  const base = safeName(file.basename);
  const page = editor.getState().pageIndex + 1;
  let name = `${base}-第${page}页.png`;
  let n = 1;
  while (await vault.adapter.exists(folder + name)) {
    name = `${base}-第${page}页 ${++n}.png`;
  }
  await vault.adapter.writeBinary(folder + name, bytes.buffer as ArrayBuffer);
  new Notice(`已导出：${folder}${name}`, 6000);
  return folder + name;
}

/**
 * 一页的 user 批注里是否含字体写不出的字符（生僻字 / emoji / 代理对）。
 *
 * 纯函数：导出链路和测试共用同一份判定，避免"代码里保守、测试里乐观"漂移。
 *
 * `charset === null` 表示字符集没解析出来（字体文件异常、fontkit 不可用等），
 * 这时**一律返回 true**：宁可整页退回位图（字都在、只是选不中），也不能把
 * 集外字送进矢量层硬画成 .notdef 方块/空白 —— 后者位图层又不画，字就真丢了。
 *
 * \n / \r 是排版用的硬换行，不是要画的字，跳过。
 * 用 codePointAt(0) 而不是 charCodeAt(0)，保证 emoji 这类代理对按整码点判定。
 */
export function pageHasUnsupportedChars(
  texts: PageText[] | undefined,
  charset: Set<number> | null
): boolean {
  if (!charset) return true;
  for (const t of texts || []) {
    if (t.source !== "user") continue;
    for (const ch of t.text || "") {
      if (ch === "\n" || ch === "\r") continue;
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      if (!charset.has(cp)) return true;
    }
  }
  return false;
}

/** 页面坐标系（794×1123）→ A4 的 pt（595.28×841.89），比例正好 0.7497 */
const PT_PER_UNIT = 595.28 / 794;
const A4_W = 595.28;
const A4_H = 841.89;

function parseColor(hex?: string): RGB {
  const s = String(hex || "#1A1A1A").replace("#", "").trim();
  const full = s.length === 3 ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2] : s;
  const v = parseInt(full, 16);
  if (!Number.isFinite(v)) return rgb(0.1, 0.1, 0.1);
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}

/**
 * 把一页里用户添加的文字画成**真正的 PDF 文字**（不是像素）。
 *
 * 坐标换算要点：
 *   · 屏幕上是 `fillText(line, x, y + i × size × 1.32)`，textBaseline 为 alphabetic，
 *     也就是 `y` 就是**基线**——正好对上 pdf-lib 的 drawText（y 也是基线）。
 *   · PDF 原点在左下、y 朝上，所以要翻成 `(页高 − y)`。
 *   · drawText 不认 `\n`，逐行调用。
 *
 * 字体只有一款 Regular（见 fontasset.ts）：屏幕上选的宋体/楷体等在这里统一成
 * Noto Sans SC，`bold` 也不描粗——PDF 里没有对应的字重文件。
 * 这是有意的取舍：优先保证「能选中、能搜索」，字形一致度次之。
 */
/**
 * 这一页有没有**真正会被画出来**的批注。
 *
 * 条件与 drawUserTextsPdf 里的过滤保持一致（source === "user" 且 trim 后非空）。
 * Notice 的「N 页的批注文字可选中」必须按这个算：以前是无条件按页累加，
 * 300 页的本子只有 2 页写了批注也会报「300 页」，用户会以为每页都有字。
 */
export function pageHasUserText(p?: Page): boolean {
  return (p?.texts || []).some(
    (t) => t.source === "user" && (t.text || "").trim().length > 0
  );
}

function drawUserTextsPdf(page: PDFPage, src: Page, font: PDFFont, pageH: number): void {
  const texts = (src.texts || []).filter((t) => t.source === "user" && (t.text || "").trim());
  if (!texts.length) return;
  /*
   * 纸宽换回页面坐标（794 那套）：textwrap 里的排版规则全程用页面坐标，
   * 量的宽度也换成页面坐标（除以 PT_PER_UNIT），画的时候再乘回去。
   * 混着单位算的话，「折行宽度」和「字体度量」会差 25%，右边一截照样出纸。
   */
  const pageWUnits = page.getWidth() / PT_PER_UNIT;
  for (const t of texts) {
    const sizePt = (t.size || 14) * PT_PER_UNIT;
    const color = parseColor(t.color);
    /*
     * 折行 + 位置夹取都交给 layoutUserText。
     *
     * 只折行不夹位置是不够的：pdf-lib 不认页边界，基线排在 y=1100 的批注
     * 折成 4 行后，下面 3 行整个落在 /MediaBox 之外，阅读器直接不显示
     * ——横向裁字的问题解决了，纵向又漏一行，症状一样是「字不完整」。
     */
    const l = layoutUserText(
      // width 必须一起传：屏幕侧按用户拖过的宽度折行，导出不传就会静默按纸宽折
      { x: t.x, y: t.y, size: t.size || 14, text: t.text, width: t.width },
      pageWUnits,
      pageH,
      // 度量换算成页面坐标，跟 maxWidth / x / y 同一套单位
      (s) => font.widthOfTextAtSize(s, sizePt) / PT_PER_UNIT
    );
    for (let i = 0; i < l.lines.length; i += 1) {
      const line = l.lines[i];
      if (!line) continue;
      const y = l.y + i * l.lineHeight;
      page.drawText(line, {
        x: l.x * PT_PER_UNIT,
        y: (pageH - y) * PT_PER_UNIT,
        size: sizePt,
        font,
        color,
      });
    }
  }
}

/**
 * 导出整本或指定页范围。
 *
 * `range` 是 1 起的闭区间 `{ from, to }`；不传或非法一律回落整本。
 * 只夹「循环哪些页 / 文件名」两处，批注矢量、原 PDF 保矢量、
 * 生僻字回退这些链路完全不动。
 *
 * `opts` 提供进度和取消（界面层用）：进度按页回调，取消时抛
 * ExportCancelledError 且不留下正式文件或 `.tmp`。产物写出走
 * 「.tmp → rename」原子写；改名不可用的适配器回落直接写。
 */
export async function exportBookPdf(
  vault: Vault,
  editor: BookEditor,
  file: TFile,
  scale = 2,
  range?: { from: number; to: number },
  opts: ExportBookOptions = {}
): Promise<string> {
  /*
   * 无论成功、失败还是**被取消**，都要把导出用的大位图还给缓存。
   *
   * 导出按 pdfExportWidth（最长边 4096）渲染，单张可达 4096×5793×4 ≈ 90MB；
   * 塞进 bgBitmaps(160MB) 只放得下 1.8 张，会把阅读用的 1588 位图全挤出去。
   * 取消路径同样要清 —— 用户点「取消」往往正是因为本子太大、导出太慢，
   * 那时缓存里恰恰已经堆了一批超大位图。
   *
   * 清理失败不影响导出结果，所以单独 catch。
   */
  try {
    return await exportBookPdfImpl(vault, editor, file, scale, range, opts);
  } finally {
    try {
      editor.pruneOversizedBackgrounds();
    } catch (_) {
      /* 清理失败不影响导出结论 */
    }
  }
}

/** 导出主体（`exportBookPdf` 的包装只负责 finally 清理） */
async function exportBookPdfImpl(
  vault: Vault,
  editor: BookEditor,
  file: TFile,
  scale = 2,
  range?: { from: number; to: number },
  opts: ExportBookOptions = {}
): Promise<string> {
  const { signal, onProgress, onRangeAdjusted } = opts;
  const total = editor.getState().pageCount;
  const norm = normalizeExportRange(total, range);
  const { from, to } = norm;
  /*
   * 夹取后和用户输入不一致就明确报一声：老实现静默回落整本，但进度
   * Notice 还写「准备导出第 9–2 页」，用户以为只导几页结果跑了 857 页。
   */
  if (norm.adjusted) onRangeAdjusted?.(norm);
  const isPartial = from > 1 || to < total;
  const indices = Array.from({ length: to - from + 1 }, (_, k) => from - 1 + k);
  const count = indices.length;
  /*
   * 动线审查第 5 条：老实现只弹一个 3 秒的 Notice，857 页的本子后面全程静默，
   * 像卡死；逐页循环也没有进度和取消。现在：
   *   · 每导完一页回调一次 onProgress（界面层负责续 Notice）；
   *   · 每页开始 / 底图等待之后 / 写文件前后都检查取消信号。
   */
  throwIfCancelled(signal);
  onProgress?.(0, count, "page");

  const doc = await PDFDocument.create();
  const pages = editor.store.data.pages;
  const pageH = editor.store.data.height;

  /*
   * 三期第 2 步（INK-102）：用户批注也走矢量。
   *
   * 之前批注是跟笔迹一起烤在位图里的，导出后一个字都选不中。
   * 现在从位图层剥离出来，用嵌入的中文字体 drawText 画在**最上面**——
   * 层序跟屏幕一致（底图 → 笔迹 → 文字），批注也能选中、能搜索。
   *
   * 字体只在真有批注时才嵌：一本纯手写的本子不该为它多背一份字体。
   */
  const hasUserText = pages.some((p) => pageHasUserText(p));
  let zhFont: PDFFont | null = null;
  /*
   * 字体能写出的码点集合。必须来自 fontkit 直接解析字体文件（见 fontasset.ts），
   * 不能依赖 PDFFont.getCharacterSet()：那是随 embedder 变的非公开 API。
   * 拿不到时**按保守处理**（当作"全都不支持" → 整页退回位图），绝不乐观放行。
   */
  let charset: Set<number> | null = hasUserText ? chineseCharacterSet() : null;
  if (hasUserText) {
    try {
      doc.registerFontkit(fontkit);
      /*
       * 这里必须是 subset: false —— 不能再对已经手工子集化的 TTF 做二次子集化。
       *
       * INK-118（用户真机：「打了 4 个字，导出 PDF 只显示 2 个，字体断断续续」）：
       * assets/NotoSansSC-subset.ttf 是构建期按 GB2312 手工子集好的 TTF，
       * 它的 glyf 各字形长度可以是奇数。pdf-lib 的 subset:true 会调 fontkit 的
       * TTFSubset，把这些字形「按原始字节长度原样拼接」成一份新字体；新字体较小，
       * head.indexToLocFormat 会退化成 0（short loca），而 loca.preEncode() 对每个
       * offset 做 `>>> 1`（只存半偏移）。奇数长度的字形会把后面所有边界向左吞掉
       * 1 字节，CID 读到的是错位的 numberOfContours（实测 -28160 / 11776 之类），
       * 阅读器画不出这些字形 —— 于是「4 个字只显示 2 个」，且缺哪些字随整本书的
       * 字形登记顺序变化，看起来断断续续。
       *
       * 更要命的是 ToUnicode CMap 是按「登记过的字符」生成的，跟 glyf 字节无关：
       * 抽回的文字一个不少，视觉上却是空白。上一轮只验 getTextContent() 的断言
       * 因此全绿也没抓到（见 test/pdftext-harness.ts 的像素级逐字检查）。
       *
       * 关掉二次子集化后，嵌入的就是构建期那份完整手工子集字体（long loca，
       * indexToLocFormat=1），字形边界不再被截断。代价是每份导出 PDF 多约
       * 1.2MB（字体本来就已内联进 main.js，插件包体积不变）；相对「看得见的字
       * 导出后消失」，按「内容不丢第一原则」这个体积可以接受。
       */
      zhFont = await doc.embedFont(chineseFontBytes(), { subset: false });
    } catch (e) {
      // 嵌字体失败不能让导出整个失败：退回"文字烤进位图"，至少内容不丢
      console.warn("[inkbook] 嵌入中文字体失败，批注将按图片导出", e);
      zhFont = null;
    }
    // 放在 try 外面：嵌字体是大 await，期间可能已经取消，别被上面的 catch 吞掉
    throwIfCancelled(signal);
  }

  /**
   * 这一页的批注里有没有字体写不出的字（生僻字、emoji）。
   *
   * 子集只覆盖 GB2312，遇到集外字硬画会变成空白或方块——
   * 那比"文字不可选"更糟（内容看起来像丢了）。这种页整页退回位图，
   * 批注照样看得见，只是选不中。
   *
   * `charset` 为 null 表示字符集解析失败（字体文件异常 / fontkit 不可用）：
   * 此时返回 true（**保守**），让所有带批注的页都退回位图。绝不能返回 false
   * 乐观放行 —— 那会把集外字送进矢量层画成 .notdef，同时位图层又不画，字就丢了。
   *
   * 抽成纯函数是为了能在 pdftext-harness.ts 里直接断言这个保守分支，
   * 而不是只能靠"字体正常时侥幸没走到"来间接验证。
   */
  const hasUnsupported = (p: Page | undefined): boolean =>
    pageHasUnsupportedChars(p?.texts, charset);

  /** 原 PDF 文件只解析一次（同一份 PDF 可能有很多页） */
  const srcDocs = new Map<string, PDFDocument | null>();
  let vectorPages = 0;
  let textPages = 0;
  let fallbackPages = 0;

  for (let k = 0; k < indices.length; k++) {
    throwIfCancelled(signal);
    const i = indices[k];
    const page = pages[i];
    const pdfRef = page?.background?.pdf;
    /* 这一页的批注能不能写成矢量文字？写不了就烤进位图（内容不能丢） */
    const vectorText = !!zhFont && !hasUnsupported(page);
    if (zhFont && !vectorText) fallbackPages += 1;
    const canvasWithText = !vectorText;
    let done = false;

    /*
     * 三期（INK-102 第一步）：PDF 底图页保留**矢量**。
     *
     * 老做法是把整页画成 canvas 贴成图片，原文自然不可选、不可搜。
     * 现在用 pdf-lib 的 copyPages 把原页整页搬进导出文档，
     * 再把笔迹/手写文字做成**透明 PNG** 叠上去——原文这层始终是矢量。
     */
    if (pdfRef) {
      if (!srcDocs.has(pdfRef.path)) {
        throwIfCancelled(signal);
        const bytes = await editor.readPdfBytes(pdfRef.path);
        throwIfCancelled(signal);
        let loaded: PDFDocument | null = null;
        if (bytes) {
          try {
            loaded = await PDFDocument.load(bytes, {
              ignoreEncryption: true,
              updateMetadata: false,
            });
          } catch (e) {
            console.warn("[inkbook] 原 PDF 解析失败，这几页退回位图", pdfRef.path, e);
          }
        }
        // 别放在上面的 try 里：ExportCancelledError 会被 catch 当成解析失败吞掉
        throwIfCancelled(signal);
        srcDocs.set(pdfRef.path, loaded);
      }
      const src = srcDocs.get(pdfRef.path);
      const bg = page.background;
      if (src && bg && pdfRef.page >= 1 && pdfRef.page <= src.getPageCount()) {
        try {
          throwIfCancelled(signal);
          const [copied] = await doc.copyPages(src, [pdfRef.page - 1]);
          throwIfCancelled(signal);
          /*
           * 旋转过的页（扫描件常见 /Rotate 90）不能用这条路径：
           * Form XObject 不带 /Rotate，画上去会横过来。宁可退回位图也不错页。
           */
          const rot = Math.abs(Number((copied as any).getRotation?.()?.angle ?? 0)) % 360;
          if (rot === 0) {
            const out = doc.addPage([A4_W, A4_H]);
            // drawPage 要的是"嵌入页"（embedPage），不是 copyPages 得到的 PDFPage
            const embedded = await doc.embedPage(copied);
            out.drawPage(embedded, {
              x: bg.x * PT_PER_UNIT,
              // PDF 的 y 轴朝上：页面坐标系里"距顶部 bg.y"要翻成"距底部"
              y: (pageH - bg.y - bg.height) * PT_PER_UNIT,
              width: bg.width * PT_PER_UNIT,
              height: bg.height * PT_PER_UNIT,
            });
            const overlay = editor.exportOverlayCanvas(i, scale, canvasWithText);
            const png = await doc.embedPng(overlay.toDataURL("image/png"));
            throwIfCancelled(signal);
            out.drawImage(png, { x: 0, y: 0, width: A4_W, height: A4_H });
            if (vectorText && zhFont) {
              drawUserTextsPdf(out, page, zhFont, pageH);
              // 只统计真有批注的页：否则 Notice 会把整本页数都算进去
              if (pageHasUserText(page)) textPages += 1;
            }
            vectorPages += 1;
            done = true;
          }
        } catch (e) {
          console.warn("[inkbook] 复制原 PDF 页失败，这一页退回位图", e);
        }
      }
    }

    if (!done) {
      /*
       * 只有「退回位图」的页才需要底图；PDF 矢量页（copyPages）用的只是
       * 透明叠加层，根本不需要把原页再光栅化一遍。
       *
       * 老代码在开跑前 waitBackgrounds(indices) 一次性等**整本**每一页，
       * 857 页的 PDF 本子会先把 857 张 2x 位图同时压进缓存（每张十几 MB），
       * 进度条却一直停在 0 —— 既慢又像卡死。现在按页等，且只等真正要用
       * 位图的页；矢量页直接跳过。
       */
      await editor.waitBackgrounds([i], scale);
      throwIfCancelled(signal);
      const canvas = editor.exportPageCanvas(i, scale, canvasWithText);
      const png = await doc.embedPng(canvas.toDataURL("image/png"));
      throwIfCancelled(signal);
      const out = doc.addPage([A4_W, A4_H]);
      out.drawImage(png, { x: 0, y: 0, width: A4_W, height: A4_H });
      if (vectorText && zhFont) {
        drawUserTextsPdf(out, page, zhFont, pageH);
        if (pageHasUserText(page)) textPages += 1;
      }
    }
    onProgress?.(k + 1, count, "page");
  }

  throwIfCancelled(signal);
  onProgress?.(count, count, "saving");
  /*
   * doc.save() 是同步大活（几百页时能卡好几秒）。先让出一帧，把
   * 「正在生成 PDF…」真正画到屏幕上，否则用户看到的是最后一个页码卡住。
   */
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  throwIfCancelled(signal);
  const bytes = await doc.save();
  throwIfCancelled(signal);
  const folder = file.parent && file.parent.path !== "/" ? file.parent.path + "/" : "";
  const base = safeName(file.basename);
  const suffix = isPartial ? `-第${from}-${to}页` : "";
  let name = `${base}-手写本${suffix}.pdf`;
  let n = 1;
  while (await vault.adapter.exists(folder + name)) {
    name = `${base}-手写本${suffix} ${++n}.pdf`;
  }
  await writeExportFile(vault, folder + name, bytes, signal);

  const notes: string[] = [];
  if (vectorPages) notes.push(`${vectorPages} 页保留了 PDF 原文，可选中可搜索`);
  if (textPages) notes.push(`${textPages} 页的批注文字可选中`);
  if (fallbackPages) {
    notes.push(`${fallbackPages} 页批注含生僻字，按图片导出（看得见但选不中）`);
  }
  new Notice(
    `已导出：${folder}${name}` + (notes.length ? `（${notes.join("；")}）` : ""),
    7000
  );
  return folder + name;
}
