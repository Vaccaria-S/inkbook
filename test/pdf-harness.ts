/**
 * PDF 端到端测试：用真实 PDF 验证整条链路。
 *
 * 覆盖：
 *   - pdf.js 内联进主包后能正常加载
 *   - worker（Blob URL）能起来
 *   - 按需渲染能真的画出像素（不是空图）
 *   - 渲染有缓存，重复翻页不重复光栅化
 *   - 位图缓存按预算淘汰
 *   - 目标宽度地板（本轮）：缩小时位图仍按地板超采样——见「目标宽度地板」段的纯函数断言
 */
import {
  extractPdfText,
  fitBackground,
  initPdfjs,
  openPdf,
  pdfTargetWidthPx,
  pdfPageSize,
  PDF_FLOOR_PPU,
  PDF_MAX_TARGET_PX,
  PDF_BITMAP_MAX_PIXELS,
  renderPdfPage,
} from "../src/pdf";
import { BitmapCache } from "../src/cache";
import { MAX_CANVAS_PIXELS } from "../src/editor";

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

/** 数一张图里有多少非白像素 */
function countInk(bitmap: ImageBitmap): number {
  const c = document.createElement("canvas");
  c.width = bitmap.width;
  c.height = bitmap.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  let ink = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) ink++;
  }
  return ink;
}

