/* =====================================================================
   SettingsView —— 独立设置窗口
    左导航（6类分组）+ 右内容区，替代原侧滑面板。
    复用 SettingsPanel/sections 下所有 section 组件。
   ===================================================================== */

import { useState, useCallback, useMemo, useEffect } from 'react';
import type { TopBarButtonGroup } from '../../lib/electron-api';
import {
  updateAppSettings,
  getAppSettings,
  setMinimumSize,
} from '../../lib/electron-api';
import { useTabStore } from '../../store/useTabStore';
import { useModuleStore } from '../../store/useModuleStore';
import { useAppSettings, useVoiceConfig, useHotkeys, usePresets } from '../../hooks/useSettingsData';
import { useEscToCloseWindow } from '../../hooks/useEscToCloseWindow';
import StandaloneWindowHeader from '../../components/StandaloneWindowHeader';
import WindowResizeHandles from '../../components/WindowResizeHandles';
import Toggle from '../../components/ui/Toggle';
import { SectionTitle, FormRow, Combobox } from '../../components/ui';
import type { ComboboxOption } from '../../components/ui';
import type { VoiceSettings, GeneralSettings, ProxySettings } from '../../components/SettingsPanel/types';
import AppearanceSection from '../../components/SettingsPanel/sections/AppearanceSection';
import GeneralSection from '../../components/SettingsPanel/sections/GeneralSection';
import HotkeySection from '../../components/SettingsPanel/sections/HotkeySection';
import TopBarSection from '../../components/SettingsPanel/sections/TopBarSection';
import AiAppSection from '../../components/SettingsPanel/sections/AiAppSection';
import ProviderSection from '../../components/SettingsPanel/sections/ProviderSection';
import VoiceSection from '../../components/SettingsPanel/sections/VoiceSection';
import ProxySection from '../../components/SettingsPanel/sections/ProxySection';
import PresetSection from '../../components/SettingsPanel/sections/PresetSection';
import CookieSection from '../../components/SettingsPanel/sections/CookieSection';
import StorageSection from '../../components/SettingsPanel/sections/StorageSection';
import AboutSection from '../../components/SettingsPanel/sections/AboutSection';
import ModuleManagementSection from '../../components/SettingsPanel/sections/ModuleManagementSection';
import DeveloperOptionsSection from '../../components/SettingsPanel/sections/DeveloperOptionsSection';
import AiAppEditorModal from '../../components/AiAppEditorModal';
import '../../components/SettingsPanel/styles.css';
import '../../components/ui/TitleBar.css';
import './index.css';

type CategoryId = 'appearance' | 'ai' | 'voice' | 'network' | 'advanced' | 'modules' | 'developer' | 'about';

const CATEGORIES: Array<{ id: CategoryId; label: string; icon: string }> = [
  { id: 'appearance', label: '外观与交互', icon: '◐' },
  { id: 'ai', label: 'AI 服务', icon: '◆' },
  { id: 'voice', label: '语音', icon: '♪' },
  { id: 'network', label: '网络与隐私', icon: '▣' },
  { id: 'advanced', label: '高级', icon: '⚙' },
  { id: 'modules', label: '模块管理', icon: '▦' },
  { id: 'developer', label: '开发者选项', icon: '⚗' },
  { id: 'about', label: '关于', icon: 'ℹ' },
];

