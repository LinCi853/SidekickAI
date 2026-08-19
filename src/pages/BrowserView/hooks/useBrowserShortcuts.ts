/* =====================================================================
   pages/BrowserView/hooks/useBrowserShortcuts.ts —— 浏览器窗口快捷键绑定
   职责：
   - useBrowserKeyboard（统一快捷键注册）
   - Ctrl+Alt+C 宿主焦点兜底（不依赖快捷键注册表 enabled 状态）
   - 主进程 before-input-event 转发的 Ctrl+W（closeTab）/ F6（focusCycle）
   - 主进程 F12 / 菜单触发的 DevTools 切换
   ===================================================================== */

import { useEffect, type MutableRefObject } from 'react';
import { useBrowserKeyboard } from '../useBrowserKeyboard.js';
import { useBrowserTabStore } from '../../../store/useBrowserTabStore.js';
import { useModuleStore } from '../../../store/useModuleStore.js';
import { onWebviewHotkey, onToggleDevTools, maximizeToggleWindow } from '../../../lib/electron-api/index.js';

interface UseBrowserShortcutsParams {
  addressBarRef: MutableRefObject<HTMLInputElement | null>;
  bookmarkBarVisible: boolean;
  setBookmarkBarVisible: (visible: boolean) => void;
  isFullscreen: boolean;
  isCloudPc: boolean;
  handleRefresh: () => void;
  handleGoBack: () => void;
  handleGoForward: () => void;
  handleStopLoading: () => void;
  handleForceRefresh: () => void;
  handleToggleDevTools: () => void;
  handleToggleFullscreen: () => void;
  handleExitFullscreen: () => void;
  handleFocusCycle: () => void;
  focusCycleRef: MutableRefObject<() => void>;
  handleAddBookmark: () => void;
  handleFocusSearch: () => void;
  handleFindInPage: () => void;
  handlePrint: () => void;
  handleSavePageAs: () => void;
  handleViewSource: () => void;
  zoomInAction: () => void;
  zoomOutAction: () => void;
  zoomResetAction: () => void;
  toggleCloudPc: () => void;
  handleToggleSpatialNav: () => void;
  handleToggleFreeze: (tabId?: string) => void;
}

export function useBrowserShortcuts(p: UseBrowserShortcutsParams): void {
  // Ctrl+Alt+C 宿主焦点兜底：不依赖快捷键注册表的 enabled 状态，
  // 保证任意状态下都能进入/退出云电脑模式（webview 焦点由主进程转发处理）。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && e.code === 'KeyC') {
        e.preventDefault();
        e.stopImmediatePropagation();
        p.toggleCloudPc();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [p.toggleCloudPc]);

  useBrowserKeyboard({
    onFocusAddressBar: () => p.addressBarRef.current?.focus(),
    onRefresh: p.handleRefresh,
    onForceRefresh: p.handleForceRefresh,
    onGoBack: p.handleGoBack,
    onGoForward: p.handleGoForward,
    onStopLoading: p.handleStopLoading,
    onMaximize: () => { void maximizeToggleWindow(); },
    onToggleDevTools: p.handleToggleDevTools,
    onToggleFullscreen: p.handleToggleFullscreen,
    onExitFullscreen: p.handleExitFullscreen,
    isFullscreen: p.isFullscreen,
    onToggleCloudPc: p.toggleCloudPc,
    onToggleSpatialNav: p.handleToggleSpatialNav,
    enabled: !p.isCloudPc,
    onToggleBookmarkBar: () => p.setBookmarkBarVisible(!p.bookmarkBarVisible),
    onFocusCycle: p.handleFocusCycle,
    onAddBookmark: p.handleAddBookmark,
    onFocusSearch: p.handleFocusSearch,
    onFindInPage: p.handleFindInPage,
    onPrint: p.handlePrint,
    onSaveAsPage: p.handleSavePageAs,
    onViewSource: p.handleViewSource,
    onZoomIn: p.zoomInAction,
    onZoomOut: p.zoomOutAction,
    onZoomReset: p.zoomResetAction,
    onToggleFreeze: useModuleStore.getState().isEnabled('freeze') ? p.handleToggleFreeze : undefined,
  });

  // v0.0.9 B4：接收主进程 before-input-event 转发的 Ctrl+W（closeTab），
  // 确保浏览器窗口任意位置（含 webview 焦点）都能关闭当前标签。
  useEffect(() => {
    const off = onWebviewHotkey((payload) => {
      if (payload.action === 'closeTab') {
        const store = useBrowserTabStore.getState();
        if (store.activeTabId) void store.closeTab(store.activeTabId);
      } else if (payload.action === 'focusCycle') {
        p.focusCycleRef.current();
      }
    });
    return off;
  }, [p.focusCycleRef]);

  useEffect(() => {
    const offDevTools = onToggleDevTools(p.handleToggleDevTools);
    return () => { offDevTools(); };
  }, [p.handleToggleDevTools]);
}
