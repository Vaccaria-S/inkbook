/**
 * 导出 PDF 时嵌入的中文字体。
 *
 * 为什么必须自带一份：
 *   pdf-lib 内置的 StandardFonts（Helvetica 等）只有 WinAnsi 字符集，
 *   写中文会直接抛「WinAnsi cannot encode」。而 Obsidian 里拿不到系统字体文件
 *   （移动端没有 fs），所以只能在构建期把字体塞进包里。
 *
 * 为什么是子集：
 *   完整 Noto Sans SC 转 TTF 有 8MB+，base64 内联进 main.js 会到 11MB。
 *   这里按 GB2312（6763 汉字 + 常用符号，共 8280 字符）做子集，
 *   落到 ~1.85MB → base64 约 2.4MB，日常输入够用。
 *
 * 子集里没有的生僻字 / emoji：**不会画成方块**。导出时逐页扫批注，
 * 只要有一个码点不在字符集里，该页整页退回位图（看得见、但选不中）——
 * 见 `pageHasUnsupportedChars()` 与 INK-118。字符集拿不到时同样退回位图（保守）。
 *
 * 字体为 Noto Sans SC（SIL OFL 1.1），由构建期一次性子集化得到；
 * 生成脚本当时没有入库（`tools/mksubset.mjs` 已不存在），要重新生成得照
 * `assets/README.md` 记的来源与字符集重写一份。
 */
import fontkit from "@pdf-lib/fontkit";
import dataUrl from "../assets/NotoSansSC-subset.ttf";

let cached: Uint8Array | null = null;
let cachedCharset: Set<number> | null = null;

/** 取出字体字节（只解码一次，之后复用同一份 Uint8Array） */
export function chineseFontBytes(): Uint8Array {
  if (cached) return cached;
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  cached = out;
  return out;
}

/**
 * 字体能写出的 Unicode 码点集合（直接从字体文件解析）。
 *
 * 为什么不用 `PDFFont.getCharacterSet()`：那是 pdf-lib 挂在 PDFFont 上的
 * 非公开方法，具体实现随 embedder 变（subset 走 CustomFontSubsetEmbedder、
 * 非 subset 走 CustomFontEmbedder）。INK-118 把导出改成 `subset:false` 之后，
 * 继续依赖它等于把「集外字能否退回位图」这层兜底押在私有 API 上：哪天方法
 * 没了或返回空，`charset` 就是 null，而旧代码的 `if (!charset) return false`
 * 是**乐观放行** —— 集外字会被当矢量硬画成 .notdef 方块/空白，同时
 * `canvasWithText=false`（位图不画），字就真的丢了。
 *
 * 这里改用 fontkit 直接解析同一份字体字节：与导出用哪个 embedder 完全无关。
 * 拿不到就返回 null，由导出端按「保守」处理（退回位图），绝不静默放行。
 * 结果与 pdf-lib 的 getCharacterSet() 一致（实测都是 6182 个码点）。
 * 结果缓存：一本本子可能导出多次，没必要每次重解析 1.85MB 的 cmap。
 */
export function chineseCharacterSet(): Set<number> | null {
  if (cachedCharset) return cachedCharset;
  try {
    const font = fontkit.create(chineseFontBytes());
    const points = font.characterSet;
    if (!Array.isArray(points) || points.length === 0) return null;
    cachedCharset = new Set(points);
    return cachedCharset;
  } catch (e) {
    console.warn("[inkbook] 解析中文字体字符集失败，批注将按图片导出", e);
    return null;
  }
}
