/**
 * qa-embed4 的运行器（run.mjs 的增强版）：
 *   1. 跟 run.mjs 一样跑页面、收 `#out` 与 title；
 *   2. 页面 DONE 之后再干一件 run.mjs 干不了的事——**真 hover**。
 *
 * 为什么需要它：`:hover` 是合成状态，dispatchEvent 造不出来，样式表里读规则
 * 只能证明"规则存在"，证明不了"hover 上去角标真的显形"。这里用 CDP 的
 * CSS.forcePseudoState 让引擎自己按 hover 匹配一遍，再读 computed opacity。
 *
 * 用法：node test/qa-hover-run.mjs http://127.0.0.1:8901/qa-embed4.html 180000
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:8901/qa-embed4.html';
const timeout = Number(process.argv[3] || 180000);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = Number(process.env.CDP_PORT || 9361);
const profile = path.resolve(process.env.CDP_PROFILE || '.edge-run/hover');
fs.mkdirSync(profile, { recursive: true });

const extraFlags = (process.env.EDGE_FLAGS || '').split(' ').filter(Boolean);
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-proxy-server',
  ...extraFlags,
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, url,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
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

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  return r.result?.value;
};

const start = Date.now();
let title = '';
let text = '';
while (Date.now() - start < timeout) {
  const v = JSON.parse(await evaluate(
    'JSON.stringify({t:document.title,o:document.getElementById("out")?.textContent||""})'
  ) || '{}');
  title = v.t; text = v.o;
  if (title === 'DONE' || title === 'FATAL') break;
  await sleep(500);
}
console.log('--- output ---');
console.log(text || '(empty)');
if (logs.length) { console.log('--- console ---'); console.log(logs.slice(0, 20).join('\n')); }
console.log('--- title:', title || '(timeout)', '---');

/* ============ 真 hover（CDP 强制伪类） ============ */
console.log('--- hover (CSS.forcePseudoState) ---');
try {
  await send('DOM.enable');
  await send('CSS.enable');
  const { root } = await send('DOM.getDocument', { depth: 1 });
  const sel = '#badge-host .mb-embed';
  const before = await evaluate(
    `JSON.stringify(Array.from(document.querySelectorAll('${sel} .mb-embed-badge')).map(b => ({
       text: b.textContent, clamped: b.classList.contains('is-clamped'),
       opacity: getComputedStyle(b).opacity, bg: getComputedStyle(b).backgroundColor
     })))`
  );
  console.log('未 hover :', before);

  const { nodeIds } = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: sel });
  if (!nodeIds || !nodeIds.length) {
    console.log('找不到 #badge-host .mb-embed（页面可能没跑到角标那段），跳过 hover 验证');
  } else {
    for (const nid of nodeIds) {
      await send('CSS.forcePseudoState', { nodeId: nid, forcedPseudoClasses: ['hover'] });
    }
    await sleep(300);
    const after = await evaluate(
      `JSON.stringify(Array.from(document.querySelectorAll('${sel} .mb-embed-badge')).map(b => ({
         text: b.textContent, clamped: b.classList.contains('is-clamped'),
         opacity: getComputedStyle(b).opacity,
         borderColor: getComputedStyle(b.parentElement).borderTopColor
       })))`
    );
    console.log('已 hover :', after);
    const parsed = JSON.parse(after || '[]');
    const normal = parsed.find((p) => !p.clamped);
    const clamped = parsed.find((p) => p.clamped);
    console.log('判定:');
    console.log('  非越界角标 hover 后 opacity =', normal?.opacity,
      normal && parseFloat(normal.opacity) > 0 ? 'OK(显形)' : 'BAD(仍然看不见)');
    // N1：越界角标 hover 时必须仍然是 1（不能被 :hover 的 0.85 压掉）
    const clampOk = clamped && clamped.opacity === '1';
    console.log('  越界角标 hover 后 opacity =', clamped?.opacity,
      clampOk ? 'OK(常显，N1 已修)' : 'BAD(被 hover 规则压掉了)');
    const hex = (s) => {
      const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(s || '');
      return m ? '#' + m.slice(1).map((n) => Number(n).toString(16).padStart(2, '0')).join('') : s;
    };
    console.log('  非越界块 hover 边框色 =', hex(normal?.borderColor), '（--interactive-accent = #6c5ce7）');
  }
} catch (e) {
  console.log('hover 验证失败：', String(e.message || e));
}

ws.close();
child.kill();
process.exit(0);
