import { useCallback, useEffect, useRef, useState } from 'react';
import { safeReloadWebview, safeLoadURLWebview, type WebviewElement } from '../../../lib/webview';
import { getPresetAIPlatforms } from '../../../lib/electron-api';
import type { Profile } from '../../../lib/electron-api';

interface Tab {
  id: string;
  profileId: string;
  url?: string;
  homeUrl?: string;
}

/**
 * Manages webview navigation state (canGoBack/canGoForward/domReady)
 * and navigation actions (back/forward/reload/home).
 */
export function useNavigation(
  activeTabId: string | null,
  tabs: Tab[],
  profiles: Profile[],
) {
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [activeTabDomReady, setActiveTabDomReady] = useState(false);
  const activeTabDomReadyRef = useRef(false);

  useEffect(() => { activeTabDomReadyRef.current = activeTabDomReady; }, [activeTabDomReady]);

  const getActiveWebview = useCallback((): WebviewElement | null => {
    if (!activeTabId) return null;
    return document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as WebviewElement | null;
  }, [activeTabId]);

  // Query navigation state on tab switch
  useEffect(() => {
    if (!activeTabId) { setCanGoBack(false); setCanGoForward(false); setActiveTabDomReady(false); return; }
    const wv = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as WebviewElement | null;
    if (wv) {
      try { setCanGoBack(wv.canGoBack()); setCanGoForward(wv.canGoForward()); } catch { /* ignore */ }
      setActiveTabDomReady(true);
    } else {
      setCanGoBack(false); setCanGoForward(false);
      setActiveTabDomReady(false);
    }
  }, [activeTabId]);

  const handleGoBack = useCallback(() => {
    const wv = getActiveWebview();
    try {
      if (wv && wv.canGoBack()) wv.goBack();
    } catch (e) {
      console.error('[MainView] goBack 失败:', e);
    }
  }, [getActiveWebview]);

  const handleGoForward = useCallback(() => {
    const wv = getActiveWebview();
    try {
      if (wv && wv.canGoForward()) wv.goForward();
    } catch (e) {
      console.error('[MainView] goForward 失败:', e);
    }
  }, [getActiveWebview]);

  const handleReload = useCallback(() => {
    const wv = getActiveWebview();
    if (!wv) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    const profile = tab ? profiles.find((p) => p.id === tab.profileId) : null;
    const fallbackUrl = (tab?.url || profile?.aiPlatformUrl || '') as string;
    safeReloadWebview(wv, fallbackUrl, activeTabDomReadyRef.current);
  }, [getActiveWebview, tabs, activeTabId, profiles]);

  const handleGoHome = useCallback(() => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    const profile = profiles.find((p) => p.id === tab.profileId);
    let homeUrl = tab.homeUrl || profile?.aiPlatformUrl || tab.url;
    if (!homeUrl && profile?.aiPlatformId) {
      const preset = getPresetAIPlatforms().find((p) => p.id === profile.aiPlatformId);
      if (preset) homeUrl = preset.url;
    }
    if (!homeUrl) return;
    const wv = getActiveWebview();
    if (!wv) return;
    safeLoadURLWebview(wv, homeUrl);
  }, [tabs, activeTabId, profiles, getActiveWebview]);

  /** Called by WebviewTab onNavigationChange to update back/forward state from webview events */
  const handleNavigationChange = useCallback((back: boolean, fwd: boolean) => {
    setCanGoBack(back);
    setCanGoForward(fwd);
  }, []);

  return {
    canGoBack,
    canGoForward,
    activeTabDomReady,
    activeTabDomReadyRef,
    getActiveWebview,
    setActiveTabDomReady,
    handleNavigationChange,
    handleGoBack,
    handleGoForward,
    handleReload,
    handleGoHome,
  };
}
