/* =====================================================================
   AiAppGeneralSection —— Alt+Q AI 应用窗口通用设置
   自管理 state（参照 CookieSection/StorageSection 模式）。
   后续可扩展更多 Alt+Q 专属设置（如窗口尺寸、标签栏样式等）。
   ===================================================================== */

import { useEffect, useState } from 'react';
import { getAppSettings, updateAppSettings } from '../../../lib/electron-api';
import SegmentedControl from '../../ui/SegmentedControl';
import { SectionTitle, FormRow } from '../../ui';

type AiAppTab = 'chat' | 'whiteboard' | 'notes';

const TAB_OPTIONS: Array<{ value: AiAppTab; label: string }> = [
  { value: 'chat', label: '自定义对话' },
  { value: 'whiteboard', label: '白板' },
  { value: 'notes', label: '灵感笔记' },
];

export default function AiAppGeneralSection() {
  const [defaultTab, setDefaultTab] = useState<AiAppTab>('chat');

  useEffect(() => {
    void getAppSettings()
      .then((cfg) => {
        setDefaultTab(cfg.defaultAiAppTab ?? 'chat');
      })
      .catch((e) => {
        console.error('[AiAppGeneralSection] 加载默认 tab 设置失败:', e);
      });
  }, []);

  const handleChange = async (value: AiAppTab) => {
    const prev = defaultTab;
    setDefaultTab(value);
    try {
      await updateAppSettings({ defaultAiAppTab: value });
    } catch (e) {
      console.error('[AiAppGeneralSection] 保存默认 tab 设置失败:', e);
      setDefaultTab(prev);
    }
  };

  return (
    <section data-name="settings.ai-app-general.section">
      <SectionTitle>通用</SectionTitle>
      <FormRow label="默认打开" hint="Alt+Q 打开 AI 应用窗口时首先显示的标签页">
        <SegmentedControl
          value={defaultTab}
          options={TAB_OPTIONS}
          onChange={(v) => void handleChange(v)}
          name="默认打开"
          className="proxy-mode-group"
        />
      </FormRow>
    </section>
  );
}
