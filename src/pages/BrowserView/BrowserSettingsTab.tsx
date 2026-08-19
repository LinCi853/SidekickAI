/* =====================================================================
   pages/BrowserView/BrowserSettingsTab.tsx —— 浏览器设置标签页
    内部页面（类似 chrome://settings），浏览器窗口内作为标签页渲染。
    视觉系统：Google Material 3 风格 —— 居中内容列 + 卡片分组 + 行式条目。
    复用 SectionTitle / FormRow / Button / input-underline 等共享组件与设计令牌。
   ===================================================================== */

import { useCallback, useEffect, useState } from 'react';
import type { Profile } from '../../lib/electron-api';
import {
  getAppSettings,
  updateAppSettings,
  listBlockRules,
  selectDownloadDir,
  openDownloadDir,
  listPresets,
  startHotkeyRecording,
  stopHotkeyRecording,
  onHotkeyRecordingResult,
  onHotkeyRecordingPartial,
  setProfileShortcut,
} from '../../lib/electron-api';
import type { AppSettings, BlockRule, DevicePreset } from '../../lib/electron-api';
import { AI_PLATFORMS } from '../../../electron/presets/ai-platforms';
import { WIN_CHROME_UA } from '../../../electron/presets/devices';
import ProxySection from '../../components/SettingsPanel/sections/ProxySection';
import type { ProxySettings } from '../../components/SettingsPanel/types';
import { useProfileStore } from '../../store/useProfileStore';
import { useCloudPcStore } from '../../store/useCloudPcStore';
import HotkeyRecorder from '../../components/ui/HotkeyRecorder';
import { Button, FormRow, SectionTitle } from '../../components/ui';
import './BrowserSettingsTab.css';

/** G1：搜索引擎预设清单（自定义模式允许用户手动输入 name 和 urlTemplate） */
const SEARCH_ENGINE_PRESETS = [
  { name: 'Bing', urlTemplate: 'https://www.bing.com/search?q={query}' },
  { name: 'Google', urlTemplate: 'https://www.google.com/search?q={query}' },
  { name: '百度', urlTemplate: 'https://www.baidu.com/s?wd={query}' },
  { name: 'DuckDuckGo', urlTemplate: 'https://duckduckgo.com/?q={query}' },
];

interface BrowserSettingsTabProps {
  profile: Profile;
}

