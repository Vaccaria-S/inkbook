/**
 * P1 · 数据安全改动的对抗性验证。
 *
 * 目标不是"确认能跑"，而是**证伪**：能在什么条件下把用户数据写坏 / 写丢 / 让用户误解。
 *
 * 关键手段：
 *   · adapter 记账：每一次 write / rename / remove 都记下路径和字节数
 *   · adapter 提供 stat（mtime + size），否则 view 的冲突检测整条链路是关的
 *   · 外部改动 = 直接改 files 表 + 把 mtime 往前推（模拟 Obsidian Sync）
 */
import InkbookPlugin from "../src/main";
import { InkbookView } from "../src/view";
import { normalizeBook } from "../src/storage";
import { createBook, createPage, DEFAULT_SETTINGS, type InkBook, type Stroke } from "../src/types";
import {
  isIndexPageFileName,
  isLegacyIndexPageName,
  removeTextIndex,
  writeTextIndex,
} from "../src/indexer";

const lines: string[] = [];
const out = document.getElementById("out")!;
function log(s: string) {
  lines.push(s);
  out.textContent = lines.join("\n");
}
const tally = { pass: 0, fail: 0, known: 0 };
function pass(ok: boolean, msg: string) {
  if (ok) tally.pass++;
  else tally.fail++;
  log((ok ? "PASS " : "FAIL ") + msg);
}
/** 已知问题：照实打印，但不计入 FAIL（已与 team-lead 确认留到 P2） */
function known(msg: string) {
  tally.known++;
  log("KNOWN " + msg);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 抓 Notice 文案：stub 的 Notice 只 console.log('[Notice] ...') */
const notices: string[] = [];
const origLog = console.log.bind(console);
console.log = (...a: any[]) => {
  const s = a.map((x) => (typeof x === "string" ? x : String(x))).join(" ");
  if (s.startsWith("[Notice]")) notices.push(s.slice(8).trim());
  origLog(...a);
};

window.addEventListener("error", (e) => log("ERROR " + e.message + " @" + e.filename + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e: any) =>
  log("REJECT " + (e?.reason?.stack || e?.reason))
);

/* ------------------------------ 假 vault ------------------------------ */

const enc = new TextEncoder();
const blen = (s: any) => (typeof s === "string" ? enc.encode(s).length : 0);

interface Call {
  kind: "write" | "rename" | "remove";
  path: string;
  newPath?: string;
  bytes: number;
  /** 相对开跑的时间戳，用来量化单次保存的真实耗时 */
  t: number;
}
const T0 = performance.now();
const calls: Call[] = [];
const files = new Map<string, any>();
const mt = new Map<string, number>();
/**
 * mtime 必须用**真实时钟**，不能用固定基准值。
 *
 * `.bak` 限频（storage.ts 的 BACKUP_MIN_INTERVAL_MS）是拿 `Date.now() - mtime`
 * 判断"备份还新不新"。如果这里用 2023 年的假时间戳，任何真实实现都会
 * 永远判成"过期"——断言会假绿，限频等于没测。
 * bumpMt 保证单调递增（指纹比对要求每次写有不同 mtime）。
 */
let lastMt = Date.now();
function bumpMt(): number {
  lastMt = Math.max(Date.now(), lastMt + 1);
  return lastMt;
}

/** 造文件（不计入写盘记账） */
function seed(path: string, text: any) {
  files.set(path, text);
  mt.set(path, bumpMt());
}
/** 外部改动（模拟同步/另一台设备）：内容换掉 + mtime 前进 */
function externalEdit(path: string, text: any) {
  files.set(path, text);
  mt.set(path, bumpMt());
}

/**
 * 写盘故障注入：返回真则该路径的 write 抛错（模拟磁盘满 / 无权限）。
 *
 * 用来验证「保存失败还要切本子」这条路会不会把内存里的内容丢掉（INK-169）。
 * 按路径注入而不是一刀切：主文件写失败、抢救副本仍要能写成功，
 * 否则测不出「内容被救下来了」这件事。
 */
let writeFailFor: ((p: string) => boolean) | null = null;
/** rename 故障注入：返回真则这次改名失败（模拟 Windows 上文件被占用） */
let renameFailFor: ((o: string, n: string) => boolean) | null = null;
/** 写盘人为延迟（毫秒），用来制造「保存还在飞」的窗口（INK-167） */
let writeDelayMs = 0;
/**
 * 取指纹的人为延迟（毫秒）。
 *
 * saveNow 是「先 await 指纹、再读 store.data」的顺序，切本子恰好落在这段
 * await 里就会串写。要稳定复现这个窗口，只能把指纹这一步拖慢。
 */
let statDelayMs = 0;

const adapter = {
  stat: async (p: string) => {
    if (statDelayMs > 0) await sleep(statDelayMs);
    return files.has(p) ? { mtime: mt.get(p)!, size: blen(files.get(p)) } : null;
  },
  exists: async (p: string) => files.has(p),
  read: async (p: string) => {
    if (!files.has(p)) throw new Error("ENOENT " + p);
    return files.get(p);
  },
  write: async (p: string, d: any) => {
    if (writeDelayMs > 0) await sleep(writeDelayMs);
    if (writeFailFor && writeFailFor(p)) throw new Error("ENOSPC: no space left on device");
    files.set(p, d);
    mt.set(p, bumpMt());
    calls.push({ kind: "write", path: p, bytes: blen(d), t: performance.now() - T0 });
  },
  rename: async (o: string, n: string) => {
    if (!files.has(o)) throw new Error("ENOENT " + o);
    // 原子写的落点同样受故障注入影响，否则「磁盘满」会被 rename 悄悄绕过
    if (writeFailFor && writeFailFor(n)) throw new Error("ENOSPC: no space left on device");
    if (renameFailFor && renameFailFor(o, n)) throw new Error("EBUSY: resource busy or locked");
    files.set(n, files.get(o));
    files.delete(o);
    mt.delete(o);
    mt.set(n, bumpMt());
    calls.push({ kind: "rename", path: o, newPath: n, bytes: 0, t: performance.now() - T0 });
  },
  remove: async (p: string) => {
    files.delete(p);
    mt.delete(p);
    calls.push({ kind: "remove", path: p, bytes: 0, t: performance.now() - T0 });
  },
};

const vault = {
  adapter,
  createFolder: async (p: string) => ({ path: p }),
  create: async (p: string, text: string) => {
    seed(p, text);
    return tf(p);
  },
  getAbstractFileByPath: () => null,
  getFiles: () => [],
};
const app: any = {
  vault,
  workspace: {
    getActiveFile: () => null,
    getActiveViewOfType: () => null,
    getLeaf: () => ({ openFile: async () => {} }),
    on: () => ({}),
    onLayoutReady: (cb: () => void) => setTimeout(cb, 0),
  },
};
const leaf: any = { app, getViewState: () => ({ state: {} }), getEphemeralState: () => ({}) };
const plugin: any = {
  settings: { ...DEFAULT_SETTINGS },
  saveSettings: async () => {},
  refreshViews: () => {},
};

/* ------------------------------ 记账工具 ------------------------------ */

const since = (n: number) => calls.slice(n);
/** 正文写：直接 write 到主路径，或 rename 顶到主路径 */
function bodyWrites(from: number, path: string): number {
  return since(from).filter(
    (c) => (c.kind === "write" && c.path === path) || (c.kind === "rename" && c.newPath === path)
  ).length;
}
function writesTo(from: number, path: string): number {
  return since(from).filter((c) => c.kind === "write" && c.path === path).length;
}
function bytesTo(from: number, path: string): number {
  return since(from)
    .filter((c) => c.kind === "write" && c.path === path)
    .reduce((a, c) => a + c.bytes, 0);
}
function totalCalls(from: number): number {
  return calls.length - from;
}
function keys(): string[] {
  return [...files.keys()];
}

/* ------------------------------ 造数工具 ------------------------------ */

function tf(path: string): any {
  const name = path.split("/").pop()!;
  return {
    path,
    name,
    basename: name.replace(/\.[^.]+$/, ""),
    extension: name.split(".").pop()!,
  };
}

function mkStroke(seedN: number, points = 12): Stroke {
  const pts: any[] = [];
  for (let i = 0; i < points; i++) pts.push([100 + (seedN % 97) * 7 + i * 4, 200 + (i % 13) * 9, 0.5]);
  return {
    id: "s_" + seedN + "_" + Math.random().toString(36).slice(2, 8),
    tool: "pen",
    color: "#1A1A1A",
    size: 2.8,
    opacity: 1,
    points: pts,
  };
}

function mkBook(title: string, pageCount: number, strokesPerPage: number, points = 12): InkBook {
  const b = createBook(title, "grid", "white");
  while (b.pages.length < pageCount) b.pages.push(createPage("grid", "white"));
  for (let i = 0; i < pageCount; i++) {
    for (let j = 0; j < strokesPerPage; j++) {
      b.pages[i].layers[0].strokes.push(mkStroke(i * 1000 + j, points));
    }
  }
  return b;
}

function countStrokes(book: any): number {
  let n = 0;
  for (const p of book?.pages || []) for (const l of p?.layers || []) n += (l.strokes || []).length;
  return n;
}

async function openView(): Promise<any> {
  const v: any = new InkbookView(leaf, plugin);
  await v.onOpen();
  return v;
}

/* ------------------------------ 用例 ------------------------------ */

/** A1 + A2：翻 59 页 0 写盘；关闭只写 1 次正文 */
async function A12() {
  const p = "A.inkbook";
  seed(p, JSON.stringify(mkBook("A本", 60, 5)));
  const v = await openView();
  const t0 = calls.length;
  await v.onLoadFile(tf(p));
  await sleep(400);
  pass(!!v.store && v.store.pageCount === 60, "A0 打开 60 页 book，pageCount=" + (v.store?.pageCount ?? "null"));

  for (let i = 1; i < 60; i++) v.editor.goToPage(i, false);
  await sleep(300);
  const w = totalCalls(t0);
  pass(w === 0, "A1 连翻 59 页 → 写盘类调用(write/rename/remove)=" + w + "（期望 0），当前页=" + v.editor.getState().pageIndex);

  const t1 = calls.length;
  await v.onClose();
  const body = bodyWrites(t1, p);
  const bak = writesTo(t1, p + ".bak");
  const tmp = writesTo(t1, p + ".tmp");
  pass(
    body === 1,
    "A2 关闭时正文写=" + body + " 次（期望 1）；.bak=" + bak + " 次；.tmp=" + tmp + " 次；rename=" +
      since(t1).filter((c) => c.kind === "rename").length + " 次；其他调用=" + (totalCalls(t1) - body - bak - tmp)
  );
  v.containerEl.remove();
}

/** A3：打开不动直接关，0 写盘 */
async function A3() {
  const p = "A3.inkbook";
  seed(p, JSON.stringify(mkBook("A3本", 3, 2)));
  const v = await openView();
  const t0 = calls.length;
  await v.onLoadFile(tf(p));
  await sleep(500);
  const mid = totalCalls(t0);
  await v.onClose();
  const body = bodyWrites(t0, p);
  pass(
    body === 0,
    "A3 打开→直接关闭：正文写=" + body + " 次（期望 0）；打开阶段调用=" + mid + "；全程调用=" + totalCalls(t0)
  );
  v.containerEl.remove();
}

/** A4：落一笔 → 850ms → 正好 1 次正文写 */
async function A4() {
  const p = "A4.inkbook";
  seed(p, JSON.stringify(mkBook("A4本", 3, 2)));
  const v = await openView();
  await v.onLoadFile(tf(p));
  await sleep(400);
  const t0 = calls.length;
  v.store.addStroke(mkStroke(1), 0);
  await sleep(1200);
  const body = bodyWrites(t0, p);
  pass(
    body === 1,
    "A4 落一笔等 850ms：正文写=" + body + " 次（期望 1）；.bak=" + writesTo(t0, p + ".bak") +
      "；.tmp=" + writesTo(t0, p + ".tmp") + "；笔迹数=" + v.store.strokeCount
  );
  await v.onClose();
  v.containerEl.remove();
}

/** B5 + B6 + B7：外部改动 → 冲突 → 主文件永不被写 */
async function B() {
  const p = "B.inkbook";
  seed(p, JSON.stringify(mkBook("B本", 2, 1))); // 内存 2 页 / 2 笔
  const v = await openView();
  await v.onLoadFile(tf(p));
  await sleep(400);
  const fpAtOpen = JSON.stringify(v.fp);
  const ext = JSON.stringify(mkBook("B本-外部同步成5页", 5, 3)); // 磁盘 5 页
  externalEdit(p, ext);
  log("B0 打开时指纹=" + fpAtOpen);

  const t0 = calls.length;
  v.store.addStroke(mkStroke(9), 0); // 内存 2 页 / 3 笔
  await sleep(1300);

  pass(files.get(p) === ext, "B5① 主文件与被外部改动后的字节完全一致=" + (files.get(p) === ext) + "；主文件写=" + bodyWrites(t0, p));
  const ks = keys();
  const diskCopy = ks.find((k) => /-disk-p\d+(?:-\d+)?\.inkbook$/.test(k));
  const mineCopy = ks.find((k) => /-mine-p\d+(?:-\d+)?\.inkbook$/.test(k));
  pass(!!diskCopy && /-disk-p5(?:-\d+)?\.inkbook$/.test(diskCopy), "B5② 出现磁盘副本=" + (diskCopy || "无") + "（期望 -disk-p5）");
  pass(!!mineCopy && /-mine-p2(?:-\d+)?\.inkbook$/.test(mineCopy), "B5② 出现内存副本=" + (mineCopy || "无") + "（期望 -mine-p2）");
  pass(
    !!diskCopy && files.get(diskCopy) === ext,
    "B5③ 磁盘副本内容逐字节等于外部版本=" + (!!diskCopy && files.get(diskCopy) === ext) +
      "；页数=" + (() => { try { return JSON.parse(files.get(diskCopy!)).pages.length; } catch (_) { return "?"; } })()
  );

  // B6：冲突后继续落 3 笔
  for (let k = 0; k < 3; k++) {
    v.store.addStroke(mkStroke(20 + k), 0);
    await sleep(1100);
  }
  pass(
    files.get(p) === ext && bodyWrites(t0, p) === 0,
    "B6 冲突后再落 3 笔：主文件一字节未变=" + (files.get(p) === ext) + "；主文件写=" + bodyWrites(t0, p) +
      "；内存笔迹=" + v.store.strokeCount
  );

  // B7：冲突后关闭
  /*
   * 副本文件名带「到分钟」的时间戳，B5 与 B7 一旦跨分钟就会写出两个不同文件。
   * 所以这里不能盯着 B5 那个路径，必须重新扫目录、取所有 -mine- 副本里
   * 笔迹最多的一份——那才代表"关闭前把内存内容落下来了"。
   */
  const t1 = calls.length;
  await v.onClose();
  const mineFiles = keys().filter((k) => /-mine-p\d+(?:-\d+)?\.inkbook$/.test(k));
  let mineStrokes = -1;
  let mineBest = "";
  for (const k of mineFiles) {
    try {
      const n = countStrokes(JSON.parse(files.get(k)));
      if (n > mineStrokes) {
        mineStrokes = n;
        mineBest = k;
      }
    } catch (_) {}
  }
  log(
    "B7 目录清单=" + JSON.stringify(
      keys().filter((k) => k.startsWith("B.")).map((k) => {
        let n = -1;
        try { n = countStrokes(JSON.parse(files.get(k))); } catch (_) {}
        return k.split("/").pop() + "(" + n + "笔)";
      })
    )
  );
  pass(files.get(p) === ext, "B7 冲突后关闭：主文件仍未变=" + (files.get(p) === ext) + "；主文件写=" + bodyWrites(t1, p));
  pass(
    mineStrokes === 6,
    "B7 关闭前另存 -mine- 副本笔迹=" + mineStrokes + "（期望 6 = 2+1+3）；副本数=" + mineFiles.length +
      "；最佳副本=" + (mineBest || "无") + "；关闭阶段写调用=" + totalCalls(t1)
  );
  v.containerEl.remove();
}

/** C8：version 3（未来版本）拒开，且不写盘 */
async function C8() {
  const p = "C8.inkbook";
  const b: any = mkBook("C8本", 3, 2);
  b.version = 3;
  const text = JSON.stringify(b);
  seed(p, text);
  const v = await openView();
  const t0 = calls.length;
  await v.onLoadFile(tf(p));
  await sleep(500);
  const html = (v.editorHost?.textContent || "").replace(/\s+/g, " ");
  pass(v.store == null, "C8① 未进入编辑态：store=" + (v.store == null ? "null" : "非空") + "；readOnly=" + v.readOnly);
  pass(html.includes("升级"), "C8① 页面提示含「升级」=" + html.includes("升级") + "；文案=" + JSON.stringify(html.slice(0, 70)));
  pass(
    files.get(p) === text,
    "C8② 磁盘字节未变=" + (files.get(p) === text) + "；写调用=" + totalCalls(t0) + "（期望 0）"
  );
  v.containerEl.remove();
}

/** 取当前页的 pointer 事件构造器（落笔 / 半笔都从这里走同一条真实路径） */
function pagePointer(v: any, pageIdx = 0): ((type: string, x: number, y: number, buttons: number) => PointerEvent) | null {
  const pageEl = v.contentEl.querySelectorAll(".mb-page")[pageIdx] as HTMLElement;
  if (!pageEl) return null;
  const r = pageEl.getBoundingClientRect();
  const k = r.width / 794 || 1;
  return (type, x, y, buttons) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 31,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons,
      clientX: r.left + x * k,
      clientTop: 0,
      clientY: r.top + y * k,
      pressure: type === "pointerup" ? 0 : 0.55,
    } as any);
}

