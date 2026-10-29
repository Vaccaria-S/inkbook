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
