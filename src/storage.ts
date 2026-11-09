import {
  A4_HEIGHT,
  A4_WIDTH,
  createLayer,
  createPage,
  type InkBook,
  type Layer,
  type Page,
  type Pt,
} from "./types";

/**
 * 当前支持的 .inkbook 文件版本。
 *
 * 读到 `version > CURRENT_VERSION` 的文件必须**拒绝打开**，
 * 而不是照旧解析——老版本代码不认识新字段，normalizeBook 会把它们
 * 全丢掉，再保存一次就把新版本写的东西永久抹掉了。
 */
export const CURRENT_VERSION = 2;
/*
 * 版本历史：
 *   1 —— 初版（笔迹 + 底图）
 *   2 —— 页面可以带 texts（PDF 原文文本层 + 手动添加的文字）
 */

/** 备份后缀：每次写正文前把旧内容抄到这里 */
const BACKUP_SUFFIX = ".bak";
/** 临时后缀：先写这里再改名，避免半截文件顶上正文 */
const TMP_SUFFIX = ".tmp";

/**
 * `.bak` 的最小刷新间隔。
 *
 * 每写一笔就复制一遍全书，在大小说上等于每次保存写两倍体积
 * （实测 6.34MB 的书，单笔保存写 12.69MB：「每 850ms 一次」的防抖保存
 * 会让磁盘一直忙着搬同样的字节）。
 *
 * 为什么可以容忍 `.bak` 最多旧 45 秒：正文本身走 `.tmp` + `rename` 原子写，
 * 半截文件根本顶不上正文；`.bak` 只是第二层保险——防的是"写成功了但内容
 * 是坏的"（序列化错、磁盘坏块、同步把新文件截断）。这种概率事件不需要
 * 精确到秒的新鲜度，45 秒前的版本足够救回来。冲突检测另有一套（指纹），
 * 不依赖 `.bak`。
 */
const BACKUP_MIN_INTERVAL_MS = 45_000;

/** 文件版本比本插件支持的新：不能打开，否则会覆盖掉新字段 */
export class TooNewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TooNewError";
  }
}

/** 文件读不出来（JSON 坏掉 / 完整性对不上） */
export class CorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptError";
  }
}

/** 磁盘文件的「指纹」：修改时间 + 字节数，用来发现外部改动 */
export interface FileFingerprint {
  mtime: number;
  size: number;
}

/** 只用到 stat 的适配器（Obsidian 的 DataAdapter 满足；测试里可以没有） */
export interface StatAdapter {
  stat?: (path: string) => Promise<{ mtime: number | Date; size: number } | null>;
}

/** 读文件用到的适配器能力 */
export interface ReadAdapter {
  read: (path: string) => Promise<string>;
  exists: (path: string) => Promise<boolean>;
}

/** 写文件用到的适配器能力（rename / exists / read / remove 都可以没有） */
export interface WriteAdapter extends StatAdapter {
  write: (path: string, data: string) => Promise<void>;
  exists?: (path: string) => Promise<boolean>;
  read?: (path: string) => Promise<string>;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  remove?: (path: string) => Promise<void>;
}

/**
 * 统计一本书的页数与笔迹数。
 *
 * 只数「有点的笔迹」——读取端 `normalizeBook` 会扔掉空笔迹，
 * 若这里把空笔迹也算进去，下次打开就会误报「文件可能不完整」。
 * 统计口径必须与读取端一致。
 */
export function bookStats(book: InkBook): { pageCount: number; strokeCount: number } {
  let strokeCount = 0;
  const pages = Array.isArray(book?.pages) ? book.pages : [];
  for (const page of pages) {
    const layers = Array.isArray(page?.layers) ? page.layers : [];
    for (const layer of layers) {
      const strokes = Array.isArray(layer?.strokes) ? layer.strokes : [];
      for (const stroke of strokes) {
        if (stroke && Array.isArray(stroke.points) && stroke.points.length) strokeCount += 1;
      }
    }
  }
  return { pageCount: pages.length, strokeCount };
}

/**
 * 取文件指纹。失败一律返回 null，不抛——
 * 拿不到指纹时只是「这次不做冲突检测」，不该让保存整体失败。
 */
