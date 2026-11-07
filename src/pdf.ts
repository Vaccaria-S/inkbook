/**
 * PDF 引擎：把 PDF 页面按需渲染成位图。
 *
 * 关键设计——**不预渲染**。
 *
 * 旧做法是导入时把每一页都渲染成 PNG 存进库里。一份 300 页的 PDF
 * 会在导入时连续阻塞主线程几分钟（每页一次 toDataURL），内存里同时
 * 堆着几百 MB 的 base64 字符串，而且库里凭空多出几百个 PNG。
 *
 * 现在改成：.inkbook 只记下"第几页来自哪个 PDF"，翻到哪页才渲染哪页。
 * 导入瞬时完成，磁盘零膨胀，内存由 LRU 缓存兜底。
 *
 * pdf.js 直接打进主包（用户不在意体积，换来的是加载路径绝对可靠）。
 * worker 源码在构建时转成字符串内联，运行时用 Blob URL 起——这样
 * 不依赖任何外部文件路径。
 */

import * as pdfjsBundle from "pdfjs-dist/legacy/build/pdf.min.mjs";
import workerSource from "pdfjs-dist/legacy/build/pdf.worker.min.mjs";

export type PdfDoc = any;

let pdfjsReady: any = null;

/**
 * 初始化 pdf.js（含 worker）。
 * worker 走 Blob URL：不依赖插件目录定位，桌面端和移动端都能起。
 */
export function initPdfjs(): any {
  if (pdfjsReady) return pdfjsReady;
  // pdf.min.mjs 只有具名导出，没有 default
  const pdfjs: any = pdfjsBundle;
  try {
    const blob = new Blob([workerSource as unknown as BlobPart], {
      type: "text/javascript",
    });
    pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  } catch (_) {
    // 起不了 worker 也不致命：pdf.js 会退回到主线程解析
    pdfjs.GlobalWorkerOptions.workerSrc = "";
  }
  pdfjsReady = pdfjs;
  return pdfjs;
}

/**
 * 打开一份 PDF。
 *
 * 用 Range 传输（PDFDataRangeTransport）按需拉字节——大 PDF 不用
 * 一次性把整个文件读进内存。Obsidian 的 app:// 协议支持 Range。
 */
