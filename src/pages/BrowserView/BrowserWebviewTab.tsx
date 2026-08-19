/* =====================================================================
   pages/BrowserView/BrowserWebviewTab.tsx —— 浏览器 webview 标签
   简化版 WebviewTab：无对话抓取/登录检测，增加浏览器行为。
   ===================================================================== */

import { useMemo, useRef, useState } from 'react';
import type { BrowserTabState, Profile } from '../../lib/electron-api';
import { sanitizeUrl, type WebviewElement } from '../../lib/webview.js';
import { WIN_CHROME_UA } from '../../../electron/presets/devices.js';
import WebviewContextMenu from './WebviewContextMenu.js';
import { useWebviewDomReady } from './hooks/useWebviewDomReady.js';
import { useWebviewNavigation } from './hooks/useWebviewNavigation.js';
import { useWebviewLoadingProgress } from './hooks/useWebviewLoadingProgress.js';
import { useWebviewAudio } from './hooks/useWebviewAudio.js';
import { useWebviewContextMenu } from './hooks/useWebviewContextMenu.js';
import { useWebviewLifecycle } from './hooks/useWebviewLifecycle.js';

interface BrowserWebviewTabProps {
  tab: BrowserTabState;
  profile: Profile;
  active: boolean;
  /** 外部请求导航到 URL（地址栏输入） */
  navigateUrl?: string | null;
  /** 导航完成后清除 navigateUrl */
  onNavigateComplete?: () => void;
  /** 导航回调（后退/前进/重新加载） */
  onGoBack?: () => void;
  onGoForward?: () => void;
  onReload?: () => void;
  /** canGoBack/canGoForward 状态 */
  canGoBack?: boolean;
  canGoForward?: boolean;
  /** 云电脑模式切换（右键菜单） */
  onToggleCloudPc?: () => void;
  /** 当前是否云电脑模式（右键菜单文案） */
  isCloudPc?: boolean;
  /** 页面缩放（右键菜单，统一走 BrowserView 缩放动作含右上角提示） */
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
}