/** 在纸面上真实落一笔（走 pointer 事件，和用户手写同一条路径） */
function drawOnPage(v: any, pageIdx = 0): boolean {
  const pe = pagePointer(v, pageIdx);
  const pageEl = v.contentEl.querySelectorAll(".mb-page")[pageIdx] as HTMLElement;
  if (!pe || !pageEl) return false;
  pageEl.dispatchEvent(pe("pointerdown", 100, 200, 1));
  for (let i = 1; i <= 12; i++) pageEl.dispatchEvent(pe("pointermove", 100 + i * 12, 200 + i * 3, 1));
  pageEl.dispatchEvent(pe("pointerup", 244, 236, 0));
  return true;
}

/**
 * 只按下、不抬起：模拟「手还按在纸上」的那一笔。
 *
 * INK-168 的场景就是用户笔尖还没离纸就关了标签页——
 * 这一笔只在 editor 的 draft 里，从没进过 book。
 */
function pressOnPage(v: any, pageIdx = 0): boolean {
  const pe = pagePointer(v, pageIdx);
  const pageEl = v.contentEl.querySelectorAll(".mb-page")[pageIdx] as HTMLElement;
  if (!pe || !pageEl) return false;
  pageEl.dispatchEvent(pe("pointerdown", 120, 220, 1));
  for (let i = 1; i <= 8; i++) pageEl.dispatchEvent(pe("pointermove", 120 + i * 10, 220 + i * 4, 1));
  return true;
}

/** C9：version 3 + 合法 .bak → 不许被备份接住，必须如实报「请升级」 */
async function C9() {
  const p = "C9.inkbook";
  const b2: any = mkBook("C9本", 2, 1);
  b2.version = 3;
  const text = JSON.stringify(b2);
  seed(p, text);
  seed(p + ".bak", JSON.stringify(mkBook("C9本-旧备份", 4, 2))); // version 1 的合法备份
  const v = await openView();
  const t0 = calls.length;
  const nCase = notices.length;
  await v.onLoadFile(tf(p));
  await sleep(700);
  const html = (v.editorHost?.textContent || "").replace(/\s+/g, " ");
  const notice = notices.slice(nCase).join(" | ");
  pass(
    v.store == null && v.readOnly === true,
    "C9① 未被备份接管：store=" + (v.store == null ? "null" : "非空") + "；readOnly=" + v.readOnly +
      "；Notice=" + JSON.stringify(notice)
  );
  pass(
    html.includes("升级") && !html.includes("从备份恢复") && !notice.includes("从备份恢复"),
    "C9① 「请升级墨本」未被掩盖：DOM含升级=" + html.includes("升级") +
      "；DOM含从备份恢复=" + html.includes("从备份恢复") + "；Notice含从备份恢复=" +
      notice.includes("从备份恢复") + "；文案=" + JSON.stringify(html.slice(0, 60))
  );
  pass(
    files.get(p) === text && totalCalls(t0) === 0,
    "C9② 磁盘字节未变=" + (files.get(p) === text) + "；写盘=" + totalCalls(t0) + " 次（期望 0）"
  );
  v.containerEl.remove();
}

/** C9b：正文损坏 + 合法 .bak → 只读恢复；走真实 UI 路径试着解锁书写 */
async function C9b() {
  const p = "C9b.inkbook";
  const bad = "这不是 JSON，正文坏了";
  seed(p, bad);
  seed(p + ".bak", JSON.stringify(mkBook("C9b-备份", 4, 2)));
  const v = await openView();
  const t0 = calls.length;
  const nCase = notices.length; // 只认本用例产生的 Notice，别抓上一条用例的尾巴
  await v.onLoadFile(tf(p));
  await sleep(700);
  const caseNotices = () => notices.slice(nCase);
  const nb = caseNotices().find((n) => n.includes("已从备份恢复")) || "";
  pass(
    v.store != null && v.readOnly === true && v.store.pageCount === 4,
    "C9b① 只读恢复：store=" + (v.store != null) + "；readOnly=" + v.readOnly + "；页数=" + (v.store?.pageCount ?? "-")
  );
  pass(nb.length > 0, "C9b① 恢复提示=" + JSON.stringify(nb));

  // 真实用户路径：点长条「仅阅读」按钮两次（进→出），再真的落笔
  const btn = v.containerEl.querySelector(".mb-rail-read") as HTMLElement;
  const before = v.store.strokeCount;
  btn?.click();
  await sleep(150);
  btn?.click();
  await sleep(150);
  const editorLocked = (v.editor as any)?.readOnly;
  log(
    "C9b 诊断：onclick=" + typeof (btn as any)?.onclick + "；reading=" + v.reading +
      "；viewReadOnly=" + v.readOnly + "；editor.readOnly=" + editorLocked +
      "；本用例 Notice=" + JSON.stringify(caseNotices())
  );
  const drew = drawOnPage(v);
  await sleep(350);
  const after = v.store.strokeCount;
  pass(
    after === before && editorLocked === true,
    "C9b② 退出仅阅读后仍不可写：按钮=" + !!btn + "；落笔=" + drew + "；笔迹 " + before + "→" + after +
      "；editor.readOnly=" + editorLocked
  );
  // 关键词用「不会保存」：它对文案改词不敏感，但只在真的存在警告时成立
  const warn = caseNotices().find((n) => n.includes("不会保存")) || "";
  pass(warn.length > 0, "C9b② 有「改动不会保存」警告=" + (warn.length > 0) + "；文案=" + JSON.stringify(warn.slice(0, 50)));
  /*
   * 新行为：恢复后会另存一份 .recovered- 副本供用户接着写。
   * 所以"写盘=0"不再是正确期望——真正的不变量是**主文件与其 .bak 零写**，
   * 副本本身该写就写，还要写得对（4 页）。
   */
  const rec = keys().filter((k) => k.startsWith("C9b.recovered-") && /\.recovered-\d{8}-\d{4}\.inkbook$/.test(k));
  let recPages = -1;
  try {
    recPages = JSON.parse(files.get(rec[0])).pages.length;
  } catch (_) {}
  pass(
    bodyWrites(t0, p) === 0 && writesTo(t0, p + ".bak") === 0 && files.get(p) === bad,
    "C9b③ 主文件零写：正文=" + bodyWrites(t0, p) + " 次；.bak=" + writesTo(t0, p + ".bak") +
      " 次；字节未变=" + (files.get(p) === bad) + "；总写调用=" + totalCalls(t0) + "（含 recovered 副本）"
  );
  pass(
    rec.length >= 1 && recPages === 4,
    "C9b③ 另存 recovered 副本=" + (rec[0] || "无") + "；页数=" + recPages + "（期望 4）"
  );
  v.containerEl.remove();
}

/** C10：截断成前 60% 字节 */
async function C10() {
  const p = "C10.inkbook";
  const full = JSON.stringify(mkBook("C10本", 6, 4));
  const cut = full.slice(0, Math.floor(full.length * 0.6));
  seed(p, cut);
  const v = await openView();
  const t0 = calls.length;
  let threw = "";
  try {
    await v.onLoadFile(tf(p));
  } catch (e: any) {
    threw = String(e?.message || e);
  }
  await sleep(500);
  const html = (v.editorHost?.textContent || "").replace(/\s+/g, " ");
  pass(threw === "", "C10① 打开未抛异常 threw=" + JSON.stringify(threw));
  pass(html.includes("打不开"), "C10① 显示「打不开」=" + html.includes("打不开") + "；文案=" + JSON.stringify(html.slice(0, 80)));
  pass(files.get(p) === cut, "C10② 主文件字节未被改写=" + (files.get(p) === cut) + "；写调用=" + totalCalls(t0));
  v.containerEl.remove();
}

/* ============================================================================
 * INK-179 / INK-180：设置数值校验 + 存档防 NaN
 *
 * 复现路径：data.json 被同步工具/手工编辑写进 null、"abc" 或越界值 →
 * loadSettings 的 Object.assign 原样盖掉默认值 → shapePressure(0.5, NaN)
 * 返回 NaN → pressureFor 把 NaN 写进 stroke.points → normalizePoints 只查
 * `typeof === "number"`（NaN 也是 number）直接放行 → 存档永久污染。
 * 下面四条分别守住这四层，任何一层单独被改回去都会红。
 * ========================================================================== */

/** 造一个只带 loadData/saveData 的宿主，专测 loadSettings / 外部变更 */
function makeSettingsHost(data: any): any {
  const pluginApp: any = {
    vault: {
      adapter: { exists: async () => false, read: async () => "", write: async () => {} },
      getFiles: () => [],
      getAbstractFileByPath: () => null,
      on: () => ({}),
    },
    workspace: {
      on: () => ({}),
      getLeavesOfType: () => [],
      getActiveFile: () => null,
      getActiveViewOfType: () => null,
      getLeaf: () => ({ openFile: async () => {} }),
      onLayoutReady: () => {},
    },
  };
  const p: any = new InkbookPlugin(pluginApp, { id: "inkbook", name: "墨本", version: "0", dir: "" });
  // 直接给宿主塞 data，再走真实 loadData（stub 的 Plugin.loadData 读 __data）
  p.__data = data;
  return p;
}

/** T1：脏 data.json 的数值字段必须回落/夹取，未知字段保留 */
async function T1() {
  const p = makeSettingsHost({
    pressure: null,
    smoothing: "abc",
    defaultPenSize: NaN,
    defaultHighlighterSize: 9999,
    futureSetting: "keep-me",
  });
  await p.loadSettings();
  pass(
    p.settings.pressure === DEFAULT_SETTINGS.pressure,
    "T1 pressure=null 回落默认 " + DEFAULT_SETTINGS.pressure + "（实际 " + p.settings.pressure + "）"
  );
  pass(
    p.settings.smoothing === DEFAULT_SETTINGS.smoothing,
    "T1 smoothing=\"abc\" 回落默认 " + DEFAULT_SETTINGS.smoothing + "（实际 " + p.settings.smoothing + "）"
  );
  pass(
    p.settings.defaultPenSize === DEFAULT_SETTINGS.defaultPenSize,
    "T1 defaultPenSize=NaN 回落默认（实际 " + p.settings.defaultPenSize + "）"
  );
  pass(
    p.settings.defaultHighlighterSize === 40,
    "T1 越界 9999 夹到上界 40（实际 " + p.settings.defaultHighlighterSize + "）"
  );
  pass(
    (p.settings as any).futureSetting === "keep-me",
    "T1 未知字段保留（不激进删除，留给未来版本/别的插件）"
  );

  const p2 = makeSettingsHost({ pressure: 0.01, smoothing: -3, defaultPenSize: 0 });
  await p2.loadSettings();
  pass(
    p2.settings.pressure === 0.3 &&
      p2.settings.smoothing === 0 &&
      p2.settings.defaultPenSize === DEFAULT_SETTINGS.defaultPenSize,
    "T1 越下界夹到边界；粗细=0 按非法回落默认（" +
      [p2.settings.pressure, p2.settings.smoothing, p2.settings.defaultPenSize].join("/") +
      "）"
  );
}

