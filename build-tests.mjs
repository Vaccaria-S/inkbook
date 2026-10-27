/**
 * 测试 harness 构建。
 *
 * 每个 harness 都是一个独立的 esbuild 入口：
 * 把 src/ 下的模块打成一个 IIFE，直接在浏览器里跑。
 *
 * 单独写脚本是为了让"加一个测试"这件事有明确步骤，
 * 不用记住一长串 esbuild 参数。
 */
import esbuild from "esbuild";
import path from "node:path";

const root = process.cwd();
const testDir = path.join(root, "test");

/**
 * obsidian 是 Obsidian 运行时提供的模块，浏览器里没有。
 * 测试时用 test/obsidian-stub.mjs 顶替——
 * 它提供了插件用到的那部分 API。
 */
const obsidianAlias = {
  name: "obsidian-alias",
  setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({
      path: path.join(testDir, "obsidian-stub.mjs"),
    }));
  },
};

/** harness 入口 → 产物名 */
const HARNESSES = [
  "harness.ts",
  "feel-harness.ts",
  "view-harness.ts",
  "tablet-harness.ts",
  "perf-harness.ts",
  "zoom-harness.ts",
  "pdf-harness.ts",
  "bigpdf-harness.ts",
  // 产物级 / 插件级：直接加载构建产物和真实插件入口
  "dist-harness.ts",
  "plugin-harness.ts",
  "jumptest.ts",
  "dockpreview.ts",
  "dock-harness.ts",
  "swipe-harness.ts",
  "touch-harness.ts",
  // P1 数据安全（指纹 / 原子写 / 版本闸门 / 冲突 / 完整性）
  "p1-harness.ts",
];

const only = process.argv[2];

for (const entry of HARNESSES) {
  if (only && !entry.includes(only)) continue;
  const out = path.join(testDir, entry.replace(/\.ts$/, ".js"));
  await esbuild.build({
    entryPoints: [path.join(testDir, entry)],
    outfile: out,
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2018",
    minify: false,
    logLevel: "warning",
    plugins: [obsidianAlias],
    loader: {
      ".worker.min.mjs": "text",
    },
  });
  console.log(`[test] ${entry} → ${path.basename(out)}`);
}
