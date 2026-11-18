import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import {
  DEFAULT_SETTINGS,
  PAPERS,
  TEMPLATES,
  normalizeShapeSnap,
  type InkbookSettings,
  type PaperId,
  type TemplateId,
} from "./types";
import {
  HOTKEY_ACTIONS,
  actionCombos,
  formatCombo,
  hotkeyLabelFor,
  keyCombo,
} from "./hotkeys";

export interface InkbookPluginLike {
  settings: InkbookSettings;
  saveSettings(): Promise<void>;
  refreshViews(): void;
  /** 重建全库文字索引（main.ts 实现；测试桩可以不提供） */
  rebuildTextIndex?: () => Promise<{ books: number; pages: number; failed: number }>;
}

export class InkbookSettingTab extends PluginSettingTab {
  plugin: InkbookPluginLike;
  /** 滑杆防抖保存的定时器（见 saveSoon） */
  private saveTimer = 0;
  /** 正在录制快捷键时挂上的监听器（null = 没在录） */
  private captureHandler: ((e: KeyboardEvent) => void) | null = null;
  /**
   * 录制监听器挂在哪个窗口上（null = 没在录）。
   *
   * 不能写死主窗口的 `document`：Obsidian 1.15 起桌面端默认把设置面板开在
   * **独立的设置窗口**里（`settingsPopoutWindow` 默认 true），设置页的按键
   * 按钮属于那个窗口的 document。主窗口的 document 收不到那边的 keydown，
   * 表现就是点了按钮、按了键却毫无反应。所以按设置 UI 实际所在的窗口挂。
   */
  private captureTarget: Window | null = null;
  /** 录制结束后把按钮文字恢复成「当前键位」的回调 */
  private captureRestore: (() => void) | null = null;

  constructor(app: App, plugin: InkbookPluginLike) {
    super(app, plugin as any);
    this.plugin = plugin;
  }