/** T2：onExternalSettingsChange 要重读盘并刷新已打开的视图 */
async function T2() {
  const p = makeSettingsHost({ pressure: 1 });
  await p.loadSettings();
  let synced = 0;
  let cancelled = 0;
  p.app.workspace.getLeavesOfType = () => [
    {
      view: {
        syncSettings: () => synced++,
        cancelPendingSaves: () => cancelled++,
      },
    },
  ] as any;
  // 模拟另一台设备 / 另一个窗口改了 data.json
  p.__data = { pressure: 0.6, smoothing: 0.9, lastPenColor: "#2E8B57" };
  await p.onExternalSettingsChange();
  pass(
    p.settings.pressure === 0.6 && p.settings.lastPenColor === "#2E8B57",
    "T2 外部变更被读进内存（pressure=" + p.settings.pressure + "，色=" + p.settings.lastPenColor + "）"
  );
  pass(synced === 1, "T2 refreshViews 调了已打开视图的 syncSettings（" + synced + " 次）");

  // 关掉自动保存再刷新：pendings 要被收回
  p.__data = { autosave: false };
  await p.onExternalSettingsChange();
  pass(
    cancelled === 1,
    "T2 关自动保存时取消已排队的落盘（cancelPendingSaves " + cancelled + " 次）"
  );
}

