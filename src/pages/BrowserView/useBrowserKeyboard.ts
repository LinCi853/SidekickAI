/* =====================================================================
   pages/BrowserView/useBrowserKeyboard.ts —— 浏览器窗口快捷键（统一注册）
   =====================================================================

   重构：所有快捷键以「定义表（defs）」驱动，统一通过通用组件 useShortcutRegistry
   完成 accelerator 解析与匹配（含 ignoreRepeat / capture / enabled），不再手写
   if-else 修饰键判断。webview 焦点时主进程 before-input-event 通过 WEBVIEW_HOTKEY
   IPC 转发同一 action，按 def.action 查表执行——渲染层与主进程共用同一份语义，
   新增/修改快捷键只需改 buildShortcutDefs。

   浏览器窗口的「脱离/回归」全局快捷键由主进程 globalShortcut 注册
   （Profile.browserWindowShortcut），与本 hook 无关。
   ===================================================================== */

import { useEffect, useRef } from 'react';
import { useShortcutRegistry } from '../../hooks/useShortcutRegistry';
import { useBrowserTabStore } from '../../store/useBrowserTabStore';
import { useRecentClosedStore } from './RecentClosedStore';
import { onWebviewHotkey, clearAllNavHistory, clearAllDownloads } from '../../lib/electron-api';

export interface BrowserKeyboardOptions {
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
  /** 切换最大化/还原回调（TitleBar 最大化按钮语义） */
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
  /** Ctrl+S：另存为当前页面 */
  onSaveAsPage?: () => void;
  /** Ctrl+U：查看网页源代码 */
  onViewSource?: () => void;
  /** 页面缩放（Ctrl+= / Ctrl+- / Ctrl+0） */
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
  /** F11：切换沉浸式全屏 */
  onToggleFullscreen?: () => void;
  /** Escape（全屏时）：退出全屏 */
  onExitFullscreen?: () => void;
  /** 当前是否全屏（决定 Escape 行为） */
  isFullscreen?: boolean;
  /** 云电脑模式切换回调（Ctrl+Alt+C，webview 焦点时由主进程转发） */
  onToggleCloudPc?: () => void;
  /** Ctrl+G：切换手柄/键盘空间导航（等效主窗口，webview 焦点时由主进程转发） */
  onToggleSpatialNav?: () => void;
  /** 整体启用开关（云电脑模式下 false：所有浏览器快捷键放行给远端） */
  enabled?: boolean;
  /** Alt+P：冻结/恢复当前页面（防撤回保险） */
  onToggleFreeze?: (tabId?: string) => void;
}

/** 快捷键定义：accelerator（渲染层匹配）+ action（主进程转发）+ handler */
interface BrowserShortcutDef {
  accelerator: string;
  /** 主进程 WEBVIEW_HOTKEY 转发的 action；纯渲染层快捷键省略 */
  action?: string;
  /** 执行动作（data 为转发 payload.data） */
  handler: (data?: unknown) => void;
}

/**
 * 构建快捷键定义表（唯一维护点）。
 * 渲染层 keydown 按 accelerator 匹配；webview 焦点时主进程按 action 转发，
 * 查表执行同一 handler —— 两个入口语义一致。
 */
