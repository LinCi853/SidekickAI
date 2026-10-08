import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
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

  const stable = useMemo(() => modules.filter((m) => m.category === 'stable' && m.id !== 'freeze'), [modules]);
  const plugins = useMemo(() => modules.filter((m) => m.category === 'plugin'), [modules]);
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
          <Toggle
            checked={m.enabled}
            disabled={!m.installed}
            onChange={(v) => void handleToggle(m, v)}
            aria-label={'启用 ' + m.name}
          />
        </div>
      </div>
      <p className="module-card-desc" data-name="settings.modules.card-desc">{m.description}</p>
      {!m.installed && (
        <p className="module-card-meta module-card-missing-hint" data-name="settings.modules.card-missing-hint">
          该模块未安装，请重新运行安装包补装。
        </p>
      )}
      <div className="module-card-footer">
        {m.enabled && (m.entries.length > 0 || m.hotkeys.length > 0) && (
          <details className="module-entry-details">
            <summary>入口与快捷键</summary>
            {m.entries.length > 0 && <p className="module-card-meta" data-name="settings.modules.card-entries">入口：{m.entries.join('、')}</p>}
            {m.hotkeys.length > 0 && <p className="module-card-meta" data-name="settings.modules.card-hotkeys">快捷键：{m.hotkeys.join('、')}</p>}
          </details>
        )}
        <button
          type="button"
          className="btn-icon module-clear-icon"
          disabled={!m.installed}
          onClick={() => setPendingClear(m)}
          aria-label={'清除 ' + m.name + ' 数据'}
          title={'清除 ' + m.name + ' 数据'}
          data-name="settings.modules.clear-data-button"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );

  return (
    <section className="module-management" data-name="settings.modules.section">
      <SectionTitle>模块管理</SectionTitle>
      {(errorMsg || okMsg) && (
        <p
          className={'module-feedback' + (errorMsg ? ' is-error' : '')}
          data-name="settings.modules.feedback"
        >
          {errorMsg ?? okMsg}
        </p>
      )}

      <div className="module-column-title" data-name="settings.modules.market-title">内置模块</div>
      <div className="module-grid" data-name="settings.modules.market-list">
        {stable.map((m, i) => renderModule(m, i))}
      </div>
      {hasMissingLarge && (
        <p className="module-market-hint" data-name="settings.modules.market-missing-hint">
          可能存在未安装的大模块，如需使用请重新运行安装包补装。
        </p>
      )}

      {plugins.length > 0 && (
        <>
          <div className="module-column-title" data-name="settings.modules.plugins-title">功能插件</div>
          <div className="module-grid" data-name="settings.modules.plugins-list">
            {plugins.map((m, i) => renderModule(m, i))}
          </div>
        </>
      )}

      <ConfirmDialog
        open={pendingClear !== null}
        title="清除模块数据"
        message={pendingClear?.id === 'prompt-library'
          ? '请先关闭 AI资产，并结束 API 响应、文件导入和原件传输。将清除所有网页/API 对话、修订、文本用量、资料原件、提示词和注入记录（不可恢复）；保留账号与供应商配置、笔记、白板、浏览器历史和日志。确认清除？'
          : '清除「' + (pendingClear?.name ?? '') + '」该模块所有数据（不可恢复）？'}
        variant="danger"
        confirmLabel="清除"
        onConfirm={() => void handleConfirmClear()}
        onCancel={() => setPendingClear(null)}
      />
    </section>
  );
}
