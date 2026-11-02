# assets/NotoSansSC-subset.ttf

导出 PDF 时嵌入的中文字体子集。

- **来源**：Noto Sans SC Regular（Google Fonts 版，取自 npm 包 `@fontsource/noto-sans-sc`）
- **许可**：SIL Open Font License 1.1（见 `NotoSansSC-LICENSE.txt`）
- **生成**：`node tools/mksubset.mjs`（可重复执行，产出字节稳定约 1851KB）
- **字符集**：GB2312 全字符（6763 汉字 + 符号，共 8280 字符）+ ASCII

只改这个文件的话不用动代码；要扩大字符覆盖就改 `tools/mksubset.mjs`
里的字符集，重新生成后 main.js 会跟着变大（base64 是 4/3 倍）。
