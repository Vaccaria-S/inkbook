import type { PaperId, TemplateId } from "./types";

interface Palette {
  bg: string;
  line: string;
  strong: string;
  dot: string;
  margin: string;
}

const PALETTES: Record<PaperId, Palette> = {
  white: {
    bg: "#FFFFFF",
    line: "#DCE6F0",
    strong: "#C9D8E8",
    dot: "#B7C6D6",
    margin: "#EFC9C9",
  },
  cream: {
    bg: "#FCF8EC",
    line: "#E6DCC4",
    strong: "#D8C9A8",
    dot: "#C9B995",
    margin: "#E7C3B5",
  },
  gray: {
    bg: "#F5F5F3",
    line: "#DEDEDC",
    strong: "#CACAC7",
    dot: "#B6B6B2",
    margin: "#E3C5C5",
  },
};

export function paperBackground(paper: PaperId): string {
  return (PALETTES[paper] || PALETTES.white).bg;
}

export function drawPaper(
  ctx: CanvasRenderingContext2D,
  template: TemplateId,
  paper: PaperId,
  w: number,
  h: number,
  lineWidth = 1,
  /**
   * 是否填充纸张底色。
   *
   * 导出 PDF 时要关掉：矢量页底下就是原 PDF 内容，铺一层纸色会把原文盖死。
   * 关掉之后只剩纸面线条（横线 / 网格 / 点阵），叠在原文上正好。
   */
  fill = true
): void {
  const p = PALETTES[paper] || PALETTES.white;
  const lw = Math.max(0.35, lineWidth);
  ctx.save();
  if (fill) {
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, w, h);
  }
  if (template === "blank") {
    ctx.restore();
    return;
  }

  ctx.lineWidth = lw;
  ctx.lineCap = "butt";

  if (template === "lined") {
    ctx.strokeStyle = p.line;
    ctx.beginPath();
    for (let y = 112; y < h - 40; y += 34) {
      ctx.moveTo(54, y + lw / 2);
      ctx.lineTo(w - 42, y + lw / 2);
    }
    ctx.stroke();
    ctx.strokeStyle = p.margin;
    ctx.beginPath();
    ctx.moveTo(78 + lw / 2, 64);
    ctx.lineTo(78 + lw / 2, h - 40);
    ctx.stroke();
  } else if (template === "grid") {
    ctx.lineWidth = Math.max(0.3, lw * 0.8);
    ctx.strokeStyle = p.line;
    ctx.beginPath();
    for (let x = 24; x < w; x += 24) {
      ctx.moveTo(x + ctx.lineWidth / 2, 0);
      ctx.lineTo(x + ctx.lineWidth / 2, h);
    }
    for (let y = 24; y < h; y += 24) {
      ctx.moveTo(0, y + ctx.lineWidth / 2);
      ctx.lineTo(w, y + ctx.lineWidth / 2);
    }
    ctx.stroke();
    ctx.lineWidth = lw;
    ctx.strokeStyle = p.strong;
    ctx.beginPath();
    for (let x = 96; x < w; x += 96) {
      ctx.moveTo(x + lw / 2, 0);
      ctx.lineTo(x + lw / 2, h);
    }
    ctx.stroke();
  } else if (template === "dotted") {
    ctx.fillStyle = p.dot;
    const r = Math.max(1.05, lw * 1.15);
    for (let x = 12; x < w; x += 24) {
      for (let y = 12; y < h; y += 24) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (template === "cornell") {
    ctx.strokeStyle = p.line;
    ctx.beginPath();
    for (let y = 150; y < h - 56; y += 34) {
      ctx.moveTo(48, y + lw / 2);
      ctx.lineTo(w - 40, y + lw / 2);
    }
    ctx.stroke();
    ctx.strokeStyle = p.strong;
    ctx.beginPath();
    ctx.moveTo(48, 132 + lw / 2);
    ctx.lineTo(w - 40, 132 + lw / 2);
    ctx.moveTo(w * 0.3 + lw / 2, 132);
    ctx.lineTo(w * 0.3 + lw / 2, h * 0.76);
    ctx.moveTo(48, h * 0.76 + lw / 2);
    ctx.lineTo(w - 40, h * 0.76 + lw / 2);
    ctx.stroke();
  } else if (template === "planner") {
    ctx.strokeStyle = p.strong;
    ctx.beginPath();
    ctx.moveTo(48, 112 + lw / 2);
    ctx.lineTo(w - 40, 112 + lw / 2);
    ctx.moveTo(w * 0.24, 112);
    ctx.lineTo(w * 0.24, h - 40);
    ctx.stroke();

    ctx.strokeStyle = p.line;
    ctx.beginPath();
    for (let i = 0; i < 7; i++) {
      const y = 168 + i * 128;
      ctx.moveTo(48, y + lw / 2);
      ctx.lineTo(w - 40, y + lw / 2);
    }
    ctx.stroke();

    ctx.strokeStyle = p.strong;
    ctx.beginPath();
    ctx.moveTo(48, 168 + lw / 2);
    ctx.lineTo(w - 40, 168 + lw / 2);
    ctx.stroke();
    ctx.strokeStyle = p.margin;
    ctx.beginPath();
    ctx.moveTo(w - 40 - lw / 2, 112);
    ctx.lineTo(w - 40 - lw / 2, h - 40);
    ctx.stroke();
  }

  ctx.restore();
}

export function paintPaperPreview(
  canvas: HTMLCanvasElement,
  template: TemplateId,
  paper: PaperId,
  pageW: number,
  pageH: number
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const cssW = rect.width || 64;
  const cssH = rect.height || 90;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale((cssW * dpr) / pageW, (cssH * dpr) / pageH);
  drawPaper(ctx, template, paper, pageW, pageH, (0.9 * pageW) / cssW);
}
