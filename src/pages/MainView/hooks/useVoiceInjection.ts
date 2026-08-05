import { useCallback, useEffect } from 'react';
import { injectTextToWebview, triggerSendInWebview, type WebviewLike } from '../../../hooks/useWebViewControl';
import { onVoiceInjectAndSend } from '../../../lib/electron-api';
import type { AIPlatform, Profile } from '../../../lib/electron-api';

interface Tab {
  id: string;
  profileId: string;
}

/**
 * Handles voice recognition result injection into the active webview.
 * Used by both in-app and background voice paths.
 */
export function useVoiceInjection(
  activeTab: Tab | null,
  getProfile: (profileId: string) => Profile | null,
  platforms: AIPlatform[],
) {
  const injectAndSendVoice = useCallback(
    async (text: string, send = true): Promise<void> => {
      if (!text || !text.trim()) return;
      if (!activeTab) {
        console.warn('[MainView] injectAndSendVoice: 无激活标签，跳过');
        return;
      }
      const profile = getProfile(activeTab.profileId);
      const platform = profile?.aiPlatformUrl
        ? platforms.find((p) => p.url === profile.aiPlatformUrl)
        : undefined;
      const inputSelector = profile?.aiInputSelector || platform?.inputSelector || null;
      const sendSelector = profile?.aiSendSelector || platform?.sendSelector || null;
      const el = document.querySelector(`webview[data-tab-id="${activeTab.id}"]`) as WebviewLike | null;
      if (!el) {
        console.warn('[MainView] injectAndSendVoice: 未找到激活 webview');
        return;
      }
      const ok = await injectTextToWebview(el, text, inputSelector);
      if (!ok) {
        console.warn('[MainView] injectAndSendVoice: 注入失败');
        return;
      }
      if (send) {
        await triggerSendInWebview(el, sendSelector, inputSelector);
      }
    },
    [activeTab, getProfile, platforms],
  );

  useEffect(() => {
    const offInject = onVoiceInjectAndSend(({ text, enterToSend }) => {
      console.log('[MainView] 收到后台语音注入指令，enterToSend=', enterToSend);
      void injectAndSendVoice(text, enterToSend);
    });
    return () => { offInject(); };
  }, [injectAndSendVoice]);

  return { injectAndSendVoice };
}
