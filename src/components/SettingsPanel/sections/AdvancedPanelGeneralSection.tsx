/* =====================================================================
   AdvancedPanelGeneralSection —— Alt+Q 进阶面板通用设置
   使用 useSettingsDraft 统一加载 + 乐观更新 + 失败回滚（与 CookieSection/StorageSection 对齐）。
   后续可扩展更多 Alt+Q 专属设置（如窗口尺寸、标签栏样式等）。
   ===================================================================== */

import { updateAppSettings } from '../../../lib/electron-api';
import { useSettingsDraft } from '../../../hooks/useSettingsData';
import SegmentedControl from '../../ui/SegmentedControl';
import Toggle from '../../ui/Toggle';
import { SectionTitle, FormRow } from '../../ui';

type AdvancedPanelTab = 'chat' | 'whiteboard' | 'notes';

const TAB_OPTIONS: Array<{ value: AdvancedPanelTab; label: string }> = [
  { value: 'chat', label: '自定义对话' },
  { value: 'whiteboard', label: '白板' },
  { value: 'notes', label: '灵感笔记' },
];

export default function AdvancedPanelGeneralSection() {
  const { draft, setDraft } = useSettingsDraft();

  const defaultTab: AdvancedPanelTab = draft?.defaultAdvancedPanelTab ?? 'chat';
  const whiteboardSidebarVisible = draft?.whiteboardSidebarVisible ?? false;

  const handleChangeTab = async (value: AdvancedPanelTab) => {
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

  return (
    <section data-name="settings.advanced-panel-general.section">
      <SectionTitle>通用</SectionTitle>
      <FormRow label="默认打开">
        <SegmentedControl
          value={defaultTab}
          options={TAB_OPTIONS}
          onChange={(v) => void handleChangeTab(v)}
          name="默认打开"
          className="seg-control-row"
        />
      </FormRow>
      <FormRow
        label="白板侧边栏"
      >
        <Toggle
          checked={whiteboardSidebarVisible}
          onChange={(v) => void handleToggleSidebar(v)}
          aria-label="白板侧边栏"
        />
      </FormRow>
    </section>
  );
}
