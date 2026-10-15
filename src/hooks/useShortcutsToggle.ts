import { useEffect } from 'react';
import { isTypingTarget } from '../lib/shared-utils';
import { useRegisterShortcutDocs } from '../store/useShortcutDocStore';

/**
 * 按住 `~`（物理键 Backquote）显示快捷键速览，松开立即关闭。
 * - 输入框/contenteditable 焦点时跳过（不影响正常输入）。
 * - 与主进程 before-input-event 拦截分支互补：webview 焦点时由主进程
 *   转发 openShortcuts / closeShortcuts，由组件 setOpen。
 * - 全页面统一；`?` 不再唤起。
 */
export function useShortcutsToggle(open: boolean, setOpen: (v: boolean) => void): void {
  useEffect(() => {
    const isToggleKey = (e: KeyboardEvent) => e.code === 'Backquote';
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (!isToggleKey(e)) return;
      e.preventDefault();
      if (!open) setOpen(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!isToggleKey(e)) return;
      e.preventDefault();
      if (open) setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [open, setOpen]);

  useRegisterShortcutDocs('help-toggle', [
    { id: 'help.toggle', keys: '按住 ~', action: '显示快捷键速览（松开关闭）', category: 'page' },
  ]);
}