export async function fingerprint(
  adapter: StatAdapter,
  path: string
): Promise<FileFingerprint | null> {
  const stat = adapter?.stat;
  if (typeof stat !== "function") return null;
  try {
    const st = await stat.call(adapter, path);
    if (!st) return null;
    // 不同平台/版本的 Obsidian 里 mtime 可能是 number 也可能是 Date
    const rawMtime: number | Date = st.mtime;
    const mtime =
      typeof rawMtime === "number"
        ? rawMtime
        : rawMtime instanceof Date
        ? rawMtime.getTime()
        : Number(rawMtime) || 0;
    return { mtime, size: Number(st.size) || 0 };
  } catch (e) {
    console.warn("[inkbook] 取文件指纹失败", e);
    return null;
  }
}

/**
 * 规范化一条笔迹的点数组。
 *
 * 为什么需要单独一个函数：点是整个文件里**数量最多**的东西。
 * 300 页 × 200 条笔迹 × 60 个点 = 360 万个点，一本 72MB 的本子光是把
 * 这些点重建成 `[x, y, p]` 就是 360 万次小数组分配——实测这一段的
 * 分配开销占 normalizeBook 的大头（72MB 样本 130ms）。
 *
 * 关键事实：磁盘上写出来的点**本来就是** `[number, number, number]`。
 * 我们自己写的、旧版本写的都长这样。所以先走一趟只读校验：
 *   · 全部合规 → 原样把数组交回去，零分配（`raw` 在这次调用返回后就是垃圾，
 *     复用它没有任何别名风险）
 *   · 只要有一个不合规 → 整体走慢路径逐点重建（长度 < 2 的丢掉，缺压力值
 *     补 0.5，字符串数字用 Number 转）
 *
 * 合规判据必须是 `Number.isFinite` 而不是 `typeof === "number"`：
 * NaN / Infinity 的 typeof 也是 "number"，只查类型会原样放行。
 * 手感参数一旦被脏 data.json 写坏，NaN 会顺着 pressureFor → points
 * 流进来；这一层是**存档前的最后一道防线**，漏了就永久写坏这一笔
 * （INK-179）。非法坐标/压力按中性值兜底，不让脏值再写回磁盘。
 *
 * 为什么不"洗几个就复用几个"：半洗半留会让「哪些点被规范化过」变得不可预测，
 * 将来排查"某个点为什么是字符串"会变成噩梦。要么全快，要么全慢。
 */
