import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/**
 * 发一个文件。
 *
 * 两处都是被真实故障逼出来的（不是"顺手加健壮性"）：
 *
 * 1. **支持 Range（206）**。pdf.js 打开底图时会发 `Range: bytes=...`，
 *    不支持就退化成整份重下；同一份 PDF 被主视图、缩略图、自检同时请求时，
 *    反复整读既慢又容易和客户端的 abort 撞上。有了 206，
 *    与 Obsidian 里 `app://` 的行为也更接近。
 *
 * 2. **流必须挂 error / close**。之前是裸的 `createReadStream(...).pipe(res)`：
 *    pdf.js 拿到第一段就 abort 连接时，流向已销毁的 res 写入 → 未捕获的
 *    EPIPE/'write after end' → **整个测试服务进程直接死掉**，后续所有 fetch
 *    都变成 `TypeError: Failed to fetch`，套件从那一档开始全是假数据
 *    （实测 C 档 openTotal 量到 2.8ms、缩略图 0 条，就是这么来的）。
 */
function send(res, file, req) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('404 ' + file);
    return;
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const size = fs.statSync(file).size;

  // Range: bytes=start-end（end 可省略）
  const range = req && req.headers && req.headers.range;
  let start = 0;
  let end = size - 1;
  let partial = false;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      if (m[1]) {
        start = Number(m[1]);
        if (m[2]) end = Math.min(Number(m[2]), size - 1);
      } else if (m[2]) {
        // bytes=-N：最后 N 字节
        start = Math.max(0, size - Number(m[2]));
      }
      if (!(start >= 0 && start <= end && start < size)) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      partial = true;
    }
  }

  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(partial ? end - start + 1 : size),
  };
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(partial ? 206 : 200, headers);

  const stream = partial
    ? fs.createReadStream(file, { start, end })
    : fs.createReadStream(file);
  // 客户端提前断开是常态（pdf.js 拿到需要的段就 abort），不能让它把进程带走
  stream.on('error', () => {
    try {
      res.destroy();
    } catch (_) {
      /* 已经断了就算了 */
    }
  });
  res.on('close', () => stream.destroy());
  res.on('error', () => stream.destroy());
  stream.pipe(res);
}

