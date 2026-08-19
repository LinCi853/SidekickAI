/* =====================================================================
   SettingsPanel/sections/DeveloperOptionsSection.tsx —— 开发者选项（独立设置栏）
   不止管理开发者插件：实验性模块（语音/TTS/页面冻结/浏览器）+ 开发者向设置
   （如「启用广告屏蔽规则」等底层调试选项）统一收纳在此栏。
   样式复用 ModuleManagementSection.css。
   ===================================================================== */

import { useEffect, useMemo, useState } from 'react';
import { useModuleStore } from '../../../store/useModuleStore';
import type { ModuleInfo } from '../../../lib/electron-api';
import Toggle from '../../ui/Toggle';
import ConfirmDialog from '../../ui/ConfirmDialog';
import SectionTitle from '../../ui/SectionTitle';
import FormRow from '../../ui/FormRow';
import './ModuleManagementSection.css';

export interface DeveloperOptionsSectionProps {
  /** 广告屏蔽规则开关状态（true=已禁用） */
  disableAllBlockRules: boolean;
  onToggleDisableAllBlockRules: () => void;
}

export default function DeveloperOptionsSection({
  disableAllBlockRules,
  onToggleDisableAllBlockRules,
}: DeveloperOptionsSectionProps) {
  const modules = useModuleStore((s) => s.modules);
  const initialized = useModuleStore((s) => s.initialized);
  const setEnabled = useModuleStore((s) => s.setEnabled);
  const clearData = useModuleStore((s) => s.clearData);

  const [pendingClear, setPendingClear] = useState<ModuleInfo | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!initialized) void useModuleStore.getState().init();
  }, [initialized]);

  const devModules = useMemo(() => modules.filter((m) => m.category === 'dev'), [modules]);

  const handleToggle = async (m: ModuleInfo, enabled: boolean) => {
    setErrorMsg(null);
    setOkMsg(null);
    const r = await setEnabled(m.id, enabled);
    if (!r.ok) setErrorMsg(m.name + '：' + (r.error ?? '操作失败'));
    else setOkMsg(m.name + (enabled ? '已开启' : '已关闭'));
  };

  const handleConfirmClear = async () => {
    if (!pendingClear) return;
    setErrorMsg(null);
    setOkMsg(null);
    const r = await clearData(pendingClear.id);
    if (r.ok) setOkMsg(pendingClear.name + '：已清除该模块所有数据');
    else setErrorMsg(pendingClear.name + '：' + (r.error ?? '清除失败'));
    setPendingClear(null);
  };

  const renderModule = (m: ModuleInfo, idx: number) => (
    <div
      key={m.id}
      className={'module-card' + (m.installed ? '' : ' is-missing')}
      data-name={'settings.developer.card-' + (idx + 1)}
      data-id={m.id}
    >
      <div className="module-card-head" data-name="settings.developer.card-head">
        <div className="module-card-title-row">
          <span className="module-card-name" data-name="settings.developer.card-name">{m.name}</span>
          {m.testBadge && (
            <span className="module-test-badge" data-name="settings.developer.test-badge">测试</span>
          )}
          {!m.installed && (
            <span className="module-missing-badge" data-name="settings.developer.missing-badge">未安装</span>
          )}
        </div>
        <div className="module-card-head-actions" data-name="settings.developer.card-actions">
          <button
            type="button"
            className="module-clear-btn"
            disabled={!m.installed}
            onClick={() => setPendingClear(m)}
            data-name="settings.developer.clear-data-button"
          >
            清除数据
          </button>
          <Toggle
            checked={m.enabled}
            disabled={!m.installed}
            onChange={(v) => void handleToggle(m, v)}
            aria-label={'启用 ' + m.name}
          />
        </div>
      </div>
      <p className="module-card-desc" data-name="settings.developer.card-desc">{m.description}</p>
      {/* 模块关闭时入口/快捷键已不存在，相关描述直接隐藏 */}
      {m.enabled && m.entries.length > 0 && (
        <p className="module-card-meta" data-name="settings.developer.card-entries">入口：{m.entries.join('、')}</p>
      )}
      {m.enabled && m.hotkeys.length > 0 && (
        <p className="module-card-meta" data-name="settings.developer.card-hotkeys">快捷键：{m.hotkeys.join('、')}</p>
      )}
      {!m.installed && (
        <p className="module-card-meta module-card-missing-hint" data-name="settings.developer.card-missing-hint">
          该模块未安装，请重新运行安装包补装。
        </p>
      )}
    </div>
  );

  return (
    <>
      <SectionTitle>开发者选项</SectionTitle>
      {(errorMsg || okMsg) && (
        <p className={'module-feedback' + (errorMsg ? ' is-error' : '')} data-name="settings.developer.feedback">
          {errorMsg ?? okMsg}
        </p>
      )}

      {/* 开发者向设置：启用广告屏蔽规则 */}
      <FormRow label="启用广告屏蔽规则" mutedLabel>
        <Toggle
          checked={!disableAllBlockRules}
          onChange={() => onToggleDisableAllBlockRules()}
          aria-label="启用广告屏蔽规则"
          data-name="settings.developer.enable-block-rules-toggle"
        />
      </FormRow>

      <div className="module-column" data-name="settings.developer.dev-module-list">
        {devModules.map((m, i) => renderModule(m, i))}
      </div>

      <ConfirmDialog
        open={pendingClear !== null}
        title="清除模块数据"
        message={'清除「' + (pendingClear?.name ?? '') + '」该模块所有数据（不可恢复）？'}
        variant="danger"
        confirmLabel="清除"
        onConfirm={() => void handleConfirmClear()}
        onCancel={() => setPendingClear(null)}
      />
    </>
  );
}