export function buildShortcutDefs(o: BrowserKeyboardOptions): BrowserShortcutDef[] {
  const store = () => useBrowserTabStore.getState();
  const cycleTab = (reverse: boolean) => {
    const s = store();
    const { tabs, activeTabId } = s;
    if (tabs.length <= 1) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const next = reverse ? (idx - 1 + tabs.length) % tabs.length : (idx + 1) % tabs.length;
    s.switchTab(tabs[next].id);
  };
  const openInternal = (source: 'history' | 'downloads') => {
    const s = store();
    const existing = s.tabs.find((t) => t.source === source);
    const url = source === 'history' ? 'sidekickai://history' : 'sidekickai://downloads';
    if (existing) s.switchTab(existing.id);
    else s.newTab(url, { source });
  };
  const reopenClosed = () => {
    const recent = useRecentClosedStore.getState().entries;
    if (recent.length > 0) {
      const last = recent[0];
      useRecentClosedStore.getState().remove(last.id);
      store().newTab(last.url, { kind: 'web' });
    }
  };
  const clearBrowsingData = () => {
    void clearAllNavHistory(store().profileId || undefined);
    void clearAllDownloads();
  };

  const defs: BrowserShortcutDef[] = [
    // ===== 标签操作 =====
    { accelerator: 'Ctrl+T', action: 'detachCurrent', handler: () => store().newTab() },
    { accelerator: 'Ctrl+W', action: 'closeTab', handler: () => { const id = store().activeTabId; if (id) void store().closeTab(id); } },
    { accelerator: 'Ctrl+Tab', action: 'cycleTab', handler: (d) => cycleTab(Boolean((d as { reverse?: boolean } | undefined)?.reverse)) },
    { accelerator: 'Ctrl+Shift+Tab', handler: () => cycleTab(true) },
    { accelerator: 'Alt+1', action: 'switchTab', handler: (d) => switchByIndex((d as { index?: number } | undefined)?.index ?? 0) },
    { accelerator: 'Alt+2', action: 'switchTab', handler: (d) => switchByIndex((d as { index?: number } | undefined)?.index ?? 1) },
    { accelerator: 'Alt+3', action: 'switchTab', handler: (d) => switchByIndex((d as { index?: number } | undefined)?.index ?? 2) },
    { accelerator: 'Alt+4', action: 'switchTab', handler: (d) => switchByIndex((d as { index?: number } | undefined)?.index ?? 3) },
    { accelerator: 'Alt+5', action: 'switchTab', handler: (d) => switchByIndex((d as { index?: number } | undefined)?.index ?? 4) },
    { accelerator: 'Alt+6', action: 'switchTab', handler: (d) => switchByIndex((d as { index?: number } | undefined)?.index ?? 5) },
    { accelerator: 'Alt+7', action: 'switchTab', handler: (d) => switchByIndex((d as { index?: number } | undefined)?.index ?? 6) },
    { accelerator: 'Alt+8', action: 'switchTab', handler: (d) => switchByIndex((d as { index?: number } | undefined)?.index ?? 7) },
    { accelerator: 'Alt+9', action: 'switchTab', handler: (d) => switchByIndex((d as { index?: number } | undefined)?.index ?? 8) },
    { accelerator: 'Ctrl+Shift+T', action: 'reopenClosed', handler: () => reopenClosed() },

    // ===== 导航 / 加载 =====
    { accelerator: 'Ctrl+L', action: 'focusAddressBar', handler: () => o.onFocusAddressBar() },
    { accelerator: 'Alt+D', action: 'focusAddressBar', handler: () => o.onFocusAddressBar() },
    { accelerator: 'Ctrl+R', action: 'navRefresh', handler: () => o.onRefresh() },
    { accelerator: 'F5', action: 'navRefresh', handler: () => o.onRefresh() },
    { accelerator: 'Ctrl+Shift+R', action: 'forceRefresh', handler: () => o.onForceRefresh() },
    { accelerator: 'Ctrl+F5', action: 'forceRefresh', handler: () => o.onForceRefresh() },
    { accelerator: 'Alt+ArrowLeft', action: 'navBack', handler: () => o.onGoBack() },
    { accelerator: 'Alt+ArrowRight', action: 'navForward', handler: () => o.onGoForward() },
    { accelerator: 'F6', action: 'focusCycle', handler: () => o.onFocusCycle?.() },
    { accelerator: 'Escape', handler: () => handleEscape() },

    // ===== 浏览器功能 =====
    { accelerator: 'Ctrl+D', action: 'addBookmark', handler: () => o.onAddBookmark?.() },
    { accelerator: 'Ctrl+H', action: 'openHistory', handler: () => openInternal('history') },
    { accelerator: 'Ctrl+J', action: 'openDownloads', handler: () => openInternal('downloads') },
    { accelerator: 'Ctrl+K', action: 'focusSearch', handler: () => o.onFocusSearch?.() },
    { accelerator: 'Ctrl+E', action: 'focusSearch', handler: () => o.onFocusSearch?.() },
    { accelerator: 'Ctrl+Shift+B', action: 'toggleBookmarkBar', handler: () => o.onToggleBookmarkBar?.() },
    { accelerator: 'Ctrl+Shift+Delete', action: 'clearBrowsingData', handler: () => clearBrowsingData() },
    { accelerator: 'Ctrl+F', action: 'findInPage', handler: () => o.onFindInPage?.() },
    { accelerator: 'Ctrl+P', action: 'print', handler: () => o.onPrint?.() },
    { accelerator: 'Ctrl+S', action: 'savePageAs', handler: () => o.onSaveAsPage?.() },
    { accelerator: 'Ctrl+U', action: 'viewSource', handler: () => o.onViewSource?.() },

    // ===== 缩放 =====
    { accelerator: 'Ctrl+0', action: 'zoomReset', handler: () => o.onZoomReset?.() },
    { accelerator: 'Ctrl+=', action: 'zoomIn', handler: () => o.onZoomIn?.() },
    { accelerator: 'Ctrl+Plus', action: 'zoomIn', handler: () => o.onZoomIn?.() },
    { accelerator: 'Ctrl+-', action: 'zoomOut', handler: () => o.onZoomOut?.() },

    // ===== 窗口 / 系统级 =====
    { accelerator: 'F11', handler: () => { console.log('[fullscreen-keyboard] F11 pressed, calling onToggleFullscreen'); o.onToggleFullscreen?.(); } },
    { accelerator: 'F12', handler: () => o.onToggleDevTools() },
    { accelerator: 'Alt+P', action: 'toggleFreeze', handler: (d) => o.onToggleFreeze?.((d as { tabId?: string } | undefined)?.tabId) },

    // ===== 云电脑模式 =====
    // Ctrl+Alt+C：进入/退出云电脑模式。渲染层 keydown（宿主聚焦）经通用注册表匹配；
    // webview 聚焦时主进程转发 action（uiohook 兜底通道 + guest 拦截双通道去重）；
    // onWebviewHotkey 中 toggleCloudPc 不受 enabled 限制（云电脑模式下也能退出）。
    { accelerator: 'Ctrl+Alt+C', action: 'toggleCloudPc', handler: () => o.onToggleCloudPc?.() },

    // ===== 手柄/键盘空间导航（等效主窗口 Ctrl+G） =====
    { accelerator: 'Ctrl+G', action: 'toggleSpatialNav', handler: () => o.onToggleSpatialNav?.() },
  ];

  function switchByIndex(index: number): void {
    const s = store();
    const tab = s.tabs[index];
    if (tab) s.switchTab(tab.id);
  }

  function handleEscape(): void {
    const activeEl = document.activeElement;
    console.log('[fullscreen-keyboard] Escape pressed, isFullscreen=', o.isFullscreen, 'activeEl=', activeEl?.tagName);
    if (activeEl?.tagName === 'INPUT' && activeEl.classList.contains('browser-address-input')) {
      // 地址栏处理 ESC（退出编辑状态），不执行其他行为
      console.log('[fullscreen-keyboard] Escape: address bar focused, skipping');
      return;
    }
    if (o.isFullscreen) {
      console.log('[fullscreen-keyboard] Escape: calling onExitFullscreen');
      o.onExitFullscreen?.();
      return;
    }
    console.log('[fullscreen-keyboard] Escape: not fullscreen, calling onStopLoading');
    o.onStopLoading();
  }

  return defs;
}