/** T3：normalizePoints 是最后一道防线，NaN / Infinity 的点不许进存档 */
async function T3() {
  const raw: any = {
    version: 2,
    kind: "inkbook",
    title: "NaN本",
    pages: [
      {
        id: "p",
        template: "grid",
        paper: "white",
        layers: [
          {
            id: "l",
            name: "笔迹层",
            visible: true,
            opacity: 1,
            activeLayerId: "l",
            strokes: [
              {
                id: "s",
                tool: "pen",
                color: "#1A1A1A",
                size: 2.8,
                opacity: 1,
                points: [
                  [10, 20, 0.5],
                  [30, 40, NaN], // 压力 NaN：typeof 是 number，旧实现放行
                  [Infinity, 50, 0.7], // 坐标 Infinity
                  [60, 70, 0.8],
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const book = normalizeBook(raw, "fallback");
  const pts = book.pages[0].layers[0].strokes[0].points;
  pass(
    pts.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]) && Number.isFinite(q[2])),
    "T3 normalizeBook 后所有点坐标/压力都是有限数（" + JSON.stringify(pts) + "）"
  );
  pass(
    pts.length === 3 && pts[1][2] === 0.5,
    "T3 压力 NaN 补中性 0.5、坐标 Infinity 丢点（剩 " + pts.length + " 点）"
  );
}

/** T4：syncSettings 对运行时注入的脏值兜底 + 关自动保存后 pending 不落盘 */
async function T4() {
  const p = "T4.inkbook";
  seed(p, JSON.stringify(mkBook("T4本", 1, 0)));
  const v: any = await openView();
  await v.onLoadFile(tf(p));
  await sleep(300);
  plugin.settings.pressure = NaN;
  plugin.settings.smoothing = -5;
  plugin.settings.defaultPenSize = 0;
  plugin.settings.defaultHighlighterSize = NaN;
  v.syncSettings();
  const opts = (v.editor as any).opts;
  pass(
    Number.isFinite(opts.pressure) && opts.pressure === 1 && opts.smoothing === 0,
    "T4 syncSettings 把 NaN/负平滑夹回合法区间（pressure=" + opts.pressure + " smoothing=" + opts.smoothing + "）"
  );
  pass(
    v.editor.penSize === 2.8 && v.editor.highlighterSize === 24,
    "T4 syncSettings 的粗细兜底与 mountEditor 一致（" +
      v.editor.penSize + "/" + v.editor.highlighterSize + "）"
  );

  // 关自动保存：已排队的定时器到点也不许写盘
  plugin.settings.autosave = false;
  const t0 = calls.length;
  v.markDirty();
  // 模拟「已经排上但用户在这之后才关掉自动保存」的定时器：手动排一次
  v.saveDebounce();
  v.cancelPendingSaves();
  // 不取消也会落盘的那两条路径（10s 兜底、抬笔补排）同样不许再排
  v.armInkDeferRetry(0);
  v.onInkGestureEnd();
  await sleep(1100);
  pass(
    totalCalls(t0) === 0,
    "T4 关自动保存后 pending/兜底/抬笔补排都不落盘（写调用=" + totalCalls(t0) + "）"
  );
  pass(v.dirty === true, "T4 取消定时器不吞 dirty，显式保存仍能写下去");
  plugin.settings.autosave = true;
  v.containerEl.remove();
}

/** C11：integrity.pageCount 写错 +3 */
async function C11() {
  const p = "C11.inkbook";
  const b: any = mkBook("C11本", 4, 3);
  b.integrity = { pageCount: 7, strokeCount: 12 }; // 故意 +3
  const text = JSON.stringify(b);
  seed(p, text);
  const v = await openView();
  const t0 = calls.length;
  await v.onLoadFile(tf(p));
  await sleep(500);
  const html = (v.editorHost?.textContent || "").replace(/\s+/g, " ");
  pass(html.includes("文件可能不完整"), "C11① 提示含「文件可能不完整」=" + html.includes("文件可能不完整") + "；文案=" + JSON.stringify(html.slice(0, 90)));
  pass(!html.includes("损坏"), "C11① 用词不含「损坏」=" + !html.includes("损坏"));
  pass(files.get(p) === text, "C11② 不写盘=" + (files.get(p) === text) + "；写调用=" + totalCalls(t0));
  v.containerEl.remove();
}

/** D12：字段保真 */
async function D12() {
  const p = "D12.inkbook";
  const b: any = mkBook("D12本", 2, 2);
  b.pages[0].background = {
    src: "附件/底图.png",
    sourceName: "讲义",
    sourcePage: 3,
    x: 10,
    y: 20,
    width: 700,
    height: 900,
    kind: "pdf",
  };
  b.pages[0].texts = [
    { id: "t1", source: "pdf", x: 100, y: 200, size: 12, text: "原文一行", width: 80 },
    {
      id: "t2",
      source: "user",
      x: 150,
      y: 260,
      size: 20,
      color: "#D64545",
      font: "kai",
      text: "我加的字",
      width: 260,
    },
    // 脏宽度：渲染层一律当「没写」，落盘也不该带回来
    { id: "t3", source: "user", x: 150, y: 320, size: 20, text: "脏宽度", width: 0 },
  ];
  // 空数组表示"抽过但没文字"（扫描版），必须原样保留，否则每次挂载都重抽
  b.pages[1].texts = [];
  b.futureField = 1;
  b.pages[0].futurePageField = "x";
  seed(p, JSON.stringify(b));
  const v = await openView();
  await v.onLoadFile(tf(p));
  await sleep(400);
  v.store.addStroke(mkStroke(3), 0);
  await sleep(1300);
  let saved: any = null;
  try {
    saved = JSON.parse(files.get(p));
  } catch (e: any) {
    log("D12 保存结果解析失败 " + e);
  }
  pass(
    !!saved?.integrity && saved.integrity.pageCount === 2 && saved.integrity.strokeCount === 5,
    "D12① integrity 仍在=" + JSON.stringify(saved?.integrity) + "（期望 2 页 / 5 条）"
  );
  pass(
    !!saved?.pages?.[0]?.background && saved.pages[0].background.src === "附件/底图.png",
    "D12① background 仍在=" + JSON.stringify(saved?.pages?.[0]?.background?.src)
  );
  pass(typeof saved?.version === "number" && saved.version === 2, "D12 version 是 number 且=2（v2 起有 texts）：" + JSON.stringify(saved?.version));
  pass(
    saved?.pages?.[0]?.texts?.length === 3,
    "D12 文字层往返：3 条（" + JSON.stringify(saved?.pages?.[0]?.texts?.length) + "）"
  );
  pass(
    saved?.pages?.[0]?.texts?.[0]?.width === 80,
    "D12 pdf 原文 width 往返保住（" + JSON.stringify(saved?.pages?.[0]?.texts?.[0]?.width) + "）"
  );
  pass(
    saved?.pages?.[0]?.texts?.[1]?.width === 260,
    "D12 user 手动宽度 width 往返保住（" + JSON.stringify(saved?.pages?.[0]?.texts?.[1]?.width) + "）"
  );
  pass(
    saved?.pages?.[0]?.texts?.[2]?.width === undefined,
    "D12 脏宽度（0）被 normalizeBook 丢弃，不写回文件"
  );
  pass(
    saved?.pages?.[0]?.texts?.[0]?.source === "pdf" &&
      saved?.pages?.[0]?.texts?.[0]?.text === "原文一行" &&
      saved?.pages?.[0]?.texts?.[1]?.color === "#D64545",
    "D12 文字内容/来源/颜色都保住了"
  );
  pass(
    saved?.pages?.[0]?.texts?.[1]?.font === "kai",
    "D12 文字字体也保住了（" + JSON.stringify(saved?.pages?.[0]?.texts?.[1]?.font) + "）"
  );
  pass(
    Array.isArray(saved?.pages?.[1]?.texts) && saved.pages[1].texts.length === 0,
    "D12 空文字数组被保留（代表已抽过，不用重抽）"
  );
  known(
    "D12②[P1 不做，留 P2 透传 __unknown] 未知书籍字段 futureField 保留=" +
      JSON.stringify(saved?.futureField) + "（现状：被 normalizeBook 白名单丢弃，已知问题）"
  );
  known(
    "D12②[P1 不做，留 P2 透传 __unknown] 未知页字段 futurePageField 保留=" +
      JSON.stringify(saved?.pages?.[0]?.futurePageField) + "（现状：被丢弃，已知问题）"
  );
  await v.onClose();
  v.containerEl.remove();
}

/** E13：A→B→A 后直接关闭；以及只读本残留 dirty */
async function E13() {
  const pa = "E13-A.inkbook";
  const pb = "E13-B.inkbook";
  seed(pa, JSON.stringify(mkBook("E13A", 3, 2)));
  seed(pb, JSON.stringify(mkBook("E13B", 4, 2)));
  const v = await openView();
  await v.onLoadFile(tf(pa));
  await sleep(400);
  await v.onUnloadFile();
  await v.onLoadFile(tf(pb));
  await sleep(400);
  await v.onUnloadFile();
  const t0 = calls.length;
  await v.onLoadFile(tf(pa));
  await sleep(500);
  const mid = totalCalls(t0);
  await v.onClose();
  pass(
    bodyWrites(t0, pa) === 0,
    "E13 A→B→A 后什么都不做直接关闭：正文写=" + bodyWrites(t0, pa) + " 次（期望 0）；打开阶段调用=" + mid + "；关闭阶段调用=" + (totalCalls(t0) - mid)
  );
  v.containerEl.remove();

  /* 变体：只读（备份恢复）本上落笔 → dirty 残留 → 打开另一本直接关闭 */
  const rp = "E13-R.inkbook";
  const bp = "E13-B2.inkbook";
  seed(rp, "这不是 JSON，正文坏了");
  seed(rp + ".bak", JSON.stringify(mkBook("E13R-备份", 2, 1)));
  seed(bp, JSON.stringify(mkBook("E13B2", 5, 2)));
  const v2 = await openView();
  await v2.onLoadFile(tf(rp));
  await sleep(500);
  const ro = v2.readOnly;
  v2.editor?.setReadOnly(false);
  v2.store?.addStroke(mkStroke(5), 0); // dirty = true，但 saveNow 因 readOnly 直接返回
  await sleep(1000);
  await v2.onUnloadFile();
  await v2.onLoadFile(tf(bp));
  await sleep(500);
  const t1 = calls.length;
  await v2.onClose();
  const bw = bodyWrites(t1, bp);
  pass(
    bw === 0,
    "E13b 只读本残留 dirty 未在 openBook 复位：打开 B 本(5页)不动直接关闭 → B 正文写=" + bw +
      " 次（期望 0；readOnly本=" + ro + "，切换前 dirty 残留）"
  );
  v2.containerEl.remove();
}

/** F14：写放大量化（60 页 × 300 笔 ≈ 10MB） */
async function F14() {
  const p = "F14.inkbook";
  const big = mkBook("F14本", 60, 300, 20);
  const text = JSON.stringify(big);
  const mb = (n: number) => (n / 1048576).toFixed(2) + "MB";
  log("F14 书体积=" + mb(blen(text)) + "；笔迹=" + countStrokes(big));
  seed(p, text);
  const v = await openView();
  const tOpen = Date.now();
  await v.onLoadFile(tf(p));
  await sleep(600);
  log("F14 打开耗时=" + (Date.now() - tOpen) + "ms，pageCount=" + (v.store?.pageCount ?? "-"));

  const t0 = calls.length;
  v.store.addStroke(mkStroke(1, 20), 0);
  await sleep(1800);
  const seg = since(t0);
  const bakB = bytesTo(t0, p + ".bak");
  const tmpB = bytesTo(t0, p + ".tmp");
  const bodyB = bytesTo(t0, p);
  const total = bakB + tmpB + bodyB;
  const writeN = seg.filter((c) => c.kind === "write").length;
  const renameN = seg.filter((c) => c.kind === "rename").length;
  // 真实落盘耗时：第一次写调用 → 最后一次调用（不含 850ms 防抖等待）
  const ioMs = seg.length ? Math.round(seg[seg.length - 1].t - seg[0].t) : -1;
  pass(
    total >= blen(text) * 1.8,
    "F14 单笔保存总写字节=" + mb(total) + "（bak " + mb(bakB) + " + tmp " + mb(tmpB) + " + 正文直写 " + mb(bodyB) +
      "）；write 调用=" + writeN + "；rename=" + renameN + "；序列化+落盘耗时≈" + ioMs + "ms"
  );
  await v.onClose();
  v.containerEl.remove();
}

/* ------------------------------ 调度 ------------------------------ */

/**
 * E1：`dropBook()` 把 store 置空之后，别处还引用着它吗？
 *
 * 最容易炸的序列：损坏文件 → 不关视图直接切正常文件 → 关闭。
 * 断言：不抛异常、正常文件没被写坏、切换后还能正常保存。
 */
async function E1() {
  const bad = "E1.inkbook";
  const good = "E1-good.inkbook";
  const badText = "{ 这不是 JSON";
  const goodText = JSON.stringify(mkBook("E1好本", 3, 2));
  seed(bad, badText);
  seed(good, goodText);

  const v = await openView();
  let threw = "";
  try {
    await v.onLoadFile(tf(bad)); // 损坏 → dropBook() + 错误态
    await sleep(500);
    await v.onLoadFile(tf(good)); // 不关视图，直接切到正常文件
    await sleep(600);
    await v.onClose();
  } catch (e: any) {
    threw = String(e?.stack || e);
  }
  pass(threw === "", "E1① 损坏→切正常→关闭 不抛异常：" + (threw === "" ? "ok" : threw.slice(0, 140)));
  pass(files.get(good) === goodText, "E1② 正常文件字节未变=" + (files.get(good) === goodText));
  let pages = -1;
  let strokes = -1;
  try {
    const s = JSON.parse(files.get(good));
    pages = s.pages.length;
    strokes = countStrokes(s);
  } catch (_) {}
  pass(pages === 3 && strokes === 6, "E1② 正常文件结构完好：页=" + pages + " 笔=" + strokes + "（期望 3 / 6）");
  v.containerEl.remove();

  // 切换之后还能不能正常写：落笔必须写回正常文件，绝不能碰到坏文件
  const v2 = await openView();
  let threw2 = "";
  try {
    await v2.onLoadFile(tf(bad));
    await sleep(400);
    await v2.onLoadFile(tf(good));
    await sleep(500);
  } catch (e: any) {
    threw2 = String(e?.stack || e);
  }
  const storeOk = v2.store != null && v2.store.pageCount === 3;
  const t = calls.length;
  if (storeOk) v2.store.addStroke(mkStroke(9), 0);
  await sleep(1300);
  pass(
    threw2 === "" && storeOk && bodyWrites(t, good) === 1 && bodyWrites(t, bad) === 0,
    "E1③ 切换后落笔：store=" + storeOk + "；写正常文件=" + bodyWrites(t, good) +
      " 次；写坏文件=" + bodyWrites(t, bad) + " 次；异常=" + (threw2 === "" ? "无" : threw2.slice(0, 60))
  );
  await v2.onClose();
  v2.containerEl.remove();
}

/**
 * G：`.bak` 限频（storage.ts 的 BACKUP_MIN_INTERVAL_MS，当前 45s）。
 *
 * 3 笔间隔 2s → 正文 3 次、.bak 只 1 次；
 * 把 .bak 的 mtime 回拨 2 分钟 → 下一笔必须重新备份。
 */
async function G() {
  const p = "G.inkbook";
  seed(p, JSON.stringify(mkBook("G本", 2, 2)));
  const v = await openView();
  await v.onLoadFile(tf(p));
  await sleep(400);

  const t0 = calls.length;
  for (let i = 0; i < 3; i++) {
    v.store.addStroke(mkStroke(100 + i), 0);
    await sleep(2000); // 每笔各自触发一次 850ms 防抖保存
  }
  const body = bodyWrites(t0, p);
  const bak = writesTo(t0, p + ".bak");
  const sumB = bytesTo(t0, p + ".tmp") + bytesTo(t0, p + ".bak") + bytesTo(t0, p);
  const one = blen(files.get(p) || "");
  pass(
    body === 3 && bak === 1,
    "G1 连续 3 笔（间隔 2s）：正文写=" + body + " 次（期望 3）；.bak=" + bak + " 次（期望 1）；.tmp=" +
      writesTo(t0, p + ".tmp") + " 次｜3 笔共写 " + (sumB / 1024).toFixed(0) + "KB，均摊 " +
      (sumB / 3 / 1024).toFixed(0) + "KB/笔（单本约 " + (one / 1024).toFixed(0) + "KB）"
  );

  const bakPath = p + ".bak";
  mt.set(bakPath, Date.now() - 120_000); // 把备份"做旧" 2 分钟
  const t1 = calls.length;
  v.store.addStroke(mkStroke(200), 0);
  await sleep(1300);
  pass(
    writesTo(t1, bakPath) === 1 && bodyWrites(t1, p) === 1,
    "G2 .bak 回拨到 2 分钟前后落一笔：.bak 写=" + writesTo(t1, bakPath) + " 次（期望 1）；正文=" +
      bodyWrites(t1, p) + " 次（期望 1）"
  );
  await v.onClose();
  v.containerEl.remove();
}

/**
 * H：只读态下**绕过编辑器**改结构（侧栏加页 / 换模板）会不会被静默吞掉。
 *
 * 编辑器的落笔路径已经被 C9b 锁住了，但侧栏走的是 store.onChange → markDirty，
 * 不经过编辑器的只读闸门。这里逐时刻记录 Notice：打开时 / 改动当下 / 关闭时。
 */
async function H() {
  const p = "H.inkbook";
  seed(p, "坏 JSON，正文读不出来");
  seed(p + ".bak", JSON.stringify(mkBook("H-备份", 3, 2)));
  const v = await openView();
  const t0 = calls.length;
  const n0 = notices.length;
  await v.onLoadFile(tf(p));
  await sleep(700);
  const atOpen = notices.slice(n0);
  const before = v.store.pageCount;

  const n1 = notices.length;
  const addBtn = [...v.contentEl.querySelectorAll(".mb-link")].find((el) =>
    (el.textContent || "").includes("加一页")
  ) as HTMLElement | undefined;
  if (addBtn) addBtn.click();
  else v.store.addPage();
  await sleep(350);
  const atChange = notices.slice(n1);
  const warnAt = (list: string[]) => list.some((n) => n.includes("不会保存"));
  pass(
    v.store.pageCount === before + 1,
    "H1 只读态侧栏加页：内存页数 " + before + "→" + v.store.pageCount +
      "（走" + (addBtn ? "真实按钮" : "store.addPage") + "，改动确实进了内存）"
  );
  pass(
    warnAt(atChange),
    "H2 改动**当下**有只读警告=" + warnAt(atChange) + "；该时刻新增 Notice=" + JSON.stringify(atChange) +
      "；dirty=" + v.dirty + "（证明 markDirty 跑过）；readOnlyNoticeShown=" + (v as any).readOnlyNoticeShown +
      "（true=去重标志已在打开时消费）；打开时已有 " + atOpen.length + " 条（含警告=" + warnAt(atOpen) + "）"
  );

  const t1 = calls.length;
  const n2 = notices.length;
  await v.onClose();
  const atClose = notices.slice(n2);
  pass(
    totalCalls(t1) === 0,
    "H3 关闭时写盘=" + totalCalls(t1) + " 次（期望 0）；关闭时新增 Notice=" + JSON.stringify(atClose) +
      "；内存最终页数=" + (v.store?.pageCount ?? "store=null") + "；主文件未被改写=" +
      (files.get(p) === "坏 JSON，正文读不出来")
  );
  v.containerEl.remove();
}

/**
 * I：`-recovered` 副本名只有**分钟**精度，同分钟内重复恢复会不会覆盖用户已写的副本？
 *
 * 场景：原文件损坏 → 恢复并另存 recovered 副本 → 用户切到副本写了东西 →
 * 一分钟后（或更短）又去打开那个坏掉的原文件 → 会不会把副本重新写一遍、
 * 把用户刚写的字冲掉？
 */
async function I() {
  const p = "I.inkbook";
  const bad = "坏 JSON，正文读不出来";
  seed(p, bad);
  seed(p + ".bak", JSON.stringify(mkBook("I-备份", 4, 2)));
  const v = await openView();
  await v.onLoadFile(tf(p));
  await sleep(700);
  // 必须只认**本书**的副本：前面用例（C9b 等）也留下过 .recovered- 文件，
  // 用 keys()[0] 会挑到别人的副本，测出来是假绿
  const recOf = () => keys().filter((k) => k.startsWith("I.recovered-"));
  const rec = recOf()[0];
  if (!rec) {
    log("I 未生成 recovered 副本，用例无法构造");
    v.containerEl.remove();
    return;
  }
  // 模拟用户已经切到副本里接着写了 2 笔。
  // 真实改动会走 writeBook 重算 integrity，手工改必须自己补上，
  // 否则后面打开这份副本会被 integrity 校验判成"文件可能不完整"。
  const edited = JSON.parse(files.get(rec));
  edited.pages[0].layers[0].strokes.push(mkStroke(77), mkStroke(78));
  edited.integrity = { pageCount: edited.pages.length, strokeCount: countStrokes(edited) };
  const editedText = JSON.stringify(edited);
  const editedStrokes = countStrokes(edited);
  files.set(rec, editedText);

  // 同一分钟内再打开那个仍然损坏的原文件
  await v.onLoadFile(tf(p));
  await sleep(700);
  const recFiles = recOf();
  const survived = files.get(rec) === editedText;
  let nowStrokes = -1;
  try {
    nowStrokes = countStrokes(JSON.parse(files.get(rec)));
  } catch (_) {}
  if (recFiles.length > 1) {
    log(
      "I 两次恢复落在不同分钟（副本数=" + recFiles.length + "），覆盖未复现——本用例对分钟边界不敏感，需重跑"
    );
  }
  // I②：打开 recovered 副本**本身**不该再增殖新副本（它是一本正常文件）
  const beforeCount = recOf().length;
  await v.onLoadFile(tf(rec));
  await sleep(700);
  const afterCount = recOf().length;
  pass(
    afterCount === beforeCount && v.store != null && v.store.strokeCount === editedStrokes,
    "I② 打开 recovered 副本本身不增殖：副本数 " + beforeCount + "→" + afterCount +
      "；store=" + (v.store != null) + "；笔迹=" + (v.store?.strokeCount ?? "-") + "（期望 " + editedStrokes + "）"
  );

  log(
    "I 目录清单=" + JSON.stringify(
      keys().filter((k) => k.startsWith("I.")).map((k) => {
        let n = -1;
        try { n = countStrokes(JSON.parse(files.get(k))); } catch (_) {}
        return k.split("/").pop() + "(" + n + "笔)";
      })
    )
  );
  pass(
    survived,
    "I 同分钟重复恢复：recovered 副本未被覆盖=" + survived + "；用户笔迹 " + editedStrokes + "→" + nowStrokes +
      "；副本=" + rec.split("/").pop() + "；本用例 recovered 文件数=" + recFiles.length
  );
  v.containerEl.remove();
}

/**
 * J：页序重排（侧栏「长按 → 上移/下移」的完整路径）。
 *
 * 用户场景：补页/导入后想把某页挪到中间，撤销后顺序必须回去。
 * 页 id 是身份、下标只是位置——这里同时盯 store 顺序和主视图/侧栏 DOM，
 * 因为「页数没变但顺序变了」最容易漏掉 DOM 重建（第 3 页还显示第 1 页的内容）。
 */
async function J() {
  const p = "J.inkbook";
  seed(p, JSON.stringify(mkBook("J本", 4, 2)));
  const v = await openView();
  await v.onLoadFile(tf(p));
  await sleep(400);

  const ids = (): string[] => v.store.data.pages.map((pg: any) => pg.id);
  const strokesById = (): Map<string, number> => {
    const m = new Map<string, number>();
    for (const pg of v.store.data.pages) {
      let n = 0;
      for (const l of pg.layers) n += l.strokes.length;
      m.set(pg.id, n);
    }
    return m;
  };
  const mainDomIds = (): string[] =>
    [...v.contentEl.querySelectorAll(".mb-page-wrap")].map((el: any) => el.dataset.pageId);
  const sideDomIds = (): string[] =>
    [...v.contentEl.querySelectorAll(".mb-thumb:not(.mb-thumb-add)")].map(
      (el: any) => el.dataset.pageId
    );

  /** 真实 UI：长按某条目 → 点菜单项 */
  async function longPress(pageIndex: number, label: "上移" | "下移"): Promise<boolean> {
    const item = v.contentEl.querySelector(
      `.mb-thumb[data-page="${pageIndex}"]`
    ) as HTMLElement | null;
    if (!item) return false;
    item.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 41,
        pointerType: "touch",
        clientX: 20,
        clientY: 20,
      } as any)
    );
    await sleep(700);
    const menu = item.querySelector(".mb-thumb-menu") as HTMLElement | null;
    const btn = [...(menu?.querySelectorAll("button") || [])].find(
      (b) => (b.textContent || "") === label
    ) as HTMLElement | undefined;
    if (!menu || !btn) {
      item.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 41 } as any));
      return false;
    }
    btn.click();
    await sleep(150);
    return true;
  }

  const before = ids();
  const beforeStrokes = strokesById();
  pass(
    before.length === 4 && new Set(before).size === 4,
    "J1 前置：4 页且页 id 唯一（" + before.length + " 页）"
  );

  // ① 第 3 页长按上移 → 与第 2 页换位
  const movedOk = await longPress(2, "上移");
  const moved = ids();
  pass(
    movedOk && moved[1] === before[2] && moved[2] === before[1] && moved.length === 4,
    "J2 长按「上移」后 store 顺序：" + moved.map((x) => before.indexOf(x)).join(",") +
      "（期望 0,2,1,3；页 id 身份不变）"
  );
  pass(
    mainDomIds().join(",") === moved.join(","),
    "J2 主视图页 DOM 跟着换序（" + mainDomIds().map((x) => before.indexOf(x)).join(",") + "）"
  );
  pass(
    sideDomIds().join(",") === moved.join(","),
    "J2 侧栏条目跟着换序（" + sideDomIds().map((x) => before.indexOf(x)).join(",") + "）"
  );

  // ② 撤销：顺序恢复（页数没变，必须靠页顺序版本触发 DOM 重建）
  v.editor.undo();
  await sleep(200);
  pass(
    ids().join(",") === before.join(","),
    "J3 撤销后 store 顺序恢复（" + ids().map((x) => before.indexOf(x)).join(",") + "）"
  );
  pass(
    mainDomIds().join(",") === before.join(",") && sideDomIds().join(",") === before.join(","),
    "J3 撤销后主视图 + 侧栏 DOM 也恢复（主=" + mainDomIds().map((x) => before.indexOf(x)).join(",") +
      "；侧=" + sideDomIds().map((x) => before.indexOf(x)).join(",") + "）"
  );

  // ③ 重做：再次前移
  v.editor.redo();
  await sleep(200);
  pass(
    ids().join(",") === moved.join(","),
    "J4 重做后再次前移（" + ids().map((x) => before.indexOf(x)).join(",") + "）"
  );
  pass(
    mainDomIds().join(",") === moved.join(","),
    "J4 重做后主视图 DOM 再次换序（" + mainDomIds().map((x) => before.indexOf(x)).join(",") + "）"
  );

  // ④ 笔迹跟着页 id 走：移动/撤销/重做一条都不能丢、不能串页
  const nowStrokes = strokesById();
  let strokesOk = nowStrokes.size === beforeStrokes.size;
  for (const [id, n] of beforeStrokes) if (nowStrokes.get(id) !== n) strokesOk = false;
  pass(
    strokesOk,
    "J5 移动/撤销/重做不影响每页笔迹（" +
      [...nowStrokes].map(([id, n]) => "p" + before.indexOf(id) + "=" + n).join(" ") + "）"
  );

  // 反方向也走一遍真实 UI：第 1 页「下移」
  const downOk = await longPress(0, "下移");
  const down = ids();
  pass(
    downOk && down[1] === moved[0] && down[0] === moved[1],
    "J6 长按「下移」也能换位（" + down.map((x) => before.indexOf(x)).join(",") + "，期望 2,0,1,3）"
  );
  v.editor.undo();
  await sleep(200);
  pass(
    ids().join(",") === moved.join(","),
    "J6 下移后撤销恢复（" + ids().map((x) => before.indexOf(x)).join(",") + "）"
  );

  // 越界/原地移动不记历史
  const rev = v.store.pageOrderRev;
  pass(
    v.store.movePage(0, -1) === false && v.store.movePage(0, 0) === false &&
      v.store.movePage(0, 99) === false && v.store.pageOrderRev === rev,
    "J7 越界/原地移动返回 false 且不产生历史（rev 不变 " + rev + "）"
  );

  await v.onClose();
  v.containerEl.remove();
}

