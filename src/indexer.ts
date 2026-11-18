import { Notice, type App, type TFile } from "obsidian";
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
 * 代价是文件多（有文字的页才有文件，通常远少于总页数）。
 *
 * 2026-11-12 起所有生成文件集中到库根的 `墨本文件/` 下：用户不想在每个笔记
 * 文件夹里看到一堆散落的索引 / 底图，而要「统一一个文件夹、每本一个
 * 子文件夹放它自己的底图和索引，不跟别的本子弄混」。旧 `墨本索引/` 与
 * 同目录 `.墨本索引/` 里的内容在启动时迁移进来。
 * 每本本子仍保留一个叶子目录，只是叶子名改成「完整文件路径」的
 * base64url token——这样不同文件夹里的同名本子不会撞目录，同时 token
 * 可逆，parseIndexPath 仍能反查出原始本子路径。
 */
/**
 * 墨本生成文件的**唯一公共根目录**：库根「墨本文件/」。
 *
 * 里面对每一本手写本分一个叶子目录（见 `indexDirFor`），该叶子同时存放
 * 这本的**文字索引页（.md）**和它导入产生的**底图 / 原件**（Word 页 PNG、
 * 从设备导入的 PDF / Word 原件）。用户要求「插件生成的文件统一收进一个
 * 文件夹，并且某本的底图和索引放在同一个文件夹里，不要跟别的本子弄混」。
 */
export const BOOK_DATA_ROOT = "墨本文件";

/** 每本手写本在公共根下的叶子目录后缀。 */
export const BOOK_DIR_SUFFIX = ".墨本";

/**
 * 从设备选进来的文件先落到这里（还没确定要导进哪一本）。
 * 与「墨本文件」同级子目录，随后由导入流程搬进目标本子的数据叶子，
 * 不会再散到库根 `.inkbook-assets/`。
 */
export const INCOMING_DIR = `${BOOK_DATA_ROOT}/.incoming`;

/** 兼容旧名：索引逻辑里一直用 INDEX_ROOT / INDEX_DIR_SUFFIX 指代公共根与叶子后缀。 */
export const INDEX_ROOT = BOOK_DATA_ROOT;
export const INDEX_DIR_SUFFIX = BOOK_DIR_SUFFIX;

/** 旧版公共根（INK-226 起的「墨本索引/」）：迁移期识别与清理用。 */
export const LEGACY_INDEX_ROOT = "墨本索引";

/** 旧版叶子目录后缀：迁移期识别与清理用。 */
export const LEGACY_INDEX_DIR_SUFFIX = ".墨本索引";

/** 旧方案（一本一个 md）的文件名后缀，遇到就删掉 */
export const LEGACY_INDEX_SUFFIX = ".墨本文字.md";

/** 目录名是否是一本本子的数据叶子（新 `.墨本` 或旧 `.墨本索引`）。 */
function hasBookDirSuffix(dir: string): boolean {
  return dir.endsWith(BOOK_DIR_SUFFIX) || dir.endsWith(LEGACY_INDEX_DIR_SUFFIX);
}

/** 叶子目录名里那串后缀的长度（用于「非空前缀」安全检查）。 */
function bookDirSuffixLen(dir: string): number {
  return dir.endsWith(BOOK_DIR_SUFFIX) ? BOOK_DIR_SUFFIX.length : LEGACY_INDEX_DIR_SUFFIX.length;
}

/**
 * 数据叶子里「墨本生成的」非索引文件：导入底图（Word 页 PNG）与导入原件
 * （从设备选进来的 PDF / Word）。删除本子时这些要跟着一起清掉。
 *
 * 只认常见的导入产物扩展名；其它文件（用户自己丢进来的笔记等）一律当
 * 「不是我们生成的」，目录保留不动——延续 INK-176 的防误删策略。
 */
function isGeneratedAssetFileName(name: string): boolean {
  return /\.(png|jpe?g|webp|gif|pdf|docx)$/i.test(name);
}

/**
 * 索引页文件名：`<本子名> · 第 12 页.md`。
 *
 * 为什么文件名里要带本子名：Obsidian 的全局搜索结果显示的是**文件名**，
 * 旧命名只有「第 12 页」，搜出来一排结果根本分不清是哪本本子的。
 * 加上本子名之后，搜索结果本身就是「数学 · 第 12 页」，一眼能认出来。
 *
 * 本子名本身可以带任意字符（含「·」）：文件名里最后一个「 · 」才是分隔符。
 */
const PAGE_FILE_RE = /^.+ · 第 (\d+) 页\.md$/;

/** 旧命名 `第 12 页.md`：写入新索引时顺手清掉（搜索结果里不再出现两份） */
const LEGACY_PAGE_FILE_RE = /^第 (\d+) 页\.md$/;

/**
 * 这个文件名是不是旧命名的索引页。
 *
 * 导出来给测试用：迁移逻辑（清理旧文件）必须和识别逻辑用同一把尺子，
 * 否则会出现「认得出、却删不掉」或者「删错了别的文件」。
 */
export function isLegacyIndexPageName(name: string): boolean {
  return LEGACY_PAGE_FILE_RE.test(name);
}

/**
 * 这个名字是不是**我们生成的**索引文件（新旧两种命名都算）。
 *
 * ensureDir 要「删掉未登记的旧目录重建」时用它逐项核对：
 * `adapter.rmdir(dir, true)` 会递归删掉整目录，判据不能只是目录名后缀——
 * 用户可能往 `.墨本索引/` 里放过自己的笔记。任何一个不认识的文件都要
 * 让整次递归删除作罢（INK-176）。
 *
 * 导出来给测试直接断言，避免「识别逻辑」和「删除判据」各写一份而漂移。
 */
export function isIndexPageFileName(name: string): boolean {
  return PAGE_FILE_RE.test(name) || LEGACY_PAGE_FILE_RE.test(name);
}

/**
 * 这个**路径**是不是墨本生成的文字索引页？
 *
 * 只给快速切换的结果过滤用（见 `src/switcher.ts`）。和 `parseIndexPath` 不同，
 * 这里不要求叶子目录里的本子 token 还能解出来：迁移没跑完、token 损坏或目录
 * 被手改过的旧索引仍然是插件生成物，照样不该占着快速切换的位置。
 *
 * 判据刻意收窄到历史上真实出现过的四种布局：
 *   1. `<任意路径>/<本子名>.墨本文字.md`（最早，一本一个 md）
 *   2. `墨本文件/<token>.墨本/<本子名> · 第 N 页.md`（当前）
 *   3. `墨本索引/<token>.墨本索引/<页名>.md`（INK-226 的旧公共根）
 *   4. `<任意路径>/<本子名>.墨本索引/<页名>.md`（更旧的同目录布局）
 * 后三者的共同点：索引页都住在「非空前缀 + `.墨本` / `.墨本索引`」的叶子目录里。
 *
 * 不放宽到整个 `墨本文件/`：用户可能把笔记放进这个公共根或数据叶子
 * （INK-176 的防误删原则）。也不认 `.inkbook` 本子、底图与导入原件——
 * Ribbon「打开手写本」就是靠核心快速切换找 `.inkbook` 的。
 */
export function isInkbookIndexFile(path: string): boolean {
  const text = String(path || "");
  // 布局 1：与本子同目录，后缀固定
  if (text.endsWith(LEGACY_INDEX_SUFFIX)) return true;

  const slash = text.lastIndexOf("/");
  const name = slash >= 0 ? text.slice(slash + 1) : text;
  const dir = slash >= 0 ? text.slice(0, slash) : "";
  if (!isIndexPageFileName(name)) return false;

  // 布局 2/3/4：只认本子的数据叶子，不认公共根本身或用户自建的子目录
  const leaf = dir.slice(dir.lastIndexOf("/") + 1);
  return hasBookDirSuffix(leaf) && leaf.length > bookDirSuffixLen(leaf);
}

/** 单页最多索引这么多字符（约 200 行中文），超出截断 */
const MAX_PAGE_CHARS = 12000;

function dirOf(file: TFile): string {
  return file.parent && file.parent.path && file.parent.path !== "/" ? `${file.parent.path}/` : "";
}

function baseOf(file: TFile): string {
  return (file.basename || "未命名").replace(/\.inkbook$/i, "");
}

/**
 * 把完整文件路径编码成目录名 token。
 *
 * 用 TextEncoder + btoa 而不是 encodeURIComponent：路径含中文时
 * encodeURIComponent 会产生 `%`，既长又不适合当目录名；base64url
 * 只含 `[A-Za-z0-9_-]`，Windows / macOS / 移动端都安全。
 * `=` 填充去掉，目录名更短；解码时自动补回来。
 */