export async function openPdf(
  url: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<PdfDoc> {
  const pdfjs = initPdfjs();
  const task = pdfjs.getDocument({
    url,
    range: pdfjs.PDFDataRangeTransport,
    /*
     * 大 PDF 不要自动预取。
     *
     * 用户那本 857 页的本子引用的是一份 **69.5MB** 的 PDF。开着自动预取时，
     * 只要底层流支持 Range，pdf.js 就会在打开后持续把整份文件按块拉完，
     * 平板上和首屏渲染抢 IO，表现就是「打开半天」；关掉后只按需拉
     * 「交叉引用表 + 当前页」那几段。
     *
     * 说明：pdf.js 4.10 只在协议能提供 Range 时才走这条路。测试环境是
     * http（server.mjs 支持 Range），收益确定；Obsidian 的 app:// 在部分平台
     * 也支持 Range，不支持时行为与以前一致（整份缓冲），不会变差。
     * 代价是连续翻页会多发几次 Range 请求（本地文件，可忽略）。
     */
    disableAutoFetch: true,
    disableStream: true,
  });
  if (onProgress) {
    task.onProgress = (p: any) => {
      try {
        onProgress(p.loaded || 0, p.total || 0);
      } catch (_) {}
    };
  }
  return task.promise;
}

/** 一页渲染出来的位图 */
export interface RenderedPage {
  bitmap: ImageBitmap;
  /** 页面尺寸（PDF 坐标系，pt） */
  width: number;
  height: number;
}

/**
 * 目标位图里「每 1 个页面单位」至少要有多少设备像素。
 *
 * 这是个**地板**，不是推荐值——见 pdfTargetWidthPx 的说明。
 *
 * 取 2.0 的依据：PDF 原生单位是 point（A4 = 595.28pt 宽），铺到 794 单位宽
 * 的页面坐标系里乘了 1.3338 的换算系数。于是
 *   2.0 设备像素/页面单位 ≈ 2.67 设备像素/pt
 * 中文笔画密度远高于西文，在这个倍率上光栅化，笔画不会粘连成一团。
 */
export const PDF_FLOOR_PPU = 2.0;

/** PDF 底图位图宽度上限（设备像素）——再大就是拿内存换肉眼看不见的清晰度 */
export const PDF_MAX_TARGET_PX = 4096;

/**
 * A4 页面的高宽比（1123 / 794）。用来把「目标宽度」换算成「像素总数」。
 *
 * 底图总是按比例铺在纸面上（`fitBackground`），所以宽定下来高也就定了。
 */
export const PDF_PAGE_ASPECT = 1123 / 794;

/**
 * 单张 PDF 底图位图的像素数上限。
 *
 * 取值依据：`bgBitmaps` 预算 160MB，`MIN_MOUNTED = 2`（同时至少两张），
 * 留一点余量给「正在渲的那张 + 刚淘汰还没回收的」→ 每张最多吃一半：
 *   160MB / 2 = 80MB = 20.97M px
 * 按 A4 高宽比反推目标宽 ≈ sqrt(20.97M / 1.414) ≈ **3850px**
 * 实测单张约 3850×5444×4 ≈ 80MB，两张 160MB 正好卡线。
 * 再保守一点取 17M px（单张约 65MB，两张 130MB，留 30MB 余量）。
 */
export const PDF_BITMAP_MAX_PIXELS = 17_000_000;

/**
 * 算 PDF 底图的目标位图宽度（设备像素）。
 *
 * 纯函数：只吃「底图在页面坐标系里多宽」和「现在每页面单位多少设备像素」，
 * 不碰编辑器状态——测试可以直接跑它。
 *
 *   target = bgWidth × max(zoom × dpr, PDF_FLOOR_PPU)   （封顶 PDF_MAX_TARGET_PX）
 *
 * 为什么必须有那个 max：按 `zoom × dpr` 直接光栅化，缩小到 0.5 倍只剩
 * 1.33 设备像素/pt、0.35 倍只剩 0.47——pdf.js 被迫在亚像素倍率上画字，
 * 字形直接糊掉；而那张低清位图就是我们手上唯一的图，糊被原样显示出来
 * （真机反馈：「缩小时字很糊，放大还能好一点」）。地板保证位图**永远超采样**，
 * 缩小由画布 drawImage 高质量降采样得到平滑结果（imageSmoothingEnabled 默认开）。
 *
 * 地板量纲选「设备像素 / 页面单位」而不是「设备像素 / CSS 像素 × dpr」：
 * 后者在 dpr=1 的桌面端会退化成一个跟 dpr 无关的固定像素数——而桌面端的
 * 糊是一样的，必须同样被地板挡住。
 *
 * **为什么还要吃一个「像素预算」上限**（2026-11-07 补）：
 * 只有 `PDF_MAX_TARGET_PX`(4096) 这个宽度封顶是不够的 —— 位图是**按比例**
 * 缩放的（A4 高宽比 1123/794 ≈ 1.414），宽 4096 时高就是 5793，
 * 单张 = 4096×5793×4 ≈ **90.5MB**。平板 dpr=2 放大到 2.8 倍就会顶到 4096，
 * 而 `MIN_MOUNTED = 2` 意味着同时至少两张 → **181MB**，超出
 * `bgBitmaps` 的 160MB 预算，LRU 会一边渲一边淘汰（等于每次翻页都重渲）。
 * 所以这里再按「单张最多占预算的 1/2」夹一道：宽 ≤ sqrt(预算/2 ÷ 高宽比)，
 * 换算到 A4 就是 ≈ 3340px（单张 ≈ 60MB，两张 120MB，留 40MB 余量）。
 *
 * @param maxPixels 单张位图的像素数上限（默认按「两张吃满 160MB」反推）
 */
export function pdfTargetWidthPx(
  bgWidth: number,
  devicePxPerUnit: number,
  maxPixels: number = PDF_BITMAP_MAX_PIXELS
): number {
  const ppu = Math.max(devicePxPerUnit || 0, PDF_FLOOR_PPU);
  const w = Math.max(bgWidth || 0, 1);
  let target = Math.min(Math.round(w * ppu), PDF_MAX_TARGET_PX);
  /*
   * 按像素预算再夹一道。位图高度按「页面高宽比」估：底图占页面宽 bgWidth，
   * 高就是 bgWidth × (页高/页宽)。换算成目标宽：
   *   px = target × (target × ratio) ≤ maxPixels
   *   ⇒ target ≤ sqrt(maxPixels / ratio)
   */
  if (Number.isFinite(maxPixels) && maxPixels > 0) {
    const ratio = Math.max(0.1, PDF_PAGE_ASPECT);
    const capByPixels = Math.floor(Math.sqrt(maxPixels / ratio));
    if (target > capByPixels) target = capByPixels;
  }
  return Math.max(1, target);
}

/**
 * 把 PDF 的第 pageNo 页（1 起）渲染成位图。
 *
 * @param targetWidthPx 目标位图宽度（**设备像素**）。
 *   传 0 表示"按 PDF 原始尺寸 1:1"，即 72dpi。
 *
 * 为什么用"目标宽度"而不是"倍率"：
 * 倍率是相对于 PDF 的 point（1/72 英寸）而言的，而我们要的是
 * 屏幕上的**物理像素**。A4 是 595.28pt 宽，铺到 794 单位宽的
 * 页面坐标系里要放大 1.334 倍——这个系数如果漏掉，位图就会
 * 被拉伸 1.33 倍显示，文字明显发糊。
 * 直接给目标像素宽度，让调用方说清"我要多宽的图"，就不会算错。
 *
 * 渲染是异步的——pdf.js 内部 worker 解析，主线程只负责最后
 * 的 canvas 光栅化。
 */
export async function renderPdfPage(
  doc: PdfDoc,
  pageNo: number,
  targetWidthPx: number
): Promise<RenderedPage> {
  const page = await doc.getPage(pageNo);
  // 先拿 PDF 原始尺寸（point），再反推需要的倍率
  const unit = page.getViewport({ scale: 1 });
  const ptWidth = unit.width || 1;
  const scale = targetWidthPx > 0 ? targetWidthPx / ptWidth : 1;

  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("无法创建渲染画布");
  // PDF 页可能有透明背景，先铺白
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const task = page.render({
    canvasContext: ctx,
    viewport,
    background: "#ffffff",
  });
  await task.promise;

  const bitmap = await createImageBitmap(canvas);
  // 画布用完就扔，别让显存被临时画布占着
  canvas.width = 0;
  canvas.height = 0;
  page.cleanup();
  return { bitmap, width: viewport.width, height: viewport.height };
}

/**
 * 一页里的一行文字（坐标是 **viewport(scale=1)** 的，y 向下）。
 *
 * 调用方要按底图摆放比例映射到页面坐标系：
 *   pageX = bg.x + line.x * (bg.width  / pdfW)
 *   pageY = bg.y + line.y * (bg.height / pdfH)
 */
export interface PdfTextLine {
  x: number;
  y: number;
  size: number;
  text: string;
  width: number;
}

/** 2×3 矩阵乘法，与 pdf.js 的 Util.transform 同义（不依赖内部导出） */
function mulMatrix(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * 抽取 PDF 一页的文字，按行合并。
 *
 * 目的不是"还原排版"，而是让这些字**能被选中、能被搜到**：
 *   · 一行一个结果，坐标取行首基线；
 *   · PDF 常把一句话拆成好几个 item（换字体、加粗、字距），
 *     这里按 y 聚类、按 x 排序，间距大的地方补一个空格；
 *   · 扫描版 PDF 没有文字层，返回空数组——那种只能等 OCR。
 *
 * 只解析文本，不光栅化，所以比 renderPdfPage 快一个量级。
 */
export async function extractPdfText(
  doc: PdfDoc,
  pageNo: number
): Promise<PdfTextLine[]> {
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items: Array<{ x: number; y: number; size: number; text: string; width: number }> = [];

  for (const raw of (content?.items || []) as any[]) {
    const str = typeof raw?.str === "string" ? raw.str : "";
    if (!str.trim()) continue;
    if (!Array.isArray(raw.transform)) continue;
    const tr = mulMatrix(viewport.transform as number[], raw.transform as number[]);
    const x = Number(tr[4]) || 0;
    const y = Number(tr[5]) || 0;
    // 字号 = 变换后竖直方向的长度；拿不到就退回 item.height
    const size = Math.max(1, Math.hypot(tr[2], tr[3]) || Number(raw.height) || 10);
    const width = Math.max(0, Number(raw.width) || 0);
    items.push({ x, y, size, text: str, width });
  }

  page.cleanup();

  // 先从左上到右下排一遍，再把同一水平线上的合并成行
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: PdfTextLine[] = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= Math.max(last.size, it.size) * 0.55) {
      const gap = it.x - (last.x + last.width);
      if (gap > it.size * 0.22 && !/\s$/.test(last.text) && !/^\s/.test(it.text)) {
        last.text += " ";
      }
      last.text += it.text;
      last.width = Math.max(last.width, it.x + it.width - last.x);
    } else {
      lines.push({ x: it.x, y: it.y, size: it.size, text: it.text, width: it.width });
    }
  }
  return lines.filter((l) => l.text.trim().length > 0);
}

/** 读一页的尺寸，不渲染 */
export async function pdfPageSize(
  doc: PdfDoc,
  pageNo: number
): Promise<{ width: number; height: number }> {
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale: 1 });
  const size = { width: viewport.width, height: viewport.height };
  page.cleanup();
  return size;
}

/**
 * 把底图按 A4 比例放进页面。
 * PDF 页通常是 Letter/A4 比例，宽度按 A4 铺满，高度按比例，超出的部分留白。
 */
export function fitBackground(
  imgW: number,
  imgH: number,
  pad = 0
): { x: number; y: number; width: number; height: number } {
  const boxW = 794 - pad * 2;
  const boxH = 1123 - pad * 2;
  const scale = Math.min(boxW / imgW, boxH / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  return {
    x: (794 - w) / 2,
    y: (1123 - h) / 2,
    width: w,
    height: h,
  };
}
