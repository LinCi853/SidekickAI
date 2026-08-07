/* =====================================================================
   pages/MainView.tsx —— 主窗口视图（多标签 + 顶栏 + 底栏）
   架构：
   - 中央：多 <webview> 并存，仅激活标签可见（切换不重建，保留状态）
   - 顶栏（宽屏常驻；窄屏隐藏，控制按钮移到底栏）：AppSwitcher 图标 → 可编辑标题 → 最小化/最大化/关闭/置顶
   - 底栏（auto-hide，可展开可拖拽调高）：
       · 折叠行：当前标签列表 + 展开按钮
       · 展开面板：标签列表（关闭/脱离）+ 应用快捷切换 + 设置 + 快捷键 + 指纹
   - 默认首次打开 DeepSeek（而非本应用设置）
   - 所有状态通过 useTabStore 持久化（bounds / tabs / activeTabId / alwaysOnTop / bottomBarExpanded / bottomBarHeight）
   ===================================================================== */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  openSettingsWindow,
  openHistoryWindow,
  openPromptWindow,
  getLastConversationUrl,
  isWindowMaximized,
  onBrowserTabMigrateBack,
  onBrowserTabDetached,
  onChatRequestConfig,
} from '../../lib/electron-api';
import type { Profile } from '../../lib/electron-api';
import ShortcutsModal from '../../components/ShortcutsModal';
import DrawerPanel from '../../components/DrawerPanel';
import WindowResizeHandles from '../../components/WindowResizeHandles';
import { useHotkeys } from '../../hooks/useHotkeys';
import { focusInputInWebview, type WebviewLike } from '../../hooks/useWebViewControl';
import { useProfileStore } from '../../store/useProfileStore';
import { useTabStore } from '../../store/useTabStore';
import { useThemeStore } from '../../store/useThemeStore';
import { AI_PLATFORMS } from '../../../electron/presets/ai-platforms';
import './styles.css';
import { WebviewTab } from './WebviewTab';
import TabContextMenu from './TabContextMenu';
import BottomBar from './BottomBar';
import TopBar from './TopBar';
import TabBar from './TabBar';
import { useTabContextMenu } from './useTabContextMenu';
import { useMainViewKeyboard } from './useMainViewKeyboard';
import { useShortcutsToggle } from '../../hooks/useShortcutsToggle';
import FileDropOverlay from './FileDropOverlay';
import InjectionPreviewModal from '../../components/InjectionPreviewModal';

// Extracted hooks
import { useMainViewData } from './hooks/useMainViewData';
import { useTitleEditing } from './hooks/useTitleEditing';
import { useNavigation } from './hooks/useNavigation';
import { useWebviewHotkeyDispatch } from './hooks/useWebviewHotkeyDispatch';
import { useVoiceInjection } from './hooks/useVoiceInjection';
import { usePromptInjection } from './hooks/usePromptInjection';
import { useFileDragDrop } from './hooks/useFileDragDrop';
import { useTabDragSort } from './hooks/useTabDragSort';
import { useWindowMinWidth } from './hooks/useWindowMinWidth';
import { useOxyTheme } from './hooks/useOxyTheme';

