/**
 * 批注的排版（折行 + 位置夹取）。
 *
 * 为什么抽成纯函数：屏幕（DOM span）、画布（canvas）、导出（pdf-lib）
 * 三处都要知道「这段字断成哪几行、第一行基线在哪」，各写一遍必然出现
 * 「屏幕上两行、导出来三行、点不中第二行」；更要命的是**越界**——
 * 横向超出的字被页边界裁掉、纵向超出的行整行落到 /MediaBox 之外，
 * 症状都是「我自己打的那段字不完整」。
 * 折行/夹取本身不关心字体怎么量，宽度由调用方用 measure 注入，
 * 因为 CanvasRenderingContext2D.measureText 和 PDFFont.widthOfTextAtSize
 * 是两套毫不相干的 API。**单位约定：本文件所有长度都是"页面坐标"**
 * （794×1123 那套），导出端自己把 pt 度量除以 PT_PER_UNIT 再喂进来。
 */

/** 批注行高倍数（相对字号）。屏幕 DOM、导出 canvas、导出 PDF 三处必须一致 */
export const TEXT_LINE_HEIGHT = 1.32;

/** 批注右侧留白（页面坐标）：字不顶到纸边，折行后也不会压到裁切线 */
export const TEXT_RIGHT_MARGIN = 40;

/** 折行允许的最小可用宽度：贴着右边缘写的字，至少还能放几个 */
export const MIN_TEXT_WIDTH = 120;

/**
 * 用户手动拖出来的框宽下限（页面坐标）。
 * 不能沿用 MIN_TEXT_WIDTH：那是"自动排版"保证一行还能放几个字，
 * 而用户要的正是"一行只放 4 个字"这种窄框，120 会把窄框直接弹回去。
 * 取一个汉字多一点，保证 wrapText 不会因为宽度为 0 退化成一行一字。
 */
export const MIN_BOX_WIDTH = 24;

/** 纸张四边的物理安全边（页面坐标）：怎么折、怎么挪都不能画到这条线外 */
export const PAGE_SAFE_INSET = 8;

/**
 * 一段批注的可用折行宽度（页面坐标）。
 *
 * 两个约束要同时成立：
 *   · 理想宽度——右边留 TEXT_RIGHT_MARGIN，字不贴纸边；
 *   · 物理上限——x 已经贴到右边缘时，剩多少就只能用多少。
 *     只有下限没有上限的话，x=700 时「至少 120」会把每行右端推到 820 > 794，
 *     超出的部分被页边界裁掉，又是「字不完整」。
 * 但上限也不能退成 0：宽度 0 时一个字符都放不下，折行没有意义。
 *
 * 非有限值兜底（INK-193）：x 或 pageWidth 是 NaN/Infinity 时，原式会一路
 * 算出 NaN 宽度。wrapText 把 NaN maxWidth 当「非法」等价于**不折行**，
 * 长句就一路画出纸外被裁掉。存档层已经拦了脏值，但内存态（布局计算的中间量、
 * 外部直接构造的 PageText）仍可能传进来，所以在这里兜：
 *   · x 非有限 → 当作页左缘 0（这是"不知道在哪"里最安全的位置，宽度取满）；
 *   · pageWidth 非有限 → 当作 0，hardMax 至少保证 1，绝不返回 0/NaN。
 */
export function availableTextWidth(pageWidth: number, x: number): number {
  const pw = Number.isFinite(pageWidth) ? pageWidth : 0;
  const sx = Number.isFinite(x) ? x : 0;
  const hardMax = Math.max(1, pw - sx - PAGE_SAFE_INSET);
  const room = pw - sx - TEXT_RIGHT_MARGIN;
  return Math.min(Math.max(MIN_TEXT_WIDTH, room), hardMax);
}

/**
 * 新建/拖动批注时 x 的上限：再往右就连 MIN_TEXT_WIDTH 都放不下了，
 * 会变成"一行一个字"的窄柱。渲染时对老数据用更宽的安全网（见 reserveTextX）。
 */
export function maxTextStartX(pageWidth: number): number {
  return Math.max(0, pageWidth - MIN_TEXT_WIDTH - TEXT_RIGHT_MARGIN);
}

/** 渲染时的 x 上限：至少保证 MIN_TEXT_WIDTH 的可用宽度还在纸内 */
export function reserveTextX(pageWidth: number, x: number): number {
  return Math.min(Math.max(0, x), Math.max(0, pageWidth - MIN_TEXT_WIDTH - PAGE_SAFE_INSET));
}

/** 一段批注排好版的样子 */
export interface TextLayout {
  /** 夹取后的左端（页面坐标）：老文件里贴着右边缘的批注会往左收一点 */
  x: number;
  /** 夹取后的首行基线（页面坐标） */
  y: number;
  /** 折好的行（含用户自己的空行） */
  lines: string[];
  /** 行高（页面坐标 px，已乘字号）：相邻两行基线相差这么多 */
  lineHeight: number;
  /**
   * 实际生效的折行宽度（页面坐标）。
   * 屏幕绘制、命中判定、选中框、编辑框、文字层、导出、嵌入全部读这个值，
   * 不许各自再按 x 算一遍——算散了就会出现「屏幕上两行、导出三行」。
   */
  width: number;
  /**
   * 因纸面高度装不下而被裁掉的行数（0 = 全部显示）。
   *
   * 注意 `PageText.text` **不会**因为裁行而丢字——原文完整保存在数据里，
   * 这里只是「这一版排版显示不下」。用户调小字号或把框拖宽后，
   * 被裁的字会重新出现。UI 可以据此提示「还有 N 行未显示」。
   */
  hidden?: number;
}

