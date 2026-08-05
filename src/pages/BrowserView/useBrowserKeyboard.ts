/* =====================================================================
   pages/BrowserView/useBrowserKeyboard.ts —— 浏览器窗口快捷键
   ===================================================================== */

import { useEffect, useRef } from 'react';
import { useBrowserTabStore } from '../../store/useBrowserTabStore';
import { useRecentClosedStore } from './RecentClosedStore';

interface BrowserKeyboardOptions {
  /** 聚焦地址栏回调 */
  onFocusAddressBar: () => void;
  /** 刷新当前页面回调 */
  onRefresh: () => void;
  /** 强制刷新（清除缓存）回调 */
  onForceRefresh: () => void;
  /** 后退回调 */
  onGoBack: () => void;
  /** 前进回调 */
  onGoForward: () => void;
  /** 停止加载回调 */
  onStopLoading: () => void;
  /** 切换全屏回调 */
  onToggleFullscreen: () => void;
  /** 切换 DevTools 回调 */
  onToggleDevTools: () => void;
  /** v0.0.9 切换书签栏显示/隐藏 */
  onToggleBookmarkBar?: () => void;
  /** v0.0.9 恢复最近关闭标签 */
  onRestoreClosedTab?: (url: string, title: string) => void;
}

export function useBrowserKeyboard(opts: BrowserKeyboardOptions): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const store = useBrowserTabStore.getState();
      const hasCtrl = e.ctrlKey || e.metaKey;
      const hasAlt = e.altKey;
      const hasShift = e.shiftKey;

      // Ctrl+T: New tab
      if (hasCtrl && !hasAlt && !hasShift && e.key.toLowerCase() === 't') {
        e.preventDefault();
        store.newTab();
        return;
      }

      // Ctrl+W: Close tab
      if (hasCtrl && !hasAlt && !hasShift && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        const { activeTabId } = store;
        if (activeTabId) store.closeTab(activeTabId);
        return;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab: Cycle tabs
      if (hasCtrl && e.key === 'Tab') {
        e.preventDefault();
        const { tabs, activeTabId } = store;
        if (tabs.length <= 1) return;
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        const next = hasShift
          ? (idx - 1 + tabs.length) % tabs.length
          : (idx + 1) % tabs.length;
        store.switchTab(tabs[next].id);
        return;
      }

      // Ctrl+L / Alt+D: Focus address bar
      if ((hasCtrl && e.key.toLowerCase() === 'l') || (hasAlt && e.key.toLowerCase() === 'd')) {
        e.preventDefault();
        optsRef.current.onFocusAddressBar();
        return;
      }

      // Ctrl+R / F5: Refresh
      if ((hasCtrl && e.key.toLowerCase() === 'r' && !hasShift) || (e.key === 'F5' && !hasCtrl)) {
        e.preventDefault();
        optsRef.current.onRefresh();
        return;
      }

      // Ctrl+Shift+R: Force refresh
      if (hasCtrl && hasShift && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        optsRef.current.onForceRefresh();
        return;
      }

      // v0.0.9 Ctrl+Shift+B: 切换书签栏显示/隐藏
      if (hasCtrl && hasShift && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        optsRef.current.onToggleBookmarkBar?.();
        return;
      }

      // v0.0.9 Ctrl+Shift+T: 恢复最近关闭的标签
      if (hasCtrl && hasShift && e.key.toLowerCase() === 't') {
        e.preventDefault();
        const recent = useRecentClosedStore.getState().entries;
        if (recent.length > 0) {
          const last = recent[0];
          useRecentClosedStore.getState().remove(last.id);
          store.newTab(last.url, { kind: 'web' });
        }
        return;
      }

      // F11: Toggle fullscreen
      if (e.key === 'F11' && !hasCtrl && !hasAlt) {
        e.preventDefault();
        optsRef.current.onToggleFullscreen();
        return;
      }

      // F12: Toggle DevTools
      if (e.key === 'F12' && !hasCtrl && !hasAlt) {
        e.preventDefault();
        optsRef.current.onToggleDevTools();
        return;
      }

      // Alt+Left: Back
      if (hasAlt && e.key === 'ArrowLeft') {
        e.preventDefault();
        optsRef.current.onGoBack();
        return;
      }

      // Alt+Right: Forward
      if (hasAlt && e.key === 'ArrowRight') {
        e.preventDefault();
        optsRef.current.onGoForward();
        return;
      }

      // Escape: Stop loading
      if (e.key === 'Escape' && !hasCtrl && !hasAlt && !hasShift) {
        e.preventDefault();
        optsRef.current.onStopLoading();
        return;
      }

      // Ctrl+0: Reset zoom
      if (hasCtrl && e.key === '0') {
        e.preventDefault();
        // webview.setZoomLevel(0) — handled by caller
        return;
      }

      // Ctrl+= / Ctrl+-: Zoom in/out
      if (hasCtrl && (e.key === '=' || e.key === '-')) {
        e.preventDefault();
        // webview.setZoomLevel — handled by caller
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);
}