export default function SettingsView() {
  useEscToCloseWindow();

  const [activeCategory, setActiveCategory] = useState<CategoryId>('appearance');

  // ===== 状态 hook =====
  const app = useAppSettings(true);
  const voice = useVoiceConfig(true);
  const hotkeys = useHotkeys(true);
  const presetsState = usePresets(true);

  const [providerEditing, setProviderEditing] = useState(false);

  // ===== AI 应用编辑器遮罩状态 =====
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorProfileId, setEditorProfileId] = useState<string | undefined>(undefined);
  const [editorMode, setEditorMode] = useState<'edit' | 'create'>('edit');

  const handleOpenEditorEdit = useCallback((profileId: string) => {
    setEditorProfileId(profileId);
    setEditorMode('edit');
    setEditorOpen(true);
  }, []);

  const handleOpenEditorCreate = useCallback(() => {
    setEditorProfileId(undefined);
    setEditorMode('create');
    setEditorOpen(true);
  }, []);

  const handleCloseEditor = useCallback(() => {
    setEditorOpen(false);
  }, []);

  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);

  // ===== UA 预设相关状态（从 AdvancedSection 内联） =====
  const desktopPresets = useMemo(
    () => presetsState.presets.filter((p) => p.platform === 'desktop'),
    [presetsState.presets],
  );
  const mobilePresets = useMemo(
    () => presetsState.presets.filter((p) => p.platform === 'mobile'),
    [presetsState.presets],
  );
  const desktopPlaceholder = desktopPresets.some((p) => p.id === app.defaultDesktopUaPreset)
    ? null
    : { id: app.defaultDesktopUaPreset, name: '（已失效，请重选）' };
  const mobilePlaceholder = mobilePresets.some((p) => p.id === app.defaultMobileUaPreset)
    ? null
    : { id: app.defaultMobileUaPreset, name: '（已失效，请重选）' };

  // ===== Alt+Space 阈值相关状态（从 AdvancedSection 内联） =====
  const [thresholdDraft, setThresholdDraft] = useState<string>(String(app.altSpaceResetThreshold));
  useEffect(() => {
    setThresholdDraft(String(app.altSpaceResetThreshold));
  }, [app.altSpaceResetThreshold]);

  const handleThresholdBlur = () => {
    const parsed = parseInt(thresholdDraft, 10);
    if (!Number.isFinite(parsed)) {
      setThresholdDraft(String(app.altSpaceResetThreshold));
      return;
    }
    const clamped = Math.max(3, Math.min(20, parsed));
    setThresholdDraft(String(clamped));
    if (clamped !== app.altSpaceResetThreshold) {
      void handleAltSpaceThresholdChange(clamped);
    }
  };

  // ===== Handlers =====
  const handleToggleHideForeignModels = async () => {
    const next = !app.hideForeignModels;
    app.setHideForeignModels(next);
    try {
      await updateAppSettings({ hideForeignModels: next });
    } catch (e) {
      console.error('[SettingsView] 切换屏蔽国外模型失败:', e);
      app.setHideForeignModels(app.hideForeignModels);
    }
  };

  const handleToggleDisableAllBlockRules = async () => {
    const next = !app.disableAllBlockRules;
    app.setDisableAllBlockRules(next);
    try {
      await updateAppSettings({ disableAllBlockRules: next });
    } catch (e) {
      console.error('[SettingsView] 切换广告屏蔽规则失败:', e);
      app.setDisableAllBlockRules(app.disableAllBlockRules);
    }
  };

  const handleAltSpaceThresholdChange = async (value: number) => {
    const clamped = Math.max(3, Math.min(20, value));
    const prev = app.altSpaceResetThreshold;
    app.setAltSpaceResetThreshold(clamped);
    try {
      await updateAppSettings({ altSpaceResetThreshold: clamped });
    } catch (e) {
      console.error('[SettingsView] 更新 Alt+Space 阈值失败:', e);
      app.setAltSpaceResetThreshold(prev);
    }
  };

  const handleToggleTopBarButton = async (group: TopBarButtonGroup) => {
    const current = app.topBarVisibleButtons;
    const next = current.includes(group)
      ? current.filter((g) => g !== group)
      : [...current, group];
    app.setTopBarVisibleButtons(next);
    try {
      await updateAppSettings({ topBarVisibleButtons: next });
      try {
        const { calculateMainWindowMinWidth, MAIN_WINDOW_MIN_HEIGHT } = await import(
          '../../../electron/shared/window-size'
        );
        const cfg = await getAppSettings();
        const uiScale = (cfg.uiScale ?? 'medium') as 'small' | 'medium' | 'large';
        const activeTab = tabs.find((t) => t.id === activeTabId);
        const newMinWidth = calculateMainWindowMinWidth(uiScale, next, activeTab?.title);
        await setMinimumSize(newMinWidth, MAIN_WINDOW_MIN_HEIGHT);
      } catch (e) {
        console.warn('[SettingsView] 更新窗口最小宽度失败:', e);
      }
    } catch (e) {
      console.error('[SettingsView] 切换顶栏按钮显隐失败:', e);
      app.setTopBarVisibleButtons(current);
    }
  };

  const handleVoiceChange = useCallback((patch: Partial<VoiceSettings>) => {
    if (patch.confirmMode !== undefined) voice.setConfirmMode(patch.confirmMode);
    if (patch.inputMethod !== undefined) voice.setInputMethod(patch.inputMethod);
    if (patch.enterToSend !== undefined) voice.setEnterToSend(patch.enterToSend);
    if (patch.sttMode !== undefined) voice.setSttMode(patch.sttMode);
    if (patch.aiProvider !== undefined) voice.setAiProvider(patch.aiProvider);
    if (patch.language !== undefined) voice.setLanguage(patch.language);
    if (patch.localExePath !== undefined) voice.setLocalExePath(patch.localExePath);
    if (patch.localArgs !== undefined) voice.setLocalArgs(patch.localArgs);
    if (patch.inputDeviceId !== undefined) voice.setInputDeviceId(patch.inputDeviceId);
    if (patch.ttsMode !== undefined) voice.setTtsMode(patch.ttsMode);
    if (patch.ttsProvider !== undefined) voice.setTtsProvider(patch.ttsProvider);
  }, [voice]);

  const handleGeneralChange = useCallback((patch: Partial<GeneralSettings>) => {
    if (patch.startupOpen !== undefined) app.setStartupOpen(patch.startupOpen);
    if (patch.closeBehavior !== undefined) app.setCloseBehavior(patch.closeBehavior);
    if (patch.enterToSend !== undefined) app.setEnterToSend(patch.enterToSend);
    if (patch.appClickBehavior !== undefined) app.setAppClickBehavior(patch.appClickBehavior);
    if (patch.usageTrackingEnabled !== undefined) app.setUsageTrackingEnabled(patch.usageTrackingEnabled);
  }, [app]);

  const handleProxyChange = useCallback((patch: Partial<ProxySettings>) => {
    if (patch.proxyMode !== undefined) app.setProxyMode(patch.proxyMode);
    if (patch.customProxy !== undefined) app.setCustomProxy(patch.customProxy);
    if (patch.proxyUsername !== undefined) app.setProxyUsername(patch.proxyUsername);
    if (patch.proxyPassword !== undefined) app.setProxyPassword(patch.proxyPassword);
    if (patch.proxyBypass !== undefined) app.setProxyBypass(patch.proxyBypass);
    if (patch.proxyFallbackEnabled !== undefined) app.setProxyFallbackEnabled(patch.proxyFallbackEnabled);
    if (patch.proxyFallbackMode !== undefined) app.setProxyFallbackMode(patch.proxyFallbackMode);
  }, [app]);

  return (
    <>
      <WindowResizeHandles />
      <div className="settings-window-root app-shell app-view-root" data-name="settings.window.root">
        <StandaloneWindowHeader title="设置" dataNamePrefix="settings.topbar" showMinMax={false} />

        <div className="settings-window-body">
          {/* 左导航 */}
          <nav className="settings-nav" data-name="settings.nav">
            {CATEGORIES.filter((cat) => {
              // 模块联动：语音输入与 TTS 全关时隐藏「语音」分类
              if (cat.id === 'voice') {
                return useModuleStore.getState().isEnabled('voice') || useModuleStore.getState().isEnabled('tts');
              }
              return true;
            }).map((cat) => (
              <button
                key={cat.id}
                className={`settings-nav-item${activeCategory === cat.id ? ' active' : ''}`}
                onClick={() => setActiveCategory(cat.id)}
                data-name={`settings.nav.${cat.id}`}
              >
                <span className="settings-nav-icon" aria-hidden="true">{cat.icon}</span>
                <span className="settings-nav-label">{cat.label}</span>
              </button>
            ))}
          </nav>

          {/* 右内容区 */}
          <main className="settings-content" data-name="settings.content">
        {activeCategory === 'appearance' && (
          <>
            <AppearanceSection
              tabBarCollapsed={app.tabBarCollapsed}
              setTabBarCollapsed={app.setTabBarCollapsed}
              uiScale={app.uiScale}
              setUiScale={app.setUiScale}
            />
            <GeneralSection
              general={{
                startupOpen: app.startupOpen,
                closeBehavior: app.closeBehavior,
                enterToSend: app.enterToSend,
                defaultDesktopUaPreset: app.defaultDesktopUaPreset,
                defaultMobileUaPreset: app.defaultMobileUaPreset,
                appClickBehavior: app.appClickBehavior,
                usageTrackingEnabled: app.usageTrackingEnabled,
              }}
              onChange={handleGeneralChange}
            />
            <TopBarSection
              visibleButtons={app.topBarVisibleButtons}
              onToggle={handleToggleTopBarButton}
            />
            <HotkeySection
              hotkeys={hotkeys.hotkeys}
              drafts={hotkeys.drafts}
              savingAction={hotkeys.savingAction}
              feedback={hotkeys.feedback}
              setDrafts={hotkeys.setDrafts}
              handleSaveHotkey={hotkeys.saveHotkey}
              onToggleEnabled={hotkeys.toggleEnabled}
            />
            {/* Alt+Space 位置恢复触发次数 */}
            <section data-name="settings.appearance.alt-space.section">
              <SectionTitle>Alt+Space 位置恢复</SectionTitle>
              <FormRow label="触发次数" mutedLabel>
                <input
                  type="number"
                  className="input-underline hotkey-threshold-input"
                  min={3}
                  max={20}
                  value={thresholdDraft}
                  onChange={(e) => setThresholdDraft(e.target.value)}
                  onBlur={handleThresholdBlur}
                  data-name="settings.appearance.alt-space-threshold-input"
                />
              </FormRow>
            </section>
          </>
        )}

        {activeCategory === 'ai' && (
          <>
            <AiAppSection
              platforms={presetsState.platforms}
              onEditApp={handleOpenEditorEdit}
              onCreateNew={handleOpenEditorCreate}
              hideForeignModels={app.hideForeignModels}
              collapsibleTitle={false}
            />
            <PresetSection
              presets={presetsState.presets}
              loading={presetsState.isLoading}
              presetExpanded={true}
              setPresetExpanded={() => {}}
              onReload={() => { void presetsState.load(); }}
              collapsibleTitle={false}
            />
            {/* 默认 UA 预设 */}
            <section data-name="settings.ai.ua-preset.section">
              <SectionTitle>默认 UA 预设</SectionTitle>
              <FormRow label="默认桌面端 UA" mutedLabel>
                <Combobox
                  inputValue={
                    desktopPlaceholder
                      ? desktopPlaceholder.name
                      : desktopPresets.find((p) => p.id === app.defaultDesktopUaPreset)?.name ?? ''
                  }
                  onInputChange={() => {}}
                  inputPlaceholder="选择桌面端 UA"
                  inputClassName="ua-preset-select"
                  inputReadOnly
                  options={desktopPresets.map<ComboboxOption>((p) => ({
                    value: p.id,
                    label: p.name,
                    selected: p.id === app.defaultDesktopUaPreset,
                  }))}
                  onSelect={async (v) => {
                    app.setDefaultDesktopUaPreset(v);
                    try {
                      await updateAppSettings({ defaultDesktopUaPreset: v });
                    } catch (err) {
                      console.error('保存默认桌面端 UA 失败:', err);
                    }
                  }}
                  searchable
                  searchPlaceholder="搜索 UA 预设…"
                  emptyText="无匹配预设"
                  dataName="settings.ai.desktop-ua-select"
                />
              </FormRow>
              <FormRow label="默认移动端 UA" mutedLabel>
                <Combobox
                  inputValue={
                    mobilePlaceholder
                      ? mobilePlaceholder.name
                      : mobilePresets.find((p) => p.id === app.defaultMobileUaPreset)?.name ?? ''
                  }
                  onInputChange={() => {}}
                  inputPlaceholder="选择移动端 UA"
                  inputClassName="ua-preset-select"
                  inputReadOnly
                  options={mobilePresets.map<ComboboxOption>((p) => ({
                    value: p.id,
                    label: p.name,
                    selected: p.id === app.defaultMobileUaPreset,
                  }))}
                  onSelect={async (v) => {
                    app.setDefaultMobileUaPreset(v);
                    try {
                      await updateAppSettings({ defaultMobileUaPreset: v });
                    } catch (err) {
                      console.error('保存默认移动端 UA 失败:', err);
                    }
                  }}
                  searchable
                  searchPlaceholder="搜索 UA 预设…"
                  emptyText="无匹配预设"
                  dataName="settings.ai.mobile-ua-select"
                />
              </FormRow>
            </section>
            {useModuleStore.getState().isEnabled('custom-chat') && (
              <ProviderSection
                defaultCollapsed={false}
                collapsibleTitle={false}
                onEditingChange={setProviderEditing}
              />
            )}
          </>
        )}

        {activeCategory === 'voice' && (useModuleStore.getState().isEnabled('voice') || useModuleStore.getState().isEnabled('tts')) && (
          <VoiceSection
            voice={{
              confirmMode: voice.confirmMode,
              inputMethod: voice.inputMethod,
              enterToSend: voice.enterToSend,
              sttMode: voice.sttMode,
              aiProvider: voice.aiProvider,
              language: voice.language,
              localExePath: voice.localExePath,
              localArgs: voice.localArgs,
              inputDeviceId: voice.inputDeviceId,
              ttsMode: voice.ttsMode,
              ttsProvider: voice.ttsProvider,
            }}
            onChange={handleVoiceChange}
            collapsibleTitle={false}
          />
        )}

        {activeCategory === 'network' && (
          <>
            <ProxySection
              proxy={{
                proxyMode: app.proxyMode,
                customProxy: app.customProxy,
                proxyUsername: app.proxyUsername,
                proxyPassword: app.proxyPassword,
                proxyBypass: app.proxyBypass,
                proxyFallbackEnabled: app.proxyFallbackEnabled,
                proxyFallbackMode: app.proxyFallbackMode,
              }}
              onChange={handleProxyChange}
            />
            <CookieSection />
          </>
        )}

        {activeCategory === 'advanced' && (
          <>
            {/* 屏蔽与过滤 */}
            <section data-name="settings.advanced.filter.section">
              <SectionTitle>屏蔽与过滤</SectionTitle>
              <FormRow label="屏蔽国外模型">
                <Toggle
                  checked={app.hideForeignModels}
                  onChange={handleToggleHideForeignModels}
                  aria-label="屏蔽国外模型"
                  data-name="settings.advanced.hide-foreign-models-toggle"
                />
              </FormRow>
            </section>
            {/* 下载与缓存清理 */}
            <StorageSection />
          </>
        )}

        {activeCategory === 'modules' && (
  <ModuleManagementSection />
)}

{activeCategory === 'developer' && (
  <DeveloperOptionsSection
    disableAllBlockRules={app.disableAllBlockRules}
    onToggleDisableAllBlockRules={handleToggleDisableAllBlockRules}
  />
)}

{activeCategory === 'about' && (
          <AboutSection />
        )}
          </main>
        </div>
      </div>

      {/* AI 应用编辑器遮罩（覆盖整个设置页面） */}
      <AiAppEditorModal
        open={editorOpen}
        onClose={handleCloseEditor}
        profileId={editorProfileId}
        mode={editorMode}
      />
    </>
  );
}
