/**
 * 插件生成文件的统一存放与迁移。
 *
 * 用户要求（2026-11-12）：
 *   「把插件生成的索引、PDF 原件、导入底图统一收进一个文件夹，并且分好类——
 *     某本本子的底图和索引放在同一个文件夹里，不要跟别的本子弄混。」
 *
 * 落点：库根 `墨本文件/<token>.墨本/`（见 indexer.ts 的 dataDirForPath）。
 * 历史版本把文件散在：
 *   · 本子旁边的 `<本子目录>/.inkbook-assets/`（Word 导入的底图 PNG）；
 *   · 库根 `.inkbook-assets/`（从设备导入的 PDF / Word 原件）；
 *   · 库根 `墨本索引/<token>.墨本索引/`（旧文字索引，indexer 负责迁移）。
 * 本模块负责把前两类的旧文件搬进「墨本文件」并改写 `.inkbook` 里的引用，
 * 以及本子改名时把整个数据叶子一起搬走、同步改写引用。
 */

import { type App, type TFile } from "obsidian";
import {
  dataDirForPath,
  ensureBookDataDir,
  INCOMING_DIR,
  legacyRootIndexDirForPath,
} from "./indexer";
import { readBook, writeBook } from "./storage";
import type { InkBook } from "./types";

/** 旧版「散落」的生成物目录：任意层级的 `.inkbook-assets/`。 */
const LEGACY_ASSET_RE = /(?:^|\/)\.inkbook-assets\//;

/** 这个库内路径是不是旧版散落的生成物（需要迁进「墨本文件」）。 */
export function isLegacyAssetPath(path: string): boolean {
  return !!path && LEGACY_ASSET_RE.test(path);
}

/** 适配器上本模块用到的部分（Obsidian 的 DataAdapter 都有；测试桩按需补）。 */
interface MoveAdapter {
  exists: (path: string) => Promise<boolean>;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  readBinary?: (path: string) => Promise<ArrayBuffer>;
  writeBinary?: (path: string, data: ArrayBuffer) => Promise<void>;
  remove?: (path: string) => Promise<void>;
  list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
  rmdir?: (path: string, recursive?: boolean) => Promise<void>;
  mkdir?: (path: string) => Promise<void>;
}

