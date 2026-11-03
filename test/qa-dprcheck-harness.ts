/**
 * QA 复核（INK-105 第三轮）——**dpr 下显示宽的量测页**。
 *
 * 背景：R1 把上限从 CSS px 换成设备像素预算以后，`clampEmbedWidth` 在 dpr>1
 * 时把宽度夹到 840；而 `renderEmbedPage` 是 `canvas.style.width = cssW + "px"`，
 * 夹的是 CSS 宽度，不只是 backing store——**显示尺寸也跟着变小了**。
 * 在 1200px 宽的栏里，dpr=2 的嵌入图右边会空出 359px。
 *
 * 修法：显示宽与位图宽拆开（`embedDisplayWidth` / `clampEmbedWidth`）。
 * 这一页现在用来**复测**：显示宽那一列应当铺满栏宽，出现 840 就是回退复发。
 */
import InkbookPlugin from "../src/main";
import {
  clampEmbedWidth,
  embedDisplayWidth,
  embedDpr,
  invalidateEmbedCache,
  maxCssWidthForDpr,
} from "../src/embed";
import { TFile } from "obsidian";
import { createBook, createPage, type InkBook } from "../src/types";

const lines: string[] = [];
const out = document.getElementById("out")!;
const log = (s: string) => {
  lines.push(s);
  out.textContent = lines.join("\n");
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 20000): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(30);
  }
  return pred();
}

function makeBook(): InkBook {
  const b = createBook("量测本", "blank", "white");
  b.pages = [createPage("blank", "white")];
  return b;
}

const P = "量测.inkbook";
const json = JSON.stringify(makeBook());
const file: any = new TFile();
Object.assign(file, { path: P, basename: "量测", extension: "inkbook", stat: { mtime: 1 } });

const app: any = {
  commands: { executeCommandById: () => true },
  viewRegistry: { typeByExtension: {}, trigger() {} },
  vault: {
    adapter: {
      exists: async () => true,
      read: async () => json,
      write: async () => {},
      mkdir: async () => {},
      writeBinary: async () => {},
      readBinary: async () => new ArrayBuffer(0),
      getResourcePath: (p: string) => p,
    },
    on: () => ({}),
    getFiles: () => [file],
    getAbstractFileByPath: (p: string) => (p === P ? file : null),
  },
  metadataCache: { getFirstLinkpathDest: () => file },
  workspace: {
    on: () => ({}),
    onLayoutReady: (cb: () => void) => setTimeout(cb, 0),
    getLeaf: () => ({ openFile: async () => {}, setViewState: async () => {}, view: {} }),
    getActiveFile: () => null,
    getActiveViewOfType: () => null,
    getLeavesOfType: () => [],
    trigger() {},
  },
};

async function main() {
  const dpr = embedDpr();
  const ceiling = dpr <= 1 ? 2000 : Math.min(2000, maxCssWidthForDpr(dpr));
  log(`dpr(embedDpr) = ${dpr}，生效上限 ${ceiling}px，maxCssWidthForDpr=${maxCssWidthForDpr(dpr)}`);

  invalidateEmbedCache();
  const plugin: any = new InkbookPlugin(app, { id: "inkbook", name: "墨本", version: "0.1.0", dir: ".obsidian/plugins/inkbook" });
  await plugin.onload();
  const pp = ((window as any).__markdownPostProcessors || [])[0] as (el: HTMLElement, ctx: any) => void;

  const host = document.getElementById("wide-host")!;
  const cases: Array<{ key: string; src: string; req: number }> = [
    { key: "不写宽度", src: P, req: 1198 }, // 栏宽 1200 − 2px 边框
    { key: "|2000", src: `${P}|2000`, req: 2000 },
    { key: "|1200", src: `${P}|1200`, req: 1200 },
    { key: "|700", src: `${P}|700`, req: 700 },
  ];
  const cells: Record<string, HTMLElement> = {};
  for (const c of cases) {
    const cell = document.createElement("div");
    cell.className = "case";
    const node = document.createElement("div");
    node.className = "internal-embed";
    node.setAttribute("src", c.src);
    cell.appendChild(node);
    host.appendChild(cell);
    cells[c.key] = cell;
  }
  pp(host, { sourcePath: "笔记/x.md" });
  const ready = await waitFor(() => host.querySelectorAll(".mb-embed-canvas").length >= cases.length);
  log(`渲染完成：${ready}（${host.querySelectorAll(".mb-embed-canvas").length} 张 canvas）`);
  await sleep(300);

  log("");
  log("栏宽(host clientWidth) = " + host.clientWidth);
  log("写法        期望显示宽  style.width  实际显示宽   栏内右侧空隙  backing(位图)");
  for (const c of cases) {
    const cell = cells[c.key];
    const cont = cell.querySelector(".mb-embed") as HTMLElement | null;
    const cv = cell.querySelector(".mb-embed-canvas") as HTMLCanvasElement | null;
    if (!cont || !cv) {
      log(`${c.key}  → 没渲染出来`);
      continue;
    }
    /*
     * 两种期望值现在**分开**了（这一页原本就是量它们被混在一起的那个回退）：
     *   · 位图宽 clampEmbedWidth(...) —— 受设备像素预算，dpr=2 时 840；
     *   · 显示宽 embedDisplayWidth(...) —— 只受 MAX_EMBED_WIDTH，不折 dpr。
     * 显示宽那一列现在应当铺满栏宽；如果是 840，说明回退又回来了。
     */
    const wantBitmap = clampEmbedWidth(c.req, 600, dpr);
    const wantDisplay = embedDisplayWidth(c.req, 600);
    const shown = cv.getBoundingClientRect().width;
    const gap = cont.getBoundingClientRect().right - cv.getBoundingClientRect().right;
    log(
      `${c.key.padEnd(10)} ${String(wantDisplay).padStart(10)} ` +
        `${String(cv.style.width).padStart(12)} ${shown.toFixed(1).padStart(12)} ` +
        `${gap.toFixed(1).padStart(11)}  ${cv.width}×${cv.height}` +
        `（位图 CSS 宽 ${wantBitmap}，backing 宽 / dpr = ${Math.round(cv.width / dpr)}）`
    );
  }
  log("");
  log("说明：显示宽 = canvas.style.width（被 max-width:100% 再压一次到栏宽）；");
  log("      位图宽按设备像素预算夹（dpr=2 → 840），显示宽不折 dpr → 宽栏里不再留白。");
  document.title = "DONE";
}

main().catch((e) => {
  log("FATAL " + (e?.stack || e));
  document.title = "FATAL";
});