export function useBrowserKeyboard(opts: BrowserKeyboardOptions): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // 每次渲染重建 defs（闭包持有最新 opts），useShortcutRegistry 用 ref 持有最新列表
  const defs = buildShortcutDefs(opts);
  const defsRef = useRef(defs);
  defsRef.current = defs;

  // 渲染层 keydown：统一走通用组件 useShortcutRegistry（capture + ignoreRepeat）
  useShortcutRegistry(
    defs.map((d) => ({
      accelerator: d.accelerator,
      handler: (e: KeyboardEvent) => {
        e.preventDefault();
        d.handler();
      },
    })),
    { enabled: opts.enabled !== false, capture: true, ignoreRepeat: true },
  );

  // webview 焦点时 keydown 不触发，监听主进程转发的 WEBVIEW_HOTKEY，
  // 按 action 查表执行同一 handler（toggleCloudPc 不受 enabled 限制，
  // 云电脑模式下 Ctrl+Alt+C 依然能退出，避免快捷键死锁）。
  useEffect(() => {
    const offHotkey = onWebviewHotkey((payload: { action: string; data?: unknown }) => {
      const action = payload.action;
      if (action === 'toggleCloudPc') {
        optsRef.current.onToggleCloudPc?.();
        return;
      }
      if (optsRef.current.enabled === false) return;
      const def = defsRef.current.find((d) => d.action === action);
      if (def) {
        console.log('[browser-hotkey] 转发命中:', action);
        def.handler(payload.data);
      } else {
        console.log('[browser-hotkey] 未注册的转发 action:', action);
      }
    });
    return () => { offHotkey(); };
  }, []);
}