function normalizePoints(list: any[]): Pt[] {
  let clean = true;
  for (let i = 0; i < list.length; i++) {
    const q = list[i];
    if (!Array.isArray(q) || q.length !== 3) {
      clean = false;
      break;
    }
    if (
      !Number.isFinite(q[0]) ||
      !Number.isFinite(q[1]) ||
      !Number.isFinite(q[2])
    ) {
      clean = false;
      break;
    }
  }
  if (clean) return list as Pt[];

  const finite = (v: any, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const out: Pt[] = [];
  for (const q of list) {
    if (!Array.isArray(q) || q.length < 2) continue;
    // 坐标非法时不能瞎补 0（会把点吸到左上角）——直接丢这个点最安全；
    // 压力非法补 0.5（中性力度），与旧路径「缺压力值补 0.5」语义一致。
    const x = Number(q[0]);
    const y = Number(q[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push([x, y, finite(q[2] ?? 0.5, 0.5)]);
  }
  return out;
}

export function normalizeBook(raw: any, fallbackTitle: string): InkBook {
  const book: InkBook = {
    version: CURRENT_VERSION,
    kind: "inkbook",
    title: String(raw?.title || fallbackTitle || "未命名笔记"),
    width: A4_WIDTH,
    height: A4_HEIGHT,
    created: Number(raw?.created) || Date.now(),
    updated: Number(raw?.updated) || 0,
    activePage: Number(raw?.activePage) || 0,
    pages: [],
  };

  const pages = Array.isArray(raw?.pages) && raw.pages.length ? raw.pages : [createPage("grid", "white")];
  book.pages = pages.map((p: any): Page => {
    const layers: Layer[] =
      Array.isArray(p?.layers) && p.layers.length
        ? p.layers.map((l: any): Layer => ({
            id: String(l.id || createLayer().id),
            name: String(l.name || "笔迹层"),
            visible: l.visible !== false,
            opacity: typeof l.opacity === "number" ? Math.max(0, Math.min(1, l.opacity)) : 1,
            strokes: Array.isArray(l.strokes)
              ? l.strokes
                  .filter((s: any) => s && Array.isArray(s.points) && s.points.length)
                  .map((s: any) => ({
                    id: String(s.id || Math.random().toString(36).slice(2)),
                    tool: ["pen", "ballpoint", "highlighter", "shape"].includes(s.tool)
                      ? s.tool
                      : "pen",
                    color: String(s.color || "#1A1A1A"),
                    size: Number(s.size) || 2.8,
                    opacity: typeof s.opacity === "number" ? s.opacity : 1,
                    // 点数组走 normalizePoints：合规就零分配复用，不合规才逐点重建
                    points: normalizePoints(s.points),
                    shape: s.shape,
                  }))
              : [],
          }))
        : [createLayer()];
    const active =
      layers.find((l: Layer) => l.id === p?.activeLayerId) || layers[0] || createLayer();
    const page: Page = {
      id: String(p?.id || createPage("grid", "white").id),
      template: ["blank", "lined", "grid", "dotted", "cornell", "planner"].includes(p?.template)
        ? p.template
        : "grid",
      paper: ["white", "cream", "gray"].includes(p?.paper) ? p.paper : "white",
      layers,
      activeLayerId: active.id,
    };
    /*
     * 文字层（v2）：PDF / Word 原文 + 手动添加的文字。
     * 同样白名单重建——旧版文件没有这个字段，读出来就是空数组。
     */
    const texts = Array.isArray(p?.texts)
      ? p.texts
          .filter(
            (t: any) =>
              t &&
              typeof t.text === "string" &&
              t.text.length > 0 &&
              Number.isFinite(Number(t.x)) &&
              Number.isFinite(Number(t.y)) &&
              Number.isFinite(Number(t.size))
          )
          .map((t: any) => {
            const item: any = {
              id: String(t.id || `text_${Math.random().toString(36).slice(2, 9)}`),
              source: t.source === "user" ? "user" : t.source === "word" ? "word" : "pdf",
              x: Number(t.x),
              y: Number(t.y),
              text: String(t.text),
              size: Math.max(1, Number(t.size)),
            };
            if (typeof t.color === "string") item.color = t.color;
            // 字体只认短 id（sans/serif/kai/mono），别的字符串一律当没写，
            // 免得旧文件里的脏数据把 font-family 拼成奇怪的东西
            if (typeof t.font === "string" && t.font.length <= 16) item.font = t.font;
            if (t.bold === true) item.bold = true;
            // width 只留正的有限值：0 / 负 / NaN 在渲染层一律当「没写」回落自动算法，
            // 落盘时就不该把脏值写回去（否则每次保存都带着一个无意义的字段）
            if (Number.isFinite(Number(t.width)) && Number(t.width) > 0) item.width = Number(t.width);
            return item;
          })
      : [];
    // 空数组也要保留：它表示"这页抽过了、只是没有文字"（扫描版），
    // 丢掉的话每次挂载都会重新抽一遍。
    if (Array.isArray(p?.texts)) page.texts = texts;

    // 底图（导入的 PDF / Word 页）要原样保留
    const bg = p?.background;
    if (bg && typeof bg === "object") {
      const hasSrc = typeof bg.src === "string" && bg.src;
      const hasPdf = bg.pdf && typeof bg.pdf.path === "string" && bg.pdf.path;
      if (hasSrc || hasPdf) {
        page.background = {
          sourceName: String(bg.sourceName || ""),
          sourcePage: Number(bg.sourcePage) || 1,
          x: Number(bg.x) || 0,
          y: Number(bg.y) || 0,
          width: Number(bg.width) || 0,
          height: Number(bg.height) || 0,
          kind: bg.kind === "word" ? "word" : "pdf",
        };
        if (hasSrc) page.background.src = String(bg.src);
        if (hasPdf) {
          page.background.pdf = {
            path: String(bg.pdf.path),
            page: Number(bg.pdf.page) || 1,
          };
        }
      }
    }
    return page;
  });

  book.activePage = Math.max(0, Math.min(book.pages.length - 1, Number(raw?.activePage) || 0));
  const src = raw?.source;
  if (src && (src.kind === "pdf" || src.kind === "word")) {
    book.source = {
      name: String(src.name || ""),
      kind: src.kind,
      pageCount: Number(src.pageCount) || book.pages.length,
    };
    if (typeof src.path === "string" && src.path) book.source.path = src.path;
  }
  // 完整性记录：校验后原样带回，否则第一次保存就会被自己删掉
  const integrity = raw?.integrity;
  if (integrity && typeof integrity === "object") {
    const pageCount = Number(integrity.pageCount);
    const strokeCount = Number(integrity.strokeCount);
    if (Number.isFinite(pageCount) && Number.isFinite(strokeCount)) {
      book.integrity = { pageCount, strokeCount };
    }
  }
  /*
   * 目录（不升版本，与 Page.texts 同批做法）：
   *   · 老文件没有 outlines 字段 → 不写回 → undefined，UI 按空目录处理；
   *   · 逐条白名单：id 存在、title 是非空字符串、page 是有限非负整数，
   *     一条不满足就整条丢弃（脏数据不留在内存，也就不会被保存回去）；
   *   · **id 去重**：只保留第一次出现的。UI 全用 id 定位条目
   *     （`findIndex` / `find`），重复 id 会让第二条永远选不中也删不掉，
   *     变成点不到的孤儿条目。正常流程不会产生重复（`uid("outline")`
   *     唯一），但手改文件、或两份文件合并时可能带进来。
   *   · 过滤完为空时不写回——空目录 = 没这个字段，省体积、语义一致。
   */
  const outlines = Array.isArray(raw?.outlines)
    ? raw.outlines
        .filter(
          (o: any) =>
            o &&
            typeof o === "object" &&
            typeof o.id === "string" &&
            o.id.length > 0 &&
            typeof o.title === "string" &&
            o.title.trim().length > 0 &&
            Number.isInteger(Number(o.page)) &&
            Number(o.page) >= 0
        )
        .map((o: any) => ({
          id: String(o.id),
          title: String(o.title),
          page: Number(o.page),
        }))
        .filter((o: any, i: number, arr: any[]) => arr.findIndex((x: any) => x.id === o.id) === i)
    : undefined;
  if (outlines !== undefined && outlines.length > 0) book.outlines = outlines;
  /*
   * 视图状态（zoom / scrollTop，不升版本，与 outlines 同批做法）：
   *   · zoom 只认真正的 number（字符串 "1.5"、null 一律当没写）并夹到
   *     [0.3, 2.8]。夹取而不是丢弃——「用户手动缩放过」这个信息有价值，
   *     不该因为一个脏数字就退回 fit；但也不能原样放行：99 倍 zoom 会让
   *     打开时先按 99 倍排一次版，可能直接把主线程卡死。
   *   · scrollTop / scrollLeft 只留正的有限值；0/负/NaN 当没写
   *     （页首 / 页左边是默认行为）。
   *   · 缺省不写回字段——老文件读出来仍是 undefined，打开时走 fit + 页首。
   */
  const zoom = raw?.zoom;
  if (typeof zoom === "number" && Number.isFinite(zoom)) {
    book.zoom = Math.max(0.3, Math.min(2.8, zoom));
  }
  const scrollTop = raw?.scrollTop;
  if (typeof scrollTop === "number" && Number.isFinite(scrollTop) && scrollTop > 0) {
    book.scrollTop = scrollTop;
  }
  /*
   * 水平位置与 scrollTop 同一套校验：只认正的有限数。
   * 未放大时 scrollLeft 恒为 0，「停在左边」不需要字段表达。
   */
  const scrollLeft = raw?.scrollLeft;
  if (typeof scrollLeft === "number" && Number.isFinite(scrollLeft) && scrollLeft > 0) {
    book.scrollLeft = scrollLeft;
  }
  return book;
}

/** 把已经解析好的对象转成书（版本检查 + 白名单重建） */
export function parseBook(raw: any, fallbackTitle: string): InkBook {
  const version = Number(raw?.version);
  if (Number.isFinite(version) && version > CURRENT_VERSION) {
    throw new TooNewError(
      `这本笔记是用更新版本的墨本保存的（文件版本 ${version}，当前墨本只支持到 ${CURRENT_VERSION}）。` +
        `请先升级墨本再打开，否则保存会把新版本的内容抹掉。`
    );
  }
  return normalizeBook(raw, fallbackTitle);
}

export async function readBook(
  adapter: ReadAdapter,
  path: string,
  fallbackTitle: string
): Promise<InkBook> {
  if (!(await adapter.exists(path))) throw new Error("文件不存在");
  const text = await adapter.read(path);
  /*
   * 提示里要不要提 `.bak`，取决于它**到底在不在**（INK-170）。
   * 没有备份却让人"试试 .bak"，用户会去翻一个不存在的文件，
   * 反而以为插件在骗他。这里先探一次，措辞跟着实际情况走。
   */
  const hasBackup = await hasBackupFile(adapter, path);
  const bakHint = hasBackup
    ? "可以试试同目录下的 .bak 备份。"
    : "同目录下也没有找到 .bak 备份。";
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (_) {
    throw new CorruptError(`这个 .inkbook 的内容读不完整（不是完整的 JSON）。${bakHint}`);
  }
  const book = parseBook(raw, fallbackTitle);

  // 完整性核对：写盘时记下的页数/笔迹数，读回来必须对得上
  const integrity = raw?.integrity;
  if (integrity && typeof integrity === "object") {
    const expectPages = Number(integrity.pageCount);
    const expectStrokes = Number(integrity.strokeCount);
    if (Number.isFinite(expectPages) && Number.isFinite(expectStrokes)) {
      const actual = bookStats(book);
      if (expectPages !== actual.pageCount || expectStrokes !== actual.strokeCount) {
        throw new CorruptError(
          `文件可能不完整：记录 ${expectPages} 页 / ${expectStrokes} 条笔迹，` +
            `实际读到 ${actual.pageCount} 页 / ${actual.strokeCount} 条。` +
            bakHint
        );
      }
    }
  }
  return book;
}

/** 同目录下有没有 `.bak`（探不到就当作没有，提示里不误导用户） */
async function hasBackupFile(adapter: ReadAdapter, path: string): Promise<boolean> {
  const exists = adapter?.exists;
  if (typeof exists !== "function") return false;
  try {
    return !!(await exists.call(adapter, path + BACKUP_SUFFIX));
  } catch (_) {
    return false;
  }
}

/** 尽力删掉临时文件，删不掉也不吭声 */
async function removeQuietly(adapter: WriteAdapter, path: string): Promise<void> {
  if (typeof adapter.remove !== "function") return;
  try {
    if (typeof adapter.exists === "function" && !(await adapter.exists(path))) return;
    await adapter.remove(path);
  } catch (_) {
    /* 清理失败无所谓：临时文件带着 .tmp 后缀，不影响正文 */
  }
}

/**
 * `.bak` 是否还够新（距上次备份不足 BACKUP_MIN_INTERVAL_MS）。
 *
 * 拿不到 mtime（适配器没有 stat / stat 报错 / 文件不存在）一律当作"不新"，
 * 也就是**照旧备份**——这里宁可多写一次，不要因为查不到时间就少一层保险。
 */
async function backupIsFresh(adapter: WriteAdapter, bakPath: string): Promise<boolean> {
  const stat = adapter.stat;
  if (typeof stat !== "function") return false;
  try {
    const st = await stat.call(adapter, bakPath);
    if (!st) return false;
    const rawMtime: number | Date = st.mtime;
    const mtime =
      typeof rawMtime === "number"
        ? rawMtime
        : rawMtime instanceof Date
        ? rawMtime.getTime()
        : Number(rawMtime) || 0;
    if (!mtime) return false;
    return Date.now() - mtime < BACKUP_MIN_INTERVAL_MS;
  } catch (_) {
    return false;
  }
}

/**
 * 写一本书。
 *
 * 三层保护，任何一层失效都不会让正文变成半截文件：
 *   1. 备份：旧内容先抄到 `.bak`（复制失败就跳过，绝不能因此不写正文）
 *   2. 原子：先写 `.tmp`，再 rename 顶掉正文；不支持 rename 则直接写
 *   3. 自检：落盘前把页数/笔迹数记进 `integrity`，下次打开能核对
 */
export async function writeBook(
  adapter: WriteAdapter,
  path: string,
  book: InkBook,
  opts: { backup?: boolean } = {}
): Promise<void> {
  book.updated = Date.now();
  book.integrity = bookStats(book);
  const json = JSON.stringify(book);

  // 1. 备份旧文件（纯尽力而为，失败绝不影响正文）
  if (opts.backup !== false) {
    try {
      const exists = typeof adapter.exists === "function" ? await adapter.exists(path) : false;
      if (exists && typeof adapter.read === "function") {
        // 刚备份过就跳过：大书上每笔都复制全书太贵，正文本身有原子写保护
        if (!(await backupIsFresh(adapter, path + BACKUP_SUFFIX))) {
          const old = await adapter.read(path);
          if (typeof old === "string" && old) await adapter.write(path + BACKUP_SUFFIX, old);
        }
      }
    } catch (e) {
      console.warn("[inkbook] 备份旧文件失败，继续写正文", e);
    }
  }

  /*
   * 2. 原子写：写临时文件 → 改名覆盖。
   *
   * 两段失败要分开处理（INK-170）：
   *   · `.tmp` **没写成功** → 手上没有完整副本，只能退回直接写正文；
   *   · `.tmp` 写成了、只是 rename 失败 → 完整的 JSON 还在盘上，
   *     重试一次 rename；再失败也**不要**先删 tmp 再去直接覆盖正文，
   *     那样一旦直写半途失败，唯一完整的那份也被自己删了。
   */
  let atomicDone = false;
  let tmpComplete = false;
  if (typeof adapter.rename === "function") {
    const tmp = path + TMP_SUFFIX;
    try {
      await adapter.write(tmp, json);
      tmpComplete = true;
    } catch (e) {
      console.warn("[inkbook] 写临时文件失败，改回直接写入", e);
      await removeQuietly(adapter, tmp);
    }
    if (tmpComplete) {
      try {
        await adapter.rename(tmp, path);
        atomicDone = true;
      } catch (e) {
        console.warn("[inkbook] 临时文件改名失败，重试一次", e);
        try {
          await adapter.rename(tmp, path);
          atomicDone = true;
        } catch (e2) {
          console.warn("[inkbook] 改名仍失败，保留临时文件并直接写正文", e2);
        }
      }
    }
  }
  // 3. 退路：直接写正文（tmp 完整时留着它，万一这次直写也失败还能人工救回）
  if (!atomicDone) await adapter.write(path, json);
}

/**
 * 从 `.bak` 备份恢复一本书。
 *
 * 返回 null 表示救不回来（没有备份 / 备份也读不出来），**不抛异常**——
 * 调用方拿到 null 时去走"打不开"的提示即可。
 *
 * 备份里是**旧一代**的文件，所以版本过新的备份一律不算救援成功：
 * 拿它顶上会把"请升级墨本"这个唯一正确的提示盖掉。
 */
export async function recoverFromBackup(
  adapter: ReadAdapter,
  path: string,
  fallbackTitle: string
): Promise<InkBook | null> {
  const bak = path + BACKUP_SUFFIX;
  try {
    if (typeof adapter.exists === "function" && !(await adapter.exists(bak))) return null;
    const text = await adapter.read(bak);
    if (typeof text !== "string" || !text) return null;
    const raw = JSON.parse(text);
    // 备份里可能没有 integrity（老版本写的），也可能对不上——
    // 但既然正文都救不回来了，备份就是最好的东西，先还给用户。
    return parseBook(raw, fallbackTitle);
  } catch (e) {
    if (e instanceof TooNewError) {
      console.warn("[inkbook] 备份文件的版本也过新，不作为恢复来源", e);
      return null;
    }
    console.warn("[inkbook] 从备份恢复失败", e);
    return null;
  }
}
