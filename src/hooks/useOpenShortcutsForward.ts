/* =====================================================================
   hooks/useOpenShortcutsForward.ts —— 接住主进程转发的速览开/关
   webview 获得焦点时，按住/松开 ~ 不进入渲染层 keydown/keyup，由主进程
   before-input-event（electron/browser/webview-hotkeys.ts）拦截后
   经 WEBVIEW_HOTKEY IPC 以 action: 'openShortcuts' | 'closeShortcuts' 转发。
   ===================================================================== */

import { useEffect, useRef } from 'react';
import { onWebviewHotkey } from '../lib/electron-api';

export function useOpenShortcutsForward(onOpen: () => void, onClose: () => void): void {
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);
  onOpenRef.current = onOpen;
  onCloseRef.current = onClose;

  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      off = onWebviewHotkey((payload) => {
        if (payload.action === 'openShortcuts') onOpenRef.current();
        else if (payload.action === 'closeShortcuts') onCloseRef.current();
      });
    } catch {
      // preload 未就绪或测试环境：无 webview 转发通道
    }
    return () => off?.();
  }, []);
}