  /**
   * 滑杆用的防抖保存（INK-202）。
   *
   * 滑杆的 `step` 很小（0.2 / 0.05），拖一次能连发几十个 `onChange`。
   * 每个都 `saveSettings()` = 几十次全量 `saveData`，而多窗口场景下
   * 全量覆盖会放大竞态（正是 INK-179 担心的那个问题）。
   *
   * 防抖 250ms：拖动期间只写最后一次。`refreshViews()` 仍然**立刻**调
   * ——用户要的是"拖的时候实时看到粗细变化"，延迟它反而像卡了。
   */
  private saveSoon(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      void this.plugin.saveSettings();
    }, 250);
  }

  /**
   * 记住设置页当前滚动位置，供 display() 整页重建后恢复。
   *
   * display() 会 `containerEl.empty()` 再逐行重建。真实 Obsidian 在重建设置行时
   * 会同步测量控件布局，只要在“已清空、尚未重建”的间隙发生一次 reflow，滚动
   * 容器的 scrollHeight 归零、scrollTop 就被浏览器钳到 0——用户改完一个快捷键
   * 就被弹回顶部。这里在清空前把滚动容器和它的 scrollTop 存下来。
   *
   * 滚动容器可能是 containerEl（.vertical-tab-content，真实 Obsidian 就是它），
   * 也可能是某个祖先，所以从 containerEl 往上找第一个“内容超出且 overflow 可滚”
   * 的元素，两种结构都能覆盖。
   */
  private captureScroll(): { el: HTMLElement; top: number } | null {
    let el: HTMLElement | null = this.containerEl;
    let fallback: { el: HTMLElement; top: number } | null = null;
    while (el) {
      const overflows = el.scrollHeight - el.clientHeight > 1;
      if (overflows && el.scrollTop > 0) {
        const view = el.ownerDocument?.defaultView;
        const oy = view ? view.getComputedStyle(el).overflowY : "";
        if (oy === "auto" || oy === "scroll" || oy === "overlay") {
          return { el, top: el.scrollTop };
        }
        // 计算样式认不出（个别主题给 overflow 用了别的值）时，只要它确实被滚过
        // 就先记住，继续往上找更“正统”的滚动容器；找不到再用它兜底。
        if (!fallback) fallback = { el, top: el.scrollTop };
      }
      el = el.parentElement;
    }
    return fallback;
  }

  /**
   * 重建完成、内容高度恢复后，把滚动位置放回去。
   *
   * 同步设一次即可（读取/写入 scrollTop 会强制布局）；再补一帧兜底：个别环境
   * （例如内容里有异步测量）首帧布局还没到位，同步那次可能被钳住，下一帧内容
   * 完整后再设一次更稳。
   */
  private restoreScroll(mem: { el: HTMLElement; top: number } | null): void {
    if (!mem || !(mem.top > 0)) return;
    mem.el.scrollTop = mem.top;
    const view = mem.el.ownerDocument?.defaultView;
    if (view && typeof view.requestAnimationFrame === "function") {
      view.requestAnimationFrame(() => {
        mem.el.scrollTop = mem.top;
      });
    }
  }

  display(): void {
    const { containerEl } = this;
    const scroll = this.captureScroll();
    this.cancelHotkeyCapture();
    containerEl.empty();
    containerEl.createEl("h2", { text: "墨本 Inkbook 设置" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "默认值只影响新建的手写本；已有的本子按自己的页面设置走。",
    });

    new Setting(containerEl)
      .setName("新建时的纸张模板")
      .setDesc("空白 / 横线 / 网格 / 点阵 / 康奈尔 / 周计划")
      .addDropdown((d) => {
        for (const t of TEMPLATES) d.addOption(t.id, t.label);
        d.setValue(this.plugin.settings.defaultTemplate).onChange(async (v) => {
          this.plugin.settings.defaultTemplate = v as TemplateId;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("新建时的纸色")
      .addDropdown((d) => {
        for (const p of PAPERS) d.addOption(p.id, p.label);
        d.setValue(this.plugin.settings.defaultPaper).onChange(async (v) => {
          this.plugin.settings.defaultPaper = v as PaperId;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("默认笔尖粗细")
      .setDesc("页面坐标里的粗细；屏幕上的实际粗细会随缩放变化")
      .addSlider((s) =>
        s
          .setLimits(1, 8, 0.2)
          .setValue(this.plugin.settings.defaultPenSize)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.defaultPenSize = v;
            this.saveSoon();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName("默认荧光笔粗细")
      .setDesc("侧栏「荧光 细 / 中 / 粗」的选择也会写回这里；页面坐标里的粗细，随缩放变化")
      .addSlider((s) =>
        s
          .setLimits(4, 40, 1)
          .setValue(this.plugin.settings.defaultHighlighterSize || 24)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.defaultHighlighterSize = v;
            this.saveSoon();
            this.plugin.refreshViews();
          })
      );

    /*
     * 「上次用的颜色」以前只存在侧栏，设置页看不到也改不了。
     * 补一个取色器：改完立即同步到已经打开的墨本（refreshViews →
     * view.syncSettings），下次打开也会从 settings 恢复。
     */
    new Setting(containerEl)
      .setName("上次用的笔色")
      .setDesc("侧栏里点过的笔色会写回这里；改这里也会成为当前笔色")
      .addColorPicker((c) =>
        c
          .setValue(this.plugin.settings.lastPenColor || "#1A1A1A")
          .onChange(async (v) => {
            this.plugin.settings.lastPenColor = v;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName("上次用的荧光色")
      .setDesc("侧栏里点过的荧光色会写回这里；改这里也会成为当前荧光色")
      .addColorPicker((c) =>
        c
          .setValue(this.plugin.settings.lastHighlighterColor || "#F6E05E")
          .onChange(async (v) => {
            this.plugin.settings.lastHighlighterColor = v;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName("压感灵敏度")
      .setDesc("越大，轻写和重写的粗细差别越明显（0.3–1.5）")
      .addSlider((s) =>
        s
          .setLimits(0.3, 1.5, 0.05)
          .setValue(this.plugin.settings.pressure)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.pressure = v;
            this.saveSoon();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName("手写平滑")
      .setDesc("滤掉手抖和采样噪声，让线条干净；调高更稳，调低更跟手（0–1）")
      .addSlider((s) =>
        s
          .setLimits(0, 1, 0.05)
          .setValue(this.plugin.settings.smoothing)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.smoothing = v;
            this.saveSoon();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName("笔画预测")
      .setDesc("墨迹会比笔尖稍微跑在前面，落笔更跟手，类似 Apple Notes")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.prediction).onChange(async (v) => {
          this.plugin.settings.prediction = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("只认触控笔")
      .setDesc("打开后手指只负责滚动页面，掌根压上去也不会画出线")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.penOnly).onChange(async (v) => {
          this.plugin.settings.penOnly = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("允许手指书写")
      .setDesc(
        "打开后手指可以直接在纸上写字（平板没笔时用），代价是单指不再滚页——滚动改用双指或右缘滑条。以前这个开关每次打开 Obsidian 都会复位，现在会记住。"
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.touchDraw === true).onChange(async (v) => {
          this.plugin.settings.touchDraw = v;
          /*
           * 与侧栏开关一致：打开手指书写时一并关掉「只认触控笔」，
           * 否则后者会把手写压住，开关看起来像没生效。
           *
           * **改完必须重绘面板**（INK-202）：上面那个「只认触控笔」
           * Toggle 的 DOM 是打开设置页时按当时的值建的，这里改了字段
           * 它不会跟着变——用户会看到「手指书写」开着、「只认触控笔」
           * 也还亮着，两个互斥的开关同时显示「开」，界面在骗人。
           */
          const crossChanged = v && this.plugin.settings.penOnly;
          if (v) this.plugin.settings.penOnly = false;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
          if (crossChanged) this.display();
        })
      );

    new Setting(containerEl)
      .setName("在墨本里屏蔽「左缘右滑弹文件列表」")
      .setDesc(
        "开启后，在墨本笔记里从最左缘往右划不会弹出文件列表（手指、笔都算）。代价：在墨本里这个手势会失效，改用左侧栏按钮或命令面板；关掉开关即可恢复。"
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.blockEdgeSwipe).onChange(async (v) => {
          this.plugin.settings.blockEdgeSwipe = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("在墨本里屏蔽「命令面板」")
      .setDesc(
        "开启后，在墨本笔记里平板下拉手势、误触都不会弹出命令面板——拖右侧滑条时弹出的就是它。键盘 Ctrl/Cmd+P 仍然可用（不连键盘一起拦）。离开墨本文件即恢复。"
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.blockCommandPalette !== false)
          .onChange(async (v) => {
            this.plugin.settings.blockCommandPalette = v;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName("自动把直线画直")
      .setDesc(
        "开启后，用钢笔、圆珠笔或荧光笔画出的近似直线，抬手时会自动拉直（保留原来的粗细与压感）。只识别直线，圆圈、曲线、字迹不受影响。"
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.straightLine === true).onChange(async (v) => {
          this.plugin.settings.straightLine = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("一笔成型（自动识别图形）")
      .setDesc(
        "用手绘一笔圈出矩形、椭圆、直线或箭头，抬手就自动换成规整图形（颜色、粗细沿用当前笔）。" +
          "识别不了就原样保留笔迹，不会把字迹吃掉。默认关闭，也可以直接在钢笔 / 圆珠笔的弹出笔盒里开关。"
      )
      .addToggle((t) =>
        t
          .setValue(normalizeShapeSnap(this.plugin.settings.shapeSnap) !== "off")
          .onChange(async (v) => {
            this.plugin.settings.shapeSnap = v ? "lift" : "off";
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName("激光笔")
      .setDesc(
        "开启后落笔只在页面上方留一条会淡出的红色指示光迹，" +
          "不写进本子、不进撤销栈、导出里也没有，适合投屏讲解时指一指。再点一次可随时关掉。"
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.laserPointer === true).onChange(async (v) => {
          this.plugin.settings.laserPointer = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("生成文字索引（全局搜索能搜到手写本里的字）")
      .setDesc(
        "开启后，每次保存会在库根公共文件夹「墨本文件/」下按本子分一个叶子目录，为**有文字的页**各写一个「本子名 · 第 N 页.md」（文字来自 PDF 原文与手动添加的文字，手写笔迹不在其中）。这本导入文档产生的底图与 PDF/Word 原件也放在同一个叶子目录里，按本子分开、不会跟别的本子弄混。集中放是为了不弄乱各笔记文件夹；叶子目录用本子完整路径的可逆编码命名，同名本子也不会串。搜索结果直接显示是哪本本子的第几页，点开就跳回那一页。索引是派生文件，删掉不影响本子，下次保存会重建。"
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.searchIndex !== false).onChange(async (v) => {
          this.plugin.settings.searchIndex = v;
          await this.plugin.saveSettings();
          // 关掉后只是不再更新索引；已经生成的那份会停在最后一次保存的内容，
          // 不需要它时直接删掉那个目录即可（删了不影响本子）
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("跳转后轻提示落点")
      .setDesc(
        "从搜索结果、内部链接或嵌入跳到某一页后，目标页边缘轻轻亮一下、页顶浮出「已跳到第 N 页」，约 2 秒自动消失。全局搜索不提供命中行号和搜索词，插件无法高亮具体文字，这个提示负责帮你确认落在哪一页。不拦触控、不影响导出的 PDF；关掉后跳转行为不变。"
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.jumpHint !== false).onChange(async (v) => {
          this.plugin.settings.jumpHint = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    /*
     * 手动补建按钮。
     *
     * 为什么设置页也要放一颗（命令面板里已经有了）：
     * 墨本默认屏蔽命令面板——用户在墨本里按 Ctrl+P 打不开，
     * 想补建索引就必须先切到别的笔记，太绕。
     */
    new Setting(containerEl)
      .setName("重建文字索引")
      .setDesc(
        "把库里每一本手写本重新写一遍索引。生成过索引、但全局搜索搜不到时点这里——旧版裸写、同步工具从外部建目录等情况会让索引目录没被 Obsidian 收录，这里会自动修复目录登记并重写。"
      )
      .addButton((b) => {
        b.setButtonText("立即重建").onClick(async () => {
          if (!this.plugin.rebuildTextIndex) {
            b.setButtonText("当前版本不支持");
            return;
          }
          b.setButtonText("重建中…");
          b.setDisabled(true);
          try {
            const r = await this.plugin.rebuildTextIndex();
            b.setButtonText(
              r.failed
                ? `完成 · ${r.pages} 页，${r.failed} 本失败`
                : r.pages > 0
                ? `完成 · ${r.pages} 页`
                : "完成 · 无文字"
            );
          } catch (_) {
            b.setButtonText("失败，看控制台");
          } finally {
            b.setDisabled(false);
            window.setTimeout(() => b.setButtonText("立即重建"), 4000);
          }
        });
      });

    new Setting(containerEl)
      .setName("自动保存")
      .setDesc("停笔约 0.8 秒写回 .inkbook 文件")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autosave).onChange(async (v) => {
          this.plugin.settings.autosave = v;
          await this.plugin.saveSettings();
          /*
           * 关掉后 refreshViews 会取消各视图已经排队的自动保存；
           * 打开时也让视图跟上，避免别的窗口同步来的设置与内存不一致。
           */
          this.plugin.refreshViews();
        })
      );

    this.renderHotkeySettings(containerEl);
    this.restoreScroll(scroll);
  }

  /**
   * 「快捷键」设置区：为每个动作录制 / 修改 / 恢复默认键位。
   *
   * 交互：点一下右侧的键位按钮进入录制态，再按下想要的组合即可；用 document
   * 捕获阶段拦键，录制时不会误触发墨本视图自己的快捷键。键位统一经
   * hotkeys.ts 的 keyCombo 规范化，和视图派发用的是同一套规则。
   */
  private renderHotkeySettings(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "快捷键" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "点一下右侧的按键按钮，再按下想用的按键即可录制（支持 Ctrl/⌘、Alt 组合，也可以只用一个键）。" +
        "录制时按 Esc 取消；单独按 Delete 或 Backspace 可清除该快捷键。改完立即对所有已打开的墨本生效。",
    });

    let lastGroup = "";
    for (const action of HOTKEY_ACTIONS) {
      if (action.group !== lastGroup) {
        lastGroup = action.group;
        containerEl.createEl("h3", { text: action.group });
      }
      const defLabel = action.defaults.map((d) => formatCombo(d)).join(" / ");
      const setting = new Setting(containerEl)
        .setName(action.label)
        .setDesc(defLabel ? `默认：${defLabel}` : "默认未绑定");
      setting.addButton((b) => {
        const current = hotkeyLabelFor(action.id, this.plugin.settings.hotkeys);
        b.setButtonText(current || "未设置");
        b.setTooltip("点击后按下新的快捷键");
        b.buttonEl.classList.add("mb-hotkey-btn");
        b.onClick(() => this.beginHotkeyCapture(action.id, b));
      });
      setting.addExtraButton((xb) => {
        xb.setIcon("rotate-ccw");
        xb.setTooltip("恢复默认");
        xb.onClick(async () => {
          this.cancelHotkeyCapture();
          const hk = this.plugin.settings.hotkeys;
          if (hk && hk[action.id] !== undefined) {
            delete hk[action.id];
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          }
          this.display();
        });
      });
    }

    new Setting(containerEl)
      .setName("恢复所有默认快捷键")
      .setDesc("清除全部自定义设置，回到内置的默认键位。")
      .addButton((b) => {
        b.setButtonText("全部恢复默认").onClick(async () => {
          this.cancelHotkeyCapture();
          if (this.plugin.settings.hotkeys) {
            this.plugin.settings.hotkeys = {};
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          }
          this.display();
        });
      });
  }

  /** 离开设置页 / 关闭设置窗口时，先把录制态和监听收干净，避免残留监听误吞按键。 */
  hide(): void {
    this.cancelHotkeyCapture();
    super.hide();
  }

  /** 取消正在进行的录制（摘监听、恢复按钮文字）。 */
  private cancelHotkeyCapture(): void {
    if (this.captureHandler && this.captureTarget) {
      this.captureTarget.removeEventListener("keydown", this.captureHandler, true);
    }
    this.captureHandler = null;
    this.captureTarget = null;
    const restore = this.captureRestore;
    this.captureRestore = null;
    if (restore) {
      try {
        restore();
      } catch (_) {}
    }
  }

  /**
   * 进入录制态：在设置 UI 所在窗口的捕获阶段拦一次按键，规范化成 combo 后写回设置。
   * 用捕获 + stopPropagation，确保录制时不会同时触发墨本自己的快捷键。
   *
   * 关键：监听得挂在**设置面板实际所在的窗口**上。Obsidian 桌面端默认把设置
   * 开在单独窗口，`document` 指向的仍是主窗口，挂在主窗口上收不到按键，录制
   * 就完全没反应（本单要修的 bug）。`containerEl.ownerDocument.defaultView`
   * 会指向设置窗口，主窗口 / 独立窗口都能覆盖。
   */
  private beginHotkeyCapture(
    actionId: string,
    btn: { setButtonText(text: string): unknown; buttonEl: HTMLElement }
  ): void {
    this.cancelHotkeyCapture();
    const prevText = btn.buttonEl.textContent || "未设置";
    this.captureRestore = () => btn.setButtonText(prevText);
    btn.setButtonText("按下快捷键…");
    try {
      btn.buttonEl.focus();
    } catch (_) {}

    const ownerDoc = this.containerEl?.ownerDocument ?? document;
    const win: Window = ownerDoc.defaultView ?? window;

    const handler = (e: KeyboardEvent) => {
      const combo = keyCombo(e);
      if (!combo) return; // 只按了修饰键：继续等真正的主键
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      this.cancelHotkeyCapture();
      // Esc = 取消录制，不改动
      if (combo === "escape") return;
      // 单独按 Delete / Backspace = 清除这个快捷键
      if (combo === "delete" || combo === "backspace") {
        void this.clearHotkey(actionId);
        return;
      }
      void this.applyHotkeyCapture(actionId, combo);
    };
    win.addEventListener("keydown", handler, true);
    this.captureHandler = handler;
    this.captureTarget = win;
  }

  /** 清除某动作的键位并置为「禁用」（即使它当前用的是默认键位也能清）。 */
  private async clearHotkey(actionId: string): Promise<void> {
    const settings = this.plugin.settings;
    if (!settings.hotkeys) settings.hotkeys = {};
    if (settings.hotkeys[actionId] !== "") {
      settings.hotkeys[actionId] = ""; // 空串 = 主动禁用
      await this.plugin.saveSettings();
      this.plugin.refreshViews();
    }
    this.display();
  }

  /** 把录制到的 combo 写回某动作；顺带清掉占用同一键位的其它动作。 */
  private async applyHotkeyCapture(actionId: string, combo: string): Promise<void> {
    const settings = this.plugin.settings;
    if (!settings.hotkeys) settings.hotkeys = {};
    let clearedLabel: string | null = null;
    for (const a of HOTKEY_ACTIONS) {
      if (a.id === actionId) continue;
      if (actionCombos(a.id, settings.hotkeys).includes(combo)) {
        settings.hotkeys[a.id] = "";
        clearedLabel = a.label;
      }
    }
    settings.hotkeys[actionId] = combo;
    await this.plugin.saveSettings();
    this.plugin.refreshViews();
    if (clearedLabel) {
      new Notice(`「${clearedLabel}」的快捷键已清除（与新设置冲突）`, 3000);
    }
    this.display();
  }
}

export { DEFAULT_SETTINGS };
