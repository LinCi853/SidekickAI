import { useCallback, useEffect, useState } from 'react';
import {
  listAIPlatforms,
  getPresetAIPlatforms,
  getAppSettings,
  onWindowShown,
  onWindowHidden,
  onAppSettingsChanged,
  getHotkeys,
  ALL_TOP_BAR_BUTTON_GROUPS,
} from '../../../lib/electron-api';
import { useTabStore } from '../../../store/useTabStore';
import { useThemeStore } from '../../../store/useThemeStore';
import { focusInputInWebview, type WebviewLike } from '../../../hooks/useWebViewControl';
import type { AIPlatform, HotkeyConfig, TopBarButtonGroup } from '../../../lib/electron-api';

/**
 * Manages platform loading/filtering, app settings, window lifecycle events,
 * and shared UI state for the main view.
 */
export function useMainViewData() {
  // Platform state
  const [allPlatforms, setAllPlatforms] = useState<AIPlatform[]>([]);
  const [platforms, setPlatforms] = useState<AIPlatform[]>(getPresetAIPlatforms());
  const [hiddenPlatforms, setHiddenPlatforms] = useState<string[]>([]);
  const [hideForeignModels, setHideForeignModels] = useState(true);

  // Settings state
  const [isTabBarCollapsed, setIsTabBarCollapsed] = useState(true);
  const [enterToSend, setEnterToSend] = useState(true);
  const [appClickBehavior, setAppClickBehavior] = useState<'switch' | 'close'>('switch');
  const [topBarVisibleButtons, setTopBarVisibleButtons] = useState<TopBarButtonGroup[]>([...ALL_TOP_BAR_BUTTON_GROUPS]);

  // UI state
  const [hotkeys, setHotkeys] = useState<HotkeyConfig[]>([]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isNarrow, setIsNarrow] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 600 : false,
  );

  // Theme
  const isDarkTheme = useThemeStore((s) => s.resolved === 'dark');

  // Narrow resize listener
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 600);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Window focus: focus active webview input
  useEffect(() => {
    const focusActiveInput = () => {
      const activeTabId = useTabStore.getState().activeTabId;
      if (!activeTabId) return;
      const el = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as WebviewLike | null;
      if (el) {
        el?.focus?.();
        focusInputInWebview(el, null).catch((e) => console.warn('[main-view] 操作失败:', e));
      }
    };
    const offShown = onWindowShown(focusActiveInput);
    window.addEventListener('focus', focusActiveInput);
    return () => {
      offShown();
      window.removeEventListener('focus', focusActiveInput);
    };
  }, []);

  // Window hidden: collapse panels
  useEffect(() => {
    const offHidden = onWindowHidden(() => {
      useTabStore.getState().setBottomBarExpanded(false);
      setDrawerOpen(false);
      setShortcutsOpen(false);
    });
    return () => { offHidden(); };
  }, []);

  // Load hotkeys for ShortcutsModal
  useEffect(() => {
    if (!shortcutsOpen) return;
    getHotkeys()
      .then((list) => setHotkeys(list))
      .catch((e) => console.error('加载全局热键失败（ShortcutsModal）:', e));
  }, [shortcutsOpen]);

  // Filter platforms
  const filterPlatforms = useCallback(
    (list: AIPlatform[], hidden: string[], hideForeign: boolean): AIPlatform[] => {
      let result = list;
      if (hideForeign) {
        result = result.filter((p) => p.region !== 'global');
      }
      if (hidden.length > 0) {
        result = result.filter((p) => !hidden.includes(p.id));
      }
      return result;
    },
    [],
  );

  // Re-filter when hiddenPlatforms / hideForeignModels change
  useEffect(() => {
    if (allPlatforms.length === 0) {
      setPlatforms(getPresetAIPlatforms());
      return;
    }
    const filtered = filterPlatforms(allPlatforms, hiddenPlatforms, hideForeignModels);
    setPlatforms(filtered.length > 0 ? filtered : getPresetAIPlatforms());
  }, [hiddenPlatforms, hideForeignModels, allPlatforms, filterPlatforms]);

  // Initial load platforms + settings
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([listAIPlatforms(), getAppSettings()])
      .then(([platResult, appResult]) => {
        if (cancelled) return;
        if (platResult.status === 'fulfilled') {
          const platList = platResult.value;
          setAllPlatforms(platList);
          const hidden =
            appResult.status === 'fulfilled'
              ? (appResult.value.hiddenPlatforms ?? [])
              : [];
          const hideForeign =
            appResult.status === 'fulfilled'
              ? (appResult.value.hideForeignModels ?? true)
              : true;
          setHiddenPlatforms(hidden);
          setHideForeignModels(hideForeign);
          const filtered = filterPlatforms(platList, hidden, hideForeign);
          setPlatforms(filtered.length > 0 ? filtered : getPresetAIPlatforms());
          console.log(
            '[MainView] 平台列表静默更新完成:',
            platList.length, '个，过滤后:', filtered.length, '个',
          );
        } else {
          console.error('[MainView] listAIPlatforms 失败（不影响渲染）:', platResult.reason);
        }
        if (appResult.status === 'fulfilled') {
          const appCfg = appResult.value;
          setIsTabBarCollapsed(appCfg.tabBarCollapsed ?? true);
          setEnterToSend(appCfg.enterToSend ?? true);
          setTopBarVisibleButtons(appCfg.topBarVisibleButtons ?? [...ALL_TOP_BAR_BUTTON_GROUPS]);
          setAppClickBehavior(appCfg.appClickBehavior ?? 'switch');
        } else {
          console.error('[MainView] getAppSettings 失败，使用默认值:', appResult.reason);
          setIsTabBarCollapsed(true);
          setEnterToSend(true);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        console.error('[MainView] 平台/设置加载链异常（不影响渲染）:', e);
      });
    return () => { cancelled = true; };
  }, [filterPlatforms]);

  // Reload on window show
  useEffect(() => {
    const reload = () => {
      console.log('[MainView] 窗口重新显示，静默刷新平台列表...');
      Promise.allSettled([listAIPlatforms(), getAppSettings()])
        .then(([platResult, appResult]) => {
          if (platResult.status === 'fulfilled') {
            const platList = platResult.value;
            setAllPlatforms(platList);
          } else {
            console.error('[MainView] 重新加载 listAIPlatforms 失败（不影响渲染）:', platResult.reason);
          }
          if (appResult.status === 'fulfilled') {
            const cfg = appResult.value;
            setHiddenPlatforms(cfg.hiddenPlatforms ?? []);
            setHideForeignModels(cfg.hideForeignModels ?? true);
            setIsTabBarCollapsed(cfg.tabBarCollapsed ?? true);
            setEnterToSend(cfg.enterToSend ?? true);
            setTopBarVisibleButtons(cfg.topBarVisibleButtons ?? [...ALL_TOP_BAR_BUTTON_GROUPS]);
            setAppClickBehavior(cfg.appClickBehavior ?? 'switch');
          } else {
            console.error('[MainView] 重新加载 getAppSettings 失败（不影响渲染）:', appResult.reason);
          }
        })
        .catch((e) => console.error('重新加载平台列表链异常:', e));
    };
    const off = onWindowShown(reload);
    return off;
  }, [filterPlatforms]);

  // Listen for settings changed broadcast
  useEffect(() => {
    const off = onAppSettingsChanged((cfg) => {
      setIsTabBarCollapsed(cfg.tabBarCollapsed ?? true);
      setEnterToSend(cfg.enterToSend ?? true);
      setTopBarVisibleButtons(cfg.topBarVisibleButtons ?? [...ALL_TOP_BAR_BUTTON_GROUPS]);
      setAppClickBehavior(cfg.appClickBehavior ?? 'switch');
      setHiddenPlatforms(cfg.hiddenPlatforms ?? []);
      setHideForeignModels(cfg.hideForeignModels ?? true);
    });
    return off;
  }, []);

  // Reload settings on focus
  useEffect(() => {
    getAppSettings()
      .then((cfg) => {
        const hiddenChanged = JSON.stringify(cfg.hiddenPlatforms ?? []) !== JSON.stringify(hiddenPlatforms);
        if (hiddenChanged) setHiddenPlatforms(cfg.hiddenPlatforms ?? []);
        const foreignChanged = (cfg.hideForeignModels ?? true) !== hideForeignModels;
        if (foreignChanged) setHideForeignModels(cfg.hideForeignModels ?? true);
        setIsTabBarCollapsed(cfg.tabBarCollapsed ?? true);
        setEnterToSend(cfg.enterToSend ?? true);
        setTopBarVisibleButtons(cfg.topBarVisibleButtons ?? [...ALL_TOP_BAR_BUTTON_GROUPS]);
        setAppClickBehavior(cfg.appClickBehavior ?? 'switch');
      })
      .catch((e) => console.warn('[main-view] 操作失败:', e));
  }, [hiddenPlatforms, hideForeignModels]);

  return {
    // Platform
    platforms,
    setPlatforms,
    allPlatforms,
    hiddenPlatforms,
    hideForeignModels,
    // Settings
    isTabBarCollapsed,
    enterToSend,
    appClickBehavior,
    topBarVisibleButtons,
    // UI
    hotkeys,
    shortcutsOpen,
    setShortcutsOpen,
    drawerOpen,
    setDrawerOpen,
    isNarrow,
    isDarkTheme,
  };
}
