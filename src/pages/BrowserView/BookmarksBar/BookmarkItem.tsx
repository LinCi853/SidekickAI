/* =====================================================================
   pages/BrowserView/BookmarksBar/BookmarkItem.tsx —— 单条书签（v0.0.9）
   favicon + 标题 + 来源应用标识。点击在新标签打开，右键弹菜单。
   ===================================================================== */

import { memo, useMemo } from 'react';
import type { Bookmark } from '../../../lib/electron-api';
import { useProfileStore } from '../../../store/useProfileStore';
import { AI_PLATFORMS } from '../../../../electron/presets/ai-platforms';

interface BookmarkItemProps {
  bookmark: Bookmark;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function BookmarkItemInner({ bookmark, onClick, onContextMenu }: BookmarkItemProps) {
  // 主题色：与 BrowserTabItem 保持一致（profile 覆盖 → 平台默认 → 兜底）
  const profiles = useProfileStore((s) => s.profiles);
  const themeColor = useMemo(() => {
    const profile = profiles.find((p) => p.id === bookmark.profileId);
    const platformDef = bookmark.aiPlatformId
      ? AI_PLATFORMS.find((p) => p.id === bookmark.aiPlatformId)
      : null;
    return profile?.aiThemeColor || platformDef?.themeColor || '#c25a4a';
  }, [profiles, bookmark.profileId, bookmark.aiPlatformId]);

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
        <span className="browser-tab-favicon-placeholder" style={{ background: themeColor }} data-name="browser.bookmark-favicon-placeholder">
          {(bookmark.title || '?').charAt(0).toUpperCase()}
        </span>
      )}
      <span className="browser-bookmark-title" data-name="browser.bookmark-title">{bookmark.title}</span>
    </div>
  );
}

export const BookmarkItem = memo(BookmarkItemInner);