export default function BrowserSettingsTab({ profile }: BrowserSettingsTabProps) {
  // 云电脑模式状态（开关触发 BrowserView 的 cloud-pc-toggle 统一入口）
  const isCloudPc = useCloudPcStore((s) => s.isActive);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [blockRules, setBlockRules] = useState<BlockRule[]>([]);
  const [presets, setPresets] = useState<DevicePreset[]>([]);
  const [currentDesktopPresetId, setCurrentDesktopPresetId] = useState<string>('win-chrome-125');
  // G1：搜索引擎模式下拉值（preset 名称或 'custom'），独立于 settings 以支持"选中自定义但保留当前值"
  const [searchEngineMode, setSearchEngineMode] = useState<string>('Bing');

  // 订阅 useProfileStore 以获取实时 profile（跨窗口同步 proxyConfig 变更）
  const liveProfile = useProfileStore((s) => s.profiles.find((p) => p.id === profile.id)) ?? profile;
  const updateProfile = useProfileStore((s) => s.updateProfile);
  // 代理本地状态：从 profile.proxyConfig 初始化，未配置时回退到全局 AppSettings
  const [proxyState, setProxyState] = useState<ProxySettings>({
    proxyMode: 'system',
    customProxy: '',
    proxyUsername: '',
    proxyPassword: '',
    proxyBypass: '',
    proxyFallbackEnabled: false,
    proxyFallbackMode: 'direct',
  });
  const proxyConfigKey = JSON.stringify(liveProfile.proxyConfig);

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

  // G1：根据当前设置同步搜索引擎下拉模式（匹配预设则显示预设名，否则为自定义）
  useEffect(() => {
    const se = settings?.defaultSearchEngine;
    if (!se) {
      setSearchEngineMode('Bing');
      return;
    }
    const match = SEARCH_ENGINE_PRESETS.find(
      (p) => p.name === se.name && p.urlTemplate === se.urlTemplate,
    );
    setSearchEngineMode(match ? match.name : 'custom');
  }, [settings?.defaultSearchEngine]);

  // 同步代理本地状态：profile.proxyConfig 优先，未配置时回退到全局 AppSettings
  // 依赖 proxyConfigKey（序列化值）以避免对象引用频繁变化导致重置
  useEffect(() => {
    if (!settings) return;
    const pc = liveProfile.proxyConfig;
    setProxyState({
      proxyMode: pc?.proxyMode ?? settings.proxyMode,
      customProxy: pc?.customProxy ?? settings.customProxy,
      proxyUsername: pc?.proxyUsername ?? settings.proxyUsername ?? '',
      proxyPassword: pc?.proxyPassword ?? settings.proxyPassword ?? '',
      proxyBypass: pc?.proxyBypass ?? settings.proxyBypass ?? '',
      proxyFallbackEnabled: pc?.proxyFallbackEnabled ?? settings.proxyFallbackEnabled ?? false,
      proxyFallbackMode: pc?.proxyFallbackMode ?? settings.proxyFallbackMode ?? 'direct',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, proxyConfigKey]);

  const handleProxyChange = useCallback((patch: Partial<ProxySettings>) => {
    setProxyState((s) => ({ ...s, ...patch }));
  }, []);

  const handleSelectDownloadDir = useCallback(async () => {
    const dir = await selectDownloadDir();
    if (dir) {
      void updateAppSettings({ downloadDir: dir });
      setSettings((s) => s ? { ...s, downloadDir: dir } : s);
    }
  }, []);

  // ===== 浏览器窗口脱离/回归快捷键（每应用独立，默认无快捷键） =====
  // 草稿值：从 liveProfile.browserWindowShortcut 初始化（undefined=无快捷键）
  const [shortcutDraft, setShortcutDraft] = useState<string>('');
  const shortcutSourceKey = liveProfile.browserWindowShortcut ?? '';

  useEffect(() => {
    setShortcutDraft(liveProfile.browserWindowShortcut ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shortcutSourceKey]);

  /** 录制新快捷键 → 持久化到 Profile 并重注册 */
  const handleShortcutRecord = useCallback(
    (accelerator: string) => {
      setShortcutDraft(accelerator);
      void setProfileShortcut(profile.id, accelerator).catch((e) => {
        console.error('[BrowserSettingsTab] 保存快捷键失败:', e);
      });
    },
    [profile.id],
  );

  /** 清除快捷键 → 持久化 null 到 Profile 并重注册 */
  const handleShortcutClear = useCallback(() => {
    setShortcutDraft('');
    void setProfileShortcut(profile.id, null).catch((e) => {
      console.error('[BrowserSettingsTab] 清除快捷键失败:', e);
    });
  }, [profile.id]);

  // ===== 浏览器主页 URL（与 AI 应用编辑器双向同步 Profile.browserHomePage） =====
  // 草稿值：从 liveProfile.browserHomePage 初始化；失焦/回车时写回 Profile。
  const [homePageDraft, setHomePageDraft] = useState<string>('');
  const homePageSourceKey = liveProfile.browserHomePage ?? '';

  useEffect(() => {
    setHomePageDraft(liveProfile.browserHomePage ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homePageSourceKey]);

  /** 提交主页 URL 到 Profile（空值存 undefined，回退到平台 URL） */
  const handleHomePageCommit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      void updateProfile(profile.id, {
        browserHomePage: trimmed || undefined,
      }).catch((e) => {
        console.error('[BrowserSettingsTab] 保存浏览器主页失败:', e);
      });
    },
    [profile.id, updateProfile],
  );

  if (!settings) {
    return (
      <div
        className="browser-settings-page"
        data-name="browser.settings-loading"
      >
        <div className="browser-settings-loading-text" data-name="browser.settings-loading-text">
          加载中...
        </div>
      </div>
    );
  }

  return (
    <div
      className="browser-settings-page"
      data-name="browser.settings.container"
    >
      <div
        className="browser-settings-scroll"
        data-name="browser.settings.scroll-body"
      >
        <h1
          className="browser-settings-title"
          data-name="browser.settings.title"
        >
          浏览器设置
        </h1>

        {/* Homepage Section —— 浏览器主页 URL（与 AI 应用编辑器双向同步 Profile.browserHomePage） */}
        <section className="browser-settings-card" data-name="browser.settings.homepage-section">
          <SectionTitle>浏览器主页</SectionTitle>
          <FormRow label="浏览器主页 URL" hint="留空则使用平台 URL">
            <input
              type="text"
              className="input-underline browser-settings-input"
              value={homePageDraft}
              placeholder={profile.aiPlatformUrl || 'https://...'}
              onChange={(e) => setHomePageDraft(e.target.value)}
              onBlur={(e) => handleHomePageCommit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              data-name="browser.settings.homepage-input"
            />
          </FormRow>
        </section>

        {/* Cloud PC Section —— 云电脑模式入口（设置内单独打开） */}
        <section className="browser-settings-card" data-name="browser.settings.cloud-pc-section">
          <SectionTitle>云电脑模式</SectionTitle>
          <p className="browser-settings-hint" data-name="browser.settings.cloud-pc-desc">
            为云电脑 / 云游戏网页提供专用环境：进入沉浸式全屏、系统级与浏览器级快捷键
            直通远端（Win / Alt+Tab / Win+Tab / Win+D / Alt+F4 会路由到云电脑）、
            自动匹配远端分辨率（4K 屏跑 1080P 云电脑自动放大铺满，防止误切移动端布局）。
            退出方式：顶部悬浮条 / Ctrl+Alt+C / 三连击 Esc / Ctrl+Alt+Shift+F12。
          </p>
          <FormRow label="云电脑模式" hint={isCloudPc ? '当前已开启' : '当前未开启'}>
            <button
              type="button"
              className={'browser-settings-cloud-pc-btn' + (isCloudPc ? ' is-on' : '')}
              onClick={() => window.dispatchEvent(new CustomEvent('cloud-pc-toggle'))}
              data-name="browser.settings.cloud-pc-toggle"
            >
              {isCloudPc ? '退出云电脑模式' : '开启云电脑模式'}
            </button>
          </FormRow>
        </section>

        {/* UA Section */}
        <section className="browser-settings-card" data-name="browser.settings.ua-section">
          <SectionTitle>User-Agent</SectionTitle>
          <FormRow label="UA 预设">
            <select
              className="input-underline browser-settings-select"
              value={currentDesktopPresetId}
              onChange={(e) => {
                const presetId = e.target.value;
                setCurrentDesktopPresetId(presetId);
              }}
              data-name="browser.settings.ua-preset-select"
            >
              {presets.map((preset, idx) => (
                <option key={preset.id} value={preset.id} data-name={'browser.settings.ua-preset-option-' + (idx + 1)}>{preset.name}</option>
              ))}
            </select>
          </FormRow>
          <p className="browser-settings-hint browser-settings-hint-mono" data-name="browser.settings.ua-hint">
            {presets.find((p) => p.id === currentDesktopPresetId)?.userAgent || WIN_CHROME_UA}
          </p>
        </section>

        {/* Search Engine Section (G1) */}
        <section className="browser-settings-card" data-name="browser.settings.search-engine-section">
          <SectionTitle>搜索引擎</SectionTitle>
          <FormRow label="默认搜索引擎">
            <select
              className="input-underline browser-settings-select"
              value={searchEngineMode}
              onChange={(e) => {
                const val = e.target.value;
                if (val === 'custom') {
                  setSearchEngineMode('custom');
                  return;
                }
                const preset = SEARCH_ENGINE_PRESETS.find((p) => p.name === val);
                if (preset) {
                  setSearchEngineMode(preset.name);
                  void updateAppSettings({
                    defaultSearchEngine: { name: preset.name, urlTemplate: preset.urlTemplate },
                  });
                  setSettings((s) => (s ? { ...s, defaultSearchEngine: { name: preset.name, urlTemplate: preset.urlTemplate } } : s));
                }
              }}
              data-name="browser.settings.search-engine-select"
            >
              {SEARCH_ENGINE_PRESETS.map((p, idx) => (
                <option key={p.name} value={p.name} data-name={'browser.settings.search-engine-option-' + (idx + 1)}>{p.name}</option>
              ))}
              <option value="custom" data-name="browser.settings.search-engine-option-custom">自定义</option>
            </select>
          </FormRow>
          {searchEngineMode === 'custom' && (
            <>
              <FormRow label="名称">
                <input
                  className="input-underline browser-settings-input"
                  type="text"
                  value={settings.defaultSearchEngine?.name ?? ''}
                  placeholder="Bing"
                  onChange={(e) => {
                    const name = e.target.value;
                    const urlTemplate = settings.defaultSearchEngine?.urlTemplate ?? 'https://www.bing.com/search?q={query}';
                    void updateAppSettings({ defaultSearchEngine: { name, urlTemplate } });
                    setSettings((s) => (s ? { ...s, defaultSearchEngine: { name, urlTemplate } } : s));
                  }}
                  data-name="browser.settings.search-engine-name-input"
                />
              </FormRow>
              <FormRow label="URL 模板">
                <input
                  className="input-underline browser-settings-input"
                  type="text"
                  value={settings.defaultSearchEngine?.urlTemplate ?? ''}
                  placeholder="https://www.bing.com/search?q={query}"
                  onChange={(e) => {
                    const urlTemplate = e.target.value;
                    const name = settings.defaultSearchEngine?.name ?? 'Bing';
                    void updateAppSettings({ defaultSearchEngine: { name, urlTemplate } });
                    setSettings((s) => (s ? { ...s, defaultSearchEngine: { name, urlTemplate } } : s));
                  }}
                  data-name="browser.settings.search-engine-url-input"
                />
              </FormRow>
              <p className="browser-settings-hint" data-name="browser.settings.search-engine-hint">
                使用 {'{query}'} 作为搜索词占位符，例如 https://www.bing.com/search?q={'{query}'}
              </p>
            </>
          )}
        </section>

        {/* Proxy Section —— 当前 AI 应用窗口独立代理配置（Profile.proxyConfig）
            ProxySection 内部已自带 SectionTitle，无需再外层重复标题（与主窗口设置面板一致） */}
        <section className="browser-settings-card" data-name="browser.settings.proxy-section">
          <ProxySection
            proxy={proxyState}
            onChange={handleProxyChange}
            scope="profile"
            profileId={profile.id}
          />
        </section>

        {/* Shortcut Section —— 当前 AI 应用浏览器窗口脱离/回归快捷键（Profile.browserWindowShortcut） */}
        <section className="browser-settings-card" data-name="browser.settings.shortcut-section">
          <SectionTitle>窗口快捷键</SectionTitle>
          <p className="browser-settings-hint" data-name="browser.settings.shortcut-hint">
            按下该快捷键可将当前 AI 应用在主窗口与独立浏览器窗口之间快速脱离/回归（系统级全局快捷键，应用未聚焦也生效）。默认无快捷键。
          </p>
          <FormRow label="脱离/回归快捷键">
            <HotkeyRecorder
              value={shortcutDraft}
              placeholder="未设置（点击录制）"
              className="input-underline"
              onRecord={handleShortcutRecord}
              otherHotkeys={[]}
              startRecording={startHotkeyRecording}
              stopRecording={stopHotkeyRecording}
              onRecordingResult={onHotkeyRecordingResult}
              onRecordingPartial={onHotkeyRecordingPartial}
            />
            {shortcutDraft && (
              <Button
                variant="outline"
                onClick={handleShortcutClear}
                data-name="browser.settings.shortcut-clear-button"
              >
                清除
              </Button>
            )}
          </FormRow>
        </section>

        {/* Download Section */}
        <section className="browser-settings-card" data-name="browser.settings.download-section">
          <SectionTitle>下载设置</SectionTitle>
          <FormRow label="下载目录">
            <code
              className="browser-settings-dir"
              data-name="browser.settings.download-dir-value"
            >
              {settings.downloadDir || '默认下载目录'}
            </code>
            <Button variant="outline" onClick={() => void handleSelectDownloadDir()} data-name="browser.settings.download-dir-change">更改</Button>
            <Button variant="outline" onClick={() => void openDownloadDir()} data-name="browser.settings.download-dir-open">打开</Button>
          </FormRow>
          <FormRow label="下载行为">
            <select
              className="input-underline browser-settings-select"
              value={settings.downloadBehavior || 'auto'}
              onChange={(e) => {
                const behavior = e.target.value as 'auto' | 'ask';
                void updateAppSettings({ downloadBehavior: behavior });
                setSettings((s) => s ? { ...s, downloadBehavior: behavior } : s);
              }}
              data-name="browser.settings.download-behavior-select"
            >
              <option value="auto" data-name="browser.settings.download-behavior-option-auto">自动保存</option>
              <option value="ask" data-name="browser.settings.download-behavior-option-ask">每次询问</option>
            </select>
          </FormRow>
        </section>

        {/* Tab Persistence Section */}
        <section className="browser-settings-card" data-name="browser.settings.tab-persistence-section">
          <SectionTitle>标签管理</SectionTitle>
          <FormRow label="标签累积持久化">
            <select
              className="input-underline browser-settings-select"
              value={settings.browserTabPersistence ?? 'memory'}
              onChange={(e) => {
                const mode = e.target.value as 'memory' | 'persistent';
                void updateAppSettings({ browserTabPersistence: mode });
                setSettings((s) => s ? { ...s, browserTabPersistence: mode } : s);
              }}
              data-name="browser.settings.tab-persistence-select"
            >
              <option value="memory" data-name="browser.settings.tab-persistence-option-memory">内存模式（仅本次会话）</option>
              <option value="persistent" data-name="browser.settings.tab-persistence-option-persistent">持久化模式（重启后保留）</option>
            </select>
          </FormRow>
          <p className="browser-settings-hint" data-name="browser.settings.tab-persistence-hint">
            AI 应用内点击新窗口链接时累积的标签，关闭独立窗口后是否保留
          </p>
        </section>

        {/* Block Rules Section */}
        <section className="browser-settings-card" data-name="browser.settings.block-rules-section">
          <SectionTitle>屏蔽规则</SectionTitle>
          <p className="browser-settings-hint" data-name="browser.settings-desc">
            当前平台域名: {profile.aiPlatformUrl ? new URL(profile.aiPlatformUrl).hostname : '未设置'}
          </p>
          {blockRules.length === 0 ? (
            <p className="browser-settings-hint browser-settings-empty-hint" data-name="browser.settings-empty">无匹配规则</p>
          ) : (
            <ul
              className="browser-settings-rules"
              data-name="browser.settings-list"
            >
              {blockRules.map((rule) => (
                <li
                  key={rule.id}
                  className="browser-settings-rule"
                  data-name="browser.settings-rule-item"
                >
                  <code
                    className="browser-settings-rule-domain"
                    data-name="browser.settings-rule-domain"
                  >
                    {rule.domainPattern}
                  </code>
                  <span className="browser-settings-rule-selector" data-name="browser.settings-rule-selector">
                    {' — '}{rule.selector || '无选择器'}
                  </span>
                  <span
                    data-name="browser.rule-status"
                    className={'rule-status ' + (rule.enabled ? 'enabled' : 'disabled')}
                  >
                    {rule.enabled ? '启用' : '禁用'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Region Info */}
        <section
          className="browser-settings-card"
          data-name="browser.settings.region-section"
        >
          <SectionTitle>区域设置</SectionTitle>
          <FormRow label="AI 平台区域">
            <span className="browser-settings-region-value" data-name="browser.settings.region-value">
              {profile.aiPlatformRegion === 'cn' ? '国内' : profile.aiPlatformRegion === 'global' ? '国外' : '未设置'}
            </span>
          </FormRow>
        </section>
      </div>

      {/* Sticky action bar —— 设置自动保存，此处为底部固定提示区，保证布局可滚动且底部留出操作位 */}
      <div
        className="browser-settings-footer"
        data-name="browser.settings.footer"
      >
        <span className="browser-settings-footer-text" data-name="browser.settings.footer-text">
          设置自动保存
        </span>
      </div>
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
