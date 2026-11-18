/**
 * 自定义快捷键：动作定义、键位规范化、反查与展示。
 *
 * 这里只放纯数据与纯函数，不碰 DOM 运行时（KeyboardEvent 仅作类型用），
 * 让 view.ts（按键派发）、settings.ts（录制）和测试共用同一套规则。
 *
 * 键位字符串（下称 combo）的格式：小写、修饰键在前、主键在最后，
 * 例如 `"mod+shift+z"`、`"p"`、`"escape"`、`"+"`。
 * `mod` 同时代表 Ctrl 与 Cmd（跨平台等价，见 keyCombo）。
 */

/** 一个可绑定快捷键的动作。 */
export interface HotkeyAction {
  /** 稳定 id，也是写进 settings.hotkeys 的键 */
  id: string;
  /** 设置页里显示的名字 */
  label: string;
  /** 分组标题（设置页按组插入小标题） */
  group: string;
  /**
   * 默认键位（可以是多个别名，如重做同时支持 Ctrl+Shift+Z 与 Ctrl+Y）。
   * 用户一旦自定义，就会整体替换掉这里的默认别名。
   */
  defaults: string[];
}

/**
 * 全部可自定义的动作。
 *
 * 工具动作的 id 直接复用 ToolId（pen / ballpoint …），这样 view.ts 里
 * 顶栏按钮的 tooltip 能按同一个 id 反查出当前键位。
 */
export const HOTKEY_ACTIONS: HotkeyAction[] = [
  // ---- 工具 ----
  { id: "pen", group: "工具", label: "钢笔", defaults: ["p"] },
  { id: "ballpoint", group: "工具", label: "圆珠笔", defaults: ["b"] },
  { id: "highlighter", group: "工具", label: "荧光笔", defaults: ["h"] },
  { id: "eraser", group: "工具", label: "橡皮", defaults: ["e"] },
  { id: "text", group: "工具", label: "文字", defaults: ["t"] },
  { id: "select", group: "工具", label: "选择 / 移动", defaults: ["v"] },
  { id: "shape", group: "工具", label: "形状", defaults: ["r"] },
  { id: "hand", group: "工具", label: "拖动画布", defaults: [] },
  // ---- 编辑 ----
  { id: "undo", group: "编辑", label: "撤销", defaults: ["mod+z"] },
  { id: "redo", group: "编辑", label: "重做", defaults: ["mod+shift+z", "mod+y"] },
  { id: "deleteText", group: "编辑", label: "删除选中的文字", defaults: ["delete", "backspace"] },
  { id: "save", group: "编辑", label: "立即保存", defaults: ["mod+s"] },
  { id: "cancel", group: "编辑", label: "取消选择 / 收起侧栏", defaults: ["escape"] },
  { id: "find", group: "编辑", label: "在当前笔记中查找文字", defaults: ["mod+f"] },
  // ---- 视图 ----
  { id: "fit", group: "视图", label: "整页适应窗口", defaults: ["0"] },
  { id: "zoomIn", group: "视图", label: "放大", defaults: ["+", "="] },
  { id: "zoomOut", group: "视图", label: "缩小", defaults: ["-"] },
  // ---- 输入与面板 ----
  { id: "penOnly", group: "输入与面板", label: "切换「只认触控笔」", defaults: ["i"] },
  { id: "toggleSide", group: "输入与面板", label: "展开 / 收起右侧栏", defaults: [] },
  { id: "toggleDock", group: "输入与面板", label: "展开 / 收起缩略图抽屉", defaults: [] },
  // 经典手写应用移植功能：默认不绑键（避免抢占用户已有键位），需要时自己在设置页录
  { id: "cycleShapeSnap", group: "输入与面板", label: "一笔成型：开 / 关", defaults: [] },
  { id: "toggleLaser", group: "输入与面板", label: "切换激光笔", defaults: [] },
];

/** 合法动作 id 集合，用于清理从磁盘读进来的脏数据。 */
export const HOTKEY_ACTION_IDS = new Set(HOTKEY_ACTIONS.map((a) => a.id));

/** keyCombo 只关心这几个字段，抽出来方便测试直接传普通对象。 */
export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/** 把单个键名归一：空格、常见别名统一成便于展示 / 比较的形式。 */
function normalizeKeyName(key: string): string {
  if (key === " " || key === "Spacebar" || key === "Space") return "space";
  const k = key.toLowerCase();
  if (k === "esc") return "escape";
  if (k === "del") return "delete";
  return k;
}

