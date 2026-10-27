/**
 * 读取页面里的媒体查询结果，用来验证设备判定逻辑。
 *
 * 用法：node test/probe.mjs <url> <要打印的表达式>
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2];
const expr = process.argv[3];
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('.edge-probe');
fs.mkdirSync(profile, { recursive: true });

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-proxy-server',
  '--remote-debugging-port=9349', '--window-size=1280,860',
  `--user-data-dir=${profile}`, url,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:9349/json/list')).json();
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
await sleep(2500);

let res;
for (let i = 0; i < 6; i++) {
  try {
    res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (res && res.result && res.result.value !== undefined) break;
  } catch (_) {}
  await sleep(800);
}
console.log(res?.result?.value ?? JSON.stringify(res));
ws.close();
child.kill();
process.exit(0);
