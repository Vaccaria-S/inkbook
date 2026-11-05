import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { killEdgeTree, installEdgeCleanup } from './edge-cleanup.mjs';

const url = process.argv[2] || 'http://127.0.0.1:8901/test.html';
const timeout = Number(process.argv[3] || 45000);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
/**
 * 端口与 profile 目录可用环境变量覆盖。
 *
 * 必要性：上一次跑挂了但没退出的无头 Edge 会一直占着 9343，
 * 新实例绑不上端口会被静默忽略，run.mjs 于是连到**旧实例**——
 * 一旦旧实例上还挂着同名页面，就会读到上一次的旧输出，出现假绿。
 * 换端口 + 换 profile 目录，各 harness 之间互不干扰。
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9343);
const profile = path.resolve(process.env.CDP_PROFILE || '.edge-run');
fs.mkdirSync(profile, { recursive: true });
/**
 * 额外启动参数，空格分隔（默认没有）。
 *
 * 用来按需打开 Chrome 的可选能力，比如 performance.memory 的精确读数：
 *   CHROME_ARGS=--enable-precise-memory-info node test/run.mjs ...
 * 默认不改任何行为——别的套件拿到的浏览器跟以前完全一样。
 */
const extraArgs = (process.env.CHROME_ARGS || '').split(' ').filter(Boolean);

/** Edge 主进程（后面 spawn 出来的）；先声明好，退出清理要用 */
let child = null;

/*
 * 退出时收干净整棵 Edge 进程树。
 *
 * `child.kill()` 只杀主进程，gpu-process / renderer / utility 这些子进程会
 * 变成孤儿继续跑（跑完全量实测攒到 52 个，把用户电脑拖卡）。
 * 详见 test/edge-cleanup.mjs 的说明。
 */
const cleanup = () => killEdgeTree(child?.pid, profile);
installEdgeCleanup(() => child?.pid, () => profile);

child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-proxy-server',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, ...extraArgs, url,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    // 必须精确匹配目标 URL，否则会抓到上次会话遗留的标签页
    const want = new URL(url).pathname;
    page = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1') && t.url.includes(want));
    if (page) break;
  } catch (_) {}
  await sleep(300);
}
if (!page) { console.error('CDP 连不上'); cleanup(); process.exit(1); }
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
ws.close();
// 收干净整棵 Edge 进程树（只 child.kill() 会漏掉 gpu/renderer 等子进程，
// 跑完全量能攒到几十个孤儿 Edge，把用户电脑拖卡）
cleanup();
process.exit(0);
