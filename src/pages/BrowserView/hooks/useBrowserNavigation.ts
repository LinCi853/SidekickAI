/* =====================================================================
   pages/BrowserView/hooks/useBrowserNavigation.ts —— 浏览器窗口导航
   职责：
   - 地址栏导航（handleNavigate / handleNavigateComplete / handleGoHome）
   - 内部标签打开（设置 / 书签管理器 / 历史 / 下载）
   - 本地文件拖拽导入（文本/图片/PDF 等直接查看）
   ===================================================================== */

import { useCallback, useEffect, useState } from 'react';
import { useBrowserTabStore } from '../../../store/useBrowserTabStore.js';
import type { BrowserTabState, Profile } from '../../../lib/electron-api/index.js';
import { INTERNAL_TAB_SOURCES } from '../constants.js';

interface UseBrowserNavigationParams {
  activeTabId: string | null;
  activeProfile: Profile | null;
  tabs: BrowserTabState[];
  newTab: (url?: string, opts?: { source?: BrowserTabState['source']; kind?: 'home' | 'web' }) => string;
  switchTab: (tabId: string) => void;
}

export function useBrowserNavigation({
  activeTabId,
  activeProfile,
  tabs,
  newTab,
  switchTab,
}: UseBrowserNavigationParams) {
  const [navigateUrl, setNavigateUrl] = useState<string | null>(null);

  const handleNavigate = useCallback((url: string) => {
    // 查看源码标签激活时：输入 view-source 地址 → 更新当前标签（地址栏驱动的资源切换）；
    // 输入普通地址 → 新标签打开（内部标签不做页面导航）
    const store = useBrowserTabStore.getState();
    const currentTab = store.tabs.find((t) => t.id === store.activeTabId);
    if (currentTab?.source === 'view-source') {
      if (url.startsWith('sidekickai://view-source')) {
        store.navigateTab(currentTab.id, url);
      } else if (/^https?:/i.test(url)) {
        store.newTab(url, { kind: 'web' });
      }
      return;
    }
    if (url.includes('bing.com/search') && activeProfile) {
      const query = new URL(url).searchParams.get('q') || '';
      if (query) {
        void import('../../../lib/electron-api').then((api) =>
          api.addSearchHistory({ profileId: activeProfile.id, query, url }),
        );
      }
    }
    setNavigateUrl(url);
  }, [activeProfile]);

  const handleNavigateComplete = useCallback(() => {
    setNavigateUrl(null);
  }, []);

  const handleGoHome = useCallback(() => {
    const homeUrl = activeProfile?.browserHomePage || activeProfile?.aiPlatformUrl;
    if (!homeUrl || !activeTabId) return;
    const store = useBrowserTabStore.getState();
    const current = store.tabs.find((t) => t.id === activeTabId);
    const internal = INTERNAL_TAB_SOURCES;
    if (current && internal.includes(current.source)) {
      // 内部标签点主页：切换到已有主页标签，否则新建（内部标签无 webview 可导航）
      const homeTab = store.tabs.find((t) => !internal.includes(t.source) && t.kind === 'home');
      if (homeTab) store.switchTab(homeTab.id);
      else store.newTab(homeUrl, { kind: 'home' });
      return;
    }
    setNavigateUrl(homeUrl);
  }, [activeProfile?.browserHomePage, activeProfile?.aiPlatformUrl, activeTabId]);

  const handleOpenSettings = useCallback(() => {
    // 单实例：已有设置标签则切换，否则新建
    const existing = tabs.find((t) => t.source === 'settings');
    if (existing) {
      switchTab(existing.id);
    } else {
      newTab('sidekickai://settings', { source: 'settings' });
    }
  }, [tabs, newTab, switchTab]);

  const handleOpenBookmarkManager = useCallback(() => {
    // 单实例：已有书签管理器标签则切换，否则新建
    const existing = tabs.find((t) => t.source === 'bookmark-manager');
    if (existing) {
      switchTab(existing.id);
    } else {
      newTab('sidekickai://bookmarks', { source: 'bookmark-manager' });
    }
  }, [tabs, newTab, switchTab]);

  const handleOpenHistory = useCallback(() => {
    // 单实例：已有导航历史标签则切换，否则新建
    const existing = tabs.find((t) => t.source === 'history');
    if (existing) {
      switchTab(existing.id);
    } else {
      newTab('sidekickai://history', { source: 'history' });
    }
  }, [tabs, newTab, switchTab]);

  const handleOpenDownloads = useCallback(() => {
    // 单实例：已有下载管理标签则切换，否则新建
    const existing = tabs.find((t) => t.source === 'downloads');
    if (existing) {
      switchTab(existing.id);
    } else {
      newTab('sidekickai://downloads', { source: 'downloads' });
    }
  }, [tabs, newTab, switchTab]);

  useEffect(() => {
    return window.electron?.appSettings.onLocalFilesDropped(({ files }) => {
      for (const file of files) {
        newTab(file.url, file.kind === 'pdf' ? { source: 'print-preview', kind: 'web' } : { kind: 'web' });
      }
    });
  }, [newTab]);

  // 宿主 UI 区域拖入文件：打开查看（webview 区域由 guest 页面自行处理上传）
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);
  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const files = e.dataTransfer?.files;
    if (!e.nativeEvent.isTrusted || !files || files.length === 0) return;
    e.preventDefault();
    void window.electron?.appSettings.openDroppedFiles().catch(error => {
      console.warn('[BrowserView] Unable to open dropped files:', error);
    });
  }, []);

  return {
    navigateUrl,
    handleNavigate,
    handleNavigateComplete,
    handleGoHome,
    handleOpenSettings,
    handleOpenBookmarkManager,
    handleOpenHistory,
    handleOpenDownloads,
    handleDragOver,
    handleDrop,
  };
}
