/**
 * 触摸交互端到端测试的运行器（惯性滚动 + 捏合缩放）。
 *
 * 与 swipe-run.mjs 的差别：这次要派发**多指**手势，
 * 所以 touchPoints 是一组带 id 的点。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const URL_ = process.argv[2] || "http://127.0.0.1:8901/touch.html";
const PORT = 9355;
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const profile = path.resolve(".edge-touch");

fs.mkdirSync(profile, { recursive: true });

const child = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-proxy-server",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=900,760",
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
        (t) => t.type === "page" && t.url.includes("127.0.0.1") && t.url.includes("touch")
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

/** 派发一次多点触摸。points = [{x,y,id}] */
async function dispatchTouch(type, points) {
  const isEnd = type === "touchEnd";
  await send("Input.dispatchTouchEvent", {
    type,
    touchPoints: isEnd
      ? []
      : points.map((p) => ({
          x: p.x,
          y: p.y,
          id: p.id,
          radiusX: 1,
          radiusY: 1,
          force: 1,
        })),
  });
}

async function evalPage(expr) {
  const res = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  return res?.result?.value;
}

try {
  if (!(await connect())) {
    console.error("CDP 连不上");
    process.exit(1);
  }
  await send("Page.enable");
  await send("Runtime.enable");

  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "log") {
      const txt = m.params.args?.[0]?.value;
      if (typeof txt === "string" && txt.startsWith("__TOUCH__:")) {
        const [, type, payload] = txt.split(":");
        const points = payload
          ? payload.split(";").map((p) => {
              const [x, y, id] = p.split(",");
              return { x: Number(x), y: Number(y), id: Number(id) };
            })
          : [];
        dispatchTouch(type, points).then(() => {
          send("Runtime.evaluate", {
            expression: `window.postMessage({__touchDone:'${type}'}, '*')`,
          });
        });
      }
    }
  });

  // 等页面就绪
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const t = await evalPage("document.getElementById('out')?.textContent || ''");
    if (typeof t === "string" && t.includes("PASS") || typeof t === "string" && t.includes("SKIP")) {
      ready = true;
      break;
    }
  }
  if (!ready) {
    // 页面可能还在跑测试，再等一轮
    await sleep(2000);
  }

  let text = "";
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    text = (await evalPage("document.getElementById('out')?.textContent || ''")) || "";
    if (/ALL PASS|FAILED/.test(text)) break;
  }

  console.log(text);
  ws.close();
} catch (e) {
  console.error("运行出错:", e);
} finally {
  try {
    child.kill();
  } catch (_) {
    /* ignore */
  }
  process.exit(0);
}