/**
 * K：本子目录（outline）。
 *
 * 覆盖四条主线：
 *   ① 往返：加目录 → 保存 → 重开，目录还在（normalizeBook 白名单没把它抹掉）
 *   ② 脏数据：normalizeBook 丢弃坏条目（title 空串 / page 负数或非整数 / id 缺失）
 *   ③ 撤销/重做：撤销一次目录恢复，撤销两次回到原状，重做也能回去
 *   ④ 规模：加 500 条目录不崩（DOM 不会一次建几千个）
 */
async function K() {
  /* ---------- ① 往返：加目录 → 保存 → 重开还在 ---------- */
  const p = "K.inkbook";
  seed(p, JSON.stringify(mkBook("K本", 5, 1)));
  const v = await openView();
  await v.onLoadFile(tf(p));
  await sleep(400);

  const id1 = v.store.addOutline("第一章", 0);
  const id2 = v.store.addOutline("第二章", 2);
  pass(
    !!id1 && !!id2 && v.store.outlines.length === 2,
    "K1 加两条目录：条数=" + v.store.outlines.length + "（期望 2）；id 唯一=" +
      (!!id1 && !!id2 && id1 !== id2)
  );
  pass(
    v.store.outlines[0].page === 0 && v.store.outlines[1].page === 2,
    "K1 页码存的是 0 起下标（" + v.store.outlines.map((o) => o.page).join(",") + "，期望 0,2）"
  );

  // 等自动保存落盘
  await sleep(1300);
  let saved: any = null;
  try {
    saved = JSON.parse(files.get(p));
  } catch (e: any) {
    log("K1 保存结果解析失败 " + e);
  }
  pass(
    Array.isArray(saved?.outlines) && saved.outlines.length === 2 &&
      saved.outlines[0].title === "第一章" && saved.outlines[1].page === 2,
    "K1 保存到文件：outlines=" + JSON.stringify(saved?.outlines)
  );

  await v.onClose();
  v.containerEl.remove();

  // 重开：目录还在
  const v2 = await openView();
  await v2.onLoadFile(tf(p));
  await sleep(400);
  pass(
    v2.store.outlines.length === 2 && v2.store.outlines[0].title === "第一章" &&
      v2.store.outlines[1].page === 2,
    "K2 重开后目录还在：条数=" + v2.store.outlines.length + "；内容=" +
      JSON.stringify(v2.store.outlines)
  );
  await v2.onClose();
  v2.containerEl.remove();

  /* ---------- ② 脏数据：normalizeBook 丢弃坏条目 ---------- */
  const dirty: any = mkBook("脏数据本", 3, 0);
  dirty.outlines = [
    { id: "ok1", title: "好的", page: 1 },                       // 合法
    { id: "bad1", title: "", page: 1 },                        // title 空串 → 丢
    { id: "bad2", title: "   ", page: 1 },                     // title 全空白 → 丢
    { id: "bad3", title: "负页", page: -1 },                   // page 负数 → 丢
    { id: "bad4", title: "小数", page: 1.5 },                  // page 非整数 → 丢
    { id: "bad5", title: "非数字页", page: "abc" },            // page 不是数字 → 丢
    { title: "没有id", page: 1 },                              // id 缺失 → 丢
    { id: "bad7", title: "越界页", page: 9999 },               // page 超范围：留着，但点击要安全
  ];
  const dp = "K-dirty.inkbook";
  seed(dp, JSON.stringify(dirty));
  const v3 = await openView();
  await v3.onLoadFile(tf(dp));
  await sleep(400);
  const kept = v3.store.outlines;
  pass(
    kept.length === 2 && kept[0].title === "好的" && kept[1].title === "越界页",
    "K3 normalizeBook 丢弃脏目录：留下 " + kept.length + " 条（期望 2）=" +
      JSON.stringify(kept.map((o) => ({ t: o.title, p: o.page })))
  );
  // 越界的那条：点击不能抛异常（要夹到有效范围）
  let threw = "";
  try {
    const row = v3.contentEl.querySelector(".mb-outline") as HTMLElement | null;
    if (row) row.click();
  } catch (e: any) {
    threw = String(e?.stack || e);
  }
  pass(
    threw === "" && v3.editor.getState().pageIndex >= 0 &&
      v3.editor.getState().pageIndex < v3.store.pageCount,
    "K3 越界目录项点击不抛异常：threw=" + JSON.stringify(threw) + "；当前页=" +
      v3.editor.getState().pageIndex + "（页数 " + v3.store.pageCount + "）"
  );
  await v3.onClose();
  v3.containerEl.remove();

  /* ---------- ②b 重复 id：只留第一条（2026-11-07 补） ---------- */
  /*
   * UI 全用 id 定位目录条目（findIndex / find），重复 id 会让第二条
   * 永远选不中也删不掉，变成点不到的孤儿。正常流程不会产生重复
   * （uid("outline") 唯一），但手改文件 / 两份文件合并会带进来。
   */
  {
    const dup: any = mkBook("重复id本", 3, 0);
    dup.outlines = [
      { id: "same", title: "第一条", page: 0 },
      { id: "same", title: "重复的", page: 1 },
      { id: "other", title: "另一条", page: 2 },
    ];
    const dp2 = "K-dup.inkbook";
    seed(dp2, JSON.stringify(dup));
    const v4 = await openView();
    await v4.onLoadFile(tf(dp2));
    await sleep(400);
    const list = v4.store.outlines;
    pass(
      list.length === 2 && list[0].title === "第一条" && list[1].title === "另一条",
      "K3b normalizeBook 去掉重复 id：留下 " + list.length + " 条（" +
        JSON.stringify(list.map((o) => o.title)) +
        "，期望 [第一条, 另一条]）"
    );
    pass(
      new Set(list.map((o) => o.id)).size === list.length,
      "K3b 去重后所有 id 唯一（" + list.map((o) => o.id).join(",") + "）"
    );
    await v4.onClose();
    v4.containerEl.remove();
  }

  /* ---------- ③ 撤销 / 重做 ---------- */
  const up = "K-undo.inkbook";
  seed(up, JSON.stringify(mkBook("撤销本", 4, 0)));
  const v4 = await openView();
  await v4.onLoadFile(tf(up));
  await sleep(400);
  const noneBefore = v4.store.outlines.length === 0;
  v4.store.addOutline("甲", 1);
  v4.store.addOutline("乙", 2);
  pass(
    noneBefore && v4.store.outlines.length === 2,
    "K4 前置：原来没有目录 → 加两条后有 " + v4.store.outlines.length + " 条"
  );
  // 撤销一次：回到 1 条
  v4.editor.undo();
  await sleep(200);
  pass(
    v4.store.outlines.length === 1 && v4.store.outlines[0].title === "甲",
    "K4 撤销一次：剩 " + v4.store.outlines.length + " 条（期望 1，且是「甲」）"
  );
  // 撤销两次：回到原状（没有目录）
  v4.editor.undo();
  await sleep(200);
  pass(
    v4.store.outlines.length === 0 && v4.store.data.outlines === undefined,
    "K4 撤销两次：回到原状（条数=" + v4.store.outlines.length +
      "；字段=" +
      (v4.store.data.outlines === undefined ? "undefined ✓" : JSON.stringify(v4.store.data.outlines)) +
      "）"
  );
  // 重做两次：两条都回来
  v4.editor.redo();
  await sleep(200);
  v4.editor.redo();
  await sleep(200);
  pass(
    v4.store.outlines.length === 2 &&
      v4.store.outlines[0].title === "甲" && v4.store.outlines[1].title === "乙",
    "K4 重做两次：目录回来了（" + JSON.stringify(v4.store.outlines.map((o) => o.title)) + "）"
  );
  // 再撤销一次
  v4.editor.undo();
  await sleep(150);
  pass(
    v4.store.outlines.length === 1,
    "K4 重做后再撤销：剩 " + v4.store.outlines.length + " 条（期望 1）"
  );

  /* ---------- ③a 编辑弹窗：名字 + 页码一次改完 = 一条撤销记录 ---------- */
  const cur = v4.store.outlines[0];
  v4.store.updateOutline(cur.id, "甲改名", 3);
  await sleep(150);
  pass(
    v4.store.outlines[0].title === "甲改名" && v4.store.outlines[0].page === 3,
    "K5 updateOutline 一次改完名字和页码：" + JSON.stringify(v4.store.outlines[0])
  );
  v4.editor.undo();
  await sleep(150);
  pass(
    v4.store.outlines[0].title === "甲" && v4.store.outlines[0].page === 1,
    "K5 撤销一次就整体回退（名字和页码一起回去）：" + JSON.stringify(v4.store.outlines[0])
  );

  /* ---------- ③b 删页 / 加页 → 目录的页码跟着挪（夹住，不删条目） ---------- */
  const dp2 = "K-pages.inkbook";
  seed(dp2, JSON.stringify(mkBook("页码本", 5, 0)));
  const v5 = await openView();
  await v5.onLoadFile(tf(dp2));
  await sleep(400);
  v5.store.addOutline("p0", 0);
  v5.store.addOutline("p2", 2);
  v5.store.addOutline("p4", 4);
  v5.store.deletePage(2); // 删掉第 3 页
  await sleep(200);
  pass(
    v5.store.outlines.length === 3 &&
      v5.store.outlines[0].page === 0 &&
      v5.store.outlines[1].page === 2 &&
      v5.store.outlines[2].page === 3,
    "K6 删掉第 3 页：目录三条都还在，页码=" +
      JSON.stringify(v5.store.outlines.map((o) => o.page)) +
      "（期望 [0,2,3]：指向被删页的夹到原下一页，后面的 -1）"
  );
  // 撤销删页：目录的页码要一起回去
  v5.editor.undo();
  await sleep(200);
  pass(
    v5.store.outlines.length === 3 &&
      v5.store.outlines[0].page === 0 &&
      v5.store.outlines[1].page === 2 &&
      v5.store.outlines[2].page === 4,
    "K6 撤销删页：目录页码一起还原=" +
      JSON.stringify(v5.store.outlines.map((o) => o.page)) + "（期望 [0,2,4]）"
  );
  // 加页：后面的页码 +1
  v5.store.addPage(0); // 在第 1 页后插入一页
  await sleep(200);
  pass(
    v5.store.outlines[0].page === 0 && v5.store.outlines[1].page === 3 &&
      v5.store.outlines[2].page === 5,
    "K6 加一页：目录页码跟着挪=" +
      JSON.stringify(v5.store.outlines.map((o) => o.page)) + "（期望 [0,3,5]）"
  );
  await v5.onClose();
  v5.containerEl.remove();

  /* ---------- ④ 规模：500 条不崩 ---------- */
  let bigThrew = "";
  const t0 = performance.now();
  try {
    for (let i = 0; i < 500; i++) v4.store.addOutline("目录 " + i, i % 4);
  } catch (e: any) {
    bigThrew = String(e?.stack || e);
  }
  const addMs = Math.round(performance.now() - t0);
  v4.updateUI();
  await sleep(300);
  let uiThrew = "";
  let domCount = -1;
  try {
    domCount = v4.contentEl.querySelectorAll(".mb-outline").length;
  } catch (e: any) {
    uiThrew = String(e?.stack || e);
  }
  pass(
    bigThrew === "" && v4.store.outlines.length === 501,
    "K5 加 500 条目录不崩：条数=" + v4.store.outlines.length + "（期望 501）；异常=" +
      JSON.stringify(bigThrew.slice(0, 60)) + "；耗时=" + addMs + "ms"
  );
  pass(
    uiThrew === "" && domCount > 0 && domCount < 501,
    "K5 侧栏没一次建 501 个 DOM：实际建了 " + domCount + " 个条目（窗口化生效）"
  );
  /*
   * 窗口化的 spacer 总高度必须与「真实条目数 × 真实行高」一致
   * （2026-11-07 补）：行高量到 0 时曾被兜底成 24（真实约 30），
   * 于是 spacer 每行少算 6px × 500 条 = 3000px，滚动条比例失真、
   * 滚到「视觉底部」时实际还有内容没到。
   */
  {
    const listEl = v4.contentEl.querySelector(".mb-outline-list") as HTMLElement | null;
    const rows = v4.contentEl.querySelectorAll(".mb-outline") as NodeListOf<HTMLElement>;
    if (listEl && rows.length > 0) {
      const realRowH = rows[0].getBoundingClientRect().height;
      const listH = listEl.getBoundingClientRect().height;
      // 列表总高应约等于 501 × 真实行高（容差 2 行，spacer 与条目取整会有零头）
      const expect = v4.store.outlines.length * realRowH;
      pass(
        Math.abs(listH - expect) <= realRowH * 2 + 2,
        "K5 窗口化 spacer 总高与真实行高一致（列表 " +
          listH.toFixed(0) +
          "px / 期望 " +
          expect.toFixed(0) +
          "px，行高 " +
          realRowH.toFixed(1) +
          "px）"
      );
    } else {
      pass(false, "K5 目录列表/条目没建出来，无法核对 spacer 高度");
    }
  }
  // 逐条撤销不能炸（撤销栈有 60 层上限，撤 500 次会撤到底但不能抛异常）
  let undoThrew = "";
  let undoed = 0;
  try {
    for (let i = 0; i < 500; i++) if (v4.store.undo()) undoed++;
  } catch (e: any) {
    undoThrew = String(e?.stack || e);
  }
  pass(
    undoThrew === "" && undoed > 0 && v4.store.outlines.length < 501,
    "K5 连撤 500 次不炸：实际撤了 " + undoed + " 次，剩 " + v4.store.outlines.length +
      " 条（撤销栈上限 60，撤到底就停）；异常=" + JSON.stringify(undoThrew.slice(0, 60))
  );
  await v4.onClose();
  v4.containerEl.remove();
}

