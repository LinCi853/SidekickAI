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

import { useEffect, useRef } from 'react';
import { useTabStore } from '../../store/useTabStore';
import { useProfileStore } from '../../store/useProfileStore';
import { hasOverlay } from '../../hooks/useEscToCloseWindow';
import { maximizeToggleWindow } from '../../lib/electron-api';
import { focusInputInWebview, type WebviewLike } from '../../hooks/useWebViewControl';

const LONG_PRESS_MS = 500;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

export function useMainViewKeyboard(bottomBarExpanded: boolean, toggleBottomBar: () => void) {
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // ===== Alt+1~9：切换到第 N 个可见标签（渲染层兜底） =====
      // 主进程 before-input-event 仅在 webview 焦点时拦截；焦点在顶栏/设置/输入框时不触发。
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

      // ===== 长按 Tab 切换底栏（已展开则收起，已收起则展开） =====
      if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return;
      if (isTypingTarget(e.target)) return;
      if (longPressTimerRef.current) return;
      longPressTriggeredRef.current = false;
      longPressTimerRef.current = setTimeout(() => {
        longPressTriggeredRef.current = true;
        // 切换底栏（已展开则收起，已收起则展开）
        toggleBottomBar();
      }, LONG_PRESS_MS);
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      if (longPressTriggeredRef.current) {
        e.preventDefault();
        longPressTriggeredRef.current = false;
      } else if (!isTypingTarget(e.target)) {
        // 短按 Tab：阻止默认焦点切换行为（防止焦点泄漏到隐藏的抽屉/设置面板）
        e.preventDefault();
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
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('keydown', handleEsc, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('keydown', handleEsc, true);
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    };
  }, [bottomBarExpanded, toggleBottomBar]);
}
