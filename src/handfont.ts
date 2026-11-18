/**
 * 「手写」字体：自带一份小赖（Xiaolai）子集，运行时装进 `document.fonts`。
 *
 * 为什么必须自带（INK-224，用户真机反馈）：
 *   上一版的手写字体栈是 `"Excalifont", "Xiaolai", …`，指望 Obsidian 的
 *   Excalidraw 插件把这两款字体注册进 `document.fonts` 再按同名借用。
 *   实测这条路走不通：
 *     · Excalifont 只有西文（7 个 woff2 分片，共 63KB，一个汉字都没有）；
 *     · Xiaolai 要 Excalidraw 打开「中文字体」开关（`loadChineseFonts`，
 *       默认 false）才会去加载**本地**的中文字体资源。
 *   于是用户「装了 Excalidraw、选了手写」，中文实际落到回退链尾部的
 *   Noto Sans SC——看起来还是黑体，也就是「选了手写字体，字体没变」。
 *
 *   插件不能依赖另一个插件的可选开关：用户没装 Excalidraw、或装了但没开
 *   中文字体，手写档就等于失效。所以这里把子集直接打进包里（内联 base64，
 *   移动端没有 fs，插件目录里的独立文件读不到），用 `FontFace` 自己注册。
 *
 * 为什么是子集：
 *   完整 Xiaolai TTF 有 21.2MB，base64 内联会把 main.js 从 5.9MB 撑到 34MB。
 *   这里用与导出字体**完全相同**的字符集（GB2312 + ASCII + 常用符号）做子集，
 *   woff2 落到 1216KB → base64 约 1.6MB，汉字覆盖率与导出一致。
 *
 * 量宽一致性（INK-193）：
 *   子集里汉字的 advance width 与导出用的 Noto Sans SC 子集**逐字相同**
 *   （都是 1000/1000 upem 全角），所以中文的折行位置屏幕与导出严格一致；
 *   西文/部分标点的字宽略有差异，见 `assets/README.md` 的说明。
 *
 * 字体为 Xiaolai（小赖，基于濑户字体），SIL OFL 1.1，
 * 许可全文见 `assets/Xiaolai-LICENSE.txt`（无 Reserved Font Name）。
 */
import dataUrl from "../assets/Xiaolai-subset.woff2";

/**
 * 注册到 `document.fonts` 的家族名。
 *
 * 刻意不用 `"Xiaolai"`：那个名字属于 Excalidraw 插件注册的字体，
 * 同名会互相顶掉（谁后注册谁生效，且 `document.fonts` 是全局的）。
 * 用插件自己的名字，行为可预期，也不会影响 Excalidraw 的画布。
 */
export const HAND_FONT_FAMILY = "Inkbook Hand";

/** 字体栈里代表「本插件自带的手写体」的那一项，供 editor 的字体栈引用 */
export const HAND_FONT_FAMILY_CSS = `"${HAND_FONT_FAMILY}"`;

/** 加载状态：null=还没开始，true=已注册可用，false=环境不支持或加载失败 */
let state: boolean | null = null;
let loading: Promise<boolean> | null = null;
const waiters = new Set<(ok: boolean) => void>();

/**
 * `FontFaceSet.add()` 的类型声明。
 *
 * 规范里 `document.fonts.add(face)` 是标准 API，但 TypeScript 的
 * `lib.dom.d.ts` 到现在都没声明它（`FontFaceSet` 只列了 check/load/ready/
 * status）。运行时（Electron / WKWebView / Android WebView）全都有，
 * 所以这里按规范补一个最小接口，不做 `as any`——那样连参数名都会丢掉。
 */
interface FontFaceSetWithAdd extends FontFaceSet {
  add(font: FontFace): FontFaceSet;
}

/**
 * 把构建期内联的 data URL 解成字体字节（只解一次）。
 *
 * 为什么不用 `new FontFace(family, \`url(${dataUrl})\`)`：
 *   `url(data:…)` 要经过 CSP 的 `font-src` 检查。Obsidian 各平台（桌面
 *   Electron / iOS WKWebView / Android WebView）的 CSP 不完全一样，
 *   一旦 `data:` 被拦，字体就静默加载失败——正是这次要修的 bug 的同类。
 *   直接把字节交给 `FontFace` 走的是内存里的二进制源，不经过任何 URL 策略。
 */
