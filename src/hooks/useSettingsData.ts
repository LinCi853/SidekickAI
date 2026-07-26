/* =====================================================================
   hooks/useSettingsData.ts —— 设置面板状态管理 Hook 集合
   将 SettingsPanel/index.tsx 的 50+ useState 按数据域拆分，便于复用与测试。
   ===================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  getAppSettings,
  updateAppSettings,
  getVoiceConfig,
  setVoiceConfig,
  getHotkeys,
  setHotkeyFor,
  setHotkeyEnabled,
  listPresets,
  listAIPlatforms,
  ALL_TOP_BAR_BUTTON_GROUPS,
} from '../lib/electron-api';
import type {
  AppSettings,
  DevicePreset,
  HotkeyConfig,
  HotkeyAction,
  AIPlatform,
  TopBarButtonGroup,
  VoiceConfig,
} from '../lib/electron-api';

/* =====================================================================
   useAppSettings —— app-settings-store 的所有字段
   ===================================================================== */

export interface AppSettingsState {
  // 外观
  tabBarCollapsed: boolean;
  setTabBarCollapsed: Dispatch<SetStateAction<boolean>>;
  uiScale: 'small' | 'medium' | 'large';
  setUiScale: Dispatch<SetStateAction<'small' | 'medium' | 'large'>>;
  // 通用
  enterToSend: boolean;
  setEnterToSend: Dispatch<SetStateAction<boolean>>;
  defaultDesktopUaPreset: string;
  setDefaultDesktopUaPreset: Dispatch<SetStateAction<string>>;
  defaultMobileUaPreset: string;
  setDefaultMobileUaPreset: Dispatch<SetStateAction<string>>;
  closeBehavior: 'close' | 'minimize';
  setCloseBehavior: Dispatch<SetStateAction<'close' | 'minimize'>>;
  startupOpen: 'home' | 'lastConversation';
  setStartupOpen: Dispatch<SetStateAction<'home' | 'lastConversation'>>;
  appClickBehavior: 'switch' | 'close';
  setAppClickBehavior: Dispatch<SetStateAction<'switch' | 'close'>>;
  usageTrackingEnabled: boolean;
  setUsageTrackingEnabled: Dispatch<SetStateAction<boolean>>;
  // 代理
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
  proxyFallbackEnabled: boolean;
  setProxyFallbackEnabled: Dispatch<SetStateAction<boolean>>;
  proxyFallbackMode: 'direct' | 'system';
  setProxyFallbackMode: Dispatch<SetStateAction<'direct' | 'system'>>;
  // 平台与模型
  hiddenPlatforms: string[];
  setHiddenPlatforms: Dispatch<SetStateAction<string[]>>;
  hideForeignModels: boolean;
  setHideForeignModels: Dispatch<SetStateAction<boolean>>;
  // 顶栏
  topBarVisibleButtons: TopBarButtonGroup[];
  setTopBarVisibleButtons: Dispatch<SetStateAction<TopBarButtonGroup[]>>;
  // 其他
  altSpaceResetThreshold: number;
  setAltSpaceResetThreshold: Dispatch<SetStateAction<number>>;
  defaultAdvancedPanelTab: 'chat' | 'whiteboard' | 'notes';
  setDefaultAdvancedPanelTab: Dispatch<SetStateAction<'chat' | 'whiteboard' | 'notes'>>;
  // 加载与持久化
  load: () => Promise<void>;
  /** 更新单个或多个字段并持久化到主进程 */
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

export function useAppSettings(enabled: boolean): AppSettingsState {
  const [tabBarCollapsed, setTabBarCollapsed] = useState(true);
  const [uiScale, setUiScale] = useState<'small' | 'medium' | 'large'>('medium');
  const [enterToSend, setEnterToSend] = useState(true);
  const [defaultDesktopUaPreset, setDefaultDesktopUaPreset] = useState('win-chrome-125');
  const [defaultMobileUaPreset, setDefaultMobileUaPreset] = useState('iphone-15-pro-safari');
  const [closeBehavior, setCloseBehavior] = useState<'close' | 'minimize'>('close');
  const [startupOpen, setStartupOpen] = useState<'home' | 'lastConversation'>('home');
  const [appClickBehavior, setAppClickBehavior] = useState<'switch' | 'close'>('switch');
  const [usageTrackingEnabled, setUsageTrackingEnabled] = useState(true);
  const [proxyMode, setProxyMode] = useState<'system' | 'direct' | 'custom'>('system');
  const [customProxy, setCustomProxy] = useState('');
  const [proxyUsername, setProxyUsername] = useState('');
  const [proxyPassword, setProxyPassword] = useState('');
  const [proxyBypass, setProxyBypass] = useState('');
  const [proxyFallbackEnabled, setProxyFallbackEnabled] = useState(false);
  const [proxyFallbackMode, setProxyFallbackMode] = useState<'direct' | 'system'>('direct');
  const [hiddenPlatforms, setHiddenPlatforms] = useState<string[]>([]);
  const [hideForeignModels, setHideForeignModels] = useState(true);
  const [topBarVisibleButtons, setTopBarVisibleButtons] = useState<TopBarButtonGroup[]>([
    ...ALL_TOP_BAR_BUTTON_GROUPS,
  ]);
  const [altSpaceResetThreshold, setAltSpaceResetThreshold] = useState(6);
  const [defaultAdvancedPanelTab, setDefaultAdvancedPanelTab] = useState<'chat' | 'whiteboard' | 'notes'>('chat');

  const load = useCallback(async () => {
    try {
      const cfg = await getAppSettings();
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
      setDefaultAdvancedPanelTab(cfg.defaultAdvancedPanelTab ?? 'chat');
    } catch (e) {
      console.error('[useAppSettings] 加载失败:', e);
    }
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  const update = useCallback(async (patch: Partial<AppSettings>) => {
    await updateAppSettings(patch);
  }, []);

  return {
    tabBarCollapsed, setTabBarCollapsed,
    uiScale, setUiScale,
    enterToSend, setEnterToSend,
    defaultDesktopUaPreset, setDefaultDesktopUaPreset,
    defaultMobileUaPreset, setDefaultMobileUaPreset,
    closeBehavior, setCloseBehavior,
    startupOpen, setStartupOpen,
    appClickBehavior, setAppClickBehavior,
    usageTrackingEnabled, setUsageTrackingEnabled,
    proxyMode, setProxyMode,
    customProxy, setCustomProxy,
    proxyUsername, setProxyUsername,
    proxyPassword, setProxyPassword,
    proxyBypass, setProxyBypass,
    proxyFallbackEnabled, setProxyFallbackEnabled,
    proxyFallbackMode, setProxyFallbackMode,
    hiddenPlatforms, setHiddenPlatforms,
    hideForeignModels, setHideForeignModels,
    topBarVisibleButtons, setTopBarVisibleButtons,
    altSpaceResetThreshold, setAltSpaceResetThreshold,
    defaultAdvancedPanelTab, setDefaultAdvancedPanelTab,
    load,
    update,
  };
}

/* =====================================================================
   useVoiceConfig —— voice-store 的所有字段
   ===================================================================== */

export interface VoiceConfigState {
  confirmMode: 'auto' | 'manual' | 'clipboard';
  setConfirmMode: Dispatch<SetStateAction<'auto' | 'manual' | 'clipboard'>>;
  enterToSend: boolean;
  setEnterToSend: Dispatch<SetStateAction<boolean>>;
  sttMode: 'builtin' | 'ai' | 'local' | 'download';
  setSttMode: Dispatch<SetStateAction<'builtin' | 'ai' | 'local' | 'download'>>;
  aiProvider: string;
  setAiProvider: Dispatch<SetStateAction<string>>;
  language: string;
  setLanguage: Dispatch<SetStateAction<string>>;
  inputDeviceId: string;
  setInputDeviceId: Dispatch<SetStateAction<string>>;
  localExePath: string;
  setLocalExePath: Dispatch<SetStateAction<string>>;
  localArgs: string;
  setLocalArgs: Dispatch<SetStateAction<string>>;
  downloadModel: string;
  setDownloadModel: Dispatch<SetStateAction<string>>;
  downloadedModels: string[];
  setDownloadedModels: Dispatch<SetStateAction<string[]>>;
  downloadStatus: string;
  setDownloadStatus: Dispatch<SetStateAction<string>>;
  cliDownloaded: boolean;
  setCliDownloaded: Dispatch<SetStateAction<boolean>>;
  ttsMode: 'disable' | 'ai';
  setTtsMode: Dispatch<SetStateAction<'disable' | 'ai'>>;
  ttsProvider: string;
  setTtsProvider: Dispatch<SetStateAction<string>>;
  load: () => Promise<void>;
  update: (patch: Partial<VoiceConfig>) => Promise<void>;
}

export function useVoiceConfig(enabled: boolean): VoiceConfigState {
  const [confirmMode, setConfirmMode] = useState<'auto' | 'manual' | 'clipboard'>('auto');
  const [enterToSend, setEnterToSend] = useState(false);
  const [sttMode, setSttMode] = useState<'builtin' | 'ai' | 'local' | 'download'>('builtin');
  const [aiProvider, setAiProvider] = useState('openai');
  const [language, setLanguage] = useState('zh');
  const [inputDeviceId, setInputDeviceId] = useState('');
  const [localExePath, setLocalExePath] = useState('');
  const [localArgs, setLocalArgs] = useState('');
  const [downloadModel, setDownloadModel] = useState('');
  const [downloadedModels, setDownloadedModels] = useState<string[]>([]);
  const [downloadStatus, setDownloadStatus] = useState('idle');
  const [cliDownloaded, setCliDownloaded] = useState(false);
  const [ttsMode, setTtsMode] = useState<'disable' | 'ai'>('disable');
  const [ttsProvider, setTtsProvider] = useState('openai');

  const load = useCallback(async () => {
    try {
      const cfg = await getVoiceConfig();
      setConfirmMode(cfg.confirmMode ?? 'auto');
      setEnterToSend(cfg.enterToSend ?? true);
      setSttMode(cfg.sttMode ?? 'builtin');
      setAiProvider(cfg.aiProvider ?? 'openai');
      setLanguage(cfg.language ?? 'zh');
      setInputDeviceId(cfg.inputDeviceId ?? '');
      setLocalExePath(cfg.localExePath ?? '');
      setLocalArgs(cfg.localArgs ?? '');
      setDownloadModel(cfg.downloadModel ?? '');
      setDownloadedModels(Array.isArray(cfg.downloadedModels) ? cfg.downloadedModels : []);
      setDownloadStatus(cfg.downloadStatus ?? 'idle');
      setCliDownloaded(Boolean(cfg.cliDownloaded));
      setTtsMode(cfg.ttsMode ?? 'disable');
      setTtsProvider(cfg.ttsProvider ?? 'openai');
    } catch (e) {
      console.error('[useVoiceConfig] 加载失败:', e);
    }
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  const update = useCallback(async (patch: Partial<VoiceConfig>) => {
    await setVoiceConfig(patch);
  }, []);

  return {
    confirmMode, setConfirmMode,
    enterToSend, setEnterToSend,
    sttMode, setSttMode,
    aiProvider, setAiProvider,
    language, setLanguage,
    inputDeviceId, setInputDeviceId,
    localExePath, setLocalExePath,
    localArgs, setLocalArgs,
    downloadModel, setDownloadModel,
    downloadedModels, setDownloadedModels,
    downloadStatus, setDownloadStatus,
    cliDownloaded, setCliDownloaded,
    ttsMode, setTtsMode,
    ttsProvider, setTtsProvider,
    load,
    update,
  };
}

/* =====================================================================
   useHotkeys —— 热键配置
   ===================================================================== */

export interface HotkeysState {
  hotkeys: HotkeyConfig[];
  setHotkeys: Dispatch<SetStateAction<HotkeyConfig[]>>;
  drafts: Record<string, string>;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  savingAction: HotkeyAction | null;
  setSavingAction: Dispatch<SetStateAction<HotkeyAction | null>>;
  feedback: Record<string, { type: 'success' | 'error'; msg: string } | null>;
  setFeedback: Dispatch<SetStateAction<Record<string, { type: 'success' | 'error'; msg: string } | null>>>;
  load: () => Promise<void>;
  saveHotkey: (action: HotkeyAction) => Promise<void>;
  toggleEnabled: (action: HotkeyAction, enabled: boolean) => Promise<void>;
}

export function useHotkeys(enabled: boolean): HotkeysState {
  const [hotkeys, setHotkeys] = useState<HotkeyConfig[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingAction, setSavingAction] = useState<HotkeyAction | null>(null);
  const [feedback, setFeedback] = useState<
    Record<string, { type: 'success' | 'error'; msg: string } | null>
  >({});

  const load = useCallback(async () => {
    try {
      const list = await getHotkeys();
      setHotkeys(list);
      const draftMap: Record<string, string> = {};
      for (const h of list) draftMap[h.action] = h.accelerator;
      setDrafts(draftMap);
      setFeedback({});
    } catch (e) {
      console.error('[useHotkeys] 加载失败:', e);
    }
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  const saveHotkey = useCallback(
    async (action: HotkeyAction) => {
      const acc = (drafts[action] ?? '').trim();
      if (!acc) {
        setFeedback((p) => ({ ...p, [action]: { type: 'error', msg: '热键不能为空' } }));
        return;
      }
      setSavingAction(action);
      setFeedback((p) => ({ ...p, [action]: null }));
      try {
        const current = hotkeys.find((h) => h.action === action);
        if (current && !current.enabled) {
          await setHotkeyEnabled(action, true);
        }
        const ok = await setHotkeyFor(action, acc);
        if (ok) {
          setHotkeys((list) =>
            list.map((h) => (h.action === action ? { ...h, accelerator: acc, enabled: true } : h)),
          );
          setFeedback((p) => ({ ...p, [action]: { type: 'success', msg: '已保存并生效' } }));
        } else {
          const currentAcc = current?.accelerator ?? '';
          setDrafts((p) => ({ ...p, [action]: currentAcc }));
          setFeedback((p) => ({
            ...p,
            [action]: { type: 'error', msg: '注册失败（可能被其他应用占用），已恢复原热键' },
          }));
        }
      } catch (e) {
        setFeedback((p) => ({
          ...p,
          [action]: { type: 'error', msg: e instanceof Error ? e.message : String(e) },
        }));
      } finally {
        setSavingAction(null);
      }
    },
    [drafts, hotkeys],
  );

  const toggleEnabled = useCallback(
    async (action: HotkeyAction, enabled: boolean) => {
      setSavingAction(action);
      try {
        await setHotkeyEnabled(action, enabled);
        setHotkeys((list) => list.map((h) => (h.action === action ? { ...h, enabled } : h)));
        setFeedback((p) => ({
          ...p,
          [action]: { type: 'success', msg: enabled ? '已启用' : '已禁用' },
        }));
      } catch (e) {
        setFeedback((p) => ({
          ...p,
          [action]: { type: 'error', msg: e instanceof Error ? e.message : String(e) },
        }));
      } finally {
        setSavingAction(null);
      }
    },
    [],
  );

  return {
    hotkeys, setHotkeys,
    drafts, setDrafts,
    savingAction, setSavingAction,
    feedback, setFeedback,
    load,
    saveHotkey,
    toggleEnabled,
  };
}

/* =====================================================================
   usePresets —— 设备预设 + AI 平台列表
   ===================================================================== */

export interface PresetsState {
  presets: DevicePreset[];
  setPresets: Dispatch<SetStateAction<DevicePreset[]>>;
  isLoading: boolean;
  platforms: AIPlatform[];
  setPlatforms: Dispatch<SetStateAction<AIPlatform[]>>;
  load: () => Promise<void>;
}

export function usePresets(enabled: boolean): PresetsState {
  const [presets, setPresets] = useState<DevicePreset[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [platforms, setPlatforms] = useState<AIPlatform[]>([]);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [presetList, platformList] = await Promise.all([listPresets(), listAIPlatforms()]);
      setPresets(presetList);
      setPlatforms(platformList);
    } catch (e) {
      console.error('[usePresets] 加载失败:', e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled && presets.length === 0) void load();
  }, [enabled, presets.length, load]);

  return {
    presets, setPresets,
    isLoading,
    platforms, setPlatforms,
    load,
  };
}

/* =====================================================================
   useSettingsDraft —— 完整的「load + local copy + patch + rollback」模式
   提供持久化设置的草稿副本，支持局部更新、差异保存与回滚。
   - settings: 当前持久化的设置（从主进程加载）
   - draft:    本地草稿副本，可在 UI 中即时修改
   - setDraft: 部分更新草稿（不持久化）
   - save:     仅将草稿与 settings 的差异字段持久化到主进程
   - reset:    草稿回滚到 settings
   适用于「即时保存」（setDraft + updateAppSettings）或「编辑后保存」（setDraft + save）两种模式。
   ===================================================================== */

export interface UseSettingsDraftResult {
  /** 当前持久化的设置（从主进程加载） */
  settings: AppSettings | null;
  /** 本地草稿副本 */
  draft: AppSettings | null;
  /** 部分更新草稿（不持久化） */
  setDraft: (patch: Partial<AppSettings>) => void;
  /** 草稿与 settings 是否有差异 */
  isDirty: boolean;
  /** 是否正在加载 */
  loading: boolean;
  /** 重新从主进程加载 */
  reload: () => Promise<void>;
  /** 保存草稿到主进程（仅保存差异字段） */
  save: () => Promise<void>;
  /** 草稿回滚到 settings */
  reset: () => void;
}

export function useSettingsDraft(enabled = true): UseSettingsDraftResult {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraftState] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(false);

  // 使用 ref 保存最新值，使 save() 能在 setDraft 之后立即读到最新草稿
  const settingsRef = useRef<AppSettings | null>(null);
  const draftRef = useRef<AppSettings | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const cfg = await getAppSettings();
      settingsRef.current = cfg;
      draftRef.current = cfg;
      setSettings(cfg);
      setDraftState(cfg);
    } catch (e) {
      console.error('[useSettingsDraft] 加载失败:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  const setDraft = useCallback((patch: Partial<AppSettings>) => {
    const prev = draftRef.current;
    if (!prev) return;
    const next = { ...prev, ...patch };
    draftRef.current = next;
    setDraftState(next);
  }, []);

  const isDirty = useMemo(() => {
    if (!settings || !draft) return false;
    const keys = new Set<string>([...Object.keys(settings), ...Object.keys(draft)]);
    for (const key of keys) {
      const k = key as keyof AppSettings;
      if (settings[k] !== draft[k]) return true;
    }
    return false;
  }, [settings, draft]);

  const save = useCallback(async () => {
    const currentDraft = draftRef.current;
    const currentSettings = settingsRef.current;
    if (!currentDraft || !currentSettings) return;
    const diff: Partial<AppSettings> = {};
    const keys = new Set<string>([
      ...Object.keys(currentSettings),
      ...Object.keys(currentDraft),
    ]);
    for (const key of keys) {
      const k = key as keyof AppSettings;
      if (currentDraft[k] !== currentSettings[k]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (diff as any)[k] = currentDraft[k];
      }
    }
    if (Object.keys(diff).length === 0) return;
    await updateAppSettings(diff);
    settingsRef.current = currentDraft;
    setSettings(currentDraft);
  }, []);

  const reset = useCallback(() => {
    const currentSettings = settingsRef.current;
    if (!currentSettings) return;
    draftRef.current = currentSettings;
    setDraftState(currentSettings);
  }, []);

  return {
    settings,
    draft,
    setDraft,
    isDirty,
    loading,
    reload,
    save,
    reset,
  };
}
