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
  // 打开 300+ 页大本子的分阶段计时 + 首屏/阻塞上界（"打开很慢"回归闸门）
  "perf-open-harness.ts",
  // QA 独立验证（不是断言套件的重复）：占位的真实生命周期 / 失败路径 /
  // 连点切书 / 同进程二次打开的资源残留 / 最后一页是否真的画出来。
  // 和 perf-open 互补，不改 run-all 的基线条数（要进闸门就在 PAGES 里加 ["qa-open.html", 49]）。
  "qa-open-harness.ts",
  "zoom-harness.ts",
  "pdf-harness.ts",
  "bigpdf-harness.ts",
  // 产物级 / 插件级：直接加载构建产物和真实插件入口
  "dist-harness.ts",
  "plugin-harness.ts",
  "jumptest.ts",
  "dockpreview.ts",
  "textpreview.ts",
  "dock-harness.ts",
  "swipe-harness.ts",
  "touch-harness.ts",
  // 侧栏缩略图的 PDF 底图（单独一个页面，不跟 perf 的失败状态混在一起）
  "thumb-harness.ts",
  // 导出 PDF 的矢量保真（原文可选中）
  "export-harness.ts",
  // INK-118：短批注导出 PDF 的隔字缺字（抽字 + 渲染像素双重判定）
  "pdftext-harness.ts",
  // QA 独立终验（INK-118）：A/B 差分渲染 + 字形结构，不复用上面的断言
  "qa-ink118-visual-harness.ts",
  // QA 独立验证：批注折行（屏幕 DOM / 画布 / 导出三处断字一致 + 不越界）
  "qa-wrap-harness.ts",
  // P1 数据安全（指纹 / 原子写 / 版本闸门 / 冲突 / 完整性）
  "p1-harness.ts",
  // 笔记内嵌入（INK-105）：链接解析 / 一页渲染 / 缓存 / postprocessor 端到端
  "embed-harness.ts",
  // QA 独立验证（INK-105）：真实布局量尺寸 / 解析边界外推 / LRU / 失败路径 / 幂等
  "qa-embed2-harness.ts",
  // QA 独立验证（INK-105）：main.ts 真接线（postprocessor 注册 + vault 事件清缓存）
  "qa-embed3-harness.ts",
  // QA 终验（INK-105 第二轮）：F1 宽度天花板 / F2 不越栏 / 点击落点 / 保存后重画 / 角标
  "qa-embed4-harness.ts",
  // QA 量测（不是断言套件）：dpr=1 vs dpr=2 下嵌入的**显示宽度**差多少
  "qa-dprcheck-harness.ts",
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
      // 导出用的中文字体（见 src/fontasset.ts）同样是内联的
      ".ttf": "dataurl",
    },
  });
  console.log(`[test] ${entry} → ${path.basename(out)}`);
}
