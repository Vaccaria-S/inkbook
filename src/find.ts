/**
 * 笔记内「查找文字」的纯逻辑。
 *
 * 为什么单独一份：墨本的一个 `.inkbook` 是单个 JSON，正文分散在每页的
 * `texts[]`（PDF / Word 原文 + 手动批注）里，并不是 Obsidian 编辑器里的
 * 一段 Markdown —— 宿主自带的「在当前文件内搜索」只认识 CodeMirror 的
 * 文档，看不到画布上的文字，所以这里把「搜什么、命中在哪」做成与 DOM
 * 无关的纯函数：视图负责出 UI，编辑器负责高亮，测试可以直接喂数据。
 *
 * 约定与 Obsidian 的文件内搜索一致：
 *   · 大小写不敏感（`toLowerCase`，中文不受影响）；
 *   · 同一段文字里多次出现各算一条，互不重叠（从上一处末尾继续找）；
 *   · 命中用**原文**的起止下标表示，高亮时再映射到屏幕上的排版文本。
 */

import type { Page } from "./types";

/** 一处命中：第几页（0 起）+ 哪段文字 + 在原文里的起止下标（左闭右开）。 */
export interface FindMatch {
  page: number;
  textId: string;
  start: number;
  end: number;
}

/**
 * 单次查找最多收集多少条命中。
 *
 * 一个 800 页 PDF 本子里搜一个「的」可能是几万条。全收下来既占内存，
 * 逐条渲染也毫无意义（用户不可能按几万次「下一个」），所以封顶；
 * 超出时仍按前 N 条工作，不会因为一条回车把主线程卡住。
 */
export const MAX_FIND_MATCHES = 5000;

/** 在**一段文字**里找全部命中（大小写不敏感、不重叠）。 */
export function findInText(
  text: string,
  query: string,
  limit = Number.POSITIVE_INFINITY
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const needle = String(query ?? "");
  if (!needle) return out;
  const hay = String(text ?? "").toLowerCase();
  const low = needle.toLowerCase();
  if (!low) return out;
  let from = 0;
  while (out.length < limit) {
    const at = hay.indexOf(low, from);
    if (at < 0) break;
    out.push({ start: at, end: at + low.length });
    from = at + low.length;
  }
  return out;
}

/**
 * 在一整本笔记里查找：按页、按段的顺序逐条列出命中。
 *
 * `query` 为空（或全是能被忽略的空串）时返回空数组——调用方据此显示
 * `0/0` 并清掉高亮。
 */
export function findInNote(pages: Page[], query: string, limit = MAX_FIND_MATCHES): FindMatch[] {
  const out: FindMatch[] = [];
  const needle = String(query ?? "");
  if (!needle) return out;
  for (let page = 0; page < pages.length && out.length < limit; page++) {
    const texts = pages[page]?.texts;
    if (!texts || !texts.length) continue;
    for (const t of texts) {
      if (out.length >= limit) break;
      for (const hit of findInText(t.text, needle, limit - out.length)) {
        out.push({ page, textId: t.id, start: hit.start, end: hit.end });
      }
    }
  }
  return out;
}

/**
 * 某段文字里，排在 `before` 下标之前的命中条数。
 *
 * 用来把「原文里的第几个命中」对应到「屏幕上排版文本里的第几个命中」：
 * 用户批注会被 `wrapText` 插入换行，屏幕文本的字符下标和原文不再一一相等，
 * 但只要按出现顺序数，就能稳定对上（见 editor.renderTextLayer 的高亮）。
 */
export function countMatchesBefore(text: string, query: string, before: number): number {
  let n = 0;
  for (const hit of findInText(text, query)) {
    if (hit.start >= before) break;
    n++;
  }
  return n;
}
