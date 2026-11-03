/**
 * QA 独立验证（INK-105）——**集成层**：main.ts 的真实接线。
 *
 * 现有 plugin-harness 只验 onload 不炸，dist-harness 只验包里有桩；
 * 两边都没验「onload 之后后处理器真的注册了」以及「vault 的
 * modify / rename / delete 真的把嵌入缓存清掉了」。这两件事是纯接线，
 * 单元测试（embed-harness）看不到，但用户在真机上最先遇到的就是它们。
 *
 * 这里直接 new 真插件、跑真 onload、拿真 postprocessor、发真事件。
 */
import InkbookPlugin from "../src/main";
import { embedCacheStats, invalidateEmbedCache } from "../src/embed";
import { TFile } from "obsidian";
import { createPage, type InkBook, type Stroke } from "../src/types";

const lines: string[] = [];
const out = document.getElementById("out")!;
const log = (s: string) => {
  lines.push(s);
  out.textContent = lines.join("\n");
};
let checks = 0;
let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  checks += 1;
  if (!ok) failures += 1;
  log((ok ? "PASS " : "FAIL ") + label + (detail ? "  ← " + detail : ""));
};
const num = (k: string, v: string) => log("  · " + k + " = " + v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 8000): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(40);
  }
  return pred();
}

const uncaught: string[] = [];
window.addEventListener("error", (e) => uncaught.push("error: " + e.message));
window.addEventListener("unhandledrejection", (e) =>
  uncaught.push("reject: " + ((e as any).reason?.stack || (e as any).reason))
);

/* ------------------------- 假库 ------------------------- */

function makeBook(): InkBook {
  const page = createPage("blank", "white");
  const stroke: Stroke = {
    id: "s1",
    tool: "pen",
    color: "#1A1A1A",
    size: 9,
    opacity: 1,
    points: [
      [80, 160, 0.6],
      [300, 200, 0.7],
      [520, 320, 0.8],
    ],
  };
  page.layers[0].strokes.push(stroke);
  return {
    version: 2,
    kind: "inkbook",
    title: "集成本",
    width: 794,
    height: 1123,
    created: 1,
    updated: 1,
    activePage: 0,
    pages: [page, createPage("lined", "white")],
  };
}

const BOOK_PATH = "笔记/集成本.inkbook";
const files: Record<string, string> = { [BOOK_PATH]: JSON.stringify(makeBook()) };
const reads: Record<string, number> = {};

const bookFile = new TFile();
Object.assign(bookFile, {
  path: BOOK_PATH,
  basename: "集成本",
  extension: "inkbook",
  stat: { mtime: 111 },
});

const handlers: Record<string, Array<(...a: any[]) => void>> = {};
const vaultOn = (name: string, cb: (...a: any[]) => void) => {
  (handlers[name] = handlers[name] || []).push(cb);
  return { unsubscribe() {} };
};
const emit = (name: string, ...args: any[]) => {
  for (const h of handlers[name] || []) h(...args);
};

const openedFiles: any[] = [];

const wsProto: any = { trigger() {} };
const workspace: any = Object.create(wsProto);
Object.assign(workspace, {
  on: () => ({}),
  onLayoutReady: (cb: () => void) => setTimeout(cb, 0),
  getLeaf: () => ({
    openFile: async (f: any) => {
      openedFiles.push(f);
    },
    setViewState: async () => {},
    view: {},
  }),
  getActiveFile: () => null,
  getActiveViewOfType: () => null,
  getLeavesOfType: () => [],
});

const adapter = {
  exists: async (p: string) => Object.prototype.hasOwnProperty.call(files, p),
  read: async (p: string) => {
    reads[p] = (reads[p] || 0) + 1;
    return files[p] ?? "";
  },
  write: async () => {},
  mkdir: async () => {},
  writeBinary: async () => {},
  readBinary: async () => new ArrayBuffer(0),
  getFullPath: (p: string) => p,
  getResourcePath: (p: string) => p,
};

const app: any = {
  commands: { executeCommandById: () => true },
  viewRegistry: { typeByExtension: { pdf: "pdf", md: "markdown" }, trigger() {} },
  vault: {
    adapter,
    on: vaultOn,
    getFiles: () => [bookFile],
    getAbstractFileByPath: (p: string) => (p === BOOK_PATH ? bookFile : null),
  },
  metadataCache: {
    getFirstLinkpathDest: (linktext: string) => (linktext === BOOK_PATH ? bookFile : null),
  },
  workspace,
};

const manifest = { id: "inkbook", name: "墨本", version: "0.1.0", dir: ".obsidian/plugins/inkbook" };

