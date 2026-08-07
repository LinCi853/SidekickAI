/* =====================================================================
   pages/BrowserView/TabBar/TabSearchPanel.tsx —— 标签管理面板（v0.0.9）
   搜索框 → 所有打开的标签页列表（含跨窗口子标签树形） → 最近关闭的标签页。
   主子标签归属：主窗口 A 标签 ↔ 浏览器窗口 A1/A2/A3 子标签。
   ===================================================================== */

import { useEffect, useMemo, useState, type MutableRefObject } from 'react';
import Popover from '../../../components/ui/Popover';

import type { BrowserTabState, TabState } from '../../../lib/electron-api';
import { focusBrowserWindow } from '../../../lib/electron-api';
import { useRecentClosedStore } from '../RecentClosedStore';
import { useBrowserTabStore } from '../../../store/useBrowserTabStore';
import { useProfileStore } from '../../../store/useProfileStore';
import { AI_PLATFORMS } from '../../../../electron/presets/ai-platforms';
import { extractDomainInitial } from '../utils/favicon-placeholder';
import { VolumeIcon, PinIcon, RotateIcon } from '@/components/icons';

interface TabSearchPanelProps {
  /** 当前窗口标签 */
  tabs: BrowserTabState[];
  /** 跨窗口标签树（主窗口 + 所有浏览器窗口） */
  allTabsTree: {
    main: TabState[];
    browsers: {
      windowId: string;
      parentTabId: string | null;
      profileId: string;
      platformName: string | null;
      tabs: BrowserTabState[];
    }[];
  } | null;
  activeTabId: string | null;
  /** 当前窗口 id（用于排除自身，避免重复显示） */
  currentWindowId: string;
  /** 触发按钮 ref（用于定位） */
  triggerRef: MutableRefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onSwitchTab: (tabId: string) => void;
  /** 恢复最近关闭标签（在新标签打开） */
  onRestoreClosed: (url: string, title: string) => void;
}

