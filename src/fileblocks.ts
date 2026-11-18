/**
 * 「文件块」：把 Excalidraw 导图 / 笔记 / 文本文件以「快照图 + 源引用」的形式
 * 嵌进墨本页面。
 *
 * 为什么做成快照位图而不是在画布上实时渲染源文件：
 *   · 墨本页面是 canvas 绘制的，屏幕 / 缩略图 / 导出 PDF / 笔记内嵌入四处
 *     共用同一套 `drawInsertedImages`。只要文件块是一张图，这四处就**自动一致**，
 *     不用再为导出 / 嵌入各写一遍富文本或 Excalidraw 渲染。
 *   · 卡片里画的是**源文件的内容**：Excalidraw 按 scene 元素自绘（矩形 /
 *     箭头 / 文字 / 自由笔 …），笔记按标题 / 列表 / 引用排版成可读正文，
 *     不是一张应用截图，也不是把 JSON 源码当文本倒出来。
 *
 * Excalidraw 不再强依赖官方插件：`.excalidraw` 原始 JSON、`.excalidraw.md`、
 * 新版插件存成普通 `.md` 的导图都按内容认出来并自绘。只有压缩格式
 * （LZ-string）自绘解不了时，才退回插件导出能力。
 *
 * 这一层只做「源文件 → 快照 PNG」的纯逻辑（读文件 / 排版 / 自绘场景），
 * 不碰编辑器与 DOM 事件；落点、拖动、缩放、撤销全复用插入图片那条管线。
 */
import type { App, TFile } from "obsidian";
import { measureImageBytes, saveImageAsset } from "./images";
import type { PageFileSource, PageFileSourceType } from "./types";
import {
  isExcalidrawText,
  parseExcalidrawScene,
  renderExcalidrawScene,
  type ExcalidrawScene,
} from "./excalidraw-scene";

/** 与 editor 的 TEXT_FONTS「黑体」同一套回退链，保证快照里的字形与页面文字观感一致 */
const CARD_FONT =
  '-apple-system, BlinkMacSystemFont, "Noto Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif';

/** 支持作为文件块的文本类扩展名（其余二进制不在这个入口里） */
const TEXT_EXTS = ["md", "txt", "text", "log", "csv", "json", "yaml", "yml"];

/**
 * 判断一个文件能否作为「文件块」嵌入；返回类型或 null（不支持）。
 * 第二个参数做内容嗅探：新版 Excalidraw 插件把导图存成普通 `.md`，
 * 只认文件名会把它当笔记，渲染出 `# Text Elements` / scene JSON 一堆英文。
 * 可以是文件全文，也可以是 metadataCache 的 frontmatter 对象。
 */
export function classifyFileBlock(
  name: string,
  content?: string | Record<string, unknown>
): PageFileSourceType | null {
  const n = String(name || "").toLowerCase();
  if (!n) return null;
  if (n.endsWith(".excalidraw") || n.endsWith(".excalidraw.md")) return "excalidraw";
  const dot = n.lastIndexOf(".");
  const ext = dot > 0 ? n.slice(dot + 1) : "";
  const byName: PageFileSourceType | null = ext === "md" ? "markdown" : TEXT_EXTS.includes(ext) ? "text" : null;
  if (!byName) return null;
  if (content && isExcalidrawSource(content)) return "excalidraw";
  return byName;
}

function isExcalidrawSource(content: string | Record<string, unknown>): boolean {
  if (typeof content === "string") return isExcalidrawText(content);
  if (content && typeof content === "object") {
    return Boolean((content as Record<string, unknown>)["excalidraw-plugin"]);
  }
  return false;
}

/** 文件块的类型标签（属性条 / 卡片角标用） */
export function fileBlockTypeLabel(type: PageFileSourceType): string {
  return type === "excalidraw" ? "Excalidraw" : type === "markdown" ? "笔记" : "文本";
}

/**
 * 去掉 YAML frontmatter（`--- ... ---`）、BOM 与 HTML 注释。
 *
 * Obsidian 笔记常以 frontmatter 开头（tags / created 等），这些是元数据，
 * 不该出现在文件块卡片的正文里——否则卡片第一屏全是 `---` 和键值对，看着就像坏了。
 */