export function encodeBookPathToken(path: string): string {
  const bytes = new TextEncoder().encode(String(path || ""));
  let binary = "";
  // 路径通常很短，一次转完即可；分段只防极端超长路径把参数栈撑爆。
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * token 反解。**任何非法输入都返回 null，绝不抛异常**：
 * 它会在 file-open 的路径解析里被调用，外部改坏一个文件名不能让插件崩。
 */
export function decodeBookPathToken(token: string): string | null {
  try {
    const raw = String(token || "");
    if (!raw) return null;
    const pad = raw.length % 4 === 0 ? "" : "=".repeat(4 - (raw.length % 4));
    const binary = atob(raw.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const path = new TextDecoder().decode(bytes);
    return path || null;
  } catch (_) {
    return null;
  }
}

/** 旧版索引目录：与本子同目录、同名前缀（迁移期识别与清理用） */
export function legacyIndexDirFor(file: TFile): string {
  return `${dirOf(file)}${baseOf(file)}${LEGACY_INDEX_DIR_SUFFIX}`;
}

/**
 * 某本手写本的「数据叶子」目录（库根 `墨本文件/<路径 token>.墨本`）。
 *
 * 这本的索引页与导入底图/原件都放这里（用户要求按本子分文件夹、不弄混）。
 * 用完整本子路径的可逆 token 命名，不同文件夹里的同名本子也不会撞目录。
 */
export function dataDirForPath(bookPath: string): string {
  return `${BOOK_DATA_ROOT}/${encodeBookPathToken(bookPath)}${BOOK_DIR_SUFFIX}`;
}

/** 新索引目录 = 本子的数据叶子目录（索引页是其中一类生成文件）。 */
export function indexDirFor(file: TFile): string {
  return dataDirForPath(file.path);
}

/** 旧版公共根叶子路径（INK-226 的 `墨本索引/<token>.墨本索引`），迁移/清理用。 */
export function legacyRootIndexDirForPath(bookPath: string): string {
  return `${LEGACY_INDEX_ROOT}/${encodeBookPathToken(bookPath)}${LEGACY_INDEX_DIR_SUFFIX}`;
}

/**
 * 确保「墨本文件/」公共根与某本的数据叶子都存在，返回叶子路径。
 * 导入底图 / 原件写盘前调用（写完要保证目录已进 Obsidian 文件表）。
 */
export async function ensureBookDataDir(app: App, bookPath: string): Promise<string> {
  const vault = app.vault as unknown as VaultLike;
  const adapter = (vault.adapter || (app.vault.adapter as unknown as AdapterLike)) as AdapterLike;
  const dir = dataDirForPath(bookPath);
  await ensureIndexRoot(vault, adapter);
  await ensureDir(vault, adapter, dir);
  return dir;
}

/** 某一页的索引文件路径（文件名带本子名，全局搜索结果里才分得清） */
export function indexPagePath(file: TFile, pageNo: number): string {
  return `${indexDirFor(file)}/${indexFileName(file, pageNo)}`;
}

/** 某一页的索引**文件名**（不含目录） */
export function indexFileName(file: TFile, pageNo: number): string {
  return `${indexFileBase(file)} · 第 ${pageNo} 页.md`;
}

/**
 * 索引文件名里用的本子名。
 *
 * 为什么要截断：Windows 的文件名上限是 255 字符，本子名本身可能已经占了
 * 240 个，再加「 · 第 12 页.md」就超了——超限的文件根本创建不出来。
 * 截断只影响**文件名**，不影响目录名，所以反查（parseIndexPath 靠目录名
 * 找本子）照样对得上。
 */
const MAX_INDEX_FILE_BASE = 120;

function indexFileBase(file: TFile): string {
  const base = baseOf(file);
  const chars = Array.from(base);
  return chars.length > MAX_INDEX_FILE_BASE
    ? chars.slice(0, MAX_INDEX_FILE_BASE).join("")
    : base;
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
  const text = String(path || "");
  /*
   * 当前布局：`墨本文件/<token>.墨本/<页文件名>.md`。
   * token 解出的是完整本子路径（含 `.inkbook`），不要再拼 `.inkbook`。
   *
   * 注意：只要路径落在 `墨本文件/` 下，就不再走旧版同目录规则。
   * 否则一个损坏的 token 会被误判成「库根下有一本叫 <token> 的本子」，
   * 点开后只会报文件不存在；直接返回 null 更安全。
   */
  if (text.startsWith(`${BOOK_DATA_ROOT}/`)) {
    const m = text.match(/^墨本文件\/([A-Za-z0-9_-]+)\.墨本\/(?:.+ · )?第 (\d+) 页\.md$/);
    if (!m) return null;
    const page = Number(m[2]);
    if (!Number.isFinite(page) || page < 1) return null;
    const bookPath = decodeBookPathToken(m[1]);
    return bookPath ? { bookPath, page } : null;
  }

  /*
   * 旧版公共根（INK-226）：`墨本索引/<token>.墨本索引/<页文件名>.md`。
   * 迁移尚未跑完时旧的搜索结果仍可能指向这里，必须还能反查。
   */
  if (text.startsWith(`${LEGACY_INDEX_ROOT}/`)) {
    const m = text.match(/^墨本索引\/([A-Za-z0-9_-]+)\.墨本索引\/(?:.+ · )?第 (\d+) 页\.md$/);
    if (!m) return null;
    const page = Number(m[2]);
    if (!Number.isFinite(page) || page < 1) return null;
    const bookPath = decodeBookPathToken(m[1]);
    return bookPath ? { bookPath, page } : null;
  }

  /*
   * 更旧的同目录路径（迁移期兼容）：
   *   · 新命名：`<本子名> · 第 N 页.md`
   *   · 旧命名：`第 N 页.md`
   * 旧文件要等下一次保存 / 迁移才会被清掉；在那之前，搜索结果里残留的旧链接
   * 点开也应该能跳回本子，而不是停在一页过期的索引上。
   * 文件名前缀（本子名）允许为空，兼容历史数据。
   */
  const m = text.match(/^(.*)\.墨本索引\/(?:.+ · )?第 (\d+) 页\.md$/);
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
export function buildPageIndex(
  file: TFile,
  book: InkBook,
  pageIndex: number,
  rewriteText?: (text: string) => string
): string {
  let text = pageText(book.pages[pageIndex] || ({} as Page));
  if (rewriteText) text = rewriteText(text);
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

/*
 * 把索引页里指向 `.inkbook` 的双链改写成「指向目标本子文字索引页」的普通
 * Markdown 双链。
 *
 * 为什么必须改写：Obsidian 的「关系图谱」只认 Markdown 笔记，`.inkbook` 是
 * JSON，不属于它能成图的文件（官方论坛明确「不支持把附件画进图里」）。所以
 * 不论写成 `[[本子]]` 还是 `[[本子.inkbook]]`，Obsidian 都解析不到一个可成图
 * 的节点：要么灰链`文件不存在`，要么根本连不上。索引页本身就是 `.md`，把
 * 链接改指到目标本子某页的索引页，就能在关系图谱里连成一条真实可见的边，
 * 点开那条边对应的节点又会经 file-open 钩子跳回目标本子对应页。
 *
 * 只动「生成出来的索引文本」，不动本子里存的原始文字：本子里依旧显示
 * `[[本子.inkbook]]`，App 内点击由本插件自己解析，行为不变。
 */
const WIKILINK_RE = /\[\[([^\[\]\n]+?)\]\]/g;

interface ParsedWikilinkInner {
  name: string;
  heading: string | null;
  alias: string | null;
}

function parseWikilinkInner(inner: string): ParsedWikilinkInner | null {
  let rest = inner;
  let alias: string | null = null;
  const pipe = rest.indexOf("|");
  if (pipe >= 0) {
    alias = rest.slice(pipe + 1);
    rest = rest.slice(0, pipe);
  }
  rest = rest.trim();
  if (!rest) return null;
  let name = rest;
  let heading: string | null = null;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    name = rest.slice(0, hash).trim();
    heading = rest.slice(hash + 1);
  }
  if (!name) return null;
  return { name, heading, alias };
}

/** 解析链接目标对应的本子文件（优先 metadataCache，退而按路径 / 文件名找）。 */
function resolveInkbookFile(app: App, name: string, sourcePath: string): TFile | null {
  const vault: any = (app as any).vault;
  const cache: any = (app as any).metadataCache;
  try {
    if (cache && typeof cache.getFirstLinkpathDest === "function") {
      const hit = cache.getFirstLinkpathDest(name, sourcePath || "");
      if (hit) return hit as TFile;
    }
  } catch (_) {
    /* 解析失败就退回文件名匹配 */
  }
  const files: any[] = vault && typeof vault.getFiles === "function" ? vault.getFiles() : [];
  const baseName = name.replace(/\.inkbook$/i, "");
  return (
    (files.find(
      (f) =>
        f.path === name ||
        f.path === name + ".md" ||
        f.name === name ||
        (typeof f.path === "string" && f.path.endsWith("/" + name)) ||
        f.basename === name ||
        f.basename === baseName
    ) as TFile) || null
  );
}

/** 目标本子里真正存在的一页索引页，用作链接名（不含 `.md`）。 */
async function targetIndexLinkName(
  app: App,
  target: TFile,
  wantPage: number | undefined
): Promise<string | null> {
  const adapter: any = (app as any).vault?.adapter;
  if (!adapter || typeof adapter.exists !== "function") return null;
  const dir = indexDirFor(target);
  const exists = async (p: string) => {
    try {
      return !!(await adapter.exists(p));
    } catch (_) {
      return false;
    }
  };
  const baseNoExt = (pageNo: number) => indexFileName(target, pageNo).replace(/\.md$/i, "");
  if (wantPage && wantPage >= 1 && (await exists(`${dir}/${indexFileName(target, wantPage)}`))) {
    return baseNoExt(wantPage);
  }
  // 目标本子第一张有文字的页（只有有文字的页才生成索引）：读页数后逐页找已存在的。
  let pageCount = 0;
  try {
    if (typeof adapter.read === "function") {
      const raw = await adapter.read(target.path);
      const json = JSON.parse(raw);
      if (Array.isArray(json?.pages)) pageCount = json.pages.length;
    }
  } catch (_) {
    /* 读不到就按最大上限探测 */
  }
  const max = pageCount > 0 ? pageCount : 300;
  for (let p = 1; p <= max; p += 1) {
    if (await exists(`${dir}/${indexFileName(target, p)}`)) return baseNoExt(p);
  }
  return null;
}

/** 收集一页文本里所有 `.inkbook` 双链目标，解析成「本子某页索引」的链接名。 */
export async function buildInkbookLinkMap(
  app: App,
  sourcePath: string,
  texts: string[]
): Promise<Map<string, string>> {
  const keys = new Set<string>();
  for (const text of texts) {
    WIKILINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK_RE.exec(text))) {
      const parsed = parseWikilinkInner(m[1]);
      if (!parsed || !/\.inkbook$/i.test(parsed.name)) continue;
      const numeric =
        parsed.heading != null && /^\d+$/.test(parsed.heading.trim())
          ? parsed.heading.trim()
          : "";
      keys.add(numeric ? `${parsed.name}#${numeric}` : parsed.name);
    }
  }
  const map = new Map<string, string>();
  for (const key of keys) {
    const [name, pageStr] = key.split("#");
    const target = resolveInkbookFile(app, name, sourcePath);
    if (!target) continue;
    if (String((target as any).extension || "").toLowerCase() !== "inkbook") continue;
    const wantPage = pageStr ? parseInt(pageStr, 10) : undefined;
    const linkName = await targetIndexLinkName(app, target, wantPage);
    if (linkName) map.set(key, linkName);
  }
  return map;
}

/** 同步改写：把文本里的 `.inkbook` 双链换成指向目标本子索引页的 Markdown 双链。 */
export function rewriteInkbookLinks(text: string, map: Map<string, string>): string {
  return text.replace(WIKILINK_RE, (full, inner) => {
    const parsed = parseWikilinkInner(inner);
    if (!parsed || !/\.inkbook$/i.test(parsed.name)) return full;
    const numeric =
      parsed.heading != null && /^\d+$/.test(parsed.heading.trim())
        ? parsed.heading.trim()
        : "";
    const base =
      (numeric ? map.get(`${parsed.name}#${numeric}`) : undefined) || map.get(parsed.name);
    if (!base) return full;
    let display = (parsed.alias && parsed.alias.trim()) || parsed.name.replace(/\.inkbook$/i, "");
    display = display.replace(/\]\]/g, "");
    return `[[${base}|${display}]]`;
  });
}