function dirOfPath(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

function baseOfPath(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

/** 在目标目录里给 `name` 找一个不冲突的文件名（同目录内去重）。 */
async function uniqueTarget(adapter: MoveAdapter, dir: string, name: string, taken: Set<string>): Promise<string> {
  let candidate = `${dir}/${name}`;
  let n = 1;
  while (taken.has(candidate) || (await adapter.exists(candidate))) {
    const [stem, ext] = splitExt(name);
    candidate = `${dir}/${stem}-${++n}${ext}`;
  }
  taken.add(candidate);
  return candidate;
}

/** 把一个文件从 oldPath 移到 newPath（优先 rename，否则读二进制再写再删）。 */
async function moveFile(adapter: MoveAdapter, oldPath: string, newPath: string): Promise<boolean> {
  if (typeof adapter.rename === "function") {
    await adapter.rename(oldPath, newPath);
    return true;
  }
  if (typeof adapter.readBinary === "function" && typeof adapter.writeBinary === "function") {
    const buf = await adapter.readBinary(oldPath);
    await adapter.writeBinary(newPath, buf);
    if (typeof adapter.remove === "function") await adapter.remove(oldPath);
    return true;
  }
  return false;
}

/** 目录空了才删（不递归、不误删）；失败无所谓。 */
async function removeDirIfEmpty(adapter: MoveAdapter, dir: string): Promise<void> {
  if (!dir || typeof adapter.list !== "function") return;
  try {
    if (!(await adapter.exists(dir))) return;
    const listed = await adapter.list(dir);
    if ((listed?.files || []).length === 0 && (listed?.folders || []).length === 0) {
      if (typeof adapter.rmdir === "function") await adapter.rmdir(dir, false);
    }
  } catch (_) {
    /* 删不掉就留着 */
  }
}

/**
 * 把一本本子里引用的旧版散落生成物搬进它的数据叶子，并改写引用。
 *
 * `book` 会被**原地修改**；返回是否有改动（有改动时调用方负责落盘）。
 * 只搬「`.inkbook-assets/` 下的文件」，其它路径（比如用户自己放进库里的
 * PDF）一律不动——那不是插件生成的，搬走反而会让用户找不到原件。
 */
export async function migrateBookAssets(app: App, bookPath: string, book: InkBook): Promise<boolean> {
  const adapter = app.vault.adapter as unknown as MoveAdapter;
  const dir = dataDirForPath(bookPath);
  const moves = new Map<string, string>();
  const taken = new Set<string>();
  const legacyDirs = new Set<string>();
  let changed = false;

  const relocate = async (oldPath: string | undefined): Promise<string | undefined> => {
    if (!oldPath || !isLegacyAssetPath(oldPath)) return oldPath;
    const cached = moves.get(oldPath);
    if (cached) return cached;
    let exists = false;
    try {
      exists = await adapter.exists(oldPath);
    } catch (_) {
      exists = false;
    }
    // 旧文件已经不在了（被删/被别的本子搬走）：保持原样，别写坏引用
    if (!exists) return oldPath;
    try {
      await ensureBookDataDir(app, bookPath);
      const target = await uniqueTarget(adapter, dir, baseOfPath(oldPath), taken);
      moves.set(oldPath, target);
      legacyDirs.add(dirOfPath(oldPath));
      changed = true;
      if (!(await moveFile(adapter, oldPath, target))) {
        moves.delete(oldPath);
        changed = false;
        return oldPath;
      }
      return target;
    } catch (_) {
      moves.delete(oldPath);
      return oldPath;
    }
  };

  for (const page of book.pages || []) {
    const bg = page?.background;
    if (bg) {
      if (bg.src) {
        const next = await relocate(bg.src);
        if (next && next !== bg.src) bg.src = next;
      }
      if (bg.pdf?.path) {
        const next = await relocate(bg.pdf.path);
        if (next && next !== bg.pdf.path) bg.pdf.path = next;
      }
    }
    // 插入的图片同样可能在旧的 `.inkbook-assets/` 下，一并搬进数据叶子
    for (const im of page?.images || []) {
      if (!im?.src) continue;
      const next = await relocate(im.src);
      if (next && next !== im.src) im.src = next;
    }
  }
  if (book.source?.path) {
    const next = await relocate(book.source.path);
    if (next && next !== book.source.path) book.source.path = next;
  }

  // 旧的 `.inkbook-assets/` 目录若已搬空就顺手删掉，别留空壳
  for (const legacy of legacyDirs) await removeDirIfEmpty(adapter, legacy);
  return changed;
}

/**
 * 把「从设备选进来」的临时文件（在 `墨本文件/.incoming/`）搬进目标本子的
 * 数据叶子，返回一个新路径的 TFile。
 *
 * 库里本来就有的文件（不是 `.incoming/` 下的）原样返回——那是用户自己的
 * 原件，按引用使用，不做搬动。
 */
export async function adoptIncomingSource(
  app: App,
  file: TFile,
  bookPath: string
): Promise<TFile> {
  const p = file?.path;
  if (!p || !p.startsWith(`${INCOMING_DIR}/`)) return file;
  const adapter = app.vault.adapter as unknown as MoveAdapter;
  const dir = await ensureBookDataDir(app, bookPath);
  const target = await uniqueTarget(adapter, dir, baseOfPath(p), new Set<string>());
  if (!(await moveFile(adapter, p, target))) return file;
  const name = baseOfPath(target);
  const dot = name.lastIndexOf(".");
  return {
    path: target,
    name,
    basename: dot > 0 ? name.slice(0, dot) : name,
    extension: dot > 0 ? name.slice(dot + 1) : "",
    stat: (file as any)?.stat,
  } as unknown as TFile;
}

/** 读一本、迁移它的生成物、有改动则落盘。返回是否搬过东西。 */
export async function migrateBookFile(app: App, file: TFile): Promise<boolean> {  const adapter = app.vault.adapter as unknown as MoveAdapter;
  const book = await readBook(adapter as any, file.path, file.basename);
  const changed = await migrateBookAssets(app, file.path, book);
  if (changed) await writeBook(adapter as any, file.path, book);
  return changed;
}

export interface GeneratedFilesMigrationResult {
  books: number;
  migrated: number;
  failed: number;
}

/**
 * 全库一次性迁移：把每本本子散落的生成物收进「墨本文件」。
 * 逐本读、逐本写，一本坏掉不影响其余。**永不抛异常**。
 */
export async function migrateAllGeneratedFiles(app: App): Promise<GeneratedFilesMigrationResult> {
  const result: GeneratedFilesMigrationResult = { books: 0, migrated: 0, failed: 0 };
  let files: TFile[] = [];
  try {
    files = (app.vault.getFiles() || []).filter(
      (f) => (f.extension || "").toLowerCase() === "inkbook"
    );
  } catch (_) {
    return result;
  }
  for (const f of files) {
    result.books += 1;
    try {
      if (await migrateBookFile(app, f)) result.migrated += 1;
    } catch (e) {
      result.failed += 1;
      console.warn("[inkbook] 迁移生成文件失败（跳过这本）：" + f.path, e);
    }
  }
  return result;
}

/**
 * 本子改名 / 移动时，把整个数据叶子（索引页 + 底图/原件）搬到新 token 目录，
 * 并改写盘上 `.inkbook` 里的引用。
 *
 * 返回新旧目录，供打开中的视图同步改写内存里的引用（否则它下一次保存
 * 会把旧路径又写回去）。没有旧目录（这本没导入过东西）返回 null。
 */
export async function moveBookDataDirOnRename(
  app: App,
  oldPath: string,
  newPath: string
): Promise<{ oldDir: string; newDir: string } | null> {
  const adapter = app.vault.adapter as unknown as MoveAdapter;
  const oldDir = dataDirForPath(oldPath);
  const newDir = dataDirForPath(newPath);
  if (!oldPath || !newPath || oldDir === newDir) return null;
  let exists = false;
  try {
    exists = await adapter.exists(oldDir);
  } catch (_) {
    exists = false;
  }
  if (!exists) return null;
  if (typeof adapter.list !== "function") return null;

  try {
    // 先读出新路径上的本子（读不出来就别动文件，避免「搬了文件却没改引用」）
    const basename = (newPath.split("/").pop() || "未命名").replace(/\.inkbook$/i, "");
    const book = await readBook(adapter as any, newPath, basename);

    await ensureBookDataDir(app, newPath);
    const listed = await adapter.list(oldDir);
    const taken = new Set<string>();
    for (const p of listed?.files || []) {
      const target = await uniqueTarget(adapter, newDir, baseOfPath(p), taken);
      await moveFile(adapter, p, target);
    }
    await removeDirIfEmpty(adapter, oldDir);

    // 盘上的本子引用也要跟着改（本子关着时没人会替它改）
    if (remapAssetPrefix(book, oldDir, newDir)) {
      await writeBook(adapter as any, newPath, book);
    }
    return { oldDir, newDir };
  } catch (e) {
    console.warn("[inkbook] 改名时搬移数据目录失败：" + oldPath + " → " + newPath, e);
    return null;
  }
}

/**
 * 把 book 里所有以 `oldDir/` 开头的生成物引用改成 `newDir/`。
 * 返回是否有改动。打开中的视图用它同步内存，避免保存时把旧路径写回去。
 */
export function remapAssetPrefix(book: InkBook, oldDir: string, newDir: string): boolean {
  if (!oldDir || !newDir || oldDir === newDir) return false;
  const prefix = `${oldDir}/`;
  const swap = (p?: string): string | undefined =>
    p && p.startsWith(prefix) ? `${newDir}/${p.slice(prefix.length)}` : p;
  let changed = false;
  for (const page of book.pages || []) {
    const bg = page?.background;
    if (bg) {
      if (bg.src) {
        const next = swap(bg.src);
        if (next && next !== bg.src) {
          bg.src = next;
          changed = true;
        }
      }
      if (bg.pdf?.path) {
        const next = swap(bg.pdf.path);
        if (next && next !== bg.pdf.path) {
          bg.pdf.path = next;
          changed = true;
        }
      }
    }
    // 插入图片的路径前缀也要跟着数据目录改名一起换
    for (const im of page?.images || []) {
      if (!im?.src) continue;
      const next = swap(im.src);
      if (next && next !== im.src) {
        im.src = next;
        changed = true;
      }
    }
  }
  if (book.source?.path) {
    const next = swap(book.source.path);
    if (next && next !== book.source.path) {
      book.source.path = next;
      changed = true;
    }
  }
  return changed;
}

export { legacyRootIndexDirForPath };
