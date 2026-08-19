/* =====================================================================
   pages/BrowserView/BrowserNavBar.tsx —— 两行导航栏
   第一行：[标签列表...] [置顶][设置][最小化][最大化][关闭]
   第二行：[←][→][↻][🏠] [地址栏______________][外部打开]
   ===================================================================== */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserTabState, Profile, SearchHistoryEntry, BrowserDownloadRecord } from '../../lib/electron-api';
import {
  minimizeWindow,
  maximizeToggleWindow,
  closeCurrentWindow,
  pinCurrentWindow,
  openExternal,
  listSearchHistory,
  onDownloadUpdated,
} from '../../lib/electron-api';
import { useBrowserTabStore } from '../../store/useBrowserTabStore';
import { IconButton, PinToggleButton } from '../../components/ui';
import WindowControls from '../../components/ui/WindowControls';
import { LockIcon, AlertIcon, SearchIcon, GearIcon } from '@/components/icons';

/* =====================================================================
   工具函数
   ===================================================================== */

function isUrl(input: string): boolean {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^[\w-]+(\.[\w-]+)+\/?/.test(trimmed)) return true;
  return false;
}

function toSearchUrl(query: string): string {
  return `https://www.bing.com/search?q=${encodeURIComponent(query.trim())}`;
}

/* =====================================================================
   组件 Props
   ===================================================================== */

interface BrowserNavBarProps {
  profile: Profile;
  themeColor: string;
  tabs: BrowserTabState[];
  activeTabId: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onRefresh: () => void;
  onGoHome: () => void;
  onNavigate: (url: string) => void;
  onOpenSettings: () => void;
  addressBarRef: React.MutableRefObject<HTMLInputElement | null>;
}

