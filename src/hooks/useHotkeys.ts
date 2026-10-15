/* =====================================================================
   hooks/useHotkeys.ts —— 窗口内快捷键监听 + 全局热键注册
   窗口内快捷键（React keydown 监听）：
     Alt+1~9        切换到当前窗口第 N 个标签
     Ctrl+Tab       切换到下一个标签
     Ctrl+Shift+Tab 切换到上一个标签
   注意：F12 由 useMainViewKeyboard 统一管理（走 toggleAlwaysOnTop 接口），
        此 hook 不再注册 F12，避免重复监听导致互相抵消。
   全局热键（通过 window.electron.hotkey.register 注册到主进程）：
     可选传入 accelerators 自定义注册
   ===================================================================== */

import { useEffect, useRef, useMemo } from 'react';
import { useTabStore } from '../store/useTabStore';
import { registerHotkey, unregisterHotkey } from '../lib/electron-api';
import { isTypingTarget } from '../lib/shared-utils';
import { useRegisterShortcutDocs } from '../store/useShortcutDocStore';
import { useShortcutRegistry, type ShortcutEntry } from './useShortcutRegistry';

export interface UseHotkeysOptions {
  /** 全局热键配置 —— accelerator → 触发回调 */
  globalHotkeys?: Record<string, () => void>;
  /** 注册即声明：是否登记标签切换键位说明（单标签窗口传 false） */
  registerTabDocs?: boolean;
}

/**
 * 窗口内快捷键 Hook
 *
 * 注意：Alt+数字、Ctrl+Tab 等组合可能在某些浏览器/系统下被拦截，
 * 在 Electron 渲染进程内通常可正常工作。
 */
export function useHotkeys(options: UseHotkeysOptions = {}): void {
  const { globalHotkeys, registerTabDocs = true } = options;

  // 注册即声明：本 hook 实现的标签切换键位
  useRegisterShortcutDocs('main-tabs', registerTabDocs ? [
    { id: 'main.tab-switch', keys: 'Alt + 1~9', action: '切换到第 N 个标签', category: 'page' },
    { id: 'main.tab-cycle', keys: 'Ctrl + Tab / Ctrl + Shift + Tab', action: '向前/向后循环切换标签', category: 'page' },
  ] : []);

  // 窗口内快捷键 —— useShortcutRegistry（与浏览器/进阶面板同一层；allowRepeat 支持连按切标签）
  const tabShortcuts = useMemo<ShortcutEntry[]>(() => {
    const switchByIndex = (index: number) => {
      const store = useTabStore.getState();
      const tab = store.tabs[index];
      if (tab) store.setActiveTab(tab.id);
    };
    const cycle = (reverse: boolean) => {
      const store = useTabStore.getState();
      const { tabs, activeTabId } = store;
      if (tabs.length === 0) return;
      const curIdx = tabs.findIndex((t) => t.id === activeTabId);
      const nextIdx = reverse
        ? (curIdx < 0 ? 0 : (curIdx - 1 + tabs.length) % tabs.length)
        : (curIdx < 0 ? 0 : (curIdx + 1) % tabs.length);
      store.setActiveTab(tabs[nextIdx].id);
    };
    const entries: ShortcutEntry[] = [];
    for (let n = 1; n <= 9; n += 1) {
      const index = n - 1;
      entries.push(
        { accelerator: `Alt+${n}`, allowRepeat: true, handler: (e) => { e.preventDefault(); switchByIndex(index); } },
      );
    }
    entries.push(
      {
        accelerator: 'Ctrl+Tab', allowRepeat: true,
        handler: (e) => { if (isTypingTarget(e.target)) return; e.preventDefault(); cycle(false); },
      },
      {
        accelerator: 'Ctrl+Shift+Tab', allowRepeat: true,
        handler: (e) => { if (isTypingTarget(e.target)) return; e.preventDefault(); cycle(true); },
      },
    );
    return entries;
  }, []);
  useShortcutRegistry(tabShortcuts, { capture: true, ignoreRepeat: true });

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
