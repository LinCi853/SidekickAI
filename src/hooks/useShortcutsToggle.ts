import { useEffect } from 'react';
import { isTypingTarget } from '../lib/shared-utils';

/**
 * 监听反引号(`)/波浪号(~)/问号(?) 键呼出/关闭快捷键说明窗口。
 * - 输入框/textarea/contenteditable 焦点时跳过（不影响正常输入）。
 * - 与主进程 before-input-event 拦截分支互补：webview 焦点时由主进程通过
 *   WEBVIEW_HOTKEY IPC 转发到 onWebviewHotkey，由组件自行调用 setShortcutsOpen；
 *   渲染层窗口焦点时由本 hook 直接处理。
 */
export function useShortcutsToggle(open: boolean, setOpen: (v: boolean) => void): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      // 反引号键（Backquote）或问号键
      if (e.code === 'Backquote' || e.key === '?' || e.key === '`' || e.key === '~') {
        e.preventDefault();
        setOpen(!open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, setOpen]);
}