export default function BrowserNavBar({
  profile,
  themeColor,
  tabs,
  activeTabId,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onRefresh,
  onGoHome,
  onNavigate,
  onOpenSettings,
  addressBarRef,
}: BrowserNavBarProps) {
  const { switchTab, closeTab, newTab, moveTab, isMaximized, alwaysOnTop, setAlwaysOnTop, setMaximized } = useBrowserTabStore();
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // 地址栏状态
  const [urlDraft, setUrlDraft] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [suggestions, setSuggestions] = useState<SearchHistoryEntry[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // 右键菜单
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);

  // 拖拽
  const dragRef = useRef<string | null>(null);

  // 下载状态
  const [downloads, setDownloads] = useState<BrowserDownloadRecord[]>([]);
  const [showDownloads, setShowDownloads] = useState(false);
  const activeDownloads = downloads.filter((d) => d.state === 'progressing');

  // 监听下载状态变化
  useEffect(() => {
    const off = onDownloadUpdated((record) => {
      setDownloads((prev) => {
        const idx = prev.findIndex((d) => d.id === record.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = record;
          return next;
        }
        return [...prev, record];
      });
    });
    return off;
  }, []);

  // 同步地址栏
  useEffect(() => {
    if (!isEditing) setUrlDraft(activeTab?.url || '');
  }, [activeTab?.url, isEditing]);

  /* ===== 地址栏事件 ===== */

  const handleAddressFocus = useCallback(() => {
    setIsEditing(true);
    void listSearchHistory(profile.id, undefined, 8).then((entries) => {
      setSuggestions(entries);
      setShowSuggestions(entries.length > 0);
    });
  }, [profile.id]);

  const handleAddressBlur = useCallback(() => {
    setTimeout(() => {
      setIsEditing(false);
      setShowSuggestions(false);
      setUrlDraft(activeTab?.url || '');
    }, 200);
  }, [activeTab?.url]);

  const handleAddressKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const input = urlDraft.trim();
      if (!input) return;
      const url = isUrl(input) ? (input.startsWith('http') ? input : `https://${input}`) : toSearchUrl(input);
      onNavigate(url);
      setIsEditing(false);
      setShowSuggestions(false);
    } else if (e.key === 'Escape') {
      setIsEditing(false);
      setShowSuggestions(false);
      setUrlDraft(activeTab?.url || '');
    }
  }, [urlDraft, activeTab?.url, onNavigate]);

  const handleSuggestionClick = useCallback((entry: SearchHistoryEntry) => {
    onNavigate(entry.url);
    setIsEditing(false);
    setShowSuggestions(false);
  }, [onNavigate]);

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
    void closeTab(tabId);
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

  const handleContextAction = useCallback((action: string, tabId: string) => {
    const store = useBrowserTabStore.getState();
    switch (action) {
      case 'closeOthers':
        store.tabs.filter((t) => t.id !== tabId).forEach((t) => void store.closeTab(t.id));
        break;
      case 'closeRight': {
        const idx = store.tabs.findIndex((t) => t.id === tabId);
        store.tabs.slice(idx + 1).forEach((t) => void store.closeTab(t.id));
        break;
      }
      case 'reload':
        window.dispatchEvent(new CustomEvent('browser-tab-reload', { detail: { tabId } }));
        break;
      case 'copyUrl': {
        const tab = store.tabs.find((t) => t.id === tabId);
        if (tab?.url) void navigator.clipboard?.writeText(tab.url);
        break;
      }
      case 'openExternal': {
        const tab = store.tabs.find((t) => t.id === tabId);
        if (tab?.url) void openExternal(tab.url);
        break;
      }
    }
    setContextMenu(null);
  }, []);

  const isSecure = activeTab?.url?.startsWith('https://');

  return (
    <div className="browser-nav-container">
      {/* ===== 第一行：标签列表 + 功能按钮 + 窗口控制 ===== */}
      <div className="browser-nav-row-top" data-name="browser.nav-bar.top-row">
        {/* 标签列表 */}
        <div className="browser-tab-list" data-name="browser.nav-bar.tabs">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`browser-tab${tab.id === activeTabId ? ' active' : ''}`}
              onClick={() => handleTabClick(tab.id)}
              onContextMenu={(e) => handleContextMenu(e, tab.id)}
              draggable
              onDragStart={(e) => handleDragStart(e, tab.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleDrop(e, tab.id)}
              data-name="browser.nav-bar.tab"
              data-tab-id={tab.id}
            >
              {tab.isLoading && (
                <div className="browser-tab-loading-bar">
                  <div className="browser-tab-loading-bar-inner" />
                </div>
              )}
              <span className="browser-tab-favicon">
                {tab.favicon ? (
                  <img src={tab.favicon} alt="" width={14} height={14} />
                ) : (
                  <span className="browser-tab-favicon-placeholder" style={{ background: themeColor }}>
                    {(tab.title || '?').charAt(0).toUpperCase()}
                  </span>
                )}
              </span>
              <span className="browser-tab-title" title={tab.title || tab.url}>
                {tab.title || '新标签'}
              </span>
              <button
                type="button"
                className="browser-tab-close"
                onClick={(e) => handleTabClose(e, tab.id)}
                title="关闭标签 (Ctrl+W)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))}
          <button
            type="button"
            className="browser-tab-new"
            onClick={() => newTab()}
            title="新建标签 (Ctrl+T)"
            data-name="browser.nav-bar.new-tab"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>

        {/* 右侧：功能按钮 + 窗口控制 */}
        <div className="browser-nav-top-actions">
          <PinToggleButton
            isPinned={alwaysOnTop}
            onToggle={() => void handlePin()}
            className="titlebar-icon-btn"
            data-name="browser.nav-bar.pin"
          />
          <IconButton
            type="button"
            className="titlebar-icon-btn"
            aria-label="设置"
            onClick={onOpenSettings}
            title="设置"
            data-name="browser.nav-bar.settings"
          >
            <GearIcon className="icon-svg" />
          </IconButton>
          {/* 下载指示器 */}
          <div style={{ position: 'relative' }}>
            <IconButton
              type="button"
              className="titlebar-icon-btn"
              aria-label="下载"
              onClick={() => setShowDownloads((v) => !v)}
              title="下载"
              data-name="browser.nav-bar.downloads"
              variant={activeDownloads.length > 0 ? 'active' : 'default'}
            >
              <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {activeDownloads.length > 0 && (
                <span className="browser-download-badge">{activeDownloads.length}</span>
              )}
            </IconButton>
            {/* 下载列表浮层 */}
            {showDownloads && downloads.length > 0 && (
              <div className="browser-download-panel">
                {downloads.slice(0, 10).map((d) => (
                  <div key={d.id} className="browser-download-item">
                    <span className="browser-download-name">{d.filename}</span>
                    <span className="browser-download-state">
                      {d.state === 'progressing' ? `${Math.round((d.receivedBytes / Math.max(d.totalBytes, 1)) * 100)}%` :
                       d.state === 'completed' ? '✓' : d.state}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <WindowControls
            onMinimize={() => void minimizeWindow()}
            onMaximize={() => void handleMaximize()}
            onClose={() => void closeCurrentWindow()}
          />
        </div>
      </div>

      {/* ===== 第二行：导航按钮 + 地址栏 ===== */}
      <div className="browser-nav-row-bottom" data-name="browser.nav-bar.bottom-row">
        {/* App 图标 */}
        <div
          className="browser-app-icon"
          style={{ background: themeColor }}
          data-name="browser.nav-bar.app-icon"
        >
          {profile.name.charAt(0).toUpperCase()}
        </div>
        {/* 导航按钮 */}
        <IconButton
          type="button"
          className="titlebar-icon-btn"
          aria-label="后退"
          disabled={!canGoBack}
          onClick={onGoBack}
          title="后退 (Alt+←)"
          data-name="browser.nav-bar.back"
        >
          <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </IconButton>
        <IconButton
          type="button"
          className="titlebar-icon-btn"
          aria-label="前进"
          disabled={!canGoForward}
          onClick={onGoForward}
          title="前进 (Alt+→)"
          data-name="browser.nav-bar.forward"
        >
          <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </IconButton>
        <IconButton
          type="button"
          className="titlebar-icon-btn"
          aria-label="刷新"
          onClick={onRefresh}
          title="刷新 (F5)"
          data-name="browser.nav-bar.refresh"
        >
          <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </IconButton>
        <IconButton
          type="button"
          className="titlebar-icon-btn"
          aria-label="主页"
          onClick={onGoHome}
          title="主页"
          data-name="browser.nav-bar.home"
        >
          <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </IconButton>

        {/* 地址栏 */}
        <div className="browser-address-wrapper" data-name="browser.nav-bar.address">
          <span className="browser-address-security">
            {isSecure ? <LockIcon className="browser-address-security-icon" /> : activeTab?.url ? <AlertIcon className="browser-address-security-icon" /> : null}
          </span>
          <input
            ref={addressBarRef}
            className="browser-address-input"
            type="text"
            value={urlDraft}
            spellCheck={false}
            placeholder="输入地址或搜索"
            onChange={(e) => setUrlDraft(e.target.value)}
            onFocus={handleAddressFocus}
            onBlur={handleAddressBlur}
            onKeyDown={handleAddressKeyDown}
            data-name="browser.nav-bar.address-input"
          />
          {activeTab?.url && (
            <button
              type="button"
              className="browser-address-external"
              onClick={() => void openExternal(activeTab.url)}
              title="在外部浏览器中打开"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </button>
          )}
          {showSuggestions && suggestions.length > 0 && (
            <div className="browser-suggestions">
              {suggestions.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="browser-suggestion-item"
                  onMouseDown={() => handleSuggestionClick(entry)}
                >
                  <span className="browser-suggestion-icon"><SearchIcon className="browser-suggestion-svg" /></span>
                  <span className="browser-suggestion-text">{entry.query}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <>
          <div className="settings-overlay" style={{ opacity: 1, pointerEvents: 'auto', zIndex: 199 }} onClick={() => setContextMenu(null)} />
          <div className="browser-tab-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
            <button type="button" onClick={() => handleContextAction('reload', contextMenu.tabId)}>刷新</button>
            <button type="button" onClick={() => handleContextAction('copyUrl', contextMenu.tabId)}>复制地址</button>
            <button type="button" onClick={() => handleContextAction('openExternal', contextMenu.tabId)}>在外部浏览器中打开</button>
            <div className="browser-tab-context-divider" />
            <button type="button" onClick={() => handleContextAction('closeOthers', contextMenu.tabId)}>关闭其他标签</button>
            <button type="button" onClick={() => handleContextAction('closeRight', contextMenu.tabId)}>关闭右侧标签</button>
            <button type="button" className="danger" onClick={() => { void closeTab(contextMenu.tabId); setContextMenu(null); }}>关闭标签</button>
          </div>
        </>
      )}
    </div>
  );
}
