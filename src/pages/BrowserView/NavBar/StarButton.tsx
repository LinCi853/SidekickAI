/* =====================================================================
   pages/BrowserView/NavBar/StarButton.tsx —— 收藏星标按钮（v0.0.9）
   已收藏=实心星（主题色），未收藏=空心星。点击 toggle 添加/移除书签。
   ===================================================================== */

import { useCallback, useEffect, useState } from 'react';
import type { Profile } from '../../../lib/electron-api';
import { useBookmarkStore } from '../../../store/useBookmarkStore';

interface StarButtonProps {
  url: string;
  title: string;
  favicon?: string;
  profile: Profile;
  themeColor: string;
}

export default function StarButton({ url, title, favicon, profile, themeColor }: StarButtonProps) {
  const bookmarks = useBookmarkStore((s) => s.bookmarks);
  const addBookmark = useBookmarkStore((s) => s.add);
  const removeBookmark = useBookmarkStore((s) => s.remove);
  const loadBookmarks = useBookmarkStore((s) => s.load);

  // 首次加载书签列表（若未加载）
  useEffect(() => {
    const state = useBookmarkStore.getState();
    if (!state.loaded) void loadBookmarks();
  }, [loadBookmarks]);

  const existing = bookmarks.find((b) => b.url === url);
  const starred = !!existing;

  const handleClick = useCallback(async () => {
    if (!url) return;
    if (existing) {
      await removeBookmark(existing.id);
    } else {
      await addBookmark({
        title: title || url,
        url,
        favicon,
        profileId: profile.id,
        profileName: profile.name,
        aiPlatformId: profile.aiPlatformId,
        platformName: profile.aiPlatformId
          ? undefined // 由主进程在 add 时无法回填，这里渲染层也不持有 AI_PLATFORMS
          : undefined,
        inBookmarkBar: true,
      });
    }
  }, [url, title, favicon, profile, existing, addBookmark, removeBookmark]);

  if (!url) return null;

  return (
    <button
      type="button"
      className={`browser-star-btn${starred ? ' starred' : ''}`}
      onClick={handleClick}
      title={starred ? '已收藏（点击移除）' : '收藏为书签'}
      data-name="browser.star-btn"
      style={starred ? { color: themeColor } : undefined}
    >
      <svg viewBox="0 0 24 24" fill={starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    </button>
  );
}