function handFontBytes(): Uint8Array<ArrayBuffer> {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 注册手写字体（幂等，可重复调用）。
 *
 * 返回 `true` 表示字体已经可用；`false` 表示环境不支持 `FontFace`
 * 或字体解析失败——此时字体栈会按字回落到 `"Noto Sans SC"`，
 * 排版仍然正确（量宽同源），只是看不到手写效果。**不抛异常**：
 * 一个装饰性字体不该让打开本子失败。
 *
 * 注意：`atob` 解 1.6MB base64 是**同步**的（几十毫秒），所以调用方
 * 不要在打开本子的关键路径上直接调（会拖慢首屏）。编辑器用
 * `requestIdleCallback` 之类的空闲时机触发，导出/嵌入路径才显式 await。
 */
export function ensureHandFont(): Promise<boolean> {
  if (loading) return loading;
  loading = (async () => {
    const fonts =
      typeof document !== "undefined" ? (document.fonts as FontFaceSetWithAdd | undefined) : undefined;
    if (typeof FontFace === "undefined" || !fonts || typeof fonts.add !== "function") {
      // 老环境（或测试里的假 DOM）没有 FontFace：静默降级，不报错
      state = false;
      flush(false);
      return false;
    }
    try {
      const face = new FontFace(HAND_FONT_FAMILY, handFontBytes(), {
        style: "normal",
        weight: "400",
      });
      /*
       * 必须先 `load()` 再 `add()`：只 add 不 load 的话，`document.fonts`
       * 里会有一条永远 pending 的记录，而 canvas 的 `font` 在字体就绪前
       * 会静默用回退字体——导出时画出来就是黑体。
       */
      await face.load();
      fonts.add(face);
      state = true;
      flush(true);
      return true;
    } catch (e) {
      console.warn("[inkbook] 手写字体加载失败，手写档将回落到 Noto Sans SC", e);
      state = false;
      flush(false);
      return false;
    }
  })();
  return loading;
}

/**
 * 在**空闲**时机注册手写字体（不阻塞首屏）。
 *
 * 打开一本本子的关键路径上有排版、首屏绘制、PDF 底图渲染要抢时间，
 * 同步解 1.6MB base64 会实打实地拖慢它。字体只是装饰：晚一两帧到位
 * 用户看不出来（到位后文字层会重排，见 `onHandFontReady`）。
 *
 * `requestIdleCallback` 在 Safari/WKWebView 上缺失（Obsidian iOS 就是它），
 * 所以有超时兜底 + `setTimeout` 兜底两重。
 */
export function ensureHandFontIdle(): void {
  if (loading || state !== null) return;
  const kick = () => void ensureHandFont();
  const ric = (globalThis as any).requestIdleCallback;
  if (typeof ric === "function") {
    // timeout 是兜底：页面一直不空闲（持续滚动/书写）也必须最终加载
    ric(kick, { timeout: 1500 });
  } else {
    setTimeout(kick, 120);
  }
}

/**
 * 订阅「手写字体就绪」。
 *
 * 字体是异步解码的，而第一屏文字往往在它到位之前就渲染完了：
 * 那时 span 的 `font-family` 已经指向 `"Inkbook Hand"`，浏览器按字回落到
 * Noto，等字体注册好**不会自动重排**（CSS 只认 family 名，不认加载完成）。
 * 所以编辑器订阅这个回调，在字体到位后重排一次文字层。
 *
 * 已经就绪时回调同步执行（下一微任务），调用方不用自己判断先后。
 *
 * @returns 取消订阅函数
 */
export function onHandFontReady(cb: (ok: boolean) => void): () => void {
  if (state !== null) {
    const ok = state;
    Promise.resolve().then(() => cb(ok));
    return () => {};
  }
  waiters.add(cb);
  return () => waiters.delete(cb);
}

/** 字体是否已注册可用（还没开始加载时是 false） */
export function handFontReady(): boolean {
  return state === true;
}

function flush(ok: boolean): void {
  const list = [...waiters];
  waiters.clear();
  for (const cb of list) {
    try {
      cb(ok);
    } catch (e) {
      console.warn("[inkbook] 手写字体就绪回调抛错", e);
    }
  }
}
