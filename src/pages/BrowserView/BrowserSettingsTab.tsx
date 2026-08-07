/* =====================================================================
   pages/BrowserView/BrowserSettingsTab.tsx —— 精简设置标签页
   内部页面（类似 chrome://settings），浏览器窗口内作为标签页渲染。
   视觉系统与主窗口 SettingsPanel 对齐：复用 SectionTitle / FormRow / Button
   与 input-underline 等共享组件与设计令牌。
   ===================================================================== */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
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
import HotkeyRecorder from '../../components/ui/HotkeyRecorder';
import { Button, FormRow, SectionTitle } from '../../components/ui';

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

  // ===== 浏览器窗口开关快捷键（每应用独立，默认无快捷键） =====
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
        data-name="browser.settings-loading"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--text-muted)',
          fontSize: 'var(--text-base)',
        }}
      >
        加载中...
      </div>
    );
  }

  // 分区统一样式：与主窗口设置面板对齐的间距与分隔线
  const sectionStyle: CSSProperties = {
    marginBottom: 'var(--space-6)',
    paddingBottom: 'var(--space-6)',
    borderBottom: '1px solid var(--glass-bd-2)',
  };
  // 辅助说明文本样式（替代 browser-setting-hint）
  const hintStyle: CSSProperties = {
    fontSize: 'var(--text-xs)',
    color: 'var(--text-muted)',
    margin: 'var(--space-1) 0 0',
    padding: '0 var(--space-2)',
    wordBreak: 'break-all',
    lineHeight: 1.5,
  };

  return (
    <div
      data-name="browser.settings.container"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        maxWidth: '640px',
        margin: '0 auto',
        color: 'var(--foreground)',
        fontFamily: 'var(--font-sans, system-ui, sans-serif)',
      }}
    >
      <div
        data-name="browser.settings.scroll-body"
        style={{ flex: '1 1 auto', overflowY: 'auto', padding: 'var(--space-6) var(--space-8)' }}
      >
        <h2
          style={{ fontSize: 'var(--text-xl)', fontWeight: 700, margin: '0 0 var(--space-6)' }}
          data-name="browser.settings.title"
        >
          浏览器设置
        </h2>

        {/* Homepage Section —— 浏览器主页 URL（与 AI 应用编辑器双向同步 Profile.browserHomePage） */}
        <section style={sectionStyle} data-name="browser.settings.homepage-section">
          <SectionTitle>浏览器主页</SectionTitle>
          <FormRow label="浏览器主页 URL" hint="留空则使用平台 URL">
            <input
              type="text"
              className="input-underline"
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

        {/* UA Section */}
        <section style={sectionStyle} data-name="browser.settings.ua-section">
          <SectionTitle>User-Agent</SectionTitle>
          <FormRow label="UA 预设">
            <select
              className="input-underline"
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
          </FormRow>
          <p style={hintStyle} data-name="browser.settings.ua-hint">
            {presets.find((p) => p.id === currentDesktopPresetId)?.userAgent || WIN_CHROME_UA}
          </p>
        </section>

        {/* Search Engine Section (G1) */}
        <section style={sectionStyle} data-name="browser.settings.search-engine-section">
          <SectionTitle>搜索引擎</SectionTitle>
          <FormRow label="默认搜索引擎">
            <select
              className="input-underline"
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
            >
              {SEARCH_ENGINE_PRESETS.map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
              <option value="custom">自定义</option>
            </select>
          </FormRow>
          {searchEngineMode === 'custom' && (
            <>
              <FormRow label="名称">
                <input
                  className="input-underline"
                  type="text"
                  value={settings.defaultSearchEngine?.name ?? ''}
                  placeholder="Bing"
                  onChange={(e) => {
                    const name = e.target.value;
                    const urlTemplate = settings.defaultSearchEngine?.urlTemplate ?? 'https://www.bing.com/search?q={query}';
                    void updateAppSettings({ defaultSearchEngine: { name, urlTemplate } });
                    setSettings((s) => (s ? { ...s, defaultSearchEngine: { name, urlTemplate } } : s));
                  }}
                />
              </FormRow>
              <FormRow label="URL 模板">
                <input
                  className="input-underline"
                  type="text"
                  value={settings.defaultSearchEngine?.urlTemplate ?? ''}
                  placeholder="https://www.bing.com/search?q={query}"
                  onChange={(e) => {
                    const urlTemplate = e.target.value;
                    const name = settings.defaultSearchEngine?.name ?? 'Bing';
                    void updateAppSettings({ defaultSearchEngine: { name, urlTemplate } });
                    setSettings((s) => (s ? { ...s, defaultSearchEngine: { name, urlTemplate } } : s));
                  }}
                />
              </FormRow>
              <p style={hintStyle} data-name="browser.settings.search-engine-hint">
                使用 {'{query}'} 作为搜索词占位符，例如 https://www.bing.com/search?q={'{query}'}
              </p>
            </>
          )}
        </section>

        {/* Proxy Section —— 当前 AI 应用窗口独立代理配置（Profile.proxyConfig）
            ProxySection 内部已自带 SectionTitle，无需再外层重复标题（与主窗口设置面板一致） */}
        <section style={sectionStyle} data-name="browser.settings.proxy-section">
          <ProxySection
            proxy={proxyState}
            onChange={handleProxyChange}
            scope="profile"
            profileId={profile.id}
          />
        </section>

        {/* Shortcut Section —— 当前 AI 应用浏览器窗口开关快捷键（Profile.browserWindowShortcut） */}
        <section style={sectionStyle} data-name="browser.settings.shortcut-section">
          <SectionTitle>窗口快捷键</SectionTitle>
          <p style={hintStyle} data-name="browser.settings.shortcut-hint">
            按下该快捷键可打开或关闭当前应用的浏览器窗口（系统级全局快捷键，应用未聚焦也生效）。默认无快捷键。
          </p>
          <FormRow label="开关快捷键">
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
        <section style={sectionStyle} data-name="browser.settings.download-section">
          <SectionTitle>下载设置</SectionTitle>
          <FormRow label="下载目录">
            <code
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 'var(--text-xs)',
                color: 'var(--text-muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {settings.downloadDir || '默认下载目录'}
            </code>
            <Button variant="outline" onClick={() => void handleSelectDownloadDir()}>更改</Button>
            <Button variant="outline" onClick={() => void openDownloadDir()}>打开</Button>
          </FormRow>
          <FormRow label="下载行为">
            <select
              className="input-underline"
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
          </FormRow>
        </section>

        {/* Tab Persistence Section */}
        <section style={sectionStyle} data-name="browser.settings.tab-persistence-section">
          <SectionTitle>标签管理</SectionTitle>
          <FormRow label="标签累积持久化">
            <select
              className="input-underline"
              value={settings.browserTabPersistence ?? 'memory'}
              onChange={(e) => {
                const mode = e.target.value as 'memory' | 'persistent';
                void updateAppSettings({ browserTabPersistence: mode });
                setSettings((s) => s ? { ...s, browserTabPersistence: mode } : s);
              }}
            >
              <option value="memory">内存模式（仅本次会话）</option>
              <option value="persistent">持久化模式（重启后保留）</option>
            </select>
          </FormRow>
          <p style={hintStyle} data-name="browser.settings.tab-persistence-hint">
            AI 应用内点击新窗口链接时累积的标签，关闭独立窗口后是否保留
          </p>
        </section>

        {/* Block Rules Section */}
        <section style={sectionStyle} data-name="browser.settings.block-rules-section">
          <SectionTitle>屏蔽规则</SectionTitle>
          <p style={hintStyle} data-name="browser.settings-desc">
            当前平台域名: {profile.aiPlatformUrl ? new URL(profile.aiPlatformUrl).hostname : '未设置'}
          </p>
          {blockRules.length === 0 ? (
            <p style={{ ...hintStyle, fontStyle: 'italic' }} data-name="browser.settings-empty">无匹配规则</p>
          ) : (
            <ul
              style={{ listStyle: 'none', padding: 0, margin: 0 }}
              data-name="browser.settings-list"
            >
              {blockRules.map((rule) => (
                <li
                  key={rule.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    padding: 'var(--space-1) 0',
                    fontSize: 'var(--text-sm)',
                    borderBottom: '1px solid var(--glass-bd-2)',
                  }}
                >
                  <code
                    style={{
                      background: 'var(--muted, #252525)',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: 'var(--text-xs)',
                    }}
                  >
                    {rule.domainPattern}
                  </code>
                  {' — '}{rule.selector || '无选择器'}
                  <span
                    data-name="browser.rule-status"
                    className={`rule-status ${rule.enabled ? 'enabled' : 'disabled'}`}
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
          style={{ ...sectionStyle, borderBottom: 0, marginBottom: 0, paddingBottom: 0 }}
          data-name="browser.settings.region-section"
        >
          <SectionTitle>区域设置</SectionTitle>
          <FormRow label="AI 平台区域">
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              {profile.aiPlatformRegion === 'cn' ? '国内' : profile.aiPlatformRegion === 'global' ? '国外' : '未设置'}
            </span>
          </FormRow>
        </section>
      </div>

      {/* Sticky action bar —— 设置自动保存，此处为底部固定提示区，保证布局可滚动且底部留出操作位 */}
      <div
        data-name="browser.settings.footer"
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 'var(--space-2)',
          padding: 'var(--space-3) var(--space-8)',
          borderTop: '1px solid var(--glass-bd-2)',
          background: 'var(--background, #1a1a1a)',
        }}
      >
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
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
