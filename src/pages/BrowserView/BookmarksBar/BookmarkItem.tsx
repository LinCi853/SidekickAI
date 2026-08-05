/* =====================================================================
   pages/BrowserView/BookmarksBar/BookmarkItem.tsx —— 单条书签（v0.0.9）
   favicon + 标题 + 来源应用标识。点击在新标签打开，右键弹菜单。
   ===================================================================== */

import { memo } from 'react';
import type { Bookmark } from '../../../lib/electron-api';

interface BookmarkItemProps {
  bookmark: Bookmark;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function BookmarkItemInner({ bookmark, onClick, onContextMenu }: BookmarkItemProps) {
  return (
    <div
      className="browser-bookmark-item"
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={`${bookmark.title}\n${bookmark.url}\n来自：${bookmark.profileName}${bookmark.platformName ? ` (${bookmark.platformName})` : ''}`}
      data-name="browser.bookmark-item"
    >
      {bookmark.favicon ? (
        <img src={bookmark.favicon} alt="" width={14} height={14} className="browser-bookmark-favicon" data-name="browser.bookmark-favicon" />
      ) : (
        <svg className="browser-bookmark-favicon" viewBox="0 0 24 24" data-name="browser.bookmark-favicon-placeholder" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      )}
      <span className="browser-bookmark-title" data-name="browser.bookmark-title">{bookmark.title}</span>
    </div>
  );
}

export const BookmarkItem = memo(BookmarkItemInner);
