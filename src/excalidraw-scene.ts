/**
 * Excalidraw 场景「解析 + 自绘」。
 *
 * 为什么不再借 Excalidraw 插件导出：`.excalidraw.md` / 新版插件的 `.md` 导图
 * 本质就是一段 Markdown 里包着 `## Drawing` 的 scene JSON；而插件的
 * ExcalidrawAutomate API 每个版本都不一样，缺一个方法就整块插不进去，
 * 用户看到的要么是报错，要么是按文件名当普通笔记后渲染出来的一堆英文。
 *
 * 这里只认数据、不认插件：读文本 → 找 scene JSON → 按元素自绘成位图。
 * 覆盖导图常见元素（矩形/圆/菱形/线/箭头/自由笔/文字/图片），
 * 颜色、线型、透明度、旋转、圆角、箭头都还原。压缩格式（LZ-string）
 * 解不了就返回 null，交给 `exportExcalidrawPng` 走插件兜底。
 *
 * 输出仍是「一张图」：屏幕 / 缩略图 / 导出 / 笔记内嵌入四处共用
 * `drawInsertedImages`，不用为 Excalidraw 单独做实时 DOM 浮层。
 */
const num = (v: any, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export interface ExcalidrawScene {
  elements: any[];
  appState: any;
  files: Record<string, any>;
}

export interface SceneRender {
  canvas: HTMLCanvasElement;
  /** 逻辑宽（页面坐标尺度） */
  width: number;
  height: number;
}

function tryScene(raw: string): ExcalidrawScene | null {
  const s = String(raw ?? "").trim();
  if (s[0] !== "{") return null;
  let o: any;
  try {
    o = JSON.parse(s);
  } catch (_) {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  // 压缩场景用 LZ-string 把 elements 编成字符串，自绘解不了
  if (o.compressed || !Array.isArray(o.elements)) return null;
  // 必须是 Excalidraw 自己的 scene：普通笔记里恰好有个
  // `{ "elements": [...] }` 代码块不算，否则会把笔记误渲染成导图
  if (o.type !== "excalidraw") return null;
  return { elements: o.elements, appState: o.appState || {}, files: o.files || {} };
}

/** 从 `.excalidraw` 原始 JSON 或 `.md` 的 `## Drawing` fenced block 里取场景 */
export function parseExcalidrawScene(text: string): ExcalidrawScene | null {
  const t = String(text ?? "").replace(/^\uFEFF/, "").trim();
  if (!t) return null;
  const direct = tryScene(t);
  if (direct) return direct;

  // Excalidraw 插件的 Markdown 格式：```json 场景 ```，外面还有 %% 包裹
  const fence = /```(?:json|JSON)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(t))) {
    const s = tryScene(m[1]);
    if (s) return s;
  }
  // 老格式：%% 之间直接是裸 JSON，没有代码围栏
  const bare = t.replace(/```(?:json|JSON)?/gi, "").replace(/^%%\s*$/gm, "");
  const i = bare.indexOf("{");
  const j = bare.lastIndexOf("}");
  if (i >= 0 && j > i) {
    const s = tryScene(bare.slice(i, j + 1));
    if (s) return s;
  }
  return null;
}

/** 内容嗅探：文件名不是 `.excalidraw` 时，靠内容认出这是张导图 */
export function isExcalidrawText(text: string): boolean {
  const t = String(text ?? "");
  if (!t) return false;
  // 新版插件把导图存成普通 .md，唯一标识是 frontmatter 里的这个键
  if (/^\uFEFF?\s*---\s*\n[\s\S]{0,4000}?\bexcalidraw-plugin\s*:/.test(t)) return true;
  const scene = parseExcalidrawScene(t);
  if (!scene) return false;
  if (/^#{1,2}\s*(Drawing|Text Elements)\b/im.test(t)) return true;
  // 裸 .excalidraw 内容被用户改了扩展名（或干脆叫 xxx.md）的情况
  return /^\s*\{/.test(t) && /"type"\s*:\s*"excalidraw"/.test(t);
}

const SKIP = new Set(["selection", "frame", "magicframe", "embeddable", "iframe"]);

interface Bounds {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

function sceneBounds(scene: ExcalidrawScene): Bounds {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const el of scene.elements) {
    if (!el || el.isDeleted || SKIP.has(String(el.type || ""))) continue;
    const x = num(el.x);
    const y = num(el.y);
    const w = num(el.width);
    const h = num(el.height);
    x0 = Math.min(x0, x, x + w);
    y0 = Math.min(y0, y, y + h);
    x1 = Math.max(x1, x, x + w);
    y1 = Math.max(y1, y, y + h);
    // line/arrow/freedraw 的 points 是相对 x,y 的；有的场景没给 width/height
    if (Array.isArray(el.points) && el.points.length) {
      for (const p of el.points) {
        if (!Array.isArray(p)) continue;
        x0 = Math.min(x0, x + num(p[0]));
        y0 = Math.min(y0, y + num(p[1]));
        x1 = Math.max(x1, x + num(p[0]));
        y1 = Math.max(y1, y + num(p[1]));
      }
    }
  }
  if (!Number.isFinite(x0) || x1 <= x0 || y1 <= y0) return { x0: 0, y0: 0, w: 400, h: 240 };
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

function roundedPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function shapePath(ctx: CanvasRenderingContext2D, el: any): (() => void) | null {
  const x = num(el.x);
  const y = num(el.y);
  const w = num(el.width);
  const h = num(el.height);
  switch (String(el.type || "")) {
    case "rectangle":
      return () => roundedPath(ctx, x, y, w, h, el.roundness ? Math.min(Math.abs(w), Math.abs(h)) * 0.18 : 0);
    case "ellipse":
      return () => {
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w) / 2, Math.abs(h) / 2, 0, 0, Math.PI * 2);
      };
    case "diamond":
      return () => {
        ctx.beginPath();
        ctx.moveTo(x + w / 2, y);
        ctx.lineTo(x + w, y + h / 2);
        ctx.lineTo(x + w / 2, y + h);
        ctx.lineTo(x, y + h / 2);
        ctx.closePath();
      };
    default:
      return null;
  }
}

/** hachure / cross-hatch 填充：Excalidraw 默认手绘感，用斜线近似 */
function paintFill(
  ctx: CanvasRenderingContext2D,
  el: any,
  path: () => void,
  bg: string,
  stroke: string
): void {
  if (!bg || bg === "transparent") return;
  const style = String(el.fillStyle || "solid");
  const x = num(el.x);
  const y = num(el.y);
  const w = Math.abs(num(el.width));
  const h = Math.abs(num(el.height));
  ctx.save();
  ctx.fillStyle = bg;
  if (style !== "solid") ctx.globalAlpha *= 0.55;
  path();
  ctx.fill();
  if (style !== "solid") {
    ctx.save();
    path();
    ctx.clip();
    ctx.globalAlpha *= 0.42;
    ctx.strokeStyle = stroke;
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    const span = w + h;
    for (let d = -h; d < span; d += 9) {
      ctx.beginPath();
      ctx.moveTo(x + d, y);
      ctx.lineTo(x + d - h, y + h);
      ctx.stroke();
    }
    if (style === "cross-hatch" || style === "zigzag") {
      for (let d = -h; d < span; d += 9) {
        ctx.beginPath();
        ctx.moveTo(x + d, y + h);
        ctx.lineTo(x + d + h, y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  ctx.restore();
}

function arrowHead(
  ctx: CanvasRenderingContext2D,
  from: number[],
  to: number[],
  ox: number,
  oy: number
): void {
  const ax = ox + num(from[0]);
  const ay = oy + num(from[1]);
  const bx = ox + num(to[0]);
  const by = oy + num(to[1]);
  const a = Math.atan2(by - ay, bx - ax);
  const len = Math.max(10, ctx.lineWidth * 4);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(bx - len * Math.cos(a - 0.42), by - len * Math.sin(a - 0.42));
  ctx.lineTo(bx, by);
  ctx.lineTo(bx - len * Math.cos(a + 0.42), by - len * Math.sin(a + 0.42));
  ctx.stroke();
}

function drawText(ctx: CanvasRenderingContext2D, el: any, font: string): void {
  const text = String(el.text ?? el.originalText ?? "");
  if (!text) return;
  const size = clamp(num(el.fontSize, 20), 8, 96);
  const family =
    el.fontFamily === 2
      ? "Arial, Helvetica, sans-serif"
      : el.fontFamily === 3
        ? "ui-monospace, Consolas, monospace"
        : font;
  const x = num(el.x);
  const y = num(el.y);
  const w = num(el.width);
  const h = num(el.height);
  const lines = text.split("\n");
  const lineH = size * clamp(num(el.lineHeight, 1.25), 0.8, 2.4);
  const align = el.textAlign === "center" || el.textAlign === "right" ? el.textAlign : "left";
  const tx = align === "center" ? x + w / 2 : align === "right" ? x + w : x;
  const total = lines.length * lineH;
  const ty = el.verticalAlign === "middle" ? y + (h - total) / 2 : el.verticalAlign === "bottom" ? y + h - total : y;
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = String(el.strokeColor || "#1e1e1e");
  ctx.font = `${size}px ${family}`;
  ctx.textAlign = align as CanvasTextAlign;
  ctx.textBaseline = "top";
  lines.forEach((line, i) => ctx.fillText(line, tx, ty + i * lineH));
  ctx.restore();
}

function drawElement(
  ctx: CanvasRenderingContext2D,
  el: any,
  images: Map<string, HTMLImageElement>,
  font: string
): void {
  if (!el || el.isDeleted) return;
  const type = String(el.type || "");
  if (SKIP.has(type)) return;
  const x = num(el.x);
  const y = num(el.y);
  const w = num(el.width);
  const h = num(el.height);
  ctx.save();
  ctx.globalAlpha *= clamp(num(el.opacity, 100) / 100, 0, 1);
  if (num(el.angle)) {
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(num(el.angle));
    ctx.translate(-(x + w / 2), -(y + h / 2));
  }
  const stroke = String(el.strokeColor || "#1e1e1e");
  ctx.strokeStyle = stroke;
  ctx.lineWidth = Math.max(0.75, num(el.strokeWidth, type === "freedraw" ? 2 : 1.5));
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash(
    el.strokeStyle === "dashed" ? [8, 6] : el.strokeStyle === "dotted" ? [1.5, 5] : []
  );

  if (type === "text") {
    drawText(ctx, el, font);
    ctx.restore();
    return;
  }
  if (type === "image") {
    const img = images.get(String(el.fileId || ""));
    if (img) {
      ctx.save();
      ctx.setLineDash([]);
      ctx.drawImage(img, Math.min(x, x + w), Math.min(y, y + h), Math.abs(w), Math.abs(h));
      ctx.restore();
    } else {
      ctx.save();
      ctx.setLineDash([]);
      ctx.fillStyle = "#F1F1F5";
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }
    ctx.restore();
    return;
  }
  if (type === "line" || type === "arrow" || type === "freedraw") {
    const pts: number[][] = Array.isArray(el.points) ? el.points : [];
    if (pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(x + num(pts[0][0]), y + num(pts[0][1]));
      if (type === "freedraw" || el.roundness) {
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = x + (num(pts[i][0]) + num(pts[i + 1][0])) / 2;
          const my = y + (num(pts[i][1]) + num(pts[i + 1][1])) / 2;
          ctx.quadraticCurveTo(x + num(pts[i][0]), y + num(pts[i][1]), mx, my);
        }
        ctx.lineTo(x + num(pts[pts.length - 1][0]), y + num(pts[pts.length - 1][1]));
      } else {
        for (let i = 1; i < pts.length; i++) ctx.lineTo(x + num(pts[i][0]), y + num(pts[i][1]));
      }
      ctx.stroke();
      // endArrowhead 显式为 null 时不要凭空画箭头（有些场景只是折线）
      const endHead = el.endArrowhead === undefined && type === "arrow" ? "arrow" : el.endArrowhead;
      if (endHead && endHead !== "none") {
        arrowHead(ctx, pts[pts.length - 2], pts[pts.length - 1], x, y);
      }
      if (el.startArrowhead && el.startArrowhead !== "none") arrowHead(ctx, pts[1], pts[0], x, y);
    }
    ctx.restore();
    return;
  }
  const path = shapePath(ctx, el);
  if (path) {
    paintFill(ctx, el, path, String(el.backgroundColor || "transparent"), stroke);
    path();
    ctx.stroke();
  }
  ctx.restore();
}

async function loadImages(scene: ExcalidrawScene): Promise<Map<string, HTMLImageElement>> {
  const out = new Map<string, HTMLImageElement>();
  const ids = Object.keys(scene.files || {}).slice(0, 40);
  await Promise.all(
    ids.map(async (id) => {
      const url = scene.files?.[id]?.dataURL;
      // 只吃内联 data URL：不发起网络请求，也不让外部资源污染画布
      if (typeof url !== "string" || !/^data:image\//i.test(url)) return;
      const img = new Image();
      const ok = await new Promise<boolean>((resolve) => {
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = url;
      });
      if (ok) out.set(id, img);
    })
  );
  return out;
}

/** 把场景按原始比例自绘成一张位图（内部 2× 超采样，缩放到页面也不糊） */
export async function renderExcalidrawScene(
  scene: ExcalidrawScene,
  opts: { maxWidth: number; maxHeight: number; font: string }
): Promise<SceneRender> {
  const b = sceneBounds(scene);
  const pad = 26;
  const bw = b.w + pad * 2;
  const bh = b.h + pad * 2;
  const scale = Math.min(opts.maxWidth / bw, opts.maxHeight / bh, 2.5);
  const width = Math.max(1, Math.round(bw * scale));
  const height = Math.max(1, Math.round(bh * scale));
  const dpr = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr * scale, dpr * scale);
  ctx.translate(pad - b.x0, pad - b.y0);
  const bg = String(scene.appState?.viewBackgroundColor || "#ffffff");
  ctx.fillStyle = /^#[0-9a-fA-F]{3,8}$|^rgba?\(/.test(bg) ? bg : "#ffffff";
  ctx.fillRect(b.x0 - pad, b.y0 - pad, bw, bh);
  const images = await loadImages(scene);
  for (const el of scene.elements) drawElement(ctx, el, images, opts.font);
  return { canvas, width, height };
}