interface AdapterLike {
  exists: (path: string) => Promise<boolean>;
  read: (path: string) => Promise<string>;
  write: (path: string, data: string) => Promise<void>;
  mkdir?: (path: string) => Promise<void>;
  rmdir?: (path: string, recursive?: boolean) => Promise<void>;
  remove?: (path: string) => Promise<void>;
  list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
}

/**
 * vault 的一等文件 API（只需要这几个）。
 *
 * 为什么不能用 adapter 写索引：**见 writeIndexFile 的注释**。
 * 这里只声明用到的部分，测试桩补几个函数就能跑。
 */
interface VaultLike {
  getAbstractFileByPath: (path: string) => unknown;
  createFolder?: (path: string) => Promise<unknown>;
  create?: (path: string, data: string) => Promise<unknown>;
  modify?: (file: unknown, data: string) => Promise<void>;
  /** 彻底删除（文件或文件夹）——必须走它，adapter.remove 绕过了文件表 */
  delete?: (file: unknown, force?: boolean) => Promise<void>;
  /** 移到回收站 */
  trash?: (file: unknown, system?: boolean) => Promise<void>;
  /** 遍历文件表里的所有文件/文件夹（扫孤儿索引用） */
  getAllLoadedFiles?: () => Array<{ path: string; children?: unknown }>;
  adapter: AdapterLike;
}

/**
 * 这个 vault 是否具备完整的文件表 API。
 *
 * 测试桩里 `app.vault` 往往只有一个 adapter（跑单元测试用不着文件表），
 * 那种情况下退回 adapter 直写，行为与旧版一致，不会把测试炸掉。
 */
function hasFileTable(vault: VaultLike | undefined): vault is VaultLike {
  return !!vault && typeof vault.getAbstractFileByPath === "function";
}

/**
 * 确保库根索引总目录存在。
 *
 * 这里**绝不递归删除** `墨本文件/`：它可能是用户自己建的文件夹（用户
 * 完全可能先建好一个同名文件夹再放东西）。旧 ensureDir 的自愈逻辑只对
 * 叶子目录生效；根目录只做「没有就建」，建不进去就退回 mkdir 兜底。
 * 根目录本身不以 `.墨本` 结尾，也不会被 removeIndexDir 误删。
 */
async function ensureIndexRoot(vault: VaultLike, adapter: AdapterLike): Promise<void> {
  if (hasFileTable(vault) && vault.getAbstractFileByPath(INDEX_ROOT)) return;
  if (hasFileTable(vault) && typeof vault.createFolder === "function") {
    try {
      await vault.createFolder(INDEX_ROOT);
    } catch (_) {
      /* 已存在（含用户自建）或宿主拒绝：交给下面的 mkdir 兜底 */
    }
    await new Promise((r) => setTimeout(r, 0));
    if (vault.getAbstractFileByPath(INDEX_ROOT)) return;
  }
  if (typeof adapter.mkdir === "function") {
    try {
      if (!(await adapter.exists(INDEX_ROOT))) await adapter.mkdir(INDEX_ROOT);
    } catch (_) {
      /* 并发建目录 / 已存在：忽略 */
    }
  }
}

/**
 * 确保索引目录存在，**并且**已经进入 Obsidian 的文件表。
 *
 * 优先 `vault.createFolder`：它会把文件夹登记进文件表。
 * 直接用 `adapter.mkdir` 建出来的目录，在 Obsidian 眼里可能"不存在"，
 * 里面的文件也就跟着进不了全局搜索。
 *
 * ### 为什么还要处理"磁盘上有、文件表里没有"
 *
 * `vault.createFolder` 在目录已存在于磁盘时只会抛「Folder already exists.」，
 * **不会**补登记。旧版裸建、同步工具在 Obsidian 运行时从外部建目录、
 * watcher 漏事件，都会留下这种状态。此时 `vault.create` 能把 md 写到磁盘，
 * 但 Obsidian 的 `Vault.addChild` 找不到父目录，文件不会挂进 `vault.getFiles()`
 * 那棵树——全局搜索永远 0 结果，而且不报任何错。
 *
 * 索引全是派生数据，所以这里删掉未登记的旧目录，再用 `createFolder`
 * 建一个会被登记的。但**只删确认过的索引目录**：`rmdir(dir, true)` 是递归删，
 * 目录里若有用户自己的文件，绝不能跟着一起没。删不掉/不敢删就退回裸建
 * 并给用户一条提示（最终校验也会把「进不了文件表」报出来）。
 */
