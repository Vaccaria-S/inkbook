/**
 * 弹窗测试（INK-199）。
 *
 * NewBookModal 的创建路径在 view-harness.ts 里已经盖过；这里补另外 5 个：
 *   JumpPageModal / PromptModal / OutlineModal / ImportSourceModal / ImportRangeModal
 *
 * **重点：ImportRangeModal 的「确认 vs 取消」。**
 *
 * 真实 Obsidian 的 `Modal.close()` 会**同步**调用 `onClose()`。调用方
 * （src/view.ts 的 runImport）用「onClose 时还没确认过 → 当取消」判取消。
 * 如果弹窗先 close 再 onDone，控制权在 close 里就返回 null，用户点确认
 * 会被当成取消吞掉——这是真实踩过的坑（见 src/modals.ts finish() 注释）。
 *
 * 桩用 test/obsidian-stub.mjs（build-tests.mjs 的 alias 指向它），它的
 * `close()` 与真实行为一致：先同步调 onClose，再移除节点。dist-harness 的
 * 内联桩不调 onClose，测不出这类时序问题——所以这里必须用这一套。
 */
import {
  ImportRangeModal,
  ImportSourceModal,
  JumpPageModal,
  OutlineModal,
  PromptModal,
  safeImportFileName,
  NewBookModal,
} from "../src/modals";
// 走 build-tests.mjs 的 obsidian alias → test/obsidian-stub.mjs；
// 与 src/modals.ts 里 import 的是同一个模块实例，改 prototype 能影响被测代码。
import { Notice, Setting } from "obsidian";

const lines: string[] = [];
const out = document.getElementById("out")!;
function log(s: string): void {
  lines.push(s);
  out.textContent = lines.join("\n");
}
function pass(ok: boolean, msg: string): void {
  log((ok ? "PASS " : "FAIL ") + msg);
}
window.addEventListener("error", (e) => log("ERROR " + e.message + " @ " + e.filename + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e: any) =>
  log("REJECT " + (e.reason?.stack || e.reason))
);

/** 这些弹窗只用到 app.vault.getFiles() */
let vaultFiles: any[] = [];
const app: any = { vault: { getFiles: () => vaultFiles } };

function openModal(m: any): HTMLElement {
  m.open();
  return m.contentEl as HTMLElement;
}

function button(el: HTMLElement, text: string): HTMLElement | undefined {
  return [...el.querySelectorAll("button")].find(
    (b) => (b.textContent || "").trim() === text
  ) as HTMLElement | undefined;
}

function clickButton(el: HTMLElement, text: string): boolean {
  const b = button(el, text);
  if (!b) return false;
  b.click();
  return true;
}

function pressEnter(el: HTMLElement): void {
  el.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
  );
}

function mkFile(path: string, size: number): any {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return {
    path,
    name,
    basename: dot >= 0 ? name.slice(0, dot) : name,
    extension: dot >= 0 ? name.slice(dot + 1) : "",
    stat: { size },
  };
}

/**
 * 捕获 ImportRangeModal 里 Setting.addText 建出来的输入组件。
 *
 * obsidian-stub 的 Setting 不往 DOM 里塞 input（只建了一个游离的 inputEl），
 * 拿不到节点；但组件对象（value + onChange 回调）是真的，测试直接调它的
 * onChange 等价于用户键入。
 */
function captureSettingTexts(openFn: () => void): any[] {
  const proto = Setting.prototype as any;
  const orig = proto.addText;
  const comps: any[] = [];
  proto.addText = function (cb: any): any {
    const ret = orig.call(this, cb);
    comps.push(this.text);
    return ret;
  };
  try {
    openFn();
  } finally {
    proto.addText = orig;
  }
  return comps;
}

/** 捕捉 Notice 的文案（stub 的 Notice 只 console.log，不暴露实例） */
function captureNotices(): string[] {
  const seen: string[] = [];
  Object.defineProperty(Notice.prototype as any, "msg", {
    configurable: true,
    get(this: any) {
      return this.__msg;
    },
    set(this: any, v: any) {
      this.__msg = String(v);
      seen.push(String(v));
    },
  });
  return seen;
}
function releaseNotices(): void {
  delete (Notice.prototype as any).msg;
}

