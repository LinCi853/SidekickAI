/* =====================================================================
   pages/MainView/useMainViewKeyboard.ts —— 主窗口键盘快捷键
   抽离自 index.tsx：
   - 长按 Tab 键（500ms+）调出底栏（输入框内不触发）
   - Alt+1~9 渲染层兜底：焦点不在 webview 时切换到第 N 个标签
   - F6 循环聚焦：AI 输入框 ↔ 取消聚焦（焦点在输入框时取消，不在时聚焦）
   - F4/F5/F11 渲染层兜底：焦点不在 webview 时，后退/刷新/切换全屏
   - Ctrl+T/Ctrl+W 渲染层兜底：同上原因，焦点不在 webview 时也需要响应。
   注：Ctrl+Tab / F12 / Ctrl+G 等应用内快捷键
   统一由主进程 before-input-event 拦截后通过 WEBVIEW_HOTKEY IPC 转发渲染层
   （见 MainView/index.tsx 的 onWebviewHotkey 监听）。
   ===================================================================== */

import { useEffect, useMemo } from 'react';
import { useTabStore } from '../../store/useTabStore';
import { useProfileStore } from '../../store/useProfileStore';
import { hasOverlay } from '../../hooks/useEscToCloseWindow';
import { maximizeToggleWindow } from '../../lib/electron-api';
import { focusInputInWebview, type WebviewLike } from '../../hooks/useWebViewControl';
import { useRegisterShortcutDocs } from '../../store/useShortcutDocStore';
import { useShortcutRegistry, type ShortcutEntry } from '../../hooks/useShortcutRegistry';

const LONG_PRESS_MS = 500;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

