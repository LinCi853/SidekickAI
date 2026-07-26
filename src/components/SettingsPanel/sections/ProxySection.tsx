import { useState } from 'react';
import { Button, SegmentedControl, Toggle, SectionTitle } from '../../ui';
import type { ProxySettings } from '../types';
import { updateAppSettings, testProxy, applyProxy } from '../../../lib/electron-api';
import { useDraftState } from '../../../hooks/useDraftState';

interface ProxySectionProps {
  proxy: ProxySettings;
  onChange: (patch: Partial<ProxySettings>) => void;
}

export default function ProxySection({ proxy, onChange }: ProxySectionProps) {
  // 重命名解构：保持内部代码对字段名的引用不变，避免大量改动
  const {
    proxyMode,
    customProxy,
    proxyUsername,
    proxyPassword,
    proxyBypass,
    proxyFallbackEnabled,
    proxyFallbackMode,
  } = proxy;

  // setter 包装：仅更新父组件本地 state（即时 UI 反馈），持久化由本 Section 内部 updateAppSettings/applyProxy 完成
  const setProxyMode = (v: 'system' | 'direct' | 'custom') => onChange({ proxyMode: v });
  const setCustomProxy = (v: string) => onChange({ customProxy: v });
  const setProxyUsername = (v: string) => onChange({ proxyUsername: v });
  const setProxyPassword = (v: string) => onChange({ proxyPassword: v });
  const setProxyBypass = (v: string) => onChange({ proxyBypass: v });
  const setProxyFallbackEnabled = (v: boolean) => onChange({ proxyFallbackEnabled: v });
  const setProxyFallbackMode = (v: 'direct' | 'system') => onChange({ proxyFallbackMode: v });
  // 草稿：编辑中的值（保存前不写回父级 state）
  const { draft: proxyDraft, setDraft: setProxyDraft, isDirty: dirty, save: saveProxyDraft } = useDraftState({
    initial: { proxy: customProxy, user: proxyUsername, pass: proxyPassword, bypass: proxyBypass },
    onSave: async (d) => {
      await updateAppSettings({
        customProxy: d.proxy,
        proxyUsername: d.user,
        proxyPassword: d.pass,
        proxyBypass: d.bypass,
      });
      setCustomProxy(d.proxy);
      setProxyUsername(d.user);
      setProxyPassword(d.pass);
      setProxyBypass(d.bypass);
      // 即时生效
      await applyProxy();
    },
  });
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs?: number; message: string } | null>(null);

  // 当前生效代理描述
  const effectiveDesc =
    proxyMode === 'system'
      ? '跟随系统代理'
      : proxyMode === 'direct'
        ? '直连（不使用代理）'
        : customProxy.trim()
          ? customProxy.trim()
          : '未配置';

  const handleModeChange = async (mode: 'system' | 'direct' | 'custom') => {
    setProxyMode(mode);
    try {
      await updateAppSettings({ proxyMode: mode });
      await applyProxy();
    } catch (e) {
      console.error('保存代理模式失败:', e);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await saveProxyDraft();
    } catch (e) {
      console.error('保存代理配置失败:', e);
    } finally {
      setIsSaving(false);
    }
  };

  const handleTest = async () => {
    // 若有未保存修改，先保存再测试
    if (dirty) {
      await handleSave();
    }
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await testProxy();
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <section data-name="settings.proxy.section">
      <SectionTitle>区域与代理</SectionTitle>

      {/* 代理模式 */}
      <div className="proxy-section-block" data-name="settings.proxy.block">
        {/* 当前生效状态 */}
        <div className="proxy-status-row" data-name="settings.proxy.status-row">
          <span className={`proxy-status-dot mode-${proxyMode}`} data-name="settings.proxy.status-dot" />
          <span className="proxy-status-text" data-name="settings.proxy.status-text">{effectiveDesc}</span>
        </div>

        <SegmentedControl
          className="seg-control-row"
          name="proxy-mode"
          value={proxyMode}
          onChange={handleModeChange}
          options={[
            { value: 'system', label: '系统代理' },
            { value: 'direct', label: '直连' },
            { value: 'custom', label: '自定义' },
          ]}
        />

        {proxyMode === 'custom' && (
          <div className="proxy-custom-block" data-name="settings.proxy.custom-block">
            {/* 代理地址 */}
            <div className="proxy-field" data-name="settings.proxy.address-field">
              <label className="proxy-field-label" data-name="settings.proxy.address-label">代理地址</label>
              <input
                type="text"
                className="input-underline"
                placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:7891"
                value={proxyDraft.proxy}
                onChange={(e) => setProxyDraft({ ...proxyDraft, proxy: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && dirty) handleSave();
                }}
                data-name="settings.proxy.address-input"
              />
            </div>

            {/* 认证 */}
            <div className="proxy-field-row" data-name="settings.proxy.auth-row">
              <div className="proxy-field" data-name="settings.proxy.username-field">
                <label className="proxy-field-label" data-name="settings.proxy.username-label">用户名</label>
                <input
                  type="text"
                  className="input-underline"
                  placeholder="代理认证用户名"
                  value={proxyDraft.user}
                  onChange={(e) => setProxyDraft({ ...proxyDraft, user: e.target.value })}
                  autoComplete="off"
                  data-name="settings.proxy.username-input"
                />
              </div>
              <div className="proxy-field" data-name="settings.proxy.password-field">
                <label className="proxy-field-label" data-name="settings.proxy.password-label">密码</label>
                <input
                  type="password"
                  className="input-underline"
                  placeholder="代理认证密码"
                  value={proxyDraft.pass}
                  onChange={(e) => setProxyDraft({ ...proxyDraft, pass: e.target.value })}
                  autoComplete="off"
                  data-name="settings.proxy.password-input"
                />
              </div>
            </div>

            {/* 绕过列表 */}
            <div className="proxy-field" data-name="settings.proxy.bypass-field">
              <label className="proxy-field-label" data-name="settings.proxy.bypass-label">绕过列表</label>
              <input
                type="text"
                className="input-underline"
                placeholder="localhost,127.0.0.1,*.local,192.168.*"
                value={proxyDraft.bypass}
                onChange={(e) => setProxyDraft({ ...proxyDraft, bypass: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && dirty) handleSave();
                }}
                data-name="settings.proxy.bypass-input"
              />
            </div>

            {/* 操作按钮：保存仅修改时显示，测试始终可用 */}
            <div className="proxy-actions" data-name="settings.proxy.actions">
              {dirty && (
                <Button
                  variant="primary-compact"
                  className="proxy-save-btn btn-save-primary"
                  disabled={isSaving}
                  onClick={handleSave}
                  data-name="settings.proxy.save-button"
                >
                  {isSaving ? '保存中…' : '保存并生效'}
                </Button>
              )}
              <Button
                variant="outline"
                className="proxy-test-btn btn-secondary-underline"
                disabled={isTesting}
                onClick={handleTest}
                data-name="settings.proxy.test-button"
              >
                {isTesting ? '测试中…' : '测试连通性'}
              </Button>
            </div>

            {/* 测试结果 */}
            {testResult && (
              <div className={`proxy-test-result test-result ${testResult.ok ? 'ok' : 'fail'}`} data-name="settings.proxy.test-result">
                {testResult.ok ? '✓ ' : '✗ '}
                {testResult.message}
              </div>
            )}
          </div>
        )}

        {/* 代理失败兜底：custom 模式加载失败时自动切换到兜底模式 */}
        <div className="proxy-fallback-block" data-name="settings.proxy.fallback-block">
          <div className="proxy-fallback-header" data-name="settings.proxy.fallback-header">
            <div className="proxy-field-label" data-name="settings.proxy.fallback-label">代理失败兜底</div>
            <Toggle
              checked={proxyFallbackEnabled}
              onChange={async (checked) => {
                setProxyFallbackEnabled(checked);
                try {
                  await updateAppSettings({ proxyFallbackEnabled: checked });
                } catch (e) {
                  console.error('保存代理兜底开关失败:', e);
                }
              }}
              data-name="settings.proxy.fallback-toggle"
            />
          </div>
          {proxyFallbackEnabled && (
            <div className="proxy-fallback-mode" data-name="settings.proxy.fallback-mode-row">
              <label className="proxy-field-label" data-name="settings.proxy.fallback-mode-label">兜底模式</label>
              <SegmentedControl
                className="seg-control-row"
                name="proxy-fallback-mode"
                value={proxyFallbackMode}
                onChange={async (mode) => {
                  setProxyFallbackMode(mode);
                  try {
                    await updateAppSettings({ proxyFallbackMode: mode });
                  } catch (e) {
                    console.error('保存代理兜底模式失败:', e);
                  }
                }}
                options={[
                  { value: 'direct', label: '直连' },
                  { value: 'system', label: '系统代理' },
                ]}
              />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
