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
import { useBookmarkStore } from '../../store/useBookmarkStore';
import { useProfileStore } from '../../store/useProfileStore';
import { useTabStore } from '../../store/useTabStore';
import {
  onToggleDevTools,
  maximizeToggleWindow,
  browserTabMigrateBack,
  onWebviewHotkey,
  consumeAccumulatedLinks,
} from '../../lib/electron-api';
import type { Profile } from '../../lib/electron-api';
import { AI_PLATFORMS } from '../../../electron/presets/ai-platforms';
import TabsPanel from './TabBar/TabsPanel';
import NavBar from './NavBar/NavBar';
import BookmarksBar from './BookmarksBar/BookmarksBar';
import BrowserWebviewTab from './BrowserWebviewTab';
import BrowserSettingsTab from './BrowserSettingsTab';
import BrowserStatusBar from './BrowserStatusBar';
import BookmarkManager from './BookmarksBar/BookmarkManager';
import NavHistoryPanel from '../HistoryDownloadView/NavHistoryPanel';
import DownloadPanel from '../HistoryDownloadView/DownloadPanel';
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
      // E1：消费主窗口 AI 应用内累积的链接，转为浏览器窗口的标签页。
      // consume 语义：取出并清空，避免重复消费。累积链接在主窗口拦截 new-window 时
      // 由 helpers.ts 写入（仅主窗口模式，浏览器窗口模式不累积）。
      try {
        const links = await consumeAccumulatedLinks(pid);
        if (links && links.length > 0) {
          const store = useBrowserTabStore.getState();
          for (const link of links) {
            store.newTab(link.url, { source: 'external', kind: 'web' });
            // newTab 不接受 title 参数，创建后立即更新标题为累积时的标题（通常为 URL）。
            // webview 加载页面后 page-title-updated 事件会自动更新为真实标题。
            const newTabId = useBrowserTabStore.getState().activeTabId;
            if (newTabId && link.title) {
              store.updateTabTitle(newTabId, link.title);
            }
          }
          console.log(`[BrowserView] E1 消费 ${links.length} 条累积链接`);
        }
      } catch (e) {
        console.warn('[BrowserView] E1 消费累积链接失败:', e);
      }

      // P1-3：确保窗口至少有一个非内部标签（空白首页标签）
      const internalSources = ['settings', 'bookmark-manager', 'history', 'downloads'];
      const store = useBrowserTabStore.getState();
      const hasNonInternal = store.tabs.some((t) => !internalSources.includes(t.source));
      if (!hasNonInternal) {
        store.newTab('', { source: 'initial', kind: 'home' });
      }
    })();
  }, [init]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeProfile = profile;

  // 主题色
  const platformDef = activeProfile?.aiPlatformId
    ? AI_PLATFORMS.find((p) => p.id === activeProfile.aiPlatformId)
    : null;
  const themeColor = activeProfile?.aiThemeColor || platformDef?.themeColor || '#c25a4a';

  // E3：根据标签状态同步窗口标题（document.title 控制 BrowserWindow 标题栏 + 任务栏文本）
  // - 存在 AI 应用标签（非内部设置/书签管理器）时显示 profile.name
  // - 所有 AI 应用标签关闭后回到默认 'SidekickAI'
  useEffect(() => {
    const hasAppTab = tabs.some(
      (t) => t.source !== 'settings' && t.source !== 'bookmark-manager' && t.source !== 'history' && t.source !== 'downloads',
    );
    if (hasAppTab && activeProfile) {
      document.title = activeProfile.name;
    } else {
      document.title = 'SidekickAI';
    }
  }, [tabs, activeProfile]);

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
    const homeUrl = activeProfile?.browserHomePage || activeProfile?.aiPlatformUrl;
    if (homeUrl && activeTabId) {
      setNavigateUrl(homeUrl);
    }
  }, [activeProfile?.browserHomePage, activeProfile?.aiPlatformUrl, activeTabId]);

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

  /* ===== F6 聚焦循环 ===== */
  // 地址栏 → 页面内可输入区域 → 不聚焦（返回页面内容）之间循环
  const handleFocusCycle = useCallback(() => {
    const addressBar = addressBarRef.current;
    // 1. 当前焦点在地址栏 → 聚焦页面内第一个可输入元素
    if (addressBar && document.activeElement === addressBar) {
      const webview = webviewContainerRef.current?.querySelector(
        `webview[data-tab-id="${activeTabId}"]`,
      ) as WebviewElement | null;
      if (webview) {
        webview.executeJavaScript(
          `(function() {
            var el = document.querySelector('textarea:not([disabled]):not([readonly])')
                   || document.querySelector('input:not([disabled]):not([readonly])')
                   || document.querySelector('div[contenteditable=true]');
            if (el) { el.focus(); return true; }
            return false;
          })()`,
        ).catch(() => {});
      }
      return;
    }
    // 2. 检查 webview 内是否有可输入元素聚焦
    const webview = webviewContainerRef.current?.querySelector(
      `webview[data-tab-id="${activeTabId}"]`,
    ) as WebviewElement | null;
    if (webview) {
      webview.executeJavaScript(
        `(function() {
          var el = document.activeElement;
          if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
            el.blur();
            return true;
          }
          return false;
        })()`,
      )
        .then((inInput: unknown) => {
          // 3. 焦点不在页面可输入元素 → 聚焦地址栏
          if (!inInput) addressBar?.focus();
        })
        .catch(() => {
          addressBar?.focus();
        });
    } else {
      addressBar?.focus();
    }
  }, [activeTabId]);

  // ref 保证 onWebviewHotkey 监听器能调用最新的 handleFocusCycle
  const focusCycleRef = useRef(handleFocusCycle);
  focusCycleRef.current = handleFocusCycle;

  /* ===== Ctrl+D：添加当前页面到书签 ===== */
  const handleAddBookmark = useCallback(() => {
    if (!activeProfile) return;
    const store = useBrowserTabStore.getState();
    const tab = store.tabs.find((t) => t.id === store.activeTabId);
    if (!tab || !tab.url) return;
    const bookmarkStore = useBookmarkStore.getState();
    if (!bookmarkStore.loaded) void bookmarkStore.load();
    void bookmarkStore.add({
      title: tab.title || tab.url,
      url: tab.url,
      favicon: tab.favicon,
      profileId: activeProfile.id,
      profileName: activeProfile.name,
      aiPlatformId: activeProfile.aiPlatformId,
      inBookmarkBar: true,
    });
  }, [activeProfile]);

  /* ===== Ctrl+K / Ctrl+E：聚焦地址栏并进入搜索模式 ===== */
  const handleFocusSearch = useCallback(() => {
    const addressBar = addressBarRef.current;
    if (addressBar) {
      addressBar.focus();
      addressBar.select();
    }
  }, []);

  /* ===== Ctrl+F：页内查找（注入 find 脚本） ===== */
  const handleFindInPage = useCallback(() => {
    const webview = webviewContainerRef.current?.querySelector(
      `webview[data-tab-id="${activeTabId}"]`,
    ) as WebviewElement | null;
    if (!webview) return;
    webview.executeJavaScript(
      `(function() {
        var existing = document.getElementById('__sidekick_find_bar');
        if (existing) { existing.remove(); return; }
        var bar = document.createElement('div');
        bar.id = '__sidekick_find_bar';
        bar.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;background:#fff;color:#333;border:1px solid #ccc;border-radius:4px;padding:6px 8px;box-shadow:0 2px 8px rgba(0,0,0,0.25);font-family:sans-serif;font-size:13px;display:flex;align-items:center;gap:6px;';
        var input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '查找...';
        input.style.cssText = 'border:1px solid #ddd;border-radius:2px;padding:3px 6px;width:180px;outline:none;font-size:13px;';
        var info = document.createElement('span');
        info.style.cssText = 'min-width:40px;color:#666;font-size:12px;';
        var closeBtn = document.createElement('button');
        closeBtn.textContent = '\\u2715';
        closeBtn.style.cssText = 'border:none;background:none;cursor:pointer;font-size:14px;color:#999;padding:0 2px;';
        closeBtn.onclick = function() { bar.remove(); };
        function doFind(reverse) {
          if (!input.value) { info.textContent = ''; return; }
          var found = window.find(input.value, false, reverse, true, false, true, false);
          info.textContent = found ? '' : '未找到';
        }
        input.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') { e.preventDefault(); doFind(e.shiftKey); }
          if (e.key === 'Escape') { e.preventDefault(); bar.remove(); }
        });
        bar.appendChild(input);
        bar.appendChild(info);
        bar.appendChild(closeBtn);
        document.body.appendChild(bar);
        input.focus();
      })()`,
    ).catch(() => {});
  }, [activeTabId]);

  /* ===== Ctrl+P：打印当前页面 ===== */
  const handlePrint = useCallback(() => {
    const webview = webviewContainerRef.current?.querySelector(
      `webview[data-tab-id="${activeTabId}"]`,
    ) as WebviewElement | null;
    webview?.print();
  }, [activeTabId]);

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
    onMaximize: () => { void maximizeToggleWindow(); },
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
    onFocusCycle: handleFocusCycle,
    onAddBookmark: handleAddBookmark,
    onFocusSearch: handleFocusSearch,
    onFindInPage: handleFindInPage,
    onPrint: handlePrint,
  });

  /* ===== 主进程事件监听 ===== */

  // 关闭窗口时，将所有网页标签迁移回主窗口（按 parentTabId 精确恢复）
  useEffect(() => {
    const handleBeforeUnload = () => {
      const store = useBrowserTabStore.getState();
      if (!store.profileId) return;
      // E2：收集所有非内部标签的 finalUrls + parentTabId + originalOrder + source
      // originalOrder：同 parentTabId 内的原始排序，主窗口据此按序插入到父标签右侧
      // source：'settings' 迁移后通知主窗口切换至主页（不作为主窗口主页插入）
      const finalUrls = store.tabs
        .filter((t) => t.source !== 'settings' && t.source !== 'bookmark-manager' && t.source !== 'history' && t.source !== 'downloads')
        .map((t, idx) => ({
          parentTabId: t.parentTabId,
          url: t.url || '',
          title: t.title || '',
          originalOrder: idx,
          source: t.source,
          // 兼容旧字段：tabId 用于旧版主窗口回退逻辑
          tabId: t.parentTabId || t.id,
        }));
      // 兼容：同时传当前激活标签的 url/title（旧逻辑）
      const activeTab = store.tabs.find((t) => t.id === store.activeTabId);
      const isMigratable = activeTab && activeTab.source !== 'settings' && activeTab.source !== 'bookmark-manager' && activeTab.source !== 'history' && activeTab.source !== 'downloads';
      const activeUrl = isMigratable
        ? (activeTab.url || '')
        : (finalUrls[0]?.url ?? '');
      const activeTitle = isMigratable
        ? (activeTab.title || '')
        : (finalUrls[0]?.title ?? '');
      browserTabMigrateBack({
        profileId: store.profileId,
        url: activeUrl,
        title: activeTitle,
        finalUrls,
      });
      // D3: 迁移完成后触发主窗口 AI 输入框聚焦
      useTabStore.getState().triggerFocusAiInput();
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
    return () => { offDevTools(); };
  }, [activeTabId]);

  // v0.0.9 B4：接收主进程 before-input-event 转发的 Ctrl+W（closeTab），
  // 确保浏览器窗口任意位置（含 webview 焦点）都能关闭当前标签。
  useEffect(() => {
    const off = onWebviewHotkey((payload) => {
      if (payload.action === 'closeTab') {
        const store = useBrowserTabStore.getState();
        if (store.activeTabId) store.closeTab(store.activeTabId);
      } else if (payload.action === 'focusCycle') {
        focusCycleRef.current();
      }
    });
    return off;
  }, []);

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
          onOpenHistory={handleOpenHistory}
          onOpenDownloads={handleOpenDownloads}
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
          // 导航历史标签页
          if (tab.source === 'history') {
            return (
              <div
                key={tab.id}
                data-name="browser.history-tab"
                style={{
                  display: tab.id === activeTabId ? 'flex' : 'none',
                  position: 'absolute',
                  inset: 0,
                  overflow: 'auto',
                  background: 'var(--background, #1a1a1a)',
                }}
              >
                <NavHistoryPanel />
              </div>
            );
          }
          // 下载管理标签页
          if (tab.source === 'downloads') {
            return (
              <div
                key={tab.id}
                data-name="browser.downloads-tab"
                style={{
                  display: tab.id === activeTabId ? 'flex' : 'none',
                  position: 'absolute',
                  inset: 0,
                  overflow: 'auto',
                  background: 'var(--background, #1a1a1a)',
                }}
              >
                <DownloadPanel />
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

      {/* 底部状态栏：加载进度 + 状态文本 */}
      <BrowserStatusBar />

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
  executeJavaScript(script: string): Promise<unknown>;
  print(): void;
}
