import type { App, TFile } from "obsidian";
import type { InkBook, Page } from "./types";

/**
 * 全局搜索用的「文字索引」。
 *
 * 为什么要单独生成一份 md：
 *   Obsidian 的全局搜索只索引它能读的文本文件，`.inkbook` 是自定义格式
 *   （本质是 JSON），里面的字既搜不到也没有可读的上下文。
 *   所以在同一目录写一份 `本子名.墨本文字.md`，把每页的文字原样铺进去，
 *   搜索命中它，再点里面的链接跳回本子的某一页。
 *
 * 取舍：
 *   · 索引文件是**派生数据**，删掉不影响本子（下次保存会重建）；
 *   · 只放文字，不放笔迹、不放底图；
 *   · 每页限长，防止一本 300 页的 PDF 生成几 MB 的索引拖慢搜索。
 */

/** 索引文件后缀。带「墨本」两字，用户一眼知道它是怎么来的 */
export const INDEX_SUFFIX = ".墨本文字.md";

/** 单页最多索引这么多字符（约 200 行中文），超出的部分截断 */
const MAX_PAGE_CHARS = 12000;

/** 一整本最多索引这么多字符，防止极端文件把库拖垮 */
const MAX_BOOK_CHARS = 800000;

/** 索引文件的路径：与本子同目录、同名前缀 */
export function indexPathFor(file: TFile): string {
  const dir = file.parent && file.parent.path && file.parent.path !== "/" ? `${file.parent.path}/` : "";
  const base = (file.basename || "未命名").replace(/\.inkbook$/i, "");
  return `${dir}${base}${INDEX_SUFFIX}`;
}

/**
 * 一页里可以搜的文字。
 *
 * 按 y 从上到下排，PDF 原文与手动添加的文字混在一起——
 * 用户在纸上看到什么顺序，索引里就是什么顺序。
 */
function pageText(page: Page): string {
  const items = (page.texts ?? [])
    .map((t) => ({ y: Number(t.y) || 0, text: (t.text || "").trim() }))
    .filter((x) => x.text.length > 0);
  if (!items.length) return "";
  items.sort((a, b) => a.y - b.y);
  let out = items.map((x) => x.text).join("\n");
  if (out.length > MAX_PAGE_CHARS) {
    out = `${out.slice(0, MAX_PAGE_CHARS)}\n…（本页文字较长，索引在此截断）`;
  }
  return out;
}

/**
 * 生成索引 md 的正文。
 *
 * 纯函数、不碰磁盘：测试里可以直接比字符串。
 * 跳页链接用 `obsidian://inkbook?file=…&page=N`，
 * 由 main.ts 的协议处理器接住（打开本子并滚到那一页）。
 */
export function buildIndexMarkdown(file: TFile, book: InkBook): string {
  const lines: string[] = [];
  lines.push(`# ${file.basename || "未命名"} · 文字索引`);
  lines.push("");
  lines.push("> 这个文件由**墨本**自动生成，用来让 Obsidian 的全局搜索能搜到这本手写本里的文字。");
  lines.push("> 删掉它不影响本子；下次保存会自动重建。");
  lines.push("");

  const path = encodeURIComponent(file.path);
  let budget = MAX_BOOK_CHARS;
  let pages = 0;

  book.pages.forEach((page, i) => {
    if (budget <= 0) return;
    const text = pageText(page);
    if (!text) return;
    const clipped = text.length > budget ? text.slice(0, budget) : text;
    budget -= clipped.length;
    pages += 1;
    lines.push(`## 第 ${i + 1} 页`);
    lines.push("");
    lines.push(clipped);
    lines.push("");
    lines.push(`[打开第 ${i + 1} 页](obsidian://inkbook?file=${path}&page=${i + 1})`);
    lines.push("");
  });

  if (!pages) {
    lines.push("（这本还没有可搜索的文字：普通纸页只有笔迹；导入的 PDF 若是扫描版，也没有文字层。）");
    lines.push("");
  } else if (budget <= 0) {
    lines.push("> 索引已达长度上限，后面的页面没有收进来。");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 写索引文件。
 *
 * 内容没变就不写：每次保存都重写一遍会让同步盘一直忙，
 * 也会让 Obsidian 反复重解析这个 md。
 *
 * 失败只记日志、不抛给调用方——索引是附属品，不能因为它坏了就报「保存失败」。
 */
export async function writeTextIndex(app: App, file: TFile, book: InkBook): Promise<void> {
  const path = indexPathFor(file);
  const content = buildIndexMarkdown(file, book);
  const adapter = app.vault.adapter;
  try {
    if (await adapter.exists(path)) {
      const old = await adapter.read(path);
      if (old === content) return;
    }
    await adapter.write(path, content);
  } catch (e) {
    console.warn("[inkbook] 写文字索引失败（不影响本子保存）", e);
  }
}

/** 删掉索引（本子被删/改名时用；失败也无所谓，它只是派生数据） */
export async function removeTextIndex(app: App, file: TFile): Promise<void> {
  const path = indexPathFor(file);
  try {
    const adapter = app.vault.adapter;
    if (await adapter.exists(path)) await adapter.remove(path);
  } catch (_) {
    /* 派生数据，删不掉不算错 */
  }
}