export function stripFrontmatter(text: string): string {
  let t = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
  const fm = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(t);
  if (fm) t = t.slice(fm[0].length);
  t = t.replace(/<!--[\s\S]*?-->/g, "");
  return t;
}

/** 行内 Markdown 记号 → 纯文本（标题 / 列表等按行处理的结构不在这里） */
function cleanInline(s: string): string {
  return String(s ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接保留文字
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // 粗体
    .replace(/(\*|_)(.*?)\1/g, "$2") // 斜体
    .replace(/~~(.*?)~~/g, "$1") // 删除线
    .replace(/`([^`]*)`/g, "$1"); // 行内代码
}

/** 把 Markdown 轻度还原成纯文本（快照卡片不做富文本排版，先把记号去掉更好读） */
export function stripMarkdown(text: string): string {
  let t = stripFrontmatter(text);
  t = t.replace(/^```.*$/gm, ""); // 代码围栏标记行
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ""); // 图片
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // 链接保留文字
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, ""); // 标题 #
  t = t.replace(/^\s{0,3}>\s?/gm, ""); // 引用 >
  t = t.replace(/^\s*[-*+]\s+/gm, "• "); // 无序列表
  t = t.replace(/(\*\*|__)(.*?)\1/g, "$2"); // 粗体
  t = t.replace(/(\*|_)(.*?)\1/g, "$2"); // 斜体
  t = t.replace(/~~(.*?)~~/g, "$1"); // 删除线
  t = t.replace(/`([^`]*)`/g, "$1"); // 行内代码
  t = t.replace(/^\s*([-*_])\1{2,}\s*$/gm, ""); // 分隔线
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function wrapParagraph(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const ch of Array.from(text)) {
    const test = line + ch;
    if (line && ctx.measureText(test).width > maxW) {
      out.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  out.push(line);
  return out;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

export interface TextCardResult {
  dataURL: string;
  /** 逻辑宽（页面坐标尺度，交给 fitImageRect 再缩放） */
  width: number;
  /** 逻辑高 */
  height: number;
}

const CARD_PAD = 22;
const CARD_ACCENT = 5;
const CARD_HEADER_H = 48;

/** 文件块卡片外壳：圆角白底 + 左侧类型色条 + 文件名 / 类型标签 + 分隔线 */
function drawCardChrome(
  ctx: CanvasRenderingContext2D,
  W: number,
  height: number,
  fileName: string,
  type: PageFileSourceType
): { innerW: number; textX0: number; bodyTop: number } {
  const pad = CARD_PAD;
  const accent = CARD_ACCENT;
  const headerH = CARD_HEADER_H;
  const titleFont = `600 18px ${CARD_FONT}`;
  const tagFont = `500 12px ${CARD_FONT}`;
  const innerW = W - pad * 2 - accent;
  const textX0 = pad + accent + 2;

  ctx.save();
  ctx.shadowColor = "rgba(20,20,30,0.18)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = "#FFFFFF";
  roundRect(ctx, 0, 0, W, height, 12);
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#C9C9D4";
  roundRect(ctx, 0.75, 0.75, W - 1.5, height - 1.5, 12);
  ctx.stroke();

  ctx.save();
  roundRect(ctx, 0, 0, W, height, 12);
  ctx.clip();
  const accentColor =
    type === "excalidraw" ? "#7C5CD6" : type === "markdown" ? "#1F5FBF" : "#6B7280";
  ctx.fillStyle = accentColor;
  ctx.fillRect(0, 0, accent, height);
  ctx.restore();

  const titleY = pad + 2;
  const tagText = fileBlockTypeLabel(type);
  ctx.font = tagFont;
  const tagW = ctx.measureText(tagText).width + 16;
  const tagH = 22;
  const tagX = W - pad - tagW;
  ctx.fillStyle = type === "excalidraw" ? "#EEE9FB" : type === "markdown" ? "#E6EEF9" : "#EFEFF2";
  roundRect(ctx, tagX, titleY, tagW, tagH, 11);
  ctx.fill();
  ctx.fillStyle = accentColor;
  ctx.fillText(tagText, tagX + 8, titleY + 4);

  ctx.font = titleFont;
  ctx.fillStyle = "#222226";
  const titleMaxW = tagX - textX0 - 10;
  ctx.fillText(ellipsize(ctx, fileName || "文件", titleMaxW), textX0, titleY);

  ctx.strokeStyle = "#ECECF0";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(textX0, pad + headerH);
  ctx.lineTo(W - pad, pad + headerH);
  ctx.stroke();

  return { innerW, textX0, bodyTop: pad + headerH + 12 };
}

/** 正文里一条待绘制的文本（横排一行） */
interface DrawOp {
  text: string;
  x: number;
  y: number;
  font: string;
  color: string;
}

/**
 * 把一段文本排成一张「文件块卡片」位图。
 *
 * 卡片含：左侧类型色条、标题栏（文件名 + 类型标签）、分隔线、正文。
 * 正文按宽度逐字折行（中文友好），超过 maxLines 就截断并标注「已截断」，
 * 避免一个几万字的大文件把快照图撑到几百 MB。
 */
export function renderTextCard(
  fileName: string,
  rawText: string,
  opts: { type?: PageFileSourceType; width?: number } = {}
): TextCardResult {
  const type = opts.type || "text";
  const W = Math.max(260, Math.round(opts.width ?? 540));
  const scale = 2;
  const pad = 22;
  const accent = 5;
  const headerH = 48;
  const bodyFontSize = 16;
  const bodyFont = `${bodyFontSize}px ${CARD_FONT}`;
  const titleFont = `600 18px ${CARD_FONT}`;
  const tagFont = `500 12px ${CARD_FONT}`;
  const innerW = W - pad * 2 - accent;
  const textX0 = pad + accent + 2;
  const bodyTop = pad + headerH + 12;
  const maxBodyHeight = 1150; // 正文最多这么高（逻辑像素），再高就截断，避免撑爆快照

  const measure = document.createElement("canvas").getContext("2d")!;
  const ops: DrawOp[] = [];
  let y = bodyTop;
  let truncated = false;
  let sawContent = false;

  /** 按宽度逐字折行，压入绘制指令；超出正文高度上限就返回 false（触发截断） */
  const pushWrapped = (text: string, font: string, color: string, indent: number, lineH: number): boolean => {
    measure.font = font;
    const avail = Math.max(24, innerW - indent);
    const lead = " ".repeat(Math.round(indent / 7));
    let line = "";
    const flush = () => {
      if (y + lineH > bodyTop + maxBodyHeight) {
        truncated = true;
        return false;
      }
      ops.push({ text: lead + line, x: textX0, y, font, color });
      y += lineH;
      line = "";
      return true;
    };
    for (const ch of Array.from(text)) {
      const test = line + ch;
      if (line && measure.measureText(test).width > avail) {
        if (!flush()) return false;
        line = ch;
      } else {
        line = test;
      }
    }
    if (line !== "") return flush();
    return true;
  };

  const body = stripFrontmatter(rawText);
  const srcLines = body.length ? body.split("\n") : [];
  for (const raw of srcLines) {
    if (y >= bodyTop + maxBodyHeight) {
      truncated = true;
      break;
    }
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      y += 10; // 空行留一小段空隙
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const size = [26, 21, 18, 16, 15, 15][level - 1] || 15;
      y += level <= 2 ? 10 : 5; // 标题上方留白
      if (!pushWrapped(cleanInline(h[2]), `700 ${size}px ${CARD_FONT}`, "#1b1b22", 0, Math.round(size * 1.4))) break;
      y += 4;
      sawContent = true;
      continue;
    }
    const b = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (b) {
      if (!pushWrapped("• " + cleanInline(b[1]), bodyFont, "#333338", 6, Math.round(bodyFontSize * 1.55))) break;
      sawContent = true;
      continue;
    }
    const o = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (o) {
      if (!pushWrapped(o[1] + ". " + cleanInline(o[2]), bodyFont, "#333338", 6, Math.round(bodyFontSize * 1.55))) break;
      sawContent = true;
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      if (!pushWrapped(cleanInline(q[1]), bodyFont, "#6a6a74", 12, Math.round(bodyFontSize * 1.55))) break;
      sawContent = true;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      y += 12; // 分隔线 → 留白
      continue;
    }
    if (/^\s*```/.test(line)) continue; // 代码围栏标记行
    if (!pushWrapped(cleanInline(line), bodyFont, "#333338", 0, Math.round(bodyFontSize * 1.55))) break;
    sawContent = true;
  }

  if (!sawContent) {
    const emptyFont = `italic ${bodyFontSize}px ${CARD_FONT}`;
    ops.push({ text: "（这个文件是空的）", x: textX0, y: bodyTop + 2, font: emptyFont, color: "#9a9aa4" });
    y = bodyTop + 34;
  }

  const footerH = truncated ? 30 : 0;
  const height = Math.max(pad + headerH + 40, y + pad + footerH);

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.textBaseline = "top";

  drawCardChrome(ctx, W, height, fileName, type);

  // 正文
  for (const op of ops) {
    ctx.font = op.font;
    ctx.fillStyle = op.color;
    ctx.fillText(op.text, op.x, op.y);
  }

  // 截断脚注
  if (truncated) {
    ctx.font = tagFont;
    ctx.fillStyle = "#8A8A93";
    ctx.fillText("内容较长，已截断——点「打开源文件」查看全文", textX0, height - pad + 4);
  }

  return { dataURL: canvas.toDataURL("image/png"), width: W, height };
}

