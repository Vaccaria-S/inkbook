import type { App, TFile } from "obsidian";
import type { InkBook, Page } from "./types";

/**
 * 全局搜索用的「文字索引」。
 *
 * 为什么不能直接搜 `.inkbook`：
 *   Obsidian 的全局搜索只索引它能读的文本文件，`.inkbook` 是 JSON，
 *   既搜不到，也没有可读的定位信息。
 *
 * 为什么**一页一个 md**，而不是一本一个大 md：
 *   一个大 md 的问题是：搜到了「第 12 页」，点开却停在索引文件里，
 *   还得再点一次链接才回到本子——用户原话是「还是会跳到 Markdown，
 *   而不是直接跳到我的笔记文件」。
 *   一页一个文件之后，可以监听 file-open：打开索引页就立刻换成
 *   对应的 `.inkbook` 并滚到那一页——搜索 → 点结果 → 直接落在纸上。
 *
 * 代价是文件多（有文字的页才有文件，通常远少于总页数），
 * 集中放在 `<本子名>.墨本索引/` 目录里，不影响本子本身。
 */
export const INDEX_DIR_SUFFIX = ".墨本索引";

/** 旧方案（一本一个 md）的文件名后缀，遇到就删掉 */
export const LEGACY_INDEX_SUFFIX = ".墨本文字.md";

/** 索引页文件名：`第 12 页.md` */
const PAGE_FILE_RE = /^第 (\d+) 页\.md$/;

/** 单页最多索引这么多字符（约 200 行中文），超出截断 */
const MAX_PAGE_CHARS = 12000;

function dirOf(file: TFile): string {
  return file.parent && file.parent.path && file.parent.path !== "/" ? `${file.parent.path}/` : "";
}

function baseOf(file: TFile): string {
  return (file.basename || "未命名").replace(/\.inkbook$/i, "");
}

/** 索引目录：与本子同目录、同名前缀 */
export function indexDirFor(file: TFile): string {
  return `${dirOf(file)}${baseOf(file)}${INDEX_DIR_SUFFIX}`;
}

/** 某一页的索引文件路径 */
export function indexPagePath(file: TFile, pageNo: number): string {
  return `${indexDirFor(file)}/第 ${pageNo} 页.md`;
}

/** 旧方案的单文件路径（用于清理） */
export function legacyIndexPath(file: TFile): string {
  return `${dirOf(file)}${baseOf(file)}${LEGACY_INDEX_SUFFIX}`;
}

/**
 * 从索引页路径反查「本子路径 + 页码」。
 *
 * main.ts 的 file-open 钩子用它：打开的是索引页时，换成对应本子那一页。
 * 不是索引页就返回 null。
 */
export function parseIndexPath(path: string): { bookPath: string; page: number } | null {
  const m = path.match(/^(.*)\.墨本索引\/第 (\d+) 页\.md$/);
  if (!m) return null;
  const page = Number(m[2]);
  if (!Number.isFinite(page) || page < 1) return null;
  return { bookPath: `${m[1]}.inkbook`, page };
}

/**
 * 一页里可以搜的文字，按 y 从上到下。
 *
 * PDF 原文与手动添加的文字混在一起——纸上什么顺序，索引里就是什么顺序。
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
 * 生成一页索引 md。
 *
 * 第一行标题带本子名与页码，搜索结果里一眼能看出是「哪本的哪一页」。
 * 末尾保留一条协议链接：万一自动跳转没生效（比如从别的客户端打开），
 * 还能手动点回本子。
 */
export function buildPageIndex(file: TFile, book: InkBook, pageIndex: number): string {
  const text = pageText(book.pages[pageIndex] || ({} as Page));
  const pageNo = pageIndex + 1;
  const path = encodeURIComponent(file.path);
  const lines: string[] = [];
  lines.push(`# ${file.basename || "未命名"} · 第 ${pageNo} 页`);
  lines.push("");
  lines.push("> 墨本自动生成的索引页。打开它会直接跳回手写本对应页；删掉不影响本子，下次保存会重建。");
  lines.push("");
  if (text) {
    lines.push(text);
    lines.push("");
  }
  lines.push(`[回到「${file.basename || "未命名"}」第 ${pageNo} 页](obsidian://inkbook?file=${path}&page=${pageNo})`);
  lines.push("");
  return lines.join("\n");
}

interface AdapterLike {
  exists: (path: string) => Promise<boolean>;
  read: (path: string) => Promise<string>;
  write: (path: string, data: string) => Promise<void>;
  mkdir?: (path: string) => Promise<void>;
  remove?: (path: string) => Promise<void>;
  list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
}

/**
 * 写索引：有文字的页各写一个文件，清掉多余的旧页与旧版单文件。
 *
 * 内容没变就不写（省同步与重解析）。失败只记日志——
 * 索引是附属品，不能因为它坏了就把「保存成功」报成失败。
 */
export async function writeTextIndex(app: App, file: TFile, book: InkBook): Promise<void> {
  const dir = indexDirFor(file);
  const adapter = app.vault.adapter as unknown as AdapterLike;
  try {
    if (!(await adapter.exists(dir))) {
      if (typeof adapter.mkdir !== "function") return;
      await adapter.mkdir(dir);
    }

    const wanted = new Set<string>();
    for (let i = 0; i < book.pages.length; i += 1) {
      const pageNo = i + 1;
      const path = indexPagePath(file, pageNo);
      const content = buildPageIndex(file, book, i);
      // 没有文字的页不生成文件，但仍标记为「不该存在」，下面会清掉旧文件
      const hasText = (book.pages[i]?.texts ?? []).some((t) => (t.text || "").trim());
      if (!hasText) continue;
      wanted.add(path);
      if (await adapter.exists(path)) {
        const old = await adapter.read(path);
        if (old === content) continue;
      }
      await adapter.write(path, content);
    }

    // 页数变少 / 某页文字被清空：删掉对应的索引页
    if (typeof adapter.list === "function" && typeof adapter.remove === "function") {
      const listed = await adapter.list(dir);
      for (const p of listed?.files || []) {
        const name = p.split("/").pop() || "";
        if (!PAGE_FILE_RE.test(name)) continue;
        if (!wanted.has(p)) await adapter.remove(p);
      }
    }

    // 旧方案留下的一本一个大 md：迁移时删掉，免得搜索结果里出现两份
    const legacy = legacyIndexPath(file);
    if (typeof adapter.remove === "function" && (await adapter.exists(legacy))) {
      await adapter.remove(legacy);
    }
  } catch (e) {
    console.warn("[inkbook] 写文字索引失败（不影响本子保存）", e);
  }
}

/** 删掉整份索引（本子被删/改名时用；失败也无所谓，它只是派生数据） */
export async function removeTextIndex(app: App, file: TFile): Promise<void> {
  const adapter = app.vault.adapter as unknown as AdapterLike;
  try {
    const legacy = legacyIndexPath(file);
    if (typeof adapter.remove === "function" && (await adapter.exists(legacy))) {
      await adapter.remove(legacy);
    }
    const dir = indexDirFor(file);
    if (typeof adapter.list !== "function" || typeof adapter.remove !== "function") return;
    if (!(await adapter.exists(dir))) return;
    const listed = await adapter.list(dir);
    for (const p of listed?.files || []) await adapter.remove(p);
  } catch (_) {
    /* 派生数据，删不掉不算错 */
  }
}
