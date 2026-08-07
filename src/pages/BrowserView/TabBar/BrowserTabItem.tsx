/* =====================================================================
   pages/BrowserView/TabBar/BrowserTabItem.tsx —— 单个浏览器标签（v0.0.9）
   显示 favicon / 标题 / 静音指示 / 关闭按钮；固定标签仅 favicon 窄形态。
   ===================================================================== */

import { memo } from 'react';
import type { BrowserTabState } from '../../../lib/electron-api';
import { extractDomainInitial } from '../utils/favicon-placeholder';

interface BrowserTabItemProps {
  tab: BrowserTabState;
  active: boolean;
  themeColor: string;
  onClick: () => void;
  onClose: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

function BrowserTabItemInner({
  tab,
  active,
  themeColor,
  onClick,
  onClose,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
}: BrowserTabItemProps) {
  const className = [
    'browser-tab',
    active ? 'active' : '',
    tab.pinned ? 'pinned' : '',
    tab.audible ? 'audible' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={className}
      onClick={onClick}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      data-name="browser.tab"
      data-tab-id={tab.id}
      title={tab.title || tab.url}
    >
      {tab.isLoading && (
        <div className="browser-tab-loading-bar" data-name="browser.tab-loading-bar">
          <div className="browser-tab-loading-bar-inner" />
        </div>
      )}
      <span className="browser-tab-favicon" data-name="browser.tab-favicon">
        {tab.favicon ? (
          <img src={tab.favicon} alt="" width={14} height={14} data-name="browser.tab-favicon-img" />
        ) : (
          <span className="browser-tab-favicon-placeholder" style={{ background: tab.themeColor || themeColor }} data-name="browser.tab-favicon-placeholder">
            {extractDomainInitial(tab.url) || (tab.title || '?').charAt(0).toUpperCase()}
          </span>
        )}
      </span>
      <span className="browser-tab-title" data-name="browser.tab-title">{tab.title || '新标签'}</span>
      {/* 静音/正在播放指示器 */}
      {(tab.muted || tab.audible) && (
        <svg
          className="browser-tab-muted-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {tab.muted ? (
            <>
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <line x1="23" y1="9" x2="17" y2="15" />
              <line x1="17" y1="9" x2="23" y2="15" />
            </>
          ) : (
            <>
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
            </>
          )}
        </svg>
      )}
      <button
        type="button"
        className="browser-tab-close"
        onClick={onClose}
        title="关闭标签 (Ctrl+W)"
       data-name="browser.tab-close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

export const BrowserTabItem = memo(BrowserTabItemInner);