async function ensureDir(vault: VaultLike, adapter: AdapterLike, dir: string): Promise<void> {
  if (hasFileTable(vault)) {
    if (vault.getAbstractFileByPath(dir)) return;

    if (typeof vault.createFolder === "function") {
      try {
        await vault.createFolder(dir);
      } catch (_) {
        /* 磁盘上已经有了（旧版裸建 / 同步工具建的）→ 抛「已存在」 */
      }
      if (vault.getAbstractFileByPath(dir)) return;
      // 有的宿主把 create 事件异步派发，让一轮宏任务再确认一次
      await new Promise((r) => setTimeout(r, 0));
      if (vault.getAbstractFileByPath(dir)) return;

      /*
       * 走到这里：目录在磁盘上，文件表里却没有。createFolder 对已存在目录
       * 只会失败、不会补登记，必须把旧目录删掉重建。
       *
       * ### 递归删除前的三项校验（INK-176）
       *
       * 老实现只判 `dir.endsWith(".墨本索引")` 就 `rmdir(dir, true)`：
       * 目录是用户可写的位置，里面若被放过自己的笔记/图片，会被静默一并删掉。
       *   1. 目录名后缀 + 非空前缀（防误把根目录当索引目录）；
       *   2. `list(dir)` 必须拿得到，且没有子文件夹；
       *   3. 每个文件的名字都必须是我们的索引命名（新旧两版）。
       * 任何一条不满足就不删，退回裸建，并明确告诉用户「搜索可能搜不到」。
       */
      if (
        typeof adapter.rmdir === "function" &&
        typeof adapter.list === "function" &&
        dir.length > INDEX_DIR_SUFFIX.length &&
        dir.endsWith(INDEX_DIR_SUFFIX)
      ) {
        try {
          if (await adapter.exists(dir)) {
            const listed = await adapter.list(dir);
            const names = (listed?.files || []).map((p) => p.split("/").pop() || "");
            const folders = listed?.folders || [];
            const unknown = names.filter((n) => !isIndexPageFileName(n));
            if (folders.length === 0 && unknown.length === 0) {
              await adapter.rmdir(dir, true);
              await vault.createFolder(dir);
              await new Promise((r) => setTimeout(r, 0));
              if (vault.getAbstractFileByPath(dir)) return;
            } else {
              // 不敢删：别静默，让用户知道搜索可能受影响
              notifyIndexIssue(
                `unknown-dir|${dir}`,
                `索引目录「${dir}」里有不是墨本生成的文件（${unknown.slice(0, 3).join("、") || "子文件夹"}），` +
                  `墨本没有动它；全局搜索可能搜不到这本本子的文字。`
              );
            }
          }
        } catch (_) {
          /* 修不好就退回下面的裸建；最终校验会把"进不了文件表"报给用户 */
        }
      }
    }
  }

  if (typeof adapter.mkdir === "function") {
    try {
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    } catch (_) {
      /* 并发建目录时可能撞上，忽略 */
    }
  }
}

/**
 * 写一个索引页。
 *
 * ### 为什么必须走 vault.create / vault.modify
 *
 * Obsidian 的全局搜索查的是它自己的文件表（`vault.getFiles()` 那张），
 * 而这张表**只由 vault 的增删改流程维护**；`adapter.write` 是绕过文件表的裸写。
 * 在 Windows 上批量新建目录时，外部变更监听很容易把整批 create 事件漏掉——
 * 文件明明躺在磁盘上，Obsidian 却从来没听说过它，于是：
 *
 *   · 文件浏览器里看不到（或者要重启才出现）
 *   · 全局搜索一个字都搜不到
 *
 * 这正是真机上「索引文件生成了、但全局检索还是搜不到手写本」的原因。
 * 走 vault.create 之后，文件在写入的同时就被登记进文件表并进入检索。
 *
 * 内容没变就不写：省同步流量，也避免每次保存都让 Obsidian 重新解析一遍。
 */
async function writeIndexFile(
  vault: VaultLike,
  adapter: AdapterLike,
  path: string,
  content: string
): Promise<void> {
  // 没有文件表（测试桩 / 极老版本）：只能裸写，行为和旧版一致
  if (!hasFileTable(vault)) {
    if (await adapter.exists(path)) {
      const old = await adapter.read(path);
      if (old === content) return;
    }
    await adapter.write(path, content);
    return;
  }

  const existing = vault.getAbstractFileByPath(path);
  if (existing) {
    let old = "";
    try {
      old = await adapter.read(path);
    } catch (_) {
      /* 读不出来就当作需要重写 */
    }
    if (old === content) return;
    if (typeof vault.modify === "function") {
      await vault.modify(existing, content);
      return;
    }
    await adapter.write(path, content);
    return;
  }

  if (typeof vault.create === "function") {
    try {
      await vault.create(path, content);
      return;
    } catch (_) {
      /*
       * 磁盘上已经有这个文件、但 Obsidian 没登记（旧版 adapter.write 的遗留）。
       * create 会因为"文件已存在"失败——先删掉再建，才能把它收进文件表。
       */
      try {
        if (typeof adapter.remove === "function" && (await adapter.exists(path))) {
          await adapter.remove(path);
          await vault.create(path, content);
          return;
        }
      } catch (_) {
        /* 落到下面的兜底 */
      }
    }
  }
  await adapter.write(path, content);
}

/**
 * 删掉一个索引文件。
 *
 * 与写入对称：**优先走 vault.delete / vault.trash**。
 *
 * 为什么删除也必须走文件表：`adapter.remove` 是绕过 Obsidian 的裸删——
 * 文件在磁盘上没了，但 Obsidian 的文件表里还留着那条记录，
 * 于是全局搜索里依然能搜到这份「已经不存在」的索引内容，
 * 点进去就是「文件不存在」。旧命名的索引页（`第 12 页.md`）清理时
 * 最容易踩到：用户会看到同一页出现两条搜索结果，其中一条点不开。
 *
 * 拿不到文件对象时（测试桩、文件本来就没登记）退回 adapter.remove。
 */
async function removeIndexFile(
  vault: VaultLike,
  adapter: AdapterLike,
  path: string
): Promise<void> {
  if (hasFileTable(vault)) {
    const abs = vault.getAbstractFileByPath(path);
    if (abs) {
      /*
       * 优先彻底删除而不是扔进回收站：索引是派生文件，
       * 一次「重建索引」可能删掉几百个，扔进回收站只是把垃圾换个地方堆。
       */
      if (typeof vault.delete === "function") {
        try {
          await vault.delete(abs, true);
          return;
        } catch (_) {
          /* 某些环境不让硬删，退回回收站 */
        }
      }
      if (typeof vault.trash === "function") {
        try {
          await vault.trash(abs, false);
          return;
        } catch (_) {
          /* 落到 adapter */
        }
      }
    }
  }
  if (typeof adapter.remove === "function") await adapter.remove(path);
}

/**
 * 删掉整个索引目录（`<本子名>.墨本索引/`）。
 *
 * ### 为什么光删文件不够（2026-11-10 真机反馈）
 *
 * 老实现 `removeTextIndex` 只把目录里的 md 逐个删掉，**目录本身留着**。
 * 用户按「有文字的页才有索引」的直觉去删本子，看到的是：本子没了、
 * 笔记文件夹里却多出一个 `.墨本索引` 空目录；连删几本测试本子之后，
 * 文件夹里堆着一排空目录（用户原话：「现在这笔记文件夹里有好多份文件」）。
 * 空目录不进搜索、也不占空间，但它是**用户看得见的垃圾**，
 * 而且下次新建同名本子时，`ensureDir` 还会把它当成「磁盘上有、
 * 文件表里没有」的旧目录，多走一遍删了重建。
 *
 * ### 递归删除前的核对（延续 INK-176）
 *
 * `vault.delete(folder)` 对文件夹是**递归**删的，判据不能只有目录名后缀：
 * 用户完全可能把自己的笔记/图片丢进 `.墨本索引/`。所以：
 *   1. 目录名必须是 `非空前缀 + .墨本索引`（防把库根目录当索引目录）；
 *   2. `list` 必须拿得到，且**没有子文件夹**；
 *   3. 每个文件都必须是我们的索引命名（新旧两版）。
 * 认得的索引文件先删（文件表里那条记录也得跟着消失），再核对目录是否
 * 真的空了；还有不认识的东西就原地保留，并提示用户一句。
 *
 * 返回是否真的把目录删掉了。
 */
