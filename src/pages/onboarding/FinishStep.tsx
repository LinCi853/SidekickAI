/* =====================================================================
   pages/onboarding/FinishStep.tsx —— 引导页 4：开始使用
   职责：祝福 + 行动卡片（导入备份数据 / 深入设置 / 随时回顾）与导入错误提示。
   完成引导并打开完整设置的入口（先开设置窗再完成引导，避免引导窗销毁后 IPC 失败）
   由主文件传入回调。
   从 pages/OnboardingView.tsx 拆出，仅通过 props 回调操作状态，不改变任何行为。
   ===================================================================== */

import { ICONS, OnboardIcon } from './OnboardIcon';

interface FinishStepProps {
  importing: boolean;
  importError: string | null;
  finishing: boolean;
  onImport: () => Promise<void>;
  onFinishAndOpenSettings: () => Promise<void>;
}

export default function FinishStep({
  importing,
  importError,
  finishing,
  onImport,
  onFinishAndOpenSettings,
}: FinishStepProps) {
  return (
    <div className="onboarding-page onboarding-finish" data-name="onboarding.page-finish">
      <div className="onboarding-finish-content">
        <h2 className="onboarding-finish-title">一切就绪</h2>
        <p className="onboarding-finish-desc">祝你使用愉快！</p>
        <div className="onboarding-finish-cards">
          <button
            type="button"
            className="onboarding-finish-card"
            onClick={() => void onImport()}
            disabled={importing}
            data-name="onboarding.finish-import"
          >
            <span className="onboarding-finish-card-icon">
              <OnboardIcon size={16}>{ICONS.download}</OnboardIcon>
            </span>
            <strong>{importing ? '导入中...' : '导入备份数据'}</strong>
            <span>从旧电脑迁移对话、登录状态与设置</span>
          </button>
          <button
            type="button"
            className="onboarding-finish-card"
            onClick={() => void onFinishAndOpenSettings()}
            disabled={finishing}
            data-name="onboarding.finish-settings"
          >
            <span className="onboarding-finish-card-icon">
              <OnboardIcon size={16}>{ICONS.sliders}</OnboardIcon>
            </span>
            <strong>深入设置</strong>
            <span>完成引导并打开完整设置</span>
          </button>
          <div className="onboarding-finish-card is-static" data-name="onboarding.finish-revisit">
            <span className="onboarding-finish-card-icon">
              <OnboardIcon size={16}>{ICONS.book}</OnboardIcon>
            </span>
            <strong>随时回顾</strong>
            <span>本指南可从设置菜单再次打开</span>
          </div>
        </div>
        {importError && <span className="onboarding-error">{importError}</span>}
      </div>
    </div>
  );
}
