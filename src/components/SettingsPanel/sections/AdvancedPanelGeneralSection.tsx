/* =====================================================================
   AdvancedPanelGeneralSection —— Alt+Q 进阶面板通用设置
   自管理 state（参照 CookieSection/StorageSection 模式）。
   后续可扩展更多 Alt+Q 专属设置（如窗口尺寸、标签栏样式等）。
   ===================================================================== */

import { useEffect, useState } from 'react';
import { getAppSettings, updateAppSettings } from '../../../lib/electron-api';
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
  const [defaultTab, setDefaultTab] = useState<AdvancedPanelTab>('chat');
  const [whiteboardSidebarVisible, setWhiteboardSidebarVisible] = useState(false);

  useEffect(() => {
    void getAppSettings()
      .then((cfg) => {
        setDefaultTab(cfg.defaultAdvancedPanelTab ?? 'chat');
        setWhiteboardSidebarVisible(cfg.whiteboardSidebarVisible ?? false);
      })
      .catch((e) => {
        console.error('[AdvancedPanelGeneralSection] 加载设置失败:', e);
      });
  }, []);

  const handleChangeTab = async (value: AdvancedPanelTab) => {
    const prev = defaultTab;
    setDefaultTab(value);
    try {
      await updateAppSettings({ defaultAdvancedPanelTab: value });
    } catch (e) {
      console.error('[AdvancedPanelGeneralSection] 保存默认 tab 设置失败:', e);
      setDefaultTab(prev);
    }
  };

  const handleToggleSidebar = async (value: boolean) => {
    const prev = whiteboardSidebarVisible;
    setWhiteboardSidebarVisible(value);
    try {
      await updateAppSettings({ whiteboardSidebarVisible: value });
    } catch (e) {
      console.error('[AdvancedPanelGeneralSection] 保存白板侧边栏设置失败:', e);
      setWhiteboardSidebarVisible(prev);
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
