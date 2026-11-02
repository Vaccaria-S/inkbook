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
 *   子集里没有的生僻字会画成方块（不会让整段消失）。
 *
 * 生成方式见 `tools/mksubset.mjs`；字体为 Noto Sans SC（SIL OFL 1.1）。
 */
import dataUrl from "../assets/NotoSansSC-subset.ttf";

let cached: Uint8Array | null = null;

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

/** 字体名（写进 PDF 的 BaseFont，仅作展示） */
export const CHINESE_FONT_NAME = "NotoSansSC-Subset";