/**
 * L：保存还在飞的时候切本子（INK-167）。
 *
 * 真实触发条件很窄但一定会撞上：写完一两秒内马上开另一本。旧实现里
 * `saveNow` 是「先 await 指纹 → 再读 this.store.data」，切本子恰好落在
 * 这个 await 里，于是**新本的内容被写进了旧本的文件**；同时
 * `flushSave` 的 `await saveNow()` 因为 `saving` 直接返回，等于没等。
 *
 * 这里把指纹那一步拖慢 120ms 稳定造出窗口，然后断言：
 *   · A 的文件里是 A 的内容（含刚加的那一笔）
 *   · B 的文件一个字节没动
 *   · 切换后真的打开了 B
 */
async function L167() {
  const pa = "L167-A.inkbook";
  const pb = "L167-B.inkbook";
  const aText = JSON.stringify(mkBook("L167-A本", 3, 2));
  const bText = JSON.stringify(mkBook("L167-B本", 5, 3));
  seed(pa, aText);
  seed(pb, bText);

  const v = await openView();
  await v.onLoadFile(tf(pa));
  await sleep(400);
  const before = v.store.strokeCount;

  v.store.addStroke(mkStroke(777), 0); // dirty
  statDelayMs = 120; // 让「取指纹」这一步慢下来，制造在途窗口
  const inFlight = v.saveNow(); // 故意不 await：模拟自动保存正在写
  await sleep(20); // 确保它已经进到 fingerprint 的 await 里
  await v.onLoadFile(tf(pb)); // 用户在保存没写完时切了本子
  statDelayMs = 0;
  await inFlight;
  await sleep(300);

  let aSaved: any = null;
  let aErr = "";
  try {
    aSaved = JSON.parse(files.get(pa));
  } catch (e: any) {
    aErr = String(e?.message || e);
  }
  let bSaved: any = null;
  try {
    bSaved = JSON.parse(files.get(pb));
  } catch (_) {}

  pass(
    !!aSaved && aSaved.title === "L167-A本" && aSaved.pages.length === 3,
    "L167① A 的文件里仍是 A 的内容：title=" + JSON.stringify(aSaved?.title) +
      "，页数=" + aSaved?.pages?.length + "（期望 L167-A本 / 3）；解析错误=" + JSON.stringify(aErr)
  );
  pass(
    !!aSaved && countStrokes(aSaved) === before + 1,
    "L167② 切本前那一笔写进了 A：笔迹=" + (aSaved ? countStrokes(aSaved) : -1) +
      "（期望 " + (before + 1) + "）"
  );
  pass(
    files.get(pb) === bText,
    "L167③ B 的文件一个字节没动=" + (files.get(pb) === bText) +
      "（页数 " + bSaved?.pages?.length + "）"
  );
  pass(
    !!v.store && v.store.pageCount === 5,
    "L167④ 切换后打开的是 B：页数=" + (v.store?.pageCount ?? "-") + "（期望 5）"
  );
  await v.onClose();
  v.containerEl.remove();
}

/**
 * M：手还按在纸上就关标签页（INK-168）。
 *
 * 这一笔只活在 editor 的 draft 里，从没进过 book。以前只有
 * visibilitychange / pagehide 会收尾，而桌面关标签页走的是 onClose
 * （页面并不 hidden），于是那一笔就没了。
 */
async function M168() {
  const p = "M168.inkbook";
  const text = JSON.stringify(mkBook("M168本", 2, 1));
  seed(p, text);
  const v = await openView();
  await v.onLoadFile(tf(p));
  await sleep(500);

  const before = v.store.strokeCount;
  const pressed = pressOnPage(v);
  await sleep(120);
  const busy = v.editor ? v.editor.isInkBusy() : false;
  // 基线：这一笔此刻**还没**进 book（正是要验证的「只在 draft 里」）
  const mid = v.store.strokeCount;

  await v.onClose(); // 手还没抬就关标签页

  let saved: any = null;
  try {
    saved = JSON.parse(files.get(p));
  } catch (_) {}
  pass(
    pressed && busy && mid === before,
    "M168① 复现前提：按下未抬笔=" + pressed + "，isInkBusy=" + busy +
      "，此刻 book 里笔迹 " + mid + "（期望仍为 " + before + "）"
  );
  pass(
    !!saved && countStrokes(saved) === before + 1,
    "M168② 关标签页前把半笔收尾写进磁盘：落盘笔迹=" +
      (saved ? countStrokes(saved) : -1) + "（期望 " + (before + 1) + "）"
  );
  v.containerEl.remove();
}

/**
 * N：保存失败（磁盘满 / 无权限）之后又切本子（INK-169）。
 *
 * 宿主不允许我们拦住 onLoadFile，所以退一步：必须把内存里那份
 * 另存成 `.unsaved-` 副本，并用**不会自动消失**的提示告诉用户。
 * 否则 store 一换，半小时的笔记就彻底没了。
 */
async function N169() {
  const pa = "N169-A.inkbook";
  const pb = "N169-B.inkbook";
  seed(pa, JSON.stringify(mkBook("N169-A本", 2, 1)));
  seed(pb, JSON.stringify(mkBook("N169-B本", 4, 2)));

  const v = await openView();
  await v.onLoadFile(tf(pa));
  await sleep(400);
  const before = v.store.strokeCount;
  v.store.addStroke(mkStroke(888), 0);
  v.store.addStroke(mkStroke(889), 0);
  await sleep(100);

  const n0 = notices.length;
  // 只让 A 的主文件 / 备份 / 临时文件写不进去；抢救副本必须还能写
  writeFailFor = (p) => p === pa || p === pa + ".bak" || p === pa + ".tmp";
  await v.onLoadFile(tf(pb));
  writeFailFor = null;
  await sleep(400);

  const caseNotices = notices.slice(n0);
  const failNotice = caseNotices.find((n) => n.includes("保存失败")) || "";
  const rescueNotice = caseNotices.find((n) => n.includes("另存为")) || "";
  const rescued = keys().filter((k) => /^N169-A\.unsaved-\d{8}-\d{4}-p\d+\.inkbook$/.test(k));
  let rescuedStrokes = -1;
  try {
    rescuedStrokes = countStrokes(JSON.parse(files.get(rescued[0])));
  } catch (_) {}

  pass(failNotice.length > 0, "N169① 保存失败有明确提示=" + (failNotice.length > 0) +
    "；文案=" + JSON.stringify(failNotice.slice(0, 60)));
  pass(
    rescued.length >= 1 && rescuedStrokes === before + 2,
    "N169② 切本前把没落盘的内容抢救成副本=" + (rescued[0] || "无") +
      "；笔迹=" + rescuedStrokes + "（期望 " + (before + 2) + "）"
  );
  pass(
    rescueNotice.length > 0,
    "N169③ 提示里说明了副本名=" + (rescueNotice.length > 0) +
      "；文案=" + JSON.stringify(rescueNotice.slice(0, 70))
  );
  pass(
    !!v.store && v.store.pageCount === 4,
    "N169④ 仍然能切到 B（没把用户卡死）：页数=" + (v.store?.pageCount ?? "-")
  );
  await v.onClose();
  v.containerEl.remove();
}

/**
 * O：写盘回退不毁掉唯一完整副本 + 没备份时别让人去找 .bak（INK-170）。
 *
 * 旧实现：rename 失败 → 先 `removeQuietly(tmp)` 再直接覆盖正文。
 * 于是「tmp 已经完整写好、只是改名被占用」这种情况，唯一完整的 JSON
 * 被自己删了，接着直写正文又可能失败，用户两头落空。
 */
async function O170() {
  const p = "O170.inkbook";
  const text = JSON.stringify(mkBook("O170本", 2, 1));
  seed(p, text);
  const v = await openView();
  await v.onLoadFile(tf(p));
  await sleep(400);

  // 落一笔 → 保存时让 rename 一直失败（tmp 会写好）
  v.store.addStroke(mkStroke(4242), 0);
  renameFailFor = (_o, n) => n === p;
  await v.saveNow();
  renameFailFor = null;
  await sleep(100);

  const tmpPath = p + ".tmp";
  const tmpOk = files.has(tmpPath);
  let tmpStrokes = -1;
  try {
    tmpStrokes = countStrokes(JSON.parse(files.get(tmpPath)));
  } catch (_) {}
  pass(
    tmpOk && tmpStrokes === countStrokes(JSON.parse(text)) + 1,
    "O170① rename 失败时保留完整的 .tmp=" + tmpOk + "；其中笔迹=" + tmpStrokes +
      "（期望 " + (countStrokes(JSON.parse(text)) + 1) + "）"
  );
  pass(
    countStrokes(JSON.parse(files.get(p))) === tmpStrokes,
    "O170② 正文仍然写成功（回退直写）"
  );
  await v.onClose();
  v.containerEl.remove();

  // 坏文件 + 没有 .bak：提示不能说「试试 .bak」
  const bad = "O170-bad.inkbook";
  seed(bad, "{ 这不是 JSON");
  const v2 = await openView();
  await v2.onLoadFile(tf(bad));
  await sleep(400);
  const html = (v2.editorHost?.textContent || "").replace(/\s+/g, " ");
  pass(
    html.includes("没有找到 .bak"),
    "O170③ 没有备份时提示如实说「没有找到 .bak」=" + html.includes("没有找到 .bak") +
      "；文案=" + JSON.stringify(html.slice(0, 90))
  );
  v2.containerEl.remove();

  // 坏文件 + 有 .bak：仍然提示可以试 .bak
  const bad2 = "O170-bad2.inkbook";
  seed(bad2, "{ 这不是 JSON");
  seed(bad2 + ".bak", JSON.stringify(mkBook("O170备份", 2, 1)));
  const v3 = await openView();
  const n3Start = notices.length;
  await v3.onLoadFile(tf(bad2));
  await sleep(400);
  // 只看**这个用例这一段**的 Notice：上面几个用例也弹过「已从备份恢复」
  const n3 = notices.slice(n3Start).join(" ");
  pass(
    n3.includes("已从备份恢复") && n3.includes("O170-bad2.recovered-"),
    "O170④ 有备份时走恢复并另存副本：Notice=" + JSON.stringify(n3.slice(0, 100))
  );
  v3.containerEl.remove();
}

/**
 * Q：改名后必须写到**新路径**（INK-174 复查发现的回归）。
 *
 * `bookPath` 是 INK-167 防串写引入的：saveNow 优先用它而不是 this.file.path。
 * 但宿主改名只改 `file.path`、**不重载视图**，如果 view 不覆写 onRename，
 * bookPath 就永远停在旧路径上——改名后每次保存都在旧路径重新造一个文件，
 * 新名字的文件一直停在改名前的版本。用户看到「已保存」，关掉重开少一段。
 */
async function Q174() {
  const oldPath = "Q174-旧名.inkbook";
  const newPath = "Q174-新名.inkbook";
  const original = JSON.stringify(mkBook("Q174本", 3, 2));
  seed(oldPath, original);

  const v = await openView();
  await v.onLoadFile(tf(oldPath));
  await sleep(400);
  const before = v.store.strokeCount;

  // 宿主改名：只换 file 路径，然后调 onRename（不重载视图）
  const renamed = tf(newPath);
  files.set(newPath, files.get(oldPath)!);
  mt.set(newPath, bumpMt());
  files.delete(oldPath);
  mt.delete(oldPath);
  await v.onRename(renamed);
  await sleep(50);

  // 改名后落一笔 → 必须写进新路径
  v.store.addStroke(mkStroke(1741), 0);
  await sleep(1300);

  let newSaved: any = null;
  try {
    newSaved = JSON.parse(files.get(newPath));
  } catch (_) {}
  pass(
    !!newSaved && countStrokes(newSaved) === before + 1,
    "Q174① 改名后保存写到新路径：新文件笔迹=" +
      (newSaved ? countStrokes(newSaved) : -1) + "（期望 " + (before + 1) + "）"
  );
  pass(
    !files.has(oldPath),
    "Q174② 没有在旧路径重新造出文件（旧路径存在=" + files.has(oldPath) + "）"
  );

  await v.onClose();
  v.containerEl.remove();
}

/**
 * R：抢救标记不能吞掉第二次机会（INK-174 复查）。
 *
 * 以前 `rescued` 在**写之前**就置位：第一次抢救因为磁盘满失败后，
 * 用户继续写、再切本子时会被直接挡掉——真正该救的内容反而没救。
 * 现在改成「写成功才置位」，且新改动会把标记复位。
 */
