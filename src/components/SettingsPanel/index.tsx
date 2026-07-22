// 维护性说明：本文件超过 300 行建议上限。
// 拆分计划：将数据加载/CRUD 抽到 useSettingsData/useProviderCrud
// 等自定义 hook，组件仅保留编排。暂缓原因：拆分涉及 50+ useState 迁移与 props 重构，
// 需充分回归测试验证设置面板各分区功能不受影响，避免破坏业务逻辑。
/* =====================================================================
   components/SettingsPanel.tsx —— 设置面板（侧滑）
   迁移到 Electron 后，Profile 编辑独立到 ProfileEditor 组件。
   本面板聚焦「应用设置」：
   - 设备预设浏览（调 window.electron.presets.list()）
   - 快捷键说明表
   - 应用信息
   ===================================================================== */

import { useEffect, useRef, useState, useCallback } from 'react';
import type { DevicePreset, HotkeyConfig, HotkeyAction, AIPlatform, TopBarButtonGroup } from '../../lib/electron-api';
import { listPresets, getHotkeys, setHotkeyFor, setHotkeyEnabled, listAIPlatforms, getVoiceConfig, getAppSettings, updateAppSettings, openAiAppEditor, ALL_TOP_BAR_BUTTON_GROUPS, setMinimumSize } from '../../lib/electron-api';
import { useTabStore } from '../../store/useTabStore';
import { useProfileStore } from '../../store/useProfileStore';
import './styles.css';
import type { SettingsPanelProps } from './types';
import AppearanceSection from './sections/AppearanceSection';
import GeneralSection from './sections/GeneralSection';
import AiAppSection from './sections/AiAppSection';
import HotkeySection from './sections/HotkeySection';
import PresetSection from './sections/PresetSection';
import VoiceSection from './sections/VoiceSection';
import ProxySection from './sections/ProxySection';
import AboutSection from './sections/AboutSection';
import TopBarSection from './sections/TopBarSection';
import StorageSection from './sections/StorageSection';
import CookieSection from './sections/CookieSection';

