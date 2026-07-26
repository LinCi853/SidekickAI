/* =====================================================================
   AdvancedPanelSettingsPanel/index.tsx —— Alt+Q 进阶面板专属设置面板
   复用 SettingsPanelShell 外壳 + 共享 section（ProviderSection）。
   后续可在此面板中添加 Alt+Q 专属设置 section（如默认 tab、标签栏样式等）。
   ===================================================================== */

import { useState } from 'react';
import SettingsPanelShell from '../SettingsPanel/SettingsPanelShell';
import AdvancedPanelGeneralSection from '../SettingsPanel/sections/AdvancedPanelGeneralSection';
import ProviderSection from '../SettingsPanel/sections/ProviderSection';

export interface AdvancedPanelSettingsPanelProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
}

export default function AdvancedPanelSettingsPanel({ open, onClose }: AdvancedPanelSettingsPanelProps) {
  // 供应商编辑状态：编辑时本地强制隐藏侧滑面板，让编辑 Modal 全屏覆盖进阶面板
  // 与主窗口 SettingsPanel 体验保持一致（侧滑面板的 transform 会破坏内部 Modal 的 fixed 定位）
  // 编辑完成后侧滑面板自动恢复打开状态，便于继续编辑其他设置
  const [providerEditing, setProviderEditing] = useState(false);

  return (
    <SettingsPanelShell open={open && !providerEditing} onClose={onClose} title="进阶面板设置">
      {/* Alt+Q 专属设置：默认打开的 tab 等 */}
      <AdvancedPanelGeneralSection />
      {/* 共享 section：供应商管理（原 ProvidersModal） */}
      <ProviderSection
        defaultCollapsed={false}
        onEditingChange={setProviderEditing}
      />
    </SettingsPanelShell>
  );
}
