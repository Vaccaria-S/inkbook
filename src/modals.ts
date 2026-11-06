import { Modal, Notice, Setting, type App, type TFile } from "obsidian";
import { createBook, PAPERS, TEMPLATES, type PaperId, type TemplateId } from "./types";
import { paintPaperPreview } from "./paper";

function safeName(s: string): string {
  return String(s).replace(/[\\/:*?"<>|#^[\]]/g, "_").trim() || "未命名笔记";
}

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
      this.close();
      this.onDone(file);
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
      const n = Number(input.value);
      if (!n || n < 1 || n > this.total) {
        hint.setText(`页码要在 1 到 ${this.total} 之间`);
        return;
      }
      this.close();
      this.go(n - 1);
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
      this.close();
      this.onSubmit(v);
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
      this.close();
      this.onSubmit(name, n - 1);
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
 * 选一个库里的 PDF / Word 文件作为导入源。
 * 平板上不能用系统文件选择器（拿不到本地路径），所以只能从库里选——
 * 这也符合同步场景：电脑把文档放进库，平板同步后就能导入。
 */
export class ImportSourceModal extends Modal {
  private kind: "pdf" | "word";
  private onPick: (file: TFile) => void;
  private listEl!: HTMLElement;

  constructor(
    app: App,
    kind: "pdf" | "word",
    onPick: (file: TFile) => void
  ) {
    super(app);
    this.kind = kind;
    this.onPick = onPick;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("mb-new-modal");
    contentEl.createEl("h3", {
      text: this.kind === "pdf" ? "导入 PDF" : "导入 Word",
    });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text:
        this.kind === "pdf"
          ? "选一个库里的 PDF，逐页渲染成底图，然后就能在上面手写批注。"
          : "选一个库里的 .docx，文字会转成可批注的页面。",
    });

    const exts = this.kind === "pdf" ? ["pdf"] : ["docx"];
    const files = this.app.vault.getFiles().filter((f) => exts.includes(f.extension.toLowerCase()));

    if (!files.length) {
      contentEl.createEl("p", {
        cls: "mb-error",
        text: `库里还没有 ${this.kind === "pdf" ? "PDF" : "Word（.docx）"} 文件。`,
      });
      const b = contentEl.createEl("button", { cls: "mod-cta", text: "关闭" });
      b.onclick = () => this.close();
      return;
    }

    this.listEl = contentEl.createDiv("mb-import-list");
    for (const f of files) {
      const row = this.listEl.createDiv("mb-import-item");
      const name = row.createSpan({ cls: "mb-import-name", text: f.name });
      name.setAttribute("title", f.path);
      const meta = row.createSpan({
        cls: "mb-import-meta",
        text: `${f.extension.toUpperCase()} · ${this.formatSize(f.stat.size)}`,
      });
      row.onclick = () => {
        this.close();
        this.onPick(f);
      };
    }
  }

  private formatSize(n: number): string {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
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
    this.close();
    this.onDone(this.from, this.to);
  }
}
