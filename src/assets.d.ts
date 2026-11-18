/** esbuild 的 dataurl loader：导入 .ttf 得到 `data:font/ttf;base64,…` 字符串 */
declare module "*.ttf" {
  const dataUrl: string;
  export default dataUrl;
}

/**
 * esbuild 的 dataurl loader：导入 .woff2 得到 `data:font/woff2;base64,…` 字符串。
 *
 * 「手写」档的自带字体走这里（见 src/handfont.ts）。用 woff2 而不是 TTF：
 * 同一份字符集 woff2 是 1216KB，转 TTF 是 2491KB，内联 base64 差一倍。
 */
declare module "*.woff2" {
  const dataUrl: string;
  export default dataUrl;
}
