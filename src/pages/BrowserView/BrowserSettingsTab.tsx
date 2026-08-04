/* =====================================================================
   pages/BrowserView/BrowserSettingsTab.tsx —— 精简设置标签页
   内部页面（类似 chrome://settings），浏览器窗口内作为标签页渲染。
   ===================================================================== */

import { useCallback, useEffect, useState } from 'react';
import type { Profile } from '../../lib/electron-api';
import {
  getAppSettings,
  updateAppSettings,
  testProxy,
  listBlockRules,
  selectDownloadDir,
  openDownloadDir,
  listPresets,
} from '../../lib/electron-api';
import type { AppSettings, BlockRule, DevicePreset } from '../../lib/electron-api';
import { AI_PLATFORMS } from '../../../electron/presets/ai-platforms';
import { WIN_CHROME_UA } from '../../../electron/presets/devices';

interface BrowserSettingsTabProps {
  profile: Profile;
}

export default function BrowserSettingsTab({ profile }: BrowserSettingsTabProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [blockRules, setBlockRules] = useState<BlockRule[]>([]);
  const [proxyTestResult, setProxyTestResult] = useState<string>('');
  const [proxyTesting, setProxyTesting] = useState(false);
  const [presets, setPresets] = useState<DevicePreset[]>([]);
  const [currentDesktopPresetId, setCurrentDesktopPresetId] = useState<string>('win-chrome-125');

  useEffect(() => {
    void getAppSettings().then(setSettings);
    void listBlockRules().then((rules) => {
      const hostname = profile.aiPlatformUrl ? new URL(profile.aiPlatformUrl).hostname : '';
      setBlockRules(rules.filter((r) => !hostname || matchDomain(r.domainPattern, hostname)));
    });
    // 加载设备预设列表
    void listPresets().then((allPresets) => {
      setPresets(allPresets.filter((p) => p.platform === 'desktop'));
    });
    // 获取当前使用的桌面端预设 ID
    const platform = profile.aiPlatformId
      ? AI_PLATFORMS.find((p) => p.id === profile.aiPlatformId)
      : undefined;
    setCurrentDesktopPresetId(platform?.defaultDesktopPreset ?? 'win-chrome-125');
  }, [profile.aiPlatformUrl, profile.aiPlatformId]);

  const handleProxyTest = useCallback(async () => {
    setProxyTesting(true);
    setProxyTestResult('');
    try {
      const result = await testProxy();
      setProxyTestResult(result.message);
    } catch (e) {
      setProxyTestResult(`测试失败: ${e}`);
    }
    setProxyTesting(false);
  }, []);

  const handleSelectDownloadDir = useCallback(async () => {
    const dir = await selectDownloadDir();
    if (dir) {
      void updateAppSettings({ downloadDir: dir });
      setSettings((s) => s ? { ...s, downloadDir: dir } : s);
    }
  }, []);

  if (!settings) return <div className="browser-settings-loading" data-name="browser.settings-loading">加载中...</div>;

  return (
    <div className="browser-settings" data-name="browser.settings.container">
      <h2 className="browser-settings-title" data-name="browser.settings.title">浏览器设置</h2>

      {/* UA Section */}
      <section className="browser-settings-section" data-name="browser.settings.ua-section">
        <h3>User-Agent</h3>
        <div className="browser-setting-item" data-name="browser.settings.ua-preset">
          <span className="browser-setting-label">UA 预设</span>
          <select
            className="browser-setting-select"
            value={currentDesktopPresetId}
            onChange={(e) => {
              const presetId = e.target.value;
              setCurrentDesktopPresetId(presetId);
            }}
          >
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.name}</option>
            ))}
          </select>
        </div>
        <div className="browser-setting-hint" data-name="browser.settings.ua-hint">
          {presets.find((p) => p.id === currentDesktopPresetId)?.userAgent || WIN_CHROME_UA}
        </div>
      </section>

      {/* Proxy Section */}
      <section className="browser-settings-section" data-name="browser.settings.proxy-section">
        <h3>代理设置</h3>
        <div className="browser-setting-item" data-name="browser.settings.proxy-mode">
          <span className="browser-setting-label">代理模式</span>
          <select
            className="browser-setting-select"
            value={settings.proxyMode}
            onChange={(e) => {
              const mode = e.target.value as AppSettings['proxyMode'];
              void updateAppSettings({ proxyMode: mode });
              setSettings((s) => s ? { ...s, proxyMode: mode } : s);
            }}
          >
            <option value="system">系统代理</option>
            <option value="direct">直连</option>
            <option value="custom">自定义</option>
          </select>
        </div>
        {settings.proxyMode === 'custom' && (
          <div className="browser-setting-item" data-name="browser.settings.proxy-addr">
            <span className="browser-setting-label">代理地址</span>
            <input
              className="browser-setting-input"
              type="text"
              value={settings.customProxy || ''}
              placeholder="socks5://127.0.0.1:1080"
              onChange={(e) => {
                void updateAppSettings({ customProxy: e.target.value });
                setSettings((s) => s ? { ...s, customProxy: e.target.value } : s);
              }}
            />
          </div>
        )}
        <div className="browser-setting-item" data-name="browser.settings.proxy-test">
          <button
            type="button"
            className="btn-primary-compact"
            onClick={() => void handleProxyTest()}
            disabled={proxyTesting}
          >
            {proxyTesting ? '测试中...' : '测试连通性'}
          </button>
          {proxyTestResult && <span className="browser-setting-hint" data-name="browser.settings-test-result">{proxyTestResult}</span>}
        </div>
      </section>

      {/* Download Section */}
      <section className="browser-settings-section" data-name="browser.settings.download-section">
        <h3>下载设置</h3>
        <div className="browser-setting-item" data-name="browser.settings.download-dir">
          <span className="browser-setting-label">下载目录</span>
          <code className="browser-setting-value">{settings.downloadDir || '默认下载目录'}</code>
          <button type="button" className="btn-outline-compact" onClick={() => void handleSelectDownloadDir()}>更改</button>
          <button type="button" className="btn-outline-compact" onClick={() => void openDownloadDir()}>打开</button>
        </div>
        <div className="browser-setting-item" data-name="browser.settings.download-behavior">
          <span className="browser-setting-label">下载行为</span>
          <select
            className="browser-setting-select"
            value={settings.downloadBehavior || 'auto'}
            onChange={(e) => {
              const behavior = e.target.value as 'auto' | 'ask';
              void updateAppSettings({ downloadBehavior: behavior });
              setSettings((s) => s ? { ...s, downloadBehavior: behavior } : s);
            }}
          >
            <option value="auto">自动保存</option>
            <option value="ask">每次询问</option>
          </select>
        </div>
      </section>

      {/* Block Rules Section */}
      <section className="browser-settings-section" data-name="browser.settings.block-rules-section">
        <h3>屏蔽规则</h3>
        <p className="browser-setting-hint" data-name="browser.settings-desc">
          当前平台域名: {profile.aiPlatformUrl ? new URL(profile.aiPlatformUrl).hostname : '未设置'}
        </p>
        {blockRules.length === 0 ? (
          <p className="browser-setting-hint" data-name="browser.settings-empty">无匹配规则</p>
        ) : (
          <ul className="browser-settings-list" data-name="browser.settings-list">
            {blockRules.map((rule) => (
              <li key={rule.id}>
                <code>{rule.domainPattern}</code> — {rule.selector || '无选择器'}
                <span data-name="browser.rule-status" className={`rule-status ${rule.enabled ? 'enabled' : 'disabled'}`}>
                  {rule.enabled ? '启用' : '禁用'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Region Info */}
      <section className="browser-settings-section" data-name="browser.settings.region-section">
        <h3>区域设置</h3>
        <div className="browser-setting-item" data-name="browser.settings.region">
          <span className="browser-setting-label">AI 平台区域</span>
          <span className="browser-setting-value">{profile.aiPlatformRegion === 'cn' ? '国内' : profile.aiPlatformRegion === 'global' ? '国外' : '未设置'}</span>
        </div>
      </section>
    </div>
  );
}

/** 简单域名匹配 */
function matchDomain(pattern: string, hostname: string): boolean {
  if (pattern === hostname) return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return hostname.endsWith(suffix) || hostname === suffix.slice(1);
  }
  return false;
}