async function removeIndexDir(
  vault: VaultLike,
  adapter: AdapterLike,
  dir: string
): Promise<boolean> {
  if (!dir || !hasBookDirSuffix(dir) || dir.length <= bookDirSuffixLen(dir)) {
    return false;
  }
  if (typeof adapter.list !== "function") return false;
  try {
    if (!(await adapter.exists(dir))) return false;
    const listed = await adapter.list(dir);
    const names = (listed?.files || []).map((p) => p.split("/").pop() || "");
    const unknown = names.filter((n) => !isIndexPageFileName(n));
    const subFolders = listed?.folders || [];

    // 认识的索引页一律清掉（顺带处理「文件还在、文件表里已经没了」的残留）
    for (const p of listed?.files || []) {
      if (isIndexPageFileName(p.split("/").pop() || "")) await removeIndexFile(vault, adapter, p);
    }

    if (unknown.length > 0 || subFolders.length > 0) {
      // 不敢递归删：目录里有不是墨本生成的东西
      notifyIndexIssue(
        `orphan-dir|${dir}`,
        `索引目录「${dir}」里还有不是墨本生成的文件（${unknown.slice(0, 3).join("、") || "子文件夹"}），` +
          `墨本只清了自己的索引页，目录留着没动。`
      );
      return false;
    }

    // 目录本身：优先走 vault（否则文件表里还挂着一条「已不存在的文件夹」）
    if (hasFileTable(vault)) {
      const abs = vault.getAbstractFileByPath(dir);
      if (abs && typeof vault.delete === "function") {
        try {
          await vault.delete(abs, true);
          return true;
        } catch (_) {
          /* 某些环境不让删文件夹，落到 adapter */
        }
      }
    }
    if (typeof adapter.rmdir === "function") {
      await adapter.rmdir(dir, false);
      return true;
    }
  } catch (_) {
    /* 派生数据，删不掉不算错 */
  }
  return false;
}

/**
 * 删掉一本本子的**整个数据叶子**（索引页 + 导入底图/原件）。
 *
 * 与 `removeIndexDir` 的区别：这里允许并删除**墨本生成的资产文件**
 * （PNG / PDF / DOCX）。删除/清理整本时，这些底图/原件属于这一本，
 * 跟着一起收掉，否则会在「墨本文件/」里留下无主的旧底图。
 *
 * 仍然保留 INK-176 的防误删：目录里若有**不认识的文件**（用户自己丢进来的
 * 笔记/图片以外的文件）或子文件夹，就只删认得的、
 * 目录留着并提示一句，绝不递归误删。返回是否真的把目录删掉了。
 */
async function removeBookDataDir(
  vault: VaultLike,
  adapter: AdapterLike,
  dir: string
): Promise<boolean> {
  if (!dir || !hasBookDirSuffix(dir) || dir.length <= bookDirSuffixLen(dir)) return false;
  if (typeof adapter.list !== "function") return false;
  try {
    if (!(await adapter.exists(dir))) return false;
    const listed = await adapter.list(dir);
    const files = listed?.files || [];
    const names = files.map((p) => p.split("/").pop() || "");
    const unknown = names.filter((n) => !isIndexPageFileName(n) && !isGeneratedAssetFileName(n));
    const subFolders = listed?.folders || [];

    // 认得的索引页与生成资产一律删掉（含旧命名索引页）
    for (const p of files) {
      const name = p.split("/").pop() || "";
      if (isIndexPageFileName(name) || isGeneratedAssetFileName(name)) {
        await removeIndexFile(vault, adapter, p);
      }
    }

    if (unknown.length > 0 || subFolders.length > 0) {
      notifyIndexIssue(
        `orphan-data|${dir}`,
        `「${dir}」里还有不是墨本生成的文件（${unknown.slice(0, 3).join("、") || "子文件夹"}），` +
          `墨本只清了自己的索引与底图，目录留着没动。`
      );
      return false;
    }

    if (hasFileTable(vault)) {
      const abs = vault.getAbstractFileByPath(dir);
      if (abs && typeof vault.delete === "function") {
        try {
          await vault.delete(abs, true);
          return true;
        } catch (_) {
          /* 某些环境不让删文件夹，落到 adapter */
        }
      }
    }
    if (typeof adapter.rmdir === "function") {
      await adapter.rmdir(dir, false);
      return true;
    }
  } catch (_) {
    /* 派生数据，删不掉不算错 */
  }
  return false;
}

/** 从任意一版索引页文件名里取页码；不是索引页返回 0。 */
function pageNoFromIndexName(name: string): number {
  const m = name.match(/第 (\d+) 页\.md$/);
  const page = m ? Number(m[1]) : 0;
  return Number.isFinite(page) && page >= 1 ? page : 0;
}

/**
 * 把旧版同目录索引迁移到新的库根叶子目录。
 *
 * 迁移只读旧页面的**内容**，写仍然走 `writeIndexFile`（vault.create /
 * modify），不允许为了迁移再用 adapter.write——那会让文件重新掉出
 * Obsidian 文件表，搜索结果再次消失。若新叶子已有同页文件则不覆盖，
 * 避免旧缓存盖掉刚写的新内容。迁移完调用 `removeIndexDir`：它只删
 * 认得的索引页，目录里有用户自己的文件就原地保留。
 */
async function migrateLegacyIndexDir(
  vault: VaultLike,
  adapter: AdapterLike,
  oldDir: string,
  file: TFile
): Promise<boolean> {
  if (typeof adapter.list !== "function") return false;
  try {
    if (!(await adapter.exists(oldDir))) return false;
    const listed = await adapter.list(oldDir);
    for (const p of listed?.files || []) {
      const name = p.split("/").pop() || "";
      const page = pageNoFromIndexName(name);
      if (!page) continue;
      const target = indexPagePath(file, page);
      if (hasFileTable(vault) && vault.getAbstractFileByPath(target)) continue;
      try {
        const content = await adapter.read(p);
        await ensureIndexRoot(vault, adapter);
        await ensureDir(vault, adapter, indexDirFor(file));
        await writeIndexFile(vault, adapter, target, content);
      } catch (_) {
        /* 单页迁移失败不影响其它页；旧目录最后仍走安全删除检查 */
      }
    }
    return removeIndexDir(vault, adapter, oldDir);
  } catch (_) {
    return false;
  }
}

/** 孤儿扫描的结果，供上层提示用户 */
export interface OrphanSweepResult {
  /** 真的删掉的孤儿索引目录数 */
  removed: number;
  /** 因为目录里有非墨本文件而保留下来的目录数 */
  kept: number;
}

/**
 * 扫掉**孤儿索引目录**：本子已经不在了，`.墨本索引/` 还留在笔记文件夹里。
 *
 * ### 为什么需要一次全库扫（2026-11-10 真机反馈）
 *
 * `removeTextIndex` 只在 Obsidian 派发 `delete` 事件时跑。下面这些情况
 * 事件根本不会来，孤儿目录就永久留下来了：
 *   · 用户在**别的客户端/文件管理器**里删了本子（同步工具、手机端、资源管理器）
 *   · 本子先于索引目录被删，索引目录当时还被别的程序占着 → 删失败后再没人重试
 *   · 旧版本插件（只删文件、不删目录）留下的历史残留
 * 用户的感受是「我删了那些测试用的本子，可文件夹里还是一堆东西」。
 *
 * ### 判据
 *
 * 目录名 `<非空本子名>.墨本索引`，同目录下同名 `.inkbook` 必须存在。
 * 「存在」按**磁盘**判（`adapter.exists`）而不是只看文件表：同步工具刚
 * 拉下来的本子可能还没进文件表，那种绝不能当孤儿删掉。
 * 删之前仍然走 `removeIndexDir` 的三项核对，目录里有用户自己的东西就不动。
 */

/** 递归列目录（`adapter.list` 只给一层，孤儿目录可能在任何深度） */
async function listAllDirs(adapter: AdapterLike, root: string): Promise<string[]> {
  if (typeof adapter.list !== "function") return [];
  const out: string[] = [];
  const queue = [root];
  // 防御：异常深的目录结构别把栈/队列撑爆
  let guard = 0;
  while (queue.length && guard < 5000) {
    const cur = queue.shift() as string;
    guard += 1;
    let listed: { files: string[]; folders: string[] } | null = null;
    try {
      listed = await adapter.list(cur);
    } catch (_) {
      // 库根目录在部分适配器上要用 "/" 才列得出来
      if (cur === "") {
        try {
          listed = await adapter.list("/");
        } catch (_) {
          listed = null;
        }
      }
      if (!listed) continue;
    }
    for (const f of listed?.folders || []) {
      out.push(f);
      queue.push(f);
    }
  }
  return out;
}

/**
 * 找出库里所有 `.墨本索引` 目录。
 *
 * 优先走**文件表**（`getAllLoadedFiles`）：一次拿到全部路径，不用逐层
 * 走磁盘。库大的时候（几千个笔记）启动时全库递归 list 会明显拖慢磁盘，
 * 而索引目录一定在文件表里（否则它的索引页也进不了全局搜索，
 * 那种残留由 `ensureDir` 的自愈逻辑负责）。
 * 没有 `getAllLoadedFiles` 的宿主才退回递归 list。
 */
async function findIndexDirs(vault: VaultLike, adapter: AdapterLike): Promise<string[]> {
  if (hasFileTable(vault) && typeof vault.getAllLoadedFiles === "function") {
    try {
      const all = vault.getAllLoadedFiles() || [];
      const out: string[] = [];
      for (const f of all) {
        const p = typeof f?.path === "string" ? f.path : "";
        if (hasBookDirSuffix(p) && p.length > bookDirSuffixLen(p)) out.push(p);
      }
      if (out.length || all.length) return out;
    } catch (_) {
      /* 落到磁盘递归 */
    }
  }
  return listAllDirs(adapter, "");
}

