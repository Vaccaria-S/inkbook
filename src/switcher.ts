/**
 * 让墨本生成的文字索引页不出现在 Obsidian 的「快速切换」/ 文件建议弹窗里。
 *
 * 背景（INK-126 / INK-153）：为了让 Obsidian 的**全局搜索**能搜到手写内容，
 * 墨本会为每一页生成一个 `.md` 文字索引页。这些索引页因此也进了
 * `vault.getFiles()`，核心快速切换器照单全收——用户搜一个词，结果里一半是
 * 「XXX · 第 N 页」。
 *
 * 为什么不直接过滤 `vault.getFiles()`：全局搜索靠 Obsidian 自己的文件表工作，
 * INK-153 已经踩过「adapter 直接写盘 → 文件表没收录 → 全局搜索 0 结果」的坑。
 * 把索引页从 `getFiles()` 里摘掉，等于把全局搜索一起关掉，正好和生成索引的
 * 目的相反。所以这里只在弹窗**把候选项交出去**的那一刻摘掉那几条，
 * 其余路径（文件浏览器、链接、全局搜索）原样放行。
 *
 * 判据很窄（`isInkbookIndexFile`）：只认四种历史布局下的 `.md` 索引页。
 * `.inkbook` 本子（Ribbon「打开手写本」要靠它）、导入的底图 / 原件、
 * 以及用户放进「墨本文件/」里的自己的笔记都保留。
 */
import { Modal, type App } from "obsidian";
import { isInkbookIndexFile } from "./indexer";

/** 一条建议里可能携带的文件路径。核心快速切换各版本 / 各弹窗形状不一样。 */
export function switcherItemPath(item: unknown): string | null {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  if (typeof rec.path === "string") return rec.path;
  // FuzzyMatch<TFile> = { item: TFile, match }；也有宿主直接给 { file: TFile }
  for (const key of ["file", "item"] as const) {
    const nested = rec[key];
    if (typeof nested === "string") return nested;
    if (!nested || typeof nested !== "object") continue;
    const inner = nested as Record<string, unknown>;
    if (typeof inner.path === "string") return inner.path;
    const deeper = inner.item;
    if (deeper && typeof deeper === "object" && typeof (deeper as any).path === "string") {
      return (deeper as any).path as string;
    }
  }
  return null;
}

/** 这条建议是不是墨本生成的索引页。 */
export function isIndexSwitcherItem(item: unknown): boolean {
  const path = switcherItemPath(item);
  return !!path && isInkbookIndexFile(path);
}

/** 过滤一批建议：只摘掉索引页，顺序与其余条目都不变。 */
export function filterSwitcherSuggestions<T>(items: T[]): T[] {
  return items.filter((item) => !isIndexSwitcherItem(item));
}

/** `SuggestModal.getSuggestions` 允许同步数组，也允许 Promise。 */
export function filterSwitcherResult<T>(result: T[] | Promise<T[]>): T[] | Promise<T[]> {
  if (Array.isArray(result)) return filterSwitcherSuggestions(result);
  if (result && typeof (result as Promise<T[]>).then === "function") {
    return (result as Promise<T[]>).then((list) =>
      Array.isArray(list) ? filterSwitcherSuggestions(list) : list
    );
  }
  return result;
}

type GuardState = { active: boolean };
type AnyFn = (...args: any[]) => any;

const SUGGESTIONS_MARK = "__inkbookSwitcherPatched";

/**
 * 给「拥有 getSuggestions 的那一层」套上过滤包装。
 *
 * @param track 是否登记还原函数。原型层要登记（卸载时恢复）；
 *              实例层不登记——实例是短命的，卸载时靠 `state.active` 让包装
 *              直接放行即可，避免把每个打开过的弹窗一直攥在内存里。
 */
function wrapSuggestions(
  owner: any,
  state: GuardState,
  track: boolean,
  restores: Array<() => void>
): void {
  const orig = owner?.getSuggestions;
  if (typeof orig !== "function" || (orig as any)[SUGGESTIONS_MARK]) return;
  const hadOwn = Object.prototype.hasOwnProperty.call(owner, "getSuggestions");
  const wrapped = function (this: unknown, ...args: any[]) {
    const result = orig.apply(this, args);
    return state.active ? filterSwitcherResult(result) : result;
  };
  (wrapped as any)[SUGGESTIONS_MARK] = true;
  (wrapped as any).__inkbookOrig = orig;
  owner.getSuggestions = wrapped;
  if (!track) return;
  restores.push(() => {
    if (owner.getSuggestions !== wrapped) return;
    if (hadOwn) owner.getSuggestions = orig;
    else delete owner.getSuggestions;
  });
}

/**
 * 安装索引页过滤，返回卸载函数（原样还原所有被替换的方法）。
 *
 * 三层保险，任一层生效即可，都能优雅降级：
 *   A. 核心快速切换器：若宿主把弹窗实例挂在 internalPlugins 上，拿得到就补；
 *   C. 主路径：任何 Modal 打开时，把本次实例和它原型链上 `getSuggestions`
 *      的那一层包起来。核心 Quick Switcher 就是 `SuggestModal` 的子类，
 *      它的 `open()` 最终走到 `Modal.prototype.open`，所以一定能被拦到。
 */
export function installSwitcherIndexGuard(app: App): () => void {
  const state: GuardState = { active: true };
  const restores: Array<() => void> = [];

  // A. 核心快速切换器的弹窗实例可能挂在 internalPlugins 上（新老版本都可能）。
  try {
    const inst = (app as any)?.internalPlugins?.getPluginById?.("switcher")?.instance;
    const modal = inst?.modal;
    if (modal) {
      wrapSuggestions(modal, state, false, restores);
      const proto = Object.getPrototypeOf(modal);
      if (proto && proto !== Object.prototype) wrapSuggestions(proto, state, true, restores);
    }
  } catch (_) {
    /* 内部 API 不存在就走下面的通用路径 */
  }

  // C. 主路径：在弹窗打开这一刻拿到具体实例。
  const modalProto: any = (Modal as any)?.prototype;
  if (modalProto && typeof modalProto.open === "function") {
    const origOpen = modalProto.open;
    const patchedOpen = function (this: any, ...args: any[]) {
      if (state.active) {
        try {
          const modal: any = this;
          if (modal && typeof modal.getSuggestions === "function") {
            // 实例层：覆盖 owner.getSuggestions 的动态查找。
            wrapSuggestions(modal, state, false, restores);
            // 原型层：某些宿主在构造弹窗时就把 getSuggestions 绑走了，
            // 补上原型，之后同类弹窗（以及构造期绑定）也能被过滤。
            let proto: any = Object.getPrototypeOf(modal);
            while (proto && proto !== Object.prototype) {
              if (Object.prototype.hasOwnProperty.call(proto, "getSuggestions")) {
                wrapSuggestions(proto, state, true, restores);
                break;
              }
              proto = Object.getPrototypeOf(proto);
            }
          }
        } catch (_) {
          /* 判定出错一律放行，绝不能把弹窗打开流程搞坏 */
        }
      }
      return origOpen.apply(this, args);
    };
    (patchedOpen as any).__inkbookPatched = true;
    (patchedOpen as any).__inkbookOrig = origOpen;
    modalProto.open = patchedOpen;
    restores.push(() => {
      if (modalProto.open === patchedOpen) modalProto.open = origOpen;
    });
  }

  return () => {
    state.active = false;
    for (let i = restores.length - 1; i >= 0; i--) {
      try {
        restores[i]();
      } catch (_) {
        /* 卸载阶段不再抛错 */
      }
    }
    restores.length = 0;
  };
}
