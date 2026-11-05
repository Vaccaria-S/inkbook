# assets/NotoSansSC-subset.ttf

导出 PDF 时嵌入的中文字体子集。

- **来源**：Noto Sans SC Regular（Google Fonts 版，取自 npm 包 `@fontsource/noto-sans-sc`）
- **许可**：SIL Open Font License 1.1（见 `NotoSansSC-LICENSE.txt`）
- **生成**：构建期一次性子集化，产出约 1851KB。
  ⚠️ 当时的生成脚本 `tools/mksubset.mjs` **没有入库**（现在仓库里不存在），
  要重新生成需按下面的来源自己重写：`@fontsource/noto-sans-sc` 的
  `noto-sans-sc-chinese-simplified-400-normal.woff2`（1.1MB）
  → `subset-font`（harfbuzz wasm）+ GB2312 全字符集（8280 字）→ TTF。
- **字符集**：GB2312 全字符（6763 汉字 + 符号，共 8280 字符）+ ASCII

只改这个文件的话不用动代码；扩大字符覆盖后 main.js 会跟着变大（base64 是 4/3 倍）。
**不要再对这份 TTF 做二次子集化**（见 `技术约定-墨本.md` 的 INK-118）。
