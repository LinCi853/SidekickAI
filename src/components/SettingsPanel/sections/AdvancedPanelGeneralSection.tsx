/* =====================================================================
   AdvancedPanelGeneralSection —— Alt+Q 进阶面板通用设置
   使用 useSettingsDraft 统一加载 + 乐观更新 + 失败回滚（与 CookieSection/StorageSection 对齐）。
   后续可扩展更多 Alt+Q 专属设置（如窗口尺寸、标签栏样式等）。
   ===================================================================== */

import { useMemo } from 'react';
import { updateAppSettings } from '../../../lib/electron-api';
import { useModuleStore } from '../../../store/useModuleStore';
import { useSettingsDraft } from '../../../hooks/useSettingsData';
import SegmentedControl from '../../ui/SegmentedControl';
import Toggle from '../../ui/Toggle';
import { SectionTitle, FormRow } from '../../ui';

export default function AdvancedPanelGeneralSection() {
  const { draft, setDraft } = useSettingsDraft();
  // 模块联动：「默认打开」始终显示完整三个选项，已关闭模块的选项置灰不可选；
  // 可选项仅剩一项时隐藏整行；模块状态未加载完成时回退显示全部（防闪失）。
  // 订阅 modules 数组（勿用 (s) => s.isEnabled 函数 selector，不会触发重渲染）
  const modules = useModuleStore((s) => s.modules);
  const enabledModuleIds = useModuleStore((s) =>
    s.modules.filter((m) => m.enabled).map((m) => m.id),
  );
  const modulesInitialized = useModuleStore((s) => s.initialized);

  // 从模块信息动态构建 tab 选项（内置 + 插件声明的 advancedPanelTab）
  const tabOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string; moduleId: string }> = [
      { value: 'chat', label: '自定义对话', moduleId: 'custom-chat' },
      { value: 'whiteboard', label: '白板', moduleId: 'whiteboard' },
      { value: 'notes', label: '灵感笔记', moduleId: 'notes' },
    ];
    for (const m of modules) {
      if (m.advancedPanelTab && !opts.some((o) => o.value === m.advancedPanelTab!.key)) {
        opts.push({ value: m.advancedPanelTab.key, label: m.advancedPanelTab.label, moduleId: m.id });
      }
    }
    return opts;
  }, [modules]);

  const availableTabs = modulesInitialized
    ? tabOptions.filter((o) => enabledModuleIds.includes(o.moduleId))
    : tabOptions;
  const moduleEnabled = (id: string) => enabledModuleIds.includes(id);

  const defaultTab: string = draft?.defaultAdvancedPanelTab ?? 'chat';
  const whiteboardSidebarVisible = draft?.whiteboardSidebarVisible ?? false;
  const notesRestoreCursor = draft?.notesRestoreCursor ?? true;
  const tabSwitchShortcuts = draft?.advancedPanelTabSwitchShortcuts ?? true;

  const handleChangeTab = async (value: string) => {
    const prev = defaultTab;
    setDraft({ defaultAdvancedPanelTab: value });
    try {
      await updateAppSettings({ defaultAdvancedPanelTab: value });
    } catch (e) {
      console.error('[AdvancedPanelGeneralSection] 保存默认 tab 设置失败:', e);
      setDraft({ defaultAdvancedPanelTab: prev });
    }
  };

  const handleToggleSidebar = async (value: boolean) => {
    const prev = whiteboardSidebarVisible;
    setDraft({ whiteboardSidebarVisible: value });
    try {
      await updateAppSettings({ whiteboardSidebarVisible: value });
    } catch (e) {
      console.error('[AdvancedPanelGeneralSection] 保存白板侧边栏设置失败:', e);
      setDraft({ whiteboardSidebarVisible: prev });
    }
  };

  const handleToggleRestoreCursor = async (value: boolean) => {
    const prev = notesRestoreCursor;
    setDraft({ notesRestoreCursor: value });
    try {
      await updateAppSettings({ notesRestoreCursor: value });
    } catch (e) {
      console.error('[AdvancedPanelGeneralSection] 保存光标恢复设置失败:', e);
      setDraft({ notesRestoreCursor: prev });
    }
  };

  const handleToggleTabSwitch = async (value: boolean) => {
    const prev = tabSwitchShortcuts;
    setDraft({ advancedPanelTabSwitchShortcuts: value });
    try {
      await updateAppSettings({ advancedPanelTabSwitchShortcuts: value });
    } catch (e) {
      console.error('[AdvancedPanelGeneralSection] 保存标签切换快捷键设置失败:', e);
      setDraft({ advancedPanelTabSwitchShortcuts: prev });
    }
  };

  return (
    <section data-name="settings.advanced-panel-general.section">
      <SectionTitle>通用</SectionTitle>
      {/* 默认打开：只显示已启用模块的选项（关闭的选项直接隐藏，不置灰）；
          可选项仅剩一项或没有时整行隐藏 */}
      {availableTabs.length > 1 && (
        <FormRow label="默认打开">
          <SegmentedControl
            value={availableTabs.some((o) => o.value === defaultTab) ? defaultTab : availableTabs[0].value}
            options={availableTabs}
            onChange={(v) => void handleChangeTab(v)}
            name="默认打开"
            className="seg-control-row"
          />
        </FormRow>
      )}
      {moduleEnabled('whiteboard') && (
      <FormRow
        label="白板侧边栏"
      >
        <Toggle
          checked={whiteboardSidebarVisible}
          onChange={(v) => void handleToggleSidebar(v)}
          aria-label="白板侧边栏"
        />
      </FormRow>
      )}
      {moduleEnabled('notes') && (
      <FormRow
        label="笔记恢复光标位置"
        hint="关闭后每次打开笔记都定位到末尾"
      >
        <Toggle
          checked={notesRestoreCursor}
          onChange={(v) => void handleToggleRestoreCursor(v)}
          aria-label="笔记恢复光标位置"
        />
      </FormRow>
      )}
      <FormRow
        label="标签切换快捷键"
        hint="Ctrl/Alt+1/2/3、Ctrl+Tab 切换对话/白板/笔记"
      >
        <Toggle
          checked={tabSwitchShortcuts}
          onChange={(v) => void handleToggleTabSwitch(v)}
          aria-label="标签切换快捷键"
        />
      </FormRow>
    </section>
  );
}
