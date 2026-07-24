import type { Dispatch, SetStateAction } from 'react';
import { useState } from 'react';
import { Button, SegmentedControl, SectionTitle } from '../../ui';
import type { AIPlatform, Profile, DevicePreset } from '../../../lib/electron-api';

interface PlatformUrlSectionProps {
  platforms: AIPlatform[];
  profiles: Profile[];
  presets: DevicePreset[];
  hideForeignModels: boolean;
  hiddenPlatforms: string[];
  openProfileIds: Set<string>;
  platformUrlDrafts: Record<string, string>;
  setPlatformUrlDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  platformDesktopUaDrafts: Record<string, string>;
  setPlatformDesktopUaDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  platformMobileUaDrafts: Record<string, string>;
  setPlatformMobileUaDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  platformThemeColorDrafts: Record<string, string>;
  setPlatformThemeColorDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  platformRegionDrafts: Record<string, 'cn' | 'global'>;
  setPlatformRegionDrafts: Dispatch<SetStateAction<Record<string, 'cn' | 'global'>>>;
  savingPlatformId: string | null;
  handleSavePlatform: (platform: AIPlatform) => Promise<void>;
  handleTogglePlatformHidden: (platform: AIPlatform) => Promise<void>;
  handleSwitchToPlatformTab: (platform: AIPlatform) => void;
}

