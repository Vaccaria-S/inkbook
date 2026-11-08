import { Modal, Notice, Setting, type App, type TFile } from "obsidian";
import { createBook, PAPERS, TEMPLATES, type PaperId, type TemplateId } from "./types";
import { paintPaperPreview } from "./paper";

export function safeName(s: string): string {
  return String(s).replace(/[\\/:*?"<>|#^[\]]/g, "_").trim() || "未命名笔记";
}

/**
 * 清洗「从设备选进来的完整文件名」。
 *
 * 为什么不直接用 safeName：设备上的文件名**带扩展名**，而 safeName
 * 会把 `.` 之外的非法字符全换掉、相当于把扩展名也当成名字的一部分。
 * 这里要保留（并规范化）扩展名，只清洗主干：
 *   · 平板的文件管理器可能给出 `我的/讲义?.pdf` 这种带路径分隔符的名字；
 *   · Windows 同步过来的名字可能带 `<>:"|`，直接当路径写入会失败；
 *   · 超长名字会撞上文件系统 / Obsidian 路径长度限制。
 *
 * 扩展名只保留 ASCII 字母数字（`.PDF` → `.pdf`），避免出现
 * `.p df` 这种既不是有效扩展名、又会在平板文件选择器里被忽略的形态。
 */
export function safeImportFileName(name: string): string {
  const raw = String(name || "");
  const dot = raw.lastIndexOf(".");
  const stem0 = dot > 0 ? raw.slice(0, dot) : raw;
  const ext = dot > 0 ? raw.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  let stem = stem0
    .replace(/[\\/:*?"<>|#^[\]]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    // 主干不能以点开头：`.hidden` 会变成库里的隐藏文件，用户找不到
    .replace(/^\.+/, "")
    .trim();
  if (!stem) stem = "imported";
  if (stem.length > 80) stem = stem.slice(0, 80).trim() || "imported";
  /*
   * **Windows 保留名**（INK-208）。
   *
   * `CON` / `PRN` / `AUX` / `NUL` / `COM1`~`COM9` / `LPT1`~`LPT9` 在
   * Windows 上**无法作为文件名创建**（带扩展名的 `CON.pdf` 也不行，
   * 系统会当成设备名）。上面那套非法字符替换完全拦不住它们，而这次
   * 新功能正是「从设备选文件」——用户完全可能选中这类名字，在 Windows
   * 上创建会直接失败。加下划线前缀即可，不必改用户看得懂的部分。
   */
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = "_" + stem;
  return ext ? `${stem}.${ext}` : stem;
}

/**
 * 读 `File` 的二进制。
 *
 * 优先 `arrayBuffer()`：Electron / Capacitor 的 Chromium 都有，能直接
 * 避免 FileReader 的额外一次进度事件。老 WebView 没有时退回 FileReader
 * ——平板上的 Obsidian 内核版本不一定跟桌面一致。
 */
function readFileAsArrayBuffer(f: File): Promise<ArrayBuffer> {
  const anyFile = f as any;
  if (typeof anyFile.arrayBuffer === "function") return anyFile.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsArrayBuffer(f);
  });
}

/** 导入源弹窗接受的文件类型（`any` = 空视图的「导入文档开始」，两种都收） */
export type ImportSourceKind = "pdf" | "word" | "any";

/** 超过这个体积就在动手前提醒一次：读进内存 + 写盘会让平板卡几秒 */
const BIG_FILE_HINT_BYTES = 20 * 1024 * 1024;

export class NewBookModal extends Modal {
  private name = "";
  private folder = "";
  private template: TemplateId;
  private paper: PaperId;
  private onDone: (file: TFile) => void;
  private plugin: {
    settings: { defaultTemplate: TemplateId; defaultPaper: PaperId };
    saveSettings(): Promise<void>;
  };

  constructor(
    app: App,
    plugin: {
      settings: { defaultTemplate: TemplateId; defaultPaper: PaperId };
      saveSettings(): Promise<void>;
    },
    onDone: (file: TFile) => void
  ) {
    super(app);
    this.plugin = plugin;
    this.onDone = onDone;
    this.template = plugin.settings.defaultTemplate;
    this.paper = plugin.settings.defaultPaper;
    const active = app.workspace.getActiveFile();
    this.folder = active && active.parent && active.parent.path !== "/" ? active.parent.path : "";
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("mb-new-modal");
    contentEl.createEl("h3", { text: "新建手写本" });

    new Setting(contentEl)
      .setName("名称")
      .setDesc("会生成一个 .inkbook 文件")
      .addText((t) =>
        t
          .setPlaceholder("例如：物理错题本")
          .setValue(this.name)
          .onChange((v) => (this.name = v))
      );

    new Setting(contentEl)
      .setName("文件夹")
      .setDesc("留空就放在库根目录")
      .addText((t) =>
        t
          .setPlaceholder("例如：笔记/手写")
          .setValue(this.folder)
          .onChange((v) => (this.folder = v))
      );

    contentEl.createDiv({ cls: "mb-new-label", text: "纸张模板" });
    const grid = contentEl.createDiv("mb-new-templates");
    for (const t of TEMPLATES) {
      const card = grid.createDiv("mb-new-tpl" + (t.id === this.template ? " is-active" : ""));
      const art = card.createDiv("mb-new-tpl-art");
      const cv = document.createElement("canvas");
      art.appendChild(cv);
      paintPaperPreview(cv, t.id, this.paper, 794, 1123);
      card.createDiv({ cls: "mb-new-tpl-name", text: t.label });
      card.onclick = () => {
        this.template = t.id;
        grid.querySelectorAll(".mb-new-tpl").forEach((el) => el.removeClass("is-active"));
        card.addClass("is-active");
      };
    }

    contentEl.createDiv({ cls: "mb-new-label", text: "纸色" });
    const papers = contentEl.createDiv("mb-new-papers");
    for (const p of PAPERS) {
      const b = papers.createDiv("mb-new-paper" + (p.id === this.paper ? " is-active" : ""));
      b.style.background = p.id === "cream" ? "#FCF8EC" : p.id === "gray" ? "#F5F5F3" : "#FFFFFF";
      b.title = p.label;
      b.onclick = () => {
        this.paper = p.id;
        papers.querySelectorAll(".mb-new-paper").forEach((el) => el.removeClass("is-active"));
        b.addClass("is-active");
        for (const t of TEMPLATES) {
          const art = grid.querySelector(
            `.mb-new-tpl:nth-child(${TEMPLATES.indexOf(t) + 1}) .mb-new-tpl-art`
          );
          const cv = art && art.querySelector("canvas");
          if (cv) paintPaperPreview(cv, t.id, this.paper, 794, 1123);
        }
      };
    }

    const actions = contentEl.createDiv("mb-new-actions");
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
    const create = actions.createEl("button", { cls: "mod-cta", text: "创建并打开" });
    create.onclick = () => this.create();
  }

  private async create(): Promise<void> {
    const name = safeName(this.name.trim() || "未命名笔记");
    const folder = this.folder
      .trim()
      .replace(/^\/+|\/+$/g, "")
      .replace(/\\/g, "/");
    const adapter = this.app.vault.adapter;
    try {
      if (folder) {
        let cur = "";
        for (const seg of folder.split("/").filter(Boolean)) {
          cur = cur ? cur + "/" + seg : seg;
          if (!this.app.vault.getAbstractFileByPath(cur)) {
            try {
              await this.app.vault.createFolder(cur);
            } catch (_) {
              if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
            }
          }
        }
      }
      let path = (folder ? folder + "/" : "") + name + ".inkbook";
      let n = 1;
      while (await adapter.exists(path)) {
        path = (folder ? folder + "/" : "") + `${name} ${++n}.inkbook`;
      }
      const book = createBook(name, this.template, this.paper);
      const file = await this.app.vault.create(path, JSON.stringify(book, null, 2));
      this.plugin.settings.defaultTemplate = this.template;
      this.plugin.settings.defaultPaper = this.paper;
      await this.plugin.saveSettings();
      this.onDone(file);
      this.close();
    } catch (e: any) {
      new Notice("创建失败：" + (e && e.message ? e.message : e), 8000);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class JumpPageModal extends Modal {
  private total: number;
  private current: number;
  private go: (index: number) => void;

  constructor(app: App, total: number, current: number, go: (index: number) => void) {
    super(app);
    this.total = total;
    this.current = current;
    this.go = go;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("mb-jump-modal");
    contentEl.createEl("h3", { text: `跳到第几页（共 ${this.total} 页）` });
    const input = contentEl.createEl("input", {
      cls: "mb-jump-input",
      attr: { type: "number", min: "1", max: String(this.total), value: String(this.current + 1) },
    });
    const hint = contentEl.createDiv({ cls: "mb-jump-hint", text: "输入页码后回车；Esc 取消" });
    const submit = () => {
      /*
       * 用 `Math.trunc` 而不是直接 `Number()`（INK-200）。
       *
       * 输入框是 `type="number"`，用户能输 `1.5`。以前直接把 1.5 传给
       * `go(0.5)` → `scrollToPage(0.5)` → `recs[0.5]` 是 undefined →
       * 静默 return。用户看到的是「输了个数字，按回车毫无反应」。
       * `OutlineModal` 早就用了 `Math.trunc`，这里漏了。
       */
      const n = Math.trunc(Number(input.value));
      if (!Number.isFinite(n) || n < 1 || n > this.total) {
        hint.setText(`页码要在 1 到 ${this.total} 之间`);
        return;
      }
      this.go(n - 1);
      this.close();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") this.close();
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
    const btn = contentEl.createEl("button", { cls: "mod-cta", text: "跳过去" });
    btn.onclick = submit;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class PromptModal extends Modal {
  private title: string;
  private value: string;
  private onSubmit: (value: string) => void;

  constructor(app: App, title: string, value: string, onSubmit: (value: string) => void) {
    super(app);
    this.title = title;
    this.value = value;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    const input = contentEl.createEl("input", {
      cls: "mb-prompt-input",
      attr: { type: "text", value: this.value },
    });
    const actions = contentEl.createDiv("mb-new-actions");
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
    const ok = actions.createEl("button", { cls: "mod-cta", text: "确定" });
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      this.onSubmit(v);
      this.close();
    };
    ok.onclick = submit;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/* ------------------------------- 目录弹窗 ------------------------------- */

/**
 * 目录条目的编辑器：名字 + 指向的页。
 *
 * 为什么不用 PromptModal：PromptModal 只有一行文本输入，
 * 而目录需要**两个字段**——名字和页码。页码用数字输入框（1 起给人看，
 * 提交时 -1 变回 0 起下标）。
 *
 * 新增和编辑共用这一个弹窗：`title` 传空串就是「新增」，
 * 传现有名字就是「编辑」（弹窗标题会跟着变）。
 *
 * @param total 本子总页数
 * @param current 当前页（0 起下标），只用来在提示里说「当前在第几页」
 * @param title 初始名字（空 = 新增）
 * @param page 初始页码（0 起下标）
 */
export class OutlineModal extends Modal {
  private total: number;
  private current: number;
  private title: string;
  private page: number;
  private onSubmit: (title: string, page: number) => void;

  constructor(
    app: App,
    total: number,
    current: number,
    title: string,
    page: number,
    onSubmit: (title: string, page: number) => void
  ) {
    super(app);
    this.total = Math.max(1, total);
    this.current = current;
    this.title = title;
    this.page = page;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    const editing = !!this.title;
    contentEl.addClass("mb-new-modal");
    contentEl.createEl("h3", { text: editing ? "编辑目录" : "添加目录" });

    const nameInput = contentEl.createEl("input", {
      cls: "mb-prompt-input",
      attr: { type: "text", value: this.title, placeholder: "例如：第三章 三角函数" },
    });

    const pageInput = contentEl.createEl("input", {
      cls: "mb-prompt-input",
      attr: {
        type: "number",
        min: "1",
        max: String(this.total),
        value: String(Math.max(1, Math.min(this.total, this.page + 1))),
      },
    });
    const hint = contentEl.createDiv({
      cls: "mb-jump-hint",
      text: `页码（1 – ${this.total}，当前在第 ${this.current + 1} 页）`,
    });

    const actions = contentEl.createDiv("mb-new-actions");
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
    const ok = actions.createEl("button", { cls: "mod-cta", text: "确定" });
    const submit = () => {
      const name = nameInput.value.trim();
      if (!name) {
        hint.setText("名字不能为空");
        return;
      }
      const n = Math.trunc(Number(pageInput.value));
      if (!Number.isFinite(n) || n < 1 || n > this.total) {
        hint.setText(`页码要在 1 到 ${this.total} 之间`);
        return;
      }
      this.onSubmit(name, n - 1);
      this.close();
    };
    ok.onclick = submit;
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    pageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    setTimeout(() => {
      nameInput.focus();
      nameInput.select();
    }, 30);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/* ------------------------------- 导入弹窗 ------------------------------- */

/**
 * 选一个 PDF / Word 文件作为导入源。
 *
 * 有两条来路：
 *   1. **库里已有**的文件——同步场景：电脑把文档放进库，平板同步后直接选；
 *   2. **设备上任意位置**的文件——点「从设备选择文件…」触发隐藏的
 *      `<input type="file">`。
 *
 * 第 2 条是后加的（INK-207）。之前的注释说「平板上不能用系统文件选择器」，
 * 那个结论只对**本地路径**成立：Electron / Capacitor 里确实拿不到
 * `file.path`，但 `File` 对象是拿得到的，用 `arrayBuffer()` 读出内容、
 * 再用 `vault.createBinary()` 写进库，就能交给现有的导入链路。
 *
 * 因此这里只负责「把源文件变成库里的 TFile」，`importPdf` / `importWord`
 * 完全不用改——两条来路在 `onPick` 之后就合流了。
 */
export class ImportSourceModal extends Modal {
  private kind: ImportSourceKind;
  private onPick: (file: TFile) => void;
  private listEl!: HTMLElement;
  private statusEl: HTMLElement | null = null;
  private deviceBtn: HTMLButtonElement | null = null;
  private fileInput: HTMLInputElement | null = null;
  /** 正在读 / 写设备文件：防止连点，也防止用户以为没反应又选一次 */
  private busy = false;
  /** 用户在读文件途中关掉弹窗：写完就别再回调（文件留在库里） */
  private closed = false;

  constructor(
    app: App,
    kind: ImportSourceKind,
    onPick: (file: TFile) => void
  ) {
    super(app);
    this.kind = kind;
    this.onPick = onPick;
  }

  onOpen(): void {
    const { contentEl } = this;
    // 复用同一个实例再 open 时，closed/busy 必须回到初始值
    this.closed = false;
    this.busy = false;
    contentEl.addClass("mb-new-modal");
    const title =
      this.kind === "pdf" ? "导入 PDF" : this.kind === "word" ? "导入 Word" : "导入文档";
    contentEl.createEl("h3", { text: title });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text:
        this.kind === "pdf"
          ? "选一个 PDF，逐页渲染成底图，然后就能在上面手写批注。"
          : this.kind === "word"
            ? "选一个 .docx，文字会转成可批注的页面。"
            : "选一个 PDF 或 .docx，新建一本手写本并从它开始。",
    });

    /*
     * 「从设备选择文件」始终显示——即使库里一个可导入文件都没有，
     * 用户也能直接选电脑 / 平板上的文件。这是本功能的重点路径，
     * 不能藏在空状态后面。
     */
    const deviceRow = contentEl.createDiv("mb-import-device");
    this.deviceBtn = deviceRow.createEl("button", {
      cls: "mod-cta mb-device-btn",
      text: "从设备选择文件…",
    });
    const input = contentEl.createEl("input", {
      cls: "mb-file-input",
      attr: { type: "file", accept: this.acceptAttr() },
    });
    /*
     * **视觉隐藏，而不是 `display: none`**（INK-210）。
     *
     * `display: none` 的 input 在标准 Chromium 里 `.click()` 仍然能弹选择器，
     * 但部分 WebView（尤其是安卓上的 Capacitor 内核）会直接忽略——
     * 用户看到的是「点了按钮，什么都没发生」，正是这次报的症状。
     * 用「零尺寸 + 透明 + 绝对定位」：元素仍在渲染树里、可被程序点击，
     * 但用户看不见、也不占位。
     */
    input.style.position = "absolute";
    input.style.width = "0";
    input.style.height = "0";
    input.style.opacity = "0";
    input.style.pointerEvents = "none";
    this.fileInput = input;
    this.deviceBtn.onclick = () => {
      if (this.busy) return;
      input.click();
    };
    input.addEventListener("change", () => void this.onDeviceFile());
    this.statusEl = contentEl.createDiv({ cls: "mb-import-status" });

    const exts = this.kind === "pdf" ? ["pdf"] : this.kind === "word" ? ["docx"] : ["pdf", "docx"];
    const files = this.app.vault.getFiles().filter((f) => exts.includes(f.extension.toLowerCase()));

    if (!files.length) {
      contentEl.createEl("p", {
        cls: "mb-error",
        text: `库里还没有 ${
          this.kind === "pdf" ? "PDF" : this.kind === "word" ? "Word（.docx）" : "PDF / Word（.docx）"
        } 文件。`,
      });
      const b = contentEl.createEl("button", { cls: "mod-cta", text: "关闭" });
      b.onclick = () => this.close();
      return;
    }

    /*
     * 库里的文件列表放在设备按钮下面——平板上手指从上面按下来，
     * 先碰到的是「从设备选」，这符合用户"我手机上有个 PDF"的直觉。
     */
    this.listEl = contentEl.createDiv("mb-import-list");
    for (const f of files) {
      const row = this.listEl.createDiv("mb-import-item");
      const name = row.createSpan({ cls: "mb-import-name", text: f.name });
      name.setAttribute("title", f.path);
      row.createSpan({
        cls: "mb-import-meta",
        text: `${f.extension.toUpperCase()} · ${this.formatSize(f.stat.size)}`,
      });
      row.onclick = () => {
        if (this.busy) return;
        this.onPick(f);
        this.close();
      };
    }
  }

  /** `accept` 只是给桌面系统的过滤器；平板可能忽略，所以选完还会自己校验 */
  private acceptAttr(): string {
    if (this.kind === "pdf") return ".pdf,application/pdf";
    if (this.kind === "word") return ".docx";
    return ".pdf,.docx,application/pdf";
  }

  /**
   * 处理 `<input type="file">` 选到的文件。
   *
   * 顺序：校验扩展名 → 读 ArrayBuffer → 写进库 → 回调。
   * 任何一步失败都**不关窗**，把原因写在弹窗里，用户可以直接重选。
   */
  private async onDeviceFile(): Promise<void> {
    const input = this.fileInput;
    const f = input?.files && input.files[0];
    // 选完立刻清空：不清理的话，连续选同一个文件不会再触发 change
    try {
      if (input) input.value = "";
    } catch (_) {
      /* 某些 WebView 不让改 value，忽略 */
    }
    if (!f || this.busy) return;

    /*
     * 自己校验扩展名（平板兼容）：`accept` 在不同平台的 `<input type=file>`
     * 上表现不一，Obsidian 的 WebView 里可能直接忽略，不能只靠它。
     */
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    const allowed = this.kind === "pdf" ? ["pdf"] : this.kind === "word" ? ["docx"] : ["pdf", "docx"];
    if (!allowed.includes(ext)) {
      const want = this.kind === "pdf" ? "PDF" : this.kind === "word" ? "Word（.docx）" : "PDF 或 Word（.docx）";
      this.setStatus(`「${f.name}」不是 ${want} 文件`);
      new Notice(`只能导入 ${want} 文件：${f.name}`, 5000);
      return;
    }

    this.busy = true;
    if (this.deviceBtn) this.deviceBtn.disabled = true;
    if (f.size > BIG_FILE_HINT_BYTES) {
      /*
       * 几十 MB 的文件要整个读进内存再写盘，平板上会明显卡一下。
       * 先给一句人话，避免用户以为点了没反应又去点第二次。
       */
      new Notice(`文件较大（${this.formatSize(f.size)}），读取和写入需要一点时间，请稍候…`, 6000);
    }
    this.setStatus(`正在读取「${f.name}」…（${this.formatSize(f.size)}）`);

    try {
      const buf = await readFileAsArrayBuffer(f);
      this.setStatus("正在写入库内…");
      const file = await this.writeDeviceFile(f.name, buf);
      if (this.closed) {
        /*
         * 用户关窗已经关掉了：源文件仍然留在 `.inkbook-assets` 里。
         * 不回调是因为弹窗已关闭、调用方可能已经去做别的事；
         * 留在库里也不算浪费——至少没把用户刚选的文件弄丢。
         */
        return;
      }
      this.onPick(file);
      this.close();
    } catch (e: any) {
      const msg = e && e.message ? e.message : String(e);
      this.setStatus("读入失败：" + msg);
      new Notice("读入文件失败：" + msg, 8000);
      console.error("[inkbook] 读入设备文件失败", e);
    } finally {
      this.busy = false;
      if (!this.closed && this.deviceBtn) this.deviceBtn.disabled = false;
    }
  }

  /**
   * 把设备文件的字节写进库，返回可交给导入链路的 TFile。
   *
   * 路径用 `.inkbook-assets/imported-<时间戳>-<原名>`：
   *   · 放在隐藏的资源目录，不打扰用户的笔记列表（导入 PDF 的底图也在这里）；
   *   · 时间戳保证同一份文件导两次也不会互相覆盖；
   *   · 万一同一毫秒内出现同名，再加序号兜底。
   *
   * **写完不删**（清理策略）：PDF 页面是按路径懒渲染的
   * （`page.background.pdf.path`），删了源文件，翻页时底图就没了；
   * `source.path` 也可能被导出 / 排查问题用到。Word 导入后虽然不再读它，
   * 但和 PDF 走同一条路、行为一致更好解释，磁盘代价只有导入的那一份。
   */
  private async writeDeviceFile(name: string, buf: ArrayBuffer): Promise<TFile> {
    const adapter = this.app.vault.adapter;
    const dir = ".inkbook-assets";
    if (!(await adapter.exists(dir))) {
      try {
        await this.app.vault.createFolder(dir);
      } catch (_) {
        // 并发创建 / 某些适配器不暴露 createFolder：再确认一次，确实没有才 mkdir
        if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
      }
    }
    const safe = safeImportFileName(name);
    const stamp = Date.now();
    let path = `${dir}/imported-${stamp}-${safe}`;
    let n = 1;
    while (await adapter.exists(path)) {
      path = `${dir}/imported-${stamp}-${n++}-${safe}`;
    }
    try {
      return await this.app.vault.createBinary(path, buf);
    } catch (e) {
      /*
       * 兜底：`.inkbook-assets` 是隐藏目录，个别 Obsidian 版本的
       * `vault.createBinary` 对隐藏路径不建索引 / 直接拒绝；老版本也可能
       * 没有这个方法。适配器直写在两条链路上都是可用的（导入链路本来就
       * 只要 `path`），所以补一个「手写 TFile」的最小对象。
       */
      console.warn("[inkbook] vault.createBinary 失败，改用适配器写入", e);
      await adapter.writeBinary(path, buf);
      const fileName = path.slice(path.lastIndexOf("/") + 1);
      const dot = fileName.lastIndexOf(".");
      return {
        path,
        name: fileName,
        basename: dot > 0 ? fileName.slice(0, dot) : fileName,
        extension: dot > 0 ? fileName.slice(dot + 1) : "",
        stat: { size: buf.byteLength },
      } as TFile;
    }
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.setText(text);
  }

  private formatSize(n: number): string {
    if (!Number.isFinite(n) || n < 0) return "未知大小";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  /*
   * 与其他 Modal 保持一致（2026-11-07 补）：不 empty 的话，复用同一个实例
   * 再 open 会在旧内容后面追加第二套 UI，`listEl` 还指向旧节点。
   * 现在每处都是 new 一个实例，所以没暴露；补上这行才一致。
   */
  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }
}

/**
 * 选导入多少页。PDF 页数可能很多，让用户先定范围。
 */
export class ImportRangeModal extends Modal {
  private total: number;
  private kind: "pdf" | "word";
  private from = 1;
  private to: number;
  private onDone: (from: number, to: number) => void;
  private infoEl!: HTMLElement;
  /** 按钮/文案里的动作名：导入用默认「导入」，导出页范围传「导出」 */
  private action: string;

  constructor(
    app: App,
    kind: "pdf" | "word",
    total: number,
    onDone: (from: number, to: number) => void,
    action = "导入"
  ) {
    super(app);
    this.kind = kind;
    this.total = total;
    this.to = total;
    this.onDone = onDone;
    this.action = action;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("mb-new-modal");
    contentEl.createEl("h3", { text: "选择页码范围" });
    this.infoEl = contentEl.createEl("p", { cls: "setting-item-description" });
    this.updateInfo();

    new Setting(contentEl)
      .setName("起始页")
      .addText((t) =>
        t.setValue(String(this.from)).onChange((v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n)) {
            this.from = Math.max(1, Math.min(this.total, n));
            this.updateInfo();
          }
        })
      );

    new Setting(contentEl)
      .setName("结束页")
      .addText((t) =>
        t.setValue(String(this.to)).onChange((v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n)) {
            this.to = Math.max(1, Math.min(this.total, n));
            this.updateInfo();
          }
        })
      );

    const all = contentEl.createEl("button", { cls: "mb-import-all", text: `全部${this.action}` });
    all.onclick = () => {
      this.from = 1;
      this.to = this.total;
      this.finish();
    };

    const actions = contentEl.createDiv("mb-new-actions");
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
    const ok = actions.createEl("button", { cls: "mod-cta", text: this.action });
    ok.onclick = () => this.finish();
  }

  private updateInfo(): void {
    const count = Math.max(0, this.to - this.from + 1);
    this.infoEl.setText(
      `共 ${this.total} 页，当前选择 ${this.from}–${this.to}（${count} 页）`
    );
  }

  private finish(): void {
    if (this.to < this.from) {
      new Notice("结束页不能小于起始页", 2500);
      return;
    }
    /*
     * **先 onDone 再 close**（2026-11-07 修）。
     *
     * 反过来的话，调用方若靠覆盖 `onClose` 判定「用户取消」，
     * `close()` 会同步触发 onClose → 先被判成取消，随后的 onDone 被吞，
     * 用户点「确认」毫无反应。导入范围弹窗正好踩了这个坑。
     *
     * 先回调再关窗也符合直觉：调用方拿到结果时弹窗还开着，
     * 想接着弹下一个框（比如导入进度）不会闪一下空白。
     */
    this.onDone(this.from, this.to);
    this.close();
  }

  /** 与其他 Modal 保持一致：关闭时清空，避免复用实例时残留两套 UI */
  onClose(): void {
    this.contentEl.empty();
  }
}
