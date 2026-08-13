/* =====================================================================
   pages/BrowserView/useBrowserKeyboard.ts —— 浏览器窗口快捷键
   =====================================================================

   全部硬编码（窗口内快捷键），不读取配置：
   - Ctrl+T / Ctrl+W / Ctrl+Tab 等标签操作
   - F11 / F12 / F5 / F6 / Escape 等系统级快捷键
   - Alt+Left / Alt+Right 导航
   - Ctrl+L / Alt+D 聚焦地址栏
   - Ctrl+D 添加书签 / Ctrl+H 历史 / Ctrl+J 下载
   - Ctrl+K / Ctrl+E 聚焦地址栏搜索模式
   - Ctrl+Shift+Del 清除浏览数据 / Ctrl+F 页内查找 / Ctrl+P 打印

   浏览器窗口的"脱离/回归"全局快捷键由主进程 globalShortcut 注册
   （Profile.browserWindowShortcut），与本 hook 无关。

   webview 焦点时 keydown 不触发，主进程 before-input-event 通过
   WEBVIEW_HOTKEY IPC 转发；本 hook 同时监听该 IPC 以覆盖 webview 焦点场景。
   ===================================================================== */

import { useEffect, useRef } from 'react';
import { useBrowserTabStore } from '../../store/useBrowserTabStore';
import { useRecentClosedStore } from './RecentClosedStore';
import { onWebviewHotkey, clearAllNavHistory, clearAllDownloads } from '../../lib/electron-api';

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
  /** 切换最大化/还原回调（F11 等效 TitleBar 最大化按钮） */
  onMaximize: () => void;
  /** 切换 DevTools 回调 */
  onToggleDevTools: () => void;
  /** v0.0.9 切换书签栏显示/隐藏 */
  onToggleBookmarkBar?: () => void;
  /** F6 聚焦循环：地址栏 → 页面可输入 → 不聚焦 */
  onFocusCycle?: () => void;
  /** Ctrl+D：添加当前页面到书签 */
  onAddBookmark?: () => void;
  /** Ctrl+K / Ctrl+E：聚焦地址栏并进入搜索模式 */
  onFocusSearch?: () => void;
  /** Ctrl+F：页内查找（注入 find 脚本） */
  onFindInPage?: () => void;
  /** Ctrl+P：打印当前页面 */
  onPrint?: () => void;
  /** Alt+P：冻结/恢复当前页面（防撤回保险） */
  onToggleFreeze?: (tabId?: string) => void;
}

export function useBrowserKeyboard(opts: BrowserKeyboardOptions): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const store = useBrowserTabStore.getState();
      const hasCtrl = e.ctrlKey || e.metaKey;
      const hasAlt = e.altKey;
      const hasShift = e.shiftKey;

      // Ctrl+T: New tab
      if (hasCtrl && !hasShift && !hasAlt && e.key.toLowerCase() === 't') {
        e.preventDefault();
        store.newTab();
        return;
      }

      // Ctrl+W: Close tab
      if (hasCtrl && !hasShift && !hasAlt && e.key.toLowerCase() === 'w') {
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

      // Ctrl+Shift+R 或 Ctrl+F5：强制刷新（清除缓存）
      if (
        !hasAlt &&
        ((hasCtrl && hasShift && e.key.toLowerCase() === 'r') || (hasCtrl && e.key === 'F5'))
      ) {
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

      // Ctrl+D: 添加当前页面到书签
      if (hasCtrl && !hasShift && !hasAlt && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        optsRef.current.onAddBookmark?.();
        return;
      }

      // Ctrl+H: 打开历史标签
      if (hasCtrl && !hasShift && !hasAlt && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        const existing = store.tabs.find((t) => t.source === 'history');
        if (existing) store.switchTab(existing.id);
        else store.newTab('sidekickai://history', { source: 'history' });
        return;
      }

      // Ctrl+J: 打开下载标签
      if (hasCtrl && !hasShift && !hasAlt && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        const existing = store.tabs.find((t) => t.source === 'downloads');
        if (existing) store.switchTab(existing.id);
        else store.newTab('sidekickai://downloads', { source: 'downloads' });
        return;
      }

      // Ctrl+K / Ctrl+E: 聚焦地址栏并进入搜索模式
      if (hasCtrl && !hasShift && !hasAlt && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'e')) {
        e.preventDefault();
        optsRef.current.onFocusSearch?.();
        return;
      }

      // Ctrl+Shift+Del: 清除浏览数据
      if (hasCtrl && hasShift && !hasAlt && e.key === 'Delete') {
        e.preventDefault();
        void clearAllNavHistory(store.profileId || undefined);
        void clearAllDownloads();
        return;
      }

      // Ctrl+F: 页内查找
      if (hasCtrl && !hasShift && !hasAlt && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        optsRef.current.onFindInPage?.();
        return;
      }

      // Ctrl+P: 打印当前页面
      if (hasCtrl && !hasShift && !hasAlt && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        optsRef.current.onPrint?.();
        return;
      }

      // Alt+P: 冻结/恢复当前页面（防撤回保险）
      if (hasAlt && !hasCtrl && !hasShift && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        optsRef.current.onToggleFreeze?.();
        return;
      }

      // F6: Focus cycle (address bar → page input → no focus)
      if (e.key === 'F6' && !hasCtrl && !hasAlt && !hasShift) {
        e.preventDefault();
        optsRef.current.onFocusCycle?.();
        return;
      }

      // F11: Toggle maximize/restore (等效 TitleBar 最大化按钮，主进程已拦截 webview 焦点时的 F11)
      if (e.key === 'F11' && !hasCtrl && !hasAlt) {
        e.preventDefault();
        optsRef.current.onMaximize();
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

      // Escape: 若地址栏正在编辑则交由地址栏处理（退出编辑），否则停止加载（G2）
      if (e.key === 'Escape' && !hasCtrl && !hasAlt && !hasShift) {
        const activeEl = document.activeElement;
        if (activeEl?.tagName === 'INPUT' && activeEl.classList.contains('browser-address-input')) {
          // 地址栏处理 ESC（退出编辑状态），不执行停止加载
          return;
        }
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

    // webview 焦点时 keydown 不触发，监听主进程 before-input-event 转发的
    // WEBVIEW_HOTKEY IPC，覆盖 webview 焦点场景。使用宽类型接收新增 action。
    const offHotkey = onWebviewHotkey((payload: { action: string; data?: unknown }) => {
      const action = payload.action;
      const s = useBrowserTabStore.getState();

      if (action === 'addBookmark') {
        optsRef.current.onAddBookmark?.();
      } else if (action === 'openHistory') {
        const existing = s.tabs.find((t) => t.source === 'history');
        if (existing) s.switchTab(existing.id);
        else s.newTab('sidekickai://history', { source: 'history' });
      } else if (action === 'openDownloads') {
        const existing = s.tabs.find((t) => t.source === 'downloads');
        if (existing) s.switchTab(existing.id);
        else s.newTab('sidekickai://downloads', { source: 'downloads' });
      } else if (action === 'focusSearch') {
        optsRef.current.onFocusSearch?.();
      } else if (action === 'clearBrowsingData') {
        void clearAllNavHistory(s.profileId || undefined);
        void clearAllDownloads();
      } else if (action === 'findInPage') {
        optsRef.current.onFindInPage?.();
      } else if (action === 'print') {
        optsRef.current.onPrint?.();
      } else if (action === 'toggleFreeze') {
        optsRef.current.onToggleFreeze?.((payload.data as { tabId?: string } | undefined)?.tabId);
      }
    });

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      offHotkey();
    };
  }, []);
}
