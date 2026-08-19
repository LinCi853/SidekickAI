/* =====================================================================
   pages/BrowserView/hooks/useWebviewAudio.ts —— 音频相关逻辑
   抽取自 BrowserWebviewTab.tsx：media 播放/暂停事件驱动 audible 状态，
   以及 muted / 站点权限强制静音的应用。
   ===================================================================== */

import { useCallback, useEffect } from 'react';
import type { BrowserTabState } from '../../../lib/electron-api';
import type { WebviewElement } from '../../../lib/webview.js';
import { useBrowserTabStore } from '../../../store/useBrowserTabStore.js';

export interface UseWebviewAudioParams {
  webviewRef: React.MutableRefObject<WebviewElement | null>;
  remountKey: number;
  tab: BrowserTabState;
}

export function useWebviewAudio({ webviewRef, remountKey, tab }: UseWebviewAudioParams) {
  const store = useBrowserTabStore();

  // 页面开始播放音频 → 更新 audible 状态
  const handleMediaStartedPlaying = useCallback(() => {
    store.updateAudible(tab.id, true);
  }, [tab.id, store]);

  // 页面停止播放音频 → 更新 audible 状态
  const handleMediaPaused = useCallback(() => {
    store.updateAudible(tab.id, false);
  }, [tab.id, store]);

  // 应用静音状态到 webview（muted 变化或 remount 后重新应用）
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    try {
      const wv = webview as unknown as { setAudioMuted: (muted: boolean) => void };
      if (typeof wv.setAudioMuted === 'function') {
        wv.setAudioMuted(!!tab.muted);
      }
    } catch { /* ignore */ }
  }, [tab.muted, tab.id, remountKey]);

  // 站点权限 - 强制静音（sitePermissions.mute 优先于用户 muted）
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const shouldMute = tab.muted || !!tab.sitePermissions?.mute;
    try {
      const wv = webview as unknown as { setAudioMuted: (muted: boolean) => void };
      if (typeof wv.setAudioMuted === 'function') {
        wv.setAudioMuted(shouldMute);
      }
    } catch { /* ignore */ }
  }, [tab.muted, tab.sitePermissions?.mute, tab.id, remountKey]);

  return { handleMediaStartedPlaying, handleMediaPaused };
}
