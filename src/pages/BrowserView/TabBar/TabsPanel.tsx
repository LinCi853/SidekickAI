/* =====================================================================
   pages/BrowserView/TabBar/TabsPanel.tsx —— 第一栏标签页栏（v0.0.9）
   左侧：标签搜索/管理按钮 → 点击展开 TabSearchPanel
   中部：网站标签页列表 + 新建按钮（空白区可拖动窗口）
   右侧：置顶 + 下载 + 窗口控制（最小化/最大化/关闭）
   ===================================================================== */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserTabState, Profile, AllTabsTree } from '../../../lib/electron-api';
import {
  minimizeWindow,
  maximizeToggleWindow,
  closeCurrentWindow,
  pinCurrentWindow,
} from '../../../lib/electron-api';
import { useBrowserTabStore } from '../../../store/useBrowserTabStore';
import { IconButton } from '../../../components/ui';
import WindowControls from '../../../components/ui/WindowControls';
import { BrowserTabItem } from './BrowserTabItem';
import BrowserTabContextMenu from './BrowserTabContextMenu';
import TabSearchPanel from './TabSearchPanel';

interface TabsPanelProps {
  profile: Profile;
  themeColor: string;
  tabs: BrowserTabState[];
  activeTabId: string | null;
  onOpenSettings: () => void;
}

