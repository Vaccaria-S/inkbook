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
import { InkbookView } from "../src/view";
import { createBook, createPage, DEFAULT_SETTINGS, type InkBook, type Stroke } from "../src/types";

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

const adapter = {
  stat: async (p: string) =>
    files.has(p) ? { mtime: mt.get(p)!, size: blen(files.get(p)) } : null,
  exists: async (p: string) => files.has(p),
  read: async (p: string) => {
    if (!files.has(p)) throw new Error("ENOENT " + p);
    return files.get(p);
  },
  write: async (p: string, d: any) => {
    files.set(p, d);
    mt.set(p, bumpMt());
    calls.push({ kind: "write", path: p, bytes: blen(d), t: performance.now() - T0 });
  },
  rename: async (o: string, n: string) => {
    if (!files.has(o)) throw new Error("ENOENT " + o);
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

/** C8：version 2 拒开，且不写盘 */
async function C8() {
  const p = "C8.inkbook";
  const b: any = mkBook("C8本", 3, 2);
  b.version = 2;
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

/** 在纸面上真实落一笔（走 pointer 事件，和用户手写同一条路径） */
function drawOnPage(v: any, pageIdx = 0): boolean {
  const pageEl = v.contentEl.querySelectorAll(".mb-page")[pageIdx] as HTMLElement;
  if (!pageEl) return false;
  const r = pageEl.getBoundingClientRect();
  const k = r.width / 794 || 1;
  const pe = (type: string, x: number, y: number, buttons: number) =>
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
  pageEl.dispatchEvent(pe("pointerdown", 100, 200, 1));
  for (let i = 1; i <= 12; i++) pageEl.dispatchEvent(pe("pointermove", 100 + i * 12, 200 + i * 3, 1));
  pageEl.dispatchEvent(pe("pointerup", 244, 236, 0));
  return true;
}

/** C9：version 2 + 合法 .bak → 不许被备份接住，必须如实报「请升级」 */
async function C9() {
  const p = "C9.inkbook";
  const b2: any = mkBook("C9本", 2, 1);
  b2.version = 2;
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
  pass(typeof saved?.version === "number" && saved.version === 1, "D12 version 是 number 且=1：" + JSON.stringify(saved?.version));
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
  ["F14", F14],
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
