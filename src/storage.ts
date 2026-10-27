import { A4_HEIGHT, A4_WIDTH, createLayer, createPage, type InkBook, type Layer, type Page } from "./types";

export function normalizeBook(raw: any, fallbackTitle: string): InkBook {
  const book: InkBook = {
    version: 1,
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
                    points: s.points
                      .filter((q: any) => Array.isArray(q) && q.length >= 2)
                      .map((q: any) => [Number(q[0]), Number(q[1]), Number(q[2] ?? 0.5)]),
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
  return book;
}

export async function readBook(
  adapter: { read: (path: string) => Promise<string>; exists: (path: string) => Promise<boolean> },
  path: string,
  fallbackTitle: string
): Promise<InkBook> {
  if (!(await adapter.exists(path))) throw new Error("文件不存在");
  const text = await adapter.read(path);
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (_) {
    throw new Error("这个 .inkbook 不是有效的 JSON，可能已损坏");
  }
  return normalizeBook(raw, fallbackTitle);
}

export async function writeBook(
  adapter: { write: (path: string, data: string) => Promise<void> },
  path: string,
  book: InkBook
): Promise<void> {
  book.updated = Date.now();
  await adapter.write(path, JSON.stringify(book));
}
