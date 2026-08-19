/* =====================================================================
   pages/BrowserView/hooks/useWebviewLifecycle.ts —— webview 生命周期
   抽取自 BrowserWebviewTab.tsx：15 个事件监听器（含注册/注销）、
   致命失败 remount、冻结注册表注册、F12 DevTools 与文件拖放上报。
   ===================================================================== */

import { useCallback, useEffect } from 'react';
import type { BrowserTabState, Profile } from '../../../lib/electron-api';
import { registerFreezeWebview } from '../../../lib/electron-api';
import type { WebviewElement } from '../../../lib/webview.js';
import { useFreezeStore } from '../../../store/useFreezeStore.js';

export interface UseWebviewLifecycleHandlers {
  handleDomReady: () => Promise<void>;
  handleNavigate: (e: Event) => void;
  handleTitleUpdate: (e: Event) => void;
  handleFaviconUpdate: (e: Event) => void;
  handleStartLoading: () => void;
  handleStopLoading: () => void;
  handleFinishNavigation: () => void;
  handleFinishLoad: () => void;
  handleFailLoad: () => void;
  handleMediaStartedPlaying: () => void;
  handleMediaPaused: () => void;
}

export interface UseWebviewLifecycleParams {
  webviewRef: React.MutableRefObject<WebviewElement | null>;
  domReadyRef: React.MutableRefObject<boolean>;
  remountKey: number;
  setRemountKey: React.Dispatch<React.SetStateAction<number>>;
  tab: BrowserTabState;
  profile: Profile;
  handlers: UseWebviewLifecycleHandlers;
}

