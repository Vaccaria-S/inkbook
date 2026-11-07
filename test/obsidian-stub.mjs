/** 极简 obsidian API 替身，只在测试里用，让 view.js 能跑在普通浏览器里 */

function installDomHelpers() {
  if (HTMLElement.prototype.createEl) return;
  HTMLElement.prototype.createEl = function (tag, opts = {}) {
    if (typeof opts === 'string') opts = { cls: opts };
    const el = document.createElement(tag);
    if (opts.cls) el.className = opts.cls;
    if (opts.text != null) el.textContent = opts.text;
    if (opts.attr) for (const k of Object.keys(opts.attr)) el.setAttribute(k, opts.attr[k]);
    if (opts.href) el.setAttribute('href', opts.href);
    this.appendChild(el);
    return el;
  };
  HTMLElement.prototype.createDiv = function (opts) {
    return this.createEl('div', opts);
  };
  HTMLElement.prototype.createSpan = function (opts) {
    return this.createEl('span', opts);
  };
  HTMLElement.prototype.empty = function () {
    this.innerHTML = '';
    return this;
  };
  HTMLElement.prototype.addClass = function (...c) {
    this.classList.add(...c);
    return this;
  };
  HTMLElement.prototype.removeClass = function (...c) {
    this.classList.remove(...c);
    return this;
  };
  HTMLElement.prototype.toggleClass = function (c, on) {
    this.classList.toggle(c, on);
    return this;
  };
  HTMLElement.prototype.setText = function (t) {
    this.textContent = t;
    return this;
  };
  HTMLElement.prototype.appendText = function (t) {
    this.appendChild(document.createTextNode(t));
    return this;
  };
  HTMLElement.prototype.setAttr = function (k, v) {
    this.setAttribute(k, v);
    return this;
  };
}
installDomHelpers();

export class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = document.createElement('div');
    this.containerEl.className = 'view-content';
    this.contentEl = document.createElement('div');
    this.containerEl.appendChild(this.contentEl);
    document.getElementById('view-host').appendChild(this.containerEl);
  }
  registerDomEvent(el, type, fn, opts) {
    el.addEventListener(type, fn, opts);
  }
  registerEvent() {}
  addAction() {}
  getViewType() {
    return 'stub';
  }
  getDisplayText() {
    return 'stub';
  }
  getIcon() {
    return 'file';
  }
}

export class FileView extends ItemView {
  async loadFile(file) { this.file = file; await this.onLoadFile(file); }
  /**
   * 宿主改名时调这个（**不重载视图**）。
   *
   * 桩里必须真的有这个方法：`view.onRename` 是我们覆写的
   * （INK-174：bookPath 要跟着新路径走），父类没有的话
   * `super.onRename` 之类的写法会炸；而且没有它，
   * 测试也无法模拟「宿主改名」这条真实路径。
   */
  async onRename(file) { this.file = file; }
  canAcceptExtension() { return true; }
  getState() { return { file: this.file && this.file.path }; }
}

const ICONS = {
  'pen-tool': 'M12 19l7-7 3 3-7 7-3-3z M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z M2 2l7.6 7.6 M11 11l-2 2',
  highlighter: 'M9 11l-6 6v3h9l3-3 M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4l8 8z',
  eraser: 'M7 21l-4.3-4.3a2 2 0 0 1 0-2.8l9.6-9.6a2 2 0 0 1 2.8 0l5.6 5.6a2 2 0 0 1 0 2.8L14 21H7z M22 21H7 M5 11l9 9',
  tablet: 'M4 2h16v20H4z M12 18h.01',
  'undo-2': 'M9 14L4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  'redo-2': 'M15 14l5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  plus: 'M5 12h14 M12 5v14',
  'layout-template': 'M3 3h18v18H3z M3 9h18 M9 21V9',
  'zoom-in': 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3 M11 8v6 M8 11h6',
  'zoom-out': 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3 M8 11h6',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  notebook: 'M3 3h15a3 3 0 0 1 3 3v15H6a3 3 0 0 1-3-3V3z M8 3v18 M3 8h5',
  x: 'M18 6L6 18 M6 6l12 12',
  image: 'M3 3h18v18H3z M3 16l5-5 4 4 3-3 6 6',
  'file-text': 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h8',
  'book-open': 'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z',
  'mouse-pointer-2': 'M4 4l7 17 3-7 7-3z',
  'eye-off': 'M17.9 17.9A10 10 0 0 1 12 20C5 20 2 12 2 12a18 18 0 0 1 5.1-5.9 M9.9 4.2A10 10 0 0 1 12 4c7 0 10 8 10 8a18 18 0 0 1-2.1 3.2 M14.1 14.1a3 3 0 1 1-4.2-4.2 M2 2l20 20',
  eye: 'M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  list: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  pencil: 'M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  hand: 'M18 11V6a2 2 0 0 0-4 0v5 M14 10V4a2 2 0 0 0-4 0v7 M10 10.5V6a2 2 0 0 0-4 0v8 M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.5L2 15a2 2 0 0 1 3-3l3 3',
  lasso: 'M7 22a5 5 0 0 1-2-4 M3.3 14A7 7 0 1 1 20 9.5 M5 17a7 7 0 0 0 14-1.5 M11 12a1 1 0 1 0 2 0 1 1 0 0 0-2 0',
  square: 'M3 3h18v18H3z',
  'trash-2': 'M3 6h18 M8 6V4h8v2 M19 6l-1 14H6L5 6 M10 11v6 M14 11v6',
  copy: 'M8 8h12v12H8z M4 16V4h12',
  'panel-right': 'M3 3h18v18H3z M15 3v18',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-left': 'M15 18l-6-6 6-6',
  'chevron-right': 'M9 18l6-6-6-6',
  import: 'M12 3v12 M7 10l5 5 5-5 M4 21h16',
  'pen-line': 'M12 19l7-7 3 3-7 7-3-3z M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z M2 2l7.6 7.6',
  sliders: 'M4 6h10 M18 6h2 M4 12h4 M12 12h8 M4 18h12 M20 18h0 M14 4v4 M8 10v4 M16 16v4',
};