/**
 * 全库扫一遍孤儿索引目录并删掉。
 *
 * **永不抛异常**：派生数据清理失败不该影响插件启动。
 * 同一本本子同时可能有在途的写索引任务，所以逐个排到那条单飞链上删，
 * 避免「刚建好的目录被扫掉」。
 */
export async function sweepOrphanIndexDirs(app: App): Promise<OrphanSweepResult> {
  const result: OrphanSweepResult = { removed: 0, kept: 0 };
  const vault = app?.vault as unknown as VaultLike | undefined;
  if (!vault) return result;
  const adapter = (vault.adapter || (app.vault.adapter as unknown as AdapterLike)) as AdapterLike;
  if (!adapter) return result;

  let dirs: string[] = [];
  try {
    dirs = await findIndexDirs(vault, adapter);
  } catch (_) {
    return result;
  }
  if (!dirs.length) return result;

  /** 本子在不在：先磁盘、再文件表（同步刚拉下来的本子不能误判孤儿）。 */
  const liveBook = async (bookPath: string): Promise<boolean> => {
    let exists = false;
    try {
      exists = await adapter.exists(bookPath);
    } catch (_) {
      exists = false;
    }
    if (!exists && hasFileTable(vault) && vault.getAbstractFileByPath(bookPath)) exists = true;
    return exists;
  };
  const asBookFile = (bookPath: string): TFile => {
    const actual = hasFileTable(vault) ? (vault.getAbstractFileByPath(bookPath) as TFile | null) : null;
    if (actual && typeof (actual as any).path === "string") return actual;
    return {
      path: bookPath,
      basename: (bookPath.split("/").pop() || "未命名").replace(/\.inkbook$/i, ""),
      parent: { path: bookPath.includes("/") ? bookPath.slice(0, bookPath.lastIndexOf("/")) : "/" },
    } as unknown as TFile;
  };

  for (const dir of dirs) {
    if (!hasBookDirSuffix(dir)) continue;
    if (dir.length <= bookDirSuffixLen(dir)) continue;

    /*
     * 当前布局的库根叶子：`墨本文件/<token>.墨本`。
     * 目录里既有索引页也可能有导入底图/原件，删除要用 removeBookDataDir
     * （连资产一起收），不能用只认索引页的 removeIndexDir。
     */
    if (dir.startsWith(`${BOOK_DATA_ROOT}/`)) {
      const leaf = dir.slice(BOOK_DATA_ROOT.length + 1);
      if (leaf.includes("/") || !leaf.endsWith(BOOK_DIR_SUFFIX)) continue;
      const token = leaf.slice(0, -BOOK_DIR_SUFFIX.length);
      const bookPath = decodeBookPathToken(token);
      // 解码失败说明不是墨本写的目录（或 token 被改坏）：不动它更安全
      if (!bookPath) {
        result.kept += 1;
        continue;
      }
      if (await liveBook(bookPath)) continue;
      const removed = await enqueueIndexTask(bookPath, () => removeBookDataDir(vault, adapter, dir));
      if (removed) result.removed += 1;
      else result.kept += 1;
      continue;
    }

    /*
     * 旧版公共根叶子：`墨本索引/<token>.墨本索引`。
     * 本子还在就把索引页迁到新的「墨本文件」叶子，再删旧目录；
     * 本子没了当孤儿删。
     */
    if (dir.startsWith(`${LEGACY_INDEX_ROOT}/`)) {
      const leaf = dir.slice(LEGACY_INDEX_ROOT.length + 1);
      if (leaf.includes("/") || !leaf.endsWith(LEGACY_INDEX_DIR_SUFFIX)) continue;
      const token = leaf.slice(0, -LEGACY_INDEX_DIR_SUFFIX.length);
      const bookPath = decodeBookPathToken(token);
      if (!bookPath) {
        result.kept += 1;
        continue;
      }
      if (!(await liveBook(bookPath))) {
        const removed = await enqueueIndexTask(bookPath, () => removeIndexDir(vault, adapter, dir));
        if (removed) result.removed += 1;
        else result.kept += 1;
        continue;
      }
      const migrated = await enqueueIndexTask(bookPath, () =>
        migrateLegacyIndexDir(vault, adapter, dir, asBookFile(bookPath))
      );
      if (migrated) result.removed += 1;
      else result.kept += 1;
      continue;
    }

    /*
     * 更旧的同目录目录：`<本子名>.墨本索引/`（与本子同一个笔记文件夹）。
     * 先按目录名推出本子路径。本子还在就迁移索引页，
     * 本子没了才当孤儿删。迁移也走 enqueueIndexTask，避免和同一本的
     * 在途写入互相踩。
     */
    const slash = dir.lastIndexOf("/");
    const parent = slash >= 0 ? dir.slice(0, slash) : "";
    const bookBase = dir.slice(slash + 1, -LEGACY_INDEX_DIR_SUFFIX.length);
    if (!bookBase) continue;
    const bookPath = parent ? `${parent}/${bookBase}.inkbook` : `${bookBase}.inkbook`;
    const exists = await liveBook(bookPath);
    if (!exists) {
      const removed = await enqueueIndexTask(bookPath, () => removeIndexDir(vault, adapter, dir));
      if (removed) result.removed += 1;
      else result.kept += 1;
      continue;
    }

    const migrated = await enqueueIndexTask(bookPath, () =>
      migrateLegacyIndexDir(vault, adapter, dir, asBookFile(bookPath))
    );
    if (migrated) result.removed += 1;
    else result.kept += 1;
  }
  return result;
}

/**
 * 文字索引相关的提示（失败、可疑目录）。
 *
 * 为什么不能只 console.warn：真机上没人看控制台，索引写不出来时用户
 * 看到的只是「全局搜索永远搜不到本子里的文字」。
 *
 * 为什么不能报成「保存失败」：索引是派生物，本子已经正常落盘。
 * 自动保存会反复触发索引失败，同一类原因 60 秒内只提示一次，避免刷屏。
 *
 * ### 节流不能拿整条文案当 key（INK-176）
 *
 * 老写法比对整个 msg，而 msg 里含本子名、阶段、页码、具体路径：
 * 多本同时失败、或每次失败的页码不一样时，每条 msg 都不同 → 60s 节流
 * 完全失效，自动保存每 10s 弹一条 10s Notice，把屏幕刷满。
 * 改成调用方传一个**归一化 key**（如 `write|ENOSPC`、`unknown-dir|路径`），
 * 文案里仍然保留细节供展示。
 */
const INDEX_NOTICE_WINDOW_MS = 60_000;
const lastIndexNoticeAt = new Map<string, number>();

function notifyIndexIssue(key: string, msg: string): void {
  const now = Date.now();
  const last = lastIndexNoticeAt.get(key) ?? 0;
  if (now - last < INDEX_NOTICE_WINDOW_MS) return;
  lastIndexNoticeAt.set(key, now);
  // Map 只存有限的几类 key，顺手清掉过期的，别随错误种类无限增长
  for (const [k, at] of lastIndexNoticeAt) {
    if (now - at >= INDEX_NOTICE_WINDOW_MS) lastIndexNoticeAt.delete(k);
  }
  try {
    new Notice(msg, 10000);
  } catch (_) {
    // 极少数测试桩没有 Notice：至少把原因留在控制台
    console.warn("[inkbook] " + msg);
  }
}

/** 失败原因归一化：同类错误（不同本子 / 不同页码）共用一个节流 key */
function indexFailureKey(e: unknown): string {
  const raw = describeError(e).toLowerCase();
  if (raw.includes("enospc") || raw.includes("no space") || raw.includes("quota")) return "disk-full";
  if (raw.includes("eacces") || raw.includes("eperm") || raw.includes("permission")) return "denied";
  if (raw.includes("enoent") || raw.includes("not found") || raw.includes("no such file")) return "missing";
  if (raw.includes("文件表")) return "not-registered";
  return raw.slice(0, 80) || "unknown";
}

function notifyTextIndexFailure(reason: string, key: string): void {
  notifyIndexIssue(
    `write|${key}`,
    `文字索引生成失败：${reason}；全局搜索可能搜不到本子里的文字（本子本身不受影响）。`
  );
}

function describeError(e: unknown): string {
  const text = e instanceof Error && e.message ? e.message : String(e ?? "");
  return text.length > 160 ? `${text.slice(0, 160)}…` : text || "未知错误";
}