async function main(): Promise<void> {
  /* -------------------------- INK-213 新建弹窗导入 -------------------------- */
  {
    const events: string[] = [];
    const plugin: any = {
      settings: { defaultTemplate: "blank", defaultPaper: "white" },
      saveSettings: async () => {},
    };
    const originalWorkspace = app.workspace;
    app.workspace = { getActiveFile: () => null };
    try {
      const modal = new NewBookModal(app, plugin, () => events.push("create"), () => events.push("import"));
      const originalClose = modal.onClose.bind(modal);
      modal.onClose = () => {
        events.push("close");
        originalClose();
      };
      const el = openModal(modal);
      pass(!!button(el, "导入外部文档"), "INK-213 新建手写本弹窗显示导入外部文档入口");
      pass(!!button(el, "创建并打开"), "INK-213 原有创建并打开入口仍保留");
      clickButton(el, "导入外部文档");
      pass(events.join(",") === "close,import", "INK-213 先关新建弹窗再启动导入，不创建空白本");
      pass(!el.isConnected, "INK-213 进入导入后新建弹窗已关闭");

      const cancelled: string[] = [];
      const cancelModal = new NewBookModal(app, plugin, () => cancelled.push("create"), () => cancelled.push("import"));
      const cancelEl = openModal(cancelModal);
      clickButton(cancelEl, "取消");
      pass(cancelled.length === 0 && !cancelEl.isConnected, "INK-213 取消不触发创建或导入");
    } finally {
      app.workspace = originalWorkspace;
    }
  }

  /* ------------------------------ JumpPageModal ------------------------------ */
  {
    const opened: number[] = [];
    const m = new JumpPageModal(app, 10, 2, (i) => opened.push(i));
    const el = openModal(m);
    const input = el.querySelector(".mb-jump-input") as HTMLInputElement;

    pass(
      (el.querySelector("h3")?.textContent || "").includes("共 10 页"),
      "跳页：标题显示总页数"
    );
    pass(
      !!input && input.value === "3",
      "跳页：输入框预填当前页（0 起 2 → 显示 3）"
    );
    pass(
      !!input &&
        input.getAttribute("type") === "number" &&
        input.getAttribute("min") === "1" &&
        input.getAttribute("max") === "10",
      "跳页：输入框限制为 1–10 的数字"
    );

    input.value = "7";
    clickButton(el, "跳过去");
    pass(
      opened.length === 1 && opened[0] === 6,
      "跳页：输入 7 跳转到下标 6（1 起转 0 起）"
    );
    pass(!el.isConnected, "跳页：跳转后弹窗关闭");
  }

  {
    const opened: number[] = [];
    const m = new JumpPageModal(app, 10, 0, (i) => opened.push(i));
    const el = openModal(m);
    const input = el.querySelector(".mb-jump-input") as HTMLInputElement;
    const hint = el.querySelector(".mb-jump-hint") as HTMLElement;

    // 0 / 负数 / 超过总页数 / 空 / 字母（number 输入会把字母存成空串）
    const cases: Array<[string, string]> = [
      ["0", "0"],
      ["-3", "负数"],
      ["11", "超过总页数"],
      ["", "空"],
      ["abc", "字母"],
    ];
    let bad = "";
    for (const [v, label] of cases) {
      input.value = v;
      clickButton(el, "跳过去");
      const rejected =
        el.isConnected &&
        opened.length === 0 &&
        hint.textContent === "页码要在 1 到 10 之间";
      if (!rejected) bad += ` ${label}`;
    }
    pass(
      bad === "",
      "跳页：0 / 负数 / 超过总页数 / 空 / 字母都被拒绝并提示（" +
        cases.length +
        " 种）"
    );
    pass(el.isConnected && opened.length === 0, "跳页：非法输入不关窗、不跳转");

    input.value = "5";
    clickButton(el, "跳过去");
    pass(
      opened.length === 1 && opened[0] === 4 && !el.isConnected,
      "跳页：非法输入后改成合法页仍能正常跳转"
    );
  }

  /*
   * INK-200：`type="number"` 允许输小数。
   *
   * 老实现直接 `Number(input.value)` → 1.5 传给 `go(0.5)` →
   * `scrollToPage(0.5)` → `recs[0.5]` 是 undefined → 静默 return。
   * 用户看到的是「输了个数字，按回车毫无反应」。
   * `OutlineModal` 早就用了 `Math.trunc`，跳页这里漏了。
   */
  {
    const opened: number[] = [];
    const m = new JumpPageModal(app, 10, 0, (i) => opened.push(i));
    const el = openModal(m);
    const input = el.querySelector(".mb-jump-input") as HTMLInputElement;
    input.value = "3.7";
    clickButton(el, "跳过去");
    pass(
      opened.length === 1 && opened[0] === 2 && Number.isInteger(opened[0]),
      "INK-200 小数页码 3.7 被截断成 3（下标 " + opened[0] + "，不再是 undefined 静默失败）"
    );
    pass(!el.isConnected, "INK-200 小数页码也能正常跳转并关窗");
  }

  {
    const opened: number[] = [];
    const m = new JumpPageModal(app, 10, 0, (i) => opened.push(i));
    const el = openModal(m);
    const input = el.querySelector(".mb-jump-input") as HTMLInputElement;
    input.value = "10";
    pressEnter(input);
    pass(
      opened.length === 1 && opened[0] === 9,
      "跳页：回车提交同样生效（第 10 页 → 下标 9）"
    );
  }

  {
    const opened: number[] = [];
    const m = new JumpPageModal(app, 10, 0, (i) => opened.push(i));
    const el = openModal(m);
    const input = el.querySelector(".mb-jump-input") as HTMLInputElement;
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    pass(!el.isConnected && opened.length === 0, "跳页：Esc 关闭弹窗且不跳转");
  }

  /* ------------------------------- PromptModal ------------------------------- */
  {
    const got: string[] = [];
    const m = new PromptModal(app, "重命名目录", "旧名字", (v) => got.push(v));
    const el = openModal(m);
    const input = el.querySelector(".mb-prompt-input") as HTMLInputElement;

    pass(el.querySelector("h3")?.textContent === "重命名目录", "输入框：标题正确");
    pass(input.value === "旧名字", "输入框：预填原值");

    input.value = "  新名字  ";
    clickButton(el, "确定");
    pass(
      got.length === 1 && got[0] === "新名字",
      "输入框：确认回调拿到 trim 后的值（" + JSON.stringify(got[0]) + "）"
    );
    pass(!el.isConnected, "输入框：确认后弹窗关闭");
  }

  {
    const got: string[] = [];
    const m = new PromptModal(app, "重命名目录", "旧名字", (v) => got.push(v));
    const el = openModal(m);
    const input = el.querySelector(".mb-prompt-input") as HTMLInputElement;

    input.value = "   ";
    clickButton(el, "确定");
    pass(
      got.length === 0 && el.isConnected,
      "输入框：空值（纯空格）不提交、弹窗不关"
    );

    clickButton(el, "取消");
    pass(
      got.length === 0 && !el.isConnected,
      "输入框：取消不触发回调（调用方按 null 处理）"
    );
  }

  {
    const got: string[] = [];
    const m = new PromptModal(app, "重命名图层", "层", (v) => got.push(v));
    const el = openModal(m);
    const input = el.querySelector(".mb-prompt-input") as HTMLInputElement;
    input.value = "新层";
    pressEnter(input);
    pass(got.length === 1 && got[0] === "新层", "输入框：回车确认");
  }

  /* 目录改名走 PromptModal：弹窗里没有页码字段，改名不可能动页码。 */
  {
    const m = new PromptModal(app, "重命名目录", "第三章", () => {});
    const el = openModal(m);
    const inputs = el.querySelectorAll("input");
    pass(
      inputs.length === 1 &&
        (inputs[0] as HTMLInputElement).type === "text" &&
        !el.querySelector('input[type="number"]'),
      "输入框：重命名弹窗只有名字输入，没有页码字段（改名不会动页码）"
    );
    m.close();
  }

  /* ------------------------------- OutlineModal ------------------------------ */
  {
    const got: Array<[string, number]> = [];
    const m = new OutlineModal(app, 10, 4, "", 4, (t, p) => got.push([t, p]));
    const el = openModal(m);
    const inputs = el.querySelectorAll("input");
    const name = inputs[0] as HTMLInputElement;
    const page = inputs[1] as HTMLInputElement;
    const hint = el.querySelector(".mb-jump-hint") as HTMLElement;

    pass(el.querySelector("h3")?.textContent === "添加目录", "目录：新增时标题为「添加目录」");
    pass(
      name.value === "" && (name.getAttribute("placeholder") || "").includes("第三章"),
      "目录：新增时名字为空并有占位提示"
    );
    pass(page.value === "5", "目录：页码显示为 0 起当前页 + 1（4 → 5）");
    pass(
      (hint.textContent || "").includes("1 – 10") &&
        (hint.textContent || "").includes("当前在第 5 页"),
      "目录：提示显示总页数与当前页（1 起）"
    );

    name.value = "  第三章 三角函数 ";
    page.value = "3";
    clickButton(el, "确定");
    pass(
      got.length === 1 && got[0][0] === "第三章 三角函数" && got[0][1] === 2,
      "目录：提交名字 trim 且页码 1 起转 0 起（3 → 2）"
    );
    pass(!el.isConnected, "目录：提交后弹窗关闭");
  }

  {
    const got: Array<[string, number]> = [];
    const m = new OutlineModal(app, 10, 0, "", 0, (t, p) => got.push([t, p]));
    const el = openModal(m);
    const inputs = el.querySelectorAll("input");
    const name = inputs[0] as HTMLInputElement;
    const page = inputs[1] as HTMLInputElement;
    const hint = el.querySelector(".mb-jump-hint") as HTMLElement;

    name.value = "   ";
    page.value = "2";
    clickButton(el, "确定");
    pass(
      got.length === 0 && el.isConnected && hint.textContent === "名字不能为空",
      "目录：名字为空时拒绝提交并提示"
    );

    name.value = "第一章";
    let bad = "";
    for (const v of ["0", "11", "", "abc"]) {
      page.value = v;
      clickButton(el, "确定");
      if (
        got.length !== 0 ||
        !el.isConnected ||
        hint.textContent !== "页码要在 1 到 10 之间"
      ) {
        bad += " " + JSON.stringify(v);
      }
    }
    pass(
      bad === "",
      "目录：页码 0 / 超过总页数 / 空 / 字母都被拒绝并提示" + bad
    );

    page.value = "10";
    clickButton(el, "确定");
    pass(
      got.length === 1 && got[0][1] === 9 && !el.isConnected,
      "目录：改成合法页码后提交成功（10 → 9）"
    );
  }

  {
    const got: Array<[string, number]> = [];
    const m = new OutlineModal(app, 10, 0, "", 0, (t, p) => got.push([t, p]));
    const el = openModal(m);
    const inputs = el.querySelectorAll("input");
    (inputs[0] as HTMLInputElement).value = "小数页";
    (inputs[1] as HTMLInputElement).value = "3.9";
    clickButton(el, "确定");
    pass(
      got.length === 1 && got[0][1] === 2,
      "目录：页码小数向下取整（3.9 → 3 → 下标 2）"
    );
  }

  {
    const got: Array<[string, number]> = [];
    const m = new OutlineModal(app, 10, 4, "旧名字", 4, (t, p) => got.push([t, p]));
    const el = openModal(m);
    const inputs = el.querySelectorAll("input");
    const name = inputs[0] as HTMLInputElement;
    const page = inputs[1] as HTMLInputElement;

    pass(el.querySelector("h3")?.textContent === "编辑目录", "目录：编辑时标题为「编辑目录」");
    pass(
      name.value === "旧名字" && page.value === "5",
      "目录：编辑时名字与页码（+1）都预填"
    );

    page.value = "7";
    clickButton(el, "确定");
    pass(
      got.length === 1 && got[0][0] === "旧名字" && got[0][1] === 6,
      "目录：编辑提交同样 1 起转 0 起（7 → 6）"
    );
  }

  {
    const m1 = new OutlineModal(app, 10, 0, "", 99, () => {});
    const e1 = openModal(m1);
    const p1 = e1.querySelectorAll("input")[1] as HTMLInputElement;
    pass(p1.value === "10", "目录：初始页码超出总页数时显示最后一页（99 → 10）");
    m1.close();

    const m2 = new OutlineModal(app, 10, 0, "", -5, () => {});
    const e2 = openModal(m2);
    const p2 = e2.querySelectorAll("input")[1] as HTMLInputElement;
    pass(p2.value === "1", "目录：初始页码为负时显示第 1 页");
    m2.close();
  }

  /* ---------------------------- ImportSourceModal ---------------------------- */
  {
    const small = mkFile("资料/小.pdf", 500);
    const mid = mkFile("资料/中.pdf", 2048);
    const big = mkFile("资料/大.pdf", 2621440);
    const word = mkFile("资料/说明.docx", 1234);
    const md = mkFile("资料/笔记.md", 10);
    vaultFiles = [small, mid, big, word, md];

    const picked: any[] = [];
    const m = new ImportSourceModal(app, "pdf", (f) => picked.push(f));
    const el = openModal(m);

    pass(el.querySelector("h3")?.textContent === "导入 PDF", "选导入源：PDF 标题");
    const rows = el.querySelectorAll(".mb-import-item");
    pass(rows.length === 3, "选导入源：只列出 PDF（3 个，忽略 docx / md）");

    const names = [...el.querySelectorAll(".mb-import-name")].map((x) => x.textContent);
    pass(
      names.join(",") === "小.pdf,中.pdf,大.pdf",
      "选导入源：文件名按 vault 顺序显示（" + names.join(",") + "）"
    );

    const metas = [...el.querySelectorAll(".mb-import-meta")].map((x) => x.textContent);
    pass(
      metas.join("|") === "PDF · 500 B|PDF · 2 KB|PDF · 2.5 MB",
      "选导入源：大小格式化为 B / KB / MB（" + metas.join("|") + "）"
    );

    const firstName = el.querySelector(".mb-import-name") as HTMLElement;
    pass(
      firstName.getAttribute("title") === "资料/小.pdf",
      "选导入源：文件名 title 显示完整路径"
    );

    (rows[1] as HTMLElement).click();
    pass(
      picked.length === 1 && picked[0] === mid,
      "选导入源：点一行回调拿到对应文件"
    );
    pass(!el.isConnected, "选导入源：选中后弹窗关闭");
  }

  {
    vaultFiles = [mkFile("a.docx", 1234), mkFile("b.pdf", 10)];
    const picked: any[] = [];
    const m = new ImportSourceModal(app, "word", (f) => picked.push(f));
    const el = openModal(m);

    pass(el.querySelector("h3")?.textContent === "导入 Word", "选导入源：Word 标题");
    const rows = el.querySelectorAll(".mb-import-item");
    pass(
      rows.length === 1 &&
        el.querySelector(".mb-import-meta")?.textContent === "DOCX · 1 KB",
      "选导入源：Word 只列 .docx 且大小正确"
    );

    (rows[0] as HTMLElement).click();
    pass(
      picked.length === 1 && picked[0].path === "a.docx",
      "选导入源：Word 选中回调"
    );
  }

  {
    vaultFiles = [mkFile("只有 md.md", 10)];
    const picked: any[] = [];
    const m = new ImportSourceModal(app, "pdf", (f) => picked.push(f));
    const el = openModal(m);

    pass(
      el.querySelector(".mb-error")?.textContent === "库里还没有 PDF 文件。",
      "选导入源：没有 PDF 时给出空状态文案"
    );
    pass(
      el.querySelectorAll(".mb-import-item").length === 0,
      "选导入源：空状态不渲染列表"
    );
    clickButton(el, "关闭");
    pass(!el.isConnected && picked.length === 0, "选导入源：空状态「关闭」按钮能关窗");

    vaultFiles = [];
    const m2 = new ImportSourceModal(app, "word", (f) => picked.push(f));
    const el2 = openModal(m2);
    pass(
      el2.querySelector(".mb-error")?.textContent === "库里还没有 Word（.docx） 文件。",
      "选导入源：没有 Word 时给出空状态文案"
    );
    m2.close();
  }

  /* ----------------------------- ImportRangeModal ----------------------------- */
  /*
   * 时序锁：确认时事件顺序必须是 onDone → close → onClose。
   * 旧实现先 close 再 onDone，调用方在 onClose 里就把这次操作判成取消，
   * 点确认毫无反应。这里把顺序本身作为断言。
   */
  {
    const events: string[] = [];
    const m = new ImportRangeModal(app, "pdf", 300, (from, to) =>
      events.push(`done:${from}-${to}`)
    );
    const origClose = m.onClose.bind(m);
    m.onClose = () => {
      events.push("close");
      origClose();
    };
    const el = openModal(m);

    pass(el.querySelector("h3")?.textContent === "选择页码范围", "页码范围：标题");
    const info = el.querySelector("p.setting-item-description") as HTMLElement;
    pass(
      info.textContent === "共 300 页，当前选择 1–300（300 页）",
      "页码范围：默认全选并显示页数（" + info.textContent + "）"
    );
    pass(
      !!button(el, "导入") && button(el, "导入")!.classList.contains("mod-cta"),
      "页码范围：确认按钮存在且是主按钮"
    );

    clickButton(el, "导入");
    pass(
      events.join(",") === "done:1-300,close",
      "页码范围：确认先回调 onDone 再 close（" + events.join(",") + "）"
    );
    pass(!el.isConnected, "页码范围：确认后弹窗关闭");
  }

  {
    const events: string[] = [];
    const m = new ImportRangeModal(app, "pdf", 300, (from, to) =>
      events.push(`done:${from}-${to}`)
    );
    const origClose = m.onClose.bind(m);
    m.onClose = () => {
      events.push("close");
      origClose();
    };
    const el = openModal(m);

    clickButton(el, "取消");
    pass(
      events.join(",") === "close" && !el.isConnected,
      "页码范围：取消只关窗、绝不调用 onDone（" + events.join(",") + "）"
    );
  }

  /*
   * 与 src/view.ts runImport 完全相同的接线：onDone 里置 confirmed，
   * 覆盖 onClose 时「没确认过才当取消」。
   */
  {
    const pickRange = (
      total: number,
      act: (el: HTMLElement) => void
    ): Promise<any> => {
      let confirmed = false;
      let settled = false;
      let resolveP!: (v: any) => void;
      const p = new Promise<any>((r) => (resolveP = r));
      const done = (v: any) => {
        if (!settled) {
          settled = true;
          resolveP(v);
        }
      };
      const m = new ImportRangeModal(app, "pdf", total, (from, to) => {
        confirmed = true;
        done({ from, to });
      });
      const origClose = m.onClose.bind(m);
      m.onClose = () => {
        origClose();
        if (!confirmed) done(null); // 没确认就关窗 = 用户取消
      };
      const el = openModal(m);
      act(el);
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 800));
      return Promise.race([p, timeout]);
    };

    const picked = await pickRange(300, (el) => {
      clickButton(el, "导入");
    });
    pass(
      picked && picked.from === 1 && picked.to === 300,
      "页码范围：view.ts 接线方式下确认能拿到范围（" + JSON.stringify(picked) + "）"
    );

    const cancelled = await pickRange(300, (el) => {
      clickButton(el, "取消");
    });
    pass(
      cancelled === null,
      "页码范围：view.ts 接线方式下取消解析为 null（" + JSON.stringify(cancelled) + "）"
    );
  }

  /*
   * 起止输入：夹取到 1–total、非数字忽略、信息行同步。
   */
  {
    const got: Array<[number, number]> = [];
    const m = new ImportRangeModal(app, "pdf", 300, (f, t) => got.push([f, t]));
    const comps = captureSettingTexts(() => m.open());
    const el = m.contentEl as HTMLElement;
    const info = el.querySelector("p.setting-item-description") as HTMLElement;

    pass(
      comps.length === 2 && comps[0].value === "1" && comps[1].value === "300",
      "页码范围：起止输入框预填 1 / 总页数"
    );

    comps[0].fn("7");
    comps[1].fn("9");
    pass(
      info.textContent === "共 300 页，当前选择 7–9（3 页）",
      "页码范围：改动后信息行同步（" + info.textContent + "）"
    );

    comps[0].fn("0");
    pass(
      (info.textContent || "").includes("1–9（9 页）"),
      "页码范围：起始页小于 1 时夹到 1（" + info.textContent + "）"
    );

    comps[0].fn("999");
    pass(
      (info.textContent || "").includes("300–9（0 页）"),
      "页码范围：起始页超过总页数时夹到最后，并如实显示 0 页"
    );

    comps[0].fn("abc");
    pass(
      (info.textContent || "").includes("300–9"),
      "页码范围：非数字输入被忽略（不改变范围）"
    );

    clickButton(el, "全部导入");
    pass(
      got.length === 1 && got[0][0] === 1 && got[0][1] === 300,
      "页码范围：「全部导入」无视当前输入，回调 1–300"
    );
    pass(!el.isConnected, "页码范围：「全部导入」后关窗");
  }

  /*
   * 起止颠倒：不回调、不关窗、给 Notice；改回合法后仍可确认。
   */
  {
    const got: Array<[number, number]> = [];
    const notices = captureNotices();
    try {
      const m = new ImportRangeModal(app, "pdf", 300, (f, t) => got.push([f, t]));
      const comps = captureSettingTexts(() => m.open());
      const el = m.contentEl as HTMLElement;
      const info = el.querySelector("p.setting-item-description") as HTMLElement;

      comps[0].fn("50");
      comps[1].fn("10");
      pass(
        info.textContent === "共 300 页，当前选择 50–10（0 页）",
        "页码范围：起止颠倒时信息行显示 0 页"
      );

      clickButton(el, "导入");
      pass(
        got.length === 0 && el.isConnected,
        "页码范围：起止颠倒时确认不回调、弹窗不关（不会静默导入空范围）"
      );
      pass(
        notices.includes("结束页不能小于起始页"),
        "页码范围：起止颠倒时给出「结束页不能小于起始页」提示（" +
          notices.join("|") +
          "）"
      );

      comps[1].fn("60");
      clickButton(el, "导入");
      pass(
        got.length === 1 && got[0][0] === 50 && got[0][1] === 60,
        "页码范围：把结束页改大后可正常确认（50–60）"
      );
    } finally {
      releaseNotices();
    }
  }

  /*
   * 导出复用同一个弹窗（action 参数）：按钮文案 + 默认范围。
   */
  {
    const got: Array<[number, number]> = [];
    const m = new ImportRangeModal(app, "pdf", 50, (f, t) => got.push([f, t]), "导出");
    const el = openModal(m);

    pass(
      !!button(el, "导出") && el.querySelector(".mb-import-all")?.textContent === "全部导出",
      "页码范围：action=导出 时按钮文案跟着变"
    );

    clickButton(el, "导出");
    pass(
      got.length === 1 && got[0][0] === 1 && got[0][1] === 50,
      "页码范围：导出确认回调默认全范围"
    );
  }

  /* ---------------------- INK-207 从设备选择文件 ---------------------- */
  /*
   * 平板上 `<input type="file">` 拿不到本地路径，但能拿到 File 对象。
   * 这里验证「File → ArrayBuffer → vault.createBinary → onPick」这条新增的
   * 来路，以及文件名清洗 / 撞名 / 扩展名自校验 / 大文件提示。
   */
  {
    const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const notices = captureNotices();
    const realVault = app.vault;
    const bin = new Map<string, ArrayBuffer>();
    const folders: string[] = [];
    /** 让前 N 次路径探测都返回「已存在」，用来稳定复现撞名 */
    let forceExists = 0;
    /** 删除记账：用来证明确实**没有**把刚写进库的源文件删掉 */
    let removed = 0;

    const deviceVault: any = {
      getFiles: () => vaultFiles,
      getAbstractFileByPath: () => null,
      delete: async () => {
        removed++;
      },
      createFolder: async (p: string) => {
        folders.push(p);
        return { path: p };
      },
      createBinary: async (p: string, data: ArrayBuffer) => {
        bin.set(p, data);
        return mkFile(p, data.byteLength);
      },
      adapter: {
        remove: async () => {
          removed++;
        },
        exists: async (p: string) => {
          if (p === ".inkbook-assets") return folders.includes(p);
          if (forceExists > 0) {
            forceExists--;
            return true;
          }
          return bin.has(p);
        },
        mkdir: async (p: string) => {
          folders.push(p);
        },
      },
    };
    app.vault = deviceVault;
    vaultFiles = [];

    try {
      /* 1) 空库也能从设备选：按钮 + 隐藏 input 必须都在 */
      const picked: any[] = [];
      const m = new ImportSourceModal(app, "pdf", (f) => picked.push(f));
      const el = openModal(m);
      pass(
        !!button(el, "从设备选择文件…"),
        "INK-207 库里没有文件时仍显示「从设备选择文件…」"
      );
      pass(
        el.querySelector(".mb-error")?.textContent === "库里还没有 PDF 文件。",
        "INK-207 空库仍保留原来的空状态提示"
      );

      const input = el.querySelector('input[type="file"]') as HTMLInputElement;
      pass(
        !!input &&
          input.type === "file" &&
          (input.getAttribute("accept") || "").includes(".pdf"),
        "INK-207 隐藏的文件输入框接受 .pdf"
      );

      const fake: any = {
        // 带路径分隔符和 Windows 非法字符：模拟平板 / 另一台电脑给的名字
        name: "我的/讲义?.PDF",
        size: 4,
        arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer,
      };
      Object.defineProperty(input, "files", { configurable: true, get: () => [fake] });
      input.dispatchEvent(new Event("change"));
      await sleepMs(80);

      const got = picked[0];
      pass(
        picked.length === 1 &&
          /^\.inkbook-assets\/imported-\d+-我的_讲义_\.pdf$/.test(got?.path || ""),
        "INK-207 文件名被清洗并写进 .inkbook-assets（" + (got?.path || "-") + "）"
      );
      const copied = got ? bin.get(got.path) : undefined;
      pass(
        !!copied && new Uint8Array(copied).join(",") === "37,80,68,70",
        "INK-207 字节原样写进库（File → createBinary）"
      );
      pass(folders.includes(".inkbook-assets"), "INK-207 自动创建 .inkbook-assets 目录");
      pass(!el.isConnected, "INK-207 选中设备文件后弹窗关闭");
      pass(
        !!got && bin.has(got.path) && removed === 0,
        "INK-207 源文件保留在库（PDF 懒渲染 / 导出还要用，不删）"
      );

      /* 2) 扩展名自校验：accept 可能被平板忽略，不能只依赖它 */
      const picked2: any[] = [];
      const m2 = new ImportSourceModal(app, "pdf", (f) => picked2.push(f));
      const el2 = openModal(m2);
      const input2 = el2.querySelector('input[type="file"]') as HTMLInputElement;
      const wrong: any = {
        name: "说明.docx",
        size: 10,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
      Object.defineProperty(input2, "files", { configurable: true, get: () => [wrong] });
      input2.dispatchEvent(new Event("change"));
      await sleepMs(50);
      pass(
        picked2.length === 0 && el2.isConnected,
        "INK-207 选错扩展名不回调、不关窗"
      );
      pass(
        notices.includes("只能导入 PDF 文件：说明.docx"),
        "INK-207 选错扩展名给出明确提示（" + notices.slice(-1).join("") + "）"
      );
      pass(
        (el2.querySelector(".mb-import-status")?.textContent || "").includes("不是 PDF 文件"),
        "INK-207 弹窗内也有失败原因"
      );
      m2.close();

      /*
       * INK-214 续：老式 .doc 要给出「另存为 .docx」的操作建议，
       * 不能只说「只能导入 .docx」——用户手里拿的往往就是 .doc。
       */
      const pickedDoc: any[] = [];
      const mDoc = new ImportSourceModal(app, "word", (f) => pickedDoc.push(f));
      const elDoc = openModal(mDoc);
      const inputDoc = elDoc.querySelector('input[type="file"]') as HTMLInputElement;
      const oldDoc: any = {
        name: "老文档.doc",
        size: 10,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
      Object.defineProperty(inputDoc, "files", { configurable: true, get: () => [oldDoc] });
      inputDoc.dispatchEvent(new Event("change"));
      await sleepMs(50);
      const docNotice = notices[notices.length - 1] || "";
      pass(
        pickedDoc.length === 0 &&
          docNotice.includes(".doc") &&
          docNotice.includes("另存为"),
        "INK-214 老式 .doc 给出「另存为 .docx」的建议（" + docNotice + "）"
      );
      mDoc.close();

      /* 3) 撞名：库里已有同名 imported 文件时加序号，绝不覆盖 */
      forceExists = 1;
      const picked3: any[] = [];
      const m3 = new ImportSourceModal(app, "pdf", (f) => picked3.push(f));
      const el3 = openModal(m3);
      const input3 = el3.querySelector('input[type="file"]') as HTMLInputElement;
      const dup: any = {
        name: "撞名.pdf",
        size: 2,
        arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
      };
      Object.defineProperty(input3, "files", { configurable: true, get: () => [dup] });
      input3.dispatchEvent(new Event("change"));
      await sleepMs(80);
      pass(
        picked3.length === 1 && picked3[0].path.includes("-1-撞名.pdf"),
        "INK-207 撞名时加序号而不是覆盖（" + (picked3[0]?.path || "-") + "）"
      );

      /* 4) 大文件先提示等待（否则用户以为点了没反应） */
      const bigNoticesBefore = notices.length;
      const m4 = new ImportSourceModal(app, "pdf", () => {});
      const el4 = openModal(m4);
      const input4 = el4.querySelector('input[type="file"]') as HTMLInputElement;
      const big: any = {
        name: "扫描件.pdf",
        size: 21 * 1024 * 1024,
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      };
      Object.defineProperty(input4, "files", { configurable: true, get: () => [big] });
      input4.dispatchEvent(new Event("change"));
      await sleepMs(80);
      pass(
        notices.slice(bigNoticesBefore).some((n) => n.includes("文件较大")),
        "INK-207 大文件给出「需要一点时间」提示（" + notices.slice(bigNoticesBefore).join("|") + "）"
      );

      /* 5) 空视图的 any：标题、列表、设备 input 都覆盖 PDF + docx */
      vaultFiles = [mkFile("a.pdf", 10), mkFile("b.docx", 20), mkFile("c.md", 30)];
      const pickedAny: any[] = [];
      const mAny = new ImportSourceModal(app, "any", (f) => pickedAny.push(f));
      const elAny = openModal(mAny);
      pass(elAny.querySelector("h3")?.textContent === "导入文档", "INK-207 any：标题为「导入文档」");
      pass(
        elAny.querySelectorAll(".mb-import-item").length === 2,
        "INK-207 any：库里同时列出 PDF 与 docx（忽略 md）"
      );
      const anyInput = elAny.querySelector('input[type="file"]') as HTMLInputElement;
      pass(
        (anyInput.getAttribute("accept") || "").includes(".pdf") &&
          (anyInput.getAttribute("accept") || "").includes(".docx"),
        "INK-207 any：文件输入框同时接受 .pdf / .docx"
      );

      /*
       * INK-214 平板选 Word 导入不了：安卓文件选择器按 **MIME** 过滤，
       * 只写扩展名 `.docx` 会匹配不到任何类型（列表空白 / 全置灰）。
       * 必须同时给出 docx 的完整 MIME。
       */
      const docxMime =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const anyAccept = anyInput.getAttribute("accept") || "";
      pass(
        anyAccept.includes(docxMime),
        "INK-214 any：accept 带 docx 完整 MIME（平板按 MIME 过滤）"
      );
      const wordModal = new ImportSourceModal(app, "word", () => {});
      const wordEl = openModal(wordModal);
      const wordInput = wordEl.querySelector('input[type="file"]') as HTMLInputElement;
      const wordAccept = wordInput.getAttribute("accept") || "";
      pass(
        wordAccept.includes(".docx") && wordAccept.includes(docxMime),
        "INK-214 word：accept 同时有扩展名与 MIME（" + wordAccept + "）"
      );

      /*
       * 零尺寸元素在个别 WebView 里点不开选择器 → 必须是 1×1 且移出视口。
       * 同时验证点击走 showPicker（新内核）或 click（老内核）都能触发。
       */
      pass(
        wordInput.style.width === "1px" &&
          wordInput.style.height === "1px" &&
          wordInput.style.left === "-9999px",
        "INK-214 文件输入框是 1×1 且移出视口（不是零尺寸）"
      );
      let pickerCalls = 0;
      let clickCalls = 0;
      const origClick = wordInput.click;
      (wordInput as any).showPicker = () => {
        pickerCalls++;
      };
      wordInput.click = () => {
        clickCalls++;
      };
      clickButton(wordEl, "从设备选择文件…");
      pass(
        pickerCalls === 1 && clickCalls === 0,
        "INK-214 点击按钮走 showPicker（picker=" + pickerCalls + " click=" + clickCalls + "）"
      );
      // 老内核没有 showPicker：必须退回 click()
      delete (wordInput as any).showPicker;
      clickButton(wordEl, "从设备选择文件…");
      pass(
        clickCalls === 1,
        "INK-214 没有 showPicker 时退回 click()（click=" + clickCalls + "）"
      );
      wordInput.click = origClick;
    } finally {
      app.vault = realVault;
      vaultFiles = [];
      releaseNotices();
    }
  }

  /* ---------------- INK-208 文件名清洗（含 Windows 保留名） ---------------- */
  {
    /*
     * 「从设备选文件」会拿到任意文件名。除了常规非法字符，
     * **Windows 保留名**（CON/PRN/AUX/NUL/COM1-9/LPT1-9）根本创建不了
     * ——带扩展名的 `CON.pdf` 也不行，系统会当成设备名。
     * 这是新功能直接引入的风险面，必须锁住。
     */
    const cases: Array<[string, string, string]> = [
      ["我的/讲义?.pdf", "我的_讲义_.pdf", "路径分隔符 + ? 被替换"],
      ["CON", "_CON", "Windows 保留名 CON"],
      ["CON.pdf", "_CON.pdf", "带扩展名的保留名 CON.pdf"],
      ["nul.docx", "_nul.docx", "保留名小写 nul"],
      ["COM1.pdf", "_COM1.pdf", "保留名 COM1"],
      ["LPT9.pdf", "_LPT9.pdf", "保留名 LPT9"],
      ["正常文件.pdf", "正常文件.pdf", "正常名字不动"],
      ["带 空格 的名字.pdf", "带 空格 的名字.pdf", "空格保留（只有一个）"],
      [".hidden.pdf", "hidden.pdf", "主干不以点开头"],
      ["a".repeat(200) + ".pdf", "a".repeat(80) + ".pdf", "超长主干截到 80"],
      ["无扩展名", "无扩展名", "无扩展名时只清洗主干"],
      ["x.PDF", "x.pdf", "扩展名转小写"],
    ];
    let bad = "";
    for (const [input, want, label] of cases) {
      const got = safeImportFileName(input);
      if (got !== want) bad += ` ${label}(得 ${JSON.stringify(got)})`;
    }
    pass(bad === "", "INK-208 文件名清洗 " + cases.length + " 种（含 Windows 保留名）" + (bad ? "：" + bad : ""));
  }

  log("DONE");
  document.title = "DONE";
}

main().catch((e) => {
  log("FATAL " + (e && e.stack ? e.stack : e));
  document.title = "FATAL";
});
