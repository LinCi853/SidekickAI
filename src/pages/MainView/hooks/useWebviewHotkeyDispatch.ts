import { useEffect } from 'react';
import { onWebviewHotkey } from '../../../lib/electron-api';
import { useTabStore } from '../../../store/useTabStore';
import { useProfileStore } from '../../../store/useProfileStore';
import { useThemeStore } from '../../../store/useThemeStore';
import { safeReloadWebview, type WebviewElement } from '../../../lib/webview';
import { focusInputInWebview } from '../../../hooks/useWebViewControl';
import { AI_PLATFORMS } from '../../../../electron/presets/ai-platforms';

/**
 * Dispatches webview hotkey events (forwarded from main process) to the appropriate handlers.
 * Handles: switchTab, cycleTab, toggleSpatialNav, openShortcuts, toggleTheme,
 * navBack/Forward/Refresh, detachCurrent, newTab, closeTab.
 */
export function useWebviewHotkeyDispatch(
  addTab: (profile: import('../../../lib/electron-api').Profile) => void,
  closeTab: (id: string) => void,
  detachTab: (id: string) => void,
  setShortcutsOpen: (open: boolean) => void,
  activeTabDomReadyRef: React.MutableRefObject<boolean>,
) {
  useEffect(() => {
    const off = onWebviewHotkey((payload) => {
      console.log('[MainView] 收到 webview 快捷键转发:', payload);
      const store = useTabStore.getState();
      if (payload.action === 'switchTab') {
        const index = (payload.data as { index: number })?.index;
        if (typeof index === 'number') {
          const tab = store.tabs[index];
          if (tab) store.setActiveTab(tab.id);
        }
      } else if (payload.action === 'cycleTab') {
        const reverse = (payload.data as { reverse?: boolean })?.reverse;
        const { tabs, activeTabId } = store;
        if (tabs.length > 0) {
          const curIdx = tabs.findIndex((t) => t.id === activeTabId);
          const nextIdx = reverse
            ? curIdx < 0 ? 0 : (curIdx - 1 + tabs.length) % tabs.length
            : curIdx < 0 ? 0 : (curIdx + 1) % tabs.length;
          store.setActiveTab(tabs[nextIdx].id);
        }
      } else if (payload.action === 'toggleSpatialNav') {
        const activeTabId = store.activeTabId;
        if (!activeTabId) return;
        const wv = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as WebviewElement | null;
        if (!wv) return;
        wv.executeJavaScript(
          'window.__ai_spatial_nav__ && window.__ai_spatial_nav__.toggle(!window.__ai_spatial_nav__.isEnabled())',
        ).catch((e) => console.warn('[main-view] 操作失败:', e));
      } else if (payload.action === 'openShortcuts') {
        setShortcutsOpen(true);
      } else if (payload.action === 'toggleTheme') {
        useThemeStore.getState().toggleTheme();
      } else if (payload.action === 'navBack' || payload.action === 'navForward' || payload.action === 'navRefresh' || payload.action === 'forceRefresh') {
        const activeTabId = store.activeTabId;
        if (!activeTabId) return;
        const wv = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as WebviewElement | null;
        if (!wv) return;
        try {
          if (payload.action === 'navBack' && wv.canGoBack()) wv.goBack();
          else if (payload.action === 'navForward' && wv.canGoForward()) wv.goForward();
          else if (payload.action === 'navRefresh') {
            const tab = store.tabs.find((t) => t.id === activeTabId);
            const prof = tab ? useProfileStore.getState().profiles.find((p) => p.id === tab.profileId) : null;
            const url = (tab?.url || prof?.aiPlatformUrl || '') as string;
            safeReloadWebview(wv, url, activeTabDomReadyRef.current);
          } else if (payload.action === 'forceRefresh') {
            // 强制刷新：清除缓存重新加载
            const wvWithReload = wv as WebviewElement & { reloadIgnoringCache?: () => void };
            if (typeof wvWithReload.reloadIgnoringCache === 'function') {
              wvWithReload.reloadIgnoringCache();
            } else {
              wv.reload();
            }
          }
        } catch (e) {
          console.error(`[MainView] ${payload.action} 失败:`, e);
        }
      } else if (payload.action === 'detachCurrent') {
        if (store.activeTabId) void detachTab(store.activeTabId);
      } else if (payload.action === 'newTab') {
        const { profiles } = useProfileStore.getState();
        const target =
          profiles.find((p) => p.isAIPlatform && p.aiPlatformUrl?.includes('deepseek')) ??
          profiles.find((p) => p.isAIPlatform) ??
          profiles[0];
        if (target) void addTab(target);
      } else if (payload.action === 'closeTab') {
        if (store.activeTabId) void closeTab(store.activeTabId);
      } else if (payload.action === 'focusCycle') {
        // 主窗口：聚焦当前 webview 内的 AI 输入框
        const activeTabId = store.activeTabId;
        if (!activeTabId) return;
        const wv = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as WebviewElement | null;
        if (!wv) return;
        const tab = store.tabs.find((t) => t.id === activeTabId);
        const profile = tab ? useProfileStore.getState().profiles.find((p) => p.id === tab.profileId) : null;
        const platform = profile?.aiPlatformId
          ? AI_PLATFORMS.find((p) => p.id === profile.aiPlatformId)
          : null;
        const selector = profile?.aiInputSelector || platform?.inputSelector || null;
        wv.focus?.();
        void focusInputInWebview(wv, selector);
      }
    });
    return off;
  }, [addTab, closeTab, detachTab, setShortcutsOpen, activeTabDomReadyRef]);
}