async function R174() {
  const pa = "R174-A.inkbook";
  const pb = "R174-B.inkbook";
  seed(pa, JSON.stringify(mkBook("R174-A本", 2, 1)));
  seed(pb, JSON.stringify(mkBook("R174-B本", 3, 1)));

  const v = await openView();
  await v.onLoadFile(tf(pa));
  await sleep(400);
  v.store.addStroke(mkStroke(1742), 0);
  await sleep(100);

  // 第一次：主文件和抢救副本都写不进去 → 抢救失败，rescued 不该置位
  writeFailFor = (p) => p.startsWith("R174-A");
  await v.onUnloadFile();
  const firstTry = keys().filter((k) => k.includes("R174-A.unsaved-"));
  writeFailFor = null;

  // 第二次：重新打开 A、写一笔、这次允许抢救 → 必须救得下来
  await v.onLoadFile(tf(pa));
  await sleep(400);
  v.store.addStroke(mkStroke(1743), 0);
  await sleep(100);
  writeFailFor = (p) => p === pa || p === pa + ".bak" || p === pa + ".tmp";
  await v.onUnloadFile();
  writeFailFor = null;

  const rescued = keys().filter((k) => k.includes("R174-A.unsaved-"));
  pass(
    firstTry.length === 0 && rescued.length >= 1,
    "R174① 第一次抢救失败不置位、第二次仍能救：第一次副本=" + firstTry.length +
      "（期望 0）；第二次副本=" + rescued.length + "（期望 ≥1）"
  );
  v.containerEl.remove();
}

/**
 * P：保存并恢复「缩放 + 页内滚动位置」（INK-173）。
 *
 * 覆盖四条主线：
 *   ① 文件里存了 zoom/scrollTop → 重开后真的恢复（不是回到 fit + 页首）
 *   ② fit 模式不把算出来的比例写成用户 zoom（否则换窗口尺寸会被锁死）
 *   ③ 非法值：zoom 夹到 [0.3,2.8]，scrollTop 负数/字符串丢弃
 *   ④ 老文件没有这两个字段 → 正常 fit 打开，且不凭空写回默认字段
 */
async function P173() {
  /* ---------- ① 已有 zoom/scrollTop → 打开即恢复，保存后再重开仍是新值 ---------- */
  const p = "P173.inkbook";
  const seeded: any = mkBook("P173本", 4, 1);
  seeded.zoom = 1.5;
  seeded.scrollTop = 640;
  seed(p, JSON.stringify(seeded));

  const v = await openView();
  await v.onLoadFile(tf(p));
  await sleep(500);
  const ed = v.editor;
  const st = ed.getState();
  const top = ed.scrollEl.scrollTop;
  pass(
    ed.fitMode === false && Math.abs(st.zoom - 1.5) < 1e-6 && Math.abs(top - 640) <= 2,
    "P173① 打开即恢复：zoom=" + st.zoom.toFixed(3) + "（期望 1.5）；fitMode=" + ed.fitMode +
      "（期望 false）；scrollTop=" + top.toFixed(1) + "（期望 640）"
  );

  // 改缩放 + 滚动后落一笔，等自动保存把新视图状态写进去
  ed.setZoom(2);
  ed.scrollEl.scrollTop = 900;
  v.store.addStroke(mkStroke(1731), 0);
  await sleep(1300);
  let saved: any = null;
  try {
    saved = JSON.parse(files.get(p));
  } catch (e: any) {
    log("P173 保存结果解析失败 " + e);
  }
  pass(
    Math.abs((saved?.zoom ?? -1) - 2) < 1e-6 && Math.abs((saved?.scrollTop ?? -1) - 900) <= 2,
    "P173② 保存写入当前视图状态：zoom=" + saved?.zoom + "（期望 2）；scrollTop=" +
      saved?.scrollTop + "（期望 ≈900）"
  );
  await v.onClose();
  v.containerEl.remove();

  /* ---------- ② 重开恢复；fit 模式不污染用户 zoom ---------- */
  const v2 = await openView();
  await v2.onLoadFile(tf(p));
  await sleep(500);
  const reZoom = v2.editor.getState().zoom;
  const reTop = v2.editor.scrollEl.scrollTop;
  pass(
    v2.editor.fitMode === false && Math.abs(reZoom - 2) < 1e-6 && Math.abs(reTop - 900) <= 2,
    "P173③ 重开后恢复上次的值：zoom=" + reZoom.toFixed(3) + "（期望 2）；scrollTop=" +
      reTop.toFixed(1) + "（期望 ≈900）"
  );

  v2.editor.fit();
  await sleep(100);
  const fitZoom = v2.editor.getState().zoom;
  v2.store.addStroke(mkStroke(1732), 0);
  await sleep(1300);
  const fitSaved: any = JSON.parse(files.get(p));
  pass(
    ("zoom" in fitSaved) === false,
    "P173④ fit 模式不把算出来的 zoom 写成用户选择：文件 zoom 字段=" +
      ("zoom" in fitSaved) + "（期望不存在）；本次 fit 比例=" + fitZoom.toFixed(3)
  );
  await v2.onClose();
  v2.containerEl.remove();

  const v3 = await openView();
  await v3.onLoadFile(tf(p));
  await sleep(500);
  pass(
    v3.editor.fitMode === true,
    "P173④ 重开时 zoom 字段缺失 → 仍然 fit（fitMode=" + v3.editor.fitMode +
      "，期望 true；zoom=" + v3.editor.getState().zoom.toFixed(3) + "）"
  );
  await v3.onClose();
  v3.containerEl.remove();

  /* ---------- ③ 非法值：夹取 / 丢弃，且不原样写回 ---------- */
  const dp = "P173-dirty.inkbook";
  const dirty: any = mkBook("P173脏本", 3, 0);
  dirty.zoom = 99;       // 超上限 → 夹到 2.8
  dirty.scrollTop = -50; // 负数 → 丢弃
  seed(dp, JSON.stringify(dirty));
  const v4 = await openView();
  await v4.onLoadFile(tf(dp));
  await sleep(500);
  const dirtyZoom = v4.editor.getState().zoom;
  const dirtyTop = v4.editor.scrollEl.scrollTop;
  pass(
    v4.editor.fitMode === false && Math.abs(dirtyZoom - 2.8) < 1e-6 && dirtyTop === 0,
    "P173⑤ zoom 99 夹到 2.8、scrollTop -50 丢弃：zoom=" + dirtyZoom.toFixed(3) +
      "；fitMode=" + v4.editor.fitMode + "；scrollTop=" + dirtyTop.toFixed(1)
  );
  // 落一笔让它保存：夹取后的 2.8 是用户显式缩放过，应该写回；脏 scrollTop 不能出现
  v4.store.addStroke(mkStroke(1733), 0);
  await sleep(1300);
  const dirtySaved: any = JSON.parse(files.get(dp));
  pass(
    Math.abs((dirtySaved?.zoom ?? -1) - 2.8) < 1e-6 && ("scrollTop" in dirtySaved) === false,
    "P173⑤ 脏值不原样写回：zoom=" + dirtySaved?.zoom + "（期望 2.8）；scrollTop 字段=" +
      ("scrollTop" in dirtySaved)
  );
  await v4.onClose();
  v4.containerEl.remove();

  // 字符串形态的脏值（手改文件 / 旧版本遗留）一律当没写
  const sp = "P173-string.inkbook";
  const strBook: any = mkBook("P173字符串本", 2, 0);
  strBook.zoom = "1.5";
  strBook.scrollTop = "120";
  seed(sp, JSON.stringify(strBook));
  const v5 = await openView();
  await v5.onLoadFile(tf(sp));
  await sleep(450);
  pass(
    v5.editor.fitMode === true && v5.store.data.zoom === undefined && v5.store.data.scrollTop === undefined,
    "P173⑥ 字符串 zoom/scrollTop 当没写：fitMode=" + v5.editor.fitMode +
      "；store.zoom=" + v5.store.data.zoom + "；store.scrollTop=" + v5.store.data.scrollTop
  );
  await v5.onClose();
  v5.containerEl.remove();

  /* ---------- ④ 老文件（没有这两个字段）正常打开，且不写出默认字段 ---------- */
  const op = "P173-old.inkbook";
  seed(op, JSON.stringify(mkBook("P173老本", 3, 1)));
  const v6 = await openView();
  await v6.onLoadFile(tf(op));
  await sleep(450);
  pass(
    v6.store.data.zoom === undefined && v6.store.data.scrollTop === undefined &&
      v6.editor.fitMode === true && v6.editor.scrollEl.scrollTop === 0,
    "P173⑦ 老文件正常打开：store.zoom=" + v6.store.data.zoom + "；store.scrollTop=" +
      v6.store.data.scrollTop + "；fitMode=" + v6.editor.fitMode + "；scrollTop=" +
      v6.editor.scrollEl.scrollTop
  );
  // 不动视图、只落一笔 → 文件里不该凭空多出 zoom / scrollTop 字段
  v6.store.addStroke(mkStroke(1734), 0);
  await sleep(1300);
  const oldSaved: any = JSON.parse(files.get(op));
  pass(
    ("zoom" in oldSaved) === false && ("scrollTop" in oldSaved) === false,
    "P173⑦ 老文件保存后不凭空写默认视图字段：zoom 字段=" + ("zoom" in oldSaved) +
      "；scrollTop 字段=" + ("scrollTop" in oldSaved)
  );
  await v6.onClose();
  v6.containerEl.remove();
}

/* ==================== INK-176：文字索引四条修复 ==================== */

/**
 * 独立的内存 vault 桩：所有写/删/列表都记在 Map 里。
 * 故意做成可配置的（list / rmdir / 故障注入），四条修复都要靠它造边界。
 */
function makeIndexVault(opts: { withList?: boolean; unregistered?: boolean } = {}) {
  const disk = new Map<string, string>();
  const table = new Map<string, any>();
  const rmdirCalls: string[] = [];
  const withList = opts.withList !== false;
  const mk = (p: string, text: string) => {
    disk.set(p, text);
    table.set(p, { path: p, extension: p.split(".").pop() });
  };
  const adapter: any = {
    // 目录只要有子文件就算存在（真实适配器语义；桩里没有单独的目录条目）
    exists: async (p: string) =>
      disk.has(p) || Array.from(disk.keys()).some((k) => k.startsWith(p + "/")),
    read: async (p: string) => disk.get(p) ?? "",
    write: async (p: string, d: string) => void disk.set(p, d),
    mkdir: async (p: string) => void table.set(p, { path: p, type: "folder" }),
    remove: async (p: string) => {
      disk.delete(p);
      table.delete(p);
    },
    rmdir: async (p: string, recursive: boolean) => {
      rmdirCalls.push(p + (recursive ? " (recursive)" : ""));
      for (const k of Array.from(disk.keys())) if (k.startsWith(p + "/")) disk.delete(k);
      table.delete(p);
    },
    list: withList
      ? async (p: string) => ({
          files: Array.from(disk.keys()).filter((k) => k.startsWith(p + "/")),
          folders: [],
        })
      : undefined,
  };
  if (!withList) delete adapter.list;
  const vault: any = {
    adapter,
    getAbstractFileByPath: (p: string) => table.get(p) || null,
    createFolder: async (p: string) => {
      // 故障态：目录在磁盘上已存在，createFolder 抛「已存在」且不补登记
      if (opts.unregistered) throw new Error("Folder already exists.");
      table.set(p, { path: p, type: "folder" });
      return table.get(p);
    },
    create: async (p: string, d: string) => {
      mk(p, d);
      return table.get(p);
    },
    modify: async (f: any, d: string) => void disk.set(f.path, d),
    delete: async (f: any) => {
      disk.delete(f.path);
      table.delete(f.path);
    },
  };
  return { disk, table, adapter, vault, rmdirCalls, mk, app: { vault } as any };
}

function indexBook(texts: string[]): InkBook {
  const b = createBook("索引修复", "blank", "white");
  b.pages = texts.map((t) => {
    const p = createPage("blank", "white");
    p.texts = t ? [{ id: "t", source: "user", x: 10, y: 20, size: 14, text: t } as any] : [];
    return p;
  });
  return b;
}
const idxFile = (p: string) =>
  ({ path: p, basename: p.split("/").pop()!.replace(/\.inkbook$/i, ""), parent: { path: "" } } as any);

/** S1：改名竞态 —— remove 必须排在旧 key 的单飞链尾部 */
async function S1() {
  const v = makeIndexVault();
  const f = idxFile("旧名.inkbook");
  const book = indexBook(["旧内容"]);
  /*
   * 造出「旧链上还有一轮在途写入」：新文件走的是 vault.create，
   * 所以把闸门挂在那儿（挂 adapter.write 会拦不到，测试变成假绿）。
   */
  const origCreate = v.vault.create;
  const origDelete = v.vault.delete;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let writesDone = 0;
  let removeStartedAfterWrites = false;
  v.vault.create = async (p: string, d: string) => {
    await gate; // 在途窗口：这一轮已经进了链、但还没写第一个索引页
    const r = await origCreate(p, d);
    writesDone += 1;
    return r;
  };
  // 索引页已登记进文件表，removeIndexFile 走的是 vault.delete
  v.vault.delete = async (f: any) => {
    removeStartedAfterWrites = writesDone > 0;
    return origDelete(f);
  };
  const writing = writeTextIndex(v.app, f, book, { notify: false });
  // 在途写入还没结束时「改名」：remove 必须排在旧链的尾部
  const fNew = idxFile("新名.inkbook");
  const removing = removeTextIndex(v.app, fNew, "旧名.inkbook");
  release();
  await writing;
  await removing;
  const oldDir = "旧名.墨本索引/";
  const left = Array.from(v.disk.keys()).filter((k) => k.startsWith(oldDir));
  pass(writesDone > 0, "S1 改名竞态：在途写入确实跑完了（" + writesDone + " 次）");
  pass(
    removeStartedAfterWrites,
    "S1 改名竞态：删除发生在在途写入完成之后（排队生效，没抢跑）"
  );
  pass(
    left.length === 0,
    "S1 改名竞态：旧目录的索引页被删干净，不会被在途写入重建（残留 " + left.length + " 个）"
  );
  pass(
    !v.disk.has("旧名.墨本文字.md"),
    "S1 改名竞态：旧版单文件索引也一并清掉"
  );
}

