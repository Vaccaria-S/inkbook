/**
 * 跑全部测试页面并统计 PASS/FAIL 数量。
 *
 * 为什么要有这个脚本：回归有 20 多个页面，一个个人肉打开对数字既慢又容易漏。
 * 这里按顺序跑（不并行——并行会抢 CPU，把性能类套件的耗时断言带偏），
 * 每个页面独立端口独立 profile，跑完打印一行「页面名 → PASS 数 / 结论」。
 *
 * 用法：
 *   node test/run-all.mjs                 # 全部
 *   node test/run-all.mjs perf-open       # 只跑名字里含 perf-open 的
 *   BASE=http://127.0.0.1:8912 node test/run-all.mjs
 */
import { spawn } from "node:child_process";

const BASE = process.env.BASE || "http://127.0.0.1:8911";
const only = process.argv[2] || "";

/**
 * 页面 → 期望的 PASS 数（null = 只要求不失败，不核对条数）。
 *
 * 有的页面必须用专门的运行器：touch / swipe 要靠 CDP 的
 * Input.dispatchTouchEvent 派发**真正的触摸序列**（浏览器不允许脚本构造
 * TouchEvent），普通 run.mjs 发的是 pointer 事件，页面会停在第一步。
 * 所以这几页在这一列标出 runner，别"顺手统一"成 run.mjs。
 */
const PAGES = [
  ["test.html", 310],
  ["export.html", 129],
  ["p1.html", 163],
  ["view.html", 117],
  ["tablet.html", 32],
  ["zoom.html", 21],
  ["dist.html", 30],
  ["plugin.html", 32],
  ["jumptest.html", 11],
  ["feel.html", 53],
  ["perf.html", 21],
  ["perf-open.html", 60],
  ["qa-open.html", 49],
  ["dock.html", 225],
  ["thumb.html", 14],
  ["pdf.html", 46],
  ["bigpdf.html", 13],
  ["touch.html", 17, "touch-run.mjs"],
  ["swipe.html", 7, "swipe-run.mjs"],
  ["qa-wrap.html", 267],
  ["embed.html", 119],
  ["qa-embed2.html", 115],
  ["qa-embed3.html", 16],
  ["qa-embed4.html", 122],
  ["pdftext.html", 177],
  ["qa-ink118-visual.html", 296],
  ["modals.html", 70],
  // 纸面模板渲染（INK-201）：6 模板 × 3 纸色 + 三处（屏幕/导出/嵌入）一致
  ["paper.html", 131],
];

const runOne = (page, i, runner = "run.mjs") =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [`test/${runner}`, `${BASE}/${page}`, String(Number(process.env.TIMEOUT || 300000))],
      {
        env: {
          ...process.env,
          CDP_PORT: String(9500 + i),
          CDP_PROFILE: `.edge-all-${page.replace(/\W/g, "_")}`,
        },
      }
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", () => resolve(out));
  });

let totalPass = 0;
let totalFail = 0;
let badPages = 0;

for (let i = 0; i < PAGES.length; i++) {
  const [page, expect, runner] = PAGES[i];
  if (only && !page.includes(only)) continue;
  const out = await runOne(page, i, runner);
  const pass = (out.match(/^PASS /gm) || []).length;
  const fail = (out.match(/^FAIL /gm) || []).length;
  const title = (out.match(/--- title: (\S+)/) || [])[1] || "?";
  // 判定只看「有没有 FAIL」和「PASS 条数对不对」——
  // touch/swipe 的运行器不打印 document.title，用 title 当门槛会误判
  const fatal = /FATAL/.test(out);
  const countOk = expect == null || pass === expect;
  const ok = !fatal && fail === 0 && countOk && pass > 0;
  if (!ok) badPages++;
  totalPass += pass;
  totalFail += fail;
  console.log(
    `${ok ? "OK  " : "BAD "} ${page.padEnd(22)}${(runner || "run.mjs").padEnd(17)} PASS=${String(pass).padStart(4)}${
      expect != null ? "/" + expect : ""
    } FAIL=${fail} title=${title}`
  );
  if (!ok) {
    const tail = out.split("\n").filter((l) => /^FAIL |FATAL|exception/.test(l)).slice(0, 8);
    if (tail.length) console.log("     " + tail.join("\n     "));
  }
}

console.log(`\n合计 PASS=${totalPass} FAIL=${totalFail} 异常页面=${badPages}`);

/*
 * 兜底清一遍所有 `.edge-*` 的无头 Edge。
 *
 * 每个 runner 自己会收干净（见 test/edge-cleanup.mjs），但万一某个 runner
 * 崩了/被强杀，它那棵 Edge 进程树就会留下来。跑完全量 26 个套件，
 * 漏一个就是十几个孤儿进程，用户那边表现为「电脑特别卡」。
 */
try {
  const { killEdgeTree } = await import("./edge-cleanup.mjs");
  killEdgeTree(null, ".edge-");
} catch (_) {
  /* 收不到就算了，不影响测试结论 */
}

process.exit(badPages === 0 && totalFail === 0 ? 0 : 1);