export default function BrowserWebviewTab({
  tab,
  profile,
  active,
  navigateUrl,
  onNavigateComplete,
  onGoBack,
  onGoForward,
  onReload,
  canGoBack = false,
  canGoForward = false,
  onToggleCloudPc,
  isCloudPc,
  onZoomIn: propZoomIn,
  onZoomOut: propZoomOut,
  onZoomReset: propZoomReset,
}: BrowserWebviewTabProps) {
  const webviewRef = useRef<WebviewElement | null>(null);
  const [remountKey, setRemountKey] = useState(0);
  const domReadyRef = useRef(false);

  const handleDomReady = useWebviewDomReady({ webviewRef, domReadyRef, tab, profile });

  const {
    handleNavigate,
    handleTitleUpdate,
    handleFaviconUpdate,
  } = useWebviewNavigation({
    webviewRef,
    domReadyRef,
    tab,
    profile,
    navigateUrl,
    onNavigateComplete,
  });

  const {
    handleStartLoading,
    handleFinishNavigation,
    handleFinishLoad,
    handleStopLoading,
    handleFailLoad,
  } = useWebviewLoadingProgress({ webviewRef, domReadyRef, tab });

  const {
    handleMediaStartedPlaying,
    handleMediaPaused,
  } = useWebviewAudio({ webviewRef, remountKey, tab });

  const {
    contextMenu,
    handleCloseContextMenu,
    handleContextMenuGoBack,
    handleContextMenuGoForward,
    handleContextMenuReload,
    handleContextMenuSaveAs,
    handleContextMenuPrint,
    handleContextMenuViewSource,
    handleContextMenuInspect,
    handleContextMenuScreenshot,
    handleZoomIn,
    handleZoomOut,
    handleZoomReset,
    handleContextMenuCopySelection,
    handleContextMenuOpenLink,
    handleContextMenuCopyLink,
    handleContextMenuSaveLinkAs,
    handleContextMenuSaveImage,
    handleContextMenuCopyImage,
    handleContextMenuCopyImageUrl,
    handleContextMenuUndo,
    handleContextMenuRedo,
    handleContextMenuCut,
    handleContextMenuCopy,
    handleContextMenuPaste,
    handleContextMenuPasteAsPlainText,
    handleContextMenuSelectAll,
  } = useWebviewContextMenu({
    webviewRef,
    tab,
    profile,
    onGoBack,
    onGoForward,
    onReload,
    onZoomIn: propZoomIn,
    onZoomOut: propZoomOut,
    onZoomReset: propZoomReset,
  });

  useWebviewLifecycle({
    webviewRef,
    domReadyRef,
    remountKey,
    setRemountKey,
    tab,
    profile,
    handlers: {
      handleDomReady,
      handleNavigate,
      handleTitleUpdate,
      handleFaviconUpdate,
      handleStartLoading,
      handleStopLoading,
      handleFinishNavigation,
      handleFinishLoad,
      handleFailLoad,
      handleMediaStartedPlaying,
      handleMediaPaused,
    },
  });

  // 使用与主窗口相同的 partition，保留全部登录态和页面数据
  const partition = `persist:${profile.id}`;
  // v0.0.9: 初始 UA 优先用 profile.devicePreset 的 UA，避免首次加载用错误 UA
  // dom-ready 后会通过 setUserAgent 再次精确设置
  // 浏览器窗口始终使用桌面端 UA，不受 profile 移动端设置影响
  const initialUa = WIN_CHROME_UA;

  // 修复页面闪烁（对齐主窗口经验）：webview 的 src 仅在挂载时设置一次。
  // 若直接绑定 tab.url，页面自身导航（SPA 路由变化，如 DeepSeek 发送消息后
  // URL 变为 /a/chat/s/xxx）会经 store.navigateTab 更新 tab.url → React 重渲染
  // → <webview src=新URL> → Electron 内部 loadURL 重载页面 → 白屏闪烁且
  // 新对话路由被重置回初始页。
  // 仅在 tab.id 或 remountKey 变化（webview 实际销毁重建）时重算初始 src；
  // 外部导航（地址栏/主页）通过 navigateUrl → safeLoadURLWebview 显式执行。
  const initialSrc = useMemo(
    () => sanitizeUrl(tab.url || profile.aiPlatformUrl || ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab.id, remountKey],
  );

  return (
    <>
      <webview
        ref={webviewRef as React.RefObject<HTMLElement> as React.RefObject<WebviewElement>}
        key={`${tab.id}-${remountKey}`}
        src={initialSrc}
        partition={partition}
        useragent={initialUa}
        {...({ allowpopups: 'true' } as Record<string, unknown>)}
        data-tab-id={tab.id}
        data-name="browser.webview-tab"
        style={{
          display: 'flex',
          visibility: active ? 'visible' : 'hidden',
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          border: 'none',
        }}
      />
      {/* 右键菜单 */}
      {contextMenu && active && (
        <WebviewContextMenu
          position={contextMenu.position}
          contextType={contextMenu.contextType}
          onClose={handleCloseContextMenu}
          onGoBack={handleContextMenuGoBack}
          onGoForward={handleContextMenuGoForward}
          onReload={handleContextMenuReload}
          onSaveAs={handleContextMenuSaveAs}
          onPrint={handleContextMenuPrint}
          onViewSource={handleContextMenuViewSource}
          onInspect={handleContextMenuInspect}
          onScreenshot={handleContextMenuScreenshot}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onZoomReset={handleZoomReset}
          onToggleCloudPc={onToggleCloudPc}
          isCloudPc={isCloudPc}
          onCopySelection={contextMenu.selectedText ? handleContextMenuCopySelection : undefined}
          onOpenLinkInNewTab={contextMenu.linkUrl ? handleContextMenuOpenLink : undefined}
          onCopyLinkAddress={contextMenu.linkUrl ? handleContextMenuCopyLink : undefined}
          onSaveLinkAs={contextMenu.linkUrl ? handleContextMenuSaveLinkAs : undefined}
          onSaveImage={contextMenu.imageUrl ? handleContextMenuSaveImage : undefined}
          onCopyImage={contextMenu.imageUrl ? handleContextMenuCopyImage : undefined}
          onCopyImageUrl={contextMenu.imageUrl ? handleContextMenuCopyImageUrl : undefined}
          onUndo={contextMenu.contextType === 'input' ? handleContextMenuUndo : undefined}
          onRedo={contextMenu.contextType === 'input' ? handleContextMenuRedo : undefined}
          onCut={contextMenu.contextType === 'input' ? handleContextMenuCut : undefined}
          onCopy={contextMenu.contextType === 'input' ? handleContextMenuCopy : undefined}
          onPaste={contextMenu.contextType === 'input' ? handleContextMenuPaste : undefined}
          onPasteAsPlainText={contextMenu.contextType === 'input' ? handleContextMenuPasteAsPlainText : undefined}
          onSelectAll={contextMenu.contextType === 'input' ? handleContextMenuSelectAll : undefined}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          hasSelection={!!contextMenu.selectedText}
          editFlags={contextMenu.editFlags}
        />
      )}
    </>
  );
}