/**
 * 批注的最终排版：折行 + 位置夹取。
 *
 * 屏幕绘制、导出 PDF、命中判定、选中框、属性条全部调它，规则只有一份。
 * 夹取的三件事：
 *   · x 别太靠右（否则每行只剩一两个字）；
 *   · 首行基线往下压，保证**最后一行**还在纸内——长批注往上顶，不往下溢；
 *   · 首行不能顶出页顶（留出字高）。
 *
 * 夹的是"排版结果"不是"数据"：渲染时把越界的老批注拉回纸内，
 * 用户不用重新排一遍，文件格式和版本都不用动。
 */
export function layoutUserText(
  t: { x: number; y: number; size: number; text: string; width?: number },
  pageWidth: number,
  pageHeight: number,
  measure: (s: string) => number
): TextLayout {
  const size = t.size > 0 ? t.size : 1;
  const x = reserveTextX(pageWidth, t.x);
  const avail = availableTextWidth(pageWidth, x);
  /*
   * 显式宽度优先，但仍要过纸面物理上限：
   * 用户把框拖到右边、或老数据 x 越界时，t.width 若超过 x 到纸右缘的余量，
   * 每行右端会被推出纸外，重演 INK-116 的「导出后那段字不完整」。
   * 非法值（0 / 负 / NaN / 非有限）一律当"没写"，回落自动算法，
   * 绝不把 0 喂给 wrapText（虽然它有兜底，但会退化成一行一个字）。
   */
  const custom = Number.isFinite(t.width) ? (t.width as number) : 0;
  const wrapW = custom > 0 ? Math.min(Math.max(custom, MIN_BOX_WIDTH), avail) : avail;
  let lines = wrapText(t.text, wrapW, measure);
  const lineHeight = size * TEXT_LINE_HEIGHT;
  /*
   * **纵向装不下要裁行，不能"从页顶画、底部溢出"**（INK-192）。
   *
   * 老实现只夹起点 y：内容比纸高时 yHigh 会被 max(yLow,…) 顶回 yLow，
   * 于是整段从页顶开始画，超出的行落到页底之外——屏幕上被
   * `.mb-page` 的 overflow:hidden 裁掉，导出 PDF 被 /MediaBox 裁掉，
   * **三处一致地整行消失**。实测：60 字 size=16 框宽 24 → 丢 8 行；
   * 200 字同尺寸 → 丢 148 行。用户看到的就是「我打的字不见了」。
   *
   * 现在的做法：先算「从 yLow 起最多能放几行」，超出的行**截断不渲染**。
   * `PageText.text` 本身一个字都不动（原文完整保存在数据里），
   * 只是这一版排版不显示超出的部分——用户把字号调小或把文字框拖宽，
   * 那些字会重新出现。
   *
   * `hidden` 回报被裁掉的行数，供 UI 提示「还有 N 行未显示」。
   */
  const maxLines = Math.max(
    1,
    Math.floor((pageHeight - PAGE_SAFE_INSET - size * 1.2) / lineHeight) + 1
  );
  const hidden = Math.max(0, lines.length - maxLines);
  if (hidden > 0) lines = lines.slice(0, maxLines);
  const last = Math.max(0, lines.length - 1);
  /*
   * 纵向夹取（裁行之后一定装得下，yHigh 不会小于 yLow）：
   *   · yLow：首行基线至少压到字高以下，否则整段顶出页顶；
   *   · yHigh：最后一行基线不越过安全边。
   */
  const yLow = size * 1.2;
  const yHigh = Math.max(yLow, pageHeight - PAGE_SAFE_INSET - last * lineHeight);
  const y = Math.min(Math.max(t.y, yLow), yHigh);
  return { x, y, lines, lineHeight, width: wrapW, hidden };
}

/**
 * 批注折行。
 *
 * 折行规则：
 *   · 用户敲的回车（\n）是硬换行，必须原样保留，空行也保留；
 *   · 每个硬行再按 maxWidth 逐字累加，加上下一个字符就超宽时断行；
 *   · 中文天然可以逐字断，不需要额外处理；
 *   · 西文优先在空格处断，但断出来的行太短（不足 60%）就干脆按宽度硬断
 *     ——否则一段英文会被空格切成一地碎片，反而更难读。
 *
 * 返回值拼起来（去掉换行）必须等于原文：折行只决定「在哪切」，
 * 不丢字、不加字。这条性质是导出端「一个字都不能少」的保证。
 */
export function wrapText(
  text: string,
  maxWidth: number,
  measure: (s: string) => number
): string[] {
  const out: string[] = [];
  // maxWidth 非法（0 / NaN / 负数）时无处可断，等价于「不折行」
  const limit = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : 0;

  for (const hard of String(text ?? "").split("\n")) {
    if (!hard) {
      // 空行是用户自己排的版：保留成一个空字符串，行高照算
      out.push("");
      continue;
    }

    let line = "";
    // 按码点切，别把 emoji / 代理对劈成两半
    for (const ch of Array.from(hard)) {
      const next = line + ch;
      if (line && limit > 0 && measure(next) > limit) {
        const sp = line.lastIndexOf(" ");
        /*
         * 空格断行的前提是「断出来的这行足够满」。
         * 留一个空格在行尾（而不是丢掉）——丢掉的话拼回去就少了空格，
         * 复制、搜索、导出都会对不上原文。
         */
        if (sp > 0 && measure(line.slice(0, sp + 1)) >= limit * 0.6) {
          out.push(line.slice(0, sp + 1));
          line = line.slice(sp + 1) + ch;
        } else {
          out.push(line);
          line = ch;
        }
      } else {
        line = next;
      }
    }
    // 单个字符就超宽时（maxWidth 极小）line 仍是那一个字，照样输出，不会死循环
    if (line) out.push(line);
  }

  return out;
}