export default function PlatformUrlSection({
  platforms,
  profiles,
  presets,
  hideForeignModels,
  hiddenPlatforms,
  openProfileIds,
  platformUrlDrafts,
  setPlatformUrlDrafts,
  platformDesktopUaDrafts,
  setPlatformDesktopUaDrafts,
  platformMobileUaDrafts,
  setPlatformMobileUaDrafts,
  platformThemeColorDrafts,
  setPlatformThemeColorDrafts,
  platformRegionDrafts,
  setPlatformRegionDrafts,
  savingPlatformId,
  handleSavePlatform,
  handleTogglePlatformHidden,
  handleSwitchToPlatformTab,
}: PlatformUrlSectionProps) {
  const desktopPresets = presets.filter((p) => p.platform === 'desktop');
  const mobilePresets = presets.filter((p) => p.platform === 'mobile');
  // 默认收起，减少占用空间
  const [isCollapsed, setIsCollapsed] = useState(true);

  const visiblePlatforms = hideForeignModels
    ? platforms.filter((p) => p.region === 'cn')
    : platforms;

  return (
    <section data-name="settings.platform-url.section">
      <SectionTitle
        collapsible
        collapsed={isCollapsed}
        onToggle={() => setIsCollapsed((v) => !v)}
      >
        平台默认 URL <span className="platform-url-count" data-name="settings.platform-url.count">({visiblePlatforms.length})</span>
      </SectionTitle>
      {hideForeignModels && !isCollapsed && (
        <div className="platform-url-hint" data-name="settings.platform-url.hint">
          已开启「一键隐藏国外模型」，仅显示国内平台。可在「区域与代理」中关闭。
        </div>
      )}
      {!isCollapsed && (
      <div className="platform-url-list" data-name="settings.platform-url.platform-item-list">
        {visiblePlatforms.map((p, idx) => {
          const profile = profiles.find(
            (pr) => pr.isAIPlatform && (pr.aiPlatformId === p.id || pr.aiPlatformUrl === p.url),
          );
          const urlDraft = platformUrlDrafts[p.id] ?? '';
          const desktopPresetDraft = platformDesktopUaDrafts[p.id] ?? p.defaultDesktopPreset;
          const mobilePresetDraft = platformMobileUaDrafts[p.id] ?? p.defaultMobilePreset;
          const themeColorDraft = platformThemeColorDrafts[p.id] ?? p.themeColor;
          const regionDraft = platformRegionDrafts[p.id] ?? p.region;
          const currentUrl = profile?.aiPlatformUrl ?? p.url;
          const currentDesktopPreset = profile?.aiDesktopPreset ?? p.defaultDesktopPreset;
          const currentMobilePreset = profile?.aiMobilePreset ?? p.defaultMobilePreset;
          const currentThemeColor = profile?.aiThemeColor ?? p.themeColor;
          const currentRegion = profile?.aiPlatformRegion ?? p.region;
          const dirty =
            urlDraft.trim() !== currentUrl ||
            desktopPresetDraft !== currentDesktopPreset ||
            mobilePresetDraft !== currentMobilePreset ||
            themeColorDraft.toLowerCase() !== currentThemeColor.toLowerCase() ||
            regionDraft !== currentRegion;
          const isOpen = profile != null && openProfileIds.has(profile.id);
          const isHidden = hiddenPlatforms.includes(p.id);
          return (
            <div
              key={p.id}
              className="platform-url-item"
              data-name={`settings.platform-url.platform-item-${idx + 1}`}
              data-index={idx + 1}
              data-id={p.id}
            >
              <div className="platform-url-head" data-name={`settings.platform-url.platform-item-${idx + 1}-head`}>
                <div className="platform-url-name-row" data-name={`settings.platform-url.platform-item-${idx + 1}-name-row`}>
                  <span
                    className="platform-url-color-dot"
                    style={{ background: themeColorDraft }}
                    data-name={`settings.platform-url.platform-item-${idx + 1}-color-dot`}
                  />
                  <span className="platform-url-name" data-name={`settings.platform-url.platform-item-${idx + 1}-name`}>{p.name}</span>
                </div>
                <SegmentedControl
                  className="platform-region-toggle"
                  name={`platform-region-${p.id}`}
                  value={regionDraft}
                  onChange={(v) =>
                    setPlatformRegionDrafts((prev) => ({ ...prev, [p.id]: v }))
                  }
                  options={[
                    { value: 'cn', label: '国内' },
                    { value: 'global', label: '国外' },
                  ]}
                />
                {isOpen ? (
                  <button
                    type="button"
                    className="platform-status-btn open"
                    onClick={() => handleSwitchToPlatformTab(p)}
                    title="切换到该应用标签"
                    data-name={`settings.platform-url.platform-item-${idx + 1}-status-button-open`}
                  >
                    已打开
                  </button>
                ) : isHidden ? (
                  <button
                    type="button"
                    className="platform-status-btn hidden"
                    onClick={() => void handleTogglePlatformHidden(p)}
                    title="取消隐藏"
                    data-name={`settings.platform-url.platform-item-${idx + 1}-status-button-hidden`}
                  >
                    已隐藏
                  </button>
                ) : (
                  <button
                    type="button"
                    className="platform-status-btn configured"
                    onClick={() => void handleTogglePlatformHidden(p)}
                    title="隐藏该应用（不在底栏/左上角显示）"
                    data-name={`settings.platform-url.platform-item-${idx + 1}-status-button-configured`}
                  >
                    已配置
                  </button>
                )}
              </div>

              <div className="platform-url-input-row" data-name={`settings.platform-url.platform-item-${idx + 1}-input-row`}>
                <input
                  type="text"
                  className="platform-url-input input-underline"
                  value={urlDraft}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={p.url}
                  onChange={(e) =>
                    setPlatformUrlDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && dirty && profile) {
                      e.preventDefault();
                      void handleSavePlatform(p);
                    }
                  }}
                  data-name={`settings.platform-url.platform-item-${idx + 1}-url-input`}
                />
                {dirty && profile && (
                  <Button
                    variant="primary-compact"
                    className="platform-url-save btn-save-primary"
                    disabled={savingPlatformId === p.id}
                    onClick={() => void handleSavePlatform(p)}
                    data-name={`settings.platform-url.platform-item-${idx + 1}-save-button`}
                  >
                    {savingPlatformId === p.id ? '保存中…' : '保存'}
                  </Button>
                )}
              </div>

              <div className="platform-ua-row" data-name={`settings.platform-url.platform-item-${idx + 1}-ua-row`}>
                <div className="platform-ua-select" data-name={`settings.platform-url.platform-item-${idx + 1}-desktop-ua-field`}>
                  <span className="platform-ua-label" data-name={`settings.platform-url.platform-item-${idx + 1}-desktop-ua-label`}>桌面端 UA</span>
                  <select
                    className="platform-ua-preset-select input-underline"
                    value={desktopPresetDraft}
                    onChange={(e) =>
                      setPlatformDesktopUaDrafts((prev) => ({
                        ...prev,
                        [p.id]: e.target.value,
                      }))
                    }
                    data-name={`settings.platform-url.platform-item-${idx + 1}-desktop-ua-select`}
                  >
                    {desktopPresets.map((preset, presetIdx) => (
                      <option
                        key={preset.id}
                        value={preset.id}
                        data-name={`settings.platform-url.platform-item-${idx + 1}-desktop-ua-option-${presetIdx + 1}`}
                      >
                        {preset.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="platform-ua-select" data-name={`settings.platform-url.platform-item-${idx + 1}-mobile-ua-field`}>
                  <span className="platform-ua-label" data-name={`settings.platform-url.platform-item-${idx + 1}-mobile-ua-label`}>移动端 UA</span>
                  <select
                    className="platform-ua-preset-select input-underline"
                    value={mobilePresetDraft}
                    onChange={(e) =>
                      setPlatformMobileUaDrafts((prev) => ({
                        ...prev,
                        [p.id]: e.target.value,
                      }))
                    }
                    data-name={`settings.platform-url.platform-item-${idx + 1}-mobile-ua-select`}
                  >
                    {mobilePresets.map((preset, presetIdx) => (
                      <option
                        key={preset.id}
                        value={preset.id}
                        data-name={`settings.platform-url.platform-item-${idx + 1}-mobile-ua-option-${presetIdx + 1}`}
                      >
                        {preset.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="platform-theme-color" data-name={`settings.platform-url.platform-item-${idx + 1}-theme-color-field`}>
                  <span className="platform-ua-label" data-name={`settings.platform-url.platform-item-${idx + 1}-theme-color-label`}>主打色</span>
                  <div className="theme-color-picker-row" data-name={`settings.platform-url.platform-item-${idx + 1}-theme-color-picker`}>
                    <input
                      type="color"
                      className="theme-color-input"
                      value={themeColorDraft}
                      onChange={(e) =>
                        setPlatformThemeColorDrafts((prev) => ({
                          ...prev,
                          [p.id]: e.target.value,
                        }))
                      }
                      data-name={`settings.platform-url.platform-item-${idx + 1}-theme-color-input`}
                    />
                    <input
                      type="text"
                      className="theme-color-text"
                      value={themeColorDraft}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) =>
                        setPlatformThemeColorDrafts((prev) => ({
                          ...prev,
                          [p.id]: e.target.value,
                        }))
                      }
                      data-name={`settings.platform-url.platform-item-${idx + 1}-theme-color-text`}
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      )}
    </section>
  );
}
