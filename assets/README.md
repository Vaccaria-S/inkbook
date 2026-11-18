# 字体资源

本目录放的是**构建期内联进 `main.js`** 的字体子集（esbuild 的 `dataurl` loader → base64）。
Obsidian 移动端没有文件系统，插件目录里的独立字体文件读不到，所以把字体随包内联。

## `NotoSansSC-subset.ttf`

导出 PDF 时嵌入的中文字体子集（批注要能选中 / 搜索，pdf-lib 只带西文）。

- 来源：Noto Sans SC Regular（Google Fonts）
- 许可：SIL Open Font License 1.1（见 `NotoSansSC-LICENSE.txt`）
- 字符集：GB2312 全字符 + ASCII

## `Xiaolai-subset.woff2`

「手写」字体档在屏幕上用的字体（小赖 / Xiaolai），运行时由 `src/handfont.ts`
经 `FontFace` 注册成家族名 `Inkbook Hand`。

- 来源：[`lxgw/kose-font`](https://github.com/lxgw/kose-font) 的 `Xiaolai-Regular.ttf`
- 许可：SIL Open Font License 1.1（见 `Xiaolai-LICENSE.txt`）

两份字体均以 SIL OFL 1.1 授权，版权归各自作者所有，仅作为构建原料随本仓库分发。