/**
 * 把 Excalidraw 场景排成一张「文件块卡片」位图。
 * 外壳和笔记卡片共用 `drawCardChrome`，正文是自绘出来的导图（不是 JSON 源码，
 * 也不是应用截图），所以 `.md` 导图插进来看到的是画，而不是一堆英文。
 */
export async function renderExcalidrawCard(
  fileName: string,
  scene: ExcalidrawScene,
  opts: { width?: number } = {}
): Promise<TextCardResult> {
  const W = Math.max(320, Math.round(opts.width ?? 620));
  const scale = 2;
  const innerW = W - CARD_PAD * 2 - CARD_ACCENT;
  const bodyTop = CARD_PAD + CARD_HEADER_H + 12;
  const drawing = await renderExcalidrawScene(scene, {
    maxWidth: innerW,
    maxHeight: 760,
    font: CARD_FONT,
  });
  const height = Math.max(CARD_PAD + CARD_HEADER_H + 60, bodyTop + drawing.height + CARD_PAD);

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.textBaseline = "top";
  drawCardChrome(ctx, W, height, fileName, "excalidraw");

  const dx = CARD_PAD + CARD_ACCENT + 2 + Math.max(0, (innerW - drawing.width) / 2);
  ctx.save();
  ctx.fillStyle = "#FBFBFD";
  roundRect(ctx, dx - 4, bodyTop - 4, drawing.width + 8, drawing.height + 8, 8);
  ctx.fill();
  ctx.drawImage(drawing.canvas, dx, bodyTop, drawing.width, drawing.height);
  ctx.restore();

  return { dataURL: canvas.toDataURL("image/png"), width: W, height };
}

