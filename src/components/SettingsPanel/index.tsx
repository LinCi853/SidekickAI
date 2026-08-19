// 维护性说明：本文件已重构，状态逻辑抽取到 hooks/useSettingsData.ts，
// 面板外壳抽取到 SettingsPanelShell.tsx。本文件仅保留编排逻辑。
/* =====================================================================
   components/SettingsPanel/index.tsx —— 主窗口设置面板（侧滑）
   编排各 section：外观、通用、顶栏、热键、AI 应用、供应商、平台 URL、
   语音、代理、设备预设、Cookie、进阶配置、关于。
   数据加载/CRUD 通过 useAppSettings/useVoiceConfig/useHotkeys/usePresets hook。
   ===================================================================== */

import { useState, useCallback } from 'react';
import type { AIPlatform, TopBarButtonGroup } from '../../lib/electron-api';
import {
  updateAppSettings,
  getAppSettings,
  openAiAppEditor,
  setMinimumSize,
} from '../../lib/electron-api';
import { useTabStore } from '../../store/useTabStore';
import { useModuleStore } from '../../store/useModuleStore';
import { useAppSettings, useVoiceConfig, useHotkeys, usePresets } from '../../hooks/useSettingsData';
import { usePlatformUrlConfig } from '../../hooks/usePlatformUrlConfig';
import './styles.css';
import type { SettingsPanelProps, VoiceSettings, GeneralSettings, ProxySettings } from './types';
import SettingsPanelShell from './SettingsPanelShell';
import AppearanceSection from './sections/AppearanceSection';
import GeneralSection from './sections/GeneralSection';
import HotkeySection from './sections/HotkeySection';
import AboutSection from './sections/AboutSection';
import ModuleManagementSection from './sections/ModuleManagementSection';
import DeveloperOptionsSection from './sections/DeveloperOptionsSection';
import TopBarSection from './sections/TopBarSection';
import AiAppSection from './sections/AiAppSection';
import ProviderSection from './sections/ProviderSection';
import PlatformUrlSection from './sections/PlatformUrlSection';
import VoiceSection from './sections/VoiceSection';
import PresetSection from './sections/PresetSection';
import AdvancedSection from './sections/AdvancedSection';

