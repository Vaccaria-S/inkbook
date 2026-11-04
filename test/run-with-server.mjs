/**
 * 一条命令跑完：起测试服务 → 跑套件 → 收服务。
 *
 * 为什么要这个包装：有环境不允许把服务放后台常驻（后台进程会被回收），
 * 而套件又必须先有一个能发 test/samples/ 的 HTTP 服务。这里把服务当成
 * 子进程拉起来，等它真的能响应了再跑套件，跑完（无论成败）都杀掉。
 *
 * 用法：
 *   node test/run-with-server.mjs                # 跑全部套件
 *   node test/run-with-server.mjs perf-open      # 只跑匹配的页面
 */
import { spawn } from "node:child_process";
import http from "node:http";

const PORT = Number(process.env.PORT || 8920);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等到服务真的能返回 200（最多 15 秒） */
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const ok = await new Promise((resolve) => {
        const req = http.get(`${BASE}/test.html`, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.setTimeout(1000, () => {
          req.destroy();
          resolve(false);
        });
      });
      if (ok) return true;
    } catch (_) {
      /* 还没起来，继续等 */
    }
    await sleep(250);
  }
  return false;
}

const server = spawn(process.execPath, ["test/server.mjs"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});

let code = 1;
try {
  if (!(await waitReady())) {
    console.error(`测试服务在 ${BASE} 起不来`);
  } else {
    const args = process.argv.slice(2);
    /*
     * `--raw <page>` 直接把 run.mjs 的输出原样打出来（要看得分段表时用），
     * 不加就是走 run-all 的汇总（回归时用）。
     */
    const raw = args[0] === "--raw";
    const cmdArgs = raw
      ? ["test/run.mjs", `${BASE}/${args[1]}`, String(Number(process.env.TIMEOUT || 900000))]
      : ["test/run-all.mjs", ...args];
    code = await new Promise((resolve) => {
      const suites = spawn(process.execPath, cmdArgs, {
        env: {
          ...process.env,
          BASE,
          ...(raw ? { CDP_PORT: "9577", CDP_PROFILE: ".edge-raw" } : {}),
        },
        stdio: "inherit",
      });
      suites.on("close", (c) => resolve(c ?? 1));
    });
  }
} finally {
  server.kill();
}

process.exit(code);