export function useMainViewKeyboard(bottomBarExpanded: boolean, toggleBottomBar: () => void) {
  // 长按 Tab 切换底栏：与 ~ 速览同属 useShortcutRegistry hold 语义
  const tabHoldShortcuts = useMemo<ShortcutEntry[]>(() => [
    {
      accelerator: 'Tab',
      ignoreWhenTyping: true,
      holdMs: LONG_PRESS_MS,
      onHoldStart: (e) => {
        // 拦下默认焦点切换（短按/长按都不要把 Tab 漏给页面元素）
        e.preventDefault();
      },
      handler: () => toggleBottomBar(),
      onHoldEnd: (e) => {
        e.preventDefault();
      },
    },
  ], [toggleBottomBar]);
  useShortcutRegistry(tabHoldShortcuts, { capture: true, ignoreRepeat: true });

  // 注册即声明：本 hook 实现的键位在此登记说明
  useRegisterShortcutDocs('main-keyboard', [
    { id: 'main.tab-detach', keys: 'Ctrl + T', action: '脱离当前标签为独立窗口', category: 'page' },
    { id: 'main.tab-close', keys: 'Ctrl + W', action: '关闭当前标签', category: 'page' },
    { id: 'main.page-back', keys: 'F4', action: '后退（当前标签）', category: 'page' },
    { id: 'main.page-refresh', keys: 'F5', action: '刷新当前标签', category: 'page' },
    { id: 'main.page-focus-input', keys: 'F6', action: '聚焦 AI 输入框 / 取消聚焦（循环）', category: 'page' },
    { id: 'window.maximize', keys: 'F11', action: '切换最大化/还原', category: 'page' },
    { id: 'main.bottom-bar', keys: '长按 Tab', action: '呼出 / 收起底栏', category: 'page' },
  ]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // ===== Alt+1~9：切换到第 N 个可见标签（渲染层兜底） =====
      // 主进程 before-input-event 仅在 webview 焦点时拦截；焦点在顶栏/设置/输入框时不触发。
      // 允许 auto-repeat，支持按住连切。
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        let n: number | null = null;
        if (e.code.startsWith('Digit')) {
          const parsed = parseInt(e.code.slice('Digit'.length), 10);
          if (parsed >= 1 && parsed <= 9) n = parsed;
        } else if (e.code.startsWith('Numpad')) {
          const parsed = parseInt(e.code.slice('Numpad'.length), 10);
          if (parsed >= 1 && parsed <= 9) n = parsed;
        }
        if (n != null) {
          e.preventDefault();
          const visibleTabs = useTabStore.getState().tabs.filter((t) => !t.detachedWindowId);
          const target = visibleTabs[n - 1];
          if (target) {
            useTabStore.getState().setActiveTab(target.id);
          }
          return;
        }
      }

      // 其余应用键忽略长按连发（避免按住 F6 等持续触发）
      if (e.repeat) return;

      // ===== F6：AI 输入框 ↔ 取消聚焦 循环（渲染层兜底） =====
      // 焦点在输入框时 → 取消聚焦；焦点不在输入框时 → 聚焦 AI 输入框
      if (e.key === 'F6' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        if (isTypingTarget(e.target)) {
          // 当前在输入框中 → 取消聚焦（焦点交回页面/body）
          (e.target as HTMLElement).blur();
        } else {
          // 当前不在输入框 → 聚焦 AI 输入框
          const activeTabId = useTabStore.getState().activeTabId;
          if (!activeTabId) return;
          const wv = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as WebviewLike | null;
          if (!wv) return;
          wv.focus?.();
          void focusInputInWebview(wv, null);
        }
        return;
      }

      // ===== F4/F5/F11 渲染层兜底 =====
      // 主进程 before-input-event 仅在 webview 焦点时拦截；焦点在顶栏/设置/输入框时不触发。
      // 此处兜底：非 typing 目标时，F4=后退 / F5=刷新 / F11=切换全屏
      if (!e.ctrlKey && !e.altKey && !e.metaKey && !isTypingTarget(e.target)) {
        if (e.key === 'F4' || e.key === 'F5') {
          e.preventDefault();
          const activeTabId = useTabStore.getState().activeTabId;
          if (!activeTabId) return;
          const wv = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as
            | (HTMLElement & {
                canGoBack: () => boolean;
                goBack: () => void;
                reload: () => void;
              })
            | null;
          if (!wv) return;
          try {
            if (e.key === 'F4' && wv.canGoBack()) wv.goBack();
            else if (e.key === 'F5') wv.reload();
          } catch {
            // 忽略：webview 可能尚未就绪
          }
          return;
        }

        // F11：切换最大化/还原（兜底：焦点不在 webview 时）
        if (e.key === 'F11') {
          e.preventDefault();
          void maximizeToggleWindow();
          return;
        }
      }

      // ===== Ctrl+T / Ctrl+W 渲染层兜底 =====
      // 主进程 before-input-event 仅在 webview 焦点时拦截；焦点在顶栏/设置/输入框时不触发。
      // 此处兜底：非 typing 目标时响应（输入框中不拦截，避免影响文本编辑）。
      if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !isTypingTarget(e.target)) {
        if (e.key === 't' || e.key === 'T') {
          // Ctrl+T：当前窗口独立（脱离当前激活标签为新窗口）
          e.preventDefault();
          const { activeTabId, detachTab } = useTabStore.getState();
          if (activeTabId) void detachTab(activeTabId);
          return;
        }
        if (e.key === 'w' || e.key === 'W') {
          e.preventDefault();
          const { activeTabId, closeTab } = useTabStore.getState();
          if (activeTabId) void closeTab(activeTabId);
          return;
        }
      }
    };

    // ESC 关闭底栏（已展开时）；浮窗栈非空时让浮窗优先处理（如快捷键说明/设置面板/抽屉）
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isTypingTarget(e.target) || !bottomBarExpanded) return;
      if (hasOverlay()) return;
      e.preventDefault();
      toggleBottomBar();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keydown', handleEsc, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keydown', handleEsc, true);
    };
  }, [bottomBarExpanded, toggleBottomBar]);
}
