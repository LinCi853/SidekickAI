/* =====================================================================
   pages/BrowserView/BookmarksBar/BookmarksBar.tsx —— 第三栏书签栏（v0.0.9）
   全局书签汇聚，可显隐。空白区右键：显示/隐藏书签栏 + 打开书签管理器。
   最右侧"全部书签"按钮 → 新标签页打开书签管理器。
   ===================================================================== */

import { useEffect, useState } from 'react';
import Popover, { PopoverItem } from '../../../components/ui/Popover';
import { IconButton } from '../../../components/ui';

import type { Bookmark } from '../../../lib/electron-api';
import { useBookmarkStore } from '../../../store/useBookmarkStore';
import { useBrowserTabStore } from '../../../store/useBrowserTabStore';
import { BookmarkItem } from './BookmarkItem';
import BookmarkContextMenu, { BookmarkEditDialog } from './BookmarkContextMenu';

interface BookmarksBarProps {
  visible: boolean;
  onOpenBookmarkManager: () => void;
}

export default function BookmarksBar({ visible, onOpenBookmarkManager }: BookmarksBarProps) {
  const bookmarks = useBookmarkStore((s) => s.bookmarks);
  const load = useBookmarkStore((s) => s.load);
  const remove = useBookmarkStore((s) => s.remove);
  const update = useBookmarkStore((s) => s.update);
  const toggleBar = useBookmarkStore((s) => s.toggleBar);
  const setBookmarkBarVisible = useBrowserTabStore((s) => s.setBookmarkBarVisible);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; bookmark: Bookmark } | null>(null);
    const [blankContextMenu, setBlankContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<Bookmark | null>(null);

  const newTab = useBrowserTabStore((s) => s.newTab);

  useEffect(() => {
    void load();
  }, [load]);

  if (!visible) return null;

  const barBookmarks = bookmarks.filter((b) => b.inBookmarkBar);
  const editingBookmark = bookmarks.find((b) => b.id === editing);

  return (
    <>
      <div
        className="browser-bar-row browser-bar-row-bookmarks"
        data-name="browser.bookmarks-bar"
        onContextMenu={(e) => {
          // 空白区右键
          if ((e.target as HTMLElement).classList.contains('browser-bar-row-bookmarks') ||
              (e.target as HTMLElement).classList.contains('browser-bookmarks-list') ||
              (e.target as HTMLElement).classList.contains('browser-bookmarks-empty')) {
            e.preventDefault();
            setBlankContextMenu({ x: e.clientX, y: e.clientY });
          }
        }}
      >
        <div className="browser-bookmarks-list" data-name="browser.bookmarks-list">
          {barBookmarks.length === 0 ? (
            <div className="browser-bookmarks-empty" data-name="browser.bookmarks-empty">点击地址栏星标收藏网页</div>
          ) : (
            barBookmarks.map((b) => (
              <BookmarkItem
                key={b.id}
                bookmark={b}
                onClick={() => newTab(b.url, { kind: 'web' })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({ x: e.clientX, y: e.clientY, bookmark: b });
                }}
              />
            ))
          )}
        </div>
        {/* 最右侧"全部书签"按钮 */}
        <IconButton
          aria-label="全部书签"
          onClick={onOpenBookmarkManager}
          title="全部书签"
          data-name="browser.bookmarks-all"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
        </IconButton>
      </div>

      {/* 书签右键菜单 */}
      {contextMenu && (
        <BookmarkContextMenu
          position={contextMenu}
          bookmark={contextMenu.bookmark}
          bookmarkBarVisible={visible}
          hasClipboard={!!clipboard}
          onClose={() => setContextMenu(null)}
          onOpenInNewTab={() => newTab(contextMenu.bookmark.url, { kind: 'web' })}
            onOpenInNewWindow={() => {
              // 在新窗口中打开 - 使用 openWindow 创建新窗口
              void import('../../../lib/electron-api').then((api) => {
                void api.openWindow(contextMenu.bookmark.profileId);
              });
            }}
          onEdit={() => setEditing(contextMenu.bookmark.id)}
          onCut={() => { setClipboard(contextMenu.bookmark); void remove(contextMenu.bookmark.id); }}
          onCopy={() => { void navigator.clipboard?.writeText(contextMenu.bookmark.url); }}
          onPaste={() => {
            if (clipboard) {
              void useBookmarkStore.getState().add({
                title: clipboard.title,
                url: clipboard.url,
                favicon: clipboard.favicon,
                profileId: clipboard.profileId,
                profileName: clipboard.profileName,
                aiPlatformId: clipboard.aiPlatformId,
                platformName: clipboard.platformName,
                inBookmarkBar: true,
              });
              setClipboard(null);
            }
          }}
          onDelete={() => void remove(contextMenu.bookmark.id)}
          onToggleBarVisibility={() => void toggleBar(contextMenu.bookmark.id, !contextMenu.bookmark.inBookmarkBar)}
          onToggleBookmarkBar={() => setBookmarkBarVisible(false)}
          onOpenManager={onOpenBookmarkManager}
        />
      )}

      {/* 空白区右键菜单 */}
      {blankContextMenu && (
        <BlankContextMenu
          position={blankContextMenu}
          onClose={() => setBlankContextMenu(null)}
          onToggleBookmarkBar={() => setBookmarkBarVisible(false)}
          onOpenManager={onOpenBookmarkManager}
        />
      )}

      {/* 编辑弹窗 */}
      {editingBookmark && (
        <BookmarkEditDialog
          bookmark={editingBookmark}
          onSave={(title, url) => {
            void update(editingBookmark.id, { title, url });
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </>
  );
}

/** 空白区右键菜单（使用 Popover 组件） */
function BlankContextMenu({
  position,
  onClose,
  onToggleBookmarkBar,
  onOpenManager,
}: {
  position: { x: number; y: number };
  onClose: () => void;
  onToggleBookmarkBar: () => void;
  onOpenManager: () => void;
}) {
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <Popover
      isOpen={true}
      onClose={onClose}
      position={position}
      variant="context-menu"
      config={{ closeOnOutsideClick: true, closeOnEsc: true }}
      dataName="browser.bookmark-blank-context-menu"
    >
      <PopoverItem onClick={run(onToggleBookmarkBar)} label="隐藏书签栏" dataName="browser.bookmark-blank-ctx-hide" />
      <PopoverItem onClick={run(onOpenManager)} label="打开书签管理器" dataName="browser.bookmark-blank-ctx-manager" />
    </Popover>
  );
}