/**
 * 写完后的硬校验：索引页必须**真的进了 Obsidian 的文件表**。
 *
 * 只看「磁盘上有文件」不够。真机故障正是「盘上有、文件表没有」：
 * `vault.getFiles()` 与全局搜索都只认文件表，此时文件等于不存在。
 * 校验失败必须让用户知道，否则他只会觉得搜索坏了。
 */
async function verifyIndexRegistered(
  vault: VaultLike,
  dir: string,
  wanted: Set<string>
): Promise<void> {
  if (!hasFileTable(vault) || wanted.size === 0) return;
  // 给异步派发的 create 事件一点时间
  await new Promise((r) => setTimeout(r, 0));
  if (!vault.getAbstractFileByPath(dir)) {
    throw new Error("索引目录没有进入 Obsidian 文件表（全局搜索会搜不到）");
  }
  for (const p of wanted) {
    if (!vault.getAbstractFileByPath(p)) {
      throw new Error(`索引页没有进入 Obsidian 文件表：${p}`);
    }
  }
}

export interface TextIndexResult {
  /** 索引是否真的可用（false 时原因在 error 里） */
  ok: boolean;
  /** 有文字、应当存在索引页的页数 */
  pages: number;
  /** ok=false 时的失败原因（可直接展示给用户） */
  error?: string;
}

/**
 * 每个本子的「正在写索引」链（单飞）。
 *
 * 为什么必须有（2026-11-07 补）：`writeTextIndex` 有四个调用点，其中
 * `view.ts:4750` 是 `void writeTextIndex(...)` 异步启动、`view.ts:4775`
 * 在 flush 时 `await` 又启一轮。两轮并发时：
 *   前一轮在「清理旧索引」阶段按**它当时的 wanted** 删文件，
 *   而后一轮可能刚写完几个新页 —— 这些新页不在前一轮的 wanted 里，
 *   于是被删掉，接着前一轮的 `verify` 报「索引失败」、全局搜索缺页。
 *
 * 同一本子的写索引必须串行：后来的请求排在链尾，等前一轮结束再跑。
 * 用 `file.path` 做键（改名后路径会变，自然分成两条链，不会互相串）。
 */
const indexWriteChain = new Map<string, Promise<unknown>>();

/**
 * 把一个任务排到某本本子的链尾，返回它的结果。
 *
 * 写索引与**删索引**都必须走这里（INK-176）：改名时 `removeTextIndex`
 * 若不排队，旧 key 上还在半途的 `writeTextIndexNow` 会在删除之后把旧目录
 * 的 md 重建回来，之后再没有事件清理 → 搜索里残留旧本子名、点开报
 * 「找不到这本手写本」。排到同一条链上，删除就必然发生在那轮写完之后。
 *
 * 链尾跑完清掉自己，避免 Map 随本子数量无限增长；前一轮失败也照样往下跑。
 */
function enqueueIndexTask<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = indexWriteChain.get(key) ?? Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.catch(() => undefined);
  indexWriteChain.set(key, tail);
  void tail.then(() => {
    if (indexWriteChain.get(key) === tail) indexWriteChain.delete(key);
  });
  return run;
}

/**
 * 写索引：有文字的页各写一个文件，清掉多余的旧页与旧版单文件。
 *
 * **永不抛异常**：索引是附属品，不能因为它坏了就把「保存成功」报成失败。
 * 失败时返回 `ok:false` 并弹一个用户可见的 Notice（同一原因会节流）。
 *
 * 同一个本子的调用会**串行排队**（见 `indexWriteChain`），避免两轮互相
 * 删掉对方刚写的页。
 */
export function writeTextIndex(
  app: App,
  file: TFile,
  book: InkBook,
  opts: { notify?: boolean } = {}
): Promise<TextIndexResult> {
  const key = file.path || file.basename || "?";
  return enqueueIndexTask(key, () => writeTextIndexNow(app, file, book, opts));
}

/**
 * 打开本子时补建缺失的文字索引。
 *
 * `scheduleTextIndex()` 只在保存成功后触发，用户光打开一本老本子不会重写。
 * 索引是派生文件，缺了就该在打开时补一次；已有新命名索引页则不动。
 *
 * ### 缺失目录必须按「缺索引」处理（2026-11-10 真机）
 *
 * 空白本不再预建 `.墨本索引/` 之后，新建的 Word 本子第一次打开时目录还不存在；
 * 真机适配器对不存在的目录 `list` 会抛 ENOENT。老实现把整个异步块 catch 掉，
 * 补建根本没跑，而 Word 本子已有 `texts`、不会像 PDF 那样再触发补抽文字/保存，
 * 于是全局搜索一直 0 结果。先判目录在不在；列不出来也按缺索引交给
 * `writeTextIndex` 自愈，不再让一次 list 失败吞掉整轮补建。
 */
export async function ensureTextIndexOnOpen(
  app: App,
  file: TFile,
  book: InkBook,
  opts: { notify?: boolean } = {}
): Promise<TextIndexResult | null> {
  const hasText = (book.pages ?? []).some((p) =>
    (p?.texts ?? []).some((t) => (t.text || "").trim())
  );
  if (!hasText) return null;

  const vault = app.vault as unknown as VaultLike | undefined;
  const adapter = (vault?.adapter || (app.vault.adapter as unknown as AdapterLike)) as
    | AdapterLike
    | undefined;
  const dir = indexDirFor(file);
  let needsWrite = false;
  try {
    const a = adapter;
    const dirExists = a && typeof a.exists === "function" ? await a.exists(dir) : true;
    if (a && dirExists && typeof a.list === "function") {
      const files = (await a.list(dir))?.files || [];
      // 有新命名的索引页就算健康；只有旧命名 / 空目录才需要重建
      const hasNew = files.some((p) => {
        const name = String(p).split("/").pop() || "";
        return /^.+ · 第 \d+ 页\.md$/.test(name);
      });
      needsWrite = !hasNew;
    } else if (a && typeof a.exists === "function") {
      /*
       * 没有 list 的移动端适配器：不能靠列目录判健康。逐个探测有文字的页
       * 对应的索引文件，全在就不重写——否则每次打开都会跑一遍 writeTextIndex
       * 的兜底清理，几百页的本子白白探几百次路径。
       */
      for (let i = 0; i < book.pages.length; i += 1) {
        const hasText = (book.pages[i]?.texts ?? []).some((t) => (t.text || "").trim());
        if (hasText && !(await a.exists(indexPagePath(file, i + 1)))) {
          needsWrite = true;
          break;
        }
      }
    } else {
      // 连 exists 都没有：无法判健康，按缺索引补建一次（writeTextIndex 自己兜底）
      needsWrite = true;
    }
  } catch (_) {
    /* 目录不存在 / 列不出来 / 探测失败：按缺索引处理，别把补建整段吞掉 */
    needsWrite = true;
  }
  if (!needsWrite) return null;
  return writeTextIndex(app, file, book, opts);
}

