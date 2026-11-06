import { PluginSettingTab, Setting, type App } from "obsidian";
import {
  DEFAULT_SETTINGS,
  PAPERS,
  TEMPLATES,
  type InkbookSettings,
  type PaperId,
  type TemplateId,
} from "./types";

export interface InkbookPluginLike {
  settings: InkbookSettings;
  saveSettings(): Promise<void>;
  refreshViews(): void;
  /** 重建全库文字索引（main.ts 实现；测试桩可以不提供） */
  rebuildTextIndex?: () => Promise<{ books: number; pages: number; failed: number }>;
}

export class InkbookSettingTab extends PluginSettingTab {
  plugin: InkbookPluginLike;

  constructor(app: App, plugin: InkbookPluginLike) {
    super(app, plugin as any);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
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
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
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
          // 与侧栏开关一致：打开手指书写时一并关掉「只认触控笔」，
          // 否则后者会把手写压住，开关看起来像没生效。
          if (v) this.plugin.settings.penOnly = false;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
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
        "开启后，在墨本笔记里命令面板打不开（快捷键 Ctrl/Cmd+P 同样拦下）。平板下拉手势、误触都算——拖右侧滑条时弹出的就是它。离开墨本文件即恢复。"
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
      .setName("生成文字索引（全局搜索能搜到手写本里的字）")
      .setDesc(
        "开启后，每次保存会在本子同目录的「本子名.墨本索引/」里，为**有文字的页**各写一个「本子名 · 第 N 页.md」（文字来自 PDF 原文与手动添加的文字，手写笔迹不在其中）。搜索结果直接显示是哪本本子的第几页，点开就跳回那一页。索引是派生文件，删掉不影响本子，下次保存会重建。"
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
        "把库里每一本手写本重新写一遍索引。以前生成过索引、但全局搜索搜不到时点这里——旧版是绕过 Obsidian 的文件表直接落盘的，可能一直没被检索收录。"
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
            b.setButtonText(r.pages > 0 ? `完成 · ${r.pages} 页` : "完成 · 无文字");
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
        })
      );
  }
}

export { DEFAULT_SETTINGS };
