import { BookEditor } from "../src/editor";
import { BookStore } from "../src/store";
import { createBook, createPage, PEN_COLORS, type Pt, type Stroke } from "../src/types";

function mkStroke(
  tool: Stroke["tool"],
  color: string,
  size: number,
  points: Pt[],
  opacity = 1
): Stroke {
  return {
    id: Math.random().toString(36).slice(2),
    tool,
    color,
    size,
    opacity,
    points,
  };
}

function bezier(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
  n = 160,
  press: (t: number) => number = (t) => 0.18 + 0.78 * Math.pow(Math.sin(Math.PI * t), 0.55)
): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const x = u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0];
    const y = u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1];
    out.push([x, y, press(t)]);
  }
  return out;
}

function loops(): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= 260; i++) {
    const t = i / 260;
    const x = 110 + t * 560;
    const y = 420 + Math.sin(t * Math.PI * 7) * (52 - t * 12);
    const p = 0.22 + 0.7 * Math.abs(Math.sin(t * Math.PI * 3.5));
    out.push([x, y, p]);
  }
  return out;
}

function signature(): Pt[] {
  const out: Pt[] = [];
  const p = [
    [120, 640] as [number, number],
    [170, 530] as [number, number],
    [250, 720] as [number, number],
    [360, 560] as [number, number],
    [470, 690] as [number, number],
    [620, 600] as [number, number],
  ];
  for (let i = 0; i < p.length - 1; i++) {
    const seg = bezier(p[i], [p[i][0] + 40, p[i][1] - 80], [p[i + 1][0] - 40, p[i + 1][1] + 80], p[i + 1], 46, (t) => {
      const into = i / (p.length - 1);
      const base = 0.35 + 0.5 * Math.sin((into + t / (p.length - 1)) * Math.PI);
      return 0.16 + base * 0.7;
    });
    out.push(...seg);
  }
  return out;
}

const app = document.getElementById("app")!;

const book = createBook("墨本 · 手感测试", "grid", "white");
book.pages[0].layers[0].strokes.push(
  mkStroke("pen", "#1A1A1A", 3.2, bezier([100, 230], [260, 90], [480, 360], [690, 210], 220)),
  mkStroke("pen", "#1F5FBF", 2.6, loops()),
  mkStroke("pen", "#D64545", 2.2, signature()),
  mkStroke("pen", "#2E8B57", 1.6, bezier([110, 780], [300, 760], [420, 800], [690, 770], 120, () => 0.22)),
  mkStroke("highlighter", "#F6E05E", 26, [
    [105, 300, 0.5],
    [420, 302, 0.5],
    [690, 300, 0.5],
  ], 0.42)
);
book.pages[0].layers[0].strokes.push(
  mkStroke("shape", "#7C5CD6", 1.8, [
    [500, 840, 0.5],
    [700, 960, 0.5],
  ])
);
book.pages.push(createPage("lined", "cream"));
book.pages[1].layers[0].strokes.push(
  mkStroke("pen", "#1A1A1A", 2.8, bezier([110, 260], [260, 160], [430, 380], [680, 240], 180))
);

const store = new BookStore(book);
let editor: BookEditor;
editor = new BookEditor(app, store, {
  penOnly: false,
  pressure: 1,
  onState: () => sync(),
  onChange: () => {},
  onPageChange: () => sync(),
});
const toolBtns: Record<string, HTMLElement> = {
  pen: document.getElementById("t-pen")!,
  ballpoint: document.getElementById("t-ball")!,
  highlighter: document.getElementById("t-hl")!,
  eraser: document.getElementById("t-eraser")!,
  lasso: document.getElementById("t-lasso")!,
  shape: document.getElementById("t-shape")!,
  hand: document.getElementById("t-hand")!,
};
for (const [tool, btn] of Object.entries(toolBtns)) {
  btn.addEventListener("click", () => editor.setTool(tool as any));
}

const colorsEl = document.getElementById("colors")!;
for (const c of PEN_COLORS) {
  const s = document.createElement("div");
  s.className = "mb-swatch";
  s.style.background = c;
  s.title = c;
  s.dataset.color = c;
  s.addEventListener("click", () => {
    editor.setTool("pen");
    editor.setPenColor(c);
    sync();
  });
  colorsEl.appendChild(s);
}

const sizeEl = document.getElementById("size") as HTMLInputElement;
const sizeLbl = document.getElementById("size-lbl")!;
sizeEl.addEventListener("input", () => {
  const v = Number(sizeEl.value);
  if (editor.getState().tool === "highlighter") editor.setHighlighterSize(v, true);
  else editor.setPenSize(v, true);
  sizeLbl.textContent = String(Math.round(v * 10) / 10);
});

const tplEl = document.getElementById("tpl") as HTMLSelectElement;
for (const [id, label] of [
  ["blank", "空白"],
  ["lined", "横线"],
  ["grid", "网格"],
  ["dotted", "点阵"],
  ["cornell", "康奈尔"],
  ["planner", "周计划"],
] as const) {
  const o = document.createElement("option");
  o.value = id;
  o.textContent = label;
  tplEl.appendChild(o);
}
tplEl.addEventListener("change", () => editor.setTemplate(tplEl.value as any));

document.getElementById("undo")!.addEventListener("click", () => editor.undo());
document.getElementById("redo")!.addEventListener("click", () => editor.redo());
document.getElementById("add")!.addEventListener("click", () => editor.addPage());
document.getElementById("fit")!.addEventListener("click", () => editor.fit());
document.getElementById("zoomout")!.addEventListener("click", () => editor.zoomBy(1 / 1.15));
document.getElementById("zoomin")!.addEventListener("click", () => editor.zoomBy(1.15));

function sync(): void {
  if (!editor) return;
  const s = editor.getState();
  for (const [id, btn] of Object.entries(toolBtns)) btn.classList.toggle("is-active", s.tool === id);
  for (const el of Array.from(colorsEl.children) as HTMLElement[]) {
    el.classList.toggle("is-active", (el.dataset.color || "").toLowerCase() === s.penColor.toLowerCase());
  }
  const v = s.tool === "highlighter" ? s.highlighterSize : s.penSize;
  sizeEl.value = String(v);
  sizeLbl.textContent = String(Math.round(v * 10) / 10);
  (document.getElementById("zoom") as HTMLElement).textContent = Math.round(s.zoom * 100) + "%";
  (document.getElementById("undo") as HTMLElement).classList.toggle("is-disabled", !s.canUndo);
  (document.getElementById("redo") as HTMLElement).classList.toggle("is-disabled", !s.canRedo);
  tplEl.value = store.page.template;
}

document.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement)?.tagName === "INPUT") return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (k === "z") {
      e.preventDefault();
      if (e.shiftKey) editor.redo();
      else editor.undo();
    }
    return;
  }
  if (k === "p") editor.setTool("pen");
  else if (k === "b") editor.setTool("ballpoint");
  else if (k === "h") editor.setTool("highlighter");
  else if (k === "e") editor.setTool("eraser");
  else if (k === "r") editor.setTool("shape");
  else if (k === "0") editor.fit();
  else if (k === "+" || k === "=") editor.zoomBy(1.15);
  else if (k === "-") editor.zoomBy(1 / 1.15);
});

sync();
(window as any).__inkbook = { editor, store };