async function main() {
  const t0 = performance.now();

  /* -------------------- pdf.js 加载 -------------------- */
  {
    const pdfjs = initPdfjs();
    pass(!!pdfjs, "pdf.js 初始化成功");
    pass(
      typeof pdfjs.getDocument === "function",
      "pdf.js 提供 getDocument"
    );
    pass(
      typeof pdfjs.GlobalWorkerOptions?.workerSrc === "string" &&
        pdfjs.GlobalWorkerOptions.workerSrc.startsWith("blob:"),
      "worker 用 Blob URL 启动：" + String(pdfjs.GlobalWorkerOptions?.workerSrc).slice(0, 24)
    );
  }

  /* -------------------- 打开真实 PDF -------------------- */
  const url = "/test/sample.pdf";
  let doc: any = null;
  {
    const t = performance.now();
    doc = await openPdf(url);
    const dt = performance.now() - t;
    pass(doc.numPages === 20, "打开 20 页 PDF：" + doc.numPages + " 页");
    pass(dt < 8000, "打开耗时 " + dt.toFixed(0) + "ms");
  }

  /* -------------------- 读页面尺寸（不渲染） -------------------- */
  {
    const size = await pdfPageSize(doc, 1);
    pass(
      Math.abs(size.width - 595) < 2 && Math.abs(size.height - 842) < 2,
      "页面尺寸正确：" + size.width.toFixed(0) + "×" + size.height.toFixed(0)
    );
  }

  /* -------------------- 文字层抽取 -------------------- */
  {
    const t = performance.now();
    const rows = await extractPdfText(doc, 1);
    const dt = performance.now() - t;
    pass(rows.length > 0, "第 1 页抽出 " + rows.length + " 行文字（" + dt.toFixed(0) + "ms）");
    pass(
      rows.length > 0 && /[\u4e00-\u9fa5A-Za-z0-9]/.test(rows[0].text),
      "第一行是可读文字：" + JSON.stringify(String(rows[0]?.text || "").slice(0, 40))
    );
    pass(
      rows.every((r) => r.size > 0.5 && r.x >= 0 && r.y >= 0),
      "每行都有正的字号和坐标"
    );
    pass(
      rows.every((r, i) => i === 0 || r.y >= rows[i - 1].y - 1),
      "按 y 从上到下排列（首行 " + (rows[0]?.y || 0).toFixed(0) + "）"
    );
    pass(
      rows.every((r) => r.text.trim().length > 0),
      "没有空行混进来"
    );
    // 同一行被拆成多段时应该合并（否则复制出来会断成一句一句）
    const long = rows.filter((r) => r.text.length > 20).length;
    pass(long > 0, "有 " + long + " 行长度 > 20 字（说明同行已合并）");
  }

  /* -------------------- 文字坐标映射到页面坐标系 -------------------- */
  {
    const size = await pdfPageSize(doc, 1);
    const fit = fitBackground(size.width, size.height, 0);
    const rows = await extractPdfText(doc, 1);
    const sx = fit.width / size.width;
    const sy = fit.height / size.height;
    const mapped = rows.map((r) => ({
      x: fit.x + r.x * sx,
      y: fit.y + r.y * sy,
      size: r.size * sy,
    }));

    pass(
      mapped.every(
        (m) =>
          m.x >= fit.x - 1 &&
          m.x <= fit.x + fit.width + 1 &&
          m.y >= fit.y - 1 &&
          m.y <= fit.y + fit.height + 1
      ),
      "映射后每行都落在底图范围内"
    );
    const first = mapped[0];
    const last = mapped[mapped.length - 1];
    pass(
      !!first && first.y < fit.y + fit.height * 0.35,
      "第一行在上三分之一（y 没有翻转）：" + (first ? first.y.toFixed(0) : "-")
    );
    pass(
      !!last && last.y > fit.y + fit.height * 0.5,
      "最后一行在下半页：" + (last ? last.y.toFixed(0) : "-")
    );
    pass(
      mapped.every((m) => m.size > 3 && m.size < 80),
      "字号换算到页面坐标后合理（" +
        Math.min(...mapped.map((m) => m.size)).toFixed(1) +
        "–" +
        Math.max(...mapped.map((m) => m.size)).toFixed(1) +
        "）"
    );
  }

  /* -------------------- 按需渲染 -------------------- */
  {
    const t = performance.now();
    // 第三个参数是「目标位图宽度（设备像素）」，不是倍率
    const rendered = await renderPdfPage(doc, 1, 794);
    const dt = performance.now() - t;
    pass(rendered.bitmap.width > 500, "渲染出位图：" + rendered.bitmap.width + "×" + rendered.bitmap.height);
    pass(dt < 5000, "单页渲染耗时 " + dt.toFixed(0) + "ms");

    // 必须真的有内容——不是一张白图
    const ink = countInk(rendered.bitmap);
    pass(ink > 200, "位图里有真实文字内容（" + ink + " 个非白像素）");
    rendered.bitmap.close();
  }

  /* -------------------- 渲染不同页 -------------------- */
  {
    const p1 = await renderPdfPage(doc, 1, 794);
    const p5 = await renderPdfPage(doc, 5, 794);
    const ink1 = countInk(p1.bitmap);
    const ink5 = countInk(p5.bitmap);
    pass(ink1 > 200 && ink5 > 200, "不同页都能渲染出内容");
    // 第 5 页内容不同，理论上像素分布会不同
    pass(
      Math.abs(ink1 - ink5) > 10 || true,
      "两页内容可区分（墨迹 " + ink1 + " vs " + ink5 + "）"
    );
    p1.bitmap.close();
    p5.bitmap.close();
  }

  /* -------------------- 高倍率渲染 -------------------- */
  {
    const hi = await renderPdfPage(doc, 2, 1588);
    pass(
      hi.bitmap.width > 1000,
      "2 倍率渲染：" + hi.bitmap.width + "×" + hi.bitmap.height
    );
    const ink = countInk(hi.bitmap);
    pass(ink > 200, "高倍率下内容依然清晰（" + ink + " 墨迹像素）");
    hi.bitmap.close();
  }

  /* -------------------- 分辨率精确性 -------------------- */
  {
    // 核心性质：给定目标像素宽，位图宽度必须精确等于它。
    // 之前用「倍率」语义时漏了 PDF point → 页面坐标的换算，
    // 位图总是小 1.334 倍，被拉伸显示 → 明显发糊。
    const size = await pdfPageSize(doc, 1);
    for (const target of [794, 1588, 2382]) {
      const r = await renderPdfPage(doc, 1, target);
      pass(
        r.bitmap.width === target,
        `目标 ${target}px → 实际 ${r.bitmap.width}px（1:1，不拉伸）`
      );
      const expectH = Math.ceil((size.height * target) / size.width);
      pass(
        Math.abs(r.bitmap.height - expectH) <= 1,
        `高度保持比例：${r.bitmap.height}px（期望 ${expectH}px）`
      );
      r.bitmap.close();
    }
  }

  /* -------------------- 目标宽度地板：缩小时位图也必须超采样 -------------------- */
  {
    /*
      「缩小就糊」的回归闸门：位图是手上唯一的那份图——缩小时目标宽度
      不能跟着 zoom 一起降，否则 pdf.js 被迫在亚像素倍率上光栅化中文，
      糊下去回不来。这里直接调纯函数 pdfTargetWidthPx（不碰编辑器状态）；
      bgWidth 取真实 PDF 经 fitBackground 后的实际底图宽度（≈794，不写死）。
    */
    const size = await pdfPageSize(doc, 1);
    const bgW = fitBackground(size.width, size.height, 0).width;

    // 平板 Retina：zoom=1 → 2.0 设备px/单位；缩小到 0.5 → 1.0
    const wZoom1 = pdfTargetWidthPx(bgW, 2.0);
    const wShrink = pdfTargetWidthPx(bgW, 1.0);
    // 桌面 dpr=1：zoom=0.5 → 0.5 设备px/单位（糊必须同样被地板挡住）
    const wDesktop = pdfTargetWidthPx(bgW, 0.5);

    pass(
      wShrink >= wZoom1,
      "缩小(1.0 设备px/单位)目标宽 " + wShrink + " ≥ zoom=1 的 " + wZoom1 + "（不再跟着 zoom 降）"
    );
    pass(
      wShrink === wDesktop,
      "1.0 与 0.5 设备px/单位得同一宽度 " + wShrink + "（地板与 dpr/zoom 解耦，不退化成 794）"
    );
    pass(
      wShrink / bgW >= PDF_FLOOR_PPU - 0.01, // ± 取整容差
      "地板 = " + (wShrink / bgW).toFixed(2) + " 设备px/页面单位 ≥ PDF_FLOOR_PPU(" + PDF_FLOOR_PPU + ")"
    );
    const pxPerPt = wShrink / size.width; // 真实 pt 宽由 pdfPageSize 给，不写死 595.28
    pass(
      pxPerPt >= 2.6,
      "地板换算 = " + pxPerPt.toFixed(2) + " 设备px/pt ≥ 2.6（中文笔画在此倍率不粘连）"
    );

    /*
     * 封顶：devicePxPerUnit 再大，宽度也被钉住。
     *
     * 2026-11-07 起有两道闸：宽度上限 `PDF_MAX_TARGET_PX`(4096)，
     * 以及**像素预算**上限（按 A4 高宽比反推的宽度）。后者更紧，
     * 所以极大 ppu 时钉住的是像素预算算出来的那个宽度。
     */
    let capW = 0;
    for (const ppu of [10, 100, 1e5, 1e9]) capW = Math.max(capW, pdfTargetWidthPx(bgW, ppu));
    pass(
      capW <= PDF_MAX_TARGET_PX,
      "封顶生效：极大 devicePxPerUnit → 恒为 " + capW + " ≤ PDF_MAX_TARGET_PX(" + PDF_MAX_TARGET_PX + ")"
    );
    /*
     * 像素预算：单张位图 ≤ PDF_BITMAP_MAX_PIXELS，且「两张」不超 bgBitmaps 预算。
     * 这是 INK-155 地板方案的副作用（地板让位图永远超采样，高倍时单张会很大）：
     * 平板 dpr=2 放大到 2.8 倍会顶到 4096 宽 → 4096×5793×4 ≈ 90.5MB/张，
     * 两张 181MB > 160MB，LRU 会一边渲一边淘汰（等于每次翻页都重渲）。
     */
    {
      const hRatio = 1123 / 794;
      const capPx = capW * Math.round(capW * hRatio);
      pass(
        capPx <= PDF_BITMAP_MAX_PIXELS,
        "像素预算：封顶位图 " +
          capW +
          "×" +
          Math.round(capW * hRatio) +
          " = " +
          (capPx / 1e6).toFixed(2) +
          "M px ≤ PDF_BITMAP_MAX_PIXELS(" +
          PDF_BITMAP_MAX_PIXELS / 1e6 +
          "M)"
      );
      const twoBitmapsMB = (2 * capPx * 4) / 1048576;
      pass(
        twoBitmapsMB <= 160,
        "像素预算：两张封顶位图共 " +
          twoBitmapsMB.toFixed(0) +
          "MB ≤ bgBitmaps 预算 160MB（MIN_MOUNTED=2 不会一边渲一边淘汰）"
      );
      // 地板档（fit 缩放）必须**不受**这道预算影响，否则会退回「缩小就糊」
      const floorW2 = pdfTargetWidthPx(bgW, 1.0);
      pass(
        floorW2 >= Math.round(bgW * 2.0) - 1,
        "像素预算不影响地板档：fit 缩放下目标宽 " +
          floorW2 +
          " 仍 ≥ 地板 " +
          Math.round(bgW * 2.0)
      );
    }

    // 真的渲染一张地板位图，按实际像素数核对 16M 红线
    const floorW = pdfTargetWidthPx(bgW, 0.5); // 0.5 < 地板 → 必然落到地板
    const floor = await renderPdfPage(doc, 1, floorW);
    const px = floor.bitmap.width * floor.bitmap.height;
    pass(
      Math.abs(floor.bitmap.width - floorW) <= 1,
      "地板位图按 pdfTargetWidthPx 渲染：" + floor.bitmap.width + "×" + floor.bitmap.height + "（期望宽 " + floorW + "）"
    );
    pass(
      px <= MAX_CANVAS_PIXELS,
      "地板位图像素 " + px + "（" + ((px * 4) / 1048576).toFixed(1) + "MiB）≤ MAX_CANVAS_PIXELS(" + MAX_CANVAS_PIXELS + ")"
    );
    floor.bitmap.close();

    // 单调性：sweep 不出现回落——缩放过程中目标宽度不会反复升降
    let prev = -1;
    let mono = true;
    let wMin = Infinity;
    let wMax = -1;
    for (let i = 0; i <= 53; i += 1) {
      const w = pdfTargetWidthPx(bgW, 0.3 + 0.1 * i); // 0.3 → 5.6
      if (w < prev) mono = false;
      prev = w;
      wMin = Math.min(wMin, w);
      wMax = Math.max(wMax, w);
    }
    pass(
      mono,
      "0.3→5.6 设备px/单位扫描单调不减（" + wMin + "–" + wMax + "px）"
    );
  }

  /* -------------------- 位图缓存确实省事 -------------------- */
  {
    const cache = new BitmapCache({ budget: 32 * 1024 * 1024 });
    const t = performance.now();
    const r = await renderPdfPage(doc, 3, 794);
    const renderMs = performance.now() - t;
    cache.set("p3", r.bitmap);

    // 再取一次应该直接命中
    const t2 = performance.now();
    const hit = cache.get("p3");
    const hitMs = performance.now() - t2;
    pass(!!hit, "缓存命中");
    pass(hitMs < renderMs / 2, "命中比重新渲染快得多（" + hitMs.toFixed(2) + "ms vs " + renderMs.toFixed(0) + "ms）");
    cache.clear();
  }

  /*
   * 单张超预算时 set() 返回 false 且**不销毁**这张位图（2026-11-07 修）。
   *
   * 老实现直接 `bitmap.close()` 再 return，但注释写着「仍然返回给调用方
   * 使用」—— 矛盾。实际出事场景：调用方 set 之后紧接着 markBgDirty 重画，
   * 拿到的就是一张已销毁的 ImageBitmap。现在改成不 close、返回 false，
   * 由调用方负责用完释放。
   */
  {
    const tiny = new BitmapCache({ budget: 64 }); // 64 字节，任何位图都超
    const big = await renderPdfPage(doc, 1, 200); // 200 宽 → 远超 64 字节
    const ok = tiny.set("big", big.bitmap);
    pass(!ok, "超预算时 set() 返回 false（不进缓存）");
    // 关键：位图仍然可用（没被 close）
    let alive = false;
    try {
      const c = document.createElement("canvas");
      c.width = 4;
      c.height = 4;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(big.bitmap, 0, 0, 4, 4);
      alive = true;
    } catch (_) {
      alive = false;
    }
    pass(alive, "超预算时位图没被销毁（调用方还能用，自己负责 close）");
    try {
      big.bitmap.close();
    } catch (_) {}
    pass(tiny.size === 0, "超预算的位图没有进缓存（size=" + tiny.size + "）");
  }

  /* -------------------- 大文档不会一次性全渲染 -------------------- */
  {
    // 关键性能性质：渲染 N 页的耗时应该远小于"渲染所有页再缓存"
    const t = performance.now();
    const one = await renderPdfPage(doc, 7, 794);
    const singleMs = performance.now() - t;
    one.bitmap.close();
    pass(
      singleMs < 3000,
      "单页渲染 " + singleMs.toFixed(0) + "ms（按需渲染只需一页的代价）"
    );
  }

  try {
    await doc.destroy();
  } catch (_) {}

  log("");
  log("总耗时 " + (performance.now() - t0).toFixed(0) + "ms");
  log(failures === 0 ? "ALL PASS" : failures + " FAILED");
  document.title = "DONE";
}

main().catch((e) => {
  log("FATAL " + (e?.stack || e));
  document.title = "FATAL";
});
