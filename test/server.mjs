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

function send(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('404 ' + file);
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

http
  .createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/' || p === '/index.html') return send(res, path.join(root, 'demo/index.html'));
    if (p === '/demo.js') return send(res, path.join(root, 'demo/demo.js'));
    if (p === '/styles.css') return send(res, path.join(root, 'styles.css'));
    if (p === '/test.html') return send(res, path.join(root, 'test/test.html'));
    if (p === '/harness.js') return send(res, path.join(root, 'test/harness.js'));
    if (p === '/pdf.html') return send(res, path.join(root, 'test/pdf.html'));
    if (p === '/pdf-harness.js') return send(res, path.join(root, 'test/pdf-harness.js'));
    if (p === '/test/sample.pdf') return send(res, path.join(root, 'test/sample.pdf'));
    // INK-118 复现用的空白 A4 底图：走 copyPages 那条导出路径时，
    // 底下不能带原文文字，否则渲染出来的深色像素没法区分是谁的墨。
    if (p === '/test/blank.pdf') return send(res, path.join(root, 'test/blank.pdf'));
    if (p === '/bigpdf.html') return send(res, path.join(root, 'test/bigpdf.html'));
    if (p === '/bigpdf-harness.js') return send(res, path.join(root, 'test/bigpdf-harness.js'));
    if (p === '/test/big.pdf') return send(res, path.join(root, 'test/big.pdf'));
    if (p === '/zoom.html') return send(res, path.join(root, 'test/zoom.html'));
    if (p === '/zoom-harness.js') return send(res, path.join(root, 'test/zoom-harness.js'));
    if (p === '/perf.html') return send(res, path.join(root, 'test/perf.html'));
    if (p === '/perf-harness.js') return send(res, path.join(root, 'test/perf-harness.js'));
    if (p === '/perf-open.html') return send(res, path.join(root, 'test/perf-open.html'));
    if (p === '/perf-open-harness.js') return send(res, path.join(root, 'test/perf-open-harness.js'));
    // 打开大本子的性能样本（由 test/make-open-samples.mjs 生成，不入库）
    if (p.startsWith('/test/samples/') && p.endsWith('.inkbook')) {
      const cand = path.join(root, p.replace(/^\/+/, ''));
      if (cand.startsWith(path.join(root, 'test', 'samples') + path.sep)) {
        return send(res, cand);
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
      return send(res, fs.existsSync(samplePdf) ? samplePdf : path.join(root, 'test/blank.pdf'));
    }
    if (p === '/view.html') return send(res, path.join(root, 'test/view.html'));
    if (p === '/view-harness.js') return send(res, path.join(root, 'test/view-harness.js'));
    if (p === '/jumptest.html') return send(res, path.join(root, 'test/jumptest.html'));
    if (p === '/jumptest.js') return send(res, path.join(root, 'test/jumptest.js'));
    if (p === '/touch.html') return send(res, path.join(root, 'test/touch.html'));
    if (p === '/touch-harness.js') return send(res, path.join(root, 'test/touch-harness.js'));
    if (p === '/swipe.html') return send(res, path.join(root, 'test/swipe.html'));
    if (p === '/swipe-harness.js') return send(res, path.join(root, 'test/swipe-harness.js'));
    if (p === '/dock.html') return send(res, path.join(root, 'test/dock.html'));
    if (p === '/dock-harness.js') return send(res, path.join(root, 'test/dock-harness.js'));
    if (p === '/dockpreview.html') return send(res, path.join(root, 'test/dockpreview.html'));
    if (p === '/dockpreview.js') return send(res, path.join(root, 'test/dockpreview.js'));
    if (p === '/diag.html') return send(res, path.join(root, 'test/diag.html'));
    if (p === '/feel-diag.js') return send(res, path.join(root, 'test/feel-diag.js'));
    if (p === '/e2e.html') return send(res, path.join(root, 'test/e2e.html'));
    if (p === '/feel-e2e.js') return send(res, path.join(root, 'test/feel-e2e.js'));
    if (p === '/compare.html') return send(res, path.join(root, 'test/compare.html'));
    if (p === '/feel-compare.js') return send(res, path.join(root, 'test/feel-compare.js'));
    if (p === '/tablet.html') return send(res, path.join(root, 'test/tablet.html'));
    if (p === '/tablet-harness.js') return send(res, path.join(root, 'test/tablet-harness.js'));
    if (p === '/dist.html') return send(res, path.join(root, 'test/dist.html'));
    if (p === '/dist-harness.js') return send(res, path.join(root, 'test/dist-harness.js'));
    if (p === '/dist/inkbook/main.js') return send(res, path.join(root, 'dist/inkbook/main.js'));
    if (p === '/feel.html') return send(res, path.join(root, 'test/feel.html'));
    if (p === '/feel-harness.js') return send(res, path.join(root, 'test/feel-harness.js'));
    if (p === '/plugin.html') return send(res, path.join(root, 'test/plugin.html'));
    if (p === '/plugin-harness.js') return send(res, path.join(root, 'test/plugin-harness.js'));
    // 兜底：test/ 下的静态文件（新增 harness 不必每加一个就改路由表）
    if (/\.(html|js|mjs|css)$/.test(p)) {
      const testRoot = path.join(root, 'test');
      const cand = path.join(testRoot, p.replace(/^\/+/, ''));
      if (cand.startsWith(testRoot + path.sep) || cand === testRoot) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return send(res, cand);
      }
    }
    res.writeHead(404).end('404');
  })
  .listen(Number(process.env.PORT) || 8901, '127.0.0.1', () => console.log('http://127.0.0.1:8901'));