export function useWebviewLifecycle({
  webviewRef,
  domReadyRef,
  remountKey,
  setRemountKey,
  tab,
  profile,
  handlers,
}: UseWebviewLifecycleParams) {
  const {
    handleDomReady,
    handleNavigate,
    handleTitleUpdate,
    handleFaviconUpdate,
    handleStartLoading,
    handleStopLoading,
    handleFinishNavigation,
    handleFinishLoad,
    handleFailLoad,
    handleMediaStartedPlaying,
    handleMediaPaused,
  } = handlers;

  // Remount on fatal failure
  const handleFatalFailure = useCallback(() => {
    console.warn('[BrowserWebviewTab] fatal failure, remounting:', tab.url);
    domReadyRef.current = false;
    setRemountKey((k) => k + 1);
  }, [tab.url]);

  // Register event listeners
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    webview.addEventListener('dom-ready', handleDomReady as EventListener);
    webview.addEventListener('did-navigate', handleNavigate as EventListener);
    webview.addEventListener('did-navigate-in-page', handleNavigate as EventListener);
    webview.addEventListener('page-title-updated', handleTitleUpdate as EventListener);
    webview.addEventListener('page-favicon-updated', handleFaviconUpdate as EventListener);
    webview.addEventListener('did-start-loading', handleStartLoading as EventListener);
    webview.addEventListener('did-stop-loading', handleStopLoading as EventListener);
    // B2: NavBar 进度条 —— 导航完成与页面完全加载事件
    webview.addEventListener('did-finish-navigation', handleFinishNavigation as EventListener);
    webview.addEventListener('did-finish-load', handleFinishLoad as EventListener);
    webview.addEventListener('did-fail-load', handleFailLoad as EventListener);

    // v0.0.9 音频事件（webview 的 media-started-playing / media-paused）
    webview.addEventListener('media-started-playing', handleMediaStartedPlaying as EventListener);
    webview.addEventListener('media-paused', handleMediaPaused as EventListener);

    // 本地文件拖放桥：guest 上报文件路径 → 宿主打开查看
    const handleConsoleMessage = (e: Event) => {
      const msg = (e as unknown as { message?: string }).message || '';
      if (!msg.startsWith('__SK_FILEDROP__:')) return;
      try {
        const paths = JSON.parse(msg.slice('__SK_FILEDROP__:'.length)) as string[];
        if (Array.isArray(paths) && paths.length > 0) {
          window.dispatchEvent(new CustomEvent('browser-local-files-drop', { detail: { paths } }));
        }
      } catch { /* ignore */ }
    };
    webview.addEventListener('console-message', handleConsoleMessage as EventListener);

    webview.addEventListener('ai-webview-fatal-failure', handleFatalFailure);

    // F12 → DevTools
    const handleBeforeInput = (e: Event) => {
      const inputEvent = e as unknown as { type: string; key: string; modifiers: string[] };
      if (inputEvent.type !== 'keyDown') return;
      if (inputEvent.key === 'F12') {
        e.preventDefault();
        if (useFreezeStore.getState().states[tab.id] === 'frozen') return;
        const wv = webview as unknown as {
          isDevToolsOpened: () => boolean;
          openDevTools: () => void;
          closeDevTools: () => void;
        };
        if (wv.isDevToolsOpened()) {
          wv.closeDevTools();
        } else {
          wv.openDevTools();
        }
      }
    };
    webview.addEventListener('before-input-event', handleBeforeInput);

    return () => {
      webview.removeEventListener('dom-ready', handleDomReady as EventListener);
      webview.removeEventListener('did-navigate', handleNavigate as EventListener);
      webview.removeEventListener('did-navigate-in-page', handleNavigate as EventListener);
      webview.removeEventListener('page-title-updated', handleTitleUpdate as EventListener);
      webview.removeEventListener('page-favicon-updated', handleFaviconUpdate as EventListener);
      webview.removeEventListener('did-start-loading', handleStartLoading as EventListener);
      webview.removeEventListener('did-stop-loading', handleStopLoading as EventListener);
      webview.removeEventListener('did-finish-navigation', handleFinishNavigation as EventListener);
      webview.removeEventListener('did-finish-load', handleFinishLoad as EventListener);
      webview.removeEventListener('did-fail-load', handleFailLoad as EventListener);
      webview.removeEventListener('media-started-playing', handleMediaStartedPlaying as EventListener);
      webview.removeEventListener('media-paused', handleMediaPaused as EventListener);
      webview.removeEventListener('console-message', handleConsoleMessage as EventListener);
      webview.removeEventListener('ai-webview-fatal-failure', handleFatalFailure);
      webview.removeEventListener('before-input-event', handleBeforeInput);
    };
  }, [handleDomReady, handleNavigate, handleTitleUpdate, handleFaviconUpdate, handleStartLoading, handleStopLoading, handleFinishNavigation, handleFinishLoad, handleFailLoad, handleFatalFailure, handleMediaStartedPlaying, handleMediaPaused, tab.id, remountKey]);

  // 注册 webview 到冻结注册表（did-attach 后 webContentsId 可用）
  // 防撤回保险：主进程按 tabId 查找 guest webContents 执行 Debugger.pause
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const register = () => {
      try {
        const wcId = webview.getWebContentsId?.();
        if (wcId === undefined) return;
        void registerFreezeWebview({
          tabId: tab.id,
          windowId: 'browser', // 浏览器窗口的 windowId 由主进程按 profileId 索引，此处占位
          profileId: profile.id,
          webContentsId: wcId,
        }).catch(() => { /* ignore */ });
      } catch { /* webview 未 attach，getWebContentsId 抛错 */ }
    };
    // did-attach 后 webContentsId 才可用
    webview.addEventListener('did-attach', register as EventListener);
    // 兜底：dom-ready 时再注册一次（若 did-attach 已过则直接成功）
    const domReadyReg = () => register();
    webview.addEventListener('dom-ready', domReadyReg as EventListener);
    return () => {
      webview.removeEventListener('did-attach', register as EventListener);
      webview.removeEventListener('dom-ready', domReadyReg as EventListener);
    };
  }, [tab.id, profile.id, remountKey]);
}