/** dataURL → ArrayBuffer（写盘 / measureImageBytes 用） */
export function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function dataUrlToBlob(dataUrl: string): Blob {
  return new Blob([dataUrlToArrayBuffer(dataUrl)], { type: "image/png" });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label}超时`));
    }, ms);
    Promise.resolve(p).then(
      (v) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * 借 Obsidian Excalidraw 插件把某个 `.excalidraw` / `.excalidraw.md` 文件导出成 PNG。
 *
 * 不自己解析、渲染 Excalidraw 场景（那是重写渲染引擎）。这里走插件暴露的
 * ExcalidrawAutomate：`getSceneFromFile` 读出场景 → `copyViewElementsToEAforEditing`
 * 装进 workbench → `createPNG` 导出。插件版本不同 API 会略有差异，做能力探测。
 * 没装 / 装的是不兼容版本 → 抛出具象错误，由调用方给用户占位提示。
 */
export async function exportExcalidrawPng(
  app: any,
  file: TFile,
  timeoutMs = 30000
): Promise<{ bytes: ArrayBuffer; width: number; height: number }> {
  const plugin = app?.plugins?.plugins?.["obsidian-excalidraw-plugin"];
  const ea = plugin?.ea;
  if (!ea || typeof ea.getSceneFromFile !== "function") {
    throw new Error("需要安装并启用 Excalidraw 插件才能显示 Excalidraw 导图");
  }
  const scene: any = await withTimeout(ea.getSceneFromFile(file), timeoutMs, "读取 Excalidraw 场景");
  if (!scene || !Array.isArray(scene.elements) || !scene.elements.length) {
    throw new Error("这个 Excalidraw 文件里没有可显示的内容");
  }
  if (typeof ea.copyViewElementsToEAforEditing !== "function") {
    throw new Error("当前 Excalidraw 插件版本不支持导出（缺少 copyViewElementsToEAforEditing）");
  }
  ea.reset?.();
  ea.copyViewElementsToEAforEditing(scene.elements);

  let blob: Blob | null = null;
  let lastErr: any = null;
  if (typeof ea.createPNG === "function") {
    try {
      const es =
        typeof ea.getExportSettings === "function" ? ea.getExportSettings(false, false) : undefined;
      blob = await withTimeout(Promise.resolve(ea.createPNG(undefined, 2, es)), timeoutMs, "导出 Excalidraw 图片");
    } catch (e) {
      lastErr = e;
    }
  }
  // createPNG 个别版本会抛错 / 返回空：退回 base64 接口再试一次
  if (!blob && typeof ea.createPNGBase64 === "function") {
    try {
      const dataUrl = await withTimeout(
        Promise.resolve(ea.createPNGBase64(undefined, 2)),
        timeoutMs,
        "导出 Excalidraw 图片"
      );
      if (dataUrl) blob = dataUrlToBlob(String(dataUrl));
    } catch (e) {
      lastErr = e;
    }
  }
  if (!blob) {
    const hint = lastErr && lastErr.message ? `（${lastErr.message}）` : "";
    throw new Error("无法导出 Excalidraw 图片" + hint);
  }

  const bytes = await blob.arrayBuffer();
  const size = await measureImageBytes(bytes, "image/png");
  if (!size) throw new Error("导出的 Excalidraw 图片无法解析");
  return { bytes, width: size.width, height: size.height };
}

async function readTextFile(app: any, file: TFile): Promise<string> {
  try {
    if (app?.vault?.read) {
      const r = await app.vault.read(file);
      if (typeof r === "string") return r;
    }
  } catch (_) {
    /* 落到 adapter.read */
  }
  const adapter = app?.vault?.adapter;
  if (adapter?.read) {
    const r = await adapter.read(file.path);
    if (typeof r === "string") return r;
  }
  throw new Error("读取源文件失败");
}

export interface FileBlockSnapshot {
  /** 快照图在本子数据叶子里的库内路径 */
  src: string;
  /** 快照原始尺寸（像素 / 逻辑尺寸），交给 fitImageRect 缩放 */
  width: number;
  height: number;
  source: PageFileSource;
}

/**
 * 把一个源文件生成「文件块快照」：渲染 / 导出成 PNG，写进本子数据叶子
 * （`墨本文件/<token>.墨本/`，与插入图片同一套），并带上源引用。
 */
export async function makeFileBlockSnapshot(
  app: App | any,
  bookPath: string,
  file: TFile
): Promise<FileBlockSnapshot> {
  const name = String(file?.name || "");
  if (!classifyFileBlock(name)) throw new Error(`「${name}」不是可嵌入的文件类型`);
  // 先读全文：新版 Excalidraw 插件把导图存成普通 .md，只认文件名会当成笔记
  let text = "";
  try {
    text = await readTextFile(app, file);
  } catch (_) {
    text = "";
  }
  const type = classifyFileBlock(name, text) as PageFileSourceType;
  const mtimeRaw = Number(file?.stat?.mtime);
  const source: PageFileSource = { path: file.path, type };
  if (Number.isFinite(mtimeRaw)) source.mtime = mtimeRaw;

  if (type === "excalidraw") {
    const scene = parseExcalidrawScene(text);
    if (scene && scene.elements.length) {
      const card = await renderExcalidrawCard(file.basename, scene);
      const bytes = dataUrlToArrayBuffer(card.dataURL);
      const src = await saveImageAsset(app, bookPath, `${file.basename}.png`, bytes);
      return { src, width: card.width, height: card.height, source };
    }
    // 压缩场景 / 读不到文本：退回官方插件导出能力，缺插件时给出明确提示
    const png = await exportExcalidrawPng(app, file);
    const src = await saveImageAsset(app, bookPath, `${file.basename}.png`, png.bytes);
    return { src, width: png.width, height: png.height, source };
  }

  const card = renderTextCard(file.basename, text, { type });
  const bytes = dataUrlToArrayBuffer(card.dataURL);
  const src = await saveImageAsset(app, bookPath, `${file.basename}.png`, bytes);
  return { src, width: card.width, height: card.height, source };
}
