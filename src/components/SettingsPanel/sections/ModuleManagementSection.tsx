/* =====================================================================
   SettingsPanel/sections/ModuleManagementSection.tsx —— 模块管理设置区
   两个栏目：插件市场（稳定模块）/ 开发者选项（实验性模块，默认关闭 + 测试标签）。
   每个模块条目：启用开关、功能描述、入口、热键、清除数据（二次确认）。
   大模块（画板）未安装时置灰 + 提示重新运行安装包补装。
   ===================================================================== */

import { useEffect, useMemo, useState } from 'react';
import { useModuleStore } from '../../../store/useModuleStore';
import type { ModuleInfo } from '../../../lib/electron-api';
import Toggle from '../../ui/Toggle';
import ConfirmDialog from '../../ui/ConfirmDialog';
import SectionTitle from '../../ui/SectionTitle';
import './ModuleManagementSection.css';

export default function ModuleManagementSection() {
  const modules = useModuleStore((s) => s.modules);
  const initialized = useModuleStore((s) => s.initialized);
  const setEnabled = useModuleStore((s) => s.setEnabled);
  const clearData = useModuleStore((s) => s.clearData);

  const [pendingClear, setPendingClear] = useState<ModuleInfo | null>(null);
  const [clearing, setClearing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!initialized) void useModuleStore.getState().init();
  }, [initialized]);

  // 插件市场只展示稳定模块；开发者模块与开发者设置见「开发者选项」独立栏目
  const stable = useMemo(() => modules.filter((m) => m.category === 'stable'), [modules]);
  const hasMissingLarge = modules.some((m) => m.sizeLevel === 'large' && !m.installed);

  const handleToggle = async (m: ModuleInfo, enabled: boolean) => {
    setErrorMsg(null);
    setOkMsg(null);
    const r = await setEnabled(m.id, enabled);
    if (!r.ok) setErrorMsg(m.name + '：' + (r.error ?? '操作失败'));
    else setOkMsg(m.name + (enabled ? '已开启' : '已关闭，可随时开启'));
  };

  const handleConfirmClear = async () => {
    if (!pendingClear) return;
    setClearing(true);
    setErrorMsg(null);
    setOkMsg(null);
    const r = await clearData(pendingClear.id);
    setClearing(false);
    if (r.ok) {
      setOkMsg(pendingClear.name + '：已清除该模块所有数据');
    } else {
      setErrorMsg(pendingClear.name + '：' + (r.error ?? '清除失败'));
    }
    setPendingClear(null);
  };

  const renderModule = (m: ModuleInfo, idx: number) => (
    <div
      key={m.id}
      className={'module-card' + (m.installed ? '' : ' is-missing')}
      data-name={'settings.modules.card-' + (idx + 1)}
      data-id={m.id}
    >
      <div className="module-card-head" data-name="settings.modules.card-head">
        <div className="module-card-title-row">
          <span className="module-card-name" data-name="settings.modules.card-name">
            {m.name}
          </span>
          {m.testBadge && (
            <span className="module-test-badge" data-name="settings.modules.test-badge">测试</span>
          )}
          {!m.installed && (
            <span className="module-missing-badge" data-name="settings.modules.missing-badge">未安装</span>
          )}
        </div>
        <div className="module-card-head-actions" data-name="settings.modules.card-actions">
          <button
            type="button"
            className="module-clear-btn"
            disabled={!m.installed}
            onClick={() => setPendingClear(m)}
            data-name="settings.modules.clear-data-button"
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
      <p className="module-card-desc" data-name="settings.modules.card-desc">{m.description}</p>
      {/* 模块关闭时入口/快捷键已不存在，相关描述直接隐藏 */}
      {m.enabled && m.entries.length > 0 && (
        <p className="module-card-meta" data-name="settings.modules.card-entries">
          入口：{m.entries.join('、')}
        </p>
      )}
      {m.enabled && m.hotkeys.length > 0 && (
        <p className="module-card-meta" data-name="settings.modules.card-hotkeys">
          快捷键：{m.hotkeys.join('、')}
        </p>
      )}
      {!m.installed && (
        <p className="module-card-meta module-card-missing-hint" data-name="settings.modules.card-missing-hint">
          该模块未安装，请重新运行安装包补装。
        </p>
      )}
    </div>
  );

  return (
    <>
      <SectionTitle>模块管理</SectionTitle>
      {(errorMsg || okMsg) && (
        <p
          className={'module-feedback' + (errorMsg ? ' is-error' : '')}
          data-name="settings.modules.feedback"
        >
          {errorMsg ?? okMsg}
        </p>
      )}

      <div className="module-column-title" data-name="settings.modules.market-title">插件市场</div>
      <div className="module-column" data-name="settings.modules.market-list">
        {stable.map((m, i) => renderModule(m, i))}
        {hasMissingLarge && (
          <p className="module-market-hint" data-name="settings.modules.market-missing-hint">
            可能存在未安装的大模块，如需使用请重新运行安装包补装。
          </p>
        )}
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