http
  .createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/' || p === '/index.html') return send(res, path.join(root, 'demo/index.html'), req);
    if (p === '/demo.js') return send(res, path.join(root, 'demo/demo.js'), req);
    if (p === '/styles.css') return send(res, path.join(root, 'styles.css'), req);
    if (p === '/test.html') return send(res, path.join(root, 'test/test.html'), req);
    if (p === '/harness.js') return send(res, path.join(root, 'test/harness.js'), req);
    if (p === '/pdf.html') return send(res, path.join(root, 'test/pdf.html'), req);
    if (p === '/pdf-harness.js') return send(res, path.join(root, 'test/pdf-harness.js'), req);
    if (p === '/test/sample.pdf') return send(res, path.join(root, 'test/sample.pdf'), req);
    // INK-118 复现用的空白 A4 底图：走 copyPages 那条导出路径时，
    // 底下不能带原文文字，否则渲染出来的深色像素没法区分是谁的墨。
    if (p === '/test/blank.pdf') return send(res, path.join(root, 'test/blank.pdf'), req);
    if (p === '/bigpdf.html') return send(res, path.join(root, 'test/bigpdf.html'), req);
    if (p === '/bigpdf-harness.js') return send(res, path.join(root, 'test/bigpdf-harness.js'), req);
    if (p === '/test/big.pdf') return send(res, path.join(root, 'test/big.pdf'), req);
    if (p === '/zoom.html') return send(res, path.join(root, 'test/zoom.html'), req);
    if (p === '/zoom-harness.js') return send(res, path.join(root, 'test/zoom-harness.js'), req);
    if (p === '/perf.html') return send(res, path.join(root, 'test/perf.html'), req);
    if (p === '/perf-harness.js') return send(res, path.join(root, 'test/perf-harness.js'), req);
    if (p === '/perf-open.html') return send(res, path.join(root, 'test/perf-open.html'), req);
    if (p === '/perf-open-harness.js') return send(res, path.join(root, 'test/perf-open-harness.js'), req);
    // 打开大本子的性能样本（由 test/make-open-samples.mjs 生成，不入库）
    if (p.startsWith('/test/samples/') && p.endsWith('.inkbook')) {
      const cand = path.join(root, p.replace(/^\/+/, ''));
      if (cand.startsWith(path.join(root, 'test', 'samples') + path.sep)) {
        return send(res, cand, req);
      }
    }
    /*
     * 样本里 background.pdf 引用的那两个 PDF 文件名。
     *
     * 必须给到**页数够多**的 PDF（test/make-open-samples.mjs 生成的 900 页那份）：
     * 只给 1 页的空白 PDF 时，pdf.js 会对第 2~300 页全部报
     * `Invalid page request`，C 档就变成在测"底图加载失败"的路径，
     * 底图这条链路等于没测。900 页同时覆盖 C（300 页）和 D（857 页）。
     */
    if (p === '/大文档.pdf' || p === '/中西医结合妇产科学.pdf') {
      const samplePdf = path.join(root, 'test/samples/大文档.pdf');
      return send(res, fs.existsSync(samplePdf) ? samplePdf : path.join(root, 'test/blank.pdf'), req);
    }
    if (p === '/view.html') return send(res, path.join(root, 'test/view.html'), req);
    if (p === '/view-harness.js') return send(res, path.join(root, 'test/view-harness.js'), req);
    if (p === '/jumptest.html') return send(res, path.join(root, 'test/jumptest.html'), req);
    if (p === '/jumptest.js') return send(res, path.join(root, 'test/jumptest.js'), req);
    if (p === '/touch.html') return send(res, path.join(root, 'test/touch.html'), req);
    if (p === '/touch-harness.js') return send(res, path.join(root, 'test/touch-harness.js'), req);
    if (p === '/swipe.html') return send(res, path.join(root, 'test/swipe.html'), req);
    if (p === '/swipe-harness.js') return send(res, path.join(root, 'test/swipe-harness.js'), req);
    if (p === '/dock.html') return send(res, path.join(root, 'test/dock.html'), req);
    if (p === '/dock-harness.js') return send(res, path.join(root, 'test/dock-harness.js'), req);
    if (p === '/dockpreview.html') return send(res, path.join(root, 'test/dockpreview.html'), req);
    if (p === '/dockpreview.js') return send(res, path.join(root, 'test/dockpreview.js'), req);
    if (p === '/diag.html') return send(res, path.join(root, 'test/diag.html'), req);
    if (p === '/feel-diag.js') return send(res, path.join(root, 'test/feel-diag.js'), req);
    if (p === '/e2e.html') return send(res, path.join(root, 'test/e2e.html'), req);
    if (p === '/feel-e2e.js') return send(res, path.join(root, 'test/feel-e2e.js'), req);
    if (p === '/compare.html') return send(res, path.join(root, 'test/compare.html'), req);
    if (p === '/feel-compare.js') return send(res, path.join(root, 'test/feel-compare.js'), req);
    if (p === '/tablet.html') return send(res, path.join(root, 'test/tablet.html'), req);
    if (p === '/tablet-harness.js') return send(res, path.join(root, 'test/tablet-harness.js'), req);
    if (p === '/dist.html') return send(res, path.join(root, 'test/dist.html'), req);
    if (p === '/dist-harness.js') return send(res, path.join(root, 'test/dist-harness.js'), req);
    if (p === '/dist/inkbook/main.js') return send(res, path.join(root, 'dist/inkbook/main.js'), req);
    if (p === '/feel.html') return send(res, path.join(root, 'test/feel.html'), req);
    if (p === '/feel-harness.js') return send(res, path.join(root, 'test/feel-harness.js'), req);
    if (p === '/plugin.html') return send(res, path.join(root, 'test/plugin.html'), req);
    if (p === '/plugin-harness.js') return send(res, path.join(root, 'test/plugin-harness.js'), req);
    // 兜底：test/ 下的静态文件（新增 harness 不必每加一个就改路由表）
    if (/\.(html|js|mjs|css)$/.test(p)) {
      const testRoot = path.join(root, 'test');
      const cand = path.join(testRoot, p.replace(/^\/+/, ''));
      if (cand.startsWith(testRoot + path.sep) || cand === testRoot) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return send(res, cand, req);
      }
    }
    res.writeHead(404).end('404');
  })
  .listen(Number(process.env.PORT) || 8901, '127.0.0.1', () => console.log('http://127.0.0.1:8901'));
