import { useEffect, useRef } from 'react';
import { getPreset } from '../../../lib/electron-api';
import type { Profile } from '../../../lib/electron-api';
import type { WebviewElement } from '../../../lib/webview';
import { leaseWebviewLifecycle } from '../../../lib/webview-lifecycle';

export function useWebviewUa({
  webviewRef,
  profile,
  isNarrow,
  desktopPresetId,
  mobilePresetId,
  domReadyRef,
  scheduleReload,
  remountKey,
}: {
  webviewRef: React.RefObject<WebviewElement | null>;
  profile: Profile;
  isNarrow: boolean;
  desktopPresetId: string;
  mobilePresetId: string;
  domReadyRef: React.MutableRefObject<boolean>;
  scheduleReload: (webview: WebviewElement) => void;
  remountKey: number;
}) {
  const uaInitializedRef = useRef(false);
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !profile.userAgent) return;
    if (!uaInitializedRef.current) {
      uaInitializedRef.current = true;
      return;
    }
    if (domReadyRef.current) scheduleReload(webview);
  }, [profile.userAgent, profile.devicePreset]);

  const previousRef = useRef<{ webview: WebviewElement; presetId: string } | null>(null);
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const lock = profile.uaLockMode ?? 'auto';
    const presetId = lock === 'mobile' ? mobilePresetId
      : lock === 'desktop' ? desktopPresetId
      : isNarrow ? mobilePresetId : desktopPresetId;
    const changed = previousRef.current?.webview !== webview || previousRef.current?.presetId !== presetId;
    previousRef.current = { webview, presetId };
    const lifecycle = leaseWebviewLifecycle(webview, () => webviewRef.current);
    const applyPreset = async (reload: boolean) => {
      const page = lifecycle.capture();
      try {
        const preset = await getPreset(presetId);
        if (!page.isCurrent()) return;
        webview.setUserAgent(preset?.userAgent ?? profile.userAgent);
        if (reload && domReadyRef.current) scheduleReload(webview);
      } catch (error) {
        console.warn('[WebviewTab] User agent update failed:', error);
      }
    };
    // A new guest inherits the configured UA without reloading a healthy document.
    const handleDomReady = () => { void applyPreset(false); };
    webview.addEventListener('dom-ready', handleDomReady);
    if (changed) void applyPreset(true);
    return () => {
      lifecycle.dispose();
      webview.removeEventListener('dom-ready', handleDomReady);
    };
  }, [isNarrow, desktopPresetId, mobilePresetId, profile.userAgent, profile.uaLockMode, remountKey]);
}
