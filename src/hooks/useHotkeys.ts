/* =====================================================================
   hooks/useHotkeys.ts —— 窗口内快捷键监听 + 全局热键注册
   窗口内快捷键（React keydown 监听）：
     Alt+1~9        切换到当前窗口第 N 个标签
     Ctrl+Tab       切换到下一个标签
     Ctrl+Shift+Tab 切换到上一个标签
   注意：F11/F12 由 useMainViewKeyboard 统一管理（走 maximizeToggleWindow 接口），
        此 hook 不再注册 F11/F12，避免重复监听导致互相抵消。
   全局热键（通过 window.electron.hotkey.register 注册到主进程）：
     可选传入 accelerators 自定义注册
   ===================================================================== */

import { useEffect, useRef } from 'react';
import { useTabStore } from '../store/useTabStore';
import { registerHotkey, unregisterHotkey } from '../lib/electron-api';
import { isTypingTarget } from '../lib/shared-utils';

export interface UseHotkeysOptions {
  /** 全局热键配置 —— accelerator → 触发回调 */
  globalHotkeys?: Record<string, () => void>;
}

/**
 * 窗口内快捷键 Hook
 *
 * 注意：Alt+数字、Ctrl+Tab 等组合可能在某些浏览器/系统下被拦截，
 * 在 Electron 渲染进程内通常可正常工作。
 */
export function useHotkeys(options: UseHotkeysOptions = {}): void {
  const { globalHotkeys } = options;

  // 窗口内快捷键 —— React keydown 监听
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // Alt+1~9 —— 切换到当前窗口第 N 个标签
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const code = e.code;
        const parseNum = (prefix: string): number | null => {
          if (code.startsWith(prefix)) {
            const n = parseInt(code.slice(prefix.length), 10);
            if (n >= 1 && n <= 9) return n;
          }
          return null;
        };
        const n = parseNum('Digit') ?? parseNum('Numpad');
        if (n != null) {
          e.preventDefault();
          const store = useTabStore.getState();
          const tab = store.tabs[n - 1];
          if (tab) {
            store.setActiveTab(tab.id);
          }
          return;
        }
      }

      // Ctrl+Tab —— 切换到下一个标签
      if (e.ctrlKey && !e.shiftKey && e.key === 'Tab') {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        const store = useTabStore.getState();
        const { tabs, activeTabId } = store;
        if (tabs.length === 0) return;
        const curIdx = tabs.findIndex((t) => t.id === activeTabId);
        const nextIdx = curIdx < 0 ? 0 : (curIdx + 1) % tabs.length;
        store.setActiveTab(tabs[nextIdx].id);
        return;
      }

      // Ctrl+Shift+Tab —— 切换到上一个标签
      if (e.ctrlKey && e.shiftKey && e.key === 'Tab') {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        const store = useTabStore.getState();
        const { tabs, activeTabId } = store;
        if (tabs.length === 0) return;
        const curIdx = tabs.findIndex((t) => t.id === activeTabId);
        const prevIdx = curIdx < 0 ? 0 : (curIdx - 1 + tabs.length) % tabs.length;
        store.setActiveTab(tabs[prevIdx].id);
        return;
      }
    };

    window.addEventListener('keydown', handler, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
    };
  }, []);

  // 全局热键 —— 通过 window.electron.hotkey.register 注册到主进程
  // 使用 useRef 持有最新回调，依赖数组改为 accelerator 列表的稳定序列化键，
  // 避免调用方传内联对象导致每次渲染都重新注册/注销热键
  const callbacksRef = useRef(globalHotkeys);
  callbacksRef.current = globalHotkeys;
  // 仅依赖 accelerator 列表的稳定字符串
  const acceleratorKey = Object.keys(globalHotkeys ?? {}).sort().join('|');
  useEffect(() => {
    if (!globalHotkeys) return;
    const accelerators = Object.keys(globalHotkeys);
    if (accelerators.length === 0) return;

    let cancelled = false;
    const registered: string[] = [];

    (async () => {
      for (const acc of accelerators) {
        const cb = () => callbacksRef.current?.[acc]?.();
        try {
          const ok = await registerHotkey(acc, cb);
          if (cancelled) {
            // 组件已卸载，立即注销
            await unregisterHotkey(acc).catch(() => { /* noop */ });
          } else if (ok) {
            registered.push(acc);
          }
        } catch (e) {
          console.error(`[useHotkeys] 注册全局热键失败 (${acc}):`, e);
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const acc of registered) {
        unregisterHotkey(acc).catch((e) => {
          console.error(`[useHotkeys] 注销全局热键失败 (${acc}):`, e);
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceleratorKey]);
}
