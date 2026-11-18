/**
 * 笔记内的 `[[双链]]` 解析。
 *
 * 墨本把批注文字存成纯字符串（`PageText.text`），不像 Markdown 那样有原生
 * 双链。这里从字符串里认出去 Obsidian 风格的三种写法：
 *   · `[[目标]]`
 *   · `[[目标|显示名]]`
 *   · `[[目标#标题]]`（`.inkbook#页码` 时解析出页码）
 * 渲染层据此把链接部分画成强调色 + 下划线，点击时据此打开目标。
 *
 * 纯字符串处理，不碰 DOM / 文件系统，方便单测。
 */
/** 一个可被 `[[...]]` 链接到的文件（供「插入双链」弹窗与 `[[` 自动补全共用）。 */
export interface LinkTarget {
  /** 真正插进文字里的链接名：Markdown 用不带扩展名的 basename，`.inkbook` 用带扩展名的文件名 */
  name: string;
  /** 列表里显示的名字（basename，不含 `.md` / `.inkbook`） */
  label: string;
  /** 类型，只用来在候选行尾显示「笔记 / 手写本」 */
  kind: "note" | "inkbook";
  /** 库内路径，列表悬浮提示用（不参与插入） */
  path: string;
}

export interface WikiLink {
  /** 整个 `[[...]]` 在原文里的起止（start 含、end 不含），用于 DOM 切片 */
  start: number;
  end: number;
  /** 链接目标：去掉 `|显示名` 与 `#标题`、trim 过的名字（不含 `#`） */
  target: string;
  /** 目标 + 可选标题，给 `workspace.openLinkText` 用；不含别名 */
  href: string;
  /** 显示名（别名优先，否则 target#标题） */
  label: string;
  /**
   * 屏幕上实际显示的文字：像原生 Obsidian 一样**去掉 `[[ ]]` 语法**，
   * 别名优先，否则用目标名（`.inkbook` 去掉扩展名）；带标题/页码时附在
   * 目标名后。编辑态显示的仍是原文（含括号），不读这个字段。
   */
  display: string;
  /** `.inkbook#数字` 时解析出的页码（1 起），否则 undefined */
  page?: number;
}

/**
 * `[[...]]`：内部不含方括号和换行（换行会把折行位置和括号错开，
 * 且跨行双链没有现实意义）。非贪婪，允许内部出现 `|` 与 `#`。
 */
const WIKILINK_RE = /\[\[([^\[\]\n]+?)\]\]/g;

/** 解析一段文字里的全部双链，按出现顺序返回。 */
export function findWikiLinks(text: string): WikiLink[] {
  const src = String(text ?? "");
  const out: WikiLink[] = [];
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(src))) {
    const start = m.index;
    const end = start + m[0].length;
    let inner = m[1];
    // 别名：`[[目标|显示]]`，只在第一个 `|` 处切
    let alias: string | null = null;
    const pipe = inner.indexOf("|");
    if (pipe >= 0) {
      alias = inner.slice(pipe + 1);
      inner = inner.slice(0, pipe);
    }
    inner = inner.trim();
    if (!inner) continue;
    // 标题 / 页码：`[[目标#标题]]`
    let name = inner;
    let heading: string | null = null;
    const hash = inner.indexOf("#");
    if (hash >= 0) {
      name = inner.slice(0, hash);
      heading = inner.slice(hash + 1);
    }
    name = name.trim();
    if (!name) continue;
    const href = heading && heading.length ? `${name}#${heading}` : name;
    let page: number | undefined;
    // 只有 `.inkbook` 目标 + 纯数字标题才当页码；普通笔记的 `#3` 是标题锚点
    if (/\.inkbook$/i.test(name) && heading && /^\d+$/.test(heading.trim())) {
      const n = parseInt(heading.trim(), 10);
      if (n >= 1) page = n;
    }
    const label = (alias && alias.trim()) || (heading ? `${name}#${heading}` : name);
    // 屏幕显示文字：隐藏 `[[ ]]` 语法，像原生 Obsidian 的链接外观
    const baseName = name.replace(/\.inkbook$/i, "");
    let display: string;
    if (alias && alias.trim()) display = alias.trim();
    else if (page != null) display = `${baseName} · 第 ${page} 页`;
    else if (heading && heading.trim()) display = `${baseName} > ${heading.trim()}`;
    else display = baseName;
    out.push({ start, end, target: name, href, label, display, page });
  }
  return out;
}

/**
 * 把一段文字里的双链语法换成像原生 Obsidian 的显示文字（去掉 `[[ ]]`、
 * 别名/标题按 `WikiLink.display` 处理）。屏幕 DOM 与画布/导出共用这一份，
 * 避免「屏幕隐藏了括号、导出却还在」的两套外观。
 */
export function stripWikiLinkSyntax(text: string): string {
  const src = String(text ?? "");
  const links = findWikiLinks(src);
  if (!links.length) return src;
  let out = "";
  let cursor = 0;
  for (const link of links) {
    out += src.slice(cursor, link.start) + link.display;
    cursor = link.end;
  }
  return out + src.slice(cursor);
}

/** 这段文字里有没有双链（轻量判断 / 测试用）。 */
export function hasWikiLink(text: string): boolean {
  return findWikiLinks(text).length > 0;
}