export default function TabsPanel({ profile, themeColor, tabs, activeTabId, onOpenSettings }: TabsPanelProps) {
  const {
    switchTab,
    closeTab,
    newTab,
    moveTab,
    togglePin,
    setMuted,
    isMaximized,
    alwaysOnTop,
    setAlwaysOnTop,
    setMaximized,
    windowId,
  } = useBrowserTabStore();

  const [showSearch, setShowSearch] = useState(false);
  const [allTabsTree, setAllTabsTree] = useState<AllTabsTree | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const dragRef = useRef<string | null>(null);
  const searchBtnRef = useRef<HTMLButtonElement>(null);

  // 展开搜索面板时拉取跨窗口标签树
  useEffect(() => {
    if (!showSearch) return;
    void useBrowserTabStore.getState().queryChildTabs().then(setAllTabsTree);
  }, [showSearch]);

  /* ===== 窗口控制 ===== */
  const handleMaximize = useCallback(async () => {
    const maximized = await maximizeToggleWindow();
    setMaximized(maximized);
  }, [setMaximized]);

  const handlePin = useCallback(async () => {
    const next = !alwaysOnTop;
    setAlwaysOnTop(next);
    try { await pinCurrentWindow(next); } catch { setAlwaysOnTop(!next); }
  }, [alwaysOnTop, setAlwaysOnTop]);

  /* ===== 标签事件 ===== */
  const handleTabClick = useCallback((tabId: string) => switchTab(tabId), [switchTab]);
  const handleTabClose = useCallback((e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    closeTab(tabId);
  }, [closeTab]);

  const handleContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, tabId });
  }, []);

  const handleDragStart = useCallback((e: React.DragEvent, tabId: string) => {
    dragRef.current = tabId;
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, hoverId: string) => {
    e.preventDefault();
    if (dragRef.current && dragRef.current !== hoverId) moveTab(dragRef.current, hoverId);
    dragRef.current = null;
  }, [moveTab]);

  /* ===== 右键菜单 actions ===== */
  const contextTab = contextMenu ? tabs.find((t) => t.id === contextMenu.tabId) : null;

  const handleContextAction = useCallback((action: string) => {
    if (!contextMenu) return;
    const tabId = contextMenu.tabId;
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    switch (action) {
      case 'newToRight':
        newTab(profile.aiPlatformUrl, { kind: 'web' });
        break;
      case 'reload':
        window.dispatchEvent(new CustomEvent('browser-tab-reload', { detail: { tabId } }));
        break;
      case 'duplicate':
        newTab(tab.url, { kind: 'web' });
        break;
      case 'togglePin':
        togglePin(tabId);
        break;
      case 'toggleMute':
        setMuted(tabId, !tab.muted);
        break;
      case 'closeOthers':
        tabs.filter((t) => t.id !== tabId).forEach((t) => closeTab(t.id));
        break;
      case 'closeRight': {
        const idx = tabs.findIndex((t) => t.id === tabId);
        tabs.slice(idx + 1).forEach((t) => closeTab(t.id));
        break;
      }
    }
  }, [contextMenu, tabs, newTab, togglePin, setMuted, closeTab, profile.aiPlatformUrl]);

  return (
    <div className="browser-bar-row browser-bar-row-tabs" data-name="browser.tabs-panel">
      {/* 左侧：标签搜索按钮 */}
      <div className="browser-search-trigger" style={{ position: 'relative', flexShrink: 0 }}>
        <IconButton
          ref={searchBtnRef}
          aria-label="搜索标签页"
          variant={showSearch ? 'active' : 'default'}
          onClick={() => setShowSearch((v) => !v)}
          title="搜索标签页"
          data-name="browser.tab-search-btn"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </IconButton>
        {showSearch && (
          <TabSearchPanel
            tabs={tabs}
            allTabsTree={allTabsTree}
            activeTabId={activeTabId}
            currentWindowId={windowId}
            triggerRef={searchBtnRef}
            onClose={() => setShowSearch(false)}
            onSwitchTab={switchTab}
            onRestoreClosed={(url, title) => newTab(url, { kind: 'web' })}
          />
        )}
      </div>

      {/* 中部：标签列表 + 新建按钮 */}
      <div className="browser-tab-list" data-name="browser.tab-list">
        {tabs.map((tab) => (
          <BrowserTabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            themeColor={themeColor}
            onClick={() => handleTabClick(tab.id)}
            onClose={(e) => handleTabClose(e, tab.id)}
            onContextMenu={(e) => handleContextMenu(e, tab.id)}
            onDragStart={(e) => handleDragStart(e, tab.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => handleDrop(e, tab.id)}
          />
        ))}
        <IconButton
          aria-label="新建标签页"
          onClick={() => newTab(profile.aiPlatformUrl, { kind: 'web' })}
          title="新建标签页 (Ctrl+T)"
          data-name="browser.new-tab"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </IconButton>
      </div>

      {/* 右侧：置顶 + 窗口控制 */}
      <div className="browser-bar-actions">
        <IconButton
          variant={alwaysOnTop ? 'active' : 'default'}
          aria-label="置顶"
          onClick={() => void handlePin()}
          title={alwaysOnTop ? '取消置顶' : '置顶'}
          data-name="browser.pin"
        >
          <svg viewBox="0 0 24 24" fill={alwaysOnTop ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="17" x2="12" y2="3" />
            <path d="M6.5 8.5L12 3l5.5 5.5" />
            <path d="M5 21h14" />
          </svg>
        </IconButton>
        <WindowControls
          onMinimize={() => void minimizeWindow()}
          onMaximize={() => void handleMaximize()}
          onClose={() => void closeCurrentWindow()}
        />
      </div>

      {/* 右键菜单 */}
      {contextMenu && contextTab && (
        <BrowserTabContextMenu
          position={contextMenu}
          tab={contextTab}
          onClose={() => setContextMenu(null)}
          onNewToRight={() => handleContextAction('newToRight')}
          onReload={() => handleContextAction('reload')}
          onDuplicate={() => handleContextAction('duplicate')}
          onTogglePin={() => handleContextAction('togglePin')}
          onToggleMute={() => handleContextAction('toggleMute')}
          onCloseTab={() => { closeTab(contextMenu.tabId); }}
          onCloseOthers={() => handleContextAction('closeOthers')}
          onCloseRight={() => handleContextAction('closeRight')}
        />
      )}
    </div>
  );
}
