import type { App } from "obsidian";
import { ensureBookDataDir } from "./indexer";

/**
 * 「在笔记里插入图片」的素材与几何工具。
 *
 * 只做三件与具体 UI 无关的事：
 *   · 认哪些是图片、文件选择器该给什么 accept；
 *   · 把用户选的图片字节写进本子的数据叶子（墨本文件/<token>.墨本/）；
 *   · 读出图片的原始像素尺寸，并算一个合适的默认摆放矩形。
 *
 * 为什么要单独成文件：素材写入、尺寸测量、默认摆放是三处独立逻辑，
 * 摊进 view.ts 会让"资源引用规则"散落各处。集中在这里，明确"图存哪、
 * 引用怎么写"，与 Word 底板（importer.ts）走同一套 ensureBookDataDir + writeBinary。
 */

/** 支持的图片扩展名（只用光栅格式；SVG 的脚本/外链在自绘 canvas 里没保障） */
export const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"];

/** 判断一个文件名是不是可插入的图片 */
export function isImageFileName(name: string): boolean {
  const ext = String(name || "").split(".").pop()?.toLowerCase() || "";
  return IMAGE_EXTS.includes(ext);
}

/**
 * 文件选择器的 accept 串。
 *
 * 与 ImportSourceModal 同样的坑：安卓 SAF 按 **MIME** 过滤，只给扩展名会
 * 匹配不到任何类型（列表全灰）。所以扩展名和 MIME 都要写，末尾再补
 * `image/*` 兜底（系统里有的格式 MIME 写不全时也能选到）。
 */
export function imageAcceptAttr(): string {
  return [
    ".png",
    "image/png",
    ".jpg",
    ".jpeg",
    "image/jpeg",
    ".webp",
    "image/webp",
    ".gif",
    "image/gif",
    ".bmp",
    "image/bmp",
    ".avif",
    "image/avif",
    "image/*",
  ].join(",");
}

/** 文件名主干清洗：去掉路径分隔符与非法字符，保留合法扩展名 */
function safeStem(name: string): { stem: string; ext: string } {
  const raw = String(name || "");
  const dot = raw.lastIndexOf(".");
  const stem0 = dot > 0 ? raw.slice(0, dot) : raw;
  const ext = dot > 0 ? raw.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  let stem = stem0
    .replace(/[\\/:*?"<>|#^[\]]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  if (!stem) stem = "image";
  if (stem.length > 60) stem = stem.slice(0, 60).trim() || "image";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = "_" + stem;
  return { stem, ext: IMAGE_EXTS.includes(ext) ? ext : "png" };
}

/**
 * 把一张图片的字节写进本子的数据叶子，返回库内路径。
 *
 * 命名 `img-<时间戳>-<主干>.<ext>`，冲突时加 `-2`、`-3`。时间戳在里面
 * 是为了让"同一张图插两次"也能各自独立（删一张不影响另一张）。
 * 与 Word 底板一致：用 `adapter.writeBinary` 直接落盘（绕开 vault 文件表也能
 * 被 `getResourcePath` 读到），除非调用方明确要 TFile，否则不建 vault 条目。
 */
export async function saveImageAsset(
  app: App,
  bookPath: string,
  fileName: string,
  bytes: ArrayBuffer
): Promise<string> {
  const adapter = app.vault.adapter as any;
  const dir = await ensureBookDataDir(app, bookPath);
  const { stem, ext } = safeStem(fileName);
  const stamp = Date.now();
  let path = `${dir}/img-${stamp}-${stem}.${ext}`;
  let n = 1;
  while (await adapter.exists(path)) {
    path = `${dir}/img-${stamp}-${stem}-${++n}.${ext}`;
  }
  await adapter.writeBinary(path, bytes);
  return path;
}

/** 16:10 的兜底比例：图片宽高读不出来时用它，保证能摆一个像样的框 */
const FALLBACK_RATIO = 1.6;

/**
 * 读一个图片 URL 的原始像素尺寸。
 *
 * 用 `<img>` 的 naturalWidth/Height：Electron / 平板 WebView 都能读，
 * 不依赖 `createImageBitmap`（个别 WebView 没有）。带上超时，读到就返回，
 * 读不出（损坏、格式不支持、URL 失效）返回 null，由调用方退到兜底比例。
 */
export function measureImageUrl(url: string, timeoutMs = 15000): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const finish = (v: { width: number; height: number } | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(v);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      finish(w > 0 && h > 0 ? { width: w, height: h } : null);
    };
    img.onerror = () => finish(null);
    img.src = url;
  });
}

/** 从一段字节读尺寸（device 选来的文件，还没有库内路径时用） */
export async function measureImageBytes(buf: ArrayBuffer, mime?: string): Promise<{ width: number; height: number } | null> {
  let url = "";
  try {
    url = URL.createObjectURL(new Blob([buf], { type: mime || "application/octet-stream" }));
    return await measureImageUrl(url);
  } catch (_) {
    return null;
  } finally {
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {
        /* 忽略 */
      }
    }
  }
}

/**
 * 算一个默认摆放矩形：按原始比例缩进「页面的一小块」，以 (cx,cy) 为中心。
 *
 * 默认最多占页宽 62%、页高 70%（A4 794×1123 → 最宽约 492、最高约 786），
 * 小图不放大（scale ≤ 1），避免把小图标吹成一团糊。最后整体夹在纸内留 8px 边。
 */
export function fitImageRect(
  naturalW: number,
  naturalH: number,
  pageW: number,
  pageH: number,
  cx: number,
  cy: number
): { x: number; y: number; width: number; height: number } {
  let w = Number.isFinite(naturalW) && naturalW > 0 ? naturalW : 0;
  let h = Number.isFinite(naturalH) && naturalH > 0 ? naturalH : 0;
  if (w <= 0 || h <= 0) {
    // 读不到尺寸 → 兜底比例，按页宽 40% 给个能看见的框
    w = pageW * 0.4;
    h = w / FALLBACK_RATIO;
  }
  const maxW = pageW * 0.62;
  const maxH = pageH * 0.7;
  const scale = Math.min(1, maxW / w, maxH / h);
  const width = Math.max(8, w * scale);
  const height = Math.max(8, h * scale);
  const margin = 8;
  const x = Math.max(margin, Math.min(cx - width / 2, pageW - width - margin));
  const y = Math.max(margin, Math.min(cy - height / 2, pageH - height - margin));
  return { x, y, width, height };
}