/** S2：rmdir 前先 list 校验，目录里有外来文件就不敢删 */
async function S2() {
  // 造「磁盘上有目录，但文件表里没有」的故障态（createFolder 会抛已存在）
  const v = makeIndexVault({ unregistered: true });
  const dir = "外来文件.墨本索引";
  v.disk.set(dir, ""); // adapter.exists(dir) 要为真
  v.disk.set(dir + "/外来文件 · 第 1 页.md", "# 索引页");
  v.disk.set(dir + "/我的笔记.md", "用户自己放的内容，不能删");
  const before = notices.length;
  const ok = await writeTextIndex(v.app, idxFile("外来文件.inkbook"), indexBook(["字"]), { notify: false });
  pass(
    v.disk.has(dir + "/我的笔记.md"),
    "S2 rmdir 校验：目录里有不认识的文件时，用户文件没被删"
  );
  pass(v.rmdirCalls.length === 0, "S2 rmdir 校验：这种情况根本没调 rmdir（递归删除）");
  pass(notices.length > before, "S2 rmdir 校验：明确弹了提示，没有静默跳过");

  // 对照组：全是我们的命名 → 允许递归删掉重建
  const v2 = makeIndexVault({ unregistered: true });
  const dir2 = "纯索引.墨本索引";
  v2.disk.set(dir2, "");
  v2.disk.set(dir2 + "/纯索引 · 第 1 页.md", "# 索引页");
  v2.disk.set(dir2 + "/第 2 页.md", "# 旧命名索引页");
  await writeTextIndex(v2.app, idxFile("纯索引.inkbook"), indexBook(["字"]), { notify: false });
  pass(v2.rmdirCalls.length === 1, "S2 对照组：全是索引命名时照常 rmdir 重建");
  pass(isIndexPageFileName("纯索引 · 第 9 页.md"), "S2 命名识别：新命名算我们的索引文件");
  pass(isIndexPageFileName("第 3 页.md"), "S2 命名识别：旧命名也算我们的索引文件");
  pass(!isIndexPageFileName("我的笔记.md"), "S2 命名识别：外来文件不算");
  pass(isLegacyIndexPageName("第 3 页.md"), "S2 命名识别：isLegacyIndexPageName 与判据一致");
}

/** S3：缺 adapter.list 时按页码逐个探测删除 */
async function S3() {
  const v = makeIndexVault({ withList: false });
  const f = idxFile("无list.inkbook");
  const dir = "无list.墨本索引";
  // 3 页 → 只留 1 页有字，旧的 2/3 页索引必须被探测删掉
  const r1 = await writeTextIndex(v.app, f, indexBook(["甲", "乙", "丙"]), { notify: false });
  pass(r1.ok && r1.pages === 3, "S3 无 list：3 页都能写出索引");
  const r2 = await writeTextIndex(v.app, f, indexBook(["甲", "", ""]), { notify: false });
  pass(r2.ok && r2.pages === 1, "S3 无 list：第 2/3 页文字清空后只剩 1 个索引");
  pass(
    !v.disk.has(dir + "/无list · 第 2 页.md") && !v.disk.has(dir + "/无list · 第 3 页.md"),
    "S3 无 list：被清空的第 2/3 页旧索引页确实删掉了（全局搜索不会命中旧字）"
  );
  pass(v.disk.has(dir + "/无list · 第 1 页.md"), "S3 无 list：仍有文字的第 1 页没被误删");
  // 旧命名残留也要能探测删掉（页码在本子页数范围内）
  v.disk.set(dir + "/第 3 页.md", "# 旧命名残留");
  await writeTextIndex(v.app, f, indexBook(["甲"]), { notify: false });
  pass(!v.disk.has(dir + "/第 3 页.md"), "S3 无 list：旧命名残留页也被探测删掉");
}

/** S4：失败 Notice 节流按归一化 key，多本/多页失败不刷屏 */
async function S4() {
  const v = makeIndexVault();
  const before = notices.length;
  // 三本不同的本子、同样的 ENOSPC：文案各不相同（含本子名），但只该弹一次
  const bad = (name: string) => {
    // 两条写入路径都堵死：create 失败会退回 adapter.write，必须也抛才能走到失败 Notice
    v.vault.create = async () => {
      throw new Error("ENOSPC: no space left on device");
    };
    v.adapter.write = async () => {
      throw new Error("ENOSPC: no space left on device");
    };
    return writeTextIndex(v.app, idxFile(name + ".inkbook"), indexBook(["字"]));
  };
  const r1 = await bad("甲本");
  const r2 = await bad("乙本");
  const r3 = await bad("丙本");
  const emitted = notices.slice(before).filter((n) => n.includes("文字索引生成失败"));
  pass(!r1.ok && !r2.ok && !r3.ok, "S4 节流：三本索引都失败了");
  pass(emitted.length === 1, "S4 节流：同类错误（不同本子名）60 秒内只弹 1 条（实际 " + emitted.length + " 条）");
  pass(
    emitted[0]?.includes("甲本") && emitted[0]?.includes("ENOSPC"),
    "S4 节流：提示里仍保留本子名与原始错误，便于排查"
  );
}

/* ==================== INK-178：撤销/重做两条加固 ==================== */

/**
 * U1：目标页已不存在时，撤销**不能**把内容写到别的页上。
 *
 * 老实现 `pageIndexOf` 找不到 pageId 就退回 `entry.pageIndex`（当时的下标），
 * 页被删/挪之后它指向的是**另一页**——撤销会把 A 页的内容写到 B 页上。
 * 正常 LIFO 顺序走不到，但历史被裁（MAX_HISTORY）或将来引入非线性历史
 * 就会撞上。现在改成返回 -1，apply 直接跳过这一步。
 */
async function U1() {
  const { BookStore } = await import("../src/store");
  const { createBook, createPage } = await import("../src/types");
  const book = createBook("撤销加固", "grid", "white");
  while (book.pages.length < 3) book.pages.push(createPage("grid", "white"));
  const store: any = new BookStore(book);

  const targetId = book.pages[2].id;
  const beforeText = book.pages[2].texts;
  // 手工造一条「指向已删页」的 page 历史
  book.pages.splice(2, 1); // 第 3 页没了
  const ghostEntry = {
    kind: "page" as const,
    pageId: targetId,
    pageIndex: 2, // 老实现会用它兜底 → 指向现在的第 3 页（越界夹到第 2 页）
    data: JSON.stringify({ ...createPage("grid", "white"), id: targetId, texts: beforeText }),
  };
  const snapshotB = JSON.stringify(book.pages[1]);
  store.undoStack.push({ before: ghostEntry, after: ghostEntry });
  const ok = store.undo();

  pass(
    JSON.stringify(book.pages[1]) === snapshotB,
    "U1 目标页已删：撤销不把内容写到相邻页上（第 2 页未被改动）"
  );
  pass(
    book.pages.every((p: any) => p && p.id),
    "U1 目标页已删：页数组里没有 null/undefined 空洞（页数 " + book.pages.length + "）"
  );
  pass(
    ok === true && book.activePage >= 0 && book.activePage < book.pages.length,
    "U1 目标页已删：activePage 仍在合法范围内（" + book.activePage + "/" + book.pages.length + "）"
  );
}

/**
 * U2：positions 里的非法值（负数 / NaN）按「追加到末尾」处理，不乱序。
 *
 * 老注释写「-1 = 追加到末尾」，但实现会把它 sort 到最前 → `B,C,A`。
 * 现在 apply 侧统一把非法值当 Infinity（追加）。
 */
async function U2() {
  const { BookStore } = await import("../src/store");
  const { createBook, createPage } = await import("../src/types");
  const book = createBook("positions 加固", "grid", "white");
  const page = book.pages[0];
  const store: any = new BookStore(book);

  const mk = (id: string): any => ({
    id,
    tool: "pen",
    color: "#000",
    size: 2.8,
    opacity: 1,
    points: [[0, 0, 0.5]],
  });
  const A = mk("A"), B = mk("B"), C = mk("C");
  page.layers[0].strokes = [];

  const entry = (strokes: any[], positions: number[]) => ({
    kind: "layer" as const,
    pageId: page.id,
    pageIndex: 0,
    layerId: page.layers[0].id,
    strokes,
    positions,
  });

  // 全 -1：老实现给 B,C,A，现在应该按原顺序 A,B,C
  store.apply(entry([A, B, C], [-1, -1, -1]));
  const got1 = page.layers[0].strokes.map((s: any) => s.id).join(",");
  pass(got1 === "A,B,C", "U2 positions 全 -1 按追加处理（实际 " + got1 + "，期望 A,B,C）");

  // NaN 混在中间
  store.apply(entry([A, B, C], [0, NaN, 1]));
  const got2 = page.layers[0].strokes.map((s: any) => s.id).join(",");
  pass(
    got2 === "A,C,B",
    "U2 positions 含 NaN 当追加（实际 " + got2 + "，期望 A,C,B：A 在 0、C 在 1、B 追加）"
  );

  // 正常顺序仍然是 A,B,C
  store.apply(entry([A, B, C], [0, 1, 2]));
  const got3 = page.layers[0].strokes.map((s: any) => s.id).join(",");
  pass(got3 === "A,B,C", "U2 正常 positions 不受影响（实际 " + got3 + "）");
}

/**
 * V：打开非 .inkbook 文件**绝不能**把本子内容写到那个文件里（INK-184）。
 *
 * 真实现场（2026-11-07）：用户导出 PDF 后点开成品，宿主用那个 .pdf 调
 * `onLoadFile`。老代码先 `this.file = pdf` 再判扩展名 → 返回时 `this.file`
 * 还是那个 .pdf，而 `bookPath` 已被 `onUnloadFile` 清成 null →
 * 下一次 `saveNow` 取 `this.bookPath || this.file.path` 拿到 **.pdf 路径**，
 * 把整本 JSON 写了进去。结果：导出的 7MB PDF 变成 128KB 的 JSON，
 * 用户「PDF 打不开」；真正的 PDF 被挤进 `.pdf.bak`。
 */
async function V184() {
  const p = "V184.inkbook";
  const pdfPath = "V184-手写本.pdf";
  seed(p, JSON.stringify(mkBook("V184本", 3, 2)));
  const pdfContent = "%PDF-1.7\n假 PDF 内容\n%%EOF";
  seed(pdfPath, pdfContent);

  const v = await openView();
  await v.onLoadFile(tf(p));
  await sleep(400);
  const before = v.store.strokeCount;
  v.store.addStroke(mkStroke(1841), 0);

  // 模拟「导出后点开成品」：宿主先卸载，再用 .pdf 调 onLoadFile
  await v.onUnloadFile();
  await v.onLoadFile(tf(pdfPath));
  await sleep(300);

  // 这时视图里不该还挂着那个 pdf
  pass(
    v.file === null,
    "V184① 打开非 .inkbook 后不把该文件留在 this.file 上（file=" +
      (v.file ? v.file.path : "null") + "）"
  );

  // 落一笔 + 触发保存：绝不能写到 pdf 上
  if (v.store) v.store.addStroke(mkStroke(1842), 0);
  await v.saveNow();
  await sleep(200);

  pass(
    files.get(pdfPath) === pdfContent,
    "V184② 导出的 PDF 内容一字未变（" + (files.get(pdfPath) === pdfContent ? "完好" : "被覆盖！") + "）"
  );

  // 重新打开真正的本子，数据还在
  await v.onLoadFile(tf(p));
  await sleep(400);
  pass(
    !!v.store && v.store.strokeCount === before + 1,
    "V184③ 重新打开本子内容完好（笔迹 " + (v.store ? v.store.strokeCount : -1) +
      "，期望 " + (before + 1) + "）"
  );
  await v.onClose();
  v.containerEl.remove();
}

/**
 * W：`saveNow` 自身拒绝往非 .inkbook 路径写（INK-184 第二道防线）。
 */
async function W184() {
  const p = "W184.inkbook";
  seed(p, JSON.stringify(mkBook("W184本", 2, 1)));
  const v = await openView();
  await v.onLoadFile(tf(p));
  await sleep(400);

  const t0 = calls.length;
  // 直接把 bookPath 和 file 都改成 pdf，模拟上游漏改的最坏情况
  (v as any).bookPath = "W184.pdf";
  (v as any).file = tf("W184.pdf");
  v.store.addStroke(mkStroke(1843), 0);
  await v.saveNow();
  await sleep(150);

  const wrotePdf = since(t0).some(
    (c) => c.path === "W184.pdf" || c.newPath === "W184.pdf"
  );
  pass(!wrotePdf, "W184 saveNow 拒绝往非 .inkbook 路径写盘（写 pdf=" + wrotePdf + "）");
  pass(
    files.get(p) !== undefined,
    "W184 原 .inkbook 文件仍在（未被误删）"
  );
  v.containerEl.remove();
}

const CASES: Array<[string, () => Promise<void>]> = [
  ["A1+A2", A12],
  ["A3", A3],
  ["A4", A4],
  ["B5+B6+B7", B],
  ["C8", C8],
  ["C9", C9],
  ["C9b", C9b],
  ["C10", C10],
  ["C11", C11],
  ["D12", D12],
  ["E13", E13],
  ["E1 dropBook 边界", E1],
  ["G bak 限频", G],
  ["H 只读态侧栏改动", H],
  ["I recovered 副本覆盖", I],
  ["J 页序重排", J],
  ["K 本子目录", K],
  ["F14", F14],
  ["L167 保存中切本子", L167],
  ["M168 按着笔关标签页", M168],
  ["N169 保存失败切本子", N169],
  ["O170 写盘回退/备份提示", O170],
  ["P173 缩放/滚动恢复", P173],
  ["Q174 改名后写新路径", Q174],
  ["R174 抢救标记不吞第二次", R174],
  ["S1 改名竞态 remove 入链", S1],
  ["S2 rmdir 递归删校验", S2],
  ["S3 无 list 探测删旧页", S3],
  ["S4 索引失败 Notice 节流", S4],
  ["U1 撤销不写错页", U1],
  ["U2 positions 非法值", U2],
  ["V184 打开非 inkbook 不写错文件", V184],
  ["W184 saveNow 拒绝非 inkbook 路径", W184],
  ["T1 设置数值校验", T1],
  ["T2 外部设置变更", T2],
  ["T3 存档防 NaN", T3],
  ["T4 syncSettings 与自动保存", T4],
];

async function main() {
  for (const [name, fn] of CASES) {
    log("--- " + name + " ---");
    try {
      await fn();
    } catch (e: any) {
      log("FAIL " + name + " 用例内部抛异常：" + (e?.stack || e));
    }
  }
  log("SUMMARY PASS=" + tally.pass + " FAIL=" + tally.fail + " KNOWN=" + tally.known);
  log("DONE");
  document.title = "DONE";
}

main().catch((e) => {
  log("FATAL " + (e?.stack || e));
  document.title = "FATAL";
});
