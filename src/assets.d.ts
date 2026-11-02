/** esbuild 的 dataurl loader：导入 .ttf 得到 `data:font/ttf;base64,…` 字符串 */
declare module "*.ttf" {
  const dataUrl: string;
  export default dataUrl;
}
