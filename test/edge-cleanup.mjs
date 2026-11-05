/**
 * 收干净无头 Edge 的**整棵进程树**。
 *
 * 为什么需要它：`child.kill()` 只杀 Edge 的主进程，而一个 Edge 实例会派生出
 * gpu-process / renderer / utility 等一批子进程。Node 紧接着 `process.exit(0)`，
 * 不等它们真的退出——于是每跑一个套件就漏下一堆孤儿 Edge，
 * 跑完全量能攒到几十个（2026-11-05 实测 52 个），它们继续占着内存和 CPU，
 * 用户那边就是「电脑特别卡」。
 *
 * 做法：
 *   1. `taskkill /T /F` 按 PID 树杀（/T = 连子进程一起）；
 *   2. 再按 profile 目录兜底，收掉上一次运行遗留的孤儿。
 *
 * 非 Windows 上没有 taskkill，就只靠第 2 步（profile 目录匹配）。
 */
import { execFileSync } from "node:child_process";

/**
 * @param pid    Edge 主进程 PID（可空）
 * @param profile 该实例的 user-data-dir（用于兜底匹配）
 */
export function killEdgeTree(pid, profile) {
  // 1) 进程树
  if (pid) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 8000,
      });
    } catch (_) {
      // 进程可能已经自己退了；忽略
    }
  }
  // 2) 按 profile 目录兜底
  if (!profile) return;
  try {
    const marker = String(profile).toLowerCase().replace(/'/g, "''");
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like '*--headless=new*' -and $_.CommandLine -like '*${marker}*' }; $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { stdio: "ignore", timeout: 12000 }
    );
  } catch (_) {
    // 没有 powershell（其它平台）就只靠第 1 步
  }
}

/**
 * 给一个 Node 脚本挂上「退出时收干净」的钩子。
 *
 * @param getPid    取当前 Edge 主进程 PID 的函数
 * @param getProfile 取当前 profile 目录的函数
 */
export function installEdgeCleanup(getPid, getProfile) {
  const done = () => {
    try {
      killEdgeTree(getPid(), getProfile());
    } catch (_) {
      /* 退出阶段不再抛错 */
    }
  };
  process.on("exit", done);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      done();
      process.exit(130);
    });
  }
}