/** 纯修饰键：单独按下时不算一个快捷键，返回空串。 */
const MODIFIER_KEYS = new Set(["control", "shift", "alt", "meta", "os"]);

/**
 * 把一次键盘事件规范化成可比较的 combo 字符串。
 * 只按了修饰键（Ctrl / Shift / Alt / Meta）时返回 `""`。
 *
 * Shift 的处理：只在带 Ctrl/Cmd 的组合里当作独立修饰键，用来区分
 * 撤销（mod+z）与重做（mod+shift+z）；单键按住 Shift 只会打出大写 / 符号，
 * 已经体现在主键本身（都转小写），不再另算一个键。
 */
export function keyCombo(e: KeyLike): string {
  const key = normalizeKeyName((e && e.key) || "");
  if (!key || MODIFIER_KEYS.has(key)) return "";
  const mod = !!(e.ctrlKey || e.metaKey);
  const parts: string[] = [];
  if (mod) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (mod && e.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

/** 单个键位的展示名。 */
const KEY_LABELS: Record<string, string> = {
  escape: "Esc",
  delete: "Delete",
  backspace: "Backspace",
  space: "Space",
  enter: "Enter",
  tab: "Tab",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

/** 把 combo 转成可读文本，例如 `"mod+shift+z"` → `"Ctrl/⌘ + Shift + Z"`。 */
export function formatCombo(combo: string): string {
  if (!combo) return "";
  return combo
    .split("+")
    .map((p) => {
      if (p === "mod") return "Ctrl/⌘";
      if (p === "alt") return "Alt";
      if (p === "shift") return "Shift";
      if (KEY_LABELS[p]) return KEY_LABELS[p];
      if (p.length === 1) return p.toUpperCase();
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join(" + ");
}

/**
 * 某动作当前生效的键位列表。
 * - 有自定义（overrides[id] 存在且非空）→ 用自定义；
 * - 自定义为空串 → 主动禁用，返回空列表；
 * - 否则用默认别名。
 */
export function actionCombos(id: string, overrides?: Record<string, string> | null): string[] {
  const a = HOTKEY_ACTIONS.find((x) => x.id === id);
  if (!a) return [];
  const custom = overrides ? overrides[id] : undefined;
  if (custom !== undefined) return custom === "" ? [] : [custom];
  return a.defaults.slice();
}

/**
 * 构建「combo → 动作 id」的反查表。
 *
 * 用户自定义优先：先铺未改动的默认键，再盖自定义键，因此冲突时自定义胜出。
 * （两个动作都被指到同一个键的极端情况，按 HOTKEY_ACTIONS 顺序后者覆盖前者；
 * 设置页录制时会先把占用该键的动作清掉并提示，正常不会出现。）
 */
export function resolveHotkeys(overrides?: Record<string, string> | null): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of HOTKEY_ACTIONS) {
    const custom = overrides ? overrides[a.id] : undefined;
    if (custom !== undefined) continue; // 已被用户改写（含禁用），跳过默认
    for (const k of a.defaults) map.set(k, a.id);
  }
  if (overrides) {
    for (const a of HOTKEY_ACTIONS) {
      const custom = overrides[a.id];
      if (custom === undefined || custom === "") continue;
      map.set(custom, a.id);
    }
  }
  return map;
}

/**
 * 某动作当前「实际生效」的主键展示文本（无绑定 / 被别的动作抢占时为空）。
 * 用在工具按钮 tooltip、设置页当前键位等。
 */
export function hotkeyLabelFor(id: string, overrides?: Record<string, string> | null): string {
  const map = resolveHotkeys(overrides);
  for (const k of actionCombos(id, overrides)) {
    if (map.get(k) === id) return formatCombo(k);
  }
  return "";
}

/**
 * 清理从 data.json 读进来的 hotkeys：只保留已知动作 id、值为字符串的项。
 * 手动编辑 / 旧版本可能写进奇怪的键，别让坏数据进内存。
 */
export function sanitizeHotkeys(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!HOTKEY_ACTION_IDS.has(k)) continue;
    if (typeof v !== "string") continue;
    if (v.length > 40) continue;
    out[k] = v;
  }
  return out;
}