async function main() {
  try {
    invalidateEmbedCache();
    const plugin: any = new InkbookPlugin(app, manifest);
    await plugin.onload();
    check(true, "真插件 onload 不抛错");

    /* ---------- 1. onload 真的把 postprocessor 注册进宿主 ---------- */
    const pps: Array<(el: HTMLElement, ctx: any) => void> =
      (window as any).__markdownPostProcessors || [];
    check(pps.length === 1, "onload 向宿主注册了 1 个 markdown postprocessor", "实际 " + pps.length);
    num("vault.on 注册的事件", Object.keys(handlers).join(",") || "(无)");
    check(
      ["modify", "delete", "rename"].every((n) => (handlers[n] || []).length === 1),
      "modify / delete / rename 三个事件各挂了 1 个处理函数",
      ["modify", "delete", "rename"].map((n) => n + "=" + (handlers[n] || []).length).join(" ")
    );

    /* ---------- 2. 真 postprocessor 能把一个 .inkbook 渲染出来 ---------- */
    const host = document.getElementById("pp")!;
    host.innerHTML = "";
    const node = document.createElement("div");
    node.className = "internal-embed";
    node.setAttribute("src", BOOK_PATH);
    host.appendChild(node);
    pps[0](host, { sourcePath: "笔记/入口.md" });
    const painted = await waitFor(() => !!host.querySelector(".mb-embed-canvas"));
    check(painted, "真回调渲染出位图");
    const canvas = host.querySelector(".mb-embed-canvas") as HTMLCanvasElement | null;
    check(canvas?.dataset.page === "1", "默认第 1 页", String(canvas?.dataset.page));
    const st1 = embedCacheStats();
    num("渲染后缓存", JSON.stringify(st1));
    check(st1.bitmaps === 1 && st1.books === 1, "渲染后位图 + 书各 1 条", JSON.stringify(st1));

    /* ---------- 3. 点击 → 插件真方法 openBookAt → 真 openFile ---------- */
    const calls: Array<[string, number]> = [];
    const orig = plugin.openBookAt.bind(plugin);
    plugin.openBookAt = async (p: string, pg: number) => {
      calls.push([p, pg]);
      return orig(p, pg);
    };
    (host.querySelector(".mb-embed") as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
    await waitFor(() => calls.length > 0, 3000);
    check(calls.length === 1 && calls[0][0] === BOOK_PATH, "点击调进插件的 openBookAt", JSON.stringify(calls[0] || null));
    check(openedFiles.length === 1 && openedFiles[0] === bookFile, "openBookAt 落到 workspace.getLeaf().openFile", "openFile 次数 " + openedFiles.length);

    /* ---------- 4. vault modify 清缓存 ---------- */
    emit("modify", bookFile);
    const st2 = embedCacheStats();
    check(st2.bitmaps === 0 && st2.books === 0, "本子 modify → 嵌入缓存清空", JSON.stringify(st2));

    /* ---------- 5. 非 .inkbook 的 modify 不该清 ---------- */
    pps[0](host, { sourcePath: "笔记/入口.md" }); // 已被 mb-embed-done 标记，不会重挂
    const fresh = document.createElement("div");
    fresh.innerHTML = "";
    const n2 = document.createElement("div");
    n2.className = "internal-embed";
    n2.setAttribute("src", BOOK_PATH + "#2");
    fresh.appendChild(n2);
    host.appendChild(fresh);
    pps[0](host, { sourcePath: "笔记/入口.md" });
    await waitFor(() => !!fresh.querySelector(".mb-embed-canvas"));
    const st3 = embedCacheStats();
    const mdFile = new TFile();
    Object.assign(mdFile, { path: "笔记/某个.md", basename: "某个", extension: "md", stat: { mtime: 1 } });
    emit("modify", mdFile);
    const st4 = embedCacheStats();
    check(st4.bitmaps === st3.bitmaps, "普通 .md 改动不动嵌入缓存", `${st3.bitmaps} → ${st4.bitmaps}`);

    /* ---------- 6. rename：旧路径的条目要丢 ---------- */
    emit("rename", bookFile, "笔记/老名字.inkbook");
    const st5 = embedCacheStats();
    check(st5.bitmaps === 0, "rename 后旧路径缓存被丢弃", JSON.stringify(st5));

    /* ---------- 7. delete ---------- */
    pps[0](document.body, { sourcePath: "x.md" }); // 不影响已挂的块
    emit("delete", bookFile);
    check(embedCacheStats().bitmaps === 0, "delete 后缓存为空", JSON.stringify(embedCacheStats()));

    /* ---------- 8. onunload 清理 ---------- */
    pps[0](host, { sourcePath: "笔记/入口.md" });
    await waitFor(() => !!host.querySelectorAll(".mb-embed-canvas").length);
    let unloadErr = "";
    try {
      plugin.onunload();
    } catch (e: any) {
      unloadErr = String(e?.stack || e);
    }
    check(!unloadErr, "onunload 不抛错", unloadErr || "ok");
    const st6 = embedCacheStats();
    check(st6.bitmaps === 0 && st6.books === 0 && st6.bytes === 0, "onunload 后缓存全清", JSON.stringify(st6));
    check(
      !(wsProto.trigger as any).__inkbookPatched,
      "onunload 后 swipe 原型补丁已还原"
    );

    check(uncaught.length === 0, "全程无未捕获异常", uncaught.slice(0, 2).join(" | ") || "ok");
    num("readBook 次数（同一本）", String(reads[BOOK_PATH] || 0));
  } catch (e: any) {
    log("FATAL " + (e?.stack || e));
    document.title = "FATAL";
    return;
  }
  log("");
  log(`合计 ${checks} 项，失败 ${failures} 项`);
  log(failures === 0 ? "ALL PASS" : failures + " FAILED");
  document.title = "DONE";
}

main();
