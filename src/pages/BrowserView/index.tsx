/* =====================================================================
   pages/BrowserView/index.tsx —— 浏览器窗口主容器（v0.0.9 三层栏）
   三层栏结构：
     第一栏 TabsPanel —— 标签页管理 + 窗口控制
     第二栏 NavBar —— 导航 + 地址栏 + 工具入口
     第三栏 BookmarksBar —— 全局书签栏（可显隐）
   webview 容器：webview 池 + 设置/书签管理器标签页。
   关闭时自动将当前激活标签迁移回主窗口。
   ===================================================================== */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useBrowserTabStore } from '../../store/useBrowserTabStore';
import { useProfileStore } from '../../store/useProfileStore';
import {
  onToggleDevTools,
  onToggleFullscreen,
  toggleFullscreenWindow,
  browserTabMigrateBack,
} from '../../lib/electron-api';
import type { Profile } from '../../lib/electron-api';
import { AI_PLATFORMS } from '../../../electron/presets/ai-platforms';
import TabsPanel from './TabBar/TabsPanel';
import NavBar from './NavBar/NavBar';
import BookmarksBar from './BookmarksBar/BookmarksBar';
import BrowserWebviewTab from './BrowserWebviewTab';
import BrowserSettingsTab from './BrowserSettingsTab';
import BookmarkManager from './BookmarksBar/BookmarkManager';
import { useBrowserKeyboard } from './useBrowserKeyboard';
import WindowResizeHandles from '../../components/WindowResizeHandles';
import './styles.css';

/** 从 URL 查询参数获取值 */
function getQueryParam(key: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(key);
}

