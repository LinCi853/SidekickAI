/* =====================================================================
   AiAppSettingsPanel/index.tsx —— Alt+Q AI 应用窗口专属设置面板
   复用 SettingsPanelShell 外壳 + 共享 section（ProviderSection）。
   后续可在此面板中添加 Alt+Q 专属设置 section（如默认 tab、标签栏样式等）。
   ===================================================================== */

import SettingsPanelShell from '../SettingsPanel/SettingsPanelShell';
import AiAppGeneralSection from '../SettingsPanel/sections/AiAppGeneralSection';
import ProviderSection from '../SettingsPanel/sections/ProviderSection';
import AboutSection from '../SettingsPanel/sections/AboutSection';

export interface AiAppSettingsPanelProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
}

export default function AiAppSettingsPanel({ open, onClose }: AiAppSettingsPanelProps) {
  return (
    <SettingsPanelShell open={open} onClose={onClose} title="AI 应用设置">
      {/* Alt+Q 专属设置：默认打开的 tab 等 */}
      <AiAppGeneralSection />
      {/* 共享 section：供应商管理（原 ProvidersModal） */}
      <ProviderSection defaultCollapsed={false} />
      <AboutSection />
    </SettingsPanelShell>
  );
}
