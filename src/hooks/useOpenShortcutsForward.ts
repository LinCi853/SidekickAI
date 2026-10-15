/* =====================================================================
   hooks/useOpenShortcutsForward.ts —— 接住主进程转发的 openShortcuts
   webview 获得焦点时，` / ~ / ? 按键不进入渲染层 keydown，由主进程
   before-input-event（electron/window-factory/webview-hotkeys.ts）拦截后
   经 WEBVIEW_HOTKEY IPC 以 action: 'openShortcuts' 转发到宿主窗口。
   宿主窗口挂载本 hook 即可打开快捷键说明——配合 useShortcutsToggle
   （窗口焦点路径）共同实现「所有页面可呼出」。
   ===================================================================== */

import { useEffect, useRef } from 'react';
import { onWebviewHotkey } from '../lib/electron-api';

export function useOpenShortcutsForward(onOpen: () => void): void {
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      off = onWebviewHotkey((payload) => {
        if (payload.action === 'openShortcuts') onOpenRef.current();
      });
    } catch {
      // preload 未就绪或测试环境：无 webview 转发通道
    }
    return () => off?.();
  }, []);
}
