/* =====================================================================
   pages/BrowserView/index.tsx —— 浏览器窗口主容器（v0.0.9 三层栏）
   三层栏结构：
      第一栏 TabsPanel —— 标签页管理 + 窗口控制
      第二栏 NavBar —— 导航 + 地址栏 + 工具入口
      第三栏 BookmarksBar —— 全局书签栏（可显隐）
   webview 容器：webview 池 + 设置/书签管理器标签页。
   关闭时自动将当前激活标签迁移回主窗口。

   本文件为薄编排层：组合 useBrowserInit / useBrowserNavigation /
   useBrowserWebview / useBrowserShortcuts 四个 hook，并渲染子组件。
   ===================================================================== */

import { AI_PLATFORMS } from '../../../electron/presets/ai-platforms.js';
import TabsPanel from './TabBar/TabsPanel.js';
import NavBar from './NavBar/NavBar.js';
import BookmarksBar from './BookmarksBar/BookmarksBar.js';
import BrowserWebviewTab from './BrowserWebviewTab.js';
import BrowserSettingsTab from './BrowserSettingsTab.js';
import ViewSourceTab from './ViewSourceTab.js';
import PrintPreviewTab from './PrintPreviewTab.js';
import BrowserStatusBar from './BrowserStatusBar.js';
import BookmarkManager from './BookmarksBar/BookmarkManager.js';
import NavHistoryPanel from '../HistoryDownloadView/NavHistoryPanel.js';
import DownloadPanel from '../HistoryDownloadView/DownloadPanel.js';
import ZoomIndicator from './ZoomIndicator.js';
import WindowResizeHandles from '../../components/WindowResizeHandles.js';
import FreezeOverlay from './FreezeOverlay.js';
import { useModuleStore } from '../../store/useModuleStore.js';
import { useBrowserInit } from './hooks/useBrowserInit.js';
import { useBrowserNavigation } from './hooks/useBrowserNavigation.js';
import { useBrowserWebview } from './hooks/useBrowserWebview.js';
import { useBrowserShortcuts } from './hooks/useBrowserShortcuts.js';
import './styles.css';

