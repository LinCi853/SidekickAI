/* =====================================================================
   pages/BrowserView/NavBar/NavBar.tsx —— 第二栏导航与功能栏（v0.0.9）
   左：后退/前进/刷新/主页 / 中：地址栏 / 右：扩展占位 + AI 头像 + 设置
   ===================================================================== */

import { useEffect, useState, type MutableRefObject } from 'react';

import type { BrowserTabState, Profile, BrowserDownloadRecord } from '../../../lib/electron-api';
import { onDownloadUpdated } from '../../../lib/electron-api';
import { IconButton } from '../../../components/ui';
import { HistoryIcon, DownloadIcon } from '@/components/icons';
import AddressBar from './AddressBar';

interface NavBarProps {
  profile: Profile;
  themeColor: string;
  activeTab: BrowserTabState | null;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onRefresh: () => void;
  onGoHome: () => void;
  onNavigate: (url: string) => void;
  onOpenSettings: () => void;
  onOpenHistory: () => void;
  onOpenDownloads: () => void;
  addressBarRef: MutableRefObject<HTMLInputElement | null>;
}

export default function NavBar({
  profile,
  themeColor,
  activeTab,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onRefresh,
  onGoHome,
  onNavigate,
  onOpenSettings,
  onOpenHistory,
  onOpenDownloads,
  addressBarRef,
}: NavBarProps) {
  // v0.0.9: 下载指示器（仅用于角标显示进行中下载数量，点击打开下载管理内嵌标签页）
  const [downloads, setDownloads] = useState<BrowserDownloadRecord[]>([]);
  const activeDownloads = downloads.filter((d) => d.state === 'progressing');

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

  return (
    <div className="browser-bar-row browser-bar-row-nav" data-name="browser.nav-bar">
      {/* 左侧：导航按钮 */}
      <div className="browser-nav-buttons">
        <IconButton
          aria-label="后退"
          disabled={!canGoBack}
          onClick={onGoBack}
          title="后退 (Alt+←)"
          data-name="browser.back"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </IconButton>
        <IconButton
          aria-label="前进"
          disabled={!canGoForward}
          onClick={onGoForward}
          title="前进 (Alt+→)"
          data-name="browser.forward"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </IconButton>
        <IconButton
          aria-label="刷新"
          onClick={onRefresh}
          title="刷新 (F5)"
          data-name="browser.refresh"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </IconButton>
        <IconButton
          aria-label="主页"
          onClick={onGoHome}
          title="主页"
          data-name="browser.home"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </IconButton>
      </div>

      {/* 中部：地址栏 */}
      <AddressBar
        tab={activeTab}
        profile={profile}
        themeColor={themeColor}
        onNavigate={onNavigate}
        addressBarRef={addressBarRef}
      />

      {/* 右侧：扩展占位 + 下载 + AI 头像 + 设置 */}
      <div className="browser-bar-right">
        {/* 扩展程序图标区（占位，待后续开发） */}
        <div className="browser-extension-slot" title="扩展程序（待开发）" data-name="browser.extension-slot">
          <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
            <line x1="7" y1="7" x2="7.01" y2="7" />
          </svg>
        </div>
        {/* 历史记录入口（内嵌标签页） */}
        <IconButton
          aria-label="历史记录"
          onClick={onOpenHistory}
          title="历史记录"
          data-name="browser.nav.history"
        >
          <HistoryIcon />
        </IconButton>
        {/* 下载管理入口（内嵌标签页，进行中下载显示角标） */}
        <IconButton
          aria-label="下载管理"
          onClick={onOpenDownloads}
          title="下载管理"
          data-name="browser.nav.downloads"
          variant={activeDownloads.length > 0 ? 'active' : 'default'}
        >
          <DownloadIcon />
          {activeDownloads.length > 0 && (
            <span className="browser-download-badge">{activeDownloads.length}</span>
          )}
        </IconButton>
        {/* AI 应用头像与名称 */}
        <div className="browser-ai-avatar" title={profile.name} data-name="browser.ai-avatar">
          <span className="browser-ai-avatar-icon" data-name="browser.ai-avatar-icon" style={{ background: themeColor }}>
            {profile.name.charAt(0).toUpperCase()}
          </span>
          <span className="browser-ai-avatar-name" data-name="browser.ai-avatar-name">{profile.name}</span>
        </div>
        {/* 设置入口（新标签页打开） */}
        <IconButton
          aria-label="设置"
          onClick={onOpenSettings}
          title="设置"
          data-name="browser.settings"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </IconButton>
      </div>

      {/* B2: NavBar 底部加载进度条（仅 isLoading 时显示） */}
      {activeTab?.isLoading && (
        <div className="browser-nav-progress-track">
          <div
            className="browser-nav-progress-bar"
            style={{ width: `${activeTab.loadingProgress ?? 30}%` }}
          />
        </div>
      )}
    </div>
  );
}
