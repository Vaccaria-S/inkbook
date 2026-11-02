import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "dist", "inkbook");
const isWatch = process.argv.includes("--watch");
const isDemo = process.argv.includes("--demo");

fs.mkdirSync(outDir, { recursive: true });

const copyPlugin = {
  name: "copy-assets",
  setup(build) {
    build.onEnd(() => {
      fs.copyFileSync(path.join(root, "manifest.json"), path.join(outDir, "manifest.json"));
      fs.copyFileSync(path.join(root, "styles.css"), path.join(outDir, "styles.css"));
      const size = fs.statSync(path.join(outDir, "main.js")).size;
      console.log(`[inkbook] main.js ${(size / 1024).toFixed(0)} KB`);
    });
  },
};

const mainOptions = {
  entryPoints: [path.join(root, "src", "main.ts")],
  outfile: path.join(outDir, "main.js"),
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2018",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  plugins: [copyPlugin],
  sourcemap: false,
  minify: true,
  logLevel: "info",
  legalComments: "none",
  loader: {
    // pdf.js 的 worker 源码当文本内联，运行时转成 Blob URL。
    // 这样不需要在插件目录里放任何额外资源文件。
    ".worker.min.mjs": "text",
    /*
     * 导出的中文批注要能选中/搜索，就必须嵌一份中文字体（pdf-lib 只带西文）。
     * 同样走内联：Obsidian 移动端没有 fs，插件目录里的独立字体文件读不到。
     * 子集只有 1.85MB（见 src/fontasset.ts 的说明）。
     */
    ".ttf": "dataurl",
  },
};

const demoOptions = {
  entryPoints: [path.join(root, "demo", "demo.ts")],
  outfile: path.join(root, "demo", "demo.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2018",
  sourcemap: false,
  minify: false,
  logLevel: "info",
  legalComments: "none",
};

/**
 * pdf.js 现在直接内联进主包。
 *
 * 之前是单独打一个 pdfjs.mjs，运行时用 import() 动态加载——
 * 但 Obsidian 的 CommonJS 沙箱里 import(app://...) 并不稳，
 * 而兜底的 bytes 分支从来没被 main.ts 填过，等于没有兜底。
 *
 * 内联之后：加载路径绝对可靠，代价只是包大一点（用户不在意）。
 * worker 源码仍然以文本形式内联，运行时转 Blob URL，
 * 不依赖插件目录里的任何文件。
 */
if (isDemo) {
  await esbuild.build(demoOptions);
  fs.copyFileSync(path.join(root, "styles.css"), path.join(root, "demo", "styles.css"));
} else {
  const ctx = await esbuild.context(mainOptions);
  if (isWatch) {
    await ctx.watch();
    console.log("[inkbook] watching...");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}
