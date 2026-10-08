import { useEffect } from 'react';
import { logLoginTrace, registerWebview } from '../../../lib/electron-api';
import type { Profile } from '../../../lib/electron-api';
import type { WebviewElement } from '../../../lib/webview';
import { DETECT_LOGIN_SCRIPT } from '../scripts';

export function useConversationScrape({ webviewRef, profile, tab, remountKey, domReadyRef,
  loggedLoginUrlsRef, lastLoginCheckedUrlRef }: {
  webviewRef: React.RefObject<WebviewElement | null>;
  profile: Profile;
  tab: { id: string };
  remountKey: number;
  domReadyRef: React.MutableRefObject<boolean>;
  loggedLoginUrlsRef: React.MutableRefObject<Set<string>>;
  lastLoginCheckedUrlRef: React.MutableRefObject<string>;
}) {
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const register = () => {
      try {
        void registerWebview({ tabId: tab.id, windowId: 'main', webContentsId: webview.getWebContentsId(), profileId: profile.id }).catch(() => {});
      } catch {}
    };
    const login = async () => {
      if (!profile.isAIPlatform || !domReadyRef.current) return;
      try {
        const value = JSON.parse(String(await webview.executeJavaScript(DETECT_LOGIN_SCRIPT))) as {
          url?: string; cookie?: string; isLoggedIn?: boolean;
        };
        if (value.isLoggedIn && value.url && !loggedLoginUrlsRef.current.has(value.url)) {
          loggedLoginUrlsRef.current.add(value.url);
          lastLoginCheckedUrlRef.current = value.url;
          await logLoginTrace({ profileId: profile.id, platform: profile.aiPlatformId, loginUrl: value.url, sessionData: value.cookie });
        }
      } catch (error) { console.warn('[login-trace] Detection failed:', error); }
    };
    webview.addEventListener('dom-ready', register);
    webview.addEventListener('did-navigate-in-page', login);
    if (domReadyRef.current) register();
    return () => {
      webview.removeEventListener('dom-ready', register);
      webview.removeEventListener('did-navigate-in-page', login);
    };
  }, [profile.id, profile.isAIPlatform, profile.aiPlatformId, tab.id, remountKey]);
}
