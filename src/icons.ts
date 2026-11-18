/**
 * 自带图标系统。
 *
 * 为什么不用 Obsidian 的 `setIcon`：
 *
 *   1. **图标名可能不存在。** Obsidian 的 `setIcon` 走它自己内置的
 *      Lucide 版本，`pen-tool`、`highlighter`、`panel-right` 这些
 *      较新的名字在旧版里查不到——查不到时它**什么都不画**，
 *      按钮就成了一个空框（用户反馈"每一个框里面看不到图标"）。
 *   2. **主题能改尺寸。** `.svg-icon` 是 Obsidian 的公共类，
 *      主题可以给它写 `width`/`height`/`stroke-width`，
 *      我们的规则得靠不断提高特异性去跟主题打架，打不赢就图标变没。
 *
 * 所以这里自绘一套：路径来自 Lucide（ISC 许可），
 * 用自己的 class `mb-ic`，尺寸交给 CSS，主题碰不到。
 */

/** 图标名 → SVG path 的 d 属性（Lucide，24×24 视框） */
const ICONS: Record<string, string> = {
  /* 书写工具 */
  "pen-tool": "M12 19l7-7 3 3-7 7-3-3z M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z M2 2l7.6 7.6 M11 11l-2 2",
  pencil: "M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  highlighter:
    "M9 11l-6 6v3h9l3-3 M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4l8 8z",
  eraser:
    "M7 21l-4.3-4.3a2 2 0 0 1 0-2.8l9.6-9.6a2 2 0 0 1 2.8 0l5.6 5.6a2 2 0 0 1 0 2.8L14 21H7z M22 21H7 M5 11l9 9",
  /*
   * 激光笔：一支斜握的指示笔 + 射向远端的细光柱 + 光点 / 星芒。
   * 之前按钮用的是 "zap"，本图标表里没有这个名字 → 回退成方块（用户反馈
   * 「激光笔的图标重绘」）。这里按激光笔该有的样子重画：笔身 + 光束 + 端点。
   */
  "laser-pointer":
    "M4 20l2.6-.7 8.2-8.2-1.9-1.9-8.2 8.2L4 20z " +
    "M12.8 7.2l1.9 1.9 " +
    "M16.4 8.2l4-4 " +
    "M20.4 2.6h.01 M21.4 5.4h.01 M18 2.2h.01",
  type: "M4 7V4h16v3 M9 20h6 M12 4v16",
  cursor: "M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.13 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.12a.5.5 0 0 1-.95.06z",
  square: "M3 3h18v18H3z",
  /*
   * 手：四根手指 + 掌 + 向左伸出的拇指。
   *
   * 原来那条 lucide 路径的指尖挤在一起、掌部又一大片，18px 下像只连指手套
   * （用户：「这个小手有点丑」）。这里重画成四根等宽圆头手指（长短依次
   * 递减，一眼能数出四根）、一个圆底手掌，拇指从掌左侧单独伸出；
   * 仍然是单条 d，iconSvg 只生成一个 <path>。
   */
  hand:
    "M7.5 12.5V8.2a1.35 1.35 0 0 1 2.7 0v4.3 " +
    "M10.2 12V6.6a1.35 1.35 0 0 1 2.7 0V12 " +
    "M12.9 12V7.2a1.35 1.35 0 0 1 2.7 0v4.8 " +
    "M15.6 12.5V9.2a1.35 1.35 0 0 1 2.7 0v3.4 " +
    "M7.5 12.5v3.4c0 3 2.4 5.4 5.4 5.4h.1c3 0 5.4-2.4 5.4-5.4v-3.2 " +
    "M7.5 14.6 5 13.1a1.45 1.45 0 0 0-1.5 2.5l4.4 2.9",

  /* 界面 */
  eye: "M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  "eye-off":
    "M17.9 17.9A10 10 0 0 1 12 20C5 20 2 12 2 12a18 18 0 0 1 5.1-5.9 M9.9 4.2A10 10 0 0 1 12 4c7 0 10 8 10 8a18 18 0 0 1-2.1 3.2 M14.1 14.1a3 3 0 1 1-4.2-4.2 M2 2l20 20",
  "panel-right": "M3 3h18v18H3z M15 3v18",
  "panel-right-close": "M3 3h18v18H3z M15 3v18 M9 10l3 3-3 3",
  "panel-right-open": "M3 3h18v18H3z M15 3v18 M12 9l3 3-3 3",
  sliders: "M4 6h10 M18 6h2 M4 12h4 M12 12h8 M4 18h12 M20 18h0 M14 4v4 M8 10v4 M16 16v4",
  "undo-2": "M9 14L4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  "redo-2": "M15 14l5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
  "trash-2": "M3 6h18 M8 6V4h8v2 M19 6l-1 14H6L5 6 M10 11v6 M14 11v6",
  plus: "M5 12h14 M12 5v14",
  minus: "M5 12h14",
  x: "M18 6L6 18 M6 6l12 12",
  check: "M20 6L9 17l-5-5",
  copy: "M8 8h12v12H8z M4 16V4h12",
  import: "M12 3v12 M7 10l5 5 5-5 M4 21h16",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3",
  /*
   * 导入 / 导出：用「带箭头的文件」区分，别再用 import / download。
   * 用户反馈这两个图标太像，分不清哪个是导入哪个是导出。
   *   · file-input：箭头指向文件（进来）
   *   · file-output：箭头离开文件（出去）
   */
  "file-input":
    "M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4 M14 2v4a2 2 0 0 0 2 2h4 M2 15h10 M9 18l3-3-3-3",
  "file-output":
    "M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4 M14 2v4a2 2 0 0 0 2 2h4 M2 15h10 M5 12l3 3-3 3",
  /*
   * 导出：三点连线（Lucide share-2）。原来用 file-output 与 file-input 太像，
   * 换成这个形状完全不同的「发送/导出」符号。
   * ⚠️ 必须把 path 补进本表：setIcon 查不到名字会回退成 ICONS["square"]
   * （用户看到的「就一个正方形」就是回退造成的）。
   */
  "share-2":
    "M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M8.6 13.5l6.8 4 M15.4 6.5l-6.8 4",
  /*
   * 软盘 = "保存"，一眼就懂。
   * 外框 + 抽屉 + 上方滑块三段画在**同一条** d 里（用空格分隔），
   * 因为 iconSvg 只生成一个 <path>；拆成多个 path 得改图标系统。
   */
  save: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z M17 21v-8H7v8 M7 3v5h8",
  image: "M3 3h18v18H3z M3 16l5-5 4 4 3-3 6 6",
  "file-text": "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h8",
  "layout-template": "M3 3h18v18H3z M3 9h18 M9 21V9",
  /* 缩略图网格：四个小方块（Lucide layout-grid），一眼看出是缩略图，不再是单个方框 */
  "layout-grid": "M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z",
  layers: "m12 2 10 5-10 5L2 7l10-5Z m-10 10 10 5 10-5 M2 17l10 5 10-5",
  list: "M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01",
  tablet: "M4 2h16v20H4z M12 18h.01",
  notebook: "M3 3h15a3 3 0 0 1 3 3v15H6a3 3 0 0 1-3-3V3z M8 3v18 M3 8h5",
  "book-open": "M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z",
  "zoom-in": "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3 M11 8v6 M8 11h6",
  "zoom-out": "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3 M8 11h6",
  maximize: "M8 3H5a2 2 0 0 0-2 2v3 M21 8V5a2 2 0 0 0-2-2h-3 M3 16v3a2 2 0 0 0 2 2h3 M16 21h3a2 2 0 0 0 2-2v-3",
  percent: "M19 5 5 19 M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  "chevron-left": "M15 18l-6-6 6-6",
  "chevron-right": "M9 18l6-6-6-6",
  "chevron-down": "M6 9l6 6 6-6",
  "chevron-up": "M18 15l-6-6-6 6",
  "mouse-pointer-2": "M4 4l7 17 3-7 7-3z",
  /* 顶栏「在当前笔记中查找」：Lucide search（放大镜，别和 zoom-in 的 + 号混） */
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3",
  /* 侧栏「收藏」：Lucide star 轮廓；选中态由 CSS 给 fill 变成实心 */
  star: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z",
};

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * 生成一个图标 SVG 元素。
 *
 * 尺寸写死成 24×24 的属性值——这样即使样式表没加载到，
 * 它也是 24px 而不是撑满容器；同时 CSS 可以按场景覆盖。
 */
export function iconSvg(name: string): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "mb-ic");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name] || ICONS["square"]);
  svg.appendChild(path);
  return svg;
}

/**
 * 把图标放进元素里（会先清空元素内容）。
 *
 * 跟 Obsidian 的 `setIcon` 行为一致，方便整份替换。
 */
export function setIcon(el: HTMLElement, name: string): void {
  el.empty?.();
  while (el.firstChild) el.removeChild(el.firstChild);
  el.appendChild(iconSvg(name));
}