export default function MainView() {
  // Store state
  const {
    tabs,
    activeTabId,
    isMaximized,
    alwaysOnTop,
    bottomBarExpanded,
    bottomBarHeight,
    initialized,
    addTab,
    closeTab,
    setActiveTab,
    renameTab,
    updateTabUrl,
    updateTabHomeUrl,
    moveTab,
    detachTab,
    setAlwaysOnTop,
    setMaximized,
    toggleBottomBar,
    setBottomBarHeight,
    detachedProfiles,
    addDetachedProfile,
    removeDetachedProfile,
  } = useTabStore();

  const profiles = useProfileStore((s) => s.profiles);
  const updateProfile = useProfileStore((s) => s.updateProfile);
  const updateProfileUaLockMode = useProfileStore((s) => s.updateProfileUaLockMode);

  // D3: 监听 AI 输入框聚焦触发器（标签迁回主窗口时触发）
  const focusAiInputTrigger = useTabStore((s) => s.focusAiInputTrigger);

  // Extracted hooks
  const {
    platforms,
    hotkeys,
    shortcutsOpen,
    setShortcutsOpen,
    drawerOpen,
    setDrawerOpen,
    isNarrow,
    isDarkTheme,
    isTabBarCollapsed,
    enterToSend,
    appClickBehavior,
    topBarVisibleButtons,
  } = useMainViewData();

  const {
    isEditingTitle,
    setIsEditingTitle,
    titleDraft,
    setTitleDraft,
    titleInputRef,
    startEditTitle,
    commitTitle,
  } = useTitleEditing(tabs, activeTabId, profiles, renameTab, updateProfile);

  const {
    canGoBack,
    canGoForward,
    activeTabDomReady,
    activeTabDomReadyRef,
    setActiveTabDomReady,
    handleNavigationChange,
    handleGoBack,
    handleGoForward,
    handleReload,
    handleGoHome,
  } = useNavigation(activeTabId, tabs, profiles);

  useWebviewHotkeyDispatch(addTab, closeTab, detachTab, setShortcutsOpen, activeTabDomReadyRef);

  const visibleTabs = useMemo(
    () => tabs.filter((t) => !detachedProfiles.has(t.profileId)),
    [tabs, detachedProfiles],
  );
  const activeTab = visibleTabs.find((t) => t.id === activeTabId) ?? null;
  const activeTitle = activeTab?.title ?? '工百窗';

  const getProfile = useCallback(
    (profileId: string) => profiles.find((p) => p.id === profileId) ?? null,
    [profiles],
  );

  const { injectAndSendVoice } = useVoiceInjection(activeTab, getProfile, platforms);
  const {
    previewState,
    handleInjectPrompt,
    handleConfirmInjection,
    handleCancelInjection,
  } = usePromptInjection(activeTab, getProfile, platforms);

  const { isDragOver, downloadToast } = useFileDragDrop(platforms);

  const {
    draggingTabId,
    hoverTabId,
    handleTabDragOver,
    handleTabDrop,
    handleTabDragStart,
    handleTabDragEnd,
  } = useTabDragSort(moveTab, detachTab);

  useWindowMinWidth(activeTitle, topBarVisibleButtons);
  const { isOxy } = useOxyTheme(activeTabId, tabs, profiles, platforms);

  // Remaining inline state
  const [isBottomHovered, setIsBottomHovered] = useState(false);

  // Keyboard shortcuts
  useHotkeys({});
  useMainViewKeyboard(bottomBarExpanded, toggleBottomBar);
  useShortcutsToggle(shortcutsOpen, setShortcutsOpen);

  // D3: focusAiInputTrigger 变化时聚焦当前激活标签的 AI 输入框
  useEffect(() => {
    if (focusAiInputTrigger <= 0) return;
    const activeTabId = useTabStore.getState().activeTabId;
    if (!activeTabId) return;
    const wv = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as WebviewLike | null;
    if (!wv) return;
    const tab = useTabStore.getState().tabs.find((t) => t.id === activeTabId);
    const profile = tab ? useProfileStore.getState().profiles.find((p) => p.id === tab.profileId) : null;
    const platform = profile?.aiPlatformId
      ? AI_PLATFORMS.find((p) => p.id === profile.aiPlatformId)
      : null;
    const selector = profile?.aiInputSelector || platform?.inputSelector || null;
    wv.focus?.();
    void focusInputInWebview(wv, selector);
  }, [focusAiInputTrigger]);

  // Browser tab migration
  // P0-4：一个 AI 应用 = 一个主标签。浏览器窗口关闭时仅恢复主标签（更新 URL/title），
  // 不再迁移多个标签。浏览器窗口内的浏览历史通过 navHistoryStore 独立保存。
  useEffect(() => {
    const off = onBrowserTabMigrateBack(({ profileId, url }) => {
      removeDetachedProfile(profileId);
      const allTabs = useTabStore.getState().tabs;

      // 按 profileId 查找主窗口中的已有标签（即被脱离的父标签）
      const existingTab = allTabs.find((t) => t.profileId === profileId);
      if (existingTab) {
        // 更新主标签 URL 为浏览器窗口中最后浏览的页面
        if (url) {
          void useTabStore.getState().updateTabUrl(existingTab.id, url);
        }
        useTabStore.getState().setActiveTab(existingTab.id);
      }

      // D3: 标签迁回后触发 AI 输入框聚焦
      useTabStore.getState().triggerFocusAiInput();
    });
    return () => off();
  }, [removeDetachedProfile]);

  useEffect(() => {
    const off = onBrowserTabDetached((profileId, newActiveTabId) => {
      addDetachedProfile(profileId);
      if (newActiveTabId) {
        useTabStore.getState().setActiveTab(newActiveTabId);
      }
    });
    return () => off();
  }, [addDetachedProfile]);

  // Chat request config: open settings on Alt+Q
  useEffect(() => {
    const off = onChatRequestConfig(() => {
      void openSettingsWindow();
    });
    return off;
  }, []);

  // Default DeepSeek on first launch
  useEffect(() => {
    if (!initialized || visibleTabs.length > 0 || profiles.length === 0) return;
    const builtIn = profiles.find((p) => p.isBuiltIn);
    const deepseek = builtIn ?? profiles.find(
      (p) => p.isAIPlatform && p.aiPlatformUrl?.includes('deepseek'),
    );
    const target =
      deepseek ?? profiles.find((p) => p.isAIPlatform) ?? profiles[0];
    if (!target) return;
    void (async () => {
      try {
        const { getAppSettings } = await import('../../lib/electron-api');
        const cfg = await getAppSettings();
        if (cfg.startupOpen === 'lastConversation') {
          const lastUrl = await getLastConversationUrl(target.id);
          if (lastUrl) {
            await addTab(target, { url: lastUrl });
            return;
          }
        }
      } catch (e) {
        console.warn('[MainView] 读取 startupOpen 失败，回退首页:', e);
      }
      void addTab(target);
    })();
  }, [initialized, tabs.length, visibleTabs.length, profiles, addTab]);

  // Sync initial maximized state
  useEffect(() => {
    if (!initialized) return;
    isWindowMaximized()
      .then((m) => setMaximized(m))
      .catch((e) => console.warn('[main-view] 操作失败:', e));
  }, [initialized, setMaximized]);

  const handleMaximize = useCallback(() => {
    useTabStore.getState().toggleMaximize();
  }, []);

  const handleCloseActiveTab = useCallback(() => {
    if (activeTabId) void closeTab(activeTabId);
  }, [activeTabId, closeTab]);

  const handleHandleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      toggleBottomBar();
    },
    [toggleBottomBar],
  );

  const effectiveTabBarCollapsed = isOxy ? true : isTabBarCollapsed;

  const activeProfile = activeTab ? (profiles.find((p) => p.id === activeTab.profileId) ?? null) : null;
  const activeUaLockMode = activeProfile?.uaLockMode;

  const handleToggleUaLockMode = useCallback(() => {
    if (!activeProfile) return;
    const current = activeProfile.uaLockMode ?? 'auto';
    const next: 'auto' | 'mobile' | 'desktop' =
      current === 'auto' ? 'mobile' : current === 'mobile' ? 'desktop' : 'auto';
    void updateProfileUaLockMode(activeProfile.id, next);
  }, [activeProfile, updateProfileUaLockMode]);

  const openProfileIds = useMemo(
    () => new Set(tabs.filter((t) => !detachedProfiles.has(t.profileId)).map((t) => t.profileId)),
    [tabs, detachedProfiles],
  );

  const handleAppClick = useCallback(
    (profile: Profile) => {
      const existingTab = tabs.find((t) => t.profileId === profile.id);
      if (existingTab && existingTab.id === activeTabId) {
        if (appClickBehavior === 'close') {
          void closeTab(existingTab.id);
        } else {
          setActiveTab(existingTab.id);
        }
      } else {
        void addTab(profile);
      }
    },
    [addTab, closeTab, tabs, activeTabId, appClickBehavior],
  );

  // Context menu
  const {
    contextMenuTabId,
    contextMenuPosition,
    urlDraft,
    editingTabUrl,
    urlInputRef,
    contextMenuHomeUrl,
    contextMenuIsAiPlatform,
    closeContextMenu,
    refreshTab,
    clearTabData,
    closeOtherTabs,
    closeTabsToRight,
    setAsAIHome,
    configureApp,
    screenshotToWhiteboard,
    handleTabContextMenu,
    commitTabUrl,
    setUrlDraft,
    setEditingTabUrl,
  } = useTabContextMenu({
    tabs,
    getProfile,
    closeTab,
    updateTabUrl,
    updateTabHomeUrl,
    isTabDomReady: (tabId: string) => tabId === activeTabId ? activeTabDomReadyRef.current : true,
  });

  return (
    <>
      <div
        className="main-view app-shell"
        data-viewport={isNarrow ? 'narrow' : 'wide'}
        data-oxy={isOxy ? 'true' : undefined}
        data-name="main.main-view.container"
      >
        <TopBar
          data={{
            editingTitle: isEditingTitle,
            titleDraft,
            alwaysOnTop,
            isMaximized,
            activeTitle,
            hasActiveTab: !!activeTabId,
            canGoBack,
            canGoForward,
            activeTabDomReady,
            titleInputRef,
            platforms,
            isDark: isDarkTheme,
            isNarrow,
            uaLockMode: activeUaLockMode,
            hasActiveProfile: !!activeProfile,
            visibleButtons: topBarVisibleButtons,
            onAppClick: handleAppClick,
            appClickBehavior,
            activeProfileId: activeTab?.profileId ?? null,
          }}
          actions={{
            startEditTitle,
            commitTitle,
            setTitleDraft,
            setEditingTitle: setIsEditingTitle,
            handleGoBack,
            handleGoForward,
            handleReload,
            handleGoHome,
            handleMaximize,
            handleTogglePin: () => useTabStore.getState().toggleAlwaysOnTop(),
            setDrawerOpen,
            onOpenSettings: () => void openSettingsWindow(),
            onToggleTheme: () => useThemeStore.getState().toggleTheme(),
            onToggleUaLockMode: handleToggleUaLockMode,
          }}
        />

        <TabBar
          data={{
            tabs: visibleTabs,
            activeTabId,
            draggingTabId,
            hoverTabId,
            collapsed: effectiveTabBarCollapsed,
            platforms,
            maxRows: isOxy ? 2 : 1,
          }}
          actions={{
            getProfile,
            setActiveTab,
            closeTab,
            onTabContextMenu: handleTabContextMenu,
            onTabDragStart: handleTabDragStart,
            onTabDragOver: handleTabDragOver,
            onTabDrop: handleTabDrop,
            onTabDragEnd: handleTabDragEnd,
          }}
        />

        <div className="webview-container" data-name="main.main-view.webview-container">
          {visibleTabs.map((tab) => {
            const profile = getProfile(tab.profileId);
            if (!profile) return null;
            const platform = profile.isAIPlatform
              ? platforms.find((p) => p.id === profile.aiPlatformId || p.url === profile.aiPlatformUrl)
              : null;
            const desktopPresetId = platform?.defaultDesktopPreset ?? 'win-chrome-125';
            const mobilePresetId = platform?.defaultMobilePreset ?? 'iphone-15-pro-safari';
            return (
              <WebviewTab
                key={tab.id}
                tab={tab}
                profile={profile}
                active={tab.id === activeTabId}
                isNarrow={isNarrow}
                desktopPresetId={desktopPresetId}
                mobilePresetId={mobilePresetId}
                inputSelector={profile?.aiInputSelector || platform?.inputSelector || null}
                sendSelector={profile?.aiSendSelector || platform?.sendSelector || null}
                enterToSend={enterToSend}
                onNavigationChange={(back, fwd) => {
                  if (tab.id === activeTabId) {
                    handleNavigationChange(back, fwd);
                  }
                }}
                onDomReadyChange={(isReady) => {
                  if (tab.id === activeTabId) {
                    setActiveTabDomReady(isReady);
                  }
                }}
                onProcessGone={(reason) => {
                  console.warn('[MainView] webview 进程崩溃，已触发自动恢复:', tab.id, reason);
                  if (tab.id === activeTabId) {
                    setActiveTabDomReady(false);
                  }
                }}
              />
            );
          })}
        </div>

        {bottomBarExpanded && (
          <div
            className="bottom-bar-overlay"
            onClick={() => toggleBottomBar()}
            aria-hidden="true"
            data-name="main.main-view.bottom-overlay"
          />
        )}

        <BottomBar
          expanded={bottomBarExpanded}
          height={bottomBarHeight}
          platforms={platforms}
          openProfileIds={openProfileIds}
          callbacks={{
            onAppClick: handleAppClick,
            onInjectPrompt: handleInjectPrompt,
            onOpenSettings: () => void openSettingsWindow(),
            onOpenShortcuts: () => setShortcutsOpen(true),
            onToggle: toggleBottomBar,
            onHandleClick: handleHandleClick,
          }}
          appClickBehavior={appClickBehavior}
          activeProfileId={activeTab?.profileId ?? null}
        />

        <DrawerPanel
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onOpenSearch={() => void openHistoryWindow()}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onOpenSettings={() => void openSettingsWindow()}
          onOpenPromptLibrary={() => void openPromptWindow()}
        />

        <ShortcutsModal
          open={shortcutsOpen}
          onClose={() => setShortcutsOpen(false)}
          hotkeys={hotkeys}
        />

        <WindowResizeHandles />

        {contextMenuPosition && contextMenuTabId && (
          <TabContextMenu
            position={contextMenuPosition}
            tabId={contextMenuTabId}
            homeUrl={contextMenuHomeUrl}
            urlDraft={urlDraft}
            editingTabUrl={editingTabUrl}
            urlInputRef={urlInputRef}
            isAiPlatformTab={contextMenuIsAiPlatform}
            actions={{
              refresh: refreshTab,
              clearData: clearTabData,
              setAsHome: setAsAIHome,
              configureApp,
              screenshotToWhiteboard,
              detach: detachTab,
              closeOthers: closeOtherTabs,
              closeRight: closeTabsToRight,
              closeTab,
              commitUrl: commitTabUrl,
              setUrlDraft: setUrlDraft,
              setEditingUrl: setEditingTabUrl,
              close: closeContextMenu,
            }}
          />
        )}

        <FileDropOverlay visible={isDragOver} />

        {downloadToast && (
          <div
            role="status"
            aria-live="polite"
            data-name="main.main-view.download-toast"
            style={{
              position: 'fixed',
              left: '50%',
              bottom: 'calc(var(--space-12, 48px) + var(--space-2, 8px))',
              transform: 'translateX(-50%)',
              padding: '8px 16px',
              background: 'var(--card, #fff)',
              color: 'var(--foreground, #333)',
              border: '1px solid var(--border, #ddd)',
              borderRadius: 6,
              fontSize: 13,
              boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
              zIndex: 100,
              pointerEvents: 'none',
            }}
          >
            {downloadToast}
          </div>
        )}

        <InjectionPreviewModal
          open={previewState.open}
          composedText={previewState.composedText}
          similarRecords={previewState.similarRecords}
          onConfirm={handleConfirmInjection}
          onCancel={handleCancelInjection}
        />
      </div>
    </>
  );
}