export function setIcon(el, name) {
  const d = ICONS[name] || 'M4 4h10l6 6v10H4z';
  el.innerHTML =
    '<svg class="svg-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' +
    d +
    '"/></svg>';
  el.dataset.icon = name;
}

export class Notice {
  constructor(msg) {
    this.msg = String(msg);
    console.log('[Notice] ' + this.msg);
  }
  hide() {}
  setMessage(m) {
    this.msg = String(m);
  }
}

export class Menu {
  constructor() {
    this.items = [];
    Menu.last = this;
  }
  addItem(cb) {
    const item = {
      title: '',
      setTitle(t) {
        item.title = t;
        return item;
      },
      setIcon() {
        return item;
      },
      setDisabled() {
        return item;
      },
      setChecked(v) {
        item.checked = v;
        return item;
      },
      onClick(fn) {
        item.fn = fn;
        return item;
      },
    };
    cb(item);
    this.items.push(item);
    return this;
  }
  addSeparator() {
    return this;
  }
  showAtMouseEvent() {
    this.shown = true;
    return this;
  }
  showAtPosition(pos) {
    this.shown = true;
    this.pos = pos;
    return this;
  }
}

export class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'modal-content';
    document.body.appendChild(this.contentEl);
    this.containerEl = this.contentEl;
  }
  open() {
    if (typeof this.onOpen === 'function') this.onOpen();
  }
  close() {
    if (typeof this.onClose === 'function') this.onClose();
    this.contentEl.remove();
  }
}

export class FuzzySuggestModal {
  constructor(app) {
    this.app = app;
  }
  setPlaceholder() {}
  open() {}
}

export const Platform = { isMacOS: false, isMobile: false, isDesktop: true };

export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
  }
}

export class Setting {
  constructor(el) {
    this.el = el;
  }
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  addText(cb) {
    const c = {
      value: '',
      setPlaceholder() {
        return c;
      },
      setValue(v) {
        c.value = v;
        return c;
      },
      onChange(fn) {
        c.fn = fn;
        return c;
      },
      inputEl: document.createElement('input'),
    };
    if (cb) cb(c);
    this.text = c;
    return this;
  }
  addToggle() {
    return this;
  }
  addSlider() {
    return this;
  }
  addDropdown() {
    return this;
  }
  addButton() {
    return this;
  }
}

export class TFile {}

export function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

export class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
  registerView(type, cb) {
    (this.app.__views = this.app.__views || {})[type] = cb;
  }
  registerExtensions(exts, type) {
    const reg = this.app && this.app.viewRegistry;
    if (!reg || !reg.typeByExtension) return;
    for (const e of exts) {
      if (Object.prototype.hasOwnProperty.call(reg.typeByExtension, e)) {
        throw new Error('Attempting to register an existing file extension "' + e + '"');
      }
    }
    exts.forEach((e) => (reg.typeByExtension[e] = type));
    reg.trigger && reg.trigger('extensions-updated');
  }
  register() {}
  addRibbonIcon() {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
  }
  addCommand(cmd) {
    (window.__commands = window.__commands || []).push(cmd);
    return cmd;
  }
  addSettingTab(tab) {
    window.__settingTab = tab;
  }
  registerEvent() {}
  registerDomEvent() {}
  /**
   * Markdown 后处理器：Obsidian 在渲染 md 段落时回调。
   *
   * 桩里只把回调收集起来（window.__markdownPostProcessors），
   * 测试可以手动拿它渲染手工构造的 DOM——见 test/embed-harness.ts。
   */
  registerMarkdownPostProcessor(cb) {
    (window.__markdownPostProcessors = window.__markdownPostProcessors || []).push(cb);
    return { unregister() {} };
  }
  /**
   * 协议处理器：Obsidian 的 `obsidian://inkbook?file=…&page=N` 走这里。
   * 桩里只记下来，测试可以手动触发（window.__protocolHandlers）。
   */
  registerObsidianProtocolHandler(action, handler) {
    (window.__protocolHandlers = window.__protocolHandlers || {})[action] = handler;
  }
  async loadData() {
    return this.__data || {};
  }
  async saveData(d) {
    this.__data = d;
  }
}