export default function SettingsPanel({ open, onClose, onOpenShortcuts }: SettingsPanelProps) {
  // ===== 状态 hook（替代原 50+ useState） =====
  const app = useAppSettings(open);
  const voice = useVoiceConfig(open);
  const hotkeys = useHotkeys(open);
  const presetsState = usePresets(open);

  // 预设展开状态（本地 UI state，不属于持久化数据）
  const [presetExpanded, setPresetExpanded] = useState(false);

  // 供应商编辑状态：编辑时本地强制隐藏侧滑面板，让编辑 Modal 全屏覆盖主窗口
  const [providerEditing, setProviderEditing] = useState(false);

  // 主窗口专属：已打开标签（用于顶栏按钮显隐后同步最小宽度）
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);

  // 平台 URL 配置状态（独立 hook 管理）
  const platformUrlConfig = usePlatformUrlConfig(presetsState.platforms);

  /** 切换平台隐藏状态（已配置 ↔ 已隐藏） */
  const handleTogglePlatformHidden = async (platform: AIPlatform) => {
    const isHidden = app.hiddenPlatforms.includes(platform.id);
    const next = isHidden
      ? app.hiddenPlatforms.filter((id) => id !== platform.id)
      : [...app.hiddenPlatforms, platform.id];
    app.setHiddenPlatforms(next);
    try {
      await updateAppSettings({ hiddenPlatforms: next });
    } catch (e) {
      console.error('[SettingsPanel] 切换平台隐藏状态失败:', e);
      app.setHiddenPlatforms(app.hiddenPlatforms);
    }
  };

  /** 切换「自动屏蔽国外模型」开关 */
  const handleToggleHideForeignModels = async () => {
    const next = !app.hideForeignModels;
    app.setHideForeignModels(next);
    try {
      await updateAppSettings({ hideForeignModels: next });
    } catch (e) {
      console.error('[SettingsPanel] 切换屏蔽国外模型失败:', e);
      app.setHideForeignModels(app.hideForeignModels);
    }
  };

  /** 切换「启用广告屏蔽规则」开关 */
  const handleToggleDisableAllBlockRules = async () => {
    const next = !app.disableAllBlockRules;
    app.setDisableAllBlockRules(next);
    try {
      await updateAppSettings({ disableAllBlockRules: next });
    } catch (e) {
      console.error('[SettingsPanel] 切换广告屏蔽规则失败:', e);
      app.setDisableAllBlockRules(app.disableAllBlockRules);
    }
  };

  /** 修改 Alt+Space 连续触发恢复窗口位置的次数阈值 */
  const handleAltSpaceThresholdChange = async (value: number) => {
    const clamped = Math.max(3, Math.min(20, value));
    const prev = app.altSpaceResetThreshold;
    app.setAltSpaceResetThreshold(clamped);
    try {
      await updateAppSettings({ altSpaceResetThreshold: clamped });
    } catch (e) {
      console.error('[SettingsPanel] 更新 Alt+Space 阈值失败:', e);
      app.setAltSpaceResetThreshold(prev);
    }
  };

  /** 切换顶栏按钮组显隐 */
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
        console.warn('[SettingsPanel] 更新窗口最小宽度失败:', e);
      }
    } catch (e) {
      console.error('[SettingsPanel] 切换顶栏按钮显隐失败:', e);
      app.setTopBarVisibleButtons(current);
    }
  };

  // ===== 聚合 props 模式：onChange 仅更新本地 state（即时 UI 反馈），不触发持久化 =====
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
    <SettingsPanelShell open={open && !providerEditing} onClose={onClose}>
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
        onOpenShortcuts={onOpenShortcuts}
      />

      <AiAppSection
        platforms={presetsState.platforms}
        onEditApp={(profileId) => {
          void openAiAppEditor({ profileId, mode: 'edit' });
        }}
        hideForeignModels={app.hideForeignModels}
        onToggleHideForeignModels={handleToggleHideForeignModels}
      />

      {useModuleStore.getState().isEnabled('custom-chat') && (
        <ProviderSection
          defaultCollapsed={false}
          onEditingChange={setProviderEditing}
        />
      )}

      <PlatformUrlSection
        platforms={presetsState.platforms}
        profiles={platformUrlConfig.profiles}
        presets={presetsState.presets}
        hideForeignModels={app.hideForeignModels}
        hiddenPlatforms={app.hiddenPlatforms}
        openProfileIds={platformUrlConfig.openProfileIds}
        platformUrlDrafts={platformUrlConfig.platformUrlDrafts}
        setPlatformUrlDrafts={platformUrlConfig.setPlatformUrlDrafts}
        platformDesktopUaDrafts={platformUrlConfig.platformDesktopUaDrafts}
        setPlatformDesktopUaDrafts={platformUrlConfig.setPlatformDesktopUaDrafts}
        platformMobileUaDrafts={platformUrlConfig.platformMobileUaDrafts}
        setPlatformMobileUaDrafts={platformUrlConfig.setPlatformMobileUaDrafts}
        platformThemeColorDrafts={platformUrlConfig.platformThemeColorDrafts}
        setPlatformThemeColorDrafts={platformUrlConfig.setPlatformThemeColorDrafts}
        platformRegionDrafts={platformUrlConfig.platformRegionDrafts}
        setPlatformRegionDrafts={platformUrlConfig.setPlatformRegionDrafts}
        savingPlatformId={platformUrlConfig.savingPlatformId}
        handleSavePlatform={platformUrlConfig.handleSavePlatform}
        handleTogglePlatformHidden={handleTogglePlatformHidden}
        handleSwitchToPlatformTab={platformUrlConfig.handleSwitchToPlatformTab}
      />

      {(useModuleStore.getState().isEnabled('voice') || useModuleStore.getState().isEnabled('tts')) && (
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
      />
      )}

      <PresetSection
        presets={presetsState.presets}
        loading={presetsState.isLoading}
        presetExpanded={presetExpanded}
        setPresetExpanded={setPresetExpanded}
        onReload={() => { void presetsState.load(); }}
      />

      <AdvancedSection
        presets={presetsState.presets}
        altSpaceResetThreshold={app.altSpaceResetThreshold}
        onAltSpaceThresholdChange={handleAltSpaceThresholdChange}
        defaultDesktopUaPreset={app.defaultDesktopUaPreset}
        defaultMobileUaPreset={app.defaultMobileUaPreset}
        onDefaultDesktopUaPresetChange={(v) => app.setDefaultDesktopUaPreset(v)}
        onDefaultMobileUaPresetChange={(v) => app.setDefaultMobileUaPreset(v)}
        proxy={{
          proxyMode: app.proxyMode,
          customProxy: app.customProxy,
          proxyUsername: app.proxyUsername,
          proxyPassword: app.proxyPassword,
          proxyBypass: app.proxyBypass,
          proxyFallbackEnabled: app.proxyFallbackEnabled,
          proxyFallbackMode: app.proxyFallbackMode,
        }}
        onProxyChange={handleProxyChange}
      />

      <ModuleManagementSection />

      <DeveloperOptionsSection
        disableAllBlockRules={app.disableAllBlockRules}
        onToggleDisableAllBlockRules={handleToggleDisableAllBlockRules}
      />

      <AboutSection />
    </SettingsPanelShell>
  );
}
