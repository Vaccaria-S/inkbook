(() => {
  // src/types.ts
  var A4_WIDTH = 794;
  var A4_HEIGHT = 1123;
  var PEN_COLORS = [
    "#1A1A1A",
    "#1F5FBF",
    "#D64545",
    "#2E8B57",
    "#E08A1E",
    "#7C5CD6",
    "#D64C8F",
    "#6B7280"
  ];
  function uid(prefix = "id") {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }
  function createLayer(name = "\u7B14\u8FF9\u5C42") {
    return { id: uid("layer"), name, visible: true, opacity: 1, strokes: [] };
  }
  function createPage(template, paper) {
    const layer = createLayer();
    return {
      id: uid("page"),
      template,
      paper,
      layers: [layer],
      activeLayerId: layer.id
    };
  }
  function createBook(title, template = "grid", paper = "white") {
    return {
      version: 1,
      kind: "inkbook",
      title: title || "\u672A\u547D\u540D\u7B14\u8BB0",
      width: A4_WIDTH,
      height: A4_HEIGHT,
      created: Date.now(),
      updated: 0,
      activePage: 0,
      pages: [createPage(template, paper)]
    };
  }
  function activeLayer(page) {
    var _a;
    return (_a = page.layers.find((l2) => l2.id === page.activeLayerId)) != null ? _a : page.layers[0];
  }

  // node_modules/perfect-freehand/dist/esm/index.mjs
  var { PI: e } = Math;
  var t = e + 1e-4;
  var n = 0.5;
  var r = [1, 1];
  function i(e2, t2, n2, r2 = (e3) => e3) {
    return e2 * r2(0.5 - t2 * (0.5 - n2));
  }
  var { min: a } = Math;
  function o(e2, t2, n2) {
    let r2 = a(1, t2 / n2);
    return a(1, e2 + (a(1, 1 - r2) - e2) * (r2 * 0.275));
  }
  function s(e2) {
    return [-e2[0], -e2[1]];
  }
  function c(e2, t2) {
    return [e2[0] + t2[0], e2[1] + t2[1]];
  }
  function l(e2, t2, n2) {
    return e2[0] = t2[0] + n2[0], e2[1] = t2[1] + n2[1], e2;
  }
  function u(e2, t2) {
    return [e2[0] - t2[0], e2[1] - t2[1]];
  }
  function d(e2, t2, n2) {
    return e2[0] = t2[0] - n2[0], e2[1] = t2[1] - n2[1], e2;
  }
  function f(e2, t2) {
    return [e2[0] * t2, e2[1] * t2];
  }
  function p(e2, t2, n2) {
    return e2[0] = t2[0] * n2, e2[1] = t2[1] * n2, e2;
  }
  function m(e2, t2) {
    return [e2[0] / t2, e2[1] / t2];
  }
  function h(e2) {
    return [e2[1], -e2[0]];
  }
  function g(e2, t2) {
    let n2 = t2[0];
    return e2[0] = t2[1], e2[1] = -n2, e2;
  }
  function ee(e2, t2) {
    return e2[0] * t2[0] + e2[1] * t2[1];
  }
  function _(e2, t2) {
    return e2[0] === t2[0] && e2[1] === t2[1];
  }
  function v(e2) {
    return Math.hypot(e2[0], e2[1]);
  }
  function y(e2, t2) {
    let n2 = e2[0] - t2[0], r2 = e2[1] - t2[1];
    return n2 * n2 + r2 * r2;
  }
  function b(e2) {
    return m(e2, v(e2));
  }
  function x(e2, t2) {
    return Math.hypot(e2[1] - t2[1], e2[0] - t2[0]);
  }
  function S(e2, t2, n2) {
    let r2 = Math.sin(n2), i2 = Math.cos(n2), a2 = e2[0] - t2[0], o2 = e2[1] - t2[1], s2 = a2 * i2 - o2 * r2, c2 = a2 * r2 + o2 * i2;
    return [s2 + t2[0], c2 + t2[1]];
  }
  function C(e2, t2, n2, r2) {
    let i2 = Math.sin(r2), a2 = Math.cos(r2), o2 = t2[0] - n2[0], s2 = t2[1] - n2[1], c2 = o2 * a2 - s2 * i2, l2 = o2 * i2 + s2 * a2;
    return e2[0] = c2 + n2[0], e2[1] = l2 + n2[1], e2;
  }
  function w(e2, t2, n2) {
    return c(e2, f(u(t2, e2), n2));
  }
  function te(e2, t2, n2, r2) {
    let i2 = n2[0] - t2[0], a2 = n2[1] - t2[1];
    return e2[0] = t2[0] + i2 * r2, e2[1] = t2[1] + a2 * r2, e2;
  }
  function T(e2, t2, n2) {
    return c(e2, f(t2, n2));
  }
  var E = [0, 0];
  var D = [0, 0];
  var O = [0, 0];
  function k(e2, n2) {
    let r2 = T(e2, b(h(u(e2, c(e2, [1, 1])))), -n2), i2 = [], a2 = 1 / 13;
    for (let n3 = a2; n3 <= 1; n3 += a2) i2.push(S(r2, e2, t * 2 * n3));
    return i2;
  }
  function A(e2, n2, r2) {
    let i2 = [], a2 = 1 / r2;
    for (let r3 = a2; r3 <= 1; r3 += a2) i2.push(S(n2, e2, t * r3));
    return i2;
  }
  function j(e2, t2, n2) {
    let r2 = u(t2, n2), i2 = f(r2, 0.5), a2 = f(r2, 0.51);
    return [u(e2, i2), u(e2, a2), c(e2, a2), c(e2, i2)];
  }
  function M(e2, n2, r2, i2) {
    let a2 = [], o2 = T(e2, n2, r2), s2 = 1 / i2;
    for (let n3 = s2; n3 < 1; n3 += s2) a2.push(S(o2, e2, t * 3 * n3));
    return a2;
  }
  function ne(e2, t2, n2) {
    return [c(e2, f(t2, n2)), c(e2, f(t2, n2 * 0.99)), u(e2, f(t2, n2 * 0.99)), u(e2, f(t2, n2))];
  }
  function N(e2, t2, n2) {
    return e2 === false || e2 === void 0 ? 0 : e2 === true ? Math.max(t2, n2) : e2;
  }
  function re(e2, t2, n2) {
    return e2.slice(0, 10).reduce((e3, r2) => {
      let i2 = r2.pressure;
      return t2 && (i2 = o(e3, r2.distance, n2)), (e3 + i2) / 2;
    }, e2[0].pressure);
  }
  function P(e2, n2 = {}) {
    let { size: r2 = 16, smoothing: a2 = 0.5, thinning: f2 = 0.5, simulatePressure: m2 = true, easing: _2 = (e3) => e3, start: v2 = {}, end: b2 = {}, last: x2 = false } = n2, { cap: S2 = true, easing: w2 = (e3) => e3 * (2 - e3) } = v2, { cap: T2 = true, easing: P2 = (e3) => --e3 * e3 * e3 + 1 } = b2;
    if (e2.length === 0 || r2 <= 0) return [];
    let F2 = e2[e2.length - 1].runningLength, I2 = N(v2.taper, r2, F2), L2 = N(b2.taper, r2, F2), R2 = (r2 * a2) ** 2, z = [], B = [], V = re(e2, m2, r2), H = i(r2, f2, e2[e2.length - 1].pressure, _2), U, W = e2[0].vector, G = e2[0].point, K = G, q = G, J = K, Y = false;
    for (let n3 = 0; n3 < e2.length; n3++) {
      let { pressure: a3 } = e2[n3], { point: s2, vector: h2, distance: v3, runningLength: b3 } = e2[n3], x3 = n3 === e2.length - 1;
      if (!x3 && F2 - b3 < 3) continue;
      f2 ? (m2 && (a3 = o(V, v3, r2)), H = i(r2, f2, a3, _2)) : H = r2 / 2, U === void 0 && (U = H);
      let S3 = b3 < I2 ? w2(b3 / I2) : 1, T3 = F2 - b3 < L2 ? P2((F2 - b3) / L2) : 1;
      H = Math.max(0.01, H * Math.min(S3, T3));
      let k2 = (x3 ? e2[n3] : e2[n3 + 1]).vector, A2 = x3 ? 1 : ee(h2, k2), j2 = ee(h2, W) < 0 && !Y, M2 = A2 !== null && A2 < 0;
      if (j2 || M2) {
        g(E, W), p(E, E, H);
        for (let e3 = 0; e3 <= 1; e3 += 0.07692307692307693) d(D, s2, E), C(D, D, s2, t * e3), q = [D[0], D[1]], z.push(q), l(O, s2, E), C(O, O, s2, t * -e3), J = [O[0], O[1]], B.push(J);
        G = q, K = J, M2 && (Y = true);
        continue;
      }
      if (Y = false, x3) {
        g(E, h2), p(E, E, H), z.push(u(s2, E)), B.push(c(s2, E));
        continue;
      }
      te(E, k2, h2, A2), g(E, E), p(E, E, H), d(D, s2, E), q = [D[0], D[1]], (n3 <= 1 || y(G, q) > R2) && (z.push(q), G = q), l(O, s2, E), J = [O[0], O[1]], (n3 <= 1 || y(K, J) > R2) && (B.push(J), K = J), V = a3, W = h2;
    }
    let X = [e2[0].point[0], e2[0].point[1]], Z = e2.length > 1 ? [e2[e2.length - 1].point[0], e2[e2.length - 1].point[1]] : c(e2[0].point, [1, 1]), Q = [], $ = [];
    if (e2.length === 1) {
      if (!(I2 || L2) || x2) return k(X, U || H);
    } else {
      I2 || L2 && e2.length === 1 || (S2 ? Q.push(...A(X, B[0], 13)) : Q.push(...j(X, z[0], B[0])));
      let t2 = h(s(e2[e2.length - 1].vector));
      L2 || I2 && e2.length === 1 ? $.push(Z) : T2 ? $.push(...M(Z, t2, H, 29)) : $.push(...ne(Z, t2, H));
    }
    return z.concat($, B.reverse(), Q);
  }
  var F = [0, 0];
  function I(e2) {
    return e2 != null && e2 >= 0;
  }
  function L(e2, t2 = {}) {
    var _a;
    let { streamline: i2 = 0.5, size: a2 = 16, last: o2 = false } = t2;
    if (e2.length === 0) return [];
    let s2 = 0.15 + (1 - i2) * 0.85, l2 = Array.isArray(e2[0]) ? e2 : e2.map(({ x: e3, y: t3, pressure: r2 = n }) => [e3, t3, r2]);
    if (l2.length === 2) {
      let e3 = l2[1];
      l2 = l2.slice(0, -1);
      for (let t3 = 1; t3 < 5; t3++) l2.push(w(l2[0], e3, t3 / 4));
    }
    l2.length === 1 && (l2 = [...l2, [...c(l2[0], r), ...l2[0].slice(2)]]);
    let u2 = [{ point: [l2[0][0], l2[0][1]], pressure: I(l2[0][2]) ? l2[0][2] : 0.25, vector: [...r], distance: 0, runningLength: 0 }], f2 = false, p2 = 0, m2 = u2[0], h2 = l2.length - 1;
    for (let e3 = 1; e3 < l2.length; e3++) {
      let t3 = o2 && e3 === h2 ? [l2[e3][0], l2[e3][1]] : w(m2.point, l2[e3], s2);
      if (_(m2.point, t3)) continue;
      let r2 = x(t3, m2.point);
      if (p2 += r2, e3 < h2 && !f2) {
        if (p2 < a2) continue;
        f2 = true;
      }
      d(F, m2.point, t3), m2 = { point: t3, pressure: I(l2[e3][2]) ? l2[e3][2] : n, vector: b(F), distance: r2, runningLength: p2 }, u2.push(m2);
    }
    return u2[0].vector = ((_a = u2[1]) == null ? void 0 : _a.vector) || [0, 0], u2;
  }
  function R(e2, t2 = {}) {
    return P(L(e2, t2), t2);
  }

  // src/ink.ts
  var pathCache = /* @__PURE__ */ new WeakMap();
  function invalidateStroke(stroke) {
    pathCache.delete(stroke);
  }
  function smoothPressures(points) {
    const n2 = points.length;
    const raw = points.map((p2) => Math.max(0.06, Math.min(1, p2[2])));
    const out = [];
    for (let i2 = 0; i2 < n2; i2++) {
      let sum = 0;
      let weight = 0;
      for (let k2 = -2; k2 <= 2; k2++) {
        const j2 = i2 + k2;
        if (j2 < 0 || j2 >= n2) continue;
        const w2 = 3 - Math.abs(k2);
        sum += raw[j2] * w2;
        weight += w2;
      }
      out.push([points[i2][0], points[i2][1], sum / weight]);
    }
    return out;
  }
  function outlineToPath(outline) {
    const path = new Path2D();
    if (outline.length < 2) return path;
    path.moveTo(outline[0][0], outline[0][1]);
    for (let i2 = 1; i2 < outline.length - 1; i2++) {
      const [x0, y0] = outline[i2];
      const [x1, y1] = outline[i2 + 1];
      path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    }
    const last = outline[outline.length - 1];
    path.lineTo(last[0], last[1]);
    path.closePath();
    return path;
  }
  function buildInkPath(stroke) {
    const smooth = smoothPressures(stroke.points);
    const isBallpoint = stroke.tool === "ballpoint";
    const outline = R(smooth, {
      size: stroke.size,
      thinning: isBallpoint ? 0.08 : 0.68,
      smoothing: 0.6,
      streamline: 0.52,
      simulatePressure: false,
      last: true,
      easing: (t2) => t2,
      start: {
        cap: true,
        taper: isBallpoint ? 0 : Math.min(stroke.size * 1.6, 7)
      },
      end: {
        cap: true,
        taper: isBallpoint ? 0 : Math.min(stroke.size * 1.6, 7)
      }
    });
    return outlineToPath(outline);
  }
  function buildPolyline(stroke) {
    const path = new Path2D();
    const pts = stroke.points;
    if (!pts.length) return path;
    path.moveTo(pts[0][0], pts[0][1]);
    if (pts.length === 1) {
      path.lineTo(pts[0][0] + 0.01, pts[0][1] + 0.01);
      return path;
    }
    for (let i2 = 1; i2 < pts.length - 1; i2++) {
      const mx = (pts[i2][0] + pts[i2 + 1][0]) / 2;
      const my = (pts[i2][1] + pts[i2 + 1][1]) / 2;
      path.quadraticCurveTo(pts[i2][0], pts[i2][1], mx, my);
    }
    const last = pts[pts.length - 1];
    path.lineTo(last[0], last[1]);
    return path;
  }
  function buildShape(stroke) {
    var _a;
    const path = new Path2D();
    const pts = stroke.points;
    if (pts.length < 2) return path;
    const [x1, y1] = pts[0];
    const [x2, y2] = pts[pts.length - 1];
    const kind = (_a = stroke.shape) != null ? _a : "rect";
    if (kind === "rect") {
      path.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    } else if (kind === "ellipse") {
      path.ellipse(
        (x1 + x2) / 2,
        (y1 + y2) / 2,
        Math.abs(x2 - x1) / 2,
        Math.abs(y2 - y1) / 2,
        0,
        0,
        Math.PI * 2
      );
    } else {
      path.moveTo(x1, y1);
      path.lineTo(x2, y2);
      if (kind === "arrow") {
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const head = Math.max(10, stroke.size * 4);
        const spread = Math.PI / 7;
        path.moveTo(x2, y2);
        path.lineTo(x2 - head * Math.cos(angle - spread), y2 - head * Math.sin(angle - spread));
        path.moveTo(x2, y2);
        path.lineTo(x2 - head * Math.cos(angle + spread), y2 - head * Math.sin(angle + spread));
      }
    }
    return path;
  }
  function strokePath(stroke) {
    const cached = pathCache.get(stroke);
    if (cached) return cached;
    let path;
    if (stroke.tool === "shape") path = buildShape(stroke);
    else if (stroke.tool === "highlighter") path = buildPolyline(stroke);
    else path = buildInkPath(stroke);
    pathCache.set(stroke, path);
    return path;
  }
  function drawStroke(ctx, stroke, alpha = 1) {
    const pts = stroke.points;
    if (!pts.length) return;
    ctx.save();
    ctx.globalAlpha = stroke.opacity * alpha;
    if (stroke.tool === "highlighter") {
      ctx.globalCompositeOperation = "multiply";
      ctx.strokeStyle = stroke.color;
      ctx.fillStyle = stroke.color;
      ctx.lineWidth = stroke.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0][0], pts[0][1], stroke.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.stroke(strokePath(stroke));
      }
      ctx.restore();
      return;
    }
    if (stroke.tool === "shape") {
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke(strokePath(stroke));
      ctx.restore();
      return;
    }
    ctx.fillStyle = stroke.color;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], Math.max(0.45, stroke.size * 0.46), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fill(strokePath(stroke));
    }
    ctx.restore();
  }

  // src/paper.ts
  var PALETTES = {
    white: {
      bg: "#FFFFFF",
      line: "#DCE6F0",
      strong: "#C9D8E8",
      dot: "#B7C6D6",
      margin: "#EFC9C9"
    },
    cream: {
      bg: "#FCF8EC",
      line: "#E6DCC4",
      strong: "#D8C9A8",
      dot: "#C9B995",
      margin: "#E7C3B5"
    },
    gray: {
      bg: "#F5F5F3",
      line: "#DEDEDC",
      strong: "#CACAC7",
      dot: "#B6B6B2",
      margin: "#E3C5C5"
    }
  };
  function paperBackground(paper) {
    return (PALETTES[paper] || PALETTES.white).bg;
  }
  function drawPaper(ctx, template, paper, w2, h2, lineWidth = 1) {
    const p2 = PALETTES[paper] || PALETTES.white;
    const lw = Math.max(0.35, lineWidth);
    ctx.save();
    ctx.fillStyle = p2.bg;
    ctx.fillRect(0, 0, w2, h2);
    if (template === "blank") {
      ctx.restore();
      return;
    }
    ctx.lineWidth = lw;
    ctx.lineCap = "butt";
    if (template === "lined") {
      ctx.strokeStyle = p2.line;
      ctx.beginPath();
      for (let y2 = 112; y2 < h2 - 40; y2 += 34) {
        ctx.moveTo(54, y2 + lw / 2);
        ctx.lineTo(w2 - 42, y2 + lw / 2);
      }
      ctx.stroke();
      ctx.strokeStyle = p2.margin;
      ctx.beginPath();
      ctx.moveTo(78 + lw / 2, 64);
      ctx.lineTo(78 + lw / 2, h2 - 40);
      ctx.stroke();
    } else if (template === "grid") {
      ctx.lineWidth = Math.max(0.3, lw * 0.8);
      ctx.strokeStyle = p2.line;
      ctx.beginPath();
      for (let x2 = 24; x2 < w2; x2 += 24) {
        ctx.moveTo(x2 + ctx.lineWidth / 2, 0);
        ctx.lineTo(x2 + ctx.lineWidth / 2, h2);
      }
      for (let y2 = 24; y2 < h2; y2 += 24) {
        ctx.moveTo(0, y2 + ctx.lineWidth / 2);
        ctx.lineTo(w2, y2 + ctx.lineWidth / 2);
      }
      ctx.stroke();
      ctx.lineWidth = lw;
      ctx.strokeStyle = p2.strong;
      ctx.beginPath();
      for (let x2 = 96; x2 < w2; x2 += 96) {
        ctx.moveTo(x2 + lw / 2, 0);
        ctx.lineTo(x2 + lw / 2, h2);
      }
      ctx.stroke();
    } else if (template === "dotted") {
      ctx.fillStyle = p2.dot;
      const r2 = Math.max(1.05, lw * 1.15);
      for (let x2 = 12; x2 < w2; x2 += 24) {
        for (let y2 = 12; y2 < h2; y2 += 24) {
          ctx.beginPath();
          ctx.arc(x2, y2, r2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else if (template === "cornell") {
      ctx.strokeStyle = p2.line;
      ctx.beginPath();
      for (let y2 = 150; y2 < h2 - 56; y2 += 34) {
        ctx.moveTo(48, y2 + lw / 2);
        ctx.lineTo(w2 - 40, y2 + lw / 2);
      }
      ctx.stroke();
      ctx.strokeStyle = p2.strong;
      ctx.beginPath();
      ctx.moveTo(48, 132 + lw / 2);
      ctx.lineTo(w2 - 40, 132 + lw / 2);
      ctx.moveTo(w2 * 0.3 + lw / 2, 132);
      ctx.lineTo(w2 * 0.3 + lw / 2, h2 * 0.76);
      ctx.moveTo(48, h2 * 0.76 + lw / 2);
      ctx.lineTo(w2 - 40, h2 * 0.76 + lw / 2);
      ctx.stroke();
    } else if (template === "planner") {
      ctx.strokeStyle = p2.strong;
      ctx.beginPath();
      ctx.moveTo(48, 112 + lw / 2);
      ctx.lineTo(w2 - 40, 112 + lw / 2);
      ctx.moveTo(w2 * 0.24, 112);
      ctx.lineTo(w2 * 0.24, h2 - 40);
      ctx.stroke();
      ctx.strokeStyle = p2.line;
      ctx.beginPath();
      for (let i2 = 0; i2 < 7; i2++) {
        const y2 = 168 + i2 * 128;
        ctx.moveTo(48, y2 + lw / 2);
        ctx.lineTo(w2 - 40, y2 + lw / 2);
      }
      ctx.stroke();
      ctx.strokeStyle = p2.strong;
      ctx.beginPath();
      ctx.moveTo(48, 168 + lw / 2);
      ctx.lineTo(w2 - 40, 168 + lw / 2);
      ctx.stroke();
      ctx.strokeStyle = p2.margin;
      ctx.beginPath();
      ctx.moveTo(w2 - 40 - lw / 2, 112);
      ctx.lineTo(w2 - 40 - lw / 2, h2 - 40);
      ctx.stroke();
    }
    ctx.restore();
  }

  // src/geometry.ts
  var boundsCache = /* @__PURE__ */ new WeakMap();
  function clamp(v2, min, max) {
    return Math.min(max, Math.max(min, v2));
  }
  function distance(ax, ay, bx, by) {
    return Math.hypot(ax - bx, ay - by);
  }
  function pointSegmentDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return distance(px, py, ax, ay);
    let t2 = ((px - ax) * dx + (py - ay) * dy) / len2;
    t2 = clamp(t2, 0, 1);
    return distance(px, py, ax + t2 * dx, ay + t2 * dy);
  }
  function pointInPolygon(x2, y2, polygon) {
    let inside = false;
    for (let i2 = 0, j2 = polygon.length - 1; i2 < polygon.length; j2 = i2++) {
      const xi = polygon[i2][0];
      const yi = polygon[i2][1];
      const xj = polygon[j2][0];
      const yj = polygon[j2][1];
      if (yi > y2 !== yj > y2 && x2 < (xj - xi) * (y2 - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function strokeBounds(stroke) {
    const cached = boundsCache.get(stroke);
    if (cached) return cached;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x2, y2] of stroke.points) {
      if (x2 < minX) minX = x2;
      if (y2 < minY) minY = y2;
      if (x2 > maxX) maxX = x2;
      if (y2 > maxY) maxY = y2;
    }
    if (!Number.isFinite(minX)) minX = minY = maxX = maxY = 0;
    const pad = stroke.size / 2 + 5;
    const b2 = { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
    boundsCache.set(stroke, b2);
    return b2;
  }
  function invalidateStrokeBounds(stroke) {
    boundsCache.delete(stroke);
  }
  function boundsContain(b2, x2, y2) {
    return x2 >= b2.minX && x2 <= b2.maxX && y2 >= b2.minY && y2 <= b2.maxY;
  }
  function strokeHit(stroke, x2, y2, tolerance) {
    const b2 = strokeBounds(stroke);
    if (!boundsContain(b2, x2, y2)) return false;
    if (stroke.tool === "shape") return true;
    const pts = stroke.points;
    if (pts.length === 0) return false;
    const reach = tolerance + stroke.size / 2;
    if (pts.length === 1) return distance(x2, y2, pts[0][0], pts[0][1]) <= reach;
    for (let i2 = 1; i2 < pts.length; i2++) {
      if (pointSegmentDistance(x2, y2, pts[i2 - 1][0], pts[i2 - 1][1], pts[i2][0], pts[i2][1]) <= reach) {
        return true;
      }
    }
    return false;
  }
  function strokeInPolygon(stroke, polygon) {
    const pts = stroke.points;
    if (!pts.length) return false;
    let inside = 0;
    for (const [x2, y2] of pts) if (pointInPolygon(x2, y2, polygon)) inside++;
    if (inside / pts.length >= 0.55) return true;
    const b2 = strokeBounds(stroke);
    return pointInPolygon((b2.minX + b2.maxX) / 2, (b2.minY + b2.maxY) / 2, polygon);
  }
  function selectionBounds(strokes) {
    if (!strokes.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s2 of strokes) {
      const b2 = strokeBounds(s2);
      if (b2.minX < minX) minX = b2.minX;
      if (b2.minY < minY) minY = b2.minY;
      if (b2.maxX > maxX) maxX = b2.maxX;
      if (b2.maxY > maxY) maxY = b2.maxY;
    }
    return { minX, minY, maxX, maxY };
  }
  function translateStroke(stroke, dx, dy) {
    for (const p2 of stroke.points) {
      p2[0] += dx;
      p2[1] += dy;
    }
    invalidateStrokeBounds(stroke);
  }
  function splitStrokeByEraser(points, x2, y2, radius) {
    const out = [];
    let cur = [];
    const r2 = radius * radius;
    for (const p2 of points) {
      const dx = p2[0] - x2;
      const dy = p2[1] - y2;
      if (dx * dx + dy * dy <= r2) {
        if (cur.length >= 2) out.push(cur);
        cur = [];
      } else {
        cur.push([p2[0], p2[1], p2[2]]);
      }
    }
    if (cur.length >= 2) out.push(cur);
    return out;
  }

  // src/editor.ts
  var BookEditor = class {
    constructor(host, store2, opts = {}) {
      this.tool = "pen";
      this.penColor = "#1A1A1A";
      this.penSize = 2.8;
      this.highlighterColor = "#F2C84B";
      this.highlighterSize = 24;
      this.shapeKind = "rect";
      this.eraserMode = "part";
      this.eraserSize = 26;
      this.zoom = 0.8;
      this.fitMode = true;
      this.recs = [];
      this.observer = null;
      this.current = 0;
      this.gesture = "none";
      this.pointerId = null;
      this.draft = null;
      this.draftRec = null;
      this.lassoPoints = [];
      this.selectedIds = /* @__PURE__ */ new Set();
      this.selectedBox = null;
      this.eraserPos = null;
      this.undoPushed = false;
      this.lastPoint = null;
      this.lastPressure = null;
      this.pan = null;
      this.moveStart = null;
      this.overlayRaf = 0;
      this.scrollRaf = 0;
      this.destroyed = false;
      this.resizeObserver = null;
      this.host = host;
      this.store = store2;
      this.opts = opts;
      this.current = clamp(store2.data.activePage || 0, 0, store2.pageCount - 1);
      this.host.classList.add("mb-host");
      this.host.innerHTML = "";
      this.scrollEl = document.createElement("div");
      this.scrollEl.className = "mb-scroll";
      this.docEl = document.createElement("div");
      this.docEl.className = "mb-doc";
      this.scrollEl.appendChild(this.docEl);
      this.host.appendChild(this.scrollEl);
      this.scrollEl.addEventListener(
        "scroll",
        () => {
          if (this.scrollRaf) return;
          this.scrollRaf = requestAnimationFrame(() => {
            this.scrollRaf = 0;
            this.updateCurrentFromScroll();
          });
        },
        { passive: true }
      );
      if (typeof ResizeObserver !== "undefined") {
        this.resizeObserver = new ResizeObserver(() => {
          if (this.fitMode && !this.destroyed) this.applyLayout();
        });
        this.resizeObserver.observe(this.scrollEl);
      }
      this.renderPages();
      this.applyTouchAction();
      requestAnimationFrame(() => {
        this.applyLayout();
        this.goToPage(this.current, false);
        this.emitState();
      });
    }
    /* ------------------------------- 状态 ------------------------------- */
    getState() {
      const page = this.store.page;
      const layer = activeLayer(page);
      return {
        pageIndex: this.current,
        pageCount: this.store.pageCount,
        zoom: this.zoom,
        tool: this.tool,
        penColor: this.penColor,
        penSize: this.penSize,
        highlighterColor: this.highlighterColor,
        highlighterSize: this.highlighterSize,
        shapeKind: this.shapeKind,
        selectionCount: this.selectedIds.size,
        canUndo: this.store.canUndo(),
        canRedo: this.store.canRedo(),
        penOnly: !!this.opts.penOnly,
        activeLayerId: layer ? layer.id : "",
        layers: page.layers.map((l2) => ({
          id: l2.id,
          name: l2.name,
          visible: l2.visible,
          count: l2.strokes.length
        }))
      };
    }
    emitState() {
      if (this.opts.onState) this.opts.onState();
    }
    changed() {
      if (this.opts.onChange) this.opts.onChange();
    }
    setPenOnly(on) {
      this.opts.penOnly = on;
      this.applyTouchAction();
      this.emitState();
    }
    setPressure(v2) {
      this.opts.pressure = v2;
    }
    setTool(tool) {
      if (this.tool === tool) return;
      this.tool = tool;
      this.eraserPos = null;
      if (tool !== "lasso" && tool !== "hand") this.clearSelection();
      this.applyTouchAction();
      this.emitState();
    }
    setPenColor(color) {
      this.penColor = color;
      this.emitState();
    }
    setPenSize(size, silent = false) {
      this.penSize = size;
      if (!silent) this.emitState();
    }
    setHighlighterColor(color) {
      this.highlighterColor = color;
      this.emitState();
    }
    setHighlighterSize(size, silent = false) {
      this.highlighterSize = size;
      if (!silent) this.emitState();
    }
    setShapeKind(kind) {
      this.shapeKind = kind;
      this.emitState();
    }
    setEraserMode(mode) {
      this.eraserMode = mode;
      this.emitState();
    }
    /* ------------------------------- 页面 ------------------------------- */
    createPageRec(index, page) {
      const wrap = document.createElement("div");
      wrap.className = "mb-page-wrap";
      wrap.dataset.page = String(index);
      const pageEl = document.createElement("div");
      pageEl.className = "mb-page";
      pageEl.style.background = paperBackground(page.paper);
      const num = document.createElement("div");
      num.className = "mb-page-num";
      num.textContent = String(index + 1);
      wrap.appendChild(pageEl);
      wrap.appendChild(num);
      pageEl.addEventListener("pointerdown", (e2) => this.onDown(e2, rec));
      pageEl.addEventListener("pointermove", (e2) => this.onMove(e2, rec));
      pageEl.addEventListener("pointerup", (e2) => this.onUp(e2, rec));
      pageEl.addEventListener("pointercancel", (e2) => this.onUp(e2, rec));
      pageEl.addEventListener("pointerleave", (e2) => this.onLeave(e2, rec));
      pageEl.addEventListener("contextmenu", (e2) => {
        if (this.tool !== "hand") e2.preventDefault();
      });
      const rec = {
        index,
        wrap,
        pageEl,
        canvas: null,
        overlay: null,
        ctx: null,
        octx: null,
        mounted: false
      };
      return rec;
    }
    renderPages() {
      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }
      this.recs = [];
      this.docEl.innerHTML = "";
      this.store.data.pages.forEach((page, i2) => {
        const rec = this.createPageRec(i2, page);
        this.recs.push(rec);
        this.docEl.appendChild(rec.wrap);
      });
      const add = document.createElement("button");
      add.className = "mb-add-page";
      add.textContent = "\uFF0B \u6DFB\u52A0\u4E00\u9875";
      add.addEventListener("click", () => this.addPage());
      this.docEl.appendChild(add);
      this.current = clamp(this.store.data.activePage, 0, this.store.pageCount - 1);
      this.applyLayout();
      this.applyTouchAction();
      this.observePages();
      requestAnimationFrame(() => this.goToPage(this.current, false));
    }
    applyLayout() {
      if (this.fitMode) {
        const availW = Math.max(240, this.scrollEl.clientWidth - 64);
        const availH = Math.max(240, this.scrollEl.clientHeight - 46);
        this.zoom = clamp(
          Math.min(availW / this.store.data.width, availH / this.store.data.height),
          0.3,
          1.25
        );
      }
      const w2 = this.store.data.width * this.zoom;
      const h2 = this.store.data.height * this.zoom;
      for (const rec of this.recs) {
        rec.pageEl.style.width = `${w2}px`;
        rec.pageEl.style.height = `${h2}px`;
        if (rec.mounted) this.resizeRec(rec);
      }
      this.emitState();
    }
    setZoom(z) {
      this.fitMode = false;
      this.zoom = clamp(z, 0.3, 2.8);
      this.applyLayout();
    }
    zoomBy(factor) {
      this.setZoom(this.zoom * factor);
    }
    fit() {
      this.fitMode = true;
      this.applyLayout();
    }
    resizeRec(rec) {
      var _a, _b;
      if (!rec.canvas || !rec.overlay) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const w2 = Math.round(this.store.data.width * this.zoom * dpr);
      const h2 = Math.round(this.store.data.height * this.zoom * dpr);
      for (const c2 of [rec.canvas, rec.overlay]) {
        if (c2.width !== w2 || c2.height !== h2) {
          c2.width = w2;
          c2.height = h2;
        }
      }
      rec.ctx = rec.canvas.getContext("2d");
      rec.octx = rec.overlay.getContext("2d");
      const k2 = dpr * this.zoom;
      (_a = rec.ctx) == null ? void 0 : _a.setTransform(k2, 0, 0, k2, 0, 0);
      (_b = rec.octx) == null ? void 0 : _b.setTransform(k2, 0, 0, k2, 0, 0);
      this.renderRec(rec);
      this.renderOverlay(rec);
    }
    mount(rec) {
      if (rec.mounted) return;
      const page = this.store.data.pages[rec.index];
      if (!page) return;
      const canvas = document.createElement("canvas");
      canvas.className = "mb-canvas";
      const overlay = document.createElement("canvas");
      overlay.className = "mb-overlay";
      rec.pageEl.insertBefore(overlay, rec.pageEl.firstChild);
      rec.pageEl.insertBefore(canvas, overlay);
      rec.canvas = canvas;
      rec.overlay = overlay;
      rec.mounted = true;
      this.resizeRec(rec);
    }
    unmount(rec) {
      var _a, _b, _c;
      if (!rec.mounted) return;
      if (rec.index === this.current && this.gesture !== "none") return;
      (_a = rec.canvas) == null ? void 0 : _a.remove();
      (_b = rec.overlay) == null ? void 0 : _b.remove();
      rec.canvas = null;
      rec.overlay = null;
      rec.ctx = null;
      rec.octx = null;
      rec.mounted = false;
      rec.pageEl.style.background = paperBackground(
        ((_c = this.store.data.pages[rec.index]) == null ? void 0 : _c.paper) || "white"
      );
    }
    observePages() {
      if (typeof IntersectionObserver === "undefined") {
        for (const rec of this.recs) this.mount(rec);
        return;
      }
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const rec = this.recs[Number(entry.target.dataset.page)];
            if (!rec) continue;
            if (entry.isIntersecting) this.mount(rec);
            else this.unmount(rec);
          }
        },
        { root: this.scrollEl, rootMargin: "1000px 0px" }
      );
      for (const rec of this.recs) this.observer.observe(rec.wrap);
      const cur = this.recs[this.current];
      if (cur) this.mount(cur);
    }
    renderRec(rec) {
      const page = this.store.data.pages[rec.index];
      if (!page || !rec.ctx) return;
      const ctx = rec.ctx;
      ctx.clearRect(0, 0, this.store.data.width, this.store.data.height);
      drawPaper(ctx, page.template, page.paper, this.store.data.width, this.store.data.height, 1);
      for (const layer of page.layers) {
        if (!layer.visible) continue;
        for (const stroke of layer.strokes) drawStroke(ctx, stroke, layer.opacity);
      }
    }
    renderOverlay(rec) {
      if (!rec.octx) return;
      const ctx = rec.octx;
      const w2 = this.store.data.width;
      const h2 = this.store.data.height;
      ctx.clearRect(0, 0, w2, h2);
      if (rec.index !== this.current) return;
      if (this.draft && this.draftRec === rec) drawStroke(ctx, this.draft);
      if (this.lassoPoints.length > 1) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(this.lassoPoints[0][0], this.lassoPoints[0][1]);
        for (let i2 = 1; i2 < this.lassoPoints.length; i2++) {
          ctx.lineTo(this.lassoPoints[i2][0], this.lassoPoints[i2][1]);
        }
        ctx.closePath();
        ctx.fillStyle = "rgba(92, 80, 214, 0.08)";
        ctx.fill();
        ctx.strokeStyle = "#6C5CE7";
        ctx.lineWidth = 1.3 / this.zoom;
        ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);
        ctx.stroke();
        ctx.restore();
      }
      if (this.selectedBox) {
        const b2 = this.selectedBox;
        ctx.save();
        ctx.strokeStyle = "#6C5CE7";
        ctx.lineWidth = 1.3 / this.zoom;
        ctx.setLineDash([5 / this.zoom, 4 / this.zoom]);
        ctx.strokeRect(b2.minX, b2.minY, b2.maxX - b2.minX, b2.maxY - b2.minY);
        ctx.setLineDash([]);
        const s2 = 4 / this.zoom;
        ctx.fillStyle = "#FFFFFF";
        for (const [x2, y2] of [
          [b2.minX, b2.minY],
          [b2.maxX, b2.minY],
          [b2.minX, b2.maxY],
          [b2.maxX, b2.maxY]
        ]) {
          ctx.fillRect(x2 - s2, y2 - s2, s2 * 2, s2 * 2);
          ctx.strokeRect(x2 - s2, y2 - s2, s2 * 2, s2 * 2);
        }
        ctx.restore();
      }
      if (this.eraserPos) {
        const e2 = this.eraserPos;
        ctx.save();
        ctx.beginPath();
        ctx.arc(e2.x, e2.y, e2.r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.fill();
        ctx.strokeStyle = "rgba(60,60,60,0.7)";
        ctx.lineWidth = 1 / this.zoom;
        ctx.stroke();
        ctx.restore();
      }
    }
    scheduleOverlay(rec) {
      if (this.overlayRaf) return;
      this.overlayRaf = requestAnimationFrame(() => {
        this.overlayRaf = 0;
        if (rec.mounted) this.renderOverlay(rec);
      });
    }
    /* ------------------------------- 坐标与压力 ------------------------------- */
    pointFromEvent(e2, rec) {
      const r2 = rec.pageEl.getBoundingClientRect();
      const k2 = this.store.data.width / (r2.width || 1);
      return [
        (e2.clientX - r2.left) * k2,
        (e2.clientY - r2.top) * k2,
        0.5
      ];
    }
    pressureFor(e2, dist, dt) {
      var _a;
      if (this.tool === "ballpoint") return 0.55;
      const speed = dist / Math.max(1, dt);
      const vel = clamp(1 - speed / 2.3, 0.3, 0.95);
      let raw;
      if (e2.pointerType === "pen") {
        const p2 = e2.pressure > 0 ? e2.pressure : 0.5;
        const sens = (_a = this.opts.pressure) != null ? _a : 1;
        const shaped = clamp(0.5 + (p2 - 0.5) * sens, 0.06, 1);
        raw = shaped * 0.82 + vel * 0.18;
      } else {
        raw = vel;
      }
      if (this.lastPressure != null) raw = this.lastPressure * 0.32 + raw * 0.68;
      this.lastPressure = raw;
      return raw;
    }
    applyTouchAction() {
      const allowTouchScroll = !!this.opts.penOnly || this.tool === "hand";
      for (const rec of this.recs) {
        rec.pageEl.style.touchAction = allowTouchScroll ? "pan-x pan-y pinch-zoom" : "none";
      }
    }
    /* ------------------------------- 指针 ------------------------------- */
    onDown(e2, rec) {
      var _a, _b;
      if (e2.pointerType === "touch" && this.opts.penOnly) return;
      if (e2.pointerType === "mouse" && e2.button !== 0 && e2.button !== 1) return;
      if (this.gesture !== "none") return;
      this.current = rec.index;
      this.store.setPage(rec.index);
      this.emitState();
      if (this.tool === "hand" || e2.pointerType === "mouse" && e2.button === 1) {
        this.gesture = "pan";
        this.pointerId = e2.pointerId;
        this.pan = {
          x: e2.clientX,
          y: e2.clientY,
          left: this.scrollEl.scrollLeft,
          top: this.scrollEl.scrollTop
        };
        (_b = (_a = rec.pageEl).setPointerCapture) == null ? void 0 : _b.call(_a, e2.pointerId);
        e2.preventDefault();
        return;
      }
      e2.preventDefault();
      this.pointerId = e2.pointerId;
      try {
        rec.pageEl.setPointerCapture(e2.pointerId);
      } catch (_2) {
      }
      const p2 = this.pointFromEvent(e2, rec);
      this.lastPoint = { x: p2[0], y: p2[1], t: e2.timeStamp || performance.now() };
      this.lastPressure = null;
      this.undoPushed = false;
      if (this.tool === "eraser") {
        this.gesture = "erase";
        this.eraseAt(rec, p2[0], p2[1], e2);
        return;
      }
      if (this.tool === "lasso") {
        if (this.selectedBox && this.pointInBox(p2[0], p2[1], this.selectedBox)) {
          this.gesture = "move";
          this.moveStart = { x: p2[0], y: p2[1] };
          this.lastPoint = { x: p2[0], y: p2[1], t: e2.timeStamp || performance.now() };
          return;
        }
        this.clearSelection();
        this.gesture = "lasso";
        this.lassoPoints = [[p2[0], p2[1]]];
        this.scheduleOverlay(rec);
        return;
      }
      if (this.tool === "shape") {
        this.gesture = "shape";
        this.draftRec = rec;
        this.draft = {
          id: uid("draft"),
          tool: "shape",
          color: this.penColor,
          size: this.penSize,
          opacity: 1,
          points: [
            [p2[0], p2[1], 0.5],
            [p2[0], p2[1], 0.5]
          ],
          shape: this.shapeKind
        };
        this.scheduleOverlay(rec);
        return;
      }
      const highlighter = this.tool === "highlighter";
      const ballpoint = this.tool === "ballpoint";
      this.gesture = "draw";
      this.draftRec = rec;
      this.draft = {
        id: uid("draft"),
        tool: highlighter ? "highlighter" : ballpoint ? "ballpoint" : "pen",
        color: highlighter ? this.highlighterColor : this.penColor,
        size: highlighter ? this.highlighterSize : this.penSize,
        opacity: highlighter ? 0.32 : 1,
        points: [[p2[0], p2[1], this.pressureFor(e2, 0, 16)]]
      };
      this.scheduleOverlay(rec);
    }
    onMove(e2, rec) {
      if (this.pointerId != null && e2.pointerId !== this.pointerId) return;
      const p2 = this.pointFromEvent(e2, rec);
      if (this.gesture === "pan" && this.pan) {
        this.scrollEl.scrollLeft = this.pan.left - (e2.clientX - this.pan.x);
        this.scrollEl.scrollTop = this.pan.top - (e2.clientY - this.pan.y);
        return;
      }
      if (this.tool === "eraser" && this.gesture !== "draw" && this.gesture !== "lasso") {
        this.eraserPos = { x: p2[0], y: p2[1], r: this.eraserSize / 2 };
        this.scheduleOverlay(rec);
        if (this.gesture === "erase") this.eraseAt(rec, p2[0], p2[1], e2);
        return;
      }
      if (this.gesture === "lasso") {
        const last = this.lassoPoints[this.lassoPoints.length - 1];
        if (!last || Math.hypot(p2[0] - last[0], p2[1] - last[1]) > 2) {
          this.lassoPoints.push([p2[0], p2[1]]);
          this.scheduleOverlay(rec);
        }
        return;
      }
      if (this.gesture === "move" && this.moveStart) {
        const dx = p2[0] - this.moveStart.x;
        const dy = p2[1] - this.moveStart.y;
        if (!dx && !dy) return;
        if (!this.undoPushed) {
          this.store.snapshotPage(rec.index);
          this.undoPushed = true;
        }
        const page = this.store.data.pages[rec.index];
        const layer = activeLayer(page);
        for (const s2 of layer.strokes) {
          if (this.selectedIds.has(s2.id)) {
            translateStroke(s2, dx, dy);
            invalidateStroke(s2);
          }
        }
        this.moveStart = { x: p2[0], y: p2[1] };
        this.selectedBox = selectionBounds(
          layer.strokes.filter((s2) => this.selectedIds.has(s2.id))
        );
        this.renderRec(rec);
        this.scheduleOverlay(rec);
        return;
      }
      if (this.gesture === "draw" || this.gesture === "shape") {
        const events = typeof e2.getCoalescedEvents === "function" ? e2.getCoalescedEvents() || [e2] : [e2];
        for (const ev of events) this.appendPoint(ev, rec);
        this.scheduleOverlay(rec);
      }
    }
    appendPoint(e2, rec) {
      if (!this.draft) return;
      const p2 = this.pointFromEvent(e2, rec);
      const now = e2.timeStamp || performance.now();
      if (this.draft.tool === "shape") {
        let x2 = p2[0];
        let y2 = p2[1];
        const start = this.draft.points[0];
        if (e2.shiftKey) {
          if (this.draft.shape === "line" || this.draft.shape === "arrow") {
            const ang = Math.atan2(y2 - start[1], x2 - start[0]);
            const snapped = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(x2 - start[0], y2 - start[1]);
            x2 = start[0] + Math.cos(snapped) * len;
            y2 = start[1] + Math.sin(snapped) * len;
          } else {
            const size = Math.max(Math.abs(x2 - start[0]), Math.abs(y2 - start[1]));
            x2 = start[0] + Math.sign(x2 - start[0] || 1) * size;
            y2 = start[1] + Math.sign(y2 - start[1] || 1) * size;
          }
        }
        this.draft.points[1] = [x2, y2, 0.5];
        return;
      }
      const last = this.draft.points[this.draft.points.length - 1];
      const dist = last ? Math.hypot(p2[0] - last[0], p2[1] - last[1]) : 0;
      if (dist < 0.55) return;
      const dt = this.lastPoint ? now - this.lastPoint.t : 16;
      if (!this.undoPushed) {
        this.store.snapshotPage(rec.index);
        this.undoPushed = true;
      }
      const pressure = this.draft.tool === "highlighter" ? 0.5 : this.pressureFor(e2, dist, Math.max(1, dt));
      this.draft.points.push([p2[0], p2[1], pressure]);
      this.lastPoint = { x: p2[0], y: p2[1], t: now };
    }
    onUp(e2, rec) {
      var _a, _b;
      if (this.pointerId != null && e2.pointerId !== this.pointerId) return;
      try {
        (_b = (_a = rec.pageEl).releasePointerCapture) == null ? void 0 : _b.call(_a, e2.pointerId);
      } catch (_2) {
      }
      const gesture = this.gesture;
      this.gesture = "none";
      this.pointerId = null;
      this.pan = null;
      if (gesture === "draw" || gesture === "shape") {
        this.commitDraft(rec);
      } else if (gesture === "erase") {
        this.eraserPos = null;
        this.renderOverlay(rec);
      } else if (gesture === "lasso") {
        this.finishLasso(rec);
      } else if (gesture === "move") {
        this.moveStart = null;
        if (this.undoPushed) {
          this.store.touch();
          this.changed();
        }
      }
      this.emitState();
    }
    onLeave(e2, rec) {
      if (this.gesture === "erase" && this.eraserPos) {
        this.eraserPos = null;
        this.scheduleOverlay(rec);
      }
    }
    commitDraft(rec) {
      const draft = this.draft;
      this.draft = null;
      this.draftRec = null;
      if (!draft) return;
      if (draft.tool === "shape") {
        const a2 = draft.points[0];
        const b2 = draft.points[draft.points.length - 1];
        if (Math.hypot(b2[0] - a2[0], b2[1] - a2[1]) < 2) {
          this.renderOverlay(rec);
          return;
        }
        this.store.snapshotPage(rec.index);
        const stroke = {
          ...draft,
          id: uid("stroke"),
          points: [
            [a2[0], a2[1], 0.5],
            [b2[0], b2[1], 0.5]
          ]
        };
        this.store.addStroke(stroke, rec.index);
      } else {
        if (!draft.points.length) return;
        if (!this.undoPushed) {
          this.store.snapshotPage(rec.index);
          this.undoPushed = true;
        }
        this.store.addStroke({ ...draft, id: uid("stroke") }, rec.index);
      }
      this.renderRec(rec);
      this.renderOverlay(rec);
      this.changed();
      this.emitState();
    }
    finishLasso(rec) {
      const poly = this.lassoPoints;
      this.lassoPoints = [];
      if (poly.length < 3) {
        this.renderOverlay(rec);
        return;
      }
      const page = this.store.data.pages[rec.index];
      const layer = activeLayer(page);
      const ids = /* @__PURE__ */ new Set();
      for (const s2 of layer.strokes) {
        if (strokeInPolygon(s2, poly)) ids.add(s2.id);
      }
      this.selectedIds = ids;
      this.selectedBox = selectionBounds(layer.strokes.filter((s2) => ids.has(s2.id)));
      this.renderOverlay(rec);
      this.emitState();
    }
    clearSelection() {
      if (!this.selectedIds.size && !this.selectedBox) return;
      this.selectedIds.clear();
      this.selectedBox = null;
      const rec = this.recs[this.current];
      if (rec) this.scheduleOverlay(rec);
      this.emitState();
    }
    pointInBox(x2, y2, b2) {
      return x2 >= b2.minX && x2 <= b2.maxX && y2 >= b2.minY && y2 <= b2.maxY;
    }
    deleteSelection() {
      if (!this.selectedIds.size) return;
      const rec = this.recs[this.current];
      if (!rec) return;
      this.store.snapshotPage(rec.index);
      this.store.removeStrokes(this.selectedIds, rec.index);
      this.selectedIds.clear();
      this.selectedBox = null;
      this.renderRec(rec);
      this.renderOverlay(rec);
      this.changed();
      this.emitState();
    }
    eraseAt(rec, x2, y2, e2) {
      const page = this.store.data.pages[rec.index];
      const layer = activeLayer(page);
      const base = this.eraserSize / 2;
      const press = e2.pointerType === "pen" ? clamp(e2.pressure || 0.5, 0.05, 1) : 1;
      const radius = base * (0.55 + press * 1);
      let changed = false;
      const remove = /* @__PURE__ */ new Set();
      const replacements = [];
      for (const s2 of layer.strokes) {
        if (!strokeHit(s2, x2, y2, radius)) continue;
        if (this.eraserMode === "whole" || s2.tool === "shape") {
          remove.add(s2.id);
          changed = true;
          continue;
        }
        const pieces = splitStrokeByEraser(s2.points, x2, y2, radius);
        const kept = pieces.reduce((n2, p2) => n2 + p2.length, 0);
        if (kept >= s2.points.length) continue;
        const made = pieces.map((pts) => ({
          ...s2,
          id: uid("stroke"),
          points: pts
        }));
        replacements.push({ oldId: s2.id, pieces: made });
        changed = true;
      }
      if (!changed) return;
      if (!this.undoPushed) {
        this.store.snapshotPage(rec.index);
        this.undoPushed = true;
      }
      if (remove.size) this.store.removeStrokes(remove, rec.index);
      for (const r2 of replacements) this.store.replaceStroke(r2.oldId, r2.pieces, rec.index);
      this.store.touch();
      this.renderRec(rec);
      this.changed();
    }
    /* ------------------------------- 页面操作 ------------------------------- */
    addPage() {
      const index = this.store.addPage(this.current);
      this.current = index;
      this.renderPages();
      requestAnimationFrame(() => this.goToPage(index, false));
    }
    deletePage(index = this.current) {
      if (!this.store.deletePage(index)) return;
      this.current = clamp(index, 0, this.store.pageCount - 1);
      this.renderPages();
      requestAnimationFrame(() => this.goToPage(this.current, false));
    }
    duplicatePage(index = this.current) {
      const at = this.store.duplicatePage(index);
      this.current = at;
      this.renderPages();
      requestAnimationFrame(() => this.goToPage(at, false));
    }
    setTemplate(template, all = false) {
      if (all) this.store.setAllTemplates(template);
      else this.store.setTemplate(this.current, template);
      for (const rec of this.recs) {
        const page = this.store.data.pages[rec.index];
        if (page) rec.pageEl.style.background = paperBackground(page.paper);
        if (rec.mounted) this.renderRec(rec);
      }
      this.changed();
      this.emitState();
    }
    setPaper(paper) {
      this.store.setPaper(this.current, paper);
      const rec = this.recs[this.current];
      if (rec) {
        rec.pageEl.style.background = paperBackground(paper);
        if (rec.mounted) this.renderRec(rec);
      }
      this.changed();
      this.emitState();
    }
    /* ------------------------------- 图层 ------------------------------- */
    addLayer() {
      this.store.addLayer(this.current);
      const rec = this.recs[this.current];
      if (rec == null ? void 0 : rec.mounted) this.renderRec(rec);
      this.changed();
      this.emitState();
    }
    setActiveLayer(id) {
      this.store.setActiveLayer(this.current, id);
      this.clearSelection();
      this.emitState();
    }
    toggleLayer(id) {
      this.store.toggleLayer(this.current, id);
      const rec = this.recs[this.current];
      if (rec == null ? void 0 : rec.mounted) this.renderRec(rec);
      this.changed();
      this.emitState();
    }
    deleteLayer(id) {
      if (!this.store.deleteLayer(this.current, id)) return;
      const rec = this.recs[this.current];
      if (rec == null ? void 0 : rec.mounted) this.renderRec(rec);
      this.changed();
      this.emitState();
    }
    renameLayer(id, name) {
      this.store.renameLayer(this.current, id, name);
      this.changed();
      this.emitState();
    }
    /* ------------------------------- 缩放与页面定位 ------------------------------- */
    scrollToPage(index, smooth = true) {
      const rec = this.recs[clamp(index, 0, this.recs.length - 1)];
      if (!rec) return;
      this.current = rec.index;
      this.store.setPage(rec.index);
      this.mount(rec);
      const sr = this.scrollEl.getBoundingClientRect();
      const top = rec.wrap.getBoundingClientRect().top - sr.top + this.scrollEl.scrollTop - 16;
      this.scrollEl.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
      this.emitState();
      if (this.opts.onPageChange) this.opts.onPageChange(rec.index);
    }
    goToPage(index, smooth = true) {
      this.scrollToPage(index, smooth);
    }
    updateCurrentFromScroll() {
      if (!this.recs.length) return;
      const sr = this.scrollEl.getBoundingClientRect();
      const mid = sr.top + Math.min(sr.height * 0.42, 460);
      let best = this.current;
      let bestD = Infinity;
      for (const rec of this.recs) {
        const b2 = rec.wrap.getBoundingClientRect();
        if (b2.top <= mid && b2.bottom >= mid) {
          best = rec.index;
          bestD = -1;
          break;
        }
        const d2 = Math.abs((b2.top + b2.bottom) / 2 - mid);
        if (d2 < bestD) {
          bestD = d2;
          best = rec.index;
        }
      }
      if (best !== this.current) {
        this.current = best;
        this.store.setPage(best);
        this.clearSelection();
        this.emitState();
        if (this.opts.onPageChange) this.opts.onPageChange(best);
      }
    }
    /* ------------------------------- 撤销 ------------------------------- */
    undo() {
      if (!this.store.undo()) return;
      if (this.recs.length !== this.store.pageCount) {
        this.current = this.store.data.activePage;
        this.renderPages();
      } else {
        this.current = clamp(this.store.data.activePage, 0, this.recs.length - 1);
        for (const rec2 of this.recs) if (rec2.mounted) this.renderRec(rec2);
        const rec = this.recs[this.current];
        if (rec) this.renderOverlay(rec);
      }
      this.changed();
      this.emitState();
    }
    redo() {
      if (!this.store.redo()) return;
      if (this.recs.length !== this.store.pageCount) {
        this.current = this.store.data.activePage;
        this.renderPages();
      } else {
        this.current = clamp(this.store.data.activePage, 0, this.recs.length - 1);
        for (const rec2 of this.recs) if (rec2.mounted) this.renderRec(rec2);
        const rec = this.recs[this.current];
        if (rec) this.renderOverlay(rec);
      }
      this.changed();
      this.emitState();
    }
    /* ------------------------------- 导出/缩略图 ------------------------------- */
    renderThumbnail(canvas, index) {
      const page = this.store.data.pages[index];
      if (!page) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const cssW = rect.width || 60;
      const cssH = rect.height || 84;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const kx = cssW * dpr / this.store.data.width;
      const ky = cssH * dpr / this.store.data.height;
      ctx.scale(kx, ky);
      drawPaper(
        ctx,
        page.template,
        page.paper,
        this.store.data.width,
        this.store.data.height,
        0.85 * dpr / kx
      );
      for (const layer of page.layers) {
        if (!layer.visible) continue;
        for (const s2 of layer.strokes) drawStroke(ctx, s2, layer.opacity);
      }
    }
    exportPageCanvas(index, scale = 2) {
      const page = this.store.data.pages[index];
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(this.store.data.width * scale);
      canvas.height = Math.round(this.store.data.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);
      drawPaper(ctx, page.template, page.paper, this.store.data.width, this.store.data.height, 1);
      for (const layer of page.layers) {
        if (!layer.visible) continue;
        for (const s2 of layer.strokes) drawStroke(ctx, s2, layer.opacity);
      }
      return canvas;
    }
    destroy() {
      var _a;
      this.destroyed = true;
      (_a = this.resizeObserver) == null ? void 0 : _a.disconnect();
      this.resizeObserver = null;
      if (this.observer) this.observer.disconnect();
      this.observer = null;
      if (this.overlayRaf) cancelAnimationFrame(this.overlayRaf);
      if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
      this.host.innerHTML = "";
    }
  };

  // src/store.ts
  var BookStore = class {
    constructor(book2) {
      this.onChange = () => {
      };
      this.undoStack = [];
      this.redoStack = [];
      this.data = book2;
    }
    touch() {
      this.data.updated = Date.now();
      this.onChange();
    }
    get page() {
      return this.data.pages[this.data.activePage] || this.data.pages[0];
    }
    get layer() {
      return activeLayer(this.page);
    }
    get pageCount() {
      return this.data.pages.length;
    }
    get strokeCount() {
      let n2 = 0;
      for (const page of this.data.pages) {
        for (const layer of page.layers) n2 += layer.strokes.length;
      }
      return n2;
    }
    /* ------------------------------- 撤销栈 ------------------------------- */
    snapshotPage(index = this.data.activePage) {
      const page = this.data.pages[index];
      if (!page) return;
      this.undoStack.push({
        kind: "page",
        pageId: page.id,
        pageIndex: index,
        data: JSON.stringify(page)
      });
      if (this.undoStack.length > 40) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    snapshotBook() {
      this.undoStack.push({
        kind: "book",
        data: JSON.stringify({ pages: this.data.pages, activePage: this.data.activePage })
      });
      if (this.undoStack.length > 40) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    canUndo() {
      return this.undoStack.length > 0;
    }
    canRedo() {
      return this.redoStack.length > 0;
    }
    currentEntry() {
      const page = this.page;
      return {
        kind: "page",
        pageId: page.id,
        pageIndex: this.data.activePage,
        data: JSON.stringify(page)
      };
    }
    undo() {
      const entry = this.undoStack.pop();
      if (!entry) return false;
      this.redoStack.push(this.currentEntry());
      this.apply(entry);
      return true;
    }
    redo() {
      const entry = this.redoStack.pop();
      if (!entry) return false;
      this.undoStack.push(this.currentEntry());
      this.apply(entry);
      return true;
    }
    apply(entry) {
      if (entry.kind === "book") {
        const obj = JSON.parse(entry.data);
        this.data.pages = obj.pages;
        this.data.activePage = Math.min(obj.activePage, this.data.pages.length - 1);
      } else {
        const page = JSON.parse(entry.data);
        const index = this.data.pages.findIndex((p2) => p2.id === entry.pageId);
        const at = index >= 0 ? index : Math.min(entry.pageIndex, this.data.pages.length - 1);
        this.data.pages[at] = page;
        this.data.activePage = at;
      }
      this.touch();
    }
    /* ------------------------------- 页面 ------------------------------- */
    setPage(index) {
      if (index < 0 || index >= this.data.pages.length) return;
      this.data.activePage = index;
    }
    addPage(after = this.data.activePage) {
      this.snapshotBook();
      const prev = this.data.pages[after];
      const page = createPage(prev ? prev.template : "grid", prev ? prev.paper : "white");
      this.data.pages.splice(after + 1, 0, page);
      this.data.activePage = after + 1;
      this.touch();
      return after + 1;
    }
    deletePage(index) {
      if (this.data.pages.length <= 1) return false;
      this.snapshotBook();
      this.data.pages.splice(index, 1);
      this.data.activePage = Math.min(index, this.data.pages.length - 1);
      this.touch();
      return true;
    }
    duplicatePage(index) {
      var _a;
      const src = this.data.pages[index];
      if (!src) return index;
      this.snapshotBook();
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = uid("page");
      for (const layer of copy.layers) {
        layer.id = uid("layer");
        for (const stroke of layer.strokes) stroke.id = uid("stroke");
      }
      copy.activeLayerId = ((_a = copy.layers[0]) == null ? void 0 : _a.id) || "";
      this.data.pages.splice(index + 1, 0, copy);
      this.data.activePage = index + 1;
      this.touch();
      return index + 1;
    }
    setTemplate(index, template) {
      const page = this.data.pages[index];
      if (!page || page.template === template) return;
      this.snapshotPage(index);
      page.template = template;
      this.touch();
    }
    setPaper(index, paper) {
      const page = this.data.pages[index];
      if (!page || page.paper === paper) return;
      this.snapshotPage(index);
      page.paper = paper;
      this.touch();
    }
    setAllTemplates(template) {
      this.snapshotBook();
      for (const page of this.data.pages) page.template = template;
      this.touch();
    }
    /* ------------------------------- 图层 ------------------------------- */
    addLayer(pageIndex = this.data.activePage) {
      const page = this.data.pages[pageIndex];
      if (!page) return;
      this.snapshotPage(pageIndex);
      const layer = createLayer(`\u56FE\u5C42 ${page.layers.length + 1}`);
      page.layers.push(layer);
      page.activeLayerId = layer.id;
      this.touch();
    }
    deleteLayer(pageIndex, layerId) {
      const page = this.data.pages[pageIndex];
      if (!page || page.layers.length <= 1) return false;
      this.snapshotPage(pageIndex);
      page.layers = page.layers.filter((l2) => l2.id !== layerId);
      if (page.activeLayerId === layerId) page.activeLayerId = page.layers[page.layers.length - 1].id;
      this.touch();
      return true;
    }
    renameLayer(pageIndex, layerId, name) {
      const page = this.data.pages[pageIndex];
      const layer = page && page.layers.find((l2) => l2.id === layerId);
      if (!layer || !name.trim() || layer.name === name.trim()) return;
      this.snapshotPage(pageIndex);
      layer.name = name.trim();
      this.touch();
    }
    toggleLayer(pageIndex, layerId) {
      const page = this.data.pages[pageIndex];
      const layer = page && page.layers.find((l2) => l2.id === layerId);
      if (!layer) return;
      this.snapshotPage(pageIndex);
      layer.visible = !layer.visible;
      this.touch();
    }
    setActiveLayer(pageIndex, layerId) {
      const page = this.data.pages[pageIndex];
      if (!page || !page.layers.some((l2) => l2.id === layerId)) return;
      page.activeLayerId = layerId;
      this.touch();
    }
    /* ------------------------------- 笔迹 ------------------------------- */
    addStroke(stroke, pageIndex = this.data.activePage, layerId) {
      const page = this.data.pages[pageIndex];
      if (!page) return;
      const layer = layerId && page.layers.find((l2) => l2.id === layerId) || activeLayer(page);
      layer.strokes.push(stroke);
      this.touch();
    }
    removeStrokes(ids, pageIndex = this.data.activePage) {
      const page = this.data.pages[pageIndex];
      if (!page) return;
      for (const layer of page.layers) {
        layer.strokes = layer.strokes.filter((s2) => !ids.has(s2.id));
      }
      this.touch();
    }
    replaceStroke(oldId, pieces, pageIndex = this.data.activePage) {
      const page = this.data.pages[pageIndex];
      if (!page) return;
      for (const layer of page.layers) {
        const idx = layer.strokes.findIndex((s2) => s2.id === oldId);
        if (idx >= 0) {
          layer.strokes.splice(idx, 1, ...pieces);
          return;
        }
      }
    }
  };

  // demo/demo.ts
  function mkStroke(tool, color, size, points, opacity = 1) {
    return {
      id: Math.random().toString(36).slice(2),
      tool,
      color,
      size,
      opacity,
      points
    };
  }
  function bezier(a2, b2, c2, d2, n2 = 160, press = (t2) => 0.18 + 0.78 * Math.pow(Math.sin(Math.PI * t2), 0.55)) {
    const out = [];
    for (let i2 = 0; i2 <= n2; i2++) {
      const t2 = i2 / n2;
      const u2 = 1 - t2;
      const x2 = u2 * u2 * u2 * a2[0] + 3 * u2 * u2 * t2 * b2[0] + 3 * u2 * t2 * t2 * c2[0] + t2 * t2 * t2 * d2[0];
      const y2 = u2 * u2 * u2 * a2[1] + 3 * u2 * u2 * t2 * b2[1] + 3 * u2 * t2 * t2 * c2[1] + t2 * t2 * t2 * d2[1];
      out.push([x2, y2, press(t2)]);
    }
    return out;
  }
  function loops() {
    const out = [];
    for (let i2 = 0; i2 <= 260; i2++) {
      const t2 = i2 / 260;
      const x2 = 110 + t2 * 560;
      const y2 = 420 + Math.sin(t2 * Math.PI * 7) * (52 - t2 * 12);
      const p2 = 0.22 + 0.7 * Math.abs(Math.sin(t2 * Math.PI * 3.5));
      out.push([x2, y2, p2]);
    }
    return out;
  }
  function signature() {
    const out = [];
    const p2 = [
      [120, 640],
      [170, 530],
      [250, 720],
      [360, 560],
      [470, 690],
      [620, 600]
    ];
    for (let i2 = 0; i2 < p2.length - 1; i2++) {
      const seg = bezier(p2[i2], [p2[i2][0] + 40, p2[i2][1] - 80], [p2[i2 + 1][0] - 40, p2[i2 + 1][1] + 80], p2[i2 + 1], 46, (t2) => {
        const into = i2 / (p2.length - 1);
        const base = 0.35 + 0.5 * Math.sin((into + t2 / (p2.length - 1)) * Math.PI);
        return 0.16 + base * 0.7;
      });
      out.push(...seg);
    }
    return out;
  }
  var app = document.getElementById("app");
  var book = createBook("\u58A8\u672C \xB7 \u624B\u611F\u6D4B\u8BD5", "grid", "white");
  book.pages[0].layers[0].strokes.push(
    mkStroke("pen", "#1A1A1A", 3.2, bezier([100, 230], [260, 90], [480, 360], [690, 210], 220)),
    mkStroke("pen", "#1F5FBF", 2.6, loops()),
    mkStroke("pen", "#D64545", 2.2, signature()),
    mkStroke("pen", "#2E8B57", 1.6, bezier([110, 780], [300, 760], [420, 800], [690, 770], 120, () => 0.22)),
    mkStroke("highlighter", "#F6E05E", 26, [
      [105, 300, 0.5],
      [420, 302, 0.5],
      [690, 300, 0.5]
    ], 0.42)
  );
  book.pages[0].layers[0].strokes.push(
    mkStroke("shape", "#7C5CD6", 1.8, [
      [500, 840, 0.5],
      [700, 960, 0.5]
    ])
  );
  book.pages.push(createPage("lined", "cream"));
  book.pages[1].layers[0].strokes.push(
    mkStroke("pen", "#1A1A1A", 2.8, bezier([110, 260], [260, 160], [430, 380], [680, 240], 180))
  );
  var store = new BookStore(book);
  var editor;
  editor = new BookEditor(app, store, {
    penOnly: false,
    pressure: 1,
    onState: () => sync(),
    onChange: () => {
    },
    onPageChange: () => sync()
  });
  var toolBtns = {
    pen: document.getElementById("t-pen"),
    ballpoint: document.getElementById("t-ball"),
    highlighter: document.getElementById("t-hl"),
    eraser: document.getElementById("t-eraser"),
    lasso: document.getElementById("t-lasso"),
    shape: document.getElementById("t-shape"),
    hand: document.getElementById("t-hand")
  };
  for (const [tool, btn] of Object.entries(toolBtns)) {
    btn.addEventListener("click", () => editor.setTool(tool));
  }
  var colorsEl = document.getElementById("colors");
  for (const c2 of PEN_COLORS) {
    const s2 = document.createElement("div");
    s2.className = "mb-swatch";
    s2.style.background = c2;
    s2.title = c2;
    s2.dataset.color = c2;
    s2.addEventListener("click", () => {
      editor.setTool("pen");
      editor.setPenColor(c2);
      sync();
    });
    colorsEl.appendChild(s2);
  }
  var sizeEl = document.getElementById("size");
  var sizeLbl = document.getElementById("size-lbl");
  sizeEl.addEventListener("input", () => {
    const v2 = Number(sizeEl.value);
    if (editor.getState().tool === "highlighter") editor.setHighlighterSize(v2, true);
    else editor.setPenSize(v2, true);
    sizeLbl.textContent = String(Math.round(v2 * 10) / 10);
  });
  var tplEl = document.getElementById("tpl");
  for (const [id, label] of [
    ["blank", "\u7A7A\u767D"],
    ["lined", "\u6A2A\u7EBF"],
    ["grid", "\u7F51\u683C"],
    ["dotted", "\u70B9\u9635"],
    ["cornell", "\u5EB7\u5948\u5C14"],
    ["planner", "\u5468\u8BA1\u5212"]
  ]) {
    const o2 = document.createElement("option");
    o2.value = id;
    o2.textContent = label;
    tplEl.appendChild(o2);
  }
  tplEl.addEventListener("change", () => editor.setTemplate(tplEl.value));
  document.getElementById("undo").addEventListener("click", () => editor.undo());
  document.getElementById("redo").addEventListener("click", () => editor.redo());
  document.getElementById("add").addEventListener("click", () => editor.addPage());
  document.getElementById("fit").addEventListener("click", () => editor.fit());
  document.getElementById("zoomout").addEventListener("click", () => editor.zoomBy(1 / 1.15));
  document.getElementById("zoomin").addEventListener("click", () => editor.zoomBy(1.15));
  function sync() {
    if (!editor) return;
    const s2 = editor.getState();
    for (const [id, btn] of Object.entries(toolBtns)) btn.classList.toggle("is-active", s2.tool === id);
    for (const el of Array.from(colorsEl.children)) {
      el.classList.toggle("is-active", (el.dataset.color || "").toLowerCase() === s2.penColor.toLowerCase());
    }
    const v2 = s2.tool === "highlighter" ? s2.highlighterSize : s2.penSize;
    sizeEl.value = String(v2);
    sizeLbl.textContent = String(Math.round(v2 * 10) / 10);
    document.getElementById("zoom").textContent = Math.round(s2.zoom * 100) + "%";
    document.getElementById("undo").classList.toggle("is-disabled", !s2.canUndo);
    document.getElementById("redo").classList.toggle("is-disabled", !s2.canRedo);
    tplEl.value = store.page.template;
  }
  document.addEventListener("keydown", (e2) => {
    var _a;
    if (((_a = e2.target) == null ? void 0 : _a.tagName) === "INPUT") return;
    const k2 = e2.key.toLowerCase();
    if (e2.ctrlKey || e2.metaKey) {
      if (k2 === "z") {
        e2.preventDefault();
        if (e2.shiftKey) editor.redo();
        else editor.undo();
      }
      return;
    }
    if (k2 === "p") editor.setTool("pen");
    else if (k2 === "b") editor.setTool("ballpoint");
    else if (k2 === "h") editor.setTool("highlighter");
    else if (k2 === "e") editor.setTool("eraser");
    else if (k2 === "l") editor.setTool("lasso");
    else if (k2 === "r") editor.setTool("shape");
    else if (k2 === "0") editor.fit();
    else if (k2 === "+" || k2 === "=") editor.zoomBy(1.15);
    else if (k2 === "-") editor.zoomBy(1 / 1.15);
  });
  sync();
  window.__inkbook = { editor, store };
})();