export default function TabSearchPanel({
  tabs,
  allTabsTree,
  activeTabId,
  currentWindowId,
  triggerRef,
  onClose,
  onSwitchTab,
  onRestoreClosed,
}: TabSearchPanelProps) {
  const [query, setQuery] = useState('');
  const recentClosed = useRecentClosedStore((s) => s.entries);
  const removeRecent = useRecentClosedStore((s) => s.remove);

  // 主题色：与 BrowserTabItem 保持一致（profile 覆盖 → 平台默认 → 兜底）
  const profileId = useBrowserTabStore((s) => s.profileId);
  const profiles = useProfileStore((s) => s.profiles);
  const themeColor = useMemo(() => {
    const profile = profiles.find((p) => p.id === profileId);
    const platformDef = profile?.aiPlatformId
      ? AI_PLATFORMS.find((p) => p.id === profile.aiPlatformId)
      : null;
    return profile?.aiThemeColor || platformDef?.themeColor || '#c25a4a';
  }, [profileId, profiles]);

  const filtered = useMemo(() => {
    if (!query.trim()) return tabs;
    const q = query.toLowerCase();
    return tabs.filter(
      (t) =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.url || '').toLowerCase().includes(q),
    );
  }, [tabs, query]);

  // 跨窗口子标签：找出其他浏览器窗口中 parentTabId 对应的子标签
  const childWindows = useMemo(() => {
    if (!allTabsTree) return [];
    return allTabsTree.browsers.filter((b) => b.windowId !== currentWindowId);
  }, [allTabsTree, currentWindowId]);

  const filteredRecent = useMemo(() => {
    if (!query.trim()) return recentClosed;
    const q = query.toLowerCase();
    return recentClosed.filter(
      (r) =>
        (r.title || '').toLowerCase().includes(q) ||
        (r.url || '').toLowerCase().includes(q),
    );
  }, [recentClosed, query]);

  // ESC 关闭
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);



  return (
    <Popover
      isOpen={true}
      onClose={onClose}
      triggerRef={triggerRef}
      variant="dropdown"
      config={{ closeOnOutsideClick: true, closeOnEsc: true }}
      search={{
        placeholder: '搜索标签页...',
        value: query,
        onChange: setQuery,
        autoFocus: true,
      }}
      style={{ width: 320, maxHeight: 480 }}
      dataName="browser.tab-search-panel"
    >

      {/* 当前窗口打开的标签 */}
      <div className="browser-tab-search-section" data-name="browser.tab-search-section">打开的标签页</div>
      {filtered.length === 0 && (
        <div style={{ padding: '4px 8px', fontSize: 12, color: '#666' }}>无匹配标签</div>
      )}
      {filtered.map((tab) => (
        <div
          key={tab.id}
          className="browser-tab-search-item"
          onClick={() => {
            onSwitchTab(tab.id);
            onClose();
          }}
          style={tab.id === activeTabId ? { background: 'var(--accent-dim, #333)' } : undefined}
        >
          <span className="browser-tab-search-item favicon">
            {tab.favicon ? (
              <img src={tab.favicon} alt="" width={14} height={14} />
            ) : (
              <span className="browser-tab-favicon-placeholder" style={{ background: tab.themeColor || themeColor, width: 14, height: 14, fontSize: 8 }} data-name="browser.tab-search-favicon">
                {extractDomainInitial(tab.url) || (tab.title || '?').charAt(0).toUpperCase()}
              </span>
            )}
          </span>
          <span className="browser-tab-search-item-title" data-name="browser.tab-search-item-title">{tab.title || tab.url || '新标签'}</span>
          {tab.audible && <span className="browser-tab-search-item-meta" data-name="browser.tab-search-item-meta"><VolumeIcon className="browser-tab-search-meta-icon" /></span>}
          {tab.pinned && <span className="browser-tab-search-item-meta" data-name="browser.tab-search-item-meta"><PinIcon className="browser-tab-search-meta-icon" /></span>}
        </div>
      ))}

      {/* 跨窗口子标签（其他浏览器窗口的标签） */}
      {childWindows.length > 0 && (
        <>
          <div className="browser-tab-search-section" data-name="browser.tab-search-section">其他窗口</div>
          {childWindows.map((w) =>
            w.tabs
              .filter(
                (t) =>
                  !query.trim() ||
                  (t.title || '').toLowerCase().includes(query.toLowerCase()) ||
                  (t.url || '').toLowerCase().includes(query.toLowerCase()),
              )
              .map((tab) => (
                <div
                  key={tab.id}
                  className="browser-tab-search-item child"
                  title={`来自${w.platformName || '其他'}窗口`}
                  onClick={() => {
                    // 聚焦目标窗口
                    void focusBrowserWindow(w.windowId);
                    onClose();
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  <span className="browser-tab-search-item favicon">
                    {tab.favicon ? (
                      <img src={tab.favicon} alt="" width={14} height={14} />
                    ) : (
                      <span className="browser-tab-favicon-placeholder" style={{ background: themeColor, width: 14, height: 14, fontSize: 8 }} data-name="browser.tab-search-favicon">
                        {(tab.title || '?').charAt(0).toUpperCase()}
                      </span>
                    )}
                  </span>
                  <span className="browser-tab-search-item-title" data-name="browser.tab-search-item-title">{tab.title || tab.url || '新标签'}</span>
                  <span className="browser-tab-search-item-meta" data-name="browser.tab-search-item-meta">{w.platformName || ''}</span>
                </div>
              )),
          )}
        </>
      )}

      {/* 最近关闭的标签 */}
      {filteredRecent.length > 0 && (
        <>
          <div className="browser-tab-search-section" data-name="browser.tab-search-section">最近关闭</div>
          {filteredRecent.map((entry) => (
            <div
              key={entry.id}
              className="browser-tab-search-item"
              onClick={() => {
                onRestoreClosed(entry.url, entry.title);
                removeRecent(entry.id);
                onClose();
              }}
            >
              <span className="browser-tab-search-item favicon"><RotateIcon className="browser-tab-search-restore-icon" /></span>
              <span className="browser-tab-search-item-title" data-name="browser.tab-search-item-title">{entry.title || entry.url}</span>
            </div>
          ))}
        </>
      )}
    </Popover>
  );
}