/** 真正干活的那一轮（由 `writeTextIndex` 串行调度） */
async function writeTextIndexNow(
  app: App,
  file: TFile,
  book: InkBook,
  opts: { notify?: boolean } = {}
): Promise<TextIndexResult> {
  const dir = indexDirFor(file);
  const vault = app.vault as unknown as VaultLike;
  const adapter = (vault.adapter || (app.vault.adapter as unknown as AdapterLike));
  const wanted = new Set<string>();
  /*
   * 整本一个字都没有：**不建**索引目录（2026-11-10）。
   *
   * 老实现无论如何先 ensureDir 建目录，再发现没有一页有文字，
   * 于是库里每开过一次的空白本子都留下一个空 `.墨本索引/` 目录。
   * 先算出来再决定建不建，既少一次建目录/删目录的抖动，
   * 也让「用户可见的垃圾」根本不会产生。
   */
  const hasAnyText = book.pages.some((p) =>
    (p?.texts ?? []).some((t) => (t.text || "").trim())
  );
  let stage = "准备索引目录";
  try {
    if (hasAnyText) {
      // 先建库根，再建本子的叶子目录；根目录是用户可见的公共入口。
      await ensureIndexRoot(vault, adapter);
      await ensureDir(vault, adapter, dir);
    }

    let linkMap = new Map<string, string>();
    if (hasAnyText) {
      /*
       * 把 `.inkbook` 双链改指到目标本子的文字索引页，让 Obsidian 关系图谱
       * 能连出真实的边（图谱只认 Markdown，非 md 的 .inkbook 连不上）。
       * 解析/探测失败就算了，保持原链接不阻断索引写入。
       */
      try {
        const allTexts = book.pages.map((p) => pageText(p || ({} as Page)));
        linkMap = await buildInkbookLinkMap(app, file.path, allTexts);
      } catch (_) {
        linkMap = new Map<string, string>();
      }
    }
    const rewriteText = (t: string) => rewriteInkbookLinks(t, linkMap);

    for (let i = 0; i < book.pages.length; i += 1) {
      const pageNo = i + 1;
      const path = indexPagePath(file, pageNo);
      stage = `写第 ${pageNo} 页`;
      const content = buildPageIndex(file, book, i, rewriteText);
      // 没有文字的页不生成文件，但仍标记为「不该存在」，下面会清掉旧文件
      const hasText = (book.pages[i]?.texts ?? []).some((t) => (t.text || "").trim());
      if (!hasText) continue;
      wanted.add(path);
      await writeIndexFile(vault, adapter, path, content);
    }

    stage = "清理旧索引";
    /*
     * 没有文字的空白本子压根没建目录（见上面的 hasAnyText），
     * 此时不能直接 list：真机适配器对不存在的目录会抛 ENOENT，
     * 整个 writeTextIndex 会因此报「索引失败」，把好好的保存吓成失败。
     */
    const dirExists = typeof adapter.exists === "function" ? await adapter.exists(dir) : true;
    // 页数变少 / 某页文字被清空：删掉对应的索引页；旧命名统一迁移掉
    if (dirExists && typeof adapter.list === "function") {
      const listed = await adapter.list(dir);
      for (const p of listed?.files || []) {
        const name = p.split("/").pop() || "";
        /*
         * 旧命名 `第 N 页.md`：不参与 wanted 的比对，一律删掉。
         * 新命名的索引页已经在上面写好了，留着旧的只会让搜索结果里
         * 同一页出现两份（一份叫「第 12 页」，一份叫「数学 · 第 12 页」）。
         */
        if (LEGACY_PAGE_FILE_RE.test(name)) {
          await removeIndexFile(vault, adapter, p);
          continue;
        }
        if (!PAGE_FILE_RE.test(name)) continue;
        if (!wanted.has(p)) await removeIndexFile(vault, adapter, p);
      }
    } else if (dirExists) {
      /*
       * 没有 `adapter.list`（测试桩 / 某些移动适配器）：老实现整段清理被跳过，
       * 某页文字清空或删页后旧索引页永远留着 → 全局搜索命中已删掉的文字。
       * 逐个 exists 探测 1..上界，把不在 wanted 里的（含旧命名）删掉。
       * 上界 = max(当前页数, wanted 里最大页码, 上次页数 + 余量)：
       * 本子从 100 页缩到 3 页时，没有 list 就无法知道曾经有多少页，
       * 多探一段余量（最多 32 页）能覆盖常见的「删了几页」，成本可控。
       * 极端残留（比如从 857 页缩到 3 页）仍需要走有 list 的适配器或重建索引命令。
       */
      let maxPage = book.pages.length;
      for (const p of wanted) {
        const m = p.match(/第 (\d+) 页\.md$/);
        if (m) maxPage = Math.max(maxPage, Number(m[1]) || 0);
      }
      maxPage += 32; // 余量覆盖「删了几页」；再高的残留只能靠有 list 的适配器或重建索引命令
      for (let pageNo = 1; pageNo <= maxPage; pageNo += 1) {
        stage = `清理旧索引（探测第 ${pageNo} 页）`;
        const candidates = [indexPagePath(file, pageNo), `${dir}/第 ${pageNo} 页.md`];
        for (const p of candidates) {
          if (wanted.has(p)) continue;
          if (await adapter.exists(p)) await removeIndexFile(vault, adapter, p);
        }
      }
      stage = "清理旧索引";
    }

    // 旧方案留下的一本一个大 md：迁移时删掉，免得搜索结果里出现两份
    const legacy = legacyIndexPath(file);
    if (await adapter.exists(legacy)) {
      await removeIndexFile(vault, adapter, legacy);
    }

    /*
     * 旧版同目录叶子：新索引已经写完后再安全删除它。
     * 不在这里把旧页复制进新叶子——当前这本刚按最新书稿重写过，
     * 复制旧内容反而会把已删页/旧文字带回来。迁移旧页面的职责在
     * sweepOrphanIndexDirs（那本没被打开、没有最新书稿时）。
     */
    const oldDir = legacyIndexDirFor(file);
    if (await adapter.exists(oldDir)) {
      stage = "清理旧索引目录";
      await removeIndexDir(vault, adapter, oldDir);
      stage = "清理旧索引";
    }

    /*
     * 旧版公共根叶子（INK-226 的 `墨本索引/<token>.墨本索引`）：这本刚按
     * 最新书稿把索引重写进了新叶子，旧叶子里的页已经过时，直接清掉，
     * 免得搜索结果里同一页出现两份。sweep 会负责没被打开过的本子。
     */
    const oldRootDir = legacyRootIndexDirForPath(file.path);
    if (await adapter.exists(oldRootDir)) {
      stage = "清理旧索引目录";
      await removeIndexDir(vault, adapter, oldRootDir);
      stage = "清理旧索引";
    }

    /*
     * 整本一个字都没有 → 把索引目录也收掉（2026-11-10）。
     *
     * `ensureDir` 在上面先建了目录，可这本一页文字都没有，最后里面
     * 一个索引页也不剩。留着就是一个空目录：用户翻笔记文件夹时看到
     * 一排「XX.墨本索引」点进去却是空的（真机反馈「文件夹里好多份文件」）。
     * 本子还在，下次有文字时 ensureDir 会重新建，不会丢任何东西。
     */
    if (wanted.size === 0) {
      stage = "清理空索引目录";
      await removeIndexDir(vault, adapter, dir);
      return { ok: true, pages: 0 };
    }

    stage = "校验索引";
    await verifyIndexRegistered(vault, dir, wanted);

    return { ok: true, pages: wanted.size };
  } catch (e) {
    const reason = `${stage}时失败：${describeError(e)}`;
    console.warn("[inkbook] 写文字索引失败（不影响本子保存）", e);
    if (opts.notify !== false) {
      // 文案带本子名/阶段/页码方便排查，但节流 key 只按错误类型算，避免刷屏
      notifyTextIndexFailure(`${file.basename || "未命名"}（${reason}）`, indexFailureKey(e));
    }
    return { ok: false, pages: wanted.size, error: reason };
  }
}

/**
 * 删掉整份索引（本子被删/改名时用；失败也无所谓，它只是派生数据）。
 *
 * `oldPath`：**改名**时 vault 传进来的 `f` 已经是新路径，
 * 按它算出来的目录是「新的、还没生成」的——旧目录永远删不掉，
 * 于是搜索结果里留着旧本子名，点开报「找不到这本手写本」。
 * 所以 rename 必须把 oldPath 传进来，按旧路径算目录。
 */
export function removeTextIndex(
  app: App,
  file: TFile,
  oldPath?: string
): Promise<void> {
  /*
   * 排到**旧路径那条链**的尾部。
   *
   * 为什么是 oldPath 的 key：在途的 `writeTextIndexNow` 是按改名前的
   * `file.path` 入链的，它写的也是旧目录。排在新 key 上等于没排，删除
   * 仍会先于那轮写入完成，随后旧目录又被重建回来。
   * 选排队而不是「作废旧链」：作废拿不到在途任务的句柄，只能靠标志位
   * 让它自己中途退出，写一半的目录还是得清；排队则天然保证「先写完、
   * 再全删」，语义最简单也最稳。
   */
  const key = oldPath || file.path || file.basename || "?";
  return enqueueIndexTask(key, async () => {
    const vault = app.vault as unknown as VaultLike;
    const adapter = (vault.adapter || (app.vault.adapter as unknown as AdapterLike));
    try {
      // 用一个「路径伪装成 TFile」的对象复用 dirOf/baseOf/indexDirFor
      const target = oldPath
        ? ({
            path: oldPath,
            basename: oldPath.split("/").pop()!.replace(/\.inkbook$/i, ""),
            parent: { path: oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/")) : "/" },
          } as unknown as TFile)
        : file;
      const legacy = legacyIndexPath(target);
      if (await adapter.exists(legacy)) {
        await removeIndexFile(vault, adapter, legacy);
      }
      /*
       * 三代目录都要删：
       *   · 当前数据叶子（`墨本文件/<token>.墨本`，索引 + 底图/原件都要清）；
       *   · 旧版公共根叶子（`墨本索引/<token>.墨本索引`，历史残留）；
       *   · 更旧的同目录叶子（`<本子名>.墨本索引/`，历史残留）。
       * 老实现只删目录里的 md、把空目录留在原地，用户会看到一排空目录。
       */
      await removeBookDataDir(vault, adapter, dataDirForPath(target.path));
      await removeIndexDir(vault, adapter, legacyRootIndexDirForPath(target.path));
      await removeIndexDir(vault, adapter, legacyIndexDirFor(target));
    } catch (_) {
      /* 派生数据，删不掉不算错 */
    }
  });
}
