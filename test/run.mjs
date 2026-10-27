import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:8901/test.html';
const timeout = Number(process.argv[3] || 45000);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('.edge-run');
fs.mkdirSync(profile, { recursive: true });
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-proxy-server',
  '--remote-debugging-port=9343', `--user-data-dir=${profile}`, url,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:9343/json/list')).json();
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
const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(`[${m.params.type}] ` + (m.params.args || []).map((a) => a.value ?? a.description).join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    logs.push('[exception] ' + (d.exception?.description || d.text));
  }
});
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');
const start = Date.now();
let title = '';
let text = '';
while (Date.now() - start < timeout) {
  const r = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({t:document.title,o:document.getElementById("out")?.textContent||""})',
    returnByValue: true,
  });
  const v = JSON.parse(r.result.value || '{}');
  title = v.t; text = v.o;
  if (title === 'DONE' || title === 'FATAL') break;
  await sleep(500);
}
console.log('--- output ---');
console.log(text || '(empty)');
if (logs.length) { console.log('--- console ---'); console.log(logs.slice(0, 30).join('\n')); }
console.log('--- title:', title || '(timeout)', '---');
ws.close(); child.kill(); process.exit(0);
