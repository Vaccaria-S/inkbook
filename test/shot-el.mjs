/**
 * 区域截图：只截某个元素的包围盒，用来细看面板的排版细节。
 *
 * 用法：
 *   node test/shot-el.mjs <url> <out.png> <选择器> [等待毫秒] [缩放倍数]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:8901/';
const outFile = process.argv[3] || 'test/el.png';
const selector = process.argv[4] || '.mb-dock-panel';
const waitMs = Number(process.argv[5] || 3000);
const scale = Number(process.argv[6] || 3);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('.edge-el');
fs.mkdirSync(profile, { recursive: true });

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-proxy-server',
  '--no-default-browser-check', '--remote-debugging-port=9347',
  '--window-size=1400,900', `--user-data-dir=${profile}`, url,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:9347/json/list')).json();
    const want = new URL(url).pathname;
    page = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1') && t.url.includes(want));
    if (page) break;
  } catch (_) {}
  await sleep(300);
}
if (!page) { console.error('CDP 连不上'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r));
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(waitMs);

const box = await send('Runtime.evaluate', {
  expression: `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({x:r.x, y:r.y, width:r.width, height:r.height});
  })()`,
  returnByValue: true,
});
const rect = JSON.parse(box.result.value);
if (!rect) { console.error('没找到元素', selector); process.exit(1); }

const pad = 14;
const clip = {
  x: Math.max(0, rect.x - pad),
  y: Math.max(0, rect.y - pad),
  width: rect.width + pad * 2,
  height: rect.height + pad * 2,
  scale,
};
const shot = await send('Page.captureScreenshot', { format: 'png', clip });
fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
console.log('saved', outFile, JSON.stringify(clip));
ws.close();
child.kill();
process.exit(0);
