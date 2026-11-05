/**
 * 右滑拦截的端到端测试运行器。
 *
 * 为什么要单独写一个运行器：
 *   浏览器不允许脚本构造 TouchEvent（会强制类型转换，
 *   传普通对象会抛 "Failed to convert value to 'Touch'"）。
 *   只有 CDP 的 Input.dispatchTouchEvent 能派发**真正的触摸序列**，
 *   才能验证「事件有没有被拦截、到不到 document」这件事。
 *
 * 流程：
 *   1. 起一个无头 Edge，连上 CDP
 *   2. 打开测试页
 *   3. 注入 __cdpTouch 桥函数（用 CDP 的 Input.dispatchTouchEvent 实现）
 *   4. 读测试页的输出
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { killEdgeTree, installEdgeCleanup } from "./edge-cleanup.mjs";

const URL_ = process.argv[2] || "http://127.0.0.1:8901/swipe.html";
const PORT = 9351;
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const profile = path.resolve(".edge-swipe");

fs.mkdirSync(profile, { recursive: true });

/** Edge 主进程；先声明好，退出清理要用 */
let child = null;

// 退出时收干净整棵 Edge 进程树（只 child.kill() 会漏掉 gpu/renderer 子进程）
installEdgeCleanup(() => child?.pid, () => profile);

child = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-proxy-server",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1400,900",
    URL_,
  ],
  { stdio: "ignore" }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
let msgId = 0;
const pending = new Map();

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(
        (t) => t.type === "page" && t.url.includes("127.0.0.1") && t.url.includes("swipe")
      );
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => {
          ws.addEventListener("open", r, { once: true });
          ws.addEventListener("error", j, { once: true });
        });
        ws.addEventListener("message", (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) {
            const p = pending.get(m.id);
            pending.delete(m.id);
            m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
          }
        });
        return true;
      }
    } catch (_) {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return false;
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** 派发一次真实触摸 */
async function dispatchTouch(type, x, y) {
  const isStart = type === "touchStart";
  const isEnd = type === "touchEnd";
  const points = isEnd ? [] : [{ x, y, radiusX: 1, radiusY: 1, force: 1 }];
  await send("Input.dispatchTouchEvent", {
    type: isStart ? "touchStart" : isEnd ? "touchEnd" : "touchMove",
    touchPoints: points,
  });
}



try {
  if (!(await connect())) {
    console.error("CDP 连不上");
    process.exit(1);
  }

  // 页面里没法直接调 CDP，所以注入一个走 window 事件通道的桥：
  // 页面把请求发到 window.postMessage，由 Node 侧转成 CDP 调用。
  await send("Page.enable");
  await send("Runtime.enable");

  // 用一个更简单可靠的方案：把「触摸派发」做成 Node 侧轮询。
  // 页面通过 console.log('__TOUCH__:<type>,<x>,<y>') 请求派发，
  // Node 侧监听 Runtime.consoleAPICalled 并回传。
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (
      m.method === "Runtime.consoleAPICalled" &&
      m.params?.type === "log"
    ) {
      const txt = m.params.args?.[0]?.value;
      if (typeof txt === "string" && txt.startsWith("__TOUCH__:")) {
        const parts = txt.split(":");
        const type = parts[1];
        const x = Number(parts[2]);
        const y = Number(parts[3]);
        // 派发真实触摸 → 派发完成后回传信号给页面
        dispatchTouch(type, x, y).then(() => {
          send("Runtime.evaluate", {
            expression: `window.postMessage({__touchDone:'${type}'}, '*')`,
          });
        });
      }
    }
  });



  // 桥已经内联在 swipe.html 里（页面脚本之前），
  // 这里只需要等页面跑起来。
  await sleep(3000);

  // 等测试跑完
  let text = "";
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const res = await send("Runtime.evaluate", {
      expression: "document.getElementById('out') ? document.getElementById('out').textContent : ''",
      returnByValue: true,
    });
    text = res?.result?.value || "";
    if (/ALL PASS|FAILED/.test(text)) break;
  }

  console.log(text);
  ws.close();
} catch (e) {
  console.error("运行出错:", e);
} finally {
  // 收干净整棵 Edge 进程树（只 child.kill() 会漏掉 gpu/renderer 子进程）
  try {
    killEdgeTree(child?.pid, profile);
  } catch (_) {
    /* ignore */
  }
}