export default function BrowserView() {
  const {
    tabs,
    activeTabId,
    profileId,
    initialized,
    init,
    newTab,
    switchTab,
    navigateTab,
    updateTabNavState,
    bookmarkBarVisible,
    setBookmarkBarVisible,
  } = useBrowserTabStore();

  const profiles = useProfileStore((s) => s.profiles);
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const addressBarRef = useRef<HTMLInputElement | null>(null);
  const webviewContainerRef = useRef<HTMLDivElement | null>(null);
  const [navigateUrl, setNavigateUrl] = useState<string | null>(null);

  // 初始化
  useEffect(() => {
    const windowId = getQueryParam('windowId') || '';
    const pid = getQueryParam('profileId') || '';
    if (!windowId || !pid) return;

    void (async () => {
      await useProfileStore.getState().loadProfiles();
      await init(windowId, pid);
      const p = useProfileStore.getState().profiles.find((pr) => pr.id === pid) ?? null;
      setProfile(p);
      setReady(true);
    })();
  }, [init]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeProfile = profile;

  // 主题色
  const platformDef = activeProfile?.aiPlatformId
    ? AI_PLATFORMS.find((p) => p.id === activeProfile.aiPlatformId)
    : null;
  const themeColor = activeProfile?.aiThemeColor || platformDef?.themeColor || '#c25a4a';

  /* ===== 导航回调 ===== */

  const handleGoBack = useCallback(() => {
    const webview = webviewContainerRef.current?.querySelector(
      `webview[data-tab-id="${activeTabId}"]`,
    ) as (WebviewElement & { canGoBack: () => boolean; goBack: () => void }) | null;
    if (webview?.canGoBack()) webview.goBack();
  }, [activeTabId]);

  const handleGoForward = useCallback(() => {
    const webview = webviewContainerRef.current?.querySelector(
      `webview[data-tab-id="${activeTabId}"]`,
    ) as (WebviewElement & { canGoForward: () => boolean; goForward: () => void }) | null;
    if (webview?.canGoForward()) webview.goForward();
  }, [activeTabId]);

  const handleRefresh = useCallback(() => {
    const webview = webviewContainerRef.current?.querySelector(
      `webview[data-tab-id="${activeTabId}"]`,
    ) as (WebviewElement & { reload: () => void }) | null;
    webview?.reload();
  }, [activeTabId]);

  const handleGoHome = useCallback(() => {
    if (activeProfile?.aiPlatformUrl && activeTabId) {
      setNavigateUrl(activeProfile.aiPlatformUrl);
    }
  }, [activeProfile?.aiPlatformUrl, activeTabId]);

  const handleNavigate = useCallback((url: string) => {
    if (url.includes('bing.com/search') && activeProfile) {
      const query = new URL(url).searchParams.get('q') || '';
      if (query) {
        void import('../../lib/electron-api').then((api) =>
          api.addSearchHistory({ profileId: activeProfile.id, query, url }),
        );
      }
    }
    setNavigateUrl(url);
  }, [activeProfile]);

  const handleNavigateComplete = useCallback(() => {
    setNavigateUrl(null);
  }, []);

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

  /* ===== 快捷键 ===== */

  useBrowserKeyboard({
    onFocusAddressBar: () => addressBarRef.current?.focus(),
    onRefresh: handleRefresh,
    onForceRefresh: () => {
      const webview = webviewContainerRef.current?.querySelector(
        `webview[data-tab-id="${activeTabId}"]`,
      ) as (WebviewElement & { reloadIgnoringCache: () => void }) | null;
      webview?.reloadIgnoringCache();
    },
    onGoBack: handleGoBack,
    onGoForward: handleGoForward,
    onStopLoading: () => {
      const webview = webviewContainerRef.current?.querySelector(
        `webview[data-tab-id="${activeTabId}"]`,
      ) as (WebviewElement & { stop: () => void }) | null;
      webview?.stop();
    },
    onToggleFullscreen: () => { void toggleFullscreenWindow(); },
    onToggleDevTools: () => {
      const webview = webviewContainerRef.current?.querySelector(
        `webview[data-tab-id="${activeTabId}"]`,
      ) as (WebviewElement & { isDevToolsOpened: () => boolean; openDevTools: () => void; closeDevTools: () => void }) | null;
      if (webview) {
        if (webview.isDevToolsOpened()) webview.closeDevTools();
        else webview.openDevTools();
      }
    },
    onToggleBookmarkBar: () => setBookmarkBarVisible(!bookmarkBarVisible),
  });

  /* ===== 主进程事件监听 ===== */

  // 关闭窗口时，将所有网页标签迁移回主窗口（按 parentTabId 精确恢复）
  useEffect(() => {
    const handleBeforeUnload = () => {
      const store = useBrowserTabStore.getState();
      if (!store.profileId) return;
      // 收集所有网页标签的最终 URL（排除设置/书签管理器）
      const finalUrls = store.tabs
        .filter((t) => t.source !== 'settings' && t.source !== 'bookmark-manager')
        .map((t) => ({
          tabId: t.parentTabId || t.id, // 用 parentTabId 关联主窗口原标签
          url: t.url || '',
          title: t.title || '',
        }));
      // 兼容：同时传当前激活标签的 url/title（旧逻辑）
      const activeTab = store.tabs.find((t) => t.id === store.activeTabId);
      const activeUrl = (activeTab && activeTab.source !== 'settings' && activeTab.source !== 'bookmark-manager')
        ? (activeTab.url || '')
        : (finalUrls[0]?.url ?? '');
      const activeTitle = (activeTab && activeTab.source !== 'settings' && activeTab.source !== 'bookmark-manager')
        ? (activeTab.title || '')
        : (finalUrls[0]?.title ?? '');
      browserTabMigrateBack({
        profileId: store.profileId,
        url: activeUrl,
        title: activeTitle,
        finalUrls,
      });
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  useEffect(() => {
    const offDevTools = onToggleDevTools(() => {
      const webview = webviewContainerRef.current?.querySelector(
        `webview[data-tab-id="${activeTabId}"]`,
      ) as (WebviewElement & { isDevToolsOpened: () => boolean; openDevTools: () => void; closeDevTools: () => void }) | null;
      if (webview) {
        if (webview.isDevToolsOpened()) webview.closeDevTools();
        else webview.openDevTools();
      }
    });
    const offFullscreen = onToggleFullscreen(() => { void toggleFullscreenWindow(); });
    return () => { offDevTools(); offFullscreen(); };
  }, [activeTabId]);

  /* ===== 加载态 ===== */

  if (!ready || !activeProfile) {
    return (
      <div className="browser-view app-shell" data-name="browser.loading">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#999' }}>
          正在加载...
        </div>
      </div>
    );
  }

  /* ===== 渲染 ===== */

  return (
    <div className="browser-view app-shell" data-name="browser.container">
      {/* 三层栏垂直堆叠 */}
      <div className="browser-bar-stack">
        {/* 第一栏：标签页栏 */}
        <TabsPanel
          profile={activeProfile}
          themeColor={themeColor}
          tabs={tabs}
          activeTabId={activeTabId}
          onOpenSettings={handleOpenSettings}
        />
        <div className="browser-bar-divider" />
        {/* 第二栏：导航与功能栏 */}
        <NavBar
          profile={activeProfile}
          themeColor={themeColor}
          activeTab={activeTab}
          canGoBack={activeTab?.canGoBack ?? false}
          canGoForward={activeTab?.canGoForward ?? false}
          onGoBack={handleGoBack}
          onGoForward={handleGoForward}
          onRefresh={handleRefresh}
          onGoHome={handleGoHome}
          onNavigate={handleNavigate}
          onOpenSettings={handleOpenSettings}
          addressBarRef={addressBarRef}
        />
        {/* 第三栏：书签栏（可显隐） */}
        <div className="browser-bar-divider" />
        <BookmarksBar
          visible={bookmarkBarVisible}
          onOpenBookmarkManager={handleOpenBookmarkManager}
        />
      </div>

      {/* Webview 容器 */}
      <div
        ref={webviewContainerRef}
        className="browser-webview-container"
        data-name="browser.webview-container"
      >
        {tabs.map((tab) => {
          // 设置标签页
          if (tab.source === 'settings') {
            return (
              <div
                key={tab.id}
                data-name="browser.settings-tab"
                style={{
                  display: tab.id === activeTabId ? 'flex' : 'none',
                  position: 'absolute',
                  inset: 0,
                  overflow: 'auto',
                  background: 'var(--background, #1a1a1a)',
                }}
              >
                <BrowserSettingsTab profile={activeProfile} />
              </div>
            );
          }
          // 书签管理器标签页
          if (tab.source === 'bookmark-manager') {
            return (
              <div
                key={tab.id}
                data-name="browser.bookmark-manager-tab"
                style={{
                  display: tab.id === activeTabId ? 'flex' : 'none',
                  position: 'absolute',
                  inset: 0,
                  overflow: 'auto',
                  background: 'var(--background, #1a1a1a)',
                }}
              >
                <BookmarkManager onOpenInNewTab={(url) => newTab(url, { kind: 'web' })} />
              </div>
            );
          }
          // 普通网页标签
          return (
            <BrowserWebviewTab
              key={tab.id}
              tab={tab}
              profile={activeProfile}
              active={tab.id === activeTabId}
              navigateUrl={tab.id === activeTabId ? navigateUrl : null}
              onNavigateComplete={handleNavigateComplete}
            />
          );
        })}
      </div>

      <WindowResizeHandles />
    </div>
  );
}

interface WebviewElement {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  reloadIgnoringCache(): void;
  stop(): void;
  isDevToolsOpened(): boolean;
  openDevTools(): void;
  closeDevTools(): void;
  getURL(): string;
  getTitle(): string;
  getWebContentsId(): number;
}