export default function BrowserView() {
  const {
    tabs,
    activeTabId,
    profileId,
    newTab,
    switchTab,
    bookmarkBarVisible,
    setBookmarkBarVisible,
    ready,
    profile: activeProfile,
    addressBarRef,
    webviewContainerRef,
  } = useBrowserInit();

  const navigation = useBrowserNavigation({
    activeTabId,
    activeProfile,
    tabs,
    newTab,
    switchTab,
  });

  const webview = useBrowserWebview({
    webviewContainerRef,
    addressBarRef,
    activeTabId,
    profileId,
    newTab,
    activeProfile,
  });

  useBrowserShortcuts({
    addressBarRef,
    bookmarkBarVisible,
    setBookmarkBarVisible,
    isFullscreen: webview.isFullscreen,
    isCloudPc: webview.isCloudPc,
    handleRefresh: webview.handleRefresh,
    handleGoBack: webview.handleGoBack,
    handleGoForward: webview.handleGoForward,
    handleStopLoading: webview.handleStopLoading,
    handleForceRefresh: webview.handleForceRefresh,
    handleToggleDevTools: webview.handleToggleDevTools,
    handleToggleFullscreen: webview.handleToggleFullscreen,
    handleExitFullscreen: webview.handleExitFullscreen,
    handleFocusCycle: webview.handleFocusCycle,
    focusCycleRef: webview.focusCycleRef,
    handleAddBookmark: webview.handleAddBookmark,
    handleFocusSearch: webview.handleFocusSearch,
    handleFindInPage: webview.handleFindInPage,
    handlePrint: webview.handlePrint,
    handleSavePageAs: webview.handleSavePageAs,
    handleViewSource: webview.handleViewSource,
    zoomInAction: webview.zoomInAction,
    zoomOutAction: webview.zoomOutAction,
    zoomResetAction: webview.zoomResetAction,
    toggleCloudPc: webview.toggleCloudPc,
    handleToggleSpatialNav: webview.handleToggleSpatialNav,
    handleToggleFreeze: webview.handleToggleFreeze,
  });

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // 主题色
  const platformDef = activeProfile?.aiPlatformId
    ? AI_PLATFORMS.find((p) => p.id === activeProfile.aiPlatformId)
    : null;
  const themeColor = activeProfile?.aiThemeColor || platformDef?.themeColor || '#c25a4a';

  /* ===== 加载态 ===== */

  if (!ready || !activeProfile) {
    return (
      <div className="browser-view app-shell" data-name="browser.loading">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#999' }} data-name="browser.loading-text">
          正在加载...
        </div>
      </div>
    );
  }

  /* ===== 渲染 ===== */

  return (
    <div
      className="browser-view app-shell"
      data-fullscreen={webview.isFullscreen ? 'true' : undefined}
      data-cloudpc={webview.isCloudPc ? 'true' : undefined}
      data-name="browser.container"
      onDragOver={navigation.handleDragOver}
      onDrop={navigation.handleDrop}
    >
      {/* 沉浸式全屏悬浮退出条（鼠标移到顶部显示） */}
      {webview.isFullscreen && (
        <div className={`browser-fullscreen-bar${webview.fsBarVisible ? ' visible' : ''}`} data-name="browser.fullscreen-bar">
          <span className="browser-fullscreen-bar-title" data-name="browser.fullscreen-bar-title">
            {webview.isCloudPc ? '云电脑模式 · 快捷键已直通远端' : '沉浸式全屏'}
          </span>
          {webview.isCloudPc && (
            <>
              <div className="browser-cloud-pc-zoom" data-name="browser.cloud-pc-zoom">
                <button type="button" className={webview.cloudPcZoomMode === 'auto' ? 'zoom-btn active' : 'zoom-btn'} onClick={webview.resetAutoZoom} data-name="browser.cloud-pc-zoom-auto">
                  自动
                </button>
                {[1, 1.25, 1.5, 2].map((f, idx) => (
                  <button
                    key={f}
                    type="button"
                    className={webview.cloudPcZoomMode === 'manual' && Math.abs(webview.cloudPcZoomFactor - f) < 0.01 ? 'zoom-btn active' : 'zoom-btn'}
                    onClick={() => webview.setManualZoom(f)}
                    data-name={'browser.cloud-pc-zoom-factor-' + (idx + 1)}
                  >
                    {Math.round(f * 100)}%
                  </button>
                ))}
                {webview.cloudPcRemoteRes && (
                  <span className="zoom-info" data-name="browser.cloud-pc-zoom-info">远端 {webview.cloudPcRemoteRes.width}×{webview.cloudPcRemoteRes.height} · {Math.round(webview.cloudPcZoomFactor * 100)}%</span>
                )}
              </div>
              <button type="button" onClick={webview.toggleCloudPc} data-name="browser.cloud-pc-exit">
                退出云电脑模式
              </button>
            </>
          )}
          <button type="button" onClick={webview.handleExitFullscreen} data-name="browser.fullscreen-exit">
            退出全屏 (F11 / Esc)
          </button>
        </div>
      )}
      {/* 页面缩放浮窗（右上角） */}
      <ZoomIndicator onZoomIn={webview.zoomInAction} onZoomOut={webview.zoomOutAction} onZoomReset={webview.zoomResetAction} />
      {/* 云电脑模式进入提示（4 秒后自动消失） */}
      {webview.cloudPcNotice && (
        <div className="browser-cloud-pc-notice" data-name="browser.cloud-pc-notice">
          {webview.cloudPcNotice}
        </div>
      )}
      {/* 云电脑/云游戏网站检测提醒 */}
      {webview.cloudPcSuggestion && !webview.isCloudPc && (
        <div className="browser-cloud-pc-suggest" data-name="browser.cloud-pc-suggest">
          <span className="browser-cloud-pc-suggest-text" data-name="browser.cloud-pc-suggest-text">
            检测到云电脑/云游戏网站「{webview.cloudPcSuggestion.siteName}」，建议开启云电脑模式（快捷键直通远端、自动匹配分辨率）
          </span>
          <button type="button" className="suggest-btn primary" onClick={webview.acceptCloudPcSuggestion} data-name="browser.cloud-pc-suggest-open">
            开启
          </button>
          <button type="button" className="suggest-btn" onClick={webview.dismissCloudPcSuggestion} data-name="browser.cloud-pc-suggest-ignore">
            忽略
          </button>
        </div>
      )}
      {/* 三层栏垂直堆叠 */}
      <div className="browser-bar-stack" data-name="browser.bar-stack">
        {/* 第一栏：标签页栏 */}
        <TabsPanel
          profile={activeProfile}
          themeColor={themeColor}
          tabs={tabs}
          activeTabId={activeTabId}
          onOpenSettings={navigation.handleOpenSettings}
        />
        <div className="browser-bar-divider" data-name="browser.bar-divider-1" />
        {/* 第二栏：导航与功能栏 */}
        <NavBar
          profile={activeProfile}
          themeColor={themeColor}
          activeTab={activeTab}
          canGoBack={activeTab?.canGoBack ?? false}
          canGoForward={activeTab?.canGoForward ?? false}
          onGoBack={webview.handleGoBack}
          onGoForward={webview.handleGoForward}
          onRefresh={webview.handleRefresh}
          onStopLoading={webview.handleStopLoading}
          onGoHome={navigation.handleGoHome}
          onNavigate={navigation.handleNavigate}
          onOpenSettings={navigation.handleOpenSettings}
          onOpenHistory={navigation.handleOpenHistory}
          onOpenDownloads={navigation.handleOpenDownloads}
          addressBarRef={addressBarRef}
        />
        {/* 第三栏：书签栏（可显隐） */}
        <div className="browser-bar-divider" data-name="browser.bar-divider-2" />
        <BookmarksBar
          visible={bookmarkBarVisible}
          onOpenBookmarkManager={navigation.handleOpenBookmarkManager}
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
          // 查看网页源代码标签页
          if (tab.source === 'view-source') {
            return (
              <div
                key={tab.id}
                data-name="browser.view-source-tab-container"
                style={{
                  display: tab.id === activeTabId ? 'flex' : 'none',
                  position: 'absolute',
                  inset: 0,
                  overflow: 'hidden',
                  background: 'var(--background, #1a1a1a)',
                }}
              >
                <ViewSourceTab tab={tab} profile={activeProfile} />
              </div>
            );
          }
          // 打印预览标签页
          if (tab.source === 'print-preview') {
            return (
              <div
                key={tab.id}
                data-name="browser.print-preview-tab-container"
                style={{
                  display: tab.id === activeTabId ? 'flex' : 'none',
                  position: 'absolute',
                  inset: 0,
                  overflow: 'hidden',
                  background: 'var(--background, #1a1a1a)',
                }}
              >
                <PrintPreviewTab tab={tab} />
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
              navigateUrl={tab.id === activeTabId ? navigation.navigateUrl : null}
              onNavigateComplete={navigation.handleNavigateComplete}
              onGoBack={webview.handleGoBack}
              onGoForward={webview.handleGoForward}
              onReload={webview.handleRefresh}
              canGoBack={tab.canGoBack ?? false}
              canGoForward={tab.canGoForward ?? false}
              onToggleCloudPc={webview.toggleCloudPc}
              isCloudPc={webview.isCloudPc}
              onZoomIn={webview.zoomInAction}
              onZoomOut={webview.zoomOutAction}
              onZoomReset={webview.zoomResetAction}
            />
          );
        })}
      </div>

      {/* 底部状态栏：加载进度 + 状态文本 */}
      <BrowserStatusBar />

      {/* 冻结态覆盖层 + 控制条（防撤回保险） */}
      {useModuleStore.getState().isEnabled('freeze') && <FreezeOverlay activeTabId={activeTabId} />}

      <WindowResizeHandles />
    </div>
  );
}
