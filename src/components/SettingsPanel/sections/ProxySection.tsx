import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Button, SegmentedControl, Toggle } from '../../ui';
import { updateAppSettings, testProxy, applyProxy } from '../../../lib/electron-api';

interface ProxySectionProps {
  proxyMode: 'system' | 'direct' | 'custom';
  setProxyMode: Dispatch<SetStateAction<'system' | 'direct' | 'custom'>>;
  customProxy: string;
  setCustomProxy: Dispatch<SetStateAction<string>>;
  proxyUsername: string;
  setProxyUsername: Dispatch<SetStateAction<string>>;
  proxyPassword: string;
  setProxyPassword: Dispatch<SetStateAction<string>>;
  proxyBypass: string;
  setProxyBypass: Dispatch<SetStateAction<string>>;
  /** 代理失败兜底开关（custom 模式加载失败时自动切换） */
  proxyFallbackEnabled: boolean;
  setProxyFallbackEnabled: Dispatch<SetStateAction<boolean>>;
  /** 代理失败兜底模式：direct=直连 / system=系统代理 */
  proxyFallbackMode: 'direct' | 'system';
  setProxyFallbackMode: Dispatch<SetStateAction<'direct' | 'system'>>;
}

export default function ProxySection({
  proxyMode,
  setProxyMode,
  customProxy,
  setCustomProxy,
  proxyUsername,
  setProxyUsername,
  proxyPassword,
  setProxyPassword,
  proxyBypass,
  setProxyBypass,
  proxyFallbackEnabled,
  setProxyFallbackEnabled,
  proxyFallbackMode,
  setProxyFallbackMode,
}: ProxySectionProps) {
  // 草稿：编辑中的值（保存前不写回父级 state）
  const [draftProxy, setDraftProxy] = useState(customProxy);
  const [draftUser, setDraftUser] = useState(proxyUsername);
  const [draftPass, setDraftPass] = useState(proxyPassword);
  const [draftBypass, setDraftBypass] = useState(proxyBypass);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs?: number; message: string } | null>(null);

  // 是否有未保存的修改
  const dirty =
    draftProxy !== customProxy ||
    draftUser !== proxyUsername ||
    draftPass !== proxyPassword ||
    draftBypass !== proxyBypass;

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
      await updateAppSettings({
        customProxy: draftProxy,
        proxyUsername: draftUser,
        proxyPassword: draftPass,
        proxyBypass: draftBypass,
      });
      setCustomProxy(draftProxy);
      setProxyUsername(draftUser);
      setProxyPassword(draftPass);
      setProxyBypass(draftBypass);
      // 即时生效
      await applyProxy();
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
      <div className="settings-section-title" data-name="settings.proxy.title">区域与代理</div>

      {/* 代理模式 */}
      <div className="proxy-section-block" data-name="settings.proxy.block">
        <div className="voice-config-name proxy-section-subtitle" data-name="settings.proxy.subtitle">
          网络代理
        </div>

        {/* 当前生效状态 */}
        <div className="proxy-status-row" data-name="settings.proxy.status-row">
          <span className={`proxy-status-dot mode-${proxyMode}`} data-name="settings.proxy.status-dot" />
          <span className="proxy-status-text" data-name="settings.proxy.status-text">{effectiveDesc}</span>
        </div>

        <SegmentedControl
          className="proxy-mode-group"
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
                className="proxy-input"
                placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:7891"
                value={draftProxy}
                onChange={(e) => setDraftProxy(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && dirty) handleSave();
                }}
                data-name="settings.proxy.address-input"
              />
            </div>

            {/* 认证（可选） */}
            <div className="proxy-field-row" data-name="settings.proxy.auth-row">
              <div className="proxy-field" data-name="settings.proxy.username-field">
                <label className="proxy-field-label" data-name="settings.proxy.username-label">用户名（可选）</label>
                <input
                  type="text"
                  className="proxy-input"
                  placeholder="代理认证用户名"
                  value={draftUser}
                  onChange={(e) => setDraftUser(e.target.value)}
                  autoComplete="off"
                  data-name="settings.proxy.username-input"
                />
              </div>
              <div className="proxy-field" data-name="settings.proxy.password-field">
                <label className="proxy-field-label" data-name="settings.proxy.password-label">密码（可选）</label>
                <input
                  type="password"
                  className="proxy-input"
                  placeholder="代理认证密码"
                  value={draftPass}
                  onChange={(e) => setDraftPass(e.target.value)}
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
                className="proxy-input"
                placeholder="localhost,127.0.0.1,*.local,192.168.*"
                value={draftBypass}
                onChange={(e) => setDraftBypass(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && dirty) handleSave();
                }}
                data-name="settings.proxy.bypass-input"
              />
              <div className="proxy-hint" data-name="settings.proxy.bypass-hint">逗号分隔的域名不走代理，留空则全部走代理</div>
            </div>

            {/* 操作按钮：保存仅修改时显示，测试始终可用 */}
            <div className="proxy-actions" data-name="settings.proxy.actions">
              {dirty && (
                <Button
                  variant="primary-compact"
                  className="proxy-save-btn"
                  disabled={isSaving}
                  onClick={handleSave}
                  data-name="settings.proxy.save-button"
                >
                  {isSaving ? '保存中…' : '保存并生效'}
                </Button>
              )}
              <Button
                variant="text"
                className="proxy-test-btn"
                disabled={isTesting}
                onClick={handleTest}
                data-name="settings.proxy.test-button"
              >
                {isTesting ? '测试中…' : '测试连通性'}
              </Button>
            </div>

            {/* 测试结果 */}
            {testResult && (
              <div className={`proxy-test-result ${testResult.ok ? 'ok' : 'fail'}`} data-name="settings.proxy.test-result">
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
          <div className="proxy-hint" data-name="settings.proxy.fallback-hint">
            自定义代理加载失败时，自动切换到兜底模式重新加载（仅临时切换，不修改设置）
          </div>
          {proxyFallbackEnabled && (
            <div className="proxy-fallback-mode" data-name="settings.proxy.fallback-mode-row">
              <label className="proxy-field-label" data-name="settings.proxy.fallback-mode-label">兜底模式</label>
              <SegmentedControl
                className="proxy-mode-group"
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
