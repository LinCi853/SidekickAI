import { useCallback, useEffect, useRef, useState } from 'react';
import type { Profile } from '../../../lib/electron-api';
import { sanitizeUrl, type WebviewElement } from '../../../lib/webview';
import { leaseWebviewLifecycle, type WebviewLifecycleLease, type WebviewPageSnapshot } from '../../../lib/webview-lifecycle';
import { useTabStore } from '../../../store/useTabStore';

async function checkWebviewStreaming(webview: WebviewElement): Promise<boolean> {
  try {
    return Boolean(await webview.executeJavaScript(`
      (function() {
        var entries = performance.getEntriesByType('resource');
        var now = performance.now();
        var active = entries.filter(function(e) { return now - e.startTime < e.duration + 2000 && e.duration === 0; });
        return active.length > 0 || document.readyState !== 'complete';
      })()
    `));
  } catch (error) {
    console.warn('[WebviewTab] Streaming check failed:', error);
    return false;
  }
}

interface ReloadRequest {
  lease: WebviewLifecycleLease;
  page: WebviewPageSnapshot;
}

export function useWebviewRemount({
  tab,
  profile,
  onDomReadyChange,
}: {
  tab: { id: string };
  profile: Profile;
  onDomReadyChange?: (isReady: boolean) => void;
}) {
  const [remountKey, setRemountKey] = useState(0);
  const domReadyRef = useRef(false);
  const lastRemountFailUrlRef = useRef('');
  const remountFailCountRef = useRef(0);
  const onDomReadyChangeRef = useRef(onDomReadyChange);
  useEffect(() => { onDomReadyChangeRef.current = onDomReadyChange; });
  const reloadRequestRef = useRef<ReloadRequest | null>(null);

  const cancelReload = useCallback(() => {
    reloadRequestRef.current?.lease.dispose();
    reloadRequestRef.current = null;
  }, []);

  const scheduleReload = useCallback((webview: WebviewElement) => {
    if (reloadRequestRef.current?.page.isCurrent()) return;
    cancelReload();
    const lease = leaseWebviewLifecycle(webview);
    const request = { lease, page: lease.capture() };
    reloadRequestRef.current = request;
    const isCurrent = () => reloadRequestRef.current === request && request.page.isCurrent();
    const finish = () => {
      if (reloadRequestRef.current === request) reloadRequestRef.current = null;
      lease.dispose();
    };
    const reload = () => {
      if (!isCurrent()) { finish(); return; }
      try { webview.reload(); } catch (error) { console.error('[WebviewTab] Reload failed:', error); }
      finish();
    };
    const poll = async () => {
      const streaming = await checkWebviewStreaming(webview);
      if (!isCurrent()) { finish(); return; }
      if (!streaming) { reload(); return; }
      lease.delay(() => { void poll(); }, 500);
    };
    // Start the timeout only after confirming that this page is still streaming.
    void checkWebviewStreaming(webview).then(streaming => {
      if (!isCurrent()) { finish(); return; }
      if (!streaming) { reload(); return; }
      lease.delay(() => { void poll(); }, 500);
      lease.delay(reload, 10000);
    });
  }, [cancelReload]);

  useEffect(() => cancelReload, [cancelReload, remountKey]);

  const resetRemountFailState = useCallback(() => {
    lastRemountFailUrlRef.current = '';
    remountFailCountRef.current = 0;
  }, []);

  const triggerRemount = useCallback((failUrl: string, reason: string, updateTabToFailUrl: boolean) => {
    cancelReload();
    const cleanFailUrl = sanitizeUrl(failUrl);
    const currentTabUrl = useTabStore.getState().tabs.find(t => t.id === tab.id)?.url || '';
    if (cleanFailUrl && cleanFailUrl === lastRemountFailUrlRef.current) {
      remountFailCountRef.current += 1;
      if (remountFailCountRef.current >= 2) {
        const homeUrl = sanitizeUrl(profile.aiPlatformUrl || '');
        console.warn('[WebviewTab] Repeated recovery failure:', reason, cleanFailUrl);
        if (homeUrl && homeUrl !== cleanFailUrl) {
          lastRemountFailUrlRef.current = homeUrl;
          remountFailCountRef.current = 1;
          void useTabStore.getState().updateTabUrl(tab.id, homeUrl);
        } else {
          resetRemountFailState();
        }
        domReadyRef.current = false;
        onDomReadyChangeRef.current?.(false);
        setRemountKey(key => key + 1);
        return;
      }
    } else {
      lastRemountFailUrlRef.current = cleanFailUrl;
      remountFailCountRef.current = 1;
    }
    if (updateTabToFailUrl && cleanFailUrl && cleanFailUrl !== currentTabUrl) {
      void useTabStore.getState().updateTabUrl(tab.id, cleanFailUrl);
    }
    console.warn('[WebviewTab] Rebuilding failed guest:', tab.id, reason, cleanFailUrl);
    domReadyRef.current = false;
    onDomReadyChangeRef.current?.(false);
    setRemountKey(key => key + 1);
  }, [tab.id, profile.aiPlatformUrl, cancelReload, resetRemountFailState]);

  return { remountKey, domReadyRef, onDomReadyChangeRef, triggerRemount, resetRemountFailState, scheduleReload };
}
