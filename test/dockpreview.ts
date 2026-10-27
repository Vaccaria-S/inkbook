/**
 * 控制坞外观预览页。
 *
 * 用真实的 InkbookView 渲染，分别在「电脑」和「平板」两种尺寸下截图，
 * 用来肉眼检查面板的排版、间距、层次和触摸目标尺寸。
 *
 * 这不是断言测试，是给人看的。
 */
import { InkbookView } from "../src/view";
import { createBook, createPage, DEFAULT_SETTINGS, type Pt } from "../src/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const params = new URLSearchParams(location.search);
const MODE = params.get("mode") || "desktop";
const TAB = params.get("tab") || "pen";
const OPEN = params.get("open") !== "0";

function bez(a: Pt[], b: Pt[], c: Pt[], d: Pt[], n = 120): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
      u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
      0.2 + 0.7 * Math.sin(Math.PI * t),
    ]);
  }
  return out;
}

const files = new Map<string, string>();
function mkFile(path: string, text: string) {
  const f = {
    path,
    basename: path.split("/").pop()!.replace(/\.[^.]+$/, ""),
    extension: path.split(".").pop()!,
    parent: { path: path.includes("/") ? path.slice(0, path.lastIndex("/")) : "/" },
  };
  files.set(path, text);
  return f;
}

function makeBook(pages = 3) {
  const book = createBook();
  book.pages = [];
  for (let i = 0; i < pages; i++) {
    const p = createPage("grid", "white");
    if (i === 0) {
      const curve = bez([95, 220], [260, 90], [470, 350], [695, 200], 200);
      const sig = bez([110, 620], [260, 540], [400, 700], [690, 580], 200);
      const hl: Pt[] = [];
      for (let k = 0; k < 70; k++) hl.push([105 + k * 8, 330, 0.5]);
      p.layers[0].strokes = [
        { id: "s1", tool: "pen", color: "#1A1A1A", size: 3.4, opacity: 1, points: curve },
        { id: "s2", tool: "pen", color: "#1F5FBF", size: 2.8, opacity: 1, points: sig },
        { id: "s3", tool: "highlighter", color: "#F6E05E", size: 26, opacity: 0.32, points: hl },
      ];
    }
    book.pages.push(p);
  }
  return book;
}

(async () => {
  const adapter = {
    exists: async (p: string) => files.has(p),
    read: async (p: string) => files.get(p),
    write: async (p: string, d: string) => void files.set(p, d),
    writeBinary: async (p: string, d: any) => void files.set(p, d),
    mkdir: async () => {},
  };
  const app: any = {
    vault: {
      adapter,
      getFiles: () => [],
      getAbstractFileByPath: () => null,
    },
    workspace: {
      getLeavesOfType: () => [],
      getActiveViewOfType: () => null,
      on: () => {},
    },
  };

  const plugin: any = {
    settings: { ...DEFAULT_SETTINGS },
    saveSettings: async () => {},
    refreshViews: () => {},
    app,
  };

  const view: any = new InkbookView({ app, view: {} }, plugin);
  view.app = app;

  const host = document.getElementById("view-host")!;
  host.appendChild(view.contentEl);
  await view.onOpen();

  const book = makeBook(4);
  const file = mkFile("预览.inkbook", JSON.stringify(book));
  await view.onLoadFile(file);
  await sleep(900);

  // 强制成需要的设备形态
  const root = view.contentEl as HTMLElement;
  root.classList.toggle("is-tablet", MODE === "tablet");
  if (params.get("theme") === "dark") document.body.classList.add("dark");

  // 指定侧栏开合状态
  const v = view as any;
  if (typeof v.toggleSide === "function" && !OPEN) v.toggleSide();
  if (params.get("reading") === "1" && typeof v.setReading === "function") {
    v.setReading(true);
  }
  await sleep(600);

  document.body.setAttribute("data-ready", "1");
})();
