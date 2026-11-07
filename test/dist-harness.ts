/**
 * 交付物验证：直接加载构建产物 dist/inkbook/main.js（压缩后的真实文件），
 * 用替身提供 obsidian 模块，确认最终交付物能正常注册、打开文件、落笔、导出。
 *
 * 这个测试跑的是用户真正会装到 Obsidian 里的那个文件，而不是源码。
 */
import fs from "node:fs";
import path from "node:path";

const lines: string[] = [];
const out = document.getElementById("out")!;
const log = (s: string) => {
  lines.push(s);
  out.textContent = lines.join("\n");
};
let failures = 0;
const pass = (ok: boolean, label: string) => {
  if (!ok) failures++;
  log((ok ? "PASS " : "FAIL ") + label);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 造一个最小 obsidian 替身（只覆盖插件用到的 API）
  const files = new Map<string, string>();
  const index = new Map<string, any>();
  const mkFile = (p: string, text: string) => {
    const f = {
      path: p,
      basename: p.split("/").pop()!.replace(/\.[^.]+$/, ""),
      extension: p.split(".").pop()!,
      parent: { path: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "/" },
    };
    files.set(p, text);
    index.set(p, f);
    return f;
  };

  const obsidianStub = `
    export class Notice {
      constructor(msg){ console.log('[Notice] ' + msg); }
      /* 真实的 Obsidian Notice 有这两个方法；少了 hide 会在导入/导出路径上抛
         "n.hide is not a function"，产物级测试直接 FATAL。 */
      hide(){}
      setMessage(m){ this.msg = String(m); }
    }
    export function setIcon(el, name){
      el.innerHTML = '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M4 4h10l6 6v10H4z"/></svg>';
      el.dataset.icon = name;
    }
    export class Menu {
      constructor(){ this.items = []; }
      addItem(cb){ const it = { setTitle(){return it;}, setIcon(){return it;}, setChecked(){return it;}, onClick(){return it;} }; cb(it); this.items.push(it); }
      addSeparator(){}
      showAtMouseEvent(){}
    }
    export class Modal {
      constructor(app){ this.app = app; this.contentEl = document.createElement('div'); }
      open(){ document.body.appendChild(this.contentEl); }
      close(){ this.contentEl.remove(); }
      onOpen(){}
      onClose(){}
    }
    export class FuzzySuggestModal extends Modal {
      constructor(app){ super(app); this.inputEl = document.createElement('input'); }
      getItems(){ return []; }
      getItemText(){ return ''; }
      onChooseItem(){}
    }
    export class PluginSettingTab {
      constructor(app, plugin){ this.app = app; this.plugin = plugin; this.containerEl = document.createElement('div'); }
      display(){}
      hide(){}
    }
    export class Setting {
      constructor(el){ this.el = el; }
      setName(){ return this; }
      setDesc(){ return this; }
      addText(cb){ const c = { value:'', setPlaceholder(){return c;}, setValue(v){c.value=v;return c;}, onChange(){return c;}, inputEl: document.createElement('input') }; if(cb) cb(c); return this; }
      addToggle(cb){ const c = { value:false, setValue(v){c.value=v;return c;}, onChange(){return c;}, toggleEl: document.createElement('div') }; if(cb) cb(c); return this; }
      addSlider(cb){ const c = { value:0, setLimits(){return c;}, setValue(v){c.value=v;return c;}, setDynamicTooltip(){return c;}, onChange(){return c;}, sliderEl: document.createElement('input') }; if(cb) cb(c); return this; }
      addDropdown(cb){ const c = { value:'', addOption(){return c;}, setValue(v){c.value=v;return c;}, onChange(){return c;}, selectEl: document.createElement('select') }; if(cb) cb(c); return this; }
      addButton(cb){ const c = { buttonEl: document.createElement('button'), setButtonText(){return c;}, setIcon(){return c;}, onClick(){return c;}, setTooltip(){return c;} }; if(cb) cb(c); return this; }
      addColorPicker(cb){ const c = { value:'#000000', setValue(v){c.value=v;return c;}, onChange(){return c;}, colorEl: document.createElement('input') }; if(cb) cb(c); return this; }
      addExtraButton(cb){ const c = { extraSettingsEl: document.createElement('div'), setTooltip(){return c;}, setIcon(){return c;}, onClick(){return c;} }; if(cb) cb(c); return this; }
      then(cb){ if(cb) cb(this); return this; }
    }
    export class Plugin {
      constructor(app, manifest){ this.app = app; this.manifest = manifest; this.__views = {}; this.__cmds = []; this.__ribbons = []; this.__settingsTab = null; this.__data = {}; this.__protocols = {}; }
      registerView(type, cb){ this.__views[type] = cb; }
      registerExtensions(){ }
      registerMarkdownPostProcessor(cb){ (this.__pp = this.__pp || []).push(cb); return { unregister(){} }; }
      addRibbonIcon(icon, title, cb){ this.__ribbons.push({icon,title}); }
      addCommand(c){ this.__cmds.push(c); }
      addSettingTab(t){ this.__settingsTab = t; }
      registerObsidianProtocolHandler(action, handler){ this.__protocols[action] = handler; }
      registerEvent(){ return () => {}; }
      async loadData(){
        // 没有 data.json 时给一份默认设置，和真实插件一致
        if (!this.__data || !Object.keys(this.__data).length) {
          this.__data = {
            defaultTemplate: "grid", defaultPaper: "white", penOnly: false,
            pressure: 1, smoothing: 0.55, prediction: true, autosave: true,
            sidebarOpen: true, defaultPenSize: 2.8,
            lastPenColor: "#1A1A1A", lastHighlighterColor: "#F6E05E",
            blockEdgeSwipe: true, blockCommandPalette: true, straightLine: false,
            searchIndex: true
          };
        }
        return this.__data;
      }
      async saveData(d){ this.__data = d; window.__inkbook_saved = d; }
    }
    export class Component {
      constructor(){ this._dom = []; }
      registerDomEvent(el, type, cb){ el.addEventListener(type, cb); this._dom.push([el, type, cb]); }
      registerEvent(){ return () => {}; }
      registerInterval(){ return 0; }
      load(){ return Promise.resolve(); }
      onload(){}
      unload(){}
    }
    export class FileView extends Component {
      constructor(leaf){ super(); this.leaf = leaf; this.contentEl = document.createElement('div'); this.containerEl = document.createElement('div'); this.containerEl.appendChild(this.contentEl); }
      getViewType(){ return ''; }
      getDisplayText(){ return ''; }
      getIcon(){ return ''; }
      getState(){ return {}; }
      setState(){ return Promise.resolve(); }
      canAcceptExtension(){ return false; }
      onResize(){}
      async onOpen(){}
      async onClose(){}
      async onLoadFile(){}
      async onUnloadFile(){}
      /* 宿主改名会调它（不重载视图）；插件覆写了 onRename（INK-174） */
      async onRename(file){ this.file = file; }
    }
    export class Events {}
    export class TAbstractFile {}
    export class TFile extends TAbstractFile {}
    export class TFolder extends TAbstractFile {}
    export class Scope {}
  `;

  // Obsidian 给 HTMLElement 加了一堆扩展方法，替身必须补上
  const proto = (window as any).HTMLElement.prototype as any;
  if (!proto.empty) {
    proto.empty = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      return this;
    };
    proto.detach = function () {
      this.remove();
      return this;
    };
    proto.setText = function (t: string) {
      this.textContent = t;
      return this;
    };
    proto.addClass = function (...cls: string[]) {
      this.classList.add(...cls);
      return this;
    };
    proto.removeClass = function (...cls: string[]) {
      this.classList.remove(...cls);
      return this;
    };
    proto.toggleClass = function (cls: string, on?: boolean) {
      if (on === undefined) this.classList.toggle(cls);
      else if (on) this.classList.add(cls);
      else this.classList.remove(cls);
      return this;
    };
    proto.hasClass = function (cls: string) {
      return this.classList.contains(cls);
    };
    proto.setAttr = function (k: string, v: string) {
      this.setAttribute(k, v);
      return this;
    };
    proto.setCss = function (k: string, v: string) {
      this.style.setProperty(k, v);
      return this;
    };
    // Obsidian 的 createDiv/createSpan/createEl 支持字符串参数当 className
    const applyOpts = (el: HTMLElement, o: any) => {
      if (typeof o === "string") {
        el.className = o;
        return;
      }
      if (!o || typeof o !== "object") return;
      if (o.cls) el.className = o.cls;
      if (o.text) el.textContent = o.text;
      if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, String(v));
      if (o.title) el.title = o.title;
    };
    proto.createDiv = function (o?: any) {
      const el = document.createElement("div");
      applyOpts(el, o);
      this.appendChild(el);
      return el;
    };
    proto.createSpan = function (o?: any) {
      const el = document.createElement("span");
      applyOpts(el, o);
      this.appendChild(el);
      return el;
    };
    proto.createEl = function (tag: string, o?: any) {
      const el = document.createElement(tag);
      if (o && typeof o === "object") {
        if (o.cls) el.className = o.cls;
        if (o.text) el.textContent = o.text;
        if (o.type) el.setAttribute("type", o.type);
        if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, String(v));
        if (o.title) el.title = o.title;
      }
      this.appendChild(el);
      return el;
    };
  }

  const blobUrl = URL.createObjectURL(new Blob([obsidianStub], { type: "text/javascript" }));
  const mod = await import(blobUrl);
  (window as any).__obsidianStub = mod;

  // 取构建产物
  const distPath = "/dist/inkbook/main.js";
  let code: string;
  try {
    const res = await fetch(distPath);
    if (!res.ok) throw new Error("HTTP " + res.status);
    code = await res.text();
  } catch (e: any) {
    log("FATAL 无法读取构建产物：" + (e && e.message));
    document.title = "FATAL";
    return;
  }
  pass(code.length > 100000, "读到构建产物 " + Math.round(code.length / 1024) + " KB");

  // Obsidian 加载插件的方式：window.eval("(function anonymous(require,module,exports){...})")
  const requireShim = (id: string) => {
    if (id === "obsidian") return mod;
    throw new Error("插件不应 require " + id);
  };
  const moduleObj = { exports: {} as any };
  try {
    const fn = window.eval(
      "(function anonymous(require,module,exports){" + code + "\n})"
    ) as Function;
    fn(requireShim, moduleObj, moduleObj.exports);
  } catch (e: any) {
    log("FATAL 加载产物失败：" + (e && e.stack ? e.stack : e));
    document.title = "FATAL";
    return;
  }
  pass(true, "产物在 CommonJS 沙箱里加载成功");

  const PluginClass = moduleObj.exports.default || moduleObj.exports;
  pass(typeof PluginClass === "function", "导出 Plugin 类：" + typeof PluginClass);

  // 造 app
  const app: any = {
    vault: {
      adapter: {
        exists: async (p: string) => files.has(p),
        read: async (p: string) => files.get(p) || "",
        write: async (p: string, d: string) => {
          files.set(p, String(d));
        },
        mkdir: async () => {},
        writeBinary: async (p: string, d: any) => {
          files.set(p, d);
        },
        readBinary: async (p: string) => files.get(p),
        getFullPath: (p: string) => "/tmp/" + p,
      },
      getFiles: () => [],
      getAbstractFileByPath: (p: string) => index.get(p) || null,
      on: () => ({}),
      create: async (p: string, t: string) => mkFile(p, t),
      createFolder: async (p: string) => ({ path: p, type: "folder" }),
    },
    workspace: {
      on: () => ({}),
      onLayoutReady: (cb: () => void) => setTimeout(cb, 0),
      getLeaf: () => ({ openFile: async () => {}, setViewState: async () => {} }),
      getActiveFile: () => null,
      getActiveViewOfType: () => null,
      getLeavesOfType: () => [],
    },
    viewRegistry: { typeByExtension: {} as any, trigger() {} },
  };

  const plugin = new PluginClass(app, {
    id: "inkbook",
    name: "墨本 Inkbook",
    version: "0.1.0",
    dir: ".obsidian/plugins/inkbook",
  });
  await plugin.onload();
  pass(true, "onload 完成");
  pass(Object.keys(plugin.__views).length === 1, "注册了视图：" + Object.keys(plugin.__views).join(","));
  pass(
    plugin.__cmds.length === 4 &&
      plugin.__cmds.some((c: any) => c.id === "inkbook-rebuild-index"),
    "注册了 4 条命令（含重建索引）：" + plugin.__cmds.map((c: any) => c.id).join(",")
  );
  pass(plugin.__ribbons.length === 2, "注册了 2 个侧栏图标");
  pass(!!plugin.__settingsTab, "注册了设置面板");
  pass(!!plugin.__protocols.inkbook, "注册了 obsidian://inkbook 跳页协议");

  // 打开一个真实的 .inkbook
  const sample = JSON.stringify({
    version: 1,
    kind: "inkbook",
    title: "产物验证",
    width: 794,
    height: 1123,
    created: Date.now(),
    updated: 0,
    activePage: 0,
    pages: [
      {
        id: "p1",
        template: "grid",
        paper: "white",
        activeLayerId: "l1",
        layers: [{ id: "l1", name: "笔迹层", visible: true, opacity: 1, strokes: [] }],
        // 产物级导出冒烟要用：有 user 批注才会走「内联中文字体」那条路
        texts: [
          { id: "t1", source: "user", x: 60, y: 300, size: 16, color: "#1A1A1A", text: "产物导出冒烟" },
        ],
      },
    ],
  });
  const file = mkFile("验证.inkbook", sample);
  // registerView 存的是工厂：(leaf) => new View(leaf, plugin)
  const view = plugin.__views["inkbook-view"]({ app: plugin.app, view: {} });
  (view as any).app = app;
  /*
   * 真实 Obsidian 的结构：contentEl **就是** .view-content 元素本身。
   *
   * 早先这里多套了一层 `.view-content` div，而那层是 display:flex（行向），
   * 于是 .mb-root 按内容收缩成 240px 宽——页面被挤成一条，
   * 滚动容器永远不产生溢出，缩放补偿完全失效。
   * 结构必须和真实 Obsidian 一致，否则测出来的不是用户看到的东西。
   */
  const host = document.getElementById("view-host")!;
  const contentEl = (view as any).contentEl as HTMLElement;
  contentEl.classList.add("view-content");
  host.appendChild(contentEl);
  await view.onOpen();
  await view.onLoadFile(file);
  await sleep(500);

  /*
   * 产物级断言：验证用户真正装到 Obsidian 里的那个文件里，
   * 墨具坞的圆钮、标签页、工具按钮都在。
   */
  pass(!!view.containerEl.querySelector(".mb-toprow"), "顶栏工具行已渲染");
  pass(!!view.containerEl.querySelector(".mb-rail-side"), "顶栏侧栏开关已渲染");
  pass(!!view.containerEl.querySelector(".mb-rail-read"), "顶栏仅阅读按钮已渲染");
  pass(!!host.querySelector(".mb-float"), "右下角浮标已渲染");
  pass(
    view.containerEl.querySelectorAll(".mb-top-tool").length === 8,
    "8 个工具按钮已渲染：" +
      view.containerEl.querySelectorAll(".mb-top-tool").length +
      " 个"
  );
  pass(
    host.querySelectorAll(".mb-ic").length >= 8,
    "自绘图标已渲染：" + host.querySelectorAll(".mb-ic").length + " 个"
  );
  pass(host.querySelectorAll(".mb-page").length === 1, "A4 页面已渲染");
  pass(host.querySelectorAll(".mb-swatch").length >= 8, "笔盒颜色已渲染：" + host.querySelectorAll(".mb-swatch").length + " 个");

  // 落一笔
  const pageEl = host.querySelector(".mb-page") as HTMLElement;
  const r = pageEl.getBoundingClientRect();
  const fire = (type: string, x: number, y: number) =>
    pageEl.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        bubbles: true,
        cancelable: true,
        clientX: r.left + x,
        clientY: r.top + y,
        pressure: 0.5,
        buttons: type === "pointerup" ? 0 : 1,
      })
    );
  fire("pointerdown", 60, 120);
  for (let i = 1; i <= 20; i++) {
    fire("pointermove", 60 + i * 6, 120 + Math.sin(i / 3) * 12);
    await sleep(6);
  }
  fire("pointerup", 180, 120);
  await sleep(300);

  // 等自动保存落盘（debounce 850ms）
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    if ((files.get("验证.inkbook") || "").length > 400) break;
  }
  const saved = (window as any).__inkbook_saved;
  const raw = files.get("验证.inkbook") || "";
  const strokes = JSON.parse(raw).pages[0].layers[0].strokes;
  pass(strokes.length === 1, "产物能落笔：写了 " + strokes.length + " 条");
  pass(strokes[0] && strokes[0].points.length > 5, "笔迹有 " + (strokes[0]?.points.length ?? 0) + " 个采样点");
  const ps = strokes[0]?.points.map((p: number[]) => p[2]) ?? [];
  const min = Math.min(...ps);
  const max = Math.max(...ps);
  pass(max - min > 0.05, "笔迹有粗细变化：" + min.toFixed(2) + "–" + max.toFixed(2));

  // 设置只有在被改动过才会写回，这里验证读取链路正常即可
  pass(
    (view as any).plugin?.settings?.smoothing === 0.55,
    "设置已从 data.json 读入（smoothing=" + (view as any).plugin?.settings?.smoothing + "）"
  );

  /* -------------------- 缩放锚点（产物级） -------------------- */
  //
  // 这一组很关键：用户装的是**压缩后的 main.js**，
  // 不是源码。缩放修复必须真的进了产物里。
  {
    const editor = (view as any).editor;
    const scroll = editor?.scrollEl;
    pass(!!scroll, "产物里的编辑器有滚动容器");

    if (scroll) {
      const ed = editor;
      const sr = scroll.getBoundingClientRect();
      const pageEl = host.querySelector(".mb-page") as HTMLElement;

      // 在页面上取一个锚点，量它的屏幕位置
      const rect0 = pageEl.getBoundingClientRect();
      const fx = 0.5;
      const fy = 0.5;
      const probe = () => {
        const r = pageEl.getBoundingClientRect();
        return { x: r.left + fx * r.width, y: r.top + fy * r.height };
      };

      const clientX = sr.left + 400;
      const clientY = rect0.top + rect0.height * fy;
      const before = probe();

      // 初始是 fit 模式（按容器算出来的缩放比），所以要按比例断言
      const z0 = ed.getState().zoom;
      editor.zoomAt(clientX, clientY, 1.12);
      await sleep(250);
      const after = probe();

      const drift = Math.abs(after.y - before.y);
      // 浏览器 scrollTop 取整带来 ±0.5px 物理下限
      pass(
        drift < 1.5,
        "产物：锚点缩放不漂移（漂移 " + drift.toFixed(2) + "px）"
      );
      pass(
        Math.abs(ed.getState().zoom - z0 * 1.12) < 0.01,
        "产物：缩放比正确（" + z0.toFixed(3) + " → " + ed.getState().zoom.toFixed(3) + "）"
      );
      // 滚动容器必须真的能滚——否则缩放补偿无从谈起
      pass(
        scroll.scrollHeight > scroll.clientHeight,
        "产物：滚动容器可滚动（scrollH=" + scroll.scrollHeight + " > clientH=" + scroll.clientHeight + "）"
      );

      // 页间距必须量得准——这是「跳好几页」的根因
      const gap = ed.pageGap;
      pass(
        Math.abs(gap - 24) < 0.1,
        "产物：页间距测量精确（" + gap.toFixed(3) + "px）"
      );
    }
  }

  /*
   * 产物级导出的冒烟（HANDOFF §3.5 记的测试缺口）。
   *
   * 源码侧的 export / pdftext 套件跑的是**源码 bundle**；用户真正装的是
   * dist/main.js。`.ttf` 的 dataurl 内联、pdf-lib 打包、fontkit 注册——
   * 任何一环在构建配置里掉了，源码测试都是全绿，只有装到 Obsidian 里才发现导不出字。
   */
  {
    const before = new Set(files.keys());
    await (view as any).runExport("pdf");
    const added = [...files.keys()].filter((k) => !before.has(k));
    const pdfKey = added.find((k) => k.endsWith("-手写本.pdf"));
    pass(!!pdfKey, "产物导出：写出了 PDF（" + (added.join(", ") || "无新文件") + "）");

    const raw = pdfKey ? (files.get(pdfKey) as unknown as ArrayBuffer) : null;
    const bytes = raw ? new Uint8Array(raw) : new Uint8Array(0);
    const head = String.fromCharCode(...bytes.slice(0, 5));
    pass(bytes.length > 0 && head === "%PDF-", "产物导出：是合法 PDF（" + bytes.length + " B，头 " + head + "）");
    /*
     * 有批注时字体会整份内联，导出件必然 > 1MB；如果 .ttf loader 在构建里掉了，
     * 导出会静默退回「批注烤进位图」，文件只有几 KB —— 这条断言就是拦它的。
     */
    pass(
      bytes.length > 100_000,
      "产物导出：中文字体确实内联进产物（" + Math.round(bytes.length / 1024) + "KB > 100KB）"
    );
  }

  /*
   * 改名后必须写到新路径（INK-174）。
   *
   * 走**压缩产物**：`bookPath` 是 saveNow 写盘时优先用的路径，
   * 而宿主改名只换 `file.path`、不重载视图。插件不覆写 onRename 的话
   * bookPath 永远停在旧路径 → 改名后每次保存都在旧路径造文件。
   * 这里只验「覆写的方法存在且能把 bookPath 跟上」，不重复 p1 的完整往返。
   */
  {
    const before = (view as any).bookPath;
    const renamed: any = { path: "改名后的本子.inkbook", name: "改名后的本子.inkbook", basename: "改名后的本子", extension: "inkbook" };
    let threw = "";
    try {
      await (view as any).onRename(renamed);
    } catch (e: any) {
      threw = String(e?.message || e);
    }
    pass(
      threw === "" && (view as any).bookPath === renamed.path,
      "产物改名：onRename 不抛异常且 bookPath 跟到新路径（" +
        before + " → " + (view as any).bookPath + "；异常=" + JSON.stringify(threw.slice(0, 60)) + "）"
    );
  }

  await view.onUnloadFile();
  await view.onClose();

  log(failures === 0 ? "ALL PASS" : failures + " FAILED");
  document.title = "DONE";
}

main();
