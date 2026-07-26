/* =====================================================================
   pages/MainView/useMainViewKeyboard.ts —— 主窗口键盘快捷键
   抽离自 index.tsx：
   - 长按 Tab 键（500ms+）调出底栏（输入框内不触发）
   - F4/F5/F6 渲染层兜底：焦点不在 webview 时（如在顶栏/设置/输入框），
     主进程 before-input-event 不触发，需在渲染层补一份。
   - Ctrl+T/Ctrl+W 渲染层兜底：同上原因，焦点不在 webview 时也需要响应。
   注：Alt+1~9 / Ctrl+Tab / F11 / F12 / Ctrl+G 等应用内快捷键
   统一由主进程 before-input-event 拦截后通过 WEBVIEW_HOTKEY IPC 转发渲染层
   （见 MainView/index.tsx 的 onWebviewHotkey 监听），此处仅保留长按 Tab 和 F4/F5/F6
   以及 Ctrl+T/Ctrl+W 兜底。
   ===================================================================== */

import { useEffect, useRef } from 'react';
import { useTabStore } from '../../store/useTabStore';
import { useProfileStore } from '../../store/useProfileStore';
import { hasOverlay } from '../../hooks/useEscToCloseWindow';

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
      // ===== F4/F5/F6 渲染层兜底 =====
      // 主进程 before-input-event 仅在 webview 焦点时拦截；焦点在顶栏/设置/输入框时不触发。
      // 此处兜底：非 typing 目标时，F4=后退 / F5=刷新 / F6=前进
      if (!e.ctrlKey && !e.altKey && !e.metaKey && !isTypingTarget(e.target)) {
        if (e.key === 'F4' || e.key === 'F5' || e.key === 'F6') {
          e.preventDefault();
          const activeTabId = useTabStore.getState().activeTabId;
          if (!activeTabId) return;
          const wv = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as
            | (HTMLElement & {
                canGoBack: () => boolean;
                canGoForward: () => boolean;
                goBack: () => void;
                goForward: () => void;
                reload: () => void;
              })
            | null;
          if (!wv) return;
          try {
            if (e.key === 'F4' && wv.canGoBack()) wv.goBack();
            else if (e.key === 'F5') wv.reload();
            else if (e.key === 'F6' && wv.canGoForward()) wv.goForward();
          } catch {
            // 忽略：webview 可能尚未就绪
          }
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
