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
 * 代价是文件多（有文字的页才有文件，通常远少于总页数），
 * 集中放在 `<本子名>.墨本索引/` 目录里，不影响本子本身。
 */
export const INDEX_DIR_SUFFIX = ".墨本索引";

/** 旧方案（一本一个 md）的文件名后缀，遇到就删掉 */
export const LEGACY_INDEX_SUFFIX = ".墨本文字.md";

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
  /*
   * 两种名字都要认：
   *   · 新：`<本子名> · 第 N 页.md`
   *   · 旧：`第 N 页.md`
   * 旧文件要等下一次保存才会被清掉；在那之前，搜索结果里残留的旧链接
   * 点开也应该能跳回本子，而不是停在一页过期的索引上。
   * 文件名前缀（本子名）允许为空，兼容历史数据。
   */
  const m = path.match(/^(.*)\.墨本索引\/(?:.+ · )?第 (\d+) 页\.md$/);
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
 * 索引全是派生数据，所以这里直接删掉未登记的旧目录，再用 `createFolder`
 * 建一个会被登记的。删不掉才退回裸建（最终校验会把它报出来）。
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
       */
      if (
        typeof adapter.rmdir === "function" &&
        dir.length > INDEX_DIR_SUFFIX.length &&
        dir.endsWith(INDEX_DIR_SUFFIX)
      ) {
        try {
          if (await adapter.exists(dir)) {
            await adapter.rmdir(dir, true);
            await vault.createFolder(dir);
            await new Promise((r) => setTimeout(r, 0));
            if (vault.getAbstractFileByPath(dir)) return;
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
 * 索引失败时给用户看的提示。
 *
 * 为什么不能只 console.warn：真机上没人看控制台，索引写不出来时用户
 * 看到的只是「全局搜索永远搜不到本子里的文字」。
 *
 * 为什么不能报成「保存失败」：索引是派生物，本子已经正常落盘。
 * 自动保存会反复触发索引失败，同一句原因 60 秒内只提示一次，避免刷屏。
 */
let lastFailureNoticeAt = 0;
let lastFailureNoticeText = "";

function notifyTextIndexFailure(reason: string): void {
  const msg = `文字索引生成失败：${reason}；全局搜索可能搜不到本子里的文字（本子本身不受影响）。`;
  const now = Date.now();
  if (msg === lastFailureNoticeText && now - lastFailureNoticeAt < 60_000) return;
  lastFailureNoticeAt = now;
  lastFailureNoticeText = msg;
  try {
    new Notice(msg, 10000);
  } catch (_) {
    // 极少数测试桩没有 Notice：至少把原因留在控制台
    console.warn("[inkbook] " + msg);
  }
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
  const prev = indexWriteChain.get(key) ?? Promise.resolve();
  // 无论前一轮成功失败都接着往下跑（失败不该卡死后续索引）
  const run = prev.then(
    () => writeTextIndexNow(app, file, book, opts),
    () => writeTextIndexNow(app, file, book, opts)
  );
  const tail = run.catch(() => undefined);
  indexWriteChain.set(key, tail);
  // 链尾跑完就清掉，避免 Map 随本子数量无限增长
  void tail.then(() => {
    if (indexWriteChain.get(key) === tail) indexWriteChain.delete(key);
  });
  return run;
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
  let stage = "准备索引目录";
  try {
    await ensureDir(vault, adapter, dir);

    for (let i = 0; i < book.pages.length; i += 1) {
      const pageNo = i + 1;
      const path = indexPagePath(file, pageNo);
      stage = `写第 ${pageNo} 页`;
      const content = buildPageIndex(file, book, i);
      // 没有文字的页不生成文件，但仍标记为「不该存在」，下面会清掉旧文件
      const hasText = (book.pages[i]?.texts ?? []).some((t) => (t.text || "").trim());
      if (!hasText) continue;
      wanted.add(path);
      await writeIndexFile(vault, adapter, path, content);
    }

    stage = "清理旧索引";
    // 页数变少 / 某页文字被清空：删掉对应的索引页；旧命名统一迁移掉
    if (typeof adapter.list === "function") {
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
    }

    // 旧方案留下的一本一个大 md：迁移时删掉，免得搜索结果里出现两份
    const legacy = legacyIndexPath(file);
    if (await adapter.exists(legacy)) {
      await removeIndexFile(vault, adapter, legacy);
    }

    stage = "校验索引";
    await verifyIndexRegistered(vault, dir, wanted);

    return { ok: true, pages: wanted.size };
  } catch (e) {
    const reason = `${stage}时失败：${describeError(e)}`;
    console.warn("[inkbook] 写文字索引失败（不影响本子保存）", e);
    if (opts.notify !== false) {
      notifyTextIndexFailure(`${file.basename || "未命名"}（${reason}）`);
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
export async function removeTextIndex(
  app: App,
  file: TFile,
  oldPath?: string
): Promise<void> {
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
    const dir = indexDirFor(target);
    if (typeof adapter.list !== "function") return;
    if (!(await adapter.exists(dir))) return;
    const listed = await adapter.list(dir);
    for (const p of listed?.files || []) await removeIndexFile(vault, adapter, p);
  } catch (_) {
    /* 派生数据，删不掉不算错 */
  }
}
