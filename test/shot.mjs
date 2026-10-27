import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:8901/';
const outFile = process.argv[3] || 'test/shot.png';
const waitMs = Number(process.argv[4] || 2500);
const W = Number(process.argv[5] || 1360);
const H = Number(process.argv[6] || 900);
const evalExpr = process.argv[7] || '';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('.edge-shot');
fs.mkdirSync(profile, { recursive: true });

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-proxy-server',
  '--no-default-browser-check', '--remote-debugging-port=9341',
  `--window-size=${W},${H}`, `--user-data-dir=${profile}`, url,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:9341/json/list')).json();
    // 必须精确匹配目标 URL，否则会抓到上次会话遗留的标签页
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
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
await sleep(waitMs);
if (evalExpr) {
  await send('Runtime.evaluate', { expression: evalExpr });
  await sleep(700);
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
console.log('saved', outFile);
ws.close();
child.kill();
process.exit(0);