export default function SettingsPanel({ open, onClose, onOpenShortcuts }: SettingsPanelProps) {
  // 关闭时设置 inert，防止 Tab 焦点泄漏到隐藏的设置面板
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (asideRef.current) {
      if (open) asideRef.current.removeAttribute('inert');
      else asideRef.current.setAttribute('inert', '');
    }
  }, [open]);

  const [presets, setPresets] = useState<DevicePreset[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [presetExpanded, setPresetExpanded] = useState(false);
  // 全局热键自定义（3 个内置动作，以 action 为 key）
  const [hotkeys, setHotkeys] = useState<HotkeyConfig[]>([]);
  // 输入框草稿：action -> accelerator
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingAction, setSavingAction] = useState<HotkeyAction | null>(null);
  const [hotkeyFeedback, setHotkeyFeedback] = useState<Record<string, { type: 'success' | 'error'; msg: string } | null>>({});
  // AI 平台与 Profile 列表（用于 AiAppSection 卡片展示）
  const [platforms, setPlatforms] = useState<AIPlatform[]>([]);
  // 语音输入配置（confirmMode 上屏方式 + enterToSend + 引擎模式 + AI/本地/下载参数 + 选择器覆盖）
  const [voiceConfirmMode, setVoiceConfirmMode] = useState<'auto' | 'manual' | 'clipboard'>('auto');
  // 默认 false：与 voice-store DEFAULT_VOICE_CONFIG.enterToSend 保持一致
  const [voiceEnterToSend, setVoiceEnterToSend] = useState(false);
  const [voiceSttMode, setVoiceSttMode] = useState<'builtin' | 'ai' | 'local' | 'download'>('builtin');
  const [voiceAiProvider, setVoiceAiProvider] = useState('openai');
  const [voiceLanguage, setVoiceLanguage] = useState('zh');
  const [voiceInputDeviceId, setVoiceInputDeviceId] = useState('');
  const [voiceLocalExePath, setVoiceLocalExePath] = useState('');
  const [voiceLocalArgs, setVoiceLocalArgs] = useState('');
  const [voiceDownloadModel, setVoiceDownloadModel] = useState('');
  // 已下载模型列表（独立于 voiceDownloadStatus 单一字段，解决"切换模型后已下载却仍提示下载"）
  const [downloadedModels, setDownloadedModels] = useState<string[]>([]);
  const [voiceDownloadStatus, setVoiceDownloadStatus] = useState('idle');
  /**
   * whisper-cli 引擎二进制是否已下载（**持久化字段**，来自 cfg.cliDownloaded）。
   * 主进程 getVoiceConfig() 启动时扫描磁盘修正此字段后返回；
   * 持久化策略保证重启后状态不丢失。
   */
  const [voiceCliDownloaded, setVoiceCliDownloaded] = useState(false);
  // v0.5.2 B-3：TTS 独立配置
  const [voiceTtsMode, setVoiceTtsMode] = useState<'disable' | 'ai'>('disable');
  const [voiceTtsProvider, setVoiceTtsProvider] = useState('openai');
  // 应用全局设置（区域代理等）
  const [tabBarCollapsed, setTabBarCollapsed] = useState(true);
  const [enterToSend, setEnterToSend] = useState(true);
  const [defaultDesktopUaPreset, setDefaultDesktopUaPreset] = useState('win-chrome-125');
  const [defaultMobileUaPreset, setDefaultMobileUaPreset] = useState('iphone-15-pro-safari');
  const [closeBehavior, setCloseBehavior] = useState<'close' | 'minimize'>('close');
  const [uiScale, setUiScale] = useState<'small' | 'medium' | 'large'>('medium');
  const [startupOpen, setStartupOpen] = useState<'home' | 'lastConversation'>('home');
  // 点击已打开应用时的行为：switch=跳转(默认) / close=关闭
  const [appClickBehavior, setAppClickBehavior] = useState<'switch' | 'close'>('switch');
  const [proxyMode, setProxyMode] = useState<'system' | 'direct' | 'custom'>('system');
  const [customProxy, setCustomProxy] = useState('');
  const [proxyUsername, setProxyUsername] = useState('');
  const [proxyPassword, setProxyPassword] = useState('');
  const [proxyBypass, setProxyBypass] = useState('');
  // 代理失败兜底：custom 模式加载失败时自动切换到兜底模式（默认关闭）
  const [proxyFallbackEnabled, setProxyFallbackEnabled] = useState(false);
  const [proxyFallbackMode, setProxyFallbackMode] = useState<'direct' | 'system'>('direct');
  // 用户手动隐藏的平台 id 列表
  const [hiddenPlatforms, setHiddenPlatforms] = useState<string[]>([]);
  // 是否自动屏蔽国外模型（region === 'global'）
  const [hideForeignModels, setHideForeignModels] = useState(true);
  // 顶栏可见按钮组（未列出的隐藏；最小化/最大化/关闭始终显示）
  const [topBarVisibleButtons, setTopBarVisibleButtons] = useState<TopBarButtonGroup[]>([...ALL_TOP_BAR_BUTTON_GROUPS]);
  // Alt+Space 连续触发恢复窗口位置的次数阈值（默认 6）
  const [altSpaceResetThreshold, setAltSpaceResetThreshold] = useState(6);
  // 使用统计与操作日志开关（默认开）
  const [usageTrackingEnabled, setUsageTrackingEnabled] = useState(true);
  // 已打开标签的 profileId 集合（与 MainView/BottomBar/AppSwitcher 同源）
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const setActiveTab = useTabStore((s) => s.setActiveTab);
  const addTab = useTabStore((s) => s.addTab);
  const openProfileIds = new Set(tabs.map((t) => t.profileId));

  // ===== 设置面板宽度可调（用户拖拽左边缘） =====
  const PANEL_WIDTH_KEY = 'settings-panel-width';
  const PANEL_MIN = 300;
  const PANEL_MAX = 720;
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(PANEL_WIDTH_KEY) : null;
    const w = saved ? parseInt(saved, 10) : NaN;
    return Number.isFinite(w) && w >= PANEL_MIN && w <= PANEL_MAX ? w : 340;
  });
  const draggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartWRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    dragStartXRef.current = e.clientX;
    dragStartWRef.current = panelWidth;
    setIsDragging(true);
  }, [panelWidth]);

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      // 面板在右侧，鼠标向左拖 → 宽度增大
      const delta = dragStartXRef.current - ev.clientX;
      const next = Math.max(PANEL_MIN, Math.min(PANEL_MAX, dragStartWRef.current + delta));
      setPanelWidth(next);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setIsDragging(false);
      // 持久化
      setPanelWidth((w) => {
        try { localStorage.setItem(PANEL_WIDTH_KEY, String(w)); } catch { /* ignore */ }
        return w;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [isDragging]);

  // 面板打开时加载设备预设
  useEffect(() => {
    if (!open || presets.length > 0) return;
    setIsLoading(true);
    listPresets()
      .then((list) => setPresets(list))
      .catch((e) => console.error('加载设备预设失败:', e))
      .finally(() => setIsLoading(false));
  }, [open, presets.length]);

  // 面板打开时加载 AI 平台与 Profile（用于 AiAppSection 卡片展示）
  // 设备预设由上方独立 useEffect 加载，此处不再重复
  useEffect(() => {
    if (!open) return;
    Promise.all([listAIPlatforms(), useProfileStore.getState().loadProfiles()])
      .then(([platformList]) => {
        setPlatforms(platformList);
      })
      .catch((e) => console.error('加载 AI 平台失败:', e));
  }, [open]);

  // 面板打开时加载语音输入配置（引擎模式 + AI/本地/下载参数）
  useEffect(() => {
    if (!open) return;
    getVoiceConfig()
      .then((cfg) => {
        // confirmMode 优先；缺失时统一回退到 'auto'（候选窗已移除，manual 行为等同 auto）
        setVoiceConfirmMode(cfg.confirmMode ?? 'auto');
        setVoiceEnterToSend(cfg.enterToSend ?? true);
        setVoiceSttMode(cfg.sttMode ?? 'builtin');
        setVoiceAiProvider(cfg.aiProvider ?? 'openai');
        setVoiceLanguage(cfg.language ?? 'zh');
        setVoiceInputDeviceId(cfg.inputDeviceId ?? '');
        setVoiceLocalExePath(cfg.localExePath ?? '');
        setVoiceLocalArgs(cfg.localArgs ?? '');
        setVoiceDownloadModel(cfg.downloadModel ?? '');
        // 优先用 downloadedModels 数组判断每个模型的下载状态
        setDownloadedModels(Array.isArray(cfg.downloadedModels) ? cfg.downloadedModels : []);
        setVoiceDownloadStatus(cfg.downloadStatus ?? 'idle');
        setVoiceCliDownloaded(Boolean(cfg.cliDownloaded));
        setVoiceTtsMode(cfg.ttsMode ?? 'disable');
        setVoiceTtsProvider(cfg.ttsProvider ?? 'openai');
      })
      .catch((e) => console.error('加载语音配置失败:', e));
  }, [open]);

  // 面板打开时加载应用全局设置（区域代理等）
  useEffect(() => {
    if (!open) return;
    getAppSettings()
      .then((cfg) => {
        setTabBarCollapsed(cfg.tabBarCollapsed ?? true);
        setEnterToSend(cfg.enterToSend ?? true);
        setDefaultDesktopUaPreset(cfg.defaultDesktopUaPreset ?? 'win-chrome-125');
        setDefaultMobileUaPreset(cfg.defaultMobileUaPreset ?? 'iphone-15-pro-safari');
        setCloseBehavior(cfg.closeBehavior ?? 'close');
        setUiScale(cfg.uiScale ?? 'medium');
        document.documentElement.setAttribute('data-ui-scale', cfg.uiScale ?? 'medium');
        setStartupOpen(cfg.startupOpen ?? 'home');
        setAppClickBehavior(cfg.appClickBehavior ?? 'switch');
        setProxyMode(cfg.proxyMode);
        setCustomProxy(cfg.customProxy);
        setProxyUsername(cfg.proxyUsername ?? '');
        setProxyPassword(cfg.proxyPassword ?? '');
        setProxyBypass(cfg.proxyBypass ?? '');
        setProxyFallbackEnabled(cfg.proxyFallbackEnabled ?? false);
        setProxyFallbackMode(cfg.proxyFallbackMode ?? 'direct');
        setHiddenPlatforms(cfg.hiddenPlatforms ?? []);
        setHideForeignModels(cfg.hideForeignModels ?? true);
        setTopBarVisibleButtons(cfg.topBarVisibleButtons ?? [...ALL_TOP_BAR_BUTTON_GROUPS]);
        setAltSpaceResetThreshold(cfg.altSpaceResetThreshold ?? 6);
        setUsageTrackingEnabled(cfg.usageTrackingEnabled ?? true);
      })
      .catch((e) => console.error('加载应用设置失败:', e));
  }, [open]);

  // 面板打开时加载全部内置热键配置（从主进程持久化设置读取）
  useEffect(() => {
    if (!open) return;
    getHotkeys()
      .then((list) => {
        setHotkeys(list);
        const draftMap: Record<string, string> = {};
        for (const h of list) draftMap[h.action] = h.accelerator;
        setDrafts(draftMap);
        setHotkeyFeedback({});
      })
      .catch((e) => console.error('加载全局热键失败:', e));
  }, [open]);

  /** 切换平台隐藏状态（已配置 ↔ 已隐藏） */
  const handleTogglePlatformHidden = async (platform: AIPlatform) => {
    const isHidden = hiddenPlatforms.includes(platform.id);
    const next = isHidden
      ? hiddenPlatforms.filter((id) => id !== platform.id)
      : [...hiddenPlatforms, platform.id];
    setHiddenPlatforms(next);
    try {
      await updateAppSettings({ hiddenPlatforms: next });
    } catch (e) {
      console.error('[SettingsPanel] 切换平台隐藏状态失败:', e);
      // 回滚
      setHiddenPlatforms(hiddenPlatforms);
    }
  };

  /** 切换「自动屏蔽国外模型」开关 */
  const handleToggleHideForeignModels = async () => {
    const next = !hideForeignModels;
    setHideForeignModels(next);
    try {
      await updateAppSettings({ hideForeignModels: next });
    } catch (e) {
      console.error('[SettingsPanel] 切换屏蔽国外模型失败:', e);
      // 回滚
      setHideForeignModels(hideForeignModels);
    }
  };

  /** 修改 Alt+Space 连续触发恢复窗口位置的次数阈值 */
  const handleAltSpaceThresholdChange = async (value: number) => {
    const clamped = Math.max(3, Math.min(20, value));
    const prev = altSpaceResetThreshold;
    setAltSpaceResetThreshold(clamped);
    try {
      await updateAppSettings({ altSpaceResetThreshold: clamped });
    } catch (e) {
      console.error('[SettingsPanel] 更新 Alt+Space 阈值失败:', e);
      setAltSpaceResetThreshold(prev);
    }
  };

  /** 切换顶栏按钮组显隐 */
  const handleToggleTopBarButton = async (group: TopBarButtonGroup) => {
    const current = topBarVisibleButtons;
    const next = current.includes(group)
      ? current.filter((g) => g !== group)
      : [...current, group];
    setTopBarVisibleButtons(next);
    try {
      await updateAppSettings({ topBarVisibleButtons: next });
      // 同步更新窗口最小宽度（visibleButtons 变化影响顶栏实际占用宽度）
      try {
        const { calculateMainWindowMinWidth, MAIN_WINDOW_MIN_HEIGHT } = await import('../../../electron/shared/window-size');
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
      setTopBarVisibleButtons(current);
    }
  };

  /** 保存某个内置热键 —— 注销旧热键、注册新热键并持久化 */
  const handleSaveHotkey = async (action: HotkeyAction) => {
    const acc = (drafts[action] ?? '').trim();
    if (!acc) {
      setHotkeyFeedback((p) => ({ ...p, [action]: { type: 'error', msg: '热键不能为空' } }));
      return;
    }
    setSavingAction(action);
    setHotkeyFeedback((p) => ({ ...p, [action]: null }));
    try {
      // 若热键当前被禁用，保存时自动启用（用户编辑热键即表示想使用它）
      const current = hotkeys.find((h) => h.action === action);
      if (current && !current.enabled) {
        await setHotkeyEnabled(action, true);
      }
      const ok = await setHotkeyFor(action, acc);
      if (ok) {
        setHotkeys((list) => list.map((h) => (h.action === action ? { ...h, accelerator: acc, enabled: true } : h)));
        setHotkeyFeedback((p) => ({ ...p, [action]: { type: 'success', msg: '已保存并生效' } }));
      } else {
        // 注册失败时主进程会恢复旧热键，这里同步回输入框
        const currentAcc = current?.accelerator ?? '';
        setDrafts((p) => ({ ...p, [action]: currentAcc }));
        setHotkeyFeedback((p) => ({
          ...p,
          [action]: { type: 'error', msg: '注册失败（可能被其他应用占用），已恢复原热键' },
        }));
      }
    } catch (e) {
      setHotkeyFeedback((p) => ({
        ...p,
        [action]: { type: 'error', msg: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      setSavingAction(null);
    }
  };

  /** 切换某个内置热键的启用状态（独立开关） */
  const handleToggleHotkeyEnabled = async (action: HotkeyAction, enabled: boolean) => {
    setSavingAction(action);
    try {
      await setHotkeyEnabled(action, enabled);
      // 同步本地 state
      setHotkeys((list) => list.map((h) => (h.action === action ? { ...h, enabled } : h)));
      setHotkeyFeedback((p) => ({
        ...p,
        [action]: { type: 'success', msg: enabled ? '已启用' : '已禁用' },
      }));
    } catch (e) {
      setHotkeyFeedback((p) => ({
        ...p,
        [action]: { type: 'error', msg: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      setSavingAction(null);
    }
  };

  return (
    <>
      {/* 遮罩层 */}
      <div
        className={`settings-overlay${open ? ' is-open' : ''}`}
        onClick={onClose}
        aria-hidden={!open}
        data-name="settings.overlay"
      />

      {/* 侧滑面板 */}
      <aside
        ref={asideRef}
        className={`settings-panel${open ? ' is-open' : ''}`}
        role="dialog"
        aria-label="设置"
        aria-hidden={!open}
        style={{ width: `${panelWidth}px`, maxWidth: '95vw' }}
        data-name="settings.panel-container"
      >
        {/* 左边缘拖拽条：用户可调节设置面板宽度 */}
        <div
          className={`settings-resize-handle${isDragging ? ' dragging' : ''}`}
          onMouseDown={onHandleMouseDown}
          title="拖拽调节宽度"
          data-name="settings.resize-handle"
        />
        <div className="settings-header" data-name="settings.header">
          <h2 data-name="settings.header-title">设置</h2>
          <button
            type="button"
            className="settings-close"
            aria-label="关闭"
            onClick={onClose}
            data-name="settings.close-button"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" data-name="settings.close-icon">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>

        <div className="settings-body" data-name="settings.body">
          <AppearanceSection
            tabBarCollapsed={tabBarCollapsed}
            setTabBarCollapsed={setTabBarCollapsed}
            uiScale={uiScale}
            setUiScale={setUiScale}
          />

          <GeneralSection
            startupOpen={startupOpen}
            setStartupOpen={setStartupOpen}
            closeBehavior={closeBehavior}
            setCloseBehavior={setCloseBehavior}
            enterToSend={enterToSend}
            setEnterToSend={setEnterToSend}
            defaultDesktopUaPreset={defaultDesktopUaPreset}
            setDefaultDesktopUaPreset={setDefaultDesktopUaPreset}
            defaultMobileUaPreset={defaultMobileUaPreset}
            setDefaultMobileUaPreset={setDefaultMobileUaPreset}
            appClickBehavior={appClickBehavior}
            setAppClickBehavior={setAppClickBehavior}
            usageTrackingEnabled={usageTrackingEnabled}
            setUsageTrackingEnabled={setUsageTrackingEnabled}
          />

          <TopBarSection
            visibleButtons={topBarVisibleButtons}
            onToggle={handleToggleTopBarButton}
          />

          <AiAppSection
            platforms={platforms}
            onEditApp={(profileId) => {
              void openAiAppEditor({ profileId, mode: 'edit' });
            }}
            hideForeignModels={hideForeignModels}
            onToggleHideForeignModels={handleToggleHideForeignModels}
          />

          <HotkeySection
            hotkeys={hotkeys}
            drafts={drafts}
            savingAction={savingAction}
            feedback={hotkeyFeedback}
            setDrafts={setDrafts}
            handleSaveHotkey={handleSaveHotkey}
            onToggleEnabled={handleToggleHotkeyEnabled}
            onOpenShortcuts={onOpenShortcuts}
            altSpaceResetThreshold={altSpaceResetThreshold}
            onAltSpaceThresholdChange={handleAltSpaceThresholdChange}
          />

          <PresetSection
            presets={presets}
            loading={isLoading}
            presetExpanded={presetExpanded}
            setPresetExpanded={setPresetExpanded}
            onReload={() => {
              listPresets()
                .then((list) => setPresets(list))
                .catch((e) => console.error('重新加载设备预设失败:', e));
            }}
          />

          <VoiceSection
            voiceConfirmMode={voiceConfirmMode}
            setVoiceConfirmMode={setVoiceConfirmMode}
            voiceEnterToSend={voiceEnterToSend}
            setVoiceEnterToSend={setVoiceEnterToSend}
            voiceSttMode={voiceSttMode}
            setVoiceSttMode={setVoiceSttMode}
            voiceAiProvider={voiceAiProvider}
            setVoiceAiProvider={setVoiceAiProvider}
            voiceLanguage={voiceLanguage}
            setVoiceLanguage={setVoiceLanguage}
            voiceLocalExePath={voiceLocalExePath}
            setVoiceLocalExePath={setVoiceLocalExePath}
            voiceLocalArgs={voiceLocalArgs}
            setVoiceLocalArgs={setVoiceLocalArgs}
            voiceDownloadModel={voiceDownloadModel}
            setVoiceDownloadModel={setVoiceDownloadModel}
            downloadedModels={downloadedModels}
            setDownloadedModels={setDownloadedModels}
            voiceDownloadStatus={voiceDownloadStatus}
            setVoiceDownloadStatus={setVoiceDownloadStatus}
            voiceInputDeviceId={voiceInputDeviceId}
            setVoiceInputDeviceId={setVoiceInputDeviceId}
            voiceCliDownloaded={voiceCliDownloaded}
            voiceTtsMode={voiceTtsMode}
            setVoiceTtsMode={setVoiceTtsMode}
            voiceTtsProvider={voiceTtsProvider}
            setVoiceTtsProvider={setVoiceTtsProvider}
          />

          <ProxySection
            proxyMode={proxyMode}
            setProxyMode={setProxyMode}
            customProxy={customProxy}
            setCustomProxy={setCustomProxy}
            proxyUsername={proxyUsername}
            setProxyUsername={setProxyUsername}
            proxyPassword={proxyPassword}
            setProxyPassword={setProxyPassword}
            proxyBypass={proxyBypass}
            setProxyBypass={setProxyBypass}
            proxyFallbackEnabled={proxyFallbackEnabled}
            setProxyFallbackEnabled={setProxyFallbackEnabled}
            proxyFallbackMode={proxyFallbackMode}
            setProxyFallbackMode={setProxyFallbackMode}
          />

          <StorageSection />
          <CookieSection />
          <AboutSection />
        </div>
      </aside>
    </>
  );
}
